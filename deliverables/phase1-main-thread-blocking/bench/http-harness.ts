/**
 * Shared HTTP acceptance harness for phase 1.
 *
 * The workload deliberately goes through the real API entry point:
 *   - source selection is a persisted source snapshot, not a label;
 *   - imports use POST /v1/imports/uploads -> /v1/imports/inspect -> /v1/import-jobs;
 *   - health/read latency is measured by an external fetch loop;
 *   - no private ImportWorker.run() is called by the benchmark.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, cpSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

import { CONTRACT_VERSION } from "@rai/contracts";
import { NATIVE_VERSION, identityAlgorithmFingerprint } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";
import yazl from "yazl";

import { IMPORT_PAYLOAD_ANCHOR_KEY, computeImportPayloadSha256 } from "../../../apps/api/src/import-payload-identity.js";

export type BenchmarkMode = "baseline" | "phase1-prefix" | "repaired";

export interface BenchmarkOutput {
  schema: "rai-phase1-http-evidence-v1";
  mode: BenchmarkMode;
  generatedAt: string;
  source: {
    snapshotRoot: string;
    fingerprintSha256: string;
    gitHead: string;
    workingTreeDiffSha256: string | null;
  };
  environment: {
    platform: string;
    release: string;
    arch: string;
    node: string;
    cpuCount: number;
    totalMemoryBytes: number;
  };
  config: Record<string, number | string | boolean>;
  rounds?: unknown[];
  summary?: unknown;
  error?: string;
}

export const benchRoot = resolve(import.meta.dirname, "..");
export const projectRoot = resolve(import.meta.dirname, "../../..");
const token = "phase1-bench-token-0123456789";

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function snapshotRoot(mode: BenchmarkMode): string {
  return resolve(benchRoot, "snapshots", mode);
}

/** Hash every source file in a deterministic path order; this names the code actually executed. */
export function snapshotFingerprint(mode: BenchmarkMode): string {
  const root = snapshotRoot(mode);
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.push(next);
    }
  };
  walk("apps/api/src");
  for (const file of files) {
    hash.update(file.split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Materialise the snapshot so tsx resolves modules from a workspace-like root. */
export function materializeSnapshot(mode: BenchmarkMode, destination: string): string {
  const source = snapshotRoot(mode);
  for (const file of ["package.json", "apps/api/package.json"]) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source, file), target);
  }
  cpSync(join(source, "apps/api/src"), join(destination, "apps/api/src"), { recursive: true });
  const modules = join(destination, "node_modules");
  if (!existsSync(modules)) symlinkSync(join(projectRoot, "node_modules"), modules, "dir");
  return join(destination, "apps/api/src/server.ts");
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => port > 0 ? resolvePort(port) : reject(new Error("no free port")));
    });
  });
}

export interface ApiProcess {
  child: ChildProcessWithoutNullStreams;
  baseUrl: string;
  port: number;
  stop(): Promise<void>;
  output(): string;
}

export async function startApi(input: {
  mode: BenchmarkMode;
  experimentRoot: string;
  runtimeRoot: string;
  databasePath: string;
}): Promise<ApiProcess> {
  const sourceRoot = join(input.experimentRoot, "source");
  const entry = materializeSnapshot(input.mode, sourceRoot);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: input.runtimeRoot,
      RAI_DATABASE: input.databasePath,
      RAI_CONTROL_DATABASE: join(input.runtimeRoot, "var", "rai-control.sqlite"),
      RAI_API_PORT: String(port),
      RAI_API_HOST: "127.0.0.1",
      RAI_API_TOKEN: token,
      RAI_LOG_LEVEL: "silent",
      RAI_DEPLOYMENT_MODE: "local",
      RAI_PHASE1_BENCH_RESET: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let lastHealth = "(no response)";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited during startup (${child.exitCode}):\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/v1/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000) });
      lastHealth = `${response.status} ${await response.text()}`;
      if (response.ok) {
        const health = JSON.parse(lastHealth.slice(lastHealth.indexOf(" ") + 1)) as { status?: string; databaseReady?: boolean };
        if (health.status === "ok" && health.databaseReady === true) break;
      }
    } catch { /* retry until startup deadline */ }
    await sleep(50);
  }
  if (Date.now() >= deadline) {
    child.kill("SIGKILL");
    throw new Error(`API did not become ready; last health=${lastHealth}\n${output}`);
  }
  return {
    child, baseUrl, port,
    output: () => output,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        sleep(10_000).then(() => { child.kill("SIGKILL"); throw new Error(`API ${port} did not stop after SIGTERM`); })
      ]);
    }
  };
}

/** Initial fixture: a database whose anchor exactly matches the payload later uploaded. */
export async function prepareDatabase(input: {
  runtimeRoot: string;
  databasePath: string;
  fixtureRoot: string;
}): Promise<{ payloadSha256: string; zipBuffer: Buffer }> {
  mkdirSync(join(input.runtimeRoot, "var"), { recursive: true });
  mkdirSync(input.fixtureRoot, { recursive: true });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
 <ExportDate value="2026-09-23 10:01:26 +0800"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="142" startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:00:01 +0800"><MetadataEntry key="RAIHealthKitSampleUUID" value="00000000-0000-4000-8000-0000000000a1"/></Record>
</HealthData>`;
  const manifest = JSON.stringify({
    version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
  });
  writeFileSync(join(input.fixtureRoot, "export.xml"), xml, "utf8");
  writeFileSync(join(input.fixtureRoot, "sync-manifest.json"), manifest, "utf8");

  const store = await RaiDatabase.open(input.databasePath);
  try {
    store.setManifest("dataset_version", "phase1_fixture");
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
    store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      const workoutId = `phase1_workout_${index}`;
      const startedAt = new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
      const endedAt = new Date(Date.parse(startedAt) + 1_800_000).toISOString();
      store.database.prepare(`INSERT INTO workouts (
        id, activity_type, source_name, source_category, start_at, end_at,
        duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical
      ) VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture', 'apple_watch', ?, ?, 1800, 0, '{}', '{}', 1)`)
        .run(workoutId, startedAt, endedAt);
      store.database.prepare(`INSERT INTO training_sessions (
        id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status
      ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 5, ?, 'active')`)
        .run(`phase1_session_${index}`, startedAt, endedAt, workoutId);
    }
  } finally { store.close(); }

  const payloadSha256 = await computeImportPayloadSha256(input.fixtureRoot, {
    preserveAbsent: true,
    contractVersion: CONTRACT_VERSION,
    engine: `typescript@${NATIVE_VERSION}`,
    identityAlgorithm: identityAlgorithmFingerprint()
  });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(input.databasePath);
  try {
    db.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)")
      .run(IMPORT_PAYLOAD_ANCHOR_KEY, JSON.stringify({ sha256: payloadSha256, datasetVersion: "phase1_fixture" }));
  } finally { db.close(); }

  return { payloadSha256, zipBuffer: await makeZip(input.fixtureRoot) };
}

async function makeZip(fixtureRoot: string): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  zip.addFile(join(fixtureRoot, "export.xml"), "export.xml");
  zip.addFile(join(fixtureRoot, "sync-manifest.json"), "sync-manifest.json");
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export interface JobResult {
  id: string;
  status: string;
  phase: string;
  jobMs: number;
  createMs: number;
  uploadMs: number;
  message?: string;
}

export async function runNoopImport(api: ApiProcess, zipBuffer: Buffer, index: number): Promise<JobResult> {
  const started = performance.now();
  const form = new FormData();
  form.append("file", new Blob([zipBuffer], { type: "application/zip" }), `phase1-${index}.zip`);
  const uploadStart = performance.now();
  const upload = await fetch(`${api.baseUrl}/v1/imports/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-rai-sync-batch": `phase1-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}` },
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
  const uploadBody = await upload.json() as { sourceId?: string; message?: string };
  if (!upload.ok || !uploadBody.sourceId) throw new Error(`upload failed ${upload.status}: ${JSON.stringify(uploadBody)}`);
  const uploadMs = performance.now() - uploadStart;

  const inspect = await fetch(`${api.baseUrl}/v1/imports/inspect`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: uploadBody.sourceId }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!inspect.ok) throw new Error(`inspect failed ${inspect.status}: ${await inspect.text()}`);

  const createStart = performance.now();
  const create = await fetch(`${api.baseUrl}/v1/import-jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: uploadBody.sourceId }),
    signal: AbortSignal.timeout(30_000)
  });
  const created = await create.json() as { id?: string; status?: string; message?: string };
  if (!create.ok || !created.id) throw new Error(`create job failed ${create.status}: ${JSON.stringify(created)}`);
  const createMs = performance.now() - createStart;

  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch(`${api.baseUrl}/v1/import-jobs/${created.id}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000)
    });
    const job = await response.json() as { id: string; status: string; phase: string; message?: string };
    if (!response.ok) throw new Error(`job poll failed ${response.status}: ${JSON.stringify(job)}`);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) {
      return {
        id: created.id, status: job.status, phase: job.phase, message: job.message,
        uploadMs, createMs, jobMs: performance.now() - started
      };
    }
    if (Date.now() > deadline) throw new Error(`job ${created.id} did not settle within 30s`);
    await sleep(10);
  }
}

export interface PerformanceSample {
  eventLoopP95Ms: number;
  eventLoopMaxMs: number;
  processRssBytes: number;
  processMaxRssKiB: number;
  importPending: boolean;
  requests: number;
  serverErrors: number;
}

export async function resetPerformanceWindow(api: ApiProcess): Promise<void> {
  const response = await fetch(`${api.baseUrl}/v1/performance?reset=1`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`performance reset failed ${response.status}`);
  await response.arrayBuffer();
  await sleep(100);
}

export async function performanceSample(api: ApiProcess): Promise<PerformanceSample> {
  const response = await fetch(`${api.baseUrl}/v1/performance`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`performance failed ${response.status}`);
  return await response.json() as PerformanceSample;
}

export interface TrafficSample {
  atMs: number;
  phase: "locked" | "unlocked";
  route: "/v1/health" | "/v1/dashboard";
  status: number;
  ms: number;
  error?: string;
}

export function startTraffic(api: ApiProcess, concurrency = 6): {
  setPhase(phase: "locked" | "unlocked"): void;
  stop(): Promise<TrafficSample[]>;
} {
  let phase: "locked" | "unlocked" = "unlocked";
  let stopped = false;
  const samples: TrafficSample[] = [];
  const start = performance.now();
  const loops = Array.from({ length: concurrency }, async (_, workerIndex) => {
    let iteration = 0;
    while (!stopped) {
      const route = (workerIndex + iteration) % 2 === 0 ? "/v1/health" : "/v1/dashboard";
      const started = performance.now();
      const phaseAtStart = phase;
      try {
        const response = await fetch(`${api.baseUrl}${route}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000)
        });
        await response.arrayBuffer();
        samples.push({
          atMs: started - start, phase: phaseAtStart, route, status: response.status,
          ms: performance.now() - started
        });
      } catch (error) {
        samples.push({
          atMs: started - start, phase: phaseAtStart, route, status: 0,
          ms: performance.now() - started,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      iteration += 1;
      await sleep(10);
    }
  });
  return {
    setPhase(value) { phase = value; },
    async stop() {
      stopped = true;
      await Promise.all(loops);
      return samples;
    }
  };
}

export function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

export function summarizeTraffic(samples: TrafficSample[], phase: "locked" | "unlocked") {
  const subset = samples.filter((sample) => sample.phase === phase);
  return {
    requests: subset.length,
    healthRequests: subset.filter((sample) => sample.route === "/v1/health").length,
    readRequests: subset.filter((sample) => sample.route === "/v1/dashboard").length,
    errors: subset.filter((sample) => sample.status === 0 || sample.status >= 500).length,
    serverErrors: subset.filter((sample) => sample.status >= 500).length,
    p50Ms: percentile(subset.map((sample) => sample.ms), 0.50),
    p95Ms: p95(subset.map((sample) => sample.ms)),
    p99Ms: percentile(subset.map((sample) => sample.ms), 0.99),
    maxMs: subset.reduce((max, sample) => Math.max(max, sample.ms), 0)
  };
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

export async function writeTrafficSamples(path: string, samples: TrafficSample[]): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await pipeline(
    ReadableFrom(samples.map((sample) => `${JSON.stringify(sample)}\n`)),
    createGzip(),
    createWriteStream(path)
  );
}

function ReadableFrom(lines: string[]) {
  // Avoid importing stream.Readable in the hot path: a small async generator is enough.
  return (async function* () { for (const line of lines) yield line; })();
}

export interface LockHelper {
  /** Resolves after BEGIN IMMEDIATE succeeded; `released` resolves after COMMIT. */
  begin(): Promise<{ released: Promise<void> }>;
  close(): Promise<void>;
}

/** External SQLite writer. It owns BEGIN IMMEDIATE/COMMIT and exposes real lock windows. */
export async function startLockHelper(databasePath: string): Promise<LockHelper> {
  const script = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout=0");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const command = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (command === "lock") {
      try {
        db.exec("BEGIN IMMEDIATE");
        process.stdout.write("locked\\n");
        setTimeout(() => {
          try { db.exec("COMMIT"); process.stdout.write("unlocked\\n"); }
          catch (error) { process.stderr.write(String(error) + "\\n"); process.exit(2); }
        }, Number(process.argv[2]));
      } catch (error) {
        process.stderr.write(String(error) + "\\n");
        process.exit(3);
      }
    } else if (command === "close") {
      try { db.close(); } catch {}
      process.exit(0);
    }
  }
});
process.stdout.write("ready\\n");
`;
  const child = spawn(process.execPath, ["-e", script, databasePath, "1200"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "";
  const waiters: Array<{ line: string; resolve: () => void; reject: (error: Error) => void }> = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const index = waiters.findIndex((waiter) => waiter.line === line);
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        waiter?.resolve();
      }
    }
  });
  const waitFor = (line: string) => new Promise<void>((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error(`lock helper did not emit ${line}; stderr=${stderr}`)), 15_000);
    waiters.push({ line, resolve: () => { clearTimeout(timer); resolveLine(); }, reject });
  });
  await waitFor("ready");
  return {
    async begin() {
      child.stdin.write("lock\n");
      await waitFor("locked");
      return { released: waitFor("unlocked") };
    },
    async close() {
      child.stdin.write("close\n");
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      if (child.exitCode !== 0) throw new Error(`lock helper exited ${child.exitCode}: ${stderr}`);
    }
  };
}

export function environmentInfo() {
  return {
    platform: process.platform,
    release: process.release.name,
    arch: process.arch,
    node: process.version,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem()
  };
}

export function fileSha256(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

export function countFiles(directory: string): number {
  if (!existsSync(directory)) return 0;
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(directory, entry.name));
    else count += 1;
  }
  return count;
}

export function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export { sleep, token };
