import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { MutationCoordinator, MutationConflictError } from "../src/mutation-coordinator.js";
import { installMutationLifetime } from "../src/request-mutation-lifetime.js";

test("disconnecting a client does not release its still-running database operation", async () => {
  const app = Fastify();
  const mutations = new MutationCoordinator();
  const releases = new WeakMap<object, () => void>();
  const release = (request: object) => { releases.get(request)?.(); releases.delete(request); };
  installMutationLifetime(app, release);
  app.addHook("preHandler", async (request) => { releases.set(request, mutations.acquire("HTTP writer")); });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  app.post("/slow", async () => { began(); await pending; return { ok: true }; });
  app.post("/error", async () => { throw new Error("fixture"); });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const client = request(`${address}/slow`, { method: "POST" });
    client.on("error", () => {});
    client.end();
    await started;
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.throws(() => mutations.acquire("import"), MutationConflictError);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 30));
    mutations.acquire("after handler")();
    const failed = await app.inject({ method: "POST", url: "/error" });
    assert.equal(failed.statusCode, 500);
    mutations.acquire("after failure")();
  } finally { finish(); await app.close(); }
});
