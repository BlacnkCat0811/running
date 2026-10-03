export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
  }
}

const TOKEN_STORAGE_KEY = "rai.web.apiToken";
const TOKEN_CHANGED_EVENT = "rai:api-token-changed";

export function subscribeApiToken(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === TOKEN_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(TOKEN_CHANGED_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TOKEN_CHANGED_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * 桌面浏览器直连云端 API 时使用的令牌。
 *
 * iOS 壳（WKWebView）不依赖这里：AppWebView 注入的 fetch/XHR 包装器会在传输层
 * 直接补 Authorization，因此壳场景下 localStorage 保持为空即可。若两者同时存在，
 * applyApiToken 先写入，壳的包装器检测到已有请求头便不再覆盖，行为一致。
 */
export function readApiToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeApiToken(token: string): void {
  try {
    const value = token.trim();
    if (value) localStorage.setItem(TOKEN_STORAGE_KEY, value);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // 隐私模式等存储不可用时静默降级：请求退回无令牌状态，由页面提示引导用户。
  }
  window.dispatchEvent(new Event(TOKEN_CHANGED_EVENT));
}

export function applyApiToken(headers: Headers): void {
  if (headers.has("authorization")) return;
  const token = readApiToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  applyApiToken(headers);
  const response = await fetch(path, {
    ...init,
    headers
  });
  const body = (await response.json().catch(() => ({}))) as { message?: string } & T;
  if (!response.ok) throw new ApiError(body.message ?? "请求失败", response.status, body);
  return body;
}
