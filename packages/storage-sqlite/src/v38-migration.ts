import type { DatabaseSync } from "node:sqlite";

/**
 * v38：可重试调度失败的尝试计数（O07 / 决策 D1，2026-10-16）。
 *
 * ## 为什么需要一列
 *
 * 写租约等待超时的语义从"失败开放"改成"可重试调度失败"（`apps/api/src/write-lease.ts`
 * 的 `WriteLeaseTimeoutError`）：任务回到 `queued` 而不是终态 `failed`。**重试必须有界** ——
 * 没有上界时，"许可永远拿不到"会变成任务在队列里无限打转，而用户永远看不到结论。
 * 这个计数就是那个上界（`RETRYABLE_JOB_ATTEMPT_LIMIT`）。
 *
 * ## 口径
 *
 * - 追加式、`NOT NULL DEFAULT 0`：v38 之前的历史行逐列相同（都是 0），语义为"从未重排过"。
 * - **不**动 `job_type` / `status` 的 `CHECK`（v35 文件头明令禁止放宽）。重排复用既有的
 *   `'queued'` 状态与 `progress_phase='retry_pending'`，不新增枚举值 ——
 *   iOS 与 `/v1/jobs` 的取值集合因此一个字节都没变。
 * - `claimNext()` 再次领取时把 `error_json` 清空，所以"重排过一次但这次成功了"的任务
 *   不会带着上一轮的错误展示给用户。
 *
 * ⚠️ 历史迁移与其冻结校验和一律不得修改；本迁移的冻结值在同一次提交里追加。
 */
export function migrateModelV38(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE recompute_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  `);
}
