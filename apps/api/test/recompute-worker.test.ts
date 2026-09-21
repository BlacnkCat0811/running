import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";

import { RecomputeWorker } from "../src/recompute-worker.js";

/**
 * An idle `drain()` used to spawn a worker thread anyway, and that thread registers
 * `tsx` from scratch (~2.5 s measured on this machine). The global mutation admission
 * is held for all of it, so every write route arriving in that window answered
 * `409 mutation_conflict` instead of its real status — which is what made
 * `server-runtime.test.ts` flake against a freshly started API.
 *
 * `runOneInWorkerThread` is the only spawn site, so counting its invocations is the
 * direct measurement of "did an idle drain pay for a thread it had no work for".
 */

interface RecomputeWorkerTestSurface {
  runOneInWorkerThread(): Promise<boolean>;
}

const withDatabase = async (action: (databasePath: string) => Promise<void>): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-worker-"));
  try {
    mkdirSync(join(root, "var"));
    const databasePath = join(root, "var", "rai.sqlite");
    (await RaiDatabase.open(databasePath, { createMigrationBackup: false })).close();
    await action(databasePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const enqueue = (databasePath: string, jobType: "snapshot_refresh" | "full_recompute"): void => {
  const database = new DatabaseSync(databasePath);
  try {
    new RecomputeJobRepository(database).enqueue(jobType, null, {});
  } finally {
    database.close();
  }
};

/** Stubs the spawn and counts it, mirroring the recompute-worker cases in worker.test.ts. */
const countingWorker = async (
  databasePath: string
): Promise<{ worker: RecomputeWorker; spawns: () => number; settle: () => Promise<void> }> => {
  const worker = new RecomputeWorker(databasePath);
  let spawns = 0;
  (worker as unknown as RecomputeWorkerTestSurface).runOneInWorkerThread = async () => {
    spawns += 1;
    return false;
  };
  return {
    worker,
    spawns: () => spawns,
    settle: async () => {
      const deadline = Date.now() + 10_000;
      while (worker.isRunning && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(worker.isRunning, false, "the scheduled drain must finish");
    }
  };
};

test("hasPending tracks queued and claimed jobs but not terminals", async () => {
  await withDatabase(async (databasePath) => {
    const database = new DatabaseSync(databasePath);
    try {
      const jobs = new RecomputeJobRepository(database);
      assert.equal(jobs.hasPending(), false, "a fresh database has nothing pending");
      const jobId = jobs.enqueue("snapshot_refresh", null, {});
      assert.equal(jobs.hasPending(), true, "a queued job is pending");
      jobs.claimNext();
      assert.equal(jobs.hasPending(), true, "a claimed (running) job must stay pending for recovery");
      jobs.fail(jobId, new Error("fixture"));
      assert.equal(jobs.hasPending(), false, "a terminal job is not pending");
    } finally {
      database.close();
    }
  });
});

test("an idle drain never spawns a worker thread", async () => {
  await withDatabase(async (databasePath) => {
    const { worker, spawns, settle } = await countingWorker(databasePath);
    try {
      worker.schedule();
      assert.equal(worker.isRunning, true, "schedule must mark the worker as running");
      await settle();
      assert.equal(
        spawns(), 0,
        "an idle drain must not spawn a thread: the global write admission is held "
          + "for the whole tsx registration, so every write route answers 409"
      );
    } finally {
      await worker.close();
    }
  });
});

test("a queued job still spawns a worker thread", async () => {
  await withDatabase(async (databasePath) => {
    enqueue(databasePath, "snapshot_refresh");
    const { worker, spawns } = await countingWorker(databasePath);
    try {
      worker.schedule();
      const deadline = Date.now() + 10_000;
      while (spawns() === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(spawns(), 1, "the idle guard must not skip a queued job");
    } finally {
      await worker.close();
    }
  });
});
