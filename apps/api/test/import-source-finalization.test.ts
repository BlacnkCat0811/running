import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { finalizeImportSource } from "../src/import-source-finalization.js";
import { ImportSourceManager } from "../src/import-sources.js";
import { ImportWorker } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { registerImportRoutes } from "../src/routes/import-routes.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import type { ImportJobResponse } from "@rai/api-contracts";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(beforeFinalize: () => Promise<void> = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), "rai-source-finalization-"));
  const sourceId = "upload_fixture";
  const directory = join(root, "var/imports", sourceId);
  const input = join(directory, "extracted");
  mkdirSync(input, { recursive: true });
  writeFileSync(join(input, "export.xml"), "<HealthData/>");
  const sources = new ImportSourceManager(root, root);
  const state = new RuntimeStateStore(root);
  state.upsertSource({
    id: sourceId, kind: "upload", displayName: "export.zip",
    inputPath: input, originalPath: join(directory, "source.zip"),
    sourceSha256: null, exportFileName: "export.xml", exportBytes: 13,
    routeFileCount: 0, modifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), lastUsedAt: null
  });
  const mutations = new MutationCoordinator();
  const sourceMutations = new MutationCoordinator();
  const releaseWriter = mutations.acquire("fixture writer");
  const worker: ImportWorker = new ImportWorker(join(root, "main.sqlite"), root, root,
    undefined, undefined, undefined, {
      scope: "fixture", admission: new TaskAdmissionScheduler(mutations).owner("import"),
      onTerminal: async (job, succeeded, durable) => {
        await beforeFinalize();
        await finalizeImportSource(sources, sourceMutations, worker, job, succeeded, durable);
      }
    });
  const app = Fastify();
  registerImportRoutes(app, { importWorker: worker, importSources: sources, sourceMutations, scopeSyncBatchId: (id) => id });
  await app.ready();
  return {
    sources, state, worker, app, sourceId, input,
    submit: () => app.inject({ method: "POST", url: "/v1/import-jobs", payload: { sourceId } }),
    close: async () => {
      await worker.close(); releaseWriter(); await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("source cleanup excludes concurrent enqueue until removal is finished", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const entered = barrier(), proceed = barrier();
  const cleanup = f.sources.cleanupUpload.bind(f.sources);
  f.sources.cleanupUpload = async (...args) => {
    entered.release();
    await proceed.promise;
    return cleanup(...args);
  };
  let cancellation: Promise<unknown> | undefined;
  try {
    const first = await f.submit();
    assert.equal(first.statusCode, 202);
    cancellation = f.worker.cancel(first.json().id);
    await entered.promise;
    assert.equal(f.worker.hasPending, true, "terminal cleanup is still pending");
    const retry = await f.submit();
    assert.equal(retry.statusCode, 409, retry.body);
    proceed.release();
    await cancellation;
    assert.equal(existsSync(f.input), false);
    assert.equal((await f.submit()).statusCode, 404);
    assert.equal(f.worker.hasPending, false);
  } finally { proceed.release(); await cancellation; await f.close(); }
});

test("a retry accepted before cleanup keeps its source without blocking queue finalization", { timeout: 10_000 }, async () => {
  const entered = barrier(), proceed = barrier();
  const f = await fixture(async () => { entered.release(); await proceed.promise; });
  let cancellation: Promise<unknown> | undefined;
  try {
    const first = await f.submit();
    const firstId = first.json().id as string;
    cancellation = f.worker.cancel(firstId);
    await entered.promise;
    const retry = await f.submit();
    assert.equal(retry.statusCode, 202, retry.body);
    const retryId = retry.json().id as string;
    assert.notEqual(firstId, retryId);
    proceed.release();
    await cancellation;
    assert.equal(f.state.job(firstId)?.queue?.finalized, true);
    assert.equal(f.worker.get(retryId)?.status, "queued");
    assert.ok(existsSync(join(f.input, "export.xml")));
    assert.ok(await f.sources.get(f.sourceId));
    assert.deepEqual(f.worker.activeInputPaths(firstId), [f.input]);
    // The final owner can clean up; the old task must not pin it forever.
    await f.worker.cancel(retryId);
    assert.equal(existsSync(f.input), false);
    assert.equal(f.worker.hasPending, false);
  } finally { proceed.release(); await cancellation; await f.close(); }
});

test("failed uploads remain inspectable until the bounded abandoned-upload sweep", async () => {
  const f = await fixture();
  try {
    const source = (await f.sources.get(f.sourceId))!;
    const job: ImportJobResponse = {
      id: "failed-fixture", sourceId: f.sourceId, status: "failed", phase: "failed",
      message: "failed", createdAt: source.createdAt, completedAt: new Date().toISOString(),
      error: "导入失败，请查看服务日志"
    };
    f.state.upsertJob({ ...job, inputPath: f.input, queue: { scope: "fixture", attempts: 1, finalized: false } });
    await finalizeImportSource(f.sources, new MutationCoordinator(), f.worker, job, false, true);
    assert.ok(await f.sources.get(f.sourceId), "failure must not immediately destroy the actual input");
    assert.equal((await f.sources.inspect(f.sourceId)).sourceId, f.sourceId);
    assert.equal((await f.sources.get(f.sourceId))?.lastUsedAt, null, "failed data must not be marked imported");
    const uploadedAt = Date.parse(source.createdAt);
    assert.equal(await f.sources.cleanupAbandonedUploads(uploadedAt + 25 * 3600_000), 0,
      "terminal persistence/ownership must protect the input until finalization");
    f.state.upsertJob({ ...job, inputPath: f.input, queue: { scope: "fixture", attempts: 1, finalized: true } });
    assert.equal(await f.sources.cleanupAbandonedUploads(uploadedAt + 23 * 3600_000), 0);
    assert.equal(await f.sources.cleanupAbandonedUploads(uploadedAt + 25 * 3600_000), 1);
    assert.equal(await f.sources.get(f.sourceId), null);
    assert.equal(existsSync(f.input), false);
  } finally { await f.close(); }
});
