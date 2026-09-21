import type { DatabaseSync } from "node:sqlite";

import { MODEL_RUN_SUMMARY_SELECT } from "./sql/fragments.js";

export interface StoredModelRunSummary {
  id: string;
  featureRunId: string;
  datasetVersion: string;
  modelVersion: string;
  modelConfigHash: string;
  evaluatedAt: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  featureCount: number | null;
  assessmentCount: number;
  snapshotCount: number;
  active: boolean;
}

export interface ModelValidationGateResult {
  candidateModelRunId: string;
  baseModelRunId: string | null;
  gateVersion: string;
  status: "passed" | "failed" | "skipped";
  metrics: {
    baseModelVersion?: string | null;
    candidateModelVersion?: string | null;
    matchedSessions: number;
    baseEligibleSessions: number;
    candidateEligibleSessions: number;
    eligibleSessionDelta: number;
    recoveryNullRateBase: number | null;
    recoveryNullRateCandidate: number | null;
    recoveryNullRateDelta: number | null;
    recoverySaturationRate: number | null;
    currentAbilityMeanAbsoluteDelta: number | null;
    currentAbilityP95AbsoluteDelta: number | null;
    finalTrueAbilityDelta: number | null;
    assessmentStatusChanged: number;
    assessmentStatusChangeRate?: number;
    invalidValueCount: number;
  };
  thresholds: Record<string, number>;
  failureReasons: string[];
}

export class ModelRunActivationError extends Error {
  constructor(
    readonly code: "not_found" | "not_succeeded" | "missing_metrics" | "failed_gate",
    message: string
  ) {
    super(message);
  }
}

export class SqliteModelRunRepository {
  constructor(private readonly database: DatabaseSync) {}

  listSummaries(limit = 30): StoredModelRunSummary[] {
    return (this.database.prepare(`
      SELECT ${MODEL_RUN_SUMMARY_SELECT}
      FROM model_runs mr
      LEFT JOIN active_model_run amr ON amr.model_run_id = mr.id
      ORDER BY mr.created_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[]).map(mapModelRunSummary);
  }

  activeSummary(): StoredModelRunSummary | null {
    const row = this.database.prepare(`
      SELECT ${MODEL_RUN_SUMMARY_SELECT}
      FROM model_runs mr
      JOIN active_model_run amr ON amr.model_run_id = mr.id
    `).get() as Record<string, unknown> | undefined;
    // Force active=1 when joined through active_model_run.
    if (!row) return null;
    return mapModelRunSummary({ ...row, active: 1 });
  }

  getSummariesByIds(ids: string[]): StoredModelRunSummary[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return (this.database.prepare(`
      SELECT ${MODEL_RUN_SUMMARY_SELECT}
      FROM model_runs mr
      LEFT JOIN active_model_run amr ON amr.model_run_id = mr.id
      WHERE mr.id IN (${placeholders})
    `).all(...ids) as Record<string, unknown>[]).map(mapModelRunSummary);
  }

  featureRunId(modelRunId: string): string | null {
    const row = this.database.prepare("SELECT feature_run_id AS featureRunId FROM model_runs WHERE id = ?")
      .get(modelRunId) as { featureRunId: string } | undefined;
    return row?.featureRunId ?? null;
  }

  activateSucceeded(modelRunId: string, activatedAt: string): void {
    const model = this.database.prepare("SELECT status FROM model_runs WHERE id = ?")
      .get(modelRunId) as { status: string } | undefined;
    if (!model) throw new ModelRunActivationError("not_found", "Model run was not found");
    if (model.status !== "succeeded") {
      throw new ModelRunActivationError("not_succeeded", "Only succeeded model runs can become active");
    }
    const metricRun = this.database.prepare("SELECT status FROM training_metric_runs WHERE model_run_id = ?")
      .get(modelRunId) as { status: string } | undefined;
    if (metricRun?.status !== "succeeded") {
      throw new ModelRunActivationError("missing_metrics", "Model run requires a succeeded training metric run before activation");
    }
    // A candidate explicitly evaluated by the production model-version gate may not
    // bypass a failed result, including through the manual activation API.
    const hasGateTable = this.database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_validation_gates'")
      .get();
    if (hasGateTable) {
      const failedGate = this.database.prepare(`
        SELECT 1 FROM model_validation_gates
        WHERE candidate_model_run_id = ? AND status = 'failed'
        ORDER BY created_at DESC LIMIT 1
      `).get(modelRunId);
      if (failedGate) throw new ModelRunActivationError("failed_gate", "Model run failed the model-version gate and cannot become active");
    }
    this.database.prepare(`
      INSERT INTO active_model_run (singleton, model_run_id, activated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        model_run_id = excluded.model_run_id,
        activated_at = excluded.activated_at
    `).run(modelRunId, activatedAt);
    // Ability/feature rebuild changes residual baselines; drop active CatBoost until retrain.
    this.clearActivePredictionModel();
  }

  clearActivePredictionModel(): void {
    this.database.exec("DELETE FROM active_prediction_model");
  }

  /** Compare a candidate replay with the currently active model and persist an auditable gate result. */
  evaluateValidationGate(candidateId: string, baseId: string | null): ModelValidationGateResult {
    const gateVersion = "rai-shadow-gate-v1";
    const thresholds = {
      maxRecoveryNullRateDelta: 0.1,
      maxEligibleSessionDelta: 0.05,
      maxCurrentAbilityMeanAbsoluteDelta: 8,
      maxCurrentAbilityP95AbsoluteDelta: 15,
      maxFinalTrueAbilityDelta: 10,
      maxStatusChangeRate: 0.1,
      maxRecoverySaturationRate: 0.2
    };
    if (!baseId || baseId === candidateId) {
      const result: ModelValidationGateResult = {
        candidateModelRunId: candidateId,
        baseModelRunId: null,
        gateVersion,
        status: "skipped",
        metrics: {
          matchedSessions: 0, baseEligibleSessions: 0, candidateEligibleSessions: 0,
          eligibleSessionDelta: 0, recoveryNullRateBase: null, recoveryNullRateCandidate: null,
          recoveryNullRateDelta: null, recoverySaturationRate: null,
          currentAbilityMeanAbsoluteDelta: null, currentAbilityP95AbsoluteDelta: null,
          finalTrueAbilityDelta: null, assessmentStatusChanged: 0, invalidValueCount: 0
        },
        thresholds,
        failureReasons: []
      };
      this.persistValidationGate(result);
      return result;
    }
    const hasOverrideTable = Boolean(this.database
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'effective_workout_overrides'")
      .get());
    const overrideExclusion = hasOverrideTable ? `
        AND NOT EXISTS (
          SELECT 1 FROM effective_workout_overrides override
          WHERE override.training_session_id = assessment.training_session_id
        )` : "";
    const row = (id: string) => this.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN assessment_status IN ('eligible','trial') THEN 1 ELSE 0 END) AS eligible,
        SUM(CASE WHEN current_ability IS NULL THEN 1 ELSE 0 END) AS ca_null,
        SUM(CASE WHEN recovery_score IS NULL THEN 1 ELSE 0 END) AS recovery_null,
        SUM(CASE WHEN recovery_score <= 0.001 OR recovery_score >= 99.999 THEN 1 ELSE 0 END) AS recovery_saturated,
        SUM(CASE WHEN current_ability IS NOT NULL AND (current_ability < 0 OR current_ability > 100) THEN 1 ELSE 0 END) AS invalid
      FROM ability_assessments assessment
      WHERE assessment.model_run_id = ?
        ${overrideExclusion}
    `).get(id) as Record<string, unknown>;
    const base = row(baseId);
    const candidate = row(candidateId);
    const versions = this.database.prepare("SELECT id, model_version AS modelVersion FROM model_runs WHERE id IN (?, ?)").all(baseId, candidateId) as Array<{ id: string; modelVersion: string }>;
    const baseVersion = versions.find((v) => v.id === baseId)?.modelVersion ?? null;
    const candidateVersion = versions.find((v) => v.id === candidateId)?.modelVersion ?? null;
    const comparison = this.compareMetrics(baseId, candidateId, hasOverrideTable);
    const del = (a: number, b: number): number => Math.abs(a - b) / Math.max(1, a);
    const baseTotal = Number(base.total ?? 0);
    const candTotal = Number(candidate.total ?? 0);
    const baseEligible = Number(base.eligible ?? 0);
    const candEligible = Number(candidate.eligible ?? 0);
    const baseNull = baseTotal > 0 ? Number(base.recovery_null ?? 0) / baseTotal : null;
    const candNull = candTotal > 0 ? Number(candidate.recovery_null ?? 0) / candTotal : null;
    const comparisonOverrideExclusion = hasOverrideTable ? `
        AND NOT EXISTS (
          SELECT 1 FROM effective_workout_overrides override
          WHERE override.training_session_id = b.training_session_id
        )` : "";
    const absDeltas = (this.database.prepare(`
      SELECT ABS(c.current_ability - b.current_ability) AS d
      FROM ability_assessments b JOIN ability_assessments c ON c.training_session_id = b.training_session_id
        WHERE b.model_run_id = ? AND c.model_run_id = ?
        AND b.current_ability IS NOT NULL AND c.current_ability IS NOT NULL
        ${comparisonOverrideExclusion}
      ORDER BY d
    `).all(baseId, candidateId) as Array<{ d: number }>).map((x) => Number(x.d)).filter(Number.isFinite);
    const p95 = absDeltas.length ? absDeltas[Math.min(absDeltas.length - 1, Math.floor(absDeltas.length * 0.95))] ?? null : null;
    const statusRate = comparison.matchedSessions > 0 ? comparison.assessmentStatusChanged / comparison.matchedSessions : 0;
    const metrics = {
      baseModelVersion: baseVersion,
      candidateModelVersion: candidateVersion,
      matchedSessions: comparison.matchedSessions,
      baseEligibleSessions: baseEligible,
      candidateEligibleSessions: candEligible,
      eligibleSessionDelta: del(baseEligible, candEligible),
      recoveryNullRateBase: baseNull,
      recoveryNullRateCandidate: candNull,
      recoveryNullRateDelta: baseNull !== null && candNull !== null ? candNull - baseNull : null,
      recoverySaturationRate: candTotal > 0 ? Number(candidate.recovery_saturated ?? 0) / candTotal : null,
      currentAbilityMeanAbsoluteDelta: comparison.currentAbilityMeanAbsoluteDelta,
      currentAbilityP95AbsoluteDelta: p95,
      finalTrueAbilityDelta: comparison.finalTrueAbilityDelta,
      assessmentStatusChanged: comparison.assessmentStatusChanged,
      assessmentStatusChangeRate: statusRate,
      invalidValueCount: Number(candidate.invalid ?? 0)
    };
    const failureReasons: string[] = [];
    if (metrics.recoveryNullRateDelta !== null && metrics.recoveryNullRateDelta > thresholds.maxRecoveryNullRateDelta) failureReasons.push("recovery_null_rate_delta");
    if (metrics.eligibleSessionDelta > thresholds.maxEligibleSessionDelta) failureReasons.push("eligible_session_delta");
    if (metrics.currentAbilityMeanAbsoluteDelta !== null && metrics.currentAbilityMeanAbsoluteDelta > thresholds.maxCurrentAbilityMeanAbsoluteDelta) failureReasons.push("current_ability_mean_absolute_delta");
    if (metrics.currentAbilityP95AbsoluteDelta !== null && metrics.currentAbilityP95AbsoluteDelta > thresholds.maxCurrentAbilityP95AbsoluteDelta) failureReasons.push("current_ability_p95_absolute_delta");
    if (metrics.finalTrueAbilityDelta !== null && Math.abs(metrics.finalTrueAbilityDelta) > thresholds.maxFinalTrueAbilityDelta) failureReasons.push("final_true_ability_delta");
    if (statusRate > thresholds.maxStatusChangeRate) failureReasons.push("assessment_status_change_rate");
    if (metrics.recoverySaturationRate !== null && metrics.recoverySaturationRate > thresholds.maxRecoverySaturationRate) failureReasons.push("recovery_saturation_rate");
    if (metrics.invalidValueCount > 0) failureReasons.push("invalid_values");
    const result: ModelValidationGateResult = {
      candidateModelRunId: candidateId, baseModelRunId: baseId, gateVersion,
      status: failureReasons.length ? "failed" : "passed", metrics, thresholds, failureReasons
    };
    this.persistValidationGate(result);
    return result;
  }

  private persistValidationGate(result: ModelValidationGateResult): void {
    this.database.prepare(`
      INSERT INTO model_validation_gates
        (id, candidate_model_run_id, base_model_run_id, gate_version, status, metrics_json, thresholds_json, failure_reasons_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_model_run_id, gate_version) DO UPDATE SET
        base_model_run_id = excluded.base_model_run_id, status = excluded.status,
        metrics_json = excluded.metrics_json, thresholds_json = excluded.thresholds_json,
        failure_reasons_json = excluded.failure_reasons_json, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(
      `validation_gate-${result.candidateModelRunId}-${result.gateVersion}`,
      result.candidateModelRunId, result.baseModelRunId, result.gateVersion, result.status,
      JSON.stringify(result.metrics), JSON.stringify(result.thresholds), JSON.stringify(result.failureReasons)
    );
  }

  latestValidationGate(candidateId: string): ModelValidationGateResult | null {
    const row = this.database.prepare(`
      SELECT candidate_model_run_id AS candidateModelRunId,
        base_model_run_id AS baseModelRunId, gate_version AS gateVersion,
        status, metrics_json AS metricsJson, thresholds_json AS thresholdsJson,
        failure_reasons_json AS failureReasonsJson
      FROM model_validation_gates
      WHERE candidate_model_run_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(candidateId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      candidateModelRunId: String(row.candidateModelRunId),
      baseModelRunId: row.baseModelRunId ? String(row.baseModelRunId) : null,
      gateVersion: String(row.gateVersion),
      status: String(row.status) as ModelValidationGateResult["status"],
      metrics: JSON.parse(String(row.metricsJson)) as ModelValidationGateResult["metrics"],
      thresholds: JSON.parse(String(row.thresholdsJson)) as Record<string, number>,
      failureReasons: JSON.parse(String(row.failureReasonsJson)) as string[]
    };
  }

  compareMetrics(baseId: string, candidateId: string, excludeOverridden = false): {
    matchedSessions: number;
    currentAbilityMeanDelta: number | null;
    currentAbilityMeanAbsoluteDelta: number | null;
    confidenceMeanDelta: number | null;
    assessmentStatusChanged: number;
    finalTrueAbilityDelta: number | null;
    topChangedWorkouts: Array<{
      trainingSessionId: string;
      startedAt: string;
      baseCurrentAbility: number | null;
      candidateCurrentAbility: number | null;
      delta: number | null;
    }>;
  } {
    const overrideExclusion = excludeOverridden ? `
          AND NOT EXISTS (
            SELECT 1 FROM effective_workout_overrides override
            WHERE override.training_session_id = b.training_session_id
          )` : "";
    const metrics = this.database
      .prepare(`
        SELECT
          COUNT(*) AS matched_sessions,
          AVG(c.current_ability - b.current_ability) AS ca_mean_delta,
          AVG(ABS(c.current_ability - b.current_ability)) AS ca_mean_abs_delta,
          AVG(c.confidence - b.confidence) AS confidence_mean_delta,
          SUM(CASE WHEN c.assessment_status <> b.assessment_status THEN 1 ELSE 0 END) AS status_changed
        FROM ability_assessments b
        JOIN ability_assessments c ON c.training_session_id = b.training_session_id
        WHERE b.model_run_id = ? AND c.model_run_id = ?
          ${overrideExclusion}
      `)
      .get(baseId, candidateId) as Record<string, unknown>;
    const finalSnapshot = (modelRunId: string): number | null => {
      const row = this.database
        .prepare(`
          SELECT true_ability
          FROM daily_ability_snapshots
          WHERE model_run_id = ?
          ORDER BY local_date DESC
          LIMIT 1
        `)
        .get(modelRunId) as Record<string, unknown> | undefined;
      const value = row?.true_ability;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    const baseFinal = finalSnapshot(baseId);
    const candidateFinal = finalSnapshot(candidateId);
    const changes = this.database
      .prepare(`
        SELECT
          b.training_session_id,
          ts.anchor_start_at,
          b.current_ability AS base_ca,
          c.current_ability AS candidate_ca,
          c.current_ability - b.current_ability AS delta
        FROM ability_assessments b
        JOIN ability_assessments c ON c.training_session_id = b.training_session_id
        JOIN training_sessions ts ON ts.id = b.training_session_id
        WHERE b.model_run_id = ? AND c.model_run_id = ?
          AND b.current_ability IS NOT NULL AND c.current_ability IS NOT NULL
        ORDER BY ABS(c.current_ability - b.current_ability) DESC, ts.anchor_start_at DESC
        LIMIT 10
      `)
      .all(baseId, candidateId) as Record<string, unknown>[];
    const asNumber = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return {
      matchedSessions: Number(metrics.matched_sessions ?? 0),
      currentAbilityMeanDelta: asNumber(metrics.ca_mean_delta),
      currentAbilityMeanAbsoluteDelta: asNumber(metrics.ca_mean_abs_delta),
      confidenceMeanDelta: asNumber(metrics.confidence_mean_delta),
      assessmentStatusChanged: Number(metrics.status_changed ?? 0),
      finalTrueAbilityDelta:
        baseFinal !== null && candidateFinal !== null ? candidateFinal - baseFinal : null,
      topChangedWorkouts: changes.map((row) => ({
        trainingSessionId: String(row.training_session_id),
        startedAt: String(row.anchor_start_at),
        baseCurrentAbility: asNumber(row.base_ca),
        candidateCurrentAbility: asNumber(row.candidate_ca),
        delta: asNumber(row.delta)
      }))
    };
  }
}

export function mapModelRunSummary(row: Record<string, unknown>): StoredModelRunSummary {
  let featureCount: number | null = null;
  try {
    const summary = JSON.parse(String(row.summary_json)) as { featureCount?: unknown };
    if (typeof summary.featureCount === "number") featureCount = summary.featureCount;
  } catch {
    // Malformed legacy summaries do not invalidate the model-run list.
  }
  return {
    id: String(row.id),
    featureRunId: String(row.feature_run_id),
    datasetVersion: String(row.dataset_version),
    modelVersion: String(row.model_version),
    modelConfigHash: String(row.model_config_hash),
    evaluatedAt: String(row.evaluated_at),
    status: String(row.status),
    createdAt: String(row.created_at),
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    featureCount,
    assessmentCount: Number(row.assessment_count ?? 0),
    snapshotCount: Number(row.snapshot_count ?? 0),
    active: Number(row.active) === 1
  };
}
