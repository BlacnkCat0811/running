import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { installLocalRequestSecurity } from "../src/local-request-security.js";

test("unsafe requests reject DNS rebinding hosts and untrusted origins", async () => {
  const app = Fastify();
  installLocalRequestSecurity(app, {
    apiPort: 8787,
    developmentOrigins: new Set(["http://localhost:5173"])
  });
  app.post("/write", async () => ({ ok: true }));
  try {
    const rebinding = await app.inject({
      method: "POST",
      url: "/write",
      headers: { host: "attacker.example", origin: "http://attacker.example" }
    });
    assert.equal(rebinding.statusCode, 403);

    const forgedOrigin = await app.inject({
      method: "POST",
      url: "/write",
      headers: { host: "127.0.0.1:8787", origin: "http://attacker.example" }
    });
    assert.equal(forgedOrigin.statusCode, 403);

    const localPage = await app.inject({
      method: "POST",
      url: "/write",
      headers: { host: "127.0.0.1:8787", origin: "http://localhost:5173" }
    });
    assert.equal(localPage.statusCode, 200);

    const localCli = await app.inject({
      method: "POST",
      url: "/write",
      headers: { host: "localhost:8787" }
    });
    assert.equal(localCli.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("read requests do not require a local Host", async () => {
  const app = Fastify();
  installLocalRequestSecurity(app, { apiPort: 8787 });
  app.get("/read", async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({
      method: "GET",
      url: "/read",
      headers: { host: "docs.example" }
    })).statusCode, 200);
  } finally {
    await app.close();
  }
});
