import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  MobilePlannedDay, TrainingPlanExecutionCommandRequest, TrainingPlanScope, TrainingPlanSession,
  TrainingPlanSessionExecution
} from "@rai/api-contracts";

import { MobileGoalsStore } from "../src/mobile-goals.js";
import { digest } from "../src/plan-digest.js";
import { TrainingPlanCommandService } from "../src/training-plan-commands.js";
import {
  TrainingPlanExecutionCommandService, type ExecutionCommandFacts
} from "../src/training-plan-execution-commands.js";
import { executionFactDigest, type ExecutionFact } from "../src/training-plan-execution-match.js";
import {
  parseTrainingPlanState, TrainingPlanStore, type TrainingPlanSessionState, type TrainingPlanState
} from "../src/training-plan-store.js";

/**
 * B09 / S05-01 / T22 + T23: every new control-store write point is tested by
 * injecting a real SQLite failure (a raising trigger or a deferred FK that only
 * fails at COMMIT). The assertion is deliberately snapshot-based, not "an error
 * was thrown": after the failed publication the state revision, state history,
 * frozen session history, current execution, execution history and operation
 * result must all be exactly what they were before the attempt.
 *
 * These are macOS local tests. They prove the transaction boundary, not a Linux
 * systemd/SIGKILL environment (G5 stays blocked; see B09_REPORT.md).
 */

const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-sessions-v2.json",
  import.meta.url), "utf8")) as {
  payload2: TrainingPlanSessionState;
  initial: TrainingPlanSession;
  scope: TrainingPlanScope;
};

const scope = fixture.scope;
const scopeKey = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
const businessDate = "2026-10-25";
const nowInstant = "2026-10-30T03:00:00.000Z";

const interval = (localDate: string): MobilePlannedDay => ({
  localDate, kind: "interval", distanceKm: 8,
  structure: { warmup: null, cooldown: null, blocks: [{ iterations: 4, steps: [
    { purpose: "work", goal: { type: "distance", meters: 1000 }, alert: { kind: "pace", lower: 240, upper: 260 } },
    { purpose: "recovery", goal: { type: "time", seconds: 90 }, alert: null }
  ] }] }, reason: null
});

interface ExecutionFixture {
  root: string;
  controlPath: string;
  goals: MobileGoalsStore;
  database: DatabaseSync;
  control: DatabaseSync;
  service: TrainingPlanExecutionCommandService;
  state: () => TrainingPlanSessionState;
  row: () => { revision: number };
  session: (id?: string) => TrainingPlanSession;
  body: (draft: TrainingPlanExecutionCommandRequest["draft"], id?: string) => TrainingPlanExecutionCommandRequest;
  facts: () => ExecutionFact[];
  setFacts: (next: ExecutionFact[]) => void;
  confirmEasy: () => ReturnType<TrainingPlanExecutionCommandService["submit"]>;
  snapshot: () => Record<string, number>;
  count: (table: string) => number;
  inject: (table: string, event: "INSERT" | "UPDATE") => void;
  armCommitFailure: (table: "mobile_training_execution" | "mobile_plan_operations") => void;
  close: () => void;
}

function countRows(database: DatabaseSync, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function createExecutionFixture(options: { completedSessions?: boolean; twoSessions?: boolean } = {}): ExecutionFixture {
  const root = mkdtempSync(join(tmpdir(), "rai-b09-faults-"));
  const controlPath = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, controlPath);
  const database = new DatabaseSync(controlPath);
  const control = (goals as unknown as { controlDatabase: DatabaseSync }).controlDatabase;
  const unified = new TrainingPlanStore(database);

  const easy = structuredClone(fixture.initial);
  easy.protection = "automatic";
  easy.userOverride = null;
  easy.lifecycle = options.completedSessions === true ? "completed" : "pending";
  easy.prescription.localDate = "2026-10-28";
  const hard: TrainingPlanSession = { ...structuredClone(easy), sessionId: "synthetic-interval-session",
    prescription: interval("2026-10-29"), recommendation: null, availableAt: "2026-10-25T03:00:00.000Z" };
  const sessions = [easy, hard];
  const weekPlan = [easy.prescription, hard.prescription];
  goals.write({ weekPlan }, { preserveWeekPlan: true });
  const { planInstanceId, sessions: _ignoredSessions, suppressions: _ignoredSuppressions,
    publishedInputKey: _ignoredPublishedInputKey, ...legacy } = fixture.payload2;
  unified.applyMigration({
    scope: scopeKey, expectedAbsentOrRevision: 0, sourceDigest: legacy.sourceDigest,
    state: parseTrainingPlanState({ ...legacy, schemaVersion: 1, migrationVersion: 1, weekPlan,
      goalsRevision: goals.read().revision })
  });
  unified.commitState({ scope: scopeKey, expectedRevision: 1, eventType: "fixture:upgrade", state: {
    ...fixture.payload2, sessions, suppressions: [], weekPlan, goalsRevision: goals.read().revision
  } }, { sessionMigration: true });
  goals.bindTrainingPlanOwner(() => scope, () => businessDate);

  let now = Date.parse(nowInstant);
  let facts: ExecutionFact[] = [];
  const fact = (id: string, startedAt: string, distanceMeters: number): ExecutionFact => ({
    trainingSessionId: id, startedAt, endedAt: new Date(Date.parse(startedAt) + 45 * 60_000).toISOString(),
    distanceMeters, durationSeconds: 2700,
    sourceFactDigest: executionFactDigest({ trainingSessionId: id, startedAt,
      endedAt: new Date(Date.parse(startedAt) + 45 * 60_000).toISOString(), distanceMeters, durationSeconds: 2700,
      updatedAt: "v1" })
  });
  facts = [fact("run-easy", "2026-10-28T00:00:00.000Z", 8200), fact("run-hard", "2026-10-29T00:00:00.000Z", 8000)];
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
    executionRevision: goals.trainingPlanExecution(scopeKey, id)?.execution.executionRevision ?? 0, draft
  });
  const snapshot = () => ({
    stateRevision: row().revision,
    stateRows: countRows(database, "mobile_training_state"),
    stateHistory: countRows(database, "mobile_training_state_history"),
    sessionHistory: countRows(database, "mobile_training_session_history"),
    executionCurrent: countRows(database, "mobile_training_execution"),
    executionHistory: countRows(database, "mobile_training_execution_history"),
    operations: countRows(database, "mobile_plan_operations"),
    goalsRevision: goals.read().revision
  });
  const inject = (table: string, event: "INSERT" | "UPDATE"): void => {
    const name = `b09_fail_${table}_${event.toLowerCase()}`;
    database.exec(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN
      SELECT RAISE(ABORT, 'B09 injected ${table} ${event} failure'); END;`);
  };
  const armCommitFailure = (table: "mobile_training_execution" | "mobile_plan_operations"): void => {
    // A deferred FK violation is raised by SQLite at COMMIT, after every business
    // row was already inserted. This is the closest in-process analogue of a
    // commit-time I/O failure (the production kill test is still Linux-only).
    control.exec("PRAGMA foreign_keys = ON");
    control.exec(`CREATE TABLE b09_parent(id TEXT PRIMARY KEY);
      CREATE TABLE b09_commit_fault(ref TEXT NOT NULL REFERENCES b09_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER b09_commit_fault_trigger AFTER INSERT ON ${table} BEGIN
        INSERT INTO b09_commit_fault(ref) VALUES ('missing-parent'); END;`);
  };
  return {
    root, controlPath, goals, database, control, service, state, row, session, body,
    facts: () => facts,
    setFacts: next => { facts = next; },
    confirmEasy: () => service.submit(body({ action: "confirm", trainingSessionId: "run-easy",
      sourceFactDigest: facts[0]!.sourceFactDigest })),
    snapshot, count: table => countRows(database, table), inject, armCommitFailure,
    close: () => { database.close(); goals.close(); rmSync(root, { recursive: true, force: true }); }
  };
}

test("B06/S05-01/T22: each execution write point fails atomically (state, frozen history, execution, operation)", t => {
  const points: Array<{ label: string; table: string; event: "INSERT" | "UPDATE" }> = [
    { label: "course state update", table: "mobile_training_state", event: "UPDATE" },
    { label: "course state history insert", table: "mobile_training_state_history", event: "INSERT" },
    { label: "frozen session history insert", table: "mobile_training_session_history", event: "INSERT" },
    { label: "execution history insert", table: "mobile_training_execution_history", event: "INSERT" },
    { label: "current execution upsert (insert)", table: "mobile_training_execution", event: "INSERT" },
    { label: "operation result insert", table: "mobile_plan_operations", event: "INSERT" }
  ];
  for (const point of points) {
    const f = createExecutionFixture();
    try {
      const before = f.snapshot();
      f.inject(point.table, point.event);
      assert.throws(() => f.confirmEasy(), new RegExp(`B09 injected ${point.table} ${point.event} failure`),
        `${point.label} must surface the injected failure`);
      assert.deepEqual(f.snapshot(), before,
        `${point.label}: a failed write must leave no state/history/execution/operation row behind`);
      assert.equal(f.goals.trainingPlanExecution(scopeKey, fixture.initial.sessionId), null);
      assert.equal(f.goals.trainingPlanExecutionHistory(scopeKey, fixture.initial.sessionId).length, 0);
      assert.equal(f.goals.trainingPlanEvaluation(scopeKey), null);
      t.diagnostic(`B06 write-point ${point.label}: rolled back cleanly (stateRevision=${before.stateRevision})`);
    } finally { f.close(); }
  }
});

test("B06/S05-01/T22: current-execution update (correct) failure keeps the old link and history", t => {
  const f = createExecutionFixture();
  try {
    const confirmed = f.confirmEasy();
    const before = f.snapshot();
    assert.equal(confirmed.execution!.association, "confirmed");
    f.inject("mobile_training_execution", "UPDATE");
    assert.throws(() => f.service.submit(f.body({ action: "correct", trainingSessionId: "run-hard",
      sourceFactDigest: f.facts()[1]!.sourceFactDigest })), /B09 injected mobile_training_execution UPDATE failure/);
    assert.deepEqual(f.snapshot(), before, "a failed current-row update must not move the link or append history");
    const current = f.goals.trainingPlanExecution(scopeKey, fixture.initial.sessionId)!;
    assert.equal(current.execution.executionRevision, 1);
    assert.equal(current.execution.trainingSessionId, "run-easy");
    assert.equal(f.goals.trainingPlanExecutionHistory(scopeKey, fixture.initial.sessionId).length, 1);
    t.diagnostic("B06 current execution UPDATE failure: old revision 1/run-easy retained, no history append");
  } finally { f.close(); }
});

test("B06/S05-01/T22: a COMMIT-time failure rolls back every business row and leaves no operation", t => {
  const f = createExecutionFixture();
  try {
    const before = f.snapshot();
    f.armCommitFailure("mobile_plan_operations");
    assert.throws(() => f.confirmEasy(), /FOREIGN KEY constraint failed/);
    assert.deepEqual(f.snapshot(), before, "COMMIT failure must leave state, session history, execution and operation untouched");
    assert.equal(f.database.isTransaction, false, "the publication transaction must not stay open after a failed COMMIT");
    t.diagnostic("B06 COMMIT failure: deferred FK raised at COMMIT; all business rows rolled back");
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// B08 evaluation cursor
// ---------------------------------------------------------------------------

interface EvaluationFixture {
  controlPath: string;
  goals: MobileGoalsStore;
  database: DatabaseSync;
  control: DatabaseSync;
  service: TrainingPlanCommandService;
  ref: () => { revision: number; state: TrainingPlanSessionState };
  deps: (inputKey: string, days?: MobilePlannedDay[]) => Parameters<TrainingPlanCommandService["refresh"]>[1];
  request: (operationId: string, revision: number) => Parameters<TrainingPlanCommandService["refresh"]>[0];
  inject: (table: string, event: "INSERT" | "UPDATE") => void;
  armCommitFailure: () => void;
  count: (table: string) => number;
  close: () => void;
}

const generatedDays = (): MobilePlannedDay[] => [
  { localDate: "2026-10-21", kind: "easy", distanceKm: 5.2, structure: null, reason: "generated" },
  { localDate: "2026-10-22", kind: "rest", distanceKm: null, structure: null, reason: "generated rest" }
];
const generatedAudit = (): import("@rai/api-contracts").MobilePlanAudit => ({
  generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: "2026-10-20T04:30:00.000Z"
});

function createEvaluationFixture(): EvaluationFixture {
  const root = mkdtempSync(join(tmpdir(), "rai-b09-eval-faults-"));
  const controlPath = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, controlPath);
  const database = new DatabaseSync(controlPath);
  const control = (goals as unknown as { controlDatabase: DatabaseSync }).controlDatabase;
  const unified = new TrainingPlanStore(database);
  const state: TrainingPlanState = {
    schemaVersion: 1, migrationVersion: 1, source: "legacy_goals", sourceStatus: "active",
    sourceDigest: digest({ source: "b09-eval-fixture" }).slice(0, 64), runState: "active", raceGoal: null,
    preferencesComplete: true, legacyRaceTarget: null, weekPlan: [], lockedSession: null, runCoach: null,
    coachLoop: null, goalsRevision: goals.read().revision, planContextDigest: null,
    migratedAt: "2026-10-20T04:00:00.000Z"
  };
  unified.applyMigration({ scope: scopeKey, expectedAbsentOrRevision: 0, sourceDigest: state.sourceDigest, state });
  const service = new TrainingPlanCommandService(goals, () => scopeKey, () => scope, () => businessDate,
    () => Date.parse("2026-10-20T04:00:00.000Z"));
  const ref = () => {
    const row = goals.trainingPlanStateRow(scopeKey)!;
    return { revision: row.revision, state: row.state as TrainingPlanSessionState };
  };
  const deps = (inputKey: string, days = generatedDays()): Parameters<TrainingPlanCommandService["refresh"]>[1] => ({
    prepare: async () => ({ days, audit: generatedAudit(), warnings: [], prescription: null, fingerprint: "fingerprint-a" }),
    fingerprint: () => "fingerprint-a",
    evaluation: () => ({ inputKey, businessDate, policyHash: null, executionDigest: "a".repeat(64) })
  });
  const request = (operationId: string, revision: number): Parameters<TrainingPlanCommandService["refresh"]>[0] => ({
    contractVersion: 2, operationId, operationScope: scope, expectedStateRevision: revision
  });
  const inject = (table: string, event: "INSERT" | "UPDATE"): void => {
    database.exec(`CREATE TRIGGER b09_eval_fail_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN
      SELECT RAISE(ABORT, 'B09 injected evaluation ${event} failure'); END;`);
  };
  const armCommitFailure = (): void => {
    control.exec("PRAGMA foreign_keys = ON");
    control.exec(`CREATE TABLE b09_eval_parent(id TEXT PRIMARY KEY);
      CREATE TABLE b09_eval_commit_fault(ref TEXT NOT NULL REFERENCES b09_eval_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER b09_eval_commit_trigger AFTER UPDATE ON mobile_training_plan_evaluation BEGIN
        INSERT INTO b09_eval_commit_fault(ref) VALUES ('missing-parent'); END;`);
  };
  return { controlPath, goals, database, control, service, ref, deps, request, inject, armCommitFailure,
    count: table => countRows(database, table),
    close: () => { database.close(); goals.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("B08/S04-03/T22: evaluation cursor insert failure rolls back the operation result", async t => {
  const f = createEvaluationFixture();
  try {
    const beforeCursor = f.goals.trainingPlanEvaluation(scopeKey);
    assert.equal(beforeCursor, null);
    f.inject("mobile_training_plan_evaluation", "INSERT");
    await assert.rejects(() => f.service.refresh(f.request("op-b08-insert-fault", f.ref().revision), f.deps("input-1")),
      /B09 injected evaluation INSERT failure/);
    assert.equal(f.goals.trainingPlanEvaluation(scopeKey), null, "no cursor row after a failed first publication");
    assert.equal(f.count("mobile_plan_operations"), 0, "no operation result after a failed first publication");
    assert.equal(f.ref().revision, 1, "the state revision did not move");
    t.diagnostic("B08 cursor INSERT failure: no cursor and no operation committed");
  } finally { f.close(); }
});

test("B08/S04-03/T22: evaluation cursor update failure keeps the old cursor and leaves no operation", async t => {
  const f = createEvaluationFixture();
  try {
    const first = await f.service.refresh(f.request("op-b08-old", f.ref().revision), f.deps("input-old"));
    assert.equal(first.outcome, "changed");
    const old = f.goals.trainingPlanEvaluation(scopeKey)!;
    assert.equal(old.inputKey, "input-old");
    const before = { revision: f.ref().revision, cursor: old, operations: f.count("mobile_plan_operations") };
    f.inject("mobile_training_plan_evaluation", "UPDATE");
    await assert.rejects(() => f.service.refresh(f.request("op-b08-update-fault", f.ref().revision), f.deps("input-new")),
      /B09 injected evaluation UPDATE failure/);
    const after = f.goals.trainingPlanEvaluation(scopeKey)!;
    assert.deepEqual(after, before.cursor, "the old cursor must remain readable and unchanged");
    assert.equal(f.count("mobile_plan_operations"), before.operations, "the failed no-change operation must not be stored");
    assert.equal(f.ref().revision, before.revision);
    assert.equal(f.service.replayRefresh(f.request("op-b08-update-fault", before.revision)), null);
    t.diagnostic(`B08 cursor UPDATE failure: old inputKey=${after.inputKey} retained; no operation row`);
  } finally { f.close(); }
});

test("B08/S04-03/T22: evaluation COMMIT failure rolls cursor and operation result back together", async t => {
  const f = createEvaluationFixture();
  try {
    await f.service.refresh(f.request("op-b08-commit-old", f.ref().revision), f.deps("input-old"));
    const old = f.goals.trainingPlanEvaluation(scopeKey)!;
    const before = { revision: f.ref().revision, cursor: old, operations: f.count("mobile_plan_operations") };
    f.armCommitFailure();
    await assert.rejects(() => f.service.refresh(f.request("op-b08-commit-fault", f.ref().revision), f.deps("input-new")),
      /FOREIGN KEY constraint failed/);
    assert.deepEqual(f.goals.trainingPlanEvaluation(scopeKey), before.cursor,
      "the old cursor must still be readable after a COMMIT failure");
    assert.equal(f.count("mobile_plan_operations"), before.operations);
    assert.equal(f.ref().revision, before.revision);
    t.diagnostic("B08 evaluation COMMIT failure: cursor and operation result rolled back together");
  } finally { f.close(); }
});

test("B08/S04-03/T23: SQLITE_BUSY is a bounded retryable failure and does not lose a committed operation", async t => {
  const f = createEvaluationFixture();
  const holder = new DatabaseSync(f.controlPath);
  try {
    const firstRequest = f.request("op-b08-busy-first", f.ref().revision);
    const first = await f.service.refresh(firstRequest, f.deps("input-old"));
    const old = f.goals.trainingPlanEvaluation(scopeKey)!;
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    const secondRequest = f.request("op-b08-busy-second", f.ref().revision);
    await assert.rejects(() => f.service.refresh(secondRequest, f.deps("input-new")),
      (error: unknown) => (error as { code?: string }).code === "database_busy",
      "a held write lock must surface the bounded database_busy contract, not a false success");
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1_000, `busy wait should be bounded but real (observed ${elapsed.toFixed(0)}ms)`);
    holder.exec("ROLLBACK");
    assert.deepEqual(f.goals.trainingPlanEvaluation(scopeKey), old, "the previously committed cursor is still readable");
    assert.deepEqual(f.service.replayRefresh(firstRequest), first,
      "the already committed operation must remain replayable after SQLITE_BUSY");
    assert.equal(f.service.replayRefresh(secondRequest), null,
      "the failed operation must not be recorded as committed");
    const retried = await f.service.refresh(secondRequest, f.deps("input-new"));
    assert.equal(retried.outcome, "no_change");
    assert.equal(f.goals.trainingPlanEvaluation(scopeKey)!.inputKey, "input-new", "a bounded retry after lock release succeeds");
    t.diagnostic(`B08 SQLITE_BUSY: failed in ${elapsed.toFixed(0)}ms with database_busy; old cursor/op replay intact; retry succeeded`);
  } finally {
    try { holder.exec("ROLLBACK"); } catch { /* not in a transaction */ }
    holder.close();
    f.close();
  }
});

// ---------------------------------------------------------------------------
// Two real processes: same actual run, two courses
// ---------------------------------------------------------------------------

const projectRoot = resolve(import.meta.dirname, "../../..");
const raceChild = join(import.meta.dirname, "helpers/training-plan-execution-race-child.ts");

interface RaceResult {
  ok: boolean;
  result?: { operationId: string; session: TrainingPlanSession; execution: TrainingPlanSessionExecution };
  code?: string | null;
  message?: string;
}

function waitForFile(path: string, timeoutMs = 30_000): void {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(sleeper, 0, 0, 25);
  }
}

test("B06/S05-01/T21: two real processes confirming one run for two courses: one wins, one gets training_execution_link_conflict", { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "rai-b09-race-"));
  const controlPath = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, controlPath);
  const database = new DatabaseSync(controlPath);
  const unified = new TrainingPlanStore(database);
  const children: ChildProcess[] = [];
  try {
    const first = structuredClone(fixture.initial);
    first.protection = "automatic"; first.userOverride = null; first.lifecycle = "completed";
    first.prescription.localDate = "2026-10-28";
    const second: TrainingPlanSession = { ...structuredClone(first), sessionId: "synthetic-second-session",
      prescription: { ...structuredClone(first.prescription), localDate: "2026-10-29" } };
    const sessions = [first, second];
    const weekPlan = sessions.map(session => session.prescription);
    goals.write({ weekPlan }, { preserveWeekPlan: true });
    const { planInstanceId, sessions: _s, suppressions: _sp, publishedInputKey: _pi, ...legacy } = fixture.payload2;
    unified.applyMigration({ scope: scopeKey, expectedAbsentOrRevision: 0, sourceDigest: legacy.sourceDigest,
      state: parseTrainingPlanState({ ...legacy, schemaVersion: 1, migrationVersion: 1, weekPlan,
        goalsRevision: goals.read().revision }) });
    unified.commitState({ scope: scopeKey, expectedRevision: 1, eventType: "fixture:race", state: {
      ...fixture.payload2, sessions, suppressions: [], weekPlan, goalsRevision: goals.read().revision
    } }, { sessionMigration: true });
    goals.bindTrainingPlanOwner(() => scope, () => businessDate);
    const row = goals.currentTrainingPlan()!;
    const state = row.state as TrainingPlanSessionState;

    const runFact: ExecutionFact = {
      trainingSessionId: "run-shared", startedAt: "2026-10-28T00:00:00.000Z",
      endedAt: "2026-10-28T00:45:00.000Z", distanceMeters: 8200, durationSeconds: 2700,
      sourceFactDigest: executionFactDigest({ trainingSessionId: "run-shared", startedAt: "2026-10-28T00:00:00.000Z",
        endedAt: "2026-10-28T00:45:00.000Z", distanceMeters: 8200, durationSeconds: 2700, updatedAt: "race-v1" })
    };
    const configPath = join(root, "race-config.json");
    writeFileSync(configPath, JSON.stringify({ root, controlPath, scope, businessDate, now: nowInstant,
      planInstanceId, runFact, sessions: sessions.map(session => ({ sessionId: session.sessionId,
        sessionRevision: session.sessionRevision })) }), "utf8");

    const waiters: Array<Promise<void>> = [];
    for (const [index, session] of sessions.entries()) {
      const ready = join(root, `ready-${index}`), go = join(root, `go-${index}`), result = join(root, `result-${index}.json`);
      const operationId = randomUUID();
      writeFileSync(join(root, `op-${index}`), operationId, "utf8");
      const child = spawn(process.execPath, ["--import", "tsx", raceChild, configPath, session.sessionId, operationId,
        String(row.revision), ready, go, result], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      children.push(child);
      waitForFile(ready);
      waiters.push(new Promise<void>((resolvePromise, rejectPromise) => {
        child.once("close", code => code === 0 ? resolvePromise()
          : rejectPromise(new Error(`race child ${index} exited ${code}: ${output}`)));
      }));
    }
    for (const index of sessions.keys()) writeFileSync(join(root, `go-${index}`), "go");
    await Promise.all(waiters);

    const outcomes = sessions.map((_session, index) => JSON.parse(readFileSync(join(root, `result-${index}.json`), "utf8")) as RaceResult);
    const winners = outcomes.filter(outcome => outcome.ok);
    const losers = outcomes.filter(outcome => !outcome.ok);
    assert.equal(winners.length, 1, `exactly one process may commit: ${JSON.stringify(outcomes)}`);
    assert.equal(losers.length, 1, `exactly one process must lose: ${JSON.stringify(outcomes)}`);
    assert.equal(losers[0]!.code, "training_execution_link_conflict",
      `the loser must report the link conflict, got ${JSON.stringify(losers[0])}`);
    const winner = winners[0]!.result!;
    assert.equal(goals.trainingPlanExecution(scopeKey, winner.session.sessionId)!.execution.trainingSessionId, "run-shared");
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM mobile_training_execution").get() as { n: number }).n, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM mobile_training_execution_history").get() as { n: number }).n, 1);
    assert.equal(goals.currentTrainingPlan()!.revision, row.revision, "a pre-completed course needs no state revision bump");
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM mobile_plan_operations").get() as { n: number }).n, 1);

    // Same operation key + same request replays the frozen result and appends nothing.
    const provider: ExecutionCommandFacts = {
      fingerprint: () => "race-facts", candidates: () => [runFact], workout: () => null
    };
    const service = new TrainingPlanExecutionCommandService(goals, () => scope, () => businessDate, () => provider,
      () => Date.parse(nowInstant));
    const replay = service.submit({ contractVersion: 1, operationId: winner.operationId, operationScope: scope,
      expectedStateRevision: row.revision, planInstanceId, sessionId: winner.session.sessionId,
      sessionRevision: winner.session.sessionRevision, executionRevision: 0,
      draft: { action: "confirm", trainingSessionId: "run-shared", sourceFactDigest: runFact.sourceFactDigest } });
    assert.equal(replay.operationId, winner.operationId);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM mobile_training_execution_history").get() as { n: number }).n, 1,
      "same-key replay must not append an execution revision");
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM mobile_plan_operations").get() as { n: number }).n, 1);
    t.diagnostic(`two-process race: winner=${winner.session.sessionId} loser=${losers[0]!.code}; replay appended nothing`);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    }
    database.close();
    goals.close();
    rmSync(root, { recursive: true, force: true });
  }
});
