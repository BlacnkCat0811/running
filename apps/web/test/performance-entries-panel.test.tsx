import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { useRemoteMock } = vi.hoisted(() => ({ useRemoteMock: vi.fn() }));
vi.mock("../src/hooks.js", () => ({ useRemote: useRemoteMock }));
const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../src/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/api.js")>(), api: apiMock
}));

import { writeApiToken } from "../src/api.js";
import { PerformanceEntriesPanel } from "../src/components/PerformanceEntriesPanel.js";

afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

it("updates both mounted performance requests when a token is saved or removed", () => {
  localStorage.clear();
  useRemoteMock.mockImplementation((path: string) => ({
    data: path === "/v1/performance-entries" ? { entries: [] } : null,
    error: null, loading: false, reload: vi.fn()
  }));
  render(<PerformanceEntriesPanel />);
  fireEvent.click(screen.getByRole("button", { name: "录入成绩" }));
  expect(useRemoteMock.mock.calls.slice(-2).map(call => call[1])).toEqual([false, false]);
  expect(screen.queryByLabelText("日期")).toBeNull();

  act(() => writeApiToken("owner-token"));
  expect(useRemoteMock.mock.calls.slice(-2).map(call => call[1])).toEqual([true, true]);
  expect(screen.getByLabelText("日期")).toBeTruthy();

  act(() => writeApiToken(""));
  expect(useRemoteMock.mock.calls.slice(-2).map(call => call[1])).toEqual([false, false]);
  expect(screen.queryByLabelText("日期")).toBeNull();
});

it("confirms an existing candidate with its original training-session identity", async () => {
  localStorage.setItem("rai.web.apiToken", "owner-token");
  useRemoteMock.mockImplementation((path: string) => ({
    data: path === "/v1/performance-entries" ? { entries: [] } : {
      funnel: { usableOutcomeCount: 0, manualEntryCount: 0, trainingSampleCount: 0,
        trainingExcludedOutcomeCount: 0, confirmedCount: 0, byDistance: {} },
      candidates: [{ trainingSessionId: "original-race", localDate: "2026-10-02", distance: "ten_k",
        durationSeconds: 3000, confidence: "likely", reasons: ["10 km"] }],
      personal: { available: false, samples: 0, labelCount: 0, scoredCount: 0,
        distances: 0, spanDays: 0, minimumSamples: 8, minimumDistances: 2, minimumSpanDays: 120,
        reasonCodes: ["no_labels"], band: null }
    }, error: null, loading: false, reload: vi.fn(async () => true)
  }));
  apiMock.mockResolvedValue({ id: "confirmed" });
  render(<PerformanceEntriesPanel />);
  fireEvent.click(screen.getByRole("button", { name: "录入成绩" }));
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() => expect(apiMock).toHaveBeenCalledOnce());
  expect(JSON.parse(apiMock.mock.calls[0]![1].body)).toMatchObject({ trainingSessionId: "original-race", localDate: "2026-10-02" });
});

it("shows temporal training samples separately from eligible manual labels", () => {
  localStorage.setItem("rai.web.apiToken", "owner-token");
  useRemoteMock.mockImplementation((path: string) => ({
    data: path === "/v1/performance-entries" ? { entries: [] } : {
      funnel: { usableOutcomeCount: 8, manualEntryCount: 8, trainingSampleCount: 0,
        trainingExcludedOutcomeCount: 8, confirmedCount: 0, byDistance: {} },
      candidates: [], personal: { available: false, samples: 7, labelCount: 8, scoredCount: 7,
        distances: 2, spanDays: 130, minimumSamples: 8, minimumDistances: 2, minimumSpanDays: 120,
        reasonCodes: ["samples_below_minimum"], band: null }
    }, error: null, loading: false, reload: vi.fn()
  }));
  render(<PerformanceEntriesPanel />);
  fireEvent.click(screen.getByRole("button", { name: "录入成绩" }));
  expect(screen.getByText(/合格成绩/).textContent).toContain("8");
  expect(screen.getByText(/训练样本/).textContent).toContain("0");
  expect(screen.getByText(/缺少赛前证据/).textContent).toContain("8");
});

it("locks the entry draft and other mutations while a result is being recorded", async () => {
  localStorage.setItem("rai.web.apiToken", "owner-token");
  useRemoteMock.mockImplementation((path: string) => ({
    data: path === "/v1/performance-entries" ? { entries: [{ id: "previous", localDate: "2026-10-01",
      distance: "ten_k", durationSeconds: 3000, note: null, recordedAt: "2026-10-01T01:00:00Z", revokedAt: null }] } : null,
    error: null, loading: false, reload: vi.fn()
  }));
  let finish: (() => void) | undefined;
  apiMock.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ id: "new" }); }));
  render(<PerformanceEntriesPanel />);
  fireEvent.click(screen.getByRole("button", { name: "录入成绩" }));
  fireEvent.change(screen.getByLabelText("日期"), { target: { value: "2026-10-02" } });
  fireEvent.change(screen.getByLabelText("分"), { target: { value: "42" } });
  fireEvent.click(screen.getByRole("button", { name: "录入" }));
  for (const label of ["日期", "距离", "分", "秒"]) {
    expect((screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement).disabled).toBe(true);
  }
  const revoke = screen.getByRole("button", { name: "撤销 2026-10-01 的成绩" }) as HTMLButtonElement;
  expect(revoke.disabled).toBe(true);
  fireEvent.click(revoke);
  expect(apiMock).toHaveBeenCalledOnce();
  await act(async () => { finish?.(); });
  expect((screen.getByLabelText("日期") as HTMLInputElement).disabled).toBe(false);
});

it("prevents repeated candidate confirmation while its write is pending", async () => {
  localStorage.setItem("rai.web.apiToken", "owner-token");
  useRemoteMock.mockImplementation((path: string) => ({
    data: path === "/v1/performance-entries" ? { entries: [] } : {
      funnel: { usableOutcomeCount: 0, manualEntryCount: 0, trainingSampleCount: 0,
        trainingExcludedOutcomeCount: 0, confirmedCount: 0, byDistance: {} },
      candidates: [{ trainingSessionId: "original-race", localDate: "2026-10-02", distance: "ten_k",
        durationSeconds: 3000, confidence: "likely", reasons: ["10 km"] }],
      personal: { available: false, samples: 0, labelCount: 0, scoredCount: 0,
        distances: 0, spanDays: 0, minimumSamples: 8, minimumDistances: 2, minimumSpanDays: 120,
        reasonCodes: ["no_labels"], band: null }
    }, error: null, loading: false, reload: vi.fn()
  }));
  let finish: (() => void) | undefined;
  apiMock.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ id: "confirmed" }); }));
  render(<PerformanceEntriesPanel />);
  fireEvent.click(screen.getByRole("button", { name: "录入成绩" }));
  const confirm = screen.getByRole("button", { name: "确认" }) as HTMLButtonElement;
  fireEvent.click(confirm);
  expect(confirm.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(apiMock).toHaveBeenCalledOnce();
  await act(async () => { finish?.(); });
  expect(confirm.disabled).toBe(false);
});
