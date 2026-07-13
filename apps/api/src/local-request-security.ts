import type { FastifyInstance } from "fastify";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface LocalRequestSecurityOptions {
  apiPort: number;
  developmentOrigins?: ReadonlySet<string>;
}

export function isTrustedUnsafeRequest(
  method: string,
  host: string | undefined,
  origin: string | undefined,
  options: LocalRequestSecurityOptions
): boolean {
  if (!unsafeMethods.has(method)) return true;
  const trustedHosts = new Set([
    `127.0.0.1:${options.apiPort}`,
    `localhost:${options.apiPort}`
  ]);
  if (!host || !trustedHosts.has(host.toLowerCase())) return false;
  if (!origin) return true;
  const trustedOrigins = new Set([
    `http://127.0.0.1:${options.apiPort}`,
    `http://localhost:${options.apiPort}`,
    ...(options.developmentOrigins ?? [])
  ]);
  return trustedOrigins.has(origin);
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
      message: "拒绝来自非本地页面的写请求"
    });
  });
}
