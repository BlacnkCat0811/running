import assert from "node:assert/strict";
import test from "node:test";

import type { RaceTimePrediction } from "@rai/contracts";

import {
  adjustPredictionWithCatBoost,
  excludeCatBoostCorrectedDistances,
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

/**
 * §16.1 **P05** / §12.1：一个距离只能有一个点修正 policy，不许 bias 与 CatBoost 各修一次。
 *
 * 这条规则此前只以一行内联 filter 的形式存在于 `buildPredictionReport` 内 ——
 * 而那条路径要开库、要有一个已激活的 CatBoost 模型才走得到，所以独立审计（2026-09-30）
 * 判定它是"实现存在、测试不存在"。现在规则被提成纯函数，这里把它钉住。
 */
test("P05: a CatBoost-corrected distance is dropped from the bias-calibration list", () => {
  const race = (distance: RaceTimePrediction["distance"], method: string) =>
    ({ distance, method }) as unknown as RaceTimePrediction;

  // CatBoost 修了半马 ⇒ 半马必须从 bias 名单里消失，10K 不受影响。
  assert.deepEqual(
    excludeCatBoostCorrectedDistances(
      ["five_k", "ten_k", "half_marathon"],
      [race("five_k", "daniels_vdot_conditions_v3"), race("ten_k", "daniels_vdot_conditions_v3"),
       race("half_marathon", "catboost_residual_v6")]
    ),
    ["five_k", "ten_k"]
  );

  // 没有距离用 CatBoost ⇒ 名单原样保留（不是"一律清空"）。
  assert.deepEqual(
    excludeCatBoostCorrectedDistances(
      ["five_k", "half_marathon"],
      [race("five_k", "daniels_vdot_conditions_v3"), race("half_marathon", "race-residual-ridge-v1")]
    ),
    ["five_k", "half_marathon"]
  );

  // 名单里有但这一轮没有该距离的预测 ⇒ 没有证据说它被修正过，保留（保守方向）。
  assert.deepEqual(excludeCatBoostCorrectedDistances(["ten_k"], []), ["ten_k"]);

  // 全部被 CatBoost 修正 ⇒ 结果为空，而不是留下一个会二次修正的条目。
  assert.deepEqual(
    excludeCatBoostCorrectedDistances(["five_k"], [race("five_k", "catboost_residual_v6")]),
    []
  );
});
