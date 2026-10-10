export type {
  PhysiologyPredictionReport as PredictionResponse,
  PhysiologyPredictionScenario as PredictionScenario,
  PhysiologyGuidanceCode,
  PredictionExplainability,
  PredictionReadinessExplainability,
  PredictionRecoveryExplainability,
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
  TrainingLoadTimelineDay,
  TrainingFormStatus,
  RecoveryTimeEstimate,
  HeartRateZone,
  PaceZone,
  StimulusType,
  DailyZoneProfile,
  WorkoutZoneSummary,
  TrainingLoadBreakdown,
  WorkoutEnvironmentView,
  EnvironmentViewStatus,
  WorkoutSplitGrade,
  WorkoutGradeSummary,
  RunningDynamicsAnalysis,
  RunningDynamicsFlag,
  RunningDynamicsMetricAnalysis,
  RunningDynamicsMetricName,
  RunningDynamicsMetricStatus,
  PerformanceEntry,
  PredictionModelScope,
  PerformanceEntryDistance,
  ShareCardResponse,
  ShareCardRoutePoint,
  TrainingZoneProfileSettings,
  TrainingZonesCurrentResponse,
  TrainingZonesHistoryResponse,
  UpdateTrainingZoneProfileInput
} from "@rai/contracts";

// 域快照的窄化读取：信封（`ModelSnapshotEntry.payload`）是 `unknown`，消费方（含 web）
// 必须走这一组函数，而不是自己断言 payload 形状 —— 否则会去读产出端没写过的字段。
export {
  readFitnessSnapshot,
  readLoadSnapshot,
  readReadinessSnapshot,
  type FitnessSnapshot,
  type FitnessSnapshotDailyPoint,
  type LoadSnapshot,
  type ReadinessSnapshotView
} from "@rai/contracts";

import type {
  MobileSessionKind,
  PredictionModelEvent,
  PredictionModelRun,
  PredictionModelRunStatus,
  PredictionModelScope,
  RecoveryTimeEstimate,
  RunningDynamicsAnalysis,
  RunningDynamicsFlag,
  RunningDynamicsMetricAnalysis,
  RunningDynamicsMetricName,
  RunningDynamicsMetricStatus,
  ShareCardResponse,
  ShareCardRoutePoint,
  WorkoutEnvironmentView,
  WorkoutGradeSummary,
  WorkoutSplitGrade,
  WorkoutTrainingLoad,
  WorkoutZoneSummary
} from "@rai/contracts";

export interface TrainPredictionModelRequest {
  /**
   * §12.12 训练范围。缺省 `population`：老客户端不会因为这次升级而拿到更低的门槛，
   * 而个人范围需要显式请求 —— 它训练出来的是**一个人**的模型，必须能被认出来。
   */
  scope?: PredictionModelScope;
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
  /** §12.12 拒绝时实际采用的门槛范围；个人请求不该被告知需要人群的 50 条。 */
  scope?: PredictionModelScope;
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
  /** Typed record UUID deltas; additive capability, not a change of dataset scope. */
  healthKitRecordSyncVersion?: number;
  /** /synced accepts UUID/time/idempotency/export metadata. Older servers omit it. */
  planReceiptMetadata?: boolean;
  planSnapshotContractVersion?: number;
  /** Opt-in coach-loop aggregate/commands; legacy plan DTOs retain their meaning. */
  coachLoopContractVersion?: number;
  planPublicationContractVersion?: number;
  planReceiptContractVersion?: number;
}

export interface MobilePlanOperationScope {
  serverId: string;
  athleteId: string;
  datasetEpoch: string;
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
  /**
   * 产出这个运行所用的**引擎**版本。`modelVersion` 是**配置**版本，两者此前被混为一谈。
   * `null` 表示未知（v24 之前落库的行）——消费方必须显示为未知，
   * **不得**回退成当前引擎版本。
   */
  engineVersion: string | null;
  active: boolean;
}

export interface AbilityMetricSet {
  efficiency: number | null;
  pace: number | null;
  cardio: number | null;
  stability: number | null;
  recovery: number | null;
}

/** Domains a published V2 release seals a snapshot for. */
export type ModelSnapshotDomain = "fitness" | "readiness" | "durability" | "load" | "zones";

/**
 * One sealed domain snapshot as served by `/v1/model-snapshots`.
 *
 * `payload` is deliberately `unknown`: every domain stores a different shape
 * (`fitness` carries `{lineage, assessments, daily}`, `load` carries `{lineage, days}`,
 * `durability` carries an array of per-distance snapshots, ...) and a legacy run stores
 * an entirely different `{assessments, daily}`. Declaring one narrow payload shape here
 * would be a contract lie that lets consumers read fields that the producing branch never
 * wrote — exactly the cross-boundary drift this envelope exists to prevent. Narrow the
 * payload against the producing writer, not against this type.
 */
export interface ModelSnapshotEntry {
  domain: ModelSnapshotDomain | string;
  key: string;
  asOf: string;
  payload: unknown;
}

interface ModelSnapshotRunIdentity {
  runId: string | null;
  snapshots: ModelSnapshotEntry[];
}

/**
 * Response of `/v1/model-snapshots`.
 *
 * `status` is a refusal code as much as a state, and the branches are not
 * interchangeable: `not_published` has no run at all, `not_found` names a run that does
 * not exist, and `legacy` means the run predates the V2 release bundle so its snapshot is
 * a compatibility read rather than sealed evidence. Consumers that need V2 evidence must
 * check for `available`/`candidate` instead of testing `snapshots.length`.
 */
export type ModelSnapshotsResponse =
  | ({ status: "not_published"; runId: null } & ModelSnapshotRunIdentity)
  | ({ status: "not_found" } & ModelSnapshotRunIdentity)
  | ({ status: "legacy"; runId: string; active: boolean; asOf: string } & ModelSnapshotRunIdentity)
  | ({ status: "available" | "candidate"; runId: string; active: boolean; asOf: string } & ModelSnapshotRunIdentity);

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
    /**
     * Environment read-out for this run (docs/ALGORITHM.md §5). `null` only when
     * the run has no distance/duration to normalise against; a capture that
     * carried no weather is `status: "unavailable"` with the missing fields named,
     * never a zero penalty that looks like reference conditions.
     */
    environment: WorkoutEnvironmentView | null;
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
    baselineEpochId?: string | null;
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
  /** Required by current clients; omission is legacy compatibility only. */
  expectedRevision?: number;
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
  /**
   * Availability of the §5 environment fields across canonical workouts, parsed
   * with the production parser (a key that exists but cannot be read is not
   * available). It answers "is there anything to correct?" before any fitted
   * correction is proposed.
   */
  environment: {
    workouts: number;
    temperatureC: number;
    humidityPercent: number;
    elevationGainMeters: number;
    /** All three present: the only rows the condition adapter can correct. */
    complete: number;
  };
  issues: Array<{ severity: string; code: string; count: number }>;
}

export interface WorkoutSeriesResponse {
  trainingSessionId: string;
  startedAt: string;
  endedAt: string;
  sourceCategory: string;
  splits: WorkoutSplit[];
  /** Distance-weighted grade-adjusted pace across the covered splits. */
  grade: WorkoutGradeSummary | null;
  /**
   * §19 stride read-out: coverage, speed-matched half-split drift and flags.
   * Device estimates, display-only — never an input to CA/TA.
   */
  dynamics: RunningDynamicsAnalysis;
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

/**
 * §13.3：Coach 决策的版本化输出。
 *
 * 实测（2026-09-30 独立审计）：在本次改动之前，**全仓不存在任何 Coach 版本常量，
 * 也不存在版本化的决策输出类型** —— 唯一的决策形状是无版本字段的 `MobileVerdict`。
 * 版本矩阵把 Coach 标为"未落地（工程项）"，这一项就是它。
 *
 * 它与 `MobileVerdict` 的关系是**同一次决策的两个投影**，不是两次计算：
 * `tone` / `reasons` 直接来自 `MobileVerdict`，`action` 来自决策自身报告的
 * `CoachPlanDisposition`（分支在哪一步被选中，就由那一步报告），
 * 所以这里不重算任何阈值（§13.4 的"再从原始 ratio 独立分支"禁令）。
 */
export const COACH_MODEL_VERSION = "rai-coach-v2.0.0" as const;

/**
 * §13.3 的动作枚举。**它是一个投影标签，不是第二套判定。**
 *
 * 取值集合比方案草图窄，这是 2026-09-30 一次 829,440 组输入的扫描结论：
 * 六值是一组**相对于计划的动词**（保留/削减某份已保存的计划），
 * 而 Coach 的实际结果空间是 (tone) × (处方课型) × (有没有计划) × (九种分支)。
 * 扫描确认枚举**无法**被补成全的，具体缺口：
 * - "今天没有计划" —— 用 `action: null` + `no_stored_plan_today` 如实表达（不硬填）。
 * - "无计划 + green + 质量窗口" —— Coach 会**新建**一节 tempo/interval 课。
 *   "新建"既不是保留也不是削减，却是它最有行动力的输出。当前同样落 `null`。
 * - "削减的是量而不是时长" —— taper 与周预算钳制砍的都是距离，
 *   枚举里没有 `reduce_volume`，只能用最接近的 `reduce_duration`。
 * - "主动恢复跑" —— 没有 recovery 成员，落在 `easy_only`。
 * 这四条**不**通过新造枚举值来掩盖：它们是方案草图的缺口，记在这里等 §13.3 定夺。
 */
export type CoachAction =
  | "keep_plan"
  | "reduce_intensity"
  | "reduce_duration"
  | "easy_only"
  | "rest"
  | "collect_evidence";

export interface CoachDecisionV2 {
  version: typeof COACH_MODEL_VERSION;
  /** 产出这条决策的发布单元。没有发布记录时是显式占位，不编造 id。 */
  bundleId: string;
  tone: MobileVerdictTone;
  /**
   * 🔴 **允许为 null，这是刻意的偏离**：方案草图的六值枚举**无法**表达
   * "今天没有已保存的计划"——那既不是 keep_plan（没有计划可保留），
   * 也不是 reduce_*（没有东西可降）。
   *
   * 判据以 `reasons` 里的 `no_stored_plan_today` 为准，**不要**用 `action === null` 反推
   * "有没有计划"：比赛日留白在没有任何周计划时也返回 `keep_plan`（比赛本身就是承诺），
   * 所以 null 是"无计划**且**没有别的可说的动作"的合取，不是"无计划"的充要条件。
   * 这是 2026-09-30 的一次扫描（829,440 组输入）发现的自相矛盾之处，已按事实修正。
   */
  action: CoachAction | null;
  reasons: Array<{ code: string; params: Record<string, string | number | null> }>;
  /** 本次决策实际消费的快照身份。取不到的类别不出现，不写空串占位。 */
  inputSnapshotIds: string[];
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
 * `CustomWorkout(warmup:blocks:cooldown:)` so that the coach and manual plans
 * use the same structure without device-side mapping logic.
 */
export interface MobileSessionStructure {
  warmup: MobileWorkoutStep | null;
  blocks: MobileIntervalBlock[];
  cooldown: MobileWorkoutStep | null;
}

/** Plan provenance. `llm` remains readable only for legacy plans and history. */
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
  windowStart?: string;
  windowEnd?: string;
  generatedAt: string;
  timezone: string;
  /** Number of days returned, starting today. */
  windowDays: number;
  planRevision: number;
  audit: MobilePlanAudit | null;
  days: MobileWorkoutPlanDay[];
}

export interface TrainingPlanStateResponse {
  metadata: {
    contractVersion: 1;
    serverId: string;
    athleteId: string;
    datasetEpoch: string;
    goalsRevision: number;
    coherenceToken: string;
    timezone: string;
    localDate: string;
    windowStart: string;
    windowEnd: string;
    ruleVersion: string;
    publicationDigest: string;
  };
  availability: "ready" | "empty";
  goals: MobileGoalsResponse;
  today: MobileTodayResponse;
  workoutPlan: MobileWorkoutPlanResponse & { windowStart: string; windowEnd: string };
  coachSummary: MobileRunCoachResponse;
}

export interface MobilePlanReceiptInput {
  localDate: string;
  kind: MobileSessionKind;
  revision?: number;
  structure?: MobileSessionStructure | null;
  workoutID?: string;
  scheduledAt?: string;
  idempotencyKey?: string;
  exportNotes?: string[];
  contractVersion?: 2;
  scope?: { serverId: string; athleteId: string; datasetEpoch: string };
  operationId?: string;
  coherenceToken?: string;
  verifiedAt?: string;
  timezone?: string;
  prescriptionDigest?: string;
  lifecycleEvent?: "verified" | "withdrawn" | "replaced";
}

/** Result of deterministic weekly coach generation. */
export interface MobileWeeklyPlanGenerationResponse {
  generatedAt: string;
  revision: number;
  audit: MobilePlanAudit;
  days: MobilePlannedDay[];
  /** Rejections and clamp adjustments, surfaced for review after the fact. */
  warnings: string[];
}

export interface MobileWeeklyPlanPreviewResponse extends MobileWeeklyPlanGenerationResponse {
  previousDays?: MobilePlannedDay[];
  candidateId: string;
  expiresAt: string;
  replacedDates: string[];
  windowStart: string;
  windowEnd: string;
}

export interface MobileLockedSession {
  localDate: string;
  session: MobileNextSession;
  verdictTone: MobileVerdictTone;
  lockedAt: string;
}

export interface MobileLockState {
  candidate?: MobileNextSession;
  present: boolean;
  relockSuggested: boolean;
  lockedAt: string | null;
}

export interface LockMobileSessionInput {
  operationId?: string;
  operationScope?: MobilePlanOperationScope;
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

/**
 * Outcome of the server-side data refresh. Deliberately independent of training
 * and recovery dates: an import that completed with zero new records is still
 * `ok`, and a refresh is never "stale" because the runner did not wear a watch.
 */
export interface MobileSyncStatus {
  /**
   * `never` until a refresh has completed. `failed` only when the newest
   * completed refresh failed and no later import has been published — an
   * in-flight or cancelled import is not a failure.
   */
  status: "never" | "ok" | "failed";
  /** When the newest attempt started, whatever its outcome. */
  lastAttemptAt: string | null;
  /** When the newest refresh completed. */
  lastSuccessAt: string | null;
  /** Carried only when `status === "failed"`; never a substitute for the status. */
  error: string | null;
}

/**
 * Record coverage for the target date, per metric. `historical` means records
 * exist but belong to an earlier date, so they are a reference and never today's
 * reading. `latestDate` is the newest record for that metric whatever its state.
 *
 * Coverage is about the record, not the reading: a night dated today can still
 * carry no usable sleep minutes, and that gap belongs to
 * `MobileRecoveryAssessment`, not here.
 */
export interface MobileCoverageMetric {
  state: "none" | "historical" | "current";
  latestDate: string | null;
}

export interface MobileCoverage {
  latestTrainingDate: string | null;
  /** Newest raw HealthKit sample of any type — the feed's freshness, not per-metric completeness. */
  latestHealthSampleAt: string | null;
  sleep: MobileCoverageMetric;
  hrv: MobileCoverageMetric;
  restingHeartRate: MobileCoverageMetric;
}

/**
 * What the recovery evidence supports for the target date. Coverage answers "did
 * we measure", assessment answers "what does it say" — a gap in coverage is not
 * a negative assessment, and complete coverage is not a positive one.
 */
export interface MobileRecoveryAssessment {
  /** Additive for legacy clients; current server always supplies the heuristic evidence marker. */
  stateEvidence?: import("@rai/contracts").ReadinessStateEvidence;
  intendedUse?: "training_guidance_not_diagnosis";
  /** The date being assessed; null when nothing was assessable at all. */
  targetDate: string | null;
  coverage: "none" | "partial" | "complete";
  assessment: "not_assessed" | "no_low_signal" | "low_signal" | "multiple_low_signals";
  reasonCodes: string[];
  /** Newest recovery observation that exists, even when it is not today's. */
  lastObservationDate: string | null;
}

/**
 * How today's recommendation was derived, so a client can explain it without
 * guessing. `recoveryAdjustment` is `no_evidence` when recovery was simply not
 * consulted — that is neither an approval nor a downgrade.
 */
export interface MobileRecommendation {
  planRevision?: number;
  plannedKind?: MobileSessionKind | null;
  effectiveKind?: MobileSessionKind;
  adjustmentReason?: string | null;
  basis: "training_load_and_plan" | "insufficient_training_history" | "high_load";
  recoveryAdjustment: "none" | "veto" | "no_evidence";
  uncertaintyReasons: string[];
  reasonCodes: string[];
}

/** Aggregated payload for the iOS home page ("今天"). */
export type MobilePeriodizationPhase = "base" | "build" | "peak" | "taper" | "race_week" | "past";

export interface MobilePeriodizationWeek {
  weekStart: string;
  phase: MobilePeriodizationPhase;
  weeksToRace: number;
  volumeBandKm: { lower: number; upper: number };
  longRunCapKm: number;
  qualityDose: number;
  note: string;
}

/** §20 race-driven skeleton. Read-time and deterministic: no LLM, nothing persisted. */
export interface MobilePeriodization {
  policyVersion: string;
  generatedFor: string;
  raceDate: string | null;
  distance: MobileRaceDistance | null;
  weeks: MobilePeriodizationWeek[];
  current: MobilePeriodizationWeek | null;
  reasonCodes: string[];
}

export interface MobileAdherenceWeek {
  weekStart: string;
  phase: MobilePeriodizationPhase | null;
  /** Days the plan asked for a **session** — rest days are not obligations and are not counted. */
  plannedDays: number;
  observedDays: number;
  /** Days the plan asked for a session and nothing was observed. Not "missed". */
  unknownDays: number;
  plannedDistanceKm: number | null;
  observedDistanceKm: number;
  volumeRatio: number | null;
  qualityPlanned: number;
  qualityObserved: number;
  status: "unknown" | "on_track" | "under" | "met";
}

export interface MobilePlanAdherence {
  policyVersion: string;
  generatedFor: string;
  weeks: MobileAdherenceWeek[];
  current: MobileAdherenceWeek | null;
  reasonCodes: string[];
}

/** Advice only: a re-draft still goes through preview/confirm. */
export interface MobileReplanAdvice {
  policyVersion: string;
  recommended: boolean;
  reasons: Array<{ code: string; detail: string }>;
}

export interface MobileTodayResponse {
  /** Metadata only; limits already apply server-side. Not another race phase. */
  executionPolicy?: import("./coach-loop.js").CoachExecutionPolicyContext;
  /** Strict dated V2 result; legacy clients may keep reading the compatible assessment. */
  readinessSnapshot?: import("@rai/contracts").ReadinessAssessmentResult;
  /**
   * §13.3 的版本化决策输出。**与 `verdict`/`nextSession` 是同一次决策的两个投影**：
   * tone 直接来自同一个 verdict，action 来自决策自己报告的分支。
   *
   * 刻意**不**进入 `recommendationRevision` 的哈希：那份哈希吃的是
   * verdict/nextSession/candidate，往它里面加字段会让每个已确认的 lock 变陈旧。
   * iOS 也不消费它（见 run-tech-presentation-tests.sh 的 metadata_only 理由）。
   */
  decision?: CoachDecisionV2;
  generatedAt: string;
  timezone: string;
  /** Latest local_date present in the training loads; null when the store is empty. */
  latestDataDate: string | null;
  /** The latest successful server-side data refresh, independent of training dates. */
  lastSyncedAt: string | null;
  /** A completed refresh with zero new records is still a successful sync. */
  sync: MobileSyncStatus;
  /** What records exist, per metric — answers "did we measure", not "how is he". */
  coverage: MobileCoverage;
  /** What today's recovery evidence supports — answers "what does it say", not "did we measure". */
  recoveryAssessment: MobileRecoveryAssessment;
  /**
   * §9.6 load-proxy recovery estimate: hours until a quality session is
   * supported. Deliberately **not** named `recovery`: that name is already taken
   * by `MobileRecoveryBreakdown` below, which reports *measured* evidence, and
   * one name for both would let an extrapolation read as a measurement.
   */
  recoveryTime: RecoveryTimeEstimate;
  /** Why today's recommendation reads the way it does, and whether recovery was consulted. */
  recommendation: MobileRecommendation;
  /** §20 race-driven skeleton for the coming weeks. Null when no race target is set. */
  periodization: MobilePeriodization | null;
  /** §20 weekly adherence. Null when no plan history exists. */
  adherence: MobilePlanAdherence | null;
  /** §20 whether to offer a re-draft. Never a write. */
  replan: MobileReplanAdvice | null;
  /**
   * @deprecated Transitional flag, now derived from `sync`. It used to answer
   * "is there a main night dated today", which reported an ordinary coverage gap
   * as an expired dataset and let a historical night decide today's verdict.
   * Prefer `sync` for the refresh outcome, `coverage` for per-metric records and
   * `recoveryAssessment` for what the evidence supports. Kept only so a client
   * that has not shipped yet keeps decoding.
   */
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
  easyDurationFloorFraction: number;
  qualitySessionCap: number;
  raceTarget: MobileRaceTarget | null;
  weekPlan: MobilePlannedDay[];
  lockedSession: MobileLockedSession | null;
  /** Audit trail of the last weekly plan generation. */
  weekPlanAudit: MobilePlanAudit | null;
  /** Server-owned migration state; only confirming a coach preview clears it. */
  weekPlanReplanRequired?: boolean;
  /** Server-owned legacy-day protection; expires by local date, not by confirmation. */
  weekPlanPreservedDate?: string | null;
  /** Server-managed adaptive running programme; edited through run-coach commands. */
  runCoach?: MobileRunCoachPlan | null;
  updatedAt: string;
}

export interface MobileRunCoachConfig {
  goal: "fitness" | "finish" | "time";
  raceDate: string | null;
  raceDistanceKm: number | null;
  targetTimeSeconds: number | null;
  /** ISO weekdays: Monday = 1, Sunday = 7. */
  runningDays: number[];
  longRunDays: number[];
  targetType: "pace" | "heart_rate";
  strengthTraining: boolean;
  /** Fitness programme length; legacy configurations default to 12 weeks. */
  durationWeeks?: number;
}

export interface MobileRunCoachPlan extends MobileRunCoachConfig {
  id: string;
  startedOn: string;
  status: "active" | "paused" | "ended";
  pausedOn: string | null;
  endedOn: string | null;
  /** Facts/config fingerprint, not a fitness score or Garmin confidence value. */
  adaptationKey: string | null;
  adaptedAt: string | null;
}

export interface MobileRunCoachCommand {
  operationId?: string;
  operationScope?: MobilePlanOperationScope;
  expectedRevision: number;
  action: "start" | "update" | "refresh" | "pause" | "resume" | "end";
  config?: MobileRunCoachConfig;
}

/**
 * Coach confidence value — *preparation*, not a probability of hitting a time.
 *
 * It re-publishes the prep assessment the today card already shows (weekly volume,
 * longest run, frequency, target-distance exposure, recency), so it answers "how
 * ready is this runner for this distance" and nothing else. It is **not** a goal
 * feasibility estimate and does not consume the race-time prediction chain.
 *
 * Three gates; any one failing ⇒ `status: "insufficient_data"` and `value: null`.
 * **`value` is never `0` to mean "no data"** — zero reads as the assertion "preparedness
 * is zero", which is the same banned shape as `DurabilityAssessment.durabilityScore`
 * (see `@rai/durability`). The UI must render an explicit empty state instead.
 *
 * Banding thresholds are policy constants, not fitted against outcomes.
 */
export interface MobileRunCoachConfidence {
  status: "available" | "insufficient_data";
  /** 0–100. Must be `null` whenever `status !== "available"`. */
  value: number | null;
  band: "low" | "moderate" | "high" | null;
  /** v1 only ever reports `"preparation"`; goal feasibility would be a new basis. */
  basis: "preparation" | null;
  /** Shares of the prep targets, 0–1. Null exactly when `value` is null. */
  components: {
    volume: number;
    longRun: number;
    frequency: number;
    exposure: number;
    recency: number;
  } | null;
  /**
   * How much history stands behind the number. `developing` means the history does
   * not cover a full preparation window, so a low value is not evidence of low volume.
   */
  evidenceLevel: "insufficient" | "developing" | "established" | null;
  reasonCodes: string[];
  /** Plain language. Always states that this is not a goal-hit probability. */
  note: string;
}

export interface MobileRunCoachResponse {
  revision: number;
  plan: MobileRunCoachPlan | null;
  /**
   * The race-block phase, or `null` when there is no race block to be in a phase of — a fitness
   * programme, or a distance outside the calibrated 5K / 10K / half-marathon set. Neither has a
   * periodisation skeleton behind it, and `null` is what the UI renders as「持续训练」: answering
   * `"base"` for a marathon asserted a plan that does not exist. A closed set on purpose: it used
   * to be `string`, and the iOS side mapped it with a private `default:`, so a seventh phase would
   * have compiled, passed every regression, and silently reused an existing word.
   */
  phase: MobilePeriodizationPhase | null;
  daysToRace: number | null;
  elapsedWeeks: number;
  weeklyCapacityKm: number;
  notices: string[];
  phases: Array<{ phase: MobilePeriodizationPhase; startsOn: string; endsOn: string; current: boolean }>;
  strength: Array<{ localDate: string; durationMinutes: number; exercises: Array<{ name: string; dose: string }> }>;
  /**
   * Selected running weekdays inside the programme that carry **no session**, with a
   * code and the observable counts behind it.
   *
   * Codes, not motives. The read path cannot tell a budget cut from a ramp-guard cut
   * from a pre-race cut, and the stored day used to answer all three with "恢复日。" —
   * a cause it had never established. Report the fact and let the screen explain it.
   */
  unplannedDays: Array<{
    localDate: string;
    code: "no_session_scheduled" | "pre_race_taper";
    detail: string;
  }>;
  /** Null only when there is no race programme at all (no plan, or a fitness goal). */
  confidence: MobileRunCoachConfidence | null;
}

export interface UpdateMobileGoalsInput {
  operationId?: string;
  operationScope?: MobilePlanOperationScope;
  expectedRevision?: number;
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
  /**
   * Grade context for this split, from the route points of the same run. Absent
   * (rather than zero-filled) when the run has no altitude data — `null`
   * `gradePercent` means "unknown", which is not the same as "flat".
   */
  grade?: WorkoutSplitGrade | null;
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

/**
 * Privacy zones (docs/DECISIONS.md D9).
 *
 * `revision` is returned with the list because the write is a whole-collection
 * replace: a client that did not read a revision cannot safely save one.
 */
export interface PrivacyZonesResponse {
  revision: number;
  /** Exact collection state, including coordinates; prevents restore ABA conflicts. */
  stateToken: string;
  zones: Array<{
    id: string;
    label: string;
    centerLatitude: number;
    centerLongitude: number;
    radiusMeters: number;
    createdAt: string;
    updatedAt: string;
  }>;
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

/** Explicit allowlist: no coordinates, health samples, notes, identifiers or model internals. */
export interface WorkoutSummaryExportResponse {
  from: string;
  through: string;
  timezone: string;
  count: number;
  csv: string;
}
export type {
  CoachEvidenceRef, CoachDecisionReason, CoachPolicyManifest, CoachTrainingMode,
  CoachExecutionPolicyContext, CoachSessionDose, CoachCapacityAnchor,
  CoachVolumeConstraint, CoachVolumePolicy, CoachLoopCandidate, WorkoutExecutionAssessment,
  CoachPlanRepairCost, CoachAdaptationRecord, CoachQualityExecutionSummary,
  SubjectiveFeedback, CoachPredictionSummary, CoachGoalGap,
  CoachLoopSettings, CoachLoopCommand, CoachLoopRuntimeResponse, CoachLoopReceiptContext, CoachLoopDeviceReceipt
} from "./coach-loop.js";
