export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
  const body = (await response.json().catch(() => ({}))) as { message?: string } & T;
  if (!response.ok) throw new ApiError(body.message ?? "请求失败", response.status, body);
  return body;
}
