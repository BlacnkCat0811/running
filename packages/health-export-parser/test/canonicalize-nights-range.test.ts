import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";
import { healthTypes, localDateTimeAt, SLEEP_ANALYSIS_VALUES } from "@rai/contracts";

import { CANONICAL_NIGHT_ALGORITHM_VERSION, canonicalizeNights, canonicalizeNightsForWindow } from "../src/index.js";
import { loadSegments } from "../src/canonicalize-nights.js";

/**
 * 夜表重建的**日期范围**：v1 只按段的**开始**时刻取范围，而一夜的 InBed/Asleep 段
 * 通常开始于**前一晚**（约 22:00 本地）。只要这一夜里有一段开始于本地午夜之后，
 * 范围就已经覆盖它的 wake date；但如果**所有**段都开始于午夜之前
 * （数据在这一夜中途结束、或这一夜很短），v1 会把整个夜丢掉。
 *
 * ⚠️ 这是**范围截断**，不是"每次导入都丢最近一夜"：本机 3 年真实数据上 v1 与 v2
 * 都产出 170 个主夜（该库末夜恰好有午夜后的段），真实库上的差异是 **0**。
 * 差异由下面这些合成用例钉住 —— 也正是"真实库没暴露、但边界一定会中"的那类缺陷。
 *
 * 顺带钉住版本号：改了产出行集合的算法文本就必须 bump，否则 provenance 失去意义。
 */

const TIMEZONE = "Asia/Shanghai";

async function withDatabase(run: (store: RaiDatabase) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-canonical-nights-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 一夜：InBed 22:00→次日 08:00 本地，Asleep 22:30→次日 06:30 本地。 */
function insertNight(store: RaiDatabase, wakeDate: string): void {
  const previous = new Date(`${wakeDate}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const evening = previous.toISOString().slice(0, 10);
  const insert = store.database.prepare(`INSERT INTO health_records
    (id,type,source_name,source_category,unit,value_text,start_at,end_at,metadata_json,raw_attributes_json)
    VALUES (?,?,'Watch','apple_watch','',?,?,?,'{}','{}')`);
  // 22:00 本地 = 14:00Z；次日 08:00 本地 = 00:00Z。
  insert.run(`inbed-${wakeDate}`, healthTypes.sleepAnalysis, SLEEP_ANALYSIS_VALUES.inBed, `${evening}T14:00:00Z`, `${wakeDate}T00:00:00Z`);
  insert.run(`asleep-${wakeDate}`, healthTypes.sleepAnalysis, SLEEP_ANALYSIS_VALUES.asleepCore, `${evening}T14:30:00Z`, `${evening}T22:30:00Z`);
}

test("the most recent night is not dropped just because its segments start the evening before", async () => {
  await withDatabase((store) => {
    for (const wakeDate of ["2026-09-01", "2026-09-02", "2026-09-03"]) insertNight(store, wakeDate);
    const result = canonicalizeNights(store.database, TIMEZONE);
    // v1 在这里只产出 2 夜（丢掉 09-03）。v2 必须三夜都在。
    assert.equal(result.mainCount, 3, `expected all three nights, got ${result.mainCount}`);
    const wakes = (store.database.prepare("SELECT wake_date AS d FROM canonical_nights ORDER BY wake_date").all() as Array<{ d: string }>)
      .map((row) => String(row.d));
    assert.deepEqual(wakes, ["2026-09-01", "2026-09-02", "2026-09-03"]);
  });
});

test("a single night with no following segment still lands in the table", async () => {
  await withDatabase((store) => {
    // 这正是"只有一个夜、没有午睡、没有后半夜片段"的常见形态：
    // 所有段的开始时刻都在前一晚，v1 下 maxDate 会小于它的 wake date。
    insertNight(store, "2026-09-10");
    const result = canonicalizeNights(store.database, TIMEZONE);
    assert.equal(result.mainCount, 1);
    assert.equal(result.napCount, 0);
    const row = store.database.prepare("SELECT wake_date AS d, asleep_union_minutes AS m FROM canonical_nights").get() as
      { d: string; m: number };
    assert.equal(String(row.d), "2026-09-10");
    assert.equal(Number(row.m), 480);
  });
});

test("each rebuilt row records which algorithm version produced it", async () => {
  await withDatabase((store) => {
    insertNight(store, "2026-09-10");
    canonicalizeNights(store.database, TIMEZONE);
    const provenance = JSON.parse(String((store.database.prepare("SELECT provenance_json AS p FROM canonical_nights").get() as { p: string }).p)) as
      { algorithmVersion: string };
    assert.equal(provenance.algorithmVersion, CANONICAL_NIGHT_ALGORITHM_VERSION);
    assert.equal(CANONICAL_NIGHT_ALGORITHM_VERSION, "canonical-night-v2");
  });
});

test("the rebuild is still a full replace, so a re-run produces the same rows", async () => {
  await withDatabase((store) => {
    for (const wakeDate of ["2026-09-01", "2026-09-02"]) insertNight(store, wakeDate);
    const first = canonicalizeNights(store.database, TIMEZONE);
    const snapshot = store.database.prepare("SELECT id, wake_date, asleep_union_minutes FROM canonical_nights ORDER BY id").all();
    const second = canonicalizeNights(store.database, TIMEZONE);
    assert.deepEqual(second, first);
    assert.deepEqual(store.database.prepare("SELECT id, wake_date, asleep_union_minutes FROM canonical_nights ORDER BY id").all(), snapshot);
  });
});

/**
 * §15.3「事实可得时间」/ 证据可追溯 —— **`computed_at` 就是到达时间**。
 *
 * `packages/application/src/model-v2-snapshots.ts` 读的是 `computed_at AS availableAt`，
 * 而 readiness 只在 `availableAt <= asOf` 时承认一条事实可得。可是本函数是
 * 全量 `DELETE` + 重建，两条 INSERT 都**不带** `computed_at`（列有 DEFAULT now），
 * 于是每次重建都把**全部行**的到达时间改写成"现在"。
 *
 * ⚠️ **两条实测限定，别把症状说过头**（独立探针在修复前的修订上复现，20/20 断言）：
 * 1. 退化成 `coverage:"none"/state:"not_assessed"` 需要 RHR 通道**同时**不可得。
 *    带上 RHR 与 `import_manifest` 时（更接近真实库）可观测的是 `complete → partial`、
 *    sleep/hrv 的 value 变 null，而 **state 字符串仍然是 `no_low_signal`** ——
 *    结论没变、证据基础悄悄减半，这比字符串变差更难被发现。
 * 2. 触发点不是"第二次导入"：**第一次**重建就已经把 `now` 盖在属于过去的行上，
 *    所以对历史库做一次全新重建就会丢掉全部历史日。
 *    修复只能保住**本来就存在**的到达时间，不能、也不该凭空把后来的事实说成早就到了。
 *
 * 判据是**内容**，不是 id 在不在：只按 id 保留会把"被更正过的旧事实"
 * 伪装成"当时就知道"，那是往未来泄漏的反方向错。
 *
 * 这两条用例不依赖墙上时钟：先把到达时间改成一个可辨认的哨兵值，
 * 再重建，看它是否被保留（事实未变）或被刷新（事实变了）。
 */
const ARRIVED_LONG_AGO = "2020-01-01T00:00:00.000Z";

function stampArrival(store: RaiDatabase, instant: string): void {
  store.database.prepare("UPDATE canonical_nights SET computed_at = ?").run(instant);
  store.database.prepare("UPDATE canonical_hrv_days SET computed_at = ?").run(instant);
}

test("an unchanged fact keeps its original arrival time across a rebuild", async () => {
  await withDatabase((store) => {
    for (const wakeDate of ["2026-09-01", "2026-09-02"]) insertNight(store, wakeDate);
    canonicalizeNights(store.database, TIMEZONE);
    // 这两夜是"很久以前就导进来的"。
    stampArrival(store, ARRIVED_LONG_AGO);
    const before = store.database.prepare("SELECT id, computed_at FROM canonical_nights ORDER BY id").all();
    assert.ok(before.length > 0);
    assert.ok(before.every((row) => (row as { computed_at: string }).computed_at === ARRIVED_LONG_AGO));

    // 第二次导入：原样重算，事实一条没变。
    canonicalizeNights(store.database, TIMEZONE);

    const after = store.database.prepare("SELECT id, computed_at FROM canonical_nights ORDER BY id").all();
    assert.deepEqual(
      after, before,
      "事实未变 ⇒ 到达时间必须原样保留；被刷成 now 会让所有历史日无法按当时可得性评估"
    );
  });
});

test("a corrected fact arrives now, not when the old value arrived", async () => {
  await withDatabase((store) => {
    insertNight(store, "2026-09-01");
    canonicalizeNights(store.database, TIMEZONE);
    stampArrival(store, ARRIVED_LONG_AGO);

    // 更正：把 Asleep 段改短（睡眠时长这条事实变了）。
    store.database.prepare("UPDATE health_records SET end_at = ? WHERE id = ?")
      .run("2026-08-31T20:30:00Z", "asleep-2026-09-01");
    canonicalizeNights(store.database, TIMEZONE);

    const rows = store.database.prepare("SELECT id, computed_at FROM canonical_nights").all() as
      Array<{ id: string; computed_at: string }>;
    assert.equal(rows.length, 1);
    assert.notEqual(
      rows[0]!.computed_at, ARRIVED_LONG_AGO,
      "事实被更正 ⇒ 新值确实是现在到的；沿用旧到达时间等于把后来才知道的值说成当时就知道"
    );
  });
});

/* ================================================================================================
 * O10（WP-31）：范围化读取之后，**全量入口的语义不变**与**窗口路径的到达时间语义不变**
 *
 * 范围参数是**可选**的：只有 `canonicalizeNightsForWindow` 传它，`canonicalizeNights`（离线全量）
 * 必须继续无过滤地读全表。否则"局部重建"的优化会反向污染全量重建 —— 而全量入口是差分门禁的
 * **预言机**（窗口化的正确性就是"与全量相同"），预言机悄悄变窄会让整套窗口回归失去意义。
 *
 * 到达时间（§15.3）在窗口路径上多了一层易错点：窗口边界现在由 SQL 文本谓词决定，
 * 若谓词把某条记录判在窗口外，它所在的那一夜会被 DELETE 后**重建为空**，
 * 其 `computed_at` 也随之被抹掉 —— 所以这里用"边界段 + 到达时间哨兵"把两侧一起钉住。
 * ============================================================================================== */

/** 窗口 `[2026-09-02, 2026-09-03]` 的生产范围（与窗口测试同一口径）。 */
const WINDOW_RANGE_START = localDateTimeAt("2026-09-01T18:00:00", TIMEZONE);
const WINDOW_RANGE_END = localDateTimeAt("2026-09-03T18:00:00", TIMEZONE);

function insertSleep(store: RaiDatabase, id: string, value: string, startAt: string, endAt: string): void {
  store.database.prepare(`INSERT INTO health_records
    (id,type,source_name,source_category,unit,value_text,start_at,end_at,metadata_json,raw_attributes_json)
    VALUES (?,?,'Watch','apple_watch','',?,?,?,'{}','{}')`).run(id, healthTypes.sleepAnalysis, value, startAt, endAt);
}

test("the full rebuild entry point keeps reading the whole history (the range parameter is opt-in)", async () => {
  await withDatabase((store) => {
    // 两夜相隔两年：任何"窗口化"的读取范围都不可能同时覆盖它们。
    insertNight(store, "2024-09-01");
    insertNight(store, "2026-09-10");
    const all = loadSegments(store.database);
    assert.equal(all.length, 4, "无 range 的加载器必须读全表（两夜 × 2 段）");

    const result = canonicalizeNights(store.database, TIMEZONE);
    assert.equal(result.mainCount, 2, "全量重建必须把相隔两年的两夜都算出来");
    const wakes = (store.database.prepare("SELECT wake_date AS d FROM canonical_nights ORDER BY wake_date").all() as Array<{ d: string }>)
      .map((row) => String(row.d));
    assert.deepEqual(wakes, ["2024-09-01", "2026-09-10"]);
  });
});

test("the windowed rebuild keeps arrival times under the range-scoped boundary math", async () => {
  await withDatabase((store) => {
    insertNight(store, "2026-09-02");
    // 窗口外的对照夜（相隔一周，不可能被任何 ±1 天 padding 卷进来）。
    insertNight(store, "2026-09-10");
    // 两条**恰好压在窗口边界**上的段：`end == rangeStart` 与 `start == rangeEnd`，历史语义
    // 都必须判在窗口外。若范围谓词被写成 `>=` / `<=`，它们会进窗口并把边界夜重建成别的值。
    insertSleep(store, "edge-ends-at-range-start", SLEEP_ANALYSIS_VALUES.asleepCore,
      "2026-09-01T08:00:00.000Z", new Date(Date.parse(WINDOW_RANGE_START)).toISOString());
    insertSleep(store, "edge-starts-at-range-end", SLEEP_ANALYSIS_VALUES.asleepCore,
      new Date(Date.parse(WINDOW_RANGE_END)).toISOString(), "2026-09-03T11:00:00.000Z");

    canonicalizeNights(store.database, TIMEZONE);
    stampArrival(store, ARRIVED_LONG_AGO);
    const outsideBefore = store.database.prepare(
      "SELECT id, computed_at FROM canonical_nights WHERE wake_date NOT BETWEEN '2026-09-02' AND '2026-09-03' ORDER BY id").all();

    canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-02", "2026-09-03");

    // 窗口内事实未变 ⇒ 到达时间原样保留（谓词边界写错会让"未变"变成"消失+重建"，哨兵随之丢失）。
    const inside = store.database.prepare(
      "SELECT id, computed_at FROM canonical_nights WHERE wake_date BETWEEN '2026-09-02' AND '2026-09-03' ORDER BY id").all() as
      Array<{ id: string; computed_at: string }>;
    assert.ok(inside.length > 0, "窗口内必须有行，否则这条用例什么都没证明");
    assert.ok(inside.every((row) => row.computed_at === ARRIVED_LONG_AGO),
      "窗口内事实未变 ⇒ 到达时间必须保留");
    // 窗口外逐字节不变（含到达时间）。
    assert.deepEqual(store.database.prepare(
      "SELECT id, computed_at FROM canonical_nights WHERE wake_date NOT BETWEEN '2026-09-02' AND '2026-09-03' ORDER BY id").all(),
      outsideBefore, "窗口外行连同 computed_at 一个字节都不许变");

    // 更正窗口内的那条夜（Asleep 段改短）⇒ 只有它的到达时间刷新，窗口外仍不动。
    store.database.prepare("UPDATE health_records SET end_at = ? WHERE id = ?")
      .run("2026-09-01T20:30:00.000Z", "asleep-2026-09-02");
    canonicalizeNightsForWindow(store.database, TIMEZONE, "2026-09-02", "2026-09-03");
    const corrected = store.database.prepare(
      "SELECT id, computed_at FROM canonical_nights WHERE wake_date = '2026-09-02'").all() as
      Array<{ id: string; computed_at: string }>;
    assert.ok(corrected.length > 0);
    assert.ok(corrected.every((row) => row.computed_at !== ARRIVED_LONG_AGO),
      "事实被更正 ⇒ 新值确实是现在到的（到达时间必须刷新）");
    assert.deepEqual(store.database.prepare(
      "SELECT id, computed_at FROM canonical_nights WHERE wake_date NOT BETWEEN '2026-09-02' AND '2026-09-03' ORDER BY id").all(),
      outsideBefore, "更正窗口内的夜不得触碰窗口外的行");
  });
});
