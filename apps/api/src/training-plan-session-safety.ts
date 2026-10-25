import type { MobileGoalsResponse, MobileTodayResponse, TrainingPlanSessionImpact } from "@rai/api-contracts";
import type { CoachZonePrescription } from "./mobile-coach.js";
import { plannedDayNumbers } from "./mobile-coach.js";
import { validateWeeklyPlan, weeklyPlanVolumeCeiling } from "./weekly-plan-validate.js";
import { phaseForPlanDate } from "./weekly-plan-service.js";
import { periodizationWeekStart } from "./plan-periodization.js";
import { PlanOperationError } from "./plan-publication.js";
import { digest } from "./plan-digest.js";
import type { TrainingPlanSessionState } from "./training-plan-store.js";
import { legacyRaceTargetMirror } from "./training-plan-commands.js";

/** Reuse the existing natural-week, race, intensity and dose validator. Reject
 * adjustments instead of silently clamping the user's protected prescription. */
export function validateTrainingSessionSafety(state: TrainingPlanSessionState, impact: TrainingPlanSessionImpact, input: {
  goals: MobileGoalsResponse;
  today: MobileTodayResponse;
  prescription: CoachZonePrescription | null;
  weeklyVolumeBaselineKm: number;
  recentWeeklyKm: number;
  previousWeekDistanceKm: number | null;
}): void {
  const target = impact.after;
  if (target === null || target.lifecycle !== "pending") return;
  if (state.sourceStatus === "ended") throw new PlanOperationError("training_session_not_editable", "已结束的计划不能继续排课。", 409);
  const today = input.today.today.localDate;
  const week = periodizationWeekStart(target.prescription.localDate);
  const currentWeek = week === periodizationWeekStart(today);
  const raceTarget = legacyRaceTargetMirror(state) ?? null;
  const phase = phaseForPlanDate({ today: input.today, goals: { ...input.goals, raceTarget }, recentWeeklyKm: input.recentWeeklyKm }, target.prescription.localDate);
  const ceiling = Math.min(weeklyPlanVolumeCeiling(input.weeklyVolumeBaselineKm, currentWeek ? input.previousWeekDistanceKm : null),
    phase?.volumeBandKm.upper ?? Infinity);
  const candidates = state.sessions.filter(s => s.lifecycle === "pending" && s.supersededBySessionId === null &&
    s.prescription.localDate >= today && periodizationWeekStart(s.prescription.localDate) === week).map(s => s.prescription);
  const actualKm = currentWeek ? input.today.week.distanceKm : 0;
  const remainingKm = Math.max(0, ceiling - actualKm);
  const measuredKm = candidates.reduce((sum, day) => sum + (plannedDayNumbers(day.kind, day.structure, day.distanceKm, input.prescription).distanceKm ?? 0), 0);
  const qualityCap = Math.max(0, Math.min(input.goals.qualitySessionCap, phase?.qualityDose ?? input.goals.qualitySessionCap) -
    (currentWeek ? input.today.weekStructure.qualitySessionCount : 0));
  const result = validateWeeklyPlan({ raw: JSON.stringify({ days: candidates }), allowedDates: candidates.map(d => d.localDate),
    prescription: input.prescription, weeklyDistanceKm: remainingKm, volumeCeilingKm: remainingKm, qualitySessionCap: qualityCap,
    easyDurationFloorFraction: input.goals.easyDurationFloorFraction, injuryFlagCodes: input.today.injuryFlags.map(f => f.code),
    raceTarget, ...(phase ? { longRunCapKm: phase.longRunCapKm } : {}) });
  const validated = result.days.find(d => d.localDate === target.prescription.localDate);
  const samePrescription = validated && validated.kind === target.prescription.kind &&
    (target.prescription.structure === null || target.prescription.structure === undefined || digest(validated.structure) === digest(target.prescription.structure));
  if (measuredKm > remainingKm + 1e-8 || result.rejected.length || result.clamped.length || !samePrescription) {
    throw new PlanOperationError("training_session_safety_rejected", "课程未通过现有自然周预算、恢复、赛前或强度约束；请降低剂量或调整日期后重新预览。", 422);
  }
}
