import type { DatabaseSync } from "node:sqlite";

/** Additive migration: original fact tables and historic migration bodies stay untouched. */
export function migrateModelV2(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS model_v2_runs (
      model_run_id TEXT PRIMARY KEY REFERENCES model_runs(id) ON DELETE CASCADE,
      engine_version TEXT NOT NULL,
      config_version TEXT NOT NULL,
      lineage_json TEXT NOT NULL CHECK(json_valid(lineage_json)),
      lineage_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_domain_snapshots (
      model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      snapshot_key TEXT NOT NULL,
      as_of TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      payload_hash TEXT NOT NULL,
      PRIMARY KEY(model_run_id, domain, snapshot_key)
    );
    CREATE INDEX IF NOT EXISTS idx_model_domain_snapshot_asof ON model_domain_snapshots(model_run_id,domain,as_of);
    CREATE TABLE IF NOT EXISTS model_release_bundles (
      model_run_id TEXT PRIMARY KEY REFERENCES model_runs(id) ON DELETE RESTRICT,
      base_model_run_id TEXT,
      dataset_version TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      evaluation_json TEXT NOT NULL CHECK(json_valid(evaluation_json)),
      status TEXT NOT NULL CHECK(status IN ('passed','failed','not_evaluable')),
      created_at TEXT NOT NULL,
      activated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS active_model_release (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      model_run_id TEXT NOT NULL REFERENCES model_release_bundles(model_run_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS prediction_calibration_artifacts (
      id TEXT PRIMARY KEY,
      predictor_version TEXT NOT NULL,
      baseline_hash TEXT NOT NULL,
      distance TEXT NOT NULL CHECK(distance IN ('five_k','ten_k','half_marathon')),
      available_at TEXT NOT NULL,
      artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)),
      artifact_hash TEXT NOT NULL,
      evaluation_json TEXT NOT NULL CHECK(json_valid(evaluation_json)),
      status TEXT NOT NULL CHECK(status IN ('passed','failed','not_evaluable'))
    );
    CREATE TRIGGER IF NOT EXISTS immutable_model_domain_snapshot
      BEFORE UPDATE ON model_domain_snapshots BEGIN SELECT RAISE(ABORT,'model snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_model_v2_lineage
      BEFORE UPDATE ON model_v2_runs BEGIN SELECT RAISE(ABORT,'model lineage is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_prediction_calibration
      BEFORE UPDATE ON prediction_calibration_artifacts BEGIN SELECT RAISE(ABORT,'calibration artifacts are immutable'); END;
  `);
}
