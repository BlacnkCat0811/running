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
//   zero matched sessions                     -> not_evaluable, never a pass
//
// `invalidValueCount > 0`, non-finite metrics and eligibility drift always fail,
// on both scales.
//
// Design: deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md §14.5.
//
// Persistence is deliberately out of scope here. `model_validation_gates.status`
// is CHECK-constrained to ('passed','failed','skipped'), so `not_evaluable`
// cannot be stored without its own migration, and writing it as 'skipped' would
// read as "no base run". This module therefore stays a pure decision function;
// wiring it into the recompute pipeline lands with that migration.

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

export interface ModelTransitionGateInput {
  candidateModelRunId: string;
  baseModelRunId: string | null;
  schema: ModelTransitionSchemaContext;
  metrics: ModelTransitionMetricsV2;
  /** Defaults to `MODEL_TRANSITION_GATE_THRESHOLDS_V2`. */
  thresholds?: ModelTransitionGateThresholdsV2;
}

export interface ModelTransitionGateResultV2 {
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
  if (metrics.matchedSessions === 0) notEvaluableReasons.push("no_matched_sessions");

  if (transition !== "unknown") {
    if (metrics.eligibleSessionDelta > thresholds.maxEligibleSessionDelta) {
      failureReasons.push("eligible_session_delta");
    }
    if (metrics.assessmentStatusChangeRate > thresholds.maxStatusChangeRate) {
      failureReasons.push("assessment_status_change_rate");
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
