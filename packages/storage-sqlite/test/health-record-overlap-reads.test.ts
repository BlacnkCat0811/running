import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Worker } from "node:worker_threads";

import {
  HEALTH_RECORD_TEXT_OVERLAP_SLACK_MS,
  HEALTH_RECORD_TIME_SLACK_MS,
  buildBoundedHealthRecordOverlapQuery,
  shiftedIsoBound,
  buildLegacyHealthRecordOverlapQuery,
  buildLegacyHealthRecordPureOverlapQuery,
  probeHealthRecordOverlapTimeline,
  type HealthRecordOverlapQueryInput
} from "../src/read/read-utils.js";
import {
  HealthRecordDurationCache,
  healthRecordDurationCache,
  readHealthRecordOverlap,
  readHealthRecordOverlapDatabaseState,
  readHealthRecordOverlapStats
} from "../src/read/health-record-overlap-reads.js";
import { HealthRecordOverlapStatsWorker } from "../src/read/health-record-stats-worker.js";

// 2026-10-18（复查 P2）：`metricIntervals` / `averageRawMetric` / `averageCadence` 的回退读
// 改成"按该 type 最长记录时长有界"的计划（bounded），替代上一轮按窗口位置二选一的自适应
// —— 后者的中段窗口无论如何都要走约半段历史（B-tree 固有下界）。
//
// 本文件守四件事：
//   1. bounded 与历史谓词**逐行等价**（±HH:MM 遗留文本、24h 长记录、malformed、零长、
//      重复、窗口起止边界、完全在窗口外），且两种谓词族都覆盖；
//   2. 最长时长缓存在**外部提交**（data_version）与**本连接写**（total_changes）时都失效；
//   3. 拿不到有界证据（缺索引 / D 病态大 / 时间戳不可解析）时退回自适应形状，仍然精确；
//   4. EXPLAIN 守卫：bounded 走 `start_at` 双端索引区间，绝不出现 `SCAN health_records`。

const HEART_RATE = "HKQuantityTypeIdentifierHeartRate";
const STEPS = "HKQuantityTypeIdentifierStepCount";
const SOURCE = "Watch";

const SCHEMA = `
  CREATE TABLE health_records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_category TEXT NOT NULL,
    source_version TEXT,
    device TEXT,
    unit TEXT,
    value_numeric REAL,
    value_text TEXT,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    created_at TEXT,
    metadata_json TEXT NOT NULL,
    raw_attributes_json TEXT NOT NULL
  );
`;
const INDEXES = `
  CREATE INDEX idx_health_records_type_time ON health_records(type, start_at, end_at);
  CREATE INDEX idx_health_records_source_time ON health_records(source_name, start_at, end_at);
  CREATE INDEX idx_health_records_type_end ON health_records(type, end_at, start_at);
`;

const utc = (milliseconds: number): string => new Date(milliseconds).toISOString();
/** 写成带固定偏移的本地时间文本（模拟 legacy 行）；`offsetMinutes` 为相对 UTC 的分钟数。 */
const offsetText = (milliseconds: number, offsetMinutes: number): string => {
  const shifted = new Date(milliseconds + offsetMinutes * 60_000).toISOString().replace("Z", "");
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${shifted}${sign}${hours}:${minutes}`;
};

interface RecordSeed {
  readonly type?: string;
  readonly sourceName?: string;
  readonly value: number;
  readonly start: string;
  readonly end: string;
  readonly unit?: string;
}

function openDatabase(options: { indexes?: boolean; path?: string } = {}): DatabaseSync {
  const database = new DatabaseSync(options.path ?? ":memory:");
  database.exec(SCHEMA);
  if (options.indexes !== false) database.exec(INDEXES);
  return database;
}

function seed(database: DatabaseSync, records: readonly RecordSeed[]): void {
  const insert = database.prepare(`
    INSERT INTO health_records
      (id, type, source_name, source_category, unit, value_numeric, start_at, end_at,
       metadata_json, raw_attributes_json)
    VALUES (?, ?, ?, 'apple_watch', ?, ?, ?, ?, '{}', '{}')
  `);
  database.exec("BEGIN");
  try {
    records.forEach((record, index) => {
      insert.run(
        `test-${index}-${record.type ?? HEART_RATE}-${record.start}-${record.end}-${record.value}`,
        record.type ?? HEART_RATE,
        record.sourceName ?? SOURCE,
        record.unit ?? "bpm",
        record.value,
        record.start,
        record.end
      );
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const input = (overrides: Partial<HealthRecordOverlapQueryInput> = {}): HealthRecordOverlapQueryInput => ({
  type: HEART_RATE,
  sourceName: SOURCE,
  startedAt: "2023-06-01T00:00:00.000Z",
  endedAt: "2023-06-01T01:00:00.000Z",
  columns: ["start_at", "end_at", "value_numeric", "unit"],
  ...overrides
});

const DAY = 86_400_000;

/** `julianday` 差值是 binary64，允许 <2ms 的浮点漂移（生产上远小于 24h 余量）。 */
const assertDuration = (actual: number | null, expected: number, label: string): void => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 2, `${label}: actual=${String(actual)} expected=${expected}`);
};
const BASE = Date.parse("2023-01-01T00:00:00.000Z");
const WINDOWS = {
  oldest: { startedAt: utc(BASE), endedAt: utc(BASE + 3_600_000) },
  middle: { startedAt: utc(BASE + 365 * DAY), endedAt: utc(BASE + 365 * DAY + 3_600_000) },
  recent: { startedAt: utc(BASE + 729 * DAY), endedAt: utc(BASE + 729 * DAY + 3_600_000) }
} as const;

/**
 * 在三个窗口各自周围放一组边界行：跨起点长记录（24h，成为该 type 的最大时长）、
 * 零长、malformed、±HH:MM 偏移文本、压在起止边界、窗口外、重复行。
 */
function seedAdversarialWindows(database: DatabaseSync, type: string): void {
  const records: RecordSeed[] = [];
  let value = 1;
  for (const window of Object.values(WINDOWS)) {
    const start = Date.parse(window.startedAt);
    const end = Date.parse(window.endedAt);
    records.push(
      { type, value: value++, start: utc(start + 60_000), end: utc(start + 120_000) },          // 窗口内
      { type, value: value++, start: utc(start - 30 * 60_000), end: utc(start + 10 * 60_000) }, // 跨起点
      { type, value: value++, start: utc(start - 24 * 3_600_000), end: utc(start + 5 * 60_000) }, // 最长（≈24h）
      { type, value: value++, start: utc(start), end: utc(start) },                             // 零长，压在起点
      { type, value: value++, start: utc(start + 10 * 60_000), end: utc(start + 5 * 60_000) },  // malformed
      { type, value: value++, start: offsetText(start + 20 * 60_000, -300), end: offsetText(start + 21 * 60_000, -300) },
      { type, value: value++, start: offsetText(start + 25 * 60_000, 840), end: offsetText(start + 26 * 60_000, 840) },
      { type, value: value++, start: utc(end - 1), end: utc(end + 60_000) },                    // 起点在窗口末端
      { type, value: value++, start: utc(end), end: utc(end + 60_000) },                        // 起点恰在终点：排除
      { type, value: value++, start: utc(end + 60_000), end: utc(end + 120_000) },              // 完全在窗口外
      { type, value: value++, start: utc(start - 2 * 3_600_000), end: utc(start - 3_600_000) }  // 窗口前已结束
    );
    // 重复行：同 (start, end, value, unit) 只出现一次。
    records.push({ type, value: 900, start: utc(start + 60_000), end: utc(start + 120_000) });
    records.push({ type, value: 900, start: utc(start + 60_000), end: utc(start + 120_000) });
  }
  seed(database, records);
}

/** 参考实现：历史谓词逐字恢复（`buildLegacy…` 已被单独差分证明与最初实现等价）。 */
const referenceRows = (
  database: DatabaseSync,
  queryInput: HealthRecordOverlapQueryInput
): Record<string, unknown>[] => {
  const legacy = queryInput.predicate === "pureOverlap"
    ? buildLegacyHealthRecordPureOverlapQuery(queryInput)
    : buildLegacyHealthRecordOverlapQuery(queryInput);
  return database.prepare(legacy.sql).all(...legacy.params) as unknown as Record<string, unknown>[];
};

/**
 * Production read no longer rebuilds stats on a miss (B). Tests that intend to
 * exercise the bounded path must explicitly prepare stats for the current
 * snapshot — exactly the contract described in the follow-up plan §5.2.
 */
const primeCache = (database: DatabaseSync, type = HEART_RATE): HealthRecordDurationCache => {
  const cache = new HealthRecordDurationCache();
  cache.lookup(database, type);
  return cache;
};

test("bounded plan matches the historical predicate row-for-row at every window position", () => {
  const database = openDatabase();
  try {
    seedAdversarialWindows(database, HEART_RATE);
    const cache = primeCache(database);
    for (const window of Object.values(WINDOWS)) {
      const queryInput = input(window);
      const result = readHealthRecordOverlap(database, queryInput, { cache });
      assert.equal(result.shape, "bounded", "有 D 且索引齐全时必须走有界计划");
      assert.deepEqual(result.rows, referenceRows(database, queryInput), JSON.stringify(window));
      // 24h 跨起点长记录必须仍在（这正是"最早可能相交"的行，最容易被下界误排除）。
      const longRow = result.rows.find((row) => row.value_numeric === 3 || row.value_numeric === 14 || row.value_numeric === 25);
      assert.ok(longRow, `跨起点长记录必须保留：${JSON.stringify(window)}`);
    }
  } finally {
    database.close();
  }
});

test("bounded plan matches the text-only (cadence) predicate row-for-row", () => {
  const database = openDatabase();
  try {
    seedAdversarialWindows(database, STEPS);
    const cache = primeCache(database, STEPS);
    for (const window of Object.values(WINDOWS)) {
      const queryInput = input({
        ...window,
        type: STEPS,
        columns: ["start_at", "end_at", "value_numeric"],
        predicate: "pureOverlap"
      });
      const result = readHealthRecordOverlap(database, queryInput, { cache });
      assert.equal(result.shape, "bounded");
      assert.deepEqual(result.rows, referenceRows(database, queryInput), JSON.stringify(window));
    }
  } finally {
    database.close();
  }
});

test("bounded plan stays exact when windows are far outside the probed timeline", () => {
  const database = openDatabase();
  try {
    seedAdversarialWindows(database, HEART_RATE);
    // 窗口整段早于时间轴 / 整段晚于时间轴：下界与上界都失效，结果应为空。
    for (const window of [
      { startedAt: utc(BASE - 100 * DAY), endedAt: utc(BASE - 100 * DAY + 3_600_000) },
      { startedAt: utc(BASE + 1_000 * DAY), endedAt: utc(BASE + 1_000 * DAY + 3_600_000) }
    ]) {
      const queryInput = input(window);
      assert.deepEqual(readHealthRecordOverlap(database, queryInput).rows, []);
      assert.deepEqual(referenceRows(database, queryInput), []);
    }
  } finally {
    database.close();
  }
});

test("exactly one max-duration probe per type until data changes (same connection)", () => {
  const database = openDatabase();
  try {
    seed(database, [
      { value: 1, start: utc(BASE + 60_000), end: utc(BASE + 120_000) },
      { value: 2, start: utc(BASE + 365 * DAY), end: utc(BASE + 365 * DAY + 24 * 3_600_000) }
    ]);
    assertDuration(readHealthRecordOverlapStats(database, HEART_RATE).maxDurationMs, 24 * 3_600_000, "24h max duration");
    assert.equal(readHealthRecordOverlapStats(database, HEART_RATE).hasNonCanonicalTimestamps, false, "定宽 UTC 行");
    assert.equal(readHealthRecordOverlapStats(database, "missing-type").maxDurationMs, null);

    const state = readHealthRecordOverlapDatabaseState(database);
    assert.ok(Number.isFinite(state.dataVersion));
    assert.ok(Number.isFinite(state.totalChanges));

    // 同连接写入：`total_changes` 变化必须让 D 缓存失效（`data_version` 对自己写不敏感）。
    const cache = new HealthRecordDurationCache();
    const before = cache.lookup(database, HEART_RATE);
    assertDuration(before.stats.maxDurationMs, 24 * 3_600_000, "cached max duration");
    seed(database, [{ value: 3, start: utc(BASE + 400 * DAY), end: utc(BASE + 403 * DAY) }]);
    const after = cache.lookup(database, HEART_RATE);
    assertDuration(after.stats.maxDurationMs, 3 * DAY, "同连接写入后必须重算：3 天 > 24 小时");
  } finally {
    database.close();
  }
});

test("an invalidated cache falls back to the exact adaptive shape and still sees a longer same-connection record", () => {
  const database = openDatabase();
  try {
    const window = { startedAt: utc(BASE + 100 * DAY), endedAt: utc(BASE + 100 * DAY + 3_600_000) };
    seed(database, [
      // 撑开 source 时间轴：有界计划的宽度守卫按 source span 判断，短库会退回自适应。
      { value: 0, start: utc(BASE - 600 * DAY), end: utc(BASE - 600 * DAY + 60_000) },
      { value: 1, start: utc(BASE + 99 * DAY), end: utc(BASE + 99 * DAY + 60_000) },
      { value: 2, start: utc(BASE + 100 * DAY + 60_000), end: utc(BASE + 100 * DAY + 120_000) }
    ]);
    const cache = primeCache(database);
    const first = readHealthRecordOverlap(database, input(window), { cache });
    assert.equal(first.shape, "bounded");
    assert.deepEqual(first.rows.map((row) => row.value_numeric), [2]);

    // 新长记录：起点在窗口前 2.5 天、终点在窗口内。旧 D（1 分钟）会把它排除在下界之外。
    seed(database, [{
      value: 3,
      start: utc(BASE + 100 * DAY - 2.5 * DAY),
      end: utc(BASE + 100 * DAY + 30 * 60_000)
    }]);
    const second = readHealthRecordOverlap(database, input(window), { cache });
    assert.notEqual(second.shape, "bounded", "stats 缓存失效后不得同步重建，直接走精确自适应形状");
    assert.deepEqual(second.rows, referenceRows(database, input(window)), "写入后必须与历史谓词一致");
    assert.ok(second.rows.some((row) => row.value_numeric === 3), "新增长记录必须被读到");
  } finally {
    database.close();
  }
});

test("an invalidated cache falls back to the exact adaptive shape after another connection commits", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-overlap-foreign-"));
  const path = join(root, "rai.sqlite");
  const writer = openDatabase({ path });
  let reader: DatabaseSync | null = null;
  try {
    const window = { startedAt: utc(BASE + 200 * DAY), endedAt: utc(BASE + 200 * DAY + 3_600_000) };
    seed(writer, [
      { value: 0, start: utc(BASE - 600 * DAY), end: utc(BASE - 600 * DAY + 60_000) },
      { value: 1, start: window.startedAt, end: utc(Date.parse(window.startedAt) + 60_000) }
    ]);
    reader = new DatabaseSync(path, { readOnly: true });
    const cache = primeCache(reader);
    const first = readHealthRecordOverlap(reader, input(window), { cache });
    assert.equal(first.shape, "bounded");
    assert.equal(first.rows.length, 1);

    seed(writer, [{
      value: 2,
      start: utc(BASE + 200 * DAY - 2 * DAY),
      end: utc(BASE + 200 * DAY + 30 * 60_000)
    }]);
    const state = readHealthRecordOverlapDatabaseState(reader);
    assert.equal(state.totalChanges, 0, "只读连接的 total_changes 恒为 0");

    const second = readHealthRecordOverlap(reader, input(window), { cache });
    assert.notEqual(second.shape, "bounded", "外部提交后不得同步重建全类型统计");
    assert.ok(second.rows.some((row) => row.value_numeric === 2), "外部提交后 data_version 必须让 D 失效");
    assert.deepEqual(second.rows, referenceRows(reader, input(window)));
  } finally {
    reader?.close();
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("duration cache: state and type identity both gate the cached probe", () => {
  const database = openDatabase();
  let state = { dataVersion: 1, totalChanges: 0 };
  let probes = 0;
  try {
    const cache = new HealthRecordDurationCache(() => state, () => {
      probes += 1;
      return { maxDurationMs: 60_000, hasNonCanonicalTimestamps: false };
    });
    assert.equal(cache.lookup(database, HEART_RATE).stats.maxDurationMs, 60_000);
    assert.equal(cache.lookup(database, HEART_RATE).stats.maxDurationMs, 60_000);
    assert.equal(probes, 1, "同一状态同一 type 只探测一次");
    assert.equal(cache.lookup(database, STEPS).stats.maxDurationMs, 60_000);
    assert.equal(probes, 2, "不同 type 分开缓存");

    state = { dataVersion: 2, totalChanges: 0 };
    cache.lookup(database, HEART_RATE);
    assert.equal(probes, 3, "data_version 变化必须重算");
    state = { dataVersion: 2, totalChanges: 7 };
    cache.lookup(database, HEART_RATE);
    assert.equal(probes, 4, "total_changes 变化必须重算");
    cache.invalidate(database, HEART_RATE);
    cache.lookup(database, HEART_RATE);
    assert.equal(probes, 5, "显式失效后重算");
  } finally {
    database.close();
  }
});

test("fallbacks stay exact: pathological D, missing indexes and unparseable timestamps", () => {
  // 1) D 病态大（一条记录跨越大半时间轴）⇒ bounded 关闭，退回 split / legacy。
  const pathological = openDatabase();
  try {
    seed(pathological, [
      { value: 1, start: utc(BASE), end: utc(BASE + 600 * DAY) },
      { value: 2, start: utc(BASE + 500 * DAY), end: utc(BASE + 500 * DAY + 60_000) }
    ]);
    const window = { startedAt: utc(BASE + 500 * DAY), endedAt: utc(BASE + 500 * DAY + 3_600_000) };
    const queryInput = input(window);
    const timeline = probeHealthRecordOverlapTimeline(pathological, SOURCE, HEART_RATE);
    assert.equal(
      buildBoundedHealthRecordOverlapQuery(queryInput, { maxDurationMs: 600 * DAY, hasNonCanonicalTimestamps: false, timeline }),
      null,
      "有界区间超过时间轴一半时不应使用 bounded"
    );
    const result = readHealthRecordOverlap(pathological, queryInput);
    assert.equal(result.shape, "split");
    assert.deepEqual(result.rows, referenceRows(pathological, queryInput));
  } finally {
    pathological.close();
  }

  // 2) 缺索引（裸测试表）：bounded 关闭，自适应形状仍然返回正确行。
  const bare = openDatabase({ indexes: false });
  try {
    seedAdversarialWindows(bare, HEART_RATE);
    const queryInput = input(WINDOWS.middle);
    const result = readHealthRecordOverlap(bare, queryInput);
    assert.equal(result.shape, "split");
    assert.deepEqual(result.rows, referenceRows(bare, queryInput));
  } finally {
    bare.close();
  }

  // 3) 该 type 只有不可解析时间戳：D 为 null（MAX 忽略 NULL），退回自适应仍精确
  //    （文本谓词的 A 分支仍可能命中这类行，参考实现按历史谓词计算）。
  const invalid = openDatabase();
  const invalidType = "HKQuantityTypeIdentifierRunningPower";
  try {
    seed(invalid, [{ type: invalidType, value: 1, start: "not-a-time", end: "also-not-a-time" }]);
    assert.equal(readHealthRecordOverlapStats(invalid, invalidType).maxDurationMs, null);
    assert.equal(readHealthRecordOverlapStats(invalid, invalidType).hasNonCanonicalTimestamps, true, "不可解析时间戳属于非规范行");
    const queryInput = input({ type: invalidType });
    assert.deepEqual(readHealthRecordOverlap(invalid, queryInput).rows, referenceRows(invalid, queryInput));
  } finally {
    invalid.close();
  }
});

test("bounded plan EXPLAIN uses a bounded start_at range, never a full table scan", () => {
  const database = openDatabase();
  try {
    seedAdversarialWindows(database, HEART_RATE);
    const queryInput = input(WINDOWS.middle);
    const timeline = probeHealthRecordOverlapTimeline(database, SOURCE, HEART_RATE);
    const stats = readHealthRecordOverlapStats(database, HEART_RATE);
    const bounded = buildBoundedHealthRecordOverlapQuery(queryInput, {
      maxDurationMs: stats.maxDurationMs!,
      hasNonCanonicalTimestamps: stats.hasNonCanonicalTimestamps,
      timeline
    });
    assert.ok(bounded, "应该能构造有界计划");
    const plan = (database.prepare(`EXPLAIN QUERY PLAN ${bounded.sql}`).all(...bounded.params) as Array<{ detail: string }>)
      .map((row) => row.detail).join("\n");
    assert.match(plan, /USING (COVERING )?INDEX idx_health_records_(source_time|type_time)/, plan);
    assert.match(plan, /start_at>\? AND start_at<\?/, plan);
    assert.doesNotMatch(plan, /SCAN health_records(?!_)/, plan);
  } finally {
    database.close();
  }
});

test("bounded builder requires a usable source timeline and parseable window text", () => {
  const database = openDatabase();
  try {
    seedAdversarialWindows(database, HEART_RATE);
    const timeline = probeHealthRecordOverlapTimeline(database, SOURCE, HEART_RATE);
    const queryInput = input();
    assert.equal(
      buildBoundedHealthRecordOverlapQuery(queryInput, { maxDurationMs: 60_000, hasNonCanonicalTimestamps: false, timeline: { ...timeline, sourceTimeIndexAvailable: false } }),
      null,
      "缺 source_time seek 时不得使用 bounded"
    );
    assert.equal(
      buildBoundedHealthRecordOverlapQuery(queryInput, { maxDurationMs: 60_000, hasNonCanonicalTimestamps: false, timeline: { ...timeline, typeTimeIndexAvailable: false, typeEndIndexAvailable: false } }),
      null,
      "没有覆盖索引做最长时长探测时不得使用 bounded"
    );
    assert.equal(
      buildBoundedHealthRecordOverlapQuery(
        { ...queryInput, startedAt: "not-a-time" },
        { maxDurationMs: 60_000, hasNonCanonicalTimestamps: false, timeline }
      ),
      null,
      "窗口起点不可解析时不得使用 bounded"
    );
    assert.equal(buildBoundedHealthRecordOverlapQuery(queryInput, { maxDurationMs: Number.NaN, hasNonCanonicalTimestamps: false, timeline }), null);
  } finally {
    database.close();
  }
});

test("shared production cache does not leak between databases", () => {
  const first = openDatabase();
  const second = openDatabase();
  try {
    seed(first, [{ value: 1, start: utc(BASE + 60_000), end: utc(BASE + 120_000) }]);
    seed(second, [{ value: 2, start: utc(BASE + 60_000), end: utc(BASE + 5 * DAY) }]);
    // 同一个全局缓存实例按数据库对象分片：两个库的 D 必须各自正确。
    assertDuration(healthRecordDurationCache.lookup(first, HEART_RATE).stats.maxDurationMs, 60_000, "first db");
    assertDuration(healthRecordDurationCache.lookup(second, HEART_RATE).stats.maxDurationMs, 5 * DAY - 60_000, "second db");
  } finally {
    first.close();
    second.close();
  }
});

test("bounded slack constants are conservative for legacy offset text", () => {
  // 纯文本谓词用 48h 余量（两端偏移差最多 28h），julianday 谓词用 24h（单端偏移最多 14h）。
  assert.equal(HEALTH_RECORD_TEXT_OVERLAP_SLACK_MS, 48 * 3_600_000);
  assert.ok(HEALTH_RECORD_TEXT_OVERLAP_SLACK_MS > 28 * 3_600_000);
});

test("bounded lower bound pays offset slack only when the type has non-canonical timestamps", () => {
  const DAY_MS = DAY;
  const window = { startedAt: utc(BASE + 120 * DAY), endedAt: utc(BASE + 120 * DAY + 3_600_000) };
  const maxDurationMs = 6 * 3_600_000;

  const canonical = openDatabase();
  try {
    seed(canonical, [
      { value: 1, start: utc(BASE - 600 * DAY), end: utc(BASE - 600 * DAY + 60_000) },
      { value: 2, start: utc(BASE + 120 * DAY), end: utc(BASE + 120 * DAY + 60_000) }
    ]);
    const stats = readHealthRecordOverlapStats(canonical, HEART_RATE);
    assert.equal(stats.hasNonCanonicalTimestamps, false);
    const timeline = probeHealthRecordOverlapTimeline(canonical, SOURCE, HEART_RATE);
    const queryInput = input(window);
    const bounded = buildBoundedHealthRecordOverlapQuery(queryInput, {
      maxDurationMs, hasNonCanonicalTimestamps: false, timeline
    });
    assert.ok(bounded);
    assert.deepEqual(
      bounded.params,
      [HEART_RATE, SOURCE, window.endedAt, shiftedIsoBound(window.startedAt, -maxDurationMs), window.startedAt, window.startedAt],
      "规范行：文本序 == 时间序，下界不需要偏移余量"
    );

    // 规范行的纯文本谓词同样不需要 48h 余量，且结果与历史谓词逐行一致。
    queryInput.predicate = "pureOverlap";
    const pureBounded = buildBoundedHealthRecordOverlapQuery(queryInput, {
      maxDurationMs, hasNonCanonicalTimestamps: false, timeline
    });
    assert.ok(pureBounded);
    assert.deepEqual(
      pureBounded.params,
      [HEART_RATE, SOURCE, window.endedAt, shiftedIsoBound(window.startedAt, -maxDurationMs), window.startedAt],
      "规范行的纯文本谓词也不加余量"
    );
    assert.deepEqual(readHealthRecordOverlap(canonical, input(window)).rows, referenceRows(canonical, input(window)));
  } finally {
    canonical.close();
  }

  const legacy = openDatabase();
  try {
    seed(legacy, [
      { value: 1, start: utc(BASE - 600 * DAY), end: utc(BASE - 600 * DAY + 60_000) },
      { value: 2, start: offsetText(BASE + 120 * DAY, -300), end: offsetText(BASE + 120 * DAY + 60_000, -300) }
    ]);
    const stats = readHealthRecordOverlapStats(legacy, HEART_RATE);
    assert.equal(stats.hasNonCanonicalTimestamps, true, "偏移行必须被识别为非规范");
    const timeline = probeHealthRecordOverlapTimeline(legacy, SOURCE, HEART_RATE);
    const bounded = buildBoundedHealthRecordOverlapQuery(input(window), {
      maxDurationMs, hasNonCanonicalTimestamps: true, timeline
    });
    assert.ok(bounded);
    assert.equal(bounded.params[3], shiftedIsoBound(window.startedAt, -(maxDurationMs + HEALTH_RECORD_TIME_SLACK_MS)),
      "非规范行：加 24h 余量");

    const pureBounded = buildBoundedHealthRecordOverlapQuery(input({ ...window, predicate: "pureOverlap" }), {
      maxDurationMs, hasNonCanonicalTimestamps: true, timeline
    });
    assert.ok(pureBounded);
    assert.equal(pureBounded.params[3], shiftedIsoBound(window.startedAt, -(maxDurationMs + HEALTH_RECORD_TEXT_OVERLAP_SLACK_MS)),
      "非规范行的纯文本谓词：加 48h 余量");
    // 两种语义在偏移行上都仍然与历史谓词逐行一致。
    assert.deepEqual(readHealthRecordOverlap(legacy, input(window)).rows, referenceRows(legacy, input(window)));
    assert.deepEqual(
      readHealthRecordOverlap(legacy, input({ ...window, predicate: "pureOverlap" })).rows,
      referenceRows(legacy, input({ ...window, predicate: "pureOverlap" }))
    );
  } finally {
    legacy.close();
  }
  assert.ok(DAY_MS > 0);
});

test("tryLookupValid never rebuilds stats after invalidation", () => {
  const database = openDatabase();
  let statsReads = 0;
  try {
    const cache = new HealthRecordDurationCache(undefined, (db, type) => {
      statsReads += 1;
      return readHealthRecordOverlapStats(db, type);
    });
    seed(database, [
      { value: 0, start: utc(BASE - 600 * DAY), end: utc(BASE - 600 * DAY + 60_000) },
      { value: 1, start: utc(BASE + 60_000), end: utc(BASE + 120_000) }
    ]);
    cache.lookup(database, HEART_RATE);
    assert.equal(statsReads, 1);
    const prime = readHealthRecordOverlap(database, input({ startedAt: utc(BASE), endedAt: utc(BASE + 3_600_000) }), { cache });
    assert.equal(prime.shape, "bounded");
    assert.equal(statsReads, 1);

    seed(database, [{ value: 2, start: utc(BASE + 90_000), end: utc(BASE + 180_000) }]);
    const after = readHealthRecordOverlap(database, input({ startedAt: utc(BASE), endedAt: utc(BASE + 3_600_000) }), { cache });
    assert.notEqual(after.shape, "bounded");
    assert.equal(statsReads, 1, "invalidated cache must not rebuild stats inside the request");
    assert.deepEqual(after.rows, referenceRows(database, input({ startedAt: utc(BASE), endedAt: utc(BASE + 3_600_000) })));
    assert.equal(cache.tryLookupValid(database, HEART_RATE), null, "stale entry is removed, not returned");
    assert.equal(statsReads, 1, "a second miss also does not scan");
  } finally {
    database.close();
  }
});

test("tryLookupValid returns only cache entries whose connection state still matches", () => {
  const database = openDatabase();
  let state = { dataVersion: 7, totalChanges: 0 };
  let probes = 0;
  try {
    const cache = new HealthRecordDurationCache(() => state, () => {
      probes += 1;
      return { maxDurationMs: 60_000, hasNonCanonicalTimestamps: false };
    });
    assert.equal(cache.tryLookupValid(database, HEART_RATE), null, "empty cache is a miss");
    assert.equal(probes, 0, "miss does not read stats");
    cache.lookup(database, HEART_RATE);
    assert.equal(probes, 1);
    assert.equal(cache.tryLookupValid(database, HEART_RATE)?.stats.maxDurationMs, 60_000);
    assert.equal(probes, 1, "a valid hit does not read stats");

    state = { dataVersion: 8, totalChanges: 0 };
    assert.equal(cache.tryLookupValid(database, HEART_RATE), null, "data_version change invalidates");
    assert.equal(probes, 1);
    assert.equal(cache.tryLookupValid(database, HEART_RATE), null, "evicted entry stays absent");
    assert.equal(probes, 1);
  } finally {
    database.close();
  }
});

test("a commit between the cache check and the bounded query discards the unprovable result", () => {
  const database = openDatabase();
  try {
    const window = { startedAt: utc(BASE + 100 * DAY), endedAt: utc(BASE + 100 * DAY + 3_600_000) };
    seed(database, [
      { value: 0, start: utc(BASE - 600 * DAY), end: utc(BASE - 600 * DAY + 60_000) },
      { value: 1, start: window.startedAt, end: utc(Date.parse(window.startedAt) + 60_000) }
    ]);
    const cache = primeCache(database);
    const first = readHealthRecordOverlap(database, input(window), { cache });
    assert.equal(first.shape, "bounded");

    // 模拟“缓存 check 之后、bounded 查询之前”另一连接提交：把写入塞进
    // tryLookupValid 的返回路径，下一次状态核对必须看到 total_changes 变化。
    class RacingCache extends HealthRecordDurationCache {
      override tryLookupValid(db: DatabaseSync, type: string) {
        const result = super.tryLookupValid(db, type);
        if (result !== null) {
          seed(db, [{ value: 2, start: utc(BASE + 100 * DAY - 2 * DAY), end: utc(BASE + 100 * DAY + 30 * 60_000) }]);
        }
        return result;
      }
    }
    const racing = new RacingCache();
    racing.lookup(database, HEART_RATE);
    const second = readHealthRecordOverlap(database, input(window), { cache: racing });
    assert.notEqual(second.shape, "bounded", "state changed after the cache check; bounded is unprovable");
    assert.deepEqual(second.rows, referenceRows(database, input(window)));
    assert.ok(second.rows.some((row) => row.value_numeric === 2));
  } finally {
    database.close();
  }
});

test("request-external worker primes bounded stats without blocking the miss", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-overlap-worker-"));
  const path = join(root, "rai.sqlite");
  const database = openDatabase({ path });
  const cache = new HealthRecordDurationCache();
  const worker = new HealthRecordOverlapStatsWorker(path, database, cache);
  try {
    seed(database, [
      { value: 0, start: utc(BASE - 600 * DAY), end: utc(BASE - 600 * DAY + 60_000) },
      { value: 1, start: utc(BASE + 60_000), end: utc(BASE + 120_000) }
    ]);
    const window = { startedAt: utc(BASE), endedAt: utc(BASE + 3_600_000) };
    const first = readHealthRecordOverlap(database, input(window), { cache });
    assert.notEqual(first.shape, "bounded", "first miss uses exact adaptive query");
    const deadline = Date.now() + 5000;
    while (cache.tryLookupValid(database, HEART_RATE) === null && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.notEqual(cache.tryLookupValid(database, HEART_RATE), null, "worker installed stats for the current state");
    const second = readHealthRecordOverlap(database, input(window), { cache });
    assert.equal(second.shape, "bounded", "the next request can use the bounded plan again");
    assert.deepEqual(second.rows, referenceRows(database, input(window)));

    const state = readHealthRecordOverlapDatabaseState(database);
    seed(database, [{ value: 2, start: utc(BASE + 90_000), end: utc(BASE + 180_000) }]);
    assert.equal(cache.prime(database, HEART_RATE, state, { maxDurationMs: 1, hasNonCanonicalTimestamps: false }), false,
      "a result computed for an older connection state must be rejected");
  } finally {
    worker.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class HeldStatsWorker extends EventEmitter {
  readonly messages: Array<Record<string, unknown>> = [];
  postMessage(message: Record<string, unknown>): void { this.messages.push(message); }
  terminate(): Promise<number> { return Promise.resolve(0); }
}

const asStatsWorker = (worker: HeldStatsWorker): Worker => worker as unknown as Worker;

async function waitForStats<T>(read: () => T | null, message: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
  throw new Error(message);
}

test("a late exit/message from the previous stats worker cannot clear or overwrite the replacement job", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-overlap-worker-generation-"));
  const path = join(root, "rai.sqlite");
  const database = openDatabase({ path });
  const cache = new HealthRecordDurationCache();
  const workers: HeldStatsWorker[] = [];
  const worker = new HealthRecordOverlapStatsWorker(
    path,
    database,
    cache,
    () => {
      const fake = new HeldStatsWorker();
      workers.push(fake);
      return asStatsWorker(fake);
    }
  );
  try {
    const state = readHealthRecordOverlapDatabaseState(database);
    worker.request(HEART_RATE, state);
    const firstWorker = await waitForStats(() => workers[0] ?? null, "first stats worker was not created");
    assert.equal(firstWorker.messages[0]?.type, HEART_RATE);

    // Force the worker to be replaced, then give the replacement a new in-flight job.
    firstWorker.emit("error", new Error("worker crashed"));
    worker.request(STEPS, state);
    const secondWorker = await waitForStats(() => workers[1] ?? null, "replacement stats worker was not created");
    const secondJob = await waitForStats(
      () => secondWorker.messages.find((message) => message.type === STEPS) ?? null,
      "replacement job was not dispatched"
    );
    assert.equal(secondJob.type, STEPS);

    // The old worker's delayed exit is the review regression: it must not clear
    // the replacement's inFlight, or the valid result below would be discarded.
    firstWorker.emit("exit", 0);
    secondWorker.emit("message", {
      type: STEPS,
      stats: { maxDurationMs: 1234, hasNonCanonicalTimestamps: false }
    });
    const primed = await waitForStats(
      () => cache.tryLookupValid(database, STEPS),
      "replacement worker result was not installed after the old exit"
    );
    assert.equal(primed.stats.maxDurationMs, 1234);

    // A late message from the old generation must not install the wrong type.
    firstWorker.emit("message", {
      type: HEART_RATE,
      stats: { maxDurationMs: 9, hasNonCanonicalTimestamps: false }
    });
    assert.equal(cache.tryLookupValid(database, HEART_RATE), null, "old worker message leaked into the replacement");
  } finally {
    worker.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
