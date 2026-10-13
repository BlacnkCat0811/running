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
      code: status >= 500 && !["plan_snapshot_changed", "plan_operations_unavailable"].includes(String(providedCode))
        ? "internal_error"
        : typeof providedCode === "string" && providedCode.length > 0
          ? providedCode
          : "request_error",
      message: status >= 500 && !["plan_snapshot_changed", "plan_operations_unavailable"].includes(String(providedCode)) ? "本地服务处理请求失败" : message
    }
  };
}
