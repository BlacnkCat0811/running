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
import {
  buildCoachConfidence, buildRunCoachWeek, coachConfidenceFromPreparation, COACH_CONFIDENCE_MODERATE_FLOOR,
  COACH_CONFIDENCE_HIGH_FLOOR, COACH_PREPARATION_STALE_AFTER_DAYS, registerRunCoachRoutes, runCoachAdaptationKey, runCoachResponse,
  runCoachUnplannedDays, runCoachWeeklyBudget
} from "../src/run-coach.js";
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
  // A distance outside the calibrated set has no skeleton, so it has no phase either. This
  // used to answer "race_week": the old `floor(daysBetween / 7)` never looked at the
  // distance, so a marathon was handed the phase of a periodised plan that does not exist.
  assert.equal(runCoachPhase("2026-11-30", { ...config, goal: "finish", raceDate: "2026-12-06", raceDistanceKm: 42.195 }), null);
  // …while a calibrated distance still answers, and answers for the natural week: 2026-11-30
  // (Mon) and 2026-12-06 (Sun) are the same Mon–Sun week, so both read `race_week`.
  assert.equal(runCoachPhase("2026-11-30", { ...config, goal: "finish", raceDate: "2026-12-06", raceDistanceKm: 21.0975 }), "race_week");
  assert.equal(runCoachPhase("2026-12-06", { ...config, goal: "finish", raceDate: "2026-12-06", raceDistanceKm: 21.0975 }), "race_week");
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

/** Half marathon 60 days out: the phase is `base` on both skeletons, so the two agree. */
const raceConfig: MobileRunCoachConfig = { ...config, goal: "finish", raceDate: "2026-12-06", raceDistanceKm: 21.0975 };
const customConfig: MobileRunCoachConfig = { ...config, goal: "finish", raceDate: "2026-12-06", raceDistanceKm: 42.195 };

test("coach confidence refuses to render absent evidence as zero and degrades an unsupported distance honestly", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-coach-confidence-"));
  const path = join(root, "rai.sqlite");
  (await RaiDatabase.open(path)).close();
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  const app = Fastify();
  registerRunCoachRoutes({ app, store, inputs: value => read.mobileWeeklyPlanInputs(value, store.planHistory()) });
  const start = async (value: MobileRunCoachConfig) => app.inject({ method: "POST", url: "/v1/mobile/run-coach",
    payload: { expectedRevision: store.read().revision, action: "start", config: value } });
  try {
    // Cold start: no training facts at all. The prep score is undefined, not zero, and the
    // whole point of the gate is that the screen must not read `0` as "preparedness is zero".
    const cold = await start(raceConfig);
    assert.equal(cold.statusCode, 200, cold.body);
    const confidence = cold.json().confidence;
    assert.equal(confidence.status, "insufficient_data");
    assert.equal(confidence.value, null, "absent evidence must be null, never 0");
    assert.equal(confidence.band, null);
    assert.equal(confidence.components, null, "components must not survive without a value");
    assert.equal(confidence.basis, null);
    assert.ok(confidence.reasonCodes.includes("preparation_insufficient_evidence"));
    assert.ok(confidence.note.includes("不是达标概率"), "the note must deny being a goal probability");
    assert.equal(store.read().runCoach?.raceDistanceKm, 21.0975);

    // Decision 1's regime, end to end: a cold start keeps the 5 km restart floor on every
    // exit — the published budget, the band the today page prints, and the week it buys.
    assert.equal(cold.json().weeklyCapacityKm, 5);
    assert.equal(read.mobileWeeklyPlanInputs(store.read()).today.periodization!.current!.volumeBandKm.upper, 5);

    // Every selected running weekday the week did not pay for, as codes rather than motives.
    const unplanned = cold.json().unplannedDays as Array<{ localDate: string; code: string; detail: string }>;
    assert.ok(unplanned.length > 0, "a cold-start week leaves runnable days empty");
    const runnable = store.read().weekPlan.filter(day => raceConfig.runningDays.includes(runCoachWeekday(day.localDate)));
    assert.equal(unplanned.length, runnable.filter(day => day.kind === "rest").length);
    assert.ok(unplanned.every(row => row.code === "no_session_scheduled" || row.code === "pre_race_taper"));
    assert.ok(unplanned.every(row => /未来7日窗口 \d+ 个可跑步日，排入 \d+ 次训练。/.test(row.detail)));

    // The stored day used to answer every one of these with「恢复日。」— a recovery claim made
    // with `recovery.state == "unknown"` and no recovery evidence in the payload at all. The
    // day now states the fact; the code travels separately in `unplannedDays`.
    assert.ok(store.read().weekPlan.every(day => !(day.reason ?? "").startsWith("恢复日")),
      "the stored week must not assert a cause the read path never established");
    assert.ok(store.read().weekPlan.filter(day => day.kind === "rest" && raceConfig.runningDays.includes(runCoachWeekday(day.localDate)))
      .every(day => day.reason === "未来7日窗口未排课。"));
    assert.equal(runCoachUnplannedDays(null, read.mobileWeeklyPlanInputs(store.read()), []).length, 0);

    // Decision 4: a distance outside the prediction chain keeps `runCoachRaceTarget === null`,
    // so it gets a stated absence instead of an empty ring or a zero.
    assert.equal((await app.inject({ method: "POST", url: "/v1/mobile/run-coach",
      payload: { expectedRevision: store.read().revision, action: "end" } })).statusCode, 200);
    const custom = await start(customConfig);
    assert.equal(custom.statusCode, 200, custom.body);
    assert.equal(store.read().runCoach?.raceDistanceKm, 42.195);
    assert.equal(runCoachRaceTarget(store.read().runCoach!), null);
    assert.equal(custom.json().confidence.status, "insufficient_data");
    assert.equal(custom.json().confidence.value, null);
    assert.ok(custom.json().confidence.reasonCodes.includes("unsupported_distance"));

    // A fitness programme has no race, so it has no prep question to answer: null, not a shell.
    const goals = { ...store.read(), runCoach: { ...plan, goal: "fitness" as const } };
    assert.equal(buildCoachConfidence(goals.runCoach, read.mobileWeeklyPlanInputs(goals)), null);
  } finally { await app.close(); read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("coach confidence bands a preparation score and never lets uncalibrated evidence claim high", () => {
  const components = { volumePreparedness: 1, longRunExposure: 0.5, frequency: 0.25, targetExposure: 0, recency: 1 };
  const evidence = (score: number, evidenceLevel: "developing" | "established" = "established") =>
    ({ values: { half_marathon: score }, components: { half_marathon: components }, evidenceLevel });
  const prepare = (score: number, calibrationCompleted = true, evidenceLevel: "developing" | "established" = "established") =>
    coachConfidenceFromPreparation({ hasRaceProgramme: true, distance: "half_marathon",
      preparation: evidence(score, evidenceLevel), calibrationCompleted })!;

  assert.equal(coachConfidenceFromPreparation({ hasRaceProgramme: false, distance: null, preparation: null, calibrationCompleted: false }), null);
  assert.equal(coachConfidenceFromPreparation({ hasRaceProgramme: true, distance: null, preparation: null,
    calibrationCompleted: true })!.reasonCodes[0], "unsupported_distance");
  assert.equal(coachConfidenceFromPreparation({ hasRaceProgramme: true, distance: "half_marathon", preparation: null,
    calibrationCompleted: true })!.value, null);

  // 0.8 prep score, calibrated ⇒ 80 / high, with the same components the score was built from.
  const high = prepare(0.8);
  assert.equal(high.status, "available");
  assert.equal(high.value, 80);
  assert.equal(high.band, "high");
  assert.equal(high.basis, "preparation");
  assert.deepEqual(high.components, { volume: 1, longRun: 0.5, frequency: 0.25, exposure: 0, recency: 1 });
  assert.equal(high.evidenceLevel, "established");
  assert.deepEqual(high.reasonCodes, ["preparation_basis"]);
  assert.ok(high.note.includes("备赛准备度 80%"));
  assert.ok(high.note.includes("不是达标概率"));

  // Gate 3: the same score without calibration may not be called "high".
  const capped = prepare(0.8, false);
  assert.equal(capped.value, 80, "the cap changes the band, not the number");
  assert.equal(capped.band, "moderate");
  assert.deepEqual(capped.reasonCodes, ["preparation_basis", "calibration_incomplete_caps_band"]);
  assert.equal(prepare(0.9, false).band, "moderate");
  assert.equal(prepare(0.5, false).band, "moderate", "a capped band is not raised");

  // Band boundaries are policy constants, so the test pins them by name rather than by number.
  assert.equal(COACH_CONFIDENCE_HIGH_FLOOR, 70);
  assert.equal(COACH_CONFIDENCE_MODERATE_FLOOR, 40);
  assert.equal(prepare(0.7).band, "high");
  assert.equal(prepare(0.69).band, "moderate");
  assert.equal(prepare(0.4).band, "moderate");
  assert.equal(prepare(0.39).band, "low");
  assert.equal(prepare(0).band, "low");
  assert.equal(prepare(0).value, 0, "a measured zero is a value; only absent evidence is null");

  // A low score points at the missing volume instead of implying "train harder".
  assert.ok(prepare(0.54).note.includes("缺的是这条距离的周量和长课"));
  assert.ok(!prepare(0.55).note.includes("缺的是这条距离的周量和长课"));
  // History that does not cover a full window travels with the number so a low score is readable.
  assert.equal(prepare(0.6, true, "developing").evidenceLevel, "developing");

  const stale = coachConfidenceFromPreparation({ hasRaceProgramme: true, distance: "half_marathon",
    preparation: { ...evidence(0.9), dataThroughAt: "2026-05-29T16:00:00.000Z" },
    calibrationCompleted: true, currentDate: "2026-10-07" })!;
  assert.equal(COACH_PREPARATION_STALE_AFTER_DAYS, 56);
  assert.equal(stale.status, "insufficient_data");
  assert.equal(stale.value, null, "stale evidence must not be presented as current confidence");
  assert.deepEqual(stale.reasonCodes, ["preparation_stale"]);
  assert.ok(stale.note.includes("2026-05-29"));
});

test("unplanned coach days use only the current seven-day window", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-coach-unplanned-window-"));
  const path = join(root, "rai.sqlite");
  (await RaiDatabase.open(path)).close();
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  try {
    const weekPlan = [
      ...["2026-10-05", "2026-10-06"].map(localDate => ({ localDate, kind: "rest" as const, distanceKm: null })),
      { localDate: "2026-10-07", kind: "easy" as const, distanceKm: 3 },
      ...["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]
        .map(localDate => ({ localDate, kind: "rest" as const, distanceKm: null }))
    ];
    const goals = { ...store.read(), runCoach: { ...plan, runningDays: [1, 2, 3, 4, 5, 6, 7], longRunDays: [7] }, weekPlan };
    const response = runCoachResponse(goals, read.mobileWeeklyPlanInputs(goals));
    assert.deepEqual(response.unplannedDays.map(day => day.localDate),
      ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]);
    assert.ok(response.unplannedDays.every(day => day.localDate >= "2026-10-07" && day.localDate <= "2026-10-13"));
    assert.ok(response.unplannedDays.every(day => day.detail === "未来7日窗口 7 个可跑步日，排入 1 次训练。"));
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("one weekly budget is published and spent, and matches the band the today page shows", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-coach-budget-"));
  const path = join(root, "rai.sqlite");
  await seedRecentRunningWeeks(path, "2026-10-07", 30);
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  try {
    const goals = { ...store.read(), runCoach: { ...plan, ...raceConfig, runningDays: [1, 2, 3, 4, 5, 6, 7], longRunDays: [4] },
      raceTarget: runCoachRaceTarget({ ...plan, ...raceConfig }) };
    const inputs = read.mobileWeeklyPlanInputs(goals);
    const budget = runCoachWeeklyBudget(goals.runCoach, inputs);
    const band = inputs.today.periodization!.current!.volumeBandKm.upper;

    // The published number is the week's budget, and it is the band the today page prints.
    assert.equal(budget, band);
    // This is the assertion the old code failed: it published the already-ramped race-target
    // capacity (36.75) while sizing sessions from a phase-trimmed number (31.5) — two quantities,
    // one screen. Reading the raw baseline back through the route must not reproduce that.
    assert.ok(band < inputs.weeklyVolumeBaselineKm,
      `expected the band (${band}) to be the tighter of the two, got published capacity ${inputs.weeklyVolumeBaselineKm}`);
    // The route must publish the budget, not `inputs.weeklyVolumeBaselineKm` (which is what the
    // read path used to hand out — a number the generator never spent).
    const response = runCoachResponse(goals, inputs);
    assert.equal(response.weeklyCapacityKm, budget, "the route must publish the week's budget");
    assert.equal(response.weeklyCapacityKm, band, "and the today page must print the same number");
    assert.notEqual(response.weeklyCapacityKm, inputs.weeklyVolumeBaselineKm);

    const days = buildRunCoachWeek(goals.runCoach, goals, inputs);
    const spent = days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
    assert.ok(spent <= budget + 1e-9, `a week may not spend ${spent} km against a ${budget} km budget`);
    assert.ok(days.some(day => day.kind !== "rest"), "the budget must still buy a session");

    // The athlete's own four weeks are the baseline here, so the budget is the band rather
    // than the race-target capacity: 30 × 1.05 = 31.5, not the 36.75 the read path used to publish.
    assert.equal(inputs.recentWeeklyKm > 0, true);
    assert.equal(budget, Math.min(inputs.weeklyVolumeBaselineKm, 31.5));

    // Same invariant for every calibrated distance. A 5K plan used to derive its band from
    // `floor(days / 7)` over a flat `taper + 5` build window while the today page derived it
    // from `PHASE_BOUNDARIES`, so the two sides could name different bands for one week. The
    // half marathon happened to agree, which is exactly why the assertions above — written
    // against a half-marathon fixture — never caught it.
    for (const [label, raceDistanceKm] of [["5K", 5], ["10K", 10], ["half marathon", 21.0975]] as const) {
      const variant = { ...raceConfig, raceDistanceKm };
      const variantGoals = { ...store.read(), runCoach: { ...plan, ...variant, runningDays: [1, 2, 3, 4, 5, 6, 7], longRunDays: [4] },
        raceTarget: runCoachRaceTarget({ ...plan, ...variant }) };
      const variantInputs = read.mobileWeeklyPlanInputs(variantGoals);
      const todayBand = variantInputs.today.periodization!.current!.volumeBandKm.upper;
      const expected = Math.min(variantInputs.weeklyVolumeBaselineKm, todayBand);
      assert.equal(runCoachWeeklyBudget(variantGoals.runCoach, variantInputs), expected,
        `${label}: the budget must be the smaller of the capacity and the today page band`);
      assert.equal(runCoachResponse(variantGoals, variantInputs).weeklyCapacityKm, expected,
        `${label}: the route must publish that same number`);
      assert.ok(expected <= todayBand + 1e-9, `${label}: the budget may never exceed the today page band`);
    }
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("when the phase band is the binding constraint it is read from the today page, not recomputed", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-coach-band-binds-"));
  const path = join(root, "rai.sqlite");
  // 8 km/week, deliberately *below* the race-target capacity: `max(5, 8 × 1.3) = 10.4` km, so
  // the phase band (8 × 1.05 = 8.4 km) is the number that binds. That is the only shape in
  // which "the coach's band" and "the today page's band" are observably different quantities —
  // with 30 km/week the capacity wins and hides the difference.
  //
  // Both race dates below put the two old algorithms on opposite sides of their build/taper
  // boundary: `floor(days / 7)` says `build` (band 8 × 1.1 = 8.8) while `PHASE_BOUNDARIES`
  // says `base` (band 8.4). Publishing 8.8 here is the 33-vs-31.5 defect in miniature.
  await seedRecentRunningWeeks(path, "2026-10-07", 8);
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  try {
    for (const [label, raceDistanceKm, raceDate] of [["10K", 10, "2026-11-29"], ["5K", 5, "2026-11-22"]] as const) {
      const variant = { ...raceConfig, raceDate, raceDistanceKm };
      const goals = { ...store.read(), runCoach: { ...plan, ...variant, runningDays: [1, 2, 3, 4, 5, 6, 7], longRunDays: [4] },
        raceTarget: runCoachRaceTarget({ ...plan, ...variant }) };
      const inputs = read.mobileWeeklyPlanInputs(goals);
      const todayBand = inputs.today.periodization!.current!.volumeBandKm.upper;
      assert.ok(inputs.weeklyVolumeBaselineKm > todayBand,
        `${label}: the fixture must leave the capacity looser than the band (${inputs.weeklyVolumeBaselineKm} vs ${todayBand})`);
      assert.equal(runCoachWeeklyBudget(goals.runCoach, inputs), todayBand,
        `${label}: with the band binding, the budget must be the today page's band`);
      assert.equal(runCoachResponse(goals, inputs).weeklyCapacityKm, todayBand,
        `${label}: and so must the published number`);
    }
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("full coach response never fabricates phase lists for fitness or unsupported distances", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-11T04:00:00Z") }); // Sunday: rolling window crosses a natural week.
  const root = mkdtempSync(join(tmpdir(), "rai-coach-null-phases-"));
  const path = join(root, "rai.sqlite");
  await seedRecentRunningWeeks(path, "2026-10-11", 30);
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  try {
    for (const distance of [null, 42.195, 50]) {
      const programme: MobileRunCoachPlan = { ...plan, ...(distance == null ? {} : { goal: "finish", raceDate: "2026-12-06", raceDistanceKm: distance }) };
      const goals = { ...store.read(), runCoach: programme, raceTarget: runCoachRaceTarget(programme) };
      const response = runCoachResponse(goals, read.mobileWeeklyPlanInputs(goals));
      assert.equal(response.phase, null);
      assert.deepEqual(response.phases, [], `distance ${distance} has no periodisation skeleton`);
    }
    for (const distance of [5, 10, 21.0975]) {
      const programme: MobileRunCoachPlan = { ...plan, goal: "finish", raceDate: "2026-12-06", raceDistanceKm: distance };
      const goals = { ...store.read(), runCoach: programme, raceTarget: runCoachRaceTarget(programme) };
      const inputs = read.mobileWeeklyPlanInputs(goals);
      const response = runCoachResponse(goals, inputs);
      assert.equal(response.phase, runCoachPhase(inputs.today.today.localDate, programme));
      assert.ok(response.phases.length > 0);
    }
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
