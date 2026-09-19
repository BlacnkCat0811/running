import type { FastifyInstance } from "fastify";

/** A disconnected client does not cancel a server-side database operation. */
export function installMutationLifetime(
  app: FastifyInstance,
  release: (request: object) => void
): void {
  app.addHook("onRoute", (route) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      try { return await handler.call(this, request, reply); }
      finally { release(request); }
    };
  });
}
