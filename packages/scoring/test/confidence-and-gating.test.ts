import assert from "node:assert/strict";
import test from "node:test";

import { CONFIDENCE_AGGREGATION_POLICY_VERSION, type WorkoutFeatureVector } from "@rai/contracts";

import {
  DEFAULT_CONFIDENCE_WEIGHTS_V2,
  defaultRaiModelConfig,
  evaluateConfidenceV2,
  updateTrueAbilityFromFeatureScore
} from "../src/index.js";
import { scoreFeature as scoreFeatureWithHistory, type PersonalBaseline } from "../src/model.js";

// §6.2 stratum sufficiency has its own test file. These cases are about reliability
// and gating, so they state a mature history up front instead of leaving it implicit.
const SUFFICIENT_HISTORY: Parameters<typeof scoreFeatureWithHistory>[3] = { independentSessions: 24, spanDays: 90 };
const scoreFeature = (
  feature: WorkoutFeatureVector,
  baseline: PersonalBaseline,
  maturity: number,
  config?: Parameters<typeof scoreFeatureWithHistory>[4]
) => scoreFeatureWithHistory(feature, baseline, maturity, SUFFICIENT_HISTORY, config);

// -----------------------------------------------------------------------------
// §6.7 rule-based evidence reliability, and §6.9's learning gate that consumes it.
// -----------------------------------------------------------------------------

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

test("F14: §6.7 the three rule factors combine geometrically at .60/.25/.15", () => {
  const result = evaluateConfidenceV2({
    dataConfidence: 0.9,
    comparability: 1,
    maturity: 1,
    evidenceCoverage: 1
  });
  assert.equal(result.evidenceReliability, Math.pow(0.9, 0.6));
  assert.equal(result.evidenceStatus, "available");
  // No calibration artifact exists yet, so there is nothing calibrated to report.
  assert.equal(result.modelConfidence, null);
  assert.equal(result.overall, null);
  assert.equal(result.overallStatus, "not_calibrated");
  assert.equal(result.aggregationPolicyVersion, CONFIDENCE_AGGREGATION_POLICY_VERSION);
  assert.equal(result.calibrationArtifactId, null);
  assert.equal(result.calibrationTarget, null);
});

test("F15: §6.7 a missing factor is insufficient evidence, and is not renormalised away", () => {
  const result = evaluateConfidenceV2({
    dataConfidence: 0.9,
    comparability: 1,
    maturity: null,
    evidenceCoverage: 1
  });
  assert.equal(result.evidenceReliability, null);
  assert.equal(result.evidenceStatus, "insufficient_evidence");
  assert.equal(result.overallStatus, "insufficient_evidence");
});

test("F15: §6.7 a factor of exactly zero is an observed zero, not unknown evidence", () => {
  // Must not take log(0); must not collapse into the null case either — the two
  // forbid learning for different reasons and the diagnosis has to survive.
  const result = evaluateConfidenceV2({
    dataConfidence: 0,
    comparability: 1,
    maturity: 1,
    evidenceCoverage: 1
  });
  assert.equal(result.evidenceReliability, 0);
  assert.equal(result.evidenceStatus, "available");
  assert.equal(result.overallStatus, "insufficient_evidence");
});

test("F15: §6.7 broken inputs throw rather than being clamped into a plausible number", () => {
  const valid = { dataConfidence: 0.9, comparability: 1, maturity: 1, evidenceCoverage: 1 };
  assert.throws(() => evaluateConfidenceV2({ ...valid, dataConfidence: Number.NaN }));
  assert.throws(() => evaluateConfidenceV2({ ...valid, dataConfidence: Number.POSITIVE_INFINITY }));
  assert.throws(() => evaluateConfidenceV2({ ...valid, comparability: 1.2 }));
  assert.throws(() => evaluateConfidenceV2({ ...valid, maturity: -0.1 }));
  assert.throws(() => evaluateConfidenceV2({ ...valid, evidenceCoverage: Number.NaN }));
  // Weights must be usable as a geometric mean.
  assert.throws(() => evaluateConfidenceV2({ ...valid, weights: { data: 0, comparability: 0.5, maturity: 0.5 } }));
  assert.throws(() => evaluateConfidenceV2({ ...valid, weights: { data: 0.6, comparability: 0.25, maturity: 0.25 } }));
  assert.equal(DEFAULT_CONFIDENCE_WEIGHTS_V2.data + DEFAULT_CONFIDENCE_WEIGHTS_V2.comparability + DEFAULT_CONFIDENCE_WEIGHTS_V2.maturity, 1);
});

test("§6.9: the gate reads evidenceReliability, not the legacy confidence number", () => {
  // Immature calibration: the legacy four-factor number stays above its own 0.6
  // display threshold while the new reliability sits below the 0.75 learning gate.
  // Under the old gate this workout would have moved true ability.
  const score = scoreFeature(feature({ qualityScore: 0.9 }), baseline, 0.1);
  assert.ok(score.confidence >= defaultRaiModelConfig.minimumConfidenceForTrueAbility);
  assert.ok(
    (score.confidenceV2.evidenceReliability ?? 1) < defaultRaiModelConfig.minimumEvidenceReliabilityForLearning
  );

  const update = updateTrueAbilityFromFeatureScore(40, 30, score);
  assert.equal(update.updated, false);
  assert.equal(update.nextTrueAbility, 40);
});

test("§6.9: a session whose stratum is not strong evidence cannot move true ability in either direction", () => {
  // Comparability, not reliability, is what excludes it. Intervals used to be the
  // example here; since §6.2 an interval with mature history is genuinely comparable
  // within its own work/recovery structure, so `recovery_unknown` is the case that
  // still sits below the gate.
  const unknown = scoreFeature(feature({ sessionType: "unknown" }), baseline, 1);
  assert.equal(unknown.confidenceV2.comparability, 0.8);
  assert.ok((unknown.confidenceV2.evidenceReliability ?? 0) >= defaultRaiModelConfig.minimumEvidenceReliabilityForLearning);

  // A fall and a rise are both refused, so the policy is not a one-way ratchet.
  assert.equal(updateTrueAbilityFromFeatureScore(70, 30, unknown).updated, false);
  assert.equal(updateTrueAbilityFromFeatureScore(30, 30, unknown).updated, false);
});

test("§6.9: learning scales with reliability, so better evidence moves ability further", () => {
  const good = scoreFeature(feature({ qualityScore: 1 }), baseline, 1);
  const weaker = scoreFeature(feature({ qualityScore: 0.9 }), baseline, 1);
  assert.ok(good.learningObservation !== null && weaker.learningObservation !== null);

  const strongUpdate = updateTrueAbilityFromFeatureScore(40, 30, good);
  const weakUpdate = updateTrueAbilityFromFeatureScore(40, 30, weaker);
  assert.equal(strongUpdate.updated, true);
  assert.equal(weakUpdate.updated, true);

  const strongDelta = strongUpdate.nextTrueAbility - 40;
  const weakDelta = weakUpdate.nextTrueAbility - 40;
  assert.ok(strongDelta > weakDelta, "lower reliability must move ability less");

  const expectedRatio =
    (good.confidenceV2.evidenceReliability ?? 0) / (weaker.confidenceV2.evidenceReliability ?? 1);
  assert.ok(
    Math.abs(strongDelta / weakDelta - expectedRatio) < 1e-9,
    `alpha_eff should be proportional to reliability: ${strongDelta / weakDelta} vs ${expectedRatio}`
  );
});
