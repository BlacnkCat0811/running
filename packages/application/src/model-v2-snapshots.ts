import { semanticHash } from "@rai/storage-sqlite";
import type { DatabaseSync } from "node:sqlite";
import { READINESS_MODEL_VERSION, READINESS_RULE_SET_VERSION, healthTypes, type ModelLineageV2, type ReadinessSignalName } from "@rai/contracts";
import { READINESS_SLEEP_RATIO_THRESHOLD, READINESS_HRV_RATIO_THRESHOLD, READINESS_RHR_RATIO_THRESHOLD, READINESS_SLEEP_STREAK_THRESHOLD, assessDatedReadiness, withReadinessLineage, type DatedRecoverySignal } from "@rai/readiness";
import { localDateAt, localDateStartAt, addDays, median } from "./utils.js";

/**
 * 装配一天的全部恢复**事实**，不做任何判定。
 *
 * §4.1 的原则是"先解决证据接口，再增加公式"：判定只有 `assessDatedReadiness` 一处，
 * 而"事实从哪来、到达时间怎么算"只有这里一处。回放器需要的是**事实**而不是结论
 * （`replayReadinessRulings` 要拿同一批事实跑两支到达时间假设），所以必须把它单独暴露出来 ——
 * 否则回放器只能自己再写一遍这些 SQL，而那正是"两套恢复口径"的开端。
 *
 * `loadDatedReadiness` = `assessDatedReadiness(loadDatedRecoveryFacts(...))`，逐位等价。
 *
 * ## O09（WP-32）：为什么这里分成"取行"与"装配"两段
 *
 * 原来的实现每天 7 条 SQL，且相邻日的 28 天窗口高度重叠 —— 一次多年增量分析要跑
 * `天数 × 7` 条语句、反复扫同一批历史行。批量读取（`loadDatedRecoveryFactsBatch`）
 * 把"取行"换成**一次范围读 + 按日双指针索引**。
 *
 * 🔴 节流的正确性判据不是"看起来一样"，而是**同一天的事实逐字段相同**，尤其是 `asOf`：
 * `loadDatedReadiness` 评估的是**那一天自己的日终**（`min(日终, 全局截止)`），于是
 * `publicationAt` 在 `import_completed_at` 之前的日子恒为 null。把它塌缩成 run 级
 * `evaluatedAt` 会让历史日"提前拿到"发布时刻，物理状态随之变化 —— 那是"用未来证据解释过去"。
 * 所以两条路径共用**同一个装配器**（`assembleDatedRecoveryFacts`）：单日读取器与批量
 * 读取器只负责产出同样的原始行，判定与到达时间语义不复制第二份。
 */
export interface DatedReadinessFacts {
  asOf: string;
  localDate: string;
  signals: Record<ReadinessSignalName, DatedRecoverySignal>;
  nights: DatedRecoverySignal[];
}

/** 原始行：**未**取中位数、**未**判定可用性。两种读取器产出同一形状。 */
interface RecoveryFactRows {
  /** 数据集发布完成的时刻，且必须 `<= asOf`，否则 null（"当时还不知道"）。 */
  publicationAt: string | null;
  sleepBaselineValues: Array<number | null>;
  hrvBaselineValues: Array<number | null>;
  /** 基线窗内**每个本地日**的 RHR 中位数（按日分组后的原料）。 */
  rhrBaselineByDate: Array<number | null>;
  night: RecoveryNightRow | undefined;
  hrv: RecoveryHrvRow | undefined;
  rhr: { observedAt: string; value: number | null } | undefined;
  nights: RecoveryNightRow[];
}

interface RecoveryNightRow { date: string; observedAt: string | null; availableAt: string | null; value: number | null }
interface RecoveryHrvRow { date: string; observedAt: string | null; availableAt: string | null; value: number | null }

/** 正数、有限的中位数（样本 < 7 天 ⇒ null，与既有口径一致）。 */
function center(values: Array<number | null>): number | null {
  const xs = values.flatMap((value) => value !== null && Number.isFinite(value) && value > 0 ? [value] : []);
  return xs.length >= 7 ? median(xs) : null;
}

/** `julianday(a) <= julianday(b)` 的等价比较：不可解析值两边都判否（SQL 里是 NULL 谓词）。 */
function instantAtOrBefore(value: string | null, boundMs: number): boolean {
  const at = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(at) && at <= boundMs;
}

function instantBefore(value: string | null, boundMs: number): boolean {
  const at = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(at) && at < boundMs;
}

/** 装配（唯一一份）：原始行 → 事实。两条读取路径都必须走这里。 */
function assembleDatedRecoveryFacts(
  asOf: string,
  localDate: string,
  rows: RecoveryFactRows
): DatedReadinessFacts {
  const sleepBase = center(rows.sleepBaselineValues);
  const hrvBase = center(rows.hrvBaselineValues);
  const rhrBase = rows.publicationAt === null ? null : center(rows.rhrBaselineByDate);
  const signal = (
    row: { date: string; observedAt: string | null; availableAt: string | null; value: number | null } | undefined,
    baseline: number | null
  ): DatedRecoverySignal => ({
    value: row?.value ?? null, baseline, observedAt: row?.observedAt ?? null, availableAt: row?.availableAt ?? null,
    localDate: row?.date ?? null,
    availabilitySource: row?.availableAt ? "canonical_computation" : "unknown"
  });
  return { asOf, localDate, signals: {
    sleep: signal(rows.night, sleepBase),
    hrv: signal(rows.hrv, hrvBase),
    rhr: { ...signal(rows.rhr === undefined ? undefined : { ...rows.rhr, date: localDate, availableAt: rows.publicationAt }, rhrBase),
      availabilitySource: rows.publicationAt ? "dataset_publication_upper_bound" : "unknown" }
  }, nights: rows.nights.map((row) => signal(row, sleepBase)) };
}

/** 发布时刻：`import_completed_at` 必须可解析且不晚于当天的 `asOf`。 */
function publicationAtFor(publication: unknown, asOfMs: number): string | null {
  // A completed publication is a conservative upper bound, not a fabricated
  // record-level arrival time. It cannot make an older observed date "today".
  return typeof publication === "string" && Number.isFinite(Date.parse(publication))
    && Date.parse(publication) <= asOfMs ? new Date(publication).toISOString() : null;
}

/** 单日读取器：7 条点查。保留原语义，供仍需单日事实的调用方与对照测试使用。 */
function singleDayRecoveryFactRows(database: DatabaseSync, asOf: string, timezone: string, date: string): RecoveryFactRows {
  const asOfMs = Date.parse(asOf);
  const publicationAt = publicationAtFor(database.prepare("SELECT value FROM import_manifest WHERE key='import_completed_at'").get()?.value, asOfMs);
  const fromDate = addDays(date, -28);
  const fromAt = localDateStartAt(fromDate, timezone), todayAt = localDateStartAt(date, timezone);
  const sleepBaselineValues = (database.prepare(`SELECT asleep_union_minutes AS value FROM canonical_nights
    WHERE kind='main' AND timezone_identifier=? AND wake_date>=? AND wake_date<? AND julianday(wake_at)<julianday(?) AND julianday(computed_at)<=julianday(?)`)
    .all(timezone, fromDate, date, todayAt, asOf) as Array<{ value: number | null }>).map((row) => row.value);
  const hrvBaselineValues = (database.prepare(`SELECT hrv_sdnn_ms AS value FROM canonical_hrv_days
    WHERE timezone_identifier=? AND local_date>=? AND local_date<? AND julianday(window_end_at)<julianday(?) AND julianday(computed_at)<=julianday(?)`)
    .all(timezone, fromDate, date, todayAt, asOf) as Array<{ value: number | null }>).map((row) => row.value);
  const rhrRows = database.prepare(`SELECT value_numeric AS value,start_at AS at FROM health_records
    WHERE type=? AND julianday(start_at)>=julianday(?) AND julianday(end_at)<julianday(?) AND value_numeric>0 ORDER BY start_at`)
    .all(healthTypes.restingHeartRate, fromAt, todayAt) as Array<{ value: number; at: string }>;
  const byDate = new Map<string, number[]>();
  for (const row of rhrRows) { const d = localDateAt(row.at, timezone); byDate.set(d, [...(byDate.get(d) ?? []), row.value]); }
  const nightRows = database.prepare(`SELECT wake_date AS date,wake_at AS observedAt,computed_at AS availableAt,
    asleep_union_minutes AS value FROM canonical_nights WHERE kind='main' AND timezone_identifier=?
    AND wake_date>=? AND wake_date<=? AND julianday(wake_at)<=julianday(?) ORDER BY wake_date`)
    .all(timezone, addDays(date, -2), date, asOf) as unknown as RecoveryNightRow[];
  const hrv = database.prepare(`SELECT local_date AS date,window_end_at AS observedAt,computed_at AS availableAt,
    hrv_sdnn_ms AS value FROM canonical_hrv_days WHERE timezone_identifier=? AND local_date=?
    AND julianday(window_end_at)<=julianday(?) ORDER BY computed_at DESC LIMIT 1`).get(timezone, date, asOf) as RecoveryHrvRow | undefined;
  const rhr = database.prepare(`SELECT start_at AS observedAt,value_numeric AS value FROM health_records
    WHERE type=? AND julianday(start_at)>=julianday(?) AND julianday(end_at)<=julianday(?) ORDER BY start_at DESC LIMIT 1`)
    .get(healthTypes.restingHeartRate, todayAt, asOf) as { observedAt: string; value: number | null } | undefined;
  return {
    publicationAt,
    sleepBaselineValues, hrvBaselineValues,
    rhrBaselineByDate: [...byDate.values()].map((xs) => median(xs)),
    night: nightRows.find((row) => row.date === date),
    hrv, rhr, nights: nightRows
  };
}

export function loadDatedRecoveryFacts(database: DatabaseSync, asOf: string, timezone: string): DatedReadinessFacts {
  const date = localDateAt(asOf, timezone);
  return assembleDatedRecoveryFacts(asOf, date, singleDayRecoveryFactRows(database, asOf, timezone, date));
}

export function loadDatedReadiness(database: DatabaseSync, asOf: string, timezone: string) {
  return assessDatedReadiness(loadDatedRecoveryFacts(database, asOf, timezone));
}

/** 批量读取的一天：`asOf` 必须是**该日自己的**日终（或更早的全局截止）。 */
export interface DatedReadinessDayRequest {
  asOf: string;
  localDate: string;
}

interface DatedRows<T> { byDate: Map<string, T[]>; dates: string[]; rows: T[] }

/** 按本地日分桶，保持 SQL 的行内顺序（桶内顺序即读取顺序）。 */
function groupRowsByDate<T extends { date: string }>(rows: readonly T[]): DatedRows<T> {
  const byDate = new Map<string, T[]>();
  for (const row of rows) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  return { byDate, dates: [...byDate.keys()].sort(), rows: [...rows] };
}

/** 在**升序**日期数组上找到第一个 `>= bound` 的位置（等价于 SQL 的 TEXT 比较）。 */
function firstDateIndexAtOrAfter(dates: readonly string[], bound: string, from: number): number {
  let index = from;
  while (index < dates.length && dates[index]! < bound) index += 1;
  return index;
}

/** 在**按毫秒升序**排好的时刻数组上找到第一个 `>= bound` 的位置。 */
function firstInstantIndexAtOrAfter(instants: readonly number[], bound: number, from: number): number {
  let index = from;
  while (index < instants.length && !(instants[index]! >= bound)) index += 1;
  return index;
}

/**
 * 批量读取器（O09 步骤 5）：一次范围读 + 按日双指针索引。
 *
 * 输入是**按本地日升序**的 `{asOf, localDate}` 列表；对每一天的产出必须与
 * `loadDatedRecoveryFacts(db, asOf, tz)` 逐字段相同（同一装配器 + 同样的原始行）。
 *
 * 三处窗口的单调性：
 * - RHR 基线窗 `[D-28, D)` 与当值窗 `[D, asOf(D)]` —— 左右端都随 D **单调右移**，
 *   所以在按 `start_at` 排好序的行数组上维护指针即可，不必每天重扫全表。
 * - 夜窗 `[D-2, D]`（含 D）与睡眠基线窗 `[D-28, D)` —— 按 `wake_date` 排序后同理。
 * - HRV 基线窗 `[D-28, D)` 与当日取值同理（按 `local_date` 分桶 + 桶内保持
 *   `computed_at DESC` 顺序）。
 *
 * ⛔ 不允许把 `asOf` 换成 run 级截止：`publicationAt` 与 `arrived <= asOf` 都按
 * "当天日终"判定，塌缩会让历史日用到未来证据。
 */
export function loadDatedRecoveryFactsBatch(
  database: DatabaseSync,
  days: readonly DatedReadinessDayRequest[],
  timezone: string
): DatedReadinessFacts[] {
  if (days.length === 0) return [];
  // `localDate` **从 `asOf` 现算**，不采信调用方给的字段 —— 单日路径就是这么算的
  // （`localDateAt(asOf, timezone)`）。两条路径必须对同一个 `asOf` 给出同一天：
  // 采信调用方会让"调用方算错日界"变成一次安静换日，而不是一次可见的不一致。
  const ordered = days
    .map((day) => ({ asOf: day.asOf, localDate: localDateAt(day.asOf, timezone) }))
    .sort((left, right) => left.localDate < right.localDate ? -1 : left.localDate > right.localDate ? 1 : 0);
  const firstDate = ordered[0]!.localDate, lastDate = ordered[ordered.length - 1]!.localDate;
  const rangeFromAt = localDateStartAt(addDays(firstDate, -28), timezone);
  const rangeThroughAt = localDateStartAt(addDays(lastDate, 1), timezone);

  // ---- 一次范围读：RHR（基线窗与当值窗共用同一批行） ----
  const rawRhr = database.prepare(`SELECT value_numeric AS value,start_at AS startAt,end_at AS endAt
    FROM health_records WHERE type=? AND julianday(start_at)>=julianday(?) AND julianday(end_at)<julianday(?)
    ORDER BY start_at,rowid`)
    .all(healthTypes.restingHeartRate, rangeFromAt, rangeThroughAt) as Array<{ value: number | null; startAt: string; endAt: string }>;
  // ⛔ 指针法要求数组按 `start_at` 单调。规范 ISO 下 TEXT 序 == 时刻序；混入异构格式时
  // 显式按解析后的时刻重排（稳定排序保留 rowid 次序），否则"两指针"会漏行。
  const rhrRows = rawRhr
    .map((row, index) => ({ row, at: Date.parse(row.startAt), index }))
    .sort((left, right) => left.at - right.at || left.index - right.index)
    .map((item) => item.row);
  const rhrStarts = rhrRows.map((row) => Date.parse(row.startAt));

  // ---- 一次范围读：canonical 夜（日事实 D-2..D 与睡眠基线共用） ----
  const nights = groupRowsByDate(database.prepare(`SELECT wake_date AS date,wake_at AS observedAt,computed_at AS availableAt,
    asleep_union_minutes AS value FROM canonical_nights WHERE kind='main' AND timezone_identifier=?
    AND wake_date>=? AND wake_date<=? AND julianday(wake_at)<julianday(?) ORDER BY wake_date,rowid`)
    .all(timezone, addDays(firstDate, -28), lastDate, rangeThroughAt) as unknown as RecoveryNightRow[]);

  // ---- 一次范围读：canonical HRV 日（当日取值 = `computed_at DESC, rowid DESC` 的首条） ----
  const hrv = groupRowsByDate(database.prepare(`SELECT local_date AS date,window_end_at AS observedAt,computed_at AS availableAt,
    hrv_sdnn_ms AS value FROM canonical_hrv_days WHERE timezone_identifier=? AND local_date>=? AND local_date<=?
    ORDER BY local_date,computed_at DESC,rowid DESC`)
    .all(timezone, addDays(firstDate, -28), lastDate) as unknown as RecoveryHrvRow[]);

  const publication = database.prepare("SELECT value FROM import_manifest WHERE key='import_completed_at'").get()?.value;

  const results: DatedReadinessFacts[] = [];
  let rhrBaselineLeft = 0, rhrBaselineRight = 0, rhrValueLeft = 0;
  for (const day of ordered) {
    const date = day.localDate;
    const asOfMs = Date.parse(day.asOf);
    const fromDate = addDays(date, -28);
    const fromAt = Date.parse(localDateStartAt(fromDate, timezone));
    const todayAt = Date.parse(localDateStartAt(date, timezone));

    // 发布时刻按**当天**判定 —— 历史日不得"提前"看到后来的发布。
    const publicationAt = publicationAtFor(publication, asOfMs);

    // RHR 基线窗 [D-28, D)：`start_at >= fromAt` 且 `end_at < todayAt`，再按 start_at 的本地日分组。
    rhrBaselineLeft = firstInstantIndexAtOrAfter(rhrStarts, fromAt, rhrBaselineLeft);
    rhrBaselineRight = firstInstantIndexAtOrAfter(rhrStarts, todayAt, rhrBaselineRight);
    const byDate = new Map<string, number[]>();
    for (let index = rhrBaselineLeft; index < rhrBaselineRight; index += 1) {
      const row = rhrRows[index]!;
      const value = Number(row.value);
      if (row.value === null || !Number.isFinite(value) || !(value > 0)) continue;
      if (!instantBefore(row.endAt, todayAt)) continue;
      const key = localDateAt(row.startAt, timezone);
      byDate.set(key, [...(byDate.get(key) ?? []), value]);
    }

    // RHR 当值窗 [D, asOf(D)]：`ORDER BY start_at DESC LIMIT 1` ≡ 窗内最后一行。
    rhrValueLeft = firstInstantIndexAtOrAfter(rhrStarts, todayAt, rhrValueLeft);
    let rhr: { observedAt: string; value: number | null } | undefined;
    for (let index = rhrValueLeft; index < rhrRows.length && instantAtOrBefore(rhrRows[index]!.startAt, asOfMs); index += 1) {
      const row = rhrRows[index]!;
      if (!instantAtOrBefore(row.endAt, asOfMs)) continue;
      rhr = { observedAt: row.startAt, value: row.value === null ? null : Number(row.value) };
    }

    // 夜事实 D-2..D：`wake_date` 在闭区间内且 `wake_at <= asOf(D)`，桶内保持 `wake_date` 顺序。
    const nightWindow: RecoveryNightRow[] = [];
    for (const nightDate of sliceDates(nights.dates, addDays(date, -2), date)) {
      for (const row of nights.byDate.get(nightDate)!) {
        if (!instantAtOrBefore(row.observedAt, asOfMs)) continue;
        nightWindow.push(row);
      }
    }
    // 睡眠基线窗 [D-28, D)：`wake_at < todayAt` 且 `computed_at <= asOf(D)`。
    const sleepBaselineValues: Array<number | null> = [];
    for (const nightDate of sliceDates(nights.dates, fromDate, addDays(date, -1))) {
      for (const row of nights.byDate.get(nightDate)!) {
        if (!instantBefore(row.observedAt, todayAt)) continue;
        if (!instantAtOrBefore(row.availableAt, asOfMs)) continue;
        sleepBaselineValues.push(row.value);
      }
    }

    // HRV：基线窗 [D-28, D) 与当日取值（当日桶内已是 `computed_at DESC` 顺序）。
    const hrvBaselineValues: Array<number | null> = [];
    for (const hrvDate of sliceDates(hrv.dates, fromDate, addDays(date, -1))) {
      for (const row of hrv.byDate.get(hrvDate)!) {
        if (!instantBefore(row.observedAt, todayAt)) continue;
        if (!instantAtOrBefore(row.availableAt, asOfMs)) continue;
        hrvBaselineValues.push(row.value);
      }
    }
    let dayHrv: RecoveryHrvRow | undefined;
    for (const row of hrv.byDate.get(date) ?? []) {
      if (!instantAtOrBefore(row.observedAt, asOfMs)) continue;
      dayHrv = row;
      break;
    }

    // 夜事实的 `localDate` 口径：单日路径取 `wake_date === D` 的第一行。
    const night = nightWindow.find((row) => row.date === date);
    results.push(assembleDatedRecoveryFacts(day.asOf, date, {
      publicationAt,
      sleepBaselineValues, hrvBaselineValues,
      rhrBaselineByDate: [...byDate.values()].map((xs) => median(xs)),
      night, hrv: dayHrv, rhr, nights: nightWindow
    }));
  }
  return results;
}

/** 取升序日期数组里 `[from, to]`（闭区间）的片段 —— 与 SQL 的 TEXT 范围比较同义。 */
function sliceDates(dates: readonly string[], from: string, to: string): string[] {
  const start = firstDateIndexAtOrAfter(dates, from, 0);
  const slice: string[] = [];
  for (let index = start; index < dates.length && dates[index]! <= to; index += 1) slice.push(dates[index]!);
  return slice;
}

export function readinessForRun(db: DatabaseSync, lineage: ModelLineageV2) {
  return withReadinessLineage(loadDatedReadiness(db,lineage.asOf,lineage.timezoneIdentifier),{
    ...lineage,modelVersion:READINESS_MODEL_VERSION,configVersion:READINESS_RULE_SET_VERSION,
    configHash:semanticHash({sleep:READINESS_SLEEP_RATIO_THRESHOLD,hrv:READINESS_HRV_RATIO_THRESHOLD,
      rhr:READINESS_RHR_RATIO_THRESHOLD,streak:READINESS_SLEEP_STREAK_THRESHOLD,baselineDays:28,minimumBaselineDays:7,
      availability:"canonical_computation_or_publication_upper_bound"}),
    baselineEpochId:null,calibrationCohortHash:null
  });
}
