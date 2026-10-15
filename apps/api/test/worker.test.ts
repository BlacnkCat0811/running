import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiApplicationService, currentAbilityBaselineHash } from "@rai/application";
import { healthTypes, PROHIBITED_DIRECT_SYNC_OPERATIONS, type PredictionModelTrainingRequest } from "@rai/contracts";
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
  predictionModelArtifactDirectory,
  PUBLIC_IMPORT_FAILURE_ERROR
} from "../src/worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";

interface ImportWorkerTestSurface {
  activateDatabase(
    stagingDatabase: string,
    jobId: string,
    existingBackupPath?: string | null,
    beforeCommit?: () => void | Promise<void>,
  ): Promise<void>;
  createCurrentBackup(jobId: string): Promise<string | null>;
  backupDatabase(database: DatabaseSync, destination: string): Promise<void>;
  isReadableDatabase(path: string): boolean | Promise<boolean>;
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
  reclaimDisplacedImportDatabases(stagingDatabase: string): Promise<void>;
  installDatabase(source: string, destination: string): Promise<void>;
  moveDatabaseFile(source: string, destination: string): Promise<void>;
  copyDatabaseFile(source: string, destination: string): Promise<void>;
  stageAuditReports(databasePath: string, markdownPath: string, jsonPath: string): {
    commit(): void;
    rollback(): void;
    finalize(): void;
    discard(): void;
  };
  prepareAuditReports(databasePath: string, markdownPath: string, jsonPath: string): Promise<{
    commit(): void;
    rollback(): void;
    finalize(): void;
    discard(): void;
  }>;
  removeDatabaseFile(path: string): Promise<void>;
  reclaimDisplacedImportDatabases(stagingDatabase: string): Promise<void>;
  persistJobs(): void;
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

test("import integrity checks yield the HTTP event loop and still reject corrupt databases", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-thread-check-"));
  const path = join(root, "rai.sqlite");
  marker(path, "unchanged");
  const worker = new ImportWorker(path, root) as unknown as ImportWorkerTestSurface;
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    assert.equal(await worker.isReadableDatabase(path), true);
    assert.ok(ticks > 0, "await-wrapped synchronous SQL would prevent all timer callbacks");
    assert.equal(marker(path), "unchanged");
    const corrupt = join(root, "broken.sqlite");
    writeFileSync(corrupt, "not a SQLite database");
    assert.equal(await worker.isReadableDatabase(corrupt), false);
    assert.equal(await worker.isReadableDatabase(join(root, "missing.sqlite")), false);
  } finally {
    clearInterval(timer);
    rmSync(root, { recursive: true, force: true });
  }
});

test("final import audit builds off-thread and remains unpublished until the database commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-thread-audit-"));
  const path = join(root, "rai.sqlite");
  const store = await seedCanonical(path);
  store.close();
  const worker = new ImportWorker(path, root) as unknown as ImportWorkerTestSurface;
  const markdown = join(root, "audit.md"), json = join(root, "audit.json");
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const audit = await worker.prepareAuditReports(path, markdown, json);
    assert.ok(ticks > 0, "the full audit query must not run on the HTTP thread");
    assert.equal(existsSync(markdown), false);
    assert.equal(existsSync(json), false);
    audit.commit();
    audit.finalize();
    assert.equal(existsSync(markdown), true);
    assert.equal((JSON.parse(readFileSync(json, "utf8")) as { totals: { workouts: number } }).totals.workouts, 8);
    assert.equal(readdirSync(root).some((name) => name.includes(".pending.") || name.includes(".replaced.")), false);
  } finally {
    clearInterval(timer);
    rmSync(root, { recursive: true, force: true });
  }
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

/**
 * S3.3 收口后的公共断言（候选链路已从运行期删除）：被拒的批次必须
 *   ① 显式失败 —— 状态 + 稳定失败码（客户端 I4 的处置输入）；
 *   ② 零禁止操作 —— §14.1 的加强版守卫（候选各阶段一段都不许出现）；
 *   ③ lane 遥测如实 —— 落点在 finally，失败路径不许漏。
 * 禁止阶段清单直接取自 contracts（单一来源）。注意 `changeAnalysis` **不在**其内：
 * 它是"载荷与上次一致"早退路径的合法计量，与候选链路的同名阶段不是一件事。
 */
function assertRefusedByClosedLane(
  job: Record<string, unknown>,
  expected: { failureCode: string; laneReasons: string[] }
): ImportJobPerformance {
  assert.equal(job.status, "failed", String(job.error ?? ""));
  assert.equal(job.failureCode, expected.failureCode);
  const timing = job.performance as ImportJobPerformance;
  assert.equal(timing.lane?.outcome, "fallback");
  assert.deepEqual(timing.lane?.reasons, expected.laneReasons);
  const prohibitedStages = [...new Set(
    PROHIBITED_DIRECT_SYNC_OPERATIONS.flatMap((operation) => operation.stages)
  )] as (keyof ImportJobPerformance["stagesMs"])[];
  for (const stage of prohibitedStages) {
    assert.equal(timing.stagesMs[stage], undefined, `${stage} must not run after S3.3`);
  }
  return timing;
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

test("an interrupted integrity worker removes the partial backup without quarantining a healthy main database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-verify-interrupted-"));
  const path = join(root, "rai.sqlite");
  marker(path, "healthy");
  const worker = new ImportWorker(path, root) as unknown as ImportWorkerTestSurface;
  worker.isReadableDatabase = async () => { throw new Error("fixture verifier interrupted"); };
  try {
    await assert.rejects(worker.createCurrentBackup("interrupted-verifier"), /fixture verifier interrupted/);
    assert.equal(marker(path), "healthy");
    assert.deepEqual(readdirSync(join(root, "var", "backups")), []);
    assert.equal(existsSync(join(root, "var", "quarantine")), false);
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

test("损坏的主库 + 无队列直跑 ⇒ 显式失败，且不建隔离、不动主库（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"损坏主库在候选链路里被隔离一次
  // （quarantine 目录恰好 1 个文件）、CLI 两次调用后成功"。隔离由候选的 activate 路径
  // 执行，已从运行期删除；`quarantineCorruptDatabase` 方法保留（阶段 5 隔离退役）。
  // 收口后的判据换成：① 无队列直跑 ⇒ `not_queued` 显式失败；② 不得创建任何隔离目录；
  // ③ 损坏的主库文件一字节不动。
  const root = mkdtempSync(join(tmpdir(), "rai-import-corrupt-run-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"), { recursive: true });
  const garbage = "not a sqlite database";
  writeFileSync(databasePath, garbage);
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
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
    assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
    // 隔离目录是候选 activate 路径的产物：收口后连空目录都不许出现。
    assert.equal(existsSync(join(root, "var", "quarantine")), false,
      "收口后的失败批次不得创建隔离目录");
    // 损坏的主库原样保留（它不是本批的修改对象）。
    assert.equal(readFileSync(databasePath, "utf8"), garbage);
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

test("无队列直跑路径在收口后显式失败，且零禁止操作（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"候选链路完整跑完（CLI 模拟两次调用）
  // 后 session 变 ambiguous + 发 issue"。那条链路已从运行期删除 —— 保留的判据换成：
  //   ① 无队列直跑（测试工装形态，生产恒经 API 队列）⇒ `not_queued`；收口后它必须**显式失败**
  //      （`direct_sync_internal_integrity`，500 语义的编程错误），而不是静默降级到任何慢路径；
  //   ② 失败批次**零禁止操作**（候选各阶段一段都不许出现）—— 这是 §14.1 的加强版守卫；
  //   ③ 主库零变化。
  // 原"recompute 激活产物"的业务语义由直连 + 分析管道承担（见 import-worker-direct-sync /
  // analysis-failure-isolation 等），它们不经过本文件的 CLI 工装。
  const root = mkdtempSync(join(tmpdir(), "rai-import-session-status-run-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
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
    assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((after.prepare(`
        SELECT status FROM training_sessions WHERE id = 'worker_session_0'
      `).get() as { status: string }).status, "active", "收口后的失败批次不得改动主库");
    } finally {
      after.close();
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

test("changed profile：无队列直跑 ⇒ 显式失败且主库 profile 不动（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"profile 变更 ⇒ 候选链路 CLI 重算
  // （commandCount==2、importMode=full）后主库 profile 被激活"。那条链路已删除；变更分类的
  // 覆盖由本文件直调用例（`uses full recompute when profile field … changes`）承担，
  // 重算执行由直连登记的分析管道承担。收口后的判据：显式失败 + 主库 profile 保持旧值。
  const root = mkdtempSync(join(tmpdir(), "rai-import-profile-full-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.database.prepare("INSERT INTO profile (id, attributes_json) VALUES (1, ?)")
    .run(JSON.stringify({ HKCharacteristicTypeIdentifierDateOfBirth: "1990-01-01" }));
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
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
    assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = activated.prepare("SELECT attributes_json AS attributesJson FROM profile WHERE id = 1")
        .get() as { attributesJson: string };
      assert.deepEqual(JSON.parse(row.attributesJson), {
        HKCharacteristicTypeIdentifierDateOfBirth: "1990-01-01"
      }, "收口后的失败批次不得改动主库 profile");
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

test("首个 GPX 指纹 + 无队列直跑 ⇒ 显式失败且主库路由零写入（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"升级库首次拿到 GPX 指纹 ⇒ 候选 CLI
  // 重算（commandCount==2、dirty-from=runDate(0)）后主库出现 route_points 与指纹"。那条
  // 链路已删除；指纹分类的覆盖由本文件直调用例（`recomputes from the first workout when the
  // GPX fingerprint has a … transition`）承担。收口后的判据：显式失败 + 主库零路由写入。
  const root = mkdtempSync(join(tmpdir(), "rai-import-route-fingerprint-run-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
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
    assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      // 收口后的失败批次不得往主库写任何路由或指纹。
      assert.equal((activated.prepare(`
        SELECT COUNT(*) AS count FROM route_points WHERE route_id = 'worker_route_new'
      `).get() as { count: number }).count, 0);
      assert.equal((activated.prepare(`
        SELECT COUNT(*) AS count FROM import_manifest WHERE key = 'source_gpx_bundle_sha256'
      `).get() as { count: number }).count, 0);
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

test("遗留重复 issue 的代际重建：无队列直跑 ⇒ 显式失败且 issue 投影与报告不动（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"重建 issue 代际（去重后只留 1 条）
  // ⇒ 候选链路一次 CLI 调用（不重算）后主库 issue 投影与审计报告一致"。代际重建与报告发布
  // 都住在候选链路里，已删除；issue 分类的覆盖由本文件直调用例（`classifies an … import
  // issue …` 系列）承担。收口后的判据：显式失败 + 主库 issue 投影保持 2 条 + 不发布报告。
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
    assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((activated.prepare("SELECT COUNT(*) AS count FROM import_issues").get() as { count: number }).count, 2,
        "收口后的失败批次不得改动主库 issue 投影");
    } finally {
      activated.close();
    }
    assert.equal(existsSync(join(root, "var", "reports", "data-audit.json")), false,
      "收口后的失败批次不得发布审计报告");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("收口后的失败批次：主库与两份审计报告一字节不动，且不留任何发布痕迹（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**（两条原用例合并到这一条）：
  //   · `keeps the active database and audit reports unchanged when import {recompute,activate} fails`
  //     —— 原判据注入候选链路的两种失败（CLI 抛错 / `installDatabase` 抛错）；两种注入点都已删除。
  //   · `rolls back the active database and both reports when audit report commit fails`
  //     —— 原判据包装 `stageAuditReports` 断言"pending 文件存在后提交失败"；收口后该包装根本
  //     不会被调用（假绿），其真正的安全属性（报告不得被改动、不得留下 .pending./.replaced.
  //     中间产物）并入本用例。
  // 收口后的判据：无队列直跑 ⇒ 显式失败；两份报告与主库 audit_marker 逐字节不动；
  // docs/var 下不得出现任何 .pending./.replaced. 中间产物与批次名临时文件。
  const root = mkdtempSync(join(tmpdir(), "rai-import-audit-closed-"));
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
  const job: Record<string, unknown> = {
    id: "web_import_audit_closed",
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
    assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
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
    assert.deepEqual(
      readdirSync(join(root, "var")).filter((name) => name.includes(job.id as string)),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("审计投影的对齐：无队列直跑 ⇒ 显式失败且投影与报告不动（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"audit-only 变更（inventory/manifest 对齐、
  // 不重算）⇒ 候选链路一次 CLI 调用后主库与报告一致"。投影发布与报告都是候选链路的动作，
  // 已删除；对齐分类的覆盖由本文件直调用例（`classifies an audit inventory/manifest change
  // as data-only`）承担。收口后的判据：显式失败 + 主库投影不动 + 不发布报告。
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
    assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const inventory = activated.prepare(`
        SELECT item_count AS itemCount FROM entity_inventory
        WHERE entity_kind = 'record' AND entity_type = 'HKQuantityTypeIdentifierBodyMass'
      `).get() as { itemCount: number };
      const recordCount = activated.prepare(
        "SELECT value FROM import_manifest WHERE key = 'record_count'"
      ).get() as { value: string };
      assert.equal(inventory.itemCount, 1, "收口后的失败批次不得改动主库投影");
      assert.equal(recordCount.value, "1");
    } finally {
      activated.close();
    }
    assert.equal(existsSync(join(root, "var", "reports", "data-audit.json")), false,
      "收口后的失败批次不得发布审计报告");
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

test("活动摘要变更：无队列直跑 ⇒ 显式失败且摘要不动（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"活动摘要变更（data-only 分类）⇒ 候选链路
  // 一次 CLI 调用后主库摘要被激活"。分类覆盖由本文件直调用例（`classifies an … activity
  // summary as data-only`）承担。收口后的判据：显式失败 + 主库摘要保持旧值。
  const root = mkdtempSync(join(tmpdir(), "rai-import-activity-summary-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.database.prepare(`
    INSERT INTO activity_summaries (date_components, attributes_json) VALUES (?, ?)
  `).run("2026-01-04", JSON.stringify({ activeEnergyBurned: 450 }));
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
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
    assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = activated.prepare(`
        SELECT attributes_json AS attributesJson FROM activity_summaries WHERE date_components = ?
      `).get("2026-01-04") as { attributesJson: string };
      assert.deepEqual(JSON.parse(row.attributesJson), { activeEnergyBurned: 450 },
        "收口后的失败批次不得改动活动摘要");
    } finally {
      activated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("data-only 健康变更：无队列直跑 ⇒ 显式失败且健康记录零写入（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"data-only 记录增量 ⇒ 候选链路照常激活
  // （importMode=incremental、跳过重算；终态清理在持久化之后才收尾）"。候选链路与它的终态
  // 清理编排都已删除；"data-only 增量真实入库 + 跳过重算"的覆盖由 `data-only-import-queue.test.ts`
  // （record-only 快通路）与 `import-worker-direct-sync.test.ts`（统一接收器）承担。
  // 收口后的判据：显式失败 + 主库零写入 + 时间线里不出现重算阶段。
  const root = mkdtempSync(join(tmpdir(), "rai-import-data-only-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  const job: Record<string, unknown> = {
    id: "web_import_data_only",
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
    const timing = assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
    assert.equal(timing.stagesMs.recompute, undefined, "收口后的失败批次不得触发重算");
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((activated.prepare(`
        SELECT COUNT(*) AS count FROM health_records WHERE id = 'worker_body_mass'
      `).get() as { count: number }).count, 0);
    } finally {
      activated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("仅新增 VO2 证据的批次：无队列直跑 ⇒ 显式失败且健康记录零写入（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"仅新增 VO2 ⇒ 候选 CLI 恰好一次重算
  // （commandCount==2、importMode=full）后主库出现该记录"。那条链路已删除；full/增量分类的
  // 覆盖由本文件直调用例（`uses full recompute when a scoring health record is inserted`）承担。
  // 收口后的判据：显式失败 + 主库零写入 + 时间线里不出现重算阶段。
  const root = mkdtempSync(join(tmpdir(), "rai-import-vo2-full-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
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
    const timing = assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
    assert.equal(timing.stagesMs.recompute, undefined, "收口后的失败批次不得触发重算");
    const activated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((activated.prepare(`
        SELECT COUNT(*) AS count FROM health_records WHERE id = 'worker_imported_vo2_max'
      `).get() as { count: number }).count, 0);
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

test("完整快照载荷：经排队入口显式失败 direct_sync_full_snapshot_unsupported（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例用 `captureCommand` 捕获候选 CLI 的
  // `--preserve-absent / --replace-absent` 参数，断言"缺省即保留、只有显式完整快照才允许
  // 缺省删除"。候选 CLI 已删除；该语义现在住在**车道判定**里（`payload_is_a_complete_snapshot`
  // 一票否决 → 稳定码 `direct_sync_full_snapshot_unsupported`）。判据换成：带完整快照清单的
  // 载荷经**排队入口**（本文件里唯一能越过 `not_queued` 的形态）必须显式失败、零禁止操作，
  // 且主库零写入。
  const root = mkdtempSync(join(tmpdir(), "rai-healthkit-preserve-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  mkdirSync(join(root, "export"));
  writeFileSync(join(root, "export", "export.xml"), "<HealthData />", "utf8");
  // 🔴 v1 + 完整快照 scope 是**唯一**能声明"缺省即删除"的清单形状：v2 清单的 scope 必须
  // 是 `healthkit`（其它值按"不可读"保守处理，`readSyncManifestScope`）。车道判定在解析
  // 载荷之前就拒绝它 —— 这条用例同时钉住"只有该形状可能打开删除语义"与"直连恒不收"。
  writeFileSync(join(root, "export", "sync-manifest.json"), JSON.stringify({
    version: 1, sourceScope: FULL_SNAPSHOT_SOURCE_SCOPE
  }), "utf8");
  const active = await seedCanonical(databasePath);
  active.close();
  const projectRoot = resolve(import.meta.dirname, "../../..");
  const worker = new ImportWorker(databasePath, projectRoot, root, undefined, undefined, undefined, {
    scope: "fixture", dataOnlyFastPath: true,
    admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
  });
  try {
    const before = new DatabaseSync(databasePath, { readOnly: true });
    const workoutsBefore = (before.prepare("SELECT COUNT(*) AS n FROM workouts").get() as { n: number }).n;
    before.close();
    const created = worker.create(join(root, "export"));
    await waitFor(() => !worker.hasPending && !worker.isRunning, 15_000);
    const stored = worker.get(created.id);
    assert.equal(stored?.status, "failed", String(stored?.error ?? ""));
    assert.equal(stored?.failureCode, "direct_sync_full_snapshot_unsupported");
    assert.equal(stored?.performance?.lane?.outcome, "fallback");
    assert.deepEqual(stored?.performance?.lane?.reasons, ["payload_is_a_complete_snapshot"]);
    const prohibitedStages = [...new Set(
      PROHIBITED_DIRECT_SYNC_OPERATIONS.flatMap((operation) => operation.stages)
    )] as (keyof ImportJobPerformance["stagesMs"])[];
    for (const stage of prohibitedStages) {
      assert.equal(stored?.performance?.stagesMs[stage], undefined, `${stage} must not run after S3.3`);
    }
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((preserved.prepare("SELECT COUNT(*) AS n FROM workouts").get() as { n: number }).n, workoutsBefore,
        "收口后的失败批次不得改动主库");
    } finally {
      preserved.close();
    }
  } finally {
    await worker.close();
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


test("失败批次公开层只给受控文案：无泄漏，且跨重启保持（S3.3：候选链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例让候选 CLI 触发"删除保护闸门"（60 个 workout
  // 的完整快照），断言公开文案是受控句、不泄漏内部细节、跨重启保持。CLI 与闸门的运行期调用链
  // 都已删除；保留的判据换成同一条**公开层纪律**在收口路径上的验证：通用受控 error、
  // 无路径/无 Error:/无 cli.ts 泄漏、主库原样、跨重启一致。（闸门自身的 IPC 解析仍由下一条
  // 直调用例覆盖。`failureCode` 目前不随任务持久化 —— 跨重启只保证 error/message。）
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
    const latest = worker.latest();
    assert.equal(latest?.status, "failed");
    assert.equal(latest?.error, PUBLIC_IMPORT_FAILURE_ERROR,
      "公开层只许给通用受控文案（内部诊断不出现）");
    assert.doesNotMatch(latest?.error ?? "", /rai-worker-removal-guard|Error:|cli\.ts/);
    const live = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((live.prepare("SELECT COUNT(*) AS n FROM workouts").get() as { n: number }).n, 60);
    } finally { live.close(); }
    const restarted = new ImportWorker(databasePath, projectRoot, root);
    try {
      assert.equal(restarted.latest()?.error, latest?.error,
        "失败结论必须跨重启保持（持久化的是内部 error；公开层再净化）");
    } finally { await restarted.close(); }
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// G4（2026-10-15）："rejects malformed guard IPC…" 用例已随 command() IPC 面退役 ——
// CLI 子进程链路删除后，该 IPC 通道与其 malformed-guard 分支不再存在。


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

test("displaced 回滚点回收：方法保留，仅对匹配前缀做一次性清理（S3.3：链路已删）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"提交成功后的导入回收
  // `<staging>.replaced.<uuid>` 回滚点（防 2026-09-15 的 36 GB 堆积）"。生成这些回滚点的
  // 候选链路已删除，但 `reclaimDisplacedImportDatabases` 方法保留（清理链上的
  // `terminalSucceeded` 守卫仍在，阶段 5 一并退役）。判据改为**直接调用**该方法：
  // 匹配前缀的文件被回收，不匹配的不动 —— 清理范围不许扩大。
  const root = mkdtempSync(join(tmpdir(), "rai-import-reclaim-displaced-"));
  const stagingDatabase = join(root, "var", "rai.importing.fixture.sqlite");
  mkdirSync(join(root, "var"));
  const importWorker = new ImportWorker(join(root, "rai.sqlite"), root, root);
  const worker = importWorker as unknown as ImportWorkerTestSurface;
  const displaced = [
    `${stagingDatabase}.replaced.77777777-7777-4777-8777-777777777777`,
    `${stagingDatabase}.replaced.88888888-8888-4888-8888-888888888888`
  ];
  const unrelated = join(root, "var", "rai.importing.other.sqlite.replaced.99999999-9999-4999-8999-999999999999");
  for (const path of [...displaced, unrelated]) writeFileSync(path, "pre-import database");
  try {
    await worker.reclaimDisplacedImportDatabases(stagingDatabase);
    for (const path of displaced) {
      assert.equal(existsSync(path), false, "匹配前缀的 displaced 回滚点必须被回收");
    }
    assert.equal(existsSync(unrelated), true, "不匹配前缀的文件不许被清理（清理范围不得扩大）");
  } finally {
    await importWorker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("未提交的批次不回收 displaced 回滚点（S3.3：回收守卫保留）", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"导入失败 ⇒ 发布者中途留下的
  // `<staging>.replaced.<uuid>` 必须保留（它可能是唯一的恢复点）"。候选链路已删除，但清理
  // 链上的 `terminalSucceeded` 守卫仍在（`...(terminalSucceeded ? [reclaim] : [])`）。
  // 本用例把 displaced 文件预先放在**确定性的 staging 路径**旁，跑一次必然失败的批次
  // （无队列直跑），断言它原样保留。
  const root = mkdtempSync(join(tmpdir(), "rai-import-keep-displaced-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const active = await seedCanonical(databasePath);
  active.close();
  const worker = new ImportWorker(databasePath, root, root) as unknown as ImportWorkerTestSurface;
  const jobId = "web_import_keep_displaced";
  const job: Record<string, unknown> = {
    id: jobId,
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath: join(root, "export")
  };
  // 无队列直跑的 staging 路径 = `var/rai.importing.<jobId>.sqlite`（attempt 后缀为空）。
  const kept = join(root, "var", `rai.importing.${jobId}.sqlite.replaced.88888888-8888-4888-8888-888888888888`);
  writeFileSync(kept, "pre-import database");
  try {
    await worker.run(job);
    assertRefusedByClosedLane(job, {
      failureCode: "direct_sync_internal_integrity", laneReasons: ["not_queued"]
    });
    assert.equal(existsSync(kept), true,
      "失败批次的清理链不得回收 displaced 回滚点（terminalSucceeded=false 一侧）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
