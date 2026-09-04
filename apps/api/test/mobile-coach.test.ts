import assert from "node:assert/strict";
import test from "node:test";

import {
  abilityExplanation,
  buildInjuryFlags,
  buildPostRun,
  decideDayPhase,
  decideNextSession,
  decideVerdict,
  isQualitySession,
  stimulusMatch,
  type CoachInput,
  type CoachLatestWorkout
} from "../src/mobile-coach.js";

const base = (): CoachInput => ({
  today: "2026-09-03",
  latestDataDate: "2026-09-03",
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
  weeklyDistanceGoalKm: 30,
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
  zones: {
    easyPaceLower: 330,
    easyPaceUpper: 390,
    easyHrLower: 120,
    easyHrUpper: 145,
    thresholdPaceLower: 270,
    thresholdPaceUpper: 300,
    thresholdHrLower: 160,
    thresholdHrUpper: 172,
    intervalPaceLower: 240,
    intervalPaceUpper: 265
  },
  raceTarget: null,
  raceShapeScore: 0.6,
  raceVolumeFraction: 0.7,
  raceLongRunFraction: 0.8,
  weekDaily: []
});

test("verdict is green when load and recovery allow a quality session", () => {
  const verdict = decideVerdict(base());
  assert.equal(verdict.tone, "green");
  const next = decideNextSession(base(), verdict);
  assert.ok(next.kind === "tempo" || next.kind === "interval");
});

test("high load ratio forces rest/easy", () => {
  const verdict = decideVerdict({ ...base(), loadRatio: 1.45, trainingStatus: "high_load" });
  assert.equal(verdict.tone, "red");
  assert.ok(verdict.triggers.some((item) => item.code === "load_ratio" || item.code === "training_status"));
  const next = decideNextSession(base(), verdict);
  assert.ok(next.kind === "recovery" || next.kind === "rest");
});

test("consecutive quality days block another hard session", () => {
  const verdict = decideVerdict({ ...base(), consecutiveQualityDays: 2 });
  assert.equal(verdict.tone, "red");
});

test("poor sleep with HRV and RHR together is red", () => {
  const verdict = decideVerdict({
    ...base(),
    lastNightSleepMinutes: 250,
    sleepBaselineMinutes: 420,
    morningHrvMs: 35,
    hrvBaselineMs: 52,
    restingHeartRateBpm: 60,
    restingHeartRateBaselineBpm: 52
  });
  assert.equal(verdict.tone, "red");
});

test("insufficient calibration stays yellow easy", () => {
  const verdict = decideVerdict({ ...base(), calibration: "calibrating", trainingStatus: "insufficient_data" });
  assert.equal(verdict.tone, "yellow");
  assert.ok(abilityExplanation({ ...base(), calibration: "calibrating" }).includes("校准"));
});

test("easy run that drifted into threshold is too_hard", () => {
  const workout: CoachLatestWorkout = {
    id: "w1",
    startedAt: "2026-09-02T01:00:00.000Z",
    localDate: "2026-09-02",
    sessionType: "easy",
    stimulusType: "lactate_threshold",
    indoor: false,
    currentAbility: 40,
    trueAbilityAfter: 44,
    trueAbilityDelta: 0,
    updatedTrueAbility: false,
    explanationCodes: [],
    missingReasons: [],
    heartRateCoverage: 0.9,
    easyHeartRateFraction: 0.5,
    thresholdHeartRateFraction: 0.35
  };
  assert.equal(stimulusMatch(workout), "too_hard");
  const post = buildPostRun(workout, 44, "2026-09-02", "easy", "yellow");
  assert.ok(post?.headline.includes("轻松"));
});

test("quality days follow session type not automatic stimulus", () => {
  assert.equal(isQualitySession("easy", "lactate_threshold"), false);
  assert.equal(isQualitySession("tempo", "aerobic_base"), true);
});

test("easy duration floor blocks a green quality window", () => {
  const verdict = decideVerdict({
    ...base(),
    weekEasyDurationSeconds: 1000,
    weekDurationSeconds: 7200,
    easyDurationFloorFraction: 0.7
  });
  assert.equal(verdict.tone, "yellow");
  assert.ok(verdict.reason.includes("轻松时长"));
});

test("taper does not dump leftover weekly volume into a long run", () => {
  const input = {
    ...base(),
    raceTarget: { date: "2026-09-10", distance: "ten_k" as const, targetPaceSecondsPerKm: null },
    weeklyDistanceGoalKm: 40,
    weekDistanceKm: 10
  };
  const verdict = decideVerdict(input);
  const next = decideNextSession(input, verdict);
  assert.notEqual(next.kind, "long_run");
  assert.equal(next.kind, "easy");
});

test("post-run only uses today's workout", () => {
  const workout: CoachLatestWorkout = {
    id: "w1",
    startedAt: "2026-09-01T01:00:00.000Z",
    localDate: "2026-09-01",
    sessionType: "easy",
    stimulusType: "aerobic_base",
    indoor: false,
    currentAbility: 40,
    trueAbilityAfter: 44,
    trueAbilityDelta: 0,
    updatedTrueAbility: true,
    explanationCodes: [],
    missingReasons: [],
    heartRateCoverage: 0.9,
    easyHeartRateFraction: 0.9,
    thresholdHeartRateFraction: 0
  };
  assert.equal(buildPostRun(workout, 44, "2026-09-03", "easy", "yellow"), null);
});

test("day phase distinguishes sync, morning, lock and post-run", () => {
  assert.equal(decideDayPhase({
    today: "2026-09-03",
    latestDataDate: "2026-09-02",
    todayWorkoutCount: 0,
    nextKind: "easy",
    lockPresent: false
  }), "need_sync");
  assert.equal(decideDayPhase({
    today: "2026-09-03",
    latestDataDate: "2026-09-03",
    todayWorkoutCount: 0,
    nextKind: "easy",
    lockPresent: false
  }), "morning_open");
  assert.equal(decideDayPhase({
    today: "2026-09-03",
    latestDataDate: "2026-09-03",
    todayWorkoutCount: 0,
    nextKind: "easy",
    lockPresent: true
  }), "locked");
  assert.equal(decideDayPhase({
    today: "2026-09-03",
    latestDataDate: "2026-09-03",
    todayWorkoutCount: 1,
    nextKind: "easy",
    lockPresent: true
  }), "post_run");
});

test("injury flags fire on volume and long-run jumps", () => {
  const flags = buildInjuryFlags({
    ...base(),
    fourWeekDistanceChangeFraction: 0.4,
    latestLongRunKm: 22,
    longestRun8WeekKm: 16
  });
  assert.ok(flags.some((flag) => flag.code === "volume_ramp"));
  assert.ok(flags.some((flag) => flag.code === "long_run_jump"));
});
