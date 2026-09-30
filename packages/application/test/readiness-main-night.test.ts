import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import { loadDatedReadiness } from "../src/model-v2-snapshots.js";

/**
 * §16.1 的 R05：**主夜归属正确，未来时间排除**。
 *
 * `canonical_nights.kind` 有 `main` 与 `nap` 两种，主夜按 (wake_date, timezone) 唯一。
 * 这条测试盯的是消费端那一半：**装配器必须只读主夜**。
 * 一个 150 分钟的午睡如果能被当成"昨晚睡了 150 分钟"，就会变成一个看起来很正常的
 * 恢复结论 —— 而事实是主夜数据没到。这正是"未知不得被读成低值"的反面：
 * 未知也不得被另一条通道读成"有个值"。
 */

const AS_OF = "2026-09-29T08:00:00Z";
const TIMEZONE = "Asia/Shanghai";
const TODAY = "2026-09-29";

/** wake_date = 醒来的本地日期。北京时间 06:00 醒来 ⇒ 前一天 22:00Z。 */
const wakeAtFor = (wakeDate: string): string => {
  const value = new Date(`${wakeDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return `${value.toISOString().slice(0, 10)}T22:00:00Z`;
};

async function withNights(run: (store: RaiDatabase) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-main-night-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    const insert = store.database.prepare(`INSERT INTO canonical_nights
      (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank,
       has_stages, sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
       stage_minutes_json, segment_count, provenance_json, computed_at)
      VALUES (?,?,?,?,?,'apple_watch',1,?,?,?,?,?,?,'{}',1,'{}',?)`);
    // 7 个合格主夜构成个人基线（中位数 450）。
    for (let day = 22; day <= 28; day += 1) {
      const wakeDate = `2026-09-${String(day).padStart(2, "0")}`;
      const wakeAt = wakeAtFor(wakeDate);
      insert.run(`main-${day}`, wakeDate, TIMEZONE, "main", "Watch", 1, wakeAt, wakeAt, 450, 480, 30, wakeAt);
    }
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const addMainToday = (store: RaiDatabase, minutes: number): void => {
  const wakeAt = wakeAtFor(TODAY);
  store.database.prepare(`INSERT INTO canonical_nights
    (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank,
     has_stages, sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
     stage_minutes_json, segment_count, provenance_json, computed_at)
    VALUES (?,?,?,'main','Watch','apple_watch',1,?,?,?,?,?,?,'{}',1,'{}',?)`)
    .run("main-today", TODAY, TIMEZONE, 1, wakeAt, wakeAt, minutes, minutes + 20, 20, wakeAt);
};

const addNapToday = (store: RaiDatabase, minutes: number): void => {
  const wakeAt = wakeAtFor(TODAY);
  store.database.prepare(`INSERT INTO canonical_nights
    (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank,
     has_stages, sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
     stage_minutes_json, segment_count, provenance_json, computed_at)
    VALUES (?,?,?,'nap','Watch','apple_watch',1,?,?,?,?,?,?,'{}',1,'{}',?)`)
    .run("nap-today", TODAY, TIMEZONE, 1, "2026-09-29T05:00:00Z", wakeAt, minutes, minutes + 5, 5, wakeAt);
};

test("R05: a nap cannot stand in for the main night", async () => {
  await withNights((store) => {
    addNapToday(store, 150);
    const readiness = loadDatedReadiness(store.database, AS_OF, TIMEZONE);
    // 只有午睡、没有主夜 ⇒ 今天**没有睡眠证据**，而不是"睡了 150 分钟"。
    assert.equal(readiness.signals.sleep.value, null);
    assert.equal(readiness.signals.sleep.quality, "missing");
    assert.notEqual(readiness.assessment, "no_low_signal");
  });
});

test("R05: the main night wins, and the nap beside it changes nothing", async () => {
  await withNights((store) => {
    addMainToday(store, 300);
    const withoutNap = loadDatedReadiness(store.database, AS_OF, TIMEZONE);
    assert.equal(withoutNap.signals.sleep.value, 300);
    assert.equal(withoutNap.signals.sleep.baseline, 450);

    addNapToday(store, 600);
    const withNap = loadDatedReadiness(store.database, AS_OF, TIMEZONE);
    // 一个比主夜长得多的午睡不得把今天的睡眠"洗"成 600 或 900。
    assert.equal(withNap.signals.sleep.value, withoutNap.signals.sleep.value);
    assert.equal(withNap.signals.sleep.ratio, withoutNap.signals.sleep.ratio);
  });
});

test("R05: a night that has not happened yet cannot become today's evidence", async () => {
  await withNights((store) => {
    addMainToday(store, 300);
    // 明天的主夜（wake_at 晚于 asOf）：本地日期上也不该被今天读到。
    const tomorrow = "2026-09-30";
    const wakeAt = wakeAtFor(tomorrow);
    store.database.prepare(`INSERT INTO canonical_nights
      (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank,
       has_stages, sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
       stage_minutes_json, segment_count, provenance_json, computed_at)
      VALUES (?,?,?,'main','Watch','apple_watch',1,?,?,?,?,?,?,'{}',1,'{}',?)`)
      .run("main-tomorrow", tomorrow, TIMEZONE, 1, wakeAt, wakeAt, 700, 720, 20, wakeAt);

    const readiness = loadDatedReadiness(store.database, AS_OF, TIMEZONE);
    assert.equal(readiness.localDate, TODAY);
    assert.equal(readiness.signals.sleep.value, 300);
    assert.ok(Date.parse(readiness.signals.sleep.observedAt ?? "1970-01-01") <= Date.parse(AS_OF));
    // 明天的夜也不得进入"连续不足"的判据。
    assert.equal(readiness.sleepStreak, false);
  });
});
