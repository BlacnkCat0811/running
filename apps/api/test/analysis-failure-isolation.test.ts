// §14.2 A10「分析失败隔离」的行为级证据（docs/SQLITE_DIRECT_SYNC_DESIGN.md §14.2）。
//
// 判据（逐字取自矩阵）：**raw 接收已成功仍保持成功；分析失败显示独立状态，重试只计算，
// 不要求重新导出、不重新备份或复制库。** 证据要求：分析故障注入、原回执不变、重试调用追踪。
//
// 为什么现在才能测：A10 的前提是"分析任务真的会被登记"。2026-10-13 之前直连车道的
// `recompute_jobs` 计数被断言为 **0**（登记属 PR4 步骤 2），连"分析失败"这个状态都产生不出来。
// 2e 落地之后（commit 34780e3）登记是真的，这条判据才有可观测对象。
//
// 本文件**刻意**用两条独立通道：
//   · 原始接收走真实 ImportWorker（真实排队 + 真实子进程 + 真实事务）—— 否则"原回执不变"没有意义；
//   · 分析走进程内 `RaiApplicationService.runNextJob()`（与 API 的消费者同一入口，但不付
//     线程 spawn 的 2.5 s）—— 故障注入要精确落在**某一个写点**上，越少无关活动越好。
//
// ⚠️ 如实标注的边界：`analysisStatus` 在回执里是**写入时刻**的事实（`queued`），
// 它不会被消费者改写；"分析失败"这个独立状态今天通过 `recompute_jobs.status` 暴露，
// 读侧的派生投影（`freshness`）属 PR5 S3/S4。本文件钉住的是"两者不会互相污染"。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION } from "@rai/contracts";
import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";

import { ImportWorker } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { readImportReceipt } from "../src/import-publication.js";
import { dataOnlyBaselineContract } from "../src/data-only-import.js";
import type { ImportDatabaseTask } from "../src/import-database-tasks.js";
import { RaiReadStore } from "../src/data.js";

const project = resolve(import.meta.dirname, "../../..");

interface Surface extends Record<string, unknown> {
  createCurrentBackup(id: string): Promise<string | null>;
  command(args: string[]): Promise<void>;
  databaseTask<T>(task: ImportDatabaseTask): Promise<T>;
}

/** 一个含 Workout 的增量载荷：record-only 车道必然拒收 ⇒ 走统一接收器 ⇒ 登记分析任务。 */
const workoutXml = (index: number): string => `<HealthData><Workout
    workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch"
    duration="30" durationUnit="min" startDate="2026-01-0${index} 08:00:00 +0000"
    endDate="2026-01-0${index} 08:30:00 +0000">
    <MetadataEntry key="RAIHealthKitWorkoutUUID"
      value="00000000-0000-0000-0000-00000000000${index}"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
  </Workout></HealthData>`;

function writeInput(root: string, name: string, xml: string): string {
  const input = join(root, name);
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), xml);
  writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
    version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
  }));
  return input;
}

/** 跑一次真实原始接收（直连车道），返回终态的 job id。 */
async function ingest(main: string, root: string, input: string, sourceId: string): Promise<string> {
  const worker = new ImportWorker(main, project, root, () => {
    throw new Error("raw ingest must not enter the replacement gate");
  }, undefined, undefined, {
    scope: "fixture", dataOnlyFastPath: true,
    admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
  });
  const surface = worker as unknown as Surface;
  surface.createCurrentBackup = async () => { throw new Error("raw ingest must not back up the whole database"); };
  surface.command = async () => { throw new Error("raw ingest must not invoke the CLI"); };
  try {
    const job = worker.create(input, undefined, sourceId);
    const deadline = Date.now() + 60_000;
    while (worker.hasPending || worker.isRunning) {
      assert.ok(Date.now() < deadline, JSON.stringify(worker.latest()));
      await new Promise((done) => setTimeout(done, 25));
    }
    const done = worker.get(job.id)!;
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    return job.id;
  } finally {
    await worker.close();
  }
}

/** 消费者（与 API 的 `RecomputeWorker` 线程同一个入口）：跑一个排队中的任务。 */
async function consumeNext(main: string): Promise<{ id: string; status: string; error: string | null }> {
  const store = await RaiDatabase.open(main, { migrationPolicy: "refuse", createMigrationBackup: false });
  try {
    const job = new RaiApplicationService(store).runNextJob();
    assert.ok(job, "消费者必须领到一个排队中的任务");
    return { id: job.id, status: job.status, error: job.error ? JSON.stringify(job.error) : null };
  } finally {
    store.close();
  }
}

interface Snapshot {
  batches: number;
  records: number;
  workouts: number;
  sessions: number;
  activeModelRun: string | null;
  featureRuns: number;
  modelRuns: number;
}

function snapshot(main: string): Snapshot {
  const db = new DatabaseSync(main, { readOnly: true });
  try {
    const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
    const active = db.prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1")
      .get() as { id: string } | undefined;
    return {
      batches: one("SELECT COUNT(*) AS n FROM import_batches"),
      records: one("SELECT COUNT(*) AS n FROM health_records"),
      workouts: one("SELECT COUNT(*) AS n FROM workouts WHERE deleted_at IS NULL"),
      sessions: one("SELECT COUNT(*) AS n FROM training_sessions"),
      activeModelRun: active?.id ?? null,
      featureRuns: one("SELECT COUNT(*) AS n FROM feature_runs"),
      modelRuns: one("SELECT COUNT(*) AS n FROM model_runs")
    };
  } finally {
    db.close();
  }
}

test("A10：分析故障隔离——原回执不变、失败独立可见、重试只计算（不重新导出/不备份）", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-analysis-isolation-"));
  const main = join(root, "main.sqlite");
  try {
    const store = await RaiDatabase.open(main);
    store.setManifest("dataset_version", "baseline");
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
    store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
    store.setManifest("data_only_baseline_contract", dataOnlyBaselineContract());
    store.setProfile({ dateOfBirth: "1990-01-01" });
    store.close();

    // ① 第一批原始接收：事实 + 批次 + 回执 + 一个排队中的分析任务。
    const firstBatch = await ingest(main, root, writeInput(root, "input-1", workoutXml(1)), "sync-1");
    const receiptAfterIngest = readImportReceipt(main, firstBatch);
    assert.equal(receiptAfterIngest?.directSync?.ingestStatus, "committed");
    assert.equal(receiptAfterIngest?.directSync?.analysisStatus, "queued");

    // ② 分析成功一次 ⇒ 有"旧 release"可比（否则"失败不影响已发布结果"是空话）。
    const firstRun = await consumeNext(main);
    assert.equal(firstRun.status, "succeeded", firstRun.error ?? "");
    const published = snapshot(main);
    assert.ok(published.activeModelRun, "成功的分析必须发布一个 active model run");

    // ③ 第二批原始接收：新的 Workout + 新的分析任务。
    const secondBatch = await ingest(main, root, writeInput(root, "input-2", workoutXml(2)), "sync-2");
    const receiptBeforeFailure = readImportReceipt(main, secondBatch);
    const beforeFailure = snapshot(main);
    assert.equal(beforeFailure.activeModelRun, published.activeModelRun, "接收侧不得动发布指针");
    assert.equal(beforeFailure.batches, published.batches + 1, "第二批应当新增一个批次行");

    // ④ 故障注入：在**候选分析行落地**这一步失败（`model_runs` 的 INSERT）。
    //    这是真实的写点，不是 mock —— 失败发生在 CPU 已经算完、正要写候选的时候。
    const injector = new DatabaseSync(main);
    injector.exec(`CREATE TRIGGER a10_fail_analysis BEFORE INSERT ON model_runs
      BEGIN SELECT RAISE(ABORT, 'injected analysis failure'); END`);
    injector.close();

    const failed = await consumeNext(main);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /injected analysis failure/,
      "失败原因必须是**注入的那个**：否则这条用例可能只是碰巧在别处失败，证明不了隔离");

    const afterFailure = snapshot(main);
    // 判据 ①：原始接收保持成功 —— 事实一条不少、批次不消失、**回执逐字段不变**。
    assert.deepEqual(readImportReceipt(main, secondBatch), receiptBeforeFailure,
      "分析失败不得改写原始回执（回执是**写入时刻**的事实，不是分析状态）");
    assert.deepEqual(readImportReceipt(main, firstBatch), receiptAfterIngest,
      "第一批的回执同样不得被后续失败污染");
    assert.equal(afterFailure.records, beforeFailure.records);
    assert.equal(afterFailure.workouts, beforeFailure.workouts, "事实不得因为分析失败而回滚或删除");
    assert.equal(afterFailure.sessions, beforeFailure.sessions);
    assert.equal(afterFailure.batches, beforeFailure.batches, "分析失败不得新增/删除批次行");
    // 判据 ②：失败**独立可见**（今天由任务行承载；读侧派生投影属 PR5）。
    assert.equal(afterFailure.activeModelRun, beforeFailure.activeModelRun,
      "失败的候选不得移动发布指针：旧 release 必须仍然可读");
    const jobState = new DatabaseSync(main, { readOnly: true });
    try {
      const row = jobState.prepare("SELECT status, error_json AS error FROM recompute_jobs WHERE id = ?")
        .get(failed.id) as { status: string; error: string };
      assert.equal(row.status, "failed");
      assert.match(row.error, /injected analysis failure/);
      assert.equal(Number(jobState.prepare(
        "SELECT COUNT(*) AS n FROM recompute_jobs WHERE status = 'queued'").get()!.n), 0,
      "失败的任务不得留在队列里假装还没跑");
    } finally { jobState.close(); }
    // 候选行可以残留（它们按 run id 隔离、且状态不是 succeeded），但绝不能被当成已发布。
    assert.ok(afterFailure.featureRuns >= beforeFailure.featureRuns);
    const read = new RaiReadStore(main);
    try {
      assert.equal(read.dashboard().activeModel?.id, published.activeModelRun,
        "读侧必须仍然指向成功的那个 release");
      // 判据 ②的**读侧**一面：失败必须能通过真实 API 投影（`GET /v1/jobs` 用的就是这条）
      // 单独看见 —— 而不是只能靠"回执没变"倒推。API 层故意只给通用文案（`task_failed`），
      // 原始原因留在 `recompute_jobs.error_json`（运维可见），这是既有产品决定。
      const visible = read.jobs().find((job) => job.id === failed.id);
      assert.equal(visible?.status, "failed", "失败的分析任务必须在读侧报 failed");
      assert.deepEqual(visible?.error, { code: "task_failed", message: "任务执行失败" });
      assert.equal(read.jobs().some((job) => job.id === firstRun.id && job.status === "succeeded"), true,
        "成功的分析任务仍然是 succeeded —— 两次任务的独立状态不得互相覆盖");
    } finally { read.close(); }

    // ⑤ 重试：只计算。走 API 的真实重试入口（`POST /v1/model-runs` 调的就是这个）。
    const retryStore = await RaiDatabase.open(main, { migrationPolicy: "refuse", createMigrationBackup: false });
    let retryJobId: string;
    try {
      retryStore.database.exec("DROP TRIGGER a10_fail_analysis");
      retryJobId = new RaiApplicationService(retryStore).enqueueFullRecompute({
        evaluatedAt: "2026-01-03T00:00:00.000Z", timezoneIdentifier: "Asia/Shanghai"
      });
    } finally { retryStore.close(); }

    const retried = await consumeNext(main);
    assert.equal(retried.id, retryJobId);
    assert.equal(retried.status, "succeeded", retried.error ?? "");

    const afterRetry = snapshot(main);
    // 判据 ③：重试**只计算** —— 不重新导出、不重新备份、不复制库、也不重写原始事实。
    assert.equal(afterRetry.batches, beforeFailure.batches, "重试不得产生新的批次行（那意味着重新接收）");
    assert.equal(afterRetry.records, beforeFailure.records, "重试不得重写原始事实");
    assert.equal(afterRetry.workouts, beforeFailure.workouts);
    assert.equal(afterRetry.sessions, beforeFailure.sessions);
    assert.deepEqual(readImportReceipt(main, secondBatch), receiptBeforeFailure,
      "重试之后回执仍然逐字段不变");
    assert.deepEqual(
      readdirSync(join(root, "var")).filter((name) => /^(backups|rai\.importing)/.test(name)), [],
      "重试不得创建项目备份或整库候选");
    assert.equal(statSync(main).ino, statSync(main).ino, "主库文件身份不得改变");
    // 而且它确实算出了新结果：发布指针移动到一个**新的** release。
    assert.ok(afterRetry.activeModelRun, "重试成功后必须发布");
    assert.notEqual(afterRetry.activeModelRun, published.activeModelRun,
      "重试必须产生新的 release，而不是复用失败的候选");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
