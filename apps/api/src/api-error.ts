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
  const status = typeof providedStatus === "number" ? providedStatus : 500;
  return {
    status,
    body: {
      code: status >= 500
        ? "internal_error"
        : typeof providedCode === "string" && providedCode.length > 0
          ? providedCode
          : "request_error",
      message: status >= 500 ? "本地服务处理请求失败" : message
    }
  };
}
