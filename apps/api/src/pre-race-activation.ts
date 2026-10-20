import type { MobilePlannedDay, MobileRaceTarget, MobileSessionStructure } from "@rai/api-contracts";

import { normalizeSessionStructure } from "./session-structure.js";
import { measureStructure, pacesFromZones, type CoachZonePrescription } from "./mobile-coach.js";
import { raceExecutionProtection, taperDayCeiling } from "./race-plan-policy.js";

/**
 * G01-B (approved 2026-10-20): pre-race activation sessions.
 *
 * The approved candidate is deliberately narrow and is NOT a new definition of "a
 * session":
 *
 * - only inside the 14-day execution-protection window;
 * - **the last 72 hours are rest** (daysToRace < 4 never gets an activation);
 * - at most one per day, only `easy`, 600–900 seconds total;
 * - the distance is bounded by the same `taperDayCeiling` as a full easy session,
 *   so this cannot raise the weekly taper load;
 * - the 1800 s minimum for a complete session is untouched: an activation is a
 *   separate signed class (`rai-pre-race-activation-v1`), and every day it replaces
 *   was already a forced rest by that rule.
 *
 * It runs AFTER `enforceAutomaticSessionDose` on purpose: it is an explicit policy
 * exception, not a bypass of the dose gate for ordinary sessions.
 */
export const PRE_RACE_ACTIVATION_POLICY_VERSION = "rai-pre-race-activation-v1";
export const PRE_RACE_ACTIVATION_MIN_SECONDS = 600;
export const PRE_RACE_ACTIVATION_MAX_SECONDS = 900;
/** Days 1–3 before the race are rest; activation is allowed from day 4. */
export const PRE_RACE_ACTIVATION_MIN_DAYS_TO_RACE = 4;
export const PRE_RACE_ACTIVATION_REASON_PREFIX = "pre_race_activation:";

export function preRaceActivationWindow(date: string, raceDate: string | null | undefined): boolean {
  const protection = raceExecutionProtection(date, raceDate);
  return protection.preRace && protection.daysToRace !== null &&
    protection.daysToRace >= PRE_RACE_ACTIVATION_MIN_DAYS_TO_RACE;
}

export function buildPreRaceActivationStructure(
  zones: CoachZonePrescription | null,
  totalSeconds: number
): MobileSessionStructure | null {
  const total = Math.round(totalSeconds);
  if (total < PRE_RACE_ACTIVATION_MIN_SECONDS || total > PRE_RACE_ACTIVATION_MAX_SECONDS) return null;
  const warmup = Math.floor(total * 0.25 / 10) * 10;
  const cooldown = warmup;
  const work = total - warmup - cooldown;
  if (warmup < 120 || work < 300) return null;
  const closedPace = zones?.easyPaceLower != null && zones.easyPaceUpper != null
    ? { kind: "pace" as const, lower: zones.easyPaceLower, upper: zones.easyPaceUpper } : null;
  return normalizeSessionStructure({
    warmup: { purpose: "warmup", goal: { type: "time", seconds: warmup }, alert: null },
    blocks: [{ iterations: 1, steps: [{
      purpose: "work", goal: { type: "time", seconds: work },
      alert: closedPace ? { ...closedPace, kind: "pace" } : null
    }] }],
    cooldown: { purpose: "cooldown", goal: { type: "time", seconds: cooldown }, alert: null }
  });
}

/**
 * Replace a taper-forced rest day with the short activation session — never a
 * different day, never a day the race policy did not already turn into rest.
 */
export function preRaceActivationFor(day: MobilePlannedDay, args: {
  raceTarget?: Pick<MobileRaceTarget, "date"> | null;
  prescription: CoachZonePrescription | null;
  weeklyVolumeBaselineKm: number;
}): MobilePlannedDay {
  if (day.kind !== "rest" || day.structure !== null) return day;
  if (!args.raceTarget?.date) return day;
  if (!preRaceActivationWindow(day.localDate, args.raceTarget.date)) return day;
  // Only a day the taper policy itself emptied is eligible: a normal rest day keeps
  // its reason (an activation is not a way to add training to an arbitrary rest day).
  if (!(day.reason ?? "").startsWith("赛前减量")) return day;
  const ceiling = taperDayCeiling(args.weeklyVolumeBaselineKm);
  // Warmup/cooldown/work all use the easy structure pace, so the slowest easy
  // seconds-per-km is the honest conversion for the daily ceiling.
  const easySecondsPerKm = pacesFromZones(args.prescription).easySecondsPerKm;
  if (!Number.isFinite(easySecondsPerKm) || easySecondsPerKm <= 0) return day;
  const secondsByCeiling = Math.floor(ceiling * easySecondsPerKm);
  const total = Math.min(PRE_RACE_ACTIVATION_MAX_SECONDS, secondsByCeiling);
  if (total < PRE_RACE_ACTIVATION_MIN_SECONDS) return day;
  const structure = buildPreRaceActivationStructure(args.prescription, total);
  if (structure === null) return day;
  const distanceKm = measureStructure(structure, "easy", pacesFromZones(args.prescription)).distanceKm;
  if (!Number.isFinite(distanceKm) || distanceKm > ceiling + 0.05) return day;
  return {
    ...day,
    kind: "easy",
    structure,
    distanceKm: Math.round(distanceKm * 10) / 10,
    reason: `${PRE_RACE_ACTIVATION_REASON_PREFIX}赛前 ${total} 秒激活；最后 72 小时仍只休息，不改变常规课 1800 秒下限。`
  };
}
