import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { loadAcuteChronicLoadRatio, loadTrainingContext } from "../src/prediction-training-data.js";

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

function loadHistoricalDatabase(
  recentLoad: number,
  runCreatedAt = "2026-06-28T00:00:00.000Z"
): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE training_sessions (
      id TEXT PRIMARY KEY, anchor_start_at TEXT NOT NULL, anchor_end_at TEXT NOT NULL,
      anchor_distance_km REAL, status TEXT NOT NULL
    );
    CREATE TABLE model_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE active_model_run (singleton INTEGER PRIMARY KEY, model_run_id TEXT NOT NULL);
    CREATE TABLE training_metric_runs (
      id TEXT PRIMARY KEY, model_run_id TEXT NOT NULL, evaluated_at TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, config_json TEXT NOT NULL
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
    INSERT INTO model_runs VALUES ('base-model', 'succeeded');
    INSERT INTO active_model_run VALUES (1, 'base-model');
  `);
  database.prepare(`
    INSERT INTO training_metric_runs VALUES (
      'base-metrics', 'base-model', '2026-06-29T00:00:00.000Z', 'succeeded', ?,
      '{"overrideSnapshotIds":[]}'
    )
  `).run(runCreatedAt);
  const insertSession = database.prepare(`
    INSERT INTO training_sessions VALUES (?, ?, ?, 10, 'active')
  `);
  const insertLoad = database.prepare(`
    INSERT INTO workout_training_loads VALUES (
      ?, 'base-metrics', ?, ?, 'UTC', 3600, ?, 10, 1
    )
  `);
  for (let day = 1; day <= 28; day += 1) {
    const date = `2026-06-${String(day).padStart(2, "0")}`;
    const id = `session-${day}`;
    insertSession.run(id, `${date}T00:00:00.000Z`, `${date}T01:00:00.000Z`);
    insertLoad.run(`base-load-${day}`, id, date, day > 21 ? recentLoad : 50);
  }
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
    CREATE TABLE model_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE active_model_run (singleton INTEGER PRIMARY KEY, model_run_id TEXT NOT NULL);
    CREATE TABLE training_metric_runs (
      id TEXT PRIMARY KEY, model_run_id TEXT NOT NULL, evaluated_at TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, config_json TEXT NOT NULL
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
    INSERT INTO model_runs VALUES ('old-model', 'succeeded');
    INSERT INTO active_model_run VALUES (1, 'old-model');
    INSERT INTO training_metric_runs VALUES (
      'old-metrics', 'old-model', '2026-06-28T00:00:00.000Z', 'succeeded',
      '2026-06-28T00:00:00.000Z', '{"overrideSnapshotIds":[]}'
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
        '2026-06-28T23:00:00-02:00'
      );
      INSERT INTO model_runs VALUES ('new-model', 'succeeded');
      INSERT INTO training_metric_runs VALUES (
        'new-metrics', 'new-model', '2026-06-28T00:00:00.000Z', 'succeeded',
        '2026-07-02T00:00:00.000Z', '{"overrideSnapshotIds":["late-override"]}'
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

test("historical load features compare mixed-offset metric run timestamps by instant", () => {
  const database = loadHistoricalDatabase(200);
  const asOf = "2026-06-29T00:00:00.000Z";
  try {
    const expected = loadAcuteChronicLoadRatio(database, asOf);
    database.exec(`
      INSERT INTO workout_overrides VALUES (
        'future-override', 'session-28', 1, NULL, 'exclude',
        '2026-06-28T23:00:00-02:00'
      );
      INSERT INTO model_runs VALUES ('post-override-model', 'succeeded');
      INSERT INTO training_metric_runs VALUES (
        'post-override-metrics', 'post-override-model', '2026-06-29T00:00:00.000Z',
        'succeeded', '2026-06-28T21:30:00-04:00',
        '{"overrideSnapshotIds":["future-override"]}'
      );
      INSERT INTO workout_training_loads
      SELECT 'post-override-' || id, 'post-override-metrics', training_session_id,
        local_date, timezone_identifier, duration_seconds,
        CASE WHEN training_session_id = 'session-28' THEN 10000 ELSE training_load END,
        distance_km, confidence
      FROM workout_training_loads
      WHERE training_metric_run_id = 'base-metrics';
    `);
    assert.equal(loadAcuteChronicLoadRatio(database, asOf), expected);
  } finally {
    database.close();
  }
});

test("historical load features exclude metric runs whose parent model failed", () => {
  const database = loadHistoricalDatabase(200);
  const asOf = "2026-06-29T00:00:00.000Z";
  try {
    const expected = loadAcuteChronicLoadRatio(database, asOf);
    database.exec(`
      INSERT INTO model_runs VALUES ('failed-model', 'failed');
      INSERT INTO training_metric_runs VALUES (
        'failed-metrics', 'failed-model', '2026-07-01T00:00:00.000Z', 'succeeded',
        '2026-07-01T00:00:00.000Z', '{"overrideSnapshotIds":[]}'
      );
      INSERT INTO workout_training_loads
      SELECT 'failed-' || id, 'failed-metrics', training_session_id, local_date,
        timezone_identifier, duration_seconds, 10000, distance_km, confidence
      FROM workout_training_loads
      WHERE training_metric_run_id = 'base-metrics';
    `);
    assert.equal(loadAcuteChronicLoadRatio(database, asOf), expected);
  } finally {
    database.close();
  }
});

test("historical load features use a recompute after the effective override", () => {
  const database = loadHistoricalDatabase(200, "2026-06-27T00:00:00.000Z");
  const expectedDatabase = loadDatabase(200);
  const asOf = "2026-06-29T00:00:00.000Z";
  try {
    expectedDatabase.prepare(`
      UPDATE active_workout_training_loads SET training_load = 1
      WHERE training_session_id = 'session-28'
    `).run();
    database.exec(`
      INSERT INTO workout_overrides VALUES (
        'effective-override', 'session-28', 1, NULL, 'include',
        '2026-06-28T12:00:00.000Z'
      );
      INSERT INTO model_runs VALUES ('corrected-model', 'succeeded');
      INSERT INTO training_metric_runs VALUES (
        'corrected-metrics', 'corrected-model', '2026-06-29T00:00:00.000Z', 'succeeded',
        '2026-06-30T00:00:00.000Z',
        '{"overrideSnapshotIds":["effective-override"]}'
      );
      INSERT INTO workout_training_loads
      SELECT 'corrected-' || id, 'corrected-metrics', training_session_id, local_date,
        timezone_identifier, duration_seconds,
        CASE WHEN training_session_id = 'session-28' THEN 1 ELSE training_load END,
        distance_km, confidence
      FROM workout_training_loads
      WHERE training_metric_run_id = 'base-metrics';
    `);
    assert.equal(
      loadAcuteChronicLoadRatio(database, asOf),
      loadAcuteChronicLoadRatio(expectedDatabase, asOf)
    );
  } finally {
    database.close();
    expectedDatabase.close();
  }
});

test("historical load features wait for a run matching an effective exclusion", () => {
  const database = loadHistoricalDatabase(200, "2026-06-27T00:00:00.000Z");
  const asOf = "2026-06-29T00:00:00.000Z";
  try {
    database.exec(`
      INSERT INTO workout_overrides VALUES (
        'excluded-override', 'session-28', 1, NULL, 'exclude',
        '2026-06-28T12:00:00.000Z'
      );
    `);
    assert.equal(loadAcuteChronicLoadRatio(database, asOf), null);
  } finally {
    database.close();
  }
});

test("historical load features never splice unaffected sessions from a future override run", () => {
  const database = loadHistoricalDatabase(200);
  const asOf = "2026-06-29T00:00:00.000Z";
  try {
    const expected = loadAcuteChronicLoadRatio(database, asOf);
    database.exec(`
      INSERT INTO workout_overrides VALUES (
        'future-early-override', 'session-1', 1, NULL, 'exclude',
        '2026-07-01T00:00:00.000Z'
      );
      INSERT INTO model_runs VALUES ('future-dependent-model', 'succeeded');
      INSERT INTO training_metric_runs VALUES (
        'future-dependent-metrics', 'future-dependent-model',
        '2026-07-02T00:00:00.000Z', 'succeeded', '2026-07-02T00:00:00.000Z',
        '{"overrideSnapshotIds":["future-early-override"]}'
      );
      INSERT INTO workout_training_loads
      SELECT 'future-dependent-' || id, 'future-dependent-metrics', training_session_id,
        local_date, timezone_identifier, duration_seconds, 10000, distance_km, confidence
      FROM workout_training_loads
      WHERE training_metric_run_id = 'base-metrics' AND training_session_id <> 'session-1';
    `);
    assert.equal(loadAcuteChronicLoadRatio(database, asOf), expected);
  } finally {
    database.close();
  }
});

function loadTrainingContextDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE training_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      anchor_start_at TEXT NOT NULL,
      anchor_end_at TEXT NOT NULL,
      anchor_distance_km REAL
    );
    CREATE TABLE workout_features (
      id TEXT PRIMARY KEY,
      feature_run_id TEXT NOT NULL,
      training_session_id TEXT NOT NULL,
      quality_score REAL NOT NULL,
      eligibility_status TEXT NOT NULL,
      missing_reasons_json TEXT NOT NULL
    );
    CREATE TABLE model_runs (id TEXT PRIMARY KEY, feature_run_id TEXT NOT NULL);
    CREATE TABLE active_model_run (model_run_id TEXT NOT NULL);
    CREATE TABLE workout_overrides (
      id TEXT PRIMARY KEY,
      training_session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      eligibility_override TEXT,
      created_at TEXT NOT NULL
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
    INSERT INTO model_runs VALUES ('model-1', 'feature-run-1');
    INSERT INTO active_model_run VALUES ('model-1');
  `);
  const insertSession = database.prepare(`
    INSERT INTO training_sessions VALUES (?, 'active', ?, ?, ?)
  `);
  const insertFeature = database.prepare(`
    INSERT INTO workout_features VALUES (?, 'feature-run-1', ?, 0.9, 'eligible', '[]')
  `);
  const sessions = [
    { id: "outside-8w", start: "2026-04-20T00:00:00.000Z", km: 20 },
    { id: "in-8w", start: "2026-05-10T00:00:00.000Z", km: 10 },
    { id: "in-4w-a", start: "2026-06-10T00:00:00.000Z", km: 8 },
    { id: "in-4w-long", start: "2026-06-15T00:00:00.000Z", km: 12 },
    { id: "in-4w-b", start: "2026-06-20T00:00:00.000Z", km: 10 },
    { id: "after-as-of", start: "2026-07-01T00:00:00.000Z", km: 20 }
  ];
  for (const session of sessions) {
    const end = new Date(Date.parse(session.start) + 3_600_000).toISOString();
    insertSession.run(session.id, session.start, end, session.km);
    insertFeature.run(`feature-${session.id}`, session.id);
  }
  return database;
}

test("training context binds 4-week mileage and target-distance exposure in placeholder order", () => {
  const database = loadTrainingContextDatabase();
  const asOf = "2026-06-29T00:00:00.000Z";
  try {
    const context = loadTrainingContext(database, asOf, "ten_k");
    assert.equal(context.weeklyDistance4wKm, 7.5);
    assert.equal(context.weeklyDistance8wKm, 5);
    assert.equal(context.runFrequency4wPerWeek, 0.75);
    assert.equal(context.targetDistanceExposure8w, 4);
    assert.equal(context.longestRun8wKm, 12);
    database.exec(`
      INSERT INTO workout_overrides VALUES (
        'late-exclude', 'in-4w-b', 1, 'exclude', '2026-07-01T00:00:00.000Z'
      )
    `);
    const afterLateOverride = loadTrainingContext(database, asOf, "ten_k");
    assert.equal(afterLateOverride.weeklyDistance4wKm, 7.5);
    assert.equal(afterLateOverride.runFrequency4wPerWeek, 0.75);
    assert.equal(afterLateOverride.targetDistanceExposure8w, 4);
  } finally {
    database.close();
  }
});

test("historical load features allow a successful first backfill after asOf", () => {
  const database = loadHistoricalDatabase(200, "2026-07-10T00:00:00.000Z");
  const expectedDatabase = loadDatabase(200);
  const asOf = "2026-06-29T00:00:00.000Z";
  try {
    assert.equal(
      loadAcuteChronicLoadRatio(database, asOf),
      loadAcuteChronicLoadRatio(expectedDatabase, asOf)
    );
  } finally {
    database.close();
    expectedDatabase.close();
  }
});
