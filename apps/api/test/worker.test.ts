import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiApplicationService, currentAbilityBaselineHash } from "@rai/application";
import { healthTypes, type PredictionModelTrainingRequest } from "@rai/contracts";
import { ImportRemovalGuardError } from "@rai/health-export-parser";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";

import { DatabaseMaintenance } from "../src/maintenance.js";
import type { ImportJobPerformance } from "@rai/api-contracts";
import { FULL_SNAPSHOT_SOURCE_SCOPE } from "../src/import-sources.js";
import {
  ExternalPredictionModelTrainer,
  ImportWorker,
  PredictionModelWorker,
  RecomputeWorker,
  createImportJobId,
  predictionModelWorkerRetryDelay,
  predictionModelArtifactDirectory
} from "../src/worker.js";

interface ImportWorkerTestSurface {
  activateDatabase(
    stagingDatabase: string,
    jobId: string,
    existingBackupPath?: string | null,
    beforeCommit?: () => void | Promise<void>,
  ): Promise<void>;
  createCurrentBackup(jobId: string): Promise<string | null>;
  backupDatabase(database: DatabaseSync, destination: string): Promise<void>;
  isReadableDatabase(path: string): boolean;
  removePartialBackupFile(path: string): Promise<void>;
  preserveHistoricalState(stagingDatabase: string, previousDatabase: string): void;
  analyzeDatasetChange(
    stagingDatabase: string,
    previousDatabase: string,
    batchId?: string,
    preserveAbsent?: boolean
  ): {
    mode: "unchanged" | "data-only" | "incremental" | "full";
    dirtyFromAt: string | null;
    insertedWorkouts: number;
    updatedWorkouts: number;
    unchangedWorkouts: number;
    routesUpdated: number;
  };
  removeDatabaseFiles(databasePath: string): Promise<void>;
  installDatabase(source: string, destination: string): Promise<void>;
  moveDatabaseFile(source: string, destination: string): Promise<void>;
  copyDatabaseFile(source: string, destination: string): Promise<void>;
  stageAuditReports(databasePath: string, markdownPath: string, jsonPath: string): {
    commit(): void;
    rollback(): void;
    finalize(): void;
    discard(): void;
  };
  removeDatabaseFile(path: string): Promise<void>;
  reclaimDisplacedImportDatabases(stagingDatabase: string): Promise<void>;
  persistJobs(): void;
  command(args: string[]): Promise<void>;
  run(job: Record<string, unknown>): Promise<void>;
}

test("failed initial import enqueue leaves no phantom job and can be retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-enqueue-rollback-"));
  const inputPath = join(root, "export");
  mkdirSync(inputPath);
  writeFileSync(join(inputPath, "export.xml"), "<HealthData />", "utf8");
  const worker = new ImportWorker(join(root, "rai.sqlite"), root, root);
  const surface = worker as unknown as ImportWorkerTestSurface;
  const persistJobs = surface.persistJobs.bind(worker);
  let terminalCalls = 0;
  surface.persistJobs = () => {
    throw new Error("fixture initial enqueue persistence failure");
  };
  try {
    assert.throws(
      () => worker.create(inputPath, () => { terminalCalls += 1; }, "source-retryable"),
      /fixture initial enqueue persistence failure/
    );
    assert.equal(worker.isRunning, false);
    assert.equal(worker.latest(), null);
    assert.equal(worker.findBySourceId("source-retryable"), null);
    assert.equal(terminalCalls, 0);

    surface.persistJobs = persistJobs;
    const retried = worker.create(inputPath, undefined, "source-retryable");
    assert.equal(worker.get(retried.id)?.status, "queued");
    assert.equal(worker.findBySourceId("source-retryable")?.id, retried.id);
  } finally {
    await worker.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("import job ids do not collide in the same millisecond", () => {
  const now = 1_700_000_000_000;
  const ids = Array.from({ length: 100 }, () => createImportJobId(now));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.every((id) => id.startsWith(`web_import_${now.toString(36)}_`)), true);
});

interface ExternalTrainerTestSurface {
  command(args: string[], signal?: AbortSignal): Promise<void>;
}

for (const scope of [undefined, "population", "personal"] as const) {
  test(`external prediction trainer forwards ${scope ?? "legacy"} scope to the runner`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-training-scope-"));
    const trainer = new ExternalPredictionModelTrainer(root);
    (trainer as unknown as ExternalTrainerTestSurface).command = async (args) => {
      assert.equal(args[args.indexOf("--scope") + 1], scope ?? "population");
      writeFileSync(args[args.indexOf("--result") + 1]!, "{}");
    };
    try {
      await trainer.train({ runId: "fixture", asOf: "2026-10-01T00:00:00Z", ...(scope ? { scope } : {}), databasePath: join(root, "rai.sqlite"), artifactDirectory: join(root, "artifact") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("prediction worker passes the stored personal scope to its trainer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-worker-scope-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  const asOf = "2026-10-01T00:00:00.000Z";
  store.database.prepare(`INSERT INTO prediction_model_runs (
    id, algorithm, model_version, feature_schema_version, training_data_through_at,
    hyperparameters_json, request_json, status, label_count, created_at
  ) VALUES (?, 'catboost', 'test', 'test', ?, '{}', ?, 'queued', 30, ?)`)
    .run("prediction_model_12345678-1234-1234-1234-123456789abc", asOf, JSON.stringify({ asOf, scope: "personal" }), asOf);
  store.close();
  const requests: PredictionModelTrainingRequest[] = [];
  const worker = new PredictionModelWorker(databasePath, root, root, {
    train: async (request) => { requests.push(request); throw new Error("fixture stops after scope capture"); }
  });
  try {
    worker.schedule();
    await waitFor(() => requests.length === 1);
    assert.equal(requests[0]!.scope, "personal");
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

interface RecomputeWorkerTestSurface {
  runOneInWorkerThread(): Promise<boolean>;
  activeWorker: unknown | null;
  scheduled: boolean;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitFor(predicate: () => boolean, timeoutMilliseconds = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for process state");
    await delay(25);
  }
}

const runDate = (index: number): string => new Date(Date.UTC(2025, 0, 1 + index * 3)).toISOString();

test("isolates prediction artifacts by retry attempt", () => {
  const root = join(tmpdir(), "rai-worker-artifacts");
  const runId = "prediction_model_12345678-1234-1234-1234-123456789abc";
  const first = predictionModelArtifactDirectory(root, runId, 1);
  const second = predictionModelArtifactDirectory(root, runId, 2);
  assert.notEqual(first, second);
  assert.match(first, /prediction_model_12345678-1234-1234-1234-123456789abc[\\/]attempt-1$/);
  assert.match(second, /prediction_model_12345678-1234-1234-1234-123456789abc[\\/]attempt-2$/);
  assert.throws(() => predictionModelArtifactDirectory(root, "../escape", 1));
  assert.throws(() => predictionModelArtifactDirectory(root, runId, 0));
});

// Windows terminates a training run by killing the whole process tree
// (`taskkill /T`); POSIX relies on a process group instead, so this specific
// path cannot be exercised here. Name the reason so it is not a silent skip.
test("cancelling prediction training terminates the Windows process tree", {
  skip: process.platform !== "win32" ? "needs Windows process-tree semantics" : false
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-training-cancel-"));
  const pidPath = join(root, "grandchild.pid");
  const trainer = new ExternalPredictionModelTrainer(root) as unknown as ExternalTrainerTestSurface;
  const controller = new AbortController();
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });",
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    "setInterval(() => {}, 1000);"
  ].join(" ");
  try {
    const running = trainer.command(["-e", parentScript], controller.signal);
    await waitFor(() => existsSync(pidPath));
    const grandchildPid = Number(readFileSync(pidPath, "utf8"));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    controller.abort();
    await assert.rejects(running, /prediction_training_cancelled/);
    await waitFor(() => {
      try {
        process.kill(grandchildPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("recompute worker marks outstanding jobs failed after bounded startup retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-retry-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  const jobId = "recompute_job_startup_failure_fixture";
  store.database.prepare(`
    INSERT INTO recompute_jobs (id, job_type, status, request_json, progress_phase)
    VALUES (?, 'full_recompute', 'queued', '{}', 'queued')
  `).run(jobId);
  store.close();
  const observedErrors: unknown[] = [];
  const worker = new RecomputeWorker(databasePath, (error) => { observedErrors.push(error); });
  let attempts = 0;
  (worker as unknown as RecomputeWorkerTestSurface).runOneInWorkerThread = async () => {
    attempts += 1;
    throw new Error("fixture worker startup failure");
  };
  try {
    worker.schedule();
    await waitFor(() => attempts === 3);
    await waitFor(() => !worker.isRunning);
    await delay(100);
    assert.equal(attempts, 3);
    assert.equal(observedErrors.length, 3);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const job = database.prepare(`
        SELECT status, progress_phase AS progressPhase, completed_at AS completedAt, error_json AS errorJson
        FROM recompute_jobs WHERE id = ?
      `).get(jobId) as { status: string; progressPhase: string; completedAt: string | null; errorJson: string | null };
      assert.equal(job.status, "failed");
      assert.equal(job.progressPhase, "failed");
      assert.ok(job.completedAt);
      assert.match(job.errorJson ?? "", /fixture worker startup failure/);
      const event = database.prepare(`
        SELECT message FROM recompute_job_events WHERE job_id = ? AND phase = 'failed'
      `).get(jobId) as { message: string };
      assert.equal(event.message, "Task failed");
    } finally {
      database.close();
    }
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recompute worker recovers a claimed job after the thread crashes then an empty run", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-recover-crash-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  const jobId = "recompute_job_crash_after_claim";
  store.database.prepare(`
    INSERT INTO recompute_jobs (id, job_type, status, request_json, progress_phase)
    VALUES (?, 'full_recompute', 'queued', '{}', 'queued')
  `).run(jobId);
  store.close();
  const worker = new RecomputeWorker(databasePath);
  const surface = worker as unknown as RecomputeWorkerTestSurface;
  let attempts = 0;
  surface.runOneInWorkerThread = async () => {
    attempts += 1;
    const database = new DatabaseSync(databasePath);
    try {
      const jobs = new RecomputeJobRepository(database);
      if (attempts === 1) {
        assert.equal(jobs.claimNext()?.id, jobId);
        throw new Error("fixture crash after claim");
      }
      const recovered = jobs.claimNext();
      if (!recovered) return false;
      assert.equal(recovered.id, jobId);
      assert.equal(jobs.complete(jobId, "completed", 1, 1, "Recovered after crash"), true);
      return true;
    } finally {
      database.close();
    }
  };
  try {
    worker.schedule();
    await waitFor(() => attempts >= 2);
    await waitFor(() => !worker.isRunning);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const job = database.prepare(`
        SELECT status, progress_phase AS progressPhase FROM recompute_jobs WHERE id = ?
      `).get(jobId) as { status: string; progressPhase: string };
      assert.equal(job.status, "succeeded");
      assert.equal(job.progressPhase, "completed");
    } finally {
      database.close();
    }
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recompute worker wakeups while draining are not dropped", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-wakeup-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  // An empty queue is now short-circuited before any thread spawn, so the "while
  // draining" window this test exercises only exists when a job is claimable.
  store.database.prepare(`
    INSERT INTO recompute_jobs (id, job_type, status, request_json, progress_phase)
    VALUES ('recompute_job_wakeup_fixture', 'full_recompute', 'queued', '{}', 'queued')
  `).run();
  store.close();
  const worker = new RecomputeWorker(databasePath);
  const surface = worker as unknown as RecomputeWorkerTestSurface;
  let holdFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolvePromise) => {
    holdFirst = resolvePromise;
  });
  let attempts = 0;
  surface.runOneInWorkerThread = async () => {
    attempts += 1;
    if (attempts === 1) {
      await firstGate;
      return false;
    }
    return false;
  };
  try {
    worker.schedule();
    await waitFor(() => attempts === 1);
    worker.schedule();
    assert.equal(surface.scheduled, true);
    holdFirst();
    await waitFor(() => attempts === 2);
    await waitFor(() => !worker.isRunning);
    assert.equal(attempts, 2);
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recompute worker fails a claimed job and its child runs after bounded retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-fail-claimed-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  const jobId = "recompute_job_claimed_retry_failure";
  store.database.prepare(`
    INSERT INTO recompute_jobs (id, job_type, status, request_json, progress_phase)
    VALUES (?, 'full_recompute', 'queued', '{}', 'queued')
  `).run(jobId);
  store.close();
  const worker = new RecomputeWorker(databasePath);
  const surface = worker as unknown as RecomputeWorkerTestSurface;
  let attempts = 0;
  surface.runOneInWorkerThread = async () => {
    attempts += 1;
    const database = new DatabaseSync(databasePath);
    try {
      const jobs = new RecomputeJobRepository(database);
      const job = jobs.claimNext();
      assert.equal(job?.id, jobId);
      const featureRunId = `feature_run_claimed_${attempts}`;
      database.prepare(`
        INSERT INTO feature_runs (
          id, dataset_version, canonical_contract_version, feature_schema_version,
          feature_config_json, feature_config_hash, status
        ) VALUES (?, 'dataset-1', 'canonical-health-v1', 'v1', '{}', 'hash', 'running')
      `).run(featureRunId);
      jobs.setRunIds(jobId, featureRunId, null);
      throw new Error("fixture crash after claim");
    } finally {
      database.close();
    }
  };
  try {
    worker.schedule();
    await waitFor(() => attempts === 3);
    await waitFor(() => !worker.isRunning);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const job = database.prepare(`
        SELECT status, cancel_requested AS cancelRequested, error_json AS errorJson
        FROM recompute_jobs WHERE id = ?
      `).get(jobId) as { status: string; cancelRequested: number; errorJson: string | null };
      assert.equal(job.status, "failed");
      assert.equal(job.cancelRequested, 0);
      assert.match(job.errorJson ?? "", /fixture crash after claim/);
      const child = database.prepare(`
        SELECT status FROM feature_runs WHERE id = 'feature_run_claimed_3'
      `).get() as { status: string };
      assert.equal(child.status, "failed");
    } finally {
      database.close();
    }
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("prediction worker retry delay backs off exponentially and caps at thirty seconds", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(predictionModelWorkerRetryDelay),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
  );
});

test("prediction worker reports main database corruption to its observer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-corruption-observer-"));
  const databasePath = join(root, "rai.sqlite");
  writeFileSync(databasePath, "not a sqlite database");
  const observedErrors: unknown[] = [];
  const worker = new PredictionModelWorker(
    databasePath,
    root,
    root,
    undefined,
    (error) => { observedErrors.push(error); }
  );
  try {
    worker.schedule();
    await waitFor(() => observedErrors.length > 0);
    assert.match(String(observedErrors[0]), /not a database|malformed|corrupt/i);
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recompute worker run completes only after its thread releases database resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-thread-close-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  store.close();
  const worker = new RecomputeWorker(databasePath);
  const surface = worker as unknown as RecomputeWorkerTestSurface;
  try {
    assert.equal(await surface.runOneInWorkerThread(), false);
    assert.equal(surface.activeWorker, null);
    await worker.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function seedCanonical(path: string): Promise<RaiDatabase> {
  const store = await RaiDatabase.open(path);
  store.database.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES ('dataset_version', 'worker_fixture')").run();
  for (let index = 0; index < 8; index += 1) {
    const workoutId = `worker_workout_${index}`;
    const sessionId = `worker_session_${index}`;
    const start = runDate(index);
    const end = new Date(Date.parse(start) + 1_800_000).toISOString();
    store.database.prepare(`
      INSERT INTO workouts (
        id, activity_type, source_name, source_category, start_at, end_at,
        duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical
      ) VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture', 'apple_watch', ?, ?, 1800, 0, '{}', '{}', 1)
    `).run(workoutId, start, end);
    store.database.prepare(`
      INSERT INTO workout_statistics (workout_id, ordinal, type, unit, sum_value)
      VALUES (?, 0, 'HKQuantityTypeIdentifierDistanceWalkingRunning', 'km', 5)
    `).run(workoutId);
    store.database.prepare(`
      INSERT INTO workout_statistics (workout_id, ordinal, type, unit, average_value, minimum_value, maximum_value)
      VALUES (?, 1, 'HKQuantityTypeIdentifierHeartRate', 'count/min', 145, 125, 170)
    `).run(workoutId);
    store.database.prepare(`
      INSERT INTO training_sessions (
        id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status
      ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 5, ?, 'active')
    `).run(sessionId, start, end, workoutId);
  }
  return store;
}

function marker(path: string, value?: string): string {
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE IF NOT EXISTS marker (value TEXT NOT NULL)");
    if (value !== undefined) {
      database.exec("DELETE FROM marker");
      database.prepare("INSERT INTO marker (value) VALUES (?)").run(value);
    }
    const row = database.prepare("SELECT value FROM marker LIMIT 1").get() as { value: string };
    return row.value;
  } finally {
    database.close();
  }
}

test("activates a staged database only after preserving the current database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-worker-"));
  const databasePath = join(root, "var", "rai.sqlite");
  const stagingPath = join(root, "var", "rai.staging.sqlite");
  mkdirSync(join(root, "var"));
  marker(databasePath, "current-database");
  marker(stagingPath, "staged-database");
  const worker = new ImportWorker(databasePath, root) as unknown as ImportWorkerTestSurface;
  try {
    await worker.activateDatabase(stagingPath, "fixture-job");
    assert.equal(marker(databasePath), "staged-database");
    assert.equal(marker(join(root, "var", "backups", "rai.before-web-import.fixture-job.sqlite")), "current-database");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the current database active when sidecar cleanup fails before import activation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-sidecar-failure-"));
  const databasePath = join(root, "var", "rai.sqlite");
  const stagingPath = join(root, "var", "rai.staging.sqlite");
  mkdirSync(join(root, "var"));
  marker(databasePath, "current-database");
  marker(stagingPath, "staged-database");
  const gateEvents: string[] = [];
  const worker = new ImportWorker(
    databasePath,
    root,
    root,
    () => { gateEvents.push("closed"); },
    () => { gateEvents.push(`opened:${marker(databasePath)}`); }
  ) as unknown as ImportWorkerTestSurface;
  const removeDatabaseFile = worker.removeDatabaseFile.bind(worker);
  worker.removeDatabaseFile = async (path) => {
    if (path === `${databasePath}-wal`) throw new Error("simulated sidecar deletion failure");
    await removeDatabaseFile(path);
  };
  try {
    await assert.rejects(
      worker.activateDatabase(stagingPath, "sidecar-failure"),
      /simulated sidecar deletion failure/
    );
    assert.equal(marker(databasePath), "current-database");
    assert.equal(marker(stagingPath), "staged-database");
    assert.deepEqual(gateEvents, ["closed", "opened:current-database"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not release an import activation gate that beforeActivate failed to acquire", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-before-gate-"));
  const databasePath = join(root, "rai.sqlite");
  const stagingPath = join(root, "rai.staging.sqlite");
  marker(databasePath, "current-database");
  marker(stagingPath, "staged-database");
  let releaseAttempts = 0;
  const worker = new ImportWorker(
    databasePath,
    root,
    root,
    () => { throw new Error("simulated beforeActivate failure"); },
    () => {
      releaseAttempts += 1;
      if (releaseAttempts === 1) throw new Error("simulated transient gate release failure");
    }
  ) as unknown as ImportWorkerTestSurface;
  try {
    await assert.rejects(
      worker.activateDatabase(stagingPath, "before-gate-failure"),
      /simulated beforeActivate failure/
    );
    assert.equal(releaseAttempts, 0);
    assert.equal(marker(databasePath), "current-database");
    assert.equal(marker(stagingPath), "staged-database");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a readable candidate active when candidate installation and rollback movement fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-install-rollback-"));
  const databasePath = join(root, "var", "rai.sqlite");
  const stagingPath = join(root, "var", "rai.staging.sqlite");
  mkdirSync(join(root, "var"));
  marker(databasePath, "current-database");
  marker(stagingPath, "staged-database");
  const gateEvents: string[] = [];
  const worker = new ImportWorker(
    databasePath,
    root,
    root,
    () => { gateEvents.push("closed"); },
    () => { gateEvents.push(`opened:${marker(databasePath)}`); }
  ) as unknown as ImportWorkerTestSurface;
  worker.installDatabase = async (source, destination) => {
    await rename(source, destination);
    throw new Error("simulated post-install failure");
  };
  const moveDatabaseFile = worker.moveDatabaseFile.bind(worker);
  worker.moveDatabaseFile = async (source, destination) => {
    if (source.includes("import-rollback")) throw new Error("simulated rollback movement failure");
    await moveDatabaseFile(source, destination);
  };
  try {
    await assert.rejects(
      worker.activateDatabase(stagingPath, "install-rollback-failure"),
      (error: unknown) => error instanceof AggregateError &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "simulated post-install failure") &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "simulated rollback movement failure")
    );
    assert.equal(marker(databasePath), "staged-database");
    assert.deepEqual(gateEvents, ["closed", "opened:staged-database"]);
    const backups = await new DatabaseMaintenance(databasePath, root).listBackups();
    assert.ok(backups.some((entry) => /^rai\.import-rollback\..+\.sqlite$/.test(entry.name)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a readable candidate active when rollback movement and backup copy both fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-double-rollback-failure-"));
  const databasePath = join(root, "var", "rai.sqlite");
  const stagingPath = join(root, "var", "rai.staging.sqlite");
  mkdirSync(join(root, "var"));
  marker(databasePath, "current-database");
  marker(stagingPath, "staged-database");
  const gateEvents: string[] = [];
  const worker = new ImportWorker(
    databasePath,
    root,
    root,
    () => { gateEvents.push("closed"); },
    () => { gateEvents.push(`opened:${marker(databasePath)}`); }
  ) as unknown as ImportWorkerTestSurface;
  worker.installDatabase = async (source, destination) => {
    await rename(source, destination);
    throw new Error("simulated post-install failure");
  };
  const moveDatabaseFile = worker.moveDatabaseFile.bind(worker);
  worker.moveDatabaseFile = async (source, destination) => {
    if (source.includes("import-rollback")) throw new Error("simulated rollback movement failure");
    await moveDatabaseFile(source, destination);
  };
  try {
    await assert.rejects(
      worker.activateDatabase(stagingPath, "double-rollback-failure", join(root, "missing-backup.sqlite")),
      (error: unknown) => error instanceof AggregateError &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "simulated post-install failure") &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "simulated rollback movement failure")
    );
    assert.equal(marker(databasePath), "staged-database");
    assert.deepEqual(gateEvents, ["closed", "opened:staged-database"]);
    const backups = await new DatabaseMaintenance(databasePath, root).listBackups();
    assert.ok(backups.some((entry) => /^rai\.import-rollback\..+\.sqlite$/.test(entry.name)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removes an unreadable candidate before restoring the rollback on Windows", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-unreadable-candidate-"));
  const databasePath = join(root, "var", "rai.sqlite");
  const stagingPath = join(root, "var", "rai.staging.sqlite");
  mkdirSync(join(root, "var"));
  marker(databasePath, "current-database");
  marker(stagingPath, "staged-database");
  const gateEvents: string[] = [];
  const worker = new ImportWorker(
    databasePath,
    root,
    root,
    () => { gateEvents.push("closed"); },
    () => { gateEvents.push(`opened:${marker(databasePath)}`); }
  ) as unknown as ImportWorkerTestSurface;
  worker.installDatabase = async (source, destination) => {
    await rename(source, destination);
    writeFileSync(destination, "not a sqlite database");
  };
  const moveDatabaseFile = worker.moveDatabaseFile.bind(worker);
  worker.moveDatabaseFile = async (source, destination) => {
    if (source.includes("import-rollback") && existsSync(destination)) {
      throw Object.assign(new Error("Windows cannot replace an existing database"), { code: "EEXIST" });
    }
    await moveDatabaseFile(source, destination);
  };
  try {
    await assert.rejects(
      worker.activateDatabase(stagingPath, "unreadable-candidate"),
      /Imported database is not readable after activation/
    );
    assert.equal(marker(databasePath), "current-database");
    assert.deepEqual(gateEvents, ["closed", "opened:current-database"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregates rollback movement and online backup copy failures for an unreadable candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-unreadable-recovery-failure-"));
  const databasePath = join(root, "var", "rai.sqlite");
  const stagingPath = join(root, "var", "rai.staging.sqlite");
  mkdirSync(join(root, "var"));
  marker(databasePath, "current-database");
  marker(stagingPath, "staged-database");
  const gateEvents: string[] = [];
  const worker = new ImportWorker(
    databasePath,
    root,
    root,
    () => { gateEvents.push("closed"); },
    () => { gateEvents.push("opened"); }
  ) as unknown as ImportWorkerTestSurface;
  worker.installDatabase = async (source, destination) => {
    await rename(source, destination);
    writeFileSync(destination, "not a sqlite database");
  };
  const moveDatabaseFile = worker.moveDatabaseFile.bind(worker);
  worker.moveDatabaseFile = async (source, destination) => {
    if (source.includes("import-rollback")) throw new Error("simulated rollback movement failure");
    await moveDatabaseFile(source, destination);
  };
  worker.copyDatabaseFile = async () => {
    throw new Error("simulated online backup copy failure");
  };
  try {
    await assert.rejects(
      worker.activateDatabase(stagingPath, "unreadable-recovery-failure"),
      (error: unknown) => error instanceof AggregateError &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "simulated rollback movement failure") &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "simulated online backup copy failure") &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "Import rollback did not restore a readable active database")
    );
    assert.equal(existsSync(databasePath), false);
    assert.deepEqual(gateEvents, ["closed"]);
    const backups = await new DatabaseMaintenance(databasePath, root).listBackups();
    assert.ok(backups.some((entry) => /^rai\.import-rollback\..+\.sqlite$/.test(entry.name)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["partial-copy", "validation", "move"] as const) {
  test(`does not expose an active database when online backup ${failure} fails`, async () => {
    const root = mkdtempSync(join(tmpdir(), `rai-import-atomic-backup-${failure}-`));
    const databasePath = join(root, "var", "rai.sqlite");
    const stagingPath = join(root, "var", "rai.staging.sqlite");
    mkdirSync(join(root, "var"));
    marker(databasePath, "current-database");
    marker(stagingPath, "staged-database");
    const gateEvents: string[] = [];
    const worker = new ImportWorker(
      databasePath,
      root,
      root,
      () => { gateEvents.push("closed"); },
      () => { gateEvents.push("opened"); }
    ) as unknown as ImportWorkerTestSurface;
    worker.installDatabase = async () => {
      throw new Error("simulated pre-install failure");
    };
    const moveDatabaseFile = worker.moveDatabaseFile.bind(worker);
    worker.moveDatabaseFile = async (source, destination) => {
      if (source.includes("import-rollback")) {
        throw new Error("simulated rollback movement failure");
      }
      if (failure === "move" && source.includes("import-backup-restore")) {
        throw new Error("simulated online backup installation failure");
      }
      await moveDatabaseFile(source, destination);
    };
    if (failure === "partial-copy") {
      worker.copyDatabaseFile = async (_source, destination) => {
        writeFileSync(destination, "partial sqlite data");
        throw new Error("simulated partial online backup copy failure");
      };
    } else if (failure === "validation") {
      worker.copyDatabaseFile = async (_source, destination) => {
        writeFileSync(destination, "not a sqlite database");
      };
    }
    try {
      await assert.rejects(
        worker.activateDatabase(stagingPath, `atomic-backup-${failure}`),
        (error: unknown) => error instanceof AggregateError &&
          error.errors.some((cause) => cause instanceof Error && cause.message === "simulated rollback movement failure") &&
          error.errors.some((cause) => cause instanceof Error && (
            failure === "partial-copy"
              ? cause.message === "simulated partial online backup copy failure"
              : failure === "validation"
                ? cause.message === "Online import backup is not readable before restoration"
                : cause.message === "simulated online backup installation failure"
          ))
      );
      assert.equal(existsSync(databasePath), false);
      assert.deepEqual(gateEvents, ["closed"]);
      assert.deepEqual(
        readdirSync(join(root, "var")).filter((name) => name.includes("import-backup-restore")),
        [],
      );
      const backups = await new DatabaseMaintenance(databasePath, root).listBackups();
      assert.ok(backups.some((entry) => /^rai\.import-rollback\..+\.sqlite$/.test(entry.name)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("restores the online backup when installation leaves no active database and rollback movement fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-backup-fallback-"));
  const databasePath = join(root, "var", "rai.sqlite");
  const stagingPath = join(root, "var", "rai.staging.sqlite");
  mkdirSync(join(root, "var"));
  marker(databasePath, "current-database");
  marker(stagingPath, "staged-database");
  const gateEvents: string[] = [];
  const worker = new ImportWorker(
    databasePath,
    root,
    root,
    () => { gateEvents.push("closed"); },
    () => { gateEvents.push(`opened:${marker(databasePath)}`); }
  ) as unknown as ImportWorkerTestSurface;
  worker.installDatabase = async () => {
    throw new Error("simulated pre-install failure");
  };
  const moveDatabaseFile = worker.moveDatabaseFile.bind(worker);
  worker.moveDatabaseFile = async (source, destination) => {
    if (source.includes("import-rollback")) throw new Error("simulated rollback movement failure");
    await moveDatabaseFile(source, destination);
  };
  try {
    await assert.rejects(
      worker.activateDatabase(stagingPath, "backup-fallback"),
      (error: unknown) => error instanceof AggregateError &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "simulated pre-install failure") &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "simulated rollback movement failure")
    );
    assert.equal(marker(databasePath), "current-database");
    assert.deepEqual(gateEvents, ["closed", "opened:current-database"]);
    const backups = await new DatabaseMaintenance(databasePath, root).listBackups();
    assert.ok(backups.some((entry) => /^rai\.import-rollback\..+\.sqlite$/.test(entry.name)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaves a committed rollback cleanup failure as a listed backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-rollback-cleanup-"));
  const databasePath = join(root, "var", "rai.sqlite");
  const stagingPath = join(root, "var", "rai.staging.sqlite");
  mkdirSync(join(root, "var"));
  marker(databasePath, "current-database");
  marker(stagingPath, "staged-database");
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  const removeDatabaseFile = worker.removeDatabaseFile.bind(worker);
  worker.removeDatabaseFile = async (path) => {
    if (path.includes("rai.import-rollback.")) {
      throw Object.assign(new Error("simulated rollback cleanup failure"), { code: "EPERM" });
    }
    await removeDatabaseFile(path);
  };
  try {
    await worker.activateDatabase(stagingPath, "cleanup-failure");
    assert.equal(marker(databasePath), "staged-database");
    const backups = await new DatabaseMaintenance(databasePath, root).listBackups();
    const rollback = backups.find((entry) => /^rai\.import-rollback\..+\.sqlite$/.test(entry.name));
    assert.ok(rollback);
    assert.equal(marker(join(root, "var", "backups", rollback.name)), "current-database");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not expose a partial import backup when SQLite backup fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-backup-failure-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  marker(databasePath, "current-database");
  const worker = new ImportWorker(databasePath, root) as unknown as ImportWorkerTestSurface;
  worker.backupDatabase = async (_database, destination) => {
    writeFileSync(destination, "incomplete backup", "utf8");
    throw new Error("injected backup failure");
  };
  const backupDirectory = join(root, "var", "backups");
  const backupPath = join(backupDirectory, "rai.before-web-import.failed-job.sqlite");
  try {
    await assert.rejects(worker.createCurrentBackup("failed-job"), /injected backup failure/);
    assert.equal(existsSync(backupPath), false);
    assert.deepEqual(readdirSync(backupDirectory), []);
    assert.equal(marker(databasePath), "current-database");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retries transient Windows errors while removing a partial import backup", async () => {
  for (const busyFailures of [1, 3]) {
    const root = mkdtempSync(join(tmpdir(), "rai-import-backup-cleanup-retry-"));
    const databasePath = join(root, "var", "rai.sqlite");
    mkdirSync(join(root, "var"));
    marker(databasePath, "current-database");
    const worker = new ImportWorker(databasePath, root) as unknown as ImportWorkerTestSurface;
    const backupError = new Error("injected backup failure");
    worker.backupDatabase = async (_database, destination) => {
      writeFileSync(destination, "incomplete backup", "utf8");
      throw backupError;
    };
    let cleanupAttempts = 0;
    worker.removePartialBackupFile = async (path) => {
      cleanupAttempts += 1;
      if (cleanupAttempts <= busyFailures) {
        throw Object.assign(new Error("partial backup is busy"), { code: "EBUSY" });
      }
      await rm(path, { force: true });
    };
    const backupDirectory = join(root, "var", "backups");
    try {
      let rejected: unknown;
      try {
        await worker.createCurrentBackup(`transient-cleanup-${busyFailures}`);
      } catch (error) {
        rejected = error;
      }
      assert.equal(rejected, backupError);
      assert.equal(cleanupAttempts, busyFailures + 1);
      assert.deepEqual(readdirSync(backupDirectory), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("preserves the backup error when partial cleanup remains locked", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-backup-cleanup-failure-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  marker(databasePath, "current-database");
  const worker = new ImportWorker(databasePath, root) as unknown as ImportWorkerTestSurface;
  const backupError = new Error("injected backup failure");
  const cleanupError = Object.assign(new Error("partial backup remains locked"), { code: "EPERM" });
  worker.backupDatabase = async (_database, destination) => {
    writeFileSync(destination, "incomplete backup", "utf8");
    throw backupError;
  };
  let cleanupAttempts = 0;
  worker.removePartialBackupFile = async () => {
    cleanupAttempts += 1;
    throw cleanupError;
  };
  const backupDirectory = join(root, "var", "backups");
  try {
    let rejected: unknown;
    try {
      await worker.createCurrentBackup("persistent-cleanup");
    } catch (error) {
      rejected = error;
    }
    assert.equal(rejected, backupError);
    assert.equal((rejected as { cleanupError?: unknown }).cleanupError, cleanupError);
    assert.equal(cleanupAttempts, 5);
    assert.equal(readdirSync(backupDirectory).length, 1);
    assert.match(readdirSync(backupDirectory)[0] ?? "", /^rai\.before-web-import\.persistent-cleanup\.sqlite\.partial-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads the whole database for the backup before running the integrity check", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-backup-order-"));
  const databasePath = join(root, "rai.sqlite");
  marker(databasePath, "current-database");
  const worker = new ImportWorker(databasePath, root) as unknown as ImportWorkerTestSurface;
  const events: string[] = [];
  const backupDatabase = worker.backupDatabase.bind(worker);
  const isReadableDatabase = worker.isReadableDatabase.bind(worker);
  worker.backupDatabase = async (database, destination) => {
    events.push("backup");
    await backupDatabase(database, destination);
  };
  worker.isReadableDatabase = (path) => {
    events.push("quick_check");
    return isReadableDatabase(path);
  };
  const backupPath = join(root, "var", "backups", "rai.before-web-import.backup-order.sqlite");
  try {
    assert.equal(await worker.createCurrentBackup("backup-order"), backupPath);
    // `backup()` 必须先跑完：它按页顺序把整库读一遍，页缓存因此变热，紧随其后的
    // `PRAGMA quick_check` 才是热态（云机真机受控实测：冷 11,993 ms → 热 260 ms）。
    // 顺序一旦调回「先校验再备份」，这条断言立刻变红。
    assert.deepEqual(events, ["backup", "quick_check"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("never publishes a safety backup from a database that fails its integrity check after the copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-backup-after-copy-"));
  const databasePath = join(root, "rai.sqlite");
  marker(databasePath, "current-database");
  const observedErrors: unknown[] = [];
  const worker = new ImportWorker(
    databasePath,
    root,
    root,
    undefined,
    undefined,
    (error) => { observedErrors.push(error); }
  ) as unknown as ImportWorkerTestSurface;
  // 关键场景：`backup()` 成功（坏页没被读到，例如落在 freelist），但完整性校验不通过。
  // 那份刚写好的副本**绝不能**以 `rai.before-web-import.<jobId>.sqlite` 的名字留下来 ——
  // 备份列表会把它当成可回滚点，而它抄的是一份损坏的主库。
  worker.isReadableDatabase = () => false;
  const backupDirectory = join(root, "var", "backups");
  const backupPath = join(backupDirectory, "rai.before-web-import.corrupt-after-copy.sqlite");
  try {
    assert.equal(await worker.createCurrentBackup("corrupt-after-copy"), null);
    assert.equal(existsSync(backupPath), false);
    assert.deepEqual(readdirSync(backupDirectory), []);
    assert.equal(observedErrors.length, 1);
    assert.match(String(observedErrors[0]), /database.*corrupt/i);
    assert.equal(
      readdirSync(join(root, "var", "quarantine")).filter((name) => name.endsWith(".sqlite")).length,
      1
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns a published import safety backup when retention cleanup fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-backup-retention-failure-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  store.close();
  const worker = new ImportWorker(databasePath, root) as unknown as ImportWorkerTestSurface;
  const original = DatabaseMaintenance.prototype.enforceBackupPolicy;
  DatabaseMaintenance.prototype.enforceBackupPolicy = async () => {
    throw Object.assign(new Error("retention target is locked"), { code: "EBUSY" });
  };
  try {
    const backupPath = await worker.createCurrentBackup("retention-failure");
    assert.ok(backupPath);
    assert.equal(existsSync(backupPath ?? ""), true);
    const backup = new DatabaseSync(backupPath ?? "", { readOnly: true });
    try {
      assert.equal(backup.prepare("PRAGMA quick_check").get() !== undefined, true);
    } finally {
      backup.close();
    }
  } finally {
    DatabaseMaintenance.prototype.enforceBackupPolicy = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves a corrupt active database and starts import from a fresh database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-corrupt-active-"));
  const databasePath = join(root, "rai.sqlite");
  const corrupt = Buffer.from("not a sqlite database");
  writeFileSync(databasePath, corrupt);
  const observedErrors: unknown[] = [];
  const worker = new ImportWorker(
    databasePath,
    root,
    root,
    undefined,
    undefined,
    (error) => { observedErrors.push(error); }
  ) as unknown as ImportWorkerTestSurface;
  try {
    assert.equal(await worker.createCurrentBackup("corrupt-active"), null);
    assert.equal(observedErrors.length, 1);
    assert.match(String(observedErrors[0]), /database.*corrupt/i);
    const quarantineDirectory = join(root, "var", "quarantine");
    const backupName = readdirSync(quarantineDirectory).find((name) => name.includes("corrupt-active-corrupt") && name.endsWith(".sqlite"));
    assert.ok(backupName);
    assert.deepEqual(readFileSync(join(quarantineDirectory, backupName)), corrupt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quarantines a corrupt active database only once across import and activation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-corrupt-run-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"), { recursive: true });
  writeFileSync(databasePath, "not a sqlite database");
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  let commandCount = 0;
  worker.command = async (args) => {
    commandCount += 1;
    if (commandCount !== 1) return;
    const databaseArgument = args.indexOf("--database");
    const stagingPath = args[databaseArgument + 1];
    assert.ok(stagingPath);
    const staging = await seedCanonical(stagingPath);
    staging.close();
  };
  worker.stageAuditReports = () => ({
    commit() {}, rollback() {}, finalize() {}, discard() {}
  });
  const job: Record<string, unknown> = {
    id: "web_import_corrupt_once",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  };
  try {
    await worker.run(job);
    assert.equal(job.status, "succeeded");
    assert.equal(commandCount, 2);
    assert.equal(
      readdirSync(join(root, "var", "quarantine"))
        .filter((name) => name.endsWith(".sqlite")).length,
      1
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects activation when the staged database is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-worker-"));
  const databasePath = join(root, "rai.sqlite");
  marker(databasePath, "current-database");
  const worker = new ImportWorker(databasePath, root) as unknown as ImportWorkerTestSurface;
  try {
    await assert.rejects(worker.activateDatabase(join(root, "missing.sqlite"), "missing-job"));
    assert.equal(marker(databasePath), "current-database");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves overrides and immutable model history before recomputing an imported database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-history-"));
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const previous = await seedCanonical(previousPath);
  const staging = await seedCanonical(stagingPath);
  try {
    const service = new RaiApplicationService(previous);
    service.enqueueFullRecompute({ evaluatedAt: runDate(8), timezoneIdentifier: "UTC" });
    assert.equal(service.runNextJob()?.status, "succeeded");
    previous.database.prepare(`
      INSERT INTO workout_overrides (
        id, training_session_id, revision, eligibility_override, session_type,
        rpe, condition_tags_json, note, performance_protocol, statistics_participation
      ) VALUES ('worker_override', 'worker_session_7', 1, NULL, 'easy', 6, '["状态良好"]', '保留我', 'five_k_time_trial', 'exclude')
    `).run();
    staging.database.exec(`
      INSERT INTO training_sessions (
        id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status, created_at, updated_at
      )
      SELECT 'replacement_session_7', activity_type, anchor_start_at, anchor_end_at,
        anchor_distance_km, canonical_workout_id, status, created_at, updated_at
      FROM training_sessions WHERE id = 'worker_session_7';
      DELETE FROM training_sessions WHERE id = 'worker_session_7';
    `);
    previous.close();
    staging.close();

    const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
    worker.preserveHistoricalState(stagingPath, previousPath);
    const merged = new DatabaseSync(stagingPath, { readOnly: true });
    try {
      assert.equal((merged.prepare("SELECT COUNT(*) AS count FROM workout_overrides").get() as { count: number }).count, 1);
      assert.equal((merged.prepare("SELECT COUNT(*) AS count FROM training_sessions WHERE id = 'worker_session_7'").get() as { count: number }).count, 1);
      assert.equal((merged.prepare("SELECT COUNT(*) AS count FROM training_sessions WHERE id = 'replacement_session_7'").get() as { count: number }).count, 0);
      assert.equal((merged.prepare("SELECT COUNT(*) AS count FROM feature_runs").get() as { count: number }).count, 1);
      assert.equal((merged.prepare("SELECT COUNT(*) AS count FROM model_runs").get() as { count: number }).count, 1);
      assert.equal((merged.prepare("SELECT COUNT(*) AS count FROM ability_assessments").get() as { count: number }).count, 8);
      assert.equal((merged.prepare("SELECT COUNT(*) AS count FROM training_metric_runs").get() as { count: number }).count, 1);
      assert.equal((merged.prepare("SELECT COUNT(*) AS count FROM workout_training_loads").get() as { count: number }).count, 8);
      assert.ok((merged.prepare("SELECT COUNT(*) AS count FROM daily_zone_profiles").get() as { count: number }).count > 0);
      assert.equal((merged.prepare("SELECT COUNT(*) AS count FROM workout_zone_summaries").get() as { count: number }).count, 8);
      assert.ok((merged.prepare("SELECT COUNT(*) AS count FROM daily_training_metrics").get() as { count: number }).count > 0);
      assert.equal((merged.prepare("SELECT COUNT(*) AS count FROM active_model_run").get() as { count: number }).count, 0);
      assert.equal((merged.prepare("SELECT note FROM workout_overrides WHERE id = 'worker_override'").get() as { note: string }).note, "保留我");
      assert.equal((merged.prepare("SELECT performance_protocol AS protocol FROM workout_overrides WHERE id = 'worker_override'").get() as { protocol: string }).protocol, "five_k_time_trial");
      assert.equal((merged.prepare("SELECT statistics_participation AS participation FROM workout_overrides WHERE id = 'worker_override'").get() as { participation: string }).participation, "exclude");
    } finally {
      merged.close();
    }
  } finally {
    try { previous.close(); } catch { /* Already closed. */ }
    try { staging.close(); } catch { /* Already closed. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("copies v15 prediction history without restoring an unfingerprinted active model", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-v15-prediction-history-"));
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const previous = await seedCanonical(previousPath);
  const staging = await seedCanonical(stagingPath);
  const runId = "prediction_model_11111111-1111-1111-1111-111111111111";
  try {
    previous.database.prepare(`
      INSERT INTO prediction_model_runs (
        id, algorithm, model_version, feature_schema_version, ability_baseline_hash,
        training_data_through_at, hyperparameters_json, request_json, status
      ) VALUES (?, 'catboost', 'catboost_v1', 'race_residual_features_v1',
        'legacy-fingerprint', ?, '{}', '{}', 'succeeded')
    `).run(runId, runDate(8));
    previous.database.prepare(`
      INSERT INTO active_prediction_model (singleton, prediction_model_run_id) VALUES (1, ?)
    `).run(runId);
    previous.database.exec("ALTER TABLE prediction_model_runs DROP COLUMN ability_baseline_hash");
    previous.close();
    staging.close();

    const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
    worker.preserveHistoricalState(stagingPath, previousPath);
    const merged = new DatabaseSync(stagingPath, { readOnly: true });
    try {
      const copied = merged.prepare(`
        SELECT ability_baseline_hash AS abilityBaselineHash
        FROM prediction_model_runs WHERE id = ?
      `).get(runId) as { abilityBaselineHash: string | null };
      assert.equal(copied.abilityBaselineHash, null);
      assert.equal(
        (merged.prepare("SELECT COUNT(*) AS count FROM active_prediction_model").get() as { count: number }).count,
        0
      );
    } finally {
      merged.close();
    }
  } finally {
    try { previous.close(); } catch { /* Already closed. */ }
    try { staging.close(); } catch { /* Already closed. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("restores historical prediction activation only for the current ability run identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-prediction-identity-"));
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const previous = await seedCanonical(previousPath);
  const staging = await seedCanonical(stagingPath);
  const runId = "prediction_model_22222222-2222-2222-2222-222222222222";
  try {
    for (const store of [previous, staging]) {
      const service = new RaiApplicationService(store);
      service.enqueueFullRecompute({ evaluatedAt: runDate(8), timezoneIdentifier: "UTC" });
      assert.equal(service.runNextJob()?.status, "succeeded");
    }
    const previousHash = currentAbilityBaselineHash(previous.database);
    const stagingHash = currentAbilityBaselineHash(staging.database);
    assert.ok(previousHash);
    assert.ok(stagingHash);
    assert.notEqual(previousHash, stagingHash, "separate model run identities must change the fingerprint");
    previous.database.prepare(`
      INSERT INTO prediction_model_runs (
        id, algorithm, model_version, feature_schema_version, ability_baseline_hash,
        training_data_through_at, hyperparameters_json, request_json, status
      ) VALUES (?, 'catboost', 'catboost_v1', 'race_residual_features_v1', ?, ?, '{}', '{}', 'succeeded')
    `).run(runId, previousHash, runDate(8));
    previous.database.prepare(`
      INSERT INTO active_prediction_model (singleton, prediction_model_run_id) VALUES (1, ?)
    `).run(runId);
    previous.close();
    staging.close();

    const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
    worker.preserveHistoricalState(stagingPath, previousPath);
    let merged = new DatabaseSync(stagingPath);
    try {
      assert.equal(
        (merged.prepare("SELECT COUNT(*) AS count FROM active_prediction_model").get() as { count: number }).count,
        0
      );
      merged.prepare("DELETE FROM prediction_model_runs WHERE id = ?").run(runId);
    } finally {
      merged.close();
    }

    const historical = new DatabaseSync(previousPath);
    try {
      historical.prepare(`
        UPDATE prediction_model_runs SET ability_baseline_hash = ? WHERE id = ?
      `).run(stagingHash, runId);
    } finally {
      historical.close();
    }
    worker.preserveHistoricalState(stagingPath, previousPath);
    merged = new DatabaseSync(stagingPath, { readOnly: true });
    try {
      const active = merged.prepare(`
        SELECT prediction_model_run_id AS runId FROM active_prediction_model WHERE singleton = 1
      `).get() as { runId: string };
      assert.equal(active.runId, runId);
    } finally {
      merged.close();
    }
  } finally {
    try { previous.close(); } catch { /* Already closed. */ }
    try { staging.close(); } catch { /* Already closed. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips recompute when the imported scoring dataset is unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-diff-"));
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const previous = await seedCanonical(previousPath);
  const staging = await seedCanonical(stagingPath);
  previous.close();
  staging.close();
  try {
    const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
    const change = worker.analyzeDatasetChange(stagingPath, previousPath);
    assert.equal(change.mode, "unchanged");
    assert.equal(change.insertedWorkouts, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses the import change ledger to classify scoring health changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-ledger-diff-"));
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const previous = await seedCanonical(previousPath);
  const staging = await seedCanonical(stagingPath);
  const batchId = "web_import_ledger_diff";
  staging.database.prepare(`
    INSERT INTO import_batches (id, xml_sha256, status, import_mode, summary_json)
    VALUES (?, 'hash', 'succeeded', 'incremental', '{}')
  `).run(batchId);
  staging.database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric,
      start_at, end_at, metadata_json, raw_attributes_json
    ) VALUES ('ledger_hr', ?, 'Fixture', 'apple_watch', 'count/min', 150, ?, ?, '{}', '{}')
  `).run(healthTypes.heartRate, runDate(7), runDate(7));
  staging.database.prepare(`
    INSERT INTO import_entity_changes (
      batch_id, entity_kind, entity_id, change_type, effective_at, content_hash
    ) VALUES (?, 'record', 'ledger_hr', 'inserted', ?, 'hash')
  `).run(batchId, runDate(7));
  previous.close();
  staging.close();
  try {
    const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
    assert.equal(worker.analyzeDatasetChange(stagingPath, previousPath, batchId).mode, "full");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ["inserted", "removed"] as const) {
  test(`uses full recompute when a running-speed health record is ${operation}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-import-diff-"));
    const previousPath = join(root, "previous.sqlite");
    const stagingPath = join(root, "staging.sqlite");
    const previous = await seedCanonical(previousPath);
    const staging = await seedCanonical(stagingPath);
    const target = operation === "inserted" ? staging : previous;
    target.database.prepare(`
      INSERT INTO health_records (
        id, type, source_name, source_category, unit, value_numeric,
        start_at, end_at, metadata_json, raw_attributes_json
      ) VALUES (
        'worker_running_speed', 'HKQuantityTypeIdentifierRunningSpeed',
        'Fixture', 'apple_watch', 'm/s', 3.5, ?, ?, '{}', '{}'
      )
    `).run(runDate(1), new Date(Date.parse(runDate(1)) + 10_000).toISOString());
    previous.close();
    staging.close();
    try {
      const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
      const change = worker.analyzeDatasetChange(stagingPath, previousPath);
      assert.equal(change.mode, "full");
      assert.equal(change.dirtyFromAt, null);
      assert.equal(change.insertedWorkouts, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const operation of ["inserted", "removed"] as const) {
  test(`uses full recompute when a VO2 max health record is ${operation}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-import-vo2-diff-"));
    const previousPath = join(root, "previous.sqlite");
    const stagingPath = join(root, "staging.sqlite");
    const previous = await seedCanonical(previousPath);
    const staging = await seedCanonical(stagingPath);
    const target = operation === "inserted" ? staging : previous;
    target.database.prepare(`
      INSERT INTO health_records (
        id, type, source_name, source_category, unit, value_numeric,
        start_at, end_at, metadata_json, raw_attributes_json
      ) VALUES (?, ?, 'Fixture', 'apple_watch', 'ml/kg*min', 52, ?, ?, '{}', '{}')
    `).run("worker_vo2_max", healthTypes.vo2Max, runDate(1), runDate(1));
    previous.close();
    staging.close();
    try {
      const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
      const change = worker.analyzeDatasetChange(stagingPath, previousPath);
      assert.equal(change.mode, "full");
      assert.equal(change.dirtyFromAt, null);
      assert.equal(change.insertedWorkouts, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("uses full recompute when a scoring health record is inserted", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-diff-"));
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const previous = await seedCanonical(previousPath);
  const staging = await seedCanonical(stagingPath);
  staging.database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric,
      start_at, end_at, metadata_json, raw_attributes_json
    ) VALUES (
      'worker_resting_heart_rate', 'HKQuantityTypeIdentifierRestingHeartRate',
      'Fixture', 'apple_watch', 'count/min', 52, ?, ?, '{}', '{}'
    )
  `).run(runDate(1), runDate(1));
  previous.close();
  staging.close();
  try {
    const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
    assert.equal(worker.analyzeDatasetChange(stagingPath, previousPath).mode, "full");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [beforeStatus, afterStatus] of [
  ["active", "ambiguous"],
  ["ambiguous", "active"],
  ["active", "inactive"],
] as const) {
  test(`uses incremental recompute when a training session changes from ${beforeStatus} to ${afterStatus}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-import-session-status-diff-"));
    const previousPath = join(root, "previous.sqlite");
    const stagingPath = join(root, "staging.sqlite");
    const previous = await seedCanonical(previousPath);
    const staging = await seedCanonical(stagingPath);
    previous.database.prepare("UPDATE training_sessions SET status = ? WHERE id = 'worker_session_0'")
      .run(beforeStatus);
    staging.database.prepare("UPDATE training_sessions SET status = ? WHERE id = 'worker_session_0'")
      .run(afterStatus);
    previous.close();
    staging.close();
    try {
      const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
      const change = worker.analyzeDatasetChange(stagingPath, previousPath);
      assert.equal(change.mode, "incremental");
      assert.equal(change.dirtyFromAt, runDate(0));
      assert.equal(change.insertedWorkouts, 0);
      assert.equal(change.updatedWorkouts, 1);
      assert.equal(change.unchangedWorkouts, 7);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("recomputes and activates a training session that becomes ambiguous (off)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-session-status-run-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  let commandCount = 0;
  worker.command = async (args) => {
    commandCount += 1;
    const databaseArgument = args.indexOf("--database");
    assert.ok(databaseArgument >= 0);
    const stagingPath = args[databaseArgument + 1];
    assert.ok(stagingPath);
    if (commandCount === 1) {
      const staging = new DatabaseSync(stagingPath);
      try {
        staging.prepare(`
          UPDATE training_sessions SET status = 'ambiguous'
          WHERE id = 'worker_session_0'
        `).run();
        staging.prepare(`
          INSERT INTO import_issues (severity, code, object_id, message)
          VALUES ('warning', 'AMBIGUOUS_TRAINING_SESSION_MATCH', 'worker_session_0',
            'A candidate workout group matched more than one existing training session.')
        `).run();
        staging.prepare(`
          UPDATE import_manifest SET value = 'worker_fixture_ambiguous'
          WHERE key = 'dataset_version'
        `).run();
      } finally {
        staging.close();
      }
      return;
    }
    assert.equal(commandCount, 2, "a training-session status change must invoke exactly one recompute");
    assert.ok(args.includes("recompute"));
    assert.equal(args.includes("--shadow-validate"), false, "the removed shadow flag must never be passed");
    const dirtyFromArgument = args.indexOf("--dirty-from");
    assert.ok(dirtyFromArgument >= 0);
    assert.equal(args[dirtyFromArgument + 1], runDate(0));
  };
  const job: Record<string, unknown> = {
    id: "web_import_session_became_ambiguous",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export"),
  };
  try {
    await worker.run(job);
    assert.equal(job.status, "succeeded", String(job.error ?? ""));
    assert.equal(commandCount, 2);
    const timing = job.performance as ImportJobPerformance;
    assert.equal(timing.validationMode, "not-run");
    for (const stage of ["backupCapacity", "backupCopy", "backupVerify", "stagingCopy", "parseImport",
      "changeAnalysis", "recompute", "activationAudit", "activationSwap", "cleanup"] as const) {
      assert.ok(timing.stagesMs[stage]! >= 0, `missing ${stage} duration`);
    }
    // 🔴 存在 ≠ 干过活：这两段各自都要动真数据（写整份备份副本 / 全库 PRAGMA quick_check），
    // 被记录成 0 就说明它们没被执行 —— 上面那条 `>= 0` 抓不到这种情况。
    for (const stage of ["backupCopy", "backupVerify"] as const) {
      assert.ok(timing.stagesMs[stage]! > 0, `${stage} was recorded but did no work`);
    }
    assert.ok(timing.totalMs >= Object.values(timing.stagesMs).reduce((sum, value) => sum + value, 0));
    assert.equal((job.summary as {
      importMode: string;
      updatedWorkouts: number;
      modelReplayFrom: string | null;
    }).importMode, "incremental");
    assert.equal((job.summary as { updatedWorkouts: number }).updatedWorkouts, 1);
    assert.equal((job.summary as { modelReplayFrom: string | null }).modelReplayFrom, runDate(0));
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((activated.prepare(`
        SELECT status FROM training_sessions WHERE id = 'worker_session_0'
      `).get() as { status: string }).status, "ambiguous");
      assert.equal((activated.prepare(`
        SELECT COUNT(*) AS count FROM import_issues
        WHERE code = 'AMBIGUOUS_TRAINING_SESSION_MATCH' AND object_id = 'worker_session_0'
      `).get() as { count: number }).count, 1);
    } finally {
      activated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const field of [
  "HKCharacteristicTypeIdentifierDateOfBirth",
  "HKCharacteristicTypeIdentifierBiologicalSex"
] as const) {
  test(`uses full recompute when profile field ${field} changes`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-import-profile-diff-"));
    const previousPath = join(root, "previous.sqlite");
    const stagingPath = join(root, "staging.sqlite");
    const previous = await seedCanonical(previousPath);
    const staging = await seedCanonical(stagingPath);
    const original = {
      HKCharacteristicTypeIdentifierDateOfBirth: "1990-01-01",
      HKCharacteristicTypeIdentifierBiologicalSex: "HKBiologicalSexMale"
    };
    previous.database.prepare("INSERT INTO profile (id, attributes_json) VALUES (1, ?)")
      .run(JSON.stringify(original));
    staging.database.prepare("INSERT INTO profile (id, attributes_json) VALUES (1, ?)")
      .run(JSON.stringify({
        ...original,
        [field]: field === "HKCharacteristicTypeIdentifierDateOfBirth"
          ? "1991-01-01"
          : "HKBiologicalSexFemale"
      }));
    previous.close();
    staging.close();
    try {
      const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
      const change = worker.analyzeDatasetChange(stagingPath, previousPath);
      assert.equal(change.mode, "full");
      assert.equal(change.dirtyFromAt, null);
      assert.equal(change.insertedWorkouts, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("recomputes and activates a changed profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-profile-full-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.database.prepare("INSERT INTO profile (id, attributes_json) VALUES (1, ?)")
    .run(JSON.stringify({ HKCharacteristicTypeIdentifierDateOfBirth: "1990-01-01" }));
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  let commandCount = 0;
  worker.command = async (args) => {
    commandCount += 1;
    const databaseArgument = args.indexOf("--database");
    assert.ok(databaseArgument >= 0);
    const stagingPath = args[databaseArgument + 1];
    assert.ok(stagingPath);
    if (commandCount === 1) {
      const staging = new DatabaseSync(stagingPath);
      try {
        staging.prepare("UPDATE profile SET attributes_json = ? WHERE id = 1")
          .run(JSON.stringify({ HKCharacteristicTypeIdentifierDateOfBirth: "1991-01-01" }));
      } finally {
        staging.close();
      }
      return;
    }
    assert.equal(commandCount, 2, "profile changes must invoke exactly one recompute");
    assert.ok(args.includes("recompute"));
  };
  const job: Record<string, unknown> = {
    id: "web_import_profile_full",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  };
  try {
    await worker.run(job);
    assert.equal(commandCount, 2);
    assert.equal(job.status, "succeeded", String(job.error ?? ""));
    assert.equal((job.summary as { importMode: string }).importMode, "full");
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = activated.prepare("SELECT attributes_json AS attributesJson FROM profile WHERE id = 1")
        .get() as { attributesJson: string };
      assert.deepEqual(JSON.parse(row.attributesJson), {
        HKCharacteristicTypeIdentifierDateOfBirth: "1991-01-01"
      });
    } finally {
      activated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const transition of ["missing-to-present", "present-to-missing", "value-change"] as const) {
  test(`recomputes from the first workout when the GPX fingerprint has a ${transition} transition`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-import-route-fingerprint-diff-"));
    const previousPath = join(root, "previous.sqlite");
    const stagingPath = join(root, "staging.sqlite");
    const previous = await seedCanonical(previousPath);
    const staging = await seedCanonical(stagingPath);
    if (transition !== "missing-to-present") {
      previous.database.prepare(`
        INSERT INTO import_manifest (key, value) VALUES ('source_gpx_bundle_sha256', 'old-gpx-hash')
      `).run();
    }
    if (transition !== "present-to-missing") {
      staging.database.prepare(`
        INSERT INTO import_manifest (key, value) VALUES ('source_gpx_bundle_sha256', 'new-gpx-hash')
      `).run();
    }
    if (transition === "missing-to-present") {
      staging.database.prepare(`
        INSERT INTO workout_routes (
          id, workout_id, source_category, relative_path, metadata_json,
          point_count, file_status
        ) VALUES ('worker_route_new', 'worker_workout_0', 'apple_watch',
          'routes/new.gpx', '{}', 2, 'imported')
      `).run();
    }
    previous.close();
    staging.close();
    try {
      const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
      const change = worker.analyzeDatasetChange(stagingPath, previousPath);
      assert.equal(change.mode, "incremental");
      assert.equal(change.dirtyFromAt, runDate(0));
      assert.equal(change.insertedWorkouts, 0);
      assert.equal(change.routesUpdated, transition === "missing-to-present" ? 1 : 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("preserve-absent GPX bundle hash change without fingerprint diffs does not dirty all sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-preserve-route-hash-"));
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const previous = await seedCanonical(previousPath);
  const staging = await seedCanonical(stagingPath);
  previous.database.prepare(`
    INSERT INTO import_manifest (key, value) VALUES ('source_gpx_bundle_sha256', 'old-gpx-hash')
  `).run();
  staging.database.prepare(`
    INSERT INTO import_manifest (key, value) VALUES ('source_gpx_bundle_sha256', 'subset-gpx-hash')
  `).run();
  previous.close();
  staging.close();
  try {
    const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
    const change = worker.analyzeDatasetChange(stagingPath, previousPath, undefined, true);
    assert.equal(change.mode, "unchanged");
    assert.equal(change.dirtyFromAt, null);
    assert.equal(change.insertedWorkouts, 0);
    assert.equal(change.routesUpdated, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("starts route recompute at the changed GPX workout instead of the first workout", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-route-granular-diff-"));
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const previous = await seedCanonical(previousPath);
  const staging = await seedCanonical(stagingPath);
  for (const [database, bundleHash, fileHash] of [
    [previous.database, "old-bundle", "old-file"],
    [staging.database, "new-bundle", "new-file"]
  ] as const) {
    database.prepare("INSERT INTO import_manifest (key, value) VALUES ('source_gpx_bundle_sha256', ?)").run(bundleHash);
    database.prepare(`
      INSERT INTO workout_routes (
        id, workout_id, source_category, relative_path, metadata_json, point_count, file_status
      ) VALUES ('worker_route_recent', 'worker_workout_7', 'apple_watch', 'routes/recent.gpx', '{}', 2, 'imported')
    `).run();
    database.prepare(`
      INSERT INTO route_file_fingerprints (
        relative_path, size_bytes, modified_at_ms, sha256, route_id, point_count
      ) VALUES ('routes/recent.gpx', 100, 1, ?, 'worker_route_recent', 2)
    `).run(fileHash);
  }
  previous.close();
  staging.close();
  try {
    const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
    const change = worker.analyzeDatasetChange(stagingPath, previousPath);
    assert.equal(change.mode, "incremental");
    assert.equal(change.dirtyFromAt, runDate(7));
    assert.equal(change.routesUpdated, 1);
    const preserveAbsentChange = worker.analyzeDatasetChange(stagingPath, previousPath, undefined, true);
    assert.equal(preserveAbsentChange.mode, "incremental");
    assert.equal(preserveAbsentChange.dirtyFromAt, runDate(7));
    assert.equal(preserveAbsentChange.routesUpdated, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recomputes and activates routes when an upgraded database gains its first GPX fingerprint", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-route-fingerprint-run-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  let commandCount = 0;
  worker.command = async (args) => {
    commandCount += 1;
    const databaseArgument = args.indexOf("--database");
    assert.ok(databaseArgument >= 0);
    const stagingPath = args[databaseArgument + 1];
    assert.ok(stagingPath);
    if (commandCount === 1) {
      const staging = new DatabaseSync(stagingPath);
      try {
        staging.prepare(`
          INSERT INTO import_manifest (key, value)
          VALUES ('source_gpx_bundle_sha256', 'first-gpx-hash')
        `).run();
        staging.prepare(`
          UPDATE import_manifest SET value = 'worker_fixture_with_routes'
          WHERE key = 'dataset_version'
        `).run();
        staging.prepare(`
          INSERT INTO workout_routes (
            id, workout_id, source_category, relative_path, metadata_json,
            point_count, file_status
          ) VALUES ('worker_route_new', 'worker_workout_0', 'apple_watch',
            'routes/new.gpx', '{}', 2, 'imported')
        `).run();
        staging.prepare(`
          INSERT INTO route_points (
            route_id, sequence, timestamp, latitude, longitude, elevation_meters,
            horizontal_accuracy_meters
          ) VALUES
            ('worker_route_new', 0, ?, 31.20, 121.40, 5, 4),
            ('worker_route_new', 1, ?, 31.21, 121.41, 15, 4)
        `).run(runDate(0), new Date(Date.parse(runDate(0)) + 60_000).toISOString());
      } finally {
        staging.close();
      }
      return;
    }
    assert.equal(commandCount, 2, "a newly available GPX bundle must invoke exactly one recompute");
    assert.ok(args.includes("recompute"));
    const dirtyFromArgument = args.indexOf("--dirty-from");
    assert.ok(dirtyFromArgument >= 0);
    assert.equal(args[dirtyFromArgument + 1], runDate(0));
  };
  const job: Record<string, unknown> = {
    id: "web_import_first_gpx_fingerprint",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  };
  try {
    await worker.run(job);
    assert.equal(commandCount, 2);
    assert.equal(job.status, "succeeded");
    assert.equal((job.summary as { importMode: string; routesUpdated: number }).importMode, "incremental");
    assert.equal((job.summary as { importMode: string; routesUpdated: number }).routesUpdated, 1);
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((activated.prepare(`
        SELECT COUNT(*) AS count FROM route_points WHERE route_id = 'worker_route_new'
      `).get() as { count: number }).count, 2);
      assert.equal((activated.prepare(`
        SELECT value FROM import_manifest WHERE key = 'source_gpx_bundle_sha256'
      `).get() as { value: string }).value, "first-gpx-hash");
    } finally {
      activated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const projection of ["inventory", "manifest"] as const) {
  test(`classifies an audit ${projection} change as data-only`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-import-audit-diff-"));
    const previousPath = join(root, "previous.sqlite");
    const stagingPath = join(root, "staging.sqlite");
    const previous = await seedCanonical(previousPath);
    const staging = await seedCanonical(stagingPath);
    if (projection === "inventory") {
      const insertInventory = (database: DatabaseSync, count: number): void => {
        database.prepare(`
          INSERT INTO entity_inventory (
            entity_kind, entity_type, item_count, first_at, last_at, details_json
          ) VALUES ('record', 'HKQuantityTypeIdentifierBodyMass', ?, ?, ?, ?)
        `).run(count, runDate(1), runDate(1), JSON.stringify({ units: ["kg"], sourceCategories: ["apple_watch"] }));
      };
      insertInventory(previous.database, 1);
      insertInventory(staging.database, 2);
    } else {
      previous.database.prepare("INSERT INTO import_manifest (key, value) VALUES ('record_count', '1')").run();
      staging.database.prepare("INSERT INTO import_manifest (key, value) VALUES ('record_count', '2')").run();
    }
    previous.close();
    staging.close();
    try {
      const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
      const change = worker.analyzeDatasetChange(stagingPath, previousPath);
      assert.equal(change.mode, "data-only");
      assert.equal(change.dirtyFromAt, null);
      assert.equal(change.insertedWorkouts, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const operation of ["inserted", "removed"] as const) {
  test(`classifies an ${operation} import issue as data-only`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-import-issue-diff-"));
    const previousPath = join(root, "previous.sqlite");
    const stagingPath = join(root, "staging.sqlite");
    const previous = await seedCanonical(previousPath);
    const staging = await seedCanonical(stagingPath);
    const target = operation === "inserted" ? staging : previous;
    target.database.prepare(`
      INSERT INTO import_issues (severity, code, object_id, message)
      VALUES ('warning', 'INVALID_RECORD', NULL, 'invalid record fixture')
    `).run();
    previous.close();
    staging.close();
    try {
      const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
      const change = worker.analyzeDatasetChange(stagingPath, previousPath);
      assert.equal(change.mode, "data-only");
      assert.equal(change.dirtyFromAt, null);
      assert.equal(change.insertedWorkouts, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("ignores import issue surrogate IDs when the current issue projection is unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-issue-unchanged-"));
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const previous = await seedCanonical(previousPath);
  const staging = await seedCanonical(stagingPath);
  previous.database.prepare(`
    INSERT INTO import_issues (id, severity, code, object_id, message)
    VALUES (10, 'warning', 'INVALID_RECORD', NULL, 'invalid record fixture')
  `).run();
  staging.database.prepare(`
    INSERT INTO import_issues (id, severity, code, object_id, message)
    VALUES (20, 'warning', 'INVALID_RECORD', NULL, 'invalid record fixture')
  `).run();
  previous.close();
  staging.close();
  try {
    const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
    assert.equal(worker.analyzeDatasetChange(stagingPath, previousPath).mode, "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [previousCount, stagingCount] of [[2, 1], [1, 2]] as const) {
  test(`classifies an import issue multiplicity change from ${previousCount} to ${stagingCount} as data-only`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-import-issue-multiplicity-"));
    const previousPath = join(root, "previous.sqlite");
    const stagingPath = join(root, "staging.sqlite");
    const previous = await seedCanonical(previousPath);
    const staging = await seedCanonical(stagingPath);
    const insertIssues = (database: DatabaseSync, count: number): void => {
      const insert = database.prepare(`
        INSERT INTO import_issues (severity, code, object_id, message)
        VALUES ('warning', 'INVALID_RECORD', NULL, 'invalid record fixture')
      `);
      for (let index = 0; index < count; index += 1) insert.run();
    };
    insertIssues(previous.database, previousCount);
    insertIssues(staging.database, stagingCount);
    previous.close();
    staging.close();
    try {
      const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
      const change = worker.analyzeDatasetChange(stagingPath, previousPath);
      assert.equal(change.mode, "data-only");
      assert.equal(change.dirtyFromAt, null);
      assert.equal(change.insertedWorkouts, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("activates a rebuilt issue generation that removes legacy duplicates", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-issue-upgrade-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  const insertIssue = active.database.prepare(`
    INSERT INTO import_issues (severity, code, object_id, message)
    VALUES ('warning', 'INVALID_RECORD', NULL, 'invalid record fixture')
  `);
  insertIssue.run();
  insertIssue.run();
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  let commandCount = 0;
  worker.command = async (args) => {
    commandCount += 1;
    assert.equal(commandCount, 1, "issue generation cleanup must not invoke recompute");
    const databaseArgument = args.indexOf("--database");
    assert.ok(databaseArgument >= 0);
    const stagingPath = args[databaseArgument + 1];
    assert.ok(stagingPath);
    const staging = new DatabaseSync(stagingPath);
    try {
      staging.prepare("DELETE FROM import_issues").run();
      staging.prepare(`
        INSERT INTO import_issues (severity, code, object_id, message)
        VALUES ('warning', 'INVALID_RECORD', NULL, 'invalid record fixture')
      `).run();
    } finally {
      staging.close();
    }
  };
  const job: Record<string, unknown> = {
    id: "web_import_issue_upgrade",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  };
  try {
    await worker.run(job);
    assert.equal(commandCount, 1);
    assert.equal(job.status, "succeeded");
    assert.equal((job.summary as { importMode: string }).importMode, "incremental");
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const issueCount = (activated.prepare("SELECT COUNT(*) AS count FROM import_issues").get() as { count: number }).count;
      const report = JSON.parse(readFileSync(join(root, "var", "reports", "data-audit.json"), "utf8")) as {
        totals: { importIssues: number };
      };
      assert.equal(issueCount, 1);
      assert.equal(report.totals.importIssues, issueCount);
    } finally {
      activated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failurePhase of ["recompute", "activate"] as const) {
  test(`keeps the active database and audit reports unchanged when import ${failurePhase} fails`, async () => {
    const root = mkdtempSync(join(tmpdir(), `rai-import-audit-${failurePhase}-`));
    const databasePath = join(root, "var", "rai.sqlite");
    const markdownPath = join(root, "docs", "DATA_AUDIT.md");
    const jsonPath = join(root, "var", "reports", "data-audit.json");
    mkdirSync(join(root, "var"));
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "var", "reports"));
    const active = await seedCanonical(databasePath);
    active.database.exec("CREATE TABLE audit_marker (value TEXT NOT NULL); INSERT INTO audit_marker VALUES ('old-generation')");
    active.close();
    writeFileSync(markdownPath, "old markdown report", "utf8");
    writeFileSync(jsonPath, JSON.stringify({ datasetVersion: "old-generation" }), "utf8");
    const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
    let commandCount = 0;
    worker.command = async (args) => {
      commandCount += 1;
      const databaseArgument = args.indexOf("--database");
      const candidatePath = args[databaseArgument + 1];
      assert.ok(candidatePath);
      if (commandCount === 1) {
        // Only the parser generates audit reports; recompute has no source-database
        // option. Asserting this on recompute used to abort the fixture before its
        // intended failure, hidden behind the old generic job.error.
        const sourceArgument = args.indexOf("--source-database");
        assert.ok(sourceArgument > 0, "audit report must be told which database it describes");
        assert.equal(args[sourceArgument + 1], databasePath);
        const candidate = new DatabaseSync(candidatePath);
        try {
          candidate.prepare(`
            INSERT INTO health_records (
              id, type, source_name, source_category, unit, value_numeric,
              start_at, end_at, metadata_json, raw_attributes_json
            ) VALUES (?, ?, 'Fixture', 'apple_watch', 'ml/kg*min', 52, ?, ?, '{}', '{}')
          `).run(`audit_${failurePhase}_vo2`, healthTypes.vo2Max, runDate(1), runDate(1));
        } finally {
          candidate.close();
        }
        return;
      }
      assert.ok(args.includes("recompute"));
      if (failurePhase === "recompute") throw new Error("simulated recompute failure");
    };
    if (failurePhase === "activate") {
      worker.installDatabase = async () => {
        throw new Error("simulated activation failure");
      };
    }
    const job: Record<string, unknown> = {
      id: `web_import_audit_${failurePhase}`,
      status: "queued",
      phase: "queued",
      message: "queued",
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      inputPath: join(root, "export"),
    };
    try {
      await worker.run(job);
      assert.equal(job.status, "failed");
      // Internal task state retains diagnostics; only the public DTO is sanitized.
      assert.match(String(job.error), failurePhase === "recompute"
        ? /simulated recompute failure/ : /simulated activation failure/);
      assert.equal(readFileSync(markdownPath, "utf8"), "old markdown report");
      assert.deepEqual(JSON.parse(readFileSync(jsonPath, "utf8")), { datasetVersion: "old-generation" });
      const preserved = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal((preserved.prepare("SELECT value FROM audit_marker").get() as { value: string }).value, "old-generation");
      } finally {
        preserved.close();
      }
      assert.deepEqual(
        readdirSync(join(root, "var")).filter((name) => name.includes(job.id as string)),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("rolls back the active database and both reports when audit report commit fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-audit-commit-failure-"));
  const databasePath = join(root, "var", "rai.sqlite");
  const markdownPath = join(root, "docs", "DATA_AUDIT.md");
  const jsonPath = join(root, "var", "reports", "data-audit.json");
  mkdirSync(join(root, "var"));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "var", "reports"));
  const active = await seedCanonical(databasePath);
  active.database.exec("CREATE TABLE audit_marker (value TEXT NOT NULL); INSERT INTO audit_marker VALUES ('old-generation')");
  active.close();
  writeFileSync(markdownPath, "old markdown report", "utf8");
  writeFileSync(jsonPath, JSON.stringify({ datasetVersion: "old-generation" }), "utf8");
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  worker.command = async (args) => {
    const databaseArgument = args.indexOf("--database");
    const candidatePath = args[databaseArgument + 1];
    assert.ok(candidatePath);
    const candidate = new DatabaseSync(candidatePath);
    try {
      candidate.prepare("UPDATE audit_marker SET value = 'new-generation'").run();
      candidate.prepare(`
        INSERT INTO health_records (
          id, type, source_name, source_category, unit, value_numeric,
          start_at, end_at, metadata_json, raw_attributes_json
        ) VALUES ('audit_commit_body_mass', 'HKQuantityTypeIdentifierBodyMass',
          'Fixture', 'apple_watch', 'kg', 65, ?, ?, '{}', '{}')
      `).run(runDate(1), runDate(1));
    } finally {
      candidate.close();
    }
  };
  const stageAuditReports = worker.stageAuditReports.bind(worker);
  worker.stageAuditReports = (candidatePath, finalMarkdownPath, finalJsonPath) => {
    const publication = stageAuditReports(candidatePath, finalMarkdownPath, finalJsonPath);
    const pendingJson = readdirSync(join(root, "var", "reports"))
      .find((name) => name.startsWith("data-audit.json.pending."));
    assert.ok(pendingJson);
    rmSync(join(root, "var", "reports", pendingJson));
    return publication;
  };
  const job: Record<string, unknown> = {
    id: "web_import_audit_commit_failure",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export"),
  };
  try {
    await worker.run(job);
    assert.equal(job.status, "failed");
    assert.equal(readFileSync(markdownPath, "utf8"), "old markdown report");
    assert.deepEqual(JSON.parse(readFileSync(jsonPath, "utf8")), { datasetVersion: "old-generation" });
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((preserved.prepare("SELECT value FROM audit_marker").get() as { value: string }).value, "old-generation");
    } finally {
      preserved.close();
    }
    assert.deepEqual(
      readdirSync(join(root, "docs")).filter((name) => name.includes(".pending.") || name.includes(".replaced.")),
      [],
    );
    assert.deepEqual(
      readdirSync(join(root, "var", "reports")).filter((name) => name.includes(".pending.") || name.includes(".replaced.")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activates audit projections without recompute so the database matches the CLI report", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-audit-projection-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.database.prepare(`
    INSERT INTO entity_inventory (
      entity_kind, entity_type, item_count, first_at, last_at, details_json
    ) VALUES ('record', 'HKQuantityTypeIdentifierBodyMass', 1, ?, ?, ?)
  `).run(runDate(1), runDate(1), JSON.stringify({ units: ["kg"], sourceCategories: ["apple_watch"] }));
  active.database.prepare("INSERT INTO import_manifest (key, value) VALUES ('record_count', '1')").run();
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  let commandCount = 0;
  worker.command = async (args) => {
    commandCount += 1;
    assert.equal(commandCount, 1, "audit-only changes must not invoke recompute");
    const databaseArgument = args.indexOf("--database");
    const reportArgument = args.indexOf("--json-report");
    assert.ok(databaseArgument >= 0);
    assert.ok(reportArgument >= 0);
    const stagingPath = args[databaseArgument + 1];
    const reportPath = args[reportArgument + 1];
    assert.ok(stagingPath);
    assert.ok(reportPath);
    const staging = new DatabaseSync(stagingPath);
    try {
      staging.prepare(`
        UPDATE entity_inventory SET item_count = 2
        WHERE entity_kind = 'record' AND entity_type = 'HKQuantityTypeIdentifierBodyMass'
      `).run();
      staging.prepare("UPDATE import_manifest SET value = '2' WHERE key = 'record_count'").run();
      staging.prepare("UPDATE import_manifest SET value = 'worker_fixture_duplicate' WHERE key = 'dataset_version'").run();
      staging.prepare(`
        INSERT INTO import_issues (severity, code, object_id, message)
        VALUES ('warning', 'INVALID_RECORD', NULL, 'invalid record fixture')
      `).run();
    } finally {
      staging.close();
    }
    mkdirSync(join(root, "var", "reports"), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({
      datasetVersion: "worker_fixture_duplicate",
      parsedRecords: 2,
      importIssues: 1
    }), "utf8");
  };
  const job: Record<string, unknown> = {
    id: "web_import_audit_projection",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  };
  try {
    await worker.run(job);
    assert.equal(commandCount, 1);
    assert.equal(job.status, "succeeded");
    assert.equal((job.summary as { importMode: string }).importMode, "incremental");
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const manifest = activated.prepare(`
        SELECT key, value FROM import_manifest WHERE key IN ('dataset_version', 'record_count')
      `).all() as unknown as Array<{ key: string; value: string }>;
      const inventory = activated.prepare(`
        SELECT item_count AS itemCount FROM entity_inventory
        WHERE entity_kind = 'record' AND entity_type = 'HKQuantityTypeIdentifierBodyMass'
      `).get() as { itemCount: number };
      const report = JSON.parse(readFileSync(join(root, "var", "reports", "data-audit.json"), "utf8")) as {
        datasetVersion: string;
        totals: {
          parsedRecords: number;
          importIssues: number;
        };
      };
      assert.deepEqual(Object.fromEntries(manifest.map((row) => [row.key, row.value])), {
        dataset_version: report.datasetVersion,
        record_count: String(report.totals.parsedRecords)
      });
      assert.equal(inventory.itemCount, report.totals.parsedRecords);
      assert.equal((activated.prepare("SELECT COUNT(*) AS count FROM import_issues").get() as { count: number }).count,
        report.totals.importIssues);
    } finally {
      activated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ["inserted", "removed", "updated"] as const) {
  test(`classifies an ${operation} activity summary as data-only`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-import-activity-summary-diff-"));
    const previousPath = join(root, "previous.sqlite");
    const stagingPath = join(root, "staging.sqlite");
    const previous = await seedCanonical(previousPath);
    const staging = await seedCanonical(stagingPath);
    const dateComponents = "2026-01-04";
    if (operation !== "inserted") {
      previous.database.prepare(`
        INSERT INTO activity_summaries (date_components, attributes_json) VALUES (?, ?)
      `).run(dateComponents, JSON.stringify({ activeEnergyBurned: 450 }));
    }
    if (operation !== "removed") {
      staging.database.prepare(`
        INSERT INTO activity_summaries (date_components, attributes_json) VALUES (?, ?)
      `).run(dateComponents, JSON.stringify({ activeEnergyBurned: 500 }));
    }
    previous.close();
    staging.close();
    try {
      const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
      const change = worker.analyzeDatasetChange(stagingPath, previousPath);
      assert.equal(change.mode, "data-only");
      assert.equal(change.dirtyFromAt, null);
      assert.equal(change.insertedWorkouts, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("activates activity summary changes without running model recompute", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-activity-summary-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.database.prepare(`
    INSERT INTO activity_summaries (date_components, attributes_json) VALUES (?, ?)
  `).run("2026-01-04", JSON.stringify({ activeEnergyBurned: 450 }));
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  let commandCount = 0;
  worker.command = async (args) => {
    commandCount += 1;
    assert.equal(commandCount, 1, "activity summary changes must not invoke recompute");
    const databaseArgument = args.indexOf("--database");
    assert.ok(databaseArgument >= 0);
    const stagingPath = args[databaseArgument + 1];
    assert.ok(stagingPath);
    const staging = new DatabaseSync(stagingPath);
    try {
      staging.prepare(`
        UPDATE activity_summaries SET attributes_json = ? WHERE date_components = ?
      `).run(JSON.stringify({ activeEnergyBurned: 500 }), "2026-01-04");
    } finally {
      staging.close();
    }
  };
  const job: Record<string, unknown> = {
    id: "web_import_activity_summary",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  };
  try {
    await worker.run(job);
    assert.equal(commandCount, 1);
    assert.equal(job.status, "succeeded");
    assert.equal((job.summary as { importMode: string }).importMode, "incremental");
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = activated.prepare(`
        SELECT attributes_json AS attributesJson FROM activity_summaries WHERE date_components = ?
      `).get("2026-01-04") as { attributesJson: string };
      assert.deepEqual(JSON.parse(row.attributesJson), { activeEnergyBurned: 500 });
    } finally {
      activated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activates data-only health changes without running model recompute", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-data-only-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  mkdirSync(join(root, "export"));
  writeFileSync(join(root, "export", "export.xml"), "<HealthData />", "utf8");
  const active = await seedCanonical(databasePath);
  active.close();
  const importWorker = new ImportWorker(databasePath, root, root);
  const worker = importWorker as unknown as ImportWorkerTestSurface;
  let commandCount = 0;
  worker.command = async (args) => {
    commandCount += 1;
    assert.equal(commandCount, 1, "data-only imports must not invoke recompute");
    const databaseArgument = args.indexOf("--database");
    assert.ok(databaseArgument >= 0);
    const stagingPath = args[databaseArgument + 1];
    assert.ok(stagingPath);
    const staging = new DatabaseSync(stagingPath);
    try {
      staging.prepare(`
        INSERT INTO health_records (
          id, type, source_name, source_category, unit, value_numeric,
          start_at, end_at, metadata_json, raw_attributes_json
        ) VALUES (
          'worker_body_mass', 'HKQuantityTypeIdentifierBodyMass',
          'Fixture', 'apple_watch', 'kg', 65, ?, ?, '{}', '{}'
        )
      `).run(runDate(1), new Date(Date.parse(runDate(1)) + 10_000).toISOString());
    } finally {
      staging.close();
    }
  };
  const persistJobs = worker.persistJobs.bind(importWorker);
  let terminalPersistenceFailures = 0;
  worker.persistJobs = () => {
    if (importWorker.latest()?.status === "succeeded" && terminalPersistenceFailures === 0) {
      terminalPersistenceFailures += 1;
      throw new Error("fixture transient terminal persistence failure");
    }
    persistJobs();
  };
  let finishTerminalCleanup: (() => void) | undefined;
  let terminalCleanupStarted = false;
  const terminalCleanup = new Promise<void>((resolvePromise) => {
    finishTerminalCleanup = resolvePromise;
  });
  try {
    const created = importWorker.create(join(root, "export"), async () => {
      const runtime = new DatabaseSync(join(root, "var", "runtime.sqlite"), { readOnly: true });
      try {
        const stored = runtime.prepare("SELECT status FROM import_jobs WHERE id = ?").get(created.id) as {
          status: string;
        };
        assert.equal(stored.status, "succeeded", "terminal cleanup must start after durable publication");
      } finally {
        runtime.close();
      }
      terminalCleanupStarted = true;
      await terminalCleanup;
    }, "source-data-only");
    await waitFor(() => terminalCleanupStarted);
    assert.equal(terminalPersistenceFailures, 1);
    assert.equal(importWorker.get(created.id)?.status, "succeeded");
    assert.equal(importWorker.isRunning, true, "worker remains active until terminal cleanup completes");
    finishTerminalCleanup?.();
    await waitFor(() => !importWorker.isRunning);
    assert.equal(commandCount, 1);
    assert.equal(importWorker.get(created.id)?.status, "succeeded");
    assert.equal(importWorker.get(created.id)?.summary?.importMode, "incremental");
    const timing = importWorker.get(created.id)?.performance;
    assert.equal(timing?.validationMode, "not-run");
    assert.equal(timing?.stagesMs.recompute, undefined, "data-only imports skip recompute entirely");
    const reopened = new ImportWorker(databasePath, root, root);
    assert.deepEqual(reopened.get(created.id)?.performance, timing, "timings survive service restart");
    await reopened.close();
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((activated.prepare(`
        SELECT COUNT(*) AS count FROM health_records WHERE id = 'worker_body_mass'
      `).get() as { count: number }).count, 1);
    } finally {
      activated.close();
    }
  } finally {
    finishTerminalCleanup?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs a full recompute when an import only adds VO2 max evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-vo2-full-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  let commandCount = 0;
  worker.command = async (args) => {
    commandCount += 1;
    const databaseArgument = args.indexOf("--database");
    assert.ok(databaseArgument >= 0);
    const stagingPath = args[databaseArgument + 1];
    assert.ok(stagingPath);
    if (commandCount === 1) {
      const staging = new DatabaseSync(stagingPath);
      try {
        staging.prepare(`
          INSERT INTO health_records (
            id, type, source_name, source_category, unit, value_numeric,
            start_at, end_at, metadata_json, raw_attributes_json
          ) VALUES (?, ?, 'Fixture', 'apple_watch', 'ml/kg*min', 52, ?, ?, '{}', '{}')
        `).run("worker_imported_vo2_max", healthTypes.vo2Max, runDate(1), runDate(1));
      } finally {
        staging.close();
      }
      return;
    }
    assert.equal(commandCount, 2, "VO2 max changes must invoke exactly one recompute");
    assert.ok(args.includes("recompute"));
  };
  const job: Record<string, unknown> = {
    id: "web_import_vo2_full",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  };
  try {
    await worker.run(job);
    assert.equal(commandCount, 2);
    assert.equal(job.status, "succeeded");
    assert.equal((job.summary as { importMode: string }).importMode, "full");
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((activated.prepare(`
        SELECT COUNT(*) AS count FROM health_records WHERE id = 'worker_imported_vo2_max'
      `).get() as { count: number }).count, 1);
    } finally {
      activated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses incremental recompute when only a new workout is appended", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-diff-"));
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const previous = await seedCanonical(previousPath);
  const staging = await seedCanonical(stagingPath);
  const start = runDate(8);
  const end = new Date(Date.parse(start) + 1_800_000).toISOString();
  staging.database.prepare(`
    INSERT INTO workouts (id, activity_type, source_name, source_category, start_at, end_at,
      duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
    VALUES ('worker_workout_8', 'HKWorkoutActivityTypeRunning', 'Fixture', 'apple_watch',
      ?, ?, 1800, 0, '{}', '{}', 1)
  `).run(start, end);
  staging.database.prepare(`
    INSERT INTO training_sessions (id, activity_type, anchor_start_at, anchor_end_at,
      anchor_distance_km, canonical_workout_id, status)
    VALUES ('worker_session_8', 'HKWorkoutActivityTypeRunning', ?, ?, 5, 'worker_workout_8', 'active')
  `).run(start, end);
  previous.close();
  staging.close();
  try {
    const worker = new ImportWorker(join(root, "active.sqlite"), root) as unknown as ImportWorkerTestSurface;
    const change = worker.analyzeDatasetChange(stagingPath, previousPath);
    assert.equal(change.mode, "incremental");
    assert.equal(change.insertedWorkouts, 1);
    assert.equal(change.dirtyFromAt, start);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists import jobs and marks an interrupted job after API restart", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-jobs-"));
  mkdirSync(join(root, "var"));
  writeFileSync(join(root, "var", "import-jobs.json"), JSON.stringify([{
    id: "web_import_interrupted",
    sourceId: "upload_interrupted",
    status: "running",
    phase: "recompute",
    message: "正在重算",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  }]), "utf8");
  try {
    const worker = new ImportWorker(join(root, "rai.sqlite"), root, root);
    const job = worker.latest();
    assert.equal(job?.id, "web_import_interrupted");
    assert.equal(job?.sourceId, "upload_interrupted");
    assert.equal(job?.status, "failed");
    assert.equal(job?.phase, "interrupted");
    assert.equal(job?.error, "导入失败，请查看服务日志");
    writeFileSync(join(root, "var", "import-jobs.json"), "[]", "utf8");
    const restarted = new ImportWorker(join(root, "rai.sqlite"), root, root);
    assert.equal(restarted.latest()?.id, "web_import_interrupted");
    assert.equal(restarted.latest()?.sourceId, "upload_interrupted");
    assert.equal(existsSync(join(root, "var", "runtime.sqlite")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adds sourceId storage when opening an existing runtime database", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-jobs-schema-"));
  const runtimeDirectory = join(root, "var");
  mkdirSync(runtimeDirectory);
  const runtimePath = join(runtimeDirectory, "runtime.sqlite");
  const database = new DatabaseSync(runtimePath);
  database.exec(`
    CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE import_jobs (
      sequence_number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, phase TEXT NOT NULL, message TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT, error TEXT,
      input_path TEXT NOT NULL, progress REAL, summary_json TEXT
    );
    INSERT INTO import_jobs (id, status, phase, message, created_at, completed_at, error, input_path)
    VALUES ('web_import_legacy', 'succeeded', 'completed', 'done',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', NULL, 'C:/legacy-export');
  `);
  database.close();
  try {
    const worker = new ImportWorker(join(root, "rai.sqlite"), root, root);
    assert.equal(worker.latest()?.id, "web_import_legacy");
    assert.equal(worker.latest()?.sourceId, undefined);
    const migrated = new DatabaseSync(runtimePath, { readOnly: true });
    const columns = migrated.prepare("PRAGMA table_info(import_jobs)").all() as Array<{ name: string }>;
    migrated.close();
    assert.ok(columns.some(({ name }) => name === "source_id"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releases import worker state and calls terminal cleanup when staging cleanup fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-cleanup-"));
  const inputPath = join(root, "export");
  mkdirSync(inputPath);
  writeFileSync(join(inputPath, "export.xml"), "<HealthData />", "utf8");
  const worker = new ImportWorker(join(root, "rai.sqlite"), root, root);
  const surface = worker as unknown as ImportWorkerTestSurface;
  surface.removeDatabaseFiles = async () => {
    throw new Error("fixture cleanup failure");
  };
  let terminalResult: boolean | null = null;
  let terminalAttempts = 0;
  try {
    const created = worker.create(inputPath, (succeeded) => {
      terminalAttempts += 1;
      if (terminalAttempts < 3) throw new Error("fixture transient terminal cleanup failure");
      terminalResult = succeeded;
    }, "source-cleanup-test");
    assert.equal(created.sourceId, "source-cleanup-test");
    assert.equal(worker.get(created.id)?.sourceId, "source-cleanup-test");
    await waitFor(() => !worker.isRunning);
    assert.equal(terminalResult, false);
    assert.equal(terminalAttempts, 3);
    assert.equal(worker.get(created.id)?.status, "failed");
    assert.equal(worker.get(created.id)?.error, "导入失败，请查看服务日志");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releases terminal ownership without cleaning the source when terminal state cannot be persisted", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-terminal-persist-failure-"));
  const inputPath = join(root, "export");
  mkdirSync(inputPath);
  writeFileSync(join(inputPath, "export.xml"), "<HealthData />", "utf8");
  const worker = new ImportWorker(join(root, "rai.sqlite"), root, root);
  const surface = worker as unknown as ImportWorkerTestSurface;
  surface.removeDatabaseFiles = async () => {
    throw new Error("fixture import failure");
  };
  const persistJobs = surface.persistJobs.bind(worker);
  let terminalPersistenceAttempts = 0;
  surface.persistJobs = () => {
    if (worker.latest()?.status === "failed") {
      terminalPersistenceAttempts += 1;
      throw new Error("fixture permanent runtime persistence failure");
    }
    persistJobs();
  };
  let released = false;
  let sourceCleaned = false;
  try {
    worker.create(inputPath, (_succeeded, durable) => {
      try {
        if (durable) sourceCleaned = true;
      } finally {
        released = true;
      }
    }, "source-must-remain");
    await waitFor(() => !worker.isRunning);
    assert.equal(terminalPersistenceAttempts, 4);
    assert.equal(released, true, "terminal callback must still release external ownership");
    assert.equal(sourceCleaned, false, "non-durable terminal state must preserve the retry source");
    assert.equal(worker.latest()?.status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releases import worker state when the initial running-state persistence fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-persist-"));
  const inputPath = join(root, "export");
  mkdirSync(inputPath);
  writeFileSync(join(inputPath, "export.xml"), "<HealthData />", "utf8");
  const worker = new ImportWorker(join(root, "rai.sqlite"), root, root);
  const surface = worker as unknown as ImportWorkerTestSurface;
  const persistJobs = surface.persistJobs.bind(worker);
  let persistenceAttempts = 0;
  surface.persistJobs = () => {
    persistenceAttempts += 1;
    if (persistenceAttempts === 2) throw new Error("fixture persistence failure");
    persistJobs();
  };
  let terminalResult: boolean | null = null;
  try {
    const created = worker.create(inputPath, (succeeded) => {
      terminalResult = succeeded;
    });
    await waitFor(() => !worker.isRunning);
    assert.equal(terminalResult, false);
    assert.equal(worker.get(created.id)?.status, "failed");
    assert.equal(worker.get(created.id)?.error, "导入失败，请查看服务日志");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports the import worker as running until asynchronous terminal cleanup finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-terminal-"));
  const inputPath = join(root, "export");
  mkdirSync(inputPath);
  writeFileSync(join(inputPath, "export.xml"), "<HealthData />", "utf8");
  const worker = new ImportWorker(join(root, "rai.sqlite"), root, root);
  const surface = worker as unknown as ImportWorkerTestSurface;
  surface.removeDatabaseFiles = async () => {
    throw new Error("fixture cleanup failure");
  };
  let finishTerminalCleanup: (() => void) | undefined;
  let terminalCleanupStarted = false;
  const terminalCleanup = new Promise<void>((resolvePromise) => {
    finishTerminalCleanup = resolvePromise;
  });
  try {
    worker.create(inputPath, async () => {
      terminalCleanupStarted = true;
      await terminalCleanup;
    });
    await waitFor(() => terminalCleanupStarted);
    assert.equal(worker.isRunning, true);
    finishTerminalCleanup?.();
    await waitFor(() => !worker.isRunning);
  } finally {
    finishTerminalCleanup?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("imports preserve by default and only an explicit full snapshot replaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-healthkit-preserve-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  mkdirSync(join(root, "export"));
  writeFileSync(join(root, "export", "export.xml"), "<HealthData />", "utf8");
  const manifestPath = join(root, "export", "sync-manifest.json");
  const active = await seedCanonical(databasePath);
  active.close();
  const captureCommand = async (
    source: { kind: string; displayName: string; originalPath?: string }
  ): Promise<string[]> => {
    const importWorker = new ImportWorker(databasePath, root, root);
    const worker = importWorker as unknown as ImportWorkerTestSurface;
    let captured: string[] | null = null;
    worker.command = async (args) => {
      captured = args;
      throw new Error("fixture stop after capturing import args");
    };
    try {
      importWorker.create(join(root, "export"), undefined, "source-healthkit", source);
      await waitFor(() => captured !== null && !importWorker.isRunning);
      assert.ok(captured);
      return captured;
    } finally {
      await importWorker.close();
    }
  };
  try {
    const healthKitArgs = await captureCommand({
      kind: "upload",
      displayName: "apple-health-healthkit.zip"
    });
    assert.ok(healthKitArgs.includes("incremental-import"));
    assert.ok(healthKitArgs.includes("--preserve-absent"));
    assert.equal(healthKitArgs.includes("--replace-absent"), false);

    const originalNameArgs = await captureCommand({
      kind: "upload",
      displayName: "health.zip",
      originalPath: join(root, "apple-health-healthkit-local.zip")
    });
    assert.ok(originalNameArgs.includes("--preserve-absent"));
    assert.equal(originalNameArgs.includes("--replace-absent"), false);

    // Neither a directory nor a discovered export declares itself a complete
    // snapshot, so both must import without enabling deletion.
    const directoryArgs = await captureCommand({
      kind: "directory",
      displayName: "apple-health-healthkit.zip"
    });
    assert.ok(directoryArgs.includes("incremental-import"));
    assert.ok(directoryArgs.includes("--preserve-absent"));
    assert.equal(directoryArgs.includes("--replace-absent"), false);

    const discoveredArgs = await captureCommand({
      kind: "discovered",
      displayName: "apple-health-healthkit.zip"
    });
    assert.ok(discoveredArgs.includes("--preserve-absent"));
    assert.equal(discoveredArgs.includes("--replace-absent"), false);

    // Only a payload that declares a complete snapshot may replace by absence.
    writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, sourceScope: FULL_SNAPSHOT_SOURCE_SCOPE }),
      "utf8"
    );
    const snapshotArgs = await captureCommand({
      kind: "upload",
      displayName: "apple-health-healthkit.zip"
    });
    assert.ok(snapshotArgs.includes("--replace-absent"));
    assert.equal(snapshotArgs.includes("--preserve-absent"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closes a queued import before it starts and runs terminal cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-close-"));
  const inputPath = join(root, "export");
  mkdirSync(inputPath);
  writeFileSync(join(inputPath, "export.xml"), "<HealthData />", "utf8");
  const worker = new ImportWorker(join(root, "rai.sqlite"), root, root);
  let terminalResult: boolean | null = null;
  try {
    const created = worker.create(inputPath, (succeeded) => {
      terminalResult = succeeded;
    });
    await worker.close();
    assert.equal(worker.isRunning, false);
    assert.equal(terminalResult, false);
    assert.equal(worker.get(created.id)?.phase, "interrupted");
    assert.throws(() => worker.create(inputPath), /正在关闭/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("publishes CLI removal guard details and preserves them across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-worker-removal-guard-"));
  const databasePath = join(root, "rai.sqlite");
  const input = join(root, "export");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), "<HealthData />");
  writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
    version: 1, sourceScope: FULL_SNAPSHOT_SOURCE_SCOPE
  }));
  const store = await seedCanonical(databasePath);
  for (let index = 8; index < 60; index += 1) {
    store.database.prepare(`
      INSERT INTO workouts (id, activity_type, source_name, source_category, start_at, end_at,
        duration_seconds, metadata_json, raw_attributes_json)
      VALUES (?, 'HKWorkoutActivityTypeRunning', 'Watch', 'apple_watch',
        '2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z', 1800, '{}', '{}')
    `).run(`guard_workout_${index}`);
  }
  store.close();
  const projectRoot = join(import.meta.dirname, "../../..");
  const worker = new ImportWorker(databasePath, projectRoot, root);
  try {
    worker.create(input);
    await waitFor(() => !worker.isRunning, 30_000);
    assert.equal(worker.latest()?.status, "failed");
    assert.match(worker.latest()?.error ?? "", /导入已中止.*60 次训练/);
    assert.doesNotMatch(worker.latest()?.error ?? "", /rai-worker-removal-guard|Error:|cli.ts/);
    const live = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((live.prepare("SELECT COUNT(*) AS n FROM workouts").get() as { n: number }).n, 60);
    } finally { live.close(); }
    const restarted = new ImportWorker(databasePath, projectRoot, root);
    try {
      assert.equal(restarted.latest()?.error, worker.latest()?.error);
    } finally { await restarted.close(); }
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed guard IPC without treating child text as a public error", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-worker-invalid-guard-"));
  const worker = new ImportWorker(join(root, "rai.sqlite"), root, root);
  try {
    const surface = worker as unknown as ImportWorkerTestSurface;
    await assert.rejects(surface.command(["-e", `
      process.send({code:'import_removal_guard', preview:{workouts:'private/path'}, userMessage:'private/path'}, () => {
        process.stderr.write('ordinary failure');
        process.exitCode = 1;
        process.disconnect();
      });
    `]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ImportRemovalGuardError, false);
      assert.match(error.message, /ordinary failure/);
      return true;
    });
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});


for (const operation of ["add", "clear", "repeat", "upgrade"] as const) {
  test(`classifies ${operation} source tombstones without recomputing`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-worker-source-tombstones-"));
    const previousPath = join(root, "previous.sqlite");
    const stagingPath = join(root, "staging.sqlite");
    const previous = await seedCanonical(previousPath);
    const staging = await seedCanonical(stagingPath);
    if (operation === "clear" || operation === "repeat") previous.removeWorkoutsBySyncIdentifiers(["unseen"]);
    if (operation !== "clear") staging.removeWorkoutsBySyncIdentifiers(["unseen"]);
    if (operation === "upgrade") previous.database.exec("DROP TABLE import_source_tombstones");
    previous.close();
    staging.close();
    const worker = new ImportWorker(join(root, "active.sqlite"), root, root);
    try {
      const surface = worker as unknown as ImportWorkerTestSurface;
      assert.equal(surface.analyzeDatasetChange(stagingPath, previousPath).mode,
        operation === "repeat" ? "unchanged" : "data-only");
    } finally {
      await worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("reclaims the displaced rollback point left behind by a committed import", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-reclaim-displaced-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  let displacedPath: string | null = null;
  let commandCount = 0;
  worker.command = async (args) => {
    commandCount += 1;
    const databaseArgument = args.indexOf("--database");
    assert.ok(databaseArgument >= 0);
    const stagingPath = args[databaseArgument + 1];
    assert.ok(stagingPath);
    if (commandCount > 1) {
      assert.ok(args.includes("recompute"));
      return;
    }
    const staging = new DatabaseSync(stagingPath);
    try {
      staging.prepare(`
        INSERT INTO health_records (
          id, type, source_name, source_category, unit, value_numeric,
          start_at, end_at, metadata_json, raw_attributes_json
        ) VALUES (?, ?, 'Fixture', 'apple_watch', 'ml/kg*min', 52, ?, ?, '{}', '{}')
      `).run("worker_reclaim_probe", healthTypes.vo2Max, runDate(1), runDate(1));
    } finally {
      staging.close();
    }
    // The CLI retains its rename-aside rollback point by contract; reclaiming it
    // for this import is the worker's responsibility.
    displacedPath = `${stagingPath}.replaced.77777777-7777-4777-8777-777777777777`;
    writeFileSync(displacedPath, "pre-import database");
  };
  const job: Record<string, unknown> = {
    id: "web_import_reclaim_displaced",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  };
  try {
    await worker.run(job);
    assert.equal(job.status, "succeeded");
    assert.equal(commandCount, 2);
    const reclaimed = displacedPath;
    assert.ok(reclaimed, "the fixture must have produced a displaced database");
    assert.equal(
      existsSync(reclaimed),
      false,
      "a committed import must not leave a full database copy on disk"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the displaced rollback point when an import fails before activation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-keep-displaced-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  let displacedPath: string | null = null;
  worker.command = async (args) => {
    const databaseArgument = args.indexOf("--database");
    assert.ok(databaseArgument >= 0);
    const stagingPath = args[databaseArgument + 1];
    assert.ok(stagingPath);
    // A publisher killed mid-flight leaves its rollback point behind, and it may
    // be the only usable recovery point, so the worker must not reclaim it.
    displacedPath = `${stagingPath}.replaced.88888888-8888-4888-8888-888888888888`;
    writeFileSync(displacedPath, "pre-import database");
    throw new Error("import command failed");
  };
  const job: Record<string, unknown> = {
    id: "web_import_keep_displaced",
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  };
  try {
    await worker.run(job);
    assert.equal(job.status, "failed");
    const kept = displacedPath;
    assert.ok(kept, "the fixture must have produced a displaced database");
    assert.equal(existsSync(kept), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
