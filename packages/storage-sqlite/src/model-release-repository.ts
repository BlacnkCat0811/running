import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalSemanticJson,
  dependencyCoverageHolds,
  selectInterveningBatches,
  type BatchGenerationFacts,
  type ModelLineageV2
} from "@rai/contracts";

export const semanticHash = (value: unknown): string =>
  createHash("sha256").update(canonicalSemanticJson(value)).digest("hex");
export const REQUIRED_MODEL_DOMAINS = ["fitness", "readiness", "durability", "load", "zones"] as const;

export class SqliteModelReleaseRepository {
  constructor(private readonly db: DatabaseSync) {}

  recordLineage(runId: string, engineVersion: string, configVersion: string, lineage: ModelLineageV2): void {
    if (lineage.sourceRunId !== runId || !engineVersion || !configVersion) throw new Error("Invalid run lineage");
    this.db.prepare(`INSERT INTO model_v2_runs VALUES (?,?,?,?,?)`)
      .run(runId, engineVersion, configVersion, canonicalSemanticJson(lineage), semanticHash(lineage));
  }

  putSnapshot(runId: string, domain: string, key: string, asOf: string, payload: unknown): void {
    if (!domain || !key || !Number.isFinite(Date.parse(asOf))) throw new Error("Invalid snapshot identity");
    const json = canonicalSemanticJson(payload);
    const hash = semanticHash(payload);
    const previous = this.db.prepare(`SELECT payload_hash AS hash FROM model_domain_snapshots
      WHERE model_run_id=? AND domain=? AND snapshot_key=?`).get(runId, domain, key) as { hash: string } | undefined;
    if (previous) {
      if (previous.hash !== hash) throw new Error("Cannot overwrite an immutable domain snapshot");
      return;
    }
    this.db.prepare("INSERT INTO model_domain_snapshots VALUES (?,?,?,?,?,?)").run(runId, domain, key, asOf, json, hash);
  }

  snapshots(runId: string): Array<{ domain: string; key: string; asOf: string; payload: unknown }> {
    return (this.db.prepare(`SELECT domain,snapshot_key AS key,as_of AS asOf,payload_json AS json,payload_hash AS hash
      FROM model_domain_snapshots WHERE model_run_id=? ORDER BY domain,snapshot_key`).all(runId) as
      Array<{ domain: string; key: string; asOf: string; json: string; hash: string }>).map((row) => {
      const payload: unknown = JSON.parse(row.json);
      if (semanticHash(payload) !== row.hash) throw new Error("Snapshot digest mismatch");
      return { domain: row.domain, key: row.key, asOf: row.asOf, payload };
    });
  }

  recordEvaluation(input: {
    runId: string; baseRunId: string | null; datasetVersion: string;
    status: "passed" | "failed" | "not_evaluable"; report: unknown; createdAt: string;
  }): void {
    const rows = this.snapshots(input.runId);
    if (input.status === "passed" && REQUIRED_MODEL_DOMAINS.some((domain) => !rows.some((row) => row.domain === domain))) {
      throw new Error("Cannot seal a release with missing domains");
    }
    this.db.prepare(`INSERT INTO model_release_bundles
      (model_run_id,base_model_run_id,dataset_version,snapshot_hash,evaluation_json,status,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(input.runId, input.baseRunId, input.datasetVersion,
        semanticHash(rows), canonicalSemanticJson(input.report), input.status, input.createdAt);
  }

  /**
   * True when this run's bundle has already been published at least once, i.e. the
   * target is an auditor-visible release rather than an unevaluated candidate.
   *
   * This is what separates "publish the candidate's successor" from "switch back to a
   * previously published release": only the former must satisfy the incumbent check in
   * `verifyAndPoint`, because for the latter the incumbent is *expected* to differ.
   */
  isPublished(runId: string): boolean {
    const row = this.db.prepare("SELECT activated_at AS at FROM model_release_bundles WHERE model_run_id=?")
      .get(runId) as { at: string | null } | undefined;
    return row != null && row.at !== null;
  }

  /** Called in the same transaction as active_model_run and job completion. */
  verifyAndPoint(runId: string, at: string, rollback = false): void {
    const bundle = this.db.prepare(`SELECT * FROM model_release_bundles WHERE model_run_id=?`)
      .get(runId) as Record<string, unknown> | undefined;
    if (!bundle || bundle.status !== "passed") throw new Error("V2 release is absent or has not passed its gate");
    const lineage = this.db.prepare(`SELECT lineage_json AS json,lineage_hash AS hash
      FROM model_v2_runs WHERE model_run_id=?`).get(runId) as { json: string; hash: string } | undefined;
    if (!lineage || semanticHash(JSON.parse(lineage.json)) !== lineage.hash) throw new Error("V2 lineage digest mismatch");
    const captured = JSON.parse(lineage.json) as ModelLineageV2;
    const currentOverrideIds = this.db.prepare(`SELECT id FROM effective_workout_overrides
      ORDER BY training_session_id`).all().map((row) => String(row.id));
    if (captured.overrideSnapshotHash !== semanticHash(currentOverrideIds)) {
      throw new Error("Workout overrides changed since candidate evaluation; recompute before activation");
    }
    if (semanticHash(this.snapshots(runId)) !== bundle.snapshot_hash) throw new Error("V2 release snapshot digest mismatch");
    const currentDataset = this.db.prepare("SELECT value FROM import_manifest WHERE key='dataset_version'").get()?.value ?? "dataset_unknown";
    if (bundle.dataset_version !== currentDataset) {
      // 🔴 O06-A / 决策 D4（2026-10-16）：dataset 版本不等**不再一律拒绝** ——
      // 允许"已证明不影响分析"的 raw-only 批次通过。但放宽的是判据的**形式**：
      // {@link dependencyAdmissionHolds} 要求候选之后进来的**每一个**批次都自己声明了
      // 没有推进依赖代次；只要有一个说不清（v39 之前的历史行是 NULL）就是拒绝。
      // 没有绑定行的老候选走 legacy 严格分支（与今天逐字节相同）。
      if (!this.dependencyAdmissionHolds(runId)) {
        throw new Error("Dataset changed since candidate evaluation");
      }
    }
    const current = this.db.prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton=1").get()?.id ?? null;
    if (current !== runId && !rollback && current !== bundle.base_model_run_id) throw new Error("Incumbent changed since evaluation");
    if (rollback && bundle.activated_at === null) throw new Error("Rollback requires a previously published bundle");
    this.db.prepare(`INSERT INTO active_model_release VALUES (1,?)
      ON CONFLICT(singleton) DO UPDATE SET model_run_id=excluded.model_run_id`).run(runId);
    this.db.prepare(`UPDATE model_release_bundles SET activated_at=COALESCE(activated_at,?) WHERE model_run_id=?`).run(at, runId);
  }

  /**
   * 依赖级发布判据（O06-A / 决策 D4）：候选之后进来的批次**有没有动过分析输入**。
   *
   * 判据本体住在 `@rai/contracts` 的 `dependencyCoverageHolds` —— 与计算端**同一份实现**。
   * 两处各写一遍时，漂移方向恰好是"发布判据比计算判据松"，而那正是"旧计算当最新展示"的入口。
   *
   * 没有绑定行（v39 之前的候选，以及非直连的 `full_recompute`）⇒ `false` ⇒ 走与今天
   * 逐字节相同的严格分支。**这就是"不能全局删掉 dataset 校验"的落实方式**。
   */
  private dependencyAdmissionHolds(runId: string): boolean {
    const binding = this.db.prepare(`
      SELECT captured_raw_generation AS capturedRaw,
             captured_dependency_generation AS capturedDependency
      FROM analysis_run_input_bindings WHERE run_id = ?
    `).get(runId) as { capturedRaw: number; capturedDependency: number } | undefined;
    if (binding === undefined) return false;
    const generations = this.db.prepare(
      "SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton = 1"
    ).get() as { raw: number; dependency: number } | undefined;
    if (generations === undefined) return false;
    const capturedRaw = Number(binding.capturedRaw);
    const batches = this.db.prepare(`
      SELECT id AS batchId, raw_generation AS rawGeneration,
             dependency_generation AS dependencyGeneration, dependency_bumped AS dependencyBumped
      FROM import_batches WHERE status = 'succeeded'
    `).all() as unknown as BatchGenerationFacts[];
    return dependencyCoverageHolds({
      capturedRawGeneration: capturedRaw,
      capturedDependencyGeneration: Number(binding.capturedDependency),
      currentRawGeneration: Number(generations.raw),
      currentDependencyGeneration: Number(generations.dependency),
      interveningBatches: selectInterveningBatches(batches, capturedRaw)
    }).holds;
  }

  /** Release receipts pin rollback dependencies; retire older receipts before normal run pruning. */
  retireOldReleases(keepHistorical=2): void {    if (!Number.isInteger(keepHistorical)||keepHistorical<1) throw new Error("Keep at least one rollback release");
    const active=this.db.prepare("SELECT model_run_id AS id FROM active_model_release WHERE singleton=1").get()?.id;
    if(typeof active!=="string")return;
    const rows=this.db.prepare("SELECT model_run_id AS id FROM model_release_bundles WHERE model_run_id<>? ORDER BY activated_at DESC,created_at DESC,rowid DESC").all(active) as Array<{id:string}>;
    const retained = new Set([active, ...rows.slice(0, keepHistorical).map((row) => row.id)]);
    // Epoch creation receipts are dependencies, not ordinary rollback history.
    // Pin the original effectiveAt for each current/retained rollback epoch.
    // Normal run pruning already retains every surviving release receipt.
    for (const id of [...retained]) {
      const origin = this.db.prepare(`SELECT origin.model_run_id AS id
        FROM model_v2_runs lineage JOIN model_release_bundles dependent
          ON dependent.model_run_id=lineage.model_run_id
        JOIN model_release_bundles origin
          ON origin.dataset_version=dependent.dataset_version
          AND json_extract(origin.evaluation_json,'$.rebase.candidateEpoch')=
              json_extract(lineage.lineage_json,'$.baselineEpochId')
        WHERE lineage.model_run_id=? AND origin.status='passed' AND origin.activated_at IS NOT NULL
          AND json_extract(origin.evaluation_json,'$.rebase.effectiveAt') IS NOT NULL
        ORDER BY origin.created_at ASC,origin.model_run_id ASC LIMIT 1`).get(id)?.id;
      if (typeof origin === "string") retained.add(origin);
    }
    for(const row of rows)if(!retained.has(row.id))this.db.prepare("DELETE FROM model_release_bundles WHERE model_run_id=?").run(row.id);
  }

  /** Explicit rollback tool; no data rewrites and no stale-data rollback. */
  rollback(runId: string, expectedActiveRunId: string, at: string): void {
    this.db.exec("SAVEPOINT rai_v2_rollback");
    try {
      const active = this.db.prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton=1").get()?.id;
      if (active !== expectedActiveRunId) throw new Error("Rollback incumbent changed");
      const model = this.db.prepare(`SELECT status FROM model_runs WHERE id=?`).get(runId);
      if (model?.status !== "succeeded") throw new Error("Rollback run is unavailable");
      this.verifyAndPoint(runId, at, true);
      this.db.prepare("UPDATE active_model_run SET model_run_id=?,activated_at=? WHERE singleton=1").run(runId, at);
      this.db.exec("DELETE FROM active_prediction_model");
      this.db.exec("RELEASE rai_v2_rollback");
    } catch (error) {
      this.db.exec("ROLLBACK TO rai_v2_rollback; RELEASE rai_v2_rollback");
      throw error;
    }
  }
}
