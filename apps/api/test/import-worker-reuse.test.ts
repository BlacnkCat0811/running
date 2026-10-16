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
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";

import { ImportWorker } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { readImportReceipt } from "../src/import-publication.js";
import type { ImportDatabaseTask } from "../src/import-database-tasks.js";
import { assertLanePlan, surveyDatabase } from "../src/import-database-thread.js";

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

async function fixture(
  run: (ctx: { root: string; main: string; make(): ImportWorker; writeInput(index: number, xml?: string): string }) => Promise<void>
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
  const make = () => new ImportWorker(main, project, root, () => {
    throw new Error("delta must not enter the replacement gate");
  }, undefined, undefined, {
    scope: "reuse-fixture", dataOnlyFastPath: true,
    admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
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
