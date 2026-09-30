import type { DatabaseSync } from "node:sqlite";

import { DATABASE_TIMEZONE, healthTypes } from "@rai/contracts";
import { canonicalizeNights } from "@rai/health-export-parser";

/**
 * `canonical_nights` / `canonical_hrv_days` 的**空表回填**。
 *
 * 为什么这是一个真实的缺口，而不是"顺手加个工具"：
 * - `docs/DATA_PIPELINE.md`（v17 迁移策略）写明回填有两条路：下一次 CLI import，
 *   或 `recoverDatabaseJobs` 在 `RaiDatabase.open` 之后发现"夜表为空且存在睡眠行"时调用
 *   `canonicalizeNights`。**第二条从未接线** —— 仓库里 `canonicalizeNights` 的唯一调用点是
 *   `packages/health-export-parser/src/cli.ts`。
 * - 后果是可观测的：本机 `var/rai.sqlite` 有 **5222 行睡眠段、684 行 HRV**，
 *   而 `canonical_nights` / `canonical_hrv_days` **各 0 行**。于是整条 Readiness 链路
 *   （§7 的 P0 目标）在这份库上永远只能拿到 `coverage: none`。
 *
 * 本函数把回填做成**有守卫、幂等、可观察**的动作：
 * - 夜表非空 ⇒ `not_needed`（不重算，避免每次启动都付代价）；
 * - 没有睡眠行 ⇒ `no_sleep_records`（没有可建的事实，不谎报成功）；
 * - 否则调用既有的 `canonicalizeNights` 并**原样返回它的计数**。
 *
 * 这里不接进 API 启动路径：那条路径的失败语义是 `databaseRecoveryRequired`（整个 API 拒绝就绪），
 * 对一次可重试的回填来说代价过高。是否接线应当单独决策，见交付记录。
 */

export interface CanonicalNightsBackfillResult {
  status: "not_needed" | "no_sleep_records" | "backfilled";
  timezoneIdentifier: string;
  before: { nights: number; hrvDays: number; sleepRecords: number; hrvRecords: number };
  after: { nights: number; hrvDays: number; sleepRecords: number; hrvRecords: number };
  canonicalization: { mainCount: number; napCount: number; hrvCount: number; rejectedInBedOnly: number } | null;
}

export function backfillCanonicalNights(
  database: DatabaseSync,
  timezone: string = DATABASE_TIMEZONE
): CanonicalNightsBackfillResult {
  if (typeof timezone !== "string" || timezone === "") throw new Error("A timezone is required");
  const count = (sql: string, ...params: Array<string | number>): number =>
    Number((database.prepare(sql).get(...params) as { n?: number } | undefined)?.n ?? 0);
  const snapshot = () => ({
    nights: count("SELECT COUNT(1) AS n FROM canonical_nights"),
    hrvDays: count("SELECT COUNT(1) AS n FROM canonical_hrv_days"),
    sleepRecords: count("SELECT COUNT(1) AS n FROM health_records WHERE type=?", healthTypes.sleepAnalysis),
    hrvRecords: count("SELECT COUNT(1) AS n FROM health_records WHERE type=?", healthTypes.hrvSdnn)
  });
  const before = snapshot();
  if (before.nights > 0) {
    return { status: "not_needed", timezoneIdentifier: timezone, before, after: before, canonicalization: null };
  }
  if (before.sleepRecords === 0) {
    return { status: "no_sleep_records", timezoneIdentifier: timezone, before, after: before, canonicalization: null };
  }
  const result = canonicalizeNights(database, timezone);
  const after = snapshot();
  // 回填声称成功就必须真的产生了行；否则调用方会以为 Readiness 有事实可用。
  if (after.nights === 0) {
    throw new Error("Canonicalization produced no nights from existing sleep records");
  }
  return {
    status: "backfilled",
    timezoneIdentifier: timezone,
    before,
    after,
    canonicalization: {
      mainCount: result.mainCount,
      napCount: result.napCount,
      hrvCount: result.hrvCount,
      rejectedInBedOnly: result.rejectedInBedOnly
    }
  };
}
