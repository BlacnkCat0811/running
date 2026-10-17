import type { DatabaseSync } from "node:sqlite";

/**
 * v45：**批次级分析影响证据**（B05，2026-10-17 第二轮复查）。
 *
 * ## 为什么需要它
 *
 * 接收端在同一个事务里**已经**算出了本批的脏范围（`planIncrementalAnalysisDirtyRange` +
 * `loadDirtyRangeInput`，其中路线变更以"所属训练的开始时刻"作为合成条目传入）。但那份
 * 结果只进了分析任务的 `incrementalPlan` 与分类原因，**没有留在批次行上**。于是：
 *
 * - 消费端（`SqliteAnalysisInputReader`）在重排/合并/后续批次时只能重新从账本装配计划，
 *   而账本**不记路线** —— 它无法重建"路线-only 更正"的边界；
 * - 只要影响批次里出现 `routes.importedRouteCount > 0`，捕获器就只能保守全量
 *   （`route_evidence_unmerged`）⇒ 一次普通带轨迹的新增跑步也重算整个历史。
 *
 * 本列把那份证据持久化在**批次行**上（与原始事实同事务提交），消费端逐批读取后合并。
 *
 * ## 生命周期与回收
 *
 * - 写入：接收事务内，`analysisRequired` 为真时写；`NULL` = 该批不影响分析 / v45 之前的老批次。
 * - 读取：只读，不作任何回填。
 * - 回收：随 `import_batches` 行一起删除（既有批次裁剪/删除账本已经覆盖），**没有**第二份
 *   生命周期。不做全库回填——老批次宁可走兼容全量，也不伪造"已验证覆盖"。
 *
 * ## 为什么单独一列而不是并入 `summary_json`
 *
 * `summary_json` 是对外回执语义的载体（`analysisJobId`、`routesUpdated` 等），消费者会读它、
 * 报表会引用它；分析计划是**内部证据**，混进去会让"回执变了"与"证据变了"无法区分。
 *
 * ⚠️ 可空：v45 之前的批次没有这份证据 ⇒ 消费端必须走明确的兼容路径（记录原因与成本），
 * 不得把"缺证据"读成"没有路线影响"。
 *
 * 历史迁移与其冻结校验和一律不得修改；本迁移的冻结值在同一次提交里追加。
 */
export function migrateModelV45(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE import_batches ADD COLUMN analysis_dirty_plan_json TEXT;
  `);
}
