import { migrateModelV2 } from "./v2-migration.js";
import { migrateModelV24 } from "./v24-migration.js";
import { migrateModelV25 } from "./v25-migration.js";
import { migrateModelV26 } from "./v26-migration.js";
import { migrateModelV27 } from "./v27-migration.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statfsSync, statSync } from "node:fs";
import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";

import type {
  CanonicalHealthRecord,
  CanonicalWorkout,
  ImportIssue,
  RoutePoint
} from "@rai/contracts";

export interface RouteImportTarget {
  id: string;
  relativePath: string;
}

interface Migration {
  version: number;
  name: string;
  up: (database: DatabaseSync) => void;
}

export interface RaiDatabaseOpenOptions {
  createMigrationBackup?: boolean;
  migrationPolicy?: "apply" | "refuse";
  /**
   * Defaults to strict validation on every open. API request-scoped writers may
   * opt into checking only when this open actually applies a migration, after a
   * strict startup validation has already established the database boundary.
   */
  foreignKeyValidation?: "always" | "after-migration";
}

export class PendingMigrationsError extends Error {
  readonly versions: number[];
  readonly names: string[];

  constructor(path: string, pending: Array<{ version: number; name: string }>) {
    super(`数据库需要显式迁移（${pending.map((item) => item.version).join(", ")}）。停止 API 后执行：npm run data:migrate -- --database ${JSON.stringify(path)} --apply`);
    this.name = "PendingMigrationsError";
    this.versions = pending.map((item) => item.version);
    this.names = pending.map((item) => item.name);
  }
}

/**
 * Read-only projection of what a non-preserving `finalizeImportGeneration`
 * would delete. Used to refuse an import payload that silently omits data.
 */
export interface GenerationRemovalPreview {
  records: number;
  workouts: number;
  activitySummaries: number;
  total: number;
}

/**
 * Outcome of pruning superseded recomputation runs. Every count is a number of
 * rows physically removed from the database.
 */
export interface SupersededRunPruneResult {
  modelRuns: number;
  featureRuns: number;
  trainingMetricRuns: number;
  /** Derived rows removed across snapshots, assessments, loads, zones, checkpoints. */
  derivedRows: number;
  /** Jobs kept for audit but detached from the run they produced. */
  detachedJobs: number;
  /** Runs preserved: the active run, its ancestry, and the retention window. */
  retainedModelRuns: number;
  /** Retained runs reachable through the active/retained model lineage. */
  retainedByLineage: number;
  /** Retained runs selected by the recent-run window before lineage expansion. */
  retainedByRecentWindow: number;
}

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
/** Placeholder content hash for cold-start generation seeds (not a real body hash). */
export const SEED_CONTENT_HASH = "__seed_unknown__";

/** Align with health-export-parser normalizeRelativePath (lowercase, forward slashes). */
function normalizeRouteRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_canonical_health_schema",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS import_manifest (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profile (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          attributes_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS health_records (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          source_name TEXT NOT NULL,
          source_category TEXT NOT NULL,
          source_version TEXT,
          device TEXT,
          unit TEXT,
          value_numeric REAL,
          value_text TEXT,
          start_at TEXT NOT NULL,
          end_at TEXT NOT NULL,
          created_at TEXT,
          metadata_json TEXT NOT NULL,
          raw_attributes_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_health_records_type_time
          ON health_records(type, start_at, end_at);
        CREATE INDEX IF NOT EXISTS idx_health_records_source_time
          ON health_records(source_name, start_at, end_at);

        CREATE TABLE IF NOT EXISTS workouts (
          id TEXT PRIMARY KEY,
          activity_type TEXT NOT NULL,
          source_name TEXT NOT NULL,
          source_category TEXT NOT NULL,
          source_version TEXT,
          device TEXT,
          start_at TEXT NOT NULL,
          end_at TEXT NOT NULL,
          created_at TEXT,
          duration_seconds REAL NOT NULL,
          indoor INTEGER CHECK (indoor IN (0, 1)),
          metadata_json TEXT NOT NULL,
          raw_attributes_json TEXT NOT NULL,
          canonical_group_id TEXT,
          is_canonical INTEGER NOT NULL DEFAULT 0 CHECK (is_canonical IN (0, 1))
        );

        CREATE INDEX IF NOT EXISTS idx_workouts_type_time
          ON workouts(activity_type, start_at, end_at);

        CREATE TABLE IF NOT EXISTS workout_statistics (
          workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          type TEXT NOT NULL,
          start_at TEXT,
          end_at TEXT,
          unit TEXT,
          sum_value REAL,
          average_value REAL,
          minimum_value REAL,
          maximum_value REAL,
          PRIMARY KEY (workout_id, ordinal)
        );

        CREATE INDEX IF NOT EXISTS idx_workout_statistics_type
          ON workout_statistics(type, workout_id);

        CREATE TABLE IF NOT EXISTS workout_events (
          workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          type TEXT NOT NULL,
          event_at TEXT,
          duration_seconds REAL,
          metadata_json TEXT NOT NULL,
          PRIMARY KEY (workout_id, ordinal)
        );

        CREATE TABLE IF NOT EXISTS workout_routes (
          id TEXT PRIMARY KEY,
          workout_id TEXT REFERENCES workouts(id) ON DELETE CASCADE,
          source_name TEXT,
          source_category TEXT NOT NULL,
          source_version TEXT,
          start_at TEXT,
          end_at TEXT,
          created_at TEXT,
          relative_path TEXT UNIQUE,
          metadata_json TEXT NOT NULL,
          point_count INTEGER NOT NULL DEFAULT 0,
          file_status TEXT NOT NULL DEFAULT 'pending'
        );

        CREATE TABLE IF NOT EXISTS route_points (
          route_id TEXT NOT NULL REFERENCES workout_routes(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          timestamp TEXT,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          elevation_meters REAL,
          speed_mps REAL,
          course_degrees REAL,
          horizontal_accuracy_meters REAL,
          vertical_accuracy_meters REAL,
          PRIMARY KEY (route_id, sequence)
        );

        CREATE INDEX IF NOT EXISTS idx_route_points_time
          ON route_points(route_id, timestamp);

        CREATE TABLE IF NOT EXISTS activity_summaries (
          date_components TEXT PRIMARY KEY,
          attributes_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS entity_inventory (
          entity_kind TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          item_count INTEGER NOT NULL,
          first_at TEXT,
          last_at TEXT,
          details_json TEXT NOT NULL,
          PRIMARY KEY (entity_kind, entity_type)
        );

        CREATE TABLE IF NOT EXISTS import_issues (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          severity TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
          code TEXT NOT NULL,
          object_id TEXT,
          message TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workout_groups (
          id TEXT PRIMARY KEY,
          activity_type TEXT NOT NULL,
          canonical_workout_id TEXT NOT NULL REFERENCES workouts(id),
          member_count INTEGER NOT NULL,
          reason TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workout_group_members (
          group_id TEXT NOT NULL REFERENCES workout_groups(id) ON DELETE CASCADE,
          workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
          is_canonical INTEGER NOT NULL CHECK (is_canonical IN (0, 1)),
          canonical_rank REAL NOT NULL,
          PRIMARY KEY (group_id, workout_id)
        );
      `);
    }
  },
  {
    version: 2,
    name: "derived_ability_schema_and_stable_sessions",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS training_sessions (
          id TEXT PRIMARY KEY,
          activity_type TEXT NOT NULL,
          anchor_start_at TEXT NOT NULL,
          anchor_end_at TEXT NOT NULL,
          anchor_distance_km REAL,
          canonical_workout_id TEXT REFERENCES workouts(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'ambiguous')),
          created_at TEXT NOT NULL DEFAULT (${nowSql}),
          updated_at TEXT NOT NULL DEFAULT (${nowSql})
        );
      `);

      const groupColumns = database
        .prepare("PRAGMA table_info(workout_groups)")
        .all() as unknown as Array<{ name: string }>;
      if (!groupColumns.some((column) => column.name === "training_session_id")) {
        database.exec(
          "ALTER TABLE workout_groups ADD COLUMN training_session_id TEXT REFERENCES training_sessions(id) ON DELETE SET NULL"
        );
      }

      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workout_groups_training_session
          ON workout_groups(training_session_id)
          WHERE training_session_id IS NOT NULL;

        INSERT OR IGNORE INTO training_sessions (
          id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
          canonical_workout_id, status
        )
        SELECT
          'training_session_' || g.id,
          g.activity_type,
          w.start_at,
          w.end_at,
          CASE ws.unit
            WHEN 'km' THEN ws.sum_value
            WHEN 'm' THEN ws.sum_value / 1000.0
            WHEN 'mi' THEN ws.sum_value * 1.609344
            ELSE NULL
          END,
          g.canonical_workout_id,
          'active'
        FROM workout_groups g
        JOIN workouts w ON w.id = g.canonical_workout_id
        LEFT JOIN workout_statistics ws
          ON ws.workout_id = w.id
          AND ws.type = 'HKQuantityTypeIdentifierDistanceWalkingRunning'
          AND ws.ordinal = (
            SELECT MIN(inner_ws.ordinal)
            FROM workout_statistics inner_ws
            WHERE inner_ws.workout_id = w.id
              AND inner_ws.type = 'HKQuantityTypeIdentifierDistanceWalkingRunning'
          );

        UPDATE workout_groups
        SET training_session_id = 'training_session_' || id
        WHERE training_session_id IS NULL;

        CREATE INDEX IF NOT EXISTS idx_training_sessions_activity_time
          ON training_sessions(activity_type, anchor_start_at, anchor_end_at);

        CREATE TABLE IF NOT EXISTS feature_runs (
          id TEXT PRIMARY KEY,
          dataset_version TEXT NOT NULL,
          canonical_contract_version TEXT NOT NULL,
          feature_schema_version TEXT NOT NULL,
          feature_config_json TEXT NOT NULL,
          feature_config_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          created_at TEXT NOT NULL DEFAULT (${nowSql}),
          started_at TEXT,
          completed_at TEXT,
          failure_json TEXT,
          UNIQUE (dataset_version, canonical_contract_version, feature_schema_version, feature_config_hash, created_at)
        );

        CREATE TABLE IF NOT EXISTS workout_features (
          id TEXT PRIMARY KEY,
          feature_run_id TEXT NOT NULL REFERENCES feature_runs(id) ON DELETE CASCADE,
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          canonical_workout_id TEXT NOT NULL,
          workout_start_at TEXT NOT NULL,
          duration_seconds REAL NOT NULL,
          distance_km REAL,
          average_speed_mps REAL,
          average_heart_rate_bpm REAL,
          heart_rate_sample_count INTEGER NOT NULL DEFAULT 0,
          heart_rate_coverage REAL,
          route_point_count INTEGER NOT NULL DEFAULT 0,
          route_quality REAL,
          source_confidence REAL NOT NULL,
          session_type TEXT NOT NULL,
          session_type_source TEXT NOT NULL CHECK (session_type_source IN ('auto', 'override')),
          eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('eligible', 'trial', 'excluded')),
          quality_score REAL NOT NULL,
          missing_reasons_json TEXT NOT NULL,
          features_json TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (${nowSql}),
          UNIQUE (feature_run_id, training_session_id)
        );

        CREATE INDEX IF NOT EXISTS idx_workout_features_feature_run_start
          ON workout_features(feature_run_id, workout_start_at);
        CREATE INDEX IF NOT EXISTS idx_workout_features_session
          ON workout_features(training_session_id);

        CREATE TABLE IF NOT EXISTS model_runs (
          id TEXT PRIMARY KEY,
          feature_run_id TEXT NOT NULL REFERENCES feature_runs(id),
          dataset_version TEXT NOT NULL,
          model_version TEXT NOT NULL,
          model_config_json TEXT NOT NULL,
          model_config_hash TEXT NOT NULL,
          evaluated_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          created_at TEXT NOT NULL DEFAULT (${nowSql}),
          started_at TEXT,
          completed_at TEXT,
          summary_json TEXT,
          failure_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_model_runs_feature_run
          ON model_runs(feature_run_id, created_at);

        CREATE TABLE IF NOT EXISTS ability_assessments (
          id TEXT PRIMARY KEY,
          model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          feature_id TEXT NOT NULL REFERENCES workout_features(id),
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          sequence_number INTEGER NOT NULL,
          assessment_status TEXT NOT NULL CHECK (assessment_status IN ('eligible', 'trial', 'excluded', 'calibrating')),
          current_ability REAL,
          efficiency_score REAL,
          pace_score REAL,
          cardio_score REAL,
          stability_score REAL,
          recovery_score REAL,
          effective_weights_json TEXT NOT NULL,
          confidence REAL NOT NULL,
          confidence_factors_json TEXT NOT NULL,
          workout_contribution REAL,
          evidence_strength REAL,
          direction_factor REAL,
          growth_resistance REAL,
          true_ability_before REAL,
          true_ability_after REAL,
          true_ability_delta REAL,
          updated_true_ability INTEGER NOT NULL CHECK (updated_true_ability IN (0, 1)),
          explanation_codes_json TEXT NOT NULL,
          explanation_json TEXT NOT NULL,
          assessed_at TEXT NOT NULL,
          UNIQUE (model_run_id, training_session_id),
          UNIQUE (model_run_id, sequence_number)
        );

        CREATE INDEX IF NOT EXISTS idx_ability_assessments_model_sequence
          ON ability_assessments(model_run_id, sequence_number);

        CREATE TABLE IF NOT EXISTS daily_ability_snapshots (
          id TEXT PRIMARY KEY,
          model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          true_ability REAL,
          decay_points REAL NOT NULL DEFAULT 0,
          growth_velocity_per_week REAL,
          last_assessment_id TEXT REFERENCES ability_assessments(id),
          snapshot_status TEXT NOT NULL CHECK (snapshot_status IN ('calibrating', 'active', 'decay', 'no_data')),
          computed_at TEXT NOT NULL DEFAULT (${nowSql}),
          UNIQUE (model_run_id, local_date)
        );

        CREATE INDEX IF NOT EXISTS idx_daily_snapshots_model_date
          ON daily_ability_snapshots(model_run_id, local_date);

        CREATE TABLE IF NOT EXISTS workout_overrides (
          id TEXT PRIMARY KEY,
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          revision INTEGER NOT NULL,
          eligibility_override TEXT CHECK (eligibility_override IN ('include', 'exclude')),
          session_type TEXT,
          rpe INTEGER CHECK (rpe BETWEEN 1 AND 10),
          condition_tags_json TEXT NOT NULL DEFAULT '[]',
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (${nowSql}),
          UNIQUE (training_session_id, revision)
        );

        CREATE INDEX IF NOT EXISTS idx_workout_overrides_session_revision
          ON workout_overrides(training_session_id, revision DESC);

        CREATE TABLE IF NOT EXISTS recompute_jobs (
          id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL CHECK (job_type IN ('import', 'full_recompute', 'snapshot_refresh')),
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          dataset_version TEXT,
          feature_run_id TEXT REFERENCES feature_runs(id),
          model_run_id TEXT REFERENCES model_runs(id),
          request_json TEXT NOT NULL,
          progress_phase TEXT NOT NULL,
          progress_current INTEGER NOT NULL DEFAULT 0,
          progress_total INTEGER NOT NULL DEFAULT 0,
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
          error_json TEXT,
          created_at TEXT NOT NULL DEFAULT (${nowSql}),
          started_at TEXT,
          completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_recompute_jobs_status_created
          ON recompute_jobs(status, created_at);

        CREATE TABLE IF NOT EXISTS recompute_job_events (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES recompute_jobs(id) ON DELETE CASCADE,
          phase TEXT NOT NULL,
          progress_current INTEGER NOT NULL,
          progress_total INTEGER NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowSql})
        );

        CREATE INDEX IF NOT EXISTS idx_recompute_job_events_job
          ON recompute_job_events(job_id, created_at);

        CREATE TABLE IF NOT EXISTS active_model_run (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          model_run_id TEXT NOT NULL REFERENCES model_runs(id),
          activated_at TEXT NOT NULL DEFAULT (${nowSql})
        );

        CREATE VIEW IF NOT EXISTS effective_workout_overrides AS
        SELECT
          id,
          training_session_id,
          revision,
          eligibility_override,
          session_type,
          rpe,
          condition_tags_json,
          note,
          created_at
        FROM (
          SELECT
            workout_overrides.*,
            ROW_NUMBER() OVER (
              PARTITION BY training_session_id
              ORDER BY revision DESC
            ) AS row_number
          FROM workout_overrides
        )
        WHERE row_number = 1;

        CREATE VIEW IF NOT EXISTS active_ability_assessments AS
        SELECT assessment.*
        FROM ability_assessments assessment
        JOIN active_model_run active ON active.model_run_id = assessment.model_run_id;

        CREATE VIEW IF NOT EXISTS active_daily_ability_snapshots AS
        SELECT snapshot.*
        FROM daily_ability_snapshots snapshot
        JOIN active_model_run active ON active.model_run_id = snapshot.model_run_id;
      `);
    }
  },
  {
    version: 3,
    name: "structured_performance_protocol",
    up: (database) => {
      const columns = database
        .prepare("PRAGMA table_info(workout_overrides)")
        .all() as unknown as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "performance_protocol")) {
        database.exec(`
          ALTER TABLE workout_overrides
          ADD COLUMN performance_protocol TEXT CHECK (
            performance_protocol IN (
              'five_k_time_trial',
              'ten_k_time_trial',
              'thirty_min_threshold',
              'half_marathon_race',
              'other_race'
            )
          )
        `);
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_workout_overrides_performance_protocol
          ON workout_overrides(performance_protocol)
          WHERE performance_protocol IS NOT NULL;

        DROP VIEW IF EXISTS effective_workout_overrides;
        CREATE VIEW effective_workout_overrides AS
        SELECT
          id,
          training_session_id,
          revision,
          eligibility_override,
          session_type,
          performance_protocol,
          rpe,
          condition_tags_json,
          note,
          created_at
        FROM (
          SELECT
            workout_overrides.*,
            ROW_NUMBER() OVER (
              PARTITION BY training_session_id
              ORDER BY revision DESC
            ) AS row_number
          FROM workout_overrides
        )
        WHERE row_number = 1;
      `);
    }
  },
  {
    version: 4,
    name: "prediction_model_runs_and_direct_activation",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS prediction_model_runs (
          id TEXT PRIMARY KEY,
          algorithm TEXT NOT NULL CHECK (algorithm = 'catboost'),
          model_version TEXT NOT NULL,
          feature_schema_version TEXT NOT NULL,
          feature_schema_hash TEXT,
          training_data_hash TEXT,
          training_data_through_at TEXT NOT NULL,
          hyperparameters_json TEXT NOT NULL,
          request_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'queued', 'running', 'validating', 'succeeded', 'rejected', 'failed', 'cancelled'
          )),
          label_count INTEGER NOT NULL DEFAULT 0,
          label_count_by_distance_json TEXT NOT NULL DEFAULT '{}',
          holdout_prediction_count INTEGER NOT NULL DEFAULT 0,
          metrics_json TEXT,
          supported_distances_json TEXT NOT NULL DEFAULT '[]',
          artifact_path TEXT,
          artifact_sha256 TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
          failure_json TEXT,
          created_at TEXT NOT NULL DEFAULT (${nowSql}),
          started_at TEXT,
          completed_at TEXT,
          activated_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_prediction_model_runs_status_created
          ON prediction_model_runs(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_prediction_model_runs_completed
          ON prediction_model_runs(completed_at DESC);

        CREATE TABLE IF NOT EXISTS prediction_model_events (
          id TEXT PRIMARY KEY,
          prediction_model_run_id TEXT NOT NULL
            REFERENCES prediction_model_runs(id) ON DELETE CASCADE,
          phase TEXT NOT NULL,
          progress_current INTEGER NOT NULL DEFAULT 0,
          progress_total INTEGER NOT NULL DEFAULT 0,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowSql})
        );

        CREATE INDEX IF NOT EXISTS idx_prediction_model_events_run_created
          ON prediction_model_events(prediction_model_run_id, created_at);

        CREATE TABLE IF NOT EXISTS active_prediction_model (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          prediction_model_run_id TEXT NOT NULL
            REFERENCES prediction_model_runs(id),
          activated_at TEXT NOT NULL DEFAULT (${nowSql})
        );
      `);
    }
  },
  {
    version: 5,
    name: "prediction_model_worker_leases_and_single_flight",
    up: (database) => {
      database.exec(`
        ALTER TABLE prediction_model_runs ADD COLUMN worker_token TEXT;
        ALTER TABLE prediction_model_runs ADD COLUMN heartbeat_at TEXT;
        ALTER TABLE prediction_model_runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK (attempt_count >= 0);

        UPDATE prediction_model_runs
        SET status = 'queued', started_at = NULL, worker_token = NULL, heartbeat_at = NULL
        WHERE status IN ('running', 'validating');

        UPDATE prediction_model_runs
        SET status = 'failed', completed_at = ${nowSql},
          failure_json = '{"code":"superseded_during_migration"}'
        WHERE status IN ('queued', 'running', 'validating')
          AND id NOT IN (
            SELECT id FROM prediction_model_runs
            WHERE status IN ('queued', 'running', 'validating')
            ORDER BY created_at, id
            LIMIT 1
          );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_prediction_model_runs_single_flight
          ON prediction_model_runs ((1))
          WHERE status IN ('queued', 'running', 'validating');
        CREATE INDEX IF NOT EXISTS idx_prediction_model_runs_lease
          ON prediction_model_runs(status, heartbeat_at);
      `);
    }
  },
  {
    version: 6,
    name: "training_load_metrics_and_statistics_participation",
    up: (database) => {
      const overrideColumns = database
        .prepare("PRAGMA table_info(workout_overrides)")
        .all() as unknown as Array<{ name: string }>;
      if (!overrideColumns.some((column) => column.name === "statistics_participation")) {
        database.exec(`
          ALTER TABLE workout_overrides
          ADD COLUMN statistics_participation TEXT CHECK (
            statistics_participation IN ('include', 'exclude')
          )
        `);
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS training_metric_runs (
          id TEXT PRIMARY KEY,
          model_run_id TEXT NOT NULL UNIQUE REFERENCES model_runs(id) ON DELETE CASCADE,
          algorithm_version TEXT NOT NULL,
          config_json TEXT NOT NULL,
          config_hash TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          evaluated_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
          summary_json TEXT,
          failure_json TEXT,
          created_at TEXT NOT NULL DEFAULT (${nowSql}),
          started_at TEXT,
          completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_training_metric_runs_status_created
          ON training_metric_runs(status, created_at);

        CREATE TABLE IF NOT EXISTS workout_training_loads (
          id TEXT PRIMARY KEY,
          training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          feature_id TEXT REFERENCES workout_features(id),
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          distance_km REAL,
          duration_seconds REAL NOT NULL CHECK (duration_seconds >= 0),
          training_load REAL NOT NULL CHECK (training_load >= 0),
          intensity REAL NOT NULL CHECK (intensity BETWEEN 0 AND 1),
          load_source TEXT NOT NULL CHECK (load_source IN (
            'heart_rate_series', 'average_heart_rate', 'rpe', 'session_type'
          )),
          confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
          heart_rate_coverage REAL,
          average_heart_rate_bpm REAL,
          elevation_gain_meters REAL CHECK (elevation_gain_meters >= 0),
          rpe INTEGER CHECK (rpe BETWEEN 1 AND 10),
          session_type TEXT NOT NULL,
          explanation_codes_json TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (${nowSql}),
          UNIQUE (training_metric_run_id, training_session_id)
        );

        CREATE INDEX IF NOT EXISTS idx_workout_training_loads_run_date
          ON workout_training_loads(training_metric_run_id, local_date);
        CREATE INDEX IF NOT EXISTS idx_workout_training_loads_session
          ON workout_training_loads(training_session_id);

        CREATE TABLE IF NOT EXISTS daily_training_metrics (
          id TEXT PRIMARY KEY,
          training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          distance_km REAL NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
          duration_seconds REAL NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
          workout_count INTEGER NOT NULL DEFAULT 0 CHECK (workout_count >= 0),
          daily_load REAL NOT NULL DEFAULT 0 CHECK (daily_load >= 0),
          current_7d_load REAL NOT NULL DEFAULT 0 CHECK (current_7d_load >= 0),
          previous_7d_load REAL NOT NULL DEFAULT 0 CHECK (previous_7d_load >= 0),
          acute_ewma REAL NOT NULL DEFAULT 0 CHECK (acute_ewma >= 0),
          chronic_ewma REAL NOT NULL DEFAULT 0 CHECK (chronic_ewma >= 0),
          load_ratio REAL,
          ramp_rate REAL,
          monotony REAL,
          strain REAL,
          recovery_evidence REAL CHECK (recovery_evidence BETWEEN 0 AND 1),
          history_days INTEGER NOT NULL DEFAULT 0 CHECK (history_days >= 0),
          load_workout_count INTEGER NOT NULL DEFAULT 0 CHECK (load_workout_count >= 0),
          training_status TEXT NOT NULL CHECK (training_status IN (
            'insufficient_data', 'recovery', 'maintaining',
            'effective_stimulus', 'high_load', 'attention'
          )),
          confidence REAL CHECK (confidence BETWEEN 0 AND 1),
          explanation_codes_json TEXT NOT NULL,
          explanation_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (${nowSql}),
          UNIQUE (training_metric_run_id, local_date)
        );

        CREATE INDEX IF NOT EXISTS idx_daily_training_metrics_run_date
          ON daily_training_metrics(training_metric_run_id, local_date);

        DROP VIEW IF EXISTS effective_workout_overrides;
        CREATE VIEW effective_workout_overrides AS
        SELECT
          id,
          training_session_id,
          revision,
          eligibility_override,
          statistics_participation,
          session_type,
          performance_protocol,
          rpe,
          condition_tags_json,
          note,
          created_at
        FROM (
          SELECT
            workout_overrides.*,
            ROW_NUMBER() OVER (
              PARTITION BY training_session_id
              ORDER BY revision DESC
            ) AS row_number
          FROM workout_overrides
        )
        WHERE row_number = 1;

        CREATE VIEW IF NOT EXISTS active_workout_training_loads AS
        SELECT load.*
        FROM workout_training_loads load
        JOIN training_metric_runs metric_run
          ON metric_run.id = load.training_metric_run_id
        JOIN active_model_run active ON active.model_run_id = metric_run.model_run_id
        WHERE metric_run.status = 'succeeded';

        CREATE VIEW IF NOT EXISTS active_daily_training_metrics AS
        SELECT metric.*
        FROM daily_training_metrics metric
        JOIN training_metric_runs metric_run
          ON metric_run.id = metric.training_metric_run_id
        JOIN active_model_run active ON active.model_run_id = metric_run.model_run_id
        WHERE metric_run.status = 'succeeded';
      `);
    }
  },
  {
    version: 7,
    name: "complete_training_load_workout_evidence",
    up: (database) => {
      const columns = database
        .prepare("PRAGMA table_info(workout_training_loads)")
        .all() as unknown as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "average_heart_rate_bpm")) {
        database.exec("ALTER TABLE workout_training_loads ADD COLUMN average_heart_rate_bpm REAL");
      }
      if (!columns.some((column) => column.name === "elevation_gain_meters")) {
        database.exec(`
          ALTER TABLE workout_training_loads
          ADD COLUMN elevation_gain_meters REAL CHECK (elevation_gain_meters >= 0)
        `);
      }
    }
  },
  {
    version: 8,
    name: "allow_unknown_daily_load_confidence",
    up: (database) => {
      const confidenceColumn = (
        database.prepare("PRAGMA table_info(daily_training_metrics)").all() as unknown as Array<{
          name: string;
          notnull: number;
        }>
      ).find((column) => column.name === "confidence");
      if (confidenceColumn?.notnull !== 1) return;

      database.exec(`
        DROP VIEW IF EXISTS active_daily_training_metrics;
        ALTER TABLE daily_training_metrics RENAME TO daily_training_metrics_v7;

        CREATE TABLE daily_training_metrics (
          id TEXT PRIMARY KEY,
          training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          distance_km REAL NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
          duration_seconds REAL NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
          workout_count INTEGER NOT NULL DEFAULT 0 CHECK (workout_count >= 0),
          daily_load REAL NOT NULL DEFAULT 0 CHECK (daily_load >= 0),
          current_7d_load REAL NOT NULL DEFAULT 0 CHECK (current_7d_load >= 0),
          previous_7d_load REAL NOT NULL DEFAULT 0 CHECK (previous_7d_load >= 0),
          acute_ewma REAL NOT NULL DEFAULT 0 CHECK (acute_ewma >= 0),
          chronic_ewma REAL NOT NULL DEFAULT 0 CHECK (chronic_ewma >= 0),
          load_ratio REAL,
          ramp_rate REAL,
          monotony REAL,
          strain REAL,
          recovery_evidence REAL CHECK (recovery_evidence BETWEEN 0 AND 1),
          history_days INTEGER NOT NULL DEFAULT 0 CHECK (history_days >= 0),
          load_workout_count INTEGER NOT NULL DEFAULT 0 CHECK (load_workout_count >= 0),
          training_status TEXT NOT NULL CHECK (training_status IN (
            'insufficient_data', 'recovery', 'maintaining',
            'effective_stimulus', 'high_load', 'attention'
          )),
          confidence REAL CHECK (confidence BETWEEN 0 AND 1),
          explanation_codes_json TEXT NOT NULL,
          explanation_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (${nowSql}),
          UNIQUE (training_metric_run_id, local_date)
        );

        INSERT INTO daily_training_metrics SELECT * FROM daily_training_metrics_v7;
        DROP TABLE daily_training_metrics_v7;

        CREATE INDEX idx_daily_training_metrics_run_date
          ON daily_training_metrics(training_metric_run_id, local_date);

        CREATE VIEW active_daily_training_metrics AS
        SELECT metric.*
        FROM daily_training_metrics metric
        JOIN training_metric_runs metric_run
          ON metric_run.id = metric.training_metric_run_id
        JOIN active_model_run active ON active.model_run_id = metric_run.model_run_id
        WHERE metric_run.status = 'succeeded';
      `);
    }
  },
  {
    version: 9,
    name: "harden_active_run_views",
    up: (database) => {
      database.exec(`
        DROP VIEW IF EXISTS active_ability_assessments;
        CREATE VIEW active_ability_assessments AS
        SELECT assessment.*
        FROM ability_assessments assessment
        JOIN model_runs model ON model.id = assessment.model_run_id
        JOIN active_model_run active ON active.model_run_id = model.id
        WHERE model.status = 'succeeded';

        DROP VIEW IF EXISTS active_daily_ability_snapshots;
        CREATE VIEW active_daily_ability_snapshots AS
        SELECT snapshot.*
        FROM daily_ability_snapshots snapshot
        JOIN model_runs model ON model.id = snapshot.model_run_id
        JOIN active_model_run active ON active.model_run_id = model.id
        WHERE model.status = 'succeeded';

        DROP VIEW IF EXISTS active_workout_training_loads;
        CREATE VIEW active_workout_training_loads AS
        SELECT load.*
        FROM workout_training_loads load
        JOIN training_metric_runs metric_run ON metric_run.id = load.training_metric_run_id
        JOIN model_runs model ON model.id = metric_run.model_run_id
        JOIN active_model_run active ON active.model_run_id = model.id
        WHERE model.status = 'succeeded' AND metric_run.status = 'succeeded';

        DROP VIEW IF EXISTS active_daily_training_metrics;
        CREATE VIEW active_daily_training_metrics AS
        SELECT metric.*
        FROM daily_training_metrics metric
        JOIN training_metric_runs metric_run ON metric_run.id = metric.training_metric_run_id
        JOIN model_runs model ON model.id = metric_run.model_run_id
        JOIN active_model_run active ON active.model_run_id = model.id
        WHERE model.status = 'succeeded' AND metric_run.status = 'succeeded';
      `);
    }
  },
  {
    version: 10,
    name: "incremental_import_lineage",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS import_batches (
          id TEXT PRIMARY KEY,
          source_sha256 TEXT,
          xml_sha256 TEXT NOT NULL,
          route_bundle_sha256 TEXT,
          status TEXT NOT NULL CHECK (status IN ('inspecting', 'running', 'unchanged', 'succeeded', 'failed', 'cancelled')),
          import_mode TEXT NOT NULL CHECK (import_mode IN ('unchanged', 'incremental', 'full')),
          previous_dataset_version TEXT,
          dataset_version TEXT,
          dirty_from_at TEXT,
          summary_json TEXT NOT NULL DEFAULT '{}',
          error_json TEXT,
          created_at TEXT NOT NULL DEFAULT (${nowSql}),
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_import_batches_fingerprint ON import_batches(xml_sha256, route_bundle_sha256, status);

        CREATE TABLE IF NOT EXISTS import_batch_files (
          batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          modified_at_ms REAL,
          sha256 TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('new', 'changed', 'unchanged', 'removed')),
          PRIMARY KEY (batch_id, relative_path)
        );

        CREATE TABLE IF NOT EXISTS import_entity_changes (
          batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
          entity_kind TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          change_type TEXT NOT NULL CHECK (change_type IN ('inserted', 'updated', 'removed', 'unchanged')),
          effective_at TEXT,
          content_hash TEXT,
          PRIMARY KEY (batch_id, entity_kind, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_import_entity_changes_effective ON import_entity_changes(batch_id, effective_at);
      `);

      const featureColumns = database.prepare("PRAGMA table_info(feature_runs)").all() as unknown as Array<{ name: string }>;
      if (!featureColumns.some((column) => column.name === "parent_feature_run_id")) {
        database.exec("ALTER TABLE feature_runs ADD COLUMN parent_feature_run_id TEXT REFERENCES feature_runs(id)");
      }
      if (!featureColumns.some((column) => column.name === "reused_feature_count")) {
        database.exec("ALTER TABLE feature_runs ADD COLUMN reused_feature_count INTEGER NOT NULL DEFAULT 0 CHECK (reused_feature_count >= 0)");
      }
      if (!featureColumns.some((column) => column.name === "recomputed_feature_count")) {
        database.exec("ALTER TABLE feature_runs ADD COLUMN recomputed_feature_count INTEGER NOT NULL DEFAULT 0 CHECK (recomputed_feature_count >= 0)");
      }
    }
  },
  {
    version: 11,
    name: "reserved_migration_11",
    up: () => {
      // Version 11 was skipped historically. Keep a ledger entry so migration history is contiguous.
    }
  },
  {
    version: 12,
    name: "raw_entity_generations_and_route_fingerprints",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS import_entity_generations (
          entity_kind TEXT NOT NULL CHECK (entity_kind IN ('record', 'workout', 'activity_summary')),
          entity_id TEXT NOT NULL,
          generation TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          effective_at TEXT,
          PRIMARY KEY (entity_kind, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_import_entity_generations_generation
          ON import_entity_generations(entity_kind, generation);

        CREATE TABLE IF NOT EXISTS route_file_fingerprints (
          relative_path TEXT PRIMARY KEY,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          modified_at_ms REAL NOT NULL,
          sha256 TEXT NOT NULL,
          route_id TEXT NOT NULL,
          point_count INTEGER NOT NULL DEFAULT 0 CHECK (point_count >= 0),
          imported_at TEXT NOT NULL DEFAULT (${nowSql})
        );
      `);
    }
  },
  {
    version: 13,
    name: "model_checkpoints_and_shadow_validation",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS model_checkpoints (
          id TEXT PRIMARY KEY,
          model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
          through_at TEXT NOT NULL,
          checkpoint_version TEXT NOT NULL,
          model_version TEXT NOT NULL,
          model_config_hash TEXT NOT NULL,
          feature_schema_version TEXT NOT NULL,
          feature_config_hash TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          state_json TEXT NOT NULL,
          state_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowSql}),
          UNIQUE(model_run_id, sequence_number)
        );
        CREATE INDEX IF NOT EXISTS idx_model_checkpoints_run_through
          ON model_checkpoints(model_run_id, through_at DESC);
        CREATE TABLE IF NOT EXISTS recompute_validations (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES recompute_jobs(id) ON DELETE CASCADE,
          candidate_model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          reference_model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          mode TEXT NOT NULL CHECK (mode = 'shadow'),
          status TEXT NOT NULL CHECK (status IN ('matched', 'mismatched')),
          hashes_json TEXT NOT NULL,
          mismatch_json TEXT,
          created_at TEXT NOT NULL DEFAULT (${nowSql})
        );
      `);
      const columns = database.prepare("PRAGMA table_info(model_runs)").all() as unknown as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "parent_model_run_id")) {
        database.exec("ALTER TABLE model_runs ADD COLUMN parent_model_run_id TEXT REFERENCES model_runs(id)");
      }
      if (!columns.some((column) => column.name === "reused_assessment_count")) {
        database.exec("ALTER TABLE model_runs ADD COLUMN reused_assessment_count INTEGER NOT NULL DEFAULT 0 CHECK (reused_assessment_count >= 0)");
      }
    }
  },
  {
    version: 14,
    name: "training_zones_stimulus_and_composite_load_v3",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS training_zone_profile_settings (
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL UNIQUE CHECK (revision >= 1),
          effective_from_local_date TEXT NOT NULL,
          resting_mode TEXT NOT NULL CHECK (resting_mode IN ('auto', 'manual')),
          resting_value_bpm REAL CHECK (resting_value_bpm BETWEEN 35 AND 110),
          maximum_mode TEXT NOT NULL CHECK (maximum_mode IN ('auto', 'manual')),
          maximum_value_bpm REAL CHECK (maximum_value_bpm BETWEEN 120 AND 230),
          threshold_pace_mode TEXT NOT NULL CHECK (threshold_pace_mode IN ('auto', 'manual')),
          threshold_pace_seconds_per_km REAL CHECK (threshold_pace_seconds_per_km BETWEEN 150 AND 900),
          created_at TEXT NOT NULL DEFAULT (${nowSql})
        );
        CREATE INDEX IF NOT EXISTS idx_zone_profile_settings_effective
          ON training_zone_profile_settings(effective_from_local_date, revision DESC);

        CREATE TABLE IF NOT EXISTS daily_zone_profiles (
          id TEXT PRIMARY KEY,
          training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          effective_at TEXT NOT NULL,
          data_through_at TEXT,
          resting_heart_rate_bpm REAL NOT NULL CHECK (resting_heart_rate_bpm BETWEEN 35 AND 110),
          maximum_heart_rate_bpm REAL NOT NULL CHECK (maximum_heart_rate_bpm BETWEEN 120 AND 230),
          threshold_pace_seconds_per_km REAL CHECK (threshold_pace_seconds_per_km BETWEEN 150 AND 900),
          heart_rate_source TEXT NOT NULL CHECK (heart_rate_source IN ('automatic', 'manual', 'fallback', 'carried_forward')),
          pace_source TEXT NOT NULL CHECK (pace_source IN ('automatic', 'manual', 'fallback', 'carried_forward')),
          heart_rate_confidence REAL NOT NULL CHECK (heart_rate_confidence BETWEEN 0 AND 1),
          pace_confidence REAL NOT NULL CHECK (pace_confidence BETWEEN 0 AND 1),
          profile_status TEXT NOT NULL CHECK (profile_status IN ('stable', 'provisional', 'fallback')),
          heart_rate_bands_json TEXT NOT NULL,
          pace_bands_json TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(training_metric_run_id, local_date)
        );
        CREATE INDEX IF NOT EXISTS idx_daily_zone_profiles_run_date
          ON daily_zone_profiles(training_metric_run_id, local_date);

        CREATE TABLE IF NOT EXISTS workout_zone_summaries (
          id TEXT PRIMARY KEY,
          training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          feature_id TEXT REFERENCES workout_features(id),
          zone_profile_id TEXT NOT NULL REFERENCES daily_zone_profiles(id),
          stimulus_type TEXT NOT NULL CHECK (stimulus_type IN (
            'recovery', 'aerobic_base', 'marathon_pace', 'lactate_threshold',
            'vo2max', 'anaerobic_endurance', 'unclassified'
          )),
          secondary_stimulus_types_json TEXT NOT NULL,
          stimulus_confidence REAL NOT NULL CHECK (stimulus_confidence BETWEEN 0 AND 1),
          heart_rate_coverage REAL NOT NULL CHECK (heart_rate_coverage BETWEEN 0 AND 1),
          pace_coverage REAL NOT NULL CHECK (pace_coverage BETWEEN 0 AND 1),
          heart_rate_exposure_json TEXT NOT NULL,
          pace_exposure_json TEXT NOT NULL,
          stimulus_scores_json TEXT NOT NULL,
          explanation_codes_json TEXT NOT NULL,
          computed_at TEXT NOT NULL,
          UNIQUE(training_metric_run_id, training_session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_workout_zone_summaries_run_type
          ON workout_zone_summaries(training_metric_run_id, stimulus_type);

        DROP VIEW IF EXISTS active_daily_zone_profiles;
        CREATE VIEW active_daily_zone_profiles AS
        SELECT profile.*
        FROM daily_zone_profiles profile
        JOIN training_metric_runs metric_run ON metric_run.id = profile.training_metric_run_id
        JOIN active_model_run active ON active.model_run_id = metric_run.model_run_id
        WHERE metric_run.status = 'succeeded';

        DROP VIEW IF EXISTS active_workout_zone_summaries;
        CREATE VIEW active_workout_zone_summaries AS
        SELECT summary.*
        FROM workout_zone_summaries summary
        JOIN training_metric_runs metric_run ON metric_run.id = summary.training_metric_run_id
        JOIN active_model_run active ON active.model_run_id = metric_run.model_run_id
        WHERE metric_run.status = 'succeeded';
      `);

      const columns = database.prepare("PRAGMA table_info(workout_training_loads)").all() as unknown as Array<{ name: string }>;
      const addColumn = (name: string, definition: string): void => {
        if (!columns.some((column) => column.name === name)) {
          database.exec(`ALTER TABLE workout_training_loads ADD COLUMN ${name} ${definition}`);
        }
      };
      addColumn("zone_profile_id", "TEXT REFERENCES daily_zone_profiles(id)");
      addColumn("stimulus_type", "TEXT NOT NULL DEFAULT 'unclassified'");
      addColumn("raw_hrr_trimp", "REAL CHECK (raw_hrr_trimp >= 0)");
      addColumn("internal_load", "REAL CHECK (internal_load >= 0)");
      addColumn("pace_load", "REAL CHECK (pace_load >= 0)");
      addColumn("distance_reference_meters", "REAL CHECK (distance_reference_meters > 0)");
      addColumn("distance_exposure_ratio", "REAL CHECK (distance_exposure_ratio >= 0)");
      addColumn("distance_factor", "REAL NOT NULL DEFAULT 1 CHECK (distance_factor BETWEEN 1 AND 1.15)");
      addColumn("heart_rate_load_confidence", "REAL NOT NULL DEFAULT 0 CHECK (heart_rate_load_confidence BETWEEN 0 AND 1)");
      addColumn("pace_load_confidence", "REAL NOT NULL DEFAULT 0 CHECK (pace_load_confidence BETWEEN 0 AND 1)");
    }
  },
  {
    version: 15,
    name: "composite_training_load_source",
    up: (database) => {
      database.exec(`
        DROP VIEW IF EXISTS active_workout_training_loads;
        ALTER TABLE workout_training_loads RENAME TO workout_training_loads_v14;
        CREATE TABLE workout_training_loads (
          id TEXT PRIMARY KEY,
          training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          feature_id TEXT REFERENCES workout_features(id),
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          distance_km REAL,
          duration_seconds REAL NOT NULL CHECK (duration_seconds >= 0),
          training_load REAL NOT NULL CHECK (training_load >= 0),
          intensity REAL NOT NULL CHECK (intensity BETWEEN 0 AND 1),
          load_source TEXT NOT NULL CHECK (load_source IN (
            'composite', 'heart_rate_series', 'average_heart_rate', 'rpe', 'session_type'
          )),
          confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
          heart_rate_coverage REAL,
          average_heart_rate_bpm REAL,
          elevation_gain_meters REAL CHECK (elevation_gain_meters >= 0),
          rpe INTEGER CHECK (rpe BETWEEN 1 AND 10),
          session_type TEXT NOT NULL,
          explanation_codes_json TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (${nowSql}),
          zone_profile_id TEXT REFERENCES daily_zone_profiles(id),
          stimulus_type TEXT NOT NULL DEFAULT 'unclassified',
          raw_hrr_trimp REAL CHECK (raw_hrr_trimp >= 0),
          internal_load REAL CHECK (internal_load >= 0),
          pace_load REAL CHECK (pace_load >= 0),
          distance_reference_meters REAL CHECK (distance_reference_meters > 0),
          distance_exposure_ratio REAL CHECK (distance_exposure_ratio >= 0),
          distance_factor REAL NOT NULL DEFAULT 1 CHECK (distance_factor BETWEEN 1 AND 1.15),
          heart_rate_load_confidence REAL NOT NULL DEFAULT 0 CHECK (heart_rate_load_confidence BETWEEN 0 AND 1),
          pace_load_confidence REAL NOT NULL DEFAULT 0 CHECK (pace_load_confidence BETWEEN 0 AND 1),
          UNIQUE (training_metric_run_id, training_session_id)
        );
        INSERT INTO workout_training_loads (
          id, training_metric_run_id, training_session_id, feature_id, local_date,
          timezone_identifier, distance_km, duration_seconds, training_load, intensity,
          load_source, confidence, heart_rate_coverage, average_heart_rate_bpm,
          elevation_gain_meters, rpe, session_type, explanation_codes_json,
          provenance_json, computed_at, zone_profile_id, stimulus_type, raw_hrr_trimp,
          internal_load, pace_load, distance_reference_meters, distance_exposure_ratio,
          distance_factor, heart_rate_load_confidence, pace_load_confidence
        )
        SELECT
          id, training_metric_run_id, training_session_id, feature_id, local_date,
          timezone_identifier, distance_km, duration_seconds, training_load, intensity,
          load_source, confidence, heart_rate_coverage, average_heart_rate_bpm,
          elevation_gain_meters, rpe, session_type, explanation_codes_json,
          provenance_json, computed_at, zone_profile_id, stimulus_type, raw_hrr_trimp,
          internal_load, pace_load, distance_reference_meters, distance_exposure_ratio,
          distance_factor, heart_rate_load_confidence, pace_load_confidence
        FROM workout_training_loads_v14;
        DROP TABLE workout_training_loads_v14;
        CREATE INDEX idx_workout_training_loads_run_date
          ON workout_training_loads(training_metric_run_id, local_date);
        CREATE INDEX idx_workout_training_loads_session
          ON workout_training_loads(training_session_id);
        CREATE VIEW active_workout_training_loads AS
        SELECT load.*
        FROM workout_training_loads load
        JOIN training_metric_runs metric_run ON metric_run.id = load.training_metric_run_id
        JOIN active_model_run active ON active.model_run_id = metric_run.model_run_id
        WHERE metric_run.status = 'succeeded';
      `);
    }
  },
  {
    version: 16,
    name: "prediction_model_ability_baseline_fingerprint",
    up: (database) => {
      database.exec(`
        ALTER TABLE prediction_model_runs ADD COLUMN ability_baseline_hash TEXT;

        -- Existing residuals do not record which formula/ability baseline produced
        -- their labels, so they cannot be activated safely after this migration.
        DELETE FROM active_prediction_model;
      `);
    }
  },
  {
    version: 17,
    name: "canonical_nights_and_hrv_days",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS canonical_nights (
          id TEXT PRIMARY KEY,
          wake_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('main', 'nap')),
          source_name TEXT NOT NULL,
          source_category TEXT NOT NULL,
          source_rank INTEGER NOT NULL CHECK (source_rank BETWEEN 1 AND 5),
          has_stages INTEGER NOT NULL CHECK (has_stages IN (0, 1)),
          sleep_onset_at TEXT,
          wake_at TEXT,
          asleep_union_minutes REAL CHECK (asleep_union_minutes IS NULL OR asleep_union_minutes >= 0),
          in_bed_union_minutes REAL CHECK (in_bed_union_minutes IS NULL OR in_bed_union_minutes >= 0),
          awake_minutes REAL CHECK (awake_minutes IS NULL OR awake_minutes >= 0),
          stage_minutes_json TEXT NOT NULL,
          segment_count INTEGER NOT NULL CHECK (segment_count >= 0),
          provenance_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (${nowSql}),
          CHECK (kind <> 'main' OR (sleep_onset_at IS NOT NULL AND wake_at IS NOT NULL AND asleep_union_minutes IS NOT NULL)),
          CHECK (kind <> 'nap' OR sleep_onset_at IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_nights_main
          ON canonical_nights(wake_date, timezone_identifier) WHERE kind = 'main';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_nights_nap
          ON canonical_nights(wake_date, timezone_identifier, source_name, sleep_onset_at)
          WHERE kind = 'nap' AND sleep_onset_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_canonical_nights_kind_wake ON canonical_nights(kind, wake_date);
        CREATE INDEX IF NOT EXISTS idx_canonical_nights_wake_at ON canonical_nights(wake_at);

        CREATE TABLE IF NOT EXISTS canonical_hrv_days (
          id TEXT PRIMARY KEY,
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          night_id TEXT NOT NULL REFERENCES canonical_nights(id) ON DELETE CASCADE,
          hrv_sdnn_ms REAL CHECK (hrv_sdnn_ms IS NULL OR hrv_sdnn_ms >= 0),
          sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
          confidence TEXT NOT NULL CHECK (confidence IN ('confident', 'sparse', 'missing')),
          window_start_at TEXT,
          window_end_at TEXT,
          source_name TEXT,
          provenance_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (${nowSql}),
          UNIQUE (local_date, timezone_identifier)
        );
        CREATE INDEX IF NOT EXISTS idx_canonical_hrv_days_night ON canonical_hrv_days(night_id);
      `);
    }
  },
  {
    version: 18,
    name: "model_validation_gates",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS model_validation_gates (
          id TEXT PRIMARY KEY,
          candidate_model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          base_model_run_id TEXT REFERENCES model_runs(id) ON DELETE SET NULL,
          gate_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
          metrics_json TEXT NOT NULL,
          thresholds_json TEXT NOT NULL,
          failure_reasons_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (${nowSql}),
          UNIQUE(candidate_model_run_id, gate_version)
        );
        CREATE INDEX IF NOT EXISTS idx_model_validation_gates_candidate
          ON model_validation_gates(candidate_model_run_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_model_validation_gates_base
          ON model_validation_gates(base_model_run_id, created_at DESC);
      `);
    }
  },
  {
    // Absence is not evidence of deletion: a client sync package only carries
    // the window since its last anchor, so an entity missing from a payload
    // may simply be outside that window. Deletion is therefore driven by an
    // explicit tombstone, and the tombstone is durable so a later payload
    // (a re-uploaded older archive, an anchor reset) cannot resurrect data the
    // user removed on purpose.
    version: 19,
    name: "import_entity_tombstones",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS import_entity_tombstones (
          entity_kind TEXT NOT NULL CHECK (entity_kind IN ('record', 'workout', 'activity_summary')),
          entity_id TEXT NOT NULL,
          source_identifier TEXT,
          batch_id TEXT,
          deleted_at TEXT NOT NULL DEFAULT (${nowSql}),
          PRIMARY KEY (entity_kind, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_import_entity_tombstones_deleted_at
          ON import_entity_tombstones(deleted_at DESC);
        CREATE INDEX IF NOT EXISTS idx_import_entity_tombstones_source
          ON import_entity_tombstones(source_identifier);
      `);
    }
  },
  {
    version: 20,
    name: "import_source_tombstones",
    up: (database) => {
      database.exec(`
        CREATE TABLE import_source_tombstones (
          entity_kind TEXT NOT NULL CHECK (entity_kind = 'workout'),
          source_identifier TEXT NOT NULL,
          batch_id TEXT,
          deleted_at TEXT NOT NULL DEFAULT (${nowSql}),
          PRIMARY KEY (entity_kind, source_identifier)
        );
        INSERT INTO import_source_tombstones (entity_kind, source_identifier, deleted_at)
          SELECT entity_kind, source_identifier, MAX(deleted_at)
          FROM import_entity_tombstones
          WHERE entity_kind = 'workout' AND source_identifier IS NOT NULL
          GROUP BY entity_kind, source_identifier;
      `);
    }
  },
  {
    version: 21,
    name: "workout_route_and_group_member_lookup_indexes",
    up: (database) => {
      // 训练列表的 has_route / route 过滤器是 `EXISTS (... wr.workout_id = w.id ...)` 形式，
      // 原先只有 relative_path 的唯一索引与主键；实测 SQLite 每次执行都会临时构建
      // AUTOMATIC PARTIAL COVERING INDEX，而是次查询明确 REPORT 为 SCAN。
      // 显式建索引后：子查询走固定索引，workout_group_members 的按 workout_id 回溯不再全表扫。
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_workout_routes_workout_point_count
          ON workout_routes(workout_id, point_count);
        CREATE INDEX IF NOT EXISTS idx_workout_group_members_workout
          ON workout_group_members(workout_id);
      `);
    }
  },
  {
    version: 22,
    name: "realign_health_record_stable_ids_and_remove_duplicates",
    up: (database) => {
      // The record identity formula no longer includes `device`, so a sample Apple
      // exports once with a device attribute and once without now folds to a single
      // id. New imports fold correctly; the rows already stored do not — they still
      // carry the id the *old* formula produced. Two user-visible consequences:
      //
      //   * every duplicated pair is still two rows, so `COUNT(*)` (what the audit
      //     and settings pages show) reads far above the number of real samples;
      //   * since no stored id equals what the current parser computes, a full
      //     re-export reports every one of those rows as "present here, absent
      //     from the import", which the removal guard refuses as a mass deletion.
      //
      // Deleting the duplicate rows alone would not fix it: the survivor would
      // still hold the old id and still be re-reported as absent on the next
      // import. This migration does both — collapse each natural-key group to one
      // row and rewrite that row's id to the formula the parser uses now.
      // `raw_attributes_json` keeps the XML attributes verbatim, so the new id is
      // exactly reconstructible from the stored row (the old formula reproduces
      // every one of those rows, so the inputs are provably intact).
      const rows = database.prepare(`
        SELECT id, type, source_name, start_at, end_at, metadata_json,
               raw_attributes_json, device, created_at
        FROM health_records
      `).all() as unknown as Array<{
        id: string;
        type: string;
        source_name: string;
        start_at: string;
        end_at: string;
        metadata_json: string;
        raw_attributes_json: string;
        device: string | null;
        created_at: string | null;
      }>;
      if (rows.length === 0) return;

      const parseObject = (json: string): Record<string, unknown> | null => {
        try {
          const parsed = JSON.parse(json) as unknown;
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      };
      // Mirrors `lastMetadataValue` (`health-export-parser/src/utils.ts`): the
      // *last* entry of the array wins.
      const syncIdentifierOf = (metadataJson: string): string | null => {
        const values = parseObject(metadataJson)?.["HKMetadataKeySyncIdentifier"];
        if (!Array.isArray(values) || values.length === 0) return null;
        const last = values[values.length - 1];
        return typeof last === "string" ? last : null;
      };
      // Mirrors `stableId` (`health-export-parser/src/utils.ts:14-20`).
      //
      // Plain `JSON.stringify` on purpose: the parser's formula now canonicalises
      // **object keys** before hashing, but every `parts` array this migration
      // builds is a flat list of primitives, on which canonicalisation is the
      // identity — so adding it here would be dead code that merely suggests the
      // two shapes differ. Do not "sync" the two implementations without first
      // checking that the parts are still primitives; if one of them ever passes
      // an object, that is the moment this copy has to grow the same step (and
      // the moment the migration would have to realign the resulting ids).
      const stableRecordId = (kind: string, parts: unknown[]): string => {
        const hash = createHash("sha256");
        hash.update(kind);
        hash.update("\0");
        hash.update(JSON.stringify(parts));
        return `${kind}_${hash.digest("hex").slice(0, 32)}`;
      };
      const identityInputs = (row: (typeof rows)[number]): { syncIdentifier: string | null; attributes: Record<string, unknown> | null } => ({
        syncIdentifier: syncIdentifierOf(row.metadata_json),
        attributes: parseObject(row.raw_attributes_json)
      });
      // Two formulas, because a migration has to be able to say what a row *is*
      // before it changes it: `current` is what the parser computes today,
      // `legacy` is what it computed while the formula still included `device`.
      const currentIdFor = (row: (typeof rows)[number]): string => {
        const { syncIdentifier, attributes } = identityInputs(row);
        if (syncIdentifier !== null) {
          return stableRecordId("record", [row.type, row.source_name, syncIdentifier]);
        }
        return stableRecordId("record", [
          row.type,
          row.source_name,
          row.start_at,
          row.end_at,
          attributes?.value ?? null,
          attributes?.unit ?? null
        ]);
      };
      const legacyIdFor = (row: (typeof rows)[number]): string => {
        const { syncIdentifier, attributes } = identityInputs(row);
        if (syncIdentifier !== null) {
          return stableRecordId("record", [row.type, row.source_name, syncIdentifier]);
        }
        return stableRecordId("record", [
          row.type,
          row.source_name,
          row.start_at,
          row.end_at,
          attributes?.value ?? null,
          attributes?.unit ?? null,
          attributes?.device ?? null
        ]);
      };

      // Refuse to guess. A row whose id matches neither formula came from a shape
      // this migration does not understand, and rewriting it would be a guess
      // about someone's health data — abort the whole migration (the caller runs
      // it inside a transaction) and let an operator look.
      const unrecognised = rows.filter((row) => {
        const current = currentIdFor(row);
        return current !== row.id && legacyIdFor(row) !== row.id;
      });
      if (unrecognised.length > 0) {
        throw new Error(
          `Cannot realign health_records: ${unrecognised.length} row(s) match neither the current nor the legacy stable-id formula (first: ${unrecognised[0]!.id})`
        );
      }

      const grouped = new Map<string, Array<(typeof rows)[number]>>();
      for (const row of rows) {
        const nextId = currentIdFor(row);
        const bucket = grouped.get(nextId);
        if (bucket) bucket.push(row);
        else grouped.set(nextId, [row]);
      }

      // Within a natural-key group the rows are the same sample; keep the one
      // carrying the most information, deterministically.
      const preferKeep = (
        candidate: (typeof rows)[number],
        current: (typeof rows)[number]
      ): boolean => {
        const candidateHasDevice = candidate.device !== null && candidate.device !== "";
        const currentHasDevice = current.device !== null && current.device !== "";
        if (candidateHasDevice !== currentHasDevice) return candidateHasDevice;
        if (candidate.created_at !== current.created_at) {
          if (candidate.created_at === null) return false;
          if (current.created_at === null) return true;
          return candidate.created_at > current.created_at;
        }
        // A stable tie-break, so the outcome does not depend on row order.
        return candidate.id < current.id;
      };

      const duplicateIds: string[] = [];
      // Every survivor, not only the ones whose id changes: the rename pass below
      // stages the *whole table* onto a prefix, so a row left out of this list
      // would keep the prefix forever.
      const survivors: Array<{ from: string; to: string }> = [];
      for (const [nextId, bucket] of grouped) {
        let keep = bucket[0]!;
        for (const candidate of bucket) {
          if (preferKeep(candidate, keep)) keep = candidate;
        }
        for (const row of bucket) {
          if (row.id !== keep.id) duplicateIds.push(row.id);
        }
        survivors.push({ from: keep.id, to: nextId });
      }

      const needsRename = survivors.some((entry) => entry.from !== entry.to);
      if (duplicateIds.length === 0 && !needsRename) return;

      const deleteGeneration = database.prepare(
        "DELETE FROM import_entity_generations WHERE entity_kind = 'record' AND entity_id = ?"
      );
      const deleteTombstone = database.prepare(
        "DELETE FROM import_entity_tombstones WHERE entity_kind = 'record' AND entity_id = ?"
      );
      const deleteRecord = database.prepare("DELETE FROM health_records WHERE id = ?");
      for (const id of duplicateIds) {
        // The collapsed row must stop being remembered as an entity of its own,
        // otherwise the next import sees an id it never wrote and reports it as
        // missing.
        deleteGeneration.run(id);
        deleteTombstone.run(id);
        deleteRecord.run(id);
      }

      // Renaming in place would collide whenever one row's target id is another
      // row's current id. Move both sides onto a prefix no stable id can have —
      // ids are `record_<hex>` — then resolve every row through one mapping
      // table, so no intermediate state is ever ambiguous and the dependent
      // tables move in the same statement as the row they point at.
      //
      // Order matters: the prefix is applied to `health_records` *after* the
      // dependents, because the dependents are selected by membership in the
      // record table and that membership only holds while both sides still carry
      // the same ids.
      if (needsRename) {
        const PREFIX = "__realign__";
        database.prepare(
          `UPDATE import_entity_generations SET entity_id = '${PREFIX}' || entity_id
            WHERE entity_kind = 'record' AND entity_id IN (SELECT id FROM health_records)`
        ).run();
        database.prepare(
          `UPDATE import_entity_tombstones SET entity_id = '${PREFIX}' || entity_id
            WHERE entity_kind = 'record' AND entity_id IN (SELECT id FROM health_records)`
        ).run();
        database.exec(`UPDATE health_records SET id = '${PREFIX}' || id`);

        database.exec("CREATE TEMP TABLE realign_record_ids (staged TEXT PRIMARY KEY, final TEXT NOT NULL)");
        const insertMapping = database.prepare(
          "INSERT INTO realign_record_ids (staged, final) VALUES (?, ?)"
        );
        for (const { from, to } of survivors) {
          const staged = PREFIX + from;
          if (staged !== to) insertMapping.run(staged, to);
        }
        database.exec(`
          UPDATE health_records
             SET id = (SELECT final FROM realign_record_ids WHERE staged = health_records.id)
           WHERE id IN (SELECT staged FROM realign_record_ids);
          UPDATE import_entity_generations
             SET entity_id = (SELECT final FROM realign_record_ids WHERE staged = entity_id)
           WHERE entity_kind = 'record' AND entity_id IN (SELECT staged FROM realign_record_ids);
          UPDATE import_entity_tombstones
             SET entity_id = (SELECT final FROM realign_record_ids WHERE staged = entity_id)
           WHERE entity_kind = 'record' AND entity_id IN (SELECT staged FROM realign_record_ids);
          DROP TABLE realign_record_ids;
        `);
      }
    }
  },
  { version: 23, name: "model_v2_snapshots_release_and_calibration", up: migrateModelV2 },
  { version: 24, name: "engine_version_gate_three_state_refusals_and_epoch", up: migrateModelV24 },
  { version: 25, name: "baseline_rebase_review_history", up: migrateModelV25 },
  { version: 26, name: "privacy_zones_for_shared_route_cards", up: migrateModelV26 },
  { version: 27, name: "manual_performance_entries_for_labels", up: migrateModelV27 }
];

/**
 * 已应用迁移的**权威**校验和。
 *
 * 🔴 为什么不从 `up.toString()` 现算：那会把「构建工具当前的行为」变成持久化数据的一部分。
 * 2026-09-23 实测：`tsx`(esbuild) 下 `up.toString()` = `x=>{return x+1}`（注释/缩进/空白全被剥离）
 * ⇒ 给历史迁移的 `up` **加注释**不会改 checksum；而换成保留注释的执行通道
 * （`node --experimental-strip-types`）⇒ 现算值**集体漂移**（22/22）。
 *
 * ⚠️ 但**现算值不参与运行时判定** —— 见下面 `migrationChecksum()` 取本表优先。
 * 所以「换通道 ⇒ 既有库打不开」是 `342ae38` **冻结之前**的行为。2026-09-24 在干净 worktree
 * 上四组对照实测（同一份真库副本，只换代码 / 通道）：
 *
 *   | 代码 | 通道 | 现算值漂移 | `open(既有库, refuse)` |
 *   |---|---|---|---|
 *   | 当前 | `node --import tsx` | 0/22 | **OK** |
 *   | 当前 | `--experimental-strip-types` | 22/22 | **OK** |
 *   | `342ae38^` | `node --import tsx` | —（尚无本表） | OK |
 *   | `342ae38^` | `--experimental-strip-types` | —（尚无本表） | **THREW `Migration 1 checksum does not match the application`** |
 *
 * ⇒ **该故障模式已被这次冻结消除。** 注释若仍声称「换通道 ⇒ 所有库打不开」，会把人推向
 * **真正危险的方向**：按门禁报错去「修复」它，也就是把冻结值改成新通道的转译产物。
 * 既有库行里存的是**旧**冻结值，改表即让它们全部失配 —— 那才是唯一能让既有库打不开的动作。
 *
 * 附带事实：即便真去换通道，本应用也先**起不来** —— `apps/api/src` 实测有 **82 处** `.js` 相对导入
 * （27 个文件：`./x.js` 76 处 + `../x.js` 6 处），原生类型剥离不做 `.js`→`.ts` 重写，
 * 错误会出现在模块解析阶段、早于任何 checksum 判定。
 *
 * ⇒ 冻结值取自**现存库实际写入的值**，运行时判定与执行通道彻底解耦。
 * 2026-09-23 实测：本地与线上 22 个值逐条一致（摘要
 * `1fa2cd288444a24709c7fdb969a20e249789460e7cdb32dbc71f0d9c702b97c2`）⇒ 冻结不影响既有库。
 *
 * 两个配套门禁在 `test/migration-policy.test.ts`：
 *  1. `every migration has a frozen checksum` —— 新增迁移必须补冻结值；
 *  2. `frozen checksums still match the transpiled source` —— 保留「改历史迁移的 `up` 会被发现」
 *     的能力（在 tsx 下，加注释**不会**让它变红）。它变红时按此顺序诊断：
 *       a) 先看某个历史迁移的 `up` 是否被改过 —— 这是它真正要守的东西；
 *       b) 再看 TS 执行通道是否被换掉（`production runs through tsx` 那条会同时红）。
 *     ⚠️ 两种情形都**不要**把本表更新成新值；通道被换就先恢复 `tsx`。确需换通道时，
 *     必须先规划一次 checksum 重写迁移，而不是就地把表改掉。
 */
export const FROZEN_MIGRATION_CHECKSUMS: Readonly<Record<number, string>> = {
  1: "baf1c3f4b3d28323dac869d9ef20ae638c019a43b0eded150c4d451beff604ba",
  2: "cfde382f225f19db61bf62214e30d20d7c1328d9b021045e5d7c8c1d47536aec",
  3: "35eca610e3e088e532e2ccc69caa29025f95202ba3fd6b62d24818dda6fedebd",
  4: "ee90dbbc80895447b3a6d1f930235d0b171d6c72d52cae6c0bce97ada3117201",
  5: "6c61fd684d56ee017652146baff897cf0fa088d3e2298bba40d3a3a50e2ea63c",
  6: "d3047cef61b7c881c91e544b45481821e24a28e06565e7a405700c506ba9a967",
  7: "f3463b906255087dc6e0b4262d8cb2d74644b8df55fd640039cc4ad3df6bb8ab",
  8: "1911d926926c4093a13b9702f27bff4f035791bdebba6e9d2b524f5c9ee24835",
  9: "ec74d9cf68e5a7d2c8b17161137e13d91de0256405bc9af794739df57f91cb8f",
  10: "8dec586f996ce049397fc64c4a32d8fb148d5b68b3be30b138da2275d8c55adb",
  11: "288aa8753506a0993eb74d8ffe3ec60371c51639306554362b03a919860734fc",
  12: "1fb39afc708979ee6edd6ad9395df64abfe32a4f2befc0c498f07dbee1f6c8d7",
  13: "4fd2f65ab5393261a0c954a6e78ea7095ccf8882cb050cfa6b0ea0a02c8cd648",
  14: "1f1811289df897e5f2eb38cbb696ff0a2a1ef46a6e7513c18ea7bcdb96f7ac4b",
  15: "329267b1a2666e24b5c1b286708f07e8ea57052078f09ef71b309e2d7c0595c3",
  16: "923ca207cd836b5af2640771307e099fc27be649855f0c63df394ca200ca57c7",
  17: "4d4262948d8ec405d5ff9f29f4b99d3f0e095c613401d62265c43565090b43c7",
  18: "e67a637540d505110ae93381aa8e284b1dd90f19904091e7d2b13ea9e81d8bc3",
  19: "faea882f61acb6a3fabda39f1ed3a7630eb318333a2956cba471b334e75aa49e",
  20: "31ecbc8732ceccbf503236adde2441c87b016ce407593e435337a696966c4869",
  21: "7631d0dabe8faed8f3e7294b9aa3794f700970a597797bc9939398dfa41e2df7",
  22: "4401a26ed8579f23a19d0b585123072564127deec47dd1899f6a8cc57d59ac58",
  23: "562530893625d343c1422a99eb64136ffd0e0d232b5428745e5983454593a90b",
  24: "eca8cf8a07292665a2a46820b5ba77e2d2f76c9c113438fdc097ad6e9f123940",
  25: "441c79b0094ef9a6e8aed2ffb90a0407e273c80ae3593047f6bff6beeccaf519",
  26: "089f8e04676dec4ab889544689c1deb237f1d0ffa23c1ed45d01d729b7358931",
  27: "95bd9406fa2bc210c776828e445cad55c03351bb1a5d79306739f0e76033804c"
};

/** 全部迁移的版本号（供门禁核对「每个迁移都已冻结」）。 */
export const MIGRATION_VERSIONS: readonly number[] = migrations.map((migration) => migration.version);

function checksumOfTranspiledSource(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}:${migration.name}:${migration.up.toString()}`)
    .digest("hex");
}

/**
 * 按**当前执行通道**下的转译产物现算，仅供测试期的等价断言使用 ——
 * 运行时判定永远走 `FROZEN_MIGRATION_CHECKSUMS`。
 */
export function transpiledChecksumFor(version: number): string | null {
  const migration = migrations.find((item) => item.version === version);
  return migration ? checksumOfTranspiledSource(migration) : null;
}

/** 期望校验和：已冻结的用冻结值（跨执行通道稳定），未冻结的新迁移才现算。 */
function migrationChecksum(migration: Migration): string {
  return FROZEN_MIGRATION_CHECKSUMS[migration.version] ?? checksumOfTranspiledSource(migration);
}

function legacyMigrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}:${migration.name}`)
    .digest("hex");
}

export class RaiDatabase {
  readonly database: DatabaseSync;
  private readonly path: string;

  private insertRecordStatement!: StatementSync;
  private insertWorkoutStatement!: StatementSync;
  private insertStatisticStatement!: StatementSync;
  private insertEventStatement!: StatementSync;
  private insertRouteStatement!: StatementSync;
  private deleteRouteByPathStatement!: StatementSync;
  private insertRoutePointStatement!: StatementSync;
  private insertIssueStatement!: StatementSync;
  private inTransaction = false;
  private objectsSinceCommit = 0;
  private atomicImport = false;

  private constructor(path: string) {
    this.path = path;
    this.database = new DatabaseSync(path);
    try {
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = NORMAL");
      this.database.exec("PRAGMA busy_timeout = 5000");
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  static async open(path: string, options: RaiDatabaseOpenOptions = {}): Promise<RaiDatabase> {
    if (options.migrationPolicy === "refuse") {
      const pending = RaiDatabase.pendingMigrations(path);
      if (pending.length > 0) throw new PendingMigrationsError(path, pending);
    }
    const database = new RaiDatabase(path);
    try {
      await database.migrate(
        options.createMigrationBackup ?? true,
        options.foreignKeyValidation ?? "always",
        options.migrationPolicy ?? "apply"
      );
      database.prepareStatements();
      return database;
    } catch (error) {
      database.database.close();
      throw error;
    }
  }

  /** Inspect before opening a writer: even journal_mode=WAL can change the file. */
  static pendingMigrations(path: string): Array<{ version: number; name: string }> {
    const all = migrations.map(({ version, name }) => ({ version, name }));
    if (!existsSync(path)) return all;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
      if (!table) return all;
      const columns = database.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
      if (!["name", "checksum"].every((name) => columns.some((column) => column.name === name))) return all;
      const rows = database.prepare("SELECT version, name, checksum FROM schema_migrations").all() as Array<{
        version: number; name: string | null; checksum: string | null;
      }>;
      const applied = new Set<number>();
      for (const row of rows) {
        const migration = migrations.find((item) => item.version === row.version);
        if (!migration) throw new Error(`Database contains unknown migration version ${row.version}`);
        // Legacy metadata repair also belongs exclusively to the explicit CLI.
        if (row.version === 1 && (!row.name || !row.checksum)) continue;
        if (row.name !== migration.name) throw new Error(`Migration ${row.version} name does not match the application`);
        if (row.checksum === migrationChecksum(migration)) applied.add(row.version);
        else if (row.checksum !== legacyMigrationChecksum(migration)) {
          throw new Error(`Migration ${row.version} checksum does not match the application`);
        }
      }
      return all.filter((item) => !applied.has(item.version));
    } finally {
      database.close();
    }
  }

  /**
   * Open an existing database for reads only.
   * Applies the shared connection PRAGMA policy (foreign_keys, busy_timeout)
   * but never runs migrations — writers own schema upgrades.
   */
  static openReadonly(path: string): DatabaseSync {
    const database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    return database;
  }

  private tableExists(name: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS exists_flag FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as unknown as { exists_flag: number } | undefined;
    return row?.exists_flag === 1;
  }

  private ensureMigrationTable(): void {
    if (!this.tableExists("schema_migrations")) {
      this.database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT,
          checksum TEXT,
          applied_at TEXT NOT NULL DEFAULT (${nowSql})
        );
      `);
      return;
    }

    const columns = this.database
      .prepare("PRAGMA table_info(schema_migrations)")
      .all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "name")) {
      this.database.exec("ALTER TABLE schema_migrations ADD COLUMN name TEXT");
    }
    if (!columns.some((column) => column.name === "checksum")) {
      this.database.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    }
  }

  private async createBackup(targetVersion: number): Promise<void> {
    if (!existsSync(this.path) || !this.tableExists("workouts")) return;
    const backupDirectory = join(dirname(this.path), "backups");
    mkdirSync(backupDirectory, { recursive: true });
    const disk = statfsSync(backupDirectory);
    const databaseBytes = statSync(this.path).size + (existsSync(`${this.path}-wal`) ? statSync(`${this.path}-wal`).size : 0);
    const required = Math.ceil(databaseBytes * 1.1) + 256 * 1024 ** 2;
    if (disk.bavail * disk.bsize < required) {
      throw new Error(`Insufficient disk space for migration backup: need at least ${required} bytes`);
    }
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const destination = join(
      backupDirectory,
      `${basename(this.path, ".sqlite")}.before-v${targetVersion}.${timestamp}.sqlite`
    );
    await backup(this.database, destination);
  }

  private async migrate(
    createMigrationBackup: boolean,
    foreignKeyValidation: "always" | "after-migration",
    policy: "apply" | "refuse"
  ): Promise<void> {
    if (policy === "refuse") {
      // Recheck the boundary; publication locks serialize cooperating processes.
      const pending = RaiDatabase.pendingMigrations(this.path);
      if (pending.length > 0) throw new PendingMigrationsError(this.path, pending);
      if (foreignKeyValidation === "always" && this.database.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("SQLite foreign key validation failed after migration");
      }
      return;
    }
    this.ensureMigrationTable();
    const appliedRows = this.database
      .prepare("SELECT version, name, checksum FROM schema_migrations")
      .all() as unknown as Array<{ version: number; name: string | null; checksum: string | null }>;
    const applied = new Map(appliedRows.map((row) => [row.version, row]));
    const pending = migrations.filter((migration) => !applied.has(migration.version));

    const existingV1 = applied.get(1);
    if (existingV1 && (!existingV1.name || !existingV1.checksum)) {
      const name = migrations[0]?.name ?? "initial_canonical_health_schema";
      const checksum = migrationChecksum(migrations[0]!);
      this.database
        .prepare("UPDATE schema_migrations SET name = ?, checksum = ? WHERE version = 1")
        .run(name, checksum);
      existingV1.name = name;
      existingV1.checksum = checksum;
    }

    for (const [version, row] of applied) {
      const migration = migrations.find((candidate) => candidate.version === version);
      if (!migration) throw new Error(`Database contains unknown migration version ${version}`);
      if (row.name !== migration.name) {
        throw new Error(`Migration ${version} name does not match the application`);
      }
      const expected = migrationChecksum(migration);
      if (row.checksum === legacyMigrationChecksum(migration)) {
        this.database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?").run(expected, version);
      } else if (row.checksum !== expected) {
        throw new Error(`Migration ${version} checksum does not match the application`);
      }
    }

    if (createMigrationBackup && pending.length > 0 && this.tableExists("workouts")) {
      await this.createBackup(pending[0]?.version ?? 1);
    }

    // Each migration is atomic; the entire sequence is not one transaction.
    for (const migration of pending) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        migration.up(this.database);
        this.database
          .prepare(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)"
          )
          .run(migration.version, migration.name, migrationChecksum(migration));
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }

    if (foreignKeyValidation === "always" || pending.length > 0) {
      const foreignKeyProblems = this.database
        .prepare("PRAGMA foreign_key_check")
        .all() as unknown[];
      if (foreignKeyProblems.length > 0) {
        throw new Error("SQLite foreign key validation failed after migration");
      }
    }
  }

  private prepareStatements(): void {
    this.insertRecordStatement = this.database.prepare(`
      INSERT INTO health_records (
        id, type, source_name, source_category, source_version, device,
        unit, value_numeric, value_text, start_at, end_at, created_at,
        metadata_json, raw_attributes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type, source_name = excluded.source_name,
        source_category = excluded.source_category, source_version = excluded.source_version,
        device = excluded.device, unit = excluded.unit, value_numeric = excluded.value_numeric,
        value_text = excluded.value_text, start_at = excluded.start_at, end_at = excluded.end_at,
        created_at = excluded.created_at, metadata_json = excluded.metadata_json,
        raw_attributes_json = excluded.raw_attributes_json
    `);
    this.insertWorkoutStatement = this.database.prepare(`
      INSERT INTO workouts (
        id, activity_type, source_name, source_category, source_version,
        device, start_at, end_at, created_at, duration_seconds, indoor,
        metadata_json, raw_attributes_json, canonical_group_id, is_canonical
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
      ON CONFLICT(id) DO UPDATE SET
        activity_type = excluded.activity_type, source_name = excluded.source_name,
        source_category = excluded.source_category, source_version = excluded.source_version,
        device = excluded.device, start_at = excluded.start_at, end_at = excluded.end_at,
        created_at = excluded.created_at, duration_seconds = excluded.duration_seconds,
        indoor = excluded.indoor, metadata_json = excluded.metadata_json,
        raw_attributes_json = excluded.raw_attributes_json
    `);
    this.insertStatisticStatement = this.database.prepare(`
      INSERT INTO workout_statistics (
        workout_id, ordinal, type, start_at, end_at, unit,
        sum_value, average_value, minimum_value, maximum_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertEventStatement = this.database.prepare(`
      INSERT INTO workout_events (
        workout_id, ordinal, type, event_at, duration_seconds, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.insertRouteStatement = this.database.prepare(`
      INSERT INTO workout_routes (
        id, workout_id, source_name, source_category, source_version,
        start_at, end_at, created_at, relative_path, metadata_json,
        point_count, file_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')
      ON CONFLICT(id) DO UPDATE SET
        workout_id = excluded.workout_id, source_name = excluded.source_name,
        source_category = excluded.source_category, source_version = excluded.source_version,
        start_at = excluded.start_at, end_at = excluded.end_at,
        created_at = excluded.created_at, relative_path = excluded.relative_path,
        metadata_json = excluded.metadata_json
    `);
    // Case-insensitive path match so mixed-case legacy rows still collide correctly.
    this.deleteRouteByPathStatement = this.database.prepare(
      "DELETE FROM workout_routes WHERE lower(relative_path) = lower(?) AND id <> ?"
    );
    this.insertRoutePointStatement = this.database.prepare(`
      INSERT INTO route_points (
        route_id, sequence, timestamp, latitude, longitude, elevation_meters,
        speed_mps, course_degrees, horizontal_accuracy_meters,
        vertical_accuracy_meters
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertIssueStatement = this.database.prepare(`
      INSERT INTO import_issues (severity, code, object_id, message)
      VALUES (?, ?, ?, ?)
    `);
  }

  private begin(): void {
    if (this.inTransaction) return;
    this.database.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
  }

  private markObject(): void {
    this.objectsSinceCommit += 1;
    if (!this.atomicImport && this.objectsSinceCommit >= 5_000) this.flush();
  }

  beginAtomicImport(): void {
    if (this.atomicImport) throw new Error("An atomic import is already active");
    this.flush();
    this.atomicImport = true;
    this.begin();
  }

  commitAtomicImport(): void {
    if (!this.atomicImport) throw new Error("No atomic import is active");
    this.atomicImport = false;
    this.flush();
  }

  rollbackAtomicImport(): void {
    this.rollback();
    this.atomicImport = false;
  }

  flush(): void {
    if (!this.inTransaction) return;
    this.database.exec("COMMIT");
    this.inTransaction = false;
    this.objectsSinceCommit = 0;
  }

  rollback(): void {
    if (!this.inTransaction) return;
    this.database.exec("ROLLBACK");
    this.inTransaction = false;
    this.objectsSinceCommit = 0;
  }

  setManifest(key: string, value: string): void {
    this.begin();
    this.database
      .prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  setProfile(attributes: Record<string, string>, options?: { merge?: boolean }): void {
    this.begin();
    if (options?.merge) {
      const incoming = Object.fromEntries(
        Object.entries(attributes).filter(([, value]) => value !== undefined && value !== "")
      );
      if (Object.keys(incoming).length === 0) return;
      const row = this.database
        .prepare("SELECT attributes_json AS attributesJson FROM profile WHERE id = 1")
        .get() as unknown as { attributesJson: string } | undefined;
      const existing = row
        ? (JSON.parse(row.attributesJson) as Record<string, string>)
        : {};
      const existingKeys = new Set(Object.keys(existing));
      const incomingKeys = Object.keys(incoming);
      const isSubset = incomingKeys.every((key) => existingKeys.has(key));
      if (isSubset && incomingKeys.every((key) => existing[key] === incoming[key])) return;
      this.database
        .prepare("INSERT OR REPLACE INTO profile (id, attributes_json) VALUES (1, ?)")
        .run(JSON.stringify({ ...existing, ...incoming }));
      return;
    }
    this.database
      .prepare("INSERT OR REPLACE INTO profile (id, attributes_json) VALUES (1, ?)")
      .run(JSON.stringify(attributes));
  }

  insertRecord(
    record: CanonicalHealthRecord,
    sourceCategory: string,
    rawAttributes: Record<string, string>
  ): void {
    this.begin();
    this.insertRecordStatement.run(
      record.id,
      record.type,
      record.sourceName,
      sourceCategory,
      record.sourceVersion,
      record.device,
      record.unit,
      record.numericValue,
      record.textValue,
      record.startAt,
      record.endAt,
      record.createdAt,
      JSON.stringify(record.metadata),
      JSON.stringify(rawAttributes)
    );
    this.markObject();
  }

  insertWorkout(
    workout: CanonicalWorkout,
    sourceCategory: string,
    rawAttributes: Record<string, string>,
    options?: { preserveAbsent?: boolean }
  ): void {
    this.begin();
    this.insertWorkoutStatement.run(
      workout.id,
      workout.activityType,
      workout.sourceName,
      sourceCategory,
      workout.sourceVersion,
      workout.device,
      workout.startAt,
      workout.endAt,
      workout.createdAt,
      workout.durationSeconds,
      workout.indoor === null ? null : workout.indoor ? 1 : 0,
      JSON.stringify(workout.metadata),
      JSON.stringify(rawAttributes)
    );

    this.database.prepare("DELETE FROM workout_statistics WHERE workout_id = ?").run(workout.id);
    workout.statistics.forEach((statistic, ordinal) => {
      this.insertStatisticStatement.run(
        workout.id,
        ordinal,
        statistic.type,
        statistic.startAt,
        statistic.endAt,
        statistic.unit,
        statistic.sum,
        statistic.average,
        statistic.minimum,
        statistic.maximum
      );
    });

    this.database.prepare("DELETE FROM workout_events WHERE workout_id = ?").run(workout.id);
    workout.events.forEach((event, ordinal) => {
      this.insertEventStatement.run(
        workout.id,
        ordinal,
        event.type,
        event.date,
        event.durationSeconds,
        JSON.stringify(event.metadata)
      );
    });

    // Upsert routes in place when ids are unchanged so imported points/file_status
    // survive re-inserts. Only delete routes that leave the workout's route set.
    const incomingRoutes = workout.routes.map((route) => ({
      ...route,
      relativePath: route.relativePath ? normalizeRouteRelativePath(route.relativePath) : null
    }));
    // HealthKit incremental payloads often omit WorkoutRoute; keep stored GPS.
    if (options?.preserveAbsent && incomingRoutes.length === 0) {
      this.markObject();
      return;
    }
    if (!options?.preserveAbsent) {
      const incomingIds = new Set(incomingRoutes.map((route) => route.id));
      const existingRoutes = this.database
        .prepare(
          "SELECT id, relative_path AS relativePath FROM workout_routes WHERE workout_id = ?"
        )
        .all(workout.id) as unknown as Array<{ id: string; relativePath: string | null }>;
      for (const existing of existingRoutes) {
        if (!incomingIds.has(existing.id)) {
          this.deleteRouteFingerprints(existing.id, existing.relativePath);
          this.database.prepare("DELETE FROM workout_routes WHERE id = ?").run(existing.id);
        }
      }
    }
    for (const route of incomingRoutes) {
      if (route.relativePath) {
        // Drop stale route rows that share a relative_path but a different id so
        // UNIQUE(relative_path) does not fail when route identity drifts.
        const replaced = this.deleteRoutesByPathExcept(
          route.relativePath,
          route.id,
          options
        );
        if (!replaced) continue;
      }
      this.insertRouteStatement.run(
        route.id,
        workout.id,
        route.sourceName,
        sourceCategory,
        route.sourceVersion,
        route.startAt,
        route.endAt,
        route.createdAt,
        route.relativePath,
        JSON.stringify(route.metadata)
      );
    }
    this.markObject();
  }

  insertActivitySummary(attributes: Record<string, string>): void {
    const dateComponents = attributes.dateComponents;
    if (!dateComponents) return;
    this.begin();
    this.database
      .prepare(
        "INSERT OR REPLACE INTO activity_summaries (date_components, attributes_json) VALUES (?, ?)"
      )
      .run(dateComponents, JSON.stringify(attributes));
    this.markObject();
  }

  upsertInventory(
    kind: string,
    type: string,
    count: number,
    firstAt: string | null,
    lastAt: string | null,
    details: unknown
  ): void {
    this.begin();
    this.database
      .prepare(`
        INSERT OR REPLACE INTO entity_inventory (
          entity_kind, entity_type, item_count, first_at, last_at, details_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(kind, type, count, firstAt, lastAt, JSON.stringify(details));
  }

  insertIssue(issue: ImportIssue): void {
    this.begin();
    this.insertIssueStatement.run(
      issue.severity,
      issue.code,
      issue.objectId,
      issue.message
    );
  }

  routesToImport(): RouteImportTarget[] {
    return this.database
      .prepare(
        "SELECT id, relative_path AS relativePath FROM workout_routes WHERE relative_path IS NOT NULL"
      )
      .all() as unknown as RouteImportTarget[];
  }

  ensureOrphanRoute(
    routeId: string,
    relativePath: string,
    options?: { preserveAbsent?: boolean }
  ): string {
    this.begin();
    const normalizedPath = normalizeRouteRelativePath(relativePath);
    const replaced = this.deleteRoutesByPathExcept(normalizedPath, routeId, options);
    if (!replaced) {
      const owner = this.database
        .prepare(
          `SELECT id FROM workout_routes WHERE lower(relative_path) = lower(?) LIMIT 1`
        )
        .get(normalizedPath) as unknown as { id: string } | undefined;
      return owner?.id ?? routeId;
    }
    this.insertRouteStatement.run(
      routeId,
      null,
      null,
      "other",
      null,
      null,
      null,
      null,
      normalizedPath,
      "{}"
    );
    return routeId;
  }

  replaceRoutePoints(routeId: string, points: RoutePoint[]): void {
    this.beginRoutePointReplacement(routeId);
    this.appendRoutePoints(routeId, points);
    this.completeRoutePointReplacement(routeId, points.length);
  }

  beginRoutePointReplacement(routeId: string): void {
    this.begin();
    this.database.prepare("DELETE FROM route_points WHERE route_id = ?").run(routeId);
    this.database.prepare(
      "UPDATE workout_routes SET point_count = 0, file_status = 'pending' WHERE id = ?"
    ).run(routeId);
  }

  appendRoutePoints(routeId: string, points: readonly RoutePoint[]): void {
    this.begin();
    for (const point of points) {
      this.insertRoutePointStatement.run(
        routeId,
        point.sequence,
        point.timestamp,
        point.latitude,
        point.longitude,
        point.elevationMeters,
        point.speedMetersPerSecond,
        point.courseDegrees,
        point.horizontalAccuracyMeters,
        point.verticalAccuracyMeters
      );
    }
  }

  completeRoutePointReplacement(routeId: string, pointCount: number): void {
    this.begin();
    this.database
      .prepare(
        "UPDATE workout_routes SET point_count = ?, file_status = 'imported' WHERE id = ?"
      )
      .run(pointCount, routeId);
    this.markObject();
  }

  markRouteStatus(routeId: string, status: string): void {
    this.begin();
    if (status !== "imported") {
      this.database.prepare("DELETE FROM route_points WHERE route_id = ?").run(routeId);
    }
    this.database
      .prepare("UPDATE workout_routes SET file_status = ?, point_count = CASE WHEN ? = 'imported' THEN point_count ELSE 0 END WHERE id = ?")
      .run(status, status, routeId);
  }

  pruneOrphanRoutes(relativePaths: readonly string[]): void {
    this.begin();
    const keep = new Set(relativePaths.map((path) => path.toLowerCase()));
    const rows = this.database.prepare(
      "SELECT id, relative_path AS relativePath FROM workout_routes WHERE workout_id IS NULL"
    ).all() as unknown as Array<{ id: string; relativePath: string }>;
    const remove = this.database.prepare("DELETE FROM workout_routes WHERE id = ?");
    for (const row of rows) {
      if (!keep.has(row.relativePath.toLowerCase())) {
        this.deleteRouteFingerprints(row.id, row.relativePath);
        remove.run(row.id);
      }
    }
  }

  /** Remove fingerprint rows that would orphan when a route is deleted. */
  private deleteRouteFingerprints(routeId: string, relativePath?: string | null): void {
    this.database
      .prepare("DELETE FROM route_file_fingerprints WHERE route_id = ?")
      .run(routeId);
    if (relativePath) {
      this.database
        .prepare("DELETE FROM route_file_fingerprints WHERE lower(relative_path) = lower(?)")
        .run(relativePath);
    }
  }

  /**
   * Delete workout_routes (and their fingerprints) that claim `relativePath`
   * but are not `keepRouteId`. CASCADE removes route_points.
   * Returns false when preserve-absent leaves a colliding owner in place.
   */
  private deleteRoutesByPathExcept(
    relativePath: string,
    keepRouteId: string,
    options?: { preserveAbsent?: boolean }
  ): boolean {
    const conflicting = this.database
      .prepare(
        `SELECT id, relative_path AS relativePath FROM workout_routes
         WHERE lower(relative_path) = lower(?) AND id <> ?`
      )
      .all(relativePath, keepRouteId) as unknown as Array<{
      id: string;
      relativePath: string | null;
    }>;
    if (options?.preserveAbsent && conflicting.length > 0) return false;
    for (const row of conflicting) {
      this.deleteRouteFingerprints(row.id, row.relativePath);
    }
    this.deleteRouteByPathStatement.run(relativePath, keepRouteId);
    return true;
  }

  /** Whether an explicit deletion tombstone exists for this entity. */
  isEntityTombstoned(kind: "record" | "workout" | "activity_summary", id: string): boolean {
    return this.database
      .prepare("SELECT 1 FROM import_entity_tombstones WHERE entity_kind = ? AND entity_id = ?")
      .get(kind, id) !== undefined;
  }

  /**
   * Records durable deletion tombstones. Called for every entity an import
   * removes, so a later payload cannot reintroduce it.
   */
  recordEntityTombstones(
    kind: "record" | "workout" | "activity_summary",
    ids: readonly string[],
    options?: { batchId?: string; sourceIdentifier?: string }
  ): number {
    if (ids.length === 0) return 0;
    const statement = this.database.prepare(`
      INSERT INTO import_entity_tombstones (entity_kind, entity_id, source_identifier, batch_id, deleted_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
        source_identifier = COALESCE(excluded.source_identifier, import_entity_tombstones.source_identifier),
        batch_id = excluded.batch_id,
        deleted_at = excluded.deleted_at
    `);
    const deletedAt = new Date().toISOString();
    for (const id of ids) {
      statement.run(kind, id, options?.sourceIdentifier ?? null, options?.batchId ?? null, deletedAt);
    }
    return ids.length;
  }

  /** Number of durable deletion tombstones. */
  countEntityTombstones(): number {
    return (this.database
      .prepare("SELECT COUNT(*) AS entityCount FROM import_entity_tombstones")
      .get() as unknown as { entityCount: number }).entityCount;
  }

  /**
   * Removes only tombstones that are older than the caller's explicit
   * retention window. Callers should run this after a verified authoritative
   * snapshot; incremental imports must retain tombstones indefinitely because
   * an old archive can arrive at any time and otherwise resurrect deleted data.
   */
  pruneEntityTombstones(options: { olderThanDays: number; limit?: number }): number {
    const days = Math.floor(options.olderThanDays);
    if (!Number.isFinite(days) || days <= 0) throw new Error("olderThanDays must be positive");
    const limit = options.limit === undefined ? 1000 : Math.floor(options.limit);
    if (!Number.isFinite(limit) || limit <= 0) throw new Error("limit must be positive");
    this.begin();
    try {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const ids = this.database.prepare(`
        SELECT entity_kind AS entityKind, entity_id AS entityId
        FROM import_entity_tombstones
        WHERE deleted_at < ?
        ORDER BY deleted_at ASC
        LIMIT ?
      `).all(cutoff, limit) as unknown as Array<{ entityKind: string; entityId: string }>;
      const statement = this.database.prepare(
        "DELETE FROM import_entity_tombstones WHERE entity_kind = ? AND entity_id = ?"
      );
      for (const row of ids) statement.run(row.entityKind, row.entityId);
      // Source tombstones have their own key and may outlive the entity row
      // (for deletions received before the entity arrived).
      this.database.prepare(`
        DELETE FROM import_source_tombstones
        WHERE rowid IN (
          SELECT s.rowid FROM import_source_tombstones s
          WHERE s.deleted_at < ? AND NOT EXISTS (
          SELECT 1 FROM import_entity_tombstones e
            WHERE e.entity_kind = s.entity_kind
              AND e.source_identifier = s.source_identifier
          )
          ORDER BY s.deleted_at ASC
          LIMIT ?
        )
      `).run(cutoff, limit);
      this.flush();
      return ids.length;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /**
   * Drops every tombstone. Only an explicitly declared complete snapshot may
   * call this: such a payload is authoritative, so it is allowed to declare
   * that a previously removed entity exists again.
   */
  clearEntityTombstones(): number {
    const removed = this.countEntityTombstones();
    this.database.exec("DELETE FROM import_entity_tombstones");
    this.database.exec("DELETE FROM import_source_tombstones");
    return removed;
  }

  observeImportEntity(
    kind: "record" | "workout" | "activity_summary",
    id: string,
    generation: string,
    effectiveAt: string | null,
    batchId?: string,
    contentHash = id,
    sourceIdentifiers: readonly string[] = []
  ): { inserted: boolean; updated: boolean; tombstoned: boolean } {
    this.begin();
    // A tombstoned entity stays deleted even if a payload still carries it:
    // deletion is explicit and durable, not a function of the latest payload.
    const sourceDeleted = sourceIdentifiers.some((identifier) => this.database.prepare(
      "SELECT 1 FROM import_source_tombstones WHERE entity_kind = ? AND source_identifier = ?"
    ).get(kind, identifier) !== undefined);
    if (sourceDeleted || this.isEntityTombstoned(kind, id)) {
      return { inserted: false, updated: false, tombstoned: true };
    }
    // Identifiers are interpolated because SQLite cannot bind them, but both
    // values below are literals chosen by `kind`; the id itself stays bound.
    const table = kind === "record" ? "health_records" : kind === "workout" ? "workouts" : "activity_summaries";
    const key = kind === "activity_summary" ? "date_components" : "id";
    const exists = this.database.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ?`).get(id) !== undefined;
    const previous = this.database.prepare(`
      SELECT content_hash AS contentHash FROM import_entity_generations
      WHERE entity_kind = ? AND entity_id = ?
    `).get(kind, id) as unknown as { contentHash: string } | undefined;
    // Seed placeholders use a sentinel so the first real content hash does not
    // look like a mass "updated" rewrite after a full import.
    const seedPlaceholder = previous?.contentHash === SEED_CONTENT_HASH;
    const updated = Boolean(
      exists && previous && !seedPlaceholder && previous.contentHash !== contentHash
    );
    this.database.prepare(`
      INSERT INTO import_entity_generations (
        entity_kind, entity_id, generation, content_hash, effective_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
        generation = excluded.generation,
        content_hash = excluded.content_hash,
        effective_at = excluded.effective_at
    `).run(kind, id, generation, contentHash, effectiveAt);
    if (batchId && (!exists || updated)) {
      this.database.prepare(`
        INSERT OR REPLACE INTO import_entity_changes (
          batch_id, entity_kind, entity_id, change_type, effective_at, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(batchId, kind, id, exists ? "updated" : "inserted", effectiveAt, contentHash);
    }
    return { inserted: !exists, updated, tombstoned: false };
  }

  seedImportGenerations(generation: string, options?: { preserveAbsent?: boolean }): void {
    this.begin();
    // These are compact projections of the current export and are rebuilt by the scan.
    // Preserve-absent payloads are incomplete, so keep the previous inventory totals.
    if (!options?.preserveAbsent) {
      this.database.exec("DELETE FROM entity_inventory");
      // An authoritative snapshot supersedes earlier tombstones. Clearing must
      // happen before the scan: a tombstone would otherwise keep the entity out
      // of the payload that is supposed to restore it.
      this.clearEntityTombstones();
    }
    this.database.exec("DELETE FROM import_issues");
    const previous = `${generation}:previous`;
    this.database.prepare(`
      INSERT OR IGNORE INTO import_entity_generations
        (entity_kind, entity_id, generation, content_hash, effective_at)
      SELECT 'record', id, ?, ?, start_at FROM health_records
    `).run(previous, SEED_CONTENT_HASH);
    this.database.prepare(`
      INSERT OR IGNORE INTO import_entity_generations
        (entity_kind, entity_id, generation, content_hash, effective_at)
      SELECT 'workout', id, ?, ?, start_at FROM workouts
    `).run(previous, SEED_CONTENT_HASH);
    const summaries = this.database.prepare(`
      SELECT date_components AS dateComponents, attributes_json AS attributesJson
      FROM activity_summaries
    `).all() as unknown as Array<{ dateComponents: string; attributesJson: string }>;
    const seedSummary = this.database.prepare(`
      INSERT INTO import_entity_generations
        (entity_kind, entity_id, generation, content_hash, effective_at)
      VALUES ('activity_summary', ?, ?, ?, ?)
      ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
        generation = excluded.generation,
        content_hash = excluded.content_hash,
        effective_at = excluded.effective_at
    `);
    for (const summary of summaries) {
      const attributes = JSON.parse(summary.attributesJson) as Record<string, string>;
      const normalized = Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b)));
      const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
      seedSummary.run(summary.dateComponents, previous, hash, summary.dateComponents);
    }
  }

  /**
   * Counts the entities that a non-preserving finalize would delete, without
   * touching any row. `preserveAbsent: false` asserts that the payload is a
   * complete snapshot, so anything missing from it is treated as deleted. When
   * the payload is actually partial that assertion is false, and the deletion
   * would be silent data loss — callers guard on this preview first.
   */
  previewGenerationRemoval(generation: string): GenerationRemovalPreview {
    const rows = this.database
      .prepare(`
        SELECT entity_kind AS entityKind, COUNT(*) AS entityCount
        FROM import_entity_generations
        WHERE generation <> ?
        GROUP BY entity_kind
      `)
      .all(generation) as unknown as Array<{ entityKind: string; entityCount: number }>;
    const preview: GenerationRemovalPreview = {
      records: 0,
      workouts: 0,
      activitySummaries: 0,
      total: 0
    };
    for (const row of rows) {
      if (row.entityKind === "record") preview.records = row.entityCount;
      else if (row.entityKind === "workout") preview.workouts = row.entityCount;
      else if (row.entityKind === "activity_summary") preview.activitySummaries = row.entityCount;
      preview.total += row.entityCount;
    }
    return preview;
  }

  /** Current population of entities that an import generation governs. */
  countImportableEntities(): number {
    const row = this.database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM health_records)
          + (SELECT COUNT(*) FROM workouts)
          + (SELECT COUNT(*) FROM activity_summaries) AS entityCount
      `)
      .get() as unknown as { entityCount: number };
    return row.entityCount;
  }

  finalizeImportGeneration(
    generation: string,
    batchId?: string,
    options?: { preserveAbsent?: boolean }
  ): { removedRecords: number; removedWorkouts: number; removedActivitySummaries: number; dirtyWorkoutTimes: string[] } {
    this.begin();
    if (options?.preserveAbsent) {
      return {
        removedRecords: 0,
        removedWorkouts: 0,
        removedActivitySummaries: 0,
        dirtyWorkoutTimes: []
      };
    }
    // Reaching this branch means the payload declared itself a complete
    // snapshot. `seedImportGenerations` already cleared the superseded
    // tombstones before the scan; every entity removed here gets a fresh one.
    const stale = this.database.prepare(`
      SELECT entity_kind AS entityKind, entity_id AS entityId, effective_at AS effectiveAt
      FROM import_entity_generations
      WHERE generation <> ?
    `).all(generation) as unknown as Array<{
      entityKind: "record" | "workout" | "activity_summary";
      entityId: string;
      effectiveAt: string | null;
    }>;
    const dirtyWorkoutTimes: string[] = [];
    const removed = { record: 0, workout: 0, activity_summary: 0 };
    const removedIds: Record<"record" | "workout" | "activity_summary", string[]> = {
      record: [],
      workout: [],
      activity_summary: []
    };
    const deleteRecord = this.database.prepare("DELETE FROM health_records WHERE id = ?");
    const deleteWorkout = this.database.prepare("DELETE FROM workouts WHERE id = ?");
    const deleteSummary = this.database.prepare("DELETE FROM activity_summaries WHERE date_components = ?");
    const deleteGeneration = this.database.prepare(
      "DELETE FROM import_entity_generations WHERE entity_kind = ? AND entity_id = ?"
    );
    const deleteGroup = this.database.prepare(`
      DELETE FROM workout_groups WHERE id IN (
        SELECT group_id FROM workout_group_members WHERE workout_id = ?
      )
    `);
    const deleteFingerprintsForWorkout = this.database.prepare(`
      DELETE FROM route_file_fingerprints WHERE route_id IN (
        SELECT id FROM workout_routes WHERE workout_id = ?
      )
    `);
    for (const row of stale) {
      if (batchId) {
        this.database.prepare(`
          INSERT OR REPLACE INTO import_entity_changes (
            batch_id, entity_kind, entity_id, change_type, effective_at, content_hash
          ) VALUES (?, ?, ?, 'removed', ?, ?)
        `).run(batchId, row.entityKind, row.entityId, row.effectiveAt, row.entityId);
      }
      if (row.entityKind === "record") deleteRecord.run(row.entityId);
      else if (row.entityKind === "workout") {
        if (row.effectiveAt) dirtyWorkoutTimes.push(row.effectiveAt);
        deleteGroup.run(row.entityId);
        // Fingerprints have no FK to workout_routes; clear before CASCADE route delete.
        deleteFingerprintsForWorkout.run(row.entityId);
        deleteWorkout.run(row.entityId);
      } else deleteSummary.run(row.entityId);
      removed[row.entityKind] += 1;
      removedIds[row.entityKind].push(row.entityId);
      deleteGeneration.run(row.entityKind, row.entityId);
    }
    // Every removal leaves a durable tombstone so a later payload cannot
    // reintroduce the entity.
    for (const kind of ["record", "workout", "activity_summary"] as const) {
      this.recordEntityTombstones(kind, removedIds[kind], { ...(batchId === undefined ? {} : { batchId }) });
    }
    return {
      removedRecords: removed.record,
      removedWorkouts: removed.workout,
      removedActivitySummaries: removed.activity_summary,
      dirtyWorkoutTimes
    };
  }

  /**
   * Applies explicit HealthKit deletion events, matched by the sync identifier
   * the client stores in the workout metadata. Each removed workout leaves a
   * durable tombstone so re-uploading an older archive cannot bring it back.
   */
  removeWorkoutsBySyncIdentifiers(identifiers: readonly string[], batchId?: string): string[] {
    const dirtyWorkoutTimes: string[] = [];
    if (identifiers.length === 0) return dirtyWorkoutTimes;
    this.begin();
    try {
      // Match the parsed metadata values exactly. LIKE is unsafe here: a sync
      // identifier containing '%' or '_' would become a wildcard, and a
      // substring match could delete a different workout. Metadata values are
      // stored as arrays, so expand only the two supported identifier keys.
      //
      // The expansion is guarded because `json_each` raises "malformed JSON" on
      // anything that is not well-formed JSON, and a single such row would abort
      // the whole DELETE — a tombstone that fails loudly is indistinguishable, to
      // the caller, from a database fault. `json_valid` is checked first and the
      // `CASE` only evaluates the branch it selects, so a value that is not an
      // array (or a column that is not valid JSON at all) expands to no rows
      // instead of raising. Absent keys are NULL, which `json_each` already turns
      // into no rows.
      const metadataMatches = (column: string, key: string): string =>
        `EXISTS (
          SELECT 1 FROM json_each(
            CASE WHEN json_valid(${column})
                 THEN CASE WHEN json_valid(json_extract(${column}, '$.${key}'))
                           THEN json_extract(${column}, '$.${key}')
                           ELSE '[]' END
                 ELSE '[]' END
          ) WHERE value = ?
        )`;
      const select = this.database.prepare(`
        SELECT id, start_at AS startAt FROM workouts
        WHERE ${metadataMatches("workouts.metadata_json", "HKMetadataKeySyncIdentifier")}
        OR ${metadataMatches("workouts.metadata_json", "RAIHealthKitWorkoutUUID")}
        OR ${metadataMatches("workouts.raw_attributes_json", "HKMetadataKeySyncIdentifier")}
        OR ${metadataMatches("workouts.raw_attributes_json", "RAIHealthKitWorkoutUUID")}
      `);
      const deleteWorkout = this.database.prepare("DELETE FROM workouts WHERE id = ?");
      const deleteGeneration = this.database.prepare(
        "DELETE FROM import_entity_generations WHERE entity_kind = 'workout' AND entity_id = ?"
      );
      const deleteGroup = this.database.prepare(`
        DELETE FROM workout_groups WHERE id IN (
          SELECT group_id FROM workout_group_members WHERE workout_id = ?
        )
      `);
      const deleteFingerprints = this.database.prepare(`
        DELETE FROM route_file_fingerprints WHERE route_id IN (
          SELECT id FROM workout_routes WHERE workout_id = ?
        )
      `);
      const tombstoned = new Map<string, string[]>();
      const recordSourceDeletion = this.database.prepare(`
        INSERT INTO import_source_tombstones (entity_kind, source_identifier, batch_id)
        VALUES ('workout', ?, ?)
        ON CONFLICT(entity_kind, source_identifier) DO UPDATE SET
          batch_id = excluded.batch_id, deleted_at = (${nowSql})
      `);
      for (const identifier of identifiers) {
        // The deletion may arrive before an older archive containing the workout.
        recordSourceDeletion.run(identifier, batchId ?? null);
        const rows = select.all(identifier, identifier, identifier, identifier) as unknown as Array<{ id: string; startAt: string }>;
        for (const row of rows) {
          dirtyWorkoutTimes.push(row.startAt);
          if (batchId) {
            this.database.prepare(`
              INSERT OR REPLACE INTO import_entity_changes
                (batch_id, entity_kind, entity_id, change_type, effective_at, content_hash)
              VALUES (?, 'workout', ?, 'removed', ?, ?)
            `).run(batchId, row.id, row.startAt, row.id);
          }
          deleteGroup.run(row.id);
          deleteFingerprints.run(row.id);
          // Leaving the ledger row behind would make the entity look like a
          // stale-but-present entity to the removal preview.
          deleteGeneration.run(row.id);
          deleteWorkout.run(row.id);
          const bucket = tombstoned.get(identifier);
          if (bucket) bucket.push(row.id);
          else tombstoned.set(identifier, [row.id]);
        }
      }
      for (const [identifier, ids] of tombstoned) {
        this.recordEntityTombstones("workout", ids, {
          ...(batchId === undefined ? {} : { batchId }),
          sourceIdentifier: identifier
        });
      }
      this.flush();
      return dirtyWorkoutTimes;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /**
   * Removes recomputation runs superseded by newer ones, together with every
   * row derived from them.
   *
   * Each recompute writes a brand-new model_run / feature_run /
   * training_metric_run and materialises the complete derived output again, so
   * without pruning the database grows as O(runs × days) and every migration
   * that rewrites a derived table pays that multiple.
   *
   * Retention: the active run, everything reachable from it through the parent
   * lineage, and the `keepRecent` most recent superseded runs. Ancestry is
   * protected because `parent_model_run_id` / `parent_feature_run_id` are
   * `NO ACTION` (deleting an ancestor of a retained run would fail the foreign
   * key) and because lineage is what makes a past run explainable.
   *
   * Refuses to run when no run is active: without a known live run there is no
   * safe definition of "superseded", and a wrong guess deletes live data.
   */
  pruneSupersededModelRuns(options?: { keepRecent?: number }): SupersededRunPruneResult {
    const keepRecent = Math.max(0, Math.floor(options?.keepRecent ?? 2));
    const activeRow = this.database
      .prepare("SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1")
      .get() as unknown as { modelRunId: string } | undefined;
    const activeId = activeRow?.modelRunId;
    if (!activeId) {
      throw new Error("Refusing to prune recomputation runs while no run is active");
    }
    const runs = this.database
      .prepare(`
        SELECT id, parent_model_run_id AS parentId, feature_run_id AS featureRunId
        FROM model_runs
        ORDER BY created_at DESC, rowid DESC
      `)
      .all() as unknown as Array<{ id: string; parentId: string | null; featureRunId: string }>;
    if (runs.length <= 1) {
      return {
        modelRuns: 0, featureRuns: 0, trainingMetricRuns: 0,
        derivedRows: 0, detachedJobs: 0, retainedModelRuns: runs.length,
        retainedByLineage: 0, retainedByRecentWindow: runs.length
      };
    }

    const byId = new Map(runs.map((run) => [run.id, run]));
    const retained = new Set<string>([activeId]);
    if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='model_release_bundles'").get()) {
      for (const row of this.database.prepare("SELECT model_run_id AS id FROM model_release_bundles").all() as Array<{id:string}>) retained.add(row.id);
    }
    let extraKept = 0;
    for (const run of runs) {
      if (extraKept >= keepRecent) break;
      if (run.id === activeId) continue;
      retained.add(run.id);
      extraKept += 1;
    }
    const pending = [...retained];
    while (pending.length > 0) {
      const parentId = byId.get(pending.pop() as string)?.parentId;
      if (parentId && !retained.has(parentId)) {
        retained.add(parentId);
        pending.push(parentId);
      }
    }

    const doomed = runs.filter((run) => !retained.has(run.id));
    if (doomed.length === 0) {
      return {
        modelRuns: 0, featureRuns: 0, trainingMetricRuns: 0,
        derivedRows: 0, detachedJobs: 0, retainedModelRuns: retained.size,
        retainedByLineage: retained.size - extraKept - 1,
        retainedByRecentWindow: extraKept + 1
      };
    }
    const doomedRunIds = doomed.map((run) => run.id);
    // A feature run still referenced by a retained model run must survive: the
    // model_runs -> feature_runs foreign key is NO ACTION.
    const retainedFeatureRunIds = new Set(
      runs.filter((run) => retained.has(run.id)).map((run) => run.featureRunId)
    );
    const candidateFeatureIds = new Set(doomed.map((run) => run.featureRunId));
    const features = this.database.prepare(`
      SELECT id, parent_feature_run_id AS parentId FROM feature_runs
    `).all() as unknown as Array<{ id: string; parentId: string | null }>;
    const featureParents = new Map(features.map((feature) => [feature.id, feature.parentId]));
    // Feature reuse can succeed even when model replay starts from scratch.
    // Protect ancestors of every surviving feature, including orphan runs.
    for (const feature of features) {
      if (!candidateFeatureIds.has(feature.id)) retainedFeatureRunIds.add(feature.id);
    }
    const pendingFeatures = [...retainedFeatureRunIds];
    while (pendingFeatures.length > 0) {
      const parentId = featureParents.get(pendingFeatures.pop() as string);
      if (parentId && !retainedFeatureRunIds.has(parentId)) {
        retainedFeatureRunIds.add(parentId);
        pendingFeatures.push(parentId);
      }
    }
    const doomedFeatureRunIds = [...candidateFeatureIds].filter((id) => !retainedFeatureRunIds.has(id));

    const countWhereIn = (table: string, column: string, ids: readonly string[]): number => {
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => "?").join(",");
      return (this.database
        .prepare(`SELECT COUNT(*) AS rowCount FROM ${table} WHERE ${column} IN (${placeholders})`)
        .get(...ids) as unknown as { rowCount: number }).rowCount;
    };
    const doomedMetricRunIds = (
      this.database
        .prepare(`SELECT id FROM training_metric_runs WHERE model_run_id IN (${doomedRunIds.map(() => "?").join(",")})`)
        .all(...doomedRunIds) as unknown as Array<{ id: string }>
    ).map((row) => row.id);

    let derivedRows = 0;
    for (const [table, column, ids] of [
      ["ability_assessments", "model_run_id", doomedRunIds],
      ["daily_ability_snapshots", "model_run_id", doomedRunIds],
      ["model_checkpoints", "model_run_id", doomedRunIds],
      ["workout_features", "feature_run_id", doomedFeatureRunIds],
      ["workout_training_loads", "training_metric_run_id", doomedMetricRunIds],
      ["daily_training_metrics", "training_metric_run_id", doomedMetricRunIds],
      ["daily_zone_profiles", "training_metric_run_id", doomedMetricRunIds],
      ["workout_zone_summaries", "training_metric_run_id", doomedMetricRunIds]
    ] as const) {
      derivedRows += countWhereIn(table, column, ids);
    }

    this.begin();
    try {
      const placeholders = (ids: readonly string[]): string => ids.map(() => "?").join(",");
      // recompute_jobs has no ON DELETE clause, so the reference must be
      // released before the run can go. The job itself is kept as the audit
      // record that a recompute happened; only its link to the pruned run goes.
      const detachedJobs = doomedRunIds.length === 0 ? 0
        : Number(this.database
          .prepare(`UPDATE recompute_jobs SET model_run_id = NULL WHERE model_run_id IN (${placeholders(doomedRunIds)})`)
          .run(...doomedRunIds).changes);
      if (doomedFeatureRunIds.length > 0) {
        this.database
          .prepare(`UPDATE recompute_jobs SET feature_run_id = NULL WHERE feature_run_id IN (${placeholders(doomedFeatureRunIds)})`)
          .run(...doomedFeatureRunIds);
      }
      // Order matters: model_runs must go before feature_runs, because
      // model_runs.feature_run_id is NO ACTION and would otherwise block it.
      const modelRuns = Number(this.database
        .prepare(`DELETE FROM model_runs WHERE id IN (${placeholders(doomedRunIds)})`)
        .run(...doomedRunIds).changes);
      const featureRuns = doomedFeatureRunIds.length === 0 ? 0
        : Number(this.database
          .prepare(`DELETE FROM feature_runs WHERE id IN (${placeholders(doomedFeatureRunIds)})`)
          .run(...doomedFeatureRunIds).changes);
      this.flush();
      return {
        modelRuns,
        featureRuns,
        trainingMetricRuns: doomedMetricRunIds.length,
        derivedRows,
        detachedJobs,
        retainedModelRuns: retained.size,
        retainedByLineage: retained.size - extraKept - 1,
        retainedByRecentWindow: extraKept + 1
      };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  close(): void {
    this.flush();
    this.database.close();
  }
}
