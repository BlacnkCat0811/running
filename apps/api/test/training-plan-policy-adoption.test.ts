import assert from "node:assert/strict";
import test from "node:test";

import type { MobileTodayResponse } from "@rai/api-contracts";

import { buildCompleteEasyStructure, assessSessionDose, MINIMUM_SESSION_DURATION_SECONDS } from "../src/coach-session-dose.js";
import { MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS, EXTENSION_BLOCKING_FLAGS } from "../src/coach-extension-eligibility.js";
import {
  MINIMUM_BAND_KM,
  periodizationVolumeBandKm,
  buildPeriodization
} from "../src/plan-periodization.js";
import { taperDayCeiling, PRE_RACE_EXECUTION_PROTECTION_DAYS } from "../src/race-plan-policy.js";
import { generateWeeklyPlan } from "../src/weekly-plan-service.js";
import type { CoachZonePrescription } from "../src/mobile-coach.js";

/**
 * G01–G03: the conservative candidates recorded in
 * `docs/TRAINING_PLAN_POLICY_REVIEW.md` §4 are the adopted policy (owner-directed,
 * zero behaviour change). These tests pin the **standard cases** that a future
 * sign-off must keep: they are the guard against "fixing" F05/G02/G03 by silently
 * loosening a dose, a capacity ceiling or the extension gate.
 */

const zones: CoachZonePrescription = {
  easyPaceLower: 345, easyPaceUpper: null, easyHrLower: 120, easyHrUpper: 150,
  thresholdPaceLower: 291, thresholdPaceUpper: 318, thresholdHrLower: 160, thresholdHrUpper: 172,
  intervalPaceLower: 270, intervalPaceUpper: 291
};

const today = (localDate: string, weekKm: number): MobileTodayResponse => ({
  today: { localDate, distanceKm: 0, durationSeconds: 0, powerWatts: null, workoutCount: 0 },
  week: { periodStart: "2026-10-19", periodEnd: "2026-10-25", distanceKm: weekKm,
    durationSeconds: weekKm * 360, workoutCount: weekKm > 0 ? 1 : 0 },
  lock: { present: false, relocked: false },
  nextSession: { kind: "easy", distanceKm: null },
  weekStructure: { qualitySessionCount: 0 },
  injuryFlags: []
} as unknown as MobileTodayResponse);

test("G01（P-G01-B）：赛前激活课已实现且边界被冻结", async () => {
  // The record: last 72 h rest, days 4–14 eligible, 600–900 s, ≤ taperDayCeiling.
  assert.equal(taperDayCeiling(20), 2);
  assert.equal(MINIMUM_SESSION_DURATION_SECONDS, 1800, "the 1800 s rule for a complete session is untouched");
  assert.equal(PRE_RACE_EXECUTION_PROTECTION_DAYS, 14);
  const plan = await generateWeeklyPlan({
    today: today("2026-10-20", 0),
    goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2,
      raceTarget: { date: "2026-10-30", distance: "ten_k", targetPaceSecondsPerKm: 300 } },
    weeklyVolumeBaselineKm: 20, recentWeeklyKm: 20, prescription: zones, previousWeekDistanceKm: 20
  });
  const activations = plan.days.filter((day) => (day.reason ?? "").startsWith("pre_race_activation:"));
  assert.ok(activations.length >= 1, "P-G01-B must produce the signed short activation sessions");
  for (const day of activations) {
    assert.equal(day.kind, "easy");
    assert.ok((day.distanceKm ?? 0) <= taperDayCeiling(20) + 0.05);
  }
  // A short session is still outside the complete-session floor: the class is signed,
  // not a loosening of `assessSessionDose` for ordinary sessions.
  const short = buildCompleteEasyStructure("easy", zones);
  short.blocks[0]!.steps[0]!.goal = { type: "time", seconds: 600 };
  assert.notEqual(assessSessionDose({ kind: "easy", structure: short, zones }).status, "feasible");
});

test("G02（P-G02-C）：容量重启 v2 已实现，默认仍不抬高容量", () => {
  assert.equal(MINIMUM_BAND_KM, 5);
  assert.equal(periodizationVolumeBandKm("base", 0), 5);
  assert.equal(periodizationVolumeBandKm("base", 0), periodizationVolumeBandKm("base", 2),
    "zero/near-zero history all collapse to the same conservative floor");
  const skeleton = buildPeriodization({ today: "2026-10-20", recentWeeklyKm: 0,
    raceTarget: { date: "2026-12-06", distance: "ten_k" } });
  assert.equal(skeleton.current?.volumeBandKm.lower, 5);
  // G02-C 的旧历史释放只在"无近期量 + 连续 4 周有观测 + 28 天前有稳定 4 周"时生效；
  // 这里没有旧历史，所以默认仍是 5 km。释放路径由 `capacity-restart-v2.test.ts` 固定。
  assert.ok(skeleton.reasonCodes.includes("no_recent_weekly_volume"));
});

test("G03（P-G03-A）：追加仍需证据门控，冷启动估算不是追加证据，次数上限冻结", () => {
  assert.equal(MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS, 2);
  assert.ok(EXTENSION_BLOCKING_FLAGS.has("strain"));
  const cold = assessSessionDose({ kind: "easy", structure: buildCompleteEasyStructure("easy", null),
    zones: null, allowColdStartEstimate: true });
  assert.equal(cold.estimateSource, "cold_start_policy");
  // Controlled extension never uses the cold-start estimate as evidence.
  assert.equal(cold.policyVersion, "rai-coach-session-dose-v2");
});
