import assert from "node:assert/strict";
import test from "node:test";

import type { MobileLockedSession, MobileNextSession, MobilePlannedDay } from "@rai/api-contracts";

import {
  abilityExplanation,
  assessRecovery,
  buildInjuryFlags,
  buildRecovery,
  buildPostRun,
  buildRaceCard,
  buildRecommendation,
  buildSessionStructure,
  buildWeekPlan,
  decideDayPhase,
  decideNextSession,
  decideVerdict,
  intervalReps,
  isQualitySession,
  measureStructure,
  pacesFromZones,
  resolveLockedNextSession,
  roundKm,
  stimulusMatch,
  type CoachInput,
  type CoachLatestWorkout
} from "../src/mobile-coach.js";
import { assembleMobileWorkoutPlan } from "../src/mobile-read.js";

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

test("recovery display score is current-day only and uses available comparable components", () => {
  const current = buildRecovery(base());
  assert.equal(current.score, 98);
  const partial = buildRecovery({ ...base(), morningHrvMs: null });
  assert.equal(partial.score, 99);
  const stale = buildRecovery({ ...base(), recoveryEvidenceDate: "2026-09-02", recoveryEvidenceStatus: "stale" });
  assert.equal(stale.score, null);
  const noBaseline = buildRecovery({ ...base(), sleepBaselineMinutes: null, hrvBaselineMs: null, restingHeartRateBaselineBpm: null });
  assert.equal(noBaseline.score, null);
});

test("historical recovery no longer vetoes today's base arrangement", () => {
  const input = { ...base(), latestDataDate: "2026-08-01", recoveryEvidenceDate: "2026-08-01", recoveryEvidenceStatus: "stale" as const };
  const verdict = decideVerdict(input);
  // The base arrangement comes from load, plan and quality spacing. An older
  // night is a coverage gap: it neither cancels the session nor gets presented
  // as today's reading.
  assert.equal(verdict.tone, "green");
  assert.equal(verdict.stale, true);
  assert.ok(verdict.reasonCodes?.includes("recovery_evidence_absent"));
  assert.ok(!verdict.reasonCodes?.includes("recovery_evidence_missing"));
  assert.ok(verdict.reasonCodes?.includes("quality_window"));
  assert.match(verdict.reason, /未结合今日恢复监测/);
  // Yesterday's low-sleep streak must not become today's streak.
  assert.equal(decideVerdict({ ...input, nightsBelowSleepBaseline: 3 }).tone, "green");
  // Recovery-independent warnings still fire. Since §9.5 the load verdict comes from the single
  // classification, so the row states the status the builder would emit for this ratio
  // (`loadRatio > 1.3` ⇒ `high_load`) instead of an inconsistent hand-built pair.
  assert.equal(decideVerdict({ ...input, loadRatio: 1.5, trainingStatus: "high_load" }).tone, "red");
  assert.equal(decideVerdict({ ...input, consecutiveQualityDays: 2 }).tone, "red");
});

test("yesterday's poor recovery is not inherited by today", () => {
  const poor = { lastNightSleepMinutes: 260, morningHrvMs: 30, restingHeartRateBpm: 58 };
  // The same numbers are a negative finding when they belong to today ...
  assert.equal(decideVerdict({ ...base(), ...poor }).tone, "red");
  // ... and must not decide today once the evidence belongs to an earlier night.
  const yesterday = decideVerdict({ ...base(), ...poor, recoveryEvidenceDate: "2026-09-02", recoveryEvidenceStatus: "stale" as const });
  assert.equal(yesterday.tone, "green");
  assert.equal(yesterday.stale, true);
  assert.ok(yesterday.reasonCodes?.includes("recovery_evidence_absent"));
});

test("recovery freshness follows its date, independently of training freshness", () => {
  assert.equal(decideVerdict({ ...base(), latestDataDate: "2026-08-01" }).stale, false);
  for (const recoveryEvidenceDate of ["2026-09-02", "2026-09-04", null]) {
    assert.equal(decideVerdict({ ...base(), recoveryEvidenceDate }).stale, true);
  }
  assert.equal(decideVerdict({ ...base(), recoveryEvidenceStatus: "stale" }).stale, true);
  assert.equal(decideVerdict({ ...base(), recoveryEvidenceStatus: "partial", morningHrvMs: null }).stale, false);
});

test("missing recovery cannot hide high load or consecutive quality warnings", () => {
  const input = { ...base(), morningHrvMs: null };
  // §9.5: the ratio no longer votes on its own; a real row with this ratio carries `high_load`.
  assert.equal(decideVerdict({ ...input, loadRatio: 1.5, trainingStatus: "high_load" }).tone, "red");
  assert.equal(decideVerdict({ ...input, consecutiveQualityDays: 2 }).tone, "red");
  // A missing personal baseline is insufficient evidence, not a negative finding.
  const noBaseline = decideVerdict({ ...base(), hrvBaselineMs: null });
  assert.equal(noBaseline.tone, "green");
  assert.ok(noBaseline.reasonCodes?.includes("recovery_evidence_partial"));
  assert.ok(!noBaseline.reasonCodes?.includes("recovery_evidence_missing"));
});

test("missing recovery records remove an input instead of adding a warning", () => {
  const verdict = decideVerdict({
    ...base(),
    lastNightSleepMinutes: null,
    morningHrvMs: null,
    restingHeartRateBpm: null,
    recoveryEvidenceStatus: "unknown",
    recoveryEvidenceDate: null
  });
  assert.equal(verdict.tone, "green");
  assert.equal(verdict.stale, true);
  assert.ok(verdict.reasonCodes?.includes("recovery_evidence_absent"));
  assert.ok(verdict.reasonCodes?.includes("quality_window"));
  assert.match(verdict.reason, /未结合今日恢复监测/);
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
    weeklyVolumeCeilingKm: 40,
    weekDistanceKm: 10
  };
  const verdict = decideVerdict(input);
  const next = decideNextSession(input, verdict);
  assert.notEqual(next.kind, "long_run");
  assert.equal(next.kind, "rest", "pre-race dose below 30 minutes rests instead of being padded");
  assert.match(next.reason, /minimum_session_not_feasible/);
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

test("reported distance and duration never contradict the structured prescription", () => {
  for (const daysSinceLastQuality of [0, 1, 3, 5, 8, 14]) {
    const input = { ...base(), daysSinceLastQuality };
    const next = decideNextSession(input, decideVerdict(input));
    if (next.kind === "rest") {
      assert.equal(next.structure, null);
      assert.equal(next.distanceKm, null);
      assert.equal(next.durationMinutes, null);
      continue;
    }
    assert.ok(next.structure, `${next.kind} 应当带结构`);
    const measured = measureStructure(next.structure!, next.kind, pacesFromZones(input.zones));
    assert.ok(
      Math.abs((next.distanceKm ?? 0) - measured.distanceKm) <= 0.5,
      `${next.kind}: 显示 ${next.distanceKm}km 与结构反推 ${measured.distanceKm}km 不符`
    );
    assert.equal(next.durationMinutes, Math.round(measured.durationSeconds / 60));
  }
});

test("interval is prescribed as distance-based 800m repeats with a fatigue cap", () => {
  const input = { ...base(), daysSinceLastQuality: 5 };
  const next = decideNextSession(input, decideVerdict(input));
  assert.equal(next.kind, "interval");
  const block = next.structure?.blocks[0];
  assert.ok(block);
  const workStep = block.steps[0];
  const restStep = block.steps[1];
  assert.ok(workStep);
  assert.ok(restStep);
  assert.ok(block.iterations >= 4);
  assert.deepEqual(workStep.goal, { type: "distance", meters: 800 });
  assert.equal(workStep.purpose, "work");
  assert.equal(workStep.alert?.kind, "pace");
  // one alert per step at most — recovery steps stay silent
  assert.equal(restStep.alert, null);
  assert.equal(restStep.purpose, "recovery");
  assert.equal(restStep.goal.type, "time");

  assert.equal(intervalReps({ ...base(), daysSinceLastQuality: 20 }), 8);
  assert.equal(intervalReps({ ...base(), daysSinceLastQuality: 5 }), 5);
  assert.equal(intervalReps({ ...base(), daysSinceLastQuality: 20, strain: 90, strainP90: 80 }), 4);
  assert.equal(intervalReps({ ...base(), daysSinceLastQuality: 20, loadRatio: 1.6 }), 4);
});

test("tempo is prescribed as threshold repeats", () => {
  const input = { ...base(), daysSinceLastQuality: 2 };
  const next = decideNextSession(input, decideVerdict(input));
  assert.equal(next.kind, "tempo");
  const block = next.structure?.blocks[0];
  assert.ok(block);
  const workStep = block.steps[0];
  assert.ok(workStep);
  assert.equal(block.iterations, 3);
  assert.deepEqual(workStep.goal, { type: "time", seconds: 480 });
  assert.equal(workStep.alert?.kind, "pace");
});

test("easy sessions get a warmup, a single work block and a cooldown", () => {
  const input = {
    ...base(),
    calibration: "calibrating" as const,
    trainingStatus: "insufficient_data" as const
  };
  const next = decideNextSession(input, decideVerdict(input));
  assert.equal(next.kind, "easy");
  const structure = next.structure;
  assert.ok(structure);
  const firstBlock = structure.blocks[0];
  assert.ok(firstBlock);
  const workStep = firstBlock.steps[0];
  assert.ok(workStep);
  assert.equal(structure.warmup?.purpose, "warmup");
  assert.equal(structure.cooldown?.purpose, "cooldown");
  assert.equal(structure.blocks.length, 1);
  assert.equal(firstBlock.iterations, 1);
  assert.equal(workStep.purpose, "work");
  assert.equal(workStep.goal.type, "time");
  assert.equal(workStep.goal.type === "time" ? workStep.goal.seconds : null, 1200);
});

test("rest days carry no prescription and no structure", () => {
  const input = { ...base(), nightsBelowSleepBaseline: 3 };
  const verdict = decideVerdict(input);
  assert.equal(verdict.tone, "red");
  const next = decideNextSession(input, verdict);
  assert.equal(next.kind, "rest");
  assert.equal(next.structure, null);
  assert.equal(next.distanceKm, null);
  assert.equal(next.durationMinutes, null);
});

test("missing zone profile still yields a measurable structure without alerts", () => {
  const input = {
    ...base(),
    zones: null,
    calibration: "calibrating" as const,
    trainingStatus: "insufficient_data" as const
  };
  const next = decideNextSession(input, decideVerdict(input));
  assert.equal(next.kind, "easy");
  const structure = next.structure;
  assert.ok(structure);
  const firstBlock = structure.blocks[0];
  assert.ok(firstBlock);
  const workStep = firstBlock.steps[0];
  assert.ok(workStep);
  assert.equal(structure.warmup?.alert, null);
  assert.equal(workStep.alert, null);
  const measured = measureStructure(structure, next.kind, pacesFromZones(null));
  assert.ok(Math.abs((next.distanceKm ?? 0) - measured.distanceKm) <= 0.5);
  assert.ok((next.distanceKm ?? 0) > 0);
});

test("a stored plan day is measured from its structure, never from the hint beside it", () => {
  // The goals editor used to persist its own distance next to the generated
  // structure, so `/v1/mobile/today` rendered the typed 7 km while
  // `/v1/mobile/workout-plan` measured the 6 × 800 m the watch would run.
  const structure = buildSessionStructure("interval", base().zones, { reps: 6 });
  assert.ok(structure);
  const measured = measureStructure(structure, "interval", pacesFromZones(base().zones));
  const stored: MobilePlannedDay = {
    localDate: "2026-09-05",
    kind: "interval",
    distanceKm: 7,
    structure
  };
  const input: CoachInput = {
    ...base(),
    storedWeekPlan: [stored],
    weekDaily: [{ localDate: "2026-09-05", distanceKm: 0, workoutCount: 0, workoutId: null }]
  };

  const weekPlan = buildWeekPlan(input, decideNextSession(input, decideVerdict(input)));
  const day = weekPlan.find((entry) => entry.localDate === "2026-09-05");
  assert.ok(day);
  assert.equal(day.distanceKm, roundKm(measured.distanceKm));
  assert.notEqual(day.distanceKm, 7);
  assert.deepEqual(day.structure, structure);
});

test("a plan day with no structure is measured from the one its hint builds", () => {
  // Same rule for a hand-written row: the hint is a build request, not a value.
  const input: CoachInput = {
    ...base(),
    storedWeekPlan: [{ localDate: "2026-09-05", kind: "easy", distanceKm: 12 }],
    weekDaily: [{ localDate: "2026-09-05", distanceKm: 0, workoutCount: 0, workoutId: null }]
  };
  const weekPlan = buildWeekPlan(input, decideNextSession(input, decideVerdict(input)));
  const day = weekPlan.find((entry) => entry.localDate === "2026-09-05");
  assert.ok(day?.structure);
  const measured = measureStructure(day.structure, day.kind as "easy", pacesFromZones(base().zones));
  assert.equal(day.distanceKm, roundKm(measured.distanceKm));
});

test("both plan endpoints give a stored day the same distance", () => {
  // `/v1/mobile/today` builds its week through `buildWeekPlan`;
  // `/v1/mobile/workout-plan` builds it through `assembleMobileWorkoutPlan`.
  // They render the same stored row, so the two must agree — the editor typed
  // 7 km next to a 6 × 800 m structure, and only the structure is real.
  const structure = buildSessionStructure("interval", null, { reps: 6 });
  assert.ok(structure);
  const storedPlan: MobilePlannedDay[] = [
    { localDate: "2026-09-05", kind: "interval", distanceKm: 7, structure }
  ];
  const input: CoachInput = {
    ...base(),
    zones: null,
    storedWeekPlan: storedPlan,
    weekDaily: [{ localDate: "2026-09-05", distanceKm: 0, workoutCount: 0, workoutId: null }]
  };
  const todaySession: MobileNextSession = {
    kind: "easy",
    title: "轻松跑",
    reason: "闸门放行",
    distanceKm: 8,
    durationMinutes: 50,
    paceSecondsPerKmLower: null,
    paceSecondsPerKmUpper: null,
    heartRateBpmLower: null,
    heartRateBpmUpper: null,
    structure: buildSessionStructure("easy", null, { targetDistanceKm: 8 })
  };

  const weekPlanSide = buildWeekPlan(input, todaySession);
  const planSide = assembleMobileWorkoutPlan({
    today: "2026-09-03",
    todaySession,
    todayCompleted: false,
    storedPlan,
    zones: null,
    audit: null,
    planRevision: 0
  });

  const fromCoach = weekPlanSide.find((day) => day.localDate === "2026-09-05");
  const fromPlan = planSide.days.find((day) => day.localDate === "2026-09-05");
  assert.ok(fromCoach && fromPlan);
  assert.equal(fromCoach.distanceKm, fromPlan.distanceKm);
  assert.equal(fromCoach.distanceKm, roundKm(measureStructure(structure, "interval", pacesFromZones(null)).distanceKm));
  assert.notEqual(fromCoach.distanceKm, 7);
});

test("a past prescribed session with no observation reports intent, not rest", () => {
  // §5.3: intent (what was prescribed), observation (what was recorded) and
  // effective (what may execute) are three different facts. The old projection
  // returned `rest` for every past date without an import *before* it read the
  // stored plan, so a prescribed interval and an intentional rest day produced
  // the same row. A past date no longer executes; its prescription is a record,
  // so the row has to say "planned, unobserved" instead of claiming a rest.
  const today = base().today;
  const past = "2026-09-01"; // Monday of the same week as today (2026-09-03)
  const structure = buildSessionStructure("interval", base().zones, { reps: 6 });
  assert.ok(structure);
  const input: CoachInput = {
    ...base(),
    storedWeekPlan: [{ localDate: past, kind: "interval", distanceKm: 7, structure }],
    weekDaily: [
      { localDate: past, distanceKm: 0, workoutCount: 0, workoutId: null },
      { localDate: today, distanceKm: 0, workoutCount: 0, workoutId: null }
    ]
  };
  const day = buildWeekPlan(input, decideNextSession(input, decideVerdict(input)))
    .find((row) => row.localDate === past);
  assert.ok(day);
  assert.equal(day.kind, "interval", "the prescription must not be overwritten with rest");
  assert.equal(day.intentKind, "interval", "what was prescribed is reported separately from the display kind");
  assert.equal(day.observation, "unknown", "no import was recorded; unknown is not the same claim as rest");
  assert.equal(day.planned, true);
  assert.match(day.title, /^原计划间歇／尚无训练观测$/);
  // The distance still comes from the prescription's own structure, never from
  // the stored hint beside it — the same measurement path as a future stored day.
  assert.equal(
    day.distanceKm,
    roundKm(measureStructure(structure, "interval", pacesFromZones(base().zones)).distanceKm)
  );
  assert.ok(day.structure, "intent keeps the prescription the runner was given");
});

test("an observed date stays completed/observed and keeps the prescription it replaced", () => {
  const observed = "2026-09-01";
  const input: CoachInput = {
    ...base(),
    storedWeekPlan: [{ localDate: observed, kind: "interval", distanceKm: 7 }],
    weekDaily: [{ localDate: observed, distanceKm: 5.2, workoutCount: 1, workoutId: "workout-1" }]
  };
  const row = buildWeekPlan(input, decideNextSession(input, decideVerdict(input)))
    .find((day) => day.localDate === observed);
  assert.ok(row);
  assert.equal(row.kind, "completed");
  assert.equal(row.observation, "observed");
  assert.equal(row.intentKind, "interval", "the observation does not erase what was prescribed");
  assert.equal(row.completedWorkoutId, "workout-1");

  const unplanned = buildWeekPlan({ ...input, storedWeekPlan: [] }, decideNextSession(input, decideVerdict(input)))
    .find((day) => day.localDate === observed);
  assert.ok(unplanned);
  assert.equal(unplanned.kind, "completed");
  assert.equal(unplanned.observation, "observed");
  assert.equal(unplanned.intentKind, null, "an unplanned run has no prescription to report");
});

test("a past date with no prescription says it was not planned", () => {
  const input: CoachInput = {
    ...base(),
    storedWeekPlan: [{ localDate: "2026-09-01", kind: "rest", distanceKm: null }],
    weekDaily: [
      { localDate: "2026-09-01", distanceKm: 0, workoutCount: 0, workoutId: null },
      { localDate: "2026-09-02", distanceKm: 0, workoutCount: 0, workoutId: null }
    ]
  };
  const week = buildWeekPlan(input, decideNextSession(input, decideVerdict(input)));
  const prescribedRest = week.find((day) => day.localDate === "2026-09-01");
  const unplanned = week.find((day) => day.localDate === "2026-09-02");
  assert.ok(prescribedRest && unplanned);
  for (const day of [prescribedRest, unplanned]) {
    assert.equal(day.kind, "rest");
    assert.equal(day.observation, "unknown");
  }
  // Both display as rest, but they are not the same claim: one was prescribed,
  // the other was never planned and no rest was observed.
  assert.equal(prescribedRest.planned, true);
  assert.equal(prescribedRest.intentKind, "rest");
  assert.equal(prescribedRest.title, "原计划休息");
  assert.equal(unplanned.planned, false);
  assert.equal(unplanned.intentKind, null);
  assert.equal(unplanned.title, "未安排训练");
});

test("today and future rows keep their existing projection", () => {
  // Scope guard: PR2 fixes the past-day read projection only. Today's row is the
  // gate-resolved effective session and future rows are the executable plan;
  // neither reports intent/observation yet (iOS rendering lands in PR5).
  const today = base().today;
  const future = "2026-09-05";
  const input: CoachInput = {
    ...base(),
    storedWeekPlan: [
      { localDate: future, kind: "easy", distanceKm: 8 },
      { localDate: today, kind: "interval", distanceKm: 9 }
    ],
    weekDaily: [
      { localDate: today, distanceKm: 0, workoutCount: 0, workoutId: null },
      { localDate: future, distanceKm: 0, workoutCount: 0, workoutId: null }
    ]
  };
  const next = decideNextSession(input, decideVerdict(input));
  const week = buildWeekPlan(input, next);
  const todayRow = week.find((day) => day.localDate === today);
  const futureRow = week.find((day) => day.localDate === future);
  assert.ok(todayRow && futureRow);
  assert.equal(todayRow.kind, next.kind);
  assert.equal(todayRow.title, next.title);
  assert.equal(todayRow.planned, true);
  assert.equal(todayRow.observation, undefined);
  assert.equal(todayRow.intentKind, undefined);
  assert.equal(futureRow.kind, "easy");
  assert.equal(futureRow.title, "轻松跑");
  assert.equal(futureRow.planned, true);
  assert.equal(futureRow.observation, undefined);
  assert.equal(futureRow.intentKind, undefined);
});

test("a locked snapshot is re-measured, and today's card matches the executable week", () => {
  // The lock is a frozen copy of a recommendation, and snapshots written before
  // structured sessions existed carry a distance with no structure at all.
  // `/v1/mobile/today` returns that copy as `nextSession` *and* renders it inside
  // `weekPlan`, while `/v1/mobile/workout-plan` renders it as a day — three
  // readers, one number.
  const today = base().today;
  const locked: MobileLockedSession = {
    localDate: today,
    verdictTone: "green",
    lockedAt: new Date(0).toISOString(),
    session: {
      kind: "interval",
      title: "间歇 / VO₂",
      reason: "",
      distanceKm: 7,
      durationMinutes: 40,
      paceSecondsPerKmLower: null,
      paceSecondsPerKmUpper: null,
      heartRateBpmLower: null,
      heartRateBpmUpper: null,
      structure: null
    }
  };
  const input: CoachInput = {
    ...base(),
    zones: null,
    lockedSession: locked,
    weekDaily: [{ localDate: today, distanceKm: 0, workoutCount: 0, workoutId: null }]
  };
  const next = resolveLockedNextSession(decideNextSession(input, decideVerdict(input)), locked, today, input.zones);

  const structure = buildSessionStructure("interval", null, {});
  assert.ok(structure);
  const measured = roundKm(measureStructure(structure, "interval", pacesFromZones(null)).distanceKm);
  assert.ok(next.structure, "锁定快照必须被重建成可执行的结构");
  assert.equal(next.distanceKm, measured, "锁定快照的距离必须由结构反推");
  assert.notEqual(next.distanceKm, 7, "快照里存着的 7km 不是距离的来源");

  const card = buildWeekPlan(input, next).find((day) => day.localDate === today);
  assert.ok(card);
  assert.equal(card.distanceKm, measured);
  assert.equal(card.structure != null, true);

  const plan = assembleMobileWorkoutPlan({
    today,
    todaySession: next,
    todayCompleted: false,
    storedPlan: [],
    zones: null,
    audit: null,
    planRevision: 0
  });
  assert.equal(plan.days[0]?.distanceKm, measured);
});


test("race card explains default distance and refreshes countdown and taper from the target", () => {
  const empty = buildRaceCard(base());
  assert.equal(empty.target, null);
  assert.equal(empty.daysUntil, null);
  assert.equal(empty.taper, false);
  assert.match(empty.note, /默认按 10 公里/);
  const target = { date: "2026-09-10", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 };
  const near = buildRaceCard({ ...base(), raceTarget: target });
  assert.deepEqual(near.target, target);
  assert.equal(near.daysUntil, 7);
  assert.equal(near.taper, true);
  const far = buildRaceCard({ ...base(), raceTarget: { ...target, date: "2026-12-06" } });
  assert.equal(far.taper, false);
  assert.match(far.note, /赛事准备度 60%/);
  assert.doesNotMatch(far.note, /体型|专项形态/);
  const expired = buildRaceCard({ ...base(), raceTarget: { ...target, date: "2026-09-01" } });
  assert.equal(expired.daysUntil, -2);
  assert.equal(expired.taper, false);
  assert.match(expired.note, /已过期/);
});

test("race card taper uses the shared 14-day protection window and excludes race day", () => {
  const target = (date: string) => ({ date, distance: "ten_k" as const, targetPaceSecondsPerKm: null });
  // 2026-09-03 is the base() "today".
  const dayBefore = buildRaceCard({ ...base(), raceTarget: target("2026-09-04") });
  assert.equal(dayBefore.daysUntil, 1);
  assert.equal(dayBefore.taper, true);
  assert.match(dayBefore.note, /进入减量/);

  const fourteen = buildRaceCard({ ...base(), raceTarget: target("2026-09-17") });
  assert.equal(fourteen.daysUntil, 14);
  assert.equal(fourteen.taper, true, "the last day of the shared protection window still counts");
  assert.match(fourteen.note, /进入减量/);

  const fifteen = buildRaceCard({ ...base(), raceTarget: target("2026-09-18") });
  assert.equal(fifteen.daysUntil, 15);
  assert.equal(fifteen.taper, false, "one day past the shared window is not the taper");
  assert.doesNotMatch(fifteen.note, /进入减量/);

  const raceDay = buildRaceCard({ ...base(), raceTarget: target("2026-09-03") });
  assert.equal(raceDay.daysUntil, 0);
  assert.equal(raceDay.taper, false, "race day is not the taper");
  assert.match(raceDay.note, /还有 0 天/);
  assert.doesNotMatch(raceDay.note, /进入减量/);
});

// ── 恢复覆盖与评估 ─────────────────────────────────────────────
// The published assessment and the verdict gates read one function, so these
// assertions cover both what the app explains and what the coach decided.

const poorNight = {
  lastNightSleepMinutes: 300,
  sleepBaselineMinutes: 430,
  morningHrvMs: 40,
  hrvBaselineMs: 52,
  restingHeartRateBpm: 58,
  restingHeartRateBaselineBpm: 53
};

test("a missing night is not assessed and never reads as a low signal", () => {
  const missing = {
    ...base(),
    recoveryEvidenceDate: null,
    recoveryEvidenceStatus: "unknown" as const,
    lastNightSleepMinutes: null,
    morningHrvMs: null,
    restingHeartRateBpm: null
  };
  const assessment = assessRecovery(missing);
  assert.equal(assessment.coverage, "none");
  assert.equal(assessment.assessment, "not_assessed");
  assert.deepEqual(assessment.reasonCodes, ["not_assessed"]);

  const verdict = decideVerdict(missing, assessment);
  assert.equal(verdict.stale, true);
  assert.ok(verdict.triggers.some((item) => item.code === "recovery_evidence_absent"));
  assert.ok(
    verdict.triggers.every((item) => item.code !== "sleep" && item.code !== "sleep_streak" && item.code !== "hrv"),
    "缺测只移除输入，不得变成一条负面证据"
  );
  assert.equal(buildRecommendation(missing, assessment, verdict).recoveryAdjustment, "no_evidence");
});

test("the same poor numbers stop vetoing once they belong to yesterday", () => {
  const today = base();
  const inherited = { ...today, ...poorNight };
  assert.equal(assessRecovery(inherited).assessment, "multiple_low_signals");
  const inheritedVerdict = decideVerdict(inherited);
  assert.equal(inheritedVerdict.tone, "red");
  const inheritedAssessment = assessRecovery(inherited);
  assert.equal(
    buildRecommendation(inherited, inheritedAssessment, inheritedVerdict).recoveryAdjustment,
    "veto",
    "决定今天安排的是恢复本身"
  );

  const yesterday = {
    ...today,
    ...poorNight,
    recoveryEvidenceDate: "2026-09-02",
    recoveryEvidenceStatus: "stale" as const
  };
  const assessment = assessRecovery(yesterday);
  assert.equal(assessment.coverage, "none", "归属昨天就不是今天的证据");
  assert.equal(assessment.assessment, "not_assessed");
  const verdict = decideVerdict(yesterday, assessment);
  assert.equal(verdict.tone, "green", "负荷与计划允许质量课");
  const recommendation = buildRecommendation(yesterday, assessment, verdict);
  assert.equal(recommendation.recoveryAdjustment, "no_evidence", "缺测既不是批准也不是降级");
  assert.equal(recommendation.basis, "training_load_and_plan");
});

test("coverage needs a comparable baseline, and a partial day says so", () => {
  const noBaseline = { ...base(), sleepBaselineMinutes: null, hrvBaselineMs: null, restingHeartRateBaselineBpm: null };
  const assessment = assessRecovery(noBaseline);
  assert.equal(assessment.coverage, "none", "有读数但没有可比基线，判断不了");
  assert.equal(assessment.assessment, "not_assessed");
  // A reading nothing can be compared against is not "consulted but incomplete":
  // it is not consulted at all, and the wording has to say so.
  assert.ok(
    decideVerdict(noBaseline, assessment).triggers.some((item) => item.code === "recovery_evidence_absent"),
    "比不了的读数不得被说成恢复证据不完整"
  );
  assert.ok(
    !decideVerdict(noBaseline, assessment).triggers.some((item) => item.code === "recovery_evidence_partial")
  );

  const partialInput = { ...base(), hrvBaselineMs: null };
  const partialAssessment = assessRecovery(partialInput);
  assert.equal(partialAssessment.coverage, "partial");
  assert.equal(partialAssessment.assessment, "no_low_signal");
  assert.equal(assessRecovery(base()).coverage, "complete");

  const partialVerdict = decideVerdict(partialInput, partialAssessment);
  assert.equal(partialVerdict.tone, "green", "缺一项不等于有风险");
  const recommendation = buildRecommendation(partialInput, partialAssessment, partialVerdict);
  assert.equal(recommendation.recoveryAdjustment, "none", "被查过并且没有否决，就是 none");
  assert.ok(recommendation.uncertaintyReasons.some((reason) => reason.includes("恢复证据不完整")));
});

test("the recommendation names its basis and separates a veto from missing evidence", () => {
  const input = base();
  const assessment = assessRecovery(input);
  const verdict = decideVerdict(input, assessment);
  const green = buildRecommendation(input, assessment, verdict);
  assert.equal(green.basis, "training_load_and_plan");
  assert.equal(green.recoveryAdjustment, "none");
  assert.deepEqual(green.reasonCodes, ["training_load_and_plan"]);

  // §9.5: a ratio above 1.5 is `attention` in the single classification, so the row says so.
  const overloaded = { ...input, loadRatio: 1.6, trainingStatus: "attention" as const };
  assert.equal(
    buildRecommendation(overloaded, assessRecovery(overloaded), decideVerdict(overloaded)).basis,
    "high_load"
  );

  const thin = { ...input, latestDataDate: null };
  const thinRecommendation = buildRecommendation(thin, assessRecovery(thin), decideVerdict(thin));
  assert.ok(thinRecommendation.uncertaintyReasons.some((reason) => reason.includes("还没有导入训练数据")));
  assert.ok(!thinRecommendation.reasonCodes.includes("recovery_downgraded"));

  const vetoed = { ...input, ...poorNight };
  const vetoAssessment = assessRecovery(vetoed);
  const veto = buildRecommendation(vetoed, vetoAssessment, decideVerdict(vetoed, vetoAssessment));
  assert.equal(veto.recoveryAdjustment, "veto");
  assert.ok(veto.reasonCodes.includes("recovery_downgraded"));
});

test("the night that woke today is the one the verdict reads", () => {
  // Same values, different evidence date: the verdict must follow the date, not
  // the numbers, and only the today-dated night may permit `complete` coverage.
  const single = { ...base(), lastNightSleepMinutes: 300 };
  assert.equal(assessRecovery(single).assessment, "low_signal", "一夜偏低只降级，不直接停练");
  assert.equal(decideVerdict(single).tone, "yellow");
  assert.equal(decideVerdict(single).title, "只宜有氧");

  const streak = { ...base(), nightsBelowSleepBaseline: 3, lastNightSleepMinutes: 300 };
  assert.equal(assessRecovery(streak).assessment, "multiple_low_signals");
  assert.deepEqual(assessRecovery(streak).reasonCodes, ["sleep_streak"], "连续低睡眠优先于单夜读数");
  assert.equal(decideVerdict(streak).tone, "red");

  // An HRV dip alone does not veto: it needs the elevated resting heart rate too.
  const hrvOnly = { ...base(), morningHrvMs: 40 };
  assert.equal(assessRecovery(hrvOnly).assessment, "no_low_signal");
  assert.equal(decideVerdict(hrvOnly).tone, "green");
});

test("stored rest and long-run days drive today; red gates still veto training", () => {
  const input = base();
  input.raceTarget = null;
  input.storedWeekPlan = [{ localDate: input.today, kind: "rest", distanceKm: null }];
  const green = { tone: "green" as const, title: "可训练", reason: "符合训练条件", triggers: [], stale: false };
  assert.equal(decideNextSession(input, green).kind, "rest");
  input.storedWeekPlan = [{ localDate: input.today, kind: "long_run", distanceKm: 12 }];
  const planned = decideNextSession(input, green);
  assert.equal(planned.kind, "long_run");
  assert.ok(Math.abs((planned.distanceKm ?? 0) - 12) < 0.2);
  input.nightsBelowSleepBaseline = 3;
  assert.equal(decideNextSession(input, { ...green, tone: "red" }).kind, "rest");
  input.raceTarget = { date: input.today, distance: "ten_k", targetPaceSecondsPerKm: 300 };
  assert.equal(decideNextSession(input, green).kind, "rest");
});
