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
