import assert from "node:assert/strict";
import test from "node:test";

import type { TrainingPlanState } from "../src/training-plan-store.js";
import type { TrainingPlanStateRow } from "../src/training-plan-store.js";
import { trainingPlanContextDigest } from "../src/training-mode-policy.js";
import {
  TrainingPlanCoordinator,
  coordinatorOperationId,
  refreshDecision
} from "../src/training-plan-coordinator.js";

/**
 * PR4 remaining: the single automatic-refresh decision.
 *
 * Pinned here: paused/not-migrated scopes are never touched, a migrated legacy plan
 * is refreshed once, configuration and business-date drift are detected, the
 * operation key is deterministic (so repeated ticks replay instead of republishing),
 * and concurrent ticks collapse to one refresh.
 */

const BUSINESS_DATE = "2026-10-20";

const row = (state: Partial<TrainingPlanState> = {}, revision = 3): TrainingPlanStateRow => {
  const base: TrainingPlanState = {
    schemaVersion: 1,
    migrationVersion: 1,
    source: "legacy_goals",
    sourceStatus: "active",
    sourceDigest: "a".repeat(64),
    runState: "active",
    raceGoal: null,
    preferencesComplete: true,
    legacyRaceTarget: null,
    weekPlan: [
      { localDate: "2026-10-21", kind: "easy", distanceKm: 5, structure: null },
      { localDate: "2026-10-22", kind: "rest", distanceKm: null, structure: null }
    ],
    lockedSession: null,
    runCoach: null,
    coachLoop: null,
    goalsRevision: 7,
    planContextDigest: trainingPlanContextDigest({ raceGoal: null, runState: "active" }),
    migratedAt: "2026-10-20T04:00:00.000Z",
    ...state
  };
  return { scope: JSON.stringify(["server", "athlete", "epoch"]), revision, state: base, updatedAt: base.migratedAt };
};

test("刷新决策：未迁移/暂停/当前都不刷新；缺少上下文摘要与配置漂移要刷新", () => {
  assert.deepEqual(refreshDecision(null, BUSINESS_DATE), { needed: false, reason: "not_migrated" });
  assert.deepEqual(refreshDecision(row({ runState: "paused" }), BUSINESS_DATE), { needed: false, reason: "paused" });
  assert.deepEqual(refreshDecision(row(), BUSINESS_DATE), { needed: false, reason: "current" });
  assert.deepEqual(refreshDecision(row({ planContextDigest: null }), BUSINESS_DATE), { needed: true, reason: "plan_missing" });
  assert.deepEqual(refreshDecision(row({
    raceGoal: { id: "goal-1", date: "2026-12-06", distanceKm: 10, goal: "finish", targetTimeSeconds: null }
  }), BUSINESS_DATE), { needed: true, reason: "config_changed" });
  // A finished week (no stored intent inside the coming seven days) needs a new plan.
  assert.deepEqual(refreshDecision(row({ weekPlan: [] }), BUSINESS_DATE), { needed: true, reason: "business_date_changed" });
});

test("七日窗口（D5-D）：任一已发布日期命中即 current，缺失日期不补成休息", () => {
  // The product decision keeps the existing bounded trigger: a partial week is
  // still "current" (the page labels missing days as not generated), so this test
  // pins the absence of an implicit fill/rest loop.
  const oneDay = row({ weekPlan: [{ localDate: "2026-10-26", kind: "easy", distanceKm: 5, structure: null }] });
  assert.deepEqual(refreshDecision(oneDay, BUSINESS_DATE), { needed: false, reason: "current" });
  const outsideWindow = row({ weekPlan: [{ localDate: "2026-10-27", kind: "easy", distanceKm: 5, structure: null }] });
  assert.deepEqual(refreshDecision(outsideWindow, BUSINESS_DATE), { needed: true, reason: "business_date_changed" });
  assert.deepEqual(refreshDecision(row({ weekPlan: [] }), BUSINESS_DATE), { needed: true, reason: "business_date_changed" });
});

test("自动刷新操作键可推导：同输入同键，日期/revision/原因变化都变键", () => {
  const base = { scopeKey: "s", reason: "config_changed" as const, businessDate: BUSINESS_DATE, stateRevision: 3 };
  assert.equal(coordinatorOperationId(base), coordinatorOperationId({ ...base }));
  assert.notEqual(coordinatorOperationId(base), coordinatorOperationId({ ...base, businessDate: "2026-10-21" }));
  assert.notEqual(coordinatorOperationId(base), coordinatorOperationId({ ...base, stateRevision: 4 }));
  assert.notEqual(coordinatorOperationId(base), coordinatorOperationId({ ...base, reason: "plan_missing" }));
});

test("协调器单飞：并发的两次 tick 只跑一次刷新；跳过的那次不丢下一次决策", async () => {
  let release: (() => void) | null = null;
  let calls = 0;
  const coordinator = new TrainingPlanCoordinator({
    scopeKey: () => "s",
    readState: () => row({ planContextDigest: null }),
    businessDate: () => BUSINESS_DATE,
    refresh: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
    }
  });
  const first = coordinator.tick();
  const second = coordinator.tick();
  assert.equal(await second.then((result) => result.ran), false, "a concurrent tick must not stack another refresh");
  release!();
  assert.equal((await first).ran, true);
  assert.equal(calls, 1);

  // A failed refresh must clear the running flag so the next tick can retry.
  let fail = true;
  const failing = new TrainingPlanCoordinator({
    scopeKey: () => "s",
    readState: () => row({ planContextDigest: null }),
    businessDate: () => BUSINESS_DATE,
    refresh: async () => { if (fail) throw new Error("boom"); }
  });
  await assert.rejects(() => failing.tick());
  fail = false;
  assert.equal((await failing.tick()).ran, true, "the coordinator must recover after a failed run");
});

test("协调器：不需要刷新的 scope 不调用刷新，也不写任何东西", async () => {
  let calls = 0;
  const coordinator = new TrainingPlanCoordinator({
    scopeKey: () => "s",
    readState: () => null,
    businessDate: () => BUSINESS_DATE,
    refresh: async () => { calls += 1; }
  });
  const result = await coordinator.tick();
  assert.deepEqual(result, { ran: false, reason: "not_migrated" });
  assert.equal(calls, 0);
});
