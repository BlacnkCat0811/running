// 阶段 6 离线统计：只从原始文件重算，不连接数据库、不启动服务。
//
// 口径（实施方案 §5.3 / W8）：
//   · 分位数用固定 nearest-rank：排序后索引 ceil(p*n)-1；
//   · 少于 10,000 个成功请求时 P99 标 insufficient_samples，不发布；
//   · 预热样本保留但单独分组；超时/错误/拒绝全部保留并计数；
//   · 不平均不同运行的 P95/P99：每个 scenario/route/phase 各自报告。
//
// 用法：
//   node scripts/phase6/summarize.mjs --input <run-root> --output <report-dir>

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const MIN_SAMPLES_FOR_P99 = 10_000;

/** nearest-rank 分位数：排序后索引 ceil(p*n)-1；空样本返回 null。 */
export function nearestRank(sortedValues, ratio) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index];
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const rows = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      // 证据损坏必须失败关闭：静默丢行会把“少了一半样本”伪装成正常统计。
      throw new Error(`invalid JSONL at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return rows;
}

/**
 * 成功耗时样本：HTTP 2xx/3xx 且 outcome=success。
 *
 * 预期 4xx（删除训练 404、S08 的合法拒绝）不是“正常业务成功延迟”，必须留在
 * expectedRefusal / 独立组；超时与 5xx 也不能进入成功分位数。P99 的样本门槛
 * 量的是**这个数组**的长度，而不是“有 clientMs 的所有样本”。
 */
export function isSuccessfulLatencySample(sample) {
  return sample?.outcome === "success"
    && Number.isInteger(sample.status) && sample.status >= 200 && sample.status < 400;
}

export function isExpectedRefusalSample(sample) {
  const expected = Array.isArray(sample?.expectedStatus) ? sample.expectedStatus : [];
  return Number.isInteger(sample?.status) && sample.status >= 400 && sample.status < 500
    && expected.includes(sample.status);
}

/** 单组耗时统计；p99 在**成功**样本不足时明确返回字符串而不是数字。 */
export function summarizeDurations(samples, { minSamplesForP99 = MIN_SAMPLES_FOR_P99 } = {}) {
  const sendLags = samples
    .map((sample) => sample.sendLagMs)
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  const successSamples = samples.filter(isSuccessfulLatencySample);
  const durations = successSamples
    .map((sample) => sample.clientMs)
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  const n = durations.length;
  const offered = samples.length;
  const completed = samples.filter((sample) => Number.isInteger(sample.status)).length;
  const businessSuccess = successSamples.length;
  const expectedRefusal = samples.filter(isExpectedRefusalSample).length;
  const timeoutSamples = samples.filter((sample) => sample.timeout === true);
  const timeoutDurations = timeoutSamples.map((sample) => sample.clientMs)
    .filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  return {
    n,
    offered,
    completed,
    businessSuccess,
    timedSuccess: n,
    expectedRefusal,
    success: businessSuccess,
    successRate: offered === 0 ? null : businessSuccess / offered,
    completionRate: offered === 0 ? null : completed / offered,
    min: n === 0 ? null : durations[0],
    p50: nearestRank(durations, 0.5),
    p95: nearestRank(durations, 0.95),
    p99: n >= minSamplesForP99 ? nearestRank(durations, 0.99) : "insufficient_samples",
    p99SampleCount: n,
    max: n === 0 ? null : durations[n - 1],
    mean: n === 0 ? null : durations.reduce((sum, value) => sum + value, 0) / n,
    sendLagP95Ms: nearestRank(sendLags, 0.95),
    sendLagMaxMs: sendLags.length === 0 ? null : sendLags[sendLags.length - 1],
    timeouts: timeoutSamples.length,
    timeoutMaxMs: timeoutDurations.length === 0 ? null : timeoutDurations[timeoutDurations.length - 1],
    serverErrors: samples.filter((sample) => Number.isInteger(sample.status) && sample.status >= 500).length,
    runnerDropped: samples.filter((sample) => sample.outcome === "runner_dropped").length,
    unexpectedStatus: samples.filter((sample) => sample.outcome === "unexpected_status").length,
    oracleFailed: samples.filter((sample) => sample.outcome === "oracle_failed").length
  };
}

function groupBy(samples, keyFn) {
  const grouped = new Map();
  for (const sample of samples) {
    const key = keyFn(sample);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(sample);
  }
  return grouped;
}

/** 一个 run 目录的完整统计。scenario 子目录与聚合 raw 都收（不重复）。 */
export function collectRun(inputRoot) {
  const resultDirectory = join(inputRoot, "results");
  const scenarioDirs = existsSync(resultDirectory)
    ? readdirSync(resultDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [];
  const scenarios = {};
  for (const scenario of scenarioDirs) {
    const requestsPath = join(resultDirectory, scenario, "raw", "requests.jsonl");
    const taskPath = join(resultDirectory, scenario, "raw", "task-events.jsonl");
    const casesPath = join(resultDirectory, scenario, "raw", "cases.jsonl");
    if (!existsSync(requestsPath) && !existsSync(taskPath) && !existsSync(casesPath)) continue;
    const samples = readJsonl(requestsPath);
    const taskEvents = readJsonl(taskPath);
    const cases = readJsonl(casesPath);
    scenarios[scenario] = {
      requests: samples.length,
      cases: cases.length,
      scenarios: summarizeByGroup(samples, (sample) => sample.scenario ?? scenario),
      routes: Object.fromEntries([...groupBy(samples, (sample) => sample.routeTemplate ?? "unknown")].map(([route, values]) => [
        route, summarizeDurations(values)
      ])),
      traffic: Object.fromEntries([...groupBy(samples, (sample) => sample.traffic ?? "main")].map(([traffic, values]) => [
        traffic, summarizeDurations(values)
      ])),
      phases: Object.fromEntries([...groupBy(samples, (sample) => `${sample.phase ?? "steady"}:${sample.traffic ?? "main"}`)].map(([phase, values]) => [
        phase, summarizeDurations(values)
      ])),
      outcomes: samples.reduce((acc, sample) => {
        acc[sample.outcome ?? "unknown"] = (acc[sample.outcome ?? "unknown"] ?? 0) + 1;
        return acc;
      }, {}),
      load: taskEvents.find((event) => event.type === "s13_load_shape") ?? null,
      taskEvents,
      caseResults: cases,
      correctnessFile: join(resultDirectory, scenario, "correctness", `${scenario}.json`),
      rawFiles: { requests: requestsPath, taskEvents: taskPath, cases: casesPath }
    };
  }
  const resourceFiles = [];
  for (const directory of [join(inputRoot, "raw"), resultDirectory]) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith("resources-") && entry.endsWith(".jsonl")) resourceFiles.push(join(directory, entry));
    }
  }
  const resources = resourceFiles.map((path) => summarizeResources(path));
  const correctness = scenarioDirs
    .map((scenario) => {
      const path = join(resultDirectory, scenario, "correctness", `${scenario}.json`);
      if (!existsSync(path)) return null;
      try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
    })
    .filter(Boolean);
  return {
    inputRoot,
    generatedAt: new Date().toISOString(),
    scenarios,
    resources,
    correctness,
    scenarioCount: Object.keys(scenarios).length
  };
}

function summarizeByGroup(samples, keyFn) {
  return Object.fromEntries([...groupBy(samples, keyFn)].map(([key, values]) => [key, summarizeDurations(values)]));
}

export function summarizeResources(path) {
  const rows = readJsonl(path);
  const capability = rows.find((row) => row.kind === "capability") ?? null;
  const samples = rows.filter((row) => row.kind === "sample");
  const rss = samples.map((row) => row.rssBytes).filter((value) => typeof value === "number");
  const cgroupCurrent = samples.map((row) => row.cgroup?.memoryCurrentBytes).filter((value) => typeof value === "number");
  const cpuPercent = samples.map((row) => row.cpuPercentSum).filter((value) => typeof value === "number");
  const processCount = samples.map((row) => row.processCount).filter((value) => typeof value === "number");
  const cgroupPeak = samples.map((row) => row.cgroup?.memoryPeakBytes).filter((value) => typeof value === "number");
  const cpuUsage = samples.map((row) => row.cpuUsageCores).filter((value) => typeof value === "number");
  const escaped = samples.map((row) => Array.isArray(row.escapedPids) ? row.escapedPids.length : 0);
  const oomKills = samples.map((row) => row.cgroup?.memoryEvents?.oom_kill).filter((value) => typeof value === "number");
  return {
    file: basename(path),
    capability,
    sampleCount: samples.length,
    intervalMs: capability?.intervalMs ?? null,
    window: samples.length === 0 ? null : { first: samples[0].at, last: samples.at(-1).at },
    rssPeakBytes: rss.length === 0 ? null : Math.max(...rss),
    rssSource: capability?.memoryPrimary ?? "unknown",
    cpuPercentPeak: cpuPercent.length === 0 ? null : Math.max(...cpuPercent),
    cpuUsageCoresPeak: cpuUsage.length === 0 ? null : Math.max(...cpuUsage),
    processCountPeak: processCount.length === 0 ? null : Math.max(...processCount),
    cgroupMemoryCurrentPeakBytes: cgroupCurrent.length === 0 ? null : Math.max(...cgroupCurrent),
    cgroupMemoryKernelPeakBytes: cgroupPeak.length === 0 ? null : Math.max(...cgroupPeak),
    cgroupTarget: capability?.targetCgroup ?? null,
    cgroupSampler: capability?.samplerCgroup ?? null,
    cgroupLimits: capability?.limits ?? null,
    cgroupLimitErrors: capability?.limitErrors ?? [],
    cgroupAttributionMismatch: capability?.attributionMismatch ?? null,
    cgroupEscapedPidsMax: escaped.length === 0 ? null : Math.max(...escaped),
    cgroupOomKillsMax: oomKills.length === 0 ? null : Math.max(...oomKills),
    cgroupAvailable: capability?.cgroup === true,
    notes: capability?.notes ?? []
  };
}

export function summarizeRun(inputRoot) {
  return collectRun(inputRoot);
}

function parseArgs(argv) {
  const args = { input: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input") args.input = argv[++index];
    else if (argv[index] === "--output") args.output = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!args.input || !args.output) throw new Error("--input and --output are required");
  return args;
}

if (process.argv[1] && existsSync(process.argv[1]) && statSync(process.argv[1]).isFile() && basename(process.argv[1]) === "summarize.mjs") {
  try {
    const args = parseArgs(process.argv.slice(2));
    const summary = summarizeRun(args.input);
    mkdirSync(args.output, { recursive: true });
    writeFileSync(join(args.output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    const lines = [
      "# 阶段 6 统计摘要（自动生成）",
      "",
      `- 输入：\`${args.input}\``,
      `- 生成时间：${summary.generatedAt}`,
      `- 场景数：${summary.scenarioCount}`,
      "",
      "| 场景 | 请求 | 成功 | 成功率 | P50 ms | P95 ms | P99 ms | 超时 | 5xx | oracle 失败 |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
    ];
    for (const [scenario, data] of Object.entries(summary.scenarios)) {
      // 场景总计：把所有 route 的原始样本重新聚合，避免平均各路由分位数。
      const requestsPath = data.rawFiles.requests;
      const all = readJsonl(requestsPath);
      const overall = summarizeDurations(all);
      lines.push(`| ${scenario} | ${data.requests} | ${overall.success} | ${overall.successRate === null ? "n/a" : `${(overall.successRate * 100).toFixed(2)}%`} | ${format(overall.p50)} | ${format(overall.p95)} | ${format(overall.p99)} | ${overall.timeouts} | ${overall.serverErrors} | ${overall.oracleFailed} |`);
    }
    lines.push("", "## 说明", "",
      "- P99 仅在单组成功样本 ≥ 10,000 时发布；否则显示 insufficient_samples。",
      "- 分位数为 nearest-rank，未平均不同运行。",
      "- DEV 的 macOS RSS 采样不是 CLOUD cgroup 内存峰值；cgroup 列为空表示未测。", "");
    writeFileSync(join(args.output, "summary.md"), `${lines.join("\n")}\n`);
    process.stdout.write(`${JSON.stringify({ output: args.output, scenarios: Object.keys(summary.scenarios) }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`phase6-summarize: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

function format(value) {
  return typeof value === "number" ? value.toFixed(1) : String(value);
}
