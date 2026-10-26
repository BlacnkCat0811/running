import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { MobileLockedSession } from "@rai/api-contracts";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { classifyTrainingPlanMigration, parseTrainingPlanState, readTrainingPlanMigrationSources,
  TrainingPlanStore, type TrainingPlanLegacyState } from "../src/training-plan-store.js";
import { applySessionIdentityMigration, inspectSessionIdentityMigration } from "../src/training-plan-session-migration.js";
import { auditTrainingPlanStateCopy } from "../src/training-plan-state-audit.js";
import { resolveTrainingPlanSessions, trainingPlanProtectedDays } from "../src/training-plan-session-policy.js";

const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-sessions-v2.json", import.meta.url), "utf8"));
const identity = fixture.scope;
const scope = JSON.stringify([identity.serverId, identity.athleteId, identity.datasetEpoch]);
const date = "2026-10-30", now = "2026-10-25T03:10:00.000Z";
const lock: MobileLockedSession = { localDate: date, session: { kind: "easy", distanceKm: 5, structure: null, reason: "synthetic lock",
  title: "synthetic", durationMinutes: null, paceSecondsPerKmLower: null, paceSecondsPerKmUpper: null,
  heartRateBpmLower: null, heartRateBpmUpper: null },
  verdictTone: "green", lockedAt: now };
function legacy(): TrainingPlanLegacyState {
  const { planInstanceId, sessions, suppressions, publishedInputKey, ...state } = fixture.payload2;
  return parseTrainingPlanState({ ...state, schemaVersion: 1, migrationVersion: 1 }) as TrainingPlanLegacyState;
}
function seed() {
  const root = mkdtempSync(join(tmpdir(), "rai-a01-")), path = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, path), db = new DatabaseSync(path), store = new TrainingPlanStore(db);
  const written = goals.write({ weekPlan: legacy().weekPlan });
  const state = { ...legacy(), weekPlan: written.weekPlan, goalsRevision: written.revision };
  store.applyMigration({ scope, expectedAbsentOrRevision: null, state, sourceDigest: state.sourceDigest });
  return { root, path, goals, db, store, state,
    close() { db.close(); goals.close(); rmSync(root, { recursive: true, force: true }); } };
}
function snapshot(db: DatabaseSync) {
  return db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({
    name: row.name, sql: row.sql, rows: String(row.sql).startsWith("CREATE TABLE")
      ? db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all() : null
  }));
}
const migrationConflict = (error: unknown) => error instanceof Error &&
  (error as Error & { code?: string }).code === "session_migration_locked_rest_conflict";

test("A-01: legal schema 1/2 locks and explicit rest remain readable without mutation", () => {
  for (const state of [legacy(), fixture.payload2]) {
    const before = JSON.stringify(state);
    assert.deepEqual(parseTrainingPlanState(state), state);
    const locked = { ...state, lockedSession: { ...lock, localDate: "2026-10-29" } };
    assert.deepEqual(parseTrainingPlanState(locked).lockedSession, locked.lockedSession);
    const lockedRest = { ...state, lockedSession: { ...lock, session: { ...lock.session, kind: "rest" as const } },
      ...(state.schemaVersion === 2 ? { suppressions: [] } : {}) };
    assert.deepEqual(parseTrainingPlanState(lockedRest).lockedSession, lockedRest.lockedSession,
      "a legacy rest lock with its rest materialization remains readable");
    if (state.schemaVersion === 2) assert.throws(() => parseTrainingPlanState({ ...lockedRest, suppressions: state.suppressions }),
      /explicit rest and locked session/);
    assert.equal(JSON.stringify(state), before);
  }
});

for (const version of [1, 2]) test(`A-01: schema ${version} strict read rejects lock/rest without silently repairing history`, () => {
  const state = { ...(version === 1 ? legacy() : structuredClone(fixture.payload2)), lockedSession: lock };
  const before = JSON.stringify(state);
  assert.throws(() => parseTrainingPlanState(state), /locked.*rest|rest.*locked/i);
  assert.equal(JSON.stringify(state), before);
  if (version === 2) {
    // weekPlan rest is independently invalid even without explicit_rest.
    state.suppressions = state.suppressions.filter((s: { reason: string }) => s.reason !== "explicit_rest");
    assert.throws(() => parseTrainingPlanState(state), /locked.*rest|rest.*locked/i);
  }
});

for (const source of ["current", "history"]) test(`A-01: ${source} schema 1 conflict is diagnosed by inspect and apply writes nothing`, () => {
  const f = seed();
  try {
    const ready = inspectSessionIdentityMigration(f.db, scope);
    const payload = JSON.stringify({ ...f.state, lockedSession: lock });
    if (source === "current") {
      f.db.prepare("UPDATE mobile_training_state SET payload_json=? WHERE scope=?").run(payload, scope);
      f.db.prepare("UPDATE mobile_training_state_history SET payload_json=? WHERE scope=?").run(payload, scope);
      const goals = JSON.parse((f.db.prepare("SELECT payload_json FROM mobile_goals").get() as { payload_json: string }).payload_json);
      f.db.prepare("UPDATE mobile_goals SET payload_json=?").run(JSON.stringify({ ...goals, lockedSession: lock }));
    } else {
      f.store.commitState({ scope, expectedRevision: 1, state: f.state, eventType: "fixture:later-valid-state" });
      f.db.prepare("UPDATE mobile_training_state_history SET payload_json=? WHERE scope=? AND revision=1").run(payload, scope);
    }
    const before = snapshot(f.db);
    assert.throws(() => inspectSessionIdentityMigration(f.db, scope), (error: unknown) => {
      assert.ok(migrationConflict(error));
      const conflicts = (error as { conflicts: Array<{ scope: string; revision: number; localDate: string; source: string }> }).conflicts;
      assert.ok(conflicts.some(c => c.scope === scope && c.revision === 1 && c.localDate === date && c.source === "mobile_training_state_history"));
      return true;
    });
    assert.throws(() => applySessionIdentityMigration(f.db, scope, ready.sourceDigest, ready.existingRevision), migrationConflict);
    assert.deepEqual(snapshot(f.db), before, "all tables, IDs, audits, revisions and DDL stay unchanged");
    assert.equal(f.db.isTransaction, false);
  } finally { f.close(); }
});

test("A-01: legacy lock rejects a rest date before writing goals/history", () => {
  const f = seed();
  try {
    const before = snapshot(f.db);
    assert.throws(() => f.goals.lockSession(lock), (error: unknown) =>
      (error as { code?: string }).code === "training_session_date_occupied");
    assert.deepEqual(snapshot(f.db), before);
    const valid = { ...lock, localDate: "2026-10-29" };
    assert.equal(f.goals.lockSession(valid).lockedSession?.localDate, valid.localDate);
  } finally { f.close(); }
});

test("A-01: owner reconciliation rolls back a lock colliding with staged explicit rest", () => {
  const f = seed();
  try {
    const ready = inspectSessionIdentityMigration(f.db, scope);
    applySessionIdentityMigration(f.db, scope, ready.sourceDigest, ready.existingRevision);
    const migrated = f.store.read(scope)!.state;
    assert.equal(migrated.schemaVersion, 2);
    if (migrated.schemaVersion !== 2) throw new Error("schema 2 required");
    f.goals.bindTrainingPlanOwner(() => identity);
    const before = snapshot(f.db);
    // Remove only the projection rest to exercise the staged owner check too.
    assert.throws(() => f.goals.withPublicationTransaction(() => {
      f.goals.stageTrainingPlanSessionState({ sessions: migrated.sessions, suppressions: migrated.suppressions });
      f.goals.write({ lockedSession: lock, weekPlan: migrated.weekPlan.filter(d => d.localDate !== date) },
        { preserveWeekPlan: true });
    }), /locked.*rest|rest.*locked|明确休息/i);
    // Publication leases deliberately advance outside the business transaction.
    // Every business row must roll back; the lease must be released normally.
    const businessRows = (rows: ReturnType<typeof snapshot>) => rows.filter(row => row.name !== "mobile_publication_guard");
    assert.deepEqual(businessRows(snapshot(f.db)), businessRows(before));
    assert.equal(f.db.prepare("SELECT pending_since FROM mobile_publication_guard").get()!.pending_since, null);
  } finally { f.close(); }
});

test("A-01: resolver and protected budget reject an invalid typed lock/weekPlan rest before allocating", () => {
  const state = { ...structuredClone(fixture.payload2), lockedSession: lock, suppressions: [] };
  const before = JSON.stringify(state);
  assert.throws(() => resolveTrainingPlanSessions({ state, generatedDays: [], businessDate: "2026-10-25", availableAt: now,
    allocateSessionId: () => { assert.fail("no identity allocation on conflict"); } }), /locked.*rest|rest.*locked/i);
  assert.throws(() => trainingPlanProtectedDays(state), /locked.*rest|rest.*locked/i);
  assert.equal(JSON.stringify(state), before);
});

test("A-01: unified store refuses conflicting commands and strict database reads never alter stored bytes", () => {
  const f = seed();
  try {
    const invalid = { ...f.state, lockedSession: lock }, before = snapshot(f.db);
    assert.throws(() => f.store.commitState({ scope, expectedRevision: 1, state: invalid, eventType: "fixture:invalid-command" }), /locked.*rest|rest.*locked/i);
    assert.deepEqual(snapshot(f.db), before);
    f.db.prepare("UPDATE mobile_training_state SET payload_json=? WHERE scope=?").run(JSON.stringify(invalid), scope);
    const corrupt = snapshot(f.db);
    assert.throws(() => f.store.read(scope), /locked.*rest|rest.*locked/i);
    assert.deepEqual(snapshot(f.db), corrupt);
  } finally { f.close(); }
});

test("A-01: legacy source migration classifies lock/rest as a conflict, never as an applicable state", () => {
  const f = seed();
  try {
    const sources = readTrainingPlanMigrationSources(f.db, identity);
    assert.ok(sources.goals);
    const result = classifyTrainingPlanMigration({ scope: identity, businessDate: "2026-10-25", now,
      sources: { ...sources, existingState: null, goals: { ...sources.goals,
        payload: { ...sources.goals.payload as object, lockedSession: lock } } } });
    assert.equal(result.applyAllowed, false); assert.equal(result.state, null);
    assert.ok(result.conflicts.some(c => c.code === "locked_rest_conflict"));
  } finally { f.close(); }
});

test("A-01: file-to-control bootstrap refuses a conflicting legacy lock and preserves the source file", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-a01-bootstrap-")), path = join(root, "control.sqlite"), file = join(root, "var", "mobile-goals.json");
  try {
    mkdirSync(join(root, "var"));
    const raw = JSON.stringify({ revision: 4, weekPlan: legacy().weekPlan, lockedSession: lock });
    writeFileSync(file, raw);
    assert.throws(() => new MobileGoalsStore(root, path), /明确休息/);
    assert.equal(readFileSync(file, "utf8"), raw);
    const db = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) n FROM mobile_goals").get()!.n, 0); }
    finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("A-01: a legal historical lock survives schema 1 to 2 migration with explicit rest on a different date", () => {
  const f = seed();
  try {
    f.goals.bindTrainingPlanOwner(() => identity);
    f.goals.lockSession({ ...lock, localDate: "2026-10-29" });
    const before = f.store.read(scope)!.state;
    const ready = inspectSessionIdentityMigration(f.db, scope);
    assert.equal(ready.status, "ready");
    applySessionIdentityMigration(f.db, scope, ready.sourceDigest, ready.existingRevision);
    const after = f.store.read(scope)!.state;
    assert.equal(after.schemaVersion, 2);
    assert.deepEqual(after.lockedSession, before.lockedSession);
    if (after.schemaVersion !== 2) throw new Error("schema 2 required");
    assert.ok(after.suppressions.some(s => s.reason === "explicit_rest" && s.localDate === date));
  } finally { f.close(); }
});

test("A-01: migration CLI dry-run/apply return structured conflict diagnostics and zero database writes", () => {
  const f = seed();
  try {
    f.db.prepare("UPDATE mobile_training_state_history SET payload_json=? WHERE scope=?").run(JSON.stringify({ ...f.state, lockedSession: lock }), scope);
    const before = snapshot(f.db);
    const args = ["--import", "tsx", "scripts/migrate-training-planner.mts", "--control-db", f.path,
      "--server-id", identity.serverId, "--athlete-id", identity.athleteId, "--dataset-epoch", identity.datasetEpoch, "--session-identities"];
    for (const extra of [[], ["--apply", "--expect-source-digest", "0".repeat(64)]]) {
      const result = spawnSync(process.execPath, [...args, ...extra], { encoding: "utf8" });
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.error.code, "session_migration_locked_rest_conflict");
      assert.ok(report.conflicts.some((c: { revision: number; localDate: string }) => c.revision === 1 && c.localDate === date));
      assert.equal(result.stdout.includes("synthetic lock"), false);
      assert.deepEqual(snapshot(f.db), before);
    }
  } finally { f.close(); }
});

test("A-01-01: legal rest lock migrates deterministically without duplicate explicit_rest and keeps history", () => {
  const f = seed();
  try {
    f.goals.bindTrainingPlanOwner(() => identity);
    f.goals.lockSession({ ...lock, session: { ...lock.session, kind: "rest" } });
    const original = f.store.read(scope)!.state;
    const before = snapshot(f.db);
    assert.equal(auditTrainingPlanStateCopy(f.path).ok, true);
    const ready = inspectSessionIdentityMigration(f.db, scope);
    assert.equal(ready.status, "ready");
    assert.deepEqual(snapshot(f.db), before, "inspect is read only");
    assert.throws(() => applySessionIdentityMigration(f.db, scope, "0".repeat(64), ready.existingRevision),
      (error: unknown) => (error as { code: string }).code === "source_digest_mismatch");
    assert.deepEqual(snapshot(f.db), before, "failed migration writes no tables or DDL");
    applySessionIdentityMigration(f.db, scope, ready.sourceDigest, ready.existingRevision);
    const after = f.store.read(scope)!.state;
    assert.equal(after.schemaVersion, 2);
    assert.deepEqual(after.lockedSession, original.lockedSession);
    if (after.schemaVersion !== 2) throw new Error("schema 2 required");
    assert.equal(after.suppressions.some(s => s.localDate === date), false);
    for (const table of ["mobile_training_state_history", "mobile_goals_history"]) {
      const oldRows = before.find(row => row.name === table)!.rows!;
      assert.deepEqual(snapshot(f.db).find(row => row.name === table)!.rows!.slice(0, oldRows.length), oldRows);
    }
    assert.equal(auditTrainingPlanStateCopy(f.path).ok, true);
    const replay = inspectSessionIdentityMigration(f.db, scope);
    assert.equal(replay.status, "replayed");
    const committed = snapshot(f.db);
    applySessionIdentityMigration(f.db, scope, replay.sourceDigest, replay.existingRevision);
    assert.deepEqual(snapshot(f.db), committed);
  } finally { f.close(); }
});
