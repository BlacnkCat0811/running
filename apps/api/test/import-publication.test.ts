import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ImportPublicationJournal, readImportReceipt, writeImportReceipt } from "../src/import-publication.js";
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
    assert.throws(() => journal.recover(), /rollback point missing/);
    assert.ok(existsSync(main));
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
    assert.throws(() => journal.recover(), /Unexpected active database/);
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
    assert.throws(() => journal.recover(), /Unexpected active database/);
    assert.ok(existsSync(main));
    assert.equal(journal.has("job"), true);
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
