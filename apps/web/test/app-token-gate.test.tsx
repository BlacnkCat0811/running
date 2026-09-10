import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App.js";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const unauthorized = () =>
  jsonResponse(401, { code: "unauthorized", message: "需要有效的 API Token" });

const renderApp = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

describe("App API token gate", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("offers a token entry point when the API rejects unauthenticated requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    renderApp("/");

    expect(await screen.findByRole("link", { name: "配置令牌" })).toBeTruthy();
  });

  it("renders the settings page at /settings even though /v1/health is unauthorized", async () => {
    // 回归防线：App 在 health 失败时若不放行 /settings，用户点「配置令牌」只会
    // 改变 URL 而看不到任何变化，等于没有任何配置入口。
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    renderApp("/settings");

    expect(await screen.findByText("API 访问令牌")).toBeTruthy();
  });

  it("reaches the token panel after clicking the entry point", async () => {
    // 复现真实操作：从错误块点「配置令牌」后必须真的看到设置面板。
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    renderApp("/");

    fireEvent.click(await screen.findByRole("link", { name: "配置令牌" }));

    expect(await screen.findByText("API 访问令牌")).toBeTruthy();
  });
});
