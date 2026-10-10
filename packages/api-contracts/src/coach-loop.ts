import type { MobilePeriodizationPhase, MobileSessionKind, MobileSessionStructure } from "./index.js";
import type { DatabaseTimezone } from "@rai/contracts";
import type { MobileGoalsResponse, MobilePlanOperationScope, MobilePlannedDay, MobileRaceTarget, MobileRunCoachConfig, MobilePlanReceiptInput } from "./index.js";

/** Versioned coach-loop contracts. Candidate outputs do not authorize execution. */
export interface CoachEvidenceRef {
  source: string;
  id: string;
  observedAt: string | null;
  availableAt: string | null;
  revisionOrHash: string | null;
}

export interface CoachDecisionReason {
  code: string;
  policyVersion: string;
  evidenceRefs: CoachEvidenceRef[];
  affectedDates: string[];
  params: Record<string, string | number | boolean | null>;
}

export interface CoachPolicyManifest {
  contractVersion: number;
  trainingModeVersion: string;
  sessionDoseVersion: string;
  budgetAllocationVersion: string;
  extensionEligibilityVersion: string;
  capacityEnvelopeVersion: string;
  executionProtectionVersion: string;
  executionAssessmentVersion: string;
  adaptationVersion: string;
  templateLibraryVersion: string;
  subjectiveFeedbackVersion: string;
  predictionSummaryVersion: string;
  replayScenarioVersion: string;
}

export type CoachTrainingMode = "daily_adaptive" | "race_preparation";

export interface CoachExecutionPolicyContext {
  localDate: string;
  phase: MobilePeriodizationPhase | null;
  phasePolicyVersion: string;
  protections: Array<{
    code: "pre_race_execution_protection" | "race_day_no_extra_training";
    policyVersion: string;
    active: boolean;
    daysToRace: number;
    scope: "current_day";
    constraints: Array<{
      kind: "replace_quality_with_easy" | "cap_distance" | "no_extra_training" | "no_quality_or_long_run";
      value: number | null;
      unit: "km" | null;
    }>;
    reasons: CoachDecisionReason[];
  }>;
}

export interface CoachSessionDose {
  policyVersion: string;
  status: "feasible" | "not_feasible" | "not_assessable" | "not_applicable";
  estimateSource: "zone_pace_range" | "cold_start_policy" | "unavailable";
  durationSeconds: { lower: number; upper: number } | null;
  distanceKm: { lower: number; upper: number } | null;
  workSecondsLower: number | null;
  workMetersLower: number | null;
  workRepetitions: number;
  reasonCodes: string[];
}

export interface CoachCapacityAnchor {
  id: string;
  revision: number;
  factsHash: string;
  weekStart: string;
  historyThrough: string;
  observedDays: number;
  coverageDays: number;
  recentWeeklyKm: number;
  previousWeekKm: number;
  policyVersion: string;
  evidenceRefs: CoachEvidenceRef[];
}

export interface CoachVolumeConstraint {
  code: string;
  from: string;
  to: string;
  actualKm: number;
  reservedKm: number;
  candidateKm: number;
  ceilingKm: number;
  remainingBeforeCandidateKm: number;
  passed: boolean;
}

export interface CoachVolumePolicy {
  schemaVersion: number;
  asOf: string;
  weekStart: string;
  timezone: DatabaseTimezone;
  anchor: CoachCapacityAnchor;
  suggestedWeeklyKm: number;
  weeklyProtectionKm: number;
  rollingLimits: Array<{ days: 7 | 14; ceilingKm: number }>;
  actualWeekKm: number;
  regularReservedKm: number;
  extensionReservedKm: number;
  otherReservedKm: number;
  suggestedRemainingKm: number;
  actualOverSuggestionKm: number;
  constraints: CoachVolumeConstraint[];
  extension: {
    status: "not_needed" | "eligible" | "blocked" | "insufficient_evidence";
    assessedForDate: string;
    candidatePrescriptionDigest: string | null;
    /** Null for all offline/read-only evaluations, including eligible ones. */
    authorizedDecisionRef: string | null;
    approvedSessionsInRolling7Days: number;
    maximumSessionsInRolling7Days: number;
    reasons: CoachDecisionReason[];
  };
  policyManifest: CoachPolicyManifest;
}

export interface CoachLoopCandidate {
  localDate: string;
  kind: MobileSessionKind;
  structure: MobileSessionStructure | null;
  prescriptionDigest: string | null;
  dose: CoachSessionDose;
  allocation: "regular" | "extension" | "rest";
  /** Offline candidates are never a publication or a device delivery receipt. */
  executable: false;
  volumePolicy: CoachVolumePolicy;
  reasons: CoachDecisionReason[];
}

/** Three independent conclusions; candidate thresholds are not adaptation authority. */
export interface WorkoutExecutionAssessment {
  version: string;
  policyStatus: "candidate";
  localDate: string;
  asOf: string;
  planRevision: number | null;
  prescriptionDigest: string | null;
  workoutIds: string[];
  association: {
    status: "matched" | "ambiguous" | "unmatched";
    method: "measured_steps_with_plan" | "valid_receipt" | "plan_history" | null;
    evidenceRefs: CoachEvidenceRef[];
  };
  observation: "observed" | "unknown";
  evidenceLevel: "measured_steps" | "reconstructed_segments" | "summary_only" | "none";
  dose: {
    status: "met" | "partial" | "not_met" | "not_assessable";
    basis: "work_steps" | "whole_session" | null;
    requiredDistanceMeters: number | null;
    observedDistanceMeters: number | null;
    requiredWorkSeconds: number | null;
    observedWorkSeconds: number | null;
    requiredReps: number | null;
    verifiedReps: number | null;
  };
  stimulus: {
    status: "matched" | "too_hard" | "too_easy" | "not_assessable";
    channel: "pace" | "heart_rate" | null;
    validCoverageFraction: number | null;
    timeInTargetFraction: number | null;
  };
  completion: "confirmed" | "known_not_met" | "unconfirmed" | "not_applicable";
  reasons: CoachDecisionReason[];
}

export interface CoachPlanRepairCost {
  changedDates: number;
  movedSessions: number;
  kindChanges: number;
  workDoseRelativeDifference: number;
  preferenceRank: number;
}

export interface CoachAdaptationRecord {
  operationId: string;
  programmeId: string | null;
  scope: { serverId: string; athleteId: string; datasetEpoch: string };
  inputDigest: string;
  policyManifest: CoachPolicyManifest;
  evaluatedAt: string;
  sourceGoalsRevision: number;
  resultingGoalsRevision: number;
  result: "no_change" | "patched" | "safe_fallback";
  affectedDates: string[];
  changes: Array<{
    localDate: string;
    layer: "stored_plan" | "effective_execution";
    before: { kind: string; prescriptionDigest: string | null };
    after: { kind: string; prescriptionDigest: string | null };
    doseBefore: number | null;
    doseAfter: number | null;
    doseUnit: "work_seconds" | "work_meters" | "reps" | null;
    safetyDowngrade: boolean;
    reasons: CoachDecisionReason[];
  }>;
}

export interface CoachQualityExecutionSummary {
  version: string;
  policyStatus: "candidate";
  asOf: string;
  qualityPlanned: number;
  /** Compatible observation count: record on the prescription date, not completion. */
  qualityObserved: number;
  qualityConfirmed: number;
  qualityKnownNotMet: number;
  qualityUnconfirmed: number;
}

export interface SubjectiveFeedback {
  id: string;
  revision: number;
  policyVersion: string;
  policyStatus: "candidate";
  scope: { athleteId: string; datasetEpoch: string };
  localDate: string;
  phase: "pre_run" | "post_run";
  workoutId: string | null;
  fatigue: "usual" | "elevated" | "high" | null;
  soreness: "none" | "mild" | "marked" | null;
  discomfort: "none" | "present" | null;
  requestedAction: "none" | "easy_only" | "rest" | null;
  interruptionReason: "time_constraint" | "fatigue" | "discomfort" | "weather" | "equipment" | "other" | null;
  replacementReason: "time_constraint" | "preference" | "fatigue" | "discomfort" | "other" | null;
  rpeOverrideRef: { workoutId: string; revision: number } | null;
  observedAt: string;
  recordedAt: string;
  availableAt: string;
  validUntil: string;
  retractedAt: string | null;
}

export interface CoachPredictionSummary {
  schemaVersion: number;
  id: string;
  athleteId: string;
  bundleId: string;
  bundleHash: string;
  datasetEpoch: string;
  factsHash: string;
  overrideHash: string;
  labelCohortHash: string | null;
  activePredictionArtifactId: string | null;
  predictionPolicyVersion: string;
  scenario: "current_prepared";
  asOf: string;
  publishedAt: string;
  dataThroughAt: string | null;
  availableAt: string;
  entries: Array<{
    distance: "five_k" | "ten_k" | "half_marathon";
    status: "available" | "insufficient_data";
    referenceSeconds: number | null;
    method: string;
    calibrationStatus: "uncalibrated" | "personal_reference" | "empirically_evaluated";
    range: {
      lowerSeconds: number;
      upperSeconds: number;
      kind: "heuristic_not_calibrated" | "personal_reference" | "empirical";
    } | null;
    evidenceRefs: CoachEvidenceRef[];
    limitationCodes: string[];
  }>;
}

export interface CoachGoalGap {
  policyVersion: string;
  policyStatus: "candidate";
  status: "available" | "no_time_goal" | "unsupported_distance" | "summary_unavailable" | "stale" | "incompatible";
  summaryId: string | null;
  distance: "five_k" | "ten_k" | "half_marathon" | null;
  targetSeconds: number | null;
  referenceSeconds: number | null;
  gapSeconds: number | null;
  preparationGaps: Array<{ code: string; evidenceRefs: CoachEvidenceRef[] }>;
  freshness: { asOf: string | null; dataThroughAt: string | null; stale: boolean };
  calibrationStatus: "uncalibrated" | "personal_reference" | "empirically_evaluated" | null;
  reasons: CoachDecisionReason[];
}

/** Opt-in versioned runtime. Legacy DTOs never silently change S into H. */
export interface CoachLoopSettings {
  mode: CoachTrainingMode;
  status: "active" | "paused" | "ended";
  runningDays: number[];
  longRunDays: number[];
  availabilityMinutesByWeekday: Partial<Record<string, number | null>>;
  targetType: "pace" | "heart_rate";
  race: MobileRunCoachConfig | null;
}

export interface CoachLoopCommand {
  contractVersion: 1;
  operationId: string;
  operationScope: MobilePlanOperationScope;
  expectedRevision: number;
  expectedFactsHash: string;
  action: "enable" | "refresh" | "update" | "pause" | "resume" | "end";
  /** Required for enable; accepts this specific policy, not a blanket upgrade. */
  acceptedPolicyHash?: string;
  settings?: Omit<CoachLoopSettings, "status">;
}

export interface CoachLoopRuntimeResponse {
  contractVersion: 1;
  scope: MobilePlanOperationScope;
  timezone: DatabaseTimezone;
  /** Server-generated identity for the exact effective execution, not just goals. */
  executionToken: string;
  policyHash: string;
  policyManifest: CoachPolicyManifest;
  revision: number;
  factsHash: string;
  asOf: string;
  settings: CoachLoopSettings | null;
  raceTarget: MobileRaceTarget | null;
  volumePolicy: CoachVolumePolicy;
  refreshRequired: boolean;
  today: { day: MobilePlannedDay; executable: boolean; decisionRef: string | null };
  days: Array<{ day: MobilePlannedDay; executable: boolean; decisionRef: string | null; templateId: string | null }>;
  feedback: { restRequested: boolean; qualityBlocked: boolean; extensionBlocked: boolean; activeFeedbackIds: string[] };
  subjectiveFeedback: SubjectiveFeedback[];
  execution: WorkoutExecutionAssessment[];
  executionSummary: CoachQualityExecutionSummary;
  executionPolicy: CoachExecutionPolicyContext;
  goalGap: CoachGoalGap | null;
  goals: MobileGoalsResponse;
  reasons: CoachDecisionReason[];
}

export interface CoachLoopReceiptContext {
  contractVersion: 1;
  policyHash: string;
  decisionRef: string | null;
}

/** Uses the existing system-schedule journal; never certifies Watch delivery. */
export interface CoachLoopDeviceReceipt extends MobilePlanReceiptInput {
  coachLoop: CoachLoopReceiptContext;
}
