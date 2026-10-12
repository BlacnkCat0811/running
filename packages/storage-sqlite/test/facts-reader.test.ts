// 固定版本事实读取器（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §4，v34 的
// `import_fact_history` / `import_generations`）。
//
// 这组用例要钉死的核心只有两条：
//   ① **NULL 的 `valid_from_generation` 是"自古以来有效"**，不是"未定义/不可见"。
//      v34 加列之前的所有老行都是 NULL —— 把 NULL 当成不可见，reader 在任何老库上都返回空集。
//   ② 代次 `G` 的视图由 `import_fact_history` 的窗口决定，**不返回混合结果**：
//      `G=1` 只有旧内容，`G=5` 只有新内容。
//
// 🔴 reader 用**独立的只读连接**，所以写入必须已提交（`store.flush()`）才可见 —— 这是刻意的：
//    "只读"不能靠共用可写连接来假装。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalHealthRecord, CanonicalWorkout, RoutePoint } from "@rai/contracts";
import { RaiDatabase } from "../src/database.js";
import { openFactsReader } from "../src/read/facts-reader.js";

function record(overrides: Partial<CanonicalHealthRecord> & { id: string }): CanonicalHealthRecord {
  return {
    type: "HKQuantityTypeIdentifierBodyMass",
    sourceName: "Watch",
    sourceVersion: "1",
    device: null,
    unit: "kg",
    numericValue: 70,
    textValue: null,
    startAt: "2026-01-01T00:00:00.000Z",
    endAt: "2026-01-01T00:00:01.000Z",
    createdAt: null,
    metadata: {},
    ...overrides
  };
}

function workout(overrides: Partial<CanonicalWorkout> & { id: string }): CanonicalWorkout {
  return {
    activityType: "HKWorkoutActivityTypeRunning",
    sourceName: "Watch",
    sourceVersion: "1",
    device: null,
    startAt: "2026-01-01T06:00:00.000Z",
    endAt: "2026-01-01T06:30:00.000Z",
    createdAt: null,
    durationSeconds: 1800,
    indoor: false,
    metadata: {},
    statistics: [],
    events: [],
    routes: [],
    ...overrides
  };
}

function routePoint(sequence: number, latitude: number): RoutePoint {
  return {
    sequence,
    timestamp: "2026-01-01T06:00:00.000Z",
    latitude,
    longitude: 121.1,
    elevationMeters: 5,
    speedMetersPerSecond: 2.5,
    courseDegrees: null,
    horizontalAccuracyMeters: 4,
    verticalAccuracyMeters: null
  };
}

/** 建一个隔离库；`seed` 里写完务必 `flush()`（reader 是独立只读连接）。 */
async function withStore(run: (store: RaiDatabase, path: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-facts-reader-"));
  const path = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(path, { createMigrationBackup: false });
  try {
    await run(store, path);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function setValidFrom(store: RaiDatabase, table: "health_records" | "workouts", id: string, generation: number): void {
  store.database.prepare(`UPDATE ${table} SET valid_from_generation = ? WHERE id = ?`).run(generation, id);
}

function insertHistory(
  store: RaiDatabase,
  entry: {
    kind: "record" | "workout";
    id: string;
    from: number;
    to: number | null;
    payload: unknown;
  }
): void {
  store.database
    .prepare(`
      INSERT INTO import_fact_history
        (entity_kind, entity_id, valid_from_generation, valid_to_generation,
         content_hash, effective_at, available_at, payload_json)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
    `)
    .run(entry.kind, entry.id, entry.from, entry.to, `hash-${entry.id}-${entry.from}`, JSON.stringify(entry.payload));
}

const ids = (iterable: Iterable<{ id: string }>): string[] =>
  [...iterable].map((item) => item.id).sort();

test("老库语义：valid_from_generation 为 NULL 的行对任意代次都可见", async () => {
  await withStore((store, path) => {
    store.insertRecord(record({ id: "legacy-null" }), "apple_watch", {});
    store.flush();

    for (const generation of [0, 1, 7, 1_000_000]) {
      const reader = openFactsReader(path, generation);
      try {
        assert.deepEqual(ids(reader.records({})), ["legacy-null"],
          `NULL 的 valid_from_generation 必须在代次 ${generation} 可见`);
      } finally {
        reader.close();
      }
    }
  });
});

test("版本正确性：G=1 读到旧内容、G=5 读到新内容，都不返回混合结果", async () => {
  await withStore((store, path) => {
    // 当前行 = 更正后的新内容（自代次 5 起有效）。
    store.insertRecord(record({ id: "rec-corrected", numericValue: 80 }), "apple_watch", {});
    setValidFrom(store, "health_records", "rec-corrected", 5);
    // 稀疏历史 = 被更正掉的旧内容（自 1 起、到 5 为止）。
    insertHistory(store, {
      kind: "record",
      id: "rec-corrected",
      from: 1,
      to: 5,
      payload: record({ id: "rec-corrected", numericValue: 70 })
    });
    store.flush();

    const readAt = (generation: number): CanonicalHealthRecord[] => {
      const reader = openFactsReader(path, generation);
      try {
        return [...reader.records({})];
      } finally {
        reader.close();
      }
    };

    const atOld = readAt(1);
    assert.equal(atOld.length, 1, "G=1 必须恰好返回一条（无混合）");
    assert.equal(atOld[0]!.numericValue, 70, "G=1 必须读到被更正掉的旧内容");

    assert.equal(readAt(4)[0]!.numericValue, 70, "G=4 仍在旧内容的窗口内");

    const atNew = readAt(5);
    assert.equal(atNew.length, 1, "G=5 必须恰好返回一条（无混合）");
    assert.equal(atNew[0]!.numericValue, 80, "G=5 必须读到更正后的新内容");
    assert.equal(readAt(9)[0]!.numericValue, 80, "G=9 之后保持新内容");
  });
});

test("不可见：valid_from_generation 大于 G 的行不得出现", async () => {
  await withStore((store, path) => {
    store.insertRecord(record({ id: "rec-future", numericValue: 99 }), "apple_watch", {});
    setValidFrom(store, "health_records", "rec-future", 10);
    store.flush();

    const readAt = (generation: number): string[] => {
      const reader = openFactsReader(path, generation);
      try {
        return ids(reader.records({}));
      } finally {
        reader.close();
      }
    };

    assert.deepEqual(readAt(5), [], "G=5 时该行尚不可见");
    assert.deepEqual(readAt(9), [], "G=9 时该行尚不可见");
    assert.deepEqual(readAt(10), ["rec-future"], "G=10 起可见");
  });
});

test("边界（刻意限定）：被删除的实体在任何代次下都不可见", async () => {
  // 🔴 这条用例**不是**在断言一个理想语义，而是在把文件头写明的边界钉成可执行语句：
  // §5.2 判据 8 在本实现里**只覆盖 update，不覆盖 delete**。
  // 本仓库的删除路径会物理删掉当前行（database.ts:3086-3087，entity_id 就是 health_records.id），
  // 所以这是真实场景：历史里有完整 payload，但当前表没有行 ⇒ 枚举（以当前表为全集）看不到它。
  //
  // 如果将来有人补上"当前表 ∪ 只存于历史的 id"，这条会变红 —— 那正是提醒他
  // **同时**去更新判据 8 的口径与文件头注释，而不是悄悄改变可见性。
  await withStore((store, path) => {
    store.insertRecord(record({ id: "gone", numericValue: 61 }), "apple_watch", {});
    store.insertRecord(record({ id: "kept", numericValue: 62 }), "apple_watch", {});
    store.flush();
    // 模拟删除路径：只删当前行，历史里留下完整内容。
    store.database.prepare("DELETE FROM health_records WHERE id = 'gone'").run();
    insertHistory(store, {
      kind: "record", id: "gone", from: 1, to: null,
      payload: record({ id: "gone", numericValue: 61 })
    });
    store.flush();

    const reader = openFactsReader(path, 1);
    try {
      assert.deepEqual(ids(reader.records({})), ["kept"],
        "已删除的实体不得出现在任何代次（本实现的口径边界，见文件头）");
      assert.deepEqual(ids(reader.records({ types: ["HKQuantityTypeIdentifierBodyMass"] })), ["kept"]);
    } finally {
      reader.close();
    }
  });
});

test("过滤：types 生效（正例 + 反例）", async () => {
  await withStore((store, path) => {
    store.insertRecord(record({ id: "body-a", type: "HKQuantityTypeIdentifierBodyMass" }), "apple_watch", {});
    store.insertRecord(record({ id: "hr-a", type: "HKQuantityTypeIdentifierHeartRate" }), "apple_watch", {});
    store.flush();

    const reader = openFactsReader(path, 1);
    try {
      assert.deepEqual(ids(reader.records({ types: ["HKQuantityTypeIdentifierBodyMass"] })), ["body-a"]);
      assert.deepEqual(
        ids(reader.records({ types: ["HKQuantityTypeIdentifierBodyMass", "HKQuantityTypeIdentifierHeartRate"] })),
        ["body-a", "hr-a"]
      );
      assert.deepEqual(ids(reader.records({ types: ["HKQuantityTypeIdentifierStepCount"] })), [],
        "不存在的 type 必须返回空，而不是退回全量");
    } finally {
      reader.close();
    }
  });
});

test("过滤：fromAt / toAt 生效（正例 + 反例）", async () => {
  await withStore((store, path) => {
    store.insertRecord(record({
      id: "early", type: "HKQuantityTypeIdentifierBodyMass", startAt: "2026-01-01T00:00:00.000Z"
    }), "apple_watch", {});
    store.insertRecord(record({
      id: "late", type: "HKQuantityTypeIdentifierBodyMass", startAt: "2026-03-01T00:00:00.000Z"
    }), "apple_watch", {});
    store.flush();

    const reader = openFactsReader(path, 1);
    try {
      assert.deepEqual(ids(reader.records({ fromAt: "2026-02-01T00:00:00.000Z" })), ["late"]);
      assert.deepEqual(ids(reader.records({ toAt: "2026-02-01T00:00:00.000Z" })), ["early"]);
      assert.deepEqual(
        ids(reader.records({ fromAt: "2026-01-01T00:00:00.000Z", toAt: "2026-12-31T00:00:00.000Z" })),
        ["early", "late"]
      );
      assert.deepEqual(
        ids(reader.records({ fromAt: "2027-01-01T00:00:00.000Z" })), [],
        "窗口外的记录必须被排除"
      );
    } finally {
      reader.close();
    }
  });
});

test("时间边界不合法必须抛错，而不是静默返回空集", async () => {
  await withStore((store, path) => {
    store.insertRecord(record({
      id: "a-utc", type: "HKQuantityTypeIdentifierBodyMass", startAt: "2026-01-01T00:00:00.000Z"
    }), "apple_watch", {});
    store.flush();

    const reader = openFactsReader(path, 1);
    try {
      // 静默失效形态 1：`julianday()` 解析不了 ⇒ 谓词变成 NULL ⇒ 一行都不返回。
      // 这些值必须抛错 —— 否则调用方看到的是"没有数据"，而不是"参数写错了"。
      for (const bad of ["2026-1-1", "2026/01/01", "20260101", "not a date", ""]) {
        assert.throws(() => reader.records({ fromAt: bad }), /绝对时刻/,
          `${JSON.stringify(bad)} 必须被拒绝而不是静默返回空集`);
      }

      // 静默失效形态 2：只写日期 ⇒ 被按 UTC 午夜解释，静默漏掉本地时区数据。
      assert.throws(() => reader.records({ toAt: "2026-02-01" }), /绝对时刻/,
        "只写日期缺偏移必须被拒绝");
      assert.throws(() => reader.records({ fromAt: "2026-01-01T00:00:00" }), /绝对时刻/,
        "省略偏移必须被拒绝");
      assert.throws(() => reader.workouts({ fromAt: "2026-2-1" }), /绝对时刻/);

      // 日历字段越界（月 13、分钟 60）现在由日历 round-trip 先挡下，报"不存在的时刻"。
      assert.throws(() => reader.records({ toAt: "2026-13-01T00:00:00Z" }), /不存在的时刻/,
        "月份 13 越界");
      assert.throws(() => reader.records({ toAt: "2026-01-01T00:60:00Z" }), /不存在的时刻/,
        "分钟 60 越界");

      // 偏移越界是**只有** `julianday` 真解析能挡住的一类：日历字段全部合法，
      // 但 SQLite 解析不了 ⇒ 谓词变 NULL ⇒ 静默空集。删掉 validateWindow 里的真解析，
      // 这一条会静默返回 []（用突变验证过）。
      assert.throws(() => reader.records({ toAt: "2026-01-01T00:00:00+99:00" }), /无法被 SQLite 解析/,
        "+99:00 偏移越界：日历合法但 SQLite 解析为 NULL，必须被真解析挡住");

      // 第三条静默形态：**能解析但不存在**的时刻会被 SQLite 静默归一化成另一个时刻
      // （2026-02-30 → 03-02、24:00:00 → 次日、非闰年 02-29 → 03-01）。
      // 这比空集更难发现：结果看起来"有数据"，只是落在了别的时间段。
      // 这些值 `julianday()` 非 NULL、正则也匹配，只能靠日历 round-trip 挡。
      for (const bad of [
        "2026-02-30T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-01-01T24:00:00Z",
        "2026-02-29T00:00:00Z"
      ]) {
        assert.throws(() => reader.records({ fromAt: bad }), /不存在的时刻/,
          `${bad} 会被 SQLite 静默归一化成另一个时刻，必须拒绝`);
      }
      // 日历 round-trip 的正面控制：真实存在的边界日期必须被接受。
      // `2024-02-29` 是闰日（若实现写成"见 29 就拒"会被抓住）；
      // `2026-02-28` 是 2026（非闰年）2 月的最后一天；`2026-03-31` 是 31 天的月末。
      assert.deepEqual(ids(reader.records({ fromAt: "2024-02-29T00:00:00Z" })), ["a-utc"],
        "2024-02-29 是真实存在的闰日，不得被误拒（a-utc 在 2026 年，故在其之后）");
      assert.deepEqual(ids(reader.records({ toAt: "2026-02-28T00:00:00Z" })), ["a-utc"],
        "2026-02-28 是 2026 年 2 月的最后一天，必须被接受");
      assert.deepEqual(ids(reader.records({ toAt: "2026-03-31T00:00:00Z" })), ["a-utc"],
        "31 天的月份月末必须被接受");

      // 正面控制：带偏移的写法被接受，并折算成正确的绝对时刻。
      assert.deepEqual(ids(reader.records({ fromAt: "2026-01-01T08:00:00+08:00" })), ["a-utc"],
        "2026-01-01T08:00+08:00 就是 00:00Z，必须包含该行");
      assert.deepEqual(ids(reader.records({ toAt: "2026-01-01T07:59:59+08:00" })), [],
        "01-01T07:59:59+08:00 早于 00:00Z，必须排除（若按 UTC 字面解释会误判为包含）");
    } finally {
      reader.close();
    }
  });
});

test("过滤：workouts 的 fromAt / toAt 生效", async () => {
  await withStore((store, path) => {
    store.insertWorkout(workout({ id: "w-early", startAt: "2026-01-01T06:00:00.000Z" }), "apple_watch", {});
    store.insertWorkout(workout({ id: "w-late", startAt: "2026-03-01T06:00:00.000Z" }), "apple_watch", {});
    store.flush();

    const reader = openFactsReader(path, 1);
    try {
      assert.deepEqual(ids(reader.workouts({})), ["w-early", "w-late"]);
      assert.deepEqual(ids(reader.workouts({ fromAt: "2026-02-01T00:00:00.000Z" })), ["w-late"]);
      assert.deepEqual(ids(reader.workouts({ toAt: "2026-02-01T00:00:00.000Z" })), ["w-early"]);
      assert.deepEqual(ids(reader.workouts({ fromAt: "2027-01-01T00:00:00.000Z" })), []);
    } finally {
      reader.close();
    }
  });
});

test("分块加载：跨页边界不丢行、不重复行", async () => {
  await withStore((store, path) => {
    // CHUNK_SIZE = 500，刻意超过一个分块以真正走一次 keyset 翻页。
    for (let index = 0; index < 1_200; index += 1) {
      store.insertRecord(record({ id: `page-${String(index).padStart(4, "0")}` }), "apple_watch", {});
    }
    store.flush();

    const reader = openFactsReader(path, 1);
    try {
      const seen = [...reader.records({})].map((item) => item.id);
      assert.equal(seen.length, 1_200, "分块翻页不得丢行或重复行");
      assert.equal(new Set(seen).size, 1_200, "分块翻页不得产出重复 id");
    } finally {
      reader.close();
    }
  });
});

test("workouts 与 routeFor 按既有契约返回内容", async () => {
  await withStore((store, path) => {
    store.insertWorkout(workout({
      id: "w-route",
      statistics: [{
        type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        startAt: "2026-01-01T06:00:00.000Z", endAt: "2026-01-01T06:30:00.000Z",
        unit: "km", sum: 5, average: null, minimum: null, maximum: null
      }],
      events: [{ type: "HKWorkoutEventTypePause", date: "2026-01-01T06:10:00.000Z", durationSeconds: 5, metadata: {} }],
      routes: [{
        id: "route-w-route", sourceName: "Watch", sourceVersion: "1",
        startAt: "2026-01-01T06:00:00.000Z", endAt: "2026-01-01T06:30:00.000Z",
        createdAt: null, relativePath: "workout-routes/w-route.gpx", metadata: {}
      }]
    }), "apple_watch", {});
    store.replaceRoutePoints("route-w-route", [routePoint(0, 31.1), routePoint(1, 31.2)]);
    store.insertWorkout(workout({ id: "w-no-route" }), "apple_watch", {});
    store.flush();

    const reader = openFactsReader(path, 1);
    try {
      const stored = [...reader.workouts({})];
      const routed = stored.find((item) => item.id === "w-route")!;
      assert.equal(routed.statistics.length, 1, "统计必须随 workout 一起重建");
      assert.equal(routed.statistics[0]!.sum, 5);
      assert.equal(routed.events.length, 1, "事件必须随 workout 一起重建");
      assert.deepEqual(routed.routes.map((route) => route.id), ["route-w-route"]);

      assert.deepEqual(
        reader.routeFor("w-route")?.map((point) => point.latitude),
        [31.1, 31.2],
        "已发布且非空的路线必须返回其点"
      );
      assert.equal(reader.routeFor("w-no-route"), null, "没有可用轨迹时必须返回 null");
      assert.equal(reader.routeFor("does-not-exist"), null);
    } finally {
      reader.close();
    }
  });
});

// Y2（2026-10-12 审查）：`FactsReader.routeFor()` 与 `RaiDatabase.hasUsableRoute()` 必须对
// **同一行** `workout_routes` 给出同一结论。此前读侧只判 `point_count > 0`、**不看 `file_status`**，
// 两处各写一遍条件，于是同一行能被读侧说成"有轨迹"、被写侧说成"没有"。
//
// ⚠️ 构造方式：直接写库造一行"自相矛盾"的路线（`file_status = 'pending'` 而 `point_count = 2`）。
// 走公开 API 造不出这种行（`markRouteStatus()` 把 `point_count` 一起清零、
// `beginRoutePointReplacement()` 先置 0），但**只有这样一行能把两种实现分开** ——
// 用一行一致的数据去断言，改前改后都绿，等于没测。
test("routeFor 与 hasUsableRoute 对同一行 workout_routes 给同一结论", async () => {
  await withStore((store, path) => {
    const route = (id: string, relativePath: string, startAt: string) => ({
      id,
      sourceName: "Watch",
      sourceVersion: "1",
      startAt,
      endAt: "2026-01-01T06:30:00.000Z",
      createdAt: null,
      relativePath,
      metadata: {}
    });

    // ① 整条 workout 只有一行**不一致**的路线：状态说"没导入"，点数说"有 2 个点"。
    store.insertWorkout(workout({
      id: "w-consensus",
      routes: [route("route-consensus", "workout-routes/consensus.gpx", "2026-01-01T06:00:00.000Z")]
    }), "apple_watch", {});

    // ② 一个 workout 下两行路线：一行正常导入，一行不一致。用来钉住"取数时也要过滤状态"，
    //    而不只是"存在性判断带上状态"。
    store.insertWorkout(workout({
      id: "w-mixed",
      routes: [
        route("route-mixed-ok", "workout-routes/mixed-ok.gpx", "2026-01-01T06:00:00.000Z"),
        route("route-mixed-bad", "workout-routes/mixed-bad.gpx", "2026-01-01T07:00:00.000Z")
      ]
    }), "apple_watch", {});
    // 正常那行走公开 API 导入 ⇒ `file_status = 'imported'`、`point_count = 2`。
    store.replaceRoutePoints("route-mixed-ok", [routePoint(0, 31.1), routePoint(1, 31.2)]);

    // ③ 单行、正常导入的对照：让恒等式两边都有"是"的样本。
    store.insertWorkout(workout({
      id: "w-ok",
      routes: [route("route-ok", "workout-routes/ok.gpx", "2026-01-01T06:00:00.000Z")]
    }), "apple_watch", {});
    store.replaceRoutePoints("route-ok", [routePoint(0, 30.1)]);

    // 不一致那两行直接写库：`point_count > 0` 但 `file_status = 'pending'`，且真有点行。
    const inconsistent = [
      { routeId: "route-consensus", lat: 33.1 },
      { routeId: "route-mixed-bad", lat: 33.2 }
    ];
    for (const item of inconsistent) {
      store.database
        .prepare("UPDATE workout_routes SET point_count = 2, file_status = 'pending' WHERE id = ?")
        .run(item.routeId);
      const insertPoint = store.database.prepare(`
        INSERT INTO route_points
          (route_id, sequence, timestamp, latitude, longitude, elevation_meters, speed_mps,
           course_degrees, horizontal_accuracy_meters, vertical_accuracy_meters)
        VALUES (?, ?, ?, ?, ?, 5, 2.5, NULL, 4, NULL)
      `);
      insertPoint.run(item.routeId, 0, "2026-01-01T06:00:00.000Z", item.lat, 121.1);
      insertPoint.run(item.routeId, 1, "2026-01-01T06:00:01.000Z", item.lat + 0.1, 121.2);
    }
    store.flush();

    const reader = openFactsReader(path, 1);
    try {
      // 显式期望值：只断言"两侧相等"是不够的 —— 两侧一起错成 `true` 也满足等式。
      assert.equal(store.hasUsableRoute("route-consensus"), false,
        "写侧：`pending` 的路线不是可用路线");
      assert.equal(reader.routeFor("w-consensus"), null,
        "读侧：`pending` 的路线不是可用路线（修复前这里会返回 2 个点）");
      assert.equal(store.hasUsableRoute("route-ok"), true, "写侧：正常导入的路线可用");
      assert.deepEqual(reader.routeFor("w-ok")?.map((point) => point.latitude), [30.1],
        "读侧：正常导入的路线必须返回点");

      assert.deepEqual(
        reader.routeFor("w-mixed")?.map((point) => point.latitude),
        [31.1, 31.2],
        "同一 workout 下只拼接**可用**路线的点：不一致那行的点必须被排除"
      );

      // 🔴 恒等式（逐个 workout 核）：`routeFor(W) !== null` ⟺ W **至少有一条**可用路线。
      // 左边是 workout 级、右边是 route 级 —— 两边必须同源才可能恒等。
      // 只比"某一对单个值"是不够的：`w-mixed` 有两条路线，拿它去和单条路线比会把
      // "workout 级有没有"与"这条路线可不可用"混成一个问题（本文件第一版就是这么错的）。
      const workoutRows = store.database.prepare("SELECT id FROM workouts ORDER BY id")
        .all() as unknown as Array<{ id: string }>;
      assert.ok(workoutRows.length >= 3, "前置条件：三个 workout 都要在库里");
      for (const row of workoutRows) {
        const routeIds = (store.database
          .prepare("SELECT id FROM workout_routes WHERE workout_id = ?")
          .all(row.id) as unknown as Array<{ id: string }>).map((item) => item.id);
        assert.equal(
          reader.routeFor(row.id) !== null,
          routeIds.some((routeId) => store.hasUsableRoute(routeId)),
          `workout ${row.id}：routeFor 非 null 必须等价于"它至少有一条可用路线"`
        );
      }
    } finally {
      reader.close();
    }
  });
});

test("历史行优先于当前行：两条规则同时命中时必须用历史 payload", async () => {
  await withStore((store, path) => {
    // 当前行自身在代次 1 上就已可见（valid_from_generation 为 NULL）……
    store.insertRecord(record({ id: "rec-both", numericValue: 80 }), "apple_watch", {});
    // ……同时历史里有一条仍然生效的旧内容。按 §4 的规则，历史行优先。
    // 只测"历史行改写的场景"钉不住优先级：那种场景下当前行本来就不可见，先查谁结果都一样。
    insertHistory(store, {
      kind: "record",
      id: "rec-both",
      from: 1,
      to: null,
      payload: record({ id: "rec-both", numericValue: 70 })
    });
    store.flush();

    const reader = openFactsReader(path, 3);
    try {
      const rows = [...reader.records({})];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.numericValue, 70, "两条规则同时命中时必须返回历史行的 payload");
    } finally {
      reader.close();
    }
  });
});

test("坏 payload 抛错而不是静默回落当前行", async () => {
  await withStore((store, path) => {
    store.insertRecord(record({ id: "rec-corrupt", numericValue: 80 }), "apple_watch", {});
    store.database
      .prepare(`
        INSERT INTO import_fact_history
          (entity_kind, entity_id, valid_from_generation, valid_to_generation,
           content_hash, effective_at, available_at, payload_json)
        VALUES ('record', 'rec-corrupt', 1, NULL, 'hash', NULL, NULL, '{not json')
      `)
      .run();
    store.flush();

    const reader = openFactsReader(path, 3);
    try {
      assert.throws(() => [...reader.records({})], /不是合法 JSON/,
        "历史行存在时坏 payload 必须抛错，不能悄悄换成当前行");
    } finally {
      reader.close();
    }
  });
});

test("close() 幂等，且关闭后调用读取方法抛错而不是静默返回空", async () => {
  await withStore((store, path) => {
    store.insertRecord(record({ id: "rec-close" }), "apple_watch", {});
    store.flush();

    const reader = openFactsReader(path, 1);
    assert.deepEqual(ids(reader.records({})), ["rec-close"]);
    reader.close();
    reader.close(); // 幂等：第二次 close() 不得抛错

    assert.throws(() => reader.records({}), /已关闭/, "records() 在关闭后必须抛错");
    assert.throws(() => reader.workouts({}), /已关闭/, "workouts() 在关闭后必须抛错");
    assert.throws(() => reader.routeFor("rec-close"), /已关闭/, "routeFor() 在关闭后必须抛错");
  });
});

test("openFactsReader 拒绝非法代次", () => {
  assert.throws(() => openFactsReader("/tmp/does-not-matter.sqlite", -1), /非负整数/);
  assert.throws(() => openFactsReader("/tmp/does-not-matter.sqlite", 1.5), /非负整数/);
});
