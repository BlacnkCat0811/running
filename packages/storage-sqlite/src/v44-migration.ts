import type { DatabaseSync } from "node:sqlite";

/**
 * v44：**覆盖证据**的两个持久化补充（2026-10-16，对应 R02 与 R05 的发布核验）。
 *
 * ## `analysis_run_input_bindings.executed_plan_json`（R02）
 *
 * "合并任务的调度成员"不等于"这次执行**实际覆盖**的范围" —— 未入选的批次（时间窗、
 * 成员上限、不同合并键之外）同样可能影响当前输入，而它们的 dirty 只有在**执行计划**
 * 里才有证据。本列在发布事务里落下执行计划的逐域边界（`{dirtyFromAt, domains}`，
 * `null` = 全量重算），结算方据此验证：
 *
 *   - 成员登记的 dirty 边界确实被**执行范围**覆盖（而不是被"调度成员清单"口头覆盖）；
 *   - 发布写下的覆盖批次清单（`analysis_job_coverage`）与执行计划同源。
 *
 * ⚠️ 可空：v44 之前写下的绑定行没有这份证据。核验方对缺列行保持**旧判据**
 * （只对"调度并集"做包含性检查），不得把"缺证据"读成"证据成立"。
 *
 * ## `training_metric_checkpoints.prefix_compat_digest`（R05）
 *
 * checkpoint 的复用判据曾把"输入绑定摘要"逐字比对，而那个摘要**含 raw／dependency 代次**
 * —— 每批导入都会推进代次，"连续两次真实增量"因此永远匹配不上，安全前缀复用被恒定拒绝
 * （原因码 `input_binding`，一条心率更正重算 7 次训练、46 天分区）。
 *
 * 本列存的是**前缀兼容摘要**：只包含算法／checkpoint 版本、配置、时区与控制修订，
 * **不含代次**。它回答"父 checkpoint 与本次运行能不能拼前缀"，而"父发布到当前之间
 * 有没有未处理影响"由覆盖计划（上面的 executed 证据 + 可信基线）独立回答 —— 两件事
 * 各自有各自的证据，不再混进同一个摘要。
 *
 * ⚠️ 可空：旧 checkpoint 没有这份证明 ⇒ 复用判据**拒绝**（"缺少必要证明时拒绝复用"），
 * 绝不按默认值续算。
 *
 * 历史迁移与其冻结校验和一律不得修改；本迁移的冻结值在同一次提交里追加。
 */
export function migrateModelV44(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE analysis_run_input_bindings ADD COLUMN executed_plan_json TEXT;
    ALTER TABLE training_metric_checkpoints ADD COLUMN prefix_compat_digest TEXT;
  `);
}
