import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import {
  ensurePublicationGuardSchema, publicationGuardChanged, readPublicationGuard
} from "../src/publication-guard.js";

/**
 * Concurrent evidence for the cross-store publication guard (review P2-2 /
 * batch-A residual) and for the retry shape of its retryable 503s.
 *
 * 1. Two real OS processes: a child publishes 300 times with the production
 *    transaction order (epoch+marker committed first, then the "main store"
 *    write, then the marker is cleared) while the parent reads the guard/marker
 *    pair 2000 times. A snapshot the guard calls consistent must correspond to
 *    the marker of that same epoch — that is the protocol invariant. A mixed
 *    snapshot is allowed to be *detected* (that is the point of the marker), but
 *    never to be returned as consistent.
 * 2. A real API process: 10×20 readers of `GET /v1/mobile/training-plan-state`
 *    race 2×25 writers of `PUT /v1/mobile/goals`. Readers must only see 200 or
 *    503, every 503 must carry `Retry-After: 1`, every 200 must be internally
 *    consistent, and latency must stay bounded. The 503 ratio is reported, not
 *    asserted: forcing it low would make the test flaky without testing more.
 *
 *    A separate publisher process is required to make the 503 path reachable:
 *    one API process handles every request synchronously, so its own writers are
 *    never observable between a reader's two guard reads; and a second API
 *    process on the same database is refused by
 *    `acquireDatabasePublicationLock` by design. The fixture therefore publishes
 *    through the real control store from its own process while the API serves the
 *    HTTP load — the cross-process shape the guard exists for. (The in-process
 *    import worker is the other real publisher; it stays out of scope here.)
 *
 * Deliberately out of scope: real import/publication concurrency through the
 * import worker (that path is still covered only synthetically).
 */

const projectRoot = resolve(import.meta.dirname, "../../..");
const childScript = join(import.meta.dirname, "plan-publication-stress-child.ts");
const publisherScript = join(import.meta.dirname, "plan-publication-stress-publisher.ts");

const PUBLICATIONS = 300;
const STABLE_READS = 200;
const CONCURRENT_READS = 1600;
const READ_LOOPS = 10;
const READS_PER_LOOP = 20;
const WRITE_LOOPS = 2;
const WRITES_PER_LOOP = 25;
const PUBLISHER_PUBLICATIONS = 60;
const PUBLICATION_WINDOW_MS = 4;
const PUBLICATION_GAP_MS = 2;

interface HttpSample {
  status: number;
  retryAfter: string | null;
  code: string | null;
  durationMs: number;
  problems: string[];
}

interface PlanStateBody {
  metadata?: { goalsRevision?: number; windowStart?: string; localDate?: string };
  goals?: { revision?: number };
  workoutPlan?: { planRevision?: number; windowStart?: string };
  today?: { today?: { localDate?: string } };
  code?: unknown;
}

test("guard protocol: two real processes never observe a consistent mixed snapshot", { timeout: 120_000 }, async t => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-publication-stress-"));
  const controlPath = join(runtimeRoot, "control.sqlite");
  const mainPath = join(runtimeRoot, "main.sqlite");
  const control = new DatabaseSync(controlPath);
  const main = new DatabaseSync(mainPath);
  for (const database of [control, main]) {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA busy_timeout = 5000");
  }
  ensurePublicationGuardSchema(control);
  main.exec("CREATE TABLE IF NOT EXISTS marker(value INTEGER NOT NULL)");
  main.prepare("INSERT INTO marker(value) VALUES (0)").run();
  const selectMarker = main.prepare("SELECT value FROM marker WHERE rowid = 1");
  let child: ChildProcess | null = null;
  let childOutput = "";
  try {
    child = spawn(
      process.execPath,
      ["--import", "tsx", childScript, controlPath, mainPath, String(PUBLICATIONS)],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }
    );
    child.stdout?.on("data", (chunk: Buffer) => { childOutput += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { childOutput += chunk.toString(); });
    await waitForChildMessage(child, "ready", () => childOutput);
    const durations: number[] = [];
    let consistent = 0;
    let detected = 0;
    const violations: Array<{ phase: string; epoch: number; marker: number; pendingSince: string | null }> = [];
    let stableReads = 0;
    let stableDetections = 0;
    const readRound = (phase: string): void => {
      const started = performance.now();
      const before = readPublicationGuard(control);
      const marker = (selectMarker.get() as { value: number }).value;
      const after = readPublicationGuard(control);
      durations.push(performance.now() - started);
      if (publicationGuardChanged(before, after) !== null) {
        detected += 1;
        if (phase !== "concurrent") stableDetections += 1;
        return;
      }
      consistent += 1;
      if (phase !== "concurrent") stableReads += 1;
      if (marker !== before.epoch) {
        violations.push({ phase, epoch: before.epoch, marker, pendingSince: before.pendingSince });
      }
    };

    // Settled state first: the invariant must hold with no publisher running.
    for (let index = 0; index < STABLE_READS; index += 1) readRound("stable_before");
    // Register the completion waiter before the synchronous read loop: an IPC
    // message emitted while this process is not awaiting would be lost.
    const childDone = waitForChildMessage(child, "done", () => childOutput);
    void childDone.catch(() => { /* awaited below; this only prevents an early unhandled rejection. */ });
    child.send({ type: "go" });
    // Let the child enter its first publication before the racing reads start.
    await new Promise<void>(done => setTimeout(done, 5));
    for (let index = 0; index < CONCURRENT_READS; index += 1) readRound("concurrent");
    await childDone;
    // And again once the publisher has cleared its marker.
    for (let index = 0; index < STABLE_READS; index += 1) readRound("stable_after");

    const p50 = percentile(durations, 0.5);
    const p95 = percentile(durations, 0.95);
    t.diagnostic(`guard invariant: rounds=${durations.length} consistent=${consistent} `
      + `(${(consistent / durations.length * 100).toFixed(1)}%) detected=${detected} `
      + `(${(detected / durations.length * 100).toFixed(1)}%) detected_outside_concurrency=${stableDetections} `
      + `p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms child=${childOutput.trim().slice(0, 200)}`);
    assert.equal(violations.length, 0,
      `consistent snapshot disagreed with the guard epoch: ${JSON.stringify(violations.slice(0, 3))}`);
    assert.equal(stableReads, STABLE_READS * 2,
      "the child must not publish before 'go' or leave a marker behind after 'done'");
    assert.equal(stableDetections, 0,
      `settled phases reported a moving guard: ${JSON.stringify({ stableReads, stableDetections })}`);
    assert.ok(consistent > 0, "the run must include settled snapshots for the invariant to be meaningful");
    assert.ok(detected > 0,
      `the publisher never overlapped the reader: ${JSON.stringify({ rounds: durations.length, consistent, detected })}`);
  } finally {
    if (child !== null) await stopChild(child);
    control.close();
    main.close();
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("HTTP load: readers stay consistent, 503s are retryable, latency stays bounded", { timeout: 120_000 }, async t => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-publication-http-"));
  const databasePath = join(runtimeRoot, "var/rai.sqlite");
  const controlPath = join(runtimeRoot, "var/rai-control.sqlite");
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  (await RaiDatabase.open(databasePath)).close();
  let api: ApiProcess | null = null;
  let publisher: ChildProcess | null = null;
  let publisherOutput = "";
  try {
    api = await startApi(runtimeRoot, databasePath);
    const app = api;
    const handshake = await (await fetch(`${app.url}/v1/handshake`)).json() as
      { serverId: string; athleteId: string; datasetEpoch: string };
    const operationScope = { serverId: handshake.serverId, athleteId: handshake.athleteId, datasetEpoch: handshake.datasetEpoch };

    const baseline = await fetch(`${app.url}/v1/mobile/training-plan-state`);
    assert.equal(baseline.status, 200, `empty database must serve a plan snapshot: ${await baseline.text()}`);

    publisher = spawn(
      process.execPath,
      ["--import", "tsx", publisherScript, runtimeRoot, controlPath,
        String(PUBLISHER_PUBLICATIONS), String(PUBLICATION_WINDOW_MS), String(PUBLICATION_GAP_MS)],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }
    );
    publisher.stdout?.on("data", (chunk: Buffer) => { publisherOutput += chunk.toString(); });
    publisher.stderr?.on("data", (chunk: Buffer) => { publisherOutput += chunk.toString(); });
    await waitForChildMessage(publisher, "ready", () => publisherOutput);
    // Register the completion waiter *before* the load starts: the child may
    // finish publishing while the driver is awaiting HTTP responses, and an IPC
    // message with no listener attached is lost.
    const publisherDone = waitForChildMessage(publisher, "done", () => publisherOutput);
    void publisherDone.catch(() => { /* awaited below; this only prevents an early unhandled rejection. */ });
    publisher.send({ type: "go" });

    const readerSamples: HttpSample[] = [];
    const writerSamples: HttpSample[] = [];
    const readRound = async (): Promise<void> => {
      const started = performance.now();
      let response: Response;
      try {
        response = await fetch(`${app.url}/v1/mobile/training-plan-state`);
      } catch (error) {
        readerSamples.push({ status: 0, retryAfter: null, code: null,
          durationMs: performance.now() - started, problems: [`fetch failed: ${String(error)}`] });
        return;
      }
      const status = response.status;
      const retryAfter = response.headers.get("retry-after");
      const text = await response.text();
      const durationMs = performance.now() - started;
      const body = parseJson(text) as PlanStateBody | null;
      const problems: string[] = [];
      if (status === 200) {
        const metadata = body?.metadata, goals = body?.goals, plan = body?.workoutPlan;
        const expectEqual = (label: string, actual: unknown, expected: unknown): void => {
          if (actual !== expected) problems.push(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
        };
        expectEqual("metadata.goalsRevision === goals.revision", metadata?.goalsRevision, goals?.revision);
        expectEqual("workoutPlan.planRevision === metadata.goalsRevision", plan?.planRevision, metadata?.goalsRevision);
        expectEqual("workoutPlan.windowStart === metadata.windowStart", plan?.windowStart, metadata?.windowStart);
        expectEqual("metadata.localDate === today.today.localDate", metadata?.localDate, body?.today?.today?.localDate);
      }
      readerSamples.push({ status, retryAfter, code: typeof body?.code === "string" ? body.code : null, durationMs, problems });
    };
    const writeRound = async (sequence: number): Promise<void> => {
      const started = performance.now();
      let response: Response;
      try {
        response = await fetch(`${app.url}/v1/mobile/goals`, {
          method: "PUT", headers: { "content-type": "application/json" },
          // Metadata only: no `weekPlan`, so the write does not need the main
          // database and every writer competes for the same control transaction.
          body: JSON.stringify({ operationId: randomUUID(), operationScope, qualitySessionCap: sequence % 5 })
        });
      } catch (error) {
        writerSamples.push({ status: 0, retryAfter: null, code: null,
          durationMs: performance.now() - started, problems: [`fetch failed: ${String(error)}`] });
        return;
      }
      const status = response.status;
      const retryAfter = response.headers.get("retry-after");
      const text = await response.text();
      const body = parseJson(text) as { code?: unknown } | null;
      writerSamples.push({ status, retryAfter, code: typeof body?.code === "string" ? body.code : null,
        durationMs: performance.now() - started, problems: [] });
    };

    // Writers start first so readers observe publications in flight rather than
    // an idle server; both run concurrently from then on.
    const writers = Array.from({ length: WRITE_LOOPS }, async (_unused, writer) => {
      for (let index = 0; index < WRITES_PER_LOOP; index += 1) await writeRound(writer * WRITES_PER_LOOP + index);
    });
    await new Promise<void>(done => setTimeout(done, 15));
    const readers = Array.from({ length: READ_LOOPS }, async () => {
      for (let index = 0; index < READS_PER_LOOP; index += 1) await readRound();
    });
    await Promise.all([...writers, ...readers]);
    await publisherDone;
    t.diagnostic(`cross-process publisher: publications=${PUBLISHER_PUBLICATIONS} window=${PUBLICATION_WINDOW_MS}ms `
      + `gap=${PUBLICATION_GAP_MS}ms`);

    const readerStatuses = countStatuses(readerSamples);
    const writerStatuses = countStatuses(writerSamples);
    const reader503 = readerSamples.filter(sample => sample.status === 503);
    const readerOther = readerSamples.filter(sample => sample.status !== 200 && sample.status !== 503);
    const writerOther = writerSamples.filter(sample => ![200, 409, 503].includes(sample.status));
    const inconsistent = readerSamples.filter(sample => sample.problems.length > 0);
    const readerLatency = readerSamples.map(sample => sample.durationMs);
    const p50 = percentile(readerLatency, 0.5);
    const p95 = percentile(readerLatency, 0.95);
    const p95Success = percentile(readerSamples.filter(sample => sample.status === 200).map(sample => sample.durationMs), 0.95);
    const errorCodes = countCodes(reader503);
    t.diagnostic(`HTTP readers n=${readerSamples.length}: 200=${readerStatuses[200] ?? 0} `
      + `503=${readerStatuses[503] ?? 0} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms `
      + `(200-only p95=${p95Success.toFixed(1)}ms) inconsistent_200=${inconsistent.length}`);
    t.diagnostic(`HTTP writers n=${writerSamples.length}: 200=${writerStatuses[200] ?? 0} `
      + `409=${writerStatuses[409] ?? 0} 503=${writerStatuses[503] ?? 0}`);
    t.diagnostic(`reader 503 codes: ${JSON.stringify(errorCodes)}`);
    const firstProblems = inconsistent.slice(0, 3).map(sample => sample.problems);
    assert.equal(readerOther.length, 0, `readers must only see 200/503: ${JSON.stringify(readerOther.slice(0, 3))}`);
    assert.equal(writerOther.length, 0, `writers must only see 200/409/503: ${JSON.stringify(writerOther.slice(0, 3))}`);
    assert.equal(inconsistent.length, 0, `mixed 200 snapshots: ${JSON.stringify(firstProblems)}`);
    assert.ok(reader503.every(sample => sample.retryAfter === "1"),
      `every 503 must carry Retry-After: 1: ${JSON.stringify(reader503.filter(sample => sample.retryAfter !== "1").slice(0, 3))}`);
    assert.ok(writerSamples.filter(sample => sample.status === 503).every(sample => sample.retryAfter === "1"),
      "writer 503s must be retryable too");
    assert.ok(reader503.length >= 1,
      `the scenario did not produce a single detected publication: ${JSON.stringify(readerStatuses)}`);
    assert.ok(writerSamples.some(sample => sample.status === 200), "at least one metadata write must commit");
    assert.ok(p95 < 2000, `reader p95 ${p95.toFixed(1)}ms must stay under the 2000ms stress budget`);
  } finally {
    if (publisher !== null) await stopChild(publisher);
    if (api !== null) await stopApi(api.child);
    await removeRuntimeRoot(runtimeRoot);
  }
});

interface ApiProcess {
  child: ChildProcess;
  url: string;
}

async function startApi(runtimeRoot: string, databasePath: string): Promise<ApiProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
  await waitForApi(child, url, () => output);
  return { child, url };
}

async function stopApi(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>(resolvePromise => { child.once("close", () => resolvePromise()); });
  try {
    if (child.connected) child.send("rai:shutdown", () => {});
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await closed;
  clearTimeout(killer);
}

function waitForChildMessage(child: ChildProcess, type: "ready" | "done", output: () => string): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`child did not send ${type}: ${output()}`));
    }, 60_000);
    const onMessage = (message: unknown): void => {
      if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === type) {
        cleanup();
        resolvePromise();
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      rejectPromise(new Error(`child exited with ${code} before ${type}: ${output()}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>(resolvePromise => { child.once("close", () => resolvePromise()); });
  child.kill("SIGKILL");
  await Promise.race([closed, new Promise<void>(resolvePromise => setTimeout(resolvePromise, 10_000))]);
}

async function waitForApi(child: ChildProcess, url: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output() || `API exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/v1/health`);
      if (response.ok) return;
    } catch { /* API is still starting. */ }
    await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(output() || "API did not become ready");
}

async function waitForBoundPort(child: ChildProcess, output: () => string): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const timer = setTimeout(() => rejectPort(new Error(output() || "API did not report its bound port")), 60_000);
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      rejectPort(new Error(output() || `API exited with ${code}`));
    };
    child.once("exit", onExit);
    child.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null &&
        (message as { type?: unknown }).type === "rai:ready" &&
        Number.isInteger((message as { port?: unknown }).port)) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolvePort((message as { port: number }).port);
      }
    });
  });
}

async function removeRuntimeRoot(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 100));
    }
  }
  // Last resort: the server/publisher may still be releasing handles. A stuck
  // temp directory must not turn a green run red.
  rmSync(path, { recursive: true, force: true });
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function countStatuses(samples: HttpSample[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const sample of samples) counts[sample.status] = (counts[sample.status] ?? 0) + 1;
  return counts;
}

function countCodes(samples: HttpSample[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sample of samples) {
    const code = sample.code ?? "no_code";
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}
