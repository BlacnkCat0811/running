import type { DatabaseSync } from "node:sqlite";

/**
 * 事务边界的**显式**形状（O07 / 2026-10-16）。
 *
 * ## 为什么需要它
 *
 * 分析跑在 worker 线程里，写许可由主线程持有，两条线程之间靠一条**被代理的连接**
 * （`apps/api/src/write-lease.ts` 的 `withWriteGate`）传递。逐语句包窗口的代理有一个结构性
 * 缺口：`BEGIN IMMEDIATE … COMMIT` 是三条独立语句 —— 事务**开着**的时候许可已经交回去了，
 * 于是"许可空闲但数据库仍被锁"。夹具（`apps/api/test/write-lease.test.ts` 末例）在修复前精确红。
 *
 * 修法是把"一个许可窗口 = 一个短事务"变成**可调用的边界**，而不是靠语句之间的巧合：
 * 代理在自己身上暴露 `withWriteTransaction`，仓库层按**结构**发现它（本文件就是那个发现点）。
 *
 * ## 为什么是结构发现而不是 import
 *
 * `@rai/storage-sqlite` 不该依赖 `apps/api`。这里只声明形状，实现由代理提供；
 * 没有代理时（CLI、单测、主线程）回落成裸 `BEGIN IMMEDIATE`/`COMMIT` ——
 * 那些路径本来就不经过闸门，行为与今天逐字节相同。
 */
export interface WriteTransactionScope {
  withWriteTransaction<T>(operation: () => T): T;
}

/** 代理连接的运行时探测：有 `withWriteTransaction` 就是事务感知的。 */
export function isWriteTransactionScope(database: unknown): database is WriteTransactionScope {
  return typeof (database as { withWriteTransaction?: unknown } | null | undefined)?.withWriteTransaction === "function";
}

/**
 * 在**一个写许可窗口**内跑一段短事务。
 *
 * ⛔ `operation` 里**只允许短 SQL**：不得有网络、HealthKit、或长 CPU 计算。把 CPU 放进这个
 * 窗口，就把"写锁只覆盖短 SQL 事务"（A11）退化成了"整轮持锁"——正是 O07 要消灭的形态。
 *
 * ⛔ 回滚**绝不覆盖原始错误**：原始错误是"为什么这一批失败"的唯一证据。
 */
export function withDatabaseTransaction<T>(database: DatabaseSync, operation: () => T): T {
  if (isWriteTransactionScope(database)) return database.withWriteTransaction(operation);
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    rollbackWithoutReplacing(database, error);
    throw error;
  }
}

/**
 * 回滚但保留原始错误。
 *
 * 为什么不是 `catch { database.exec("ROLLBACK") } finally { throw error }` 那么写：
 * 回滚**自己**也可能抛（连接已断、事务已不在）。那种情况下把回滚错误当主错误抛出去，
 * 会把"为什么这批数据失败"换成"回滚也失败了"，排查直接断线。所以回滚失败的细节挂在
 * `rollbackFailure` 上，主错误照抛。
 */
export function rollbackWithoutReplacing(database: DatabaseSync, error: unknown): void {
  try {
    database.exec("ROLLBACK");
  } catch (rollbackError) {
    if (error instanceof Error) {
      (error as Error & { rollbackFailure?: unknown }).rollbackFailure = rollbackError;
    }
  }
}

/**
 * 可重试的调度失败（结构判据，不 import 触发方）。
 *
 * 今天唯一的生产者是写租约超时（`WriteLeaseTimeoutError`）：它不是数据/逻辑错误，
 * 重排一次就可能成功。任务因此回到 `queued` 而不是终态失败。
 */
export interface RetryableJobFailure {
  readonly retryable: true;
}

export function isRetryableJobFailure(error: unknown): error is RetryableJobFailure {
  return typeof error === "object" && error !== null
    && (error as { retryable?: unknown }).retryable === true;
}

/**
 * 可重试失败的任务重排上限。
 *
 * 🔴 必须**有界**：没有上限时，"许可永远拿不到"会变成无限重排（任务永远在队列里转，
 * 而用户看不到任何结论）。超过上限即终态失败，并在诊断里留下尝试次数。
 */
export const RETRYABLE_JOB_ATTEMPT_LIMIT = 3;
