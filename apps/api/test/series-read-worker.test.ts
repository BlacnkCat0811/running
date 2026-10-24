import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Worker } from "node:worker_threads";

import type { WorkoutSeriesResponse } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";

import {
  SeriesReadBusinessError,
  SeriesReadOverloadedError,
  SeriesReadWorker,
  SeriesReadWorkerUnavailableError,
  seriesReadFailureAction
} from "../src/series-read-worker.js";

import { posixOnlyReason } from "./posix-only.js";

const START = "2026-09-20T08:00:00.000Z";
const END = "2026-09-20T09:00:00.000Z";

class HeldWorker extends EventEmitter {
  readonly messages: Array<Record<string, unknown>> = [];
  postMessage(message: Record<string, unknown>): void { this.messages.push(message); }
  terminate(): Promise<number> { return Promise.resolve(0); }
}

const asWorker = (worker: HeldWorker): Worker => worker as unknown as Worker;

async function waitFor<T>(read: () => T | null, message: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

const emptySeries = (id: string): WorkoutSeriesResponse => ({ trainingSessionId: id } as WorkoutSeriesResponse);

async function seedSession(path: string, sessionId: string, workoutId: string): Promise<void> {
  const database = await RaiDatabase.open(path);
  try {
    database.database.prepare(`
      INSERT INTO workouts (
        id, activity_type, source_name, source_category, source_version, device,
        start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json,
        is_canonical
      ) VALUES (?, 'HKWorkoutActivityTypeRunning', 'Watch', 'apple_watch', '26.6', 'Watch',
        ?, ?, 3600, 0, '{}', '{}', 1)
    `).run(workoutId, START, END);
    database.database.prepare(`
      INSERT INTO training_sessions (
        id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status
      ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 10, ?, 'active')
    `).run(sessionId, START, END, workoutId);
  } finally { database.close(); }
}

/**
 * 🔴 CI 2026-10-25（`windows-latest`）：本条红在收尾的 `rmSync(root)` 上 ——
 * `EBUSY: resource busy or locked, unlink '…\rai.sqlite'`。机制是 Windows 不允许删除
 * 仍被打开的文件：`worker.close()` 只是发出 `terminate()`，worker 线程真正退出是异步的，
 * 收尾时它手里的库句柄还在。POSIX 允许 unlink 一个仍被打开的文件（inode 语义），Windows 不允许。
 *
 * 这条判据要证明的是"换库后主线程重建 worker 并读到新快照"，它的完整动作串
 * （换文件 → 线程退出 → 清理）在 Windows 上做不出来，所以这条判据在那里没有被检查。
 * 同文件其余用例（superseded-generation、maxPending、启动等待上界）不做换库，照常通过。
 */
const FILE_REPLACEMENT_ONLY = posixOnlyReason(
  "Windows 不允许删除/替换仍被打开的文件：worker 线程还握着换库前的 rai.sqlite，"
  + "`worker.close()` 之后线程真正退出是异步的，收尾 `rmSync` 直接 EBUSY"
  + "（CI 2026-10-25：「EBUSY: resource busy or locked, unlink …rai.sqlite」）。"
  + "本条判据（换库后 worker 必须重建并读到新快照）所依赖的换文件+线程退出+清理动作在 Windows 上"
  + "做不出来，因此没有被检查；真正的 Windows 换库路径另立工单。"
);

test("route failure policy keeps overload, fallback and business exceptions distinct", () => {
  assert.equal(seriesReadFailureAction(new SeriesReadOverloadedError()), "overloaded");
  assert.equal(seriesReadFailureAction(new SeriesReadWorkerUnavailableError("worker exited")), "fallback");
  assert.equal(seriesReadFailureAction(new SeriesReadBusinessError("query failed")), "propagate");
  assert.equal(seriesReadFailureAction(new Error("lease/dataset failure")), "propagate");
});

test("series read worker serves a snapshot, restarts on file replacement, and closes cleanly", { skip: FILE_REPLACEMENT_ONLY }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-series-worker-"));
  const path = join(root, "rai.sqlite");
  const nextPath = join(root, "next.sqlite");
  await seedSession(path, "s1", "w1");
  const worker = new SeriesReadWorker(path);
  try {
    const first = await worker.request("s1", []);
    assert.equal(first?.trainingSessionId, "s1");
    assert.deepEqual(first?.segments, []);
    assert.deepEqual(first?.splits, []);

    // 换库：inode 变化必须让主线程重建 worker，而不是继续用旧连接。
    await seedSession(nextPath, "s2", "w2");
    renameSync(nextPath, path);
    const second = await worker.request("s2", []);
    assert.equal(second?.trainingSessionId, "s2", "worker must reopen the replaced database file");

    worker.close();
    await assert.rejects(() => worker.request("s1", []), /closed/);
    worker.close(); // idempotent
  } finally {
    worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a late ready/exit from the superseded worker cannot settle the replacement generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-series-worker-generation-"));
  const path = join(root, "rai.sqlite");
  const nextPath = join(root, "next.sqlite");
  await seedSession(path, "s1", "w1");
  const workers: HeldWorker[] = [];
  const worker = new SeriesReadWorker(path, 4, {
    startupTimeoutMs: 1_000,
    createWorker: () => {
      const fake = new HeldWorker();
      workers.push(fake);
      return asWorker(fake);
    }
  });
  try {
    const firstPromise = worker.request("s1", []);
    const first = await waitFor(() => workers[0] ?? null, "first worker was not created");
    first.emit("message", { type: "ready" });
    const firstMessage = await waitFor(
      () => first.messages.find((message) => typeof message.requestId === "number") ?? null,
      "first request was not dispatched"
    );
    first.emit("message", { requestId: firstMessage.requestId, series: emptySeries("s1") });
    assert.equal((await firstPromise)?.trainingSessionId, "s1");

    await seedSession(nextPath, "s2", "w2");
    renameSync(nextPath, path);
    const secondPromise = worker.request("s2", []);
    const second = await waitFor(() => workers[1] ?? null, "replacement worker was not created");

    // A delayed ready event from generation 1 must not resolve generation 2's readiness.
    first.emit("message", { type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(second.messages.length, 0, "old ready event leaked into the replacement startup");
    second.emit("message", { type: "ready" });
    const secondMessage = await waitFor(
      () => second.messages.find((message) => typeof message.requestId === "number") ?? null,
      "second request was not dispatched"
    );

    // This is the review scenario: the old worker exits after the new request is accepted.
    const secondSettled = secondPromise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    first.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    second.emit("message", { requestId: secondMessage.requestId, series: emptySeries("s2") });
    const settled = await secondSettled;
    assert.equal(settled.ok, true, settled.ok ? undefined : `old exit rejected new request: ${String(settled.error)}`);
    assert.equal(settled.ok ? settled.value?.trainingSessionId : null, "s2");
  } finally {
    worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("maxPending bounds requests that are still waiting for startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-series-worker-admission-"));
  const path = join(root, "rai.sqlite");
  await seedSession(path, "s1", "w1");
  const workers: HeldWorker[] = [];
  const worker = new SeriesReadWorker(path, 2, {
    startupTimeoutMs: 1_000,
    createWorker: () => {
      const fake = new HeldWorker();
      workers.push(fake);
      return asWorker(fake);
    }
  });
  try {
    const first = worker.request("s1", []);
    const second = worker.request("s1", []);
    await assert.rejects(() => worker.request("s1", []), SeriesReadOverloadedError);
    assert.equal(worker.admittedCount, 2, "admission must count startup waiters");

    const startup = await waitFor(() => workers[0] ?? null, "worker was not created");
    startup.emit("message", { type: "ready" });
    const messages = await waitFor(
      () => startup.messages.filter((message) => typeof message.requestId === "number").length === 2
        ? startup.messages.filter((message) => typeof message.requestId === "number")
        : null,
      "both admitted requests were not dispatched"
    );
    for (const message of messages) {
      startup.emit("message", { requestId: message.requestId, series: emptySeries("s1") });
    }
    assert.equal((await first)?.trainingSessionId, "s1");
    assert.equal((await second)?.trainingSessionId, "s1");
    assert.equal(worker.admittedCount, 0);
  } finally {
    worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup wait is bounded and worker business errors are not classified as fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-series-worker-errors-"));
  const path = join(root, "rai.sqlite");
  await seedSession(path, "s1", "w1");
  const workers: HeldWorker[] = [];
  const worker = new SeriesReadWorker(path, 2, {
    startupTimeoutMs: 25,
    createWorker: () => {
      const fake = new HeldWorker();
      workers.push(fake);
      return asWorker(fake);
    }
  });
  try {
    await assert.rejects(
      () => worker.request("s1", []),
      (error: unknown) => error instanceof SeriesReadWorkerUnavailableError && /did not become ready/.test(error.message)
    );
    assert.equal(worker.admittedCount, 0, "failed startup must release its admission slot");

    const businessRequest = worker.request("s1", []);
    const businessWorker = await waitFor(() => workers[1] ?? null, "business-test worker was not created");
    businessWorker.emit("message", { type: "ready" });
    const message = await waitFor(
      () => businessWorker.messages.find((candidate) => typeof candidate.requestId === "number") ?? null,
      "request was not dispatched after startup"
    );
    businessWorker.emit("message", {
      requestId: message.requestId,
      error: { kind: "business", message: "query failed" }
    });
    await assert.rejects(
      () => businessRequest,
      (error: unknown) => error instanceof SeriesReadBusinessError && !(error instanceof SeriesReadWorkerUnavailableError)
    );
  } finally {
    worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

