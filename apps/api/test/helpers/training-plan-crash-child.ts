import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { TrainingPlanExecutionCommandRequest, TrainingPlanRefreshRequest, TrainingPlanSession,
  TrainingPlanSessionCommandRequest, TrainingPlanSessionPreviewRequest } from "@rai/api-contracts";
import { MobileGoalsStore } from "../../src/mobile-goals.js";
import { TrainingPlanCommandService } from "../../src/training-plan-commands.js";
import { TrainingPlanExecutionCommandService } from "../../src/training-plan-execution-commands.js";
import { executionFactDigest } from "../../src/training-plan-execution-match.js";
import { TrainingPlanSessionCommandService } from "../../src/training-plan-session-commands.js";
import { parseTrainingPlanState, TrainingPlanStore, type TrainingPlanSessionState } from "../../src/training-plan-store.js";

// Test-only process driver. The barrier wraps the real SQLite COMMIT; it never
// replaces the business transaction or adds a fault hook to production code.
export type CrashLane = "session" | "execution" | "refresh" | "evaluation";
export type CrashPoint = "before_commit" | "after_commit";
const fixture = JSON.parse(readFileSync(new URL("../../../ios/tests/fixtures/training-plan-sessions-v2.json",
  import.meta.url), "utf8")) as { payload2: TrainingPlanSessionState; initial: TrainingPlanSession };
export const crashScope = { serverId: "crash-test", athleteId: "synthetic", datasetEpoch: "isolated" };
export const crashScopeKey = JSON.stringify([crashScope.serverId, crashScope.athleteId, crashScope.datasetEpoch]);
const businessDate = "2026-10-25";
const now = () => Date.parse("2026-10-30T03:00:00.000Z");
const run = { trainingSessionId: "synthetic-crash-run", startedAt: "2026-10-28T00:00:00.000Z",
  endedAt: "2026-10-28T00:45:00.000Z", distanceMeters: 8200, durationSeconds: 2700 };
const fact = { ...run, sourceFactDigest: executionFactDigest({ ...run, updatedAt: "2026-10-28T01:00:00.000Z" }) };
const tables = ["mobile_goals", "mobile_goals_history", "mobile_training_state", "mobile_training_state_history",
  "mobile_training_session_history", "mobile_training_execution", "mobile_training_execution_history",
  "mobile_training_plan_evaluation", "mobile_plan_operations", "mobile_coach_loop_receipts", "mobile_plan_pushes"];

export function crashSnapshot(database: DatabaseSync) {
  return Object.fromEntries(tables.map(table => [table,
    database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
}

function open(root: string, bindOwner = true) {
  const path = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, path);
  if (bindOwner) goals.bindTrainingPlanOwner(() => crashScope, () => businessDate);
  const database = (goals as unknown as { controlDatabase: DatabaseSync }).controlDatabase;
  const session = new TrainingPlanSessionCommandService(goals, () => crashScope, () => businessDate,
    () => ({ fingerprint: "crash-facts", prescription: null, validate: () => {} }), now);
  const execution = new TrainingPlanExecutionCommandService(goals, () => crashScope, () => businessDate,
    () => ({ fingerprint: () => "crash-facts", candidates: () => [fact], workout: () => null }), now);
  const refresh = new TrainingPlanCommandService(goals, () => crashScopeKey, () => crashScope, () => businessDate, now);
  const row = () => goals.trainingPlanStateRow(crashScopeKey)!;
  const deps = (inputKey: string) => ({
    prepare: async () => ({ days: [structuredClone(fixture.initial.prescription)],
      audit: { generatedBy: "heuristic" as const, model: null, promptVersion: null,
        generatedAt: "2026-10-30T03:00:00.000Z" }, warnings: [], prescription: null, fingerprint: "crash-facts" }),
    fingerprint: () => "crash-facts",
    evaluation: () => ({ inputKey, businessDate, policyHash: null, executionDigest: "a".repeat(64) })
  });
  return { goals, database, session, execution, refresh, row, deps };
}

export async function seedCrashFixture(root: string, lane: CrashLane) {
  const f = open(root, false);
  try {
    const session = structuredClone(fixture.initial);
    session.protection = "automatic";
    session.userOverride = null;
    session.lifecycle = "pending";
    session.prescription.localDate = "2026-10-28";
    session.availableAt = "2026-10-25T03:00:00.000Z";
    const weekPlan = [session.prescription];
    f.goals.write({ weekPlan }, { preserveWeekPlan: true });
    const { planInstanceId: _instance, sessions: _sessions, suppressions: _suppressions,
      publishedInputKey: _input, ...legacy } = fixture.payload2;
    const unified = new TrainingPlanStore(f.database);
    unified.applyMigration({ scope: crashScopeKey, expectedAbsentOrRevision: 0, sourceDigest: legacy.sourceDigest,
      state: parseTrainingPlanState({ ...legacy, schemaVersion: 1, migrationVersion: 1, weekPlan,
        goalsRevision: f.goals.read().revision }) });
    unified.commitState({ scope: crashScopeKey, expectedRevision: 1, eventType: "crash:seed", state: {
      ...fixture.payload2, sessions: [session], suppressions: [], weekPlan, goalsRevision: f.goals.read().revision,
      planContextDigest: null, publishedInputKey: null
    } }, { sessionMigration: true });
    f.goals.bindTrainingPlanOwner(() => crashScope, () => businessDate);
    if (lane === "evaluation") {
      await f.refresh.refresh({ contractVersion: 2, operationId: randomUUID(), operationScope: crashScope,
        expectedStateRevision: f.row().revision }, f.deps("input-before-crash"));
    }
    return { snapshot: crashSnapshot(f.database), revision: f.row().revision,
      guard: f.goals.publicationGuardState() };
  } finally { f.goals.close(); }
}

async function main() {
  const [mode, root, laneArg, pointArg] = process.argv.slice(2);
  assert.ok(root && (mode === "crash" || mode === "recover"));
  assert.ok(["session", "execution", "refresh", "evaluation"].includes(laneArg!));
  const lane = laneArg as CrashLane;
  const point = pointArg as CrashPoint;
  const requestPath = join(root, "request.json");
  const f = open(root);
  try {
    const submit = async (request: unknown): Promise<unknown> => {
      if (lane === "session") return f.session.submit(request as TrainingPlanSessionCommandRequest);
      if (lane === "execution") return f.execution.submit(request as TrainingPlanExecutionCommandRequest);
      return f.refresh.refresh(request as TrainingPlanRefreshRequest, f.deps("input-after-crash"));
    };
    if (mode === "recover") {
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      const before = crashSnapshot(f.database);
      const queried = f.goals.publicationResult(crashScopeKey, request.operationId);
      const guardBefore = f.goals.publicationGuardState();
      let rejectedCandidate: string | null = null;
      if (lane === "session" && point === "before_commit") {
        // Uncommitted previews are signed by the dead process. Re-read/preview
        // before retrying, while keeping the original uncommitted operation ID.
        try { await submit(request); assert.fail("old preview must not survive restart"); }
        catch (error) { rejectedCandidate = (error as { code: string }).code; }
        assert.equal(rejectedCandidate, "training_session_candidate_mismatch");
        const { candidateId: _candidate, operationId: _operation, ...previewRequest } = request;
        request.candidateId = f.session.preview(previewRequest).candidateId;
      }
      const recovered = await submit(request);
      const after = crashSnapshot(f.database);
      const guardAfter = f.goals.publicationGuardState();
      const replayed = await submit(request);
      assert.deepEqual(replayed, recovered);
      assert.deepEqual(crashSnapshot(f.database), after, "replay cannot append any business row");
      assert.deepEqual(f.goals.publicationGuardState(), guardAfter, "replay is read-only");
      writeFileSync(join(root, "recovered.json"), JSON.stringify({ before, queried, recovered, after,
        guardBefore, guardAfter, rejectedCandidate, revision: f.row().revision }));
      return;
    }

    assert.ok(point === "before_commit" || point === "after_commit");
    const state = f.row().state as TrainingPlanSessionState;
    const course = state.sessions[0]!;
    const common = { operationId: randomUUID(), operationScope: crashScope, expectedStateRevision: f.row().revision };
    let request: unknown;
    if (lane === "session") {
      const preview: TrainingPlanSessionPreviewRequest = { operationScope: crashScope,
        expectedStateRevision: common.expectedStateRevision, contractVersion: 1,
        planInstanceId: state.planInstanceId, draft: { action: "move", sessionId: course.sessionId,
          sessionRevision: course.sessionRevision, localDate: "2026-10-29" } };
      request = { ...preview, operationId: common.operationId,
        candidateId: f.session.preview(preview).candidateId } satisfies TrainingPlanSessionCommandRequest;
    } else if (lane === "execution") {
      request = { ...common, contractVersion: 1, planInstanceId: state.planInstanceId, sessionId: course.sessionId,
        sessionRevision: course.sessionRevision, executionRevision: 0,
        draft: { action: "confirm", trainingSessionId: fact.trainingSessionId, sourceFactDigest: fact.sourceFactDigest } };
    } else { request = { ...common, contractVersion: 2 }; }
    writeFileSync(requestPath, JSON.stringify(request));
    const exec = f.database.exec.bind(f.database);
    const barrier = (transaction: boolean) => {
      assert.equal(f.database.isTransaction, transaction);
      const operation = f.database.prepare("SELECT result_json FROM mobile_plan_operations WHERE operation_id=?")
        .get(common.operationId) as { result_json: string } | undefined;
      assert.ok(operation, "all business writes and the durable operation precede COMMIT");
      // Publish the checkpoint atomically: the parent polls existsSync() and
      // reads immediately, so a partially written file would intermittently
      // fail with "Unexpected end of JSON input" under I/O load.
      const checkpointPath = join(root, "checkpoint.json");
      const checkpointTemporary = `${checkpointPath}.${process.pid}.tmp`;
      writeFileSync(checkpointTemporary, JSON.stringify({ point, inTransaction: f.database.isTransaction,
        result: JSON.parse(operation.result_json), snapshot: crashSnapshot(f.database) }));
      renameSync(checkpointTemporary, checkpointPath);
      // Parent waits for this file and sends a real OS signal. A missed kill
      // fails the child, rather than eventually allowing a COMMIT through.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
      throw new Error("crash barrier timed out: parent did not terminate the child");
    };
    f.database.exec = sql => {
      if (sql === "COMMIT" && f.goals.publicationInFlight()) {
        if (point === "before_commit") barrier(true);
        exec(sql);
        if (point === "after_commit") barrier(false);
        return;
      }
      exec(sql);
    };
    await submit(request);
    assert.fail("crash submission unexpectedly returned a response");
  } finally { f.goals.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
