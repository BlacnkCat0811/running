/** Stable maintenance errors; internal exceptions remain redacted by apiErrorPayload. */
export class ClientRequestError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: 400 | 404 | 409 | 410) {
    super(message);
    this.name = "ClientRequestError";
  }
}

export interface ApiErrorPayload {
  status: number;
  body: {
    code: string;
    message: string;
  };
}

/**
 * 5xx domain codes whose code and message are safe to return verbatim.
 *
 * Everything else at ≥500 is redacted to `internal_error` /
 * "本地服务处理请求失败": an unexpected exception's message may contain SQL,
 * file paths, schema details or a stack. The codes below are deliberately
 * authored outcomes whose message is written for a human (`error.message` is
 * the designed text, not an internal diagnostic):
 *
 * - transient outcomes the client is told to retry — `plan_snapshot_changed`,
 *   `coach_snapshot_changed`, `database_busy`, `plan_operations_unavailable`
 *   (`retryAfterSeconds` gives the retry hint for the first three);
 * - `restore_recovery_required` (503): a restore/delete failed in a way that
 *   needs a restart; the message is the operator's only actionable hint, and
 *   without this entry it was replaced by the generic line;
 * - `plan_operation_status_unknown` (500): a broken server invariant, but the
 *   message names the row/status that failed — exactly what a support report
 *   needs, and it contains no user data or server internals.
 *
 * Review P3-16. Add a code here only when both conditions hold: the message is
 * authored text (never interpolated internals) and exposing it is useful to the
 * caller/operator.
 */
const EXPOSED_SERVER_ERROR_CODES: ReadonlySet<string> = new Set([
  "plan_snapshot_changed",
  "plan_operations_unavailable",
  "coach_snapshot_changed",
  "database_busy",
  "restore_recovery_required",
  "plan_operation_status_unknown"
]);

export function apiErrorPayload(error: unknown): ApiErrorPayload {
  const message = error instanceof Error ? error.message : String(error);
  const providedStatus = (error as { statusCode?: unknown } | null)?.statusCode;
  const providedCode = (error as { code?: unknown } | null)?.code;
  const status = typeof providedStatus === "number" && Number.isInteger(providedStatus) &&
    providedStatus >= 400 && providedStatus <= 599 ? providedStatus : 500;
  const namedCode = typeof providedCode === "string" && providedCode.length > 0 ? providedCode : null;
  // 4xx are client-visible by construction; 5xx only when the code is a
  // deliberately exposed domain outcome (see above).
  const exposeDetail = status < 500 || (namedCode !== null && EXPOSED_SERVER_ERROR_CODES.has(namedCode));
  return {
    status,
    body: {
      code: exposeDetail
        ? namedCode ?? "request_error"
        : "internal_error",
      message: exposeDetail ? message : "本地服务处理请求失败"
    }
  };
}

/**
 * `Retry-After` for transient, self-describing errors.
 *
 * Snapshot-changed responses mean a publication committed between two reads of
 * the same snapshot: the request is safe to retry immediately, so clients get an
 * explicit one-second hint instead of guessing a backoff (review P2-6). Rate
 * limiting keeps its existing five-second hint; everything else stays headerless
 * because a generic outage is not evidence that one second is enough.
 */
export function retryAfterSeconds(payload: ApiErrorPayload): "1" | "5" | null {
  if (payload.status === 429) return "5";
  if (payload.status === 503 &&
      (payload.body.code === "plan_snapshot_changed" || payload.body.code === "coach_snapshot_changed" ||
        payload.body.code === "database_busy")) {
    // `database_busy` is a short control-database lock, same one-second scale.
    return "1";
  }
  return null;
}
