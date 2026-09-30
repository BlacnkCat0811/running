import assert from "node:assert/strict";
import test from "node:test";

import type { RaceTimePrediction } from "@rai/contracts";

import {
  adjustPredictionWithCatBoost,
  historicalValuesAvailableAt
} from "../src/prediction-report.js";

const prediction: RaceTimePrediction = {
  distance: "ten_k",
  distanceMeters: 10_000,
  status: "available",
  potentialSeconds: 3_000,
  predictedSeconds: 3_100,
  readinessAdjustmentSeconds: 50,
  environmentAdjustmentSeconds: 50,
  elevationAdjustmentSeconds: 0,
  fatigueAdjustmentSeconds: 0,
  calibrationAdjustmentSeconds: 0,
  machineLearningAdjustmentSeconds: 0,
  machineLearningFallbackReason: "no_active_model",
  optimisticSeconds: 2_900,
  pessimisticSeconds: 3_400,
  readiness: 0.8,
  confidence: 0.7,
  confidenceLevel: "moderate",
  method: "daniels_vdot_conditions_v3",
  evidenceCodes: ["race_prediction_vdot_baseline"]
};

test("P05: applies CatBoost log-residual correction multiplicatively to the full interval", () => {
  const adjusted = adjustPredictionWithCatBoost(prediction, 0.1);
  assert.ok(Math.abs((adjusted.predictedSeconds ?? 0) - 3_410) < 1e-9);
  assert.ok(Math.abs((adjusted.optimisticSeconds ?? 0) - 3_190) < 1e-9);
  assert.ok(Math.abs((adjusted.pessimisticSeconds ?? 0) - 3_740) < 1e-9);
  assert.ok(Math.abs((adjusted.machineLearningAdjustmentSeconds ?? 0) - 310) < 1e-9);
  assert.equal(adjusted.calibrationAdjustmentSeconds, 0);
  assert.equal(adjusted.machineLearningFallbackReason, null);
  assert.equal(adjusted.method, "catboost_residual_v6");
  assert.ok(adjusted.evidenceCodes.includes("catboost_residual_model"));
});

test("P05: rejects an invalid production correction before changing a prediction", () => {
  assert.throws(() => adjustPredictionWithCatBoost(prediction, Number.NaN));
  assert.throws(() => adjustPredictionWithCatBoost(prediction, 0.3));
});

test("T01: a label or example that arrives later is invisible to an earlier as-of", () => {
  // §16.1 T01「迟到标签/override → 不进入此前 as-known-then 预测」。
  // 这是那条规则在**可见性**这一层的判据：历史标签与残差样本都经同一个过滤器，
  // 只有 availableAt <= asOf 的才进入当次预测的证据集。
  const values = [
    { availableAt: "2026-01-03T00:00:00.000Z", value: "late" },
    { availableAt: "2026-01-01T12:00:00.000Z", value: "ready" },
    { availableAt: "2026-01-02T00:30:00.000Z", value: "overlapping" }
  ];
  assert.deepEqual(
    historicalValuesAvailableAt(values, "2026-01-02T00:00:00.000Z"),
    ["ready"]
  );
  assert.deepEqual(
    historicalValuesAvailableAt(values, "2026-01-03T00:00:00.000Z"),
    ["late", "ready", "overlapping"]
  );
});
