import assert from "node:assert/strict";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

test("upgrades a v1 canonical database with a backup and training-session backfill", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-migration-"));
  const databasePath = join(root, "rai.sqlite");
  let store = await RaiDatabase.open(databasePath);
  try {
    const database = store.database;
    database
      .prepare(`
        INSERT INTO workouts (
          id, activity_type, source_name, source_category, start_at, end_at,
          duration_seconds, metadata_json, raw_attributes_json
        ) VALUES ('legacy_workout', 'HKWorkoutActivityTypeRunning', 'Legacy Watch',
          'apple_watch', '2025-01-01T00:00:00.000Z', '2025-01-01T00:30:00.000Z',
          1800, '{}', '{}')
      `)
      .run();
    database
      .prepare(`
        INSERT INTO workout_statistics (workout_id, ordinal, type, unit, sum_value)
        VALUES ('legacy_workout', 0, 'HKQuantityTypeIdentifierDistanceWalkingRunning', 'km', 5)
      `)
      .run();
    database
      .prepare(`
        INSERT INTO workout_groups (id, activity_type, canonical_workout_id, member_count, reason)
        VALUES ('legacy_group', 'HKWorkoutActivityTypeRunning', 'legacy_workout', 1, 'singleton')
      `)
      .run();
  } finally {
    store.close();
  }

  const legacy = new DatabaseSync(databasePath);
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.exec(`
    DROP VIEW active_workout_zone_summaries;
    DROP VIEW active_daily_zone_profiles;
    DROP VIEW active_daily_training_metrics;
    DROP VIEW active_workout_training_loads;
    DROP VIEW active_daily_ability_snapshots;
    DROP VIEW active_ability_assessments;
    DROP VIEW effective_workout_overrides;
    DROP TABLE active_model_run;
    DROP TABLE recompute_job_events;
    DROP TABLE recompute_jobs;
    DROP TABLE workout_overrides;
    DROP TABLE workout_zone_summaries;
    DROP TABLE daily_zone_profiles;
    DROP TABLE training_zone_profile_settings;
    DROP TABLE daily_training_metrics;
    DROP TABLE workout_training_loads;
    DROP TABLE training_metric_runs;
    DROP TABLE daily_ability_snapshots;
    DROP TABLE ability_assessments;
    DROP TABLE model_runs;
    DROP TABLE workout_features;
    DROP TABLE feature_runs;
    DROP TABLE training_sessions;
    DELETE FROM schema_migrations WHERE version IN (2, 3, 6, 7, 8, 9, 14);
  `);
  legacy.close();

  store = await RaiDatabase.open(databasePath);
  try {
    const session = store.database
      .prepare(`
        SELECT id, canonical_workout_id AS canonicalWorkoutId, status
        FROM training_sessions
        WHERE canonical_workout_id = 'legacy_workout'
      `)
      .get() as unknown as { id: string; canonicalWorkoutId: string; status: string };
    assert.equal(session.canonicalWorkoutId, "legacy_workout");
    assert.equal(session.status, "active");
    const migration = store.database
      .prepare("SELECT name, checksum FROM schema_migrations WHERE version = 2")
      .get() as unknown as { name: string; checksum: string };
    assert.equal(migration.name, "derived_ability_schema_and_stable_sessions");
    assert.equal(migration.checksum.length, 64);
    const overrideColumns = store.database
      .prepare("PRAGMA table_info(workout_overrides)")
      .all() as unknown as Array<{ name: string }>;
    assert.ok(overrideColumns.some((column) => column.name === "performance_protocol"));
    assert.ok(overrideColumns.some((column) => column.name === "statistics_participation"));
    const metricTables = store.database
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'training_metric_runs', 'workout_training_loads', 'daily_training_metrics'
        )
      `)
      .all() as unknown as Array<{ name: string }>;
    assert.equal(metricTables.length, 3);
    const metricViews = store.database
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'view' AND name IN (
          'active_workout_training_loads', 'active_daily_training_metrics'
        )
      `)
      .all() as unknown as Array<{ name: string }>;
    assert.equal(metricViews.length, 2);
    const predictionTables = store.database
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'prediction_model_runs', 'prediction_model_events', 'active_prediction_model'
        )
      `)
      .all() as unknown as Array<{ name: string }>;
    assert.equal(predictionTables.length, 3);
    const predictionMigration = store.database
      .prepare("SELECT name, checksum FROM schema_migrations WHERE version = 4")
      .get() as unknown as { name: string; checksum: string };
    assert.equal(predictionMigration.name, "prediction_model_runs_and_direct_activation");
    assert.equal(predictionMigration.checksum.length, 64);
    const leaseMigration = store.database
      .prepare("SELECT name, checksum FROM schema_migrations WHERE version = 5")
      .get() as unknown as { name: string; checksum: string };
    assert.equal(leaseMigration.name, "prediction_model_worker_leases_and_single_flight");
    assert.equal(leaseMigration.checksum.length, 64);
    const metricMigration = store.database
      .prepare("SELECT name, checksum FROM schema_migrations WHERE version = 6")
      .get() as unknown as { name: string; checksum: string };
    assert.equal(metricMigration.name, "training_load_metrics_and_statistics_participation");
    assert.equal(metricMigration.checksum.length, 64);
    const loadColumns = store.database
      .prepare("PRAGMA table_info(workout_training_loads)")
      .all() as unknown as Array<{ name: string }>;
    assert.ok(loadColumns.some((column) => column.name === "average_heart_rate_bpm"));
    assert.ok(loadColumns.some((column) => column.name === "elevation_gain_meters"));
    assert.ok(loadColumns.some((column) => column.name === "stimulus_type"));
    assert.ok(loadColumns.some((column) => column.name === "internal_load"));
    assert.ok(loadColumns.some((column) => column.name === "pace_load"));
    const dailyColumns = store.database
      .prepare("PRAGMA table_info(daily_training_metrics)")
      .all() as unknown as Array<{ name: string; notnull: number }>;
    assert.equal(dailyColumns.find((column) => column.name === "confidence")?.notnull, 0);
    const compatibilityMigrations = store.database
      .prepare("SELECT version, name FROM schema_migrations WHERE version IN (7, 8) ORDER BY version")
      .all() as unknown as Array<{ version: number; name: string }>;
    assert.deepEqual(compatibilityMigrations.map((row) => ({ ...row })), [
      { version: 7, name: "complete_training_load_workout_evidence" },
      { version: 8, name: "allow_unknown_daily_load_confidence" }
    ]);
    const predictionColumns = store.database
      .prepare("PRAGMA table_info(prediction_model_runs)")
      .all() as unknown as Array<{ name: string }>;
    assert.ok(predictionColumns.some((column) => column.name === "worker_token"));
    assert.ok(predictionColumns.some((column) => column.name === "heartbeat_at"));
    assert.ok(predictionColumns.some((column) => column.name === "attempt_count"));
    const singleFlightIndex = store.database
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_prediction_model_runs_single_flight'
      `)
      .get() as unknown as { name: string } | undefined;
    assert.equal(singleFlightIndex?.name, "idx_prediction_model_runs_single_flight");
    const zoneObjects = store.database.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name IN (
        'training_zone_profile_settings', 'daily_zone_profiles', 'workout_zone_summaries',
        'active_daily_zone_profiles', 'active_workout_zone_summaries'
      ) ORDER BY name
    `).all() as unknown as Array<{ type: string; name: string }>;
    assert.equal(zoneObjects.length, 5);
    const zoneMigration = store.database.prepare(`
      SELECT name, checksum FROM schema_migrations WHERE version = 14
    `).get() as unknown as { name: string; checksum: string };
    assert.equal(zoneMigration.name, "training_zones_stimulus_and_composite_load_v3");
    assert.equal(zoneMigration.checksum.length, 64);
    const backups = readdirSync(join(root, "backups"));
    assert.equal(backups.length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects drift in an applied migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-migration-drift-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  store.close();
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("0".repeat(64));
  database.close();
  await assert.rejects(RaiDatabase.open(databasePath), /checksum does not match/);
  rmSync(root, { recursive: true, force: true });
});

test("v15 preserves v14 training-load columns when their physical order differs", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-migration-v15-load-"));
  const databasePath = join(root, "rai.sqlite");
  let store = await RaiDatabase.open(databasePath);
  store.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.exec(`
    INSERT INTO training_sessions (
      id, activity_type, anchor_start_at, anchor_end_at, status
    ) VALUES (
      'session-v14', 'HKWorkoutActivityTypeRunning',
      '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 'active'
    );
    INSERT INTO feature_runs (
      id, dataset_version, canonical_contract_version, feature_schema_version,
      feature_config_json, feature_config_hash, status
    ) VALUES ('feature-run-v14', 'dataset', 'contract', 'feature', '{}', 'feature-hash', 'succeeded');
    INSERT INTO model_runs (
      id, feature_run_id, dataset_version, model_version, model_config_json,
      model_config_hash, evaluated_at, status
    ) VALUES (
      'model-run-v14', 'feature-run-v14', 'dataset', 'model', '{}', 'model-hash',
      '2026-01-02T00:00:00.000Z', 'succeeded'
    );
    INSERT INTO training_metric_runs (
      id, model_run_id, algorithm_version, config_json, config_hash,
      timezone_identifier, evaluated_at, status
    ) VALUES (
      'metric-run-v14', 'model-run-v14', 'algorithm', '{}', 'config-hash', 'UTC',
      '2026-01-02T00:00:00.000Z', 'succeeded'
    );

    DROP VIEW active_workout_training_loads;
    DROP TABLE workout_training_loads;
    CREATE TABLE workout_training_loads (
      id TEXT PRIMARY KEY,
      training_metric_run_id TEXT NOT NULL,
      training_session_id TEXT NOT NULL,
      feature_id TEXT,
      local_date TEXT NOT NULL,
      timezone_identifier TEXT NOT NULL,
      distance_km REAL,
      duration_seconds REAL NOT NULL,
      training_load REAL NOT NULL,
      intensity REAL NOT NULL,
      load_source TEXT NOT NULL CHECK (load_source IN (
        'heart_rate_series', 'average_heart_rate', 'rpe', 'session_type'
      )),
      confidence REAL NOT NULL,
      heart_rate_coverage REAL,
      rpe INTEGER,
      session_type TEXT NOT NULL,
      explanation_codes_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      computed_at TEXT NOT NULL,
      average_heart_rate_bpm REAL,
      elevation_gain_meters REAL,
      zone_profile_id TEXT,
      stimulus_type TEXT NOT NULL DEFAULT 'unclassified',
      raw_hrr_trimp REAL,
      internal_load REAL,
      pace_load REAL,
      distance_reference_meters REAL,
      distance_exposure_ratio REAL,
      distance_factor REAL NOT NULL DEFAULT 1,
      heart_rate_load_confidence REAL NOT NULL DEFAULT 0,
      pace_load_confidence REAL NOT NULL DEFAULT 0,
      UNIQUE (training_metric_run_id, training_session_id)
    );
    INSERT INTO workout_training_loads (
      id, training_metric_run_id, training_session_id, local_date, timezone_identifier,
      distance_km, duration_seconds, training_load, intensity, load_source, confidence,
      heart_rate_coverage, rpe, session_type, explanation_codes_json, provenance_json,
      computed_at, average_heart_rate_bpm, elevation_gain_meters, stimulus_type,
      raw_hrr_trimp, internal_load, pace_load, distance_factor,
      heart_rate_load_confidence, pace_load_confidence
    ) VALUES (
      'load-v14', 'metric-run-v14', 'session-v14', '2026-01-01', 'UTC',
      10.5, 3600, 88.25, 0.73, 'heart_rate_series', 0.91,
      0.87, 7, 'steady', '["legacy"]', '{"marker":"preserved"}',
      '2026-01-02T03:04:05.000Z', 151.25, 432.5, 'aerobic_base',
      77.5, 80.25, 92.75, 1.1, 0.87, 0.66
    );
    DELETE FROM schema_migrations WHERE version = 15;
  `);
  legacy.close();

  store = await RaiDatabase.open(databasePath);
  try {
    const row = store.database.prepare(`
      SELECT average_heart_rate_bpm AS averageHeartRate,
        elevation_gain_meters AS elevationGain, rpe, provenance_json AS provenance,
        computed_at AS computedAt, load_source AS loadSource
      FROM workout_training_loads WHERE id = 'load-v14'
    `).get() as unknown as {
      averageHeartRate: number;
      elevationGain: number;
      rpe: number;
      provenance: string;
      computedAt: string;
      loadSource: string;
    };
    assert.deepEqual({ ...row }, {
      averageHeartRate: 151.25,
      elevationGain: 432.5,
      rpe: 7,
      provenance: '{"marker":"preserved"}',
      computedAt: "2026-01-02T03:04:05.000Z",
      loadSource: "heart_rate_series"
    });
    const migration = store.database.prepare(
      "SELECT name FROM schema_migrations WHERE version = 15"
    ).get() as unknown as { name: string };
    assert.equal(migration.name, "composite_training_load_source");
    store.database.prepare(
      "UPDATE workout_training_loads SET load_source = 'composite' WHERE id = 'load-v14'"
    ).run();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
