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
