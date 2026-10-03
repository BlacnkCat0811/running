import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnnxCatBoostResidualModel } from "../src/index.js";
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

test("M01: validates the immutable CatBoost artifact manifest contract", () => {
  const hash = "a".repeat(64);
  const manifest = {
    modelVersion: "race-residual-catboost-v5",
    algorithm: "catboost",
    scope: "population",
    featureSchemaVersion: "race-residual-feature-v4",
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
  assert.doesNotThrow(() => assertCatBoostArtifactManifest({ ...manifest, scope: "personal" }));
  assert.throws(() => assertCatBoostArtifactManifest({ ...manifest, scope: undefined }));
  assert.throws(() => assertCatBoostArtifactManifest({ ...manifest, scope: "unknown" }));
  assert.throws(() => assertCatBoostArtifactManifest({ ...manifest, modelVersion: "race-residual-catboost-v4" }));
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
  assert.throws(() => assertCatBoostArtifactManifest({
    ...manifest,
    correctionCapFraction: 0.25
  }));
});


test("installed native ONNX runtime loads and executes the production feature shape", async () => {
  // ReduceMean(features, axes=[1], keepdims=1), float32 [1,26] -> [1,1].
  // Generated with onnx.helper; IR 10/opset 11. Kept inline so npm test does not
  // need Python, a private trained model, or a network download.
  const bytes = Buffer.from("CAo6kQEKQAoIZmVhdHVyZXMSCnByZWRpY3Rpb24iClJlZHVjZU1lYW4qCwoEYXhlc0ABoAEHKg8KCGtlZXBkaW1zGAGgAQISE3JhaS1ydW50aW1lLWZpeHR1cmVaGgoIZmVhdHVyZXMSDgoMCAESCAoCCAEKAggaYhwKCnByZWRpY3Rpb24SDgoMCAESCAoCCAEKAggBQgQKABAL", "base64");
  const directory = await mkdtemp(join(tmpdir(), "rai-native-inference-"));
  try {
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, "model.onnx"), bytes);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({
      modelVersion: "race-residual-catboost-v5", algorithm: "catboost",
      scope: "population",
      featureSchemaVersion: "race-residual-feature-v4",
      featureSchemaHash: PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH,
      trainingDataHash: "a".repeat(64), modelSha256: hash, labelCount: 51,
      supportedDistances: ["five_k", "ten_k", "half_marathon"],
      featureNames: [...predictionResidualOnnxFeatureNames],
      inputName: "features", outputName: "prediction", correctionCapFraction: 0.12,
      generatedAt: "2026-09-22T00:00:00.000Z", status: "accepted", metrics: {}
    }));
    await assert.rejects(OnnxCatBoostResidualModel.load(directory, "personal"), /scope mismatch/);
    const model = await OnnxCatBoostResidualModel.load(directory, "population");
    const result = await model.predict(Object.fromEntries(predictionResidualOnnxFeatureNames.map((name) => [name, 0.05])));
    assert.ok(Math.abs(result.targetLogResidual - 0.05) < 1e-6);
    assert.ok(Math.abs(result.correctionFraction - Math.expm1(0.05)) < 1e-6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
