// 阶段 2 follow-up B：外部提交后首次 /series 的 HTTP/事件循环验收。
//
// 每个状态都在一份隔离数据库副本上启动真实 API；外部写者提交后并发请求首次
// /series 与 /health，再请求第二次 /series（热读）。每状态 5 个 AB/BA 块 ×
// 20 个正式周期，另加 2 个预热周期（不入样）。逐请求保存 ms/状态/正文哈希；
// 每周期从 /v1/performance 读取事件循环 P95/Max 与 RSS。
//
// 用法：
//   node --import tsx scripts/phase2-series-cache-bench.mjs \
//     --root <experiment-root> --db <pristine.sqlite> --label baseline \
//     --json <absolute-out> [--cycles 100] [--blocks 5] [--states receipt,new-health,...] \
//     [--hot-only] [--hot-warmup 100] [--windows recent,p25,p50,p75,oldest]
//
// 热读窗口只选 `workouts.deleted_at IS NULL` 的真实可读训练；每个预热/正式
// 请求都校验 200、trainingSessionId 与非空 business body，404 不再能进入样本。
// 选窗按 `anchor_start_at, id` 升序：oldest=第一条，recent=最后一条；p25/p50/p75
// 是可读训练数量分位（floor((N-1)*ratio)），不是日历跨度分位，元数据随证据输出。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { selectTrainingWindows } from "./phase2-series-window-selection.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const fail = (message) => { console.error(`phase2-series-cache-bench: ${message}`); process.exit(2); };

function realTarget(path) {
  let current = resolve(path);
  const suffix = [];
  while (!existsSync(current)) {
    suffix.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(realpathSync(current), ...suffix);
}
const pathContains = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const rootArg = readArg("--root");
const dbArg = readArg("--db");
const label = readArg("--label", "candidate");
const out = readArg("--json");
if (!rootArg || !dbArg || !out || !isAbsolute(out)) fail("--root, --db and an absolute --json are required");
const root = resolve(rootArg);
const repoReal = realpathSync(REPO_ROOT);
if (pathContains(repoReal, root) || pathContains(root, repoReal)) fail(`experiment root must be outside the repository: ${root}`);
mkdirSync(root, { recursive: true });
const rootReal = realpathSync(root);
const databaseSource = resolve(dbArg);
if (!existsSync(databaseSource)) fail(`missing database: ${databaseSource}`);
if (lstatSync(databaseSource).isSymbolicLink()) fail(`database must not be a symlink: ${databaseSource}`);
if (pathContains(repoReal, realpathSync(databaseSource))) fail(`database must not point inside the repository: ${databaseSource}`);
const databaseReal = realpathSync(databaseSource);
if (!pathContains(rootReal, databaseReal)) fail(`database must be inside the experiment root: ${databaseReal}`);

const cycles = Number(readArg("--cycles", "100"));
const blocks = Number(readArg("--blocks", "5"));
const warmups = Number(readArg("--warmup", "2"));
const hotWarmups = Number(readArg("--hot-warmup", "100"));
const hotOnly = args.includes("--hot-only");
const windowsArg = readArg("--windows");
const requestedWindows = windowsArg === null
  ? null
  : new Set(windowsArg.split(",").map((value) => value.trim()).filter(Boolean));
const statesArg = readArg("--states", "receipt,new-health,longer-record,revise,delete,route,workout-metadata");
if (!Number.isInteger(cycles) || cycles < 1 || cycles % blocks !== 0 || blocks < 1) fail("--cycles must be a positive multiple of --blocks");
if (!Number.isInteger(hotWarmups) || hotWarmups < 0) fail("--hot-warmup must be a non-negative integer");
const states = statesArg.split(",").map((value) => value.trim()).filter(Boolean);
const knownStates = new Set(["receipt", "new-health", "longer-record", "revise", "delete", "route", "workout-metadata"]);
for (const state of states) if (!knownStates.has(state)) fail(`unknown state: ${state}`);

const percentile = (sorted, ratio) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
const summarize = (values) => {
  if (values.length === 0) return { samples: 0, p50: null, p95: null, min: null, max: null, mean: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  };
};

const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    probe.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no free port"))));
  });
});

async function startServer(runtimeLabel, databasePath, port) {
  const runtimeRoot = join(rootReal, `runtime-${runtimeLabel}`);
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: runtimeRoot,
      RAI_DATABASE: databasePath,
      RAI_CONTROL_DATABASE: join(runtimeRoot, "var", "rai-control.sqlite"),
      RAI_API_PORT: String(port),
      RAI_API_HOST: "127.0.0.1",
      RAI_API_TOKEN: "phase2-series-cache-token",
      RAI_LOG_LEVEL: "silent",
      RAI_PHASE1_BENCH_RESET: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API ${runtimeLabel} exited ${child.exitCode}: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { host: `127.0.0.1:${port}`, authorization: "Bearer phase2-series-cache-token" }
      });
      if (response.ok) return { child, output: () => output };
    } catch { /* not ready */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`API ${runtimeLabel} did not become ready: ${output}`);
}

async function stopServer(server) {
  server.child.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (server.child.exitCode === null && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
  return { exitCode: server.child.exitCode, signal: server.child.signalCode };
}

async function request(port, path) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { host: `127.0.0.1:${port}`, authorization: "Bearer phase2-series-cache-token" }
  });
  const body = await response.text();
  const ms = performance.now() - started;
  return { ms, status: response.status, body, bodyBytes: Buffer.byteLength(body), bodySha256: createHash("sha256").update(body).digest("hex") };
}
const sampleOf = (response) => ({
  ms: response.ms,
  status: response.status,
  bodyBytes: response.bodyBytes,
  bodySha256: response.bodySha256,
  trainingSessionId: response.trainingSessionId ?? null,
  metricSamples: response.metricSamples ?? null,
  splitCount: response.splitCount ?? null,
  segmentCount: response.segmentCount ?? null
});

/**
 * A 404 body is 47 bytes and has a stable hash. Latency of that error response
 * must never be recorded as a valid hot-read window. `requestSeries` rejects the
 * whole run unless the target is the requested training session and the body
 * contains observable business data.
 */
async function requestSeries(port, sessionId, label) {
  const response = await request(port, `/v1/workouts/${sessionId}/series`);
  if (response.status !== 200) {
    throw new Error(`${label}: /series status ${response.status} body=${response.body.slice(0, 200)}`);
  }
  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new Error(`${label}: /series body is not JSON`);
  }
  if (body?.trainingSessionId !== sessionId) {
    throw new Error(`${label}: /series identity ${String(body?.trainingSessionId)} != ${sessionId}`);
  }
  const splitCount = Array.isArray(body.splits) ? body.splits.length : 0;
  const segmentCount = Array.isArray(body.segments) ? body.segments.length : 0;
  const metricSamples = Object.values(body.series ?? {}).reduce((sum, metric) => {
    const count = Number(metric?.totalSamples ?? 0);
    return sum + (Number.isFinite(count) ? count : 0);
  }, 0);
  if (metricSamples <= 0 && splitCount === 0 && segmentCount === 0) {
    throw new Error(`${label}: /series has no metric samples, splits or segments`);
  }
  return { ...response, trainingSessionId: body.trainingSessionId, metricSamples, splitCount, segmentCount };
}

function databaseInfo(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const session = db.prepare(`
      SELECT session.id, session.anchor_start_at AS startedAt, session.anchor_end_at AS endedAt,
             session.anchor_distance_km AS distanceKm, workout.id AS workoutId, workout.source_name AS sourceName
      FROM training_sessions session JOIN workouts workout ON workout.id = session.canonical_workout_id
      WHERE session.status = 'active' AND session.anchor_distance_km > 0
        AND workout.deleted_at IS NULL
      ORDER BY session.anchor_start_at, session.id LIMIT 1
    `).get();
    if (!session) throw new Error("database has no readable active workout session");
    const all = db.prepare(`
      SELECT session.id, session.anchor_start_at AS startedAt, session.anchor_end_at AS endedAt
      FROM training_sessions session JOIN workouts workout ON workout.id = session.canonical_workout_id
      WHERE session.status = 'active' AND session.anchor_distance_km > 0
        AND workout.deleted_at IS NULL
      ORDER BY session.anchor_start_at, session.id
    `).all().map((row) => ({
      id: String(row.id),
      startedAt: String(row.startedAt),
      endedAt: row.endedAt === null || row.endedAt === undefined ? null : String(row.endedAt)
    }));
    if (all.length === 0) throw new Error("database has no readable workout windows");
    const selection = selectTrainingWindows(all);
    const windows = selection.windows
      .filter((window) => requestedWindows === null || requestedWindows.has(window.name));
    if (windows.length === 0) throw new Error(`--windows selected no known window: ${windowsArg}`);
    return {
      session,
      windows,
      readableSessions: selection.readableSessions,
      windowSelection: selection.selection
    };
  } finally { db.close(); }
}

const target = databaseInfo(databaseReal);
const runtimeDirectory = join(rootReal, `db-${label}`);
mkdirSync(runtimeDirectory, { recursive: true });

function runtimeDatabase(state) {
  const path = join(runtimeDirectory, `${state}.sqlite`);
  copyFileSync(databaseReal, path);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  return path;
}

function prepareStateDatabase(path, state) {
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA busy_timeout = 5000");
  const workoutId = target.session.workoutId;
  if (state === "delete") {
    const insert = writer.prepare(`INSERT OR REPLACE INTO health_records
      (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
      VALUES (?, 'HKQuantityTypeIdentifierHeartRate', ?, 'third_party', 'count/min', 140, ?, ?, '{}', '{}')`);
    const start = Date.parse(target.session.startedAt);
    for (let index = 0; index < cycles + warmups + 10; index += 1) {
      insert.run(`phase2-delete-${index}`, target.session.sourceName,
        new Date(start + (index % 50) * 1000).toISOString(),
        new Date(start + (index % 50) * 1000 + 30_000).toISOString());
    }
  }
  writer.close();
}

function applyCommit(writer, state, index) {
  const startMs = Date.parse(target.session.startedAt);
  const timestamp = new Date(startMs + (index % 300) * 1000).toISOString();
  switch (state) {
    case "receipt":
      writer.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES ('phase2-followup-receipt', ?)").run(String(index));
      break;
    case "new-health":
      writer.prepare(`INSERT OR REPLACE INTO health_records
        (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
        VALUES (?, 'HKQuantityTypeIdentifierHeartRate', ?, 'third_party', 'count/min', 141, ?, ?, '{}', '{}')`)
        .run(`phase2-new-${index}`, target.session.sourceName, timestamp, new Date(Date.parse(timestamp) + 10_000).toISOString());
      break;
    case "longer-record":
      writer.prepare(`INSERT OR REPLACE INTO health_records
        (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
        VALUES (?, 'HKQuantityTypeIdentifierHeartRate', ?, 'third_party', 'count/min', 142, ?, ?, '{}', '{}')`)
        .run(`phase2-longer-${index}`, target.session.sourceName,
          new Date(startMs - 2 * 3_600_000).toISOString(), new Date(Date.parse(timestamp) + 10_000).toISOString());
      break;
    case "revise":
      writer.prepare(`UPDATE health_records SET end_at = ?, value_numeric = 143
        WHERE id = (SELECT id FROM health_records WHERE type = 'HKQuantityTypeIdentifierHeartRate'
          AND source_name = ? ORDER BY start_at LIMIT 1)`)
        .run(new Date(Date.parse(timestamp) + 20_000).toISOString(), target.session.sourceName);
      break;
    case "delete":
      writer.prepare("DELETE FROM health_records WHERE id = ?").run(`phase2-delete-${index}`);
      break;
    case "route":
      writer.prepare("UPDATE workout_routes SET file_status = file_status WHERE workout_id = ?").run(target.session.workoutId);
      break;
    case "workout-metadata":
      writer.prepare("UPDATE workouts SET metadata_json = metadata_json WHERE id = ?").run(target.session.workoutId);
      break;
    default:
      throw new Error(`unknown state ${state}`);
  }
}

async function measureState(state) {
  const databasePath = runtimeDatabase(state);
  prepareStateDatabase(databasePath, state);
  const port = await freePort();
  const server = await startServer(`${label}-${state}`, databasePath, port);
  const writer = new DatabaseSync(databasePath);
  writer.exec("PRAGMA busy_timeout = 5000");
  const samples = [];
  const warmupSamples = [];
  const statuses = new Set();
  let rssStart = null;
  let rssMax = null;
  try {
    // 普通 /series 预热，随后每个周期只测“外部提交后的首读”。30 次是为了让
    // 请求外的 stats worker 完成首轮冷页扫描；否则 worker 与正式周期争用磁盘，
    // 会把启动预热成本误算成提交后首读延迟。
    for (let warm = 0; warm < 30; warm += 1) {
      await requestSeries(port, target.session.id, `${state}/warmup`);
    }
    const runCycle = async (cycle, record, mutationIndex) => {
      await request(port, "/v1/performance?reset=1");
      const beforePerformance = JSON.parse((await request(port, "/v1/performance")).body);
      if (rssStart === null) rssStart = Number(beforePerformance.processRssBytes ?? 0);
      writer.exec("BEGIN IMMEDIATE");
      applyCommit(writer, state, mutationIndex);
      writer.exec("COMMIT");
      const [firstSeries, health] = await Promise.all([
        requestSeries(port, target.session.id, `${state}/first`),
        request(port, "/v1/health")
      ]);
      const secondSeries = await requestSeries(port, target.session.id, `${state}/second`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      const performanceResponse = await request(port, "/v1/performance");
      const performanceBody = JSON.parse(performanceResponse.body);
      statuses.add(firstSeries.status);
      statuses.add(health.status);
      statuses.add(secondSeries.status);
      const sample = {
        cycle,
        firstSeries: sampleOf(firstSeries),
        concurrentHealth: sampleOf(health),
        secondSeries: sampleOf(secondSeries),
        eventLoopP95Ms: Number(performanceBody.eventLoopP95Ms ?? 0),
        eventLoopMaxMs: Number(performanceBody.eventLoopMaxMs ?? 0),
        processRssBytes: Number(performanceBody.processRssBytes ?? 0),
        serverErrors: Number(performanceBody.serverErrors ?? 0)
      };
      rssMax = Math.max(rssMax ?? 0, sample.processRssBytes);
      (record ? samples : warmupSamples).push(sample);
    };
    for (let warm = 0; warm < warmups; warm += 1) await runCycle(warm, false, warm);
    for (let block = 0; block < blocks; block += 1) {
      for (let index = 0; index < cycles / blocks; index += 1) {
        const cycle = block * (cycles / blocks) + index;
        await runCycle(cycle, true, warmups + cycle);
      }
    }
  } finally {
    writer.close();
    const shutdown = await stopServer(server);
    if (shutdown.exitCode !== 0) throw new Error(`API ${label}/${state} shutdown exit=${shutdown.exitCode}`);
  }
  return {
    state,
    database: databasePath,
    firstSeries: summarize(samples.map((sample) => sample.firstSeries.ms)),
    concurrentHealth: summarize(samples.map((sample) => sample.concurrentHealth.ms)),
    secondSeries: summarize(samples.map((sample) => sample.secondSeries.ms)),
    eventLoopP95Ms: summarize(samples.map((sample) => sample.eventLoopP95Ms)),
    eventLoopMaxMs: summarize(samples.map((sample) => sample.eventLoopMaxMs)),
    rssBytes: { start: rssStart, max: rssMax, end: samples.at(-1)?.processRssBytes ?? null },
    statuses: [...statuses],
    serverErrors: samples.at(-1)?.serverErrors ?? 0,
    samples,
    warmupSamples
  };
}

async function measureHotWindows() {
  const results = {};
  for (const window of target.windows) {
    const port = await freePort();
    const databasePath = runtimeDatabase(`hot-${window.name}`);
    const server = await startServer(`${label}-hot-${window.name}`, databasePath, port);
    try {
      // 100 次热读预热：请求外 stats worker 首轮扫描（D2/D3 冷页缓存可达数秒到数十秒）
      // 必须在正式样本前完成；否则会把“启动预热”误算成外部提交后的首读问题。
      for (let warm = 0; warm < hotWarmups; warm += 1) {
        await requestSeries(port, window.id, `${label}/hot-${window.name}/warmup`);
      }
      const samples = [];
      for (let index = 0; index < 200; index += 1) {
        samples.push(sampleOf(await requestSeries(port, window.id, `${label}/hot-${window.name}`)));
      }
      const statuses = [...new Set(samples.map((sample) => sample.status))];
      const trainingSessionIds = [...new Set(samples.map((sample) => sample.trainingSessionId))];
      const metricSamples = samples.map((sample) => sample.metricSamples);
      if (statuses.length !== 1 || statuses[0] !== 200) {
        throw new Error(`${label}/hot-${window.name}: statuses ${statuses.join(",")}`);
      }
      if (trainingSessionIds.length !== 1 || trainingSessionIds[0] !== window.id) {
        throw new Error(`${label}/hot-${window.name}: identities ${trainingSessionIds.join(",")} != ${window.id}`);
      }
      if (metricSamples.some((count) => !Number.isFinite(count) || count <= 0)) {
        throw new Error(`${label}/hot-${window.name}: empty metric series`);
      }
      results[window.name] = {
        sessionId: window.id,
        window: {
          selectionVersion: target.windowSelection.version,
          name: window.name,
          trainingSessionId: window.id,
          startedAt: window.startedAt,
          endedAt: window.endedAt,
          indexFromOldest: window.indexFromOldest,
          readableSessions: target.readableSessions
        },
        ...summarize(samples.map((sample) => sample.ms)),
        statuses,
        trainingSessionIds,
        metricSamplesMin: Math.min(...metricSamples),
        samples
      };
    } finally {
      const shutdown = await stopServer(server);
      rmSync(databasePath, { force: true });
      if (shutdown.exitCode !== 0) throw new Error(`API ${label}/hot-${window.name} shutdown exit=${shutdown.exitCode}`);
    }
  }
  return results;
}

const result = {
  generatedAt: new Date().toISOString(),
  label,
  root: rootReal,
  database: databaseReal,
  cycles,
  blocks,
  warmups,
  hotWarmups,
  target: target.session,
  readableSessions: target.readableSessions,
  windowSelection: target.windowSelection,
  states: {},
  hotWindows: null,
  verdict: { ok: true, failures: [] }
};
try {
  for (const state of hotOnly ? [] : states) {
    result.states[state] = await measureState(state);
    rmSync(join(runtimeDirectory, `${state}.sqlite`), { force: true });
    const stateResult = result.states[state];
    if (stateResult.firstSeries.samples !== cycles) result.verdict.failures.push(`${state}: firstSeries samples ${stateResult.firstSeries.samples} != ${cycles}`);
    if (stateResult.concurrentHealth.samples !== cycles) result.verdict.failures.push(`${state}: health samples ${stateResult.concurrentHealth.samples} != ${cycles}`);
    if (stateResult.statuses.some((status) => status !== 200)) result.verdict.failures.push(`${state}: non-200 status ${stateResult.statuses.join(",")}`);
    if (stateResult.serverErrors !== 0) result.verdict.failures.push(`${state}: serverErrors=${stateResult.serverErrors}`);
  }
  result.hotWindows = await measureHotWindows();
  for (const [name, window] of Object.entries(result.hotWindows)) {
    if (window.samples.length !== 200) result.verdict.failures.push(`${name}: hot samples ${window.samples.length} != 200`);
    if (window.statuses.some((status) => status !== 200)) result.verdict.failures.push(`${name}: hot non-200 status ${window.statuses.join(",")}`);
  }
  result.verdict.ok = result.verdict.failures.length === 0;
} catch (error) {
  result.verdict.ok = false;
  result.verdict.failures.push(String(error?.stack ?? error));
}
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  generatedAt: result.generatedAt, label, cycles, blocks,
  windowSelection: result.windowSelection,
  states: Object.fromEntries(Object.entries(result.states).map(([state, value]) => [state, {
    firstSeries: value.firstSeries, concurrentHealth: value.concurrentHealth, secondSeries: value.secondSeries,
    eventLoopP95Ms: value.eventLoopP95Ms, eventLoopMaxMs: value.eventLoopMaxMs, rssBytes: value.rssBytes
  }])),
  hotWindows: result.hotWindows === null ? null : Object.fromEntries(Object.entries(result.hotWindows).map(([name, value]) => [name, {
    sessionId: value.sessionId,
    window: value.window,
    p50: value.p50,
    p95: value.p95,
    samples: value.samples.length,
    statuses: value.statuses,
    metricSamplesMin: value.metricSamplesMin
  }])),
  verdict: result.verdict
}, null, 2));
if (!result.verdict.ok) process.exitCode = 1;
