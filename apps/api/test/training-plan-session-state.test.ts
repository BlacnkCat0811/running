import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";
import type { TrainingPlanSession } from "@rai/api-contracts";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { parseTrainingPlanState, TrainingPlanStore, type TrainingPlanSessionState } from "../src/training-plan-store.js";
import { TrainingPlanSessionRepository } from "../src/training-plan-session-repository.js";
import { buildTrainingPlanStateV2, createTrainingPlanStateRoute } from "../src/training-plan-routes.js";

const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-sessions-v2.json", import.meta.url), "utf8")) as {
  payload2: TrainingPlanSessionState; initial: TrainingPlanSession; moved: TrainingPlanSession; edited: TrainingPlanSession;
  scope: { serverId: string; athleteId: string; datasetEpoch: string }; wire: unknown;
};
const scope = JSON.stringify([fixture.scope.serverId, fixture.scope.athleteId, fixture.scope.datasetEpoch]);
const legacy = () => { const { planInstanceId, sessions, suppressions, publishedInputKey, ...old } = fixture.payload2;
  return parseTrainingPlanState({ ...old, schemaVersion: 1, migrationVersion: 1 }); };

test("B02/T25: schema 1 stays compatible; schema 2 round-trips all identity/override/null/structure fields without normalization", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseTrainingPlanState(fixture.payload2))), fixture.payload2);
  assert.equal(parseTrainingPlanState(legacy()).schemaVersion, 1);
  assert.throws(() => parseTrainingPlanState({ ...fixture.payload2, schemaVersion: 99 }), /unknown.*schemaVersion/);
  assert.throws(() => parseTrainingPlanState({ ...fixture.payload2, schemaVersion: 1 }), /lossy/);
  const corruptions: Array<(state: any) => void> = [
    s => s.sessions.push(s.sessions[0]),
    s => s.sessions[0].planInstanceId = "other-instance",
    s => s.sessions[0].futureOwnershipField = "must not vanish",
    s => s.sessions[0].sessionRevision = 0,
    s => s.sessions[0].protection = "unknown_future_protection",
    s => s.sessions[0].lifecycle = "scheduled_is_completed",
    s => s.sessions[0].userOverride.prescription.distanceKm = 11,
    s => s.sessions[0].prescription.structure.blocks[0].steps[0].goal.meters = 200000,
    s => s.suppressions[0].sessionId = "unowned",
    s => s.weekPlan.push(s.weekPlan[0]),
    s => s.weekPlan[0].distanceKm = 9,
    s => s.sessions[0].availableAt = "2026-10-25T03:10:00Z",
    // P2.12: a day cannot be both an explicit rest decision and a locked course.
    s => { s.lockedSession = { localDate: "2026-10-30", session: { kind: "easy", distanceKm: 5 },
      verdictTone: "green", lockedAt: "2026-10-25T03:00:00.000Z" }; }
  ];
  for (const corrupt of corruptions) { const state = structuredClone(fixture.payload2); corrupt(state); assert.throws(() => parseTrainingPlanState(state)); }
});

test("B02/T26: stable identity and frozen prescriptions survive moving/editing and 1000 newer whole-plan revisions", context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-25T03:00:00.000Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-session-history-"));
  const control = join(root, "control.sqlite"), goals = new MobileGoalsStore(root, control), db = new DatabaseSync(control);
  const store = new TrainingPlanStore(db), repo = new TrainingPlanSessionRepository(db);
  try {
    const old = legacy();
    store.applyMigration({ scope, expectedAbsentOrRevision: null, sourceDigest: old.sourceDigest, state: old });
    const state: TrainingPlanSessionState = { ...fixture.payload2, sessions: [fixture.initial],
      suppressions: [], weekPlan: [fixture.initial.prescription] };
    let revision = store.commitState({ scope, expectedRevision: 1, state, eventType: "fixture:controlled-upgrade" }, { sessionMigration: true }).revision;
    context.mock.timers.tick(5 * 60_000);
    state.sessions = [fixture.moved]; state.weekPlan = [fixture.moved.prescription]; state.suppressions = [fixture.payload2.suppressions[0]!];
    revision = store.commitState({ scope, expectedRevision: revision, state, eventType: "fixture:move" }).revision;
    context.mock.timers.tick(5 * 60_000);
    state.sessions = [fixture.edited]; state.weekPlan = [fixture.edited.prescription];
    revision = store.commitState({ scope, expectedRevision: revision, state, eventType: "fixture:edit" }).revision;
    for (let i = 0; i < 1000; i++) {
      context.mock.timers.tick(1);
      revision = store.commitState({ scope, expectedRevision: revision, state, eventType: "fixture:metadata" }).revision;
    }
    const instance = state.planInstanceId, id = fixture.initial.sessionId;
    assert.deepEqual(repo.get(scope, instance, id, 1)?.session, fixture.initial);
    assert.deepEqual(repo.effectiveAt(scope, instance, id, "2026-10-25T03:04:59.999Z")?.session, fixture.initial);
    assert.deepEqual(repo.effectiveAt(scope, instance, id, "2026-10-25T03:05:00.000Z")?.session, fixture.moved);
    assert.deepEqual(repo.effectiveAt(scope, instance, id, "2026-10-25T03:10:00.000Z")?.session, fixture.edited);
    assert.equal(repo.forDate(scope, "2026-10-28", "2026-10-26T00:00:00.000Z")[0]?.session.sessionId, id);
    assert.equal(repo.forDate(scope, "2026-10-29", "2026-10-26T00:00:00.000Z").length, 2);
    assert.equal(repo.get(JSON.stringify(["other", "athlete", "epoch"]), instance, id, 1), null);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM mobile_training_session_history").get() as { n: number }).n, 3, "unchanged content never duplicates course history");
    assert.throws(() => repo.append(scope, revision, fixture.edited), /transaction/);
    const changed = structuredClone(state); changed.sessions[0]!.prescription.reason = "silently overwritten";
    changed.sessions[0]!.userOverride!.prescription.reason = "silently overwritten"; changed.weekPlan = [changed.sessions[0]!.prescription];
    assert.throws(() => store.commitState({ scope, expectedRevision: revision, state: changed, eventType: "bad" }), /immutable/);
    assert.equal(store.read(scope)?.revision, revision);
    assert.throws(() => store.commitState({ scope, expectedRevision: revision, state: legacy(), eventType: "downgrade" }), /downgraded/);
    assert.throws(() => store.commitState({ scope, expectedRevision: revision,
      state: { ...state, sessions: [fixture.initial], weekPlan: [fixture.initial.prescription] }, eventType: "regression" }), /regress/);
    assert.throws(() => db.prepare(`INSERT INTO mobile_training_session_history
      (scope,plan_instance_id,session_id,session_revision,state_revision,local_date,available_at,payload_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(scope, "bad-instance", "bad-id", 1, revision, "2026-10-28", fixture.initial.availableAt,
        JSON.stringify({ ...fixture.initial, planInstanceId: "bad-instance", sessionId: "bad-id", lifecycle: "scheduled" })), /CHECK constraint/);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM mobile_training_session_history
      WHERE scope=? AND local_date=? AND available_at<=? ORDER BY available_at,session_id,session_revision LIMIT 50`)
      .all(scope, "2026-10-28", "2026-10-26T00:00:00.000Z");
    assert.match(JSON.stringify(plan), /idx_training_session_history_date/);
    db.prepare("DELETE FROM mobile_training_session_history WHERE scope=? AND session_revision=3").run(scope);
    assert.throws(() => store.read(scope), /matching frozen history/, "damaged current history is never repaired by a read");
  } finally { db.close(); goals.close(); rmSync(root, { recursive: true, force: true }); }
});

test("B02/T22: course history failure rolls back state, history, projection and operation result in the existing publication transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-session-atomic-")), control = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, control), db = new DatabaseSync(control), store = new TrainingPlanStore(db);
  try {
    const old = legacy(); store.applyMigration({ scope, expectedAbsentOrRevision: null, sourceDigest: old.sourceDigest, state: old });
    const state: TrainingPlanSessionState = { ...fixture.payload2, sessions: [fixture.initial], suppressions: [], weekPlan: [fixture.initial.prescription] };
    store.commitState({ scope, expectedRevision: 1, state, eventType: "fixture:upgrade" }, { sessionMigration: true });
    const tables = ["mobile_goals", "mobile_goals_history", "mobile_training_state", "mobile_training_state_history", "mobile_training_session_history", "mobile_plan_operations"];
    const snapshot = () => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    db.exec("CREATE TRIGGER fail_session_history BEFORE INSERT ON mobile_training_session_history BEGIN SELECT RAISE(ABORT,'injected course history failure'); END");
    assert.throws(() => goals.publicationOperation(scope, "fixture-op", "fixture-route", { changed: true }, () => {
      goals.write({ weekPlan: [fixture.moved.prescription] });
      goals.commitTrainingPlanCommandState({ scope, expectedRevision: 2,
        state: { ...state, sessions: [fixture.moved], weekPlan: [fixture.moved.prescription], suppressions: [fixture.payload2.suppressions[0]!] },
        eventType: "fixture:move" });
      return { ok: true };
    }), /injected/);
    assert.deepEqual(snapshot(), before);
  } finally { db.close(); goals.close(); rmSync(root, { recursive: true, force: true }); }
});

test("B02/T25: exact session read negotiation is zero-write and older wire stays identical", async () => {
  const state = parseTrainingPlanState(fixture.payload2);
  const row = { scope, revision: 7, state, updatedAt: state.migratedAt };
  const ordinary = buildTrainingPlanStateV2({ scope: fixture.scope, businessDate: "2026-10-25", row, currentGoalsRevision: 7 });
  assert.equal(ordinary.sessions, undefined);
  assert.deepEqual(buildTrainingPlanStateV2({ scope: fixture.scope, businessDate: "2026-10-25", row, currentGoalsRevision: 7, includeSessions: true }), fixture.wire);
  const app = Fastify(); let legacyCalls = 0;
  app.get("/state", createTrainingPlanStateRoute({ identity: () => fixture.scope, businessDate: () => "2026-10-25",
    readUnifiedState: () => row, readGoalsRevision: () => 7, legacy: () => { legacyCalls++; return { legacy: true }; } }));
  try {
    const first = await app.inject({ method: "GET", url: "/state", headers: { "x-rai-training-contract": "2" } });
    assert.deepEqual(first.json(), ordinary);
    for (let i = 0; i < 2; i++) {
      const read = await app.inject({ method: "GET", url: "/state", headers: { "x-rai-training-contract": "2", "x-rai-training-sessions": "1" } });
      assert.equal(read.statusCode, 200); assert.deepEqual(read.json(), fixture.wire); assert.match(read.headers.vary!, /X-RAI-Training-Sessions/);
    }
    const unknown = await app.inject({ method: "GET", url: "/state", headers: { "x-rai-training-contract": "2", "x-rai-training-sessions": "999" } });
    assert.equal(unknown.statusCode, 409); assert.equal(unknown.json().code, "training_session_contract_unsupported");
    assert.equal(legacyCalls, 0); assert.equal(row.revision, 7);
  } finally { await app.close(); }
});
