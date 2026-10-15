import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import {
  constantTimeTokenEquals,
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
// control for every data route, and nothing covered it before. Anonymous reads
// are covered separately, further down, and are off unless a public host list
// is supplied.
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

test("anonymous reads open only for the listed routes on the listed hosts", async () => {
  const app = Fastify();
  installLocalRequestSecurity(app, {
    apiPort: 8787,
    apiToken: "s3cret",
    publicReadRoutes: new Set(["/v1/dashboard", "/v1/jobs/:id"]),
    publicReadHosts: new Set(["rai.example"])
  });
  app.get("/v1/dashboard", async () => ({ ok: true }));
  app.get("/v1/jobs/:id", async () => ({ ok: true }));
  app.get("/v1/backups", async () => ({ ok: true }));
  app.post("/v1/dashboard", async () => ({ ok: true }));
  // The Host Nginx forwards for a public read, and the Host it forwards when the
  // request came in on some other name entirely (a scanner, or a DNS-rebinding
  // page resolving its own hostname to this address).
  const publicHost = { host: "rai.example" };
  const otherHost = { host: "attacker.example" };
  try {
    assert.equal((await app.inject({ method: "GET", url: "/v1/dashboard", headers: publicHost })).statusCode, 200);
    // `:param` routes are matched by the router, so the listed pattern — not the
    // concrete URL — is what the allow-list is compared against.
    assert.equal((await app.inject({ method: "GET", url: "/v1/jobs/job-1", headers: publicHost })).statusCode, 200);

    // A listed host does not open an unlisted route.
    const unlisted = await app.inject({ method: "GET", url: "/v1/backups", headers: publicHost });
    assert.equal(unlisted.statusCode, 401);
    assert.equal(unlisted.json().code, "unauthorized");

    // An unlisted host does not open a listed route. This is the check that
    // would be lost by simply deleting the Host rule instead of narrowing it.
    assert.equal((await app.inject({ method: "GET", url: "/v1/dashboard", headers: otherHost })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/v1/dashboard" })).statusCode, 401);

    // A write on a publicly readable path is still a write.
    assert.equal((await app.inject({ method: "POST", url: "/v1/dashboard", headers: publicHost })).statusCode, 401);

    // And the token keeps working everywhere, including on the public route.
    assert.equal((await app.inject({
      method: "GET", url: "/v1/dashboard", headers: { ...publicHost, authorization: "Bearer s3cret" }
    })).statusCode, 200);
    assert.equal((await app.inject({
      method: "POST", url: "/v1/dashboard", headers: { ...publicHost, authorization: "Bearer s3cret" }
    })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("without a public host list nothing is readable without a token", async () => {
  // The code default. A deployment that forgets `RAI_PUBLIC_HOSTS` must fail
  // closed rather than fall through to the origin rules, which would otherwise
  // accept a request whose Host happens to be a loopback name.
  const app = Fastify();
  installLocalRequestSecurity(app, {
    apiPort: 8787,
    apiToken: "s3cret",
    publicReadRoutes: new Set(["/v1/dashboard"])
  });
  app.get("/v1/dashboard", async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({
      method: "GET", url: "/v1/dashboard", headers: { host: "rai.example" }
    })).statusCode, 401);
    assert.equal((await app.inject({
      method: "GET", url: "/v1/dashboard", headers: { host: "localhost:8787" }
    })).statusCode, 401);
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

test("constantTimeTokenEquals matches the exact token and rejects missing, partial and length-variant input", () => {
  // 2026-10-15（审查 🟡-D1）：五处 token 比较收敛到这个常量时间实现。
  // 语义必须与原来的 `===` 完全一致 —— 只是不再在首字符处短路。
  assert.equal(constantTimeTokenEquals("Bearer s3cret", "Bearer s3cret"), true);
  assert.equal(constantTimeTokenEquals(undefined, "Bearer s3cret"), false);
  assert.equal(constantTimeTokenEquals("Bearer s3cret", undefined), false);
  // 单字符差（前缀相同、不同字符出现的位置不同）都必须拒绝：
  assert.equal(constantTimeTokenEquals("Bearer s3crey", "Bearer s3cret"), false);
  assert.equal(constantTimeTokenEquals("Xearer s3cret", "Bearer s3cret"), false);
  // 长度不同不得因"摘要先截断"之类的原因误判相等：
  assert.equal(constantTimeTokenEquals("Bearer s3cret-extra", "Bearer s3cret"), false);
  assert.equal(constantTimeTokenEquals("Bearer s3cre", "Bearer s3cret"), false);
  // 空串相等是纯函数的边界事实（调用方负责在比较前先挡"未配置 token"：
  // `!apiToken || ...` 的短路仍在，见 server.ts / installLocalRequestSecurity 的调用点）。
  assert.equal(constantTimeTokenEquals("", ""), true);
});
