import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShareCardResponse } from "@rai/api-contracts";

/**
 * V01–V03 on the rendering side: the card draws exactly the polylines the server
 * sent. It must not re-join them (that would draw the chord through a privacy
 * zone), and it must report whether the route was filtered at all.
 */
const useRemoteMock = vi.hoisted(() => vi.fn());
vi.mock("../src/hooks.js", () => ({ useRemote: useRemoteMock }));
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/api.js")>(), api: apiMock
}));

import { ShareCardPanel } from "../src/components/ShareCardPanel.js";
import { writeApiToken } from "../src/api.js";
import { notifyDataUpdated, notifyDatabaseStateChanged, notifyPrivacyZonesChanged } from "../src/events.js";

beforeEach(() => {
  vi.clearAllMocks();
  // The card carries route geometry, so the panel deliberately refuses to fetch
  // without a token; the test has to look like a configured browser.
  localStorage.setItem("rai.web.apiToken", "test-token");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The panel is on-demand by design: open it before asserting on the payload. */
function openPanel(): void {
  fireEvent.click(screen.getByRole("button", { name: /生成分享卡片/ }));
}

const remote = (data: unknown) => ({
  data,
  error: null,
  loading: false,
  dataPath: "/v1/workouts/session_1/share-card",
  reload: vi.fn(async () => true)
});

const card = (overrides: Partial<ShareCardResponse> = {}): ShareCardResponse => ({
  trainingSessionId: "session_1",
  generatedAt: "2026-10-02T00:00:00.000Z",
  privacy: {
    policyVersion: "rai-share-card-v1",
    zonesApplied: 1,
    redactedPoints: 12,
    gaps: 1,
    unfiltered: false
  },
  workout: {
    startedAt: "2026-10-01T10:00:00.000Z",
    sessionType: "tempo",
    distanceKm: 10,
    durationSeconds: 3_000,
    averagePaceSecondsPerKm: 300,
    averageHeartRateBpm: 150,
    elevationGainMeters: 40,
    gradeAdjustedPaceSecondsPerKm: 297
  },
  polylines: [
    [{ latitude: 31.2, longitude: 121.4 }, { latitude: 31.21, longitude: 121.41 }],
    [{ latitude: 31.23, longitude: 121.43 }, { latitude: 31.24, longitude: 121.44 }]
  ],
  note: "路线在隐私区处断开（1 处），区域内的坐标从未离开服务器。",
  ...overrides
});

describe("share card panel", () => {
  it("refreshes open cards after same-tab and cross-tab privacy changes", () => {
    const state = remote(card());
    useRemoteMock.mockReturnValue(state);
    const view = render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    act(() => notifyPrivacyZonesChanged());
    expect(state.reload).toHaveBeenCalledOnce();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "rai:privacy-zones-changed", newValue: "next" })));
    expect(state.reload).toHaveBeenCalledTimes(2);
    state.loading = true;
    view.rerender(<ShareCardPanel trainingSessionId="session_1" />);
    expect(screen.queryByRole("button", { name: "下载图片" })).toBeNull();
    expect(screen.queryByRole("img", { name: "分享卡片预览" })).toBeNull();
  });

  it("exports the freshly redacted payload instead of the cached preview", async () => {
    useRemoteMock.mockReturnValue(remote(card()));
    apiMock.mockResolvedValue(card({ polylines: [], note: "整条轨迹都在隐私区内，卡片不含路线。" }));
    const { blobs, click } = mockImageExport();
    render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(apiMock).toHaveBeenCalledWith("/v1/workouts/session_1/share-card", expect.objectContaining({
      cache: "no-store", headers: { authorization: "Bearer test-token" }
    }));
    const svg = await blobs[0]!.text();
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toContain("<path");
    expect(screen.getByText(/卡片不含路线/)).toBeTruthy();
  });

  it("fails closed when export revalidation fails", async () => {
    useRemoteMock.mockReturnValue(remote(card()));
    apiMock.mockRejectedValue(new Error("隐私设置校验失败"));
    const { blobs, click } = mockImageExport();
    render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("隐私设置校验失败"));
    expect(blobs).toHaveLength(0);
    expect(click).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "分享卡片预览" })).toBeNull();
  });

  it("cancels an export if privacy changes while PNG encoding is pending", async () => {
    useRemoteMock.mockReturnValue(remote(card()));
    apiMock.mockResolvedValue(card());
    const { blobs, click } = mockImageExport();
    let encode!: BlobCallback;
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback => { encode = callback; });
    render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
    await waitFor(() => expect(encode).toBeTypeOf("function"));
    act(() => notifyPrivacyZonesChanged());
    await act(async () => { encode(new Blob(["png"], { type: "image/png" })); });
    expect(blobs).toHaveLength(1);
    expect(click).not.toHaveBeenCalled();
  });

  it.each(["database", "data"])("cancels old PNG downloads when %s changes and allows a fresh export", async change => {
    const state = remote(card());
    useRemoteMock.mockReturnValue(state);
    apiMock.mockResolvedValue(card());
    const { click } = mockImageExport();
    const encoders: BlobCallback[] = [];
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback => { encoders.push(callback); });
    const view = render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
    await waitFor(() => expect(encoders).toHaveLength(1));
    act(() => { if (change === "database") notifyDatabaseStateChanged(); else notifyDataUpdated(); });

    const fresh = card({ polylines: [], note: "更新后不含路线。" });
    state.data = fresh;
    apiMock.mockResolvedValue(fresh);
    view.rerender(<ShareCardPanel trainingSessionId="session_1" />);
    expect(screen.getByText("更新后不含路线。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "下载图片" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
    await waitFor(() => expect(encoders).toHaveLength(2));

    await act(async () => { encoders[0]!(new Blob(["old-png"], { type: "image/png" })); });
    expect(click).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "下载图片" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { encoders[1]!(new Blob(["fresh-png"], { type: "image/png" })); });
    expect(click).toHaveBeenCalledOnce();
  });

  it.each(["database", "data"])("refreshes the real remote preview and cancels encoding when %s changes", async change => {
    const { useRemote } = await vi.importActual<typeof import("../src/hooks.js")>("../src/hooks.js");
    useRemoteMock.mockImplementation(useRemote);
    let payload = card();
    apiMock.mockImplementation(async () => payload);
    const { blobs, click } = mockImageExport();
    const encoders: BlobCallback[] = [];
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback => { encoders.push(callback); });
    const view = render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    await screen.findByRole("img", { name: "分享卡片预览" });
    fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
    await waitFor(() => expect(encoders).toHaveLength(1));

    payload = card({ polylines: [], note: "更新后不含路线。" });
    act(() => { if (change === "database") notifyDatabaseStateChanged(); else notifyDataUpdated(); });
    await screen.findByText("更新后不含路线。");
    expect(view.container.querySelectorAll("#share-card-session_1 path")).toHaveLength(0);
    await act(async () => { encoders[0]!(new Blob(["old-png"], { type: "image/png" })); });
    expect(click).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
    await waitFor(() => expect(encoders).toHaveLength(2));
    expect(await blobs[1]!.text()).not.toContain("<path");
    await act(async () => { encoders[1]!(new Blob(["fresh-png"], { type: "image/png" })); });
    expect(click).toHaveBeenCalledOnce();
    expect(apiMock).toHaveBeenCalledTimes(4);
  });

  it.each(["token", "session", "privacy", "database", "data"])("cancels an in-flight export when %s changes", async change => {
    useRemoteMock.mockReturnValue(remote(card()));
    let resolve!: (value: ShareCardResponse) => void;
    apiMock.mockReturnValue(new Promise<ShareCardResponse>(done => { resolve = done; }));
    const { blobs, click } = mockImageExport();
    const view = render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
    if (change === "token") act(() => writeApiToken("another-owner"));
    if (change === "session") view.rerender(<ShareCardPanel trainingSessionId="session_2" />);
    if (change === "privacy") act(() => notifyPrivacyZonesChanged());
    if (change === "database") act(() => notifyDatabaseStateChanged());
    if (change === "data") act(() => notifyDataUpdated());
    await act(async () => { resolve(card()); });
    expect(blobs).toHaveLength(0);
    expect(click).not.toHaveBeenCalled();
  });

  it("reacts to a token saved after the panel was mounted", () => {
    localStorage.clear();
    useRemoteMock.mockReturnValue(remote(card()));
    render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    expect(useRemoteMock.mock.lastCall?.[1]).toBe(false);
    act(() => writeApiToken("owner"));
    expect(useRemoteMock.mock.lastCall?.[1]).toBe(true);
    expect(screen.getByRole("img", { name: "分享卡片预览" })).toBeTruthy();
    act(() => writeApiToken(""));
    expect(screen.queryByRole("img", { name: "分享卡片预览" })).toBeNull();
  });
  it("V01: draws each surviving piece as its own path and never reconnects them", () => {
    useRemoteMock.mockReturnValue(remote(card()));
    const { container } = render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    // Scoped to the card: the download button's icon is an <svg> with its own <path>.
    const paths = container.querySelectorAll("#share-card-session_1 path");
    assert(paths.length === 2, `expected two separate paths, got ${paths.length}`);
    for (const path of paths) {
      assert(!path.getAttribute("d")?.includes("M") || (path.getAttribute("d")?.match(/M/g) ?? []).length === 1,
        "a path must not jump: one M per piece");
    }
    expect(screen.getByText(/路线在隐私区处断开/)).toBeTruthy();
    expect(screen.getByText("1 个 · 隐藏 12 点")).toBeTruthy();
  });

  it("V02: with no zones the card says it is unfiltered instead of implying privacy", () => {
    useRemoteMock.mockReturnValue(remote(card({
      privacy: { policyVersion: "rai-share-card-v1", zonesApplied: 0, redactedPoints: 0, gaps: 0, unfiltered: true },
      note: "未配置隐私区：卡片显示完整轨迹。"
    })));
    render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    expect(screen.getByText("未配置")).toBeTruthy();
    expect(screen.getByText(/卡片显示完整轨迹/)).toBeTruthy();
  });

  it("V03: a card whose route is entirely inside a zone renders no path at all", () => {
    useRemoteMock.mockReturnValue(remote(card({
      polylines: [],
      privacy: { policyVersion: "rai-share-card-v1", zonesApplied: 1, redactedPoints: 400, gaps: 0, unfiltered: false },
      note: "整条轨迹都在隐私区内，卡片不含路线。"
    })));
    const { container } = render(<ShareCardPanel trainingSessionId="session_1" />);
    openPanel();
    expect(container.querySelectorAll("#share-card-session_1 path").length).toBe(0);
    expect(screen.getByText(/卡片不含路线/)).toBeTruthy();
  });
});

function mockImageExport() {
  const blobs: NodeBlob[] = [];
  vi.stubGlobal("Blob", NodeBlob);
  // Keep a real, callable URL constructor on the global: WorkBuddy's sandbox fs
  // shim evaluates `filePath instanceof URL`, so replacing URL with a bare object
  // turns every dynamic import into a bogus "Right-hand side of 'instanceof' is
  // not callable". A Proxy forwards everything else (including `new URL(...)` and
  // the prototype chain) and only intercepts the two static helpers jsdom lacks.
  const createObjectURL = vi.fn((blob: NodeBlob) => { blobs.push(blob); return `blob:export-${blobs.length}`; });
  const revokeObjectURL = vi.fn();
  const StubURL = new Proxy(URL, {
    get(target, property, receiver) {
      if (property === "createObjectURL") return createObjectURL;
      if (property === "revokeObjectURL") return revokeObjectURL;
      return Reflect.get(target, property, receiver);
    }
  });
  vi.stubGlobal("URL", StubURL);
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: ""
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => {
    callback(new NodeBlob(["png"], { type: "image/png" }) as unknown as Blob);
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { blobs, click };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
