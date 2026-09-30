#!/usr/bin/env node
// `canonical_nights` / `canonical_hrv_days` 的空表回填。
//
// 背景：`docs/SLEEP_HRV_DESIGN.md` 的 v17 迁移策略写明回填有两条路 —— 下一次 CLI import，
// 或 `recoverDatabaseJobs` 在启动时发现"夜表为空且存在睡眠行"时回填。**第二条从未接线。**
// 后果可观测：本机 `var/rai.sqlite` 有 5222 行睡眠段 / 684 行 HRV，而两张 canonical 表各 0 行，
// 于是 §7 的 Readiness 在这份库上永远只能拿到 `coverage: none`。
//
// 本命令把回填做成有守卫、幂等、可观察的动作。默认**只预览**；`--apply` 才写库。
//
// Usage:
//   node --import tsx scripts/backfill-canonical-nights.mts [--database var/rai.sqlite] [--timezone Asia/Shanghai] [--apply]
//   （也可用 npm run data:backfill-canonical-nights -- --apply）

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { backfillCanonicalNights } from "@rai/application";
import { DATABASE_TIMEZONE } from "@rai/contracts";

const args = process.argv.slice(2);
const readArg = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
};
const databasePath = resolve(readArg("--database", "var/rai.sqlite"));
const timezone = readArg("--timezone", DATABASE_TIMEZONE);
const apply = args.includes("--apply");
if (!existsSync(databasePath)) {
  process.stderr.write(`Database not found: ${databasePath}\n`);
  process.exit(1);
}

if (!apply) {
  // 预览也必须给出**要不要回填**的判据，而不是只说"请加 --apply"。
  const handle = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (sql: string, ...params: Array<string | number>): number =>
      Number((handle.prepare(sql).get(...params) as { n?: number } | undefined)?.n ?? 0);
    process.stdout.write(`${JSON.stringify({
      mode: "dry-run",
      databasePath,
      timezoneIdentifier: timezone,
      canonicalNights: count("SELECT COUNT(1) AS n FROM canonical_nights"),
      canonicalHrvDays: count("SELECT COUNT(1) AS n FROM canonical_hrv_days"),
      sleepRecords: count("SELECT COUNT(1) AS n FROM health_records WHERE type=?", "HKCategoryTypeIdentifierSleepAnalysis"),
      expectedAction: count("SELECT COUNT(1) AS n FROM canonical_nights") > 0
        ? "not_needed (canonical_nights is not empty)"
        : count("SELECT COUNT(1) AS n FROM health_records WHERE type=?", "HKCategoryTypeIdentifierSleepAnalysis") === 0
          ? "no_sleep_records"
          : "backfill",
      note: "只读预览；加 --apply 才会写入 canonical_nights / canonical_hrv_days。"
    }, null, 2)}\n`);
  } finally {
    handle.close();
  }
  process.exit(0);
}

// 回填要写库，所以用可写连接；不打开应用服务，也不触发重算。
const handle = new DatabaseSync(databasePath);
try {
  const result = backfillCanonicalNights(handle, timezone);
  process.stdout.write(`${JSON.stringify({ mode: "apply", databasePath, ...result }, null, 2)}\n`);
  if (result.status === "backfilled") {
    process.stderr.write(
      `\n已回填：主夜 ${result.canonicalization?.mainCount}、午睡 ${result.canonicalization?.napCount}、` +
      `HRV 日 ${result.canonicalization?.hrvCount}。\n` +
      "注意：这些 canonical 行的 `computed_at` 是**现在**。它们不代表历史某天当时已经知道这些事实，\n" +
      "所以 `as_known_then` 回放仍然不可用（见 deliverables/READINESS_REPLAY_COVERAGE.json）。\n"
    );
  }
} finally {
  handle.close();
}
