#!/usr/bin/env node
/**
 * 阶段 3 复审 §3.1：从**同一次**测试运行重建 `equivalence-summary.json`。
 *
 * 为什么需要生成器而不是手改 JSON：
 *   · 2026-10-22 的旧文件来自 12 表投影，三个新投影只出现在顶层清单里；
 *   · 报告拼接不同代码版本的统计会让"15 表等价"变成不可复核的声明。
 *
 * 输入是 `training-metric-domain-reuse.test.ts` 输出的 `P3-06_EVIDENCE` 行（每个
 * 正向场景一条，含**实际**投影的 15 张表/行数/列名/叶子值数）。生成器强制要求
 * 15 张必需表齐全，且 `training_sessions` / `model_release_bundles` /
 * `release_readable_state` 非空；任一缺失直接失败，不写文件。
 *
 * 用法：
 *   node --import tsx scripts/phase3-equivalence-summary.mts [--from-log <log>]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const deliverables = join(projectRoot, "deliverables/phase3-import-analysis-2026-10-22");
const summaryPath = join(deliverables, "evidence/equivalence-summary.json");
const defaultLog = join(deliverables, "evidence/equivalence-run-final.log");
const testFile = "packages/application/test/training-metric-domain-reuse.test.ts";
const concurrency = "2";

const REQUIRED_TABLES = [
  "workout_features", "workout_training_loads", "workout_zone_summaries",
  "daily_zone_profiles", "daily_training_metrics", "training_sessions",
  "ability_assessments", "daily_ability_snapshots", "model_runs", "model_v2_runs",
  "model_domain_snapshots", "model_release_bundles", "release_readable_state",
  "analysis_run_input_bindings", "analysis_job_coverage"
] as const;
const NON_EMPTY = new Set(REQUIRED_TABLES.filter((name) =>
  name !== "analysis_run_input_bindings" && name !== "analysis_job_coverage"));

interface EvidenceTable { rows: number; columns: string[]; leafValues: number }
interface EvidenceLine {
  scenario: string;
  reuse: Record<string, unknown>;
  featureCounters: { reused: number; recomputed: number };
  reusedAssessmentCount: number;
  tables: Record<string, EvidenceTable>;
}

function git(args: string[]): string {
  return spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" }).stdout.trim();
}

/**
 * Digest the source/test/docs worktree without trusting `git diff` alone.
 * `git status` collapses wholly-untracked directories unless `-uall` is used,
 * and diff never contains untracked bytes. Hash each changed path's content so
 * the summary cannot claim to describe a worktree whose new files changed.
 */
function sourceWorktreeDigest(): string {
  const scope = [".", ":(exclude)deliverables"];
  const status = spawnSync("git", [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...scope
  ], { cwd: projectRoot, maxBuffer: 1 << 28 }).stdout;
  const diff = spawnSync("git", ["diff", "--binary", "--", ...scope], {
    cwd: projectRoot, maxBuffer: 1 << 28
  }).stdout;
  const entries = status.toString("utf8").split("\0").filter(Boolean);
  const paths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length === 0) continue;
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
    paths.add(path);
  }
  const content = [...paths].sort().map((path) => {
    try {
      return `${path}\0${createHash("sha256").update(readFileSync(resolve(projectRoot, path))).digest("hex")}`;
    } catch {
      return `${path}\0missing`;
    }
  }).join("\0");
  return createHash("sha256")
    .update(status)
    .update("\0")
    .update(diff)
    .update("\0")
    .update(content)
    .digest("hex");
}

/**
 * Node's test runner emits TAP (`# fail N`) when piped and the spec reporter
 * (`ℹ fail N`) on a TTY. A log may therefore arrive in either shape. Returning
 * null means "no summary found" — that is not a passing run.
 */
function testCount(text: string, label: string): number | null {
  const plain = text.replace(/\r\n/g, "\n").replace(/\u001b\[[0-9;]*m/g, "");
  for (const pattern of [`^# ${label} (\\d+)$`, `^ℹ ${label} (\\d+)$`]) {
    const matches = [...plain.matchAll(new RegExp(pattern, "gm"))];
    if (matches.length > 0) return Number(matches[matches.length - 1]![1]);
  }
  return null;
}

const fromLogIndex = process.argv.indexOf("--from-log");
const logPath = fromLogIndex >= 0 ? resolve(projectRoot, process.argv[fromLogIndex + 1]!) : defaultLog;
let logText: string;
let command: string;
let exitCode: number;
let durationMs: number;
if (fromLogIndex >= 0) {
  if (!existsSync(logPath)) throw new Error(`Log does not exist: ${logPath}`);
  logText = readFileSync(logPath, "utf8");
  command = `(parsed from log) node --import tsx --test --test-concurrency=${concurrency} ${testFile}`;
  // A log is evidence only if it proves its own outcome. The old code set
  // `exitCode = 0` unconditionally, so a log containing `# fail 1` still wrote
  // `pass: true` for every scenario. Refuse anything but a complete, passing
  // test summary.
  const failures = testCount(logText, "fail");
  const tests = testCount(logText, "tests");
  const cancelled = testCount(logText, "cancelled") ?? 0;
  if (failures === null || tests === null) {
    throw new Error("The log has no complete test summary; refusing to treat it as a passing run");
  }
  if (failures > 0 || /^not ok \d+/m.test(logText)) {
    throw new Error(`The logged test run contains failures (${failures}); refusing to write a summary`);
  }
  if (cancelled > 0) {
    throw new Error(`The logged test run was cancelled (${cancelled}); refusing to write a summary`);
  }
  if (tests <= 0) {
    throw new Error("The logged test run reports zero tests; refusing to write a summary");
  }
  exitCode = 0;
  const duration = /(?:#|ℹ) duration_ms ([\d.]+)/.exec(logText);
  durationMs = duration ? Math.round(Number(duration[1])) : 0;
} else {
  if (!existsSync(dirname(logPath))) mkdirSync(dirname(logPath), { recursive: true });
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--test", `--test-concurrency=${concurrency}`, testFile
  ], {
    cwd: projectRoot,
    env: { ...process.env, RAI_TEST_CONCURRENCY: concurrency },
    encoding: "utf8",
    maxBuffer: 1 << 28
  });
  logText = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(logPath, logText);
  command = `RAI_TEST_CONCURRENCY=${concurrency} node --import tsx --test --test-concurrency=${concurrency} ${testFile}`;
  exitCode = result.status ?? 1;
  durationMs = Date.now() - started;
}
if (exitCode !== 0) throw new Error(`The evidence test run failed (exit ${exitCode}); refusing to write a summary`);

const evidence = new Map<string, EvidenceLine>();
for (const line of logText.split("\n")) {
  const marker = line.indexOf("P3-06_EVIDENCE ");
  if (marker < 0) continue;
  const parsed = JSON.parse(line.slice(marker + "P3-06_EVIDENCE ".length)) as EvidenceLine;
  evidence.set(parsed.scenario, parsed);
}

const oldSummary = existsSync(summaryPath)
  ? JSON.parse(readFileSync(summaryPath, "utf8")) as {
    scenarios?: Array<Record<string, unknown>>; fixture?: unknown; projection?: unknown;
    resolvedDiscrepancy?: unknown; remediation?: unknown;
  }
  : {};
const oldScenarios = new Map((oldSummary.scenarios ?? []).map((scenario) => [String(scenario.scenario), scenario]));

const scenarios: Array<Record<string, unknown>> = [];
for (const [scenario, line] of evidence) {
  const tables = Object.keys(line.tables);
  const missing = REQUIRED_TABLES.filter((name) => !tables.includes(name));
  const extra = tables.filter((name) => !(REQUIRED_TABLES as readonly string[]).includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Scenario ${scenario} does not project the required 15 tables; missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`);
  }
  for (const table of NON_EMPTY) {
    if ((line.tables[table]?.rows ?? 0) <= 0) {
      throw new Error(`Scenario ${scenario}: required table ${table} is empty`);
    }
  }
  const previous = oldScenarios.get(scenario) ?? {};
  scenarios.push({
    scenario,
    testName: previous.testName ?? scenario,
    change: previous.change ?? null,
    expectReuse: previous.expectReuse ?? true,
    incrementalReuse: line.reuse,
    featureCounters: line.featureCounters,
    reusedAssessmentCount: line.reusedAssessmentCount,
    comparedRows: Object.fromEntries(REQUIRED_TABLES.map((table) => [table, line.tables[table]!.rows])),
    fieldCounts: Object.fromEntries(REQUIRED_TABLES.map((table) => [table, {
      fieldCount: line.tables[table]!.columns.length,
      leafValues: line.tables[table]!.leafValues
    }])),
    tables: line.tables,
    ...(previous.routeAssertions === undefined ? {} : { routeAssertions: previous.routeAssertions }),
    pass: true
  });
}
for (const required of ["new_workout", "deletion", "route_move_xml_only"]) {
  if (!evidence.has(required)) throw new Error(`Missing required evidence scenario: ${required}`);
}
// Scenario metadata that lives in a different suite (T12 real lane) is kept as
// a cross-reference; it is not fabricated from this run's projection evidence.
for (const [name, previous] of oldScenarios) {
  if (evidence.has(name)) continue;
  scenarios.push({
    ...previous,
    evidenceSource: "separate suite (see its own log); not part of the 15-table projection run"
  });
}

// Digest only the source/test/docs worktree; deliverables/evidence churn must not
// change the digest of the code version the evidence describes.
const treeDigest = sourceWorktreeDigest();
const testsCount = testCount(logText, "tests");
const passCount = testCount(logText, "pass");
const failCount = testCount(logText, "fail");
const skippedCount = testCount(logText, "skipped");

const summary = {
  generatedAt: new Date().toISOString(),
  head: git(["rev-parse", "HEAD"]),
  workingTree: `dirty: 2026-10-23 review implementation; status+diff+content sha256=${treeDigest}`,
  fixture: oldSummary.fixture ?? null,
  projection: {
    ...(typeof oldSummary.projection === "object" && oldSummary.projection !== null ? oldSummary.projection : {}),
    tables: [...REQUIRED_TABLES],
    note: "The 15-table projection is validated by assertCompleteBusinessProjection(); a scenario missing one of these tables fails this generator."
  },
  scenarios,
  verification: {
    commands: [{
      command,
      log: logPath.slice(projectRoot.length + 1),
      nodeVersion: process.version,
      concurrency: Number(concurrency),
      exitCode,
      tests: testsCount,
      pass: passCount,
      fail: failCount,
      skipped: skippedCount,
      durationMs
    }],
    negativeControls: {
      testFile: "packages/application/test/phase3-business-artifact-differential.test.ts",
      note: "See the dedicated run log for exact counts; the comparator now includes missing-table/missing-column/value controls for training_sessions, model_release_bundles and release_readable_state."
    }
  },
  ...(oldSummary.resolvedDiscrepancy === undefined ? {} : { resolvedDiscrepancy: oldSummary.resolvedDiscrepancy }),
  ...(oldSummary.remediation === undefined ? {} : { remediation: oldSummary.remediation })
};

writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`Wrote ${summaryPath} with ${scenarios.length} scenarios x ${REQUIRED_TABLES.length} tables\n`);
