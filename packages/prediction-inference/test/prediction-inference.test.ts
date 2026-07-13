import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCatBoostArtifactManifest,
  correctionFractionFromLogResidual
} from "../src/index.js";
import {
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH,
  predictionResidualOnnxFeatureNames
} from "@rai/contracts";

test("converts log residuals into bounded race-time corrections", () => {
  assert.ok(Math.abs(correctionFractionFromLogResidual(Math.log(1.05)) - 0.05) < 1e-12);
  assert.equal(correctionFractionFromLogResidual(Math.log(2)), 0.12);
  assert.equal(correctionFractionFromLogResidual(Math.log(0.5)), -0.12);
});

test("rejects invalid residual outputs and correction limits", () => {
  assert.throws(() => correctionFractionFromLogResidual(Number.NaN));
  assert.throws(() => correctionFractionFromLogResidual(0, 0));
  assert.throws(() => correctionFractionFromLogResidual(0, 0.5));
});

test("validates the immutable CatBoost artifact manifest contract", () => {
  const hash = "a".repeat(64);
  const manifest = {
    modelVersion: "race-residual-catboost-v1",
    algorithm: "catboost",
    featureSchemaVersion: "race-residual-feature-v2",
    featureSchemaHash: PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH,
    trainingDataHash: hash,
    modelSha256: hash,
    labelCount: 51,
    supportedDistances: ["five_k", "ten_k", "half_marathon"],
    featureNames: [...predictionResidualOnnxFeatureNames],
    inputName: "features",
    outputName: "predictions",
    correctionCapFraction: 0.12,
    generatedAt: "2026-07-11T00:00:00.000Z",
    status: "accepted",
    metrics: {
      baseline: {},
      candidate: {},
      byDistance: { baseline: {}, candidate: {} },
      meanAbsoluteErrorImprovement: 0.1,
      intervalCoverageDrop: 0
    }
  };
  assert.doesNotThrow(() => assertCatBoostArtifactManifest(manifest));
  assert.throws(() => assertCatBoostArtifactManifest({ ...manifest, status: "rejected" }));
  assert.throws(() => assertCatBoostArtifactManifest({
    ...manifest,
    featureNames: [...predictionResidualOnnxFeatureNames, predictionResidualOnnxFeatureNames[0]]
  }));
  assert.throws(() => assertCatBoostArtifactManifest({
    ...manifest,
    featureNames: [...predictionResidualOnnxFeatureNames].reverse()
  }));
  assert.throws(() => assertCatBoostArtifactManifest({
    ...manifest,
    featureSchemaHash: hash
  }));
  assert.throws(() => assertCatBoostArtifactManifest({ ...manifest, modelSha256: "bad" }));
});
