import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  loadLactateThresholdEvidence,
  loadLabeledRaceOutcomes,
  loadPerformanceVdotEvidence,
  loadRaceReadiness,
  loadRaceReadinessEvidence
} from "../src/prediction-data.js";
import {
  buildPredictionReport,
  buildPredictionReportAsync
} from "../src/prediction-report.js";
import { buildRaceResidualTrainingDataset } from "../src/prediction-training-data.js";

function fixtureDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE training_sessions (
      id TEXT PRIMARY KEY,
      anchor_start_at TEXT NOT NULL,
      anchor_end_at TEXT NOT NULL,
      anchor_distance_km REAL,
      canonical_workout_id TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE workouts (
      id TEXT PRIMARY KEY,
      source_name TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      duration_seconds REAL
    );
    CREATE TABLE workout_features (
      id TEXT PRIMARY KEY,
      feature_run_id TEXT NOT NULL,
      training_session_id TEXT NOT NULL,
      source_confidence REAL NOT NULL,
      quality_score REAL NOT NULL,
      eligibility_status TEXT NOT NULL,
      missing_reasons_json TEXT NOT NULL,
      heart_rate_coverage REAL
    );
    CREATE TABLE model_runs (
      id TEXT PRIMARY KEY,
      feature_run_id TEXT NOT NULL
    );
    CREATE TABLE active_model_run (
      singleton INTEGER PRIMARY KEY,
      model_run_id TEXT NOT NULL
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
    CREATE TABLE workout_overrides (
      id TEXT PRIMARY KEY,
      training_session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      eligibility_override TEXT,
      statistics_participation TEXT,
      session_type TEXT,
      performance_protocol TEXT,
      rpe INTEGER,
      condition_tags_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE health_records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_category TEXT NOT NULL,
      unit TEXT,
      value_numeric REAL,
      start_at TEXT NOT NULL
    );
  `);
  database.prepare(
    "INSERT INTO workouts (id, source_name, metadata_json, duration_seconds) VALUES (?, ?, '{}', ?)"
  ).run("workout", "Watch", 1800);
  database.prepare(`
    INSERT INTO training_sessions (
      id, anchor_start_at, anchor_end_at, anchor_distance_km,
      canonical_workout_id, status
    ) VALUES (?, ?, ?, ?, ?, 'active')
  `).run(
    "session",
    "2026-01-10T00:00:00.000Z",
    "2026-01-10T00:30:00.000Z",
    5,
    "workout"
  );
  database.prepare(`
    INSERT INTO workout_features (
      id, feature_run_id, training_session_id, source_confidence,
      quality_score, eligibility_status, missing_reasons_json, heart_rate_coverage
    ) VALUES ('feature', 'feature-run', 'session', 1, 1, 'eligible', '[]', 1)
  `).run();
  database.prepare("INSERT INTO model_runs (id, feature_run_id) VALUES ('model', 'feature-run')")
    .run();
  database.prepare("INSERT INTO active_model_run (singleton, model_run_id) VALUES (1, 'model')")
    .run();
  const insertRecord = database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric, start_at
    ) VALUES (?, ?, ?, 'apple_watch', ?, ?, ?)
  `);
  insertRecord.run(
    "resting",
    "HKQuantityTypeIdentifierRestingHeartRate",
    "Watch",
    "count/min",
    60,
    "2026-01-09T00:00:00.000Z"
  );
  insertRecord.run(
    "maximum",
    "HKQuantityTypeIdentifierHeartRate",
    "Watch",
    "count/min",
    200,
    "2026-01-09T01:00:00.000Z"
  );
  for (let minute = 0; minute < 30; minute += 1) {
    const at = new Date(Date.parse("2026-01-10T00:00:00.000Z") + minute * 60_000)
      .toISOString();
    insertRecord.run(
      `speed-${minute}`,
      "HKQuantityTypeIdentifierRunningSpeed",
      "Watch",
      "m/s",
      minute < 5 ? 2.5 : 3,
      at
    );
    insertRecord.run(
      `heart-${minute}`,
      "HKQuantityTypeIdentifierHeartRate",
      "Watch",
      "count/min",
      minute < 5 ? 140 : 175,
      at
    );
  }
  return database;
}

test("V2 prediction modes isolate recovery and give an exactly reconstructible correction ledger", async () => {
  const db = fixtureDatabase();
  try {
    db.prepare(`INSERT INTO health_records
      (id,type,source_name,source_category,unit,value_numeric,start_at)
      VALUES ('vo2','HKQuantityTypeIdentifierVO2Max','Watch','apple_watch','ml/kg*min',50,'2026-01-09T00:00:00.000Z')`).run();
    const options = { asOf: "2026-01-11T00:00:00.000Z", mode: "current_prepared" as const };
    const low = buildPredictionReport(db, { ...options, recoveryReadiness: 0 });
    const high = buildPredictionReport(db, { ...options, recoveryReadiness: 1 });
    assert.deepEqual(low.snapshot.races, high.snapshot.races);
    assert.ok(low.snapshot.races.some((row) => row.predictedSeconds !== null));
    for (const race of low.snapshot.races) {
      if (race.predictedSeconds === null) continue;
      const ledger = low.predictionPolicy!.corrections.find((row) => row.distance === race.distance)!;
      assert.ok(Math.abs(ledger.steps.at(-1)!.afterSeconds - race.predictedSeconds) < 1e-6);
      assert.equal(race.fatigueAdjustmentSeconds, 0);
      assert.equal(race.calibrationAdjustmentSeconds, 0);
    }
    const neutral = buildPredictionReport(db, { ...options, mode: "neutral_potential", temperatureC: 35 });
    for (const race of neutral.snapshot.races) assert.equal(race.potentialSeconds, race.predictedSeconds);
    const future = await buildPredictionReportAsync(db, {
      ...options, mode: "race_day_scenario", targetDate: "2026-06-01", temperatureC: 35
    });
    assert.equal(future.inputs.recoveryReadiness, null);
    assert.equal(future.predictionPolicy?.pointCorrection, "none");
    assert.equal(future.predictionPolicy?.intervalStatus, "insufficient_calibration");
    assert.ok(future.snapshot.races.some((row) => (row.environmentAdjustmentSeconds ?? 0) > 0));
    assert.throws(() => buildPredictionReport(db, { ...options, mode: "race_day_scenario" }), /targetDate/);
  } finally { db.close(); }
});

test("extracts a stable high-intensity 20-minute threshold segment without future leakage", () => {
  const database = fixtureDatabase();
  try {
    const evidence = loadLactateThresholdEvidence(
      database,
      "2026-01-11T00:00:00.000Z"
    );
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.source, "sustained_segment");
    assert.ok(Math.abs((evidence[0]?.paceSecondsPerKm ?? 0) - 333.333) < 0.01);
    assert.equal(evidence[0]?.heartRateBpm, 175);
    assert.equal(
      loadLactateThresholdEvidence(database, "2026-01-09T00:00:00.000Z").length,
      0
    );
  } finally {
    database.close();
  }
});

test("distance-specific readiness is bounded and stricter for longer races", () => {
  const database = fixtureDatabase();
  try {
    const readiness = loadRaceReadiness(database, "2026-01-11T00:00:00.000Z");
    assert.ok((readiness.five_k ?? 0) > (readiness.ten_k ?? 0));
    assert.ok((readiness.ten_k ?? 0) > (readiness.half_marathon ?? 0));
    assert.ok(Object.values(readiness).every((value) => value >= 0 && value <= 1));
  } finally {
    database.close();
  }
});

test("ordinary training contributes to the performance envelope within the as-of window", () => {
  const database = fixtureDatabase();
  try {
    const evidence = loadPerformanceVdotEvidence(database, "2026-01-11T00:00:00.000Z");
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.source, "training_envelope");
  } finally {
    database.close();
  }
});

test("missing race training is represented as insufficient data instead of zero readiness", () => {
  const database = fixtureDatabase();
  try {
    database.prepare("DELETE FROM training_sessions").run();
    const evidence = loadRaceReadinessEvidence(database, "2026-01-11T00:00:00.000Z");
    assert.deepEqual(evidence.values, {});
    assert.equal(evidence.status, "insufficient_data");
    assert.equal(evidence.evidenceCount, 0);
    assert.equal(loadRaceReadiness(database, "2026-01-11T00:00:00.000Z").five_k, undefined);
  } finally {
    database.close();
  }
});

test("structured standard-test protocol becomes calibration and evaluation evidence", () => {
  const database = fixtureDatabase();
  try {
    database.prepare(`
      INSERT INTO workout_overrides (
        id, training_session_id, revision, session_type, performance_protocol,
        condition_tags_json, created_at
      ) VALUES ('override-1', 'session', 1, 'race', 'five_k_time_trial', '[]',
        '2026-01-10T00:29:00.000Z')
    `).run();
    const asOf = "2026-01-11T00:00:00.000Z";
    const outcomes = loadLabeledRaceOutcomes(database, asOf);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.distance, "five_k");
    assert.equal(outcomes[0]?.labelSource, "standard_test");
    assert.equal(outcomes[0]?.labelAvailableAt, "2026-01-10T00:30:00.000Z");
    const performance = loadPerformanceVdotEvidence(database, asOf);
    assert.equal(performance.length, 1);
    assert.equal(performance[0]?.source, "standard_test");
  } finally {
    database.close();
  }
});

test("does not expose a labeled outcome until the workout has completed", () => {
  const database = fixtureDatabase();
  try {
    database.prepare(`
      INSERT INTO workout_overrides (
        id, training_session_id, revision, session_type, performance_protocol,
        condition_tags_json, created_at
      ) VALUES ('override-1', 'session', 1, 'race', 'five_k_time_trial', '[]',
        '2026-01-10T00:29:00.000Z')
    `).run();
    assert.equal(
      loadLabeledRaceOutcomes(database, "2026-01-10T00:15:00.000Z").length,
      0
    );
    assert.equal(
      loadLabeledRaceOutcomes(database, "2026-01-10T00:30:00.000Z").length,
      1
    );
  } finally {
    database.close();
  }
});

test("rejects race labels outside standard-distance and plausible-pace bounds", () => {
  const database = fixtureDatabase();
  try {
    database.prepare(`
      INSERT INTO workout_overrides (
        id, training_session_id, revision, session_type, performance_protocol,
        condition_tags_json, created_at
      ) VALUES ('override-1', 'session', 1, 'race', 'five_k_time_trial', '[]',
        '2026-01-10T00:30:00.000Z')
    `).run();
    const asOf = "2026-01-11T00:00:00.000Z";
    database.prepare("UPDATE training_sessions SET anchor_distance_km = 5.2 WHERE id = 'session'")
      .run();
    assert.equal(loadLabeledRaceOutcomes(database, asOf).length, 0);

    database.prepare(`
      UPDATE training_sessions
      SET anchor_distance_km = 5.01,
          anchor_end_at = '2026-01-10T00:10:00.000Z'
      WHERE id = 'session'
    `).run();
    database.prepare("UPDATE workouts SET duration_seconds = 600 WHERE id = 'workout'").run();
    assert.equal(loadLabeledRaceOutcomes(database, asOf).length, 0);

    database.prepare(`
      UPDATE training_sessions
      SET anchor_end_at = '2026-01-10T00:30:00.000Z'
      WHERE id = 'session'
    `).run();
    database.prepare("UPDATE workouts SET duration_seconds = 1800 WHERE id = 'workout'").run();
    assert.equal(loadLabeledRaceOutcomes(database, asOf).length, 1);
  } finally {
    database.close();
  }
});

test("uses only override revisions that existed at the historical cutoff", () => {
  const database = fixtureDatabase();
  try {
    database.prepare(`
      INSERT INTO workout_overrides (
        id, training_session_id, revision, session_type, performance_protocol,
        condition_tags_json, created_at
      ) VALUES (?, 'session', ?, 'race', ?, '[]', ?)
    `).run("override-late", 2, "five_k_time_trial", "2026-02-01T00:00:00.000Z");

    assert.equal(loadLabeledRaceOutcomes(database, "2026-01-11T00:00:00.000Z").length, 0);
    const outcomes = loadLabeledRaceOutcomes(database, "2026-02-02T00:00:00.000Z");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.labelAvailableAt, "2026-02-01T00:00:00.000Z");
  } finally {
    database.close();
  }
});

test("training samples exclude conditions available only from workout results", () => {
  const database = fixtureDatabase();
  try {
    database.prepare(`
      UPDATE workouts SET metadata_json = ? WHERE id = 'workout'
    `).run(JSON.stringify({
      HKWeatherTemperature: "86 degF",
      HKWeatherHumidity: "8000 %",
      HKElevationAscended: "15000 cm"
    }));
    database.prepare(`
      INSERT INTO workout_overrides (
        id, training_session_id, revision, session_type, performance_protocol,
        condition_tags_json, created_at
      ) VALUES ('override-1', 'session', 1, 'race', 'five_k_time_trial', '[]',
        '2026-01-10T00:30:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO health_records (
        id, type, source_name, source_category, unit, value_numeric, start_at
      ) VALUES ('vo2', 'HKQuantityTypeIdentifierVO2Max', 'Watch', 'apple_watch',
        'mL/min路kg', 45, '2026-01-09T02:00:00.000Z')
    `).run();
    const dataset = buildRaceResidualTrainingDataset(
      database,
      "2026-01-11T00:00:00.000Z"
    );
    assert.equal(dataset.samples.length, 1);
    assert.equal(dataset.samples[0]?.features.temperatureC, null);
    assert.equal(dataset.samples[0]?.features.humidityPercent, null);
    assert.equal(dataset.samples[0]?.features.elevationGainMeters, null);
  } finally {
    database.close();
  }
});

test("builds a reusable scenario prediction report without reading future evidence", async () => {
  const database = fixtureDatabase();
  try {
    database.prepare(`
      INSERT INTO health_records (
        id, type, source_name, source_category, unit, value_numeric, start_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "vo2-current",
      "HKQuantityTypeIdentifierVO2Max",
      "Watch",
      "apple_watch",
      "mL/min·kg",
      45,
      "2026-01-09T02:00:00.000Z"
    );
    database.prepare(`
      INSERT INTO health_records (
        id, type, source_name, source_category, unit, value_numeric, start_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "vo2-future",
      "HKQuantityTypeIdentifierVO2Max",
      "Watch",
      "apple_watch",
      "mL/min·kg",
      70,
      "2027-01-09T02:00:00.000Z"
    );
    const report = buildPredictionReport(database, {
      asOf: "2026-01-11T00:00:00.000Z",
      temperatureC: 30,
      humidityPercent: 80,
      elevationGainMeters: { ten_k: 150 }
    });
    assert.equal(report.inputs.directVo2Evidence, 1);
    assert.equal(report.inputs.scenario.temperatureC, 30);
    assert.equal(report.inputs.scenario.elevationGainMeters.ten_k, 150);
    assert.equal(report.explainability?.schemaVersion, "prediction-explainability-v1");
    assert.equal(report.explainability?.readiness.five_k.status, "available");
    assert.equal(report.explainability?.recovery.coverage, "none");
    assert.ok((report.snapshot.vo2Max.valueMlKgMin ?? 0) < 50);
    const tenK = report.snapshot.races.find((race) => race.distance === "ten_k");
    assert.equal(tenK?.status, "available");
    assert.ok((tenK?.environmentAdjustmentSeconds ?? 0) > 0);
    assert.ok((tenK?.elevationAdjustmentSeconds ?? 0) > 0);
    assert.equal(report.modelSelection.machineLearning.status, "insufficient_samples");
    assert.equal(tenK?.machineLearningFallbackReason, "no_active_model");
    const asyncReport = await buildPredictionReportAsync(database, {
      asOf: "2026-01-11T00:00:00.000Z"
    });
    assert.equal(asyncReport.modelSelection.machineLearning.activeModelRunId, null);
    assert.equal(
      asyncReport.snapshot.races.find((race) => race.distance === "five_k")
        ?.machineLearningFallbackReason,
      "no_active_model"
    );
  } finally {
    database.close();
  }
});
