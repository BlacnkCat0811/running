import assert from "node:assert/strict";
import test from "node:test";

import type { MobileWeeklyPlanGenerationResponse, MobileWeeklyPlanPreviewResponse } from "@rai/api-contracts";

import { PlanPreviewError, WeeklyPlanPreviews } from "../src/weekly-plan-preview.js";

const FIFTEEN_MINUTES_MS = 15 * 60_000;

const audit = {
  generatedBy: "heuristic" as const,
  model: null,
  promptVersion: null,
  generatedAt: "2026-10-18T00:00:00.000Z"
};

const previewValue = (revision: number): Omit<MobileWeeklyPlanPreviewResponse, "candidateId" | "expiresAt"> => ({
  generatedAt: "2026-10-18T00:00:00.000Z",
  revision,
  audit,
  days: [],
  warnings: [],
  replacedDates: [],
  windowStart: "2026-10-18",
  windowEnd: "2026-10-24"
});

const published = (revision: number): MobileWeeklyPlanGenerationResponse => ({
  generatedAt: "2026-10-18T00:00:00.000Z",
  revision,
  audit,
  days: [],
  warnings: []
});

const capture = (run: () => unknown): (Error & { code?: string; statusCode?: number }) | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error as Error & { code?: string; statusCode?: number };
  }
};

test("nine candidates inside the same 15-minute window stay confirmable", () => {
  const clock = Date.parse("2026-10-18T09:00:00.000Z");
  const previews = new WeeklyPlanPreviews(() => clock);
  const candidates = Array.from({ length: 9 }, (_, index) => previews.create(previewValue(index + 1), `fingerprint-${index + 1}`));
  let writes = 0;
  // The old implementation kept at most eight entries and evicted the oldest on
  // the ninth create(), so this confirm reported "预览已过期" minutes early.
  const confirmed = previews.confirm(candidates[0]!.candidateId, candidates[0]!.revision, "fingerprint-1", () => {
    writes += 1;
    return published(candidates[0]!.revision);
  });
  assert.equal(confirmed.revision, 1);
  assert.equal(writes, 1);
  // Every other live candidate is still confirmable too.
  const last = candidates[8]!;
  assert.equal(previews.confirm(last.candidateId, last.revision, "fingerprint-9", () => published(last.revision)).revision, 9);
});

test("a candidate stops being confirmable only when its 15-minute lease runs out", () => {
  let clock = Date.parse("2026-10-18T09:00:00.000Z");
  const previews = new WeeklyPlanPreviews(() => clock);
  const preview = previews.create(previewValue(3), "fingerprint-3");
  assert.equal(Date.parse(preview.expiresAt), clock + FIFTEEN_MINUTES_MS);
  clock += FIFTEEN_MINUTES_MS - 1;
  assert.equal(previews.confirm(preview.candidateId, 3, "fingerprint-3", () => published(3)).revision, 3);
  const second = previews.create(previewValue(4), "fingerprint-4");
  clock += FIFTEEN_MINUTES_MS + 1;
  const expired = capture(() => previews.confirm(second.candidateId, 4, "fingerprint-4", () => published(4)));
  assert.ok(expired instanceof PlanPreviewError);
  assert.equal(expired?.code, "plan_preview_stale");
  assert.equal(expired?.statusCode, 409);
});

test("a published confirm is remembered even for the legacy remember=false call", () => {
  const previews = new WeeklyPlanPreviews(() => Date.parse("2026-10-18T09:00:00.000Z"));
  const preview = previews.create(previewValue(7), "fingerprint-7");
  let writes = 0;
  const write = (): MobileWeeklyPlanGenerationResponse => {
    writes += 1;
    return published(7);
  };
  const first = previews.confirm(preview.candidateId, 7, "fingerprint-7", write);
  // The pre-P3-6 code passed `operationId === undefined` here, so a confirm that
  // carried an operationId never recorded its result and a retry with a fresh key
  // recomputed the fingerprint against the already-advanced revision.
  const retried = previews.confirm(preview.candidateId, 7, "fingerprint-7", write, false);
  assert.deepEqual(retried, first);
  assert.equal(writes, 1, "a lost acknowledgement must not publish a second revision");
  // The committed result is returned before the fingerprint is consulted, which
  // is what makes a retried confirm survivable after the week was rewritten.
  const afterChange = previews.confirm(preview.candidateId, 7, "different-fingerprint", write);
  assert.deepEqual(afterChange, first);
  assert.equal(writes, 1);
});

test("revision and fingerprint are still checked before a first publication", () => {
  const previews = new WeeklyPlanPreviews(() => Date.parse("2026-10-18T09:00:00.000Z"));
  const preview = previews.create(previewValue(11), "fingerprint-11");
  let writes = 0;
  const write = (): MobileWeeklyPlanGenerationResponse => {
    writes += 1;
    return published(11);
  };
  const wrongRevision = capture(() => previews.confirm(preview.candidateId, 10, "fingerprint-11", write));
  assert.equal(wrongRevision?.code, "plan_preview_stale");
  const staleFingerprint = capture(() => previews.confirm(preview.candidateId, 11, "fingerprint-moved", write));
  assert.equal(staleFingerprint?.code, "plan_preview_stale");
  const unknown = capture(() => previews.confirm("no-such-candidate", 11, "fingerprint-11", write));
  assert.equal(unknown?.code, "plan_preview_stale");
  assert.equal(writes, 0, "no candidate published on a rejected confirm");
});

test("the memory backstop only evicts when more than 64 live candidates exist", () => {
  const clock = Date.parse("2026-10-18T09:00:00.000Z");
  const previews = new WeeklyPlanPreviews(() => clock);
  const candidates = Array.from({ length: 70 }, (_, index) => previews.create(previewValue(index + 1), `fingerprint-${index + 1}`));
  // 70 live candidates > 64: the oldest six are dropped as a memory backstop.
  const evicted = capture(() => previews.confirm(candidates[5]!.candidateId, 6, "fingerprint-6", () => published(6)));
  assert.equal(evicted?.code, "plan_preview_stale");
  assert.equal(previews.confirm(candidates[6]!.candidateId, 7, "fingerprint-7", () => published(7)).revision, 7);
});

test("create() prunes expired candidates and clear() drops the whole set", () => {
  let clock = Date.parse("2026-10-18T09:00:00.000Z");
  const previews = new WeeklyPlanPreviews(() => clock);
  const first = previews.create(previewValue(1), "fingerprint-1");
  clock += FIFTEEN_MINUTES_MS + 1;
  previews.create(previewValue(2), "fingerprint-2");
  // Pruning is observable through the confirm error even if the entry were
  // otherwise still in the map: the lease check runs first.
  assert.equal(capture(() => previews.confirm(first.candidateId, 1, "fingerprint-1", () => published(1)))?.code,
    "plan_preview_stale");
  previews.clear();
  const second = previews.create(previewValue(3), "fingerprint-3");
  previews.clear();
  assert.equal(capture(() => previews.confirm(second.candidateId, 3, "fingerprint-3", () => published(3)))?.code,
    "plan_preview_stale");
});
