import assert from "node:assert/strict";
import test from "node:test";

import { MutationConflictError, MutationCoordinator } from "../src/mutation-coordinator.js";

test("serializes overlapping API mutations and releases idempotently", () => {
  const coordinator = new MutationCoordinator();
  const release = coordinator.acquire("database restore");

  assert.throws(
    () => coordinator.acquire("data import"),
    (error: unknown) => error instanceof MutationConflictError &&
      error.statusCode === 409 && error.activeOperation === "database restore"
  );

  release();
  release();
  const releaseNext = coordinator.acquire("data import");
  releaseNext();
});
