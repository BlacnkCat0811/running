// 阶段 6 cgroup 读回：目标 PID 归属、冻结限额、事件与宿主能力。
//
// 纯函数 + 显式路径参数，便于用模拟文件系统测试（不需要 Linux 宿主）：
//   · procRoot 模拟 /proc（每个 PID 目录下有 cgroup 文件）
//   · cgroupRoot 模拟 /sys/fs/cgroup
// 生产调用传默认值。缺失值保持 null，绝不把不可读写成 0。

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { cpus, totalmem } from "node:os";

export const DEFAULT_PROC_ROOT = "/proc";
export const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";

/** CLI accepts a real cgroup directory; /proc stores its root-relative identity. */
export function normalizeCgroupDirectory(path, cgroupRoot = DEFAULT_CGROUP_ROOT) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("cgroup must be an absolute directory under the cgroup v2 mount");
  }
  const root = realpathSync(resolve(cgroupRoot));
  const directory = realpathSync(resolve(path));
  const child = relative(root, directory);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`cgroup must be a child of ${root}: ${directory}`);
  }
  return { directory, relative: `/${child.split(sep).join("/")}` };
}

/** 读取文本；不存在/不可读返回 null。 */
export function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** `cpu.max`：`max 100000` 或 `150000 100000`。cores = quota/period。 */
export function parseCpuMax(raw) {
  if (raw === null || raw === undefined) return { raw: null, quota: null, period: null, cores: null };
  const [quotaText, periodText] = String(raw).trim().split(/\s+/);
  const quota = quotaText === "max" || quotaText === undefined ? null : Number(quotaText);
  const period = periodText === undefined ? null : Number(periodText);
  return {
    raw: String(raw).trim(),
    quota: Number.isFinite(quota) ? quota : null,
    period: Number.isFinite(period) ? period : null,
    cores: Number.isFinite(quota) && Number.isFinite(period) && period > 0 ? quota / period : null
  };
}

/** `memory.high` / `memory.max` / `memory.swap.max`：`max` 或字节数。 */
export function parseMemoryLimit(raw) {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (value === "max" || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** `memory.events` / `pids.current` 等 key value 行。 */
export function parseKeyValue(raw) {
  if (raw === null || raw === undefined) return null;
  const values = {};
  for (const line of String(raw).trim().split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined && Number.isFinite(Number(value))) values[key] = Number(value);
  }
  return Object.keys(values).length === 0 ? null : values;
}

/** `io.stat`：每行 `8:0 rbytes=... wbytes=...`；解析失败返回原文本 + null 数值。 */
export function parseIoStat(raw) {
  if (raw === null || raw === undefined) return null;
  const devices = {};
  for (const line of String(raw).trim().split("\n")) {
    const [device, ...pairs] = line.trim().split(/\s+/);
    if (!device) continue;
    const values = {};
    for (const pair of pairs) {
      const [key, value] = pair.split("=");
      if (key && Number.isFinite(Number(value))) values[key] = Number(value);
    }
    devices[device] = values;
  }
  return Object.keys(devices).length === 0 ? { raw: String(raw) } : devices;
}

/** 从 `/proc/<pid>/cgroup` 读取 cgroup v2 的相对路径（`0::/rai/phase6`）。 */
export function readCgroupRelative(procRoot, pid) {
  const text = readText(join(procRoot, String(pid), "cgroup"));
  if (text === null) return null;
  const line = text.trim().split("\n").find((entry) => entry.startsWith("0::"));
  return line === undefined ? null : line.slice(3) || "/";
}

/** 把相对 cgroup 路径映射到 cgroupRoot 下的目录。 */
export function cgroupDirectory(cgroupRoot, relative) {
  if (relative === null || relative === undefined) return null;
  return join(cgroupRoot, relative.replace(/^\/+/, ""));
}

/** 目标 PID 的 cgroup 目录（同时返回相对路径，便于归属比较）。 */
export function cgroupDirectoryForPid({ procRoot = DEFAULT_PROC_ROOT, cgroupRoot = DEFAULT_CGROUP_ROOT, pid }) {
  const relative = readCgroupRelative(procRoot, pid);
  return { relative, directory: relative === null ? null : cgroupDirectory(cgroupRoot, relative) };
}

/** 读一个 cgroup 目录的全部冻结限额与事件；不可读字段为 null。 */
export function readCgroupSnapshot(directory) {
  if (directory === null || !existsSync(directory)) {
    return {
      path: directory, cpuMax: null, cpuMaxCores: null, memoryCurrentBytes: null, memoryPeakBytes: null,
      memoryMaxBytes: null, memoryHighBytes: null, memorySwapCurrentBytes: null, memorySwapMaxBytes: null,
      memoryEvents: null, pidsCurrent: null, pidsMax: null, cpuStat: null, ioStat: null
    };
  }
  const read = (name) => readText(join(directory, name));
  const cpuMax = parseCpuMax(read("cpu.max"));
  const numberOrNull = (raw) => (raw === null ? null : Number(raw) || null);
  return {
    path: directory,
    cpuMax: cpuMax.raw,
    cpuMaxCores: cpuMax.cores,
    memoryCurrentBytes: numberOrNull(read("memory.current")),
    memoryPeakBytes: numberOrNull(read("memory.peak")),
    memoryMaxBytes: parseMemoryLimit(read("memory.max")),
    memoryHighBytes: parseMemoryLimit(read("memory.high")),
    memorySwapCurrentBytes: numberOrNull(read("memory.swap.current")),
    memorySwapMaxBytes: parseMemoryLimit(read("memory.swap.max")),
    memoryEvents: parseKeyValue(read("memory.events")),
    pidsCurrent: numberOrNull(read("pids.current")),
    pidsMax: parseMemoryLimit(read("pids.max")),
    cpuStat: parseKeyValue(read("cpu.stat")),
    ioStat: parseIoStat(read("io.stat"))
  };
}

/** 冻结 profile 的期望限额（单位明确：字节 / 核 / 任务数）。 */
export function expectedLimitsFromProfile(profileDefinition) {
  const readBack = profileDefinition?.resourceReadBack ?? {};
  return {
    cpuQuotaCores: Number(readBack.cpuQuotaCores ?? 1.5),
    memoryHighBytes: Number(readBack.memoryHighBytes ?? 1_153_433_600),
    memoryMaxBytes: Number(readBack.memoryMaxBytes ?? 1_468_006_400),
    swapMaxBytes: Number(readBack.swapMaxBytes ?? 536_870_912),
    tasksMax: Number(readBack.tasksMax ?? 128)
  };
}

/** 逐项比较读回与冻结限额；返回字段级错误（空数组 = 通过）。 */
export function limitReadbackErrors(snapshot, expected) {
  const errors = [];
  if (snapshot === null) return ["cgroup snapshot missing"];
  if (snapshot.cpuMaxCores === null) errors.push("cpu.max missing or unparsable");
  else if (Math.abs(snapshot.cpuMaxCores - expected.cpuQuotaCores) > 0.001) {
    errors.push(`cpu.max cores ${snapshot.cpuMaxCores} != ${expected.cpuQuotaCores}`);
  }
  for (const [field, label] of [
    ["memoryHighBytes", "memory.high"], ["memoryMaxBytes", "memory.max"],
    ["memorySwapMaxBytes", "memory.swap.max"], ["pidsMax", "pids.max"]
  ]) {
    if (snapshot[field] === null || snapshot[field] === undefined) errors.push(`${label} missing or unparsable`);
    else if (Number(snapshot[field]) !== Number(expected[field === "pidsMax" ? "tasksMax"
      : field === "memorySwapMaxBytes" ? "swapMaxBytes" : field])) {
      errors.push(`${label} ${snapshot[field]} != expected ${expected[field === "pidsMax" ? "tasksMax"
        : field === "memorySwapMaxBytes" ? "swapMaxBytes" : field]}`);
    }
  }
  return errors;
}

/** 宿主/VM 能力：2 vCPU、2 GiB、Node/SQLite 版本、磁盘/文件系统在采样文件里另记。 */
export function hostCapability() {
  return {
    platform: process.platform,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version,
    sqlite: process.versions.sqlite ?? null,
    arch: process.arch
  };
}

/** 进程树里每个 PID 的 cgroup 归属；与目标组不一致的 PID 单独列出。 */
export function cgroupAttribution({ procRoot = DEFAULT_PROC_ROOT, cgroupRoot = DEFAULT_CGROUP_ROOT, targetPid, pids }) {
  const target = cgroupDirectoryForPid({ procRoot, cgroupRoot, pid: targetPid });
  const processes = [];
  const escaped = [];
  for (const pid of pids ?? []) {
    const found = cgroupDirectoryForPid({ procRoot, cgroupRoot, pid });
    const matchesTarget = target.relative !== null && found.relative === target.relative;
    processes.push({ pid, cgroup: found.relative, matchesTarget });
    if (!matchesTarget) escaped.push(pid);
  }
  return { target: target.relative, targetDirectory: target.directory, processes, escaped };
}

/** 列出 procRoot 下可识别的 PID（模拟测试用；生产由进程树提供）。 */
export function listProcPids(procRoot = DEFAULT_PROC_ROOT) {
  try {
    return readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry)).map(Number);
  } catch {
    return [];
  }
}
