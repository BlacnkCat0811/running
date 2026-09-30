#!/usr/bin/env node
// Read-only baseline inventory; migration 25 review history is consumed when present.
// Initialize/continue history explicitly with:
// npm run data:model-v2 -- --database PATH --action review-baseline --as-of ISO --apply
// This command never writes a review or publishes a new epoch.
// Usage: --database PATH [--as-of ISO] [--window-days 28] [--out PATH]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { buildBaselineRebaseReview, type BaselineRebaseReviewOptions } from "@rai/application";
import { assertUnifiedEvaluationReport, evaluationReportEnvelope } from "@rai/model-eval";

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
    // §15.8 的公共部分由 envelope 统一提供。
    ...evaluationReportEnvelope({
      generatedBy: "scripts/baseline-rebase-review.mts",
      databasePath: databasePath.replace(root, "."),
      repoRevision,
      reproduceCommand: "npm run data:baseline-rebase-review -- --database var/rai.sqlite --out deliverables/BASELINE_REBASE_REVIEW.json",
      accuracyStatus: "not_evaluable",
      accuracyReason:
        "rebase 检查是版本化启发式政策，不代表精度或退步检测已获实证校准。",
      gates: [
        {
          name: "rebase_review_verdict",
          status: review.review.status === "not_evaluable" ? "not_evaluable" : "passed",
          reason: review.review.status === "not_evaluable" ? "review 历史尚未显式初始化或缺少证据" : null
        },
        {
          name: "saturation_trigger",
          status: review.saturation.triggerMet === null
            ? "not_evaluable"
            : review.saturation.triggerMet ? "passed" : "failed",
          reason: review.saturation.triggerMet === null
            ? "窗口内没有可用证据，无法计算饱和度"
            : `saturatedFraction=${review.saturation.saturatedFraction} vs 阈值 ${review.saturation.threshold}`
        },
        {
          name: "minimum_independent_sessions",
          status: review.evidence.meetsMinimumIndependentSessions ? "passed" : "failed",
          reason: `${review.evidence.independentSessions} 次独立训练 vs 政策要求 ${review.evidence.minimumIndependentSessions}`
        }
      ],
      notEvaluable: [
        ...(review.review.status === "not_evaluable"
          ? [{ item: "review.status", reason: "review_history_not_persisted（见 gates[0]）" }] : []),
        ...(review.saturation.saturatedFraction === null
          ? [{ item: "saturation.saturatedFraction", reason: "窗口内没有合格证据；null 而不是 0" }]
          : []),
        ...(review.epoch.epochIdStatus === "not_available_at_this_schema"
          ? [{ item: "epoch.epochId", reason: "该 schema 没有 baseline_epoch_id 列；不编 hash 冒充" }]
          : [])
      ]
    }),
    schemaVersion: schemaVersion?.v ?? null,
    ...review
  };
  assertUnifiedEvaluationReport(report);
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
