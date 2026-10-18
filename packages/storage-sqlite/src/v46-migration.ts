import type { DatabaseSync } from "node:sqlite";

/**
 * v46：记录级 `available_at`（**到达服务端的时刻**，P2-2，2026-10-18 同步诊断）。
 *
 * ## 为什么需要它
 *
 * `docs/DATA_PIPELINE.md` §3 把三种时间分开：事件时间（observed）、**可得时间**
 * （available/ingested/computed）、计算截止（evaluated/asOf）。本库此前**没有**记录级的
 * 可得时间列：`health_records.start_at` 是事件时间，`import_fact_history.available_at` 只覆盖
 * v34 稀疏历史里被改写过的版本，既有事实行没有它。于是「这条样本什么时候才可获得」
 * 无法回答，as-known-then 只能靠上界近似。
 *
 * ## 语义（写侧的唯一来源是解析器）
 *
 * - 值 = 本批**解析开始时**（或调用方显式传入的）ISO 时刻，即"服务端此刻第一次/再次
 *   拿到这条事实内容"；
 * - **更新行刷新**：内容变更的再次到达会把该行的 `available_at` 改成这次到达的时刻
 *   （"这一版内容从此刻起可得"）；内容未变的重复到达走解析器轻路径，**不重写**该行，
 *   所以首次可得时刻不被重复上传污染；
 * - **可空且不回填**：v46 之前的行没有可信的到达记录，保持 `NULL` —— 用 `start_at`
 *   或 `created_at` 回填会把"事件发生"冒充成"系统可得"，正是 §3 禁止的互换。
 *   读取方必须把 `NULL` 读成 `availabilityUnknown`（保守上界），不得读成"事件时刻"。
 *
 * ## 迁移纪律
 *
 * 历史迁移正文与冻结校验和一律不得修改；本迁移的冻结值在同一次提交里追加到
 * `FROZEN_MIGRATION_CHECKSUMS`（`test/migration-policy.test.ts` 的
 * "every migration has a frozen checksum" 会强制这一点）。
 *
 * `available_at` 不建索引：目前没有按可得时间的查询路径，等真的有了再按查询形状加
 * （与 v40 的 `idx_health_records_type_end` 同理——索引跟着查询走，不预建）。
 */
export function migrateModelV46(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE health_records ADD COLUMN available_at TEXT;
  `);
}
