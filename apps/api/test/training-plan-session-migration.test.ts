import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { acquireDatabasePublicationLock } from "@rai/storage-sqlite";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { parseTrainingPlanState, TrainingPlanStore, type TrainingPlanLegacyState } from "../src/training-plan-store.js";
import { inspectSessionIdentityMigration, applySessionIdentityMigration } from "../src/training-plan-session-migration.js";
import { TrainingPlanSessionRepository } from "../src/training-plan-session-repository.js";

const base = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-closed-loop.json", import.meta.url), "utf8"));
const identity = base.scope as { serverId: string; athleteId: string; datasetEpoch: string };
const scope = JSON.stringify([identity.serverId, identity.athleteId, identity.datasetEpoch]);
function seed() {
  const root = mkdtempSync(join(tmpdir(), "rai-session-migration-")), path = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, path);
  const written = goals.write({ weekPlan: base.projections[0].state.weekPlan });
  const db = new DatabaseSync(path), store = new TrainingPlanStore(db);
  const state = parseTrainingPlanState({ ...base.projections[0].state, goalsRevision: written.revision, weekPlan: written.weekPlan }) as TrainingPlanLegacyState;
  store.applyMigration({ scope, expectedAbsentOrRevision: null, sourceDigest: state.sourceDigest, state });
  const close = () => { db.close(); goals.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, path, goals, db, store, state, close };
}
function snapshot(db: DatabaseSync) {
  return db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => {
    const name = row.name as string;
    return { ...row, rows: String(row.sql).startsWith("CREATE TABLE") ? db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() : null };
  });
}

test("B02/T24/T26: dry-run allocates nothing; controlled apply maps all 1001 scoped revisions without guessing continuity", context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-25T02:01:00.000Z") });
  const f = seed();
  try {
    let revision = 1;
    for (let i = 0; i < 1000; i++) {
      context.mock.timers.tick(1);
      revision = f.store.commitState({ scope, expectedRevision: revision, state: f.state, eventType: "fixture:legacy-metadata" }).revision;
    }
    const before = snapshot(f.db);
    const report = inspectSessionIdentityMigration(f.db, scope);
    assert.equal(report.status, "ready"); assert.equal(report.planInstanceId, null);
    assert.equal(report.historySnapshots, 1001); assert.equal(report.historicalSessions, 1001);
    assert.deepEqual(snapshot(f.db), before, "dry-run has no DDL/data/ID side effect");
    const legacyGoalsHistory = f.db.prepare("SELECT * FROM mobile_goals_history ORDER BY id").all();
    const legacyAudit = f.db.prepare("SELECT * FROM mobile_training_migration_audit WHERE migration_version=1").all();
    const oldHistory = f.db.prepare("SELECT * FROM mobile_training_state_history ORDER BY revision").all();
    const result = applySessionIdentityMigration(f.db, scope, report.sourceDigest, report.existingRevision);
    assert.equal(result.status, "applied"); assert.equal(result.revision, 1002);
    const current = f.store.read(scope)!;
    assert.equal(current.state.schemaVersion, 2);
    if (current.state.schemaVersion !== 2) throw new Error("schema 2 required");
    assert.equal(current.state.planInstanceId, result.planInstanceId);
    assert.equal(current.state.sessions[0]?.protection, "user_protected");
    assert.equal(current.state.sessions[0]?.userOverride, null, "migration does not invent a user edit");
    const rows = f.db.prepare("SELECT plan_instance_id,session_id FROM mobile_training_session_history").all();
    assert.equal(rows.length, 1001); assert.equal(new Set(rows.map(row => row.session_id)).size, 1001, "same date/hash does not merge historical identities");
    assert.deepEqual(f.db.prepare("SELECT * FROM mobile_goals_history ORDER BY id").all(), legacyGoalsHistory);
    assert.deepEqual(f.db.prepare("SELECT * FROM mobile_training_migration_audit WHERE migration_version=1").all(), legacyAudit);
    assert.deepEqual(f.db.prepare("SELECT * FROM mobile_training_state_history WHERE revision<=1001 ORDER BY revision").all(), oldHistory);
    const repo = new TrainingPlanSessionRepository(f.db), all = [];
    let after: { availableAt: string; sessionId: string; sessionRevision: number } | undefined;
    for (;;) {
      const page = repo.forDate(scope, "2026-10-28", "2026-10-26T00:00:00.000Z", { limit: 200, ...(after ? { after } : {}) });
      all.push(...page); if (page.length < 200) break;
      const last = page.at(-1)!.session;
      after = { availableAt: last.availableAt, sessionId: last.sessionId, sessionRevision: last.sessionRevision };
    }
    assert.equal(all.length, 1001); assert.equal(all[0]?.session.availableAt, f.state.migratedAt);
    const complete = snapshot(f.db);
    const repeated = inspectSessionIdentityMigration(f.db, scope);
    const replay = applySessionIdentityMigration(f.db, scope, repeated.sourceDigest, 0);
    assert.equal(replay.status, "replayed"); assert.equal(replay.planInstanceId, result.planInstanceId);
    assert.deepEqual(snapshot(f.db), complete, "repeat apply performs zero changes and no new ID allocation");
    assert.equal(repo.forDate(JSON.stringify(["another-server", identity.athleteId, identity.datasetEpoch]), "2026-10-28", "2026-10-26T00:00:00.000Z").length, 0);
  } finally { f.close(); }
});

test("B02/T24/T25: stale digest/CAS, source duplicates, unknown payload and owner disagreement refuse without writes", () => {
  const f = seed();
  try {
    const report = inspectSessionIdentityMigration(f.db, scope), before = snapshot(f.db);
    assert.throws(() => applySessionIdentityMigration(f.db, scope, "0".repeat(64), 1), /sources changed/);
    assert.throws(() => applySessionIdentityMigration(f.db, scope, report.sourceDigest, 9), /CAS conflict/);
    assert.deepEqual(snapshot(f.db), before);
    f.store.commitState({ scope, expectedRevision: 1, state: f.state, eventType: "fixture:concurrent" });
    const changed = snapshot(f.db);
    assert.throws(() => applySessionIdentityMigration(f.db, scope, report.sourceDigest, 1), /sources changed/);
    assert.deepEqual(snapshot(f.db), changed);
    f.db.prepare("UPDATE mobile_training_state_history SET payload_json=? WHERE revision=1").run(JSON.stringify({ ...f.state, weekPlan: [f.state.weekPlan[0], f.state.weekPlan[0]] }));
    const duplicate = snapshot(f.db);
    assert.throws(() => inspectSessionIdentityMigration(f.db, scope), /Duplicate source dates/);
    assert.deepEqual(snapshot(f.db), duplicate);
    f.db.prepare("UPDATE mobile_training_state_history SET payload_json=? WHERE revision=1").run(JSON.stringify({ ...f.state, schemaVersion: 99 }));
    assert.throws(() => inspectSessionIdentityMigration(f.db, scope), /unknown.*schemaVersion/);
    f.db.prepare("UPDATE mobile_goals SET revision=revision+1").run();
    assert.throws(() => inspectSessionIdentityMigration(f.db, scope), /revisions disagree/);
  } finally { f.close(); }
});

test("B02/T22/T24: each new migration write point and COMMIT failure rolls back schema/ID mapping/state/audit together", () => {
  for (const table of ["mobile_training_session_history", "mobile_training_state", "mobile_training_state_history", "mobile_training_migration_audit", "COMMIT"]) {
    const f = seed();
    try {
      const report = inspectSessionIdentityMigration(f.db, scope);
      if (table !== "COMMIT") {
        const action = table === "mobile_training_state" ? "UPDATE" : "INSERT";
        f.db.exec(`CREATE TRIGGER fail_identity_write BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'injected identity failure'); END`);
      }
      const before = snapshot(f.db);
      const original = f.db.exec.bind(f.db);
      if (table === "COMMIT") f.db.exec = (sql: string) => { if (sql === "COMMIT") throw new Error("injected COMMIT failure"); original(sql); };
      assert.throws(() => applySessionIdentityMigration(f.db, scope, report.sourceDigest, 1), /injected/);
      f.db.exec = original;
      assert.deepEqual(snapshot(f.db), before, table);
      assert.equal(f.store.read(scope)?.state.schemaVersion, 1);
    } finally { f.close(); }
  }
});

test("B02/T24: CLI session mode is read-only by default, enforces digest/lock, applies once and never opens the health DB", () => {
  const f = seed();
  try {
    const args = ["--import", "tsx", "scripts/migrate-training-planner.mts", "--control-db", f.path,
      "--server-id", identity.serverId, "--athlete-id", identity.athleteId, "--dataset-epoch", identity.datasetEpoch, "--session-identities"];
    const invoke = (extra: string[] = []) => {
      const child = spawnSync(process.execPath, [...args, ...extra], { encoding: "utf8", env: { ...process.env, RAI_DATABASE: join(f.root, "must-not-create-health.sqlite") } });
      return { code: child.status, json: JSON.parse(child.stdout) };
    };
    const before = snapshot(f.db), dry = invoke();
    assert.equal(dry.code, 0); assert.equal(dry.json.planInstanceId, null); assert.deepEqual(snapshot(f.db), before);
    assert.equal(invoke(["--apply"]).json.error.code, "expect_source_digest_required");
    const release = acquireDatabasePublicationLock(f.path, "cli");
    try { assert.equal(invoke(["--apply", "--expect-source-digest", dry.json.sourceDigest]).json.error.code, "control_database_locked"); }
    finally { release(); }
    const applied = invoke(["--apply", "--expect-source-digest", dry.json.sourceDigest]);
    assert.equal(applied.code, 0); assert.equal(applied.json.status, "applied");
    const complete = snapshot(f.db), repeated = invoke(["--apply", "--expect-source-digest", dry.json.sourceDigest]);
    assert.equal(repeated.code, 0); assert.equal(repeated.json.status, "replayed"); assert.equal(repeated.json.planInstanceId, applied.json.planInstanceId);
    assert.deepEqual(snapshot(f.db), complete);
    assert.throws(() => readFileSync(join(f.root, "must-not-create-health.sqlite")), /ENOENT/);
  } finally { f.close(); }
});

test("B02/T22/T23: schema 3 and its ledger entry roll back together; SQLite busy never starts a partial upgrade", () => {
  const f = seed();
  try {
    // Simulate a control database whose B02 schema was rolled back; B06's
    // execution tables depend on it, so they are removed with the same fixture.
    f.db.exec("DROP TABLE mobile_training_execution_history; DROP TABLE mobile_training_execution");
    f.db.exec("DROP TABLE mobile_training_plan_evaluation");
    f.db.exec("DROP TABLE mobile_training_session_history; DELETE FROM mobile_control_schema WHERE version IN (3,4,5)");
    const report = inspectSessionIdentityMigration(f.db, scope), before = snapshot(f.db);
    const original = f.db.exec.bind(f.db);
    f.db.exec = (sql: string) => { if (sql === "COMMIT") throw new Error("injected COMMIT before DDL persistence"); original(sql); };
    assert.throws(() => applySessionIdentityMigration(f.db, scope, report.sourceDigest, 1), /injected/);
    f.db.exec = original;
    assert.deepEqual(snapshot(f.db), before, "new table/index/ledger/data are all rolled back");
    f.db.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON mobile_control_schema WHEN NEW.version=3 BEGIN SELECT RAISE(ABORT,'injected ledger failure'); END");
    const withTrigger = snapshot(f.db);
    assert.throws(() => applySessionIdentityMigration(f.db, scope, report.sourceDigest, 1), /injected ledger/);
    assert.deepEqual(snapshot(f.db), withTrigger);
    f.db.exec("DROP TRIGGER fail_ledger");
    const blocker = new DatabaseSync(f.path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      assert.throws(() => applySessionIdentityMigration(f.db, scope, report.sourceDigest, 1), /locked|busy/i);
      assert.equal(f.db.isTransaction, false);
      assert.deepEqual(snapshot(f.db), before);
    } finally { blocker.exec("ROLLBACK"); blocker.close(); }
    assert.equal(applySessionIdentityMigration(f.db, scope, report.sourceDigest, 1).status, "applied");
  } finally { f.close(); }
});


test("D-03: identity migration and historical replay retain all nine legacy steps", () => {
  const f = seed();
  try {
    const day = { localDate: "2026-10-28", kind: "easy" as const, distanceKm: 0.9, reason: "legacy nine-step course",
      structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1, steps: Array.from({ length: 9 }, () => ({
        purpose: "work" as const, goal: { type: "distance" as const, meters: 100 }, alert: null })) }] } };
    const goals = f.goals.write({ weekPlan: [day] }, { preserveWeekPlan: true });
    const row = f.store.read(scope)!;
    f.store.commitState({ scope, expectedRevision: row.revision, state: {
      ...f.state, weekPlan: [day], lockedSession: null, goalsRevision: goals.revision }, eventType: "fixture:legacy-nine-steps" });
    const before = snapshot(f.db);
    const report = inspectSessionIdentityMigration(f.db, scope);
    assert.deepEqual(snapshot(f.db), before, "dry-run preserves historical JSON and allocates nothing");
    const history = f.db.prepare("SELECT * FROM mobile_training_state_history ORDER BY revision").all();
    const migrated = applySessionIdentityMigration(f.db, scope, report.sourceDigest, report.existingRevision);
    const current = f.store.read(scope)!;
    assert.equal(current.state.schemaVersion, 2);
    if (current.state.schemaVersion !== 2) throw new Error("schema 2 required");
    assert.deepEqual(current.state.sessions[0]!.prescription, day);
    const repo = new TrainingPlanSessionRepository(f.db);
    assert.deepEqual(repo.get(scope, migrated.planInstanceId!, current.state.sessions[0]!.sessionId, 1)!.session.prescription, day);
    assert.deepEqual(f.db.prepare("SELECT * FROM mobile_training_state_history ORDER BY revision").all().slice(0, history.length), history);
    const after = snapshot(f.db);
    assert.equal(applySessionIdentityMigration(f.db, scope, report.sourceDigest, report.existingRevision).status, "replayed");
    assert.deepEqual(snapshot(f.db), after);
  } finally { f.close(); }
});
