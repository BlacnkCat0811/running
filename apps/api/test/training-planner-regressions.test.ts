import assert from "node:assert/strict";
import test from "node:test";

import type { MobileSessionStructure } from "@rai/api-contracts";

import type { CoachZonePrescription } from "../src/mobile-coach.js";
import { buildSessionStructure } from "../src/mobile-coach.js";
import type { MobileTodayResponse } from "@rai/api-contracts";

import {
  assessSessionDose,
  buildCompleteEasyStructure,
  COLD_START_ESTIMATE_SECONDS_PER_KM,
  MINIMUM_SESSION_DURATION_SECONDS
} from "../src/coach-session-dose.js";
import { constrainUpcomingPlan, generateWeeklyPlan } from "../src/weekly-plan-service.js";

/**
 * PR2 regressions for the defects the plan lists as F01/F02 (§2.2, §9.2/§9.3).
 *
 * F01 is fixed here; F02 is *reproduced* in `var/probe/f02-repro.mts` and reported as
 * still open (per-natural-week reallocation belongs to the unified kernel, PR2).
 *
 * The zone shape is the important part of the fixture. `buildPaceBands`
 * (packages/training-zones/src/index.ts) publishes the easy band as
 * `{ lowerSecondsPerKm: threshold * 1.15, upperSecondsPerKm: null }`: a slow bound
 * is deliberately absent. Before dose policy v2 that single `null` made every
 * warm-up/cooldown step of every session "no pace evidence", so every interval and
 * tempo candidate was `not_assessable` in production, and easy sessions silently
 * fell back to the 360 s/km cold-start estimate (a round 5 km for a 30-minute run).
 */

/** The production shape emitted by `zonePrescription(buildPaceBands(threshold))`. */
const openEasyZones: CoachZonePrescription = {
  easyPaceLower: 345, // threshold 300 * 1.15
  easyPaceUpper: null, // the easy zone has no slow end
  easyHrLower: 120,
  easyHrUpper: 150,
  thresholdPaceLower: 291, // threshold 300 * 0.97
  thresholdPaceUpper: 318, // threshold 300 * 1.06
  thresholdHrLower: 160,
  thresholdHrUpper: 172,
  intervalPaceLower: 270, // threshold 300 * 0.90
  intervalPaceUpper: 291
};

const openEasyUpperMinutes = (seconds: number): number => seconds / openEasyZones.easyPaceLower!;

test("UTP-A01 真实 easy 开放上界不再整体丢失配速证据，也不虚构慢端", () => {
  const interval = buildSessionStructure("interval", openEasyZones)!;
  const intervalDose = assessSessionDose({ kind: "interval", structure: interval, zones: openEasyZones });
  assert.equal(intervalDose.status, "feasible", "warmup/cooldown are time goals; an open slow end must not void them");
  assert.equal(intervalDose.reasonCodes.includes("dose_pace_evidence_unavailable"), false);
  assert.equal(intervalDose.estimateSource, "zone_pace_range");

  const tempo = buildSessionStructure("tempo", openEasyZones)!;
  assert.equal(assessSessionDose({ kind: "tempo", structure: tempo, zones: openEasyZones }).status, "feasible");

  const easy = buildCompleteEasyStructure("easy", openEasyZones);
  const easyDose = assessSessionDose({ kind: "easy", structure: easy, zones: openEasyZones });
  assert.equal(easyDose.status, "feasible");
  assert.equal(easyDose.estimateSource, "zone_pace_range", "measured zone evidence must outrank the cold-start estimate");
  // A 30-minute easy run costs at most 1800 s / fastest permitted easy pace. The
  // old cold-start fallback reported exactly 5 km for every athlete.
  assert.ok(Math.abs((easyDose.distanceKm?.upper ?? 0) - openEasyUpperMinutes(1800)) < 1e-9);
  assert.notEqual(easyDose.distanceKm?.upper, 5, "5 km is the cold-start artefact, not a measured bound");
  // The slow end stays unknown rather than being filled with the fast one.
  assert.equal(easyDose.distanceKm?.lower, null);
  assert.notEqual(easyDose.distanceKm?.upper, easyDose.distanceKm?.lower);
  assert.equal(easyDose.durationSeconds?.lower, MINIMUM_SESSION_DURATION_SECONDS);
  assert.equal(easyDose.durationSeconds?.upper, MINIMUM_SESSION_DURATION_SECONDS);
});

test("UTP-A02/A03 质量课不会仅因普通 easy 格式被误拒；维度可评估性分开报告", () => {
  for (const kind of ["interval", "tempo"] as const) {
    const structure = buildSessionStructure(kind, openEasyZones)!;
    const dose = assessSessionDose({ kind, structure, zones: openEasyZones, availableSeconds: 7200 });
    // The quality session has exact work volume and a provable upper duration, so
    // the available-time constraint is proven rather than guessed.
    assert.equal(dose.status, "feasible", `${kind} must stay assessable with an open easy band`);
    assert.equal(dose.durationSeconds?.upper !== null, true);
  }

  // A distance-goal work step at an open slow pace cannot prove its upper duration:
  // that is `not_assessable`, never `exceeded` and never silently feasible.
  const distanceStructure: MobileSessionStructure = {
    warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: null },
    blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 5000 }, alert: null }] }],
    cooldown: null
  };
  const distanceDose = assessSessionDose({ kind: "long_run", structure: distanceStructure, zones: openEasyZones, availableSeconds: 3600 });
  assert.equal(distanceDose.status, "not_assessable");
  assert.deepEqual(distanceDose.reasonCodes, ["available_time_not_assessable"]);
  assert.equal(distanceDose.durationSeconds?.lower, 300 + 5000 / 1000 * openEasyZones.easyPaceLower!);
  assert.equal(distanceDose.durationSeconds?.upper, null);
  // The distance stays exact (warm-up + work), only its slow-pace duration is unknown.
  assert.ok(Math.abs((distanceDose.distanceKm?.upper ?? 0) - (300 / openEasyZones.easyPaceLower! + 5)) < 1e-9);
  assert.equal(distanceDose.distanceKm?.lower, null);
});

test("UTP-A04 冷启动估算只在没有配速证据时出现，并保持明确出处", () => {
  const structure = buildCompleteEasyStructure("easy", null);
  const cold = assessSessionDose({ kind: "easy", structure, zones: null, allowColdStartEstimate: true });
  assert.equal(cold.status, "feasible");
  assert.equal(cold.estimateSource, "cold_start_policy");
  assert.equal(cold.distanceKm?.upper, 1800 / COLD_START_ESTIMATE_SECONDS_PER_KM);
  // Cold start is a low-intensity policy only; a quality session never borrows it.
  assert.equal(assessSessionDose({ kind: "tempo", structure, zones: null, allowColdStartEstimate: true }).status, "not_assessable");
  // ... and the estimate must not be used when any zone evidence exists.
  const withEvidence = assessSessionDose({ kind: "easy", structure, zones: openEasyZones, allowColdStartEstimate: true });
  assert.equal(withEvidence.estimateSource, "zone_pace_range");
});

test("配速证据缺失侧不是 0：两个上限都必须显式为空而不是伪造数值", () => {
  const noEvidence: CoachZonePrescription = {
    easyPaceLower: null, easyPaceUpper: null, easyHrLower: null, easyHrUpper: null,
    thresholdPaceLower: null, thresholdPaceUpper: null, thresholdHrLower: null, thresholdHrUpper: null,
    intervalPaceLower: null, intervalPaceUpper: null
  };
  const structure = buildCompleteEasyStructure("easy", noEvidence);
  const dose = assessSessionDose({ kind: "easy", structure, zones: noEvidence, allowColdStartEstimate: false });
  assert.equal(dose.status, "not_assessable");
  assert.deepEqual(dose.reasonCodes, ["dose_pace_evidence_unavailable"]);
  assert.equal(dose.durationSeconds, null);
  assert.equal(dose.distanceKm, null);
});

test("单边可用配速证据仍能约束对应维度（距离目标有确切距离、时长上界未知）", () => {
  const partial: CoachZonePrescription = { ...openEasyZones, easyPaceLower: 345, easyPaceUpper: null };
  const structure: MobileSessionStructure = {
    warmup: null,
    blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "time", seconds: 1800 }, alert: null }] }],
    cooldown: null
  };
  const dose = assessSessionDose({ kind: "easy", structure, zones: partial });
  assert.equal(dose.status, "feasible");
  assert.equal(dose.durationSeconds?.lower, 1800);
  assert.equal(dose.durationSeconds?.upper, 1800);
  assert.equal(dose.distanceKm?.upper, 1800 / 345);
  assert.equal(dose.distanceKm?.lower, null);
});

// ---------------------------------------------------------------------------
// F02: per-natural-week allocation (obligations first, then candidates)
// ---------------------------------------------------------------------------

/** The production shape again, because the cost side must be the measured fast end. */
const planZones: CoachZonePrescription = {
  easyPaceLower: 345, easyPaceUpper: null, easyHrLower: 120, easyHrUpper: 150,
  thresholdPaceLower: 291, thresholdPaceUpper: 318, thresholdHrLower: 160, thresholdHrUpper: 172,
  intervalPaceLower: 270, intervalPaceUpper: 291
};

/**
 * Evaluation date 2026-10-20 (Tuesday). The natural week is 2026-10-19..2026-10-25;
 * the rolling seven-day window is 2026-10-20..2026-10-26, so 10-26 belongs to the
 * *next* natural week. That boundary is the F02 case: the old single pass allocated
 * against the current week only and never re-allocated the following week's budget.
 */
const planToday = (weekKm: number): MobileTodayResponse => ({
  today: { localDate: "2026-10-20", distanceKm: 0, durationSeconds: 0, powerWatts: null, workoutCount: 0 },
  week: { periodStart: "2026-10-19", periodEnd: "2026-10-25", distanceKm: weekKm,
    durationSeconds: weekKm * 360, workoutCount: weekKm > 0 ? 1 : 0 },
  lock: { present: false, relocked: false },
  nextSession: { kind: "easy", distanceKm: null },
  weekStructure: { qualitySessionCount: 0 },
  injuryFlags: []
} as unknown as MobileTodayResponse);

const generatePlan = (weeklyVolumeBaselineKm: number, weekKm: number) => generateWeeklyPlan({
  today: planToday(weekKm),
  goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget: null },
  weeklyVolumeBaselineKm, recentWeeklyKm: weeklyVolumeBaselineKm,
  prescription: planZones, previousWeekDistanceKm: weeklyVolumeBaselineKm
});

test("UTP-A05 跨过周日的滚动窗口：下一自然周有合法空间时必须排到课", async () => {
  // 10 km/week baseline: a complete 30-minute easy dose costs 1800/345 ≈ 5.2 km, so
  // each natural week can hold one. Before the fix 10-26 stayed rest forever because
  // the only allocation pass ran against the current week.
  const plan = await generatePlan(10, 1);
  const nextWeek = plan.days.filter(day => day.localDate >= "2026-10-26");
  assert.equal(nextWeek.length, 1);
  assert.notEqual(nextWeek[0]!.kind, "rest", "the next natural week's own 10 km budget must be usable");
  assert.equal(plan.days.some(day => day.kind !== "rest"), true);
});

test("UTP-A05 完整剂量确实装不下时保持全休，但给出明确原因而不是静默休息", async () => {
  // 5 km/week < the measured 5.217 km cost of one complete 30-minute easy session.
  // Filling the week would require inventing a slower pace or slicing the dose, so
  // the honest result is rest with an explicit reason — for BOTH natural weeks.
  const plan = await generatePlan(5, 1);
  assert.equal(plan.days.length, 7);
  assert.equal(plan.days.every(day => day.kind === "rest"), true);
  assert.equal(plan.days.every(day => (day.reason ?? "").startsWith("no_feasible_course：")), true,
    "无可行课程必须是明确结果，并带约束数字，不是「恢复差」或静默休息");
  assert.equal(plan.days.every(day => /\d+\.\d+ km/.test(day.reason ?? "")), true, "原因必须带具体公里边界");
  assert.equal(plan.days.every(day => day.distanceKm === null), true, "不得用更慢的虚构配速或切碎的里程填满");
});

test("UTP-A06 本周实际只扣本周预算：两段自然周各自净额分配，且都不超上限", async () => {
  const baseline = 15;
  const actual = 1;
  const plan = await generatePlan(baseline, actual);
  const sessions = plan.days.filter(day => day.kind !== "rest");
  const currentWeek = sessions.filter(day => day.localDate <= "2026-10-25");
  const nextWeek = sessions.filter(day => day.localDate >= "2026-10-26");
  assert.ok(currentWeek.length >= 1, "本周剩余 14 km 至少能放下一堂完整课");
  assert.ok(nextWeek.length >= 1, "下一自然周的完整 15 km 预算不得被本周实际训练吃掉");
  const currentKm = currentWeek.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  const nextKm = nextWeek.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  assert.ok(currentKm + actual <= baseline + 1e-6, `本周实际 ${actual} + 新分配 ${currentKm} 超过 ${baseline} km`);
  assert.ok(nextKm <= baseline + 1e-6, `下一周分配 ${nextKm} 超过 ${baseline} km`);
  // Every session is a complete dose, not a fragment.
  assert.equal(sessions.every(day => (day.distanceKm ?? 0) >= 5), true);
});

test("非自动生成路径不受影响：没有 allocateCompleteDoses 时仍按传入课表约束", () => {
  const proposed = [{ localDate: "2026-10-21", kind: "easy" as const, distanceKm: 5, structure: null, reason: "manual" }];
  const kept = constrainUpcomingPlan(proposed, {
    today: planToday(0),
    goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget: null },
    weeklyVolumeBaselineKm: 40, recentWeeklyKm: 40, prescription: planZones,
    previousWeekDistanceKm: 40, automaticDosePolicy: false
  });
  assert.equal(kept.find(day => day.localDate === "2026-10-21")?.kind, "easy");
  assert.equal(kept.length, 7);
});
