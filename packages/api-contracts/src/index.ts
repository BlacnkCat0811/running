export type {
  PhysiologyPredictionReport as PredictionResponse,
  PhysiologyPredictionScenario as PredictionScenario,
  PhysiologyGuidanceCode,
  PredictionEnhancementSelection,
  PredictionModelEvent,
  PredictionModelRun,
  PredictionModelRunStatus,
  RaceDistance,
  MobileSessionKind,
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
  MobileSessionKind,
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
  serverId: string;
  athleteId: string;
  datasetEpoch: string;
  syncProtocolVersion: number;
  now: string;
}

/** Identity and protocol handshake. Clients use it to detect a dataset reset. */
export interface HandshakeResponse {
  serverId: string;
  athleteId: string;
  datasetEpoch: string;
  syncProtocolVersion: number;
  apiVersion: string;
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

export interface RecoveryTrendResponse {
  generatedAt: string;
  asOf: string;
  timezone: "Asia/Shanghai";
  latestDataDate: string | null;
  days: Array<{
    date: string;
    sleepMinutes: number | null;
    hrvSdnnMs: number | null;
    hrvSampleCount: number;
    hrvConfidence: "confident" | "sparse" | "missing";
    sourceCategory: string | null;
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

export interface ImportExecutionEngine {
  name: "typescript" | "rust";
  version: string;
  fallback: "none" | "typescript";
}
export type CommandKind = "workout_override" | "training_zones" | "recompute" |
  "prediction_training" | "activate_model" | "activate_prediction";

export interface CommandRequest {
  idempotencyKey: string;
  kind: CommandKind;
  payload: Record<string, unknown>;
}

export interface CommandResponse {
  id: string;
  kind: CommandKind;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  createdAt: string;
  completedAt: string | null;
  result?: unknown;
  error?: { code: string; message: string };
}

export type ImportStage = "backup" | "stagingCopy" | "parseImport" | "changeAnalysis" |
  "recompute" | "activation" | "cleanup";

export interface ImportJobPerformance {
  /** Extra full replay comparison only; the model activation gate stays enabled. */
  validationMode: "shadow" | "off" | "not-run";
  totalMs: number;
  stagesMs: Partial<Record<ImportStage, number>>;
  computeStagesMs?: Record<string, number>;
  computeProcessMaxRssKiB?: number;
  native?: Record<string, { rustCalls: number; typescriptFallbacks: number; wallMs: number; peakRssKiB: number }>;
}

export interface ImportJobResponse {
  executionEngine?: ImportExecutionEngine;
  id: string;
  sourceId?: string;
  status: JobStatus;
  phase: string;
  message: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  progress?: number;
  queuePosition?: number;
  waitingReason?: "writer_busy";
  /** Optional for compatibility with persisted jobs from older versions. */
  performance?: ImportJobPerformance;
  removalGuard?: RemovalGuardDto;
  summary?: {
    recomputeReasons?: string[];
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

export interface RemovalGuardDto {
  code: "import_removal_guard";
  preview: {
    records: number;
    workouts: number;
    activitySummaries: number;
    total: number;
  };
  existingEntities: number;
  allowedRemovals: number;
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
  segments: WorkoutSegment[];
  segmentPlan: WorkoutSegmentPlanMatch | null;
  /** Why `segments` is empty, or what the match assumed — never silently blank. */
  segmentNote: string | null;
  /** True only for recorded structured workout steps, not inferred plan replay or manual laps. */
  hasMeasuredWorkoutSteps?: boolean;
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

export type MobileVerdictTone = "green" | "yellow" | "red";
export type MobileDayPhase = "need_sync" | "morning_open" | "locked" | "post_run" | "rest_done";
export type MobileRaceDistance = "five_k" | "ten_k" | "half_marathon";
export type MobileStimulusMatch = "aligned" | "too_hard" | "too_easy" | "unknown";

export interface MobileTrigger {
  code: string;
  value: number | null;
  threshold: number | null;
  detail: string;
}

export interface MobileAbilityCard {
  trueAbility: number | null;
  currentAbility: number | null;
  changeFrom7DaysAgo: number | null;
  growthVelocityPerWeek: number | null;
  decayPoints: number;
  snapshotDate: string | null;
  explanation: string;
}

export interface MobileCalibrationCard {
  status: "not_started" | "calibrating" | "completed";
  eligibleSessions: number;
  eligibleDurationMinutes: number;
  spanDays: number;
  highCoverageSessions: number;
  requirements: DashboardResponse["calibration"]["requirements"];
  message: string;
}

export interface MobileVerdict {
  tone: MobileVerdictTone;
  title: string;
  reason: string;
  triggers: MobileTrigger[];
  stale: boolean;
  reasonCodes?: string[];
}

export type MobileStepPurpose = "warmup" | "work" | "recovery" | "cooldown";

/** Step goal. Mirrors the WorkoutKit goal model so the device layer is a pure translation. */
export type MobileStepGoal =
  | { type: "distance"; meters: number }
  | { type: "time"; seconds: number }
  | { type: "open" };

/**
 * At most one alert per step — the same limit WorkoutKit enforces, so a step
 * can never request both pace and heart-rate feedback.
 */
export interface MobileStepAlert {
  kind: "pace" | "heart_rate";
  lower: number | null;
  upper: number | null;
}

export interface MobileWorkoutStep {
  purpose: MobileStepPurpose;
  goal: MobileStepGoal;
  alert: MobileStepAlert | null;
}

export interface MobileIntervalBlock {
  iterations: number;
  steps: MobileWorkoutStep[];
}

/**
 * Structured session shape. Deliberately mirrors WorkoutKit's
 * `CustomWorkout(warmup:blocks:cooldown:)` so that any producer (heuristic
 * coach or LLM) can fill it and the device layer needs no mapping logic.
 */
export interface MobileSessionStructure {
  warmup: MobileWorkoutStep | null;
  blocks: MobileIntervalBlock[];
  cooldown: MobileWorkoutStep | null;
}

/** Who produced a stored weekly plan; kept for auditability (LLM output is not reproducible). */
export type MobilePlanSource = "llm" | "heuristic" | "manual";

export interface MobilePlanAudit {
  generatedBy: MobilePlanSource;
  model: string | null;
  promptVersion: string | null;
  generatedAt: string | null;
}

export interface MobileNextSession {
  kind: MobileSessionKind;
  title: string;
  reason: string;
  distanceKm: number | null;
  durationMinutes: number | null;
  paceSecondsPerKmLower: number | null;
  paceSecondsPerKmUpper: number | null;
  heartRateBpmLower: number | null;
  heartRateBpmUpper: number | null;
  /** Interval/step breakdown. Null when the session is a single continuous effort. */
  structure: MobileSessionStructure | null;
}

export interface MobileRecoveryBreakdown {
  score: number | null;
  lastNightSleepMinutes: number | null;
  sleepBaselineMinutes: number | null;
  morningHrvMs: number | null;
  hrvBaselineMs: number | null;
  restingHeartRateBpm: number | null;
  restingHeartRateBaselineBpm: number | null;
  state?: "unknown" | "depleted" | "reduced" | "recovered";
  hrvSampleCount?: number;
  note: string;
}

export interface MobilePostRunVerdict {
  workoutId: string;
  startedAt: string;
  sessionType: string;
  stimulusType: string;
  stimulusMatch: MobileStimulusMatch;
  indoor: boolean | null;
  updatedTrueAbility: boolean;
  trueAbilityDelta: number | null;
  currentAbility: number | null;
  trueAbilityAfter: number | null;
  headline: string;
  details: string[];
}

export interface MobileWeekStructure {
  easyDurationFraction: number | null;
  easyDurationFloorFraction: number;
  qualitySessionCount: number;
  qualitySessionCap: number;
  easyHonesty: {
    intendedEasyCount: number;
    easyEnoughCount: number;
    honestyFraction: number | null;
    note: string;
  };
  remainingDistanceKm: number | null;
}

export interface MobileRaceTarget {
  date: string;
  distance: MobileRaceDistance;
  targetPaceSecondsPerKm: number | null;
}

export interface MobileRaceCard {
  target: MobileRaceTarget | null;
  daysUntil: number | null;
  taper: boolean;
  shapeScore: number | null;
  volumeFraction: number | null;
  longRunFraction: number | null;
  note: string;
}

export interface MobileInjuryFlag {
  code: string;
  title: string;
  detail: string;
}

export interface MobileWeekPlanDay {
  localDate: string;
  kind: MobileSessionKind | "completed";
  title: string;
  planned: boolean;
  completedWorkoutId: string | null;
  distanceKm: number;
  workoutCount: number;
  /** Present for planned days that carry an interval/prescription breakdown. */
  structure: MobileSessionStructure | null;
}

/**
 * A single persisted planned day. `structure` is optional so plans written by
 * older clients (or by hand without a breakdown) remain valid.
 */
export interface MobilePlannedDay {
  localDate: string;
  kind: MobileSessionKind;
  distanceKm: number | null;
  structure?: MobileSessionStructure | null;
  /** Free-text rationale, typically supplied by the weekly plan generator. */
  reason?: string | null;
}

/** Executable prescription for one day, as consumed by the WorkoutKit bridge. */
export interface MobileWorkoutPlanDay {
  localDate: string;
  kind: MobileSessionKind;
  title: string;
  reason: string;
  distanceKm: number | null;
  durationMinutes: number | null;
  paceSecondsPerKmLower: number | null;
  paceSecondsPerKmUpper: number | null;
  heartRateBpmLower: number | null;
  heartRateBpmUpper: number | null;
  structure: MobileSessionStructure | null;
  source: MobilePlanSource;
  /** False for rest days, which are intentionally not synced to the watch. */
  executable: boolean;
}

export interface MobileWorkoutPlanResponse {
  generatedAt: string;
  timezone: string;
  /** Number of days returned, starting today. */
  windowDays: number;
  planRevision: number;
  audit: MobilePlanAudit | null;
  days: MobileWorkoutPlanDay[];
}

/** Result of a weekly plan generation (model or fallback). */
export interface MobileWeeklyPlanGenerationResponse {
  generatedAt: string;
  revision: number;
  audit: MobilePlanAudit;
  days: MobilePlannedDay[];
  /** Rejections and clamp adjustments, surfaced for review after the fact. */
  warnings: string[];
}

export interface MobileLockedSession {
  localDate: string;
  session: MobileNextSession;
  verdictTone: MobileVerdictTone;
  lockedAt: string;
}

export interface MobileLockState {
  present: boolean;
  relockSuggested: boolean;
  lockedAt: string | null;
}

export interface LockMobileSessionInput {
  action: "lock" | "relock";
  expectedRevision?: string;
}

/** Historical observations, not a completion/adherence grade. Missing imports remain pending. */
export interface MobilePlanExecutionDay {
  localDate: string;
  planRevision: number | null;
  plannedKind: MobileSessionKind | null;
  plannedDistanceKm: number | null;
  observedDistanceKm: number;
  observedWorkoutCount: number;
  distanceRatio: number | null;
  status: "observed" | "pending" | "unknown";
}

/** Aggregated payload for the iOS home page ("今天"). */
export interface MobileTodayResponse {
  generatedAt: string;
  timezone: string;
  /** Latest local_date present in the training loads; null when the store is empty. */
  latestDataDate: string | null;
  /** The latest successful server-side data refresh, independent of training dates. */
  lastSyncedAt: string | null;
  /** Recovery/sample coverage is intentionally separate from training freshness. */
  freshness: {
    state: "unknown" | "valid" | "stale";
    checkedAt: string | null;
    latestTrainingDate: string | null;
    recoveryDate: string | null;
  };
  recommendationRevision: string;
  today: {
    localDate: string;
    distanceKm: number;
    durationSeconds: number;
    paceSecondsPerKm: number | null;
    energyKcal: number | null;
    workoutCount: number;
  };
  week: {
    periodStart: string;
    periodEnd: string;
    distanceKm: number;
    durationSeconds: number;
    workoutCount: number;
    goalDistanceKm: number | null;
    goalProgressFraction: number | null;
    /** Running-only averages; heart rate is weighted by recorded workout duration. */
    averageSpeedKmPerHour?: number | null;
    averagePaceSecondsPerKm?: number | null;
    averageHeartRateBpm?: number | null;
    heartRateZones?: Array<{ zone: string; durationSeconds: number; fraction: number }>;
    paceZones?: Array<{ zone: string; durationSeconds: number; fraction: number }>;

  };
  /** Monday..Sunday of the current week; missing days are zero-filled. */
  weekDaily: Array<{ localDate: string; distanceKm: number; workoutCount: number }>;
  recentWorkouts: WorkoutListItem[];
  ability: MobileAbilityCard;
  calibration: MobileCalibrationCard;
  verdict: MobileVerdict;
  nextSession: MobileNextSession;
  recovery: MobileRecoveryBreakdown;
  postRun: MobilePostRunVerdict | null;
  weekStructure: MobileWeekStructure;
  race: MobileRaceCard;
  injuryFlags: MobileInjuryFlag[];
  weekPlan: MobileWeekPlanDay[];
  /** Previous seven completed Asia/Shanghai days; no inferred missed days or adherence denominator. */
  recentPlanExecution?: MobilePlanExecutionDay[];
  phase: MobileDayPhase;
  lock: MobileLockState;
}

/** Aggregated payload for the iOS statistics page. */
export interface MobileStatisticsResponse {
  generatedAt: string;
  timezone: string;
  /** Last 3 calendar months (current month included), newest last. */
  months: Array<{
    month: string;
    runningDistanceKm: number;
    cyclingDistanceKm: number;
    otherDistanceKm: number;
    totalDistanceKm: number;
    durationSeconds: number;
    workoutCount: number;
  }>;
  totals: {
    distanceKm: number;
    durationSeconds: number;
    workoutCount: number;
    averagePaceSecondsPerKm: number | null;
    distanceChangeFraction: number | null;
  };
  heartRateZones: Array<{ zone: string; durationSeconds: number; fraction: number }>;
}

/** Aggregated payload for the iOS trends page. */
export interface MobileTrendsResponse {
  generatedAt: string;
  timezone: string;
  /** Last 12 ISO weeks (current week included), oldest first. */
  weeks: Array<{
    periodStart: string;
    periodEnd: string;
    distanceKm: number;
    workoutCount: number;
    isComplete: boolean;
  }>;
  /** Total distance of the last 4 weeks vs the previous 4 weeks. */
  distanceChangeFraction4Weeks: number | null;
  records: {
    fastest5k: { distanceKm: number; paceSecondsPerKm: number; startedAt: string } | null;
    fastest10k: { distanceKm: number; paceSecondsPerKm: number; startedAt: string } | null;
    longestDistance: { distanceKm: number; startedAt: string } | null;
    biggestMonth: { month: string; distanceKm: number } | null;
  };
  insights: Array<{ kind: "positive" | "warning"; title: string; detail: string }>;
  ability: Array<{
    date: string;
    trueAbility: number | null;
    decayPoints: number;
    growthVelocityPerWeek: number | null;
    status: string;
  }>;
  currentAbility: Array<{
    id: string;
    date: string;
    currentAbility: number | null;
    confidence: number | null;
    assessmentStatus: string;
    distanceKm: number | null;
  }>;
  growthVelocityPerWeek: number | null;
  decayPoints: number;
}

/** Weekly training goals persisted server-side for the iOS settings page. */
export interface MobileGoalsResponse {
  revision: number;
  weeklyDistanceKm: number;
  easyDurationFloorFraction: number;
  qualitySessionCap: number;
  raceTarget: MobileRaceTarget | null;
  weekPlan: MobilePlannedDay[];
  lockedSession: MobileLockedSession | null;
  /** Audit trail of the last weekly plan generation. */
  weekPlanAudit: MobilePlanAudit | null;
  updatedAt: string;
}

export interface UpdateMobileGoalsInput {
  expectedRevision?: number;
  weeklyDistanceKm: number;
  easyDurationFloorFraction?: number;
  qualitySessionCap?: number;
  raceTarget?: MobileRaceTarget | null;
  weekPlan?: MobilePlannedDay[];
  lockedSession?: MobileLockedSession | null;
  weekPlanAudit?: MobilePlanAudit | null;
}

export interface WorkoutSplit {
  index: number;
  distanceMeters: number;
  durationSeconds: number;
  averagePaceSecondsPerKm: number;
  averageHeartRateBpm: number | null;
  averageCadenceSpm: number | null;
}

/**
 * One executed segment of a run.
 *
 * Two producers feed this, in order of authority:
 * 1. the Watch's own `HKWorkoutEvent` lap/segment boundaries — exactly what the
 *    Fitness app renders as 间歇;
 * 2. the stored weekly plan, replayed onto the measured speed track when the run
 *    carries no event boundary.
 *
 * The trailing stretch no plan step covered is emitted as a single
 * `purpose: "unplanned"` segment rather than being hidden.
 */
export type WorkoutSegmentPurpose = MobileStepPurpose | "unplanned";

export interface WorkoutSegment {
  index: number;
  label: string;
  purpose: WorkoutSegmentPurpose;
  goalType: MobileStepGoal["type"] | null;
  goalMeters: number | null;
  goalSeconds: number | null;
  alertKind: MobileStepAlert["kind"] | null;
  alertLower: number | null;
  alertUpper: number | null;
  startOffsetSeconds: number;
  durationSeconds: number;
  distanceMeters: number;
  averagePaceSecondsPerKm: number | null;
  averageHeartRateBpm: number | null;
  averageCadenceSpm: number | null;
}

/** Which stored plan day a run was matched to, and how confidently. */
export interface WorkoutSegmentPlanMatch {
  localDate: string;
  kind: MobileSessionKind;
  revision: number;
  matchedBy: "push_record" | "plan_history";
  plannedDistanceKm: number | null;
  /** Share of the run's duration explained by plan steps (0–1). */
  explainedFraction: number;
  reason: string;
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
