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
