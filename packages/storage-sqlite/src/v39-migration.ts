import type { DatabaseSync } from "node:sqlite";

/**
 * v39：分析**输入绑定**与**覆盖证明**（O06-A / WP-22，2026-10-16）。
 *
 * ## 为什么需要这些表
 *
 * 直连车道在接收事务里就登记了目标代次（`recompute_jobs.target_raw_generation` /
 * `target_dependency_generation`，v35），但**消费端从来没有读过它们** ——
 * `runDirectSyncAnalysis` 只是 `runFullRecompute` 的别名，事实一律从可变的当前表里读。
 * 于是"这条发布到底算了哪一版事实"没有任何持久证据：`verifyAndPoint` 只能拿
 * `import_manifest.dataset_version` 逐字相等来兜底，任何中介批次都会让候选被拒。
 *
 * 本迁移把三件事变成**可核验的事实**：
 *
 * 1. `analysis_run_input_bindings`：每个候选 run 实际捕获的输入绑定
 *    （实际 raw/dependency 代次、目标代次、incumbent、dataset 版本、时区、
 *    override/配置摘要、截止时间、输入摘要）。它记录**计算证据**，不复制健康事实。
 * 2. `analysis_job_coverage`：这条任务覆盖了哪些导入批次、覆盖的代次区间。
 *    发布判据靠它证明"我之后进来的批次没有动过分析输入"。
 * 3. `import_batches.{raw_generation, dependency_generation, dependency_bumped}`：
 *    每个批次**自己**声明它把两个计数器推到了哪里、以及它有没有推依赖代次。
 *    没有这三列，"raw-only 批次"只能靠推理猜，不能靠证据判。
 *
 * ## 口径
 *
 * - 追加式：`import_batches` 的三列可空，v39 之前的历史行是 NULL = **未知**，
 *   不是"没推过代次"。判据在 NULL 上必须保守（当作"可能动过分析"），不得当成 0。
 * - 不新增 `recompute_jobs.status` 枚举值、不动任何 CHECK。
 * - `analysis_job_coverage.job_id` 外键指向 `recompute_jobs(id)`：覆盖记录是任务的证据，
 *   任务没了它就没有意义。
 * - 历史迁移与其冻结校验和一律不得修改；本迁移的冻结值在同一次提交里追加。
 *
 * ## 索引决策（`EXPLAIN QUERY PLAN` 实测，2026-10-16）
 *
 * 两张表都按 `job_id` / `run_id` 点查或按 run 反查，主键已覆盖 `run_id`；
 * `analysis_job_coverage` 的主键是 `(job_id, import_batch_id)`，按 job 取全部覆盖行是前缀扫描，
 * 不需额外索引。发布路径上的"中介批次是否有依赖增量"按 `import_batches(raw_generation)`
 * 范围扫描 —— 该表是**百行级**（每批一行，非每记录一行），全扫即最优，
 * 加索引只会增加写入放大。故本迁移不建新索引。
 */
export function migrateModelV39(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE import_batches ADD COLUMN raw_generation INTEGER;
    ALTER TABLE import_batches ADD COLUMN dependency_generation INTEGER;
    ALTER TABLE import_batches ADD COLUMN dependency_bumped INTEGER;

    CREATE TABLE IF NOT EXISTS analysis_run_input_bindings (
      run_id TEXT PRIMARY KEY REFERENCES model_runs(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      dataset_version TEXT NOT NULL,
      captured_raw_generation INTEGER NOT NULL,
      captured_dependency_generation INTEGER NOT NULL,
      target_raw_generation INTEGER,
      target_dependency_generation INTEGER,
      incumbent_release_id TEXT,
      timezone_identifier TEXT NOT NULL,
      override_digest TEXT NOT NULL,
      config_digest TEXT NOT NULL,
      cutoff_at TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS analysis_job_coverage (
      job_id TEXT NOT NULL REFERENCES recompute_jobs(id) ON DELETE CASCADE,
      import_batch_id TEXT NOT NULL,
      dependency_generation_from INTEGER NOT NULL,
      dependency_generation_to INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (job_id, import_batch_id)
    );
  `);
}
