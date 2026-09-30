import assert from "node:assert/strict";
import test from "node:test";

import type { WorkoutFeatureVector } from "@rai/contracts";

import { defaultRaiModelConfig, scoreFeature, updateTrueAbilityFromFeatureScore, type PersonalBaseline } from "../src/index.js";

/**
 * §6.9-7 的可诊断性。
 *
 * 文档要求"有充分合格负机会却长期 0 接受"必须阻断发布并**复查/放宽非必要门槛**。
 * 要做到"复查"，报告必须能回答**卡在哪一道门**上；如果所有拒绝都只报一句
 * `updated: false`，那么"证据不够格"与"证据够了但还差一次确认"就完全无法区分，
 * 而这两者对应的处置是相反的（前者要改数据/门槛，后者只要再等一次训练）。
 *
 * 本文件钉的是**归因**，不是阈值本身 —— 阈值仍只有 `updateTrueAbilityFromFeatureScore` 一处实现。
 */

const HISTORY: Parameters<typeof scoreFeature>[3] = { independentSessions: 24, spanDays: 90 };
const MATURE = { independentSessions: 24, spanDays: 90 } as const;

const baseline: PersonalBaseline = {
  calibrationFeatureIds: ["calibration"],
  calibrationStartAt: "2026-01-01T00:00:00.000Z",
  calibrationEndAt: "2026-01-15T00:00:00.000Z",
  dimensions: {
    efficiency: { center: 0.02, scale: 0.002 },
    pace: { center: 2.8, scale: 0.3 },
    stability: { center: 0.8, scale: 0.1 }
  }
};

/** 三个维度都在 z = +1 ⇒ 观测表现 60，对 TA=70 而言是一次"变差"。 */
const feature = (overrides: Partial<WorkoutFeatureVector> = {}): WorkoutFeatureVector => ({
  id: "feature",
  featureRunId: "run",
  trainingSessionId: "session",
  canonicalWorkoutId: "workout",
  workoutStartAt: "2026-02-01T00:00:00.000Z",
  durationSeconds: 3600,
  distanceKm: 10,
  averageSpeedMetersPerSecond: 2.8,
  averageHeartRateBpm: 150,
  heartRateSampleCount: 120,
  heartRateCoverage: 1,
  routePointCount: 100,
  routeQuality: 1,
  sourceConfidence: 1,
  sessionType: "steady",
  sessionTypeSource: "auto",
  eligibilityStatus: "eligible",
  qualityScore: 1,
  missingReasons: [],
  signals: {
    efficiencyRaw: 0.022,
    paceRawMetersPerSecond: 3.1,
    cardioRaw: null,
    stabilityRaw: 0.9,
    recoveryRaw: 0.75,
    heartRateReserveFraction: 0.7,
    heartRateCoefficientOfVariation: 0.04,
    speedCoefficientOfVariation: 0.04,
    sleepDurationMinutes: 480,
    restingHeartRateBpm: 50,
    hrvSdnnMs: 60,
    recentLoadMinutes: 180
  },
  provenance: {},
  computedAt: "2026-02-01T01:00:00.000Z",
  ...overrides
});

const update = (overrides: Partial<WorkoutFeatureVector> = {}, pending = 0) =>
  updateTrueAbilityFromFeatureScore(
    70,
    30,
    scoreFeature(feature(overrides), baseline, 1, HISTORY),
    defaultRaiModelConfig,
    pending
  );

test("awaiting_negative_confirmation is not the same finding as insufficient evidence", () => {
  // 健康的一次退步观测：证据完全够格，只是还差一次确认。
  const first = update();
  assert.equal(first.refusalReason, "awaiting_negative_confirmation");
  assert.equal(first.updated, false);
  assert.equal(first.pendingNegativeConfirmations, 1);

  // 证据不够格：必须报出具体是哪一项，而不是笼统的"没更新"。
  assert.equal(update({ qualityScore: 0.3 }).refusalReason, "reliability_below_learning_minimum");
  assert.equal(update({ sessionType: "unknown" }).refusalReason, "comparability_below_learning_minimum");
});

test("an applied update reports no refusal", () => {
  const applied = update({}, 1);
  assert.equal(applied.updated, true);
  assert.ok(applied.nextTrueAbility < 70);
  assert.equal(applied.refusalReason, null);
});

test("refusal reasons stay distinguishable for eligibility and coverage", () => {
  assert.equal(update({ eligibilityStatus: "trial" }).refusalReason, "not_eligible");
  assert.equal(update({ eligibilityStatus: "excluded" }).refusalReason, "not_eligible");
});

test("the refusal taxonomy is closed and every reason is reachable-or-explicit", () => {
  // 归类而不是重算阈值：这里只要求"给出归因时不能是别的字符串"。
  const reasons = new Set([
    update().refusalReason,
    update({ qualityScore: 0.3 }).refusalReason,
    update({ sessionType: "unknown" }).refusalReason,
    update({ eligibilityStatus: "excluded" }).refusalReason,
    update({}, 1).refusalReason
  ]);
  assert.deepEqual([...reasons].sort(), [
    "awaiting_negative_confirmation",
    "comparability_below_learning_minimum",
    "not_eligible",
    null,
    "reliability_below_learning_minimum"
  ].sort());
  assert.equal(MATURE.independentSessions, HISTORY.independentSessions);
});
