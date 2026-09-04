import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
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
  }
];

function migrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}:${migration.name}:${migration.up.toString()}`)
    .digest("hex");
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
    const database = new RaiDatabase(path);
    try {
      await database.migrate(options.createMigrationBackup ?? true);
      database.prepareStatements();
      return database;
    } catch (error) {
      database.database.close();
      throw error;
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
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const destination = join(
      backupDirectory,
      `${basename(this.path, ".sqlite")}.before-v${targetVersion}.${timestamp}.sqlite`
    );
    await backup(this.database, destination);
  }

  private async migrate(createMigrationBackup: boolean): Promise<void> {
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

    const foreignKeyProblems = this.database
      .prepare("PRAGMA foreign_key_check")
      .all() as unknown[];
    if (foreignKeyProblems.length > 0) {
      throw new Error("SQLite foreign key validation failed after migration");
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

  observeImportEntity(
    kind: "record" | "workout" | "activity_summary",
    id: string,
    generation: string,
    effectiveAt: string | null,
    batchId?: string,
    contentHash = id
  ): { inserted: boolean; updated: boolean } {
    this.begin();
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
    return { inserted: !exists, updated };
  }

  seedImportGenerations(generation: string, options?: { preserveAbsent?: boolean }): void {
    this.begin();
    // These are compact projections of the current export and are rebuilt by the scan.
    // Preserve-absent payloads are incomplete, so keep the previous inventory totals.
    if (!options?.preserveAbsent) this.database.exec("DELETE FROM entity_inventory");
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
      deleteGeneration.run(row.entityKind, row.entityId);
    }
    return {
      removedRecords: removed.record,
      removedWorkouts: removed.workout,
      removedActivitySummaries: removed.activity_summary,
      dirtyWorkoutTimes
    };
  }

  close(): void {
    this.flush();
    this.database.close();
  }
}
