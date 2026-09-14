import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiMock, notifyDataUpdatedMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  notifyDataUpdatedMock: vi.fn(),
}));

vi.mock("../src/api.js", () => ({ api: apiMock }));
vi.mock("../src/events.js", () => ({
  notifyDatabaseStateChanged: vi.fn(),
  notifyDataUpdated: notifyDataUpdatedMock,
}));

import { GlobalTaskStatus } from "../src/components/GlobalTaskStatus.js";

const predictionRun = (status: string) => ({
  id: "prediction-1",
  status,
  active: false,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  apiMock.mockReset();
  notifyDataUpdatedMock.mockReset();
});

describe("GlobalTaskStatus prediction lifecycle", () => {
  it("reports a quality-gate rejection as a terminal training result", async () => {
    vi.useFakeTimers();
    apiMock
      .mockResolvedValueOnce({
        busy: true,
        importJob: null,
        recomputeJob: null,
        predictionModelJob: predictionRun("validating"),
      })
      .mockResolvedValue({
        busy: false,
        importJob: null,
        recomputeJob: null,
        predictionModelJob: predictionRun("rejected"),
      });

    render(<MemoryRouter><GlobalTaskStatus /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("预测模型正在训练")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("预测模型训练未完成，请查看任务记录。")).toBeTruthy();
    expect(notifyDataUpdatedMock).not.toHaveBeenCalled();
  });
});

// 后台标签页原先仍以 1.5-7s 的节奏轮询，长时间挂着会持续打服务端。
describe("GlobalTaskStatus visibility", () => {
  const idle = { busy: false, importJob: null, recomputeJob: null, predictionModelJob: null };
  const forceVisibility = (value: DocumentVisibilityState) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
  };

  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  it("stops polling while hidden and catches up on return to the foreground", async () => {
    vi.useFakeTimers();
    forceVisibility("hidden");
    apiMock.mockResolvedValue(idle);

    render(<MemoryRouter><GlobalTaskStatus /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    expect(apiMock).not.toHaveBeenCalled();

    // 隐藏期间推进再多时间也不应产生请求。
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(apiMock).not.toHaveBeenCalled();

    forceVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
