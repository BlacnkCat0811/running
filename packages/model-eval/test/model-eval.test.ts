import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIndependentTemporalPartitions, compareResidualChallengers,
  empiricalIntervalBounds, evaluateIntervalArtifact, fitEmpiricalIntervals,
  predictionMetrics, type EvaluationCase
} from "../src/index.js";

const asOf = "2026-09-29T00:00:00Z";
function cases(prefix: string, month: string, residuals: number[]): EvaluationCase[] {
  return residuals.map((r, i) => ({
    eventId: `${prefix}-${i}`, distance: "five_k",
    predictedAt: `2026-${month}-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    outcomeAt: `2026-${month}-${String(i + 1).padStart(2, "0")}T01:00:00Z`,
    availableAt: `2026-${month}-${String(i + 1).padStart(2, "0")}T02:00:00Z`,
    actualSeconds: 1000 * Math.exp(r), predictedSeconds: 1000
  }));
}
const policy = {
  minimumCalibrationSamples: 5, minimumTestSamples: 5,
  minimumCoverage: { p80: 0.7, p90: 0.8 }, maximumMeanRelativeWidth: 0.8
};

test("empty data has null metrics and does not activate anything", () => {
  assert.equal(predictionMetrics([], asOf).mae, null);
  assert.equal(fitEmpiricalIntervals({
    predictorVersion: "baseline-v1", distance: "five_k", calibration: [], asOf, policy
  }), null);
  assert.equal(compareResidualChallengers({
    baseline: [], ridge: [], catboost: [], asOf,
    minimumSamples: 1, minimumImprovement: 0.05, maximumDistanceRegression: 0.05
  }).blocksActivation, true);
});

test("train, calibration and test use separate event identities, arrival time and embargo", () => {
  const value = {
    trainingEventIds: ["train"], trainingLabelsAvailableThrough: "2026-06-01T00:00:00Z",
    calibration: cases("cal", "07", [0, 0.01, -0.01, 0.03, -0.03]),
    test: cases("test", "08", [0, 0.01, -0.01, 0.02, -0.02]),
    asOf, embargoHours: 24
  };
  assert.doesNotThrow(() => assertIndependentTemporalPartitions(value));
  assert.throws(() => assertIndependentTemporalPartitions({
    ...value, trainingEventIds: ["cal-0"]
  }), /overlap/);
  assert.throws(() => assertIndependentTemporalPartitions({
    ...value, test: cases("test", "06", [0])
  }), /calibration\/embargo/);
});

test("empirical intervals are nested, independently evaluated and not individual guarantees", () => {
  const artifact = fitEmpiricalIntervals({
    predictorVersion: "baseline-v1", distance: "five_k",
    calibration: cases("cal", "07", [-0.1, -0.05, 0, 0.05, 0.1]), asOf, policy
  })!;
  const bounds = empiricalIntervalBounds(artifact, 1000);
  assert.ok(bounds.p90.lowerSeconds <= bounds.p80.lowerSeconds);
  assert.ok(bounds.p80.upperSeconds <= bounds.p90.upperSeconds);
  assert.equal(bounds.p50Seconds, 1000);
  const evaluation = evaluateIntervalArtifact(artifact, cases("test", "08", [0, 0.01, -0.01, 0.02, -0.02]), asOf);
  assert.equal(evaluation.status, "passed");
  assert.equal(evaluation.p80.coverageClaim, "empirical_target_not_individual_guarantee");
  assert.equal(evaluateIntervalArtifact(artifact, [], asOf).status, "not_evaluable");
  assert.throws(() => evaluateIntervalArtifact(artifact, cases("cal", "07", [0]), asOf), /overlaps/);
  assert.equal(evaluateIntervalArtifact(artifact, cases("bad", "08", [1, 1, 1, 1, 1]), asOf).blocksPublication, true);
});

test("mixed distances, nonfinite values, duplicate labels, future arrival fail closed", () => {
  const row = cases("event", "07", [0])[0]!;
  assert.throws(() => predictionMetrics([{ ...row, actualSeconds: NaN }], asOf), /finite/);
  assert.throws(() => predictionMetrics([row, row], asOf), /unique/);
  assert.throws(() => predictionMetrics([{ ...row, availableAt: "2027-01-01T00:00:00Z" }], asOf), /timing/);
  assert.throws(() => fitEmpiricalIntervals({
    predictorVersion: "baseline", distance: "ten_k", calibration: [row], asOf, policy
  }), /Mixed-distance/);
});

test("CatBoost must beat both challengers on identical cases, including per-distance checks", () => {
  const baseline = cases("case", "07", [0.1, 0.1, 0.1]).map((row, i) => ({
    ...row, distance: (["five_k", "ten_k", "half_marathon"] as const)[i]!
  }));
  const common = { baseline, asOf, minimumSamples: 1, minimumImprovement: 0.05, maximumDistanceRegression: 0.05 };
  const perfect = baseline.map((row) => ({ ...row, predictedSeconds: row.actualSeconds }));
  const result = compareResidualChallengers({
    ...common, ridge: baseline.map((row) => ({ ...row, predictedSeconds: 1050 })), catboost: perfect
  });
  assert.equal(result.status, "passed");
  assert.equal(compareResidualChallengers({ ...common, ridge: perfect, catboost: baseline }).status, "failed");
  assert.throws(() => compareResidualChallengers({ ...common, ridge: perfect.slice(1), catboost: perfect }), /exactly/);
});
