import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteModelRunRepository } from "../src/index.js";

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE model_runs (
      id TEXT PRIMARY KEY,
      feature_run_id TEXT NOT NULL,
      dataset_version TEXT NOT NULL,
      model_version TEXT NOT NULL,
      model_config_hash TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      summary_json TEXT NOT NULL
    );
    CREATE TABLE active_model_run (
      singleton INTEGER PRIMARY KEY,
      model_run_id TEXT NOT NULL,
      activated_at TEXT NOT NULL
    );
    CREATE TABLE ability_assessments (
      id TEXT PRIMARY KEY,
      model_run_id TEXT NOT NULL
    );
    CREATE TABLE daily_ability_snapshots (
      id TEXT PRIMARY KEY,
      model_run_id TEXT NOT NULL
    );
    CREATE TABLE training_metric_runs (
      id TEXT PRIMARY KEY,
      model_run_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE active_prediction_model (
      singleton INTEGER PRIMARY KEY,
      prediction_model_run_id TEXT NOT NULL,
      activated_at TEXT NOT NULL
    );
  `);
  return database;
}

function insertModelRun(
  database: DatabaseSync,
  id: string,
  status: string,
  summaryJson = JSON.stringify({ featureCount: 12 })
): void {
  database.prepare(`
    INSERT INTO model_runs (
      id, feature_run_id, dataset_version, model_version, model_config_hash,
      evaluated_at, status, created_at, completed_at, summary_json
    ) VALUES (?, ?, 'dataset-v1', 'model-v1', 'config-hash', ?, ?, ?, ?, ?)
  `).run(
    id,
    `feature-${id}`,
    "2026-07-17T10:00:00.000Z",
    status,
    `2026-07-17T0${id === "newer" ? "9" : "8"}:00:00.000Z`,
    status === "succeeded" ? "2026-07-17T10:05:00.000Z" : null,
    summaryJson
  );
}

test("maps model-run summaries, counts related rows, and resolves the active run", () => {
  const database = createDatabase();
  try {
    insertModelRun(database, "older", "failed", "not-json");
    insertModelRun(database, "newer", "succeeded");
    database.exec(`
      INSERT INTO active_model_run VALUES (1, 'newer', '2026-07-17T10:06:00.000Z');
      INSERT INTO ability_assessments VALUES ('assessment-1', 'newer');
      INSERT INTO ability_assessments VALUES ('assessment-2', 'newer');
      INSERT INTO daily_ability_snapshots VALUES ('snapshot-1', 'newer');
    `);

    const repository = new SqliteModelRunRepository(database);
    const summaries = repository.listSummaries();

    assert.deepEqual(summaries.map((summary) => summary.id), ["newer", "older"]);
    assert.equal(summaries[0]?.featureCount, 12);
    assert.equal(summaries[0]?.assessmentCount, 2);
    assert.equal(summaries[0]?.snapshotCount, 1);
    assert.equal(summaries[0]?.active, true);
    assert.equal(summaries[1]?.featureCount, null);
    assert.equal(repository.activeSummary()?.id, "newer");
    assert.equal(repository.featureRunId("newer"), "feature-newer");
    assert.equal(repository.featureRunId("missing"), null);
  } finally {
    database.close();
  }
});

test("activates only succeeded model runs with a succeeded training metric run", () => {
  const database = createDatabase();
  try {
    insertModelRun(database, "failed", "failed");
    insertModelRun(database, "newer", "succeeded");
    const repository = new SqliteModelRunRepository(database);

    assert.throws(() => repository.activateSucceeded("failed", "2026-07-17T10:00:00.000Z"), /succeeded model runs/);
    assert.throws(() => repository.activateSucceeded("newer", "2026-07-17T10:00:00.000Z"), /training metric run/);

    database.prepare("INSERT INTO training_metric_runs VALUES (?, ?, ?)")
      .run("metric-newer", "newer", "succeeded");
    database.prepare(
      "INSERT INTO active_prediction_model VALUES (1, 'prediction-old', '2026-07-17T09:00:00.000Z')"
    ).run();
    repository.activateSucceeded("newer", "2026-07-17T10:07:00.000Z");

    assert.equal(repository.activeSummary()?.id, "newer");
    const predictionActive = database.prepare(
      "SELECT COUNT(*) AS count FROM active_prediction_model"
    ).get() as { count: number };
    assert.equal(predictionActive.count, 0);
  } finally {
    database.close();
  }
});
