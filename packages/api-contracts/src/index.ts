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
  UpdateTrainingZoneProfileInput,
  DirectSyncReceipt,
  IngestStatus,
  AnalysisStatus
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
  AnalysisBlockRow,
  AnalysisView,
  DirectSyncReceipt,
  FactsBlockRow,
  FactsView,
  FactVersions,
  Freshness,
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
  /**
   * 2026-10-21（PR-02）：统一训练**读**合同能力。`2` = `GET
   * /v1/mobile/training-plan-state` 在 `X-RAI-Training-Contract: 2` 下可用。
   *
   * 🔴 读能力 != 该 scope 已迁移：未迁移的 scope 仍返回类型化 409
   * `training_plan_not_migrated`，客户端必须分别处理"能力存在"和"scope 未迁移"。
   * managed scope 在已迁移且 owner-ready 时也可宣告；这不开放 legacy 聚合读。
   */
  trainingPlanContractVersion?: number;
  /**
   * 2026-10-21（PR-02）：统一训练**写命令**合同能力（`/training-plan/commands*`）。
   *
   * 与读能力分开是刻意的：命令面可写不代表 WorkoutKit 执行获准，也不代表该
   * scope 已完成迁移。仅 validation 模式、owner-ready 且同请求精确协商时宣告 2；
   * 生产保持省略。客户端缺位时只读，不能用 coachLoopContractVersion 猜测。
   */
  trainingPlanCommandContractVersion?: number;
  /** B01 registered only; B02+ may advertise exact version 1 after acceptance. */
  trainingPlanSessionContractVersion?: number;
  trainingPlanSessionCommandContractVersion?: number;
  trainingPlanExecutionCommandContractVersion?: number;
  trainingPlanUpdateContractVersion?: number;
  /** Opt-in coach-loop aggregate/commands; legacy plan DTOs retain their meaning. */
  coachLoopContractVersion?: number;
  planPublicationContractVersion?: number;
  planReceiptContractVersion?: number;
  /** 直连原始回执能力：1 = summary.directSync 会带 ingestStatus/analysisStatus。老服务端省略。 */
  factsAnalysisContractVersion?: number;
  /**
   * 两块视图能力（PR5 D1.4）：1 = `/v1/workouts`、`/v1/mobile/today`、
   * `/v1/mobile/training-plan-state` 会带 `currentFacts` / `publishedAnalysis`
   * （`training-plan-state` 另带 `metadata.versions`/`metadata.freshness`）。
   * 老服务端省略。
   *
   * 🔴 与上面那个能力位**是两个不同的东西**，不要合并成一个数字：
   * - `factsAnalysisContractVersion` = 直连**回执**（写入时刻的凭证，PR1）；
   * - 本字段 = 读侧**两块行视图**（PR5）。
   * 它们由不同的批次落地、可以各自演进（回执已经冻结，两块视图还会加行类型）。
   * 一个数字承担两种语义，会让"服务端到底升级了哪一侧"变成没人能回答的问题 ——
   * 这正是本仓反复付过代价的那个形态（对照 `packages/contracts/src/direct-sync.ts`
   * 里 `rawGeneration` 被删掉的理由）。
   */
  factsAnalysisViewContractVersion?: number;
  /**
   * 直连车道的单批上界（观测版阶段 1 新增；客户端用它做拆批预算，缺省即回落到保守常量）。
   * 数值单一来源 = `apps/api/src/direct-sync-ingest.ts` 的顶层常量
   * （XML/manifest ≤ 8 MiB、route ≤ 200 文件 / 64 MiB；2026-10-14 由 2 MiB / 32 MiB 放宽）。
   * 老服务端省略本键。
   *
   * 🔴 `maxRecords` 在直连车道**只约束"删除配额"**，**不**约束 XML 里的记录条数 ——
   * 服务端量的是 `manifest.deletedRecords.length + manifest.deletedWorkoutIds.length`
   * （`direct-sync-ingest.ts` 的 `preflightDirectSyncPayload`，拒因 `deletions_exceed_bounds`）。
   * 也就是说客户端按这一维拆批是**单边自律**：拆得比它小只会多分几批；但反向不成立 ——
   * "XML 记录条数超过 `maxRecords`"**不会**被服务端拒绝，别把它当成一条服务端保证。
   * 刻意**不**为此新增服务端拒绝路径：直连车道刚因为"收口后多一条硬拒"被真机引爆过一次
   * （`route_exceeds_bounds` 让同步链卡死），不再加断崖。
   */
  directSyncBounds?: {
    maxXmlBytes: number;
    maxRecords: number;
    maxRouteFiles: number;
    maxRouteBytes: number;
  };
  /**
   * 服务端覆盖探测能力（P1-1）：1 = 支持 `GET /v1/sync/coverage`。
   * 老服务端省略；客户端据此决定是否跳过已覆盖类型的历史重放。
   */
  syncCoverageVersion?: number;
}

export interface MobilePlanOperationScope {
  serverId: string;
  athleteId: string;
  datasetEpoch: string;
}

/**
 * `GET /v1/mobile/plan-operations/:id` 的四种终局状态（`handshake.planPublicationContractVersion = 1`）。
 *
 * 🔴 这是一份**共享单源**，不是文档抄写：服务端生产者是
 * `apps/api/src/mobile-goals.ts` 的 `publicationResult()`，消费方是
 * `apps/api/src/plan-publication.ts` 的 `result()` 与 iOS 的
 * `PlanPublicationResult`（`apps/ios/RAI/PlanStatePolicy.swift`）。
 * 四者的语义差别是**重试语义**，不是措辞差别：
 *
 * - `committed`：原操作已提交，`result` 是当时的**原结果**；重放必须直接返回它，
 *   不得再执行一次业务（这正是 `planPublicationContractVersion` 存在的理由）。
 * - `notFound`：当前 scope 下没有该操作行。**只有**这一种允许按原键、原字节重试；
 *   客户端随后用持久化的原请求重放。
 * - `scopeMismatch`：该 operationId 属于**其他** serverId/athleteId/datasetEpoch。
 *   终局：同一份载荷永远不会在当前身份下成功，客户端应作废本地账目而不是重试。
 * - `expired`：结果已过 90 天保留期（或已成墓碑），返回 HTTP 410；终局，不得重新执行。
 *
 * 老服务端没有本端点（`planPublicationContractVersion` 缺省），客户端不得把
 * "查不到"当作 `notFound` 去重放 —— 那会把一次网络失败变成第二次发布。
 */
export const MOBILE_PLAN_OPERATION_QUERY_STATUSES = [
  "committed",
  "notFound",
  "scopeMismatch",
  "expired"
] as const;
export type MobilePlanOperationQueryStatus = (typeof MOBILE_PLAN_OPERATION_QUERY_STATUSES)[number];

/**
 * `GET /v1/mobile/plan-operations/:id` 的响应体（可辨识联合，按 `status` 收窄）。
 *
 * `committed` 携带原操作的结果（`Result` 由发起该操作的客户端按路由自行决定形状，
 * 所以这里默认 `unknown`：本契约保证的是**信封**，不是每个发布路由的结果体）。
 * 其余三种状态**没有** `result` —— 读到 `result: null` 与"没有这个键"在语义上相同，
 * 消费方不得据 `undefined` 推断业务已成功。
 */
export type MobilePlanOperationQueryResponse<Result = unknown> =
  | { status: "committed"; operationId: string; result: Result }
  | { status: "notFound"; operationId: string }
  | { status: "scopeMismatch"; operationId: string }
  | { status: "expired"; operationId: string };

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
  /**
   * 可见性状态（P0-1，2026-10-18 同步诊断）：
   * 事实已提交但分析尚未发布时，列表/详情仍可读（派生字段为 null/占位），
   * 用本字段诚实标出 `pending`。老服务端省略 ⇒ undefined，消费方按已发布处理。
   *
   * A6（2026-10-19）：`pending` 不再只表示"从未发布"——**旧分析可用、新分析未发布**
   * 也是 `pending`，此时派生字段是旧分析的取值（不是占位）。两者由
   * {@link WorkoutListItem.analysisAvailable} 区分。
   */
  analysisPublishStatus?: AnalysisPublishStatus;
  /**
   * A6（2026-10-19）：**旧分析是否仍可读**（存在指向当前 active release 的评估行）。
   *
   * - `analysisPublishStatus = "published"` ⇒ 本字段必然为 `true`；
   * - `"pending"` / `"failed"` + `analysisAvailable = true` ⇒ 旧分析字段仍可读，
   *   但它**没有覆盖**本训练的最新事实代次，不得当作最新结论展示；
   * - `false` ⇒ 从未发布过分析，派生字段是 null/占位（P0-1 的原始语义）。
   *
   * 老服务端省略 ⇒ undefined：此时只能退回 `analysisPublishStatus`，把 `pending`
   * 一律按"占位行"处理（保守，不会把旧分数冒充最新）。
   */
  analysisAvailable?: boolean;
}

/**
 * 读侧可见性状态（P0-1）。
 *
 * - `pending`：事实（workout/session/records）已提交，派生分析尚未发布到**当前事实代次**；
 *   `analysisAvailable = false` 时派生字段为 null/占位，**不得**把 pending 当失败或不存在。
 *   A6（2026-10-19）：**旧分析可用**时状态也是 `pending`（见 `analysisAvailable`），
 *   此时派生字段是旧分析取值，不是占位。
 * - `published`：分析已发布且覆盖本训练的最新事实代次，派生字段可用。
 * - `failed`：更新事实的分析任务失败；事实与（若有）旧分析仍可读。
 */
export type AnalysisPublishStatus = "pending" | "published" | "failed";

/** A5（P2-3，2026-10-19）：数据交付状态。 */
export type WorkoutDeliveryState = "delivered" | "partial" | "unknown";

/** A5（P2-3）：分析状态（与 {@link AnalysisPublishStatus} 同值域，独立列出便于契约自解释）。 */
export type WorkoutAnalysisState = AnalysisPublishStatus;

/** A5（P2-3）：观测稳定性。**只有它**受 24h 静默窗口影响。 */
export type WorkoutStabilityState = "stable" | "settling";

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
  /**
   * 两块视图（PR5 S4）。**可选**：老服务端完全不返回这两个键，而显式返回 `null`
   * 表示"本端点还没有这一侧视图"（D1.2：`null` 与空对象是两件事，空对象会撒谎）。
   *
   * ⚠️ 与 `items` 的并存是**刻意的**：`items` 是今天那个"混过"的列表（已知过渡态），
   * 两块是分开的视图。这正是"区分而不改名"，也是不制造 flag day 的唯一做法。
   */
  currentFacts?: FactsView | null;
  publishedAnalysis?: AnalysisView | null;
}

/**
 * `GET /v1/workouts/:id/freshness`（P0-3，2026-10-18 同步诊断）。
 *
 * 只回答"这次训练的事实到齐了多少、分析到哪一步"，不读派生评分。
 * 每指标 `state` 必须区分「已见到」与「还没见到」——后者不等于设备不支持。
 */
export interface WorkoutFreshnessMetric {
  /** 逻辑指标名（heartRate/speed/power/cadence/strideLength/verticalOscillation/groundContactTime/elevation）。 */
  metric: string;
  /** 本次训练窗口内的样本数（elevation 为路线点数）。 */
  samples: number;
  /** `not_seen_yet` = 目前没有样本，可能是手表还没送达；不是"设备没有该能力"。 */
  state: "present" | "not_seen_yet";
  /** P2-2：该指标最近一次被服务端接收的时刻（`health_records.available_at`）；旧库/旧行为 null。 */
  lastAvailableAt?: string | null;
}

export interface WorkoutFreshnessFacts {
  /** workout 实体第一次被提交的批次完成时刻；null = 尚未找到（异常/旧库）。 */
  committedAt: string | null;
  /** 最近一次把本训练窗口事实写入服务端的批次完成时刻。 */
  lastBatchAt: string | null;
  /** 触及本训练的批次数（workout + 窗口内记录）。 */
  batches: number;
}

export interface WorkoutFreshnessAnalysis {
  status: AnalysisPublishStatus;
  /**
   * A6（2026-10-19）：旧分析是否仍可读（存在指向 active release 的评估行）。
   * `status = "published"` 时必为 `true`；`"pending"/"failed"` + `true` ⇒
   * 旧分析字段仍可读，但没有覆盖最新事实代次（{@link WorkoutFreshnessAnalysis.publishedAt} 是旧发布时刻）。
   */
  available: boolean;
  /** 触发本训练分析的 recompute job id；无则 null。 */
  jobId: string | null;
  /** 分析发布（active model run 激活）时刻；未发布为 null。 */
  publishedAt: string | null;
}

export interface WorkoutFreshnessResponse {
  workoutId: string;
  facts: WorkoutFreshnessFacts;
  analysis: WorkoutFreshnessAnalysis;
  series: WorkoutFreshnessMetric[];
  /**
   * A5（P2-3，2026-10-19）：三态拆分的**可选增量字段**（老服务端省略）。
   *
   * `deliveryState` 回答"事实到齐服务端没有"，`analysisState` 回答"分析覆盖到最新代次没有"，
   * `stabilityState` 回答"观测是否已经稳定"。**24h 静默只影响 `stabilityState`**，
   * 不参与 delivery/analysis。
   *
   * `deliveryState` 的服务端口径（退化分支，必须与 docs/IOS_NATIVE_API_CONTRACT.md 一致）：
   * 服务端没有客户端"本次读到了哪些类型"的回执，只能给**到达证据**：
   * - `unknown`：没有任何到达证据（`facts.batches = 0`）——"不知道"，**不是**"设备在传"；
   * - `partial`：只有窗口内记录账本、没有 workout 实体写入证据（数据面不完整）；
   * - `delivered`：本训练的 workout 实体已由成功批次交付到服务端。
   * 它**不**声称"手机已读尽"，也不声称某指标设备一定具备。
   */
  deliveryState: WorkoutDeliveryState;
  analysisState: WorkoutAnalysisState;
  stabilityState: WorkoutStabilityState;
  /**
   * `complete` = 分析已发布且最近 24h 没有新事实到达（数据已稳定）；
   * `partial` = 仍可能继续补齐（手表迟到样本/分析中）。
   * 这是**传输/分析**的完整性，不是"设备是否具备某项传感器能力"。
   *
   * ⚠️ A5 本轮**不改**本字段语义（下一版才改成 `deliveryState = delivered && analysisState = published`）；
   * 三态信息请读上面的新字段。
   */
  completeness: "partial" | "complete";
}

/**
 * `GET /v1/sync/coverage`（P1-1）：服务端每个记录类型已知覆盖区间。
 *
 * 只用于**避免重传服务端已有历史**；客户端不得据此删除本地游标或跳过真正的待办。
 */
export interface SyncCoverageType {
  type: string;
  knownFrom: string | null;
  knownUntil: string | null;
  sampleCount: number;
}

export interface SyncCoverageResponse {
  datasetEpoch: string;
  types: SyncCoverageType[];
}

export interface RoutePointDto {
  latitude: number;
  longitude: number;
  elevationMeters: number | null;
  speedMetersPerSecond: number | null;
  timestamp: string | null;
}

/**
 * 事实侧 / 分析侧的**两块视图**（PR5 D1、D5，见 `docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md` §2）。
 *
 * 🔴 **形状住在 `@rai/contracts`，这里只转发**（包边界，2026-10-13 实测修正）：
 * 读侧实现（`packages/storage-sqlite/src/read/fact-read-view.ts`）要**构造**这两个视图，
 * 而 `storage-sqlite` 不依赖 `api-contracts`。形状留在这里会让它出现一条向上的 import ——
 * `tsc` 与测试全绿，只有 `npm run check:package-boundaries` 看得见（未声明的 src 边 +
 * `package.json` 缺依赖 ⇒ 干净安装会崩）。三条硬约束与各字段的理由随形状一起搬到了
 * `packages/contracts/src/facts-analysis-view.ts`，不要在这里重写一遍。
 */
export type {
  AnalysisBlockRow,
  AnalysisView,
  FactsAnalysisBlocksDisjoint,
  FactsBlockRow,
  FactsView
} from "@rai/contracts";

export { type FactVersions, type Freshness };

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
  workout: WorkoutListItem & {    elapsedSeconds: number;
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
  /**
   * 两块视图（PR5 S4/S5）。**可选**，`null` = 本端点还没有这一侧视图。
   *
   * 🔴 这里的路线是 S5 的正题（D5 最后一段）：分析块走 `route_versions`
   * （`status='complete'` + `workout_routes.published_route_version_id` +
   * `route_version_points` 按 `sequence`），事实块走当前 `route_points`。
   * 老库指针为 `NULL` 时分析块**允许退化**读当前 `route_points`，并标
   * `routeVersionId: null` —— 退化必须**可观测**，否则"读了版本表"与"退化了"
   * 在响应里长得一模一样，C8 就没有牙。
   */
  facts?: {
    workoutId: string;
    route: RoutePointDto[];
    routeVersionId: null;
    analysisState: FactsBlockRow["analysisState"];
  } | null;
  analysis?: {
    workoutId: string;
    releaseId: string | null;
    route: RoutePointDto[];
    /** `null` = **退化读取**（老库没有已发布版本指针），不是"没有路线"。 */
    routeVersionId: string | null;
    stale: boolean;
    factDeleted: boolean;
  } | null;
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
  /**
   * v35 的分析任务绑定列（PR5 C10）。**可选**，且"缺键"是有含义的取值：
   * v35 之前登记的老任务这四列是 NULL，DTO 里就不出现这些键。
   *
   * 🔴 旧任务为什么必须是 `undefined` 而不是 `null`：C10 的原句是"旧任务为 `undefined`
   * （12 个旧字段逐个不变）"。若把老任务补成 `null`，"没有绑定"与"绑定到空值"
   * 就再也分不开了，而消费方（分析状态派生、任务对账）要问的第一个问题正是这个。
   */
  targetRawGeneration?: number;
  targetDependencyGeneration?: number;
  expectedIncumbentReleaseId?: string;
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

/**
 * 导入各阶段的耗时。**平铺且互斥**：任何两个阶段的时间区间不得重叠 ——
 * `worker.test.ts` 会断言 `totalMs >= ΣstagesMs`，重叠会让那条断言变成假绿。
 *
 * 2026-10-11：`backup` 拆成 `backupCapacity` / `backupCopy` / `backupVerify`，
 * `activation` 拆成 `activationAudit` / `activationSwap`。
 * 原因：线上一次导入 `backup` 254 s、`activation` 258 s（合计 73.5%），
 * 而独立进程做同一个备份只要 12.4 s ⇒ 旧口径把三件事/两件事糊在一个数字里，无法定位。
 * 旧口径对照：`backup` ≈ 三者之和，`activation` = `activationAudit + activationSwap`。
 */
/**
 * 阶段名的**运行期单一来源**（2026-10-15，审查 A1）：`stagesMs` 的响应描述
 * （`apps/api/src/schemas.ts`）此前手抄了一份 11 项列表、漏了 `directSyncApply`
 * ⇒ 文档枚举与类型全集漂移。现在两边都从这里派生：schema 用 `IMPORT_STAGES`
 * 生成属性表，`schemas.test.ts` 断言"schema 键集 == IMPORT_STAGES"，手抄不再可能。
 */
export const IMPORT_STAGES = ["dataOnlyApply", "directSyncApply", "backupCapacity", "backupCopy", "backupVerify",
  "stagingCopy", "parseImport", "changeAnalysis", "recompute", "activationAudit", "activationSwap", "cleanup"] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];

/**
 * `directSyncApply` 与 `dataOnlyApply` 分开计时的理由与上面 `activation` 拆分的理由相同：
 * 两者是**不同的车道**（前者接受 Workout / 评分类型 / 显式删除 / GPX 并可能登记分析任务，
 * 后者在入口就证明载荷结构上碰不到分析）。糊在一个数字里，直连车道的耗时变化就定位不到 ——
 * 而"哪条车道、耗时多少"正是 §14.3 P01–P06 要看的量。
 */
/**
 * 直连车道的**结构化拒收记录**（2026-10-14，观测版；实施方案 §5.2 S1.1）。
 *
 * 为什么要有它：直连尝试被拒后整批走候选链路（备份→整库校验→换库，线上 9.9–13.3 min，
 * 其中两次全库 `PRAGMA quick_check` 占 71.5–76.9%），而"为什么被拒"此前**零日志零遥测**
 * （`import-worker.ts` 直连段与 `direct-sync-ingest.ts` 全文无 log 语句）。
 * 这里把拒因带出来落进 `performance_json`，并由主线程补结构化日志。
 */
export interface ImportLaneRejection {
  /** 哪条车道/预检拒的。`preflight` = 载荷摘要都算不出来（`computeImportPayloadSha256` 失败）。 */
  source: "preflight" | "data-only" | "direct-sync";
  /** 稳定机器码（direct-sync 侧见 `DirectSyncRejection.reason`；data-only 侧恒为 `fast_path_rejected`）。 */
  reason: string;
  /** 拒收发生在哪一步（读取 / 准备 / 身份 / 事务）。 */
  stage: string;
  /** 人类可读补充（只含计数与键名，不含健康数据）。 */
  detail?: string;
  /** 实测值（计数/字节）。 */
  actual?: Record<string, number>;
  /** 触发拒收的上界。 */
  bounds?: Record<string, number>;
}

/**
 * 每次同步的**车道决策**遥测（`performance_json.lane`）。
 *
 * 验收口径（实施方案 §5.2 S1.3 的**时点记录**，2026-10-12）：跑一条直连、一条回退，本字段分别为
 * `outcome: "direct"`（`directSource` 标出哪条子车道）与 `outcome: "fallback"`（附 reasons/rejections）。
 * ⚠️ 2026-10-15 注：收口（`ed556a3`）后"回退旧链路"已不存在 —— `fallback` 现在的含义是
 * 「两条直连子车道都拒收、任务以稳定码终态失败」（reasons/rejections 一并携带）。
 * `unchanged` = 载荷与上次一致、在**车道判定之前**早退（既非直连也非回退）。
 */
export interface ImportLaneTelemetry {
  outcome: "direct" | "fallback" | "unchanged";
  /** `outcome=direct` 时：哪条子车道接住的。 */
  directSource?: "data-only" | "direct-sync";
  /** `planDirectSyncLane` 的否决理由原样（如 `fast_path_disabled` / `engine_<name>`）；放行时为空数组。 */
  reasons: string[];
  /** 逐条拒收记录（按尝试顺序；仅 fallback 时有意义）。 */
  rejections?: ImportLaneRejection[];
}

export interface ImportJobPerformance {
  /** Extra full replay comparison only; the model activation gate stays enabled. */
  validationMode: "shadow" | "off" | "not-run";
  totalMs: number;
  stagesMs: Partial<Record<ImportStage, number>>;
  computeStagesMs?: Record<string, number>;
  // ⚠️ 2026-10-15（G4）：`computeProcessMaxRssKiB` 与 `native` 两键已随 CLI 子进程链路退场
  // 删除（唯一写入端 command() 的 IPC 回调退役；web/iOS 无消费者）。
  // 🔴 订正（2026-10-15 晚，部署实测）：此前写"残留键会被响应 schema（additionalProperties:
  // false）剥掉"**不成立** —— 运行时没有任何 response schema 层（OpenAPI 文档的
  // `additionalProperties: false` 不参与序列化）。现由公开层白名单剥掉：`import-worker.ts`
  // 的 `publicPerformance`；数据层不重写历史行。
  /** 每次同步的车道决策与拒因（观测版阶段 1；老持久化作业没有该键）。 */
  lane?: ImportLaneTelemetry;
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
  /**
   * 稳定机器码的失败原因（收口阶段 3 起；成功/老持久化作业没有该键）。
   *
   * 客户端（iOS）据此分支处置：`direct_sync_payload_exceeds_bounds` ⇒ 收敛拆批预算后重传；
   * `direct_sync_unavailable` ⇒ 退避重试；`direct_sync_baseline_rebuild_required` ⇒ 报维护；
   * `direct_sync_route_ownership_conflict` ⇒ 载荷自相矛盾（同一路线在本批改归多个训练），
   * 整批已回滚，客户端必须清任务并重新生成同步批次，**不可重试**。
   * 与 `error` 的分工：`error` 是给人看的（公开层恒为通用文案），本字段是给程序看的
   * （枚举见 `apps/api/src/import-worker.ts` 的 `laneRefusalFailure`）。
   */
  failureCode?: string;
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
    /**
     * P2-8: **本批内容或归属发生变化的唯一路线数**（按 route id 去重）。
     *
     * 口径（合同，不是实现细节）：
     *   - 路线文件内容变化计入 1；
     *   - 内容字节未变、但父训练归属（`workout_id`）变化的路线也计入 1；
     *   - 同一路线在一批里重复出现只计 1；
     *   - 本批未触及的路线不计。
     *
     * 它**不是**“路线文件数”，也不是“路线点数”。消费方不得用它推断分析是否重算，
     * 那只由 `recomputeReasons` / `directSync.analysisStatus` 表达。
     */
    routesUpdated: number;
    featuresReused: number;
    featuresRecomputed: number;
    modelReplayFrom: string | null;
    durationMs: number;
    backupName: string | null;
    /**
     * 直接增量同步回执（docs/SQLITE_DIRECT_SYNC_DESIGN.md §10.1）。
     *
     * **可选**是刻意的兼容边界：缺省表示这条回执来自旧的候选发布路径，
     * 老客户端因此不会因为服务端升级而解析失败；反过来，消费方**不得**把"缺省"
     * 读成"分析已完成" —— `ingestStatus` 与 `analysisStatus` 是两个独立结论，
     * 前者为 `committed` 也不代表后者已经 `published`（§1.4）。
     */
    directSync?: DirectSyncReceipt;
    /**
     * 本批**在同一个事务里登记**的分析任务 id（`recompute_jobs.id`）。
     *
     * 为什么不能从 `directSync.analysisStatus` 推出来：回执的 `analysisStatus` 是
     * **COMMIT 时刻的快照**（直连车道恒写 `queued`，见 `apps/api/src/direct-sync-ingest.ts`），
     * 而"分析到底跑成没有"只有在**另一个通道**上才有终态（`GET /v1/jobs/:id`）。
     * 没有这个 id，客户端就只知道自己"提交过一批需要分析的事实"，**永远问不到结果** ——
     * §10.3 的「分析已更新」与「健康数据已保存，分析更新失败，可重试分析」两句因此不可达。
     *
     * 取值语义（三态，不是两态）：
     * - 非空 ⇒ 本批需要分析，且这是要跟踪的那条任务；
     * - `null` ⇒ 这条车道**明确不登记**分析任务（`record-only` 的 `not_required` 就是这样）；
     * - 键缺失 ⇒ 这个服务端版本还没提供这个字段（老服务端）。
     *
     * `null` 与"缺键"**必须分开**：前者是"问过了，没有分析任务"，后者是"问不到"。
     * 把后者读成前者，会让一个本该显示「分析更新中」的批次显示成「健康数据已保存」——
     * 用户于是以为分析已经完事（§9.1 明令不许把 `not_required` 说成"分析已完成"）。
     */
    analysisJobId?: string | null;
    /**
     * 本批**恢复事实**（`canonical_nights` / `canonical_hrv_days`）的重建模式。
     *
     * 🔴 为什么必须落进持久化摘要：§14.1 要求"证明没有调用"全表重建，而那张禁止操作清单里
     * 的 `canonical-nights-full-rebuild` 直到 PR4 步骤 4 之前都是**声明的真空**（直连车道根本
     * 不跑 canonical）。现在它跑了 —— 只按**本批窗口**跑 —— 于是模式本身成了可观测通道：
     * `"none"` = 本批没碰夜，`"window"` = 只重建了 `[from, to]`。
     * **`"full"` 在直连车道上永远不该出现**（那是整表删除+重建）。
     */
    canonicalNights?: {
      mode: "none" | "window";
      from?: string;
      to?: string;
      mainCount?: number;
      napCount?: number;
      hrvCount?: number;
    };
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
  /**
   * What the runner was prescribed for this date, kept apart from `kind` — which
   * is the display kind. `completed` says something was *observed*, so the
   * prescription it replaced (or that it failed to match) would otherwise be
   * erased; `null` means the stored plan holds no prescription for this date
   * (an unplanned date is not a rest day that was prescribed).
   *
   * Optional so payloads cached before this field existed keep decoding, and so
   * a client can tell "the server does not report intent" from "there is none".
   */
  intentKind?: MobileSessionKind | null;
  /**
   * Whether an imported training observation exists for this date.
   *
   * `unknown` is a statement about missing evidence, never about training: a
   * past date with no import may be a missed upload, a watch left at home, or a
   * real rest. Absent on payloads cached before this field existed; today and
   * future dates omit it because the date is not observable yet.
   */
  observation?: "observed" | "unknown";
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
    /**
     * PR5 S3：事实/分析版本与新鲜度。**可选**，理由见 §1.2 锚点 21 ——
     * iOS 的 `TrainingPlanStateResponse.Metadata` 是**非可选**字段结构体，
     * 给它加必填字段会让旧客户端 decode 失败。加可选字段则老客户端原样忽略。
     */
    versions?: FactVersions;
    freshness?: Freshness;
  };
  availability: "ready" | "empty";
  goals: MobileGoalsResponse;
  today: MobileTodayResponse;
  workoutPlan: MobileWorkoutPlanResponse & { windowStart: string; windowEnd: string };
  coachSummary: MobileRunCoachResponse;
  /** 两块视图（PR5 S4）。可选；`null` = 本端点还没有这一侧视图。 */
  currentFacts?: FactsView | null;
  publishedAnalysis?: AnalysisView | null;
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
  executionPolicy?: import("./coach-loop.js").CoachExecutionPolicyContext;  /** Strict dated V2 result; legacy clients may keep reading the compatible assessment. */
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
  /**
   * 两块视图（PR5 S4）。可选；`null` = 本端点还没有这一侧视图。
   *
   * 🔴 为什么这里的两个块**必须与上面那些数字同一次读**：`today` / `week` / `weekDaily` /
   * `planActual` 全部来自事实侧。若两块另开一次读，它们之间的提交会让响应出现
   * "汇总说 7 次、事实块说 6 行"，而那正是 C1 要挡的跨快照混合。
   *
   * ⚠️ 本类型上已有一个 `freshness` 字段，它**不是**这里说的新鲜度：那个字段已
   * `@deprecated`，只由 `sync.status` 派生（§1.2 锚点 14），与版本比较无关。
   * 版本/新鲜度的正式出口是 `training-plan-state` 的 `metadata.versions`/`freshness`
   * —— 一个端点两套 freshness 会让"哪个说了算"变成没人能回答的问题，所以这里不给第二份。
   */
  currentFacts?: FactsView | null;
  publishedAnalysis?: AnalysisView | null;
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
  /**
   * Legacy safety marker: a v2 configuration command sets it so the legacy weekly
   * generator cannot overwrite the window with a second scheduler before the
   * unified refresh publishes a new plan. Omitted = unchanged.
   */
  weekPlanReplanRequired?: boolean;
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
  /**
   * Import-batch ledger aggregates (direct-sync / data-only lanes write `xml` into
   * `import_batches.summary_json`). Added 2026-10-18 so a superseded-value or
   * tombstoned payload record is observable outside server logs: `tombstonedRecords`
   * counts payload records refused by a tombstone (including the delete-persistent
   * supersede path), `supersededRecords` counts legacy values replaced by a later
   * correction. Batches whose summary predates these fields (or is not valid JSON)
   * contribute 0.
   */
  imports: {
    batches: number;
    tombstonedRecords: number;
    supersededRecords: number;
  };
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

// ---------------------------------------------------------------------------
// Unified training-plan read contract (PR4-1; field freeze for the v2 endpoints)
// ---------------------------------------------------------------------------

/**
 * Wire contract negotiated with `X-RAI-Training-Contract`.
 *
 * v1 is every existing response (unchanged). v2 is this module's unified state
 * projection. The API never silently switches a client between them: an unknown
 * version is an explicit upgrade error, not a fallback.
 */
export const TRAINING_PLAN_CONTRACT_VERSION = 2;

export type TrainingPlanContractVersion = 1 | 2;

export interface TrainingPlanScope {
  serverId: string;
  athleteId: string;
  datasetEpoch: string;
}

export type TrainingPlanMode = "coach" | "race";
export type TrainingPlanRunState = "active" | "paused";
/** Admission is a configuration prerequisite, never a mode switch. */
export type TrainingPlanAdmissionState = "ready" | "needs_configuration" | "needs_confirmation";

export interface TrainingPlanRaceGoalSupport {
  /** `null` for a custom distance; the goal is still a race. */
  distance: MobileRaceDistance | null;
  support: "standard" | "limited";
  horizon: "within_horizon" | "beyond_horizon";
  preparation: "ready" | "short";
  weeksToRace: number;
  daysToRace: number;
  reasonCodes: string[];
}

export interface TrainingPlanRaceGoalView {
  id: string;
  date: string;
  distanceKm: number;
  goal: "finish" | "time";
  targetTimeSeconds: number | null;
  support: TrainingPlanRaceGoalSupport;
}

/**
 * v2 read response: the migrated unified state, with the mode derived live from
 * `(raceGoal, businessDate)` so a stored copy can never drift from its inputs.
 *
 * Read-only by contract: this payload carries no execution grant and the endpoint
 * never migrates, publishes or writes.
 */
export interface TrainingPlanStateResponseV2 {
  contractVersion: typeof TRAINING_PLAN_CONTRACT_VERSION;
  scope: TrainingPlanScope;
  businessDate: string;
  stateRevision: number;
  migratedAt: string;
  migration: {
    version: number;
    source: "legacy_goals" | "run_coach" | "coach_loop" | "new";
    sourceStatus: "active" | "paused" | "ended" | "none";
    sourceDigest: string;
  };
  mode: TrainingPlanMode;
  modeReason: "no_race_goal" | "race_goal_upcoming" | "race_day" | "race_goal_passed";
  daysToRace: number | null;
  runState: TrainingPlanRunState;
  admission: TrainingPlanAdmissionState;
  raceGoal: TrainingPlanRaceGoalView | null;
  plan: {
    goalsRevision: number | null;
    currentGoalsRevision: number;
    /** False when the legacy goals row moved after migration: the state is stale. */
    current: boolean;
    days: MobilePlannedDay[];
    lockedToday: boolean;
  };
  /** This slice is a projection only: it deliberately carries no execution grant. */
  execution: {
    permitted: false;
    reasonCodes: string[];
  };
  /** B02 compatible read. Sent only for explicit session extension negotiation. */
  sessions?: import("./training-plan-closed-loop.js").TrainingPlanSessionsView;
}

// ---------------------------------------------------------------------------
// Unified training-plan commands (PR4-2)
// ---------------------------------------------------------------------------

/** The only configuration commands; there is deliberately no coach/race enable pair. */
export type TrainingPlanCommandAction = "set_race_goal" | "clear_race_goal" | "pause" | "resume";

export interface TrainingPlanRaceGoalDraft {
  date?: string | null;
  distanceKm?: number | null;
  goal?: "finish" | "time" | null;
  targetTimeSeconds?: number | null;
}

/** State summary shared by preview and command responses. */
export interface TrainingPlanStateSummary {
  mode: TrainingPlanMode;
  modeReason: "no_race_goal" | "race_goal_upcoming" | "race_day" | "race_goal_passed";
  daysToRace: number | null;
  runState: TrainingPlanRunState;
  admission: TrainingPlanAdmissionState;
  raceGoal: TrainingPlanRaceGoalView | null;
}

export interface TrainingPlanCommandChangeSet {
  goalIdentity: "unset" | "kept" | "replaced" | "cleared" | "unchanged";
  goalChanged: boolean;
  runStateChanged: boolean;
  modeChanged: boolean;
}

export interface TrainingPlanCommandPreviewRequest {
  contractVersion: 2;
  operationScope: TrainingPlanScope;
  action: TrainingPlanCommandAction;
  expectedStateRevision?: number | null;
  raceGoal?: TrainingPlanRaceGoalDraft | null;
}

/**
 * Preview never persists. `candidateId` + `expiresAt` bind the confirmed submit to
 * the exact previewed configuration; a submit after the TTL is rejected instead of
 * silently applying a stale intent.
 */
export interface TrainingPlanCommandPreviewResponse {
  contractVersion: 2;
  candidateId: string;
  expiresAt: string;
  expectedStateRevision: number;
  before: TrainingPlanStateSummary;
  after: TrainingPlanStateSummary;
  changes: TrainingPlanCommandChangeSet;
  /** Preview never generates or publishes a plan; submit decides whether one is attached. */
  planRefreshRequired: true;
  warnings: string[];
}

export interface TrainingPlanCommandRequest {
  contractVersion: 2;
  operationId: string;
  operationScope: TrainingPlanScope;
  expectedStateRevision: number;
  candidateId: string;
  action: TrainingPlanCommandAction;
  raceGoal?: TrainingPlanRaceGoalDraft | null;
}

export interface TrainingPlanCommandResponse {
  contractVersion: 2;
  operationId: string;
  stateRevision: number;
  /** Separate from unified stateRevision and the device execution watermark. */
  goalsRevision: number;
  before: TrainingPlanStateSummary;
  after: TrainingPlanStateSummary;
  changes: TrainingPlanCommandChangeSet;
  /**
   * False only when this same operation also published a fresh plan. A `pause`
   * never publishes, so it keeps `true` (resume/refresh own the next plan).
   */
  planRefreshRequired: boolean;
  plan: {
    days: MobilePlannedDay[];
    audit: MobilePlanAudit;
    contextDigest: string;
    goalsRevision: number;
  } | null;
  warnings: string[];
}

/** PR4-3: publish a fresh plan for the migrated unified configuration. */
export interface TrainingPlanRefreshRequest {
  contractVersion: 2;
  operationId: string;
  operationScope: TrainingPlanScope;
  expectedStateRevision: number;
}

export interface TrainingPlanRefreshResponse {
  contractVersion: 2;
  operationId: string;
  stateRevision: number;
  goalsRevision: number;
  plan: {
    days: MobilePlannedDay[];
    audit: MobilePlanAudit;
    /** Always a fresh plan published from this refresh. */
    current: true;
    contextDigest: string;
  };
  warnings: string[];
  /** B08: absent on older servers/users must treat a missing value as `changed`. */
  outcome?: "changed" | "no_change";
}

export {
  RETIRED_TRAINING_PLAN_SURFACES,
  retiredTrainingPlanSurface,
  type RetiredPlanMethod,
  type RetiredPlanSurface,
  type RetiredPlanTag
} from "./retired-surfaces.js";

export {
  HANDSHAKE_KEY_REGISTRY,
  type HandshakeKeyRegistration
} from "./handshake-registry.js";

export * from "./training-plan-closed-loop.js";
