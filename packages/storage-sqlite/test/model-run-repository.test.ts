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
      created_at TEXT NOT NULL DEFAULT '2026-07-17T10:00:00.000Z',
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
      model_run_id TEXT NOT NULL,
      feature_id TEXT,
      training_session_id TEXT,
      sequence_number INTEGER,
      assessment_status TEXT,
      current_ability REAL,
      recovery_score REAL,
      effective_weights_json TEXT,
      confidence REAL,
      confidence_factors_json TEXT,
      updated_true_ability INTEGER,
      explanation_codes_json TEXT,
      explanation_json TEXT,
      assessed_at TEXT
    );
    CREATE TABLE daily_ability_snapshots (
      id TEXT PRIMARY KEY,
      model_run_id TEXT NOT NULL,
      local_date TEXT,
      true_ability REAL
    );
    CREATE TABLE training_sessions (
      id TEXT PRIMARY KEY,
      anchor_start_at TEXT
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
    CREATE TABLE model_validation_gates (
      id TEXT PRIMARY KEY,
      candidate_model_run_id TEXT NOT NULL,
      base_model_run_id TEXT,
      gate_version TEXT NOT NULL,
      status TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      thresholds_json TEXT NOT NULL,
      failure_reasons_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '2026-07-17T10:00:00.000Z',
      UNIQUE(candidate_model_run_id, gate_version)
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
      INSERT INTO ability_assessments (id, model_run_id) VALUES ('assessment-1', 'newer');
      INSERT INTO ability_assessments (id, model_run_id) VALUES ('assessment-2', 'newer');
      INSERT INTO daily_ability_snapshots (id, model_run_id) VALUES ('snapshot-1', 'newer');
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

test("persists a failed shadow gate and rejects activation without replacing incumbent", () => {
  const database = createDatabase();
  try {
    insertModelRun(database, "base", "succeeded");
    insertModelRun(database, "candidate", "succeeded");
    database.exec(`
      INSERT INTO active_model_run VALUES (1, 'base', '2026-07-17T10:06:00.000Z');
      INSERT INTO training_metric_runs VALUES ('metric-base', 'base', 'succeeded');
      INSERT INTO training_metric_runs VALUES ('metric-candidate', 'candidate', 'succeeded');
      INSERT INTO ability_assessments (
        id, model_run_id, feature_id, training_session_id, sequence_number,
        assessment_status, current_ability, recovery_score, effective_weights_json,
        confidence, confidence_factors_json, updated_true_ability,
        explanation_codes_json, explanation_json, assessed_at
      ) VALUES
        ('base-a', 'base', 'feature-a', 'session-a', 1, 'eligible', 50, 50, '{}', 1, '{}', 1, '[]', '{}', '2026-07-17T10:00:00.000Z'),
        ('candidate-a', 'candidate', 'feature-a', 'session-a', 1, 'eligible', 80, 0, '{}', 1, '{}', 1, '[]', '{}', '2026-07-17T10:00:00.000Z');
      INSERT INTO training_sessions (id, anchor_start_at) VALUES ('session-a', '2026-07-17T10:00:00.000Z');
    `);
    const repository = new SqliteModelRunRepository(database);
    const gate = repository.evaluateValidationGate("candidate", "base");
    assert.equal(gate.status, "failed");
    assert.ok(gate.failureReasons.includes("current_ability_mean_absolute_delta"));
    assert.throws(() => repository.activateSucceeded("candidate", "2026-07-17T10:07:00.000Z"), /shadow validation gate/);
    assert.equal(repository.activeSummary()?.id, "base");
  } finally {
    database.close();
  }
});
