import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

    const cancelledAtCompletionId = repository.enqueue("snapshot_refresh", "dataset-1", {});
    assert.equal(repository.claimNext()?.id, cancelledAtCompletionId);
    assert.equal(repository.requestCancellation(cancelledAtCompletionId).outcome, "cancellation_requested");
    let completionSideEffectRan = false;
    assert.equal(repository.complete(
      cancelledAtCompletionId,
      "snapshot_refreshed",
      1,
      1,
      "Snapshot refreshed",
      () => { completionSideEffectRan = true; }
    ), false);
    assert.equal(completionSideEffectRan, false);
    assert.equal(repository.get(cancelledAtCompletionId)?.status, "cancelled");
    repository.fail(cancelledAtCompletionId, new Error("completion surfaced cancellation"));
    repository.fail(cancelledAtCompletionId, new Error("duplicate failure retry"));
    assert.equal(
      repository.listEvents(cancelledAtCompletionId).filter(({ phase }) => phase === "cancelled").length,
      1
    );

    const completedId = repository.enqueue("full_recompute", "dataset-1", {});
    assert.equal(repository.claimNext()?.id, completedId);
    assert.equal(repository.complete(completedId, "completed", 1, 1, "Completed"), true);
    assert.equal(repository.get(completedId)?.status, "succeeded");
    assert.deepEqual(repository.requestCancellation(completedId), { outcome: "terminal" });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failure arbitration honors a cancellation requested by a running job", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-failure-cancellation-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const repository = new RecomputeJobRepository(store.database);
    const jobId = repository.enqueue("full_recompute", "dataset-1", {});
    assert.equal(repository.claimNext()?.id, jobId);
    repository.updateProgress(jobId, "feature_extraction", 3, 10, "Extracting features");
    assert.equal(repository.requestCancellation(jobId).outcome, "cancellation_requested");

    repository.fail(jobId, new Error("failure observed before the next cancellation check"));
    repository.fail(jobId, new Error("duplicate worker failure"));

    const job = repository.get(jobId);
    assert.deepEqual(
      {
        status: job?.status,
        progressPhase: job?.progressPhase,
        progressCurrent: job?.progressCurrent,
        progressTotal: job?.progressTotal,
        cancelRequested: job?.cancelRequested,
        error: job?.error
      },
      {
        status: "cancelled",
        progressPhase: "cancelled",
        progressCurrent: 3,
        progressTotal: 10,
        cancelRequested: false,
        error: null
      }
    );
    assert.ok(job?.completedAt);
    const event = repository.listEvents(jobId).find(({ phase }) => phase === "cancelled");
    assert.equal(repository.listEvents(jobId).filter(({ phase }) => phase === "cancelled").length, 1);
    assert.deepEqual(
      {
        phase: event?.phase,
        progressCurrent: event?.progress_current,
        progressTotal: event?.progress_total,
        message: event?.message
      },
      {
        phase: "cancelled",
        progressCurrent: 3,
        progressTotal: 10,
        message: "Task cancelled"
      }
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation checks persist the terminal event atomically and idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-cancellation-check-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const repository = new RecomputeJobRepository(store.database);
    const jobId = repository.enqueue("snapshot_refresh", "dataset-1", {});
    assert.equal(repository.claimNext()?.id, jobId);
    repository.updateProgress(jobId, "snapshot_refresh", 2, 5, "Refreshing snapshots");
    assert.equal(repository.requestCancellation(jobId).outcome, "cancellation_requested");

    assert.equal(repository.cancelIfRequested(jobId), true);
    assert.equal(repository.cancelIfRequested(jobId), false);
    repository.fail(jobId, new Error("pipeline observed cancellation"));

    assert.equal(repository.get(jobId)?.status, "cancelled");
    const events = repository.listEvents(jobId).filter(({ phase }) => phase === "cancelled");
    assert.equal(events.length, 1);
    assert.deepEqual(
      { current: events[0]?.progress_current, total: events[0]?.progress_total },
      { current: 2, total: 5 }
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted recovery never rewrites a job completed by another connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-recovery-concurrency-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  const otherDatabase = new DatabaseSync(databasePath);
  try {
    otherDatabase.exec("PRAGMA busy_timeout=5000");
    const repository = new RecomputeJobRepository(store.database);
    const otherRepository = new RecomputeJobRepository(otherDatabase);
    const jobId = repository.enqueue("snapshot_refresh", "dataset-1", {});
    assert.equal(repository.claimNext()?.id, jobId);
    assert.equal(otherRepository.complete(jobId, "completed", 1, 1, "Completed elsewhere"), true);

    assert.equal(repository.recoverInterrupted(), 0);
    assert.equal(repository.get(jobId)?.status, "succeeded");
    assert.equal(repository.listEvents(jobId).filter(({ phase }) => phase === "recovered").length, 0);
  } finally {
    otherDatabase.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failure arbitration persists an ordinary running-job failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-failure-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const repository = new RecomputeJobRepository(store.database);
    const jobId = repository.enqueue("snapshot_refresh", "dataset-1", {});
    assert.equal(repository.claimNext()?.id, jobId);
    repository.updateProgress(jobId, "snapshot_refresh", 2, 4, "Refreshing snapshots");

    repository.fail(jobId, new TypeError("snapshot failed"));

    const job = repository.get(jobId);
    assert.deepEqual(
      {
        status: job?.status,
        progressPhase: job?.progressPhase,
        progressCurrent: job?.progressCurrent,
        progressTotal: job?.progressTotal,
        cancelRequested: job?.cancelRequested,
        error: job?.error
      },
      {
        status: "failed",
        progressPhase: "failed",
        progressCurrent: 2,
        progressTotal: 4,
        cancelRequested: false,
        error: { message: "snapshot failed", name: "TypeError" }
      }
    );
    assert.ok(job?.completedAt);
    const event = repository.listEvents(jobId).find(({ phase }) => phase === "failed");
    assert.deepEqual(
      {
        phase: event?.phase,
        progressCurrent: event?.progress_current,
        progressTotal: event?.progress_total,
        message: event?.message
      },
      {
        phase: "failed",
        progressCurrent: 2,
        progressTotal: 4,
        message: "Task failed"
      }
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failOutstanding fails queued jobs and cascades running child runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-fail-outstanding-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const repository = new RecomputeJobRepository(store.database);
    const queuedId = repository.enqueue("full_recompute", "dataset-1", {});
    const runningId = repository.enqueue("full_recompute", "dataset-1", {});
    const cancelledId = repository.enqueue("snapshot_refresh", "dataset-1", {});
    assert.equal(repository.claimNext()?.id, queuedId);
    assert.equal(repository.complete(queuedId, "completed", 1, 1, "Completed"), true);

    assert.equal(repository.claimNext()?.id, runningId);
    store.database.prepare(`
      INSERT INTO feature_runs (
        id, dataset_version, canonical_contract_version, feature_schema_version,
        feature_config_json, feature_config_hash, status
      ) VALUES ('feature_run_outstanding', 'dataset-1', 'canonical-health-v1', 'v1', '{}', 'hash', 'running')
    `).run();
    store.database.prepare(`
      INSERT INTO model_runs (
        id, feature_run_id, dataset_version, model_version, model_config_json,
        model_config_hash, evaluated_at, status
      ) VALUES (
        'model_run_outstanding', 'feature_run_outstanding', 'dataset-1', 'rai_v1',
        '{}', 'hash', '2026-07-17T00:00:00.000Z', 'running'
      )
    `).run();
    store.database.prepare(`
      INSERT INTO training_metric_runs (
        id, model_run_id, algorithm_version, config_json, config_hash,
        timezone_identifier, evaluated_at, status
      ) VALUES (
        'metric_run_outstanding', 'model_run_outstanding', 'v1', '{}', 'hash',
        'UTC', '2026-07-17T00:00:00.000Z', 'running'
      )
    `).run();
    repository.setRunIds(runningId, "feature_run_outstanding", "model_run_outstanding");

    assert.equal(repository.claimNext()?.id, cancelledId);
    assert.equal(repository.requestCancellation(cancelledId).outcome, "cancellation_requested");

    const laterQueuedId = repository.enqueue("snapshot_refresh", "dataset-1", {});
    assert.equal(repository.failOutstanding(new Error("worker thread crashed")), 3);

    assert.equal(repository.get(queuedId)?.status, "succeeded");
    assert.equal(repository.get(runningId)?.status, "failed");
    assert.equal(repository.get(cancelledId)?.status, "cancelled");
    assert.equal(repository.get(laterQueuedId)?.status, "failed");
    assert.equal(
      (store.database.prepare("SELECT status FROM feature_runs WHERE id = 'feature_run_outstanding'")
        .get() as { status: string }).status,
      "failed"
    );
    assert.equal(
      (store.database.prepare("SELECT status FROM model_runs WHERE id = 'model_run_outstanding'")
        .get() as { status: string }).status,
      "failed"
    );
    assert.equal(
      (store.database.prepare("SELECT status FROM training_metric_runs WHERE id = 'metric_run_outstanding'")
        .get() as { status: string }).status,
      "failed"
    );
    assert.match(String(repository.get(runningId)?.error?.message ?? ""), /worker thread crashed/);
    assert.equal(repository.get(cancelledId)?.error, null);
    assert.equal(repository.get(cancelledId)?.cancelRequested, false);
    repository.fail(cancelledId, new Error("duplicate fail after cancel"));
    assert.equal(repository.get(cancelledId)?.status, "cancelled");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
