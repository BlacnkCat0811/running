// 阶段 2 HTTP 端点基准：同一份 D2 数据、同一份 v47 账本，只切换
// `idx_ability_assessments_session` 是否存在；启动真实隔离 API 进程测量。
//
//   node --import tsx scripts/phase2-http-bench.mjs \
//     --root <experiment-root> --baseline <db> --candidate <db> [--json out.json]
//
// 隔离与证据口径（2026-10-21 审查整改）：
//   · `--root` 必填；拒绝仓库根、仓库 var/、符号链接根与符号链接数据库；
//   · baseline/candidate 必须位于实验根内、是普通文件、且 realpath 与 inode 都不同；
//   · 每个请求的毫秒数、状态码、响应体字节数和 SHA-256 都保存，分位数可独立复算；
//   · 额外测量“外部提交后首次 /series + 并发 /health + 事件循环延迟”。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  existsSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

function fail(message) {
  console.error(`phase2-http-bench: ${message}`);
  process.exit(2);
}

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

function pathContains(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const rootArg = readArg("--root");
if (rootArg === null) fail("--root is required (an explicit experiment root outside the repository)");
const root = resolve(rootArg);
if (!isAbsolute(root) || root === "/" || root.split(sep).filter(Boolean).length < 2) {
  fail(`refusing unsafe experiment root: ${root}`);
}
const repoReal = realpathSync(REPO_ROOT);
const repoVarReal = join(repoReal, "var");
const rootTarget = realTarget(root);
if (rootTarget === repoReal || rootTarget.startsWith(`${repoReal}${sep}`)
  || rootTarget === repoVarReal || rootTarget.startsWith(`${repoVarReal}${sep}`)) {
  fail(`experiment root must be outside the repository: ${rootTarget}`);
}
// A parent of the repository (for example /Users/ta) must be rejected too: it
// would make /Users/ta/running/var/rai.sqlite look like a root-contained path.
if (pathContains(rootTarget, repoReal)) {
  fail(`experiment root must not contain the repository: ${rootTarget} contains ${repoReal}`);
}
if (existsSync(root) && lstatSync(root).isSymbolicLink()) fail(`refusing symlinked experiment root: ${root}`);
mkdirSync(root, { recursive: true });
const rootReal = realpathSync(root);
if (rootReal !== rootTarget) fail(`experiment root changed while resolving: ${rootTarget} -> ${rootReal}`);

function insideRoot(path, label) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) fail(`${label} does not exist: ${resolved}`);
  if (lstatSync(resolved).isSymbolicLink()) fail(`${label} must not be a symlink: ${resolved}`);
  const real = realpathSync(resolved);
  // Independently reject any database target inside the repository, even when
  // the experiment root itself was an ancestor of the repository.
  if (pathContains(repoReal, real)) {
    fail(`${label} must not point inside the repository: ${resolved} -> ${real}`);
  }
  const realRel = relative(rootReal, real);
  if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
    fail(`${label} must be inside ${rootReal}: ${resolved} -> ${real}`);
  }
  if (!statSync(real).isFile()) fail(`${label} must be a regular file: ${real}`);
  return real;
}

const baselineArg = readArg("--baseline");
const candidateArg = readArg("--candidate");
if (baselineArg === null || candidateArg === null) fail("--baseline and --candidate are required");
const baselinePath = insideRoot(baselineArg, "baseline database");
const candidatePath = insideRoot(candidateArg, "candidate database");
if (baselinePath === candidatePath) fail("baseline and candidate resolve to the same file");
const baselineStat = statSync(baselinePath);
const candidateStat = statSync(candidatePath);
if (baselineStat.dev === candidateStat.dev && baselineStat.ino === candidateStat.ino) {
  fail(`baseline and candidate are the same inode: ${baselinePath}`);
}
const jsonOut = readArg("--json", null);
if (jsonOut !== null && !isAbsolute(jsonOut)) fail("--json must be an absolute path");

const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    probe.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no free port"))));
  });
});

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function summarize(samples) {
  if (samples.length === 0) return { samples: 0, p50: null, p95: null, min: null, max: null, mean: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  };
}

async function startServer(label, databasePath, port) {
  const runtimeRoot = join(rootReal, `http-${label}`);
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
      RAI_API_TOKEN: "phase2-http-token",
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
    if (child.exitCode !== null) throw new Error(`API ${label} exited ${child.exitCode}: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { host: `127.0.0.1:${port}`, authorization: "Bearer phase2-http-token" }
      });
      if (response.ok) return { child, output: () => output };
    } catch { /* not ready */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`API ${label} did not become ready: ${output}`);
}

async function stopServer(server) {
  server.child.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (server.child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
  return { exitCode: server.child.exitCode, signal: server.child.signalCode };
}

async function request(port, path) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      host: `127.0.0.1:${port}`,
      authorization: "Bearer phase2-http-token"
    }
  });
  const body = await response.text();
  const ms = performance.now() - started;
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${body.slice(0, 300)}`);
  return {
    ms,
    status: response.status,
    body,
    bodyBytes: Buffer.byteLength(body),
    bodySha256: createHash("sha256").update(body).digest("hex")
  };
}

function requestSample(response) {
  return {
    ms: response.ms,
    status: response.status,
    bodyBytes: response.bodyBytes,
    bodySha256: response.bodySha256
  };
}

function bodyVariants(samples) {
  const variants = new Map();
  for (const sample of samples) {
    const current = variants.get(sample.bodySha256) ?? { sha256: sample.bodySha256, bytes: sample.bodyBytes, count: 0 };
    current.count += 1;
    variants.set(sample.bodySha256, current);
  }
  return [...variants.values()].sort((left, right) => right.count - left.count);
}

async function measureEndpoint(port, endpoint) {
  for (let warm = 0; warm < 10; warm += 1) await request(port, endpoint.path);
  const samples = [];
  const startedAt = Date.now();
  const deadline = startedAt + endpoint.minDurationMs;
  while ((samples.length < endpoint.count || Date.now() < deadline) && samples.length < 10_000) {
    const requests = Array.from({ length: endpoint.concurrency }, () => request(port, endpoint.path));
    const responses = await Promise.all(requests);
    for (const response of responses) samples.push(requestSample(response));
  }
  return {
    ...summarize(samples.map((sample) => sample.ms)),
    durationMs: Date.now() - startedAt,
    bodyVariants: bodyVariants(samples),
    samples
  };
}

async function measurePostCommitSeries(port, databasePath) {
  const writer = new DatabaseSync(databasePath);
  writer.exec("PRAGMA busy_timeout = 5000");
  const write = writer.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES ('phase2_http_noop_receipt', ?)");
  const samples = [];
  try {
    for (let index = 0; index < 15; index += 1) {
      await request(port, "/v1/performance?reset=1");
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      writer.exec("BEGIN IMMEDIATE");
      write.run(new Date().toISOString());
      writer.exec("COMMIT");
      const [series, health] = await Promise.all([
        request(port, "/v1/workouts/s0/series"),
        request(port, "/v1/health")
      ]);
      // 留一个采样窗口给 monitorEventLoopDelay，否则同步查询结束后立刻读会得到 0。
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      const performanceResponse = await request(port, "/v1/performance");
      const performanceBody = JSON.parse(performanceResponse.body);
      if (index < 3) continue; // 三次预热；提交仍发生，缓存每次都被打穿。
      samples.push({
        seriesMs: series.ms,
        healthMs: health.ms,
        eventLoopP95Ms: Number(performanceBody.eventLoopP95Ms ?? 0),
        eventLoopMaxMs: Number(performanceBody.eventLoopMaxMs ?? 0),
        seriesBodyBytes: series.bodyBytes,
        seriesBodySha256: series.bodySha256,
        healthStatus: health.status
      });
    }
  } finally { writer.close(); }
  return {
    series: summarize(samples.map((sample) => sample.seriesMs)),
    concurrentHealth: summarize(samples.map((sample) => sample.healthMs)),
    eventLoopP95Ms: summarize(samples.map((sample) => sample.eventLoopP95Ms)),
    eventLoopMaxMs: summarize(samples.map((sample) => sample.eventLoopMaxMs)),
    samples
  };
}

async function measureVariant(label, databasePath) {
  const port = await freePort();
  const server = await startServer(label, databasePath, port);
  const result = { label, port };
  let shutdown = null;
  try {
    const endpoints = [
      { name: "GET /v1/workouts?limit=30", path: "/v1/workouts?limit=30", count: 200, concurrency: 1, minDurationMs: 60_000 },
      { name: "GET /v1/workouts?limit=30 (4 concurrent)", path: "/v1/workouts?limit=30", count: 200, concurrency: 4, minDurationMs: 60_000 },
      { name: "GET /v1/workouts/:id/series", path: "/v1/workouts/s0/series", count: 200, concurrency: 1, minDurationMs: 60_000 }
    ];
    result.endpoints = {};
    for (const endpoint of endpoints) {
      result.endpoints[endpoint.name] = await measureEndpoint(port, endpoint);
    }
    result.postCommitSeries = await measurePostCommitSeries(port, databasePath);
  } finally {
    shutdown = await stopServer(server);
    result.shutdown = shutdown;
    result.serverOutputTail = server.output().slice(-400);
  }
  return result;
}

try {
  const baseline = await measureVariant("baseline", baselinePath);
  const candidate = await measureVariant("candidate", candidatePath);
  const result = {
    generatedAt: new Date().toISOString(),
    root: rootReal,
    baseline: baselinePath,
    candidate: candidatePath,
    baselineResult: baseline,
    candidateResult: candidate,
    delta: Object.fromEntries(Object.keys(baseline.endpoints).map((name) => [
      name,
      {
        p50: ((candidate.endpoints[name].p50 - baseline.endpoints[name].p50) / baseline.endpoints[name].p50) * 100,
        p95: ((candidate.endpoints[name].p95 - baseline.endpoints[name].p95) / baseline.endpoints[name].p95) * 100
      }
    ])),
    verdict: {
      ok: [baseline, candidate].every((variant) => variant.shutdown?.exitCode === 0)
        && Object.values(baseline.endpoints).every((endpoint) => endpoint.samples.length > 0
          && endpoint.bodyVariants.length === 1 && endpoint.samples.every((sample) => sample.status === 200))
        && Object.values(candidate.endpoints).every((endpoint) => endpoint.samples.length > 0
          && endpoint.bodyVariants.length === 1 && endpoint.samples.every((sample) => sample.status === 200))
    }
  };
  if (jsonOut !== null) writeFileSync(jsonOut, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.verdict.ok) process.exitCode = 1;
} catch (error) {
  console.error(`phase2-http-bench: ${error?.stack ?? error}`);
  process.exitCode = 1;
}
