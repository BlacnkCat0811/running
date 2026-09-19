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

test("legacy route waits for a short handoff but still bounds contention", async () => {
  const coordinator = new MutationCoordinator();
  const release = coordinator.acquire("worker");
  const pending = coordinator.acquireWhenAvailable("HTTP", 500);
  setTimeout(release, 30);
  const acquired = await pending;
  await assert.rejects(coordinator.acquireWhenAvailable("other", 0), MutationConflictError);
  acquired();
  coordinator.acquire("next")();
});
