// WP-41 / O12 的**复用与隔离**验收（docs/IOS_SYNC_PERFORMANCE_REVIEW.md §O12；
// deliverables/SYNC_OPTIMIZATION_EXECUTION_PLAN_2026-10-16.md 的 `O12（P2·WP-41）`）。
//
// 为什么单开一个文件：既有的三个 suites 各守一段 ——
//   · `direct-sync-prohibited-operations.test.ts` 守 §14.1 禁止操作与**车道尝试序列**；
//   · `import-worker-direct-sync.test.ts` 守统一接收器的端到端结果；
//   · `data-only-import-queue.test.ts` 守记录车道的排队与回执恢复。
// 它们都不回答 WP-41 自己的验收问句：
//   ① 20 个连续小批里，**到底起了几条 ingest 线程**？（老实现每个载荷 1–2 条）
//   ② 线程常驻之后，"上一批的异常"会不会污染下一批？
//   ③ 启动成本到底省在哪一段？——必须**测得出来**（`import_worker_startup`），
//      而不是引用代码注释里的 ~2.5 s。
//
// 🔴 口径纪律（本次改动最容易被吹大的地方）：
//   · 线程启动耗时只报 `ingestWorkerStats().startupMs` / `computeStagesMs.import_worker_startup`
//     的**实测值**；不从注释里的常量推算。
//   · "省下多少次启动"报的是**计数**（`started`）与**每批是否新建线程的观测键是否存在**，
//     不把"每次 2.5 s"当成结果。
//
// 用法：随 `npm test` 运行。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION } from "@rai/contracts";
import type { ImportJobResponse } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";

import { ImportWorker, type ImportQueueOptions } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { readImportReceipt } from "../src/import-publication.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import type { ImportDatabaseTask } from "../src/import-database-tasks.js";
import { assertLanePlan, surveyDatabase, writeNoopReceiptTask } from "../src/import-database-thread.js";

const project = resolve(import.meta.dirname, "../../..");

interface Surface extends Record<string, unknown> {
  databaseTask<T>(task: ImportDatabaseTask): Promise<T>;
}

/** record-only 白名单记录 + 唯一 UUID ⇒ 每批都是**不同的**载荷（不会被 no-op 早退短路）。 */
const recordOnlyXml = (index: number): string => `<HealthData><Record
    type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="10"
    startDate="2026-01-01 00:00:00 +0000" endDate="2026-01-01 00:0${index % 10}:00 +0000">
    <MetadataEntry key="RAIHealthKitSampleUUID"
      value="00000000-0000-0000-0000-0000000000${String(index).padStart(2, "0")}"/>
  </Record></HealthData>`;

const WORKOUT_XML = `<HealthData><Workout workoutActivityType="HKWorkoutActivityTypeRunning"
    sourceName="Watch" duration="30" durationUnit="min"
    startDate="2026-01-02 08:00:00 +0000" endDate="2026-01-02 08:30:00 +0000">
    <MetadataEntry key="RAIHealthKitWorkoutUUID" value="00000000-0000-0000-0000-0000000000ff"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
  </Workout></HealthData>`;

type FixtureOptions = Partial<Pick<ImportQueueOptions, "admission" | "onRecoveryRequired" | "onTerminal">>;

async function fixture(
  run: (ctx: {
    root: string; main: string;
    make(options?: FixtureOptions): ImportWorker;
    writeInput(index: number, xml?: string): string;
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-worker-reuse-"));
  const main = join(root, "main.sqlite");
  const store = await RaiDatabase.open(main);
  store.setManifest("dataset_version", "baseline");
  store.setManifest("parser_contract_version", CONTRACT_VERSION);
  store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  store.close();
  const writeInput = (index: number, xml = recordOnlyXml(index)): string => {
    const input = join(root, `input-${index}`);
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "export.xml"), xml);
    writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
      version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
    }));
    return input;
  };
  const make = (options: FixtureOptions = {}) => new ImportWorker(main, project, root, () => {
    throw new Error("delta must not enter the replacement gate");
  }, undefined, undefined, {
    scope: "reuse-fixture", dataOnlyFastPath: true,
    admission: options.admission ?? new TaskAdmissionScheduler(new MutationCoordinator()).owner("import"),
    ...(options.onRecoveryRequired === undefined ? {} : { onRecoveryRequired: options.onRecoveryRequired }),
    ...(options.onTerminal === undefined ? {} : { onTerminal: options.onTerminal })
  });
  try { await run({ root, main, make, writeInput }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

async function runBatch(worker: ImportWorker, input: string, sourceId: string) {
  const job = worker.create(input, undefined, sourceId);
  const deadline = Date.now() + 60_000;
  while (worker.hasPending || worker.isRunning) {
    assert.ok(Date.now() < deadline, JSON.stringify(worker.latest()));
    await new Promise((done) => setTimeout(done, 10));
  }
  return worker.get(job.id)!;
}

interface ThreadSurface {
  terminate(): Promise<number>;
  postMessage(message: unknown): void;
  emit(event: string, ...args: unknown[]): boolean;
}

interface ResidentSurface {
  thread: ThreadSurface;
  startup: { settled: boolean };
  retired: boolean;
}

interface LifecycleSurface extends Surface {
  ensureIngestWorker(): ResidentSurface;
  settleIngestReply(resident: ResidentSurface, message: {
    kind: "result"; taskId: number; ok: boolean; value?: unknown; error?: string;
  }): void;
  ingest: ResidentSurface | null;
}

/** 外层截止时间：超时是测试失败，不是“产品关闭成功”。 */
function withDeadline<T>(label: string, promise: Promise<T>, timeoutMs = 8_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${label} timed out after ${timeoutMs} ms`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** 测试失败也先把真实线程收掉，避免一个失败的断言把测试进程钉住。 */
async function closeWithDeadline(worker: ImportWorker, label: string, timeoutMs = 8_000): Promise<void> {
  try {
    await withDeadline(label, worker.close(), timeoutMs);
  } catch (error) {
    const resident = (worker as unknown as LifecycleSurface).ingest;
    if (resident) await resident.thread.terminate().catch(() => {});
    throw error;
  }
}

/**
 * 把 `databaseTask` 包一层观测：记下**投递了几次**与每次回报的**车道尝试序列**。
 *
 * 🔴 为什么这两个数必须分开看：`databaseTask` 次数是"起了几次任务"（WP-41 之前
 * record-only 载荷 1 次、full 载荷 2 次 —— 后者就是两次 `new Worker`），
 * `laneAttempts` 是线程内**真的执行过**的车道序列。合并之后"投递次数"不再能表达顺序，
 * 所以顺序判据迁移到 `laneAttempts`（见 `direct-sync-prohibited-operations.test.ts`）。
 */
function observeLanes(worker: ImportWorker): { dispatches: string[]; laneAttempts: string[][] } {
  const surface = worker as unknown as Surface;
  const dispatches: string[] = [];
  const laneAttempts: string[][] = [];
  const original = surface.databaseTask.bind(worker);
  surface.databaseTask = async <T>(task: ImportDatabaseTask): Promise<T> => {
    dispatches.push(task.operation);
    const result = await original<T>(task);
    const reported = (result as unknown as { laneAttempts?: unknown } | null)?.laneAttempts;
    if (Array.isArray(reported)) laneAttempts.push(reported.map(String));
    return result;
  };
  return { dispatches, laneAttempts };
}

test("20 个连续小批：ingest 线程只起 1 条，且启动成本只付一次（实测计数与毫秒）", async () => {
  await fixture(async ({ root, make, writeInput }) => {
    const worker = make();
    const observed = observeLanes(worker);
    try {
      const batches: ReturnType<ImportWorker["get"]>[] = [];
      let rssAfterFirstBatch = 0;
      for (let index = 0; index < 20; index += 1) {
        batches.push(await runBatch(worker, writeInput(index), `reuse-source-${index}`));
        if (index === 0) rssAfterFirstBatch = worker.ingestWorkerStats().lastRssKiB;
      }
      const stats = worker.ingestWorkerStats();

      // ① 每一批都真的成功入库（不是"没报错"）。
      for (const [index, done] of batches.entries()) {
        assert.equal(done?.status, "succeeded", `第 ${index + 1} 批必须成功：${JSON.stringify(done)}`);
      }
      // ② 线程计数：老实现每个载荷 1–2 条线程（full 载荷 2 条）⇒ 20 批是 20–40 条。
      assert.equal(stats.started, 1,
        `20 个连续小批只允许起 1 条 ingest 线程（实测 started=${stats.started}，retired=${stats.retired}）`);
      assert.equal(stats.tasks, 20, "20 批必须各投递一次任务");
      assert.equal(observed.dispatches.filter((operation) => operation === "import-lanes").length, 20,
        "record-only 载荷每批恰好一次任务投递（老实现也是 1 次；full 载荷才是 2 次）");
      assert.deepEqual(observed.laneAttempts, Array.from({ length: 20 }, () => ["data-only"]),
        "record-only 载荷每批的尝试序列都必须是 [data-only]：统一接收器不该被启动");

      // ③ 启动成本**只付一次**且测得出来：第 1 批的 `import_worker_startup` 有值，
      //    第 2 批起这个键必须**不存在** —— 它不存在正是"没有新建线程"的独立证据
      //    （如果实现退化成每批新建，这个键会在每一批里重新出现）。
      const firstStartup = batches[0]?.performance?.computeStagesMs?.import_worker_startup ?? 0;
      assert.ok(firstStartup > 0, "第 1 批必须留下线程启动耗时（spawn + tsx 注册 + 模块加载）");
      for (let index = 1; index < batches.length; index += 1) {
        assert.equal(batches[index]?.performance?.computeStagesMs?.import_worker_startup, undefined,
          `第 ${index + 1} 批不得再起线程（出现启动耗时就说明线程没被复用）`);
      }
      assert.ok(Math.abs(stats.startupMs - firstStartup) < 0.001,
        "统计里的启动耗时必须等于那一次实测值（不做任何外推）");

      // ④ 分开计时确实分开了：每批的**任务**耗时（import_lanes_transaction）与
      //    **车道**耗时（dataOnlyApply）都在，且第 1 批的总时长 ≥ 启动耗时 + 车道耗时。
      for (const [index, done] of batches.entries()) {
        assert.ok((done?.performance?.computeStagesMs?.import_lanes_transaction ?? 0) > 0,
          `第 ${index + 1} 批必须留下任务耗时`);
        assert.ok((done?.performance?.stagesMs?.dataOnlyApply ?? 0) > 0,
          `第 ${index + 1} 批必须留下 record-only 车道的净耗时`);
        assert.equal(done?.performance?.stagesMs?.directSyncApply, undefined,
          "record-only 载荷不得出现统一接收器的耗时（「跳过」与「跑了 0 ms」必须可分辨）");
      }
      const total = batches[0]?.performance?.totalMs ?? 0;
      assert.ok(total >= firstStartup + (batches[0]?.performance?.stagesMs?.dataOnlyApply ?? 0),
        "阶段账本不得重叠：启动 + 车道 ≤ 总时长");

      // ⑤ RSS 监测：常驻线程跨 20 批不得持续增长（阈值放宽，数字照样报出来 ——
      //    这条断言的价值在于"每批都采到了数"，不在于把噪声当结论）。
      assert.ok(rssAfterFirstBatch > 0 && stats.maxRssKiB >= stats.lastRssKiB);
      assert.ok(stats.lastRssKiB - rssAfterFirstBatch < 256 * 1024,
        `常驻线程跨 20 批 RSS 增长过大：首批 ${rssAfterFirstBatch} KiB → 末批 ${stats.lastRssKiB} KiB`);
      assert.ok(stats.maxRssKiB < 2 * 1024 * 1024, `常驻线程 RSS 异常：${stats.maxRssKiB} KiB`);
      process.stderr.write(
        `[WP-41 实测] 20 小批：ingest 线程 started=${stats.started} retired=${stats.retired} `
        + `tasks=${stats.tasks}；一次启动 startupMs=${stats.startupMs.toFixed(1)} ms；`
        + `RSS 首批=${rssAfterFirstBatch} KiB 末批=${stats.lastRssKiB} KiB max=${stats.maxRssKiB} KiB；`
        + `import_lanes_transaction 首批=${(batches[0]?.performance?.computeStagesMs?.import_lanes_transaction ?? 0).toFixed(1)} ms `
        + `末批=${(batches[19]?.performance?.computeStagesMs?.import_lanes_transaction ?? 0).toFixed(1)} ms；`
        + `dataOnlyApply 首批=${(batches[0]?.performance?.stagesMs?.dataOnlyApply ?? 0).toFixed(1)} ms `
        + `末批=${(batches[19]?.performance?.stagesMs?.dataOnlyApply ?? 0).toFixed(1)} ms\n`
      );

      // ⑥ 回执隔离：每一批的回执只属于它自己（receiptId 就是本批 job id）。
      for (const done of batches) {
        const receipt = readImportReceipt(join(root, "main.sqlite"), done!.id);
        assert.equal(receipt?.directSync?.receiptId, done!.id, "回执必须按 job id 隔离");
      }
      assert.deepEqual(
        readdirSync(join(root, "var")).filter((name) => /^(backups|rai\.importing)/.test(name)), [],
        "复用线程不得让任何一批退化成整库备份/候选链路"
      );
    } finally { await worker.close(); }
  });
});

test("no-op 回执在常驻线程执行：连续 10 批复用一条线程，不落回主线程事务", async () => {
  await fixture(async ({ root, make, writeInput }) => {
    const worker = make();
    const observed = observeLanes(worker);
    try {
      const input = writeInput(0);
      const first = await runBatch(worker, input, "noop-first");
      assert.equal(first.status, "succeeded", JSON.stringify(first));

      const noops = [];
      for (let index = 0; index < 10; index += 1) {
        noops.push(await runBatch(worker, input, `noop-source-${index}`));
      }

      const stats = worker.ingestWorkerStats();
      assert.equal(stats.started, 1, "首次导入和 10 个 no-op 必须复用同一条 ingest 线程");
      assert.equal(stats.tasks, 11, "首次导入 + 10 个 no-op 各投递一次任务");
      assert.deepEqual(observed.dispatches, [
        "import-lanes",
        ...Array.from({ length: 10 }, () => "noop-receipt")
      ], "no-op 必须走独立的 noop-receipt 任务，不能在主线程同步写回执");

      for (const [index, done] of noops.entries()) {
        assert.equal(done?.status, "succeeded", `第 ${index + 1} 个 no-op 必须成功`);
        assert.equal(done?.summary?.importMode, "unchanged");
        assert.equal(done?.summary?.directSync?.analysisStatus, "not_required");
        assert.equal(done?.summary?.directSync?.receiptId, done?.id);
        assert.ok((done?.performance?.computeStagesMs?.noop_receipt_transaction ?? 0) > 0,
          `第 ${index + 1} 个 no-op 必须留下 worker 事务耗时`);
        assert.equal(done?.performance?.stagesMs?.directSyncApply, undefined,
          "no-op 不得启动正式车道");
        const receipt = readImportReceipt(join(root, "main.sqlite"), done!.id);
        assert.equal(receipt?.directSync?.receiptId, done!.id, "每个 no-op 回执按 job id 隔离");
      }
    } finally { await worker.close(); }
  });
});

test("提交后回复丢失：从持久回执恢复同一个 no-op 成功结果", async () => {
  await fixture(async ({ root, make, writeInput }) => {
    const worker = make();
    const surface = worker as unknown as Surface;
    try {
      const input = writeInput(0);
      const first = await runBatch(worker, input, "noop-lost-first");
      assert.equal(first.status, "succeeded", JSON.stringify(first));

      const original = surface.databaseTask.bind(worker);
      surface.databaseTask = async <T>(task: ImportDatabaseTask): Promise<T> => {
        if (task.operation === "noop-receipt") {
          // 真正提交，然后丢掉回复。主线程只能从持久回执裁决结果。
          const outcome = writeNoopReceiptTask(task.input);
          assert.equal(outcome.kind, "committed");
          throw new Error("simulated lost worker reply after commit");
        }
        return original<T>(task);
      };

      const recovered = await runBatch(worker, input, "noop-lost-reply");
      assert.equal(recovered.status, "succeeded", JSON.stringify(recovered));
      assert.equal(recovered.summary?.importMode, "unchanged");
      assert.match(recovered.message ?? "", /持久回执/);
      const receipt = readImportReceipt(join(root, "main.sqlite"), recovered.id);
      assert.deepEqual(receipt, recovered.summary, "恢复结果必须与持久回执同源");
    } finally { await worker.close(); }
  });
});

test("no-op 提交等待期间取消返回 publishing，不终止线程，提交后仍成功", async () => {
  await fixture(async ({ make, writeInput }) => {
    const worker = make();
    const surface = worker as unknown as Surface;
    try {
      const input = writeInput(0);
      const first = await runBatch(worker, input, "noop-cancel-first");
      assert.equal(first.status, "succeeded", JSON.stringify(first));

      const original = surface.databaseTask.bind(worker);
      let releaseGate!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
      surface.databaseTask = async <T>(task: ImportDatabaseTask): Promise<T> => {
        if (task.operation === "noop-receipt") {
          entered();
          await gate;
        }
        return original<T>(task);
      };

      // 常驻 worker 的调度 timer 是 unref 的；等待测试 gate 时必须自己保活事件循环。
      const keepAlive = setInterval(() => {}, 50);
      try {
        const job = worker.create(input, undefined, "noop-cancel-target");
        await enteredGate;
        assert.equal(worker.get(job.id)?.phase, "activate",
          "回执事务派发前必须进入不可取消的提交区");
        assert.equal(await worker.cancel(job.id), "publishing",
          "提交区的取消必须返回 publishing，而不是终止线程");

        releaseGate();
        const deadline = Date.now() + 60_000;
        while (worker.hasPending || worker.isRunning) {
          assert.ok(Date.now() < deadline, JSON.stringify(worker.latest()));
          await new Promise((done) => setTimeout(done, 10));
        }
        const done = worker.get(job.id);
        assert.equal(done?.status, "succeeded", JSON.stringify(done));
        assert.equal(worker.ingestWorkerStats().retired, 0,
          "publishing 语义下不得因取消而退休 ingest 线程");
      } finally {
        clearInterval(keepAlive);
      }
    } finally { await worker.close(); }
  });
});

test("worker 冷启动期间 close：ready 与任务结算，关闭完成且不重建线程", { timeout: 25_000 }, async () => {
  await fixture(async ({ make, writeInput }) => {
    const input = writeInput(0);
    const seed = make();
    try { assert.equal((await runBatch(seed, input, "cold-close-seed")).status, "succeeded"); }
    finally { await closeWithDeadline(seed, "seed close"); }

    const worker = make();
    const surface = worker as unknown as LifecycleSurface;
    const originalEnsure = surface.ensureIngestWorker.bind(worker);
    let created: ResidentSurface | null = null;
    let wasStarting = false;
    let closeStarted: Promise<void> | null = null;
    surface.ensureIngestWorker = () => {
      const resident = originalEnsure();
      created = resident;
      // 必须在调用 close() 之前读：close() 会同步退休线程并结算 ready。
      wasStarting = !resident.startup.settled;
      closeStarted = worker.close();
      return resident;
    };
    try {
      const job = worker.create(input, undefined, "cold-close");
      await waitFor("close initiated during cold start", () => closeStarted !== null, 5_000);
      assert.ok(closeStarted, "close() 必须在 ensureIngestWorker() 返回前启动");
      await withDeadline("close during cold start", closeStarted!, 10_000);

      assert.equal(wasStarting, true, "close() 必须发生在 ready 结算之前");
      assert.equal(created!.retired, true);
      assert.equal(created!.startup.settled, true, "ready 等待必须有终局，不能悬挂");
      assert.equal(worker.ingestWorkerStats().started, 1,
        "关闭期间不得为了重试再创建第二条线程");
      assert.equal(worker.ingestWorkerStats().retired, 1, "只允许退休一次");
      assert.equal(worker.get(job.id)?.status, "queued",
        "关闭中的未提交批次按既有 resume 语义回到 queued，而不是伪失败或悬挂");

      await withDeadline("second close", worker.close(), 5_000);
      assert.equal(worker.ingestWorkerStats().retired, 1, "重复 close() 不得重复退休/释放");
    } finally {
      await closeWithDeadline(worker, "cold close cleanup");
    }
  });
});

test("ready 前真实退出：启动等待被结算，任务不悬挂", { timeout: 25_000 }, async () => {
  await fixture(async ({ make, writeInput }) => {
    const input = writeInput(0);
    const seed = make();
    try { assert.equal((await runBatch(seed, input, "exit-before-ready-seed")).status, "succeeded"); }
    finally { await closeWithDeadline(seed, "seed close"); }

    const worker = make();
    const surface = worker as unknown as LifecycleSurface;
    const originalEnsure = surface.ensureIngestWorker.bind(worker);
    let resident: ResidentSurface | null = null;
    surface.ensureIngestWorker = () => {
      const created = originalEnsure();
      resident = created;
      // 真实线程终止（exit 事件代码由线程运行时给出），但发生在 ready 之前。
      void created.thread.terminate().catch(() => {});
      return created;
    };
    try {
      const done = await withDeadline("task after pre-ready exit",
        runBatch(worker, input, "exit-before-ready"), 10_000);
      assert.equal(done.status, "failed", JSON.stringify(done));
      assert.equal(resident!.startup.settled, true, "exit 必须结算 ready（不能只处理 error）");
      assert.equal(resident!.retired, true);
      assert.equal(worker.ingestWorkerStats().started, 1);
    } finally {
      await closeWithDeadline(worker, "exit-before-ready cleanup");
    }
  });
});

test("ready 前 error 事件：启动等待同样被拒绝，close 不悬挂", { timeout: 25_000 }, async () => {
  await fixture(async ({ make, writeInput }) => {
    const input = writeInput(0);
    const seed = make();
    try { assert.equal((await runBatch(seed, input, "error-before-ready-seed")).status, "succeeded"); }
    finally { await closeWithDeadline(seed, "seed close"); }

    const worker = make();
    const surface = worker as unknown as LifecycleSurface;
    const originalEnsure = surface.ensureIngestWorker.bind(worker);
    let resident: ResidentSurface | null = null;
    let closeStarted: Promise<void> | null = null;
    surface.ensureIngestWorker = () => {
      const created = originalEnsure();
      resident = created;
      // 在 ready 之前注入启动错误；retire 会真实 terminate 线程。
      created.thread.emit("error", new Error("fixture pre-ready startup failure"));
      closeStarted = worker.close();
      return created;
    };
    try {
      const job = worker.create(input, undefined, "error-before-ready");
      await waitFor("pre-ready error initiation", () => closeStarted !== null, 5_000);
      await withDeadline("close after pre-ready error", closeStarted!, 10_000);
      assert.equal(resident!.startup.settled, true);
      assert.equal(resident!.retired, true);
      assert.equal(worker.get(job.id)?.status, "queued", JSON.stringify(worker.get(job.id)));
    } finally {
      await closeWithDeadline(worker, "error-before-ready cleanup");
    }
  });
});

test("真实 worker 提交后回复丢失：线程终止后从持久回执恢复同一成功结果", { timeout: 30_000 }, async () => {
  await fixture(async ({ main, make, writeInput }) => {
    const input = writeInput(0);
    const seed = make();
    try { assert.equal((await runBatch(seed, input, "lost-reply-seed")).status, "succeeded"); }
    finally { await closeWithDeadline(seed, "seed close"); }

    const worker = make();
    const surface = worker as unknown as LifecycleSurface;
    const originalSettle = surface.settleIngestReply.bind(worker);
    let targetId: string | null = null;
    let receiptAtInterception: ImportJobResponse["summary"] | null = null;
    let termination: Promise<number> | null = null;
    surface.settleIngestReply = (resident, message) => {
      if (targetId && message.kind === "result" && message.ok && !receiptAtInterception) {
        const receipt = readImportReceipt(main, targetId);
        if (receipt) {
          // 回执已同一事务提交；拒绝结算这条回复并真实终止线程。
          receiptAtInterception = receipt;
          termination = resident.thread.terminate();
          return;
        }
      }
      originalSettle(resident, message as never);
    };
    try {
      const created = worker.create(input, undefined, "lost-reply-real-worker");
      targetId = created.id;
      const done = await withDeadline("recover lost real worker reply", (async () => {
        while (worker.hasPending || worker.isRunning) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        return worker.get(created.id);
      })(), 15_000);
      await termination;

      assert.ok(receiptAtInterception, "拦截回复时必须已经有持久回执（真实提交完成）");
      assert.equal(done?.status, "succeeded", JSON.stringify(done));
      assert.deepEqual(done?.summary, receiptAtInterception,
        "恢复结果必须来自持久回执，不能来自被丢弃的内存回复");
      assert.match(done?.message ?? "", /持久回执/);
      assert.equal(worker.ingestWorkerStats().retired, 1,
        "回复丢失的线程必须被真实退休，不能继续复用");
    } finally {
      await closeWithDeadline(worker, "lost reply cleanup");
    }
  });
});

test("真实 worker 提交前失败：线程终止、无回执、无半提交", { timeout: 30_000 }, async () => {
  await fixture(async ({ main, make, writeInput }) => {
    const input = writeInput(0);
    const seed = make();
    try { assert.equal((await runBatch(seed, input, "precommit-seed")).status, "succeeded"); }
    finally { await closeWithDeadline(seed, "seed close"); }

    const lock = new DatabaseSync(main);
    lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    let rolledBack = false;
    const releaseLock = () => {
      if (rolledBack) return;
      rolledBack = true;
      try { lock.exec("ROLLBACK"); } catch { /* fixture may already have released */ }
      try { lock.close(); } catch { /* fixture may already have closed */ }
    };
    const worker = make();
    const surface = worker as unknown as LifecycleSurface;
    const originalEnsure = surface.ensureIngestWorker.bind(worker);
    let resident: ResidentSurface | null = null;
    surface.ensureIngestWorker = () => {
      const created = originalEnsure();
      if (!resident) {
        resident = created;
        const post = created.thread.postMessage.bind(created.thread);
        created.thread.postMessage = (message: unknown) => {
          post(message);
          // 写锁由夹具持有 ⇒ 任务无法 COMMIT；投递后立即终止真实线程。
          const termination = created.thread.terminate();
          void termination.finally(releaseLock);
        };
      }
      return created;
    };
    try {
      const done = await withDeadline("pre-commit failure", runBatch(worker, input, "precommit-fail"), 15_000);
      releaseLock();
      assert.equal(done.status, "failed", JSON.stringify(done));
      assert.equal(readImportReceipt(main, done.id), null, "提交前失败不得留下成功回执");
      assert.equal(worker.ingestWorkerStats().retired, 1);
      const probe = new DatabaseSync(main, { readOnly: true });
      try {
        assert.equal(Number(probe.prepare("SELECT COUNT(*) AS n FROM import_manifest WHERE key = ?")
          .get(`rai.applied-import.${done.id}`)!.n), 0, "回执行必须完全不存在");
      } finally { probe.close(); }
    } finally {
      releaseLock();
      await closeWithDeadline(worker, "precommit cleanup");
    }
  });
});

test("提交结果不确定且数据库不可访问：进入恢复阻断，不发布终态也不清理来源", { timeout: 30_000 }, async () => {
  await fixture(async ({ main, make, writeInput }) => {
    const input = writeInput(0);
    const seed = make();
    try { assert.equal((await runBatch(seed, input, "recovery-block-seed")).status, "succeeded"); }
    finally { await closeWithDeadline(seed, "seed close"); }

    const scheduler = new TaskAdmissionScheduler(new MutationCoordinator());
    const admission = scheduler.owner("import");
    let recoveryRequired = 0;
    let terminalCalls = 0;
    const worker = make({
      admission,
      onRecoveryRequired: () => {
        recoveryRequired += 1;
        scheduler.blockUntilRestart("import_publication_recovery_required");
      },
      onTerminal: () => { terminalCalls += 1; }
    });
    const surface = worker as unknown as LifecycleSurface;
    const originalSettle = surface.settleIngestReply.bind(worker);
    let targetId: string | null = null;
    let hiddenDatabase: string | null = null;
    let termination: Promise<number> | null = null;
    surface.settleIngestReply = (resident, message) => {
      if (targetId && message.kind === "result" && message.ok && hiddenDatabase === null) {
        const receipt = readImportReceipt(main, targetId);
        if (receipt) {
          // 真实提交已发生；把原数据库从路径上移走，严格读取只能“无法核实”。
          hiddenDatabase = `${main}.unavailable-${Date.now()}`;
          renameSync(main, hiddenDatabase);
          termination = resident.thread.terminate();
          return;
        }
      }
      originalSettle(resident, message as never);
    };
    try {
      const created = worker.create(input, undefined, "recovery-blocked");
      targetId = created.id;
      await waitFor("recovery block", () => worker.get(created.id)?.phase === "recovery_required", 15_000);
      await termination;

      const blocked = worker.get(created.id);
      assert.equal(blocked?.status, "running", JSON.stringify(blocked));
      assert.equal(blocked?.phase, "recovery_required");
      assert.equal(worker.hasPending, true, "恢复阻断必须保留未结束的作业");
      assert.equal(recoveryRequired, 1, "必须通知全局恢复阻断一次");
      assert.equal(terminalCalls, 0, "无法核实结果时不得调用终态来源清理");
      assert.equal(scheduler.isBlocked, true, "全局 TaskAdmissionScheduler 必须被阻断");
      assert.equal(admission.acquire(), null, "阻断后任何新的全局写者都不得取得许可");

      await closeWithDeadline(worker, "recovery block cleanup");
      assert.equal(worker.get(created.id)?.status, "running", "关闭不是终态裁决");
      assert.equal(recoveryRequired, 1);
    } finally {
      await closeWithDeadline(worker, "recovery block finally");
    }
  });
});

test("full 载荷：两条车道在**同一个**任务里跑完（一次投递，序列仍是 data-only → direct-sync）", async () => {
  await fixture(async ({ make, writeInput }) => {
    const worker = make();
    const observed = observeLanes(worker);
    try {
      const done = await runBatch(worker, writeInput(0, WORKOUT_XML), "reuse-full");
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      // 老实现这里是两次 `databaseTask`（= 一个载荷两次 `new Worker`）。WP-41 之后是一次。
      assert.deepEqual(observed.dispatches, ["import-lanes"],
        "full 载荷也只允许一次任务投递：两次尝试必须在同一条线程里完成");
      assert.deepEqual(observed.laneAttempts, [["data-only", "direct-sync"]],
        "尝试顺序不得变化：record-only 先试并被拒收，统一接收器随后接住");
      assert.equal(worker.ingestWorkerStats().started, 1, "一个载荷只起一条线程");
      assert.ok((done.performance?.stagesMs?.dataOnlyApply ?? 0) > 0);
      assert.ok((done.performance?.stagesMs?.directSyncApply ?? 0) > 0);
    } finally { await worker.close(); }
  });
});

test("任务异常只污染那一批：线程被替换，下一批拿到新线程且回执互不串", async () => {
  await fixture(async ({ root, main, make, writeInput }) => {
    const worker = make();
    const surface = worker as unknown as Surface;
    const original = surface.databaseTask.bind(worker);
    const failing = writeInput(0);
    let sabotage = true;
    surface.databaseTask = async <T>(task: ImportDatabaseTask): Promise<T> => {
      if (sabotage && task.operation === "import-lanes") {
        sabotage = false;
        // 准入之后、车道执行之前改载荷 ⇒ 车道的**内容摘要复核**必须抛错。
        // ⛔ 这里正是"不能拿 mtime/大小代替内容摘要"的那条判据：同一路径、同一大小、
        //    只有内容变了，复核照样红。
        writeFileSync(join(failing, "export.xml"), recordOnlyXml(7));
      }
      return original<T>(task);
    };
    try {
      const failed = await runBatch(worker, failing, "reuse-poisoned");
      assert.equal(failed.status, "failed", JSON.stringify(failed));
      assert.equal(readImportReceipt(main, failed.id), null, "失败的这一批不得留下回执");
      const afterFailure = worker.ingestWorkerStats();
      assert.equal(afterFailure.retired, 1, "任务抛错之后线程必须被替换（不复用可能带病的线程）");

      // 下一批：新线程、必须成功、回执只属于它自己。
      const good = await runBatch(worker, writeInput(20), "reuse-after-failure");
      assert.equal(good.status, "succeeded", JSON.stringify(good));
      const afterRecovery = worker.ingestWorkerStats();
      assert.equal(afterRecovery.started, 2, "替换后的线程应当被**复用**（不是每批都新建）");
      assert.equal(afterRecovery.tasks, 2);
      assert.equal(readImportReceipt(main, good.id)?.directSync?.receiptId, good.id);
      assert.equal(readImportReceipt(main, failed.id), null,
        "上一批的异常不得让下一批的回执落到上一批的 job id 上");

      const probe = new DatabaseSync(main, { readOnly: true });
      try {
        assert.equal(Number(probe.prepare("SELECT COUNT(*) AS n FROM health_records").get()!.n), 1,
          "只有成功的那一批落了记录");
      } finally { probe.close(); }
      assert.ok(readdirSync(join(root, "var")).length > 0);
    } finally { await worker.close(); }
  });
});

/*
 * WP-41 / O12 步骤 2：**折叠重复的载荷摘要计算**（用计数证明，而不是用"读代码相信"）。
 *
 * `computeImportPayloadSha256` 会把**整棵输入树**读一遍（export.xml + workout-routes/**），
 * 所以"算了几遍"是这一批的实际成本之一。老实现里，带锚点的增量批会算 **2 遍**：
 *   ① `detectUnchangedPayload` 的预检（未命中就把摘要丢掉）；
 *   ② 车道派发前的 `payloadSha256()` 重算。
 * 现在预检把算出来的值一并交回，②复用①的值 ⇒ **1 遍**。
 *
 * ⛔ 这条**不是**"少一道校验"：两条车道仍然各自复核它们真正要写的内容摘要
 * （`data-only-import.ts:120` / `direct-sync-ingest.ts:483`），下面同时钉住这点 ——
 * 复用的是**主线程**那一遍重复，车道内部那两遍一遍都没少。
 * ⛔ 也不是 mtime/大小缓存：上传目录的不可变性没有被证明，摘要每次都真的重算。
 */
test("载荷身份（整棵输入树）每批只算 1 次：预检未命中的增量批不再重算第二遍", async () => {
  await fixture(async ({ main, make, writeInput }) => {
    const worker = make();
    try {
      // 第 1 批：库里还没有锚点 ⇒ 预检不适用，只有车道派发那一次。
      const first = await runBatch(worker, writeInput(0), "digest-first");
      assert.equal(first.status, "succeeded", JSON.stringify(first));
      const afterFirst = worker.payloadIdentityComputations();
      assert.equal(afterFirst, 1, "首批只有车道派发前那一次摘要计算");

      // 第 2 批：锚点已存在（第 1 批在事务里写下的），但载荷不同 ⇒ 预检**未命中**。
      // 这正是老实现算两遍的那条路径。
      const second = await runBatch(worker, writeInput(1), "digest-second");
      assert.equal(second.status, "succeeded", JSON.stringify(second));
      assert.equal(worker.payloadIdentityComputations() - afterFirst, 1,
        "预检未命中的增量批只允许算 1 次载荷身份（老实现：预检 1 次 + 派发前重算 1 次 = 2 次）");

      // 车道侧的内容复核没有因此变少：第二批确实落了记录（说明车道跑过并且复核通过）。
      const probe = new DatabaseSync(main, { readOnly: true });
      try {
        assert.equal(Number(probe.prepare("SELECT COUNT(*) AS n FROM health_records").get()!.n), 2,
          "两批各自的记录都必须落库 —— 摘要折叠不得变成跳过某条车道");
      } finally { probe.close(); }
    } finally { await worker.close(); }
  });
});

/*
 * 常驻线程**空闲时不得保活进程**（这条性质只能从进程外部证）。
 *
 * 🔴 为什么必须有这条：线程从"一轮一条"改成常驻之后，"创建它的对象没被收掉"（某条真实存在
 * 的路径就是如此 —— `worker.test.ts` 里有一条断言提前抛错、跳过了 `close()`）会让**整个
 * 测试进程永远退不出去**。那不是启动成本的问题，是拿资源泄漏换性能。
 *
 * 判据只能由一个**子进程**给出：父进程里跑导入再故意不 `close()`，然后什么都不做 ——
 * 如果空闲的常驻线程还引用着事件循环（Node v22 实测：仅 `unref()` 不够，`message` 监听器
 * 会引用住 `MessagePort`），子进程会一直挂着；装上/卸下监听器之后它必须自己退出。
 * ⛔ 这条断言不检查"退出码是多少"，只检查**有没有在有界时间内退出**。
 */
test("忘了 close 的常驻 ingest 线程不得把进程钉在事件循环里（子进程必须自己退出）", async () => {
  const scriptPath = join(project, "var", `wp41-exit-fixture-${process.pid}-${Date.now()}.mts`);
  mkdirSync(join(project, "var"), { recursive: true });
  const workerModule = pathToFileURL(join(project, "apps/api/src/import-worker.ts")).href;
  const storageModule = pathToFileURL(join(project, "packages/storage-sqlite/src/index.ts")).href;
  const parserModule = pathToFileURL(join(project, "packages/health-export-parser/src/index.ts")).href;
  const contractsModule = pathToFileURL(join(project, "packages/contracts/src/index.ts")).href;
  writeFileSync(scriptPath, `
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION } from ${JSON.stringify(contractsModule)};
import { RaiDatabase } from ${JSON.stringify(storageModule)};
import { identityAlgorithmFingerprint, NATIVE_VERSION } from ${JSON.stringify(parserModule)};
import { ImportWorker } from ${JSON.stringify(workerModule)};
import { MutationCoordinator } from ${JSON.stringify(pathToFileURL(join(project, "apps/api/src/mutation-coordinator.ts")).href)};
import { TaskAdmissionScheduler } from ${JSON.stringify(pathToFileURL(join(project, "apps/api/src/task-admission.ts")).href)};

const root = mkdtempSync(join(tmpdir(), "rai-wp41-exit-"));
const main = join(root, "main.sqlite");
const input = join(root, "input");
mkdirSync(input);
writeFileSync(join(input, "export.xml"), \`<HealthData><Record type="HKQuantityTypeIdentifierStepCount"
  sourceName="Watch" unit="count" value="10" startDate="2026-01-01 00:00:00 +0000"
  endDate="2026-01-01 00:01:00 +0000"><MetadataEntry key="RAIHealthKitSampleUUID"
  value="00000000-0000-0000-0000-0000000000aa"/></Record></HealthData>\`);
writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
  version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
}));
const store = await RaiDatabase.open(main);
store.setManifest("dataset_version", "fixture");
store.setManifest("parser_contract_version", CONTRACT_VERSION);
store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
store.close();
const worker = new ImportWorker(main, ${JSON.stringify(project)}, root, () => {
  throw new Error("delta must not enter the replacement gate");
}, undefined, undefined, {
  scope: "exit-fixture", dataOnlyFastPath: true,
  admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
});
const job = worker.create(input, undefined, "exit-fixture");
const deadline = Date.now() + 60_000;
while (worker.hasPending || worker.isRunning) {
  if (Date.now() > deadline) { process.stderr.write("fixture timeout\\n"); process.exit(2); }
  await new Promise((done) => setTimeout(done, 25));
}
process.stdout.write("FIXTURE_JOB=" + worker.get(job.id)?.status + "\\n");
// ⛔ 故意**不**调用 worker.close()：判据就是"忘记收线程也不能把进程钉住"。
void NATIVE_VERSION;
`, "utf8");
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath], { cwd: project });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((done) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); done({ code: null, timedOut: true }); }, 60_000);
    child.once("exit", (code) => { clearTimeout(timer); done({ code, timedOut: false }); });
  });
  rmSync(scriptPath, { force: true });
  assert.equal(outcome.timedOut, false,
    "未 close 的 ImportWorker 让进程挂住了：空闲的常驻线程必须不引用事件循环"
    + "（`unref()` 单独不够，`message` 监听器要跟着任务装卸）");
  assert.match(stdout, /FIXTURE_JOB=succeeded/, `子进程必须真的跑完一批导入：${stdout}`);
  assert.equal(outcome.code, 0, "子进程必须正常退出（退出码 0）");
});

test("车道计划的 fail-closed 校验：颠倒或未知顺序一律拒绝执行（不做任何尝试）", async () => {  // 这是"为了少起线程而先跑宽车道"的结构性防线：worker 不认下发来的顺序以外的任何计划。
  assert.doesNotThrow(() => assertLanePlan(["data-only", "direct-sync"]));
  for (const plan of [["direct-sync", "data-only"], ["direct-sync"], ["data-only"], []]) {
    assert.throws(() => assertLanePlan(plan as never), /Unsupported import lane plan/,
      `非法车道计划必须 fail-closed：${JSON.stringify(plan)}`);
  }
});

test("每个任务的数据库调查：同路径换文件（恢复/换库）必须被看见", async () => {
  await fixture(async ({ main, root }) => {
    const first = surveyDatabase(main, null);
    assert.ok(first.target !== null, "调查必须给出目标身份（dev:ino）");
    assert.equal(first.targetChanged, false, "第一次调查没有「上一批」可比");
    assert.equal(first.contractVersion, CONTRACT_VERSION);
    assert.equal(first.identityAlgorithm, identityAlgorithmFingerprint());

    const replacement = join(root, "replacement.sqlite");
    const store = await RaiDatabase.open(replacement);
    store.setManifest("dataset_version", "restored");
    store.close();
    // 同路径、换文件：恢复/换库的真实形态（inode 变、路径不变）。
    // 侧车文件一起清掉，避免旧 WAL/SHM 让人误以为"还是原来那个库"。
    rmSync(main);
    rmSync(`${main}-wal`, { force: true });
    rmSync(`${main}-shm`, { force: true });
    copyFileSync(replacement, main);

    const second = surveyDatabase(main, first);
    assert.equal(second.targetChanged, true,
      "同路径换了文件必须被看见 —— 旧连接与旧调查结论都不许带进新库");
    assert.equal(second.datasetVersion, "restored", "当前版本必须**每任务重读**，不能沿用上一批的");
  });
});

/*
 * 终止账本与恢复阻断的回归（2026-10-21 补修）。
 *
 * 这里守的是两条**资源/安全**性质，而不是性能：
 *   ① `ingestTerminations` 只跟踪尚未结算的终止操作；连续失败、替换线程后不得
 *      把历史 Promise 永久留在集合里。
 *   ② 恢复分支中的 terminate 失败（同步抛错或 Promise 拒绝）不得绕过阻断：
 *      作业必须停在 running + recovery_required，全局 TaskAdmission 不得再发许可，
 *      也不得执行 onTerminal。
 */

interface TerminationSurface extends Surface {
  ingest: ResidentSurface | null;
  ingestTerminations: Set<Promise<void>>;
  ingestTerminationError: Error | null;
  retireIngestWorker(resident: unknown, error: Error): Promise<void>;
  waitForIngestTermination(): Promise<boolean>;
}

/** 只满足 retireIngestWorker 所需字段的假 resident；不创建真实线程。 */
function fakeResident(terminate: () => Promise<number>) {
  return {
    thread: { terminate, postMessage: () => {}, emit: () => false },
    ready: Promise.resolve(),
    startup: { settled: true, resolve: () => {}, reject: () => {} },
    startupMs: 0,
    startError: null as Error | null,
    retired: false,
    pending: new Map<number, {
      resolve: (value: unknown) => void; reject: (error: Error) => void; stage: string; startedAt: number;
    }>(),
    termination: null as Promise<void> | null,
    listener: null
  };
}

test("连续 25 轮正常退休：已结算的 termination 立即移出集合，不随历史增长", async () => {
  await fixture(async ({ make }) => {
    const worker = make();
    const surface = worker as unknown as TerminationSurface;
    try {
      for (let index = 0; index < 25; index += 1) {
        await surface.retireIngestWorker(fakeResident(async () => 0), new Error(`retire-${index}`));
        assert.equal(surface.ingestTerminations.size, 0,
          `第 ${index + 1} 轮结算后集合必须为空（历史记录不得累积）`);
      }
      assert.equal(await surface.waitForIngestTermination(), true);
      assert.equal(surface.ingestTerminationError, null);
    } finally { await worker.close(); }
  });
});

test("两条终止操作交错完成：第一条完成不得被判为整体停止", async () => {
  await fixture(async ({ make }) => {
    const worker = make();
    const surface = worker as unknown as TerminationSurface;
    try {
      let releaseFirst!: (code: number) => void;
      let releaseSecond!: (code: number) => void;
      const first = fakeResident(() => new Promise<number>((resolve) => { releaseFirst = resolve; }));
      const second = fakeResident(() => new Promise<number>((resolve) => { releaseSecond = resolve; }));
      const firstRetirement = surface.retireIngestWorker(first, new Error("first"));
      const secondRetirement = surface.retireIngestWorker(second, new Error("second"));
      assert.equal(surface.ingestTerminations.size, 2, "两条未结算的终止操作都必须在集合里");

      let settled = false;
      const waiting = surface.waitForIngestTermination().then((value) => { settled = true; return value; });
      releaseFirst(0);
      await firstRetirement;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled, false, "第二条终止操作仍在等待时，第一条完成不能判为全部停止");
      assert.equal(surface.ingestTerminations.size, 1, "已结算的第一条必须已移出集合");

      releaseSecond(0);
      await secondRetirement;
      assert.equal(await waiting, true);
      assert.equal(surface.ingestTerminations.size, 0);
    } finally { await worker.close(); }
  });
});

test("等待期间新增退休操作：新增的 termination 同样被等待", async () => {
  await fixture(async ({ make }) => {
    const worker = make();
    const surface = worker as unknown as TerminationSurface;
    try {
      let releaseFirst!: (code: number) => void;
      let releaseSecond!: (code: number) => void;
      const first = fakeResident(() => new Promise<number>((resolve) => { releaseFirst = resolve; }));
      const second = fakeResident(() => new Promise<number>((resolve) => { releaseSecond = resolve; }));
      const firstRetirement = surface.retireIngestWorker(first, new Error("first"));

      let settled = false;
      const waiting = surface.waitForIngestTermination().then((value) => { settled = true; return value; });
      // 让等待真正进入第一个快照之后，再退休一条：覆盖“等待期间新增”的路径。
      await Promise.resolve();
      const secondRetirement = surface.retireIngestWorker(second, new Error("second"));
      assert.equal(surface.ingestTerminations.size, 2);

      releaseFirst(0);
      await firstRetirement;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled, false, "等待期间新增的终止操作必须继续等待，不能提前返回");

      releaseSecond(0);
      await secondRetirement;
      assert.equal(await waiting, true);
      assert.equal(surface.ingestTerminations.size, 0);
    } finally { await worker.close(); }
  });
});

test("terminate 同步抛错/异步拒绝：集合清空后仍返回停止未确认，后续成功不得清除失败", async () => {
  await fixture(async ({ make }) => {
    for (const mode of ["sync", "async"] as const) {
      const worker = make();
      const surface = worker as unknown as TerminationSurface;
      const failing = fakeResident(mode === "sync"
        ? () => { throw new Error(`injected ${mode} terminate failure`); }
        : async () => { throw new Error(`injected ${mode} terminate failure`); });
      await assert.rejects(
        surface.retireIngestWorker(failing, new Error("retire failing resident")),
        new RegExp(`injected ${mode} terminate failure`));
      assert.equal(surface.ingestTerminations.size, 0, `${mode}：拒绝的终止操作也必须移出集合`);
      assert.ok(surface.ingestTerminationError instanceof Error, `${mode}：必须记录首次终止失败`);
      assert.equal(await surface.waitForIngestTermination(), false,
        `${mode}：集合为空不等于停止已确认`);

      // 后续正常退休不得把历史失败“洗掉”。
      await surface.retireIngestWorker(fakeResident(async () => 0), new Error("later normal retirement"));
      assert.equal(surface.ingestTerminations.size, 0);
      assert.equal(await surface.waitForIngestTermination(), false,
        `${mode}：后续成功不得清除生命周期内的首次终止失败`);

      await assert.rejects(worker.close(), /termination could not be confirmed/,
        `${mode}：close() 也必须把历史终止失败当作无法确认停止`);
    }
  });
});

test("同一 resident 重复退休：terminate 只调用一次并返回同一个 Promise", async () => {
  await fixture(async ({ make }) => {
    const worker = make();
    const surface = worker as unknown as TerminationSurface;
    try {
      let calls = 0;
      let release!: (code: number) => void;
      const resident = fakeResident(() => {
        calls += 1;
        return new Promise<number>((resolve) => { release = resolve; });
      });
      const first = surface.retireIngestWorker(resident, new Error("first retirement"));
      const second = surface.retireIngestWorker(resident, new Error("duplicate retirement"));
      assert.equal(first, second, "重复退休必须返回同一个 termination Promise");
      assert.equal(calls, 1, "同一个 resident 只允许调用一次 terminate()");
      release(0);
      await Promise.all([first, second]);
      assert.equal(surface.ingestTerminations.size, 0);
    } finally { await worker.close(); }
  });
});

test("连续多轮任务失败并替换线程：终止账本不积累历史", { timeout: 30_000 }, async () => {
  await fixture(async ({ make, writeInput }) => {
    const worker = make();
    const surface = worker as unknown as TerminationSurface;
    const original = surface.databaseTask.bind(worker);
    let currentInput: string | null = null;
    let poisonNext = false;
    let poisonIndex = 0;
    surface.databaseTask = async <T>(task: ImportDatabaseTask): Promise<T> => {
      if (poisonNext && task.operation === "import-lanes" && currentInput) {
        poisonNext = false;
        // 准入之后改载荷 ⇒ 车道内容摘要复核抛错 ⇒ 线程被真实替换。
        writeFileSync(join(currentInput, "export.xml"), recordOnlyXml(20 + poisonIndex));
      }
      return original<T>(task);
    };
    try {
      for (let index = 0; index < 3; index += 1) {
        poisonIndex = index;
        currentInput = writeInput(10 + index);
        poisonNext = true;
        const failed = await runBatch(worker, currentInput, `poison-thread-${index}`);
        assert.equal(failed.status, "failed", `第 ${index + 1} 轮必须按任务失败结算：${JSON.stringify(failed)}`);
        assert.equal(surface.ingestTerminations.size, 0,
          `第 ${index + 1} 轮线程退出后不得把已结算的 termination 留在集合里`);
      }
      assert.equal(worker.ingestWorkerStats().retired, 3, "三轮失败必须各替换一条线程");

      const good = await runBatch(worker, writeInput(30), "after-three-retirements");
      assert.equal(good.status, "succeeded", JSON.stringify(good));
      assert.equal(worker.ingestWorkerStats().started, 4, "第 4 条线程只应在成功批需要时创建");
      assert.equal(surface.ingestTerminations.size, 0, "成功批结束后集合仍必须为空");
      assert.equal(await surface.waitForIngestTermination(), true, "没有终止失败时必须确认停止");
    } finally { await worker.close(); }
  });
});

async function assertTerminateFailureBlocksRecovery(mode: "sync" | "async"): Promise<void> {
  await fixture(async ({ make, writeInput }) => {
    const scheduler = new TaskAdmissionScheduler(new MutationCoordinator());
    const admission = scheduler.owner("import");
    let recoveryRequired = 0;
    let targetId = "";
    let targetTerminalCalls = 0;
    const worker = make({
      admission,
      onRecoveryRequired: () => {
        recoveryRequired += 1;
        scheduler.blockUntilRestart("import_recovery_required");
      },
      onTerminal: (job) => { if (job.id === targetId) targetTerminalCalls += 1; }
    });
    const surface = worker as unknown as TerminationSurface & LifecycleSurface;
    let resident: ResidentSurface | null = null;
    let originalTerminate: (() => Promise<number>) | null = null;
    try {
      // 先跑一批，留下一条**真实且活跃**的常驻线程；恢复分支必须主动退休它。
      const seed = await runBatch(worker, writeInput(0), `terminate-failure-seed-${mode}`);
      assert.equal(seed.status, "succeeded", JSON.stringify(seed));
      resident = surface.ingest;
      assert.ok(resident, "seed 批必须留下常驻 ingest 线程");
      const thread = resident!.thread;
      originalTerminate = thread.terminate.bind(thread);

      // 让目标批在 writeMayHaveCommitted=true 之后抛错，进入恢复分支；
      // 此时线程仍然活着，恢复分支会亲自调用 retireIngestWorker()。
      const originalDatabaseTask = surface.databaseTask.bind(worker);
      surface.databaseTask = async <T>(task: ImportDatabaseTask): Promise<T> => {
        if (task.operation === "import-lanes"
            && (task.input as { jobId?: string }).jobId === targetId) {
          throw new Error("simulated lost worker reply after commit attempt");
        }
        return originalDatabaseTask<T>(task);
      };
      thread.terminate = mode === "sync"
        ? () => { throw new Error(`injected ${mode} terminate failure`); }
        : async () => { throw new Error(`injected ${mode} terminate failure`); };

      const target = worker.create(writeInput(1), undefined, `terminate-failure-target-${mode}`);
      targetId = target.id;
      await waitFor("recovery_required after terminate failure",
        () => worker.get(target.id)?.phase === "recovery_required", 15_000);
      await waitFor("withheld run settled", () => !worker.isRunning, 10_000);

      const blocked = worker.get(target.id);
      assert.equal(blocked?.status, "running", `${mode}: 结果未裁决时不得发布成功/失败终态`);
      assert.equal(blocked?.phase, "recovery_required");
      assert.equal(worker.hasPending, true, `${mode}: 作业必须保留在未结束队列里`);
      assert.equal(recoveryRequired, 1, `${mode}: 必须通知全局恢复阻断一次`);
      assert.equal(scheduler.isBlocked, true, `${mode}: 全局 TaskAdmissionScheduler 必须被阻断`);
      assert.equal(admission.acquire(), null, `${mode}: 阻断后任何新的全局写者都不得取得许可`);
      assert.equal(targetTerminalCalls, 0, `${mode}: 不得执行 onTerminal/source cleanup`);
      assert.equal(surface.ingestTerminations.size, 0, `${mode}: 失败终止操作也必须移出集合`);
      assert.ok(surface.ingestTerminationError instanceof Error, `${mode}: 必须记录终止失败`);
    } finally {
      // 恢复原方法并**真正**停止线程：注入的 terminate 从未发出终止请求。
      if (resident && originalTerminate) {
        resident.thread.terminate = originalTerminate;
        await originalTerminate().catch(() => {});
      }
    }
  });
}

test("恢复分支中 terminate 同步抛错：进入恢复阻断，全局写者无法取得许可", { timeout: 30_000 }, async () => {
  await assertTerminateFailureBlocksRecovery("sync");
});

test("恢复分支中 terminate 异步拒绝：进入恢复阻断，全局写者无法取得许可", { timeout: 30_000 }, async () => {
  await assertTerminateFailureBlocksRecovery("async");
});

test("恢复冻结是独立句柄：普通恢复尝试不写 recoveryBlocked，幂等且只按身份释放", { timeout: 30_000 }, async () => {
  await fixture(async ({ make, writeInput }) => {
    const scheduler = new TaskAdmissionScheduler(new MutationCoordinator());
    const admission = scheduler.owner("import");
    let notices = 0;
    const worker = make({ admission, onRecoveryRequired: () => { notices += 1; } });
    try {
      const seed = await runBatch(worker, writeInput(0), "freeze-seed");
      assert.equal(seed.status, "succeeded");
      const first = await worker.prepareForRestore();
      const second = await worker.prepareForRestore();
      assert.equal(second.id, first.id, "重复 prepare 必须返回同一个冻结句柄");
      assert.equal(worker.isRestoreFrozen, true);
      assert.equal(worker.hasRecoveryBlock, false, "临时冻结不得写成持久恢复阻断");
      assert.equal(notices, 0, "临时冻结不得触发全局恢复阻断通知");
      assert.throws(() => worker.create(writeInput(1), undefined, "frozen-create"),
        /恢复进行中|restore/i, "冻结期间不得接受新任务");

      assert.equal(worker.releaseRestoreFreeze({ ...first, id: "foreign-handle" }), false,
        "陌生句柄不得释放当前冻结");
      assert.equal(worker.isRestoreFrozen, true);
      assert.equal(worker.releaseRestoreFreeze(first), true);
      assert.equal(worker.isRestoreFrozen, false);

      const after = await runBatch(worker, writeInput(2), "freeze-after");
      assert.equal(after.status, "succeeded", "释放冻结后同进程必须真的能继续调度");
    } finally { await closeWithDeadline(worker, "freeze cleanup"); }
  });
});

test("恢复后重裁决：旧 scope 作业持久 superseded，新 scope 作业可实际运行", { timeout: 30_000 }, async () => {
  await fixture(async ({ root, make, writeInput }) => {
    const state = new RuntimeStateStore(root);
    const worker = make();
    try {
      const handle = await worker.prepareForRestore();
      // Persisted pre-restore job in the old scope, parked at recovery_required.
      state.upsertJob({
        id: "old-scope-job", status: "queued", phase: "recovery_required", message: "",
        createdAt: "2026-10-23T00:00:00.000Z", completedAt: null, error: null,
        inputPath: root, queue: { scope: "old-scope", attempts: 1, finalized: false }
      });
      const reload = worker.reloadAfterRestore("restored-epoch");
      assert.equal(reload.reconciled, true, JSON.stringify(reload));
      assert.equal(reload.blockedJobs, 0);
      const parked = worker.get("old-scope-job");
      assert.equal(parked?.phase, "superseded", "旧 scope 作业不得被伪报为未提交");
      assert.equal(state.job("old-scope-job")?.queue?.finalized, true, "superseded 终态必须持久");

      worker.releaseRestoreFreeze(handle);
      const after = await runBatch(worker, writeInput(0), "restored-first-packet");
      assert.equal(after.status, "succeeded", "恢复后同进程的新导入必须真的完成");
    } finally { await closeWithDeadline(worker, "reload cleanup"); }
  });
});

test("恢复后仍有无法核实的回执：reload 返回阻断而不是 true", { timeout: 30_000 }, async () => {
  await fixture(async ({ root, main, make }) => {
    const state = new RuntimeStateStore(root);
    const worker = make();
    const hidden = `${main}.unverifiable-${Date.now()}`;
    try {
      const handle = await worker.prepareForRestore();
      state.upsertJob({
        id: "unverifiable-job", status: "running", phase: "running", message: "",
        createdAt: "2026-10-23T00:00:00.000Z", completedAt: null, error: null,
        inputPath: root, queue: { scope: "reuse-fixture", attempts: 1, finalized: false }
      });
      renameSync(main, hidden);
      const reload = worker.reloadAfterRestore("restored-epoch");
      assert.equal(reload.reconciled, false, "只检查作业、不检查发布日志的成功不得报告为已恢复");
      assert.equal(reload.blockedJobs, 1);
      assert.equal(worker.hasRecoveryBlock, true);
      assert.equal(worker.get("unverifiable-job")?.phase, "recovery_required");
      worker.releaseRestoreFreeze(handle);
      assert.equal(worker.isRestoreFrozen, false, "真实阻断与临时冻结必须分离");
      assert.equal(worker.hasRecoveryBlock, true, "释放临时冻结不得清除真实阻断");
    } finally {
      renameSync(hidden, main);
      await closeWithDeadline(worker, "unverifiable cleanup");
    }
  });
});
