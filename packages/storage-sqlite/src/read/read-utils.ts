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
 * `health_records` 里"与窗口 `[startedAt, endedAt)` 相交"的两种 SQL 形状。
 * 两者**结果集逐行等价**（含 ±HH:MM 遗留文本、malformed `end_at < start_at`、
 * 零长记录、完全重复行、恰好压在窗口起点/终点上的行），区别只在计划器能 seek 哪一端：
 *
 * - `split`（P0-1 之后，2026-10-18 事故复盘的 P0 修复）：
 *   A 分支 `start_at ∈ [窗口起点, 窗口终点)` 走 `idx_health_records_source_time`
 *   的双端 seek；B 分支（跨窗口起点的长区间）`start_at < 窗口起点 AND end_at > 窗口起点-24h`
 *   走 `idx_health_records_type_end(type, end_at, start_at)`。
 *   🔴 B 分支**只有 `end_at` 的文本下界、没有上界**：代价 ≈ 该 type 的 `end_at`
 *   晚于窗口起点的历史行数 —— 窗口越**老**，扫过的历史越多（合成 21 万行实测：
 *   近期窗口 0.30–0.40 ms，最老窗口 16.8 ms）。
 * - `legacy`（P0-1 之前的单段 OR 谓词，此处原样恢复）：
 *   `start_at < 窗口终点 AND (start_at >= 窗口起点 OR (julianday(end_at) > julianday(start_at)
 *   AND julianday(end_at) > julianday(窗口起点)))`，只 seek
 *   `idx_health_records_source_time(source_name, start_at, end_at)` 的 `start_at < 窗口终点`。
 *   代价 ≈ 该 source 的 `start_at` 早于窗口终点的历史行数 —— 窗口越**新**，扫过的历史越多
 *   （近期窗口实测 60.7 ms，即 O(全历史)）。
 *
 * 两条成本曲线一个嫌"老"、一个嫌"新"，所以在**每次调用时**各估一个相对占比、取小者
 * （见 {@link chooseHealthRecordOverlapShape}）：最坏情况从"随全历史增长"降到
 * "随到时间轴最近一端的距离增长"。中段窗口两种形状都要走约半段历史 —— 那是 B-tree
 * 的固有下界，本自适应**不承诺**改善它（成本论证与 `v40-migration.ts` 同源：
 * `(type, end_at, start_at)` 只把"窗口在历史末端"的热路径从 ~21,860 项 seek 降到 60 项，
 * 中段窗口两侧仍各约一半）。
 */
export type HealthRecordOverlapShape = "split" | "legacy";

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
 * 读取 `idx_health_records_type_end` / `idx_health_records_source_time` 是否存在。
 *
 * 用一条 `sqlite_master` 小表查询（不依赖 `PRAGMA` 的输出形状，也免去多次 prepare）。
 * 只认这两个**索引名**：仓库的基线 schema 建 `source_time`（`database.ts`），
 * v40 迁移建 `type_end`（`v40-migration.ts`）。名字对不上（例如有人另建等价索引）
 * 时按"缺索引"回退 `split`，宁可少优化也不假装这层保护存在。
 */
function healthRecordOverlapIndexAvailability(
  database: DatabaseSync
): Pick<HealthRecordOverlapTimeline, "typeEndIndexAvailable" | "sourceTimeIndexAvailable"> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'health_records'")
    .all() as Array<{ name?: unknown }>;
  const names = new Set(rows.map((row) => String(row.name)));
  return {
    typeEndIndexAvailable: names.has("idx_health_records_type_end"),
    sourceTimeIndexAvailable: names.has("idx_health_records_source_time")
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
  // 缺任一索引就没有可比的 seek（split 也不再用 end_at 下界），不必再花 4 条探测。
  if (!availability.typeEndIndexAvailable || !availability.sourceTimeIndexAvailable) return timeline;
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
  return timeline;
}

/**
 * 生产入口：探测 → 选形状 → 构造 SQL。两个调用点（`metricIntervals`、
 * `averageRawMetric`）都走这里，避免两边 SQL/参数再次漂移。
 *
 * 返回 `shape` 是为了让测试和 EXPLAIN 守卫能钉住"这次调用到底走了哪条形状"。
 */
export function adaptiveHealthRecordOverlapQuery(
  database: DatabaseSync,
  input: HealthRecordOverlapQueryInput
): HealthRecordOverlapReadQuery {
  const timeline = probeHealthRecordOverlapTimeline(database, input.sourceName, input.type);
  const { shape } = chooseHealthRecordOverlapShape(input.startedAt, input.endedAt, timeline);
  const query =
    shape === "legacy"
      ? buildLegacyHealthRecordOverlapQuery(input)
      : buildSplitHealthRecordOverlapQuery(input);
  return { shape, ...query };
}
