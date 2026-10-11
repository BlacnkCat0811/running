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

test("runtime metadata upgrades old jobs and round-trips timings without changing business schema", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-performance-"));
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
