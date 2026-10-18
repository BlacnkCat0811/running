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

export function apiErrorPayload(error: unknown): ApiErrorPayload {
  const message = error instanceof Error ? error.message : String(error);
  const providedStatus = (error as { statusCode?: unknown } | null)?.statusCode;
  const providedCode = (error as { code?: unknown } | null)?.code;
  const status = typeof providedStatus === "number" && Number.isInteger(providedStatus) &&
    providedStatus >= 400 && providedStatus <= 599 ? providedStatus : 500;
  return {
    status,
    body: {
      code: status >= 500 && !["plan_snapshot_changed", "plan_operations_unavailable", "coach_snapshot_changed", "database_busy"].includes(String(providedCode))
        ? "internal_error"
        : typeof providedCode === "string" && providedCode.length > 0
          ? providedCode
          : "request_error",
      message: status >= 500 && !["plan_snapshot_changed", "plan_operations_unavailable", "coach_snapshot_changed", "database_busy"].includes(String(providedCode)) ? "本地服务处理请求失败" : message
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
