// 路线版本契约（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §2.4 / §5.3，v35 的 `route_versions`）。
//
// 这一步要证的核心只有一句话：**未发布的内容永远碰不到正在展示的轨迹**。
// 旧实现是先 `DELETE FROM route_points` 再解析 —— 文件坏掉时那条已经能用的轨迹就没了。
//
// 🔴 这里的每条"必须拒绝"都要有一次**期望抛错**的调用。只断言"发布成功后指针动了"
// 无法区分"校验生效"与"校验被删掉" —— 后者下成功路径一样能走通。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalWorkout, RoutePoint } from "@rai/contracts";
import { RaiDatabase } from "../src/database.js";
import { SqliteRoutePointReader } from "../src/read/route-point-reader.js";

function sampleWorkout(overrides: Partial<CanonicalWorkout> = {}): CanonicalWorkout {
  return {
    id: "workout-a", activityType: "HKWorkoutActivityTypeRunning", sourceName: "Watch",
    sourceVersion: "1", device: null, startAt: "2026-01-01T00:00:00.000Z",
    endAt: "2026-01-01T00:30:00.000Z", createdAt: null, durationSeconds: 1800,
    indoor: false, metadata: {}, statistics: [], events: [], routes: [], ...overrides
  };
}

function point(sequence: number, latitude: number): RoutePoint {
  return {
    sequence, timestamp: "2026-01-01T00:00:00.000Z", latitude, longitude: 121.1,
    elevationMeters: 5, speedMetersPerSecond: 2.5, courseDegrees: null,
    horizontalAccuracyMeters: 4, verticalAccuracyMeters: null
  };
}

interface RouteState {
  fileStatus: string;
  pointCount: number;
  publishedRouteVersionId: string | null;
}

async function withRoute(run: (store: RaiDatabase) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "rai-route-version-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    store.insertWorkout(sampleWorkout({ routes: [{
      id: "route-a", sourceName: "Watch", sourceVersion: "1",
      startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-01T00:30:00.000Z",
      createdAt: null, relativePath: "workout-routes/a.gpx", metadata: {}
    }] }), "apple_watch", {});
    // 先落一份"正在展示"的轨迹：这是后面所有失败场景都必须保住的东西。
    store.replaceRoutePoints("route-a", [point(0, 31.1), point(1, 31.2)]);
    await run(store);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

function routeState(store: RaiDatabase): RouteState {
  const row = store.database.prepare(`
    SELECT file_status AS fileStatus, point_count AS pointCount,
           published_route_version_id AS publishedRouteVersionId
    FROM workout_routes WHERE id = 'route-a'
  `).get() as unknown as RouteState;
  return { ...row, publishedRouteVersionId: row.publishedRouteVersionId ?? null };
}

/**
 * 「这条路线此刻**读得到**的轨迹」的纬度。
 *
 * 🔴 读的是**唯一的路线点入口**（`readable_route_points` 视图），不是 `route_points` 表：
 * O11 / WP-50 退役双写之后，已发布路线的点只留在 published 版本行里，旧表里那一份
 * 是**不可读的遗留副本**。断言必须落在"用户看到的轨迹"上，而不是"某张实现表里有没有行"
 * —— 后者会把"轨迹还在、只是搬了家"误报成"轨迹没了"。
 */
function storedLatitudes(store: RaiDatabase): number[] {
  return new SqliteRoutePointReader(store.database)
    .pointsForWorkout("workout-a")!
    .map((point) => point.latitude);
}

/** 旧表里还剩多少行 —— 只用来断言"双写已退役"，不参与轨迹内容的判断。 */
function legacyCopyRows(store: RaiDatabase): number {
  return (store.database.prepare(
    "SELECT COUNT(*) AS n FROM route_points WHERE route_id = 'route-a'"
  ).get() as { n: number }).n;
}

/**
 * 读**指针实际指向的那一行**版本。
 *
 * 🔴 这一步不能省：只断言"指针非空"会漏掉"指针指向一条 `rejected` 版本"这种自相矛盾状态
 * （步骤 5 实测过的缺陷 —— 那时暂存与已发布共用一条行，一次失败的重新导入会把
 * 正在被引用的版本打成 `rejected`）。
 */
function publishedVersion(store: RaiDatabase): { status: string; hash: string; pointCount: number } {
  return store.database.prepare(`
    SELECT v.status, v.content_sha256 AS hash, v.point_count AS pointCount
    FROM workout_routes r JOIN route_versions v ON v.id = r.published_route_version_id
    WHERE r.id = 'route-a'
  `).get() as unknown as { status: string; hash: string; pointCount: number };
}

test("点数不足的版本发布被拒，且已发布的轨迹与指针一字未动", async () => {
  await withRoute((store) => {
    const before = routeState(store);
    assert.deepEqual(storedLatitudes(store), [31.1, 31.2]);

    const version = store.beginRouteVersion("route-a");
    store.appendRouteVersionPoints(version, [point(0, 33.3)]);
    assert.throws(() => store.publishRouteVersion(version, "hash-partial", 2), /incomplete/);

    assert.deepEqual(storedLatitudes(store), [31.1, 31.2], "发布失败不得改写已发布轨迹");
    assert.deepEqual(routeState(store), before, "发布失败不得改动路线状态或指针");
    // 版本仍是 pending：它没成，但也没被伪装成成功。
    assert.equal(
      (store.database.prepare("SELECT status FROM route_versions WHERE id = ?").get(version) as { status: string }).status,
      "pending"
    );
  });
});

test("点数对但序号不连续同样拒绝：只数行数会漏掉中间断片的轨迹", async () => {
  await withRoute((store) => {
    const version = store.beginRouteVersion("route-a");
    // 2 个点、序号 0 与 2 —— 行数对得上，中间却少了一片。
    store.appendRouteVersionPoints(version, [point(0, 33.3), point(2, 33.5)]);
    assert.throws(() => store.publishRouteVersion(version, "hash-gap", 2), /incomplete/);
    assert.deepEqual(storedLatitudes(store), [31.1, 31.2]);
    assert.equal(routeState(store).publishedRouteVersionId, null);
  });
});

test("完整版本发布：短事务内换点、移指针，且点数与候选一致", async () => {
  await withRoute((store) => {
    const version = store.beginRouteVersion("route-a");
    store.appendRouteVersionPoints(version, [point(0, 32.1), point(1, 32.2)]);
    store.publishRouteVersion(version, "hash-full", 2);

    assert.deepEqual(storedLatitudes(store), [32.1, 32.2]);
    const state = routeState(store);
    assert.equal(state.fileStatus, "imported");
    assert.equal(state.pointCount, 2);
    assert.ok(state.publishedRouteVersionId, "发布后必须留下指针");
    // 断言落在**指针指向的那一行**上，而不是只断言指针非空。
    assert.deepEqual({ ...publishedVersion(store) },
      { status: "complete", hash: "hash-full", pointCount: 2 });
    // 候选与产物的点数必须一致：拷贝少了一行而指针照样移动的话，这里会红。
    assert.equal(
      (store.database.prepare(
        "SELECT COUNT(*) AS n FROM route_version_points WHERE route_version_id = ?"
      ).get(version) as { n: number }).n,
      0,
      "发布后暂存行应被丢弃（它的点**搬**到 published 版本行上了）"
    );
    // 🔴 O11 / WP-50：双写已退役 —— 这条路线在旧表里**一行都不该有**。
    // 旧写法（INSERT…SELECT 各来一份）会在这里留下 2 行，而那正是"同一份点两处真相"。
    assert.equal(legacyCopyRows(store), 0,
      "已发布路线不得在 `route_points` 里留副本：点只有 published 版本行一份");
    // 🔴 published 版本行必须**自己带着**这份轨迹的内容。
    // 只写元数据会让它 `point_count = 2` 却没有一行点 —— 一条自称完整却没有内容的版本，
    // 而读侧（`readable_route_points` 视图）正是按指针去读这一行的点。
    assert.equal(
      (store.database.prepare("SELECT COUNT(*) AS n FROM route_version_points WHERE route_version_id = ?")
        .get(state.publishedRouteVersionId) as { n: number }).n,
      2,
      "published 版本的 `point_count` 必须与它自己的点行数一致"
    );
  });
});

test("同一路线复用同一暂存槽位；上一次失败留下的半条点不会拼进新轨迹", async () => {
  await withRoute((store) => {
    const first = store.beginRouteVersion("route-a");
    store.appendRouteVersionPoints(first, [point(0, 32.1), point(1, 32.2)]);
    store.publishRouteVersion(first, "hash-first", 2);

    // 模拟"上一次导入半途失败"：暂存行仍 pending，且留着半条轨迹的点（没有 publish）。
    const second = store.beginRouteVersion("route-a");
    assert.equal(second, first, "同一路线必须复用同一暂存槽位（确定性 id ⇒ 结果可复现）");
    store.appendRouteVersionPoints(second, [point(0, 77.7)]);

    // 再导一次，这一次完整。若 `beginRouteVersion` 没清掉上一次的残留点，
    // 点数会变成 3 —— 发布前的自证会因为"声明 2 点、库里 3 点"直接拒绝。
    const third = store.beginRouteVersion("route-a");
    assert.equal(third, second);
    store.appendRouteVersionPoints(third, [point(0, 33.1), point(1, 33.2)]);
    store.publishRouteVersion(third, "hash-second", 2);

    assert.deepEqual(storedLatitudes(store), [33.1, 33.2], "上一次的残留点不得被拼进新轨迹");
    assert.deepEqual({ ...publishedVersion(store) },
      { status: "complete", hash: "hash-second", pointCount: 2 });
    assert.equal(
      (store.database.prepare(
        "SELECT COUNT(*) AS n FROM route_versions WHERE route_id = 'route-a'"
      ).get() as { n: number }).n,
      1,
      "稳态下每条路线只应留下一条版本行（暂存在发布时被丢弃）：版本行数被路线数封顶"
    );
  });
});

test("被拒的版本只留痕迹：路线状态、指针、已发布轨迹，以及指针指向的那条版本全都不动", async () => {
  await withRoute((store) => {
    const published = store.beginRouteVersion("route-a");
    store.appendRouteVersionPoints(published, [point(0, 32.1), point(1, 32.2)]);
    store.publishRouteVersion(published, "hash-good", 2);
    const before = routeState(store);
    const versionBefore = publishedVersion(store);

    const rejected = store.beginRouteVersion("route-a");
    store.appendRouteVersionPoints(rejected, [point(0, 99.9)]);
    store.rejectRouteVersion(rejected);

    assert.equal(
      (store.database.prepare("SELECT status FROM route_versions WHERE id = ?").get(rejected) as { status: string }).status,
      "rejected"
    );
    assert.deepEqual(storedLatitudes(store), [32.1, 32.2], "被拒版本不得影响已发布轨迹");
    assert.deepEqual(routeState(store), before, "被拒版本不得改动路线状态或指针");
    // 🔴 这一条是本用例的关键：指针指向的那条版本必须仍然是 `complete`。
    // 若暂存与已发布共用一条行（步骤 5 的初版设计），一次失败的重导会把**正被引用**的
    // 版本打成 `rejected` —— 于是"file_status=imported、点还在、却引用一条 rejected 版本"，
    // 读侧（PR5 起 JOIN status='complete'）会读不到任何轨迹。
    assert.deepEqual({ ...publishedVersion(store) }, { ...versionBefore });
    assert.equal(publishedVersion(store).status, "complete");
  });
});
