// 阶段 2 源码/环境指纹（2026-10-21，审查整改版）。
//
//   node scripts/phase2-source-fingerprint.mjs --out <path> [--rev <git-rev>]
//
// 口径（与实施方案 §1.1 一致）：git ls-files -z 的路径按字节排序；依次纳入
// 路径原文、NUL 和文件内容 SHA-256 的**原始摘要字节**（不是十六进制文本）。
// 缺失路径用 MISSING 标记。不是 Git tree hash。
//
// 未跟踪但属于阶段 2 交付的文件单独列出逐项内容 SHA-256，并计算内容指纹；
// 这样“新增迁移、checkpoint、基准脚本只列文件名”不再能掩盖内容变化。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const out = readArg("--out");
const root = resolve(readArg("--root", "."));
const rev = readArg("--rev", null);

function git(command, options = {}) {
  const result = spawnSync("git", command, {
    cwd: root,
    encoding: options.buffer ? null : "utf8",
    maxBuffer: 1 << 28
  });
  if (result.status !== 0) {
    throw new Error(`git ${command.join(" ")} failed: ${options.buffer ? result.stderr?.toString() : result.stderr}`);
  }
  return result.stdout;
}

const tracked = (rev === null ? git(["ls-files", "-z"]) : git(["ls-tree", "-r", "-z", "--name-only", rev]))
  .split("\0").filter(Boolean).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

const fingerprint = createHash("sha256");
const files = [];
for (const path of tracked) {
  let content;
  try {
    content = rev === null
      ? readFileSync(resolve(root, path))
      : git(["show", `${rev}:${path}`], { buffer: true });
  } catch {
    fingerprint.update(`${path}\0MISSING`);
    files.push({ path, sha256: "MISSING", bytes: null });
    continue;
  }
  const digest = createHash("sha256").update(content).digest();
  fingerprint.update(path, "utf8");
  fingerprint.update(Buffer.from([0]));
  fingerprint.update(digest);
  files.push({ path, sha256: digest.toString("hex"), bytes: content.length });
}
const trackedContentFingerprint = fingerprint.digest("hex");

function walkFiles(target) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) return [];
  return readdirSync(target).flatMap((entry) => walkFiles(join(target, entry)));
}

const status = rev === null
  ? git(["status", "--porcelain"]).trim().split("\n").filter(Boolean)
  : [];
const stage2Untracked = rev === null
  ? status
    .filter((line) => line.startsWith("?? "))
    .flatMap((line) => walkFiles(resolve(root, line.slice(3))))
    .map((path) => relative(root, path).split("\\").join("/"))
    .filter((path) => /phase2|checkpoint|v47|ability-session|health-record-stats-worker|series-read-worker/.test(path))
    .filter((path) => !/\/source-manifest(-[^/]+)?\.json$/.test(path))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  : [];
const untrackedStage2Files = stage2Untracked.map((path) => {
  const content = readFileSync(resolve(root, path));
  return {
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.length
  };
});
const untrackedHash = createHash("sha256");
for (const entry of untrackedStage2Files) {
  untrackedHash.update(entry.path, "utf8");
  untrackedHash.update(Buffer.from([0]));
  untrackedHash.update(Buffer.from(entry.sha256, "hex"));
}
const untrackedStage2ContentFingerprint = untrackedStage2Files.length === 0 ? null : untrackedHash.digest("hex");
const combined = createHash("sha256");
combined.update(Buffer.from(trackedContentFingerprint, "hex"));
combined.update(Buffer.from(untrackedStage2ContentFingerprint ?? "", "hex"));
const combinedContentFingerprint = combined.digest("hex");

const manifest = {
  generatedAt: new Date().toISOString(),
  root,
  rev,
  head: git(["rev-parse", "HEAD"]).trim(),
  branch: git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
  trackedFiles: tracked.length,
  trackedContentFingerprint,
  untrackedStage2Files,
  untrackedStage2ContentFingerprint,
  combinedContentFingerprint,
  status,
  node: process.version,
  tsx: (() => {
    const result = spawnSync("npx", ["tsx", "--version"], { cwd: root, encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim().split("\n")[0];
    // 宿主没有 npm/npx 时仍记录实际本地 tsx，而不是把工具版本写成 null。
    const localTsx = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    if (!existsSync(localTsx)) return null;
    const localResult = spawnSync(localTsx, ["--version"], { cwd: root, encoding: "utf8" });
    return localResult.status === 0 ? localResult.stdout.trim().split("\n")[0] : null;
  })(),
  sqlite: process.versions.sqlite,
  platform: `${process.platform} ${process.arch}`,
  files
};

if (out) writeFileSync(resolve(out), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  rev: manifest.rev,
  head: manifest.head,
  branch: manifest.branch,
  trackedFiles: manifest.trackedFiles,
  trackedContentFingerprint: manifest.trackedContentFingerprint,
  untrackedStage2Files: manifest.untrackedStage2Files,
  untrackedStage2ContentFingerprint: manifest.untrackedStage2ContentFingerprint,
  combinedContentFingerprint: manifest.combinedContentFingerprint,
  node: manifest.node,
  tsx: manifest.tsx,
  sqlite: manifest.sqlite
}, null, 2));
