// O11 读端统一 + `route_points` 双写退役（`docs/IOS_SYNC_PERFORMANCE_REVIEW.md` §O11，WP-50）。
//
// 这个文件要证四件事，每一件都有对应的**突变靶子**：
//
// 1. **判据只有一处**。「这条路线此刻可读吗」= `usableRouteConditionSql()`
//    （`file_status = 'imported' AND point_count > 0`），取数关系 = v43 的
//    `readable_route_points` 视图。视图 SQL 里那句判据是**字面副本**（迁移冻结之后
//    不能再引用会变的东西），所以必须有结构判据把两者钉住 —— 否则"改了一边"会表现为
//    某个读端静默读空，而不是某条测试变红。
// 2. **老库读得到**。指针为 NULL 的路线（v35 之前的库、`replaceRoutePoints()` 直接落的行）
//    继续从 `route_points` 读；退役双写 ≠ 删表。视图把两条分支按指针切开，
//    既不让老库读空，也不让一条路线的点同时从两处来。
// 3. **写放大真的没了**。一次发布只写一份点：搬行（`UPDATE` 主键列）+ 排空旧副本，
//    不再 `INSERT…SELECT` 到 `route_points`。这条要用"每个路线的点行数"和
//    "发布触发的行改动数"两个可观测量来钉，而不是靠读代码。
// 4. **在两种判据下都可读的路线，数值逐位不变**。这里保留改造前那三条 SQL 作为
//    **差分对照**（oracle），把"新读者 == 旧读者"写成断言；只在新判据下不可读的路线
//    则明确记录"新读者读空"——那是这次统一**有意**改变的部分（`loadRouteQuality` /
//    `loadElevationGain` 的不对称就是它造成的）。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalWorkout, RoutePoint } from "@rai/contracts";
import { RaiDatabase } from "../src/database.js";
import { SqliteRoutePointReader } from "../src/read/route-point-reader.js";
import { usableRouteConditionSql } from "../src/sql/fragments.js";

const START = "2026-01-01T00:00:00.000Z";

function point(sequence: number, latitude: number, elevationMeters: number | null = 5): RoutePoint {
  return {
    sequence, timestamp: START, latitude, longitude: 121.1, elevationMeters,
    speedMetersPerSecond: 2.5, courseDegrees: null,
    horizontalAccuracyMeters: 4, verticalAccuracyMeters: null
  };
}

function workout(id: string, routeId: string, startAt = START): CanonicalWorkout {
  return {
    id, activityType: "HKWorkoutActivityTypeRunning", sourceName: "Watch", sourceVersion: "1",
    device: null, startAt, endAt: "2026-01-01T00:30:00.000Z", createdAt: null,
    durationSeconds: 1800, indoor: false, metadata: {}, statistics: [], events: [],
    routes: [{
      id: routeId, sourceName: "Watch", sourceVersion: "1", startAt,
      endAt: "2026-01-01T00:30:00.000Z", createdAt: null,
      relativePath: `workout-routes/${routeId}.gpx`, metadata: {}
    }]
  };
}

async function withStore(run: (store: RaiDatabase) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "rai-route-point-reader-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try { await run(store); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

/** 走生产发布路径把这个路线的轨迹发布成 `complete` 版本。 */
function publish(store: RaiDatabase, routeId: string, points: readonly RoutePoint[], hash: string): string {
  const staging = store.beginRouteVersion(routeId);
  store.appendRouteVersionPoints(staging, points);
  store.publishRouteVersion(staging, hash, points.length);
  return (store.database.prepare(
    "SELECT published_route_version_id AS id FROM workout_routes WHERE id = ?"
  ).get(routeId) as { id: string }).id;
}

function count(store: RaiDatabase, sql: string): number {
  return Number((store.database.prepare(sql).get() as { n: number }).n);
}

/**
 * 改造前 `publishRouteVersion` 的**双写**：把 published 版本的点再拷一份进 `route_points`。
 *
 * 这是差分对照用的 `oracle`（不是生产代码）：只有把"旧世界的 `route_points`"重建出来，
 * "视图内容 == 改造前 `route_points` 内容"才是一句可执行的断言，而不是一句声称。
 */
function materializeLegacyDoubleWrite(store: RaiDatabase, routeId: string): void {
  store.database.prepare(`
    INSERT INTO route_points (
      route_id, sequence, timestamp, latitude, longitude, elevation_meters,
      speed_mps, course_degrees, horizontal_accuracy_meters, vertical_accuracy_meters)
    SELECT route.id, point.sequence, point.timestamp, point.latitude, point.longitude,
      point.elevation_meters, point.speed_mps, point.course_degrees,
      point.horizontal_accuracy_meters, point.vertical_accuracy_meters
    FROM workout_routes route
    JOIN route_version_points point ON point.route_version_id = route.published_route_version_id
    WHERE route.id = ?
  `).run(routeId);
}

// ---------------------------------------------------------------------------
// 改造前的三条 SQL（差分对照）。逐字来自改造前的实现，**不要**跟着新代码一起改：
// 它们的作用就是"旧读数"，改了就不再是照妖镜。
// ---------------------------------------------------------------------------

function legacySampledPoints(database: RaiDatabase["database"], workoutId: string): unknown[] {
  return database.prepare(`
    WITH numbered AS (
      SELECT rp.latitude, rp.longitude, rp.elevation_meters, rp.speed_mps, rp.timestamp,
        ROW_NUMBER() OVER (ORDER BY COALESCE(wr.start_at, rp.timestamp), wr.id, rp.sequence) AS sample_number,
        COUNT(*) OVER () AS total_samples
      FROM workout_routes wr
      JOIN route_points rp ON rp.route_id = wr.id
      WHERE wr.workout_id = ?
    )
    SELECT latitude, longitude, elevation_meters, speed_mps, timestamp
    FROM numbered
    WHERE (sample_number - 1) % MAX(1, (total_samples + 499) / 500) = 0 OR sample_number = total_samples
    ORDER BY sample_number
  `).all(workoutId) as unknown[];
}

function legacyElevationGain(database: RaiDatabase["database"], workoutId: string): number | null {
  const rows = database.prepare(`
    SELECT rp.elevation_meters AS elevation
    FROM workout_routes wr JOIN route_points rp ON rp.route_id = wr.id
    WHERE wr.workout_id = ? AND rp.elevation_meters IS NOT NULL
    ORDER BY rp.sequence
  `).all(workoutId) as Array<{ elevation: number }>;
  if (rows.length < 2) return null;
  let gain = 0;
  let previous = Number(rows[0]!.elevation);
  for (const row of rows.slice(1)) {
    const delta = Number(row.elevation) - previous;
    if (Number.isFinite(delta) && delta > 0 && delta < 30) gain += delta;
    previous = Number(row.elevation);
  }
  return gain;
}

function legacyRouteQuality(database: RaiDatabase["database"], workoutId: string): { pointCount: number; averageHorizontalAccuracy: number | null } {
  const row = database.prepare(`
    SELECT COUNT(point.sequence) AS pointCount, AVG(point.horizontal_accuracy_meters) AS averageHorizontalAccuracy
    FROM workout_routes route
    LEFT JOIN route_points point ON point.route_id = route.id
    WHERE route.workout_id = ? AND route.file_status = 'imported'
  `).get(workoutId) as { pointCount: number; averageHorizontalAccuracy: number | null };
  return { pointCount: Number(row.pointCount), averageHorizontalAccuracy: row.averageHorizontalAccuracy };
}

/** 按 `importEquivalence` 的口径对一张表（或视图）求摘要：先主键、再其余列，逐行 JSON。 */
function domainDigest(database: RaiDatabase["database"], table: string): { rows: number; sha256: string } {
  const info = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; pk: number }>;
  const columns = info.map((row) => row.name);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const orderBy = [
    ...info.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk).map((row) => row.name),
    ...columns
  ].map(quote).join(",");
  const hash = createHash("sha256");
  let rows = 0;
  for (const row of database.prepare(
    `SELECT ${columns.map(quote).join(",")} FROM "${table}" ORDER BY ${orderBy}`
  ).iterate()) {
    hash.update(JSON.stringify(row)); hash.update("\n"); rows += 1;
  }
  return { rows, sha256: hash.digest("hex") };
}

// ---------------------------------------------------------------------------
// 1. 结构判据：判据只有一处
// ---------------------------------------------------------------------------

test("O11 结构判据：可读判据在视图里逐字复制自 `usableRouteConditionSql()`，改一边就红", async () => {
  await withStore((store) => {
    const viewSql = (store.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'readable_route_points'"
    ).get() as { sql: string } | undefined)?.sql;
    assert.ok(viewSql, "v43 必须建出 `readable_route_points` 视图（唯一的路线点读取关系）");

    // 🔴 这一条就是"判据不可能分叉"的机械保证：视图里的判据是**字面副本**
    //（迁移冻结后不能引用会变的字符串），所以由测试逐字比对。
    // 忘了同步 ⇒ 这里红，而不是某个读端静默读空。
    //
    // ⚠️ 必须是**两条分支各一份**（`split().length - 1 === 2`）：只判 `includes` 会被
    // 实测骗过去 —— 从分支①里删掉 `point_count > 0` 时，分支②还留着那一整句，
    // `includes` 依然为真，而"已发布 + `point_count = 0`"的路线就重新读得出来了。
    const predicateOccurrences = viewSql.split(usableRouteConditionSql("route")).length - 1;
    assert.equal(predicateOccurrences, 2,
      `两条分支各要用一次 \`${usableRouteConditionSql("route")}\`（实际 ${predicateOccurrences} 处）；` +
      `视图定义：\n${viewSql}`);

    // 两条分支必须都在：指针非空 → 版本表；指针为 NULL → 旧表。
    assert.ok(viewSql.includes("route_version_points"), "指针非空的那条分支必须读版本表");
    assert.ok(viewSql.includes("FROM route_points point"), "指针为 NULL 的那条分支必须读 `route_points`（老库不许读空）");
    assert.match(viewSql, /published_route_version_id IS NULL/,
      "两条分支必须按**指针**切开；否则同一条路线的点会从两处冒出来（双写期的形态）");

    // `route_points` 必须仍然是**表**：它是 legacy 路线的落脚点，退役 = 不再写，不是删表。
    assert.equal((store.database.prepare(
      "SELECT type FROM sqlite_master WHERE name = 'route_points'"
    ).get() as { type: string }).type, "table");
  });
});

// ---------------------------------------------------------------------------
// 2. 两条分支互斥；老库读得到、已发布路线读版本内容
// ---------------------------------------------------------------------------

test("O11：视图按指针二选一 —— 老库读 `route_points`，已发布读版本内容，副本读不出来", async () => {
  await withStore((store) => {
    store.insertWorkout(workout("w-published", "r-published"), "apple_watch", {});
    store.insertWorkout(workout("w-legacy", "r-legacy"), "apple_watch", {});
    const reader = new SqliteRoutePointReader(store.database);

    // 老库形态：指针为 NULL，点只在 `route_points` 里。
    store.replaceRoutePoints("r-legacy", [point(0, 31.1), point(1, 31.2)]);
    assert.deepEqual(reader.pointsForWorkout("w-legacy")?.map((item) => item.latitude), [31.1, 31.2],
      "指针为 NULL 的路线必须仍然读得到（v35 之前的库全靠这一条）");

    // 已发布形态：点搬进版本表；旧表里即使有副本也不可见。
    publish(store, "r-published", [point(0, 40.1), point(1, 40.2)], "hash-published");
    store.replaceRoutePoints("r-published", [point(0, 77.7), point(1, 77.8)]);
    assert.deepEqual(reader.pointsForWorkout("w-published")?.map((item) => item.latitude), [40.1, 40.2],
      "已发布路线的点只从 published 版本读：旧表里的副本（77.x）不得出现在任何读端");

    // 一条路线的点**不可能**同时从两处来：视图的两条分支由指针切开。
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM readable_route_points"), 4,
      "两条用例各有 2 个可读点：视图不得把已发布路线在旧表里的副本也算进来");
  });
});

test("O11：状态不可读的路线一个点都不给（改造前 `routePoints`/`elevationGain` 一个字都不判）", async () => {
  await withStore((store) => {
    store.insertWorkout(workout("w-pending", "r-pending"), "apple_watch", {});
    store.replaceRoutePoints("r-pending", [point(0, 31.1), point(1, 31.2)]);
    store.insertWorkout(workout("w-empty", "r-empty"), "apple_watch", {});
    store.replaceRoutePoints("r-empty", [point(0, 32.1), point(1, 32.2)]);
    // 已发布但状态不可读的两条：判据必须**两条分支都判**，不能只判老库那条。
    store.insertWorkout(workout("w-published-pending", "r-published-pending"), "apple_watch", {});
    publish(store, "r-published-pending", [point(0, 34.1), point(1, 34.2)], "hash-pending");
    store.insertWorkout(workout("w-published-empty", "r-published-empty"), "apple_watch", {});
    publish(store, "r-published-empty", [point(0, 35.1), point(1, 35.2)], "hash-empty");
    const reader = new SqliteRoutePointReader(store.database);

    // 制造"状态说没导入、点却还在"的自相矛盾行（公开 API 造不出来，只能直接写库）。
    store.database.prepare(
      "UPDATE workout_routes SET file_status = 'pending' WHERE id = 'r-pending'"
    ).run();
    store.database.prepare(
      "UPDATE workout_routes SET point_count = 0 WHERE id = 'r-empty'"
    ).run();
    store.database.prepare(
      "UPDATE workout_routes SET file_status = 'pending' WHERE id = 'r-published-pending'"
    ).run();
    store.database.prepare(
      "UPDATE workout_routes SET point_count = 0 WHERE id = 'r-published-empty'"
    ).run();

    assert.equal(reader.pointsForWorkout("w-pending"), null,
      "`file_status != 'imported'` ⇒ 读空（判据与写侧 `hasUsableRoute()` 同源）");
    assert.equal(reader.pointsForWorkout("w-empty"), null, "`point_count = 0` ⇒ 读空");
    assert.equal(reader.pointsForWorkout("w-published-pending"), null,
      "🔴 **已发布**路线同样要判状态：版本表那条分支漏判就会在这里读出一条本该不可读的轨迹");
    assert.equal(reader.pointsForWorkout("w-published-empty"), null,
      "🔴 已发布路线同样要判 `point_count > 0`：只有老库那条分支判是不够的");
    assert.deepEqual(reader.sampledPointsForWorkout("w-pending"), []);
    assert.equal(reader.elevationGain("w-pending"), null,
      "高程增益也必须读空：判据不对称（这里给高程、那里不给点）正是本工作包要修的那处缺陷");
    assert.deepEqual(reader.routeQualityForWorkout("w-pending"), { pointCount: 0, averageHorizontalAccuracy: null },
      "路线质量保留 LEFT JOIN 的形态：没有可读点时给 0/null 行，而不是让训练整条消失");
  });
});

// ---------------------------------------------------------------------------
// 3. 发布之后的形态：一份点、旧副本排空、其他路线不动
// ---------------------------------------------------------------------------

test("O11：发布只搬行 —— 旧表排空、暂存行消失、稳态下每条路线只有一份点", async () => {
  await withStore((store) => {
    store.insertWorkout(workout("w-a", "r-a"), "apple_watch", {});
    store.insertWorkout(workout("w-b", "r-b"), "apple_watch", {});
    // 另一条老路线的点：转换一条路线**不得**碰它（"单条路线更新无需全库迁移"）。
    store.replaceRoutePoints("r-b", [point(0, 51.1), point(1, 51.2)]);
    store.replaceRoutePoints("r-a", [point(0, 31.1), point(1, 31.2)]);

    const publishedId = publish(store, "r-a", [point(0, 40.1, 10), point(1, 40.2, 12), point(2, 40.3, 13)], "hash-a");

    assert.equal(count(store, "SELECT COUNT(*) AS n FROM route_points WHERE route_id = 'r-a'"), 0,
      "🔴 双写已退役：已发布路线在旧表里必须一行都不剩（旧实现会留下 3 行副本）");
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM route_points WHERE route_id = 'r-b'"), 2,
      "转换一条路线不得动到别的老路线：这就是「无需全库迁移」的可执行形态");
    assert.equal(count(store, `SELECT COUNT(*) AS n FROM route_version_points
      WHERE route_version_id = '${publishedId}'`), 3,
      "点只留在 published 版本行下（搬行而不是拷贝）");
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM route_versions WHERE route_id = 'r-a'"), 1,
      "暂存版本行在发布后消失：稳态下每条路线只留一条版本行（版本生命周期不需要额外回收）");
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM readable_route_points WHERE route_id = 'r-a'"), 3,
      "读侧仍然读得到 3 个点：排空的是**副本**，不是轨迹");
  });
});

test("O11：发布失败（点数不足 / 序号断片）⇒ 旧内容仍可读，指针一字不动", async () => {
  await withStore((store) => {
    store.insertWorkout(workout("w-a", "r-a"), "apple_watch", {});
    const publishedId = publish(store, "r-a", [point(0, 40.1), point(1, 40.2)], "hash-1");
    const before = store.database.prepare(
      "SELECT point_count AS pointCount, file_status AS fileStatus, published_route_version_id AS pointer FROM workout_routes WHERE id = 'r-a'"
    ).get();
    const reader = new SqliteRoutePointReader(store.database);

    const partial = store.beginRouteVersion("r-a");
    store.appendRouteVersionPoints(partial, [point(0, 99.9)]);
    assert.throws(() => store.publishRouteVersion(partial, "hash-partial", 2), /incomplete/);

    assert.deepEqual({ ...(store.database.prepare(
      "SELECT point_count AS pointCount, file_status AS fileStatus, published_route_version_id AS pointer FROM workout_routes WHERE id = 'r-a'"
    ).get() as object) }, { ...(before as object) }, "失败不得改动状态与指针");
    assert.deepEqual(reader.pointsForWorkout("w-a")?.map((item) => item.latitude), [40.1, 40.2],
      "失败的发布不得让旧轨迹读空 —— 这正是把发布段包进 SAVEPOINT 的理由");
    assert.equal(count(store, `SELECT COUNT(*) AS n FROM route_version_points
      WHERE route_version_id = '${publishedId}'`), 2, "published 版本的点一个都不能少");
  });
});

// ---------------------------------------------------------------------------
// 4. 逐字节等价 + 差分金标
// ---------------------------------------------------------------------------

test("O11：视图内容 == 改造前「双写之后」的 `route_points`（含等价性摘要逐字节相同）", async () => {
  await withStore((store) => {
    // 🔴 路线 id 是摘要的一部分，所以这里刻意用与实测记录同一份夹具 id
    //（2026-10-16 在**改造前**的实现上跑 `importEquivalence` 得到的值见下）：
    // 换了 id 就只能自比自，钉不住"记录的基线还在"。
    store.insertWorkout(workout("workout-legacy", "route-legacy"), "apple_watch", {});
    store.replaceRoutePoints("route-legacy", [point(0, 31.1, 5), point(1, 31.2, 6), point(2, 31.3, 7)]);
    store.insertWorkout(workout("workout-published", "route-published"), "apple_watch", {});
    publish(store, "route-published", [point(0, 40.1, 9), point(1, 40.2, 10)], "hash-published");
    // 把旧世界的双写重建出来：改造前 `route_points` 里就是这些行。
    materializeLegacyDoubleWrite(store, "route-published");
    store.flush();

    const legacyWorld = domainDigest(store.database, "route_points");
    const canonicalWorld = domainDigest(store.database, "readable_route_points");
    assert.deepEqual(canonicalWorld, legacyWorld,
      "视图给出的多重集必须与改造前 `route_points` 表逐字节相同（importEquivalence 的摘要口径）");
    // 🔴 记录值：2026-10-16 在改造前的实现上实测 `route_points` = 5 行 / 这个 sha256。
    // 它同时证明"记录的等价性基线**没有失效**，只是域名从 `route_points` 换成了
    // `readable_route_points`"（见 `apps/api/src/import-equivalence.ts` 的说明）。
    assert.deepEqual(canonicalWorld, {
      rows: 5,
      sha256: "9f19f624b636e920216a08d6949687d971a829000de1df9413dd97d2ac52c990"
    });
  });
});

test("O11 差分金标：两种判据下都可读的路线，数值逐位不变；只在新判据下不可读的路线读空", async () => {
  await withStore((store) => {
    store.insertWorkout(workout("w-published", "r-published"), "apple_watch", {});
    store.insertWorkout(workout("w-legacy", "r-legacy"), "apple_watch", {});
    store.insertWorkout(workout("w-pending", "r-pending"), "apple_watch", {});
    const reader = new SqliteRoutePointReader(store.database);

    // R1 已发布：点走进版本表；为了让旧读数有东西可读，把双写副本重建出来。
    publish(store, "r-published", [point(0, 40.1, 10), point(1, 40.2, 14), point(2, 40.3, 12)], "hash-pub");
    materializeLegacyDoubleWrite(store, "r-published");
    // R2 老库：指针为 NULL。
    store.replaceRoutePoints("r-legacy", [point(0, 31.1, 100), point(1, 31.2, 130), point(2, 31.3, 120)]);
    // R3 只在旧判据下可读：`file_status = 'pending'` 却有点（旧读者一个字都不判）。
    store.replaceRoutePoints("r-pending", [point(0, 33.1, 200), point(1, 33.2, 260)]);
    store.database.prepare("UPDATE workout_routes SET file_status = 'pending' WHERE id = 'r-pending'").run();
    store.flush();

    const bothReadable = [
      { workoutId: "w-published", where: "已发布路线（指针非空）" },
      { workoutId: "w-legacy", where: "老库路线（指针 NULL）" }
    ];
    for (const item of bothReadable) {
      assert.deepEqual(
        { ...reader.routeQualityForWorkout(item.workoutId) },
        { ...legacyRouteQuality(store.database, item.workoutId) },
        `${item.where}：路线质量的点数与精度均值必须与改造前逐位相同`);
      assert.equal(reader.elevationGain(item.workoutId), legacyElevationGain(store.database, item.workoutId),
        `${item.where}：高程增益必须与改造前逐位相同`);
      assert.deepEqual(
        reader.sampledPointsForWorkout(item.workoutId).map((entry) => entry.latitude),
        legacySampledPoints(store.database, item.workoutId).map((entry) => (entry as { latitude: number }).latitude),
        `${item.where}：采样后的轨迹必须与改造前逐位相同`);
    }

    // 🔴 有意改变的那一半：状态说"没导入"的路线，新读者**读空**，旧读者给数字。
    // 这就是 `loadRouteQuality`（判状态）与 `loadElevationGain`（不判）不对称的收口 ——
    // 不是"顺手改了个行为"，而是"同一行 `workout_routes` 只能有一个结论"。
    assert.ok(legacyElevationGain(store.database, "w-pending") !== null,
      "前置：旧读数在这条路线**确实**给得出高程（否则这条断言是空转）");
    assert.equal(reader.elevationGain("w-pending"), null,
      "统一判据之后：`file_status != 'imported'` 的路线不给高程");
    assert.equal(legacyRouteQuality(store.database, "w-pending").pointCount, 0,
      "前置：路线质量那侧改造前就已经判状态（所以它对这条路线本来就是 0）");
    assert.deepEqual({ ...reader.routeQualityForWorkout("w-pending") },
      { pointCount: 0, averageHorizontalAccuracy: null },
      "两侧现在给出同一个结论");
  });
});

// ---------------------------------------------------------------------------
// 6. 结构判据：生产源码里再没有第二个"直接读旧表"的地方
// ---------------------------------------------------------------------------

test("O11 结构判据：生产读端不得直接读 `route_points`，Rust 侧必须读同一个视图", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { dirname, join, relative, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  const files: string[] = [];
  const walk = (directory: string, accept: (name: string) => boolean): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full, accept);
      else if (accept(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(full);
    }
  };
  const isSource = (name: string) => /\.ts$/.test(name);
  for (const packageDirectory of readdirSync(join(repoRoot, "packages"))) {
    walk(join(repoRoot, "packages", packageDirectory, "src"), isSource);
  }
  walk(join(repoRoot, "apps", "api", "src"), isSource);
  walk(join(repoRoot, "scripts"), (name) => /\.mts$/.test(name));
  walk(join(repoRoot, "crates"), (name) => /\.rs$/.test(name));
  assert.ok(files.length > 100, `扫描面必须覆盖生产源码（实际 ${files.length} 个文件）`);

  // 注释里引用旧表名是**说明**，不是读端；先剥掉注释再扫，免得把解释当成违规。
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // 允许的例外只有三处，且都必须有理由：
  //  - `v43-migration.ts`：视图的 legacy 分支**就是**"读旧表"的那一处定义，是唯一入口本体；
  //  - `migrate-cli.ts`：库还没跑到 v43 时（视图不存在）诊断计数退回旧表 —— 那时旧表就是全部；
  //  - `read/route-point-reader.ts`：唯一入口自己的**降级取数**（连接上没有 v43 视图时，
  //    例如 O06-A 的分析输入快照）。它的判据来自 `usableRouteConditionSql()`，
  //    不是手抄一遍 —— 下面单独有一条断言钉住这件事。
  const allowed = new Set([
    "packages/storage-sqlite/src/v43-migration.ts",
    "packages/storage-sqlite/src/migrate-cli.ts",
    "packages/storage-sqlite/src/read/route-point-reader.ts"
  ]);
  const offenders: string[] = [];
  for (const file of files) {
    const relativePath = relative(repoRoot, file).replaceAll("\\", "/");
    if (allowed.has(relativePath)) continue;
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      // `DELETE FROM route_points` 是**写**（退役之后只剩 legacy 路线与状态清理），不是读。
      if (/DELETE\s+FROM\s+route_points\b/i.test(line)) continue;
      if (/\b(FROM|JOIN)\s+route_points\b/i.test(line)) {
        offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    "生产读端必须走唯一的路线点入口（`readable_route_points` 视图 / `SqliteRoutePointReader`）；" +
    "直接读 `route_points` 在双写退役之后会**读空已发布路线**：\n" + offenders.join("\n"));

  // Rust 侧同源：聚合读的就是这个视图（否则 native 聚合与 TS 回落会给出不同的高程）。
  const rust = readFileSync(join(repoRoot, "crates/rai-data-worker/src/main.rs"), "utf8");
  assert.match(rust, /JOIN readable_route_points\b/,
    "Rust 的 `aggregate()` 必须读 `readable_route_points`：读旧表会让已发布路线的增益静默消失");
  assert.ok(!/JOIN\s+route_points\b/.test(stripComments(rust)), "Rust 侧不得再直接 JOIN 旧表");

  // 唯一入口的**降级取数**允许出现旧表，但它的判据必须是引用来的，不能手抄：
  // 手抄一遍就等于把"同一件事两处写法"重新引进来（本仓已经栽过一次）。
  const reader = readFileSync(
    join(repoRoot, "packages/storage-sqlite/src/read/route-point-reader.ts"), "utf8"
  );
  assert.match(reader, /usableRouteConditionSql\("route"\)/,
    "降级取数的 WHERE 必须引用 `usableRouteConditionSql()`（判据只有一处定义）");
  assert.ok(!/file_status\s*=\s*'imported'/.test(stripComments(reader)),
    "唯一入口里不得手写 `file_status = 'imported'` 字面量：判据只能来自 `usableRouteConditionSql()`");
});

// ---------------------------------------------------------------------------
// 5. 写放大：一次发布只写一份点
// ---------------------------------------------------------------------------

test("O11：一次发布的点行改动数是 2N 而不是旧实现的 4N（写放大消除的可观测形态）", async () => {
  await withStore((store) => {
    store.insertWorkout(workout("w-a", "r-a"), "apple_watch", {});
    const points = Array.from({ length: 200 }, (_, sequence) => point(sequence, 40 + sequence / 1000));
    store.flush();

    const before = count(store, "SELECT total_changes() AS n");
    publish(store, "r-a", points, "hash-amplified");
    const changed = count(store, "SELECT total_changes() AS n") - before;

    // 逐个语句实测过（2026-10-16，N=100 探针）：
    //   旧实现 = beginRouteVersion(1) + 暂存点(N) + INSERT `route_points`(N) + upsert(1)
    //          + INSERT published 点(N) + UPDATE workout_routes(1) + 删暂存版本行(N+1，点靠 CASCADE 删)
    //          ⇒ **4N**；
    //   新实现 = beginRouteVersion(1) + 暂存点(N) + upsert(1) + 搬行(N) + UPDATE workout_routes(1)
    //          + 删暂存版本行(1，点已搬走、没有可级联的行) ⇒ **2N**。
    // 阈值取 2.5N：既排除旧实现的 4N，也把几条元数据行算作常数而不是放大。
    assert.ok(changed < points.length * 2.5,
      `一次发布的行改动数必须低于 2.5N（实测 ${changed}，N=${points.length}）；` +
      "超过它基本就是 `INSERT…SELECT` 到 `route_points` 的旧写法又回来了");
    assert.ok(changed >= points.length * 2 - 5,
      `也不能低于 2N（实测 ${changed}）：那说明"先删旧 published 点、再搬行"有一条没执行`);

    // 稳态形状：每个路线的点只有一份。
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM route_points"), 0);
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM route_version_points"), points.length);
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM readable_route_points"), points.length);
  });
});

test("O11：重复发布不累积点行 —— 旧 published 点先清掉，搬行不撞主键", async () => {
  await withStore((store) => {
    store.insertWorkout(workout("w-a", "r-a"), "apple_watch", {});
    publish(store, "r-a", [point(0, 40.1), point(1, 40.2)], "hash-1");
    const second = store.beginRouteVersion("r-a");
    store.appendRouteVersionPoints(second, [point(0, 41.1), point(1, 41.2), point(2, 41.3)]);
    store.publishRouteVersion(second, "hash-2", 3);

    assert.equal(count(store, "SELECT COUNT(*) AS n FROM route_version_points"), 3,
      "第二次发布必须把上一版的行清掉再搬：否则点数会累积成 5");
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM route_points"), 0, "重复发布也不写旧表");
    assert.deepEqual(new SqliteRoutePointReader(store.database).pointsForWorkout("w-a")?.map((item) => item.latitude),
      [41.1, 41.2, 41.3]);
  });
});
