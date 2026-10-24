// 阶段 6 W0：冻结代码/协议/工具/夹具身份，生成 source-manifest.json。
//
// 只读 git 与文件哈希，不修改业务代码/数据库。行号与源文件哈希随实现变化，
// 因此报告中的行号只对 manifest 记录的 commit + worktree 快照有效。
//
// 用法：
//   node scripts/phase6/freeze.mjs --protocol deliverables/phase6-performance-2026-10-24/protocol.json \
//     --out deliverables/phase6-performance-2026-10-24/source-manifest.json \
//     [--runs /abs/run-001,/abs/run-002]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { REPO_ROOT, sha256File } from "./safety.mjs";

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const protocolPath = readArg("--protocol");
const outPath = readArg("--out");
const runs = (readArg("--runs", "") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
if (!outPath) {
  process.stderr.write("phase6-freeze: --out is required\n");
  process.exit(2);
}

const git = (commandArgs) => {
  const result = spawnSync("git", commandArgs, { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};

const toolFiles = [
  "scripts/phase6/safety.mjs",
  "scripts/phase6/fixtures.mjs",
  "scripts/phase6/runner.mjs",
  "scripts/phase6/driver.mjs",
  "scripts/phase6/collect-resources.mjs",
  "scripts/phase6/summarize.mjs",
  "scripts/phase6/verify.mjs",
  "scripts/phase6/stop-rules.mjs",
  "scripts/phase6/freeze.mjs",
  "scripts/phase6/freeze-evidence.mjs",
  "scripts/phase6/cgroup.mjs",
  "scripts/phase6/s08-contract.mjs",
  "scripts/phase6/write-sha256sums.mjs",
  "apps/api/test/phase6-safety.test.mjs",
  "apps/api/test/phase6-fixtures.test.mjs",
  "apps/api/test/phase6-verify.test.mjs",
  "apps/api/test/phase6-cgroup.test.mjs",
  "apps/api/test/phase6-s08-contract.test.mjs",
  "apps/api/test/phase6-driver.test.mjs",
  "apps/api/test/phase6-runner.test.mjs",
  "apps/api/test/phase6-stop-rules.test.mjs",
  "apps/api/test/phase6-freeze-evidence.test.mjs"
];
const files = {};
for (const relative of toolFiles) {
  const absolute = join(REPO_ROOT, relative);
  if (existsSync(absolute)) files[relative] = sha256File(absolute);
}
const auxiliary = ["package.json", "package-lock.json", "AGENTS.md"];
for (const relative of auxiliary) {
  const absolute = join(REPO_ROOT, relative);
  if (existsSync(absolute)) files[relative] = sha256File(absolute);
}

const runManifests = runs.map((runRoot) => {
  const manifestPath = join(runRoot, "manifest.json");
  const acceptancePath = join(runRoot, "acceptance.json");
  return {
    runRoot,
    manifest: existsSync(manifestPath) ? { path: manifestPath, sha256: sha256File(manifestPath) } : null,
    acceptance: existsSync(acceptancePath) ? { path: acceptancePath, sha256: sha256File(acceptancePath) } : null
  };
});

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository: REPO_ROOT,
  git: {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    status: git(["status", "--porcelain"]),
    diffStat: git(["diff", "--stat"]),
    stagedDiffStat: git(["diff", "--cached", "--stat"])
  },
  platform: {
    node: process.version,
    platform: process.platform,
    release: (await import("node:os")).release(),
    arch: (await import("node:os")).arch()
  },
  protocol: protocolPath && existsSync(protocolPath)
    ? { path: resolve(protocolPath), sha256: sha256File(protocolPath) } : null,
  inputs: {
    reviewPlan: "/Users/ta/Downloads/RAI_Phase6_Review_and_Implementation_Plan_2026-10-24.md",
    reviewPlanSha256: existsSync("/Users/ta/Downloads/RAI_Phase6_Review_and_Implementation_Plan_2026-10-24.md")
      ? sha256File("/Users/ta/Downloads/RAI_Phase6_Review_and_Implementation_Plan_2026-10-24.md") : null,
    fixPlan: "/Users/ta/Downloads/RAI_Phase6_Uncommitted_Review_Fix_Plan_2026-10-24.md",
    fixPlanSha256: existsSync("/Users/ta/Downloads/RAI_Phase6_Uncommitted_Review_Fix_Plan_2026-10-24.md")
      ? sha256File("/Users/ta/Downloads/RAI_Phase6_Uncommitted_Review_Fix_Plan_2026-10-24.md") : null
  },
  files,
  fixtureManifests: runs.map((runRoot) => {
    const path = join(runRoot, "manifest.json");
    if (!existsSync(path)) return null;
    try {
      const run = JSON.parse(readFileSync(path, "utf8"));
      return run.fixtureManifest ?? null;
    } catch { return null; }
  }).filter(Boolean),
  runs: runManifests
};
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ out: resolve(outPath), commit: manifest.git.commit, files: Object.keys(files).length }, null, 2)}\n`);
