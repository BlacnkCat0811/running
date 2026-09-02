import type { FastifyInstance } from "fastify";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface LocalRequestSecurityOptions {
  apiPort: number;
  developmentOrigins?: ReadonlySet<string>;
  allowPrivateLanWebPort?: number;
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
