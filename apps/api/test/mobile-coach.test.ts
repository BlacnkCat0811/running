import assert from "node:assert/strict";
import test from "node:test";

import type { MobileLockedSession, MobileNextSession, MobilePlannedDay } from "@rai/api-contracts";

import {
  abilityExplanation,
  buildInjuryFlags,
  buildPostRun,
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

test("historical recovery blocks quality and locking without hiding risk warnings", () => {
  const input = { ...base(), latestDataDate: "2026-08-01", recoveryEvidenceDate: "2026-08-01", recoveryEvidenceStatus: "stale" as const };
  const verdict = decideVerdict(input);
  assert.equal(verdict.tone, "yellow");
  assert.equal(verdict.stale, true);
  assert.ok(verdict.reasonCodes?.includes("recovery_evidence_stale"));
  assert.ok(!verdict.reasonCodes?.includes("quality_window"));
  assert.ok(!["tempo", "interval"].includes(decideNextSession(input, verdict).kind));
  assert.equal(decideVerdict({ ...input, loadRatio: 1.5 }).tone, "red");
  assert.equal(decideVerdict({ ...input, nightsBelowSleepBaseline: 3 }).tone, "red");
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
  assert.equal(decideVerdict({ ...input, loadRatio: 1.5 }).tone, "red");
  assert.equal(decideVerdict({ ...input, consecutiveQualityDays: 2 }).tone, "red");
  assert.equal(decideVerdict({ ...base(), hrvBaselineMs: null }).tone, "yellow");
});

test("missing recovery facts stay conservative", () => {
  const verdict = decideVerdict({
    ...base(),
    lastNightSleepMinutes: null,
    morningHrvMs: null,
    restingHeartRateBpm: null,
    recoveryEvidenceStatus: "unknown",
    recoveryEvidenceDate: null
  });
  assert.equal(verdict.tone, "yellow");
  assert.equal(verdict.stale, true);
  assert.ok(verdict.reasonCodes?.includes("recovery_evidence_missing"));
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
  assert.equal(workStep.goal.type, "distance");
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
