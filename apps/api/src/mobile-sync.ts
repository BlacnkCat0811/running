import type { ImportJobResponse, MobileSyncStatus } from "@rai/api-contracts";

/**
 * The newest refresh the import worker knows about.
 *
 * Deliberately independent of training and recovery dates. An import that
 * completed with zero new records is a successful refresh; an import is never
 * "stale" because the runner did not wear a watch.
 */
export interface MobileRefreshOutcome {
  /** Outcome of the newest *completed* refresh, or `null` when none has finished. */
  lastCompleted: "ok" | "failed" | null;
  /** When the newest attempt started, whatever its state. */
  attemptedAt: string | null;
  /** The failure the worker recorded. Only meaningful for a failed attempt. */
  error: string | null;
}

/**
 * Reads a refresh outcome off an import job. In-flight and cancelled jobs
 * report no completed outcome rather than a failure: an import the runner
 * cancelled is not a broken sync, and the previous outcome still stands.
 */
export function mobileRefreshOutcome(job: ImportJobResponse | null): MobileRefreshOutcome | null {
  if (!job) return null;
  return {
    lastCompleted: job.status === "failed" ? "failed" : job.status === "succeeded" ? "ok" : null,
    attemptedAt: job.createdAt ?? null,
    error: job.status === "failed" ? job.error ?? null : null
  };
}

const atOrAfter = (left: string, right: string): boolean => {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return left >= right;
  return leftMs >= rightMs;
};

/**
 * Folds the refresh outcome together with the published-import record.
 *
 * The data database can only prove that a refresh *completed*: the import
 * writes `import_started_at` and `import_completed_at` into the staging copy,
 * and they become visible only when that copy is published. A failed attempt is
 * rolled back and leaves no trace there, so `failed` can only come from the
 * worker's job log. When that log is unavailable — a database imported straight
 * from the CLI, or a caller that never had a worker — this falls back to
 * `never`/`ok` and never claims a failure it cannot see.
 */
export function mobileSyncStatus(
  lastSuccessAt: string | null,
  outcome: MobileRefreshOutcome | null
): MobileSyncStatus {
  const status: MobileSyncStatus["status"] = (() => {
    if (outcome?.lastCompleted === "failed") {
      // A published import at or after the failed attempt means the refresh did
      // recover — a CLI import, a retry the log no longer holds, or a manual
      // re-import. Reporting the older failure would be the same class of
      // mistake as the stale-recovery warning this field replaced.
      if (lastSuccessAt != null && outcome.attemptedAt != null && atOrAfter(lastSuccessAt, outcome.attemptedAt)) {
        return "ok";
      }
      return "failed";
    }
    if (outcome?.lastCompleted === "ok") return "ok";
    return lastSuccessAt == null ? "never" : "ok";
  })();
  return {
    status,
    lastAttemptAt: outcome?.attemptedAt ?? lastSuccessAt,
    lastSuccessAt,
    error: status === "failed" ? outcome?.error ?? null : null
  };
}

/** A refusal to confirm a session, as the route should answer it. */
export interface MobileLockRejection {
  code: "mobile_refresh_failed" | "mobile_recommendation_stale";
  message: string;
}

/**
 * Which gate refuses a confirmation, in the order the runner should act on them.
 *
 * A failed refresh is reported first on purpose. Answering with the revision
 * conflict would tell the runner to re-read, and re-reading hands back the same
 * recommendation because nothing new was published — the resync instruction only
 * arrives on the second attempt. Checked against the refresh outcome rather than
 * a recovery date, so a night without a watch is never a reason to refuse.
 */
export function mobileLockRejection(input: {
  syncStatus: MobileSyncStatus["status"];
  recommendationRevision: string;
  // `| undefined` is explicit: the repo runs `exactOptionalPropertyTypes`, and a
  // caller passing `request.body.expectedRevision` hands over an explicit undefined.
  expectedRevision?: string | null | undefined;
}): MobileLockRejection | null {
  if (input.syncStatus === "failed") {
    return { code: "mobile_refresh_failed", message: "上次同步健康数据失败，请重新同步后再确认安排" };
  }
  if (input.expectedRevision && input.expectedRevision !== input.recommendationRevision) {
    return { code: "mobile_recommendation_stale", message: "今日建议已更新，请重新查看后再确认安排" };
  }
  return null;
}
