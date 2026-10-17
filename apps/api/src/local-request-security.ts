import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/// 写方法的唯一定义（2026-10-15 审查 D-🔡6）：`server.ts` 的路由准入守卫与这里的
/// 鉴权 hook 必须对"什么算写"保持同一口径 —— 此前两处各声明一份相同字面量。
export const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const safeMethods = new Set(["GET", "HEAD"]);

/**
 * 常量时间 token 比较（2026-10-15 审查 🟡-D1）。
 *
 * JS 的 `===` 在首个不同字符处短路 ⇒ 存在逐字符计时预言机（局域网抖动低时可被利用）。
 * 先对两端各取 SHA-256 定长摘要、再 `timingSafeEqual`，长度差与内容差都不再泄漏到
 * 比较耗时上；原始长度相等作为第二判据（摘要相等已隐含，保留它是显式契约）。
 * 任何一侧缺失（未配置 token / 无 Authorization 头）一律 false。
 */
export function constantTimeTokenEquals(provided: string | undefined, expected: string | undefined): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && provided.length === expected.length;
}

export interface LocalRequestSecurityOptions {
  apiPort: number;
  apiToken?: string;
  developmentOrigins?: ReadonlySet<string>;
  allowPrivateLanWebPort?: number;
  allowAuthenticatedRemote?: boolean;
  trustedOrigins?: ReadonlySet<string>;
  /**
   * Mounted route patterns — Fastify spelling, `:param` included — that an
   * unauthenticated caller is allowed to read.
   *
   * Absent or empty means the old behaviour: every `/v1/` route needs the token.
   */
  publicReadRoutes?: ReadonlySet<string>;
  /**
   * Hosts whose unauthenticated reads of `publicReadRoutes` are accepted.
   *
   * This is not a convenience. The deployed topology terminates TLS on Nginx,
   * which forwards `Host: tpandmr.xyz`, so an anonymous GET that fell through to
   * `isTrustedUnsafeRequest` would be refused with 403 — opening reads requires
   * naming the public host explicitly, and that name is also what keeps the
   * DNS-rebinding rule below from degenerating into "accept any Host".
   */
  publicReadHosts?: ReadonlySet<string>;
}

/**
 * The `Host` header without its port, lower-cased.
 *
 * Nginx forwards `$host`, which carries no port; a direct caller may keep it.
 * Both spellings have to match the same allow-list entry.
 */
export function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;
  // IPv6 literals arrive as `[::1]:8787`; the brackets are part of the host.
  const withoutPort = trimmed.startsWith("[")
    ? trimmed.slice(0, trimmed.indexOf("]") + 1)
    : trimmed.replace(/:\d+$/, "");
  if (!withoutPort || withoutPort === "[") return null;
  return withoutPort;
}

/**
 * Whether this request may read without a token.
 *
 * All four conditions are required: a safe method, a route that is explicitly
 * listed, a host that is explicitly listed, and a route the router actually
 * resolved (an unmatched URL leaves `routeUrl` undefined and is never public).
 */
export function isAnonymousPublicRead(
  method: string,
  host: string | undefined,
  routeUrl: string | undefined,
  options: Pick<LocalRequestSecurityOptions, "publicReadRoutes" | "publicReadHosts">
): boolean {
  if (!safeMethods.has(method)) return false;
  if (routeUrl === undefined || !options.publicReadRoutes?.has(routeUrl)) return false;
  const hostname = hostnameOf(host);
  if (hostname === null) return false;
  return options.publicReadHosts?.has(hostname) ?? false;
}

export function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) return false;
  if (first === 127 || first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return false;
}

export function isPrivateLanHttpOrigin(origin: string, webPort: number): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.username || url.password) return false;
  const port = url.port === "" ? 80 : Number(url.port);
  if (port !== webPort) return false;
  return url.hostname === "localhost" || isPrivateIPv4(url.hostname);
}

export function isTrustedDevelopmentOrigin(
  origin: string,
  options: Pick<LocalRequestSecurityOptions, "developmentOrigins" | "allowPrivateLanWebPort" | "apiPort">
): boolean {
  const trustedOrigins = new Set([
    `http://127.0.0.1:${options.apiPort}`,
    `http://localhost:${options.apiPort}`,
    ...(options.developmentOrigins ?? [])
  ]);
  if (trustedOrigins.has(origin)) return true;
  return options.allowPrivateLanWebPort != null
    && isPrivateLanHttpOrigin(origin, options.allowPrivateLanWebPort);
}

export function isTrustedUnsafeRequest(
  method: string,
  host: string | undefined,
  origin: string | undefined,
  options: LocalRequestSecurityOptions
): boolean {
  if (options.apiToken && options.allowAuthenticatedRemote && origin && options.trustedOrigins?.has(origin)) {
    return true;
  }
  if (options.apiToken && options.allowAuthenticatedRemote && !origin) return true;
  if (options.apiToken && origin === undefined) return false;
  const trustedHosts = new Set([
    `127.0.0.1:${options.apiPort}`,
    `localhost:${options.apiPort}`
  ]);
  if (!host || !trustedHosts.has(host.toLowerCase())) return false;
  if (!unsafeMethods.has(method)) return true;
  if (!origin) return true;
  return isTrustedDevelopmentOrigin(origin, options);
}

export function installLocalRequestSecurity(
  app: FastifyInstance,
  options: LocalRequestSecurityOptions
): void {
  app.addHook("onRequest", async (request, reply) => {
    if (options.apiToken && (
      request.routeOptions.url?.startsWith("/v1/") ||
      (request.url.split("?", 1)[0] ?? "").startsWith("/v1/")
    )) {
      const authorization = request.headers.authorization;
      if (constantTimeTokenEquals(authorization, `Bearer ${options.apiToken}`)) {
        if (options.allowAuthenticatedRemote) {
          const origin = request.headers.origin;
          if (!origin || options.trustedOrigins?.has(origin)) return;
          return reply.code(403).send({ code: "untrusted_origin", message: "拒绝来自未配置来源的请求" });
        }
        return;
      }
      // A token-less read of a listed route, from a listed host, is the
      // anonymous-read case (introduced for the retired Web SPA) and is
      // answered here. Everything else — every write, every unlisted read,
      // every other Host — still lands on the 401 below, so widening reads
      // cannot widen writes.
      if (isAnonymousPublicRead(request.method, request.headers.host, request.routeOptions.url, options)) return;
      return reply.code(401).send({ code: "unauthorized", message: "需要有效的 API Token" });
    }
    if (isTrustedUnsafeRequest(
      request.method,
      request.headers.host,
      request.headers.origin,
      options
    )) return;
    return reply.code(403).send({
      code: "untrusted_origin",
      message: "拒绝来自非本地页面的请求"
    });
  });
}
