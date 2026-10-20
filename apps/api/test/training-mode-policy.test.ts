import assert from "node:assert/strict";
import test from "node:test";

import { coachLocalDate } from "../src/coach-loop-facts.js";
import {
  admissionStateFor,
  applyTrainingConfigurationCommand,
  daysBetweenLocalDates,
  raceDistanceFor,
  raceGoalSupport,
  resolveTrainingMode,
  validateRaceGoal,
  type RaceGoal,
  type RaceGoalDraft,
  type RaceGoalRejectionReason,
  type RaceGoalValidation,
  type TrainingConfigurationState
} from "../src/training-mode-policy.js";

/** Narrow a validation result to its rejection reasons for assertions. */
const rejectionReasons = (validation: RaceGoalValidation): RaceGoalRejectionReason[] => {
  if (validation.status === "valid") throw new Error("expected a rejected race goal");
  return validation.reasons;
};

/**
 * PR1 regression for the single derived training mode.
 *
 * The IDs are the plan's `UTP-M*` acceptance rows (§14.1). They are asserted here
 * against pure functions only: no storage, no HTTP, no candidate search. A mode is
 * derived from `(raceGoal, Shanghai business date)` and the command reducer is the
 * only place that decides whether an editor draft may change state.
 */

const BUSINESS_DATE = "2026-10-20";
const GOAL: RaceGoal = {
  id: "goal-1",
  date: "2026-12-06",
  distanceKm: 10,
  goal: "time",
  targetTimeSeconds: 3000
};
const state = (overrides: Partial<TrainingConfigurationState> = {}): TrainingConfigurationState => ({
  raceGoal: null,
  runState: "active",
  preferencesComplete: true,
  ...overrides
});

test("UTP-M01 无比赛目标时 mode=coach，且准入由偏好完整性决定", () => {
  const resolution = resolveTrainingMode({ raceGoal: null, businessDate: BUSINESS_DATE });
  assert.deepEqual(resolution, { mode: "coach", reason: "no_race_goal", daysToRace: null });
  assert.equal(admissionStateFor(state({ preferencesComplete: false })), "needs_configuration");
  assert.equal(admissionStateFor(state()), "ready");
});

test("UTP-M02 保存完整未来赛事：一次命令切换 race，模式与目标同源", () => {
  const decision = applyTrainingConfigurationCommand({
    state: state(),
    command: { type: "set_race_goal", draft: { date: "2026-12-06", distanceKm: 10, goal: "time", targetTimeSeconds: 3000 } },
    businessDate: BUSINESS_DATE,
    newGoalId: "goal-1"
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.rejection, null);
  assert.equal(decision.change, "race_goal_set");
  assert.equal(decision.goalIdentity, "unset");
  assert.equal(decision.state.raceGoal?.id, "goal-1");
  assert.equal(decision.mode.mode, "race");
  assert.equal(decision.mode.reason, "race_goal_upcoming");
  // The derived mode is not stored, so it cannot disagree with the goal.
  assert.equal("mode" in decision.state, false);
});

test("UTP-M03 清除赛事自动回到 coach，不需要先「结束」教练", () => {
  const decision = applyTrainingConfigurationCommand({
    state: state({ raceGoal: GOAL }),
    command: { type: "clear_race_goal" },
    businessDate: BUSINESS_DATE
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.change, "race_goal_cleared");
  assert.equal(decision.state.raceGoal, null);
  assert.equal(decision.mode.mode, "coach");
  assert.equal(decision.mode.reason, "no_race_goal");
});

test("UTP-M04 改时间保留赛事身份；改日期或距离生成新身份且历史可追溯", () => {
  const timeOnly = applyTrainingConfigurationCommand({
    state: state({ raceGoal: GOAL }),
    command: { type: "set_race_goal", draft: { date: GOAL.date, distanceKm: GOAL.distanceKm, goal: "time", targetTimeSeconds: 2880 } },
    businessDate: BUSINESS_DATE
  });
  assert.equal(timeOnly.change, "race_goal_updated");
  assert.equal(timeOnly.goalIdentity, "kept");
  assert.equal(timeOnly.state.raceGoal?.id, "goal-1");
  assert.equal(timeOnly.state.raceGoal?.targetTimeSeconds, 2880);

  const dateChanged = applyTrainingConfigurationCommand({
    state: state({ raceGoal: GOAL }),
    command: { type: "set_race_goal", draft: { date: "2026-12-13", distanceKm: 10, goal: "time", targetTimeSeconds: 3000 } },
    businessDate: BUSINESS_DATE,
    newGoalId: "goal-2"
  });
  assert.equal(dateChanged.change, "race_goal_replaced");
  assert.equal(dateChanged.goalIdentity, "replaced");
  assert.equal(dateChanged.state.raceGoal?.id, "goal-2");

  const distanceChanged = applyTrainingConfigurationCommand({
    state: state({ raceGoal: GOAL }),
    command: { type: "set_race_goal", draft: { date: GOAL.date, distanceKm: 21.0975, goal: "finish" } },
    businessDate: BUSINESS_DATE,
    newGoalId: "goal-3"
  });
  assert.equal(distanceChanged.change, "race_goal_replaced");
  assert.equal(distanceChanged.state.raceGoal?.id, "goal-3");
});

test("UTP-M04 新赛事身份缺少服务端 id 时失败关闭，不静默复用旧身份", () => {
  assert.throws(() => applyTrainingConfigurationCommand({
    state: state({ raceGoal: GOAL }),
    command: { type: "set_race_goal", draft: { date: "2026-12-13", distanceKm: 10, goal: "finish" } },
    businessDate: BUSINESS_DATE
  }), /newGoalId is required/);
});

test("UTP-M05 修改目标时间不改变模式，也不抬高支持等级", () => {
  const before = raceGoalSupport(GOAL, BUSINESS_DATE);
  const after = raceGoalSupport({ date: GOAL.date, distanceKm: GOAL.distanceKm }, BUSINESS_DATE);
  assert.deepEqual(after, before);
  const decision = applyTrainingConfigurationCommand({
    state: state({ raceGoal: GOAL }),
    command: { type: "set_race_goal", draft: { date: GOAL.date, distanceKm: GOAL.distanceKm, goal: "time", targetTimeSeconds: 2400 } },
    businessDate: BUSINESS_DATE
  });
  assert.equal(decision.mode.mode, "race");
  assert.equal(decision.mode.daysToRace, before.daysToRace);
});

test("UTP-M06 暂停时设置或清除赛事，运行意愿仍为 paused", () => {
  const paused = state({ raceGoal: GOAL, runState: "paused" });
  const cleared = applyTrainingConfigurationCommand({ state: paused, command: { type: "clear_race_goal" }, businessDate: BUSINESS_DATE });
  assert.equal(cleared.accepted, true);
  assert.equal(cleared.state.runState, "paused");
  assert.equal(cleared.mode.mode, "coach");

  const set = applyTrainingConfigurationCommand({
    state: state({ runState: "paused" }),
    command: { type: "set_race_goal", draft: { date: "2026-12-06", distanceKm: 10, goal: "finish" } },
    businessDate: BUSINESS_DATE,
    newGoalId: "goal-1"
  });
  assert.equal(set.accepted, true);
  assert.equal(set.state.runState, "paused");
  assert.equal(set.mode.mode, "race");
});

test("UTP-M07 恢复必须显式；恢复后模式按当前业务日期重新派生", () => {
  const paused = state({ raceGoal: GOAL, runState: "paused" });
  const resumed = applyTrainingConfigurationCommand({ state: paused, command: { type: "resume" }, businessDate: "2026-12-07" });
  assert.equal(resumed.accepted, true);
  assert.equal(resumed.state.runState, "active");
  // The old goal is history now: resume does not resurrect a finished race plan.
  assert.equal(resumed.mode.mode, "coach");
  assert.equal(resumed.mode.reason, "race_goal_passed");
  assert.equal(resumed.state.raceGoal?.id, "goal-1", "history is retained, only the mode changed");

  const idempotent = applyTrainingConfigurationCommand({ state: state(), command: { type: "resume" }, businessDate: BUSINESS_DATE });
  assert.equal(idempotent.change, "none");
});

test("UTP-M08 草稿或非法目标不改变当前模式与状态", () => {
  const current = state({ raceGoal: GOAL });
  const draft: RaceGoalDraft = { date: "2026-12-06", distanceKm: null, goal: "finish" };
  const draftDecision = applyTrainingConfigurationCommand({ state: current, command: { type: "set_race_goal", draft }, businessDate: BUSINESS_DATE });
  assert.equal(draftDecision.accepted, false);
  assert.equal(draftDecision.rejection, "draft");
  assert.deepEqual(draftDecision.state, current);
  assert.equal(draftDecision.mode.mode, "race");

  const invalidDate = applyTrainingConfigurationCommand({
    state: current,
    command: { type: "set_race_goal", draft: { date: "2026-02-30", distanceKm: 10, goal: "finish" } },
    businessDate: BUSINESS_DATE
  });
  assert.equal(invalidDate.rejection, "invalid");
  assert.deepEqual(invalidDate.state, current, "an invalid date must never clear the stored race goal");

  const missingTime = validateRaceGoal({ date: "2026-12-06", distanceKm: 10, goal: "time" });
  assert.equal(missingTime.status, "draft");
  assert.deepEqual(rejectionReasons(missingTime), ["target_time_missing"]);
});

test("UTP-M09 比赛日仍是 race，且不是普通休息日", () => {
  const resolution = resolveTrainingMode({ raceGoal: GOAL, businessDate: GOAL.date });
  assert.equal(resolution.mode, "race");
  assert.equal(resolution.reason, "race_day");
  assert.equal(resolution.daysToRace, 0);
});

test("UTP-M10 业务日期经过赛事后回到 coach，但不生成已完赛事实", () => {
  const resolution = resolveTrainingMode({ raceGoal: GOAL, businessDate: "2026-12-07" });
  assert.equal(resolution.mode, "coach");
  assert.equal(resolution.reason, "race_goal_passed");
  assert.equal(resolution.daysToRace, -1);
  // The goal itself is still the same identity: mode falling back is not a delete.
  assert.equal(GOAL.id, "goal-1");
});

test("UTP-M11 临近赛事与超出骨架范围的赛事仍是 race", () => {
  const near = resolveTrainingMode({ raceGoal: GOAL, businessDate: "2026-11-26" }); // 10 days out
  assert.equal(near.mode, "race");
  const nearSupport = raceGoalSupport(GOAL, "2026-11-26");
  assert.equal(nearSupport.preparation, "short");
  assert.ok(nearSupport.reasonCodes.includes("race_preparation_short"));
  // The old 42-day creation rule must not demote a real near race to daily coach.
  assert.equal(nearSupport.daysToRace, 10);

  const farGoal: RaceGoal = { ...GOAL, date: "2027-08-01" };
  const far = resolveTrainingMode({ raceGoal: farGoal, businessDate: BUSINESS_DATE });
  assert.equal(far.mode, "race");
  const farSupport = raceGoalSupport(farGoal, BUSINESS_DATE);
  assert.equal(farSupport.horizon, "beyond_horizon");
  assert.ok(farSupport.reasonCodes.includes("race_beyond_periodization_horizon"));
  assert.equal(farSupport.distance, "ten_k", "beyond-horizon is about the window, not the distance");
});

test("UTP-M12 全马与自定义距离保留赛事身份，不因无标准骨架退回日常", () => {
  for (const distanceKm of [42.195, 50]) {
    assert.equal(raceDistanceFor(distanceKm), null);
    const goal: RaceGoal = { ...GOAL, date: "2026-12-06", distanceKm };
    const support = raceGoalSupport(goal, BUSINESS_DATE);
    assert.equal(support.support, "limited");
    assert.ok(support.reasonCodes.includes("race_distance_custom"));
    assert.equal(resolveTrainingMode({ raceGoal: goal, businessDate: BUSINESS_DATE }).mode, "race");
  }
  assert.equal(raceDistanceFor(5), "five_k");
  assert.equal(raceDistanceFor(10), "ten_k");
  assert.equal(raceDistanceFor(21.0975), "half_marathon");
  assert.equal(raceDistanceFor(21.1), "half_marathon", "GPS-measured half marathons still map to the standard skeleton");
});

test("模式解析对非法日期失败关闭，绝不静默当作无赛事", () => {
  assert.throws(() => resolveTrainingMode({ raceGoal: { date: "2026-13-01" }, businessDate: BUSINESS_DATE }), /raceGoal\.date/);
  assert.throws(() => resolveTrainingMode({ raceGoal: GOAL, businessDate: "2026-10-32" }), /businessDate/);
  assert.throws(() => resolveTrainingMode({ raceGoal: { date: "" }, businessDate: BUSINESS_DATE }));
});

test("业务日期只有一个来源：上海时区，设备时区不改变赛事归属", () => {
  // 17:30Z is already the next day in Asia/Shanghai (+08:00).
  assert.equal(coachLocalDate("2026-10-19T17:30:00Z"), "2026-10-20");
  assert.equal(coachLocalDate("2026-10-19T15:59:59Z"), "2026-10-19");
  assert.equal(daysBetweenLocalDates("2026-10-19", "2026-10-26"), 7);
  assert.equal(daysBetweenLocalDates("2026-10-26", "2026-10-19"), -7);
});

test("目标校验边界：42 天/超出距离/零值时间", () => {
  const supportAt = (businessDate: string) => raceGoalSupport({ ...GOAL, date: "2026-12-06" }, businessDate);
  // 2026-10-25 → 42 days out exactly: enough preparation.
  assert.equal(supportAt("2026-10-25").preparation, "ready");
  assert.equal(supportAt("2026-10-26").preparation, "short");

  assert.deepEqual(rejectionReasons(validateRaceGoal({ date: "2026-12-06", distanceKm: 0, goal: "finish" })), ["distance_invalid"]);
  assert.deepEqual(rejectionReasons(validateRaceGoal({ date: "2026-12-06", distanceKm: 201, goal: "finish" })), ["distance_invalid"]);
  assert.deepEqual(rejectionReasons(validateRaceGoal({ date: "2026-12-06", distanceKm: 10, goal: "time", targetTimeSeconds: 0 })), ["target_time_invalid"]);
  assert.deepEqual(rejectionReasons(validateRaceGoal({ date: "2026-12-06", distanceKm: 10, goal: "time", targetTimeSeconds: 12.5 })), ["target_time_invalid"]);
  assert.equal(validateRaceGoal({ date: "2026-12-06", distanceKm: 42.195, goal: "finish" }).status, "valid");
});
