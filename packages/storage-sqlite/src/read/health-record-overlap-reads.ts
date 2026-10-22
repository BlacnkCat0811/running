import type { DatabaseSync } from "node:sqlite";

import {
  adaptiveHealthRecordOverlapQuery,
  buildBoundedHealthRecordOverlapQuery,
  probeHealthRecordOverlapTimeline,
  type HealthRecordOverlapQuery,
  type HealthRecordOverlapQueryInput,
  type HealthRecordOverlapReadShape
} from "./read-utils.js";

/**
 * `health_records` 相交读的**执行入口**（2026-10-18 复查 P2）。
 *
 * ## 为什么不再"按窗口位置二选一"
 *
 * 上一轮（caf79e7）用 `split` / `legacy` 两种形状按窗口在时间轴上的位置自适应，
 * 但两者在时间轴**中段**都必然要走约半段历史 —— B-tree 的固有下界。本次改成
 * **有界计划**：只要知道该 type 的最长记录时长 D，相交集合就只可能出现在窗口起点
 * 前 D 之内（更早开始的记录在窗口起点前已经结束），于是候选起点被收紧成一段
 * `(窗口起点 − D − slack, 窗口终点)` 的**固定宽度**区间，与窗口位置无关。
 *
 * D 与"该 type 是否含非规范时间戳"由**同一次**覆盖索引扫描得到：规范文本（导入器
 * 只写定宽 UTC）时 `slack = 0`，有 ±HH:MM 偏移的遗留行才付 24h / 48h 余量。
 * 生产库实测（2026-10-18，533,678 行）：心率 1,691 s、步数 1,937 s、距离 86,399 s；
 * **非规范行 0 条**。一次扫描 32–48 ms，只在**该 type 数据变化后的第一次读**发生
 * （缓存见下）。因此有界计划的候选行数 ≈ 每种 type 每天行数 × (D + 窗口宽度)，
 * 中段/老窗口同样快；生产实测 0.005–0.052 ms/次（`slack=0` 时近期窗口从 2.6 ms
 * 降到 0.05 ms）。
 *
 * 拿不到 D（缺索引、该 type 无有效时间戳、D 病态大、窗口文本不可解析）或读期间
 * 数据变化时，回退到 `adaptiveHealthRecordOverlapQuery` 的 `split` / `legacy`
 * —— 它们仍然**精确**，只是重新接受 B-tree 下界。
 *
 * ## 缓存凭什么可靠
 *
 * D 按 `(database 实例, type)` 缓存，失效条件是两个廉价计数器任一变化：
 * - `PRAGMA data_version`：**其他连接**提交后变化 —— 生产中导入/直连增量/重算发布/
 *   换库文件都会推进它；读连接只读，不会自增；
 * - `total_changes()`：**本连接自己**的写也会计数 —— 测试与维护路径在同一个
 *   `DatabaseSync` 上先写后读时，缓存必须随之失效（`data_version` 对自己写不敏感）。
 *
 * 执行时还要在 D 计算和查询之间再核对一次这两个计数器：只有前后完全一致才信任
 * 有界结果（否则 D 可能对应旧状态，丢弃并用始终精确的自适应形状重读）。这把窗口
 * 缩到"一次同步调用内部"，且任何不一致都会退回精确路径，不会返回错误行集。
 *
 * 为什么不做 schema 迁移加表达式索引把 D 探测变成 O(log n)：那需要一次生产库维护
 * 迁移（停服/备份/回滚约束），而本方案把成本摊到"每种 type 每次数据变化一次
 * 20–30 ms 的覆盖索引扫描"，常规运行（导入触发的数据版本变化）下可忽略；若将来
 * D 探测成为瓶颈，表达式索引是明确的下一步。
 */

/** 读路径看到的数据库状态；详见模块注释。 */
export interface HealthRecordOverlapDatabaseState {
  /** `PRAGMA data_version`：其他连接提交后变化。 */
  readonly dataVersion: number;
  /** `total_changes()`：本连接自己的写也计入。 */
  readonly totalChanges: number;
}

export interface HealthRecordOverlapReadResult {
  readonly shape: HealthRecordOverlapReadShape;
  /** 与历史实现相同的行集（去重后按投影元组全序）。 */
  readonly rows: Record<string, unknown>[];
}

export type HealthRecordOverlapStateReader = (database: DatabaseSync) => HealthRecordOverlapDatabaseState;

/** 该 type 的最长记录时长 + 是否含非规范时间戳；一次覆盖索引扫描同时得到两者。 */
export interface HealthRecordOverlapStats {
  readonly maxDurationMs: number | null;
  /** 存在 ±HH:MM 偏移等非定宽 UTC 时间戳时，有界区间需要额外余量。 */
  readonly hasNonCanonicalTimestamps: boolean;
}

export type HealthRecordOverlapStatsReader = (database: DatabaseSync, type: string) => HealthRecordOverlapStats;

/**
 * 规范定宽 UTC 形状（`normalizeAppleDate` → `toISOString()`）；与
 * `packages/health-export-parser/src/canonicalize-nights.ts` 的普查 GLOB 同形。
 * GLOB 的大小写与 `.` 都是字面量，不依赖正则回溯。
 */
export const HEALTH_RECORD_CANONICAL_INSTANT_GLOB = "????-??-??T??:??:??.???Z";

/** 默认状态读取：两次极廉价的查询（`PRAGMA` + 标量函数）。 */
export const readHealthRecordOverlapDatabaseState: HealthRecordOverlapStateReader = (database) => {
  const version = database.prepare("PRAGMA data_version").get() as { data_version?: unknown } | undefined;
  const changes = database.prepare("SELECT total_changes() AS changes").get() as { changes?: unknown } | undefined;
  return { dataVersion: Number(version?.data_version), totalChanges: Number(changes?.changes) };
};

/**
 * 默认 stats 读取：**一次**覆盖索引扫描同时得到"最长记录时长"和"是否存在非规范时间戳"。
 *
 * 无有效时间戳的行是 NULL，`MAX` 忽略它们 —— 与相交谓词的 `julianday` 条件一致
 * （这类行不可能命中 B 分支）；但只要该 type 里存在非规范文本（含不可解析日期），
 * 有界区间就按保守余量处理。生产实测（2026-10-18，533,677 行）全部规范，所以热路径
 * 实际不加余量：一次扫描约 32–48 ms，只在该 type 数据变化后的第一次读发生。
 */
export const readHealthRecordOverlapStats: HealthRecordOverlapStatsReader = (database, type) => {
  const row = database
    .prepare(
      `SELECT MAX(julianday(end_at) - julianday(start_at)) * 86400000.0 AS milliseconds,
              SUM(CASE WHEN start_at GLOB ? AND end_at GLOB ? THEN 0 ELSE 1 END) AS nonCanonical
         FROM health_records WHERE type = ?`
    )
    .get(HEALTH_RECORD_CANONICAL_INSTANT_GLOB, HEALTH_RECORD_CANONICAL_INSTANT_GLOB, type) as
    { milliseconds?: unknown; nonCanonical?: unknown } | undefined;
  const value = row?.milliseconds;
  return {
    maxDurationMs: typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null,
    hasNonCanonicalTimestamps: Number(row?.nonCanonical ?? 0) > 0
  };
};

interface StatsCacheEntry {
  readonly state: HealthRecordOverlapDatabaseState;
  readonly stats: HealthRecordOverlapStats;
}

const sameState = (left: HealthRecordOverlapDatabaseState, right: HealthRecordOverlapDatabaseState): boolean =>
  left.dataVersion === right.dataVersion && left.totalChanges === right.totalChanges;

/**
 * 相交读 stats 缓存（最长时长 + 是否非规范时间戳；进程内，按数据库实例分片）。
 *
 * `WeakMap<DatabaseSync, …>` 让连接关闭后缓存自然回收；`lookup` 每次先读状态，
 * 只有状态完全一致才复用，否则重算。对只读连接 `total_changes` 恒为 0，
 * 只靠 `data_version` 失效；对测试/维护路径的可写连接两者都参与。
 */
export type HealthRecordOverlapMissListener = (
  database: DatabaseSync,
  type: string,
  state: HealthRecordOverlapDatabaseState
) => void;

export class HealthRecordDurationCache {
  private readonly entries = new WeakMap<DatabaseSync, Map<string, StatsCacheEntry>>();
  /** Request-external rebuild hook (worker); never called on the request's bounded path. */
  private readonly missListeners = new WeakMap<DatabaseSync, Set<HealthRecordOverlapMissListener>>();

  constructor(
    private readonly state: HealthRecordOverlapStateReader = readHealthRecordOverlapDatabaseState,
    private readonly readStats: HealthRecordOverlapStatsReader = readHealthRecordOverlapStats
  ) {}

  /**
   * 只返回**当前连接状态已验证**的缓存；缺失或失效时移除条目并返回 `null`，
   * **不触发全类型统计扫描**。
   *
   * 这是生产相交读的入口：外部提交（包括与健康记录无关的回执/manifest 变化）
   * 推进 `data_version` 后，本次请求立即走精确的自适应查询，而不是在主线程同步
   * 重算 MAX(julianday…)（D2 实测 HR 约 177 ms、步数约 72 ms、速度约 43 ms）。
   * 失效后的首个请求走自适应查询；请求外的 `HealthRecordOverlapStatsWorker` 可在
   * 后台重建，主线程用捕获状态核对后 `prime`，不会阻塞本次请求。
   */
  tryLookupValid(
    database: DatabaseSync,
    type: string
  ): { readonly state: HealthRecordOverlapDatabaseState; readonly stats: HealthRecordOverlapStats } | null {
    const state = this.state(database);
    const byType = this.entries.get(database);
    const cached = byType?.get(type);
    if (cached === undefined) {
      this.notifyMiss(database, type, state);
      return null;
    }
    if (!sameState(cached.state, state)) {
      byType!.delete(type);
      this.notifyMiss(database, type, state);
      return null;
    }
    return { state, stats: cached.stats };
  }

  /**
   * 注册“缓存缺失/失效”通知。用于请求外 worker 重建统计；监听器不得在回调里
   * 同步扫表，否则又回到 B 要消除的主线程阻塞。
   */
  onMiss(database: DatabaseSync, listener: HealthRecordOverlapMissListener): () => void {
    const listeners = this.missListeners.get(database) ?? new Set<HealthRecordOverlapMissListener>();
    listeners.add(listener);
    this.missListeners.set(database, listeners);
    return () => { listeners.delete(listener); };
  }

  /**
   * 安装请求外计算出的 stats，仅当调用方捕获的状态仍是当前状态时生效。
   * 返回 false 表示计算期间发生了提交（或换库），结果必须丢弃。
   */
  prime(
    database: DatabaseSync,
    type: string,
    expectedState: HealthRecordOverlapDatabaseState,
    stats: HealthRecordOverlapStats
  ): boolean {
    if (!sameState(this.state(database), expectedState)) return false;
    const map = this.entries.get(database) ?? new Map<string, StatsCacheEntry>();
    if (stats.maxDurationMs === null) map.delete(type);
    else map.set(type, { state: expectedState, stats });
    this.entries.set(database, map);
    return true;
  }

  private notifyMiss(database: DatabaseSync, type: string, state: HealthRecordOverlapDatabaseState): void {
    for (const listener of this.missListeners.get(database) ?? []) {
      try { listener(database, type, state); } catch { /* background rebuild must not break the read */ }
    }
  }

  /**
   * 显式计算入口：返回该 type 当前状态下的 stats；缺失或失效时重算并写入缓存。
   * `maxDurationMs === null` 表示无有效时间戳。
   *
   * 生产读路径不再调用它；保留给明确的离线/维护调用方与缓存行为测试。
   */
  lookup(database: DatabaseSync, type: string): { readonly state: HealthRecordOverlapDatabaseState; readonly stats: HealthRecordOverlapStats } {
    const state = this.state(database);
    const byType = this.entries.get(database);
    const cached = byType?.get(type);
    if (cached !== undefined && sameState(cached.state, state)) {
      return { state, stats: cached.stats };
    }
    const stats = this.readStats(database, type);
    const map = byType ?? new Map<string, StatsCacheEntry>();
    if (stats.maxDurationMs === null) map.delete(type);
    else map.set(type, { state, stats });
    this.entries.set(database, map);
    return { state, stats };
  }

  /** 丢弃该 type 的缓存（读期间状态变化时调用）。 */
  invalidate(database: DatabaseSync, type: string): void {
    this.entries.get(database)?.delete(type);
  }
}

/** 生产共享缓存。 */
export const healthRecordDurationCache = new HealthRecordDurationCache();

const execute = (database: DatabaseSync, query: HealthRecordOverlapQuery): Record<string, unknown>[] =>
  database.prepare(query.sql).all(...query.params) as unknown as Record<string, unknown>[];

/**
 * 执行一次相交读：**先尝试有界计划**（生产主路径），拿不到证据或读期间数据变化时
 * 退回自适应形状。任何路径返回的行集都与历史实现逐行等价；`shape` 仅用于测试与
 * EXPLAIN 守卫，业务调用方不需要分支。
 */
export function readHealthRecordOverlap(
  database: DatabaseSync,
  input: HealthRecordOverlapQueryInput,
  options: { readonly cache?: HealthRecordDurationCache } = {}
): HealthRecordOverlapReadResult {
  const cache = options.cache ?? healthRecordDurationCache;
  const timeline = probeHealthRecordOverlapTimeline(database, input.sourceName, input.type);
  // 只读已验证缓存：失效时不重算统计，直接使用始终精确的自适应形状。
  const cached = cache.tryLookupValid(database, input.type);
  if (cached !== null && cached.stats.maxDurationMs !== null) {
    const bounded = buildBoundedHealthRecordOverlapQuery(input, {
      maxDurationMs: cached.stats.maxDurationMs,
      hasNonCanonicalTimestamps: cached.stats.hasNonCanonicalTimestamps,
      timeline
    });
    if (bounded !== null) {
      const rows = execute(database, bounded);
      const after = readHealthRecordOverlapDatabaseState(database);
      if (sameState(cached.state, after)) return { shape: "bounded", rows };
      // 读取期间有外部提交（或本连接写入）：本次有界结果不可证明，丢弃并走精确形状。
      cache.invalidate(database, input.type);
    }
  }
  const adaptive = adaptiveHealthRecordOverlapQuery(database, input, { timeline });
  return { shape: adaptive.shape, rows: execute(database, adaptive) };
}
