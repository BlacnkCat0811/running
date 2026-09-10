import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, applyApiToken, readApiToken, writeApiToken } from "../src/api.js";

const okResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe("browser API token", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("trims the token on write and clears it on blank input", () => {
    expect(readApiToken()).toBe("");
    writeApiToken("  abc123  ");
    expect(readApiToken()).toBe("abc123");
    writeApiToken("   ");
    expect(readApiToken()).toBe("");
  });

  it("attaches a bearer header to API requests", async () => {
    writeApiToken("secret");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await api<{ ok: boolean }>("/v1/health");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("leaves requests unauthenticated when no token is stored", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await api<{ ok: boolean }>("/v1/health");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("does not overwrite an explicit authorization header", () => {
    writeApiToken("stored");
    const headers = new Headers({ authorization: "Bearer caller" });
    applyApiToken(headers);
    expect(headers.get("authorization")).toBe("Bearer caller");
  });

  it("adds the stored token to a bare header set", () => {
    writeApiToken("stored");
    const headers = new Headers();
    applyApiToken(headers);
    expect(headers.get("authorization")).toBe("Bearer stored");
  });
});
