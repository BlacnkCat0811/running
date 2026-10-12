import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workoutTypes } from "@rai/contracts";

import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { RaiDatabase } from "../src/database.js";
import {
  importGpxRoutes,
  MAX_GPX_ROUTE_BYTES,
  MAX_GPX_ROUTE_POINTS
} from "../src/gpx-parser.js";

// V2.1 规范 §5.2 的 GPX 配额。三个数字都**没有**照抄规范，理由写在 `gpx-parser.ts`
// 的常量注释里（规范给的 20 MB / 50,000 / 200,000 分别会误杀 24 小时越野、
// 24 小时越野、以及「重新导入全部」这条唯一的重建路径）。
// 本文件钉的是"合法数据碰不到"，因为配额超限的处置（该次跑步失去轨迹与海拔）是不可归因的。

const appleDate = (hour: string): string => `2026-01-02 ${hour}:00 +0800`;

/** 逐点写 8 个字段、无抽稀 —— 与 `apps/ios/RAI/HealthKitExport.swift` 的生成器同形。 */
function gpx(pointCount: number): string {
  const rows: string[] = [];
  for (let index = 0; index < pointCount; index += 1) {
    rows.push(
      `<trkpt lat="23.1${index % 10}" lon="113.3${index % 10}">`
      + `<ele>12.5</ele><time>2026-01-02T00:00:00Z</time><speed>3.1</speed>`
      + `<course>180</course><hAcc>5</hAcc><vAcc>5</vAcc></trkpt>`
    );
  }
  return `<gpx><trk><trkseg>${rows.join("")}</trkseg></trk></gpx>`;
}

function writeExport(root: string, routeNames: readonly string[]): string {
  mkdirSync(join(root, "workout-routes"), { recursive: true });
  const xmlPath = join(root, "export.xml");
  const workouts = routeNames
    .map(
      (name, index) => `<Workout workoutActivityType="${workoutTypes.running}"
      sourceName="Watch" startDate="${appleDate(`0${index + 8}:00`)}"
      endDate="${appleDate(`0${index + 8}:30`)}" duration="30" durationUnit="min">
      <WorkoutRoute><FileReference path="/workout-routes/${name}"/></WorkoutRoute>
    </Workout>`
    )
    .join("");
  writeFileSync(xmlPath, `<HealthData>${workouts}</HealthData>`, "utf8");
  return xmlPath;
}

async function withExport(
  routeNames: readonly string[],
  body: (root: string, store: RaiDatabase) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-gpx-quota-"));
  const xmlPath = writeExport(root, routeNames);
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    await body(root, store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function routeStatus(store: RaiDatabase): Array<{ file_status: string; point_count: number }> {
  // 映射成普通对象再比：`node:assert/strict` 的 `deepEqual` 是 `deepStrictEqual`，
  // 而 `StatementSync.all()` 返回的是 `[Object: null prototype]` 形状 —— 直接比会
  // 报"值一样但原型不同"，看起来像失败其实是脚手架。
  const rows = store.database
    .prepare("SELECT file_status, point_count FROM workout_routes ORDER BY relative_path")
    .all() as unknown as Array<{ file_status: string; point_count: number }>;
  return rows.map((row) => ({
    file_status: String(row.file_status),
    point_count: Number(row.point_count)
  }));
}

function issueCodes(store: RaiDatabase): string[] {
  return (
    store.database.prepare("SELECT code FROM import_issues ORDER BY code").all() as unknown as Array<{
      code: string;
    }>
  ).map((row) => String(row.code));
}

test("a 24-hour ultra route (86,400 points at 1 Hz) is imported, not refused", async () => {
  // 这是"配额不误杀合法数据"的正向判据，也是规范给的 50,000 点上限为什么不能采用的证据：
  // 50,000 点 @1 Hz = 13.9 小时，而 24 小时越野 ≈ 86,400 点。
  await withExport(["ultra.gpx"], async (root, store) => {
    writeFileSync(join(root, "workout-routes", "ultra.gpx"), gpx(86_400), "utf8");
    const result = await importGpxRoutes(root, store);

    assert.equal(result.importedRouteCount, 1);
    assert.equal(result.pointCount, 86_400);
    assert.equal(result.oversizedRouteCount, 0);
    assert.deepEqual(routeStatus(store), [{ file_status: "imported", point_count: 86_400 }]);
    assert.deepEqual(issueCodes(store), []);
  });
});

test("a route past the point quota is refused without calling it corrupt", async () => {
  await withExport(
    ["ok.gpx", "huge.gpx"],
    async (root, store) => {
      writeFileSync(join(root, "workout-routes", "ok.gpx"), gpx(3), "utf8");
      writeFileSync(
        join(root, "workout-routes", "huge.gpx"),
        gpx(MAX_GPX_ROUTE_POINTS + 1_000),
        "utf8"
      );
      const result = await importGpxRoutes(root, store);

      // 关键：超限**不中断整批**，其余路线照常导入。
      assert.equal(result.importedRouteCount, 1);
      assert.equal(result.oversizedRouteCount, 1);
      assert.equal(result.pointCount, 3);

      const routes = store.database
        .prepare("SELECT relative_path, file_status, point_count FROM workout_routes ORDER BY relative_path")
        .all() as unknown as Array<{ relative_path: string; file_status: string; point_count: number }>;
      const ok = routes.find((route) => route.relative_path.endsWith("ok.gpx"));
      const huge = routes.find((route) => route.relative_path.endsWith("huge.gpx"));
      assert.equal(ok?.file_status, "imported");
      assert.equal(ok?.point_count, 3);
      // 🔴 必须是 `pending` 而不是 `invalid`：`invalid` 断言"这份文件是坏的"，而那是假话。
      // 两种状态的下游成本一样（都拿不到轨迹），差别在可归因性 —— 假话会让下一个人去修解析器。
      assert.equal(huge?.file_status, "pending");
      assert.equal(huge?.point_count, 0);
      assert.deepEqual(issueCodes(store), ["GPX_ROUTE_TOO_MANY_POINTS"]);

      // 指纹被删掉 ⇒ 下次导入会重试（配额是"这次不导"，不是"永久不要了"）。
      const fingerprints = store.database
        .prepare("SELECT relative_path FROM route_file_fingerprints")
        .all() as unknown as Array<{ relative_path: string }>;
      assert.deepEqual(
        fingerprints.map((row) => row.relative_path.endsWith("ok.gpx")),
        [true]
      );
    }
  );
});

test("a route past the byte quota is left completely untouched", async () => {
  await withExport(["sparse.gpx"], async (root, store) => {
    // 稀疏但点数很少、字节很多：字节配额必须在 `beginRouteVersion` **之前**判，
    // 否则"先建版本、再说超限"会给一份不会被导入的文件留下垃圾版本行。
    const padding = "x".repeat(MAX_GPX_ROUTE_BYTES + 1);
    writeFileSync(
      join(root, "workout-routes", "sparse.gpx"),
      `<gpx><!--${padding}--><trk><trkseg><trkpt lat="23.1" lon="113.3"/></trkseg></trk></gpx>`,
      "utf8"
    );
    const result = await importGpxRoutes(root, store);

    assert.equal(result.oversizedRouteCount, 1);
    assert.equal(result.importedRouteCount, 0);
    assert.equal(result.pointCount, 0);
    assert.deepEqual(routeStatus(store), [{ file_status: "pending", point_count: 0 }]);
    assert.deepEqual(issueCodes(store), ["GPX_ROUTE_TOO_LARGE"]);
  });
});

test("the per-route point quota is consistent with the byte quota", () => {
  // 两个上限不许互相矛盾：若点数上限高于"字节上限能容纳的点数"，它就永远不会生效。
  // 本仓生成器逐点写 8 个字段 ≈ 213 B/点（`HealthKitExport.swift`），而实测行如
  // `<trkpt lat="23.1" lon="113.3"><ele>12.5</ele>…` 单点约 150–250 B。
  const bytesPerPoint = 213;
  const pointsFittingInByteQuota = Math.floor(MAX_GPX_ROUTE_BYTES / bytesPerPoint);
  assert.ok(
    MAX_GPX_ROUTE_POINTS < pointsFittingInByteQuota,
    `the point quota (${MAX_GPX_ROUTE_POINTS}) must be reachable before the byte quota `
    + `(${pointsFittingInByteQuota} points would fit), otherwise it is dead code`
  );
  // 同时它必须远高于最坏的合法形态（24 小时越野 ≈ 86,400 点）。
  assert.ok(MAX_GPX_ROUTE_POINTS > 86_400 * 3, "the point quota leaves no headroom for a 24-hour ultra");
});
