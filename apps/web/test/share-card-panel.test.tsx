import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShareCardResponse } from "@rai/api-contracts";

/**
 * V01–V03 on the rendering side: the card draws exactly the polylines the server
 * sent. It must not re-join them (that would draw the chord through a privacy
 * zone), and it must report whether the route was filtered at all.
 */
const useRemoteMock = vi.hoisted(() => vi.fn());
vi.mock("../src/hooks.js", () => ({ useRemote: useRemoteMock }));

import { ShareCardPanel } from "../src/components/ShareCardPanel.js";

beforeEach(() => {
  // The card carries route geometry, so the panel deliberately refuses to fetch
  // without a token; the test has to look like a configured browser.
  localStorage.setItem("rai.web.apiToken", "test-token");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
