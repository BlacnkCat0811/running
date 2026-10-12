import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";
import { healthTypes, SLEEP_ANALYSIS_VALUES } from "@rai/contracts";

import { canonicalizeNights, canonicalizeNightsForWindow } from "../src/index.js";

/**
 * `canonicalizeNightsForWindow` 的**窗口不变性**。
 *
 * 核心断言：对任意窗口 `[a,b]`，windowed 产出的 `wake_date ∈ [a,b]` 的行，
 * 与全量 `canonicalizeNights` 产出的同一批日期的行**逐列相同**（`computed_at` 除外，
 * 它按到达时间语义单独维护）；并且窗口外的行**一个字节都不改**（含 `computed_at`）。
 *
 * ⚠️ 单有"逐列相同"是**可以假绿**的：如果 windowed 根本没删/重算窗口内的行，
 * 而库里那些行恰好已经是全量重建过的正确值，比较当然相等。下面
 * `it repairs a deliberately corrupted window row` 专门先改坏一行再跑 windowed，
 * 用"坏值被修好"证明**确实发生了重算** —— 这才让"逐列相同"有意义。
 */

const TIMEZONE = "Asia/Shanghai";

async function withDatabase(run: (store: RaiDatabase) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-canonical-window-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

interface SegmentInput {
  id: string;
  sourceName: string;
  sourceCategory: string;
  value: string;
  startAt: string;
  endAt: string;
}

function insertSegment(store: RaiDatabase, segment: SegmentInput): void {
  store.database.prepare(`INSERT INTO health_records
    (id,type,source_name,source_category,unit,value_text,start_at,end_at,metadata_json,raw_attributes_json)
    VALUES (?,?,?,?,'',?,?,?,'{}','{}')`).run(
    segment.id, healthTypes.sleepAnalysis, segment.sourceName, segment.sourceCategory,
    segment.value, segment.startAt, segment.endAt
  );
}

function insertHrv(store: RaiDatabase, id: string, sourceName: string, startAt: string, value: number): void {
  store.database.prepare(`INSERT INTO health_records
    (id,type,source_name,source_category,unit,value_numeric,start_at,end_at,metadata_json,raw_attributes_json)
    VALUES (?,?,'Watch','apple_watch','ms',?,?,?,'{}','{}')`).run(
    id, healthTypes.hrvSdnn, value, startAt, startAt
  );
}

/** 前一个本地日的 UTC 日期串（Asia/Shanghai 无 DST，可直接按 UTC 日期减一）。 */
function previousDate(wakeDate: string): string {
  const previous = new Date(`${wakeDate}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

/**
 * 完整 fixture：
 * - Watch 主夜 09-01 / 09-02 / 09-03（InBed 22:00→次日 08:00、Asleep 22:30→次日 06:30 local，
 *   InBed **跨本地午夜**）；
 * - 09-03 15:00–16:00 local 的**午睡**（走 14:00–18:00 nap pass）；
 * - 09-04 主夜的所有段都**开始于本地午夜之前**（22:00→23:30），钉住 v2 的"看结束时刻"范围；
 * - 09-05 只有一台 iPhone 的 InBed、没有任何 Asleep ⇒ 计入 `rejectedInBedOnly`；
 * - HRV：09-01 两个样本（confident）、09-02 一个样本（sparse）、09-03 无样本（missing）。
 */
const WATCH = { sourceName: "Watch", sourceCategory: "apple_watch" };
const PHONE = { sourceName: "iPhone", sourceCategory: "apple_phone" };

function seedFixture(store: RaiDatabase): void {
  for (const wakeDate of ["2026-09-01", "2026-09-02", "2026-09-03"]) {
    const evening = previousDate(wakeDate);
    insertSegment(store, {
      id: `inbed-${wakeDate}`, ...WATCH, value: SLEEP_ANALYSIS_VALUES.inBed,
      startAt: `${evening}T14:00:00Z`, endAt: `${wakeDate}T00:00:00Z`
    });
    insertSegment(store, {
      id: `asleep-${wakeDate}`, ...WATCH, value: SLEEP_ANALYSIS_VALUES.asleepCore,
      startAt: `${evening}T14:30:00Z`, endAt: `${evening}T22:30:00Z`
    });
  }
  // 09-04 主夜：全部段开始于 09-03 22:00 local（= 14:00Z），本地午夜前结束。
  insertSegment(store, {
    id: "inbed-short", ...WATCH, value: SLEEP_ANALYSIS_VALUES.inBed,
    startAt: "2026-09-03T14:00:00Z", endAt: "2026-09-03T15:30:00Z"
  });
  insertSegment(store, {
    id: "asleep-short", ...WATCH, value: SLEEP_ANALYSIS_VALUES.asleepCore,
    startAt: "2026-09-03T14:05:00Z", endAt: "2026-09-03T15:30:00Z"
  });
  // 09-03 午睡：15:00–16:00 local = 07:00–08:00Z。
  insertSegment(store, {
    id: "nap-09-03", ...WATCH, value: SLEEP_ANALYSIS_VALUES.asleepCore,
    startAt: "2026-09-03T07:00:00Z", endAt: "2026-09-03T08:00:00Z"
  });
  // 09-05：iPhone 只有 InBed（无 Asleep）⇒ rejectedInBedOnly。
  insertSegment(store, {
    id: "inbed-phone", ...PHONE, value: SLEEP_ANALYSIS_VALUES.inBed,
    startAt: "2026-09-04T14:00:00Z", endAt: "2026-09-05T00:00:00Z"
  });
  // HRV 样本（落进对应主夜的 [sleepOnsetAt, wakeAt]）。
  insertHrv(store, "hrv-09-01-a", WATCH.sourceName, "2026-08-31T15:00:00Z", 45);
  insertHrv(store, "hrv-09-01-b", WATCH.sourceName, "2026-08-31T16:00:00Z", 55);
  insertHrv(store, "hrv-09-02", WATCH.sourceName, "2026-09-01T15:00:00Z", 50);
}

/**
 * 形状 B：**同一窗口内多个来源都有 Asleep** ⇒ 走到 `sourceGroups` 的 rank 排序，
 * 以及 rank 并列时"先按 asleep 段数、再按 sourceName"两条决胜规则（`canonicalize-nights.ts:268`），
 * 并让 `competingSourceCount > 1`。fixture A 的 iPhone 只有 InBed、且独占一个日期，
 * 所以 A 里 `competingSourceCount` 恒为 0/1，这条分支一次都没走到。
 *
 * 关键点：WatchB 的**睡眠分钟数更少**（6.5h）但有**更多 Asleep 段**（2 段）⇒ 它在 rank 并列
 * 时靠 asleep 段数胜出。若决胜规则写反（比分钟数而非段数），这里就会挑错来源。
 */
function seedCompetingSources(store: RaiDatabase): void {
  for (const wakeDate of ["2026-10-01", "2026-10-02", "2026-10-03"]) {
    const evening = previousDate(wakeDate);
    // WatchA：apple_watch，1 段 asleep，共 8h（14:30Z→22:30Z）。rank 1（有阶段）。
    insertSegment(store, { id: `a-inbed-${wakeDate}`, sourceName: "WatchA", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.inBed, startAt: `${evening}T14:00:00Z`, endAt: `${wakeDate}T00:00:00Z` });
    insertSegment(store, { id: `a-asleep-${wakeDate}`, sourceName: "WatchA", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.asleepCore, startAt: `${evening}T14:30:00Z`, endAt: `${evening}T22:30:00Z` });
    // WatchB：apple_watch，2 段 asleep，共 6.5h（15:30Z→19:00Z、19:30Z→22:30Z，间隔 30min < 90min 同段）。rank 1。
    insertSegment(store, { id: `b-asleep1-${wakeDate}`, sourceName: "WatchB", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.asleepCore, startAt: `${evening}T15:30:00Z`, endAt: `${evening}T19:00:00Z` });
    insertSegment(store, { id: `b-asleep2-${wakeDate}`, sourceName: "WatchB", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.asleepDeep, startAt: `${evening}T19:30:00Z`, endAt: `${evening}T22:30:00Z` });
    // COROS：coros，rank 3，睡眠更长也必须排在两个 apple_watch 之后。
    insertSegment(store, { id: `c-asleep-${wakeDate}`, sourceName: "COROS", sourceCategory: "coros", value: SLEEP_ANALYSIS_VALUES.asleepCore, startAt: `${evening}T15:00:00Z`, endAt: `${evening}T22:30:00Z` });
    // WatchC：apple_watch，2 段 asleep（与 WatchB 段数并列、rank 并列）⇒ 逼出第三条决胜 sourceName.localeCompare。
    // "WatchB" < "WatchC" ⇒ 赢家仍应是 WatchB；若 name 决胜缺失或反向，赢家会变。
    insertSegment(store, { id: `d-asleep1-${wakeDate}`, sourceName: "WatchC", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.asleepCore, startAt: `${evening}T15:40:00Z`, endAt: `${evening}T19:00:00Z` });
    insertSegment(store, { id: `d-asleep2-${wakeDate}`, sourceName: "WatchC", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.asleepDeep, startAt: `${evening}T19:30:00Z`, endAt: `${evening}T22:30:00Z` });
  }
}

/**
 * 形状 C：**同一晚多个 Asleep 段中间 > 90 min 的间隔** ⇒ 走到 `sessions` 的切分判据
 * （`canonicalize-nights.ts:277` 起的 `seg.start - max(end) > 90min`），产出 main + 夜内 nap；
 * 并且 HRV 样本**精确落在**主夜 `[onset, wake]` 的闭区间两端点，钉住 `>= onset && <= wake` 的边界。
 */
function seedSplitSessionsWithBoundaryHrv(store: RaiDatabase): void {
  for (const wakeDate of ["2026-11-02", "2026-11-03"]) {
    const evening = previousDate(wakeDate);
    // 本地：InBed/Asleep1 22:00→01:00，Asleep2 03:30→04:30；两段 asleep 间隔 2.5h > 90min。
    insertSegment(store, { id: `inbed-${wakeDate}`, sourceName: "Watch", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.inBed, startAt: `${evening}T14:00:00Z`, endAt: `${evening}T17:00:00Z` });
    insertSegment(store, { id: `asleep1-${wakeDate}`, sourceName: "Watch", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.asleepCore, startAt: `${evening}T14:30:00Z`, endAt: `${evening}T17:00:00Z` });
    insertSegment(store, { id: `asleep2-${wakeDate}`, sourceName: "Watch", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.asleepDeep, startAt: `${evening}T19:30:00Z`, endAt: `${evening}T20:30:00Z` });
    // 主夜（session 1）onset=14:30Z、wake=17:00Z；样本恰好压在两端点(闭区间) ⇒ 必须计入 ⇒ confident。
    insertHrv(store, `hrv-onset-${wakeDate}`, "Watch", `${evening}T14:30:00Z`, 40);
    insertHrv(store, `hrv-wake-${wakeDate}`, "Watch", `${evening}T17:00:00Z`, 60);
  }
  // 把 90min 切分阈值钉在边界两侧：gap=89min **不切分**、gap=91min **切分**。
  // 判据是 `gap > T`，故合法阈值区间是 **[89, 91)**（T=89 与 T=90 都通过，T=91 会让 gap=91 不切而红）。
  // ⚠️ 写了区间就要写对：`(89, 91]` 会把通过值 89 排除、把失败值 91 包含 —— 恰好反了，
  // 会误导后来者去"修"一个本来正确的阈值。⇒ 机械排除"阈值其实是 60min / 120min"这类改动。
  for (const [wakeDate, gapMinutes] of [["2026-11-05", 89], ["2026-11-06", 91]] as const) {
    const evening = previousDate(wakeDate);
    insertSegment(store, { id: `t-inbed-${wakeDate}`, sourceName: "Watch", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.inBed, startAt: `${evening}T14:00:00Z`, endAt: `${evening}T15:30:00Z` });
    insertSegment(store, { id: `t-asleep1-${wakeDate}`, sourceName: "Watch", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.asleepCore, startAt: `${evening}T14:00:00Z`, endAt: `${evening}T15:30:00Z` });
    const asleep2Start = new Date(Date.parse(`${evening}T15:30:00Z`) + gapMinutes * 60_000);
    const asleep2End = new Date(asleep2Start.getTime() + 60 * 60_000);
    insertSegment(store, { id: `t-asleep2-${wakeDate}`, sourceName: "Watch", sourceCategory: "apple_watch", value: SLEEP_ANALYSIS_VALUES.asleepDeep, startAt: asleep2Start.toISOString(), endAt: asleep2End.toISOString() });
  }
}

const NIGHT_COLUMNS = [
  "id", "wake_date", "timezone_identifier", "kind", "source_name", "source_category", "source_rank",
  "has_stages", "sleep_onset_at", "wake_at", "asleep_union_minutes", "in_bed_union_minutes", "awake_minutes",
  "stage_minutes_json", "segment_count", "provenance_json"
] as const;

const HRV_COLUMNS = [
  "id", "local_date", "timezone_identifier", "night_id", "hrv_sdnn_ms", "sample_count", "confidence",
  "window_start_at", "window_end_at", "source_name", "provenance_json"
] as const;

function selectNights(store: RaiDatabase, columns: readonly string[], where?: string): Array<Record<string, unknown>> {
  const sql = `SELECT ${columns.join(",")} FROM canonical_nights${where ? ` WHERE ${where}` : ""} ORDER BY wake_date, kind, source_name, id`;
  return store.database.prepare(sql).all() as unknown as Array<Record<string, unknown>>;
}

function selectHrv(store: RaiDatabase, columns: readonly string[], where?: string): Array<Record<string, unknown>> {
  const sql = `SELECT ${columns.join(",")} FROM canonical_hrv_days${where ? ` WHERE ${where}` : ""} ORDER BY local_date, id`;
  return store.database.prepare(sql).all() as unknown as Array<Record<string, unknown>>;
}

function stampArrival(store: RaiDatabase, instant: string): void {
  store.database.prepare("UPDATE canonical_nights SET computed_at = ?").run(instant);
  store.database.prepare("UPDATE canonical_hrv_days SET computed_at = ?").run(instant);
}

test("windowed output equals the full rebuild for every wake_date inside the window (column by column)", async () => {
  await withDatabase((store) => {
    seedFixture(store);
    const full = canonicalizeNights(store.database, TIMEZONE);
    assert.equal(full.mainCount, 4);
    assert.equal(full.napCount, 1);
    assert.equal(full.hrvCount, 4);
    assert.equal(full.rejectedInBedOnly, 1);

    const window = "wake_date BETWEEN '2026-09-02' AND '2026-09-03'";
    const baselineNights = selectNights(store, NIGHT_COLUMNS, window);
    const baselineHrv = selectHrv(store, HRV_COLUMNS, "local_date BETWEEN '2026-09-02' AND '2026-09-03'");
    assert.ok(baselineNights.length >= 3, "fixture must produce main 09-02, main + nap 09-03");

    const result = canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-02", "2026-09-03");
    assert.equal(result.mainCount, 2);
    assert.equal(result.napCount, 1);
    assert.equal(result.hrvCount, 2);

    assert.deepEqual(selectNights(store, NIGHT_COLUMNS, window), baselineNights);
    assert.deepEqual(selectHrv(store, HRV_COLUMNS, "local_date BETWEEN '2026-09-02' AND '2026-09-03'"), baselineHrv);
  });
});

test("windowed can run standalone (no prior full rebuild) and still matches a full rebuild", async () => {
  await withDatabase((store) => {
    seedFixture(store);
    // 表此时是空的：windowed 必须能在没有任何既有 canonical 行时独立产出。
    const standalone = canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-01", "2026-09-04");
    assert.equal(standalone.mainCount, 4);
    assert.equal(standalone.napCount, 1);
    assert.equal(standalone.hrvCount, 4);
    const window = "wake_date BETWEEN '2026-09-01' AND '2026-09-04'";
    const windowedNights = selectNights(store, NIGHT_COLUMNS, window);
    const windowedHrv = selectHrv(store, HRV_COLUMNS, "local_date BETWEEN '2026-09-01' AND '2026-09-04'");

    // 同一份 fixture 上改为全量重建（全量重建与既有行无关），作为独立基准。
    canonicalizeNights(store.database, TIMEZONE);
    assert.deepEqual(selectNights(store, NIGHT_COLUMNS, window), windowedNights);
    assert.deepEqual(selectHrv(store, HRV_COLUMNS, "local_date BETWEEN '2026-09-01' AND '2026-09-04'"), windowedHrv);
  });
});

/**
 * ⚠️ 假绿对照：把窗口内一行**改坏**，再跑 windowed。
 *
 * 这条防的是：windowed 若只是"跳过重算"或"只重算别的行"，那么"逐列相同"会因为
 * 库里本来就是全量重建过的正确值而**假绿**。这里先注入一个绝不可能是基准值的错值，
 * 断言它被修回基准 —— 证明窗口内确实发生了删除 + 重算。
 */
test("windowed repairs a deliberately corrupted window row (guards against a no-op false green)", async () => {
  await withDatabase((store) => {
    seedFixture(store);
    canonicalizeNights(store.database, TIMEZONE);
    const target = store.database.prepare(
      "SELECT id, asleep_union_minutes AS m FROM canonical_nights WHERE wake_date = '2026-09-02' AND kind = 'main'"
    ).get() as { id: string; m: number };
    const correct = Number(target.m);

    // 注入明显错误的"睡眠时长"；真实来源段没有被改动。
    store.database.prepare("UPDATE canonical_nights SET asleep_union_minutes = ? WHERE id = ?")
      .run(12345, target.id);
    assert.equal(
      Number((store.database.prepare("SELECT asleep_union_minutes AS m FROM canonical_nights WHERE id = ?").get(target.id) as { m: number }).m),
      12345
    );

    canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-02", "2026-09-03");

    const repaired = store.database.prepare("SELECT asleep_union_minutes AS m FROM canonical_nights WHERE id = ?").get(target.id) as { m: number };
    assert.equal(
      Number(repaired.m), correct,
      "windowed 必须把窗口内的坏行重算回正确值；若仍是 12345，说明它根本没重算（此时'逐列相同'是假绿）"
    );
  });
});

test("rows outside the window are left byte-identical, including computed_at", async () => {
  await withDatabase((store) => {
    seedFixture(store);
    canonicalizeNights(store.database, TIMEZONE);
    const ARRIVED_LONG_AGO = "2020-01-01T00:00:00.000Z";
    stampArrival(store, ARRIVED_LONG_AGO);
    const outside = "wake_date NOT BETWEEN '2026-09-02' AND '2026-09-03'";
    const nightsBefore = selectNights(store, [...NIGHT_COLUMNS, "computed_at"], outside);
    const hrvBefore = selectHrv(store, [...HRV_COLUMNS, "computed_at"], "local_date NOT BETWEEN '2026-09-02' AND '2026-09-03'");
    assert.ok(nightsBefore.length > 0, "fixture must have rows outside the window (09-01, 09-04)");

    canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-02", "2026-09-03");

    assert.deepEqual(
      selectNights(store, [...NIGHT_COLUMNS, "computed_at"], outside), nightsBefore,
      "窗口外的 night 行（含 computed_at）一个字节都不许变"
    );
    assert.deepEqual(
      selectHrv(store, [...HRV_COLUMNS, "computed_at"], "local_date NOT BETWEEN '2026-09-02' AND '2026-09-03'"), hrvBefore,
      "窗口外的 hrv 行（含 computed_at）一个字节都不许变"
    );

    // 窗口内、事实未变的行：旧到达时间必须被保留（指纹未变）。
    const insideArrivals = selectNights(store, ["id", "computed_at"], "wake_date BETWEEN '2026-09-02' AND '2026-09-03'");
    assert.ok(insideArrivals.length > 0);
    assert.ok(
      insideArrivals.every((row) => row.computed_at === ARRIVED_LONG_AGO),
      "窗口内事实未变的行也必须保住原到达时间，否则 readiness 的历史可得性会退化"
    );
  });
});

test("re-running the same window is idempotent (rows and computed_at unchanged)", async () => {
  await withDatabase((store) => {
    seedFixture(store);
    canonicalizeNights(store.database, TIMEZONE);
    canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-02", "2026-09-03");
    const first = selectNights(store, [...NIGHT_COLUMNS, "computed_at"]);
    const firstHrv = selectHrv(store, [...HRV_COLUMNS, "computed_at"]);

    canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-02", "2026-09-03");

    assert.deepEqual(selectNights(store, [...NIGHT_COLUMNS, "computed_at"]), first);
    assert.deepEqual(selectHrv(store, [...HRV_COLUMNS, "computed_at"]), firstHrv);
  });
});

test("an empty window (no nights in range) is a no-op and touches nothing", async () => {
  await withDatabase((store) => {
    seedFixture(store);
    canonicalizeNights(store.database, TIMEZONE);
    stampArrival(store, "2020-01-01T00:00:00.000Z");
    const nightsBefore = selectNights(store, [...NIGHT_COLUMNS, "computed_at"]);
    const hrvBefore = selectHrv(store, [...HRV_COLUMNS, "computed_at"]);

    const result = canonicalizeNightsForWindow(store.database, TIMEZONE, "2027-01-01", "2027-01-02");

    assert.deepEqual(result, { mainCount: 0, napCount: 0, hrvCount: 0, rejectedInBedOnly: 0, timezoneIdentifier: TIMEZONE });
    assert.deepEqual(selectNights(store, [...NIGHT_COLUMNS, "computed_at"]), nightsBefore);
    assert.deepEqual(selectHrv(store, [...HRV_COLUMNS, "computed_at"]), hrvBefore);
  });
});

test("a window over an empty database yields an empty result (both windowed and full)", async () => {
  await withDatabase((store) => {
    const windowed = canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-01", "2026-09-03");
    assert.deepEqual(windowed, { mainCount: 0, napCount: 0, hrvCount: 0, rejectedInBedOnly: 0, timezoneIdentifier: TIMEZONE });
    const full = canonicalizeNights(store.database, TIMEZONE);
    assert.deepEqual(full, { mainCount: 0, napCount: 0, hrvCount: 0, rejectedInBedOnly: 0, timezoneIdentifier: TIMEZONE });
    assert.equal((store.database.prepare("SELECT COUNT(*) AS n FROM canonical_nights").get() as { n: number }).n, 0);
    assert.equal((store.database.prepare("SELECT COUNT(*) AS n FROM canonical_hrv_days").get() as { n: number }).n, 0);
  });
});

test("fromLocalDate > toLocalDate is an explicit no-op", async () => {
  await withDatabase((store) => {
    seedFixture(store);
    canonicalizeNights(store.database, TIMEZONE);
    const nightsBefore = selectNights(store, [...NIGHT_COLUMNS, "computed_at"]);

    const result = canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-03", "2026-09-01");

    assert.deepEqual(
      result, { mainCount: 0, napCount: 0, hrvCount: 0, rejectedInBedOnly: 0, timezoneIdentifier: TIMEZONE },
      "from > to 必须是显式空操作"
    );
    assert.deepEqual(selectNights(store, [...NIGHT_COLUMNS, "computed_at"]), nightsBefore);
  });
});

/**
 * FK 级联是唯一能绕过"窗口外一个字节不改"的路径：
 * `canonical_hrv_days.night_id → canonical_nights(id) ON DELETE CASCADE`。
 * 生产路径下 `hrv.local_date == night.wake_date` 恒成立，所以级联只会波及窗口内；
 * 但这条不变量没有约束守护。一旦被破坏（窗口外的 hrv 行指向窗口内的 night），
 * 删除窗口内 night 会级联删掉窗口外的 hrv 行。
 *
 * 本函数选择**显式拒跑**（开事务前抛错）而不是静默改窗口外的行 —— 这条用例把它钉住：
 * 抛错，且**任何一行都没变**（含那条被破坏的窗口外 hrv 行）。
 */
test("refuses instead of silently cascading into out-of-window hrv rows", async () => {
  await withDatabase((store) => {
    seedFixture(store);
    canonicalizeNights(store.database, TIMEZONE);
    const target = store.database.prepare("SELECT id FROM canonical_hrv_days WHERE local_date = '2026-09-02'").get() as { id: string };
    // 破坏不变量：把窗口内 hrv 行的 local_date 挪到窗口外（night_id 仍指向窗口内的 night）。
    store.database.prepare("UPDATE canonical_hrv_days SET local_date = '2026-08-01' WHERE id = ?").run(target.id);

    const nightsBefore = selectNights(store, [...NIGHT_COLUMNS, "computed_at"]);
    const hrvBefore = selectHrv(store, [...HRV_COLUMNS, "computed_at"]);
    assert.equal(hrvBefore.length, 4);

    assert.throws(
      () => canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-02", "2026-09-03"),
      /cascade-delete a row outside the window/,
      "探测到跨窗口级联时必须拒跑"
    );

    assert.deepEqual(selectNights(store, [...NIGHT_COLUMNS, "computed_at"]), nightsBefore, "拒跑后 night 行必须原样");
    assert.deepEqual(
      selectHrv(store, [...HRV_COLUMNS, "computed_at"]), hrvBefore,
      "拒跑后 hrv 行（含那条窗口外的）必须原样 —— 否则就是静默改了窗口外的行"
    );
  });
});

/**
 * 绝对 golden：差分的预言机是"全量重建"，所以若**全量路径本身**回归，上面那条差分门禁
 * 会照样绿（它比的是同进程刚算出来的错基准）。这条用**手算**的期望值钉住基准自身：
 * 一个主夜（InBed 跨本地午夜）、它的 HRV 行（sparse）、以及午睡 pass 产出的 nap 行，
 * 各写死一组绝对期望。两边同时坏才会红 —— 差分永远差不出"基准坏了"。
 *
 * 手算依据（Asia/Shanghai = UTC+8，fixture 见 `seedFixture`）：
 * - 09-02 主夜：InBed 09-01 22:00→09-02 08:00 local = 14:00Z→00:00Z（跨午夜，600 min）；
 *   AsleepCore 09-01 22:30→09-02 06:30 local = 14:30Z→22:30Z（480 min）；无 Awake。
 * - 09-02 的 HRV：仅 1 个样本（09-01T15:00Z=50）落在 [onset 14:30Z, wake 22:30Z] ⇒ sparse。
 * - 09-03 午睡：AsleepCore 15:00→16:00 local = 07:00Z→08:00Z ⇒ nap，60 min，走 14:00–18:00 pass。
 *
 * ⚠️ 与 `canonicalize-nights-range.test.ts` 存在**部分耦合**：那个文件也写死了绝对期望
 * （`asleep_union_minutes===480`、`mainCount`、`CANONICAL_NIGHT_ALGORITHM_VERSION`）。
 * 两者钉的**重叠**部分（如并集分钟数、跨午夜窗口边界）被任一共享核心改动触碰时，两处都要改；
 * 而本文件独有的部分（nap、HRV `confidence`、`source_rank`）改了只影响本文件。
 * 精确起见：`sourceRank` 属于后者 —— 改它只会让本文件变红，range 文件不钉 `source_rank`。
 * 漏改一处是**变红**（不是静默假绿）；若 team-lead 想收敛成单一常量模块，可另开改动。
 */
test("hand-computed golden values pin the full rebuild baseline itself", async () => {
  await withDatabase((store) => {
    seedFixture(store);
    canonicalizeNights(store.database, TIMEZONE);

    const main = { ...(store.database.prepare(`SELECT wake_date, kind, source_name, source_category, source_rank,
      has_stages, sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
      stage_minutes_json, segment_count, provenance_json
      FROM canonical_nights WHERE wake_date = '2026-09-02' AND kind = 'main'`).get() as Record<string, unknown>) };
    assert.deepEqual(main, {
      wake_date: "2026-09-02", kind: "main", source_name: "Watch", source_category: "apple_watch", source_rank: 1,
      has_stages: 1, sleep_onset_at: "2026-09-01T14:30:00.000Z", wake_at: "2026-09-01T22:30:00.000Z",
      asleep_union_minutes: 480, in_bed_union_minutes: 600, awake_minutes: null,
      stage_minutes_json: '{"core":480,"deep":0,"rem":0,"unspecified":0,"awake":0}', segment_count: 2,
      provenance_json: '{"algorithmVersion":"canonical-night-v2","competingSourceCount":1,"rejectedInBedOnly":false}'
    });

    const mainId = (store.database.prepare("SELECT id FROM canonical_nights WHERE wake_date = '2026-09-02' AND kind = 'main'").get() as { id: string }).id;
    const hrv = { ...(store.database.prepare(`SELECT local_date, timezone_identifier, night_id, hrv_sdnn_ms, sample_count,
      confidence, window_start_at, window_end_at, source_name, provenance_json
      FROM canonical_hrv_days WHERE local_date = '2026-09-02'`).get() as Record<string, unknown>) };
    assert.deepEqual(hrv, {
      local_date: "2026-09-02", timezone_identifier: TIMEZONE, night_id: mainId, hrv_sdnn_ms: 50, sample_count: 1,
      confidence: "sparse", window_start_at: "2026-09-01T14:30:00.000Z", window_end_at: "2026-09-01T22:30:00.000Z",
      source_name: "Watch", provenance_json: '{"algorithmVersion":"canonical-night-v2","fallbackWatch":false}'
    });

    const nap = { ...(store.database.prepare(`SELECT wake_date, kind, source_name, source_category, source_rank, has_stages,
      sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes, stage_minutes_json,
      segment_count, provenance_json FROM canonical_nights WHERE wake_date = '2026-09-03' AND kind = 'nap'`).get() as Record<string, unknown>) };
    assert.deepEqual(nap, {
      wake_date: "2026-09-03", kind: "nap", source_name: "Watch", source_category: "apple_watch", source_rank: 1,
      has_stages: 1, sleep_onset_at: "2026-09-03T07:00:00.000Z", wake_at: "2026-09-03T08:00:00.000Z",
      asleep_union_minutes: 60, in_bed_union_minutes: null, awake_minutes: null,
      stage_minutes_json: '{"core":60,"deep":0,"rem":0,"unspecified":0,"awake":0}', segment_count: 1,
      // ⚠️ `competingSourceCount: 0` 在这里是**既有语义怪癖**，不是"没有竞争来源"的通用表达，
      // 读 provenance 的人不要照这句话反推：
      //   · 夜内 nap（`sessions` 切分那条 pass）传 `sourceGroups.length`（`canonicalize-nights.ts:277`）；
      //   · **午后 nap pass 传字面量 0**（同文件 `:316`）。
      // 即 0 只说明"这条走的是午后那条 pass"，不说明"没有竞争来源"。本条 golden 钉的正是 `:316`。
      // 将来若统一两处语义，请同时改这条 golden 与 provenance 契约（本次只搬移、未改语义）。
      provenance_json: '{"algorithmVersion":"canonical-night-v2","competingSourceCount":0,"rejectedInBedOnly":false}'
    });
  });
});

/**
 * 手算 golden 的第二组：把绝对锚从"只有形状 A"扩到 **形状 B 与 C**。
 *
 * 没有这组时，B/C 的绝对锚只剩各自一条前置断言（赢家是谁 / main=2,nap=2），粒度太粗：
 * 凡"全量与窗口化同坏、且不改动那条前置量"的回归都会绿。这里给 B 的主夜、C 的主夜与夜内 nap
 * 各写死一组手算期望，把基准锚到 3 个形状。
 *
 * 手算依据（fixture 见 `seedCompetingSources` / `seedSplitSessionsWithBoundaryHrv`）：
 * - 形状 B（wake 2026-10-02，赢家 WatchB 段数决胜）：asleep1 15:30Z→19:00Z=210min(core)、
 *   asleep2 19:30Z→22:30Z=180min(deep)；无 InBed；onset 15:30Z、wake 22:30Z；段数 2；4 个来源竞争。
 * - 形状 C（wake 2026-11-02）：session1=[InBed 14:00Z→17:00Z, asleep1 14:30Z→17:00Z] ⇒ main
 *   （asleep 150、inBed 180、段数 2）；session2=[asleep2 19:30Z→20:30Z] ⇒ 夜内 nap（asleep 60、段数 1、deep）。
 */
test("hand-computed golden values also pin shapes B and C", async () => {
  await withDatabase((store) => {
    seedCompetingSources(store);
    canonicalizeNights(store.database, TIMEZONE);
    const bMain = { ...(store.database.prepare(`SELECT wake_date, kind, source_name, source_category, source_rank,
      has_stages, sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
      stage_minutes_json, segment_count, provenance_json
      FROM canonical_nights WHERE wake_date = '2026-10-02' AND kind = 'main'`).get() as Record<string, unknown>) };
    assert.deepEqual(bMain, {
      wake_date: "2026-10-02", kind: "main", source_name: "WatchB", source_category: "apple_watch", source_rank: 1,
      has_stages: 1, sleep_onset_at: "2026-10-01T15:30:00.000Z", wake_at: "2026-10-01T22:30:00.000Z",
      asleep_union_minutes: 390, in_bed_union_minutes: null, awake_minutes: null,
      stage_minutes_json: '{"core":210,"deep":180,"rem":0,"unspecified":0,"awake":0}', segment_count: 2,
      provenance_json: '{"algorithmVersion":"canonical-night-v2","competingSourceCount":4,"rejectedInBedOnly":false}'
    });
  });
  await withDatabase((store) => {
    seedSplitSessionsWithBoundaryHrv(store);
    canonicalizeNights(store.database, TIMEZONE);
    const cMain = { ...(store.database.prepare(`SELECT wake_date, kind, source_name, source_category, source_rank,
      has_stages, sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
      stage_minutes_json, segment_count, provenance_json
      FROM canonical_nights WHERE wake_date = '2026-11-02' AND kind = 'main'`).get() as Record<string, unknown>) };
    assert.deepEqual(cMain, {
      wake_date: "2026-11-02", kind: "main", source_name: "Watch", source_category: "apple_watch", source_rank: 1,
      has_stages: 1, sleep_onset_at: "2026-11-01T14:30:00.000Z", wake_at: "2026-11-01T17:00:00.000Z",
      asleep_union_minutes: 150, in_bed_union_minutes: 180, awake_minutes: null,
      stage_minutes_json: '{"core":150,"deep":0,"rem":0,"unspecified":0,"awake":0}', segment_count: 2,
      provenance_json: '{"algorithmVersion":"canonical-night-v2","competingSourceCount":1,"rejectedInBedOnly":false}'
    });
    const cNap = { ...(store.database.prepare(`SELECT wake_date, kind, source_name, source_category, source_rank,
      has_stages, sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
      stage_minutes_json, segment_count, provenance_json
      FROM canonical_nights WHERE wake_date = '2026-11-02' AND kind = 'nap'`).get() as Record<string, unknown>) };
    assert.deepEqual(cNap, {
      wake_date: "2026-11-02", kind: "nap", source_name: "Watch", source_category: "apple_watch", source_rank: 1,
      has_stages: 1, sleep_onset_at: "2026-11-01T19:30:00.000Z", wake_at: "2026-11-01T20:30:00.000Z",
      asleep_union_minutes: 60, in_bed_union_minutes: null, awake_minutes: null,
      stage_minutes_json: '{"core":0,"deep":60,"rem":0,"unspecified":0,"awake":0}', segment_count: 1,
      provenance_json: '{"algorithmVersion":"canonical-night-v2","competingSourceCount":1,"rejectedInBedOnly":false}'
    });
  });
});

/**
 * 常跑门禁：**窗口化重建与全量重建是同一判据的两处实现**（`DELETE ... WHERE wake_date`
 * vs `DELETE` 全表），只改一处就会出现"两种坏法"。一次性抽查（如 red-team 那次 80 窗口
 * 差分探针，跑完即删）不足以守住它 —— 这里把它固化：先全量重建取基准，再对
 * **所有** `a ≤ b` 的子窗口逐个跑窗口化，每次都断言**整张表（所有列 + `computed_at`）
 * 与全量基准逐字节相同**。
 *
 * 为什么断言"整表"而非"窗口内子集"：窗口化对窗口外的行零改动 ⇒ 整表等于基准，
 * 一条断言同时覆盖了"窗口内 = 全量"与"窗口外不变"两个性质。窗口外的空日期
 * 也纳入扫描，钉住"窗口落在任何段之外"的情形。
 *
 * ⚠️ 扫描的维度是**子窗口**；同一份 fixture 只走一条代码路径。所以还要在**多个 fixture 形状**
 * 上各跑一遍同一套扫描（red-team 指出 fixture 覆盖才是真缺口）：A=跨午夜+午睡+sparse HRV、
 * B=同窗口多来源（rank 并列决胜）、C=同晚 >90min 间隔切分 + HRV 端点。每条形状在跑到扫描前，
 * 先断言"它确实走到了目标分支"，否则形状会静默退化成 A 的复制。
 */
function sweepSubWindows(store: RaiDatabase, dates: string[]): void {
  const baselineNights = selectNights(store, [...NIGHT_COLUMNS, "computed_at"]);
  const baselineHrv = selectHrv(store, [...HRV_COLUMNS, "computed_at"]);
  assert.ok(baselineNights.length > 0, "sweep needs a non-trivial baseline");
  let windows = 0;
  for (let from = 0; from < dates.length; from += 1) {
    for (let to = from; to < dates.length; to += 1) {
      const label = `[${dates[from]}, ${dates[to]}]`;
      canonicalizeNightsForWindow(store.database, TIMEZONE, dates[from]!, dates[to]!);
      windows += 1;
      assert.deepEqual(selectNights(store, [...NIGHT_COLUMNS, "computed_at"]), baselineNights, `night rows diverged from the full rebuild after window ${label}`);
      assert.deepEqual(selectHrv(store, [...HRV_COLUMNS, "computed_at"]), baselineHrv, `hrv rows diverged from the full rebuild after window ${label}`);
    }
  }
  assert.equal(windows, (dates.length * (dates.length + 1)) / 2);
}

const SWEEP_DATES = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
const COMPETING_SWEEP_DATES = ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const SPLIT_SWEEP_DATES = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"];

test("sweep over every sub-window — shape A (cross-midnight night + nap + sparse HRV)", async () => {
  await withDatabase((store) => {
    seedFixture(store);
    canonicalizeNights(store.database, TIMEZONE);
    assert.ok(selectNights(store, ["id"]).length >= 5, "sweep needs a non-trivial baseline");
    sweepSubWindows(store, SWEEP_DATES);
  });
});

test("sweep over every sub-window — shape B (multiple Asleep sources ⇒ rank tie-break, competingSourceCount > 1)", async () => {
  await withDatabase((store) => {
    seedCompetingSources(store);
    canonicalizeNights(store.database, TIMEZONE);
    // 先证明形状 B 真走到了并列决胜：赢家是段数更多的 WatchB（不是分钟数更多的 WatchA/COROS）。
    const winners = store.database.prepare("SELECT DISTINCT source_name AS s FROM canonical_nights WHERE kind = 'main'").all() as Array<{ s: string }>;
    assert.deepEqual(winners.map((row) => row.s), ["WatchB"], "rank 并列时应按 asleep 段数决胜");
    const competing = store.database.prepare("SELECT DISTINCT json_extract(provenance_json, '$.competingSourceCount') AS c FROM canonical_nights WHERE kind = 'main'").all() as Array<{ c: number }>;
    assert.deepEqual(competing.map((row) => Number(row.c)), [4], "competingSourceCount 必须 > 1（fixture A 永远走不到）");
    sweepSubWindows(store, COMPETING_SWEEP_DATES);
  });
});

test("sweep over every sub-window — shape C (sessions split by >90min gap + HRV on the closed-interval endpoints)", async () => {
  await withDatabase((store) => {
    seedSplitSessionsWithBoundaryHrv(store);
    canonicalizeNights(store.database, TIMEZONE);
    // 先证明形状 C 真触发了切分（每晚 main + 夜内 nap）与闭区间端点（样本恰在 onset/wake ⇒ 各 2 个 ⇒ confident）。
    const kinds = store.database.prepare("SELECT kind, COUNT(*) AS n FROM canonical_nights GROUP BY kind ORDER BY kind").all() as Array<{ kind: string; n: number }>;
    assert.deepEqual(kinds.map((row) => ({ kind: row.kind, n: Number(row.n) })),
      [{ kind: "main", n: 4 }, { kind: "nap", n: 3 }],
      ">90min 间隔必须把一晚切成 main + nap（gap=89min 不切、gap=91min 切）");
    // 90min 阈值边界：gap=89min 的 11-05 无 nap；gap=91min 的 11-06 有 nap。阈值改为 60/120 会让此断言变红。
    const napsPerDate = store.database.prepare("SELECT wake_date AS d, SUM(CASE WHEN kind = 'nap' THEN 1 ELSE 0 END) AS naps FROM canonical_nights GROUP BY wake_date ORDER BY wake_date").all() as Array<{ d: string; naps: number }>;
    assert.deepEqual(napsPerDate.map((row) => ({ d: row.d, naps: Number(row.naps) })), [
      { d: "2026-11-02", naps: 1 }, { d: "2026-11-03", naps: 1 }, { d: "2026-11-05", naps: 0 }, { d: "2026-11-06", naps: 1 }
    ], "切分阈值必须落在 [89min, 91min)：89min 不切分、91min 切分。阈值改为 60/120 会让此断言变红");
    const hrv = store.database.prepare("SELECT confidence, sample_count FROM canonical_hrv_days ORDER BY local_date").all() as Array<{ confidence: string; sample_count: number }>;
    assert.deepEqual(hrv.map((row) => ({ confidence: row.confidence, sample_count: Number(row.sample_count) })), [
      { confidence: "confident", sample_count: 2 }, { confidence: "confident", sample_count: 2 },
      { confidence: "missing", sample_count: 0 }, { confidence: "missing", sample_count: 0 }
    ], "样本恰在 [onset, wake] 两端点必须计入（闭区间）");
    sweepSubWindows(store, SPLIT_SWEEP_DATES);
  });
});
