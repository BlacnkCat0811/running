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
// 所以下面还有一条**阳性对照**——让旧候选路径真的跑一遍，断言守卫确实转红。
// 没有这条对照，第 2 问的"全 0"可能只是守卫瞎了。
//
// ⚠️ 覆盖边界（PR1 阶段，必须如实标注）：目前只有**有界的 record-only 增量**
// 走直连车道，所以本文件证明的是"这条车道不踩 §14.1"。文档要求的其余场景
// （首次历史分页、删除-only、混合评分批次、大包分批）此刻仍走旧链路，
// 因此**必然**会踩 —— 它们的守卫随 PR2–PR6 逐条接上，不能据此认为整份 §14.1 已通过。
// 这也是为什么"旧候选路径会触发守卫"被写成了**通过的用例**而不是失败的用例：
// 它记录的正是尚未迁移的那一半。
//
// 用法：随 `npm test` 运行。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { dataOnlyBaselineContract } from "../src/data-only-import.js";
import type { ImportDatabaseTask } from "../src/import-database-tasks.js";

const project = resolve(import.meta.dirname, "../../..");
const uuid = "00000000-0000-0000-0000-00000000000a";

/**
 * `ImportDatabaseTask["operation"]` 的穷尽取值。用 `Record<..., true>` 而不是普通数组：
 * 少写一个键或多写一个键都会**编译不过**，守卫因此不会因为对端新增任务类型而静默失效。
 */
const databaseTaskOperations: Record<ImportDatabaseTask["operation"], true> = {
  verify: true, audit: true, checkpoint: true, "data-only": true, "direct-sync": true
};

interface Guard {
  counters: Map<string, number>;
  commands: string[][];
  databaseTaskCalls: string[];
  storeMethodCalls: string[];
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
    return originalTask.apply(worker, args);
  };

  return { counters, commands, databaseTaskCalls, storeMethodCalls };
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

async function fixture(run: (ctx: {
  root: string; main: string; input: string;
  make(enabled?: boolean): ImportWorker;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "rai-direct-sync-guard-"));
  const main = join(root, "main.sqlite");
  const input = join(root, "input");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), `<HealthData><Record type="HKQuantityTypeIdentifierStepCount"
    sourceName="Watch" unit="count" value="10" startDate="2026-01-01 00:00:00 +0000"
    endDate="2026-01-01 00:01:00 +0000"><MetadataEntry key="RAIHealthKitSampleUUID"
    value="${uuid}"/></Record></HealthData>`);
  writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
    version: 2, sourceScope: "healthkit", deletedSourceIds: [], deletedRecords: []
  }));
  const store = await RaiDatabase.open(main);
  store.setManifest("dataset_version", "baseline");
  store.setManifest("parser_contract_version", CONTRACT_VERSION);
  store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  store.setManifest("data_only_baseline_contract", dataOnlyBaselineContract());
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
  }

  // 🔴 在本车道上**结构性不可能被触发**的条目必须显式声明，且清单是写死的。
  // 不声明的真空是缺陷（守卫看起来在守、其实什么都没守）；声明的真空是待办项。
  // 把清单写死在这里，是为了让"新增一条真空条目"必须是一次**有意的**改动，
  // 而不是加一行清单就自动获得"已守"的假象。
  assert.deepEqual(
    PROHIBITED_DIRECT_SYNC_OPERATIONS.filter((operation) => (operation.vacuousOnDirectLane ?? null) !== null)
      .map((operation) => operation.id),
    ["canonical-nights-full-rebuild"],
    "直连车道上的真空条目清单变了：要么有人补上了通道（请从清单里删掉该条），" +
    "要么新增了一条在本车道上永远不报警的守卫（请说明原因，或补一个真能响的通道）"
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
      assert.deepEqual(guard.databaseTaskCalls, ["data-only"],
        "直连车道只允许投递 data-only 任务；verify/audit/checkpoint 都是禁止操作");
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

      // 🔴 行为级钉住"今天**没有**登记任何分析任务"（设计文档步骤 6b 的三步上线顺序）。
      // 本车道今天只接受 record-only 载荷，这类载荷**结构上不可能**触及分析，
      // 所以回执写 `analysisStatus: "not_required"` 是准确的；一旦有人在这里登记分析任务，
      // 他必须同批把 `deltaMode` 放开到 `"full"`、把回执改成 `"queued"`，
      // 并接上读侧一致性（PR5）—— 这几条判据会一起变红，不允许只落地一半。
      const probe = new DatabaseSync(main, { readOnly: true });
      try {
        assert.equal(Number(probe.prepare("SELECT COUNT(*) AS n FROM recompute_jobs").get()!.n), 0,
          "直连车道今天不得登记任何 recompute_jobs 任务（登记属 PR4 步骤 2，必须与 deltaMode 放开同批）");
      } finally { probe.close(); }
    } finally { await worker.close(); }
  });
});

test("A01/§14.1 阳性对照：旧候选路径确实会触发守卫，所以上一条的「全 0」不是假绿", async () => {
  await fixture(async ({ root, main, input, make }) => {
    const worker = make(false);
    const guard = installGuard(worker);
    const surface = worker as unknown as Surface;
    // 只拦住子进程：解析器要在真机上跑几十秒，而这条用例要证明的是"守卫看得见"，
    // 不是"旧链路能跑完"。拦在 CLI 之前，前面几步（备份、整库 copy、quick_check）全部真实发生。
    surface.command = (...args: unknown[]) => {
      guard.commands.push(args.map((value) => String(value)));
      throw new Error("fixture: legacy CLI stopped after the prohibited steps");
    };
    try {
      const job = worker.create(input);
      await wait(worker);
      assert.equal(worker.get(job.id)?.status, "failed");

      const triggered = triggeredOperations(guard, stagesOf(worker, job.id)).map((operation) => operation.id);
      for (const id of ["current-backup", "whole-database-copy", "full-database-quick-check"]) {
        assert.ok(triggered.includes(id),
          `阳性对照失效：旧候选路径没有触发 ${id}，守卫可能已经看不见它（实际触发：${triggered.join(", ") || "无"}）`);
      }
      // 与函数计数无关的独立证据：磁盘上真的出现了项目备份。
      assert.ok(readdirSync(join(root, "var")).includes("backups"),
        "旧候选路径应当留下 var/backups 目录 —— 这是它被守卫看到的另一条独立证据");
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
