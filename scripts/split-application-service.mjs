import fs from "node:fs";

const path = "packages/application/src/service.ts";
const src = fs.readFileSync(path, "utf8");
const lines = src.split(/\r?\n/);

const classStart = lines.findIndex((l) => l.startsWith("export class RaiApplicationService"));
if (classStart < 0) throw new Error("class not found");
const helpersStart = lines.findIndex((l) => l.startsWith("const clamp ="));
if (helpersStart < 0) throw new Error("helpers not found");

const helpers = lines.slice(helpersStart, classStart).join("\n");

const typesFile = `import type {
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
  validationMode: "off" | "shadow";
}

export interface RecomputeOptions {
  evaluatedAt?: string;
  timezoneIdentifier?: string;
  featureConfig?: FeatureConfig;
  modelConfig?: RaiModelConfig;
  validationMode?: "off" | "shadow";
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

export interface AppendWorkoutOverrideInput {
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

  constructor(readonly trainingSessionId: string) {
    super(\`Unknown training session: \${trainingSessionId}\`);
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
`;

const helpersFile = `import type { NumericSeriesSummary } from "@rai/features";
import { defaultFeatureConfig } from "@rai/features";
import { defaultRaiModelConfig } from "@rai/scoring";
import { appNow, median } from "./utils.js";
import type { RecomputeOptions, RecomputeRequest, RecordRow, StatisticRow } from "./service-types.js";

${helpers}
`;

fs.writeFileSync("packages/application/src/service-types.ts", typesFile);
fs.writeFileSync("packages/application/src/recompute-helpers.ts", helpersFile);

// Rewrite service.ts to import types/helpers and drop duplicated definitions
const classBody = lines.slice(classStart).join("\n");

// Remove type definitions that are now in service-types (lines before helpersStart after imports)
// Keep only imports + class
const importEnd = lines.findIndex((l, i) => i > 0 && l.startsWith("const runningType"));
const importBlock = lines.slice(0, importEnd >= 0 ? importEnd : helpersStart).join("\n");

const newService = `${importBlock}

export {
  WorkoutNotFoundError,
  TrainingZoneProfileValidationError,
  TrainingZoneProfileRevisionConflictError,
  type AppendWorkoutOverrideInput,
  type AppendWorkoutOverrideResult,
  type RecomputeOptions
} from "./service-types.js";

import {
  runningType,
  heartRateType,
  runningSpeedType,
  restingHeartRateType,
  hrvType,
  sleepType,
  distanceType,
  MODEL_CHECKPOINT_VERSION,
  WorkoutNotFoundError,
  TrainingZoneProfileValidationError,
  TrainingZoneProfileRevisionConflictError,
  type SessionRow,
  type StatisticRow,
  type RecordRow,
  type RouteQualityRow,
  type TimelineAssessment,
  type RecomputeRequest,
  type RecomputeOptions,
  type ModelCheckpointState,
  type ReplayResume,
  type AppendWorkoutOverrideInput,
  type AppendWorkoutOverrideResult
} from "./service-types.js";

import {
  clamp,
  asNullableNumber,
  finiteNumber,
  convertDistanceToKilometers,
  convertSpeedToMetersPerSecond,
  coefficientOfVariation,
  weightedRecordIntervals,
  coveredDurationSeconds,
  sustainedThirtySecondPeak,
  summaryFromRecords,
  fallbackStatisticSummary,
  defaultRequest
} from "./recompute-helpers.js";

${classBody}
`;

fs.writeFileSync(path, newService);
console.log("Rewrote service.ts, helpers and types extracted");
console.log("service lines", newService.split(/\n/).length);
console.log("helpers lines", helpersFile.split(/\n/).length);
console.log("types lines", typesFile.split(/\n/).length);
