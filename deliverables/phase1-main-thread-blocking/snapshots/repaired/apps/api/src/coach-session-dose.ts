import type { CoachSessionDose, MobileSessionKind, MobileSessionStructure, MobileWorkoutStep } from "@rai/api-contracts";
import type { CoachZonePrescription } from "./mobile-coach.js";
import { MAX_BLOCKS, MAX_BLOCK_ITERATIONS, MAX_STEP_METERS, MAX_STEP_SECONDS, normalizeSessionStructure } from "./session-structure.js";

/**
 * Final-structure dose assessment.
 *
 * v2 (2026-10-20) fixes an evidence bug rather than a threshold. `buildPaceBands`
 * publishes the easy band with an **open slow end** (`upperSecondsPerKm: null`) and
 * that is a normal, measured shape — a slow bound does not exist for the easy zone.
 * v1 required both pace bounds for *any* step, so one open bound made the whole
 * session `not_assessable`: in production every easy warm-up/cooldown step of every
 * interval and tempo session failed, which silently removed all quality training
 * from the coach. It also let the 360 s/km cold-start estimate stand in for measured
 * pace on easy sessions, so the "cost" of a 30-minute run was a round 5 km instead
 * of the measured 1800 / fastest-permitted-easy-pace.
 *
 * v2 therefore tracks each bound separately, per dimension:
 *   - a time goal has an exact duration; its distance is bounded above by the fast
 *     end (a slower allowlisted pace covers less distance, so no upper pace is
 *     needed) and open below;
 *   - a distance goal has an exact distance; its duration is bounded by the pace
 *     range, and is *unknown* on the side whose pace bound is absent;
 *   - an unknown bound never becomes a fabricated one. It becomes an explicit
 *     `*_not_assessable` reason, and the status can only be `feasible` when every
 *     binding constraint was actually proven.
 * The cold-start estimate is used only when a whole session has no pace evidence at
 * all (both bounds absent), stays visibly labelled `cold_start_policy`, and remains
 * unusable for controlled extension.
 */

export const SESSION_DOSE_POLICY_VERSION = "rai-coach-session-dose-v2";
export const MINIMUM_SESSION_DURATION_SECONDS = 1800;
/** Cold-start cost estimate, NOT a measured pace or an intensity target. */
export const COLD_START_ESTIMATE_SECONDS_PER_KM = 360;

type Bounds = { lower: number | null; upper: number | null };

/** Both ends present: what a StepAlert / weighted average may use. */
function paceRange(kind: MobileSessionKind, zones: CoachZonePrescription | null): Bounds | null {
  const lower = kind === "interval" ? zones?.intervalPaceLower : kind === "tempo" ? zones?.thresholdPaceLower : zones?.easyPaceLower;
  const upper = kind === "interval" ? zones?.intervalPaceUpper : kind === "tempo" ? zones?.thresholdPaceUpper : zones?.easyPaceUpper;
  const usable = (value: number | null | undefined): boolean =>
    value == null || (Number.isFinite(value) && value >= 120 && value <= 1200);
  if (!usable(lower) || !usable(upper)) return null;
  if (lower != null && upper != null && lower > upper) return null;
  // No evidence at all is "unavailable", not an infinitely open range.
  if (lower == null && upper == null) return null;
  return { lower: lower ?? null, upper: upper ?? null };
}

/** Expand bounded steps without copying the structure or assigning meaning to open goals. */
function stepsWithCounts(structure: MobileSessionStructure): Array<{ step: MobileWorkoutStep; count: number }> | null {
  if (!Array.isArray(structure.blocks) || structure.blocks.length > MAX_BLOCKS) return null;
  const result = [
    ...(structure.warmup ? [{ step: structure.warmup, count: 1 }] : []),
    ...(structure.cooldown ? [{ step: structure.cooldown, count: 1 }] : [])
  ];
  for (const block of structure.blocks) {
    if (!Number.isInteger(block.iterations) || block.iterations < 1 || block.iterations > MAX_BLOCK_ITERATIONS ||
      !Array.isArray(block.steps) || !block.steps.length) return null;
    result.push(...block.steps.map(step => ({ step, count: block.iterations })));
  }
  return result;
}

function addBounds(total: Bounds, step: Bounds): Bounds {
  return {
    lower: total.lower === null || step.lower === null ? null : total.lower + step.lower,
    upper: total.upper === null || step.upper === null ? null : total.upper + step.upper
  };
}

/** A block repeats its steps `iterations` times. */
function scaleBounds(bounds: Bounds, count: number): Bounds {
  return {
    lower: bounds.lower === null ? null : bounds.lower * count,
    upper: bounds.upper === null ? null : bounds.upper * count
  };
}

function addCount(total: number | null, value: number | null, multiplier: number): number | null {
  return total === null || value === null ? null : total + value * multiplier;
}

/** One step's duration/distance range, keeping every unknown end explicit. */
function stepBounds(goal: { type: "time"; seconds: number } | { type: "distance"; meters: number }, pace: Bounds): {
  duration: Bounds; distance: Bounds;
} {
  if (goal.type === "time") {
    const seconds = goal.seconds;
    return {
      duration: { lower: seconds, upper: seconds },
      // Distance = seconds / pace(seconds per km): the fastest permitted pace is the
      // longest possible distance. A missing slow bound leaves no *lower* end.
      distance: {
        lower: pace.upper === null ? null : seconds / pace.upper,
        upper: pace.lower === null ? null : seconds / pace.lower
      }
    };
  }
  const km = goal.meters / 1000;
  return {
    duration: {
      lower: pace.lower === null ? null : km * pace.lower,
      upper: pace.upper === null ? null : km * pace.upper
    },
    distance: { lower: km, upper: km }
  };
}

export function assessSessionDose(input: {
  kind: MobileSessionKind;
  structure: MobileSessionStructure | null;
  zones: CoachZonePrescription | null;
  availableSeconds?: number | null;
  maximumDistanceKm?: number | null;
  allowColdStartEstimate?: boolean;
}): CoachSessionDose {
  const base: CoachSessionDose = {
    policyVersion: SESSION_DOSE_POLICY_VERSION,
    status: input.kind === "rest" ? "not_applicable" : "not_assessable",
    estimateSource: "unavailable", durationSeconds: null, distanceKm: null,
    workSecondsLower: null, workMetersLower: null, workRepetitions: 0, reasonCodes: []
  };
  if (input.kind === "rest") return base;
  const steps = input.structure ? stepsWithCounts(input.structure) : null;
  if (!steps) return { ...base, reasonCodes: ["session_structure_unavailable"] };
  let usedColdStart = false;
  let duration: Bounds = { lower: 0, upper: 0 };
  let distance: Bounds = { lower: 0, upper: 0 };
  let workSeconds: number | null = 0;
  let workMeters: number | null = 0;
  let repetitions = 0;
  for (const { step, count } of steps) {
    if (!["warmup", "work", "recovery", "cooldown"].includes(step.purpose)) {
      return { ...base, reasonCodes: ["session_structure_invalid"] };
    }
    const goal = step.goal;
    if (goal.type === "open") return { ...base, reasonCodes: ["open_goal_not_bounded"] };
    const value = goal.type === "time" ? goal.seconds : goal.meters;
    const maximum = goal.type === "time" ? MAX_STEP_SECONDS : MAX_STEP_METERS;
    if (!Number.isFinite(value) || value <= 0 || value > maximum) return { ...base, reasonCodes: ["session_structure_invalid"] };
    let pace = paceRange(step.purpose === "work" ? input.kind : "easy", input.zones);
    // A step target can widen the assumed range but never conceal a faster zone
    // edge. Missing sides stay missing instead of being invented.
    if (step.alert?.kind === "pace") {
      const alertLower = step.alert.lower ?? null;
      const alertUpper = step.alert.upper ?? null;
      const usable = (bound: number | null): boolean => bound == null || (Number.isFinite(bound) && bound >= 120 && bound <= 1200);
      if (!usable(alertLower) || !usable(alertUpper) || (alertLower != null && alertUpper != null && alertLower > alertUpper)) {
        return { ...base, reasonCodes: ["step_pace_range_invalid"] };
      }
      if (pace === null) pace = { lower: alertLower, upper: alertUpper };
      else pace = {
        lower: alertLower === null || pace.lower === null ? (alertLower ?? pace.lower) : Math.min(pace.lower, alertLower),
        upper: alertUpper === null || pace.upper === null ? (alertUpper ?? pace.upper) : Math.max(pace.upper, alertUpper)
      };
      // An alert that widened a range to "both missing" has no evidence left.
      if (pace.lower === null && pace.upper === null) pace = null;
    }
    if (!pace) {
      if (!input.allowColdStartEstimate || ["interval", "tempo"].includes(input.kind)) {
        return { ...base, reasonCodes: ["dose_pace_evidence_unavailable"] };
      }
      usedColdStart = true;
      pace = { lower: COLD_START_ESTIMATE_SECONDS_PER_KM, upper: COLD_START_ESTIMATE_SECONDS_PER_KM };
    }
    const bounds = stepBounds(goal, pace);
    duration = addBounds(duration, scaleBounds(bounds.duration, count));
    distance = addBounds(distance, scaleBounds(bounds.distance, count));
    if (step.purpose === "work") {
      workSeconds = addCount(workSeconds, bounds.duration.lower, count);
      // Work volume is kept in metres for the interval minimum (4 x 800 m).
      workMeters = addCount(workMeters, bounds.distance.lower === null ? null : bounds.distance.lower * 1000, count);
      repetitions += count;
    }
  }
  const violations: string[] = [];
  const unknown: string[] = [];
  if (duration.lower === null) unknown.push("minimum_session_duration_not_assessable");
  else if (duration.lower < MINIMUM_SESSION_DURATION_SECONDS) violations.push("minimum_session_not_feasible");
  // Existing builders: easy/recovery/long need meaningful continuous work,
  // tempo is 3 x 8 min, intervals 4 x 800 m. No padding-only quality sessions.
  if (input.kind === "interval") {
    if (workMeters === null) unknown.push("minimum_work_dose_not_assessable");
    else if (repetitions < 4 || workMeters < 3200) violations.push("minimum_work_dose_not_met");
  } else if (workSeconds === null) {
    unknown.push("minimum_work_dose_not_assessable");
  } else if (workSeconds < (input.kind === "tempo" ? 1440 : 1200)) {
    violations.push("minimum_work_dose_not_met");
  }
  if (input.availableSeconds != null) {
    if (!Number.isFinite(input.availableSeconds)) violations.push("available_time_exceeded");
    // An open slow end means an upper duration bound is genuinely unknown; that is
    // a different statement from "the session does not fit".
    else if (duration.upper === null) unknown.push("available_time_not_assessable");
    else if (duration.upper > input.availableSeconds) violations.push("available_time_exceeded");
  }
  if (input.maximumDistanceKm != null) {
    if (!Number.isFinite(input.maximumDistanceKm)) violations.push("session_distance_limit");
    else if (distance.upper === null) unknown.push("session_distance_limit_not_assessable");
    else if (distance.upper > input.maximumDistanceKm + 1e-9) violations.push("session_distance_limit");
  }
  return {
    ...base,
    status: violations.length ? "not_feasible" : unknown.length ? "not_assessable" : "feasible",
    estimateSource: usedColdStart ? "cold_start_policy" : "zone_pace_range",
    durationSeconds: duration,
    distanceKm: distance,
    workSecondsLower: workSeconds,
    workMetersLower: workMeters,
    workRepetitions: repetitions,
    reasonCodes: [...violations, ...unknown]
  };
}

/** Complete low-intensity dose: 5 min warmup, 20 min work, 5 min cooldown. */
export function buildCompleteEasyStructure(
  kind: "easy" | "recovery", zones: CoachZonePrescription | null
): MobileSessionStructure {
  // A WorkoutKit alert needs both ends; an open slow end does not degrade the dose
  // assessment above but it must not be exported as a one-sided pace target.
  const pace = paceRange(kind, zones);
  const closedPace = pace !== null && pace.lower !== null && pace.upper !== null ? { lower: pace.lower, upper: pace.upper } : null;
  const hr = zones?.easyHrUpper != null && Number.isFinite(zones.easyHrUpper) &&
    zones.easyHrUpper > 0 && zones.easyHrUpper <= 240 &&
    (zones.easyHrLower === null || Number.isFinite(zones.easyHrLower) && zones.easyHrLower > 0 && zones.easyHrLower <= zones.easyHrUpper)
    ? { kind: "heart_rate" as const, lower: zones.easyHrLower, upper: zones.easyHrUpper } : null;
  return normalizeSessionStructure({
    warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: hr },
    blocks: [{ iterations: 1, steps: [{
      purpose: "work", goal: { type: "time", seconds: 1200 },
      alert: closedPace ? { kind: "pace", lower: closedPace.lower, upper: closedPace.upper } : null
    }] }],
    cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: hr }
  })!;
}
