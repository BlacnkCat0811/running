import assert from "node:assert/strict";
import test from "node:test";

import type { MobileTodayResponse } from "@rai/api-contracts";

import {
  PRE_RACE_ACTIVATION_MAX_SECONDS,
  PRE_RACE_ACTIVATION_MIN_DAYS_TO_RACE,
  PRE_RACE_ACTIVATION_MIN_SECONDS,
  PRE_RACE_ACTIVATION_POLICY_VERSION,
  PRE_RACE_ACTIVATION_REASON_PREFIX,
  buildPreRaceActivationStructure,
  preRaceActivationFor,
  preRaceActivationWindow
} from "../src/pre-race-activation.js";
import { taperDayCeiling } from "../src/race-plan-policy.js";
import { generateWeeklyPlan } from "../src/weekly-plan-service.js";
import type { CoachZonePrescription } from "../src/mobile-coach.js";

/**
 * G01-B (approved 2026-10-20): pre-race activation sessions.
 *
 * The signed boundary is encoded here: only days 4–14 before the race, last 72
 * hours are rest, 600–900 seconds, only easy, distance never above the same
 * `taperDayCeiling` as a full session, and only a day the taper policy itself
 * emptied (an arbitrary rest day is not upgraded).
 */

const zones: CoachZonePrescription = {
  easyPaceLower: 345, easyPaceUpper: null, easyHrLower: 120, easyHrUpper: 150,
  thresholdPaceLower: 291, thresholdPaceUpper: 318, thresholdHrLower: 160, thresholdHrUpper: 172,
  intervalPaceLower: 270, intervalPaceUpper: 291
};

const today = (localDate: string): MobileTodayResponse => ({
  today: { localDate, distanceKm: 0, durationSeconds: 0, powerWatts: null, workoutCount: 0 },
  week: { periodStart: "2026-10-19", periodEnd: "2026-10-25", distanceKm: 0, durationSeconds: 0, workoutCount: 0 },
  lock: { present: false, relocked: false },
  nextSession: { kind: "easy", distanceKm: null },
  weekStructure: { qualitySessionCount: 0 },
  injuryFlags: []
} as unknown as MobileTodayResponse);

test("赛前激活窗口：只允许赛前第 4–14 天，最后 72 小时只休息", () => {
  assert.equal(PRE_RACE_ACTIVATION_POLICY_VERSION, "rai-pre-race-activation-v1");
  assert.equal(PRE_RACE_ACTIVATION_MIN_DAYS_TO_RACE, 4);
  assert.equal(preRaceActivationWindow("2026-10-20", "2026-10-30"), true); // 10 days
  assert.equal(preRaceActivationWindow("2026-10-26", "2026-10-30"), true); // 4 days
  assert.equal(preRaceActivationWindow("2026-10-27", "2026-10-30"), false); // 3 days → rest
  assert.equal(preRaceActivationWindow("2026-10-29", "2026-10-30"), false); // 1 day → rest
  assert.equal(preRaceActivationWindow("2026-10-30", "2026-10-30"), false); // race day
  assert.equal(preRaceActivationWindow("2026-10-19", "2026-10-30"), true); // 11 days, still inside the 14-day window
});

test("赛前激活结构：600–900 秒、按 easy 结构配速折算且不超过单日减量上限", () => {
  const structure = buildPreRaceActivationStructure(zones, 690);
  assert.ok(structure);
  const seconds = (structure!.warmup?.goal.type === "time" ? structure!.warmup!.goal.seconds : 0) +
    (structure!.blocks[0]!.steps[0]!.goal.type === "time" ? structure!.blocks[0]!.steps[0]!.goal.seconds : 0) +
    (structure!.cooldown?.goal.type === "time" ? structure!.cooldown!.goal.seconds : 0);
  assert.equal(seconds, 690);
  assert.equal(buildPreRaceActivationStructure(zones, PRE_RACE_ACTIVATION_MIN_SECONDS - 1), null);
  assert.equal(buildPreRaceActivationStructure(zones, PRE_RACE_ACTIVATION_MAX_SECONDS + 1), null);
});

test("赛前激活只替换减量策略造成的休息日，且距离不超过 taperDayCeiling", () => {
  const ceiling = taperDayCeiling(20);
  assert.equal(ceiling, 2);
  const activation = preRaceActivationFor(
    { localDate: "2026-10-20", kind: "rest", distanceKm: null, structure: null, reason: "赛前减量，保留恢复。" },
    { raceTarget: { date: "2026-10-30" }, prescription: zones, weeklyVolumeBaselineKm: 20 });
  assert.equal(activation.kind, "easy");
  assert.ok((activation.reason ?? "").startsWith(PRE_RACE_ACTIVATION_REASON_PREFIX));
  assert.ok(activation.distanceKm != null && activation.distanceKm <= ceiling + 0.05);
  // An ordinary rest day is not upgraded, and no race goal means no activation.
  assert.equal(preRaceActivationFor(
    { localDate: "2026-10-20", kind: "rest", distanceKm: null, structure: null, reason: "周跑量预算不足，安排休息" },
    { raceTarget: { date: "2026-10-30" }, prescription: zones, weeklyVolumeBaselineKm: 20 }).kind, "rest");
  assert.equal(preRaceActivationFor(
    { localDate: "2026-10-20", kind: "rest", distanceKm: null, structure: null, reason: "赛前减量，保留恢复。" },
    { raceTarget: null, prescription: zones, weeklyVolumeBaselineKm: 20 }).kind, "rest");
});

test("F05 场景：减量日不再全休，但最后 72 小时与比赛日仍只休息", async () => {
  const plan = await generateWeeklyPlan({
    today: today("2026-10-20"),
    goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2,
      raceTarget: { date: "2026-10-30", distance: "ten_k", targetPaceSecondsPerKm: 300 } },
    weeklyVolumeBaselineKm: 20, recentWeeklyKm: 20, prescription: zones, previousWeekDistanceKm: 20
  });
  const activations = plan.days.filter((day) => (day.reason ?? "").startsWith(PRE_RACE_ACTIVATION_REASON_PREFIX));
  assert.ok(activations.length >= 1, "the signed G01-B policy must produce activation sessions instead of all-rest");
  for (const day of activations) {
    assert.equal(day.kind, "easy");
    assert.ok((day.distanceKm ?? 0) <= taperDayCeiling(20) + 0.05);
  }
  // A race close enough that the whole window is inside 72h: everything stays rest.
  const late = await generateWeeklyPlan({
    today: today("2026-10-25"),
    goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2,
      raceTarget: { date: "2026-10-27", distance: "ten_k", targetPaceSecondsPerKm: 300 } },
    weeklyVolumeBaselineKm: 20, recentWeeklyKm: 20, prescription: zones, previousWeekDistanceKm: 20
  });
  assert.equal(late.days.filter((day) => day.localDate <= "2026-10-27").every((day) => day.kind === "rest"), true,
    "the last 72 hours and race day are rest: no activation may be scheduled there");
});
