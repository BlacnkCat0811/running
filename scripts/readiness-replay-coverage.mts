#!/usr/bin/env node
// §7.3 / §15.3 / §15.5 —— 在真实库上量化恢复裁决对"到达时间口径"的敏感度。
//
// 为什么要有这个 runner：`replayReadinessRulings` 是纯函数、有单测，但此前**没有任何调用方**
// 在真实数据上跑过它，于是 §15.5 要求上报的"freshness 泄漏率"一直没有数字。
// 设计把 Readiness 列为回放优先级最高的领域，正是因为它最可能出现时间泄漏。
//
// 只读。口径（每日 asOf、日集合、回放模式）全部由被调用模块写进报告，本文件不另立一套。
//
// Usage:
//   node --import tsx scripts/readiness-replay-coverage.mts \
//     [--database var/rai.sqlite] [--out deliverables/READINESS_REPLAY_COVERAGE.json] \
//     [--timezone Asia/Shanghai] [--from 2026-01-01] [--to 2026-09-30] [--max-days 800]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { buildReadinessReplayCoverage } from "@rai/application";
import { assertUnifiedEvaluationReport, evaluationReportEnvelope } from "@rai/model-eval";
import { DATABASE_TIMEZONE } from "@rai/contracts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const readArg = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
};

const databasePath = resolve(root, readArg("--database", "var/rai.sqlite"));
const outPath = resolve(root, readArg("--out", "deliverables/READINESS_REPLAY_COVERAGE.json"));
const timezone = readArg("--timezone", DATABASE_TIMEZONE);
const from = argv.includes("--from") ? readArg("--from", "") : null;
const to = argv.includes("--to") ? readArg("--to", "") : null;
const maxDays = Number(readArg("--max-days", "800"));
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
  const coverage = buildReadinessReplayCoverage(handle, { timezone, fromLocalDate: from, toLocalDate: to, maxDays });
  const schemaVersion = handle.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    { v: number | null } | undefined;
  report = {
    // §15.8 的公共部分由 envelope 统一提供，不再各自手写。
    ...evaluationReportEnvelope({
      generatedBy: "scripts/readiness-replay-coverage.mts",
      databasePath: databasePath.replace(root, "."),
      repoRevision,
      reproduceCommand: `node --import tsx scripts/readiness-replay-coverage.mts --database var/rai.sqlite --out ${outPath.replace(root, ".")}`,
      accuracyStatus: "not_evaluable",
      accuracyReason:
        "两条分支共用同一个生产规则函数，只差到达时间假设；泄漏率衡量的是可用性口径的影响，不是模型精度。",
      gates: [
        {
          name: "leakage_rate_evaluated",
          status: coverage.comparableDays >= 2 ? "passed" : "not_evaluable",
          reason: coverage.comparableDays >= 2
            ? null
            : `只有 ${coverage.comparableDays} 个可比日；n<2 的比例不携带信息（leakageStatus=${coverage.leakageStatus}）`
        },
        {
          name: "as_known_then_replay",
          status: coverage.asKnownThenBlockedDays === 0 ? "passed" : "not_evaluable",
          reason: coverage.asKnownThenBlockedDays === 0
            ? null
            : `${coverage.asKnownThenBlockedDays} 天有读数但到达时间不可考，不能充当 as_known_then 证据`
        }
      ],
      // §15.8-5：统计不可用项及原因。分母为 0 时该率=null，而不是 0。
      notEvaluable: [
        ...(coverage.leakageRate === null
          ? [{ item: "leakageRate", reason: coverage.leakageRateInterpretation }]
          : []),
        ...(coverage.assessableDays === 0
          ? [{ item: "assessable_days", reason: "没有任何一天能按真实到达时间形成评估" }]
          : [])
      ]
    }),
    schemaVersion: schemaVersion?.v ?? null,
    assessmentMomentConvention: "每天以其本地日的最后一毫秒为 asOf（评估该日结束时已知什么）",
    replayMode: "event_time_reconstruction",
    ...coverage
  };
  assertUnifiedEvaluationReport(report);
} finally {
  handle.close();
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(`\nWrote ${outPath}\n`);
