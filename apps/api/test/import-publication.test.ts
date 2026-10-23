import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ImportPublicationJournal, readImportReceipt, readImportReceiptStrict, writeImportReceipt } from "../src/import-publication.js";
import { ImportWorker } from "../src/import-worker.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";

const summary = {
  importMode: "incremental" as const, insertedWorkouts: 1, updatedWorkouts: 0, removedWorkouts: 0,
  unchangedWorkouts: 0, routesUpdated: 0, featuresReused: 0, featuresRecomputed: 1,
  modelReplayFrom: null, durationMs: 10, backupName: null
};
function database(path: string, marker: string) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE import_manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO import_manifest VALUES ('marker', ?)").run(marker);
  db.close();
}

for (const committed of [false, true]) {
  test(`restart ${committed ? "acknowledges committed candidate without reimport" : "rolls back uncommitted rename"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-publish-recovery-"));
    mkdirSync(join(root, "var/backups"), { recursive: true });
    const main = join(root, "rai.sqlite"), candidate = join(root, "candidate.sqlite");
    const rollback = join(root, "var/backups/rai.import-rollback.fixture.sqlite");
    database(main, "old"); database(candidate, "new");
    const state = new RuntimeStateStore(root);
    const journal = new ImportPublicationJournal(main, root);
    try {
      state.upsertJob({
        id: "job", status: "running", phase: "activate", message: "", createdAt: new Date().toISOString(),
        completedAt: null, error: null, inputPath: join(root, "missing-upload"),
        queue: { scope: "fixture", attempts: 1, finalized: false }
      });
      writeImportReceipt(candidate, "job", summary);
      journal.prepare("job", rollback, true);
      renameSync(main, rollback); renameSync(candidate, main);
      if (committed) journal.commit("job");
      const recovered = new ImportPublicationJournal(main, root);
      recovered.recover();
      assert.equal(Boolean(readImportReceipt(main, "job")), committed);
      if (committed) {
        const worker = new ImportWorker(main, root, root, undefined, undefined, undefined, {
          scope: "fixture", admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
        });
        assert.equal(worker.get("job")?.status, "succeeded");
        assert.deepEqual(worker.get("job")?.summary, summary);
        await worker.close();
      } else {
        assert.equal(existsSync(rollback), false);
        const db = new DatabaseSync(main);
        assert.equal((db.prepare("SELECT value FROM import_manifest WHERE key='marker'").get() as { value: string }).value, "old");
        db.close();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("committed journal + temporarily missing database: no false 'receipt missing', intent survives", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-missing-committed-"));
  try {
    mkdirSync(join(root, "var/backups"), { recursive: true });
    const main = join(root, "rai.sqlite");
    const rollback = join(root, "var/backups/rai.import-rollback.missing.sqlite");
    const journal = new ImportPublicationJournal(main, root);
    journal.prepare("missing-db-job", rollback, false);
    journal.commit("missing-db-job");
    // 主库暂时不存在：不能把它当成“已提交回执丢失”而启动失败。
    const recovered = new ImportPublicationJournal(main, root);
    const result = recovered.recover();
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0]!.state, "missing");
    assert.equal(recovered.has("missing-db-job"), true, "journal intent must survive until the DB is readable");
    assert.equal(existsSync(main), false, "journal recovery must not create an empty database");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepared rename with no remaining original fails closed instead of accepting candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-missing-"));
  mkdirSync(join(root, "var/backups"), { recursive: true });
  new RuntimeStateStore(root);
  const main = join(root, "rai.sqlite");
  database(main, "candidate");
  writeImportReceipt(main, "job", summary);
  const journal = new ImportPublicationJournal(main, root);
  try {
    journal.prepare("job", join(root, "var/backups/rai.import-rollback.missing.sqlite"), true);
    const recovery = journal.recover();
    assert.equal(recovery.blocked.length, 1);
    assert.match(recovery.blocked[0]!.detail, /rollback point missing/);
    assert.equal(journal.has("job"), true);
    assert.ok(existsSync(main));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepared rollback with missing main restores the displaced old database", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-restore-rollback-"));
  try {
    mkdirSync(join(root, "var/backups"), { recursive: true });
    const main = join(root, "rai.sqlite");
    const rollback = join(root, "var/backups/rai.import-rollback.prepared.sqlite");
    database(rollback, "old-dataset");
    const journal = new ImportPublicationJournal(main, root);
    journal.prepare("job", rollback, true);
    // Crash window: old database moved to the rollback path, candidate not
    // installed yet. The missing main path is expected, not a recovery stop.
    const recovery = journal.recover();
    assert.equal(recovery.blocked.length, 0);
    assert.equal(recovery.repaired, true);
    assert.equal(journal.has("job"), false);
    assert.equal(existsSync(rollback), false);
    const db = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT value FROM import_manifest WHERE key='marker'").get() as
        { value: string }).value, "old-dataset");
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepared rollback that fails integrity validation blocks instead of installing it", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-corrupt-rollback-"));
  try {
    mkdirSync(join(root, "var/backups"), { recursive: true });
    const main = join(root, "rai.sqlite");
    const rollback = join(root, "var/backups/rai.import-rollback.prepared.sqlite");
    writeFileSync(rollback, "not a sqlite database");
    const journal = new ImportPublicationJournal(main, root);
    journal.prepare("job", rollback, true);
    const recovery = journal.recover();
    assert.equal(recovery.blocked.length, 1);
    assert.equal(recovery.blocked[0]!.state, "unreadable");
    assert.match(recovery.blocked[0]!.detail, /rollback database/i);
    assert.equal(existsSync(main), false, "must not create or install a database");
    assert.equal(existsSync(rollback), true, "the only recovery copy must survive");
    assert.equal(journal.has("job"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime acknowledgement and publication intent removal are atomic", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-ack-"));
  const state = new RuntimeStateStore(root);
  const journal = new ImportPublicationJournal(join(root, "rai.sqlite"), root);
  const job = {
    id: "ack", status: "succeeded", phase: "completed", message: "",
    createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    error: null, inputPath: root, queue: { scope: "fixture", attempts: 1, finalized: false }
  };
  state.upsertJob(job);
  journal.prepare(job.id, join(root, "var/backups/rai.import-rollback.ack.sqlite"), true);
  journal.commit(job.id);
  const db = new DatabaseSync(state.path);
  try {
    db.exec("CREATE TRIGGER fail_intent_delete BEFORE DELETE ON import_publications BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    assert.throws(() => state.finalizeImportJob({ ...job, queue: { ...job.queue, finalized: true } }), /fixture/);
    assert.equal(state.job(job.id)?.queue?.finalized, false);
    assert.equal(journal.has(job.id), true);
    db.exec("DROP TRIGGER fail_intent_delete");
    state.finalizeImportJob({ ...job, queue: { ...job.queue, finalized: true } });
    assert.equal(state.job(job.id)?.queue?.finalized, true);
    assert.equal(journal.has(job.id), false);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recovery never overwrites an unfamiliar active database", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-unexpected-"));
  mkdirSync(join(root, "var/backups"), { recursive: true });
  new RuntimeStateStore(root);
  const main = join(root, "rai.sqlite");
  const rollback = join(root, "var/backups/rai.import-rollback.fixture.sqlite");
  database(main, "external-dataset");
  database(rollback, "old-dataset");
  const journal = new ImportPublicationJournal(main, root);
  try {
    journal.prepare("job", rollback, true);
    const recovery = journal.recover();
    assert.equal(recovery.blocked.length, 1);
    assert.equal(recovery.blocked[0]!.state, "unreadable");
    assert.ok(existsSync(main));
    assert.ok(existsSync(rollback));
    assert.equal(journal.has("job"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("initial import recovery refuses an unexpected database without a candidate receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-initial-unexpected-"));
  mkdirSync(join(root, "var/backups"), { recursive: true });
  new RuntimeStateStore(root);
  const main = join(root, "rai.sqlite");
  database(main, "external-dataset");
  const journal = new ImportPublicationJournal(main, root);
  try {
    journal.prepare("job", join(root, "var/backups/rai.import-rollback.fixture.sqlite"), false);
    const recovery = journal.recover();
    assert.equal(recovery.blocked.length, 1);
    assert.equal(recovery.blocked[0]!.state, "unreadable");
    assert.ok(existsSync(main));
    assert.equal(journal.has("job"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("initial import recovery refuses a rollback point even when the active database has its receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-initial-rollback-"));
  mkdirSync(join(root, "var/backups"), { recursive: true });
  new RuntimeStateStore(root);
  const main = join(root, "rai.sqlite");
  const rollback = join(root, "var/backups/rai.import-rollback.unexpected.sqlite");
  database(main, "candidate");
  writeImportReceipt(main, "job", summary);
  database(rollback, "unrelated-rollback");
  const journal = new ImportPublicationJournal(main, root);
  try {
    journal.prepare("job", rollback, false);
    const recovery = journal.recover();
    assert.equal(recovery.blocked.length, 1);
    assert.equal(recovery.blocked[0]!.state, "unreadable");
    assert.match(recovery.blocked[0]!.detail, /unexpected rollback/i);
    assert.equal(journal.has("job"), true);
    const active = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal((active.prepare("SELECT value FROM import_manifest WHERE key='marker'").get() as
        { value: string }).value, "candidate", "the active database must not be replaced");
    } finally { active.close(); }
    assert.ok(existsSync(rollback), "the unexpected rollback point must be preserved for inspection");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("committed imports remain pending through failed cleanup and restart until acknowledgement", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-pending-"));
  const state = new RuntimeStateStore(root);
  const main = join(root, "rai.sqlite");
  database(main, "candidate");
  const journal = new ImportPublicationJournal(main, root);
  writeImportReceipt(main, "job", summary);
  journal.prepare("job", join(root, "var/backups/rai.import-rollback.fixture.sqlite"), true);
  journal.commit("job");
  state.upsertJob({
    id: "job", status: "succeeded", phase: "completed", message: "",
    createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    error: null, inputPath: root, queue: { scope: "fixture", attempts: 1, finalized: false }
  });
  let attempts = 0;
  const create = (fail: boolean) => new ImportWorker(main, root, root,
    undefined, undefined, undefined, {
      scope: "fixture", admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import"),
      onTerminal: async () => {
        attempts++;
        if (fail) throw new Error("fixture source cleanup unavailable");
      }
    });
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, "finalization did not settle");
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  let worker = create(true);
  try {
    assert.equal(worker.hasPending, true);
    worker.resume();
    await waitFor(() => attempts >= 4 && !worker.isRunning);
    assert.equal(worker.hasPending, true, "maintenance stays blocked between cleanup attempts");
    assert.equal(journal.has("job"), true);
    await worker.close();
    worker = create(false);
    assert.equal(worker.hasPending, true, "restart must retain the maintenance guard");
    worker.resume();
    await waitFor(() => !worker.hasPending);
    assert.equal(state.job("job")?.queue?.finalized, true);
    assert.equal(journal.has("job"), false);
    assert.deepEqual(readImportReceipt(main, "job"), summary);
  } finally { await worker.close(); rmSync(root, { recursive: true, force: true }); }
});


test("strict receipt read returns null only after a successful query with no receipt row", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-receipt-strict-absent-"));
  const main = join(root, "rai.sqlite");
  database(main, "fixture");
  try {
    assert.equal(readImportReceiptStrict(main, "job"), null,
      "数据库可读且确实没有该 job 回执时才允许返回 null");
    writeImportReceipt(main, "job", summary);
    assert.deepEqual(readImportReceiptStrict(main, "job"), summary,
      "存在的有效回执必须原样返回");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict receipt read rejects a missing database and never creates an empty one", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-receipt-strict-missing-"));
  const missing = join(root, "missing.sqlite");
  try {
    assert.equal(existsSync(missing), false);
    assert.throws(() => readImportReceiptStrict(missing, "job"),
      "数据库缺失属于无法核实，不能当成没有回执");
    assert.equal(existsSync(missing), false,
      "readOnly 打开失败不得顺手创建空数据库");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict receipt read rejects corrupt databases, malformed JSON, and JSON null receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-receipt-strict-corrupt-"));
  const corrupt = join(root, "corrupt.sqlite");
  const malformed = join(root, "malformed.sqlite");
  const nullReceipt = join(root, "null-receipt.sqlite");
  const wrongShape = join(root, "wrong-shape.sqlite");
  writeFileSync(corrupt, "not a sqlite database");
  database(malformed, "fixture");
  database(nullReceipt, "fixture");
  database(wrongShape, "fixture");
  for (const [path, value] of [
    [malformed, "{not-json"],
    [nullReceipt, "null"],
    [wrongShape, JSON.stringify({ importMode: "unchanged" })]
  ] as const) {
    const db = new DatabaseSync(path);
    try {
      db.prepare("INSERT INTO import_manifest VALUES (?, ?)")
        .run(`rai.applied-import.job`, value);
    } finally { db.close(); }
  }
  try {
    assert.equal(readImportReceipt(corrupt, "job"), null,
      "宽松读取保留启动恢复的尽力语义");
    for (const path of [corrupt, malformed, nullReceipt, wrongShape]) {
      assert.throws(() => readImportReceiptStrict(path, "job"),
        `${path} 属于无法核实，必须上抛`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// P1-6（2026-10-23）：可恢复的 missing/unreadable 不得被裁决成“回执丢失”。
test("P1-6 committed intent + 损坏主库：保留 journal、报告恢复阻断、不创建空库", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-corrupt-committed-"));
  try {
    mkdirSync(join(root, "var/backups"), { recursive: true });
    const main = join(root, "rai.sqlite");
    writeFileSync(main, "not a sqlite database");
    const journal = new ImportPublicationJournal(main, root);
    journal.prepare("corrupt-job", join(root, "var/backups/rai.import-rollback.corrupt.sqlite"), true);
    journal.commit("corrupt-job");
    const recovery = journal.recover();
    assert.equal(recovery.blocked.length, 1);
    assert.equal(recovery.blocked[0]?.state, "unreadable");
    assert.equal(journal.has("corrupt-job"), true, "journal intent must survive an unreadable database");
    assert.equal(readFileSync(main, "utf8"), "not a sqlite database", "损坏主库字节不得被替换或删除");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P1-6 prepared intent + 不可读主库：不得用回滚点覆盖现场", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-corrupt-prepared-"));
  try {
    mkdirSync(join(root, "var/backups"), { recursive: true });
    const main = join(root, "rai.sqlite");
    const rollback = join(root, "var/backups/rai.import-rollback.prepared-corrupt.sqlite");
    writeFileSync(main, "unreadable active bytes");
    database(rollback, "old-dataset");
    const journal = new ImportPublicationJournal(main, root);
    journal.prepare("prepared-corrupt", rollback, true);
    const before = readFileSync(main, "utf8");
    const recovery = journal.recover();
    assert.equal(recovery.blocked.length, 1);
    assert.equal(recovery.blocked[0]?.state, "unreadable");
    assert.equal(readFileSync(main, "utf8"), before, "主库现场必须保留");
    assert.ok(existsSync(rollback), "回滚点必须保留");
    assert.equal(journal.has("prepared-corrupt"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P1-6 构造函数不因可恢复的 missing/unreadable intent 退出，且暴露结构化阻断", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-worker-blocked-"));
  try {
    mkdirSync(join(root, "var/backups"), { recursive: true });
    new RuntimeStateStore(root);
    const main = join(root, "rai.sqlite");
    const journal = new ImportPublicationJournal(main, root);
    journal.prepare("blocked-job", join(root, "var/backups/rai.import-rollback.blocked.sqlite"), false);
    journal.commit("blocked-job");
    const worker = new ImportWorker(main, root, root, undefined, undefined, undefined, {
      scope: "fixture", admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
    });
    try {
      assert.equal(worker.publicationRecoveryBlocked.length, 1);
      assert.equal(worker.hasPendingWrites, false, "恢复阻断的任务不是写者");
    } finally { await worker.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P1-7 停在 recovery_required 的任务不算写者，但仍是恢复阻断证据", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-parked-"));
  try {
    const state = new RuntimeStateStore(root);
    const main = join(root, "rai.sqlite");
    state.upsertJob({
      id: "parked", status: "queued", phase: "queued", message: "", createdAt: new Date().toISOString(),
      completedAt: null, error: null, inputPath: join(root, "missing-upload"),
      queue: { scope: "fixture", attempts: 0, finalized: false, databaseAbsentAtEnqueue: true }
    });
    const worker = new ImportWorker(main, root, root, undefined, undefined, undefined, {
      scope: "fixture", admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
    });
    try {
      assert.equal(worker.get("parked")?.phase, "recovery_required");
      assert.equal(worker.hasPendingWrites, false, "停在恢复裁决的任务不得永久阻止显式 restore");
      assert.equal(worker.hasRecoveryBlockedJobs, true);
      assert.equal(worker.hasPending, true);
    } finally { await worker.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("旧 scope 已完成但未确认的作业在启动时 superseded 并释放写者", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-terminal-"));
  try {
    const state = new RuntimeStateStore(root);
    const main = join(root, "rai.sqlite");
    database(main, "current-dataset");
    state.upsertJob({
      id: "old-succeeded", status: "succeeded", phase: "completed", message: "",
      createdAt: "2026-10-23T00:00:00.000Z", completedAt: "2026-10-23T00:01:00.000Z",
      error: null, inputPath: join(root, "missing-upload"),
      queue: { scope: "old-scope", attempts: 1, finalized: false }
    });
    const worker = new ImportWorker(main, root, root, undefined, undefined, undefined, {
      scope: "new-scope", admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
    });
    try {
      const job = worker.get("old-succeeded");
      assert.equal(job?.status, "succeeded", "已确认的成功结果不得被改写成 failed");
      assert.equal(job?.phase, "superseded", "旧 scope 的终态作业必须被收口，而不是永远 pending");
      assert.equal(worker.hasPendingWrites, false, "已终态的旧 scope 作业不得永久阻止删库/恢复");
      assert.equal(state.job("old-succeeded")?.queue?.finalized, true, "收口必须持久");
    } finally { await worker.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("显式恢复持久取代旧发布意图：重启不再把旧意图当作当前主库冲突", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-supersede-"));
  try {
    mkdirSync(join(root, "var/backups"), { recursive: true });
    const main = join(root, "rai.sqlite");
    database(main, "restored-dataset");
    const journal = new ImportPublicationJournal(main, root);
    const rollback = join(root, "var/backups/rai.import-rollback.superseded.sqlite");
    database(rollback, "old-dataset");
    journal.prepare("pre-restore-intent", rollback, true);
    journal.commit("pre-restore-intent");
    assert.equal(journal.has("pre-restore-intent"), true);

    // Restore committed + final epoch durable ⇒ intents become durably inert.
    assert.equal(journal.supersedeWithRestore("restored-epoch"), 1);
    assert.equal(journal.has("pre-restore-intent"), false, "意图必须在同一事务里失效");
    const records = journal.supersessions();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.id, "pre-restore-intent");
    assert.equal(records[0]!.restoredEpoch, "restored-epoch");
    assert.ok(existsSync(rollback), "取代不是删除回滚文件：它仍是有效备份");

    // Restart: the durable record is recognized; nothing re-blocks.
    const restarted = new ImportPublicationJournal(main, root);
    const recovery = restarted.recover();
    assert.equal(recovery.blocked.length, 0);
    assert.equal(recovery.superseded, 0, "已清理的意图不会再次计数");
    assert.equal(restarted.has("pre-restore-intent"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("取代记录已提交但意图尚未删除：重启只补齐第二步，不再阻断", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publish-supersede-window-"));
  try {
    mkdirSync(join(root, "var/backups"), { recursive: true });
    const main = join(root, "rai.sqlite");
    database(main, "restored-dataset");
    const journal = new ImportPublicationJournal(main, root);
    journal.prepare("crash-window-intent", join(root, "var/backups/rai.import-rollback.window.sqlite"), true);
    journal.commit("crash-window-intent");
    // Simulate the crash window: supersession row committed, intent still there.
    const db = new DatabaseSync(join(root, "var/runtime.sqlite"));
    try {
      db.prepare(`INSERT INTO import_publication_supersessions (id, restored_epoch, reason, superseded_at)
        VALUES (?, ?, ?, ?)`).run("crash-window-intent", "restored-epoch", "explicit_backup_restore",
        new Date().toISOString());
    } finally { db.close(); }

    const restarted = new ImportPublicationJournal(main, root);
    const recovery = restarted.recover();
    assert.equal(recovery.blocked.length, 0, "取代记录必须让重启得出同一结论");
    assert.equal(recovery.superseded, 1);
    assert.equal(restarted.has("crash-window-intent"), false, "第二步必须被补齐");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
