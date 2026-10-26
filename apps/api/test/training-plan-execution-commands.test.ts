import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MobilePlannedDay, TrainingPlanExecutionCommandRequest, TrainingPlanSession } from "@rai/api-contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { acquireDatabasePublicationLock, RaiDatabase } from "@rai/storage-sqlite";
import { ReadStoreManager } from "../src/read-store-manager.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { parseTrainingPlanState, TrainingPlanStore, type TrainingPlanSessionState } from "../src/training-plan-store.js";
import {
  TrainingPlanExecutionCommandService, createTrainingExecutionCommandHandlers, parseTrainingExecutionRequest, type ExecutionCommandFacts
} from "../src/training-plan-execution-commands.js";
import { executionFactDigest, type ExecutionFact } from "../src/training-plan-execution-match.js";
import { PlanOperationError } from "../src/plan-publication.js";
import { digest } from "../src/plan-digest.js";
import { TrainingPlanCommandService } from "../src/training-plan-commands.js";
import { TrainingPlanSessionCommandService } from "../src/training-plan-session-commands.js";
import { buildTrainingPlanStateV2 } from "../src/training-plan-routes.js";
import { trainingPlanProtectedDays } from "../src/training-plan-session-policy.js";

const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-sessions-v2.json", import.meta.url), "utf8")) as {
  payload2: TrainingPlanSessionState; initial: TrainingPlanSession; scope: TrainingPlanExecutionCommandRequest["operationScope"];
};
const scope = fixture.scope, key = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
const nowInstant = "2026-10-30T03:00:00.000Z";
const businessDate = "2026-10-25";

const interval = (localDate: string): MobilePlannedDay => ({ localDate, kind: "interval", distanceKm: 8,
  structure: { warmup: null, cooldown: null, blocks: [{ iterations: 4, steps: [
    { purpose: "work", goal: { type: "distance", meters: 1000 }, alert: { kind: "pace", lower: 240, upper: 260 } },
    { purpose: "recovery", goal: { type: "time", seconds: 90 }, alert: null }
  ] }] }, reason: null });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rai-execution-commands-")), path = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, path), db = new DatabaseSync(path), unified = new TrainingPlanStore(db);
  const easy = structuredClone(fixture.initial);
  easy.protection = "automatic"; easy.userOverride = null; easy.lifecycle = "pending";
  easy.prescription.localDate = "2026-10-28";
  const hard: TrainingPlanSession = { ...structuredClone(easy), sessionId: "synthetic-interval-session",
    prescription: interval("2026-10-29"), recommendation: null, availableAt: "2026-10-25T03:00:00.000Z" };
  const weekPlan = [easy.prescription, hard.prescription];
  goals.write({ weekPlan }, { preserveWeekPlan: true });
  const { planInstanceId, sessions, suppressions, publishedInputKey, ...legacy } = fixture.payload2;
  unified.applyMigration({ scope: key, expectedAbsentOrRevision: 0, sourceDigest: legacy.sourceDigest,
    state: parseTrainingPlanState({ ...legacy, schemaVersion: 1, migrationVersion: 1, weekPlan, goalsRevision: goals.read().revision }) });
  unified.commitState({ scope: key, expectedRevision: 1, eventType: "fixture:upgrade", state: {
    ...fixture.payload2, sessions: [easy, hard], suppressions: [], weekPlan, goalsRevision: goals.read().revision
  } }, { sessionMigration: true });
  goals.bindTrainingPlanOwner(() => scope, () => businessDate);

  let now = Date.parse(nowInstant);
  let facts: ExecutionFact[] = [];
  const fact = (id: string, startedAt: string, distanceMeters: number, digestSeed = "v1"): ExecutionFact => ({
    trainingSessionId: id, startedAt, endedAt: new Date(Date.parse(startedAt) + 45 * 60_000).toISOString(),
    distanceMeters, durationSeconds: 2700,
    sourceFactDigest: executionFactDigest({ trainingSessionId: id, startedAt,
      endedAt: new Date(Date.parse(startedAt) + 45 * 60_000).toISOString(), distanceMeters, durationSeconds: 2700, updatedAt: digestSeed })
  });
  facts = [fact("run-easy", "2026-10-28T00:00:00.000Z", 8200), fact("run-hard", "2026-10-29T00:00:00.000Z", 8000),
    fact("run-far", "2026-10-31T00:00:00.000Z", 8000)];
  const provider: ExecutionCommandFacts = {
    fingerprint: () => `facts-${facts.map(item => item.sourceFactDigest).join(":")}`,
    candidates: (start, end) => facts.filter(item => item.startedAt.slice(0, 10) >= start && item.startedAt.slice(0, 10) <= end),
    workout: () => null
  };
  const service = new TrainingPlanExecutionCommandService(goals, () => scope, () => businessDate, () => provider, () => now);
  const row = () => goals.currentTrainingPlan()!;
  const state = () => row().state as TrainingPlanSessionState;
  const session = (id = easy.sessionId) => state().sessions.find(item => item.sessionId === id)!;
  const body = (draft: TrainingPlanExecutionCommandRequest["draft"], id = easy.sessionId): TrainingPlanExecutionCommandRequest => ({
    contractVersion: 1, operationId: randomUUID(), operationScope: scope, expectedStateRevision: row().revision,
    planInstanceId: state().planInstanceId, sessionId: id, sessionRevision: session(id).sessionRevision,
    executionRevision: goals.trainingPlanExecution(key, id)?.execution.executionRevision ?? 0, draft
  });
  const execute = (draft: TrainingPlanExecutionCommandRequest["draft"], id = easy.sessionId) => service.submit(body(draft, id));
  return { root, path, goals, db, service, row, state, session, body, execute, facts: () => facts,
    setFacts: (next: ExecutionFact[]) => { facts = next; }, clock: (value: number) => { now += value; },
    now: () => now,
    close: () => { db.close(); goals.close(); rmSync(root, { recursive: true, force: true }); } };
}

const code = (expected: string) => (error: unknown) => (error as { code: string }).code === expected;

for (const cause of ["retract", "source_changed"] as const) {
  test(`B06/S03-04: ${cause} followed by refresh keeps the execution's course readable and correctable`, async () => {
    const f = setup();
    try {
      const source = f.facts()[0]!;
      f.execute({ action: "confirm", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest });
      if (cause === "retract") {
        f.execute({ action: "retract", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest });
      } else {
        f.setFacts(f.facts().map(fact => fact.trainingSessionId === source.trainingSessionId
          ? { ...fact, sourceFactDigest: digest({ corrected: true }) } : fact));
        assert.equal(f.service.reconcileSourceChanges().changed, 1);
      }
      const pending = structuredClone(f.session());
      const executions = () => f.goals.trainingPlanExecutions(key, f.state().planInstanceId);
      assert.equal(pending.lifecycle, "pending");
      assert.ok(trainingPlanProtectedDays(f.state(), executions()).some(day => day.localDate === pending.prescription.localDate),
        "the generator must reserve the course's budget before allocation, even after completion was withdrawn");
      const refresh = new TrainingPlanCommandService(f.goals, () => key, () => scope, () => businessDate, () => Date.parse(nowInstant));
      await refresh.refresh({ contractVersion: 2, operationId: randomUUID(), operationScope: scope,
        expectedStateRevision: f.row().revision }, {
        fingerprint: () => "unchanged-facts",
        prepare: async () => ({ fingerprint: "unchanged-facts", prescription: null, warnings: [],
          audit: { generatedBy: "heuristic", generatedAt: nowInstant, model: null, promptVersion: null },
          days: [{ localDate: pending.prescription.localDate, kind: "rest", distanceKm: null, structure: null, reason: "budget exhausted" },
            f.session("synthetic-interval-session").prescription] })
      });
      const snapshot = buildTrainingPlanStateV2({ scope, businessDate, row: f.row(),
        currentGoalsRevision: f.goals.read().revision, includeSessions: true, executions: executions() });
      assert.ok(snapshot.sessions!.executions!.every(execution =>
        snapshot.sessions!.sessions.some(session => session.sessionId === execution.sessionId)), "no orphan execution is served to iOS");
      assert.deepEqual(f.session(), pending, "refresh preserves the pending course and its original prescription/revision");
      assert.equal(f.goals.trainingPlanExecutionHistory(key, pending.sessionId).length, 2);
      const candidates = f.service.candidates(pending.sessionId, { planInstanceId: f.state().planInstanceId });
      const live = candidates.candidates.find(candidate => candidate.trainingSessionId === source.trainingSessionId)!;
      assert.ok(live, "the review/correction entry remains reachable after refresh");
      const corrected = f.execute({ action: "correct", trainingSessionId: live.trainingSessionId, sourceFactDigest: live.sourceFactDigest });
      assert.equal(corrected.execution!.association, "confirmed");
      assert.equal(corrected.execution!.executionRevision, 3);
      assert.equal(f.session().lifecycle, "completed");
    } finally { f.close(); }
  });
}

test("B06/S03-01: confirm links one ended run, keeps dose/stimulus separate and advances only the course lifecycle it changes", () => {
  const f = setup();
  try {
    const before = f.row().revision;
    const first = f.body({ action: "confirm", trainingSessionId: "run-easy",
      sourceFactDigest: f.facts()[0]!.sourceFactDigest });
    const result = f.service.submit(first);
    assert.equal(result.outcome, "changed");
    assert.equal(result.execution!.association, "confirmed");
    assert.equal(result.execution!.trainingSessionId, "run-easy");
    assert.equal(result.execution!.executionRevision, 1);
    assert.equal(result.execution!.prescriptionSessionRevision, 1);
    assert.equal(result.execution!.assessment!.dose.status, "met", "8.2 km fulfils the 8 km whole-session dose");
    assert.equal(result.execution!.assessment!.stimulus.status, "not_assessable", "a summary cannot prove time-in-target");
    assert.equal(result.session!.lifecycle, "completed");
    assert.equal(result.session!.sessionRevision, 2);
    assert.equal(result.stateRevision, before + 1);
    assert.equal(f.session().lifecycle, "completed");
    assert.equal(f.goals.read().weekPlan.length, 2, "execution does not rewrite the projected week");
    const history = f.goals.trainingPlanExecutionHistory(key, fixture.initial.sessionId);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.execution.association, "confirmed");
    const noOp = f.service.submit(f.body({ action: "correct", trainingSessionId: "run-easy",
      sourceFactDigest: f.facts()[0]!.sourceFactDigest }));
    assert.equal(noOp.outcome, "no_change", "a different key with the same link adds no execution revision");
    assert.equal(noOp.stateRevision, result.stateRevision);
    assert.equal(f.goals.trainingPlanExecutionHistory(key, fixture.initial.sessionId).length, 1);
    assert.deepEqual(f.service.replay(first), result, "the original key replays the stored result without a second write");
  } finally { f.close(); }
});

test("B06/S03-03: explicit dose shortfall is partial; unknown dose stays completed with an unknown assessment", () => {
  const f = setup();
  try {
    const short = f.facts().map(item => item.trainingSessionId === "run-easy" ? { ...item, distanceMeters: 5000 } : item);
    f.setFacts(short);
    const partial = f.execute({ action: "confirm", trainingSessionId: "run-easy", sourceFactDigest: short[0]!.sourceFactDigest });
    assert.equal(partial.execution!.assessment!.dose.status, "partial");
    assert.equal(partial.session!.lifecycle, "partial");
    const unknown = f.execute({ action: "confirm", trainingSessionId: "run-hard", sourceFactDigest: f.facts()[1]!.sourceFactDigest },
      "synthetic-interval-session");
    assert.equal(unknown.execution!.assessment!.dose.status, "not_assessable", "summary-only interval has no measured reps");
    assert.equal(unknown.execution!.assessment!.completion, "unconfirmed");
    assert.equal(unknown.session!.lifecycle, "completed", "an ended linked run is completed even when dose is unknown");
  } finally { f.close(); }
});

test("B06/S03-01/04: correct replaces the link atomically, retract restores pending and history keeps the completed revision", () => {
  const f = setup();
  try {
    f.execute({ action: "confirm", trainingSessionId: "run-easy", sourceFactDigest: f.facts()[0]!.sourceFactDigest });
    const corrected = f.execute({ action: "correct", trainingSessionId: "run-hard", sourceFactDigest: f.facts()[1]!.sourceFactDigest });
    assert.equal(corrected.execution!.executionRevision, 2);
    assert.equal(corrected.execution!.trainingSessionId, "run-hard");
    assert.equal(corrected.execution!.prescriptionSessionRevision, 1);
    assert.equal(corrected.session!.lifecycle, "completed", "the lifecycle did not change, so the course revision stays frozen");
    const retracted = f.execute({ action: "retract", trainingSessionId: "run-hard", sourceFactDigest: f.facts()[1]!.sourceFactDigest });
    assert.equal(retracted.execution!.executionRevision, 3);
    assert.equal(retracted.execution!.association, "invalidated");
    assert.equal(retracted.session!.lifecycle, "pending");
    const history = f.goals.trainingPlanExecutionHistory(key, fixture.initial.sessionId);
    assert.equal(history.length, 3);
    assert.equal(history[0]!.execution.association, "confirmed");
    assert.equal(history[1]!.execution.trainingSessionId, "run-hard");
    assert.ok(history[2]!.execution.reasonCodes.includes("execution_retracted"));
    const reclaimed = f.execute({ action: "confirm", trainingSessionId: "run-hard",
      sourceFactDigest: f.facts()[1]!.sourceFactDigest }, "synthetic-interval-session");
    assert.equal(reclaimed.execution!.trainingSessionId, "run-hard", "the run released by retract can now be claimed by another course");
  } finally { f.close(); }
});

test("B06/S03-04: one run cannot confirm two courses; source corrections and CAS mismatches write nothing", () => {
  const f = setup();
  try {
    const confirmed = f.execute({ action: "confirm", trainingSessionId: "run-easy", sourceFactDigest: f.facts()[0]!.sourceFactDigest });
    const frozen = { state: f.state(), revision: f.row().revision, history: f.goals.trainingPlanExecutionHistory(key, fixture.initial.sessionId) };
    assert.throws(() => f.execute({ action: "confirm", trainingSessionId: "run-easy",
      sourceFactDigest: f.facts()[0]!.sourceFactDigest }, "synthetic-interval-session"), code("training_execution_link_conflict"));
    const wrongRevision = { ...f.body({ action: "retract", trainingSessionId: "run-easy",
      sourceFactDigest: f.facts()[0]!.sourceFactDigest }), expectedStateRevision: frozen.revision - 1 };
    assert.throws(() => f.service.submit(wrongRevision), code("training_state_revision_conflict"));
    const staleExecution = { ...f.body({ action: "retract", trainingSessionId: "run-easy",
      sourceFactDigest: f.facts()[0]!.sourceFactDigest }), executionRevision: 0 };
    assert.throws(() => f.service.submit(staleExecution), code("training_execution_revision_conflict"));
    const changed = f.facts().map(item => item.trainingSessionId === "run-easy"
      ? { ...item, distanceMeters: 9900, sourceFactDigest: digest({ changed: true }) } : item);
    f.setFacts(changed);
    assert.throws(() => f.execute({ action: "confirm", trainingSessionId: "run-easy",
      sourceFactDigest: confirmed.execution!.sourceFactDigest! }, "synthetic-interval-session"),
      code("training_execution_source_changed"), "a corrected fact digest cannot be confirmed as the old identity");
    const retracted = f.execute({ action: "retract", trainingSessionId: "run-easy",
      sourceFactDigest: confirmed.execution!.sourceFactDigest! });
    assert.equal(retracted.execution!.association, "invalidated",
      "retract uses the saved digest and still works after the source changed or was deleted");
    assert.equal(f.session().lifecycle, "pending");
  } finally { f.close(); }
});

test("B06/S03-04: skip is an explicit pending-only decision and never covers a confirmed run", () => {
  const f = setup();
  try {
    const priorFacts = f.facts();
    f.setFacts([]);
    const skipped = f.execute({ action: "skip", reason: "临时出差" }, "synthetic-interval-session");
    assert.equal(skipped.session!.lifecycle, "skipped");
    assert.equal(skipped.execution, null);
    f.setFacts(priorFacts);
    assert.throws(() => f.execute({ action: "confirm", trainingSessionId: "run-hard",
      sourceFactDigest: f.facts()[1]!.sourceFactDigest }, "synthetic-interval-session"), code("training_session_not_editable"));
    f.execute({ action: "confirm", trainingSessionId: "run-easy", sourceFactDigest: f.facts()[0]!.sourceFactDigest });
    assert.throws(() => f.execute({ action: "skip", reason: "again" }), code("training_session_not_editable"),
      "a confirmed run cannot be skipped as if it never happened");
  } finally { f.close(); }
});

test("B06/S03-02: candidate reads are date-filtered, paged and never claim identity without a confirmed link", () => {
  const f = setup();
  try {
    const row = f.state();
    const defaultPage = f.service.candidates(fixture.initial.sessionId, { planInstanceId: row.planInstanceId });
    assert.deepEqual(defaultPage.candidates.map(item => item.trainingSessionId), ["run-easy", "run-hard"]);
    assert.ok(defaultPage.candidates.every(item => item.evidence === "needs_confirmation"));
    assert.equal(defaultPage.rangeStart, "2026-10-26");
    assert.equal(defaultPage.rangeEnd, "2026-10-30");
    assert.equal(defaultPage.executionRevision, 0);
    const expanded = f.service.candidates(fixture.initial.sessionId, { planInstanceId: row.planInstanceId,
      rangeStart: "2026-10-25", rangeEnd: "2026-10-31" });
    assert.deepEqual(expanded.candidates.map(item => item.trainingSessionId), ["run-easy", "run-hard", "run-far"]);
    assert.throws(() => f.service.candidates(fixture.initial.sessionId, { planInstanceId: row.planInstanceId,
      rangeStart: "2026-09-01", rangeEnd: "2026-10-31" }), code("training_session_command_invalid"));
    const paged = f.service.candidates(fixture.initial.sessionId, { planInstanceId: row.planInstanceId,
      rangeStart: "2026-10-25", rangeEnd: "2026-10-31" });
    assert.equal(paged.nextCursor, null);
    f.execute({ action: "confirm", trainingSessionId: "run-easy", sourceFactDigest: f.facts()[0]!.sourceFactDigest });
    const after = f.service.candidates(fixture.initial.sessionId, { planInstanceId: row.planInstanceId });
    assert.equal(after.candidates.find(item => item.trainingSessionId === "run-easy")!.evidence, "verified_identity");
    assert.equal(after.executionRevision, 1);
  } finally { f.close(); }
});

test("B06: strict wire parsing rejects malformed execution drafts before any write", () => {
  const f = setup();
  try {
    assert.throws(() => parseTrainingExecutionRequest({ contractVersion: 1 }), code("training_session_command_invalid"));
    assert.throws(() => parseTrainingExecutionRequest({ contractVersion: 2, operationId: randomUUID(),
      operationScope: scope, expectedStateRevision: 1, planInstanceId: "p", sessionId: "s", sessionRevision: 1,
      executionRevision: 0, draft: { action: "skip", reason: "x" } }), code("training_session_contract_required"));
    assert.throws(() => parseTrainingExecutionRequest({ contractVersion: 1, operationId: randomUUID(),
      operationScope: scope, expectedStateRevision: 1, planInstanceId: "p", sessionId: "s", sessionRevision: 1,
      executionRevision: 0, draft: { action: "confirm", trainingSessionId: "run", sourceFactDigest: "short" } }),
      code("training_session_command_invalid"));
    assert.throws(() => parseTrainingExecutionRequest({ contractVersion: 1, operationId: randomUUID(),
      operationScope: scope, expectedStateRevision: 1, planInstanceId: "p", sessionId: "s", sessionRevision: 1,
      executionRevision: 0, draft: { action: "skip", reason: "" } }), code("training_session_command_invalid"));
  } finally { f.close(); }
});

test("B06/S03-04: a deleted/corrected source invalidates the current link with a new revision, never by guessing on GET", () => {
  const f = setup();
  try {
    f.execute({ action: "confirm", trainingSessionId: "run-easy", sourceFactDigest: f.facts()[0]!.sourceFactDigest });
    assert.equal(f.service.reconcileSourceChanges().changed, 0, "an unchanged source is not rewritten");
    f.setFacts(f.facts().map(item => item.trainingSessionId === "run-easy"
      ? { ...item, distanceMeters: 9900, sourceFactDigest: digest({ corrected: true }) } : item));
    const reconciled = f.service.reconcileSourceChanges();
    assert.equal(reconciled.changed, 1);
    const execution = f.goals.trainingPlanExecution(key, fixture.initial.sessionId)!.execution;
    assert.equal(execution.association, "invalidated");
    assert.equal(execution.executionRevision, 2);
    assert.ok(execution.reasonCodes.includes("execution_source_changed"));
    assert.equal(f.session().lifecycle, "pending");
    assert.equal(f.goals.trainingPlanExecutionHistory(key, fixture.initial.sessionId).length, 2,
      "the original confirmed revision stays readable");
    const revision = f.row().revision;
    assert.equal(f.service.reconcileSourceChanges().changed, 0, "a second tick replays/no-ops instead of adding revisions");
    assert.equal(f.row().revision, revision);
    // The invalidated link can be corrected to the corrected fact after a fresh confirm.
    const corrected = f.execute({ action: "confirm", trainingSessionId: "run-easy",
      sourceFactDigest: f.facts()[0]!.sourceFactDigest });
    assert.equal(corrected.execution!.association, "confirmed");
    assert.equal(corrected.execution!.executionRevision, 3);
  } finally { f.close(); }
});

test("P1.2: superseded and cancelled courses cannot be confirmed, corrected, skipped or used for candidates", () => {
  const f = setup();
  try {
    const row = f.row();
    const state = structuredClone(f.state()) as TrainingPlanSessionState;
    const template = structuredClone(state.sessions[0]!);
    const old: TrainingPlanSession = { ...structuredClone(template), sessionId: "superseded-old", sessionRevision: 1,
      prescription: { ...structuredClone(template.prescription), localDate: "2026-10-27" },
      supersededBySessionId: "replacement-live", protection: "automatic", userOverride: null };
    const replacement: TrainingPlanSession = { ...structuredClone(template), sessionId: "replacement-live",
      sessionRevision: 1, prescription: { ...structuredClone(template.prescription), localDate: "2026-10-27" },
      supersededBySessionId: null, protection: "automatic", userOverride: null };
    const cancelled: TrainingPlanSession = { ...structuredClone(template), sessionId: "cancelled-course",
      sessionRevision: 1, prescription: { ...structuredClone(template.prescription), localDate: "2026-10-26" },
      lifecycle: "cancelled", protection: "automatic", userOverride: null };
    state.sessions.push(old, replacement, cancelled);
    state.weekPlan = [...state.weekPlan, replacement.prescription].sort((left, right) => left.localDate.localeCompare(right.localDate));
    f.goals.withPublicationTransaction(() => {
      const projected = f.goals.write({ weekPlan: state.weekPlan }, { preserveWeekPlan: true, sessionCommand: true });
      f.goals.commitTrainingPlanCommandState({ scope: key, expectedRevision: row.revision,
        state: { ...state, goalsRevision: projected.revision }, eventType: "fixture:superseded-and-cancelled" });
    });
    const planInstanceId = f.state().planInstanceId;
    const expected = code("training_session_not_editable");
    for (const id of ["superseded-old", "cancelled-course"]) {
      assert.throws(() => f.service.candidates(id, { planInstanceId }), expected);
      assert.throws(() => f.execute({ action: "confirm", trainingSessionId: "run-easy",
        sourceFactDigest: f.facts()[0]!.sourceFactDigest }, id), expected);
      assert.throws(() => f.execute({ action: "correct", trainingSessionId: "run-easy",
        sourceFactDigest: f.facts()[0]!.sourceFactDigest }, id), expected);
      assert.throws(() => f.execute({ action: "skip", reason: "stale client" }, id), expected);
    }
    assert.ok(f.service.candidates("replacement-live", { planInstanceId }).candidates.length > 0,
      "the live replacement remains reachable");
  } finally { f.close(); }
});

test("P2.1: correct always re-reads the live source; a deleted/corrected fact is source_changed, never no_change", () => {
  const f = setup();
  try {
    const source = f.facts()[0]!;
    f.execute({ action: "confirm", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest });
    f.setFacts(f.facts().filter(item => item.trainingSessionId !== source.trainingSessionId));
    assert.throws(() => f.execute({ action: "correct", trainingSessionId: source.trainingSessionId,
      sourceFactDigest: source.sourceFactDigest }), code("training_execution_source_changed"));
    f.setFacts([{ ...source, distanceMeters: 9900, sourceFactDigest: digest({ correctedAfterNoop: true }) }]);
    assert.throws(() => f.execute({ action: "correct", trainingSessionId: source.trainingSessionId,
      sourceFactDigest: source.sourceFactDigest }), code("training_execution_source_changed"));
    assert.equal(f.goals.trainingPlanExecution(key, fixture.initial.sessionId)!.execution.association, "confirmed");
  } finally { f.close(); }
});

test("P2.2: reconcile re-reads facts in the transaction and skips a source that recovered before commit", () => {
  const f = setup();
  try {
    const source = f.facts()[0]!;
    f.execute({ action: "confirm", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest });
    const original = f.facts();
    const corrected = original.map(item => item.trainingSessionId === source.trainingSessionId
      ? { ...item, distanceMeters: 9900, sourceFactDigest: digest({ transientCorrection: true }) } : item);
    let calls = 0;
    const provider: ExecutionCommandFacts = {
      fingerprint: () => "stable-facts",
      candidates: () => { calls++; return calls === 1 ? corrected : original; },
      workout: () => null
    };
    const service = new TrainingPlanExecutionCommandService(f.goals, () => scope, () => businessDate,
      () => provider, () => Date.parse(nowInstant));
    const before = businessSnapshot(f.db);
    assert.equal(service.reconcileSourceChanges().changed, 0);
    assert.deepEqual(businessSnapshot(f.db), before, "no-change reconciliation must not save an operation tombstone");
    assert.ok(calls >= 2, "the transaction re-read the candidate instead of trusting the pre-scan");
    const execution = f.goals.trainingPlanExecution(key, fixture.initial.sessionId)!.execution;
    assert.equal(execution.association, "confirmed");
    assert.equal(execution.executionRevision, 1);
    assert.equal(f.goals.trainingPlanExecutionHistory(key, fixture.initial.sessionId).length, 1);
  } finally { f.close(); }
});

test("P1.5: an edit previewed before the run but committed after it is not the pre-run prescription", () => {
  const f = setup();
  try {
    const current = f.session();
    const sessionService = new TrainingPlanSessionCommandService(f.goals, () => scope, () => businessDate,
      () => ({ fingerprint: "session-facts", prescription: null, validate: () => {} }), () => f.now());
    const beforeRun = "2026-10-27T23:59:00.000Z";
    f.clock(Date.parse(beforeRun) - Date.parse(nowInstant));
    const request = { contractVersion: 1 as const, operationScope: scope, expectedStateRevision: f.row().revision,
      planInstanceId: f.state().planInstanceId, draft: { action: "edit" as const, sessionId: current.sessionId,
        sessionRevision: current.sessionRevision, patch: { reason: "written after the run" } } };
    const preview = sessionService.preview(request);
    f.clock(105_000);
    const submitted = sessionService.submit({ ...request, candidateId: preview.candidateId, operationId: randomUUID() });
    assert.equal(submitted.session!.availableAt, "2026-10-28T00:00:45.000Z");
    assert.ok(Date.parse(submitted.session!.availableAt) > Date.parse("2026-10-28T00:00:00.000Z"));
    f.setFacts(f.facts().map(item => item.trainingSessionId === "run-easy"
      ? { ...item, endedAt: "2026-10-28T00:00:30.000Z" } : item));
    const confirmed = f.execute({ action: "confirm", trainingSessionId: "run-easy",
      sourceFactDigest: f.facts()[0]!.sourceFactDigest });
    assert.equal(confirmed.execution!.prescriptionSessionRevision, 1,
      "the run freezes the revision that was actually published before it started");
  } finally { f.close(); }
});

// I-01/P-03: real main-library facts and control publications use separate SQLite files.
async function skipFixture() {
  const f = setup();
  const main = await RaiDatabase.open(join(f.root, "facts.sqlite"));
  const reads = new ReadStoreManager(join(f.root, "facts.sqlite"));
  const provider: ExecutionCommandFacts = {
    fingerprint: () => reads.dataVersionFingerprint(),
    candidates: (start, end) => reads.use(store => store.executionCandidateFacts(start, end)),
    workout: () => null
  };
  const service = new TrainingPlanExecutionCommandService(f.goals, () => scope, () => businessDate, () => provider, () => f.now());
  const control = (f.goals as unknown as { controlDatabase: DatabaseSync }).controlDatabase;
  const addRun = (startedAt = "2026-10-28T00:00:00.000Z") => {
    const endedAt = new Date(Date.parse(startedAt) + 1800_000).toISOString();
    main.database.prepare(`INSERT INTO workouts(id,activity_type,source_name,source_category,source_version,device,
      start_at,end_at,duration_seconds,indoor,metadata_json,raw_attributes_json,is_canonical)
      VALUES ('skip-workout','HKWorkoutActivityTypeRunning','Fixture','apple_watch','1','Watch',?,?,1800,0,'{}','{}',1)`)
      .run(startedAt, endedAt);
    main.database.prepare(`INSERT INTO training_sessions(id,activity_type,anchor_start_at,anchor_end_at,
      anchor_distance_km,canonical_workout_id,status) VALUES ('skip-run','HKWorkoutActivityTypeRunning',?,?,5,'skip-workout','active')`)
      .run(startedAt, endedAt);
  };
  const snapshot = () => Object.fromEntries(["mobile_training_state", "mobile_training_state_history",
    "mobile_training_session_history", "mobile_training_execution", "mobile_training_execution_history",
    "mobile_plan_operations"].map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { ...f, main, reads, provider, service, control, addRun, snapshot,
    close: () => { reads.close(); main.close(); f.close(); } };
}

test("P-03: a new real running fact after an empty page rejects Skip without state/history/receipt writes", async () => {
  const f = await skipFixture();
  try {
    const page = f.service.candidates(f.session().sessionId, { planInstanceId: f.state().planInstanceId });
    assert.equal(page.candidates.length, 0);
    const request = f.body({ action: "skip", reason: "empty page" });
    const before = f.snapshot();
    f.addRun();
    assert.throws(() => f.service.submit(request), code("training_execution_candidates_present"));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.session().lifecycle, "pending");
    assert.equal((f.goals.publicationResult(key, request.operationId) as { status: string }).status, "notFound");
  } finally { f.close(); }
});

for (const point of ["candidate read", "operation receipt"] as const) {
  test(`P-03: a real main-DB version change at ${point} rolls back the whole Skip publication`, async () => {
    const f = await skipFixture();
    try {
      const before = f.snapshot();
      const request = f.body({ action: "skip", reason: "race" });
      if (point === "candidate read") {
        const original = f.provider.candidates;
        f.provider.candidates = (start, end) => { const rows = original(start, end); f.addRun(); return rows; };
      } else {
        // Runs after state/history and result insertion, immediately before the real COMMIT.
        f.control.function("p03_arriving_fact", () => { f.addRun(); return 1; });
        f.control.exec(`CREATE TRIGGER p03_arriving_fact AFTER INSERT ON mobile_plan_operations
          BEGIN SELECT p03_arriving_fact(); END`);
      }
      assert.throws(() => f.service.submit(request), code("training_execution_source_changed"));
      assert.deepEqual(f.snapshot(), before, "no skipped state or partial receipt survives the cross-store conflict");
      assert.equal(f.reads.use(store => store.executionCandidateFacts("2026-10-26", "2026-10-30")).length, 1);
    } finally { f.close(); }
  });
}

test("P-03: empty-window Skip replays unchanged after facts arrive; a fresh duplicate Skip is rejected", async () => {
  const f = await skipFixture();
  try {
    const request = f.body({ action: "skip", reason: "休息" });
    const result = f.service.submit(request);
    assert.equal(result.session!.lifecycle, "skipped");
    const after = f.snapshot();
    f.addRun();
    f.provider.fingerprint = () => { throw new Error("replay must not read facts"); };
    assert.deepEqual(f.service.submit(request), result);
    assert.deepEqual(f.snapshot(), after);
    assert.throws(() => f.service.submit(f.body({ action: "skip", reason: "again" })), code("training_session_not_editable"));
    assert.deepEqual(f.snapshot(), after);
  } finally { f.close(); }
});

for (const failure of ["state", "receipt", "commit"] as const) {
  test(`P-03: SQLite ${failure} failure leaves no Skip or partial operation`, async () => {
    const f = await skipFixture();
    try {
      const request = f.body({ action: "skip", reason: "rollback" });
      const before = f.snapshot();
      if (failure === "commit") {
        f.control.exec(`PRAGMA foreign_keys=ON;
          CREATE TABLE p03_parent(id TEXT PRIMARY KEY);
          CREATE TABLE p03_fault(ref TEXT REFERENCES p03_parent(id) DEFERRABLE INITIALLY DEFERRED);
          CREATE TRIGGER p03_fault AFTER INSERT ON mobile_plan_operations BEGIN INSERT INTO p03_fault VALUES ('missing'); END`);
      } else {
        const table = failure === "state" ? "mobile_training_state" : "mobile_plan_operations";
        const event = failure === "state" ? "UPDATE" : "INSERT";
        f.control.exec(`CREATE TRIGGER p03_fault BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'P03 injected failure'); END`);
      }
      assert.throws(() => f.service.submit(request), failure === "commit" ? /FOREIGN KEY/ : /P03 injected failure/);
      assert.deepEqual(f.snapshot(), before);
    } finally { f.close(); }
  });
}

test("P-03: confirmed association and its immutable history survive a stale Skip", async () => {
  const f = await skipFixture();
  try {
    const stale = f.body({ action: "skip", reason: "stale" });
    f.addRun();
    const fact = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
    f.service.submit(f.body({ action: "confirm", trainingSessionId: fact.trainingSessionId, sourceFactDigest: fact.sourceFactDigest }));
    const before = f.snapshot();
    assert.throws(() => f.service.submit(stale), code("training_state_revision_conflict"));
    assert.throws(() => f.service.submit(f.body({ action: "skip", reason: "already confirmed" })), code("training_session_not_editable"));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.goals.trainingPlanExecution(key, f.session().sessionId)!.execution.association, "confirmed");
  } finally { f.close(); }
});

test("P-03: Skip/Confirm share the fact-writer lease; replay bypasses admission and the lease", async () => {
  const f = await skipFixture();
  try {
    const mutations = new MutationCoordinator(), admission = new TaskAdmissionScheduler(mutations);
    const worker = admission.owner("fact-writer");
    const releaseWorker = worker.acquire()!;
    const request = f.body({ action: "skip", reason: "race" });
    let leases = 0, admitted = true;
    const handlers = createTrainingExecutionCommandHandlers(f.service, () => { assert.ok(admitted); }, async fn => {
      leases++;
      const release = await mutations.acquireWhenAvailable("execution");
      try { assert.equal(worker.acquire(), null, "fact writer cannot change either DB through the coordinated lane"); return await fn(); }
      finally { release(); worker.withdraw(); }
    });
    const req = (body: TrainingPlanExecutionCommandRequest) => ({ body, log: { error() {} } }) as unknown as FastifyRequest;
    const reply = () => ({ statusCode: 200, body: null as unknown, header() { return this; },
      code(value: number) { this.statusCode = value; return this; }, send(value: unknown) { this.body = value; return value; } });
    const skipReply = reply();
    const pendingSkip = handlers.submit(req(request), skipReply as unknown as FastifyReply);
    f.addRun(); releaseWorker();
    const fact = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
    const confirmReply = reply();
    const pendingConfirm = handlers.submit(req(f.body({ action: "confirm", trainingSessionId: fact.trainingSessionId,
      sourceFactDigest: fact.sourceFactDigest })), confirmReply as unknown as FastifyReply);
    await Promise.all([pendingSkip, pendingConfirm]);
    assert.equal(leases, 2);
    assert.equal(confirmReply.statusCode, 200);
    assert.equal(skipReply.statusCode, 409);
    assert.ok(["training_execution_candidates_present", "training_state_revision_conflict"].includes((skipReply.body as {code:string}).code));
    assert.equal(f.session().lifecycle, "partial", "the real 5 km run confirms identity but falls short of the 8 km prescription");
    const confirmed = f.goals.trainingPlanExecution(key, f.session().sessionId)!;
    assert.equal(confirmed.execution.trainingSessionId, "skip-run");
    // A separate empty course can still commit and replay with the gate closed.
    f.main.database.prepare("UPDATE training_sessions SET anchor_start_at='2026-01-01T00:00:00Z'").run();
    const skip = f.body({ action: "skip", reason: "empty" }, "synthetic-interval-session");
    const result = await handlers.submit(req(skip), reply() as unknown as FastifyReply);
    const before = f.snapshot(), leaseCount = leases;
    admitted = false;
    assert.deepEqual(await handlers.submit(req(skip), reply() as unknown as FastifyReply), result);
    assert.equal(leases, leaseCount);
    assert.deepEqual(f.snapshot(), before);
  } finally { f.close(); }
});

function businessSnapshot(db: DatabaseSync) {
  return Object.fromEntries(["mobile_goals", "mobile_goals_history", "mobile_training_state", "mobile_training_state_history",
    "mobile_training_session_history", "mobile_training_execution", "mobile_training_execution_history", "mobile_plan_operations"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function stopExecution(f: ReturnType<typeof setup>, status: "paused" | "ended") {
  const row = f.row();
  f.goals.withPublicationTransaction(() => f.goals.commitTrainingPlanCommandState({ scope: key, expectedRevision: row.revision,
    state: { ...f.state(), runState: "paused", ...(status === "ended" ? { sourceStatus: "ended" as const } : {}) }, eventType: "fixture:stop" }));
}
for (const status of ["paused", "ended"] as const) {
  for (const action of ["confirm", "correct", "skip"] as const) test(`EXEC-01: ${status} rejects new ${action} with stable 409 and zero business writes`, () => {
    const f = setup();
    try {
      const source = f.facts()[0]!;
      if (action === "correct") f.execute({ action: "confirm", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest });
      stopExecution(f, status);
      f.setFacts(action === "skip" ? [] : f.facts());
      const request = f.body(action === "skip" ? { action, reason: "stopped" }
        : { action, trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest });
      const before = businessSnapshot(f.db);
      assert.throws(() => f.service.submit(request), (error: unknown) => error instanceof PlanOperationError &&
        error.statusCode === 409 && error.code === "training_execution_not_active");
      assert.deepEqual(businessSnapshot(f.db), before);
    } finally { f.close(); }
  });
  test(`EXEC-01: ${status} permits saved-identity Retract and committed Confirm replay without authorizing execution`, () => {
    const f = setup();
    try {
      const source = f.facts()[0]!;
      const request = f.body({ action: "confirm", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest });
      const confirmed = f.service.submit(request);
      stopExecution(f, status);
      const before = businessSnapshot(f.db);
      assert.deepEqual(f.service.submit(request), confirmed);
      assert.deepEqual(businessSnapshot(f.db), before);
      f.setFacts([]);
      const result = f.execute({ action: "retract", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest });
      assert.equal(result.execution!.association, "invalidated");
      assert.equal(f.state().runState, "paused");
      assert.equal(f.goals.trainingPlanExecutionHistory(key, f.session().sessionId).length, 2);
    } finally { f.close(); }
  });
}

for (const action of ["confirm", "correct"] as const) {
  for (const point of ["assessment", "receipt", "no-change receipt"] as const) {
    if (action === "confirm" && point === "no-change receipt") continue;
    test(`EXEC-02: ${action} detects real fact change at ${point} and rolls back all control rows`, async () => {
      const f = await skipFixture();
      try {
        f.addRun();
        f.provider.workout = (id, day, asOf) => f.reads.use(store => store.executionWorkout(id, day, asOf));
        let source = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
        if (action === "correct") {
          f.service.submit(f.body({ action: "confirm", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest }));
          if (point !== "no-change receipt") {
            f.main.database.exec("UPDATE training_sessions SET anchor_distance_km=6");
            source = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
          }
        }
        const mutate = () => f.main.database.exec("UPDATE training_sessions SET anchor_distance_km=7");
        if (point === "assessment") {
          const original = f.provider.workout;
          f.provider.workout = (id, day, asOf) => { const value = original(id, day, asOf); mutate(); return value; };
        } else {
          f.control.function("exec02_mutate", () => { mutate(); return 1; });
          f.control.exec(`CREATE TRIGGER exec02_mutate AFTER INSERT ON mobile_plan_operations BEGIN SELECT exec02_mutate(); END`);
        }
        const request = f.body({ action, trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest });
        const before = businessSnapshot(f.db);
        assert.throws(() => f.service.submit(request), code("training_execution_source_changed"));
        assert.deepEqual(businessSnapshot(f.db), before);
        assert.equal(f.db.isTransaction, false);
        assert.equal((f.goals.publicationResult(key, request.operationId) as { status: string }).status, "notFound");
      } finally { f.close(); }
    });
  }
}

test("EXEC-02: candidate and assessment use the same source identity and recorded duration", async () => {
  const f = await skipFixture();
  try {
    f.addRun();
    f.main.database.exec("UPDATE workouts SET duration_seconds=1200");
    const fact = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
    const workout = f.reads.use(store => store.executionWorkout(fact.trainingSessionId, f.session().prescription, nowInstant))!;
    assert.equal(workout.durationSeconds, fact.durationSeconds, "recorded duration is not elapsed wall-clock duration");
    assert.equal(workout.evidenceRef.revisionOrHash, fact.sourceFactDigest);
    assert.equal(workout.distanceMeters, fact.distanceMeters);
  } finally { f.close(); }
});

for (const mismatch of ["id", "digest", "distance", "duration"] as const) test(`EXEC-02: ${mismatch} mismatch in workout assessment rejects without partial claim`, async () => {
  const f = await skipFixture();
  try {
    f.addRun();
    const source = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
    f.provider.workout = (id, day, asOf) => {
      const value = f.reads.use(store => store.executionWorkout(id, day, asOf))!;
      return { ...value, ...(mismatch === "id" ? { id: "another-run" } : {}),
        ...(mismatch === "distance" ? { distanceMeters: 100 } : {}),
        ...(mismatch === "duration" ? { durationSeconds: 100 } : {}),
        evidenceRef: { ...value.evidenceRef, revisionOrHash: mismatch === "digest" ? "0".repeat(64) : source.sourceFactDigest } };
    };
    const before = businessSnapshot(f.db);
    assert.throws(() => f.service.submit(f.body({ action: "confirm", trainingSessionId: source.trainingSessionId,
      sourceFactDigest: source.sourceFactDigest })), code("training_execution_source_changed"));
    assert.deepEqual(businessSnapshot(f.db), before);
  } finally { f.close(); }
});

test("EXEC-03: a fact restored after Reconcile receipt insertion rolls back invalidation and history", async () => {
  const f = await skipFixture();
  try {
    f.addRun();
    const source = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
    f.service.submit(f.body({ action: "confirm", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest }));
    f.main.database.exec("UPDATE training_sessions SET status='inactive'");
    const before = businessSnapshot(f.db);
    f.control.function("exec03_recover", () => { f.main.database.exec("UPDATE training_sessions SET status='active'"); return 1; });
    f.control.exec(`CREATE TRIGGER exec03_recover AFTER INSERT ON mobile_plan_operations BEGIN SELECT exec03_recover(); END`);
    assert.throws(() => f.service.reconcileSourceChanges(), code("training_execution_source_changed"));
    assert.deepEqual(businessSnapshot(f.db), before);
  } finally { f.close(); }
});

test("EXEC-03: HTTP Confirm and background Reconcile use one non-nested fact lease through COMMIT", async () => {
  const f = await skipFixture(), app = Fastify();
  try {
    const mutations = new MutationCoordinator(), admission = new TaskAdmissionScheduler(mutations);
    const worker = admission.owner("fact-writer");
    let acquisitions = 0;
    const handlers = createTrainingExecutionCommandHandlers(f.service, () => {}, async fn => {
      acquisitions++;
      const release = await mutations.acquireWhenAvailable("execution");
      try { assert.equal(worker.acquire(), null); return await fn(); }
      finally { worker.withdraw(); release(); }
    });
    app.post("/execution", handlers.submit);
    let release = worker.acquire()!;
    const background = handlers.reconcile();
    await new Promise(resolve => setImmediate(resolve));
    f.addRun(); release();
    assert.deepEqual(await background, { changed: 0 });
    const fact = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
    const request = f.body({ action: "confirm", trainingSessionId: fact.trainingSessionId, sourceFactDigest: fact.sourceFactDigest });
    const response = await app.inject({ method: "POST", url: "/execution", payload: request });
    assert.equal(response.statusCode, 200);
    release = worker.acquire()!;
    const reconcile = handlers.reconcile();
    await new Promise(resolve => setImmediate(resolve));
    f.main.database.exec("UPDATE training_sessions SET anchor_distance_km=6");
    release();
    assert.deepEqual(await reconcile, { changed: 1 });
    assert.equal(acquisitions, 3, "one acquisition per entry; no nested service lease");
    const before = businessSnapshot(f.db);
    const replay = await app.inject({ method: "POST", url: "/execution", payload: request });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), response.json());
    assert.equal(acquisitions, 3, "committed replay needs no lease or facts");
    assert.deepEqual(businessSnapshot(f.db), before);
  } finally { await app.close(); f.close(); }
});

test("EXEC-02/03: an independent CLI process respects the API publication lock, then Reconcile sees its committed fact", async () => {
  const f = await skipFixture(), app = Fastify();
  let release: (() => void) | undefined;
  try {
    f.addRun();
    const mainPath = join(f.root, "facts.sqlite");
    const child = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { acquireDatabasePublicationLock } from '@rai/storage-sqlite';
      import { DatabaseSync } from 'node:sqlite';
      let release;
      try {
        release = acquireDatabasePublicationLock(process.argv[1], 'cli');
        const db = new DatabaseSync(process.argv[1]);
        db.exec('BEGIN IMMEDIATE');
        db.exec('UPDATE training_sessions SET anchor_distance_km=6');
        db.exec('COMMIT'); db.close();
      } catch { process.exitCode = 9; }
      finally { release?.(); }
    `, mainPath], { encoding: "utf8" });
    release = acquireDatabasePublicationLock(mainPath, "api");
    const mutations = new MutationCoordinator();
    const handlers = createTrainingExecutionCommandHandlers(f.service, () => {}, async fn => {
      const unlock = await mutations.acquireWhenAvailable("execution");
      try { return await fn(); } finally { unlock(); }
    });
    app.post("/execution", handlers.submit);
    f.provider.workout = (id, day, asOf) => {
      assert.equal(child().status, 9, "supported CLI writer cannot enter while API owns main DB");
      return f.reads.use(store => store.executionWorkout(id, day, asOf));
    };
    const source = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
    const response = await app.inject({ method: "POST", url: "/execution", payload: f.body({ action: "confirm",
      trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest }) });
    assert.equal(response.statusCode, 200);
    release(); release = undefined;
    assert.equal(child().status, 0, "CLI commits only after API releases the publication lock");
    release = acquireDatabasePublicationLock(mainPath, "api");
    assert.equal((await handlers.reconcile()).changed, 1);
    const history = f.goals.trainingPlanExecutionHistory(key, f.session().sessionId);
    assert.equal(history.length, 2);
    assert.equal(history[0]!.execution.sourceFactDigest, source.sourceFactDigest);
    assert.equal(history[1]!.execution.association, "invalidated");
  } finally { release?.(); await app.close(); f.close(); }
});

test("EXEC-03: recovery between pre-scan and transaction cannot persist a no-change receipt that masks later deletion", async () => {
  const f = await skipFixture();
  try {
    f.addRun();
    const source = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
    f.service.submit(f.body({ action: "confirm", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest }));
    const original = f.provider.candidates;
    f.main.database.exec("UPDATE training_sessions SET status='inactive'");
    let calls = 0;
    f.provider.candidates = (start, end) => {
      const values = original(start, end);
      if (++calls === 1) f.main.database.exec("UPDATE training_sessions SET status='active'");
      return values;
    };
    const before = businessSnapshot(f.db);
    let raceError: unknown;
    try { f.service.reconcileSourceChanges(); } catch (error) { raceError = error; }
    const afterRace = businessSnapshot(f.db);
    f.provider.candidates = original;
    f.main.database.exec("UPDATE training_sessions SET status='inactive'");
    assert.equal(f.service.reconcileSourceChanges().changed, 1, "later deletion must not replay a poisoned no-change receipt");
    assert.ok(code("training_execution_source_changed")(raceError));
    assert.deepEqual(afterRace, before, "no no-change operation receipt may survive this fact race");
    assert.equal(f.goals.trainingPlanExecutionHistory(key, f.session().sessionId).length, 2);
  } finally { f.close(); }
});

test("EXEC-03: legacy reconcile no-change receipt remains immutable without blocking a new v2 evaluation", async () => {
  const f = await skipFixture();
  try {
    f.addRun();
    const source = f.provider.candidates("2026-10-26", "2026-10-30")[0]!;
    f.service.submit(f.body({ action: "confirm", trainingSessionId: source.trainingSessionId, sourceFactDigest: source.sourceFactDigest }));
    const execution = f.goals.trainingPlanExecution(key, f.session().sessionId)!.execution;
    const operationId = `reconcile-${digest({ contract: "rai-training-execution-reconcile-v1", scope,
      stateRevision: f.row().revision, executions: [{ sessionId: execution.sessionId, executionRevision: execution.executionRevision,
        trainingSessionId: execution.trainingSessionId, sourceFactDigest: execution.sourceFactDigest }] }).slice(0, 40)}`;
    const input = { operationId, operationScope: scope };
    f.goals.publicationOperation(key, operationId, "training-plan-execution-command", input, () => ({ changed: 0 }));
    const saved = f.db.prepare("SELECT * FROM mobile_plan_operations WHERE operation_id=?").get(operationId);
    f.main.database.exec("UPDATE training_sessions SET status='inactive'");
    assert.equal(f.service.reconcileSourceChanges().changed, 1);
    assert.deepEqual(f.db.prepare("SELECT * FROM mobile_plan_operations WHERE operation_id=?").get(operationId), saved);
    assert.deepEqual(f.goals.replayOperation(key, operationId, "training-plan-execution-command", input), { changed: 0 });
  } finally { f.close(); }
});
