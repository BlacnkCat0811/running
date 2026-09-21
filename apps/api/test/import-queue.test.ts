import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImportWorker, ImportQueueFullError } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { RuntimeStateStore, type RuntimeImportJobRow } from "../src/runtime-state.js";

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "queue failed to make progress");
    await new Promise((done) => setTimeout(done, 10));
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rai-queue-"));
  const input = join(root, "export");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), "<HealthData/>");
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  const state = new RuntimeStateStore(root);
  const worker = () => new ImportWorker(join(root, "rai.sqlite"), root, root, undefined, undefined, undefined, {
    scope: "fixture", maxPending: 2, admission: scheduler.owner("import")
  });
  return { root, input, mutations, state, worker };
}

test("accepted jobs persist while busy, retain sources, resume FIFO, and deduplicate", async () => {
  const f = fixture();
  const release = f.mutations.acquire("other work");
  let worker = f.worker();
  try {
    const a = worker.create(f.input, undefined, "a");
    const b = worker.create(f.input, undefined, "b");
    assert.equal(worker.create(f.input, undefined, "a").id, a.id);
    assert.equal(worker.get(b.id)?.queuePosition, 2);
    assert.equal(worker.active()?.id, a.id);
    assert.throws(() => worker.create(f.input, undefined, "c"), ImportQueueFullError);
    assert.deepEqual(worker.activeInputPaths(), [f.input, f.input]);
    await worker.close();
    assert.equal(f.state.jobs().find((job) => job.id === a.id)?.status, "queued");
    worker = f.worker();
    const order: string[] = [];
    const surface = worker as unknown as { run(job: RuntimeImportJobRow): Promise<void>; persistJobs(): void };
    surface.run = async (job) => {
      order.push(job.sourceId!);
      job.status = "succeeded";
      job.queue!.finalized = true;
      surface.persistJobs();
    };
    worker.resume();
    release();
    await waitFor(() => order.length === 2 && !worker.isRunning);
    assert.deepEqual(order, ["a", "b"]);
    assert.equal(worker.hasPending, false);
  } finally {
    release(); await worker.close(); rmSync(f.root, { recursive: true, force: true });
  }
});

test("queued cancellation releases its pin without executing and survives restart", async () => {
  const f = fixture();
  const release = f.mutations.acquire("other work");
  let worker = f.worker();
  try {
    const job = worker.create(f.input, undefined, "cancel");
    assert.equal(await worker.cancel(job.id), "cancelled");
    assert.equal(worker.hasPending, false);
    assert.deepEqual(worker.activeInputPaths(), []);
    await worker.close();
    worker = f.worker();
    assert.equal(worker.get(job.id)?.status, "cancelled");
    assert.equal(await worker.cancel(job.id), "terminal");
  } finally {
    release(); await worker.close(); rmSync(f.root, { recursive: true, force: true });
  }
});

test("running work restarts at safe boundary, but a different dataset scope is never replayed", async () => {
  const f = fixture();
  const worker = f.worker();
  try {
    f.state.upsertJob({
      id: "interrupted", status: "running", phase: "recompute", message: "",
      createdAt: new Date().toISOString(), completedAt: null, error: null,
      inputPath: f.input, preserveAbsent: true, queue: { scope: "fixture", attempts: 1, finalized: false }
    });
    const resumed = f.worker();
    assert.equal(resumed.get("interrupted")?.status, "queued");
    assert.equal(f.state.jobs().find((job) => job.id === "interrupted")?.preserveAbsent, true);
    await resumed.close();
    const other = new ImportWorker(join(f.root, "rai.sqlite"), f.root, f.root, undefined, undefined, undefined, {
      scope: "other-dataset", admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
    });
    assert.equal(other.get("interrupted")?.status, "failed");
    assert.equal(other.hasPending, false);
    await other.close();
  } finally {
    await worker.close(); rmSync(f.root, { recursive: true, force: true });
  }
});

test("idempotency and job lookup outlive the latest twenty completed jobs", async () => {
  const f = fixture();
  let worker: ImportWorker | undefined;
  try {
    for (let index = 0; index < 25; index++) {
      f.state.upsertJob({
        id: `job-${index}`, sourceId: `source-${index}`, status: "succeeded", phase: "completed", message: "",
        createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: null,
        inputPath: f.input, queue: { scope: "fixture", attempts: 1, finalized: true }
      });
    }
    worker = f.worker();
    assert.equal(worker.findBySourceId("source-0")?.id, "job-0");
    assert.equal(worker.get("job-0")?.status, "succeeded");
    assert.equal(worker.create(f.input, undefined, "source-0").id, "job-0");
    assert.equal(worker.hasPending, false);
  } finally {
    await worker?.close(); rmSync(f.root, { recursive: true, force: true });
  }
});
