import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_TRANSITION_GATE_VERSION,
  evaluateModelTransitionGateV2,
  type ModelTransitionGateInput,
  type ModelTransitionMetricsV2,
  type ModelTransitionSourceBackfillEvidence
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
    baseScoredSessions: 200,
    candidateScoredSessions: 200,
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

test("confirmed empty-cohort transition is explicit and does not waive unknown or corrupt evidence", () => {
  const empty: NonNullable<ModelTransitionGateInput["emptyCohort"]> = {
    baseSessions: 7, removedBaseSessions: 7, remainingSourceSessions: 0,
    candidateFeatures: 0, candidateAssessments: 0, candidateLoads: 0,
    candidateDailyRows: 0, candidateCheckpointRows: 0, domainSnapshotsEmpty: true
  };
  const input: ModelTransitionGateInput = {
    candidateModelRunId: "candidate", baseModelRunId: "base", schema: sameScaleSchema,
    metrics: metrics({ matchedSessions: 0, baseScoredSessions: 0, candidateScoredSessions: 0,
      baseEligibleSessions: 0, candidateEligibleSessions: 0,
      currentAbilityMeanAbsoluteDelta: null, currentAbilityP95AbsoluteDelta: null,
      finalTrueAbilityDelta: null, readinessOutputCoverage: 1, recoveryIsolationHolds: true }),
    emptyCohort: empty
  };
  assert.equal(evaluateModelTransitionGateV2(input).status, "passed");
  for (const patch of [
    { remainingSourceSessions: 1 }, { removedBaseSessions: 6 }, { candidateFeatures: 1 },
    { candidateAssessments: 1 }, { candidateLoads: 1 }, { candidateDailyRows: 1 },
    { candidateCheckpointRows: 1 }, { domainSnapshotsEmpty: false },
    { baseSessions: Number.NaN }, { baseSessions: -1 }, { baseSessions: 1.5 },
    { baseSessions: undefined, removedBaseSessions: undefined }
  ]) {
    const result = evaluateModelTransitionGateV2({ ...input, emptyCohort: { ...empty, ...patch } as typeof empty });
    assert.equal(result.status, "failed", JSON.stringify(patch));
    assert.ok(result.failureReasons.includes("empty_cohort_evidence_invalid"));
  }
  const { emptyCohort: _proof, ...unproven } = input;
  assert.ok(evaluateModelTransitionGateV2(unproven).notEvaluableReasons.includes("no_matched_sessions"));
  assert.equal(evaluateModelTransitionGateV2({ ...input, baseModelRunId: null }).status, "not_evaluable");
  assert.equal(evaluateModelTransitionGateV2({ ...input, schema: { ...sameScaleSchema, baseModelVersion: null } }).status, "not_evaluable");
  for (const patch of [{ invalidValueCount: 1 }, { recoveryIsolationHolds: false }, { readinessOutputCoverage: 0 }]) {
    assert.equal(evaluateModelTransitionGateV2({ ...input, metrics: { ...input.metrics, ...patch } }).status, "failed");
  }
});

test("a same-scale release with scored cohorts cannot pass on metrics it could not compute", () => {
  // Mutation that turns this red: treat `null` as "within limits" again (the old
  // `exceeds(null, limit) === false`), which let a scored release activate while the
  // distribution assertions had not actually been evaluated.
  const unknown = evaluate({
    metrics: {
      currentAbilityMeanAbsoluteDelta: null,
      currentAbilityP95AbsoluteDelta: null,
      finalTrueAbilityDelta: null,
      recoveryNullRateDelta: null,
      recoverySaturationRate: null
    }
  });
  assert.equal(unknown.status, "not_evaluable");
  assert.equal(unknown.blocksActivation, true);
  assert.deepEqual(unknown.notEvaluableReasons, [
    "metric_unavailable:currentAbilityMeanAbsoluteDelta",
    "metric_unavailable:currentAbilityP95AbsoluteDelta",
    "metric_unavailable:recoveryNullRateDelta",
    "metric_unavailable:recoverySaturationRate"
  ]);
  // A TA that was never calibrated is recorded, not gated: the CA comparison is what
  // the same-scale protection is about (see the cold-start test below).
  assert.ok(unknown.migrationReport.includes("final_true_ability_unavailable"));
  assert.deepEqual(unknown.failureReasons, []);

  // One uncomputable CA metric is enough: the release is not evaluable, not "mostly fine".
  const partial = evaluate({ metrics: { currentAbilityP95AbsoluteDelta: null } });
  assert.equal(partial.status, "not_evaluable");
  assert.deepEqual(partial.notEvaluableReasons, ["metric_unavailable:currentAbilityP95AbsoluteDelta"]);

  // Cross-scale keeps using its replacement assertions; the null distribution
  // metrics there are recorded, not gated (S02).
  const crossScale = evaluate({ schema: crossScaleSchema, metrics: { ...passingCrossScale } });
  assert.equal(crossScale.status, "passed");
});

test("a null metric cannot hide a real failure on the same scale", () => {
  // `null` goes to not_evaluable, but an actual breach must still be `failed`
  // (failed wins over not_evaluable so the diagnosis is not lost).
  const result = evaluate({
    metrics: { currentAbilityP95AbsoluteDelta: null, recoverySaturationRate: 0.5 }
  });
  assert.equal(result.status, "failed");
  assert.ok(result.failureReasons.includes("recovery_saturation_rate"));
  assert.ok(result.notEvaluableReasons.includes("metric_unavailable:currentAbilityP95AbsoluteDelta"));
});

test("a cold-start recalculation with no scored cohort on either side is migrated, not blocked", () => {
  // The real regression this locks: a new runner's first few recalculations have
  // every assessment in `calibrating`, so CA and final TA are NULL on **both** runs.
  // The distribution protection is an empty set there — refusing to activate made the
  // first recalculation of an uncalibrated database fail forever.
  const result = evaluate({
    metrics: {
      matchedSessions: 7,
      baseScoredSessions: 0,
      candidateScoredSessions: 0,
      currentAbilityMeanAbsoluteDelta: null,
      currentAbilityP95AbsoluteDelta: null,
      finalTrueAbilityDelta: null,
      recoveryNullRateDelta: 0,
      recoverySaturationRate: 0
    }
  });
  assert.equal(result.status, "passed");
  assert.equal(result.blocksActivation, false);
  assert.deepEqual(result.failureReasons, []);
  assert.deepEqual(result.notEvaluableReasons, []);
  assert.ok(result.migrationReport.includes("no_scored_cohort"));
  assert.ok(result.migrationReport.includes("final_true_ability_unavailable"));
});

test("a same-scale release that loses a scored cohort fails hard", () => {
  // User-visible CA disappeared: that is a failure, not "not evaluable".
  const lost = evaluate({
    metrics: {
      matchedSessions: 7,
      baseScoredSessions: 7,
      candidateScoredSessions: 0,
      currentAbilityMeanAbsoluteDelta: null,
      currentAbilityP95AbsoluteDelta: null,
      finalTrueAbilityDelta: null
    }
  });
  assert.equal(lost.status, "failed");
  assert.equal(lost.blocksActivation, true);
  assert.ok(lost.failureReasons.includes("scored_cohort_lost"));
  assert.ok(!lost.notEvaluableReasons.some((reason) => reason.includes("currentAbilityMeanAbsoluteDelta")));
});

test("a same-scale release that gains a scored cohort is allowed and recorded", () => {
  const appeared = evaluate({
    metrics: {
      matchedSessions: 7,
      baseScoredSessions: 0,
      candidateScoredSessions: 7,
      currentAbilityMeanAbsoluteDelta: null,
      currentAbilityP95AbsoluteDelta: null,
      finalTrueAbilityDelta: null
    }
  });
  assert.equal(appeared.status, "passed");
  assert.equal(appeared.blocksActivation, false);
  assert.ok(appeared.migrationReport.includes("scored_cohort_appeared"));
});

test("an uncalibrated final TA is recorded but does not block a scored comparison", () => {
  const result = evaluate({ metrics: { finalTrueAbilityDelta: null } });
  assert.equal(result.status, "passed");
  assert.equal(result.blocksActivation, false);
  assert.ok(result.migrationReport.includes("final_true_ability_unavailable"));
  assert.deepEqual(result.notEvaluableReasons, []);
});

test("scored-cohort counts must be non-negative integers", () => {
  for (const patch of [
    { baseScoredSessions: Number.NaN },
    { candidateScoredSessions: -1 },
    { baseScoredSessions: 1.5 }
  ]) {
    const result = evaluate({ metrics: patch });
    assert.equal(result.status, "failed", JSON.stringify(patch));
    assert.ok(result.failureReasons.includes("invalid_scored_session_counts"), JSON.stringify(patch));
  }
});

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

test("S02: exempts removed-dimension drift on a cross-scale release and records it instead", () => {
  const result = evaluate({ schema: crossScaleSchema, metrics: passingCrossScale });
  assert.equal(result.transition, "cross_scale");
  assert.equal(result.status, "passed");
  assert.equal(result.blocksActivation, false);
  assert.deepEqual(result.failureReasons, []);
  assert.ok(result.migrationReport.some((entry) => entry.startsWith("recovery_null_rate_delta:")));
  assert.ok(result.migrationReport.includes("current_ability_mean_absolute_delta:11"));
});

test("S02: gates a cross-scale release on the replacement assertions", () => {
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

// --- sourceBackfill: pure history backfill reclassifies eligibility drift -------

function backfill(overrides: Partial<ModelTransitionSourceBackfillEvidence> = {}): ModelTransitionSourceBackfillEvidence {
  return {
    preservedAbsent: true,
    removedRecords: 0,
    removedWorkouts: 0,
    removedActivitySummaries: 0,
    removedEligibleSessions: 0,
    removedCalibrationSessions: 0,
    earliestInsertedIsNewGlobalEarliest: true,
    ...overrides
  };
}

/** Both eligibility failures exceed their limits, so the gate must act on them. */
const driftingEligibility = { eligibleSessionDelta: 0.9, assessmentStatusChangeRate: 0.44 };

function evaluateBackfill(
  sourceBackfill: ModelTransitionSourceBackfillEvidence | undefined,
  metricOverrides: Partial<ModelTransitionMetricsV2> = driftingEligibility
) {
  return evaluateModelTransitionGateV2({
    candidateModelRunId: "candidate",
    baseModelRunId: "base",
    schema: sameScaleSchema,
    metrics: metrics(metricOverrides),
    ...(sourceBackfill === undefined ? {} : { sourceBackfill })
  });
}

test("sourceBackfill: verified pure backfill records both drift reasons and passes", () => {
  // Mutation that turns this red: flip `verifiedBackfill` off (e.g. require
  // preservedAbsent === false, or drop a field from the equality check) so the
  // drift falls back to failureReasons.
  const result = evaluateBackfill(backfill());
  assert.equal(result.status, "passed");
  assert.equal(result.blocksActivation, false);
  assert.deepEqual(result.failureReasons, []);
  assert.deepEqual(result.migrationReport, [
    "source_backfill_eligible_session_delta:0.9",
    "source_backfill_assessment_status_change_rate:0.44"
  ]);
  assert.deepEqual(result.sourceBackfill, backfill());
});

test("sourceBackfill: without the global-earliest proof the drift still fails", () => {
  // Mutation that turns this red: drop `earliestInsertedIsNewGlobalEarliest` from
  // the verifiedBackfill conjunction, which would let a non-backwards import pass.
  const result = evaluateBackfill(backfill({ earliestInsertedIsNewGlobalEarliest: false }));
  assert.equal(result.status, "failed");
  assert.equal(result.blocksActivation, true);
  assert.deepEqual(result.failureReasons, [
    "eligible_session_delta",
    "assessment_status_change_rate"
  ]);
  assert.deepEqual(result.migrationReport, []);
});

test("sourceBackfill: any recorded deletion keeps the drift as a hard failure", () => {
  // Mutation that turns this red: stop asserting removed* === 0, which would let a
  // destructive import masquerade as a backfill.
  for (const patch of [
    { removedRecords: 1 },
    { removedWorkouts: 1 },
    { removedActivitySummaries: 1 },
    { removedEligibleSessions: 1 },
    { removedCalibrationSessions: 1 },
    { preservedAbsent: false }
  ]) {
    const result = evaluateBackfill(backfill(patch));
    assert.equal(result.status, "failed", JSON.stringify(patch));
    assert.ok(result.failureReasons.includes("eligible_session_delta"), JSON.stringify(patch));
    assert.ok(result.failureReasons.includes("assessment_status_change_rate"), JSON.stringify(patch));
  }
});

test("sourceBackfill: a hard failure is never waived by a valid backfill", () => {
  // Mutation that turns this red: move the `invalid_values` / non-finite checks
  // behind `if (!verifiedBackfill)`, which would let corrupt inputs pass.
  const invalid = evaluateBackfill(backfill(), { ...driftingEligibility, invalidValueCount: 2 });
  assert.equal(invalid.status, "failed");
  assert.ok(invalid.failureReasons.includes("invalid_values"));
  assert.deepEqual(invalid.failureReasons, ["invalid_values"]);

  const nonFinite = evaluateBackfill(backfill(), { ...driftingEligibility, recoveryNullRateDelta: Number.NaN });
  assert.equal(nonFinite.status, "failed");
  assert.ok(nonFinite.failureReasons.includes("non_finite_metric:recoveryNullRateDelta"));
});

test("sourceBackfill: omitted evidence is bit-identical to the pre-backfill gate", () => {
  // Mutation that turns this red: make the drift branch unconditional (always
  // record instead of fail), or include an empty sourceBackfill key in the result.
  const result = evaluateBackfill(undefined);
  assert.equal(result.status, "failed");
  assert.equal(result.blocksActivation, true);
  assert.deepEqual(result.failureReasons, [
    "eligible_session_delta",
    "assessment_status_change_rate"
  ]);
  assert.deepEqual(result.migrationReport, []);
  assert.deepEqual(result.notEvaluableReasons, []);
  assert.equal("sourceBackfill" in result, false);
});

test("sourceBackfill: malformed counts are rejected rather than treated as zero", () => {
  // Mutation that turns this red: replace Number.isInteger assertions with a
  // truthiness test, letting NaN / negative counts through as "no deletion".
  for (const patch of [
    { removedRecords: Number.NaN },
    { removedWorkouts: -1 },
    { removedActivitySummaries: 1.5 },
    { removedEligibleSessions: Number.NaN }
  ]) {
    const result = evaluateBackfill(backfill(patch as Partial<ModelTransitionSourceBackfillEvidence>));
    assert.equal(result.status, "failed", JSON.stringify(patch));
    assert.ok(result.failureReasons.includes("eligible_session_delta"), JSON.stringify(patch));
  }
});
