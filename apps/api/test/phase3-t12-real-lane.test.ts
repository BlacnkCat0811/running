// P3 复审（2026-10-22）第二轮：T12 的**真实到达 + 原任务消费**主路径。
//
// 与上一版的差别（正是复审指出的两个缺陷）：
//   1. 不再在导入后 UPDATE canonical_nights / canonical_hrv_days 的 computed_at，
//      也不再重写 import_completed_at。到达时刻由可审计的内部时钟注入到**写入前**：
//      同一次导入的 canonical 到达时间、批次完成时刻、任务 evaluatedAt、
//      import_completed_at 全部同源；
//   2. A 不再 DELETE 导入事务登记的原任务、也不复制 incrementalPlan 另建任务。
//      A 直接通过生产消费者 `RaiApplicationService.runNextJob()` 领取原
//      `analysisJobId`，并核对 input binding / coverage / 复用证明 / 发布结果。
//      B 的对照任务走仓库现有的取消接口，再用明确隔离的 direct-sync 全量任务
//      在同一父发布上计算。
//
// 时间线（Asia/Shanghai）：
//   基线按“数据真正到达的那一天”分段导入（第 1–33 天分段、34–52 天逐日），
//   每天的样本结束时刻 <= 当天 10:00 的模拟到达时刻；父发布与修订任务都评估在
//   day 52 12:00（EVAL_2）。修订包（day 5 / day 50）在同一 EVAL_2 到达，
//   因此最终 run 的 as-of 语义是“当时已知”，不是回填。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DEFAULT_ANALYSIS_INPUT_BUDGET, RaiApplicationService, SqliteAnalysisInputReader
} from "@rai/application";
import { CONTRACT_VERSION, DIRECT_SYNC_ANALYSIS_REQUEST_MODE, healthTypes, workoutTypes } from "@rai/contracts";
import type { ImportJobResponse } from "@rai/api-contracts";
import { identityAlgorithmFingerprint, NATIVE_VERSION } from "@rai/health-export-parser";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";

import { applyDirectSyncImport, isDirectSyncRejection, type DirectSyncImportInput } from "../src/direct-sync-ingest.js";
import { computeImportPayloadSha256 } from "../src/import-payload-identity.js";
import { loadDatedReadiness } from "../../../packages/application/src/model-v2-snapshots.js";
import {
  assertBusinessEquivalent, assertCompleteBusinessProjection, readBusinessProjection, stripExecutionIdentity
} from "../../../packages/application/test/business-artifact-projection.js";

const TZ = "Asia/Shanghai";
/** day 52 12:00 Asia/Shanghai：父发布、修订到达与最终评估共用同一个时刻。 */
const EVAL_2 = "2026-02-21T04:00:00.000Z";
const DAYS = Array.from({ length: 52 }, (_, index) => index + 1);
const FIRST_REVISION_DAY = 5;
const SECOND_REVISION_DAY = 50;
/** 36..49：距 day 5 的 28 天睡眠基线窗至少 2 天，且都在 day 50 修订之前。 */
const MIDDLE_DAYS = Array.from({ length: 14 }, (_, index) => index + 36);

const dateOfDay = (day: number): string =>
  new Date(Date.parse("2026-01-01T00:00:00.000Z") + (day - 1) * 86_400_000).toISOString().slice(0, 10);
const localDay = (day: number): string => dateOfDay(day);
const appleDate = (day: number, time: string): string => `${dateOfDay(day)} ${time}:00 +0800`;
const nextDate = (date: string): string => {
  const next = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000);
  return next.toISOString().slice(0, 10);
};
const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
/** 模拟到达时刻：本地日 10:00。所有夹具样本的结束时刻都早于它。 */
const arrivalAt = (day: number): string => `${dateOfDay(day)}T02:00:00.000Z`;

function workout(day: number, index: number): string {
  return `
  <Workout workoutActivityType="${workoutTypes.running}" duration="30" durationUnit="min"
    sourceName="Fixture Apple Watch" sourceVersion="1"
    creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" device="Watch">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <MetadataEntry key="HKMetadataKeySyncIdentifier" value="t12-workout-${day}"/>
    <WorkoutStatistics type="${healthTypes.distanceWalkingRunning}" startDate="${appleDate(day, "08:00")}"
      endDate="${appleDate(day, "08:30")}" sum="${(5 + index * 0.08).toFixed(2)}" unit="km"/>
    <WorkoutStatistics type="${healthTypes.heartRate}" startDate="${appleDate(day, "08:00")}"
      endDate="${appleDate(day, "08:30")}" average="${145 + index}" minimum="120" maximum="172" unit="count/min"/>
  </Workout>`;
}

function heartRecord(day: number, index: number, sample: number): string {
  const minute = String(sample * 2).padStart(2, "0");
  const endMinute = String(sample * 2 + 1).padStart(2, "0");
  return `
  <Record type="${healthTypes.heartRate}" sourceName="Fixture Apple Watch" sourceVersion="1"
    unit="count/min" creationDate="${appleDate(day, "08:31")}"
    startDate="${appleDate(day, `08:${minute}`)}" endDate="${appleDate(day, `08:${endMinute}`)}"
    value="${140 + index + (sample % 3)}">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid(day * 1000 + sample)}"/>
  </Record>`;
}

function sleepRecord(
  day: number, startDate: string, startTime: string, endDate: string, endTime: string, value: string
): string {
  return `
  <Record type="${healthTypes.sleepAnalysis}" sourceName="Fixture Apple Watch" sourceVersion="1"
    value="${value}"
    startDate="${startDate} ${startTime}:00 +0800" endDate="${endDate} ${endTime}:00 +0800">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid(300_000 + day)}"/>
  </Record>`;
}

function hrvRecord(day: number, value: number): string {
  const wakeDate = nextDate(dateOfDay(day));
  return `
  <Record type="${healthTypes.hrvSdnn}" sourceName="Fixture Apple Watch" sourceVersion="1"
    unit="ms" value="${value}" startDate="${wakeDate} 06:30:00 +0800" endDate="${wakeDate} 06:50:00 +0800">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid(500_000 + day)}"/>
  </Record>`;
}

function restingHeartRateRecord(day: number): string {
  const wakeDate = nextDate(dateOfDay(day));
  return `
  <Record type="${healthTypes.restingHeartRate}" sourceName="Fixture Apple Watch" sourceVersion="1"
    unit="count/min" value="${50 + (day % 3)}"
    startDate="${wakeDate} 06:45:00 +0800" endDate="${wakeDate} 06:46:00 +0800">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid(700_000 + day)}"/>
  </Record>`;
}

function healthData(parts: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="zh_CN">\n  <ExportDate value="${appleDate(52, "12:00")}"/>\n  <Me biologicalSex="HKBiologicalSexMale"/>${parts}\n</HealthData>`;
}

/**
 * 一个“唤醒日”的完整事实：训练发生在唤醒日 08:00–08:30；睡眠/HRV/RHR 记录
 * 属于前一晚，结束于唤醒日 06:50。因此它们都在唤醒日 10:00 的模拟到达之前。
 */
function wakeDayBundle(day: number): string {
  const previous = day - 1;
  return workout(day, day - 1)
    + Array.from({ length: 15 }, (_, sample) => heartRecord(day, day - 1, sample)).join("")
    + sleepRecord(previous, dateOfDay(previous), "23:10", dateOfDay(day), "06:40",
      "HKCategoryValueSleepAnalysisAsleepCore")
    + hrvRecord(previous, 48 + (previous % 6))
    + restingHeartRateRecord(previous);
}

function baselineChunkXml(fromWakeDay: number, toWakeDay: number): string {
  const parts: string[] = [];
  for (let day = fromWakeDay; day <= toWakeDay; day += 1) parts.push(wakeDayBundle(day));
  return healthData(parts.join(""));
}

/** 两处非相邻修订：day 5 与 day 50 各把 60 分钟从 night d 移到 night d+1，并行修订 HRV。 */
function revisionXml(): string {
  const parts: string[] = [];
  for (const day of [FIRST_REVISION_DAY, SECOND_REVISION_DAY]) {
    const d = dateOfDay(day);
    const next = nextDate(d);
    // night d：少 60 分钟（00:10 → 06:40），wake_date 仍是 day+1。
    parts.push(sleepRecord(day, next, "00:10", next, "06:40", "HKCategoryValueSleepAnalysisAsleepCore"));
    // night d+1：多 60 分钟（22:10 day+1 → 06:40 day+2）。
    parts.push(sleepRecord(day + 1, next, "22:10", nextDate(next), "06:40", "HKCategoryValueSleepAnalysisAsleepCore"));
    // 修订 day 与 day+1 的 HRV（wake_date = day+1 / day+2）。
    parts.push(hrvRecord(day, 48 + (day % 6) + 10));
    // day 5 只改 day 本身，避免把“中间期基线”也改掉；day 50 同时修订 day+1，
    // 因为 EVAL_2 在 day 52 的 wake date 上评估。
    if (day === SECOND_REVISION_DAY) {
      parts.push(hrvRecord(day + 1, 48 + ((day + 1) % 6) + 10));
    }
  }
  return healthData(parts.join(""));
}

/** 基线分段：1–33 分五段，34–52 逐日；每段到达时刻 = 段末那天的 10:00。 */
const BASELINE_BATCHES: ReadonlyArray<{ batchId: string; from: number; to: number; arrivalDay: number }> = [
  { batchId: "t12-baseline-1", from: 1, to: 7, arrivalDay: 7 },
  { batchId: "t12-baseline-2", from: 8, to: 14, arrivalDay: 14 },
  { batchId: "t12-baseline-3", from: 15, to: 21, arrivalDay: 21 },
  { batchId: "t12-baseline-4", from: 22, to: 28, arrivalDay: 28 },
  { batchId: "t12-baseline-5", from: 29, to: 33, arrivalDay: 33 },
  ...Array.from({ length: 19 }, (_, index) => {
    const day = 34 + index;
    return { batchId: `t12-baseline-${day}`, from: day, to: day, arrivalDay: day };
  })
];

interface Workspace { root: string; store: RaiDatabase; main: string }

async function openWorkspace(prefix: string): Promise<Workspace> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const main = join(root, "rai.sqlite");
  return { root, main, store: await RaiDatabase.open(main) };
}

function closeWorkspace(workspace: Workspace): void {
  workspace.store.close();
  rmSync(workspace.root, { recursive: true, force: true });
}

async function importXml(
  workspace: Workspace, xml: string, jobId: string, now: string,
  deletedRecords: Array<{ type: string; uuid: string }> = []
): Promise<NonNullable<ImportJobResponse["summary"]>> {
  const inputPath = join(workspace.root, `input-${jobId}`);
  mkdirSync(inputPath, { recursive: true });
  writeFileSync(join(inputPath, "export.xml"), xml);
  writeFileSync(join(inputPath, "sync-manifest.json"), JSON.stringify({
    version: 2, sourceScope: "healthkit", sourceIds: [],
    deletedSourceIds: [], deletedRecords
  }));
  const payloadSha256 = await computeImportPayloadSha256(inputPath, {
    preserveAbsent: true, contractVersion: CONTRACT_VERSION,
    engine: `typescript@${NATIVE_VERSION}`, identityAlgorithm: identityAlgorithmFingerprint()
  });
  const input: DirectSyncImportInput = {
    databasePath: workspace.main, inputPath, jobId, payloadSha256,
    startedAtMs: Date.parse(now) - 1_000, now
  };
  const outcome = await applyDirectSyncImport(input);
  assert.ok(!isDirectSyncRejection(outcome), `真实直连导入被拒：${JSON.stringify(outcome)}`);
  assert.ok(outcome.summary);
  return outcome.summary;
}

function analysisJobIdOf(summary: NonNullable<ImportJobResponse["summary"]>): string {
  // 回执的 summary 顶层携带 `analysisJobId`（与 import_batches.summary_json 同值）。
  const jobId = summary.analysisJobId;
  assert.ok(typeof jobId === "string" && jobId.length > 0,
    `导入回执必须携带 analysisJobId：${JSON.stringify(summary.directSync)}`);
  return jobId;
}

/** 基线批次只用于建立父发布；其登记任务走仓库现有取消接口，不删除历史。 */
function cancelAnalysisJob(workspace: Workspace, jobId: string): void {
  const result = new RaiApplicationService(workspace.store).requestJobCancellation(jobId);
  assert.equal(result.outcome, "cancelled", `基线任务 ${jobId} 必须能在执行前取消：${JSON.stringify(result)}`);
}

/** 生产消费路径：只读连接捕获 input binding，再领取下一条 queued 任务。 */
function runQueuedDirectJob(workspace: Workspace): NonNullable<ReturnType<RaiApplicationService["runNextJob"]>> {
  const inputDatabase = RaiDatabase.openReadonly(workspace.main);
  try {
    const service = new RaiApplicationService(
      workspace.store, "owned", undefined, undefined,
      new SqliteAnalysisInputReader(inputDatabase, "direct-sync", DEFAULT_ANALYSIS_INPUT_BUDGET)
    );
    const job = service.runNextJob();
    assert.ok(job, "必须有可领取的分析任务");
    return job;
  } finally { inputDatabase.close(); }
}

/**
 * B 的明确隔离对照：取消 B 的导入登记任务后，用一个 **direct-sync 形态的全量
 * 任务**（无 incrementalPlan）在同一父发布上计算。它仍走生产消费者、input
 * binding 与 coverage，因此 A/B 的 binding/coverage 投影可以逐字段比较。
 */
function enqueueControlledFull(workspace: Workspace, batchId: string, evaluatedAt: string): string {
  const db = workspace.store.database;
  const batch = db.prepare(`SELECT raw_generation AS raw, dependency_generation AS dependency
    FROM import_batches WHERE id = ?`).get(batchId) as { raw: number; dependency: number } | undefined;
  assert.ok(batch, `对照批次 ${batchId} 必须存在`);
  const active = db.prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton=1").get() as
    { id: string } | undefined;
  const datasetVersion = String((db.prepare(
    "SELECT value FROM import_manifest WHERE key='dataset_version'").get() as { value: string }).value);
  return new RecomputeJobRepository(db).enqueue("import", datasetVersion, {
    mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
    importBatchId: batchId,
    evaluatedAt,
    timezoneIdentifier: TZ
  }, {
    targetRawGeneration: Number(batch.raw),
    targetDependencyGeneration: Number(batch.dependency),
    ...(active === undefined ? {} : { expectedIncumbentReleaseId: active.id }),
    dirty: { reasons: ["controlled_full_comparison"], unknownRecordTypes: [], from: null }
  });
}

function activeModelRunId(store: RaiDatabase): string {
  const row = store.database.prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton=1").get();
  assert.ok(row);
  return String((row as { id: string }).id);
}

interface DomainSnapshot { snapshotKey: string; asOf: string; payload: unknown }

function domainSnapshots(workspace: Workspace, domain: "readiness" | "fitness"): DomainSnapshot[] {
  const projection = readBusinessProjection(workspace.store);
  const table = projection.tables.find((candidate) => candidate.name === "model_domain_snapshots");
  assert.ok(table);
  return table.rows
    .filter((row) => String((row as { domain?: unknown }).domain) === domain)
    .map((row) => ({
      snapshotKey: String((row as { snapshotKey?: unknown }).snapshotKey),
      asOf: String((row as { asOf?: unknown }).asOf),
      payload: (row as { payload?: unknown }).payload
    }))
    .sort((left, right) => left.snapshotKey.localeCompare(right.snapshotKey));
}

/**
 * A/B 严格视图：只剥执行身份（run/row id + 纯执行时间戳），**保留 lineage**。
 * before/after 视图另外剥 lineage（版本/父 run 会随修订变化，它不是业务指标）；
 * 这只用于“修订前后”对照，A/B 的 lineage 仍逐字段比较。
 */
function businessSnapshot(
  workspace: Workspace, domain: "readiness" | "fitness", options: { keepLineage?: boolean } = {}
): unknown {
  return domainSnapshots(workspace, domain).map((snapshot) => {
    const payload = stripExecutionIdentity(snapshot.payload) as Record<string, unknown>;
    if (options.keepLineage === false) delete payload.lineage;
    return { snapshotKey: snapshot.snapshotKey, asOf: snapshot.asOf, payload };
  });
}

function manifestValue(workspace: Workspace, key: string): string | null {
  const row = workspace.store.database.prepare(
    "SELECT value FROM import_manifest WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

interface MiddleSnapshot {
  readiness: Array<{ localDate: string; asOf: string; assessment: unknown }>;
  nights: Array<Record<string, unknown>>;
  hrvDays: Array<Record<string, unknown>>;
}

function localDayEnd(day: number): string {
  const localDate = localDay(day);
  return new Date(Math.min(
    Date.parse(new Date(Date.parse(`${localDate}T00:00:00.000Z`) + 86_400_000).toISOString().replace("Z", "+08:00")) - 1,
    Date.parse(EVAL_2)
  )).toISOString();
}

function captureMiddle(workspace: Workspace): MiddleSnapshot {
  const readiness = MIDDLE_DAYS.map((day) => ({
    localDate: localDay(day),
    asOf: localDayEnd(day),
    assessment: loadDatedReadiness(workspace.store.database, localDayEnd(day), TZ)
  }));
  const nights = workspace.store.database.prepare(
    "SELECT * FROM canonical_nights WHERE wake_date >= ? AND wake_date <= ? ORDER BY wake_date, id"
  ).all(localDay(MIDDLE_DAYS[0]!), localDay(MIDDLE_DAYS.at(-1)!)) as Array<Record<string, unknown>>;
  const hrvDays = workspace.store.database.prepare(
    "SELECT * FROM canonical_hrv_days WHERE local_date >= ? AND local_date <= ? ORDER BY local_date, id"
  ).all(localDay(MIDDLE_DAYS[0]!), localDay(MIDDLE_DAYS.at(-1)!)) as Array<Record<string, unknown>>;
  return { readiness, nights, hrvDays };
}

function nightsByDate(workspace: Workspace): Map<string, string> {
  const rows = workspace.store.database.prepare("SELECT * FROM canonical_nights ORDER BY wake_date, id")
    .all() as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => [String(row.wake_date), JSON.stringify({ ...row })]));
}

function copyDatabase(source: string, destination: string): void {
  const db = new DatabaseSync(source);
  try {
    db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } finally { db.close(); }
}

function countQueued(workspace: Workspace): number {
  return Number((workspace.store.database.prepare(
    "SELECT COUNT(*) AS n FROM recompute_jobs WHERE status='queued'").get() as { n: number }).n);
}

test("P3-06 T12（原任务主路径）：真实到达的 v2 XML→原任务 partial 消费→发布，A/B 零差分", { timeout: 600_000 }, async () => {
  const a = await openWorkspace("rai-t12-real-a-");
  const b = await openWorkspace("rai-t12-real-b-");
  try {
    // ── 基线：按真实到达顺序分段导入；每批登记的分析任务用生产取消接口取消，
    // 因为父发布必须由同一 EVAL_2 的显式全量建立（不是丢弃历史）。
    for (const workspace of [a, b]) {
      for (const batch of BASELINE_BATCHES) {
        const summary = await importXml(
          workspace,
          baselineChunkXml(batch.from, batch.to),
          batch.batchId,
          arrivalAt(batch.arrivalDay)
        );
        assert.equal(summary.directSync?.ingestStatus, "committed");
        cancelAnalysisJob(workspace, analysisJobIdOf(summary));
      }
      assert.equal(countQueued(workspace), 0, "基线导入不得留下无主 queued 任务");
      // 父发布也走生产 direct-sync 消费路径（而不是 CLI 全量）：只有这样才能留下
      // `analysis_run_input_bindings`，后续修订任务的 partial 复用才有可信基线。
      // 第一次对照全量从“无证据源”建立基线；第二次同条件全量让父 run 拥有
      // `zoneEvidenceSnapshot.sourceRunId`（复用证明要求前缀来自有证据的父 run）。
      const seedJob = enqueueControlledFull(workspace, "t12-baseline-52", EVAL_2);
      const seedResult = runQueuedDirectJob(workspace);
      assert.equal(seedResult.id, seedJob);
      assert.equal(seedResult.status, "succeeded", `基线全量失败：${JSON.stringify(seedResult)}`);
      const parentJob = enqueueControlledFull(workspace, "t12-baseline-52", EVAL_2);
      const parentResult = runQueuedDirectJob(workspace);
      assert.equal(parentResult.id, parentJob, "父发布必须由对照全量任务领取");
      assert.equal(parentResult.status, "succeeded", `父发布失败：${JSON.stringify(parentResult)}`);
    }

    const parentReleaseA = activeModelRunId(a.store);
    const readinessBefore = businessSnapshot(a, "readiness", { keepLineage: false });
    const fitnessBefore = businessSnapshot(a, "fitness", { keepLineage: false });
    const middleBefore = captureMiddle(a);
    const nightsBefore = nightsByDate(a);
    assert.equal(middleBefore.readiness.length, MIDDLE_DAYS.length);
    assert.equal(middleBefore.nights.length, MIDDLE_DAYS.length);
    assert.equal(middleBefore.hrvDays.length, MIDDLE_DAYS.length);

    // ── 同一修订包、同一 EVAL_2 到达：两个独立库走真实 v2 接收 + 局部夜重建 + 任务登记。
    const revision = revisionXml();
    const revisionA = await importXml(a, revision, "t12-revision", EVAL_2);
    const revisionB = await importXml(b, revision, "t12-revision", EVAL_2);
    assert.equal(revisionA?.directSync?.analysisStatus, "queued");
    assert.equal(revisionB?.directSync?.analysisStatus, "queued");
    const originalJobIdA = analysisJobIdOf(revisionA);
    const originalJobIdB = analysisJobIdOf(revisionB);

    // ── 回执、批次、代次、父发布与脏证据双向核对（A 的原任务）。
    const originalJobA = a.store.database.prepare(`SELECT id, status, request_json AS request,
      dirty_json AS dirty, target_raw_generation AS targetRaw,
      target_dependency_generation AS targetDependency, expected_incumbent_release_id AS incumbent,
      created_at AS createdAt
      FROM recompute_jobs WHERE id = ?`).get(originalJobIdA) as {
        id: string; status: string; request: string; dirty: string;
        targetRaw: number; targetDependency: number; incumbent: string | null; createdAt: string;
      } | undefined;
    assert.ok(originalJobA, "回执 analysisJobId 必须指向真实 recompute_jobs 行");
    assert.equal(originalJobA.status, "queued", "原任务在运行前必须保持 queued");
    const requestA = JSON.parse(originalJobA.request) as {
      mode?: string; importBatchId?: string; evaluatedAt?: string;
      incrementalPlan?: { mode?: string; dirtyFromAt?: string; domains?: Record<string, string | null> };
    };
    assert.equal(requestA.mode, DIRECT_SYNC_ANALYSIS_REQUEST_MODE);
    assert.equal(requestA.importBatchId, "t12-revision");
    assert.equal(requestA.evaluatedAt, EVAL_2, "原任务的 evaluatedAt 必须是注入的到达/评估时刻，不是墙钟");
    assert.equal(requestA.incrementalPlan?.mode, "partial", "A 必须拿到真实事务登记 partial 计划");
    assert.ok(requestA.incrementalPlan?.dirtyFromAt, "partial 计划必须有 dirtyFromAt");
    assert.equal(originalJobA.incumbent, parentReleaseA, "原任务必须绑定当前父发布");

    const batchA = a.store.database.prepare(`SELECT raw_generation AS raw,
      dependency_generation AS dependency, analysis_dirty_plan_json AS dirty
      FROM import_batches WHERE id='t12-revision'`).get() as
      { raw: number; dependency: number; dirty: string };
    assert.equal(Number(batchA.raw), Number(originalJobA.targetRaw));
    assert.equal(Number(batchA.dependency), Number(originalJobA.targetDependency));
    const dirtyPlan = JSON.parse(batchA.dirty) as {
      full: boolean; dirtyFromAt: string | null; domains: Record<string, string | null>; reasons: string[];
    };
    const jobDirty = JSON.parse(originalJobA.dirty) as { from?: string | null; reasons?: string[] };
    assert.equal(dirtyPlan.full, false, "两个不相邻时期必须保持有界 partial");
    assert.ok(dirtyPlan.domains.readiness, "readiness 域必须有边界");
    assert.equal(jobDirty.from, dirtyPlan.dirtyFromAt, "任务 dirty.from 必须与批次脏证据同源");
    assert.ok(!dirtyPlan.reasons.includes("unknown_record_type"));

    // ── canonical 局部重建：只允许两段修订日期变化，中间 36..49 逐字节不变。
    const nightsAfterImport = nightsByDate(a);
    const changedDates = [...nightsAfterImport.keys()]
      .filter((date) => nightsAfterImport.get(date) !== nightsBefore.get(date));
    const expectedChanged = [
      localDay(FIRST_REVISION_DAY + 1), localDay(FIRST_REVISION_DAY + 2),
      localDay(SECOND_REVISION_DAY + 1), localDay(SECOND_REVISION_DAY + 2)
    ];
    assert.deepEqual(changedDates.sort(), expectedChanged.sort(),
      `只允许两段旧/新夜变化，实际：${JSON.stringify(changedDates)}`);
    const middleAfterImport = captureMiddle(a);
    assert.deepEqual(middleAfterImport.nights, middleBefore.nights,
      "未触及的中间 canonical_nights（含 computed_at）必须逐字节不变");
    assert.deepEqual(middleAfterImport.hrvDays, middleBefore.hrvDays,
      "未触及的中间 canonical_hrv_days（含 computed_at）必须逐字节不变");

    // ── 负对照 1：改变到达时间必须改变 as-of 结果。
    // 在 A 的完整副本上把所有 canonical 到达时间推到 EVAL_2，再看 day 36 日终
    // readiness：它必须不再是修订前那个“当时已知”的评估。
    const arrivalControl = join(a.root, "arrival-control.sqlite");
    copyDatabase(a.main, arrivalControl);
    const arrivalDb = new DatabaseSync(arrivalControl);
    try {
      arrivalDb.prepare("UPDATE canonical_nights SET computed_at = ?").run(EVAL_2);
      arrivalDb.prepare("UPDATE canonical_hrv_days SET computed_at = ?").run(EVAL_2);
      const controlDay = MIDDLE_DAYS[0]!;
      const originalAssessment = middleBefore.readiness.find((entry) => entry.localDate === localDay(controlDay))!.assessment;
      const tamperedAssessment = loadDatedReadiness(arrivalDb, localDayEnd(controlDay), TZ);
      assert.notDeepEqual(tamperedAssessment, originalAssessment,
        "把到达时间改晚必须让当天的 readiness 证据不可用；若仍相等，说明 availability 没被真实使用");
    } finally { arrivalDb.close(); }

    // ── A：直接领取导入事务登记的原任务（不 DELETE、不复制计划）。
    const resultA = runQueuedDirectJob(a);
    const mergeA = a.store.database.prepare(`SELECT covering_job_id AS coveringId, state,
      covering_model_run_id AS coveringRun FROM analysis_job_merges WHERE covered_job_id = ?`)
      .get(originalJobIdA) as { coveringId: string; state: string; coveringRun: string | null } | undefined;
    if (mergeA !== undefined) {
      assert.equal(mergeA.state, "published", "原任务若被正式覆盖，覆盖关系必须已发布");
      assert.ok(mergeA.coveringRun, "覆盖任务必须产生发布 run");
    } else {
      assert.equal(resultA.id, originalJobIdA, "A 必须领取原任务 ID，而不是另建无关联任务");
    }
    const settledA = a.store.database.prepare(`SELECT status, model_run_id AS modelRunId,
      target_raw_generation AS targetRaw, target_dependency_generation AS targetDependency
      FROM recompute_jobs WHERE id = ?`).get(originalJobIdA) as {
        status: string; modelRunId: string | null; targetRaw: number; targetDependency: number;
      };
    assert.equal(settledA.status, "succeeded", `A 原任务必须持久成功：${JSON.stringify(settledA)}`);
    assert.ok(settledA.modelRunId, "A 原任务必须发布一个 model run（不能留下未消费 queued 行）");
    const finalRunA = activeModelRunId(a.store);
    assert.equal(finalRunA, settledA.modelRunId, "A 的 active 指针必须指向原任务发布的 run");

    // 实际消费证据：input binding + coverage + 复用计数。
    const bindingA = a.store.database.prepare(`SELECT job_id AS jobId, scope,
      captured_raw_generation AS capturedRaw, captured_dependency_generation AS capturedDependency,
      target_raw_generation AS targetRaw, target_dependency_generation AS targetDependency,
      cutoff_at AS cutoffAt, executed_plan_json AS executedPlan
      FROM analysis_run_input_bindings WHERE run_id = ?`).get(finalRunA) as {
        jobId: string; scope: string; capturedRaw: number; capturedDependency: number;
        targetRaw: number; targetDependency: number; cutoffAt: string; executedPlan: string | null;
      } | undefined;
    assert.ok(bindingA, "A 的生产消费必须留下 input binding");
    assert.equal(bindingA.jobId, originalJobIdA);
    assert.equal(bindingA.scope, "direct-sync");
    assert.equal(Number(bindingA.capturedDependency), Number(originalJobA.targetDependency));
    assert.equal(bindingA.cutoffAt, EVAL_2);
    const coverageA = a.store.database.prepare(`SELECT import_batch_id AS batchId,
      dependency_generation_from AS fromGeneration, dependency_generation_to AS toGeneration
      FROM analysis_job_coverage WHERE job_id = ? ORDER BY import_batch_id`).all(originalJobIdA) as
      Array<{ batchId: string; fromGeneration: number; toGeneration: number }>;
    assert.deepEqual(coverageA.map((row) => row.batchId), ["t12-revision"],
      "A 原任务的实际覆盖批次必须包含修订批次");
    assert.equal(Number(coverageA[0]!.toGeneration), Number(originalJobA.targetDependency));

    const metricRun = a.store.database.prepare(
      "SELECT id FROM training_metric_runs WHERE model_run_id = ? AND status='succeeded' ORDER BY created_at DESC LIMIT 1"
    ).get(finalRunA) as { id: string } | undefined;
    assert.ok(metricRun);
    const metricSummary = JSON.parse(String(a.store.database.prepare(
      "SELECT summary_json AS json FROM training_metric_runs WHERE id=?"
    ).get(metricRun.id)?.json ?? "{}")) as {
      reuse?: {
        proof?: string;
        loads?: { reused?: number };
        zoneProfiles?: { reused?: number };
        dailyMetrics?: { reused?: number };
      };
    };
    assert.equal(metricSummary.reuse?.proof, "verified",
      `A 的 partial 计划必须走真实复用证明：${JSON.stringify(metricSummary.reuse)}`);
    // 复审 §3.2：精确断言（不是 reused>0）。夹具是固定的 52 天真实到达序列与
    // 固定的 EVAL_2 时钟，所以这三个数字是确定性产物，不是当次观测的偶然值。
    assert.equal(metricSummary.reuse?.loads?.reused, 4,
      `loads 复用数必须精确等于 4：${JSON.stringify(metricSummary.reuse?.loads)}`);
    assert.equal(metricSummary.reuse?.zoneProfiles?.reused, 4,
      `zoneProfiles 复用数必须精确等于 4：${JSON.stringify(metricSummary.reuse?.zoneProfiles)}`);
    assert.equal(metricSummary.reuse?.dailyMetrics?.reused, 4,
      `dailyMetrics 复用数必须精确等于 4：${JSON.stringify(metricSummary.reuse?.dailyMetrics)}`);

    // ── B：取消导入时登记的任务（生产取消接口），再用明确隔离的 direct-sync 全量对照。
    const cancelB = new RaiApplicationService(b.store).requestJobCancellation(originalJobIdB);
    assert.equal(cancelB.outcome, "cancelled", "B 的导入登记任务必须能按生产接口取消");
    const controlledFullJobB = enqueueControlledFull(b, "t12-revision", EVAL_2);
    const resultB = runQueuedDirectJob(b);
    assert.equal(resultB.id, controlledFullJobB);
    assert.equal(resultB.status, "succeeded", `B 的全量对照失败：${JSON.stringify(resultB)}`);
    const settledB = b.store.database.prepare(
      "SELECT status, model_run_id AS modelRunId FROM recompute_jobs WHERE id=?"
    ).get(controlledFullJobB) as { status: string; modelRunId: string | null };
    assert.equal(settledB.status, "succeeded");
    assert.ok(settledB.modelRunId);
    assert.equal(activeModelRunId(b.store), settledB.modelRunId);
    assert.equal(countQueued(a), 0, "A 结束后不得留下无主 queued 任务");
    assert.equal(countQueued(b), 0, "B 结束后不得留下无主 queued 任务");

    // ── 完整 15 表/投影逐字段等价（含 binding/coverage、bundle、active 指针、可读状态）。
    const projectionA = readBusinessProjection(a.store);
    const projectionB = readBusinessProjection(b.store);
    assertCompleteBusinessProjection(projectionA, "T12 real lane incremental");
    assertCompleteBusinessProjection(projectionB, "T12 real lane controlled full");
    assertBusinessEquivalent(projectionA, projectionB);

    // ── 负对照 2：篡改 active 指针必须让业务比较器失败。
    // 在 A 的副本上把 active 指回父发布（bundle 仍完整存在，因此失败必须来自
    // “可读状态/active 指针不一致”，而不是副本损坏）。真实 A 库不受影响。
    const pointerControl = join(a.root, "pointer-control.sqlite");
    copyDatabase(a.main, pointerControl);
    const pointerStore = await RaiDatabase.open(pointerControl);
    try {
      pointerStore.database.prepare(
        "UPDATE active_model_run SET model_run_id = ? WHERE singleton = 1"
      ).run(parentReleaseA);
      pointerStore.flush();
      assert.throws(
        () => assertBusinessEquivalent(readBusinessProjection(pointerStore), readBusinessProjection(b.store)),
        /release_readable_state|active|bundle|diff/i,
        "把 active 指针改回父发布后，业务/发布投影比较必须失败"
      );
    } finally { pointerStore.close(); }

    // A/B：严格业务视图，保留 lineage；只剥 run/row 级执行身份。
    const readinessAfter = businessSnapshot(a, "readiness");
    assert.deepEqual(readinessAfter, businessSnapshot(b, "readiness"),
      "A 的原任务 partial readiness（含 lineage/availableAt）必须等于同父发布 B 的全量");
    const fitnessAfter = businessSnapshot(a, "fitness");
    assert.deepEqual(fitnessAfter, businessSnapshot(b, "fitness"));

    // 修订前后：同一评估时刻，只把 lineage/版本包络排除在“业务指标”之外。
    const readinessAfterMetrics = businessSnapshot(a, "readiness", { keepLineage: false });
    assert.notDeepEqual(readinessAfterMetrics, readinessBefore, "readiness 必须因修订真实变化");
    const fitnessAfterMetrics = businessSnapshot(a, "fitness", { keepLineage: false });
    assert.deepEqual(fitnessAfterMetrics, fitnessBefore,
      "Fitness 业务指标与解释不得被睡眠/HRV 修订污染（只允许 lineage/版本字段变化）");

    // 到达时间没有被事后改写：A/B 的 import_completed_at 与 canonical computed_at 集合
    // 必须来自同一注入时钟，且不晚于最终评估时刻。
    assert.equal(manifestValue(a, "import_completed_at"), EVAL_2);
    assert.equal(manifestValue(b, "import_completed_at"), EVAL_2);
    const rawArrivals = a.store.database.prepare(`SELECT available_at AS at, COUNT(*) AS count
      FROM health_records GROUP BY available_at ORDER BY available_at`).all() as
      Array<{ at: string | null; count: number }>;
    assert.ok(rawArrivals.length > 0);
    assert.ok(rawArrivals.every((row) => row.at !== null && Date.parse(row.at) <= Date.parse(EVAL_2)),
      "原始健康记录的可得时间必须使用注入时钟，不能落到真实墙钟");
    assert.ok(rawArrivals.some((row) => row.at === EVAL_2),
      "修订记录的 available_at 必须与该批次的 import_completed_at 相同");
    const arrivalSet = (workspace: Workspace): string[] => (workspace.store.database.prepare(
      "SELECT DISTINCT computed_at AS at FROM canonical_nights UNION SELECT DISTINCT computed_at FROM canonical_hrv_days ORDER BY at"
    ).all() as Array<{ at: string }>).map((row) => row.at);
    const arrivalsA = arrivalSet(a);
    const arrivalsB = arrivalSet(b);
    assert.ok(arrivalsA.every((at) => Date.parse(at) <= Date.parse(EVAL_2)),
      "canonical 到达时间不得晚于最终评估时刻");
    assert.deepEqual(arrivalsB, arrivalsA, "A/B 必须使用同一确定性时钟序列");

    const middleAfter = captureMiddle(a);
    assert.deepEqual(middleAfter.readiness, middleBefore.readiness,
      "中间期逐日 readiness 必须在其 as-of 语义下不变");
    assert.deepEqual(middleAfter.nights, middleBefore.nights,
      "中间期 canonical_nights 必须逐字节不变");
    assert.deepEqual(middleAfter.hrvDays, middleBefore.hrvDays,
      "中间期 canonical_hrv_days 必须逐字节不变");

    console.log(`P3_T12_REAL_LANE ${JSON.stringify({
      originalJobIdA,
      executedJobIdA: resultA.id,
      mergeA: mergeA ?? null,
      jobBinding: {
        targetRaw: originalJobA.targetRaw,
        targetDependency: originalJobA.targetDependency,
        incumbent: originalJobA.incumbent,
        evaluatedAt: requestA.evaluatedAt,
        dirtyFromAt: requestA.incrementalPlan?.dirtyFromAt
      },
      coverageA,
      reuse: metricSummary.reuse,
      finalRunA,
      finalRunB: settledB.modelRunId,
      arrivalFrom: arrivalAt(1),
      arrivalTo: EVAL_2,
      businessDiffCount: 0,
      changedNightDates: changedDates,
      middleDays: [MIDDLE_DAYS[0], MIDDLE_DAYS.at(-1)]
    })}`);
  } finally {
    closeWorkspace(a);
    closeWorkspace(b);
  }
});
