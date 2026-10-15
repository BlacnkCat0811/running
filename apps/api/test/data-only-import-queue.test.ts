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
import { applyDataOnlyImport } from "../src/data-only-import.js";
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

test("回退开关关闭直连通路 ⇒ 显式失败 direct_sync_unavailable；候选链路不得回来", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"`dataOnlyFastPath=false` ⇒ 退回候选链路
  // （`createCurrentBackup` 恰好被调 1 次）"。D1 收口后语义相反：关闭开关是**暂停同步入口**
  // （`fast_path_disabled` ⇒ `direct_sync_unavailable`），任何候选动作都不许再发生。
  // `forbidBulk` 让"候选被重新接回"直接以异常方式炸出来，而不是悄悄多跑一次整库备份。
  await fixture(async ({ main, input, make }) => {
    const worker = make(false);
    forbidBulk(worker);
    try {
      const job = worker.create(input);
      await wait(worker);
      const stored = worker.get(job.id);
      assert.equal(stored?.status, "failed");
      assert.equal(stored?.failureCode, "direct_sync_unavailable");
      assert.equal(stored?.performance?.lane?.outcome, "fallback");
      assert.deepEqual(stored?.performance?.lane?.reasons, ["fast_path_disabled"]);
      assert.equal(stored?.performance?.stagesMs.dataOnlyApply, undefined,
        "入口被暂停 ⇒ 连快通路都不许被尝试");
      for (const stage of ["backupCapacity", "backupCopy", "backupVerify", "stagingCopy", "parseImport",
        "recompute", "activationAudit", "activationSwap"] as const) {
        assert.equal(stored?.performance?.stagesMs[stage], undefined, `${stage} 不得运行（候选链路已删）`);
      }
      assert.equal(readImportReceipt(main, job.id), null);
      const db = new DatabaseSync(main, { readOnly: true });
      try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_records").get()!.n, 0); }
      finally { db.close(); }
    } finally { await worker.close(); }
  });
});

test("缺身份代际的库 ⇒ 显式失败 direct_sync_baseline_rebuild_required；不再走任何候选/备份路径", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例验证"候选链路建立资格、下一批改用零拷贝车道"
  // （资格 = 一次整库备份换来的）。资格语义已删；S3.2 的三态在收口后的判据：
  // 有身份痕迹但与当前契约/身份算法不符 ⇒ **显式失败** `baseline_rebuild_required`
  // （运维显式处置，客户端不能自动修）；两条车道的拒收都进遥测，主库零写入。
  await fixture(async ({ main, input, make }) => {
    const db = new DatabaseSync(main);
    db.exec("DELETE FROM import_manifest WHERE key = 'parser_identity_algorithm'");
    db.close();
    const worker = make();
    forbidBulk(worker);
    try {
      const job = worker.create(input, undefined, "qualification-source");
      await wait(worker);
      const stored = worker.get(job.id);
      assert.equal(stored?.status, "failed", JSON.stringify(stored));
      assert.equal(stored?.failureCode, "direct_sync_baseline_rebuild_required");
      assert.equal(stored?.performance?.lane?.outcome, "fallback");
      // ⚠️ 顺序在本用例里是断言的一部分：快通路**先被尝试并拒收**（缺基线戳），
      // 统一接收器随后按身份三态拒收 —— 两条拒因都要如实留痕。
      assert.ok((stored?.performance?.stagesMs.dataOnlyApply ?? 0) > 0,
        "record-only 快通路必须先被尝试（阶段账本里要有它的耗时）");
      const rejections = (stored?.performance?.lane?.rejections ?? [])
        .map((entry) => `${entry.source}:${entry.reason}`);
      assert.ok(rejections.includes("data-only:fast_path_rejected"),
        `快通路拒收必须留痕（实际 ${JSON.stringify(rejections)}）`);
      assert.ok(rejections.includes("direct-sync:baseline_rebuild_required"),
        `接收器拒收必须留痕（实际 ${JSON.stringify(rejections)}）`);
      for (const stage of ["backupCapacity", "backupCopy", "backupVerify", "stagingCopy", "parseImport",
        "recompute", "activationAudit", "activationSwap"] as const) {
        assert.equal(stored?.performance?.stagesMs[stage], undefined, `${stage} 不得运行（候选链路已删）`);
      }
      assert.equal(readImportReceipt(main, job.id), null);
      const unchanged = new DatabaseSync(main, { readOnly: true });
      try {
        assert.equal(unchanged.prepare("SELECT COUNT(*) AS n FROM health_records").get()!.n, 0);
        assert.equal(
          (unchanged.prepare("SELECT value FROM import_manifest WHERE key='dataset_version'").get() as { value: string }).value,
          "baseline"
        );
      } finally { unchanged.close(); }
    } finally { await worker.close(); }
  });
});
