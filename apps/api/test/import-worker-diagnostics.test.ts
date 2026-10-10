import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RaiDatabase } from "@rai/storage-sqlite";

import { ImportWorker, PUBLIC_IMPORT_FAILURE_ERROR } from "../src/import-worker.js";
import { mobileRefreshOutcome } from "../src/mobile-sync.js";
import { RuntimeStateStore } from "../src/runtime-state.js";

interface CommandSurface {
  command(args: string[]): Promise<void>;
}

function fixture(project?: string) {
  const root = mkdtempSync(join(tmpdir(), "rai-import-diagnostics-"));
  const worker = new ImportWorker(join(root, "rai.sqlite"), project ?? root, root);
  return {
    root, worker,
    surface: worker as unknown as CommandSurface,
    async close() {
      await worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("import command preserves stdout business failure, stderr warning, and exit code", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.surface.command(["-e", `
      console.error("ExperimentalWarning: SQLite is an experimental feature");
      console.log(JSON.stringify({status: "failed", error: {message: "fixture recompute business failure"}}));
      process.exitCode = 7;
    `]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /code=7, signal=none/);
      assert.match(error.message, /stderr:\nExperimentalWarning/);
      assert.match(error.message, /stdout:\n.*fixture recompute business failure/);
      return true;
    });
  } finally { await f.close(); }
});

test("import command drains output larger than pipe capacity while retaining bounded tails",
  { timeout: 10_000 }, async () => {
    const f = fixture();
    try {
      const output = `
        console.log("stdout-prefix-" + "x".repeat(2 * 1024 * 1024) + "-stdout-tail");
        console.error("stderr-prefix-" + "y".repeat(2 * 1024 * 1024) + "-stderr-tail");
      `;
      // Successful children also need both pipes drained, not just failed ones.
      await f.surface.command(["-e", output]);
      await assert.rejects(f.surface.command(["-e", output + "process.exitCode = 1;"]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.length < 34_000, "diagnostics must not retain the entire export");
          assert.match(error.message, /-stdout-tail/);
          assert.match(error.message, /-stderr-tail/);
          assert.doesNotMatch(error.message, /stdout-prefix|stderr-prefix/);
          return true;
        });
    } finally { await f.close(); }
  });

test("real recompute failure reaches durable import diagnostics before staging rollback",
  { timeout: 60_000 }, async () => {
    const f = fixture(resolve(import.meta.dirname, "../../.."));
    const store = await RaiDatabase.open(join(f.root, "rai.sqlite"));
    store.database.exec(`
      CREATE TRIGGER fixture_recompute_failure BEFORE INSERT ON feature_runs
      BEGIN SELECT RAISE(ABORT, 'fixture actual recompute failure'); END;
    `);
    store.close();
    const input = join(f.root, "export");
    mkdirSync(input);
    writeFileSync(join(input, "export.xml"), `<HealthData>
      <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Apple Watch"
        duration="30" durationUnit="min" totalDistance="5" totalDistanceUnit="km"
        startDate="2026-10-09 08:00:00 +0800" endDate="2026-10-09 08:30:00 +0800"/>
    </HealthData>`);
    try {
      const created = f.worker.create(input);
      const deadline = Date.now() + 50_000;
      while (f.worker.isRunning) {
        assert.ok(Date.now() < deadline, "real failed import did not finalize");
        await new Promise((done) => setTimeout(done, 25));
      }
      const internal = new RuntimeStateStore(f.root).job(created.id)!;
      assert.equal(internal.status, "failed");
      assert.match(internal.error ?? "", /code=1, signal=none/);
      assert.match(internal.error ?? "", /fixture actual recompute failure/);
      assert.equal(f.worker.latest()?.error, PUBLIC_IMPORT_FAILURE_ERROR);
      assert.equal(existsSync(join(f.root, "var", `rai.importing.${created.id}.sqlite`)), false,
        "the diagnostic must outlive the deleted staging database");
      const live = await RaiDatabase.open(join(f.root, "rai.sqlite"));
      try {
        assert.equal(live.database.prepare("SELECT COUNT(*) AS n FROM workouts").get()?.n, 0,
          "failed recompute must not publish imported data");
      } finally { live.close(); }
    } finally { await f.close(); }
  });

test("import command reports empty-output exits", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.surface.command(["-e", "process.exitCode = 3;"]),
      /code=3, signal=none/);
  } finally { await f.close(); }
});

test("import command reports terminating signals",
  { skip: process.platform === "win32" }, async () => {
    const f = fixture();
    try {
      await assert.rejects(f.surface.command(["-e", "process.kill(process.pid, 'SIGTERM');"]),
        /code=null, signal=SIGTERM/);
    } finally { await f.close(); }
  });

test("failed import diagnostics survive cleanup and restart without leaking via public/mobile DTOs",
  { timeout: 10_000 }, async () => {
    const f = fixture();
    let restarted: ImportWorker | undefined;
    const failure = "fixture business error: /private/health-export/secret.xml";
    writeFileSync(join(f.root, "export.xml"), "<HealthData/>");
    f.surface.command = async () => { throw new Error(failure); };
    try {
      const created = f.worker.create(f.root, undefined, "source-fixture");
      const deadline = Date.now() + 8_000;
      while (f.worker.isRunning) {
        assert.ok(Date.now() < deadline, "failed import did not finalize");
        await new Promise((done) => setTimeout(done, 20));
      }
      const state = new RuntimeStateStore(f.root);
      assert.equal(state.job(created.id)?.status, "failed");
      assert.match(state.job(created.id)?.error ?? "", /fixture business error/);
      assert.equal(f.worker.get(created.id)?.error, PUBLIC_IMPORT_FAILURE_ERROR);
      assert.equal(mobileRefreshOutcome(f.worker.latest())?.error, PUBLIC_IMPORT_FAILURE_ERROR);
      await f.worker.close();
      restarted = new ImportWorker(join(f.root, "rai.sqlite"), f.root, f.root);
      assert.equal(restarted.get(created.id)?.error, PUBLIC_IMPORT_FAILURE_ERROR);
      assert.equal(restarted.findBySourceId("source-fixture")?.error, PUBLIC_IMPORT_FAILURE_ERROR);
      assert.equal(mobileRefreshOutcome(restarted.latest())?.error, PUBLIC_IMPORT_FAILURE_ERROR);
      assert.match(state.job(created.id)?.error ?? "", /private\/health-export\/secret.xml/);
    } finally {
      await restarted?.close();
      await f.close();
    }
  });
