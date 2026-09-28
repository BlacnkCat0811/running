import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { MobilePlannedDay, MobileSessionStructure, MobileTodayResponse } from "@rai/api-contracts";

import { buildWeeklyPlanPrompt } from "../src/weekly-plan-prompt.js";
import type { CoachZonePrescription } from "../src/mobile-coach.js";
import { buildSessionStructure, measureStructure, pacesFromZones, roundKm } from "../src/mobile-coach.js";
import {
  DEFAULT_TOTAL_BUDGET_MS,
  MAX_LLM_RESPONSE_BYTES,
  createPlanModelClient,
  llmConfigFromEnv
} from "../src/weekly-plan-llm.js";
import { MAX_PLANNED_DISTANCE_KM } from "../src/session-structure.js";
import { readStripped, sourceFiles } from "./source-scan.js";
import {
  generateWeeklyPlan,
  overwriteWarning,
  overwrittenPlanDates,
  weeklyPlanDates
} from "../src/weekly-plan-service.js";
import {
  buildFallbackWeekPlan,
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
    week: { periodStart: "2026-09-07", periodEnd: "2026-09-13", distanceKm: 12, durationSeconds: 4200, workoutCount: 2, goalDistanceKm: 40, goalProgressFraction: 0.3 },
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
  const result = validateWeeklyPlan(validateArgs(JSON.stringify({ days }), { qualitySessionCap: 3 }));
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
  const days = buildFallbackWeekPlan({
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

  const blocked = buildFallbackWeekPlan({
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
    const days = buildFallbackWeekPlan({
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
    buildFallbackWeekPlan({
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

test("generation falls back when no model is configured", async () => {
  const result = await generateWeeklyPlan({
    today: todayPayload(),
    goals: { weeklyDistanceKm: 35, easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget: null },
    prescription: PRESCRIPTION,
    client: null
  });
  assert.equal(result.audit.generatedBy, "heuristic");
  assert.equal(result.audit.model, null);
  assert.equal(result.days.length, 7);
  assert.ok(result.warnings.some((entry) => entry.includes("RAI_LLM_API_KEY")));
});

test("generation falls back when the model call fails or returns garbage", async () => {
  const failing = {
    provider: "deepseek",
    model: "deepseek-chat",
    complete: async () => {
      throw new Error("网络不可达");
    }
  };
  const failed = await generateWeeklyPlan({
    today: todayPayload(),
    goals: { weeklyDistanceKm: 35, easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget: null },
    prescription: PRESCRIPTION,
    client: failing
  });
  assert.equal(failed.audit.generatedBy, "heuristic");
  assert.ok(failed.warnings.some((entry) => entry.includes("模型调用失败")));

  const garbage = {
    provider: "deepseek",
    model: "deepseek-chat",
    complete: async () => "抱歉，我无法完成。"
  };
  const invalid = await generateWeeklyPlan({
    today: todayPayload(),
    goals: { weeklyDistanceKm: 35, easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget: null },
    prescription: PRESCRIPTION,
    client: garbage
  });
  assert.equal(invalid.audit.generatedBy, "heuristic");
  assert.equal(invalid.days.length, 7);
});

test("a valid model response is accepted and audited", async () => {
  const payload = JSON.stringify({
    days: [
      { localDate: "2026-09-07", kind: "easy", distanceKm: 8, reason: "今天轻松", structure: null },
      { localDate: "2026-09-08", kind: "interval", distanceKm: 9, reason: "VO2", structure: null },
      { localDate: "2026-09-09", kind: "rest", distanceKm: null, reason: "休息", structure: null },
      { localDate: "2026-09-10", kind: "easy", distanceKm: 8, reason: "轻松", structure: null },
      { localDate: "2026-09-11", kind: "easy", distanceKm: 8, reason: "轻松", structure: null },
      { localDate: "2026-09-12", kind: "tempo", distanceKm: 10, reason: "阈值", structure: null },
      { localDate: "2026-09-13", kind: "long_run", distanceKm: 14, reason: "长距离", structure: null }
    ]
  });
  const client = { provider: "deepseek", model: "deepseek-chat", complete: async () => payload };
  const result = await generateWeeklyPlan({
    today: todayPayload(),
    goals: { weeklyDistanceKm: 45, easyDurationFloorFraction: 0.5, qualitySessionCap: 2, raceTarget: null },
    prescription: PRESCRIPTION,
    client
  });
  assert.equal(result.audit.generatedBy, "llm");
  assert.equal(result.audit.model, "deepseek:deepseek-chat");
  assert.equal(result.audit.promptVersion, "weekly-plan-v2");
  assert.equal(result.days.length, 7);
  // every non-rest day is rebuilt with a real structure
  assert.equal(result.days.filter((day) => day.kind !== "rest").every((day) => day.structure != null), true);
});

test("llm configuration comes from the environment and never invents a key", () => {
  assert.equal(llmConfigFromEnv({}), null);
  const deepseek = llmConfigFromEnv({ RAI_LLM_API_KEY: "sk-test" });
  assert.equal(deepseek?.provider, "deepseek");
  assert.equal(deepseek?.model, "deepseek-chat");
  assert.equal(deepseek?.baseUrl, "https://api.deepseek.com");
  const openai = llmConfigFromEnv({
    RAI_LLM_API_KEY: "sk-test",
    RAI_LLM_PROVIDER: "OpenAI",
    RAI_LLM_MODEL: "gpt-4o",
    RAI_LLM_BASE_URL: "https://api.openai.com/v1/"
  });
  assert.equal(openai?.provider, "openai");
  assert.equal(openai?.model, "gpt-4o");
  assert.equal(openai?.baseUrl, "https://api.openai.com/v1");
});

test("the model client sends a bearer token and retries once on server errors", async () => {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  let attempts = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    attempts += 1;
    calls.push({
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.authorization
    });
    if (attempts === 1) {
      return new Response("upstream error", { status: 503 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"days":[]}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = createPlanModelClient(
    { provider: "deepseek", model: "deepseek-chat", apiKey: "sk-secret", baseUrl: "https://api.deepseek.com" },
    { fetchImpl }
  );
  const content = await client.complete({ system: "s", user: "u" });
  assert.equal(content, '{"days":[]}');
  assert.equal(attempts, 2);
  assert.equal(calls[0]?.url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0]?.auth, "Bearer sk-secret");
});

test("the output budget leaves room for the plan after a reasoning model's hidden tokens", async () => {
  const budgets: number[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
    budgets.push(Number(body.max_tokens));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"days":[]}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createPlanModelClient(
    { provider: "deepseek", model: "deepseek-flash", apiKey: "sk-secret", baseUrl: "https://api.deepseek.com" },
    { fetchImpl }
  );
  await client.complete({ system: "s", user: "u" });
  // A reasoning model bills its hidden tokens against `max_tokens`. A measured
  // week spent 2921 reasoning tokens plus roughly 1150 visible ones, so at 4096
  // the JSON was cut off mid-object, `parsePlanJson` found no `days` array, and
  // the whole week was silently replaced by the conservative template.
  const budget = budgets[0] ?? 0;
  assert.ok(budget >= 8192, `max_tokens ${budget} leaves too little room for the visible plan after reasoning`);
});

test("a response the provider truncated is rejected instead of parsed", async () => {
  // `finish_reason: "length"` means the JSON was cut off mid-object. Parsing that
  // string is what let `parsePlanJson` find no `days` array and quietly fall back
  // to the template, with nothing in the log naming the truncation.
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"days":[{"local' } }] }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  const client = createPlanModelClient(
    { provider: "deepseek", model: "deepseek-flash", apiKey: "sk-secret", baseUrl: "https://api.deepseek.com" },
    { fetchImpl }
  );
  await assert.rejects(() => client.complete({ system: "s", user: "u" }), /截断/);
  // Not retried: the retry would send the same `max_tokens`, so it truncates the
  // same way while spending what is left of the caller's budget — and the abort
  // that ends *that* attempt is what would then be reported.
  assert.equal(attempts, 1);
});

test("a retry killed by our own deadline does not erase the cause", async () => {
  // The first failure is the provider's; the second is our shrinking timeout. The
  // report must name the provider's, because "the operation was aborted" describes
  // this function's deadline, not what went wrong.
  let attempts = 0;
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      attempts += 1;
      if (attempts === 1) {
        resolve(new Response("upstream exploded", { status: 500 }));
        return;
      }
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("This operation was aborted", "AbortError"))
      );
    })) as unknown as typeof fetch;
  const client = createPlanModelClient(
    { provider: "deepseek", model: "deepseek-flash", apiKey: "sk-secret", baseUrl: "https://api.deepseek.com" },
    { fetchImpl, totalBudgetMs: 6_000, timeoutMs: 45_000 }
  );
  await assert.rejects(() => client.complete({ system: "s", user: "u" }), /模型服务返回 500/);
  assert.equal(attempts, 2);
});

test("a response the provider completed is still accepted", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"days":[]}' } }] }),
      { status: 200 }
    )) as unknown as typeof fetch;
  const client = createPlanModelClient(
    { provider: "deepseek", model: "deepseek-flash", apiKey: "sk-secret", baseUrl: "https://api.deepseek.com" },
    { fetchImpl }
  );
  assert.equal(await client.complete({ system: "s", user: "u" }), '{"days":[]}');
});

test("the output budget can be raised from the environment", async () => {
  const budgets: number[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
    budgets.push(Number(body.max_tokens));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"days":[]}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const config = llmConfigFromEnv({ RAI_LLM_API_KEY: "sk-test", RAI_LLM_MAX_TOKENS: "16384" });
  assert.ok(config);
  const client = createPlanModelClient(config, { fetchImpl });
  await client.complete({ system: "s", user: "u" });
  assert.equal(budgets[0], 16384);
  // A malformed value falls back to the default rather than being sent upstream
  // as `max_tokens: NaN`, which the provider would reject over the wrong thing.
  assert.equal(llmConfigFromEnv({ RAI_LLM_API_KEY: "sk-test", RAI_LLM_MAX_TOKENS: "abc" })?.maxTokens, 8192);
  assert.equal(llmConfigFromEnv({ RAI_LLM_API_KEY: "sk-test" })?.maxTokens, 8192);
});

test("a 401 is not retried", async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    return new Response("unauthorized", { status: 401 });
  }) as unknown as typeof fetch;
  const client = createPlanModelClient(
    { provider: "deepseek", model: "deepseek-chat", apiKey: "bad", baseUrl: "https://api.deepseek.com" },
    { fetchImpl }
  );
  await assert.rejects(() => client.complete({ system: "s", user: "u" }));
  assert.equal(attempts, 1);
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

test("the model client stops retrying once the total budget is spent", async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    return new Response("upstream error", { status: 503 });
  }) as unknown as typeof fetch;

  const client = createPlanModelClient(
    { provider: "deepseek", model: "deepseek-chat", apiKey: "sk-secret", baseUrl: "https://api.deepseek.com" },
    // A budget too small for a second attempt: the retry must not start, so the
    // endpoint can never outlive the client's own timeout.
    { fetchImpl, totalBudgetMs: 50 }
  );

  await assert.rejects(() => client.complete({ system: "s", user: "u" }));
  assert.equal(attempts, 1);
});

test("short model budgets are never extended to a five-second minimum", async () => {
  let attempts = 0;
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      attempts += 1;
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("This operation was aborted", "AbortError"));
      }, { once: true });
    })) as unknown as typeof fetch;
  const client = createPlanModelClient(
    { provider: "fixture", model: "fixture", apiKey: "unused", baseUrl: "http://fixture.invalid" },
    { fetchImpl, totalBudgetMs: 80, timeoutMs: 30 }
  );
  const started = performance.now();
  await assert.rejects(() => client.complete({ system: "s", user: "u" }));
  const elapsed = performance.now() - started;
  assert.equal(attempts, 1);
  assert.ok(elapsed < 1_000, `80ms budget unexpectedly took ${elapsed.toFixed(0)}ms`);
});

test("invalid model timeout configuration is rejected", () => {
  const config = { provider: "fixture", model: "fixture", apiKey: "unused", baseUrl: "http://fixture.invalid" };
  assert.throws(() => createPlanModelClient(config, { timeoutMs: 0 }), /positive finite/);
  assert.throws(() => createPlanModelClient(config, { totalBudgetMs: Number.NaN }), /positive finite/);
  assert.throws(() => createPlanModelClient(config, { timeoutMs: Number.POSITIVE_INFINITY }), /positive finite/);
});

test("non-success model responses cancel their bodies before retrying", async () => {
  let calls = 0;
  let cancellations = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(new ReadableStream<Uint8Array>({
      cancel() { cancellations += 1; }
    }), { status: 503 });
  }) as unknown as typeof fetch;
  const client = createPlanModelClient(
    { provider: "fixture", model: "fixture", apiKey: "unused", baseUrl: "http://fixture.invalid" },
    { fetchImpl }
  );
  await assert.rejects(() => client.complete({ system: "s", user: "u" }), /模型服务返回 503/);
  assert.equal(calls, 2);
  assert.equal(cancellations, 2);
});

test("model response size is enforced from streamed bytes, not content-length", async () => {
  for (const headers of [undefined, { "content-length": "1" }]) {
    let cancellations = 0;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_LLM_RESPONSE_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel() { cancellations += 1; }
      }), { status: 200, ...(headers ? { headers } : {}) });
    }) as unknown as typeof fetch;
    const client = createPlanModelClient(
      { provider: "fixture", model: "fixture", apiKey: "unused", baseUrl: "http://fixture.invalid" },
      { fetchImpl }
    );
    await assert.rejects(() => client.complete({ system: "s", user: "u" }), /大小限制/);
    assert.equal(calls, 1, "oversized responses must not be retried");
    assert.equal(cancellations, 1);
  }
});

test("declared oversized model responses are cancelled without reading", async () => {
  let pulls = 0;
  let cancellations = 0;
  const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
    pull() { pulls += 1; },
    cancel() { cancellations += 1; }
  }), {
    status: 200,
    headers: { "content-length": String(MAX_LLM_RESPONSE_BYTES + 1) }
  })) as unknown as typeof fetch;
  const client = createPlanModelClient(
    { provider: "fixture", model: "fixture", apiKey: "unused", baseUrl: "http://fixture.invalid" },
    { fetchImpl }
  );
  await assert.rejects(() => client.complete({ system: "s", user: "u" }), /大小限制/);
  assert.equal(cancellations, 1);
  assert.ok(pulls <= 1);
});

test("normal multi-chunk model JSON is accepted and malformed JSON stays safe", async () => {
  const encoder = new TextEncoder();
  const content = '{"days":[],"说明":"轻松跑"}';
  const response = encoder.encode(JSON.stringify({ choices: [{ message: { content } }] }));
  const multibyte = encoder.encode("轻");
  let multibyteOffset = -1;
  for (let index = 0; index <= response.length - multibyte.length; index += 1) {
    if (multibyte.every((byte, offset) => response[index + offset] === byte)) {
      multibyteOffset = index;
      break;
    }
  }
  assert.ok(multibyteOffset >= 0, "fixture must contain a real UTF-8 multibyte character");
  // Split after the first byte of “轻” so decoding each chunk independently
  // would corrupt the payload. The client must count bytes but decode the
  // complete body.
  const chunks = [
    response.slice(0, multibyteOffset + 1),
    response.slice(multibyteOffset + 1, multibyteOffset + 2),
    response.slice(multibyteOffset + 2)
  ];
  const good = createPlanModelClient(
    { provider: "fixture", model: "fixture", apiKey: "unused", baseUrl: "http://fixture.invalid" },
    {
      fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        }
      }))) as unknown as typeof fetch
    }
  );
  assert.equal(await good.complete({ system: "s", user: "u" }), content);

  let malformedCalls = 0;
  const malformed = createPlanModelClient(
    { provider: "fixture", model: "fixture", apiKey: "unused", baseUrl: "http://fixture.invalid" },
    {
      fetchImpl: (async () => {
        malformedCalls += 1;
        return new Response("{not-json");
      }) as unknown as typeof fetch
    }
  );
  await assert.rejects(() => malformed.complete({ system: "s", user: "u" }), /有效 JSON/);
  assert.equal(malformedCalls, 2);
});

test("a slow model response body is bounded by the attempt deadline", async () => {
  let cancellations = 0;
  const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancellations += 1; }
  }))) as unknown as typeof fetch;
  const client = createPlanModelClient(
    { provider: "fixture", model: "fixture", apiKey: "unused", baseUrl: "http://fixture.invalid" },
    { fetchImpl, timeoutMs: 40, totalBudgetMs: 100 }
  );
  const started = performance.now();
  await assert.rejects(() => client.complete({ system: "s", user: "u" }));
  assert.ok(performance.now() - started < 1_000);
  assert.equal(cancellations, 1);
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
  const days = buildFallbackWeekPlan({
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
    const days = buildFallbackWeekPlan({
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
  const days = buildFallbackWeekPlan({
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
  const days = buildFallbackWeekPlan({
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

test("the client waits longer for a generated plan than the server spends on it", () => {
  // Preview waits for model generation but never persists the business plan.
  // Keep enough client budget to receive the candidate or fallback. Timeout
  // ordering cannot establish whether a separate mutating request committed.
  // These budgets live in different languages, so check both declarations.
  const raw = readFileSync(new URL("../../ios/RAI/APIClient.swift", import.meta.url), "utf8");
  // Comments stripped the way the Swift reader would: a comment that merely
  // mentions the constant must not be able to stand in for the real argument.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Anchored to the start of a line, to an optional receiver (`configuration.`)
  // and to a declaration, so a comment cannot supply the number either.
  const declaration = (name: string): number => {
    const match = new RegExp(
      "^\\s*(?:[\\w.]*\\.)?(?:static\\s+)?(?:(?:let|var)\\s+)?" + name + "\\s*(?::\\s*TimeInterval)?\\s*=\\s*([\\d_.]+)",
      "m"
    ).exec(source);
    assert.ok(match, `APIClient.swift 必须声明 ${name}`);
    const value = Number(match![1]!.replace(/_/g, ""));
    assert.ok(Number.isFinite(value) && value > 0, `${name} 必须是正的数字字面量，实际读到 ${match![1]}`);
    return value * 1000;
  };
  const clientMs = declaration("generateTimeoutInterval");
  assert.ok(
    DEFAULT_TOTAL_BUDGET_MS < clientMs,
    `服务端总预算 ${DEFAULT_TOTAL_BUDGET_MS}ms 必须小于客户端超时 ${clientMs}ms`
  );
  // `timeoutIntervalForResource` caps the whole transfer regardless of the
  // per-request timeout, so it is the number that actually decides whether the
  // client gives up first. Asserting only the per-request value would let it be
  // lowered underneath the server's budget with every test still green.
  const resourceMs = declaration("timeoutIntervalForResource");
  assert.ok(
    DEFAULT_TOTAL_BUDGET_MS < resourceMs,
    `服务端总预算 ${DEFAULT_TOTAL_BUDGET_MS}ms 必须小于资源超时 ${resourceMs}ms`
  );
  assert.ok(
    resourceMs >= clientMs,
    `资源超时 ${resourceMs}ms 不得低于单请求超时 ${clientMs}ms`
  );
  assert.match(
    source,
    /func previewWeeklyPlan[\s\S]*?path: "\/v1\/mobile\/workout-plan\/preview"[\s\S]*?timeout:\s*Self\.generateTimeoutInterval/,
    "previewWeeklyPlan 必须带上这个超时，否则会退回默认的 POST 超时"
  );

  // No production caller may override the default. The timing tests above
  // verify the actual spending behaviour instead of pinning its source
  // expression, which previously preserved the buggy five-second floor.
  const llmSource = readStripped(new URL("../src/weekly-plan-llm.ts", import.meta.url));
  // Pinning the declaration is not enough on its own: leaving it alone and
  // writing `Date.now() + totalBudgetMs * 2` at the one place the budget is
  // spent doubles the real budget while every number a reader can see stays
  // put. The single use is pinned, and the identifier is counted — so a second
  // deadline computed anywhere in the file fails the equality.
  assert.match(
    llmSource,
    /const deadline = Date\.now\(\) \+ totalBudgetMs;/,
    "总预算必须一次性花完，不得在使用点放大"
  );
  assert.equal(
    (llmSource.match(/\btotalBudgetMs\b/g) ?? []).length,
    4,
    "总预算在 weekly-plan-llm.ts 中只应出现四处：选项声明、默认取值、赋值与唯一使用点"
  );
  // The short-budget and slow-body tests above exercise the actual deadline
  // behaviour. Keep only the single-horizon invariant here rather than pinning
  // the formerly buggy Math.max expression as source text.
  assert.match(
    llmSource,
    /^\s*const remaining = deadline - Date\.now\(\);\s*$/m,
    "剩余预算必须就是 deadline 减当前时间，不得附加任何宽限"
  );
  assert.equal(
    (llmSource.match(/\bDate\.now\(\)/g) ?? []).length,
    2,
    "时间只能看两处：读取 deadline 与计算剩余预算；第三处必然在另一条时间线上"
  );
  assert.ok(
    !/\blet\s+deadline\b/.test(llmSource),
    "deadline 必须是 const：可重新赋值就意味着可以在循环里续期"
  );

  const serviceSource = readStripped(new URL("../src/weekly-plan-service.ts", import.meta.url));
  // The ban is on the identifier, not on one way of spelling an option: a
  // caller can pass a budget without ever writing `totalBudgetMs:` — shorthand
  // (`{ totalBudgetMs, timeoutMs }`), a spread, a variable of its own, or a
  // concatenated key all skip the property shape. Matching the words instead
  // covers every one of those, and they have no other business in the
  // generation path.
  assert.ok(
    !/budget|timeout/i.test(serviceSource),
    "生成路径不得自带预算或超时：客户端预算是照着默认值算的"
  );
  assert.ok(
    !/\bJSON\s*\.\s*parse\b/.test(serviceSource),
    "生成路径不得用 JSON.parse 拼装选项：那是绕过字面量检查的手法"
  );

  // And the same rule against every other module: the generation path is not
  // the only place a client could be built, and an option object is reachable
  // only as `createPlanModelClient`'s second argument. Banning the identifier
  // everywhere and the second argument everywhere closes the route where some
  // neighbouring module — `server.ts`, a helper, a future route file — quietly
  // constructs its own client with a budget the client's timeout never saw.
  const scanned = sourceFiles(new URL("../src/", import.meta.url));
  assert.ok(scanned.length > 1, "应当扫描到多个源文件");
  for (const file of scanned) {
    const normalizedFile = file.replace(/\\/g, "/");
    if (normalizedFile.endsWith("/weekly-plan-llm.ts")) continue;
    const name = normalizedFile.slice(normalizedFile.indexOf("src/"));
    const text = readStripped(file);
    assert.ok(
      !/\btotalBudgetMs\b/.test(text),
      name + " 不得自带 LLM 总预算：客户端预算是照着默认值算的"
    );
    for (const call of text.match(/createPlanModelClient\s*\([\s\S]*?\)/g) ?? []) {
      const args = call.slice(call.indexOf("(") + 1, call.lastIndexOf(")"));
      assert.ok(
        !args.includes(","),
        `${name} 必须以单参数创建模型客户端，否则可以自带预算：${call.trim()}`
      );
    }
  }
});

test("no single day exceeds the per-day distance ceiling", () => {
  // The weekly goal is accepted up to 500 km, and `RAMP_BASE_FLOOR_FRACTION`
  // keeps a comeback week sized against half of it — so a short window can ask
  // the template for a day no runner has ever done. The cap is per day and the
  // stored number has to describe the rebuilt structure, not the request.
  const dates = weeklyPlanDates(TODAY).slice(0, 3);
  const days = buildFallbackWeekPlan({
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


test("weekly prompt includes historical observations without treating missing imports as missed runs", () => {
  const execution = [{
    localDate: "2026-09-06", planRevision: 1, plannedKind: "easy", plannedDistanceKm: 8,
    observedDistanceKm: 0, observedWorkoutCount: 0, distanceRatio: null, status: "pending"
  }];
  const prompt = buildWeeklyPlanPrompt({
    today: todayPayload({ recentPlanExecution: execution }),
    goals: { weeklyDistanceKm: 40, easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget: null },
    prescription: PRESCRIPTION, allowedDates: [TODAY]
  });
  assert.match(prompt.user, /recentExecution/);
  assert.match(prompt.user, /pending\/unknown 不代表漏跑/);
  assert.match(prompt.user, /不得据此补偿加量/);
  assert.match(prompt.user, /"plannedDistanceKm": 8/);
});

test("fallback plans enforce the same easy-duration floor at every volume budget", () => {
  for (const prescription of [null, PRESCRIPTION]) for (const weeklyDistanceKm of [1, 5, 15, 20, 30, 40, 80]) {
    for (const floor of [0.5, 0.7, 0.9, 1]) {
      const days = buildFallbackWeekPlan({ allowedDates: weeklyPlanDates("2026-09-21"), prescription,
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
  const result = await generateWeeklyPlan({ today, goals: { weeklyDistanceKm: 40, easyDurationFloorFraction: 0.8, qualitySessionCap: 2, raceTarget: { date: "2026-09-27", distance: "half_marathon", targetPaceSecondsPerKm: 330 } }, prescription: PRESCRIPTION, client: null });
  assert.equal(result.days.length, 7);
  assert.equal(result.days[0]!.localDate, "2026-09-25");
  assert.equal(result.days.at(-1)!.localDate, "2026-10-01");
  assert.ok(result.days.filter(day => day.localDate <= "2026-09-27").every(day => day.kind === "rest"));
  assert.ok(result.days.filter(day => day.localDate > "2026-09-27").reduce((sum, day) => sum + (day.distanceKm ?? 0), 0) <= 40 * 1.05);
});
