// 直连车道的**统一原始接收器**（PR4 步骤 2c/2d，docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md §2）。
//
// 这个文件要证明的是四件事，每件都配了"期望非零/期望抛错"的对照：
//   1. 本批事实、身份、账本、**分析任务**、回执在**同一个主库事务**里落库（§4.2）；
//   2. 分类决定回执：`record-only` 才允许 `not_required`，需要分析时必须是 `queued`
//      且**任务真的登记了**（不是"回执这么写而已"）；
//   3. 写权限按**表**判定：派生分析/发布表一律拒绝，未表态的新表 fail-closed；
//   4. 失败注入下整批回滚 —— 事实、批次行、任务、回执**一起消失**（A04 的形态）。
//
// ✅ 2026-10-13（PR4 步骤 2e）：本模块**已经是生产路径** —— `planDirectSyncLane` 给 `"full"`，
// worker 在 record-only 快通路拒收之后投递 `direct-sync` 任务。端到端的证明在
// `apps/api/test/import-worker-direct-sync.test.ts`（真实排队 + 真实子进程 + 真实事务）。
// ⚠️ 仍然如实标注的边界：§9.1 的"旧分数 JOIN 新训练"要在**读侧拆分**（PR5 S3–S11）之后才彻底消失；
// 今天已删事实不再进事实侧（PR5-S1/S2），但"当前事实"与"已发布分析"仍在同一个响应里。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import ts from "typescript";

import { CONTRACT_VERSION, DATABASE_TIMEZONE, healthTypes, workoutTypes } from "@rai/contracts";
import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";
import { NATIVE_VERSION, canonicalizeNightsForWindow, identityAlgorithmFingerprint } from "@rai/health-export-parser";

import {
  DIRECT_SYNC_WRITE_GUARD, INGEST_TABLE_DISPOSITIONS, applyDirectSyncImport, fullNightRebuildPeriod, isDirectSyncRejection,
  installDirectSyncWriteGuards, preflightDirectSyncPayload, unclassifiedIngestTables,
  type DirectSyncImportInput, type DirectSyncImportResult
} from "../src/direct-sync-ingest.js";
import { applyDataOnlyImport } from "../src/data-only-import.js";
import { readImportReceipt } from "../src/import-publication.js";
import { importPayloadSha256 } from "../src/import-payload-identity.js";
import { computeImportPayloadSha256 } from "../src/import-payload-identity.js";

const a = "00000000-0000-0000-0000-00000000000a";
const b = "00000000-0000-0000-0000-00000000000b";
const step = healthTypes.stepCount;
const heartRate = healthTypes.heartRate;

function record(uuid: string, value = "10", type: string = step): string {
  return `<Record type="${type}" sourceName="Watch" unit="count" value="${value}"
    startDate="2018-01-01 00:00:00 +0000" endDate="2018-01-01 00:01:00 +0000">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/>
  </Record>`;
}

function workout(startAt = "2018-01-02 08:00:00 +0000", syncId = "workout-1"): string {
  const endAt = startAt.replace("08:00:00", "08:30:00");
  return `<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
    startDate="${startAt}" endDate="${endAt}" duration="30" durationUnit="min">
    <MetadataEntry key="HKMetadataKeySyncIdentifier" value="${syncId}"/>
  </Workout>`;
}

const xml = (rows = "") => `<HealthData>${rows}</HealthData>`;

/**
 * 观测版（阶段 1）：`applyDirectSyncImport` 返回「成功 | 拒收」判别联合。
 * 本文件里**期望成功**的调用统一走这里 —— 拒收时把拒收码完整打进断言消息，
 * 而不是等 `undefined.summary` 报一个指认不了原因的类型错。
 */
async function applyOrFail(input: DirectSyncImportInput): Promise<DirectSyncImportResult> {
  const outcome = await applyDirectSyncImport(input);
  assert.ok(!isDirectSyncRejection(outcome),
    `expected a successful apply, got rejection: ${JSON.stringify(outcome)}`);
  return outcome;
}

interface Fixture {
  root: string;
  main: string;
  /** 造一个输入目录并算出与提交端一致的 payload 摘要（用生产端同一个摘要函数）。 */
  input(rows?: string, options?: {
    deletedRecords?: { type: string; uuid: string }[];
    deletedWorkoutIds?: string[];
    gpx?: Record<string, string>;
    job?: string;
    /** 直接给 `export.xml` 的原始字节（用于构造非法 UTF-8；提供时 `rows` 被忽略）。 */
    xmlBytes?: Buffer;
  }): Promise<DirectSyncImportInput>;
  seed(rows: string): Promise<void>;
}

async function fixture(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-direct-sync-"));
  const main = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(main);
  store.setManifest("dataset_version", "baseline");
  store.setManifest("parser_contract_version", CONTRACT_VERSION);
  store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  // （G4，2026-10-15）`data_only_baseline_contract` 键已退役（§4.3 不再作门槛、写入端已删），fixture 不再需要刻意跳过它。
  store.setProfile({ dateOfBirth: "1990-01-01" });
  store.close();
  let ordinal = 0;
  const input: Fixture["input"] = async (rows = "", options = {}) => {
    const inputPath = join(root, `input-${ordinal++}`);
    mkdirSync(inputPath);
    writeFileSync(join(inputPath, "export.xml"), options.xmlBytes ?? xml(rows));
    writeFileSync(join(inputPath, "sync-manifest.json"), JSON.stringify({
      version: 2, sourceScope: "healthkit", sourceIds: [],
      deletedSourceIds: options.deletedWorkoutIds ?? [],
      deletedRecords: options.deletedRecords ?? []
    }));
    for (const [name, content] of Object.entries(options.gpx ?? {})) {
      mkdirSync(join(inputPath, "workout-routes"), { recursive: true });
      writeFileSync(join(inputPath, "workout-routes", name), content);
    }
    // 🔴 摘要必须用**生产端同一个函数**算（worker 的 `computeImportPayloadSha256`），
    // 包括路由内容。从前这里手写的是"XML+manifest"配方，与生产不一致 —— 于是
    // "带 GPX 的载荷"在接收器里会被判成"载荷已变更"而硬失败，而这条用例当时**看不见**那个缺陷，
    // 因为它自己也在用那份错的配方（两边一起错 ⇒ 假绿）。改用生产函数之后，这一条同时守住了
    // "准入摘要 == 接收时的复核摘要"。它**不是**性能敏感的：夹具只有几条记录。
    const payloadSha256 = await computeImportPayloadSha256(inputPath, {
      preserveAbsent: true, contractVersion: CONTRACT_VERSION,
      engine: `typescript@${NATIVE_VERSION}`, identityAlgorithm: identityAlgorithmFingerprint()
    });
    return { databasePath: main, inputPath, jobId: options.job ?? "delta", payloadSha256, startedAtMs: Date.now() };
  };
  const seed = async (rows: string) => {
    const seeded = await RaiDatabase.open(main);
    const path = join(root, "seed.xml");
    writeFileSync(path, xml(rows));
    try {
      seeded.database.prepare(`INSERT OR IGNORE INTO import_batches
        (id,xml_sha256,status,import_mode) VALUES ('seed','seed','running','incremental')`).run();
      const { parseAppleHealthXml, canonicalizeRunningWorkouts } = await import("@rai/health-export-parser");
      await parseAppleHealthXml(path, seeded, {
        fileSize: statSync(path).size, healthKitRecordIdentity: true,
        incremental: { generation: "seed", batchId: "seed", preserveAbsent: true }
      });
      canonicalizeRunningWorkouts(seeded.database);
    } finally { seeded.close(); }
  };
  try { await run({ root, main, input, seed }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

/** 睡眠分段：跨夜（23:10 → 次日 06:40），喂 `canonical_nights`。 */
function sleepSegment(uuid: string, date: string, wake = "06:40:00"): string {
  return `<Record type="${healthTypes.sleepAnalysis}" sourceName="Watch"
    value="HKCategoryValueSleepAnalysisAsleepCore"
    startDate="${date} 23:10:00 +0800" endDate="${date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) =>
      `${y}-${m}-${String(Number(d) + 1).padStart(2, "0")}`)} ${wake} +0800">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/>
  </Record>`;
}

/** 一张表里全部行的逐字节快照（用于"窗口外一个字节都不许改"）。 */
function tableDigest(path: string, table: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()); }
  finally { db.close(); }
}

/** `canonical_nights` 按 `wake_date` 分行的逐字节快照。 */
function nightsByDate(path: string): Map<string, string> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("SELECT * FROM canonical_nights ORDER BY wake_date").all() as
      Array<Record<string, unknown>>;
    return new Map(rows.map((row) => [String(row.wake_date), JSON.stringify(row)]));
  } finally { db.close(); }
}

const scalar = (db: DatabaseSync, sql: string, ...params: unknown[]): number =>
  Number((db.prepare(sql).get(...params as never[]) as { n: number }).n);

test("record-only 载荷：事实+账本+回执同事务落库，回执 not_required 且**没有**登记分析任务", async () => {
  await fixture(async ({ main, input }) => {
    const batch = await input(record(a) + record(b, "25"));
    const applied = await applyOrFail(batch);
    assert.ok(applied, "record-only 载荷必须被接收");
    assert.equal(applied.payloadClass, "record-only");
    assert.equal(applied.replayed, false);
    assert.equal(applied.summary.directSync?.ingestStatus, "committed");
    assert.equal(applied.summary.directSync?.analysisStatus, "not_required");

    const db = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM health_records"), 2);
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM recompute_jobs"), 0,
        "record-only 批次不得登记分析任务");
      const generations = db.prepare(
        "SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton=1"
      ).get() as { raw: number; dependency: number };
      assert.equal(generations.raw, 1, "raw 代次每个批次都要递增");
      assert.equal(generations.dependency, 0, "不影响分析的批次不得递增依赖代次");
      assert.equal((db.prepare("SELECT value FROM import_manifest WHERE key='direct_sync_payload_class'").get() as { value: string }).value,
        "record-only");
      // 回执必须与磁盘上的持久回执同内容。
      assert.deepEqual(readImportReceipt(main, batch.jobId), applied.summary);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  });
});

test("P0-3/P2-3：回执带 records 计数（parsed/inserted/unchanged），提交成功的批次带四段阶段账本", async () => {
  await fixture(async ({ main, input }) => {
    // 同一份载荷会被第二个 job 再收一次：parsed 不变、inserted 掉到 0、unchanged 顶上。
    // 这正是生产里"6 批 27,000 条解析、有效新增 1,111 条"的可观测形态。
    const first = await applyOrFail(await input(record(a) + record(b, "25"), { job: "records-1" }));
    const firstRecords = first.summary.directSync?.records;
    assert.equal(firstRecords?.parsed, 2, "parsed = 本批 XML 里的 <Record> 条数");
    assert.equal(firstRecords?.inserted, 2);
    assert.equal(firstRecords?.unchanged, 0);
    // 老字段语义一个字节都没动：records 是**追加**键，不是替代。
    assert.equal(first.summary.directSync?.ingestStatus, "committed");
    assert.equal(first.summary.directSync?.analysisStatus, "not_required");
    assert.equal(first.summary.directSync?.receiptId, "records-1");

    // P2-3：四段观测键随成功结果带回；拒收/重放没有完整四段（见类型注释）。
    // 它们进 `performance.computeStagesMs`（开放键），**不**进 `stagesMs` 的闭集。
    assert.deepEqual(Object.keys(first.stagesMs ?? {}).sort(), [
      "directSync.commit", "directSync.identity", "directSync.ledger", "directSync.parse"
    ], "提交成功的批次必须带回接收器内部四段耗时");
    for (const [stage, milliseconds] of Object.entries(first.stagesMs ?? {})) {
      assert.ok(Number.isFinite(milliseconds) && milliseconds >= 0, `${stage} 必须是有限非负数`);
    }

    const second = await applyOrFail(await input(record(a) + record(b, "25"), { job: "records-2" }));
    assert.equal(second.summary.directSync?.records?.parsed, 2);
    assert.equal(second.summary.directSync?.records?.inserted, 0, "同一内容再收一次不得再报新增");
    assert.equal(second.summary.directSync?.records?.unchanged, 2);

    const db = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM health_records"), 2,
        "重复批次不得改变记录行数");
      // 持久回执与返回的 summary 同源（客户端之后只能从回执读到这些计数）。
      assert.deepEqual(readImportReceipt(main, "records-1")?.directSync?.records, firstRecords);
    } finally { db.close(); }
  });
});

test("Workout 载荷：同事务登记分析任务，回执 queued，且消费者能把它跑完（闭环）", async () => {
  await fixture(async ({ main, input }) => {
    const batch = await input(workout());
    const applied = await applyOrFail(batch);
    assert.ok(applied);
    assert.equal(applied.payloadClass, "analysis-required", "Workout 一律要求分析");
    assert.equal(applied.summary.directSync?.analysisStatus, "queued",
      "任务已经同事务登记，回执必须说 queued —— 说 published 是假话，说 not_required 更糟");

    const db = new DatabaseSync(main, { readOnly: true });
    let jobId: string;
    try {
      const job = db.prepare(`SELECT id, job_type AS jobType, status, request_json AS request,
        target_raw_generation AS raw, target_dependency_generation AS dependency,
        expected_incumbent_release_id AS incumbent, dirty_json AS dirty FROM recompute_jobs`).get() as {
          id: string; jobType: string; status: string; request: string;
          raw: number; dependency: number; incumbent: string | null; dirty: string;
        };
      jobId = job.id;
      assert.equal(job.jobType, "import");
      assert.equal(job.status, "queued");
      assert.equal(JSON.parse(job.request).mode, "direct_sync_analysis");
      assert.equal(Number(job.raw), 1);
      assert.equal(Number(job.dependency), 1, "影响分析的批次必须递增依赖代次");
      assert.equal(job.incumbent, null, "没有活跃 release 时绑定列留空，而不是编一个 id");
      const dirty = JSON.parse(job.dirty) as { reasons: string[] };
      assert.ok(dirty.reasons.includes("workout_present"), `dirty 原因必须说清为什么分析：${job.dirty}`);
      assert.equal((db.prepare("SELECT value FROM import_manifest WHERE key='direct_sync_payload_class'").get() as { value: string }).value,
        "analysis-required");
    } finally { db.close(); }

    // 闭环：用真消费者把这条任务跑完（证明登记的载荷确实是它能执行的形态）。
    const store = await RaiDatabase.open(main);
    try {
      const completed = new RaiApplicationService(store).runNextJob();
      assert.equal(completed?.id, jobId, "消费者必须领到本批登记的那条任务");
      assert.equal(completed?.status, "succeeded", JSON.stringify(completed?.error));
      assert.equal(
        Number(store.database.prepare("SELECT COUNT(*) AS n FROM active_model_run").get()!.n), 1,
        "跑完分析必须移动活跃发布指针"
      );
    } finally { store.close(); }
  });
});

/** 训练**内**的心率记录（起于给定时刻）。 */
function heartRateRecord(uuid: string, startAt: string): string {
  return `<Record type="${heartRate}" sourceName="Watch" unit="count/min" value="150"
    startDate="${startAt}" endDate="${startAt.replace(":10:00", ":11:00")}">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/>
  </Record>`;
}

test("O04：训练内的记录变更把脏下界回退到相交训练起点（不再是变更时刻）", async () => {
  await fixture(async ({ main, input, seed }) => {
    // 先落下一个训练（08:00–08:30）。
    await seed(workout("2018-01-02 08:00:00 +0000", "workout-1"));
    // 第二批只有训练**内**（08:10）的一条心率：旧 `dirtyFromAt()` 的边界会是 08:10
    // （训练起点之后）⇒ `extractFeatures` 把该训练当成未受影响、错误复用旧特征。
    // 相交回退必须把下界压到训练起点 08:00。
    const batch = await input(heartRateRecord("00000000-0000-0000-0000-0000000000c1", "2018-01-02 08:10:00 +0000"));
    const applied = await applyOrFail(batch);
    assert.ok(applied);

    const db = new DatabaseSync(main, { readOnly: true });
    try {
      const job = db.prepare("SELECT request_json AS request, dirty_json AS dirty FROM recompute_jobs")
        .get() as { request: string; dirty: string };
      const plan = JSON.parse(job.request).incrementalPlan as {
        mode: string; dirtyFromAt: string; domains?: { features: string | null };
      };
      assert.equal(plan.mode, "partial", "有界变更必须走 partial");
      assert.equal(plan.dirtyFromAt, "2018-01-02T08:00:00.000Z",
        "脏下界必须回退到相交训练的起点（训练 08:00 起、变更 08:10）");
      assert.equal(plan.domains?.features, "2018-01-02T08:00:00.000Z",
        "分域边界与总边界一致（本批无恢复/路线变更）");
      const dirty = JSON.parse(job.dirty) as { from: string };
      assert.equal(dirty.from, "2018-01-02T08:00:00.000Z", "dirty.from 与 incrementalPlan 同源");
    } finally { db.close(); }
  });
});

test("删除-only 载荷：显式删除先于到达也要求分析，且不误删同来源其它事实", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(workout() + workout("2018-01-03 08:00:00 +0000", "workout-2"));
    const before = new DatabaseSync(main, { readOnly: true });
    const workoutsBefore = scalar(before, "SELECT COUNT(*) AS n FROM workouts");
    before.close();
    assert.equal(workoutsBefore, 2);

    // 删除-only：没有任何 Record/Workout 载荷，只有 manifest 里的显式删除。
    const batch = await input("", { deletedWorkoutIds: ["workout-1"] });
    const applied = await applyOrFail(batch);
    assert.ok(applied);
    assert.equal(applied.payloadClass, "analysis-required", "删除-only 页面不是 EOF，也必须分析");
    assert.equal(applied.summary.removedWorkouts, 1);

    const db = new DatabaseSync(main, { readOnly: true });
    try {
      // 软删（v36）：行保留并标 deleted_at，所以"删掉了"= 不再是**仍在**的训练。
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM workouts WHERE deleted_at IS NULL"), 1,
        "只删点名的那一条");
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM workouts WHERE deleted_at IS NOT NULL"), 1,
        "被删的那条必须保留行并标记（路线版本证据不能级联消失）");
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM workouts"), 2);
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM recompute_jobs WHERE status='queued'"), 1);
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM import_source_tombstones"), 1,
        "删除必须留墓碑，防止后续载荷复活它");
    } finally { db.close(); }
  });
});

test("GPX 路线：路线变更同样要求分析，且路线版本对读侧可见（末批发布）", async () => {
  await fixture(async ({ main, input }) => {
    const gpx = `<gpx><trk><trkseg>${[0, 1, 2].map((index) =>
      `<trkpt lat="23.1${index}" lon="113.3${index}"><ele>12.5</ele><time>2018-01-02T00:00:0${index}Z</time></trkpt>`
    ).join("")}</trkseg></trk></gpx>`;
    const batch = await input(
      `<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
        startDate="2018-01-02 08:00:00 +0000" endDate="2018-01-02 08:30:00 +0000"
        duration="30" durationUnit="min">
        <MetadataEntry key="HKMetadataKeySyncIdentifier" value="workout-gpx"/>
        <WorkoutRoute><FileReference path="/workout-routes/route-1.gpx"/></WorkoutRoute>
      </Workout>`,
      { gpx: { "route-1.gpx": gpx } }
    );
    const applied = await applyOrFail(batch);
    assert.ok(applied);
    assert.equal(applied.payloadClass, "analysis-required", "路线变更必须要求分析（它改变本训练特征与时间线）");
    // 回执与分类必须一致：路线批次同样要 `queued`（突变"忽略分类"第一次跑时正是这条缺失，
    // 让 GPX 用例在该突变下**假绿**了）。
    assert.equal(applied.summary.directSync?.analysisStatus, "queued");
    const db = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM recompute_jobs"), 1,
        "路线批次必须登记分析任务（否则轨迹补齐不会反映到分析里）");
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM workout_routes"), 1);
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM route_version_points"), 3, "点必须落在版本表里");
      const pointer = db.prepare("SELECT published_route_version_id AS id FROM workout_routes").get() as { id: string | null };
      assert.ok(pointer.id, "整条补齐后必须原子发布指针");
      assert.equal(scalar(db, `SELECT COUNT(*) AS n FROM route_versions
        WHERE id = ? AND status='complete'`, pointer.id), 1);
      // 🔴 B05（2026-10-17）：路线变更的计划必须**持久化到批次行**（v45）。
      // 没有它，消费端只能从账本重建计划 —— 而账本不记路线，于是含 GPX 的批次一律全量。
      const evidenceJson = (db.prepare(
        "SELECT analysis_dirty_plan_json AS json FROM import_batches WHERE id = ?"
      ).get("delta") as { json: string | null } | undefined)?.json;
      assert.ok(evidenceJson, "含路线的批次必须写下分析影响证据");
      const evidence = JSON.parse(evidenceJson) as {
        version: number; full: boolean; dirtyFromAt: string | null;
        routeDirtyTimes: string[]; domains: Record<string, string | null>;
      };
      assert.equal(evidence.version, 1, "证据必须版本化");
      assert.equal(evidence.full, false,
        "一场新增跑步 + 有效 GPX 不应退化成 full —— 这正是 B05 的收益");
      assert.ok(evidence.dirtyFromAt, "必须给出可复用的边界");
      assert.equal(evidence.routeDirtyTimes.length, 1,
        "路线变更必须记下所属训练的时刻（合成 route 条目的原始输入）");
      const routeDirtyTime = evidence.routeDirtyTimes[0] ?? "";
      assert.ok(routeDirtyTime.startsWith("2018-01-02T08:00:00"),
        `路线影响时刻必须指向该训练：${routeDirtyTime}`);
      // §7.2 步骤 7：路线变更**同时**推进三个域 —— 只推进 features 会让负荷/分区
      // 拿旧训练量去拼新轨迹（"只改一条路线"不等于"只改一行分数"）。
      assert.equal(evidence.domains.features, evidence.dirtyFromAt);
      assert.equal(evidence.domains.fitness, evidence.dirtyFromAt,
        "路线变更必须同时推进负荷边界");
      assert.equal(evidence.domains.readiness, evidence.dirtyFromAt,
        "路线变更必须同时推进恢复/分区边界");
      assert.ok((evidence.dirtyFromAt ?? "") <= routeDirtyTime,
        "边界不得晚于路线所属训练的开始时刻（否则训练前半段不会被重算）");
    } finally { db.close(); }
  });
});

// P3a（2026-10-14）：`manifest_exceeds_bounds` 的响应 `bounds` 键必须是 `maxManifestBytes`。
//
// 为什么这里要一条**源码级**判据而不是行为判据：造一个 >8 MiB 的 manifest 夹具成本很高
// （manifest 的体积由删除账本撑起来），而这条错配的失效方式是**静默**的 ——
// `actual` 报 `manifestBytes`、`bounds` 却报 `maxXmlBytes`，同一个对象的两半在说两件事，
// 排查时无法区分"manifest 超了"还是"xml 超了"。它不会让任何**既有**测试变红。
test("manifest_exceeds_bounds 的 bounds 键必须与 actual 同指一个量（P3a）", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/direct-sync-ingest.ts"), "utf8");
  const sites = source.split(/\r?\n/).filter((line) => line.includes("manifestBytes: manifest"));
  assert.equal(sites.length, 2,
    "manifest 上界有两处判定（文件字节 / 文本字节），两处都必须带 bounds");
  for (const line of sites) {
    assert.ok(line.includes("bounds: { maxManifestBytes: DIRECT_SYNC_MAX_XML_BYTES }"),
      `manifest 的 bounds 键必须报 maxManifestBytes（= 被量的那个量），实际：${line.trim()}`);
  }
  // 反向对照：xml 那一处必须**仍然**报 maxXmlBytes —— 否则上面那条可以靠"把两处改成同一个键"骗过去。
  assert.ok(source.includes("bounds: { maxXmlBytes: DIRECT_SYNC_MAX_XML_BYTES }"),
    "xml_exceeds_bounds 的 bounds 键必须保持 maxXmlBytes（两处误报同一个键就分不清谁超了）");
});

test("超限/杂物载荷 ⇒ **带码拒收**（回退旧链路）且零写入（观测版 S1.1）", async () => {
  await fixture(async ({ main, input }) => {
    // 超过 xml 上界（2026-10-14 起 8 MiB；此前 2 MiB）。不做"先收一半"。
    const oversized = await input(record(a, "1".repeat(8_800_000)));
    const oversizedOutcome = await applyDirectSyncImport(oversized);
    assert.ok(isDirectSyncRejection(oversizedOutcome),
      `超限载荷必须被拒收，实际：${JSON.stringify(oversizedOutcome)}`);
    assert.equal(oversizedOutcome.reason, "xml_exceeds_bounds");
    assert.equal(oversizedOutcome.stage, "prepare");
    // 观测版的核心承诺：拒收**带实测值与上界**（"为什么拒"不能只有结论）。
    assert.ok((oversizedOutcome.actual?.xmlBytes ?? 0) > 8 * 1024 * 1024,
      "拒收记录必须带实测字节数");
    assert.equal(oversizedOutcome.bounds?.maxXmlBytes, 8 * 1024 * 1024);
    // 输入目录里有非 GPX 的杂物也不合格：输入集合必须可枚举。
    const dirty = await input(record(a));
    writeFileSync(join(dirty.inputPath, "notes.txt"), "hello");
    const dirtyOutcome = await applyDirectSyncImport(dirty);
    assert.ok(isDirectSyncRejection(dirtyOutcome),
      `含杂物的输入目录必须被拒收，实际：${JSON.stringify(dirtyOutcome)}`);
    assert.equal(dirtyOutcome.reason, "input_tree_not_allowed");
    // 输入目录整体缺失（成功导入后的清理 / 外部删除）⇒ 受控拒收，不许 ENOENT 冒泡成 500
    // （inspect 路由对"已导入"来源已在更上一层跳过 preflight；这里是 worker 兜底防线）。
    const missing = await input(record(a));
    rmSync(missing.inputPath, { recursive: true, force: true });
    const missingOutcome = await applyDirectSyncImport(missing);
    assert.ok(isDirectSyncRejection(missingOutcome),
      `目录缺失必须受控拒收，实际：${JSON.stringify(missingOutcome)}`);
    assert.equal(missingOutcome.reason, "missing_required_files");
    assert.equal(missingOutcome.stage, "prepare");

    const db = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM health_records"), 0);
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM import_batches"), 0);
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM recompute_jobs"), 0);
      assert.equal((db.prepare("SELECT raw_generation AS raw FROM import_generations WHERE singleton=1").get() as { raw: number }).raw, 0);
    } finally { db.close(); }
  });
});

// ---------------------------------------------------------------------------
// P2-4（2026-10-15）：收口核心窗口 (2, 8] MiB 的正向覆盖。
//
// 为什么单列：2026-10-14 真机事故（2.41 MB 批被 400 硬拒）正落在该窗口，而当时全部
// 测试只覆盖两个端点（<2 MiB 的夹具自证、>8 MiB 的拒收）——窗口内部与边界没有任何用例。
// 上界再被调整、或比较符被改（`>` 变 `>=`）时，都不该没有测试拦住。
// ---------------------------------------------------------------------------

test("收口窗口 (2, 8] MiB：data-only 拒、统一接收器接受（P2-4）", async () => {
  await fixture(async ({ main, input }) => {
    // 批量记录把 xml 推过 2 MiB（record-only 上界），但仍在 8 MiB（直连上界）以内。
    // startDate 逐条 +1 秒：canonical id 依赖它，重复时刻会让夹具撞唯一约束（造出真机不存在形态）。
    const pad = (value: number): string => String(value).padStart(2, "0");
    const bulk = Array.from({ length: 9_000 }, (_, index) => {
      const moment = new Date(Date.UTC(2018, 0, 1, 0, 0, index));
      const stamp = `${moment.getUTCFullYear()}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())} ` +
        `${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())} +0000`;
      const uuid = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      return `<Record type="${step}" sourceName="Watch" unit="count" value="10" startDate="${stamp}" endDate="${stamp}">` +
        `<MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/></Record>`;
    }).join("\n");
    const windowed = await input(bulk);
    const bytes = statSync(join(windowed.inputPath, "export.xml")).size;
    assert.ok(bytes > 2 * 1024 * 1024 && bytes < 8 * 1024 * 1024,
      `夹具必须落在收口窗口 (2, 8] MiB 内，实际 ${bytes} 字节`);
    // 1) record-only 快通路在形状层超限 ⇒ 拒（大小检查先于 compatible，不解析、零写入）。
    assert.equal(await applyDataOnlyImport(windowed), null,
      ">2 MiB 载荷必须被 record-only 快通路拒收（两条车道的大小上界本就不同）");
    // 2) 统一接收器必须接受同一载荷：窗口内合法，数据真的落库。
    await applyOrFail(windowed);
    const db = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM health_records"), 9_000);
    } finally { db.close(); }
  });
});

test("边界：恰好等于 8 MiB 不算超（服务端语义是严格 >，P2-4）", async () => {
  await fixture(async ({ input }) => {
    // 精确构造：`record(a, value)` 的 xml 字节长度对 value 长度线性，按差值补足到恰好上界。
    const skeleton = Buffer.byteLength(xml(record(a, "")), "utf8");
    const filler = "1".repeat(8 * 1024 * 1024 - skeleton);
    const exact = await input(record(a, filler));
    assert.equal(statSync(join(exact.inputPath, "export.xml")).size, 8 * 1024 * 1024,
      "夹具必须精确落在上界（构造偏差会让这条用例测的不是边界）");
    // 恰好上界 ⇒ 预检通过（`direct-sync-ingest.ts:418` 是严格 `>`；本用例只走预检、不解析）。
    const atBound = preflightDirectSyncPayload(exact.inputPath);
    assert.ok(atBound.ok, `恰好 8 MiB 必须通过预检，实际：${JSON.stringify(atBound)}`);
    // 对照：上界 +1 字节 ⇒ 必须以 xml_exceeds_bounds 拒收。
    const over = await input(record(a, filler + "1"));
    assert.equal(statSync(join(over.inputPath, "export.xml")).size, 8 * 1024 * 1024 + 1);
    const overBound = preflightDirectSyncPayload(over.inputPath);
    assert.ok(!overBound.ok && overBound.rejection.reason === "xml_exceeds_bounds",
      `8 MiB+1 必须拒收且带对应 reason，实际：${JSON.stringify(overBound)}`);
  });
});

/**
 * 观测版（阶段 1，S1.1）的**拒收码词典**：每类构造载荷都必须带正确 `reason` 被拒。
 * 这些码是 stderr 日志与 `performance_json.lane.rejections` 的机器面 —— 改码等于改观测契约，
 * 所以每一条都单独钉住（而不是只断言"被拒了"）。
 *
 * 覆盖边界（如实标注）：`pending_migrations` / `write_guard_triggered` 的**入口形状**
 * 分别要求一个真欠迁移的库与一个能触发守卫的写路径，前者另有用例（写守卫测试），
 * 后者需要注入分析表写入 —— 两者都不在本用例里伪造。
 */
test("P6-F05：非法 manifest 版本在 preflight 返回稳定拒绝码，不抛成 500", async () => {
  await fixture(async ({ root }) => {
    const inputPath = join(root, "manifest-invalid");
    mkdirSync(inputPath);
    writeFileSync(join(inputPath, "export.xml"), xml(record(a)));
    writeFileSync(join(inputPath, "sync-manifest.json"), JSON.stringify({
      version: 99, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
    }));
    const result = preflightDirectSyncPayload(inputPath);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.rejection.reason : null, "manifest_invalid");
    assert.equal(result.ok === false ? result.rejection.stage : null, "prepare");

    // 非 JSON/结构错误同样必须走稳定拒绝，而不是异常冒泡。
    writeFileSync(join(inputPath, "sync-manifest.json"), "{not json");
    const malformed = preflightDirectSyncPayload(inputPath);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.ok === false ? malformed.rejection.reason : null, "manifest_invalid");
  });
});

test("拒收码词典：缺文件 / 缺 v2 身份 / 删除超界 / 契约代际不符 / 库不存在 / 批次无回执 各自带正确 reason", async () => {
  await fixture(async ({ main, input, root }) => {
    // ① 缺 sync-manifest.json ⇒ missing_required_files（必须文件缺失）。
    const noManifest = await input(record(a));
    rmSync(join(noManifest.inputPath, "sync-manifest.json"));
    const missing = await applyDirectSyncImport(noManifest);
    assert.ok(isDirectSyncRejection(missing) && missing.reason === "missing_required_files",
      `缺 manifest 必须报 missing_required_files，实际：${JSON.stringify(missing)}`);

    // ② manifest 是 **v1**（v2 身份缺失，无法保证"同一实体"）⇒ missing_record_identity。
    //    判据来源 `packages/health-export-parser/src/sync-manifest.ts:21`：
    //    `version === 1` ⇒ `recordIdentity: false`（v2 才由结构推导出身份）。
    const noIdentity = await input(record(a));
    writeFileSync(join(noIdentity.inputPath, "sync-manifest.json"), JSON.stringify({
      version: 1, deletedWorkoutIds: [], deletedRecords: []
    }));
    const identity = await applyDirectSyncImport(noIdentity);
    assert.ok(isDirectSyncRejection(identity) && identity.reason === "missing_record_identity",
      `v1（缺 v2 身份）必须报 missing_record_identity，实际：${JSON.stringify(identity)}`);

    // ③ 删除数超上界（>5000）⇒ deletions_exceed_bounds，且带 actual/bounds。
    const manyDeletions = Array.from({ length: 5001 }, (_, index) => ({
      type: step, uuid: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`
    }));
    const tooMany = await input(record(a), { deletedRecords: manyDeletions });
    const deletions = await applyDirectSyncImport(tooMany);
    assert.ok(isDirectSyncRejection(deletions) && deletions.reason === "deletions_exceed_bounds",
      `删除超界必须报 deletions_exceed_bounds，实际：${JSON.stringify(deletions)}`);
    assert.equal(deletions.actual?.deletions, 5001);
    assert.equal(deletions.bounds?.maxRecords, 5000);

    // ④ **契约/身份代际不符**（库里有身份痕迹但值不符）⇒ `baseline_rebuild_required`。
    //    S3.2 把身份检查拆成三态：只有**四项全缺**才允许就地初始化（见下一条用例），
    //    "有痕迹但不合格"必须显式要求运维重建 —— 客户端不能自动修，也不能被当成"没资格"混过去。
    //    注意本场景的 payload 摘要必须仍能复核通过（它先于身份检查），所以改的是**库**不是载荷。
    const goodPayload = await input(record(b), { job: "delta-identity" });
    const breakIt = new DatabaseSync(main);
    try {
      breakIt.prepare("UPDATE import_manifest SET value='mismatch' WHERE key='parser_contract_version'").run();
    } finally { breakIt.close(); }
    const ineligible = await applyDirectSyncImport(goodPayload);
    assert.ok(isDirectSyncRejection(ineligible) && ineligible.reason === "baseline_rebuild_required",
      `契约不符（有身份痕迹）必须报 baseline_rebuild_required，实际：${JSON.stringify(ineligible)}`);
    assert.equal(ineligible.stage, "identity");
    const restore = new DatabaseSync(main);
    try {
      restore.prepare("UPDATE import_manifest SET value=? WHERE key='parser_contract_version'").run(CONTRACT_VERSION);
    } finally { restore.close(); }

    // ⑤ 主库不存在 ⇒ database_not_found（第一条检查，不碰任何目录）。
    const missingDb = await applyDirectSyncImport({ ...goodPayload, databasePath: join(root, "missing.sqlite") });
    assert.ok(isDirectSyncRejection(missingDb) && missingDb.reason === "database_not_found",
      `库不存在必须报 database_not_found，实际：${JSON.stringify(missingDb)}`);

    // ⑥ 同 id 批次存在但没有完成回执 ⇒ batch_without_receipt（数据面异常，不允许"续写"）。
    const noReceipt = await input(record(a), { job: "delta-no-receipt" });
    const seedBatch = new DatabaseSync(main);
    try {
      seedBatch.prepare(`INSERT INTO import_batches (id,xml_sha256,status,import_mode)
        VALUES ('delta-no-receipt','x','running','incremental')`).run();
    } finally { seedBatch.close(); }
    const receiptLess = await applyDirectSyncImport(noReceipt);
    assert.ok(isDirectSyncRejection(receiptLess) && receiptLess.reason === "batch_without_receipt",
      `同 id 无回执必须报 batch_without_receipt，实际：${JSON.stringify(receiptLess)}`);
    assert.equal(receiptLess.stage, "transaction");
  });
});

test("空库首包（四项身份全缺）+ v2 载荷 ⇒ 就地初始化：四要素齐备、第二包照常（S3.2/D3）", async () => {
  await fixture(async ({ root, input }) => {
    // 一个**全新**的库：迁移到 v36 但不带任何身份键（"从未有完成过的导入"）。
    const fresh = join(root, "fresh.sqlite");
    (await RaiDatabase.open(fresh)).close();
    const first = await input(record(a), { job: "bootstrap-first" });
    const applied = await applyOrFail({ ...first, databasePath: fresh });
    assert.equal(applied.summary.directSync?.ingestStatus, "committed");
    // 四要素在一批之内齐备：`dataset_version` / `import_completed_at` 由接收器写，
    // `parser_contract_version` / `parser_identity_algorithm` 由解析器写。
    const check = new DatabaseSync(fresh, { readOnly: true });
    try {
      const state = new Map(
        (check.prepare("SELECT key, value FROM import_manifest").all() as Array<{ key: string; value: string }>)
          .map((row) => [row.key, row.value])
      );
      for (const key of ["dataset_version", "import_completed_at", "parser_contract_version", "parser_identity_algorithm"]) {
        assert.ok(state.get(key), `${key} 必须在首包之后齐备（bootstrap 就地初始化）`);
      }
      assert.equal(state.get("parser_contract_version"), CONTRACT_VERSION);
      assert.equal(state.get("parser_identity_algorithm"), identityAlgorithmFingerprint());
      assert.notEqual(state.get("dataset_version"), "bootstrap", "版本号必须真的前进，不许停在引导符上");
    } finally { check.close(); }
    // 第二包（普通批次）在同一库上照常走常规增量 —— 就地初始化只发生一次。
    const second = await input(record(b), { job: "bootstrap-second" });
    const followUp = await applyOrFail({ ...second, databasePath: fresh });
    assert.equal(followUp.summary.directSync?.ingestStatus, "committed");
  });
});

test("写守卫：接收事务写派生分析/发布表 ⇒ 立刻被拒；写事实表允许（阳性对照）", async () => {
  await fixture(async ({ main }) => {
    // 先**留下**一行分析数据：BEFORE UPDATE/DELETE 触发器是**逐行**触发的，
    // 空表上 `UPDATE ... WHERE` 一行都不碰，自然也不会响 —— 那样断言就变成了假绿。
    const seed = new DatabaseSync(main);
    seed.exec(`INSERT INTO feature_runs (id, dataset_version, canonical_contract_version,
      feature_schema_version, feature_config_json, feature_config_hash, status, created_at)
      VALUES ('f0','v','c','s','{}','h','succeeded','2026-01-01T00:00:00.000Z')`);
    seed.exec(`INSERT INTO model_runs (id, feature_run_id, dataset_version, model_version,
      model_config_json, model_config_hash, evaluated_at, status, created_at)
      VALUES ('m0','f0','v','mv','{}','mh','2026-01-01T00:00:00.000Z','succeeded','2026-01-01T00:00:00.000Z')`);
    seed.close();

    const store = await RaiDatabase.open(main, { transactionOwner: "caller" });
    try {
      installDirectSyncWriteGuards(store.database);
      store.beginCallerTransaction();
      try {
        // 阳性对照：事实表必须能写 —— 否则"拒绝"可能只是整个连接坏了。
        store.database.prepare(`INSERT INTO import_manifest (key, value) VALUES ('guard_probe','1')`).run();
        for (const sql of [
          `INSERT INTO model_runs (id) VALUES ('m1')`,
          `INSERT INTO feature_runs (id) VALUES ('f1')`,
          `INSERT INTO active_model_run (singleton, model_run_id) VALUES (1, 'm0')`,
          `UPDATE model_runs SET status = 'failed' WHERE id = 'm0'`,
          `DELETE FROM model_runs WHERE id = 'm0'`
        ]) {
          assert.throws(() => store.database.exec(sql), new RegExp(DIRECT_SYNC_WRITE_GUARD),
            `接收事务不得写分析/发布表：${sql}`);
        }
        // ⚠️ 这里**不**断言"空表上的 UPDATE/DELETE 也会抛" —— 触发器是逐行触发的，
        // 空表上一行都不碰，所以那种断言只能靠"提前给表塞一行"来成立，否则是假绿。
        // 上面用已播种的 model_runs 覆盖了 UPDATE 与 DELETE 两条路径。
        // 被拒绝的写入一行都不许生效（ABORT 只回滚该语句，随后我们整体回滚）。
        assert.equal(
          String((store.database.prepare("SELECT status FROM model_runs WHERE id='m0'").get() as { status: string }).status),
          "succeeded");
      } finally {
        store.rollbackCallerTransaction();
      }
    } finally { store.close(); }
  });
});

test("fail-closed：出现未表态的表时，守卫拒绝安装（而不是默认放行）", async () => {
  await fixture(async ({ main }) => {
    const raw = new DatabaseSync(main);
    raw.exec("CREATE TABLE IF NOT EXISTS brand_new_analysis_table (id TEXT PRIMARY KEY)");
    raw.close();
    const store = await RaiDatabase.open(main, { transactionOwner: "caller" });
    try {
      assert.throws(() => installDirectSyncWriteGuards(store.database),
        /brand_new_analysis_table/, "新表必须先在 INGEST_TABLE_DISPOSITIONS 里表态");
    } finally { store.close(); }
  });
  // 声明表本身也要自洽：不能有重复项，也不能漏掉任何生产表。
  const names = INGEST_TABLE_DISPOSITIONS.map((row) => row.table);
  assert.equal(new Set(names).size, names.length, "声明表不得有重复条目");
  assert.deepEqual(unclassifiedIngestTables(["health_records", "workouts"]), []);
  assert.deepEqual(unclassifiedIngestTables(["unknown_table"]), ["unknown_table"]);
});

test("PR4 步骤 4：只重建本批触及的**夜**，窗口外的 canonical 行逐字节不变", async () => {
  await fixture(async ({ main, input }) => {
    // 两个夜：1/1 与 1/10（睡眠段跨夜 ⇒ wake_date 分别是 1/2 与 1/11）。
    const first = await applyOrFail(await input(
      sleepSegment("00000000-0000-0000-0000-0000000000e1", "2026-01-01")
      + sleepSegment("00000000-0000-0000-0000-0000000000e2", "2026-01-10")));
    assert.ok(first, "第一批必须被接收");
    assert.equal(first.summary.canonicalNights?.mode, "window",
      "碰了夜的批次必须按窗口重建（不是整表、也不是什么都不做）");
    const before = nightsByDate(main);
    assert.equal(before.size, 2, `两夜都要有 canonical 行（实际 ${JSON.stringify([...before.keys()])}）`);

    // 🔴 野值金丝雀：把**窗口外**那一夜（1/11）的 canonical 值故意写错 —— 999 分钟在这条夹具里
    // 不可能出现（23:10→06:40 满打满算 450 分钟）。于是下面那句"逐字节不变"才有牙：
    // 任何**真的**重建到 1/11 的路径都会把它算回真值 ⇒ 快照必然不同。
    //
    // 为什么非要有这条（2026-10-13 突变实测）：把"回执照实报窄窗口、实际按 2026 全年重建"这个
    // 突变打进来时，**没有**金丝雀的版本是**绿的** —— 重建一个输入未变的夜是确定性的，
    // 字节碰巧一模一样，"窗口外不变"因此无法区分"没碰"与"碰了但结果相同"。
    const canary = new DatabaseSync(main);
    try {
      canary.prepare("UPDATE canonical_nights SET asleep_union_minutes = 999 WHERE wake_date = '2026-01-11'").run();
    } finally { canary.close(); }
    const canaryBefore = nightsByDate(main);
    assert.equal(JSON.parse(canaryBefore.get("2026-01-11")!).asleep_union_minutes, 999,
      "金丝雀没写进去的话，下面那条断言什么都没证明");

    // 第二批只更正 1/1 那一夜（更早醒 ⇒ 睡了更短）。
    const second = await applyOrFail(await input(
      sleepSegment("00000000-0000-0000-0000-0000000000e1", "2026-01-01", "05:30:00"), { job: "delta-night-2" }));
    assert.ok(second);
    const range = second.summary.canonicalNights!;
    assert.equal(range.mode, "window");
    assert.ok(range.from! <= "2026-01-02" && range.to! >= "2026-01-02",
      `窗口必须覆盖被更正的那一夜（${range.from}..${range.to}）`);
    assert.ok(range.to! < "2026-01-11",
      `窗口必须**有界**：不得把没碰到的 1/10 那一夜卷进来（${range.from}..${range.to}）`);

    const after = nightsByDate(main);
    assert.notEqual(after.get("2026-01-02"), before.get("2026-01-02"),
      "被触及的夜必须真的重建（否则这条用例证明不了任何事）");
    assert.equal(after.get("2026-01-11"), canaryBefore.get("2026-01-11"),
      "🔴 窗口外的 canonical 行必须**逐字节**不变（§14.1 的「不许全表重建」就是这一条）：" +
      "金丝雀值 999 必须原封不动地留在库里");
  });
});

test("历史删除缺旧侧且是唯一睡眠记录：无界窗口覆盖并清除旧 canonical 夜", async () => {
  await fixture(async ({ main, input }) => {
    await applyOrFail(await input(
      sleepSegment("00000000-0000-0000-0000-0000000000e9", "2026-01-01"),
      { job: "legacy-night-first" }
    ));
    assert.ok(nightsByDate(main).has("2026-01-02"));
    const db = new DatabaseSync(main);
    try {
      db.exec("DELETE FROM health_records");
      const period = fullNightRebuildPeriod(db, ["2026-01-01T15:10:00.000Z"]);
      assert.ok(period.from <= "2026-01-02" && period.to >= "2026-01-02",
        `删除后的空 health_records 仍须覆盖旧夜，实际 ${period.from}..${period.to}`);
      canonicalizeNightsForWindow(db, DATABASE_TIMEZONE, period.from, period.to);
    } finally { db.close(); }
    assert.equal(nightsByDate(main).size, 0, "旧夜必须被真正删除，不能留下派生残影");
  });
});

test("O10（WP-31）：一批里两个**不相邻**时期 ⇒ 逐时期重建，中间那段（间隙）逐字节不变", async () => {
  await fixture(async ({ main, input }) => {
    // 三个夜：1/1（wake 1/2）、1/6（wake 1/7，**间隙**）、1/12（wake 1/13）。
    const first = await applyOrFail(await input(
      sleepSegment("00000000-0000-0000-0000-0000000000d1", "2026-01-01")
      + sleepSegment("00000000-0000-0000-0000-0000000000d2", "2026-01-06")
      + sleepSegment("00000000-0000-0000-0000-0000000000d3", "2026-01-12")));
    assert.ok(first, "第一批必须被接收");
    assert.equal(nightsByDate(main).size, 3, "三个夜都要有 canonical 行");

    // 🔴 间隙金丝雀：把**中间那一夜**（1/7）故意写错。1/1 与 1/12 的更正不该碰到它 ——
    // 而"一个全局 min/max 跨度"的实现会把 1/2..1/13 全卷进来，包括 1/7。
    // 没有这条金丝雀，两种实现都会给出同样的最终行（重建一个输入未变的夜是确定性的）。
    const canary = new DatabaseSync(main);
    try {
      canary.prepare("UPDATE canonical_nights SET asleep_union_minutes = 999 WHERE wake_date = '2026-01-07'").run();
    } finally { canary.close(); }
    const canaryBefore = nightsByDate(main);
    assert.equal(JSON.parse(canaryBefore.get("2026-01-07")!).asleep_union_minutes, 999,
      "金丝雀没写进去的话，下面那条断言什么都没证明");

    // 第二批在**同一个载荷**里更正两端：1/1 与 1/12（彼此不相邻）。
    const second = await applyOrFail(await input(
      sleepSegment("00000000-0000-0000-0000-0000000000d1", "2026-01-01", "05:30:00")
      + sleepSegment("00000000-0000-0000-0000-0000000000d3", "2026-01-12", "05:30:00"),
      { job: "delta-night-two-periods" }));
    assert.ok(second);
    const range = second.summary.canonicalNights!;
    assert.equal(range.mode, "window");
    // 回执的 from/to 仍是**单一跨度**（首时期下界..末时期上界）—— 与改动前逐字节相同，
    // 于是"按时期重建"这件事对回执契约是不可见的。
    assert.equal(range.from, "2025-12-31", `回执下界必须仍是首时期的下界（实际 ${range.from}）`);
    // 末时期的上界 = 末次变更的**结束时刻**所在本地日 +1：段是 1/12 23:10 → 1/13 06:40，
    // 所以 max 本地日是 1/13 ⇒ to = 1/14（不是 1/13）。
    assert.equal(range.to, "2026-01-14", `回执上界必须仍是末时期的上界（实际 ${range.to}）`);

    const after = nightsByDate(main);
    assert.notEqual(after.get("2026-01-02"), canaryBefore.get("2026-01-02"),
      "被更正的第一端必须真的重建（否则这条用例证明不了任何事）");
    assert.notEqual(after.get("2026-01-13"), canaryBefore.get("2026-01-13"),
      "被更正的第二端必须真的重建");
    assert.equal(after.get("2026-01-07"), canaryBefore.get("2026-01-07"),
      "🔴 **间隙**里的 canonical 行必须逐字节不变：金丝雀 999 必须原封不动。" +
      "这条正是『逐时期重建』与『一个全局跨度』的唯一可区分之处（O10 步骤 4）");
  });
});

test("R7：同 UUID 睡眠段从 1/1 移到 1/10 ⇒ 旧夜被重建（before 范围进窗口）", async () => {
  await fixture(async ({ main, input }) => {
    // 两夜：1/1 与 1/10（wake_date 1/2 / 1/11）——1/10 那一夜全程不动，作"窗口外"对照。
    const first = await applyOrFail(await input(
      sleepSegment("00000000-0000-0000-0000-0000000000f1", "2026-01-01")
      + sleepSegment("00000000-0000-0000-0000-0000000000f2", "2026-01-10")));
    assert.ok(first, "第一批必须被接收");
    const before = nightsByDate(main);
    assert.equal(before.size, 2, `两夜都要有 canonical 行（实际 ${JSON.stringify([...before.keys()])}）`);

    // 第二批：**同一个 UUID**（f1）改到 1/10——旧的 1/1 范围只剩在账本 previous_* 里。
    const second = await applyOrFail(await input(
      sleepSegment("00000000-0000-0000-0000-0000000000f1", "2026-01-10"), { job: "delta-night-r7" }));
    assert.ok(second, "第二批必须被接收");
    const range = second.summary.canonicalNights!;
    assert.equal(range.mode, "window");
    // 🔴 核心判据（R7）：窗口必须覆盖**旧**夜（1/2）。修复前只读 `effective_at`（新范围），
    // 窗口落 1/11 一带 —— 旧的 1/2 夜永远不重建，旧派生残留。
    assert.ok(range.from! <= "2026-01-02" && range.to! >= "2026-01-02",
      `窗口必须覆盖被移走的那一夜（旧范围进窗口），实际 ${range.from}..${range.to}`);

    const after = nightsByDate(main);
    assert.notEqual(after.get("2026-01-02") ?? "missing", before.get("2026-01-02"),
      "旧夜必须真的被重建（或消失）——否则 R7 的残留没有被清掉");
  });
});

test("PR4 步骤 4：不碰夜的批次连窗口重建都不做（模式 none、两张表逐字节不变）", async () => {
  await fixture(async ({ main, input }) => {
    const first = await applyOrFail(await input(
      sleepSegment("00000000-0000-0000-0000-0000000000e3", "2026-02-01")));
    assert.ok(first);
    const nights = nightsByDate(main);
    const hrv = tableDigest(main, "canonical_hrv_days");

    const workoutBatch = await applyOrFail(await input(workout(), { job: "delta-workout-only" }));
    assert.ok(workoutBatch);
    assert.equal(workoutBatch.summary.canonicalNights?.mode, "none",
      "一批只有 Workout 的载荷不该重建任何夜");
    assert.deepEqual(nightsByDate(main), nights, "canonical_nights 必须逐字节不变");
    assert.equal(tableDigest(main, "canonical_hrv_days"), hrv, "canonical_hrv_days 必须逐字节不变");
  });
});

test("A04 形态：回执写入点故障注入 ⇒ 事实/批次/任务/回执整批回滚", async () => {
  await fixture(async ({ main, input }) => {
    const injected = new DatabaseSync(main);
    // 在**最后一个写入点**上失败：回执写 import_manifest（键 `rai.applied-import.<id>`）时抛错。
    injected.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON import_manifest
      WHEN NEW.key LIKE 'rai.applied-import.%' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`);
    injected.close();
    const batch = await input(record(a) + workout());
    await assert.rejects(applyDirectSyncImport(batch), /injected receipt failure/);

    const db = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM health_records"), 0, "事实必须回滚");
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM workouts"), 0);
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM import_batches"), 0, "批次行必须回滚");
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM recompute_jobs"), 0, "登记的分析任务必须一起回滚");
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM import_entity_changes"), 0, "账目必须回滚");
      assert.equal((db.prepare("SELECT raw_generation AS raw FROM import_generations WHERE singleton=1").get() as { raw: number }).raw, 0,
        "代次计数器不得在回滚后留下痕迹");
      assert.equal(readImportReceipt(main, batch.jobId), null, "不得留下任何回执");
    } finally { db.close(); }
    // 清掉注入，证明失败之后同一个库还能正常接收（回滚干净，不是"库坏了"）。
    const cleanup = new DatabaseSync(main);
    cleanup.exec("DROP TRIGGER fail_receipt");
    cleanup.close();
    const retried = await applyOrFail({ ...batch, jobId: "delta-retry" });
    assert.ok(retried, "移除故障后必须能重新接收同一份载荷");
    assert.equal(retried.summary.directSync?.analysisStatus, "queued");
  });
});

test("§4.3：缺少快通路资格 stamp 的库不得被拒（它不是直接路径的门槛）", async () => {
  await fixture(async ({ main, input }) => {
    const db = new DatabaseSync(main);
    assert.equal(db.prepare("SELECT 1 FROM import_manifest WHERE key='data_only_baseline_contract'").get(), undefined,
      "本用例的前提：库里没有快通路资格 stamp");
    db.close();
    const applied = await applyOrFail(await input(record(a)));
    assert.ok(applied, "没有资格 stamp 也必须能走直连（§4.3 明令它不是门槛）");
  });
});

// ── P1-1：prepare 阶段不再整读 XML ─────────────────────────────────────────────
//
// 这条改动把「XML 读三遍」降到两遍（摘要流读 + 解析器按路径读）。其中一遍是
// `readFileSync` 同步阻塞 worker 线程的 8 MiB 全量读，只为算一个字节数。
//
// 两条判据分工**必须分清**，否则会自我欺骗：
//   1. 行为判据：在**合法 UTF-8** 上与旧口径恰好相等，所以夹具里故意放一个**非法 UTF-8**
//      字节，让旧口径（解码后重编码 = 磁盘 + 2）与新口径（磁盘字节）分开。它钉的是语义来源。
//   2. 源码判据才是回归检测器，且必须用 **AST**：`stripComments` 只跳双引号串，模板字符串/
//      单引号/正则里的 `/*` 会把其后全文截掉，使负断言恒绿（2026-10-17 复核实测）；
//      字符串匹配也抓不住"先赋给局部变量"的别名回退。AST 两者都能覆盖。
//   3. 源码判据的作用域是 `preparePayload` **函数体**：同文件的预检函数合法地读 manifest，
//      按整文件断言会把"读任何东西"都判红。

test("P1-1：source_xml_bytes 报磁盘字节数，不是解码后重编码的长度", async () => {
  await fixture(async ({ main, input }) => {
    // 🔴 非法 UTF-8 放在 XML 注释里（语义上被忽略）：0x80 解码成 U+FFFD（3 字节），
    // 于是旧口径 `Buffer.byteLength(解码文本)` = 磁盘字节 + 2 —— 这条判据才能真的区分新旧实现。
    const invalidUtf8 = Buffer.concat([
      Buffer.from("<HealthData><!--"),
      Buffer.from([0x80]),
      Buffer.from(`-->${record(a)}${record(b, "25")}</HealthData>`)
    ]);
    const batch = await input("", { xmlBytes: invalidUtf8 });
    const diskBytes = statSync(join(batch.inputPath, "export.xml")).size;
    assert.equal(diskBytes, invalidUtf8.length, "夹具写盘字节数不对，判据前提已失效");
    await applyOrFail(batch);
    const db = new DatabaseSync(main, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM import_manifest WHERE key='source_xml_bytes'").get() as
        { value: string } | undefined;
      assert.ok(row, "本批必须写下 source_xml_bytes");
      assert.equal(Number(row.value), diskBytes,
        "source_xml_bytes 必须等于 statSync(export.xml).size；等于 diskBytes + 2 说明又被解码再重编码了");
    } finally { db.close(); }
  });
});

test("P1-1：prepare 阶段不得再整读 XML（AST 级，行为判据看不见这一条）", () => {
  const file = ts.createSourceFile(
    "direct-sync-ingest.ts",
    readFileSync(join(import.meta.dirname, "../src/direct-sync-ingest.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const prepare = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "preparePayload");
  const preparedPayload = file.statements.find((node): node is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(node) && node.name.text === "PreparedPayload");
  assert.ok(prepare, "找不到 preparePayload：判据锚点已失效，需要更新判据");
  assert.ok(preparedPayload, "找不到 PreparedPayload：判据锚点已失效，需要更新判据");

  const fileReads: string[] = [];
  const xmlTextUses: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === "readFileSync") {
      fileReads.push(node.getText(file));
    }
    if (ts.isIdentifier(node) && node.text === "xmlText") xmlTextUses.push(node.getText(file));
    if (ts.isStringLiteralLike(node) && node.text === "xmlText") xmlTextUses.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(prepare);
  assert.deepEqual(fileReads, [],
    "preparePayload 不得再 readFileSync：摘要流读 + 解析器按路径读各一遍就够了");
  assert.deepEqual(xmlTextUses, [],
    "preparePayload 不应再承载 XML 全文：全文没有消费点，只为一个字节数付 8 MiB 阻塞读");

  const members = preparedPayload.members
    .filter((member): member is ts.PropertySignature => ts.isPropertySignature(member))
    .map((member) => member.name.getText(file));
  assert.ok(!members.includes("xmlText"),
    `PreparedPayload 不应再携带 xmlText（成员：${members.join(", ")}）`);
  assert.ok(members.includes("xmlFileBytes"),
    `PreparedPayload 应改携带磁盘字节数 xmlFileBytes（成员：${members.join(", ")}）`);
});
