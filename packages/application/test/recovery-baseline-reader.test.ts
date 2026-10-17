import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { healthTypes, workoutTypes } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";

import { RecoveryBaselineReader } from "../src/services/recovery-baseline-reader.js";
import { addDays, localDateAt, localDateStartAt, median } from "../src/utils.js";

/**
 * 恢复基线的按日期索引改写（item 7）必须与"每场会话现算"的旧实现**逐字段相同**。
 *
 * 旧实现对每场会话跑 8 条 SQL（28/60 两个窗口各一遍），`load` 基线还把全部历史取回内存
 * 再按日期筛。新实现按 `localDate` 缓存、时间下界进 SQL。**等值性不能靠"两次分析互相比较"
 * 来证明** —— 两边都用新实现时，一个系统性偏移会同时出现在两边。
 */
const TZ = "Asia/Shanghai";
const DAY_MS = 86_400_000;
const END_DATE = "2026-03-15";
const END_MS = Date.parse(`${END_DATE}T12:00:00.000Z`);
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();
const dateAt = (offsetDays: number): string => addDays(END_DATE, offsetDays);

function seed(database: DatabaseSync, sparseRecovery = false): void {
  const record = database.prepare(`
    INSERT INTO health_records
      (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
    VALUES (?, ?, 'Apple Watch', 'apple_watch', ?, ?, ?, ?, '{}', '{}')
  `);
  const night = database.prepare(`
    INSERT INTO canonical_nights
      (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank,
       has_stages, sleep_onset_at, wake_at, asleep_union_minutes, stage_minutes_json,
       segment_count, provenance_json, computed_at)
    VALUES (?, ?, ?, 'main', 'Apple Watch', 'apple_watch', 1, 0, ?, ?, ?, '{}', 1, '{}', ?)
  `);
  const hrv = database.prepare(`
    INSERT INTO canonical_hrv_days
      (id, local_date, timezone_identifier, night_id, hrv_sdnn_ms, sample_count, confidence,
       window_end_at, provenance_json, computed_at)
    VALUES (?, ?, ?, ?, ?, 20, ?, ?, '{}', ?)
  `);
  const workout = database.prepare(`
    INSERT INTO workouts
      (id, activity_type, source_name, source_category, start_at, end_at, duration_seconds,
       metadata_json, raw_attributes_json, is_canonical)
    VALUES (?, ?, 'Apple Watch', 'apple_watch', ?, ?, ?, '{}', '{}', 1)
  `);
  const session = database.prepare(`
    INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, canonical_workout_id, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `);

  database.exec("BEGIN IMMEDIATE");
  try {
    for (let offset = -70; offset <= 0; offset += 1) {
      const date = dateAt(offset);
      const wakeAt = Date.parse(`${date}T00:30:00.000Z`); // 08:30 Asia/Shanghai
      // 睡眠/HRV 故意缺失：常规夹具缺 1/3，稀疏夹具缺到"28 天窗有效值不足 7"⇒ 必须走 60 天窗。
      const nightPresent = sparseRecovery ? (offset + 70) % 9 === 0 : (offset + 70) % 3 !== 0;
      if (nightPresent) {
        night.run(
          `n-${date}`, date, TZ, iso(wakeAt - 7 * 3_600_000), iso(wakeAt),
          380 + ((offset + 70) % 11) * 7, iso(wakeAt)
        );
        hrv.run(
          `h-${date}`, date, TZ, `n-${date}`, 40 + ((offset + 70) % 9) * 2,
          (offset + 70) % 7 === 0 ? "sparse" : "confident", iso(wakeAt), iso(wakeAt)
        );
      }
      if (sparseRecovery ? (offset + 70) % 8 === 0 : (offset + 70) % 2 === 0) {
        const at = Date.parse(`${date}T00:00:00.000Z`); // 08:00 Asia/Shanghai
        record.run(`rhr-${date}`, healthTypes.restingHeartRate, "count/min", 48 + ((offset + 70) % 6), iso(at), iso(at + 60_000));
      }
      // 部分日子一天两练（早/晚）：同一天的两场会话必须得到**同一条**基线。
      const runs = (offset + 70) % 5 === 0 ? ["00:00", "10:00"] : ["00:00"];
      for (const [index, clock] of runs.entries()) {
        const startAt = `${date}T${clock}:00.000Z`;
        const endAt = iso(Date.parse(startAt) + 2_700_000);
        workout.run(`w-${date}-${index}`, workoutTypes.running, startAt, endAt, 2_700);
        session.run(`s-${date}-${index}`, workoutTypes.running, startAt, endAt, `w-${date}-${index}`);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** 优化前的实现，逐字保留（含 28/60 两次查询与"全历史 + JS 筛"）。 */
function referenceBaseline(
  database: DatabaseSync,
  workoutStartAt: string,
  timezoneIdentifier: string
): {
  sleepMinutes: number | null;
  restingHeartRateBpm: number | null;
  hrvSdnnMs: number | null;
  loadMinutes: number | null;
  lookbackDays: number;
  validDays: { sleep: number; hrv: number; rhr: number; load: number };
} {
  const localDate = localDateAt(workoutStartAt, timezoneIdentifier);
  const medianValue = (values: number[]): number | null => {
    const valid = values.filter((value) => Number.isFinite(value));
    return valid.length ? median(valid) : null;
  };
  const readBaseline = (table: "sleep" | "hrv" | "rhr" | "load", days: number): number[] => {
    const fromDate = addDays(localDate, -days);
    if (table === "sleep") {
      return (database.prepare("SELECT asleep_union_minutes AS value FROM canonical_nights WHERE kind='main' AND timezone_identifier=? AND wake_date >= ? AND wake_date < ? AND wake_at < ?")
        .all(timezoneIdentifier, fromDate, localDate, workoutStartAt) as Array<{ value: number | null }>)
        .flatMap((row) => row.value == null ? [] : [Number(row.value)]);
    }
    if (table === "hrv") {
      return (database.prepare("SELECT hrv_sdnn_ms AS value FROM canonical_hrv_days WHERE timezone_identifier=? AND local_date >= ? AND local_date < ? AND confidence <> 'missing' AND window_end_at < ? AND hrv_sdnn_ms IS NOT NULL")
        .all(timezoneIdentifier, fromDate, localDate, workoutStartAt) as Array<{ value: number }>)
        .map((row) => Number(row.value));
    }
    if (table === "rhr") {
      const rows = database.prepare("SELECT source_category AS sourceCategory, value_numeric AS value, start_at AS startAt FROM health_records WHERE type=? AND value_numeric IS NOT NULL AND source_category IN ('apple_watch', 'connect') AND start_at >= ? AND start_at < ? AND end_at < ?")
        .all(healthTypes.restingHeartRate, localDateStartAt(fromDate, timezoneIdentifier), localDateStartAt(localDate, timezoneIdentifier), localDateStartAt(localDate, timezoneIdentifier)) as Array<{ sourceCategory: string; value: number; startAt: string }>;
      const byDate = new Map<string, Array<{ sourceCategory: string; value: number }>>();
      for (const row of rows) {
        const date = localDateAt(row.startAt, timezoneIdentifier);
        const bucket = byDate.get(date) ?? [];
        bucket.push(row);
        byDate.set(date, bucket);
      }
      return [...byDate.values()].flatMap((dayRows) => {
        const watch = dayRows.filter((row) => row.sourceCategory === "apple_watch");
        const value = medianValue((watch.length ? watch : dayRows).map((row) => Number(row.value)));
        return value === null ? [] : [value];
      });
    }
    const rows = database.prepare("SELECT workout.start_at AS startAt, workout.duration_seconds AS durationSeconds FROM training_sessions session JOIN workouts workout ON workout.id=session.canonical_workout_id WHERE session.activity_type=? AND session.status='active' AND workout.start_at < ?")
      .all(workoutTypes.running, workoutStartAt) as Array<{ startAt: string; durationSeconds: number }>;
    const byDate = new Map<string, number>();
    for (const row of rows) {
      const date = localDateAt(row.startAt, timezoneIdentifier);
      if (date >= fromDate && date < localDate) byDate.set(date, (byDate.get(date) ?? 0) + Number(row.durationSeconds) / 60);
    }
    return [...byDate.values()];
  };
  const baselineFor = (table: "sleep" | "hrv" | "rhr" | "load") => {
    const recent = readBaseline(table, 28).filter(Number.isFinite);
    if (recent.length >= 7) return { value: medianValue(recent), lookbackDays: 28, validDays: recent.length };
    const extended = readBaseline(table, 60).filter(Number.isFinite);
    return { value: extended.length >= 7 ? medianValue(extended) : null, lookbackDays: 60, validDays: extended.length };
  };
  const sleepBase = baselineFor("sleep");
  const hrvBase = baselineFor("hrv");
  const rhrBase = baselineFor("rhr");
  const loadBase = baselineFor("load");
  return {
    sleepMinutes: sleepBase.value,
    restingHeartRateBpm: rhrBase.value,
    hrvSdnnMs: hrvBase.value,
    loadMinutes: loadBase.value,
    lookbackDays: Math.max(sleepBase.lookbackDays, hrvBase.lookbackDays, rhrBase.lookbackDays, loadBase.lookbackDays),
    validDays: { sleep: sleepBase.validDays, hrv: hrvBase.validDays, rhr: rhrBase.validDays, load: loadBase.validDays }
  };
}

async function withFixture(work: (store: RaiDatabase) => void, sparseRecovery = false): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "rai-recovery-baseline-"));
  const store = await RaiDatabase.open(join(directory, "rai.sqlite"), { createMigrationBackup: false });
  try {
    seed(store.database, sparseRecovery);
    work(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the date-indexed recovery baseline is field-identical to the per-session implementation", async () => {
  await withFixture((store) => {
    const reader = new RecoveryBaselineReader(store.database, TZ);
    // 覆盖三种形态：28 天窗充足、28 天窗不足（走 60 天）、序列边界附近。
    const sessions = ["2026-03-15T00:00:00.000Z", "2026-03-15T10:00:00.000Z", "2026-03-02T00:00:00.000Z", "2026-01-20T00:00:00.000Z"];
    for (const session of sessions) {
      const expected = referenceBaseline(store.database, session, TZ);
      const actual = reader.baseline(localDateAt(session, TZ));
      assert.deepEqual(actual, expected, session);
    }
    // 同一天的两场训练必须命中同一条缓存（否则"按日期索引"没有发生）。
    assert.equal(reader.baseline(localDateAt(sessions[0]!, TZ)), reader.baseline(localDateAt(sessions[1]!, TZ)));
  });
});

test("the sparse fixture actually exercises the 60-day fallback and stays identical", async () => {
  await withFixture((store) => {
    const reader = new RecoveryBaselineReader(store.database, TZ);
    for (const session of ["2026-03-15T00:00:00.000Z", "2026-03-02T00:00:00.000Z"]) {
      const expected = referenceBaseline(store.database, session, TZ);
      const actual = reader.baseline(localDateAt(session, TZ));
      assert.deepEqual(actual, expected, session);
      // 判据：稀疏夹具下至少有一条基线必须落进 60 天窗，否则这个用例没测到回退分支。
      assert.equal(actual.lookbackDays, 60, `expected the 60-day window to be used for ${session}`);
    }
  }, true);
});
