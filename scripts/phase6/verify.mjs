// 阶段 6 离线裁决：只凭原始文件与协议重算，不连接数据库、不启动服务。
//
// F3 口径（审查修复方案 §5）：
//   · G0/G8 真正调用 fingerprintErrors()：协议 SHA、协议身份、profile/dataset/
//     场景集合、源码/工具哈希、fixture 哈希都必须一致；测后改协议必须非 0。
//   · G8 从 raw/*.jsonl 独立重算，与**已保存的** report/summary.json 及
//     correctness/*.json 做规范化字段比较；不再"用同一函数重算再和自己比"。
//   · 缺文件、重复/截断行、run/profile/dataset/scenario 身份不一致都失败。
//   · G5 消费目标 PID cgroup 归属与冻结限额读回；DEV 明确 BLOCKED。
//
// 用法：
//   node scripts/phase6/verify.mjs --input <run-root> --protocol <path> \
//     [--output <dir>] [--scope dev|phase6] [--regressions <json>] [--summary <json>] [--self-test]

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { REPO_ROOT, phase6ToolHashes, runtimeSourceHashes, sha256File } from "./safety.mjs";
import { MIN_SAMPLES_FOR_P99, readJsonl, summarizeDurations, summarizeRun } from "./summarize.mjs";

const REQUIRED_DEV_GATES = ["G0", "G1", "G2", "G3", "G4", "G8", "G9"];
const BLOCKED_CLOUD_GATES = ["G5", "G6", "G7"];
const VALID_SCOPES = new Set(["dev", "phase6"]);

/**
 * DEV 正确性场景矩阵（审查方案 W4 / 修复方案 §7）：S01–S12。
 *
 * 不能从 manifest 自行声明的场景推导：否则只跑 S01 的残缺 run 也能签
 * `devBaseline: PASS`。矩阵是签收口径，不是运行者的自述。
 */
export const DEV_BASELINE_SCENARIOS = Object.freeze([
  "S01", "S02", "S03", "S04", "S05", "S06",
  "S07", "S08", "S09", "S10", "S11", "S12"
]);

/** G9 必需回归命令；命令文本按实际记录匹配，缺一项即 FAIL。 */
export const REQUIRED_REGRESSION_CHECKS = Object.freeze([
  {
    id: "phase6-self-test",
    label: "node scripts/phase6/verify.mjs --self-test",
    matches: (command) => /(?:^|\s)(?:node\s+)?(?:\.\/)?(?:scripts\/phase6\/)?verify\.mjs\s+--self-test(?:\s|$)/.test(command)
      || /(?:^|\s)npm\s+run\s+phase6:verify:self-test(?:\s|$)/.test(command)
  },
  {
    id: "phase6-tests",
    label: "npm run phase6:test",
    matches: (command) => /(?:^|\s)npm\s+run\s+phase6:test(?:\s|$)/.test(command)
      || /phase6-(?:safety|fixtures|verify|cgroup|s08-contract|driver|runner|stop-rules|freeze-evidence)\.test\.mjs/.test(command)
  },
  {
    id: "typecheck",
    label: "npm run typecheck",
    matches: (command) => /(?:^|\s)npm\s+run\s+typecheck(?:\s|$)/.test(command)
  },
  {
    id: "test",
    label: "npm test",
    matches: (command) => /(?:^|\s)npm\s+test(?:\s|$)/.test(command)
  },
  {
    id: "acceptance-matrix",
    label: "npm run check:acceptance-matrix",
    matches: (command) => /(?:^|\s)npm\s+run\s+check:acceptance-matrix(?:\s|$)/.test(command)
  },
  {
    id: "smoke-api",
    label: "npm run smoke:api",
    matches: (command) => /(?:^|\s)npm\s+run\s+smoke:api(?:\s|$)/.test(command)
  },
  {
    id: "check-scripts",
    label: "npm run check:scripts",
    matches: (command) => /(?:^|\s)npm\s+run\s+check:scripts(?:\s|$)/.test(command)
  },
  {
    id: "check-docs",
    label: "npm run check:docs",
    matches: (command) => /(?:^|\s)npm\s+run\s+check:docs(?:\s|$)/.test(command)
  }
]);

/** DEV 矩阵缺项；只在 `--scope dev` 的裁决上执行。 */
export function devScenarioMatrixErrors(declared, { scope = "dev", profile = "dev" } = {}) {
  // DEV 基线签收必须覆盖矩阵；CLOUD 正式范围（scope=phase6）才有权不按
  // DEV 矩阵裁决，避免把 cloud 的长跑证据误当 DEV 正确性。
  if (scope !== "dev") return [];
  if (profile !== "dev") return [];
  return DEV_BASELINE_SCENARIOS
    .filter((scenario) => !(declared ?? []).includes(scenario))
    .map((scenario) => `DEV baseline matrix missing scenario: ${scenario}`);
}

/** G9 必需命令缺项；命令只认实际记录，不从 overall 推断。 */
export function regressionCommandErrors(regressions) {
  const checks = Array.isArray(regressions?.checks) ? regressions.checks : [];
  if (checks.length === 0) return ["regressions.json has no command records"];
  const commands = checks.map((checkItem) => String(checkItem?.command ?? ""));
  return REQUIRED_REGRESSION_CHECKS
    .filter((required) => !commands.some((command) => required.matches(command)))
    .map((required) => `missing required regression command: ${required.label}`);
}

/**
 * 证据身份绑定：每条 raw/correctness 行都必须声明与运行清单相同的
 * run/profile/dataset/scenario。否则把另一轮的完整文件拼进来也能“通过形状校验”。
 */
export function evidenceIdentityErrors(rows, expected, kind = "row") {
  const errors = [];
  if (expected === null || expected === undefined) return errors;
  for (const [index, row] of rows.entries()) {
    for (const field of ["runId", "profile", "dataset", "scenario"]) {
      if (row?.[field] !== expected[field]) {
        errors.push(`${kind}#${index}: ${field} ${JSON.stringify(row?.[field])} != ${JSON.stringify(expected[field])}`);
      }
    }
  }
  return errors;
}

/** 原始样本结构校验：任何缺失/自相矛盾都让 G3 失败。 */
export function validateSamples(samples, expectedIdentity = null) {
  const errors = [...evidenceIdentityErrors(samples, expectedIdentity, "sample")];
  for (const [index, sample] of samples.entries()) {
    const where = `sample#${index}`;
    const dropped = sample.outcome === "runner_dropped";
    if (typeof sample.routeTemplate !== "string" || !sample.routeTemplate.startsWith("/v1/")) {
      errors.push(`${where}: routeTemplate missing or not /v1/*`);
    }
    if (typeof sample.scheduledAt !== "string" || Number.isNaN(Date.parse(sample.scheduledAt))) {
      errors.push(`${where}: scheduledAt missing/invalid`);
    }
    // 从未发送的 runner_dropped 没有 sentAt/clientMs，但必须留下明确的丢弃原因。
    if (dropped) {
      if (typeof sample.dropReason !== "string" || sample.dropReason.length === 0) {
        errors.push(`${where}: runner_dropped without dropReason`);
      }
      if (sample.sentAt !== null && sample.sentAt !== undefined) {
        errors.push(`${where}: runner_dropped must not claim it was sent`);
      }
      if (sample.status !== null && sample.status !== undefined) {
        errors.push(`${where}: runner_dropped must not carry an HTTP status`);
      }
      continue;
    }
    if (typeof sample.sentAt !== "string" || Number.isNaN(Date.parse(sample.sentAt))) {
      errors.push(`${where}: sentAt missing/invalid`);
    }
    if (sample.outcome === "success") {
      // 负例场景（删除训练 404、拒绝 400/413）可以在 expectedStatus 里声明；
      // 没声明却把 4xx/5xx 记 success 才是假绿。
      const expected = Array.isArray(sample.expectedStatus) ? sample.expectedStatus : [];
      const explicitNegative = sample.phase === "deleted:404" && sample.status === 404;
      if (!Number.isInteger(sample.status) || (sample.status >= 400 && !expected.includes(sample.status) && !explicitNegative)) {
        errors.push(`${where}: success with unexpected status ${String(sample.status)}`);
      }
      if (typeof sample.clientMs !== "number") errors.push(`${where}: success without clientMs`);
    } else if (sample.outcome !== "timeout" && sample.outcome !== "network_error" && sample.outcome !== undefined) {
      if (sample.status === null || sample.status === undefined) errors.push(`${where}: ${sample.outcome} without status`);
    }
    if (sample.timeout === true && sample.outcome === "success") errors.push(`${where}: timeout marked success`);
  }
  return errors;
}

/** 404 假成功负例：/v1/workouts/:id 的 404 不能出现在 success 里。 */
export function findFakeSuccess(samples) {
  return samples.filter((sample) =>
    sample.outcome === "success"
    && sample.routeTemplate === "/v1/workouts/:id"
    && sample.status === 404
    && sample.phase !== "deleted:404"
    && !(Array.isArray(sample.expectedStatus) && sample.expectedStatus.includes(404)));
}

/** 空样本/缺场景：任何声明的场景没有 raw 或 0 请求都不是通过。 */
export function missingScenarios(scenarioList, summary) {
  return scenarioList.filter((scenario) => !summary.scenarios[scenario] || summary.scenarios[scenario].requests === 0);
}

/** 预热混入：同一 route 的 warmup 样本不得计入 steady 统计。 */
export function phaseIsolationErrors(summary) {
  const errors = [];
  for (const [scenario, data] of Object.entries(summary.scenarios)) {
    const phases = Object.keys(data.phases ?? {});
    if (phases.includes("warmup:main") && !phases.some((phase) => phase.startsWith("steady:main"))) {
      errors.push(`${scenario}: warmup samples without steady phase`);
    }
  }
  return errors;
}

/**
 * S13 负载形状：到达率、丢弃、完成与守恒都必须能从原始样本复算。
 *
 * 只核对写请求数量会让“负载器少投放/多丢弃”变成不可见的通过；这里把
 * task event 的每个计数器与 raw/requests.jsonl 逐项对齐，并要求设定到达率
 * 对应的 tick 一个不少、丢弃为 0。
 */
export function s13WorkloadErrors(s13, statistics = {}) {
  if (s13 === null || s13 === undefined) return ["S13 summary missing"];
  const load = s13.load;
  if (load === null || load === undefined) return ["S13 has no s13_load_shape task event"];
  const errors = [];
  const samples = readJsonl(s13.rawFiles.requests);
  const main = samples.filter((sample) => (sample.traffic ?? "main") === "main");
  const health = samples.filter((sample) => sample.traffic === "health");
  const readbacks = samples.filter((sample) => sample.traffic === "write-readback");
  const unknownTraffic = samples.filter((sample) =>
    !["main", "health", "write-readback"].includes(sample.traffic ?? "main"));
  const dropped = samples.filter((sample) => sample.outcome === "runner_dropped");
  const droppedMain = main.filter((sample) => sample.outcome === "runner_dropped");
  const droppedHealth = health.filter((sample) => sample.outcome === "runner_dropped");
  const rate = Number(load.rate);
  const warmupMs = Number(load.warmupMs ?? 0);
  const durationMs = Number(load.durationMs ?? 0);
  const totalMs = warmupMs + durationMs;
  // 协议冻结的 DEV 正式热读口径：至少 30 s 预热 + 5 min 测量。1 秒冒烟
  // 只能证明工具会发请求，不能作为 S13 签收证据。
  const minimumWarmupMs = Number(statistics.warmupSeconds ?? 30) * 1_000;
  const minimumDurationMs = Number(statistics.minimumHotReadSeconds ?? 300) * 1_000;
  if (!Number.isFinite(warmupMs) || warmupMs < minimumWarmupMs) {
    errors.push(`S13 warmup ${String(load.warmupMs)} ms < protocol minimum ${minimumWarmupMs} ms`);
  }
  if (!Number.isFinite(durationMs) || durationMs < minimumDurationMs) {
    errors.push(`S13 duration ${String(load.durationMs)} ms < protocol minimum ${minimumDurationMs} ms`);
  }
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(totalMs) || totalMs <= 0) {
    errors.push("S13 load shape has invalid rate/duration");
  } else {
    const expectedMain = Math.ceil((totalMs * rate) / 1000 - 1e-9);
    const expectedHealth = Math.ceil(totalMs / 1000 - 1e-9);
    if (load.mainOffered !== expectedMain) {
      errors.push(`S13 mainOffered ${String(load.mainOffered)} != expected ${expectedMain} arrivals`);
    }
    if (load.healthOffered !== expectedHealth) {
      errors.push(`S13 healthOffered ${String(load.healthOffered)} != expected ${expectedHealth} arrivals`);
    }
  }
  if (load.mainOffered !== main.length) errors.push(`S13 mainOffered ${String(load.mainOffered)} != raw main samples ${main.length}`);
  if (load.healthOffered !== health.length) errors.push(`S13 healthOffered ${String(load.healthOffered)} != raw health samples ${health.length}`);
  if (load.offered !== main.length + health.length) {
    errors.push(`S13 offered ${String(load.offered)} != raw main + health samples ${main.length + health.length}`);
  }
  if (unknownTraffic.length > 0) errors.push(`S13 raw samples have unknown traffic: ${unknownTraffic.length}`);
  if (load.dropped !== dropped.length) errors.push(`S13 dropped ${String(load.dropped)} != raw runner_dropped ${dropped.length}`);
  if (load.mainDropped !== droppedMain.length) errors.push(`S13 mainDropped ${String(load.mainDropped)} != raw dropped main ${droppedMain.length}`);
  if (load.healthDropped !== droppedHealth.length) errors.push(`S13 healthDropped ${String(load.healthDropped)} != raw dropped health ${droppedHealth.length}`);
  if (load.mainSent !== main.length - droppedMain.length) errors.push("S13 mainSent != raw sent main samples");
  if (load.healthSent !== health.length - droppedHealth.length) errors.push("S13 healthSent != raw sent health samples");
  if (load.mainDropped !== Number(load.mainDroppedCapacity ?? 0) + Number(load.mainDroppedWindow ?? 0)) {
    errors.push("S13 mainDropped != capacity + window");
  }
  if (load.healthDropped !== Number(load.healthDroppedCapacity ?? 0) + Number(load.healthDroppedWindow ?? 0)) {
    errors.push("S13 healthDropped != capacity + window");
  }
  const conservation = load.conservation ?? {};
  for (const key of ["main", "health", "mainSent", "healthSent", "combinedOffered"]) {
    if (conservation[key] !== true) errors.push(`S13 conservation.${key} is not true`);
  }
  if (load.mainStillInFlight !== 0) errors.push("S13 mainStillInFlight is not 0");
  if (load.healthStillInFlight !== 0) errors.push("S13 healthStillInFlight is not 0");
  if (load.mainCompleted !== load.mainSent) errors.push("S13 mainCompleted != mainSent");
  if (load.healthCompleted !== load.healthSent) errors.push("S13 healthCompleted != healthSent");
  if (dropped.length > 0) errors.push(`S13 dropped ${dropped.length} offered requests instead of completing them`);
  const writes = samples.filter((sample) =>
    sample.method === "POST" && sample.routeTemplate === "/v1/performance-entries");
  const successfulWrites = writes.filter((sample) => sample.outcome === "success").length;
  const successfulReadbacks = readbacks.filter((sample) => sample.outcome === "success").length;
  if (writes.length === 0 || successfulWrites === 0) errors.push("S13 has no successful concurrent writes");
  if (load.writeSent !== writes.length || load.writeSuccessful !== successfulWrites) {
    errors.push("S13 write counters do not match raw requests");
  }
  if (load.writeReadbackSent !== readbacks.length) {
    errors.push(`S13 writeReadbackSent ${String(load.writeReadbackSent)} != raw readbacks ${readbacks.length}`);
  }
  if (load.writeReadbackSuccessful !== successfulReadbacks) {
    errors.push("S13 writeReadbackSuccessful != raw successful readbacks");
  }
  if (load.writeSuccessful !== load.writeReadbackSuccessful) {
    errors.push("S13 successful writes were not all read back from persistence");
  }
  if (readbacks.some((sample) => sample.method !== "GET" || sample.routeTemplate !== "/v1/performance-entries")) {
    errors.push("S13 write readback is not a GET /v1/performance-entries");
  }
  return errors;
}

/**
 * 配置指纹不一致：协议、代码、夹具与工具身份必须全部对齐。
 * G0/G8 都调用它，不再只定义一个没人用的函数。
 */
export function fingerprintErrors(manifest, protocolPath, { deliverableDir = null } = {}) {
  const errors = [];
  if (manifest === null || manifest === undefined) return ["run manifest missing"];
  if (!manifest?.protocol?.sha256) errors.push("manifest has no protocol sha256");
  if (protocolPath && manifest?.protocol?.sha256 && sha256File(protocolPath) !== manifest.protocol.sha256) {
    errors.push(`protocol file changed after the run: ${manifest.protocol.sha256} != ${sha256File(protocolPath)}`);
  }
  if (protocolPath && existsSync(protocolPath)) {
    let protocol = null;
    try { protocol = JSON.parse(readFileSync(protocolPath, "utf8")); } catch { errors.push("protocol file is not valid JSON"); }
    if (protocol !== null) {
      if (protocol.protocolVersion !== 1) errors.push(`protocolVersion must be 1, got ${String(protocol.protocolVersion)}`);
      if (typeof protocol.protocolId !== "string" || protocol.protocolId.length === 0) errors.push("protocol has no protocolId");
      if (manifest.protocol?.protocolId !== undefined && manifest.protocol.protocolId !== protocol.protocolId) {
        errors.push(`protocolId mismatch: manifest ${String(manifest.protocol.protocolId)} != protocol ${protocol.protocolId}`);
      }
      if (manifest.profile !== undefined && protocol.profiles?.[manifest.profile] === undefined) {
        errors.push(`profile is not defined in the frozen protocol: ${String(manifest.profile)}`);
      }
      if (manifest.dataset !== undefined && protocol.datasets?.[manifest.dataset] === undefined) {
        errors.push(`dataset is not defined in the frozen protocol: ${String(manifest.dataset)}`);
      }
      for (const scenario of manifest.scenarios ?? []) {
        if (protocol.scenarios?.[scenario] === undefined) errors.push(`scenario is not defined in the frozen protocol: ${scenario}`);
      }
      if (protocol.statistics?.minSamplesForP99 !== MIN_SAMPLES_FOR_P99) {
        errors.push(`protocol minSamplesForP99 must be ${MIN_SAMPLES_FOR_P99}`);
      }
      if (protocol.statistics?.percentile !== "nearest-rank: sorted[ceil(p*n)-1]") {
        errors.push("protocol percentile definition is not the frozen nearest-rank rule");
      }
    }
  }
  if (manifest?.code?.commit === undefined || manifest.code.commit === null) errors.push("manifest has no code commit");
  if (manifest?.code?.packageLockSha256 === undefined) {
    errors.push("manifest has no package-lock sha256");
  } else {
    const lockPath = join(REPO_ROOT, "package-lock.json");
    if (existsSync(lockPath) && sha256File(lockPath) !== manifest.code.packageLockSha256) {
      errors.push("package-lock.json changed after the run");
    }
  }
  if (manifest?.code?.toolFiles === undefined || typeof manifest.code.toolFiles !== "object") {
    errors.push("manifest has no tool file hashes");
  } else {
    const currentTools = phase6ToolHashes();
    if (JSON.stringify(Object.keys(manifest.code.toolFiles).sort()) !== JSON.stringify(Object.keys(currentTools).sort())) {
      errors.push("phase6 tool file set changed after the run");
    }
    for (const [relative, actual] of Object.entries(currentTools)) {
      if (manifest.code.toolFiles[relative] !== actual) errors.push(`tool file changed after the run: ${relative}`);
    }
  }
  const recordedSources = manifest?.code?.sourceFiles;
  if (recordedSources === null || recordedSources === undefined || typeof recordedSources !== "object"
      || Array.isArray(recordedSources)) {
    errors.push("manifest has no runtime source file hashes");
  } else {
    const currentSources = runtimeSourceHashes();
    const recordedNames = Object.keys(recordedSources).sort();
    const currentNames = Object.keys(currentSources).sort();
    if (JSON.stringify(recordedNames) !== JSON.stringify(currentNames)) {
      errors.push("runtime source file set changed after the run");
    }
    for (const name of currentNames) {
      if (recordedSources[name] !== currentSources[name]) errors.push(`runtime source changed after the run: ${name}`);
    }
  }
  if (manifest?.fixture?.sha256 === undefined) {
    errors.push("manifest has no fixture sha256");
  } else if (manifest.fixture.path && existsSync(manifest.fixture.path)
      && sha256File(manifest.fixture.path) !== manifest.fixture.sha256) {
    errors.push("fixture database changed after the run");
  }
  if (manifest?.fixtureManifest?.sha256 !== undefined) {
    let path = manifest.fixtureManifest.path;
    if ((path === null || path === undefined || !existsSync(path)) && deliverableDir !== null) {
      const candidate = join(deliverableDir, "evidence", "fixtures", `${String(manifest.dataset)}-manifest.json`);
      if (existsSync(candidate)) path = candidate;
    }
    if (path && existsSync(path) && sha256File(path) !== manifest.fixtureManifest.sha256) {
      errors.push("fixture manifest changed after the run");
    }
  }
  if (manifest?.payloadManifest?.sha256 !== undefined) {
    let path = manifest.payloadManifest.path;
    if ((path === null || path === undefined || !existsSync(path)) && deliverableDir !== null) {
      const candidate = join(deliverableDir, "evidence", "fixtures", "DX-manifest.json");
      if (existsSync(candidate)) path = candidate;
    }
    if (path && existsSync(path) && sha256File(path) !== manifest.payloadManifest.sha256) {
      errors.push("payload manifest changed after the run");
    }
  }
  return errors;
}

/** 资源重复计 RSS：同一个 PID 在一条样本里出现多次，或 API RSS 与进程总和重复相加。 */
export function resourceConsistencyErrors(summary) {
  const errors = [];
  for (const resource of summary.resources ?? []) {
    if (!resource.cgroupAvailable && resource.cgroupMemoryCurrentPeakBytes !== null) {
      errors.push(`${resource.file}: cgroup memory reported while cgroup unavailable`);
    }
    if (resource.rssPeakBytes !== null && resource.sampleCount === 0) {
      errors.push(`${resource.file}: RSS peak without samples`);
    }
  }
  return errors;
}

/** 每个声明场景都要有自己的资源文件；缺资源不能让 G3 以"有别的场景资源"通过。 */
export function resourceCoverageErrors(declaredScenarios, summary) {
  const files = new Set((summary.resources ?? []).map((resource) => resource.file));
  const errors = [];
  for (const scenario of declaredScenarios) {
    const expected = `resources-${scenario}.jsonl`;
    if (!files.has(expected)) errors.push(`missing resource file for ${scenario}: ${expected}`);
  }
  return errors;
}

function gate(id, status, evidence, reason) {
  return { id, status, evidence, reason };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

const STAT_KEYS = [
  "n", "offered", "completed", "businessSuccess", "timedSuccess", "expectedRefusal",
  "success", "successRate", "completionRate", "min", "p50", "p95", "p99", "p99SampleCount", "max", "mean",
  "sendLagP95Ms", "sendLagMaxMs", "timeouts", "timeoutMaxMs", "serverErrors", "runnerDropped",
  "unexpectedStatus", "oracleFailed"
];

function normalizeStats(stats) {
  const normalized = {};
  for (const key of STAT_KEYS) normalized[key] = stats?.[key] ?? null;
  return normalized;
}

/** 已保存 summary 的每个分组都必须能从 raw 独立重算；分组集合也不许少。 */
export function recomputeSummaryErrors(runRoot, rawSummary, savedSummary) {
  const errors = [];
  if (savedSummary === null) return ["saved report/summary.json missing"];
  const savedScenarios = savedSummary.scenarios ?? {};
  const rawScenarios = rawSummary.scenarios ?? {};
  const savedNames = Object.keys(savedScenarios).sort();
  const rawNames = Object.keys(rawScenarios).sort();
  if (JSON.stringify(savedNames) !== JSON.stringify(rawNames)) {
    errors.push(`scenario set mismatch: saved ${savedNames.join(",")} != raw ${rawNames.join(",")}`);
  }
  for (const scenario of rawNames) {
    const saved = savedScenarios[scenario];
    const raw = rawScenarios[scenario];
    if (saved === undefined) { errors.push(`${scenario}: missing from saved summary`); continue; }
    if (saved.requests !== raw.requests) errors.push(`${scenario}.requests: saved ${saved.requests} != raw ${raw.requests}`);
    for (const group of ["scenarios", "routes", "traffic", "phases"]) {
      const savedGroups = saved[group] ?? {};
      const rawGroups = raw[group] ?? {};
      const keys = new Set([...Object.keys(savedGroups), ...Object.keys(rawGroups)]);
      for (const key of keys) {
        const a = normalizeStats(savedGroups[key]);
        const b = normalizeStats(rawGroups[key]);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          const changed = STAT_KEYS.filter((statKey) => a[statKey] !== b[statKey]);
          errors.push(`${scenario}.${group}.${key}: saved != raw on ${changed.join(",")}`);
        }
      }
    }
    if ((saved.caseResults?.length ?? 0) !== (raw.caseResults?.length ?? 0)) {
      errors.push(`${scenario}.caseResults: saved ${saved.caseResults?.length ?? 0} != raw ${raw.caseResults?.length ?? 0}`);
    }
    if (saved.cases !== undefined && saved.cases !== raw.cases) {
      errors.push(`${scenario}.cases: saved ${saved.cases} != raw ${raw.cases}`);
    }
  }
  return errors;
}

/** correctness 与 raw/cases 的一致性：case 数、失败数、请求数。 */
export function correctnessConsistencyErrors(rawSummary, correctness) {
  const errors = [];
  const byScenario = new Map(correctness.map((item) => [item.scenario, item]));
  for (const [scenario, data] of Object.entries(rawSummary.scenarios)) {
    const item = byScenario.get(scenario);
    if (item === undefined) { errors.push(`${scenario}: missing correctness file`); continue; }
    if (item.fatal !== undefined) { errors.push(`${scenario}: correctness has fatal: ${item.fatal}`); continue; }
    if (item.requests !== data.requests) errors.push(`${scenario}.requests: correctness ${item.requests} != raw ${data.requests}`);
    const samples = readJsonl(data.rawFiles.requests);
    const outcomes = samples.reduce((counts, sample) => {
      const outcome = sample.outcome ?? "unknown";
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      return counts;
    }, {});
    if (JSON.stringify(item.outcomes ?? {}) !== JSON.stringify(outcomes)) {
      errors.push(`${scenario}.outcomes: correctness does not match raw requests`);
    }
    const caseResults = data.caseResults ?? [];
    const expectedFailures = [
      ...samples.filter((sample) => sample.outcome !== "success").map((sample) => ({
        routeTemplate: sample.routeTemplate, phase: sample.phase, status: sample.status,
        outcome: sample.outcome, businessCode: sample.businessCode,
        checks: (sample.oracle?.checks ?? []).filter((checkItem) => !checkItem.ok)
      })),
      ...caseResults.filter((caseResult) => caseResult.ok !== true).map((caseResult) => ({
        routeTemplate: "/v1/imports/case", phase: `s08:${caseResult.caseId}`,
        status: caseResult.observed?.rejection?.status ?? null, outcome: "oracle_failed",
        businessCode: caseResult.observed?.rejection?.code ?? null,
        checks: (caseResult.checks ?? []).filter((checkItem) => !checkItem.ok)
      }))
    ];
    if (JSON.stringify(item.oracleFailures ?? []) !== JSON.stringify(expectedFailures)) {
      errors.push(`${scenario}.oracleFailures: correctness does not match raw requests/cases`);
    }
    if (caseResults.length > 0) {
      const failedCases = caseResults.filter((caseResult) => caseResult.ok !== true).length;
      if (item.cases?.length !== caseResults.length) {
        errors.push(`${scenario}.cases: correctness ${item.cases?.length ?? 0} != raw ${caseResults.length}`);
      }
      const caseFailures = (item.oracleFailures ?? []).filter((failure) => String(failure.routeTemplate).includes("/imports/case")).length;
      if (caseFailures !== failedCases) {
        errors.push(`${scenario}.caseFailures: correctness ${caseFailures} != raw ${failedCases}`);
      }
      if ((item.oracleFailures?.length ?? 0) < failedCases) {
        errors.push(`${scenario}.oracleFailures: ${item.oracleFailures?.length ?? 0} < failed cases ${failedCases}`);
      }
    }
  }
  return errors;
}

/** G5：目标 PID 的 cgroup 归属、冻结限额与宿主读回必须逐项匹配。 */
export function cgroupGateErrors(manifest, summary, protocol) {
  const errors = [];
  const profile = manifest?.profile;
  const profileDefinition = protocol?.profiles?.[profile] ?? null;
  const expected = profileDefinition?.resourceReadBack ?? null;
  if (profile === null || profile === undefined || !String(profile).startsWith("cloud")) {
    return { status: "BLOCKED", errors: ["DEV profile does not provide CLOUD cgroup readback"] };
  }
  const declared = manifest?.scenarios ?? [];
  if (declared.length === 0) return { status: "FAIL", errors: ["cloud profile run has no declared scenarios"] };
  for (const scenario of declared) {
    const matches = (summary.resources ?? []).filter((item) => item.file === `resources-${scenario}.jsonl`);
    if (matches.length !== 1 || matches[0].cgroupAvailable !== true) {
      errors.push(`${scenario}: cgroup-capable resource file missing, duplicated or unavailable`);
      continue;
    }
    const resource = matches[0];
    const firstError = errors.length;
    const capability = resource.capability ?? {};
    if (capability.cgroup !== true) errors.push("capability.cgroup is not true");
    if (!capability.targetCgroup) errors.push("capability.targetCgroup missing");
    if (!capability.samplerCgroup) errors.push("capability.samplerCgroup missing");
    if (capability.samplerSeparate !== true) errors.push("sampler and API cgroup are not distinct");
    if (capability.attributionMismatch === true) errors.push("target PID cgroup does not match the expected cgroup");
    if (resource.cgroupEscapedPidsMax !== 0) errors.push(`cgroup escaped PIDs observed: ${String(resource.cgroupEscapedPidsMax)}`);
    if (resource.cgroupOomKillsMax !== null && resource.cgroupOomKillsMax > 0) {
      errors.push(`OOM kills observed: ${String(resource.cgroupOomKillsMax)}`);
    }
    for (const limitError of capability.limitErrors ?? []) errors.push(`limit readback: ${limitError}`);
    const host = capability.host ?? {};
    const expectedHost = profileDefinition?.resourceReadBack?.host ?? null;
    if (expectedHost !== null) {
      if (host.cpuCount !== expectedHost.cpuCount) errors.push(`host cpuCount ${String(host.cpuCount)} != ${expectedHost.cpuCount}`);
      if (host.totalMemoryBytes !== expectedHost.totalMemoryBytes) {
        errors.push(`host totalMemoryBytes ${String(host.totalMemoryBytes)} != ${expectedHost.totalMemoryBytes}`);
      }
    }
    if (resource.sampleCount === 0) errors.push("cgroup resource file has no samples");
    if (resource.cgroupMemoryCurrentPeakBytes === null) errors.push("memory.current samples missing");
    if (resource.cgroupMemoryKernelPeakBytes === null) errors.push("memory.peak readback missing");
    if (resource.cgroupOomKillsMax === null) errors.push("memory.events oom_kill readback missing");
    if (resource.cpuUsageCoresPeak === null) errors.push("cpu.stat usage_usec samples missing");
    if (!capability.limits) {
      errors.push("capability.limits readback missing");
    } else {
      if (capability.limits.memoryCurrentBytes === null || capability.limits.memoryCurrentBytes === undefined) {
        errors.push("capability.limits.memory.current missing");
      }
      if (capability.limits.memoryPeakBytes === null || capability.limits.memoryPeakBytes === undefined) {
        errors.push("capability.limits.memory.peak missing");
      }
      if (capability.limits.memoryEvents === null || capability.limits.memoryEvents === undefined) {
        errors.push("capability.limits.memory.events missing");
      }
      if (capability.limits.cpuStat === null || capability.limits.cpuStat === undefined) {
        errors.push("capability.limits.cpu.stat missing");
      }
      if (capability.limits.ioStat === null || capability.limits.ioStat === undefined) {
        errors.push("capability.limits.io.stat missing");
      }
      const limits = capability.limits;
      const oneCoreQuota = limits.cpuMaxCores;
      if (oneCoreQuota === null || oneCoreQuota === undefined || Math.abs(oneCoreQuota - Number(expected?.cpuQuotaCores ?? 1.5)) > 0.001) {
        errors.push(`cpu.max quota/period = ${String(oneCoreQuota)} cores, expected ${String(expected?.cpuQuotaCores ?? 1.5)}`);
      }
      if (limits.memoryHighBytes !== Number(expected?.memoryHighBytes ?? 1153433600)) {
        errors.push(`memory.high = ${String(limits.memoryHighBytes)}, expected ${String(expected?.memoryHighBytes ?? 1153433600)}`);
      }
      if (limits.memoryMaxBytes !== Number(expected?.memoryMaxBytes ?? 1468006400)) {
        errors.push(`memory.max = ${String(limits.memoryMaxBytes)}, expected ${String(expected?.memoryMaxBytes ?? 1468006400)}`);
      }
      if (limits.memorySwapMaxBytes !== Number(expected?.swapMaxBytes ?? 536870912)) {
        errors.push(`memory.swap.max = ${String(limits.memorySwapMaxBytes)}, expected ${String(expected?.swapMaxBytes ?? 536870912)}`);
      }
      if (limits.pidsMax !== Number(expected?.tasksMax ?? 128)) {
        errors.push(`pids.max = ${String(limits.pidsMax)}, expected ${String(expected?.tasksMax ?? 128)}`);
      }
    }
    for (let index = firstError; index < errors.length; index += 1) errors[index] = `${scenario}: ${errors[index]}`;
  }
  return { status: errors.length === 0 ? "PASS" : "FAIL", errors };
}

/**
 * 核心裁决。所有输入都是普通对象/文件路径，便于负例测试。
 */
export function verifyRun({
  runRoot, protocolPath, scope = "dev", regressionsPath = null,
  summaryPath = null, deliverableDir = null
}) {
  if (!VALID_SCOPES.has(scope)) throw new Error(`unknown scope: ${scope}`);
  const manifestPath = join(runRoot, "manifest.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null;
  const protocol = protocolPath && existsSync(protocolPath) ? readJson(protocolPath) : null;
  const effectiveDeliverable = deliverableDir ?? (protocolPath ? dirname(resolve(protocolPath)) : join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24"));
  const summary = summarizeRun(runRoot);
  const allSamples = [];
  for (const data of Object.values(summary.scenarios)) {
    try { allSamples.push(...readJsonl(data.rawFiles.requests)); } catch { /* 由 G3 的 read 错误报告 */ }
  }
  const manifestIdentityErrors = [];
  for (const field of ["runId", "profile", "dataset"]) {
    if (typeof manifest?.[field] !== "string" || manifest[field].length === 0) {
      manifestIdentityErrors.push(`manifest has no ${field} for evidence identity binding`);
    }
  }
  const expectedIdentity = (scenario) => ({
    runId: manifest?.runId ?? null,
    profile: manifest?.profile ?? null,
    dataset: manifest?.dataset ?? null,
    scenario
  });
  const gates = [];
  const fingerprint = fingerprintErrors(manifest, protocolPath, { deliverableDir: effectiveDeliverable });

  // G0：协议 + 代码身份 + 基线文档。
  const requiredDocs = ["BASELINE.md", "source-manifest.json", "open-items.md", "protocol.json"];
  const missingDocs = requiredDocs.filter((name) => !existsSync(join(effectiveDeliverable, name)));
  const g0Errors = [...fingerprint];
  if (protocol === null) g0Errors.push("protocol file missing or invalid");
  if (manifest === null) g0Errors.push("run manifest missing or invalid");
  gates.push(gate("G0", missingDocs.length === 0 && g0Errors.length === 0 ? "PASS" : "FAIL",
    { protocol: protocolPath, missingDocs, commit: manifest?.code?.commit ?? null, errors: g0Errors.slice(0, 30) },
    g0Errors.length > 0 ? `fingerprint/identity errors: ${g0Errors.slice(0, 5).join("; ")}`
      : missingDocs.length > 0 ? `missing baseline docs: ${missingDocs.join(", ")}`
        : "code/profile/dataset/protocol/fixture/tool frozen"));

  // G1：安全门禁证据。runner manifest 必须声明最终密钥扫描已通过；raw、日志与
  // secret-findings.json 任一有命中都不得通过（不能只信内存里的 runErrors）。
  const safety = manifest?.safety ?? null;
  const tokenHits = [];
  const rawReadErrors = [];
  for (const data of Object.values(summary.scenarios)) {
    for (const rawPath of Object.values(data.rawFiles ?? {})) {
      try {
        const text = readFileSync(rawPath, "utf8");
        tokenHits.push(...scanTextForSecrets(text));
      } catch (error) {
        rawReadErrors.push(`${rawPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const logSecretHits = [];
  const logReadErrors = [];
  const logFiles = new Set();
  const logsDirectory = join(runRoot, "logs");
  if (existsSync(logsDirectory)) {
    for (const entry of readdirSync(logsDirectory)) {
      if (entry.endsWith(".log")) logFiles.add(join(logsDirectory, entry));
    }
  }
  for (const command of manifest?.commands ?? []) {
    if (typeof command?.log === "string" && command.log.length > 0) logFiles.add(command.log);
  }
  for (const scenarioResult of manifest?.scenariosResults ?? []) {
    for (const key of ["driverLog", "apiLog"]) {
      if (typeof scenarioResult?.[key] === "string" && scenarioResult[key].length > 0) logFiles.add(scenarioResult[key]);
    }
  }
  for (const logPath of logFiles) {
    try {
      const text = readFileSync(logPath, "utf8");
      logSecretHits.push(...scanTextForSecrets(text).map((finding) => ({ file: logPath, ...finding })));
    } catch (error) {
      logReadErrors.push(`${logPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const secretFindingsPath = join(runRoot, "secret-findings.json");
  const secretFileErrors = [];
  const secretFileFindings = [];
  if (existsSync(secretFindingsPath)) {
    const saved = readJson(secretFindingsPath);
    if (Array.isArray(saved)) secretFileFindings.push(...saved);
    else secretFileErrors.push("secret-findings.json is not an array");
  }
  const g1Errors = [];
  if (safety === null) g1Errors.push("manifest lacks safety block");
  else {
    if (safety.rootOutsideRepo !== true) g1Errors.push("safety.rootOutsideRepo is not true");
    if (safety.envWhitelist !== true) g1Errors.push("safety.envWhitelist is not true");
    if (safety.isolatedTemp === undefined) g1Errors.push("safety.isolatedTemp missing");
    if (safety.tokenScan !== "clean") g1Errors.push(`safety.tokenScan is ${String(safety.tokenScan)}`);
  }
  if (tokenHits.length > 0) g1Errors.push(`raw evidence contains ${tokenHits.length} secret finding(s)`);
  if (logSecretHits.length > 0) g1Errors.push(`logs contain ${logSecretHits.length} secret finding(s)`);
  if (secretFileFindings.length > 0) g1Errors.push(`secret-findings.json contains ${secretFileFindings.length} finding(s)`);
  g1Errors.push(...secretFileErrors, ...rawReadErrors, ...logReadErrors);
  gates.push(gate("G1", g1Errors.length === 0 ? "PASS" : "FAIL",
    { safety, tokenHits: tokenHits.length, logSecretHits: logSecretHits.slice(0, 10), secretFileFindings: secretFileFindings.length,
      secretFileErrors, rawReadErrors, logReadErrors, scannedLogs: logFiles.size },
    g1Errors.length === 0 ? "negative safety checks recorded; raw/log/secret scan clean" : g1Errors.slice(0, 5).join("; ")));

  // G2：夹具 manifest + 摘要 + 规模 + 声明哈希。
  const fixtureManifestRef = manifest?.fixtureManifest ?? null;
  let fixtureManifestPath = typeof fixtureManifestRef === "string" ? fixtureManifestRef : fixtureManifestRef?.path ?? null;
  if (fixtureManifestPath !== null && !existsSync(fixtureManifestPath)) {
    const candidate = join(effectiveDeliverable, "evidence", "fixtures", `${String(manifest?.dataset)}-manifest.json`);
    if (existsSync(candidate)) fixtureManifestPath = candidate;
  }
  const fixtureManifest = fixtureManifestPath && existsSync(fixtureManifestPath) ? readJson(fixtureManifestPath) : null;
  const fixtureErrors = [];
  if (fixtureManifest === null) fixtureErrors.push("fixture manifest missing");
  else {
    if (!fixtureManifest.rows) fixtureErrors.push("fixture manifest has no rows");
    if (!fixtureManifest.digest) fixtureErrors.push("fixture manifest has no digest");
    if (fixtureManifest.dataset !== manifest?.dataset) fixtureErrors.push(`fixture dataset ${String(fixtureManifest.dataset)} != ${String(manifest?.dataset)}`);
    const declaredSha = fixtureManifest.databaseSha256 ?? fixtureManifest.bytes?.databaseSha256 ?? null;
    if (declaredSha === null) fixtureErrors.push("fixture manifest has no declared database sha256");
    else if (manifest?.fixture?.sha256 !== declaredSha) fixtureErrors.push("run fixture sha256 != fixture manifest declared sha256");
    if (manifest?.fixture?.bytes !== undefined && fixtureManifest.bytes?.database !== undefined
        && Number(manifest.fixture.bytes) !== Number(fixtureManifest.bytes.database)) {
      fixtureErrors.push("run fixture bytes != fixture manifest bytes");
    }
    if (fixtureManifestRef?.sha256 && fixtureManifestPath && sha256File(fixtureManifestPath) !== fixtureManifestRef.sha256) {
      fixtureErrors.push("fixture manifest file changed after the run");
    }
  }
  gates.push(gate("G2", fixtureErrors.length === 0 ? "PASS" : "FAIL",
    { fixtureManifestPath, rows: fixtureManifest?.rows ?? null, digest: fixtureManifest?.digest ?? null, errors: fixtureErrors },
    fixtureErrors.length > 0 ? fixtureErrors.join("; ") : "deterministic fixture digest + declared sha present"));

  // G3：原始样本结构 + 运行身份 + 资源文件覆盖 + 无 404 假成功 + case 证据。
  const identityErrors = [...manifestIdentityErrors];
  const shapeErrors = [];
  for (const [scenario, data] of Object.entries(summary.scenarios)) {
    const expected = expectedIdentity(scenario);
    let samples = [];
    try { samples = readJsonl(data.rawFiles.requests); } catch { /* rawReadErrors 已记录 */ }
    shapeErrors.push(...validateSamples(samples));
    identityErrors.push(...evidenceIdentityErrors(samples, expected, `${scenario}/samples`));
    identityErrors.push(...evidenceIdentityErrors(data.taskEvents ?? [], expected, `${scenario}/task-events`));
    identityErrors.push(...evidenceIdentityErrors(data.caseResults ?? [], expected, `${scenario}/cases`));
  }
  const fakeSuccess = findFakeSuccess(allSamples);
  const resourceCoverage = resourceCoverageErrors(manifest?.scenarios ?? [], summary);
  const resourceErrors = resourceConsistencyErrors(summary);
  const caseEvidenceErrors = [];
  const s08 = summary.scenarios.S08;
  if ((manifest?.scenarios ?? []).includes("S08")) {
    if (s08 === undefined || (s08.caseResults?.length ?? 0) === 0) caseEvidenceErrors.push("S08 has no raw/cases.jsonl case results");
    else {
      const required = s08.caseResults.filter((caseResult) => caseResult.contract?.required === true).length;
      if (required !== s08.caseResults.length) caseEvidenceErrors.push("S08 contains a case without required=true");
    }
  }
  const g3Errors = [...shapeErrors, ...identityErrors, ...rawReadErrors, ...resourceCoverage, ...resourceErrors, ...caseEvidenceErrors];
  gates.push(gate("G3", g3Errors.length === 0 && fakeSuccess.length === 0 ? "PASS" : "FAIL",
    { shapeErrors: shapeErrors.slice(0, 20), identityErrors: identityErrors.slice(0, 20), fakeSuccess: fakeSuccess.length,
      resourceFiles: summary.resources?.length ?? 0, resourceCoverage, resourceErrors, caseEvidenceErrors, rawReadErrors },
    g3Errors.length > 0 ? "raw/resource/case shape or identity invalid" : fakeSuccess.length > 0 ? "404 fake success detected" : "raw samples attributable"));

  // G4：声明场景全部有结果、无 fatal、无 oracle/case 失败。
  const declared = manifest?.scenarios ?? [];
  const missing = missingScenarios(declared, summary);
  const correctness = summary.correctness ?? [];
  const lifecycleErrors = [];
  if (manifest?.status !== "complete") lifecycleErrors.push(`run status is ${String(manifest?.status)}`);
  if (!Array.isArray(manifest?.scenariosResults)) lifecycleErrors.push("run has no scenario results");
  if ((manifest?.errors?.length ?? 0) > 0) lifecycleErrors.push("runner recorded errors");
  const failedScenarios = declared.filter((scenario) => {
    const item = correctness.find((entry) => entry.scenario === scenario);
    const runResult = manifest?.scenariosResults?.find((entry) => entry.scenario === scenario);
    if (runResult === undefined || runResult.exitCode !== 0 || runResult.incomplete !== false) {
      lifecycleErrors.push(`${scenario}: runner result missing, failed or incomplete`);
    }
    return item === undefined || item.fatal !== undefined || (item.oracleFailures?.length ?? 0) > 0
      || item.incomplete !== false || item.requests === 0;
  });
  const correctnessErrors = correctnessConsistencyErrors(summary, correctness);
  const correctnessIdentityErrors = [];
  for (const item of correctness) {
    if (typeof item?.scenario !== "string") {
      correctnessIdentityErrors.push("correctness file has no scenario identity");
      continue;
    }
    const expected = expectedIdentity(item.scenario);
    for (const field of ["runId", "profile", "dataset", "scenario"]) {
      if (item[field] !== expected[field]) {
        correctnessIdentityErrors.push(`${item.scenario}.correctness.${field} ${JSON.stringify(item[field])} != ${JSON.stringify(expected[field])}`);
      }
    }
  }
  const workloadErrors = [];
  const devMatrixErrors = devScenarioMatrixErrors(declared, { scope, profile: manifest?.profile ?? "dev" });
  if (declared.includes("S06")) {
    const s06 = summary.scenarios.S06;
    const duplicate = (s06?.taskEvents ?? []).find((event) => event.type === "s06_duplicate_check");
    if (duplicate === undefined) workloadErrors.push("S06 has no s06_duplicate_check task event");
    else {
      if (duplicate.noDuplicateHealthRecords !== true) workloadErrors.push("S06 duplicate health records were observed");
      if (duplicate.noDuplicateWorkouts !== true) workloadErrors.push("S06 duplicate workouts were observed");
    }
    const duplicateCase = (s06?.caseResults ?? []).find((caseResult) => caseResult.caseId === "S06-DUPLICATE");
    if (duplicateCase === undefined) workloadErrors.push("S06 has no S06-DUPLICATE case result");
    else if (duplicateCase.ok !== true) workloadErrors.push("S06 duplicate case failed");
  }
  if (declared.includes("S13")) {
    if (summary.scenarios.S13 === undefined) workloadErrors.push("S13 summary missing");
    else workloadErrors.push(...s13WorkloadErrors(summary.scenarios.S13, protocol?.statistics ?? {}));
  }
  // CLOUD-VALIDATION 的 S12 必须是可执行的候选写负载，而不是只读。
  if (manifest?.profile === "cloud-validation" && declared.includes("S12") && summary.scenarios.S12 !== undefined) {
    const s12Samples = readJsonl(summary.scenarios.S12.rawFiles.requests);
    const commandWrites = s12Samples.filter((sample) =>
      sample.method === "POST" && sample.routeTemplate === "/v1/mobile/training-plan/commands");
    const previews = s12Samples.filter((sample) =>
      sample.method === "POST" && sample.routeTemplate === "/v1/mobile/training-plan/commands/preview");
    if (!previews.some((sample) => sample.outcome === "success")) {
      workloadErrors.push("CLOUD-VALIDATION S12 has no successful command preview");
    }
    if (!commandWrites.some((sample) => sample.outcome === "success")) {
      workloadErrors.push("CLOUD-VALIDATION S12 has no successful command submit");
    }
    const apiCommand = (manifest.commands ?? []).find((command) =>
      command.scenario === "S12"
      && (String(command.command ?? "").includes("apps/api/src/server.ts")
        || String(command.command ?? "").includes("scripts/phase6/server-entry.mjs")));
    if (apiCommand === undefined || !(apiCommand.envKeys ?? []).includes("RAI_TRAINING_PLAN_COMMAND_MODE")) {
      workloadErrors.push("CLOUD-VALIDATION S12 API was not started in validation command mode");
    }
  }
  gates.push(gate("G4", missing.length === 0 && failedScenarios.length === 0
    && correctnessErrors.length === 0 && correctnessIdentityErrors.length === 0
    && lifecycleErrors.length === 0 && workloadErrors.length === 0
    && devMatrixErrors.length === 0 ? "PASS" : "FAIL",
    { declared, missing, devScenarioMatrix: DEV_BASELINE_SCENARIOS, devMatrixErrors,
      failedScenarios, correctnessErrors, correctnessIdentityErrors, lifecycleErrors, workloadErrors },
    lifecycleErrors.length > 0 ? `run lifecycle invalid: ${lifecycleErrors.join("; ")}`
      : devMatrixErrors.length > 0 ? `DEV scenario matrix incomplete: ${devMatrixErrors.join("; ")}`
      : failedScenarios.length > 0 ? `scenario failures: ${failedScenarios.join(", ")}`
      : workloadErrors.length > 0 ? `scenario workload invalid: ${workloadErrors.join("; ")}`
      : correctnessIdentityErrors.length > 0 ? `correctness identity invalid: ${correctnessIdentityErrors.slice(0, 5).join("; ")}`
      : correctnessErrors.length > 0 ? `correctness/raw mismatch: ${correctnessErrors.slice(0, 5).join("; ")}`
        : "declared scenarios cover the DEV matrix and have consistent machine-adjudicated results"));

  // G5–G7：CLOUD / 故障 / 长跑。
  const g5 = cgroupGateErrors(manifest, summary, protocol);
  gates.push(gate("G5", g5.status, { profile: manifest?.profile ?? null, cgroupAvailable: (summary.resources ?? []).some((resource) => resource.cgroupAvailable) },
    g5.errors.join("; ")));
  const cloudProfile = String(manifest?.profile ?? "").startsWith("cloud");
  const steadyMinutes = summary.scenarios?.S13?.load?.durationMs
    ? Number(summary.scenarios.S13.load.durationMs) / 60_000 : 0;
  const g6Status = cloudProfile && steadyMinutes >= 15 ? "NOT_RUN" : "BLOCKED";
  gates.push(gate("G6", g6Status, { steadyStateMinutes: steadyMinutes },
    cloudProfile && steadyMinutes >= 15 ? "单次 S13 不足 3 次独立重复/冻结目标" : "没有 CLOUD 稳定容量点；DEV 只做趋势冒烟"));
  gates.push(gate("G7", "BLOCKED", { faultRuns: 0, longRunHours: 0 }, "S15–S19 未执行；iOS S20 未运行"));

  // G8：从 raw 独立重算，与已保存 summary/correctness 比较；P99 样本不足保持 insufficient_samples。
  const savedSummaryPath = summaryPath ?? join(runRoot, "report", "summary.json");
  const savedSummary = existsSync(savedSummaryPath) ? readJson(savedSummaryPath) : null;
  const recomputeErrors = recomputeSummaryErrors(runRoot, summary, savedSummary);
  const correctnessErrorsForG8 = [...correctnessConsistencyErrors(summary, correctness), ...correctnessIdentityErrors];
  const g8Errors = [...recomputeErrors, ...correctnessErrorsForG8, ...identityErrors, ...fingerprint];
  gates.push(gate("G8", g8Errors.length === 0 ? "PASS" : "FAIL",
    { summaryPath: savedSummaryPath, recomputeErrors: recomputeErrors.slice(0, 30), correctnessErrors: correctnessErrorsForG8.slice(0, 30),
      fingerprintErrors: fingerprint.slice(0, 30) },
    g8Errors.length > 0 ? "saved summary/correctness not independently recomputable from raw" : "raw-only recompute matches saved summary; insufficient P99 handled"));

  // G9：回归门禁结果；必须绑定同一代码/工具身份。
  let regressions = null;
  if (regressionsPath && existsSync(regressionsPath)) regressions = readJson(regressionsPath);
  const regressionIdentityErrors = [];
  if (regressions !== null) {
    const identity = regressions.codeIdentity ?? null;
    if (identity === null) regressionIdentityErrors.push("regressions.json has no codeIdentity");
    else {
      if (identity.commit !== manifest?.code?.commit) regressionIdentityErrors.push("regressions commit != run commit");
      if (identity.packageLockSha256 !== manifest?.code?.packageLockSha256) regressionIdentityErrors.push("regressions package-lock != run package-lock");
      if (JSON.stringify(identity.toolFiles ?? null) !== JSON.stringify(manifest?.code?.toolFiles ?? null)) {
        regressionIdentityErrors.push("regressions tool files != run tool files");
      }
      if (!identity.sourceFiles || !manifest?.code?.sourceFiles) {
        regressionIdentityErrors.push("regressions or run has no runtime source file hashes");
      } else if (JSON.stringify(identity.sourceFiles) !== JSON.stringify(manifest.code.sourceFiles)) {
        regressionIdentityErrors.push("regressions runtime source files != run runtime source files");
      }
    }
  }
  const regressionCommandMissing = regressions === null ? [] : regressionCommandErrors(regressions);
  const regressionOk = regressions !== null && regressions.overall === "PASS"
    && Array.isArray(regressions.checks)
    && regressions.checks.length > 0
    && regressions.checks.every((checkItem) => checkItem.exitCode === 0)
    && regressionIdentityErrors.length === 0
    && regressionCommandMissing.length === 0;
  gates.push(gate("G9", regressions === null ? "NOT_RUN" : regressionOk ? "PASS" : "FAIL",
    { regressionsPath, overall: regressions?.overall ?? null, identityErrors: regressionIdentityErrors,
      requiredCommands: REQUIRED_REGRESSION_CHECKS.map((item) => item.label), missingCommands: regressionCommandMissing },
    regressions === null ? "regressions.json not supplied"
      : regressionCommandMissing.length > 0 ? `required regression commands missing: ${regressionCommandMissing.join("; ")}`
        : regressionOk ? "required npm/typecheck/self-test commands recorded with same code identity"
          : "regression identity/exit mismatch"));

  const gateById = Object.fromEntries(gates.map((item) => [item.id, item]));
  const required = scope === "phase6" ? [...REQUIRED_DEV_GATES, ...BLOCKED_CLOUD_GATES] : REQUIRED_DEV_GATES;
  const failedRequired = required.filter((id) => gateById[id].status !== "PASS");
  const devBaseline = REQUIRED_DEV_GATES.every((id) => gateById[id]?.status === "PASS") ? "PASS" : "FAIL";
  const cloudStatuses = BLOCKED_CLOUD_GATES.map((id) => gateById[id].status);
  const cloudCapacity = cloudStatuses.every((status) => status === "PASS") ? "PASS"
    : cloudStatuses.some((status) => status === "FAIL") ? "FAIL" : "BLOCKED";
  const phase6Overall = devBaseline === "FAIL" ? "FAIL" : cloudCapacity === "PASS" ? "PASS" : cloudCapacity === "FAIL" ? "FAIL" : "BLOCKED";
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    runRoot,
    protocolPath: protocolPath ?? null,
    scope,
    verdict: {
      devBaseline,
      cloudCapacity,
      phase6Overall,
      devScenarioMatrix: {
        required: DEV_BASELINE_SCENARIOS,
        declared: Array.isArray(manifest?.scenarios) ? manifest.scenarios : [],
        missing: DEV_BASELINE_SCENARIOS.filter((scenario) => !(manifest?.scenarios ?? []).includes(scenario))
      },
      knownFailures: gates.filter((item) => item.status === "FAIL").map((item) => item.id),
      blocked: gates.filter((item) => item.status === "BLOCKED").map((item) => item.id),
      notRun: gates.filter((item) => item.status === "NOT_RUN").map((item) => item.id)
    },
    exitCode: failedRequired.length === 0 ? 0 : 1,
    requiredGates: required,
    failedRequired,
    gates,
    summary: {
      scenarios: Object.keys(summary.scenarios),
      requests: allSamples.length,
      resources: summary.resources.length
    }
  };
}

/** 独立扫描：不依赖 process.env token，任何 Bearer 头都算泄漏。 */
function scanTextForSecrets(text) {
  return /authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi.test(text) ? [{ kind: "authorization_header" }] : [];
}

/**
 * 自检负例：每条都必须被对应校验捕获，否则 verify 本身就是假绿。
 */
export function selfTest() {
  const failures = [];
  const expect = (name, condition) => { if (!condition) failures.push(name); };
  const base = {
    routeTemplate: "/v1/workouts/:id", scheduledAt: new Date().toISOString(),
    sentAt: new Date().toISOString(), status: 200, outcome: "success", clientMs: 1
  };
  expect("404 fake success not detected", findFakeSuccess([{ ...base, status: 404 }]).length === 1);
  expect("empty samples accepted", validateSamples([]).length === 0);
  expect("missing timing not detected", validateSamples([{ ...base, scheduledAt: undefined }]).length > 0);
  expect("timeout success not detected", validateSamples([{ ...base, timeout: true }]).length > 0);
  expect("foreign run identity not detected", evidenceIdentityErrors([{ ...base, runId: "other" }], {
    runId: "expected", profile: "dev", dataset: "D0", scenario: "S01"
  }).length > 0);
  expect("dropped sample without reason not detected", validateSamples([{
    ...base, outcome: "runner_dropped", status: null, sentAt: null, clientMs: null
  }]).length > 0);
  const emptySummary = { scenarios: { S01: { requests: 0, phases: {}, scenarios: {} } }, resources: [] };
  expect("missing scenario not detected", missingScenarios(["S01"], emptySummary).length === 1);
  expect("S01-only run passes DEV matrix", devScenarioMatrixErrors(["S01"]).length > 0);
  expect("missing npm test regression passes", regressionCommandErrors({
    checks: [{ command: "npm run typecheck", exitCode: 0 }]
  }).some((error) => error.includes("npm test")));
  expect("warmup without steady not detected", phaseIsolationErrors({
    scenarios: { S01: { requests: 2, phases: { "warmup:main": {} }, scenarios: {} } }
  }).length === 1);
  expect("unknown profile not detected", fingerprintErrors({
    protocol: { sha256: "deadbeef" }, profile: "nope", dataset: "D0", scenarios: ["S01"], code: { commit: "x" }
  }, join(REPO_ROOT, "package.json")).length > 0);
  expect("P99 published with insufficient samples",
    summarizeDurations(Array.from({ length: 3 }, () => ({ clientMs: 1, outcome: "success", status: 200 }))).p99 === "insufficient_samples");
  expect("timeout counted as P99 sample",
    summarizeDurations([...Array.from({ length: MIN_SAMPLES_FOR_P99 - 1 }, () => ({ clientMs: 1, outcome: "success", status: 200 })),
      { clientMs: 9999, outcome: "timeout", status: null, timeout: true }]).p99 === "insufficient_samples");
  expect("expected 4xx counted as normal P99",
    summarizeDurations(Array.from({ length: MIN_SAMPLES_FOR_P99 }, () => ({ clientMs: 1, outcome: "success", status: 400, expectedStatus: [400] }))).p99 === "insufficient_samples");
  expect("fingerprint mismatch not detected", fingerprintErrors({
    protocol: { sha256: "deadbeef" }, code: { commit: "x" }
  }, join(REPO_ROOT, "package.json")).length > 0);
  expect("duplicate RSS not detected", resourceConsistencyErrors({
    resources: [{ file: "r", cgroupAvailable: false, cgroupMemoryCurrentPeakBytes: 1, rssPeakBytes: 1, sampleCount: 1 }]
  }).length === 1);
  expect("persisted summary compared to itself not detected", recomputeSummaryErrors("/nonexistent",
    { scenarios: { S01: { requests: 1, scenarios: {}, routes: { "/v1/health": { p95: 1 } }, traffic: {}, phases: {} } } },
    { scenarios: { S01: { requests: 1, scenarios: {}, routes: { "/v1/health": { p95: 2 } }, traffic: {}, phases: {} } } }
  ).length > 0);
  return { ok: failures.length === 0, failures };
}

function parseArgs(argv) {
  const args = { input: null, protocol: null, output: null, scope: "dev", regressions: null, summary: null, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--input") args.input = argv[++index];
    else if (current === "--protocol") args.protocol = argv[++index];
    else if (current === "--output") args.output = argv[++index];
    else if (current === "--scope") args.scope = argv[++index];
    else if (current === "--regressions") args.regressions = argv[++index];
    else if (current === "--summary") args.summary = argv[++index];
    else if (current === "--self-test") args.selfTest = true;
    else throw new Error(`unknown argument: ${current}`);
  }
  return args;
}

if (process.argv[1] && basename(process.argv[1]) === "verify.mjs") {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.selfTest) {
      const result = selfTest();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    } else {
      if (!args.input) throw new Error("--input is required");
      if (!args.protocol) throw new Error("--protocol is required");
      const output = args.output ?? args.input;
      mkdirSync(output, { recursive: true });
      const acceptance = verifyRun({
        runRoot: resolve(args.input),
        protocolPath: resolve(args.protocol),
        scope: args.scope,
        regressionsPath: args.regressions ? resolve(args.regressions) : null,
        summaryPath: args.summary ? resolve(args.summary) : null
      });
      writeFileSync(join(output, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({
        verdict: acceptance.verdict, exitCode: acceptance.exitCode, failedRequired: acceptance.failedRequired
      }, null, 2)}\n`);
      process.exitCode = acceptance.exitCode;
    }
  } catch (error) {
    process.stderr.write(`phase6-verify: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
