import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { SqlitePredictionRecoveryReadRepository } from "../src/index.js";

const asOf = "2026-01-31T00:00:00.000Z";

function healthRecords(database: DatabaseSync, withCompletion = true): void {
  database.exec(`
    CREATE TABLE health_records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value_numeric REAL,
      start_at TEXT NOT NULL
      ${withCompletion ? ", end_at TEXT NOT NULL" : ""}
    );
  `);
}

function insertHealth(
  database: DatabaseSync,
  id: string,
  type: string,
  value: number,
  startAt: string,
  endAt = startAt
): void {
  const hasEndAt = (database.prepare("PRAGMA table_info(health_records)").all() as unknown as Array<{ name: string }>)
    .some((column) => column.name === "end_at");
  database.prepare(hasEndAt
    ? "INSERT INTO health_records (id, type, value_numeric, start_at, end_at) VALUES (?, ?, ?, ?, ?)"
    : "INSERT INTO health_records (id, type, value_numeric, start_at) VALUES (?, ?, ?, ?)"
  ).run(...(hasEndAt ? [id, type, value, startAt, endAt] : [id, type, value, startAt]));
}

function canonicalTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE canonical_nights (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      timezone_identifier TEXT NOT NULL,
      wake_at TEXT,
      asleep_union_minutes REAL
    );
    CREATE TABLE canonical_hrv_days (
      id TEXT PRIMARY KEY,
      timezone_identifier TEXT NOT NULL,
      hrv_sdnn_ms REAL,
      confidence TEXT NOT NULL,
      window_end_at TEXT
    );
  `);
}

test("uses canonical HRV, applies sleep freshness, and excludes future completions", () => {
  const database = new DatabaseSync(":memory:");
  try {
    healthRecords(database);
    canonicalTables(database);
    insertHealth(database, "raw-recent", "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", 20, "2026-01-29T00:00:00Z");
    insertHealth(database, "raw-base", "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", 100, "2026-01-15T00:00:00Z");
    insertHealth(database, "raw-future-completion", "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", 900, "2026-01-29T00:00:00Z", "2026-02-01T00:00:00Z");
    database.prepare("INSERT INTO canonical_hrv_days VALUES (?, ?, ?, ?, ?)").run("hrv-recent", "UTC", 60, "confident", "2026-01-29T01:00:00Z");
    database.prepare("INSERT INTO canonical_hrv_days VALUES (?, ?, ?, ?, ?)").run("hrv-base", "UTC", 50, "confident", "2026-01-15T01:00:00Z");
    database.prepare("INSERT INTO canonical_hrv_days VALUES (?, ?, ?, ?, ?)").run("hrv-future", "UTC", 999, "confident", "2026-02-01T00:00:00Z");
    database.prepare("INSERT INTO canonical_hrv_days VALUES (?, ?, ?, ?, ?)").run("hrv-other-zone", "Asia/Shanghai", 777, "confident", "2026-01-29T01:00:00Z");
    database.prepare("INSERT INTO canonical_nights VALUES (?, 'main', ?, ?, ?)").run("night-stale", "UTC", "2026-01-10T00:00:00Z", 600);
    database.prepare("INSERT INTO canonical_nights VALUES (?, 'main', ?, ?, ?)").run("night-future", "UTC", "2026-02-01T00:00:00Z", 600);
    const readings = new SqlitePredictionRecoveryReadRepository(database).load(asOf, "UTC");
    assert.equal(readings.recentHrv, 60);
    assert.equal(readings.baselineHrv, 50);
    assert.equal(readings.latestSleepMinutes, null);
    assert.equal(readings.baselineSleepMinutes, 600);
  } finally {
    database.close();
  }
});

test("uses raw HRV only for legacy databases without canonical HRV facts", () => {
  const database = new DatabaseSync(":memory:");
  try {
    healthRecords(database);
    insertHealth(database, "raw-recent", "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", 60, "2026-01-29T00:00:00Z");
    insertHealth(database, "raw-base", "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", 50, "2026-01-15T00:00:00Z");
    insertHealth(database, "raw-future-completion", "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", 900, "2026-01-29T00:00:00Z", "2026-02-01T00:00:00Z");
    const readings = new SqlitePredictionRecoveryReadRepository(database).load(asOf, "UTC");
    assert.equal(readings.recentHrv, 60);
    assert.equal(readings.baselineHrv, 50);
    assert.equal(readings.latestSleepMinutes, null);
  } finally {
    database.close();
  }
});

test("marks raw resting heart rate as raw compatibility provenance", () => {
  const database = new DatabaseSync(":memory:");
  try {
    healthRecords(database);
    insertHealth(database, "rhr-recent", "HKQuantityTypeIdentifierRestingHeartRate", 58, "2026-01-29T00:00:00Z");
    insertHealth(database, "rhr-base", "HKQuantityTypeIdentifierRestingHeartRate", 52, "2026-01-15T00:00:00Z");
    const readings = new SqlitePredictionRecoveryReadRepository(database).load(asOf, "UTC");
    assert.equal(readings.recentRestingHeartRate, 58);
    assert.equal(readings.baselineRestingHeartRate, 52);
    assert.deepEqual(readings.provenance, {
      hrvSource: "none",
      sleepSource: "none",
      source: "raw_compat",
      coverage: "partial",
      latestObservedAt: "2026-01-29T00:00:00Z"
    });
  } finally {
    database.close();
  }
});

test("does not fall back to raw HRV when canonical facts exist but are empty", () => {
  const database = new DatabaseSync(":memory:");
  try {
    healthRecords(database, false);
    canonicalTables(database);
    insertHealth(database, "raw-recent", "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", 60, "2026-01-29T00:00:00Z");
    const readings = new SqlitePredictionRecoveryReadRepository(database).load(asOf, "UTC");
    assert.equal(readings.recentHrv, null);
    assert.equal(readings.baselineHrv, null);
  } finally {
    database.close();
  }
});

test("propagates malformed canonical queries", () => {
  const database = new DatabaseSync(":memory:");
  try {
    healthRecords(database, false);
    database.exec("CREATE TABLE canonical_hrv_days (id TEXT PRIMARY KEY, timezone_identifier TEXT NOT NULL)");
    assert.throws(
      () => new SqlitePredictionRecoveryReadRepository(database).load(asOf, "UTC"),
      /no such column: hrv_sdnn_ms/
    );
  } finally {
    database.close();
  }
});
