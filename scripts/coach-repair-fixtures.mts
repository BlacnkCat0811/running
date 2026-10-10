import type { MobilePlannedDay, MobileTodayResponse } from "@rai/api-contracts";
import type { CoachZonePrescription } from "../apps/api/src/mobile-coach.js";
import { plannedDayNumbers } from "../apps/api/src/mobile-coach.js";
import { buildCompleteEasyStructure } from "../apps/api/src/coach-session-dose.js";
import { constrainUpcomingPlan } from "../apps/api/src/weekly-plan-service.js";
import { repairCoachPlan, type CoachPlanRepairResult, type CoachRepairCandidate, type CoachRepairDay } from "../apps/api/src/coach-plan-repair.js";
import { coachLocalDate, shiftCoachDate } from "../apps/api/src/coach-loop-facts.js";
import { periodizationWeekStart } from "../apps/api/src/plan-periodization.js";
import { digest } from "../apps/api/src/plan-digest.js";
import { coachReplayInput } from "./coach-replay-scenarios.mjs";

/** Frozen synthetic repair context; no DB, wall clock, scheduled task or publication. */
export interface FrozenRepairInput {
  asOf: string;
  previous: readonly CoachRepairDay[];
  candidates: Readonly<Record<string, readonly CoachRepairCandidate[]>>;
  affectedDates: readonly string[];
  protectedDates: readonly string[];
  requiredIntentDates: readonly string[];
  zones: CoachZonePrescription | null;
  weeklyKm: number;
  actualKm: number;
  injuryCodes: readonly string[];
}

export const syntheticRepairEasy = (localDate: string): CoachRepairDay => {
  const zones = coachReplayInput().zones;
  const structure = buildCompleteEasyStructure("easy", zones);
  return { day: { localDate, kind: "easy", ...plannedDayNumbers("easy", structure, null, zones), reason: "synthetic-original" },
    executable: true, authorizedDecisionRef: null };
};
export const syntheticRepairRest = (localDate: string): CoachRepairDay => ({
  day: { localDate, kind: "rest", distanceKm: null, structure: null, reason: "synthetic-rest" },
  executable: false, authorizedDecisionRef: null
});

export function runFrozenRepairInput(input: FrozenRepairInput): CoachPlanRepairResult {
  const todayDate = coachLocalDate(input.asOf);
  const weekStart = periodizationWeekStart(todayDate);
  const today = {
    today: { localDate: todayDate, workoutCount: 0 },
    week: { periodStart: weekStart, periodEnd: shiftCoachDate(weekStart, 6), distanceKm: input.actualKm },
    lock: { present: false }, weekStructure: { qualitySessionCount: 0 }, nextSession: { kind: "rest", distanceKm: null },
    injuryFlags: input.injuryCodes.map(code => ({ code }))
  } as unknown as MobileTodayResponse;
  const dates = [...new Set([...input.previous.map(row => row.day.localDate), ...Object.keys(input.candidates)])]
    .filter(date => date >= todayDate && date <= shiftCoachDate(todayDate, 6)).sort();
  if (!dates.length) return {
    version: "rai-coach-plan-repair-candidate-v1", policyStatus: "candidate", publishable: false,
    status: "no_change", storedDays: input.previous.map(row => row.day), effectiveDays: input.previous,
    cost: { changedDates: 0, movedSessions: 0, kindChanges: 0, workDoseRelativeDifference: 0, preferenceRank: 0 },
    changes: [], affectedDates: [], evaluatedCandidates: 0, reasons: []
  };
  const validate = (days: readonly MobilePlannedDay[]) => {
    const safe = constrainUpcomingPlan([...days], {
      today, prescription: input.zones, weeklyVolumeBaselineKm: input.weeklyKm, recentWeeklyKm: input.weeklyKm,
      previousWeekDistanceKm: input.weeklyKm, automaticDosePolicy: true,
      goals: { raceTarget: null, qualitySessionCap: 0, easyDurationFloorFraction: 0.7, weekPlan: [...days] }
    });
    return { feasible: true, effectiveDays: days.map(day => {
      const effective = safe.find(row => row.localDate === day.localDate) ?? day;
      return { day: effective, executable: effective.kind !== "rest" && effective.structure != null,
        authorizedDecisionRef: input.previous.find(row => row.day.localDate === day.localDate)?.authorizedDecisionRef ?? null };
    }), reasons: [] };
  };
  return repairCoachPlan({
    previous: input.previous, windowDates: dates, affectedDates: input.affectedDates,
    protectedDates: input.protectedDates, requiredIntentDates: input.requiredIntentDates,
    candidates: input.candidates, maximumEvaluations: 10_000, inputDigest: digest(input), reasonsByDate: {}, validate
  });
}
