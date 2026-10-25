import type { MobileRunCoachPlan } from "@rai/api-contracts";

import { PlanOperationError } from "./plan-publication.js";
import { runCoachWeekday } from "./run-coach-policy.js";
import type { TrainingPlanState } from "./training-plan-store.js";

/**
 * B03 / S01-04: consume the preferences the legacy migration already preserved.
 *
 * The migration keeps `mobile_goals.runCoach` as immutable *evidence* on the
 * unified state. Before this adapter, the unified generator explicitly cleared
 * that evidence (`runCoach: null`) and therefore generated for a default
 * seven-day week — the saved preference was retained but never consumed.
 *
 * This module is the single translation from stored evidence to the schedule the
 * generator is allowed to use. It is deliberately not an execution owner: no
 * `status` value here grants WorkoutKit permission, and `ended`/`paused` never
 * activates a programme.
 *
 * Fail-closed rules:
 * - a scope whose source is `run_coach` but whose stored programme is missing or
 *   structurally invalid is rejected; it is never silently replaced by a
 *   default seven-day preference;
 * - `ended` is terminal and cannot generate; `paused` is rejected by refresh
 *   before this adapter is even reached;
 * - a legacy scope that never had a run-coach programme returns no preference
 *   (`runningDays: null`), which means "no saved restriction", not "invent 7
 *   days of availability".
 */

export interface TrainingPlanGenerationPreferences {
  /** `null` means no saved availability preference; it is not a seven-day default. */
  runningDays: readonly number[] | null;
  longRunDays: readonly number[] | null;
  targetType: "pace" | "heart_rate";
  strengthTraining: boolean;
  /** Coach-loop settings carry per-weekday minutes; run-coach evidence has none. */
  availabilityMinutesByWeekday: Readonly<Record<string, number | null>>;
  source: "run_coach" | "none";
}

const ISO_DAYS = (values: unknown): values is number[] => Array.isArray(values) && values.length > 0 &&
  new Set(values).size === values.length && values.every(day => Number.isInteger(day) && day >= 1 && day <= 7);

const incomplete = (message: string): never => {
  throw new PlanOperationError("training_preferences_incomplete", message, 409);
};

/** Validate and translate the retained preference evidence; throws instead of guessing. */
export function trainingPlanGenerationPreferences(state: TrainingPlanState): TrainingPlanGenerationPreferences {
  const preferences = state.runCoach;
  if (preferences === null) {
    if (state.source === "run_coach" || state.source === "coach_loop") {
      return incomplete("训练偏好证据缺失；请重新确认可跑步日后再生成本周计划。");
    }
    return { runningDays: null, longRunDays: null, targetType: "pace", strengthTraining: false,
      availabilityMinutesByWeekday: {}, source: "none" };
  }
  const plan: MobileRunCoachPlan = preferences;
  const known = new Set(["id", "goal", "raceDate", "raceDistanceKm", "targetTimeSeconds", "runningDays", "longRunDays",
    "targetType", "strengthTraining", "durationWeeks", "startedOn", "status", "pausedOn", "endedOn", "adaptationKey", "adaptedAt"]);
  const unknown = Object.keys(plan).filter(key => !known.has(key));
  if (unknown.length > 0) {
    return incomplete(`训练偏好包含未知字段（${unknown.join("、")}）；请重新确认后再生成。`);
  }
  // `ended` is terminal. A paused legacy programme may be resumed through the
  // unified configuration command; then unified `runState` is the current
  // willingness and generation may consume the retained preferences again.
  if (plan.status === "ended" || plan.status === "paused" && state.runState !== "active") {
    return incomplete(`迁移的训练偏好状态为 ${plan.status}，不能生成新的训练计划；请显式确认偏好。`);
  }
  if (!state.preferencesComplete) {
    return incomplete("迁移的训练偏好尚未完整确认，不能默认按七天可跑生成。");
  }
  if (!ISO_DAYS(plan.runningDays) || plan.runningDays.length < 3) {
    return incomplete("迁移的可跑步日无效；请重新确认至少三个可跑步日。");
  }
  if (plan.longRunDays !== undefined && (!Array.isArray(plan.longRunDays) ||
      plan.longRunDays.some(day => !plan.runningDays.includes(day)))) {
    return incomplete("迁移的长距离日不在可跑步日内；请重新确认。");
  }
  if (plan.targetType !== "pace" && plan.targetType !== "heart_rate") {
    return incomplete("迁移的目标类型未知；请重新确认配速或心率目标。");
  }
  return {
    runningDays: [...plan.runningDays].sort((left, right) => left - right),
    longRunDays: [...(plan.longRunDays ?? [])].sort((left, right) => left - right),
    targetType: plan.targetType,
    strengthTraining: plan.strengthTraining,
    availabilityMinutesByWeekday: {},
    source: "run_coach"
  };
}

/** Positive proof that a weekday is permitted by a saved preference (tests/report use). */
export function trainingPlanWeekdayPermitted(preferences: TrainingPlanGenerationPreferences, localDate: string): boolean {
  return preferences.runningDays === null || preferences.runningDays.includes(runCoachWeekday(localDate));
}
