import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
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
  buildCoachConfidence, coachConfidenceFromPreparation, COACH_CONFIDENCE_MODERATE_FLOOR,
  COACH_CONFIDENCE_HIGH_FLOOR, COACH_PREPARATION_STALE_AFTER_DAYS, runCoachResponse,
  runCoachUnplannedDays, runCoachWeeklyBudget
} from "../src/run-coach.js";
import { normalizeRunCoachPlan, runCoachEndDate, runCoachIsTraining, runCoachPhase, runCoachRaceTarget, runCoachWeekday, validateRunCoachConfig } from "../src/run-coach-policy.js";

const config: MobileRunCoachConfig = { goal: "fitness", raceDate: null, raceDistanceKm: null, targetTimeSeconds: null,
  runningDays: [1, 2, 4, 6, 7], longRunDays: [7], targetType: "pace", strengthTraining: true };
const plan: MobileRunCoachPlan = { ...config, id: "fixture", startedOn: "2026-10-06", status: "active", pausedOn: null, endedOn: null, adaptationKey: null, adaptedAt: null };

test("AC1 compatibility read: unsupported two-day quality/long protection applies to the effective layer without rewriting storage", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-coach-custom-protection-"));
  const path = join(root, "rai.sqlite");
  (await RaiDatabase.open(path)).close();
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  try {
    const custom: MobileRunCoachPlan = { ...plan, goal: "finish", raceDate: "2026-10-10", raceDistanceKm: 42.195,
      startedOn: "2026-08-01", runningDays: [1, 2, 3, 4, 5, 6, 7], longRunDays: [3] };
    const structure = buildSessionStructure("long_run", null, { targetDistanceKm: 5 });
    const day = { localDate: "2026-10-07", kind: "long_run" as const, distanceKm: 5, structure, reason: "stored original" };
    const threeDays = store.write({ weekPlan: [day] }, { runCoach: custom });
    assert.equal(read.mobileToday(threeDays).executionPolicy?.protections.length, 0);
    assert.equal(read.mobileToday(threeDays).nextSession.kind, "long_run");
    const twoDays = store.write({ expectedRevision: threeDays.revision, weekPlan: [day] },
      { runCoach: { ...custom, raceDate: "2026-10-09" } });
    const original = store.read();
    const today = read.mobileToday(twoDays);
    assert.equal(today.nextSession.kind, "rest");
    assert.equal(today.executionPolicy?.phase, null);
    assert.equal(today.executionPolicy?.protections[0]?.constraints[0]?.kind, "no_quality_or_long_run");
    assert.equal(read.mobileWorkoutPlan(twoDays).days[0]?.executable, false);
    assert.deepEqual(store.read(), original);
    assert.equal(store.read().weekPlan[0]?.kind, "long_run");
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

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

const raceConfig: MobileRunCoachConfig = { ...config, goal: "finish", raceDate: "2026-12-06", raceDistanceKm: 21.0975 };
const customConfig: MobileRunCoachConfig = { ...config, goal: "finish", raceDate: "2026-12-06", raceDistanceKm: 42.195 };

test("coach confidence refuses to render absent evidence as zero and degrades an unsupported distance honestly", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-coach-confidence-"));
  const path = join(root, "rai.sqlite");
  (await RaiDatabase.open(path)).close();
  const store = new MobileGoalsStore(root);
  const read = new RaiReadStore(path);
  const programme = (value: MobileRunCoachConfig): MobileRunCoachPlan => ({ ...value, id: randomUUID(),
    startedOn: "2026-10-07", status: "active", pausedOn: null, endedOn: null, adaptationKey: null, adaptedAt: null });
  try {
    // Cold start: no training facts at all. The prep score is undefined, not zero, and the
    // whole point of the gate is that the screen must not read `0` as "preparedness is zero".
    const racePlan = programme(raceConfig);
    const raceGoals = { ...store.read(), runCoach: racePlan, raceTarget: runCoachRaceTarget(racePlan) };
    const raceInputs = read.mobileWeeklyPlanInputs(raceGoals);
    const confidence = buildCoachConfidence(racePlan, raceInputs)!;
    assert.equal(confidence.status, "insufficient_data");
    assert.equal(confidence.value, null, "absent evidence must be null, never 0");
    assert.equal(confidence.band, null);
    assert.equal(confidence.components, null, "components must not survive without a value");
    assert.equal(confidence.basis, null);
    assert.ok(confidence.reasonCodes.includes("preparation_insufficient_evidence"));
    assert.ok(confidence.note.includes("不是达标概率"), "the note must deny being a goal probability");

    // Decision 1's regime, end to end: a cold start keeps the 5 km restart floor on every
    // exit — the published budget and the band the today page prints.
    assert.equal(runCoachResponse(raceGoals, raceInputs).weeklyCapacityKm, 5);
    assert.equal(raceInputs.today.periodization!.current!.volumeBandKm.upper, 5);

    // Decision 4: a distance outside the prediction chain keeps `runCoachRaceTarget === null`,
    // so it gets a stated absence instead of an empty ring or a zero.
    const customPlan = programme(customConfig);
    const customGoals = { ...store.read(), runCoach: customPlan, raceTarget: runCoachRaceTarget(customPlan) };
    const customInputs = read.mobileWeeklyPlanInputs(customGoals);
    assert.equal(runCoachRaceTarget(customPlan), null);
    const customConfidence = buildCoachConfidence(customPlan, customInputs)!;
    assert.equal(customConfidence.status, "insufficient_data");
    assert.equal(customConfidence.value, null);
    assert.ok(customConfidence.reasonCodes.includes("unsupported_distance"));

    // A fitness programme has no race, so it has no prep question to answer: null, not a shell.
    const fitnessGoals = { ...store.read(), runCoach: { ...plan, goal: "fitness" as const } };
    assert.equal(buildCoachConfidence(fitnessGoals.runCoach, read.mobileWeeklyPlanInputs(fitnessGoals)), null);
  } finally { read.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
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
