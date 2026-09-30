import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import { assessmentInstantForLocalDate, buildReadinessReplayCoverage } from "../src/readiness-replay-coverage.js";

/**
 * §7.3 / §15.3 / §15.5 的 runner 在**真实库上**跑过之后只剩一条退化路径（0 可评估日），
 * 那证明不了它算得对。这里用一个可控夹具把**非退化**路径钉住：
 * 有一个可评估日、并且两支到达时间假设在这天上给出**不同**裁决。
 */

const TIMEZONE = "Asia/Shanghai";

/** wake_date = 醒来的本地日期；北京时间 06:00 醒来 ⇒ 前一天 22:00Z。 */
const wakeAtFor = (wakeDate: string): string => {
  const value = new Date(`${wakeDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return `${value.toISOString().slice(0, 10)}T22:00:00Z`;
};

const insertNight = (store: RaiDatabase, wakeDate: string, minutes: number, computedAt: string): void => {
  const wakeAt = wakeAtFor(wakeDate);
  store.database.prepare(`INSERT INTO canonical_nights
    (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank,
     has_stages, sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
     stage_minutes_json, segment_count, provenance_json, computed_at)
    VALUES (?,?,?,'main','Watch','apple_watch',1,?,?,?,?,?,?,'{}',1,'{}',?)`)
    .run(`night-${wakeDate}`, wakeDate, TIMEZONE, 1, wakeAt, wakeAt, minutes, minutes + 20, 20, computedAt);
};

async function withDatabase(run: (store: RaiDatabase) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-readiness-coverage-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("the daily assessment instant stays inside its own local day", () => {
  // 这条约定是逐日循环的隐含前提：asOf 若落在次日，事实装配器会去评估次日，
  // 循环就会静默错位（runner 里有断言，但约定本身也值得单独钉住）。
  const instant = assessmentInstantForLocalDate("2026-09-29", TIMEZONE);
  assert.equal(instant, "2026-09-29T15:59:59.999Z");
});

test("an arrival-time difference on the assessed day is reported as leakage, with its reason code", async () => {
  await withDatabase((store) => {
    // 7 个合格夜构成 28 天中位数基线（450 分钟）。
    for (let day = 10; day <= 16; day += 1) {
      const wakeDate = `2026-09-${String(day).padStart(2, "0")}`;
      insertNight(store, wakeDate, 450, wakeAtFor(wakeDate));
    }
    // 目标日：夜很短（ratio 300/450 = 0.667 < 0.75 ⇒ 睡眠低），且**当天结束后很久**才入库。
    // 严格支（真实到达时间）看不到它；"观测即到达"支看得到。
    insertNight(store, "2026-09-18", 300, "2026-09-25T00:00:00Z");
    // 对照日：正常的一夜，**当天早上就入库**。两支都看得到 ⇒ 可比但不分歧。
    // 它把"分母"与"分子"分开，否则 1/1 的结果无法区分是率算对了还是碰巧。
    insertNight(store, "2026-09-19", 450, wakeAtFor("2026-09-19"));

    const coverage = buildReadinessReplayCoverage(store.database, {
      timezone: TIMEZONE,
      fromLocalDate: "2026-09-17",
      toLocalDate: "2026-09-19"
    });
    assert.deepEqual(coverage.window, { fromLocalDate: "2026-09-17", toLocalDate: "2026-09-19", days: 3 });
    assert.equal(coverage.truncatedToRecentDays, false);
    assert.equal(coverage.observedFactDays, 2);
    // 严格支（真实到达时间）在 09-18 当天**什么都判不了**，只判得了 09-19。
    assert.equal(coverage.assessableDays, 1);
    // 但"观测即到达"那一支两天都看得到，所以两天对到达时间假设都是**可比**的，
    // 其中一天裁决被改变 —— 这正是泄漏率必须计入的情形。
    assert.equal(coverage.comparableDays, 2);
    assert.equal(coverage.divergentDays, 1);
    assert.equal(coverage.leakageStatus, "evaluated");
    assert.equal(coverage.leakageRate, 0.5);
    assert.match(coverage.leakageRateInterpretation, /2 个可比日/);
    assert.deepEqual(coverage.rulingEqual, { true: 1, false: 1 });
    // 泄漏必须能归因到具体理由码，而不是只给一个比率。
    assert.deepEqual(coverage.arrivalSensitiveReasonCodes, [
      { code: "not_assessed", count: 1 },
      { code: "sleep_unavailable_at_assessment", count: 1 }
    ]);
    // 这一夜的**到达时间是已知的**（`computed_at`），只是迟到了。迟到 ≠ 到达时间不可考：
    // 前者由严格要求的那一支排除，后者才阻断 as_known_then。两者不得混为一谈。
    assert.equal(coverage.asKnownThenBlockedDays, 0);
    // 只有 09-17 两支都看不到东西，理由必须写出来（它不进泄漏率分母）。
    assert.deepEqual(coverage.unassessableReasons, [{ reason: "no_reading_for_this_day", count: 1 }]);
    assert.equal(coverage.longestStateRun?.days, 1, "严格支只在 09-19 评估成功");
  });
});

test("a present reading with no arrival time is what blocks as-known-then, not a missing one", async () => {
  await withDatabase((store) => {
    for (let day = 10; day <= 16; day += 1) {
      const wakeDate = `2026-09-${String(day).padStart(2, "0")}`;
      insertNight(store, wakeDate, 450, wakeAtFor(wakeDate));
    }
    // 静息心率只来自 `health_records`，它的到达时间受"数据集发布上界"约束：
    // 发布时刻晚于当天 ⇒ 读数存在但**到达时间不可考**。
    store.database.prepare(`INSERT INTO health_records
      (id,type,source_name,source_category,unit,value_numeric,start_at,end_at,metadata_json,raw_attributes_json)
      VALUES (?,?,'Watch','apple_watch','count/min',?,?,?,'{}','{}')`)
      .run("rhr-18", "HKQuantityTypeIdentifierRestingHeartRate", 60, "2026-09-18T02:00:00Z", "2026-09-18T02:01:00Z");

    const beforePublication = buildReadinessReplayCoverage(store.database, {
      timezone: TIMEZONE, fromLocalDate: "2026-09-18", toLocalDate: "2026-09-18"
    });
    assert.equal(beforePublication.assessableDays, 0);
    assert.equal(beforePublication.asKnownThenBlockedDays, 1);
    assert.deepEqual(beforePublication.unassessableReasons, [
      { reason: "reading_exists_but_arrival_time_unknown", count: 1 }
    ]);

    store.database.prepare("INSERT INTO import_manifest VALUES ('import_completed_at',?)").run("2026-09-18T03:00:00Z");
    const afterPublication = buildReadinessReplayCoverage(store.database, {
      timezone: TIMEZONE, fromLocalDate: "2026-09-18", toLocalDate: "2026-09-18"
    });
    assert.equal(afterPublication.asKnownThenBlockedDays, 0);
    assert.equal(afterPublication.assessableDays, 0, "睡眠基线未覆盖该日，所以仍然不可评估");
    assert.equal(afterPublication.observedFactDays, 1);
  });
});

test("a day whose reading arrived on time produces no leakage", async () => {
  await withDatabase((store) => {
    for (let day = 10; day <= 16; day += 1) {
      const wakeDate = `2026-09-${String(day).padStart(2, "0")}`;
      insertNight(store, wakeDate, 450, wakeAtFor(wakeDate));
    }
    // 同样很短的一夜，但**当天早上就入库**：两支都看得到它 ⇒ 裁决相同。
    insertNight(store, "2026-09-18", 300, wakeAtFor("2026-09-18"));

    const coverage = buildReadinessReplayCoverage(store.database, {
      timezone: TIMEZONE,
      fromLocalDate: "2026-09-18",
      toLocalDate: "2026-09-18"
    });
    assert.equal(coverage.assessableDays, 1);
    assert.equal(coverage.comparableDays, 1);
    assert.equal(coverage.divergentDays, 0);
    assert.equal(coverage.leakageStatus, 'single_comparable_day');
    assert.equal(coverage.leakageRate, null);
    assert.deepEqual(coverage.rulingEqual, { true: 1, false: 0 });
    assert.deepEqual(coverage.arrivalSensitiveReasonCodes, []);
    assert.equal(coverage.asKnownThenBlockedDays, 0);
  });
});

test("an empty fact set yields null rather than a zero rate", async () => {
  await withDatabase((store) => {
    const coverage = buildReadinessReplayCoverage(store.database, { timezone: TIMEZONE });
    assert.equal(coverage.window.days, 0);
    assert.equal(coverage.leakageRate, null);
    assert.match(coverage.leakageRateInterpretation, /没有任何可比日/);
    assert.equal(coverage.accuracyStatus, "not_evaluable");
  });
});
