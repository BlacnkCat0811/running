import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { loadAcuteChronicLoadRatio } from "../src/prediction-training-data.js";

function loadDatabase(recentLoad: number, futureLoad = 100_000): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE training_sessions (
      id TEXT PRIMARY KEY,
      anchor_end_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE active_workout_training_loads (
      training_session_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      timezone_identifier TEXT NOT NULL,
      duration_seconds REAL NOT NULL,
      training_load REAL NOT NULL,
      distance_km REAL,
      confidence REAL NOT NULL
    );
  `);
  const insertSession = database.prepare(`
    INSERT INTO training_sessions (id, anchor_end_at, status)
    VALUES (?, ?, 'active')
  `);
  const insertLoad = database.prepare(`
    INSERT INTO active_workout_training_loads (
      training_session_id, local_date, timezone_identifier, duration_seconds,
      training_load, distance_km, confidence
    ) VALUES (?, ?, 'UTC', 3600, ?, 10, 1)
  `);
  for (let day = 1; day <= 28; day += 1) {
    const localDate = `2026-06-${String(day).padStart(2, "0")}`;
    const id = `session-${day}`;
    insertSession.run(id, `${localDate}T01:00:00.000Z`);
    insertLoad.run(id, localDate, day > 21 ? recentLoad : 50);
  }
  insertSession.run("future-session", "2026-07-02T01:00:00.000Z");
  insertLoad.run("future-session", "2026-07-02", futureLoad);
  return database;
}

test("acute/chronic feature uses composite load and excludes loads after asOf", () => {
  const steady = loadDatabase(50);
  const intense = loadDatabase(200);
  const intenseWithDifferentFuture = loadDatabase(200, 1);
  try {
    const asOf = "2026-06-29T00:00:00.000Z";
    const steadyRatio = loadAcuteChronicLoadRatio(steady, asOf);
    const intenseRatio = loadAcuteChronicLoadRatio(intense, asOf);
    assert.notEqual(steadyRatio, null);
    assert.notEqual(intenseRatio, null);
    assert.ok((intenseRatio ?? 0) > (steadyRatio ?? 0));
    assert.equal(intenseRatio, loadAcuteChronicLoadRatio(intenseWithDifferentFuture, asOf));
  } finally {
    steady.close();
    intense.close();
    intenseWithDifferentFuture.close();
  }
});

test("historical load features ignore overrides created after asOf", () => {
  const database = new DatabaseSync(":memory:");
  const expectedDatabase = loadDatabase(200);
  database.exec(`
    CREATE TABLE training_sessions (
      id TEXT PRIMARY KEY, anchor_start_at TEXT NOT NULL, anchor_end_at TEXT NOT NULL,
      anchor_distance_km REAL, status TEXT NOT NULL
    );
    CREATE TABLE model_runs (id TEXT PRIMARY KEY);
    CREATE TABLE active_model_run (singleton INTEGER PRIMARY KEY, model_run_id TEXT NOT NULL);
    CREATE TABLE training_metric_runs (
      id TEXT PRIMARY KEY, model_run_id TEXT NOT NULL, evaluated_at TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE workout_training_loads (
      id TEXT PRIMARY KEY, training_metric_run_id TEXT NOT NULL,
      training_session_id TEXT NOT NULL, local_date TEXT NOT NULL,
      timezone_identifier TEXT NOT NULL, duration_seconds REAL NOT NULL,
      training_load REAL NOT NULL, distance_km REAL, confidence REAL NOT NULL
    );
    CREATE TABLE workout_overrides (
      id TEXT PRIMARY KEY, training_session_id TEXT NOT NULL, revision INTEGER NOT NULL,
      eligibility_override TEXT, statistics_participation TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO model_runs VALUES ('old-model');
    INSERT INTO active_model_run VALUES (1, 'old-model');
    INSERT INTO training_metric_runs VALUES (
      'old-metrics', 'old-model', '2026-06-30T00:00:00.000Z', 'succeeded',
      '2026-06-30T00:00:00.000Z'
    );
  `);
  const insertSession = database.prepare(`
    INSERT INTO training_sessions VALUES (?, ?, ?, 10, 'active')
  `);
  const insertLoad = database.prepare(`
    INSERT INTO workout_training_loads VALUES (
      ?, 'old-metrics', ?, ?, 'UTC', 3600, ?, 10, 1
    )
  `);
  for (let day = 1; day <= 28; day += 1) {
    const date = `2026-06-${String(day).padStart(2, "0")}`;
    const id = `session-${day}`;
    insertSession.run(id, `${date}T00:00:00.000Z`, `${date}T01:00:00.000Z`);
    insertLoad.run(`old-load-${day}`, id, date, day > 21 ? 200 : 50);
  }
  const asOf = "2026-06-29T00:00:00.000Z";
  try {
    const expected = loadAcuteChronicLoadRatio(expectedDatabase, asOf);
    const before = loadAcuteChronicLoadRatio(database, asOf);
    assert.equal(before, expected);
    database.exec(`
      INSERT INTO workout_overrides VALUES (
        'late-override', 'session-28', 1, 'exclude', 'exclude',
        '2026-07-01T00:00:00.000Z'
      );
      INSERT INTO model_runs VALUES ('new-model');
      INSERT INTO training_metric_runs VALUES (
        'new-metrics', 'new-model', '2026-06-28T00:00:00.000Z', 'succeeded',
        '2026-07-02T00:00:00.000Z'
      );
      INSERT INTO workout_training_loads
      SELECT 'new-' || id, 'new-metrics', training_session_id, local_date,
        timezone_identifier, duration_seconds,
        CASE WHEN training_session_id = 'session-28' THEN 10000 ELSE training_load END,
        distance_km, confidence
      FROM workout_training_loads
      WHERE training_metric_run_id = 'old-metrics';
      UPDATE active_model_run SET model_run_id = 'new-model' WHERE singleton = 1;
    `);
    assert.equal(loadAcuteChronicLoadRatio(database, asOf), before);
  } finally {
    database.close();
    expectedDatabase.close();
  }
});
