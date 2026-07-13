import assert from "node:assert/strict";
import test from "node:test";

import { assertPhysiologyPredictionSnapshot, type PhysiologyPredictionSnapshot } from "../src/index.js";

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
