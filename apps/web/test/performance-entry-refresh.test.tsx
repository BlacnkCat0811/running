import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/api.js")>(), api: apiMock
}));

import { PerformanceEntriesPanel } from "../src/components/PerformanceEntriesPanel.js";
import { useRemote } from "../src/hooks.js";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem("rai.web.apiToken", "owner-token");
});
afterEach(() => { cleanup(); localStorage.clear(); });

const entry = { id: "result", localDate: "2026-10-01", distance: "ten_k", durationSeconds: 3000,
  note: null, recordedAt: "2026-10-02T00:00:00Z", revokedAt: null };
const progress = (count: number) => ({
  funnel: { usableOutcomeCount: count, manualEntryCount: count, trainingSampleCount: count,
    trainingExcludedOutcomeCount: 0, confirmedCount: count, byDistance: {} },
  candidates: count === 1 ? [{ trainingSessionId: "candidate", localDate: "2026-10-02",
    distance: "ten_k", durationSeconds: 3000, confidence: "likely", reasons: ["race"] }] : [],
  personal: { available: false, samples: count, labelCount: count, scoredCount: count,
    distances: 1, spanDays: 1, minimumSamples: 8, minimumDistances: 2, minimumSpanDays: 120,
    reasonCodes: ["samples_below_minimum"], band: null }
});

function PredictionProbe() {
  const remote = useRemote<{ version: string }>("/v1/predictions");
  return <span>{remote.data?.version}</span>;
}

it.each(["submit", "confirm", "revoke"])("%s refreshes entries, label progress and mounted predictions", async action => {
  let mutated = false;
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST" || init?.method === "DELETE") {
      mutated = true;
      return init.method === "DELETE" ? { revoked: true } : { ...entry, id: "new-result" };
    }
    if (path === "/v1/performance-entries") return { entries: mutated ? [] : [entry] };
    if (path === "/v1/label-funnel") return progress(mutated ? (action === "revoke" ? 0 : 2) : 1);
    if (path === "/v1/predictions") return { version: mutated ? "prediction-after" : "prediction-before" };
    throw new Error(`Unexpected request: ${path}`);
  });
  render(<><PredictionProbe /><PerformanceEntriesPanel /></>);
  fireEvent.click(screen.getByRole("button", { name: "录入成绩" }));
  await screen.findByText("prediction-before");
  await screen.findByText(/合格成绩/);
  if (action === "submit") {
    fireEvent.change(screen.getByLabelText("日期"), { target: { value: "2026-10-02" } });
    fireEvent.change(screen.getByLabelText("分"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "录入" }));
  } else if (action === "confirm") {
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
  } else {
    fireEvent.click(screen.getByRole("button", { name: "撤销 2026-10-01 的成绩" }));
  }
  await screen.findByText("prediction-after");
  await waitFor(() => expect(screen.getByText(/合格成绩/).textContent).toContain(action === "revoke" ? "0" : "2"));
  for (const path of ["/v1/performance-entries", "/v1/label-funnel", "/v1/predictions"]) {
    expect(apiMock.mock.calls.filter(call => call[0] === path && !call[1]?.method)).toHaveLength(2);
  }
});

it("hides stale calibration when the post-write progress refresh fails", async () => {
  let mutated = false;
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "DELETE") { mutated = true; return { revoked: true }; }
    if (path === "/v1/performance-entries") return { entries: mutated ? [] : [entry] };
    if (path === "/v1/label-funnel") {
      if (mutated) throw new Error("标签进度更新失败");
      return progress(1);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  render(<PerformanceEntriesPanel />);
  fireEvent.click(screen.getByRole("button", { name: "录入成绩" }));
  await screen.findByText(/合格成绩/);
  fireEvent.click(screen.getByRole("button", { name: "撤销 2026-10-01 的成绩" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("标签进度更新失败"));
  expect(screen.queryByText(/合格成绩/)).toBeNull();
});
