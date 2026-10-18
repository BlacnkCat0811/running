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
    // 路线点现在只能通过 `readable_route_points` 视图读（O11 / WP-50）。这条用例刻意手搓
    // 最小 schema，所以视图也在这里就地建一份 —— **形态必须与 `v43-migration.ts` 一致**
    // （列名、两条分支、`file_status = 'imported' AND point_count > 0` 的判据）。
    // 真视图的判据与语义由 `route-point-reader.test.ts` 用真迁移出来的库钉住；
    // 这里钉的是"仓储层怎么排序、怎么拼接多行路线的点、怎么采样"。
    db.exec(`CREATE TABLE workout_routes(id TEXT, workout_id TEXT, start_at TEXT,
        point_count INTEGER, file_status TEXT, published_route_version_id TEXT);
      CREATE TABLE route_version_points(route_version_id TEXT, sequence INTEGER, latitude REAL,
        longitude REAL, elevation_meters REAL, speed_mps REAL, timestamp TEXT);
      CREATE TABLE route_points(route_id TEXT, sequence INTEGER, latitude REAL, longitude REAL,
        elevation_meters REAL, speed_mps REAL, timestamp TEXT);
      CREATE VIEW readable_route_points AS
        SELECT route.id AS route_id, point.sequence AS sequence, point.timestamp AS timestamp,
               point.latitude AS latitude, point.longitude AS longitude,
               point.elevation_meters AS elevation_meters, point.speed_mps AS speed_mps
          FROM workout_routes route
          JOIN route_version_points point ON point.route_version_id = route.published_route_version_id
         WHERE route.file_status = 'imported' AND route.point_count > 0
        UNION ALL
        SELECT point.route_id AS route_id, point.sequence AS sequence, point.timestamp AS timestamp,
               point.latitude AS latitude, point.longitude AS longitude,
               point.elevation_meters AS elevation_meters, point.speed_mps AS speed_mps
          FROM route_points point
          JOIN workout_routes route ON route.id = point.route_id
         WHERE route.published_route_version_id IS NULL
           AND route.file_status = 'imported' AND route.point_count > 0;
      INSERT INTO workout_routes VALUES ('z','w','2026-01-01T00:00:00Z',2,'imported',NULL),
        ('a','w','2026-01-01T00:02:00Z',2,'imported',NULL);
      INSERT INTO route_points VALUES
      ('z',0,1,1,10,3,'2026-01-01T00:00:00Z'),('z',1,2,2,11,3,'2026-01-01T00:01:00Z'),
      ('a',0,3,3,12,3,'2026-01-01T00:02:00Z'),('a',1,4,4,13,3,'2026-01-01T00:03:00Z');
      CREATE TABLE training_sessions(id TEXT, canonical_workout_id TEXT, anchor_start_at TEXT);
      INSERT INTO training_sessions VALUES ('s','w','2026-01-01T00:00:00Z');`);
    const repo = new SqliteSeriesReadRepository(db);
    assert.deepEqual(repo.routePoints("w").map((point) => point.latitude), [1, 2, 3, 4]);
    assert.deepEqual(repo.routeElevationSeries("s").points.map((point) => point.offsetSeconds), [0, 60, 120, 180]);
    // 状态说"没导入"的行**一个点都不给** —— 改造前这两条路一个字都不判，于是
    // "详情页有轨迹、地图页没有"这类差异没有归因。
    db.exec("UPDATE workout_routes SET file_status = 'pending' WHERE id = 'a'");
    assert.deepEqual(repo.routePoints("w").map((point) => point.latitude), [1, 2]);
    // 采样步长必须是**整数**除法：`node:sqlite` 把绑定的数字当 REAL，步长退化成 3.xxx 时
    // 只会在第 1 条上命中取模（实测），于是"每 N 条留一条"变成"只留首尾两条"。
    // 这里 1200 个点、上界 500 ⇒ 步长 3，采样应落在 0、3、6…（末条恒保留）。
    db.exec("INSERT INTO workout_routes VALUES ('n','w2','2026-01-02T00:00:00Z',1200,'imported',NULL)");
    const insert = db.prepare("INSERT INTO route_points VALUES ('n', ?, ?, 1, 10, 3, '2026-01-02T00:00:00Z')");
    for (let sequence = 0; sequence < 1200; sequence += 1) insert.run(sequence, sequence);
    const sampled = repo.routePoints("w2");
    assert.deepEqual(sampled.slice(0, 4).map((point) => point.latitude), [0, 3, 6, 9],
      "步长被绑成实数时这里只会剩首尾两条（实测 2 条），所以它同时是那处陷阱的守卫");
    assert.equal(sampled.at(-1)?.latitude, 1199, "末条必须保留（终点语义）");
  } finally { db.close(); }
});

test("metricIntervals keeps overlap semantics while seeking bounded windows", () => {
  const database = new DatabaseSync(":memory:");
  const workoutStart = "2026-09-01T00:00:00.000Z";
  const workoutEnd = "2026-09-01T00:10:00.000Z";
  try {
    database.exec(`
      CREATE TABLE health_records (type TEXT, source_name TEXT, start_at TEXT, end_at TEXT, value_numeric REAL, unit TEXT);
      CREATE INDEX idx_health_records_source_time ON health_records(source_name, start_at, end_at);
      CREATE INDEX idx_health_records_type_end ON health_records(type, end_at, start_at);
      INSERT INTO health_records VALUES
        ('heartRate','Watch','2026-09-01T00:01:00.000Z','2026-09-01T00:02:00.000Z',120,'bpm'),
        ('heartRate','Watch','2026-09-01T00:00:30.000Z','2026-09-01T00:00:45.000Z',110,'bpm'),
        ('heartRate','Watch','2026-09-01T00:00:30.000Z','2026-09-01T00:00:45.000Z',110,'bpm'),
        ('heartRate','Watch','2026-08-31T23:50:00.000Z','2026-09-01T00:03:00.000Z',150,'bpm'),
        ('heartRate','Watch','2026-08-31T23:00:00.000Z','2026-08-31T23:30:00.000Z',90,'bpm'),
        ('heartRate','Watch','2026-09-01T00:10:00.000Z','2026-09-01T00:11:00.000Z',130,'bpm'),
        ('heartRate','Watch','2026-08-31T19:05:00-05:00','2026-08-31T19:06:00-05:00',200,'bpm'),
        ('heartRate','Watch','2026-08-31T23:59:30.000Z','2026-09-01T00:00:30.000Z',160,'bpm'),
        ('heartRate','Watch','2026-08-31T23:40:00.000Z','2026-09-01T00:20:00.000Z',170,'bpm');
    `);
    const intervals = new SqliteSeriesReadRepository(database).metricIntervals(
      "heartRate", "Watch", workoutStart, workoutEnd
    );
    assert.deepEqual(intervals.map((interval) => interval.value).sort((a, b) => a - b),
      [110, 120, 150, 160, 170, 200], "in-window, crossing and offset-formatted rows are kept exactly once");
    const byValue = (value: number) => intervals.find((interval) => interval.value === value)!;
    assert.deepEqual([byValue(150).startMs, byValue(150).endMs],
      [Date.parse(workoutStart), Date.parse("2026-09-01T00:03:00.000Z")],
      "a long record crossing the workout start is clipped to the window");
    assert.deepEqual([byValue(160).startMs, byValue(160).endMs],
      [Date.parse(workoutStart), Date.parse("2026-09-01T00:00:30.000Z")]);
    assert.deepEqual([byValue(170).startMs, byValue(170).endMs],
      [Date.parse(workoutStart), Date.parse(workoutEnd)],
      "a record ending after the workout is clamped to the workout end");
    assert.deepEqual([byValue(200).startMs, byValue(200).endMs],
      [Date.parse("2026-09-01T00:05:00.000Z"), Date.parse("2026-09-01T00:06:00.000Z")],
      "offset-formatted timestamps keep their absolute instant instead of their text order");
    assert.ok(!intervals.some((interval) => interval.value === 90),
      "a record that ends before the workout start is not part of the overlap branch");
    assert.ok(!intervals.some((interval) => interval.value === 130),
      "a record starting exactly at the workout end is outside the half-open window");
  } finally { database.close(); }
});
