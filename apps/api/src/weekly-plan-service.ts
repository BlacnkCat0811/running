import type { MobileGoalsResponse, MobilePlanAudit, MobilePlannedDay, MobileTodayResponse } from "@rai/api-contracts";

import type { CoachZonePrescription } from "./mobile-coach.js";
import { createPlanModelClient, llmConfigFromEnv, type PlanModelClient } from "./weekly-plan-llm.js";
import { buildWeeklyPlanPrompt, WEEKLY_PLAN_DAYS, WEEKLY_PLAN_PROMPT_VERSION } from "./weekly-plan-prompt.js";
import { buildFallbackWeekPlan, validateWeeklyPlan } from "./weekly-plan-validate.js";

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
          days: validated.days,
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
    days,
    audit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt },
    warnings,
    rejectedCount: 0,
    clampedCount: 0
  };
}
