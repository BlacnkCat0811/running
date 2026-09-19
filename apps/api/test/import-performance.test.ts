import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImportPerformanceTracker, importValidationModeFromEnvironment } from "../src/import-performance.js";
import { RuntimeStateStore } from "../src/runtime-state.js";

test("import validation defaults safe and rejects misconfiguration", () => {
  assert.equal(importValidationModeFromEnvironment({}), "shadow");
  assert.equal(importValidationModeFromEnvironment({ RAI_IMPORT_VALIDATION_MODE: " " }), "shadow");
  assert.equal(importValidationModeFromEnvironment({ RAI_IMPORT_VALIDATION_MODE: "off" }), "off");
  assert.equal(importValidationModeFromEnvironment({ RAI_IMPORT_VALIDATION_MODE: " shadow " }), "shadow");
  for (const value of ["false", "0", "weekly", "OFF", "typo"]) {
    assert.throws(() => importValidationModeFromEnvironment({ RAI_IMPORT_VALIDATION_MODE: value }), /must be shadow or off/);
  }
});

test("stage timing survives failure and snapshots are detached from subsequent measurements", async () => {
  let now = 10;
  const timing = new ImportPerformanceTracker(() => now);
  assert.equal(await timing.measure("backup", () => { now += 5; return "backup"; }), "backup");
  const first = timing.snapshot();
  assert.deepEqual(first, { validationMode: "not-run", totalMs: 5, stagesMs: { backup: 5 } });
  timing.validationMode = "shadow";
  await assert.rejects(timing.measure("recompute", async () => {
    now += 20;
    throw new Error("fixture");
  }), /fixture/);
  await timing.measure("cleanup", () => { now += 3; });
  await timing.measure("cleanup", () => { now += 2; });
  assert.deepEqual(timing.snapshot(), {
    validationMode: "shadow", totalMs: 30, stagesMs: { backup: 5, recompute: 20, cleanup: 5 }
  });
  assert.equal(first.validationMode, "not-run");
  assert.deepEqual(first.stagesMs, { backup: 5 });
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
    timing.validationMode = "off";
    const performance = timing.snapshot();
    upgraded.upsertJob({ ...job, performance });
    const reopened = new RuntimeStateStore(root);
    assert.deepEqual(reopened.jobs()[0]?.performance, performance);
    assert.equal(reopened.jobs()[0]?.id, job.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
