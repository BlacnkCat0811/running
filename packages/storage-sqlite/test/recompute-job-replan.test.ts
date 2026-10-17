// B03（2026-10-17 第二轮复查）：自动重排必须**沿原任务 id** 闭环。
//
// 被复查确认的缺陷形态（合成端到端）：输入漂移时 `replanAfterInputDrift` 新建一条后继任务，
// 原任务被 `runNextJob` 的 catch 送进 `fail`。于是：
//   * 客户端手里那个 `analysisJobId`（回执里写的）**永久是 failed**；
//   * 真正算完的是另一个 id，而两者之间没有任何持久关联；
//   * iOS 的"终态失败不被迟到读取覆盖"保护让客户端连"其实是成功的"都拼不出来。
//
// 修法：把原任务从 running **退回 queued**（同一个 id、同一份回执、同一份登记证据），
// 重排次数与新计划写进请求载荷。这个文件钉仓库层的四个出口：
//
//   1. running → queued，id 不变，请求被替换，阶段是 `replan_pending`；
//   2. 用户已请求取消 ⇒ **不**放回队列（取消优先），返回 `cancelled`；
//   3. 不是 running 的任务 ⇒ 一个字节都不改（`not_running`，不伪造重排）；
//   4. 重排后能被重新领取（否则"退回队列"只是一句状态字符串）。
//
// ⚠️ 界限：本文件证明的是**仓库层**的判据。pipeline 侧"漂移不再抛错"的接线由
// `check-background-capabilities.py` 之外的应用层测试与代码审查覆盖；真机/端到端验收
// 需要真实分批导入，不在纯逻辑夹具里。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DATABASE_TIMEZONE,
  DIRECT_SYNC_ANALYSIS_REQUEST_MODE
} from "@rai/contracts";
import { RecomputeJobRepository } from "../src/recompute-job-repository.js";
import { RaiDatabase } from "../src/database.js";

async function withStore(run: (store: RaiDatabase, jobs: RecomputeJobRepository) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-replan-requeue-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    run(store, new RecomputeJobRepository(store.database));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function enqueue(jobs: RecomputeJobRepository, batchId: string): string {
  return jobs.enqueue(
    "import",
    `dataset_${batchId}`,
    {
      mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
      importBatchId: batchId,
      evaluatedAt: "2026-10-17T00:00:00.000Z",
      timezoneIdentifier: DATABASE_TIMEZONE
    },
    { targetRawGeneration: 1, targetDependencyGeneration: 1 }
  );
}

function requeueRequest(batchId: string, attempts: number): Record<string, unknown> {
  return {
    mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
    importBatchId: batchId,
    evaluatedAt: "2026-10-17T00:00:00.000Z",
    timezoneIdentifier: DATABASE_TIMEZONE,
    bindingDriftReplans: attempts,
    incrementalPlan: {
      mode: "partial",
      dirtyFromAt: "2026-03-01T09:00:00.000Z",
      domains: {
        features: "2026-03-01T09:00:00.000Z",
        fitness: "2026-03-01T09:00:00.000Z",
        readiness: "2026-03-01T09:00:00.000Z"
      }
    }
  };
}

test("B03：漂移重排退回**原任务**，不新建后继 id", async () => {
  await withStore((store, jobs) => {
    const id = enqueue(jobs, "batch_drift");
    const claimed = jobs.claimNext();
    assert.equal(claimed?.id, id, "the fixture task must be claimable");
    const before = Number((store.database.prepare(
      "SELECT COUNT(*) AS n FROM recompute_jobs"
    ).get() as { n: number }).n);

    const outcome = jobs.requeueForReplan(
      id,
      requeueRequest("batch_drift", 1),
      {
        targetRawGeneration: 2,
        targetDependencyGeneration: 2
      },
      "Replanned after input drift during stage:features"
    );

    assert.equal(outcome, "requeued");
    const row = store.database.prepare(`
      SELECT status, progress_phase AS phase, request_json AS requestJson,
             target_raw_generation AS targetRaw,
             target_dependency_generation AS targetDependency,
             attempts, started_at AS startedAt, error_json AS errorJson
      FROM recompute_jobs WHERE id = ?
    `).get(id) as {
      status: string; phase: string; requestJson: string; targetRaw: number;
      targetDependency: number; attempts: number; startedAt: string | null; errorJson: string | null;
    };
    assert.equal(row.status, "queued", "the original task goes back to the queue");
    assert.equal(row.phase, "replan_pending", "the phase names the replan instead of a terminal failure");
    assert.equal(row.startedAt, null, "a queued task carries no start time");
    assert.equal(row.errorJson, null, "no failure is recorded — the task is not done failing");
    assert.equal(Number(row.targetRaw), 2, "the replanned capture generation replaces the old target");
    assert.equal(Number(row.targetDependency), 2);
    assert.equal(Number(row.attempts), 1, "the replan is counted, so an unbounded loop is observable");
    const request = JSON.parse(row.requestJson) as Record<string, unknown>;
    assert.equal(request.bindingDriftReplans, 1);
    assert.deepEqual(request.incrementalPlan, requeueRequest("batch_drift", 1).incrementalPlan);

    const after = Number((store.database.prepare(
      "SELECT COUNT(*) AS n FROM recompute_jobs"
    ).get() as { n: number }).n);
    assert.equal(after, before, "no successor job is created — the client's id stays the only one");

    // 退回队列必须真的能被再次领取，否则"重排"只是一句状态字符串。
    const reclaimed = jobs.claimNext();
    assert.equal(reclaimed?.id, id, "the replanned task is the one that runs next");
  });
});

test("B03：用户已请求取消 ⇒ 重排不得把任务放回队列", async () => {
  await withStore((store, jobs) => {
    const id = enqueue(jobs, "batch_cancel");
    jobs.claimNext();
    jobs.requestCancellation(id);

    const outcome = jobs.requeueForReplan(
      id, requeueRequest("batch_cancel", 1),
      { targetRawGeneration: 2, targetDependencyGeneration: 2 },
      "Replanned after input drift"
    );
    assert.equal(outcome, "cancelled");
    const row = store.database.prepare(
      "SELECT status, cancel_requested AS cancelRequested FROM recompute_jobs WHERE id = ?"
    ).get(id) as { status: string; cancelRequested: number };
    assert.equal(row.status, "running", "cancellation is settled by the normal failure path, not by the replan");
    assert.equal(Number(row.cancelRequested), 1, "the cancellation request is preserved");
  });
});

test("B03：不是 running 的任务不会被伪造成一次重排", async () => {
  await withStore((store, jobs) => {
    const id = enqueue(jobs, "batch_queued");
    const before = store.database.prepare(
      "SELECT status, request_json AS requestJson, attempts FROM recompute_jobs WHERE id = ?"
    ).get(id) as { status: string; requestJson: string; attempts: number };

    const outcome = jobs.requeueForReplan(
      id, requeueRequest("batch_queued", 1),
      { targetRawGeneration: 2, targetDependencyGeneration: 2 },
      "Replanned after input drift"
    );
    assert.equal(outcome, "not_running");
    const after = store.database.prepare(
      "SELECT status, request_json AS requestJson, attempts FROM recompute_jobs WHERE id = ?"
    ).get(id) as { status: string; requestJson: string; attempts: number };
    assert.deepEqual(after, before, "a queued or finished task is left untouched");
  });
});
