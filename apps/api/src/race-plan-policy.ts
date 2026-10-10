import type { CoachExecutionPolicyContext, MobilePlannedDay, MobileRaceTarget } from "@rai/api-contracts";
import { isValidLocalDate } from "./local-date.js";
import { PERIODIZATION_POLICY_VERSION, periodizationPhaseFor } from "./plan-periodization.js";
import { coachReason } from "./coach-loop-policy.js";

export const EXECUTION_PROTECTION_POLICY_VERSION = "rai-pre-race-execution-protection-v1";
export const PRE_RACE_EXECUTION_PROTECTION_DAYS = 14;
export const UNSUPPORTED_RACE_EXECUTION_PROTECTION_DAYS = 2;
export const UNSUPPORTED_RACE_PROTECTION_POLICY_VERSION = "rai-unsupported-race-execution-protection-v1";

/** Execution protection is NOT another periodization phase. */
export function raceExecutionProtection(date: string, raceDate: string | null | undefined): {
  daysToRace: number | null;
  preRace: boolean;
  raceDay: boolean;
  past: boolean;
} {
  const days = raceDate && isValidLocalDate(date) && isValidLocalDate(raceDate)
    ? Math.round((Date.parse(`${raceDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000) : null;
  return { daysToRace: days, preRace: days != null && days > 0 && days <= PRE_RACE_EXECUTION_PROTECTION_DAYS,
    raceDay: days === 0, past: days != null && days < 0 };
}

/** Preserve the pre-existing custom-distance compatibility rule, not a new phase. */
export function unsupportedRaceExecutionProtection(date: string, raceDate: string | null | undefined) {
  const protection = raceExecutionProtection(date, raceDate);
  return { ...protection, preRace: protection.daysToRace != null && protection.daysToRace > 0 &&
    protection.daysToRace <= UNSUPPORTED_RACE_EXECUTION_PROTECTION_DAYS };
}

export function applyUnsupportedRacePlanPolicy(
  days: MobilePlannedDay[], raceDate: string | null | undefined, hasSkeleton: boolean, warnings: string[] = []
): MobilePlannedDay[] {
  if (hasSkeleton || !raceDate) return days;
  return days.map(day => {
    const protection = unsupportedRaceExecutionProtection(day.localDate, raceDate);
    if (!protection.preRace || !["tempo", "interval", "long_run"].includes(day.kind)) return day;
    warnings.push(`${day.localDate} 无骨架赛事的两天兼容保护：不安排质量或长距离课。`);
    return { ...day, kind: "rest", distanceKm: null, structure: null,
      reason: "无骨架赛事临近，沿用两天兼容执行保护；不虚构专项阶段。" };
  });
}

/** Per-date semantic adapter; original dose ceilings remain idempotent. */
export function executionPolicyContext(input: {
  localDate: string;
  raceTarget: MobileRaceTarget | null;
  /** Unsupported distances may retain execution protection but have no phase. */
  raceDate?: string | null;
  weeklyDistanceKm: number;
}): CoachExecutionPolicyContext {
  const hasSkeleton = input.raceTarget !== null;
  const protection = hasSkeleton ? raceExecutionProtection(input.localDate, input.raceTarget?.date) :
    unsupportedRaceExecutionProtection(input.localDate, input.raceDate);
  const policyVersion = hasSkeleton ? EXECUTION_PROTECTION_POLICY_VERSION : UNSUPPORTED_RACE_PROTECTION_POLICY_VERSION;
  const code = protection.raceDay ? "race_day_no_extra_training" as const : "pre_race_execution_protection" as const;
  return {
    localDate: input.localDate,
    phase: input.raceTarget && isValidLocalDate(input.localDate) && isValidLocalDate(input.raceTarget.date)
      ? periodizationPhaseFor(input.localDate, input.raceTarget) : null,
    phasePolicyVersion: PERIODIZATION_POLICY_VERSION,
    protections: protection.preRace || protection.raceDay ? [{
      code, policyVersion, active: true,
      daysToRace: protection.daysToRace!, scope: "current_day",
      constraints: protection.raceDay ? [{ kind: "no_extra_training", value: null, unit: null }] :
        !hasSkeleton ? [{ kind: "no_quality_or_long_run", value: null, unit: null }] : [
        { kind: "replace_quality_with_easy", value: null, unit: null },
        { kind: "cap_distance", value: taperDayCeiling(input.weeklyDistanceKm), unit: "km" }
      ],
      reasons: [coachReason(code, policyVersion, [input.localDate],
        { daysToRace: protection.daysToRace!, distanceCeilingKm: protection.raceDay || !hasSkeleton ? null : taperDayCeiling(input.weeklyDistanceKm),
          supportedDistance: hasSkeleton })]
    }] : []
  };
}

/** @deprecated Legacy test/API adapter only; never use this to report a phase. */
export function racePlanPhase(date: string, target: MobileRaceTarget | null | undefined): "race_day" | "taper" | "past" | "build" {
  const protection = raceExecutionProtection(date, target?.date);
  return protection.past ? "past" : protection.raceDay ? "race_day" : protection.preRace ? "taper" : "build";
}

/** Same 30% taper reduction as today's coach, applied as an idempotent ceiling. */
export function taperDayCeiling(weeklyDistanceKm: number): number {
  return Math.max(1, Math.round(Math.min(10, weeklyDistanceKm / 7 * 0.7) * 10) / 10);
}
