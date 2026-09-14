import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import {
  installLocalRequestSecurity,
  isPrivateIPv4,
  isPrivateLanHttpOrigin
} from "../src/local-request-security.js";

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

test("read requests reject DNS rebinding hosts", async () => {
  const app = Fastify();
  installLocalRequestSecurity(app, { apiPort: 8787 });
  app.get("/read", async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({
      method: "GET",
      url: "/read",
      headers: { host: "docs.example" }
    })).statusCode, 403);
    assert.equal((await app.inject({
      method: "GET",
      url: "/read",
      headers: { host: "localhost:8787" }
    })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("private IPv4 detection only accepts RFC1918 and loopback", () => {
  assert.equal(isPrivateIPv4("192.168.126.130"), true);
  assert.equal(isPrivateIPv4("10.0.0.8"), true);
  assert.equal(isPrivateIPv4("172.16.0.1"), true);
  assert.equal(isPrivateIPv4("172.31.255.255"), true);
  assert.equal(isPrivateIPv4("127.0.0.1"), true);
  assert.equal(isPrivateIPv4("172.15.0.1"), false);
  assert.equal(isPrivateIPv4("8.8.8.8"), false);
  assert.equal(isPrivateIPv4("192.168.1"), false);
  assert.equal(isPrivateIPv4("192.168.1.256"), false);
  assert.equal(isPrivateLanHttpOrigin("http://192.168.126.130:5173", 5173), true);
  assert.equal(isPrivateLanHttpOrigin("http://192.168.126.130:5173", 8787), false);
  assert.equal(isPrivateLanHttpOrigin("https://192.168.126.130:5173", 5173), false);
  assert.equal(isPrivateLanHttpOrigin("http://8.8.8.8:5173", 5173), false);
});

test("LAN development origin is opt-in for device debugging", async () => {
  const app = Fastify();
  installLocalRequestSecurity(app, {
    apiPort: 8787,
    developmentOrigins: new Set(["http://localhost:5173"]),
    allowPrivateLanWebPort: 5173
  });
  app.post("/write", async () => ({ ok: true }));
  try {
    const lanPage = await app.inject({
      method: "POST",
      url: "/write",
      headers: { host: "127.0.0.1:8787", origin: "http://192.168.126.130:5173" }
    });
    assert.equal(lanPage.statusCode, 200);

    const publicOrigin = await app.inject({
      method: "POST",
      url: "/write",
      headers: { host: "127.0.0.1:8787", origin: "http://8.8.8.8:5173" }
    });
    assert.equal(publicOrigin.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("LAN development origin stays rejected without the opt-in", async () => {
  const app = Fastify();
  installLocalRequestSecurity(app, {
    apiPort: 8787,
    developmentOrigins: new Set(["http://localhost:5173"])
  });
  app.post("/write", async () => ({ ok: true }));
  try {
    const lanPage = await app.inject({
      method: "POST",
      url: "/write",
      headers: { host: "127.0.0.1:8787", origin: "http://192.168.126.130:5173" }
    });
    assert.equal(lanPage.statusCode, 403);
  } finally {
    await app.close();
  }
});

// The five tests above all run without `apiToken` and use non-`/v1/` paths, so
// they exercise the origin rules only. The token branch below is the sole access
// control for every data route, and nothing covered it before.
test("the API token gates every /v1/ route and nothing else", async () => {
  const app = Fastify();
  installLocalRequestSecurity(app, { apiPort: 8787, apiToken: "s3cret" });
  app.get("/v1/read", async () => ({ ok: true }));
  app.post("/v1/write", async () => ({ ok: true }));
  app.get("/outside", async () => ({ ok: true }));
  const local = { host: "127.0.0.1:8787" };
  try {
    assert.equal((await app.inject({
      method: "GET", url: "/v1/read", headers: { ...local, authorization: "Bearer s3cret" }
    })).statusCode, 200);
    assert.equal((await app.inject({
      method: "POST", url: "/v1/write", headers: { ...local, authorization: "Bearer s3cret" }
    })).statusCode, 200);

    const missing = await app.inject({ method: "GET", url: "/v1/read", headers: local });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().code, "unauthorized");

    const wrong = await app.inject({
      method: "GET", url: "/v1/read", headers: { ...local, authorization: "Bearer wrong" }
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().code, "unauthorized");

    // A query parameter is not a credential — the token must stay out of URLs
    // that end up in logs and browser history.
    assert.equal((await app.inject({
      method: "GET", url: "/v1/read?token=s3cret", headers: local
    })).statusCode, 401);

    // Only the `/v1/` prefix is token-gated; a lookalike path falls through to
    // the origin rules, which reject an unauthenticated request.
    assert.equal((await app.inject({
      method: "GET", url: "/v1read", headers: local
    })).statusCode, 403);

    // Non-`/v1/` routes are not token-gated, but once a token is configured a
    // request with no Origin and no bearer is still refused (`isTrustedUnsafeRequest`
    // returns false). In the deployed topology Nginx serves the static shell, so
    // this only surfaces when connecting to the API port directly.
    assert.equal((await app.inject({
      method: "GET", url: "/outside", headers: local
    })).statusCode, 403);
    assert.equal((await app.inject({
      method: "GET", url: "/outside", headers: { ...local, origin: "http://localhost:8787" }
    })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("authenticated remote access still checks the configured origins", async () => {
  const app = Fastify();
  installLocalRequestSecurity(app, {
    apiPort: 8787,
    apiToken: "s3cret",
    allowAuthenticatedRemote: true,
    trustedOrigins: new Set(["https://rai.example"])
  });
  app.get("/v1/read", async () => ({ ok: true }));
  const auth = { authorization: "Bearer s3cret" };
  try {
    // No Origin (native client / curl) and a trusted Origin both pass.
    assert.equal((await app.inject({ method: "GET", url: "/v1/read", headers: auth })).statusCode, 200);
    assert.equal((await app.inject({
      method: "GET", url: "/v1/read", headers: { ...auth, origin: "https://rai.example" }
    })).statusCode, 200);

    // A valid token from an untrusted origin is still refused.
    const blocked = await app.inject({
      method: "GET", url: "/v1/read", headers: { ...auth, origin: "https://evil.example" }
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().code, "untrusted_origin");
  } finally {
    await app.close();
  }
});
