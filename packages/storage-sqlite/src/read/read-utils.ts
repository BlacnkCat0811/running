import type { DatabaseSync } from "node:sqlite";

export const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * 24 h of slack for indexable text-range prefilters on `health_records.start_at` /
 * `end_at`.
 *
 * Imported timestamps are normalised to fixed-width UTC (`normalizeAppleDate` →
 * `toISOString()`), so text order equals time order and a text range is exact.
 * Legacy rows may still carry a `±HH:MM` offset; comparing such text against a
 * canonical `Z` bound is then off by at most 14 h. Callers widen the indexed
 * text range by this slack so it stays a **superset** of the exact
 * `julianday(...)` window, then let the `julianday` predicates decide membership.
 * That keeps the absolute-instant semantics the facts reader documents while
 * restoring an index seek on the column.
 */
export const HEALTH_RECORD_TIME_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * 纯**文本**相交谓词（`averageCadence` 的回退读）的额外余量：48 h。
 *
 * 那个谓词是 `start_at < U AND end_at > L`（两边都是文本比较，没有 `julianday` 残差）。
 * 给它加 `start_at` 下界时，必须保证"被排除的行本来也不会命中 `end_at > L`"：
 * 行的文本跨度 = 实际时长 + (end 偏移 − start 偏移)，单个时间戳的 `±HH:MM` 偏移最多
 * 让文本位置偏 14 h、两端叠加最坏 28 h。48 h 留足余量后，文本跨度 > `D + 48h` 的行
 * 不可能同时满足 `end_at > L` 且 `start_at ≤ L − D − 48h`（见 `buildBounded…`）。
 */
export const HEALTH_RECORD_TEXT_OVERLAP_SLACK_MS = 48 * 60 * 60 * 1000;

/**
 * Canonical fixed-width UTC text shifted by `deltaMs`.
 *
 * Unparseable inputs are returned unchanged: the exact `julianday` predicate
 * still decides membership (an invalid bound yields NULL there, as before).
 */
export function shiftedIsoBound(value: string, deltaMs: number): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds + deltaMs).toISOString() : value;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const paceSeconds = (duration: number, distance: number | null): number | null =>
  distance !== null && distance > 0 ? duration / distance : null;

/**
 * `health_records` 里"与窗口 `[startedAt, endedAt)` 相交"的三种 SQL 形状。
 * 三者**结果集逐行等价**（含 ±HH:MM 遗留文本、malformed `end_at < start_at`、
 * 零长记录、完全重复行、恰好压在窗口起点/终点上的行），区别只在计划器能 seek 哪一段：
 *
 * - `bounded`（2026-10-18 复查 P2 起的**生产主路径**，见下）：
 *   用"该 type 的最长记录时长 D"把候选起点收紧到
 *   `start_at ∈ (窗口起点 − D − slack, 窗口终点)`，seek 的是一段**固定宽度**区间
 *   （≈ D + slack + 窗口宽度），与窗口在时间轴上的位置无关。`slack` 只在**存在
 *   非规范时间戳**时才需要：定宽 UTC 文本的时间序与时间轴一致，D 本身就是精确下界；
 *   带 ±HH:MM 偏移的遗留行才需要 24h（julianday 谓词）/ 48h（纯文本谓词）余量。
 * - `split`（P0-1 修复）：A 分支 `start_at ∈ [起点, 终点)` 走
 *   `idx_health_records_source_time` 的双端 seek；B 分支（跨窗口起点的长区间）
 *   `start_at < 起点 AND end_at > 起点-24h` 走 `idx_health_records_type_end`。
 *   🔴 B 分支**只有 `end_at` 的文本下界、没有上界**：窗口越**老**扫过的历史越多
 *   （合成 21 万行实测：近期 0.30–0.40 ms，最老窗口 16.8 ms）。
 * - `legacy`（P0-1 之前的单段 OR 谓词）：只 seek `start_at < 窗口终点`，窗口越**新**
 *   扫过的历史越多（近期实测 60.7 ms，即 O(全历史)）。
 *
 * `split` / `legacy` 的成本曲线一个嫌"老"、一个嫌"新"，两者**中段都要走约半段历史**
 * —— 这是 B-tree 的固有下界（与 `v40-migration.ts` 同源论证）。`bounded` 把这段
 * 下界也消掉：只要知道该 type 的最大记录时长 D，相交集合只可能出现在窗口起点前
 * D 之内（更早的记录在窗口起点前就结束了）。D 与"是否存在非规范时间戳"由**同一次**
 * 覆盖索引扫描得到，按 `(data_version, total_changes)` 缓存在进程内
 * （见 `health-record-overlap-reads.ts`）：一次扫描 ≈ 32–48 ms、只在该 type
 * 数据变化后的第一次读发生。生产库实测（2026-10-18）：D 心率 1691 s、步数 1937 s、
 * 距离 86,399 s；533,678 行**全部**为定宽 UTC（非规范 0 行），所以热路径不加 slack。
 * 于是 `bounded` 的候选行数 ≈ 每种 type 每天行数 × (D + 窗口宽度) ≈ 数十到数百行，
 * 与窗口在时间轴上的位置无关（生产实测 0.005–0.052 ms/次，见下）。
 *
 * `bounded` 不再依赖窗口位置的启发式估计（生产路径不再调用
 * `chooseHealthRecordOverlapShape`）；`split` / `legacy` 只在拿不到 D
 * （没有可用索引、该 type 无有效时间戳、D 过大导致有界区间不划算、读期间数据变化）
 * 时作为**精确回退**使用。
 *
 * 两种谓词语义：
 * - `windowOrCrossing`（`metricIntervals` / `averageRawMetric`）：A 分支只要起点落在
 *   窗口内就命中（即使 end < start 的 malformed 行），B 分支要求 julianday 精确相交。
 * - `pureOverlap`（`averageCadence` 的回退读）：`start_at < U AND end_at > L`，
 *   两边都是文本比较，没有 julianday 残差。
 */
export type HealthRecordOverlapShape = "split" | "legacy";

/** 相交谓词族；决定 B 分支是否带 `julianday` 残差、以及 `bounded` 的文本余量。 */
export type HealthRecordOverlapPredicate = "windowOrCrossing" | "pureOverlap";

/** `bounded` + 两种回退形状共用的读形状（`bounded` 是生产主路径）。 */
export type HealthRecordOverlapReadShape = "bounded" | HealthRecordOverlapShape;

/**
 * 相交读允许投影的列。两处调用点的**行集语义不同**，不能统一：
 * - `SqliteSeriesReadRepository.metricIntervals` 投影 `unit`（去重键含 unit，
 *   `transform` 也按 unit 换算单位）；
 * - `SqliteWorkoutReadRepository.averageRawMetric` 不投影 `unit`（去重键不含 unit）。
 * 统一列清单会让"同一 (start_at, end_at, value_numeric) 但 unit 不同"的行从两行变一行，
 * 直接改变加权平均的分母。`start_at` 必选：调用方按它排序并推算下一条记录。
 */
export type HealthRecordOverlapColumn = "start_at" | "end_at" | "value_numeric" | "unit";

export interface HealthRecordOverlapQueryInput {
  type: string;
  sourceName: string;
  /** 窗口起点/终点（文本）。比较语义与历史实现一致：`start_at`/`end_at` 按**文本序**比较。 */
  startedAt: string;
  endedAt: string;
  columns: readonly HealthRecordOverlapColumn[];
  /** 默认 `windowOrCrossing`（P0 之后的语义）；`pureOverlap` 供 `averageCadence` 回退读。 */
  predicate?: HealthRecordOverlapPredicate;
}

/** 谓词族归一化；历史调用方不传时保持 `windowOrCrossing` 的行为不变。 */
export function healthRecordOverlapPredicate(input: HealthRecordOverlapQueryInput): HealthRecordOverlapPredicate {
  return input.predicate ?? "windowOrCrossing";
}

export interface HealthRecordOverlapQuery {
  sql: string;
  params: string[];
}

/** 时间轴两端的探测（绝对时刻 ms；`null` = 无行/不可解析）。 */
export interface HealthRecordOverlapTimeline {
  /** source 侧 `start_at` 的两端（`legacy` 的成本轴）。 */
  sourceStartMs: number | null;
  sourceEndMs: number | null;
  /** type 侧 `end_at` 的两端（`split` B 分支的成本轴）。 */
  typeStartMs: number | null;
  typeEndMs: number | null;
  /** `idx_health_records_type_end` 是否可用：缺失时 `split` 的 B 分支没有 end_at seek。 */
  typeEndIndexAvailable: boolean;
  /** `idx_health_records_source_time` 是否可用：缺失时 `legacy` 没有 start_at seek。 */
  sourceTimeIndexAvailable: boolean;
  /**
   * `idx_health_records_type_time(type, start_at, end_at)` 是否可用：
   * `bounded` 至少需要一条能按 `start_at` 区间 seek 的索引（source_time 或 type_time），
   * 最长时长探测也需要一条覆盖 `(type, start_at, end_at)` 的索引。
   */
  typeTimeIndexAvailable: boolean;
}

export interface HealthRecordOverlapChoice {
  shape: HealthRecordOverlapShape;
  /** legacy 的估算成本（占 source `start_at` 时间轴的比例，0..1）；无法估算时 `null`。 */
  legacyCost: number | null;
  /** split B 分支的估算成本（占 type `end_at` 时间轴的比例，0..1）；无法估算时 `null`。 */
  splitCost: number | null;
}

export interface HealthRecordOverlapReadQuery extends HealthRecordOverlapQuery {
  shape: HealthRecordOverlapShape;
}

/** `bounded` 计划的构造结果；`null` 表示该次调用拿不到有界证据（退回自适应形状）。 */
export interface HealthRecordOverlapBoundedOptions {
  /** 该 type 的最长记录时长（ms）；由 `MAX(julianday(end_at) − julianday(start_at))` 得到。 */
  readonly maxDurationMs: number;
  /**
   * 该 type 是否存在**非规范**（非定宽 UTC、可能带 ±HH:MM 偏移）时间戳。
   *
   * `false` 时文本序 == 时间序，有界区间不需要偏移余量（`start_at > 窗口起点 − D` 即精确）；
   * `true` 时按谓词族加 24 h / 48 h 余量（见 `HEALTH_RECORD_TIME_SLACK_MS`、
   * `HEALTH_RECORD_TEXT_OVERLAP_SLACK_MS`）。生产库 2026-10-18 实测 533,678 行全部规范，
   * 因此热路径实际不需要这段余量；只有遗留/手工写入的库才付这个成本。
   */
  readonly hasNonCanonicalTimestamps: boolean;
  /** 本次调用使用的（已探测好的）时间轴；避免在热路径上重复探测。 */
  readonly timeline: HealthRecordOverlapTimeline;
}

function overlapSelectParts(input: HealthRecordOverlapQueryInput): { columns: string; orderBy: string } {
  if (!input.columns.includes("start_at")) {
    // 两处调用方都依赖 `start_at` 做区间归属与"下一条记录"推断；少了它 SQL 也不成立。
    throw new Error("health record overlap query requires the start_at column");
  }
  const columns = input.columns.join(", ");
  // 次序键 = 投影元组的字典序。两种形状对同一窗口必须连**平手行**（同一 start_at、
  // 不同 end_at/value/unit）的行序都一致，而历史实现只写 `ORDER BY start_at` 时
  // 平手行序由引擎决定（同一形状在有无索引时都可能不同，实测过）。投影元组经
  // UNION/DISTINCT 去重后是唯一的，所以按它排序是一个**全序**，两种形状因此逐行相同。
  // 主序 `start_at` 不变；调用方（区间归属、"下一条记录"推断）只用主序。
  return { columns, orderBy: columns };
}

/**
 * `split` 形状（P0-1 之后的正式形状）。
 *
 * 两个 UNION 分支互斥（A 的 `start_at ∈ [起点,终点)`、B 的 `start_at < 起点`），
 * 各自都能用索引 seek；`UNION`（非 ALL）与改造前的 `SELECT DISTINCT` 一样按投影
 * 元组去重，所以重复行只出现一次。B 分支的 `end_at > 起点-24h` 文本下界是
 * `julianday(end_at) > julianday(起点)` 的**超集**（带 ±HH:MM 偏移的遗留文本最多早 14 h，
 * 见 {@link HEALTH_RECORD_TIME_SLACK_MS}），精确归属仍由 `julianday` 残差决定。
 */
export function buildSplitHealthRecordOverlapQuery(
  input: HealthRecordOverlapQueryInput
): HealthRecordOverlapQuery {
  const { columns, orderBy } = overlapSelectParts(input);
  const overlapBound = shiftedIsoBound(input.startedAt, -HEALTH_RECORD_TIME_SLACK_MS);
  return {
    sql: `
      WITH bounded AS MATERIALIZED (
        SELECT ${columns}
        FROM health_records
        WHERE type = ? AND source_name = ? AND value_numeric IS NOT NULL
          AND start_at >= ? AND start_at < ?
        UNION
        SELECT ${columns}
        FROM health_records
        WHERE type = ? AND source_name = ? AND value_numeric IS NOT NULL
          AND start_at < ? AND end_at > ?
          AND julianday(end_at) > julianday(start_at)
          AND julianday(end_at) > julianday(?)
      )
      SELECT ${columns}
      FROM bounded
      ORDER BY ${orderBy}
    `,
    params: [
      input.type, input.sourceName, input.startedAt, input.endedAt,
      input.type, input.sourceName, input.startedAt, overlapBound, input.startedAt
    ]
  };
}

/**
 * `legacy` 形状：P0-1 之前的单段 OR 谓词，逐字恢复（含 `DISTINCT` 子查询的包法）。
 *
 * 它在之前的差分验证里已证明与 `split` 逐行等价，所以只当"老窗口"路径用：
 * 窗口在时间轴前端时，`start_at < 窗口终点` 的 seek 只走过一小段历史。
 */
export function buildLegacyHealthRecordOverlapQuery(
  input: HealthRecordOverlapQueryInput
): HealthRecordOverlapQuery {
  const { columns, orderBy } = overlapSelectParts(input);
  return {
    sql: `
      SELECT ${columns}
      FROM (
        SELECT DISTINCT ${columns}
        FROM health_records
        WHERE type = ? AND source_name = ? AND value_numeric IS NOT NULL
          AND start_at < ?
          AND (
            start_at >= ?
            OR (
              julianday(end_at) > julianday(start_at)
              AND julianday(end_at) > julianday(?)
            )
          )
      )
      ORDER BY ${orderBy}
    `,
    params: [input.type, input.sourceName, input.endedAt, input.startedAt, input.startedAt]
  };
}

/**
 * `pureOverlap` 的 `split` 形状（`averageCadence` 回退读）。
 *
 * 与原谓词 `start_at < U AND end_at > L`（两边都是文本比较）等价：
 * A = {start ∈ [L,U) ∧ end_text > L}、B = {start < L ∧ end_text > L}，
 * 并集正好是原集合——原谓词对"起点落在窗口内"的行同样要求 `end_at > L`。
 * 两个分支都能分别用 start_at / end_at 索引 seek，因此老窗口不再走
 * `end_at > L` 的长尾（那是 cadence 之前唯一谓词的形态）。
 */
export function buildSplitHealthRecordPureOverlapQuery(
  input: HealthRecordOverlapQueryInput
): HealthRecordOverlapQuery {
  const { columns, orderBy } = overlapSelectParts(input);
  return {
    sql: `
      WITH bounded AS MATERIALIZED (
        SELECT ${columns}
        FROM health_records
        WHERE type = ? AND source_name = ? AND value_numeric IS NOT NULL
          AND start_at >= ? AND start_at < ? AND end_at > ?
        UNION
        SELECT ${columns}
        FROM health_records
        WHERE type = ? AND source_name = ? AND value_numeric IS NOT NULL
          AND start_at < ? AND end_at > ?
      )
      SELECT ${columns}
      FROM bounded
      ORDER BY ${orderBy}
    `,
    params: [
      input.type, input.sourceName, input.startedAt, input.endedAt, input.startedAt,
      input.type, input.sourceName, input.startedAt, input.startedAt
    ]
  };
}

/** `pureOverlap` 的 `legacy` 形状：原谓词逐字恢复（单段 `start_at < U` 范围 + `end_at > L`）。 */
export function buildLegacyHealthRecordPureOverlapQuery(
  input: HealthRecordOverlapQueryInput
): HealthRecordOverlapQuery {
  const { columns, orderBy } = overlapSelectParts(input);
  return {
    sql: `
      SELECT ${columns}
      FROM (
        SELECT DISTINCT ${columns}
        FROM health_records
        WHERE type = ? AND source_name = ? AND value_numeric IS NOT NULL
          AND start_at < ? AND end_at > ?
      )
      ORDER BY ${orderBy}
    `,
    params: [input.type, input.sourceName, input.endedAt, input.startedAt]
  };
}

/** 按谓词族选 `split` / `legacy` 构造器（`bounded` 见 {@link buildBoundedHealthRecordOverlapQuery}）。 */
function buildAdaptiveShapeQuery(
  input: HealthRecordOverlapQueryInput,
  shape: HealthRecordOverlapShape
): HealthRecordOverlapQuery {
  const pureOverlap = healthRecordOverlapPredicate(input) === "pureOverlap";
  if (pureOverlap) {
    return shape === "split"
      ? buildSplitHealthRecordPureOverlapQuery(input)
      : buildLegacyHealthRecordPureOverlapQuery(input);
  }
  return shape === "split"
    ? buildSplitHealthRecordOverlapQuery(input)
    : buildLegacyHealthRecordOverlapQuery(input);
}

/** 时间轴两端之间的跨度；单点（两端同刻）/反向/缺失时返回 `null`（分式无意义）。 */
function timelineSpan(startMs: number | null, endMs: number | null): number | null {
  if (startMs === null || endMs === null || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const spanMs = endMs - startMs;
  return spanMs > 0 ? spanMs : null;
}

/** 距离占跨度的比例，夹到 `[0, 1]`（窗口可能落在时间轴之外）。 */
function costFraction(distanceMs: number, spanMs: number): number {
  return Math.min(1, Math.max(0, distanceMs / spanMs));
}

/**
 * `legacy` 每扫过一行比 `split` 贵约 3 倍的实测修正因子（2026-10-18 复查 P1）。
 *
 * 只按"扫过的历史占比"取小还不够：两种形状的**每行成本**不同。`legacy` 的 seek 是
 * `(source_name, start_at)`，`type` 与 `value_numeric` 都要回表过滤；`split` 的 B 分支
 * `(type, end_at, start_at)` 覆盖了 type/end_at/start_at。合成 21 万行实测（3 年均匀、
 * 三索引齐全、窗口宽 1 小时、p50）：扫满全历史时 legacy ≈ 50 ms 而 split ≈ 12–17 ms；
 * 25% 位置 legacy ≈ 10.7 ms vs split ≈ 8.8 ms；50% 位置 legacy ≈ 23.9 ms vs split ≈ 5.7 ms。
 *
 * 不修正时会在 25%–50% 区间选到 legacy，实际比 split 慢 2–4×（最坏 ~24 ms vs ~6 ms），
 * 等于把"老窗口变快"换成"中段变慢"。乘上保守因子 3 后：最老约 25% 仍走 legacy
 * （实测相当或更快），其余位置走 split，所有位置都不超过改造前的最坏值。
 */
const LEGACY_RELATIVE_ROW_COST = 3;

/**
 * 形状选择（纯函数）：**只做启发式估计，从不影响结果集**。
 *
 * 成本模型（均匀密度假设 + 每行成本修正）：
 * - legacy ≈ `(窗口终点 - sourceStart) / (sourceEnd - sourceStart)`
 *   —— `start_at < 窗口终点` 的 seek 从 source 历史起点走过来，窗口越新占比越大；
 * - split(B) ≈ `(typeEnd - 窗口起点) / (typeEnd - typeStart)`
 *   —— `end_at > 窗口起点` 的 seek 从 type 时间轴末端往回走，窗口越老占比越大；
 * - legacy 占比再乘 {@link LEGACY_RELATIVE_ROW_COST}（回表过滤让每行更贵）。
 * 修正后 split 严格更小才用 split，否则用 legacy（保留"平手偏 legacy"的既有口径）。
 *
 * 回退 `split`（= P0-1 之后的既有行为）的情形：缺 `idx_health_records_type_end`
 * 或 `idx_health_records_source_time`（没有可比的 seek，且 P0 形状是当前生产行为）、
 * 空库/探测值不可解析、时间轴退化（只有单一时刻）、窗口文本不可解析。
 */
export function chooseHealthRecordOverlapShape(
  startedAt: string,
  endedAt: string,
  timeline: HealthRecordOverlapTimeline
): HealthRecordOverlapChoice {
  const fallback: HealthRecordOverlapChoice = { shape: "split", legacyCost: null, splitCost: null };
  if (!timeline.typeEndIndexAvailable || !timeline.sourceTimeIndexAvailable) return fallback;
  const windowStartMs = Date.parse(startedAt);
  const windowEndMs = Date.parse(endedAt);
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) return fallback;
  const { sourceStartMs, sourceEndMs, typeStartMs, typeEndMs } = timeline;
  const sourceSpanMs = timelineSpan(sourceStartMs, sourceEndMs);
  const typeSpanMs = timelineSpan(typeStartMs, typeEndMs);
  if (sourceStartMs === null || typeEndMs === null || sourceSpanMs === null || typeSpanMs === null) {
    return fallback;
  }
  const legacyCost = costFraction(windowEndMs - sourceStartMs, sourceSpanMs);
  const splitCost = costFraction(typeEndMs - windowStartMs, typeSpanMs);
  const legacyWeightedCost = legacyCost * LEGACY_RELATIVE_ROW_COST;
  return { shape: splitCost < legacyWeightedCost ? "split" : "legacy", legacyCost, splitCost };
}

/**
 * `bounded` 区间占 source 时间轴超过这一比例时退回自适应形状。
 *
 * 正常生产数据远小于 0.5（心率：D+24h ≈ 25h，6.6 年时间轴 ⇒ ~0.04%）；这条只兜住
 * "病态 D"（例如某 type 有一条跨越大半历史的记录）。此时有界计划并不比两种扫描形状
 * 更好，回退到它们仍然是**精确**的，只是重新接受 B-tree 下界。
 */
const MAX_BOUNDED_TIMELINE_FRACTION = 0.5;

/**
 * `bounded` 计划（2026-10-18 复查 P2 起的生产主路径）：用该 type 的**最长记录时长 D**
 * 把候选起点收紧到 `(窗口起点 − D − slack, 窗口终点)`。
 *
 * ## 为什么这样是精确的
 *
 * `windowOrCrossing`：B 分支要求 `julianday(end_at) > julianday(L)`，而
 * `end − start = duration ≤ D` ⇒ `start_instant > L − D`。带 ±HH:MM 偏移的遗留文本
 * 相对绝对时刻最多偏 14 h，24 h 余量保证这些行仍落在文本下界之上；窗口内起点
 * （A 分支）本来就满足 `start_text >= L_text > 下界`。被下界排除的行因此不可能命中，
 * 结果集与 `split` / `legacy` 逐行相等。
 *
 * `pureOverlap`：谓词两边都是文本比较，行的文本跨度 ≤ 实际时长 + 两端偏移差 ≤ D + 28 h；
 * 48 h 余量保证"文本跨度 > D+48h 且仍 `end_at > L`"不可能发生，因此同样精确。
 * 前提是时间戳为可解析的 ISO 文本（导入器 `normalizeAppleDate` 只会写定宽 UTC，
 * 遗留行最多带 ±HH:MM）——读路径的索引 seek 本来就要求"文本序 == 时间序"。
 *
 * 返回 `null` 表示**拿不到有界证据**（缺索引 / 该 type 无有效时间戳 / D 病态大 /
 * 窗口文本不可解析），调用方应退回 `adaptiveHealthRecordOverlapQuery`（仍然精确）。
 */
export function buildBoundedHealthRecordOverlapQuery(
  input: HealthRecordOverlapQueryInput,
  options: HealthRecordOverlapBoundedOptions
): HealthRecordOverlapQuery | null {
  const timeline = options.timeline;
  // bounded 的候选行用 `source_name + start_at 区间` seek（`idx_health_records_source_time`）；
  // 覆盖库也可以，但生产基线一定有 source_time，缺失即视为"拿不到有界证据"。
  const hasStartSeek = timeline.sourceTimeIndexAvailable;
  // 最长时长探测用 `MAX(julianday(end_at) − julianday(start_at))`，需要一条覆盖
  // `(type, start_at, end_at)` 的索引才不会退化成全表扫描。
  const hasDurationCoverIndex = timeline.typeTimeIndexAvailable || timeline.typeEndIndexAvailable;
  if (!hasStartSeek || !hasDurationCoverIndex) return null;
  const startedMs = Date.parse(input.startedAt);
  const endedMs = Date.parse(input.endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return null;
  const maxDurationMs = options.maxDurationMs;
  if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0) return null;
  const spanMs = timelineSpan(timeline.sourceStartMs, timeline.sourceEndMs);
  if (spanMs === null) return null;
  // 只有存在非规范时间戳时才需要偏移余量：规范文本的时间序与时间轴一致，
  // `start_at > 窗口起点 − D` 本身已经是精确下界（见 `buildBoundedHealthRecordOverlapQuery` 注释）。
  const slackMs = options.hasNonCanonicalTimestamps
    ? (healthRecordOverlapPredicate(input) === "pureOverlap"
      ? HEALTH_RECORD_TEXT_OVERLAP_SLACK_MS
      : HEALTH_RECORD_TIME_SLACK_MS)
    : 0;
  const boundedWidthMs = maxDurationMs + slackMs + Math.max(0, endedMs - startedMs);
  if (boundedWidthMs > spanMs * MAX_BOUNDED_TIMELINE_FRACTION) return null;

  const lowerBound = shiftedIsoBound(input.startedAt, -(maxDurationMs + slackMs));
  const { columns, orderBy } = overlapSelectParts(input);
  if (healthRecordOverlapPredicate(input) === "pureOverlap") {
    return {
      sql: `
        SELECT ${columns}
        FROM (
          SELECT DISTINCT ${columns}
          FROM health_records
          WHERE type = ? AND source_name = ? AND value_numeric IS NOT NULL
            AND start_at < ? AND start_at > ?
            AND end_at > ?
        )
        ORDER BY ${orderBy}
      `,
      params: [input.type, input.sourceName, input.endedAt, lowerBound, input.startedAt]
    };
  }
  return {
    sql: `
      SELECT ${columns}
      FROM (
        SELECT DISTINCT ${columns}
        FROM health_records
        WHERE type = ? AND source_name = ? AND value_numeric IS NOT NULL
          AND start_at < ? AND start_at > ?
          AND (
            start_at >= ?
            OR (
              julianday(end_at) > julianday(start_at)
              AND julianday(end_at) > julianday(?)
            )
          )
      )
      ORDER BY ${orderBy}
    `,
    params: [input.type, input.sourceName, input.endedAt, lowerBound, input.startedAt, input.startedAt]
  };
}

/**
 * 读取 `idx_health_records_type_end` / `idx_health_records_source_time` 是否存在。
 *
 * 用一条 `sqlite_master` 小表查询（不依赖 `PRAGMA` 的输出形状，也免去多次 prepare）。
 * 只认这两个**索引名**：仓库的基线 schema 建 `source_time`（`database.ts`），
 * v40 迁移建 `type_end`（`v40-migration.ts`）。名字对不上（例如有人另建等价索引）
 * 时按"缺索引"回退 `split`，宁可少优化也不假装这层保护存在。
 */
function healthRecordOverlapIndexAvailability(
  database: DatabaseSync
): Pick<HealthRecordOverlapTimeline, "typeEndIndexAvailable" | "sourceTimeIndexAvailable" | "typeTimeIndexAvailable"> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'health_records'")
    .all() as Array<{ name?: unknown }>;
  const names = new Set(rows.map((row) => String(row.name)));
  return {
    typeEndIndexAvailable: names.has("idx_health_records_type_end"),
    sourceTimeIndexAvailable: names.has("idx_health_records_source_time"),
    typeTimeIndexAvailable: names.has("idx_health_records_type_time")
  };
}

/** 一条 `... ORDER BY <列> ASC|DESC LIMIT 1` 的索引端点探测；返回绝对时刻，失败为 `null`。 */
function probeHealthRecordBound(database: DatabaseSync, sql: string, parameter: string): number | null {
  const row = database.prepare(sql).get(parameter) as Record<string, unknown> | undefined;
  const bound = row?.bound;
  if (typeof bound !== "string") return null;
  const milliseconds = Date.parse(bound);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

/**
 * 4 条 O(log n) 索引端点探测 + 一条索引可用性查询。
 *
 * 成本（本机 `:memory:` 合成 21 万行、三个索引齐全）：每条端点探测约 0.012 ms，
 * 索引可用性查询约 0.02 ms ⇒ 一次形状选择约 0.07 ms；同期近期窗口的 split 查询约
 * 0.34–0.40 ms，而它替掉的最老窗口 split 查询是 16.8 ms。空表/缺索引时不做探测。
 *
 * 探测值是**文本序**的首/末行，再 `Date.parse` 成绝对时刻：`±HH:MM` 遗留文本会让
 * 端点绝对时刻最多偏 14 h。这只会让成本估计偏一点（选到次优形状），**不影响结果集**
 * —— 形状选择只决定用哪条已证明等价的 SQL。
 */
export function probeHealthRecordOverlapTimeline(
  database: DatabaseSync,
  sourceName: string,
  type: string
): HealthRecordOverlapTimeline {
  const availability = healthRecordOverlapIndexAvailability(database);
  const timeline: HealthRecordOverlapTimeline = {
    sourceStartMs: null,
    sourceEndMs: null,
    typeStartMs: null,
    typeEndMs: null,
    ...availability
  };
  // 按可用索引分别探测：source 侧走 source_time，type 侧走 type_end。
  // 两者都缺时（裸测试表）不做探测，调用方回退 split（精确但可能慢）。
  if (availability.sourceTimeIndexAvailable) {
    timeline.sourceStartMs = probeHealthRecordBound(
      database,
      "SELECT start_at AS bound FROM health_records WHERE source_name = ? ORDER BY start_at ASC LIMIT 1",
      sourceName
    );
    timeline.sourceEndMs = probeHealthRecordBound(
      database,
      "SELECT start_at AS bound FROM health_records WHERE source_name = ? ORDER BY start_at DESC LIMIT 1",
      sourceName
    );
  }
  if (availability.typeEndIndexAvailable) {
    timeline.typeStartMs = probeHealthRecordBound(
      database,
      "SELECT end_at AS bound FROM health_records WHERE type = ? ORDER BY end_at ASC LIMIT 1",
      type
    );
    timeline.typeEndMs = probeHealthRecordBound(
      database,
      "SELECT end_at AS bound FROM health_records WHERE type = ? ORDER BY end_at DESC LIMIT 1",
      type
    );
  }
  return timeline;
}

/**
 * 自适应入口（`bounded` 不可用时的**精确回退**）：探测 → 选形状 → 构造 SQL。
 * `bounded` 主路径见 `health-record-overlap-reads.ts` 的 `readHealthRecordOverlap`。
 *
 * 返回 `shape` 是为了让测试和 EXPLAIN 守卫能钉住"这次调用到底走了哪条形状"。
 */
export function adaptiveHealthRecordOverlapQuery(
  database: DatabaseSync,
  input: HealthRecordOverlapQueryInput,
  options: { timeline?: HealthRecordOverlapTimeline } = {}
): HealthRecordOverlapReadQuery {
  const timeline = options.timeline ?? probeHealthRecordOverlapTimeline(database, input.sourceName, input.type);
  const { shape } = chooseHealthRecordOverlapShape(input.startedAt, input.endedAt, timeline);
  return { shape, ...buildAdaptiveShapeQuery(input, shape) };
}
