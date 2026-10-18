import { ISO_UTC_OFFSET } from "@rai/contracts";

import { periodizationWeekStart, type Periodization, type PeriodizationPhase } from "./plan-periodization.js";
import type { PlanHistoryRevision } from "./mobile-goals.js";

/**
 * Plan adherence and re-plan advice (docs/ALGORITHM.md §20).
 *
 * Read-time, like the periodisation it sits beside. The rules that matter here are
 * about **not** overstating what was observed:
 *
 * 1. A prescribed training day with no observations is `unknown`, never a missed session. Import lag and
 *    a phone left at home look identical from here, and only one of them is a fact
 *    about training.
 * 2. Obligations freeze per local day, with the first same-day prescription used
 *    when none existed at midnight. Later edits cannot rewrite elapsed days.
 * 3. Adherence never writes anything. It produces a *recommendation* to re-draft,
 *    and the existing preview/confirm flow is still the only way a plan changes.
 */

export const PLAN_ADHERENCE_POLICY_VERSION = "rai-plan-adherence-v3" as const;
export const REPLAN_POLICY_VERSION = "rai-replan-v2" as const;

/** Below this share of the planned volume a week reads as under-delivered. */
export const ADHERENCE_LOW_VOLUME_RATIO = 0.6;
/** Two consecutive under-delivered weeks are the trigger, not one. */
export const REPLAN_CONSECUTIVE_LOW_WEEKS = 2;
/** @deprecated Observation gaps are not confirmed failures and never trigger re-drafting. */
export const REPLAN_MISSED_QUALITY_SESSIONS = 2;

export interface AdherenceWeek {
  weekStart: string;
  phase: PeriodizationPhase | null;
  plannedDays: number;
  /** Non-rest prescription dates with at least one observed workout. */
  observedDays: number;
  unknownDays: number;
  plannedDistanceKm: number | null;
  /** Observed volume on non-rest prescription dates, not all runs that week. */
  observedDistanceKm: number;
  /** Whole-week progress; current-week status compares only obligations due so far. */
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
 * `mobile-goals`; each day's effective prescription defines its obligation.
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
    .filter((item) => Number.isFinite(Date.parse(item.changedAt)) &&
      Date.parse(item.changedAt) < Date.parse(`${shiftDate(input.today, 1)}T00:00:00${ISO_UTC_OFFSET}`))
    .sort((left, right) => Date.parse(right.changedAt) - Date.parse(left.changedAt) || right.revision - left.revision);

  const result: AdherenceWeek[] = [];
  const reasonCodes: string[] = [];
  if (revisions.length === 0) reasonCodes.push("no_plan_history");

  for (let index = 0; index < weeksToReport; index += 1) {
    const weekStart = shiftDate(currentWeekStart, -7 * index);
    const phase = input.periodization.weeks.find((week) => week.weekStart === weekStart)?.phase ?? null;
    const planned = Array.from({ length: 7 }, (_, offset) => {
      const localDate = shiftDate(weekStart, offset);
      const boundary = Date.parse(`${localDate}T00:00:00${ISO_UTC_OFFSET}`);
      if (localDate > input.today) return revisions[0]?.weekPlan.find(day => day.localDate === localDate);
      const atMidnight = revisions.find(item => Date.parse(item.changedAt) <= boundary);
      const existing = atMidnight?.weekPlan.find(day => day.localDate === localDate);
      if (existing) return existing;
      // Initial plans made on Monday or midweek still create real obligations.
      const end = Date.parse(`${shiftDate(localDate, 1)}T00:00:00${ISO_UTC_OFFSET}`);
      const firstSameDay = [...revisions].reverse().find(item => Date.parse(item.changedAt) > boundary &&
        Date.parse(item.changedAt) < end && item.weekPlan.some(day => day.localDate === localDate));
      return firstSameDay?.weekPlan.find(day => day.localDate === localDate);
    }).filter(day => day !== undefined);
    // The universe every field below is derived from: the days the plan actually asked for a
    // session. Rest days are not obligations.
    const prescribedDays = planned.filter(day => day.kind !== "rest");

    let plannedDistanceKm: number | null = null;
    let observedDistanceKm = 0;
    let observedDays = 0;
    let unknownDays = 0;
    let qualityPlanned = 0;
    let qualityObserved = 0;
    let dueDistanceKm = 0;

    for (let offset = 0; offset < 7; offset += 1) {
      const localDate = shiftDate(weekStart, offset);
      const plannedDay = planned.find((day) => day.localDate === localDate) ?? null;
      if (!plannedDay || plannedDay.kind === "rest") continue;
      const seen = localDate <= input.today ? observed.get(localDate) ?? null : null;
      if (plannedDay.distanceKm != null) {
        plannedDistanceKm = (plannedDistanceKm ?? 0) + plannedDay.distanceKm;
        if (localDate <= input.today) dueDistanceKm += plannedDay.distanceKm;
      }
      if (QUALITY_KINDS.has(plannedDay.kind)) qualityPlanned += 1;
      if (seen && seen.workoutCount > 0) {
        observedDays += 1;
        observedDistanceKm += seen.distanceKm;
        if (QUALITY_KINDS.has(plannedDay.kind)) qualityObserved += 1;
      } else if (localDate <= input.today) {
        unknownDays += 1;
      }
    }

    const volumeRatio =
      plannedDistanceKm !== null && plannedDistanceKm > 0
        ? round(observedDistanceKm / plannedDistanceKm, 3)
        : null;
    const status: AdherenceWeek["status"] =
      prescribedDays.length === 0
        ? "unknown"
        : observedDays === 0 && unknownDays > 0
          ? "unknown"
          : dueDistanceKm > 0 && observedDistanceKm / dueDistanceKm < ADHERENCE_LOW_VOLUME_RATIO
            ? "under"
            : volumeRatio !== null && volumeRatio >= 1 && shiftDate(weekStart, 6) <= input.today
              ? "met"
              : "on_track";

    result.push({
      weekStart,
      phase,
      // Prescribed days only, matching `unknownDays` / `qualityPlanned`. It used to be
      // `planned.length`, which counted rest days too: a week the plan answered with one run and
      // six explicit rest days reported `plannedDays: 7` while every other field in the same row
      // was derived from the single prescribed day. Nothing renders it today, which is exactly
      // why it would have survived until someone built "本周剩余 N 次" on top of it.
      plannedDays: prescribedDays.length,
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
  const completedWeeks = input.adherence.weeks.filter((week) => shiftDate(week.weekStart, 6) < input.adherence.generatedFor);

  let consecutiveLow = 0;
  for (const week of completedWeeks) {
    if (week.status === "under") {
      consecutiveLow += 1;
      if (consecutiveLow >= REPLAN_CONSECUTIVE_LOW_WEEKS) break;
    } else {
      break;
    }
  }
  if (consecutiveLow >= REPLAN_CONSECUTIVE_LOW_WEEKS) {
    reasons.push({
      code: "consecutive_low_volume_weeks",
      // The heuristic only reads *completed* weeks (`completedWeeks` above), so the
      // sentence must say so. It used to conclude "当前周量可能已经不现实" while the
      // current week may have been on track — the same card could show "按计划"
      // beside it and both numbers were right (TODAY_PLAN_CARDS_REVIEW C3/A3).
      detail: `连续 ${consecutiveLow} 周（已结束）完成量低于计划的 ${Math.round(ADHERENCE_LOW_VOLUME_RATIO * 100)}%，周量上限可能需要下调。`
    });
  }

  // `qualityObserved` retains its compatible "record on the date" meaning.
  // Absence is an evidence gap, not a missed prescription; O2's future
  // assessment must supply known_not_met before it can affect adaptation.

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
