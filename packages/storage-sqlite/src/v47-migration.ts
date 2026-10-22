import type { DatabaseSync } from "node:sqlite";

/**
 * v47：`ability_assessments(training_session_id, model_run_id)` 覆盖索引。
 *
 * ## 证据（阶段 2，2026-10-21，隔离合成库 D2：518,000 health_records / 1,000 workouts）
 *
 * `/v1/workouts` 的 `currentFacts` / `publishedAnalysis` 附加块在同一读事务里对每一行执行
 * `EXISTS (SELECT 1 FROM active_ability_assessments presence WHERE presence.training_session_id = ...)`。
 * `ability_assessments` 现有的唯一索引是 `(model_run_id, sequence_number)` 和
 * `(model_run_id, training_session_id)`；两个索引都以 `model_run_id` 打头，只按
 * `training_session_id` 查找时无法 seek，计划退化成**每个 session 扫一遍评估表**：
 *
 * | 查询 | 改造前 p50 | 改造后 p50 |
 * |---|---|---:|---:|
 * | `readFactsBlock` 的 100 行事实块 | 39.2 ms | 2.6 ms |
 * | `countPendingAnalysis`（1,000 个 session） | 36.9 ms | 1.1 ms |
 * | `workoutsWithViews`（完整 `/v1/workouts` 组装） | 94.95 ms | 21.29 ms |
 * | 同上，D3（2,018,000 条记录 / 5,000 训练） | 2,103.95 ms | 130.38 ms |
 *
 * 这是 5 轮配对（D2 完整端点每轮 50 次，合计 250 样本；D3 每轮 20 次，合计 60 样本）
 * 的同条件测量；索引只改变访问路径，不改变任何 SQL 文本、排序或过滤语义
 * （差分测试逐字节相等）。
 *
 * ## 为什么列序是 `(training_session_id, model_run_id)`
 *
 * - 第一列是唯一被等值过滤的列，必须能 seek；
 * - 第二列让 `active_ability_assessments` 的 `JOIN active_model_run ON model_run_id = ...`
 *   在索引内完成，避免回表（实测比单列索引再快约 10–15%）；
 * - 每个 active release 每个 session 只有一行评估；索引条目量与评估表同阶，
 *   D2 实测索引约 0.1 MiB、总库 +0.04%；500 行 assessment 的 100 轮配对 P95：
 *   WAL 归零辅助组完整事务/持锁/COMMIT +3.61/+3.61/+0.62 ms；autocheckpoint=1000
 *   的空 WAL 组 +0.41/+0.41/+0.63 ms，临近阈值组（971→1046/1058 页）通过；
 *   三组均低于 max(10%,5 ms)。
 *
 * ## 迁移纪律
 *
 * 历史迁移正文与冻结校验和一律不得修改；本迁移的冻结值在同一次提交里追加到
 * `FROZEN_MIGRATION_CHECKSUMS`（`test/migration-policy.test.ts` 会强制这一点）。
 * 使用 `IF NOT EXISTS`，既有库补跑幂等；不在请求/worker 首包路径建索引。
 */
export function migrateModelV47(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_ability_assessments_session
      ON ability_assessments(training_session_id, model_run_id);
  `);
}
