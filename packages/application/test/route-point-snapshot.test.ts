// O06-A 分析输入快照（`:memory:`）与 O11 路线点唯一入口的**交界处**判据。
//
// ## 为什么这个用例必须存在
//
// O06-A 的物化快照按 `PINNED_FACT_TABLES` **逐表重放 DDL** 把事实拷进一块 `:memory:`，
// CPU 相位只读它（默认预算 40 万行，本地真库在预算内 ⇒ 这是**正常路径**，不是兜底路径）。
// 而 O11 退役了 `route_points` 的双写：已发布路线的点只存在于 `route_version_points`
// （v43 视图 `readable_route_points` = `workout_routes` ⋈ 指针 ⋈ 那两张点表）。
//
// ⇒ 快照的钉住清单里如果只有 `route_points`，快照里就**没有任何一处**装着已发布路线的点。
// 这正是 2026-10-16 实测到的缺口（清单归 `analysis-fact-view.ts` 所有，WP-50 的写范围不含它）。
//
// ## 判据（与修法无关，所以修好之后本用例仍然成立）
//
// **要么给出与主库相同的答案，要么响亮地失败。绝不静默读空。**
// 「静默读空」= 把"这条训练有轨迹"算成"没有轨迹"，`routeQuality` / 高程跟着变，
// 而已发布的分析值不会报错、行数与门禁上也看不出来。
// 失败也必须是**可归因**的：报错要点名缺的是 `route_version_points` / `readable_route_points`，
// 否则下一个人只会看到 `no such table` 并以为是自己写错了表名。
//
// 三段分别钉住：
// 1. 老库（只有指针为 NULL 的路线）⇒ 快照里点就在 `route_points`，两侧逐位相同（不许过度拒绝）；
// 2. 有已发布路线 ⇒ 唯一入口必须拒绝（本用例断"可归因的失败"，而不是断"返回 null"）；
// 3. 钉住清单补上 `route_version_points` 之后 ⇒ 两侧逐位相同（修好即转绿，不需要改用例）。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalWorkout, RoutePoint } from "@rai/contracts";
import { PINNED_FACT_TABLES, materializeFactSnapshot } from "@rai/application";
import { RaiDatabase, SqliteRoutePointReader } from "@rai/storage-sqlite";

const START = "2026-01-01T00:00:00.000Z";

function point(sequence: number, latitude: number, elevationMeters = 5): RoutePoint {
  return {
    sequence, timestamp: START, latitude, longitude: 121.1, elevationMeters,
    speedMetersPerSecond: 2.5, courseDegrees: null,
    horizontalAccuracyMeters: 4, verticalAccuracyMeters: null
  };
}

function workout(id: string, routeId: string): CanonicalWorkout {
  return {
    id, activityType: "HKWorkoutActivityTypeRunning", sourceName: "Watch", sourceVersion: "1",
    device: null, startAt: START, endAt: "2026-01-01T00:30:00.000Z", createdAt: null,
    durationSeconds: 1800, indoor: false, metadata: {}, statistics: [], events: [],
    routes: [{
      id: routeId, sourceName: "Watch", sourceVersion: "1", startAt: START,
      endAt: "2026-01-01T00:30:00.000Z", createdAt: null,
      relativePath: `workout-routes/${routeId}.gpx`, metadata: {}
    }]
  };
}

function publish(store: RaiDatabase, routeId: string, points: readonly RoutePoint[], hash: string): void {
  const staging = store.beginRouteVersion(routeId);
  store.appendRouteVersionPoints(staging, points);
  store.publishRouteVersion(staging, hash, points.length);
}

/** 把"要么给同一个答案、要么响亮失败"写成一次调用。 */
function answerOrError<T>(run: () => T): T | Error {
  try { return run(); } catch (error) { return error as Error; }
}

async function withStore(run: (store: RaiDatabase) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "rai-snapshot-route-points-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try { await run(store); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

/** 唯一入口在快照上拒绝时，必须是这一个错误、且报错要可归因。 */
function assertActionableRefusal(answer: unknown, context: string): void {
  assert.ok(answer instanceof Error, `${context}：要么给出与主库相同的结果，要么响亮失败 —— 不接受静默读空`);
  assert.equal(answer.name, "RoutePointSourceUnavailableError",
    `${context}：只接受这一种失败（实际 ${answer.name}: ${answer.message}）`);
  assert.match(answer.message, /route_version_points|readable_route_points/,
    `${context}：报错必须点名缺的关系，否则不可归因`);
}

test("O11×O06-A：只有老库路线时，快照必须与主库逐位同源（不许过度拒绝）", async () => {
  await withStore((store) => {
    store.insertWorkout(workout("w-legacy", "route-legacy"), "apple_watch", {});
    store.replaceRoutePoints("route-legacy", [point(0, 31.1, 5), point(1, 31.2, 6)]);
    store.flush();

    const main = new SqliteRoutePointReader(store.database);
    const snapshot = materializeFactSnapshot(store.database);
    try {
      const inSnapshot = new SqliteRoutePointReader(snapshot.database);
      assert.deepEqual(inSnapshot.pointsForWorkout("w-legacy"), main.pointsForWorkout("w-legacy"),
        "老库路线的点一直在 `route_points` 里（快照一直在拷它）⇒ CPU 相位必须读得到同一份");
      assert.equal(inSnapshot.elevationGain("w-legacy"), main.elevationGain("w-legacy"));
      assert.deepEqual({ ...inSnapshot.routeQualityForWorkout("w-legacy") },
        { ...main.routeQualityForWorkout("w-legacy") });
    } finally {
      snapshot.database.close();
    }
  });
});

test("O11×O06-A：模拟整合方补上钉住项之后，内联 union 降级与视图逐位同源", async () => {
  await withStore((store) => {
    store.insertWorkout(workout("w-legacy", "route-legacy"), "apple_watch", {});
    store.replaceRoutePoints("route-legacy", [point(0, 31.1, 5), point(1, 31.2, 6)]);
    store.insertWorkout(workout("w-published", "route-published"), "apple_watch", {});
    publish(store, "route-published", [point(0, 40.1, 10), point(1, 40.2, 14), point(2, 40.3, 12)], "snapshot-hash");
    store.flush();
    const main = new SqliteRoutePointReader(store.database);

    // 🔴 快照**不带视图**（第三个参数给空清单）⇒ 唯一入口会走"内联 union"降级。
    // 这一支是刻意保留的：整合方的**最小修法**是只往 `PINNED_FACT_TABLES` 里加
    // `route_version_points`、不必同时钉视图（该行已于 WP-50 收尾时落在生产清单里）。
    // 判据是"降级路径与视图路径逐位同源" —— 两条路必须给出同一个世界。
    const snapshot = materializeFactSnapshot(
      store.database,
      PINNED_FACT_TABLES,
      []
    );
    try {
      const inSnapshot = new SqliteRoutePointReader(snapshot.database);
      assert.deepEqual(inSnapshot.pointsForWorkout("w-published"), main.pointsForWorkout("w-published"),
        "内联 union 降级必须与视图给同一份已发布路线内容");
      assert.deepEqual(inSnapshot.pointsForWorkout("w-legacy"), main.pointsForWorkout("w-legacy"),
        "降级路径同时要保住 legacy 分支");
      assert.equal(inSnapshot.elevationGain("w-published"), main.elevationGain("w-published"));
      assert.deepEqual({ ...inSnapshot.routeQualityForWorkout("w-published") },
        { ...main.routeQualityForWorkout("w-published") });
      assert.equal(inSnapshot.countReadablePoints(), main.countReadablePoints(),
        "全库计数也必须同源（覆盖率/审计工具用它）");
    } finally {
      snapshot.database.close();
    }
  });
});

test("O11×O06-A：快照里有已发布路线时，唯一入口要么同源、要么可归因地拒绝（绝不静默读空）", async () => {
  await withStore((store) => {
    store.insertWorkout(workout("w-legacy", "route-legacy"), "apple_watch", {});
    store.replaceRoutePoints("route-legacy", [point(0, 31.1, 5), point(1, 31.2, 6)]);
    store.insertWorkout(workout("w-published", "route-published"), "apple_watch", {});
    publish(store, "route-published", [point(0, 40.1, 10), point(1, 40.2, 14)], "snapshot-hash");
    store.flush();

    const main = new SqliteRoutePointReader(store.database);
    const publishedOnMain = main.pointsForWorkout("w-published");
    assert.deepEqual(publishedOnMain?.map((item) => item.latitude), [40.1, 40.2],
      "前置：主库上这条已发布路线**读得到**（否则下面的判据是空转）");
    assert.ok(main.elevationGain("w-published") !== null, "前置：主库上这条路线有高程增益");

    const snapshot = materializeFactSnapshot(store.database);
    try {
      const inSnapshot = new SqliteRoutePointReader(snapshot.database);
      const pinned = PINNED_FACT_TABLES.includes("route_version_points");

      const points = answerOrError(() => inSnapshot.pointsForWorkout("w-published"));
      const gain = answerOrError(() => inSnapshot.elevationGain("w-published"));
      const quality = answerOrError(() => inSnapshot.routeQualityForWorkout("w-published"));

      if (pinned) {
        // 修好之后必须走这一支：快照与主库同源，数字逐位相同。
        assert.deepEqual(points, publishedOnMain, "钉住 route_version_points 之后两侧必须同源");
        assert.equal(gain, main.elevationGain("w-published"));
        assert.deepEqual({ ...(quality as object) }, { ...main.routeQualityForWorkout("w-published") });
      } else {
        // 现状：快照里没有任何一处装着已发布路线的点 ⇒ 三种读法都必须可归因地拒绝。
        assertActionableRefusal(points, "轨迹点");
        assertActionableRefusal(gain, "高程增益");
        assertActionableRefusal(quality, "路线质量");
      }
    } finally {
      snapshot.database.close();
    }
  });
});
