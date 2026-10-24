// 阶段 6 资源采样器：Linux cgroup v2 目标组归属优先，macOS/Windows 明确标注能力缺口。
//
// F4 口径（审查修复方案 §7）：
//   · 以**目标 API PID** 的 /proc/<pid>/cgroup 定位受测组；采样器自己的组单独记录。
//   · 每轮启动与采样期间检查 API、worker child、预测/训练子进程的组归属；
//     PID 消失、迁移、逃逸都写进 attribution 证据缺口，不能静默。
//   · 读回 cpu.max（换算核数）、memory.high/max/swap.max、pids.max 以及
//     memory.current/peak/events、cpu.stat、io.stat；不可读保持 null，不写 0。
//   · DEV 的 RSS 只是解释性视图，不是 CLOUD 内存峰值。
//
// 用法（runner 作为子进程拉起）：
//   node scripts/phase6/collect-resources.mjs --pid <api-pid> --out <jsonl> \
//     [--interval-ms 1000] [--cgroup <expected-path>] [--require-cgroup]
//     [--proc-root <dir>] [--cgroup-root <dir>] [--expected-limits <json>]
// 运行到收到 SIGTERM/SIGINT 或 stdin 关闭；每次采样写一行 JSON。

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  DEFAULT_CGROUP_ROOT,
  DEFAULT_PROC_ROOT,
  cgroupAttribution,
  cgroupDirectoryForPid,
  hostCapability,
  limitReadbackErrors,
  readCgroupSnapshot,
  readText
} from "./cgroup.mjs";

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const pid = Number(readArg("--pid", "0"));
const out = readArg("--out");
const intervalMs = Math.max(200, Number(readArg("--interval-ms", "1000")));
const runtimeRoot = readArg("--runtime-root", null);
const procRoot = readArg("--proc-root", DEFAULT_PROC_ROOT);
const cgroupRoot = readArg("--cgroup-root", DEFAULT_CGROUP_ROOT);
const expectedPath = readArg("--cgroup", null);
const requireCgroup = args.includes("--require-cgroup");
const expectedLimitsRaw = readArg("--expected-limits", null);
const expectedLimits = expectedLimitsRaw === null ? null : JSON.parse(expectedLimitsRaw);
if (!out) {
  process.stderr.write("phase6-resources: --out is required\n");
  process.exit(2);
}

const target = pid > 0 ? cgroupDirectoryForPid({ procRoot, cgroupRoot, pid }) : { relative: null, directory: null };
const ownRelative = readText(`${procRoot}/${process.pid}/cgroup`) === null
  ? null : (() => {
    const text = readText(`${procRoot}/${process.pid}/cgroup`).trim().split("\n").find((line) => line.startsWith("0::"));
    return text === undefined ? null : text.slice(3) || "/";
  })();
const targetExists = target.directory !== null && existsSync(target.directory);
const attributionMismatch = expectedPath !== null && target.relative !== expectedPath;
const limits = targetExists ? readCgroupSnapshot(target.directory) : null;
const limitErrors = expectedLimits === null || limits === null ? [] : limitReadbackErrors(limits, expectedLimits);
const cgroupAvailable = targetExists && limits !== null;

const capabilities = {
  kind: "capability",
  platform: process.platform,
  cgroup: cgroupAvailable,
  cgroupPath: target.relative,
  cgroupDirectory: target.directory,
  expectedCgroupPath: expectedPath,
  attributionMismatch,
  targetPid: pid,
  targetCgroup: target.relative,
  samplerCgroup: ownRelative,
  samplerSeparate: ownRelative === null || target.relative === null ? null : ownRelative !== target.relative,
  processTree: process.platform !== "win32",
  memoryPrimary: cgroupAvailable ? "cgroup.memory.current" : "per-pid RSS sum (sampled)",
  host: hostCapability(),
  limits,
  expectedLimits,
  limitErrors,
  notes: [
    ...(cgroupAvailable ? [] : ["cgroup v2 目标组不可用：DEV 只能给 RSS 采样，不冒充 CLOUD 内存峰值"]),
    ...(attributionMismatch ? [`目标 PID 的 cgroup ${String(target.relative)} != 期望 ${String(expectedPath)}`] : []),
    ...(limitErrors.length > 0 ? [`冻结限额读回不一致：${limitErrors.join("; ")}`] : []),
    "采样分辨率默认 1s；短峰值可能漏采"
  ],
  intervalMs,
  runtimeRoot,
  startedAt: new Date().toISOString()
};

if (requireCgroup && !cgroupAvailable) {
  process.stderr.write(`phase6-resources: cgroup ${String(target.relative)} is not readable; refusing CLOUD run\n`);
  process.exit(2);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "");
appendFileSync(out, `${JSON.stringify(capabilities)}\n`);

let stopping = false;
const stop = () => { stopping = true; };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin?.resume();
process.stdin?.on("end", stop);

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function parsePsOutput() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,vsz=,pcpu=,comm="], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024
  });
  const rows = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]),
      vszKiB: Number(match[4]), cpuPercent: Number(match[5]), command: match[6]
    });
  }
  return rows;
}

function processTree(rootPid) {
  if (process.platform === "win32") return null;
  try {
    const rows = parsePsOutput();
    const byParent = new Map();
    for (const row of rows) {
      if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
      byParent.get(row.ppid).push(row);
    }
    const tree = [];
    const queue = [rootPid];
    while (queue.length > 0) {
      const current = queue.shift();
      const row = rows.find((item) => item.pid === current);
      if (row) tree.push(row);
      for (const child of byParent.get(current) ?? []) queue.push(child.pid);
    }
    return tree;
  } catch {
    return null;
  }
}

function diskSnapshot() {
  try {
    // 安全余量必须量实验根所在文件系统；量仓库所在盘会在实验根位于另一挂载点时给出假余量。
    const path = runtimeRoot ?? ".";
    const stat = execFileSync("df", ["-k", path], { encoding: "utf8" }).split("\n")[1]?.trim().split(/\s+/);
    if (!stat || stat.length < 4) return null;
    return { filesystem: stat[0], path, sizeKiB: Number(stat[1]), usedKiB: Number(stat[2]), availableKiB: Number(stat[3]) };
  } catch {
    return null;
  }
}

let previousCpuUsageUsec = null;
let previousAtMs = null;
let previousMemoryEvents = null;

(async () => {
  while (!stopping) {
    const tree = processTree(pid);
    const unique = tree === null ? [] : [...new Map(tree.map((row) => [row.pid, row])).values()];
    const rssBytes = unique.reduce((total, row) => total + row.rssKiB * 1024, 0);
    const apiRow = unique.find((row) => row.pid === pid) ?? null;
    const snapshot = targetExists ? readCgroupSnapshot(target.directory) : null;
    const attribution = cgroupAvailable
      ? cgroupAttribution({ procRoot, cgroupRoot, targetPid: pid, pids: unique.map((row) => row.pid) })
      : null;
    const at = new Date();
    const atMs = at.getTime();
    const usageUsec = snapshot?.cpuStat?.usage_usec ?? null;
    const cpuUsageCores = usageUsec !== null && previousCpuUsageUsec !== null && previousAtMs !== null
      ? ((usageUsec - previousCpuUsageUsec) / 1_000_000) / ((atMs - previousAtMs) / 1000) : null;
    previousCpuUsageUsec = usageUsec;
    previousAtMs = atMs;
    let memoryEventsDelta = null;
    if (snapshot?.memoryEvents !== null && snapshot?.memoryEvents !== undefined) {
      memoryEventsDelta = {};
      for (const [key, value] of Object.entries(snapshot.memoryEvents)) {
        memoryEventsDelta[key] = previousMemoryEvents === null ? value : value - (previousMemoryEvents[key] ?? 0);
      }
      previousMemoryEvents = { ...snapshot.memoryEvents };
    }
    const sample = {
      kind: "sample",
      at: at.toISOString(),
      monotonicMs: Math.round(performance.now()),
      pid,
      processCount: unique.length,
      childPids: unique.filter((row) => row.pid !== pid).map((row) => row.pid),
      rssBytes: unique.length === 0 ? null : rssBytes,
      apiProcessRssBytes: apiRow === null ? null : apiRow.rssKiB * 1024,
      cpuPercentSum: unique.reduce((total, row) => total + row.cpuPercent, 0),
      processes: unique.map((row) => ({ pid: row.pid, ppid: row.ppid, rssKiB: row.rssKiB, cpuPercent: row.cpuPercent })),
      cgroup: snapshot,
      cgroupAttribution: attribution,
      escapedPids: attribution?.escaped ?? [],
      cpuUsageCores,
      memoryEventsDelta,
      disk: diskSnapshot()
    };
    appendFileSync(out, `${JSON.stringify(sample)}\n`);
    await sleep(intervalMs);
  }
  process.exit(0);
})();
