import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import type { MobilePlannedDay, TrainingPlanSessionDraft, TrainingPlanSessionCommandRequest, TrainingPlanSessionPreviewRequest } from "@rai/api-contracts";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { parseTrainingPlanState, TrainingPlanStore, type TrainingPlanSessionState } from "../src/training-plan-store.js";
import { TrainingPlanSessionCommandService, createTrainingSessionCommandHandlers, parseTrainingSessionRequest } from "../src/training-plan-session-commands.js";
import { resolveTrainingPlanSessions } from "../src/training-plan-session-policy.js";
import { PlanOperationError } from "../src/plan-publication.js";
import { TrainingPlanCommandService } from "../src/training-plan-commands.js";
import { trainingPlanContextDigest } from "../src/training-mode-policy.js";

const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-sessions-v2.json", import.meta.url), "utf8")) as {
  payload2: TrainingPlanSessionState; initial: TrainingPlanSessionState["sessions"][number]; scope: TrainingPlanSessionPreviewRequest["operationScope"];
};
const scope = fixture.scope, key = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
const instant = "2026-10-25T03:00:00.000Z";
const tables = ["mobile_goals", "mobile_goals_history", "mobile_training_state", "mobile_training_state_history", "mobile_training_session_history", "mobile_plan_operations"];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "rai-session-commands-")), path = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, path), db = new DatabaseSync(path), unified = new TrainingPlanStore(db);
  const initial = structuredClone(fixture.initial);
  initial.protection = "automatic"; initial.userOverride = null;
  const { planInstanceId, sessions, suppressions, publishedInputKey, ...legacy } = fixture.payload2;
  const weekPlan = [initial.prescription];
  goals.write({ weekPlan }, { preserveWeekPlan: true });
  unified.applyMigration({ scope: key, expectedAbsentOrRevision: 0, sourceDigest: legacy.sourceDigest,
    state: parseTrainingPlanState({ ...legacy, schemaVersion: 1, migrationVersion: 1, weekPlan, goalsRevision: goals.read().revision }) });
  unified.commitState({ scope: key, expectedRevision: 1, eventType: "fixture:upgrade", state: {
    ...fixture.payload2, sessions: [initial], suppressions: [], weekPlan, goalsRevision: goals.read().revision
  } }, { sessionMigration: true });
  goals.bindTrainingPlanOwner(() => scope, () => "2026-10-25");
  let now = Date.parse(instant), facts = "facts-1", ready = true, validations = 0;
  const capture = () => {
    if (!ready) throw new PlanOperationError("coach_sync_pending", "facts pending");
    return { fingerprint: facts, prescription: null, validate: () => { validations++; } };
  };
  const service = new TrainingPlanSessionCommandService(goals, () => scope, () => "2026-10-25", capture, () => now);
  const row = () => goals.currentTrainingPlan()!;
  const state = () => row().state as TrainingPlanSessionState;
  const request = (draft: TrainingPlanSessionDraft): TrainingPlanSessionPreviewRequest => ({ contractVersion: 1,
    operationScope: scope, expectedStateRevision: row().revision, planInstanceId: state().planInstanceId, draft });
  const existing = () => ({ sessionId: initial.sessionId, sessionRevision: state().sessions.find(s => s.sessionId === initial.sessionId)!.sessionRevision });
  const command = (draft: TrainingPlanSessionDraft): TrainingPlanSessionCommandRequest => {
    const body = request(draft), preview = service.preview(body);
    return { ...body, candidateId: preview.candidateId, operationId: randomUUID() };
  };
  const snapshot = () => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { root, path, goals, db, unified, service, row, state, request, existing, command, snapshot,
    clock: (value: number) => { now += value; }, facts: () => { facts = "facts-2"; }, busy: () => { ready = false; },
    validations: () => validations, restart: () => new TrainingPlanSessionCommandService(goals, () => scope, () => "2026-10-25", capture, () => now),
    close: () => { db.close(); goals.close(); rmSync(root, { recursive: true, force: true }); } };
}
const code = (expected: string) => (e: unknown) => (e as { code: string }).code === expected;
const easy = (localDate: string, km = 10): MobilePlannedDay => ({ localDate, kind: "easy", distanceKm: km,
  structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: km * 1000 }, alert: null }] }] }, reason: null });

test("B08/S04-03: an unchanged protected course still clears the edit confirmation fence once", async () => {
  const f = setup();
  try {
    f.unified.commitState({ scope: key, expectedRevision: f.row().revision, eventType: "fixture:published-context",
      state: { ...f.state(), planContextDigest: trainingPlanContextDigest(f.state()) } });
    f.service.submit(f.command({ action: "edit", ...f.existing(), patch: { reason: "description only" } }));
    assert.equal(f.goals.read().weekPlanReplanRequired, true);
    const session = structuredClone(f.state().sessions[0]!);
    const before = { state: f.row().revision, goals: f.goals.read().revision };
    const refresh = new TrainingPlanCommandService(f.goals, () => key, () => scope, () => "2026-10-25", () => Date.parse(instant));
    const deps = {
      fingerprint: () => "same-facts",
      prepare: async () => ({ fingerprint: "same-facts", days: f.state().weekPlan, warnings: [], prescription: null,
        audit: { generatedBy: "heuristic" as const, model: null, promptVersion: null, generatedAt: instant } }),
      evaluation: () => ({ inputKey: "edited-input", businessDate: "2026-10-25", policyHash: null, executionDigest: "a".repeat(64) })
    };
    const request = () => ({ contractVersion: 2 as const, operationId: randomUUID(), operationScope: scope, expectedStateRevision: f.row().revision });
    const first = request();
    const result = await refresh.refresh(first, deps);
    assert.equal(result.outcome, "changed", "clearing the confirmation fence is a publication change");
    assert.equal(result.stateRevision, before.state + 1);
    assert.equal(result.goalsRevision, before.goals + 1);
    assert.equal(f.goals.read().weekPlanReplanRequired, false);
    assert.deepEqual(f.state().sessions[0], session, "no course revision is fabricated for clearing a plan fence");
    assert.deepEqual(await refresh.refresh(first, deps), result, "retry replays the original acknowledgement");
    const second = await refresh.refresh(request(), deps);
    assert.equal(second.outcome, "no_change");
    assert.equal(second.stateRevision, result.stateRevision);
    assert.equal(second.goalsRevision, result.goalsRevision);
  } finally { f.close(); }
});

for (const suppression of ["cancelled", "moved"] as const) {
  test(`B04/T13-18: add releases ${suppression} suppression only on its target, and unlock does not lose the new course`, () => {
    const f = setup();
    try {
      f.service.submit(f.command(suppression === "cancelled"
        ? { action: "cancel", ...f.existing() } : { action: "move", ...f.existing(), localDate: "2026-10-29" }));
      f.service.submit(f.command({ action: "set_rest", localDate: "2026-10-30" }));
      const other = structuredClone(f.state().suppressions.find(item => item.localDate === "2026-10-30")!);
      const before = f.snapshot();
      const request = f.request({ action: "add", prescription: easy("2026-10-28", 8) as never });
      const preview = f.service.preview(request);
      assert.deepEqual(f.snapshot(), before, "preview lists the release without writing it");
      assert.ok(preview.impact.warnings.some(warning => warning.includes("释放") && warning.includes("2026-10-28")));
      const command = { ...request, candidateId: preview.candidateId, operationId: randomUUID() };
      const result = f.service.submit(command);
      assert.deepEqual(f.service.submit(command), result);
      assert.equal(f.state().suppressions.some(item => item.localDate === "2026-10-28"), false);
      assert.deepEqual(f.state().suppressions.find(item => item.localDate === "2026-10-30"), other);
      const added = result.session!;
      f.service.submit(f.command({ action: "unlock", sessionId: added.sessionId, sessionRevision: added.sessionRevision }));
      const resolved = resolveTrainingPlanSessions({ state: f.state(), businessDate: "2026-10-25", availableAt: instant,
        generatedDays: [easy("2026-10-28", 8)] });
      assert.equal(resolved.weekPlan.find(day => day.localDate === "2026-10-28")?.kind, "easy");
      assert.ok(resolved.sessions.some(session => session.sessionId === added.sessionId));
      assert.equal(resolved.archivedSessionIds.includes(added.sessionId), false);
    } finally { f.close(); }
  });
}

test("B04/T09–12: preview zero-write; move/edit keep ID, suppress source and survive new-load generation", () => {
  const f = setup();
  try {
    const before = f.snapshot();
    const body = f.command({ action: "move", ...f.existing(), localDate: "2026-10-29" });
    assert.deepEqual(f.snapshot(), before);
    const moved = f.service.submit(body);
    assert.equal(moved.session!.sessionId, fixture.initial.sessionId);
    assert.equal(moved.session!.prescription.localDate, "2026-10-29");
    assert.equal(moved.session!.sessionRevision, 2);
    const edited = f.service.submit(f.command({ action: "edit", ...f.existing(), patch: {
      distanceKm: 10, structure: easy("2026-10-29").structure!, reason: null } }));
    assert.equal(edited.session!.prescription.distanceKm, 10);
    assert.equal(edited.session!.protection, "user_protected");
    const generated = resolveTrainingPlanSessions({ state: f.state(), businessDate: "2026-10-25", availableAt: instant,
      generatedDays: [easy("2026-10-28", 5), easy("2026-10-29", 5)] });
    assert.equal(generated.weekPlan.find(d => d.localDate === "2026-10-28")!.kind, "rest");
    assert.deepEqual(generated.sessions.find(s => s.sessionId === fixture.initial.sessionId), edited.session);
    assert.equal(f.goals.read().weekPlanReplanRequired, true, "editing does not grant execution or claim a device update");
    const reloaded = new MobileGoalsStore(f.root, f.path);
    try { assert.deepEqual(reloaded.trainingPlanStateRow(key), f.row()); } finally { reloaded.close(); }
  } finally { f.close(); }
});

test("B04/T13–18: occupied/rest dates, cancel/add, repeated moves, release and no-op", () => {
  const f = setup();
  try {
    f.service.submit(f.command({ action: "set_rest", localDate: "2026-10-30" }));
    assert.throws(() => f.command({ action: "move", ...f.existing(), localDate: "2026-10-30" }), code("training_session_date_occupied"));
    assert.throws(() => f.command({ action: "set_rest", localDate: "2026-10-28" }), code("training_session_date_occupied"));
    for (const date of ["2026-10-29", "2026-11-02"]) f.service.submit(f.command({ action: "move", ...f.existing(), localDate: date }));
    assert.equal(f.state().suppressions.filter(s => s.reason === "moved").length, 2);
    f.service.submit(f.command({ action: "unlock", ...f.existing() }));
    assert.equal(f.state().sessions[0]!.protection, "automatic");
    assert.equal(f.state().suppressions.filter(s => s.sessionId === fixture.initial.sessionId).length, 0);
    const revision = f.row().revision;
    const noOp = f.service.submit(f.command({ action: "unlock", ...f.existing() }));
    assert.equal(noOp.outcome, "no_change");
    assert.equal(f.row().revision, revision);
    f.service.submit(f.command({ action: "cancel", ...f.existing() }));
    assert.throws(() => f.command({ action: "edit", ...f.existing(), patch: { reason: "no" } }), code("training_session_not_editable"));
    const add = f.request({ action: "add", prescription: easy("2026-11-02") as never });
    const preview = f.service.preview(add);
    const saved = f.service.submit({ ...add, candidateId: preview.candidateId, operationId: randomUUID() });
    assert.equal(saved.session!.sessionId, preview.impact.after!.sessionId, "new identity is bound at preview");
    assert.notEqual(saved.session!.sessionId, fixture.initial.sessionId);
    assert.equal(f.state().sessions.filter(s => s.lifecycle !== "cancelled" && s.prescription.localDate === "2026-11-02").length, 1);
  } finally { f.close(); }
});

test("B04/T19–20: draft, source, scope, instance, TTL and state/session CAS reject with zero business writes", () => {
  const f = setup();
  try {
    const body = f.command({ action: "move", ...f.existing(), localDate: "2026-10-29" });
    const before = f.snapshot();
    assert.throws(() => f.service.submit({ ...body, draft: { ...body.draft, localDate: "2026-10-30" } as TrainingPlanSessionDraft }), code("training_session_candidate_mismatch"));
    assert.throws(() => f.service.preview({ ...f.request({ action: "cancel", ...f.existing() }), planInstanceId: "other" }), code("training_plan_instance_mismatch"));
    assert.throws(() => f.command({ action: "cancel", ...f.existing(), sessionRevision: 100 }), code("training_session_revision_conflict"));
    assert.throws(() => f.service.submit({ ...body, operationScope: { ...scope, datasetEpoch: "other" } }), code("training_scope_mismatch"));
    f.facts();
    assert.throws(() => f.service.submit(body), code("training_session_candidate_mismatch"));
    f.clock(121_000);
    assert.throws(() => f.service.submit(body), code("training_session_candidate_expired"));
    assert.deepEqual(f.snapshot(), before);
    const one = f.command({ action: "cancel", ...f.existing() });
    const two = f.command({ action: "move", ...f.existing(), localDate: "2026-10-29" });
    f.service.submit(one);
    const committed = f.snapshot();
    assert.throws(() => f.service.submit(two), code("training_state_revision_conflict"));
    assert.deepEqual(f.snapshot(), committed);
  } finally { f.close(); }
});

test("B04: committed replay survives restart, disabled capability and expiry without facts/lease/guard writes", async () => {
  const f = setup(), app = Fastify();
  try {
    let admitted = true, leases = 0;
    const handlers = createTrainingSessionCommandHandlers(f.service, () => {
      if (!admitted) throw new PlanOperationError("training_session_commands_disabled", "closed");
    }, async fn => { leases++; return fn(); });
    app.post("/preview", handlers.preview); app.post("/submit", handlers.submit);
    const body = f.command({ action: "move", ...f.existing(), localDate: "2026-10-29" });
    const first = await app.inject({ method: "POST", url: "/submit", payload: body });
    assert.equal(first.statusCode, 200, first.body);
    const after = f.snapshot(), guard = f.goals.publicationGuardState();
    admitted = false; f.busy(); f.clock(121_000);
    const replay = await app.inject({ method: "POST", url: "/submit", payload: body });
    assert.equal(replay.statusCode, 200, replay.body); assert.deepEqual(replay.json(), first.json());
    assert.deepEqual(f.restart().submit(body), first.json());
    assert.equal(leases, 1); assert.deepEqual(f.snapshot(), after); assert.deepEqual(f.goals.publicationGuardState(), guard);
    const different = await app.inject({ method: "POST", url: "/submit", payload: { ...body, candidateId: "different" } });
    assert.equal(different.json().code, "plan_operation_key_conflict");
    const fresh = await app.inject({ method: "POST", url: "/preview", payload: f.request({ action: "cancel", ...f.existing() }) });
    assert.equal(fresh.json().code, "training_session_commands_disabled");
    f.db.exec("UPDATE mobile_plan_operations SET expires_at='2000-01-01T00:00:00.000Z'");
    assert.throws(() => f.service.submit(body), code("plan_operation_expired"));
  } finally { await app.close(); f.close(); }
});

test("B04: cancel and explicit rest remain usable with pending facts; additive edits require facts", () => {
  const f = setup();
  try {
    f.busy();
    assert.throws(() => f.command({ action: "move", ...f.existing(), localDate: "2026-10-29" }), code("coach_sync_pending"));
    f.service.submit(f.command({ action: "cancel", ...f.existing() }));
    f.service.submit(f.command({ action: "set_rest", localDate: "2026-10-30" }));
    assert.equal(f.validations(), 0);
    assert.equal(f.state().sessions[0]!.lifecycle, "cancelled");
  } finally { f.close(); }
});

for (const [table, event] of [["mobile_goals", "UPDATE"], ["mobile_goals_history", "INSERT"],
  ["mobile_training_state", "UPDATE"], ["mobile_training_state_history", "INSERT"],
  ["mobile_training_session_history", "INSERT"], ["mobile_plan_operations", "INSERT"]]) {
  test(`B04/T22: SQL failure at ${table} rolls back the entire move; original candidate can retry`, () => {
    const f = setup();
    try {
      const body = f.command({ action: "move", ...f.existing(), localDate: "2026-10-29" }), before = f.snapshot();
      f.db.exec(`CREATE TRIGGER fail_session BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
      assert.throws(() => f.service.submit(body), /injected failure/);
      assert.deepEqual(f.snapshot(), before); assert.equal(f.goals.publicationGuardState().pendingSince, null);
      f.db.exec("DROP TRIGGER fail_session");
      assert.equal(f.service.submit(body).outcome, "changed");
    } finally { f.close(); }
  });
}

test("B04: strict shape, units, omission/null and coupled structure validation", () => {
  const f = setup();
  try {
    const valid = f.request({ action: "edit", ...f.existing(), patch: { reason: null } });
    assert.equal((parseTrainingSessionRequest(valid, false).draft as { patch: { reason: null } }).patch.reason, null);
    for (const draft of [
      { action: "edit", ...f.existing(), patch: {} }, { action: "edit", ...f.existing(), patch: { structure: null } },
      { action: "edit", ...f.existing(), patch: { unknown: true } }, { action: "edit", ...f.existing(), patch: { distanceKm: 10 } },
      { action: "move", ...f.existing(), localDate: "2026-02-30" }, { action: "move", sessionId: "missing", sessionRevision: 1, localDate: "2026-10-29" },
      { action: "add", prescription: { ...easy("2026-10-30"), structure: null } },
      { action: "add", prescription: { ...easy("2026-10-30"), distanceKm: 10.0001 } },
      { action: "add", prescription: { ...easy("2026-10-30"), structure: { ...easy("2026-10-30").structure, blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 10000.2 }, alert: null }] }] } } }
    ]) assert.throws(() => f.service.preview({ ...valid, draft } as never));
    const before = f.snapshot();
    f.service.submit(f.command({ action: "edit", ...f.existing(), patch: { reason: null } }));
    assert.equal(f.state().sessions[0]!.prescription.reason, null);
    assert.notDeepEqual(f.snapshot(), before);
    assert.equal(f.state().sessions[0]!.prescription.distanceKm, fixture.initial.prescription.distanceKm);
  } finally { f.close(); }
});

test("B04/T21: two independent SQLite clients submit one state revision; only one owns the date", () => {
  const f = setup(), otherGoals = new MobileGoalsStore(f.root, f.path);
  otherGoals.bindTrainingPlanOwner(() => scope, () => "2026-10-25");
  const other = new TrainingPlanSessionCommandService(otherGoals, () => scope, () => "2026-10-25",
    () => ({ fingerprint: "facts-1", prescription: null, validate: () => {} }), () => Date.parse(instant));
  try {
    const one = f.command({ action: "move", ...f.existing(), localDate: "2026-10-29" });
    const input = f.request({ action: "move", ...f.existing(), localDate: "2026-10-30" });
    const preview = other.preview(input);
    const two = { ...input, candidateId: preview.candidateId, operationId: randomUUID() };
    f.service.submit(one);
    assert.throws(() => other.submit(two), code("training_state_revision_conflict"));
    assert.equal(f.state().sessions.filter(s => s.lifecycle === "pending").length, 1);
    assert.equal(f.state().sessions[0]!.prescription.localDate, "2026-10-29");
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM mobile_plan_operations").get() as { n: number }).n, 1);
  } finally { otherGoals.close(); f.close(); }
});

test("B04/T22: business COMMIT failure rolls back the move and all histories/results", context => {
  const f = setup();
  try {
    const body = f.command({ action: "move", ...f.existing(), localDate: "2026-10-29" }), before = f.snapshot();
    const original = DatabaseSync.prototype.exec;
    let fail = true;
    const mock = context.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
      if (sql === "COMMIT" && f.goals.publicationInFlight() && fail) { fail = false; throw new Error("injected business commit failure"); }
      return original.call(this, sql);
    });
    assert.throws(() => f.service.submit(body), /injected business commit failure/);
    mock.mock.restore();
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.goals.publicationGuardState().pendingSince, null);
    assert.equal(f.service.submit(body).outcome, "changed");
  } finally { f.close(); }
});

test("B04/T17: active device evidence is scope-bound and changes invalidate a prepared edit", () => {
  const f = setup();
  try {
    const input = f.request({ action: "move", ...f.existing(), localDate: "2026-10-29" });
    const preview = f.service.preview(input);
    assert.equal(preview.impact.deviceWithdrawalRequired, false);
    f.goals.recordPlanPush({ localDate: "2026-10-28", kind: "easy", revision: f.goals.read().revision,
      structure: fixture.initial.prescription.structure!, pushedAt: instant, scope: { ...scope, datasetEpoch: "other" } });
    assert.equal(f.service.preview(input).impact.deviceWithdrawalRequired, false, "another scope never creates a device obligation here");
    f.goals.recordPlanPush({ localDate: "2026-10-28", kind: "easy", revision: f.goals.read().revision,
      structure: fixture.initial.prescription.structure!, pushedAt: instant, scope });
    assert.equal(f.service.preview(input).impact.deviceWithdrawalRequired, true);
    const before = f.snapshot();
    assert.throws(() => f.service.submit({ ...input, candidateId: preview.candidateId, operationId: randomUUID() }), code("training_session_candidate_mismatch"));
    assert.deepEqual(f.snapshot(), before);
  } finally { f.close(); }
});


test("B04/T21: two OS processes race the same course revision; exactly one atomic move commits", async () => {
  const f = setup();
  const children = ["2026-10-29", "2026-10-30"].map(date => spawn(process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./helpers/training-session-writer.ts", import.meta.url)), f.root, f.path, date],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  const closed = children.map(child => new Promise<void>(resolve => child.once("close", () => resolve())));
  try {
    const prepared = children.map(child => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CAS probe startup timeout")), 30_000);
      child.once("message", () => { clearTimeout(timer); resolve(); });
      child.once("error", reject);
      child.once("exit", code => { clearTimeout(timer); if (code) reject(new Error(`CAS probe exited ${code}`)); });
    }));
    await Promise.all(prepared);
    const results = children.map(child => new Promise<{ outcome?: string; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CAS probe commit timeout")), 30_000);
      child.once("message", result => { clearTimeout(timer); resolve(result as { outcome?: string; error?: string }); });
    }));
    for (const child of children) child.send("commit");
    const outcomes = await Promise.all(results);
    assert.equal(outcomes.filter(result => result.outcome === "changed").length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter(result => result.error === "training_state_revision_conflict").length, 1, JSON.stringify(outcomes));
    assert.equal(f.state().sessions.filter(s => s.lifecycle === "pending").length, 1);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM mobile_plan_operations").get() as { n: number }).n, 1);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(closed);
    f.close();
  }
});

for (const lifecycle of ["completed", "partial", "skipped", "cancelled"] as const) {
  test(`B04/T16: ${lifecycle} history cannot be edited, moved, cancelled or unlocked`, () => {
    const f = setup();
    try {
      const row = f.row(), state = structuredClone(f.state());
      state.sessions[0]!.sessionRevision++;
      state.sessions[0]!.lifecycle = lifecycle;
      state.sessions[0]!.availableAt = instant;
      if (lifecycle === "cancelled") state.weekPlan = [];
      f.goals.withPublicationTransaction(() => {
        const projected = f.goals.write({ weekPlan: state.weekPlan }, { preserveWeekPlan: true, sessionCommand: true });
        f.goals.commitTrainingPlanCommandState({ scope: key, expectedRevision: row.revision,
          state: { ...state, goalsRevision: projected.revision }, eventType: `fixture:${lifecycle}` });
      });
      const before = f.snapshot();
      for (const draft of [
        { action: "move", ...f.existing(), localDate: "2026-10-29" },
        { action: "edit", ...f.existing(), patch: { reason: "must not rewrite execution history" } },
        { action: "cancel", ...f.existing() }, { action: "unlock", ...f.existing() }
      ] as TrainingPlanSessionDraft[]) assert.throws(() => f.service.preview(f.request(draft)), code("training_session_not_editable"));
      assert.deepEqual(f.snapshot(), before);
    } finally { f.close(); }
  });
}
