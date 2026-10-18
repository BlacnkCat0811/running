import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateRacePredictionErrors,
  applyRaceResidualRidge,
  buildRaceMlFeatures,
  buildPhysiologyPredictionSnapshot,
  calibrateRacePrediction,
  estimateLactateThreshold,
  estimateLactateThresholdFromEvidence,
  estimateLactateThresholdFromPerformanceVdot,
  estimatePerformanceVdot,
  estimateVo2Max,
  evaluateRacePrediction,
  fitRaceResidualRidge,
  performanceEvidence,
  performanceVdotEvidence,
  performanceSecondsFromVdot,
  predictRaceTimes,
  UNMODELED_READINESS_CONFIDENCE_PRIOR,
  type PredictionReadiness,
  vdotFromPerformance
} from "../src/index.js";

test("P01: Daniels VDOT matches a representative 20-minute 5K and round-trips", () => {
  const vdot = vdotFromPerformance(5_000, 20 * 60);
  assert.ok(vdot > 49 && vdot < 51);
  assert.ok(Math.abs(performanceSecondsFromVdot(5_000, vdot) - 20 * 60) < 0.01);
});

test("higher aerobic capacity predicts faster race times", () => {
  const common = {
    status: "available" as const,
    rangeMlKgMin: null,
    confidence: 0.8,
    confidenceLevel: "high" as const,
    evidenceCount: 3,
    latestEvidenceAt: "2026-01-01T00:00:00.000Z",
    method: "robust_evidence_ensemble_v1" as const,
    evidenceCodes: []
  };
  const slower = predictRaceTimes({ ...common, valueMlKgMin: 40 });
  const faster = predictRaceTimes({ ...common, valueMlKgMin: 50 });
  assert.ok((faster[0]?.predictedSeconds ?? Infinity) < (slower[0]?.predictedSeconds ?? 0));
});

test("distance readiness slows the point prediction while preserving potential", () => {
  const estimate = {
    status: "available" as const,
    valueMlKgMin: 42,
    rangeMlKgMin: { lower: 40, upper: 44 },
    confidence: 0.7,
    confidenceLevel: "moderate" as const,
    evidenceCount: 3,
    latestEvidenceAt: "2026-01-01T00:00:00.000Z",
    method: "robust_evidence_ensemble_v1" as const,
    evidenceCodes: []
  };
  const ready = predictRaceTimes(estimate, { half_marathon: 1 })[2];
  const underprepared = predictRaceTimes(estimate, { half_marathon: 0.2 })[2];
  assert.ok(ready && underprepared);
  assert.ok((underprepared.predictedSeconds ?? 0) > (ready.predictedSeconds ?? Infinity));
  assert.equal(ready.potentialSeconds, ready.predictedSeconds);
  assert.ok((underprepared.readinessAdjustmentSeconds ?? 0) > 0);
  assert.equal(underprepared.method, "daniels_vdot_readiness_v2");
});

test("VO2max ensemble excludes future evidence and limits an outlier", () => {
  const estimate = estimateVo2Max(
    [
      { id: "a", observedAt: "2026-01-01T00:00:00.000Z", valueMlKgMin: 43, source: "apple_health", quality: 1 },
      { id: "b", observedAt: "2026-01-10T00:00:00.000Z", valueMlKgMin: 44, source: "apple_health", quality: 1 },
      { id: "c", observedAt: "2026-01-15T00:00:00.000Z", valueMlKgMin: 80, source: "hard_workout", quality: 0.5 },
      { id: "future", observedAt: "2027-01-01T00:00:00.000Z", valueMlKgMin: 70, source: "race", quality: 1 }
    ],
    "2026-02-01T00:00:00.000Z"
  );
  assert.equal(estimate.status, "available");
  assert.ok((estimate.valueMlKgMin ?? 0) > 42 && (estimate.valueMlKgMin ?? 99) < 48);
  assert.ok(estimate.evidenceCodes.includes("future_evidence_excluded"));
});

test("selects latest physiology evidence by instant across mixed offsets", () => {
  const estimate = estimateVo2Max(
    [
      { id: "older", observedAt: "2026-01-01T10:00:00+10:00", valueMlKgMin: 44, source: "apple_health", quality: 1 },
      { id: "newer", observedAt: "2026-01-01T02:00:00+00:00", valueMlKgMin: 45, source: "hard_workout", quality: 1 }
    ],
    "2026-01-02T00:00:00.000Z"
  );

  assert.equal(estimate.latestEvidenceAt, "2026-01-01T02:00:00+00:00");

  const performance = estimatePerformanceVdot(
    estimate,
    [
      { id: "performance-older", observedAt: "2026-01-02T10:00:00+10:00", value: 44, source: "training_envelope", quality: 1 },
      { id: "performance-newer", observedAt: "2026-01-02T02:00:00+00:00", value: 45, source: "race", quality: 1 }
    ],
    "2026-01-03T00:00:00.000Z"
  );
  assert.equal(performance.latestEvidenceAt, "2026-01-02T02:00:00+00:00");

  const olderVo2 = estimateVo2Max(
    [{ id: "vo2-prior", observedAt: "2026-01-03T10:00:00+10:00", valueMlKgMin: 45, source: "apple_health", quality: 1 }],
    "2026-01-04T00:00:00.000Z"
  );
  const threshold = estimateLactateThresholdFromEvidence(
    olderVo2,
    { restingHeartRateBpm: 60, observedMaximumHeartRateBpm: 195 },
    [{
      id: "threshold-newer",
      observedAt: "2026-01-03T02:00:00+00:00",
      paceSecondsPerKm: 300,
      heartRateBpm: 175,
      durationSeconds: 1_500,
      source: "threshold_test",
      quality: 1
    }],
    "2026-01-04T00:00:00.000Z"
  );
  assert.equal(threshold.latestEvidenceAt, "2026-01-03T02:00:00+00:00");
});

test("repeated evidence from one device remains moderate confidence", () => {
  const evidence = Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    observedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    valueMlKgMin: 44 + (index % 2) * 0.2,
    source: "apple_health" as const,
    quality: 1
  }));
  const estimate = estimateVo2Max(evidence, "2026-02-01T00:00:00.000Z");
  assert.equal(estimate.confidenceLevel, "moderate");
  assert.ok((estimate.rangeMlKgMin?.upper ?? 0) - (estimate.rangeMlKgMin?.lower ?? 0) >= 4);
  assert.ok(!estimate.evidenceCodes.includes("stale_evidence"));
});

test("performance observations become VDOT evidence", () => {
  const evidence = performanceEvidence({
    id: "race-5k",
    observedAt: "2026-01-01T00:00:00.000Z",
    distanceMeters: 5_000,
    durationSeconds: 20 * 60,
    source: "race",
    quality: 1
  });
  assert.equal(evidence.source, "race");
  assert.ok(evidence.valueMlKgMin > 49 && evidence.valueMlKgMin < 51);
});

test("performance VDOT stays separate from physiological VO2max", () => {
  const vo2 = estimateVo2Max(
    [
      { id: "a", observedAt: "2026-01-01T00:00:00.000Z", valueMlKgMin: 45, source: "apple_health", quality: 1 },
      { id: "b", observedAt: "2026-01-02T00:00:00.000Z", valueMlKgMin: 45, source: "apple_health", quality: 1 }
    ],
    "2026-02-01T00:00:00.000Z"
  );
  const performance = estimatePerformanceVdot(
    vo2,
    [
      { id: "p1", observedAt: "2026-01-10T00:00:00.000Z", value: 38, source: "training_envelope", quality: 0.6 },
      { id: "p2", observedAt: "2026-01-15T00:00:00.000Z", value: 39, source: "training_envelope", quality: 0.6 },
      { id: "p3", observedAt: "2026-01-20T00:00:00.000Z", value: 40, source: "training_envelope", quality: 0.6 }
    ],
    "2026-02-01T00:00:00.000Z"
  );
  assert.equal(performance.status, "available");
  assert.ok((performance.value ?? 0) < (vo2.valueMlKgMin ?? 0));
  assert.ok(performance.evidenceCodes.includes("training_performance_envelope"));
});

test("performance VDOT evidence uses the same reversible performance formula", () => {
  const evidence = performanceVdotEvidence({
    id: "five-k",
    observedAt: "2026-01-01T00:00:00.000Z",
    distanceMeters: 5_000,
    durationSeconds: 20 * 60,
    source: "standard_test",
    quality: 1
  });
  assert.ok(evidence.value > 49 && evidence.value < 51);
});

test("hot humid and hilly performances are normalized before deriving VDOT", () => {
  const raw = performanceVdotEvidence({
    id: "raw",
    observedAt: "2026-01-01T00:00:00.000Z",
    distanceMeters: 10_000,
    durationSeconds: 50 * 60,
    source: "training_envelope",
    quality: 0.6
  });
  const normalized = performanceVdotEvidence({
    id: "normalized",
    observedAt: "2026-01-01T00:00:00.000Z",
    distanceMeters: 10_000,
    durationSeconds: 50 * 60,
    source: "training_envelope",
    quality: 0.6,
    conditions: {
      temperatureC: 30,
      humidityPercent: 80,
      elevationGainMeters: 150
    }
  });
  assert.ok(normalized.value > raw.value);
  assert.ok((normalized.conditionPenaltyFraction ?? 0) > 0);
});

test("race scenarios expose separate environment, elevation, and fatigue adjustments", () => {
  const estimate = {
    status: "available" as const,
    valueMlKgMin: 42,
    rangeMlKgMin: { lower: 40, upper: 44 },
    confidence: 0.7,
    confidenceLevel: "moderate" as const,
    evidenceCount: 3,
    latestEvidenceAt: "2026-01-01T00:00:00.000Z",
    method: "robust_evidence_ensemble_v1" as const,
    evidenceCodes: []
  };
  const standard = predictRaceTimes(estimate, { ten_k: 1 })[1];
  const difficult = predictRaceTimes(
    estimate,
    { ten_k: 1 },
    undefined,
    {
      temperatureC: 30,
      humidityPercent: 80,
      recoveryReadiness: 0.5,
      elevationGainMeters: { ten_k: 150 }
    }
  )[1];
  assert.ok(standard && difficult);
  assert.ok((difficult.predictedSeconds ?? 0) > (standard.predictedSeconds ?? Infinity));
  assert.ok((difficult.environmentAdjustmentSeconds ?? 0) > 0);
  assert.ok((difficult.elevationAdjustmentSeconds ?? 0) > 0);
  assert.ok((difficult.fatigueAdjustmentSeconds ?? 0) > 0);
  assert.equal(difficult.method, "daniels_vdot_conditions_v3");
});

test("§11: missing preparation readiness is unmodeled and neutral — it is never a default penalty", () => {
  // Mutation that turns this red: restore `readiness[distance] ?? defaultRaceReadiness[distance]`
  // (0.7 / 0.6 / 0.45), which penalised the runner whose preparation we could not see.
  const estimate = {
    status: "available" as const,
    valueMlKgMin: 50,
    rangeMlKgMin: { lower: 48, upper: 52 },
    confidence: 0.8,
    confidenceLevel: "moderate" as const,
    evidenceCount: 3,
    latestEvidenceAt: "2026-01-01T00:00:00.000Z",
    method: "robust_evidence_ensemble_v1" as const,
    evidenceCodes: []
  };
  const neutral = predictRaceTimes(estimate, { five_k: 1, ten_k: 1, half_marathon: 1 });
  const missing = predictRaceTimes(estimate, {});
  // `PredictionReadiness` types the values as numeric, but a caller that cleans a
  // partial record can still hand us `null` at runtime; the predictor must treat it
  // exactly like an absent key rather than falling into a default penalty.
  const explicitNull = predictRaceTimes(
    estimate,
    { five_k: null, ten_k: null, half_marathon: null } as unknown as PredictionReadiness
  );
  for (const [index, prediction] of missing.entries()) {
    const reference = neutral[index]!;
    assert.ok(prediction);
    assert.equal(prediction.predictedSeconds, reference.predictedSeconds, `${prediction.distance}: unknown readiness must not slow the prediction`);
    assert.equal(prediction.readiness, null);
    assert.equal(prediction.readinessAdjustmentSeconds, null);
    assert.equal(prediction.method, "daniels_vdot_v1");
    assert.ok(prediction.evidenceCodes.includes("endurance_readiness_unmodeled"));
    assert.ok(!prediction.evidenceCodes.includes("race_readiness_applied"));
    // An explicit null is the same statement as an absent key: unknown, not "applied".
    assert.deepEqual(explicitNull[index], prediction);
    // Point estimate stays neutral, but confidence must not pretend the missing
    // preparation was observed: it uses the documented maximum-uncertainty prior.
    const expectedConfidence = Math.min(0.95, estimate.confidence *
      (0.55 + 0.45 * UNMODELED_READINESS_CONFIDENCE_PRIOR));
    assert.ok(Math.abs(prediction.confidence - expectedConfidence) < 1e-12,
      `${prediction.distance}: unmodeled readiness must use the confidence prior, got ${prediction.confidence}`);
    assert.ok(prediction.confidence < reference.confidence,
      `${prediction.distance}: unknown preparation cannot be more confident than fully-ready`);
  }
  // A supplied value is still modelled, penalised and labelled as such.
  const low = predictRaceTimes(estimate, { ten_k: 0.6 })[1]!;
  assert.ok((low.predictedSeconds ?? 0) > missing[1]!.predictedSeconds!);
  assert.equal(low.readiness, 0.6);
  assert.ok((low.readinessAdjustmentSeconds ?? 0) > 0);
  assert.equal(low.method, "daniels_vdot_readiness_v2");
  assert.ok(low.evidenceCodes.includes("race_readiness_applied"));
  // A supplied value keeps the original confidence formula; the prior is only for
  // "not modelled", and it is deliberately lower than this 0.6 readiness.
  assert.ok(Math.abs(low.confidence - estimate.confidence * (0.55 + 0.45 * 0.6)) < 1e-12);
  assert.ok(missing[1]!.confidence < low.confidence);
  // A non-finite value is not silently clamped into a modelled readiness.
  const broken = predictRaceTimes(estimate, { ten_k: Number.NaN })[1]!;
  assert.equal(broken.readiness, null);
  assert.equal(broken.readinessAdjustmentSeconds, null);
  assert.ok(broken.evidenceCodes.includes("endurance_readiness_unmodeled"));
});

test("lactate threshold exposes one-hour pace and heart-rate uncertainty", () => {
  const vo2 = estimateVo2Max(
    [
      { id: "a", observedAt: "2026-01-01T00:00:00.000Z", valueMlKgMin: 45, source: "apple_health", quality: 1 },
      { id: "b", observedAt: "2026-01-02T00:00:00.000Z", valueMlKgMin: 45.5, source: "apple_health", quality: 1 },
      { id: "c", observedAt: "2026-01-03T00:00:00.000Z", valueMlKgMin: 44.5, source: "apple_health", quality: 1 }
    ],
    "2026-01-04T00:00:00.000Z"
  );
  const threshold = estimateLactateThreshold(vo2, {
    restingHeartRateBpm: 60,
    observedMaximumHeartRateBpm: 195
  });
  assert.equal(threshold.status, "available");
  assert.ok((threshold.paceSecondsPerKm ?? 0) > 240);
  assert.ok((threshold.heartRateBpm ?? 0) > 170);
  assert.ok((threshold.heartRateRangeBpm?.upper ?? 0) > (threshold.heartRateRangeBpm?.lower ?? 0));
});

test("sustained threshold segments calibrate the VO2 prior without accepting future data", () => {
  const vo2 = estimateVo2Max(
    [
      { id: "a", observedAt: "2026-01-01T00:00:00.000Z", valueMlKgMin: 45, source: "apple_health", quality: 1 },
      { id: "b", observedAt: "2026-01-02T00:00:00.000Z", valueMlKgMin: 45, source: "apple_health", quality: 1 }
    ],
    "2026-02-01T00:00:00.000Z"
  );
  const prior = estimateLactateThreshold(vo2, {
    restingHeartRateBpm: 60,
    observedMaximumHeartRateBpm: 195
  });
  const calibrated = estimateLactateThresholdFromEvidence(
    vo2,
    { restingHeartRateBpm: 60, observedMaximumHeartRateBpm: 195 },
    [
      { id: "segment", observedAt: "2026-01-20T00:00:00.000Z", paceSecondsPerKm: 300, heartRateBpm: 175, durationSeconds: 1_500, source: "threshold_test", quality: 0.95 },
      { id: "future", observedAt: "2027-01-20T00:00:00.000Z", paceSecondsPerKm: 200, heartRateBpm: 200, durationSeconds: 1_500, source: "race_segment", quality: 1 }
    ],
    "2026-02-01T00:00:00.000Z"
  );
  assert.equal(calibrated.method, "multi_evidence_threshold_v2");
  assert.ok((calibrated.paceSecondsPerKm ?? 0) > (prior.paceSecondsPerKm ?? 0));
  assert.ok(calibrated.evidenceCodes.includes("threshold_test_segment"));
  assert.ok(calibrated.evidenceCodes.includes("future_evidence_excluded"));
});

test("threshold cursor advances when newer performance VDOT changes an existing segment-calibrated prior", () => {
  const performance = {
    status: "available" as const,
    value: 50,
    range: { lower: 48, upper: 52 },
    confidence: 0.8,
    confidenceLevel: "high" as const,
    evidenceCount: 2,
    latestEvidenceAt: "2026-01-25T00:00:00.000Z",
    method: "performance_envelope_v1" as const,
    evidenceCodes: []
  };
  const threshold = estimateLactateThresholdFromPerformanceVdot(
    performance,
    { restingHeartRateBpm: 60, observedMaximumHeartRateBpm: 195 },
    [{
      id: "older-segment",
      observedAt: "2026-01-20T00:00:00.000Z",
      paceSecondsPerKm: 300,
      heartRateBpm: 175,
      durationSeconds: 1_500,
      source: "threshold_test",
      quality: 0.95
    }],
    "2026-02-01T00:00:00.000Z"
  );

  assert.equal(threshold.latestEvidenceAt, performance.latestEvidenceAt);
  assert.equal(threshold.evidenceCount, 2);
});

test("snapshot stays unavailable without valid evidence", () => {
  const snapshot = buildPhysiologyPredictionSnapshot({
    evidence: [],
    profile: { restingHeartRateBpm: null, observedMaximumHeartRateBpm: null },
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(snapshot.vo2Max.status, "insufficient_data");
  assert.equal(snapshot.performanceVdot.status, "insufficient_data");
  assert.ok(snapshot.races.every((prediction) => prediction.status === "insufficient_data"));
});

test("invalid performance inputs are rejected", () => {
  assert.throws(() => vdotFromPerformance(0, 1), /distanceMeters/);
  assert.throws(() => performanceSecondsFromVdot(5_000, 0), /vdot/);
});

test("rejects positive velocities below the Daniels running domain", () => {
  assert.throws(() => vdotFromPerformance(100, 60 * 60), /Daniels running domain/);
});

test("race prediction errors report bias, MAE, RMSE, MAPE, and interval coverage", () => {
  const prediction = predictRaceTimes({
    status: "available",
    valueMlKgMin: 45,
    rangeMlKgMin: { lower: 42, upper: 48 },
    confidence: 0.7,
    confidenceLevel: "moderate",
    evidenceCount: 4,
    latestEvidenceAt: "2026-01-01T00:00:00.000Z",
    method: "robust_evidence_ensemble_v1",
    evidenceCodes: []
  })[0];
  assert.ok(prediction);
  const error = evaluateRacePrediction(
    prediction,
    prediction.predictedSeconds! + 30,
    "2026-02-01T01:00:00.000Z",
    "2026-02-01T00:00:00.000Z"
  );
  const metrics = aggregateRacePredictionErrors([error]);
  assert.equal(metrics.sampleCount, 1);
  assert.equal(metrics.meanAbsoluteErrorSeconds, 30);
  assert.equal(metrics.rootMeanSquaredErrorSeconds, 30);
  assert.equal(metrics.meanSignedErrorSeconds, -30);
  assert.ok((metrics.meanAbsolutePercentageError ?? 0) > 0);
});

test("walk-forward calibration learns only from outcomes available before prediction", () => {
  const base = predictRaceTimes({
    status: "available",
    valueMlKgMin: 42,
    rangeMlKgMin: { lower: 40, upper: 44 },
    confidence: 0.6,
    confidenceLevel: "moderate",
    evidenceCount: 3,
    latestEvidenceAt: "2026-01-01T00:00:00.000Z",
    method: "robust_evidence_ensemble_v1",
    evidenceCodes: []
  }, { five_k: 1 })[0];
  assert.ok(base?.predictedSeconds);
  const prior = [1, 2, 3].map((day) => evaluateRacePrediction(
    base!,
    base!.predictedSeconds! + 60,
    `2026-01-0${day}T01:00:00.000Z`,
    `2026-01-0${day}T00:00:00.000Z`
  ));
  const future = evaluateRacePrediction(
    base!,
    base!.predictedSeconds! - 300,
    "2027-01-01T01:00:00.000Z",
    "2027-01-01T00:00:00.000Z"
  );
  const calibrated = calibrateRacePrediction(
    base!,
    "2026-02-01T00:00:00.000Z",
    [...prior, future]
  );
  assert.equal(calibrated.method, "bias_calibrated_v4");
  assert.ok(Math.abs((calibrated.calibrationAdjustmentSeconds ?? 0) - 60) < 0.001);
  assert.ok((calibrated.predictedSeconds ?? 0) > base!.predictedSeconds!);
});

test("ridge residual candidate learns a systematic readiness error", () => {
  const vo2 = {
    status: "available" as const,
    valueMlKgMin: 44,
    rangeMlKgMin: { lower: 42, upper: 46 },
    confidence: 0.7,
    confidenceLevel: "moderate" as const,
    evidenceCount: 10,
    latestEvidenceAt: "2026-01-01T00:00:00.000Z",
    method: "robust_evidence_ensemble_v1" as const,
    evidenceCodes: []
  };
  const performance = {
    status: "available" as const,
    value: 42,
    range: { lower: 40, upper: 44 },
    confidence: 0.65,
    confidenceLevel: "moderate" as const,
    evidenceCount: 8,
    latestEvidenceAt: "2026-01-01T00:00:00.000Z",
    method: "performance_envelope_v1" as const,
    evidenceCodes: []
  };
  const distances = ["five_k", "ten_k", "half_marathon"] as const;
  const examples = Array.from({ length: 24 }, (_, index) => {
    const distance = distances[index % distances.length]!;
    const readiness = 0.2 + (index % 8) * 0.1;
    const prediction = predictRaceTimes(vo2, { [distance]: readiness })
      .find((item) => item.distance === distance)!;
    const distancePenalty = distance === "half_marathon" ? 0.02 : distance === "ten_k" ? 0.01 : 0;
    const actualSeconds = prediction.predictedSeconds! *
      (1 + 0.08 * (1 - readiness) + distancePenalty);
    return {
      features: buildRaceMlFeatures(prediction, performance, vo2),
      predictedSeconds: prediction.predictedSeconds!,
      actualSeconds
    };
  });
  const model = fitRaceResidualRidge(examples);
  assert.ok(model);
  const targetReadiness = 0.25;
  const raw = predictRaceTimes(vo2, { half_marathon: targetReadiness })[2]!;
  const actual = raw.predictedSeconds! * (1 + 0.08 * (1 - targetReadiness) + 0.02);
  const adjusted = applyRaceResidualRidge(
    raw,
    model!,
    buildRaceMlFeatures(raw, performance, vo2)
  );
  assert.ok(
    Math.abs(adjusted.predictedSeconds! - actual) <
      Math.abs(raw.predictedSeconds! - actual)
  );
  assert.equal(adjusted.method, "ridge_ensemble_v5");
  const multiplier = adjusted.predictedSeconds! / raw.predictedSeconds!;
  assert.ok(Math.abs(adjusted.optimisticSeconds! - raw.optimisticSeconds! * multiplier) < 1e-9);
  assert.ok(Math.abs(adjusted.pessimisticSeconds! - raw.pessimisticSeconds! * multiplier) < 1e-9);
});
