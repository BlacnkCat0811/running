#!/usr/bin/env node
// §6.4 的 rebase 定期检查在真实库上的**只读**盘点。
//
// 背景：`reviewBaselineRebase` 有实现、有单测，但没有任何生产调用方 ——
// "每 28 天最多检查一次 / 冷却 90 天 / 饱和触发"这套政策从未在真实数据上跑过。
// 本命令把可推导的事实算出来（epoch 起点、独立训练数、逐维度饱和度），
// 并明确报告哪两个输入**没有持久化**，因此 review 结论为 `not_evaluable`。
//
// 它**不会**、也不应该自动重建基线：§6.4 规定"自动重建关闭；检查只生成候选请求"，
// 而当前连"检查"都还缺状态。默认 `asOf` 取 active run 的 `evaluated_at`（数据前沿），
// 因为墙上时钟会让窗口落在没有任何数据的区间里。
//
// Usage:
//   node --import tsx scripts/baseline-rebase-review.mts [--database var/rai.sqlite]
//     [--as-of 2026-07-20T02:51:58.706Z] [--window-days 28] [--out deliverables/BASELINE_REBASE_REVIEW.json]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { buildBaselineRebaseReview, type BaselineRebaseReviewOptions } from "@rai/application";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const readArg = (name: string, fallback: string | null): string | null => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
};

const databasePath = resolve(root, readArg("--database", "var/rai.sqlite")!);
const outPath = readArg("--out", null);
const asOf = readArg("--as-of", null);
const windowDays = readArg("--window-days", null);
if (!existsSync(databasePath)) {
  process.stderr.write(`Database not found: ${databasePath}\n`);
  process.exit(1);
}

let repoRevision: string | null = null;
try {
  repoRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  repoRevision = null;
}

const handle = new DatabaseSync(databasePath, { readOnly: true });
let report: Record<string, unknown>;
try {
  // `exactOptionalPropertyTypes` 下不能把 undefined 当成"没给"，所以要逐项构造。
  const options: BaselineRebaseReviewOptions = {};
  if (asOf !== null) options.asOf = asOf;
  if (windowDays !== null) options.windowDays = Number(windowDays);
  const review = buildBaselineRebaseReview(handle, options);
  const schemaVersion = handle.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    { v: number | null } | undefined;
  report = {
    generatedBy: "scripts/baseline-rebase-review.mts",
    generatedAt: new Date().toISOString(),
    repoRevision,
    databasePath: databasePath.replace(root, "."),
    schemaVersion: schemaVersion?.v ?? null,
    ...review
  };
} finally {
  handle.close();
}

if (outPath !== null) {
  const resolved = resolve(root, outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`Wrote ${resolved}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
