import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { submitFeedbackCommand, FeedbackSubmissionRejected, type FeedbackSubmission } from "../src/feedback-command.js";
import { writeApiToken } from "../src/api.js";
const input: FeedbackSubmission = { idempotencyKey: "feedback-id", kind: "workout_override", payload: {
  trainingSessionId: "run", expectedRevision: 4, eligibilityOverride: "exclude", statisticsParticipation: "include",
  sessionType: "race", performanceProtocol: "five_k_time_trial", rpe: 7, conditionTags: ["hot"], note: "draft"
} };
beforeEach(() => localStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("keeps the same key and full snapshot when acknowledgement is lost", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "command", status: "succeeded", result: { overrideId: "one", jobId: "job" } })));
  vi.stubGlobal("fetch", fetch);
  await expect(submitFeedbackCommand(input)).rejects.toThrow("offline");
  expect((await submitFeedbackCommand(input)).status).toBe("succeeded");
  const first = JSON.parse(fetch.mock.calls[0]![1].body);
  const second = JSON.parse(fetch.mock.calls[1]![1].body);
  expect(first).toEqual(second); expect(first.payload).toEqual(input.payload);
});
it("does not equate acceptance with persistence and checks command terminal status", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "command", status: "queued" }), { status: 202 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "command", status: "failed", error: { code: "workout_override_revision_conflict", message: "conflict" } })));
  vi.stubGlobal("fetch", fetch);
  const pending = submitFeedbackCommand(input);
  await vi.runAllTimersAsync();
  expect((await pending).status).toBe("failed"); expect(fetch.mock.calls[1]![0]).toBe("/v1/commands/command");
});
it("a validation rejection permits correcting the draft", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"message":"invalid"}', { status: 400 })));
  await expect(submitFeedbackCommand(input)).rejects.toBeInstanceOf(FeedbackSubmissionRejected);
});
it("does not publish a response after credentials changed", async () => {
  writeApiToken("first");
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
    writeApiToken("second"); return new Response('{"id":"command","status":"succeeded"}');
  }));
  await expect(submitFeedbackCommand(input)).rejects.toThrow("连接凭证已变化");
});
