import { runCoachSessionTargets } from "./run-coach-policy.js";
import type { MobileGoalsResponse, MobilePlanAudit, MobilePlannedDay, MobileTodayResponse } from "@rai/api-contracts";

import { plannedDayNumbers, type CoachZonePrescription } from "./mobile-coach.js";
import { currentPeriodizationWeek, periodizationWeekStart, type PeriodizationWeek } from "./plan-periodization.js";
import { applyRacePlanPolicy, validateWeeklyPlan, weeklyPlanVolumeCeiling } from "./weekly-plan-validate.js";
import { preRaceActivationFor } from "./pre-race-activation.js";
import { buildCompleteCoachWeekPlan, enforceAutomaticSessionDose, fitCompleteSessionsToBudget } from "./coach-complete-plan.js";
import { applyUnsupportedRacePlanPolicy } from "./race-plan-policy.js";

export const WEEKLY_PLAN_DAYS = 7;

export interface WeeklyPlanGenerationResult {
  days: MobilePlannedDay[];
  audit: MobilePlanAudit;
  warnings: string[];
  /** Counters useful for the API response and for after-the-fact review. */
  rejectedCount: number;
  clampedCount: number;
}

export function phaseForPlanDate(
  args: Pick<Parameters<typeof generateWeeklyPlan>[0], "today" | "goals" | "recentWeeklyKm">,
  localDate: string
): PeriodizationWeek | null {
  const skeleton = args.today.periodization;
  if (skeleton && skeleton.generatedFor === args.today.today.localDate &&
    skeleton.raceDate === args.goals.raceTarget?.date && skeleton.distance === args.goals.raceTarget?.distance) {
    return skeleton.weeks.find(week => week.weekStart === periodizationWeekStart(localDate)) ?? null;
  }
  // The bands are a fraction of what the athlete actually runs, so the fallback
  // must use observed volume. Feeding a configured number here is exactly what
  // made the generated plan and the today payload disagree about the same week.
  return currentPeriodizationWeek({ today: localDate, raceTarget: args.goals.raceTarget, recentWeeklyKm: args.recentWeeklyKm });
}

export function weeklyPlanDates(today: string, days: number = WEEKLY_PLAN_DAYS): string[] {
  const start = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return [];
  return Array.from({ length: days }, (_, index) => {
    const value = new Date(start);
    value.setUTCDate(value.getUTCDate() + index);
    return value.toISOString().slice(0, 10);
  });
}

export function shouldGenerateWeeklyPlan(today: string,
  goals: Pick<MobileGoalsResponse, "weekPlan" | "weekPlanReplanRequired" | "runCoach">): boolean {
  if (goals.runCoach || goals.weekPlanReplanRequired || new Date(`${today}T00:00:00Z`).getUTCDay() !== 1) return false;
  const dates = weeklyPlanDates(today);
  return dates.length > 0 && !goals.weekPlan.some(day => dates.includes(day.localDate));
}

const structureKey = (day: MobilePlannedDay): string => (day.structure ? JSON.stringify(day.structure) : "");

/** Historical prescriptions are retained in the revision journal, not accumulated forever in the editor. */
export function mergePlanWindow(previous: MobilePlannedDay[], next: MobilePlannedDay[], today: string): MobilePlannedDay[] {
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const start = monday.toISOString().slice(0, 10);
  const replacementDates = new Set(next.map(day => day.localDate));
  return [...previous.filter(day => day.localDate >= start && !replacementDates.has(day.localDate)), ...next]
    .sort((a, b) => a.localDate.localeCompare(b.localDate));
}

/**
 * Dates whose stored prescription a fresh plan would replace.
 *
 * Regeneration writes the whole week, so any structure or rationale already on
 * a day inside the new window is discarded. The goals editor only owns kind and
 * distance, which means nothing else in the app would notice — so the caller
 * reports it instead of losing a tuned session without a trace.
 */
export function overwrittenPlanDates(previous: MobilePlannedDay[], next: MobilePlannedDay[]): string[] {
  const replacements = new Map(next.map((day) => [day.localDate, day]));
  const overwritten: string[] = [];
  for (const day of previous) {
    const replacement = replacements.get(day.localDate);
    if (!replacement) continue;
    const carried = day.structure != null || (day.reason ?? "").length > 0;
    if (!carried) continue;
    const differs =
      day.kind !== replacement.kind ||
      structureKey(day) !== structureKey(replacement) ||
      (day.reason ?? "") !== (replacement.reason ?? "");
    if (differs) overwritten.push(day.localDate);
  }
  return overwritten.sort((left, right) => left.localeCompare(right));
}

/** One-line warning for {@link overwrittenPlanDates}; empty when nothing was lost. */
export function overwriteWarning(previous: MobilePlannedDay[], next: MobilePlannedDay[]): string | null {
  const dates = overwrittenPlanDates(previous, next);
  if (dates.length === 0) return null;
  const shown = dates.slice(0, 4).join("、");
  const suffix = dates.length > 4 ? " 等" : "";
  return `已覆盖 ${dates.length} 天既有课表（${shown}${suffix}）：原有分段与说明不再保留`;
}

/** Validation outcomes reported back to the caller (and audit), not just warnings. */
export interface WeeklyPlanConstraintCounters {
  rejectedCount: number;
  clampedCount: number;
}

/** Produces a deterministic coach plan, measured and constrained before review. */
export async function generateWeeklyPlan(args: {
  today: MobileTodayResponse;
  goals: Pick<
    MobileGoalsResponse,
    "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget"
  > & Partial<Pick<MobileGoalsResponse, "weekPlan" | "weekPlanReplanRequired" | "weekPlanPreservedDate" | "runCoach">>;
  /** Baseline of the weekly volume ceiling, km. Derived by `weeklyCapacity`, never stored. */
  weeklyVolumeBaselineKm: number;
  /** Observed mean of the last four complete weeks, km — what the phase bands scale. */
  recentWeeklyKm: number;
  prescription: CoachZonePrescription | null;
  previousWeekDistanceKm?: number | null;
  now?: Date;
  /**
   * Automatic generation defaults to the complete-dose policy. `false` keeps the
   * legacy validator-only path (used by offline/legacy comparisons); it is no
   * longer silently overridden to `true`.
   */
  automaticDosePolicy?: boolean;
  /**
   * Internal: allocation of complete doses happens inside the one constraint pass,
   * per natural week, instead of upstream over the whole rolling window (F02).
   * Only automatic generation sets it; every other caller keeps passing its own
   * proposed days.
   */
  allocateCompleteDoses?: boolean;
}): Promise<WeeklyPlanGenerationResult> {
  const generatedAt = (args.now ?? new Date()).toISOString();
  const allowedDates = weeklyPlanDates(args.today.today.localDate);
  const warnings: string[] = [];
  const automaticDosePolicy = args.automaticDosePolicy ?? true;
  const counters: WeeklyPlanConstraintCounters = { rejectedCount: 0, clampedCount: 0 };
  const finish = (proposed: MobilePlannedDay[]) => constrainUpcomingPlan(
    proposed, { ...args, automaticDosePolicy, allocateCompleteDoses: true }, warnings, counters);

  if (allowedDates.length === 0) {
    return {
      days: [],
      audit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt },
      warnings: ["今日日期无效，未生成课表"],
      rejectedCount: 0,
      clampedCount: 0
    };
  }

  return {
    days: finish([]),
    audit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt },
    warnings,
    rejectedCount: counters.rejectedCount,
    clampedCount: counters.clampedCount
  };
}

/** One natural week's share of the rolling window, with its obligations already deducted. */
interface NaturalWeekBudget {
  dates: string[];
  protectedToday: boolean;
  reservedKm: number;
  reservedQuality: number;
  weekStart: string;
  phase: PeriodizationWeek | null;
  retainedKm: number;
  retainedQuality: number;
  ceilingKm: number;
  remainingKm: number;
  qualityCap: number;
}

/** The rolling window split at the current week's Sunday; at most two segments. */
function splitNaturalWeeks(dates: string[], periodEnd: string): string[][] {
  return [dates.filter((date) => date <= periodEnd), dates.filter((date) => date > periodEnd)]
    .filter((segment) => segment.length > 0);
}

export function constrainUpcomingPlan(proposed: MobilePlannedDay[],
  args: Pick<Parameters<typeof generateWeeklyPlan>[0], "today" | "goals" | "prescription" | "previousWeekDistanceKm" | "weeklyVolumeBaselineKm" | "recentWeeklyKm" | "automaticDosePolicy" | "allocateCompleteDoses">,
  warnings: string[] = [],
  counters?: WeeklyPlanConstraintCounters): MobilePlannedDay[] {
  const allowedDates = weeklyPlanDates(args.today.today.localDate);
  const injuryFlagCodes = args.today.injuryFlags.map(flag => flag.code);
  const replacementDates = new Set(allowedDates);
  const segments = splitNaturalWeeks(allowedDates, args.today.week.periodEnd);

  /**
   * Per natural week: obligations first, then the week's own budget.
   *
   * A rolling seven-day window can straddle Sunday. Deducting this week's actual
   * volume, the reserved today session and the prescriptions retained outside the
   * window from *every* segment would let one segment's history consume the next
   * week's budget; spending a single whole-window allocation would leave the next
   * week's budget unspent. Both behaved as "all rest" once a complete dose no longer
   * fit the first segment (F02).
   */
  const budgets: NaturalWeekBudget[] = segments.map((dates, index) => {
    const protectedToday = index === 0 && (args.today.today.workoutCount > 0 || args.today.lock.present ||
      args.goals.weekPlanReplanRequired === true || args.goals.weekPlanPreservedDate === args.today.today.localDate);
    const reservedKm = protectedToday && args.today.today.workoutCount === 0 ? args.today.nextSession.distanceKm ?? 0 : 0;
    const reservedQuality = reservedKm > 0 && ["tempo", "interval", "race"].includes(args.today.nextSession.kind) ? 1 : 0;
    const phase = phaseForPlanDate(args, dates[0]!);
    const weekStart = periodizationWeekStart(dates[0]!);
    const retained = (args.goals.weekPlan ?? []).filter(day => day.localDate >= args.today.today.localDate &&
      periodizationWeekStart(day.localDate) === weekStart && !replacementDates.has(day.localDate));
    const retainedKm = retained.reduce((sum, day) => sum +
      (plannedDayNumbers(day.kind, day.structure, day.distanceKm, args.prescription).distanceKm ?? 0), 0);
    const retainedQuality = retained.filter(day => ["tempo", "interval", "race"].includes(day.kind)).length;
    const ceilingKm = Math.min(weeklyPlanVolumeCeiling(args.weeklyVolumeBaselineKm, index === 0 ? args.previousWeekDistanceKm : null),
      phase?.volumeBandKm.upper ?? Number.POSITIVE_INFINITY);
    const remainingKm = Math.max(0, ceilingKm - retainedKm - (index === 0 ? args.today.week.distanceKm + reservedKm : 0));
    const qualityCap = Math.max(0, Math.min(args.goals.qualitySessionCap, phase?.qualityDose ?? args.goals.qualitySessionCap) -
      retainedQuality - (index === 0 ? args.today.weekStructure.qualitySessionCount + reservedQuality : 0));
    return { dates, protectedToday, reservedKm, reservedQuality, weekStart, phase, retainedKm, retainedQuality, ceilingKm, remainingKm, qualityCap };
  });
  for (const budget of budgets) {
    if (budget.retainedKm > 0 || budget.retainedQuality > 0) {
      warnings.push(`${budget.weekStart} 自然周已为窗口外保留课表预留 ${budget.retainedKm.toFixed(1)} km、${budget.retainedQuality} 堂质量课。`);
    }
  }

  // One allocation per natural week, against that week's net budget. Every candidate
  // is a complete dose; nothing is sliced to fit, and a week with no feasible
  // complete dose says so instead of borrowing the next week's km.
  const allocated = args.allocateCompleteDoses === true
    ? budgets.flatMap((budget, index) => budget.remainingKm <= 0 ? [] : buildCompleteCoachWeekPlan({
        // Today's protected session (an actual run, a lock, or a preserved draft) is
        // not re-planned: it is already deducted from the budget, so allocating a
        // session for it would waste one complete dose that then gets filtered out.
        allowedDates: budget.protectedToday ? budget.dates.filter(date => date !== args.today.today.localDate) : budget.dates,
        prescription: args.prescription,
        weeklyDistanceKm: budget.remainingKm,
        qualitySessionCap: budget.qualityCap,
        easyDurationFloorFraction: args.goals.easyDurationFloorFraction,
        injuryFlagCodes,
        previousWeekDistanceKm: index === 0 ? args.previousWeekDistanceKm ?? null : null
      }))
    : proposed;

  const safe = applyUnsupportedRacePlanPolicy(
    applyRacePlanPolicy(allocated, args.goals.raceTarget, args.weeklyVolumeBaselineKm, args.prescription, warnings),
    args.goals.runCoach?.raceDate, args.goals.raceTarget != null, warnings);
  const complete = allowedDates.map(localDate => safe.find(day => day.localDate === localDate) ??
    { localDate, kind: "rest" as const, distanceKm: null, structure: null, reason: "未生成有效处方，保留休息。" });
  return budgets.flatMap((budget, index) => {
    const days = complete.filter(day => budget.dates.includes(day.localDate));
    if (!days.length) return [];
    const adjustable = days.filter(day => !(budget.protectedToday && day.localDate === args.today.today.localDate));
    if (budget.remainingKm <= 0) {
      warnings.push("自然周剩余预算已用完，未完成日期不再追加训练。");
      return adjustable.map(day => ({ ...day, kind: "rest" as const, distanceKm: null, structure: null, reason: "本自然周预算已用完。" }));
    }
    const validation = { allowedDates, prescription: args.prescription,
      weeklyDistanceKm: budget.remainingKm, volumeCeilingKm: budget.remainingKm, qualitySessionCap: budget.qualityCap,
      ...(budget.phase ? { longRunCapKm: budget.phase.longRunCapKm } : {}),
      easyDurationFloorFraction: args.goals.easyDurationFloorFraction, injuryFlagCodes };
    const candidates = args.automaticDosePolicy
      ? fitCompleteSessionsToBudget(adjustable, args.prescription, budget.remainingKm, warnings) : adjustable;
    const result = validateWeeklyPlan({ ...validation, raw: JSON.stringify({ days: candidates }) });
    if (counters) {
      counters.rejectedCount += result.rejected.length;
      counters.clampedCount += result.clamped.length;
    }
    warnings.push(...result.rejected, ...result.clamped.map(message => budget.phase ? `${budget.phase.note} 阶段上限 ${budget.ceilingKm.toFixed(1)} km：${message}` : message));
    if (args.automaticDosePolicy) {
      let current = result.days;
      // Dropping a short easy day can alter the final intensity mix. Repeat the
      // same validator, not a second set of floor/quality/ramp rules.
      for (let pass = 0; pass <= WEEKLY_PLAN_DAYS; pass++) {
        const completeAgain = fitCompleteSessionsToBudget(
          current.map(day => enforceAutomaticSessionDose(day, args.prescription, warnings)),
          args.prescription, budget.remainingKm, warnings);
        const checked = validateWeeklyPlan({ ...validation, raw: JSON.stringify({ days: completeAgain }) });
        if (counters) {
          counters.rejectedCount += checked.rejected.length;
          counters.clampedCount += checked.clamped.length;
        }
        warnings.push(...checked.rejected, ...checked.clamped);
        if (JSON.stringify(current) === JSON.stringify(checked.days)) return checked.days;
        current = checked.days;
      }
      warnings.push("完整课最终约束未稳定，保守返回休息。");
      return current.map(day => ({ ...day, kind: "rest" as const, structure: null, distanceKm: null,
        reason: "no_feasible_safe_plan：最终完整剂量校验未稳定。" }));
    }
    return result.days;
  }).map(day => runCoachSessionTargets(day, args.goals.runCoach, args.prescription))
    .map(day => args.automaticDosePolicy ? enforceAutomaticSessionDose(day, args.prescription, warnings) : day)
    // G01-B (signed 2026-10-20): a taper-forced rest day may become a short
    // activation session. This runs last, after the ordinary dose gate, because it
    // is an explicit policy exception — not a loosening of the 1800 s rule.
    .map(day => preRaceActivationFor(day, {
      raceTarget: args.goals.raceTarget,
      prescription: args.prescription,
      weeklyVolumeBaselineKm: args.weeklyVolumeBaselineKm
    }));
}
