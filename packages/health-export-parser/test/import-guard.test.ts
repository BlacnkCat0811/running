import assert from "node:assert/strict";
import test from "node:test";

import {
  ABSENT_REMOVAL_GUARD_MAX_RATIO,
  ABSENT_REMOVAL_GUARD_MIN_ENTITIES,
  evaluateRemovalGuard,
  ImportRemovalGuardError
} from "../src/import-guard.js";

const preview = (records: number, workouts: number, activitySummaries = 0) => ({
  records,
  workouts,
  activitySummaries,
  total: records + workouts + activitySummaries
});

test("allows small removals that a genuine snapshot produces", () => {
  // Deleting a handful of sessions in Apple Health is a normal edit.
  const evaluation = evaluateRemovalGuard(preview(12, 3), 160_000);
  assert.equal(evaluation.allowedRemovals, 8_000);
  assert.equal(evaluation.exceeded, false);
});

test("allows the floor even on an almost empty database", () => {
  const evaluation = evaluateRemovalGuard(preview(10, 0), 0);
  assert.equal(evaluation.allowedRemovals, ABSENT_REMOVAL_GUARD_MIN_ENTITIES);
  assert.equal(evaluation.exceeded, false);
});

test("refuses a partial payload that would delete most of the history", () => {
  // A one-week export loaded as a full snapshot: 156k of 160k records vanish.
  const partial = preview(156_000, 200);
  const evaluation = evaluateRemovalGuard(partial, 160_271);
  assert.equal(evaluation.exceeded, true);

  const error = new ImportRemovalGuardError(partial, 160_271, evaluation.allowedRemovals);
  assert.equal(error.code, "import_removal_guard");
  assert.match(error.userMessage, /156000 条健康记录/);
  assert.match(error.userMessage, /200 次训练/);
  assert.match(error.userMessage, /约 97%/);
  assert.doesNotMatch(error.userMessage, /\//, "the operator message must not leak paths");
});

test("scales the allowance with the database size", () => {
  const evaluation = evaluateRemovalGuard(preview(0, 0), 10_000);
  assert.equal(evaluation.allowedRemovals, 10_000 * ABSENT_REMOVAL_GUARD_MAX_RATIO);
  // 500 removals are inside the ratio; 501 are not.
  assert.equal(evaluateRemovalGuard(preview(0, 500), 10_000).exceeded, false);
  assert.equal(evaluateRemovalGuard(preview(0, 501), 10_000).exceeded, true);
});


test("reconstructs only validated removal counts from IPC payloads", () => {
  const error = new ImportRemovalGuardError(preview(0, 59), 60, 50);
  const payload = error.toPayload();
  assert.equal(ImportRemovalGuardError.fromPayload(JSON.parse(JSON.stringify(payload)))?.userMessage, error.userMessage);
  for (const invalid of [null, {}, { ...payload, existingEntities: "private/path" },
    { ...payload, preview: { ...payload.preview, workouts: -1 } },
    { ...payload, preview: { ...payload.preview, total: 58 } },
    { ...payload, existingEntities: 1 }, { ...payload, allowedRemovals: 60 }]) {
    assert.equal(ImportRemovalGuardError.fromPayload(invalid), null);
  }
  const extraText = { ...payload, userMessage: "/private/secret", message: "/private/secret" };
  assert.equal(ImportRemovalGuardError.fromPayload(extraText)?.userMessage, error.userMessage);
});
