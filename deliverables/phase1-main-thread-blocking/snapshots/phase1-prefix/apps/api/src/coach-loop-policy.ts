import type { CoachDecisionReason, CoachEvidenceRef, CoachPolicyManifest } from "@rai/api-contracts";
import { SESSION_DOSE_POLICY_VERSION } from "./coach-session-dose.js";

/** Explicitly candidate-only until the plan's D-08/D-11/D-12 approval gates close. */
export const CAPACITY_ENVELOPE_CANDIDATE_VERSION = "rai-coach-capacity-envelope-candidate-v1";
export const EXTENSION_ELIGIBILITY_CANDIDATE_VERSION = "rai-coach-extension-eligibility-candidate-v1";
export const COACH_REPLAY_VERSION = "rai-coach-behavior-replay-v1";
export const COACH_POLICY_MANIFEST: Readonly<CoachPolicyManifest> = Object.freeze({
  contractVersion: 1,
  trainingModeVersion: "rai-coach-training-mode-candidate-v1",
  sessionDoseVersion: SESSION_DOSE_POLICY_VERSION,
  budgetAllocationVersion: "rai-coach-complete-allocation-v1",
  extensionEligibilityVersion: EXTENSION_ELIGIBILITY_CANDIDATE_VERSION,
  capacityEnvelopeVersion: CAPACITY_ENVELOPE_CANDIDATE_VERSION,
  executionProtectionVersion: "rai-pre-race-execution-protection-v1",
  executionAssessmentVersion: "rai-coach-execution-assessment-candidate-v1",
  adaptationVersion: "rai-coach-plan-repair-candidate-v1",
  templateLibraryVersion: "legacy_builders",
  subjectiveFeedbackVersion: "rai-coach-subjective-feedback-candidate-v1",
  predictionSummaryVersion: "rai-coach-goal-gap-candidate-v1",
  replayScenarioVersion: COACH_REPLAY_VERSION
});

export function coachReason(
  code: string, policyVersion: string, affectedDates: string[],
  params: CoachDecisionReason["params"] = {}, evidenceRefs: CoachEvidenceRef[] = []
): CoachDecisionReason {
  return { code, policyVersion, affectedDates, params, evidenceRefs };
}
