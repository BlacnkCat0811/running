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
import { TrainingPlanSessionCommandService, createTrainingSessionCommandHandlers, parseTrainingSessionRequest, trainingSessionCommandRouteOptions } from "../src/training-plan-session-commands.js";
import { resolveTrainingPlanSessions } from "../src/training-plan-session-policy.js";
import { digest } from "../src/plan-digest.js";
import { parseSessionPrescription } from "../src/training-plan-session-state.js";
import { PlanOperationError } from "../src/plan-publication.js";
import { TrainingPlanCommandService } from "../src/training-plan-commands.js";
import { trainingPlanContextDigest } from "../src/training-mode-policy.js";

import { measureStructure, pacesFromZones, roundKm, type CoachZonePrescription } from "../src/mobile-coach.js";
import { buildCompleteCoachWeekPlan } from "../src/coach-complete-plan.js";

const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-sessions-v2.json", import.meta.url), "utf8")) as {
  payload2: TrainingPlanSessionState; initial: TrainingPlanSessionState["sessions"][number]; scope: TrainingPlanSessionPreviewRequest["operationScope"];
};
const scope = fixture.scope, key = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
const instant = "2026-10-25T03:00:00.000Z";
const tables = ["mobile_goals", "mobile_goals_history", "mobile_training_state", "mobile_training_state_history", "mobile_training_session_history", "mobile_plan_operations"];
function setup(day = fixture.initial.prescription, prescription: CoachZonePrescription | null = null) {
  const root = mkdtempSync(join(tmpdir(), "rai-session-commands-")), path = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, path), db = new DatabaseSync(path), unified = new TrainingPlanStore(db);
  const initial = structuredClone(fixture.initial);
  initial.protection = "automatic"; initial.userOverride = null; initial.prescription = structuredClone(day);
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
    return { fingerprint: facts, prescription, validate: () => { validations++; } };
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
  test(`B04/T13-18: add releases ${suppression} suppression on its target, and unlock does not lose the new course`, () => {
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
      assert.ok(preview.impact.warnings.some(warning => warning.includes("释放") && warning.includes("2026-10-28") &&
        warning.includes(suppression === "cancelled" ? "取消记录" : "改期源日")));
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
  // Match server.ts: oneOf validation must never remove fields from a signed command.
  const f = setup(), app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  try {
    let admitted = true, leases = 0;
    const handlers = createTrainingSessionCommandHandlers(f.service, () => {
      if (!admitted) throw new PlanOperationError("training_session_commands_disabled", "closed");
    }, async fn => { leases++; return fn(); });
    app.post("/preview", trainingSessionCommandRouteOptions(false), handlers.preview);
    app.post("/submit", trainingSessionCommandRouteOptions(true), handlers.submit);
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
      { action: "add", prescription: { ...easy("2026-10-30"), distanceKm: 10.002 } },
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

const timeOnly = (localDate: string): MobilePlannedDay => ({ localDate, kind: "easy", distanceKm: null,
  structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1, steps: [{ purpose: "work",
    goal: { type: "time", seconds: 1800 }, alert: null }] }] }, reason: null });
const distanceStructure = (localDate: string, meters: number, distanceKm: number): MobilePlannedDay => ({
  localDate, kind: "easy", distanceKm, structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1,
    steps: [{ purpose: "work", goal: { type: "distance", meters }, alert: null }] }] }, reason: null });

test("P1.3/P2.4: add explicitly releases that day's explicit rest in the same transaction; move still refuses it", () => {
  const f = setup();
  try {
    f.service.submit(f.command({ action: "set_rest", localDate: "2026-10-30" }));
    const rest = structuredClone(f.state().suppressions.find(item => item.localDate === "2026-10-30")!);
    assert.throws(() => f.command({ action: "move", ...f.existing(), localDate: "2026-10-30" }),
      code("training_session_date_occupied"));
    const request = f.request({ action: "add", prescription: easy("2026-10-30", 8) as never });
    const before = f.snapshot();
    const preview = f.service.preview(request);
    assert.deepEqual(f.snapshot(), before, "preview lists the release without writing it");
    assert.ok(preview.impact.warnings.some(warning => warning.includes("明确休息") && warning.includes("2026-10-30")));
    const result = f.service.submit({ ...request, candidateId: preview.candidateId, operationId: randomUUID() });
    assert.equal(result.outcome, "changed");
    assert.equal(f.state().suppressions.some(item => item.localDate === "2026-10-30" && item.reason === "explicit_rest"), false);
    assert.deepEqual(f.state().suppressions.some(item => item.localDate === "2026-10-30"), false);
    assert.equal(f.state().sessions.some(item => item.sessionId === result.session!.sessionId), true);

    f.service.submit(f.command({ action: "set_rest", localDate: "2026-10-31" }));
    const firstRest = structuredClone(f.state().suppressions.find(item => item.localDate === "2026-10-31")!);
    const revision = f.row().revision;
    const again = f.service.submit(f.command({ action: "set_rest", localDate: "2026-10-31" }));
    assert.equal(again.outcome, "no_change");
    assert.deepEqual(f.state().suppressions.find(item => item.localDate === "2026-10-31"), firstRest,
      "set_rest stays idempotent and does not rewrite its decision");
    assert.equal(f.row().revision, revision);
    assert.equal(rest.reason, "explicit_rest");
  } finally { f.close(); }
});

test("P1.4: distance steps require a non-null display distance and compare in whole metres", () => {
  const f = setup();
  try {
    assert.throws(() => f.service.preview(f.request({ action: "add",
      prescription: { ...easy("2026-10-30", 8), distanceKm: null } as never })), code("training_session_command_invalid"));
    assert.throws(() => f.service.preview(f.request({ action: "edit", ...f.existing(), patch: { distanceKm: null } })),
      code("training_session_command_invalid"));
    const time = f.service.preview(f.request({ action: "add", prescription: timeOnly("2026-10-30") as never }));
    assert.equal(time.impact.after!.prescription.distanceKm, null, "a time-only structure may keep distanceKm:null");

    const exact = f.service.preview(f.request({ action: "add", prescription: distanceStructure("2026-10-31", 8050, 8.05) as never }));
    assert.equal(exact.impact.after!.prescription.distanceKm, 8.05);
    assert.throws(() => f.service.preview(f.request({ action: "add",
      prescription: distanceStructure("2026-10-31", 8050, 8.1) as never })),
      code("training_session_command_invalid"), "a rounded 0.1 km display value cannot hide a 50 m mismatch");
  } finally { f.close(); }
});

test("P1.5: preview time is never persisted as the course's availableAt; submit stamps the commit instant", () => {
  const f = setup();
  try {
    const request = f.request({ action: "move", ...f.existing(), localDate: "2026-10-29" });
    const preview = f.service.preview(request);
    f.clock(60_000);
    const submittedAt = new Date(Date.parse(instant) + 60_000).toISOString();
    const result = f.service.submit({ ...request, candidateId: preview.candidateId, operationId: randomUUID() });
    assert.equal(result.session!.availableAt, submittedAt);
    assert.equal(result.session!.userOverride!.availableAt, submittedAt);
    assert.equal(f.state().suppressions.find(item => item.localDate === "2026-10-28")!.availableAt, submittedAt);
    assert.notEqual(result.session!.availableAt, preview.impact.after!.availableAt, "the preview instant is display-only");
  } finally { f.close(); }
});

test("P2.4: move/cancel/set_rest replace only their own suppression and never another course's tombstone", () => {
  const f = setup();
  try {
    // The initial course moves away from 10-28, leaving a moved tombstone there.
    f.service.submit(f.command({ action: "move", ...f.existing(), localDate: "2026-10-29" }));
    const initialTombstone = structuredClone(f.state().suppressions.find(item =>
      item.localDate === "2026-10-28" && item.sessionId === fixture.initial.sessionId)!);
    // A new course is added elsewhere, then moved onto the tombstoned source date.
    // Move must not release the tombstone; only add may explicitly release it.
    const added = f.service.submit(f.command({ action: "add", prescription: easy("2026-10-30", 8) as never })).session!;
    f.service.submit(f.command({ action: "move", sessionId: added.sessionId, sessionRevision: added.sessionRevision, localDate: "2026-10-28" }));
    assert.deepEqual(f.state().suppressions.find(item => item.localDate === "2026-10-28" && item.sessionId === fixture.initial.sessionId),
      initialTombstone, "moving onto the date never deletes another course's tombstone");
    // Moving the new course exits 10-28; its own tombstone is added while the other remains.
    const atSource = f.state().sessions.find(item => item.sessionId === added.sessionId)!;
    f.service.submit(f.command({ action: "move", sessionId: added.sessionId, sessionRevision: atSource.sessionRevision, localDate: "2026-10-31" }));
    const moved = f.state();
    assert.equal(moved.suppressions.filter(item => item.localDate === "2026-10-28" && item.reason === "moved").length, 2);
    assert.deepEqual(moved.suppressions.find(item => item.localDate === "2026-10-28" && item.sessionId === fixture.initial.sessionId),
      initialTombstone);
    // Move it back and cancel it on 10-28: its cancelled tombstone must not erase the first one.
    const back = f.state().sessions.find(item => item.sessionId === added.sessionId)!;
    f.service.submit(f.command({ action: "move", sessionId: added.sessionId, sessionRevision: back.sessionRevision, localDate: "2026-10-28" }));
    const current = f.state().sessions.find(item => item.sessionId === added.sessionId)!;
    f.service.submit(f.command({ action: "cancel", sessionId: added.sessionId, sessionRevision: current.sessionRevision }));
    assert.deepEqual(f.state().suppressions.find(item => item.localDate === "2026-10-28" && item.sessionId === fixture.initial.sessionId),
      initialTombstone, "cancel only replaces the cancelled course's own suppression");
    // set_rest adds explicit rest without deleting either tombstone.
    f.service.submit(f.command({ action: "set_rest", localDate: "2026-10-28" }));
    const final = f.state().suppressions.filter(item => item.localDate === "2026-10-28");
    assert.equal(final.length, 3);
    assert.ok(final.some(item => item.reason === "explicit_rest" && item.sessionId === null));
    assert.ok(final.some(item => item.reason === "moved" && item.sessionId === fixture.initial.sessionId));
    assert.ok(final.some(item => item.reason === "cancelled" && item.sessionId === added.sessionId));
  } finally { f.close(); }
});


// D-01/D-02: one frozen semantic baseline is consumed by Node and native Swift.
const distanceFixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-session-distance-v1.json", import.meta.url), "utf8")) as {
  generatorInput: Parameters<typeof buildCompleteCoachWeekPlan>[0];
  cases: Array<{ id: string; generated: boolean; prescription: MobilePlannedDay;
    measured: { distanceKm: number; durationSeconds: number }; displayDistanceKm: number; editorDistanceMode: string }>;
};
const distanceZones = distanceFixture.generatorInput.prescription;

test("D-01/D-02: frozen easy/interval/tempo are actual generated courses; measured and display values stay distinct", () => {
  const generated = buildCompleteCoachWeekPlan(distanceFixture.generatorInput);
  for (const item of distanceFixture.cases) {
    if (item.generated) assert.deepEqual(generated.find(day => day.kind === item.prescription.kind), item.prescription);
    const measured = measureStructure(item.prescription.structure!, item.prescription.kind, pacesFromZones(distanceZones));
    assert.ok(Math.abs(measured.distanceKm - item.measured.distanceKm) < 1e-9, item.id);
    assert.ok(Math.abs(measured.durationSeconds - item.measured.durationSeconds) < 1e-9, item.id);
    assert.equal(roundKm(measured.distanceKm), item.displayDistanceKm, item.id);
  }
});

for (const item of distanceFixture.cases) {
  test(`D-01: ${item.id} original full payload previews/submits without changing its persisted dose`, () => {
    const f = setup(item.prescription, distanceZones);
    try {
      const before = f.snapshot(), { localDate, ...patch } = item.prescription;
      const request = f.request({ action: "edit", ...f.existing(), patch: patch as never });
      const preview = f.service.preview(request);
      assert.deepEqual(f.snapshot(), before, "preview is read-only");
      assert.deepEqual(preview.impact.after!.prescription, item.prescription);
      const command = { ...request, candidateId: preview.candidateId, operationId: randomUUID() };
      const result = f.service.submit(command);
      assert.deepEqual(result.session!.prescription, item.prescription);
      assert.deepEqual(f.state().weekPlan[0], item.prescription);
      assert.deepEqual(f.service.submit(command), result, "replay retains exact acknowledgement");
    } finally { f.close(); }
  });
}

test("D-01: historical rounding cannot mask changed steps, type, targets or fabricated totals", () => {
  for (const item of distanceFixture.cases.filter(item => item.generated || item.id === "historical-distance-only")) {
    const f = setup(item.prescription, distanceZones);
    try {
      const before = f.snapshot();
      const structure = structuredClone(item.prescription.structure!);
      const goal = structure.blocks[0]!.steps[0]!.goal;
      if (goal.type === "time") goal.seconds += 1;
      if (goal.type === "distance") goal.meters += 1;
      const targeted = structuredClone(item.prescription.structure!);
      targeted.blocks[0]!.steps[0]!.alert = { kind: "heart_rate", lower: 100, upper: 150 };
      for (const patch of [
        { structure }, { structure: targeted },
        { kind: item.prescription.kind === "easy" ? "recovery" : "easy" },
        { distanceKm: item.prescription.distanceKm! + 0.1 }, { distanceKm: 0 }
      ]) assert.throws(() => f.service.preview(f.request({ action: "edit", ...f.existing(), patch: { ...patch,
        distanceKm: "distanceKm" in patch ? patch.distanceKm : item.prescription.distanceKm } as never })), code("training_session_command_invalid"), item.id);
      assert.deepEqual(f.snapshot(), before);
    } finally { f.close(); }
  }
});

test("D-02: omitted distance delegates changed mixed dose to server; null/zero/rounded explicit totals stay strict", () => {
  const item = distanceFixture.cases.find(item => item.id === "mixed")!;
  const f = setup(item.prescription, distanceZones);
  try {
    const structure = structuredClone(item.prescription.structure!);
    structure.blocks[0]!.iterations = 5;
    const measured = measureStructure(structure, "interval", pacesFromZones(distanceZones));
    const draft: TrainingPlanSessionDraft = { action: "edit", ...f.existing(), patch: { structure, reason: "one extra repetition" } };
    const request = f.request(draft), before = f.snapshot();
    const preview = f.service.preview(request);
    const expected = Math.round(measured.distanceKm * 1000) / 1000;
    assert.equal(preview.impact.after!.prescription.distanceKm, expected);
    assert.deepEqual(preview.impact.after!.prescription.structure, structure);
    assert.deepEqual(f.snapshot(), before);
    for (const distanceKm of [null, 0, 5, roundKm(measured.distanceKm)]) {
      assert.throws(() => f.service.preview(f.request({ ...draft, patch: { structure, distanceKm } })), code("training_session_command_invalid"));
    }
    const command = { ...request, candidateId: preview.candidateId, operationId: randomUUID() };
    f.facts();
    assert.throws(() => f.service.submit(command), code("training_session_candidate_mismatch"));
    assert.deepEqual(f.snapshot(), before, "failed submit writes no partial state, history or operation");
    const result = f.service.submit(f.command(draft));
    assert.equal(result.session!.prescription.distanceKm, expected);
    assert.deepEqual(result.session!.prescription.structure, structure);
  } finally { f.close(); }
});

test("D-02: add omission computes on server; pure time keeps null; explicit old-client exact totals remain accepted", () => {
  const f = setup();
  const service = new TrainingPlanSessionCommandService(f.goals, () => scope, () => "2026-10-25", () => ({
    fingerprint: "distance-fixture", prescription: distanceZones, validate: () => {} }));
  try {
    for (const item of distanceFixture.cases) {
      const { distanceKm, ...prescription } = item.prescription;
      const request = f.request({ action: "add", prescription: { ...prescription, localDate: "2026-11-02" } as never });
      const preview = service.preview(request);
      const hasDistance = JSON.stringify(prescription.structure).includes('"type":"distance"');
      assert.equal(preview.impact.after!.prescription.distanceKm,
        hasDistance ? Math.round(item.measured.distanceKm * 1000) / 1000 : null, item.id);
      const exact = { ...prescription, localDate: "2026-11-02", distanceKm: hasDistance ? Math.round(item.measured.distanceKm * 1000) / 1000 : null };
      assert.equal(service.preview(f.request({ action: "add", prescription: exact as never })).impact.after!.prescription.distanceKm, exact.distanceKm);
    }
    const before = f.snapshot();
    for (const prescription of [distanceStructure("2026-11-02", 80001, 80.001),
      { ...timeOnly("2026-11-02"), structure: { warmup: null, cooldown: null, blocks: [{ iterations: 2, steps: [{ purpose: "work", goal: { type: "time", seconds: 14400 }, alert: null }] }] } }]) {
      assert.throws(() => service.preview(f.request({ action: "add", prescription: prescription as never })), code("training_session_command_invalid"));
    }
    assert.deepEqual(f.snapshot(), before);
  } finally { f.close(); }
});


test("D-01/D-02: shared native omission/null/value payloads preserve unchanged dose; legal structure adjustments remeasure", () => {
  for (const item of distanceFixture.cases) {
    const f = setup(item.prescription, distanceZones);
    try {
      const { localDate, distanceKm, ...content } = item.prescription;
      const patch = { ...content, ...(item.editorDistanceMode === "omit" ? {} : { distanceKm }) };
      const preview = f.service.preview(f.request({ action: "edit", ...f.existing(), patch: patch as never }));
      assert.deepEqual(preview.impact.after!.prescription, item.prescription, item.id);
      const structure = structuredClone(item.prescription.structure!);
      structure.blocks[0]!.iterations += 1;
      const measured = measureStructure(structure, item.prescription.kind, pacesFromZones(distanceZones));
      const adjusted = f.service.submit(f.command({ action: "edit", ...f.existing(), patch: { structure } }));
      const hasDistance = JSON.stringify(structure).includes('"type":"distance"');
      assert.equal(adjusted.session!.prescription.distanceKm, hasDistance ? Math.round(measured.distanceKm * 1000) / 1000 : null, item.id);
      assert.deepEqual(adjusted.session!.prescription.structure, structure, "measurement never scales the requested structure");
    } finally { f.close(); }
  }
});

test("D-01: unchanged but corrupt historical totals are not accepted as legacy rounding", () => {
  const item = distanceFixture.cases.find(item => item.id === "interval")!;
  const day = { ...item.prescription, distanceKm: item.prescription.distanceKm! + 0.1 };
  const f = setup(day, distanceZones);
  try {
    const before = f.snapshot();
    assert.throws(() => f.service.preview(f.request({ action: "edit", ...f.existing(), patch: {
      kind: day.kind as never, structure: day.structure!, distanceKm: day.distanceKm
    } })), code("training_session_command_invalid"));
    assert.deepEqual(f.snapshot(), before);
  } finally { f.close(); }
});


test("D-02: COMMIT failure rolls back a server-measured mixed edit, projection, override and operation", context => {
  const item = distanceFixture.cases.find(item => item.id === "mixed")!;
  const f = setup(item.prescription, distanceZones);
  try {
    const structure = structuredClone(item.prescription.structure!);
    structure.blocks[0]!.iterations = 5;
    const body = f.command({ action: "edit", ...f.existing(), patch: { structure } }), before = f.snapshot();
    const original = DatabaseSync.prototype.exec;
    let fail = true;
    const mock = context.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
      if (sql === "COMMIT" && f.goals.publicationInFlight() && fail) { fail = false; throw new Error("injected measured-dose COMMIT failure"); }
      return original.call(this, sql);
    });
    assert.throws(() => f.service.submit(body), /injected measured-dose COMMIT failure/);
    mock.mock.restore();
    assert.deepEqual(f.snapshot(), before, "all six business/history/result tables remain unchanged");
    assert.equal(f.goals.publicationGuardState().pendingSince, null);
    const result = f.service.submit(body);
    assert.equal(result.session!.prescription.distanceKm,
      Math.round(measureStructure(structure, item.prescription.kind, pacesFromZones(distanceZones)).distanceKm * 1000) / 1000);
    assert.deepEqual(result.session!.prescription.structure, structure);
  } finally { f.close(); }
});


// D-03: synthetic structures keep quantity tests independent of weekly safety.
function quantityCourse(steps = 1, blocks = 1, iterations = 1): MobilePlannedDay & { kind: "easy"; structure: NonNullable<MobilePlannedDay["structure"]> } {
  return { ...easy("2026-10-28"), kind: "easy", distanceKm: null, structure: { warmup: null, cooldown: null,
    blocks: Array.from({ length: blocks }, () => ({ iterations,
      steps: Array.from({ length: steps }, () => ({ purpose: "work" as const,
        goal: { type: "distance" as const, meters: 100 }, alert: null })) })) } };
}
const allControlTables = (db: DatabaseSync) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(row => ({ table: row.name, rows: db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all() }));

for (const [label, steps, blocks, iterations, accepted] of [
  ["8 steps", 8, 1, 1, true], ["9 steps", 9, 1, 1, false],
  ["8 blocks", 1, 8, 1, true], ["9 blocks", 1, 9, 1, false],
  ["20 iterations", 1, 1, 20, true], ["21 iterations", 1, 1, 21, false]
] as const) {
  for (const action of ["add", "edit"] as const) test(`D-03: direct ${action} ${label} ${accepted ? "accepted" : "rejected"}`, () => {
    const f = setup();
    try {
      const { localDate, distanceKm, ...patch } = quantityCourse(steps, blocks, iterations);
      const draft: TrainingPlanSessionDraft = action === "add"
        ? { action, prescription: { localDate: "2026-10-29", ...patch } as never }
        : { action, ...f.existing(), patch };
      const request = f.request(draft), before = allControlTables(f.db);
      if (accepted) {
        const preview = f.service.preview(request);
        assert.deepEqual(allControlTables(f.db), before, "preview must write nothing");
        const command = { ...request, operationId: randomUUID(), candidateId: preview.candidateId };
        const result = f.service.submit(command);
        assert.deepEqual(result.session!.prescription.structure, patch.structure);
        assert.deepEqual(f.service.submit(command), result);
      } else {
        assert.throws(() => f.service.preview(request), code("training_session_command_invalid"));
        assert.throws(() => f.service.submit({ ...request, operationId: randomUUID(), candidateId: "unissued" }),
          code("training_session_command_invalid"));
        assert.deepEqual(allControlTables(f.db), before, "every control table, history and receipt stays unchanged");
      }
    } finally { f.close(); }
  });
}

test("D-03: API preview/submit reject nine steps without writes", async () => {
  const f = setup(), app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  try {
    const handlers = createTrainingSessionCommandHandlers(f.service, () => {}, async fn => fn());
    app.post("/preview", trainingSessionCommandRouteOptions(false), handlers.preview);
    app.post("/submit", trainingSessionCommandRouteOptions(true), handlers.submit);
    const { distanceKm, ...prescription } = quantityCourse(9);
    const request = f.request({ action: "add", prescription: { ...prescription, localDate: "2026-10-29" } as never });
    const before = allControlTables(f.db);
    const preview = await app.inject({ method: "POST", url: "/preview", payload: request });
    assert.equal(preview.statusCode, 422, preview.body);
    assert.equal(preview.json().code, "training_session_command_invalid");
    const submit = await app.inject({ method: "POST", url: "/submit", payload: {
      ...request, operationId: randomUUID(), candidateId: "unissued" } });
    assert.equal(submit.statusCode, 422, submit.body);
    assert.equal(submit.json().code, "training_session_command_invalid");
    assert.deepEqual(allControlTables(f.db), before);
  } finally { await app.close(); f.close(); }
});

test("D-03: persisted nine-step courses remain lossless; metadata edits survive, dose edits require legal replacement", () => {
  const original = quantityCourse(9); original.distanceKm = 0.9;
  const f = setup(original);
  try {
    assert.deepEqual(f.state().sessions[0]!.prescription, original);
    assert.deepEqual(f.goals.read().weekPlan[0], original);
    const oldHistory = f.db.prepare("SELECT * FROM mobile_training_session_history ORDER BY rowid").all();
    f.service.submit(f.command({ action: "edit", ...f.existing(), patch: { reason: "preserve all nine historical steps" } }));
    assert.deepEqual(f.state().sessions[0]!.prescription.structure, original.structure);
    f.service.submit(f.command({ action: "move", ...f.existing(), localDate: "2026-10-29" }));
    assert.deepEqual(f.state().sessions[0]!.prescription.structure, original.structure);
    const before = allControlTables(f.db);
    for (const patch of [{ kind: "interval" as const }, { distanceKm: 0.9 }, { structure: original.structure }]) {
      assert.throws(() => f.service.preview(f.request({ action: "edit", ...f.existing(), patch })), code("training_session_command_invalid"));
    }
    assert.deepEqual(allControlTables(f.db), before);
    const replacement = quantityCourse(8).structure!;
    f.service.submit(f.command({ action: "edit", ...f.existing(), patch: { structure: replacement } }));
    assert.deepEqual(f.state().sessions[0]!.prescription.structure, replacement);
    assert.deepEqual(f.db.prepare("SELECT * FROM mobile_training_session_history ORDER BY rowid").all().slice(0, oldHistory.length), oldHistory,
      "repair appends a new revision; old prescriptions are not rewritten");
  } finally { f.close(); }
});


for (const [label, goals, iterations, accepted] of [
  ["80 km", [80_000], 1, true], ["80 km plus one metre", [80_001], 1, false],
  ["80 km through iterations", [4_000], 20, true], ["over 80 km through iterations", [4_001], 20, false],
  ["4 hours", [14_400], 1, true], ["step over 4 hours", [14_401], 1, false],
  ["4 hours through steps", [7_200, 7_200], 1, true], ["over 4 hours through steps", [7_200, 7_201], 1, false],
  ["4 hours through iterations", [720], 20, true], ["over 4 hours through iterations", [721], 20, false]
] as const) test(`D-03: dose boundary ${label}`, () => {
  const isTime = label.includes("hours");
  const f = setup(undefined, { ...distanceZones!, easyPaceUpper: isTime ? 400 : 150 });
  try {
    const prescription = { localDate: "2026-10-29", kind: "easy" as const, structure: { warmup: null, cooldown: null,
      blocks: [{ iterations, steps: goals.map(amount => ({ purpose: "work" as const, alert: null,
        goal: isTime ? { type: "time" as const, seconds: amount } : { type: "distance" as const, meters: amount } })) }] } };
    const request = f.request({ action: "add", prescription }), before = allControlTables(f.db);
    if (accepted) {
      const preview = f.service.preview(request);
      assert.deepEqual(allControlTables(f.db), before);
      const result = f.service.submit({ ...request, operationId: randomUUID(), candidateId: preview.candidateId });
      assert.deepEqual(result.session!.prescription.structure, prescription.structure);
    } else {
      assert.throws(() => f.service.preview(request), code("training_session_command_invalid"));
      assert.deepEqual(allControlTables(f.db), before);
    }
  } finally { f.close(); }
});

test("D-03: lossless shape reader retains single-step metre/second ceilings", () => {
  for (const [field, limit] of [["meters", 100_000], ["seconds", 14_400]] as const) {
    const type = field === "meters" ? "distance" : "time";
    const day = { ...easy("2026-10-28"), distanceKm: null, structure: { warmup: null, cooldown: null,
      blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type, [field]: Number(limit) }, alert: null }] }] } };
    assert.deepEqual(parseSessionPrescription(day), day);
    day.structure.blocks[0]!.steps[0]!.goal[field] = limit + 1;
    assert.throws(() => parseSessionPrescription(day), /structure would lose or normalize fields/);
  }
});

test("D-03: a committed historical nine-step operation replays ahead of schema/capability/new-write gates", async () => {
  const f = setup(), app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  try {
    const { distanceKm, ...prescription } = quantityCourse(9);
    const request = { ...f.request({ action: "add", prescription: { ...prescription, localDate: "2026-10-29" } }),
      operationId: randomUUID(), candidateId: "historical-candidate" };
    // Seed an old immutable receipt, not a new business write under today's validator.
    const historicalSession = { ...structuredClone(fixture.initial), prescription: { ...prescription, distanceKm: 0.9 } };
    const result = { contractVersion: 1, operationId: request.operationId, stateRevision: 2, goalsRevision: 1,
      planInstanceId: request.planInstanceId, outcome: "changed", session: historicalSession, execution: null,
      planUpdate: "pending", warnings: [] };
    f.db.prepare("INSERT INTO mobile_plan_operations(scope,operation_id,request_digest,result_json,expires_at) VALUES(?,?,?,?,?)")
      .run(key, request.operationId, digest({ route: "training-plan-session-command", input: request }), JSON.stringify(result), "2099-01-01T00:00:00.000Z");
    const before = allControlTables(f.db);
    f.busy();
    const handlers = createTrainingSessionCommandHandlers(f.service, () => { throw new Error("replay must not admit"); },
      async () => { throw new Error("replay must not capture facts"); });
    app.post("/submit", trainingSessionCommandRouteOptions(true), handlers.submit);
    assert.deepEqual(f.service.submit(request), result);
    const replay = await app.inject({ method: "POST", url: "/submit", payload: request });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), result);
    assert.deepEqual(allControlTables(f.db), before);
    const fresh = await app.inject({ method: "POST", url: "/submit", payload: { ...request, operationId: randomUUID() } });
    assert.equal(fresh.statusCode, 422);
    assert.equal(fresh.json().code, "training_session_command_invalid");
    assert.deepEqual(allControlTables(f.db), before);
  } finally { await app.close(); f.close(); }
});

test("D-03: production route options share OpenAPI schemas and reject coercion without changing errors", async () => {
  const f = setup(), app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  try {
    const handlers = createTrainingSessionCommandHandlers(f.service, () => {}, async fn => fn());
    app.post("/preview", trainingSessionCommandRouteOptions(false), handlers.preview);
    app.post("/submit", trainingSessionCommandRouteOptions(true), handlers.submit);
    const { distanceKm, ...prescription } = quantityCourse(8);
    const request = f.request({ action: "add", prescription: { ...prescription, localDate: "2026-10-29" } });
    const before = allControlTables(f.db);
    for (const input of [
      { ...request, expectedStateRevision: String(request.expectedStateRevision) },
      { ...request, extra: true }, { ...request, contractVersion: 2 },
      { ...request, draft: { ...request.draft, prescription: { ...prescription, structure: {
        ...prescription.structure, blocks: [{ ...prescription.structure.blocks[0], iterations: "1" }] } } } }
    ]) {
      const response = await app.inject({ method: "POST", url: "/preview", payload: input });
      assert.equal(response.statusCode, 422, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.json().code, input.contractVersion === 2 ? "training_session_contract_required" : "training_session_command_invalid");
      assert.deepEqual(allControlTables(f.db), before);
    }
    const preview = await app.inject({ method: "POST", url: "/preview", payload: request });
    assert.equal(preview.statusCode, 200, preview.body);
    const command = { ...request, operationId: randomUUID(), candidateId: preview.json().candidateId };
    const invalid = structuredClone(command);
    if (invalid.draft.action !== "add") throw new Error("add expected");
    invalid.draft.prescription.structure.blocks[0]!.steps.push({ purpose: "work", goal: { type: "distance", meters: 100 }, alert: null });
    const rejected = await app.inject({ method: "POST", url: "/submit", payload: invalid });
    assert.equal(rejected.statusCode, 422, rejected.body);
    assert.deepEqual(allControlTables(f.db), before);
    const submitted = await app.inject({ method: "POST", url: "/submit", payload: command });
    assert.equal(submitted.statusCode, 200, submitted.body);
  } finally { await app.close(); f.close(); }
});
