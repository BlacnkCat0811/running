// Timezone: the single source of truth for the database timezone plus the shared
// memoised `Intl.DateTimeFormat` cache. Re-exported here so every package reaches it
// through `@rai/contracts` — contracts is the only package all others depend on
// (`storage-sqlite` and `training-load` do not depend on each other, so neither can
// host a helper the other needs).
export * from "./timezone.js";

// 直接增量同步的状态合同与"禁止操作"清单（docs/SQLITE_DIRECT_SYNC_DESIGN.md §10.1 / §14.1）。
// 放 contracts 是因为 API 与 storage 都要读它，而两者互不依赖。
export * from "./direct-sync.js";

// 事实侧/分析侧两块视图的**形状**（PR5 D1、D5）。同样放这里：读侧实现（`storage-sqlite`）
// 要构造它们，API 层（`api-contracts`）要把它们装进响应类型，而这两者互不依赖 ——
// 留在 `api-contracts` 会让 `storage-sqlite` 出现一条**向上的** import，
// 被 `npm run check:package-boundaries` 拦下（详见该文件头注释）。
export * from "./facts-analysis-view.js";

// 分析输入覆盖证明（O06-A / WP-22）。同样放这里：计算端（`@rai/application` 的输入读取器）
// 与发布端（`@rai/storage-sqlite` 的 `verifyAndPoint`）**必须用同一份实现** ——
// 两处各写一遍时，漂移方向恰好是"发布判据比计算判据松"，而那正是"旧计算当最新展示"的入口。
export * from "./analysis-input-coverage.js";

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

/**
 * 会影响**评分/分析**的健康记录类型。
 *
 * 🔴 这份清单是"能不能不做分析"这个判定的核心，所以它必须**只有一处定义**：
 * 它同时被
 *   - 批次分类（`classifyDirectSyncPayload`，决定本批走 record-only 还是必须登记分析）；
 *   - 直连 record-only 车道的**结构闸门**（`DATA_ONLY_RECORD_TYPES ∩ 本清单 = ∅`，
 *     见 `apps/api/src/data-only-import.ts`）；
 *   - `dataOnlyBaselineContract()` 的哈希输入（清单变了，旧基线资格立刻失效）。
 * 三处各写一份的后果不是"多写几行"，而是**可以只改一处就造出"该分析却宣布不需要分析"**。
 *
 * ⚠️ 新增类型时的正确动作是：先判断它是否影响分析，若是则加进本清单；
 * 加进来会让上面前两条同时生效，而不是只影响其中一条。
 */
export const scoringHealthTypes = [
  healthTypes.heartRate,
  healthTypes.runningSpeed,
  healthTypes.restingHeartRate,
  healthTypes.sleepAnalysis,
  healthTypes.hrvSdnn,
  healthTypes.vo2Max
] as const;

export const SLEEP_ANALYSIS_VALUES = {
  inBed: "HKCategoryValueSleepAnalysisInBed",
  awake: "HKCategoryValueSleepAnalysisAwake",
  asleepUnspecified: "HKCategoryValueSleepAnalysisAsleepUnspecified",
  asleepCore: "HKCategoryValueSleepAnalysisAsleepCore",
  asleepDeep: "HKCategoryValueSleepAnalysisAsleepDeep",
  asleepRem: "HKCategoryValueSleepAnalysisAsleepREM",
  asleepDeprecated: "HKCategoryValueSleepAnalysisAsleep"
} as const;

export type CanonicalNightKind = "main" | "nap";
export type HrvDayConfidence = "confident" | "sparse" | "missing";
export type PhysState = "unknown" | "depleted" | "reduced" | "recovered_phys";
export interface DailyPhysState { localDate: string; physState: PhysState }

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

export const FEATURE_SCHEMA_VERSION = "workout-feature-v4" as const;
export const LEGACY_FEATURE_SCHEMA_VERSION = "workout-feature-v3" as const;

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

/**
 * HR zones counted as "high intensity" for `LoadVectorV2.highIntensityMinutes` (§9.2).
 *
 * Single definition on purpose: this set was previously an inline literal inside
 * `analyzeWorkoutZones` (`highHeart`), and a second copy in the load vector would let the two
 * drift without anything failing. The two ladders are **not** structurally isomorphic
 * (`aerobic_power` exists only on the heart-rate side), so a set of names is the only safe
 * shared representation — see the §10.4 coherence policy for why indices must not be compared.
 */
export const highIntensityHeartRateZones = ["lactate_threshold", "anaerobic"] as const satisfies readonly HeartRateZone[];

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
    valueSources?: {
      restingHeartRate: ZoneValueSource;
      maximumHeartRate: ZoneValueSource;
      thresholdPace: ZoneValueSource;
      thresholdEvidence: "observed" | "inferred" | "fallback" | "manual";
    };
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

export type ZoneAgreement = "aligned" | "pace_high" | "hr_high" | "insufficient";

/**
 * §10.4 HR/Pace 双来源一致性。
 *
 * 🔴 HR zone 与 Pace zone **并不同构**（`aerobic_power` 只在 HR 一侧，`anaerobic_endurance` /
 * `sprint` 只在 Pace 一侧），所以实现里先映射到共享生理努力档，再用**显式语义映射**判断对齐 ——
 * **不得把各自数组下标相减当冲突分**。
 */
export interface ZoneCoherence {
  agreement: ZoneAgreement;
  comparisonPolicyVersion: string;
  /** **真实配对**覆盖率：两侧同时落到某个分区的时长占比，不是 `min(两侧覆盖率)`。 */
  pairedCoverage: number;
  /** 达到最小持续时长的分歧秒数合计；短暂 HR 滞后不计入。 */
  sustainedConflictSeconds: number;
  reasonCodes: string[];
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
  /**
   * §10.4 HR/Pace 双来源一致性。与 `explanationCodes` 里的 `heart_rate_pace_conflict` 并存：
   * 后者是旧的下标相减判据（会改 `stimulusConfidence`），本字段是显式语义映射的版本，
   * **两者尚未统一** —— 切换需要一次带前后对照的变更。
   *
   * ⚠️ **可选**：内存计算路径（`analyzeWorkoutZones`）总会给出它；但
   * `active_workout_zone_summaries` 是**按列存取**的，把它落库需要新增列（Phase 5 §14），
   * 所以从库里重建的 summary 目前取不到。消费方必须把**缺失**当作"未计算"，
   * 不能当作 `aligned` —— 与 §5.3「缺数据不得谎报已归一化」同一条原则。
   */
  zoneCoherence?: ZoneCoherence;
}

export interface TrainingLoadBreakdown {
  rawHrrTrimp: number | null;
  internalLoad: number | null;
  paceLoad: number | null;
  distanceReferenceMeters: number | null;
  distanceExposureRatio: number | null;
  distanceFactor: number;
  compositeLoad: number;
  compositeIntensity: number;
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

export const TRAINING_ZONE_CONFIG_VERSION = "training-zone-config-v4" as const;
export const TRAINING_LOAD_CONFIG_VERSION = "training-load-config-v5" as const;

export type TrainingLoadSource =
  | "composite"
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
  /**
   * §9.6 load-proxy recovery estimate anchored on the newest finished session.
   * A load extrapolation, not a measured recovery state. Named `recoveryTime`
   * rather than `recovery` so it cannot be confused with the measured
   * `recoveryAssessment` on the mobile contract.
   */
  recoveryTime: RecoveryTimeEstimate;
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
  days: TrainingLoadTimelineDay[];
  components: Array<{
    localDate: string;
    internalLoad: number | null;
    paceLoad: number | null;
    compositeLoad: number;
  }>;
}

// -----------------------------------------------------------------------------
// Training form and recovery time (docs/ALGORITHM.md §9.6).
//
// Both are **load proxies**, not physiological measurements: `form` is the
// difference between the chronic and acute EWMA of the same composite load the
// rest of §9 uses, and recovery time extrapolates from the last session's load.
// They are named and typed to keep that visible — `isLoadProxy` travels with the
// recovery estimate, and neither may override Readiness, the plan, or the
// training status (§9.5 / L03).
//
// `form` is deliberately a separate type from `TrainingStatusCode`: that code is
// the §9.5 action classification with its own thresholds and acceptance tests,
// and folding a second scale into it would silently change what those tests mean.
// -----------------------------------------------------------------------------

export const TRAINING_FORM_POLICY_VERSION = "rai-training-form-v1" as const;
export const RECOVERY_TIME_POLICY_VERSION = "rai-recovery-time-v1" as const;

export type TrainingFormStatus =
  | "insufficient_data"
  | "transition"
  | "fresh"
  | "neutral"
  | "loaded"
  | "overreached";

/** A persisted daily metric plus its read-time form curve. The stored row is unchanged. */
export interface TrainingLoadTimelineDay extends DailyTrainingMetric {
  /** `chronicEwma − acuteEwma`, in daily-EWMA load units. Null before history exists. */
  form: number | null;
  /** `form / chronicEwma`. Reported because absolute load units are not comparable across athletes. */
  formRatio: number | null;
  formStatus: TrainingFormStatus;
}

export interface RecoveryTimeEstimate {
  policyVersion: typeof RECOVERY_TIME_POLICY_VERSION;
  status: "available" | "insufficient_data";
  /** Hours until the next quality session is supported by this estimate. */
  remainingHours: number | null;
  /** When the estimate clears, ISO instant. Null when insufficient. */
  readyAt: string | null;
  /** The session the estimate is anchored on. */
  anchor: {
    trainingSessionId: string;
    localDate: string;
    endedAt: string;
    load: number;
    sessionType: SessionType;
  } | null;
  /** Why the number reads the way it does. The UI renders these instead of inventing wording. */
  basisCodes: string[];
  /** Always true: this is an extrapolation from load, not a measured recovery state. */
  isLoadProxy: true;
  confidence: number | null;
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

/**
 * CLI 导出导入进程写在 `recompute_jobs.request_json` 里的载荷判别物。
 * 出处：`packages/health-export-parser/src/cli.ts`（`import` / `incremental-import` 命令）。
 */
export const CLI_OWNED_IMPORT_REQUEST_MODE = "cli_export_import";

/**
 * 直接增量同步车道登记的分析任务写在 `request_json` 里的载荷判别物。
 *
 * 🔴 为什么分析任务**必须**带这个判别物，而不是只靠 `job_type`：`'import'` 是
 * **两个所有者共用的类型名** —— 旧 CLI 导入在写它，直连车道登记的分析任务也要写它
 * （v35 文件头明令禁止放宽 `job_type` 的 `CHECK`，所以不能靠新增类型名区分）。
 * 只按类型分派会让两条路互相误伤：
 *   - 恢复流程把中断的 CLI 导入任务放回队列 ⇒ 消费者领走 ⇒ 旧行为：判 `failed`，
 *     且**原始中断原因被清掉**（实测形态，见 `recompute-job-recovery.test.ts`）；
 *   - 反过来，一旦消费者有 `import` 分支而**不看载荷**，一条被复活的 CLI 导入任务
 *     会被当成分析任务去执行。
 */
export const DIRECT_SYNC_ANALYSIS_REQUEST_MODE = "direct_sync_analysis";

/** 谁能执行一条 `recompute_jobs` 任务。`external` = 有自己所有者进程，消费者不得执行。 */
export type RecomputeJobDisposition = "application" | "payload-scoped" | "external";

export interface RecomputeJobTypeDisposition {
  readonly jobType: RecomputeJobType;
  readonly disposition: RecomputeJobDisposition;
  /** 该类型的执行者（用于文档与失败文案）。 */
  readonly owner: string;
}

/**
 * `recompute_jobs` 里每个 `job_type` 的**有意表态**。
 *
 * 🔴 为什么这是一个共享表而不是两边各写一份：`recoverInterrupted()`（存储层）会把
 * `status='running'` 的任务按"谁能执行"分派，而唯一那个消费者是
 * `DatasetService.runNextJob`（应用层）。两边各写一份清单，等于允许它们悄悄分叉 ——
 * 分叉的后果实测过：CLI 导入崩溃 → API 重启做恢复 → 任务被放回队列 → 消费者领走后
 * 以 `Unsupported application job type: import` 置为失败，而**原始中断原因已被恢复流程清掉**。
 *
 * `payload-scoped` 表示**同一个类型名由两个所有者共用**，只能连载荷一起判别 ——
 * 判别规则见 {@link PAYLOAD_SCOPED_JOB_OWNERSHIP}，执行者是
 * {@link isApplicationConsumableJob}。新增任务类型时，这里要么给它 `application`
 * （并在消费者里加分支），要么写明它归谁；`recompute-job-recovery.test.ts` 会把
 * "两者都没有"的新类型判红，也会把"声明了却与判别函数不一致"的组合判红。
 */
export const RECOMPUTE_JOB_TYPE_DISPOSITIONS: readonly RecomputeJobTypeDisposition[] = [
  {
    jobType: "full_recompute",
    disposition: "application",
    owner: "DatasetService.runNextJob（应用消费者）"
  },
  {
    jobType: "snapshot_refresh",
    disposition: "application",
    owner: "DatasetService.runNextJob（应用消费者）"
  },
  {
    jobType: "import",
    disposition: "payload-scoped",
    owner: "按载荷判别：CLI 导入进程（cli_export_import）vs 直连车道分析任务（direct_sync_analysis）"
  }
];

/**
 * `payload-scoped` 类型的载荷级归属表。两列都必须**非空**：
 * 只列"谁能跑"而不列"谁不能跑"，会让判别函数退化成默认放行。
 */
export interface PayloadScopedJobOwnership {
  readonly jobType: RecomputeJobType;
  /** 归应用消费者的 `request_json.mode` 取值。**白名单**：不在其中的一律不放行。 */
  readonly applicationRequestModes: readonly string[];
  /** 归外部所有者进程的 `request_json.mode` 取值，以及它的所有者。 */
  readonly externalRequestModes: readonly { readonly requestMode: string; readonly owner: string }[];
}

export const PAYLOAD_SCOPED_JOB_OWNERSHIP: readonly PayloadScopedJobOwnership[] = [
  {
    jobType: "import",
    applicationRequestModes: [DIRECT_SYNC_ANALYSIS_REQUEST_MODE],
    externalRequestModes: [{
      requestMode: CLI_OWNED_IMPORT_REQUEST_MODE,
      owner: "CLI 导入进程（packages/health-export-parser/src/cli.ts）自己创建并推进"
    }]
  }
];

/** 取载荷里的 `mode`。接受已解析的对象，也接受库里那一列原样的 JSON 文本。 */
export function recomputeRequestMode(requestJson: unknown): string | null {
  let value = requestJson;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const mode = (value as { mode?: unknown }).mode;
  return typeof mode === "string" ? mode : null;
}

/**
 * 应用消费者（`DatasetService.runNextJob`）能否执行这条任务。
 *
 * 🔴 判据是 `(job_type, 载荷 mode)` 的**合取**，不是 `job_type` 一个字段：
 * `payload-scoped` 类型的载荷白名单为空、或载荷 `mode` 不在白名单里，一律返回 `false`。
 * 未知类型同样返回 `false` —— 把一条没人能跑的活投给消费者，只会得到一条
 * **原因错误**的失败任务（真因是"它根本不属于这个消费者"）。
 */
export function isApplicationConsumableJob(jobType: string, requestJson: unknown): boolean {
  const declared = RECOMPUTE_JOB_TYPE_DISPOSITIONS.find((entry) => entry.jobType === jobType);
  if (!declared) return false;
  if (declared.disposition === "application") return true;
  if (declared.disposition === "external") return false;
  const scope = PAYLOAD_SCOPED_JOB_OWNERSHIP.find((entry) => entry.jobType === jobType);
  if (!scope) return false;
  const mode = recomputeRequestMode(requestJson);
  return mode !== null && scope.applicationRequestModes.includes(mode);
}

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
  "recovery_data_missing",
  /** §3.3: read from a frozen V3 payload, so V4-only evidence is unavailable, not measured. */
  "unavailable_in_legacy_feature"
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

/** Frozen legacy in-memory projection, used only at existing scoring/read boundaries. */
export type WorkoutFeatureVectorV3 = WorkoutFeatureVector;

export interface WorkoutFeaturePayloadV4 {
  schemaVersion: "workout-feature-v4";
  raw: {
    efficiencyRaw: number | null;
    paceRawMetersPerSecond: number | null;
    stabilityRaw: number | null;
    heartRateReserveFraction: number | null;
    heartRateCoefficientOfVariation: number | null;
    speedCoefficientOfVariation: number | null;
  };
  normalized: {
    speedMetersPerSecond: number | null;
    efficiencySpeedPerBpm: number | null;
  };
  normalization: {
    adapterVersion: string; configHash: string; sourceContextHash: string;
    status: "applied" | "not_needed" | "unavailable" | "out_of_domain";
    correctionFraction: number | null;
    comparability: number; reasonCodes: string[];
  };
  execution: {
    pacingConsistency: number | null;
    heartRateConsistency: number | null;
    aerobicDecouplingPct: number | null;
    pairedCoverage: number;
    intervalExecutionQuality: number | null;
  };
  evidenceFlags: string[];
}

export interface WorkoutFeatureVectorV4 extends Omit<WorkoutFeatureVector, "signals" | "provenance"> {
  payload: WorkoutFeaturePayloadV4;
  provenance: {
    featureConfigVersion: string;
    sourceCategory: string;
    workoutEndAt: string;
    observedMaximumHeartRate: number | null;
  };
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
  /**
   * Written by the persistence layer, not by the alpha composition. Since
   * `rai-model-config-v10` the §6.9 alpha formula has no direction factor, so an
   * applied step stores `1` (the identity) and a step that was not applied stores
   * `0`. Rows written before v10 may hold `0.4` or `0.25`; the two spans are not
   * comparable, and after v10 the column duplicates `updatedTrueAbility`.
   */
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
  /**
   * v35 的分析任务绑定列（PR5 §1.2 锚点 18 / 清单 18）。
   *
   * 🔴 三个字段都是**可选**的，且语义上"缺省 = `undefined`"而不是 `null`：
   * v35 之前登记的历史任务这四列**根本不存在**（`ALTER TABLE ADD COLUMN` 让老行为 NULL），
   * 而"老任务没有绑定代次"与"新任务绑定了一个为 NULL 的代次"是两件事 ——
   * 后者不可能发生（`enqueue` 只在给了值时才写那一列），前者才是真实情况。
   * 把两者合成一个 `null` 会让消费方无法回答"这条任务到底有没有版本绑定"。
   */
  targetRawGeneration?: number;
  targetDependencyGeneration?: number;
  expectedIncumbentReleaseId?: string;
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
  // §2/§3: a missing observation is `null`, and a present one must be finite. The
  // optional numbers used to go unchecked, so `NaN`/`Infinity` travelled from the
  // parser into scoring, where the first symptom was a `Math.min/max` propagating
  // NaN into an unrelated assert or an unstable sort key.
  for (const name of [
    "distanceKm",
    "averageSpeedMetersPerSecond",
    "averageHeartRateBpm",
    "routeQuality"
  ] as const) {
    assertFiniteOrNull(`WorkoutFeatureVector ${name}`, feature[name]);
  }
  for (const [name, value] of [
    ["heartRateCoverage", feature.heartRateCoverage],
    ["sourceConfidence", feature.sourceConfidence],
    ["qualityScore", feature.qualityScore]
  ] as const) {
    // `!(x >= 0 && x <= 1)` rather than `x < 0 || x > 1`: NaN fails both old
    // comparisons and slipped through as a valid score.
    if (value !== null && !(Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error(`WorkoutFeatureVector ${name} must be null or a finite number within [0, 1]`);
    }
  }
  for (const [name, value] of [
    ["heartRateSampleCount", feature.heartRateSampleCount],
    ["routePointCount", feature.routePointCount]
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`WorkoutFeatureVector ${name} must be a non-negative integer`);
    }
  }
  for (const name of ["workoutStartAt", "computedAt"] as const) {
    if (typeof feature[name] !== "string" || !Number.isFinite(Date.parse(feature[name]))) {
      throw new Error(`WorkoutFeatureVector ${name} must be a parseable instant`);
    }
  }
  if (!(sessionTypes as readonly string[]).includes(feature.sessionType)) {
    throw new Error(`WorkoutFeatureVector sessionType is not a known session type: ${String(feature.sessionType)}`);
  }
  if (feature.sessionTypeSource !== "auto" && feature.sessionTypeSource !== "override") {
    throw new Error(`WorkoutFeatureVector sessionTypeSource is invalid: ${String(feature.sessionTypeSource)}`);
  }
  if (feature.eligibilityStatus !== "eligible" && feature.eligibilityStatus !== "trial" &&
      feature.eligibilityStatus !== "excluded") {
    throw new Error(`WorkoutFeatureVector eligibilityStatus is invalid: ${String(feature.eligibilityStatus)}`);
  }
  // Deliberately not enumerated: stored rows may carry codes retired since they were
  // written, and the read path must not fail on a value it cannot re-derive.
  if (!Array.isArray(feature.missingReasons) ||
      feature.missingReasons.some((reason) => typeof reason !== "string" || reason.length === 0)) {
    throw new Error("WorkoutFeatureVector missingReasons must be an array of non-empty strings");
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

/**
 * The session kinds a plan day may carry.
 *
 * This array is the single source of truth. The union type, the JSON Schema
 * enum the API validates with, and the `Set` each server module checks all
 * derive from it — they used to be four hand-written copies of the same six
 * strings, and a kind added to one but not the others turned a request that had
 * already passed schema validation into an unexplained 500.
 */
export const MOBILE_SESSION_KINDS = [
  "rest",
  "recovery",
  "easy",
  "long_run",
  "tempo",
  "interval"
] as const;

export type MobileSessionKind = (typeof MOBILE_SESSION_KINDS)[number];

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
  method: "vdot_one_hour_proxy_v1" | "multi_evidence_threshold_v2" | "observed_threshold_v3";
  evidenceCodes: PhysiologyEvidenceCode[];
}

export interface RaceTimePrediction {
  /** Rule-derived bounds, never an empirical P80/P90 coverage claim. */
  heuristicRange?: {
    kind: "heuristic_not_calibrated";
    lowerSeconds: number | null;
    upperSeconds: number | null;
  };
  machineLearningPolicyReason?: "calibration_unavailable" | "ridge_not_validated";
  intervalEvidence?: {
    predictorKey: string;
    status: "insufficient_calibration" | "empirically_evaluated";
    artifactId: string | null;
    p50Seconds: number | null;
    p80: { lowerSeconds:number; upperSeconds:number } | null;
    p90: { lowerSeconds:number; upperSeconds:number } | null;
    coverageP80: number | null;
    coverageP90: number | null;
    coverageIntervalP80?: {lower:number;upper:number}|null;
    coverageIntervalP90?: {lower:number;upper:number}|null;
    evaluationSamples: number;
    coverageClaim: "empirical_target_not_individual_guarantee";
  };
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
  | "race_readiness_missing"
  | "prediction_confidence_low";

export interface PhysiologyPredictionScenario {
  temperatureC: number | null;
  humidityPercent: number | null;
  elevationGainMeters: Record<RaceDistance, number | null>;
}

export interface PredictionRecoveryExplainability {
  readiness: number | null;
  status: "available" | "insufficient_data" | "compat_fallback";
  source: "canonical" | "raw_compat" | "mixed" | "none";
  asOf: string;
  latestObservedAt: string | null;
  coverage: "full" | "partial" | "none";
}

export interface PredictionReadinessExplainability {
  value: number | null;
  status: "available" | "insufficient_data";
  evidenceCount: number;
  dataThroughAt: string | null;
}

export interface PredictionExplainability {
  schemaVersion: "prediction-explainability-v1";
  recovery: PredictionRecoveryExplainability;
  readiness: Record<RaceDistance, PredictionReadinessExplainability>;
}

export interface PredictionEnhancementSelection {
  biasCalibration: {
    status: "inactive" | "available";
    historicalOutcomeCount: number;
    eligibleOutcomeCountByDistance: Record<RaceDistance, number>;
    appliedDistances: RaceDistance[];
  };
  machineLearning: {
    status:
      | "insufficient_samples"
      | "keep_formula_baseline"
      | "active"
      | "inference_unavailable"
      | "stale";
    modelVersion:
      | "race-residual-ridge-v1"
      | "race-residual-catboost-v1"
      | "race-residual-catboost-v2"
      | "race-residual-catboost-v4"
      | "race-residual-catboost-v5"
      | null;
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
  predictionPolicy?: {
    version: "rai-prediction-policy-v2";
    mode: "neutral_potential" | "current_prepared" | "race_day_scenario";
    targetDate: string | null;
    pointCorrection: "none" | "catboost";
    intervalStatus: "insufficient_calibration" | "empirically_evaluated" | "partially_calibrated";
    corrections: Array<{
      distance: RaceDistance;
      steps: Array<{
        kind: "preparation" | "durability" | "environment" | "elevation" | "acute_readiness" | "catboost";
        /**
         * §5.5：这一步作用于哪个对象。`target_scenario` 是"未来比赛情景"，
         * `historical_evidence` 是"过去表现去偏差"。后者**不得**以 applied=true 出现在
         * 这条链上 —— `potentialSeconds` 的定义已经是历史归一化之后（见 @rai/model-eval 的账本断言）。
         * `null` 表示该 kind 不区分对象。
         */
        object: "historical_evidence" | "target_scenario" | null;
        /** 谁做的这一步。同一步责任被两个 owner 各做一次时要靠它说清是谁。 */
        ownerVersion: string;
        /** 这一步去的是哪份证据。同一份证据被去两次 ⇒ §5.5 违规。无法声明时为 null。 */
        inputHash: string | null;
        applied: boolean;
        beforeSeconds: number; afterSeconds: number;
        reasonCodes: string[];
      }>;
    }>;
  };
  labelFunnel?: {
    sessionCount: number;
    confirmedCount: number;
    usableOutcomeCount: number;
    trainingSampleCount: number;
    trainingExcludedOutcomeCount: number;
    evaluatedOutcomeCount: number;
    primaryRejections: Record<string, number>;
    accuracyStatus: "not_evaluable" | "requires_release_evaluation";
  };
  reportVersion: typeof PHYSIOLOGY_REPORT_VERSION;
  generatedAt: string;
  inputs: {
    directVo2Evidence: number;
    labeledPerformanceEvidence: number;
    lactateThresholdSegments: number;
    performanceVdotEvidence: number;
    labeledRaceOutcomes: number;
    readiness: Record<RaceDistance, number | null>;
    recoveryReadiness: number | null;
    scenario: PhysiologyPredictionScenario;
    profile: {
      restingHeartRateBpm: number | null;
      observedMaximumHeartRateBpm: number | null;
    };
  };
  modelSelection: PredictionEnhancementSelection;
  guidanceCodes: PhysiologyGuidanceCode[];
  explainability?: PredictionExplainability;
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
  "race-residual-feature-v4" as const;
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
      "active composite daily training load; 7-day/28-day half-life EWMA ratio through asOf",
    environmentalScenario:
      "missing unless an independently timestamped pre-race scenario is available; workout result metadata is excluded"
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
  "462e213399e199f268ce1122eeae924db6d55c4dbc0795c643394d22f0366aa7" as const;
export const CATBOOST_PREDICTION_MODEL_VERSION =
  "race-residual-catboost-v5" as const;
export const PREDICTION_CORRECTION_CAP_FRACTION = 0.12 as const;

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
  ridgeComparison?: { status:"passed"|"failed"; walkForwardImprovement:number; releaseImprovement:number; bootstrapLower:number };
  baselineMaeSeconds: number;
  modelMaeSeconds: number;
  maeImprovement: number;
  intervalCoverageChange: number;
  regressesAnyDistanceByMoreThan5Percent: boolean;
  onnxMaximumAbsoluteError: number;
  /** Temporal event-block bootstrap 95% CI lower bound; null when unavailable. */
  maeImprovementBootstrap95Lower: number | null;
  byDistance: Record<RaceDistance, PredictionModelDistanceMetrics>;
}

/**
 * Which floor a training run was gated by (docs/ALGORITHM.md §12.12).
 *
 * `scope` changes **how much data** is required, never **how good the model must be**:
 * a personal model still has to beat the rule baseline by `MINIMUM_MAE_IMPROVEMENT` on
 * held-out data. It exists so a personal model is never mistaken for a population one
 * after activation.
 */
export type PredictionModelScope = "population" | "personal";

export interface PredictionModelRun {
  id: string;
  algorithm: "catboost";
  scope: PredictionModelScope;
  modelVersion: string;
  featureSchemaVersion: string;
  featureSchemaHash: string | null;
  abilityBaselineHash: string | null;
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
  scope?: PredictionModelScope;
  databasePath: string;
  artifactDirectory: string;
}

export interface PredictionModelTrainingResult {
  ridgeComparison?: { status:"passed"|"failed"; walkForwardImprovement:number; releaseImprovement:number; bootstrapLower:number };
  featureSchemaHash: string;
  trainingDataHash: string;
  labelCount: number;
  labelCountByDistance: Record<RaceDistance, number>;
  holdoutPredictionCount: number;
  metrics: PredictionModelEvaluationMetrics;
  supportedDistances: RaceDistance[];
  artifactPath: string;
  artifactSha256: string;
  /** Python evaluation gate outcome; activation requires "accepted". */
  evaluationStatus: "accepted" | "rejected";
  rejectionReasons: string[];
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
    // docs/ALGORITHM.md §11: a missing preparation score must read as *unmodeled*,
    // never as a number that was applied. These two invariants are what makes the
    // trace honest instead of merely present:
    //   · readiness === null  => there is no readiness adjustment;
    //   · method says readiness_v2 => a real readiness value produced it.
    if (prediction.readiness === null && prediction.readinessAdjustmentSeconds !== null) {
      throw new Error(
        "Race prediction without readiness evidence must not report a readiness adjustment"
      );
    }
    if (prediction.method === "daniels_vdot_readiness_v2" && prediction.readiness === null) {
      throw new Error("Race prediction method claims modelled readiness but carries no readiness value");
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

// -----------------------------------------------------------------------------
// V2 model lineage and replay envelope.
//
// Additive only: nothing above this marker changes meaning. The V2 optimisations
// are designed in `docs/ALGORITHM.md`
// (§3.2 lineage, §15.2 replay, §15.7 labels). These types fix the vocabulary the
// later phases attach to; having the vocabulary is not the same as having a
// replayable run.
// -----------------------------------------------------------------------------

export const MODEL_LINEAGE_SCHEMA_VERSION = "model-lineage-v2" as const;

/**
 * Everything needed to answer "which model, over which facts, produced this
 * number" without re-deriving it from the database.
 */
export interface ModelLineageV2 {
  sourceRunId: string;
  datasetVersion: string;
  factsSnapshotHash: string;
  overrideSnapshotHash: string;
  modelVersion: string;
  featureSchemaVersion: string;
  configVersion: string;
  configHash: string;
  /**
   * `null` when no calibration cohort exists. Never a placeholder hash: a fake
   * hash reads as "this run was calibrated".
   */
  calibrationCohortHash: string | null;
  baselineEpochId: string | null;
  normalizationVersion: string | null;
  normalizationConfigHash: string | null;
  /** Business timezone the run was computed in; never inferred from the host. */
  timezoneIdentifier: string;
  /** When the calculation ran. Not interchangeable with `dataThroughAt`. */
  asOf: string;
  /** Newest fact actually used. `null` when the extent is genuinely unknown. */
  dataThroughAt: string | null;
}

/**
 * `event_time_reconstruction` rebuilds past performance from what we hold today;
 * `as_known_then` additionally requires the facts and the labels to have reached
 * the system before `asOf`. Only the latter can evidence live prediction quality.
 */
export type ReplayModeV2 = "event_time_reconstruction" | "as_known_then";

/**
 * The part of a replay case that makes it auditable. Payload bundles (canonical
 * facts, overrides, race scenarios) keep their existing types until the V4
 * contracts land; the envelope is what Phase 0 fixes.
 */
export interface ReplayDescriptorV2 {
  caseId: string;
  asOf: string;
  timezoneIdentifier: string;
  replayMode: ReplayModeV2;
  factsSnapshotHash: string;
  overrideSnapshotHash: string;
  /**
   * True when fact arrival times are only partially known. Such a case may be
   * reconstructed at event time but must not be presented as `as_known_then`.
   */
  availabilityUnknown: boolean;
}

export type LabelAvailabilityV2 =
  /** Arrival time is known and usable for `as_known_then`. */
  | "available"
  /** The result exists, but when the system learned it is not recoverable. */
  | "availabilityUnknown"
  /** Not yet a usable label. */
  | "not_available";

/**
 * One confirmed performance result. Labels are evaluation inputs only — they
 * must never be fed into the model that produced the prediction being scored.
 */
export interface OutcomeLabelV2 {
  trainingSessionId: string;
  distance: RaceDistance;
  protocol: string;
  /** When the performance actually happened. */
  outcomeAt: string;
  /** max(completion, the moment the label became usable); drives leakage checks. */
  availableAt: string;
  availability: LabelAvailabilityV2;
  /** Bumped on every correction, so a replay can pin the revision it saw. */
  revision: number;
  /** Set when the result was withdrawn or superseded; excluded from cohorts. */
  excludedReason: string | null;
}

// Re-exported from the end of the file on purpose: placing this near the top
// shifts every subsequent line and silently invalidates the `file:line`
// references that dated deliverables point at (`npm run check:doc-refs`
// reports them as "锚在空行"). Appending keeps the whole existing numbering.
export * from "./semantic-json.js";

// -----------------------------------------------------------------------------
// Session comparability strata (docs/ALGORITHM.md §6.2).
//
// A workout may only be compared against workouts of the same kind. Comparing a
// tempo run against recovery jogs is what turns "the training plan changed" into
// "the athlete declined". The first version deliberately stops at five explainable
// strata instead of a sparse cross-product of weather, device and terrain.
// -----------------------------------------------------------------------------

export const SESSION_STRATA = [
  "steady_aerobic",
  "threshold_sustained",
  "race_protocol",
  "interval",
  "recovery_unknown"
] as const;

export type SessionStratum = (typeof SESSION_STRATA)[number];

export const COMPARABILITY_POLICY_VERSION = "rai-comparability-policy-v1" as const;

/** Independent training history inside one stratum, as of the workout being scored. */
export interface StratumHistory {
  /**
   * Distinct training sessions in this stratum *before* the current one. Multiple
   * windows of one session never count more than once.
   */
  independentSessions: number;
  /** Calendar span those sessions cover, in days. */
  spanDays: number;
}

export interface ComparabilityPolicy {
  allowedStrata: SessionStratum[];
  /**
   * Hard ceiling on the stratum count. Config parsing must reject anything above
   * it — a documented limit that the parser does not enforce is not a limit.
   */
  maximumStrata: number;
  minimumIndependentSessions: number;
  minimumSpanDays: number;
  /** Always false in this version: an insufficient bucket is never widened. */
  allowCrossStratumFallback: false;
  insufficientPolicy: "not_comparable";
}

export type StratumComparabilityStatus = "comparable" | "not_comparable" | "not_assessed";

export interface StratumComparability {
  status: StratumComparabilityStatus;
  stratum: SessionStratum;
  independentSessions: number | null;
  spanDays: number | null;
  reasonCodes: string[];
}

// -----------------------------------------------------------------------------
// Confidence V2 (docs/ALGORITHM.md §6.7).
//
// Rule-based evidence reliability is kept strictly apart from `modelConfidence` /
// `overall`. The first is a deterministic function of how good the evidence is;
// the second requires a joint calibration artifact with a declared target and an
// independent holdout. In this version both are always null, and that null is the
// product contract — not a gap for a front end to fill with a default.
// -----------------------------------------------------------------------------

export const CONFIDENCE_AGGREGATION_POLICY_VERSION = "rai-confidence-aggregation-v1" as const;

export type ConfidenceEvidenceStatus = "available" | "insufficient_evidence";

export type ConfidenceOverallStatus =
  | "not_calibrated"
  | "available"
  | "insufficient_evidence"
  | "out_of_domain";

/**
 * Weights of the rule factors inside the reliability geometric mean. Each must be
 * positive and they must sum to 1. The `source` signal deliberately has no weight
 * of its own: it is already inside `dataConfidence`, and counting it twice is the
 * double-discount this design removes.
 */
export interface ConfidenceWeightsV2 {
  data: number;
  comparability: number;
  maturity: number;
}

export interface ConfidenceV2 {
  dataConfidence: number | null;
  comparability: number | null;
  maturity: number | null;
  /** Coverage of the *scoring policy*. Not a multiplier inside the reliability. */
  evidenceCoverage: number;
  evidenceReliability: number | null;
  evidenceStatus: ConfidenceEvidenceStatus;
  modelConfidence: number | null;
  overall: number | null;
  overallStatus: ConfidenceOverallStatus;
  aggregationPolicyVersion: typeof CONFIDENCE_AGGREGATION_POLICY_VERSION;
  calibrationArtifactId: string | null;
  calibrationTarget: string | null;
}

// -----------------------------------------------------------------------------
// Environment view (docs/ALGORITHM.md §5).
//
// The environment correction itself already exists and already has an owner:
// `performanceConditionPenaltyFraction` in @rai/physiology, applied to historical
// VDOT evidence and to the target race scenario (see the condition ledger in
// @rai/normalization). What did not exist was any way for a reader to see it — a
// run in 30 °C and 80 % humidity rendered exactly like a run in 15 °C.
//
// This view is that read-out, and **nothing more**: it is a different object from
// the §5.5 ledger sites, it corrects nothing on its own, and no value here may be
// wired into evidence without first registering a ledger site. §5.5 forbids
// correcting the same field twice on the same object.
//
// The status taxonomy is deliberately the one the physiology condition adapter
// already returns. A correction of exactly zero is `not_needed`, not `null`;
// missing inputs are `unavailable`, never silently treated as reference
// conditions.
// -----------------------------------------------------------------------------

export const ENVIRONMENT_VIEW_POLICY_VERSION = "rai-environment-view-v1" as const;
export const GRADE_ADJUSTMENT_POLICY_VERSION = "rai-grade-adjustment-v1" as const;

export type EnvironmentViewStatus = "applied" | "not_needed" | "unavailable";

export interface WorkoutEnvironmentView {
  policyVersion: typeof ENVIRONMENT_VIEW_POLICY_VERSION;
  /** Version of the adapter that produced `adjusted`. */
  adapterVersion: string;
  status: EnvironmentViewStatus;
  /** Where the numbers came from. Only HealthKit workout metadata is read today. */
  source: "workout_metadata";
  /** Optional additive HealthKit weather code; null means unrecorded or unknown. */
  weatherCondition?: number | null;
  /** Raw observations. Always reported, even when the correction is unavailable. */
  temperatureC: number | null;
  humidityPercent: number | null;
  elevationGainMeters: number | null;
  /**
   * Correction components as fractions of duration. `null` whenever the status is
   * `unavailable`: a partial penalty presented as a total is exactly the
   * silent-zero-penalty failure this contract exists to prevent.
   */
  correction: { environment: number; elevation: number; total: number } | null;
  /**
   * The observation re-expressed at reference conditions. `null` when the
   * correction is unknown.
   */
  adjusted: { durationSeconds: number; paceSecondsPerKm: number | null } | null;
  /** Codes the UI renders instead of inventing its own wording. */
  reasonCodes: string[];
}

/**
 * Per-split grade context. Elevation comes from the route points of the same run,
 * so it exists only when a route with altitude was imported.
 */
export interface WorkoutSplitGrade {
  elevationChangeMeters: number | null;
  gainMeters: number | null;
  lossMeters: number | null;
  /** Net grade over the split distance, in percent. Null — not 0 — when unknown. */
  gradePercent: number | null;
  /** Minetti-equivalent flat pace, seconds per km. Null when grade or pace is unknown. */
  gradeAdjustedPaceSecondsPerKm: number | null;
  policyVersion: typeof GRADE_ADJUSTMENT_POLICY_VERSION;
  reasonCodes: string[];
}

export interface WorkoutGradeSummary {
  policyVersion: typeof GRADE_ADJUSTMENT_POLICY_VERSION;
  coveredSplits: number;
  totalSplits: number;
  gainMeters: number | null;
  lossMeters: number | null;
  /** Distance-weighted mean of the covered splits. Null when no split is covered. */
  gradeAdjustedPaceSecondsPerKm: number | null;
  reasonCodes: string[];
}

// -----------------------------------------------------------------------------
// Manually entered race results (docs/ALGORITHM.md §12.10).
//
// Declared here rather than in storage because the web client reads it: the shape is
// a contract, and a contract that lives behind the database package forces every
// consumer to depend on storage. The distance set is closed for the same reason the
// prediction chain's is — a marathon result has nowhere to go yet.
// -----------------------------------------------------------------------------

export type PerformanceEntryDistance = "five_k" | "ten_k" | "half_marathon";

/** Shared race-result plausibility rules for entry writes and candidate discovery. */
export function performanceResultValidationError(distanceMeters: number, durationSeconds: number): string | null {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return "distanceMeters must be a positive finite distance";
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 12 * 60 || durationSeconds > 4 * 60 * 60) {
    return "durationSeconds is outside the range a race result can occupy";
  }
  const pace = durationSeconds / (distanceMeters / 1_000);
  if (pace < 150 || pace > 900) {
    return "implied pace is outside the range a race result can occupy";
  }
  return null;
}

export interface PerformanceEntry {
  id: string;
  localDate: string;
  distance: PerformanceEntryDistance;
  durationSeconds: number;
  /** Only manual entry exists today; the field is here so provenance stays explicit. */
  source: "manual";
  note: string | null;
  /** When the runner entered it. The label counts from this instant, not the race date. */
  recordedAt: string;
  /** Tombstone timestamp. A revoked entry stays readable so the count reconciles. */
  revokedAt: string | null;
  revision: number;
  /** Present for a confirmed recorded workout; timestamps are copied by the server. */
  trainingSessionId?: string | null;
  observedAt?: string | null;
  completedAt?: string | null;
}

// -----------------------------------------------------------------------------
// Personal calibration progress (docs/ALGORITHM.md §12.11).
//
// A **relative** band, and deliberately not the population interval shape: it has no
// nominalCoverage, no P80/P90, and a claim string that says so. The client multiplies
// it by a rule prediction to show the runner their own band.
// -----------------------------------------------------------------------------

export interface PersonalCalibrationBand {
  policyVersion: string;
  method: "leave_one_out_relative_residual_v1";
  samples: number;
  evaluated: number;
  relativeLower: number;
  relativeCenter: number;
  relativeUpper: number;
  coverageClaim: "personal_self_calibrated_not_population_guarantee";
}

export interface PersonalCalibrationProgress {
  policyVersion: string;
  available: boolean;
  /** Labels that produced a held-out residual — the number the band is built from. */
  samples: number;
  /** Labels that exist, scored or not. */
  labelCount: number;
  scoredCount: number;
  distances: number;
  spanDays: number;
  minimumSamples: number;
  minimumDistances: number;
  minimumSpanDays: number;
  reasonCodes: string[];
  /** Null until the floors are met; the client then shows nothing but progress. */
  band: PersonalCalibrationBand | null;
}

// -----------------------------------------------------------------------------
// Share card (docs/WEB.md, docs/DECISIONS.md D9).
//
// A card is built by the **server** so that "hide my home" has exactly one
// implementation: the clients draw the polylines they are handed and never see the
// coordinates that were removed. `polylines` is a list rather than one line with
// gaps so a renderer cannot reconnect across a cut by accident.
// -----------------------------------------------------------------------------

export const SHARE_CARD_POLICY_VERSION = "rai-share-card-v1" as const;

export interface ShareCardRoutePoint {
  latitude: number;
  longitude: number;
}

export interface ShareCardResponse {
  trainingSessionId: string;
  generatedAt: string;
  privacy: {
    policyVersion: typeof SHARE_CARD_POLICY_VERSION;
    zonesApplied: number;
    /** Points inside a zone that were removed before this payload was built. */
    redactedPoints: number;
    /**
     * How many breaks the drawn line has because of zones. Counted as gaps rather
     * than as "segments overlapping a circle": with 50 m sampling a 200 m zone
     * overlaps ten segments, and that number tells a reader nothing about the card.
     */
    gaps: number;
    /** True when no zone is configured — the polylines are the raw route. */
    unfiltered: boolean;
  };
  workout: {
    startedAt: string;
    /** Passthrough of the stored value, like every other read response. */
    sessionType: string;
    distanceKm: number | null;
    durationSeconds: number;
    averagePaceSecondsPerKm: number | null;
    averageHeartRateBpm: number | null;
    elevationGainMeters: number | null;
    /** Minetti-equivalent flat pace, when the run had usable altitude data. */
    gradeAdjustedPaceSecondsPerKm: number | null;
  };
  polylines: ShareCardRoutePoint[][];
  /** What the reader should know about the card, e.g. why the line is broken. */
  note: string | null;
}

// -----------------------------------------------------------------------------
// Running dynamics (docs/ALGORITHM.md §19).
//
// Watch-reported stride metrics: cadence, stride length, vertical oscillation and
// ground contact time. They reach the database today and are drawn as raw series,
// but nothing analyses them — `packages/features` and `packages/scoring` reference
// them zero times. This contract is that read-out, and it is **display and evidence
// only**: no laboratory validation exists for this pipeline, so no value here may
// enter CA/TA, and `evidenceStatus` travels with every response saying so.
//
// Coverage is part of the contract rather than a UI concern: a watch that reported
// ground contact time for eight seconds of a one-hour run must be able to say
// "insufficient coverage" instead of producing an average that looks complete.
// -----------------------------------------------------------------------------

export const RUNNING_DYNAMICS_POLICY_VERSION = "rai-dynamics-v1" as const;

export type RunningDynamicsMetricName =
  | "cadence"
  | "stride_length"
  | "vertical_oscillation"
  | "ground_contact_time";

export type RunningDynamicsMetricStatus =
  | "available"
  | "partial"
  | "insufficient_coverage"
  | "unavailable";

export interface RunningDynamicsMetricAnalysis {
  name: RunningDynamicsMetricName;
  label: string;
  unit: string;
  status: RunningDynamicsMetricStatus;
  samples: number;
  /** Share of the run's duration the metric spans. Reported even when insufficient. */
  coverage: number;
  average: number | null;
  firstHalfAverage: number | null;
  secondHalfAverage: number | null;
  /** Relative change of the second half against the first, at comparable speed. */
  driftFraction: number | null;
  /** How many second-half samples found a speed-matched partner in the first half. */
  comparableSamples: number;
  reasonCodes: string[];
}

export interface RunningDynamicsFlag {
  code: string;
  metric: RunningDynamicsMetricName;
  detail: string;
  driftFraction: number;
  comparableSamples: number;
}

export interface RunningDynamicsAnalysis {
  policyVersion: typeof RUNNING_DYNAMICS_POLICY_VERSION;
  evidenceStatus: "device_estimated_not_lab_validated";
  metrics: RunningDynamicsMetricAnalysis[];
  flags: RunningDynamicsFlag[];
  note: string | null;
}

// -----------------------------------------------------------------------------
// Readiness V1 contract (docs/ALGORITHM.md §7.4).
//
// Additive only. `assessment` is deliberately kept separate from `state`:
// `assessment` is what the evidence says, `state` is the training-facing mapping
// of it, and `coverage === "none"` is a gap in evidence rather than a negative
// finding. `no_low_signal` is not named `ready` for the same reason — not having
// observed a low signal, especially on one signal only, is not the same as being
// fully recovered.
//
// Every `state` in this first version is a heuristic. `stateEvidence` carries
// that fact to every consumer so the API, the Coach explanation and the UI cannot
// present it as a validated medical threshold.
// -----------------------------------------------------------------------------

export const READINESS_MODEL_VERSION = "rai-readiness-v1.0.0" as const;
export const READINESS_RULE_SET_VERSION = "rai-readiness-ruleset-v1" as const;

export type ReadinessCoverage = "none" | "partial" | "complete";

export type ReadinessAssessment =
  | "not_assessed"
  | "no_low_signal"
  | "low_signal"
  | "multiple_low_signals";

export type ReadinessState = "not_assessed" | "no_low_signal" | "caution" | "strained";

export type ReadinessSignalName = "sleep" | "hrv" | "rhr";

export type ReadinessSignalQuality = "adequate" | "sparse" | "missing";

export interface ReadinessSignal {
  availabilitySource?: "canonical_computation" | "dataset_publication_upper_bound" | "unknown";
  name: ReadinessSignalName;
  /** Today's observation. `null` means not measured, never "normal". */
  value: number | null;
  /** Personal reference the value is compared against. */
  baseline: number | null;
  /** value / baseline. `null` when either side is missing or non-positive. */
  ratio: number | null;
  /** True when this signal alone met its low/raised rule. */
  low: boolean;
  quality: ReadinessSignalQuality;
  observedAt: string | null;
  /** When the system learned the reading; drives freshness, not the value. */
  availableAt: string | null;
  /** Local date the reading belongs to. */
  evidenceLocalDate: string | null;
}

export interface ReadinessStateEvidence {
  method: "heuristic_rules";
  /**
   * `not_empirically_validated` until a report against a declared target and an
   * independent holdout exists. Passing compatibility tests only proves the new
   * rules match the old ones — it is not validation.
   */
  validationStatus: "not_empirically_validated" | "validated_for_declared_target";
  ruleSetVersion: string;
  validationTarget: string | null;
  validationReportId: string | null;
}

/**
 * `score` stays null while `scoreStatus === "not_calibrated"`: the first version
 * drives Coach from `state`, and turning the heuristic ratios into a 0-100 number
 * would present them as something they are not.
 */
export interface ReadinessAssessmentResult {
  modelVersion: typeof READINESS_MODEL_VERSION;
  asOf: string;
  localDate: string;
  coverage: ReadinessCoverage;
  assessment: ReadinessAssessment;
  state: ReadinessState;
  stateEvidence: ReadinessStateEvidence;
  intendedUse: "training_guidance_not_diagnosis";
  score: number | null;
  scoreStatus: "not_calibrated" | "available";
  signals: Record<ReadinessSignalName, ReadinessSignal>;
  /**
   * Whether the sleep baseline streak rule fired. Exposed rather than recomputed
   * by callers: the threshold lives with the rules, and a wrapper that re-derives
   * it would be the second copy the design forbids.
   */
  sleepStreak: boolean;
  reasonCodes: string[];
}

/** The same result with the provenance envelope attached at assembly time. */
export interface ReadinessSnapshot extends ReadinessAssessmentResult {
  lineage: ModelLineageV2;
}

// ---------------------------------------------------------------------------
// 域快照的窄化读取（sealed domain snapshots）
//
// 为什么要有这一组函数：信封层（`ModelSnapshotEntry.payload`）刻意是 `unknown`，
// 因为各域存的东西完全不同 —— `fitness` 存 `{lineage, assessments, daily}`、
// `load` 存 `{lineage, days}`、`durability` 存的是**数组**。消费方若自己断言一个形状，
// 就会去读产出端**根本没写过**的字段（而 TypeScript 不会拦，因为源头是 unknown）。
//
// 所以窄化只做一次，放在双方共享的契约层：**必需字段缺失 ⇒ 返回 null**，
// 绝不用 `undefined` 冒充"没有值"。
// ---------------------------------------------------------------------------

export interface FitnessSnapshotDailyPoint {
  localDate: string;
  trueAbility: number | null;
  status: string;
}

/**
 * 已封存的 `fitness` 域快照。
 * V2 写入 `{lineage, assessments, daily}`；legacy 分支写 `{assessments, daily}`（**没有** lineage）。
 */
export interface FitnessSnapshot {
  /** `null` = 该运行没有可用的 epoch（legacy 写入，或当时无法确定）——不是"等于当前 epoch"。 */
  baselineEpochId: string | null;
  daily: FitnessSnapshotDailyPoint[];
}

/** 已封存的 `load` 域快照。V2 写入 `{lineage, days}`。 */
export interface LoadSnapshot {
  baselineEpochId: string | null;
  /** 行是 `daily_training_metrics` 的投影；这里只承诺"是一组行"，不假装逐列类型化。 */
  days: Array<Record<string, unknown>>;
}

function snapshotBaselineEpochId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const lineage = (payload as { lineage?: unknown }).lineage;
  if (typeof lineage !== "object" || lineage === null) return null;
  const epoch = (lineage as { baselineEpochId?: unknown }).baselineEpochId;
  return typeof epoch === "string" && epoch !== "" ? epoch : null;
}

function snapshotRows(payload: unknown, key: "daily" | "days"): unknown[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const rows = (payload as Record<string, unknown>)[key];
  return Array.isArray(rows) ? rows : null;
}

/** `fitness` 窄化：`daily` 不是数组、或无一行带可用的 `local_date` ⇒ `null`。 */
export function readFitnessSnapshot(payload: unknown): FitnessSnapshot | null {
  const rows = snapshotRows(payload, "daily");
  if (rows === null) return null;
  const daily: FitnessSnapshotDailyPoint[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const source = row as Record<string, unknown>;
    // 必需字段缺失就跳过这一行，而不是把 undefined 读成"没有值"。
    if (typeof source.local_date !== "string" || source.local_date === "") continue;
    daily.push({
      localDate: source.local_date,
      trueAbility: typeof source.true_ability === "number" && Number.isFinite(source.true_ability)
        ? source.true_ability
        : null,
      status: typeof source.snapshot_status === "string" ? source.snapshot_status : "unknown"
    });
  }
  if (daily.length === 0) return null;
  return { baselineEpochId: snapshotBaselineEpochId(payload), daily };
}

/**
 * `load` 窄化。
 * 刻意**不**接受 `daily` 这个键：把 fitness 的字段名当成通用的，正是这层要挡住的那类错误。
 */
export function readLoadSnapshot(payload: unknown): LoadSnapshot | null {
  const rows = snapshotRows(payload, "days");
  if (rows === null) return null;
  const days = rows.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
  if (days.length === 0) return null;
  return { baselineEpochId: snapshotBaselineEpochId(payload), days };
}

/**
 * 已封存的 `readiness` 域快照。V2 写入 `ReadinessAssessmentResult & {lineage}`。
 *
 * `stateEvidence` 是**必需**字段，不是可选装饰：§7.4 要求启发式/验证标签随数字一起到达
 * 每个消费方（API、Coach 解释、界面）。读端把它当可选项丢掉，就等于让未经验证的阈值
 * 在别处装成已验证的医学阈值。
 */
export interface ReadinessSnapshotView {
  /** `null` = 该运行没有可用的 epoch —— 不是"等于当前 epoch"。 */
  baselineEpochId: string | null;
  asOf: string;
  localDate: string;
  coverage: ReadinessCoverage;
  /** 证据说了什么。与 `state`（面向训练的映射）刻意分开：缺口不是阴性发现。 */
  assessment: ReadinessAssessment;
  state: ReadinessState;
  stateEvidence: ReadinessStateEvidence;
  /** `score: null` + `scoreStatus: "not_calibrated"` 是契约定义的合法状态，不是缺值。 */
  score: number | null;
  scoreStatus: "not_calibrated" | "available";
  /** 三个通道**缺一不可**：少一个通道不是"更小的快照"，而是不可比的另一份快照。 */
  signals: Record<ReadinessSignalName, ReadinessSignal>;
  /**
   * 睡眠基线连续不足是否触发。由规则自身产出，读端**不重算** —— 重算就是设计禁止的第二份阈值。
   */
  sleepStreak: boolean;
  /**
   * 解释层只格式化/翻译这些码，不重新执行阈值分支（§13.3）。
   * 空数组合法（确实没有可说的理由），但**键必须存在**：缺席是畸形 payload。
   */
  reasonCodes: string[];
  /**
   * 顶层 freshness。产出端把观测/到达时间记在各信号上，所以这里只有 payload 真写过才带出；
   * 缺席一律 `null`，**不**用 `asOf` 冒充"就是今天的"。
   */
  availableAt: string | null;
  observedAt: string | null;
  evidenceLocalDate: string | null;
}

const READINESS_COVERAGES = ["none", "partial", "complete"] as const;
const READINESS_ASSESSMENTS = ["not_assessed", "no_low_signal", "low_signal", "multiple_low_signals"] as const;
const READINESS_STATES = ["not_assessed", "no_low_signal", "caution", "strained"] as const;
const READINESS_SCORE_STATUSES = ["not_calibrated", "available"] as const;
const READINESS_SIGNAL_QUALITIES = ["adequate", "sparse", "missing"] as const;
const READINESS_VALIDATION_STATUSES = ["not_empirically_validated", "validated_for_declared_target"] as const;
const READINESS_AVAILABILITY_SOURCES = ["canonical_computation", "dataset_publication_upper_bound", "unknown"] as const;

/** 枚举成员判定：不做大小写/前缀兜底 —— 不认识就是"这不是一份 readiness 快照"。 */
function snapshotMember<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** 可选字符串：只有非空字符串才带走；缺席、空串、非字符串一律 `null`。 */
function snapshotString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 可选数值：非有限（NaN / ±Infinity）归一到 `null`，不让它漏进 JSON 与图表。 */
function snapshotNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 必需数值：`null` 合法（契约里的"没有值"）；缺席或非有限返回 `undefined`，表示畸形。 */
function snapshotStrictNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function snapshotStateEvidence(value: unknown): ReadinessStateEvidence | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const method = source.method;
  if (method !== "heuristic_rules") return null;
  const validationStatus = source.validationStatus;
  if (!snapshotMember(READINESS_VALIDATION_STATUSES, validationStatus)) return null;
  const ruleSetVersion = snapshotString(source.ruleSetVersion);
  if (ruleSetVersion === null) return null;
  return {
    method,
    validationStatus,
    ruleSetVersion,
    validationTarget: snapshotString(source.validationTarget),
    validationReportId: snapshotString(source.validationReportId)
  };
}

function snapshotReadinessSignal(value: unknown, name: ReadinessSignalName): ReadinessSignal | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  // `name` 必须等于它所在的键：否则消费方取 `signals.sleep`，拿到的是另一条通道。
  if (source.name !== name) return null;
  const signalValue = snapshotStrictNumber(source.value);
  const ratio = snapshotStrictNumber(source.ratio);
  if (signalValue === undefined || ratio === undefined) return null;
  const low = source.low;
  if (typeof low !== "boolean") return null;
  const quality = source.quality;
  if (!snapshotMember(READINESS_SIGNAL_QUALITIES, quality)) return null;
  const signal: ReadinessSignal = {
    name,
    value: signalValue,
    baseline: snapshotNumber(source.baseline),
    ratio,
    low,
    quality,
    observedAt: snapshotString(source.observedAt),
    availableAt: snapshotString(source.availableAt),
    evidenceLocalDate: snapshotString(source.evidenceLocalDate)
  };
  const availabilitySource = source.availabilitySource;
  if (snapshotMember(READINESS_AVAILABILITY_SOURCES, availabilitySource)) signal.availabilitySource = availabilitySource;
  return signal;
}

/**
 * `readiness` 窄化。payload 由 `readinessForRun` 产出，形状是
 * `ReadinessAssessmentResult & {lineage}`。
 *
 * 这里刻意**不做任何兜底**：把缺失的 `state` 补成 `not_assessed`、把缺失的信号通道当成
 * "没测到"，都会把"这根本不是一份 readiness 快照"翻译成一句健康结论 —— 正是本层要挡住的
 * "未知被读成正常"。fitness 的 `daily` / load 的 `days` 因为拿不出这些必需字段，
 * 自然返回 `null`（不需要为它们写特例）。
 */
export function readReadinessSnapshot(payload: unknown): ReadinessSnapshotView | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  const asOf = snapshotString(source.asOf);
  const localDate = snapshotString(source.localDate);
  if (asOf === null || localDate === null) return null;
  const coverage = source.coverage;
  if (!snapshotMember(READINESS_COVERAGES, coverage)) return null;
  const assessment = source.assessment;
  if (!snapshotMember(READINESS_ASSESSMENTS, assessment)) return null;
  const state = source.state;
  if (!snapshotMember(READINESS_STATES, state)) return null;
  const scoreStatus = source.scoreStatus;
  if (!snapshotMember(READINESS_SCORE_STATUSES, scoreStatus)) return null;
  const stateEvidence = snapshotStateEvidence(source.stateEvidence);
  if (stateEvidence === null) return null;
  // 缺 `score` 不等于 `score: null`：前者是畸形 payload，后者是契约定义的"未标定"。
  const score = snapshotStrictNumber(source.score);
  if (score === undefined) return null;
  const rawSignals = source.signals;
  if (typeof rawSignals !== "object" || rawSignals === null) return null;
  const signalSource = rawSignals as Record<string, unknown>;
  const sleep = snapshotReadinessSignal(signalSource.sleep, "sleep");
  const hrv = snapshotReadinessSignal(signalSource.hrv, "hrv");
  const rhr = snapshotReadinessSignal(signalSource.rhr, "rhr");
  if (sleep === null || hrv === null || rhr === null) return null;
  const sleepStreak = source.sleepStreak;
  if (typeof sleepStreak !== "boolean") return null;
  const reasonCodes = source.reasonCodes;
  // 空数组合法，但必须是数组且元素是非空字符串：把 `[""]` 或含数字的数组读成理由码，
  // 会让解释层去翻译一个不存在的 code。
  if (!Array.isArray(reasonCodes) ||
      reasonCodes.some((code) => typeof code !== "string" || code === "")) return null;
  return {
    baselineEpochId: snapshotBaselineEpochId(payload),
    asOf,
    localDate,
    coverage,
    assessment,
    state,
    stateEvidence,
    score,
    scoreStatus,
    signals: { sleep, hrv, rhr },
    sleepStreak,
    reasonCodes: [...(reasonCodes as string[])],
    availableAt: snapshotString(source.availableAt),
    observedAt: snapshotString(source.observedAt),
    evidenceLocalDate: snapshotString(source.evidenceLocalDate)
  };
}
