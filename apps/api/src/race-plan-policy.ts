import type { MobileRaceTarget } from "@rai/api-contracts";
import { isValidLocalDate } from "./local-date.js";

/** Uses the existing coach's 14-day taper window, not a new readiness model. */
export function racePlanPhase(date: string, target: MobileRaceTarget | null | undefined): "race_day" | "taper" | "past" | "build" {
  if (!target || !isValidLocalDate(date) || !isValidLocalDate(target.date)) return "build";
  const days = Math.round((Date.parse(`${target.date}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return "past";
  if (days === 0) return "race_day";
  return days <= 14 ? "taper" : "build";
}

/** Same 30% taper reduction as today's coach, applied as an idempotent ceiling. */
export function taperDayCeiling(weeklyDistanceKm: number): number {
  return Math.max(1, Math.round(Math.min(10, weeklyDistanceKm / 7 * 0.7) * 10) / 10);
}
