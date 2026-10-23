#!/usr/bin/env node
/**
 * 阶段 3 复审 §3.5：从**最终** git 工作树生成 evidence/manifest.json 的
 * `changedFiles`，包括未跟踪目录中的每个文件及其内容哈希，避免清单只覆盖
 * 已跟踪改动而漏掉本次实现新增的文件。
 *
 * 只读取工作树与既有 manifest 的其余字段；不运行测试、不改命令统计。
 * 用法：node --import tsx scripts/phase3-evidence-manifest.mts
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const manifestPath = join(projectRoot, "deliverables/phase3-import-analysis-2026-10-22/evidence/manifest.json");
// `git status` always reports POSIX separators; normalize the platform path so
// the generated manifest excludes itself on Windows as well.
const manifestRelative = manifestPath.slice(projectRoot.length + 1).split(sep).join("/");
// The manifest cannot hash itself: exclude only the generated artifact. Every
// other worktree file (including untracked directories) belongs in the list.
const excluded = new Set([".DS_Store", manifestRelative]);
const excludedPrefixes = ["node_modules/", "target/", "var/", "output/", "cargo/"];

// `git status` collapses a wholly-untracked directory to `?? dir/` unless
// `--untracked-files=all` is set. The old generator then skipped that directory
// entry, so 100+ untracked files never entered `changedFiles` or the digest.
const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
  cwd: projectRoot, maxBuffer: 1 << 28
}).stdout.toString("utf8");
const paths = new Set<string>();
const entries = status.split("\0").filter(Boolean);
for (let index = 0; index < entries.length; index += 1) {
  const entry = entries[index]!;
  const code = entry.slice(0, 2);
  const path = entry.slice(3);
  if (path.length === 0) continue;
  if (code.startsWith("R") || code.startsWith("C")) index += 1; // skip rename/copy source
  paths.add(path);
}

const changedFiles: Array<{ path: string; sha256: string; bytes: number }> = [];
for (const path of [...paths].sort()) {
  if (excluded.has(path)) continue;
  if (excludedPrefixes.some((prefix) => path.startsWith(prefix))) continue;
  const absolute = join(projectRoot, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
  const bytes = readFileSync(absolute);
  changedFiles.push({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length
  });
}

const old = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim();
const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim();
const diff = spawnSync("git", ["diff", "--binary"], { cwd: projectRoot, maxBuffer: 1 << 28 }).stdout;
// `git diff` does not contain untracked bytes. Bind the digest to every
// changed file's actual content hash as well, so changing an untracked file
// (even inside an untracked directory) changes the manifest's tree digest.
const changedContentDigest = changedFiles
  .map((file) => `${file.path}\0${file.sha256}\0${file.bytes}`)
  .join("\0");
const treeDigest = createHash("sha256")
  .update(status).update("\0")
  .update(diff).update("\0")
  .update(changedContentDigest)
  .digest("hex");

writeFileSync(manifestPath, `${JSON.stringify({
  ...old,
  generatedAt: new Date().toISOString(),
  phase: "2026-10-23 review implementation: P1-1..P1-9, P2-1..P2-9, P3, evidence rebuild, third review fixes 1-5",
  head,
  branch,
  worktree: `dirty: 2026-10-23 review implementation; status+diff+content sha256=${treeDigest}`,
  environment: {
    ...(typeof old.environment === "object" && old.environment !== null ? old.environment : {}),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    timezone: "Asia/Shanghai"
  },
  changedFiles,
  changedFileCount: changedFiles.length
}, null, 2)}\n`);
process.stdout.write(`Updated ${manifestPath}: ${changedFiles.length} changed files at ${head}\n`);
