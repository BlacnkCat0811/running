// 分析任务登记能力（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §3.2 / 步骤 6b）。
//
// 本文件只钉两件事，都是**能力**而非"上线"：
//   1. `enqueue` 的可选绑定参数（v35 的四个列）确实写进了库；
//   2. 不传绑定参数时，落库结果与 v35 之前**逐列相同**（历史调用方不受影响）。
//
// ⛔ 本文件**不**证明任何"分析任务已经被登记进直连车道"——今天直连车道恒为 record-only，
// 见 apps/api/test/direct-sync-analysis-registration.test.ts。这里只提供将来登记要用的能力。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import { RecomputeJobRepository } from "../src/recompute-job-repository.js";

interface BindingRow {
  job_type: string;
  status: string;
  progress_phase: string;
  target_raw_generation: number | null;
  target_dependency_generation: number | null;
  expected_incumbent_release_id: string | null;
  dirty_json: string | null;
}

function readRow(store: RaiDatabase, id: string): BindingRow {
  return store.database.prepare(`
    SELECT job_type, status, progress_phase,
      target_raw_generation, target_dependency_generation,
      expected_incumbent_release_id, dirty_json
    FROM recompute_jobs WHERE id = ?
  `).get(id) as unknown as BindingRow;
}

test("不传绑定参数时，四个 v35 列保持 NULL，其余列与历史逐列相同", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-bindings-legacy-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    // 阳性对照：先确认这四个列**真的存在**。若列不存在，下面的 NULL 断言会因
    // "列名写错"而抛错，也可能因 fixture 缺失而变成一次空跑。
    const columns = (store.database
      .prepare("PRAGMA table_info(recompute_jobs)")
      .all() as unknown as Array<{ name: string }>).map(({ name }) => name);
    for (const column of [
      "target_raw_generation",
      "target_dependency_generation",
      "expected_incumbent_release_id",
      "dirty_json"
    ]) {
      assert.ok(columns.includes(column), `v35 绑定列缺失：${column}`);
    }

    const repository = new RecomputeJobRepository(store.database);
    const id = repository.enqueue("snapshot_refresh", "dataset-1", { timezoneIdentifier: "UTC" });

    // node:sqlite 返回的是 null-prototype 对象，先摊平成普通对象再深比。
    assert.deepEqual({ ...readRow(store, id) }, {
      job_type: "snapshot_refresh",
      status: "queued",
      progress_phase: "queued",
      target_raw_generation: null,
      target_dependency_generation: null,
      expected_incumbent_release_id: null,
      dirty_json: null
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("传绑定参数时，四个 v35 列按值写入（dirty 序列化为 JSON）", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-bindings-write-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const repository = new RecomputeJobRepository(store.database);
    const id = repository.enqueue("import", "dataset-1", { source: "direct-sync" }, {
      targetRawGeneration: 7,
      targetDependencyGeneration: 3,
      expectedIncumbentReleaseId: "release_abc",
      dirty: { records: ["r1", "r2"], reason: "heart_rate" }
    });

    const row = readRow(store, id);
    assert.equal(row.job_type, "import");
    assert.equal(row.status, "queued");
    assert.equal(row.target_raw_generation, 7);
    assert.equal(row.target_dependency_generation, 3);
    assert.equal(row.expected_incumbent_release_id, "release_abc");
    assert.deepEqual(JSON.parse(String(row.dirty_json)), {
      records: ["r1", "r2"],
      reason: "heart_rate"
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("只给部分绑定字段时，未给的列仍为 NULL", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-bindings-partial-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const repository = new RecomputeJobRepository(store.database);
    const id = repository.enqueue("import", null, {}, { targetRawGeneration: 11 });
    const row = readRow(store, id);
    assert.equal(row.target_raw_generation, 11);
    assert.equal(row.target_dependency_generation, null);
    assert.equal(row.expected_incumbent_release_id, null);
    assert.equal(row.dirty_json, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("job_type / status 的 CHECK 未被放宽：未知类型仍被库拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-bindings-check-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    // 这不是"测 enqueue"——它钉的是"有人为了登记分析任务去放宽 job_type 的 CHECK"
    // 这条捷径：一旦放宽，下面这条 INSERT 会成功而不是抛错。
    assert.throws(() => {
      store.database.prepare(`
        INSERT INTO recompute_jobs (id, job_type, status, dataset_version, request_json, progress_phase)
        VALUES ('probe', 'route_analysis', 'queued', NULL, '{}', 'queued')
      `).run();
    }, /CHECK constraint failed/i);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
