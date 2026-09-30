import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";
import { healthTypes, SLEEP_ANALYSIS_VALUES } from "@rai/contracts";

import { CANONICAL_NIGHT_ALGORITHM_VERSION, canonicalizeNights } from "../src/index.js";

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
