import {
  ENVIRONMENT_VIEW_POLICY_VERSION,
  GRADE_ADJUSTMENT_POLICY_VERSION,
  type WorkoutEnvironmentView,
  type WorkoutGradeSummary,
  type WorkoutSplitGrade
} from "@rai/contracts";
import { parsePerformanceConditions } from "@rai/application";
import {
  GRADE_ADJUSTMENT_POLICY_VERSION as PHYSIOLOGY_GRADE_POLICY_VERSION,
  buildWorkoutEnvironmentView,
  gradeAdjustedPace
} from "@rai/physiology";

/**
 * Environment and grade read-out for one run (docs/ALGORITHM.md §5).
 *
 * Two separate jobs, deliberately kept out of the scoring paths:
 *
 * 1. **Environment** — the correction already exists and already has an owner
 *    (`performanceConditionPenaltyFraction` in `@rai/physiology`, applied to
 *    historical VDOT evidence and to the race scenario). Until now a run in 30 °C
 *    and 80 % humidity rendered identically to a run in 15 °C; this module only
 *    makes the existing number readable. It calls the same adapter, so the number
 *    shown cannot drift from the number applied.
 *
 * 2. **Grade** — a display-only re-expression of measured pace at a reference
 *    gradient, using the published Minetti cost model. It is a different object
 *    from both §5.5 ledger sites, so it must not be wired into
 *    `performanceVdotEvidence` or `predictRaceTimes` without first registering a
 *    ledger site; `validateConditionLedger` refuses a second correction of the
 *    same field on the same object.
 *
 * Nothing here mutates a stored fact, and every unknown stays `null` with a
 * reason code rather than becoming a zero that reads like "no correction needed".
 */

/** Grade beyond this is GPS noise on a 1 km split, not a hill. */
export const MAXIMUM_PLAUSIBLE_GRADE_PERCENT = 60;
/** Below this a split is too short for a meaningful net elevation change. */
export const MINIMUM_GRADE_SPLIT_METERS = 50;

export interface ElevationPoint {
  timestamp: string;
  value: number;
}

export interface SplitInput {
  index: number;
  distanceMeters: number;
  durationSeconds: number;
  averagePaceSecondsPerKm: number;
}

export interface SplitGradeResult {
  splits: WorkoutSplitGrade[];
  summary: WorkoutGradeSummary;
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Net/gain/loss over the points that fall inside `[startMs, endMs]`.
 *
 * Requires at least two in-window samples: a single sample carries no change, and
 * reporting 0 m of climb for it would be a fabricated "flat" reading.
 */
function elevationChange(
  points: ReadonlyArray<ElevationPoint>,
  startMs: number,
  endMs: number
): { change: number; gain: number; loss: number; samples: number } | null {
  let first: number | null = null;
  let last: number | null = null;
  let gain = 0;
  let loss = 0;
  let samples = 0;
  let previous: number | null = null;
  for (const point of points) {
    const at = Date.parse(point.timestamp);
    if (!Number.isFinite(at) || at < startMs || at > endMs) continue;
    if (!Number.isFinite(point.value)) continue;
    samples += 1;
    if (first === null) first = point.value;
    if (previous !== null) {
      const delta = point.value - previous;
      if (delta > 0) gain += delta;
      else loss -= delta;
    }
    previous = point.value;
    last = point.value;
  }
  if (samples < 2 || first === null || last === null) return null;
  return { change: last - first, gain, loss, samples };
}

export function splitGradeContexts(input: {
  startedAtMs: number;
  splits: ReadonlyArray<SplitInput>;
  elevationPoints: ReadonlyArray<ElevationPoint>;
}): SplitGradeResult {
  if (!Number.isFinite(input.startedAtMs)) {
    throw new Error("splitGradeContexts requires a finite startedAtMs");
  }
  const results: WorkoutSplitGrade[] = [];
  let coveredSplits = 0;
  let totalGain = 0;
  let totalLoss = 0;
  let weightedPace = 0;
  let weightedDistance = 0;
  let cursor = input.startedAtMs;

  for (const split of input.splits) {
    const startMs = cursor;
    const endMs = startMs + split.durationSeconds * 1000;
    cursor = endMs;
    const base = { policyVersion: GRADE_ADJUSTMENT_POLICY_VERSION } as const;

    if (!Number.isFinite(split.distanceMeters) || split.distanceMeters < MINIMUM_GRADE_SPLIT_METERS) {
      results.push({
        ...base,
        elevationChangeMeters: null,
        gainMeters: null,
        lossMeters: null,
        gradePercent: null,
        gradeAdjustedPaceSecondsPerKm: null,
        reasonCodes: ["split_too_short_for_grade"]
      });
      continue;
    }

    const change = elevationChange(input.elevationPoints, startMs, endMs);
    if (change === null) {
      results.push({
        ...base,
        elevationChangeMeters: null,
        gainMeters: null,
        lossMeters: null,
        gradePercent: null,
        gradeAdjustedPaceSecondsPerKm: null,
        reasonCodes: ["elevation_samples_insufficient"]
      });
      continue;
    }

    const gradePercent = (change.change / split.distanceMeters) * 100;
    if (!Number.isFinite(gradePercent) || Math.abs(gradePercent) > MAXIMUM_PLAUSIBLE_GRADE_PERCENT) {
      results.push({
        ...base,
        elevationChangeMeters: round(change.change, 1),
        gainMeters: round(change.gain, 1),
        lossMeters: round(change.loss, 1),
        gradePercent: null,
        gradeAdjustedPaceSecondsPerKm: null,
        reasonCodes: ["grade_implausible_for_split"]
      });
      continue;
    }

    const adjusted = gradeAdjustedPace(split.averagePaceSecondsPerKm, gradePercent);
    coveredSplits += 1;
    totalGain += change.gain;
    totalLoss += change.loss;
    weightedPace += adjusted.paceSecondsPerKm * split.distanceMeters;
    weightedDistance += split.distanceMeters;
    results.push({
      ...base,
      elevationChangeMeters: round(change.change, 1),
      gainMeters: round(change.gain, 1),
      lossMeters: round(change.loss, 1),
      gradePercent: round(gradePercent, 2),
      gradeAdjustedPaceSecondsPerKm: round(adjusted.paceSecondsPerKm, 1),
      reasonCodes: adjusted.reasonCodes
    });
  }

  const summaryReasonCodes: string[] = [];
  if (coveredSplits === 0) summaryReasonCodes.push("no_split_with_elevation");
  else if (coveredSplits < results.length) summaryReasonCodes.push("partial_elevation_coverage");
  if (input.splits.length === 0) summaryReasonCodes.push("no_splits");

  return {
    splits: results,
    summary: {
      policyVersion: GRADE_ADJUSTMENT_POLICY_VERSION,
      coveredSplits,
      totalSplits: results.length,
      gainMeters: coveredSplits === 0 ? null : round(totalGain, 1),
      lossMeters: coveredSplits === 0 ? null : round(totalLoss, 1),
      gradeAdjustedPaceSecondsPerKm:
        coveredSplits === 0 || weightedDistance <= 0 ? null : round(weightedPace / weightedDistance, 1),
      reasonCodes: summaryReasonCodes
    }
  };
}

/** Environment view for one run, or `null` when there is nothing to normalise against. */
export function environmentViewForWorkout(input: {
  metadataJson: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
}): WorkoutEnvironmentView | null {
  const distanceMeters = input.distanceMeters;
  const durationSeconds = input.durationSeconds;
  if (
    distanceMeters === null ||
    durationSeconds === null ||
    !Number.isFinite(distanceMeters) ||
    !Number.isFinite(durationSeconds) ||
    distanceMeters <= 0 ||
    durationSeconds <= 0
  ) {
    return null;
  }
  return {
    ...buildWorkoutEnvironmentView({
      distanceMeters,
      durationSeconds,
      conditions: parsePerformanceConditions(input.metadataJson ?? "{}")
    }),
    weatherCondition: workoutWeatherCondition(input.metadataJson)
  };
}

/** HealthKit's observed weather code, not an inference from temperature/humidity. */
function workoutWeatherCondition(metadataJson: string | null): number | null {
  try {
    const metadata: unknown = JSON.parse(metadataJson ?? "{}");
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const raw = (metadata as Record<string, unknown>).HKWeatherCondition;
    const value: unknown = Array.isArray(raw) ? raw.at(-1) : raw;
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
    const code = Number(value);
    return Number.isInteger(code) && code > 0 && code <= 27 ? code : null;
  } catch {
    return null;
  }
}

export interface EnvironmentCoverage {
  workouts: number;
  temperatureC: number;
  humidityPercent: number;
  elevationGainMeters: number;
  /** All three fields present: the only rows the adapter can actually correct. */
  complete: number;
}

/**
 * Availability of the environment fields across the canonical workouts.
 *
 * This is the §5.2 inventory ("count first, then decide"), surfaced in the data
 * audit page so the answer is visible from the running product instead of only
 * from a CLI run on a database copy. It parses with the production parser: a key
 * that exists but cannot be read is not counted as available.
 */
export function environmentCoverage(
  rows: ReadonlyArray<{ metadataJson: string | null }>
): EnvironmentCoverage {
  const coverage: EnvironmentCoverage = {
    workouts: rows.length,
    temperatureC: 0,
    humidityPercent: 0,
    elevationGainMeters: 0,
    complete: 0
  };
  for (const row of rows) {
    const conditions = parsePerformanceConditions(row.metadataJson ?? "{}");
    const hasTemperature = conditions.temperatureC !== null;
    const hasHumidity = conditions.humidityPercent !== null;
    const hasElevation = conditions.elevationGainMeters !== null;
    if (hasTemperature) coverage.temperatureC += 1;
    if (hasHumidity) coverage.humidityPercent += 1;
    if (hasElevation) coverage.elevationGainMeters += 1;
    if (hasTemperature && hasHumidity && hasElevation) coverage.complete += 1;
  }
  return coverage;
}

/**
 * The two version strings this module's output depends on, exported for the
 * acceptance tests: a change to either must fail a test rather than silently
 * re-label old numbers.
 */
export const ENVIRONMENT_VIEW_VERSIONS = {
  view: ENVIRONMENT_VIEW_POLICY_VERSION,
  grade: PHYSIOLOGY_GRADE_POLICY_VERSION
} as const;
