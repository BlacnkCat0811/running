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
    if (model?.status !== "succeeded") throw new Error("Only succeeded model runs can become active");
    const metricRun = this.database.prepare("SELECT status FROM training_metric_runs WHERE model_run_id = ?")
      .get(modelRunId) as { status: string } | undefined;
    if (metricRun?.status !== "succeeded") {
      throw new Error("Model run requires a succeeded training metric run before activation");
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

  compareMetrics(baseId: string, candidateId: string): {
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
