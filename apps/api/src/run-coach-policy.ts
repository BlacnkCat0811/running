import type { MobileRaceTarget, MobileRunCoachConfig, MobileRunCoachPlan, MobileSessionKind, MobileSessionStructure, MobileWorkoutStep } from "@rai/api-contracts";
import { sessionRanges, type CoachZonePrescription } from "./mobile-coach.js";
import { isValidLocalDate } from "./local-date.js";
import { currentPeriodizationWeek, periodizationPhaseFor, type PeriodizationPhase } from "./plan-periodization.js";

export class RunCoachInputError extends Error {}

export const runCoachWeekday = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
export const runCoachDaysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const runCoachShiftDate = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const runCoachEndDate = (plan: MobileRunCoachPlan): string => plan.raceDate ?? runCoachShiftDate(plan.startedOn, (plan.durationWeeks ?? 12) * 7 - 1);

export function validateRunCoachConfig(config: MobileRunCoachConfig, today: string, creating: boolean): void {
  const fail = (message: string): never => { throw new RunCoachInputError(message); };
  if (!["fitness", "finish", "time"].includes(config.goal)) fail("训练目标无效。");
  const days = (values: number[]) => Array.isArray(values) && values.length > 0 && values.every(day => Number.isInteger(day) && day >= 1 && day <= 7) && new Set(values).size === values.length;
  if (!days(config.runningDays) || config.runningDays.length < 3) fail("请选择至少三个可跑步日。");
  if (!days(config.longRunDays) || config.longRunDays.some(day => !config.runningDays.includes(day))) fail("长距离日必须是可跑步日。");
  if (!["pace", "heart_rate"].includes(config.targetType) || typeof config.strengthTraining !== "boolean") fail("训练偏好无效。");
  if (config.durationWeeks != null && (!Number.isInteger(config.durationWeeks) || config.durationWeeks < 6 || config.durationWeeks > 52)) fail("训练周期须为 6–52 周。");
  if (config.goal === "fitness") {
    if (config.raceDate !== null || config.raceDistanceKm !== null || config.targetTimeSeconds !== null) fail("改善体能计划不绑定比赛。");
    return;
  }
  if (typeof config.raceDate !== "string" || !isValidLocalDate(config.raceDate)) fail("请选择有效比赛日期。");
  const remaining = runCoachDaysBetween(today, config.raceDate!);
  if (remaining < (creating ? 42 : 0) || remaining > 364) fail("新比赛计划需要 6–52 周准备期。");
  if (!Number.isFinite(config.raceDistanceKm) || config.raceDistanceKm! < 1.6 || config.raceDistanceKm! > 1609.344) fail("比赛距离必须为 1.6–1609.344 km。");
  if (config.goal === "time") {
    const pace = config.targetTimeSeconds! / config.raceDistanceKm!;
    if (!Number.isFinite(config.targetTimeSeconds) || config.targetTimeSeconds! <= 0 || pace < 150 || pace > 900) fail("目标时间对应配速须为 2:30–15:00 /km。");
  } else if (config.targetTimeSeconds !== null) fail("完赛目标不设置目标时间。");
}

export function runCoachRaceTarget(plan: MobileRunCoachConfig): MobileRaceTarget | null {
  if (plan.goal === "fitness" || !plan.raceDate) return null;
  const distance = [5, 10, 21.0975].findIndex(km => Math.abs(km - (plan.raceDistanceKm ?? 0)) < 0.001);
  if (distance < 0) return null;
  return { date: plan.raceDate, distance: (["five_k", "ten_k", "half_marathon"] as const)[distance]!,
    targetPaceSecondsPerKm: plan.goal === "time" ? plan.targetTimeSeconds! / plan.raceDistanceKm! : null };
}

/**
 * Phase of the **natural week** `today` falls in, or `null` when the programme has no race
 * with a periodisation skeleton behind it.
 *
 * An adapter over the §20 skeleton, not a second implementation: `PHASE_BOUNDARIES` in
 * `plan-periodization.ts` is the single place a build length is written down, so the coach
 * page, the plan generator and the today page cannot disagree about the same week.
 *
 * It used to be its own algorithm — `floor(daysBetween(today, raceDate) / 7)` with a flat
 * `taper + 5` build window — with three measurable consequences (all pinned by
 * `test/run-coach-phase.test.ts`):
 *
 *   1. a function of the **day**, so one natural week could read `peak` on Monday and
 *      `taper` on Tuesday, moving the skeleton and the "第 N 周 · 强化期" label mid-week;
 *   2. a 5K plan earned five weeks of build and the half marathon four — backwards;
 *   3. no distance check, so a 42.195 km race was handed `"base"` despite having no
 *      skeleton, no volume band and no taper. `null` is that case's honest answer now, and
 *      the UI already has a word for it ("持续训练").
 *
 * Inside the skeleton's window the today page's own resolved row is the answer, so the two
 * surfaces read the same object. Outside it — a race already run, or one further out than
 * `PERIODIZATION_MAXIMUM_WEEKS` — the skeleton has no row to read while the phase is still
 * defined, so the same boundary table answers directly instead of a second window rule.
 *
 * `recentWeeklyKm` scales the volume band, which the phase does not read — the skeleton
 * computes both in one pass, so `0` is passed rather than threading a number that cannot
 * change the answer.
 */
export function runCoachPhase(today: string, plan: MobileRunCoachConfig): PeriodizationPhase | null {
  const raceTarget = runCoachRaceTarget(plan);
  if (raceTarget === null || !isValidLocalDate(today)) return null;
  return currentPeriodizationWeek({ today, raceTarget, recentWeeklyKm: 0 })?.phase
    ?? periodizationPhaseFor(today, raceTarget);
}

export const runCoachIsTraining = (plan: MobileRunCoachPlan, today: string): boolean =>
  plan.status === "active" && runCoachEndDate(plan) >= today;

export function normalizeRunCoachPlan(value: unknown): MobileRunCoachPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const plan = value as MobileRunCoachPlan;
  const nullableDate = (date: unknown) => date === null || (typeof date === "string" && isValidLocalDate(date));
  if (typeof plan.id !== "string" || !plan.id || typeof plan.startedOn !== "string" || !isValidLocalDate(plan.startedOn) ||
      !["active", "paused", "ended"].includes(plan.status) || !nullableDate(plan.pausedOn) || !nullableDate(plan.endedOn) ||
      (plan.adaptationKey !== null && typeof plan.adaptationKey !== "string") ||
      (plan.adaptedAt !== null && (typeof plan.adaptedAt !== "string" || !Number.isFinite(Date.parse(plan.adaptedAt))))) return null;
  try {
    validateRunCoachConfig(plan, plan.startedOn, true);
    return plan;
  } catch (error) {
    if (error instanceof RunCoachInputError) return null;
    throw error;
  }
}

/** Apply the programme's intensity preference after safety gates have sized the session. */
export function runCoachSessionTargets<T extends { kind: MobileSessionKind; structure?: MobileSessionStructure | null }>(
  day: T, plan: Pick<MobileRunCoachConfig, "targetType"> | null | undefined, prescription: CoachZonePrescription | null
): T {
  if (plan?.targetType !== "heart_rate" || !day.structure) return day;
  const ranges = sessionRanges(day.kind, prescription);
  const convert = (step: MobileWorkoutStep | null): MobileWorkoutStep | null => {
    if (!step) return null;
    const easy = step.purpose !== "work";
    const lower = easy ? prescription?.easyHrLower ?? null : ranges.heartRateBpmLower;
    const upper = easy ? prescription?.easyHrUpper ?? null : ranges.heartRateBpmUpper;
    return { ...step, alert: upper == null ? null : { kind: "heart_rate", lower, upper } };
  };
  return { ...day, structure: {
    warmup: convert(day.structure.warmup), cooldown: convert(day.structure.cooldown),
    blocks: day.structure.blocks.map(block => ({ ...block, steps: block.steps.map(step => convert(step)!) }))
  } };
}
