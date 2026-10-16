// §14.1「禁止操作」的可执行守卫（docs/SQLITE_DIRECT_SYNC_DESIGN.md）。
//
// 为什么需要它：文档 §14.1 要求这些操作"必须证明没有调用，而不只是没有显示"。
// 在那之前，"正常同步不再整库备份/换库"只是**断言**——UI 不显示阶段名、
// 或者函数改个名，都能让检查变成假绿。
//
// 这个文件把要求变成可判定的两问：
//   1. 守卫**看不看得见**每一条？（结构性：通道名必须真实存在、每条至少一个通道）
//   2. 直连车道跑完，**有没有任何一条被触发**？（行为性）
//
// 🔴 只有第 1 问是不够的：一个看得见但从不报警的守卫，与没有守卫无法区分。
// 所以下面还有一条**阳性对照**——**直接调用保留的禁止方法**，断言守卫确实转红。
// 没有这条对照，第 2 问的"全 0"可能只是守卫瞎了。（2026-10-14 S3.3：旧候选路径的
// 运行期调用链已删除，对照方式从"让它真的跑一遍"改为"直接调用保留方法"。）
//
// ⚠️ 覆盖边界（2026-10-14 随 S3.3 更新）：两条直连子车道都跑 —— record-only 快通路
// （记录白名单）与统一接收器（Workout / 评分类型 / 删除 / GPX）；**超限/不合规载荷
// 现在显式失败（带稳定码），不再进入候选链路** —— 也就是说，本文件的两条车道上
// "§14.1 全 0"是完整可证的（守卫的可见性由下一条阳性对照负责）。
//
// 🔴 2026-10-16（WP-41 / O12 第一阶段）**有意的判据迁移，不是放宽**：
// 两条导入车道合并进**同一个**任务（`import-lanes`），于是一个载荷不再起两条线程。
// 旧的两条断言是 `databaseTaskCalls == ["data-only"]` 与 `["data-only","direct-sync"]`；
// 现在拆成**两问**，合起来与旧断言等价：
//   ① `databaseTaskCalls == ["import-lanes"]` —— 一个载荷**只投递一次**（= 不起两条线程）；
//   ② `guard.laneAttempts == ["data-only"]` / `["data-only","direct-sync"]` —— worker 线程
//      **实际执行过**的车道序列（由线程在跑完之后回报，不是主线程的投递顺序）。
// 第②问比旧写法更接近事实（它来自真正执行的那一侧），而"顺序被颠倒"仍然会红
// （突变验证：把 `runImportLanesTask` 改成先跑宽车道 ⇒ 上面两条用例都红）。
//
// 用法：随 `npm test` 运行。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CONTRACT_VERSION,
  PROHIBITED_DIRECT_SYNC_OPERATIONS,
  unobservableProhibitedOperations,
  type ProhibitedDirectSyncOperation
} from "@rai/contracts";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";
import { ImportWorker } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { readImportReceipt } from "../src/import-publication.js";
import type { ImportDatabaseTask } from "../src/import-database-tasks.js";

const project = resolve(import.meta.dirname, "../../..");
const uuid = "00000000-0000-0000-0000-00000000000a";

/**
 * `ImportDatabaseTask["operation"]` 的穷尽取值。用 `Record<..., true>` 而不是普通数组：
 * 少写一个键或多写一个键都会**编译不过**，守卫因此不会因为对端新增任务类型而静默失效。
 *
 * ⚠️ 2026-10-16（WP-41 / O12 第一阶段）：`data-only` 与 `direct-sync` 两个任务类型**合并**成
 * 一个 `import-lanes` 任务（两条车道在同一个 Worker 里按顺序执行）。这次改动是**收窄**守卫
 * 的观察面（从前看"投递了哪两个任务"，现在看"一次投递 + 线程回报的尝试序列"），
 * 所以下面每条断言都必须同时钉住**新的**事实（见 `laneAttempts`）。
 */
const databaseTaskOperations: Record<ImportDatabaseTask["operation"], true> = {
  verify: true, audit: true, checkpoint: true, "import-lanes": true
};

interface Guard {
  counters: Map<string, number>;
  commands: string[][];
  databaseTaskCalls: string[];
  storeMethodCalls: string[];
  /**
   * worker 回报的**实际执行过的车道序列**（逐次投递累加）。
   *
   * 🔴 为什么这条通道必须存在：`data-only`/`direct-sync` 合并成一个任务之后，
   * "投递序列"再也说不出车道顺序 —— 它只会说 `["import-lanes"]`。而顺序本身是**判据**
   * （record-only 的入口判据更严，必须先试）。序列由 worker 线程在**真的跑完**之后回报，
   * 所以它比"主线程打算投递什么"更接近事实：主线程投递了 `import-lanes`，但线程内部
   * 到底试了几条车道、顺序如何，只有回报能证明。
   */
  laneAttempts: string[];
}

interface Surface extends Record<string, unknown> {
  command(...args: unknown[]): unknown;
  databaseTask(...args: unknown[]): unknown;
}

/**
 * 在**真实对象**上装观测器：不改实现，只计数后原样转发。
 * ⚠️ 包装顺序无关紧要——方法包装先装、`databaseTask` 后装也能生效，因为内部调用在
 * **调用时**才查属性（`this.databaseTask`），拿到的是包装后的版本。
 */
function installGuard(worker: ImportWorker): Guard {
  const counters = new Map<string, number>();
  const commands: string[][] = [];
  const databaseTaskCalls: string[] = [];
  const storeMethodCalls: string[] = [];
  const laneAttempts: string[] = [];
  const surface = worker as unknown as Surface;

  for (const operation of PROHIBITED_DIRECT_SYNC_OPERATIONS) {
    const name = operation.workerMethod;
    if (name === null) continue;
    const original = surface[name];
    assert.equal(typeof original, "function",
      `§14.1 守卫通道失效：ImportWorker 上不存在方法 \`${name}\`（条目 ${operation.id}）。` +
      "改名会让守卫静默失去覆盖 —— 请同时更新 contracts 与真实实现。");
    surface[name] = (...args: unknown[]) => {
      counters.set(name, (counters.get(name) ?? 0) + 1);
      return (original as (...inner: unknown[]) => unknown).apply(worker, args);
    };
  }

  // 🔴 **进程内**通道：包装 `RaiDatabase.prototype[storeMethod]`。
  // 存在的理由：`seed-import-generations` 的真实调用点是进程内的
  // `store.seedImportGenerations(...)`，它既不是 worker 方法、也不经过子进程 ——
  // 只靠 `commandSubcommands` 的话，直连车道（不跑子进程）上那条守卫**构造性恒为 0**。
  // 包装在原型上，所以守卫对任何 store 实例都生效，包括车道内部自己 new 出来的。
  for (const operation of PROHIBITED_DIRECT_SYNC_OPERATIONS) {
    const name = operation.storeMethod ?? null;
    if (name === null) continue;
    const prototype = RaiDatabase.prototype as unknown as Record<string, unknown>;
    const original = prototype[name];
    assert.equal(typeof original, "function",
      `§14.1 守卫通道失效：RaiDatabase 上不存在方法 \`${name}\`（条目 ${operation.id}）。` +
      "改名会让守卫静默失去覆盖 —— 请同时更新 contracts 与真实实现。");
    prototype[name] = function patched(this: unknown, ...args: unknown[]) {
      storeMethodCalls.push(name);
      return (original as (...inner: unknown[]) => unknown).apply(this, args);
    };
  }

  const originalCommand = surface.command as (...args: unknown[]) => unknown;
  surface.command = (...args: unknown[]) => {
    commands.push(args.map((value) => String(value)));
    return originalCommand.apply(worker, args);
  };

  const originalTask = surface.databaseTask as (...args: unknown[]) => unknown;
  surface.databaseTask = (...args: unknown[]) => {
    const task = args[0] as { operation?: unknown } | undefined;
    databaseTaskCalls.push(String(task?.operation));
    const dispatched = originalTask.apply(worker, args);
    // 车道序列只能从**任务回报**里取（见 `Guard.laneAttempts` 的说明）。原样转发返回值，
    // 只在旁边记一笔 —— 观测器不得改变被测对象的语义。
    if (task?.operation === "import-lanes" && dispatched instanceof Promise) {
      return dispatched.then((value: unknown) => {
        const reported = (value as { laneAttempts?: unknown } | null)?.laneAttempts;
        if (Array.isArray(reported)) laneAttempts.push(...reported.map(String));
        return value;
      });
    }
    return dispatched;
  };

  return { counters, commands, databaseTaskCalls, storeMethodCalls, laneAttempts };
}

/** 把观测结果判成"哪几条 §14.1 被触发了"。空数组 = 一条都没踩。 */
function triggeredOperations(guard: Guard, stages: Record<string, unknown>): ProhibitedDirectSyncOperation[] {
  const present = (stage: string): boolean => Object.prototype.hasOwnProperty.call(stages, stage);
  return PROHIBITED_DIRECT_SYNC_OPERATIONS.filter((operation) => {
    if (operation.workerMethod !== null && (guard.counters.get(operation.workerMethod) ?? 0) > 0) return true;
    if (operation.databaseTaskOperation !== null && guard.databaseTaskCalls.includes(operation.databaseTaskOperation)) return true;
    if ((operation.storeMethod ?? null) !== null && guard.storeMethodCalls.includes(operation.storeMethod!)) return true;
    if (operation.commandSubcommands.length > 0
        && guard.commands.some((args) => args.some((arg) => operation.commandSubcommands.includes(arg)))) return true;
    // 源码级通道：只在别的手段都不可得时才用（见 contracts 的注释）。
    const forbidden = operation.forbiddenIdentifiers ?? null;
    if (forbidden !== null && forbidden.identifiers.some((identifier) =>
      forbidden.files.some((file) => new RegExp(`\\b${identifier}\\b`)
        .test(readFileSync(join(project, file), "utf8"))))) return true;
    return operation.stages.some(present);
  });
}

function stagesOf(worker: ImportWorker, jobId: string): Record<string, unknown> {
  const performance = worker.get(jobId)?.performance;
  // ⚠️ 两个账本都要看：`stagesMs` 记 worker 自己的阶段，`computeStagesMs` 记投递到数据库
  // 工作线程的任务阶段。只看一个会漏掉 `database_quick_check` / `database_checkpoint`
  // 这类"藏在 databaseTask 里"的禁止操作。
  return { ...(performance?.stagesMs ?? {}), ...(performance?.computeStagesMs ?? {}) };
}

/** record-only 快通路的典型载荷：白名单记录类型 + UUID，没有 Workout。 */
const RECORD_ONLY_XML = `<HealthData><Record type="HKQuantityTypeIdentifierStepCount"
    sourceName="Watch" unit="count" value="10" startDate="2026-01-01 00:00:00 +0000"
    endDate="2026-01-01 00:01:00 +0000"><MetadataEntry key="RAIHealthKitSampleUUID"
    value="${uuid}"/></Record></HealthData>`;

/**
 * 2e 的全类型载荷：**带 Workout** 的增量。record-only 车道的入口判据（记录白名单）会拒收它，
 * 所以它必然落到统一接收器 —— 这正是本文件要证明"§14.1 在更宽的车道上也不被踩"的场景。
 */
const WORKOUT_XML = `<HealthData><Workout workoutActivityType="HKWorkoutActivityTypeRunning"
    sourceName="Watch" duration="30" durationUnit="min"
    startDate="2026-01-01 08:00:00 +0000" endDate="2026-01-01 08:30:00 +0000">
    <MetadataEntry key="RAIHealthKitWorkoutUUID" value="00000000-0000-0000-0000-00000000000b"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
  </Workout></HealthData>`;

async function fixture(run: (ctx: {
  root: string; main: string; input: string;
  make(enabled?: boolean): ImportWorker;
}) => Promise<void>, payload?: { xml?: string }) {
  const root = mkdtempSync(join(tmpdir(), "rai-direct-sync-guard-"));
  const main = join(root, "main.sqlite");
  const input = join(root, "input");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), payload?.xml ?? RECORD_ONLY_XML);
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
    await new Promise((done) => setTimeout(done, 25));
  }
}

test("A01/§14.1 清单本身自洽：每条都声明了可观测通道，且通道名在真实实现上存在", () => {
  assert.deepEqual(unobservableProhibitedOperations(), [],
    "§14.1 有条目没有声明任何可观测通道 —— 那一条无法被守卫证明，必须补通道或从清单移除");

  const ids = PROHIBITED_DIRECT_SYNC_OPERATIONS.map((operation) => operation.id);
  assert.equal(new Set(ids).size, ids.length, "§14.1 条目 id 必须唯一");

  const prototype = ImportWorker.prototype as unknown as Record<string, unknown>;
  for (const operation of PROHIBITED_DIRECT_SYNC_OPERATIONS) {
    if (operation.workerMethod !== null) {
      assert.equal(typeof prototype[operation.workerMethod], "function",
        `条目 ${operation.id} 声明的 workerMethod \`${operation.workerMethod}\` 在 ImportWorker 上不存在`);
    }
    if (operation.databaseTaskOperation !== null) {
      assert.ok(databaseTaskOperations[operation.databaseTaskOperation as ImportDatabaseTask["operation"]] === true,
        `条目 ${operation.id} 声明的 databaseTaskOperation \`${operation.databaseTaskOperation}\` 不是合法的任务类型`);
    }
    const storeMethod = operation.storeMethod ?? null;
    if (storeMethod !== null) {
      assert.equal(typeof (RaiDatabase.prototype as unknown as Record<string, unknown>)[storeMethod], "function",
        `条目 ${operation.id} 声明的 storeMethod \`${storeMethod}\` 在 RaiDatabase 上不存在`);
    }
    // 源码级通道的通道**自检**：文件必须真实存在，且标识符至少能匹配到一次"窗口版之外"的东西
    // —— 否则这条通道就是"看着在守、其实文件名写错了"的真空。
    const forbidden = operation.forbiddenIdentifiers ?? null;
    if (forbidden !== null) {
      for (const file of forbidden.files) {
        assert.ok(existsSync(join(project, file)),
          `条目 ${operation.id} 声明的源码通道文件不存在：${file}`);
      }
      assert.ok(forbidden.identifiers.length > 0);
    }
  }

  // 🔴 在本车道上**结构性不可能被触发**的条目必须显式声明，且清单是写死的。
  // 不声明的真空是缺陷（守卫看起来在守、其实什么都没守）；声明的真空是待办项。
  // 把清单写死在这里，是为了让"新增一条真空条目"必须是一次**有意的**改动，
  // 而不是加一行清单就自动获得"已守"的假象。
  // ✅ 2026-10-13（PR4 步骤 4）：最后一条真空条目补上了真通道 —— 直连车道开始跑 canonical
  // （按本批窗口），于是"全表重建"既有了源码级通道，也有了行为判据（窗口外逐字节不变）。
  // 现在这张清单必须**为空**：任何一条重新变成真空都要显式声明，而不是悄悄混进来。
  assert.deepEqual(
    PROHIBITED_DIRECT_SYNC_OPERATIONS.filter((operation) => (operation.vacuousOnDirectLane ?? null) !== null)
      .map((operation) => operation.id),
    [],
    "直连车道上又出现了真空条目：要么补一个真能响的通道，要么显式声明它为什么不可观测"
  );
});

test("A01/§14.1 逐项：真实排队的 v2 增量不触发任何禁止操作，且主库文件身份不变", async () => {
  await fixture(async ({ root, main, input, make }) => {
    const worker = make();
    const guard = installGuard(worker);
    const beforeInode = statSync(main).ino;
    try {
      const job = worker.create(input, undefined, "guard-source");
      await wait(worker);
      const done = worker.get(job.id);
      assert.equal(done?.status, "succeeded", JSON.stringify(done));

      const triggered = triggeredOperations(guard, stagesOf(worker, job.id)).map((operation) => operation.id);
      assert.deepEqual(triggered, [],
        `直连车道触发了 §14.1 禁止操作：${triggered.join(", ")}`);

      assert.deepEqual(guard.commands, [], "直连车道不得调用任何子进程 CLI");
      // 🔴 WP-41 / O12 第一阶段：两条车道合并成**同一个**任务 ⇒ 投递序列只剩一项。
      // 这一条现在钉的是"一个载荷**不会**起两条线程"（从前是 ["data-only","direct-sync"]，
      // 也就是两次 `new Worker`：两次 tsx 注册 + 两次模块加载）。车道顺序改由下面
      // `laneAttempts` 钉住 —— 两条断言合起来才等价于旧的那一条。
      assert.deepEqual(guard.databaseTaskCalls, ["import-lanes"],
        "直连车道只允许投递一个 import-lanes 任务（verify/audit/checkpoint 都是禁止操作，"
        + "而两条车道不得再各起一条线程）");
      assert.deepEqual(guard.laneAttempts, ["data-only"],
        "record-only 载荷必须**只有** record-only 车道真的跑过：统一接收器没有理由被启动，"
        + "启动了就是「为合格载荷白付一次尝试」（而且会让那条更严的入口判据失去意义）");
      // 🔴 进程内通道也必须为 0，而且它**真的能响**（见文件末尾的阳性对照）。
      // 从前 `seed-import-generations` 只有 `commandSubcommands` 通道，而本车道的
      // `commands` 恒为空 ⇒ 那条守卫在这里**构造性恒为 0**，"全 0"什么都没证明。
      assert.deepEqual(guard.storeMethodCalls, [],
        `直连车道不得在进程内直接调用被禁的 store 方法：${guard.storeMethodCalls.join(", ")}`);

      // 文件层面的独立判据：不看函数名，只看磁盘上留下了什么。
      const varEntries = readdirSync(join(root, "var"));
      const leftovers = varEntries.filter((name) => /^(backups|rai\.importing)/.test(name));
      assert.deepEqual(leftovers, [],
        `直连车道不得创建项目备份或整库候选，但 var/ 里出现了：${leftovers.join(", ")}`);
      assert.equal(statSync(main).ino, beforeInode, "主库文件身份必须保持不变（不得 rename/install/move）");

      // 🔴 行为级钉住"**这一批**没有登记分析任务"。2e 之后这条不再是车道级事实，而是批次级：
      // 本批载荷是白名单记录增量（结构上碰不到分析），所以回执 `not_required` 是准确的，
      // `recompute_jobs` 必须为空。动了分析的批次（下一条用例）则**必须**登记 ——
      // 两条用例合起来才说明"回执说的话与账本一致"。
      const probe = new DatabaseSync(main, { readOnly: true });
      try {
        assert.equal(Number(probe.prepare("SELECT COUNT(*) AS n FROM recompute_jobs").get()!.n), 0,
          "record-only 载荷不得登记分析任务：它结构上碰不到分析，登记了就是无谓地把分析标脏");
      } finally { probe.close(); }
    } finally { await worker.close(); }
  });
});

test("A01/§14.1 全类型：含 Workout 的增量走统一接收器，同样一条禁止操作都不踩", async () => {
  await fixture(async ({ root, main, input, make }) => {
    const worker = make();
    const guard = installGuard(worker);
    const beforeInode = statSync(main).ino;
    try {
      const job = worker.create(input, undefined, "guard-full-source");
      await wait(worker);
      const done = worker.get(job.id);
      assert.equal(done?.status, "succeeded", JSON.stringify(done));

      // §14.1 在**更宽**的车道上同样一条都不能踩 —— 这正是 2e 的验收口径（A01 全类型 + 禁止操作 0）。
      const triggered = triggeredOperations(guard, stagesOf(worker, job.id)).map((operation) => operation.id);
      assert.deepEqual(triggered, [],
        `full 车道触发了 §14.1 禁止操作：${triggered.join(", ")}`);
      assert.deepEqual(guard.commands, [], "full 车道同样不得调用任何子进程 CLI");
      // 🔴 两条子车道的顺序仍是判据：先 record-only（入口判据更严），拒收后才走统一接收器。
      // WP-41 之后这条判据**不能**再写成"投递序列" —— 两条车道在**同一个任务**里执行，
      // 投递序列只会是 ["import-lanes"]（上一条用例已经把它钉住：一个载荷不再起两条线程）。
      // 顺序改由 worker 线程**回报的尝试序列**钉住：它在真的跑完之后产生，因此"顺序被颠倒"
      // 或"宽车道先跑"都会在这里露出来（见下方 mutation 说明）。
      assert.deepEqual(guard.databaseTaskCalls, ["import-lanes"],
        "full 车道同样只投递一个 import-lanes 任务：两次尝试必须在**同一条线程**里完成");
      assert.deepEqual(guard.laneAttempts, ["data-only", "direct-sync"],
        "full 车道的**尝试序列**必须是 data-only（拒收）→ direct-sync（接收）："
        + "顺序反了就等于跳过了 record-only 更严的入口判据");
      assert.deepEqual(guard.storeMethodCalls, []);
      const leftovers = readdirSync(join(root, "var")).filter((name) => /^(backups|rai\.importing)/.test(name));
      assert.deepEqual(leftovers, [], `full 车道不得创建项目备份或整库候选，但 var/ 里出现了：${leftovers.join(", ")}`);
      assert.equal(statSync(main).ino, beforeInode, "主库文件身份必须保持不变");

      // 与上一条用例的**对照点**：这一批动了分析（Workout），所以必须登记任务并把回执写成 queued。
      const probe = new DatabaseSync(main, { readOnly: true });
      try {
        assert.equal(Number(probe.prepare("SELECT COUNT(*) AS n FROM recompute_jobs").get()!.n), 1,
          "含 Workout 的批次必须登记恰好一个分析任务（否则「原始已存、分析不更新」）");
        assert.equal(Number(probe.prepare("SELECT COUNT(*) AS n FROM workouts WHERE deleted_at IS NULL").get()!.n), 1);
      } finally { probe.close(); }
      const receipt = readImportReceipt(main, job.id);
      assert.equal(receipt?.directSync?.ingestStatus, "committed");
      assert.equal(receipt?.directSync?.analysisStatus, "queued");
      assert.equal(receipt?.directSync?.publishedReleaseId, null);
    } finally { await worker.close(); }
  }, { xml: WORKOUT_XML });
});

test("A01/§14.1 阳性对照（S3.3 改写）：直接调用保留方法，守卫必须转红 —— 「全 0」不是假绿", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：旧候选路径的调用链已从运行期删除，"让旧链路
  // 真的跑一遍"的对照方式不再可达。判据不变 —— 守卫必须对**这些方法本身**看得见，
  // 否则上一条"直连车道全 0"仍然不可证（看不见的守卫 = 没有守卫）。
  // 保留的方法（阶段 5 之前仍在类上）直接调用即可，观测器照常生效。
  await fixture(async ({ root, main, make }) => {
    const worker = make();
    const guard = installGuard(worker);
    const surface = worker as unknown as Surface;
    try {
      // ① createCurrentBackup：真做一次项目级备份（内部走 backupCapacity/backupCopy/backupVerify）。
      const backupPath = await (surface.createCurrentBackup as (id: string) => Promise<string | null>)
        .call(worker, "guard-positive-backup");
      assert.ok(backupPath !== null, "阳性对照前提：备份真的产出了产物");

      // ② 整库 copy：与旧候选链路的 stagingCopy 同一个动作（node:sqlite 的在线备份）。
      const source = new DatabaseSync(main);
      try {
        await (surface.backupDatabase as (database: DatabaseSync, destination: string) => Promise<void>)
          .call(worker, source, join(root, "var", "guard-positive-staging.sqlite"));
      } finally { source.close(); }

      // ③ 全库 quick_check（verify 通道）。
      await (surface.isReadableDatabase as (path: string) => Promise<boolean>).call(worker, main);

      const triggered = triggeredOperations(guard, {}).map((operation) => operation.id);
      for (const id of ["current-backup", "whole-database-copy", "full-database-quick-check"]) {
        assert.ok(triggered.includes(id),
          `阳性对照失效：直接调用保留方法没有触发 ${id}，守卫可能已经看不见它（实际触发：${triggered.join(", ") || "无"}）`);
      }
      // 与函数计数无关的独立证据：磁盘上真的出现了项目备份。
      assert.ok(readdirSync(join(root, "var")).includes("backups"),
        "备份路径应当留下 var/backups 目录 —— 这是守卫看到的另一条独立证据");
    } finally { await worker.close(); }
  });
});

test("A17/§10.1 直连回执把「原始已保存」与「分析已更新」分成两个字段，且与持久回执一致", async () => {
  await fixture(async ({ main, input, make }) => {
    const worker = make();
    try {
      const job = worker.create(input, undefined, "receipt-source");
      await wait(worker);
      const done = worker.get(job.id);
      assert.equal(done?.status, "succeeded", JSON.stringify(done));

      const receipt = done?.summary?.directSync;
      assert.ok(receipt, "直连车道必须产出一份 §10.1 回执");
      assert.equal(receipt.ingestStatus, "committed");
      assert.equal(receipt.analysisStatus, "not_required");
      assert.equal(receipt.receiptId, job.id);
      // 🔴 回执**不承诺**事实版本号（`rawGeneration` 已删除）：它以前装的是批次 token
      // `delta:<jobId>`，既与 `receiptId` 重复，又让人以为能喂给 `openFactsReader`
      // （那要非负整数）。这里把"它不该回来"钉住 —— 谁想加回数值版本号，
      // 必须同时带来写入方（见 `DirectSyncReceipt` 的说明与设计文档步骤 6b）。
      assert.equal(
        Object.prototype.hasOwnProperty.call(receipt, "rawGeneration"), false,
        "回执不得重新出现 rawGeneration —— 它是批次 token 的别名，会被当成可用的事实版本号"
      );
      assert.deepEqual(Object.keys(receipt).sort(),
        ["analysisStatus", "dependencyGeneration", "ingestStatus", "parentBatchId",
         "publishedReleaseId", "receiptId"]);
      assert.equal(receipt.dependencyGeneration, null, "本批不影响分析，依赖版本必须是 null 而不是空串");
      assert.equal(receipt.publishedReleaseId, null);
      assert.equal(receipt.parentBatchId, null);

      // 回执必须与**磁盘上的持久回执**同内容：只在内存里成立的回执，重启后就不认了。
      assert.deepEqual(readImportReceipt(main, job.id)?.directSync, receipt);
    } finally { await worker.close(); }
  });
});

test("A05/§14.1 重启后的已 committed 任务从持久回执恢复，且不投递任何数据库任务", async () => {
  await fixture(async ({ main, input, make }) => {
    const first = make();
    let jobId = "";
    try {
      const job = first.create(input, undefined, "restart-source");
      jobId = job.id;
      await wait(first);
      assert.equal(first.get(jobId)?.status, "succeeded");
    } finally { await first.close(); }

    // 重启一个**全新**的 worker：它必须只看持久回执就认定成功，而不是重放一遍写入。
    // §10.2 要求所有恢复分支走同一套回执规则，这条用例就是它的守卫。
    const restarted = make();
    const guard = installGuard(restarted);
    try {
      assert.equal(restarted.get(jobId)?.status, "succeeded");
      restarted.resume();
      await wait(restarted);
      assert.deepEqual(guard.databaseTaskCalls, [], "已 committed 的回执不应再投递任何数据库任务");
      assert.deepEqual(triggeredOperations(guard, stagesOf(restarted, jobId)).map((operation) => operation.id), []);
      assert.ok(readImportReceipt(main, jobId), "持久回执必须还在");
    } finally { await restarted.close(); }
  });
});

test("§14.1 进程内通道有牙：直接调用被禁的 store 方法会被守卫判红", async () => {
  // 🔴 这条对照是给 `seed-import-generations` 补的**阳性对照**，理由有实测依据：
  // 该条目原本只有 `commandSubcommands` 一个通道，而直连车道的 `guard.commands` 恒为空
  // （上一条用例自己断言了这一句）⇒ 那条守卫在直连车道上**构造性恒为 0**，
  // "全 0 ⇒ 通过"什么都没证明。补了 `storeMethod` 通道之后，必须有证据表明它**会响**，
  // 否则只是把一种真空换成另一种真空。
  await fixture(async ({ main, make }) => {
    const worker = make();
    const guard = installGuard(worker);
    const store = await RaiDatabase.open(main, { createMigrationBackup: false });
    try {
      store.seedImportGenerations("guard-positive-control");
      assert.deepEqual(guard.storeMethodCalls, ["seedImportGenerations"],
        "进程内通道没记到调用 —— 那条守卫又变成真空了");
      const triggered = triggeredOperations(guard, {}).map((operation) => operation.id);
      assert.ok(triggered.includes("seed-import-generations"),
        `通道记到了调用，却没把条目判红（判据接线断了）：${JSON.stringify(triggered)}`);
    } finally { store.close(); await worker.close(); }
  });
});
