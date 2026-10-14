// 直连车道的**端到端**验收（PR4 步骤 2e：放开 `deltaMode: "full"`）。
//
// 为什么必须有这个文件：`direct-sync-ingest.test.ts` 直接调用接收器，`direct-sync-plan.test.ts`
// 只判纯函数。两者都不回答"**worker 里**这条车道到底接没接上" —— 而 2e 的整个风险就在这里：
// 判据改成 `"full"` 却没人调用接收器时，标签变宽、行为没变，测试全绿。
//
// 这个文件走真实 worker：真实排队的任务 → 车道判定 → record-only 快通路**拒收** →
// 统一接收器（真实子进程 + 真实事务）→ 终态。断言覆盖四件事：
//   1. 事实真的落库（workout / training_session / 路线版本）；
//   2. 分析任务在**同一个事务**里登记（四个绑定列 + `dirty_json` 的分类理由）；
//   3. 回执与终态摘要一致，且 `analysisStatus` 是 `queued`（不是 `not_required`，更不是 `published`）；
//   4. §14.1 的禁止操作一条都没踩（没有项目备份、没有换库、没有子进程 CLI）。
//
// ⚠️ 本文件**不**覆盖：真机 HealthKit 上传、P01–P06 的性能口径（需要目标云机）。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION, DIRECT_SYNC_ANALYSIS_REQUEST_MODE } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";

import { ImportWorker } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { readImportReceipt } from "../src/import-publication.js";
import { dataOnlyBaselineContract } from "../src/data-only-import.js";
import type { ImportDatabaseTask } from "../src/import-database-tasks.js";

const project = resolve(import.meta.dirname, "../../..");
const workoutUuid = "00000000-0000-0000-0000-00000000000b";

interface Surface extends Record<string, unknown> {
  createCurrentBackup(id: string): Promise<string | null>;
  command(args: string[]): Promise<void>;
  databaseTask<T>(task: ImportDatabaseTask): Promise<T>;
}

/**
 * 含 **Workout** 的增量载荷 —— record-only 车道的入口判据（记录类型白名单）必然拒收它。
 * 于是它只能落到统一接收器：这正是 2e 要证明"接上了"的那条路径。
 */
const workoutXml = (route?: string): string => `<HealthData><Workout
    workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch"
    duration="30" durationUnit="min" startDate="2026-01-02 08:00:00 +0000"
    endDate="2026-01-02 08:30:00 +0000">
    <MetadataEntry key="RAIHealthKitWorkoutUUID" value="${workoutUuid}"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
    ${route === undefined ? "" : `<WorkoutRoute><FileReference path="/${route}"/></WorkoutRoute>`}
  </Workout></HealthData>`;

const gpx = (): string => `<?xml version="1.0"?><gpx><trk><trkseg>
  <trkpt lat="31.10" lon="121.10"><time>2026-01-02T08:00:00.000+08:00</time><ele>5</ele></trkpt>
  <trkpt lat="31.11" lon="121.11"><time>2026-01-02T08:00:05.000+08:00</time><ele>6</ele></trkpt>
</trkseg></trk></gpx>`;

interface FixtureContext {
  root: string;
  main: string;
  input: string;
  make(): ImportWorker;
}

async function fixture(
  payload: { xml: string; gpx?: Record<string, string> },
  run: (ctx: FixtureContext) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-worker-direct-sync-"));
  const main = join(root, "main.sqlite");
  const input = join(root, "input");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), payload.xml);
  // v2 + `sourceScope: "healthkit"`：车道判定的第 5 个条件（`preserveAbsent`）就来自这里。
  writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
    version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
  }));
  for (const [name, content] of Object.entries(payload.gpx ?? {})) {
    mkdirSync(join(input, "workout-routes"), { recursive: true });
    writeFileSync(join(input, "workout-routes", name), content);
  }
  const store = await RaiDatabase.open(main);
  store.setManifest("dataset_version", "baseline");
  store.setManifest("parser_contract_version", CONTRACT_VERSION);
  store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  // 快通路资格 stamp **故意写上**：这样"record-only 拒收"只可能由**载荷形状**造成，
  // 而不是"缺 stamp 导致谁都不合格"。拒收原因越单一，这条用例证明的东西越清楚。
  store.setManifest("data_only_baseline_contract", dataOnlyBaselineContract());
  store.setProfile({ dateOfBirth: "1990-01-01" });
  store.close();
  const make = () => new ImportWorker(main, project, root, () => {
    // 第 4 个参数是"进入替换/发布门"的回调。它一旦被调用，就说明这批走了旧候选链路。
    throw new Error("delta must not enter the replacement gate");
  }, undefined, undefined, {
    scope: "fixture", dataOnlyFastPath: true,
    admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
  });
  try {
    await run({ root, main, input, make });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function wait(worker: ImportWorker): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (worker.hasPending || worker.isRunning) {
    assert.ok(Date.now() < deadline, JSON.stringify(worker.latest()));
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** 备份/换库/子进程 CLI 都不允许出现 —— 这是 §14.1 在**这条**车道上最直接的三条。 */
function forbidBulk(worker: ImportWorker): void {
  const surface = worker as unknown as Surface;
  surface.createCurrentBackup = async () => { throw new Error("delta must not back up the whole database"); };
  surface.command = async () => { throw new Error("delta must not invoke the import/recompute CLI"); };
}

interface JobRow {
  id: string;
  jobType: string;
  status: string;
  request: string;
  rawGeneration: number;
  dependencyGeneration: number;
  dirty: string;
}

function analysisJobs(path: string): JobRow[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare(`SELECT id, job_type AS jobType, status, request_json AS request,
      target_raw_generation AS rawGeneration, target_dependency_generation AS dependencyGeneration,
      dirty_json AS dirty FROM recompute_jobs ORDER BY created_at`).all() as unknown as JobRow[]);
  } finally {
    db.close();
  }
}

function countRows(path: string, sql: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Number((db.prepare(sql).get() as { n: number }).n); }
  finally { db.close(); }
}

test("2e：含 Workout 的增量在 worker 里走统一接收器——登记分析任务、回执 queued、零禁止操作", async () => {
  await fixture({ xml: workoutXml() }, async ({ root, main, input, make }) => {
    const worker = make();
    forbidBulk(worker);
    const inodeBefore = statSync(main).ino;
    try {
      const job = worker.create(input, undefined, "direct-sync-workout");
      await wait(worker);
      const done = worker.get(job.id)!;
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      assert.equal(done.error, null);

      // ① 两条车道的耗时账本都在：record-only **先试并被拒收**（阶段要留痕），
      //    随后统一接收器接手。只看 `directSyncApply` 会分不清"跳过"与"没这条车道"。
      assert.ok((done.performance?.stagesMs.dataOnlyApply ?? 0) > 0,
        "record-only 快通路必须**先被尝试**（它的入口判据更严），阶段账本里要有它的耗时");
      assert.ok((done.performance?.stagesMs.directSyncApply ?? 0) > 0,
        "统一接收器必须真的跑了 —— 只有判据放开、没有调用方时这里恒为 undefined");
      // 观测（阶段 1，S1.3）：直连成功必须如实落 lane 遥测（哪条子车道 + 无否决理由）。
      assert.equal(done.performance?.lane?.outcome, "direct");
      assert.equal(done.performance?.lane?.directSource, "direct-sync",
        "本用例的载荷被 record-only 快通路拒收、由统一接收器接住 —— directSource 必须说清楚");
      assert.deepEqual(done.performance?.lane?.reasons, []);
      assert.deepEqual(
        (done.performance?.lane?.rejections ?? []).map((entry) => `${entry.source}:${entry.reason}`),
        ["data-only:fast_path_rejected"],
        "快通路拒收必须留痕（拒因结构化是观测版的核心承诺）");
      for (const stage of ["backupCapacity", "backupCopy", "backupVerify", "stagingCopy", "parseImport",
        "recompute", "activationAudit", "activationSwap"] as const) {
        assert.equal(done.performance?.stagesMs[stage], undefined, `${stage} 不得运行`);
      }
      assert.equal(done.summary?.backupName, null, "直连车道不产生项目备份");
      assert.deepEqual(
        readdirSync(join(root, "var")).filter((name) => /^(backups|rai\.importing)/.test(name)), [],
        "var/ 里不得出现备份或整库候选");
      assert.equal(statSync(main).ino, inodeBefore, "主库文件身份必须保持不变（不得 rename/install/move）");

      // ② 事实落库：Workout + 它的 canonical session。
      assert.equal(countRows(main, "SELECT COUNT(*) AS n FROM workouts WHERE deleted_at IS NULL"), 1);
      assert.equal(countRows(main, "SELECT COUNT(*) AS n FROM training_sessions"), 1);

      // ③ 分析任务**在同一个事务里**登记，四个绑定列与载荷分类逐项相符。
      const jobs = analysisJobs(main);
      assert.equal(jobs.length, 1, "含 Workout 的批次必须登记恰好一个分析任务");
      const queued = jobs[0]!;
      assert.equal(queued.jobType, "import");
      assert.equal(queued.status, "queued", "登记完只是排队；声称 published 会是假话");
      const request = JSON.parse(queued.request) as { mode?: unknown; importBatchId?: unknown };
      assert.equal(request.mode, DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
        "载荷 mode 必须让消费者认得出这是直连分析（否则会被拒绝执行）");
      assert.equal(request.importBatchId, job.id);
      assert.equal(Number(queued.rawGeneration), 1, "raw 代次：本批在库里递增一次");
      assert.equal(Number(queued.dependencyGeneration), 1, "dependency 代次：与 raw 同批推进");
      const dirty = JSON.parse(queued.dirty) as { reasons?: string[]; from?: string | null };
      assert.ok(dirty.reasons?.includes("workout_present"),
        `分类理由必须落在计划里（实际 ${JSON.stringify(dirty.reasons)}）`);

      // ④ 回执：与终态摘要一致，且**不许**声称分析已完成。
      const receipt = readImportReceipt(main, job.id);
      assert.ok(receipt, "回执必须在同一个事务里落库");
      assert.equal(receipt.directSync?.ingestStatus, "committed");
      assert.equal(receipt.directSync?.analysisStatus, "queued",
        "登记了任务就必须写 queued；写 not_required 就是「旧分析看起来是最新的」");
      assert.equal(receipt.directSync?.publishedReleaseId, null, "原始接收不得声称已发布分析");
      assert.equal(receipt.directSync?.dependencyGeneration, String(queued.dependencyGeneration));
      assert.deepEqual(receipt.directSync, done.summary?.directSync,
        "终态摘要与持久回执必须是同一份结论");
      assert.match(String(done.message), /分析任务已登记/, "用户可见文案必须说清下一步在重算");

      // ⑤ 批次账本：`import_batches` 成功 + 记下本批登记的任务。
      const db = new DatabaseSync(main, { readOnly: true });
      try {
        const batch = db.prepare("SELECT status, summary_json AS summary FROM import_batches WHERE id = ?")
          .get(job.id) as { status: string; summary: string };
        assert.equal(batch.status, "succeeded");
        const summary = JSON.parse(batch.summary) as { analysisJobId?: unknown; publication?: unknown };
        assert.equal(summary.analysisJobId, queued.id, "批次账本必须记下同事务登记的任务");
      } finally { db.close(); }
    } finally { await worker.close(); }
  });
});

test("2e 回归：带 GPX 路由的载荷也能走这条车道（准入摘要与接收复核摘要必须同源）", async () => {
  await fixture({ xml: workoutXml("workout-routes/route-1.gpx"), gpx: { "route-1.gpx": gpx() } },
    async ({ main, input, make }) => {
      const worker = make();
      forbidBulk(worker);
      try {
        const job = worker.create(input, undefined, "direct-sync-route");
        await wait(worker);
        const done = worker.get(job.id)!;
        // 🔴 这一条曾经验证过的是一个**真缺陷**：接收器用 `digestHealthKitRecordSnapshot`
        // （只算 XML+manifest）复核，而 worker 的准入摘要用 `digestHealthKitExportContent`
        // （折进 `workout-routes/**`）。两者不一致 ⇒ 带 GPX 的载荷在这句话上**硬失败**：
        // "Direct sync payload changed after admission" —— 不是回退，是用户可见的失败。
        assert.equal(done.status, "succeeded", JSON.stringify(done));
        assert.ok((done.performance?.stagesMs.directSyncApply ?? 0) > 0);

        assert.equal(countRows(main, "SELECT COUNT(*) AS n FROM route_versions WHERE status = 'complete'"), 1,
          "路线版本必须真的发布");
        assert.equal(countRows(main, "SELECT COUNT(*) AS n FROM route_version_points"), 2,
          "轨迹点必须落在版本表里（不写 route_points 也能被读侧看到）");
        assert.equal(countRows(main, "SELECT COUNT(*) AS n FROM workouts WHERE deleted_at IS NULL"), 1);

        const jobs = analysisJobs(main);
        assert.equal(jobs.length, 1, "路线变更同样要求分析（§9.1：轨迹变了，旧分析不是最新的）");
        assert.equal(jobs[0]!.status, "queued");
        const dirty = JSON.parse(jobs[0]!.dirty) as { reasons?: string[] };
        assert.ok(dirty.reasons?.includes("route_present"),
          `分类理由必须点名路线（实际 ${JSON.stringify(dirty.reasons)}）`);
        assert.equal(readImportReceipt(main, job.id)?.directSync?.analysisStatus, "queued");
      } finally { await worker.close(); }
    });
});

test("回退时 lane 遥测带出两条车道的拒因（观测版 S1.3；候选链路拦在整库备份前）", async () => {
  // 8 MiB 归一化上界（`direct-sync-ingest.ts` 的 `DIRECT_SYNC_MAX_XML_BYTES`，2026-10-14 由 2 MiB 放宽）：
  // 超限会让 record-only 快通路与统一接收器**都**拒收 ⇒ "为什么回退"的一条完整样本。
  const padding = `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="999"
    startDate="2018-01-01 00:00:00 +0000" endDate="2018-01-01 00:01:00 +0000">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="00000000-0000-0000-0000-00000000abcd"/>
  </Record>\n`;
  await fixture({ xml: workoutXml() + padding.repeat(36_000) }, async ({ input, make }) => {
    const worker = make();
    // 候选链路在"创建整库备份"处被拦下：本用例要证明的是**拒因可见**，不是"旧链路能跑完"
    // （后者由 worker.test.ts 的完整候选用例覆盖，那条会真做备份与全库校验）。
    (worker as unknown as Surface).createCurrentBackup = async () => {
      throw new Error("fixture: candidate pipeline stopped before the whole-database backup");
    };
    try {
      const job = worker.create(input, undefined, "lane-fallback");
      await wait(worker);
      const done = worker.get(job.id)!;
      assert.equal(done.status, "failed", JSON.stringify(done));
      const lane = done.performance?.lane;
      assert.ok(lane, "回退必须留下 lane 遥测（观测版 S1.3 的核心承诺）");
      assert.equal(lane.outcome, "fallback");
      assert.deepEqual(lane.reasons, [],
        "车道判定放行了（否决理由为空）—— 这次回退来自两条子车道的拒收");
      assert.deepEqual(
        (lane.rejections ?? []).map((entry) => `${entry.source}:${entry.reason}`),
        ["data-only:fast_path_rejected", "direct-sync:xml_exceeds_bounds"],
        "两条车道各自的拒因必须按尝试顺序留痕");
      const direct = (lane.rejections ?? []).find((entry) => entry.source === "direct-sync");
      assert.equal(direct?.bounds?.maxXmlBytes, 8 * 1024 * 1024, "拒因必须带上界");
      assert.ok((direct?.actual?.xmlBytes ?? 0) > 8 * 1024 * 1024, "拒因必须带实测字节数");
    } finally { await worker.close(); }
  });
});
