import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteSeriesReadRepository } from "../src/read/series-read-repository.js";

test("downsampled series retains a peak between regular sample positions", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE health_records (type TEXT, source_name TEXT, start_at TEXT, end_at TEXT, value_numeric REAL, unit TEXT)");
    const insert = database.prepare("INSERT INTO health_records VALUES ('heartRate', 'Watch', ?, ?, ?, 'bpm')");
    const start = Date.parse("2026-09-01T00:00:00Z");
    for (let i = 0; i < 1200; i++) {
      const timestamp = new Date(start + i * 1000).toISOString();
      insert.run(timestamp, timestamp, i === 502 ? 191 : 140);
    }
    const series = new SqliteSeriesReadRepository(database).metricSeries("heartRate", "bpm", new Date(start).toISOString(), new Date(start + 1200000).toISOString(), "Watch");
    assert.equal(series.totalSamples, 1200);
    assert.equal(Math.max(...series.points.map(p => p.value)), 191);
    assert.equal(series.points[0]?.offsetSeconds, 0);
    assert.equal(series.points.at(-1)?.offsetSeconds, 1199);
    assert.ok(series.points.length <= 601);
  } finally { database.close(); }
});

test("routes with independent sequence counters are read in chronological order", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE workout_routes(id TEXT, workout_id TEXT, start_at TEXT);
      CREATE TABLE route_points(route_id TEXT, sequence INTEGER, latitude REAL, longitude REAL, elevation_meters REAL, speed_mps REAL, timestamp TEXT);
      INSERT INTO workout_routes VALUES ('z','w','2026-01-01T00:00:00Z'),('a','w','2026-01-01T00:02:00Z');
      INSERT INTO route_points VALUES
      ('z',0,1,1,10,3,'2026-01-01T00:00:00Z'),('z',1,2,2,11,3,'2026-01-01T00:01:00Z'),
      ('a',0,3,3,12,3,'2026-01-01T00:02:00Z'),('a',1,4,4,13,3,'2026-01-01T00:03:00Z');
      CREATE TABLE training_sessions(id TEXT, canonical_workout_id TEXT, anchor_start_at TEXT);
      INSERT INTO training_sessions VALUES ('s','w','2026-01-01T00:00:00Z');`);
    const repo = new SqliteSeriesReadRepository(db);
    assert.deepEqual(repo.routePoints("w").map((point) => point.latitude), [1, 2, 3, 4]);
    assert.deepEqual(repo.routeElevationSeries("s").points.map((point) => point.offsetSeconds), [0, 60, 120, 180]);
  } finally { db.close(); }
});
