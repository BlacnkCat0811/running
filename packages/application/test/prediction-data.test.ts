import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqlitePerformanceEntryRepository } from "@rai/storage-sqlite";

import {
  expandPerformanceEventExclusions,
  loadDirectVo2Evidence,
  loadLactateThresholdEvidence,
  loadLabeledRaceOutcomes,
  loadPerformanceVdotEvidence,
  loadPhysiologyProfile,
  loadRaceReadiness,
  loadRaceReadinessEvidence
} from "../src/prediction-data.js";
import {
  buildFormulaPredictionBase,
  buildPredictionEvaluationReport,
  buildPredictionReport,
  buildPredictionReportAsync
} from "../src/prediction-report.js";
import { buildRaceResidualTrainingDataset, loadTrainingContext } from "../src/prediction-training-data.js";
import { buildPersonalCalibrationSamples } from "../src/personal-calibration.js";
import { calibrateRacePrediction } from "@rai/physiology";

function fixtureDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE performance_entries (
      id TEXT PRIMARY KEY, local_date TEXT NOT NULL, distance TEXT NOT NULL,
      duration_seconds REAL NOT NULL, source TEXT NOT NULL, note TEXT,
      recorded_at TEXT NOT NULL, revoked_at TEXT, revision INTEGER NOT NULL,
      training_session_id TEXT, observed_at TEXT, completed_at TEXT
    );
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
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL
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
      id, type, source_name, source_category, unit, value_numeric, start_at, end_at
    ) VALUES (?, ?, ?, 'apple_watch', ?, ?, ?, ?)
  `);
  insertRecord.run(
    "resting",
    "HKQuantityTypeIdentifierRestingHeartRate",
    "Watch",
    "count/min",
    60,
    "2026-01-09T00:00:00.000Z",
    "2026-01-09T00:00:00.000Z"
  );
  insertRecord.run(
    "maximum",
    "HKQuantityTypeIdentifierHeartRate",
    "Watch",
    "count/min",
    200,
    "2026-01-09T01:00:00.000Z",
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
      at,
      at
    );
    insertRecord.run(
      `heart-${minute}`,
      "HKQuantityTypeIdentifierHeartRate",
      "Watch",
      "count/min",
      minute < 5 ? 140 : 175,
      at,
      at
    );
  }
  return database;
}

test("pre-race health features require completed samples and exclude every overlapping event interval", () => {
  const db = fixtureDatabase();
  try {
    db.exec(`INSERT INTO workout_overrides VALUES ('race-label', 'session', 1, NULL, NULL,
      'race', 'five_k_time_trial', 10, '[]', '2026-01-10T01:00:00.000Z')`);
    const raceStart = "2026-01-10T00:00:00.000Z";
    const asOf = "2026-01-11T00:00:00.000Z";
    assert.deepEqual(buildRaceResidualTrainingDataset(db, asOf).samples, []);
    const insert = db.prepare(`INSERT INTO health_records
      (id, type, source_name, source_category, unit, value_numeric, start_at, end_at)
      VALUES (?, ?, 'Watch', 'apple_watch', ?, ?, ?, ?)`);
    for (const [id, type, unit, value] of [
      ["vo2", "HKQuantityTypeIdentifierVO2Max", "mL/min*kg", 60],
      ["resting", "HKQuantityTypeIdentifierRestingHeartRate", "count/min", 100],
      ["heart", "HKQuantityTypeIdentifierHeartRate", "count/min", 240]
    ] as const) {
      for (const [suffix, start, end] of [
        ["crosses-start", "2026-01-10T07:59:00+08:00", "2026-01-10T08:20:00+08:00"],
        ["contains-event", "2026-01-09T23:59:00Z", "2026-01-10T00:31:00Z"],
        ["crosses-end", "2026-01-10T00:29:00Z", "2026-01-10T00:31:00Z"]
      ] as const) insert.run(`${id}-${suffix}`, type, unit, value, start, end);
    }
    const heldOut = new Set(["session"]);
    assert.deepEqual(loadDirectVo2Evidence(db, raceStart, heldOut), []);
    assert.deepEqual(loadPhysiologyProfile(db, raceStart, heldOut), {
      restingHeartRateBpm: 60, observedMaximumHeartRateBpm: 200
    });
    assert.deepEqual(buildRaceResidualTrainingDataset(db, asOf).samples, [],
      "a VO2 sample ending during the race cannot create a pre-race training baseline");
    assert.deepEqual(loadDirectVo2Evidence(db, asOf, heldOut), [],
      "completed samples starting before the race are still excluded if their intervals overlap it");
    assert.deepEqual(loadPhysiologyProfile(db, asOf, heldOut), {
      restingHeartRateBpm: 60, observedMaximumHeartRateBpm: 200
    });
    insert.run("prior-vo2", "HKQuantityTypeIdentifierVO2Max", "mL/min*kg", 45,
      "2026-01-09T00:00:00Z", "2026-01-09T00:20:00Z");
    const samples = buildRaceResidualTrainingDataset(db, asOf).samples;
    assert.equal(samples.length, 1);
    assert.equal(samples[0]!.features.vo2Max, 45);
    db.exec("UPDATE health_records SET value_numeric=90 WHERE id LIKE 'vo2-%'");
    assert.deepEqual(buildRaceResidualTrainingDataset(db, asOf).samples, samples,
      "changing held-out health evidence cannot change the target's feature vector");
  } finally { db.close(); }
});

test("health completion cutoffs compare absolute instants, including samples ending exactly at the cutoff", () => {
  const db = fixtureDatabase();
  try {
    const cutoff = "2026-01-10T00:00:00.000Z";
    const insert = db.prepare(`INSERT INTO health_records VALUES (?, 'HKQuantityTypeIdentifierVO2Max',
      'Watch', 'apple_watch', 'mL/min*kg', 50, ?, ?)`);
    insert.run("completed", "2026-01-10T07:58:00+08:00", "2026-01-10T07:59:00+08:00");
    insert.run("at-cutoff", "2026-01-09T23:59:00Z", "2026-01-10T08:00:00+08:00");
    insert.run("unfinished", "2026-01-09T23:59:00Z", "2026-01-10T00:00:01Z");
    insert.run("future", "2026-01-09T23:59:00-01:00", "2026-01-10T00:00:00-01:00");
    const evidence = loadDirectVo2Evidence(db, cutoff);
    assert.deepEqual(evidence.map(row => row.id).sort(), ["at-cutoff", "completed"]);
    assert.equal(evidence.find(row => row.id === "completed")?.observedAt, "2026-01-10T07:59:00+08:00");
    assert.deepEqual(loadDirectVo2Evidence(db, "2026-01-10T08:00:00+08:00"), evidence);
  } finally { db.close(); }
});

test("confirmed candidates retain race clocks and hold out the entire event", () => {
  const db = fixtureDatabase();
  try {
    const entry = new SqlitePerformanceEntryRepository(db).insert({ localDate: "2026-01-10",
      distance: "five_k", durationSeconds: 1800, note: null, trainingSessionId: "session",
      recordedAt: "2026-01-11T00:00:00.000Z" });
    const asOf = "2026-01-12T00:00:00.000Z";
    const [outcome] = loadLabeledRaceOutcomes(db, asOf);
    assert.equal(outcome?.observedAt, "2026-01-10T00:00:00.000Z");
    assert.equal(outcome?.completedAt, "2026-01-10T00:30:00.000Z");
    assert.deepEqual(outcome?.trainingSessionIds, ["session"]);
    assert.deepEqual(buildRaceResidualTrainingDataset(db, asOf).samples, []);
    assert.deepEqual(loadPerformanceVdotEvidence(db, asOf, new Set([entry.id])), []);
    const heldOut = buildFormulaPredictionBase(db, asOf, { mode: "current_prepared", excludeLabelIds: [entry.id] });
    assert.equal(heldOut.thresholdEvidenceCount, 0);
    assert.equal(heldOut.readinessEvidenceCount, 0);
    assert.equal(heldOut.performanceVdotEvidenceCount, 0);
    assert.equal(buildPersonalCalibrationSamples(db, asOf).scoredCount, 0);
    db.exec(`INSERT INTO health_records VALUES ('race-vo2', 'HKQuantityTypeIdentifierVO2Max', 'Watch', 'apple_watch',
      'mL/min*kg', 60, '2026-01-10T00:20:00Z', '2026-01-10T00:20:00Z');
      UPDATE health_records SET value_numeric = 210 WHERE id = 'heart-10'`);
    const withoutRaceHealth = buildFormulaPredictionBase(db, asOf, { mode: "neutral_potential", excludeLabelIds: [entry.id] });
    assert.equal(withoutRaceHealth.directEvidenceCount, 0);
    assert.equal(withoutRaceHealth.profile.observedMaximumHeartRateBpm, 200);
    assert.equal(buildPersonalCalibrationSamples(db, asOf).scoredCount, 0, "own race health measurements cannot inform its held-out residual");
    const context = loadTrainingContext(db, asOf, "five_k", new Set(outcome?.trainingSessionIds));
    assert.equal(context.weeklyDistance4wKm, 0);
    assert.equal(context.longestRun8wKm, 0);
    assert.equal(context.runFrequency4wPerWeek, 0);

    db.exec(`INSERT INTO workout_overrides VALUES ('label', 'session', 1, NULL, NULL,
      'race', 'five_k_time_trial', 10, '[]', '2026-01-10T01:00:00Z')`);
    assert.equal(loadLabeledRaceOutcomes(db, asOf).length, 1, "watch and confirmation represent one event");
    assert.equal(loadPerformanceVdotEvidence(db, asOf).length, 1);
    assert.deepEqual(loadPerformanceVdotEvidence(db, asOf, new Set(["session"])), []);
  } finally { db.close(); }
});

test("explicit confirmations do not absorb independent same-day runs", () => {
  const db = fixtureDatabase();
  try {
    db.exec(`INSERT INTO training_sessions VALUES ('independent', '2026-01-10T09:00:00Z',
      '2026-01-10T09:30:00Z', 5, NULL, 'active');
      INSERT INTO workout_overrides VALUES ('excluded-other-run', 'independent', 1, 'exclude', NULL,
        'race', 'five_k_time_trial', 10, '[]', '2026-01-10T10:00:00Z')`);
    const entry = new SqlitePerformanceEntryRepository(db).insert({ localDate: "2026-01-10",
      distance: "five_k", durationSeconds: 1800, note: null, trainingSessionId: "session",
      recordedAt: "2026-01-11T00:00:00Z" });
    const outcomes = loadLabeledRaceOutcomes(db, "2026-01-12T00:00:00Z");
    assert.equal(outcomes.length, 1, "an excluded independent run must not discard the confirmed race");
    assert.deepEqual(outcomes[0]!.trainingSessionIds, ["session"]);
    assert.deepEqual([...expandPerformanceEventExclusions(db, new Set([entry.id]), "2026-01-12T00:00:00Z")].sort(), [entry.id, "session"].sort());
    assert.deepEqual([...expandPerformanceEventExclusions(db, new Set(["independent"]), "2026-01-12T00:00:00Z")], ["independent"]);
    db.exec(`INSERT INTO training_sessions VALUES ('same-event', '2026-01-10T00:01:00Z',
      '2026-01-10T00:29:00Z', 5, NULL, 'active')`);
    assert.deepEqual(loadLabeledRaceOutcomes(db, "2026-01-12T00:00:00Z")[0]!.trainingSessionIds,
      ["same-event", "session"]);
    assert.ok(expandPerformanceEventExclusions(db, new Set(["same-event"]), "2026-01-12T00:00:00Z").has(entry.id));
  } finally { db.close(); }
});

test("explicit held-out targets retain their event identity before confirmation and after revocation", () => {
  const db = fixtureDatabase();
  try {
    const entries = new SqlitePerformanceEntryRepository(db);
    const entry = entries.insert({ localDate: "2026-01-10", distance: "five_k", durationSeconds: 1800,
      note: null, trainingSessionId: "session", recordedAt: "2026-01-11T00:00:00Z" });
    entries.revoke(entry.id, "2026-01-13T00:00:00Z");
    for (const asOf of ["2026-01-10T00:00:00Z", "2026-01-13T00:00:00Z"]) {
      assert.deepEqual([...expandPerformanceEventExclusions(db, new Set([entry.id]), asOf)].sort(),
        [entry.id, "session"].sort());
      assert.deepEqual([...expandPerformanceEventExclusions(db, new Set(["session"]), asOf)],
        ["session"], "unavailable labels cannot introduce indirect event associations");
    }
  } finally { db.close(); }
});

test("indirect date-only exclusions respect both recording and revocation instants", () => {
  const db = fixtureDatabase();
  try {
    db.exec(`INSERT INTO training_sessions VALUES ('independent', '2026-01-10T09:00:00Z',
      '2026-01-10T09:30:00Z', 5, NULL, 'active')`);
    const entries = new SqlitePerformanceEntryRepository(db);
    const entry = entries.insert({ localDate: "2026-01-10", distance: "five_k", durationSeconds: 1800,
      note: null, recordedAt: "2026-01-11T00:00:00Z" });
    entries.revoke(entry.id, "2026-01-13T00:00:00Z");
    const heldOut = new Set(["independent"]);
    assert.deepEqual([...expandPerformanceEventExclusions(db, heldOut, "2026-01-10T12:00:00Z")],
      ["independent"]);
    assert.deepEqual([...expandPerformanceEventExclusions(db, heldOut, "2026-01-11T08:00:00+08:00")].sort(),
      [entry.id, "independent", "session"].sort(), "recording is inclusive and later revocation does not rewrite history");
    assert.deepEqual([...expandPerformanceEventExclusions(db, heldOut, "2026-01-13T00:00:00Z")],
      ["independent"], "revocation is effective at the cutoff");
  } finally { db.close(); }
});

test("available event exclusions are stable when baseline and feature loaders expand them again", () => {
  const db = fixtureDatabase();
  try {
    db.exec(`INSERT INTO training_sessions VALUES ('before-midnight', '2026-01-10T15:30:00Z',
      '2026-01-10T15:59:00Z', 5, NULL, 'active');
      INSERT INTO training_sessions VALUES ('across-midnight', '2026-01-10T15:50:00Z',
      '2026-01-10T16:20:00Z', 5, NULL, 'active');
      INSERT INTO training_sessions VALUES ('after-midnight', '2026-01-10T16:10:00Z',
      '2026-01-10T16:40:00Z', 5, NULL, 'active')`);
    const entries = new SqlitePerformanceEntryRepository(db);
    const dateOnly = entries.insert({ localDate: "2026-01-10", distance: "five_k", durationSeconds: 1800,
      note: null, recordedAt: "2026-01-12T00:00:00Z" });
    const linked = entries.insert({ localDate: "2026-01-11", distance: "five_k", durationSeconds: 1800,
      note: null, trainingSessionId: "across-midnight", recordedAt: "2026-01-12T00:00:00Z" });
    const asOf = "2026-01-13T00:00:00Z";
    const expanded = expandPerformanceEventExclusions(db, new Set(["after-midnight"]), asOf);
    assert.deepEqual([...expanded].sort(), [dateOnly.id, linked.id, "session", "before-midnight",
      "across-midnight", "after-midnight"].sort());
    assert.deepEqual([...expandPerformanceEventExclusions(db, expanded, asOf)].sort(), [...expanded].sort());
  } finally { db.close(); }
});

test("date-only and legacy results cannot consume same-day race evidence", () => {
  const db = fixtureDatabase();
  try {
    const entry = new SqlitePerformanceEntryRepository(db).insert({ localDate: "2026-01-10",
      distance: "five_k", durationSeconds: 1800, note: null, recordedAt: "2026-01-11T00:00:00Z" });
    const asOf = "2026-01-12T00:00:00Z";
    assert.equal(loadLabeledRaceOutcomes(db, asOf)[0]?.observedAt, "2026-01-09T16:00:00.000Z");
    assert.deepEqual(buildRaceResidualTrainingDataset(db, asOf).samples, []);
    assert.deepEqual(loadPerformanceVdotEvidence(db, asOf, new Set([entry.id])), []);
  } finally { db.close(); }
});

test("historical exclusion removes labeled VDOT and linked confirmations only when effective", () => {
  const db = fixtureDatabase();
  try {
    db.exec(`INSERT INTO workout_overrides VALUES ('label', 'session', 1, NULL, NULL,
      'race', 'five_k_time_trial', 10, '[]', '2026-01-10T01:00:00Z');
      INSERT INTO workout_overrides VALUES ('exclude', 'session', 2, 'exclude', NULL,
      'race', 'five_k_time_trial', 10, '[]', '2026-01-12T01:00:00Z')`);
    new SqlitePerformanceEntryRepository(db).insert({ localDate: "2026-01-10", distance: "five_k",
      durationSeconds: 1800, note: null, trainingSessionId: "session", recordedAt: "2026-01-11T00:00:00Z" });
    assert.equal(loadPerformanceVdotEvidence(db, "2026-01-12T00:00:00Z").length, 1);
    assert.equal(loadLabeledRaceOutcomes(db, "2026-01-12T00:00:00Z").length, 1);
    assert.deepEqual(loadPerformanceVdotEvidence(db, "2026-01-13T00:00:00Z"), []);
    assert.deepEqual(loadLabeledRaceOutcomes(db, "2026-01-13T00:00:00Z"), []);
  } finally { db.close(); }
});

test("mixed-source outcomes are globally ordered by absolute instant with stable ties", () => {
  const db = fixtureDatabase();
  try {
    db.exec(`UPDATE training_sessions SET anchor_start_at = '2026-01-10T08:00:00+08:00',
      anchor_end_at = '2026-01-10T08:30:00+08:00';
      INSERT INTO workout_overrides VALUES ('label', 'session', 1, NULL, NULL,
        'race', 'five_k_time_trial', 10, '[]', '2026-01-10T01:00:00Z')`);
    const repository = new SqlitePerformanceEntryRepository(db);
    const earlier = repository.insert({ localDate: "2026-01-09", distance: "five_k", durationSeconds: 1800,
      note: null, recordedAt: "2026-01-10T01:00:00Z" });
    const later = repository.insert({ localDate: "2026-01-11", distance: "five_k", durationSeconds: 1800,
      note: null, recordedAt: "2026-01-12T01:00:00Z" });
    const outcomes = loadLabeledRaceOutcomes(db, "2026-02-01T00:00:00Z");
    assert.deepEqual(outcomes.map(row => row.id), [earlier.id, "session", later.id]);
    assert.ok(Date.parse(outcomes[0]!.labelAvailableAt) > Date.parse(outcomes[1]!.observedAt),
      "chronology does not backdate a delayed confirmation's availability");
  } finally { db.close(); }
});

test("walk-forward calibration sees earlier manual labels but not delayed confirmations", () => {
  const db = fixtureDatabase();
  try {
    db.exec(`UPDATE training_sessions SET anchor_start_at = '2026-06-01T00:00:00Z',
      anchor_end_at = '2026-06-01T00:50:00Z', anchor_distance_km = 10;
      UPDATE workouts SET duration_seconds = 3000;
      INSERT INTO workout_overrides VALUES ('label', 'session', 1, NULL, NULL,
        'race', 'ten_k_time_trial', 10, '[]', '2026-06-01T01:00:00Z');
      INSERT INTO health_records VALUES ('vo2', 'HKQuantityTypeIdentifierVO2Max', 'Watch', 'apple_watch',
        'mL/min*kg', 50, '2025-12-01T00:00:00Z', '2025-12-01T00:00:00Z')`);
    const repository = new SqlitePerformanceEntryRepository(db);
    for (let month = 1; month <= 5; month++) {
      const date = `2026-${String(month).padStart(2, "0")}-01`;
      repository.insert({ localDate: date, distance: "ten_k", durationSeconds: 3100, note: null,
        recordedAt: month === 3 ? "2026-07-01T00:00:00Z" : `${date.slice(0, 8)}02T00:00:00Z` });
    }
    const asOf = "2026-09-30T00:00:00Z";
    const report = buildPredictionEvaluationReport(db, asOf);
    const june = "2026-06-01T00:00:00Z";
    const outcomes = loadLabeledRaceOutcomes(db, asOf);
    const available = new Set(outcomes.filter(row => Date.parse(row.labelAvailableAt) <= Date.parse(june)).map(row => Date.parse(row.observedAt)));
    const earlier = report.rawErrors.filter(row => Date.parse(row.predictionGeneratedAt) < Date.parse(june) && available.has(Date.parse(row.predictionGeneratedAt)));
    assert.equal(earlier.length, 4);
    const prediction = buildFormulaPredictionBase(db, june, {}).snapshot.races.find(row => row.distance === "ten_k")!;
    const expected = calibrateRacePrediction(prediction, june, earlier);
    const actual = report.calibratedErrors.find(row => Date.parse(row.predictionGeneratedAt) === Date.parse(june));
    assert.ok(actual);
    assert.equal(actual.predictedSeconds, expected.predictedSeconds);
  } finally { db.close(); }
});

test("P03: V2 prediction modes isolate recovery and give an exactly reconstructible correction ledger", async () => {
  const db = fixtureDatabase();
  try {
    db.prepare(`INSERT INTO health_records
      (id,type,source_name,source_category,unit,value_numeric,start_at,end_at)
      VALUES ('vo2','HKQuantityTypeIdentifierVO2Max','Watch','apple_watch','ml/kg*min',50,'2026-01-09T00:00:00.000Z','2026-01-09T00:00:00.000Z')`).run();
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

test("threshold health evidence ends within a completed session at the absolute feature cutoff", () => {
  const db = fixtureDatabase();
  try {
    const afterSession = "2026-01-11T00:00:00.000Z";
    assert.equal(loadLactateThresholdEvidence(db, afterSession).length, 1);
    db.exec("UPDATE health_records SET end_at='2026-01-12T00:00:00Z' WHERE id LIKE 'speed-%'");
    assert.deepEqual(loadLactateThresholdEvidence(db, afterSession), [],
      "records starting during a prior session but finishing later cannot inform its threshold segment");
    db.exec(`UPDATE health_records SET end_at=start_at WHERE id LIKE 'speed-%';
      UPDATE training_sessions SET anchor_end_at='2026-01-09T23:30:00-01:00' WHERE id='session'`);
    assert.deepEqual(loadLactateThresholdEvidence(db, "2026-01-10T00:10:00Z"), [],
      "a lexically earlier end clock is still a future absolute instant");
    assert.equal(loadLactateThresholdEvidence(db, afterSession).length, 1);
  } finally { db.close(); }
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
        id, type, source_name, source_category, unit, value_numeric, start_at, end_at
      ) VALUES ('vo2', 'HKQuantityTypeIdentifierVO2Max', 'Watch', 'apple_watch',
        'mL/min路kg', 45, '2026-01-09T02:00:00.000Z', '2026-01-09T02:00:00.000Z')
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
        id, type, source_name, source_category, unit, value_numeric, start_at, end_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "vo2-current",
      "HKQuantityTypeIdentifierVO2Max",
      "Watch",
      "apple_watch",
      "mL/min·kg",
      45,
      "2026-01-09T02:00:00.000Z",
      "2026-01-09T02:00:00.000Z"
    );
    database.prepare(`
      INSERT INTO health_records (
        id, type, source_name, source_category, unit, value_numeric, start_at, end_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "vo2-future",
      "HKQuantityTypeIdentifierVO2Max",
      "Watch",
      "apple_watch",
      "mL/min·kg",
      70,
      "2027-01-09T02:00:00.000Z",
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
