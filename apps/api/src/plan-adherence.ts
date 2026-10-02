import { ISO_UTC_OFFSET } from "@rai/contracts";

import { periodizationWeekStart, type Periodization, type PeriodizationPhase } from "./plan-periodization.js";
import type { PlanHistoryRevision } from "./mobile-goals.js";

/**
 * Plan adherence and re-plan advice (docs/ALGORITHM.md §20).
 *
 * Read-time, like the periodisation it sits beside. The rules that matter here are
 * about **not** overstating what was observed:
 *
 * 1. A day with no observations is `unknown`, never a missed session. Import lag and
 *    a phone left at home look identical from here, and only one of them is a fact
 *    about training.
 * 2. A week's obligations are read from the plan revision that was in force at that
 *    week's local midnight — editing today's plan must not rewrite last week's
 *    adherence.
 * 3. Adherence never writes anything. It produces a *recommendation* to re-draft,
 *    and the existing preview/confirm flow is still the only way a plan changes.
 */

export const PLAN_ADHERENCE_POLICY_VERSION = "rai-plan-adherence-v1" as const;
export const REPLAN_POLICY_VERSION = "rai-replan-v1" as const;

/** Below this share of the planned volume a week reads as under-delivered. */
export const ADHERENCE_LOW_VOLUME_RATIO = 0.6;
/** Two consecutive under-delivered weeks are the trigger, not one. */
export const REPLAN_CONSECUTIVE_LOW_WEEKS = 2;
/** A week with at least this many unobserved quality sessions is worth re-drafting. */
export const REPLAN_MISSED_QUALITY_SESSIONS = 2;

export interface AdherenceWeek {
  weekStart: string;
  phase: PeriodizationPhase | null;
  plannedDays: number;
  /** Days the plan asked for a session and the plan snapshot exists. */
  observedDays: number;
  unknownDays: number;
  plannedDistanceKm: number | null;
  observedDistanceKm: number;
  volumeRatio: number | null;
  qualityPlanned: number;
  qualityObserved: number;
  status: "unknown" | "on_track" | "under" | "met";
}

export interface PlanAdherence {
  policyVersion: typeof PLAN_ADHERENCE_POLICY_VERSION;
  generatedFor: string;
  weeks: AdherenceWeek[];
  current: AdherenceWeek | null;
  reasonCodes: string[];
}

export interface ReplanAdvice {
  policyVersion: typeof REPLAN_POLICY_VERSION;
  recommended: boolean;
  reasons: Array<{ code: string; detail: string }>;
}

export interface PlanDayObservation {
  localDate: string;
  distanceKm: number;
  workoutCount: number;
}

const QUALITY_KINDS = new Set(["tempo", "interval", "race"]);

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Builds weekly adherence for the last `weeks` weeks (most recent first).
 *
 * `history` is the plan revision journal, newest first, as stored by
 * `mobile-goals`; the revision in force at a week's local midnight is the one that
 * defines what that week asked for.
 */
export function buildPlanAdherence(input: {
  today: string;
  history: readonly PlanHistoryRevision[];
  actual: readonly PlanDayObservation[];
  periodization: Periodization;
  weeks?: number;
}): PlanAdherence {
  const weeksToReport = Math.max(1, Math.min(12, input.weeks ?? 4));
  const currentWeekStart = periodizationWeekStart(input.today);
  const observed = new Map(input.actual.map((day) => [day.localDate, day]));
  const revisions = [...input.history]
    .filter((item) => Number.isFinite(Date.parse(item.changedAt)))
    .sort((left, right) => Date.parse(right.changedAt) - Date.parse(left.changedAt) || right.revision - left.revision);

  const result: AdherenceWeek[] = [];
  const reasonCodes: string[] = [];
  if (revisions.length === 0) reasonCodes.push("no_plan_history");

  for (let index = 0; index < weeksToReport; index += 1) {
    const weekStart = shiftDate(currentWeekStart, -7 * index);
    const phase = input.periodization.weeks.find((week) => week.weekStart === weekStart)?.phase ?? null;
    // Freeze at local midnight: later edits must not rewrite what last week asked for.
    const boundary = Date.parse(`${weekStart}T00:00:00${ISO_UTC_OFFSET}`);
    const revision = revisions.find((item) => Date.parse(item.changedAt) < boundary);
    const planned = revision?.weekPlan.filter((day) => periodizationWeekStart(day.localDate) === weekStart) ?? [];

    let plannedDistanceKm: number | null = null;
    let observedDistanceKm = 0;
    let observedDays = 0;
    let unknownDays = 0;
    let qualityPlanned = 0;
    let qualityObserved = 0;

    for (let offset = 0; offset < 7; offset += 1) {
      const localDate = shiftDate(weekStart, offset);
      const plannedDay = planned.find((day) => day.localDate === localDate) ?? null;
      const seen = observed.get(localDate) ?? null;
      if (plannedDay?.distanceKm != null) {
        plannedDistanceKm = (plannedDistanceKm ?? 0) + plannedDay.distanceKm;
      }
      if (plannedDay && QUALITY_KINDS.has(plannedDay.kind)) qualityPlanned += 1;
      if (seen && seen.workoutCount > 0) {
        observedDays += 1;
        observedDistanceKm += seen.distanceKm;
        if (plannedDay && QUALITY_KINDS.has(plannedDay.kind)) qualityObserved += 1;
      } else if (plannedDay && localDate <= input.today) {
        unknownDays += 1;
      }
    }

    const volumeRatio =
      plannedDistanceKm !== null && plannedDistanceKm > 0
        ? round(observedDistanceKm / plannedDistanceKm, 3)
        : null;
    const status: AdherenceWeek["status"] =
      revision === undefined
        ? "unknown"
        : observedDays === 0 && unknownDays > 0
          ? "unknown"
          : volumeRatio !== null && volumeRatio < ADHERENCE_LOW_VOLUME_RATIO
            ? "under"
            : volumeRatio !== null && volumeRatio >= 1
              ? "met"
              : "on_track";

    result.push({
      weekStart,
      phase,
      plannedDays: planned.length,
      observedDays,
      unknownDays,
      plannedDistanceKm: plannedDistanceKm === null ? null : round(plannedDistanceKm, 1),
      observedDistanceKm: round(observedDistanceKm, 1),
      volumeRatio,
      qualityPlanned,
      qualityObserved,
      status
    });
  }

  return {
    policyVersion: PLAN_ADHERENCE_POLICY_VERSION,
    generatedFor: input.today,
    weeks: result,
    current: result[0] ?? null,
    reasonCodes
  };
}

/**
 * Whether the coach should offer to re-draft the week.
 *
 * Deliberately conservative: it recommends, it never re-plans. A runner coming back
 * from illness or a work trip would otherwise find their week silently rewritten by
 * a rule that cannot see either.
 */
export function replanAdvice(input: {
  adherence: PlanAdherence;
  periodization: Periodization;
}): ReplanAdvice {
  const reasons: Array<{ code: string; detail: string }> = [];
  const completedWeeks = input.adherence.weeks.filter((week) => week.status !== "unknown");

  let consecutiveLow = 0;
  for (const week of completedWeeks) {
    if (week.status === "under") {
      consecutiveLow += 1;
      if (consecutiveLow >= REPLAN_CONSECUTIVE_LOW_WEEKS) break;
    } else {
      consecutiveLow = 0;
    }
  }
  if (consecutiveLow >= REPLAN_CONSECUTIVE_LOW_WEEKS) {
    reasons.push({
      code: "consecutive_low_volume_weeks",
      detail: `连续 ${consecutiveLow} 周完成量低于计划的 ${Math.round(ADHERENCE_LOW_VOLUME_RATIO * 100)}%，当前周量可能已经不现实。`
    });
  }

  const missedQuality = completedWeeks
    .slice(0, 1)
    .reduce((sum, week) => sum + Math.max(0, week.qualityPlanned - week.qualityObserved), 0);
  if (missedQuality >= REPLAN_MISSED_QUALITY_SESSIONS) {
    reasons.push({
      code: "quality_sessions_unobserved",
      detail: `本周有 ${missedQuality} 次质量课没有观测到训练记录，可能需要重排而不是补课。`
    });
  }

  const current = input.adherence.current;
  const currentPhase = input.periodization.current;
  if (
    currentPhase &&
    current &&
    current.plannedDistanceKm !== null &&
    current.plannedDistanceKm > currentPhase.volumeBandKm.upper
  ) {
    reasons.push({
      code: "plan_above_phase_band",
      detail: `当前周计划 ${current.plannedDistanceKm.toFixed(1)} km 高于 ${currentPhase.phase} 期上限 ${currentPhase.volumeBandKm.upper.toFixed(1)} km。`
    });
  }

  return {
    policyVersion: REPLAN_POLICY_VERSION,
    recommended: reasons.length > 0,
    reasons
  };
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
