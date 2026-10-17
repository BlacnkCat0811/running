import type { DatabaseSync } from "node:sqlite";

import { healthTypes, workoutTypes } from "@rai/contracts";

import { addDays, localDateAt, localDateStartAt, median } from "../utils.js";

/**
 * 恢复基线（睡眠 / HRV / 静息心率 / 训练负荷）的**按日期**读取器。
 *
 * ## 为什么要有它
 *
 * 旧实现每个训练会话都重新算四条基线，其中三条要用 28 天窗、不足再算 60 天窗 ⇒ 同一份
 * SQL 跑两遍；`load` 基线更糟：SQL 只有上界（`workout.start_at < 会话开始`），
 * 把**全部历史**取回内存再按日期筛 —— 一万条历史、几千场会话 ⇒ O(会话数 × 历史行数)。
 *
 * ## 为什么可以按 `localDate` 缓存
 *
 * 四条基线的窗口都只由 `localDate` 决定，与会话的具体时刻无关：
 * 窗口内的行都满足 `date < localDate`，因此旧 SQL 里"`wake_at` / `start_at` 早于会话开始"
 * 这个附加上界在窗口内恒真（同一天的更晚行本来就被 `date < localDate` 排除）。
 * 于是"同一本地日的多场训练共用一次计算"是**等价变换**，不是近似。
 *
 * ## 生命周期
 *
 * 缓存只活在一次 run 内：持有者（`RecomputePipeline`）在事实视图被替换时构造新的读取器。
 * 跨 job 复用会用旧事实算基线 —— 那正是"输入变了却仍然复用"的形态。
 */

interface BaselineWindow {
  value: number | null;
  lookbackDays: number;
  validDays: number;
}

export interface RecoveryBaselineSnapshot {
  sleepMinutes: number | null;
  restingHeartRateBpm: number | null;
  hrvSdnnMs: number | null;
  loadMinutes: number | null;
  lookbackDays: number;
  validDays: { sleep: number; hrv: number; rhr: number; load: number };
}

type BaselineTable = "sleep" | "hrv" | "rhr" | "load";

/** 28 天窗至少要有这么多天有效值，否则扩到 60 天（与旧实现同判据）。 */
const MINIMUM_BASELINE_DAYS = 7;
const SHORT_LOOKBACK_DAYS = 28;
const LONG_LOOKBACK_DAYS = 60;

export class RecoveryBaselineReader {
  private readonly cache = new Map<string, RecoveryBaselineSnapshot>();

  constructor(
    private readonly database: DatabaseSync,
    private readonly timezoneIdentifier: string
  ) {}

  /** 同一 `localDate` 只算一次。 */
  baseline(localDate: string): RecoveryBaselineSnapshot {
    const cached = this.cache.get(localDate);
    if (cached !== undefined) return cached;
    const computed = this.compute(localDate);
    this.cache.set(localDate, computed);
    return computed;
  }

  private compute(localDate: string): RecoveryBaselineSnapshot {
    const fromDate = addDays(localDate, -LONG_LOOKBACK_DAYS);
    // 一次取 60 天，两个窗口都在内存里切 —— 旧实现对 28/60 各跑一遍同一条 SQL。
    const rows: Record<BaselineTable, Map<string, number[]>> = {
      sleep: this.sleepValues(fromDate, localDate),
      hrv: this.hrvValues(fromDate, localDate),
      rhr: this.restingHeartRateValues(fromDate, localDate),
      load: this.loadValues(fromDate, localDate)
    };
    const windows: Record<BaselineTable, BaselineWindow> = {
      sleep: this.window(rows.sleep, localDate),
      hrv: this.window(rows.hrv, localDate),
      rhr: this.window(rows.rhr, localDate),
      load: this.window(rows.load, localDate)
    };
    return {
      sleepMinutes: windows.sleep.value,
      restingHeartRateBpm: windows.rhr.value,
      hrvSdnnMs: windows.hrv.value,
      loadMinutes: windows.load.value,
      lookbackDays: Math.max(
        windows.sleep.lookbackDays, windows.hrv.lookbackDays,
        windows.rhr.lookbackDays, windows.load.lookbackDays
      ),
      validDays: {
        sleep: windows.sleep.validDays, hrv: windows.hrv.validDays,
        rhr: windows.rhr.validDays, load: windows.load.validDays
      }
    };
  }

  /** 先 28 天；有效天数不足 7 才扩到 60 天（与旧 `baselineFor` 逐字同判据）。 */
  private window(values: Map<string, number[]>, localDate: string): BaselineWindow {
    const recent = this.collect(values, addDays(localDate, -SHORT_LOOKBACK_DAYS), localDate);
    if (recent.length >= MINIMUM_BASELINE_DAYS) {
      return { value: medianOf(recent), lookbackDays: SHORT_LOOKBACK_DAYS, validDays: recent.length };
    }
    const extended = this.collect(values, addDays(localDate, -LONG_LOOKBACK_DAYS), localDate);
    return {
      value: extended.length >= MINIMUM_BASELINE_DAYS ? medianOf(extended) : null,
      lookbackDays: LONG_LOOKBACK_DAYS,
      validDays: extended.length
    };
  }

  private collect(values: Map<string, number[]>, fromDate: string, localDate: string): number[] {
    const collected: number[] = [];
    for (let date = fromDate; date < localDate; date = addDays(date, 1)) {
      const bucket = values.get(date);
      if (bucket === undefined) continue;
      collected.push(...bucket);
    }
    return collected.filter(Number.isFinite);
  }

  private sleepValues(fromDate: string, localDate: string): Map<string, number[]> {
    return groupByDate(this.database.prepare(`
      SELECT wake_date AS localDate, asleep_union_minutes AS value
      FROM canonical_nights
      WHERE kind = 'main' AND timezone_identifier = ?
        AND wake_date >= ? AND wake_date < ?
        AND wake_at IS NOT NULL AND wake_at < ?
        AND asleep_union_minutes IS NOT NULL
      ORDER BY wake_date, id
    `).all(
      this.timezoneIdentifier, fromDate, localDate, localDateStartAt(localDate, this.timezoneIdentifier)
    ) as unknown as Array<{ localDate: string; value: number | null }>);
  }

  private hrvValues(fromDate: string, localDate: string): Map<string, number[]> {
    return groupByDate(this.database.prepare(`
      SELECT local_date AS localDate, hrv_sdnn_ms AS value
      FROM canonical_hrv_days
      WHERE timezone_identifier = ?
        AND local_date >= ? AND local_date < ?
        AND confidence <> 'missing'
        AND window_end_at IS NOT NULL AND window_end_at < ?
        AND hrv_sdnn_ms IS NOT NULL
      ORDER BY local_date, computed_at
    `).all(
      this.timezoneIdentifier, fromDate, localDate, localDateStartAt(localDate, this.timezoneIdentifier)
    ) as unknown as Array<{ localDate: string; value: number | null }>);
  }

  /** RHR 每天先按"Watch 优先、否则 Connect"归并成一个值，再进 28/60 天窗。 */
  private restingHeartRateValues(fromDate: string, localDate: string): Map<string, number[]> {
    const dayStart = localDateStartAt(localDate, this.timezoneIdentifier);
    const rows = this.database.prepare(`
      SELECT source_category AS sourceCategory, value_numeric AS value, start_at AS startAt
      FROM health_records
      WHERE type = ? AND value_numeric IS NOT NULL
        AND source_category IN ('apple_watch', 'connect')
        AND start_at >= ? AND start_at < ? AND end_at < ?
    `).all(
      healthTypes.restingHeartRate,
      localDateStartAt(fromDate, this.timezoneIdentifier), dayStart, dayStart
    ) as unknown as Array<{ sourceCategory: string; value: number; startAt: string }>;
    const byDate = new Map<string, Array<{ sourceCategory: string; value: number }>>();
    for (const row of rows) {
      const date = localDateAt(row.startAt, this.timezoneIdentifier);
      const bucket = byDate.get(date) ?? [];
      bucket.push(row);
      byDate.set(date, bucket);
    }
    const values = new Map<string, number[]>();
    for (const [date, dayRows] of byDate) {
      const watch = dayRows.filter((row) => row.sourceCategory === "apple_watch");
      const value = medianOf((watch.length ? watch : dayRows).map((row) => Number(row.value)));
      if (value !== null) values.set(date, [value]);
    }
    return values;
  }

  /**
   * 负荷基线：分钟数按本地日聚合。
   *
   * 🔴 时间下界必须进 SQL —— 旧实现只有上界，每场会话都把全部历史读回内存再按日期筛。
   */
  private loadValues(fromDate: string, localDate: string): Map<string, number[]> {
    const rows = this.database.prepare(`
      SELECT workout.start_at AS startAt, workout.duration_seconds AS durationSeconds
      FROM training_sessions session
      JOIN workouts workout ON workout.id = session.canonical_workout_id
      WHERE session.activity_type = ? AND session.status = 'active'
        AND workout.start_at >= ? AND workout.start_at < ?
    `).all(
      workoutTypes.running,
      localDateStartAt(fromDate, this.timezoneIdentifier),
      localDateStartAt(localDate, this.timezoneIdentifier)
    ) as unknown as Array<{ startAt: string; durationSeconds: number }>;
    const byDate = new Map<string, number>();
    for (const row of rows) {
      const date = localDateAt(row.startAt, this.timezoneIdentifier);
      byDate.set(date, (byDate.get(date) ?? 0) + Number(row.durationSeconds) / 60);
    }
    return new Map([...byDate].map(([date, minutes]) => [date, [minutes]]));
  }
}

function groupByDate(rows: Array<{ localDate: string; value: number | null }>): Map<string, number[]> {
  const values = new Map<string, number[]>();
  for (const row of rows) {
    if (row.value === null) continue;
    const bucket = values.get(row.localDate) ?? [];
    bucket.push(Number(row.value));
    values.set(row.localDate, bucket);
  }
  return values;
}

function medianOf(values: number[]): number | null {
  const valid = values.filter(Number.isFinite);
  return valid.length ? median(valid) : null;
}
