import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_TRANSITION_GATE_VERSION,
  evaluateModelTransitionGateV2,
  type ModelTransitionGateInput,
  type ModelTransitionMetricsV2
} from "../src/index.js";

const sameScaleSchema: ModelTransitionGateInput["schema"] = {
  baseModelVersion: "rai-model-config-v4",
  candidateModelVersion: "rai-model-config-v4",
  baseFeatureSchemaVersion: "workout-feature-v3",
  candidateFeatureSchemaVersion: "workout-feature-v3"
};

/** A V1 -> V2 style release: config and feature schema both move. */
const crossScaleSchema: ModelTransitionGateInput["schema"] = {
  baseModelVersion: "rai-model-config-v4",
  candidateModelVersion: "rai-model-config-v5",
  baseFeatureSchemaVersion: "workout-feature-v3",
  candidateFeatureSchemaVersion: "workout-feature-v4"
};

function metrics(overrides: Partial<ModelTransitionMetricsV2> = {}): ModelTransitionMetricsV2 {
  return {
    matchedSessions: 200,
    baseEligibleSessions: 180,
    candidateEligibleSessions: 180,
    eligibleSessionDelta: 0,
    assessmentStatusChangeRate: 0.02,
    invalidValueCount: 0,
    currentAbilityMeanAbsoluteDelta: 1.5,
    currentAbilityP95AbsoluteDelta: 4,
    finalTrueAbilityDelta: 2,
    recoveryNullRateDelta: 0,
    recoverySaturationRate: 0.01,
    readinessOutputCoverage: null,
    recoveryIsolationHolds: null,
    ...overrides
  };
}

function evaluate(options: {
  schema?: ModelTransitionGateInput["schema"];
  metrics?: Partial<ModelTransitionMetricsV2>;
  baseModelRunId?: string | null;
} = {}) {
  return evaluateModelTransitionGateV2({
    candidateModelRunId: "candidate",
    baseModelRunId: options.baseModelRunId === undefined ? "base" : options.baseModelRunId,
    schema: options.schema ?? sameScaleSchema,
    metrics: metrics(options.metrics)
  });
}

const passingCrossScale = {
  readinessOutputCoverage: 1,
  recoveryIsolationHolds: true,
  // A removed dimension legitimately moves these far past the legacy limits.
  recoveryNullRateDelta: 0.42,
  recoverySaturationRate: 0.35,
  currentAbilityMeanAbsoluteDelta: 11
};

test("passes a same-scale candidate inside the legacy thresholds", () => {
  const result = evaluate();
  assert.equal(result.status, "passed");
  assert.equal(result.transition, "same_scale");
  assert.equal(result.blocksActivation, false);
  assert.equal(result.failureReasons.length, 0);
  assert.equal(result.gateVersion, MODEL_TRANSITION_GATE_VERSION);
});

test("fails a same-scale candidate on the metrics the legacy gate already policed", () => {
  assert.deepEqual(evaluate({ metrics: { currentAbilityMeanAbsoluteDelta: 9 } }).failureReasons, [
    "current_ability_mean_absolute_delta"
  ]);
  assert.deepEqual(evaluate({ metrics: { currentAbilityP95AbsoluteDelta: 16 } }).failureReasons, [
    "current_ability_p95_absolute_delta"
  ]);
  assert.deepEqual(evaluate({ metrics: { finalTrueAbilityDelta: -11 } }).failureReasons, [
    "final_true_ability_delta"
  ]);
  // Recovery continuity must stay enforced while the scale is unchanged.
  assert.deepEqual(evaluate({ metrics: { recoveryNullRateDelta: 0.11 } }).failureReasons, [
    "recovery_null_rate_delta"
  ]);
  assert.deepEqual(evaluate({ metrics: { recoverySaturationRate: 0.21 } }).failureReasons, [
    "recovery_saturation_rate"
  ]);
});

test("exempts removed-dimension drift on a cross-scale release and records it instead", () => {
  const result = evaluate({ schema: crossScaleSchema, metrics: passingCrossScale });
  assert.equal(result.transition, "cross_scale");
  assert.equal(result.status, "passed");
  assert.equal(result.blocksActivation, false);
  assert.deepEqual(result.failureReasons, []);
  assert.ok(result.migrationReport.some((entry) => entry.startsWith("recovery_null_rate_delta:")));
  assert.ok(result.migrationReport.includes("current_ability_mean_absolute_delta:11"));
});

test("gates a cross-scale release on the replacement assertions", () => {
  const missing = evaluate({ schema: crossScaleSchema });
  assert.equal(missing.status, "not_evaluable");
  assert.ok(missing.notEvaluableReasons.includes("readiness_output_missing"));
  assert.ok(missing.notEvaluableReasons.includes("recovery_isolation_not_run"));

  const isolationBroken = evaluate({
    schema: crossScaleSchema,
    metrics: { ...passingCrossScale, recoveryIsolationHolds: false }
  });
  assert.equal(isolationBroken.status, "failed");
  assert.ok(isolationBroken.failureReasons.includes("recovery_isolation_violated"));

  const partialCoverage = evaluate({
    schema: crossScaleSchema,
    metrics: { ...passingCrossScale, readinessOutputCoverage: 0.5 }
  });
  assert.equal(partialCoverage.status, "failed");
  assert.ok(partialCoverage.failureReasons.includes("readiness_output_coverage"));
});

test("never reports zero matched sessions as a pass", () => {
  for (const schema of [sameScaleSchema, crossScaleSchema]) {
    const result = evaluate({
      schema,
      metrics: { matchedSessions: 0, ...(schema === crossScaleSchema ? passingCrossScale : {}) }
    });
    assert.equal(result.status, "not_evaluable");
    assert.equal(result.blocksActivation, true);
    assert.ok(result.notEvaluableReasons.includes("no_matched_sessions"));
  }
});

test("treats an undeterminable scale and a missing base run as not_evaluable", () => {
  const unknownScale = evaluate({
    schema: { ...sameScaleSchema, candidateFeatureSchemaVersion: null }
  });
  assert.equal(unknownScale.transition, "unknown");
  assert.equal(unknownScale.status, "not_evaluable");
  assert.ok(unknownScale.notEvaluableReasons.includes("unknown_transition_scale"));

  const noBase = evaluate({ baseModelRunId: null });
  assert.equal(noBase.status, "not_evaluable");
  assert.equal(noBase.blocksActivation, true);
  assert.ok(noBase.notEvaluableReasons.includes("no_base_run"));

  const selfBase = evaluate({ baseModelRunId: "candidate" });
  assert.equal(selfBase.status, "not_evaluable");
  assert.ok(selfBase.notEvaluableReasons.includes("no_base_run"));
});

test("hard failures hold on both scales", () => {
  for (const schema of [sameScaleSchema, crossScaleSchema]) {
    const extra = schema === crossScaleSchema ? passingCrossScale : {};
    const invalid = evaluate({ schema, metrics: { ...extra, invalidValueCount: 3 } });
    assert.equal(invalid.status, "failed");
    assert.ok(invalid.failureReasons.includes("invalid_values"));

    const nonFinite = evaluate({ schema, metrics: { ...extra, currentAbilityP95AbsoluteDelta: Number.NaN } });
    assert.equal(nonFinite.status, "failed");
    assert.ok(nonFinite.failureReasons.includes("non_finite_metric:currentAbilityP95AbsoluteDelta"));
  }
});

test("eligibility drift fails regardless of scale", () => {
  for (const schema of [sameScaleSchema, crossScaleSchema]) {
    const extra = schema === crossScaleSchema ? passingCrossScale : {};
    assert.deepEqual(evaluate({ schema, metrics: { ...extra, eligibleSessionDelta: 0.06 } }).failureReasons, [
      "eligible_session_delta"
    ]);
    assert.deepEqual(
      evaluate({ schema, metrics: { ...extra, assessmentStatusChangeRate: 0.11 } }).failureReasons,
      ["assessment_status_change_rate"]
    );
  }
});

test("reading blocksActivation is required: not_evaluable is not a failure status", () => {
  const result = evaluate({ schema: crossScaleSchema });
  assert.notEqual(result.status, "failed");
  assert.equal(result.blocksActivation, true);
});

test("an explicit baseline epoch change cannot be mistaken for same-scale tuning", () => {
  const result = evaluate({schema:{...sameScaleSchema,baseScaleId:"epoch-old",candidateScaleId:"epoch-new"},metrics:passingCrossScale});
  assert.equal(result.transition,"cross_scale");
  assert.equal(result.status,"passed");
  const failed=evaluate({schema:{...sameScaleSchema,baseScaleId:"epoch-old",candidateScaleId:"epoch-new"},metrics:{...passingCrossScale,recoveryIsolationHolds:false}});
  assert.equal(failed.blocksActivation,true);
});

test("a new engine/config version with the same known epoch retains strict regression limits", () => {
  const result=evaluate({schema:{...sameScaleSchema,candidateModelVersion:"rai-model-config-v-next",baseScaleId:"same-epoch",candidateScaleId:"same-epoch"},metrics:{finalTrueAbilityDelta:11}});
  assert.equal(result.transition,"same_scale");
  assert.equal(result.status,"failed");
  assert.ok(result.failureReasons.includes("final_true_ability_delta"));
});
