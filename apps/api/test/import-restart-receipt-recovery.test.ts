// P3-03（R3）：重启恢复的三态回执读取。
//
// 缺陷：`loadJobs()` 过去用宽松 `readImportReceipt`，把“读不到”吞成“没有回执”。
// 重启时一个已经提交、但数据库暂时不可读的 queued/running 作业会被错误地按
// cancelRequested / attempts 政策判为 cancelled / failed / queued。
//
// 本套件只用真实 ImportWorker + RuntimeStateStore + 临时数据库，覆盖：
//   found（恢复原回执且不重复事实）、confirmed_absent（旧取消／重试政策不变）、
//   unreadable（恢复阻断，不发布猜测终态）、首次空库不阻断、外 scope 旧任务不变。

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION } from "@rai/contracts";
import type { ImportJobResponse } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";

import { ImportWorker, type ImportQueueOptions } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { RuntimeStateStore, type RuntimeImportJobRow } from "../src/runtime-state.js";
import {
  readImportReceipt, readImportReceiptForRecovery, writeImportReceipt
} from "../src/import-publication.js";

import { posixOnlyReason } from "./posix-only.js";

const project = resolve(import.meta.dirname, "../../..");

/** record-only 白名单记录 + 唯一 UUID ⇒ 每批都是不同载荷，避免 no-op 早退。 */
const recordOnlyXml = (index: number): string => `<HealthData><Record
    type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="10"
    startDate="2026-01-01 00:00:00 +0000" endDate="2026-01-01 00:0${index % 10}:00 +0000">
    <MetadataEntry key="RAIHealthKitSampleUUID"
      value="00000000-0000-0000-0000-0000000000${String(index).padStart(2, "0")}"/>
  </Record></HealthData>`;

const summary = {
  importMode: "incremental" as const, insertedWorkouts: 1, updatedWorkouts: 0, removedWorkouts: 0,
  unchangedWorkouts: 0, routesUpdated: 0, featuresReused: 0, featuresRecomputed: 1,
  modelReplayFrom: null, durationMs: 10, backupName: null
} satisfies NonNullable<ImportJobResponse["summary"]>;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function withTempRoot(
  prefix: string,
  run: (ctx: { root: string; main: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    await run({ root, main: join(root, "main.sqlite") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeWorker(
  root: string,
  main: string,
  scope: string,
  options: Partial<ImportQueueOptions> = {}
): ImportWorker {
  return new ImportWorker(main, project, root, undefined, undefined, undefined, {
    scope,
    admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import"),
    ...options
  });
}

/** 与 import-worker-reuse 相同：已初始化的基线库（后续走真实 record-only 导入）。 */
async function seedImportedDatabase(main: string): Promise<void> {
  const store = await RaiDatabase.open(main);
  store.setManifest("dataset_version", "baseline");
  store.setManifest("parser_contract_version", CONTRACT_VERSION);
  store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  store.close();
}

/** 可读但没有回执行的库：用于 confirmed_absent。 */
function seedReadableReceiptDatabase(main: string): void {
  const db = new DatabaseSync(main);
  try {
    db.exec("CREATE TABLE import_manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  } finally { db.close(); }
}

function writeInput(root: string, index: number): string {
  const input = join(root, `input-${index}`);
  mkdirSync(input, { recursive: true });
  writeFileSync(join(input, "export.xml"), recordOnlyXml(index));
  writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
    version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
  }));
  return input;
}

function restartJob(overrides: {
  id: string;
  inputPath: string;
  status: "queued" | "running";
  scope: string;
  attempts: number;
  cancelRequested?: boolean;
  /** 入队时主库缺失的持久证据；缺省模拟旧作业。 */
  databaseAbsentAtEnqueue?: boolean;
  /** 入队时作用域账本的首空代次；只有它 + 账本仍无写者才构成首次空库许可。 */
  firstEmptyEpoch?: number;
}): RuntimeImportJobRow {
  return {
    id: overrides.id,
    status: overrides.status,
    phase: overrides.status,
    message: "fixture restart job",
    createdAt: "2026-10-22T00:00:00.000Z",
    completedAt: null,
    error: null,
    inputPath: overrides.inputPath,
    // 与 create() 从 sync-manifest（sourceScope=healthkit）算出的值一致：
    // 缺省即删除的增量载荷，首次导入也必须能走正式车道。
    preserveAbsent: true,
    queue: {
      scope: overrides.scope,
      attempts: overrides.attempts,
      finalized: false,
      ...(overrides.cancelRequested === undefined ? {} : { cancelRequested: overrides.cancelRequested }),
      ...(overrides.databaseAbsentAtEnqueue === undefined
        ? {} : { databaseAbsentAtEnqueue: overrides.databaseAbsentAtEnqueue }),
      ...(overrides.firstEmptyEpoch === undefined ? {} : { firstEmptyEpoch: overrides.firstEmptyEpoch })
    }
  };
}

function storeJob(root: string, job: RuntimeImportJobRow): void {
  new RuntimeStateStore(root).upsertJob(job);
}

function healthRecordCount(main: string): number {
  const db = new DatabaseSync(main, { readOnly: true });
  try {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM health_records").get() as { n: number }).n);
  } finally { db.close(); }
}

async function waitForIdle(worker: ImportWorker, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (worker.hasPending || worker.isRunning) {
    assert.ok(Date.now() < deadline, `worker did not settle: ${JSON.stringify(worker.latest())}`);
    await sleep(10);
  }
}

async function runBatch(worker: ImportWorker, input: string, sourceId: string): Promise<ImportJobResponse> {
  const job = worker.create(input, undefined, sourceId);
  await waitForIdle(worker);
  return worker.get(job.id)!;
}

/**
 * 🔴 CI 2026-10-25（`windows-latest`）：本条红在"权限拒绝无法核实，不是不存在"这句断言上，
 * 实际拿到的是 `found`、期望 `unreadable` —— 因为 `chmodSync(denied, 0o000)` 在 Windows 上
 * **不阻止读取**：Windows 的访问控制靠 ACL，POSIX 的 mode 位只影响只读属性，进程照样能打开
 * 那个库。这条判据要证明的正是"存在但读不到 ⇒ unreadable，绝不能被当成『没有回执』"。
 *
 * 四态里的另外三态（found / confirmed_absent / missing，以及损坏库 / 零字节库 / 缺表的
 * unreadable 分支）不依赖权限位，仍然在 Windows 上运行；只有"权限拒绝"这一态在那里造不出来，
 * 因此这一条判据没有被检查。把这一条拆成"按平台构造不可读库"是另一个工作包。
 */
const PERMISSION_DENIED_ONLY = posixOnlyReason(
  "Windows 的 chmod 位不阻止读取（访问控制靠 ACL）：`chmodSync(file, 0o000)` 之后库仍可打开，"
  + "`readImportReceiptForRecovery` 返回 found 而不是 unreadable（CI 2026-10-25：found !== unreadable）。"
  + "四态判据里『存在但读不到 ⇒ unreadable，不得当成没有回执』这一态在 Windows 上造不出来，"
  + "因此没有被检查；按平台构造不可读库（ACL / 独占句柄）另立工单。"
);

test("helper 四态：found / confirmed_absent / missing / unreadable（缺失库不得自行确认不存在）", { skip: PERMISSION_DENIED_ONLY }, () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recovery-helper-"));
  try {
    const readable = join(root, "readable.sqlite");
    seedReadableReceiptDatabase(readable);
    assert.deepEqual(readImportReceiptForRecovery(readable, "job"), { state: "confirmed_absent" },
      "查询成功且没有回执行才是 confirmed_absent");

    writeImportReceipt(readable, "job", summary);
    assert.deepEqual(readImportReceiptForRecovery(readable, "job"), { state: "found", receipt: summary },
      "存在的有效回执必须原样返回");

    const malformed = join(root, "malformed.sqlite");
    seedReadableReceiptDatabase(malformed);
    const malformedDb = new DatabaseSync(malformed);
    try {
      malformedDb.prepare("INSERT INTO import_manifest (key, value) VALUES (?, ?)")
        .run("rai.applied-import.job", "{not json");
    } finally { malformedDb.close(); }
    const malformedOutcome = readImportReceiptForRecovery(malformed, "job");
    assert.equal(malformedOutcome.state, "unreadable");
    assert.ok(malformedOutcome.state === "unreadable" && malformedOutcome.error instanceof Error);

    const wrongShape = join(root, "wrong-shape.sqlite");
    seedReadableReceiptDatabase(wrongShape);
    const wrongShapeDb = new DatabaseSync(wrongShape);
    try {
      wrongShapeDb.prepare("INSERT INTO import_manifest (key, value) VALUES (?, ?)")
        .run("rai.applied-import.job", JSON.stringify({ importMode: "incremental" }));
    } finally { wrongShapeDb.close(); }
    assert.equal(readImportReceiptForRecovery(wrongShape, "job").state, "unreadable",
      "字段形状不合格的回执也是无法核实，不是不存在");

    const corrupt = join(root, "corrupt.sqlite");
    writeFileSync(corrupt, "this is not a sqlite database");
    const corruptOutcome = readImportReceiptForRecovery(corrupt, "job");
    assert.equal(corruptOutcome.state, "unreadable");
    assert.ok(corruptOutcome.state === "unreadable" && corruptOutcome.error instanceof Error);
    assert.ok(corruptOutcome.state === "unreadable" && corruptOutcome.error.message.length > 0);

    const zeroByte = join(root, "zero-byte.sqlite");
    writeFileSync(zeroByte, "");
    assert.equal(readImportReceiptForRecovery(zeroByte, "job").state, "unreadable",
      "存在但零字节的库无法核实，不是不存在");

    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      const denied = join(root, "permission-denied.sqlite");
      seedReadableReceiptDatabase(denied);
      writeImportReceipt(denied, "job", summary);
      chmodSync(denied, 0o000);
      try {
        assert.equal(readImportReceiptForRecovery(denied, "job").state, "unreadable",
          "权限拒绝无法核实，不是不存在");
      } finally {
        chmodSync(denied, 0o600);
      }
    }

    const noManifest = join(root, "no-manifest.sqlite");
    const noManifestDb = new DatabaseSync(noManifest);
    try { noManifestDb.exec("CREATE TABLE unrelated (id INTEGER)"); } finally { noManifestDb.close(); }
    assert.equal(readImportReceiptForRecovery(noManifest, "job").state, "unreadable",
      "存在但缺少 import_manifest 表属于无法核实");

    const missing = join(root, "missing.sqlite");
    const missingOutcome = readImportReceiptForRecovery(missing, "job");
    assert.equal(missingOutcome.state, "missing",
      "数据库文件不存在只报告 missing，不能自行确认没有回执");
    assert.ok(missingOutcome.state === "missing" && missingOutcome.error instanceof Error);
    assert.equal(existsSync(missing), false, "四态检查不得创建空数据库");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("已提交回执 + 持久 running：重启恢复 succeeded 原回执且不重复事实", { timeout: 60_000 }, async () => {
  await withTempRoot("rai-recovery-found-", async ({ root, main }) => {
    await seedImportedDatabase(main);
    const input = writeInput(root, 1);
    let first: ImportWorker | undefined;
    let recovered: ImportWorker | undefined;
    try {
      first = makeWorker(root, main, "recovery-found");
      const done = await runBatch(first, input, "recovery-found-source");
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      const persistedReceipt = readImportReceipt(main, done.id);
      assert.ok(persistedReceipt, "真实导入必须留下持久回执");
      assert.equal(healthRecordCount(main), 1);

      // 模拟“提交成功但父进程没来得及记录成功”：持久状态仍为 running。
      const state = new RuntimeStateStore(root);
      const stored = state.job(done.id);
      assert.ok(stored);
      state.upsertJob({
        ...stored!,
        status: "running",
        phase: "activate",
        message: "导入中",
        completedAt: null,
        error: null,
        summary: undefined,
        queue: { ...(stored!.queue ?? { scope: "recovery-found", attempts: 1 }), attempts: 0, finalized: false }
      });
      assert.equal(new RuntimeStateStore(root).job(done.id)?.status, "running");
      await first.close();
      first = undefined;

      recovered = makeWorker(root, main, "recovery-found");
      const restored = recovered.get(done.id);
      assert.equal(restored?.status, "succeeded", JSON.stringify(restored));
      assert.equal(restored?.phase, "completed");
      assert.equal(restored?.error, null);
      assert.deepEqual(restored?.summary, persistedReceipt,
        "必须原样返回持久回执，不能重新格式化或生成新值");
      assert.equal(healthRecordCount(main), 1, "恢复只读回执，不得重复写入事实");

      // queue 尚未 finalize：resume 只做既有终态收口，不能再跑一遍导入。
      recovered.resume();
      await waitForIdle(recovered);
      assert.equal(recovered.get(done.id)?.status, "succeeded");
      assert.equal(healthRecordCount(main), 1, "终态收口也不得重复事实");
      assert.equal(new RuntimeStateStore(root).job(done.id)?.queue?.finalized, true);
    } finally {
      await recovered?.close();
      await first?.close();
    }
  });
});

test("损坏数据库 + cancelRequested：恢复阻断而非 cancelled，且不清理来源", { timeout: 30_000 }, async () => {
  await withTempRoot("rai-recovery-cancel-", async ({ root, main }) => {
    writeFileSync(main, "this is not a sqlite database");
    const input = writeInput(root, 1);
    storeJob(root, restartJob({
      id: "blocked-cancel", inputPath: input, status: "running", scope: "recovery-block",
      attempts: 0, cancelRequested: true
    }));
    let recoveryCalls = 0;
    let terminalCalls = 0;
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, "recovery-block", {
        onRecoveryRequired: () => { recoveryCalls += 1; },
        onTerminal: () => { terminalCalls += 1; }
      });
      worker.resume();
      await sleep(0);
      const job = worker.get("blocked-cancel");
      assert.equal(job?.status, "running", `不得因 cancelRequested 猜测 cancelled：${JSON.stringify(job)}`);
      assert.equal(job?.phase, "recovery_required");
      assert.match(job?.message ?? "", /回执无法读取/);
      assert.equal(worker.hasPending, true);
      assert.equal(recoveryCalls, 1, "恢复阻断回调必须恰好一次");
      worker.resume();
      assert.equal(recoveryCalls, 1, "重复 resume 不得重复通知");
      assert.equal(terminalCalls, 0, "不得执行来源清理");

      const persisted = new RuntimeStateStore(root).job("blocked-cancel");
      assert.equal(persisted?.status, "running", "持久状态也不得发布 cancelled");
      assert.equal(persisted?.phase, "recovery_required");
      assert.equal(persisted?.queue?.finalized, false, "不得 finalize 队列");
    } finally {
      await worker?.close();
    }
  });
});

test("损坏数据库 + attempts=3：恢复阻断而非 failed", { timeout: 30_000 }, async () => {
  await withTempRoot("rai-recovery-attempts-", async ({ root, main }) => {
    writeFileSync(main, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const input = writeInput(root, 1);
    storeJob(root, restartJob({
      id: "blocked-attempts", inputPath: input, status: "running", scope: "recovery-block",
      attempts: 3
    }));
    let recoveryCalls = 0;
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, "recovery-block", {
        onRecoveryRequired: () => { recoveryCalls += 1; }
      });
      worker.resume();
      await sleep(0);
      const job = worker.get("blocked-attempts");
      assert.equal(job?.status, "running", `不得因 attempts 耗尽猜测 failed：${JSON.stringify(job)}`);
      assert.equal(job?.phase, "recovery_required");
      assert.equal(worker.hasPending, true);
      assert.equal(recoveryCalls, 1);

      const persisted = new RuntimeStateStore(root).job("blocked-attempts");
      assert.equal(persisted?.status, "running");
      assert.equal(persisted?.phase, "recovery_required");
      assert.equal(persisted?.queue?.finalized, false);
    } finally {
      await worker?.close();
    }
  });
});

test("onRecoveryRequired 异步兑现：兼容 server.ts 在 await 之后才声明的 let（TDZ）", { timeout: 30_000 }, async () => {
  await withTempRoot("rai-recovery-tdz-", async ({ root, main }) => {
    writeFileSync(main, "corrupt database for TDZ fixture");
    const input = writeInput(root, 1);
    storeJob(root, restartJob({
      id: "tdz-job", inputPath: input, status: "running", scope: "recovery-tdz", attempts: 0
    }));
    let recoveryCalls = 0;
    let observedLateFlag: boolean | undefined;
    let worker: ImportWorker | undefined;
    try {
      const constructLikeServer = async (): Promise<void> => {
        worker = makeWorker(root, main, "recovery-tdz", {
          onRecoveryRequired: () => {
            // 与 server.ts 相同：callback 读取在构造器之后、隔着 await 才声明的 let。
            // 构造期的微任务通知会撞 TDZ；必须保留 pending，等 resume() 再兑现。
            const lateFlag = databaseRecoveryRequired;
            observedLateFlag = lateFlag;
            recoveryCalls += 1;
          }
        });
        // 模拟 server.ts 构造器与 `let databaseRecoveryRequired` 之间的 await。
        await sleep(5);
        let databaseRecoveryRequired = true;
        return;
      };
      await constructLikeServer();
      assert.equal(recoveryCalls, 0, "构造器同步阶段不得调用通知，TDZ 尝试不得算作已通知");
      worker!.resume();
      await sleep(0);
      assert.equal(recoveryCalls, 1, "启动声明完成后必须恰好兑现一次");
      assert.equal(observedLateFlag, true, "通知必须读到已初始化的启动状态");
    } finally {
      await worker?.close();
    }
  });
});

test("可读数据库 + 无回执 + cancelRequested：confirmed_absent 仍按原政策取消", { timeout: 30_000 }, async () => {
  await withTempRoot("rai-recovery-absent-cancel-", async ({ root, main }) => {
    seedReadableReceiptDatabase(main);
    const input = writeInput(root, 1);
    storeJob(root, restartJob({
      id: "absent-cancel", inputPath: input, status: "running", scope: "recovery-absent",
      attempts: 0, cancelRequested: true
    }));
    let recoveryCalls = 0;
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, "recovery-absent", {
        onRecoveryRequired: () => { recoveryCalls += 1; }
      });
      await sleep(0);
      const job = worker.get("absent-cancel");
      assert.equal(job?.status, "cancelled", JSON.stringify(job));
      assert.equal(job?.phase, "cancelled");
      assert.equal(job?.error, null);
      assert.equal(recoveryCalls, 0, "确认不存在不触发恢复阻断");
    } finally {
      await worker?.close();
    }
  });
});

test("可读数据库 + 无回执 + attempts=3：confirmed_absent 仍按原政策判中断", { timeout: 30_000 }, async () => {
  await withTempRoot("rai-recovery-absent-attempts-", async ({ root, main }) => {
    seedReadableReceiptDatabase(main);
    const input = writeInput(root, 1);
    storeJob(root, restartJob({
      id: "absent-attempts", inputPath: input, status: "running", scope: "recovery-absent",
      attempts: 3
    }));
    let recoveryCalls = 0;
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, "recovery-absent", {
        onRecoveryRequired: () => { recoveryCalls += 1; }
      });
      await sleep(0);
      const job = worker.get("absent-attempts");
      assert.equal(job?.status, "failed", JSON.stringify(job));
      assert.equal(job?.phase, "interrupted");
      assert.equal(recoveryCalls, 0, "确认不存在不触发恢复阻断");
    } finally {
      await worker?.close();
    }
  });
});

test("首次空库（数据库文件不存在）+ queued attempts=0：不阻断，且能完成首批 record-only 导入", { timeout: 60_000 }, async () => {
  await withTempRoot("rai-recovery-first-", async ({ root, main }) => {
    const input = writeInput(root, 1);
    // 受控首次安装：只有显式初始化流程能写入 pristine 许可。
    const reservation = new RuntimeStateStore(root).establishPristineScope("recovery-first", "test_first_install");
    assert.equal(reservation.state, "pristine");
    storeJob(root, restartJob({
      id: "first-import", inputPath: input, status: "queued", scope: "recovery-first",
      attempts: 0, databaseAbsentAtEnqueue: true, firstEmptyEpoch: reservation.firstEmptyEpoch ?? 0
    }));
    assert.equal(existsSync(main), false);
    let recoveryCalls = 0;
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, "recovery-first", {
        onRecoveryRequired: () => { recoveryCalls += 1; }
      });
      await sleep(0);
      assert.equal(existsSync(main), false, "启动加载不得为了检查而创建空数据库");
      const loaded = worker.get("first-import");
      assert.equal(loaded?.status, "queued", JSON.stringify(loaded));
      assert.equal(loaded?.phase, "queued");
      assert.equal(recoveryCalls, 0, "首次空库不得被恢复阻断");
      assert.equal(worker.hasPending, true);

      worker.resume();
      await waitForIdle(worker);
      const done = worker.get("first-import");
      assert.equal(done?.status, "succeeded", JSON.stringify(done));
      assert.equal(done?.phase, "completed");
      assert.ok(readImportReceipt(main, "first-import"), "首批必须留下持久回执");
      assert.equal(healthRecordCount(main), 1, "首批 record 必须真实写入");
      assert.equal(recoveryCalls, 0);
    } finally {
      await worker?.close();
    }
  });
});

test("create 入队时把主库缺失写进持久队列证据", { timeout: 30_000 }, async () => {
  await withTempRoot("rai-recovery-enqueue-proof-", async ({ root, main }) => {
    const input = writeInput(root, 1);
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, "enqueue-proof");
      const state = new RuntimeStateStore(root);
      state.establishPristineScope("enqueue-proof", "test_first_install");
      const created = worker.create(input, undefined, "enqueue-proof-source");
      const stored = state.job(created.id);
      assert.equal(stored?.status, "queued");
      assert.equal(stored?.queue?.databaseAbsentAtEnqueue, true,
        "入队时主库不存在必须持久记录");
      assert.equal(stored?.queue?.firstEmptyEpoch, 1, "入队时必须持久记录作用域账本代次");
      const evidence = state.scopeEvidence("enqueue-proof");
      assert.equal(evidence?.state, "pristine");
      assert.equal(evidence?.firstEmptyEpoch, 1);
      assert.equal(evidence?.writerEnteredAt, null);
      assert.equal(evidence?.datasetEstablishedAt, null);
    } finally {
      await worker?.close();
    }
  });
});

test("只有任务自己的 databaseAbsentAtEnqueue、没有作用域账本：缺失库仍阻断", { timeout: 30_000 }, async () => {
  await withTempRoot("rai-recovery-missing-scope-proof-", async ({ root, main }) => {
    const input = writeInput(root, 1);
    // 模拟旧版本/被删掉账本的任务：per-job 标记为 true，但作用域账本不存在。
    storeJob(root, restartJob({
      id: "job-without-scope-proof", inputPath: input, status: "queued", scope: "recovery-scope-missing",
      attempts: 0, databaseAbsentAtEnqueue: true
    }));
    let recoveryCalls = 0;
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, "recovery-scope-missing", {
        onRecoveryRequired: () => { recoveryCalls += 1; }
      });
      worker.resume();
      await sleep(0);
      const job = worker.get("job-without-scope-proof");
      assert.equal(job?.status, "queued", JSON.stringify(job));
      assert.equal(job?.phase, "recovery_required");
      assert.match(job?.message ?? "", /主库暂时缺失/);
      assert.equal(recoveryCalls, 1, "无法证明作用域为空必须阻断并通知");
      assert.equal(existsSync(main), false, "阻断期间不得创建新空库");
      assert.equal(worker.hasPending, true);
    } finally {
      await worker?.close();
    }
  });
});

test("P1：A、B 双任务空库序列——A 成功后移走主库，B 不得运行/建库/清理来源，恢复后只提交一次", { timeout: 120_000 }, async () => {
  await withTempRoot("rai-recovery-first-empty-ab-", async ({ root, main }) => {
    const inputA = writeInput(root, 1);
    const inputB = writeInput(root, 2);
    const mutations = new MutationCoordinator();
    let release: (() => void) | null = mutations.acquire("test-hold");
    const firstAdmission = new TaskAdmissionScheduler(mutations).owner("import");
    let worker: ImportWorker | undefined;
    let blocked: ImportWorker | undefined;
    let recovered: ImportWorker | undefined;
    try {
      new RuntimeStateStore(root).establishPristineScope("recovery-ab", "test_first_install");
      worker = makeWorker(root, main, "recovery-ab", { admission: firstAdmission });
      const a = worker.create(inputA, undefined, "recovery-ab-source-a");
      const b = worker.create(inputB, undefined, "recovery-ab-source-b");
      const state = new RuntimeStateStore(root);
      assert.equal(state.job(a.id)?.queue?.firstEmptyEpoch, 1, "A 必须持有作用域首空代次");
      assert.equal(state.job(b.id)?.queue?.firstEmptyEpoch, 1, "B 必须持有同一作用域首空代次");
      assert.equal(existsSync(main), false);

      release();
      release = null;
      const aDeadline = Date.now() + 60_000;
      while (worker.get(a.id)?.status !== "succeeded") {
        assert.ok(Date.now() < aDeadline, `A 未成功：${JSON.stringify(worker.get(a.id))}`);
        await sleep(10);
      }
      // A 成功后、B 的 250ms 重试之前重新握住写者许可。
      release = mutations.acquire("test-hold");
      await sleep(50);
      assert.equal(worker.get(b.id)?.status, "queued", "B 必须仍排在队列里，尚未运行");
      const healthAfterA = healthRecordCount(main);
      assert.equal(healthAfterA, 1, "A 必须恰好提交一次");
      await worker.close();
      worker = undefined;

      // 主库被暂时移走：B 自己的入队标记仍为 true，但作用域账本已记录 A 的写者进入。
      const moved = join(root, "main.sqlite.moved");
      renameSync(main, moved);
      let recoveryCalls = 0;
      blocked = makeWorker(root, main, "recovery-ab", {
        admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import"),
        onRecoveryRequired: () => { recoveryCalls += 1; }
      });
      blocked.resume();
      await sleep(0);
      const blockedJob = blocked.get(b.id);
      assert.equal(blockedJob?.status, "queued", JSON.stringify(blockedJob));
      assert.equal(blockedJob?.phase, "recovery_required", "B 必须进入恢复阻断，而不是被当成首次空库");
      assert.equal(recoveryCalls, 1, "恢复阻断必须通知一次");
      assert.equal(existsSync(main), false, "阻断期间不得创建新空库");
      assert.equal(existsSync(join(inputB, "export.xml")), true, "阻断期间不得清理来源");
      assert.equal(blocked.hasPending, true);
      await blocked.close();
      blocked = undefined;

      // 恢复原库：B 才能按原数据继续，并且只提交一次。
      renameSync(moved, main);
      recovered = makeWorker(root, main, "recovery-ab", {
        admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
      });
      recovered.resume();
      await waitForIdle(recovered);
      const done = recovered.get(b.id);
      assert.equal(done?.status, "succeeded", JSON.stringify(done));
      assert.equal(done?.phase, "completed");
      assert.ok(readImportReceipt(main, b.id), "B 必须留下恰好一份持久回执");
      assert.equal(healthRecordCount(main), 2, "A/B 各一条记录，B 不得重复提交");
      const receiptCount = (() => {
        const db = new DatabaseSync(main, { readOnly: true });
        try {
          return Number((db.prepare(
            "SELECT COUNT(*) AS n FROM import_manifest WHERE key LIKE 'rai.applied-import.%'"
          ).get() as { n: number }).n);
        } finally { db.close(); }
      })();
      assert.equal(receiptCount, 2, "A/B 各一份回执，恢复不得产生第二份");
    } finally {
      release?.();
      await worker?.close();
      await blocked?.close();
      await recovered?.close();
    }
  });
});

test("缺失库 + attempts=0 但没有入队时空库证据：恢复阻断，不按首次空库放行", { timeout: 30_000 }, async () => {
  await withTempRoot("rai-recovery-missing-no-proof-", async ({ root, main }) => {
    const input = writeInput(root, 1);
    // 模拟旧作业：没有 databaseAbsentAtEnqueue 这条持久证据。即使 attempts=0，
    // 也不能证明“入队时主库不存在、且从未进入可提交的 worker”。
    storeJob(root, restartJob({
      id: "old-job-missing", inputPath: input, status: "queued", scope: "recovery-missing", attempts: 0
    }));
    let recoveryCalls = 0;
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, "recovery-missing", {
        onRecoveryRequired: () => { recoveryCalls += 1; }
      });
      worker.resume();
      await sleep(0);
      const job = worker.get("old-job-missing");
      assert.equal(job?.status, "queued", JSON.stringify(job));
      assert.equal(job?.phase, "recovery_required");
      assert.match(job?.message ?? "", /主库暂时缺失/);
      assert.equal(recoveryCalls, 1, "缺失且无证据必须触发恢复阻断通知");
      assert.equal(worker.hasPending, true);
      assert.equal(existsSync(main), false, "检查过程不得创建空库");

      const persisted = new RuntimeStateStore(root).job("old-job-missing");
      assert.equal(persisted?.phase, "recovery_required");
      assert.equal(persisted?.queue?.finalized, false);
    } finally {
      await worker?.close();
    }
  });
});

test("已提交 + 重启时主库暂时缺失 + cancelRequested：阻断而非 cancelled；恢复后返回原回执", { timeout: 60_000 }, async () => {
  await withTempRoot("rai-recovery-missing-committed-", async ({ root, main }) => {
    await seedImportedDatabase(main);
    const input = writeInput(root, 1);
    let first: ImportWorker | undefined;
    let blocked: ImportWorker | undefined;
    let recovered: ImportWorker | undefined;
    const parked = join(root, "main.parked.sqlite");
    const moveDatabase = (from: string, to: string): void => {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(`${from}${suffix}`)) renameSync(`${from}${suffix}`, `${to}${suffix}`);
      }
    };
    try {
      first = makeWorker(root, main, "recovery-missing-committed");
      const done = await runBatch(first, input, "committed-source");
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      const receipt = readImportReceipt(main, done.id);
      assert.ok(receipt);
      const factsBefore = healthRecordCount(main);

      // 模拟“已提交、但父进程没来得及记录终态”：持久状态仍是 running，且
      // cancelRequested=true、attempts=1。旧实现会把缺失库当成没有回执并发布 cancelled。
      const stored = new RuntimeStateStore(root).job(done.id);
      assert.ok(stored);
      new RuntimeStateStore(root).upsertJob({
        ...stored!,
        status: "running",
        phase: "commit",
        message: "提交中",
        completedAt: null,
        error: null,
        summary: undefined,
        queue: { ...(stored!.queue ?? { scope: "recovery-missing-committed", attempts: 1 }), attempts: 1, finalized: false, cancelRequested: true }
      });
      await first.close();
      first = undefined;

      moveDatabase(main, parked);
      let recoveryCalls = 0;
      let terminalCalls = 0;
      blocked = makeWorker(root, main, "recovery-missing-committed", {
        onRecoveryRequired: () => { recoveryCalls += 1; },
        onTerminal: () => { terminalCalls += 1; }
      });
      blocked.resume();
      await sleep(0);
      const blockedJob = blocked.get(done.id);
      assert.equal(blockedJob?.status, "running",
        `缺失库不得被猜成 cancelled/failed：${JSON.stringify(blockedJob)}`);
      assert.equal(blockedJob?.phase, "recovery_required");
      assert.match(blockedJob?.message ?? "", /主库暂时缺失/);
      assert.equal(recoveryCalls, 1);
      assert.equal(terminalCalls, 0, "不得发布终态或清理来源");
      assert.equal(blocked.hasPending, true);
      assert.equal(new RuntimeStateStore(root).job(done.id)?.queue?.finalized, false);

      // 主库恢复可读：新 worker 必须重新查原回执并恢复成功，不重复事实。
      moveDatabase(parked, main);
      await blocked.close();
      blocked = undefined;
      recovered = makeWorker(root, main, "recovery-missing-committed");
      const restored = recovered.get(done.id);
      assert.equal(restored?.status, "succeeded", JSON.stringify(restored));
      assert.deepEqual(restored?.summary, receipt, "必须返回原持久回执");
      assert.equal(healthRecordCount(main), factsBefore, "恢复不得重复写入事实");
      recovered.resume();
      await waitForIdle(recovered);
      assert.equal(healthRecordCount(main), factsBefore);
    } finally {
      await recovered?.close();
      await blocked?.close();
      await first?.close();
    }
  });
});

test("外 scope 旧任务 + 数据库不可读：仍走旧终态并 finalize 自己的 scope，不阻断当前 scope", { timeout: 30_000 }, async () => {
  await withTempRoot("rai-recovery-out-of-scope-", async ({ root, main }) => {
    writeFileSync(main, "corrupt bytes for out-of-scope test");
    const input = writeInput(root, 1);
    storeJob(root, restartJob({
      id: "old-scope-job", inputPath: input, status: "running", scope: "old-scope", attempts: 0
    }));
    let recoveryCalls = 0;
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, "current-scope", {
        onRecoveryRequired: () => { recoveryCalls += 1; }
      });
      await sleep(0);
      const job = worker.get("old-scope-job");
      assert.equal(job?.status, "failed", JSON.stringify(job));
      assert.equal(job?.phase, "interrupted");
      assert.equal(recoveryCalls, 0, "外 scope 旧任务不得触发当前 scope 的恢复阻断");
      assert.equal(worker.hasPending, false, "外 scope 旧任务收口后不得留在 pending");

      const persisted = new RuntimeStateStore(root).job("old-scope-job");
      assert.equal(persisted?.status, "failed");
      assert.equal(persisted?.phase, "interrupted");
      assert.equal(persisted?.queue?.finalized, true, "外 scope 旧任务保持原 scope 收口行为");
    } finally {
      await worker?.close();
    }
  });
});
