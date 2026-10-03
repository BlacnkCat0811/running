import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateModelV27 } from "../src/v27-migration.js";
import { migrateModelV28 } from "../src/v28-migration.js";

test("v28 retains historical labels, refuses inferred identity and retires old publication pointers", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE training_sessions (id TEXT PRIMARY KEY, status TEXT, anchor_start_at TEXT,
      anchor_end_at TEXT, anchor_distance_km REAL, canonical_workout_id TEXT);
      CREATE TABLE workout_overrides (id TEXT PRIMARY KEY, training_session_id TEXT);
      CREATE TABLE active_prediction_model (singleton INTEGER PRIMARY KEY, prediction_model_run_id TEXT);
      INSERT INTO active_prediction_model VALUES (1, 'legacy-residual');
      INSERT INTO training_sessions VALUES ('race', 'active', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z', 10, NULL)`);
    migrateModelV27(db);
    db.exec(`INSERT INTO performance_entries VALUES ('historical', '2026-08-01', 'ten_k', 3000,
      'manual', 'original note', '2026-08-02T00:00:00Z', NULL, 1)`);
    migrateModelV28(db);
    const row = db.prepare("SELECT * FROM performance_entries").get()!;
    assert.equal(row.note, "original note");
    assert.equal(row.training_session_id, null);
    assert.equal(row.observed_at, null);
    assert.equal(row.completed_at, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM active_prediction_model").get()?.count, 0);
    const revision = () => db.prepare("SELECT revision FROM prediction_label_state").get()?.revision;
    assert.equal(revision(), 0);
    db.exec("BEGIN; UPDATE performance_entries SET revoked_at = '2026-10-03T00:00:00Z' WHERE id = 'historical'");
    assert.equal(revision(), 1);
    db.exec("ROLLBACK");
    assert.equal(revision(), 0);
    db.exec("UPDATE performance_entries SET training_session_id = 'race' WHERE id = 'historical'");
    assert.equal(revision(), 1);
    db.exec("INSERT INTO active_prediction_model VALUES (1, 'new-residual'); DELETE FROM training_sessions WHERE id = 'race'");
    assert.equal(revision(), 2);
    assert.equal(db.prepare("SELECT training_session_id FROM performance_entries").get()?.training_session_id, "race",
      "source deletion must not erase event provenance or block import reconciliation");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM active_prediction_model").get()?.count, 0);
  } finally { db.close(); }
});
