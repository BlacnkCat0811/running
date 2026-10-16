// O06-B / WP-40 的**端到端**验收：连续批次的重复计算合并（`analysis_job_merges`，v42）。
//
// 与 `packages/storage-sqlite/test/analysis-job-merge.test.ts`（仓库层判据）的分工：
// 那个文件证明"判据长什么样"，本文件证明"接上真实车道之后结果对不对"——
// 用**真**的直连导入（真账本、真代次计数器、真回执、真 `analysisJobId`）、
// **真**的消费者（`RaiApplicationService.runNextJob`）与**真**的输入读取器
// （`SqliteAnalysisInputReader`，与 worker 线程同一条装配）。
//
// 三条判据（审查文档 §O06-B 的验收原文）：
//
//   1. **10 条兼容的排队批次只执行一份覆盖计算**，且全部 10 个原 `analysisJobId`
//      都能查到自己的真实结果（沿原 id —— HTTP 合同不变 ⇒ iOS 不需要改）；
//   2. 计算期间**再注入一批导入**：要么在同一绑定上发布，要么**安全重排**，
//      绝不混代次（注入用写触发器完成：它在"捕获之后、发布之前"真的发生）；
//   3. 分析失败之后**原始回执仍是 committed**，客户端不会重传已确认的载荷。
//
// 🔴 第 2 条的两种走向都要有：推依赖代次的批次 ⇒ 发布被拒（安全重排）；
// raw-only 批次（不推依赖代次）⇒ 决策 D4 放行，同绑定发布。只测一边都区分不出
// "判据真的在看代次"还是"判据恰好总是拒绝/总是放行"。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION, DATABASE_TIMEZONE, DIRECT_SYNC_ANALYSIS_REQUEST_MODE, workoutTypes } from "@rai/contracts";
import { RaiApplicationService, SqliteAnalysisInputReader } from "@rai/application";
import { RaiDatabase, RecomputeJobRepository, readFactReadView } from "@rai/storage-sqlite";
import { NATIVE_VERSION, identityAlgorithmFingerprint } from "@rai/health-export-parser";

import { RaiReadStore } from "../src/data.js";
import {
  applyDirectSyncImport, isDirectSyncRejection, type DirectSyncImportInput, type DirectSyncImportResult
} from "../src/direct-sync-ingest.js";
import { readImportReceipt } from "../src/import-publication.js";
import { computeImportPayloadSha256 } from "../src/import-payload-identity.js";

function workout(index: number): string {
  const day = String((index % 27) + 1).padStart(2, "0");
  return `<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
    startDate="2026-03-${day} 06:00:00 +0000" endDate="2026-03-${day} 06:30:00 +0000"
    duration="30" durationUnit="min">
    <MetadataEntry key="HKMetadataKeySyncIdentifier" value="merged-workout-${index}"/>
  </Workout>`;
}

const xml = (rows: string) => `<HealthData>${rows}</HealthData>`;

interface Fixture {
  main: string;
  input(rows: string): Promise<DirectSyncImportInput>;
}

/** 与 `direct-sync-analysis-reconcile.test.ts` 同源的夹具：同一条生产摘要函数、同一份输入目录形状。 */
async function fixture(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-analysis-job-merge-e2e-"));
  const main = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(main);
  store.setManifest("dataset_version", "baseline");
  store.setManifest("parser_contract_version", CONTRACT_VERSION);
  store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  store.setProfile({ dateOfBirth: "1990-01-01" });
  store.close();
  let ordinal = 0;
  const input = async (rows: string): Promise<DirectSyncImportInput> => {
    const inputPath = join(root, `input-${ordinal++}`);
    mkdirSync(inputPath);
    writeFileSync(join(inputPath, "export.xml"), xml(rows));
    writeFileSync(join(inputPath, "sync-manifest.json"), JSON.stringify({
      version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
    }));
    const payloadSha256 = await computeImportPayloadSha256(inputPath, {
      preserveAbsent: true, contractVersion: CONTRACT_VERSION,
      engine: `typescript@${NATIVE_VERSION}`, identityAlgorithm: identityAlgorithmFingerprint()
    });
    return { databasePath: main, inputPath, jobId: `delta-${ordinal}`, payloadSha256, startedAtMs: Date.now() };
  };
  try { await run({ main, input }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

async function applyOrFail(batch: DirectSyncImportInput): Promise<DirectSyncImportResult["summary"]> {
  const outcome = await applyDirectSyncImport(batch);
  assert.ok(!isDirectSyncRejection(outcome),
    `直连批次必须被接收，实际拒收：${JSON.stringify(outcome)}`);
  return outcome.summary;
}

function read<T>(main: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(main, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

/** 分析产物的计数：**一份覆盖计算**的判据就是"feature/model run 各只多一条"。 */
function analysisCounts(main: string): { featureRuns: number; modelRuns: number } {
  return read(main, (db) => ({
    featureRuns: Number((db.prepare("SELECT COUNT(*) AS n FROM feature_runs").get() as { n: number }).n),
    modelRuns: Number((db.prepare("SELECT COUNT(*) AS n FROM model_runs").get() as { n: number }).n)
  }));
}

function jobStatus(main: string, id: string): string {
  return String((read(main, (db) => db.prepare("SELECT status FROM recompute_jobs WHERE id = ?").get(id)) as
    { status: string } | undefined)?.status);
}

/** 终态失败时的原始原因（断言消息里必须带上它，否则"为什么红"要靠猜）。 */
function jobError(main: string, id: string): string {
  const row = read(main, (db) => db.prepare(
    "SELECT error_json AS error FROM recompute_jobs WHERE id = ?"
  ).get(id)) as { error: string | null } | undefined;
  return row?.error ?? "null";
}

function mergeState(main: string, coveredJobId: string): { state: string; coveringJobId: string } {
  const row = read(main, (db) => db.prepare(
    "SELECT state, covering_job_id AS coveringJobId FROM analysis_job_merges WHERE covered_job_id = ?"
  ).get(coveredJobId)) as { state: string; coveringJobId: string } | undefined;
  assert.ok(row, `${coveredJobId} 应当有一条覆盖关联`);
  return row;
}

/** 用**真消费者**跑一轮（与 worker 线程同一条装配：真输入读取器的独立只读连接）。 */
async function consumeOne(main: string): Promise<{ id: string; status: string } | null> {
  const store = await RaiDatabase.open(main);
  const inputDatabase = RaiDatabase.openReadonly(main);
  try {
    const completed = new RaiApplicationService(
      store, "owned", undefined, undefined, new SqliteAnalysisInputReader(inputDatabase)
    ).runNextJob();
    return completed === null ? null : { id: completed.id, status: completed.status };
  } finally {
    inputDatabase.close();
    store.close();
  }
}

/**
 * 注入"计算期间又到了一批导入"：触发器挂在 `feature_runs` 的 INSERT 上 ——
 * 那一刻**一定**在输入捕获之后、发布之前（`runDirectSyncAnalysis` 先捕获，
 * `runFullRecompute` 才建 feature run），所以这是真实的竞态位置，不是模拟。
 *
 * 用 `INSERT OR REPLACE` + `UPDATE`：万一管道建了不止一条 feature run，注入也只发生一次效果。
 */
function installNextBatchInjection(
  main: string,
  injection: { batchId: string; raw: number; dependency: number; bumped: 0 | 1 }
): void {
  const store = new DatabaseSync(main);
  try {
    store.exec(`CREATE TRIGGER inject_next_direct_sync_batch AFTER INSERT ON feature_runs BEGIN
      INSERT OR REPLACE INTO import_batches (
        id, xml_sha256, status, import_mode, summary_json,
        raw_generation, dependency_generation, dependency_bumped
      ) VALUES ('${injection.batchId}', '${"0".repeat(64)}', 'succeeded', 'incremental', '{}',
        ${injection.raw}, ${injection.dependency}, ${injection.bumped});
      UPDATE import_generations
        SET raw_generation = ${injection.raw}, dependency_generation = ${injection.dependency}
        WHERE singleton = 1;
      UPDATE import_manifest SET value = 'dataset_delta_injected' WHERE key = 'dataset_version';
    END;`);
  } finally { store.close(); }
}

function dropInjection(main: string): void {
  const store = new DatabaseSync(main);
  try { store.exec("DROP TRIGGER IF EXISTS inject_next_direct_sync_batch"); } finally { store.close(); }
}

test("验收①：10 条兼容排队批次只执行一份覆盖计算，10 个原 analysisJobId 各自查到真实结果", async () => {
  await fixture(async ({ main, input }) => {
    const receipts: Array<{ batchId: string; jobId: string }> = [];
    for (let index = 0; index < 10; index += 1) {
      const batch = await input(workout(index));
      const summary = await applyOrFail(batch);
      assert.equal(summary.analysisJobId !== null && summary.analysisJobId !== undefined, true,
        `第 ${index + 1} 批是需要分析的批次，必须交出 analysisJobId`);
      receipts.push({ batchId: batch.jobId, jobId: String(summary.analysisJobId) });
    }
    assert.equal(read(main, (db) => Number((db.prepare(
      "SELECT COUNT(*) AS n FROM recompute_jobs WHERE status = 'queued'"
    ).get() as { n: number }).n)), 10, "前提：十条批次各登记了一条排队任务");

    const before = analysisCounts(main);
    const completed = await consumeOne(main);
    assert.ok(completed, "必须真的领到任务");
    assert.equal(completed.status, "succeeded",
      `覆盖任务必须发布成功（实际 ${completed.status}：${jobError(main, completed.id)}）`);
    assert.equal(receipts.some((receipt) => receipt.jobId === completed.id), false,
      "被领取并执行的必须是**新造的覆盖任务**，而不是某一条原任务");

    // 🔴 判据本身：**恰好一份**覆盖计算（feature/model run 各只多一条）。
    const after = analysisCounts(main);
    assert.equal(after.featureRuns - before.featureRuns, 1, "十条兼容批次只允许多出一份特征计算");
    assert.equal(after.modelRuns - before.modelRuns, 1, "十条兼容批次只允许多出一份模型计算");

    // 队列已排空：九条被覆盖任务没有被独立领取，也不该留在队列里。
    assert.equal(await consumeOne(main), null, "一轮之后队列必须排空（十条只算一份）");

    // 🔴 全部 10 个**原** analysisJobId 都能查到自己的真实结果。
    const readStore = new RaiReadStore(main);
    try {
      const modelRunIds = new Set<string>();
      for (const receipt of receipts) {
        const dto = readStore.job(receipt.jobId);
        assert.ok(dto, `原 id ${receipt.jobId} 必须仍然可查（不得删掉原任务行）`);
        assert.equal(dto.id, receipt.jobId, "返回的 id 必须还是**客户端手里那个**（HTTP 合同不变 ⇒ iOS 不需要改）");
        assert.equal(dto.status, "succeeded", `原 id ${receipt.jobId} 必须报真实终态`);
        assert.equal(typeof dto.modelRunId, "string",
          "每条原任务都必须指向真正覆盖它的那次发布（客户端据此知道结论来自哪一版）");
        modelRunIds.add(String(dto.modelRunId));
        assert.ok((dto.events ?? []).some((event) => event.phase === "merged"),
          "原 id 的事件流必须说明它被并进了覆盖任务");
        assert.ok((dto.events ?? []).some((event) => event.phase === "covered"),
          "原 id 的事件流必须说明覆盖任务真的发布了");
      }
      assert.equal(modelRunIds.size, 1, "十条批次共享**同一次**发布（一份覆盖计算的落库形态）");
    } finally { readStore.close(); }

    // 覆盖关系在库里是**发布态**（不是靠内存推断），且失败/未发布一律不叫 published。
    for (const receipt of receipts) {
      assert.equal(mergeState(main, receipt.jobId).state, "published");
    }
    // 同一覆盖任务的全部成员指向**同一次**发布，且发布绑定的捕获代次不落后于任何成员的目标。
    const binding = read(main, (db) => db.prepare(`
      SELECT binding.captured_dependency_generation AS capturedDependency,
             binding.captured_raw_generation AS capturedRaw
      FROM analysis_run_input_bindings binding
      JOIN recompute_jobs job ON job.model_run_id = binding.run_id
      WHERE job.id = ?
    `).get(mergeState(main, receipts[0]!.jobId).coveringJobId)) as
      { capturedDependency: number; capturedRaw: number } | undefined;
    assert.ok(binding, "覆盖任务必须留下实际输入绑定（发布短事务写的）");
    const targets = read(main, (db) => db.prepare(`
      SELECT merge.covered_target_dependency_generation AS dependency
      FROM analysis_job_merges merge WHERE merge.covering_job_id = ?
    `).all(mergeState(main, receipts[0]!.jobId).coveringJobId)) as Array<{ dependency: number }>;
    assert.equal(targets.length, 10);
    for (const target of targets) {
      assert.ok(Number(binding.capturedDependency) >= Number(target.dependency),
        "发布的输入快照必须覆盖每个成员的 dirty 范围（证明：捕获代次 ≥ 成员目标代次）");
    }
    // 原始回执**逐字段不变**：回执是写入时刻的凭证，分析推进不改写它。
    for (const receipt of receipts) {
      const persisted = readImportReceipt(main, receipt.batchId);
      assert.equal(persisted?.analysisJobId, receipt.jobId, "回执里的 analysisJobId 不得被改写");
      assert.equal(persisted?.directSync?.analysisStatus, "queued",
        "回执仍是写入时刻的快照（分析已更新必须来自独立通道的对账）");
      assert.equal(persisted?.directSync?.ingestStatus, "committed");
    }
  });
});

test("验收②（安全重排）：计算期间来了推依赖代次的批次 ⇒ 发布被拒、成员留队列、绝不混代次", async () => {
  await fixture(async ({ main, input }) => {
    const jobIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const summary = await applyOrFail(await input(workout(index)));
      jobIds.push(String(summary.analysisJobId));
    }
    const before = analysisCounts(main);
    installNextBatchInjection(main, { batchId: "injected_dependency_batch", raw: 5, dependency: 5, bumped: 1 });
    try {
      const completed = await consumeOne(main);
      assert.ok(completed);
      assert.equal(completed.status, "failed",
        "计算期间依赖代次前进 ⇒ 发布必须被拒（安全重排），不得把两边拼着发布");
      // 混代次的直接判据：那次被拒的候选**不得**成为活跃发布。
      assert.equal(analysisCounts(main).modelRuns - before.modelRuns, 1,
        "前提：被拒的那次确实建了一套 run（候选是半成品，不是没跑）");
      assert.equal(read(main, (db) => Number((db.prepare(
        "SELECT COUNT(*) AS n FROM active_model_run WHERE model_run_id = ?"
      ).get(completed.id) as { n: number }).n)), 0, "被拒的候选绝不能是活跃发布");
      // 成员回到队列（真实含义是"重排"），关联被释放，**绝不**结算。
      for (const id of jobIds) {
        assert.equal(jobStatus(main, id), "queued", "发布被拒不是成员的成功，也不是成员的失败");
        assert.equal(mergeState(main, id).state, "released");
      }
      // 🔴 客户端不重传：原始回执仍说 committed/queued，载荷已经被确认过。
      const batchIds = read(main, (db) => db.prepare(
        "SELECT id FROM import_batches WHERE id LIKE 'delta-%' ORDER BY id"
      ).all()) as Array<{ id: string }>;
      assert.equal(batchIds.length, 3);
      for (const batch of batchIds) {
        const persisted = readImportReceipt(main, batch.id);
        assert.equal(persisted?.directSync?.ingestStatus, "committed",
          "分析失败不得改写原始回执的 ingestStatus（客户端据此不重传）");
        assert.equal(persisted?.directSync?.analysisStatus, "queued");
      }
    } finally { dropInjection(main); }
  });
});

test("验收②（同绑定发布）：计算期间只来了 raw-only 批次 ⇒ D4 放行、同绑定发布并结算", async () => {
  await fixture(async ({ main, input }) => {
    const jobIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const summary = await applyOrFail(await input(workout(index)));
      jobIds.push(String(summary.analysisJobId));
    }
    // raw-only：raw 前进、**依赖代次不动**（这正是决策 D4 允许通过的那一档）。
    installNextBatchInjection(main, { batchId: "injected_raw_only_batch", raw: 4, dependency: 3, bumped: 0 });
    try {
      const completed = await consumeOne(main);
      assert.ok(completed);
      assert.equal(completed.status, "succeeded",
        `raw-only 批次不移动分析输入 ⇒ 同一个绑定必须照常发布（${jobError(main, completed.id)}）`);
      for (const id of jobIds) {
        assert.equal(jobStatus(main, id), "succeeded", "同绑定发布之后成员必须被结算");
        assert.equal(mergeState(main, id).state, "published");
      }
      // 结算的证明是**发布绑定**：捕获代次 ≥ 成员目标代次，且捕获之后依赖代次没再动。
      const covering = mergeState(main, jobIds[0]!).coveringJobId;
      const binding = read(main, (db) => db.prepare(`
        SELECT captured_dependency_generation AS capturedDependency
        FROM analysis_run_input_bindings WHERE job_id = ?
      `).get(covering)) as { capturedDependency: number } | undefined;
      assert.ok(binding, "覆盖任务必须留下绑定");
      assert.equal(Number(binding.capturedDependency), 3, "捕获的就是注入之前的依赖代次（不混代次）");
    } finally { dropInjection(main); }
  });
});

test("验收③（新鲜度派生）：被覆盖任务的状态沿持久覆盖关系读，不由内存推断", async () => {
  await fixture(async ({ main }) => {
    // 只造最小状态：依赖代次 1；一条被覆盖任务 + 一条覆盖任务。
    const write = new DatabaseSync(main);
    try {
      write.exec("UPDATE import_generations SET raw_generation = 1, dependency_generation = 1 WHERE singleton = 1");
      const insert = write.prepare(`
        INSERT INTO recompute_jobs (
          id, job_type, status, request_json, progress_phase, target_dependency_generation, created_at
        ) VALUES (?, 'import', ?, ?, ?, 1, ?)
      `);
      // 覆盖任务的登记时刻取**成员那一批**（合并实现如此）；成员反而更"新"，
      // 于是新鲜度查询按 created_at 取到的是**成员行** —— 这正是要考的形态。
      insert.run("covering", "running", "{}", "prepare", "2026-10-15T23:59:59.000Z");
      insert.run("member", "queued", "{}", "queued", "2026-10-16T00:00:00.000Z");
      write.prepare(`
        INSERT INTO analysis_job_merges (
          covered_job_id, covering_job_id, state, scope, import_batch_id,
          covered_target_raw_generation, covered_target_dependency_generation,
          union_batch_ids_json, evidence_json
        ) VALUES ('member', 'covering', 'pending', 'direct-sync', 'batch_1', 1, 1, '["batch_1"]', '{}')
      `).run();
    } finally { write.close(); }

    const store = await RaiDatabase.open(main);
    try {
      const pending = readFactReadView(store.database, { factRows: 10, analysisRows: 10 });
      assert.equal(pending.versions.analysisStatus, "running",
        "覆盖任务在跑 ⇒ 被覆盖任务不得被报成 queued（新鲜度与 GET /v1/jobs/:id 必须同一口径）");
      assert.equal(pending.freshness.reason, "analysis_missing",
        "从未发布过 ⇒ 落后原因是「缺失」而不是「落后于某个旧发布」（与 published=null 的口径一致）");

      // 关联被释放（覆盖任务失败/重排过）⇒ 必须报成员**自己**的状态，不得继续借用覆盖任务。
      store.database.prepare("UPDATE analysis_job_merges SET state = 'released' WHERE covered_job_id = 'member'").run();
      assert.equal(
        readFactReadView(store.database, { factRows: 10, analysisRows: 10 }).versions.analysisStatus,
        "queued",
        "释放之后必须回到成员自己的状态（重排有它自己的含义）"
      );

      // 发布态：成员被结算成 succeeded ⇒ published（"结论已发布"的等价关系由发布事务保证）。
      store.database.prepare("UPDATE analysis_job_merges SET state = 'published' WHERE covered_job_id = 'member'").run();
      store.database.prepare("UPDATE recompute_jobs SET status = 'succeeded' WHERE id = 'member'").run();
      assert.equal(
        readFactReadView(store.database, { factRows: 10, analysisRows: 10 }).versions.analysisStatus,
        "published"
      );
    } finally { store.close(); }
  });
});

test("验收④（服务端任务查询）：覆盖任务在跑时，GET /v1/jobs/:id 沿原 id 报它的真实进度", async () => {
  await fixture(async ({ main }) => {
    let coveringId = "";
    const store = await RaiDatabase.open(main);
    const memberIds: string[] = [];
    try {
      const jobs = new RecomputeJobRepository(store.database);
      for (const index of [1, 2]) {
        memberIds.push(jobs.enqueue(
          "import",
          `dataset_delta_${index}`,
          {
            mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
            importBatchId: `projection_batch_${index}`,
            evaluatedAt: new Date().toISOString(),
            timezoneIdentifier: DATABASE_TIMEZONE
          },
          { targetRawGeneration: index, targetDependencyGeneration: index }
        ));
      }
      const claimed = jobs.claimNext();
      assert.ok(claimed, "必须生成并领取覆盖任务");
      coveringId = claimed.id;
    } finally { store.close(); }

    const readStore = new RaiReadStore(main);
    try {
      for (const id of memberIds) {
        const dto = readStore.job(id);
        assert.ok(dto);
        assert.equal(dto.id, id, "HTTP 合同不变：返回的 id 仍是客户端请求的那一个");
        assert.equal(dto.status, "running", "被覆盖任务必须沿原 id 报覆盖任务的真实进度（不是它自己那个 queued）");
        assert.equal(dto.progressPhase, "claimed", "进度字段同样来自覆盖任务");
        assert.ok((dto.events ?? []).some((event) => event.phase === "merged"),
          "原 id 的事件流必须解释这条任务去哪了");
      }
      assert.equal(readStore.job(coveringId)?.status, "running",
        "覆盖任务自己的 id 也照常可查（身份字段没有被合并改写）");
    } finally { readStore.close(); }

    // 覆盖任务失败 ⇒ 关联被释放 ⇒ 原 id 报它**自己**的状态（重排有它自己的含义）。
    const store2 = await RaiDatabase.open(main);
    try {
      new RecomputeJobRepository(store2.database).fail(coveringId, new Error("publication refused"));
    } finally { store2.close(); }
    const after = new RaiReadStore(main);
    try {
      for (const id of memberIds) {
        const dto = after.job(id);
        assert.equal(dto?.status, "queued",
          "覆盖任务失败不是成员的成功，也不是成员的失败：它回到队列等重新规划");
        assert.ok((dto?.events ?? []).some((event) => event.phase === "replan"));
      }
    } finally { after.close(); }
  });
});
