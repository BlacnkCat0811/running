import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { acquireDatabasePublicationLock, RaiDatabase } from "@rai/storage-sqlite";
import yazl from "yazl";

import { DatabaseMaintenance } from "../src/maintenance.js";

const projectRoot = resolve(import.meta.dirname, "../../..");

async function zipBuffer(entries: Array<{ name: string; body: string }>): Promise<Buffer> {
  const archive = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  for (const entry of entries) archive.addBuffer(Buffer.from(entry.body), entry.name);
  const complete = new Promise<void>((resolveComplete, reject) => {
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on("end", resolveComplete);
    archive.outputStream.on("error", reject);
  });
  archive.end();
  await complete;
  return Buffer.concat(chunks);
}

function corruptFirstCompressedPayload(bytes: Buffer): Buffer {
  const corrupted = Buffer.from(bytes);
  assert.equal(corrupted.readUInt32LE(0), 0x04034b50);
  const compressedSize = corrupted.readUInt32LE(18);
  const payloadOffset = 30 + corrupted.readUInt16LE(26) + corrupted.readUInt16LE(28);
  assert.ok(compressedSize > 2);
  corrupted[payloadOffset + Math.floor(compressedSize / 2)]! ^= 0xff;
  return corrupted;
}

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

async function waitForBoundPort(child: ChildProcess, output: () => string): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(output() || "API did not report its bound port")), 20_000);
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      reject(new Error(output() || `API exited with ${code}`));
    };
    child.once("exit", onExit);
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" && message !== null &&
        (message as { type?: unknown }).type === "rai:ready" &&
        Number.isInteger((message as { port?: unknown }).port)
      ) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolvePort((message as { port: number }).port);
      }
    });
  });
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

test("prediction training reports a missing active ability baseline as a conflict", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-prediction-baseline-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const store = await RaiDatabase.open(databasePath, { createMigrationBackup: false });
  const insertSession = store.database.prepare(`
    INSERT INTO training_sessions (
      id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
      canonical_workout_id, status
    ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, ?, NULL, 'active')
  `);
  const insertOverride = store.database.prepare(`
    INSERT INTO workout_overrides (
      id, training_session_id, revision, session_type, performance_protocol,
      condition_tags_json, created_at
    ) VALUES (?, ?, 1, 'race', ?, '[]', '2023-12-31T00:00:00.000Z')
  `);
  store.database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric,
      start_at, end_at, metadata_json, raw_attributes_json
    ) VALUES (
      'prediction-vo2', 'HKQuantityTypeIdentifierVO2Max', 'Watch', 'apple_watch',
      'mL/min*kg', 50, '2023-12-01T00:00:00.000Z',
      '2023-12-01T00:00:01.000Z', '{}', '{}'
    )
  `).run();
  const fixtures = [
    { distance: 5, protocol: "five_k_time_trial", seconds: 1_500 },
    { distance: 10, protocol: "ten_k_time_trial", seconds: 3_100 },
    { distance: 21.0975, protocol: "half_marathon_race", seconds: 7_200 }
  ];
  for (let index = 0; index < 51; index += 1) {
    const fixture = fixtures[index % fixtures.length]!;
    const start = new Date(Date.UTC(2024, 0, 1 + index * 7)).toISOString();
    const end = new Date(Date.parse(start) + fixture.seconds * 1_000).toISOString();
    insertSession.run(`session-${index}`, start, end, fixture.distance);
    insertOverride.run(`override-${index}`, `session-${index}`, fixture.protocol);
  }
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
    const response = await fetch(`${url}/v1/prediction-models/train`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asOf: "2026-07-11T00:00:00.000Z" })
    });
    const responseText = await response.text();
    assert.equal(response.status, 409, responseText);
    const body = JSON.parse(responseText) as { code: string };
    assert.equal(body.code, "prediction_ability_baseline_unavailable");
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

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

    const runtimeStatus = await fetch(`${url}/v1/runtime-status`).then((response) => response.json()) as {
      busy: boolean;
      predictionModelJob: { id: string; status: string } | null;
    };
    assert.equal(runtimeStatus.busy, true);
    assert.equal(runtimeStatus.predictionModelJob?.id, "prediction_model_00000000-0000-4000-8000-000000000001");
    assert.equal(runtimeStatus.predictionModelJob?.status, "running");

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

test("HTTP restore remains available when the active database is corrupt at startup", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-corrupt-restore-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const store = await RaiDatabase.open(databasePath);
  store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
  store.close();
  const maintenance = new DatabaseMaintenance(databasePath, runtimeRoot);
  const backup = await maintenance.createBackup("corrupt-http-fixture");
  const corruptBytes = Buffer.from("not a sqlite database");
  writeFileSync(databasePath, corruptBytes);

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
    const degradedHealth = await fetch(`${url}/v1/health`).then((result) => result.json()) as {
      status: string;
      databaseReady: boolean;
    };
    assert.equal(degradedHealth.status, "recovery_required");
    assert.equal(degradedHealth.databaseReady, false);
    const runtimeResponse = await fetch(`${url}/v1/runtime-status`);
    assert.equal(runtimeResponse.status, 200, await runtimeResponse.clone().text());
    const degradedRuntime = await runtimeResponse.json() as {
      databaseReady: boolean;
      recomputeJob: unknown;
      predictionModelJob: unknown;
    };
    assert.equal(degradedRuntime.databaseReady, false);
    assert.equal(degradedRuntime.recomputeJob, null);
    assert.equal(degradedRuntime.predictionModelJob, null);
    for (const path of [
      "/v1/prediction-models",
      "/v1/prediction-models/prediction_model_00000000-0000-4000-8000-000000000000"
    ]) {
      const readResponse = await fetch(`${url}${path}`);
      assert.equal(readResponse.status, 409, `${path}: ${await readResponse.text()}`);
    }
    assert.deepEqual(readFileSync(databasePath), corruptBytes);
    const response = await fetch(`${url}/v1/backups/${backup.name}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "恢复此备份" })
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const body = JSON.parse(responseText) as { safetyBackup: unknown };
    assert.equal(body.safetyBackup, null);
    const restoredHealth = await fetch(`${url}/v1/health`).then((result) => result.json()) as {
      status: string;
      databaseReady: boolean;
    };
    assert.equal(restoredHealth.status, "ok");
    assert.equal(restoredHealth.databaseReady, true);

    const active = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((active.prepare("SELECT value FROM marker").get() as { value: string }).value, "backup-version");
    } finally {
      active.close();
    }
    assert.deepEqual((await maintenance.listBackups()).map((candidate) => candidate.name), [backup.name]);
    const quarantined = readdirSync(maintenance.quarantineDirectory)
      .find((candidate) => candidate.includes("before-restore-corrupt") && candidate.endsWith(".sqlite"));
    assert.ok(quarantined);
    assert.deepEqual(readFileSync(join(maintenance.quarantineDirectory, quarantined)), corruptBytes);
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("API quarantines a corrupt runtime state database and still starts", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-corrupt-runtime-state-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const store = await RaiDatabase.open(databasePath);
  store.close();
  writeFileSync(join(runtimeRoot, "var", "runtime.sqlite"), "not a sqlite database");

  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: runtimeRoot,
      RAI_DATABASE: databasePath,
      RAI_API_PORT: "0",
      RAI_LOG_LEVEL: "silent"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const boundPort = await waitForBoundPort(child, () => output);
    const health = await fetch(`http://127.0.0.1:${boundPort}/v1/health`).then(
      (response) => response.json()
    ) as { databaseReady: boolean };
    assert.equal(health.databaseReady, true);
    assert.equal(
      readdirSync(join(runtimeRoot, "var")).some((name) => name.startsWith("runtime.sqlite.corrupt-")),
      true
    );
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
    const deletionText = await deletion.text();
    assert.equal(deletion.status, 200, deletionText);
    const deletionBody = JSON.parse(deletionText) as {
      preservation: { kind: string; backup?: { name: string } };
    };
    assert.equal(deletionBody.preservation.kind, "backup");
    assert.ok(deletionBody.preservation.backup?.name);
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

test("dynamic-port startup reports readiness and workout overrides preserve service result", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-override-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const store = await RaiDatabase.open(databasePath);
  store.database.prepare(`
    INSERT INTO workouts (
      id, activity_type, source_name, source_category, source_version, device,
      start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json,
      is_canonical
    ) VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture', 'apple_watch',
      '1', 'Watch', ?, ?, 1800, 0, '{}', '{}', 1)
  `).run("workout_override_fixture", "2026-07-16T00:00:00.000Z", "2026-07-16T00:30:00.000Z");
  store.database.prepare(`
    INSERT INTO training_sessions (
      id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
      canonical_workout_id, status
    ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 5, ?, 'active')
  `).run(
    "session_override_fixture",
    "2026-07-16T00:00:00.000Z",
    "2026-07-16T00:30:00.000Z",
    "workout_override_fixture"
  );
  store.close();

  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: runtimeRoot,
      RAI_DATABASE: databasePath,
      RAI_API_PORT: "0",
      RAI_LOG_LEVEL: "silent"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    const boundPort = await waitForBoundPort(child, () => output);
    assert.ok(boundPort > 0);
    const url = `http://127.0.0.1:${boundPort}`;
    await waitForApi(child, url, () => output);
    assert.throws(
      () => acquireDatabasePublicationLock(databasePath, "cli"),
      /Another api process is using/
    );
    const payload = {
      eligibilityOverride: null,
      statisticsParticipation: null,
      sessionType: "race",
      performanceProtocol: "five_k_time_trial",
      rpe: 8,
      conditionTags: ["fixture"],
      note: "HTTP contract fixture"
    };

    const missing = await fetch(`${url}/v1/workouts/missing-session/override`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const missingText = await missing.text();
    assert.equal(missing.status, 404, missingText);
    assert.equal((JSON.parse(missingText) as { code: string }).code, "request_error");

    const response = await fetch(`${url}/v1/workouts/session_override_fixture/override`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const result = JSON.parse(responseText) as { overrideId: string; jobId: string };
    assert.match(result.overrideId, /^workout_override_/);
    assert.match(result.jobId, /^recompute_job_/);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const persistedOverride = database.prepare(
        "SELECT id FROM workout_overrides WHERE training_session_id = ?"
      ).get("session_override_fixture") as { id: string };
      assert.equal(result.overrideId, persistedOverride.id);
      const persistedJob = database.prepare("SELECT id FROM recompute_jobs WHERE id = ?")
        .get(result.jobId) as { id: string };
      assert.equal(result.jobId, persistedJob.id);
    } finally {
      database.close();
    }
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("upload HTTP errors distinguish limits, invalid archives, and internal I/O failures", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-upload-errors-"));
  mkdirSync(join(runtimeRoot, "var"));
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: runtimeRoot,
      RAI_DATABASE: join(runtimeRoot, "var", "rai.sqlite"),
      RAI_API_PORT: "0",
      RAI_IMPORT_MAX_ZIP_BYTES: String(64 * 1024),
      RAI_LOG_LEVEL: "silent"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  const upload = async (bytes: Uint8Array): Promise<Response> => {
    const body = new FormData();
    const contents = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(contents).set(bytes);
    body.append("file", new Blob([contents], { type: "application/zip" }), "health.zip");
    return fetch(`${url}/v1/imports/uploads`, { method: "POST", body });
  };
  let url = "";
  try {
    const boundPort = await waitForBoundPort(child, () => output);
    url = `http://127.0.0.1:${boundPort}`;
    await waitForApi(child, url, () => output);

    const oversized = await upload(new Uint8Array(128 * 1024));
    assert.equal(oversized.status, 413, await oversized.text());

    const invalid = await upload(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]));
    const invalidText = await invalid.text();
    assert.equal(invalid.status, 400, invalidText);
    assert.equal((JSON.parse(invalidText) as { code: string }).code, "invalid_import_archive");

    const emptyZip = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);
    const missingExport = await upload(emptyZip);
    const missingExportText = await missingExport.text();
    assert.equal(missingExport.status, 400, missingExportText);
    assert.equal((JSON.parse(missingExportText) as { code: string }).code, "invalid_import_archive");

    const validArchive = await zipBuffer([{
      name: "apple_health_export/export.xml",
      body: `<HealthData>${"payload".repeat(2_000)}</HealthData>`
    }]);
    const corruptPayload = await upload(corruptFirstCompressedPayload(validArchive));
    const corruptPayloadText = await corruptPayload.text();
    assert.equal(corruptPayload.status, 400, corruptPayloadText);
    assert.equal((JSON.parse(corruptPayloadText) as { code: string }).code, "invalid_import_archive");

    const duplicatePaths = await upload(await zipBuffer([
      { name: "apple_health_export/export.xml", body: "<HealthData/>" },
      { name: "apple_health_export/export.xml", body: "<HealthData duplicate=\"true\"/>" }
    ]));
    const duplicatePathsText = await duplicatePaths.text();
    assert.equal(duplicatePaths.status, 400, duplicatePathsText);
    assert.equal((JSON.parse(duplicatePathsText) as { code: string }).code, "invalid_import_archive");

    const failedImportUpload = await upload(await zipBuffer([{
      name: "apple_health_export/export.xml",
      body: "not valid XML"
    }]));
    assert.equal(failedImportUpload.status, 200, await failedImportUpload.clone().text());
    const { sourceId } = await failedImportUpload.json() as { sourceId: string };
    const created = await fetch(`${url}/v1/import-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId })
    });
    assert.equal(created.status, 200, await created.clone().text());
    const createdJob = await created.json() as { id: string; sourceId?: string };
    const importJobId = createdJob.id;
    assert.equal(createdJob.sourceId, sourceId);
    let failedJob: { status: string } | null = null;
    const terminalDeadline = Date.now() + 15_000;
    while (Date.now() < terminalDeadline) {
      failedJob = await fetch(`${url}/v1/import-jobs/${importJobId}`).then(
        (response) => response.json()
      ) as { status: string };
      if (!["queued", "running"].includes(failedJob.status)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(failedJob?.status, "failed");
    const latestJob = await fetch(`${url}/v1/import-jobs/latest`);
    assert.equal(latestJob.status, 200, await latestJob.clone().text());
    assert.deepEqual(await latestJob.json(), {
      ...(await fetch(`${url}/v1/import-jobs/${importJobId}`).then((response) => response.json()) as object)
    });
    assert.equal(await fetch(`${url}/v1/import-jobs/active`).then((response) => response.json()), null);
    const cleanedSource = await fetch(`${url}/v1/import-sources/${sourceId}`, { method: "DELETE" });
    assert.equal(cleanedSource.status, 404, await cleanedSource.text());

    const importsPath = join(runtimeRoot, "var", "imports");
    rmSync(importsPath, { recursive: true, force: true });
    writeFileSync(importsPath, "blocks upload directory creation");
    const ioFailure = await upload(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]));
    const ioText = await ioFailure.text();
    assert.equal(ioFailure.status, 500, ioText);
    assert.deepEqual(JSON.parse(ioText), {
      code: "internal_error",
      message: "本地服务处理请求失败"
    });
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("training-zone HTTP errors expose only typed client failures", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-zone-errors-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const store = await RaiDatabase.open(databasePath);
  store.database.exec(`
    CREATE TRIGGER reject_zone_insert
    BEFORE INSERT ON training_zone_profile_settings
    BEGIN
      SELECT RAISE(ABORT, 'secret zone persistence failure');
    END;
  `);
  store.close();

  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: runtimeRoot,
      RAI_DATABASE: databasePath,
      RAI_API_PORT: "0",
      RAI_LOG_LEVEL: "silent"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    const boundPort = await waitForBoundPort(child, () => output);
    const url = `http://127.0.0.1:${boundPort}`;
    await waitForApi(child, url, () => output);
    const request = async (payload: object): Promise<Response> => fetch(`${url}/v1/training-zones/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const settings = (expectedRevision: number, resting = 100, maximum = 120): object => ({
      expectedRevision,
      restingHeartRate: { mode: "manual", valueBpm: resting },
      maximumHeartRate: { mode: "manual", valueBpm: maximum },
      lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null }
    });

    const invalid = await request(settings(0));
    const invalidText = await invalid.text();
    assert.equal(invalid.status, 400, invalidText);
    assert.equal((JSON.parse(invalidText) as { code: string }).code, "invalid_training_zone_profile");

    const conflict = await request(settings(1, 60, 180));
    const conflictText = await conflict.text();
    assert.equal(conflict.status, 409, conflictText);
    assert.equal((JSON.parse(conflictText) as { code: string }).code, "training_zone_profile_revision_conflict");

    const internal = await request(settings(0, 60, 180));
    const internalText = await internal.text();
    assert.equal(internal.status, 500, internalText);
    assert.deepEqual(JSON.parse(internalText), {
      code: "internal_error",
      message: "本地服务处理请求失败"
    });
    assert.doesNotMatch(internalText, /secret zone persistence failure/);
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});
