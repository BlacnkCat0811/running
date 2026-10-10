import type { MobileRaceDistance, MobileRaceTarget, MobileRunCoachPlan } from "@rai/api-contracts";
import { runCoachIsTraining, runCoachRaceTarget } from "./run-coach-policy.js";

import { MINIMUM_BAND_KM, currentPeriodizationWeek, periodizationVolumeFraction, type PeriodizationPhase } from "./plan-periodization.js";
import { RAMP_LIMIT_FRACTION } from "./weekly-plan-validate.js";
import type { CoachCapacityAnchor } from "@rai/api-contracts";
import { digest } from "./plan-digest.js";
import { periodizationWeekStart } from "./plan-periodization.js";
import { CAPACITY_ENVELOPE_CANDIDATE_VERSION } from "./coach-loop-policy.js";
import { coachLocalDate, runEvidenceRef, shiftCoachDate, visibleCoachRuns, type CoachRunFact } from "./coach-loop-facts.js";
import { isValidLocalDate } from "./local-date.js";

/**
 * Weekly plan capacity, **derived from training facts instead of configured**.
 *
 * The runner used to carry a `weeklyDistanceKm` goal and the coach treated that
 * number as both the ceiling and the athlete's recent volume. Two consequences:
 * a stored goal could be years out of date while still capping every plan, and
 * the generation path fed the *goal* into the periodisation bands where the read
 * path fed real 4-week volume — the same field meaning two different things.
 *
 * Capacity now comes from one of three places, in this order of precedence:
 *
 *   1. a race target — target weekly volume for that distance, trimmed by the
 *      current phase, and never above what the last four weeks justify;
 *   2. recent volume — the mean of the last four complete calendar weeks, with
 *      a conservative restart floor while recorded volume remains small;
 *   3. nothing at all — a restart floor of `NO_HISTORY_WEEKLY_KM`.
 *
 * Run Coach goals select a policy target, never a user-entered weekly mileage.
 */

/** Target weekly volume per race distance, km — the ceiling a race block aims at. */
export const RACE_WEEKLY_BASELINE_KM: Record<MobileRaceDistance, number> = {
  five_k: 15,
  ten_k: 25,
  half_marathon: 35
};

/**
 * Conservative restart baseline for absent or very small recorded volume.
 *
 * Deliberately the same value as the periodisation bands' own no-history floor
 * (`MINIMUM_BAND_KM`, used at `plan-periodization.ts:252`): importing it keeps
 * the two from drifting into two different "starting over" numbers.
 *
 * It must stay above `MIN_PLANNED_DISTANCE_KM` in `weekly-plan-validate.ts`. At
 * or below that, `weeklyPlanVolumeCeiling`'s `Math.min` is pinned by its own
 * floor and the whole week collapses to a single kilometre that no later ramp
 * can lift. The same floor must survive the first completed week: that week's
 * four-week mean is diluted by the three preceding empty weeks.
 */
export const NO_HISTORY_WEEKLY_KM = MINIMUM_BAND_KM;

export type WeeklyCapacitySource = "race_target" | "recent_volume" | "no_history";

export interface WeeklyCapacity {
  /** The baseline handed to `weeklyPlanVolumeCeiling(baselineKm, previousWeekDistanceKm)`. */
  baselineKm: number;
  /** Phase of the week the plan covers, or null when there is no race target. */
  phase: PeriodizationPhase | null;
  source: WeeklyCapacitySource;
  /** True when neither recent nor previous-week volume exists. */
  coldStart: boolean;
  reasonCodes: string[];
}

const isLocalDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

export function weeklyCapacity(input: {
  today: string;
  raceTarget?: Pick<MobileRaceTarget, "date" | "distance"> | null;
  runCoach?: MobileRunCoachPlan | null;
  /** Mean of the last four complete calendar weeks, km (`data.ts` `recentWeeklyKm`). */
  recentWeeklyKm: number;
  /** Distance run in the seven days before this week (`data.ts` `previousWeekDistanceKm`). */
  previousWeekDistanceKm?: number | null;
  /** Pre-resolved phase; pass explicitly to avoid re-deriving the skeleton. */
  phase?: PeriodizationPhase | null;
}): WeeklyCapacity {
  const reasonCodes: string[] = [];
  const recent = Number.isFinite(input.recentWeeklyKm) ? Math.max(0, input.recentWeeklyKm) : 0;
  const previous =
    input.previousWeekDistanceKm != null && Number.isFinite(input.previousWeekDistanceKm) && input.previousWeekDistanceKm > 0
      ? input.previousWeekDistanceKm
      : null;

  // `distance` is typed, but a stored race target crosses a JSON boundary: an
  // unknown value would index this table to `undefined` and poison every
  // downstream ceiling with NaN. Treat it as "no race target" instead.
  let race: Pick<MobileRaceTarget, "date" | "distance"> | null = null;
  let raceBaselineKm = 0;
  if (input.raceTarget != null) {
    const candidate = RACE_WEEKLY_BASELINE_KM[input.raceTarget.distance];
    if (Number.isFinite(candidate)) {
      race = input.raceTarget;
      raceBaselineKm = candidate;
    }
  }
  const programme = input.runCoach && runCoachIsTraining(input.runCoach, input.today) ? input.runCoach : null;
  if (programme?.goal !== "fitness" && programme?.raceDistanceKm != null) {
    const km = programme.raceDistanceKm;
    raceBaselineKm = km <= 5 ? 15 : km <= 10 ? 25 : km <= 21.1 ? 35 : km <= 42.2 ? 45 : 55;
  }

  // Which race the phase is asked about: a programme's own target when there is a programme,
  // otherwise the caller's goals-level target. That is a target choice, not a second
  // algorithm — and `runCoachRaceTarget` returns `null` for a fitness goal or a distance
  // outside the calibrated set, which is exactly when no phase should be claimed.
  const raceTargetForPhase = input.runCoach ? runCoachRaceTarget(input.runCoach) : race;

  const phase =
    input.phase !== undefined
      ? input.phase
      // One derivation, one alignment. Branching between `runCoachPhase` and
      // `currentPeriodizationWeek` per source is what let the two drift: a 5K plan read
      // `build` here and `base` on the today page for the same week. A programme's own race
      // target and a goals-level one are the same question with a different target, so only
      // the target is selected below — the query itself stays singular, and stays windowed
      // so the volume cut agrees with the band the today page prints.
      : raceTargetForPhase != null && isLocalDate(input.today)
        ? currentPeriodizationWeek({ today: input.today, raceTarget: raceTargetForPhase, recentWeeklyKm: recent })?.phase ?? null
        : null;

  // Nothing observed and nothing last week: a restart, not a plan. Reusing the
  // periodisation floor keeps this above `MIN_PLANNED_DISTANCE_KM` so a coach
  // template can still pay for one or two easy days instead of collapsing.
  if (recent <= 0 && previous == null) {
    reasonCodes.push("no_recent_weekly_volume");
    if (race == null) reasonCodes.push("no_race_target");
    return { baselineKm: NO_HISTORY_WEEKLY_KM, phase, source: "no_history", coldStart: true, reasonCodes };
  }

  if (recent < NO_HISTORY_WEEKLY_KM) reasonCodes.push("restart_volume_floor");
  if (race == null && !(programme && programme.goal !== "fitness")) {
    // Keep a restart executable without rewriting the observed four-week mean.
    // The caller still applies the previous-week ramp to this baseline.
    if (programme?.goal === "fitness") reasonCodes.push("run_coach_fitness_progression");
    return { baselineKm: Math.max(NO_HISTORY_WEEKLY_KM, recent * (programme?.goal === "fitness" ? 1.1 : 1)), phase: null, source: "recent_volume", coldStart: false, reasonCodes };
  }

  // A race sets the target; the last four weeks decide how fast we may approach
  // it. The "+30%" guard is written out here rather than left to
  // `weeklyPlanVolumeCeiling`, because that helper floors its ramp base at *half
  // the goal*: with a 38.5 km race baseline and an 8 km week it would permit
  // 25 km — a threefold jump the runner has not earned.
  const raceTargetKm = raceBaselineKm * (phase != null ? periodizationVolumeFraction(phase) : 1);
  const recentCeiling = Math.max(NO_HISTORY_WEEKLY_KM, recent * (1 + RAMP_LIMIT_FRACTION));
  const baselineKm = Math.min(raceTargetKm, recentCeiling);
  reasonCodes.push("race_target_baseline");
  if (recentCeiling < raceTargetKm) reasonCodes.push("recent_volume_caps_race_target");
  return { baselineKm, phase, source: "race_target", coldStart: false, reasonCodes };
}

/**
 * O0-F offline candidate. Only pre-week single-workout facts enter the anchor.
 * Current-week training consumes space and cannot raise its own permission.
 * No store, migration, wall clock, goal time, readiness score or planned km.
 */
export function buildCoachCapacityAnchor(input: {
  asOf: string;
  facts: readonly CoachRunFact[];
  /** Earliest date for which the import history is known usable (not inferred rest). */
  historyCoverageFrom: string | null;
  scope: { athleteId: string; datasetEpoch: string };
  revision: number;
}): CoachCapacityAnchor {
  if (!Number.isInteger(input.revision) || input.revision < 1 || !input.scope.athleteId || !input.scope.datasetEpoch) {
    throw new Error("Explicit capacity-anchor revision and data scope required");
  }
  const weekStart = periodizationWeekStart(coachLocalDate(input.asOf));
  const from = shiftCoachDate(weekStart, -28);
  const historyThrough = shiftCoachDate(weekStart, -1);
  const runs = visibleCoachRuns(input.facts, input.asOf)
    .filter(run => coachLocalDate(run.startedAt) >= from && coachLocalDate(run.startedAt) < weekStart);
  const factsHash = digest({ scope: input.scope, weekStart, historyCoverageFrom: input.historyCoverageFrom,
    runs, policyVersion: CAPACITY_ENVELOPE_CANDIDATE_VERSION });
  const coverageFrom = input.historyCoverageFrom && isValidLocalDate(input.historyCoverageFrom) ? input.historyCoverageFrom : null;
  const coverageDays = coverageFrom && coverageFrom <= historyThrough
    ? Math.min(28, Math.round((Date.parse(`${weekStart}T00:00:00Z`) -
      Date.parse(`${coverageFrom}T00:00:00Z`)) / 86_400_000)) : 0;
  return {
    id: digest({ scope: input.scope, weekStart, factsHash, revision: input.revision }),
    revision: input.revision, factsHash, weekStart, historyThrough,
    observedDays: new Set(runs.map(run => coachLocalDate(run.startedAt))).size,
    coverageDays, recentWeeklyKm: runs.reduce((sum, run) => sum + run.distanceKm, 0) / 4,
    previousWeekKm: runs.filter(run => coachLocalDate(run.startedAt) >= shiftCoachDate(weekStart, -7))
      .reduce((sum, run) => sum + run.distanceKm, 0),
    policyVersion: CAPACITY_ENVELOPE_CANDIDATE_VERSION, evidenceRefs: runs.map(runEvidenceRef)
  };
}

/** Candidate constants are not activated by an environment flag or a GET. */
export function coachCapacityEnvelope(input: {
  anchor: CoachCapacityAnchor;
  suggestedWeeklyKm: number;
  legacyProtectionKm: number;
  loadHistorySufficient: boolean;
  /** Caller must carry the applicable product/phase hard cap, not Infinity. */
  absoluteProtectionKm: number;
  explicitPhaseHardCapKm?: number | null;
}): { suggestedWeeklyKm: number; weeklyProtectionKm: number; rolling7Km: number; rolling14Km: number; evidenceSufficient: boolean } {
  for (const km of [input.suggestedWeeklyKm, input.legacyProtectionKm, input.absoluteProtectionKm]) {
    if (!Number.isFinite(km) || km < 0) throw new Error("Finite non-negative capacity bounds required");
  }
  if (input.explicitPhaseHardCapKm != null && (!Number.isFinite(input.explicitPhaseHardCapKm) || input.explicitPhaseHardCapKm < 0)) {
    throw new Error("Invalid phase protection cap");
  }
  const { anchor } = input;
  const evidenceSufficient = anchor.coverageDays >= 28 && anchor.observedDays >= 8 &&
    anchor.recentWeeklyKm > 0 && anchor.previousWeekKm > 0 && input.loadHistorySufficient;
  const base = evidenceSufficient
    ? Math.min(anchor.recentWeeklyKm * (1 + RAMP_LIMIT_FRACTION), anchor.previousWeekKm * (1 + RAMP_LIMIT_FRACTION), input.absoluteProtectionKm)
    : Math.min(input.legacyProtectionKm, input.absoluteProtectionKm);
  const weeklyProtectionKm = Math.min(base, input.explicitPhaseHardCapKm ?? base);
  return { suggestedWeeklyKm: input.suggestedWeeklyKm, weeklyProtectionKm,
    rolling7Km: base, rolling14Km: 2 * base, evidenceSufficient };
}
