// P1 复审（2026-10-22）：作用域级首空证据的状态机、启动登记与恢复阻断。
//
// 本套件只使用真实的 `RuntimeStateStore`、真实 `ImportWorker`（含真实 ingest 线程）
// 与临时 SQLite 文件；不 mock 状态转移。覆盖方案 §1.3 的八类路径：
//   1. 旧库升级：启动登记 established，账本迁移不补写 pristine；
//   2. 旧库在首次登记前暂时缺失：unknown，不建库，恢复后收敛；
//   3. 启动后旧库消失：established，attempts=0 也不放行；
//   4. 账本损坏/隔离重建：新账本 unknown，不因无行重建空库；
//   5. A/B 排队序列在 `import-restart-receipt-recovery.test.ts`（同套件 G7）；
//   6. 真正首次安装：受控 pristine 许可 + 首批建 v47 库 + 第二包按已有库；
//   7. 证据持久化失败：不写主库、不发布终态、来源保留；
//   8. 显式删除/恢复：旧 scope 许可不复活，新 scope 只按显式初始化规则。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION } from "@rai/contracts";
import type { ImportJobResponse } from "@rai/api-contracts";
import { identityAlgorithmFingerprint, parseAppleHealthXml } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

import { ImportWorker, type ImportQueueOptions } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { readImportReceipt } from "../src/import-publication.js";

const project = join(import.meta.dirname, "../../..");
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const recordOnlyXml = (index: number): string => `<HealthData><Record
    type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="${10 + (index % 50)}"
    startDate="2026-01-01 00:00:00 +0000" endDate="2026-01-01 00:0${index % 10}:00 +0000">
    <MetadataEntry key="RAIHealthKitSampleUUID"
      value="00000000-0000-0000-0000-0000000000${String(index).padStart(2, "0")}"/>
  </Record></HealthData>`;

async function withRoot(
  prefix: string,
  run: (ctx: { root: string; main: string; runtime: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const main = join(root, "main.sqlite");
  const runtime = join(root, "var/runtime.sqlite");
  try { await run({ root, main, runtime }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function makeWorker(root: string, main: string, scope: string, options: Partial<ImportQueueOptions> = {}): ImportWorker {
  return new ImportWorker(main, project, root, undefined, undefined, undefined, {
    scope,
    admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import"),
    ...options
  });
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

/** 真实 v47 库 + 基线身份；用于“旧库已被观察”的路径。 */
async function seedDatabase(main: string): Promise<void> {
  const store = await RaiDatabase.open(main);
  try {
    store.setManifest("dataset_version", "baseline");
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
    store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  } finally { store.close(); }
}

/** 旧库里有事实：先真实解析一条 record-only XML。 */
async function seedFact(main: string, root: string, index = 90): Promise<void> {
  const store = await RaiDatabase.open(main);
  try {
    store.setManifest("dataset_version", "baseline");
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
    store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
    const path = join(root, `seed-${index}.xml`);
    writeFileSync(path, recordOnlyXml(index));
    await parseAppleHealthXml(path, store, { fileSize: 1, healthKitRecordIdentity: true });
  } finally { store.close(); }
}

function healthRecordCount(main: string): number {
  const db = new DatabaseSync(main, { readOnly: true });
  try { return Number((db.prepare("SELECT COUNT(*) AS n FROM health_records").get() as { n: number }).n); }
  finally { db.close(); }
}

function schemaVersion(main: string): number {
  const db = new DatabaseSync(main, { readOnly: true });
  try { return Number((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v); }
  finally { db.close(); }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `等待「${what}」超时`);
    await sleep(10);
  }
}

async function waitForIdle(worker: ImportWorker): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (worker.hasPending || worker.isRunning) {
    assert.ok(Date.now() < deadline, `worker 未结算：${JSON.stringify(worker.latest())}`);
    await sleep(10);
  }
}

async function runJob(worker: ImportWorker, input: string, sourceId: string): Promise<ImportJobResponse> {
  const job = worker.create(input, undefined, sourceId);
  await waitForIdle(worker);
  return worker.get(job.id)!;
}

test("P1-1 旧库升级：启动登记 established；旧账本空行迁移为 unknown 而不是 pristine", { timeout: 60_000 }, async () => {
  await withRoot("rai-scope-upgrade-", async ({ root, main, runtime }) => {
    await seedDatabase(main);
    const beforeHash = createHash("sha256").update(readFileSync(main)).digest("hex");
    // 模拟复审前的旧 runtime.sqlite：表已存在，但只有“入队即写”的 first_empty_epoch=1。
    mkdirSync(join(root, "var"), { recursive: true });
    const legacy = new DatabaseSync(runtime);
    legacy.exec(`CREATE TABLE import_scope_evidence (
      scope TEXT PRIMARY KEY, first_empty_epoch INTEGER NOT NULL,
      writer_entered_at TEXT, dataset_established_at TEXT)`);
    legacy.prepare("INSERT INTO import_scope_evidence VALUES (?, 1, NULL, NULL)").run("upgrade");
    legacy.close();

    const store = new RuntimeStateStore(root);
    assert.equal(store.firstEmptyPermit("upgrade"), null,
      "旧版自动写入的空行不是可信首空许可，迁移后必须为 unknown");
    assert.equal(store.scopeEvidence("upgrade")?.state, "unknown");
    // 旧表 `first_empty_epoch` 是 NOT NULL：未知 scope 的新状态转移也必须能落库。
    assert.equal(store.markScopeWriterEntered("upgrade-new-scope", "2026-10-22T00:00:00.000Z").state, "writer_entered");

    const evidence = store.registerStartupDatabaseObservation("upgrade", main);
    assert.equal(evidence.state, "established");
    assert.equal(evidence.datasetEstablishedAt !== null, true);
    assert.equal(store.firstEmptyPermit("upgrade"), null);
    assert.equal(createHash("sha256").update(readFileSync(main)).digest("hex"), beforeHash,
      "启动登记只写 runtime 账本，不得改动主库");
    assert.equal(healthRecordCount(main), 0);
    // 显式“主库不可读”观察：置 unknown 阻断自动建库，但保留已建立的诊断时间戳。
    const unreadable = store.markScopeDatabaseUnreadable("upgrade", "2026-10-22T00:00:01.000Z", "fixture unreadable");
    assert.equal(unreadable.state, "unknown");
    assert.notEqual(unreadable.datasetEstablishedAt, null);
    assert.equal(store.firstEmptyPermit("upgrade"), null);
    assert.equal(new RuntimeStateStore(root).scopeEvidence("upgrade")?.state, "unknown",
      "当前格式的账本再次初始化不得把恢复阻断升回 established");
  });
});

test("P1-2 旧库在首次登记前暂时缺失：unknown 阻断，恢复原库后按真实状态收敛且只提交一次", { timeout: 120_000 }, async () => {
  await withRoot("rai-scope-missing-before-register-", async ({ root, main }) => {
    await seedFact(main, root, 91);
    const moved = `${main}.moved`;
    renameSync(main, moved);
    const scope = "missing-before-register";
    const store = new RuntimeStateStore(root);
    assert.equal(store.registerStartupDatabaseObservation(scope, main).state, "unknown");
    assert.equal(store.firstEmptyPermit(scope), null);

    const input = writeInput(root, 1);
    let worker: ImportWorker | undefined;
    let recoveryCalls = 0;
    try {
      worker = makeWorker(root, main, scope, { onRecoveryRequired: () => { recoveryCalls += 1; } });
      const job = worker.create(input, undefined, "missing-before-register-source");
      await waitFor(() => worker!.get(job.id)?.phase === "recovery_required", "恢复阻断");
      const blocked = worker.get(job.id)!;
      assert.equal(blocked.status, "running");
      assert.equal(blocked.phase, "recovery_required");
      assert.equal(recoveryCalls, 1);
      assert.equal(existsSync(main), false, "不得创建新空库");
      assert.equal(existsSync(join(input, "export.xml")), true, "不得清理上传来源");
      assert.equal(readImportReceipt(main, job.id), null);
      await worker.close();
      worker = undefined;

      renameSync(moved, main);
      assert.equal(new RuntimeStateStore(root).registerStartupDatabaseObservation(scope, main).state, "established");
      worker = makeWorker(root, main, scope);
      worker.resume();
      await waitForIdle(worker);
      const done = worker.get(job.id)!;
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      assert.ok(readImportReceipt(main, job.id), "恢复原库后必须按原任务提交一次");
      assert.equal(healthRecordCount(main), 2, "原有事实 + 本批一条，恰好一次");
    } finally { await worker?.close(); }
  });
});

test("P1-3 启动后旧库消失：已登记 established，新作业 attempts=0 也不得被当成首次空库", { timeout: 60_000 }, async () => {
  await withRoot("rai-scope-disappears-after-start-", async ({ root, main }) => {
    await seedDatabase(main);
    const scope = "disappears-after-start";
    const store = new RuntimeStateStore(root);
    assert.equal(store.registerStartupDatabaseObservation(scope, main).state, "established");
    renameSync(main, `${main}.moved`);
    const input = writeInput(root, 1);
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, scope);
      const job = worker.create(input, undefined, "disappears-source");
      await waitFor(() => worker!.get(job.id)?.phase === "recovery_required", "恢复阻断");
      assert.equal(worker.get(job.id)?.status, "running");
      assert.equal(existsSync(main), false);
      assert.equal(readImportReceipt(main, job.id), null);
    } finally { await worker?.close(); }
  });
});

test("P1-4 账本损坏/隔离重建：新账本 unknown，不因“无行”重建空库；恢复后收敛", { timeout: 120_000 }, async () => {
  await withRoot("rai-scope-ledger-corrupt-", async ({ root, main, runtime }) => {
    await seedFact(main, root, 92);
    const scope = "ledger-corrupt";
    new RuntimeStateStore(root).registerStartupDatabaseObservation(scope, main);
    writeFileSync(runtime, "this is not a sqlite database");
    const moved = `${main}.moved`;
    renameSync(main, moved);

    // 构造器按既有保护隔离损坏账本并重建空库；空账本 = unknown。
    const recreated = new RuntimeStateStore(root);
    assert.equal(recreated.scopeEvidence(scope), null);
    assert.equal(recreated.registerStartupDatabaseObservation(scope, main).state, "unknown");
    const quarantined = readdirSync(join(root, "var")).filter((name) => name.startsWith("runtime.sqlite.corrupt-"));
    assert.ok(quarantined.length > 0, "损坏账本必须被隔离，而不是静默重建后继续使用旧证据");

    const input = writeInput(root, 1);
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, scope);
      const job = worker.create(input, undefined, "ledger-corrupt-source");
      await waitFor(() => worker!.get(job.id)?.phase === "recovery_required", "恢复阻断");
      assert.equal(existsSync(main), false, "隔离重建后的空账本不得放行首包建库");
      await worker.close();
      worker = undefined;

      renameSync(moved, main);
      new RuntimeStateStore(root).registerStartupDatabaseObservation(scope, main);
      worker = makeWorker(root, main, scope);
      worker.resume();
      await waitForIdle(worker);
      assert.equal(worker.get(job.id)?.status, "succeeded", JSON.stringify(worker.get(job.id)));
      assert.equal(healthRecordCount(main), 2);
    } finally { await worker?.close(); }
  });
});

test("P1-6 真正首次安装：受控 pristine 许可放行首批 v47 建库，许可在写者进入后永久失效", { timeout: 120_000 }, async () => {
  await withRoot("rai-scope-first-install-", async ({ root, main }) => {
    const scope = "first-install";
    const state = new RuntimeStateStore(root);
    const permit = state.establishPristineScope(scope, "test_first_install");
    assert.equal(permit.state, "pristine");
    let worker: ImportWorker | undefined;
    try {
      worker = makeWorker(root, main, scope);
      const firstInput = writeInput(root, 1);
      const first = worker.create(firstInput, undefined, "first-install-source-1");
      assert.equal(new RuntimeStateStore(root).job(first.id)?.queue?.firstEmptyEpoch, 1,
        "首批必须持有作用域许可代次");
      await waitForIdle(worker);
      assert.equal(worker.get(first.id)?.status, "succeeded", JSON.stringify(worker.get(first.id)));
      assert.equal(existsSync(main), true, "受控首包必须创建主库");
      assert.equal(schemaVersion(main), 47);
      assert.ok(readImportReceipt(main, first.id));
      assert.equal(healthRecordCount(main), 1);

      const afterFirst = new RuntimeStateStore(root).scopeEvidence(scope)!;
      assert.equal(afterFirst.state, "established");
      assert.notEqual(afterFirst.permitRevokedAt, null, "写者进入后许可必须持久失效");

      // 第二包按已有库处理：即使再出现“入队时文件不在”也不能复活旧许可。
      const second = await runJob(worker, writeInput(root, 2), "first-install-source-2");
      assert.equal(second.status, "succeeded", JSON.stringify(second));
      assert.equal(healthRecordCount(main), 2);
      assert.equal(new RuntimeStateStore(root).scopeEvidence(scope)?.state, "established");
    } finally { await worker?.close(); }
  });
});

test("P1-7 进入 writer_entered 前账本写失败：不写主库、不发布终态、来源保留", { timeout: 60_000 }, async () => {
  await withRoot("rai-scope-write-failure-", async ({ root, main, runtime }) => {
    await seedDatabase(main);
    // P2-1 分界：本用例守的是“尚无安全证据的 scope”在写者屏障失败时必须阻断。
    // established 作用域的诊断写失败由下一条 P2-1 用例覆盖，二者不能混为一谈。
    const scope = "write-failure";
    new RuntimeStateStore(root);
    const runtimeDb = new DatabaseSync(runtime);
    runtimeDb.exec(`CREATE TRIGGER fail_scope_writer BEFORE UPDATE ON import_scope_evidence
      BEGIN SELECT RAISE(ABORT, 'fixture scope evidence write failure'); END`);
    runtimeDb.close();

    const input = writeInput(root, 1);
    let worker: ImportWorker | undefined;
    let recoveryCalls = 0;
    try {
      worker = makeWorker(root, main, scope, { onRecoveryRequired: () => { recoveryCalls += 1; } });
      const job = worker.create(input, undefined, "write-failure-source");
      await waitFor(() => worker!.get(job.id)?.phase === "recovery_required", "恢复阻断");
      const blocked = worker.get(job.id)!;
      assert.equal(blocked.status, "running", "不得发布失败/成功终态");
      assert.equal(blocked.phase, "recovery_required");
      assert.match(blocked.message, /作用域证据|recovery|恢复/i);
      assert.equal(recoveryCalls, 1);
      assert.equal(healthRecordCount(main), 0, "不得创建/修改主库");
      assert.equal(readImportReceipt(main, job.id), null);
      assert.equal(existsSync(join(input, "export.xml")), true, "不得清理上传来源");
      assert.equal(worker.hasPending, true, "恢复阻断必须继续挡住写者");
    } finally { await worker?.close(); }
  });
});

test("P1-8 显式删除/恢复：旧 scope 许可不复活，新 scope 只按显式初始化放行", { timeout: 30_000 }, async () => {
  await withRoot("rai-scope-epoch-", async ({ root }) => {
    const store = new RuntimeStateStore(root);
    const oldScope = JSON.stringify(["local", "athlete_1", "old"]);
    const newScope = JSON.stringify(["local", "athlete_1", "new"]);
    store.establishPristineScope(oldScope, "explicit_database_delete");
    store.markScopeWriterEntered(oldScope, "2026-10-22T00:00:01.000Z");
    store.markScopeDatasetEstablished(oldScope, "2026-10-22T00:00:02.000Z");
    assert.equal(store.firstEmptyPermit(oldScope), null);

    // 显式删除成功 → 新 epoch/scope 获得一次 pristine 许可。
    store.establishPristineScope(newScope, "explicit_database_delete");
    assert.notEqual(store.firstEmptyPermit(newScope), null);
    assert.equal(store.firstEmptyPermit(oldScope), null, "旧 scope 不得因 epoch 切换复活");
    assert.equal(store.scopeEvidence(oldScope)?.state, "established");

    // 恢复旧库 → 新 scope 登记 established，许可失效；旧 scope 仍保持原样。
    store.markScopeDatasetEstablished(newScope, "2026-10-22T00:00:03.000Z");
    assert.equal(store.firstEmptyPermit(newScope), null);
    assert.equal(store.scopeEvidence(newScope)?.state, "established");
    assert.equal(store.scopeEvidence(oldScope)?.state, "established");
  });
});

// ---------------------------------------------------------------------------
// P2-1（2026-10-23 复审）：established 只能来自可读结构；诊断写失败不误阻断
// ---------------------------------------------------------------------------

test("P2-1 零字节/损坏主库不得登记 established", { timeout: 30_000 }, async () => {
  await withRoot("rai-scope-zero-byte-", async ({ root, main }) => {
    const scope = JSON.stringify(["local", "athlete_1", "default"]);
    const store = new RuntimeStateStore(root);
    writeFileSync(main, "");
    const observation = store.registerStartupDatabaseObservation(scope, main);
    assert.equal(observation.state, "unknown", "零字节文件不是数据集");
    assert.equal(store.scopeEvidence(scope)?.state, "unknown");
    writeFileSync(main, "definitely not sqlite");
    assert.equal(store.registerStartupDatabaseObservation(scope, main).state, "unknown");
  });
});

test("P2-1 已 established 的作用域：诊断写失败不阻断 data-only 导入", { timeout: 120_000 }, async () => {
  await withRoot("rai-scope-diagnostic-write-", async ({ root, main, runtime }) => {
    await seedDatabase(main);
    const scope = JSON.stringify(["local", "athlete_1", "default"]);
    const store = new RuntimeStateStore(root);
    store.markScopeDatasetEstablished(scope, "2026-10-22T00:00:00.000Z");
    // Reads still work; every write to the scope ledger now fails.
    const db = new DatabaseSync(runtime);
    try {
      db.exec(`CREATE TRIGGER fail_scope_insert BEFORE INSERT ON import_scope_evidence
        BEGIN SELECT RAISE(ABORT, 'fixture diagnostic write failure'); END;
        CREATE TRIGGER fail_scope_update BEFORE UPDATE ON import_scope_evidence
        BEGIN SELECT RAISE(ABORT, 'fixture diagnostic write failure'); END;`);
    } finally { db.close(); }
    const worker = makeWorker(root, main, scope, { dataOnlyFastPath: true });
    try {
      const job = await runJob(worker, writeInput(root, 1), "diagnostic-write-source");
      assert.equal(job.status, "succeeded", JSON.stringify(job));
      assert.equal(job.phase, "completed");
      assert.equal(store.scopeEvidence(scope)?.state, "established",
        "诊断写失败不得把既有 established 证据降级");
    } finally { await worker.close(); }
  });
});

test("放弃操作按旧 scope 唯一：重复调用复用同一 epoch，冲突历史拒绝迁移", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-scope-abandon-unique-"));
  try {
    const scope = JSON.stringify(["local", "athlete_1", "default"]);
    const store = new RuntimeStateStore(root);
    const at = "2026-10-23T00:00:00.000Z";
    store.establishPristineScope(scope, "fixture_first_install", at);
    store.markScopeWriterEntered(scope, at);
    const first = store.abandonWriterEnteredScope({
      oldScope: scope, oldEpoch: "default", operator: "operator", reason: "fixture", at
    });
    assert.equal(first.replayed, false);
    const second = store.abandonWriterEnteredScope({
      oldScope: scope, oldEpoch: "default", operator: "operator", reason: "fixture", at
    });
    assert.equal(second.replayed, true);
    assert.equal(second.abandonment.newEpoch, first.abandonment.newEpoch, "重试必须复用同一 new epoch");
    assert.equal(store.abandonmentFor(scope)?.newEpoch, first.abandonment.newEpoch);

    let rows = 0;
    const db = new DatabaseSync(store.path, { readOnly: true });
    try {
      rows = (db.prepare("SELECT COUNT(*) AS count FROM scope_abandonments WHERE old_scope=?").get(scope) as
        { count: number }).count;
    } finally { db.close(); }
    assert.equal(rows, 1);

    assert.throws(() => store.abandonWriterEnteredScope({
      oldScope: scope, oldEpoch: "default", operator: "operator", reason: "different reason", at
    }), /incompatible|manual review/i);

    // Simulate legacy duplicate history: the constructor must refuse to migrate
    // instead of silently choosing one row.
    const duplicate = new DatabaseSync(store.path);
    try {
      duplicate.exec("DROP INDEX IF EXISTS idx_scope_abandonments_old_unique");
      duplicate.prepare(`INSERT INTO scope_abandonments
        (id, old_scope, new_scope, old_epoch, new_epoch, operator, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "second-operation", scope, JSON.stringify(["local", "athlete_1", "other"]),
        "default", "other", "operator", "fixture", at);
    } finally { duplicate.close(); }
    assert.throws(() => new RuntimeStateStore(root), /duplicate scope_abandonments|manual review/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P1-9 abandoned 是终态：启动观察或迟到的导入不得复活旧 scope", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-scope-abandon-terminal-"));
  try {
    const scope = JSON.stringify(["local", "athlete_1", "default"]);
    const at = "2026-10-23T00:00:00.000Z";
    const store = new RuntimeStateStore(root);
    store.establishPristineScope(scope, "fixture_first_install", at);
    store.markScopeWriterEntered(scope, at);
    const result = store.abandonWriterEnteredScope({
      oldScope: scope, oldEpoch: "default", operator: "operator", reason: "fixture", at
    });
    assert.equal(store.scopeEvidence(scope)?.state, "abandoned");
    const observed = store.registerStartupDatabaseObservation(scope, join(root, "main.sqlite"));
    assert.equal(observed.state, "abandoned", "startup observation must not re-establish the abandoned scope");
    assert.throws(() => store.markScopeDatasetEstablished(scope, at), /abandoned/i);
    assert.throws(() => store.markScopeWriterEntered(scope, at), /abandoned/i);
    assert.equal(store.scopeEvidence(scope)?.state, "abandoned");
    assert.equal(store.abandonmentFor(scope)?.newEpoch, result.abandonment.newEpoch);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
