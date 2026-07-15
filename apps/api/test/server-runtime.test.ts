import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/health-export-parser";

import { DatabaseMaintenance } from "../src/maintenance.js";

const projectRoot = resolve(import.meta.dirname, "../../..");

async function removeRuntimeRoot(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError;
}

async function waitForApi(child: ChildProcess, url: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output() || `API exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/v1/health`);
      if (response.ok) return;
    } catch { /* API is still starting. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(output() || "API did not become ready");
}

async function stopApi(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null && child.stdout?.closed && child.stderr?.closed && !child.connected) return;
  const closed = new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
  const waitForClose = (timeoutMs: number): Promise<void> => {
    return new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("API shutdown timed out")), timeoutMs);
      closed.then(() => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  };
  if (child.connected) child.send("rai:shutdown");
  else child.kill("SIGTERM");
  try {
    await waitForClose(10_000);
  } catch (error) {
    child.kill("SIGKILL");
    await waitForClose(10_000).catch(() => {});
    throw error;
  }
}

test("runtime status includes persisted prediction work and restore recovers recompute jobs", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-runtime-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const store = await RaiDatabase.open(databasePath);
  const jobId = new RaiApplicationService(store).enqueueFullRecompute({
    evaluatedAt: "2026-07-15T00:00:00.000Z",
    timezoneIdentifier: "Asia/Shanghai"
  });
  store.database.prepare(`
    UPDATE recompute_jobs SET status = 'running', started_at = ? WHERE id = ?
  `).run("2026-07-15T00:00:00.000Z", jobId);
  const restoredPredictionId = "prediction_model_00000000-0000-4000-8000-000000000002";
  store.database.prepare(`
    INSERT INTO prediction_model_runs (
      id, algorithm, model_version, feature_schema_version, training_data_through_at,
      hyperparameters_json, request_json, status, worker_token, heartbeat_at, attempt_count
    ) VALUES (?, 'catboost', 'fixture', 'fixture', ?, '{}', '{}', 'running', ?, ?, 3)
  `).run(
    restoredPredictionId,
    "2026-07-15T00:00:00.000Z",
    "future-worker",
    "2099-01-01T00:00:00.000Z"
  );
  store.close();

  const maintenance = new DatabaseMaintenance(databasePath, runtimeRoot);
  const backup = await maintenance.createBackup("running-job");
  const current = new DatabaseSync(databasePath);
  current.prepare(`
    UPDATE recompute_jobs SET status = 'failed', completed_at = ? WHERE id = ?
  `).run("2026-07-15T00:01:00.000Z", jobId);
  current.prepare("UPDATE prediction_model_runs SET status = 'failed' WHERE id = ?").run(restoredPredictionId);
  current.close();

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: runtimeRoot,
      RAI_DATABASE: databasePath,
      RAI_API_PORT: String(port),
      RAI_LOG_LEVEL: "silent"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    await waitForApi(child, url, () => output);

    const predictionDatabase = new DatabaseSync(databasePath);
    predictionDatabase.prepare(`
      INSERT INTO prediction_model_runs (
        id, algorithm, model_version, feature_schema_version, training_data_through_at,
        hyperparameters_json, request_json, status, worker_token, heartbeat_at, attempt_count
      ) VALUES (?, 'catboost', 'fixture', 'fixture', ?, '{}', '{}', 'running', ?, ?, 1)
    `).run(
      "prediction_model_00000000-0000-4000-8000-000000000001",
      "2026-07-15T00:00:00.000Z",
      "fixture-worker",
      new Date().toISOString()
    );
    predictionDatabase.close();

    const runtimeStatus = await fetch(`${url}/v1/runtime-status`).then((response) => response.json()) as { busy: boolean };
    assert.equal(runtimeStatus.busy, true);

    const cleanupDatabase = new DatabaseSync(databasePath);
    cleanupDatabase.prepare("UPDATE prediction_model_runs SET status = 'failed' WHERE status = 'running'").run();
    cleanupDatabase.close();

    const idleDeadline = Date.now() + 5_000;
    let busy = true;
    while (Date.now() < idleDeadline) {
      busy = ((await fetch(`${url}/v1/runtime-status`).then((response) => response.json())) as { busy: boolean }).busy;
      if (!busy) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(busy, false);

    const restoreResponse = await fetch(`${url}/v1/backups/${backup.name}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "恢复此备份" })
    });
    assert.equal(restoreResponse.status, 200, await restoreResponse.text());

    const deadline = Date.now() + 10_000;
    let restoredStatus = "running";
    while (Date.now() < deadline) {
      const restored = new DatabaseSync(databasePath, { readOnly: true });
      restoredStatus = (restored.prepare("SELECT status FROM recompute_jobs WHERE id = ?").get(jobId) as { status: string }).status;
      restored.close();
      if (restoredStatus !== "running" && restoredStatus !== "queued") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.notEqual(restoredStatus, "running");
    assert.notEqual(restoredStatus, "queued");

    const predictionDeadline = Date.now() + 10_000;
    let restoredPredictionStatus = "running";
    while (Date.now() < predictionDeadline) {
      const restored = new DatabaseSync(databasePath, { readOnly: true });
      restoredPredictionStatus = (restored.prepare(
        "SELECT status FROM prediction_model_runs WHERE id = ?"
      ).get(restoredPredictionId) as { status: string }).status;
      restored.close();
      if (!['running', 'validating', 'queued'].includes(restoredPredictionStatus)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.ok(!['running', 'validating', 'queued'].includes(restoredPredictionStatus));
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("restore request fails and keeps the current database when job recovery fails", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-restore-rollback-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const store = await RaiDatabase.open(databasePath);
  store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
  const predictionId = "prediction_model_00000000-0000-4000-8000-000000000003";
  store.database.prepare(`
    INSERT INTO prediction_model_runs (
      id, algorithm, model_version, feature_schema_version, training_data_through_at,
      hyperparameters_json, request_json, status, worker_token, heartbeat_at, attempt_count
    ) VALUES (?, 'catboost', 'fixture', 'fixture', ?, '{}', '{}', 'running', ?, ?, 1)
  `).run(
    predictionId,
    "2026-07-15T00:00:00.000Z",
    "fixture-worker",
    "2026-07-15T00:00:00.000Z"
  );
  store.database.exec(`
    CREATE TRIGGER reject_prediction_recovery
    BEFORE UPDATE ON prediction_model_runs
    BEGIN
      SELECT RAISE(ABORT, 'simulated prediction recovery failure');
    END;
  `);
  store.close();

  const maintenance = new DatabaseMaintenance(databasePath, runtimeRoot);
  const backup = await maintenance.createBackup("recovery-failure");
  const current = new DatabaseSync(databasePath);
  current.exec("DROP TRIGGER reject_prediction_recovery; UPDATE marker SET value = 'current-version'");
  current.prepare("UPDATE prediction_model_runs SET status = 'failed' WHERE id = ?").run(predictionId);
  current.close();

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: runtimeRoot,
      RAI_DATABASE: databasePath,
      RAI_API_PORT: String(port),
      RAI_LOG_LEVEL: "silent"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    await waitForApi(child, url, () => output);
    const idleDeadline = Date.now() + 5_000;
    while (Date.now() < idleDeadline) {
      const status = await fetch(`${url}/v1/runtime-status`).then((result) => result.json()) as { busy: boolean };
      if (!status.busy) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    const response = await fetch(`${url}/v1/backups/${backup.name}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "恢复此备份" })
    });
    assert.equal(response.status, 500);

    const active = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((active.prepare("SELECT value FROM marker").get() as { value: string }).value, "current-version");
      assert.equal((active.prepare(
        "SELECT status FROM prediction_model_runs WHERE id = ?"
      ).get(predictionId) as { status: string }).status, "failed");
    } finally {
      active.close();
    }
    assert.equal((await fetch(`${url}/v1/health`)).status, 200);
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("database-backed writes cannot recreate a deleted database", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-delete-guard-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const store = await RaiDatabase.open(databasePath);
  store.close();

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: runtimeRoot,
      RAI_DATABASE: databasePath,
      RAI_API_PORT: String(port),
      RAI_LOG_LEVEL: "silent"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    await waitForApi(child, url, () => output);
    const idleDeadline = Date.now() + 5_000;
    while (Date.now() < idleDeadline) {
      const status = await fetch(`${url}/v1/runtime-status`).then((response) => response.json()) as { busy: boolean };
      if (!status.busy) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    const deletion = await fetch(`${url}/v1/database`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "删除我的 RAI 数据" })
    });
    assert.equal(deletion.status, 200, await deletion.text());
    assert.equal(existsSync(databasePath), false);

    const guardedRequests: Array<[string, RequestInit]> = [
      ["/v1/model-runs", { method: "POST" }],
      ["/v1/prediction-models/train", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }],
      ["/v1/training-zones/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          restingHeartRate: { mode: "auto", valueBpm: null },
          maximumHeartRate: { mode: "auto", valueBpm: null },
          lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null }
        })
      }],
      ["/v1/workouts/missing-session/override", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eligibilityOverride: null,
          statisticsParticipation: null,
          sessionType: null,
          performanceProtocol: null,
          rpe: null,
          conditionTags: [],
          note: null
        })
      }]
    ];
    for (const [path, init] of guardedRequests) {
      const response = await fetch(`${url}${path}`, init);
      const responseText = await response.text();
      assert.equal(response.status, 409, `${path}: ${responseText}`);
      const body = JSON.parse(responseText) as { code?: string };
      assert.equal(body.code, "database_not_ready");
      assert.equal(existsSync(databasePath), false, `${path} recreated the database`);
    }
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});
