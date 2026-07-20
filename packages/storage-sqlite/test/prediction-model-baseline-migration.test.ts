import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { RaiDatabase } from "../src/database.js";

test("migration invalidates active prediction models without a baseline fingerprint", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-baseline-migration-"));
  const path = join(root, "rai.sqlite");
  const current = await RaiDatabase.open(path, { createMigrationBackup: false });
  current.close();

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    DELETE FROM schema_migrations WHERE version = 16;
    ALTER TABLE prediction_model_runs DROP COLUMN ability_baseline_hash;
    INSERT INTO prediction_model_runs (
      id, algorithm, model_version, feature_schema_version,
      training_data_through_at, hyperparameters_json, request_json, status,
      label_count, label_count_by_distance_json, supported_distances_json,
      created_at, completed_at
    ) VALUES (
      'legacy-prediction', 'catboost', 'race-residual-catboost-v1',
      'race-residual-features-v1', '2026-01-01T00:00:00.000Z', '{}', '{}',
      'succeeded', 50, '{}', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
    );
    INSERT INTO active_prediction_model (
      singleton, prediction_model_run_id, activated_at
    ) VALUES (1, 'legacy-prediction', '2026-01-01T00:00:02.000Z');
  `);
  legacy.close();

  const migrated = await RaiDatabase.open(path, { createMigrationBackup: false });
  try {
    const columns = migrated.database.prepare("PRAGMA table_info(prediction_model_runs)")
      .all() as unknown as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "ability_baseline_hash"));
    const run = migrated.database.prepare(`
      SELECT ability_baseline_hash AS abilityBaselineHash
      FROM prediction_model_runs WHERE id = 'legacy-prediction'
    `).get() as unknown as { abilityBaselineHash: string | null };
    assert.equal(run.abilityBaselineHash, null);
    const active = migrated.database.prepare(`
      SELECT COUNT(*) AS count FROM active_prediction_model
    `).get() as unknown as { count: number };
    assert.equal(active.count, 0);
  } finally {
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  }
});
