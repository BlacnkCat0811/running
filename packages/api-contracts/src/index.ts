export type {
  PhysiologyPredictionReport as PredictionResponse,
  PhysiologyPredictionScenario as PredictionScenario,
  PhysiologyGuidanceCode,
  PredictionEnhancementSelection,
  PredictionModelEvent,
  PredictionModelRun,
  PredictionModelRunStatus,
  RaceDistance,
  RaceTimePrediction,
  TrainingLoadSource,
  TrainingStatusCode,
  TrainingStatisticsGranularity,
  WorkoutTrainingLoad,
  DailyTrainingMetric,
  TrainingPeriodSummary,
  TrainingStatisticsOverviewResponse,
  TrainingStatisticsHistoryResponse,
  TrainingLoadTimelineResponse,
  HeartRateZone,
  PaceZone,
  StimulusType,
  DailyZoneProfile,
  WorkoutZoneSummary,
  TrainingLoadBreakdown,
  TrainingZoneProfileSettings,
  TrainingZonesCurrentResponse,
  TrainingZonesHistoryResponse,
  UpdateTrainingZoneProfileInput
} from "@rai/contracts";

import type {
  PredictionModelEvent,
  PredictionModelRun,
  PredictionModelRunStatus,
  WorkoutTrainingLoad,
  WorkoutZoneSummary
} from "@rai/contracts";

export interface TrainPredictionModelRequest {
  /** Omit to reuse the current active training request, or use the server's current time for a new run. */
  asOf?: string;
}

export interface TrainPredictionModelResponse {
  runId: string;
  status: Extract<PredictionModelRunStatus, "queued" | "running" | "validating">;
}

export interface PredictionModelTrainingInProgressResponse {
  code: "prediction_training_in_progress";
  existingRunId: string;
  message: string;
}

export interface PredictionModelCancellationResponse {
  cancelRequested: boolean;
  status: "cancelling" | "cancelled";
}

export interface RecomputeJobCancellationResponse {
  cancelRequested: boolean;
  status: "running" | "cancelled";
}

export interface ApiErrorResponse {
  code: string;
  message: string;
}

export interface PredictionModelListResponse {
  runs: PredictionModelRun[];
}

export interface PredictionModelDetailResponse {
  run: PredictionModelRun;
  events: PredictionModelEvent[];
}

export interface InsufficientPredictionLabelsResponse {
  code: "insufficient_labeled_outcomes";
  required: number;
  available: number;
  requiredPerDistance: number;
  availableByDistance: Record<"five_k" | "ten_k" | "half_marathon", number>;
  message: string;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;

export interface HealthResponse {
  status: "ok" | string;
  databaseReady: boolean;
  localOnly: boolean;
  now: string;
}

export interface ModelRunSummary {
  id: string;
  featureRunId: string;
  datasetVersion: string;
  modelVersion: string;
  modelConfigHash: string;
  evaluatedAt: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  featureCount: number | null;
  assessmentCount: number;
  snapshotCount: number;
  active: boolean;
}

export interface AbilityMetricSet {
  efficiency: number | null;
  pace: number | null;
  cardio: number | null;
  stability: number | null;
  recovery: number | null;
}

export interface WorkoutListItem {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  distanceKm: number | null;
  averagePaceSecondsPerKm: number | null;
  averageHeartRateBpm: number | null;
  indoor: boolean | null;
  sourceCategory: string;
  sessionType: string;
  stimulusType: string;
  stimulusConfidence: number | null;
  eligibilityStatus: string;
  assessmentStatus: string | null;
  missingReasons: string[];
  qualityScore: number;
  currentAbility: number | null;
  confidence: number | null;
  trueAbilityDelta: number | null;
  hasRoute: boolean;
}

export interface DashboardResponse {
  generatedAt: string;
  activeModel: ModelRunSummary | null;
  latestSnapshot: {
    localDate: string;
    trueAbility: number | null;
    decayPoints: number;
    growthVelocityPerWeek: number | null;
    changeFrom7DaysAgo: number | null;
    status: string;
  } | null;
  latestWorkout: WorkoutListItem | null;
  dimensions: AbilityMetricSet | null;
  explanationCodes: string[];
  totals: {
    sessions: number;
    eligible: number;
    trial: number;
    excluded: number;
  };
  calibration: {
    status: "not_started" | "calibrating" | "completed";
    eligibleSessions: number;
    eligibleDurationMinutes: number;
    spanDays: number;
    highCoverageSessions: number;
    requirements: {
      sessions: number;
      durationMinutes: number;
      spanDays: number;
      highCoverageSessions: number;
    };
    baselineStartAt: string | null;
    baselineEndAt: string | null;
  };
  recentWorkouts: WorkoutListItem[];
  runningJob: RecomputeJobDto | null;
}

export interface WorkoutListResponse {
  items: WorkoutListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface RoutePointDto {
  latitude: number;
  longitude: number;
  elevationMeters: number | null;
  speedMetersPerSecond: number | null;
  timestamp: string | null;
}

export interface WorkoutOverrideDto {
  revision: number;
  eligibilityOverride: "include" | "exclude" | null;
  statisticsParticipation: "include" | "exclude" | null;
  sessionType: string | null;
  performanceProtocol: "five_k_time_trial" | "ten_k_time_trial" | "thirty_min_threshold" | "half_marathon_race" | "other_race" | null;
  rpe: number | null;
  conditionTags: string[];
  note: string | null;
  createdAt: string;
}

export interface WorkoutDetailResponse {
  workout: WorkoutListItem & {
    elapsedSeconds: number;
    activeEnergyKcal: number | null;
    elevationGainMeters: number | null;
    averageCadenceSpm: number | null;
    averagePowerWatts: number | null;
    averageStrideLengthMeters: number | null;
    averageVerticalOscillationCm: number | null;
    averageGroundContactTimeMs: number | null;
    modelVersion: string;
    updatedTrueAbility: boolean;
    heartRateCoverage: number | null;
    heartRateSampleCount: number;
    routeQuality: number | null;
    routePointCount: number;
    sourceConfidence: number;
    effectiveWeights: Record<string, number>;
    confidenceFactors: Record<string, number>;
    explanationCodes: string[];
    explanation: Record<string, unknown>;
    trueAbilityBefore: number | null;
    trueAbilityAfter: number | null;
    workoutContribution: number | null;
  };
  dimensions: AbilityMetricSet;
  route: RoutePointDto[];
  override: WorkoutOverrideDto | null;
  trainingLoad: WorkoutTrainingLoad | null;
  zoneSummary: WorkoutZoneSummary | null;
  zoneProfile: import("@rai/contracts").DailyZoneProfile | null;
}


export interface TrendResponse {
  startDate: string | null;
  endDate: string | null;
  daily: Array<{
    date: string;
    trueAbility: number | null;
    decayPoints: number;
    growthVelocityPerWeek: number | null;
    status: string;
  }>;
  workouts: Array<{
    id: string;
    date: string;
    currentAbility: number | null;
    confidence: number | null;
    assessmentStatus: string;
    distanceKm: number | null;
    durationSeconds: number;
    workoutContribution: number | null;
    dimensions: AbilityMetricSet;
  }>;
  context: Array<{
    date: string;
    distanceKm: number;
    durationMinutes: number;
    trainingLoad: number;
  }>;
  modelRuns: Array<{
    id: string;
    date: string;
    modelVersion: string;
    active: boolean;
  }>;
}

export interface RecomputeJobEventDto {
  id: string;
  phase: string;
  progressCurrent: number;
  progressTotal: number;
  message: string;
  createdAt: string;
}

export interface RecomputeJobDto {
  id: string;
  jobType: string;
  status: JobStatus;
  progressPhase: string;
  progressCurrent: number;
  progressTotal: number;
  cancelRequested: boolean;
  modelRunId: string | null;
  error: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  events?: RecomputeJobEventDto[];
}

export interface OverrideWorkoutInput {
  eligibilityOverride: "include" | "exclude" | null;
  statisticsParticipation: "include" | "exclude" | null;
  sessionType: "easy" | "steady" | "tempo" | "interval" | "long_run" | "race" | "recovery" | "unknown" | null;
  performanceProtocol: "five_k_time_trial" | "ten_k_time_trial" | "thirty_min_threshold" | "half_marathon_race" | "other_race" | null;
  rpe: number | null;
  conditionTags: string[];
  note: string | null;
}

export interface ImportJobRequest {
  sourceId: string;
}

export interface ImportJobResponse {
  id: string;
  sourceId?: string;
  status: JobStatus;
  phase: string;
  message: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  progress?: number;
  summary?: {
    importMode: "unchanged" | "incremental" | "full";
    insertedWorkouts: number;
    updatedWorkouts: number;
    removedWorkouts: number;
    unchangedWorkouts: number;
    routesUpdated: number;
    featuresReused: number;
    featuresRecomputed: number;
    modelReplayFrom: string | null;
    durationMs: number;
    backupName: string | null;
  };
}

export interface BackupDto {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface QuarantineDto {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export type DatabaseDeletionResponse =
  | { deleted: true; preservation: { kind: "backup"; backup: BackupDto } }
  | { deleted: true; preservation: { kind: "quarantine"; snapshot: QuarantineDto } };

export interface DataSummaryResponse {
  databaseBytes: number;
  datasetVersion: string | null;
  importCompletedAt: string | null;
  counts: {
    healthRecords: number;
    workouts: number;
    trainingSessions: number;
    routePoints: number;
    assessments: number;
  };
  issues: Array<{ severity: string; count: number }>;
}

export interface RuntimeStatusResponse {
  databaseReady: boolean;
  busy: boolean;
  recomputeJob: RecomputeJobDto | null;
  importJob: ImportJobResponse | null;
  predictionModelJob: PredictionModelRun | null;
}

export interface ModelRunComparisonResponse {
  base: ModelRunSummary;
  candidate: ModelRunSummary;
  metrics: {
    matchedSessions: number;
    currentAbilityMeanDelta: number | null;
    currentAbilityMeanAbsoluteDelta: number | null;
    confidenceMeanDelta: number | null;
    finalTrueAbilityDelta: number | null;
    assessmentStatusChanged: number;
  };
  topChangedWorkouts: Array<{
    trainingSessionId: string;
    startedAt: string;
    baseCurrentAbility: number | null;
    candidateCurrentAbility: number | null;
    delta: number | null;
  }>;
}

export interface DataAuditResponse {
  datasetVersion: string | null;
  importCompletedAt: string | null;
  ranges: {
    healthRecords: { first: string | null; last: string | null };
    workouts: { first: string | null; last: string | null };
  };
  canonical: {
    healthRecords: number;
    workouts: number;
    canonicalWorkouts: number;
    workoutGroups: number;
    trainingSessions: number;
    routes: number;
    routePoints: number;
  };
  featureQuality: {
    averageQualityScore: number | null;
    averageHeartRateCoverage: number | null;
    minimumHeartRateCoverage: number | null;
    maximumHeartRateCoverage: number | null;
  };
  recordTypes: Array<{ type: string; count: number }>;
  sourceCategories: Array<{ category: string; count: number }>;
  sessionStatuses: Array<{ status: string; count: number }>;
  missingReasons: Array<{ reason: string; count: number }>;
  issues: Array<{ severity: string; code: string; count: number }>;
}

export interface WorkoutSeriesResponse {
  trainingSessionId: string;
  startedAt: string;
  endedAt: string;
  sourceCategory: string;
  splits: WorkoutSplit[];
  series: {
    heartRate: WorkoutMetricSeries;
    speed: WorkoutMetricSeries;
    power: WorkoutMetricSeries;
    cadence: WorkoutMetricSeries;
    elevation: WorkoutMetricSeries;
    strideLength: WorkoutMetricSeries;
    verticalOscillation: WorkoutMetricSeries;
    groundContactTime: WorkoutMetricSeries;
  };
}

export interface WorkoutSplit {
  index: number;
  distanceMeters: number;
  durationSeconds: number;
  averagePaceSecondsPerKm: number;
  averageHeartRateBpm: number | null;
  averageCadenceSpm: number | null;
}

export interface WorkoutMetricSeries {
  unit: string;
  totalSamples: number;
  points: Array<{ timestamp: string; offsetSeconds: number; value: number }>;
}

export interface DiagnosticExportResponse {
  generatedAt: string;
  privacy: {
    coordinatesRemoved: true;
    healthTimeSeriesRemoved: true;
    sourceNamesRemoved: true;
  };
  dataset: {
    version: string | null;
    importedAt: string | null;
    counts: DataSummaryResponse["counts"];
  };
  activeModel: {
    id: string;
    modelVersion: string;
    modelConfigHash: string;
    featureRunId: string;
    calibrationFeatureIds: string[];
  } | null;
  calibration: DashboardResponse["calibration"] | null;
  jobs: RecomputeJobDto[];
  issues: Array<{ severity: string; code: string; count: number }>;
  exclusionReasons: Array<{ reason: string; count: number }>;
}
