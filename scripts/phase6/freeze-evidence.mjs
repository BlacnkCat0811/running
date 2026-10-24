// 阶段 6 F0：冻结历史证据、归档资源 JSONL、生成可复核的 run 索引。
//
// 这个工具只做三件事：
//   1. 把实验室里的 resources-*.jsonl 原样复制到交付 run 的 raw/（缺资源会让
//      离线复算无法定位资源峰值；旧 requests/task-events 一字节不改）；
//   2. 为每个文件记录 bytes + SHA-256 + 只读状态，并生成 run 索引（含负载参数、
//      样本数、丢弃数与“可信范围”）；
//   3. `--mark-read-only` 把旧 run 目录标成只读历史证据（在完成复制之后）。
//
// 旧 run 永远不覆盖：目标文件已存在且哈希不同则失败关闭。
//
// 用法：
//   node scripts/phase6/freeze-evidence.mjs \
//     --deliverable deliverables/phase6-performance-2026-10-24 \
//     --lab /Users/ta/rai-phase6-lab \
//     [--mark-read-only]

import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { REPO_ROOT, sha256File } from "./safety.mjs";

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const deliverable = resolve(readArg("--deliverable", "deliverables/phase6-performance-2026-10-24"));
const lab = resolve(readArg("--lab", "/Users/ta/rai-phase6-lab"));
const markReadOnly = args.includes("--mark-read-only");

if (!existsSync(join(deliverable, "evidence"))) {
  process.stderr.write(`phase6-freeze-evidence: evidence directory missing under ${deliverable}\n`);
  process.exit(2);
}

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runRoots = () => {
  const roots = [];
  for (const base of ["runs", "runs-v2"]) {
    const directory = join(deliverable, "evidence", base);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push({ base, name: entry.name });
    }
  }
  return roots.sort((a, b) => `${a.base}/${a.name}`.localeCompare(`${b.base}/${b.name}`));
};

function walk(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function treeDigest(root) {
  const lines = walk(root).map((path) => {
    const rel = relative(root, path).split(sep).join("/");
    return `${rel}\0${sha256File(path)}`;
  });
  return sha256Bytes(lines.join("\n"));
}

/** 从 run manifest 的 driver 命令里读取本次负载参数（没有则 null）。 */
function loadParameters(manifest) {
  const command = (manifest.commands ?? []).find((item) => Array.isArray(item.args)
    && item.args.some((arg) => String(arg).endsWith("driver.mjs")));
  if (!command) return null;
  const value = (name) => {
    const index = command.args.indexOf(name);
    return index >= 0 ? command.args[index + 1] : null;
  };
  return {
    rate: value("--rate") === null ? null : Number(value("--rate")),
    durationMs: value("--duration-ms") === null ? null : Number(value("--duration-ms")),
    warmupMs: value("--warmup-ms") === null ? null : Number(value("--warmup-ms")),
    maxInFlight: value("--max-in-flight") === null ? 64 : Number(value("--max-in-flight"))
  };
}

function loadShape(runDirectory, scenarios) {
  for (const scenario of scenarios) {
    const path = join(runDirectory, "results", scenario, "raw", "task-events.jsonl");
    if (!existsSync(path)) continue;
    const events = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const shape = events.find((event) => event.type === "s13_load_shape");
    if (shape) {
      return {
        source: relative(deliverable, path).split(sep).join("/"),
        rate: shape.rate ?? null,
        durationMs: shape.durationMs ?? null,
        warmupMs: shape.warmupMs ?? null,
        offered: shape.offered ?? null,
        completed: shape.completed ?? null,
        dropped: shape.dropped ?? null,
        maxInFlight: shape.maxInFlight ?? null,
        counters: shape.counters ?? null
      };
    }
  }
  return null;
}

function archiveResources(runRootName) {
  const targetRaw = join(deliverable, "evidence", "runs", runRootName, "raw");
  const sourceRaw = join(lab, runRootName, "raw");
  if (!existsSync(sourceRaw)) return [];
  mkdirSync(targetRaw, { recursive: true });
  const archived = [];
  for (const name of readdirSync(sourceRaw).filter((entry) => /^resources-.*\.jsonl$/.test(entry)).sort()) {
    const source = join(sourceRaw, name);
    const target = join(targetRaw, name);
    const sourceHash = sha256File(source);
    if (existsSync(target) && sha256File(target) !== sourceHash) {
      throw new Error(`refusing to overwrite archived resource with different bytes: ${target}`);
    }
    if (!existsSync(target)) copyFileSync(source, target);
    archived.push({
      file: relative(deliverable, target).split(sep).join("/"),
      source: source,
      bytes: statSync(target).size,
      sha256: sha256File(target),
      immutable: true
    });
  }
  return archived;
}

function countSamples(runDirectory, scenarios) {
  let requests = 0;
  let success = 0;
  for (const scenario of scenarios) {
    const path = join(runDirectory, "results", scenario, "raw", "requests.jsonl");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      requests += 1;
      const sample = JSON.parse(line);
      if (sample.outcome === "success") success += 1;
    }
  }
  return { requests, success };
}

const git = (commandArgs) => {
  const result = spawnSync("git", commandArgs, { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};

const archivedByRun = {};
for (const runRoot of runRoots()) {
  archivedByRun[`${runRoot.base}/${runRoot.name}`] = runRoot.base === "runs"
    ? archiveResources(runRoot.name) : [];
}

const runs = [];
for (const runRoot of runRoots()) {
  const runRootName = runRoot.name;
  const runDirectory = join(deliverable, "evidence", runRoot.base, runRootName);
  const manifestPath = join(runDirectory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const scenarios = manifest.scenarios ?? [];
  const parameters = loadParameters(manifest);
  const shape = loadShape(runDirectory, scenarios);
  const counts = countSamples(runDirectory, scenarios);
  const localResources = existsSync(join(runDirectory, "raw"))
    ? readdirSync(join(runDirectory, "raw")).filter((name) => /^resources-.*\.jsonl$/.test(name)).sort().map((name) => {
      const file = join(runDirectory, "raw", name);
      return {
        file: relative(deliverable, file).split(sep).join("/"),
        bytes: statSync(file).size,
        sha256: sha256File(file),
        immutable: true
      };
    }) : [];
  const isS13 = scenarios.length === 1 && scenarios[0] === "S13";
  const reportedS13 = isS13 && shape !== null;
  const legacy = runRoot.base === "runs";
  const status = legacy
    ? (reportedS13 ? "diagnostic-invalid-load-shape" : "frozen-legacy")
    : (isS13 ? "fixed-valid-dev" : "fixed-valid-dev");
  const reasons = [];
  if (legacy && reportedS13) {
    reasons.push("任务事件记录 2 rps × 30 s、offered 70、completed 65、dropped 27；"
      + "旧报告写成 0.5 rps × 60 s、0 dropped；该 run 是旧负载器诊断数据，不能用于稳态容量判断");
  } else if (!legacy) {
    reasons.push("修复后新工具/新 run-id 生成；参数、计数与原始文件见同目录 raw 与 manifest");
  }
  runs.push({
    runId: manifest.runId,
    evidenceDirectory: `${runRoot.base}/${runRootName}`,
    profile: manifest.profile,
    dataset: manifest.dataset,
    scenarios,
    requests: counts.requests,
    success: counts.success,
    loadParameters: parameters,
    loadShape: shape,
    status,
    statusReason: reasons.length > 0 ? reasons.join("；") : "旧工具生成的冻结历史证据；保留原裁决，不用于新 6A 签收",
    validForSteadyState: false,
    validForDevHotRead: !legacy && isS13 && Number(shape?.durationMs ?? 0) >= 300_000,
    runManifest: relative(deliverable, manifestPath).split(sep).join("/"),
    treeSha256: treeDigest(runDirectory),
    resources: legacy
      ? (archivedByRun[`${runRoot.base}/${runRootName}`] ?? [])
      : localResources
  });
}

const generatedAt = new Date().toISOString();
const index = {
  schemaVersion: 2,
  generatedAt,
  freezeRecord: "EVIDENCE-FREEZE.json",
  note: "旧 run 的 report 数字如与本索引冲突，以原始 task-events/requests 与本索引为准；旧 run 不用于新 6A 签收",
  runs
};

// 先写 run-index.json，再枚举 evidence 文件哈希。若顺序反过来，冻结记录会
// 记录“上一轮”的 index 哈希，重跑一次就指向过期内容。
writeFileSync(join(deliverable, "evidence", "run-index.json"), `${JSON.stringify(index, null, 2)}\n`);

const evidenceFiles = [];
for (const path of walk(join(deliverable, "evidence"))) {
  if (basename(path) === "EVIDENCE-FREEZE.json") continue;
  const stat = statSync(path);
  evidenceFiles.push({
    path: relative(deliverable, path).split(sep).join("/"),
    bytes: stat.size,
    sha256: sha256File(path),
    mode: `0${(stat.mode & 0o777).toString(8)}`
  });
}

const toolFiles = {};
for (const name of readdirSync(join(REPO_ROOT, "scripts", "phase6")).filter((entry) => entry.endsWith(".mjs")).sort()) {
  toolFiles[`scripts/phase6/${name}`] = sha256File(join(REPO_ROOT, "scripts", "phase6", name));
}
for (const relativePath of ["package-lock.json", "package.json"]) {
  toolFiles[relativePath] = sha256File(join(REPO_ROOT, relativePath));
}

const freeze = {
  schemaVersion: 1,
  frozenAt: generatedAt,
  purpose: "F0 历史证据冻结：旧 raw 不可改写；新实验使用全新根和 run-id",
  git: {
    commit: git(["rev-parse", "HEAD"]),
    status: git(["status", "--porcelain"]),
    diffStat: git(["diff", "--stat"]),
    stagedDiffStat: git(["diff", "--cached", "--stat"])
  },
  protocol: {
    path: "protocol.json",
    sha256: sha256File(join(deliverable, "protocol.json"))
  },
  inputs: {
    reviewPlan: "/Users/ta/Downloads/RAI_Phase6_Review_and_Implementation_Plan_2026-10-24.md",
    reviewPlanSha256: existsSync("/Users/ta/Downloads/RAI_Phase6_Review_and_Implementation_Plan_2026-10-24.md")
      ? sha256File("/Users/ta/Downloads/RAI_Phase6_Review_and_Implementation_Plan_2026-10-24.md") : null,
    fixPlan: "/Users/ta/Downloads/RAI_Phase6_Uncommitted_Review_Fix_Plan_2026-10-24.md",
    fixPlanSha256: existsSync("/Users/ta/Downloads/RAI_Phase6_Uncommitted_Review_Fix_Plan_2026-10-24.md")
      ? sha256File("/Users/ta/Downloads/RAI_Phase6_Uncommitted_Review_Fix_Plan_2026-10-24.md") : null
  },
  toolFiles,
  evidence: {
    fileCount: evidenceFiles.length,
    totalBytes: evidenceFiles.reduce((total, file) => total + file.bytes, 0),
    files: evidenceFiles
  },
  runs
};

// EVIDENCE-FREEZE.json 最后写；它的 evidence.files 已包含上面刚写完的
// run-index.json 的当前哈希。冻结记录排除自身，因此不会自我递归。
writeFileSync(join(deliverable, "evidence", "EVIDENCE-FREEZE.json"), `${JSON.stringify(freeze, null, 2)}\n`);

if (markReadOnly) {
  const markDirectory = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        markDirectory(path);
        chmodSync(path, 0o555);
      } else if (entry.isFile()) {
        chmodSync(path, 0o444);
      }
    }
  };
  // 旧 run 是只读历史证据；runs-v2 保留可写，verify --output 可写回验收文件。
  for (const runRoot of runRoots().filter((item) => item.base === "runs")) {
    const directory = join(deliverable, "evidence", runRoot.base, runRoot.name);
    markDirectory(directory);
    chmodSync(directory, 0o555);
  }
  const legacyRuns = join(deliverable, "evidence", "runs");
  if (existsSync(legacyRuns)) chmodSync(legacyRuns, 0o555);
}

process.stdout.write(`${JSON.stringify({
  deliverable,
  runs: runs.map((run) => ({ runId: run.runId, status: run.status, requests: run.requests, resources: run.resources.length })),
  evidenceFiles: evidenceFiles.length,
  readOnly: markReadOnly
}, null, 2)}\n`);
