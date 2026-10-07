import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { RaiDatabase } from "@rai/storage-sqlite";
import type { MobileRunCoachConfig, MobileRunCoachPlan, MobileSessionStructure, TrainingZonesCurrentResponse } from "@rai/api-contracts";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { RaiReadStore } from "../src/data.js";
import { buildSessionStructure, plannedDayNumbers } from "../src/mobile-coach.js";
import { constrainUpcomingPlan } from "../src/weekly-plan-service.js";
import { seedRecentRunningWeeks } from "./weekly-training-fixture.js";
import { buildRunCoachWeek, registerRunCoachRoutes, runCoachAdaptationKey } from "../src/run-coach.js";
import { normalizeRunCoachPlan, runCoachEndDate, runCoachIsTraining, runCoachPhase, runCoachRaceTarget, runCoachWeekday, validateRunCoachConfig } from "../src/run-coach-policy.js";

const config: MobileRunCoachConfig = { goal: "fitness", raceDate: null, raceDistanceKm: null, targetTimeSeconds: null,
  runningDays: [1, 2, 4, 6, 7], longRunDays: [7], targetType: "pace", strengthTraining: true };
const plan: MobileRunCoachPlan = { ...config, id: "fixture", startedOn: "2026-10-06", status: "active", pausedOn: null, endedOn: null, adaptationKey: null, adaptedAt: null };

test("coach setup validates actual dates, distance/time, unique weekdays and long-run subsets", () => {
  assert.doesNotThrow(() => validateRunCoachConfig(config, "2026-10-06", true));
  for (const value of [{ ...config, runningDays: [1, 2] }, { ...config, runningDays: [1, 1, 2] },
    { ...config, longRunDays: [3] }, { ...config, raceDate: "2026-12-06" },
    { ...config, goal: "finish" as const, raceDate: "2026-11-31", raceDistanceKm: 5 },
    { ...config, goal: "finish" as const, raceDate: "2026-10-12", raceDistanceKm: 5 },
    { ...config, goal: "time" as const, raceDate: "2026-12-06", raceDistanceKm: 5, targetTimeSeconds: 500 }]) {
    assert.throws(() => validateRunCoachConfig(value, "2026-10-06", true));
  }
  assert.equal(runCoachRaceTarget({ ...config, goal: "finish", raceDate: "2026-12-06", raceDistanceKm: 42.195 }), null);
  assert.equal(runCoachPhase("2026-11-30", { ...config, goal: "finish", raceDate: "2026-12-06", raceDistanceKm: 42.195 }), "race_week");
  assert.equal(runCoachIsTraining({ ...plan, status: "paused" }, "2026-10-06"), false);
  assert.equal(runCoachEndDate({ ...plan, durationWeeks: 6 }), "2026-11-16");
  assert.equal(runCoachIsTraining({ ...plan, durationWeeks: 6 }, "2026-11-17"), false);
  assert.throws(() => validateRunCoachConfig({ ...config, durationWeeks: 53 }, "2026-10-06", true));
  assert.deepEqual(normalizeRunCoachPlan(plan), plan);
  for (const invalid of [null, {}, { ...plan, startedOn: "yesterday" }, { ...plan, durationWeeks: 100_000 },
    { ...plan, runningDays: null }, { ...plan, status: "unknown" }, { ...plan, adaptedAt: "yesterday" }]) {
    assert.equal(normalizeRunCoachPlan(invalid), null, "persisted metadata cannot create an unbounded date loop or crash a read");
  }
});

test("coach lifecycle persists atomically, refresh is idempotent and stopped programmes cannot restart by fallback", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-06T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-run-coach-"));
  const path = join(root, "rai.sqlite");
  (await RaiDatabase.open(path)).close();
  const goals = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const read = new RaiReadStore(path);
  const app = Fastify();
  registerRunCoachRoutes({ app, store: goals, inputs: value => read.mobileWeeklyPlanInputs(value, goals.planHistory()) });
  const command = async (action: string, extra: object = {}) => app.inject({ method: "POST", url: "/v1/mobile/run-coach",
    payload: { expectedRevision: goals.read().revision, action, ...extra } });
  try {
    goals.write({ weekPlan: [{ localDate: "2026-11-06", kind: "rest", distanceKm: null }] });
    const start = await command("start", { config });
    assert.equal(start.statusCode, 200, start.body);
    assert.equal(goals.read().runCoach?.status, "active");
    assert.ok(goals.read().weekPlan.some(day => day.kind !== "rest"));
    assert.ok(goals.read().weekPlan.filter(day => day.kind !== "rest").every(day => config.runningDays.includes(runCoachWeekday(day.localDate))));
    assert.ok(goals.read().weekPlan.every(day => day.localDate <= "2026-10-12"), "old future slots cannot survive outside the new adaptive window");
    const weekdaySet = new Set(config.runningDays);
    assert.ok(read.mobileWorkoutPlan(goals.read()).days.filter(day => !weekdaySet.has(runCoachWeekday(day.localDate))).every(day => !day.executable));
    const revision = goals.read().revision;
    assert.equal((await command("refresh")).statusCode, 200);
    assert.equal(goals.read().revision, revision, "own plan writes cannot poison the facts fingerprint");
    assert.equal((await app.inject({ method: "POST", url: "/v1/mobile/run-coach", payload: { expectedRevision: revision - 1, action: "pause" } })).statusCode, 409);
    assert.equal((await command("start", { config })).statusCode, 422);
    assert.equal((await command("update", { config: { ...config, runningDays: [1, 3, 5], longRunDays: [5] } })).statusCode, 200);
    context.mock.timers.setTime(Date.parse("2026-10-14T04:00:00Z"));
    assert.ok(read.mobileWorkoutPlan(goals.read()).days.every(day => !day.executable), "an expired saved window cannot fall back to the legacy template even on a preferred running day");
    assert.equal((await command("refresh")).statusCode, 200);
    assert.ok(goals.read().weekPlan.some(day => day.localDate >= "2026-10-14" && day.kind !== "rest"));
    assert.equal((await command("pause")).statusCode, 200);
    assert.equal(read.mobileToday(goals.read()).nextSession.kind, "rest");
    assert.ok(read.mobileWorkoutPlan(goals.read()).days.every(day => !day.executable));
    context.mock.timers.setTime(Date.parse("2026-10-23T04:00:00Z"));
    assert.equal(read.mobileToday(goals.read()).nextSession.kind, "rest", "expired pause window cannot invent a run");
    assert.equal((await command("resume")).statusCode, 200);
    assert.equal(goals.read().runCoach?.status, "active");
    assert.equal((await command("end")).statusCode, 200);
    assert.ok(read.mobileWorkoutPlan(goals.read()).days.every(day => !day.executable));
    const reopened = new MobileGoalsStore(root, join(root, "control.sqlite"));
    assert.equal(reopened.read().runCoach?.status, "ended"); reopened.close();
    assert.equal((await command("resume")).statusCode, 422);
    assert.equal((await command("start", { config: { ...config, goal: "finish", raceDate: "2027-01-10", raceDistanceKm: 42.195 } })).statusCode, 200);
    assert.ok((await app.inject({ url: "/v1/mobile/run-coach" })).json().notices.some((message: string) => message.includes("暂无")));
    assert.equal((await command("update", { config: { ...config, goal: "finish", raceDate: "2027-02-10", raceDistanceKm: 42.195 } })).statusCode, 422);
  } finally { await app.close(); read.close(); goals.close(); rmSync(root, { recursive: true, force: true }); }
});

test("adaptive plans respect cold-start budgets, target evidence and immutable completed dates", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-06T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-run-coach-rules-"));
  const path = join(root, "rai.sqlite");
  (await RaiDatabase.open(path)).close();
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  try {
    const goals = { ...store.read(), runCoach: plan };
    const inputs = read.mobileWeeklyPlanInputs(goals);
    const days = buildRunCoachWeek(plan, goals, inputs);
    assert.ok(days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 5);
    assert.ok(days.every(day => day.kind === "rest" || day.kind === "easy"));
    const hr = buildRunCoachWeek({ ...plan, targetType: "heart_rate" }, goals, inputs);
    assert.ok(hr.flatMap(day => day.structure?.blocks.flatMap(block => block.steps) ?? []).every(step => step.alert == null));
    const measuredHR = buildRunCoachWeek({ ...plan, targetType: "heart_rate" }, goals, { ...inputs, prescription: {
      easyPaceLower: 360, easyPaceUpper: 450, easyHrLower: 130, easyHrUpper: 145,
      thresholdPaceLower: null, thresholdPaceUpper: null, thresholdHrLower: null, thresholdHrUpper: null,
      intervalPaceLower: null, intervalPaceUpper: null
    } });
    const hrSteps = measuredHR.flatMap(day => day.structure?.blocks.flatMap(block => block.steps) ?? []);
    assert.ok(hrSteps.length > 0);
    assert.ok(hrSteps.every(step => step.alert?.kind === "heart_rate" && step.alert.lower === 130 && step.alert.upper === 145));
    const completed = buildRunCoachWeek(plan, goals, { ...inputs, today: { ...inputs.today,
      today: { ...inputs.today.today, workoutCount: 1, distanceKm: 3 }, week: { ...inputs.today.week, distanceKm: 3 } } });
    assert.ok(completed.every(day => day.localDate !== "2026-10-06"));
    assert.ok(completed.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 2);
    const key = runCoachAdaptationKey(plan, inputs);
    assert.equal(key, runCoachAdaptationKey({ ...plan, adaptedAt: "new", adaptationKey: key }, inputs));
    assert.notEqual(key, runCoachAdaptationKey(plan, { ...inputs, today: { ...inputs.today, verdict: { ...inputs.today.verdict, tone: "red" } } }));
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});


test("all race distances leave race day blank, including saved or locked legacy training", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-coach-race-day-"));
  const path = join(root, "rai.sqlite");
  (await RaiDatabase.open(path)).close();
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  try {
    const numbers = plannedDayNumbers("easy", buildSessionStructure("easy", null, { targetDistanceKm: 3 }), 3, null);
    for (const distance of [5, 10, 21.0975, 42.195, 50]) {
      const racePlan: MobileRunCoachPlan = { ...plan, goal: "finish", startedOn: "2026-08-01",
        raceDate: "2026-10-07", raceDistanceKm: distance, runningDays: [1, 3, 5], longRunDays: [5] };
      const goals = { ...store.read(), runCoach: racePlan, raceTarget: runCoachRaceTarget(racePlan),
        weekPlan: [{ localDate: "2026-10-07", kind: "easy" as const, distanceKm: numbers.distanceKm, structure: numbers.structure }],
        weekPlanPreservedDate: "2026-10-07", lockedSession: {
          localDate: "2026-10-07", verdictTone: "yellow" as const, lockedAt: "2026-10-07T01:00:00Z",
          session: { ...numbers, kind: "easy" as const, title: "旧训练", reason: "已锁定",
            paceSecondsPerKmLower: null, paceSecondsPerKmUpper: null, heartRateBpmLower: null, heartRateBpmUpper: null }
        } };
      const fresh = { ...goals, weekPlan: [], lockedSession: null, weekPlanPreservedDate: null };
      const days = buildRunCoachWeek(racePlan, fresh, read.mobileWeeklyPlanInputs(fresh));
      assert.equal(days.find(day => day.localDate === racePlan.raceDate)?.kind, "rest", `${distance} km generation`);
      assert.equal(read.mobileToday(goals).nextSession.kind, "rest", `${distance} km saved race-day prescription`);
      assert.ok(read.mobileWorkoutPlan(goals).days.every(day => !day.executable), `${distance} km race day and subsequent days`);
      context.mock.timers.setTime(Date.parse("2026-10-06T04:00:00Z"));
      assert.equal(read.mobileWorkoutPlan(goals).days.find(day => day.localDate === racePlan.raceDate)?.executable, false,
        `${distance} km upcoming race-day export`);
      context.mock.timers.setTime(Date.parse("2026-10-07T04:00:00Z"));
    }
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("heart-rate preferences survive persistence, export validation, budget cuts and missing HR evidence", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-coach-hr-export-"));
  const path = join(root, "rai.sqlite");
  await seedRecentRunningWeeks(path, "2026-10-07", 50);
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  const profile = {
    heartRateBands: [{ zone: "recovery", lowerBpm: 100, upperBpm: 130 },
      { zone: "aerobic_base", lowerBpm: 130, upperBpm: 145 }, { zone: "lactate_threshold", lowerBpm: 155, upperBpm: 165 }],
    paceBands: [{ zone: "easy", lowerSecondsPerKm: 360, upperSecondsPerKm: 450 },
      { zone: "lactate_threshold", lowerSecondsPerKm: 270, upperSecondsPerKm: 300 },
      { zone: "anaerobic_endurance", lowerSecondsPerKm: 240, upperSecondsPerKm: 265 }]
  };
  let zones = { profile } as unknown as TrainingZonesCurrentResponse;
  context.mock.method(read, "trainingZonesCurrent", () => zones);
  const steps = (structure: MobileSessionStructure | null | undefined) => structure ?
    [structure.warmup, ...structure.blocks.flatMap(block => block.steps), structure.cooldown].filter(step => step != null) : [];
  try {
    const hrPlan: MobileRunCoachPlan = { ...plan, targetType: "heart_rate", runningDays: [1, 2, 3, 4, 5, 6, 7], longRunDays: [4] };
    const goals = { ...store.read(), runCoach: hrPlan, qualitySessionCap: 2, easyDurationFloorFraction: 0.4 };
    const initial = read.mobileWeeklyPlanInputs(goals);
    const inputs = { ...initial, today: { ...initial.today, calibration: { ...initial.today.calibration, status: "completed" as const } } };
    const days = buildRunCoachWeek(hrPlan, goals, inputs);
    const interval = days.find(day => day.kind === "interval");
    assert.ok(interval && interval.localDate > "2026-10-07", "fixture includes a future interval session");
    assert.deepEqual(steps(interval.structure).filter(step => step.purpose === "work").map(step => step.alert),
      [{ kind: "heart_rate", lower: 155, upper: 165 }]);
    const written = store.write({ weekPlan: days, qualitySessionCap: 2, easyDurationFloorFraction: 0.4 },
      { runCoach: hrPlan, prescription: inputs.prescription });
    const today = read.mobileToday(written);
    const exported = read.mobileWorkoutPlan(written);
    assert.deepEqual(exported.days.find(day => day.localDate === interval.localDate)?.structure, interval.structure,
      "the Watch executes the same interval targets as the stored programme");
    assert.deepEqual(exported.days[0]?.structure, today.nextSession.structure);
    assert.ok(steps(today.nextSession.structure).length > 0);
    assert.ok(exported.days.flatMap(day => steps(day.structure)).every(step => step.alert?.kind === "heart_rate"));
    const cut = constrainUpcomingPlan(days, { ...inputs, goals: written,
      today: { ...inputs.today, week: { ...inputs.today.week, distanceKm: 45 } } });
    const current = cut.filter(day => day.localDate <= inputs.today.week.periodEnd);
    assert.ok(current.some(day => day.kind !== "rest"));
    assert.ok(current.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 10);
    assert.ok(cut.flatMap(day => steps(day.structure)).every(step => step.alert?.kind === "heart_rate"),
      "structures rebuilt to fit the budget retain heart-rate targets");
    zones = { profile: { ...profile, heartRateBands: [] } } as unknown as TrainingZonesCurrentResponse;
    const noHr = read.mobileWorkoutPlan(written);
    assert.ok(noHr.days.some(day => day.executable));
    assert.ok(noHr.days.flatMap(day => steps(day.structure)).every(step => step.alert == null),
      "missing HR evidence removes targets rather than silently selecting pace");
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
