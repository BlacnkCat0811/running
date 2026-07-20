import type { DatabaseSync } from "node:sqlite";

import { nullableNumber } from "./read-utils.js";

export interface StoredDataSummary {
  datasetVersion: string | null;
  importCompletedAt: string | null;
  counts: {
    healthRecords: number;
    workouts: number;
    trainingSessions: number;
    routePoints: number;
    assessments: number;
  };
  issues: Array<{ severity: string; count: number }>;
}

export interface StoredDataAudit {
  datasetVersion: string | null;
  importCompletedAt: string | null;
  ranges: {
    healthRecords: { first: string | null; last: string | null };
    workouts: { first: string | null; last: string | null };
  };
  canonical: {
    healthRecords: number;
    workouts: number;
    canonicalWorkouts: number;
    workoutGroups: number;
    trainingSessions: number;
    routes: number;
    routePoints: number;
  };
  featureQuality: {
    averageQualityScore: number | null;
    averageHeartRateCoverage: number | null;
    minimumHeartRateCoverage: number | null;
    maximumHeartRateCoverage: number | null;
  };
  recordTypes: Array<{ type: string; count: number }>;
  sourceCategories: Array<{ category: string; count: number }>;
  sessionStatuses: Array<{ status: string; count: number }>;
  missingReasons: Array<{ reason: string; count: number }>;
  issues: Array<{ severity: string; code: string; count: number }>;
}

export interface StoredDiagnosticsActiveModel {
  id: string;
  modelVersion: string;
  modelConfigHash: string;
  featureRunId: string;
  summaryJson: string | null;
}

export class SqliteAuditReadRepository {
  constructor(private readonly database: DatabaseSync) {}

  private manifestMap(): Map<string, string> {
    const manifestRows = this.database
      .prepare("SELECT key, value FROM import_manifest")
      .all() as Array<{ key: string; value: string }>;
    return new Map(manifestRows.map((row) => [row.key, row.value]));
  }

  dataSummary(): StoredDataSummary {
    const manifest = this.manifestMap();
    const counts = this.database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM health_records) AS health_records,
          (SELECT COUNT(*) FROM workouts) AS workouts,
          (SELECT COUNT(*) FROM training_sessions) AS training_sessions,
          (SELECT COUNT(*) FROM route_points) AS route_points,
          (SELECT COUNT(*) FROM active_ability_assessments) AS assessments
      `)
      .get() as Record<string, unknown>;
    const issues = this.database
      .prepare("SELECT severity, COUNT(*) AS count FROM import_issues GROUP BY severity ORDER BY severity")
      .all() as Record<string, unknown>[];
    return {
      datasetVersion: manifest.get("dataset_version") ?? null,
      importCompletedAt: manifest.get("import_completed_at") ?? null,
      counts: {
        healthRecords: Number(counts.health_records ?? 0),
        workouts: Number(counts.workouts ?? 0),
        trainingSessions: Number(counts.training_sessions ?? 0),
        routePoints: Number(counts.route_points ?? 0),
        assessments: Number(counts.assessments ?? 0)
      },
      issues: issues.map((row) => ({ severity: String(row.severity), count: Number(row.count) }))
    };
  }

  dataAudit(): StoredDataAudit {
    const manifest = this.manifestMap();
    const ranges = this.database
      .prepare(`
        SELECT
          (SELECT MIN(start_at) FROM health_records) AS first_record,
          (SELECT MAX(end_at) FROM health_records) AS last_record,
          (SELECT MIN(start_at) FROM workouts) AS first_workout,
          (SELECT MAX(end_at) FROM workouts) AS last_workout
      `)
      .get() as Record<string, unknown>;
    const canonical = this.database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM health_records) AS health_records,
          (SELECT COUNT(*) FROM workouts) AS workouts,
          (SELECT COUNT(*) FROM workouts WHERE is_canonical = 1) AS canonical_workouts,
          (SELECT COUNT(*) FROM workout_groups) AS workout_groups,
          (SELECT COUNT(*) FROM training_sessions) AS training_sessions,
          (SELECT COUNT(*) FROM workout_routes) AS routes,
          (SELECT COUNT(*) FROM route_points) AS route_points
      `)
      .get() as Record<string, unknown>;
    const quality = this.database
      .prepare(`
        SELECT
          AVG(f.quality_score) AS average_quality_score,
          AVG(f.heart_rate_coverage) AS average_hr_coverage,
          MIN(f.heart_rate_coverage) AS minimum_hr_coverage,
          MAX(f.heart_rate_coverage) AS maximum_hr_coverage
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
      `)
      .get() as Record<string, unknown>;
    const grouped = (sql: string): Record<string, unknown>[] =>
      this.database.prepare(sql).all() as Record<string, unknown>[];

    return {
      datasetVersion: manifest.get("dataset_version") ?? null,
      importCompletedAt: manifest.get("import_completed_at") ?? null,
      ranges: {
        healthRecords: {
          first: typeof ranges.first_record === "string" ? ranges.first_record : null,
          last: typeof ranges.last_record === "string" ? ranges.last_record : null
        },
        workouts: {
          first: typeof ranges.first_workout === "string" ? ranges.first_workout : null,
          last: typeof ranges.last_workout === "string" ? ranges.last_workout : null
        }
      },
      canonical: {
        healthRecords: Number(canonical.health_records ?? 0),
        workouts: Number(canonical.workouts ?? 0),
        canonicalWorkouts: Number(canonical.canonical_workouts ?? 0),
        workoutGroups: Number(canonical.workout_groups ?? 0),
        trainingSessions: Number(canonical.training_sessions ?? 0),
        routes: Number(canonical.routes ?? 0),
        routePoints: Number(canonical.route_points ?? 0)
      },
      featureQuality: {
        averageQualityScore: nullableNumber(quality.average_quality_score),
        averageHeartRateCoverage: nullableNumber(quality.average_hr_coverage),
        minimumHeartRateCoverage: nullableNumber(quality.minimum_hr_coverage),
        maximumHeartRateCoverage: nullableNumber(quality.maximum_hr_coverage)
      },
      recordTypes: grouped(`
        SELECT type, COUNT(*) AS count
        FROM health_records
        GROUP BY type
        ORDER BY count DESC, type
        LIMIT 24
      `).map((row) => ({ type: String(row.type), count: Number(row.count) })),
      sourceCategories: grouped(`
        SELECT source_category, COUNT(*) AS count
        FROM workouts
        GROUP BY source_category
        ORDER BY count DESC, source_category
      `).map((row) => ({ category: String(row.source_category), count: Number(row.count) })),
      sessionStatuses: grouped(`
        SELECT status, COUNT(*) AS count
        FROM training_sessions
        GROUP BY status
        ORDER BY count DESC, status
      `).map((row) => ({ status: String(row.status), count: Number(row.count) })),
      missingReasons: grouped(`
        SELECT reasons.value AS reason, COUNT(*) AS count
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        JOIN json_each(f.missing_reasons_json) reasons
        GROUP BY reasons.value
        ORDER BY count DESC, reason
      `).map((row) => ({ reason: String(row.reason), count: Number(row.count) })),
      issues: grouped(`
        SELECT severity, code, COUNT(*) AS count
        FROM import_issues
        GROUP BY severity, code
        ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, count DESC, code
      `).map((row) => ({
        severity: String(row.severity),
        code: String(row.code),
        count: Number(row.count)
      }))
    };
  }

  diagnosticsActiveModel(): StoredDiagnosticsActiveModel | null {
    const active = this.database
      .prepare(`
        SELECT mr.id, mr.feature_run_id, mr.model_version, mr.model_config_hash, mr.summary_json
        FROM model_runs mr
        JOIN active_model_run amr ON amr.model_run_id = mr.id
      `)
      .get() as Record<string, unknown> | undefined;
    if (!active) return null;
    return {
      id: String(active.id),
      modelVersion: String(active.model_version),
      modelConfigHash: String(active.model_config_hash),
      featureRunId: String(active.feature_run_id),
      summaryJson: typeof active.summary_json === "string" ? active.summary_json : null
    };
  }
}
