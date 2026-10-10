import type { MobileGoalsResponse, MobileTodayResponse, UpdateMobileGoalsInput } from "@rai/api-contracts";
import type { CoachZonePrescription } from "./mobile-coach.js";
import { applyRacePlanPolicy, validateWeeklyPlan, weeklyPlanVolumeCeiling } from "./weekly-plan-validate.js";
import { phaseForPlanDate } from "./weekly-plan-service.js";

export class ManualPlanPolicyError extends Error { readonly code = "plan_policy_violation"; }

/** Public manual edits cannot retain or forge an automatic-generation guarantee. */
export function manualPlanWriteInput(input: UpdateMobileGoalsInput, changedAt: string): UpdateMobileGoalsInput {
  if (input.weekPlan === undefined) return input;
  if (!Number.isFinite(Date.parse(changedAt))) throw new ManualPlanPolicyError("人工课表的保存时刻无效。");
  return { ...input, weekPlanAudit: { generatedBy: "manual", model: null, promptVersion: null, generatedAt: changedAt } };
}

/** Validate before persistence; race-day safety policy may rewrite the pending days. */
export function validateManualPlan(args: {
  goals: MobileGoalsResponse;
  today: MobileTodayResponse;
  prescription: CoachZonePrescription | null;
  /** Baseline of the weekly volume ceiling, km. Derived by `weeklyCapacity`, never stored. */
  weeklyVolumeBaselineKm: number;
  /** Observed mean of the last four complete weeks, km — what the phase bands scale. */
  recentWeeklyKm: number;
  previousWeekDistanceKm: number;
  previous?: MobileGoalsResponse;
}): MobileGoalsResponse {
  const { goals, today, prescription, weeklyVolumeBaselineKm, recentWeeklyKm, previousWeekDistanceKm, previous } = args;
  const protectedToday = today.today.workoutCount > 0 || today.lock.present || goals.weekPlanPreservedDate === today.today.localDate;
  if (previous) {
    const frozen = (date: string) => date < today.today.localDate || (date === today.today.localDate && protectedToday);
    const oldDays = previous.weekPlan.filter(day => frozen(day.localDate));
    const newDays = goals.weekPlan.filter(day => frozen(day.localDate));
    if (JSON.stringify(oldDays) !== JSON.stringify(newDays)) throw new ManualPlanPolicyError("历史、已完成、已锁定或迁移保留日期不能通过周计划编辑改写。请保留原日期内容。");
  }
  const pending = goals.weekPlan.filter(day => day.localDate >= today.today.localDate && !(day.localDate === today.today.localDate && protectedToday));
  const weeks = new Map<string, typeof pending>();
  for (const day of pending) {
    const date = new Date(`${day.localDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const key = date.toISOString().slice(0, 10);
    weeks.set(key, [...(weeks.get(key) ?? []), day]);
  }
  const safeByDate = new Map<string, MobileGoalsResponse["weekPlan"][number]>();
  for (const [monday, days] of weeks) {
    const currentWeek = monday === today.week.periodStart;
    const reserved = currentWeek && protectedToday && today.today.workoutCount === 0 ? today.nextSession.distanceKm ?? 0 : 0;
    const phase = phaseForPlanDate({ today, goals, recentWeeklyKm }, days[0]!.localDate);
    const budget = Math.max(0, Math.min(weeklyPlanVolumeCeiling(weeklyVolumeBaselineKm, currentWeek ? previousWeekDistanceKm : null), phase?.volumeBandKm.upper ?? Number.POSITIVE_INFINITY) - (currentWeek ? today.week.distanceKm + reserved : 0));
    if (budget === 0 && days.some(day => day.kind !== "rest")) throw new ManualPlanPolicyError("本自然周跑量预算已用完，请减少未来安排或调整周目标。");
    const safeDays = applyRacePlanPolicy(days, goals.raceTarget, weeklyVolumeBaselineKm, prescription);
    const reservedQuality = reserved > 0 && ["tempo", "interval", "race"].includes(today.nextSession.kind) ? 1 : 0;
    const checked = validateWeeklyPlan({ raw: JSON.stringify({ days: safeDays }), allowedDates: safeDays.map(day => day.localDate), prescription, weeklyDistanceKm: budget,
      volumeCeilingKm: budget, ...(phase ? { longRunCapKm: phase.longRunCapKm } : {}),
      qualitySessionCap: Math.max(0, Math.min(goals.qualitySessionCap, phase?.qualityDose ?? goals.qualitySessionCap) - (currentWeek ? today.weekStructure.qualitySessionCount + reservedQuality : 0)), easyDurationFloorFraction: goals.easyDurationFloorFraction, injuryFlagCodes: today.injuryFlags.map(flag => flag.code) });
    if (checked.rejected.length || checked.clamped.length) {
      throw new ManualPlanPolicyError(`课表未保存：${[...checked.rejected, ...checked.clamped].join("；")}。请调整安排后重试，或预览重新生成的安全课表。`);
    }
    for (const day of safeDays) safeByDate.set(day.localDate, day);
  }
  return {
    ...goals,
    weekPlan: goals.weekPlan.map(day => safeByDate.get(day.localDate) ?? day)
  };
}
