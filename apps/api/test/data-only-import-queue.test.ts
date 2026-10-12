import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CONTRACT_VERSION } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";
import { ImportWorker } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { readImportReceipt } from "../src/import-publication.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { RaiReadStore } from "../src/data.js";
import type { ImportDatabaseTask } from "../src/import-database-tasks.js";
import { applyDataOnlyImport, dataOnlyBaselineContract } from "../src/data-only-import.js";
import { computeImportPayloadSha256 } from "../src/import-payload-identity.js";
import { NATIVE_VERSION } from "@rai/health-export-parser";

const uuid = "00000000-0000-0000-0000-00000000000a";
const project = resolve(import.meta.dirname, "../../..");
interface Surface {
  createCurrentBackup(id: string): Promise<string | null>;
  command(args: string[]): Promise<void>;
  databaseTask<T>(task: ImportDatabaseTask): Promise<T>;
}

async function fixture(run: (ctx: {
  root: string; main: string; input: string;
  make(enabled?: boolean): ImportWorker;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "rai-fast-queue-"));
  const main = join(root, "main.sqlite");
  const input = join(root, "input"); mkdirSync(input);
  writeFileSync(join(input, "export.xml"), `<HealthData><Record type="HKQuantityTypeIdentifierStepCount"
    sourceName="Watch" unit="count" value="10" startDate="2026-01-01 00:00:00 +0000"
    endDate="2026-01-01 00:01:00 +0000"><MetadataEntry key="RAIHealthKitSampleUUID"
    value="${uuid}"/></Record></HealthData>`);
  writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
    version: 2, sourceScope: "healthkit", deletedSourceIds: [], deletedRecords: []
  }));
  const store = await RaiDatabase.open(main);
  store.setManifest("dataset_version", "baseline");
  store.setManifest("parser_contract_version", CONTRACT_VERSION);
  store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  store.setManifest("data_only_baseline_contract", dataOnlyBaselineContract());
  store.close();
  const make = (enabled = true) => new ImportWorker(main, project, root, () => {
    throw new Error("delta must not enter the replacement gate");
  }, undefined, undefined, {
    scope: "fixture", dataOnlyFastPath: enabled,
    admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
  });
  try { await run({ root, main, input, make }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

async function wait(worker: ImportWorker) {
  const deadline = Date.now() + 30_000;
  while (worker.hasPending || worker.isRunning) {
    assert.ok(Date.now() < deadline, JSON.stringify(worker.latest()));
    await new Promise(done => setTimeout(done, 25));
  }
}
function forbidBulk(worker: ImportWorker) {
  const surface = worker as unknown as Surface;
  surface.createCurrentBackup = async () => { throw new Error("delta must not back up the whole database"); };
  surface.command = async () => { throw new Error("delta must not invoke the import/recompute CLI"); };
}

test("real queued v2 deltas use no backup, candidate, audit, recompute or publication gate and invalidate cached reads", async () => {
  await fixture(async ({ root, main, input, make }) => {
    let worker = make();
    const reader = new RaiReadStore(main);
    const beforeVersion = reader.dataSummary().datasetVersion;
    forbidBulk(worker);
    try {
      const job = worker.create(input, undefined, "fast-source");
      await wait(worker);
      const done = worker.get(job.id)!;
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      assert.ok(done.performance?.stagesMs.dataOnlyApply! > 0);
      for (const stage of ["backupCapacity", "backupCopy", "backupVerify", "stagingCopy", "parseImport",
        "recompute", "activationAudit", "activationSwap"] as const) {
        assert.equal(done.performance?.stagesMs[stage], undefined, `${stage} must not run`);
      }
      assert.equal(done.summary?.backupName, null);
      assert.equal(done.summary?.featuresRecomputed, 0);
      assert.ok(readImportReceipt(main, job.id));
      assert.notEqual(reader.dataSummary().datasetVersion, beforeVersion, "PRAGMA data_version refreshes existing caches");
      assert.equal(worker.create(input, undefined, "fast-source").id, job.id);
      assert.equal(readdirSync(join(root, "var")).some(name => /rai\.importing|backups/.test(name)), false);
      await worker.close();
      worker = make();
      assert.equal(worker.get(job.id)?.status, "succeeded");
      assert.equal(worker.hasPending, false);
      const db = new DatabaseSync(main, { readOnly: true });
      try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_records").get()!.n, 1); }
      finally { db.close(); }
    } finally { reader.close(); await worker.close(); }
  });
});

test("a reply lost after the real SQLite COMMIT is recovered as success, not reported as failed", async () => {
  await fixture(async ({ main, input, make }) => {
    const worker = make();
    forbidBulk(worker);
    const surface = worker as unknown as Surface;
    const original = surface.databaseTask.bind(worker);
    surface.databaseTask = async <T>(task: ImportDatabaseTask): Promise<T> => {
      const result = await original<T>(task);
      if (task.operation === "data-only" && result) throw new Error("fixture lost reply after COMMIT");
      return result;
    };
    try {
      const job = worker.create(input, undefined, "lost-reply");
      await wait(worker);
      assert.equal(worker.get(job.id)?.status, "succeeded", JSON.stringify(worker.get(job.id)));
      assert.ok(readImportReceipt(main, job.id));
      assert.equal(worker.get(job.id)?.error, null);
    } finally { await worker.close(); }
  });
});

test("restart acknowledges a committed delta whose runtime job was never completed, without reading the missing upload", async () => {
  await fixture(async ({ root, main, input, make }) => {
    const jobId = "committed-before-crash";
    assert.ok(await applyDataOnlyImport({
      databasePath: main, inputPath: input, jobId,
      payloadSha256: await computeImportPayloadSha256(input, {
        preserveAbsent: true, contractVersion: CONTRACT_VERSION,
        engine: `typescript@${NATIVE_VERSION}`, identityAlgorithm: identityAlgorithmFingerprint()
      }), startedAtMs: Date.now()
    }));
    const runtime = new RuntimeStateStore(root);
    runtime.upsertJob({
      id: jobId, status: "running", phase: "activate", message: "", createdAt: new Date().toISOString(),
      completedAt: null, error: null, inputPath: join(root, "missing"),
      preserveAbsent: true, queue: { scope: "fixture", attempts: 1, finalized: false }
    });
    const worker = make();
    forbidBulk(worker);
    try {
      assert.equal(worker.get(jobId)?.status, "succeeded");
      worker.resume();
      await wait(worker);
      assert.equal(runtime.job(jobId)?.queue?.finalized, true);
      assert.ok(readImportReceipt(main, jobId));
    } finally { await worker.close(); }
  });
});

test("the rollback flag disables live transactions and restores the existing candidate path", async () => {
  await fixture(async ({ main, input, make }) => {
    const worker = make(false);
    let copies = 0;
    (worker as unknown as Surface).createCurrentBackup = async () => {
      copies++;
      throw new Error("fixture normal backup path");
    };
    try {
      const job = worker.create(input);
      await wait(worker);
      assert.equal(copies, 1);
      assert.equal(worker.get(job.id)?.status, "failed");
      assert.equal(worker.get(job.id)?.performance?.stagesMs.dataOnlyApply, undefined);
      assert.equal(readImportReceipt(main, job.id), null);
      const db = new DatabaseSync(main, { readOnly: true });
      try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_records").get()!.n, 0); }
      finally { db.close(); }
    } finally { await worker.close(); }
  });
});

test("the actual candidate pipeline establishes qualification, and the next correction uses the zero-copy lane", async () => {
  await fixture(async ({ root, main, input, make }) => {
    const db = new DatabaseSync(main);
    db.exec("DELETE FROM import_manifest WHERE key IN ('parser_identity_algorithm','data_only_baseline_contract')");
    db.close();
    let publications = 0;
    let worker = new ImportWorker(main, project, root, () => { publications++; },
      undefined, undefined, {
        scope: "fixture", admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
      });
    try {
      const initial = worker.create(input, undefined, "qualification-source");
      await wait(worker);
      assert.equal(worker.get(initial.id)?.status, "succeeded", JSON.stringify(worker.get(initial.id)));
      assert.equal(publications, 1);
      assert.ok(worker.get(initial.id)?.performance?.stagesMs.backupCopy! > 0);
      const qualified = new DatabaseSync(main, { readOnly: true });
      try {
        assert.equal(qualified.prepare("SELECT value FROM import_manifest WHERE key='data_only_baseline_contract'").get()!.value,
          dataOnlyBaselineContract());
      } finally { qualified.close(); }
      await worker.close();
      worker = make();
      forbidBulk(worker);
      const correction = join(root, "correction"); mkdirSync(correction);
      writeFileSync(join(correction, "export.xml"), readFileSync(join(input, "export.xml"), "utf8").replace('value="10"', 'value="20"'));
      writeFileSync(join(correction, "sync-manifest.json"), readFileSync(join(input, "sync-manifest.json")));
      const next = worker.create(correction, undefined, "qualified-correction");
      await wait(worker);
      assert.equal(worker.get(next.id)?.status, "succeeded", JSON.stringify(worker.get(next.id)));
      assert.ok(worker.get(next.id)?.performance?.stagesMs.dataOnlyApply! > 0);
      assert.equal(worker.get(next.id)?.performance?.stagesMs.backupCopy, undefined);
      const accepted = new DatabaseSync(main, { readOnly: true });
      try {
        assert.equal(accepted.prepare("SELECT value_numeric FROM health_records").get()!.value_numeric, 20);
        assert.equal(accepted.prepare("SELECT value FROM import_manifest WHERE key='audit_report_pending_version'").get()!.value,
          accepted.prepare("SELECT value FROM import_manifest WHERE key='dataset_version'").get()!.value);
      } finally { accepted.close(); }
    } finally { await worker.close(); }
  });
});
