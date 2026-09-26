import type { MobileGoalsResponse, MobilePlanAudit, MobilePlannedDay, MobileTodayResponse } from "@rai/api-contracts";

import type { CoachZonePrescription } from "./mobile-coach.js";
import { createPlanModelClient, llmConfigFromEnv, type PlanModelClient } from "./weekly-plan-llm.js";
import { buildWeeklyPlanPrompt, WEEKLY_PLAN_DAYS, WEEKLY_PLAN_PROMPT_VERSION } from "./weekly-plan-prompt.js";
import { applyRacePlanPolicy, buildFallbackWeekPlan, validateWeeklyPlan, weeklyPlanVolumeCeiling } from "./weekly-plan-validate.js";

export interface WeeklyPlanGenerationResult {
  days: MobilePlannedDay[];
  audit: MobilePlanAudit;
  warnings: string[];
  /** Counters useful for the API response and for after-the-fact review. */
  rejectedCount: number;
  clampedCount: number;
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

/**
 * Produces the next week of training. Always returns a usable plan: if the model
 * is missing, unreachable, or its output cannot pass validation, the
 * deterministic fallback is used instead.
 */
export async function generateWeeklyPlan(args: {
  today: MobileTodayResponse;
  goals: Pick<
    MobileGoalsResponse,
    "weeklyDistanceKm" | "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget"
  >;
  prescription: CoachZonePrescription | null;
  client?: PlanModelClient | null;
  previousWeekDistanceKm?: number | null;
  now?: Date;
}): Promise<WeeklyPlanGenerationResult> {
  const generatedAt = (args.now ?? new Date()).toISOString();
  const allowedDates = weeklyPlanDates(args.today.today.localDate);
  const warnings: string[] = [];
  const injuryFlagCodes = args.today.injuryFlags.map((flag) => flag.code);
  const finish = (proposed: MobilePlannedDay[]) => constrainUpcomingPlan(proposed, args, warnings);

  const client =
    args.client === undefined
      ? (() => {
          const config = llmConfigFromEnv();
          return config ? createPlanModelClient(config) : null;
        })()
      : args.client;

  if (allowedDates.length === 0) {
    return {
      days: [],
      audit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt },
      warnings: ["今日日期无效，未生成课表"],
      rejectedCount: 0,
      clampedCount: 0
    };
  }

  if (client) {
    const prompt = buildWeeklyPlanPrompt({
      today: args.today,
      goals: args.goals,
      prescription: args.prescription,
      allowedDates
    });
    try {
      const raw = await client.complete(prompt);
      const validated = validateWeeklyPlan({
        raw,
        raceTarget: args.goals.raceTarget,
        allowedDates,
        prescription: args.prescription,
        weeklyDistanceKm: args.goals.weeklyDistanceKm,
        qualitySessionCap: args.goals.qualitySessionCap,
        easyDurationFloorFraction: args.goals.easyDurationFloorFraction,
        injuryFlagCodes,
        previousWeekDistanceKm: args.previousWeekDistanceKm ?? null
      });
      if (validated.days.length > 0) {
        return {
          days: finish(validated.days),
          audit: {
            generatedBy: "llm",
            model: `${client.provider}:${client.model}`,
            promptVersion: WEEKLY_PLAN_PROMPT_VERSION,
            generatedAt
          },
          warnings: [...warnings, ...validated.rejected, ...validated.clamped],
          rejectedCount: validated.rejected.length,
          clampedCount: validated.clamped.length
        };
      }
      // The validator's reasons are the only description of what the model got
      // wrong. Dropping them left an operator with "校验失败" and no way to tell
      // a truncated JSON from a hallucinated date.
      const detail = validated.rejected.slice(0, 3).join("；");
      warnings.push(`模型输出未通过校验${detail ? `（${detail}）` : ""}，已回退到保守模板`);
    } catch (error) {
      warnings.push(`模型调用失败（${error instanceof Error ? error.message : "未知错误"}），已回退到保守模板`);
    }
  } else {
    warnings.push("未配置模型密钥（RAI_LLM_API_KEY），已使用保守模板");
  }

  const days = buildFallbackWeekPlan({
    easyDurationFloorFraction: args.goals.easyDurationFloorFraction,
    allowedDates,
    prescription: args.prescription,
    weeklyDistanceKm: args.goals.weeklyDistanceKm,
    qualitySessionCap: args.goals.qualitySessionCap,
    injuryFlagCodes,
    // The template is held to the same ramp ceiling as the model, so an
    // unusable model key cannot prescribe a week the runner has not earned.
    previousWeekDistanceKm: args.previousWeekDistanceKm ?? null
  });
  return {
    days: finish(applyRacePlanPolicy(days, args.goals.raceTarget, args.goals.weeklyDistanceKm, args.prescription, warnings)),
    audit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt },
    warnings,
    rejectedCount: 0,
    clampedCount: 0
  };
}

export function constrainUpcomingPlan(proposed: MobilePlannedDay[],
  args: Pick<Parameters<typeof generateWeeklyPlan>[0], "today" | "goals" | "prescription" | "previousWeekDistanceKm">,
  warnings: string[] = []): MobilePlannedDay[] {
  const allowedDates = weeklyPlanDates(args.today.today.localDate);
  const injuryFlagCodes = args.today.injuryFlags.map(flag => flag.code);

    const safe = applyRacePlanPolicy(proposed, args.goals.raceTarget, args.goals.weeklyDistanceKm, args.prescription, warnings);
    const complete = allowedDates.map(localDate => safe.find(day => day.localDate === localDate) ??
      { localDate, kind: "rest" as const, distanceKm: null, structure: null, reason: "未生成有效处方，保留休息。" });
    const groups = [complete.filter(day => day.localDate <= args.today.week.periodEnd), complete.filter(day => day.localDate > args.today.week.periodEnd)];
    return groups.flatMap((days, index) => {
      if (!days.length) return [];
      const protectedToday = index === 0 && (args.today.today.workoutCount > 0 || args.today.lock.present);
      const adjustable = days.filter(day => !(protectedToday && day.localDate === args.today.today.localDate));
      const reserved = protectedToday && args.today.today.workoutCount === 0 ? args.today.nextSession.distanceKm ?? 0 : 0;
      const remainingKm = Math.max(0, weeklyPlanVolumeCeiling(args.goals.weeklyDistanceKm, index === 0 ? args.previousWeekDistanceKm : null) - (index === 0 ? args.today.week.distanceKm + reserved : 0));
      if (remainingKm <= 0) {
        warnings.push("自然周剩余预算已用完，未完成日期不再追加训练。");
        return adjustable.map(day => ({ ...day, kind: "rest" as const, distanceKm: null, structure: null, reason: "本自然周预算已用完。" }));
      }
      const result = validateWeeklyPlan({ raw: JSON.stringify({ days: adjustable }), allowedDates, prescription: args.prescription,
        weeklyDistanceKm: remainingKm, qualitySessionCap: Math.max(0, args.goals.qualitySessionCap - (index === 0 ? args.today.weekStructure.qualitySessionCount : 0)),
        easyDurationFloorFraction: args.goals.easyDurationFloorFraction, injuryFlagCodes });
      warnings.push(...result.rejected, ...result.clamped);
      return result.days;
    });

}
