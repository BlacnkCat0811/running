import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MobilePlannedDay, TrainingPlanExecutionCommandRequest, TrainingPlanSession } from "@rai/api-contracts";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { parseTrainingPlanState, TrainingPlanStore, type TrainingPlanSessionState } from "../src/training-plan-store.js";
import {
  TrainingPlanExecutionCommandService, parseTrainingExecutionRequest, type ExecutionCommandFacts
} from "../src/training-plan-execution-commands.js";
import { executionFactDigest, type ExecutionFact } from "../src/training-plan-execution-match.js";
import { PlanOperationError } from "../src/plan-publication.js";
import { digest } from "../src/plan-digest.js";
import { TrainingPlanCommandService } from "../src/training-plan-commands.js";
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
    const skipped = f.execute({ action: "skip", reason: "临时出差" }, "synthetic-interval-session");
    assert.equal(skipped.session!.lifecycle, "skipped");
    assert.equal(skipped.execution, null);
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
