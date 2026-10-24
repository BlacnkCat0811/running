import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";

import type { TrainingPlanCommandPreviewRequest, TrainingPlanCommandRequest } from "@rai/api-contracts";

import { MobileGoalsStore } from "../src/mobile-goals.js";
import { digest } from "../src/plan-digest.js";
import {
  TRAINING_PLAN_PREVIEW_TTL_SECONDS,
  TrainingPlanCommandService
} from "../src/training-plan-commands.js";
import { trainingPlanContextDigest } from "../src/training-mode-policy.js";
import { TrainingPlanStore, type TrainingPlanState } from "../src/training-plan-store.js";
import { createTrainingPlanCommandHandlers } from "../src/training-plan-routes.js";
import { trainingPlanGenerationDeps } from "../src/training-plan-generation.js";
import { TryAcquireGate } from "../src/try-acquire-gate.js";
import { TrainingPlanCoordinator } from "../src/training-plan-coordinator.js";

/**
 * PR4-2: configuration commands over the unified state.
 *
 * Pinned here:
 * - preview is stateless and writes nothing (state revision and goals revision both
 *   unchanged), and its candidate id binds action + draft + revision + expiry;
 * - submit commits the unified state, its history row, the legacy goals mirror and
 *   the operation result in one publication transaction, and is idempotent per
 *   operationId;
 * - a stale/expired/tampered candidate and a stale revision are explicit 409s;
 * - an ended programme cannot be resumed;
 * - the command does NOT claim a regenerated plan: both responses and the v2 read
 *   say the plan needs a refresh.
 */

const identity = () => ({ serverId: "server", athleteId: "athlete", datasetEpoch: "epoch" });
const scope = identity();
const scopeKey = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
const BUSINESS_DATE = "2026-10-20";

const createFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "rai-training-plan-command-"));
  const controlPath = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, controlPath);
  const database = new DatabaseSync(controlPath);
  const unified = new TrainingPlanStore(database);
  const migrate = (overrides: Partial<TrainingPlanState> = {}) => {
    const state: TrainingPlanState = {
      schemaVersion: 1,
      migrationVersion: 1,
      source: "legacy_goals",
      sourceStatus: "active",
      sourceDigest: digest({ source: overrides }).slice(0, 64),
      runState: "active",
      raceGoal: null,
      preferencesComplete: true,
      legacyRaceTarget: null,
      weekPlan: [],
      lockedSession: null,
      runCoach: null,
      coachLoop: null,
      goalsRevision: goals.read().revision,
      planContextDigest: null,
      migratedAt: "2026-10-20T04:00:00.000Z",
      ...overrides
    };
    const applied = unified.applyMigration({ scope: scopeKey, expectedAbsentOrRevision: 0,
      sourceDigest: state.sourceDigest, state });
    assert.equal(applied.status, "applied");
    return state;
  };
  const service = (now = () => Date.parse("2026-10-20T04:00:00.000Z")) =>
    new TrainingPlanCommandService(goals, () => scopeKey, identity, () => BUSINESS_DATE, now);
  const close = () => { database.close(); goals.close(); rmSync(root, { recursive: true, force: true }); };
  return { goals, database, controlPath, unified, migrate, service, close };
};

const preview = (overrides: Partial<TrainingPlanCommandPreviewRequest> = {}): TrainingPlanCommandPreviewRequest => ({
  contractVersion: 2,
  operationScope: scope,
  action: "set_race_goal",
  raceGoal: { date: "2026-12-06", distanceKm: 10, goal: "time", targetTimeSeconds: 3000 },
  ...overrides
});

test("预览不写任何行，且候选绑定动作/草稿/revision/过期时间", () => {
  const fixture = createFixture();
  try {
    const state = fixture.migrate();
    const rowBefore = fixture.goals.trainingPlanStateRow(scopeKey)!;
    const goalsBefore = fixture.goals.read().revision;
    const result = fixture.service().preview(preview({ expectedStateRevision: rowBefore.revision }));
    assert.equal(result.contractVersion, 2);
    assert.equal(result.before.mode, "coach");
    assert.equal(result.after.mode, "race");
    assert.equal(result.after.raceGoal?.date, "2026-12-06");
    assert.equal(result.after.raceGoal?.support.distance, "ten_k");
    assert.equal(result.changes.modeChanged, true);
    assert.equal(result.changes.goalIdentity, "unset");
    assert.equal(result.planRefreshRequired, true);
    assert.equal(result.expectedStateRevision, rowBefore.revision);
    assert.ok(result.candidateId.includes(result.expiresAt));
    const rowAfter = fixture.goals.trainingPlanStateRow(scopeKey)!;
    assert.equal(rowAfter.revision, rowBefore.revision, "preview must not write the unified state");
    assert.equal(fixture.goals.read().revision, goalsBefore, "preview must not write the legacy goals");
    assert.equal(state.goalsRevision, goalsBefore);
  } finally {
    fixture.close();
  }
});

test("草稿不完整/跨域/陈旧 revision 都被显式拒绝", () => {
  const fixture = createFixture();
  try {
    const state = fixture.migrate();
    assert.throws(() => fixture.service().preview(preview({ raceGoal: { date: "2026-12-06", distanceKm: null } })), (error: unknown) =>
      (error as { code?: string }).code === "training_configuration_invalid");
    assert.throws(() => fixture.service().preview(preview({
      operationScope: { ...scope, datasetEpoch: "other" }
    })), (error: unknown) => (error as { code?: string }).code === "training_scope_mismatch");
    const row = fixture.goals.trainingPlanStateRow(scopeKey)!;
    assert.throws(() => fixture.service().preview(preview({ expectedStateRevision: row.revision + 5 })),
      (error: unknown) => (error as { code?: string }).code === "training_revision_conflict");
    assert.equal(state.sourceStatus, "active");
  } finally {
    fixture.close();
  }
});

test("提交：统一状态+历史+旧 goals 镜像同一事务，且计划被标记待刷新", () => {
  const fixture = createFixture();
  try {
    fixture.migrate();
    const row = fixture.goals.trainingPlanStateRow(scopeKey)!;
    const service = fixture.service();
    const previewed = service.preview(preview({ expectedStateRevision: row.revision }));
    const request: TrainingPlanCommandRequest = {
      contractVersion: 2,
      operationId: "op-1",
      operationScope: scope,
      expectedStateRevision: row.revision,
      candidateId: previewed.candidateId,
      action: "set_race_goal",
      raceGoal: { date: "2026-12-06", distanceKm: 10, goal: "time", targetTimeSeconds: 3000 }
    };
    const result = service.submit(request);
    assert.equal(result.after.mode, "race");
    assert.equal(result.stateRevision, row.revision + 1);
    assert.equal(result.planRefreshRequired, true);
    const after = fixture.goals.trainingPlanStateRow(scopeKey)!;
    assert.equal(after.revision, row.revision + 1);
    assert.equal(after.state.raceGoal?.date, "2026-12-06");
    assert.equal(after.state.planContextDigest, trainingPlanContextDigest({
      raceGoal: after.state.raceGoal, runState: after.state.runState
    }));
    // The legacy mirror: v1 readers see the same goal, and the legacy generator is
    // blocked until the unified refresh publishes a plan.
    const goals = fixture.goals.read();
    assert.deepEqual(goals.raceTarget, { date: "2026-12-06", distance: "ten_k", targetPaceSecondsPerKm: null });
    assert.equal(goals.weekPlanReplanRequired, true);
    assert.equal(after.state.goalsRevision, goals.revision);
  } finally {
    fixture.close();
  }
});

test("同 operationId 重放返回原结果、不重复写；换请求内容被拒绝", () => {
  const fixture = createFixture();
  try {
    fixture.migrate();
    const row = fixture.goals.trainingPlanStateRow(scopeKey)!;
    const service = fixture.service();
    const base: TrainingPlanCommandRequest = {
      contractVersion: 2, operationId: "op-replay", operationScope: scope,
      expectedStateRevision: row.revision,
      candidateId: service.preview(preview({ expectedStateRevision: row.revision })).candidateId,
      action: "set_race_goal",
      raceGoal: { date: "2026-12-06", distanceKm: 10, goal: "time", targetTimeSeconds: 3000 }
    };
    const first = service.submit(base);
    const revisionAfterFirst = fixture.goals.trainingPlanStateRow(scopeKey)!.revision;
    const replay = service.submit(base);
    assert.deepEqual(replay, first, "a same-key/same-request retry must return the stored result");
    assert.equal(fixture.goals.trainingPlanStateRow(scopeKey)!.revision, revisionAfterFirst,
      "a replay must not write the state again");
    assert.throws(() => service.submit({ ...base, raceGoal: { date: "2026-12-13", distanceKm: 10, goal: "finish" } }),
      (error: unknown) => (error as { code?: string }).code === "plan_operation_key_conflict");
  } finally {
    fixture.close();
  }
});

test("过期候选与篡改候选被拒绝（先重放查询、后过期判定）", () => {
  const fixture = createFixture();
  try {
    fixture.migrate();
    const row = fixture.goals.trainingPlanStateRow(scopeKey)!;
    let clock = Date.parse("2026-10-20T04:00:00.000Z");
    const service = fixture.service(() => clock);
    const previewed = service.preview(preview({ expectedStateRevision: row.revision }));
    const request: TrainingPlanCommandRequest = {
      contractVersion: 2, operationId: "op-expiry", operationScope: scope,
      expectedStateRevision: row.revision, candidateId: previewed.candidateId,
      action: "set_race_goal",
      raceGoal: { date: "2026-12-06", distanceKm: 10, goal: "time", targetTimeSeconds: 3000 }
    };
    clock += (TRAINING_PLAN_PREVIEW_TTL_SECONDS + 1) * 1000;
    assert.throws(() => service.submit(request), (error: unknown) =>
      (error as { code?: string }).code === "training_candidate_expired");
    assert.equal(fixture.goals.trainingPlanStateRow(scopeKey)!.revision, row.revision,
      "an expired submit must write nothing");

    clock -= (TRAINING_PLAN_PREVIEW_TTL_SECONDS + 1) * 1000;
    // Flip one hex character of the digest, leaving the (still valid) expiry intact.
    const flipped = request.candidateId[0] === "0" ? "1" : "0";
    const tampered = `${flipped}${request.candidateId.slice(1)}`;
    assert.throws(() => service.submit({ ...request, candidateId: tampered }), (error: unknown) =>
      (error as { code?: string }).code === "training_candidate_mismatch");
  } finally {
    fixture.close();
  }
});

test("暂停/恢复只改运行意愿；结束后的节目不能恢复", () => {
  const fixture = createFixture();
  try {
    fixture.migrate();
    const service = fixture.service();
    const row = () => fixture.goals.trainingPlanStateRow(scopeKey)!;
    const submit = (action: "pause" | "resume", revision: number, operationId: string) => {
      const candidate = service.preview({ contractVersion: 2, operationScope: scope, action,
        expectedStateRevision: revision });
      return service.submit({ contractVersion: 2, operationId, operationScope: scope,
        expectedStateRevision: revision, candidateId: candidate.candidateId, action } as TrainingPlanCommandRequest);
    };
    const paused = submit("pause", row().revision, "op-pause");
    assert.equal(paused.after.runState, "paused");
    assert.equal(row().state.runState, "paused");
    const resumed = submit("resume", row().revision, "op-resume");
    assert.equal(resumed.after.runState, "active");
    assert.equal(row().state.runState, "active");
  } finally {
    fixture.close();
  }

  const ended = createFixture();
  try {
    ended.migrate({ sourceStatus: "ended", runState: "paused" });
    const service = ended.service();
    const row = ended.goals.trainingPlanStateRow(scopeKey)!;
    assert.throws(() => service.preview({ contractVersion: 2, operationScope: scope, action: "resume",
      expectedStateRevision: row.revision }), (error: unknown) =>
      (error as { code?: string }).code === "training_cannot_resume");
  } finally {
    ended.close();
  }
});

test("未迁移的 scope 不能预览或提交", () => {
  const fixture = createFixture();
  try {
    assert.throws(() => fixture.service().preview(preview()),
      (error: unknown) => (error as { code?: string }).code === "training_plan_not_migrated");
  } finally {
    fixture.close();
  }
});

// ---------------------------------------------------------------------------
// PR4-3: refresh publishes the plan and the unified state in one transaction
// ---------------------------------------------------------------------------

const generatedDays = (): import("@rai/api-contracts").MobilePlannedDay[] => [
  { localDate: "2026-10-21", kind: "easy", distanceKm: 5.2, structure: null, reason: "generated" },
  { localDate: "2026-10-22", kind: "rest", distanceKm: null, structure: null, reason: "generated rest" }
];
const generatedAudit = (): import("@rai/api-contracts").MobilePlanAudit => ({
  generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: "2026-10-20T04:30:00.000Z"
});

test("migrated run-coach preferences survive commands, automatic refresh, projection writes and reopening", async () => {
  const fixture = createFixture();
  try {
    const preferences: import("@rai/api-contracts").MobileRunCoachPlan = {
      id: "migrated-preferences", goal: "fitness", raceDate: null, raceDistanceKm: null, targetTimeSeconds: null,
      runningDays: [2, 4, 6], longRunDays: [6], targetType: "heart_rate", strengthTraining: true,
      durationWeeks: 12, startedOn: BUSINESS_DATE, status: "active", pausedOn: null, endedOn: null,
      adaptationKey: null, adaptedAt: null
    };
    fixture.goals.write({}, { runCoach: preferences });
    fixture.migrate({ source: "run_coach", runCoach: preferences });
    fixture.goals.bindTrainingPlanOwner(identity, () => BUSINESS_DATE);
    const service = fixture.service();
    for (const action of ["pause", "set_race_goal", "clear_race_goal", "resume"] as const) {
      const revision = fixture.goals.currentTrainingPlan()!.revision;
      const draft = preview({ action, expectedStateRevision: revision });
      const candidate = service.preview(draft);
      service.submit({ ...draft, operationId: `preserve-${action}`, expectedStateRevision: revision,
        candidateId: candidate.candidateId });
      assert.deepEqual(fixture.goals.currentTrainingPlan()!.state.runCoach, preferences);
      assert.equal(fixture.goals.read().runCoach, null, "the legacy programme no longer owns execution");
    }
    const coordinator = new TrainingPlanCoordinator({
      scopeKey: () => scopeKey, readState: () => fixture.goals.currentTrainingPlan(), businessDate: () => BUSINESS_DATE,
      refresh: input => service.refresh({ contractVersion: 2, operationScope: scope, operationId: input.operationId,
        expectedStateRevision: input.stateRevision }, {
        prepare: async () => ({ days: generatedDays(), audit: generatedAudit(), warnings: [], prescription: null, fingerprint: "facts" }),
        fingerprint: () => "facts"
      })
    });
    assert.equal((await coordinator.tick()).ran, true, "automatic refresh uses the same preference-preserving write");
    fixture.goals.write({ qualitySessionCap: 1 });
    const reopened = new MobileGoalsStore("unused", fixture.controlPath);
    try {
      reopened.bindTrainingPlanOwner(identity, () => BUSINESS_DATE);
      assert.deepEqual(reopened.currentTrainingPlan()!.state.runCoach, preferences);
      assert.equal(reopened.currentTrainingPlan()!.state.preferencesComplete, true);
      assert.equal(reopened.read().runCoach, null);
    } finally { reopened.close(); }
  } finally { fixture.close(); }
});

test("generation latch: facts changed during generation cannot be stamped with the new version", async () => {
  const fixture = createFixture();
  try {
    fixture.migrate();
    const factsPath = fixture.controlPath + ".facts";
    const factsReader = new DatabaseSync(factsPath);
    factsReader.exec("CREATE TABLE facts(value INTEGER); INSERT INTO facts VALUES(1)");
    const factsWriter = new DatabaseSync(factsPath);
    const version = () => String(factsReader.prepare("PRAGMA data_version").get()!.data_version);
    const originalVersion = version();
    try {
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const latch = new Promise<void>(resolve => { finish = resolve; });
    const gate = new TryAcquireGate();
    const deps = trainingPlanGenerationDeps({
      publicationReady: () => true,
      snapshot: () => ({ fingerprint: "unchanged-recommendation-and-goals" }),
      dataVersion: version,
      tryAcquire: () => gate.tryAcquire(),
      generate: async () => {
        started(); await latch;
        return { days: generatedDays(), audit: generatedAudit(), warnings: [], prescription: null };
      }
    });
    const before = fixture.goals.read();
    const request = { contractVersion: 2 as const, operationScope: scope, operationId: "facts-latch", expectedStateRevision: 1 };
    const running = fixture.service().refresh(request, deps);
    await entered;
    await assert.rejects(fixture.service().refresh({ ...request, operationId: "busy" }, deps),
      (error: unknown) => (error as { code?: string }).code === "weekly_plan_generation_busy");
    factsWriter.exec("UPDATE facts SET value=2");
    assert.notEqual(version(), originalVersion, "a real external SQLite commit changes the read connection version");
    finish();
    await assert.rejects(running, (error: unknown) => (error as { code?: string }).code === "training_snapshot_changed");
    assert.deepEqual(fixture.goals.read(), before);
    assert.equal(fixture.goals.trainingPlanStateRow(scopeKey)!.revision, 1);
    assert.equal(fixture.goals.publicationInFlight(), false);
    assert.equal(fixture.goals.publicationGuardState().pendingSince, null);
    const release = gate.tryAcquire(); assert.ok(release); release();
    } finally { factsWriter.close(); factsReader.close(); }
  } finally { fixture.close(); }
});

test("facts readiness: HTTP generation rejects before reads, after generation and at commit; releases the lane and replays first", async () => {
  const fixture = createFixture();
  const app = Fastify();
  try {
    fixture.migrate();
    const service = fixture.service();
    const gate = new TryAcquireGate();
    let ready = true;
    let reads = 0;
    let becomeBusyDuringGeneration = false;
    const deps = trainingPlanGenerationDeps({
      publicationReady: () => ready,
      snapshot: () => { reads++; return { fingerprint: "stable-facts" }; },
      dataVersion: () => "stable-version",
      tryAcquire: () => gate.tryAcquire(),
      generate: async () => {
        if (becomeBusyDuringGeneration) ready = false;
        return { days: generatedDays(), audit: generatedAudit(), warnings: [], prescription: null };
      }
    });
    const handlers = createTrainingPlanCommandHandlers(service, deps);
    app.post("/commands", handlers.submit);
    const candidate = service.preview(preview({ expectedStateRevision: 1 }));
    const body = { ...preview({ expectedStateRevision: 1 }), expectedStateRevision: 1,
      operationId: "readiness-command", candidateId: candidate.candidateId };
    const before = () => ["mobile_goals", "mobile_goals_history", "mobile_training_state", "mobile_training_state_history", "mobile_plan_operations"]
      .map(table => fixture.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const frozen = before();
    ready = false;
    const busy = await app.inject({ method: "POST", url: "/commands", payload: body });
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().code, "coach_sync_pending");
    assert.equal(reads, 0, "busy facts cannot enter snapshot generation");
    assert.deepEqual(before(), frozen);
    ready = true; becomeBusyDuringGeneration = true;
    const lateBusy = await app.inject({ method: "POST", url: "/commands", payload: body });
    assert.equal(lateBusy.json().code, "coach_sync_pending");
    assert.deepEqual(before(), frozen, "busy during generation writes no operation, history or state");
    const release = gate.tryAcquire(); assert.ok(release); release();
    ready = true; becomeBusyDuringGeneration = false;
    const prepared = await deps.prepare(service.planFor(body).afterState);
    ready = false;
    assert.throws(() => service.submit(body, { prepared, fingerprint: deps.fingerprint }),
      (error: unknown) => (error as { code?: string }).code === "coach_sync_pending");
    assert.deepEqual(before(), frozen, "commit rechecks task readiness even when fact fingerprints have not moved");
    ready = true;
    const committed = await app.inject({ method: "POST", url: "/commands", payload: body });
    assert.equal(committed.statusCode, 200, committed.body);
    const after = before(); const readsAfter = reads;
    ready = false;
    const replayed = await app.inject({ method: "POST", url: "/commands", payload: body });
    assert.deepEqual(replayed.json(), committed.json());
    assert.equal(reads, readsAfter, "committed replay precedes readiness and generation");
    assert.deepEqual(before(), after);
  } finally { await app.close(); fixture.close(); }
});

for (const action of ["set_race_goal", "pause"] as const) {
  test(`HTTP ${action}: durable replay precedes revision/TTL/generation, including restart`, async () => {
    const fixture = createFixture();
    const app = Fastify({ logger: false });
    let generations = 0;
    let clock = Date.parse("2026-10-20T04:00:00.000Z");
    try {
      fixture.migrate();
      const service = fixture.service(() => clock);
      const handlers = createTrainingPlanCommandHandlers(service, {
        prepare: async () => {
          generations++;
          return { days: generatedDays(), audit: generatedAudit(), warnings: [], prescription: null,
            fingerprint: "facts" };
        }, fingerprint: () => "facts"
      });
      app.post("/v1/mobile/training-plan/commands", handlers.submit);
      const draft = preview({ action, ...(action === "pause" ? { raceGoal: null } : {}) });
      const candidate = service.preview(draft);
      const payload = { ...draft, operationId: `http-${action}`, candidateId: candidate.candidateId,
        expectedStateRevision: candidate.expectedStateRevision };
      const send = (body: unknown) => app.inject({ method: "POST", url: "/v1/mobile/training-plan/commands", payload: body as object });
      const first = await send(payload);
      assert.equal(first.statusCode, 200, first.body);
      const snapshot = () => fixture.database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mobile_%' ORDER BY name"
      ).all().map(row => ({ name: row.name, rows: fixture.database.prepare(`SELECT * FROM ${row.name}`).all() }));
      const after = snapshot();
      clock += 121_000; // A committed result survives candidate expiry.
      const retry = await send(payload);
      assert.equal(retry.statusCode, 200, retry.body);
      assert.deepEqual(retry.json(), first.json());
      const conflict = await send({ ...payload, candidateId: "different" });
      assert.equal(conflict.json().code, "plan_operation_key_conflict", conflict.body);
      assert.equal((await send({ ...payload, operationScope: { ...scope, datasetEpoch: "other" } })).json().code,
        "training_scope_mismatch");
      // Fresh service + fresh SQLite connection: no in-memory candidate/result can answer this.
      const reopened = new MobileGoalsStore("unused", fixture.controlPath);
      try {
        const restarted = new TrainingPlanCommandService(reopened, () => scopeKey, identity, () => BUSINESS_DATE, () => clock);
        const restartApp = Fastify({ logger: false });
        restartApp.post("/commands", createTrainingPlanCommandHandlers(restarted, {
          prepare: async () => { throw new Error("replay must never generate"); }, fingerprint: () => "changed"
        }).submit);
        try {
          const restored = await restartApp.inject({ method: "POST", url: "/commands", payload });
          assert.equal(restored.statusCode, 200, restored.body);
          assert.deepEqual(restored.json(), first.json());
        } finally { await restartApp.close(); }
      } finally { reopened.close(); }
      assert.equal(generations, action === "pause" ? 0 : 1);
      assert.deepEqual(snapshot(), after, "replay/conflicts must not change goals, unified, history or operation tables");
      fixture.database.prepare("UPDATE mobile_plan_operations SET expires_at = '2000-01-01T00:00:00Z'").run();
      const expired = await send(payload);
      assert.equal(expired.statusCode, 410, expired.body);
      assert.equal(expired.json().code, "plan_operation_expired");
      assert.equal(generations, action === "pause" ? 0 : 1);
    } finally { await app.close(); fixture.close(); }
  });
}

for (const [table, event] of [["mobile_goals", "UPDATE"], ["mobile_goals_history", "INSERT"],
  ["mobile_training_state", "UPDATE"], ["mobile_training_state_history", "INSERT"], ["mobile_plan_operations", "INSERT"]]) {
  test(`publication abort at ${table}: all business rows roll back and lane can retry`, () => {
    const fixture = createFixture();
    try {
      fixture.migrate();
      fixture.goals.bindTrainingPlanOwner(identity);
      const service = fixture.service();
      const candidate = service.preview(preview());
      const request = { ...preview(), operationId: "atomic-failure", expectedStateRevision: candidate.expectedStateRevision,
        candidateId: candidate.candidateId } as TrainingPlanCommandRequest;
      const beforeGoals = fixture.goals.read();
      const beforeUnified = fixture.goals.trainingPlanStateRow(scopeKey);
      const counts = () => ["mobile_goals_history", "mobile_training_state_history", "mobile_plan_operations"].map(name =>
        fixture.database.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()!.n);
      const beforeCounts = counts();
      fixture.database.exec(`CREATE TRIGGER phase5_abort BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
      assert.throws(() => service.submit(request), /synthetic failure/);
      assert.deepEqual(fixture.goals.read(), beforeGoals);
      assert.deepEqual(fixture.goals.trainingPlanStateRow(scopeKey), beforeUnified);
      assert.deepEqual(counts(), beforeCounts);
      assert.equal(fixture.goals.publicationGuardState().pendingSince, null);
      assert.equal(fixture.goals.publicationInFlight(), false);
      fixture.database.exec("DROP TRIGGER phase5_abort");
      assert.equal(service.submit(request).stateRevision, 2);
    } finally { fixture.close(); }
  });
}

test("刷新：生成在事务外、提交在事务内；计划与统一状态一起落库", async () => {
  const fixture = createFixture();
  try {
    fixture.migrate();
    const row = fixture.goals.trainingPlanStateRow(scopeKey)!;
    const service = fixture.service();
    const refreshDeps = {
      prepare: async () => ({ days: generatedDays(), audit: generatedAudit(), warnings: ["w"], prescription: null,
        fingerprint: "fingerprint-a" }),
      fingerprint: () => "fingerprint-a"
    };
    const result = await service.refresh({
      contractVersion: 2, operationId: "op-refresh", operationScope: scope,
      expectedStateRevision: row.revision
    }, refreshDeps);
    assert.equal(result.plan.current, true);
    assert.equal(result.goalsRevision, row.state.goalsRevision! + 1);
    const after = fixture.goals.trainingPlanStateRow(scopeKey)!;
    assert.equal(after.revision, row.revision + 1);
    assert.deepEqual(after.state.weekPlan.map((day) => day.localDate), ["2026-10-21", "2026-10-22"]);
    assert.equal(after.state.planContextDigest, trainingPlanContextDigest({ raceGoal: after.state.raceGoal, runState: after.state.runState }));
    assert.equal(after.state.goalsRevision, result.goalsRevision);
    const goals = fixture.goals.read();
    assert.equal(goals.weekPlanReplanRequired, false, "a published plan clears the confirmation marker");
    assert.equal(goals.weekPlan.some((day) => day.localDate === "2026-10-21"), true);
  } finally {
    fixture.close();
  }
});

test("刷新：事实在生成期间变化 → 409，且不写任何行", async () => {
  const fixture = createFixture();
  try {
    fixture.migrate();
    const row = fixture.goals.trainingPlanStateRow(scopeKey)!;
    const service = fixture.service();
    let fingerprint = "fingerprint-a";
    const refreshDeps = {
      prepare: async () => ({ days: generatedDays(), audit: generatedAudit(), warnings: [], prescription: null,
        fingerprint: "fingerprint-a" }),
      fingerprint: () => fingerprint
    };
    fingerprint = "fingerprint-b";
    await assert.rejects(() => service.refresh({
      contractVersion: 2, operationId: "op-refresh-stale", operationScope: scope,
      expectedStateRevision: row.revision
    }, refreshDeps), (error: unknown) => (error as { code?: string }).code === "training_snapshot_changed");
    assert.equal(fixture.goals.trainingPlanStateRow(scopeKey)!.revision, row.revision);
    assert.equal(fixture.goals.read().weekPlanReplanRequired, false);
  } finally {
    fixture.close();
  }
});

test("刷新：空计划不写行、准入释放，后续合法请求仍可继续", async () => {
  const fixture = createFixture();
  try {
    fixture.migrate();
    const row = fixture.goals.trainingPlanStateRow(scopeKey)!;
    const service = fixture.service();
    const gate = new TryAcquireGate();
    const deps = trainingPlanGenerationDeps({
      publicationReady: () => true,
      snapshot: () => ({ fingerprint: "empty-plan-facts" }),
      dataVersion: () => "v1",
      tryAcquire: () => gate.tryAcquire(),
      generate: async () => ({ days: [], audit: generatedAudit(), warnings: [], prescription: null })
    });
    await assert.rejects(() => service.refresh({
      contractVersion: 2, operationId: "op-empty-plan", operationScope: scope, expectedStateRevision: row.revision
    }, deps), (error: unknown) => (error as { code?: string }).code === "training_plan_empty");
    assert.equal(fixture.goals.trainingPlanStateRow(scopeKey)!.revision, row.revision);
    assert.equal(fixture.goals.publicationInFlight(), false);
    const release = gate.tryAcquire();
    assert.ok(release, "the generation gate must be released after an empty result");
    release();
  } finally {
    fixture.close();
  }
});

test("刷新：暂停状态拒绝生成；重放返回原结果不重复写", async () => {
  const fixture = createFixture();
  try {
    fixture.migrate({ runState: "paused" });
    const row = fixture.goals.trainingPlanStateRow(scopeKey)!;
    const service = fixture.service();
    await assert.rejects(() => service.refresh({
      contractVersion: 2, operationId: "op-refresh-paused", operationScope: scope,
      expectedStateRevision: row.revision
    }, { prepare: async () => { throw new Error("must not be called"); }, fingerprint: () => "x" }),
    (error: unknown) => (error as { code?: string }).code === "training_paused");
  } finally {
    fixture.close();
  }

  const active = createFixture();
  try {
    active.migrate();
    const row = active.goals.trainingPlanStateRow(scopeKey)!;
    const service = active.service();
    const deps = {
      prepare: async () => ({ days: generatedDays(), audit: generatedAudit(), warnings: [], prescription: null,
        fingerprint: "fingerprint-a" }),
      fingerprint: () => "fingerprint-a"
    };
    const request = { contractVersion: 2 as const, operationId: "op-refresh-replay", operationScope: scope,
      expectedStateRevision: row.revision };
    const first = await service.refresh(request, deps);
    const revision = active.goals.trainingPlanStateRow(scopeKey)!.revision;
    const replay = await service.refresh(request, deps);
    assert.deepEqual(replay, first);
    assert.equal(active.goals.trainingPlanStateRow(scopeKey)!.revision, revision);
  } finally {
    active.close();
  }
});

// ---------------------------------------------------------------------------
// PR4-4: one operation publishes configuration AND plan atomically
// ---------------------------------------------------------------------------

test("单次命令：配置+计划同一操作发布，指纹不一致则整体拒绝", async () => {
  const fixture = createFixture();
  try {
    fixture.migrate();
    const row = fixture.goals.trainingPlanStateRow(scopeKey)!;
    const service = fixture.service();
    const request: TrainingPlanCommandRequest = {
      contractVersion: 2, operationId: "op-one-call", operationScope: scope,
      expectedStateRevision: row.revision,
      candidateId: service.preview(preview({ expectedStateRevision: row.revision })).candidateId,
      action: "set_race_goal",
      raceGoal: { date: "2026-12-06", distanceKm: 10, goal: "time", targetTimeSeconds: 3000 }
    };
    const prepared = {
      days: generatedDays(), audit: generatedAudit(), warnings: ["plan-warning"],
      prescription: null, fingerprint: "fp-1"
    };
    let fingerprint = "fp-1";
    const result = service.submit(request, { prepared, fingerprint: () => fingerprint });
    assert.equal(result.planRefreshRequired, false);
    assert.ok(result.plan !== null);
    assert.equal(result.plan!.goalsRevision, fixture.goals.read().revision);
    assert.deepEqual(result.plan!.days.map((day) => day.localDate), ["2026-10-21", "2026-10-22"]);
    const goals = fixture.goals.read();
    assert.equal(goals.weekPlanReplanRequired, false);
    assert.equal(goals.weekPlan.some((day) => day.localDate === "2026-10-21"), true);
    assert.deepEqual(goals.raceTarget, { date: "2026-12-06", distance: "ten_k", targetPaceSecondsPerKm: null });
    const state = fixture.goals.trainingPlanStateRow(scopeKey)!.state;
    assert.equal(state.weekPlan.some((day) => day.localDate === "2026-10-21"), true);
    assert.equal(state.planContextDigest, trainingPlanContextDigest({ raceGoal: state.raceGoal, runState: state.runState }));

    // A fact import between generation and commit must fail the whole operation.
    const request2: TrainingPlanCommandRequest = {
      ...request, operationId: "op-one-call-stale",
      candidateId: service.preview(preview({ expectedStateRevision: fixture.goals.trainingPlanStateRow(scopeKey)!.revision })).candidateId,
      expectedStateRevision: fixture.goals.trainingPlanStateRow(scopeKey)!.revision
    };
    const before = fixture.goals.trainingPlanStateRow(scopeKey)!.revision;
    fingerprint = "fp-2";
    assert.throws(() => service.submit(request2, { prepared, fingerprint: () => fingerprint }), (error: unknown) =>
      (error as { code?: string }).code === "training_snapshot_changed");
    assert.equal(fixture.goals.trainingPlanStateRow(scopeKey)!.revision, before);
  } finally {
    fixture.close();
  }
});

test("命令体形状错误返回 422 training_command_invalid，而不是 500", async () => {
  const fixture = createFixture();
  const app = Fastify({ logger: false });
  try {
    fixture.migrate();
    app.post("/commands", createTrainingPlanCommandHandlers(fixture.service()).preview);
    for (const payload of [
      { operationScope: scope, action: "delete" },
      { action: "pause" },
      { contractVersion: 2, operationScope: scope }
    ]) {
      const response = await app.inject({ method: "POST", url: "/commands", payload });
      assert.equal(response.statusCode, 422, response.body);
      assert.equal(response.json().code, "training_command_invalid");
    }
  } finally {
    await app.close();
    fixture.close();
  }
});

test("暂停命令不发布课表：planRefreshRequired 为真且 plan 为空", () => {
  const fixture = createFixture();
  try {
    fixture.migrate();
    const row = fixture.goals.trainingPlanStateRow(scopeKey)!;
    const service = fixture.service();
    const candidate = service.preview({ contractVersion: 2, operationScope: scope, action: "pause",
      expectedStateRevision: row.revision });
    const result = service.submit({ contractVersion: 2, operationId: "op-pause-no-plan", operationScope: scope,
      expectedStateRevision: row.revision, candidateId: candidate.candidateId, action: "pause" });
    assert.equal(result.planRefreshRequired, true);
    assert.equal(result.plan, null);
    assert.equal(result.after.runState, "paused");
  } finally {
    fixture.close();
  }
});
