import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App.js";

// 合规回归防线：ICP 备案号必须悬挂在页面底部并链接工信部。
// 关键点是「无条件可见」——线上核查时 /v1/health 很可能因缺少 API 令牌而失败，
// 首页渲染的是 ErrorBlock 而不是正常内容，备案号在那时同样必须出现。
const ICP_LICENSE = "粤ICP备2026134468号-1";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const unauthorized = () =>
  jsonResponse(401, { code: "unauthorized", message: "需要有效的 API Token" });

const healthy = () =>
  jsonResponse(200, {
    status: "ok",
    databaseReady: true,
    localOnly: true,
    serverId: "test",
    athleteId: "test",
    datasetEpoch: "1",
    syncProtocolVersion: 1,
    now: new Date().toISOString(),
  });

const renderApp = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

const expectLicenseLink = async () => {
  const link = (await screen.findByText(ICP_LICENSE)).closest("a");
  expect(link).toBeTruthy();
  expect(link?.getAttribute("href")).toBe("https://beian.miit.gov.cn/");
  expect(link?.getAttribute("target")).toBe("_blank");
};

describe("SiteFooter ICP 备案号", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("API 未授权、首页渲染错误块时仍悬挂备案号", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    renderApp("/");

    // 先确认确实处于错误分支（不是正常内容页），再断言备案号。
    expect(await screen.findByRole("link", { name: "配置令牌" })).toBeTruthy();
    await expectLicenseLink();
  });

  it("API 未授权、放行的 /settings 页面上悬挂备案号", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    renderApp("/settings");

    expect(await screen.findByText("API 访问令牌")).toBeTruthy();
    await expectLicenseLink();
  });

  it("数据库就绪的正常页面上悬挂备案号", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => healthy()));

    renderApp("/more");

    expect(await screen.findByRole("heading", { name: "更多" })).toBeTruthy();
    await expectLicenseLink();
  });
});
