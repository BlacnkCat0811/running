import type { DatabaseSync } from "node:sqlite";

/**
 * v41：负荷／分区／日级三个计算域的**带版本 checkpoint**（O09 / WP-32，2026-10-16）。
 *
 * ## 为什么需要它
 *
 * `replayTrainingMetrics` / `buildAndPersistZoneProfiles` / `persistDailyTrainingMetrics`
 * 至今每次分析都从**第一个 feature**／**最早日期**重算到 `evaluatedAt`。原因不是懒：
 * 这三个域都是有**滚动状态**的（指数平滑、90 天距离参考队列、分区带的"前一日继承"链），
 * 而状态在库里没有任何落脚点 —— 唯一的 checkpoint 是 `model_checkpoints`（v13），
 * 它存的是 **能力重放**的状态，只有 `resumeModelReplay` 读它。
 *
 * 没有状态落脚点，就只剩两条路：全量重算（现状），或"凭默认零值续算"（错）。
 * 第二条正是本表要防的缺陷形态：把 EWMA 从 0 续、把分区链从 `null` 续，
 * 会让近期小变更产出的日指标与离线从头计算**不一致**，而且不一致发生在**历史前缀**里，
 * 从行数、覆盖、发布 gate 上都看不出来。
 *
 * ## 语义（判据在 `recompute-pipeline.ts`，本表只是证据）
 *
 * - 一条 metric run 至多一条 checkpoint（`training_metric_run_id` 唯一）。
 * - `state_json` 是**滚动状态**（分区链尾、90 天距离队列、急性／慢性 EWMA 与累计计数），
 *   `state_hash` = `configHash(state)`。哈希对不上、状态缺项、版本/配置/时区/override/
 *   输入绑定任一不符 ⇒ **不复用**（不是"当作零值继续"）。默认零是"没有历史"，
 *   而"没有历史"必须表现为重算。
 * - `prefix_*` 记录这次**实际复用**的前缀区间；`through_*` 记录这条 run 算到的位置，
 *   于是一条 run 的 checkpoint 既可以作为下一次的复用来源，也可以回答
 *   "它到底复用到了哪天"。
 * - 追加式、无破坏性：不修改任何历史迁移与其冻结 checksum；本迁移自身的冻结值在同一次
 *   提交里追加。
 *
 * ## 索引决策
 *
 * 查表路径只有一条：`active_model_run` → `model_runs` → `training_metric_runs`
 * （按主键）→ 本表（按 `training_metric_run_id`）。唯一索引即该路径的索引，
 * 因此**不**额外建 `through_local_date` 索引 —— 本表是"每条 run 一行"（百行级），
 * 加索引只增加写入放大。
 */
export function migrateModelV41(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS training_metric_checkpoints (
      id TEXT PRIMARY KEY,
      training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
      checkpoint_version TEXT NOT NULL,
      load_algorithm_version TEXT NOT NULL,
      zone_algorithm_version TEXT NOT NULL,
      daily_algorithm_version TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      zone_settings_digest TEXT NOT NULL,
      override_digest TEXT NOT NULL,
      input_binding_digest TEXT NOT NULL,
      timezone_identifier TEXT NOT NULL,
      through_local_date TEXT NOT NULL,
      through_at TEXT NOT NULL,
      prefix_from_local_date TEXT,
      prefix_through_local_date TEXT,
      state_json TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      counters_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_training_metric_checkpoints_run
      ON training_metric_checkpoints(training_metric_run_id);
  `);
}
