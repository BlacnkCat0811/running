// 阶段 4 / T04：模型发布事务的进程级崩溃边界。
//
// `model-release-v2.test.ts` 已覆盖“事务内触发器失败 ⇒ 指针与 bundle 一起回滚”。
// 本文件补的是它没有覆盖的形态：**事务已经做完所有写、但在 COMMIT 之前进程消失**。
// 子进程使用真实的 `RecomputeJobRepository.complete` + `SqliteModelRunRepository.
// activateSucceeded`；父进程只读核对，不修补任何状态。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ModelLineageV2 } from "@rai/contracts";
import {
  REQUIRED_MODEL_DOMAINS, RaiDatabase, SqliteModelReleaseRepository, SqliteModelRunRepository, semanticHash
} from "@rai/storage-sqlite";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CHILD = join(REPO_ROOT, "apps/api/test/phase4-model-release-crash-child.mjs");
const AT = "2026-10-23T06:00:00.000Z";
const JOB_ID = "job-phase4-t04";

function seedCandidate(db: DatabaseSync, id: string, base: string | null): void {
  const releases = new SqliteModelReleaseRepository(db);
  db.prepare(`INSERT INTO feature_runs (
    id, dataset_version, canonical_contract_version, feature_schema_version,
    feature_config_json, feature_config_hash, status
  ) VALUES (?,'dataset','canonical-health-v2','workout-feature-v4','{}',?,'succeeded')`)
    .run(`f${id}`, `hash-${id}`);
  db.prepare(`INSERT INTO model_runs (
    id, feature_run_id, dataset_version, model_version, model_config_json, model_config_hash,
    evaluated_at, status
  ) VALUES (?,?,'dataset','v2','{}','hash',?,'succeeded')`).run(id, `f${id}`, AT);
  db.prepare(`INSERT INTO training_metric_runs (
    id, model_run_id, algorithm_version, config_json, config_hash,
    timezone_identifier, evaluated_at, status
  ) VALUES (?,?,'v5','{}','hash','Asia/Shanghai',?,'succeeded')`).run(`t${id}`, id, AT);
  const lineage: ModelLineageV2 = {
    sourceRunId: id, datasetVersion: "dataset",
    factsSnapshotHash: semanticHash({}), overrideSnapshotHash: semanticHash([]),
    modelVersion: "rai-v2.0.0", featureSchemaVersion: "workout-feature-v4",
    configVersion: "v11", configHash: "hash", calibrationCohortHash: null,
    baselineEpochId: null, normalizationVersion: null, normalizationConfigHash: null,
    timezoneIdentifier: "Asia/Shanghai", asOf: AT, dataThroughAt: null
  };
  releases.recordLineage(id, "rai-v2.0.0", "v11", lineage);
  for (const domain of REQUIRED_MODEL_DOMAINS) releases.putSnapshot(id, domain, "summary", AT, { lineage });
  releases.recordEvaluation({
    runId: id, baseRunId: base, datasetVersion: "dataset", status: "passed",
    report: { status: "passed" }, createdAt: AT
  });
}

function activeId(db: DatabaseSync): string | null {
  return (db.prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton=1").get() as
    { id?: string } | undefined)?.id ?? null;
}

function jobStatus(db: DatabaseSync): string | null {
  return (db.prepare("SELECT status FROM recompute_jobs WHERE id=?").get(JOB_ID) as
    { status?: string } | undefined)?.status ?? null;
}

test("T04 发布事务 COMMIT 前 SIGKILL：active 指针与 job 结算同进同退，重放一次成功", async (context) => {
  if (process.platform === "win32") {
    context.skip("SIGKILL signal semantics are covered on POSIX hosts");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "rai-phase4-model-crash-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath, { createMigrationBackup: false });
    try {
      const db = store.database;
      db.prepare("INSERT INTO import_manifest VALUES('dataset_version','dataset')").run();
      seedCandidate(db, "release-a", null);
      new SqliteModelRunRepository(db).activateSucceeded("release-a", AT);
      seedCandidate(db, "candidate-b", "release-a");
      db.prepare(`INSERT INTO recompute_jobs
        (id, job_type, status, dataset_version, request_json, progress_phase, started_at)
        VALUES (?, 'full_recompute', 'running', 'dataset', '{}', 'publishing', ?)`).run(JOB_ID, AT);
    } finally {
      store.close();
    }

    const kill = spawnSync(process.execPath, ["--import", "tsx", CHILD, databasePath, JOB_ID, "candidate-b", "kill"], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000
    });
    assert.equal(kill.signal, "SIGKILL", `${kill.stdout}${kill.stderr}`);

    const afterCrash = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(activeId(afterCrash), "release-a", "pointer must not move before COMMIT");
      assert.equal(jobStatus(afterCrash), "running", "job settlement must not become visible before COMMIT");
      const bundle = afterCrash.prepare(
        "SELECT activated_at AS at FROM model_release_bundles WHERE model_run_id='candidate-b'"
      ).get() as { at?: string | null } | undefined;
      assert.equal(bundle?.at ?? null, null, "candidate must remain unactivated");
    } finally { afterCrash.close(); }

    const commit = spawnSync(process.execPath, ["--import", "tsx", CHILD, databasePath, JOB_ID, "candidate-b", "commit"], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000
    });
    assert.equal(commit.status, 0, commit.stderr);

    const afterCommit = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(activeId(afterCommit), "candidate-b");
      assert.equal(jobStatus(afterCommit), "succeeded");
      const bundle = afterCommit.prepare(
        "SELECT activated_at AS at FROM model_release_bundles WHERE model_run_id='candidate-b'"
      ).get() as { at?: string | null } | undefined;
      assert.ok(bundle?.at);
    } finally { afterCommit.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
