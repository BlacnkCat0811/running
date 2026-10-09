import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App.js";

// 合规回归防线：ICP 备案号与公安联网备案号必须同时悬挂在页面底部并各自链接到对应平台。
// 关键点是「无条件可见」——线上核查时 /v1/health 很可能因缺少 API 令牌而失败，
// 首页渲染的是 ErrorBlock 而不是正常内容，备案信息在那时同样必须出现。
// 两项备案互相独立、缺一即核查不通过，所以每条分支都同时断言两者。
const ICP_LICENSE = "粤ICP备2026134468号-1";
const POLICE_LICENSE = "粤公网安备44011802001569号";
const POLICE_LICENSE_URL =
  "https://beian.mps.gov.cn/#/query/webSearch?code=44011802001569";
const POLICE_LICENSE_ICON = "/assets/gongan-beian.png";

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

// 公安联网备案：链接指向平台查询页，且必须「图标在前、备案编号在右」。
const expectPoliceLicenseLink = async () => {
  const link = (await screen.findByText(POLICE_LICENSE)).closest("a");
  expect(link).toBeTruthy();
  expect(link?.getAttribute("href")).toBe(POLICE_LICENSE_URL);
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toContain("noreferrer");

  // 产物自洽：链接里的 code 必须与页面上展示的备案号数字一致（两个值都读自 DOM）。
  expect(link?.getAttribute("href")).toContain(
    (link?.textContent ?? "").replace(/\D/g, ""),
  );

  // 顺序断言落在产物 DOM 上，而不是常量或辅助函数上：首个子元素必须是图标。
  const icon = link?.querySelector("img");
  expect(icon).toBeTruthy();
  expect(icon?.getAttribute("src")).toBe(POLICE_LICENSE_ICON);
  expect(link?.firstElementChild?.tagName).toBe("IMG");
};

describe("SiteFooter 备案号悬挂", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("API 未授权、首页渲染错误块时仍悬挂两项备案号", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    renderApp("/");

    // 先确认确实处于错误分支（不是正常内容页），再断言备案号。
    expect(await screen.findByRole("link", { name: "配置令牌" })).toBeTruthy();
    await expectLicenseLink();
    await expectPoliceLicenseLink();
  });

  it("API 未授权、放行的 /settings 页面上悬挂两项备案号", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    renderApp("/settings");

    expect(await screen.findByText("API 访问令牌")).toBeTruthy();
    await expectLicenseLink();
    await expectPoliceLicenseLink();
  });

  it("数据库就绪的正常页面上悬挂两项备案号", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => healthy()));

    renderApp("/more");

    expect(await screen.findByRole("heading", { name: "更多" })).toBeTruthy();
    await expectLicenseLink();
    await expectPoliceLicenseLink();
  });
});
