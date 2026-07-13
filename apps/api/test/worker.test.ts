import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/health-export-parser";

import {
  ExternalPredictionModelTrainer,
  ImportWorker,
  RecomputeWorker,
  predictionModelArtifactDirectory
} from "../src/worker.js";

interface ImportWorkerTestSurface {
  activateDatabase(stagingDatabase: string, jobId: string, existingBackupPath?: string | null): Promise<void>;
  preserveHistoricalState(stagingDatabase: string, previousDatabase: string): void;
  analyzeDatasetChange(stagingDatabase: string, previousDatabase: string): {
    mode: "unchanged" | "incremental" | "full";
    dirtyFromAt: string | null;
    insertedWorkouts: number;
  };
}

interface ExternalTrainerTestSurface {
  command(args: string[], signal?: AbortSignal): Promise<void>;
}

interface RecomputeWorkerTestSurface {
  runOneInWorkerThread(): Promise<boolean>;
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

test("cancelling prediction training terminates the Windows process tree", {
  skip: process.platform !== "win32"
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("recompute worker catches startup failures and stops after bounded retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-retry-"));
  const databasePath = join(root, "rai.sqlite");
  writeFileSync(databasePath, "fixture", "utf8");
  const worker = new RecomputeWorker(databasePath);
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
    assert.equal(job?.status, "failed");
    assert.equal(job?.phase, "interrupted");
    assert.match(job?.error ?? "", /restarted/);
    writeFileSync(join(root, "var", "import-jobs.json"), "[]", "utf8");
    const restarted = new ImportWorker(join(root, "rai.sqlite"), root, root);
    assert.equal(restarted.latest()?.id, "web_import_interrupted");
    assert.equal(existsSync(join(root, "var", "runtime.sqlite")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
