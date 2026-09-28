import type {
  EligibilityStatus,
  PerformanceProtocol,
  SessionType
} from "@rai/contracts";
import type { FeatureConfig } from "@rai/features";
import type { PersonalBaseline, RaiModelConfig } from "@rai/scoring";
import type { RecomputePlan } from "@rai/health-export-parser";

export const runningType = "HKWorkoutActivityTypeRunning";
export const heartRateType = "HKQuantityTypeIdentifierHeartRate";
export const runningSpeedType = "HKQuantityTypeIdentifierRunningSpeed";
export const restingHeartRateType = "HKQuantityTypeIdentifierRestingHeartRate";
export const hrvType = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
export const sleepType = "HKCategoryTypeIdentifierSleepAnalysis";
export const distanceType = "HKQuantityTypeIdentifierDistanceWalkingRunning";

export interface SessionRow {
  trainingSessionId: string;
  trainingSessionStatus: "active" | "inactive" | "ambiguous";
  canonicalWorkoutId: string;
  workoutStartAt: string;
  workoutEndAt: string;
  durationSeconds: number;
  indoor: number | null;
  sourceCategory: string;
  sourceName: string;
  distanceValue: number | null;
  distanceUnit: string | null;
}

export interface StatisticRow {
  averageValue: number | null;
  minimumValue: number | null;
  maximumValue: number | null;
  unit: string | null;
}

export interface RecordRow {
  value: number;
  startAt: string;
  endAt: string;
  unit?: string | null;
}

export interface RouteQualityRow {
  pointCount: number;
  averageHorizontalAccuracy: number | null;
}

export interface TimelineAssessment {
  id: string;
  workoutStartAt: string;
  assessmentStatus: EligibilityStatus | "calibrating";
  trueAbilityAfter: number | null;
}

export interface RecomputeRequest {
  evaluatedAt: string;
  timezoneIdentifier: string;
  featureConfig: FeatureConfig;
  modelConfig: RaiModelConfig;
  incrementalPlan?: RecomputePlan;
}

export interface RecomputeOptions {
  evaluatedAt?: string;
  timezoneIdentifier?: string;
  featureConfig?: FeatureConfig;
  modelConfig?: RaiModelConfig;
}

export const MODEL_CHECKPOINT_VERSION = "rai-model-checkpoint-v1";

export interface ModelCheckpointState {
  baseline: PersonalBaseline;
  trueAbility: number;
  lastEligibleLocalDate: string | null;
  lastEligibleTrueAbility: number;
  eligibleWorkoutCount: number;
}

export interface ReplayResume {
  parentModelRunId: string;
  throughSequence: number;
  state: ModelCheckpointState;
}

export class WorkoutOverrideRevisionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "workout_override_revision_conflict";
  constructor() { super("训练反馈已在别处更新，你的输入仍保留，请读取最新记录后再提交"); }
}

export interface AppendWorkoutOverrideInput {
  /** Optional only for the legacy-client compatibility window. */
  expectedRevision?: number;
  trainingSessionId: string;
  eligibilityOverride: "include" | "exclude" | null;
  statisticsParticipation?: "include" | "exclude" | null;
  sessionType: SessionType | null;
  performanceProtocol: PerformanceProtocol | null;
  rpe: number | null;
  conditionTags: string[];
  note: string | null;
}

export interface AppendWorkoutOverrideResult {
  overrideId: string;
  jobId: string;
}

export class WorkoutNotFoundError extends Error {
  readonly code = "workout_not_found" as const;
  readonly statusCode = 404;

  constructor(readonly trainingSessionId: string) {
    super(`Unknown training session: ${trainingSessionId}`);
  }
}

export class TrainingZoneProfileValidationError extends Error {
  readonly code = "invalid_training_zone_profile" as const;
}

export class TrainingZoneProfileRevisionConflictError extends Error {
  readonly code = "training_zone_profile_revision_conflict" as const;

  constructor() {
    super("Training zone settings revision conflict");
  }
}
