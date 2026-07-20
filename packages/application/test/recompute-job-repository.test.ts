import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import { RecomputeJobRepository } from "../src/recompute-job-repository.js";

test("repository owns the durable recompute job lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-repository-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const repository = new RecomputeJobRepository(store.database);
    const firstId = repository.enqueue("full_recompute", "dataset-1", { evaluatedAt: "2026-07-17T00:00:00.000Z" });
    const secondId = repository.enqueue("snapshot_refresh", "dataset-1", { timezoneIdentifier: "UTC" });

    assert.deepEqual(
      { id: repository.get(firstId)?.id, status: repository.get(firstId)?.status },
      { id: firstId, status: "queued" }
    );
    assert.equal(repository.claimNext()?.id, firstId);
    assert.deepEqual(repository.requestCancellation(firstId), {
      outcome: "cancellation_requested",
      status: "running",
      cancelRequested: true
    });
    assert.equal(repository.recoverInterrupted(), 1);
    assert.equal(repository.get(firstId)?.status, "cancelled");

    assert.deepEqual(repository.requestCancellation(secondId), {
      outcome: "cancelled",
      status: "cancelled",
      cancelRequested: false
    });
    assert.equal(repository.claimNext(), null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
