// 阶段 6 隔离 runner：纯预检、独占新根、生命周期、执行清单与停止条件。
//
// F1 口径（审查修复方案 §6）：
//   · 默认只做 dry-run；`--execute` 也必须先完成全部纯预检，预检失败时实验根不存在。
//   · 实验根必须是尚不存在的新绝对路径；任何已有根（含同 run-id）在清理前拒绝。
//   · 子进程环境白名单，TMPDIR/TMP/TEMP/HOME 全部落在根内；派生路径逐一断言。
//   · 删除前复核所有权标记、run-id、realpath；只删除本次根内 runner 拥有的路径。
//   · SIGINT/异常/子进程超时写 `incomplete` manifest，保留 raw，只终止本次进程树。

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";

import {
  REPO_ROOT,
  SafetyError,
  assertDistinctDatabaseFiles,
  assertExternalFixture,
  assertFixtureManifest,
  assertOwnedDeletionPath,
  assertPayloadManifest,
  assertSafeExperimentRoot,
  buildChildEnvironment,
  buildServerEnvironment,
  createOwnedExperimentRoot,
  derivedRuntimePaths,
  generateRunToken,
  phase6ToolHashes,
  runtimeSourceHashes,
  scanForSecrets,
  sha256File
} from "./safety.mjs";
import { normalizeCgroupDirectory } from "./cgroup.mjs";
import { createStopRuleTracker } from "./stop-rules.mjs";

const VALUE_OPTIONS = new Set([
  "--root", "--profile", "--protocol", "--dataset", "--fixture", "--fixture-manifest",
  "--payload-manifest", "--scenario", "--run-id", "--rate", "--duration-ms", "--warmup-ms",
  "--max-in-flight", "--driver-timeout-ms", "--concurrency", "--cgroup"
]);
const FLAG_OPTIONS = new Set(["--execute", "--dry-run", "--recompute", "--keep-api"]);

function parseArguments(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (FLAG_OPTIONS.has(current)) { flags.add(current); continue; }
    if (!VALUE_OPTIONS.has(current)) throw new SafetyError("argument_unknown", `unknown argument: ${current}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new SafetyError("argument_value_missing", `argument ${current} requires a value`);
    }
    values[current] = value;
    index += 1;
  }
  if (flags.has("--execute") && flags.has("--dry-run")) {
    throw new SafetyError("argument_conflict", "--execute and --dry-run are mutually exclusive");
  }
  return { values, flags };
}

// 纯预检阶段的异常必须是可读的退出码 2，而不是 Node 的未捕获堆栈。
process.on("uncaughtException", (error) => {
  const code = error && typeof error === "object" && "code" in error ? ` [${String(error.code)}]` : "";
  process.stderr.write(`phase6-runner:${code} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});

const { values, flags } = parseArguments(process.argv.slice(2));
const execute = flags.has("--execute");
const readValue = (name, fallback = null) => values[name] ?? fallback;
const rootArg = readValue("--root");
const profile = readValue("--profile", "dev");
const protocolPath = readValue("--protocol");
const dataset = readValue("--dataset", "D1");
const fixturePath = readValue("--fixture");
const fixtureManifestPath = readValue("--fixture-manifest");
const payloadManifestPath = readValue("--payload-manifest");
const scenarioList = (readValue("--scenario", "S01") ?? "S01").split(",").map((item) => item.trim()).filter(Boolean);
const runId = readValue("--run-id", `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const rate = Number(readValue("--rate", "5"));
const durationMs = Number(readValue("--duration-ms", "30000"));
const warmupMs = Number(readValue("--warmup-ms", "0"));
const maxInFlight = Number(readValue("--max-in-flight", "64"));
const recomputeEnabled = flags.has("--recompute");
const keepApi = flags.has("--keep-api");
const driverTimeoutMs = Number(readValue("--driver-timeout-ms", String(durationMs + 180_000)));
const cgroupPath = readValue("--cgroup", process.env.RAI_PHASE6_CGROUP_PATH ?? null);
let cgroupRelative = null;
let cgroupDirectory = null;

function failPreflight(code, message) {
  const error = new SafetyError(code, message);
  error.phase = "preflight";
  throw error;
}

if (!rootArg) failPreflight("root_required", "--root is required");
if (!protocolPath) failPreflight("protocol_required", "--protocol is required (profile/scenario validation needs the frozen protocol)");

const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
if (protocol.protocolVersion !== 1) failPreflight("protocol_version", "unsupported protocol version");
if (protocol.profiles === null || typeof protocol.profiles !== "object") failPreflight("protocol_profiles", "protocol has no profiles");
if (protocol.scenarios === null || typeof protocol.scenarios !== "object") failPreflight("protocol_scenarios", "protocol has no scenarios");
if (protocol.datasets === null || typeof protocol.datasets !== "object") failPreflight("protocol_datasets", "protocol has no datasets");
const profileDefinition = protocol.profiles[profile];
if (profileDefinition === undefined) failPreflight("profile_unknown", `profile is not defined in the frozen protocol: ${profile}`);
if (protocol.datasets[dataset] === undefined) failPreflight("dataset_unknown", `dataset is not defined in the frozen protocol: ${dataset}`);
for (const scenario of scenarioList) {
  if (!/^S\d{2}$/.test(scenario)) failPreflight("scenario_invalid", `invalid scenario id: ${scenario}`);
  if (protocol.scenarios[scenario] === undefined) failPreflight("scenario_unknown", `scenario is not defined in the frozen protocol: ${scenario}`);
}
if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000) failPreflight("rate_invalid", `--rate must be in (0, 1000]: ${String(rate)}`);
if (!Number.isFinite(durationMs) || durationMs <= 0) failPreflight("duration_invalid", `--duration-ms must be > 0: ${String(durationMs)}`);
if (!Number.isFinite(warmupMs) || warmupMs < 0 || warmupMs > durationMs) {
  failPreflight("warmup_invalid", `--warmup-ms must be in [0, duration]: ${String(warmupMs)}`);
}
if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 4_096) {
  failPreflight("max_in_flight_invalid", `--max-in-flight must be an integer in [1, 4096]: ${String(maxInFlight)}`);
}
const protocolMaxInFlight = Number(protocol.stopRules?.maxInFlight ?? 0);
if (protocolMaxInFlight > 0 && maxInFlight > protocolMaxInFlight) {
  failPreflight("max_in_flight_exceeds_stop_rule",
    `--max-in-flight ${maxInFlight} exceeds the frozen stop rule limit ${protocolMaxInFlight}`);
}
const hardTimeoutMs = Number(protocol.stopRules?.hardTimeoutPerRoundSeconds ?? 0) * 1_000;
if (hardTimeoutMs > 0 && durationMs + warmupMs > hardTimeoutMs) {
  failPreflight("duration_exceeds_hard_timeout", `warmup+duration exceeds the frozen per-round hard timeout (${hardTimeoutMs} ms)`);
}
if (!Number.isFinite(driverTimeoutMs) || driverTimeoutMs <= durationMs + warmupMs) {
  failPreflight("driver_timeout_invalid", "--driver-timeout-ms must exceed warmup+duration");
}
if (profile.startsWith("cloud")) {
  if (platform() !== "linux") failPreflight("cloud_profile_requires_linux", `profile ${profile} requires an isolated Linux target`);
  if (cgroupPath === null) failPreflight("cloud_cgroup_required", `profile ${profile} requires an explicit pre-created cgroup path (--cgroup or RAI_PHASE6_CGROUP_PATH)`);
  try {
    const cgroup = normalizeCgroupDirectory(cgroupPath);
    cgroupRelative = cgroup.relative;
    cgroupDirectory = cgroup.directory;
  }
  catch (error) { failPreflight("cloud_cgroup_invalid", error instanceof Error ? error.message : String(error)); }
}

// 纯预检：根尚不存在、仓库外、生产 runtime 根及其子目录外。
const rootCheck = assertSafeExperimentRoot(rootArg, { mustNotExist: true });
const { root, realRoot } = rootCheck;
const paths = derivedRuntimePaths(realRoot);

let fixture = null;
let fixtureManifest = null;
let payloadManifest = null;
if (fixtureManifestPath !== null) {
  if (!existsSync(fixtureManifestPath)) failPreflight("fixture_manifest_missing", `fixture manifest missing: ${fixtureManifestPath}`);
  let declared;
  try { declared = JSON.parse(readFileSync(fixtureManifestPath, "utf8")); } catch (error) {
    failPreflight("fixture_manifest_invalid", `fixture manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (declared.dataset !== dataset) failPreflight("fixture_dataset_mismatch", `fixture manifest dataset ${String(declared.dataset)} != ${dataset}`);
  if (fixturePath !== null) {
    fixture = assertExternalFixture(fixturePath, {
      expectedBytes: declared.bytes?.database ?? null,
      expectedSha256: declared.bytes?.databaseSha256 ?? declared.databaseSha256 ?? null
    });
    fixtureManifest = assertFixtureManifest(fixtureManifestPath, {
      dataset, fixturePath: fixture.path, fixtureSha256: fixture.sha256, fixtureBytes: fixture.bytes
    });
  }
} else if (execute) {
  failPreflight("fixture_manifest_required", "--fixture-manifest is required with --execute");
}
if (execute && fixturePath === null) failPreflight("fixture_required", "--fixture <absolute pristine sqlite> is required with --execute");
if (fixturePath !== null && fixture === null) {
  fixture = assertExternalFixture(fixturePath);
  if (fixtureManifestPath !== null) {
    fixtureManifest = assertFixtureManifest(fixtureManifestPath, {
      dataset, fixturePath: fixture.path, fixtureSha256: fixture.sha256, fixtureBytes: fixture.bytes
    });
  }
}
if (payloadManifestPath !== null) {
  const importScenarios = scenarioList.filter((scenario) => ["S05", "S06", "S07", "S08", "S09"].includes(scenario));
  payloadManifest = assertPayloadManifest(payloadManifestPath, { requireContracts: importScenarios.length > 0 });
  if (payloadManifest.entries.length === 0) failPreflight("payload_manifest_empty", "payload manifest declares no payloads");
} else if (execute && scenarioList.some((scenario) => ["S05", "S06", "S07", "S08", "S09"].includes(scenario))) {
  failPreflight("payload_manifest_required", "import scenarios require --payload-manifest");
}

const dryRun = {
  mode: "dry-run",
  runId,
  profile,
  dataset,
  scenarios: scenarioList,
  root,
  realRoot,
  rootExists: false,
  paths,
  fixture: fixture === null ? null : { path: fixture.path, bytes: fixture.bytes, sha256: fixture.sha256 },
  fixtureManifest: fixtureManifest === null ? null : {
    path: fixtureManifest.path, sha256: fixtureManifest.sha256,
    digest: fixtureManifest.digest, declaredSha256: fixtureManifest.declaredSha256
  },
  payloadManifest: payloadManifest === null ? null : {
    path: payloadManifest.path, sha256: payloadManifest.sha256, entries: payloadManifest.entries.length
  },
  api: {
    host: "127.0.0.1",
    port: "ephemeral (RAI_API_PORT=0, port read from child IPC)",
    command: `${process.execPath} --import tsx ${cgroupRelative === null ? "apps/api/src/server.ts" : "scripts/phase6/server-entry.mjs"}`,
    cwd: REPO_ROOT,
    envKeys: [
      "RAI_RUNTIME_ROOT", "RAI_DATABASE", "RAI_CONTROL_DATABASE", "RAI_API_PORT", "RAI_API_HOST",
      "RAI_API_TOKEN", "RAI_SERVER_ID", "RAI_ATHLETE_ID", "RAI_DATASET_EPOCH", "RAI_LOG_LEVEL",
      ...(profile === "cloud-validation" ? ["RAI_TRAINING_PLAN_COMMAND_MODE"] : []),
      "TMPDIR", "TMP", "TEMP", "HOME", "XDG_CACHE_HOME", "npm_config_cache", "NO_PROXY", "no_proxy"
    ],
    trainingPlanCommandMode: profile === "cloud-validation" ? "validation" : null,
    token: "<generated; never printed>"
  },
  resourceLimits: profile.startsWith("cloud") ? {
    note: `CLOUD 要求隔离 cgroup：${cgroupPath}`,
    cgroup: true
  } : {
    note: "DEV 无 cgroup/systemd 限额；CLOUD 资源读回由 Linux 隔离目标提供",
    cgroup: false
  },
  cleanup: [root],
  preflight: {
    ok: true,
    checks: [
      "arguments strict", "profile/dataset/scenarios frozen", "numeric ranges",
      "root is a new path outside repo and production runtime", "fixture closed snapshot",
      "fixture manifest identity", "payload paths/sha/contracts", "no side effects"
    ]
  },
  protocol: {
    path: resolve(protocolPath),
    sha256: sha256File(protocolPath),
    profile,
    profilePurpose: profileDefinition.purpose ?? null
  }
};

if (!execute) {
  process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 执行（此后才允许创建根/打开数据库/发送请求）
// ---------------------------------------------------------------------------

const created = createOwnedExperimentRoot(rootArg, { runId });
const pristineFixture = fixture.path;
for (const directory of [paths.var ?? join(realRoot, "var"), paths.imports, paths.backups, paths.modelArtifacts,
  paths.temp, paths.home, paths.cache, paths.npmCache, paths.results, paths.logs, join(realRoot, "raw")]) {
  mkdirSync(directory, { recursive: true });
}
assertDistinctDatabaseFiles(realRoot, paths.database, paths.controlDatabase);

const token = generateRunToken();
const startedAt = new Date().toISOString();
const commands = [];
const scenarioResults = [];
const activeChildren = new Set();
let interruptedSignal = null;

function registerChild(child) {
  activeChildren.add(child);
  child.once("exit", () => activeChildren.delete(child));
  return child;
}

async function terminateChildren() {
  for (const child of [...activeChildren]) {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
  const deadline = Date.now() + 5_000;
  while (activeChildren.size > 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  for (const child of [...activeChildren]) {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (interruptedSignal !== null) return;
    interruptedSignal = signal;
    process.stderr.write(`phase6-runner: received ${signal}; stopping this run and keeping evidence\n`);
    void terminateChildren();
  });
}

function gitOutput(commandArgs) {
  const result = spawnSync("git", commandArgs, { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const codeIdentity = {
  commit: gitOutput(["rev-parse", "HEAD"]),
  status: gitOutput(["status", "--porcelain"]),
  protocolSha256: sha256File(protocolPath),
  packageLockSha256: sha256File(join(REPO_ROOT, "package-lock.json")),
  packageJsonSha256: sha256File(join(REPO_ROOT, "package.json")),
  toolFiles: phase6ToolHashes(),
  sourceFiles: runtimeSourceHashes(),
  node: process.version,
  platform: `${platform()} ${release()} ${arch()}`
};

const environment = {
  profile,
  platform: platform(),
  release: release(),
  arch: arch(),
  cpuModel: cpus()[0]?.model ?? "unknown",
  cpuCount: cpus().length,
  totalMemoryBytes: totalmem(),
  node: process.version,
  execPath: process.execPath,
  cgroup: profile.startsWith("cloud") ? { requestedPath: cgroupPath } : null,
  cgroupNote: platform() === "linux"
    ? "见 raw/resources-*.jsonl 的目标 PID cgroup 归属与限额读回"
    : "DEV: cgroup/systemd 不可用，未冒充 CLOUD 资源读回",
  collectedAt: new Date().toISOString()
};
writeJson(join(realRoot, "environment.json"), environment);

const childLogs = [];
function logChunk(path, chunk) {
  appendFileSync(path, chunk);
}

function startApi(scenario) {
  const logPath = join(realRoot, "logs", `api-${scenario}.log`);
  writeFileSync(logPath, "");
  const env = buildServerEnvironment({
    runtimeRoot: realRoot,
    database: paths.database,
    controlDatabase: paths.controlDatabase,
    port: 0,
    token,
    serverId: "phase6",
    athleteId: "athlete_1",
    datasetEpoch: "phase6",
    logLevel: "warn",
    // 协议声明的候选写能力只在隔离 validation profile 打开；default/dev 不透传
    // 任何生产开关，API 继续只读。
    extras: profile === "cloud-validation" ? { RAI_TRAINING_PLAN_COMMAND_MODE: "validation" } : {}
  });
  const entry = cgroupRelative === null ? "apps/api/src/server.ts" : "scripts/phase6/server-entry.mjs";
  const child = registerChild(spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: REPO_ROOT,
    env: env.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true
  }));
  childLogs.push(logPath);
  child.stdout.on("data", (chunk) => logChunk(logPath, chunk));
  child.stderr.on("data", (chunk) => logChunk(logPath, chunk));
  if (cgroupRelative !== null) {
    if (!Number.isInteger(child.pid)) throw new Error("CLOUD API process has no PID for cgroup placement");
    // The entry process has not imported the API yet; move it before any server work.
    writeFileSync(join(cgroupDirectory, "cgroup.procs"), `${child.pid}\n`);
    child.send("phase6:start");
  }
  commands.push({
    scenario, command: `node --import tsx ${entry}`,
    cwd: REPO_ROOT, envKeys: env.injectedKeys, envInheritedKeys: env.inheritedKeys,
    port: "0 (ephemeral)", log: logPath,
    isolatedTemp: env.isolated.temp, isolatedHome: env.isolated.home
  });
  return { child, logPath, env };
}

function waitForReady(child, logPath, budgetMs = 120_000) {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`API did not report ready within ${budgetMs} ms; see ${logPath}`));
    }, budgetMs);
    const onMessage = (message) => {
      if (message?.type === "rai:ready" && Number.isInteger(message.port)) {
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("message", onMessage);
        resolveReady(message.port);
      }
    };
    const onExit = (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`API exited before ready (code ${code}); see ${logPath}`));
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function stopChild(child, { graceMs = 15_000 } = {}) {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null) { resolveStop(); return; }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      resolveStop();
    }, graceMs);
    child.once("exit", () => { clearTimeout(timer); resolveStop(); });
    try { child.send("rai:shutdown"); } catch { try { child.kill("SIGTERM"); } catch { /* 已退出 */ } }
  });
}

function startCollector(apiPid, scenario) {
  const outPath = join(realRoot, "raw", `resources-${scenario}.jsonl`);
  const env = buildChildEnvironment({ runtimeRoot: realRoot });
  const expectedLimits = profileDefinition.resourceReadBack
    ? JSON.stringify(profileDefinition.resourceReadBack) : null;
  const collectorArgs = [
    "scripts/phase6/collect-resources.mjs", "--pid", String(apiPid),
    "--out", outPath, "--interval-ms", "1000",
    "--runtime-root", realRoot,
    ...(cgroupRelative === null ? [] : ["--cgroup", cgroupRelative, "--require-cgroup"]),
    ...(expectedLimits === null ? [] : ["--expected-limits", expectedLimits])
  ];
  const child = registerChild(spawn(process.execPath, collectorArgs, {
    cwd: REPO_ROOT, env: env.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true
  }));
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  commands.push({ scenario, command: "node scripts/phase6/collect-resources.mjs", args: collectorArgs, log: null,
    isolatedTemp: env.isolated.temp, isolatedHome: env.isolated.home });
  return { child, outPath };
}

/**
 * 运行中停止条件监视器。
 *
 * driver 启动后，runner 不能只等它自然结束：协议里的内存/健康/磁盘停止条件
 * 必须在运行中执行。资源条件消费 collector 的 JSONL；health 由 runner 独立
 * 以 eachMs 超时探测（与 S13 的 1 Hz health 分开，避免把 driver 卡死误判为
 * “没有失败样本”）。一旦触发就终止 driver，保留 raw，并让本轮 manifest 变成
 * incomplete。
 */
function startStopMonitor({ baseUrl, apiChild, collector }) {
  const stopRules = protocol.stopRules ?? {};
  const configuredMemoryMax = Number(profileDefinition.resourceReadBack?.memoryMaxBytes ?? 0);
  // DEV 没有 cgroup 上限；用宿主总内存作为安全边界，避免把 RSS 采样误当
  // CLOUD memory.current。CLOUD profile 使用冻结的 memory.max。
  const memoryMaxBytes = configuredMemoryMax > 0 ? configuredMemoryMax : totalmem();
  const healthEachMs = Math.max(250, Number(stopRules.healthTimeout?.eachMs ?? 5_000));
  const tracker = createStopRuleTracker({
    rules: stopRules,
    memoryMaxBytes,
    expectedCgroup: cgroupRelative
  });
  let stopped = false;
  let violation = null;
  let driverChild = null;
  let processedResourceLines = 0;
  let probing = false;
  const stopController = new AbortController();
  const timers = [];

  const killDriver = () => {
    if (driverChild === null) return;
    try { driverChild.kill("SIGTERM"); } catch { /* 已退出 */ }
    const killTimer = setTimeout(() => {
      try { driverChild.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, 5_000);
    killTimer.unref?.();
  };

  const trigger = (candidate) => {
    if (stopped || violation !== null) return;
    violation = candidate;
    killDriver();
  };

  const onApiExit = (code, signal) => {
    if (stopped) return;
    trigger({
      rule: "unexpectedOomOrWatchdogRestart",
      detail: `API process exited while the scenario was running (code ${String(code)}, signal ${String(signal)})`,
      at: new Date().toISOString()
    });
  };
  apiChild.once("exit", onApiExit);
  const onCollectorExit = (code, signal) => {
    if (stopped) return;
    trigger({
      rule: "resourceCollectorExited",
      detail: `resource collector exited while the scenario was running (code ${String(code)}, signal ${String(signal)})`,
      at: new Date().toISOString()
    });
  };
  collector.child.once("exit", onCollectorExit);

  const readNewResourceSamples = () => {
    if (stopped || violation !== null) return;
    let text;
    try { text = readFileSync(collector.outPath, "utf8"); } catch { return; }
    if (text === "") return;
    const endsWithNewline = text.endsWith("\n");
    const lines = text.split("\n");
    if (endsWithNewline) lines.pop();
    const completeCount = endsWithNewline ? lines.length : Math.max(0, lines.length - 1);
    if (completeCount < processedResourceLines) processedResourceLines = 0;
    for (let index = processedResourceLines; index < completeCount; index += 1) {
      let sample;
      try { sample = JSON.parse(lines[index]); } catch { continue; }
      if (sample?.kind !== "sample") continue;
      const found = tracker.observeResource(sample);
      if (found !== null) { trigger(found); return; }
    }
    processedResourceLines = completeCount;
  };

  const probeHealth = async () => {
    if (stopped || probing || violation !== null) return;
    probing = true;
    let status = null;
    let timeout = false;
    let error = null;
    try {
      const response = await fetch(`${baseUrl}/v1/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.any([stopController.signal, AbortSignal.timeout(healthEachMs)])
      });
      status = response.status;
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (stopped) return;
      const found = tracker.observeHealth({
        ok: response.ok && body?.status === "ok" && body?.databaseReady === true,
        status
      });
      if (found !== null) trigger(found);
    } catch (caught) {
      if (stopped) return;
      timeout = caught?.name === "TimeoutError" || caught?.name === "AbortError";
      error = caught instanceof Error ? caught.name : String(caught);
      const found = tracker.observeHealth({ ok: false, timeout, status, error });
      if (found !== null) trigger(found);
    } finally {
      probing = false;
    }
  };

  timers.push(setInterval(readNewResourceSamples, 250));
  timers.push(setInterval(() => { void probeHealth(); }, 1_000));
  void probeHealth();

  return {
    attachDriver(child) {
      driverChild = child;
      if (violation !== null) killDriver();
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      apiChild.off("exit", onApiExit);
      collector.child.off("exit", onCollectorExit);
      stopController.abort();
    },
    get violation() { return violation; }
  };
}

function runDriver({ scenario, baseUrl, manifestPath, onStart = null }) {
  const outDir = join(realRoot, "results", scenario);
  mkdirSync(outDir, { recursive: true });
  const logPath = join(realRoot, "logs", `driver-${scenario}.log`);
  writeFileSync(logPath, "");
  const driverArgs = [
    "scripts/phase6/driver.mjs",
    "--base-url", baseUrl,
    "--scenario", scenario,
    "--dataset", dataset,
    "--profile", profile,
    "--run-id", runId,
    "--out", outDir,
    "--rate", String(rate),
    "--duration-ms", String(durationMs),
    "--warmup-ms", String(warmupMs),
    "--max-in-flight", String(maxInFlight),
    "--timeout-ms", String(Math.max(30_000, durationMs + 60_000))
  ];
  // 客户端能力头由 runner 按冻结 profile 决定：只有 cloud-validation 协商 v2。
  if (profile === "cloud-validation") driverArgs.push("--client-training-commands", "2");
  if (manifestPath) driverArgs.push("--manifest", manifestPath);
  const env = buildChildEnvironment({ runtimeRoot: realRoot, token });
  const child = registerChild(spawn(process.execPath, driverArgs, {
    cwd: REPO_ROOT,
    env: env.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }));
  childLogs.push(logPath);
  appendFileSync(logPath, `driver args: ${driverArgs.filter((item) => item !== token).join(" ")}\n`);
  child.stdout.on("data", (chunk) => logChunk(logPath, chunk));
  child.stderr.on("data", (chunk) => logChunk(logPath, chunk));
  commands.push({ scenario, command: "node scripts/phase6/driver.mjs", args: driverArgs.filter((item) => item !== token), log: logPath,
    isolatedTemp: env.isolated.temp, isolatedHome: env.isolated.home });
  onStart?.(child);
  return new Promise((resolveDriver) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, driverTimeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveDriver({ code, signal, timedOut, logPath, outDir });
    });
  });
}

async function readScenarioSummary(outDir) {
  const summaryPath = join(outDir, "driver-summary.json");
  if (!existsSync(summaryPath)) return null;
  try { return JSON.parse(readFileSync(summaryPath, "utf8")); } catch { return null; }
}

function databaseStats() {
  const stats = { bytes: null, walBytes: null, shmBytes: null };
  for (const [key, path] of [["bytes", paths.database], ["walBytes", `${paths.database}-wal`], ["shmBytes", `${paths.database}-shm`]]) {
    if (existsSync(path)) stats[key] = statSync(path).size;
  }
  return stats;
}

/** 每个 scenario 从同一 pristine 起跑：只替换本次 run root 内的主/控库，不触碰夹具。 */
function resetDatabases() {
  // 删除前复核所有权标记、run-id、realpath；目标必须是本次根内的普通路径。
  for (const path of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`,
    paths.controlDatabase, `${paths.controlDatabase}-wal`, `${paths.controlDatabase}-shm`,
    paths.runtimeState, `${paths.runtimeState}-wal`, `${paths.runtimeState}-shm`,
    paths.imports, paths.backups, paths.modelArtifacts]) {
    const checked = assertOwnedDeletionPath(realRoot, path, { runId });
    if (existsSync(checked.real)) rmSync(checked.real, { recursive: true, force: true });
  }
  mkdirSync(paths.imports, { recursive: true });
  mkdirSync(paths.backups, { recursive: true });
  mkdirSync(paths.modelArtifacts, { recursive: true });
  assertExternalFixture(pristineFixture);
  copyFileSync(pristineFixture, paths.database);
}

async function runScenario(scenario, { reset = true } = {}) {
  if (interruptedSignal !== null) throw new Error(`runner interrupted by ${interruptedSignal}`);
  if (reset) resetDatabases();
  const fixtureStats = statSync(pristineFixture);
  const api = startApi(scenario);
  let port;
  try {
    port = await waitForReady(api.child, api.logPath);
  } catch (error) {
    await stopChild(api.child);
    throw error;
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const collector = startCollector(api.child.pid, scenario);
  // CLOUD/要求 cgroup 的采样器若目标组不可读会立刻退出；不能带着无资源证据继续跑。
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  if (collector.child.exitCode !== null && collector.child.exitCode !== 0) {
    await stopChild(api.child);
    throw new Error(`resource collector exited ${collector.child.exitCode} before the scenario started`);
  }
  const importScenario = ["S05", "S06", "S07", "S08", "S09"].includes(scenario);
  const manifestPath = importScenario && payloadManifestPath ? payloadManifestPath : fixtureManifestPath;
  const stopMonitor = startStopMonitor({ baseUrl, apiChild: api.child, collector });
  let driver;
  try {
    driver = await runDriver({ scenario, baseUrl, manifestPath, onStart: (child) => stopMonitor.attachDriver(child) });
  } finally {
    stopMonitor.stop();
  }
  const stopViolation = stopMonitor.violation;
  await stopChild(api.child);
  if (collector.child.exitCode === null) {
    const collectorExited = new Promise((resolveWait) => collector.child.once("exit", resolveWait));
    collector.child.kill("SIGTERM");
    await Promise.race([collectorExited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
  }
  const summary = await readScenarioSummary(driver.outDir);
  const record = {
    scenario,
    exitCode: driver.code,
    signal: driver.signal,
    timedOut: driver.timedOut,
    stopRule: stopViolation,
    incomplete: driver.timedOut || driver.code !== 0 || interruptedSignal !== null || stopViolation !== null,
    driverLog: driver.logPath,
    apiLog: api.logPath,
    fixtureBytes: fixtureStats.size,
    database: databaseStats(),
    summary,
    requests: summary?.requests ?? null,
    oracleFailures: summary?.oracleFailures?.length ?? null,
    fatal: summary?.fatal ?? null
  };
  scenarioResults.push(record);
  writeJson(join(realRoot, "results", scenario, "scenario.json"), record);
  return record;
}

const runErrors = [];
let stopTriggered = null;
try {
  if (!existsSync(paths.database)) resetDatabases();
  const mainScenarios = scenarioList.filter((scenario) => scenario !== "S10");
  for (const scenario of mainScenarios) {
    if (interruptedSignal !== null) break;
    const record = await runScenario(scenario);
    if (record.exitCode !== 0) runErrors.push(`${scenario}: driver exit ${record.exitCode}${record.fatal ? ` (${record.fatal})` : ""}`);
    if (record.timedOut) runErrors.push(`${scenario}: driver timed out after ${driverTimeoutMs} ms`);
    if (record.stopRule) {
      stopTriggered = { scenario, ...record.stopRule };
      runErrors.push(`${scenario}: stop rule ${record.stopRule.rule} (${record.stopRule.detail})`);
      break;
    }
  }
  if (scenarioList.includes("S10") && !recomputeEnabled && stopTriggered === null) {
    throw new Error("scenario S10 requires --recompute (it verifies a completed full recompute)");
  }
  if (recomputeEnabled && interruptedSignal === null && stopTriggered === null) {
    const recomputeLog = join(realRoot, "logs", "recompute.log");
    const env = buildChildEnvironment({ runtimeRoot: realRoot });
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "packages/application/src/cli.ts", "recompute", "--database", paths.database
    ], { cwd: REPO_ROOT, encoding: "utf8", env: env.env, timeout: driverTimeoutMs, killSignal: "SIGKILL" });
    writeFileSync(recomputeLog, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    commands.push({ scenario: "S10", command: "node --import tsx packages/application/src/cli.ts recompute",
      exitCode: result.status, timedOut: result.error?.code === "ETIMEDOUT", log: recomputeLog,
      isolatedTemp: env.isolated.temp, isolatedHome: env.isolated.home });
    let parsed = null;
    try { parsed = JSON.parse((result.stdout ?? "").trim()); } catch {
      try { parsed = JSON.parse((result.stdout ?? "").trim().split("\n").at(-1) ?? ""); } catch { parsed = null; }
    }
    writeJson(join(realRoot, "results", "recompute.json"), { exitCode: result.status, output: parsed, log: recomputeLog,
      timedOut: result.error?.code === "ETIMEDOUT" });
    if (result.status !== 0) runErrors.push(`recompute: exit ${result.status}${result.error?.code === "ETIMEDOUT" ? " (timeout)" : ""}`);
    if (scenarioList.includes("S10")) {
      const record = await runScenario("S10", { reset: false });
      if (record.exitCode !== 0) runErrors.push(`S10: driver exit ${record.exitCode}${record.fatal ? ` (${record.fatal})` : ""}`);
    }
  }
} catch (error) {
  runErrors.push(error instanceof Error ? error.message : String(error));
} finally {
  await terminateChildren();
  if (!keepApi) {
    // 所有 scenario 都已 stop；terminateChildren 兜底确认没有本次 runner 的子进程仍存活。
  }
}

const finishedAt = new Date().toISOString();
// Token 不得进入任何日志或交付物。扫描必须在写 manifest/summary 之前完成：
// 否则离线裁决会读到 status=complete，而泄漏只存在于进程内存的 runErrors 中。
const secretFindings = [];
let secretScanError = null;
try {
  const scanned = new Set();
  const scanFile = (path) => {
    if (scanned.has(path) || !existsSync(path) || !statSync(path).isFile()) return;
    scanned.add(path);
    const text = readFileSync(path, "utf8");
    secretFindings.push(...scanForSecrets(text, { token }).map((finding) => ({ file: path, ...finding })));
  };
  const scanDirectory = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) scanFile(join(directory, entry));
  };
  for (const logPath of childLogs) scanFile(logPath);
  scanDirectory(join(realRoot, "raw"));
  const resultsDirectory = join(realRoot, "results");
  if (existsSync(resultsDirectory)) {
    for (const entry of readdirSync(resultsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      scanDirectory(join(resultsDirectory, entry.name, "raw"));
      scanDirectory(join(resultsDirectory, entry.name, "correctness"));
    }
  }
} catch (error) {
  secretScanError = error instanceof Error ? error.message : String(error);
  secretFindings.push({ kind: "scan_error", file: null, message: secretScanError });
}
writeJson(join(realRoot, "secret-findings.json"), secretFindings);
if (secretScanError !== null) {
  runErrors.push(`secret scan failed: ${secretScanError}`);
} else if (secretFindings.length > 0) {
  runErrors.push("secret scan failed: token or authorization header found in logs/raw evidence");
}
const tokenScan = secretScanError !== null ? "error" : secretFindings.length === 0 ? "clean" : "findings";

const incomplete = interruptedSignal !== null || runErrors.length > 0
  || scenarioResults.some((record) => record.incomplete === true);
const manifest = {
  schemaVersion: 1,
  runId,
  mode: "execute",
  status: incomplete ? "incomplete" : "complete",
  incompleteReason: interruptedSignal !== null ? `signal ${interruptedSignal}`
    : runErrors.length > 0 ? runErrors.join("; ") : null,
  profile,
  dataset,
  scenarios: scenarioList,
  startedAt,
  finishedAt,
  root,
  realRoot,
  protocol: {
    path: resolve(protocolPath), sha256: sha256File(protocolPath),
    protocolId: protocol.protocolId ?? null, protocolVersion: protocol.protocolVersion,
    profile
  },
  code: codeIdentity,
  fixture: { path: pristineFixture, sha256: sha256File(pristineFixture), bytes: statSync(pristineFixture).size,
    declaredSha256: fixtureManifest?.declaredSha256 ?? null },
  fixtureManifest: fixtureManifest === null ? null : {
    path: fixtureManifest.path, sha256: fixtureManifest.sha256, digest: fixtureManifest.digest,
    declaredSha256: fixtureManifest.declaredSha256
  },
  payloadManifest: payloadManifest === null ? null : {
    path: payloadManifest.path, sha256: payloadManifest.sha256, entries: payloadManifest.entries.length
  },
  safety: {
    rootOutsideRepo: true,
    mainAndControlDistinct: true,
    loopbackOnly: true,
    envWhitelist: true,
    isolatedTemp: paths.temp,
    isolatedHome: paths.home,
    tokenScan,
    secretFindings: secretFindings.length
  },
  commands,
  scenariosResults: scenarioResults,
  errors: runErrors,
  stopViolations: stopTriggered === null ? [] : [stopTriggered],
  environment: "environment.json",
  cleanup: [root]
};
writeJson(join(realRoot, "manifest.json"), manifest);
writeJson(join(realRoot, "summary.json"), {
  runId, profile, dataset, status: manifest.status, finishedAt, tokenScan,
  scenarios: scenarioResults.map(({ scenario, exitCode, requests, oracleFailures, fatal, incomplete: scenarioIncomplete, stopRule }) => ({
    scenario, exitCode, requests, oracleFailures, fatal, incomplete: scenarioIncomplete, stopRule
  })),
  stopViolations: stopTriggered === null ? [] : [stopTriggered],
  errors: runErrors
});

process.stdout.write(`${JSON.stringify({
  runId, root: realRoot, status: manifest.status, scenarios: scenarioList,
  exitCode: runErrors.length === 0 && !incomplete ? 0 : 1,
  errors: runErrors,
  results: scenarioResults.map(({ scenario, exitCode, requests, oracleFailures }) => ({ scenario, exitCode, requests, oracleFailures }))
}, null, 2)}\n`);
process.exitCode = runErrors.length === 0 && !incomplete ? 0 : 1;
