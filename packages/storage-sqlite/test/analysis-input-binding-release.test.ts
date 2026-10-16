// `verifyAndPoint` 的**依赖级发布判据**（O06-A / WP-22，决策 D4）。
//
// 为什么必须有这条用例：D4 把"dataset 版本逐字相等"放宽成"依赖级覆盖证明"，
// 而 `verifyAndPoint` 是**唯一**决定候选能不能变成"当前发布"的地方。放宽错在"松"的一侧，
// 后果是旧计算被当最新展示 —— 那正是这项工作的头号风险。所以三个方向都要有对照：
//   ① 老候选（没有绑定行）⇒ 仍然严格拒绝（不能因为放宽把 legacy 一起放过去）；
//   ② raw-only 批次之后 ⇒ 放行（D4 要的就是这一档：它们结构上不动依赖代次）；
//   ③ 依赖代次前进之后 ⇒ 拒绝（候选真的旧了）。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalSemanticJson, type ModelLineageV2 } from "@rai/contracts";
import { createHash } from "node:crypto";

import { RaiDatabase } from "../src/database.js";
import { SqliteModelReleaseRepository, semanticHash } from "../src/model-release-repository.js";

/**
 * 造一个"可发布"的候选：lineage、空快照集合的 bundle、以及让它通过 incumbent 检查的指针。
 * 只造 `verifyAndPoint` 走到 dataset 判据所需的**最少**证据，其余一律不碰。
 */
function prepareCandidate(store: Awaited<ReturnType<typeof RaiDatabase.open>>, runId: string, datasetVersion: string): void {
  const database = store.database;
  database.prepare(`INSERT INTO import_manifest (key, value) VALUES ('dataset_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(datasetVersion);
  const featureRunId = `feature_${runId}`;
  database.prepare(`INSERT INTO feature_runs (id, dataset_version, canonical_contract_version,
    feature_schema_version, feature_config_json, feature_config_hash, status, created_at)
    VALUES (?, ?, 'canonical-health-v2', 'workout-feature-v4', '{}', 'feature-config-hash', 'succeeded', ?)`)
    .run(featureRunId, datasetVersion, "2026-01-01T00:00:00.000Z");
  database.prepare(`INSERT INTO model_runs (id, feature_run_id, dataset_version, model_version,
    model_config_json, model_config_hash, evaluated_at, status, created_at)
    VALUES (?, ?, ?, 'test-model', '{}', 'model-config-hash', ?, 'succeeded', ?)`)
    .run(runId, featureRunId, datasetVersion, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const releases = new SqliteModelReleaseRepository(database);
  const overrideIds = database.prepare(
    "SELECT id FROM effective_workout_overrides ORDER BY training_session_id"
  ).all().map((row) => String((row as { id: string }).id));
  const lineage: ModelLineageV2 = {
    sourceRunId: runId,
    datasetVersion,
    factsSnapshotHash: "facts",
    overrideSnapshotHash: semanticHash(overrideIds),
    modelVersion: "test-model",
    configVersion: "test-config",
    configHash: "config-hash",
    featureSchemaVersion: "workout-feature-v4",
    calibrationCohortHash: null,
    baselineEpochId: null,
    normalizationVersion: "test-normalization",
    normalizationConfigHash: "normalization-hash",
    timezoneIdentifier: "Asia/Shanghai",
    asOf: "2026-01-01T00:00:00.000Z",
    dataThroughAt: null
  };
  releases.recordLineage(runId, "test-engine", "test-config", lineage);
  // 空快照集合：`snapshots()` 返回 []，于是 bundle 的摘要必须等于 semanticHash([])。
  database.prepare(`INSERT INTO model_release_bundles
    (model_run_id, base_model_run_id, dataset_version, snapshot_hash, evaluation_json, status, created_at, activated_at)
    VALUES (?, NULL, ?, ?, '{}', 'passed', ?, NULL)`)
    .run(runId, datasetVersion, semanticHash([]), "2026-01-01T00:00:00.000Z");
  // incumbent 检查：current === runId 即通过（正向发布）。
  database.prepare(`INSERT INTO active_model_run (singleton, model_run_id, activated_at) VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET model_run_id = excluded.model_run_id`).run(runId, "2026-01-01T00:00:00.000Z");
}

function setGenerations(database: import("node:sqlite").DatabaseSync, raw: number, dependency: number): void {
  database.prepare(`UPDATE import_generations SET raw_generation = ?, dependency_generation = ? WHERE singleton = 1`)
    .run(raw, dependency);
}

function addBatch(
  database: import("node:sqlite").DatabaseSync,
  id: string,
  raw: number | null,
  dependency: number | null,
  bumped: number | null
): void {
  database.prepare(`INSERT INTO import_batches (id, xml_sha256, status, import_mode, created_at,
    raw_generation, dependency_generation, dependency_bumped)
    VALUES (?, ?, 'succeeded', 'incremental', ?, ?, ?, ?)`)
    .run(id, "0".repeat(64), "2026-01-01T00:00:00.000Z", raw, dependency, bumped);
}

function writeBinding(
  database: import("node:sqlite").DatabaseSync,
  runId: string,
  capturedRaw: number,
  capturedDependency: number
): void {
  database.prepare(`INSERT INTO analysis_run_input_bindings
    (run_id, job_id, scope, dataset_version, captured_raw_generation, captured_dependency_generation,
     target_raw_generation, target_dependency_generation, incumbent_release_id, timezone_identifier,
     override_digest, config_digest, cutoff_at, input_digest, created_at)
    VALUES (?, 'job_test', 'direct-sync', 'dataset_old', ?, ?, ?, ?, NULL, 'Asia/Shanghai', '', '', ?, ?, ?)`)
    .run(runId, capturedRaw, capturedDependency, capturedRaw, capturedDependency,
      "2026-01-01T00:00:00.000Z", "digest", "2026-01-01T00:00:00.000Z");
}

async function withStore<T>(run: (store: Awaited<ReturnType<typeof RaiDatabase.open>>) => T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rai-input-binding-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    return run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("D4①：没有绑定行的老候选 ⇒ 仍然严格拒绝（放宽不能把 legacy 一起放过去）", async () => {
  await withStore((store) => {
    prepareCandidate(store, "run_legacy", "dataset_v1");
    setGenerations(store.database, 5, 3);
    // 候选之后来了一个 raw-only 批次，dataset 版本因此变了。
    addBatch(store.database, "batch_6", 6, 3, 0);
    store.database.prepare("UPDATE import_manifest SET value='dataset_v2' WHERE key='dataset_version'").run();
    assert.throws(
      () => new SqliteModelReleaseRepository(store.database).verifyAndPoint("run_legacy", "2026-01-02T00:00:00.000Z"),
      /Dataset changed since candidate evaluation/,
      "老候选没有绑定行 ⇒ 走 legacy 严格分支；这里放行就是拿未知当安全"
    );
  });
});

test("D4②：只有 raw-only 批次进来 ⇒ 放行（依赖代次没动就是证明）", async () => {
  await withStore((store) => {
    prepareCandidate(store, "run_raw_only", "dataset_v1");
    setGenerations(store.database, 5, 3);
    writeBinding(store.database, "run_raw_only", 5, 3);
    // 捕获之后三个只写记录、不动依赖代次的批次（record-only 车道结构上就只推 raw）。
    addBatch(store.database, "batch_6", 6, 3, 0);
    addBatch(store.database, "batch_7", 7, 3, 0);
    addBatch(store.database, "batch_8", 8, 3, 0);
    setGenerations(store.database, 8, 3);
    store.database.prepare("UPDATE import_manifest SET value='dataset_v2' WHERE key='dataset_version'").run();
    new SqliteModelReleaseRepository(store.database).verifyAndPoint("run_raw_only", "2026-01-02T00:00:00.000Z");
    const published = store.database.prepare(
      "SELECT model_run_id AS id FROM active_model_release WHERE singleton=1"
    ).get() as { id: string } | undefined;
    assert.equal(published?.id, "run_raw_only", "raw-only 批次不得再让候选发布不了（D4 的收益）");
  });
});

test("D4③：依赖代次前进之后 ⇒ 拒绝（候选真的旧了，不能当最新发布）", async () => {
  await withStore((store) => {
    prepareCandidate(store, "run_stale", "dataset_v1");
    setGenerations(store.database, 5, 3);
    writeBinding(store.database, "run_stale", 5, 3);
    addBatch(store.database, "batch_6", 6, 4, 1);
    setGenerations(store.database, 6, 4);
    store.database.prepare("UPDATE import_manifest SET value='dataset_v2' WHERE key='dataset_version'").run();
    assert.throws(
      () => new SqliteModelReleaseRepository(store.database).verifyAndPoint("run_stale", "2026-01-02T00:00:00.000Z"),
      /Dataset changed since candidate evaluation/,
      "依赖代次前进 ⇒ 候选之后有影响分析的批次 ⇒ 必须重排而不是把旧结果当最新"
    );
  });
});

test("D4④：dataset 版本没变时判据不参与 —— 覆盖证明不能变成新的拒绝理由", async () => {
  await withStore((store) => {
    prepareCandidate(store, "run_same", "dataset_v1");
    setGenerations(store.database, 5, 3);
    writeBinding(store.database, "run_same", 5, 3);
    addBatch(store.database, "batch_6", 6, 4, 1);
    setGenerations(store.database, 6, 4);
    // dataset_version 不变 ⇒ 连 `dependencyAdmissionHolds` 都不会被调用。
    new SqliteModelReleaseRepository(store.database).verifyAndPoint("run_same", "2026-01-02T00:00:00.000Z");
    assert.equal(
      (store.database.prepare("SELECT model_run_id AS id FROM active_model_release WHERE singleton=1").get() as { id: string }).id,
      "run_same"
    );
  });
});

test("D4⑤：历史批次（代次未知）⇒ 拒绝：不确定一律按不安全处理", async () => {
  await withStore((store) => {
    prepareCandidate(store, "run_unknown", "dataset_v1");
    setGenerations(store.database, 5, 3);
    writeBinding(store.database, "run_unknown", 5, 3);
    // v39 之前的历史行：三列都是 NULL。
    addBatch(store.database, "batch_legacy", null, null, null);
    addBatch(store.database, "batch_6", 6, 4, 1);
    setGenerations(store.database, 6, 4);
    store.database.prepare("UPDATE import_manifest SET value='dataset_v2' WHERE key='dataset_version'").run();
    assert.throws(
      () => new SqliteModelReleaseRepository(store.database).verifyAndPoint("run_unknown", "2026-01-02T00:00:00.000Z"),
      /Dataset changed since candidate evaluation/
    );
  });
});

// 占位断言：`createHash` 只在造 lineage 摘要时用得上，这里显式用一次，
// 免得"看起来没用到的 import"被后来的人顺手删掉（本文件确实依赖 sha256 口径）。
test("口径：semanticHash 与 v39 绑定用的摘要同源", () => {
  assert.equal(
    semanticHash([1, 2, 3]),
    createHash("sha256").update(canonicalSemanticJson([1, 2, 3])).digest("hex")
  );
});
