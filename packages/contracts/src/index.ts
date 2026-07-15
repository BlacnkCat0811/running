export const CONTRACT_VERSION = "canonical-health-v2" as const;

export const healthTypes = {
  activeEnergy: "HKQuantityTypeIdentifierActiveEnergyBurned",
  distanceWalkingRunning: "HKQuantityTypeIdentifierDistanceWalkingRunning",
  heartRate: "HKQuantityTypeIdentifierHeartRate",
  heartRateRecoveryOneMinute:
    "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",
  hrvSdnn: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  physicalEffort: "HKQuantityTypeIdentifierPhysicalEffort",
  restingHeartRate: "HKQuantityTypeIdentifierRestingHeartRate",
  runningGroundContactTime:
    "HKQuantityTypeIdentifierRunningGroundContactTime",
  runningPower: "HKQuantityTypeIdentifierRunningPower",
  runningSpeed: "HKQuantityTypeIdentifierRunningSpeed",
  runningStrideLength: "HKQuantityTypeIdentifierRunningStrideLength",
  runningVerticalOscillation:
    "HKQuantityTypeIdentifierRunningVerticalOscillation",
  sleepAnalysis: "HKCategoryTypeIdentifierSleepAnalysis",
  stepCount: "HKQuantityTypeIdentifierStepCount",
  vo2Max: "HKQuantityTypeIdentifierVO2Max"
} as const;

export const workoutTypes = {
  running: "HKWorkoutActivityTypeRunning"
} as const;

export type MetadataMap = Record<string, string[]>;

export interface CanonicalHealthRecord {
  id: string;
  type: string;
  sourceName: string;
  sourceVersion: string | null;
  device: string | null;
  unit: string | null;
  numericValue: number | null;
  textValue: string | null;
  startAt: string;
  endAt: string;
  createdAt: string | null;
  metadata: MetadataMap;
}

export interface CanonicalWorkoutStatistic {
  type: string;
  startAt: string | null;
  endAt: string | null;
  unit: string | null;
  sum: number | null;
  average: number | null;
  minimum: number | null;
  maximum: number | null;
}

export interface CanonicalWorkoutEvent {
  type: string;
  date: string | null;
  durationSeconds: number | null;
  metadata: MetadataMap;
}

export interface CanonicalRouteReference {
  id: string;
  sourceName: string | null;
  sourceVersion: string | null;
  startAt: string | null;
  endAt: string | null;
  createdAt: string | null;
  relativePath: string | null;
  metadata: MetadataMap;
}

export interface CanonicalWorkout {
  id: string;
  activityType: string;
  sourceName: string;
  sourceVersion: string | null;
  device: string | null;
  startAt: string;
  endAt: string;
  createdAt: string | null;
  durationSeconds: number;
  indoor: boolean | null;
  metadata: MetadataMap;
  statistics: CanonicalWorkoutStatistic[];
  events: CanonicalWorkoutEvent[];
  routes: CanonicalRouteReference[];
}

export interface RoutePoint {
  sequence: number;
  timestamp: string | null;
  latitude: number;
  longitude: number;
  elevationMeters: number | null;
  speedMetersPerSecond: number | null;
  courseDegrees: number | null;
  horizontalAccuracyMeters: number | null;
  verticalAccuracyMeters: number | null;
}

export interface ImportIssue {
  severity: "warning" | "error";
  code: string;
  objectId: string | null;
  message: string;
}

export const FEATURE_SCHEMA_VERSION = "workout-feature-v3" as const;

export const sessionTypes = [
  "unknown",
  "recovery",
  "easy",
  "steady",
  "tempo",
  "interval",
  "long_run",
  "race"
] as const;

export type SessionType = (typeof sessionTypes)[number];

export const heartRateZones = [
  "recovery",
  "aerobic_base",
  "aerobic_power",
  "lactate_threshold",
  "anaerobic"
] as const;
export type HeartRateZone = (typeof heartRateZones)[number];

export const paceZones = [
  "easy",
  "marathon",
  "lactate_threshold",
  "anaerobic_endurance",
  "sprint"
] as const;
export type PaceZone = (typeof paceZones)[number];

export const stimulusTypes = [
  "recovery",
  "aerobic_base",
  "marathon_pace",
  "lactate_threshold",
  "vo2max",
  "anaerobic_endurance",
  "unclassified"
] as const;
export type StimulusType = (typeof stimulusTypes)[number];

export type ZoneValueSource = "automatic" | "manual" | "fallback" | "carried_forward";
export type ZoneProfileStatus = "stable" | "provisional" | "fallback";

export interface HeartRateZoneBand {
  zone: HeartRateZone;
  lowerReserveFraction: number | null;
  upperReserveFraction: number | null;
  lowerBpm: number | null;
  upperBpm: number | null;
}

export interface PaceZoneBand {
  zone: PaceZone;
  lowerSecondsPerKm: number | null;
  upperSecondsPerKm: number | null;
}

export interface DailyZoneProfile {
  id: string;
  localDate: string;
  timezoneIdentifier: string;
  effectiveAt: string;
  dataThroughAt: string | null;
  restingHeartRateBpm: number;
  maximumHeartRateBpm: number;
  lactateThresholdPaceSecondsPerKm: number | null;
  heartRateSource: ZoneValueSource;
  paceSource: ZoneValueSource;
  heartRateConfidence: number;
  paceConfidence: number;
  status: ZoneProfileStatus;
  heartRateBands: HeartRateZoneBand[];
  paceBands: PaceZoneBand[];
  evidence: {
    restingHeartRateDays: number;
    maximumHeartRateWorkouts: number;
    thresholdEvidenceCount: number;
  };
  createdAt: string;
}

export interface ZoneExposure<TZone extends string> {
  zone: TZone;
  durationSeconds: number;
  distanceMeters: number;
  fraction: number;
}

export interface StimulusScore {
  stimulusType: Exclude<StimulusType, "unclassified">;
  qualifyingSeconds: number;
  targetSeconds: number;
  score: number;
  confidence: number;
}

export interface WorkoutZoneSummary {
  trainingSessionId: string;
  zoneProfileId: string;
  stimulusType: StimulusType;
  secondaryStimulusTypes: Exclude<StimulusType, "unclassified">[];
  stimulusConfidence: number;
  heartRateCoverage: number;
  paceCoverage: number;
  heartRateExposure: Array<ZoneExposure<HeartRateZone>>;
  paceExposure: Array<ZoneExposure<PaceZone>>;
  stimulusScores: StimulusScore[];
  explanationCodes: string[];
}

export interface TrainingLoadBreakdown {
  rawHrrTrimp: number | null;
  internalLoad: number | null;
  paceLoad: number | null;
  distanceReferenceMeters: number | null;
  distanceExposureRatio: number | null;
  distanceFactor: number;
  compositeLoad: number;
  heartRateConfidence: number;
  paceConfidence: number;
}

export interface TrainingZoneProfileSettings {
  revision: number;
  effectiveFromLocalDate: string;
  restingHeartRate: { mode: "auto" | "manual"; valueBpm: number | null };
  maximumHeartRate: { mode: "auto" | "manual"; valueBpm: number | null };
  lactateThresholdPace: { mode: "auto" | "manual"; valueSecondsPerKm: number | null };
  createdAt: string;
}

export interface TrainingZonesCurrentResponse {
  generatedAt: string;
  profile: DailyZoneProfile;
  settings: TrainingZoneProfileSettings;
  previousProfile: DailyZoneProfile | null;
}

export interface TrainingZonesHistoryResponse {
  generatedAt: string;
  profiles: DailyZoneProfile[];
}

export interface UpdateTrainingZoneProfileInput {
  expectedRevision: number;
  restingHeartRate: { mode: "auto" | "manual"; valueBpm: number | null };
  maximumHeartRate: { mode: "auto" | "manual"; valueBpm: number | null };
  lactateThresholdPace: { mode: "auto" | "manual"; valueSecondsPerKm: number | null };
}

export const TRAINING_ZONE_CONFIG_VERSION = "training-zone-config-v3" as const;
export const TRAINING_LOAD_CONFIG_VERSION = "training-load-config-v3" as const;

export type TrainingLoadSource =
  | "heart_rate_series"
  | "average_heart_rate"
  | "rpe"
  | "session_type";

export type TrainingStatusCode =
  | "insufficient_data"
  | "recovery"
  | "maintaining"
  | "effective_stimulus"
  | "high_load"
  | "attention";

export type TrainingStatisticsGranularity = "week" | "month" | "year";

export interface TrainingStatusExplanation {
  code: string;
  value: number | null;
  threshold: number | null;
}

export interface WorkoutTrainingLoad {
  trainingSessionId: string;
  localDate: string;
  distanceMeters: number | null;
  durationSeconds: number;
  load: number;
  intensity: number;
  source: TrainingLoadSource;
  confidence: number;
  rpe: number | null;
  sessionType: SessionType;
  averageHeartRate: number | null;
  elevationGainMeters: number | null;
  stimulusType: StimulusType;
  breakdown: TrainingLoadBreakdown;
  explanations: TrainingStatusExplanation[];
}

export interface DailyTrainingMetric {
  localDate: string;
  distanceMeters: number;
  durationSeconds: number;
  workoutCount: number;
  load: number;
  current7dLoad: number;
  previous7dLoad: number;
  acuteEwma: number;
  chronicEwma: number;
  loadRatio: number | null;
  rampRate: number;
  monotony: number | null;
  strain: number | null;
  recoveryEvidence: number | null;
  trainingStatus: TrainingStatusCode;
  statusExplanations: TrainingStatusExplanation[];
  loadConfidence: number | null;
}

export interface TrainingTypeDistribution {
  sessionType: SessionType;
  workoutCount: number;
  distanceMeters: number;
  load: number;
}

export interface StimulusTypeDistribution {
  stimulusType: StimulusType;
  workoutCount: number;
  distanceMeters: number;
  load: number;
}

export interface TrainingPeriodSummary {
  granularity: TrainingStatisticsGranularity | "rolling";
  periodStart: string;
  periodEnd: string;
  isComplete: boolean;
  distanceMeters: number;
  durationSeconds: number;
  workoutCount: number;
  totalLoad: number;
  elevationGainMeters: number;
  longestRunMeters: number;
  averagePaceSecondsPerKm: number | null;
  averageHeartRate: number | null;
  dataCompleteness: number;
  loadConfidence: number | null;
  typeDistribution: TrainingTypeDistribution[];
  stimulusDistribution: StimulusTypeDistribution[];
  comparison: {
    distanceChangeFraction: number | null;
    durationChangeFraction: number | null;
    workoutCountChangeFraction: number | null;
    loadChangeFraction: number | null;
  } | null;
}

export interface TrainingStatisticsOverviewResponse {
  generatedAt: string;
  timezone: string;
  status: DailyTrainingMetric | null;
  statusConfidence: number | null;
  week: TrainingPeriodSummary;
  month: TrainingPeriodSummary;
  year: TrainingPeriodSummary;
  rolling7Days: TrainingPeriodSummary;
  rolling28Days: TrainingPeriodSummary;
}

export interface TrainingStatisticsHistoryResponse {
  generatedAt: string;
  timezone: string;
  granularity: TrainingStatisticsGranularity;
  periods: TrainingPeriodSummary[];
}

export interface TrainingLoadTimelineResponse {
  generatedAt: string;
  timezone: string;
  days: DailyTrainingMetric[];
  components: Array<{
    localDate: string;
    internalLoad: number | null;
    paceLoad: number | null;
    compositeLoad: number;
  }>;
}
export type SessionTypeSource = "auto" | "override";
export const performanceProtocols = [
  "five_k_time_trial",
  "ten_k_time_trial",
  "thirty_min_threshold",
  "half_marathon_race",
  "other_race"
] as const;
export type PerformanceProtocol = (typeof performanceProtocols)[number];
export type EligibilityStatus = "eligible" | "trial" | "excluded";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RecomputeJobType = "import" | "full_recompute" | "snapshot_refresh";
export type TrainingSessionStatus = "active" | "inactive" | "ambiguous";

export const missingReasonCodes = [
  "distance_missing",
  "distance_below_1km",
  "duration_below_8min",
  "heart_rate_missing",
  "heart_rate_coverage_low",
  "route_missing",
  "route_quality_low",
  "indoor_workout",
  "indoor_status_unknown",
  "implausible_average_pace",
  "source_not_comparable",
  "session_ambiguous",
  "user_excluded",
  "recovery_data_missing"
] as const;

export type MissingReasonCode = (typeof missingReasonCodes)[number];

export const abilityExplanationCodes = [
  "calibrating",
  "data_insufficient",
  "efficiency_above_baseline",
  "efficiency_below_baseline",
  "pace_above_baseline",
  "pace_below_baseline",
  "cardio_above_baseline",
  "cardio_below_baseline",
  "stability_above_baseline",
  "stability_below_baseline",
  "recovery_low",
  "recovery_high",
  "fatigue_protected_negative_update",
  "low_confidence_no_true_ability_update",
  "user_excluded",
  "inactivity_decay"
] as const;

export type AbilityExplanationCode = (typeof abilityExplanationCodes)[number];

export interface TrainingSession {
  id: string;
  activityType: string;
  anchorStartAt: string;
  anchorEndAt: string;
  anchorDistanceKm: number | null;
  canonicalWorkoutId: string | null;
  status: TrainingSessionStatus;
}

export interface WorkoutFeatureSignals {
  efficiencyRaw: number | null;
  paceRawMetersPerSecond: number | null;
  cardioRaw: number | null;
  stabilityRaw: number | null;
  recoveryRaw: number | null;
  heartRateReserveFraction: number | null;
  heartRateCoefficientOfVariation: number | null;
  speedCoefficientOfVariation: number | null;
  sleepDurationMinutes: number | null;
  restingHeartRateBpm: number | null;
  hrvSdnnMs: number | null;
  recentLoadMinutes: number | null;
}

export interface WorkoutFeatureVector {
  id: string;
  featureRunId: string;
  trainingSessionId: string;
  canonicalWorkoutId: string;
  workoutStartAt: string;
  durationSeconds: number;
  distanceKm: number | null;
  averageSpeedMetersPerSecond: number | null;
  averageHeartRateBpm: number | null;
  heartRateSampleCount: number;
  heartRateCoverage: number | null;
  routePointCount: number;
  routeQuality: number | null;
  sourceConfidence: number;
  sessionType: SessionType;
  sessionTypeSource: SessionTypeSource;
  eligibilityStatus: EligibilityStatus;
  qualityScore: number;
  missingReasons: MissingReasonCode[];
  signals: WorkoutFeatureSignals;
  provenance: Record<string, unknown>;
  computedAt: string;
}

export interface FeatureRun {
  id: string;
  datasetVersion: string;
  canonicalContractVersion: string;
  featureSchemaVersion: string;
  featureConfig: Record<string, unknown>;
  featureConfigHash: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failure: Record<string, unknown> | null;
}

export interface ConfidenceFactors {
  coverage: number;
  source: number;
  comparability: number;
  maturity: number;
}

export interface AbilityDimensionScores {
  efficiency: number | null;
  pace: number | null;
  cardio: number | null;
  stability: number | null;
  recovery: number | null;
}

export interface AbilityAssessment {
  id: string;
  modelRunId: string;
  featureId: string;
  trainingSessionId: string;
  sequenceNumber: number;
  assessmentStatus: EligibilityStatus | "calibrating";
  currentAbility: number | null;
  dimensions: AbilityDimensionScores;
  effectiveWeights: Partial<Record<keyof AbilityDimensionScores, number>>;
  confidence: number;
  confidenceFactors: ConfidenceFactors;
  workoutContribution: number | null;
  evidenceStrength: number | null;
  directionFactor: number | null;
  growthResistance: number | null;
  trueAbilityBefore: number | null;
  trueAbilityAfter: number | null;
  trueAbilityDelta: number | null;
  updatedTrueAbility: boolean;
  explanationCodes: AbilityExplanationCode[];
  explanation: Record<string, unknown>;
  assessedAt: string;
}

export interface ModelRun {
  id: string;
  featureRunId: string;
  datasetVersion: string;
  modelVersion: string;
  modelConfig: Record<string, unknown>;
  modelConfigHash: string;
  evaluatedAt: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  summary: Record<string, unknown> | null;
  failure: Record<string, unknown> | null;
}

export interface DailyAbilitySnapshot {
  id: string;
  modelRunId: string;
  localDate: string;
  timezoneIdentifier: string;
  trueAbility: number | null;
  decayPoints: number;
  growthVelocityPerWeek: number | null;
  lastAssessmentId: string | null;
  snapshotStatus: "calibrating" | "active" | "decay" | "no_data";
  computedAt: string;
}

export interface WorkoutOverride {
  id: string;
  trainingSessionId: string;
  revision: number;
  eligibilityOverride: "include" | "exclude" | null;
  statisticsParticipation: "include" | "exclude" | null;
  sessionType: SessionType | null;
  performanceProtocol: PerformanceProtocol | null;
  rpe: number | null;
  conditionTags: string[];
  note: string | null;
  createdAt: string;
}

export interface RecomputeJob {
  id: string;
  jobType: RecomputeJobType;
  status: RunStatus;
  datasetVersion: string | null;
  featureRunId: string | null;
  modelRunId: string | null;
  request: Record<string, unknown>;
  progressPhase: string;
  progressCurrent: number;
  progressTotal: number;
  cancelRequested: boolean;
  error: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function assertFiniteOrNull(name: string, value: number | null): void {
  if (value !== null && !Number.isFinite(value)) {
    throw new Error(`${name} must be finite or null`);
  }
}

export function assertWorkoutFeatureVector(feature: WorkoutFeatureVector): void {
  if (!feature.id || !feature.featureRunId || !feature.trainingSessionId) {
    throw new Error("WorkoutFeatureVector requires stable identifiers");
  }
  if (feature.durationSeconds < 0 || !Number.isFinite(feature.durationSeconds)) {
    throw new Error("WorkoutFeatureVector durationSeconds must be a non-negative finite value");
  }
  if (feature.heartRateCoverage !== null && (feature.heartRateCoverage < 0 || feature.heartRateCoverage > 1)) {
    throw new Error("WorkoutFeatureVector heartRateCoverage must be between 0 and 1");
  }
  if (feature.sourceConfidence < 0 || feature.sourceConfidence > 1) {
    throw new Error("WorkoutFeatureVector sourceConfidence must be between 0 and 1");
  }
  if (feature.qualityScore < 0 || feature.qualityScore > 1) {
    throw new Error("WorkoutFeatureVector qualityScore must be between 0 and 1");
  }
  for (const [name, value] of Object.entries(feature.signals)) {
    assertFiniteOrNull(name, value);
  }
}

export const PHYSIOLOGY_PREDICTION_SCHEMA_VERSION = "physiology-prediction-v1" as const;

export const raceDistanceMeters = {
  five_k: 5_000,
  ten_k: 10_000,
  half_marathon: 21_097.5
} as const;

export type RaceDistance = keyof typeof raceDistanceMeters;
export type EstimateStatus = "available" | "insufficient_data";
export type PredictionConfidenceLevel = "low" | "moderate" | "high";

export const physiologyEvidenceCodes = [
  "apple_health_vo2max",
  "race_performance",
  "standard_test_performance",
  "time_trial_performance",
  "hard_workout_performance",
  "future_evidence_excluded",
  "stale_evidence",
  "evidence_disagreement",
  "single_source_only",
  "vo2_upper_prior",
  "training_performance_envelope",
  "performance_evidence_missing",
  "performance_vo2_gap",
  "performance_environment_normalized",
  "lactate_threshold_one_hour_proxy",
  "lactate_threshold_hr_reserve_proxy",
  "sustained_threshold_segment",
  "threshold_test_segment",
  "race_threshold_segment",
  "threshold_evidence_disagreement",
  "threshold_segments_missing",
  "heart_rate_inputs_missing",
  "race_prediction_vdot_baseline",
  "endurance_readiness_unmodeled",
  "race_readiness_applied",
  "race_readiness_low",
  "heat_humidity_adjustment",
  "elevation_adjustment",
  "fatigue_adjustment",
  "standard_conditions",
  "walk_forward_bias_calibration",
  "ridge_residual_model",
  "catboost_residual_model"
] as const;

export type PhysiologyEvidenceCode = (typeof physiologyEvidenceCodes)[number];

export interface NumericEstimateRange {
  lower: number;
  upper: number;
}

export interface Vo2MaxEstimate {
  status: EstimateStatus;
  valueMlKgMin: number | null;
  rangeMlKgMin: NumericEstimateRange | null;
  confidence: number;
  confidenceLevel: PredictionConfidenceLevel;
  evidenceCount: number;
  latestEvidenceAt: string | null;
  method: "robust_evidence_ensemble_v1";
  evidenceCodes: PhysiologyEvidenceCode[];
}

export interface PerformanceVdotEstimate {
  status: EstimateStatus;
  value: number | null;
  range: NumericEstimateRange | null;
  confidence: number;
  confidenceLevel: PredictionConfidenceLevel;
  evidenceCount: number;
  latestEvidenceAt: string | null;
  method: "performance_envelope_v1";
  evidenceCodes: PhysiologyEvidenceCode[];
}

export interface LactateThresholdEstimate {
  status: EstimateStatus;
  paceSecondsPerKm: number | null;
  paceRangeSecondsPerKm: NumericEstimateRange | null;
  heartRateBpm: number | null;
  heartRateRangeBpm: NumericEstimateRange | null;
  confidence: number;
  confidenceLevel: PredictionConfidenceLevel;
  evidenceCount: number;
  latestEvidenceAt: string | null;
  method: "vdot_one_hour_proxy_v1" | "multi_evidence_threshold_v2";
  evidenceCodes: PhysiologyEvidenceCode[];
}

export interface RaceTimePrediction {
  distance: RaceDistance;
  distanceMeters: number;
  status: EstimateStatus;
  potentialSeconds: number | null;
  predictedSeconds: number | null;
  readinessAdjustmentSeconds: number | null;
  environmentAdjustmentSeconds: number | null;
  elevationAdjustmentSeconds: number | null;
  fatigueAdjustmentSeconds: number | null;
  calibrationAdjustmentSeconds: number | null;
  machineLearningAdjustmentSeconds: number | null;
  machineLearningFallbackReason:
    | "no_active_model"
    | "unsupported_distance"
    | "inference_failed"
    | "feature_schema_mismatch"
    | null;
  optimisticSeconds: number | null;
  pessimisticSeconds: number | null;
  readiness: number | null;
  confidence: number;
  confidenceLevel: PredictionConfidenceLevel;
  method:
    | "daniels_vdot_v1"
    | "daniels_vdot_readiness_v2"
    | "daniels_vdot_conditions_v3"
    | "bias_calibrated_v4"
    | "ridge_ensemble_v5"
    | "catboost_residual_v6";
  evidenceCodes: PhysiologyEvidenceCode[];
}

export interface PhysiologyPredictionSnapshot {
  schemaVersion: typeof PHYSIOLOGY_PREDICTION_SCHEMA_VERSION;
  modelVersion: string;
  generatedAt: string;
  dataThroughAt: string | null;
  vo2Max: Vo2MaxEstimate;
  performanceVdot: PerformanceVdotEstimate;
  lactateThreshold: LactateThresholdEstimate;
  races: RaceTimePrediction[];
  disclaimer: string;
}

export const PHYSIOLOGY_REPORT_VERSION = "rai-physiology-report-v2" as const;

export type PhysiologyGuidanceCode =
  | "direct_vo2_evidence_missing"
  | "standard_test_missing"
  | "threshold_segments_missing"
  | "prediction_confidence_low";

export interface PhysiologyPredictionScenario {
  temperatureC: number | null;
  humidityPercent: number | null;
  elevationGainMeters: Record<RaceDistance, number | null>;
}

export interface PredictionEnhancementSelection {
  biasCalibration: {
    status: "inactive" | "available";
    historicalOutcomeCount: number;
    eligibleOutcomeCountByDistance: Record<RaceDistance, number>;
    appliedDistances: RaceDistance[];
  };
  machineLearning: {
    status: "insufficient_samples" | "keep_formula_baseline" | "active";
    modelVersion: "race-residual-ridge-v1" | "race-residual-catboost-v1" | null;
    trainedExampleCount: number;
    evaluatedOutcomeCount: number;
    meanAbsoluteErrorImprovement: number | null;
    regressesAnyDistanceByMoreThan5Percent: boolean;
    activeModelRunId: string | null;
    activeModelVersion: string | null;
    featureSchemaVersion: string | null;
    artifactSha256: string | null;
    activatedAt: string | null;
  };
}

export interface PhysiologyPredictionReport {
  reportVersion: typeof PHYSIOLOGY_REPORT_VERSION;
  generatedAt: string;
  inputs: {
    directVo2Evidence: number;
    labeledPerformanceEvidence: number;
    lactateThresholdSegments: number;
    performanceVdotEvidence: number;
    labeledRaceOutcomes: number;
    readiness: Record<RaceDistance, number>;
    recoveryReadiness: number;
    scenario: PhysiologyPredictionScenario;
    profile: {
      restingHeartRateBpm: number | null;
      observedMaximumHeartRateBpm: number | null;
    };
  };
  modelSelection: PredictionEnhancementSelection;
  guidanceCodes: PhysiologyGuidanceCode[];
  snapshot: PhysiologyPredictionSnapshot;
}

export interface RacePredictionError {
  distance: RaceDistance;
  predictionGeneratedAt: string;
  outcomeAt: string;
  predictedSeconds: number;
  actualSeconds: number;
  signedErrorSeconds: number;
  absoluteErrorSeconds: number;
  absolutePercentageError: number;
  intervalCovered: boolean | null;
}

export interface RacePredictionMetrics {
  sampleCount: number;
  meanAbsoluteErrorSeconds: number | null;
  rootMeanSquaredErrorSeconds: number | null;
  meanAbsolutePercentageError: number | null;
  meanSignedErrorSeconds: number | null;
  intervalCoverage: number | null;
}

export const PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION =
  "race-residual-feature-v2" as const;
export const predictionResidualFeatureNames = [
  "logPredictedSeconds", "readiness", "conditionAdjustmentFraction",
  "performanceVdot", "vo2Max", "vo2Gap", "lactateThresholdPaceSecondsPerKm",
  "lactateThresholdConfidence", "recoveryReadiness", "weeklyDistance4wKm",
  "weeklyDistance8wKm", "longestRun8wKm", "runFrequency4wPerWeek",
  "targetDistanceExposure8w", "daysSinceLastRun", "acuteChronicLoadRatio",
  "temperatureC", "humidityPercent", "elevationGainMeters",
  "directVo2EvidenceCount", "thresholdEvidenceCount",
  "performanceVdotEvidenceCount", "overallDataQuality"
] as const;
export const predictionResidualOnnxFeatureNames = [
  ...predictionResidualFeatureNames,
  "isFiveK", "isTenK", "isHalfMarathon"
] as const;
export const predictionResidualFeatureSchema = {
  distanceEncoding: {
    five_k: "isFiveK",
    half_marathon: "isHalfMarathon",
    ten_k: "isTenK"
  },
  featureNames: predictionResidualOnnxFeatureNames,
  featureSemantics: {
    acuteChronicLoadRatio:
      "active composite daily training load; 7-day/28-day half-life EWMA ratio through asOf"
  },
  featureSchemaVersion: PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
  inputDtype: "float32",
  inputShape: ["N", predictionResidualOnnxFeatureNames.length],
  missingValue: "NaN",
  outputDtype: "float32",
  outputSemantics: "targetLogResidual=log(actualSeconds/baselinePredictedSeconds)",
  outputShape: ["N", 1]
} as const;
export const PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH =
  "77a352b9035b68c584bd2b6147fc1156c22423ffa806b0da42462afd2b10dfb2" as const;
export const CATBOOST_PREDICTION_MODEL_VERSION =
  "race-residual-catboost-v1" as const;

export const predictionModelRunStatuses = [
  "queued",
  "running",
  "validating",
  "succeeded",
  "rejected",
  "failed",
  "cancelled"
] as const;

export type PredictionModelRunStatus =
  (typeof predictionModelRunStatuses)[number];

export interface PredictionModelDistanceMetrics {
  sampleCount: number;
  baselineMaeSeconds: number | null;
  modelMaeSeconds: number | null;
  maeImprovement: number | null;
}

export interface PredictionModelEvaluationMetrics {
  baselineMaeSeconds: number;
  modelMaeSeconds: number;
  maeImprovement: number;
  intervalCoverageChange: number;
  regressesAnyDistanceByMoreThan5Percent: boolean;
  onnxMaximumAbsoluteError: number;
  byDistance: Record<RaceDistance, PredictionModelDistanceMetrics>;
}

export interface PredictionModelRun {
  id: string;
  algorithm: "catboost";
  modelVersion: string;
  featureSchemaVersion: string;
  featureSchemaHash: string | null;
  trainingDataHash: string | null;
  trainingDataThroughAt: string;
  hyperparameters: Record<string, unknown>;
  status: PredictionModelRunStatus;
  labelCount: number;
  labelCountByDistance: Record<RaceDistance, number>;
  holdoutPredictionCount: number;
  metrics: PredictionModelEvaluationMetrics | null;
  supportedDistances: RaceDistance[];
  artifactPath: string | null;
  artifactSha256: string | null;
  cancelRequested: boolean;
  failure: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  activatedAt: string | null;
  active: boolean;
}

export interface PredictionModelEvent {
  id: string;
  predictionModelRunId: string;
  phase: string;
  progressCurrent: number;
  progressTotal: number;
  message: string;
  createdAt: string;
}

export interface PredictionModelTrainingRequest {
  runId: string;
  asOf: string;
  databasePath: string;
  artifactDirectory: string;
}

export interface PredictionModelTrainingResult {
  featureSchemaHash: string;
  trainingDataHash: string;
  labelCount: number;
  labelCountByDistance: Record<RaceDistance, number>;
  holdoutPredictionCount: number;
  metrics: PredictionModelEvaluationMetrics;
  supportedDistances: RaceDistance[];
  artifactPath: string;
  artifactSha256: string;
}

export function assertPhysiologyPredictionSnapshot(
  snapshot: PhysiologyPredictionSnapshot
): void {
  if (snapshot.schemaVersion !== PHYSIOLOGY_PREDICTION_SCHEMA_VERSION) {
    throw new Error("Unexpected physiology prediction schema version");
  }
  if (!snapshot.modelVersion || !snapshot.generatedAt) {
    throw new Error("Physiology prediction requires modelVersion and generatedAt");
  }
  const confidenceValues = [
    snapshot.vo2Max.confidence,
    snapshot.performanceVdot.confidence,
    snapshot.lactateThreshold.confidence,
    ...snapshot.races.map((prediction) => prediction.confidence)
  ];
  for (const confidence of confidenceValues) {
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("Prediction confidence must be between 0 and 1");
    }
  }
  for (const prediction of snapshot.races) {
    if (prediction.distanceMeters !== raceDistanceMeters[prediction.distance]) {
      throw new Error("Race prediction distance does not match its contract key");
    }
    const seconds = [prediction.potentialSeconds, prediction.predictedSeconds,
      prediction.optimisticSeconds, prediction.pessimisticSeconds];
    if (seconds.some((value) => value !== null && (!Number.isFinite(value) || value <= 0))) {
      throw new Error("Race prediction times must be finite and positive");
    }
    if (prediction.status === "available" && seconds.some((value) => value === null)) {
      throw new Error("Available race predictions require complete time estimates");
    }
    if (prediction.optimisticSeconds !== null && prediction.predictedSeconds !== null &&
        prediction.pessimisticSeconds !== null &&
        !(prediction.optimisticSeconds <= prediction.predictedSeconds &&
          prediction.predictedSeconds <= prediction.pessimisticSeconds)) {
      throw new Error("Race prediction interval must contain the point estimate");
    }
    const adjustments = [
      prediction.readinessAdjustmentSeconds,
      prediction.environmentAdjustmentSeconds,
      prediction.elevationAdjustmentSeconds,
      prediction.fatigueAdjustmentSeconds,
      prediction.calibrationAdjustmentSeconds,
      prediction.machineLearningAdjustmentSeconds
    ];
    if (adjustments.some((value) => value !== null && !Number.isFinite(value))) {
      throw new Error("Race prediction adjustments must be finite");
    }
    if (prediction.readiness !== null &&
        (!Number.isFinite(prediction.readiness) || prediction.readiness < 0 || prediction.readiness > 1)) {
      throw new Error("Race prediction readiness must be between 0 and 1");
    }
  }

  const assertRange = (name: string, range: NumericEstimateRange | null): void => {
    if (range !== null && (!Number.isFinite(range.lower) || !Number.isFinite(range.upper) ||
        range.lower > range.upper)) throw new Error(`${name} range is invalid`);
  };
  const assertAvailable = (name: string, status: EstimateStatus, values: Array<number | null>): void => {
    if (values.some((value) => value !== null && !Number.isFinite(value))) {
      throw new Error(`${name} estimate must be finite`);
    }
    if (status === "available" && values.some((value) => value === null)) {
      throw new Error(`Available ${name} estimate is incomplete`);
    }
  };
  assertRange("VO2 max", snapshot.vo2Max.rangeMlKgMin);
  assertRange("performance VDOT", snapshot.performanceVdot.range);
  assertRange("lactate threshold pace", snapshot.lactateThreshold.paceRangeSecondsPerKm);
  assertRange("lactate threshold heart rate", snapshot.lactateThreshold.heartRateRangeBpm);
  assertAvailable("VO2 max", snapshot.vo2Max.status, [
    snapshot.vo2Max.valueMlKgMin,
    snapshot.vo2Max.rangeMlKgMin?.lower ?? null,
    snapshot.vo2Max.rangeMlKgMin?.upper ?? null
  ]);
  assertAvailable("performance VDOT", snapshot.performanceVdot.status, [
    snapshot.performanceVdot.value,
    snapshot.performanceVdot.range?.lower ?? null,
    snapshot.performanceVdot.range?.upper ?? null
  ]);
  assertAvailable("lactate threshold", snapshot.lactateThreshold.status, [
    snapshot.lactateThreshold.paceSecondsPerKm,
    snapshot.lactateThreshold.paceRangeSecondsPerKm?.lower ?? null,
    snapshot.lactateThreshold.paceRangeSecondsPerKm?.upper ?? null
  ]);
}
