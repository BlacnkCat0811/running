import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqlitePerformanceEntryRepository } from "../src/performance-entry-repository.js";
import { migrateModelV27 } from "../src/v27-migration.js";
import { migrateModelV28 } from "../src/v28-migration.js";
import { migrateModelV29 } from "../src/v29-migration.js";

function databaseV28(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE training_sessions (id TEXT PRIMARY KEY, status TEXT, anchor_start_at TEXT,
    anchor_end_at TEXT, anchor_distance_km REAL, canonical_workout_id TEXT);
    CREATE TABLE workout_overrides (id TEXT PRIMARY KEY, training_session_id TEXT,
      eligibility_override TEXT, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE active_prediction_model (singleton INTEGER PRIMARY KEY, prediction_model_run_id TEXT);
    INSERT INTO training_sessions VALUES ('race', 'active', '2026-08-01T16:00:00Z', '2026-08-01T17:00:00Z', 10, NULL)`);
  migrateModelV27(database);
  migrateModelV28(database);
  return database;
}

function revision(database: DatabaseSync): number {
  return Number(database.prepare("SELECT revision FROM prediction_label_state WHERE singleton = 1").get()!.revision);
}

test("v29 retires already-published models without rewriting existing event provenance", () => {
  const database = databaseV28();
  try {
    const entries = new SqlitePerformanceEntryRepository(database);
    entries.insert({ localDate: "2026-08-02", distance: "ten_k", durationSeconds: 2400,
      note: null, recordedAt: "2026-08-03T00:00:00Z" });
    const historical = entries.list();
    assert.equal(revision(database), 0, "v28 did not invalidate unlinked replacements");
    database.exec("INSERT INTO active_prediction_model VALUES (1, 'old-residual')");
    migrateModelV29(database);
    assert.equal(revision(database), 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM active_prediction_model").get()!.count, 0);
    assert.deepEqual(entries.list(), historical);
  } finally { database.close(); }
});

for (const trainingSessionId of [null, "race"]) {
  test(`v29 ${trainingSessionId ? "linked" : "unlinked"} event invalidation commits and rolls back with the entry`, () => {
    const database = databaseV28();
    try {
      migrateModelV29(database);
      const entries = new SqlitePerformanceEntryRepository(database);
      const input = { localDate: "2026-08-02", distance: "ten_k" as const, durationSeconds: 2400,
        note: null, recordedAt: "2026-08-03T00:00:00Z", trainingSessionId };
      const before = revision(database);
      database.exec("INSERT INTO active_prediction_model VALUES (1, 'published-residual'); BEGIN");
      entries.insert(input);
      assert.equal(revision(database), before + 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM active_prediction_model").get()!.count, 0);
      database.exec("ROLLBACK");
      assert.equal(revision(database), before);
      assert.equal(database.prepare("SELECT prediction_model_run_id FROM active_prediction_model").get()!.prediction_model_run_id, "published-residual");
      assert.deepEqual(entries.list(), []);
      entries.insert(input);
      assert.equal(revision(database), before + 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM active_prediction_model").get()!.count, 0);
      assert.throws(() => entries.insert(input), /same|同日/);
      assert.equal(revision(database), before + 1, "a rejected duplicate cannot advance the generation");
    } finally { database.close(); }
  });
}

test("v29 uses local finish dates and all supported distance bounds for unlinked events", () => {
  for (const [distance, nominalKm, durationSeconds] of [
    ["five_k", 5, 1500], ["ten_k", 10, 3000], ["half_marathon", 21.0975, 7200]
  ] as const) {
    for (const fraction of [0.9, 1.1]) {
      const database = databaseV28();
      try {
        database.prepare("UPDATE training_sessions SET anchor_distance_km = ?").run(nominalKm * fraction);
        migrateModelV29(database);
        const before = revision(database);
        new SqlitePerformanceEntryRepository(database).insert({ localDate: "2026-08-02", distance,
          durationSeconds, note: null, recordedAt: "2026-08-03T00:00:00Z" });
        assert.equal(revision(database), before + 1, `${distance} at ${fraction} of nominal distance`);
      } finally { database.close(); }
    }
  }
});

test("v29 retains independent date-only append behavior when no event matches", () => {
  const database = databaseV28();
  try {
    migrateModelV29(database);
    const before = revision(database);
    database.exec("INSERT INTO active_prediction_model VALUES (1, 'published-residual')");
    const entries = new SqlitePerformanceEntryRepository(database);
    for (const [localDate, distance] of [["2026-08-03", "ten_k"], ["2026-08-02", "five_k"]] as const) {
      entries.insert({ localDate, distance, durationSeconds: 1500, note: null, recordedAt: "2026-08-04T00:00:00Z" });
      assert.equal(revision(database), before);
      assert.equal(database.prepare("SELECT prediction_model_run_id FROM active_prediction_model").get()!.prediction_model_run_id, "published-residual");
    }
  } finally { database.close(); }
});

test("v29 upgrade itself is transactional", () => {
  const database = databaseV28();
  try {
    database.exec("INSERT INTO active_prediction_model VALUES (1, 'published-residual'); BEGIN");
    migrateModelV29(database);
    assert.equal(revision(database), 1);
    database.exec("ROLLBACK");
    assert.equal(revision(database), 0);
    assert.equal(database.prepare("SELECT prediction_model_run_id FROM active_prediction_model").get()!.prediction_model_run_id, "published-residual");
    new SqlitePerformanceEntryRepository(database).insert({ localDate: "2026-08-02", distance: "ten_k",
      durationSeconds: 2400, note: null, recordedAt: "2026-08-03T00:00:00Z" });
    assert.equal(revision(database), 0, "rollback restores the v28 trigger, not just its pointer");
  } finally { database.close(); }
});
