import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MobilePlannedDay, MobileSessionStructure, MobileTodayResponse } from "@rai/api-contracts";

import { buildPeriodization } from "../src/plan-periodization.js";
import type { CoachZonePrescription } from "../src/mobile-coach.js";
import { buildSessionStructure, measureStructure, pacesFromZones, roundKm } from "../src/mobile-coach.js";
import { MAX_PLANNED_DISTANCE_KM, structureWorkRepetitions } from "../src/session-structure.js";
import { ManualPlanPolicyError, validateManualPlan } from "../src/manual-plan-policy.js";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import type { MobileGoalsResponse } from "@rai/api-contracts";
import {
  generateWeeklyPlan,
  constrainUpcomingPlan,
  overwriteWarning,
  overwrittenPlanDates,
  mergePlanWindow,
  weeklyPlanDates
} from "../src/weekly-plan-service.js";
import {
  buildCoachWeekPlan,
  parsePlanJson,
  RAMP_BASE_FLOOR_FRACTION,
  RAMP_LIMIT_FRACTION,
  validateWeeklyPlan,
  VOLUME_CEILING_TOLERANCE,
  weeklyPlanVolumeCeiling
} from "../src/weekly-plan-validate.js";

const PRESCRIPTION: CoachZonePrescription = {
  easyPaceLower: 330,
  easyPaceUpper: 390,
  easyHrLower: 120,
  easyHrUpper: 150,
  thresholdPaceLower: 270,
  thresholdPaceUpper: 300,
  thresholdHrLower: 160,
  thresholdHrUpper: 172,
  intervalPaceLower: 240,
  intervalPaceUpper: 265
};

const TODAY = "2026-09-07";

/**
 * Capacity stands in for the stored weekly goal these tests used to pass.
 *
 * Both numbers are deliberately equal so every assertion below keeps its exact
 * value: the ceiling baseline and the observed volume the phase bands scale used
 * to be one field and are now two, and pinning them equal is what makes this
 * file a regression test for "the number changed hands, not the arithmetic".
 * `weekly-capacity.test.ts` is where the two are pulled apart on purpose.
 */
const capacityInputs = (km: number) => ({ weeklyVolumeBaselineKm: km, recentWeeklyKm: km });

const todayPayload = (overrides: Record<string, unknown> = {}): MobileTodayResponse =>
  ({
    generatedAt: "2026-09-07T01:00:00.000Z",
    timezone: "Asia/Shanghai",
    latestDataDate: "2026-09-06",
    lastSyncedAt: "2026-09-07T00:30:00.000Z",
    sync: { status: "ok", lastAttemptAt: "2026-09-07T00:20:00.000Z", lastSuccessAt: "2026-09-07T00:30:00.000Z", error: null },
    coverage: {
      latestTrainingDate: "2026-09-06",
      latestHealthSampleAt: "2026-09-07T00:20:00.000Z",
      sleep: { state: "current", latestDate: "2026-09-07" },
      hrv: { state: "current", latestDate: "2026-09-07" },
      restingHeartRate: { state: "current", latestDate: "2026-09-07" }
    },
    recoveryAssessment: {
      targetDate: "2026-09-07",
      coverage: "complete",
      assessment: "no_low_signal",
      reasonCodes: ["no_low_signal"],
      lastObservationDate: "2026-09-07"
    },
    recommendation: {
      basis: "training_load_and_plan",
      recoveryAdjustment: "none",
      uncertaintyReasons: [],
      reasonCodes: ["training_load_and_plan"]
    },
    freshness: { state: "valid", checkedAt: "2026-09-07T00:30:00.000Z", latestTrainingDate: "2026-09-06", recoveryDate: "2026-09-07" },
    recommendationRevision: "rev-1",
    today: { localDate: TODAY, distanceKm: 0, durationSeconds: 0, paceSecondsPerKm: null, energyKcal: null, workoutCount: 0 },
    week: { periodStart: "2026-09-07", periodEnd: "2026-09-13", distanceKm: 12, durationSeconds: 4200, workoutCount: 2 },
    weekDaily: [],
    recentWorkouts: [],
    ability: { trueAbility: 44, currentAbility: 43.5, changeFrom7DaysAgo: 0.2, growthVelocityPerWeek: 0.1, decayPoints: 0, snapshotDate: "2026-09-06", explanation: "" },
    calibration: { status: "completed", eligibleSessions: 20, eligibleDurationMinutes: 600, spanDays: 60, highCoverageSessions: 12, requirements: {} as never, message: "" },
    verdict: { tone: "green", title: "可以训练", reason: "恢复充分", triggers: [], stale: false },
    nextSession: { kind: "easy", title: "轻松跑", reason: "闸门放行", distanceKm: 8, durationMinutes: 50, paceSecondsPerKmLower: 330, paceSecondsPerKmUpper: 390, heartRateBpmLower: 130, heartRateBpmUpper: 150, structure: null },
    recovery: { score: 80, lastNightSleepMinutes: 430, sleepBaselineMinutes: 430, morningHrvMs: 52, hrvBaselineMs: 52, restingHeartRateBpm: 52, restingHeartRateBaselineBpm: 53, note: "" },
    postRun: null,
    weekStructure: { easyDurationFraction: 0.8, easyDurationFloorFraction: 0.7, qualitySessionCount: 0, qualitySessionCap: 2, easyHonesty: { intendedEasyCount: 3, easyEnoughCount: 3, honestyFraction: 1, note: "" }, remainingDistanceKm: 28 },
    race: { target: null, daysUntil: null, taper: false, shapeScore: null, volumeFraction: null, longRunFraction: null, note: "" },
    injuryFlags: [],
    weekPlan: [],
    phase: "morning_open",
    lock: { present: false, relockSuggested: false, lockedAt: null },
    ...overrides
  }) as unknown as MobileTodayResponse;

const validateArgs = (raw: string, overrides: Partial<Parameters<typeof validateWeeklyPlan>[0]> = {}) => ({
  raw,
  allowedDates: weeklyPlanDates(TODAY),
  prescription: PRESCRIPTION,
  weeklyDistanceKm: 40,
  qualitySessionCap: 2,
  easyDurationFloorFraction: 0.7,
  injuryFlagCodes: [] as string[],
  previousWeekDistanceKm: null,
  ...overrides
});

test("phase ceiling constrains coach structures and survives read-time validation", async () => {
  const args = {
    today: todayPayload({
      today: { localDate: "2026-10-05", workoutCount: 0 },
      week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 0 }
    }),
    goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2,
      raceTarget: { date: "2026-10-24", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 } },
    ...capacityInputs(40),
    prescription: PRESCRIPTION,
    previousWeekDistanceKm: 40
  };
  const result = await generateWeeklyPlan(args);
  assert.equal(result.audit.generatedBy, "heuristic");
  const executableKm = result.days.reduce((sum, day) => sum + (day.structure ? measureStructure(day.structure, day.kind, pacesFromZones(PRESCRIPTION)).distanceKm : 0), 0);
  assert.ok(executableKm <= 30 + 1e-6, `structure total ${executableKm}`);
  for (const day of result.days) if (day.structure) {
    assert.equal(day.distanceKm, roundKm(measureStructure(day.structure, day.kind, pacesFromZones(PRESCRIPTION)).distanceKm));
  }
  assert.deepEqual(constrainUpcomingPlan(result.days, args), result.days);
});

test("base phase caps quality sessions while a rolling window applies next week's own budget", async () => {
  const args = {
    today: todayPayload({ today: { localDate: "2026-10-05", workoutCount: 0 },
      week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 0 } }),
    goals: { easyDurationFloorFraction: 0.5, qualitySessionCap: 2,
      raceTarget: { date: "2027-01-10", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 } },
    ...capacityInputs(80),
    prescription: PRESCRIPTION
  };
  const base = await generateWeeklyPlan(args);
  assert.ok(base.days.filter(day => ["tempo", "interval", "race"].includes(day.kind)).length <= 1);
  const noRace = await generateWeeklyPlan({ ...args, goals: { ...args.goals, raceTarget: null } });
  assert.equal(noRace.days.filter(day => ["tempo", "interval", "race"].includes(day.kind)).length, 2);

  const today = todayPayload({ today: { localDate: "2026-10-09", workoutCount: 0 },
    week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 12 } });
  const rollingArgs = { ...args, today, ...capacityInputs(40), goals: { ...args.goals,
    raceTarget: { date: "2026-10-18", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 } } };
  const days = weeklyPlanDates("2026-10-09").map(localDate => ({ localDate, kind: "easy" as const, distanceKm: 12, structure: null, reason: null }));
  const constrained = constrainUpcomingPlan(days, rollingArgs);
  assert.ok(constrained.filter(day => day.localDate <= "2026-10-11").reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 18);
  assert.ok(constrained.filter(day => day.localDate > "2026-10-11").reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 24);
});

test("phase long-run limits bind executable single sessions below the weekly ceiling", () => {
  const raceTarget = { date: "2026-10-24", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 };
  const today = todayPayload({ today: { localDate: "2026-10-05", workoutCount: 0 },
    week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 0 },
    periodization: buildPeriodization({ today: "2026-10-05", raceTarget, recentWeeklyKm: 40 }) });
  // Isolate the single-session cap; long-run-only easy-floor repair is tested separately.
  const goals = { qualitySessionCap: 2, easyDurationFloorFraction: 0, raceTarget };
  const proposed: MobilePlannedDay[] = [{ localDate: "2026-10-05", kind: "long_run", distanceKm: 29, structure: null, reason: null }];
  const cap = today.periodization!.current!.longRunCapKm;
  assert.equal(cap, 9);
  assert.ok(29 < today.periodization!.current!.volumeBandKm.upper);
  const warnings: string[] = [];
  const result = constrainUpcomingPlan(proposed, { today, goals, ...capacityInputs(40), prescription: PRESCRIPTION }, warnings);
  const run = result.find(day => day.kind === "long_run")!;
  assert.ok(run.distanceKm! <= cap);
  assert.ok(measureStructure(run.structure!, run.kind, pacesFromZones(PRESCRIPTION)).distanceKm <= cap);
  assert.ok(warnings.some(message => message.includes("长距离超过阶段上限")));
  assert.deepEqual(constrainUpcomingPlan(result, { today, goals, ...capacityInputs(40), prescription: PRESCRIPTION }), result);
  assert.throws(() => validateManualPlan({ goals: { ...goals, weekPlan: proposed } as MobileGoalsResponse,
    today, prescription: PRESCRIPTION, previousWeekDistanceKm: 40, ...capacityInputs(40) }), ManualPlanPolicyError);
  const noTarget = constrainUpcomingPlan(proposed, { today, goals: { ...goals, raceTarget: null }, ...capacityInputs(40), prescription: PRESCRIPTION });
  assert.ok(noTarget[0]!.distanceKm! > cap, "a stale skeleton must not limit a removed target");
  const tiny = validateWeeklyPlan(validateArgs(JSON.stringify({ days: proposed }), {
    allowedDates: ["2026-10-05"], longRunCapKm: 0.1
  }));
  assert.equal(tiny.days[0]?.kind, "rest", "an irreducible session cannot exceed a tiny cap");
});

test("phase budgets reserve locked sessions and completed volume without rewriting today", () => {
  const goals = { easyDurationFloorFraction: 0.5, qualitySessionCap: 2,
    raceTarget: { date: "2027-01-10", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 } };
  const proposed = weeklyPlanDates("2026-10-05").map(localDate => ({ localDate, kind: "tempo" as const, distanceKm: 8, structure: null, reason: null }));
  const locked = todayPayload({ today: { localDate: "2026-10-05", workoutCount: 0 },
    week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 10 },
    lock: { present: true }, nextSession: { kind: "tempo", distanceKm: 8 } });
  const result = constrainUpcomingPlan(proposed, { today: locked, goals, ...capacityInputs(40), prescription: PRESCRIPTION });
  assert.ok(result.every(day => day.localDate !== "2026-10-05"));
  assert.ok(result.every(day => !["tempo", "interval", "race"].includes(day.kind)));
  assert.ok(result.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 22);
  const completed = todayPayload({ ...locked, today: { localDate: "2026-10-05", workoutCount: 1 },
    week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 39.9 },
    weekStructure: { qualitySessionCount: 1 } });
  const remaining = constrainUpcomingPlan(proposed, { today: completed, goals, ...capacityInputs(40), prescription: PRESCRIPTION });
  assert.ok(remaining.every(day => day.kind === "rest"), "a budget below one session must not retain an oversized minimum run");
});

test("generation and reads use the displayed phase band based on actual recent volume", async () => {
  const raceTarget = { date: "2026-10-24", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 };
  const args = {
    today: todayPayload({ today: { localDate: "2026-10-05", workoutCount: 0 },
      week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 0 },
      periodization: buildPeriodization({ today: "2026-10-05", raceTarget, recentWeeklyKm: 20 }) }),
    goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget },
    ...capacityInputs(40),
    prescription: PRESCRIPTION
  };
  const generated = await generateWeeklyPlan(args);
  assert.equal(args.today.periodization!.current!.volumeBandKm.upper, 15);
  assert.ok(generated.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 15);
  assert.deepEqual(constrainUpcomingPlan(generated.days, args), generated.days);
  const withoutRace = await generateWeeklyPlan({ ...args, goals: { ...args.goals, raceTarget: null } });
  assert.ok(withoutRace.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) > 15, "stale skeletons must not constrain a removed target");
});

test("phase volume shrinking preserves the final easy-time floor and is idempotent", async () => {
  const localDate = "2026-10-05";
  const raceTarget = { date: "2026-12-13", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 };
  const proposed = weeklyPlanDates(localDate).map((date, index) => ({
    localDate: date,
    kind: index === 0 ? "easy" : index === 1 ? "tempo" : "rest",
    distanceKm: index === 0 ? 30 : index === 1 ? 8 : null,
    structure: null
  }));
  const args = {
    today: todayPayload({ today: { localDate, workoutCount: 0 },
      week: { periodStart: localDate, periodEnd: "2026-10-11", distanceKm: 0 },
      periodization: buildPeriodization({ today: localDate, raceTarget, recentWeeklyKm: 20 }) }),
    goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget },
    ...capacityInputs(40),
    prescription: PRESCRIPTION
  };
  const result = { days: constrainUpcomingPlan(proposed as MobilePlannedDay[], args) };
  const ceiling = args.today.periodization!.current!.volumeBandKm.upper;
  const measured = result.days.map(day => ({ day,
    size: day.structure ? measureStructure(day.structure, day.kind, pacesFromZones(PRESCRIPTION)) :
      { distanceKm: 0, durationSeconds: 0 } }));
  const totalSeconds = measured.reduce((sum, { size }) => sum + size.durationSeconds, 0);
  const easySeconds = measured.reduce((sum, { day, size }) => sum +
    (["easy", "recovery"].includes(day.kind) ? size.durationSeconds : 0), 0);
  assert.ok(totalSeconds > 0);
  assert.ok(easySeconds / totalSeconds >= args.goals.easyDurationFloorFraction,
    `final easy-time fraction ${easySeconds / totalSeconds}`);
  assert.ok(measured.reduce((sum, { size }) => sum + size.distanceKm, 0) <= ceiling + 1e-6);
  assert.ok(result.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= ceiling + 1e-6);
  assert.deepEqual(constrainUpcomingPlan(result.days, args), result.days);
});

test("final easy-time repair never enlarges a tiny hard-budget session", () => {
  const days = [
    { localDate: TODAY, kind: "easy", distanceKm: 30, structure: null },
    { localDate: "2026-09-08", kind: "tempo", distanceKm: 0.1, structure: {
      warmup: null, cooldown: null,
      blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 100 }, alert: null }] }]
    } }
  ];
  const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days }), { volumeCeilingKm: 0.1 }));
  assert.ok(result.days.every(day => day.kind === "rest"), "an unaffordable easy replacement must become rest");
  assert.ok(result.clamped.some(message => message.includes("轻松时段占比低于下限")));
});

test("final easy-time repair respects both volume readings across quality-dose boundaries", () => {
  for (const prescription of [null, PRESCRIPTION]) for (const kind of ["tempo", "interval"] as const) {
    for (const volumeCeilingKm of [0.1, 2, 5.3, 7.9, 12, 20, 30]) {
      const days = [
        { localDate: TODAY, kind: "easy", distanceKm: 30, structure: null },
        { localDate: "2026-09-08", kind, distanceKm: 8,
          structure: buildSessionStructure(kind, prescription, { reps: 2 }) }
      ];
      const args = validateArgs(JSON.stringify({ days }), { prescription, volumeCeilingKm });
      const result = validateWeeklyPlan(args);
      let easySeconds = 0, totalSeconds = 0, measuredKm = 0;
      for (const day of result.days) {
        if (!day.structure) continue;
        const measured = measureStructure(day.structure, day.kind, pacesFromZones(prescription));
        measuredKm += measured.distanceKm;
        totalSeconds += measured.durationSeconds;
        if (["easy", "recovery"].includes(day.kind)) easySeconds += measured.durationSeconds;
      }
      const context = `${kind}, budget ${volumeCeilingKm}, zones ${prescription !== null}`;
      assert.ok(totalSeconds === 0 || easySeconds / totalSeconds >= args.easyDurationFloorFraction, context);
      assert.ok(measuredKm <= volumeCeilingKm + 1e-6, context);
      assert.ok(result.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= volumeCeilingKm + 1e-6, context);
      assert.deepEqual(validateWeeklyPlan({ ...args, raw: JSON.stringify({ days: result.days }) }).days, result.days, context);
    }
  }
});

test("rolling generation reserves retained next-week distance and quality sessions", async () => {
  const today = todayPayload({ today: { localDate: "2026-10-08", workoutCount: 0 },
    week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 0 } });
  const weekPlan = weeklyPlanDates("2026-10-15", 4).map((localDate, index) => ({
    localDate, kind: index < 2 ? "tempo" as const : "easy" as const, distanceKm: 8, structure: null, reason: "retain"
  }));
  const goals = { qualitySessionCap: 2, easyDurationFloorFraction: 0,
    raceTarget: null, weekPlan };
  const proposed = weeklyPlanDates("2026-10-08").map(localDate => ({ localDate,
    kind: localDate <= "2026-10-11" ? "rest" as const : "tempo" as const,
    distanceKm: localDate <= "2026-10-11" ? null : 10, structure: null, reason: null }));
  const warnings: string[] = [];
  const result = constrainUpcomingPlan(proposed, { today, goals, ...capacityInputs(40), prescription: PRESCRIPTION }, warnings);
  const merged = mergePlanWindow(weekPlan, result, "2026-10-08");
  const nextWeek = merged.filter(day => day.localDate >= "2026-10-12");
  assert.ok(nextWeek.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 40);
  assert.equal(nextWeek.filter(day => ["tempo", "interval", "race"].includes(day.kind)).length, 2);
  assert.deepEqual(merged.filter(day => day.localDate >= "2026-10-15"), weekPlan);
  assert.ok(warnings.some(message => message.includes("窗口外保留")));
  const generated = await generateWeeklyPlan({ today, goals, ...capacityInputs(40), prescription: PRESCRIPTION });
  assert.ok(mergePlanWindow(weekPlan, generated.days, "2026-10-08")
    .filter(day => day.localDate >= "2026-10-12").reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 40);
  const root = mkdtempSync(join(tmpdir(), "rai-retained-budget-"));
  const store = new MobileGoalsStore(root);
  try {
    const saved = store.write({ ...goals, weekPlan: mergePlanWindow(weekPlan, result, "2026-10-08") },
      { prescription: PRESCRIPTION });
    assert.ok(saved.weekPlan.filter(day => day.localDate >= "2026-10-12")
      .reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 40, "persistence must not reintroduce excess volume");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("retained budgets measure executable structure instead of stale distance hints", () => {
  const today = todayPayload({ today: { localDate: "2026-10-08", workoutCount: 0 },
    week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 0 } });
  const retained: MobilePlannedDay = { localDate: "2026-10-15", kind: "easy", distanceKm: 1,
    structure: buildSessionStructure("easy", PRESCRIPTION, { targetDistanceKm: 38 }), reason: null };
  const measured = measureStructure(retained.structure!, retained.kind, pacesFromZones(PRESCRIPTION)).distanceKm;
  const proposed = weeklyPlanDates("2026-10-08").map(localDate => ({ localDate,
    kind: "easy" as const, distanceKm: 10, structure: null, reason: null }));
  const result = constrainUpcomingPlan(proposed, { today, prescription: PRESCRIPTION, ...capacityInputs(40),
    goals: { qualitySessionCap: 2, easyDurationFloorFraction: 0.7,
      raceTarget: null, weekPlan: [retained] } });
  assert.ok(result.filter(day => day.localDate > "2026-10-11")
    .reduce((sum, day) => sum + (day.distanceKm ?? 0), measured) <= 40);
});

const dayJson = (localDate: string, kind: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    days: [
      {
        localDate,
        kind,
        distanceKm: 8,
        reason: "测试",
        structure: {
          warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: null },
          blocks: [
            {
              iterations: 1,
              steps: [
                { purpose: "work", goal: { type: "distance", meters: 6300 }, alert: { kind: "pace", lower: 330, upper: 390 } }
              ]
            }
          ],
          cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: null }
        },
        ...extra
      }
    ]
  });

test("plan json parsing tolerates code fences and surrounding prose", () => {
  assert.deepEqual(parsePlanJson('{"days":[]}'), { days: [] });
  assert.deepEqual(parsePlanJson('```json\n{"days":[]}\n```'), { days: [] });
  assert.deepEqual(parsePlanJson('这是计划：\n{"days":[]}\n以上。'), { days: [] });
  assert.equal(parsePlanJson("完全不是 JSON"), null);
});

test("dates outside the allowed window are rejected", () => {
  const raw = JSON.stringify({
    days: [
      JSON.parse(dayJson(TODAY, "easy")).days[0],
      JSON.parse(dayJson("2026-08-01", "easy")).days[0],
      JSON.parse(dayJson("2026-12-31", "easy")).days[0]
    ]
  });
  const result = validateWeeklyPlan(validateArgs(raw));
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0]?.localDate, TODAY);
  assert.equal(result.rejected.length, 2);
});

test("quality sessions beyond the cap are demoted to easy", () => {
  const days = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"].map((date) =>
    JSON.parse(dayJson(date, date === "2026-09-11" ? "interval" : "tempo")).days[0]
  );
  // The easy-time floor is disabled here so this test measures the cap alone.
  // The floor has its own dedicated coverage below.
  const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days }), { easyDurationFloorFraction: 0 }));
  const quality = result.days.filter((day) => day.kind === "tempo" || day.kind === "interval");
  assert.equal(quality.length, 2);
  assert.ok(result.clamped.some((entry) => entry.includes("质量课数量超过上限")));
});

test("the easy-time floor demotes the last quality session when intensity dominates", () => {
  // Four easy days and three quality sessions of comparable duration leave easy
  // time at ~58% of the week, below the 0.7 floor, so exactly one quality
  // session must fall back to easy running.
  const quality = ["2026-09-08", "2026-09-09", "2026-09-11"].map((date) => JSON.parse(dayJson(date, "tempo")).days[0]);
  const easy = ["2026-09-07", "2026-09-10", "2026-09-12", "2026-09-13"].map((date) =>
    JSON.parse(dayJson(date, "easy")).days[0]
  );
  const days = [...easy, ...quality].sort((left, right) => String(left.localDate).localeCompare(String(right.localDate)));
  const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days }), { qualitySessionCap: 3, weeklyDistanceKm: 60 }));
  assert.equal(result.days.filter((day) => day.kind === "tempo" || day.kind === "interval").length, 2);
  assert.equal(result.days.find((day) => day.localDate === "2026-09-11")?.kind, "easy");
  assert.ok(result.clamped.some((entry) => entry.includes("轻松时段占比低于下限")));
});

test("load and injury flags suppress every quality session", () => {
  const days = ["2026-09-08", "2026-09-09"].map((date) => JSON.parse(dayJson(date, "interval")).days[0]);
  const result = validateWeeklyPlan(
    validateArgs(JSON.stringify({ days }), { injuryFlagCodes: ["volume_ramp"] })
  );
  assert.equal(result.days.every((day) => day.kind === "easy"), true);
  assert.ok(result.clamped.some((entry) => entry.includes("已取消")));
});

test("pace targets faster than the allowed band are pulled back and reps are capped", () => {
  const aggressive = JSON.stringify({
    days: [
      {
        localDate: "2026-09-08",
        kind: "interval",
        distanceKm: 12,
        reason: "过激",
        structure: {
          warmup: { purpose: "warmup", goal: { type: "time", seconds: 600 }, alert: null },
          blocks: [
            {
              iterations: 14,
              steps: [
                { purpose: "work", goal: { type: "distance", meters: 800 }, alert: { kind: "pace", lower: 180, upper: 200 } },
                { purpose: "recovery", goal: { type: "time", seconds: 120 }, alert: null }
              ]
            }
          ],
          cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 600 }, alert: null }
        }
      }
    ]
  });
  const result = validateWeeklyPlan(validateArgs(aggressive, { easyDurationFloorFraction: 0 }));
  const day = result.days[0];
  assert.ok(day?.structure);
  assert.equal(day?.structure?.blocks[0]?.iterations, 8);
  const workStep = day?.structure?.blocks[0]?.steps[0];
  assert.ok((workStep?.alert?.lower ?? 0) >= 240, "配速下限应被收回到间歇区间");
  assert.ok(result.clamped.some((entry) => entry.includes("组数")));
  assert.ok(result.clamped.some((entry) => entry.includes("配速目标")));
});

for (const kind of ["easy", "recovery", "long_run", "tempo", "interval"] as const) {
  test(`${kind} heart-rate targets obey the session and step intensity limits`, () => {
    const structure = buildSessionStructure(kind, PRESCRIPTION, { targetDistanceKm: 5, reps: 2 })!;
    for (const step of [structure.warmup, ...structure.blocks.flatMap(block => block.steps), structure.cooldown]) {
      if (step) step.alert = { kind: "heart_rate", lower: 200, upper: 210 };
    }
    const day = { localDate: "2026-09-08", kind, distanceKm: 5, structure };
    const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days: [day] }), { easyDurationFloorFraction: 0 }));
    assert.deepEqual(result.rejected, []);
    assert.ok(result.clamped.some(message => message.includes("心率目标")));
    const safe = result.days[0]!.structure!;
    for (const step of [safe.warmup, ...safe.blocks.flatMap(block => block.steps), safe.cooldown]) {
      if (!step?.alert) continue;
      if (step.purpose === "work" && kind === "interval") {
        assert.deepEqual(step.alert, { kind: "pace", lower: 240, upper: 265 });
      } else {
        const ceiling = step.purpose === "work" && kind === "tempo" ? 172 : 150;
        assert.equal(step.alert.kind, "heart_rate");
        assert.equal(step.alert.lower, ceiling);
        assert.equal(step.alert.upper, ceiling);
      }
    }
  });
}

test("unknown heart-rate ceilings cannot authorize an unbounded target", () => {
  const structure: MobileSessionStructure = { warmup: null, cooldown: null, blocks: [{ iterations: 1, steps: [
    { purpose: "work", goal: { type: "distance", meters: 5000 }, alert: { kind: "heart_rate", lower: 200, upper: null } }
  ] }] };
  const day = { localDate: "2026-09-08", kind: "easy", distanceKm: 5, structure };
  for (const prescription of [null, { ...PRESCRIPTION, easyHrLower: null, easyHrUpper: null }]) {
    const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days: [day] }), { prescription }));
    assert.notEqual(result.days[0]!.structure!.blocks[0]!.steps[0]!.alert?.kind, "heart_rate");
    assert.ok(result.clamped.some(message => message.includes("心率目标")));
  }
  structure.blocks[0]!.steps[0]!.alert = { kind: "heart_rate", lower: 100, upper: null };
  const bounded = validateWeeklyPlan(validateArgs(JSON.stringify({ days: [day] })));
  assert.deepEqual(bounded.days[0]!.structure!.blocks[0]!.steps[0]!.alert, { kind: "heart_rate", lower: 100, upper: 150 });
});

test("manual easy plans cannot bypass injury guards with high heart-rate alerts", () => {
  const day: MobilePlannedDay = { localDate: "2026-09-08", kind: "easy", distanceKm: 5, reason: null,
    structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1, steps: [
      { purpose: "work", goal: { type: "distance", meters: 5000 }, alert: { kind: "heart_rate", lower: 200, upper: 210 } }
    ] }] } };
  const goals = { revision: 0, qualitySessionCap: 0, easyDurationFloorFraction: 0.8,
    raceTarget: null, weekPlan: [day] } as MobileGoalsResponse;
  assert.throws(() => validateManualPlan({ goals, today: todayPayload({ week: { periodStart: TODAY, distanceKm: 0 },
    injuryFlags: [{ code: "quality_cluster" }] }), prescription: PRESCRIPTION, previousWeekDistanceKm: 40, ...capacityInputs(40) }), ManualPlanPolicyError);
});

test("unknown pace bounds remove alerts on every step and reject the corresponding manual plans", () => {
  for (const prescription of [null, { ...PRESCRIPTION, easyPaceLower: null }]) {
    for (const target of ["warmup", "work", "recovery", "cooldown"] as const) {
      const alert = { kind: "pace" as const, lower: 150, upper: 160 };
      const structure: MobileSessionStructure = {
        warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: target === "warmup" ? alert : null },
        blocks: [{ iterations: 1, steps: [
          { purpose: "work", goal: { type: "distance", meters: 5000 }, alert: target === "work" ? alert : null },
          { purpose: "recovery", goal: { type: "time", seconds: 60 }, alert: target === "recovery" ? alert : null }
        ] }],
        cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: target === "cooldown" ? alert : null }
      };
      const day: MobilePlannedDay = { localDate: "2026-09-08", kind: "easy", distanceKm: 7, reason: null, structure };
      const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days: [day] }), {
        prescription, qualitySessionCap: 0, injuryFlagCodes: ["load_ratio"]
      }));
      const safe = result.days[0]!.structure!;
      assert.ok([safe.warmup, ...safe.blocks.flatMap(block => block.steps), safe.cooldown]
        .every(step => step?.alert == null), `${target} must not retain an ungrounded pace target`);
      assert.ok(result.clamped.some(message => message.includes("无可靠配速区间时移除目标")));
      const goals = { revision: 0, qualitySessionCap: 0, easyDurationFloorFraction: 0.8,
        raceTarget: null, weekPlan: [day] } as MobileGoalsResponse;
      assert.throws(() => validateManualPlan({ goals, today: todayPayload({ week: { periodStart: TODAY, distanceKm: 0 },
        injuryFlags: [{ code: "load_ratio" }] }), prescription, previousWeekDistanceKm: 40, ...capacityInputs(40) }), ManualPlanPolicyError);
    }
  }
});

test("long-run-only plans cannot abandon the easy-duration floor after all quality sessions are gone", () => {
  for (const prescription of [null, PRESCRIPTION]) {
    const dates = weeklyPlanDates(TODAY);
    for (const count of [1, 7]) {
      const days: MobilePlannedDay[] = dates.slice(0, count).map(localDate => ({
        localDate, kind: "long_run", distanceKm: 4, reason: null, structure: null
      }));
      const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days }), {
        prescription, qualitySessionCap: 0, easyDurationFloorFraction: 1
      }));
      assert.deepEqual(result.rejected, []);
      assert.ok(result.days.every(day => day.kind === "easy" || day.kind === "rest"));
      assert.equal(result.clamped.filter(message => message.includes("长距离课")).length, count);
      for (const day of result.days) if (day.structure) {
        const measured = measureStructure(day.structure, day.kind, pacesFromZones(prescription));
        assert.ok(measured.distanceKm <= 4 + 1e-6, "repair must not expand a long run");
        assert.equal(day.distanceKm, roundKm(measured.distanceKm));
      }
      const goals = { revision: 0, qualitySessionCap: 0, easyDurationFloorFraction: 1,
        raceTarget: null, weekPlan: days } as MobileGoalsResponse;
      assert.throws(() => validateManualPlan({ goals,
        today: todayPayload({ week: { periodStart: TODAY, distanceKm: 0 } }), prescription, previousWeekDistanceKm: 40, ...capacityInputs(40) }), ManualPlanPolicyError);
      const repeated = validateWeeklyPlan(validateArgs(JSON.stringify({ days: result.days }), {
        prescription, qualitySessionCap: 0, easyDurationFloorFraction: 1
      }));
      assert.deepEqual(repeated.clamped, [], "a repaired plan remains stable when exported again");
      assert.deepEqual(repeated.days, result.days);
    }
  }
});

test("easy/long-run mixtures retain long runs only when the measured easy floor is met", () => {
  const days = [
    { localDate: "2026-09-08", kind: "easy", distanceKm: 10 },
    { localDate: "2026-09-09", kind: "long_run", distanceKm: 5 }
  ];
  const permissive = validateWeeklyPlan(validateArgs(JSON.stringify({ days }), { easyDurationFloorFraction: 0.5 }));
  assert.equal(permissive.days[1]!.kind, "long_run");
  assert.deepEqual(permissive.clamped, []);
  const restrictive = validateWeeklyPlan(validateArgs(JSON.stringify({ days }), { easyDurationFloorFraction: 0.8 }));
  assert.equal(restrictive.days[1]!.kind, "easy");
  assert.ok(restrictive.clamped.some(message => message.includes("长距离课")));
});

test("interval repetition ceiling counts all blocks and every work step", () => {
  const original = buildSessionStructure("interval", PRESCRIPTION, { reps: 8 })!;
  const variants = [
    { ...original, blocks: [original.blocks[0]!, original.blocks[0]!] },
    { ...original, blocks: [{ ...original.blocks[0]!, steps: [...original.blocks[0]!.steps, ...original.blocks[0]!.steps] }] },
    { ...original, blocks: [{ iterations: 1, steps: Array.from({ length: 12 }, () => original.blocks[0]!.steps[0]!) }] }
  ];
  for (const structure of variants) {
    const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days: [{ localDate: "2026-09-08", kind: "interval", structure }] }),
      { weeklyDistanceKm: 80, volumeCeilingKm: 80, easyDurationFloorFraction: 0 }));
    const safe = result.days[0]!.structure!;
    assert.ok(structureWorkRepetitions(safe) <= 8);
    assert.ok(measureStructure(safe, "interval", pacesFromZones(PRESCRIPTION)).distanceKm <=
      measureStructure(structure, "interval", pacesFromZones(PRESCRIPTION)).distanceKm);
    assert.ok(result.clamped.some(message => message.includes("组数")));
    assert.deepEqual(validateWeeklyPlan(validateArgs(JSON.stringify({ days: result.days }),
      { weeklyDistanceKm: 80, volumeCeilingKm: 80, easyDurationFloorFraction: 0 })).clamped, []);
  }
});

test("interval structures already below the aggregate ceiling stay intact", () => {
  const structure = buildSessionStructure("interval", PRESCRIPTION, { reps: 2 })!;
  structure.blocks.push({ iterations: 3, steps: structure.blocks[0]!.steps });
  const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days: [{ localDate: "2026-09-08", kind: "interval", structure }] }),
    { easyDurationFloorFraction: 0 }));
  assert.deepEqual(result.days[0]!.structure, structure);
  assert.deepEqual(result.clamped, []);
});

test("a plan above the weekly ceiling is scaled down", () => {
  const days = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"].map((date) =>
    JSON.parse(dayJson(date, "easy", { distanceKm: 20 })).days[0]
  );
  const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days }), { weeklyDistanceKm: 40 }));
  const total = result.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  assert.ok(total <= 40 * 1.05 + 1, `总跑量 ${total} 应被压到上限附近`);
  assert.ok(result.clamped.some((entry) => entry.includes("超过上限")));
});

test("a model-supplied structure over the single-day ceiling is rebuilt at the cap", () => {
  // 20 repetitions of a 10 km work step is ~201 km: every field bound in
  // `normalizeSessionStructure` holds (`MAX_BLOCK_ITERATIONS` = 20), so the shape
  // is legal while the total is not. `clampIntervalReps` only rewrites `interval`
  // days, so these repetitions survive to the clamp under test.
  //
  // The size is chosen to sit **between** the two ceilings: over the single-day
  // cap, under the weekly ceiling (`weeklyDistanceKm` at its schema maximum).
  // That is what isolates this clamp — a payload merely larger still gets scaled
  // by `fitWeekToCeiling`, which carries its own copy of the cap, and the day
  // clamp would never be the thing under test.
  const giant = JSON.stringify({
    days: [
      {
        localDate: "2026-09-08",
        kind: "long_run",
        distanceKm: 200,
        reason: "超大结构",
        structure: {
          warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: null },
          blocks: [
            {
              iterations: 20,
              steps: [
                {
                  purpose: "work",
                  goal: { type: "distance", meters: 10000 },
                  alert: { kind: "pace", lower: 330, upper: 390 }
                }
              ]
            }
          ],
          cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: null }
        }
      }
    ]
  });
  const result = validateWeeklyPlan(validateArgs(giant, { weeklyDistanceKm: 500 }));
  assert.equal(result.rejected.length, 0, `不应被拒绝：${result.rejected.join("；")}`);
  const day = result.days[0]!;
  assert.ok(
    (day.distanceKm ?? 0) <= MAX_PLANNED_DISTANCE_KM,
    `落库距离 ${day.distanceKm} 必须 ≤ ${MAX_PLANNED_DISTANCE_KM}：周闸门管不到这一档，只有单日闸门能拦`
  );
  assert.ok(day.structure, "超限日必须带重建后的结构，否则上表处方仍超限");
  assert.ok(
    measureStructure(day.structure, "long_run", pacesFromZones(PRESCRIPTION)).distanceKm <= MAX_PLANNED_DISTANCE_KM,
    "重建后的结构实测必须 ≤ 上限"
  );
});

test("the volume ceiling still holds when interval reps round the week back up", () => {
  // Six 12 km easy days plus an 8-rep interval day. A single proportional pass
  // shrinks the easy days but rounds the interval day back up to whole 800 m
  // reps, which used to leave the week ~15% above its own ceiling.
  const dates = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"];
  const days = dates.map((localDate, index) => ({
    localDate,
    kind: index === 2 ? "interval" : "easy",
    distanceKm: 12,
    reason: "超量",
    structure:
      index === 2
        ? {
            warmup: { purpose: "warmup", goal: { type: "time", seconds: 600 }, alert: null },
            blocks: [
              {
                iterations: 8,
                steps: [
                  { purpose: "work", goal: { type: "distance", meters: 800 }, alert: null },
                  { purpose: "recovery", goal: { type: "time", seconds: 120 }, alert: null }
                ]
              }
            ],
            cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 600 }, alert: null }
          }
        : {
            warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: null },
            blocks: [
              { iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 10500 }, alert: null }] }
            ],
            cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: null }
          }
  }));

  const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days }), { weeklyDistanceKm: 40 }));
  const ceiling = 40 * 1.05;
  const paces = pacesFromZones(PRESCRIPTION);
  const measured = result.days.reduce(
    (sum, day) => sum + (day.structure ? measureStructure(day.structure, day.kind, paces).distanceKm : 0),
    0
  );
  assert.ok(measured <= ceiling + 0.5, `周总跑量 ${measured.toFixed(1)}km 应被压到上限 ${ceiling}km 以内`);
  assert.ok(result.clamped.some((entry) => entry.includes("超过上限") && entry.includes("已缩减至")));
});

test("malformed structures are dropped and rebuilt from the session kind", () => {
  const raw = JSON.stringify({
    days: [
      { localDate: "2026-09-08", kind: "easy", distanceKm: 8, reason: "坏结构", structure: { warmup: null, blocks: [{ iterations: 0, steps: [] }], cooldown: null } }
    ]
  });
  const result = validateWeeklyPlan(validateArgs(raw));
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0]?.structure?.blocks[0]?.iterations, 1);
  assert.equal(result.days[0]?.structure?.blocks[0]?.steps[0]?.purpose, "work");
});

test("fallback plan covers the whole window and stays conservative", () => {
  const dates = weeklyPlanDates(TODAY);
  const days = buildCoachWeekPlan({
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 35,
    qualitySessionCap: 2,
    injuryFlagCodes: []
  });
  assert.deepEqual(days.map((day) => day.localDate), dates);
  assert.ok(days.filter((day) => day.kind === "interval" || day.kind === "tempo").length <= 2);
  const measured = days.map((day) => ({ day, seconds: day.structure
    ? measureStructure(day.structure, day.kind, pacesFromZones(PRESCRIPTION)).durationSeconds : 0 }));
  assert.ok(measured.filter(({ day }) => ["easy", "recovery"].includes(day.kind)).reduce((sum, row) => sum + row.seconds, 0)
    / measured.reduce((sum, row) => sum + row.seconds, 0) >= 0.7);
  assert.equal(days.every((day) => day.structure != null), true);

  const blocked = buildCoachWeekPlan({
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 35,
    qualitySessionCap: 2,
    injuryFlagCodes: ["quality_cluster"]
  });
  assert.equal(blocked.every((day) => day.kind === "easy"), true);
});

test("a week too small for quality work stays easy-only and inside the goal", () => {
  // Regression: the template used to size both quality structures from the
  // coach (~16 km for the pair) regardless of the goal, then floor every easy
  // day at MIN_EASY_DISTANCE_KM. At a small goal the quality work was
  // unpayable and no easy day ever reached the floor, so a 5 km goal produced
  // ~28.8 km — the default path for a deployment without an LLM key.
  for (const goal of [5, 8, 15]) {
    const days = buildCoachWeekPlan({
      allowedDates: weeklyPlanDates(TODAY),
      prescription: PRESCRIPTION,
      weeklyDistanceKm: goal,
      qualitySessionCap: 2,
      injuryFlagCodes: []
    });
    const total = days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
    assert.ok(total <= goal + 0.05, `goal ${goal}km produced ${total}km`);

    for (const day of days) {
      if (day.kind === "rest") {
        assert.equal(day.structure, null);
        continue;
      }
      assert.ok(day.structure != null, `${day.localDate} has no structure`);
      const measured = measureStructure(day.structure, day.kind, pacesFromZones(PRESCRIPTION));
      assert.ok(
        Math.abs((day.distanceKm ?? 0) - measured.distanceKm) <= 0.05,
        `${day.localDate} stored ${day.distanceKm} but measures ${measured.distanceKm}`
      );
    }
    // Unpaid days become rest rather than an over-budget easy run.
    assert.ok(days.some((day) => day.kind === "rest"), `goal ${goal}km left no rest day`);
  }
});

test("the fallback template is held to the ramp ceiling too", () => {
  const total = (previousWeekDistanceKm: number | null): number =>
    buildCoachWeekPlan({
      allowedDates: weeklyPlanDates(TODAY),
      prescription: PRESCRIPTION,
      weeklyDistanceKm: 40,
      qualitySessionCap: 2,
      injuryFlagCodes: [],
      previousWeekDistanceKm
    }).reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);

  const ceiling = Math.max(8, 40 * RAMP_BASE_FLOOR_FRACTION) * (1 + RAMP_LIMIT_FRACTION);
  assert.ok(total(8) <= ceiling + 0.05, `comeback week produced ${total(8)}km`);
  // No previous week means no ramp constraint. A `null` ceiling would coerce to
  // 0 under `Math.min` and collapse the whole week, so this guards the sentinel.
  assert.ok(total(0) > 30, `a zero previous week collapsed the plan to ${total(0)}km`);
  assert.ok(total(null) > 30, `a missing previous week collapsed the plan to ${total(null)}km`);
  // Last week already supported the goal: no tightening.
  assert.ok(total(38) >= 38, `an earned week was cut to ${total(38)}km`);
});

test("coach generation is deterministic, structured and has no fallback warning", async () => {
  const args = {
    today: todayPayload(),
    goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget: null },
    ...capacityInputs(35),
    prescription: PRESCRIPTION,
    now: new Date("2026-09-07T00:00:00Z")
  };
  const result = await generateWeeklyPlan(args);
  assert.deepEqual(await generateWeeklyPlan(args), result);
  assert.equal(result.audit.generatedBy, "heuristic");
  assert.equal(result.audit.model, null);
  assert.equal(result.audit.promptVersion, null);
  assert.equal(result.days.length, 7);
  assert.ok(result.days.filter(day => day.kind !== "rest").every(day => day.structure != null));
  assert.ok(result.warnings.every(entry => !/模型|回退|RAI_LLM/.test(entry)));
});

test("migration previews reserve today's unchanged prescription and quality budget", async () => {
  const args = {
    today: todayPayload({ nextSession: { kind: "interval", distanceKm: 10 },
      week: { periodStart: TODAY, periodEnd: "2026-09-13", distanceKm: 0 } }),
    goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2,
      raceTarget: null, weekPlanReplanRequired: true },
    ...capacityInputs(40),
    prescription: PRESCRIPTION
  };
  const result = await generateWeeklyPlan(args);
  assert.equal(result.days.length, 6);
  assert.ok(result.days.every(day => day.localDate > TODAY));
  assert.ok(result.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 30);
  assert.ok(result.days.filter(day => ["interval", "tempo"].includes(day.kind)).length <= 1);
});

test("confirmed migration days remain frozen for regeneration and manual edits", async () => {
  const protectedDay = { localDate: TODAY, kind: "easy" as const, distanceKm: 8, structure: null, reason: "旧处方" };
  const today = todayPayload({ nextSession: { kind: "easy", distanceKm: 8 },
    week: { periodStart: TODAY, periodEnd: "2026-09-13", distanceKm: 0 } });
  const goals = { revision: 2, easyDurationFloorFraction: 0.8, qualitySessionCap: 2,
    raceTarget: null, weekPlan: [protectedDay], lockedSession: null, weekPlanAudit: null,
    weekPlanReplanRequired: false, weekPlanPreservedDate: TODAY, updatedAt: "2026-09-07T01:00:00Z" };
  const args = { today, goals, ...capacityInputs(5), prescription: PRESCRIPTION };
  const result = await generateWeeklyPlan(args);
  assert.ok(result.days.every(day => day.localDate > TODAY));
  assert.ok(result.days.every(day => day.kind === "rest"), "the old day spends more than this week's new budget");
  const manualArgs = { ...args, previousWeekDistanceKm: 0, previous: goals };
  assert.doesNotThrow(() => validateManualPlan(manualArgs));
  assert.throws(() => validateManualPlan({ ...manualArgs, goals: { ...goals, weekPlan: [] } }), ManualPlanPolicyError);
  assert.throws(() => validateManualPlan({ ...manualArgs,
    goals: { ...goals, weekPlan: [{ ...protectedDay, distanceKm: 4 }] } }), ManualPlanPolicyError);
  const expired = await generateWeeklyPlan({ ...args, goals: { ...goals, weekPlanPreservedDate: "2026-09-06" } });
  assert.ok(expired.days.some(day => day.localDate === TODAY), "yesterday's protection cannot freeze today");
});

test("missing execution imports never increase the coach's prescribed volume", async () => {
  const args = { today: todayPayload(), goals: { easyDurationFloorFraction: 0.7,
    qualitySessionCap: 2, raceTarget: null }, ...capacityInputs(40), prescription: PRESCRIPTION,
    now: new Date("2026-09-07T00:00:00Z") };
  const expected = await generateWeeklyPlan(args);
  for (const status of ["pending", "unknown"]) {
    const result = await generateWeeklyPlan({ ...args, today: todayPayload({ recentPlanExecution: [{
      localDate: "2026-09-06", planRevision: 1, plannedKind: "easy", plannedDistanceKm: 8,
      observedDistanceKm: 0, observedWorkoutCount: 0, distanceRatio: null, status
    }] }) });
    assert.deepEqual(result, expected);
  }
});


test("regeneration reports the days whose stored prescription it replaces", () => {
  const structure: MobileSessionStructure = {
    warmup: null,
    cooldown: null,
    blocks: [
      {
        iterations: 6,
        steps: [{ purpose: "work", goal: { type: "distance", meters: 800 }, alert: null }]
      }
    ]
  };
  const previous: MobilePlannedDay[] = [
    { localDate: "2026-09-07", kind: "interval" as const, distanceKm: 8, structure, reason: "手调过的间歇" },
    // No structure and no rationale: the editor wrote this, so rebuilding it loses nothing.
    { localDate: "2026-09-08", kind: "easy" as const, distanceKm: 5, structure: null, reason: null }
  ];
  const rebuilt: MobilePlannedDay[] = [
    { localDate: "2026-09-07", kind: "easy" as const, distanceKm: 6, structure: null, reason: "新计划" },
    { localDate: "2026-09-08", kind: "easy" as const, distanceKm: 5, structure: null, reason: null },
    // Outside the new window, therefore never touched.
    { localDate: "2026-09-30", kind: "easy" as const, distanceKm: 5, structure: null, reason: null }
  ];

  assert.deepEqual(overwrittenPlanDates(previous, rebuilt), ["2026-09-07"]);
  const warning = overwriteWarning(previous, rebuilt);
  assert.ok(warning?.includes("已覆盖 1 天既有课表"));
  assert.ok(warning?.includes("2026-09-07"));

  // Identical content on both sides is not an overwrite and must stay silent.
  assert.deepEqual(overwrittenPlanDates([previous[0]!], [previous[0]!]), []);
  assert.equal(overwriteWarning([previous[0]!], [previous[0]!]), null);

  // An editor-written day being replaced is equally silent.
  assert.equal(overwriteWarning([previous[1]!], [rebuilt[1]!]), null);
});

test("a plan that scales down keeps interval reps on the coach's 800 m rep", () => {
  const oversized = JSON.stringify({
    days: [
      {
        localDate: "2026-09-09",
        kind: "interval",
        distanceKm: 20,
        structure: {
          warmup: { purpose: "warmup", goal: { type: "time", seconds: 600 }, alert: null },
          blocks: [
            {
              iterations: 8,
              steps: [
                {
                  purpose: "work",
                  goal: { type: "distance", meters: 800 },
                  alert: { kind: "pace", lower: 240, upper: 265 }
                },
                { purpose: "recovery", goal: { type: "time", seconds: 120 }, alert: null }
              ]
            }
          ],
          cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 600 }, alert: null }
        }
      }
    ]
  });

  // The easy-time floor is out of scope here, so it must not demote the day and
  // hide the scaling path this test is about.
  const result = validateWeeklyPlan(
    validateArgs(oversized, { weeklyDistanceKm: 2, easyDurationFloorFraction: 0 })
  );
  const day = result.days.find((entry) => entry.kind === "interval");
  assert.ok(day?.structure, "the interval day survives scaling");
  const work = day.structure.blocks
    .flatMap((block) => block.steps)
    .find((step) => step.purpose === "work");
  assert.equal(work?.goal.type, "distance");
  // Rep length is the shared constant, never a second hardcoded number.
  assert.equal(work?.goal.type === "distance" ? work.goal.meters : null, 800);
  // Scaling is enforced by shrinking the rep count, which proves it recomputes
  // against the same 800 m rep rather than a private copy of the constant.
  const reps = day.structure.blocks.reduce((total, block) => total + block.iterations, 0);
  assert.ok(reps < 8 && reps >= 2, `expected scaled reps inside 2..7, got ${reps}`);
  assert.ok(result.clamped.some((entry) => entry.includes("超过上限") && entry.includes("已缩减至")));
});


test("a model that misreports distance is overruled by the structure it sent", () => {
  // The model claims 1 km but hands over a 6.3 km work step. The stored value
  // must come from the structure: it is persisted, shown in the app, and summed
  // into the user-facing weekly total, while the watch runs the structure.
  const raw = JSON.stringify({
    days: [
      {
        localDate: TODAY,
        kind: "easy",
        distanceKm: 1,
        reason: "模型少报",
        structure: {
          warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: null },
          blocks: [
            { iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 6300 }, alert: null }] }
          ],
          cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: null }
        }
      }
    ]
  });

  const result = validateWeeklyPlan(validateArgs(raw));
  const day = result.days[0];
  assert.ok(day);
  const structure = day.structure;
  assert.ok(structure, "结构应当被保留");
  const measured = measureStructure(structure, day.kind, pacesFromZones(PRESCRIPTION));
  assert.ok(
    Math.abs((day.distanceKm ?? 0) - measured.distanceKm) <= 0.05,
    `存储 ${day.distanceKm}km 必须等于结构反推 ${measured.distanceKm.toFixed(2)}km`
  );
  assert.ok((day.distanceKm ?? 0) > 7, "存储距离取自结构，而不是模型的声明");
});

test("the ramp ceiling pulls a week back toward last week's volume", () => {
  const days = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"].map((date) =>
    JSON.parse(dayJson(date, "easy", { distanceKm: 20 })).days[0]
  );
  // Goal 40 km with a real 20 km last week. The 50% floor (20 km) sits exactly at
  // the real value, so the ceiling is 20 * 1.3 * 1.05 ≈ 27.3 km — far below the
  // goal, and only reachable because last week actually supported the ramp.
  const result = validateWeeklyPlan(
    validateArgs(JSON.stringify({ days }), { weeklyDistanceKm: 40, previousWeekDistanceKm: 20 })
  );
  const ceiling = 20 * (1 + RAMP_LIMIT_FRACTION) * VOLUME_CEILING_TOLERANCE;
  const total = result.days.reduce((sum, day) => {
    const structure = day.structure;
    if (!structure) return sum;
    return sum + measureStructure(structure, day.kind, pacesFromZones(PRESCRIPTION)).distanceKm;
  }, 0);
  assert.ok(total <= ceiling + 1, `总量 ${total.toFixed(1)}km 应被上周基准 ${ceiling.toFixed(1)}km 拦住`);
  assert.ok(result.clamped.some((entry) => entry.includes("超过上限")));
});

test("a comeback week is not capped by the injury week that preceded it", () => {
  const days = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"].map((date) =>
    JSON.parse(dayJson(date, "easy", { distanceKm: 20 })).days[0]
  );
  // 8 km last week (illness), 40 km goal this week. Without the floor the ramp
  // would hold the week at 8 * 1.3 * 1.05 ≈ 10.9 km — an app-ignores-its-own-
  // setting outcome. The floor lifts the base to 40 * 0.5 = 20 km.
  const result = validateWeeklyPlan(
    validateArgs(JSON.stringify({ days }), { weeklyDistanceKm: 40, previousWeekDistanceKm: 8 })
  );
  const withoutFloor = 8 * (1 + RAMP_LIMIT_FRACTION) * VOLUME_CEILING_TOLERANCE;
  const withFloor = 40 * RAMP_BASE_FLOOR_FRACTION * (1 + RAMP_LIMIT_FRACTION) * VOLUME_CEILING_TOLERANCE;
  const total = result.days.reduce((sum, day) => {
    const structure = day.structure;
    if (!structure) return sum;
    return sum + measureStructure(structure, day.kind, pacesFromZones(PRESCRIPTION)).distanceKm;
  }, 0);
  assert.ok(total <= withFloor + 1, `总量 ${total.toFixed(1)}km 应落在下限后的上限 ${withFloor.toFixed(1)}km 内`);
  assert.ok(
    total > withoutFloor + 1,
    `总量 ${total.toFixed(1)}km 必须高于无下限时的 ${withoutFloor.toFixed(1)}km，否则下限没有生效`
  );
});

test("the fallback plan measures every day and stays inside the weekly goal", () => {
  const dates = weeklyPlanDates(TODAY);
  const days = buildCoachWeekPlan({
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 50,
    qualitySessionCap: 2,
    injuryFlagCodes: []
  });
  assert.equal(days.length, dates.length);

  let total = 0;
  for (const day of days) {
    const structure = day.structure;
    assert.ok(structure, `${day.localDate} 应当带结构`);
    const measured = measureStructure(structure, day.kind, pacesFromZones(PRESCRIPTION));
    total += measured.distanceKm;
    assert.ok(
      Math.abs((day.distanceKm ?? 0) - measured.distanceKm) <= 0.1,
      `${day.localDate} 存储 ${day.distanceKm}km 与结构 ${measured.distanceKm.toFixed(2)}km 不符`
    );
  }
  assert.ok(total <= 50 * 1.02, `回退课表总量 ${total.toFixed(1)}km 应落在周目标 50km 内`);
});

test("the fallback template never exceeds its own ceiling", () => {
  // It used to overshoot by 0.1–0.2 km: the template sized days from targets
  // while the week is measured in structures, and `buildSessionStructure` rounds
  // its work step and floors it at the shortest meaningful session. It now
  // re-cuts against the measured week.
  const cases: Array<{ goal: number; prev: number | null }> = [
    { goal: 3, prev: null },
    { goal: 5, prev: null },
    { goal: 8, prev: null },
    { goal: 15, prev: null },
    { goal: 26, prev: 8 },
    { goal: 30, prev: null },
    { goal: 40, prev: 8 },
    { goal: 40, prev: 20 },
    { goal: 50, prev: null }
  ];
  for (const { goal, prev } of cases) {
    const days = buildCoachWeekPlan({
      allowedDates: weeklyPlanDates(TODAY),
      prescription: PRESCRIPTION,
      weeklyDistanceKm: goal,
      qualitySessionCap: 2,
      injuryFlagCodes: [],
      previousWeekDistanceKm: prev
    });
    const ceiling = weeklyPlanVolumeCeiling(goal, prev);
    const total = days.reduce(
      (sum, day) => sum + (day.structure ? measureStructure(day.structure, day.kind, pacesFromZones(PRESCRIPTION)).distanceKm : 0),
      0
    );
    assert.ok(
      total <= ceiling + 1e-6,
      `目标 ${goal}km / 上周 ${prev ?? "无"}：总量 ${total.toFixed(3)}km 超过上限 ${ceiling}km`
    );
  }
});

test("a budget too tight for two sessions is spent on one properly sized session", () => {
  // Two easy days at the structure's minimum already measure 5.08 km, so a 5 km
  // goal cannot pay for both. The week gets one real session instead of either
  // breaking the ceiling or leaving half the budget unspent.
  const days = buildCoachWeekPlan({
    allowedDates: weeklyPlanDates(TODAY),
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 5,
    qualitySessionCap: 2,
    injuryFlagCodes: []
  });
  const ceiling = weeklyPlanVolumeCeiling(5, null);
  const total = days.reduce(
    (sum, day) => sum + (day.structure ? measureStructure(day.structure, day.kind, pacesFromZones(PRESCRIPTION)).distanceKm : 0),
    0
  );
  assert.ok(total <= ceiling + 1e-6, `总量 ${total.toFixed(3)}km 不得超过上限 ${ceiling}km`);
  assert.ok(total >= ceiling * 0.9, `总量 ${total.toFixed(3)}km 应接近上限 ${ceiling}km，而不是只剩一堂短课`);
});

test("a goal smaller than one easy session plans rest rather than an over-budget run", () => {
  // Deliberate: the ceiling is the safety property. A 1 km week cannot pay for
  // the shortest structure the coach can express (~2.5 km), and fielding it
  // anyway is exactly the "template exceeds its own ceiling" defect.
  const days = buildCoachWeekPlan({
    allowedDates: weeklyPlanDates(TODAY),
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 1,
    qualitySessionCap: 2,
    injuryFlagCodes: []
  });
  assert.equal(days.every((day) => day.kind === "rest"), true);
  assert.equal(days.every((day) => day.distanceKm === null && day.structure === null), true);
});

test("a demoted quality session stores a rounded, re-measured distance", () => {
  // `demoteToEasy` used to persist the raw measurement, so a degraded day read
  // `7.838461538461538` while the day before it read a plain `7.8`.
  const dates = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
  const days = dates.map((date) => JSON.parse(dayJson(date, "tempo")).days[0]);
  const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days }), { qualitySessionCap: 2 }));
  const demoted = result.days.filter((day) => day.kind === "easy");
  assert.ok(demoted.length >= 1, "质量课超过上限时必须至少有 1 天降级为 easy");
  for (const day of demoted) {
    assert.ok(day.structure, `${day.localDate} 降级后应当带结构`);
    const measured = measureStructure(day.structure, day.kind, pacesFromZones(PRESCRIPTION)).distanceKm;
    const stored = day.distanceKm ?? 0;
    assert.equal(Math.round(stored * 10) / 10, stored, `${day.localDate} 存储 ${stored} 应当只有 1 位小数`);
    assert.ok(
      Math.abs(stored - measured) <= 0.05,
      `${day.localDate} 存储 ${stored} 与结构反推 ${measured.toFixed(3)} 不符`
    );
  }
});


test("no single day exceeds the per-day distance ceiling", () => {
  // The weekly goal is accepted up to 500 km, and `RAMP_BASE_FLOOR_FRACTION`
  // keeps a comeback week sized against half of it — so a short window can ask
  // the template for a day no runner has ever done. The cap is per day and the
  // stored number has to describe the rebuilt structure, not the request.
  const dates = weeklyPlanDates(TODAY).slice(0, 3);
  const days = buildCoachWeekPlan({
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 500,
    qualitySessionCap: 2,
    injuryFlagCodes: []
  });
  assert.equal(days.length, dates.length);
  for (const day of days) {
    const structure = day.structure;
    assert.ok(structure, `${day.localDate} 应当带结构`);
    const measured = measureStructure(structure, day.kind, pacesFromZones(PRESCRIPTION)).distanceKm;
    assert.ok(measured <= MAX_PLANNED_DISTANCE_KM + 1e-6, `${day.localDate} 结构测出 ${measured}km，超过单日上限`);
    assert.ok(
      (day.distanceKm ?? 0) <= MAX_PLANNED_DISTANCE_KM,
      `${day.localDate} 落库 ${day.distanceKm}km，超过单日上限`
    );
  }
});

test("a model structure larger than a day is rebuilt at the cap", () => {
  // `normalizeSessionStructure` bounds each step at 100 km and each block at 20
  // iterations, so a hallucinated plan can still measure hundreds of kilometres.
  // Capping the stored number alone would leave the structure saying something
  // else, so the day is rebuilt at the cap and measured again.
  const dates = weeklyPlanDates(TODAY);
  const huge = {
    warmup: { purpose: "warmup", goal: { type: "distance", meters: 10_000 }, alert: null },
    blocks: [
      { iterations: 4, steps: [{ purpose: "work", goal: { type: "distance", meters: 90_000 }, alert: null }] }
    ],
    cooldown: null
  };
  const result = validateWeeklyPlan({
    raw: JSON.stringify({ days: [{ localDate: dates[0], kind: "easy", distanceKm: 5, structure: huge }] }),
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 500,
    qualitySessionCap: 2,
    easyDurationFloorFraction: 0.7,
    injuryFlagCodes: []
  });
  const day = result.days[0];
  assert.ok(day?.structure);
  const measured = measureStructure(day.structure, "easy", pacesFromZones(PRESCRIPTION)).distanceKm;
  assert.ok(measured <= MAX_PLANNED_DISTANCE_KM + 1e-6, `结构仍测出 ${measured}km`);
  assert.equal(day.distanceKm, roundKm(measured), "落库距离必须等于重建后的结构");
});

test("a demoted quality session cannot land above the per-day ceiling", () => {
  // A day is capped where it is first built, but demotion rebuilds it from its
  // measured size — and a request of 79.99 km measures 80.0385 km once the easy
  // work step is rounded to 100 m. The cap therefore has to be re-applied after
  // everything that rebuilds a day, which is what the final pass does.
  const dates = weeklyPlanDates(TODAY);
  const quality = {
    warmup: { purpose: "warmup", goal: { type: "distance", meters: 2_000 }, alert: null },
    blocks: [
      { iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 77_990 }, alert: null }] }
    ],
    cooldown: null
  };
  const result = validateWeeklyPlan({
    raw: JSON.stringify({ days: [{ localDate: dates[0], kind: "tempo", distanceKm: 79.99, structure: quality }] }),
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 500,
    qualitySessionCap: 0,
    easyDurationFloorFraction: 0.7,
    injuryFlagCodes: []
  });
  const day = result.days[0];
  assert.ok(day?.structure);
  assert.equal(day.kind, "easy", "质量课超过上限 0 必须降级");
  const measured = measureStructure(day.structure, "easy", pacesFromZones(PRESCRIPTION)).distanceKm;
  assert.ok(measured <= MAX_PLANNED_DISTANCE_KM + 1e-6, `降级后实测 ${measured}km，超过单日上限`);
  assert.ok((day.distanceKm ?? 0) <= MAX_PLANNED_DISTANCE_KM, `降级后落库 ${day.distanceKm}km`);
});

test("a week the budget cannot pay for drops sessions instead of overshooting", () => {
  // A session has an irreducible size — warm-up, cool-down and a minimum work
  // step — so once the structures bottom out, scaling has nothing left to take
  // and the week would stay over the ceiling it is measured against. Seven days
  // of a 10 km goal used to be stored as 17.7 km, three times the ramp ceiling,
  // because nothing could shrink them. The ceiling decides how much of the plan
  // survives, so the days that cannot be paid for become rest.
  const dates = weeklyPlanDates(TODAY);
  const result = validateWeeklyPlan({
    raw: JSON.stringify({ days: dates.map((localDate) => ({ localDate, kind: "easy", distanceKm: 500 })) }),
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 10,
    qualitySessionCap: 2,
    easyDurationFloorFraction: 0.7,
    injuryFlagCodes: [],
    previousWeekDistanceKm: null
  });
  const ceiling = weeklyPlanVolumeCeiling(10, null) * VOLUME_CEILING_TOLERANCE;
  const storedTotal = result.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  assert.ok(storedTotal <= ceiling + 1e-6, `周总量 ${storedTotal}km 超过上限 ${ceiling}km`);
  const kept = result.days.filter((day) => day.kind !== "rest").length;
  assert.ok(kept > 0, "至少要保留一堂课");
  assert.ok(kept < dates.length, `预算不足时必须减少课次，实际仍保留 ${kept} 堂`);
  assert.ok(storedTotal > 0, "留下来的那堂课必须有距离");
});

test("a quality session the week cannot afford becomes an easy run", () => {
  // A tempo block is dosed by the coach's fixed reps rather than by distance, so
  // no amount of scaling makes it smaller — and at a small weekly goal the block
  // alone is larger than the entire allowed week. It cannot belong to that week,
  // so it is demoted to an easy run, which *is* dosed by distance. An interval
  // day is left alone here: it shrinks by its rep count, which is the behaviour
  // the reps test above locks down.
  const dates = weeklyPlanDates(TODAY);
  const result = validateWeeklyPlan({
    raw: JSON.stringify({ days: [{ localDate: dates[0], kind: "tempo", distanceKm: 8.8 }] }),
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 2,
    qualitySessionCap: 2,
    easyDurationFloorFraction: 0,
    injuryFlagCodes: []
  });
  assert.equal(result.days[0]?.kind, "easy", "预算付不起的质量课必须降为轻松跑");
  assert.ok(result.clamped.some((entry) => entry.includes("已降为轻松跑")));
  assert.ok(
    (result.days[0]?.distanceKm ?? 0) < 8.8,
    "降级后应当真的变小，而不是把固定的 tempo 结构原样留下"
  );
});

test("the ceiling never hands back a day longer than the one it started with", () => {
  // The scaling pass rebuilds days from a target, and `buildSessionStructure`
  // ignores that target for tempo — so re-cutting a small tempo day returns the
  // coach's fixed block, *larger* than the day being trimmed, while the audit
  // line would claim "已缩减". A pass that cannot reduce a day must leave it
  // alone; the week is trimmed by dropping sessions instead.
  const dates = weeklyPlanDates(TODAY);
  const fixedDose = measureStructure(
    buildSessionStructure("tempo", PRESCRIPTION, {})!,
    "tempo",
    pacesFromZones(PRESCRIPTION)
  ).distanceKm;
  const result = validateWeeklyPlan({
    raw: JSON.stringify({ days: dates.slice(0, 4).map((localDate) => ({ localDate, kind: "tempo" })) }),
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 20,
    qualitySessionCap: 4,
    easyDurationFloorFraction: 0,
    injuryFlagCodes: []
  });
  for (const day of result.days) {
    assert.ok(
      (day.distanceKm ?? 0) <= fixedDose + 1e-6,
      `${day.localDate} 落库 ${day.distanceKm}km，超过未缩放时的 ${fixedDose}km`
    );
  }
});

test("a model hint above the per-day cap is reported", () => {
  // The hint only sizes the structure, but the model's own prescription is still
  // rewritten: a 500 km request stored as an 80 km day with an empty audit trail
  // would look like the model's idea on the audit screen.
  const dates = weeklyPlanDates(TODAY).slice(0, 1);
  const result = validateWeeklyPlan({
    raw: JSON.stringify({ days: [{ localDate: dates[0], kind: "easy", distanceKm: 500 }] }),
    allowedDates: dates,
    prescription: null,
    weeklyDistanceKm: 40,
    qualitySessionCap: 2,
    easyDurationFloorFraction: 0.7,
    injuryFlagCodes: []
  });
  assert.ok(
    result.clamped.some((entry) => entry.includes("500km") && entry.includes("单日上限")),
    "被截断的模型请求必须留痕：" + JSON.stringify(result.clamped)
  );
});

test("a week whose structures measure nothing is still bounded by the ceiling", () => {
  // `{"type":"open"}` is a work goal the prompt invites the model to emit, and a
  // day may omit its warm-up and cool-down. Such a structure measures 0 km, so
  // gating the ceiling on the measured total let a whole week of them through:
  // seven days declared at 49 km were stored as 343 km against a 42 km ceiling,
  // silently. The stored number is what the runner sees and what the week's
  // total is summed from, so it is what the ceiling has to bind.
  const dates = weeklyPlanDates(TODAY);
  const bare = (localDate: string) => ({
    localDate,
    kind: "easy",
    distanceKm: 49,
    structure: { blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "open" } }] }] }
  });
  const result = validateWeeklyPlan({
    raw: JSON.stringify({ days: dates.map((day) => bare(day)) }),
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 40,
    qualitySessionCap: 2,
    easyDurationFloorFraction: 0.7,
    injuryFlagCodes: [],
    previousWeekDistanceKm: null
  });
  const ceiling = weeklyPlanVolumeCeiling(40, null) * VOLUME_CEILING_TOLERANCE;
  const storedTotal = result.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  assert.ok(storedTotal <= ceiling + 1e-6, `周总量 ${storedTotal}km 超过上限 ${ceiling}km`);
  assert.ok(
    result.clamped.some((entry) => entry.includes("超过上限")),
    "把一整周无实测距离的计划砍到上限，必须在审计里留痕：" + JSON.stringify(result.clamped)
  );
  // The rebuilt days are dosed by distance, so the stored number comes off the
  // structure the watch will run rather than off the model's own declaration.
  for (const day of result.days) {
    if (day.kind === "rest" || !day.structure) continue;
    const measured = measureStructure(day.structure, day.kind, pacesFromZones(PRESCRIPTION)).distanceKm;
    assert.ok(measured > 0, day.localDate + " 缩放后必须成为可实测的课程");
    assert.ok(
      Math.abs(measured - (day.distanceKm ?? 0)) <= 0.05,
      `${day.localDate} 落库 ${day.distanceKm}km 与结构实测 ${measured}km 不一致`
    );
  }
});

test("a quality session too big for the week is demoted once scaling has nothing left", () => {
  // The interval scales by rep count down to two reps — 5.29 km, the shortest
  // quality session the coach prescribes — and a 4 km week cannot host it. The
  // day used to survive at 1.26x the ceiling: the demotion pass skipped it
  // because the scaler had already shortened it, and the dropping pass never
  // takes the last session. An easy run *does* fit that week, so it is re-cut as
  // one.
  const dates = weeklyPlanDates(TODAY).slice(0, 1);
  const result = validateWeeklyPlan({
    raw: JSON.stringify({
      days: [
        {
          localDate: dates[0],
          kind: "interval",
          distanceKm: 20,
          structure: {
            warmup: { purpose: "warmup", goal: { type: "time", seconds: 600 }, alert: null },
            blocks: [
              {
                iterations: 8,
                steps: [
                  { purpose: "work", goal: { type: "distance", meters: 800 }, alert: { kind: "pace", lower: 240, upper: 265 } },
                  { purpose: "recovery", goal: { type: "time", seconds: 120 }, alert: null }
                ]
              }
            ],
            cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 600 }, alert: null }
          }
        }
      ]
    }),
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 4,
    qualitySessionCap: 2,
    easyDurationFloorFraction: 0,
    injuryFlagCodes: []
  });
  const ceiling = weeklyPlanVolumeCeiling(4, null) * VOLUME_CEILING_TOLERANCE;
  assert.equal(result.days[0]?.kind, "easy", "缩放救不回来的质量课必须降为轻松跑");
  assert.ok((result.days[0]?.distanceKm ?? 0) <= ceiling + 1e-6, "降级后必须装进上限");
  assert.ok(
    result.clamped.some((entry) => entry.includes("已降为轻松跑")),
    "降级必须留痕：" + JSON.stringify(result.clamped)
  );
  // It fits now, so the line must not hedge about a residual that is no longer
  // there — the wording is only honest in one direction.
  assert.ok(
    !result.clamped.some((entry) => entry.includes("仍高于上限")),
    "已经装进上限的计划不得声称仍高于上限：" + JSON.stringify(result.clamped)
  );
});

test("a day whose structure cannot be sized is rebuilt instead of storing the model's number", () => {
  // `{"type":"open"}` means "run until the watch is stopped", and the model is
  // invited to emit it. A day built on one has no distance the app can measure,
  // so it would have shown and summed the model's own declaration while the watch
  // ran an unbounded work block — and the week's ceiling, which is enforced on
  // the distance, could not see it at all. It is rebuilt from that declaration,
  // so the prescription and the number describe each other, and — because the
  // model's own shape is being replaced — the rewrite is reported.
  const dates = weeklyPlanDates(TODAY).slice(0, 1);
  const result = validateWeeklyPlan({
    raw: JSON.stringify({
      days: [
        {
          localDate: dates[0],
          kind: "tempo",
          distanceKm: 5,
          structure: { blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "open" } }] }] }
        }
      ]
    }),
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 60,
    qualitySessionCap: 2,
    easyDurationFloorFraction: 0,
    injuryFlagCodes: []
  });
  const day = result.days[0];
  assert.ok(day?.structure, "重建后必须有结构");
  const measured = measureStructure(day.structure, day.kind, pacesFromZones(PRESCRIPTION)).distanceKm;
  assert.ok(measured > 0, "重建后的结构必须可估算距离");
  assert.ok(
    Math.abs(measured - (day.distanceKm ?? 0)) <= 0.05,
    `落库 ${day.distanceKm}km 与结构实测 ${measured}km 不一致`
  );
  assert.ok(
    result.clamped.some((entry) => entry.includes("开放式工作段")),
    "重建模型自己的结构必须留痕：" + JSON.stringify(result.clamped)
  );
});

test("a week over the ceiling only in its stored numbers is scaled, not decapitated", () => {
  // Seven 5.7 km days measure 39.67 km against a 39.70 km ceiling while storing
  // 39.90. The scaling pass used to size itself on the measurement, conclude the
  // week already fitted, and leave the 0.2 km residue to the dropping pass — which
  // answered 0.5% of overshoot by deleting a whole 5.7 km session. The gate has
  // always required *both* readings to fit, so the pass that exists to make them
  // fit has to be sized on both as well.
  const goal = 39.7 / VOLUME_CEILING_TOLERANCE;
  const dates = weeklyPlanDates(TODAY);
  const result = validateWeeklyPlan({
    raw: JSON.stringify({ days: dates.map((localDate) => ({ localDate, kind: "easy", distanceKm: 5.7 })) }),
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: goal,
    qualitySessionCap: 2,
    easyDurationFloorFraction: 0.7,
    injuryFlagCodes: [],
    previousWeekDistanceKm: null
  });
  const ceiling = weeklyPlanVolumeCeiling(goal, null) * VOLUME_CEILING_TOLERANCE;
  const storedTotal = result.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  assert.equal(
    result.days.filter((day) => day.kind !== "rest").length,
    dates.length,
    "只超一个取整台阶不得丢课：" + JSON.stringify(result.days.map((day) => `${day.kind}/${day.distanceKm}`))
  );
  assert.ok(storedTotal <= ceiling + 1e-6, `周总量 ${storedTotal}km 超过上限 ${ceiling}km`);
  assert.ok(
    !result.clamped.some((entry) => entry.includes("已改为休息")),
    "取整残差不得触发丢课：" + JSON.stringify(result.clamped)
  );
});

test("a week below what the coach can prescribe says so instead of claiming a reduction", () => {
  // A 2 km goal gives a 2.1 km ceiling, below the shortest easy run the coach
  // builds (2.54 km), so nothing can satisfy it. The audit line has to name the
  // shortfall: "已缩减至 2.5km" beside "超过上限 2.1km" reads as compliance with
  // a number that is itself over the limit.
  const dates = weeklyPlanDates(TODAY);
  const result = validateWeeklyPlan({
    raw: JSON.stringify({
      days: dates.map((localDate) => ({
        localDate,
        kind: "interval",
        distanceKm: 20,
        structure: {
          warmup: { purpose: "warmup", goal: { type: "time", seconds: 600 }, alert: null },
          blocks: [
            {
              iterations: 8,
              steps: [
                { purpose: "work", goal: { type: "distance", meters: 800 }, alert: { kind: "pace", lower: 240, upper: 265 } },
                { purpose: "recovery", goal: { type: "time", seconds: 120 }, alert: null }
              ]
            }
          ],
          cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 600 }, alert: null }
        }
      }))
    }),
    allowedDates: dates,
    prescription: PRESCRIPTION,
    weeklyDistanceKm: 2,
    qualitySessionCap: 4,
    easyDurationFloorFraction: 0,
    injuryFlagCodes: []
  });
  const ceiling = weeklyPlanVolumeCeiling(2, null) * VOLUME_CEILING_TOLERANCE;
  const storedTotal = result.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  const kept = result.days.filter((day) => day.kind !== "rest").length;
  assert.equal(kept, 1, "退化区间里只保留一堂最便宜的课：" + JSON.stringify(result.days.map((day) => day.kind)));
  assert.ok(storedTotal > ceiling, `前置条件：结构地板 ${storedTotal}km 本就高于上限 ${ceiling}km`);
  const line = result.clamped.find((entry) => entry.includes("已缩减至"));
  assert.ok(line, "缩减过就必须留痕：" + JSON.stringify(result.clamped));
  assert.ok(line.includes("仍高于上限"), "装不进上限的周计划不得声称已合规：" + line);
});


test("fallback plans enforce the same easy-duration floor at every volume budget", () => {
  for (const prescription of [null, PRESCRIPTION]) for (const weeklyDistanceKm of [1, 5, 15, 20, 30, 40, 80]) {
    for (const floor of [0.5, 0.7, 0.9, 1]) {
      const days = buildCoachWeekPlan({ allowedDates: weeklyPlanDates("2026-09-21"), prescription,
        weeklyDistanceKm, qualitySessionCap: 2, easyDurationFloorFraction: floor, injuryFlagCodes: [] });
      let total = 0, easy = 0;
      for (const day of days) {
        if (!day.structure) continue;
        const duration = measureStructure(day.structure, day.kind, pacesFromZones(prescription)).durationSeconds;
        total += duration;
        if (["easy", "recovery"].includes(day.kind)) easy += duration;
      }
      assert.ok(total === 0 || easy / total >= floor, JSON.stringify({ weeklyDistanceKm, floor, days }));
      assert.ok(days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= weeklyDistanceKm + 1e-6);
    }
  }
});

test("fallback respects race day and completed natural-week volume across Sunday", async () => {
  const today = todayPayload({
    today: { localDate: "2026-09-25", workoutCount: 0 },
    week: { periodStart: "2026-09-21", periodEnd: "2026-09-27", distanceKm: 40 },
    weekStructure: { qualitySessionCount: 2 }
  });
  const result = await generateWeeklyPlan({ today, goals: { easyDurationFloorFraction: 0.8, qualitySessionCap: 2, raceTarget: { date: "2026-09-27", distance: "half_marathon", targetPaceSecondsPerKm: 330 } }, ...capacityInputs(40), prescription: PRESCRIPTION });
  assert.equal(result.days.length, 7);
  assert.equal(result.days[0]!.localDate, "2026-09-25");
  assert.equal(result.days.at(-1)!.localDate, "2026-10-01");
  assert.ok(result.days.filter(day => day.localDate <= "2026-09-27").every(day => day.kind === "rest"));
  assert.ok(result.days.filter(day => day.localDate > "2026-09-27").reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 40 * 1.05);
});

/**
 * G05: the phase has to reach the prescription.
 *
 * A taper that exists only in the plan view is worse than no phase at all: the runner
 * reads "减量期" and is handed 专项期 volume.
 */
test("G05: a taper week is generated inside the phase band, and says why", async () => {
  const today = todayPayload({
    today: { localDate: "2026-10-05", workoutCount: 0 },
    week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 0 }
  });
  // Race in twelve days: the week being planned is the taper week of a half marathon.
  const result = await generateWeeklyPlan({
    today,
    goals: {
      easyDurationFloorFraction: 0.8,
      qualitySessionCap: 2,
      raceTarget: { date: "2026-10-17", distance: "half_marathon", targetPaceSecondsPerKm: 330 }
    },
    ...capacityInputs(60),
    prescription: PRESCRIPTION
  });
  const total = result.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  // 0.75 × 60 km is the taper band's upper edge; `finish` may adjust slightly, so the
  // assertion is on the band the runner was promised, not on an exact total.
  assert.ok(total <= 45 + 0.5, `expected the taper band, got ${total} km`);

  const noRace = await generateWeeklyPlan({
    today,
    goals: { easyDurationFloorFraction: 0.8, qualitySessionCap: 2, raceTarget: null },
    ...capacityInputs(60),
    prescription: PRESCRIPTION
  });
  const noRaceTotal = noRace.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  assert.ok(noRaceTotal > total, "without a race target complete sessions are not restricted by race protection");
  assert.ok(
    !noRace.warnings.some((warning) => warning.includes("阶段上限")),
    "no race target means no phase warning at all"
  );
  // The race policy already trims taper days, so the phase ceiling is often the second
  // line of defence rather than the binding one. Either way the week must be inside the
  // band, and a compression that *did* happen must say so (unit-tested in
  // plan-periodization.test.ts).
  if (result.warnings.some((warning) => warning.includes("阶段上限"))) {
    assert.match(result.warnings.find((warning) => warning.includes("阶段上限"))!, /减量期/);
  }
});

/**
 * G06: capacity reaches the week through two separate numbers.
 *
 * Both used to be one field (`goals.weeklyDistanceKm`). A migration that quietly
 * routed one of them to both uses would leave half the derivation dead while
 * every assertion above stayed green — those cases pin the two equal by
 * construction. Here they are pulled apart against a deliberately oversized
 * draft, so what survives is the ceiling rather than the draft.
 */
test("G06: the ceiling baseline and the observed volume are separately load-bearing", () => {
  const raceTarget = { date: "2026-10-24", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 };
  const base = {
    today: todayPayload({ today: { localDate: "2026-10-05", workoutCount: 0 },
      week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 0 } }),
    goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget },
    prescription: PRESCRIPTION
  };
  const proposed: MobilePlannedDay[] = weeklyPlanDates("2026-10-05").map(localDate =>
    ({ localDate, kind: "easy" as const, distanceKm: 30, structure: null, reason: null }));
  const capped = (weeklyVolumeBaselineKm: number, recentWeeklyKm: number): number =>
    constrainUpcomingPlan(proposed, { ...base, weeklyVolumeBaselineKm, recentWeeklyKm })
      .reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);

  // A half marathon two weeks out: taper, so the band's upper edge is 0.75 x recent.
  const control = capped(60, 60);
  assert.ok(control > 0);
  // Same observed volume, a smaller baseline: the baseline is what caps the week.
  assert.ok(capped(5, 60) < control, "the baseline must cap the week");
  // Same baseline, less observed volume: the phase band is what caps the week.
  assert.ok(capped(60, 10) < control, "observed volume must reach the phase band");
});
