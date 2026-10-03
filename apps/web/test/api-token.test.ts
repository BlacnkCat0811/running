import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, cleanup, renderHook } from "@testing-library/react";
import { api, applyApiToken, readApiToken, writeApiToken } from "../src/api.js";
import { useApiToken } from "../src/api-token.js";

const okResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe("browser API token", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("updates mounted consumers on save, replacement and removal", () => {
    const { result } = renderHook(useApiToken);
    expect(result.current).toBe("");
    act(() => writeApiToken("first"));
    expect(result.current).toBe("first");
    act(() => writeApiToken("second"));
    expect(result.current).toBe("second");
    act(() => writeApiToken(""));
    expect(result.current).toBe("");
  });

  it("updates mounted consumers on another tab's storage events", () => {
    const { result } = renderHook(useApiToken);
    act(() => {
      localStorage.setItem("rai.web.apiToken", "other-tab");
      window.dispatchEvent(new StorageEvent("storage", { key: "rai.web.apiToken" }));
    });
    expect(result.current).toBe("other-tab");
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current).toBe("");
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
