import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkoutDetailResponse } from "@rai/api-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverrideDrawer } from "../src/components/OverrideDrawer.js";
import { writeApiToken } from "../src/api.js";

const detail = { workout: { id: "run" }, override: {
  revision: 4, eligibilityOverride: "exclude", statisticsParticipation: "include",
  sessionType: "race", performanceProtocol: "five_k_time_trial", rpe: 7,
  conditionTags: ["hot"], note: "original draft", createdAt: "2026-09-28T00:00:00Z"
} } as WorkoutDetailResponse;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "保存并重算" }));
const retry = () => fireEvent.click(screen.getByRole("button", { name: "检查保存结果" }));
const note = () => screen.getByLabelText("备注") as HTMLTextAreaElement;
// Native DOM disabled reflects ancestor fieldsets (element.disabled alone does not).
const frozen = () => note().matches(":disabled");
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it.each([400, 422])("unlocks after a retry is rejected with %s, preserves input and uses a new key for edited content", async status => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(reply(500, { message: "reply lost" }))
    .mockResolvedValueOnce(reply(status, { message: "invalid feedback" }))
    .mockResolvedValueOnce(reply(200, { id: "command", status: "succeeded", result: { jobId: "job" } }));
  vi.stubGlobal("fetch", fetch);
  const saved = vi.fn(); render(<OverrideDrawer detail={detail} onClose={vi.fn()} onSaved={saved} />);
  submit(); await screen.findByRole("button", { name: "检查保存结果" });
  expect(frozen()).toBe(true);
  retry(); await screen.findByText(/本次请求被拒绝/);
  expect(frozen()).toBe(false); expect(note().value).toBe("original draft"); expect(saved).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).not.toContain("重试使用同一次操作");
  fireEvent.change(note(), { target: { value: "corrected draft" } }); submit();
  await waitFor(() => expect(saved).toHaveBeenCalledWith("job"));
  const payloads = fetch.mock.calls.map(call => JSON.parse(call[1].body));
  expect(payloads[1]).toEqual(payloads[0]);
  expect(payloads[2].idempotencyKey).not.toBe(payloads[0].idempotencyKey);
  expect(payloads[2].payload).toEqual({ ...payloads[0].payload, note: "corrected draft" });
});

it("a first validation refusal immediately restores editing without losing the draft", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(400, { message: "invalid" })));
  render(<OverrideDrawer detail={detail} onClose={vi.fn()} onSaved={vi.fn()} />);
  submit(); await screen.findByText(/本次请求被拒绝/);
  expect(frozen()).toBe(false); expect(note().value).toBe("original draft");
});

it.each([401, 403])("retains uncertain operation on retry authentication error %s, then reuses it after recovery", async status => {
  const fetch = vi.fn().mockResolvedValueOnce(reply(500, { message: "reply lost" }))
    .mockResolvedValueOnce(reply(status, { message: "authentication refused" }))
    .mockResolvedValueOnce(reply(200, { id: "command", status: "succeeded", result: { jobId: "job" } }));
  vi.stubGlobal("fetch", fetch);
  const saved = vi.fn(); render(<OverrideDrawer detail={detail} onClose={vi.fn()} onSaved={saved} />);
  submit(); await screen.findByRole("button", { name: "检查保存结果" }); retry();
  await screen.findByText(/请先恢复连接/); expect(frozen()).toBe(true);
  expect(saved).not.toHaveBeenCalled(); retry();
  await waitFor(() => expect(saved).toHaveBeenCalled());
  const payloads = fetch.mock.calls.map(call => JSON.parse(call[1].body));
  expect(payloads[0]).toEqual(payloads[1]); expect(payloads[1]).toEqual(payloads[2]);
});

it("an error querying an accepted command cannot unlock editing or report unsaved", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(202, { id: "command", status: "queued" }))
    .mockResolvedValueOnce(reply(400, { message: "lookup failed" })));
  render(<OverrideDrawer detail={detail} onClose={vi.fn()} onSaved={vi.fn()} />);
  submit(); await screen.findByText(/lookup failed/, {}, { timeout: 3000 });
  expect(frozen()).toBe(true); expect(screen.getByRole("alert").textContent).not.toContain("本次请求被拒绝");
});

it("credential changes have distinct guidance and never publish an old success", async () => {
  writeApiToken("first");
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
    writeApiToken("second"); return reply(200, { id: "command", status: "succeeded" });
  }));
  const saved = vi.fn(); render(<OverrideDrawer detail={detail} onClose={vi.fn()} onSaved={saved} />);
  submit(); await screen.findByText(/请回到原连接/);
  expect(frozen()).toBe(true); expect(saved).not.toHaveBeenCalled();
});
