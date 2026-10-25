import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";

import type { TrainingPlanStateResponseV2 } from "@rai/api-contracts";

import { MobileGoalsStore } from "../src/mobile-goals.js";
import { digest } from "../src/plan-digest.js";
import {
  buildTrainingPlanStateV2,
  createTrainingPlanStateRoute,
  requestedTrainingPlanContract
} from "../src/training-plan-routes.js";
import {
  TrainingPlanStore,
  type TrainingPlanState,
  type TrainingPlanLegacyState,
  type TrainingPlanStateRow
} from "../src/training-plan-store.js";

/**
 * PR4-1: the negotiated unified read.
 *
 * What is pinned here:
 * - negotiation is explicit (absent/1 → legacy; 2 → unified; anything else → 409);
 * - the v2 projection derives the mode live from `(raceGoal, businessDate)` and
 *   never claims an execution grant;
 * - a not-migrated scope is an explicit error, never a silent legacy fallback;
 * - the read path never writes: two GETs leave the state revision unchanged.
 */

const identity = () => ({ serverId: "server", athleteId: "athlete", datasetEpoch: "epoch" });
const scope = identity();
const scopeKey = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);

const stateRow = (state: Partial<TrainingPlanLegacyState> = {}, revision = 3): TrainingPlanStateRow => ({
  scope: scopeKey,
  revision,
  updatedAt: "2026-10-20T04:00:00.000Z",
  state: {
    schemaVersion: 1,
    migrationVersion: 1,
    source: "legacy_goals",
    sourceStatus: "active",
    sourceDigest: "a".repeat(64),
    runState: "active",
    raceGoal: null,
    preferencesComplete: true,
    legacyRaceTarget: null,
    weekPlan: [],
    lockedSession: null,
    runCoach: null,
    coachLoop: null,
    goalsRevision: 7,
    planContextDigest: null,
    migratedAt: "2026-10-20T04:00:00.000Z",
    ...state
  }
});

test("合同协商只接受 1 或 2，未知版本显式拒绝而不是回退", () => {
  assert.deepEqual(requestedTrainingPlanContract({}), { version: 1, raw: null });
  assert.deepEqual(requestedTrainingPlanContract({ "x-rai-training-contract": "" }), { version: 1, raw: null });
  assert.deepEqual(requestedTrainingPlanContract({ "x-rai-training-contract": "1" }), { version: 1, raw: "1" });
  assert.deepEqual(requestedTrainingPlanContract({ "x-rai-training-contract": "2" }), { version: 2, raw: "2" });
  assert.deepEqual(requestedTrainingPlanContract({ "x-rai-training-contract": ["2"] }), { version: 2, raw: "2" });
  for (const raw of ["3", "v2", "two", " 3 "]) {
    assert.deepEqual(requestedTrainingPlanContract({ "x-rai-training-contract": raw }), { version: "unsupported", raw });
  }
});

test("v2 投影：模式按业务日期派生，读取不带执行授权", () => {
  const coach = buildTrainingPlanStateV2({ scope, businessDate: "2026-10-20", row: stateRow(), currentGoalsRevision: 7 });
  assert.equal(coach.contractVersion, 2);
  assert.equal(coach.mode, "coach");
  assert.equal(coach.modeReason, "no_race_goal");
  assert.equal(coach.runState, "active");
  assert.equal(coach.admission, "ready");
  assert.equal(coach.raceGoal, null);
  assert.equal(coach.execution.permitted, false);
  assert.deepEqual(coach.execution.reasonCodes, ["projection_only", "facts_freshness_not_evaluated", "device_coordination_not_evaluated"]);

  const race = buildTrainingPlanStateV2({
    scope, businessDate: "2026-10-20", currentGoalsRevision: 7,
    row: stateRow({ raceGoal: { id: "goal-1", date: "2026-12-06", distanceKm: 10, goal: "time", targetTimeSeconds: 3000 } })
  });
  assert.equal(race.mode, "race");
  assert.equal(race.modeReason, "race_goal_upcoming");
  assert.equal(race.daysToRace, 47);
  assert.equal(race.raceGoal?.support.distance, "ten_k");
  assert.equal(race.raceGoal?.support.support, "standard");
});

test("v2 投影：结束后不复活、结束时准入待确认、计划陈旧可判定", () => {
  const ended = buildTrainingPlanStateV2({
    scope, businessDate: "2026-10-20", currentGoalsRevision: 7,
    row: stateRow({ sourceStatus: "ended", runState: "paused" })
  });
  assert.equal(ended.runState, "paused", "an ended programme must never be reported active");
  assert.equal(ended.admission, "needs_confirmation");

  const needsConfig = buildTrainingPlanStateV2({
    scope, businessDate: "2026-10-20", currentGoalsRevision: 7,
    row: stateRow({ preferencesComplete: false })
  });
  assert.equal(needsConfig.admission, "needs_configuration");

  const movedGoals = buildTrainingPlanStateV2({
    scope, businessDate: "2026-10-20", currentGoalsRevision: 9,
    row: stateRow()
  });
  assert.equal(movedGoals.plan.current, false);
  assert.equal(movedGoals.plan.goalsRevision, 7);
  assert.equal(movedGoals.plan.currentGoalsRevision, 9);
});

test("v2 投影：只返回业务日起七日内的已发布意图，并按日期排序", () => {
  const built = buildTrainingPlanStateV2({
    scope, businessDate: "2026-10-20", currentGoalsRevision: 7,
    row: stateRow({
      weekPlan: [
        { localDate: "2026-10-22", kind: "tempo", distanceKm: 8, structure: null, reason: "quality" },
        { localDate: "2026-10-19", kind: "interval", distanceKm: 9, structure: null, reason: "past" },
        { localDate: "2026-10-21", kind: "easy", distanceKm: 5, structure: null, reason: "easy" },
        { localDate: "2026-10-27", kind: "easy", distanceKm: 5, structure: null, reason: "outside" }
      ],
      lockedSession: { localDate: "2026-10-20", kind: "easy", distanceKm: 5, structure: null, lockedAt: "2026-10-20T00:00:00.000Z" } as never
    })
  });
  assert.deepEqual(built.plan.days.map((day) => day.localDate), ["2026-10-21", "2026-10-22"]);
  assert.equal(built.plan.lockedToday, true);
});

test("路由：v2 返回统一投影，v1 原样走旧处理器，未知版本 409", async () => {
  const app = Fastify({ logger: false });
  let legacyCalls = 0;
  let unifiedReads = 0;
  app.get("/v1/mobile/training-plan-state", createTrainingPlanStateRoute({
    identity,
    businessDate: () => "2026-10-20",
    readUnifiedState: () => { unifiedReads += 1; return stateRow(); },
    readGoalsRevision: () => 7,
    legacy: () => { legacyCalls += 1; return { legacy: true }; }
  }));
  try {
    const v2 = await app.inject({ method: "GET", url: "/v1/mobile/training-plan-state",
      headers: { "x-rai-training-contract": "2" } });
    assert.equal(v2.statusCode, 200);
    assert.equal(v2.headers["cache-control"], "no-store");
    assert.equal(v2.headers["vary"], "X-RAI-Training-Contract");
    const body = v2.json() as TrainingPlanStateResponseV2;
    assert.equal(body.contractVersion, 2);
    assert.equal(body.scope.athleteId, "athlete");
    assert.equal(body.execution.permitted, false);
    assert.equal(legacyCalls, 0, "a v2 request must not touch the legacy snapshot path");
    assert.equal(unifiedReads, 1);

    const v1 = await app.inject({ method: "GET", url: "/v1/mobile/training-plan-state" });
    assert.equal(v1.statusCode, 200);
    assert.deepEqual(v1.json(), { legacy: true });
    assert.equal(legacyCalls, 1);
    assert.equal(unifiedReads, 1);

    const unsupported = await app.inject({ method: "GET", url: "/v1/mobile/training-plan-state",
      headers: { "x-rai-training-contract": "3" } });
    assert.equal(unsupported.statusCode, 409);
    assert.equal((unsupported.json() as { code: string }).code, "training_contract_unsupported");
    assert.equal(legacyCalls, 1, "an unknown contract must not be downgraded to v1");
  } finally {
    await app.close();
  }
});

test("路由：未迁移的 scope 是显式的 409，不静默回退；存储不可读是 503", async () => {
  const app = Fastify({ logger: false });
  let reads = 0;
  let failing = false;
  app.get("/v1/mobile/training-plan-state", createTrainingPlanStateRoute({
    identity,
    businessDate: () => "2026-10-20",
    readUnifiedState: () => {
      reads += 1;
      if (failing) throw new Error("control database is damaged");
      return null;
    },
    readGoalsRevision: () => 1,
    legacy: () => { throw new Error("legacy branch must not run for v2"); }
  }));
  try {
    const notMigrated = await app.inject({ method: "GET", url: "/v1/mobile/training-plan-state",
      headers: { "x-rai-training-contract": "2" } });
    assert.equal(notMigrated.statusCode, 409);
    assert.equal((notMigrated.json() as { code: string }).code, "training_plan_not_migrated");

    failing = true;
    const unavailable = await app.inject({ method: "GET", url: "/v1/mobile/training-plan-state",
      headers: { "x-rai-training-contract": "2" } });
    assert.equal(unavailable.statusCode, 503);
    assert.equal((unavailable.json() as { code: string }).code, "training_plan_state_unavailable");
    assert.equal(reads, 2);
  } finally {
    await app.close();
  }
});

test("存储→路由端到端：迁移后读出统一状态，且两次读取不写任何行", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-training-plan-v2-"));
  const controlPath = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, controlPath);
  const database = new DatabaseSync(controlPath);
  try {
    const unified = new TrainingPlanStore(database);
    const sourceDigest = digest({ source: "legacy_goals", revision: goals.read().revision });
    const state: TrainingPlanState = {
      ...stateRow().state,
      sourceDigest,
      goalsRevision: goals.read().revision
    };
    const applied = unified.applyMigration({ scope: scopeKey, expectedAbsentOrRevision: 0, sourceDigest, state });
    assert.equal(applied.status, "applied");

    const first = goals.trainingPlanStateRow(scopeKey);
    assert.ok(first, "the migrated state must be readable through the store facade");
    assert.equal(first!.state.sourceDigest, sourceDigest);
    const second = goals.trainingPlanStateRow(scopeKey);
    assert.equal(second!.revision, first!.revision, "GET must not bump the state revision");

    const built = buildTrainingPlanStateV2({
      scope, businessDate: "2026-10-20", row: first!, currentGoalsRevision: goals.read().revision
    });
    assert.equal(built.plan.current, true);

    // A legacy write after migration makes the state stale: still readable, but
    // explicitly `current: false` instead of pretending the projection is fresh.
    goals.write({});
    const stale = goals.trainingPlanStateRow(scopeKey)!;
    const after = buildTrainingPlanStateV2({
      scope, businessDate: "2026-10-20", row: stale, currentGoalsRevision: goals.read().revision
    });
    assert.equal(after.plan.current, false);
  } finally {
    database.close();
    goals.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("未迁移的 store 读返回 null（不是伪造的空状态）", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-training-plan-empty-"));
  const goals = new MobileGoalsStore(root, join(root, "control.sqlite"));
  try {
    assert.equal(goals.trainingPlanStateRow(scopeKey), null);
  } finally {
    goals.close();
    rmSync(root, { recursive: true, force: true });
  }
});
