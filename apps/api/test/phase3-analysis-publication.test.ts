// 阶段 3 / P3-07：分析发布闭环里**候选已生成、发布前中断 / 发布后丢回复**的持久证据。
//
// 只补真实缺口：`packages/storage-sqlite/test/model-release-v2.test.ts` 已覆盖
//   · 发布事务失败（active_model_run 的 UPDATE 触发器抛错）⇒ 旧指针稳定、bundle 未激活；
//   · failed / unsealed / stale / changed snapshot 的候选被拒。
// 本文件补的是它没有覆盖的两点（F10）：
//   1. 候选 run 已经生成、封存、评估通过，但**发布事务从未发生**（进程在发布前消失）：
//      旧 active 指针必须稳定，候选不得出现在任何"可见 release"投影里；
//   2. 发布已经提交、但调用方**没收到回复**后重试同一发布：指针仍是同一个、bundle 只有一份、
//      `activated_at` 不被第二次调用改写（不产生重复可见 release）。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ModelLineageV2 } from "@rai/contracts";
import {
  REQUIRED_MODEL_DOMAINS, RaiDatabase, SqliteModelReleaseRepository, SqliteModelRunRepository,
  semanticHash
} from "@rai/storage-sqlite";

const at = "2026-09-29T00:00:00Z";

test("F10 候选已生成但发布前中断：旧发布稳定、候选不可见；补发同一发布幂等且无重复 release", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-phase3-publication-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    const db = store.database;
    db.prepare("INSERT INTO import_manifest VALUES('dataset_version','dataset')").run();
    const releases = new SqliteModelReleaseRepository(db);
    const models = new SqliteModelRunRepository(db);

    /** 造一条**完整封存、评估通过**的候选（与真实分析完成时的行形状一致）。 */
    const seedCandidate = (id: string, base: string | null): void => {
      db.prepare(`INSERT INTO feature_runs (
        id, dataset_version, canonical_contract_version, feature_schema_version,
        feature_config_json, feature_config_hash, status
      ) VALUES (?,'dataset','canonical-health-v2','workout-feature-v4','{}',?,'succeeded')`)
        .run(`f${id}`, `hash-${id}`);
      db.prepare(`INSERT INTO model_runs (
        id, feature_run_id, dataset_version, model_version, model_config_json, model_config_hash,
        evaluated_at, status
      ) VALUES (?,?,'dataset','v2','{}','hash',?,'succeeded')`).run(id, `f${id}`, at);
      db.prepare(`INSERT INTO training_metric_runs (
        id, model_run_id, algorithm_version, config_json, config_hash,
        timezone_identifier, evaluated_at, status
      ) VALUES (?,?,'v5','{}','hash','Asia/Shanghai',?,'succeeded')`).run(`t${id}`, id, at);
      const lineage: ModelLineageV2 = {
        sourceRunId: id, datasetVersion: "dataset",
        factsSnapshotHash: semanticHash({}), overrideSnapshotHash: semanticHash([]),
        modelVersion: "rai-v2.0.0", featureSchemaVersion: "workout-feature-v4",
        configVersion: "v11", configHash: "hash", calibrationCohortHash: null,
        baselineEpochId: null, normalizationVersion: null, normalizationConfigHash: null,
        timezoneIdentifier: "Asia/Shanghai", asOf: at, dataThroughAt: null
      };
      releases.recordLineage(id, "rai-v2.0.0", "v11", lineage);
      for (const domain of REQUIRED_MODEL_DOMAINS) releases.putSnapshot(id, domain, "summary", at, { lineage });
      releases.recordEvaluation({
        runId: id, baseRunId: base, datasetVersion: "dataset", status: "passed",
        report: { status: "passed" }, createdAt: at
      });
    };

    seedCandidate("release-a", null);
    models.activateSucceeded("release-a", at);
    seedCandidate("candidate-b", "release-a");

    const activeRun = (): string | null => String(
      (db.prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton=1").get() as
        { id: string } | undefined)?.id ?? "");
    const activeRelease = (): string | null => String(
      (db.prepare("SELECT model_run_id AS id FROM active_model_release WHERE singleton=1").get() as
        { id: string } | undefined)?.id ?? "");
    const bundle = (id: string): { status: string; activatedAt: string | null; base: string | null } =>
      db.prepare(`SELECT status, activated_at AS activatedAt, base_model_run_id AS base
        FROM model_release_bundles WHERE model_run_id=?`).get(id) as
        { status: string; activatedAt: string | null; base: string | null };

    // ① 候选已生成（model_runs 行 succeeded、bundle passed），但发布事务没有发生。
    assert.equal(
      String((db.prepare("SELECT status FROM model_runs WHERE id='candidate-b'").get() as { status: string }).status),
      "succeeded", "候选 run 必须已经算完（否则这条用例只是「没算」）");
    assert.equal(bundle("candidate-b").status, "passed", "候选 bundle 必须已封存");
    assert.equal(bundle("candidate-b").activatedAt, null, "候选从未激活");
    assert.equal(releases.isPublished("candidate-b"), false);
    assert.equal(activeRun(), "release-a", "旧 active 指针必须稳定");
    assert.equal(activeRelease(), "release-a", "旧可见 release 必须稳定");
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM model_release_bundles WHERE activated_at IS NOT NULL")
      .get() as { n: number }).n), 1, "此刻只有旧 release 是可见的");

    // ② 发布事务提交后回复丢失：重试同一个发布。
    models.activateSucceeded("candidate-b", "2026-09-29T00:01:00Z");
    const firstActivatedAt = bundle("candidate-b").activatedAt;
    assert.equal(activeRun(), "candidate-b");
    assert.equal(activeRelease(), "candidate-b");
    assert.equal(firstActivatedAt, "2026-09-29T00:01:00Z");
    assert.equal(releases.isPublished("candidate-b"), true);

    // 重试（模拟丢失回复后的客户端/运维重放）：不得产生第二份可见 release。
    models.activateSucceeded("candidate-b", "2026-09-29T00:02:00Z");
    assert.equal(activeRun(), "candidate-b", "重放必须仍指向同一个 release");
    assert.equal(activeRelease(), "candidate-b");
    assert.equal(bundle("candidate-b").activatedAt, firstActivatedAt,
      "第二次发布不得改写首次激活时间（activated_at 是审计证据）");
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM active_model_run").get() as { n: number }).n), 1,
      "active_model_run 只能是单行指针");
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM active_model_release").get() as { n: number }).n), 1,
      "active_model_release 只能是单行指针");
    assert.equal(Number((db.prepare(
      "SELECT COUNT(*) AS n FROM model_release_bundles WHERE model_run_id='candidate-b'").get() as { n: number }).n), 1,
      "重复发布不得复制 bundle（可见 release 只能一份）");
    // 旧 release 仍是可回滚的完整发布（指针之外的历史证据不得被重放破坏）。
    assert.equal(releases.isPublished("release-a"), true, "旧 release 必须仍保持完整、可回滚");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
