import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH,
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
  predictionResidualFeatureSchema,
  predictionResidualOnnxFeatureNames
} from "@rai/contracts";
import { assertCatBoostArtifactManifest } from "@rai/prediction-inference";

import {
  RACE_RESIDUAL_FEATURE_SCHEMA_VERSION,
  raceResidualFeatureSchemaHash,
  raceResidualOnnxFeatureNames
} from "../src/prediction-training-data.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

test("uses one residual feature schema across contracts and training", () => {
  const calculatedHash = createHash("sha256")
    .update(canonicalJson(predictionResidualFeatureSchema))
    .digest("hex");

  assert.equal(calculatedHash, PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH);
  assert.equal(raceResidualFeatureSchemaHash(), PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH);
  assert.equal(RACE_RESIDUAL_FEATURE_SCHEMA_VERSION, PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION);
  assert.deepEqual(raceResidualOnnxFeatureNames, predictionResidualOnnxFeatureNames);
});

test("accepts a training-side schema hash at the inference boundary", () => {
  const placeholderHash = "a".repeat(64);
  const manifest = {
    modelVersion: "race-residual-catboost-v4",
    algorithm: "catboost",
    featureSchemaVersion: RACE_RESIDUAL_FEATURE_SCHEMA_VERSION,
    featureSchemaHash: raceResidualFeatureSchemaHash(),
    trainingDataHash: placeholderHash,
    modelSha256: placeholderHash,
    labelCount: 50,
    supportedDistances: ["five_k", "ten_k", "half_marathon"],
    featureNames: [...raceResidualOnnxFeatureNames],
    inputName: "features",
    outputName: "predictions",
    correctionCapFraction: 0.12,
    generatedAt: "2026-07-15T00:00:00.000Z",
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
});
