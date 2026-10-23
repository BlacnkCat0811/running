// P3-02（阶段 3，§3.2 R1/R2 / §6）：新回执字段收口与历史回执兼容。
//
// 这个文件只回答三个生产者在新回执上的**同一份合同**：
//   · no-op：显式 `analysisJobId: null`（R1），dependencyGeneration 为 null；
//   · direct-sync / not_required：dependencyGeneration 为 null（R2），analysisJobId 为 null；
//   · direct-sync / queued：analysisJobId 非空，且 receipt = batch summary = 持久任务，
//     dependencyGeneration 同时等于任务目标代次与 `import_generations` 当前代次。
// 另外用一份**旧格式回执**（缺 `analysisJobId`、dependencyGeneration 为 "7"）证明：
// 读取不补键、不改值、重启恢复原样返回，回执不是"读出来再格式化一遍"的投影。
//
// 全部路径都走真实 ImportWorker / 常驻 ingest 线程 / 真实 SQLite 事务，不 mock 车道。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ImportJobResponse } from "@rai/api-contracts";
import { CONTRACT_VERSION } from "@rai/contracts";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

import { ImportWorker } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { readImportReceipt, readImportReceiptStrict } from "../src/import-publication.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";

const project = resolve(import.meta.dirname, "../../..");
const scope = "receipt-fields-fixture";

/** record-only 白名单记录 + 唯一 UUID（形状同 `import-worker-reuse.test.ts`）。 */
const recordOnlyXml = (index: number): string => `<HealthData><Record
    type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="10"
    startDate="2026-01-01 00:00:00 +0000" endDate="2026-01-01 00:0${index % 10}:00 +0000">
    <MetadataEntry key="RAIHealthKitSampleUUID"
      value="00000000-0000-0000-0000-0000000000${String(index).padStart(2, "0")}"/>
  </Record></HealthData>`;

/** 同一份 record-only XML 扩大到 data-only 的 2 MiB 门槛之上（仍低于 direct-sync 的 8 MiB）。 */
const oversizedRecordOnlyXml = (index: number): string => {
  const record = recordOnlyXml(index);
  const head = "<HealthData>";
  assert.ok(record.startsWith(head) && record.endsWith("</HealthData>"));
  const body = record.slice(head.length, -"</HealthData>".length);
  // 纯空白文本不会变成 Record，也不会改变载荷分类；只让 fast-path 因字节门槛拒收。
  return `${head}${" ".repeat(2 * 1024 * 1024 + 4096)}${body}</HealthData>`;
};

const WORKOUT_XML = `<HealthData><Workout workoutActivityType="HKWorkoutActivityTypeRunning"
    sourceName="Watch" duration="30" durationUnit="min"
    startDate="2026-01-02 08:00:00 +0000" endDate="2026-01-02 08:30:00 +0000">
    <MetadataEntry key="RAIHealthKitWorkoutUUID" value="00000000-0000-0000-0000-0000000000ff"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
  </Workout></HealthData>`;

interface Fixture {
  root: string;
  main: string;
  writeInput(name: string, xml: string): string;
}

async function fixture(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-receipt-fields-"));
  const main = join(root, "main.sqlite");
  const store = await RaiDatabase.open(main);
  try {
    store.setManifest("dataset_version", "baseline");
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
    store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  } finally {
    store.close();
  }
  const writeInput = (name: string, xml: string): string => {
    const input = join(root, name);
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "export.xml"), xml);
    writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
      version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
    }));
    return input;
  };
  try {
    await run({ root, main, writeInput });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeWorker(root: string, main: string): ImportWorker {
  return new ImportWorker(main, project, root, () => {
    throw new Error("delta must not enter the replacement gate");
  }, undefined, undefined, {
    scope, dataOnlyFastPath: true,
    admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
  });
}

async function runBatch(worker: ImportWorker, input: string, sourceId: string): Promise<ImportJobResponse> {
  const job = worker.create(input, undefined, sourceId);
  const deadline = Date.now() + 60_000;
  while (worker.hasPending || worker.isRunning) {
    assert.ok(Date.now() < deadline, JSON.stringify(worker.latest()));
    await new Promise((done) => setTimeout(done, 10));
  }
  return worker.get(job.id)!;
}

function readRows<T>(
  path: string,
  sql: string,
  parameters: Array<string | number | bigint | null | Uint8Array> = []
): T[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).all(...parameters) as T[]; }
  finally { db.close(); }
}

interface RecomputeJobRow {
  id: string;
  jobType: string;
  status: string;
  dependencyGeneration: number;
  request: string;
}

function recomputeJobsForBatch(path: string, batchId: string): RecomputeJobRow[] {
  return readRows<RecomputeJobRow>(path, `SELECT id, job_type AS jobType, status,
      target_dependency_generation AS dependencyGeneration, request_json AS request
    FROM recompute_jobs ORDER BY created_at, id`)
    .filter((row) => (JSON.parse(row.request) as { importBatchId?: unknown }).importBatchId === batchId);
}

function readBatchSummary(path: string, batchId: string): Record<string, unknown> {
  const row = readRows<{ summary: string }>(path,
    "SELECT summary_json AS summary FROM import_batches WHERE id = ?", [batchId])[0];
  assert.ok(row, `batch ${batchId} must exist`);
  return JSON.parse(row.summary) as Record<string, unknown>;
}

/** 直接写 manifest：历史回执就是数据库里已经存在的一行，不能靠新代码“重新生成”。 */
function writeManifestValue(path: string, key: string, value: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)").run(key, value);
  } finally { db.close(); }
}

function readManifestValue(path: string, key: string): string | undefined {
  return readRows<{ value: string }>(path,
    "SELECT value FROM import_manifest WHERE key = ?", [key])[0]?.value;
}

test("no-op：新回执显式 analysisJobId=null，dependencyGeneration=null，不登记本批分析任务", async () => {
  await fixture(async ({ root, main, writeInput }) => {
    const worker = makeWorker(root, main);
    try {
      const input = writeInput("noop-input", recordOnlyXml(0));
      const first = await runBatch(worker, input, "noop-first");
      assert.equal(first.status, "succeeded", JSON.stringify(first));

      // 同一个目录、同一份字节，换 sourceId 让 worker 不能按来源 id 直接返回旧 job。
      const second = await runBatch(worker, input, "noop-second");
      assert.equal(second.status, "succeeded", JSON.stringify(second));
      assert.equal(second.summary?.importMode, "unchanged");

      const receipt = readImportReceipt(main, second.id);
      assert.ok(receipt, "no-op 必须留下持久回执");
      assert.equal(Object.hasOwn(receipt, "analysisJobId"), true,
        "新 no-op 回执必须显式带 analysisJobId 键（缺键只表示旧服务端）");
      assert.equal(receipt.analysisJobId, null, "no-op 不登记分析任务 ⇒ 显式 null");
      assert.equal(receipt.directSync?.analysisStatus, "not_required");
      assert.equal(receipt.directSync?.dependencyGeneration, null);
      assert.deepEqual(receipt, second.summary, "内存终态与持久回执必须同源");

      assert.deepEqual(recomputeJobsForBatch(main, second.id), [],
        "no-op 不得为本批登记 recompute_jobs 行");
    } finally {
      await worker.close();
    }
  });
});

test("direct-sync record-only：新回执 dependencyGeneration=null / analysisJobId=null，无本批任务", async () => {
  await fixture(async ({ root, main, writeInput }) => {
    const worker = makeWorker(root, main);
    try {
      const done = await runBatch(worker, writeInput("record-only", oversizedRecordOnlyXml(1)), "record-only");
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      // 先被 data-only 以字节门槛拒收，再落到 direct-sync；否则这条用例证明不了 direct-sync 的回执。
      assert.ok((done.performance?.stagesMs?.dataOnlyApply ?? 0) > 0);
      assert.ok((done.performance?.stagesMs?.directSyncApply ?? 0) > 0);

      const receipt = readImportReceipt(main, done.id);
      assert.ok(receipt, "direct-sync 必须留下持久回执");
      assert.equal(receipt.directSync?.ingestStatus, "committed");
      assert.equal(receipt.directSync?.analysisStatus, "not_required");
      assert.equal(receipt.directSync?.dependencyGeneration, null,
        "R2：本批不影响分析时依赖代次必须是 null，不是全局计数器的字符串");
      assert.equal(Object.hasOwn(receipt, "analysisJobId"), true);
      assert.equal(receipt.analysisJobId, null, "not_required 批次必须显式声明没有分析任务");
      assert.deepEqual(recomputeJobsForBatch(main, done.id), [],
        "not_required 批次不得登记本批分析任务");

      // 真实代次仍照常持久化：raw 前进、dependency 不动，批次行声明自己的足迹。
      const generations = readRows<{ raw: number; dependency: number }>(main,
        "SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton = 1")[0]!;
      assert.equal(Number(generations.raw), 1, "direct-sync 成功批次仍推进 raw 代次");
      assert.equal(Number(generations.dependency), 0, "not_required 批次不得推进 dependency 代次");
      const batch = readRows<{ dependency: number; bumped: number }>(main,
        "SELECT dependency_generation AS dependency, dependency_bumped AS bumped FROM import_batches WHERE id = ?",
        [done.id])[0]!;
      assert.equal(Number(batch.dependency), 0);
      assert.equal(Number(batch.bumped), 0);
    } finally {
      await worker.close();
    }
  });
});

test("direct-sync queued：回执/批次/任务三处 analysisJobId 同源，dependencyGeneration 与两处代次一致", async () => {
  await fixture(async ({ root, main, writeInput }) => {
    const worker = makeWorker(root, main);
    try {
      const done = await runBatch(worker, writeInput("workout", WORKOUT_XML), "workout-queued");
      assert.equal(done.status, "succeeded", JSON.stringify(done));

      const receipt = readImportReceipt(main, done.id);
      assert.ok(receipt, "queued 批次必须留下持久回执");
      assert.equal(receipt.directSync?.analysisStatus, "queued");
      assert.ok(receipt.analysisJobId, "queued 批次必须给出非空分析任务 id");
      assert.deepEqual(receipt, done.summary, "内存终态与持久回执必须同源");

      const jobs = recomputeJobsForBatch(main, done.id);
      assert.equal(jobs.length, 1, "queued 批次必须恰好登记一个本批任务");
      const job = jobs[0]!;
      assert.equal(job.id, receipt.analysisJobId, "receipt.analysisJobId 必须等于持久 task.id");
      assert.equal(job.jobType, "import");
      assert.equal(job.status, "queued");
      assert.equal(receipt.directSync?.dependencyGeneration, String(job.dependencyGeneration),
        "回执依赖代次必须等于任务目标代次");

      const generations = readRows<{ dependency: number }>(main,
        "SELECT dependency_generation AS dependency FROM import_generations WHERE singleton = 1")[0]!;
      assert.equal(receipt.directSync?.dependencyGeneration, String(generations.dependency),
        "回执依赖代次必须等于 import_generations 当前代次");

      const batch = readBatchSummary(main, done.id);
      assert.equal(batch.analysisJobId, receipt.analysisJobId,
        "import_batches.summary_json.analysisJobId 必须与回执同源");
    } finally {
      await worker.close();
    }
  });
});

test("历史回执：缺 analysisJobId / dependencyGeneration=\"7\" 原样读取，重启恢复不改写", async () => {
  await fixture(async ({ root, main, writeInput }) => {
    const batchId = "historical-not-required-batch";
    const input = writeInput("historical-input", recordOnlyXml(2));
    const oldReceipt: NonNullable<ImportJobResponse["summary"]> = {
      recomputeReasons: ["data_only_transaction"],
      importMode: "incremental",
      insertedWorkouts: 0,
      updatedWorkouts: 0,
      removedWorkouts: 0,
      unchangedWorkouts: 0,
      routesUpdated: 0,
      featuresReused: 0,
      featuresRecomputed: 0,
      modelReplayFrom: null,
      durationMs: 123,
      backupName: null,
      directSync: {
        ingestStatus: "committed",
        analysisStatus: "not_required",
        receiptId: batchId,
        dependencyGeneration: "7",
        publishedReleaseId: null,
        parentBatchId: null
      }
    };
    const rawJson = JSON.stringify(oldReceipt);
    assert.equal(Object.hasOwn(oldReceipt, "analysisJobId"), false, "夹具必须是旧格式：没有 analysisJobId 键");
    writeManifestValue(main, `rai.applied-import.${batchId}`, rawJson);
    const db = new DatabaseSync(main);
    try {
      db.prepare(`INSERT INTO import_batches (id, xml_sha256, status, import_mode, summary_json)
        VALUES (?, ?, 'succeeded', 'incremental', '{}')`).run(batchId, "0".repeat(64));
    } finally { db.close(); }

    // 新进程（新 ImportWorker）之前的读取：宽松与严格路径都必须原样返回。
    const loose = readImportReceipt(main, batchId);
    assert.ok(loose);
    assert.equal(Object.hasOwn(loose, "analysisJobId"), false, "读取不得补出 analysisJobId 键");
    assert.equal(loose.directSync?.dependencyGeneration, "7", "历史非空依赖代次必须保留");
    assert.deepEqual(loose, oldReceipt);
    const strict = readImportReceiptStrict(main, batchId);
    assert.ok(strict);
    assert.equal(Object.hasOwn(strict, "analysisJobId"), false);
    assert.deepEqual(strict, oldReceipt);

    // 持久化一个“已排队但重启前未收到回复”的作业；新 ImportWorker 的 loadJobs 必须用
    // 持久回执恢复成 succeeded，并把**那一份** summary 原样交给调用方。
    new RuntimeStateStore(root).upsertJob({
      id: batchId,
      sourceId: "historical-source",
      status: "queued",
      phase: "queued",
      message: "导入任务已排队",
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      error: null,
      inputPath: input,
      queue: { scope, attempts: 0, finalized: false }
    });

    const worker = makeWorker(root, main);
    try {
      const recovered = worker.get(batchId);
      assert.equal(recovered?.status, "succeeded", JSON.stringify(recovered));
      assert.deepEqual(recovered?.summary, oldReceipt, "恢复必须返回持久回执本身，而不是重新拼一份");
      assert.equal(Object.hasOwn(recovered!.summary!, "analysisJobId"), false);

      // 重放路径：同 sourceId 直接返回原 succeeded job，不得触发新回执写入。
      const replay = worker.create(input, undefined, "historical-source");
      assert.equal(replay.id, batchId);
      assert.deepEqual(replay.summary, oldReceipt);
    } finally {
      await worker.close();
    }

    assert.equal(readManifestValue(main, `rai.applied-import.${batchId}`), rawJson,
      "重启/重放不得改写历史回执的字节");
    assert.deepEqual(readImportReceipt(main, batchId), oldReceipt);
    assert.deepEqual(readImportReceiptStrict(main, batchId), oldReceipt);
  });
});
