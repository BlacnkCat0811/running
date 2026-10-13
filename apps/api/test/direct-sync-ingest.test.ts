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

import { CONTRACT_VERSION, healthTypes, workoutTypes } from "@rai/contracts";
import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";
import { NATIVE_VERSION, identityAlgorithmFingerprint } from "@rai/health-export-parser";

import {
  DIRECT_SYNC_WRITE_GUARD, INGEST_TABLE_DISPOSITIONS, applyDirectSyncImport,
  installDirectSyncWriteGuards, unclassifiedIngestTables, type DirectSyncImportInput
} from "../src/direct-sync-ingest.js";
import { dataOnlyBaselineContract } from "../src/data-only-import.js";
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

interface Fixture {
  root: string;
  main: string;
  /** 造一个输入目录并算出与提交端一致的 payload 摘要（用生产端同一个摘要函数）。 */
  input(rows?: string, options?: {
    deletedRecords?: { type: string; uuid: string }[];
    deletedWorkoutIds?: string[];
    gpx?: Record<string, string>;
    job?: string;
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
  // ⚠️ 刻意**不**写 `data_only_baseline_contract`：本车道不得把它当作资格门槛（§4.3）。
  store.setProfile({ dateOfBirth: "1990-01-01" });
  store.close();
  let ordinal = 0;
  const input: Fixture["input"] = async (rows = "", options = {}) => {
    const inputPath = join(root, `input-${ordinal++}`);
    mkdirSync(inputPath);
    writeFileSync(join(inputPath, "export.xml"), xml(rows));
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

const scalar = (db: DatabaseSync, sql: string, ...params: unknown[]): number =>
  Number((db.prepare(sql).get(...params as never[]) as { n: number }).n);

test("record-only 载荷：事实+账本+回执同事务落库，回执 not_required 且**没有**登记分析任务", async () => {
  await fixture(async ({ main, input }) => {
    const batch = await input(record(a) + record(b, "25"));
    const applied = await applyDirectSyncImport(batch);
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

test("Workout 载荷：同事务登记分析任务，回执 queued，且消费者能把它跑完（闭环）", async () => {
  await fixture(async ({ main, input }) => {
    const batch = await input(workout());
    const applied = await applyDirectSyncImport(batch);
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

test("删除-only 载荷：显式删除先于到达也要求分析，且不误删同来源其它事实", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(workout() + workout("2018-01-03 08:00:00 +0000", "workout-2"));
    const before = new DatabaseSync(main, { readOnly: true });
    const workoutsBefore = scalar(before, "SELECT COUNT(*) AS n FROM workouts");
    before.close();
    assert.equal(workoutsBefore, 2);

    // 删除-only：没有任何 Record/Workout 载荷，只有 manifest 里的显式删除。
    const batch = await input("", { deletedWorkoutIds: ["workout-1"] });
    const applied = await applyDirectSyncImport(batch);
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
    const applied = await applyDirectSyncImport(batch);
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
    } finally { db.close(); }
  });
});

test("超限载荷不合格 ⇒ 返回 null（回退旧链路）且**零写入**", async () => {
  await fixture(async ({ main, input }) => {
    // 超过 2 MiB 归一化原始内容上限（§14.3 P01）。不做"先收一半"。
    const oversized = await input(record(a, "1".repeat(2_200_000)));
    assert.equal(await applyDirectSyncImport(oversized), null);
    // 输入目录里有非 GPX 的杂物也不合格：输入集合必须可枚举。
    const dirty = await input(record(a));
    writeFileSync(join(dirty.inputPath, "notes.txt"), "hello");
    assert.equal(await applyDirectSyncImport(dirty), null);

    const db = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM health_records"), 0);
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM import_batches"), 0);
      assert.equal(scalar(db, "SELECT COUNT(*) AS n FROM recompute_jobs"), 0);
      assert.equal((db.prepare("SELECT raw_generation AS raw FROM import_generations WHERE singleton=1").get() as { raw: number }).raw, 0);
    } finally { db.close(); }
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
    const retried = await applyDirectSyncImport({ ...batch, jobId: "delta-retry" });
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
    const applied = await applyDirectSyncImport(await input(record(a)));
    assert.ok(applied, "没有资格 stamp 也必须能走直连（§4.3 明令它不是门槛）");
  });
});
