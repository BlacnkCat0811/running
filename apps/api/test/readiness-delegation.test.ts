import assert from "node:assert/strict";
import test from "node:test";

import {
  READINESS_HRV_RATIO_THRESHOLD,
  READINESS_RHR_RATIO_THRESHOLD,
  READINESS_SLEEP_RATIO_THRESHOLD,
  READINESS_SLEEP_STREAK_THRESHOLD,
  assessReadiness
} from "@rai/readiness";

import {
  RECOVERY_HRV_RATIO_THRESHOLD,
  RECOVERY_RHR_RATIO_THRESHOLD,
  RECOVERY_SLEEP_RATIO_THRESHOLD,
  RECOVERY_SLEEP_STREAK_THRESHOLD,
  assessRecovery,
  type CoachInput
} from "../src/mobile-coach.js";

// -----------------------------------------------------------------------------
// Frozen oracle: the recovery logic exactly as it stood inside `assessRecovery`
// before it was extracted into `@rai/readiness`.
//
// The numeric literals below are deliberate and must NOT be replaced by imports
// from the new package: an oracle that reads the new constants would agree with
// the new code no matter which side changed, and would prove nothing. This is
// the pre-refactor behaviour, frozen.
// -----------------------------------------------------------------------------
const oracleRatio = (current: number | null, baseline: number | null): number | null =>
  current != null && baseline != null && baseline > 0 ? current / baseline : null;

function frozenAssessRecovery(input: CoachInput): {
  coverage: string;
  assessment: string;
  reasonCodes: string[];
  sleepRatio: number | null;
  hrvRatio: number | null;
  sleepLow: boolean;
  hrvLow: boolean;
  restingHeartRateUp: boolean;
  sleepStreak: boolean;
} {
  const sleepRatio = oracleRatio(input.lastNightSleepMinutes, input.sleepBaselineMinutes);
  const hrvRatio = oracleRatio(input.morningHrvMs, input.hrvBaselineMs);
  const restingHeartRateUp =
    input.restingHeartRateBpm != null &&
    input.restingHeartRateBaselineBpm != null &&
    input.restingHeartRateBpm > input.restingHeartRateBaselineBpm * 1.03;
  const sleepLow = sleepRatio != null && sleepRatio < 0.75;
  const hrvLow = hrvRatio != null && hrvRatio < 0.85;
  const sleepStreak = input.nightsBelowSleepBaseline >= 3;
  const datedToday =
    input.recoveryEvidenceDate === input.today &&
    input.recoveryEvidenceStatus !== "stale" &&
    input.recoveryEvidenceStatus !== "unknown";
  const measured =
    Number(input.lastNightSleepMinutes != null && oracleRatio(input.lastNightSleepMinutes, input.sleepBaselineMinutes) != null) +
    Number(input.morningHrvMs != null && oracleRatio(input.morningHrvMs, input.hrvBaselineMs) != null) +
    Number(input.restingHeartRateBpm != null && oracleRatio(input.restingHeartRateBpm, input.restingHeartRateBaselineBpm) != null);
  const coverage = !datedToday || measured === 0 ? "none" : measured === 3 ? "complete" : "partial";
  const assessment =
    coverage === "none"
      ? "not_assessed"
      : sleepStreak || (sleepLow && hrvLow && restingHeartRateUp)
        ? "multiple_low_signals"
        : sleepLow || (hrvLow && restingHeartRateUp)
          ? "low_signal"
          : "no_low_signal";
  const reasonCodes =
    assessment === "not_assessed"
      ? ["not_assessed"]
      : assessment === "no_low_signal"
        ? ["no_low_signal"]
        : sleepStreak
          ? ["sleep_streak"]
          : [
              ...(sleepLow ? ["sleep"] : []),
              ...(hrvLow ? ["hrv"] : []),
              ...(restingHeartRateUp ? ["resting_heart_rate"] : [])
            ];
  return { coverage, assessment, reasonCodes, sleepRatio, hrvRatio, sleepLow, hrvLow, restingHeartRateUp, sleepStreak };
}

const base = (): CoachInput => ({
  today: "2026-09-03",
  latestDataDate: "2026-09-03",
  recoveryEvidenceDate: "2026-09-03",
  recoveryEvidenceStatus: "valid",
  calibration: "completed",
  eligibleSessions: 20,
  trueAbility: 44,
  currentAbility: 43.5,
  changeFrom7DaysAgo: 0.2,
  growthVelocityPerWeek: 0.1,
  decayPoints: 0,
  snapshotDate: "2026-09-03",
  explanationCodes: [],
  trainingStatus: "effective_stimulus",
  loadRatio: 1.05,
  rampRate: 0.1,
  strain: 40,
  strainP90: 80,
  monotony: 1.2,
  recoveryEvidence: 0.7,
  lastNightSleepMinutes: 420,
  sleepBaselineMinutes: 430,
  nightsBelowSleepBaseline: 0,
  morningHrvMs: 50,
  hrvBaselineMs: 52,
  restingHeartRateBpm: 52,
  restingHeartRateBaselineBpm: 53,
  consecutiveQualityDays: 0,
  daysSinceLastRun: 1,
  daysSinceLastQuality: 3,
  weekDistanceKm: 18,
  weekDurationSeconds: 7200,
  weekEasyDurationSeconds: 5400,
  weekQualityCount: 0,
  weeklyVolumeCeilingKm: 30,
  easyDurationFloorFraction: 0.7,
  qualitySessionCap: 2,
  fourWeekDistanceChangeFraction: 0.1,
  previousWeekDistanceKm: 20,
  currentWeekDistanceKm: 18,
  longestRun8WeekKm: 16,
  latestLongRunKm: 14,
  intendedEasyCount: 3,
  easyEnoughCount: 3,
  latestWorkout: null,
  todayWorkoutCount: 0,
  storedWeekPlan: [],
  lockedSession: null,
  zones: null,
  raceTarget: null,
  raceShapeScore: 0.6,
  raceVolumeFraction: 0.7,
  raceLongRunFraction: 0.8,
  weekDaily: []
});

test("the exported recovery thresholds are aliases, not second copies", () => {
  assert.equal(RECOVERY_SLEEP_RATIO_THRESHOLD, READINESS_SLEEP_RATIO_THRESHOLD);
  assert.equal(RECOVERY_HRV_RATIO_THRESHOLD, READINESS_HRV_RATIO_THRESHOLD);
  assert.equal(RECOVERY_RHR_RATIO_THRESHOLD, READINESS_RHR_RATIO_THRESHOLD);
  assert.equal(RECOVERY_SLEEP_STREAK_THRESHOLD, READINESS_SLEEP_STREAK_THRESHOLD);
});

test("the extracted rules reproduce the pre-refactor assessment over the whole input matrix", () => {
  // Values sit on both sides of every threshold: sleep 0.75 x 430 = 322.5,
  // hrv 0.85 x 52 = 44.2, rhr 1.03 x 53 = 54.59.
  const sleepValues: Array<number | null> = [null, 300, 320, 325, 420];
  const hrvValues: Array<number | null> = [null, 40, 44, 45, 52];
  const rhrValues: Array<number | null> = [null, 52, 54, 55, 60];
  const evidenceDates: Array<string | null> = ["2026-09-03", "2026-09-02", null];
  const evidenceStatuses: Array<CoachInput["recoveryEvidenceStatus"]> = ["valid", "partial", "stale", "unknown"];
  const streaks = [0, 2, 3];

  let compared = 0;
  const divergences: string[] = [];
  for (const sleep of sleepValues) {
    for (const hrv of hrvValues) {
      for (const rhr of rhrValues) {
        for (const evidenceDate of evidenceDates) {
          for (const status of evidenceStatuses) {
            for (const streak of streaks) {
              const input: CoachInput = {
                ...base(),
                lastNightSleepMinutes: sleep,
                morningHrvMs: hrv,
                restingHeartRateBpm: rhr,
                recoveryEvidenceDate: evidenceDate,
                recoveryEvidenceStatus: status,
                nightsBelowSleepBaseline: streak
              };
              const actual = assessRecovery(input);
              const expected = frozenAssessRecovery(input);
              compared += 1;
              try {
                assert.deepEqual(actual, expected);
              } catch {
                divergences.push(JSON.stringify({ ...input, actual, expected }).slice(0, 400));
              }
            }
          }
        }
      }
    }
  }

  assert.equal(divergences.length, 0, `divergences:\n${divergences.slice(0, 3).join("\n")}`);
  // Guards against the matrix silently collapsing to nothing. The literal is
  // checked with `node -e 'console.log(5*5*5*3*4*3)'` rather than by hand.
  assert.equal(
    compared,
    sleepValues.length * hrvValues.length * rhrValues.length * evidenceDates.length * evidenceStatuses.length * streaks.length
  );
  assert.equal(compared, 4500);
});

test("R03: a reading without its own baseline does not inflate coverage", () => {
  const input: CoachInput = {
    ...base(),
    sleepBaselineMinutes: null,
    hrvBaselineMs: null,
    restingHeartRateBaselineBpm: null
  };
  const readiness = assessReadiness({
    asOf: input.today,
    localDate: input.today,
    evidenceLocalDate: input.recoveryEvidenceDate,
    evidenceStatus: input.recoveryEvidenceStatus,
    sleepMinutes: input.lastNightSleepMinutes,
    sleepBaselineMinutes: input.sleepBaselineMinutes,
    nightsBelowSleepBaseline: input.nightsBelowSleepBaseline,
    hrvMs: input.morningHrvMs,
    hrvBaselineMs: input.hrvBaselineMs,
    restingHeartRateBpm: input.restingHeartRateBpm,
    restingHeartRateBaselineBpm: input.restingHeartRateBaselineBpm,
    observedAt: null,
    availableAt: null
  });
  assert.equal(readiness.coverage, "none");
  assert.equal(readiness.assessment, "not_assessed");
  assert.equal(readiness.signals.sleep.quality, "missing");
  assert.equal(readiness.signals.sleep.ratio, null);
});

test("yesterday's night is not today's evidence", () => {
  const yesterday = assessRecovery({ ...base(), recoveryEvidenceDate: "2026-09-02", recoveryEvidenceStatus: "valid" });
  assert.equal(yesterday.coverage, "none");
  assert.equal(yesterday.assessment, "not_assessed");
  // The ratio is still reported so the app can show the older night as reference.
  assert.notEqual(yesterday.sleepRatio, null);
});

test("readiness state is a heuristic mapping and says so", () => {
  const strained = assessReadiness({
    asOf: "2026-09-03",
    localDate: "2026-09-03",
    evidenceLocalDate: "2026-09-03",
    evidenceStatus: "valid",
    sleepMinutes: 300,
    sleepBaselineMinutes: 430,
    nightsBelowSleepBaseline: 0,
    hrvMs: 40,
    hrvBaselineMs: 52,
    restingHeartRateBpm: 60,
    restingHeartRateBaselineBpm: 53,
    observedAt: null,
    availableAt: null
  });
  assert.equal(strained.assessment, "multiple_low_signals");
  assert.equal(strained.state, "strained");
  assert.equal(strained.stateEvidence.method, "heuristic_rules");
  assert.equal(strained.stateEvidence.validationStatus, "not_empirically_validated");
  assert.equal(strained.stateEvidence.validationTarget, null);
  // An uncalibrated heuristic must not be dressed up as a 0-100 measurement.
  assert.equal(strained.score, null);
  assert.equal(strained.scoreStatus, "not_calibrated");
  assert.equal(strained.intendedUse, "training_guidance_not_diagnosis");
});

test("no low signal is not the same as fully recovered", () => {
  const single = assessReadiness({
    asOf: "2026-09-03",
    localDate: "2026-09-03",
    evidenceLocalDate: "2026-09-03",
    evidenceStatus: "valid",
    sleepMinutes: 430,
    sleepBaselineMinutes: 430,
    nightsBelowSleepBaseline: 0,
    hrvMs: null,
    hrvBaselineMs: null,
    restingHeartRateBpm: null,
    restingHeartRateBaselineBpm: null,
    observedAt: null,
    availableAt: null
  });
  assert.equal(single.coverage, "partial");
  assert.equal(single.assessment, "no_low_signal");
  assert.equal(single.state, "no_low_signal");
  // "not assessed" and "looks fine" must stay distinguishable in the payload.
  assert.notEqual(single.coverage, "complete");
});
