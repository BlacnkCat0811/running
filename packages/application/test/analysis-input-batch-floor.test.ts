import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import { SqliteAnalysisInputReader } from "../src/services/analysis-input-reader.js";

/**
 * 批次读取的**代次下界**下推（item 6d）。
 *
 * 判据不是"少读了几行"，而是：**下界不改变计划**。它只允许把"基线之前、又不是登记成员"
 * 的历史批次挡在 SQL 外 —— 那些批次在计划里本来就不会被 `selectInterveningBatches` 选中。
 * 所以每个用例都跑两遍（auto / 全读），逐字段比较 `plan` / `coverage` / `mergedBatchIds`，
 * 同时断言 `batchScan.scanned` 确实变小了（否则这个用例什么都没测到）。
 */

const TZ = "Asia/Shanghai";
const EVALUATED_AT = "2026-03-15T04:00:00.000Z";

interface BatchSeed {
  id: string;
  raw: number | null;
  dependency: number | null;
  bumped: number | null;
}

function seed(store: RaiDatabase): void {
  // 绑定表对 `model_runs` 有外键，而这条路径只 JOIN `active_model_run` —— 夹具不造 model run。
  store.database.exec("PRAGMA foreign_keys = OFF");
  store.database.exec("BEGIN IMMEDIATE");
  try {
    store.database.prepare(
      "UPDATE import_generations SET raw_generation = 8, dependency_generation = 4 WHERE singleton = 1"
    ).run();
    store.database.prepare(
      "INSERT INTO import_manifest (key, value) VALUES ('dataset_version', 'dataset_fixture')"
    ).run();
    const insertBatch = store.database.prepare(`
      INSERT INTO import_batches
        (id, xml_sha256, status, import_mode, summary_json, raw_generation, dependency_generation, dependency_bumped)
      VALUES (?, 'sha', 'succeeded', 'incremental', '{}', ?, ?, ?)
    `);
    const batches: BatchSeed[] = [
      { id: "b1", raw: 1, dependency: 1, bumped: 1 },
      { id: "b2", raw: 2, dependency: 2, bumped: 1 },
      { id: "b3", raw: 3, dependency: 3, bumped: 1 }, // 可信基线
      { id: "b4", raw: 4, dependency: 3, bumped: 0 }, // 登记成员（低于下界也必须读到）
      { id: "b5", raw: 5, dependency: 4, bumped: 1 },
      { id: "b6", raw: 6, dependency: 4, bumped: 0 },
      { id: "b7", raw: null, dependency: null, bumped: null } // v39 之前的未知行
    ];
    for (const batch of batches) {
      insertBatch.run(batch.id, batch.raw, batch.dependency, batch.bumped);
    }
    store.database.prepare(
      "INSERT INTO active_model_run (singleton, model_run_id) VALUES (1, 'run-base')"
    ).run();
    store.database.prepare(`
      INSERT INTO analysis_run_input_bindings
        (run_id, job_id, scope, dataset_version, captured_raw_generation, captured_dependency_generation,
         timezone_identifier, override_digest, config_digest, cutoff_at, input_digest)
      VALUES ('run-base', 'job-base', 'direct-sync', 'dataset_fixture', 3, 3,
              ?, 'override', 'config', ?, 'digest')
    `).run(TZ, EVALUATED_AT);
    store.database.exec("COMMIT");
  } catch (error) {
    store.database.exec("ROLLBACK");
    throw error;
  }
}

test("the batch generation floor never changes the plan, only how many rows are scanned", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rai-batch-floor-"));
  const store = await RaiDatabase.open(join(directory, "rai.sqlite"), { createMigrationBackup: false });
  try {
    seed(store);
    const reader = new SqliteAnalysisInputReader(store.database, "direct-sync");
    const base = {
      runId: "run-capture-1",
      jobId: "job-1",
      scope: "direct-sync",
      timezoneIdentifier: TZ,
      evaluatedAt: EVALUATED_AT,
      targetRawGeneration: 8,
      targetDependencyGeneration: 4,
      expectedIncumbentReleaseId: null,
      registeredPlan: null,
      registeredBatchIds: ["b4"],
      mergeFromRawGeneration: 4
    };
    const scoped = reader.capture({ ...base, disableBatchFloor: false });
    const full = reader.capture({ ...base, disableBatchFloor: true });

    assert.deepEqual(scoped.plan, full.plan);
    assert.deepEqual(scoped.coverage, full.coverage);
    assert.deepEqual(scoped.mergedBatchIds, full.mergedBatchIds);
    assert.equal(scoped.planAdjustment, full.planAdjustment);

    // 下界取"基线"与"合并起点"中**更早**的那个（保守方向）：base.raw=3、mergeFrom=4 ⇒ 3。
    assert.equal(scoped.batchScan.floor, 3);
    assert.equal(full.batchScan.floor, null);
    // b3 的 raw=3 不满足 `> 3`；b4(登记)、b5、b6、b7(NULL) = 4。全读是 7。
    assert.equal(scoped.batchScan.scanned, 4, JSON.stringify(scoped.batchScan));
    assert.equal(full.batchScan.scanned, 7, JSON.stringify(full.batchScan));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
