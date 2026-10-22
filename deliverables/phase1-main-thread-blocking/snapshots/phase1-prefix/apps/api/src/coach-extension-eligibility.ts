import type { CoachDecisionReason, CoachTrainingMode, CoachVolumeConstraint } from "@rai/api-contracts";
import { coachReason, EXTENSION_ELIGIBILITY_CANDIDATE_VERSION } from "./coach-loop-policy.js";
import { assessSessionDose } from "./coach-session-dose.js";
import { coachLocalDate, shiftCoachDate, runEvidenceRef, type CoachRunFact, type CoachReservation } from "./coach-loop-facts.js";
import type { CoachZonePrescription } from "./mobile-coach.js";
import type { MobileSessionStructure } from "@rai/api-contracts";
import { raceExecutionProtection } from "./race-plan-policy.js";
import type { PeriodizationPhase } from "./plan-periodization.js";

export const MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS = 2;
/** Versioned rule list; reuse the existing flags, not verdict.tone == green. */
export const EXTENSION_BLOCKING_FLAGS: ReadonlySet<string> = new Set([
  "volume_ramp", "week_jump", "ramp_rate", "load_ratio", "strain",
  "quality_cluster", "long_run_jump", "sleep_streak", "monotony"
]);

export function recentSingleRunExposure(runs: readonly CoachRunFact[], today: string): {
  spikes: Array<{ run: CoachRunFact; previousMaximumKm: number }>;
  missingReferenceIds: string[];
} {
  const spikes: Array<{ run: CoachRunFact; previousMaximumKm: number }> = [];
  const missingReferenceIds: string[] = [];
  for (const run of runs.filter(item => coachLocalDate(item.startedAt) >= shiftCoachDate(today, -6) &&
    coachLocalDate(item.startedAt) <= today)) {
    const earlier = runs.filter(item => Date.parse(item.startedAt) < Date.parse(run.startedAt) &&
      coachLocalDate(item.startedAt) >= shiftCoachDate(coachLocalDate(run.startedAt), -56));
    const maximum = Math.max(0, ...earlier.map(item => item.distanceKm));
    if (maximum <= 0) missingReferenceIds.push(run.id);
    else if (run.distanceKm > maximum * 1.2) spikes.push({ run, previousMaximumKm: maximum });
  }
  return { spikes, missingReferenceIds };
}

export function countApprovedExtensions(reservations: readonly CoachReservation[], runs: readonly CoachRunFact[], today: string): number {
  const ids = new Set(runs.map(run => run.id));
  return reservations.filter(reservation => reservation.allocation === "extension" &&
    reservation.localDate >= shiftCoachDate(today, -6) && reservation.localDate <= today &&
    (reservation.status === "pending" || reservation.status === "completed" || reservation.deviceScheduleUnresolved ||
      reservation.matchedWorkoutIds.some(id => ids.has(id)))).length;
}

/** Pure eligibility only. An eligible candidate still needs atomic publication. */
export function assessExtensionEligibility(input: {
  today: string;
  mode: CoachTrainingMode;
  phase: PeriodizationPhase | null;
  raceDate: string | null;
  lifecycleAllowsTraining: boolean;
  runningDay: boolean;
  requestedRest: boolean;
  alreadyHasTodaySession: boolean;
  runs: readonly CoachRunFact[];
  reservations: readonly CoachReservation[];
  historySufficient: boolean;
  syncStatus: "ok" | "pending" | "failed" | "unknown";
  blockingFlagCodes: readonly string[];
  recoveryRestricted: boolean;
  candidateKind: "easy" | "recovery";
  candidateStructure: MobileSessionStructure;
  zones: CoachZonePrescription | null;
  availableSeconds?: number | null;
  constraints: readonly CoachVolumeConstraint[];
}): { status: "eligible" | "blocked" | "insufficient_evidence"; approvedCount: number; reasons: CoachDecisionReason[] } {
  const reasons: CoachDecisionReason[] = [];
  const reason = (code: string, params: CoachDecisionReason["params"] = {}) => {
    reasons.push(coachReason(code, EXTENSION_ELIGIBILITY_CANDIDATE_VERSION, [input.today], params));
  };
  let insufficient = false;
  if (!input.lifecycleAllowsTraining || !input.runningDay || input.requestedRest) reason("training_not_permitted");
  if (input.alreadyHasTodaySession || input.runs.some(run => coachLocalDate(run.startedAt) === input.today)) reason("today_session_already_present");
  if (!input.historySufficient || input.syncStatus !== "ok") {
    insufficient = true;
    reason("extension_evidence_insufficient", { historySufficient: input.historySufficient, syncStatus: input.syncStatus });
  }
  const flags = input.blockingFlagCodes.filter(code => EXTENSION_BLOCKING_FLAGS.has(code));
  if (input.recoveryRestricted || flags.length) reason("recovery_restriction", { flagCodes: flags.join(","), recoveryRestricted: input.recoveryRestricted });
  const protection = raceExecutionProtection(input.today, input.raceDate);
  if (protection.preRace || protection.raceDay || protection.past || input.phase === "taper" || input.phase === "race_week" ||
    input.phase === "past" || input.mode === "race_preparation" && (input.phase === null || input.raceDate === null)) {
    reason("pre_race_extension_blocked", { phase: input.phase, daysToRace: protection.daysToRace });
  }
  const exposure = recentSingleRunExposure(input.runs, input.today);
  for (const spike of exposure.spikes) reasons.push(coachReason("recent_single_run_spike", EXTENSION_ELIGIBILITY_CANDIDATE_VERSION,
    [input.today], { actualKm: spike.run.distanceKm, previousMaximumKm: spike.previousMaximumKm, ratioLimit: 1.2 }, [runEvidenceRef(spike.run)]));
  if (exposure.missingReferenceIds.length) {
    insufficient = true;
    reason("extension_evidence_insufficient", { singleRunReferenceMissing: exposure.missingReferenceIds.join(",") });
  }
  const dose = assessSessionDose({ kind: input.candidateKind, structure: input.candidateStructure,
    zones: input.zones, availableSeconds: input.availableSeconds ?? null });
  if (dose.status !== "feasible" || dose.durationSeconds?.lower !== 1800 || dose.durationSeconds?.upper !== 1800) {
    reason("minimum_session_not_feasible", { doseStatus: dose.status });
  }
  for (const constraint of input.constraints.filter(item => !item.passed)) reason(
    constraint.code === "natural_week" ? "weekly_protection_reached" : "rolling_load_limit",
    { from: constraint.from, to: constraint.to, ceilingKm: constraint.ceilingKm, actualKm: constraint.actualKm,
      reservedKm: constraint.reservedKm, candidateKm: constraint.candidateKm });
  const approvedCount = countApprovedExtensions(input.reservations, input.runs, input.today);
  if (approvedCount >= MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS) reason("extension_count_limit",
    { approvedCount, maximum: MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS });
  if (!reasons.length) reason("extension_allowed", { approvedCount, maximum: MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS });
  const blocked = reasons.some(item => item.code !== "extension_evidence_insufficient" && item.code !== "extension_allowed");
  return { status: blocked ? "blocked" : insufficient ? "insufficient_evidence" : "eligible", approvedCount, reasons };
}
