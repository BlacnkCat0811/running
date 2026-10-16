import type { DatabaseSync } from "node:sqlite";

/**
 * v42：**原任务 → 覆盖任务**的合并关联（O06-B / WP-40，2026-10-16）。
 *
 * ## 为什么需要它
 *
 * 直连车道**每批**登记一条 `import` 分析任务（`direct-sync-ingest.ts`）。十条兼容批次
 * 排队时，它们要的是**同一件事**（"把最新分析算出来"），却会被逐条执行十次 —— 十份
 * 完全相同的计算。O06-B 的合并是"只算一份"，但合并之后有一个必须回答的问题：
 *
 * > 那条**原任务**去哪了？它的 `analysisJobId` 还在客户端手上（回执里写的那个），
 * > 客户端会拿它来问结果。
 *
 * 不回答这个问题就只剩两条错路：删掉原任务行（客户端拿到 404，等于"你提交的那批没了"），
 * 或把它谎报成 `not_required`／直接改写成 `succeeded`（把"还没算"说成"算完了"）。
 * 两条路都在 `docs/IOS_SYNC_PERFORMANCE_REVIEW.md` §10.3 明令禁止。
 *
 * 所以本表是**追加式**的第三种答案：原任务行**逐字节不动**（状态仍是 `queued`），
 * 只在旁边记一行"它被哪条覆盖任务接管了、接管到哪一步"。查询端沿这一行把覆盖任务的
 * 真实进度**沿原 id** 报出来，于是 HTTP 合同不变（**iOS 不需要改**）。
 *
 * ## 口径（逐条都有对应的失败形态）
 *
 * - **不改 `recompute_jobs.status` 的 CHECK**（v35 文件头明令禁止放宽，iOS 消费该枚举）。
 *   本表因此**不引入 `superseded` 状态**：被覆盖任务的真实状态仍然是 `queued`，
 *   "它被接管了"这件事住在 `analysis_job_merges` 里。
 * - **只有覆盖任务真的发布之后**才把被覆盖任务结算成 `succeeded`（`state='published'`）。
 *   失败/取消/重排一律**释放**（`state='released'`）：原任务回到可被领取的状态，
 *   由下一次合并重新规划。**绝不**因为"覆盖任务被创建了"就结算。
 * - `attempts` 是**防饿死计数的持久落脚点**（B6）：一条被覆盖任务被释放几次之后
 *   不再参与合并，必须单独执行 —— 于是它一定会拿到自己的那一份调度，
 *   不会"被无限创建又无限废弃"。上限的判据在 `RecomputeJobRepository`，本列是它的账。
 * - `union_batch_ids_json` / `evidence_json` 不是审计装饰：覆盖任务发布时，
 *   **并集**就是写进 `analysis_job_coverage` 的那一组批次（现有业务 gate 读的表），
 *   而 `evidence_json.selectedEvidenceBatch` 是喂给 `sourceBackfillEvidence` 单数入参的
 *   那一个批次（挑法是"让 gate 的结论与并集一致"，见仓库层注释）。
 * - `binding_*` 五列是**发布事务**里从 `analysis_run_input_bindings` 抄下来的实际绑定
 *   （同一覆盖任务的全部成员共享**一份**绑定）。"同 scope/同配置/同 override 绑定"
 *   因此不是合并时的一句声称，而是可复核的落库事实。
 * - 历史迁移与其冻结校验和一律不得修改；本迁移的冻结值在同一次提交里追加。
 *
 * ## 索引决策
 *
 * 两条查询路径：按 `covered_job_id` 点查（主键即索引，`GET /v1/jobs/:id` 走这条）、
 * 按 `covering_job_id` + `state` 反查（`claimNext` 的排除子句与发布时的结算走这条）。
 * 后者需要一条索引；前者不需要额外索引。本表是"每条被覆盖任务一行"（百行级），
 * 索引只建这一条，不再加别的。
 */
export function migrateModelV42(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS analysis_job_merges (
      covered_job_id TEXT PRIMARY KEY REFERENCES recompute_jobs(id) ON DELETE CASCADE,
      covering_job_id TEXT NOT NULL REFERENCES recompute_jobs(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('pending','published','released')),
      scope TEXT NOT NULL,
      import_batch_id TEXT NOT NULL,
      covered_dirty_from_at TEXT,
      merged_dirty_from_at TEXT,
      covered_target_raw_generation INTEGER NOT NULL,
      covered_target_dependency_generation INTEGER NOT NULL,
      union_batch_ids_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      binding_job_id TEXT,
      binding_input_digest TEXT,
      binding_override_digest TEXT,
      binding_config_digest TEXT,
      binding_timezone_identifier TEXT,
      binding_captured_raw_generation INTEGER,
      binding_captured_dependency_generation INTEGER,
      covering_model_run_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      settled_at TEXT,
      released_at TEXT,
      release_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_job_merges_covering
      ON analysis_job_merges(covering_job_id, state);
  `);
}
