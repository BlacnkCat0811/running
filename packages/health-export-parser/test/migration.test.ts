import assert from "node:assert/strict";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "../src/database.js";

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
