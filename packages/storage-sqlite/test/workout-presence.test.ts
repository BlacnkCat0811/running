// 训练事实的**存在性判据**（PR5 D4 / S1+S2，见 docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md）。
//
// 三件事必须同时成立，缺一条 D4 就没落地：
//   1. **判据只有一处**：可见性条件由 `workoutPresentConditionSql()` 给出，别处不得再写一遍
//      字面 SQL（同一件事两处写法 = 迟早分叉，本仓已踩过 `has_route` 那次）。
//   2. **写侧留下身份**：物理 `DELETE FROM workouts` 会沿
//      workouts→workout_routes→route_versions→route_version_points 级联，把**已发布路线版本
//      的全部点**一起删掉（2026-10-13 实测四张表归零）。软删之后这些证据必须仍在。
//   3. **读侧看得见"不在"**：`deleted_at` 非空的行必须被排除 —— 而不是靠"恰好 INNER JOIN 掉了"。

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { CanonicalWorkout, RoutePoint } from "@rai/contracts";
import { RaiDatabase, sessionFactPresentConditionSql, workoutPresentConditionSql } from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sampleWorkout(overrides: Partial<CanonicalWorkout> = {}): CanonicalWorkout {
  return {
    id: "workout-a", activityType: "HKWorkoutActivityTypeRunning", sourceName: "Watch",
    sourceVersion: "1", device: null, startAt: "2026-01-01T00:00:00.000Z",
    endAt: "2026-01-01T00:30:00.000Z", createdAt: null, durationSeconds: 1800,
    indoor: false, // MetadataMap 的值是**数组**（解析器就是这么写的）；写字符串会让
    // `removeWorkoutsBySyncIdentifiers` 的 json_each 匹配不上（实测：那样删除会静默不生效）。
    metadata: { HKMetadataKeySyncIdentifier: ["sync-a"] }, statistics: [], events: [], routes: [], ...overrides
  };
}

function point(sequence: number, latitude: number): RoutePoint {
  return {
    sequence, timestamp: "2026-01-01T00:00:00.000Z", latitude, longitude: 121.1,
    elevationMeters: 5, speedMetersPerSecond: 2.5, courseDegrees: null,
    horizontalAccuracyMeters: 4, verticalAccuracyMeters: null
  };
}

async function withStore(run: (store: RaiDatabase) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "rai-workout-presence-"));
  const store = await RaiDatabase.open(join(directory, "rai.sqlite"), { createMigrationBackup: false });
  try { await run(store); }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

const count = (store: RaiDatabase, sql: string): number =>
  Number((store.database.prepare(sql).get() as { n: number }).n);

test("C7：软删训练**不**级联销毁已发布路线的版本内容（物理删会，实测四张表归零）", async () => {
  await withStore(async (store) => {
    store.insertWorkout(sampleWorkout({ routes: [{
      id: "route-a", sourceName: "Watch", sourceVersion: "1",
      startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-01T00:30:00.000Z",
      createdAt: null, relativePath: "workout-routes/a.gpx", metadata: {}
    }] }), "apple_watch", {});
    store.replaceRoutePoints("route-a", [point(0, 31.1), point(1, 31.2)]);
    const staging = store.beginRouteVersion("route-a");
    store.appendRouteVersionPoints(staging, [point(0, 31.1), point(1, 31.2)]);
    store.publishRouteVersion(staging, "content-hash-a", 2);

    const publishedId = (store.database.prepare(
      "SELECT published_route_version_id AS id FROM workout_routes WHERE id = 'route-a'"
    ).get() as { id: string }).id;
    assert.ok(publishedId, "前置：必须有一条已发布版本");
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM route_version_points"), 2);

    // 走**生产写路径**删除（不是直接改列）：manifest 的显式删除 → 软删标记。
    const removed = store.removeWorkoutsBySyncIdentifiers(["sync-a"]);
    assert.deepEqual(removed, ["2026-01-01T00:00:00.000Z"]);
    store.flush();

    assert.equal(count(store, `SELECT COUNT(*) AS n FROM workouts
      WHERE id = 'workout-a' AND ${workoutPresentConditionSql()}`), 0, "它不再是仍在的事实");
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM workouts WHERE id = 'workout-a'"), 1,
      "行必须保留（物理删会连带销毁下面的路线证据）");
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM workout_routes WHERE id = 'route-a'"), 1,
      "路线行不得级联消失");
    assert.equal(count(store, `SELECT COUNT(*) AS n FROM route_versions WHERE id = '${publishedId}'`), 1,
      "已发布版本行必须仍在");
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM route_version_points"), 2,
      "🔴 已发布版本的点一个都不能少 —— 这是「旧 release 保持可读」在删除场景下的唯一载体");
    assert.equal((store.database.prepare(
      "SELECT published_route_version_id AS id FROM workout_routes WHERE id = 'route-a'"
    ).get() as { id: string }).id, publishedId, "发布指针不得被删除改动");
  });
});

test("删除之后再收到的权威载荷可以恢复它（deleted_at 被撤销），而墓碑挡住的载荷不行", async () => {
  await withStore(async (store) => {
    store.insertWorkout(sampleWorkout(), "apple_watch", {});
    store.removeWorkoutsBySyncIdentifiers(["sync-a"]);
    store.flush();
    assert.equal(count(store, `SELECT COUNT(*) AS n FROM workouts WHERE ${workoutPresentConditionSql()}`), 0);

    // ① 直接重放同一条 workout（模拟权威完整载荷）：`insertWorkout` 的 upsert 必须擦掉标记。
    store.insertWorkout(sampleWorkout(), "apple_watch", {});
    store.flush();
    assert.equal(count(store, `SELECT COUNT(*) AS n FROM workouts WHERE ${workoutPresentConditionSql()}`), 1,
      "权威载荷重新提到它时必须恢复（「删错了还能从好档案里恢复」是既有契约）");

    // ② 反之，**墓碑仍在**时解析器根本不会 insert（`observation.tombstoned` 的 shouldWrite 判定），
    // 所以"删除是持久的、不随最新载荷漂移"这条语义没有被软删改坏。
    store.removeWorkoutsBySyncIdentifiers(["sync-a"]);
    store.flush();
    const observation = store.observeImportEntity("workout", "workout-a", "generation-x",
      "2026-01-01T00:00:00.000Z", undefined, "content", ["sync-a"]);
    assert.deepEqual(observation, { inserted: false, updated: false, tombstoned: true });
    assert.equal(count(store, `SELECT COUNT(*) AS n FROM workouts WHERE ${workoutPresentConditionSql()}`), 0);
  });
});

test("会话级判据与训练级判据同源：只在事实确实被删时排除", async () => {
  await withStore(async (store) => {
    store.insertWorkout(sampleWorkout(), "apple_watch", {});
    store.database.prepare(`INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, canonical_workout_id, status)
      VALUES ('session-a','HKWorkoutActivityTypeRunning','2026-01-01T00:00:00.000Z',
        '2026-01-01T00:30:00.000Z','workout-a','active')`).run();
    const liveSessions = (): number => count(store,
      `SELECT COUNT(*) AS n FROM training_sessions session WHERE ${sessionFactPresentConditionSql("session")}`);
    assert.equal(liveSessions(), 1);

    store.removeWorkoutsBySyncIdentifiers(["sync-a"]);
    store.flush();
    assert.equal(liveSessions(), 0, "训练级已删 ⇒ 会话级必须同步排除");
  });
});

test("结构判据：可见性判据只有一处实现，事实侧 JOIN 全部引用它", () => {
  // ① 全仓只有 `sql/fragments.ts` 允许出现 `deleted_at IS NULL` 这类**可见性**字面量。
  //    （`deleted_at IS NOT NULL` 是**写侧/守卫**的判据，不是可见性；`deleted_at =` 是软删标记本身。）
  const sources: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) sources.push(full);
    }
  };
  for (const packageDirectory of readdirSync(join(root, "packages"))) {
    walk(join(root, "packages", packageDirectory, "src"));
  }
  walk(join(root, "apps", "api", "src"));

  const visibilityLiteral = /deleted_at\s+IS\s+NULL/i;
  // Windows 上 `relative()` 返回 `packages\storage-sqlite\src\…`，与下面的期望值（POSIX 分隔符）不等：
  // 报错文案会写成"出现了第二处字面量"，而实际命中的正是那唯一一处 —— 假警报。
  // 这条判据比较的是"哪些文件命中"，不是"路径用什么分隔符"，所以先归一化（2026-10-13 实测修）。
  const offenders = sources.filter((file) => visibilityLiteral.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file).replaceAll("\\", "/")).sort();
  assert.deepEqual(offenders, ["packages/storage-sqlite/src/sql/fragments.ts"],
    "出现了第二处 `deleted_at IS NULL` 字面量：可见性判据必须只有 `workoutPresentConditionSql()` 一处定义");

  // ② 事实侧读文件里每个 `FROM workouts` / `JOIN workouts` 都必须引用那条判据。
  const factSideFiles = [
    "packages/storage-sqlite/src/read/workout-read-repository.ts",
    "packages/storage-sqlite/src/read/series-read-repository.ts",
    "packages/storage-sqlite/src/read/facts-reader.ts",
    // PR5 S4 新增：两块视图的事实侧读。加进这份清单是刻意的 —— 新文件若不在扫描面里，
    // 里面每一处 `JOIN workouts` 都可以悄悄不引用判据而"全绿"（结构判据的盲区就是它的扫描面）。
    "packages/storage-sqlite/src/read/fact-read-view.ts",
    "apps/api/src/data.ts",
    "apps/api/src/mobile-read.ts"
  ];
  for (const file of factSideFiles) {
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(/(?:FROM|JOIN) workouts\b/g)) {
      // 取所在的反引号模板串（前后各一个反引号之间），要求它引用判据。
      const before = text.lastIndexOf("`", match.index!);
      const after = text.indexOf("`", match.index!);
      const statement = before >= 0 && after > before ? text.slice(before, after) : "";
      assert.match(statement, /workoutPresentConditionSql/,
        `${file} 里有一处 \`${match[0]}\` 没有引用 workoutPresentConditionSql —— ` +
        "事实侧的存在性判据不允许就地手写（那样删除会在这一条路径上泄露）");
    }
  }
});

test("迁移 v36：只新增可空列，老库补迁移后所有行读作“未删除”", async () => {
  await withStore(async (store) => {
    const columns = store.database.prepare("PRAGMA table_info(workouts)").all() as
      Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const deletedAt = columns.find((column) => column.name === "deleted_at");
    assert.ok(deletedAt, "v36 必须给 workouts 加 deleted_at 列");
    assert.equal(deletedAt.notnull, 0, "必须是**可空**列（§14.2 A18：只新增，不改历史 up）");
    assert.equal(deletedAt.dflt_value, null, "没有默认值 —— 老行保持 NULL = 未删除");
    store.insertWorkout(sampleWorkout(), "apple_watch", {});
    assert.equal(count(store, `SELECT COUNT(*) AS n FROM workouts WHERE ${workoutPresentConditionSql()}`), 1);
    assert.equal(count(store, "SELECT COUNT(*) AS n FROM workouts WHERE deleted_at IS NULL"), 1);
  });
});
