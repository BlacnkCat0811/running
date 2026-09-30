import assert from "node:assert/strict";
import test from "node:test";

import type { WorkoutFeatureVector } from "@rai/contracts";

import { baseLearningRate } from "../src/index.js";
import { updateTrueAbilityFromFeatureScore, type PersonalBaseline } from "../src/model.js";
import { scoreFeature as scoreFeatureWithHistory } from "../src/model.js";

// §6.2 stratum sufficiency has its own test file. These cases are about recovery
// isolation, so they state a mature history up front.
const SUFFICIENT_HISTORY: Parameters<typeof scoreFeatureWithHistory>[3] = { independentSessions: 24, spanDays: 90 };
const scoreFeature = (
  feature: WorkoutFeatureVector,
  baseline: PersonalBaseline,
  maturity: number,
  config?: Parameters<typeof scoreFeatureWithHistory>[4]
) => scoreFeatureWithHistory(feature, baseline, maturity, SUFFICIENT_HISTORY, config);

const baseline: PersonalBaseline = {
  calibrationFeatureIds: ["calibration"],
  calibrationStartAt: "2026-01-01T00:00:00.000Z",
  calibrationEndAt: "2026-01-15T00:00:00.000Z",
  dimensions: {
    efficiency: { center: 0.02, scale: 0.002 },
    pace: { center: 3, scale: 0.3 },
    stability: { center: 0.8, scale: 0.1 },
    recovery: { center: 0.7, scale: 0.1 }
  }
};

const feature = (overrides: Partial<WorkoutFeatureVector["signals"]> = {}): WorkoutFeatureVector => ({
  id: "feature",
  featureRunId: "run",
  trainingSessionId: "session",
  canonicalWorkoutId: "workout",
  workoutStartAt: "2026-02-01T00:00:00.000Z",
  durationSeconds: 3600,
  distanceKm: 10,
  averageSpeedMetersPerSecond: 3,
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
    paceRawMetersPerSecond: 3.3,
    cardioRaw: 198,
    stabilityRaw: 0.85,
    recoveryRaw: 0.75,
    heartRateReserveFraction: 0.7,
    heartRateCoefficientOfVariation: 0.04,
    speedCoefficientOfVariation: 0.04,
    sleepDurationMinutes: 480,
    restingHeartRateBpm: 50,
    hrvSdnnMs: 60,
    recentLoadMinutes: 180,
    ...overrides
  },
  provenance: {},
  computedAt: "2026-02-01T01:00:00.000Z"
});

test("current ability is identical when only recovery inputs change", () => {
  const good = scoreFeature(feature({ recoveryRaw: 0.85, restingHeartRateBpm: 48, hrvSdnnMs: 70, sleepDurationMinutes: 500 }), baseline, 1);
  const bad = scoreFeature(feature({ recoveryRaw: 0.31, restingHeartRateBpm: 62, hrvSdnnMs: 30, sleepDurationMinutes: 250 }), baseline, 1);

  assert.equal(good.status, "eligible");
  assert.equal(bad.status, "eligible");

  // The recovery dimension itself is expected to move — it is still computed and
  // still displayed. What must not move is anything current ability is built from.
  assert.notEqual(good.dimensions.recovery, bad.dimensions.recovery);

  assert.equal(good.currentAbility, bad.currentAbility);
  assert.equal(good.confidence, bad.confidence);
  assert.deepEqual(good.confidenceFactors, bad.confidenceFactors);
  assert.deepEqual(good.effectiveWeights, bad.effectiveWeights);
  assert.equal(good.evidenceStrength, bad.evidenceStrength);
  assert.deepEqual(good.dimensions.efficiency, bad.dimensions.efficiency);
  assert.deepEqual(good.dimensions.pace, bad.dimensions.pace);
  assert.deepEqual(good.dimensions.stability, bad.dimensions.stability);
});

test("true ability and the update decision are identical when only recovery inputs change", () => {
  const good = scoreFeature(feature({ recoveryRaw: 0.85, restingHeartRateBpm: 48, hrvSdnnMs: 70, sleepDurationMinutes: 500 }), baseline, 1);
  const bad = scoreFeature(feature({ recoveryRaw: 0.31, restingHeartRateBpm: 62, hrvSdnnMs: 30, sleepDurationMinutes: 250 }), baseline, 1);

  for (const trueAbility of [70, 40]) {
    for (const eligibleWorkoutCount of [5, 12, 40]) {
      const goodUpdate = updateTrueAbilityFromFeatureScore(trueAbility, eligibleWorkoutCount, good);
      const badUpdate = updateTrueAbilityFromFeatureScore(trueAbility, eligibleWorkoutCount, bad);
      assert.deepEqual(
        badUpdate,
        goodUpdate,
        `TA update differed at trueAbility=${trueAbility}, n=${eligibleWorkoutCount}`
      );
    }
  }
});

test("recovery no longer modulates how fast a negative residual is accepted", () => {
  // Previously a recovery dimension below 40 cut the negative direction factor to
  // 0.25, so today's sleep/HRV/RHR decided how quickly TA could fall. §6.9 then
  // removed the direction factor from the alpha composition entirely, so the step is
  // alpha(N) * evidenceReliability * evidenceStrength * residual, with growthResistance
  // applied to positives only. Asserting the formula rather than a retired constant is
  // what keeps this test meaningful if the composition is edited again.
  const low = scoreFeature(feature({ recoveryRaw: 0.1 }), baseline, 1);
  // One confirmation pending, so the K-count gate is satisfied and the step applies.
  const update = updateTrueAbilityFromFeatureScore(80, 40, low, undefined, 1);
  assert.equal(update.updated, true);
  assert.equal(update.directionFactor, 1);

  const observation = low.learningObservation;
  assert.ok(observation !== null && observation < 80, "the fixture must produce a decline");
  const residual = Math.max(-12, Math.min(12, observation - 80));
  const alpha =
    baseLearningRate(40) * (low.confidenceV2.evidenceReliability ?? NaN) * (low.evidenceStrength ?? NaN);
  const expected = Math.max(0, Math.min(100, 80 + alpha * residual));
  assert.ok(
    Math.abs(update.nextTrueAbility - expected) < 1e-9,
    `negative step is not the documented alpha: got ${update.nextTrueAbility}, expected ${expected}`
  );
  // A discount on the negative side would land well above this: 0.4 would give
  // 80 + 0.4 * alpha * residual.
  assert.ok(update.nextTrueAbility < 80);

  // A positive residual keeps the unmodified rate through growthResistance, which
  // §6.9 keeps for positives only.
  const positive = updateTrueAbilityFromFeatureScore(20, 40, low);
  assert.equal(positive.directionFactor, 1);
});

test("recovery is absent from the weights current ability actually uses", () => {
  const score = scoreFeature(feature(), baseline, 1);
  assert.equal(score.effectiveWeights.recovery, undefined);
  // Still reported for display, so the app can explain a bad night without it
  // being an ability judgement.
  assert.notEqual(score.dimensions.recovery, null);
});

test("recovery explanation codes still move, and that is a decision rather than an oversight", () => {
  // `recovery_low` / `recovery_high` are pushed without the zero-weight guard the
  // other dimension explanations have. That is intentional: they explain a night,
  // not an ability change. Pinned here so it cannot drift into an ability claim
  // unnoticed — and so that removing them is a conscious change.
  const good = scoreFeature(feature({ recoveryRaw: 0.9 }), baseline, 1);
  const bad = scoreFeature(feature({ recoveryRaw: 0.1 }), baseline, 1);
  assert.ok(bad.explanationCodes.includes("recovery_low"));
  assert.ok(good.explanationCodes.includes("recovery_high"));
  // What must NOT move is anything the ability numbers are built from.
  assert.equal(good.currentAbility, bad.currentAbility);
  assert.equal(good.evidenceStrength, bad.evidenceStrength);
  assert.deepEqual(good.effectiveWeights, bad.effectiveWeights);
});
