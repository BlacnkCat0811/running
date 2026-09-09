import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteWorkoutReadRepository } from "../src/read/workout-read-repository.js";

test("average cadence falls back to overlapping step-count records", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE workout_statistics (
      workout_id TEXT, type TEXT, ordinal INTEGER, sum_value REAL, average_value REAL
    );
    CREATE TABLE workouts (
      id TEXT, source_name TEXT, start_at TEXT, end_at TEXT
    );
    CREATE TABLE health_records (
      source_name TEXT, type TEXT, value_numeric REAL, start_at TEXT, end_at TEXT
    );
    INSERT INTO workouts VALUES (
      'workout_1', 'RQ Run', '2026-07-16T12:00:00.000Z', '2026-07-16T12:01:00.000Z'
    );
    INSERT INTO health_records VALUES
      ('RQ Run', 'HKQuantityTypeIdentifierStepCount', 80, '2026-07-16T12:00:00.000Z', '2026-07-16T12:00:30.000Z'),
      ('RQ Run', 'HKQuantityTypeIdentifierStepCount', 80, '2026-07-16T12:00:30.000Z', '2026-07-16T12:01:00.000Z'),
      ('RQ Run', 'HKQuantityTypeIdentifierStepCount', 80, '2026-07-16T12:00:00.000Z', '2026-07-16T12:00:30.000Z'),
      ('RQ Run', 'HKQuantityTypeIdentifierStepCount', 80, '2026-07-16T12:00:30.000Z', '2026-07-16T12:01:00.000Z');
  `);

  try {
    assert.equal(new SqliteWorkoutReadRepository(database).averageCadence("workout_1", 60), 160);
  } finally {
    database.close();
  }
});

test("running dynamics averages fall back to deduplicated health records", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE workout_statistics (
      workout_id TEXT, type TEXT, ordinal INTEGER, sum_value REAL, average_value REAL
    );
    CREATE TABLE workouts (
      id TEXT, source_name TEXT, start_at TEXT, end_at TEXT
    );
    CREATE TABLE health_records (
      source_name TEXT, type TEXT, value_numeric REAL, start_at TEXT, end_at TEXT
    );
    INSERT INTO workouts VALUES (
      'workout_2', 'Apple Watch', '2026-07-16T12:00:00.000Z', '2026-07-16T12:01:00.000Z'
    );
    INSERT INTO health_records VALUES
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningPower', 200, '2026-07-16T12:00:00.000Z', '2026-07-16T12:00:30.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningPower', 200, '2026-07-16T12:00:00.000Z', '2026-07-16T12:00:30.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningPower', 220, '2026-07-16T12:00:30.000Z', '2026-07-16T12:01:00.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningStrideLength', 1.00, '2026-07-16T12:00:00.000Z', '2026-07-16T12:00:30.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningStrideLength', 1.10, '2026-07-16T12:00:30.000Z', '2026-07-16T12:01:00.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningVerticalOscillation', 8.0, '2026-07-16T12:00:00.000Z', '2026-07-16T12:00:30.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningVerticalOscillation', 9.0, '2026-07-16T12:00:30.000Z', '2026-07-16T12:01:00.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningGroundContactTime', 240, '2026-07-16T12:00:00.000Z', '2026-07-16T12:00:30.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningGroundContactTime', 260, '2026-07-16T12:00:30.000Z', '2026-07-16T12:01:00.000Z');
  `);

  try {
    const repository = new SqliteWorkoutReadRepository(database);
    assert.equal(repository.workoutStatistic("workout_2", "HKQuantityTypeIdentifierRunningPower", "average"), 210);
    assert.equal(repository.workoutStatistic("workout_2", "HKQuantityTypeIdentifierRunningStrideLength", "average"), 1.05);
    assert.equal(repository.workoutStatistic("workout_2", "HKQuantityTypeIdentifierRunningVerticalOscillation", "average"), 8.5);
    assert.equal(repository.workoutStatistic("workout_2", "HKQuantityTypeIdentifierRunningGroundContactTime", "average"), 250);
  } finally {
    database.close();
  }
});
