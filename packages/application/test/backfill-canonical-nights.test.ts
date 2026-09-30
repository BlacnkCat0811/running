import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";
import { healthTypes, SLEEP_ANALYSIS_VALUES } from "@rai/contracts";

import { backfillCanonicalNights } from "../src/backfill-canonical-nights.js";

/**
 * §7 P0 的事实来源：没有 `canonical_nights` / `canonical_hrv_days`，整条 Readiness 只能拿到
 * `coverage: none`。设计文档写明的启动期回填**从未接线**，所以回填至少要有一个
 * 有守卫、幂等、可观察的入口，并且它的三种结局必须能被测试区分开。
 */

const TIMEZONE = "Asia/Shanghai";

async function withDatabase(run: (store: RaiDatabase) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-backfill-nights-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 一个完整的主夜：入睡段 + 核心睡眠段，足以让 canonicalizer 接受。 */
function insertSleepPair(store: RaiDatabase, wakeDate: string, index: number): void {
  const previous = new Date(`${wakeDate}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const night = previous.toISOString().slice(0, 10);
  const insert = store.database.prepare(`INSERT INTO health_records
    (id,type,source_name,source_category,unit,value_text,start_at,end_at,metadata_json,raw_attributes_json)
    VALUES (?,?,'Watch','apple_watch','',?,?,?,'{}','{}')`);
  insert.run(`sleep-inbed-${index}`, healthTypes.sleepAnalysis, SLEEP_ANALYSIS_VALUES.inBed, `${night}T14:00:00Z`, `${wakeDate}T00:00:00Z`);
  insert.run(`sleep-core-${index}`, healthTypes.sleepAnalysis, SLEEP_ANALYSIS_VALUES.asleepCore, `${night}T14:30:00Z`, `${night}T22:30:00Z`);
}

test("an empty night table with sleep records is backfilled, and running it again is a no-op", async () => {
  await withDatabase((store) => {
    for (const [index, wakeDate] of ["2026-09-01", "2026-09-02", "2026-09-03"].entries()) {
      insertSleepPair(store, wakeDate, index);
    }
    const first = backfillCanonicalNights(store.database, TIMEZONE);
    assert.equal(first.status, "backfilled");
    assert.equal(first.before.nights, 0);
    assert.equal(first.before.sleepRecords, 6);
    // ⚠️ 这里**刻意不写死 3**。`canonicalizeNights` 的日期范围由每个段的**开始时刻**决定
    // （`dates = all.map(s => localDateAt(s.start, tz))`），所以最后一夜会落在范围之外：
    // 三个合成夜只产出 2 个主夜。这是 canonicalizer 的既有边界（见交付记录），
    // 不是本模块的行为。断言"自洽 + 下界"，避免把它的边界钉成"正确"。
    assert.equal(first.after.nights, (first.canonicalization?.mainCount ?? 0) + (first.canonicalization?.napCount ?? 0));
    assert.ok(first.after.nights >= 2, `expected at least 2 nights, got ${first.after.nights}`);
    assert.ok((first.canonicalization?.hrvCount ?? 0) >= 2);

    // 幂等：第二次不得重算，也不得新增行。
    const second = backfillCanonicalNights(store.database, TIMEZONE);
    assert.equal(second.status, "not_needed");
    assert.equal(second.after.nights, first.after.nights);
    assert.equal(second.canonicalization, null);
  });
});

test("a night table with no sleep records reports that, instead of claiming success", async () => {
  await withDatabase((store) => {
    const result = backfillCanonicalNights(store.database, TIMEZONE);
    assert.equal(result.status, "no_sleep_records");
    assert.equal(result.after.nights, 0);
    assert.equal(result.canonicalization, null);
  });
});

test("a database that already has nights is left alone even if sleep records exist", async () => {
  await withDatabase((store) => {
    insertSleepPair(store, "2026-09-01", 0);
    store.database.prepare(`INSERT INTO canonical_nights
      (id,wake_date,timezone_identifier,kind,source_name,source_category,source_rank,has_stages,
       sleep_onset_at,wake_at,asleep_union_minutes,in_bed_union_minutes,awake_minutes,
       stage_minutes_json,segment_count,provenance_json)
      VALUES (?,?,?,'main','Watch','apple_watch',1,?,?,?,?,?,?,'{}',1,'{}')`)
      .run("existing", "2026-09-01", TIMEZONE, 1, "2026-08-31T14:30:00Z", "2026-08-31T22:30:00Z", 480, 500, 20);
    const result = backfillCanonicalNights(store.database, TIMEZONE);
    assert.equal(result.status, "not_needed");
    assert.equal(result.before.nights, 1);
    // 不重算：既有的那一行必须原样保留。
    assert.equal(result.after.nights, 1);
  });
});
