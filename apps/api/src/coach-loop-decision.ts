import type { CoachLoopCandidate, CoachTrainingMode, CoachVolumeConstraint } from "@rai/api-contracts";
import { DATABASE_TIMEZONE } from "@rai/contracts";
import { buildCoachCapacityAnchor, coachCapacityEnvelope } from "./weekly-capacity.js";
import { COACH_POLICY_MANIFEST, coachReason } from "./coach-loop-policy.js";
import { assessSessionDose, buildCompleteEasyStructure } from "./coach-session-dose.js";
import { coachLocalDate, effectiveCoachReservations, shiftCoachDate, visibleCoachReservations, visibleCoachRuns,
  type CoachReservation, type CoachRunFact } from "./coach-loop-facts.js";
import { assessExtensionEligibility, MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS } from "./coach-extension-eligibility.js";
import { periodizationWeekStart } from "./plan-periodization.js";
import { executionPolicyContext } from "./race-plan-policy.js";
import { prescriptionDigest } from "./plan-digest.js";
import type { CoachZonePrescription } from "./mobile-coach.js";
import type { MobileRaceTarget } from "@rai/api-contracts";
import { runCoachSessionTargets } from "./run-coach-policy.js";
import { normalizeSessionStructure } from "./session-structure.js";

export interface CoachLoopDecisionInput {
  asOf: string;
  scope: { athleteId: string; datasetEpoch: string };
  mode: CoachTrainingMode;
  raceTarget: MobileRaceTarget | null;
  raceDate: string | null;
  lifecycleAllowsTraining: boolean;
  runningDay: boolean;
  requestedRest: boolean;
  facts: readonly CoachRunFact[];
  reservations: readonly CoachReservation[];
  historyCoverageFrom: string | null;
  anchorRevision: number;
  loadHistorySufficient: boolean;
  syncStatus: "ok" | "pending" | "failed" | "unknown";
  blockingFlagCodes: readonly string[];
  recoveryRestricted: boolean;
  zones: CoachZonePrescription | null;
  availableSeconds: number | null;
  suggestedWeeklyKm: number;
  legacyProtectionKm: number;
  absoluteProtectionKm: number;
  explicitPhaseHardCapKm: number | null;
  targetType?: "pace" | "heart_rate";
}

/**
 * Shared candidate decision for O0/O8 offline evaluation. In particular,
 * eligibility is not publication: no DB handle, operation id or device API.
 * Production continues using the legacy S ceiling until O0-G is approved.
 */
export function buildCoachLoopCandidate(input: CoachLoopDecisionInput): CoachLoopCandidate {
  const today = coachLocalDate(input.asOf);
  const weekStart = periodizationWeekStart(today);
  const weekEnd = shiftCoachDate(weekStart, 6);
  if (input.mode === "daily_adaptive" && (input.raceTarget || input.raceDate)) throw new Error("Daily mode cannot carry an active race");
  if (input.raceTarget && input.raceDate && input.raceTarget.date !== input.raceDate) throw new Error("Conflicting authoritative race dates");
  const runs = visibleCoachRuns(input.facts, input.asOf);
  const reservations = visibleCoachReservations(input.reservations, input.asOf);
  const effective = effectiveCoachReservations(reservations, runs);
  const anchor = buildCoachCapacityAnchor({ ...input, revision: input.anchorRevision });
  const envelope = coachCapacityEnvelope({ ...input, anchor });
  const structure = normalizeSessionStructure(runCoachSessionTargets({
    kind: "easy", structure: buildCompleteEasyStructure("easy", input.zones)
  }, { targetType: input.targetType ?? "pace" }, input.zones).structure)!;
  const dose = assessSessionDose({ kind: "easy", structure, zones: input.zones,
    availableSeconds: input.availableSeconds, allowColdStartEstimate: true });
  const cost = dose.distanceKm?.upper ?? 0;
  const inWeek = (date: string) => date >= weekStart && date <= weekEnd;
  const actualWeekKm = runs.filter(run => inWeek(coachLocalDate(run.startedAt))).reduce((sum, run) => sum + run.distanceKm, 0);
  const reservedBy = (allocation: CoachReservation["allocation"]) => effective.filter(slot => inWeek(slot.localDate) && slot.allocation === allocation)
    .reduce((sum, slot) => sum + slot.distanceKm, 0);
  const regularReservedKm = reservedBy("regular");
  const suggestedRemainingKm = Math.max(0, envelope.suggestedWeeklyKm - actualWeekKm - regularReservedKm);
  const needsExtension = cost > suggestedRemainingKm + 1e-9;
  const constraints: CoachVolumeConstraint[] = [];
  const addConstraint = (code: string, from: string, to: string, ceilingKm: number) => {
    const actualKm = runs.filter(run => coachLocalDate(run.startedAt) >= from && coachLocalDate(run.startedAt) <= to)
      .reduce((sum, run) => sum + run.distanceKm, 0);
    const reservedKm = effective.filter(slot => slot.localDate >= from && slot.localDate <= to)
      .reduce((sum, slot) => sum + slot.distanceKm, 0);
    constraints.push({ code, from, to, actualKm, reservedKm, candidateKm: cost, ceilingKm,
      remainingBeforeCandidateKm: ceilingKm - actualKm - reservedKm,
      passed: actualKm + reservedKm + cost <= ceilingKm + 1e-9 });
  };
  addConstraint("natural_week", weekStart, weekEnd, envelope.weeklyProtectionKm);
  // Candidate affects windows ending after today as well, including saved
  // reservations outside a seven-day editor window. No week-boundary reset.
  for (const days of [7, 14] as const) for (let offset = 0; offset < days; offset++) {
    const end = shiftCoachDate(today, offset);
    addConstraint(`rolling_${days}_days`, shiftCoachDate(end, -(days - 1)), end, days === 7 ? envelope.rolling7Km : envelope.rolling14Km);
  }
  const context = executionPolicyContext({ localDate: today, raceTarget: input.raceTarget,
    raceDate: input.raceDate, weeklyDistanceKm: envelope.suggestedWeeklyKm });
  const hasTodaySession = effective.some(slot => slot.localDate === today);
  const eligibility = assessExtensionEligibility({
    ...input, today, phase: context.phase, runs, reservations,
    alreadyHasTodaySession: hasTodaySession, historySufficient: envelope.evidenceSufficient,
    candidateKind: "easy", candidateStructure: structure, constraints
  });
  const reasons = needsExtension ? [...eligibility.reasons] : [];
  if (actualWeekKm >= envelope.suggestedWeeklyKm) reasons.unshift(coachReason("suggested_volume_met",
    COACH_POLICY_MANIFEST.budgetAllocationVersion, [today], { actualWeekKm, suggestedWeeklyKm: envelope.suggestedWeeklyKm }));
  let allocation: CoachLoopCandidate["allocation"] = needsExtension ? eligibility.status === "eligible" ? "extension" : "rest" : "regular";
  if (!input.lifecycleAllowsTraining || !input.runningDay || input.requestedRest || hasTodaySession ||
    runs.some(run => coachLocalDate(run.startedAt) === today) || input.recoveryRestricted ||
    context.protections.some(item => item.code === "race_day_no_extra_training") ||
    dose.status !== "feasible" || constraints.some(item => !item.passed)) allocation = "rest";
  // The candidate adapter has no dose-preserving pre-race regular planner;
  // do not pretend that an unprotected 30-min structure has passed it.
  if (context.protections.length || context.phase === "past" ||
    input.raceDate && input.raceDate < today) allocation = "rest";
  if (allocation === "rest" && !needsExtension) reasons.push(coachReason("regular_candidate_not_feasible",
    COACH_POLICY_MANIFEST.sessionDoseVersion, [today], { doseStatus: dose.status, hasTodaySession,
      lifecycleAllowsTraining: input.lifecycleAllowsTraining, runningDay: input.runningDay, requestedRest: input.requestedRest }));
  const candidateDigest = prescriptionDigest("easy", structure);
  return {
    localDate: today, kind: allocation === "rest" ? "rest" : "easy",
    structure: allocation === "rest" ? null : structure,
    prescriptionDigest: allocation === "rest" ? null : candidateDigest,
    dose, allocation, executable: false, reasons,
    volumePolicy: {
      schemaVersion: 1, asOf: input.asOf, weekStart, timezone: DATABASE_TIMEZONE, anchor,
      suggestedWeeklyKm: envelope.suggestedWeeklyKm, weeklyProtectionKm: envelope.weeklyProtectionKm,
      rollingLimits: [{ days: 7, ceilingKm: envelope.rolling7Km }, { days: 14, ceilingKm: envelope.rolling14Km }],
      actualWeekKm, regularReservedKm, extensionReservedKm: reservedBy("extension"), otherReservedKm: reservedBy("other"),
      suggestedRemainingKm, actualOverSuggestionKm: Math.max(0, actualWeekKm - envelope.suggestedWeeklyKm),
      constraints,
      extension: {
        status: needsExtension ? eligibility.status : "not_needed", assessedForDate: today,
        candidatePrescriptionDigest: candidateDigest, authorizedDecisionRef: null,
        approvedSessionsInRolling7Days: eligibility.approvedCount,
        maximumSessionsInRolling7Days: MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS, reasons: eligibility.reasons
      },
      policyManifest: { ...COACH_POLICY_MANIFEST }
    }
  };
}
