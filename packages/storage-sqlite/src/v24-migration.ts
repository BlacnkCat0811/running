import type { DatabaseSync } from "node:sqlite";

/** 与 `database.ts` 里的 `nowSql` 保持同一表达式，避免两处默认值分叉。 */
const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * v24 —— 一次补齐四个互相独立、但都属于"缺一列/缺一张表"的缺口
 * （现行谱系与发布合同见 `docs/ALGORITHM.md` §3 / §14）。
 *
 * 1. `model_runs.engine_version`：引擎版本此前**只活在 configHash 的输入里**，没有独立列，
 *    于是"哪个引擎产出过这个 run"只能看 `model_version`，而那一列的语义是**配置**版本。
 *    历史行一律留 `NULL` —— 读端必须显示 `unknown`，**不得**用当前 `MODEL_CONFIG_VERSION` 兜底，
 *    否则正是 §14.4 要消灭的那种混淆。
 *
 * 2. `model_validation_gates.status` 的 CHECK 扩到含 `not_evaluable`：三态是 transition gate v2 的
 *    **正式结论**，此前装不下它，只能退化成 `'skipped'`，而 `'skipped'` 会被读成"没有 base run"。
 *    SQLite 改不了 CHECK ⇒ 只能重建表（本仓 v7 / v15 已有同样手法的成例）。
 *
 * 3. `model_release_refusals`：发布被拒此前**只体现在一次 409 响应里**，库里查不到
 *    "当时为什么被拒"。§15.8 要求每个 gate 的结论可查，而 HTTP 响应不是持久证据。
 *    只增不删：审计线索不设清理。
 *
 * 4. `daily_ability_snapshots.baseline_epoch_id`：要按 epoch 分段画长期曲线，而 epoch 目前
 *    只在每个 run 的 lineage 里，**逐日快照没有落地** ⇒ 读端无法知道某一天属于哪个标尺。
 *
 * 三项都是 additive（两列可空、一表新增），唯一的破坏性动作是第 2 项的表重建，
 * 而它**逐列拷贝全部既有行**，索引与 UNIQUE 约束一并重建。
 */
export function migrateModelV24(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE model_runs ADD COLUMN engine_version TEXT;
    ALTER TABLE daily_ability_snapshots ADD COLUMN baseline_epoch_id TEXT;

    ALTER TABLE model_validation_gates RENAME TO model_validation_gates_v23;
    CREATE TABLE model_validation_gates (
      id TEXT PRIMARY KEY,
      candidate_model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
      base_model_run_id TEXT REFERENCES model_runs(id) ON DELETE SET NULL,
      gate_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'not_evaluable', 'skipped')),
      metrics_json TEXT NOT NULL,
      thresholds_json TEXT NOT NULL,
      failure_reasons_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      UNIQUE(candidate_model_run_id, gate_version)
    );
    INSERT INTO model_validation_gates (
      id, candidate_model_run_id, base_model_run_id, gate_version, status,
      metrics_json, thresholds_json, failure_reasons_json, created_at
    )
    SELECT
      id, candidate_model_run_id, base_model_run_id, gate_version, status,
      metrics_json, thresholds_json, failure_reasons_json, created_at
    FROM model_validation_gates_v23;
    DROP TABLE model_validation_gates_v23;
    CREATE INDEX idx_model_validation_gates_candidate
      ON model_validation_gates(candidate_model_run_id, created_at DESC);
    CREATE INDEX idx_model_validation_gates_base
      ON model_validation_gates(base_model_run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS model_release_refusals (
      id TEXT PRIMARY KEY,
      model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
      -- 只登记**已接线**的阶段。预测侧的两个拒绝阶段（activation_compatibility /
      -- artifact_boundary）还没接，等接的时候再加法扩宽 CHECK，不留"允许但永不写入"的值。
      stage TEXT NOT NULL CHECK (stage IN ('release_gate')),
      reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json)),
      detail TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT (${nowSql})
    );
    CREATE INDEX IF NOT EXISTS idx_model_release_refusals_run
      ON model_release_refusals(model_run_id, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_model_release_refusals_stage
      ON model_release_refusals(stage, detected_at DESC);
  `);
}
