import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteTrendsReadRepository } from "../src/read/trends-read-repository.js";

test("trends retain the active model run when it predates the selected window", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE active_daily_ability_snapshots (
      local_date TEXT, true_ability REAL, decay_points REAL,
      growth_velocity_per_week REAL, snapshot_status TEXT
    );
    CREATE TABLE active_ability_assessments (
      training_session_id TEXT, feature_id TEXT, current_ability REAL,
      confidence REAL, assessment_status TEXT, workout_contribution REAL,
      efficiency_score REAL, pace_score REAL, cardio_score REAL,
      stability_score REAL, recovery_score REAL
    );
    CREATE TABLE workout_features (
      id TEXT, workout_start_at TEXT, distance_km REAL, duration_seconds REAL
    );
    CREATE TABLE active_workout_training_loads (
      training_session_id TEXT, local_date TEXT, distance_km REAL,
      duration_seconds REAL, training_load REAL
    );
    CREATE TABLE model_runs (
      id TEXT, evaluated_at TEXT, model_version TEXT, status TEXT
    );
    CREATE TABLE active_model_run (model_run_id TEXT);
    INSERT INTO active_daily_ability_snapshots VALUES
      ('2026-07-18', 42, 0, 0.5, 'active');
    INSERT INTO model_runs VALUES
      ('active-old', '2025-01-01T00:00:00.000Z', 'v1', 'succeeded'),
      ('inactive-old', '2025-01-02T00:00:00.000Z', 'v0', 'succeeded');
    INSERT INTO active_model_run VALUES ('active-old');
  `);

  try {
    const result = new SqliteTrendsReadRepository(database).load(30);
    assert.deepEqual(result.modelRuns, [{
      id: "active-old",
      date: "2025-01-01T00:00:00.000Z",
      modelVersion: "v1",
      active: true,
    }]);
  } finally {
    database.close();
  }
});
