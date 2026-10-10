// `rai-model-transition-gate-v2` — the schema-aware model release gate.
//
// The legacy `evaluateValidationGate` ("rai-shadow-gate-v1") is a same-scale
// gate: it compares a candidate against a base run of the same schema and fails
// on distribution drift. Removing the recovery dimension from CA legitimately
// moves those distributions, so the legacy thresholds would reject a correct V2
// release — and "passing" the gate by backfilling a synthetic recovery score
// would be worse than the rejection.
//
// This gate keeps the legacy protection where it is still meaningful and makes
// applicability explicit instead of implicit:
//
//   same feature schema + same model version  -> strict same-scale comparison
//   any schema/version change                 -> distribution continuity on the
//                                                removed dimensions is recorded
//                                                as a migration metric, not a
//                                                failure; the replacement
//                                                assertions (F01 recovery
//                                                isolation, readiness output
//                                                completeness) become the gate
//   scale cannot be determined                -> not_evaluable, never a pass
//   zero matched sessions                     -> not_evaluable unless explicit
//                                                complete empty-cohort proof
//
// `invalidValueCount > 0`, non-finite metrics and eligibility drift always fail,
// on both scales. The one exception is a *verified* source backfill (see
// `ModelTransitionSourceBackfillEvidence`): when the import provably removed
// nothing and only extended the fact timeline backwards, the two data-driven
// eligibility failures become migration records instead — identical in spirit to
// the verified-empty-cohort path.
//
// Design: docs/ALGORITHM.md §14.
//
// This module stays pure. The recompute pipeline persists its three-state result
// with the immutable release evaluation, including any explicit empty proof.

export const MODEL_TRANSITION_GATE_VERSION = "rai-model-transition-gate-v2" as const;

export type ModelTransitionGateStatus = "passed" | "failed" | "not_evaluable";

export type ModelTransitionKind =
  /** Same feature schema and same model version: legacy thresholds apply. */
  | "same_scale"
  /** The scale changed; distribution continuity is reported, not enforced. */
  | "cross_scale"
  /** Versions are missing, so the applicable assertions cannot be chosen. */
  | "unknown";

export interface ModelTransitionSchemaContext {
  baseScaleId?: string | null;
  candidateScaleId?: string | null;
  baseModelVersion: string | null;
  candidateModelVersion: string | null;
  baseFeatureSchemaVersion: string | null;
  candidateFeatureSchemaVersion: string | null;
}

export interface ModelTransitionMetricsV2 {
  matchedSessions: number;
  baseEligibleSessions: number;
  candidateEligibleSessions: number;
  eligibleSessionDelta: number;
  assessmentStatusChangeRate: number;
  invalidValueCount: number;
  currentAbilityMeanAbsoluteDelta: number | null;
  currentAbilityP95AbsoluteDelta: number | null;
  finalTrueAbilityDelta: number | null;
  recoveryNullRateDelta: number | null;
  recoverySaturationRate: number | null;
  /** Share of eligible sessions carrying a Readiness snapshot (0..1). */
  readinessOutputCoverage: number | null;
  /**
   * F01 counterfactual result: swapping only sleep/HRV/RHR left CA, TA and the
   * TA-update decision unchanged. `null` means the counterfactual was not run,
   * which is not the same as it having failed.
   */
  recoveryIsolationHolds: boolean | null;
}

export interface ModelTransitionGateThresholdsV2 {
  /** Same-scale only. */
  readonly maxCurrentAbilityMeanAbsoluteDelta: number;
  readonly maxCurrentAbilityP95AbsoluteDelta: number;
  readonly maxFinalTrueAbilityDelta: number;
  readonly maxRecoveryNullRateDelta: number;
  readonly maxRecoverySaturationRate: number;
  /** Applies on both scales. */
  readonly maxEligibleSessionDelta: number;
  readonly maxStatusChangeRate: number;
  /** Cross-scale replacement assertion. */
  readonly minReadinessOutputCoverage: number;
}

/**
 * Reused rather than re-invented: the numeric limits are the existing gate's
 * ("evaluateValidationGate", model-run-repository.ts). Only the applicability
 * rules and the two replacement assertions are new.
 */
export const MODEL_TRANSITION_GATE_THRESHOLDS_V2: ModelTransitionGateThresholdsV2 = {
  maxCurrentAbilityMeanAbsoluteDelta: 8,
  maxCurrentAbilityP95AbsoluteDelta: 15,
  maxFinalTrueAbilityDelta: 10,
  maxRecoveryNullRateDelta: 0.1,
  maxRecoverySaturationRate: 0.2,
  maxEligibleSessionDelta: 0.05,
  maxStatusChangeRate: 0.1,
  minReadinessOutputCoverage: 1
};

/**
 * DB-derived proof for a pure source backfill, never a generic bypass.
 *
 * A backfill import carries an *older* history slice than the base run had. That
 * legitimately re-labels existing sessions (they now have fuller inputs), so the
 * data-driven eligibility drift can no longer distinguish "facts were lost" from
 * "facts were extended backwards". This evidence is the structural proof that it
 * is the latter: the import removed nothing at all and the newest gap it fills is
 * strictly before everything the database already held.
 *
 * Mirrors `emptyCohort`: it converts the two eligibility drift failures into
 * migration records and never waives a hard failure (`invalid_values`,
 * non-finite metrics, distribution limits, replacement assertions).
 */
export interface ModelTransitionSourceBackfillEvidence {
  /**
   * The import recorded no deletion for its batch, i.e. absence from the payload
   * was preserved rather than interpreted as removal.
   */
  preservedAbsent: boolean;
  removedRecords: number;
  removedWorkouts: number;
  removedActivitySummaries: number;
  removedEligibleSessions: number;
  removedCalibrationSessions: number;
  /**
   * The batch's earliest inserted record is the new global earliest fact, so the
   * fact timeline really moved backwards. Membership only; no time comparison.
   */
  earliestInsertedIsNewGlobalEarliest: boolean;
}

export interface ModelTransitionGateInput {
  candidateModelRunId: string;
  baseModelRunId: string | null;
  schema: ModelTransitionSchemaContext;
  metrics: ModelTransitionMetricsV2;
  /** DB-derived proof for a legitimate empty dataset, never a generic bypass. */
  emptyCohort?: {
    baseSessions: number;
    removedBaseSessions: number;
    remainingSourceSessions: number;
    candidateFeatures: number;
    candidateAssessments: number;
    candidateLoads: number;
    candidateDailyRows: number;
    candidateCheckpointRows: number;
    domainSnapshotsEmpty: boolean;
  };
  /** DB-derived proof for a pure source backfill, never a generic bypass. */
  sourceBackfill?: ModelTransitionSourceBackfillEvidence;
  /** Defaults to `MODEL_TRANSITION_GATE_THRESHOLDS_V2`. */
  thresholds?: ModelTransitionGateThresholdsV2;
}

export interface ModelTransitionGateResultV2 {
  emptyCohort?: ModelTransitionGateInput["emptyCohort"];
  sourceBackfill?: ModelTransitionGateInput["sourceBackfill"];
  candidateModelRunId: string;
  baseModelRunId: string | null;
  gateVersion: typeof MODEL_TRANSITION_GATE_VERSION;
  status: ModelTransitionGateStatus;
  transition: ModelTransitionKind;
  /**
   * True unless `status === "passed"`. Publishing must read this field rather
   * than testing `status === "failed"`, or `not_evaluable` silently publishes.
   */
  blocksActivation: boolean;
  thresholds: ModelTransitionGateThresholdsV2;
  metrics: ModelTransitionMetricsV2;
  /** Hard failures. Non-empty implies `status === "failed"`. */
  failureReasons: string[];
  /** Cross-scale drift kept for the migration record; never fails the gate. */
  migrationReport: string[];
  /**
   * Checks that could not run. Non-empty with no hard failure implies
   * `status === "not_evaluable"`.
   */
  notEvaluableReasons: string[];
}

export function evaluateModelTransitionGateV2(
  input: ModelTransitionGateInput
): ModelTransitionGateResultV2 {
  const thresholds = input.thresholds ?? MODEL_TRANSITION_GATE_THRESHOLDS_V2;
  const metrics = input.metrics;
  const transition = classifyTransition(input.schema);
  const failureReasons: string[] = [];
  const migrationReport: string[] = [];
  const notEvaluableReasons: string[] = [];

  // Hard failures first: they hold on both scales and are never exempted.
  for (const name of nonFiniteMetricNames(metrics)) {
    failureReasons.push(`non_finite_metric:${name}`);
  }
  if (metrics.invalidValueCount > 0) failureReasons.push("invalid_values");

  if (transition === "unknown") notEvaluableReasons.push("unknown_transition_scale");

  const hasBase = input.baseModelRunId !== null && input.baseModelRunId !== input.candidateModelRunId;
  if (!hasBase) notEvaluableReasons.push("no_base_run");
  const empty = input.emptyCohort;
  const verifiedEmpty = empty !== undefined &&
    [empty.baseSessions, empty.removedBaseSessions, empty.remainingSourceSessions,
      empty.candidateFeatures, empty.candidateAssessments, empty.candidateLoads,
      empty.candidateDailyRows, empty.candidateCheckpointRows]
      .every((value) => Number.isInteger(value) && value >= 0) &&
    empty.baseSessions === empty.removedBaseSessions && empty.remainingSourceSessions === 0 &&
    empty.candidateFeatures === 0 && empty.candidateAssessments === 0 && empty.candidateLoads === 0 &&
    empty.candidateDailyRows === 0 && empty.candidateCheckpointRows === 0 && empty.domainSnapshotsEmpty === true &&
    metrics.matchedSessions === 0 && metrics.candidateEligibleSessions === 0 && metrics.baseEligibleSessions === 0 &&
    metrics.invalidValueCount === 0 && metrics.readinessOutputCoverage === 1 && metrics.recoveryIsolationHolds === true;
  if (empty !== undefined && !verifiedEmpty) failureReasons.push("empty_cohort_evidence_invalid");
  if (metrics.matchedSessions === 0 && !verifiedEmpty) notEvaluableReasons.push("no_matched_sessions");
  if (verifiedEmpty) migrationReport.push("confirmed_empty_cohort:no_remaining_source_or_derived_training");

  // A verified backfill reclassifies a *legitimate* eligibility drift as a
  // migration record. It is deliberately all-or-nothing: every removal count must
  // be a real zero (integers, never negative) and the batch must own the global
  // earliest fact, which together prove no data was lost and the timeline merely
  // grew backwards. Any missing/odd evidence leaves the normal failures in place.
  const backfill = input.sourceBackfill;
  const verifiedBackfill = backfill !== undefined &&
    [backfill.removedRecords, backfill.removedWorkouts, backfill.removedActivitySummaries,
      backfill.removedEligibleSessions, backfill.removedCalibrationSessions]
      .every((value) => Number.isInteger(value) && value >= 0) &&
    backfill.preservedAbsent === true &&
    backfill.removedRecords === 0 && backfill.removedWorkouts === 0 &&
    backfill.removedActivitySummaries === 0 && backfill.removedEligibleSessions === 0 &&
    backfill.removedCalibrationSessions === 0 && backfill.earliestInsertedIsNewGlobalEarliest === true;

  if (transition !== "unknown") {
    if (metrics.eligibleSessionDelta > thresholds.maxEligibleSessionDelta) {
      if (verifiedBackfill) {
        migrationReport.push(
          `source_backfill_eligible_session_delta:${formatMetric(metrics.eligibleSessionDelta)}`
        );
      } else {
        failureReasons.push("eligible_session_delta");
      }
    }
    if (metrics.assessmentStatusChangeRate > thresholds.maxStatusChangeRate) {
      if (verifiedBackfill) {
        migrationReport.push(
          `source_backfill_assessment_status_change_rate:${formatMetric(metrics.assessmentStatusChangeRate)}`
        );
      } else {
        failureReasons.push("assessment_status_change_rate");
      }
    }

    if (transition === "same_scale") {
      if (exceeds(metrics.currentAbilityMeanAbsoluteDelta, thresholds.maxCurrentAbilityMeanAbsoluteDelta)) {
        failureReasons.push("current_ability_mean_absolute_delta");
      }
      if (exceeds(metrics.currentAbilityP95AbsoluteDelta, thresholds.maxCurrentAbilityP95AbsoluteDelta)) {
        failureReasons.push("current_ability_p95_absolute_delta");
      }
      if (exceedsAbsolute(metrics.finalTrueAbilityDelta, thresholds.maxFinalTrueAbilityDelta)) {
        failureReasons.push("final_true_ability_delta");
      }
      if (exceeds(metrics.recoveryNullRateDelta, thresholds.maxRecoveryNullRateDelta)) {
        failureReasons.push("recovery_null_rate_delta");
      }
      if (exceeds(metrics.recoverySaturationRate, thresholds.maxRecoverySaturationRate)) {
        failureReasons.push("recovery_saturation_rate");
      }
    } else {
      // A cross-scale release removes a dimension on purpose, so its old
      // distribution cannot be preserved. Record the movement for the migration
      // audit and gate on the replacement assertions instead.
      migrationReport.push(
        `current_ability_mean_absolute_delta:${formatMetric(metrics.currentAbilityMeanAbsoluteDelta)}`,
        `current_ability_p95_absolute_delta:${formatMetric(metrics.currentAbilityP95AbsoluteDelta)}`,
        `final_true_ability_delta:${formatMetric(metrics.finalTrueAbilityDelta)}`,
        `recovery_null_rate_delta:${formatMetric(metrics.recoveryNullRateDelta)}`,
        `recovery_saturation_rate:${formatMetric(metrics.recoverySaturationRate)}`
      );

      if (metrics.readinessOutputCoverage === null) {
        notEvaluableReasons.push("readiness_output_missing");
      } else if (metrics.readinessOutputCoverage < thresholds.minReadinessOutputCoverage) {
        failureReasons.push("readiness_output_coverage");
      }
      if (metrics.recoveryIsolationHolds === null) {
        notEvaluableReasons.push("recovery_isolation_not_run");
      } else if (!metrics.recoveryIsolationHolds) {
        failureReasons.push("recovery_isolation_violated");
      }
    }
  }

  const status: ModelTransitionGateStatus =
    failureReasons.length > 0 ? "failed" : notEvaluableReasons.length > 0 ? "not_evaluable" : "passed";

  return {
    ...(empty === undefined ? {} : { emptyCohort: empty }),
    ...(backfill === undefined ? {} : { sourceBackfill: backfill }),
    candidateModelRunId: input.candidateModelRunId,
    baseModelRunId: input.baseModelRunId,
    gateVersion: MODEL_TRANSITION_GATE_VERSION,
    status,
    transition,
    blocksActivation: status !== "passed",
    thresholds,
    metrics,
    failureReasons,
    migrationReport,
    notEvaluableReasons
  };
}

function classifyTransition(schema: ModelTransitionSchemaContext): ModelTransitionKind {
  const versions = [
    schema.baseModelVersion,
    schema.candidateModelVersion,
    schema.baseFeatureSchemaVersion,
    schema.candidateFeatureSchemaVersion
  ];
  if (versions.some((value) => value === null || value === "")) return "unknown";
  const knownEpochs = schema.baseScaleId != null && schema.candidateScaleId != null;
  const sameScale = schema.baseFeatureSchemaVersion === schema.candidateFeatureSchemaVersion &&
    (knownEpochs ? schema.baseScaleId === schema.candidateScaleId
      : schema.baseModelVersion === schema.candidateModelVersion);
  return sameScale ? "same_scale" : "cross_scale";
}

function nonFiniteMetricNames(metrics: ModelTransitionMetricsV2): string[] {
  const offenders: string[] = [];
  for (const [name, value] of Object.entries(metrics)) {
    if (typeof value === "number" && !Number.isFinite(value)) offenders.push(name);
  }
  return offenders;
}

const exceeds = (value: number | null, limit: number): boolean => value !== null && value > limit;

const exceedsAbsolute = (value: number | null, limit: number): boolean =>
  value !== null && Math.abs(value) > limit;

/** Records "absent" distinctly from a real zero, so the audit trail stays honest. */
const formatMetric = (value: number | null): string => (value === null ? "null" : String(value));
