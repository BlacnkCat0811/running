#!/usr/bin/env node
// B09 / S05-02 DEV baseline (macOS only; this is NOT a G5 acceptance run).
//
// Measures, with isolated temporary databases under $TMPDIR:
//   - GET /v1/mobile/training-plan-state v2 with sessions + executions + update,
//     on an empty main store and on a 43,000-row production-shaped store;
//   - B06 execution-candidate reads (±2 days, 31 days, 50-per-page);
//   - B08 desired-input-key computation over the 28+7-day facts window.
//
// It never reads or writes the user's var/rai.sqlite. Usage:
//   node --import tsx scripts/bench-training-plan-closed-loop.mjs
//   node --import tsx scripts/bench-training-plan-closed-loop.mjs --json=path/to/result.json
//
// The route is exercised through Fastify's real route handler (`app.inject`),
// not a reimplementation. Cold samples create a fresh control store + read store
// + Fastify app; hot samples reuse one. No network/systemd/Linux claim is made.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { arch, cpus, loadavg, platform, release, totalmem, freemem } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import { DATABASE_TIMEZONE, localDateAt } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";

import { RaiReadStore } from "../apps/api/src/data.js";
import { MobileGoalsStore } from "../apps/api/src/mobile-goals.js";
import {
  trainingPlanConfigDigest, trainingPlanDesiredInputKey, trainingPlanExecutionDigest,
  trainingPlanOverridesDigest
} from "../apps/api/src/training-plan-input-identity.js";
import { TrainingPlanExecutionCommandService } from "../apps/api/src/training-plan-execution-commands.js";
import { createTrainingPlanStateRoute } from "../apps/api/src/training-plan-routes.js";
import { benchmarkScope, benchmarkScopeKey, seedBenchControlStore } from "../apps/api/test/helpers/training-plan-benchmark-fixture.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const scope = benchmarkScope;
const scopeKey = benchmarkScopeKey;

const percentile = (samples, fraction) => {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
};
const summary = samples => ({
  n: samples.length,
  p50: Number(percentile(samples, 0.5).toFixed(3)),
  p95: Number(percentile(samples, 0.95).toFixed(3)),
  p99: Number(percentile(samples, 0.99).toFixed(3)),
  max: Number(Math.max(...samples).toFixed(3)),
  mean: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(3))
});
const shiftDate = (today, offset) => {
  const value = new Date(`${today}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};
const nowIso = () => new Date().toISOString();

function sqliteVersion() {
  const database = new DatabaseSync(":memory:");
  try {
    return database.prepare("SELECT sqlite_version() AS version").get().version;
  } finally { database.close(); }
}

function seedMainDatabase(path) {
  const database = new DatabaseSync(path);
  const today = localDateAt(Date.now());
  try {
    database.exec("BEGIN IMMEDIATE");
    const health = database.prepare(`INSERT INTO health_records
      (id, type, source_name, source_category, start_at, end_at, metadata_json, raw_attributes_json)
      VALUES (?,?,?,?,?,?,?,?)`);
    const baseInstant = Date.parse("2026-01-01T00:00:00Z");
    for (let index = 0; index < 40_600; index += 1) {
      const startAt = new Date(baseInstant + index * 60_000).toISOString();
      const isRestingHr = index < 70;
      health.run(`bench-health-${index}`,
        isRestingHr ? "HKQuantityTypeIdentifierRestingHeartRate" : "HKQuantityTypeIdentifierHeartRate",
        "Watch", "apple_watch", startAt, startAt, "{}", "{}");
    }
    const rhr = database.prepare("UPDATE health_records SET start_at=?, end_at=? WHERE id=?");
    for (let index = 0; index < 70; index += 1) {
      const startAt = `${shiftDate(today, -index)}T03:00:00.000Z`;
      rhr.run(startAt, startAt, `bench-health-${index}`);
    }
    const night = database.prepare(`INSERT INTO canonical_nights
      (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank, has_stages,
       sleep_onset_at, wake_at, asleep_union_minutes, stage_minutes_json, segment_count, provenance_json, computed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const hrv = database.prepare(`INSERT INTO canonical_hrv_days
      (id, local_date, timezone_identifier, night_id, sample_count, confidence, provenance_json, computed_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (let index = 0; index < 400; index += 1) {
      const date = shiftDate(today, -index);
      night.run(`bench-night-${index}`, date, DATABASE_TIMEZONE, "main", "Watch", "apple_watch",
        1, 0, `${shiftDate(date, -1)}T15:00:00.000Z`, `${date}T23:00:00.000Z`, 480, "{}", 1, "{}",
        `${date}T01:00:00.000Z`);
      hrv.run(`bench-hrv-${index}`, date, DATABASE_TIMEZONE, `bench-night-${index}`, 1, "confident", "{}",
        `${date}T01:00:00.000Z`);
    }
    const workout = database.prepare(`INSERT INTO workouts
      (id, activity_type, source_name, source_category, start_at, end_at, duration_seconds, metadata_json, raw_attributes_json)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const session = database.prepare(`INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const statistic = database.prepare(`INSERT INTO workout_statistics
      (workout_id, ordinal, type, unit, sum_value) VALUES (?,?,?,?,?)`);
    for (let index = 0; index < 400; index += 1) {
      const day = shiftDate(today, -(index % 56));
      const startAt = `${day}T${String(6 + (index % 12)).padStart(2, "0")}:00:00.000Z`;
      const endAt = `${day}T${String(7 + (index % 12)).padStart(2, "0")}:00:00.000Z`;
      workout.run(`bench-workout-${index}`, "HKWorkoutActivityTypeRunning", "Watch", "apple_watch",
        startAt, endAt, 3600, "{}", "{}");
      session.run(`bench-session-${index}`, "HKWorkoutActivityTypeRunning", startAt, endAt, 10,
        `bench-workout-${index}`, "active", startAt, startAt);
      statistic.run(`bench-workout-${index}`, 0, "HKQuantityTypeIdentifierDistanceWalkingRunning", "km", 10);
      statistic.run(`bench-workout-${index}`, 1, "HKQuantityTypeIdentifierEnergyBurned", "kcal", 500);
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally { database.close(); }
}

function updateViewFor(goals, read, businessDate, row) {
  const state = row.state;
  const { facts, analysis } = read.trainingPlanInputFacts(businessDate);
  const executions = state.schemaVersion === 2 ? goals.trainingPlanExecutions(scopeKey, state.planInstanceId) : [];
  const evaluation = goals.trainingPlanEvaluation(scopeKey);
  const executionDigest = trainingPlanExecutionDigest(executions);
  const configDigest = trainingPlanConfigDigest(state);
  const overridesDigest = trainingPlanOverridesDigest(state);
  const policyHash = state.coachLoop?.policyHash ?? null;
  const inputKey = trainingPlanDesiredInputKey({ scope, businessDate, facts, analysis, configDigest,
    overridesDigest, executionDigest, policyHash });
  const sessions = state.schemaVersion === 2 ? state.sessions : [];
  const associationPending = sessions.some(session => session.lifecycle === "pending" &&
    session.prescription.localDate <= businessDate &&
    !executions.some(execution => execution.sessionId === session.sessionId && execution.association === "confirmed"));
  const associationBlocked = executions.some(execution => execution.association === "invalidated");
  const current = state.schemaVersion === 2 && (state.publishedInputKey === inputKey ||
    (evaluation !== null && evaluation.inputKey === inputKey && evaluation.stateRevision === row.revision));
  const reasonCodes = [];
  if (!current) reasonCodes.push("auto_publish_disabled");
  if (associationBlocked) reasonCodes.push("execution_invalidated");
  return { contractVersion: 1,
    facts: { status: facts.length > 0 ? "stored" : "pending", identity: analysis.factsGeneration },
    analysis: { status: analysis.analysisStatus === "published" ? "ready" : analysis.analysisStatus === "failed" ? "failed" : "pending",
      identity: analysis.releaseId },
    association: { status: associationBlocked ? "blocked" : associationPending ? "pending" : "current",
      identity: executionDigest },
    plan: { status: current ? "current" : "blocked", desiredInputKey: inputKey,
      publishedInputKey: state.schemaVersion === 2 ? state.publishedInputKey : null,
      evaluatedInputKey: evaluation?.inputKey ?? null,
      evaluatedStateRevision: evaluation?.stateRevision ?? null, reasonCodes } };
}

function openContext({ root, mainPath, controlPath, businessDate }) {
  const goals = new MobileGoalsStore(root, controlPath);
  goals.bindTrainingPlanOwner(() => scope, () => businessDate);
  const read = new RaiReadStore(mainPath);
  return { goals, read, close: () => { read.close(); goals.close(); } };
}

async function openRouteContext({ root, mainPath, controlPath, businessDate }) {
  const context = openContext({ root, mainPath, controlPath, businessDate });
  const app = Fastify({ logger: false });
  app.get("/v1/mobile/training-plan-state", createTrainingPlanStateRoute({
    identity: () => scope,
    businessDate: () => businessDate,
    readUnifiedState: key => context.goals.trainingPlanStateRow(key),
    readGoalsRevision: () => context.goals.read().revision,
    readExecutions: (key, instance) => context.goals.trainingPlanExecutions(key, instance),
    readUpdate: (_key, row) => updateViewFor(context.goals, context.read, businessDate, row),
    legacy: () => ({ legacy: true })
  }));
  await app.ready();
  return { ...context, app, close: async () => { await app.close(); context.close(); } };
}

async function measureHttp(factory, headers) {
  const context = await factory();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: { ...process.env, RAI_RUNTIME_ROOT: context.root, RAI_DATABASE: context.mainPath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "",
      RAI_SERVER_ID: scope.serverId, RAI_ATHLETE_ID: scope.athleteId, RAI_DATASET_EPOCH: scope.datasetEpoch,
      RAI_CONTROL_DATABASE: context.controlPath },
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true
  });
  let output = "";
  child.stdout?.on("data", chunk => { output += chunk.toString(); });
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    const request = async () => {
      const started = performance.now();
      const response = await fetch(`${url}/v1/mobile/training-plan-state`, { headers });
      const body = await response.text();
      if (response.status !== 200) throw new Error(`HTTP GET v2 ${response.status}: ${body.slice(0, 300)}`);
      return performance.now() - started;
    };
    const cold = [await request()];
    for (let index = 0; index < 5; index += 1) await request();
    const hot = [];
    for (let index = 0; index < 30; index += 1) hot.push(await request());
    return { cold: summary(cold), hot: summary(hot) };
  } finally { await stopApi(child); }
}

async function measureGetV2(factory, headers) {
  const cold = [];
  for (let index = 0; index < 10; index += 1) {
    const context = await factory();
    try {
      const started = performance.now();
      const response = await context.app.inject({ method: "GET", url: "/v1/mobile/training-plan-state", headers });
      const body = response.json();
      if (response.statusCode !== 200) throw new Error(`GET v2 cold failed ${response.statusCode}: ${response.body.slice(0, 300)}`);
      if (body.sessions?.sessions?.length !== 24 || body.sessions?.executions?.length !== 24 || body.update === undefined) {
        throw new Error(`GET v2 shape missing sessions/executions/update: ${JSON.stringify({ sessions: body.sessions?.sessions?.length, executions: body.sessions?.executions?.length, update: body.update !== undefined })}`);
      }
      cold.push(performance.now() - started);
    } finally { await context.close(); }
  }
  const context = await factory();
  try {
    for (let index = 0; index < 5; index += 1) await context.app.inject({ method: "GET", url: "/v1/mobile/training-plan-state", headers });
    const hot = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      const response = await context.app.inject({ method: "GET", url: "/v1/mobile/training-plan-state", headers });
      if (response.statusCode !== 200) throw new Error(`GET v2 hot failed ${response.statusCode}`);
      hot.push(performance.now() - started);
    }
    return { cold: summary(cold), hot: summary(hot) };
  } finally { await context.close(); }
}

function measureCandidates(context, businessDate, planInstanceId, rangeStart, rangeEnd, expectedCount) {
  const service = new TrainingPlanExecutionCommandService(context.goals, () => scope, () => businessDate, () => ({
    fingerprint: () => "bench-facts",
    candidates: (start, end) => context.read.executionCandidateFacts(start, end),
    workout: () => null
  }), () => Date.parse(`${businessDate}T12:00:00.000Z`));
  const response = service.candidates("bench-session-01", { planInstanceId, rangeStart, rangeEnd });
  if (expectedCount !== undefined && response.candidates.length !== expectedCount) {
    throw new Error(`candidate count ${response.candidates.length} != ${expectedCount} for ${rangeStart}..${rangeEnd}`);
  }
  return response;
}

async function measureCandidateSeries(factory, businessDate, planInstanceId, ranges) {
  const results = {};
  for (const range of ranges) {
    const cold = [];
    for (let index = 0; index < 10; index += 1) {
      const context = openContext(await factory());
      try {
        const started = performance.now();
        measureCandidates(context, businessDate, planInstanceId, range.start, range.end, range.expected);
        cold.push(performance.now() - started);
      } finally { context.close(); }
    }
    const context = openContext(await factory());
    try {
      for (let index = 0; index < 3; index += 1) measureCandidates(context, businessDate, planInstanceId, range.start, range.end);
      const hot = [];
      for (let index = 0; index < 30; index += 1) {
        const started = performance.now();
        const response = measureCandidates(context, businessDate, planInstanceId, range.start, range.end, range.expected);
        hot.push(performance.now() - started);
        if (range.expected === 50 && response.nextCursor === null) throw new Error("50-per-page response did not expose nextCursor");
      }
      results[range.label] = { cold: summary(cold), hot: summary(hot), returned: range.expected };
    } finally { context.close(); }
  }
  return results;
}

async function measureInputKey(factory, businessDate) {
  const compute = context => {
    const row = context.goals.currentTrainingPlan();
    const state = row.state;
    const executions = context.goals.trainingPlanExecutions(scopeKey, state.planInstanceId);
    const configDigest = trainingPlanConfigDigest(state);
    const overridesDigest = trainingPlanOverridesDigest(state);
    const executionDigest = trainingPlanExecutionDigest(executions);
    const started = performance.now();
    const { facts, analysis } = context.read.trainingPlanInputFacts(businessDate);
    const key = trainingPlanDesiredInputKey({ scope, businessDate, facts, analysis, configDigest,
      overridesDigest, executionDigest, policyHash: state.coachLoop?.policyHash ?? null });
    return { elapsed: performance.now() - started, facts: facts.length, keyLength: key.length };
  };
  const cold = [];
  let facts = 0;
  for (let index = 0; index < 10; index += 1) {
    const context = openContext(await factory());
    try { const value = compute(context); cold.push(value.elapsed); facts = value.facts; }
    finally { context.close(); }
  }
  const context = openContext(await factory());
  try {
    for (let index = 0; index < 3; index += 1) compute(context);
    const hot = [];
    let keyLength = 0;
    for (let index = 0; index < 30; index += 1) {
      const value = compute(context); hot.push(value.elapsed); facts = value.facts; keyLength = value.keyLength;
    }
    return { cold: summary(cold), hot: summary(hot), factsInWindow: facts, keyLength };
  } finally { context.close(); }
}

function waitForChildMessage(child, type, output) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => { cleanup(); rejectPromise(new Error(`child did not send ${type}: ${output()}`)); }, 60_000);
    const onMessage = message => {
      if (typeof message === "object" && message !== null && message.type === type) { cleanup(); resolvePromise(); }
    };
    const onExit = code => { cleanup(); rejectPromise(new Error(`child exited ${code} before ${type}: ${output()}`)); };
    const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); };
    child.on("message", onMessage); child.on("exit", onExit);
  });
}

async function waitForBoundPort(child, output) {
  return new Promise((resolvePort, rejectPort) => {
    const timer = setTimeout(() => rejectPort(new Error(output() || "API did not report its bound port")), 60_000);
    const onExit = code => { clearTimeout(timer); rejectPort(new Error(output() || `API exited ${code}`)); };
    child.once("exit", onExit);
    child.on("message", message => {
      if (typeof message === "object" && message !== null && message.type === "rai:ready" && Number.isInteger(message.port)) {
        clearTimeout(timer); child.off("exit", onExit); resolvePort(message.port);
      }
    });
  });
}

async function waitForApi(child, url, output) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output() || `API exited ${child.exitCode}`);
    try { const response = await fetch(`${url}/v1/health`); if (response.ok) return; } catch { /* starting */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(output() || "API did not become ready");
}

async function stopApi(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise(resolvePromise => { child.once("close", () => resolvePromise()); });
  try { if (child.connected) child.send("rai:shutdown", () => {}); else child.kill("SIGTERM"); }
  catch { child.kill("SIGTERM"); }
  const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await closed;
  clearTimeout(killer);
}

function mainDatabaseCounts(path) {
  const database = new DatabaseSync(path);
  try {
    const count = table => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return { health_records: count("health_records"), canonical_nights: count("canonical_nights"),
      canonical_hrv_days: count("canonical_hrv_days"), workouts: count("workouts"),
      training_sessions: count("training_sessions"), workout_statistics: count("workout_statistics") };
  } finally { database.close(); }
}

async function scenario(label, scale) {
  const root = mkdtempSync(join(tmpdir(), `rai-b09-bench-${label}-`));
  const mainPath = join(root, "facts.sqlite");
  const controlPath = join(root, "control.sqlite");
  const businessDate = localDateAt(Date.now());
  let opened = await RaiDatabase.open(mainPath);
  opened.close();
  if (scale) seedMainDatabase(mainPath);
  const goals = new MobileGoalsStore(root, controlPath);
  const seeded = seedBenchControlStore(goals, controlPath, businessDate);
  goals.close();

  const factory = () => ({ root, mainPath, controlPath, businessDate });
  const mainRows = mainDatabaseCounts(mainPath);
  const totalRows = Object.values(mainRows).reduce((sum, value) => sum + value, 0);
  const range2Start = shiftDate(businessDate, -2);
  const range2End = shiftDate(businessDate, 2);
  const range31Start = shiftDate(businessDate, -15);
  const range31End = shiftDate(businessDate, 15);
  const headers = { "x-rai-training-contract": "2", "x-rai-training-sessions": "1", "x-rai-training-updates": "1" };

  const getV2 = await measureGetV2(() => openRouteContext(factory()), headers);
  const http = await measureHttp(async () => factory(), headers);
  const candidates = await measureCandidateSeries(async () => factory(), businessDate, seeded.planInstanceId, [
    { label: "plus_minus_2d", start: range2Start, end: range2End },
    { label: "31d", start: range31Start, end: range31End },
    { label: "50_per_page", start: range31Start, end: range31End, ...(scale ? { expected: 50 } : {}) }
  ]);
  const inputKey = await measureInputKey(async () => factory(), businessDate);
  const fileSizes = [mainPath, controlPath].map(path => statSync(path).size);
  const result = { label, businessDate, mainRows, totalMainRows: totalRows, controlSessions: seeded.sessions.length,
    dbBytes: fileSizes.reduce((sum, value) => sum + value, 0), getV2, http, candidates, inputKey };
  rmSync(root, { recursive: true, force: true });
  return result;
}

const startedAt = nowIso();
const cpuBefore = process.cpuUsage();
const memoryBefore = process.memoryUsage();
const results = {
  startedAt, finishedAt: null, node: process.version, sqlite: sqliteVersion(), platform: platform(), release: release(),
  arch: arch(), cpuModel: cpus()[0]?.model ?? null, cpuCount: cpus().length, totalMemBytes: totalmem(),
  freeMemBytesAtStart: freemem(), loadAverage: loadavg(), sampleConcurrency: 1,
  sampling: { getV2: "cold n=10 fresh context, hot n=30 same context", candidates: "cold n=10, hot n=30",
    inputKey: "cold n=10, hot n=30" },
  scenarios: {}
};
try {
  results.scenarios.empty = await scenario("empty", false);
  results.scenarios.scale = await scenario("scale", true);
} finally {
  const cpu = process.cpuUsage(cpuBefore);
  results.finishedAt = nowIso();
  results.loadAverageEnd = loadavg();
  results.process = { userCpuMs: Number((cpu.user / 1000).toFixed(1)), systemCpuMs: Number((cpu.system / 1000).toFixed(1)),
    rssBytesBefore: memoryBefore.rss, memory: process.memoryUsage() };
}

const text = JSON.stringify(results, null, 2);
const jsonArg = process.argv.find(argument => argument.startsWith("--json="));
if (jsonArg) writeFileSync(jsonArg.slice("--json=".length), `${text}\n`, "utf8");
console.log(text);
