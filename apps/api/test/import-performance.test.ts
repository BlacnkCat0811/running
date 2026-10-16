import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImportPerformanceTracker } from "../src/import-performance.js";
import { RuntimeStateStore } from "../src/runtime-state.js";

// The RAI_IMPORT_VALIDATION_MODE parser and its "never silently disable validation
// because of a typo" test were removed on 2026-09-20 together with the shadow
// full-replay comparison. `validationMode` is now permanently "not-run"; the model
// activation gate was never controlled by that variable and is unaffected.

test("stage timing survives failure and snapshots are detached from subsequent measurements", async () => {
  let now = 10;
  const timing = new ImportPerformanceTracker(() => now);
  assert.equal(await timing.measure("backupCopy", () => { now += 5; return "backupCopy"; }), "backupCopy");
  const first = timing.snapshot();
  assert.deepEqual(first, { validationMode: "not-run", totalMs: 5, stagesMs: { backupCopy: 5 } });
  await assert.rejects(timing.measure("recompute", async () => {
    now += 20;
    throw new Error("fixture");
  }), /fixture/);
  await timing.measure("cleanup", () => { now += 3; });
  await timing.measure("cleanup", () => { now += 2; });
  assert.deepEqual(timing.snapshot(), {
    validationMode: "not-run", totalMs: 30, stagesMs: { backupCopy: 5, recompute: 20, cleanup: 5 }
  });
  assert.equal(first.validationMode, "not-run");
  assert.deepEqual(first.stagesMs, { backupCopy: 5 });
});

/**
 * WP-41 / O12 步骤 7：两条导入车道搬进**同一个**任务 Worker 之后，主线程再也无法用
 * "围着一次调用计时"的方式分别量出两条车道 —— 它只能看到"任务整体"。所以阶段账本必须有
 * 一个入口，把 worker 线程内测得的**外部时长**记进来（`record`）。
 *
 * 这条用例钉三件事：①同名阶段累加；②"没跑"不得被写成 0（非正数/非有限值一律不落键，
 * 于是 `undefined` 与 `0` 可分辨）；③`record` 不改 `totalMs`（总时长只由 tracker 自己的
 * 时钟决定，否则阶段之和会与总时长脱钩、`totalMs >= ΣstagesMs` 那条断言就变成假绿）。
 */
test("record() 记入外部测得的车道耗时：累加、跳过非正数、不改总时长", () => {
  let now = 100;
  const timing = new ImportPerformanceTracker(() => now);
  timing.record("dataOnlyApply", 12.5);
  timing.record("dataOnlyApply", 7.5);
  // 没跑过的车道：0 / NaN / Infinity 都不落键 —— "跳过"与"跑了 0 ms"必须可分辨。
  timing.record("directSyncApply", 0);
  timing.record("directSyncApply", Number.NaN);
  timing.record("directSyncApply", Number.POSITIVE_INFINITY);
  const snapshot = timing.snapshot();
  assert.deepEqual(snapshot.stagesMs, { dataOnlyApply: 20 });
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.stagesMs, "directSyncApply"), false,
    "没跑过的车道不得留下键（0 会被读成「跑过、耗时 0」）");
  now += 40;
  assert.equal(timing.snapshot().totalMs, 40, "record 不得改动总时长：它只记外部测得的片段");
});

test("runtime metadata upgrades old jobs and round-trips timings without changing business schema", () => {  const root = mkdtempSync(join(tmpdir(), "rai-import-performance-"));
  try {
    const old = new RuntimeStateStore(root);
    const job = {
      id: "fixture", status: "failed", phase: "failed", message: "fixture",
      createdAt: new Date().toISOString(), completedAt: null, error: "fixture", inputPath: root
    };
    old.upsertJob(job);
    const db = new DatabaseSync(old.path);
    try { db.exec("ALTER TABLE import_jobs DROP COLUMN performance_json"); }
    finally { db.close(); }
    const upgraded = new RuntimeStateStore(root);
    assert.equal(upgraded.jobs()[0]?.performance, undefined);
    const timing = new ImportPerformanceTracker();
    const performance = timing.snapshot();
    upgraded.upsertJob({ ...job, performance });
    const reopened = new RuntimeStateStore(root);
    assert.deepEqual(reopened.jobs()[0]?.performance, performance);
    assert.equal(reopened.jobs()[0]?.id, job.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
