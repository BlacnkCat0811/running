import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TrainingPlanCommandAction, TrainingPlanCommandPreviewRequest } from "@rai/api-contracts";
import { CoachLoopRuntime, COACH_RUNTIME_POLICY_HASH, type CoachRuntimeReceipt } from "../src/coach-loop-runtime.js";
import { digest } from "../src/plan-digest.js";
import { TrainingPlanCommandService } from "../src/training-plan-commands.js";
import { TrainingPlanStore, type TrainingPlanState } from "../src/training-plan-store.js";
import { coachRuntimeFixture, runtimeReplayScope as scope, runtimeReplaySettings as settings } from "../../../scripts/coach-runtime-fixtures.mjs";

const scopeKey = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
const receiptScope = JSON.stringify(scope);

function fixture() {
  const f = coachRuntimeFixture();
  f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
  const database = new DatabaseSync(f.controlPath);
  const latest = database.prepare("SELECT operation_id FROM mobile_coach_loop_receipts ORDER BY sequence DESC LIMIT 1").get()!;
  const goals = f.store.read();
  const state: TrainingPlanState = {
    schemaVersion: 1, migrationVersion: 1, source: "coach_loop", sourceStatus: "active", sourceDigest: digest("synthetic-owner"),
    runState: "active", raceGoal: null, preferencesComplete: true, legacyRaceTarget: null, weekPlan: goals.weekPlan,
    lockedSession: goals.lockedSession, runCoach: null,
    coachLoop: { operationId: String(latest.operation_id), policyHash: COACH_RUNTIME_POLICY_HASH, evaluatedAt: f.facts.asOf },
    goalsRevision: goals.revision, planContextDigest: null, migratedAt: f.facts.asOf
  };
  new TrainingPlanStore(database).applyMigration({ scope: scopeKey, expectedAbsentOrRevision: 0, sourceDigest: state.sourceDigest, state });
  f.store.bindTrainingPlanOwner(() => scope, () => f.facts.date);
  const service = new TrainingPlanCommandService(f.store, () => scopeKey, () => scope,
    () => f.facts.date, () => Date.parse(f.facts.asOf));
  const deps = {
    prepare: async (value: TrainingPlanState) => ({ ...f.runtime.prepareUnified(value), fingerprint: "synthetic-facts" }),
    fingerprint: () => "synthetic-facts"
  };
  const command = async (action: TrainingPlanCommandAction, raceGoal?: TrainingPlanCommandPreviewRequest["raceGoal"]) => {
    const draft: TrainingPlanCommandPreviewRequest = { contractVersion: 2, operationScope: scope, action,
      expectedStateRevision: f.store.currentTrainingPlan()!.revision, ...(raceGoal === undefined ? {} : { raceGoal }) };
    const preview = service.preview(draft);
    const body = { ...draft, operationId: `unified-${action}-${preview.expectedStateRevision}`,
      expectedStateRevision: preview.expectedStateRevision, candidateId: preview.candidateId };
    return action === "pause" ? service.submit(body) : service.submit(body, {
      prepared: await deps.prepare(service.planFor(body).afterState), fingerprint: deps.fingerprint
    });
  };
  const refresh = () => service.refresh({ contractVersion: 2, operationScope: scope,
    operationId: `refresh-${f.store.currentTrainingPlan()!.revision}`,
    expectedStateRevision: f.store.currentTrainingPlan()!.revision }, deps);
  return { f, command, refresh, close: () => { database.close(); f.close(); } };
}

test("managed prepareUnified uses the same facts-updating admission as the existing runtime command", () => {
  const x = fixture();
  try {
    let ready = false; let reads = 0;
    const runtime = new CoachLoopRuntime(x.f.store, () => scope, () => { reads++; return x.f.facts; }, () => ready,
      { now: () => Date.parse(x.f.facts.asOf) });
    const before = x.f.store.currentTrainingPlan();
    for (const action of [() => runtime.command(x.f.command("refresh")), () => runtime.prepareUnified(before!.state)]) {
      assert.throws(action, (error: unknown) => (error as { code?: string }).code === "coach_sync_pending");
    }
    assert.equal(reads, 0);
    assert.deepEqual(x.f.store.currentTrainingPlan(), before);
    ready = true;
    assert.ok(runtime.prepareUnified(before!.state).days.length > 0);
    assert.deepEqual(x.f.store.currentTrainingPlan(), before, "preparing does not publish");
  } finally { x.close(); }
});

test("unified generation never accepts a changed coach policy; pause and explicit policy acceptance remain usable", async () => {
  const x = fixture();
  try {
    const receipt = x.f.store.coachLoopState<CoachRuntimeReceipt>(receiptScope)!;
    x.f.store.withPublicationTransaction(() => x.f.store.appendCoachLoopReceipt(receiptScope, "old-policy", {
      ...receipt, policyHash: "previous-policy"
    }));
    const before = x.f.store.currentTrainingPlan();
    for (const action of ["resume", "clear_race_goal", "set_race_goal"] as const) {
      await assert.rejects(x.command(action, { date: "2026-12-06", distanceKm: 10, goal: "finish", targetTimeSeconds: null }),
        (error: unknown) => (error as { code?: string }).code === "coach_policy_changed");
    }
    await assert.rejects(x.refresh(), (error: unknown) => (error as { code?: string }).code === "coach_policy_changed");
    assert.deepEqual(x.f.store.currentTrainingPlan(), before, "rejections change neither owner nor evidence");
    assert.equal(x.f.store.coachLoopState<CoachRuntimeReceipt>(receiptScope)!.policyHash, "previous-policy");
    await x.command("pause");
    x.f.runtime.command(x.f.command("update", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
    await x.command("resume");
    assert.equal(x.f.runtime.read().settings?.status, "active");
    assert.equal(x.f.store.coachLoopState<CoachRuntimeReceipt>(receiptScope)!.policyHash, COACH_RUNTIME_POLICY_HASH);
  } finally { x.close(); }
});

test("a past race is retained as history while unified refresh and coach lifecycle generate daily training", async () => {
  const x = fixture();
  try {
    const result = await x.command("set_race_goal", { date: "2026-10-07", distanceKm: 10, goal: "finish", targetTimeSeconds: null });
    assert.equal(result.after.mode, "coach");
    const goal = x.f.store.currentTrainingPlan()!.state.raceGoal;
    assert.ok(goal);
    let read = x.f.runtime.read();
    assert.equal(read.settings?.mode, "daily_adaptive");
    assert.equal(read.settings?.race, null);
    assert.ok(read.days.some(day => day.executable), "a historical race must not turn the whole week into rest");
    for (const action of ["pause", "resume", "refresh"] as const) {
      x.f.runtime.command(x.f.command(action));
      assert.deepEqual(x.f.store.currentTrainingPlan()!.state.raceGoal, goal, `${action} preserves the historical goal`);
    }
    await x.refresh();
    read = x.f.runtime.read();
    assert.ok(read.days.some(day => day.executable));
    assert.deepEqual(x.f.store.currentTrainingPlan()!.state.raceGoal, goal);
    x.f.runtime.command(x.f.command("end"));
    x.f.runtime.command(x.f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
    assert.equal(x.f.store.currentTrainingPlan()!.state.raceGoal, null, "a newly declared daily configuration may explicitly clear the old goal");
  } finally { x.close(); }
});

test("crossing the race date uses the Shanghai business day for both unified and execution mode", async () => {
  const x = fixture();
  try {
    await x.command("set_race_goal", { date: "2026-10-09", distanceKm: 10, goal: "finish", targetTimeSeconds: null });
    const goal = x.f.store.currentTrainingPlan()!.state.raceGoal;
    assert.equal(x.f.runtime.read().settings?.mode, "race_preparation");
    x.f.facts.date = "2026-10-10";
    x.f.facts.asOf = "2026-10-09T16:01:00Z"; // 00:01 in Shanghai, still October 9 in UTC.
    x.f.facts.inputs.today.today.localDate = x.f.facts.date;
    x.f.facts.factsHash = "after-race";
    assert.equal(x.f.runtime.read().settings?.mode, "daily_adaptive");
    await x.refresh();
    assert.ok(x.f.runtime.read().days.some(day => day.executable));
    assert.deepEqual(x.f.store.currentTrainingPlan()!.state.raceGoal, goal);
  } finally { x.close(); }
});

test("coach receipts keep a v2 race identity through lifecycle and target-time updates", async () => {
  const x = fixture();
  try {
    await x.command("set_race_goal", { date: "2026-12-06", distanceKm: 10, goal: "time", targetTimeSeconds: 3000 });
    const goal = x.f.store.currentTrainingPlan()!.state.raceGoal!;
    for (const action of ["pause", "resume", "refresh"] as const) {
      x.f.runtime.command(x.f.command(action));
      assert.equal(x.f.store.currentTrainingPlan()!.state.raceGoal!.id, goal.id);
    }
    const current = x.f.runtime.read().settings!;
    x.f.runtime.command(x.f.command("update", { settings: { ...settings, mode: "race_preparation",
      race: { ...current.race!, targetTimeSeconds: 2700 } } }));
    assert.equal(x.f.store.currentTrainingPlan()!.state.raceGoal!.id, goal.id);
    assert.equal(x.f.store.currentTrainingPlan()!.state.raceGoal!.targetTimeSeconds, 2700);
    await x.command("set_race_goal", { date: "2026-12-13", distanceKm: 10, goal: "time", targetTimeSeconds: 2700 });
    assert.notEqual(x.f.store.currentTrainingPlan()!.state.raceGoal!.id, goal.id, "changing the race date creates a new identity");
  } finally { x.close(); }
});
