import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { acquireDatabasePublicationLock, RaiDatabase } from "@rai/storage-sqlite";
import yazl from "yazl";

import { DatabaseMaintenance } from "../src/maintenance.js";
import { ImportPublicationJournal, readImportReceipt, writeImportReceipt } from "../src/import-publication.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { mobileLocalDate } from "../src/data.js";
import { weeklyPlanDates } from "../src/weekly-plan-service.js";
import { seedRecentRunningWeeks } from "./weekly-training-fixture.js";
import { prescriptionDigest } from "../src/plan-digest.js";

const projectRoot = resolve(import.meta.dirname, "../../..");

test("coach-loop opt-in uses real main/control stores, feedback changes the fact token, legacy execution is blocked", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-coach-loop-http-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  (await RaiDatabase.open(databasePath)).close();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot, env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    const read = async () => {
      const response = await fetch(url + "/v1/mobile/coach-loop");
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const handshake = await fetch(url + "/v1/handshake").then(r => r.json());
    assert.equal(handshake.coachLoopContractVersion, 1);
    const operationScope = { serverId: handshake.serverId, athleteId: handshake.athleteId, datasetEpoch: handshake.datasetEpoch };
    const post = (path: string, payload: unknown) => fetch(url + path, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const initial = await read();
    const enabled = await post("/v1/mobile/coach-loop", { contractVersion: 1, operationId: randomUUID(), operationScope,
      action: "enable", expectedRevision: initial.revision, expectedFactsHash: initial.factsHash,
      acceptedPolicyHash: initial.policyHash, settings: { mode: "daily_adaptive", runningDays: [1,2,3,4,5,6,7],
        longRunDays: [7], targetType: "pace", availabilityMinutesByWeekday: {}, race: null } });
    assert.equal(enabled.status, 200, await enabled.clone().text());
    const beforeFeedback = await read();
    const feedback = await post("/v1/mobile/coach-feedback", { operationId: randomUUID(), operationScope,
      id: "current-rest", expectedRevision: 0, action: "save", consent: true,
      fields: { phase: "pre_run", workoutId: null, fatigue: null, soreness: null, discomfort: null,
        requestedAction: "rest", interruptionReason: null, replacementReason: null, rpeOverrideRef: null,
        observedAt: new Date().toISOString() } });
    assert.equal(feedback.status, 200, await feedback.clone().text());
    const afterFeedback = await read();
    assert.notEqual(afterFeedback.factsHash, beforeFeedback.factsHash);
    assert.equal(afterFeedback.revision, beforeFeedback.revision, "GET safety downgrade does not publish a goals revision");
    assert.equal(afterFeedback.today.executable, false);
    assert.equal(afterFeedback.feedback.restRequested, true);
    for (const path of ["/v1/mobile/today", "/v1/mobile/workout-plan", "/v1/mobile/training-plan-state"])
      assert.equal((await fetch(url + path)).status, 409, "old consumers cannot misinterpret S/H or run stale courses");
    const summary = await post("/v1/mobile/coach-prediction-refresh", { operationScope });
    assert.equal(summary.status, 200, await summary.clone().text());
    assert.equal((await summary.json()).status, "summary_unavailable");
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("Run Coach routes enforce managed plans, CAS, pause exports and the return to manual planning", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-run-coach-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  (await RaiDatabase.open(databasePath)).close();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot, env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "",
      RAI_SERVER_ID: "local", RAI_ATHLETE_ID: "athlete_1", RAI_DATASET_EPOCH: "default" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    const read = async (path: string) => (await fetch(url + path)).json();
    const mutate = async (path: string, body: object, method = "POST") => fetch(url + path, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const config = { goal: "fitness", raceDate: null, raceDistanceKm: null, targetTimeSeconds: null,
      runningDays: [1, 2, 4, 6, 7], longRunDays: [7], targetType: "pace", strengthTraining: false };
    const goals = await read("/v1/mobile/goals");
    const start = await mutate("/v1/mobile/run-coach", { expectedRevision: goals.revision, action: "start", config });
    assert.equal(start.status, 200, await start.clone().text());
    let coach = await start.json();
    assert.equal(coach.plan.status, "active");
    assert.equal((await mutate("/v1/mobile/goals", { expectedRevision: coach.revision, runCoach: null }, "PUT")).status, 400);
    for (const path of ["/v1/mobile/workout-plan/generate", "/v1/mobile/workout-plan/preview"]) {
      assert.equal((await mutate(path, { expectedRevision: coach.revision })).status, 409);
    }
    const manual = await mutate("/v1/mobile/goals", { expectedRevision: coach.revision, weekPlan: [] }, "PUT");
    assert.equal(manual.status, 409);
    assert.equal((await manual.json()).code, "run_coach_managed");
    const pause = await mutate("/v1/mobile/run-coach", { expectedRevision: coach.revision, action: "pause" });
    assert.equal(pause.status, 200); coach = await pause.json();
    assert.equal((await read("/v1/mobile/today")).nextSession.kind, "rest");
    assert.ok((await read("/v1/mobile/workout-plan")).days.every((day: { executable: boolean }) => !day.executable));
    assert.equal((await mutate("/v1/mobile/run-coach", { expectedRevision: coach.revision - 1, action: "resume" })).status, 409);
    const end = await mutate("/v1/mobile/run-coach", { expectedRevision: coach.revision, action: "end" });
    assert.equal(end.status, 200); coach = await end.json();
    const preview = await mutate("/v1/mobile/workout-plan/preview", { expectedRevision: coach.revision });
    assert.equal(preview.status, 200, await preview.clone().text());
    const candidate = await preview.json();
    assert.ok(candidate.days.some((day: { kind: string }) => day.kind !== "rest"));
    const confirm = await mutate("/v1/mobile/workout-plan/confirm", { candidateId: candidate.candidateId, expectedRevision: candidate.revision });
    assert.equal(confirm.status, 200, await confirm.clone().text());
    assert.equal((await read("/v1/mobile/goals")).runCoach, null);
    assert.ok((await read("/v1/mobile/workout-plan")).days.some((day: { executable: boolean }) => day.executable));
    const currentGoals = await read("/v1/mobile/goals");
    const localDate = weeklyPlanDates(mobileLocalDate())[1]!;
    const shortManualStructure = {
      warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: null },
      blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "time", seconds: 600 }, alert: null }] }],
      cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: null }
    };
    const shortManual = await mutate("/v1/mobile/goals", { expectedRevision: currentGoals.revision,
      weekPlan: [
        { localDate: mobileLocalDate(), kind: "rest", distanceKm: null, structure: null, reason: "explicit manual rest today" },
        { localDate, kind: "easy", distanceKm: 3.3, structure: shortManualStructure, reason: "explicit manual short" }
      ] }, "PUT");
    assert.equal(shortManual.status, 200, await shortManual.clone().text());
    assert.equal((await shortManual.json()).weekPlanAudit.generatedBy, "manual");
    const manualExport = (await read("/v1/mobile/workout-plan")).days.find((day: { localDate: string }) => day.localDate === localDate);
    assert.equal(manualExport?.source, "manual");
    assert.equal(manualExport?.durationMinutes, 20);
    assert.equal(manualExport?.executable, true, "the automatic-dose policy must not silently relabel a saved manual short session");
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("manual plan validation derives capacity from the race target being saved", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-candidate-capacity-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  const today = mobileLocalDate();
  await seedRecentRunningWeeks(databasePath, today, 30);
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot, env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    const put = (body: object) => fetch(`${url}/v1/mobile/goals`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const dates = weeklyPlanDates(today, 98);
    const raceTarget = { date: dates[90]!, distance: "five_k", targetPaceSecondsPerKm: null };
    const targetSave = await put({ raceTarget });
    assert.equal(targetSave.status, 200, await targetSave.clone().text());
    let goals = await targetSave.json();
    const nextMonday = dates.slice(1, 8).find(date => new Date(`${date}T00:00:00Z`).getUTCDay() === 1)!;
    const weekPlan = weeklyPlanDates(nextMonday, 4).map(localDate => ({ localDate, kind: "easy", distanceKm: 5 }));
    const removeRace = await put({ expectedRevision: goals.revision, raceTarget: null, weekPlan });
    assert.equal(removeRace.status, 200, await removeRace.clone().text());
    goals = await removeRace.json();
    assert.equal(goals.raceTarget, null);
    assert.equal(goals.weekPlan.reduce((sum: number, day: { distanceKm: number | null }) => sum + (day.distanceKm ?? 0), 0), 20);
    const addRace = await put({ expectedRevision: goals.revision, raceTarget, weekPlan });
    assert.equal(addRace.status, 422, await addRace.clone().text());
    assert.equal((await addRace.json()).code, "plan_policy_violation");
    const unchanged = await (await fetch(`${url}/v1/mobile/goals`)).json();
    assert.equal(unchanged.revision, goals.revision, "a rejected candidate cannot partially persist its target");
    assert.equal(unchanged.raceTarget, null);
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("restore and deletion reject a committed import whose acknowledgement is still pending", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-pending-publication-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  const state = new RuntimeStateStore(runtimeRoot);
  const store = await RaiDatabase.open(databasePath);
  store.close();
  const backup = await new DatabaseMaintenance(databasePath, runtimeRoot).createBackup("before-import");
  const summary = {
    importMode: "full" as const, insertedWorkouts: 0, updatedWorkouts: 0, removedWorkouts: 0,
    unchangedWorkouts: 0, routesUpdated: 0, featuresReused: 0, featuresRecomputed: 0,
    modelReplayFrom: null, durationMs: 0, backupName: backup.name
  };
  writeImportReceipt(databasePath, "pending-ack", summary);
  const journal = new ImportPublicationJournal(databasePath, runtimeRoot);
  journal.prepare("pending-ack", join(runtimeRoot, "var/backups/rai.import-rollback.fixture.sqlite"), true);
  journal.commit("pending-ack");
  state.upsertJob({
    id: "pending-ack", status: "succeeded", phase: "completed", message: "",
    createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    error: null, inputPath: runtimeRoot,
    queue: { scope: JSON.stringify(["local", "athlete_1", "default"]), attempts: 1, finalized: false }
  });
  const runtime = new DatabaseSync(state.path);
  runtime.exec(`CREATE TRIGGER fail_publication_ack BEFORE DELETE ON import_publications
    BEGIN SELECT RAISE(ABORT, 'fixture acknowledgement unavailable'); END`);
  runtime.close();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "",
      RAI_SERVER_ID: "local", RAI_ATHLETE_ID: "athlete_1", RAI_DATASET_EPOCH: "default"
    },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    for (const [method, path, confirmation, message] of [
      ["POST", `/v1/backups/${backup.name}/restore`, "恢复此备份", "任务执行期间不能恢复数据库"],
      ["DELETE", "/v1/database", "删除我的 RAI 数据", "任务执行期间不能删除数据库"]
    ] as const) {
      const response = await fetch(`${url}${path}`, {
        method, headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation })
      });
      const body = await response.json() as { message: string };
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.message, message, "maintenance guard, not transient writer contention, must reject");
    }
    assert.equal(state.job("pending-ack")?.queue?.finalized, false);
    assert.equal(journal.has("pending-ack"), true);
    assert.deepEqual(readImportReceipt(databasePath, "pending-ack"), summary);
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

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
  // Parallel full-suite runs share the CPU with many real API child processes;
  // keep the window generous so slow tsx/onnx startup does not flake.
  const deadline = Date.now() + 60_000;
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
    const timer = setTimeout(() => reject(new Error(output() || "API did not report its bound port")), 60_000);
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
  const closed = new Promise<void>((resolvePromise) => {
    const resolveIfClosed = (): void => {
      if (child.exitCode !== null && child.stdout?.closed && child.stderr?.closed && !child.connected) {
        resolvePromise();
      }
    };
    child.once("close", () => resolvePromise());
    resolveIfClosed();
  });
  const waitForClose = (timeoutMs: number): Promise<void> => {
    return new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("API shutdown timed out")), timeoutMs);
      closed.then(() => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  };
  try {
    // Fire-and-forget: `connected` can flip between the check and the send, and with
    // no callback that failure is emitted as an 'error' event on the child, which no
    // listener would catch. Passing a callback routes it here instead; the shutdown
    // signal is advisory and the SIGTERM/SIGKILL path below still applies.
    if (child.connected) child.send("rai:shutdown", () => {});
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  try {
    await waitForClose(10_000);
  } catch (error) {
    if (process.platform === "win32" && child.pid !== undefined) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      await new Promise<void>((resolvePromise) => killer.once("close", () => resolvePromise()));
    } else {
      child.kill("SIGKILL");
    }
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
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
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
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
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

    const idleDeadline = Date.now() + 15_000;
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
      try {
        restoredStatus = (restored.prepare(
          "SELECT status FROM recompute_jobs WHERE id = ?"
        ).get(jobId) as { status: string }).status;
      } catch (error) {
        if (!/database is locked/i.test(error instanceof Error ? error.message : String(error))) throw error;
      } finally {
        restored.close();
      }
      if (restoredStatus !== "running" && restoredStatus !== "queued") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.notEqual(restoredStatus, "running");
    assert.notEqual(restoredStatus, "queued");

    const predictionDeadline = Date.now() + 10_000;
    let restoredPredictionStatus = "running";
    while (Date.now() < predictionDeadline) {
      const restored = new DatabaseSync(databasePath, { readOnly: true });
      try {
        restoredPredictionStatus = (restored.prepare(
          "SELECT status FROM prediction_model_runs WHERE id = ?"
        ).get(restoredPredictionId) as { status: string }).status;
      } catch (error) {
        if (!/database is locked/i.test(error instanceof Error ? error.message : String(error))) throw error;
      } finally {
        restored.close();
      }
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
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
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

    await stopApi(child);
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
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    const epochBefore = (await fetch(`${url}/v1/handshake`).then(result => result.json()) as { datasetEpoch: string }).datasetEpoch;
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
    const epochAfter = (await fetch(`${url}/v1/handshake`).then(result => result.json()) as { datasetEpoch: string }).datasetEpoch;
    assert.equal(epochAfter, epochBefore, "a rolled-back restore must preserve the current scope");
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
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
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
      // A metadata-only mutation: it deliberately does not take the main
      // database lock (it writes the separate goals store), but it *reads* the
      // main database, so an absent database must still surface as the same 409
      // rather than as an internal error.
      ["/v1/mobile/workout-plan/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
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

test("startup foreign-key failure cannot be bypassed by the request hot-open policy", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-fk-recovery-boundary-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  (await RaiDatabase.open(databasePath)).close();
  const damaged = new DatabaseSync(databasePath);
  try {
    damaged.exec("PRAGMA foreign_keys = OFF");
    damaged.prepare(`
      INSERT INTO workout_statistics (workout_id, ordinal, type)
      VALUES ('missing-workout', 1, 'fixture')
    `).run();
  } finally {
    damaged.close();
  }

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
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    const health = await fetch(`${url}/v1/health`).then((response) => response.json()) as {
      databaseReady: boolean;
      status: string;
    };
    assert.equal(health.databaseReady, false);
    assert.equal(health.status, "recovery_required");

    const write = await fetch(`${url}/v1/model-runs`, { method: "POST" });
    assert.equal(write.status, 500);
    const verify = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((verify.prepare(`
        SELECT COUNT(*) AS count FROM workout_statistics WHERE workout_id = 'missing-workout'
      `).get() as { count: number }).count, 1);
      assert.equal((verify.prepare(`
        SELECT COUNT(*) AS count FROM recompute_jobs
      `).get() as { count: number }).count, 0);
    } finally {
      verify.close();
    }
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("weekly coach generation ignores legacy model settings and performs no upstream requests", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-rule-plan-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  (await RaiDatabase.open(databasePath)).close();
  let upstreamCalls = 0;
  const upstream = createServer((request, response) => {
    request.resume();
    upstreamCalls += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: '{"days":[]}' }, finish_reason: "stop" }] }));
  });
  await new Promise<void>(resolveListen => upstream.listen(0, "127.0.0.1", resolveListen));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_CONTROL_DATABASE: join(runtimeRoot, "var/rai-control.sqlite"), RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "",
      RAI_LLM_API_KEY: "fixture-key", RAI_LLM_PROVIDER: "fixture", RAI_LLM_MODEL: "fixture-model",
      RAI_LLM_BASE_URL: 'http://127.0.0.1:' + upstreamAddress.port, RAI_LLM_MAX_TOKENS: "8192" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = 'http://127.0.0.1:' + await waitForBoundPort(child, () => output);
    await waitForApi(child, url, () => output);
    const post = (path: string, body: object) => fetch(url + path, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const goals = await fetch(url + "/v1/mobile/goals").then(response => response.json()) as import("@rai/api-contracts").MobileGoalsResponse;
    const first = await post("/v1/mobile/workout-plan/preview", { expectedRevision: goals.revision });
    assert.equal(first.status, 200);
    const preview = await first.json() as import("@rai/api-contracts").MobileWeeklyPlanPreviewResponse;
    const repeated = await post("/v1/mobile/workout-plan/preview", { expectedRevision: goals.revision });
    assert.equal(repeated.status, 200);
    const repeatedPreview = await repeated.json() as typeof preview;
    assert.deepEqual(preview.days, repeatedPreview.days);
    assert.equal(preview.audit.generatedBy, "heuristic");
    assert.equal(preview.audit.model, null);
    assert.equal(preview.audit.promptVersion, null);
    assert.ok(preview.warnings.every(warning => !/模型|回退|RAI_LLM/.test(warning)));
    assert.ok(preview.days.every(day => !/模型|回退/.test(day.reason ?? "")));
    const confirmed = await post("/v1/mobile/workout-plan/confirm", { candidateId: preview.candidateId, expectedRevision: preview.revision });
    assert.equal(confirmed.status, 200, await confirmed.text());
    const legacy = await post("/v1/mobile/workout-plan/generate", { expectedRevision: goals.revision + 1 });
    assert.equal(legacy.status, 200);
    const generated = await legacy.json() as import("@rai/api-contracts").MobileWeeklyPlanGenerationResponse;
    assert.equal(generated.audit.generatedBy, "heuristic");
    assert.equal(generated.audit.model, null);
    assert.equal(upstreamCalls, 0, "legacy model settings must never cause a network request");
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await new Promise<void>(resolveClose => upstream.close(() => resolveClose()));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("startup retires legacy future plans and only preview confirmation enables them again", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-rule-plan-transition-http-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  const controlPath = join(runtimeRoot, "var/rai-control.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  (await RaiDatabase.open(databasePath)).close();
  const today = mobileLocalDate();
  const dates = weeklyPlanDates(today, 30);
  const seed = new MobileGoalsStore(runtimeRoot, controlPath);
  const original = seed.write({ weekPlan: [today, dates[1]!, dates[29]!].map(localDate => ({
    localDate, kind: "easy", distanceKm: 8, reason: "已保存的旧处方"
  })), weekPlanAudit: { generatedBy: "llm", model: "legacy:model", promptVersion: "legacy-v1", generatedAt: null } }, { prescription: null });
  seed.close();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot, env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_CONTROL_DATABASE: controlPath, RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    const getGoals = async () => await fetch(`${url}/v1/mobile/goals`).then(response => response.json()) as import("@rai/api-contracts").MobileGoalsResponse;
    const post = (path: string, body: object, method = "POST") => fetch(`${url}/v1/mobile/${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const pending = await getGoals();
    assert.equal(pending.revision, original.revision + 1);
    assert.equal(pending.weekPlanReplanRequired, true);
    assert.deepEqual(pending.weekPlan, original.weekPlan.filter(day => day.localDate === today));
    const plan = await fetch(`${url}/v1/mobile/workout-plan`).then(response => response.json()) as import("@rai/api-contracts").MobileWorkoutPlanResponse;
    const getToday = async () => await fetch(`${url}/v1/mobile/today`).then(response => response.json()) as import("@rai/api-contracts").MobileTodayResponse;
    const retainedToday = await getToday();
    assert.equal(retainedToday.nextSession.distanceKm, 8, "migration must preserve the actual today's prescription, not just storage");
    assert.equal(plan.days[0]?.distanceKm, 8, "WorkoutKit must receive the same preserved prescription");
    assert.equal(plan.days[0]?.executable, true);
    assert.ok(plan.days.filter(day => day.localDate > today).every(day => !day.executable && day.structure === null));
    for (const [path, body, method] of [
      ["workout-plan/generate", { expectedRevision: pending.revision }, "POST"],
      ["goals", { expectedRevision: pending.revision, weekPlan: original.weekPlan }, "PUT"]
    ] as const) {
      const blocked = await post(path, body, method);
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json() as { code: string }).code, "weekly_plan_confirmation_required");
    }
    const spoof = await post("goals", { weekPlanReplanRequired: false }, "PUT");
    assert.equal(spoof.status, 400, "migration state must not be writable by clients");
    const spoofDate = await post("goals", { weekPlanPreservedDate: today }, "PUT");
    assert.equal(spoofDate.status, 400, "today's preservation date must not be writable by clients");
    const response = await post("workout-plan/preview", { expectedRevision: pending.revision });
    assert.equal(response.status, 200);
    const cancelled = await response.json() as import("@rai/api-contracts").MobileWeeklyPlanPreviewResponse;
    assert.ok(cancelled.days.every(day => day.localDate > today));
    assert.deepEqual(await getGoals(), pending, "creating or abandoning a preview cannot clear pending state");
    const edit = await post("goals", { expectedRevision: pending.revision,
      easyDurationFloorFraction: 0.85, qualitySessionCap: 1 }, "PUT");
    assert.equal(edit.status, 200, await edit.text());
    const changed = await getGoals();
    assert.equal(changed.weekPlanReplanRequired, true);
    assert.equal((await post("workout-plan/confirm", { candidateId: cancelled.candidateId, expectedRevision: cancelled.revision })).status, 409);
    assert.deepEqual(await getGoals(), changed);
    const next = await post("workout-plan/preview", { expectedRevision: changed.revision });
    assert.equal(next.status, 200);
    const preview = await next.json() as typeof cancelled;
    assert.equal(preview.audit.generatedBy, "heuristic");
    const confirmBody = { candidateId: preview.candidateId, expectedRevision: preview.revision };
    const confirmed = await post("workout-plan/confirm", confirmBody);
    assert.equal(confirmed.status, 200, await confirmed.text());
    const enabled = await getGoals();
    assert.equal(enabled.revision, changed.revision + 1);
    assert.equal(enabled.weekPlanReplanRequired, false);
    assert.deepEqual(enabled.weekPlan.find(day => day.localDate === today), pending.weekPlan[0]);
    assert.equal(enabled.weekPlanAudit?.generatedBy, "heuristic");
    assert.equal((await getToday()).nextSession.distanceKm, 8, "confirmation must not end today's protection");
    const enabledPlan = await fetch(`${url}/v1/mobile/workout-plan`).then(response => response.json()) as import("@rai/api-contracts").MobileWorkoutPlanResponse;
    assert.equal(enabledPlan.days[0]?.distanceKm, 8);
    assert.equal(enabledPlan.days[0]?.source, "llm", "the preserved legacy day must not be relabelled as rule generation");
    assert.equal((await post("workout-plan/confirm", confirmBody)).status, 200);
    assert.deepEqual(await getGoals(), enabled, "confirmation retry must not create another revision");
    const manual = await post("goals", { expectedRevision: enabled.revision, weekPlan: enabled.weekPlan }, "PUT");
    assert.equal(manual.status, 200, await manual.text());
    const afterManual = await getGoals();
    assert.equal((await post("workout-plan/generate", { expectedRevision: afterManual.revision })).status, 200);
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
      // Match production readonly connections while the scheduled worker opens
      // its SQLite connection; an immediate schema read can race that handoff.
      database.exec("PRAGMA busy_timeout = 5000");
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

    const cancellationDatabase = new DatabaseSync(databasePath);
    // The API child's recompute worker may be writing the triggered job at this
    // moment; wait for the write lock instead of failing with SQLITE_BUSY.
    cancellationDatabase.exec("PRAGMA busy_timeout = 5000");
    try {
      cancellationDatabase.prepare(`
        INSERT INTO recompute_jobs (
          id, job_type, status, request_json, progress_phase, started_at
        ) VALUES (?, 'snapshot_refresh', 'running', '{}', 'snapshot_refresh', ?)
      `).run("runtime-cancellation-contract", new Date().toISOString());
    } finally {
      cancellationDatabase.close();
    }
    const cancellation = await fetch(`${url}/v1/jobs/runtime-cancellation-contract/cancel`, {
      method: "POST"
    });
    const cancellationText = await cancellation.text();
    assert.equal(cancellation.status, 200, cancellationText);
    const cancellationResult = JSON.parse(cancellationText) as {
      cancelRequested: boolean;
      status: string;
    };
    // The worker may observe the cancellation between the request transaction
    // and the response. Both responses describe a successful cancellation.
    assert.ok(
      (cancellationResult.cancelRequested && cancellationResult.status === "running") ||
      (!cancellationResult.cancelRequested && cancellationResult.status === "cancelled")
    );
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

  const upload = async (
    bytes: Uint8Array,
    file: { type?: string; name?: string } = {}
  ): Promise<Response> => {
    const body = new FormData();
    const contents = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(contents).set(bytes);
    body.append(
      "file",
      new Blob([contents], { type: file.type ?? "application/zip" }),
      file.name ?? "health.zip"
    );
    return fetch(`${url}/v1/imports/uploads`, { method: "POST", body });
  };
  let url = "";
  try {
    const boundPort = await waitForBoundPort(child, () => output);
    url = `http://127.0.0.1:${boundPort}`;
    await waitForApi(child, url, () => output);

    // A non-ZIP upload has to be refused before the archive is written to disk.
    const wrongType = await upload(Uint8Array.from([0x50, 0x4b]), {
      type: "text/plain",
      name: "notes.txt"
    });
    assert.equal(wrongType.status, 415, await wrongType.text());

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
    const otherUpload = await upload(await zipBuffer([{
      name: "apple_health_export/export.xml",
      body: "<HealthData/>"
    }]));
    assert.equal(otherUpload.status, 200, await otherUpload.clone().text());
    const otherSource = await otherUpload.json() as { sourceId: string };
    const created = await fetch(`${url}/v1/import-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId })
    });
    assert.equal(created.status, 202, await created.clone().text());
    const createdJob = await created.json() as { id: string; sourceId?: string };
    const importJobId = createdJob.id;
    assert.equal(createdJob.sourceId, sourceId);
    const repeated = await fetch(`${url}/v1/import-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId })
    });
    assert.equal(repeated.status, 200, await repeated.clone().text());
    assert.equal((await repeated.json() as { id: string }).id, importJobId);
    const competing = await fetch(`${url}/v1/import-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: otherSource.sourceId })
    });
    assert.equal(competing.status, 202, await competing.clone().text());
    const queued = await competing.json() as { id: string; status: string };
    assert.equal(queued.status, "queued");
    const cancelled = await fetch(`${url}/v1/import-jobs/${queued.id}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200, await cancelled.clone().text());
    const inspectedDuringImport = await fetch(`${url}/v1/imports/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId })
    });
    assert.equal(inspectedDuringImport.status, 200, await inspectedDuringImport.clone().text());
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
    const failedTiming = await fetch(`${url}/v1/import-jobs/${importJobId}`)
      .then((response) => response.json()) as { error: string; performance: { totalMs: number; stagesMs: { parseImport: number } } };
    assert.equal(failedTiming.error, "导入失败，请查看服务日志", "raw parser diagnostics must stay internal");
    assert.ok(failedTiming.performance.totalMs >= 0);
    assert.ok(failedTiming.performance.stagesMs.parseImport >= 0, "failed parser still records its duration");
    const latestJob = await fetch(`${url}/v1/import-jobs/latest`);
    assert.equal(latestJob.status, 200, await latestJob.clone().text());
    assert.deepEqual(await latestJob.json(), {
      ...(await fetch(`${url}/v1/import-jobs/${queued.id}`).then((response) => response.json()) as object)
    });
    assert.equal(await fetch(`${url}/v1/import-jobs/active`).then((response) => response.json()), null);
    const retainedSource = await fetch(`${url}/v1/imports/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId })
    });
    assert.equal(retainedSource.status, 200, "failed payload remains inspectable for diagnosis/retry");
    // The failed import releases its mutation slot slightly after the job
    // reaches the terminal status; a DELETE fired in that gap is rejected with
    // 409. Retry briefly instead of racing the coordinator.
    let cleanedSource: Response | null = null;
    const deleteDeadline = Date.now() + 5_000;
    for (;;) {
      cleanedSource = await fetch(`${url}/v1/import-sources/${sourceId}`, { method: "DELETE" });
      if (cleanedSource.status !== 409 || Date.now() >= deleteDeadline) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.equal(cleanedSource.status, 200, await cleanedSource.clone().text());
    assert.deepEqual(await cleanedSource.json(), { deleted: true });
    const removedSource = await fetch(`${url}/v1/imports/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId })
    });
    assert.equal(removedSource.status, 404, "explicit cleanup must still remove a retained failure");

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

test("scopes sync batch idempotency by dataset epoch", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-sync-batch-scope-"));
  mkdirSync(join(runtimeRoot, "var"));
  const archive = await zipBuffer([{
    name: "apple_health_export/export.xml",
    body: "<HealthData><Record type=\"workout\"/></HealthData>"
  }]);
  let child: ChildProcess | null = null;

  const start = async (epoch: string): Promise<{ url: string; output: () => string }> => {
    child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        RAI_RUNTIME_ROOT: runtimeRoot,
        RAI_DATABASE: join(runtimeRoot, "var", "rai.sqlite"),
        RAI_API_PORT: "0",
        RAI_DATASET_EPOCH: epoch,
        RAI_LOG_LEVEL: "silent"
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const boundPort = await waitForBoundPort(child, () => output);
    const url = `http://127.0.0.1:${boundPort}`;
    await waitForApi(child, url, () => output);
    return { url, output: () => output };
  };

  const upload = async (url: string): Promise<string> => {
    const body = new FormData();
    const contents = new ArrayBuffer(archive.byteLength);
    new Uint8Array(contents).set(archive);
    body.append("file", new Blob([contents], { type: "application/zip" }), "apple-health-healthkit.zip");
    const response = await fetch(`${url}/v1/imports/uploads`, {
      method: "POST",
      headers: { "X-RAI-Sync-Batch": "same-batch" },
      body
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return (JSON.parse(text) as { sourceId: string }).sourceId;
  };

  try {
    const first = await start("epoch-one");
    const firstSourceId = await upload(first.url);
    assert.equal(await upload(first.url), firstSourceId);
    if (!child) throw new Error("API child was not started");
    const firstChild = child;
    await stopApi(firstChild);
    child = null;

    const second = await start("epoch-two");
    const secondSourceId = await upload(second.url);
    assert.notEqual(secondSourceId, firstSourceId);
  } finally {
    if (child) await stopApi(child).catch(() => child?.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

for (const restartBeforeImport of [false, true]) test(`deletion isolates receipts and rebuilds the same source ${restartBeforeImport ? "after restart" : "without restart"}`, async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-deleted-scope-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  const inputPath = join(runtimeRoot, "export");
  mkdirSync(inputPath);
  const xml = `<HealthData><Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch"
    startDate="2026-01-02 08:00:00 +0800" endDate="2026-01-02 08:30:00 +0800" duration="30" durationUnit="min">
    <MetadataEntry key="HKMetadataKeySyncIdentifier" value="delete-reimport-workout"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
    </Workout></HealthData>`;
  writeFileSync(join(inputPath, "export.xml"), xml);
  const state = new RuntimeStateStore(runtimeRoot);
  state.upsertSource({ id: "same-local-source", kind: "directory", displayName: "delete regression",
    inputPath, originalPath: inputPath, sourceSha256: null, exportFileName: "export.xml",
    exportBytes: Buffer.byteLength(xml), routeFileCount: 0, modifiedAt: "2026-01-03T00:00:00Z",
    createdAt: "2026-01-03T00:00:00Z", lastUsedAt: null });
  const store = await RaiDatabase.open(databasePath);
  store.close();
  const archive = await zipBuffer([{ name: "apple_health_export/export.xml", body: "<HealthData/>" }]);
  let child: ChildProcess | null = null;
  let output = "";
  const start = async (): Promise<string> => {
    output = "";
    child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
      cwd: projectRoot, env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
        RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "", RAI_SERVER_ID: "local",
        RAI_ATHLETE_ID: "athlete_1", RAI_DATASET_EPOCH: "delete-fixture", RAI_IMPORT_ENGINE: "typescript" },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    return url;
  };
  const epoch = async (url: string): Promise<string> =>
    (await fetch(`${url}/v1/handshake`).then(response => response.json()) as { datasetEpoch: string }).datasetEpoch;
  const upload = async (url: string): Promise<string> => {
    const form = new FormData();
    const bytes = new ArrayBuffer(archive.byteLength);
    new Uint8Array(bytes).set(archive);
    form.append("file", new Blob([bytes], { type: "application/zip" }), "healthkit.zip");
    const response = await fetch(`${url}/v1/imports/uploads`, {
      method: "POST", headers: { "X-RAI-Sync-Batch": "same-deleted-batch" }, body: form
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as { sourceId: string }).sourceId;
  };
  const enqueueImport = async (url: string, expectedStatus = 202): Promise<{ id: string; status: string }> => {
    const response = await fetch(`${url}/v1/import-jobs`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: "same-local-source" }) });
    assert.equal(response.status, expectedStatus, await response.clone().text());
    return response.json() as Promise<{ id: string; status: string }>;
  };
  const commandRequest = { idempotencyKey: "same-deleted-command", kind: "training_zones", payload: {
    expectedRevision: 0, restingHeartRate: { mode: "auto", valueBpm: null },
    maximumHeartRate: { mode: "auto", valueBpm: null }, lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null }
  } };
  const enqueueCommand = async (url: string): Promise<string> => {
    const response = await fetch(`${url}/v1/commands`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(commandRequest) });
    assert.equal(response.status, 202, await response.clone().text());
    return (await response.json() as { id: string }).id;
  };
  const settle = async (url: string, importId: string, commandId?: string): Promise<void> => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const job = state.job(importId);
      assert.notEqual(job?.status, "failed", JSON.stringify(job) + output);
      let commandSucceeded = true;
      if (commandId) {
        const command = await fetch(`${url}/v1/commands/${commandId}`).then(response => response.json()) as { status: string };
        assert.notEqual(command.status, "failed", JSON.stringify(command));
        commandSucceeded = command.status === "succeeded";
      }
      const status = await fetch(`${url}/v1/runtime-status`).then(response => response.json()) as { busy: boolean };
      const performance = await fetch(`${url}/v1/performance`).then(response => response.json()) as { commandPending: boolean };
      if (job?.status === "succeeded" && job.queue?.finalized && commandSucceeded && !status.busy && !performance.commandPending) return;
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error(`import/command did not settle: ${output}`);
  };
  const sessionCount = (): number => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return (database.prepare("SELECT COUNT(*) AS n FROM training_sessions WHERE status='active'").get() as { n: number }).n; }
    finally { database.close(); }
  };
  try {
    let url = await start();
    assert.equal(await epoch(url), "delete-fixture");
    const oldBatchSource = await upload(url);
    const first = await enqueueImport(url);
    await settle(url, first.id);
    assert.equal(sessionCount(), 1);
    const oldCommand = await enqueueCommand(url);
    await settle(url, first.id, oldCommand);
    const response = await fetch(`${url}/v1/database`, { method: "DELETE",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation: "删除我的 RAI 数据" }) });
    assert.equal(response.status, 200, await response.text());
    assert.equal(existsSync(databasePath), false);
    const deletedEpoch = await epoch(url);
    assert.notEqual(deletedEpoch, "delete-fixture");
    assert.equal((await fetch(`${url}/v1/commands/${oldCommand}`)).status, 404);
    if (restartBeforeImport) {
      assert.ok(child);
      await stopApi(child);
      child = null;
      url = await start();
      assert.equal(await epoch(url), deletedEpoch, "the empty dataset's new identity must survive restart");
    }
    const newBatchSource = await upload(url);
    assert.notEqual(newBatchSource, oldBatchSource);
    const second = await enqueueImport(url);
    assert.notEqual(second.id, first.id);
    await settle(url, second.id);
    assert.equal(sessionCount(), 1, "the same source must actually rebuild the deleted facts");
    assert.equal(await epoch(url), deletedEpoch);
    const newCommand = await enqueueCommand(url);
    assert.notEqual(newCommand, oldCommand);
    await settle(url, second.id, newCommand);
    assert.ok(child);
    await stopApi(child);
    child = null;
    url = await start();
    assert.equal(await epoch(url), deletedEpoch, "the rebuilt dataset retains the deletion epoch");
    assert.equal(await upload(url), newBatchSource);
    const duplicate = await enqueueImport(url, 200);
    assert.equal(duplicate.id, second.id);
    assert.equal(duplicate.status, "succeeded");
  } finally {
    if (child) await stopApi(child).catch(() => child?.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("restore advances durable dataset scope and reapplies commands instead of replaying stale success", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-restored-scope-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const store = await RaiDatabase.open(databasePath);
  store.close();
  const backup = await new DatabaseMaintenance(databasePath, runtimeRoot).createBackup("before-command");
  const archive = await zipBuffer([{ name: "apple_health_export/export.xml", body: "<HealthData/>" }]);
  let child: ChildProcess | null = null;
  const start = async (): Promise<string> => {
    child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
      cwd: projectRoot, env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
        RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "", RAI_SERVER_ID: "local",
        RAI_ATHLETE_ID: "athlete_1", RAI_DATASET_EPOCH: "restore-fixture" },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    return url;
  };
  const epoch = async (url: string): Promise<string> =>
    (await fetch(`${url}/v1/handshake`).then(response => response.json()) as { datasetEpoch: string }).datasetEpoch;
  const upload = async (url: string): Promise<string> => {
    const form = new FormData();
    const contents = new ArrayBuffer(archive.byteLength);
    new Uint8Array(contents).set(archive);
    form.append("file", new Blob([contents], { type: "application/zip" }), "healthkit.zip");
    const response = await fetch(`${url}/v1/imports/uploads`, {
      method: "POST", headers: { "X-RAI-Sync-Batch": "same-restored-batch" }, body: form
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as { sourceId: string }).sourceId;
  };
  const request = { idempotencyKey: "same-restored-command", kind: "training_zones", payload: {
    expectedRevision: 0, restingHeartRate: { mode: "auto", valueBpm: null },
    maximumHeartRate: { mode: "auto", valueBpm: null },
    lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null }
  } };
  const enqueue = async (url: string, expectedStatus = 202): Promise<{ id: string; status: string }> => {
    const response = await fetch(`${url}/v1/commands`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
    });
    assert.equal(response.status, expectedStatus, await response.clone().text());
    return response.json() as Promise<{ id: string; status: string }>;
  };
  const settle = async (url: string, id: string): Promise<void> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const command = await fetch(`${url}/v1/commands/${id}`).then(response => response.json()) as { status: string };
      assert.notEqual(command.status, "failed", JSON.stringify(command));
      const status = await fetch(`${url}/v1/runtime-status`).then(response => response.json()) as { busy: boolean };
      const performance = await fetch(`${url}/v1/performance`).then(response => response.json()) as { commandPending: boolean };
      if (command.status === "succeeded" && !status.busy && !performance.commandPending) return;
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error("command or workers did not settle before restore");
  };
  const settingCount = (): number => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return (database.prepare("SELECT COUNT(*) AS n FROM training_zone_profile_settings").get() as { n: number }).n; }
    finally { database.close(); }
  };
  try {
    let url = await start();
    assert.equal(await epoch(url), "restore-fixture");
    const oldSource = await upload(url);
    const first = await enqueue(url);
    await settle(url, first.id);
    assert.equal(settingCount(), 1);
    const response = await fetch(`${url}/v1/backups/${backup.name}/restore`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation: "恢复此备份" })
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(settingCount(), 0);
    const restoredEpoch = await epoch(url);
    assert.notEqual(restoredEpoch, "restore-fixture");
    assert.equal((await fetch(`${url}/v1/commands/${first.id}`)).status, 404);
    const newSource = await upload(url);
    assert.notEqual(newSource, oldSource);
    const second = await enqueue(url);
    assert.notEqual(second.id, first.id);
    assert.equal(second.status, "queued");
    await settle(url, second.id);
    assert.equal(settingCount(), 1, "the command must actually affect the restored main database");
    assert.ok(child);
    await stopApi(child);
    child = null;
    url = await start();
    assert.equal(await epoch(url), restoredEpoch, "the restored scope must survive API restart");
    assert.equal(await upload(url), newSource);
    const duplicate = await enqueue(url, 200);
    assert.equal(duplicate.id, second.id);
    assert.equal(duplicate.status, "succeeded");
    assert.equal(settingCount(), 1);
  } finally {
    if (child) await stopApi(child).catch(() => child?.kill("SIGKILL"));
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

/**
 * A night the runner did not wear the watch used to block locking outright, which
 * turned an ordinary coverage gap into "you cannot plan tomorrow's session". The
 * gate now asks the question it always meant to ask — did the refresh fail — so
 * missing recovery only removes the recovery input.
 */
test("mobile lock confirms a session when today has no recovery record", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-api-stale-recovery-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const store = await RaiDatabase.open(databasePath);
  store.database.prepare(`INSERT INTO canonical_nights
    (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank,
     has_stages, sleep_onset_at, wake_at, asleep_union_minutes, stage_minutes_json, segment_count, provenance_json)
    VALUES ('old-night', '2025-01-22', 'Asia/Shanghai', 'main', 'Watch', 'apple_watch', 1,
      0, '2025-01-21T15:00:00Z', '2025-01-21T23:00:00Z', 480, '{}', 1, '{}')`).run();
  store.close();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const port = await waitForBoundPort(child, () => output);
    const url = `http://127.0.0.1:${port}`;
    await waitForApi(child, url, () => output);
    const todayResponse = await fetch(`${url}/v1/mobile/today`);
    assert.equal(todayResponse.status, 200);
    const today = await todayResponse.json() as {
      verdict: { stale: boolean };
      sync: { status: string; lastSuccessAt: string | null };
      coverage: { sleep: { state: string; latestDate: string | null } };
      recoveryAssessment: { coverage: string; assessment: string };
      today: { localDate: string };
      recommendationRevision: string;
    };
    assert.equal(today.verdict.stale, true, "历史恢复仍然不得授权质量课");
    assert.equal(today.recoveryAssessment.coverage, "none");
    assert.equal(today.recoveryAssessment.assessment, "not_assessed");
    assert.equal(today.coverage.sleep.state, "historical", "更早的夜是可展示的参考，不是缺数据");
    assert.equal(today.coverage.sleep.latestDate, "2025-01-22");
    assert.equal(today.sync.status, "never", "没有任何刷新记录");
    assert.equal(today.sync.lastSuccessAt, null);

    const locked = await fetch(`${url}/v1/mobile/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "lock", expectedRevision: today.recommendationRevision })
    });
    assert.equal(locked.status, 200, await locked.text());
    const afterLock = await (await fetch(`${url}/v1/mobile/goals`)).json() as {
      lockedSession: { localDate: string } | null;
    };
    assert.equal(afterLock.lockedSession?.localDate, today.today.localDate);

    // The stale-revision gate itself is untouched: an out-of-date revision is still
    // refused, so narrowing the refresh gate did not remove the conflict check.
    const conflicted = await fetch(`${url}/v1/mobile/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "lock", expectedRevision: "not-the-current-revision" })
    });
    assert.equal(conflicted.status, 409);
    assert.deepEqual(await conflicted.json(), {
      code: "mobile_recommendation_stale",
      message: "今日建议已更新，请重新查看后再确认安排"
    });
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

/**
 * The route table Fastify actually mounted, compared against the registries.
 *
 * `schemas.test.ts` enumerates the mountings by reading `server.ts` as text,
 * and text cannot be made airtight: `const a = app; a.post(...)`,
 * `(app as any).post(...)`, and a route module whose plugin argument is the
 * idiomatic `fastify` all mount a write route without leaving a token that scan
 * recognises. The server dumps its resolved table when `RAI_ROUTE_DUMP` is set,
 * so the registries are compared against what was really mounted — the only
 * spelling-independent check available, and the one that decides whether
 * "every write route is classified" is still true.
 */
test("every mounted write route is classified, whatever the source looks like", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-route-dump-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  (await RaiDatabase.open(databasePath)).close();
  const dumpPath = join(runtimeRoot, "routes.txt");
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: runtimeRoot,
      RAI_DATABASE: databasePath,
      RAI_API_PORT: "0",
      RAI_LOG_LEVEL: "silent",
      RAI_ROUTE_DUMP: dumpPath
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    assert.ok(existsSync(dumpPath), "RAI_ROUTE_DUMP 应当已写出路由表：" + output.slice(-2000));
    const mounted = JSON.parse(readFileSync(dumpPath, "utf8")) as Array<{ method: string; url: string }>;
    assert.ok(mounted.length > 0, "路由表为空：" + output.slice(-2000));

    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const registry = (name: string): string[] => {
      const block = new RegExp("const " + name + " = new Set\\(\\[([\\s\\S]*?)\\]\\)").exec(source);
      assert.ok(block, "server.ts 必须声明 " + name);
      return [...block[1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!);
    };
    const registered = [
      ...registry("metadataOnlyMutationRoutes"),
      ...registry("databaseRequiredMutationRoutes"),
      ...registry("lockOnlyMutationRoutes")
    ];
    // HEAD comes with every GET; OPTIONS is the CORS preflight (`OPTIONS *`),
    // which no registry could ever name. Everything else is a write route.
    const writeMounted = mounted.filter(
      (route) => route.method !== "GET" && route.method !== "HEAD" && route.method !== "OPTIONS"
    );
    assert.ok(writeMounted.length > 0, "应当至少挂载一条写路由");
    for (const route of writeMounted) {
      assert.ok(
        registered.includes(route.url),
        `${route.method} ${route.url} 已挂载，却没有登记在任何写路由分类里`
      );
    }
    for (const route of registered) {
      assert.ok(
        writeMounted.some((mountedRoute) => mountedRoute.url === route),
        route + " 已登记但实际没有挂载"
      );
    }
    // The read-only week carries no body and must stay out of every registry.
    assert.ok(
      mounted.some((route) => route.method === "GET" && route.url === "/v1/mobile/workout-plan"),
      "只读的 /v1/mobile/workout-plan 必须挂载"
    );
    assert.ok(!registered.includes("/v1/mobile/workout-plan"), "只读周计划不应进写路由登记表");

    // Every mounted `/v1/` read route must be classified as public or
    // token-gated. Without this, a new GET route silently inherits "needs the
    // token" — fine — but a typo in `publicReadRoutes` widens nothing and
    // nothing notices either, and the failure mode that actually hurts (a
    // route added to the public set that was never meant to be public) has no
    // second reader.
    const publicRead = registry("publicReadRoutes");
    const tokenRequiredRead = registry("tokenRequiredReadRoutes");
    assert.ok(publicRead.length > 0, "server.ts 必须声明 publicReadRoutes");
    assert.ok(tokenRequiredRead.length > 0, "server.ts 必须声明 tokenRequiredReadRoutes");
    for (const url of publicRead) {
      assert.ok(
        !tokenRequiredRead.includes(url),
        url + " 同时出现在 publicReadRoutes 与 tokenRequiredReadRoutes 里"
      );
      // Sharing a path with a write route is legal and expected — `/v1/model-runs`
      // reads the list and creates a run, `/v1/mobile/goals` reads and replaces
      // the goals — because the hook dispatches on the method: the GET opens,
      // the POST/PUT still needs the token. What must hold is that the path is
      // really mounted as a read; `local-request-security.test.ts` covers the
      // write half of the same path.
      assert.ok(
        mounted.some((route) => route.method === "GET" && route.url === url),
        url + " 已登记为公开只读，实际却没有挂载成 GET 路由"
      );
    }
    for (const url of tokenRequiredRead) {
      assert.ok(
        mounted.some((route) => route.method === "GET" && route.url === url),
        url + " 已登记为需要令牌，实际却没有挂载成 GET 路由"
      );
    }
    const mountedReads = mounted
      .filter((route) => route.method === "GET" && route.url.startsWith("/v1/"))
      .map((route) => route.url);
    assert.ok(mountedReads.length > 0, "应当至少挂载一条 /v1/ 读路由");
    for (const url of mountedReads) {
      assert.ok(
        publicRead.includes(url) || tokenRequiredRead.includes(url),
        `GET ${url} 已挂载，却没有登记在 publicReadRoutes 或 tokenRequiredReadRoutes 里：新增读路由必须显式分类`
      );
    }
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("plan preview/confirm HTTP flow is non-mutating, idempotent and revision safe", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-plan-preview-http-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  const database = await RaiDatabase.open(databasePath);
  database.close();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot, env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath, RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "", RAI_LLM_API_KEY: "" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    const getGoals = async () => await fetch(`${url}/v1/mobile/goals`).then(response => response.json()) as import("@rai/api-contracts").MobileGoalsResponse;
    const post = (path: string, body: object, method = "POST") => fetch(`${url}/v1/mobile/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const initial = await getGoals();
    const missingRevision = await post("workout-plan/preview", {});
    assert.equal(missingRevision.status, 400, await missingRevision.text());
    const response = await post("workout-plan/preview", { expectedRevision: initial.revision });
    assert.equal(response.status, 200);
    const preview = await response.json() as import("@rai/api-contracts").MobileWeeklyPlanPreviewResponse;
    assert.ok(preview.candidateId);
    assert.equal((await getGoals()).revision, initial.revision, "preview must not write");
    const confirmBody = { candidateId: preview.candidateId, expectedRevision: preview.revision };
    const confirmed = await post("workout-plan/confirm", confirmBody);
    assert.equal(confirmed.status, 200, await confirmed.text());
    const committed = await getGoals();
    assert.equal(committed.revision, initial.revision + 1);
    assert.equal((await post("workout-plan/confirm", confirmBody)).status, 200);
    assert.equal((await getGoals()).revision, committed.revision, "lost acknowledgement retry is not another write");
    const stale = await (await post("workout-plan/preview", { expectedRevision: committed.revision })).json() as import("@rai/api-contracts").MobileWeeklyPlanPreviewResponse;
    const today = await fetch(`${url}/v1/mobile/today`).then(response => response.json()) as import("@rai/api-contracts").MobileTodayResponse;
    const edit = await post("goals", { expectedRevision: committed.revision, raceTarget: { date: today.today.localDate, distance: "ten_k", targetPaceSecondsPerKm: 330 } }, "PUT");
    assert.equal(edit.status, 200, await edit.text());
    const changed = await getGoals();
    assert.equal((await post("workout-plan/confirm", { candidateId: stale.candidateId, expectedRevision: stale.revision })).status, 409);
    assert.equal((await getGoals()).revision, changed.revision);
    const invalid = await post("goals", { expectedRevision: changed.revision, qualitySessionCap: 0, weekPlan: [{ localDate: today.today.localDate, kind: "tempo", distanceKm: 10 }] }, "PUT");
    assert.equal(invalid.status, 200, await invalid.text());
    const safelyRewritten = await getGoals();
    assert.equal(safelyRewritten.revision, changed.revision + 1);
    assert.equal(safelyRewritten.weekPlan[0]?.kind, "rest", "race-day manual edits are rewritten to rest");
    for (const action of ["lock", "relock"]) {
      const current = await fetch(`${url}/v1/mobile/today`).then(response => response.json()) as import("@rai/api-contracts").MobileTodayResponse;
      const locked = await post("lock", { action, expectedRevision: current.recommendationRevision });
      assert.equal(locked.status, 200, await locked.text());
    }
    const plan = await fetch(`${url}/v1/mobile/workout-plan`).then(response => response.json()) as import("@rai/api-contracts").MobileWorkoutPlanResponse;
    assert.equal(plan.days.length, 7);
    assert.equal(plan.days[0]!.executable, false, "race day never adds another workout");
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("snapshot capabilities, durable confirm restart and receipt lifecycle work through the production router", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-plan-state-http-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"));
  (await RaiDatabase.open(databasePath)).close();
  const launch = async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
      cwd: projectRoot, env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
        RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "", RAI_LLM_API_KEY: "" },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    try {
      const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
      await waitForApi(child, url, () => output);
      return { child, url };
    } catch (error) { await stopApi(child).catch(() => child.kill("SIGKILL")); throw error; }
  };
  let server = await launch();
  const post = (path: string, body: object) => fetch(server.url + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const snapshot = async () => await fetch(server.url + "/v1/mobile/training-plan-state")
    .then(response => response.json()) as import("@rai/api-contracts").TrainingPlanStateResponse;
  try {
    const handshake = await fetch(server.url + "/v1/handshake").then(response => response.json()) as import("@rai/api-contracts").HandshakeResponse;
    assert.equal(handshake.planSnapshotContractVersion, 1);
    assert.equal(handshake.planPublicationContractVersion, 1);
    assert.equal(handshake.planReceiptContractVersion, 2);
    const initial = await snapshot();
    const previewResponse = await post("/v1/mobile/workout-plan/preview", { expectedRevision: initial.metadata.goalsRevision });
    assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
    const preview = await previewResponse.json() as import("@rai/api-contracts").MobileWeeklyPlanPreviewResponse;
    const operationId = randomUUID();
    const operationScope = { serverId: handshake.serverId, athleteId: handshake.athleteId, datasetEpoch: handshake.datasetEpoch };
    const input = { candidateId: preview.candidateId, expectedRevision: preview.revision, operationId, operationScope };
    const response = await post("/v1/mobile/workout-plan/confirm", input);
    assert.equal(response.status, 200, await response.clone().text());
    const committed = await response.json();
    await stopApi(server.child);
    server = await launch();
    const retry = await post("/v1/mobile/workout-plan/confirm", input);
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.deepEqual(await retry.json(), committed, "durable result bypasses missing process-local preview after restart");
    const queried = await fetch(server.url + "/v1/mobile/plan-operations/" + operationId).then(reply => reply.json()) as { status: string; result: unknown };
    assert.equal(queried.status, "committed"); assert.deepEqual(queried.result, committed);
    const changedKey = await post("/v1/mobile/workout-plan/confirm", { ...input, candidateId: "different" });
    assert.equal(changedKey.status, 409);
    assert.equal((await changedKey.json() as { code: string }).code, "plan_operation_key_conflict");
    const unknownOldIntent = await post("/v1/mobile/workout-plan/confirm", { ...input, operationId: randomUUID(),
      operationScope: { ...operationScope, datasetEpoch: "old-dataset" } });
    assert.equal(unknownOldIntent.status, 409);
    assert.equal((await unknownOldIntent.json() as { code: string }).code, "plan_operation_scope_mismatch",
      "even a never-committed old intent cannot be applied to a replacement dataset");
    const current = await snapshot();
    assert.equal(current.metadata.goalsRevision, initial.metadata.goalsRevision + 1);
    assert.equal(current.today.recommendation.planRevision, current.workoutPlan.planRevision);
    const day = current.workoutPlan.days.find(item => item.executable && item.structure)!;
    assert.ok(day, "fixture must have a genuine executable prescription");
    const workoutID = randomUUID();
    const receipt = { contractVersion: 2, scope: { serverId: handshake.serverId, athleteId: handshake.athleteId, datasetEpoch: handshake.datasetEpoch },
      operationId: randomUUID(), coherenceToken: current.metadata.coherenceToken, verifiedAt: new Date().toISOString(),
      timezone: current.metadata.timezone, prescriptionDigest: prescriptionDigest(day.kind, day.structure), lifecycleEvent: "verified",
      localDate: day.localDate, kind: day.kind, revision: current.metadata.goalsRevision, structure: day.structure,
      workoutID, scheduledAt: day.localDate + "T00:00:00Z" };
    const registered = await post("/v1/mobile/workout-plan/synced", receipt);
    assert.equal(registered.status, 200, await registered.clone().text());
    const first = await registered.json() as { recordedAt: string; matchesCurrent: boolean };
    assert.equal(first.matchesCurrent, true);
    const repeated = await post("/v1/mobile/workout-plan/synced", { ...receipt, verifiedAt: new Date().toISOString() });
    assert.equal(repeated.status, 200, await repeated.clone().text());
    assert.equal((await repeated.json() as { recordedAt: string }).recordedAt, first.recordedAt);
    const mismatched = await post("/v1/mobile/workout-plan/synced", { ...receipt, prescriptionDigest: "0".repeat(64) });
    assert.equal(mismatched.status, 422);
    assert.equal((await mismatched.json() as { code: string }).code, "plan_receipt_evidence_mismatch");
    const wrongScope = await post("/v1/mobile/workout-plan/synced", { ...receipt, scope: { ...receipt.scope, datasetEpoch: "other-epoch" } });
    assert.equal(wrongScope.status, 409);
    const withdrawn = await post("/v1/mobile/workout-plan/synced", { ...receipt, lifecycleEvent: "withdrawn" });
    assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
    assert.equal((await withdrawn.json() as { matchesCurrent: boolean }).matchesCurrent, false);
    const lateVerify = await post("/v1/mobile/workout-plan/synced", receipt);
    assert.equal((await lateVerify.json() as { matchesCurrent: boolean }).matchesCurrent, false, "a duplicate old verification cannot reactivate a withdrawn entry");
    const legacy = await post("/v1/mobile/workout-plan/synced", { localDate: day.localDate, kind: day.kind, revision: current.metadata.goalsRevision, structure: day.structure });
    assert.equal(legacy.status, 200, await legacy.clone().text());
    assert.equal((await legacy.json() as { informationLevel: string }).informationLevel, "legacy");
  } finally { await stopApi(server.child).catch(() => server.child.kill("SIGKILL")); await removeRuntimeRoot(runtimeRoot); }
});

test("summary export requires token even on a public host and validates its range before reading", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-export-auth-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  const store = await RaiDatabase.open(databasePath); store.close();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot, env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "export-test-token", RAI_PUBLIC_HOSTS: "127.0.0.1" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    const path = "/v1/exports/workout-summary?from=2026-09-01&through=2026-09-28";
    assert.equal((await fetch(`${url}/v1/health`)).status, 200);
    assert.equal((await fetch(url + path)).status, 401);
    const response = await fetch(url + path, { headers: { authorization: "Bearer export-test-token" } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { count: number; csv: string };
    assert.equal(body.count, 0); assert.ok(body.csv.includes("训练开始时间"));
    const invalid = await fetch(`${url}/v1/exports/workout-summary?from=2026-02-29&through=2026-03-01`, { headers: { authorization: "Bearer export-test-token" } });
    assert.equal(invalid.status, 400);
    const invalidDay = await fetch(`${url}/v1/workouts?localDate=2026-02-29`, { headers: { authorization: "Bearer export-test-token" } });
    assert.equal(invalidDay.status, 400);
    const problem = await invalidDay.json() as { code: string; message: string };
    assert.equal(problem.code, "invalid_workout_date");
    assert.ok(!problem.message.includes("导出"));
    const validDay = await fetch(`${url}/v1/workouts?localDate=2026-09-28`, { headers: { authorization: "Bearer export-test-token" } });
    assert.equal(validDay.status, 200);
    assert.equal((await validDay.json() as { total: number }).total, 0);
    for (const localDate of ["2026-02-29", "2026-04-31"]) {
      const invalidEntry = await fetch(`${url}/v1/performance-entries`, {
        method: "POST", headers: { authorization: "Bearer export-test-token", "content-type": "application/json" },
        body: JSON.stringify({ localDate, distance: "ten_k", durationSeconds: 2400 })
      });
      assert.equal(invalidEntry.status, 400);
    }
    const entries = await fetch(`${url}/v1/performance-entries`, { headers: { authorization: "Bearer export-test-token" } });
    assert.deepEqual((await entries.json() as { entries: unknown[] }).entries, []);
  } finally { await stopApi(child).catch(() => child.kill("SIGKILL")); await removeRuntimeRoot(runtimeRoot); }
});

/**
 * POST a write while tolerating the API's **startup recompute window**.
 *
 * A fixture that has already run a full recompute leaves an `active_model_run` row behind, so
 * `checkTrainingZoneBackfill` (`server.ts`) enqueues one more job as the API boots. Two ways a
 * write can be turned away while that job runs, and neither is what these cases are testing:
 *
 *   · `409 mutation_conflict` — the write permit is momentarily taken (since PR4 步骤 3 it is held
 *     **per SQL statement**, so this window is short, but it can still land on a request);
 *   · `409 任务执行期间不能录入成绩` — `isDatabaseWriteBusy()` sees the recompute job still
 *     **running**. 2026-10-13 之前这条几乎看不到：写路由要等整轮的写许可，等到许可时任务已经跑完；
 *     A11 拆锁之后写路由不再等，于是真的会在"分析进行中"抵达 —— 这是既有的产品守卫（分析要读用户
 *     成绩标签，不能读到写了一半的集合），客户端应当重试。
 *
 * 所以这里用**有界重试**把它熬过去，而不是假设第一次响应就是最终结果。预算刻意给足：
 * 启动那一次重算要跑几百条语句，而拆锁之后每条语句都要过一次主线程的租约往返。
 * 永久冲突的写仍然会失败：预算是有限的，调用方随后照样断言真状态。
 */
async function postToleratingStartupRecompute(
  url: string, headers: Record<string, string>, body: string
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { method: "POST", headers, body });
    if (response.status !== 409 || attempt >= 20) return response;
    await new Promise((done) => setTimeout(done, 250));
  }
}

for (const config of [
  { token: "route-test-token", anonymousRoutes: "", publicRoute: false },
  { token: "route-test-token", anonymousRoutes: "1", publicRoute: false },
  { token: "", anonymousRoutes: "", publicRoute: false },
  { token: "", anonymousRoutes: "0", publicRoute: false },
  { token: "", anonymousRoutes: "1", publicRoute: true }
]) test(`workout route privacy: token=${Boolean(config.token)}, anonymousRoutes=${config.anonymousRoutes || "unset"}`, async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-route-auth-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  const store = await RaiDatabase.open(databasePath, { createMigrationBackup: false });
  store.database.exec(`
    INSERT INTO workouts (id, activity_type, source_name, source_category, start_at, end_at,
      duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
    VALUES ('private-workout', 'HKWorkoutActivityTypeRunning', 'Watch', 'apple_watch',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:30:00.000Z', 1800, 0, '{}', '{}', 1);
    INSERT INTO workout_statistics (workout_id, ordinal, type, unit, sum_value)
    VALUES ('private-workout', 0, 'HKQuantityTypeIdentifierDistanceWalkingRunning', 'km', 5);
    INSERT INTO training_sessions (id, activity_type, anchor_start_at, anchor_end_at,
      anchor_distance_km, canonical_workout_id, status)
    VALUES ('private-session', 'HKWorkoutActivityTypeRunning', '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:30:00.000Z', 5, 'private-workout', 'active');
    INSERT INTO workout_overrides (id, training_session_id, revision, eligibility_override, condition_tags_json)
    VALUES ('private-override', 'private-session', 1, 'include', '[]');
  `);
  const service = new RaiApplicationService(store);
  service.enqueueFullRecompute({ evaluatedAt: "2026-09-02T00:00:00.000Z" });
  assert.equal(service.runNextJob()?.status, "succeeded");
  store.database.exec(`
    INSERT INTO workout_routes (id, workout_id, source_name, source_category, relative_path, metadata_json, point_count, file_status)
    VALUES ('private-route', 'private-workout', 'Watch', 'apple_watch', 'private.gpx', '{}', 2, 'imported');
    INSERT INTO route_points (route_id, sequence, latitude, longitude)
    VALUES ('private-route', 0, 31.23, 121.47), ('private-route', 1, 31.24, 121.48);
  `);
  store.close();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot, env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: config.token, RAI_PUBLIC_HOSTS: "127.0.0.1",
      RAI_ALLOW_ANONYMOUS_ROUTES: config.anonymousRoutes },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    const path = `${url}/v1/workouts/private-session`;
    const owner = await fetch(path, { headers: { authorization: "Bearer route-test-token" } });
    assert.equal(owner.status, 200, await owner.clone().text());
    assert.equal(owner.headers.get("cache-control"), "no-store");
    const privateDetail = await owner.json() as import("@rai/api-contracts").WorkoutDetailResponse;
    const coordinates = [[31.23, 121.47], [31.24, 121.48]];
    assert.deepEqual(privateDetail.route.map(point => [point.latitude, point.longitude]),
      config.token || config.publicRoute ? coordinates : []);
    const anonymous = await fetch(path);
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    const summary = await anonymous.json() as import("@rai/api-contracts").WorkoutDetailResponse;
    assert.deepEqual(summary.route.map(point => [point.latitude, point.longitude]), config.publicRoute ? coordinates : []);
    assert.equal(summary.workout.distanceKm, privateDetail.workout.distanceKm);
    assert.equal(summary.workout.hasRoute, true);
    for (const protectedPath of [path + "/share-card", `${url}/v1/privacy-zones`]) {
      assert.equal((await fetch(protectedPath)).status, 401);
      assert.equal((await fetch(protectedPath, { headers: { authorization: "Bearer incorrect" } })).status, 401);
      const authorized = await fetch(protectedPath, { headers: { authorization: "Bearer route-test-token" } });
      assert.equal(authorized.status, config.token ? 200 : 401);
      if (config.token) assert.equal(authorized.headers.get("cache-control"), "no-store");
    }
    if (config.token && config.anonymousRoutes === "") {
      const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
      const eligibilityFixture = new DatabaseSync(databasePath);
      const overrideAt = new Date().toISOString();
      try {
        eligibilityFixture.prepare(`INSERT INTO workout_overrides
          (id, training_session_id, revision, eligibility_override, created_at)
          VALUES ('private-excluded', 'private-session', 2, 'exclude', ?)`).run(overrideAt);
        const rejected = await postToleratingStartupRecompute(`${url}/v1/performance-entries`, headers,
          JSON.stringify({ localDate: "2026-09-01", distance: "five_k", durationSeconds: 1800,
            trainingSessionId: "private-session" }));
        assert.equal(rejected.status, 400, await rejected.clone().text());
        assert.equal((await rejected.json() as { code: string }).code, "performance_entry_invalid");
        const entries = await fetch(`${url}/v1/performance-entries`, { headers }).then(response => response.json()) as {
          entries: import("@rai/contracts").PerformanceEntry[];
        };
        assert.deepEqual(entries.entries, [], "a stale candidate must not leave an unusable confirmation");
        eligibilityFixture.prepare(`INSERT INTO workout_overrides
          (id, training_session_id, revision, eligibility_override, created_at)
          VALUES ('private-restored', 'private-session', 3, 'include', ?)`).run(overrideAt);
      } finally {
        eligibilityFixture.close();
      }
      const confirmation = await postToleratingStartupRecompute(`${url}/v1/performance-entries`, headers,
        JSON.stringify({ localDate: "2026-09-01", distance: "five_k", durationSeconds: 1800,
          trainingSessionId: "private-session" }));
      assert.equal(confirmation.status, 200, await confirmation.clone().text());
      const entry = await confirmation.json() as import("@rai/contracts").PerformanceEntry;
      assert.equal(entry.trainingSessionId, "private-session");
      assert.equal(entry.observedAt, "2026-09-01T00:00:00.000Z");
      assert.equal(entry.completedAt, "2026-09-01T00:30:00.000Z");
      const initial = await fetch(`${url}/v1/privacy-zones`, { headers }).then(response => response.json()) as import("@rai/api-contracts").PrivacyZonesResponse;
      assert.match(initial.stateToken, /^[a-f0-9]{64}$/);
      const zones = [{ id: "home", label: "home", centerLatitude: 31.23, centerLongitude: 121.47,
        radiusMeters: 300, createdAt: "2026-09-01T00:00:00Z" }];
      const missingState = await fetch(`${url}/v1/privacy-zones`, { method: "PUT", headers,
        body: JSON.stringify({ revision: initial.revision, zones }) });
      assert.equal(missingState.status, 400, "legacy clients cannot bypass the state guard");
      const saved = await fetch(`${url}/v1/privacy-zones`, { method: "PUT", headers,
        body: JSON.stringify({ revision: initial.revision, stateToken: initial.stateToken, zones }) });
      assert.equal(saved.status, 200, await saved.clone().text());
      const baseline = await saved.json() as import("@rai/api-contracts").PrivacyZonesResponse;
      const fixture = new DatabaseSync(databasePath);
      try { fixture.exec("UPDATE privacy_zones SET center_latitude = 32 WHERE id = 'home'"); }
      finally { fixture.close(); }
      const stale = await fetch(`${url}/v1/privacy-zones`, { method: "PUT", headers,
        body: JSON.stringify({ revision: baseline.revision, stateToken: baseline.stateToken, zones: [] }) });
      assert.equal(stale.status, 409, await stale.clone().text());
      const current = await fetch(`${url}/v1/privacy-zones`, { headers }).then(response => response.json()) as import("@rai/api-contracts").PrivacyZonesResponse;
      assert.equal(current.revision, baseline.revision);
      assert.equal(current.zones[0]?.centerLatitude, 32);
      assert.notEqual(current.stateToken, baseline.stateToken);
    }
    assert.equal((await fetch(path, { headers: { authorization: "Bearer incorrect" } })).status, 200);
    const incorrect = await fetch(path, { headers: { authorization: "Bearer incorrect" } });
    assert.deepEqual((await incorrect.json() as import("@rai/api-contracts").WorkoutDetailResponse).route.map(point => [point.latitude, point.longitude]), config.publicRoute ? coordinates : []);
  } finally {
    await stopApi(child).catch(() => child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});
