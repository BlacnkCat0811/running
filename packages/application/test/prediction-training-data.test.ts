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
