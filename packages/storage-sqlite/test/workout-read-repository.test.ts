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
      id TEXT, source_name TEXT, start_at TEXT, end_at TEXT, deleted_at TEXT
    );
    CREATE TABLE health_records (
      source_name TEXT, type TEXT, value_numeric REAL, start_at TEXT, end_at TEXT
    );
    INSERT INTO workouts VALUES (
      'workout_1', 'RQ Run', '2026-07-16T12:00:00.000Z', '2026-07-16T12:01:00.000Z', NULL
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
      id TEXT, source_name TEXT, start_at TEXT, end_at TEXT, deleted_at TEXT
    );
    CREATE TABLE health_records (
      source_name TEXT, type TEXT, value_numeric REAL, start_at TEXT, end_at TEXT
    );
    INSERT INTO workouts VALUES (
      'workout_2', 'Apple Watch', '2026-07-16T12:00:00.000Z', '2026-07-16T12:01:00.000Z', NULL
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

test("raw running-dynamics average clips a record that overlaps the workout start", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE workout_statistics (
      workout_id TEXT, type TEXT, ordinal INTEGER, sum_value REAL, average_value REAL
    );
    CREATE TABLE workouts (
      id TEXT, source_name TEXT, start_at TEXT, end_at TEXT, deleted_at TEXT
    );
    CREATE TABLE health_records (
      source_name TEXT, type TEXT, value_numeric REAL, start_at TEXT, end_at TEXT
    );
    INSERT INTO workouts VALUES (
      'workout_overlap', 'Apple Watch', '2026-07-16T12:00:00.000Z', '2026-07-16T12:02:00.000Z', NULL
    );
    INSERT INTO health_records VALUES
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningPower', 100, '2026-07-16T11:59:30.000Z', '2026-07-16T12:00:30.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningPower', 200, '2026-07-16T12:00:30.000Z', '2026-07-16T12:01:30.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningPower', 300, '2026-07-16T11:58:00.000Z', '2026-07-16T11:58:30.000Z'),
      ('Apple Watch', 'HKQuantityTypeIdentifierRunningPower', 400, '2026-07-16T12:02:00.000Z', '2026-07-16T12:02:30.000Z');
  `);

  try {
    const average = new SqliteWorkoutReadRepository(database)
      .workoutStatistic("workout_overlap", "HKQuantityTypeIdentifierRunningPower", "average");
    assert.ok(average !== null && Math.abs(average - 500 / 3) < 1e-9,
      "the crossing record contributes its clipped 30 s, while wholly-before/after records are excluded");
  } finally {
    database.close();
  }
});

// 2026-10-18（复查 P2）：cadence 的原始 step 回退读此前只有 `end_at` 下界（老 workout 随时间
// 轴增长扫描历史）。现在走有界计划（按该 type 最长记录时长收紧候选起点）。本测试用
// "24h 跨起点长记录 + 偏移格式 + 窗口外记录"钉住：结果按重叠比例计入长记录，且旧窗口与
// 新窗口的行为一致。
test("average cadence fallback counts a long record crossing the workout start proportionally", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE workout_statistics (
      workout_id TEXT, type TEXT, ordinal INTEGER, sum_value REAL, average_value REAL
    );
    CREATE TABLE workouts (
      id TEXT, source_name TEXT, start_at TEXT, end_at TEXT, deleted_at TEXT
    );
    CREATE TABLE health_records (
      source_name TEXT, type TEXT, value_numeric REAL, start_at TEXT, end_at TEXT
    );
    CREATE INDEX idx_health_records_type_time ON health_records(type, start_at, end_at);
    CREATE INDEX idx_health_records_source_time ON health_records(source_name, start_at, end_at);
    CREATE INDEX idx_health_records_type_end ON health_records(type, end_at, start_at);
    INSERT INTO workouts VALUES (
      'workout_old', 'RQ Run', '2023-01-01T00:00:00.000Z', '2023-01-01T01:00:00.000Z', NULL
    );
    INSERT INTO health_records VALUES
      -- 24h 长记录跨过窗口起点：只有 30 min 在窗口内 ⇒ 86400 × 0.5h/24h = 1800 步。
      ('RQ Run', 'HKQuantityTypeIdentifierStepCount', 86400, '2022-12-31T00:30:00.000Z', '2023-01-01T00:30:00.000Z'),
      -- 窗口内 10 min 的 600 步。
      ('RQ Run', 'HKQuantityTypeIdentifierStepCount', 600, '2023-01-01T00:00:00.000Z', '2023-01-01T00:10:00.000Z'),
      -- 偏移格式（-05:00 书写，绝对时刻在窗口内，但写下的本地日期是 12-31）：历史谓词是
      -- 文本比较：end_at > 窗口起点文本 不成立 ⇒ 与改造前一致地被排除（不是有界计划引入的）。
      ('RQ Run', 'HKQuantityTypeIdentifierStepCount', 300, '2022-12-31T19:20:00-05:00', '2022-12-31T19:50:00-05:00'),
      -- 完全在窗口外。
      ('RQ Run', 'HKQuantityTypeIdentifierStepCount', 999, '2022-12-30T00:00:00.000Z', '2022-12-30T01:00:00.000Z');
  `);
  try {
    // (1800 + 600) 步 / 60 min = 40 步/分钟：偏移行按历史文本语义不计入（见上）。
    assert.equal(new SqliteWorkoutReadRepository(database).averageCadence("workout_old", 3600), 40);
  } finally {
    database.close();
  }
});
