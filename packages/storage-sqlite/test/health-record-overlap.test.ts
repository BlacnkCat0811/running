import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  adaptiveHealthRecordOverlapQuery,
  buildLegacyHealthRecordOverlapQuery,
  buildSplitHealthRecordOverlapQuery,
  chooseHealthRecordOverlapShape,
  probeHealthRecordOverlapTimeline,
  type HealthRecordOverlapColumn,
  type HealthRecordOverlapQueryInput,
  type HealthRecordOverlapTimeline
} from "../src/read/read-utils.js";
import { SqliteSeriesReadRepository } from "../src/read/series-read-repository.js";
import { SqliteWorkoutReadRepository } from "../src/read/workout-read-repository.js";

// 2026-10-18（事故复盘 P0-1 复查 P1）：`metricIntervals` / `averageRawMetric` 的
// UNION 分支 B（`start_at < L AND end_at > L`）**只有 end_at 下界**，窗口越老扫描的
// 历史行数越多（合成 21 万行：近期 0.30 ms、最老 16.8 ms，而 P0 之前的单段形状在老窗口
// 只要 0.11 ms）。修复方式是按窗口位置在 split / legacy 两种**逐行等价**的形状里二选一。
// 本文件守三件事：
//   1. 选择器是纯函数，边界（近期/中段/最老/同刻/空库/缺索引）行为明确且回退 split；
//   2. 两种形状在大量边界合成数据上返回**完全相同**的行（含 ±HH:MM 遗留文本、malformed、
//      零长、重复、跨窗、窗口起止边界），仓库层结果也逐位相同；
//   3. EXPLAIN QUERY PLAN 守卫：近期窗口走 end_at 索引 seek、老窗口走 start_at 索引 seek，
//      两条路径都不得出现 `SCAN health_records`。

const HEALTH_RECORD_COLUMNS: readonly HealthRecordOverlapColumn[] = [
  "start_at",
  "end_at",
  "value_numeric",
  "unit"
];
const RAW_METRIC_COLUMNS: readonly HealthRecordOverlapColumn[] = [
  "start_at",
  "end_at",
  "value_numeric"
];

// 与 `database.ts` 的基线 schema + `v40-migration.ts` 的索引逐字同形：EXPLAIN 守卫要求
// "真实建表 + 建索引"，否则计划器给出的结论对生产没有意义。
const HEALTH_RECORDS_SCHEMA = `
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
const HEALTH_RECORD_INDEXES = `
  CREATE INDEX idx_health_records_type_time ON health_records(type, start_at, end_at);
  CREATE INDEX idx_health_records_source_time ON health_records(source_name, start_at, end_at);
  CREATE INDEX idx_health_records_type_end ON health_records(type, end_at, start_at);
`;

const HEART_RATE = "HKQuantityTypeIdentifierHeartRate";
const RUNNING_POWER = "HKQuantityTypeIdentifierRunningPower";

function openDatabase(options: { indexes: boolean }): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(HEALTH_RECORDS_SCHEMA);
  if (options.indexes) database.exec(HEALTH_RECORD_INDEXES);
  return database;
}

interface SyntheticRecord {
  type: string;
  sourceName: string;
  start: string;
  end: string;
  value: number | null;
  unit?: string;
}

function seedRecords(database: DatabaseSync, records: readonly SyntheticRecord[]): void {
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
        `synthetic-${index}`,
        record.type,
        record.sourceName,
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

/** 固定宽度 UTC 文本。 */
function utc(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 把同一个绝对时刻写成带 `±HH:MM` 偏移的遗留文本（AI 之外的导入路径可能留下这种行）。
 * 例：`offsetIso(t, -840)` ⇒ 墙钟显示 `t - 14 h`，后缀 `-14:00`。
 */
function offsetIso(ms: number, offsetMinutes: number): string {
  const wallClock = new Date(ms + offsetMinutes * 60_000).toISOString();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const minutes = String(absoluteMinutes % 60).padStart(2, "0");
  // 保留 `.mmm`：文本比较是逐字节的，小数部分的形状同样参与"文本序"（历史契约）。
  return `${wallClock.slice(0, 23)}${sign}${hours}:${minutes}`;
}

function rowsFor(query: { sql: string; params: string[] }, database: DatabaseSync): string[] {
  const rows = database.prepare(query.sql).all(...query.params) as Array<Record<string, unknown>>;
  return rows.map((row) => JSON.stringify(row));
}

function queryInput(
  startedAt: string,
  endedAt: string,
  columns: readonly HealthRecordOverlapColumn[] = HEALTH_RECORD_COLUMNS,
  type = HEART_RATE,
  sourceName = "Watch"
): HealthRecordOverlapQueryInput {
  return { type, sourceName, startedAt, endedAt, columns };
}

// ---------------------------------------------------------------------------
// 1. 纯函数选择器：边界与回退
// ---------------------------------------------------------------------------

const TIMELINE_IN_MS: HealthRecordOverlapTimeline = {
  sourceStartMs: Date.parse("2022-01-01T00:00:00.000Z"),
  sourceEndMs: Date.parse("2024-01-01T00:00:00.000Z"),
  typeStartMs: Date.parse("2022-01-01T00:01:00.000Z"),
  typeEndMs: Date.parse("2024-01-01T00:01:00.000Z"),
  typeEndIndexAvailable: true,
  sourceTimeIndexAvailable: true,
  typeTimeIndexAvailable: true
};

test("shape selector picks split for a window at the newest edge of the timeline", () => {
  const choice = chooseHealthRecordOverlapShape(
    "2023-12-31T23:00:00.000Z",
    "2023-12-31T23:30:00.000Z",
    TIMELINE_IN_MS
  );
  assert.equal(choice.shape, "split", "近期窗口：legacy 要扫几乎全历史，split B 只扫时间轴末端");
  assert.ok(choice.legacyCost !== null && choice.legacyCost > 0.99);
  assert.ok(choice.splitCost !== null && choice.splitCost < 0.001);
});

test("shape selector picks legacy for a window at the oldest edge of the timeline", () => {
  const choice = chooseHealthRecordOverlapShape(
    "2022-01-02T00:00:00.000Z",
    "2022-01-02T00:30:00.000Z",
    TIMELINE_IN_MS
  );
  assert.equal(choice.shape, "legacy", "老窗口：legacy 只 seek start_at 的前一小段历史");
  assert.ok(choice.legacyCost !== null && choice.legacyCost < 0.002, "离时间轴起点仅 1 天，占两年历史约 0.14 %");
  assert.ok(choice.splitCost !== null && choice.splitCost > 0.99);
});

test("shape selector keeps the middle of the timeline at roughly half history either way", () => {
  // 中段窗口两侧各约一半历史：这是 B-tree 的固有下界（v40-migration.ts 的同源论证），
  // 自适应只能取两者较小者，不承诺把它变成 O(log n)。
  const middle = chooseHealthRecordOverlapShape(
    "2023-01-01T00:00:00.000Z",
    "2023-01-01T00:30:00.000Z",
    TIMELINE_IN_MS
  );
  assert.equal(middle.shape, "split", "split 略小（type_end 时间轴比 source 时间轴更靠右）");
  assert.ok(middle.legacyCost !== null && Math.abs(middle.legacyCost - 0.5) < 0.01);
  assert.ok(middle.splitCost !== null && Math.abs(middle.splitCost - 0.5) < 0.01);
  assert.ok(Math.min(middle.legacyCost!, middle.splitCost!) > 0.49, "中段成本仍是约半段历史");
});

test("shape selector sends a pre-history window to legacy and a post-history one to split", () => {
  const before = chooseHealthRecordOverlapShape(
    "2021-12-01T00:00:00.000Z",
    "2021-12-01T00:30:00.000Z",
    TIMELINE_IN_MS
  );
  assert.equal(before.shape, "legacy");
  assert.equal(before.legacyCost, 0);
  const after = chooseHealthRecordOverlapShape(
    "2024-02-01T00:00:00.000Z",
    "2024-02-01T00:30:00.000Z",
    TIMELINE_IN_MS
  );
  assert.equal(after.shape, "split");
  assert.equal(after.splitCost, 0);
});

test("shape selector falls back to split when either index edge is missing", () => {
  const withoutTypeEnd = { ...TIMELINE_IN_MS, typeEndIndexAvailable: false };
  const withoutSourceTime = { ...TIMELINE_IN_MS, sourceTimeIndexAvailable: false };
  const oldWindow = ["2022-01-02T00:00:00.000Z", "2022-01-02T00:30:00.000Z"] as const;
  for (const timeline of [withoutTypeEnd, withoutSourceTime]) {
    const choice = chooseHealthRecordOverlapShape(oldWindow[0], oldWindow[1], timeline);
    assert.equal(choice.shape, "split", "缺索引时保持 P0 之后的既有行为，不假装能比较成本");
    assert.equal(choice.legacyCost, null);
    assert.equal(choice.splitCost, null);
  }
});

test("shape selector falls back to split for an empty database or failed probes", () => {
  const empty: HealthRecordOverlapTimeline = {
    sourceStartMs: null,
    sourceEndMs: null,
    typeStartMs: null,
    typeEndMs: null,
    typeEndIndexAvailable: true,
    sourceTimeIndexAvailable: true,
    typeTimeIndexAvailable: true
  };
  assert.equal(chooseHealthRecordOverlapShape("2023-01-01T00:00:00.000Z", "2023-01-01T00:30:00.000Z", empty).shape, "split");
  const partial = { ...TIMELINE_IN_MS, typeEndMs: null };
  assert.equal(chooseHealthRecordOverlapShape("2022-01-02T00:00:00.000Z", "2022-01-02T00:30:00.000Z", partial).shape, "split");
  // 窗口文本不可解析 ⇒ julianday 只能得到 NULL，任何成本估计都无意义。
  const invalidWindow = chooseHealthRecordOverlapShape("not-a-time", "also-not", TIMELINE_IN_MS);
  assert.equal(invalidWindow.shape, "split");
  assert.equal(invalidWindow.legacyCost, null);
});

test("shape selector falls back to split when an axis is a single instant", () => {
  const sameInstant: HealthRecordOverlapTimeline = {
    ...TIMELINE_IN_MS,
    sourceStartMs: Date.parse("2023-01-01T00:00:00.000Z"),
    sourceEndMs: Date.parse("2023-01-01T00:00:00.000Z"),
    typeStartMs: Date.parse("2023-01-01T00:00:00.000Z"),
    typeEndMs: Date.parse("2023-01-01T00:00:00.000Z")
  };
  const choice = chooseHealthRecordOverlapShape("2022-01-02T00:00:00.000Z", "2022-01-02T00:30:00.000Z", sameInstant);
  assert.equal(choice.shape, "split");
  assert.equal(choice.legacyCost, null);
});

test("shape selector treats a raw 0.5/0.5 cost tie as split (legacy rows cost ~3x)", () => {
  // 成本占比平手不再直接选 legacy：legacy 每行要回表过滤 type/value_numeric，
  // 实测每行成本约是 split 的 3 倍（见 read-utils.ts 的 LEGACY_RELATIVE_ROW_COST）。
  // 平手时 split 修正后严格更小 ⇒ 选 split；legacy 只在"明显更接近时间轴起点"时用。
  const symmetric: HealthRecordOverlapTimeline = {
    sourceStartMs: 0,
    sourceEndMs: 100,
    typeStartMs: 0,
    typeEndMs: 100,
    typeEndIndexAvailable: true,
    sourceTimeIndexAvailable: true,
    typeTimeIndexAvailable: true
  };
  const choice = chooseHealthRecordOverlapShape(new Date(50).toISOString(), new Date(50).toISOString(), symmetric);
  assert.equal(choice.legacyCost, 0.5);
  assert.equal(choice.splitCost, 0.5);
  assert.equal(choice.shape, "split");

  // 老窗口（legacy 占比 0.1、split 占比 0.9）：即使乘 3 修正，legacy 仍明显更小。
  const oldest = chooseHealthRecordOverlapShape(new Date(10).toISOString(), new Date(11).toISOString(), symmetric);
  assert.equal(oldest.shape, "legacy");
});

test("shape selector clamps windows that lie outside the probe timeline", () => {
  const choice = chooseHealthRecordOverlapShape(
    "2020-01-01T00:00:00.000Z",
    "2020-01-02T00:00:00.000Z",
    TIMELINE_IN_MS
  );
  assert.equal(choice.shape, "legacy");
  assert.equal(choice.legacyCost, 0, "窗口整段早于 source 时间轴：legacy 的 seek 走 0 行");
});

// ---------------------------------------------------------------------------
// 2. 探测：索引可用性 + 4 条 O(log n) 端点
// ---------------------------------------------------------------------------

test("timeline probe reads both timeline ends when the indexes exist", () => {
  const database = openDatabase({ indexes: true });
  try {
    seedRecords(database, [
      { type: HEART_RATE, sourceName: "Watch", start: utc(1_000), end: utc(61_000), value: 100 },
      { type: HEART_RATE, sourceName: "Watch", start: utc(2_000_000), end: utc(2_060_000), value: 120 },
      // 另一个来源/类型不参与本窗口的探测轴。
      { type: RUNNING_POWER, sourceName: "RQ Run", start: utc(500_000), end: utc(560_000), value: 200 }
    ]);
    const timeline = probeHealthRecordOverlapTimeline(database, "Watch", HEART_RATE);
    assert.deepEqual(timeline, {
      sourceStartMs: 1_000,
      sourceEndMs: 2_000_000,
      typeStartMs: 61_000,
      typeEndMs: 2_060_000,
      typeEndIndexAvailable: true,
      sourceTimeIndexAvailable: true,
      typeTimeIndexAvailable: true
    });
  } finally {
    database.close();
  }
});

test("timeline probe reports missing indexes and skips the four probes", () => {
  const database = openDatabase({ indexes: false });
  try {
    seedRecords(database, [
      { type: HEART_RATE, sourceName: "Watch", start: utc(1_000), end: utc(61_000), value: 100 }
    ]);
    const timeline = probeHealthRecordOverlapTimeline(database, "Watch", HEART_RATE);
    assert.equal(timeline.typeEndIndexAvailable, false);
    assert.equal(timeline.sourceTimeIndexAvailable, false);
    assert.equal(timeline.sourceStartMs, null, "缺索引时不探测：没有可比的 seek，直接回退 split");
    assert.equal(timeline.typeEndMs, null);
  } finally {
    database.close();
  }
});

test("overlap query builders project the caller's column set and start_at is mandatory", () => {
  const split = buildSplitHealthRecordOverlapQuery(queryInput("2026-09-01T00:00:00.000Z", "2026-09-01T00:10:00.000Z"));
  assert.equal(split.params.length, 9);
  assert.match(split.sql, /value_numeric IS NOT NULL/);
  assert.match(split.sql, /UNION/);
  const legacy = buildLegacyHealthRecordOverlapQuery(queryInput("2026-09-01T00:00:00.000Z", "2026-09-01T00:10:00.000Z"));
  assert.equal(legacy.params.length, 5);
  assert.match(legacy.sql, /SELECT DISTINCT/);
  // 投影列集合是行集语义的一部分：raw metric 的去重键不含 unit。
  const rawMetric = buildSplitHealthRecordOverlapQuery(
    queryInput("2026-09-01T00:00:00.000Z", "2026-09-01T00:10:00.000Z", RAW_METRIC_COLUMNS)
  );
  assert.doesNotMatch(rawMetric.sql, /\bunit\b/);
  assert.throws(
    () => buildSplitHealthRecordOverlapQuery(queryInput("2026-09-01T00:00:00.000Z", "2026-09-01T00:10:00.000Z", ["end_at"])),
    /start_at/
  );
});

// ---------------------------------------------------------------------------
// 3. 差分：两种形状逐行等价（边界 + 随机合成数据）
// ---------------------------------------------------------------------------

const WINDOW_START = Date.parse("2026-09-01T12:00:00.000Z");
const WINDOW_END = Date.parse("2026-09-01T12:10:00.000Z");

function boundaryRecords(): SyntheticRecord[] {
  const records: SyntheticRecord[] = [
    // 窗口内的普通行、重复行（逐字重复 ⇒ 两种形状都必须只留一份）
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START + 60_000), end: utc(WINDOW_START + 120_000), value: 120 },
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START + 60_000), end: utc(WINDOW_START + 120_000), value: 120 },
    // 同一 (start, end, value) 但 unit 不同：4 列形状留两份，3 列形状留一份。
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START + 180_000), end: utc(WINDOW_START + 240_000), value: 121, unit: "count/min" },
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START + 180_000), end: utc(WINDOW_START + 240_000), value: 121, unit: "bpm" },
    // 零长记录（start == end）：窗口内保留（按"下一条"推 end），跨窗口起点时因
    // `julianday(end_at) > julianday(start_at)` 为假被排除。
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START + 300_000), end: utc(WINDOW_START + 300_000), value: 122 },
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START - 300_000), end: utc(WINDOW_START - 300_000), value: 123 },
    // malformed（end < start）：窗口内保留、跨窗口起点时排除。
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START + 360_000), end: utc(WINDOW_START + 330_000), value: 124 },
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START - 600_000), end: utc(WINDOW_START - 900_000), value: 125 },
    // 跨窗口起点的长区间（split B 分支的正主）。
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START - 3_600_000), end: utc(WINDOW_START + 600_000), value: 150 },
    // 跨整个窗口的长区间。
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START - 7_200_000), end: utc(WINDOW_START + 3_600_000), value: 161 },
    // 恰好压在窗口起点/终点上的行：起点算相交、终点不算（半开窗口）。
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START), end: utc(WINDOW_START + 60_000), value: 130 },
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_END), end: utc(WINDOW_END + 60_000), value: 131 },
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START - 60_000), end: utc(WINDOW_START), value: 132 },
    // 完全在窗口外（前后各一段）。
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START - 3_600_000), end: utc(WINDOW_START - 3_500_000), value: 90 },
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_END + 60_000), end: utc(WINDOW_END + 120_000), value: 91 },
    // 另一个来源/类型的行：不得混进来。
    { type: RUNNING_POWER, sourceName: "Watch", start: utc(WINDOW_START + 60_000), end: utc(WINDOW_START + 120_000), value: 200 },
    { type: HEART_RATE, sourceName: "RQ Run", start: utc(WINDOW_START + 60_000), end: utc(WINDOW_START + 120_000), value: 201 },
    // value_numeric 为 NULL：两侧都过滤掉。
    { type: HEART_RATE, sourceName: "Watch", start: utc(WINDOW_START + 420_000), end: utc(WINDOW_START + 480_000), value: null },
    // ±HH:MM 遗留文本（历史契约按**文本序**分派分支、按 julianday 判绝对归属）：
    // (a) 绝对时刻在窗口内（L+5 min）、`-05:00` 文本把它写到 L 之前 ⇒ 从 B 分支进来。
    { type: HEART_RATE, sourceName: "Watch", start: offsetIso(WINDOW_START + 300_000, -300), end: offsetIso(WINDOW_START + 360_000, -300), value: 200 },
    // (b) 跨窗口起点、绝对 end 在 L 之后 1 秒，但 `-14:00` 文本把 end 写到 L-14 h：
    //     仍必须落在 B 分支 24 h slack 的超集里（这是 slack 存在的理由）。
    { type: HEART_RATE, sourceName: "Watch", start: offsetIso(WINDOW_START - 60_000, -840), end: offsetIso(WINDOW_START + 1_000, -840), value: 201 },
    // (c) 绝对 end 早于窗口起点 1 h、但 `-14:00` 文本仍大于 L-24h：slack 超集放进来的行
    //     必须被 julianday 残差谓词剔掉（不能只靠文本下界）。
    { type: HEART_RATE, sourceName: "Watch", start: offsetIso(WINDOW_START - 7_200_000, -840), end: offsetIso(WINDOW_START - 3_600_000, -840), value: 202 },
    // (d) `+14:00` 文本落在窗口内 1 ms、绝对时刻却早于窗口 14 h：A/B 分支按**文本**
    //     判定，所以两种形状都必须把它当成"起点在窗口内"的行（JS 侧再因 end<=start 丢弃）。
    { type: HEART_RATE, sourceName: "Watch", start: offsetIso(WINDOW_START - 50_399_999, 840), end: offsetIso(WINDOW_START - 50_339_999, 840), value: 203 },
    // (e) 与上面窗口内 UTC 行同一绝对时刻、不同文本：文本不同 ⇒ 去重后仍是两行，
    //     两种形状都必须保留两份（一份从 A 进来、一份从 B 进来）。
    { type: HEART_RATE, sourceName: "Watch", start: offsetIso(WINDOW_START + 300_000, -300), end: offsetIso(WINDOW_START + 360_000, -300), value: 204 }
  ];
  return records;
}

/** 确定性伪随机（LCG），不引入额外依赖。 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function randomRecords(): SyntheticRecord[] {
  const random = seededRandom(20261018);
  const types = [HEART_RATE, RUNNING_POWER, "HKQuantityTypeIdentifierStepCount"];
  const sources = ["Watch", "RQ Run", "Third Party"];
  const durations = [-60_000, 0, 1_000, 30_000, 300_000, 3_600_000];
  const records: SyntheticRecord[] = [];
  for (let index = 0; index < 240; index += 1) {
    const startMs = WINDOW_START - 86_400_000 + Math.floor(random() * 3 * 86_400_000);
    const duration = durations[Math.floor(random() * durations.length)]!;
    const endMs = startMs + duration;
    const offsetMinutes = [0, 0, 0, 330, -840, 840][Math.floor(random() * 6)]!;
    const record: SyntheticRecord = {
      type: types[Math.floor(random() * types.length)]!,
      sourceName: sources[Math.floor(random() * sources.length)]!,
      start: offsetMinutes === 0 ? utc(startMs) : offsetIso(startMs, offsetMinutes),
      end: offsetMinutes === 0 ? utc(endMs) : offsetIso(endMs, offsetMinutes),
      value: random() < 0.1 ? null : Math.floor(random() * 40) * 5
    };
    records.push(record);
    // 重复行、以及"同区间同值不同 unit"的行都要进入去重语义的对照。
    if (random() < 0.3) records.push({ ...record });
    if (random() < 0.2) records.push({ ...record, unit: "count/min" });
  }
  return records;
}

function assertShapesEquivalent(
  records: readonly SyntheticRecord[],
  windows: ReadonlyArray<readonly [string, string]>,
  truthy: string
): void {
  for (const indexes of [true, false]) {
    const database = openDatabase({ indexes });
    try {
      seedRecords(database, records);
      for (const [startedAt, endedAt] of windows) {
        for (const columns of [HEALTH_RECORD_COLUMNS, RAW_METRIC_COLUMNS]) {
          const input = queryInput(startedAt, endedAt, columns);
          const splitRows = rowsFor(buildSplitHealthRecordOverlapQuery(input), database);
          const legacyRows = rowsFor(buildLegacyHealthRecordOverlapQuery(input), database);
          assert.deepEqual(splitRows, legacyRows, `${truthy}：索引=${indexes} 窗口=${startedAt}~${endedAt} 列=${columns.join(",")}`);
        }
      }
    } finally {
      database.close();
    }
  }
}

test("split and legacy shapes return identical rows on boundary data", () => {
  assertShapesEquivalent(
    boundaryRecords(),
    [
      [utc(WINDOW_START), utc(WINDOW_END)],
      [utc(WINDOW_START), utc(WINDOW_START)],
      [utc(WINDOW_START - 1_000), utc(WINDOW_START + 1_000)],
      [utc(WINDOW_END - 1_000), utc(WINDOW_END + 1_000)],
      ["2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z"]
    ],
    "边界数据"
  );
});

test("boundary fixture really exercises the slack superset and the text-order branch dispatch", () => {
  // 防止上面的"逐行等价"退化成"两边都空"：这里把边界夹具在真实窗口上的语义钉死
  // （行集由历史实现决定，split/legacy 都必须给出同一份）。
  const database = openDatabase({ indexes: true });
  try {
    seedRecords(database, boundaryRecords());
    const values = (columns: readonly HealthRecordOverlapColumn[]): number[] => {
      const query = buildSplitHealthRecordOverlapQuery(queryInput(utc(WINDOW_START), utc(WINDOW_END), columns));
      const rows = database.prepare(query.sql).all(...query.params) as Array<Record<string, unknown>>;
      return rows.map((row) => Number(row.value_numeric)).sort((left, right) => left - right);
    };
    const fourColumnValues = values(HEALTH_RECORD_COLUMNS);
    // 201：绝对 end 在 L 之后 1 s、-14:00 文本写到 L-14 h ⇒ 追加 24 h slack 后才进得来。
    assert.ok(fourColumnValues.includes(201), `24 h slack 超集必须接住偏移文本行，实际：${fourColumnValues.join(",")}`);
    // 202：绝对 end 早于 L、靠 slack 文本混进预筛 ⇒ 必须被 julianday 残差剔掉。
    assert.ok(!fourColumnValues.includes(202), "slack 只是文本预筛，绝对归属仍由 julianday 决定");
    // 203：+14:00 文本恰好等于 L（绝对时刻 L-14 h）⇒ 按文本序属于窗口内分支。
    assert.ok(fourColumnValues.includes(203), "文本序是历史契约的一部分");
    // 204 与 (a) 200 同一绝对时刻、不同文本 ⇒ 去重键不同，两行都留。
    assert.ok(fourColumnValues.includes(200) && fourColumnValues.includes(204));
    // 121 两行只差 unit ⇒ 4 列形状保留两份、3 列形状去重成一份（调用点语义差异）。
    assert.equal(fourColumnValues.filter((value) => value === 121).length, 2);
    const threeColumnValues = values(RAW_METRIC_COLUMNS);
    assert.equal(threeColumnValues.filter((value) => value === 121).length, 1);
    // 零长跨窗口起点 / malformed 跨窗口起点 / 恰好等于窗口终点 / 窗口外都不算相交。
    for (const excluded of [123, 125, 131, 132, 90, 91]) {
      assert.ok(!fourColumnValues.includes(excluded), `值 ${excluded} 不应属于该窗口`);
    }
  } finally {
    database.close();
  }
});

test("split and legacy shapes return identical rows on seeded random data", () => {
  const records = randomRecords();
  const random = seededRandom(42);
  const windows: Array<readonly [string, string]> = [];
  for (let index = 0; index < 12; index += 1) {
    const startMs = WINDOW_START - 2 * 86_400_000 + Math.floor(random() * 4 * 86_400_000);
    windows.push([utc(startMs), utc(startMs + Math.floor(random() * 3_600_000))]);
  }
  assertShapesEquivalent(records, windows, "随机数据");
});

// ---------------------------------------------------------------------------
// 4. 仓库层：两条调用点共用 helper，且两种形状给出同一结果
// ---------------------------------------------------------------------------

function createWorkoutFixtures(database: DatabaseSync, windows: ReadonlyArray<readonly [string, string]>): string[] {
  database.exec(`
    CREATE TABLE workouts (
      id TEXT, source_name TEXT, start_at TEXT, end_at TEXT, deleted_at TEXT
    );
    CREATE TABLE workout_statistics (
      workout_id TEXT, type TEXT, ordinal INTEGER, sum_value REAL, average_value REAL
    );
  `);
  const insert = database.prepare("INSERT INTO workouts VALUES (?, 'Watch', ?, ?, NULL)");
  return windows.map(([startedAt, endedAt], index) => {
    const id = `workout-${index}`;
    insert.run(id, startedAt, endedAt);
    return id;
  });
}

const REPOSITORY_WINDOWS: ReadonlyArray<readonly [string, string]> = [
  // 时间轴前端（随机数据的下界就是 -1 d）、中段、时间轴末端（随机数据上界 < +2 d）。
  [utc(WINDOW_START - 86_400_000), utc(WINDOW_START - 86_400_000 + 600_000)],
  [utc(WINDOW_START), utc(WINDOW_END)],
  [utc(WINDOW_START + 2 * 86_400_000), utc(WINDOW_START + 2 * 86_400_000 + 600_000)]
];

/**
 * 每个窗口里放一条 HR + 一条功率锚点行：形状断言需要窗口真的能读到行，
 * 否则"有索引库和无索引库结果相同"可能只是"两边都空"。
 */
function anchorRecords(): SyntheticRecord[] {
  return REPOSITORY_WINDOWS.flatMap(([startedAt], index) => {
    const startedMs = Date.parse(startedAt);
    return [
      { type: HEART_RATE, sourceName: "Watch", start: utc(startedMs + 60_000), end: utc(startedMs + 180_000), value: 100 + index },
      { type: RUNNING_POWER, sourceName: "Watch", start: utc(startedMs + 120_000), end: utc(startedMs + 240_000), value: 200 + index }
    ];
  });
}

test("metricIntervals returns the same intervals whether the adaptive read uses split or legacy", () => {
  const records = [...boundaryRecords(), ...randomRecords(), ...anchorRecords()];
  const withIndexes = openDatabase({ indexes: true });
  const withoutIndexes = openDatabase({ indexes: false });
  try {
    seedRecords(withIndexes, records);
    seedRecords(withoutIndexes, records);
    const shapes = REPOSITORY_WINDOWS.map(([startedAt, endedAt]) =>
      adaptiveHealthRecordOverlapQuery(withIndexes, queryInput(startedAt, endedAt)).shape
    );
    assert.ok(shapes.includes("legacy"), `索引库应有窗口走 legacy（实际 ${shapes.join(",")}）`);
    assert.ok(shapes.includes("split"), `索引库应有窗口走 split（实际 ${shapes.join(",")}）`);
    // 无索引库恒回退 split ⇒ 它是有索引库（可能走 legacy）的参照。
    for (const [startedAt, endedAt] of REPOSITORY_WINDOWS) {
      const indexed = new SqliteSeriesReadRepository(withIndexes).metricIntervals(
        HEART_RATE, "Watch", startedAt, endedAt
      );
      const reference = new SqliteSeriesReadRepository(withoutIndexes).metricIntervals(
        HEART_RATE, "Watch", startedAt, endedAt
      );
      assert.deepEqual(indexed, reference, `窗口 ${startedAt}~${endedAt} 的区间必须逐项相同`);
      assert.ok(indexed.length > 0, "夹具在这三个窗口上都必须真的读到行，否则本用例什么都没证明");
    }
  } finally {
    withIndexes.close();
    withoutIndexes.close();
  }
});

test("averageRawMetric returns the same average whether the adaptive read uses split or legacy", () => {
  const records = [...boundaryRecords(), ...randomRecords(), ...anchorRecords()];
  const withIndexes = openDatabase({ indexes: true });
  const withoutIndexes = openDatabase({ indexes: false });
  try {
    seedRecords(withIndexes, records);
    seedRecords(withoutIndexes, records);
    const workoutIds = createWorkoutFixtures(withIndexes, REPOSITORY_WINDOWS);
    createWorkoutFixtures(withoutIndexes, REPOSITORY_WINDOWS);
    const shapes = REPOSITORY_WINDOWS.map(([startedAt, endedAt]) =>
      adaptiveHealthRecordOverlapQuery(withIndexes, queryInput(startedAt, endedAt, RAW_METRIC_COLUMNS, RUNNING_POWER)).shape
    );
    assert.ok(shapes.includes("legacy"), `索引库应有窗口走 legacy（实际 ${shapes.join(",")}）`);
    assert.ok(shapes.includes("split"), `索引库应有窗口走 split（实际 ${shapes.join(",")}）`);
    for (const [index, workoutId] of workoutIds.entries()) {
      const indexed = new SqliteWorkoutReadRepository(withIndexes)
        .workoutStatistic(workoutId, RUNNING_POWER, "average");
      const reference = new SqliteWorkoutReadRepository(withoutIndexes)
        .workoutStatistic(workoutId, RUNNING_POWER, "average");
      assert.equal(indexed, reference, `窗口 ${REPOSITORY_WINDOWS[index]!.join("~")} 的加权平均必须相同`);
    }
    // 锚点行保证每个窗口都真的读到功率行，否则上面的相等可能只是"两边都是 null"。
    for (const [index, workoutId] of workoutIds.entries()) {
      assert.notEqual(
        new SqliteWorkoutReadRepository(withIndexes).workoutStatistic(workoutId, RUNNING_POWER, "average"),
        null,
        `窗口 ${REPOSITORY_WINDOWS[index]!.join("~")} 必须真的读到功率行`
      );
    }
  } finally {
    withIndexes.close();
    withoutIndexes.close();
  }
});

// ---------------------------------------------------------------------------
// 5. EXPLAIN QUERY PLAN 守卫：近期窗口用 end_at seek，老窗口用 start_at seek
// ---------------------------------------------------------------------------

function planRows(database: DatabaseSync, query: { sql: string; params: string[] }): string {
  const rows = database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{
    detail?: unknown;
  }>;
  return rows.map((row) => String(row.detail)).join("\n");
}

function timelineDatabase(): DatabaseSync {
  const database = openDatabase({ indexes: true });
  // 2026-01-01 起每小时一条、时长 1 分钟的 HR：时间轴从年初铺到年末。
  database.exec("BEGIN");
  const insert = database.prepare(`
    INSERT INTO health_records
      (id, type, source_name, source_category, unit, value_numeric, start_at, end_at,
       metadata_json, raw_attributes_json)
    VALUES (?, ?, 'Watch', 'apple_watch', 'bpm', 120, ?, ?, '{}', '{}')
  `);
  const first = Date.parse("2026-01-01T00:00:00.000Z");
  for (let index = 0; index < 8_760; index += 1) {
    const startMs = first + index * 3_600_000;
    insert.run(`hr-${index}`, HEART_RATE, utc(startMs), utc(startMs + 60_000));
  }
  database.exec("COMMIT");
  return database;
}

test("EXPLAIN guard: newest window seeks idx_health_records_type_end, never scans health_records", () => {
  const database = timelineDatabase();
  try {
    const query = adaptiveHealthRecordOverlapQuery(
      database,
      queryInput("2026-12-31T22:00:00.000Z", "2026-12-31T23:00:00.000Z")
    );
    assert.equal(query.shape, "split", "时间轴末端的窗口必须走 split（P0 形状）");
    const plan = planRows(database, query);
    assert.match(plan, /USING INDEX idx_health_records_type_end \(type=\? AND end_at>\?\)/,
      `split B 分支必须按 end_at seek 到 idx_health_records_type_end，实际计划：\n${plan}`);
    assert.match(plan, /USING INDEX idx_health_records_source_time/,
      `split A 分支必须按 start_at seek 到 idx_health_records_source_time，实际计划：\n${plan}`);
    assert.doesNotMatch(plan, /SCAN health_records\b/, `不得出现健康表全扫，实际计划：\n${plan}`);
  } finally {
    database.close();
  }
});

test("EXPLAIN guard: oldest window seeks idx_health_records_source_time, never scans health_records", () => {
  const database = timelineDatabase();
  try {
    const query = adaptiveHealthRecordOverlapQuery(
      database,
      queryInput("2026-01-01T01:00:00.000Z", "2026-01-01T02:00:00.000Z")
    );
    assert.equal(query.shape, "legacy", "时间轴前端的窗口必须走 legacy（P0 之前的单段形状）");
    const plan = planRows(database, query);
    assert.match(plan, /USING INDEX idx_health_records_source_time \(source_name=\? AND start_at<\?\)/,
      `legacy 必须按 start_at 上界 seek 到 idx_health_records_source_time，实际计划：\n${plan}`);
    assert.doesNotMatch(plan, /SCAN health_records\b/, `不得出现健康表全扫，实际计划：\n${plan}`);
  } finally {
    database.close();
  }
});

test("EXPLAIN guard: without the type_end index the adaptive read falls back to split", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(HEALTH_RECORDS_SCHEMA);
    database.exec(`
      CREATE INDEX idx_health_records_type_time ON health_records(type, start_at, end_at);
      CREATE INDEX idx_health_records_source_time ON health_records(source_name, start_at, end_at);
    `);
    seedRecords(database, [
      { type: HEART_RATE, sourceName: "Watch", start: utc(1_000), end: utc(61_000), value: 100 }
    ]);
    const query = adaptiveHealthRecordOverlapQuery(
      database,
      queryInput("2026-09-01T12:00:00.000Z", "2026-09-01T12:10:00.000Z")
    );
    assert.equal(query.shape, "split", "缺 idx_health_records_type_end 时保持 P0 之后的方案");
    assert.match(query.sql, /UNION/, "回退形状必须是 split 而不是 legacy");
  } finally {
    database.close();
  }
});
