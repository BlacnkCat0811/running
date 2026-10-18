import assert from "node:assert/strict";
import test from "node:test";

import { assertPhysiologyPredictionSnapshot, assertWorkoutFeatureVector, performanceResultValidationError, type PhysiologyPredictionSnapshot, type WorkoutFeatureVector } from "../src/index.js";

const snapshot = {
  schemaVersion: "physiology-prediction-v1", modelVersion: "test", generatedAt: "2026-01-01T00:00:00Z",
  dataThroughAt: null, disclaimer: "test",
  vo2Max: { status: "available", valueMlKgMin: 50, rangeMlKgMin: { lower: 48, upper: 52 }, confidence: 0.8, confidenceLevel: "high", evidenceCount: 1, latestEvidenceAt: null, method: "robust_evidence_ensemble_v1", evidenceCodes: [] },
  performanceVdot: { status: "available", value: 49, range: { lower: 47, upper: 51 }, confidence: 0.8, confidenceLevel: "high", evidenceCount: 1, latestEvidenceAt: null, method: "performance_envelope_v1", evidenceCodes: [] },
  lactateThreshold: { status: "available", paceSecondsPerKm: 250, paceRangeSecondsPerKm: { lower: 240, upper: 260 }, heartRateBpm: null, heartRateRangeBpm: null, confidence: 0.7, confidenceLevel: "moderate", evidenceCount: 1, latestEvidenceAt: null, method: "vdot_one_hour_proxy_v1", evidenceCodes: [] },
  races: [{ distance: "five_k", distanceMeters: 5000, status: "available", potentialSeconds: 1200, predictedSeconds: 1260, readinessAdjustmentSeconds: 60, environmentAdjustmentSeconds: 0, elevationAdjustmentSeconds: 0, fatigueAdjustmentSeconds: 0, calibrationAdjustmentSeconds: 0, machineLearningAdjustmentSeconds: null, machineLearningFallbackReason: "no_active_model", optimisticSeconds: 1200, pessimisticSeconds: 1320, readiness: 0.8, confidence: 0.8, confidenceLevel: "high", method: "daniels_vdot_v1", evidenceCodes: [] }]
} satisfies PhysiologyPredictionSnapshot;

test("validates complete finite physiology estimates and ordered race intervals", () => {
  assert.doesNotThrow(() => assertPhysiologyPredictionSnapshot(snapshot));
  assert.throws(() => assertPhysiologyPredictionSnapshot({ ...snapshot, races: [{ ...snapshot.races[0]!, predictedSeconds: Number.NaN }] }));
  assert.throws(() => assertPhysiologyPredictionSnapshot({ ...snapshot, races: [{ ...snapshot.races[0]!, optimisticSeconds: 1300 }] }));
  assert.throws(() => assertPhysiologyPredictionSnapshot({ ...snapshot, vo2Max: { ...snapshot.vo2Max, valueMlKgMin: null } }));
});

test("rejects invalid race adjustment and readiness values", () => {
  const race = snapshot.races[0]!;
  const adjustmentFields = [
    "readinessAdjustmentSeconds",
    "environmentAdjustmentSeconds",
    "elevationAdjustmentSeconds",
    "fatigueAdjustmentSeconds",
    "calibrationAdjustmentSeconds",
    "machineLearningAdjustmentSeconds"
  ] as const;
  for (const field of adjustmentFields) {
    assert.throws(() => assertPhysiologyPredictionSnapshot({
      ...snapshot,
      races: [{ ...race, [field]: Number.NaN }]
    }), /adjustments must be finite/);
  }
  for (const readiness of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
    assert.throws(() => assertPhysiologyPredictionSnapshot({
      ...snapshot,
      races: [{ ...race, readiness }]
    }), /readiness must be between 0 and 1/);
  }
});

test("a race prediction cannot claim readiness it never modelled (§11)", () => {
  // Mutation that turns this red: drop the two invariants — then a trace with
  // `readiness: null` and a non-zero readiness adjustment (or a readiness_v2
  // method) would pass as "the readiness was applied", which is the false trace
  // the missing-preparation fix removed.
  const race = snapshot.races[0]!;
  assert.throws(() => assertPhysiologyPredictionSnapshot({
    ...snapshot,
    races: [{ ...race, readiness: null, readinessAdjustmentSeconds: 60 }]
  }), /must not report a readiness adjustment/);
  assert.throws(() => assertPhysiologyPredictionSnapshot({
    ...snapshot,
    races: [{ ...race, readiness: null, readinessAdjustmentSeconds: null, method: "daniels_vdot_readiness_v2" }]
  }), /claims modelled readiness/);
  // The honest shapes both pass: unmodeled (null/null + vdot_v1) and modelled.
  assert.doesNotThrow(() => assertPhysiologyPredictionSnapshot({
    ...snapshot,
    races: [{ ...race, readiness: null, readinessAdjustmentSeconds: null, method: "daniels_vdot_v1" }]
  }));
  assert.doesNotThrow(() => assertPhysiologyPredictionSnapshot({
    ...snapshot,
    races: [{ ...race, readiness: 0.6, readinessAdjustmentSeconds: 40, method: "daniels_vdot_readiness_v2" }]
  }));
});


test("shared race result validation preserves inclusive duration and pace limits", () => {
  for (const [meters, seconds] of [[4800, 720], [5000, 750], [5000, 4500], [21097.5, 14400]]) {
    assert.equal(performanceResultValidationError(meters!, seconds!), null);
  }
  for (const [meters, seconds] of [[4800, 719], [21097.5, 14401], [5000, 735], [5000, 4590]]) {
    assert.notEqual(performanceResultValidationError(meters!, seconds!), null);
  }
});

test("shared race result validation rejects non-finite and non-positive inputs", () => {
  for (const meters of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5000]) {
    assert.notEqual(performanceResultValidationError(meters, 1500), null);
  }
  for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1500]) {
    assert.notEqual(performanceResultValidationError(5000, seconds), null);
  }
});

const featureVector: WorkoutFeatureVector = {
  id: "feature", featureRunId: "run", trainingSessionId: "session", canonicalWorkoutId: "workout",
  workoutStartAt: "2026-02-01T00:00:00.000Z", durationSeconds: 3600, distanceKm: 10,
  averageSpeedMetersPerSecond: 2.7, averageHeartRateBpm: 150, heartRateSampleCount: 10,
  heartRateCoverage: 0.9, routePointCount: 100, routeQuality: 0.9, sourceConfidence: 0.9,
  sessionType: "easy", sessionTypeSource: "auto", eligibilityStatus: "eligible", qualityScore: 0.9,
  missingReasons: [], signals: {
    efficiencyRaw: 0.018, paceRawMetersPerSecond: 2.7, cardioRaw: 8100, stabilityRaw: 0.9,
    recoveryRaw: null, heartRateReserveFraction: 0.6, heartRateCoefficientOfVariation: 0.05,
    speedCoefficientOfVariation: 0.05, sleepDurationMinutes: null, restingHeartRateBpm: null,
    hrvSdnnMs: null, recentLoadMinutes: null
  },
  provenance: { featureConfigVersion: "test" }, computedAt: "2026-02-02T00:00:00.000Z"
};

test("the feature-vector contract rejects NaN/Infinity/dates its previous checks let through", () => {
  // Mutation that turns this red: restore the old `value < 0 || value > 1` comparisons
  // (NaN passes both) or drop the optional-number/date checks, letting a corrupt
  // parser value reach scoring with a stack trace from an unrelated assert.
  assert.doesNotThrow(() => assertWorkoutFeatureVector(featureVector));
  const rejected: Array<[string, (feature: WorkoutFeatureVector) => void]> = [
    ["NaN qualityScore", (f) => { f.qualityScore = Number.NaN; }],
    ["NaN heartRateCoverage", (f) => { f.heartRateCoverage = Number.NaN; }],
    ["NaN sourceConfidence", (f) => { f.sourceConfidence = Number.NaN; }],
    ["Infinity distanceKm", (f) => { f.distanceKm = Number.POSITIVE_INFINITY; }],
    ["NaN speed", (f) => { f.averageSpeedMetersPerSecond = Number.NaN; }],
    ["Infinity averageHeartRate", (f) => { f.averageHeartRateBpm = Number.POSITIVE_INFINITY; }],
    ["NaN routeQuality", (f) => { f.routeQuality = Number.NaN; }],
    ["fractional sample count", (f) => { f.heartRateSampleCount = 1.5; }],
    ["negative route points", (f) => { f.routePointCount = -1; }],
    ["unparseable workoutStartAt", (f) => { f.workoutStartAt = "nope"; }],
    ["unparseable computedAt", (f) => { f.computedAt = ""; }],
    ["unknown session type", (f) => { (f as { sessionType: string }).sessionType = "ultra"; }],
    ["invalid eligibility", (f) => { (f as { eligibilityStatus: string }).eligibilityStatus = "maybe"; }],
    ["NaN signal", (f) => { f.signals.stabilityRaw = Number.NaN; }]
  ];
  for (const [label, mutate] of rejected) {
    const copy = structuredClone(featureVector);
    mutate(copy);
    assert.throws(() => assertWorkoutFeatureVector(copy), label);
  }
});
