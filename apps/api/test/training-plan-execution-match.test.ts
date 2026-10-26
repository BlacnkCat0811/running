import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../src/plan-digest.js";
import { PlanOperationError } from "../src/plan-publication.js";
import {
  ExecutionCursorError, executionCandidateFactsDigest, executionFactDigest, factsInRange,
  lifecycleForAssessment, pageExecutionCandidates, parseExecutionCursor, resolveExecutionRange,
  shiftLocalDate, type ExecutionFact
} from "../src/training-plan-execution-match.js";

const fact = (id: string, startedAt: string): ExecutionFact => ({ trainingSessionId: id, startedAt,
  endedAt: new Date(Date.parse(startedAt) + 30 * 60_000).toISOString(), distanceMeters: 8000, durationSeconds: 1800,
  sourceFactDigest: executionFactDigest({ trainingSessionId: id, startedAt, endedAt: startedAt,
    distanceMeters: 8000, durationSeconds: 1800, updatedAt: "2026-10-30T00:00:00.000Z" }) });

test("B06/S03-02: default window is ±2 natural days; expanded range is capped at 31 days and must contain the course", () => {
  assert.deepEqual(resolveExecutionRange("2026-10-28"), { rangeStart: "2026-10-26", rangeEnd: "2026-10-30" });
  assert.deepEqual(resolveExecutionRange("2026-10-28", "2026-10-25", "2026-10-31"), { rangeStart: "2026-10-25", rangeEnd: "2026-10-31" });
  assert.throws(() => resolveExecutionRange("2026-10-28", "2026-09-01", "2026-10-31"), /31 natural days/);
  assert.throws(() => resolveExecutionRange("2026-10-28", "2026-10-29", "2026-10-31"), /include the session date/);
  assert.throws(() => resolveExecutionRange("2026-10-28", "2026-10-26", null), /provided together/);
  assert.equal(shiftLocalDate("2026-10-28", -2), "2026-10-26");
});

test("B06/S03-02: cross-midnight runs are filtered by startedAt's Shanghai date, not endedAt", () => {
  // 2026-10-28T16:40Z = 2026-10-29 00:40 +08:00, even though it ends on the 29th.
  const late = fact("late", "2026-10-28T16:40:00.000Z");
  const next = fact("next", "2026-10-29T00:10:00.000Z");
  const range = resolveExecutionRange("2026-10-29");
  assert.deepEqual(factsInRange([late, next], range).map(item => item.trainingSessionId), ["late", "next"]);
  const outside = fact("outside", "2026-10-30T16:10:00.000Z"); // 2026-10-31 00:10 +08
  assert.deepEqual(factsInRange([outside], resolveExecutionRange("2026-10-28")).map(item => item.trainingSessionId), [],
    "a run whose startedAt falls on the 31st is outside the 28th's default window");
});

test("B06/S03-02: candidate paging is stable, bounded at 50 and the cursor is not a write token", () => {
  const facts = Array.from({ length: 60 }, (_, index) => fact(`run-${String(index).padStart(2, "0")}`,
    new Date(Date.parse("2026-10-28T00:00:00.000Z") + index * 60_000).toISOString()));
  const range = resolveExecutionRange("2026-10-28");
  const scope = "scope-a";
  const first = pageExecutionCandidates({ facts, range, scope });
  assert.equal(first.candidates.length, 50);
  assert.ok(first.nextCursor);
  const second = pageExecutionCandidates({ facts, range, scope, cursor: first.nextCursor });
  assert.equal(second.candidates.length, 10);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.candidates, ...second.candidates].map(item => item.trainingSessionId)).size, 60);
  const cursor = parseExecutionCursor(first.nextCursor!, {
    scope, range, factsDigest: executionCandidateFactsDigest(facts, range)
  });
  assert.equal(cursor.trainingSessionId, first.candidates.at(-1)!.trainingSessionId);
});

test("B06/S03-02: cursor is bound to contract scope, range and the candidate fact set", () => {
  const facts = Array.from({ length: 3 }, (_, index) => fact(`run-${index}`,
    new Date(Date.parse("2026-10-28T00:00:00.000Z") + index * 60_000).toISOString()));
  const range = resolveExecutionRange("2026-10-28");
  const scope = "scope-a";
  const first = pageExecutionCandidates({ facts, range, scope, limit: 1 });
  assert.ok(first.nextCursor);
  const cursor = first.nextCursor!;
  const assertCursorError = (fn: () => unknown, label: string) => {
    assert.throws(fn, (error: unknown) => error instanceof ExecutionCursorError &&
      error instanceof PlanOperationError && error.code === "training_session_command_invalid" &&
      error.statusCode === 422, label);
  };
  assertCursorError(() => pageExecutionCandidates({ facts, range, scope: "scope-b", cursor }), "cross-scope cursor");
  const wider = resolveExecutionRange("2026-10-28", "2026-10-27", "2026-10-29");
  assertCursorError(() => pageExecutionCandidates({ facts, range: wider, scope, cursor }), "cross-range cursor");
  const changed = facts.map((item, index) => index === 0 ? { ...item, distanceMeters: 8_100 } : item);
  assertCursorError(() => pageExecutionCandidates({ facts: changed, range, scope, cursor }), "changed facts");
  assertCursorError(() => pageExecutionCandidates({ facts, range, scope, cursor: "%%%%" }), "illegal base64");
  assertCursorError(() => pageExecutionCandidates({ facts, range, scope, cursor: "not-a-cursor" }), "malformed payload");
  assertCursorError(() => pageExecutionCandidates({ facts, range, scope: "", cursor }), "missing scope context");
  const wrongVersion = Buffer.from(JSON.stringify({ contract: "rai-training-plan-execution-cursor-v1", version: 999,
    scope, rangeStart: range.rangeStart, rangeEnd: range.rangeEnd, factsDigest: executionCandidateFactsDigest(facts, range),
    startedAt: first.candidates[0]!.startedAt, trainingSessionId: first.candidates[0]!.trainingSessionId
  }), "utf8").toString("base64url");
  assertCursorError(() => parseExecutionCursor(wrongVersion), "wrong contract version");
});

test("B06: a completed link stays completed when dose is unknown; only explicit shortfall is partial", () => {
  assert.equal(lifecycleForAssessment(null), "completed");
  assert.equal(lifecycleForAssessment({ dose: { status: "not_assessable" } }), "completed");
  assert.equal(lifecycleForAssessment({ dose: { status: "met" } }), "completed");
  assert.equal(lifecycleForAssessment({ dose: { status: "partial" } }), "partial");
  assert.equal(lifecycleForAssessment({ dose: { status: "not_met" } }), "partial");
});

test("B06: the fact digest changes when the main library corrects or re-imports the run", () => {
  const base = { trainingSessionId: "run-1", startedAt: "2026-10-28T00:00:00.000Z",
    endedAt: "2026-10-28T00:45:00.000Z", distanceMeters: 8200, durationSeconds: 2700, updatedAt: "2026-10-30T00:00:00.000Z" };
  const one = executionFactDigest(base);
  assert.equal(executionFactDigest(base), one);
  assert.notEqual(executionFactDigest({ ...base, distanceMeters: 8300 }), one);
  assert.notEqual(executionFactDigest({ ...base, updatedAt: "2026-10-31T00:00:00.000Z" }), one);
  assert.equal(one, digest({ contract: "rai-training-execution-fact-v1", ...base }));
});

test("B06/S03-02: early/late runs stay candidates in the ±2 window and same-day runs are never merged", () => {
  const sessionDate = "2026-10-28";
  const early = fact("early", "2026-10-26T00:10:00.000Z"); // 2026-10-26 08:10 +08
  const sameMorning = fact("same-am", "2026-10-28T00:10:00.000Z");
  const sameEvening = fact("same-pm", "2026-10-28T10:30:00.000Z");
  const late = fact("late", "2026-10-30T00:10:00.000Z"); // 2026-10-30 08:10 +08
  const outside = fact("outside", "2026-10-31T00:10:00.000Z");
  const page = pageExecutionCandidates({ facts: [late, sameEvening, early, outside, sameMorning],
    range: resolveExecutionRange(sessionDate) });
  assert.deepEqual(page.candidates.map(item => item.trainingSessionId), ["early", "same-am", "same-pm", "late"]);
  assert.equal(page.candidates.filter(item => item.trainingSessionId.startsWith("same-")).length, 2,
    "two same-day runs remain two candidates; the matcher never merges them");
  assert.ok(page.candidates.every(item => item.evidence === "needs_confirmation"));
});
