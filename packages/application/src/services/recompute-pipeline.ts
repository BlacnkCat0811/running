import { loadPersistedTrainingLoads, loadDailyPhysEvidence } from "../training-load-data.js";
import { NO_WRITE_GATE, type AnalysisStore, type WriteGate } from "../write-gate.js";
import { identityNormalizationConfigHash } from "@rai/normalization";
import { READINESS_SLEEP_RATIO_THRESHOLD } from "@rai/readiness";
import { readinessForRun } from "../model-v2-snapshots.js";
import { DURABILITY_MODEL_VERSION, PREPARATION_TARGETS, PREPARATION_WINDOW_DAYS, assessPreparation, assessDurability, buildDurabilitySnapshot } from "@rai/durability";
import type { ModelLineageV2, WorkoutFeaturePayloadV4 } from "@rai/contracts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { RecomputeProgressGate } from "./recompute-progress.js";
import { BoundedCache } from "./bounded-cache.js";
import { ChunkedWriter } from "./chunked-write.js";
import { RecoveryBaselineReader } from "./recovery-baseline-reader.js";
import type { AnalysisInputCapture, AnalysisInputSource } from "./analysis-input-reader.js";
import {
  AnalysisInputCoverageOutOfBoundsError,
  AnalysisInputDriftError,
  PEAK_EVIDENCE_LOOKBACK_MS,
  RECORDS_MAX_LOOKBACK_MS,
  SESSION_RECORDS_LOOKBACK_MS,
  type AnalysisFactView
} from "./analysis-fact-view.js";
import type { AnalysisDirtyDomains } from "@rai/health-export-parser";

import {
  DATABASE_TIMEZONE,
  CONTRACT_VERSION,
  FEATURE_SCHEMA_VERSION,
  type AbilityAssessment,
  type DailyZoneProfile,
  type DailyAbilitySnapshot,
  type EligibilityStatus,
  type FeatureRun,
  type MissingReasonCode,
  type ModelRun,
  type PerformanceProtocol,
  type RecomputeJob,
  type RunStatus,
  type SessionStratum,
  type SessionType,
  type StratumHistory,
  type TrainingZoneProfileSettings,
  type WorkoutFeatureVector,
  type WorkoutOverride,
  type WorkoutZoneSummary
} from "@rai/contracts";
import {
  FEATURE_CONFIG_VERSION,
  defaultFeatureConfig,
  extractWorkoutFeatureVector,
  extractWorkoutFeatureVectorV4, projectFeatureV4, encodeFeaturePayloadV4, decodeStoredFeature,
  type FeatureConfig,
  type WorkoutFeatureSource
} from "@rai/features";
import {
  RaiDatabase,
  SqliteModelRunRepository, SqliteModelReleaseRepository, semanticHash, evaluateModelTransitionGateV2,
  RecomputeJobRepository,
  SqliteRoutePointReader,
  SqliteTrainingSessionRepository,
  type ModelTransitionSourceBackfillEvidence
} from "@rai/storage-sqlite";
import {
  buildAdaptiveBaselineTimeline,
  buildLegacyStratumHistory,
  defaultAdaptiveBaselinePolicy,
  BASELINE_POLICY_VERSION,
  createPersonalBaseline,
  defaultRaiModelConfig,
  hasCompletedCalibration,
  inactivityDecay,
  MODEL_CONFIG_VERSION, SCORING_MODEL_VERSION,
  scoreFeature,
  sessionStratum,
  sortWorkoutFeaturesChronologically,
  trueAbilityAfterInactivity,
  updateTrueAbilityFromFeatureScore,
  type PersonalBaseline
} from "@rai/scoring";
import {
  buildDailyTrainingMetricsV2 as buildDailyTrainingMetrics,
  buildDailyTrainingMetrics as buildLegacyDailyTrainingMetrics,
  calculateWorkoutTrainingLoad, buildLoadVectorV2,
  classifyPhysState,
  defaultDailyMetricConfig,
  type DailyPhysEvidence,
} from "@rai/training-load";
import { TRAINING_LOAD_CONFIG_VERSION, type DailyTrainingMetric, type WorkoutTrainingLoad } from "@rai/contracts";
import { TRAINING_ZONE_CONFIG_VERSION } from "@rai/contracts";
import {
  analyzeWorkoutZones,
  buildDailyZoneProfile,
  calculateCompositeTrainingLoad,
  percentile,
  type MaximumHeartRateEvidence,
  type RestingHeartRateEvidence,
  type ThresholdPaceCandidate,
  type TimedMetricSample
} from "@rai/training-zones";
import {
  estimateLactateThresholdFromPerformanceVdot,
  estimatePerformanceVdot,
  estimateVo2Max
} from "@rai/physiology";
import {
  loadDirectVo2Evidence,
  loadLabeledPerformanceEvidence,
  loadLactateThresholdEvidence,
  loadPerformanceVdotEvidence, parsePerformanceConditions
} from "../prediction-data.js";

import {
  addDays,
  appNow,
  configHash,
  daysBetween,
  deterministicId,
  localDateAt,
  localDateStartAt,
  median,
  opaqueId,
  parseJson
} from "../utils.js";

import {
  runningType,
  heartRateType,
  runningSpeedType,
  restingHeartRateType,
  hrvType,
  sleepType,
  distanceType,
  MODEL_CHECKPOINT_VERSION,
  type SessionRow,
  type StatisticRow,
  type RecordRow,
  type RouteQualityRow,
  type TimelineAssessment,
  type RecomputeRequest,
  type ModelCheckpointState,
  type ReplayResume
} from "../service-types.js";

import {
  clamp,
  asNullableNumber,
  finiteNumber,
  convertDistanceToKilometers,
  convertSpeedToMetersPerSecond,
  weightedRecordIntervals,
  sustainedThirtySecondPeak,
  summaryFromRecords,
  fallbackStatisticSummary,
  defaultRequest,
  normalizeInstant,
  type WeightedRecordInterval
} from "../recompute-helpers.js";

interface OverrideSnapshot {
  ids: string[];
  byTrainingSessionId: Map<string, WorkoutOverride>;
}

/**
 * 输入漂移（O06-A 步骤 5）最多重排几次。
 *
 * 为什么必须有上限：每次漂移都登记一条续算任务，若导入持续到达、而这条库又大到只能分段读，
 * 就会变成"不停创建又废弃候选"的活锁（O06-B 的防饿死上限是另一条独立要求）。
 * 到顶之后当前任务以**显式原因**失败，而不是把候选悄悄发布出去。
 */
const MAX_BINDING_DRIFT_REPLANS = 3;

/**
 * 一场训练的**一次装配结果**（O09 步骤 6）。
 *
 * 特征阶段要的是区间原样，分区阶段要 30 秒持续峰值，负荷阶段要 30 秒平滑样本与高程增益 ——
 * 今天这三处各自重扫同一批记录。装配一次之后它们共享同一份派生结果。
 * 高程是懒加载：最大心率证据与分区阶段并不需要它（路线点表是最贵的一次扫描）。
 */
class WorkoutAssembly {
  private elevation: number | null | undefined = undefined;
  constructor(
    /** 心率区间（源记录 → 加权区间），特征/最大心率/负荷三个阶段共用。 */
    readonly heartIntervals: WeightedRecordInterval[],
    readonly speedIntervals: WeightedRecordInterval[],
    /** 负荷阶段的 30 秒（心率）/平滑（配速）样本。 */
    readonly heartSamples: TimedMetricSample[],
    readonly speedSamples: TimedMetricSample[],
    private readonly elevationLoader: () => number | null,
    /** 权重 = 本次装配持有的源记录行数（缓存按行数设上限）。 */
    readonly rows: number
  ) {}
  elevationGainMeters(): number | null {
    if (this.elevation === undefined) this.elevation = this.elevationLoader();
    return this.elevation;
  }
}

/** 复用计划（O09 步骤 2/4）：父 run、边界、恢复出的滚动状态。 */
interface MetricReusePlan {
  parentMetricRunId: string;
  parentModelRunId: string;
  parentEvaluatedAt: string;
  parentThroughDate: string;
  /** 父 run 的第一个分区日（拷贝区间的起点）。 */
  firstDate: string;
  /** 分区/负荷的后缀起点（本地日）。 */
  zoneStart: string;
  /** `zoneStart-1` 那天的分区（链的续点）；前缀为空时为 null。 */
  previousProfile: DailyZoneProfile | null;
  /** 从 checkpoint 恢复的 90 天距离参考队列。 */
  distanceQueue: DistanceQueueEntry[];
  state: TrainingMetricCheckpointState;
}

/** 待落库的一行（分区摘要 / 训练负荷）。 */
interface StagedLoadWrite {
  table: "workout_zone_summaries" | "workout_training_loads";
  values: SQLInputValue[];
}

/** 待落库的逐训练域快照（`model_domain_snapshots`）。 */
interface StagedSnapshot { domain: string; key: string; asOf: string; payload: unknown }

/** 一次负荷/分区装配的产物（写入前先全部算完，证明失败就一行都不写）。 */
interface TrainingLoadPass {
  loads: WorkoutTrainingLoad[];
  writes: StagedLoadWrite[];
  snapshots: StagedSnapshot[];
  distanceQueue: DistanceQueueEntry[];
  modelId: string;
}

/**
 * Superseded recomputation runs kept beyond the active one.
 *
 * Every recompute writes a new model_run / feature_run / training_metric_run
 * and materialises the complete derived output into it, so unbounded retention
 * grows the database as O(runs × days) and multiplies the cost of every
 * migration that rewrites a derived table. Keeping a small recent history
 * preserves run-to-run comparison while bounding that growth. `0` disables
 * pruning entirely.
 */
export const SUPERSEDED_RUN_RETENTION = 2;

/**
 * 负荷／分区／日级三域 checkpoint 的版本号（O09 步骤 2）。
 *
 * 口径变化（滚动状态形状、复用判据）必须**上调**它：旧 checkpoint 由此不再被复用，
 * 而不是被新代码按新口径解释。历史 row 保留，不迁移、不回填。
 */
export const TRAINING_METRIC_CHECKPOINT_VERSION = "rai-training-metric-checkpoint-v2";

/**
 * 日级**生理证据**快照的分块长度（v2）。
 *
 * 为什么存"每天一个字符"而不是每块一个 sha256：摘要只能回答"这一块变没变"，
 * 而复用边界 `zoneStart` 通常落在块的中间 —— 哈希无法在块内定位，只能整块重算
 * （短历史直接退化成零复用）。每天一个字符（4 态 + 缺失）既精确到天、又比哈希更小：
 * 20 年 ≈ 7.3 KB，和已存的 90 天距离参考队列同量级。
 */
export const DAILY_EVIDENCE_CHUNK_DAYS = 64;
/** 20 年 × 366 天的分块上限；超过即视为状态损坏（不截断）。 */
const MAX_DAILY_EVIDENCE_CHUNKS = Math.ceil((366 * 20) / DAILY_EVIDENCE_CHUNK_DAYS);
/** 单日状态的编码：缺失 `.`、unknown `u`、depleted `d`、reduced `r`、recovered_phys `p`。 */
const DAILY_EVIDENCE_ALPHABET = ".udrp";

/** 日级指标的算法版本（`buildDailyTrainingMetrics(V2)` 的口径）。 */
export const DAILY_METRIC_ALGORITHM_VERSION = "rai-daily-metric-v2";

/**
 * 滚动状态里距离参考队列的条数上限。
 *
 * 90 天窗内不可能有这么多训练；超过就说明状态被篡改或口径变了 ⇒ **不复用**
 * （不截断成"看起来够用"，那会把错误状态当有效历史）。
 */
export const MAX_DISTANCE_QUEUE_ENTRIES = 2000;

/** 证据时刻列表的条数上限；超过即视为"状态不可信"（不复用），不截断。 */
export const MAX_EVIDENCE_TIMESTAMPS = 4000;

/** 分区链尾：`through_local_date` 那天那一行的业务值（下一段链的起点）。 */
interface ZoneChainState {
  localDate: string;
  effectiveAt: string;
  dataThroughAt: string | null;
  restingHeartRateBpm: number;
  maximumHeartRateBpm: number;
  lactateThresholdPaceSecondsPerKm: number | null;
  heartRateSource: string;
  paceSource: string;
  heartRateConfidence: number;
  paceConfidence: number;
  status: string;
  heartRateBandsJson: string;
  paceBandsJson: string;
  evidenceJson: string;
}

/** 距离参考队列的一条（`priorDistances` 的可复用部分）。 */
interface DistanceQueueEntry { observedAt: string; distanceMeters: number }

/**
 * 负荷／分区／日级的**滚动状态**（O09 步骤 2、4）。
 *
 * 🔴 缺项一律表示"不可复用"，**不是**"按 0 续算"：把 EWMA 从 0 续、把分区链从 `null` 续，
 * 都会让近期小变更在**历史前缀**里产出与离线从头计算不同的值，且行数与覆盖都看不出来。
 * 平滑与累计状态不按固定天数截尾 —— 它们本来就不是固定窗口能表达的。
 */
/**
 * 分区/负荷证据的**快照**（O09 步骤 2 的"输入绑定"在证据链上的那一半）。
 *
 * 🔴 为什么必须有它：分区链的证据不是只从原始表读的 —— `labeled_performance` /
 * `performance_vdot` / `lactate_threshold` 三类**经 `active_model_run` 的 feature 行**读取
 * （`performanceRows` 里那个 `JOIN active_model_run`）。于是同一批事实在不同 run 上会得到
 * **不同的证据集**：一条刚发布的候选会让下一次分析的证据"从无到有"。
 * 实测（本工作包的回归夹具）：首次全量 run 时还没有 active run ⇒ 证据为空、阈值配速为空、
 * 分区带全为 null；第二次 run 就有了 —— 此时若照抄第一次的前缀，增量结果与离线从头计算
 * **不一致**（合成库上差 5 倍负荷）。
 *
 * 判据（复用侧按 `prefixAt = zoneStart 的本地日起点` 收紧）：`observedAt < prefixAt` 的证据集合
 * 必须逐条相同。比 `prefixAt` 新的证据不可能影响前缀日（前缀日的 `effectiveAt <= prefixAt`）。
 */
export interface ZoneEvidenceSnapshot {
  /** 当时的证据源 run（即当时的 active run）；`null` = 当时根本没有证据源 ⇒ 不可复用。 */
  sourceRunId: string | null;
  /** 三类"经 active run 读取"的证据的 `observedAt`；可重算的两类（RHR / VO2）不存。 */
  labeled: string[];
  performance: string[];
  threshold: string[];
}

export interface TrainingMetricCheckpointState {
  version: string;
  zonePrevious: ZoneChainState | null;
  evidence: ZoneEvidenceSnapshot;
  /**
   * 队列是否**完整**。`false` = 条数超限，队列存的是空数组 ⇒ 不可复用。
   * 不按天数截尾是刻意的：未来任何一个更早的后缀都要用这条队列做 90 天参考。
   */
  distanceQueueComplete: boolean;
  distanceQueue: DistanceQueueEntry[];
  daily: { localDate: string; acuteEwma: number; chronicEwma: number; workoutCount: number; historyDays: number } | null;
  /**
   * 日级证据快照的**序列首日**（比对原点）。下一 run 的首日与它不一致 ⇒ 无法逐日对齐，
   * 退回 {@link RecomputePipeline.proveDailyPrefix} 的逐行证明。
   */
  dailyEvidenceFrom: string;
  /**
   * 从 `dailyEvidenceFrom` 起**每天一个字符**的 `physState`（每块 ≤ {@link DAILY_EVIDENCE_CHUNK_DAYS}），
   * 缺失日记 `.`。它证明的是"这些天的分类输入没变"；日指标是这些输入的确定性函数，
   * 所以边界之前的行必然逐位相同，不必逐行重算 —— 前提是**父 run 的行本身没被改过**。
   */
  dailyEvidenceDays: string[];
  /**
   * 父 run `daily_training_metrics` **整表**的业务列摘要（写入时从盘上算）。
   *
   * 与证据快照是两道独立证明：快照证明"输入没变"，它证明"算出来的行还在"。
   * 少了它，一个被就地改过的前缀行会被当成"输入没变"照抄下去（旧实现靠逐行重算顺带发现，
   * v2 不再逐行重算 ⇒ 必须显式把这条证据补回来）。不一致时退回逐行证明。
   */
  dailyRowsDigest: string;
}

/** 每域 reused/recomputed 计数（落到 `training_metric_runs.summary_json.reuse`）。 */
export interface MetricReuseCounters {
  attempted: boolean;
  proof: "verified" | "rejected" | "not_attempted";
  rejectionReason: string | null;
  loads: { reused: number; recomputed: number };
  zoneProfiles: { reused: number; recomputed: number };
  dailyMetrics: { reused: number; recomputed: number };
  checkpointWritten: boolean;
  /** 实际复用的日期区间（`null` = 没有复用）。 */
  reuseFromLocalDate: string | null;
  reuseThroughLocalDate: string | null;
}

/** 各计算域的排他边界（`null` = 该域不可增量，必须全算）。 */
interface DomainBoundaries {
  features: string | null;
  fitness: string | null;
  readiness: string | null;
  /** 边界来源：`domains`（O04 分域）／`legacy`（老 payload 的单一边界）／`none`（全量）。 */
  source: "domains" | "legacy" | "none";
}

/**
 * 逐日证据快照的比较结果。
 *
 * `insufficient` = 任一侧比待证明的跨度短（父 run 的快照没覆盖到边界 / 本 run 的证据缺失），
 * 此时**不能**把"已比较的部分相同"当成整段证明 —— 调用方必须退回逐行证明。
 */
export type DailyEvidenceComparison =
  | { kind: "match" }
  | { kind: "mismatch"; offset: number }
  | { kind: "insufficient" };

/** 纯函数：只比较 `[0, span)` 这一段；`offset` 是第一个不同的日偏移。 */
export function compareDailyEvidenceDays(
  stored: string,
  current: string,
  span: number
): DailyEvidenceComparison {
  if (span < 0) return { kind: "insufficient" };
  if (stored.length < span || current.length < span) return { kind: "insufficient" };
  for (let offset = 0; offset < span; offset += 1) {
    if (stored[offset] !== current[offset]) return { kind: "mismatch", offset };
  }
  return { kind: "match" };
}

/**
 * 单日生理状态 → 一个字符。未知枚举值返回 `null`：**宁可退回逐行证明**，也不能把两个
 * 不同的新状态编码成同一个字符（那会让比较得出"没变"）。
 */
function encodeDailyEvidenceState(state: string | undefined): string | null {
  switch (state) {
    case undefined: return ".";
    case "unknown": return "u";
    case "depleted": return "d";
    case "reduced": return "r";
    case "recovered_phys": return "p";
    default: return null;
  }
}

/**
 * Feature extraction, training metrics/zones, and ability timeline replay.
 * Split from RaiApplicationService (ARCHITECTURE_DEBT_MIGRATION P4).
 */
export class RecomputePipeline {
  private allowNativeAggregates = true;
  private recoveryIsolationHolds = true;
  private readonly recordCache = new BoundedCache<RecordRow[]>(16, 20_000);
  /**
   * 一次装配、多次复用（O09 步骤 6）：训练的心率／速度区间、路线质量、高程聚合。
   *
   * 为什么需要它：`loadRecordSeries` 的缓存按"来源＋时间窗＋类型"键控，容量只有 16 条 ——
   * 一场训练就要两条（心率／速度），于是跨阶段（特征 → 最大心率证据 → 分区 → 负荷）
   * 的复用**在真实数据量下必然抖动失效**，同一批记录被反复扫描。
   * 这里缓存的是**派生结果**（区间、30 秒平滑样本、高程增益、路线质量），
   * 键含输入绑定与参数标识，容量有上限（条数 + 行数），换一次 run 就整体清空。
   */
  private readonly workoutAssemblyCache = new BoundedCache<WorkoutAssembly>(512, 200_000);
  private readonly progressGate = new RecomputeProgressGate();
  private healthRecordHasUnitColumn: boolean | null = null;
  /** 本次 metric run 的复用计数（`finishTrainingMetricRun` 落进 `summary_json.reuse`）。 */
  private pendingReuseCounters: MetricReuseCounters | null = null;

  constructor(
    private readonly store: AnalysisStore,
    private readonly jobs: RecomputeJobRepository,
    private readonly modelRuns: SqliteModelRunRepository,
    private readonly sessions: SqliteTrainingSessionRepository,
    private readonly nativeElevationGains?: ReadonlyMap<string, number | null>,
    private readonly gate: WriteGate = NO_WRITE_GATE,
    /**
     * 分析输入源（O06-A / WP-22）。**注入**而不是在这里开连接：`write-lease.test.ts` 的
     * 结构判据（**按原文匹配**，连注释里的构造调用也算）钉住本文件不得出现直接构造
     * `DatabaseSync` / 直接打开 `RaiDatabase` 的写法 —— 分析只允许用被写租约代理包住的
     * 那一条连接。判据按原文而不是"去掉注释再匹配"，是为了让"把代码注释掉"这种
     * 「方法仍在、逻辑失效」的突变同样转红。
     * 读取器由 worker 线程构造（那里允许开只读连接），默认 `undefined` = 老行为。
     */
    private readonly inputSource?: AnalysisInputSource
  ) {}

  /** 本次直连分析捕获到的输入绑定；非直连任务为 null ⇒ 不写绑定行（老路径零改动）。 */
  private pendingInputCapture: AnalysisInputCapture | null = null;

  /**
   * 恢复基线读取器（按 `localDate` 缓存）。**生命周期 = 一次事实视图**：
   * 视图被替换时必须丢弃，否则会拿旧事实算基线（"输入变了却仍然复用"的形态）。
   */
  private recoveryBaselineCache: { timezoneIdentifier: string; reader: RecoveryBaselineReader } | null = null;

  /**
   * 本次运行的**事实视图**（O06-A / WP-22 步骤 3）：
   *
   * - `null`（CLI、老调用方、单测）⇒ 事实从 `store.database` 读，行为与改动前**逐字节相同**；
   * - 非空 ⇒ 事实（`health_records` / `workouts` / `canonical_*` / override / 分区设置 /
   *   成绩证据 / 账本…）一律从被固定的那一版读，**绝不再碰写连接**。
   *
   * 为什么默认 `null` 而不是"总去固定"：固定需要一条独立的只读连接，那是 worker 线程
   * （`apps/api/src/recompute-thread.ts`）的权限；分析侧不允许自己开连接（写租约结构判据：
   * 本文件里不得出现**直连构造**或**直连打开**主库的写法，判据按原文匹配 —— 连注释里
   * 出现那几个字面量也算，这正是 2026-10-16 踩过一次的坑）。于是本类只**使用**注入的视图，
   * 没有注入时保持老行为。
   */
  private factView: AnalysisFactView | null = null;

  get database(): DatabaseSync {
    return this.store.database;
  }

  /**
   * 事实读取句柄：有固定输入就从它读，否则退回写连接。
   *
   * ⛔ 只给**事实**用。派生结果（`workout_features` / `ability_assessments` / `daily_*` /
   * `model_*`）必须继续走 `this.database`：它们要么由本次运行自己写（读快照会读到旧行），
   * 要么属于发布证据。写仍然只经 `AnalysisStore`（本 getter 不存在写路径）。
   */
  private get facts(): DatabaseSync {
    return this.factView === null ? this.database : this.factView.database;
  }

  private hasHealthRecordUnitColumn(): boolean {
    if (this.healthRecordHasUnitColumn === null) {
      const columns = this.database
        .prepare("PRAGMA table_info(health_records)")
        .all() as unknown as Array<{ name: string }>;
      this.healthRecordHasUnitColumn = columns.some((column) => column.name === "unit");
    }
    return this.healthRecordHasUnitColumn;
  }

  runFullRecompute(job: RecomputeJob): void {
    this.recordCache.clear();
    // 装配缓存与记录缓存同寿命：绑定或事实一变，派生结果就不能跨 run 复用。
    this.workoutAssemblyCache.clear();
    this.pendingReuseCounters = null;
    this.recoveryIsolationHolds = true;
    const request = this.parseRequest(job.request);
    // Capture the incumbent before writing a candidate. The incumbent remains
    // active until the candidate has passed the shadow gate.
    const incumbent = this.database
      .prepare("SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1")
      .get() as { modelRunId: string } | undefined;
    const incumbentModelRunId = incumbent?.modelRunId ?? null;
    const datasetVersion = this.manifestValue("dataset_version") ?? "dataset_unknown";
    const overrideSnapshot = this.captureOverrideSnapshot();
    const featureRun = this.createFeatureRun(datasetVersion, request.featureConfig);
    this.setJobRunIds(job.id, featureRun.id, null);
    this.updateJobProgress(job.id, "feature_extraction", 0, 0, "Extracting canonical workout features");

    let features: WorkoutFeatureVector[];
    try {
      features = this.measureCompute(job.id, "features", () => this.extractFeatures(job.id, featureRun, request, overrideSnapshot));
      this.finishFeatureRun(featureRun.id, "succeeded", null);
    } catch (error) {
      this.finishFeatureRun(featureRun.id, this.isCancellationError(error) ? "cancelled" : "failed", error);
      throw error;
    }

    this.throwIfCancelled(job.id);
    const modelRun = this.createModelRun(datasetVersion, featureRun.id, request);
    this.setJobRunIds(job.id, featureRun.id, modelRun.id);
    const metricRunId = this.createTrainingMetricRun(modelRun.id, request, overrideSnapshot.ids);
    const lineage: ModelLineageV2 = {
      sourceRunId: modelRun.id, datasetVersion, factsSnapshotHash: semanticHash({datasetVersion,asOf:request.evaluatedAt,sessions:features.map((f)=>({session:f.trainingSessionId,at:f.workoutStartAt}))}),
      overrideSnapshotHash: semanticHash(overrideSnapshot.ids), modelVersion: SCORING_MODEL_VERSION,
      configVersion: MODEL_CONFIG_VERSION, configHash: modelRun.modelConfigHash, featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      calibrationCohortHash:null, baselineEpochId:null, normalizationVersion:"rai-normalization-identity-v1", normalizationConfigHash:identityNormalizationConfigHash(),
      timezoneIdentifier:request.timezoneIdentifier,asOf:request.evaluatedAt,dataThroughAt:features.at(-1)?.workoutStartAt??null
    };
    try {
      this.updateJobProgress(job.id, "training_metrics", 0, features.length, "Calculating training load");
      this.measureCompute(job.id, "trainingMetrics", () => this.replayTrainingMetrics(job.id, metricRunId, features, request, overrideSnapshot));
      this.finishTrainingMetricRun(metricRunId, "succeeded", null);
      this.updateJobProgress(job.id, "model_replay", 0, features.length, "Replaying ability timeline");
      this.measureCompute(job.id, "modelReplay", () => this.replayModel(job.id, modelRun, features, request));
      const summary = this.database.prepare("SELECT summary_json AS json FROM model_runs WHERE id=?").get(modelRun.id)?.json;
      const reference = typeof summary === "string" ? (JSON.parse(summary) as {baseline:PersonalBaseline|null}).baseline : null;
      lineage.baselineEpochId = this.fitnessEpochId(reference, features, request, modelRun);
      lineage.calibrationCohortHash = reference ? semanticHash(sortWorkoutFeaturesChronologically(features)
        .filter((f)=>reference.calibrationFeatureIds.includes(f.id)).map((f)=>({sessionId:f.trainingSessionId,at:f.workoutStartAt}))) : null;
      // D5：逐日快照先于 epoch 计算落地，所以这里回填而不是重排序。NULL 表示"该行写下时
      // 还不知道标尺"，读端必须把它当未知，不得当成"与当前 epoch 相同"。
      if (lineage.baselineEpochId !== null) {
        this.database.prepare(`UPDATE daily_ability_snapshots SET baseline_epoch_id = ?
          WHERE model_run_id = ? AND baseline_epoch_id IS NULL`)
          .run(lineage.baselineEpochId, modelRun.id);
      }
      new SqliteModelReleaseRepository(this.database).recordLineage(modelRun.id, SCORING_MODEL_VERSION, MODEL_CONFIG_VERSION, lineage);
      this.finishModelRun(modelRun.id, "succeeded", null);
      const releases = new SqliteModelReleaseRepository(this.database);
      this.sealDomainSnapshots(modelRun, metricRunId, features, request, lineage);
      const legacy = this.modelRuns.evaluateValidationGate(modelRun.id, incumbentModelRunId, false);
      // The incumbent is immutable and still contains deleted sessions. Only
      // explicit inactive facts explain removal; a missing candidate row for an
      // active session must still fail the original eligibility drift gate.
      const deletedAssessments = (id: string | null): number => id === null ? 0 : Number(
        this.database.prepare(`SELECT COUNT(*) AS n FROM ability_assessments a
          JOIN training_sessions s ON s.id=a.training_session_id
          WHERE a.model_run_id=? AND s.status='inactive'
          AND a.assessment_status IN ('eligible','trial')
          AND NOT EXISTS (SELECT 1 FROM effective_workout_overrides o
            WHERE o.training_session_id=a.training_session_id)`).get(id)?.n ?? 0);
      const removedEligibleSessions = deletedAssessments(incumbentModelRunId);
      const retainedDeletedSessions = Number(this.database.prepare(`SELECT COUNT(*) AS n
        FROM workout_features f JOIN training_sessions s ON s.id=f.training_session_id
        WHERE f.feature_run_id=? AND s.status='inactive'`).get(modelRun.featureRunId)?.n ?? 0);
      const comparableBaseEligible = legacy.metrics.baseEligibleSessions - removedEligibleSessions;
      const factAdjustedMetrics = {
        baseEligibleSessions: comparableBaseEligible,
        eligibleSessionDelta: Math.abs(comparableBaseEligible - legacy.metrics.candidateEligibleSessions) /
          Math.max(1, comparableBaseEligible),
        invalidValueCount: legacy.metrics.invalidValueCount + retainedDeletedSessions
      };
      const baseSchema = incumbentModelRunId ? this.database.prepare(`SELECT f.feature_schema_version AS schema
        FROM model_runs m JOIN feature_runs f ON f.id=m.feature_run_id WHERE m.id=?`).get(incumbentModelRunId)?.schema : null;
      const previousLineage = incumbentModelRunId ? this.database.prepare("SELECT lineage_json AS json FROM model_v2_runs WHERE model_run_id=?").get(incumbentModelRunId)?.json : null;
      const previousEpoch = typeof previousLineage === "string" ? (JSON.parse(previousLineage) as ModelLineageV2).baselineEpochId : null;
      const removedCalibrationSessions = incumbentModelRunId ? Number(this.database.prepare(`
        SELECT COUNT(*) AS n FROM model_runs m,
          json_each(json_extract(m.summary_json,'$.baseline.calibrationFeatureIds')) calibration
        JOIN workout_features f ON f.id=calibration.value
        JOIN training_sessions s ON s.id=f.training_session_id
        WHERE m.id=? AND s.status='inactive'`).get(incumbentModelRunId)?.n??0) : 0;
      const deletionRecalibration = removedCalibrationSessions > 0 &&
        previousEpoch !== null && previousEpoch !== lineage.baselineEpochId;
      const explicitRebase = request.modelConfig.baselineReferenceStartAt !== undefined && reference !== null &&
        previousEpoch !== null && previousEpoch !== lineage.baselineEpochId;
      // Recalibration intentionally marks the earlier period as calibrating in the
      // new coordinate system. Do not confuse that planned relabeling with lost
      // source eligibility; post-calibration statuses still face the normal gate.
      let rebaseMetrics: { matchedSessions:number; baseEligibleSessions:number; candidateEligibleSessions:number;
        eligibleSessionDelta:number; assessmentStatusChangeRate:number } | null = null;
      if ((explicitRebase || deletionRecalibration) && incumbentModelRunId) {
        const matched = this.database.prepare(`SELECT COUNT(*) AS n,
          SUM(CASE WHEN b.assessment_status<>c.assessment_status THEN 1 ELSE 0 END) AS changed
          FROM ability_assessments b JOIN ability_assessments c ON b.training_session_id=c.training_session_id
          JOIN workout_features f ON f.id=c.feature_id
          WHERE b.model_run_id=? AND c.model_run_id=? AND julianday(f.workout_start_at)>julianday(?)`)
          .get(incumbentModelRunId,modelRun.id,reference?.calibrationEndAt??request.evaluatedAt) as {n:number;changed:number|null};
        const eligible = (id:string):number => Number(this.database.prepare(`SELECT COUNT(*) AS n
          FROM model_runs m JOIN workout_features f ON f.feature_run_id=m.feature_run_id
          WHERE m.id=? AND f.eligibility_status IN ('eligible','trial')
          AND NOT EXISTS (SELECT 1 FROM training_sessions s
            WHERE s.id=f.training_session_id AND s.status='inactive')`).get(id)?.n??0);
        const oldCount=eligible(incumbentModelRunId),newCount=eligible(modelRun.id);
        rebaseMetrics={matchedSessions:deletionRecalibration?legacy.metrics.matchedSessions:matched.n,
          baseEligibleSessions:oldCount,candidateEligibleSessions:newCount,
          eligibleSessionDelta:Math.abs(oldCount-newCount)/Math.max(1,oldCount),
          assessmentStatusChangeRate:matched.n?Number(matched.changed??0)/matched.n:0};
      }
      const sourceBackfill = this.sourceBackfillEvidence(
        request.importBatchId, removedEligibleSessions, removedCalibrationSessions);
      const gate = incumbentModelRunId ? evaluateModelTransitionGateV2({
        candidateModelRunId:modelRun.id, baseModelRunId:incumbentModelRunId,
        ...(features.length === 0 ? {emptyCohort: this.emptyCohortEvidence(incumbentModelRunId,modelRun.id,metricRunId)} : {}),
        ...(sourceBackfill === undefined ? {} : {sourceBackfill}),
        schema:{baseModelVersion:legacy.metrics.baseModelVersion??null,candidateModelVersion:MODEL_CONFIG_VERSION,
          baseFeatureSchemaVersion:typeof baseSchema === "string" ? baseSchema : null,candidateFeatureSchemaVersion:FEATURE_SCHEMA_VERSION,
          baseScaleId:previousEpoch,candidateScaleId:lineage.baselineEpochId ??
            (deletionRecalibration ? "uncalibrated_after_confirmed_calibration_removal" : null)},
        metrics:{...legacy.metrics,assessmentStatusChangeRate:legacy.metrics.assessmentStatusChangeRate??0,
          ...factAdjustedMetrics,
          ...(rebaseMetrics??{}),
          readinessOutputCoverage:Number(releases.snapshots(modelRun.id).some((row)=>row.domain==="readiness")),recoveryIsolationHolds:this.recoveryIsolationHolds}
      }) : {
        gateVersion:"rai-bootstrap-invariants-v1", status:this.recoveryIsolationHolds ? "passed" as const : "failed" as const,
        blocksActivation:!this.recoveryIsolationHolds, failureReasons:this.recoveryIsolationHolds?[]:["recovery_isolation_violated"]
      };
      releases.recordEvaluation({runId:modelRun.id,baseRunId:incumbentModelRunId,datasetVersion,
        status:gate.status,report:{...gate,factChanges:{
          removedEligibleSessions,retainedDeletedSessions,removedCalibrationSessions,deletionRecalibration,
          eligibilityComparisonBasis:rebaseMetrics?"source_features":"ability_assessments",
          originalBaseEligibleSessions:legacy.metrics.baseEligibleSessions,
          originalEligibleSessionDelta:legacy.metrics.eligibleSessionDelta,
          sourceBackfill:sourceBackfill??null
        },rebase:explicitRebase||deletionRecalibration?{
          referenceStartAt:request.modelConfig.baselineReferenceStartAt??null,calibrationEndAt:reference?.calibrationEndAt??null,
          effectiveAt:request.evaluatedAt,rebaseReason:explicitRebase?"explicit_reference_start":"calibration_evidence_removed",
          previousEpoch,candidateEpoch:lineage.baselineEpochId,fullHistoryMetrics:legacy.metrics}:null},createdAt:request.evaluatedAt});
      if (gate.blocksActivation) throw new Error(`Model-version gate failed: ${gate.failureReasons.join(", ") || "not_evaluable"}`);
      this.activateModelRunAndCompleteJob(job.id, modelRun.id, features.length);
    } catch (error) {
      this.finishTrainingMetricRun(
        metricRunId,
        this.isCancellationError(error) ? "cancelled" : "failed",
        error
      );
      this.finishModelRun(modelRun.id, this.isCancellationError(error) ? "cancelled" : "failed", error);
      throw error;
    }
  }

  private emptyCohortEvidence(baseId:string,candidateId:string,metricRunId:string) {
    const counts = this.database.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN s.status='inactive' THEN 1 ELSE 0 END) AS removed
      FROM model_runs m JOIN workout_features f ON f.feature_run_id=m.feature_run_id
      LEFT JOIN training_sessions s ON s.id=f.training_session_id WHERE m.id=?`).get(baseId)!;
    const count = (sql:string,...args:string[]) => Number(this.database.prepare(sql).get(...args)?.n??0);
    const snapshots = new SqliteModelReleaseRepository(this.database).snapshots(candidateId);
    const emptyArray = (domain:string,key:string) => {
      const payload=snapshots.find(row=>row.domain===domain&&row.key==='summary')?.payload as Record<string,unknown>|undefined;
      return Array.isArray(payload?.[key]) && payload[key].length===0;
    };
    return {
      baseSessions:Number(counts.total),removedBaseSessions:Number(counts.removed??0),
      remainingSourceSessions:count("SELECT COUNT(*) AS n FROM training_sessions WHERE status IN ('active','ambiguous')"),
      candidateFeatures:count("SELECT COUNT(*) AS n FROM workout_features f JOIN model_runs m ON m.feature_run_id=f.feature_run_id WHERE m.id=?",candidateId),
      candidateAssessments:count("SELECT COUNT(*) AS n FROM ability_assessments WHERE model_run_id=?",candidateId),
      candidateLoads:count("SELECT COUNT(*) AS n FROM workout_training_loads WHERE training_metric_run_id=?",metricRunId),
      candidateDailyRows:count("SELECT COUNT(*) AS n FROM daily_ability_snapshots WHERE model_run_id=?",candidateId)+
        count("SELECT COUNT(*) AS n FROM daily_training_metrics WHERE training_metric_run_id=?",metricRunId)+
        count("SELECT COUNT(*) AS n FROM daily_zone_profiles WHERE training_metric_run_id=?",metricRunId),
      candidateCheckpointRows:count("SELECT COUNT(*) AS n FROM model_checkpoints WHERE model_run_id=?",candidateId),
      domainSnapshotsEmpty:emptyArray('fitness','assessments')&&emptyArray('fitness','daily')&&
        emptyArray('load','days')&&emptyArray('zones','profiles')&&
        !snapshots.some(row=>row.domain==='load_vector'||row.domain==='zone_coherence')
    };
  }

  /**
   * Structural proof that this candidate's eligibility drift is a pure source
   * backfill: the import removed nothing at all and is the one that pushed the
   * fact timeline backwards. Returns `undefined` (leaving the gate untouched)
   * whenever the batch identity is unknown, so a plain rebuild can never take the
   * exemption. Every field is a count or a membership test — no thresholds.
   */
  private sourceBackfillEvidence(
    importBatchId: string | undefined,
    removedEligibleSessions: number,
    removedCalibrationSessions: number
  ): ModelTransitionSourceBackfillEvidence | undefined {
    if (importBatchId === undefined) return undefined;
    const count = (sql: string, ...args: SQLInputValue[]): number =>
      Number(this.facts.prepare(sql).get(...args)?.n ?? 0);
    // `import_entity_changes` is the per-batch change ledger and is the only place
    // a removal of a fact row is written with its batch identity: rows with
    // `change_type='removed'` are inserted by `removeDeletedHealthKitAliasCopies`
    // (database.ts) and `removeHealthKitRecords` (database.ts) exactly when the
    // corresponding `health_records` row is deleted. Counting them by kind is
    // therefore a direct, per-batch zero-deletion witness.
    const removedByKind = (kind: "record" | "workout" | "activity_summary"): number => count(
      `SELECT COUNT(*) AS n FROM import_entity_changes
       WHERE batch_id = ? AND entity_kind = ? AND change_type = 'removed'`,
      importBatchId, kind);
    const removedRecords = removedByKind("record");
    const removedWorkouts = removedByKind("workout");
    const removedActivitySummaries = removedByKind("activity_summary");
    // Durable tombstones attributed to this batch are the second, independent
    // witness. `recordEntityTombstones` is called on the same code paths that
    // delete a fact row, and also for an arrival-less deletion that leaves no
    // change row, so requiring both to be empty is strictly stronger than either
    // alone. Source tombstones are intentionally excluded: a deletion before the
    // entity ever arrived creates no fact-row loss.
    const batchTombstones = count(
      `SELECT COUNT(*) AS n FROM import_entity_tombstones WHERE batch_id = ?`, importBatchId);
    const preservedAbsent = removedRecords === 0 && removedWorkouts === 0 &&
      removedActivitySummaries === 0 && batchTombstones === 0;
    // Membership only — never a time-string comparison. The row that currently
    // holds the global minimum `start_at` must be one of this batch's *inserted*
    // records; an update of an already-present row would not have moved the
    // timeline backwards, so only `inserted` proves the backfill.
    //
    // R06：**裁剪后**快照里的 `MIN(start_at)` 是"被裁集合的最小值"（更早的心率明细行已经
    // 不在快照里），照读会让这条判据换一个答案。用捕获读事务里算出的全局最早行 id
    // （`analysis-input-reader.ts` 与这里逐字同 SQL）；未裁剪（或分段模式）时才回落到原查询。
    const coverage = this.factView?.snapshotCoverage;
    const earliest = coverage !== undefined && coverage.recordsFrom !== null
      ? (coverage.globalEarliestRecordId === null ? undefined : { id: coverage.globalEarliestRecordId })
      : this.facts.prepare(
        `SELECT id FROM health_records
         WHERE start_at = (SELECT MIN(start_at) FROM health_records) LIMIT 1`
      ).get() as { id: string } | undefined;
    const earliestInsertedIsNewGlobalEarliest = earliest !== undefined && count(
      `SELECT COUNT(*) AS n FROM import_entity_changes
       WHERE batch_id = ? AND entity_kind = 'record' AND change_type = 'inserted' AND entity_id = ?`,
      importBatchId, earliest.id) === 1;
    return {
      preservedAbsent, removedRecords, removedWorkouts, removedActivitySummaries,
      removedEligibleSessions, removedCalibrationSessions, earliestInsertedIsNewGlobalEarliest
    };
  }

  /**
   * 直连增量同步车道登记的分析任务（`job_type='import'` + 载荷
   * `mode='direct_sync_analysis'`，见 §13 PR4 步骤 1）。
   *
   * **前置条件**（由调用方 `RaiApplicationService.runNextJob` 用共享函数
   * `isApplicationConsumableJob(job.jobType, job.request)` 保证）：这条任务确实归应用消费者。
   * 这里**不再复写第二遍判据** —— 同一判据两处写法正是这个仓反复踩过的坑。
   *
   * ⚠️ 本步只落地"消费者认识它并**真正跑分析**"：计算复用 `runFullRecompute` 的同一套
   * feature / metric / model 计算与全部业务发布 gate，**尚未**按 `target_raw_generation` /
   * `target_dependency_generation` 读固定版本事实（`FactsReader`）。代次绑定与"同批登记"
   * 属 PR4 步骤 2，必须与登记、`deltaMode: "full"` 同批落地（见 `docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md`
   * 步骤 6b 的三步上线顺序）。
   */
  runDirectSyncAnalysis(job: RecomputeJob): void {
    // WP-22（O06-A）：消费端**终于读**登记时写下的代次绑定。
    //
    // 没有输入源时（CLI、老调用方、单测）行为与以前逐字节相同 —— 直接跑全量管线。
    // 有输入源时先在一个**只读连接的一致读事务**里捕获输入绑定，再按"捕获到的实际代次"
    // 决定执行计划（可能要把未覆盖账本并进 dirty；并不动就退回全量）。
    this.pendingInputCapture = null;
    if (!this.inputSource) {
      this.runFullRecompute(job);
      return;
    }
    const raw = job.request as Record<string, unknown>;
    let capture = this.adoptInputCapture(job, raw, false);
    try {
      // 最多两次：第 1 次按裁剪快照跑；只有**覆盖越界**（R06 的显式失败）才关闭裁剪重来一次。
      // 其它任何错误（含输入漂移）都不在这里重试 —— 漂移走 `replanAfterInputDrift` 的登记路径。
      for (let attempt = 1; ; attempt += 1) {
        try {
          this.runFullRecompute({ ...job, request: this.requestWithPlan(raw, capture) });
          return;
        } catch (error) {
          if (error instanceof AnalysisInputCoverageOutOfBoundsError && attempt === 1) {
            // 回退证据先落事件：谁把"计划说会复用、实际却要更早事实"逼出来了，事后要能查。
            this.jobs.logEvent(job.id, "input_materialization", 0, 0, JSON.stringify({
              fallback: "fact_pruning_disabled", kind: error.kind,
              requiredFrom: error.requiredFrom, coverageFrom: error.coverageFrom, context: error.context
            }));
            capture = this.adoptInputCapture(job, raw, true);
            continue;
          }
          if (error instanceof AnalysisInputDriftError
              && this.replanAfterInputDrift(job, raw, error) === "requeued") {
            // 原任务已经退回队列（同一个 `analysisJobId`）⇒ 这一轮**不是**失败。
            // 抛出去会让 `runNextJob` 的 catch 把原 id 写成 failed，那正是 B03 的病灶。
            return;
          }
          throw error;
        }
      }
    } finally {
      // 分段模式的**逐条记账**必须落到任务事件上：单条读越过 `maxReadRows` / `maxReadMs`、
      // 以及 raw-only 前进，都只在 `stats()` 里活着；不写下来就等于"超预算没人知道"。
      // （读多少行、越了多少次是计数，不含任何健康明细。）
      const finished = this.factView;
      if (finished !== null) {
        const stats = finished.stats();
        if (stats.nearLimit.length > 0 || stats.rawAdvances.length > 0) {
          try {
            this.jobs.logEvent(job.id, "input_materialization", 0, 0, JSON.stringify({
              mode: stats.mode, reads: stats.reads, rows: stats.rows,
              nearLimit: stats.nearLimit.slice(0, 8),
              rawAdvances: stats.rawAdvances.slice(0, 8),
              observedGenerations: stats.observedGenerations.slice(0, 8)
            }));
          } catch {
            // 记账失败不能盖住本次运行的结局（成功/失败原因才是主线）。
          }
        }
      }
      // 快照的寿命就是这一次运行：关掉它（内存快照；分段视图不关别人的只读连接），
      // 下一轮任务不会带着上一版的输入开工。
      this.factView?.dispose();
      this.factView = null;
      this.pendingInputCapture = null;
      // 基线缓存挂在事实视图上：视图关了，缓存必须一起失效（否则下一轮用旧事实算基线）。
      this.recoveryBaselineCache = null;
    }
  }

  /**
   * 捕获一次输入并把捕获结果挂成"这一次运行的固定输入"。
   *
   * `disableFactPruning` = R06 的覆盖越界回退（全量物化）：不是性能开关，只有
   * {@link runDirectSyncAnalysis} 的越界分支会传 `true`，且**整个任务最多一次**。
   * 上一份视图（通常是内存快照）在这里关掉 —— 回退重捕获时不能让两份输入同时活着。
   */
  private adoptInputCapture(
    job: RecomputeJob,
    raw: Record<string, unknown>,
    disableFactPruning: boolean
  ): AnalysisInputCapture {
    const capture = this.inputSource!.capture({
      ...this.captureRequest(job, raw),
      ...(disableFactPruning ? { disableFactPruning: true } : {})
    });
    this.pendingInputCapture = typeof raw.importBatchId === "string"
      && !capture.mergedBatchIds.includes(raw.importBatchId)
      ? { ...capture, mergedBatchIds: [...capture.mergedBatchIds, raw.importBatchId] }
      : capture;
    if (capture.planAdjustment !== null) {
      this.jobs.logEvent(job.id, "input_binding", 0, 0,
        `Analysis input plan adjusted: ${capture.planAdjustment} (coverage=${capture.coverage.reason})`);
    }
    // 步骤 3–4 证据：这一版输入是**物化**取出的还是**分段**读的、多少行／字节、为什么降级、
    // 裁剪到哪。写进任务事件，"这一版算的是什么"事后可查（不进健康明细，只有计数与原因码）。
    this.jobs.logEvent(job.id, "input_materialization", 0, 0, JSON.stringify(capture.materialization));
    // 🔴 固定输入就位：从这一刻起，事实读取只命中这一版（见 `facts` getter）。
    this.factView?.dispose();
    this.factView = capture.facts;
    // 视图换了 ⇒ 基线缓存作废（同一次捕获内仍按 localDate 复用）。
    this.recoveryBaselineCache = null;
    return capture;
  }

  /**
   * 把捕获到的**实际计划**写回请求：`reuseFeaturePrefix` / `resumeModelReplay` 读的都是
   * `request.incrementalPlan`（计划被覆盖合并调整过时，登记时那一档已经不代表实际输入）。
   * 计划为 `null` ⇒ 删掉键 ⇒ 全量。
   */
  private requestWithPlan(raw: Record<string, unknown>, capture: AnalysisInputCapture): Record<string, unknown> {
    const request: Record<string, unknown> = { ...raw };
    if (capture.plan === null) delete request.incrementalPlan;
    else request.incrementalPlan = { mode: "partial", dirtyFromAt: capture.plan.dirtyFromAt, domains: capture.plan.domains };
    return request;
  }

  /** 捕获请求的构造（登记计划 → 捕获请求的映射只留一份）。 */
  private captureRequest(job: RecomputeJob, raw: Record<string, unknown>): Parameters<AnalysisInputSource["capture"]>[0] {
    // 「原任务未发布范围」的批次证据：单任务 = 它自己的批次；合并任务 = 成员并集
    // （`importBatchIds` 由 `insertCoveringJob` 写进载荷）。捕获器用它①在无可信基线时
    // 判断"库里还有没有未被任何途径覆盖的影响批次"，②写 `analysis_job_coverage`
    // 的"实际执行覆盖批次"。
    const registeredBatchIds: string[] = [];
    if (Array.isArray(raw.importBatchIds)) {
      for (const value of raw.importBatchIds) {
        if (typeof value === "string" && value.length > 0 && !registeredBatchIds.includes(value)) {
          registeredBatchIds.push(value);
        }
      }
    }
    if (typeof raw.importBatchId === "string" && raw.importBatchId.length > 0
        && !registeredBatchIds.includes(raw.importBatchId)) {
      registeredBatchIds.push(raw.importBatchId);
    }
    return {
      runId: "",
      jobId: job.id,
      scope: "direct-sync",
      timezoneIdentifier: typeof raw.timezoneIdentifier === "string" ? raw.timezoneIdentifier : DATABASE_TIMEZONE,
      evaluatedAt: typeof raw.evaluatedAt === "string" ? normalizeInstant(raw.evaluatedAt, "evaluatedAt") : appNow(),
      targetRawGeneration: job.targetRawGeneration ?? null,
      targetDependencyGeneration: job.targetDependencyGeneration ?? null,
      expectedIncumbentReleaseId: job.expectedIncumbentReleaseId ?? null,
      registeredBatchIds,
      registeredPlan: typeof raw.incrementalPlan === "object" && raw.incrementalPlan !== null
        && (raw.incrementalPlan as { mode?: unknown }).mode === "partial"
        && typeof (raw.incrementalPlan as { dirtyFromAt?: unknown }).dirtyFromAt === "string"
        ? {
            dirtyFromAt: normalizeInstant((raw.incrementalPlan as { dirtyFromAt: string }).dirtyFromAt, "dirtyFromAt"),
            domains: (raw.incrementalPlan as { domains?: AnalysisDirtyDomains }).domains
              ?? { features: normalizeInstant((raw.incrementalPlan as { dirtyFromAt: string }).dirtyFromAt, "dirtyFromAt"), fitness: null, readiness: null }
          }
        : null
    };
  }

  /**
   * 段间判据（O06-A 步骤 5）：每个续算分段/阶段开工前核对依赖绑定未变。
   *
   * - **分段模式**：`assertPinned` 在依赖代次变化时抛 `AnalysisInputDriftError` ⇒ 候选作废、
   *   保留旧发布结果、合并新增 dirty 范围后重排（{@link replanAfterInputDrift}）。
   * - **物化模式**：整份输入来自一个读事务，快照本身就是判据 —— 代次前进**不**作废候选，
   *   它由发布短事务里的依赖级判据（D4）裁决。这里只留痕，避免"悄悄放过一次代次前进"。
   */
  private assertPinnedStage(jobId: string, stage: string): void {
    const view = this.factView;
    if (view === null) return;
    const binding = this.pendingInputCapture?.binding;
    const observed = view.observeGenerations();
    view.assertPinned(`stage:${stage}`);
    if (binding === undefined) return;
    if (observed.raw !== binding.capturedRawGeneration ||
        observed.dependency !== binding.capturedDependencyGeneration) {
      this.jobs.logEvent(jobId, "input_binding", 0, 0,
        `Generation advanced during ${stage}: captured ${binding.capturedRawGeneration}/${binding.capturedDependencyGeneration}, ` +
        `observed ${observed.raw}/${observed.dependency} (materialized snapshot kept)`);
    }
  }

  /**
   * R06 **覆盖守卫**：某一步"需要的最早事实时刻"必须落在快照的物化覆盖之内。
   *
   * ## 它防的是什么（唯一的病灶形态）
   *
   * "计划说会复用、实际却要更早的事实"：计划一边给出裁剪边界（物化按它裁），运行时复用
   * 被更深层证据拒绝、退化成从头重算（例如 `reuseFeaturePrefix` 返回 null ⇒ 特征阶段要吃
   * 全史训练；`resumeModelReplay` 拒绝 ⇒ 分区日链从最早一天起）。那一刻快照里**没有**
   * 那些更早的行 —— 照旧读就是静默少读（少几行心率 ⇒ 峰值证据消失 ⇒ 分区/负荷悄悄变值）。
   * 越界必须显式失败：调用方（{@link runDirectSyncAnalysis}）捕获后关闭裁剪重捕获一次。
   *
   * ## 判据的量（不是"会话起点比边界早就算越界"）
   *
   * 比较的是**读取窗口的下沿**：`需要的最早时刻 = 最早被算会话/日期 − 该阶段的最大回看窗`。
   * 阶段窗常量与各读口一一对应（{@link SESSION_RECORDS_LOOKBACK_MS} 训练装配、
   * {@link RECORDS_MAX_LOOKBACK_MS} 证据链），加错窗就是把守卫调成恒真或恒假。
   *
   * `requiredFrom === null`（本阶段没有需要的事实）、越界侧未裁剪（`snapshotCoverage`
   * 缺省 = 分段模式读源库；`recordsFrom/routeFrom === null` = 全量物化）都直接放行。
   */
  private assertFactCoverage(
    requiredFrom: string | null,
    kind: "records" | "route",
    context: string
  ): void {
    const coverage = this.factView?.snapshotCoverage;
    if (coverage === undefined || requiredFrom === null) return;
    const coverageFrom = kind === "records" ? coverage.recordsFrom : coverage.routeFrom;
    if (coverageFrom === null) return;
    if (Date.parse(requiredFrom) >= Date.parse(coverageFrom)) return;
    throw new AnalysisInputCoverageOutOfBoundsError(kind, requiredFrom, coverageFrom, context);
  }

  /** 一组会话里最早的 `workout_start_at`（毫秒）；一个都不可解析 ⇒ `null`（本阶段无事实需求）。 */
  private earliestWorkoutStartAt(sessions: Iterable<{ workoutStartAt: string }>): number | null {
    let earliest: number | null = null;
    for (const session of sessions) {
      const parsed = Date.parse(session.workoutStartAt);
      if (!Number.isFinite(parsed)) continue;
      if (earliest === null || parsed < earliest) earliest = parsed;
    }
    return earliest;
  }

  /**
   * 漂移后的重排（O06-A 步骤 5）：**保留旧发布结果**（本次候选什么都没发布），
   * 把"漂移弄脏的范围"并进 dirty 后登记一条续算任务。
   *
   * ## 🔴 R01（2026-10-16 复查）：重排必须守恒原任务尚未发布的 dirty 范围
   *
   * 这里**不得**清空原任务的登记计划（曾经的 `registeredPlan: null` 就是 R01 的病灶）：
   * 原任务范围内的早期更正（A）只活在它自己的 `incrementalPlan` 里，候选漂移作废之后
   * 没有任何其他载体保存它 —— 重排时把它丢掉，后继任务只会算"漂移之后"的批次（B），
   * A 永远不被重算，而发布却宣称已到最新代次。
   *
   * 修复后的合并语义：**新计划 = 漂移弄脏的批次账本 ∪ 原任务计划**（逐域取最早），
   * 由捕获器里的**同一份**合并实现（`mergeDirtyPlans`）执行 —— 与合并任务的
   * "调度成员 ∪ 未入选批次"共用一处，不允许这个函数里再写一套 MIN(dirty)。
   * 计划边界可以保持或向前扩大，永不后移。
   *
   * ⛔ 不在这里发布任何东西、不拼接"最新一段"：漂移的候选整体丢掉。
   * ⛔ 重排次数有上限（`MAX_BINDING_DRIFT_REPLANS`）：反复漂移时不再无限登记任务，
   * 当前任务以显式原因失败，由调用方/调度决定下一步（防饿死的上限属 O06-B）。
   */
  private replanAfterInputDrift(
    job: RecomputeJob,
    raw: Record<string, unknown>,
    drift: AnalysisInputDriftError
  ): "requeued" | "gave_up" {
    const attempts = Number(raw.bindingDriftReplans ?? 0);
    this.jobs.logEvent(job.id, "input_binding", 0, 0,
      `Analysis input drifted during ${drift.stage} (dependency ${drift.expected.dependency} -> ${drift.observed.dependency}); ` +
      `published release kept, candidate dropped (replan attempt ${attempts + 1}/${MAX_BINDING_DRIFT_REPLANS})`);
    if (attempts >= MAX_BINDING_DRIFT_REPLANS || this.inputSource === undefined) return "gave_up";
    let replan: AnalysisInputCapture;
    try {
      // 重新捕获一次：`captureRequest` 会带上原任务的登记计划与批次证据（R01 守恒的一半），
      // `mergeFromRawGeneration` 补上"漂移前捕获的 raw 代次之后"的账本（另一半的兼容路径
      // 起点；有可信基线时由基线起算，本字段不再承担语义）。
      replan = this.inputSource.capture({
        ...this.captureRequest(job, raw),
        mergeFromRawGeneration: drift.expected.raw
      });
    } catch (error) {
      // 重排捕获本身失败（例如刚被写者占住）：不再登记任务，让当前任务以显式原因失败 ——
      // 但**必须留痕**，"想重排却没排成"不能只在日志里缺失。
      this.jobs.logEvent(job.id, "input_binding", 0, 0,
        `Replan capture failed after input drift: ${error instanceof Error ? error.message : String(error)}`);
      return "gave_up";
    }
    const request: Record<string, unknown> = { ...raw, bindingDriftReplans: attempts + 1 };
    if (replan.plan === null) delete request.incrementalPlan;
    else request.incrementalPlan = { mode: "partial", dirtyFromAt: replan.plan.dirtyFromAt, domains: replan.plan.domains };
    // ⛔ datasetVersion 取**重排捕获自己的绑定**，不要走 `this.manifestValue`：那会经过
    // `this.facts`，而此刻旧的（已漂移的）事实视图还挂着 —— 再去读它等于让同一个漂移
    // 在重排路径里再抛一次，于是"登记重排任务"这一步永远走不到。
    //
    // 🔴 B03（2026-10-17）：**退回原任务**，不新建后继。原 `analysisJobId` 就是客户端
    // 手里那个 id —— 新建一条后继会让原 id 永久停在 failed，而真正算完的是另一个 id。
    // 重排次数写在请求载荷里（`bindingDriftReplans`），原回执与登记代次的含义不变。
    const outcome = this.jobs.requeueForReplan(
      job.id,
      request,
      {
        targetRawGeneration: replan.binding.capturedRawGeneration,
        targetDependencyGeneration: replan.binding.capturedDependencyGeneration,
        ...(replan.binding.incumbentReleaseId === null
          ? {}
          : { expectedIncumbentReleaseId: replan.binding.incumbentReleaseId })
      },
      `Replanned after input drift during ${drift.stage} (attempt ${attempts + 1}/${MAX_BINDING_DRIFT_REPLANS})`
    );
    replan.facts.dispose();
    if (outcome === "cancelled") {
      // 用户取消优先：不放回队列，也不在这里改写终态 —— `runNextJob` 的 catch 会按
      // `cancel_requested` 把任务结算成 cancelled。
      return "gave_up";
    }
    return outcome === "requeued" ? "requeued" : "gave_up";
  }

  runSnapshotRefresh(job: RecomputeJob): void {
    this.recordCache.clear();
    this.workoutAssemblyCache.clear();
    this.pendingReuseCounters = null;
    const request = this.parseRequest(job.request);
    this.throwIfCancelled(job.id);
    const active = this.database
      .prepare("SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1")
      .get() as unknown as { modelRunId: string } | undefined;
    if (!active) {
      this.completeJob(job.id, "no_active_model", 0, 0, "No active model run to refresh");
      return;
    }
    this.setJobRunIds(job.id, null, active.modelRunId);
    this.throwIfCancelled(job.id);
    const timeline = this.loadTimelineAssessments(active.modelRunId);
    this.writeDailySnapshots(
      active.modelRunId,
      timeline,
      request.evaluatedAt,
      request.timezoneIdentifier,
      true
    );
    this.throwIfCancelled(job.id);
    const metricRun = this.database
      .prepare("SELECT id FROM training_metric_runs WHERE model_run_id = ? AND status = 'succeeded'")
      .get(active.modelRunId) as unknown as { id: string } | undefined;
    if (metricRun) {
      const isV4=this.database.prepare(`SELECT f.feature_schema_version AS schema FROM model_runs m
        JOIN feature_runs f ON f.id=m.feature_run_id WHERE m.id=?`).get(active.modelRunId)?.schema==="workout-feature-v4";
      const featureRunId = this.modelRuns.featureRunId(active.modelRunId);
      if (featureRunId && isV4) {
        this.buildAndPersistZoneProfiles(
          metricRun.id,
          this.loadFeatureRunVectors(featureRunId),
          new Map(this.loadSessions(request.evaluatedAt).map((session) => [session.trainingSessionId, session])),
          request
        );
        this.throwIfCancelled(job.id);
      }
      const loads = this.loadPersistedTrainingLoads(metricRun.id);
      const throughDate = localDateAt(request.evaluatedAt, request.timezoneIdentifier);
      const existingThrough = this.database
        .prepare("SELECT MAX(local_date) AS localDate FROM daily_training_metrics WHERE training_metric_run_id = ?")
        .get(metricRun.id) as unknown as { localDate: string | null };
      if (existingThrough.localDate === null || existingThrough.localDate < throughDate) {
        const startDate = loads[0]?.localDate ?? throughDate;
        const physEvidence = (isV4 ? this.loadDailyPhysEvidence.bind(this) : this.loadLegacyDailyPhysEvidence.bind(this))(startDate, throughDate, request.timezoneIdentifier, request.evaluatedAt);
        const daily = (isV4 ? buildDailyTrainingMetrics : buildLegacyDailyTrainingMetrics)(loads, throughDate, physEvidence);
        this.persistDailyTrainingMetrics(metricRun.id, daily, request, true);
      }
    }
    this.throwIfCancelled(job.id);
    this.completeJob(job.id, "snapshot_refreshed", 1, 1, "Current-day snapshot appended");
  }

  private parseRequest(value: Record<string, unknown>): RecomputeRequest {
    const parsed = value as Partial<RecomputeRequest>;
    return {
      evaluatedAt: normalizeInstant(
        typeof parsed.evaluatedAt === "string" ? parsed.evaluatedAt : appNow(),
        "evaluatedAt"
      ),
      timezoneIdentifier:
        typeof parsed.timezoneIdentifier === "string" ? parsed.timezoneIdentifier : DATABASE_TIMEZONE,
      featureConfig: { ...defaultFeatureConfig, ...(parsed.featureConfig ?? {}) },
      modelConfig: { ...defaultRaiModelConfig, ...(parsed.modelConfig ?? {}) }
      // (2026-09-20) `validationMode` is deliberately not read back: historical
      // job.request records still carry the key, and the shadow replay it selected
      // no longer exists. Ignoring it keeps old jobs replayable.
      ,...(typeof parsed.importBatchId === "string" ? { importBatchId: parsed.importBatchId } : {})
      ,...(parsed.incrementalPlan?.mode === "partial" && typeof parsed.incrementalPlan.dirtyFromAt === "string"
        ? {
            incrementalPlan: {
              ...parsed.incrementalPlan,
              dirtyFromAt: normalizeInstant(parsed.incrementalPlan.dirtyFromAt, "dirtyFromAt")
            }
          }
        : {})
    };
  }

  private manifestValue(key: string): string | null {
    const row = this.facts
      .prepare("SELECT value FROM import_manifest WHERE key = ?")
      .get(key) as unknown as { value: string } | undefined;
    return row?.value ?? null;
  }

  private createFeatureRun(datasetVersion: string, config: FeatureConfig): FeatureRun {
    const id = opaqueId("feature_run");
    const createdAt = appNow();
    const canonicalContractVersion = this.manifestValue("parser_contract_version") ?? CONTRACT_VERSION;
    this.database
      .prepare(`
        INSERT INTO feature_runs (
          id, dataset_version, canonical_contract_version, feature_schema_version,
          feature_config_json, feature_config_hash, status, created_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `)
      .run(
        id,
        datasetVersion,
        canonicalContractVersion,
        FEATURE_SCHEMA_VERSION,
        JSON.stringify(config),
        configHash({ version: FEATURE_CONFIG_VERSION, config }),
        createdAt,
        createdAt
      );
    return {
      id,
      datasetVersion,
      canonicalContractVersion,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      featureConfig: config as unknown as Record<string, unknown>,
      featureConfigHash: configHash({ version: FEATURE_CONFIG_VERSION, config }),
      status: "running",
      createdAt,
      startedAt: createdAt,
      completedAt: null,
      failure: null
    };
  }

  private finishFeatureRun(
    id: string,
    status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
    error: unknown
  ): void {
    this.database
      .prepare(`
        UPDATE feature_runs
        SET status = ?, completed_at = ?, failure_json = ?
        WHERE id = ?
      `)
      .run(status, appNow(), error === null ? null : JSON.stringify(this.errorPayload(error)), id);
  }

  private createModelRun(
    datasetVersion: string,
    featureRunId: string,
    request: RecomputeRequest
  ): ModelRun {
    const id = opaqueId("model_run");
    const createdAt = appNow();
    const config = request.modelConfig;
    const hash = configHash({ version: MODEL_CONFIG_VERSION, engineVersion: SCORING_MODEL_VERSION, config });
    this.database
      .prepare(`
        INSERT INTO model_runs (
          id, feature_run_id, dataset_version, model_version, model_config_json,
          model_config_hash, evaluated_at, status, created_at, started_at, engine_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
      `)
      .run(
        id,
        featureRunId,
        datasetVersion,
        MODEL_CONFIG_VERSION,
        JSON.stringify(config),
        hash,
        request.evaluatedAt,
        createdAt,
        createdAt,
        // 引擎版本此前只作为 configHash 的输入存在，无法单独查询（§14.4）。历史行保持 NULL。
        SCORING_MODEL_VERSION
      );
    return {
      id,
      featureRunId,
      datasetVersion,
      modelVersion: MODEL_CONFIG_VERSION,
      modelConfig: config as unknown as Record<string, unknown>,
      modelConfigHash: hash,
      evaluatedAt: request.evaluatedAt,
      status: "running",
      createdAt,
      startedAt: createdAt,
      completedAt: null,
      summary: null,
      failure: null
    };
  }

  private finishModelRun(
    id: string,
    status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
    error: unknown
  ): void {
    this.database
      .prepare(`
        UPDATE model_runs
        SET status = ?, completed_at = ?, failure_json = ?
        WHERE id = ?
      `)
      .run(status, appNow(), error === null ? null : JSON.stringify(this.errorPayload(error)), id);
  }

  private createTrainingMetricRun(
    modelRunId: string,
    request: RecomputeRequest,
    overrideSnapshotIds: string[]
  ): string {
    const id = opaqueId("training_metric_run");
    const createdAt = appNow();
    const config = {
      dailyMetrics: defaultDailyMetricConfig,
      zoneVersion: TRAINING_ZONE_CONFIG_VERSION,
      heartRateReserveBoundaries: [0.6, 0.7, 0.8, 0.9],
      paceThresholdMultipliers: [1.15, 1.06, 0.97, 0.9],
      overrideSnapshotIds
    };
    this.database.prepare(`
      INSERT INTO training_metric_runs (
        id, model_run_id, algorithm_version, config_json, config_hash,
        timezone_identifier, evaluated_at, status, created_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      id,
      modelRunId,
      TRAINING_LOAD_CONFIG_VERSION,
      JSON.stringify(config),
      configHash({ version: TRAINING_LOAD_CONFIG_VERSION, config }),
      request.timezoneIdentifier,
      request.evaluatedAt,
      createdAt,
      createdAt
    );
    return id;
  }

  private finishTrainingMetricRun(
    id: string,
    status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
    error: unknown
  ): void {
    const current = this.database
      .prepare("SELECT status FROM training_metric_runs WHERE id = ?")
      .get(id) as unknown as { status: string } | undefined;
    if (!current || current.status !== "running") return;
    const summary = status === "succeeded"
      ? this.database.prepare(`
          SELECT
            (SELECT COUNT(*) FROM workout_training_loads WHERE training_metric_run_id = ?) AS loadCount,
            (SELECT COUNT(*) FROM daily_training_metrics WHERE training_metric_run_id = ?) AS dayCount
        `).get(id, id)
      : null;
    // O09 步骤 2/7：每域 reused／recomputed 计数落进 `summary_json.reuse`（durable、可读）。
    // 失败或取消时不写：一次没跑完的 run 的"复用了几行"不是事实。
    const payload = summary === null ? null : {
      ...(summary as Record<string, unknown>),
      ...(this.pendingReuseCounters === null ? {} : { reuse: this.pendingReuseCounters })
    };
    this.database.prepare(`
      UPDATE training_metric_runs
      SET status = ?, summary_json = ?, failure_json = ?, completed_at = ?
      WHERE id = ?
    `).run(
      status,
      payload === null ? null : JSON.stringify(payload),
      error === null ? null : JSON.stringify(this.errorPayload(error)),
      appNow(),
      id
    );
  }

  private loadSessions(evaluatedAt: string): SessionRow[] {
    // 事实读（O06-A 步骤 3）：固定输入存在时，"这次算哪些训练"必须来自**那一版**事实。
    // 仓储只读且只碰 training_sessions / workouts / workout_statistics，把它构造在事实视图上即可，
    // SQL 不必在这里手抄第二份（两处 SQL 必然漂移）。
    const repository: SqliteTrainingSessionRepository =
      this.factView === null ? this.sessions : new SqliteTrainingSessionRepository(this.facts);
    return (repository.listActiveForFeatures() as SessionRow[]).filter(
      (session) => session.workoutStartAt <= evaluatedAt && session.workoutEndAt <= evaluatedAt
    );
  }

  private captureOverrideSnapshot(): OverrideSnapshot {
    const rows = this.facts.prepare(`
      SELECT * FROM effective_workout_overrides ORDER BY training_session_id
    `).all() as unknown as Array<Record<string, unknown>>;
    const overrides = rows.map((row): WorkoutOverride => ({
      id: String(row.id),
      trainingSessionId: String(row.training_session_id),
      revision: Number(row.revision),
      eligibilityOverride:
        row.eligibility_override === "include" || row.eligibility_override === "exclude"
          ? row.eligibility_override
          : null,
      statisticsParticipation:
        row.statistics_participation === "include" || row.statistics_participation === "exclude"
          ? row.statistics_participation
          : null,
      sessionType: typeof row.session_type === "string" ? row.session_type as SessionType : null,
      performanceProtocol:
        typeof row.performance_protocol === "string"
          ? row.performance_protocol as PerformanceProtocol
          : null,
      rpe: typeof row.rpe === "number" ? row.rpe : null,
      conditionTags: parseJson(typeof row.condition_tags_json === "string" ? row.condition_tags_json : "[]", []),
      note: typeof row.note === "string" ? row.note : null,
      createdAt: String(row.created_at)
    }));
    return {
      ids: overrides.map((override) => override.id),
      byTrainingSessionId: new Map(overrides.map((override) => [override.trainingSessionId, override]))
    };
  }

  private loadStatistic(workoutId: string, type: string): StatisticRow | null {
    const row = this.facts
      .prepare(`
        SELECT average_value AS averageValue, minimum_value AS minimumValue,
               maximum_value AS maximumValue, unit
        FROM workout_statistics
        WHERE workout_id = ? AND type = ?
        ORDER BY ordinal
        LIMIT 1
      `)
      .get(workoutId, type) as unknown as StatisticRow | undefined;
    return row ?? null;
  }

  private loadRecordSeries(
    sourceName: string,
    workoutStartAt: string,
    workoutEndAt: string,
    type: string
  ): RecordRow[] {
    const key = JSON.stringify([sourceName, workoutStartAt, workoutEndAt, type]);
    const cached = this.recordCache.get(key);
    if (cached !== undefined) return cached;
    const records = this.queryRecordSeries(sourceName, workoutStartAt, workoutEndAt, type);
    this.recordCache.set(key, records, records.length);
    return records;
  }

  private queryRecordSeries(
    sourceName: string, workoutStartAt: string, workoutEndAt: string, type: string
  ): RecordRow[] {
    const unitSelect = this.hasHealthRecordUnitColumn() ? ", unit" : "";
    const exact = this.facts
      .prepare(`
        SELECT value_numeric AS value, start_at AS startAt, end_at AS endAt${unitSelect}
        FROM (
          SELECT DISTINCT value_numeric, start_at, end_at${unitSelect}
          FROM health_records
          WHERE source_name = ?
            AND type = ?
            AND value_numeric IS NOT NULL
            AND start_at <= ?
            AND end_at >= ?
        )
        ORDER BY start_at
      `)
      .all(sourceName, type, workoutEndAt, workoutStartAt) as unknown as RecordRow[];
    if (exact.length > 0 || type !== heartRateType) return exact;

    const fallback = this.facts.prepare(`
      SELECT source_name AS sourceName
      FROM health_records
      WHERE source_name <> ? AND type = ? AND value_numeric IS NOT NULL
        AND start_at <= ? AND end_at >= ?
        AND source_category IN ('apple_watch', 'coros', 'huawei', 'connect', 'other')
      GROUP BY source_name
      ORDER BY
        CASE MAX(source_category)
          WHEN 'apple_watch' THEN 5 WHEN 'coros' THEN 4 WHEN 'huawei' THEN 3
          WHEN 'connect' THEN 2 ELSE 1
        END DESC,
        COUNT(*) DESC,
        source_name
      LIMIT 1
    `).get(sourceName, type, workoutEndAt, workoutStartAt) as unknown as { sourceName: string } | undefined;
    if (!fallback) return exact;
    return this.facts.prepare(`
      SELECT value_numeric AS value, start_at AS startAt, end_at AS endAt${unitSelect}
      FROM (
        SELECT DISTINCT value_numeric, start_at, end_at${unitSelect}
        FROM health_records
        WHERE source_name = ? AND type = ? AND value_numeric IS NOT NULL
          AND start_at <= ? AND end_at >= ?
      )
      ORDER BY start_at
    `).all(fallback.sourceName, type, workoutEndAt, workoutStartAt) as unknown as RecordRow[];
  }

  /** 本次事实视图下的基线读取器（按 `localDate` 缓存）；时区变化时重建。 */
  private recoveryBaselines(timezoneIdentifier: string): RecoveryBaselineReader {
    if (this.recoveryBaselineCache?.timezoneIdentifier !== timezoneIdentifier) {
      this.recoveryBaselineCache = {
        timezoneIdentifier,
        reader: new RecoveryBaselineReader(this.facts, timezoneIdentifier)
      };
    }
    return this.recoveryBaselineCache.reader;
  }

  private loadPersonalRecovery(workoutStartAt: string, timezoneIdentifier: string): {
    restingHeartRate: number | null;
    hrvSdnn: number | null;
    sleepDurationMinutes: number | null;
    recentLoadMinutes: number | null;
    baseline: NonNullable<WorkoutFeatureSource["recoveryBaseline"]>;
    context: NonNullable<WorkoutFeatureSource["recoveryContext"]>;
  } {
    const instant = Date.parse(workoutStartAt);
    const localDate = localDateAt(workoutStartAt, timezoneIdentifier);
    const medianValue = (values: number[]): number | null => {
      const valid = values.filter((value) => Number.isFinite(value));
      return valid.length ? median(valid) : null;
    };
    const night = this.facts.prepare(`
      SELECT id, wake_at AS wakeAt, asleep_union_minutes AS sleepMinutes
      FROM canonical_nights
      WHERE kind = 'main' AND timezone_identifier = ? AND wake_at IS NOT NULL AND wake_at < ?
      ORDER BY wake_at DESC LIMIT 1
    `).get(timezoneIdentifier, workoutStartAt) as unknown as { id: string; wakeAt: string; sleepMinutes: number | null } | undefined;
    const recentNight = night && Number.isFinite(Date.parse(night.wakeAt)) && instant - Date.parse(night.wakeAt) <= 36 * 3_600_000
      ? night
      : undefined;
    const hrv = recentNight
      ? this.facts.prepare(`
          SELECT hrv_sdnn_ms AS value, confidence
          FROM canonical_hrv_days WHERE night_id = ? AND hrv_sdnn_ms IS NOT NULL
            AND window_end_at IS NOT NULL AND window_end_at < ?
          ORDER BY computed_at DESC LIMIT 1
        `).get(recentNight.id, workoutStartAt) as unknown as { value: number; confidence: string } | undefined
      : undefined;
    const rhrRows = this.facts.prepare(`
      SELECT source_category AS sourceCategory, value_numeric AS value
      FROM health_records
      WHERE type = ? AND value_numeric IS NOT NULL
        AND source_category IN ('apple_watch', 'connect')
        AND start_at >= ? AND start_at < ?
      ORDER BY start_at
    `).all(
      restingHeartRateType,
      new Date(instant - 36 * 3_600_000).toISOString(),
      workoutStartAt
    ) as unknown as Array<{ sourceCategory: string; value: number }>;
    const watchRhr = rhrRows.filter((row) => row.sourceCategory === "apple_watch");
    const restingHeartRate = medianValue((watchRhr.length ? watchRhr : rhrRows).map((row) => Number(row.value)));

    // 🔴 四条基线只由 `localDate` 决定，与本次会话的具体时刻无关（见 RecoveryBaselineReader）：
    // 同一本地日的多场训练共用一次计算，load 基线的时间下界也进了 SQL。
    const baseline = this.recoveryBaselines(timezoneIdentifier).baseline(localDate);
    const recentLoadRows = this.facts.prepare(`SELECT SUM(duration_seconds)/60.0 AS value FROM training_sessions session JOIN workouts workout ON workout.id=session.canonical_workout_id WHERE session.activity_type=? AND session.status='active' AND workout.start_at >= ? AND workout.start_at < ?`).get(runningType, new Date(instant - 7 * 86_400_000).toISOString(), workoutStartAt) as unknown as { value: number | null } | undefined;
    return {
      restingHeartRate,
      hrvSdnn: hrv?.value == null ? null : Number(hrv.value),
      sleepDurationMinutes: recentNight?.sleepMinutes == null ? null : Number(recentNight.sleepMinutes),
      recentLoadMinutes: asNullableNumber(recentLoadRows?.value),
      baseline: {
        sleepMinutes: baseline.sleepMinutes,
        restingHeartRateBpm: baseline.restingHeartRateBpm,
        hrvSdnnMs: baseline.hrvSdnnMs,
        loadMinutes: baseline.loadMinutes,
        lookbackDays: baseline.lookbackDays,
        validDays: baseline.validDays
      },
      context: {
        asOfAt: workoutStartAt,
        nightId: recentNight?.id ?? null,
        hrvConfidence: hrv?.confidence as NonNullable<WorkoutFeatureSource["recoveryContext"]>["hrvConfidence"] ?? null,
        rhrSourceCategory: watchRhr.length ? "apple_watch" : rhrRows.length ? "connect" : null
      }
    };
  }

  private loadObservedMaximumHeartRate(workoutStartAt: string): number | null {
    const cutoff = new Date(Date.parse(workoutStartAt) - 180 * 86_400_000).toISOString();
    const row = this.facts
      .prepare(`
        SELECT MAX(value_numeric) AS value
        FROM health_records
        WHERE type = ? AND value_numeric IS NOT NULL
          AND start_at >= ? AND start_at < ?
      `)
      .get(heartRateType, cutoff, workoutStartAt) as unknown as { value: number | null } | undefined;
    return asNullableNumber(row?.value);
  }


  private loadRecentLoadMinutes(workoutStartAt: string): number | null {
    const cutoff = new Date(Date.parse(workoutStartAt) - 7 * 86_400_000).toISOString();
    const row = this.facts
      .prepare(`
        SELECT SUM(workout.duration_seconds) / 60.0 AS value
        FROM training_sessions session
        JOIN workouts workout ON workout.id = session.canonical_workout_id
        WHERE session.activity_type = ? AND session.status = 'active'
          AND workout.start_at >= ? AND workout.start_at < ?
      `)
      .get(runningType, cutoff, workoutStartAt) as unknown as { value: number | null } | undefined;
    return asNullableNumber(row?.value);
  }

  /**
   * 路线质量证据（点数 + 水平精度均值）。
   *
   * 🔴 取数走**唯一**的路线点入口（`SqliteRoutePointReader` → `readable_route_points` 视图）：
   * 改造前这里点数来自不判状态的 `route_points`，与隔壁 {@link loadElevationGain}
   * 的口径不一致。现在两者同源，且"哪种路线算可读"只有一处定义。
   */
  private loadRouteQuality(workoutId: string): RouteQualityRow {
    return new SqliteRoutePointReader(this.facts).routeQualityForWorkout(workoutId);
  }

  private loadElevationGain(workoutId: string): number | null {
    if (this.allowNativeAggregates && this.nativeElevationGains?.has(workoutId)) {
      return this.nativeElevationGains.get(workoutId) ?? null;
    }
    // 与 `loadRouteQuality` 同一个入口：判据不对称就是那两个方法各写一遍条件的产物。
    // Rust 侧的 `aggregate()` 读的也是同一个视图（`crates/rai-data-worker/src/main.rs`），
    // 所以"走 native 聚合"与"回落到这里"给出的数字来自同一份可读集合。
    return new SqliteRoutePointReader(this.facts).elevationGain(workoutId);
  }

  private buildFeatureSource(row: SessionRow, override: WorkoutOverride | null, timezoneIdentifier: string = DATABASE_TIMEZONE): WorkoutFeatureSource {
    const heartRecords = this.loadRecordSeries(
      row.sourceName,
      row.workoutStartAt,
      row.workoutEndAt,
      heartRateType
    );
    const speedRecords = this.loadRecordSeries(
      row.sourceName,
      row.workoutStartAt,
      row.workoutEndAt,
      runningSpeedType
    );
    const heartRate = heartRecords.length > 0
      ? summaryFromRecords(heartRecords, "count/min", row.workoutStartAt, row.workoutEndAt)
      : fallbackStatisticSummary(
          this.loadStatistic(row.canonicalWorkoutId, heartRateType),
          row.workoutStartAt,
          row.workoutEndAt
        );
    const speed = speedRecords.length > 0
      ? summaryFromRecords(
          speedRecords,
          null,
          row.workoutStartAt,
          row.workoutEndAt,
          convertSpeedToMetersPerSecond
        )
      : fallbackStatisticSummary(
          this.loadStatistic(row.canonicalWorkoutId, runningSpeedType),
          row.workoutStartAt,
          row.workoutEndAt,
          convertSpeedToMetersPerSecond
        );
    const route = this.loadRouteQuality(row.canonicalWorkoutId);
    const routeQuality =
      route.pointCount === 0
        ? null
        : route.averageHorizontalAccuracy === null
          ? 0.75
          : clamp(1 - route.averageHorizontalAccuracy / 50, 0, 1);
    return {
      id: row.canonicalWorkoutId,
      trainingSessionId: row.trainingSessionId,
      trainingSessionStatus: row.trainingSessionStatus,
      workoutStartAt: row.workoutStartAt,
      workoutEndAt: row.workoutEndAt,
      durationSeconds: Number(row.durationSeconds),
      distanceKm: convertDistanceToKilometers(asNullableNumber(row.distanceValue), row.distanceUnit),
      indoor: row.indoor === null ? null : Number(row.indoor) === 1,
      sourceCategory: row.sourceCategory,
      routePointCount: route.pointCount,
      routeQuality,
      speed,
      speedSamples: this.workoutAssembly(row).speedIntervals.map((interval) => ({
        value: interval.value,
        startOffsetSeconds: Math.max(0, (interval.startMs - Date.parse(row.workoutStartAt)) / 1000),
        durationSeconds: interval.durationSeconds
      })),
      heartRate,
      heartRateSamples: this.workoutAssembly(row).heartIntervals.map((interval) => ({
        value: interval.value, startOffsetSeconds: Math.max(0,(interval.startMs-Date.parse(row.workoutStartAt))/1000),durationSeconds:interval.durationSeconds
      })),
      environment: parsePerformanceConditions(String(this.facts.prepare("SELECT metadata_json FROM workouts WHERE id=?").get(row.canonicalWorkoutId)?.metadata_json ?? "{}")),
      ...(() => {
        const recovery = this.loadPersonalRecovery(row.workoutStartAt, timezoneIdentifier);
        return {
          restingHeartRate: recovery.restingHeartRate,
          // Prior-day reference only. Missing history must not reopen the
          // recovery -> HRR -> session type -> Fitness channel.
          restingHeartRateReference: recovery.baseline.restingHeartRateBpm,
          hrvSdnn: recovery.hrvSdnn,
          sleepDurationMinutes: recovery.sleepDurationMinutes,
          recentLoadMinutes: recovery.recentLoadMinutes,
          recoveryBaseline: recovery.baseline,
          recoveryContext: recovery.context
        };
      })(),
      observedMaximumHeartRate: this.loadObservedMaximumHeartRate(row.workoutStartAt),
      override
    };
  }

  private extractFeatures(
    jobId: string,
    featureRun: FeatureRun,
    request: RecomputeRequest,
    overrideSnapshot: OverrideSnapshot
  ): WorkoutFeatureVector[] {
    const allSessions = this.loadSessions(request.evaluatedAt);
    const reuse = this.featurePrefixPlan(request, overrideSnapshot);
    const sessions = reuse === null
      ? allSessions
      : allSessions.filter((session) => session.workoutStartAt >= reuse.dirtyFromAt);
    // R06 覆盖守卫（特征阶段）：本阶段读的是"被算会话窗内的明细 + 每场训练 180 天心率回看
    // （`loadObservedMaximumHeartRate`）"与会话名下的路线点（质量/高程）。复用被拒
    // （`reuse === null`）时 `sessions` 是全史 —— 需要的最早时刻一下子退到最早一场训练，
    // 越界必须在这里显式失败，而不是对着被裁掉的快照照读（那会静默少读心率/高程）。
    const earliestSessionStart = this.earliestWorkoutStartAt(sessions);
    this.assertFactCoverage(
      earliestSessionStart === null
        ? null
        : new Date(earliestSessionStart - SESSION_RECORDS_LOOKBACK_MS).toISOString(),
      "records", "feature_extraction");
    this.assertFactCoverage(
      earliestSessionStart === null ? null : new Date(earliestSessionStart).toISOString(),
      "route", "feature_extraction");
    // ⛔ 前缀拷贝排在守卫之后（"证明先于写入"）：越界时整条候选作废重来，此时若前缀行已经
    // 拷进 `workout_features`，库里就多出一份挂在废弃 feature run 下的孤儿行。
    const reusedCount = reuse === null ? 0 : this.copyFeaturePrefix(featureRun, reuse);
    const insert = this.database.prepare(`
      INSERT INTO workout_features (
        id, feature_run_id, training_session_id, canonical_workout_id,
        workout_start_at, duration_seconds, distance_km, average_speed_mps,
        average_heart_rate_bpm, heart_rate_sample_count, heart_rate_coverage,
        route_point_count, route_quality, source_confidence, session_type,
        session_type_source, eligibility_status, quality_score,
        missing_reasons_json, features_json, provenance_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const features: WorkoutFeatureVector[] = [];
    // O07 步骤 4：≤100 行一个许可窗口（让路点在**提交之后**，见 `ChunkedWriter`）。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (const [index, session] of sessions.entries()) {
      this.throwIfCancelled(jobId);
      // 让路点（PR4 §3.2.1）：把"接收优先"的等待上界从"一整轮"压到"一小段计算"。
      // 此刻没有开着的事务（分块在 `add()` 内即时提交），所以它是真的让路点。
      this.gate.yieldIfStale();
      const featureId = deterministicId("workout_feature", {
        featureRunId: featureRun.id,
        trainingSessionId: session.trainingSessionId
      });
      const source = this.buildFeatureSource(session, overrideSnapshot.byTrainingSessionId.get(session.trainingSessionId) ?? null, request.timezoneIdentifier);
      const v4 = extractWorkoutFeatureVectorV4(featureId, featureRun.id, source, request.featureConfig, request.evaluatedAt);
      const feature = projectFeatureV4(v4);
      // Small pure counterfactual, not a second full recomputation/shadow system.
      // 🔴 2026-10-15（P2-6）口径：这是**运行期哨兵**，不是数据证据。恒真的根因比"强制
      // null"更深 —— 突变实测（移除 `v4.ts:19-21` 的 null 覆盖后本反事实**仍恒真**）：V3
      // 冻结提取器本身就不消费 recovery 输入，null 覆盖是双保险。哨兵真正转红的条件 =
      // recovery 进入 **payload 输出**（已验证：给 payload.raw 注入一个 recovery 值，
      // 测试层的属性断言即转红）。数据证据在 `packages/features/test/v4.test.ts` 的
      // 参数化属性测试。
      const counterfactual = projectFeatureV4(extractWorkoutFeatureVectorV4(featureId, featureRun.id, {
        ...source, restingHeartRate: 99, hrvSdnn: 1, sleepDurationMinutes: 1, recentLoadMinutes: 9999
      }, request.featureConfig, request.evaluatedAt));
      this.recoveryIsolationHolds &&= semanticHash(feature) === semanticHash(counterfactual);
      writer.add(() => {
        insert.run(
          feature.id,
          feature.featureRunId,
          feature.trainingSessionId,
          feature.canonicalWorkoutId,
          feature.workoutStartAt,
          feature.durationSeconds,
          feature.distanceKm,
          feature.averageSpeedMetersPerSecond,
          feature.averageHeartRateBpm,
          feature.heartRateSampleCount,
          feature.heartRateCoverage,
          feature.routePointCount,
          feature.routeQuality,
          feature.sourceConfidence,
          feature.sessionType,
          feature.sessionTypeSource,
          feature.eligibilityStatus,
          feature.qualityScore,
          JSON.stringify(feature.missingReasons),
          encodeFeaturePayloadV4(v4.payload),
          JSON.stringify(v4.provenance),
          feature.computedAt
        );
        this.updateJobProgress(jobId, "feature_extraction", index + 1, sessions.length, "Feature extracted");
      });
      features.push(feature);
    }
    writer.flush();
    this.database.prepare(`
      UPDATE feature_runs SET reused_feature_count = ?, recomputed_feature_count = ? WHERE id = ?
    `).run(reusedCount, features.length, featureRun.id);
    return reuse === null ? features : this.loadFeatureRunVectors(featureRun.id);
  }

  /**
   * 前缀**行**（只读）：父 feature run 里"边界之前、且已到达 asOf"的那一段。
   * O04（WP-20）：边界优先取分域边界（`domains.features` = 相交训练回退后的保守下界）；
   * 老 payload 没有 `domains` 时回落单一边界 `dirtyFromAt`。`domains` 存在但为 null
   * 表示"full"（不复用）——不得再回落到 dirtyFromAt（那是 payload 内部矛盾态），
   * 所以调用方在 `dirtyFromAt` 缺失时直接不选行（{@link featurePrefixPlan}）。
   */
  private featurePrefixRows(
    parentFeatureRunId: string,
    request: RecomputeRequest,
    dirtyFromAt: string
  ): Array<Record<string, SQLInputValue>> {
    return this.database.prepare(`
      SELECT feature.*
      FROM workout_features feature
      JOIN training_sessions session ON session.id = feature.training_session_id
      JOIN workouts workout ON workout.id = session.canonical_workout_id
      WHERE feature.feature_run_id = ? AND feature.workout_start_at < ?
        AND workout.start_at <= ? AND workout.end_at <= ?
      ORDER BY feature.workout_start_at, feature.id
    `).all(parentFeatureRunId, dirtyFromAt, request.evaluatedAt, request.evaluatedAt) as unknown as Array<Record<string, SQLInputValue>>;
  }

  /**
   * 前缀重用**决策**（O09 步骤 2 的特征侧；纯读，不写任何行）。
   *
   * 🔴 R06（2026-10-17）把"决策"与"拷贝"拆开（拷贝见 {@link copyFeaturePrefix}）：覆盖守卫
   * 必须落在"证明之后、写入之前"—— 越界时整条候选要作废重来，若前缀行已经拷进
   * `workout_features`（挂在这条即将废弃的 feature run 下），库里就多出一份没人读的孤儿行。
   * 这与仓里既有的"证明先于写入"（分区/负荷的集合拷贝）是同一条纪律。
   */
  private featurePrefixPlan(
    request: RecomputeRequest,
    overrideSnapshot: OverrideSnapshot
  ): { dirtyFromAt: string; parentId: string; rows: Array<Record<string, SQLInputValue>> } | null {
    const plan = request.incrementalPlan;
    const dirtyFromAt = plan?.domains ? plan.domains.features : plan?.dirtyFromAt;
    if (!dirtyFromAt) return null;
    const parent = this.database.prepare(`
      SELECT feature.id, feature.feature_config_hash AS configHash,
             feature.feature_schema_version AS schemaVersion,
             feature.canonical_contract_version AS contractVersion,
             metric.timezone_identifier AS timezone, metric.config_json AS metricConfig
      FROM active_model_run active
      JOIN model_runs model ON model.id = active.model_run_id AND model.status = 'succeeded'
      JOIN feature_runs feature ON feature.id = model.feature_run_id AND feature.status = 'succeeded'
      JOIN training_metric_runs metric ON metric.model_run_id = model.id AND metric.status = 'succeeded'
      WHERE active.singleton = 1
    `).get() as unknown as { id: string; configHash: string; schemaVersion: string; contractVersion: string; timezone: string; metricConfig: string } | undefined;
    const contract = this.manifestValue("parser_contract_version") ?? CONTRACT_VERSION;
    if (!parent || parent.configHash !== configHash({ version: FEATURE_CONFIG_VERSION, config: request.featureConfig }) ||
        parent.schemaVersion !== FEATURE_SCHEMA_VERSION || parent.contractVersion !== contract ||
        parent.timezone !== request.timezoneIdentifier) return null;
    const rows = this.featurePrefixRows(parent.id, request, dirtyFromAt);
    const expected = this.loadSessions(request.evaluatedAt).filter((session) => session.workoutStartAt < dirtyFromAt);
    const bySession = new Map(rows.map((row) => [String(row.training_session_id), row]));
    const oldOverrideIds = parseJson<{ overrideSnapshotIds?: unknown } | null>(parent.metricConfig, null)?.overrideSnapshotIds;
    if (!Array.isArray(oldOverrideIds) || oldOverrideIds.some((id) => typeof id !== "string")) return null;
    const oldOverrides = this.facts.prepare(`SELECT id,training_session_id AS sessionId FROM workout_overrides
      WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(oldOverrideIds)) as { id: string; sessionId: string }[];
    if (oldOverrides.length !== new Set(oldOverrideIds).size) return null;
    const previousOverrides = new Map(oldOverrides.map((override) => [override.sessionId, override.id]));
    if (rows.length !== expected.length || expected.some((session) => {
      const row = bySession.get(session.trainingSessionId);
      return !row || row.canonical_workout_id !== session.canonicalWorkoutId || row.workout_start_at !== session.workoutStartAt ||
        (previousOverrides.get(session.trainingSessionId) ?? null) !== (overrideSnapshot.byTrainingSessionId.get(session.trainingSessionId)?.id ?? null);
    })) return null;
    return { dirtyFromAt, parentId: parent.id, rows };
  }

  /**
   * 前缀拷贝（写入）：把决策阶段选中的行按分块短事务拷进新 feature run，并记下父指针。
   * ⛔ 调用点必须在 R06 覆盖守卫**之后**（见 {@link extractFeatures}）。
   */
  private copyFeaturePrefix(
    featureRun: FeatureRun,
    plan: { dirtyFromAt: string; parentId: string; rows: Array<Record<string, SQLInputValue>> }
  ): number {
    const insert = this.database.prepare(`
      INSERT INTO workout_features (
        id, feature_run_id, training_session_id, canonical_workout_id, workout_start_at,
        duration_seconds, distance_km, average_speed_mps, average_heart_rate_bpm,
        heart_rate_sample_count, heart_rate_coverage, route_point_count, route_quality,
        source_confidence, session_type, session_type_source, eligibility_status, quality_score,
        missing_reasons_json, features_json, provenance_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // O07 步骤 4：复用前缀的逐行拷贝同样按分块短事务落地。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (const row of plan.rows) {
      this.gate.yieldIfStale();
      writer.add(() => insert.run(
        deterministicId("workout_feature", { featureRunId: featureRun.id, trainingSessionId: row.training_session_id! }),
        featureRun.id, row.training_session_id!, row.canonical_workout_id!,
        row.workout_start_at!, row.duration_seconds!, row.distance_km!, row.average_speed_mps!,
        row.average_heart_rate_bpm!, row.heart_rate_sample_count!, row.heart_rate_coverage!,
        row.route_point_count!, row.route_quality!, row.source_confidence!,
        row.session_type!, row.session_type_source!, row.eligibility_status!,
        row.quality_score!, row.missing_reasons_json!, row.features_json!, row.provenance_json!, row.computed_at!
      ));
    }
    writer.flush();
    this.database.prepare("UPDATE feature_runs SET parent_feature_run_id = ? WHERE id = ?").run(plan.parentId, featureRun.id);
    return plan.rows.length;
  }

  private loadFeatureRunVectors(featureRunId: string): WorkoutFeatureVector[] {
    const rows = this.database.prepare(`
      SELECT * FROM workout_features WHERE feature_run_id = ? ORDER BY workout_start_at, id
    `).all(featureRunId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => decodeStoredFeature(String(row.features_json), {
      id: String(row.id), featureRunId: String(row.feature_run_id), trainingSessionId: String(row.training_session_id),
      canonicalWorkoutId: String(row.canonical_workout_id), workoutStartAt: String(row.workout_start_at),
      durationSeconds: Number(row.duration_seconds), distanceKm: asNullableNumber(row.distance_km),
      averageSpeedMetersPerSecond: asNullableNumber(row.average_speed_mps),
      averageHeartRateBpm: asNullableNumber(row.average_heart_rate_bpm),
      heartRateSampleCount: Number(row.heart_rate_sample_count), heartRateCoverage: asNullableNumber(row.heart_rate_coverage),
      routePointCount: Number(row.route_point_count), routeQuality: asNullableNumber(row.route_quality),
      sourceConfidence: Number(row.source_confidence), sessionType: String(row.session_type) as SessionType,
      sessionTypeSource: String(row.session_type_source) as WorkoutFeatureVector["sessionTypeSource"],
      eligibilityStatus: String(row.eligibility_status) as EligibilityStatus, qualityScore: Number(row.quality_score),
      missingReasons: parseJson(String(row.missing_reasons_json), []) as MissingReasonCode[],
      signals: parseJson(String(row.features_json), {}) as WorkoutFeatureVector["signals"],
      provenance: parseJson(String(row.provenance_json), {}), computedAt: String(row.computed_at)
    }));
  }

  /** 装配缓存的绑定键：输入绑定（或 dataset 身份）+ 参数形状。换一次 run 就整体清空。 */
  private assemblyBindingKey(): string {
    const capture = this.pendingInputCapture;
    if (capture !== null) return `binding:${capture.binding.inputDigest}`;
    return `dataset:${this.manifestValue("dataset_version") ?? "unknown"}`;
  }

  /**
   * 一次装配、多次复用（O09 步骤 6）：心率/速度区间、30 秒样本、高程聚合。
   *
   * 缓存键含**输入绑定**与参数标识（来源 + 训练窗 + 工作 identity），
   * 容量按条数与**源记录行数**双重设限（`BoundedCache` 的 weight）。
   */
  private workoutAssembly(session: SessionRow): WorkoutAssembly {
    const key = `${this.assemblyBindingKey()}|${session.trainingSessionId}|${session.canonicalWorkoutId}|` +
      `${session.workoutStartAt}|${session.workoutEndAt}|${session.sourceName}`;
    const cached = this.workoutAssemblyCache.get(key);
    if (cached !== undefined) return cached;
    const heartRecords = this.loadRecordSeries(session.sourceName, session.workoutStartAt, session.workoutEndAt, heartRateType);
    const speedRecords = this.loadRecordSeries(session.sourceName, session.workoutStartAt, session.workoutEndAt, runningSpeedType);
    const heartIntervals = weightedRecordIntervals(heartRecords, session.workoutStartAt, session.workoutEndAt, (value) => value);
    const speedIntervals = weightedRecordIntervals(
      speedRecords, session.workoutStartAt, session.workoutEndAt,
      (value, unit) => convertSpeedToMetersPerSecond(value, unit)
    );
    const assembly = new WorkoutAssembly(
      heartIntervals, speedIntervals,
      this.timedMetricSamples(heartIntervals, heartRateType, session),
      this.timedMetricSamples(speedIntervals, runningSpeedType, session),
      () => this.loadElevationGain(session.canonicalWorkoutId),
      heartRecords.length + speedRecords.length
    );
    this.workoutAssemblyCache.set(key, assembly, Math.max(1, assembly.rows));
    return assembly;
  }

  /** 区间 → 负荷/分区口径的定时样本（配速额外做 30 秒中位平滑，样本不足 30 条视为不可用）。 */
  private timedMetricSamples(
    intervals: readonly WeightedRecordInterval[],
    type: string,
    session: SessionRow
  ): TimedMetricSample[] {
    const startMs = Date.parse(session.workoutStartAt);
    const samples = intervals.map((interval) => ({
      value: interval.value,
      durationSeconds: interval.durationSeconds,
      startOffsetSeconds: Math.max(0, (interval.startMs - startMs) / 1000),
      ...(type === runningSpeedType ? { distanceMeters: interval.value * interval.durationSeconds } : {})
    }));
    if (type !== runningSpeedType) return samples;
    const duration = Math.max(0, Math.ceil((Date.parse(session.workoutEndAt) - startMs) / 1000));
    const perSecond = new Array<number | null>(duration).fill(null);
    for (const sample of samples) {
      const pace = sample.value > 0 ? 1000 / sample.value : Number.POSITIVE_INFINITY;
      if (pace < 150 || pace > 900) continue;
      const start = Math.max(0, Math.floor(sample.startOffsetSeconds));
      const end = Math.min(duration, Math.ceil(sample.startOffsetSeconds + sample.durationSeconds));
      for (let second = start; second < end; second += 1) perSecond[second] = sample.value;
    }
    const smoothed: TimedMetricSample[] = [];
    for (let second = 0; second < perSecond.length; second += 1) {
      if (perSecond[second] === null) continue;
      const values = perSecond
        .slice(Math.max(0, second - 29), second + 1)
        .filter((sample): sample is number => finiteNumber(sample));
      const value = median(values);
      if (value === null) continue;
      smoothed.push({ value, durationSeconds: 1, startOffsetSeconds: second, distanceMeters: value });
    }
    return smoothed.length >= 30 ? smoothed : [];
  }

  private metricSamplesForSession(
    session: SessionRow,
    type: string,
    converter: (value: number, unit: string | null) => number
  ): TimedMetricSample[] {
    // 两个热类型走装配缓存；其它类型保持逐次计算（今天没有调用方，不为它扩大口径）。
    if (type === heartRateType) return this.workoutAssembly(session).heartSamples;
    if (type === runningSpeedType) return this.workoutAssembly(session).speedSamples;
    return this.timedMetricSamples(weightedRecordIntervals(
      this.loadRecordSeries(session.sourceName, session.workoutStartAt, session.workoutEndAt, type),
      session.workoutStartAt,
      session.workoutEndAt,
      converter
    ), type, session);
  }

  private loadRestingHeartRateEvidence(evaluatedAt: string): RestingHeartRateEvidence[] {
    return (this.facts.prepare(`
      SELECT value_numeric AS valueBpm, start_at AS observedAt
      FROM health_records
      WHERE type = ? AND value_numeric IS NOT NULL AND start_at < ?
      ORDER BY start_at
    `).all(restingHeartRateType, evaluatedAt) as unknown as RestingHeartRateEvidence[]);
  }

  private loadDateOfBirth(): string | null {
    const row = this.facts.prepare("SELECT attributes_json AS attributesJson FROM profile WHERE id = 1")
      .get() as unknown as { attributesJson: string } | undefined;
    const attributes = parseJson<Record<string, unknown>>(row?.attributesJson, {});
    const value = attributes.HKCharacteristicTypeIdentifierDateOfBirth;
    return typeof value === "string" ? value.slice(0, 10) : null;
  }

  private loadZoneProfileSettings(): TrainingZoneProfileSettings[] {
    const rows = this.facts.prepare(`
      SELECT * FROM training_zone_profile_settings ORDER BY revision
    `).all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      revision: Number(row.revision),
      effectiveFromLocalDate: String(row.effective_from_local_date),
      restingHeartRate: {
        mode: String(row.resting_mode) as "auto" | "manual",
        valueBpm: asNullableNumber(row.resting_value_bpm)
      },
      maximumHeartRate: {
        mode: String(row.maximum_mode) as "auto" | "manual",
        valueBpm: asNullableNumber(row.maximum_value_bpm)
      },
      lactateThresholdPace: {
        mode: String(row.threshold_pace_mode) as "auto" | "manual",
        valueSecondsPerKm: asNullableNumber(row.threshold_pace_seconds_per_km)
      },
      createdAt: String(row.created_at)
    }));
  }

  private buildAndPersistZoneProfiles(
    metricRunId: string,
    features: WorkoutFeatureVector[],
    sessions: Map<string, SessionRow>,
    request: RecomputeRequest
  ): Map<string, DailyZoneProfile> {
    const built = this.buildZoneProfilesRange(metricRunId, features, sessions, request, { startDate: null, previous: null });
    this.persistZoneProfileRows(built.rows);
    return built.profiles;
  }

  /**
   * 分区链的**纯计算**（O09 步骤 3）：只产出领域对象与待写行，不碰数据库。
   *
   * 拆开的理由是复用路径必须"先证明、后写入"：前缀证明要在任何 INSERT 之前完成，
   * 所以计算与落库必须能分开。全量路径（`startDate = null`、`previous = null`）行为与
   * 拆分前逐字节相同。
   *
   * `previous` = `startDate - 1` 那天的分区：链是**逐日继承**的，从半路续算必须带上它，
   * 否则第一个重算日的 `carried_forward` 判定会与从头算不同（这正是"把默认值当历史"的缺陷）。
   */
  private buildZoneProfilesRange(
    metricRunId: string,
    features: WorkoutFeatureVector[],
    sessions: Map<string, SessionRow>,
    request: RecomputeRequest,
    options: { startDate: string | null; previous: DailyZoneProfile | null }
  ): { profiles: Map<string, DailyZoneProfile>; rows: SQLInputValue[][]; evidence: ZoneEvidenceSnapshot } {
    const profiles = new Map<string, DailyZoneProfile>();
    const rows: SQLInputValue[][] = [];
    const evidence = this.zoneEvidenceSnapshot();
    if (features.length === 0) return { profiles, rows, evidence };
    const restingEvidence = this.loadRestingHeartRateEvidence(request.evaluatedAt);
    const maximumEvidence: MaximumHeartRateEvidence[] = [];
    for (const feature of features) {
      if ((feature.heartRateCoverage ?? 0) < 0.7 || feature.sourceConfidence < 0.6) continue;
      const session = sessions.get(feature.trainingSessionId);
      if (!session) continue;
      // O09 步骤 6：心率区间与最大心率证据走**同一份装配**（特征阶段已装配过就不重扫记录）。
      const intervals = this.workoutAssembly(session).heartIntervals;
      const peak = sustainedThirtySecondPeak(intervals, session.workoutStartAt, session.workoutEndAt);
      if (peak !== null) maximumEvidence.push({
        peakBpm: peak,
        observedAt: feature.workoutStartAt,
        coverage: feature.heartRateCoverage ?? 0,
        sourceConfidence: feature.sourceConfidence
      });
    }
    const directVo2 = loadDirectVo2Evidence(this.facts, request.evaluatedAt);
    const labeledPerformance = loadLabeledPerformanceEvidence(this.facts, request.evaluatedAt);
    const performanceEvidence = loadPerformanceVdotEvidence(this.facts, request.evaluatedAt);
    const thresholdEvidence = loadLactateThresholdEvidence(this.facts, request.evaluatedAt);
    // 证据快照：只记"经 active run 读取"的三类；时刻列表就是复用侧要比的那一份。
    evidence.labeled = labeledPerformance.map((item) => item.observedAt).sort();
    evidence.performance = performanceEvidence.map((item) => item.observedAt).sort();
    evidence.threshold = thresholdEvidence.map((item) => item.observedAt).sort();
    const settings = this.loadZoneProfileSettings();
    const firstDate = features
      .map((feature) => localDateAt(feature.workoutStartAt, request.timezoneIdentifier))
      .sort()[0]!;
    const fromDate = options.startDate ?? firstDate;
    // R06 覆盖守卫（分区日链）：日 `D` 的峰值证据窗是 `[D - 365d, D)`（`comparableEvidence`，
    // 见 `PEAK_EVIDENCE_LOOKBACK_MS`）；`localDateStartAt` 给出该日的**精确**起点（含时区），
    // 所以这里比的是真需求。全量路径（`fromDate` = 最早一天）走到这里会显式失败 —— 那正是
    // "复用被拒、日链要从头算"的真实需求，绝不能对着被裁掉的快照照读（峰值会凭空消失）。
    this.assertFactCoverage(
      new Date(Date.parse(localDateStartAt(fromDate, request.timezoneIdentifier)) - PEAK_EVIDENCE_LOOKBACK_MS)
        .toISOString(),
      "records", "zone_profiles");
    const throughDate = localDateAt(request.evaluatedAt, request.timezoneIdentifier);
    const dateOfBirth = this.loadDateOfBirth();
    let previous: DailyZoneProfile | null = options.previous;
    for (let date = fromDate; date <= throughDate; date = addDays(date, 1)) {
      this.gate.yieldIfStale();
      const effectiveAt = localDateStartAt(date, request.timezoneIdentifier);
      const activeSettings = [...settings].reverse().find((item) => item.effectiveFromLocalDate <= date) ?? null;
      const temporary = buildDailyZoneProfile({
        id: deterministicId("daily_zone_profile", { metricRunId, date }),
        localDate: date,
        timezoneIdentifier: request.timezoneIdentifier,
        effectiveAt,
        createdAt: request.evaluatedAt,
        dateOfBirth,
        restingHeartRates: restingEvidence,
        maximumHeartRates: maximumEvidence,
        thresholdPace: null,
        previousProfile: previous,
        settings: activeSettings
      });
      // Race performance already feeds Performance VDOT; it is not a second
      // direct VO2 measurement in the threshold/profile path.
      const eligibleVo2 = directVo2.filter((item) => Date.parse(item.observedAt) < Date.parse(effectiveAt));
      const vo2 = estimateVo2Max(eligibleVo2, effectiveAt);
      const performance = estimatePerformanceVdot(
        vo2,
        performanceEvidence.filter((item) => item.observedAt < effectiveAt),
        effectiveAt
      );
      const threshold = estimateLactateThresholdFromPerformanceVdot(
        performance,
        {
          restingHeartRateBpm: temporary.restingHeartRateBpm,
          observedMaximumHeartRateBpm: temporary.maximumHeartRateBpm
        },
        thresholdEvidence.filter((item) => item.observedAt < effectiveAt),
        effectiveAt
      );
      const thresholdCandidate: ThresholdPaceCandidate | null = threshold.status === "available" && threshold.paceSecondsPerKm !== null
        ? {
            paceSecondsPerKm: threshold.paceSecondsPerKm,
            confidence: threshold.confidence,
            evidenceCount: threshold.evidenceCount,
            evidenceSource: threshold.method === "observed_threshold_v3" ? "observed" : "inferred",
            dataThroughAt: threshold.latestEvidenceAt
          }
        : null;
      const profile = buildDailyZoneProfile({
        id: temporary.id,
        localDate: date,
        timezoneIdentifier: request.timezoneIdentifier,
        effectiveAt,
        createdAt: request.evaluatedAt,
        dateOfBirth,
        restingHeartRates: restingEvidence,
        maximumHeartRates: maximumEvidence,
        thresholdPace: thresholdCandidate,
        previousProfile: previous,
        settings: activeSettings
      });
      rows.push([
        profile.id, metricRunId, profile.localDate, profile.timezoneIdentifier,
        profile.effectiveAt, profile.dataThroughAt, profile.restingHeartRateBpm,
        profile.maximumHeartRateBpm, profile.lactateThresholdPaceSecondsPerKm,
        profile.heartRateSource, profile.paceSource, profile.heartRateConfidence,
        profile.paceConfidence, profile.status, JSON.stringify(profile.heartRateBands),
        JSON.stringify(profile.paceBands), JSON.stringify(profile.evidence), profile.createdAt
      ]);
      profiles.set(date, profile);
      previous = profile;
    }
    return { profiles, rows, evidence };
  }

  /**
   * 当前（本 run 视角）的证据来源：当时生效的 active run。首次全量 run 时**可能为空** ——
   * 那正是"证据从无到有"的转折点，必须记下来，否则下一次会照抄一份没有证据的前缀。
   */
  private zoneEvidenceSnapshot(): ZoneEvidenceSnapshot {
    const active = this.database.prepare(
      "SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1"
    ).get() as { id: string } | undefined;
    return { sourceRunId: active?.id ?? null, labeled: [], performance: [], threshold: [] };
  }

  /**
   * 证据链一致性判据（O09 步骤 7）。返回 `null` = 通过，否则返回拒绝原因。
   *
   * - `sourceRunId === null`：父 run 计算时**没有证据源**（该库的首次全量）⇒ 它的前缀是在
   *   空证据下算出来的，照抄会与离线从头计算不一致 ⇒ 拒绝。
   * - 三类经 active run 读取的证据（labeled / performance / threshold）：`observedAt < prefixAt`
   *   的时刻集合必须逐条相同。这一条同时覆盖两种情况：新证据进入前缀窗口，以及
   *   **窗口滑动**把旧证据挤出去（performance 56 天、threshold 365 天都相对 `asOf`）。
   *   比 `prefixAt` 新的证据不可能影响前缀日（前缀日的 `effectiveAt <= prefixAt`）。
   * - RHR / VO2 直读 `health_records`，任何 `asOf` 都能重算 ⇒ 两个 `asOf` 各现算一次再比。
   */
  private checkZoneEvidenceParity(input: {
    snapshot: ZoneEvidenceSnapshot;
    parentEvaluatedAt: string;
    currentAsOf: string;
    zoneStart: string;
    timezone: string;
  }): string | null {
    if (input.snapshot.sourceRunId === null) return "evidence_source_missing";
    const prefixAt = localDateStartAt(input.zoneStart, input.timezone);
    const restricted = (list: readonly string[]): string[] =>
      list.filter((at) => Number.isFinite(Date.parse(at)) && at < prefixAt).sort();
    const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
      const a = restricted(left), b = restricted(right);
      return a.length === b.length && a.every((value, index) => value === b[index]);
    };
    const labeled = loadLabeledPerformanceEvidence(this.facts, input.currentAsOf).map((item) => item.observedAt);
    if (!sameSet(input.snapshot.labeled, labeled)) return "evidence_labeled_changed";
    const performance = loadPerformanceVdotEvidence(this.facts, input.currentAsOf).map((item) => item.observedAt);
    if (!sameSet(input.snapshot.performance, performance)) return "evidence_performance_changed";
    const threshold = loadLactateThresholdEvidence(this.facts, input.currentAsOf).map((item) => item.observedAt);
    if (!sameSet(input.snapshot.threshold, threshold)) return "evidence_threshold_changed";
    const restingNow = this.recomputableEvidenceTimestamps(input.currentAsOf).resting;
    const restingThen = this.recomputableEvidenceTimestamps(input.parentEvaluatedAt).resting;
    if (!sameSet(restingThen, restingNow)) return "evidence_resting_changed";
    const vo2Now = this.recomputableEvidenceTimestamps(input.currentAsOf).directVo2;
    const vo2Then = this.recomputableEvidenceTimestamps(input.parentEvaluatedAt).directVo2;
    if (!sameSet(vo2Then, vo2Now)) return "evidence_direct_vo2_changed";
    return null;
  }

  /** RHR / VO2 两类证据直读 `health_records`，任何 `asOf` 都能重算 ⇒ 复用侧两边现算比较。 */
  private recomputableEvidenceTimestamps(asOf: string): { resting: string[]; directVo2: string[] } {
    const resting = this.facts.prepare(`
      SELECT start_at AS observedAt FROM health_records
      WHERE type = ? AND value_numeric IS NOT NULL AND start_at < ? ORDER BY start_at
    `).all(restingHeartRateType, asOf) as unknown as Array<{ observedAt: string }>;
    const vo2 = loadDirectVo2Evidence(this.facts, asOf);
    return {
      resting: resting.map((row) => row.observedAt),
      directVo2: vo2.map((item) => item.observedAt).sort()
    };
  }

  /** 分区行的落库（O07 步骤 4：分块短事务；让路点在提交之后）。 */
  private persistZoneProfileRows(rows: readonly SQLInputValue[][]): void {
    if (rows.length === 0) return;
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO daily_zone_profiles (
        id, training_metric_run_id, local_date, timezone_identifier, effective_at,
        data_through_at, resting_heart_rate_bpm, maximum_heart_rate_bpm,
        threshold_pace_seconds_per_km, heart_rate_source, pace_source,
        heart_rate_confidence, pace_confidence, profile_status,
        heart_rate_bands_json, pace_bands_json, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const writer = new ChunkedWriter(this.database, this.gate);
    for (const row of rows) writer.add(() => insert.run(...row));
    writer.flush();
  }

  // ===================== O09（WP-32）：分域边界、checkpoint 与安全前缀复用 =====================

  /**
   * 各计算域的排他边界（O09 步骤 1）。
   *
   * `domains` 存在时逐域取用：`features` 只服务特征前缀与能力重放，`fitness` 服务
   * 负荷／分区，`readiness` 服务恢复证据。**不**把所有健康变化一律扩大成 Fitness 全历史重算，
   * 也**不**在 `domains` 存在但某域为 null 时回落单一边界 —— 那会把"该域不可增量"
   * 读成"可以增量"。老 payload（无 `domains`）才回落 `dirtyFromAt`。
   *
   * 非法时刻 ⇒ 该域为 null（全算）：方向永远是"宁可全算，不可错复用"。
   */
  private domainBoundaries(request: RecomputeRequest): DomainBoundaries {
    const plan = request.incrementalPlan;
    if (!plan || plan.mode !== "partial") return { features: null, fitness: null, readiness: null, source: "none" };
    const legacy = this.normalizeBoundary(plan.dirtyFromAt);
    if (!plan.domains) return { features: legacy, fitness: legacy, readiness: legacy, source: "legacy" };
    return {
      features: this.normalizeBoundary(plan.domains.features),
      fitness: this.normalizeBoundary(plan.domains.fitness),
      readiness: this.normalizeBoundary(plan.domains.readiness),
      source: "domains"
    };
  }

  private normalizeBoundary(value: unknown): string | null {
    if (typeof value !== "string") return null;
    try { return normalizeInstant(value, "domainBoundary"); } catch { return null; }
  }

  /** override 快照摘要：与输入读取器/发布判据**同源**（有序 id 集合）。 */
  private overrideSnapshotDigest(overrideSnapshot: OverrideSnapshot): string {
    return overrideSnapshot.ids.join("\u0001");
  }

  /** 分区设置摘要：设置一改，历史分区与负荷不再可复用。 */
  private zoneSettingsDigest(): string {
    const rows = this.facts.prepare(
      "SELECT id, revision FROM training_zone_profile_settings ORDER BY effective_from_local_date, id"
    ).all() as unknown as Array<{ id: string; revision: number }>;
    return rows.map((row) => `${row.id}:${row.revision}`).join("\u0001");
  }

  /**
   * **输入身份摘要**（含实际 raw／dependency 代次）——谱系与审计用。
   *
   * 🔴 R05（2026-10-16 复查）：它**不再是复用判据**。含代次的摘要会让"连续两次真实增量"
   * 永远匹配不上（每批导入都推进代次），安全前缀复用被恒定拒绝——一条心率更正就能重算
   * 7 次训练、46 天分区。复用判据见 {@link metricPrefixCompatibilityDigest}。
   *
   * 🔴 刻意**不含** `runId` / `jobId` / `cutoffAt` / `datasetVersion`：前三项每次 run 都变，
   * 含进去等于永不匹配；`datasetVersion` 每批导入都变（`dataset_delta_<hash>`），
   * 而"前缀事实有没有变"由**边界**声明、由前缀证明与摘要比对**证伪**，
   * 不由"整批的版本号有没有动"回答 —— 拿版本号当复用条件会把复用率压到恒零。
   *
   * 直连车道用捕获到的绑定（scope/代次/override/config 摘要）；CLI 车道没有捕获，
   * 用同一形状的本地摘要（scope=`cli-recompute`），两条车道的摘要形状不同 ⇒ 天然不互相复用。
   */
  private metricInputBindingDigest(overrideSnapshot: OverrideSnapshot): string {
    const capture = this.pendingInputCapture;
    // ⛔ 分隔符**不能是 `\u0000`**：node:sqlite 按 C 字符串传参，NUL 之后的字节不入库，
    // 摘要会被静默截断成第一段（实测就是 `"cli-recompute"`）——判据随即退化成
    // "scope 相同就复用"，而那正是"输入变了却仍然复用"的形态。
    if (capture !== null) {
      const binding = capture.binding;
      return [
        binding.scope, String(binding.capturedRawGeneration), String(binding.capturedDependencyGeneration),
        binding.timezoneIdentifier, binding.overrideDigest, binding.configDigest
      ].join("\u0001");
    }
    return [
      "cli-recompute", "-", "-",
      this.manifestValue("timezone_identifier") ?? DATABASE_TIMEZONE,
      this.overrideSnapshotDigest(overrideSnapshot), this.zoneSettingsDigest()
    ].join("\u0001");
  }

  /**
   * **前缀兼容摘要**（R05）：只回答"父 checkpoint 与本次运行能不能拼前缀"，**不含代次**。
   *
   * 组成 = scope + 时区 + override 摘要 + 配置摘要（直连）；CLI 用同形状的本地摘要。
   * 算法／checkpoint 版本与 config hash 另在 `resolveMetricReuse` 里逐列比对（本摘要
   * 是防漂移的第二道，不替代那些逐项校验）。
   *
   * "父发布到当前之间有没有**未处理影响**"**不在这个摘要里回答** —— 那是覆盖计划的
   * 职责（`capture.coverageBase` + 从基线起算的执行计划）：两件事各自有各自的证据，
   * 混进同一个摘要正是 R05 病灶的形态。
   */
  private metricPrefixCompatibilityDigest(overrideSnapshot: OverrideSnapshot): string {
    const capture = this.pendingInputCapture;
    if (capture !== null) {
      const binding = capture.binding;
      return [
        binding.scope, binding.timezoneIdentifier, binding.overrideDigest, binding.configDigest
      ].join("\u0001");
    }
    return [
      "cli-recompute",
      this.manifestValue("timezone_identifier") ?? DATABASE_TIMEZONE,
      this.overrideSnapshotDigest(overrideSnapshot), this.zoneSettingsDigest()
    ].join("\u0001");
  }

  /**
   * 分区/负荷/日级三个域共同消费的配置。**同一份对象**既用于建 run、也用于复用比对 ——
   * 两处各写一份必然漂移（漂移的后果是"配置变了还复用"）。
   */
  private metricRunConfig(overrideSnapshotIds: string[]): Record<string, unknown> {
    return {
      dailyMetrics: defaultDailyMetricConfig,
      zoneVersion: TRAINING_ZONE_CONFIG_VERSION,
      heartRateReserveBoundaries: [0.6, 0.7, 0.8, 0.9],
      paceThresholdMultipliers: [1.15, 1.06, 0.97, 0.9],
      overrideSnapshotIds
    };
  }

  private metricRunConfigHash(overrideSnapshotIds: string[]): string {
    return configHash({ version: TRAINING_LOAD_CONFIG_VERSION, config: this.metricRunConfig(overrideSnapshotIds) });
  }

  /** 库里的一行分区 → 领域对象（复用链尾、证明比对共用）。 */
  private dailyZoneProfileFromRow(row: Record<string, unknown>): DailyZoneProfile {
    return {
      id: String(row.id), localDate: String(row.local_date), timezoneIdentifier: String(row.timezone_identifier),
      effectiveAt: String(row.effective_at), dataThroughAt: row.data_through_at === null ? null : String(row.data_through_at),
      restingHeartRateBpm: Number(row.resting_heart_rate_bpm), maximumHeartRateBpm: Number(row.maximum_heart_rate_bpm),
      lactateThresholdPaceSecondsPerKm: asNullableNumber(row.threshold_pace_seconds_per_km),
      heartRateSource: String(row.heart_rate_source) as DailyZoneProfile["heartRateSource"],
      paceSource: String(row.pace_source) as DailyZoneProfile["paceSource"],
      heartRateConfidence: Number(row.heart_rate_confidence), paceConfidence: Number(row.pace_confidence),
      status: String(row.profile_status) as DailyZoneProfile["status"],
      heartRateBands: parseJson(String(row.heart_rate_bands_json), []),
      paceBands: parseJson(String(row.pace_bands_json), []),
      evidence: parseJson(String(row.evidence_json), { restingHeartRateDays: 0, maximumHeartRateWorkouts: 0, thresholdEvidenceCount: 0 }),
      createdAt: String(row.created_at)
    };
  }

  private zoneChainState(profile: DailyZoneProfile | null): ZoneChainState | null {
    if (profile === null) return null;
    return {
      localDate: profile.localDate, effectiveAt: profile.effectiveAt, dataThroughAt: profile.dataThroughAt,
      restingHeartRateBpm: profile.restingHeartRateBpm, maximumHeartRateBpm: profile.maximumHeartRateBpm,
      lactateThresholdPaceSecondsPerKm: profile.lactateThresholdPaceSecondsPerKm,
      heartRateSource: profile.heartRateSource, paceSource: profile.paceSource,
      heartRateConfidence: profile.heartRateConfidence, paceConfidence: profile.paceConfidence,
      status: profile.status, heartRateBandsJson: JSON.stringify(profile.heartRateBands),
      paceBandsJson: JSON.stringify(profile.paceBands), evidenceJson: JSON.stringify(profile.evidence)
    };
  }

  private zoneChainMatchesProfile(state: ZoneChainState, profile: DailyZoneProfile): boolean {
    return state.localDate === profile.localDate && state.effectiveAt === profile.effectiveAt &&
      state.dataThroughAt === profile.dataThroughAt &&
      state.restingHeartRateBpm === profile.restingHeartRateBpm &&
      state.maximumHeartRateBpm === profile.maximumHeartRateBpm &&
      state.lactateThresholdPaceSecondsPerKm === profile.lactateThresholdPaceSecondsPerKm &&
      state.heartRateSource === profile.heartRateSource && state.paceSource === profile.paceSource &&
      state.heartRateConfidence === profile.heartRateConfidence && state.paceConfidence === profile.paceConfidence &&
      state.status === profile.status && state.heartRateBandsJson === JSON.stringify(profile.heartRateBands) &&
      state.paceBandsJson === JSON.stringify(profile.paceBands) &&
      state.evidenceJson === JSON.stringify(profile.evidence);
  }

  /**
   * checkpoint 状态解析 + 形状校验（O09 步骤 2：缺失即不复用）。
   *
   * `state_hash` 是写入侧自己算的，所以它证明的是"这份 JSON 没被改动"，不是"它算得对"。
   * 形状校验负责另一半：**默认零值不是有效历史** —— 缺项、NaN、队列超限、乱序都判不可信。
   */
  private parseMetricCheckpointState(stateJson: string, stateHash: string): TrainingMetricCheckpointState | null {
    const state = parseJson<TrainingMetricCheckpointState | null>(stateJson, null);
    if (state === null || typeof state !== "object") return null;
    if (state.version !== TRAINING_METRIC_CHECKPOINT_VERSION) return null;
    if (configHash(state) !== stateHash) return null;
    const evidence = state.evidence;
    // `sourceRunId === null` 是**合法**形状（当时的库还没有 active run）；它由证据一致性判据
    // 判成"不可复用"，而不是被当成"状态损坏" —— 两种原因的处置相同，但诊断不能混为一谈。
    if (evidence === null || typeof evidence !== "object" ||
      (evidence.sourceRunId !== null && typeof evidence.sourceRunId !== "string")) return null;
    for (const list of [evidence.labeled, evidence.performance, evidence.threshold]) {
      if (!Array.isArray(list) || list.length > MAX_EVIDENCE_TIMESTAMPS) return null;
      if (list.some((at) => typeof at !== "string" || !Number.isFinite(Date.parse(at)))) return null;
    }
    if (state.distanceQueueComplete !== true) return null;
    if (!Array.isArray(state.distanceQueue) || state.distanceQueue.length > MAX_DISTANCE_QUEUE_ENTRIES) return null;
    for (const [index, entry] of state.distanceQueue.entries()) {
      if (entry === null || typeof entry !== "object") return null;
      if (typeof entry.observedAt !== "string" || !Number.isFinite(Date.parse(entry.observedAt))) return null;
      if (!Number.isFinite(entry.distanceMeters) || entry.distanceMeters <= 0) return null;
      if (index > 0 && state.distanceQueue[index - 1]!.observedAt > entry.observedAt) return null;
    }
    if (state.daily !== null) {
      const daily = state.daily;
      if (typeof daily.localDate !== "string" || !Number.isFinite(daily.acuteEwma) ||
        !Number.isFinite(daily.chronicEwma) || !Number.isFinite(daily.workoutCount) ||
        !Number.isFinite(daily.historyDays)) return null;
    }
    // v2 日级证据快照：形状不对就判"状态损坏"（不复用），**不允许**"缺字段当全一致"。
    if (typeof state.dailyEvidenceFrom !== "string" ||
      (state.dailyEvidenceFrom !== "" && !Number.isFinite(Date.parse(state.dailyEvidenceFrom)))) return null;
    if (!Array.isArray(state.dailyEvidenceDays) ||
      state.dailyEvidenceDays.length > MAX_DAILY_EVIDENCE_CHUNKS) return null;
    const evidenceAlphabet = new RegExp(`^[${DAILY_EVIDENCE_ALPHABET}]+$`);
    if (state.dailyEvidenceDays.some((chunk) =>
      typeof chunk !== "string" || chunk.length === 0 ||
      chunk.length > DAILY_EVIDENCE_CHUNK_DAYS || !evidenceAlphabet.test(chunk))) return null;
    if (state.dailyEvidenceDays.length > 0 && state.dailyEvidenceFrom === "") return null;
    if (typeof state.dailyRowsDigest !== "string" || !/^[0-9a-f]{64}$/.test(state.dailyRowsDigest)) return null;
    if (state.zonePrevious !== null) {
      const zone = state.zonePrevious;
      if (typeof zone.localDate !== "string" || typeof zone.effectiveAt !== "string" ||
        !Number.isFinite(zone.restingHeartRateBpm) || !Number.isFinite(zone.maximumHeartRateBpm) ||
        typeof zone.heartRateBandsJson !== "string" || typeof zone.paceBandsJson !== "string" ||
        typeof zone.evidenceJson !== "string") return null;
    }
    return state;
  }

  /**
   * 复用计划（只读）：解析边界、取父 run 的 checkpoint、逐项校验。
   *
   * 任何一项不满足 ⇒ **不复用**（`attempted: true` 表示"试过了、被拒"，与"没有增量计划"
   * 区分开；两者都不假装复用成功）。
   */
  private resolveMetricReuse(input: {
    request: RecomputeRequest;
    metricRunId: string;
    features: WorkoutFeatureVector[];
    overrideSnapshot: OverrideSnapshot;
  }): { ok: true; plan: MetricReusePlan } | { ok: false; attempted: boolean; reason: string } {
    const boundaries = this.domainBoundaries(input.request);
    if (boundaries.fitness === null) {
      return { ok: false, attempted: boundaries.source !== "none", reason: `no_fitness_boundary:${boundaries.source}` };
    }
    const timezone = input.request.timezoneIdentifier;
    const overrideDigest = this.overrideSnapshotDigest(input.overrideSnapshot);
    const configHashExpected = this.metricRunConfigHash(input.overrideSnapshot.ids);
    const row = this.database.prepare(`
      SELECT metric.id AS metricRunId, metric.evaluated_at AS evaluatedAt, metric.config_hash AS configHash,
             metric.timezone_identifier AS checkpointTimezone, metric.model_run_id AS modelRunId,
             model.feature_run_id AS featureRunId,
             checkpoint.checkpoint_version AS checkpointVersion,
             checkpoint.load_algorithm_version AS loadVersion,
             checkpoint.zone_algorithm_version AS zoneVersion,
             checkpoint.daily_algorithm_version AS dailyVersion,
             checkpoint.config_hash AS checkpointConfigHash,
             checkpoint.zone_settings_digest AS zoneSettingsDigest,
             checkpoint.override_digest AS overrideDigest,
             checkpoint.prefix_compat_digest AS prefixCompatDigest,
             checkpoint.through_local_date AS throughLocalDate,
             checkpoint.state_json AS stateJson, checkpoint.state_hash AS stateHash
      FROM active_model_run active
      JOIN model_runs model ON model.id = active.model_run_id AND model.status = 'succeeded'
      JOIN training_metric_runs metric ON metric.model_run_id = model.id AND metric.status = 'succeeded'
      JOIN training_metric_checkpoints checkpoint ON checkpoint.training_metric_run_id = metric.id
      WHERE active.singleton = 1
      ORDER BY metric.created_at DESC, metric.id DESC LIMIT 1
    `).get() as unknown as Record<string, unknown> | undefined;
    if (!row) return { ok: false, attempted: true, reason: "no_parent_checkpoint" };
    if (String(row.checkpointVersion) !== TRAINING_METRIC_CHECKPOINT_VERSION) return { ok: false, attempted: true, reason: "checkpoint_version" };
    if (String(row.loadVersion) !== TRAINING_LOAD_CONFIG_VERSION) return { ok: false, attempted: true, reason: "load_algorithm_version" };
    if (String(row.zoneVersion) !== TRAINING_ZONE_CONFIG_VERSION) return { ok: false, attempted: true, reason: "zone_algorithm_version" };
    if (String(row.dailyVersion) !== DAILY_METRIC_ALGORITHM_VERSION) return { ok: false, attempted: true, reason: "daily_algorithm_version" };
    if (String(row.configHash) !== configHashExpected || String(row.checkpointConfigHash) !== configHashExpected) {
      return { ok: false, attempted: true, reason: "config_hash" };
    }
    if (String(row.zoneSettingsDigest) !== this.zoneSettingsDigest()) return { ok: false, attempted: true, reason: "zone_settings" };
    if (String(row.overrideDigest) !== overrideDigest) return { ok: false, attempted: true, reason: "override_snapshot" };
    if (String(row.checkpointTimezone) !== timezone) return { ok: false, attempted: true, reason: "timezone" };
    // 🔴 R05（2026-10-16）：复用判据 = **前缀兼容摘要**（不含代次）+ **覆盖基线存在**。
    //
    // 旧实现比的是含代次的 `input_binding_digest` ⇒ 每批导入都推进代次 ⇒ 连续两次真实
    // 增量永远以 `input_binding` 拒绝复用（一条心率更正重算 7 次训练、46 天分区）。
    // 现在拆成两件事，各自有各自的证据：
    //   · 摘要回答"算法/配置/时区/override 这一层能不能拼"；
    //   · 覆盖基线（旧发布的输入绑定）回答"父发布到当前之间有没有未处理影响" ——
    //     没有它（v39 前的老发布 / CLI 直接发布）就拒绝复用：不允许把无法证明的前缀当安全。
    // 旧 checkpoint 缺新摘要（v44 之前的行）⇒ 拒绝，"缺少必要证明时拒绝复用"。
    const prefixCompatDigest = String(row.prefixCompatDigest ?? "");
    if (prefixCompatDigest.length === 0) {
      return { ok: false, attempted: true, reason: "prefix_compat_missing" };
    }
    if (prefixCompatDigest !== this.metricPrefixCompatibilityDigest(input.overrideSnapshot)) {
      return { ok: false, attempted: true, reason: "prefix_compat" };
    }
    if (this.pendingInputCapture !== null && this.pendingInputCapture.coverageBase === null) {
      return { ok: false, attempted: true, reason: "coverage_base_missing" };
    }
    const state = this.parseMetricCheckpointState(String(row.stateJson), String(row.stateHash));
    if (state === null) return { ok: false, attempted: true, reason: "checkpoint_state" };
    const zoneStart = localDateAt(boundaries.fitness, timezone);
    // 证据链一致性（O09 步骤 2/7）：前缀日只用 `observedAt < prefixAt` 的证据，
    // 所以只比这一段。三类经 active run 读取的证据按记录的时刻集合比；RHR/VO2 两边现算。
    const evidenceVerdict = this.checkZoneEvidenceParity({
      snapshot: state.evidence, parentEvaluatedAt: String(row.evaluatedAt),
      currentAsOf: input.request.evaluatedAt, zoneStart, timezone
    });
    if (evidenceVerdict !== null) return { ok: false, attempted: true, reason: evidenceVerdict };

    const parentMetricRunId = String(row.metricRunId);
    const parentModelRunId = String(row.modelRunId);
    const parentEvaluatedAt = String(row.evaluatedAt);
    if (!Number.isFinite(Date.parse(parentEvaluatedAt))) return { ok: false, attempted: true, reason: "parent_evaluated_at" };
    const parentThroughDate = localDateAt(parentEvaluatedAt, timezone);
    if (String(row.throughLocalDate) !== parentThroughDate) return { ok: false, attempted: true, reason: "checkpoint_through" };
    const first = this.database.prepare(
      "SELECT MIN(local_date) AS firstDate, COUNT(*) AS rowCount FROM daily_zone_profiles WHERE training_metric_run_id = ?"
    ).get(parentMetricRunId) as unknown as { firstDate: string | null; rowCount: number };
    const firstDate = first.firstDate ?? localDateAt(
      input.features[0]?.workoutStartAt ?? input.request.evaluatedAt, timezone);
    if (zoneStart < firstDate) return { ok: false, attempted: true, reason: "boundary_before_parent" };
    if (zoneStart > addDays(parentThroughDate, 1)) return { ok: false, attempted: true, reason: "boundary_gap" };
    // 前缀必须**稠密**：拷贝 [firstDate, zoneStart) 与重算 [zoneStart, throughDate) 拼起来
    // 覆盖全区间，中间不能有洞（洞在发布层面看起来像"那天没有数据"，不是像"没算"）。
    const prefixDays = Math.max(0, daysBetween(firstDate, zoneStart));
    if (Number(first.rowCount) !== daysBetween(firstDate, parentThroughDate) + 1) {
      return { ok: false, attempted: true, reason: "parent_profiles_not_dense" };
    }
    // 特征前缀：新 run 的 feature run 的父级必须**正是**父 model run 的 feature run。
    // 没有这条，负荷前缀就可能与"这批特征"不是同一代事实 —— 那是"混代复用"。
    const parentFeatureRunId = String((this.database.prepare(
      "SELECT feature_run_id AS id FROM model_runs WHERE id = ?"
    ).get(parentModelRunId) as { id: string }).id);
    const currentFeature = this.database.prepare(`
      SELECT feature.parent_feature_run_id AS parent
      FROM training_metric_runs metric
      JOIN model_runs model ON model.id = metric.model_run_id
      JOIN feature_runs feature ON feature.id = model.feature_run_id
      WHERE metric.id = ?
    `).get(input.metricRunId) as { parent: string | null } | undefined;
    if (!currentFeature || currentFeature.parent === null || currentFeature.parent !== parentFeatureRunId) {
      return { ok: false, attempted: true, reason: "feature_prefix" };
    }
    // 逐表前缀完整性：没有对应 feature / 分区行的父行会在集合拷贝里**静默丢行**。
    const missing = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM workout_training_loads old
          WHERE old.training_metric_run_id = ? AND old.local_date < ?
            AND NOT EXISTS (SELECT 1 FROM workout_features f JOIN model_runs m ON m.feature_run_id = f.feature_run_id
              WHERE m.id = ? AND f.training_session_id = old.training_session_id)) AS loadsMissingFeature,
        (SELECT COUNT(*) FROM workout_zone_summaries old
          JOIN workout_training_loads load ON load.training_metric_run_id = old.training_metric_run_id
            AND load.training_session_id = old.training_session_id
          WHERE old.training_metric_run_id = ? AND load.local_date < ?
            AND NOT EXISTS (SELECT 1 FROM workout_features f JOIN model_runs m ON m.feature_run_id = f.feature_run_id
              WHERE m.id = ? AND f.training_session_id = old.training_session_id)) AS summariesMissingParent
    `).get(parentMetricRunId, zoneStart, parentModelRunId, parentMetricRunId, zoneStart, parentModelRunId) as unknown as { loadsMissingFeature: number; summariesMissingParent: number };
    if (Number(missing.loadsMissingFeature) !== 0 || Number(missing.summariesMissingParent) !== 0) {
      return { ok: false, attempted: true, reason: "prefix_rows_incomplete" };
    }
    // 复用链尾：`zoneStart-1` 那天的那一行就是下一段链的 `previous`。
    const previousRow = prefixDays === 0 ? undefined : this.database.prepare(
      "SELECT * FROM daily_zone_profiles WHERE training_metric_run_id = ? AND local_date = ?"
    ).get(parentMetricRunId, addDays(zoneStart, -1)) as unknown as Record<string, unknown> | undefined;
    if (prefixDays > 0 && !previousRow) return { ok: false, attempted: true, reason: "missing_previous_profile" };
    // 状态与**库中事实**必须对齐：链尾 = 父 run 最后一天那一行；日级种子 = 父 run 最后一天的 EWMA。
    const parentLastProfileRow = this.database.prepare(
      "SELECT * FROM daily_zone_profiles WHERE training_metric_run_id = ? AND local_date = ?"
    ).get(parentMetricRunId, parentThroughDate) as unknown as Record<string, unknown> | undefined;
    if (parentLastProfileRow === undefined) return { ok: false, attempted: true, reason: "missing_parent_tail_profile" };
    const parentTailProfile = this.dailyZoneProfileFromRow(parentLastProfileRow);
    if (state.zonePrevious === null || !this.zoneChainMatchesProfile(state.zonePrevious, parentTailProfile)) {
      return { ok: false, attempted: true, reason: "zone_chain_mismatch" };
    }
    const parentTailDaily = this.database.prepare(`SELECT local_date AS localDate, acute_ewma AS acute, chronic_ewma AS chronic,
      load_workout_count AS workoutCount, history_days AS historyDays FROM daily_training_metrics
      WHERE training_metric_run_id = ? AND local_date = ?`).get(parentMetricRunId, parentThroughDate) as unknown as
      { localDate: string; acute: number; chronic: number; workoutCount: number; historyDays: number } | undefined;
    if (state.daily === null || parentTailDaily === undefined ||
      state.daily.localDate !== parentTailDaily.localDate ||
      state.daily.acuteEwma !== Number(parentTailDaily.acute) ||
      state.daily.chronicEwma !== Number(parentTailDaily.chronic) ||
      state.daily.workoutCount !== Number(parentTailDaily.workoutCount) ||
      state.daily.historyDays !== Number(parentTailDaily.historyDays)) {
      return { ok: false, attempted: true, reason: "daily_seed_mismatch" };
    }
    // 距离队列的来源证明：按父 run 的同一套判据重算期望队列并**逐条比对**（含顺序）。
    // 这证明的是"队列就是这批特征事实推出来的那一条"，而不是"某个数字看着合理"。
    const expectedQueue = this.deriveDistanceQueue(
      (this.database.prepare("SELECT feature_run_id AS id FROM model_runs WHERE id = ?").get(parentModelRunId) as { id: string }).id,
      input.overrideSnapshot
    );
    if (expectedQueue.length !== state.distanceQueue.length ||
      expectedQueue.some((entry, index) => entry.observedAt !== state.distanceQueue[index]!.observedAt ||
        Math.abs(entry.distanceMeters - state.distanceQueue[index]!.distanceMeters) > 1e-6)) {
      return { ok: false, attempted: true, reason: "distance_queue_provenance" };
    }
    return {
      ok: true,
      plan: {
        parentMetricRunId, parentModelRunId, parentEvaluatedAt, parentThroughDate, firstDate, zoneStart,
        previousProfile: previousRow === undefined ? null : this.dailyZoneProfileFromRow(previousRow),
        distanceQueue: state.distanceQueue.map((entry) => ({ ...entry })),
        state
      }
    };
  }

  /**
   * 负荷／分区／日级三域入口（O09 步骤 1/3/4/7）。
   *
   * 复用路径**先证明、后写入**：前缀证明在写任何一行之前完成；证明失败 ⇒ 一行都没有写、
   * 退回全量重算并把 `reused` 记 0。绝不让"证明失败"看起来像"复用成功"。
   */
  private replayTrainingMetrics(
    jobId: string,
    metricRunId: string,
    features: WorkoutFeatureVector[],
    request: RecomputeRequest,
    overrideSnapshot: OverrideSnapshot
  ): void {
    // R06 覆盖守卫（证据阶段，先于任何证据读）：`resolveMetricReuse` →
    // `checkZoneEvidenceParity` 与分区阶段都按 `evaluatedAt` 读证据链 —— 乳酸阈值会话取
    // `evaluatedAt - 365d` 窗，每场会话的最大心率证据再回看 180 天 ⇒ 明细下沿 =
    // `evaluatedAt - 545d`（`RECORDS_MAX_LOOKBACK_MS` 的完整推导见 `analysis-fact-view.ts`）。
    // 这一条同时是"裁剪边界与执行计划同源"的结构断言：边界若被改回按登记计划算（偏晚），
    // 它会立刻转红，而不是让证据链悄悄少几个会话。
    this.assertFactCoverage(
      new Date(Date.parse(request.evaluatedAt) - RECORDS_MAX_LOOKBACK_MS).toISOString(),
      "records", "metric_evidence");
    const sessions = new Map(
      this.loadSessions(request.evaluatedAt).map((session) => [session.trainingSessionId, session])
    );
    const resolved = this.resolveMetricReuse({ request, metricRunId, features, overrideSnapshot });
    if (resolved.ok) {
      const reused = this.replayTrainingMetricsReused(jobId, metricRunId, features, sessions, request, overrideSnapshot, resolved.plan);
      if (reused.ok) {
        this.pendingReuseCounters = reused.counters;
        return;
      }
      const full = this.replayTrainingMetricsFull(jobId, metricRunId, features, sessions, request, overrideSnapshot);
      this.pendingReuseCounters = {
        attempted: true, proof: "rejected", rejectionReason: reused.reason,
        loads: { reused: 0, recomputed: full.loads },
        zoneProfiles: { reused: 0, recomputed: full.zoneProfiles },
        dailyMetrics: { reused: 0, recomputed: full.dailyMetrics },
        checkpointWritten: full.checkpointWritten, reuseFromLocalDate: null, reuseThroughLocalDate: null
      };
      return;
    }
    const full = this.replayTrainingMetricsFull(jobId, metricRunId, features, sessions, request, overrideSnapshot);
    this.pendingReuseCounters = {
      attempted: resolved.attempted, proof: resolved.attempted ? "rejected" : "not_attempted",
      rejectionReason: resolved.reason,
      loads: { reused: 0, recomputed: full.loads },
      zoneProfiles: { reused: 0, recomputed: full.zoneProfiles },
      dailyMetrics: { reused: 0, recomputed: full.dailyMetrics },
      checkpointWritten: full.checkpointWritten, reuseFromLocalDate: null, reuseThroughLocalDate: null
    };
  }

  /**
   * 全量路径（O09 之前的行为）：从第一个 feature／最早负荷日算到 `evaluatedAt`。
   * 复用被拒或没有增量计划时走它；它同样写 checkpoint —— 链的**起点**必须是一条全量 run，
   * 否则第二次分析永远没有可复用的来源。
   */
  private replayTrainingMetricsFull(
    jobId: string,
    metricRunId: string,
    features: WorkoutFeatureVector[],
    sessions: Map<string, SessionRow>,
    request: RecomputeRequest,
    overrideSnapshot: OverrideSnapshot
  ): { loads: number; zoneProfiles: number; dailyMetrics: number; checkpointWritten: boolean } {
    const throughDate = localDateAt(request.evaluatedAt, request.timezoneIdentifier);
    const built = this.buildZoneProfilesRange(metricRunId, features, sessions, request, { startDate: null, previous: null });
    this.persistZoneProfileRows(built.rows);
    const pass = this.buildTrainingLoadsRange(jobId, metricRunId, features, sessions, request, overrideSnapshot, built.profiles, {
      skipTrainingSessionIds: null, distanceSeed: []
    });
    this.persistTrainingLoadWrites(pass);
    const loads = pass.loads;
    const startDate = loads[0]?.localDate ?? throughDate;
    const physEvidence = this.loadDailyPhysEvidence(startDate, throughDate, request.timezoneIdentifier, request.evaluatedAt);
    const daily = buildDailyTrainingMetrics(loads, throughDate, physEvidence);
    this.persistDailyTrainingMetrics(metricRunId, daily, request, false);
    const checkpointWritten = this.writeTrainingMetricCheckpoint({
      metricRunId, request, overrideSnapshot, throughDate,
      state: this.buildMetricCheckpointState({
        metricRunId,
        zoneProfiles: built.profiles, throughDate, distanceQueue: pass.distanceQueue, daily,
        evidence: built.evidence, physEvidence
      }),
      prefixFromLocalDate: null, prefixThroughLocalDate: null,
      counters: {
        loads: { reused: 0, recomputed: loads.length },
        zoneProfiles: { reused: 0, recomputed: built.rows.length },
        dailyMetrics: { reused: 0, recomputed: daily.length }
      }
    });
    return { loads: loads.length, zoneProfiles: built.rows.length, dailyMetrics: daily.length, checkpointWritten };
  }

  /**
   * 复用路径（O09 步骤 3/4）：集合拷贝安全前缀 + 从 checkpoint 恢复滚动状态后算到 `evaluatedAt`。
   *
   * 顺序（**证明先于写入**）：
   * 1. 父 run 的前缀负荷（内存）→ 独立重算前缀日指标并逐字段比对父 run 已落库的行；
   *    不一致就从第一处不一致起收窄复用区间（不是"整体放弃"，也不是"当作一致"）。
   * 2. 后缀分区（从父 run 的链尾续）与后缀负荷（从 checkpoint 的距离队列续）—— 只在内存里。
   * 3. 用**全部负荷**（拷贝前缀 ∪ 重算后缀）走真正的 `buildDailyTrainingMetrics`，
   *    后缀日指标直接取它的输出 ⇒ 与离线从头计算逐位一致，不需要手写第二套平滑。
   * 4. 全部通过之后才：集合拷贝前缀 → 落库后缀 → 写新 checkpoint。
   */
  private replayTrainingMetricsReused(
    jobId: string,
    metricRunId: string,
    features: WorkoutFeatureVector[],
    sessions: Map<string, SessionRow>,
    request: RecomputeRequest,
    overrideSnapshot: OverrideSnapshot,
    plan: MetricReusePlan
  ): { ok: true; counters: MetricReuseCounters } | { ok: false; reason: string } {
    const timezone = request.timezoneIdentifier;
    const throughDate = localDateAt(request.evaluatedAt, timezone);
    const parentLoads = this.loadPersistedTrainingLoads(plan.parentMetricRunId);
    const prefixLoads = parentLoads.filter((load) => load.localDate < plan.zoneStart);
    const evidenceStart = features.length === 0
      ? (prefixLoads[0]?.localDate ?? throughDate)
      : [prefixLoads[0]?.localDate ?? throughDate, localDateAt(features[0]!.workoutStartAt, timezone)].sort()[0]!;
    const physEvidence = this.loadDailyPhysEvidence(evidenceStart, throughDate, timezone, request.evaluatedAt);

    // ---- 1. 前缀证明（还没有写任何一行）----
    // v2：先按证据摘要桶判"前缀输入有没有变"；摘要有缺口才退回逐行重算。
    const proof = this.resolveDailyCopyThrough(plan, prefixLoads, physEvidence);
    if (!proof.ok) return { ok: false, reason: proof.reason };
    const dailyCopyThrough = proof.dailyCopyThrough;

    // ---- 2. 后缀计算（内存）----
    const suffix = this.buildZoneProfilesRange(metricRunId, features, sessions, request, {
      startDate: plan.zoneStart, previous: plan.previousProfile
    });
    // 🔴 距离参考队列的种子必须**截到边界**：从头的循环在处理某个后缀训练时，队列里只有
    // 它之前（更早）的训练；把父 run 的整条队列都塞进去，就等于让"未来"的训练参与
    // 90 天参考 —— 实测（合成库的训练内更正）会让边界后第一场训练的负荷偏 1.2%。
    // 队列是按时间升序的，所以"取前缀"就是取 `observedAt < 第一场后缀训练的开始时刻`。
    const suffixFeaturesInOrder = features.filter((feature) => localDateAt(feature.workoutStartAt, timezone) >= plan.zoneStart);
    const firstSuffixStartAt = suffixFeaturesInOrder[0]?.workoutStartAt ?? null;
    const distanceSeed = firstSuffixStartAt === null
      ? []
      : plan.distanceQueue.filter((entry) => entry.observedAt < firstSuffixStartAt);
    const pass = this.buildTrainingLoadsRange(jobId, metricRunId, features, sessions, request, overrideSnapshot, suffix.profiles, {
      skipTrainingSessionIds: new Set(features
        .filter((feature) => localDateAt(feature.workoutStartAt, timezone) < plan.zoneStart)
        .map((feature) => feature.trainingSessionId)),
      distanceSeed
    });
    const allLoads = [...prefixLoads, ...pass.loads];
    const daily = buildDailyTrainingMetrics(allLoads, throughDate, physEvidence);

    // ---- 3. 后缀日指标 = 全量输入上真算式的结果（不是第二套平滑）----
    const copyIndex = daily.findIndex((metric) => metric.localDate >= dailyCopyThrough);
    const dailyReused = copyIndex < 0 ? daily.length : copyIndex;
    const suffixDaily = daily.slice(dailyReused);
    if (dailyReused > 0) {
      // 收窄后的复用区间必须仍在"已证明"的范围内（证明是针对 [firstDate, dailyCopyThrough) 的）。
      const lastReused = daily[dailyReused - 1]!;
      if (lastReused.localDate >= dailyCopyThrough) return { ok: false, reason: "daily_suffix_alignment" };
    }
    const zoneRows = suffix.rows.length;
    const profileRows = Number(this.database.prepare(
      "SELECT COUNT(*) AS n FROM daily_zone_profiles WHERE training_metric_run_id = ? AND local_date < ?"
    ).get(plan.parentMetricRunId, plan.zoneStart)?.n ?? 0);
    const loadRows = prefixLoads.length;
    // ---- 4. 写入 ----
    this.copyMetricPrefixRows(metricRunId, plan, dailyCopyThrough);
    this.persistZoneProfileRows(suffix.rows);
    this.persistTrainingLoadWrites(pass);
    this.persistDailyTrainingMetrics(metricRunId, daily, request, false, dailyReused);
    const counters: MetricReuseCounters = {
      attempted: true, proof: "verified", rejectionReason: null,
      loads: { reused: loadRows, recomputed: pass.loads.length },
      zoneProfiles: { reused: profileRows, recomputed: zoneRows },
      dailyMetrics: { reused: dailyReused, recomputed: suffixDaily.length },
      checkpointWritten: false,
      reuseFromLocalDate: loadRows > 0 || profileRows > 0 ? plan.firstDate : null,
      reuseThroughLocalDate: dailyCopyThrough > plan.firstDate ? addDays(dailyCopyThrough, -1) : null
    };
    const checkpointWritten = this.writeTrainingMetricCheckpoint({
      metricRunId, request, overrideSnapshot, throughDate,
      state: this.buildMetricCheckpointState({
        metricRunId,
        zoneProfiles: suffix.profiles, throughDate, distanceQueue: pass.distanceQueue, daily,
        evidence: suffix.evidence, physEvidence
      }),
      prefixFromLocalDate: counters.reuseFromLocalDate,
      prefixThroughLocalDate: counters.reuseThroughLocalDate,
      counters: {
        loads: counters.loads, zoneProfiles: counters.zoneProfiles, dailyMetrics: counters.dailyMetrics
      }
    });
    return { ok: true, counters: { ...counters, checkpointWritten } };
  }

  /**
   * 日级生理证据的**逐日快照**（v2）。
   *
   * 覆盖 `[fromDate, throughDate]` 每一天的**有效** `physState`：同一天取首次出现（与
   * `buildDailyTrainingMetrics` 的 Map 同语义），缺失日记 `.` —— "缺失变成有值"
   * 同样会让快照变化。每块 {@link DAILY_EVIDENCE_CHUNK_DAYS} 天，块内位置即日期偏移。
   */
  private buildDailyEvidenceDays(
    physEvidence: readonly DailyPhysEvidence[],
    fromDate: string,
    throughDate: string
  ): string[] {
    if (throughDate < fromDate) return [];
    const byDate = new Map<string, string>();
    for (const item of physEvidence) {
      if (!byDate.has(item.localDate)) byDate.set(item.localDate, item.physState);
    }
    const lastOffset = daysBetween(fromDate, throughDate);
    const chunks: string[] = [];
    let chunk = "";
    for (let offset = 0; offset <= lastOffset; offset += 1) {
      const encoded = encodeDailyEvidenceState(byDate.get(addDays(fromDate, offset)));
      // 未知枚举值：无法证明"两种新状态是否相同" ⇒ 本次快照不可用（回退逐行证明）。
      if (encoded === null) return [];
      chunk += encoded;
      if (chunk.length === DAILY_EVIDENCE_CHUNK_DAYS) {
        chunks.push(chunk);
        chunk = "";
      }
      if (chunks.length > MAX_DAILY_EVIDENCE_CHUNKS) {
        // 超过上限说明状态被篡改或年限异常 ⇒ 不复用（不截断成"看起来够用"）。
        return [];
      }
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
  }

  /**
   * 一个 run 的日表**业务列**摘要（从盘上算）。
   *
   * 列集与 {@link proveDailyPrefix} 的逐字段比较同源，再加两条累计列
   * （`history_days` / `load_workout_count`）—— 保证"摘要一致"蕴含"逐字段一致"。
   */
  private dailyRowsDigest(metricRunId: string): string {
    const rows = this.database.prepare(`
      SELECT local_date AS localDate, daily_load AS load, current_7d_load AS current7dLoad,
             previous_7d_load AS previous7dLoad, acute_ewma AS acuteEwma, chronic_ewma AS chronicEwma,
             load_ratio AS loadRatio, ramp_rate AS rampRate, monotony, strain,
             workout_count AS workoutCount, training_status AS trainingStatus, confidence,
             explanation_codes_json AS codesJson, history_days AS historyDays,
             load_workout_count AS loadWorkoutCount
      FROM daily_training_metrics WHERE training_metric_run_id = ? ORDER BY local_date
    `).all(metricRunId) as unknown as Array<Record<string, unknown>>;
    return configHash(rows);
  }

  /**
   * 前缀日指标的复用边界（v2）：逐日比较本 run 现算的证据快照与父 run 存下的快照。
   *
   * - 完全一致 ⇒ 边界推进到 `zoneStart`，前缀整段拷贝；
   * - 第 k 天不一致 ⇒ 边界 = 该天（精确到天，不是"整块重算"）；
   * - 快照缺失/首日不一致/比 `zoneStart` 短 ⇒ 退回 {@link proveDailyPrefix} 逐行证明。
   *
   * 之所以能替掉逐行重算：日指标是「前缀负荷 + 每日 physState + 配置/版本」的确定性函数，
   * 前两项由快照逐日证明、后一项由 `resolveMetricReuse` 的版本闸门证明。
   */
  private resolveDailyCopyThrough(
    plan: MetricReusePlan,
    prefixLoads: readonly WorkoutTrainingLoad[],
    physEvidence: readonly DailyPhysEvidence[]
  ): { ok: true; dailyCopyThrough: string } | { ok: false; reason: string } {
    const stored = plan.state;
    const firstDate = prefixLoads[0]?.localDate;
    if (firstDate === undefined) return this.proveDailyPrefix(plan, prefixLoads, physEvidence);
    if (stored.dailyEvidenceFrom !== firstDate || stored.dailyEvidenceDays.length === 0) {
      return this.proveDailyPrefix(plan, prefixLoads, physEvidence);
    }
    // 第二道证明：父 run 的行本身必须还是写入时那一份。被就地改过 ⇒ 逐行证明去定位/收窄。
    if (stored.dailyRowsDigest !== this.dailyRowsDigest(plan.parentMetricRunId)) {
      return this.proveDailyPrefix(plan, prefixLoads, physEvidence);
    }
    const span = daysBetween(firstDate, plan.zoneStart);
    if (span < 0) return { ok: false, reason: "daily_boundary_before_series" };
    if (span === 0) return { ok: true, dailyCopyThrough: firstDate };
    const currentDays = this.buildDailyEvidenceDays(physEvidence, firstDate, addDays(firstDate, span - 1))
      .join("");
    const comparison = compareDailyEvidenceDays(stored.dailyEvidenceDays.join(""), currentDays, span);
    // 父 run 的快照没覆盖到边界（或本次证据缺失）⇒ 退回逐行证明，不拿"部分相同"近似。
    if (comparison.kind === "insufficient") return this.proveDailyPrefix(plan, prefixLoads, physEvidence);
    if (comparison.kind === "mismatch") {
      return { ok: true, dailyCopyThrough: addDays(firstDate, comparison.offset) };
    }
    return { ok: true, dailyCopyThrough: plan.zoneStart };
  }

  /**
   * 前缀证明（O09 步骤 7 的"证明失败不假装复用成功"）。
   *
   * 判据：拿父 run 的**前缀负荷**独立重算一遍日指标，与父 run **已落库**的行逐字段比对
   * （分类与 missing reason 精确比较，浮点留余量）。第一处不一致起，复用区间收窄到它之前 ——
   * 那之前的行已经被逐字段证明过，之后的行走重算。
   *
   * 为什么这件事非做不可：日指标的输入之一是**恢复物理状态**，而恢复证据的"到达时间"
   * 按每天自己的 `asOf` 判定（`publicationAt` 只在该日之前已有发布完成时才非空）。
   * 一次新导入会把 `import_completed_at` 推后，于是**某些历史日**的可用性判定随之改变 ——
   * 那时前缀就不再等于离线从头计算的结果。这个检查把"边界声明错了"变成一次可观察的收窄，
   * 而不是一次静默的错误复用。
   */
  private proveDailyPrefix(
    plan: MetricReusePlan,
    prefixLoads: readonly WorkoutTrainingLoad[],
    physEvidence: readonly DailyPhysEvidence[]
  ): { ok: true; dailyCopyThrough: string } | { ok: false; reason: string } {
    const candidate = prefixLoads.length === 0
      ? []
      : buildDailyTrainingMetrics(prefixLoads, addDays(plan.zoneStart, -1), physEvidence);
    const rows = this.database.prepare(`
      SELECT local_date AS localDate, daily_load AS load, current_7d_load AS current7dLoad,
             previous_7d_load AS previous7dLoad, acute_ewma AS acuteEwma, chronic_ewma AS chronicEwma,
             load_ratio AS loadRatio, ramp_rate AS rampRate, monotony, strain, workout_count AS workoutCount,
             training_status AS trainingStatus, confidence, explanation_codes_json AS codesJson
      FROM daily_training_metrics WHERE training_metric_run_id = ? AND local_date < ?
      ORDER BY local_date
    `).all(plan.parentMetricRunId, plan.zoneStart) as unknown as Array<Record<string, unknown>>;
    const byDate = new Map(rows.map((row) => [String(row.localDate), row]));
    for (const metric of candidate) {
      const row = byDate.get(metric.localDate);
      if (row === undefined) return { ok: false, reason: `daily_prefix_missing:${metric.localDate}` };
      if (!this.dailyRowMatchesMetric(row, metric)) {
        const narrowed = metric.localDate > plan.firstDate ? metric.localDate : plan.firstDate;
        return { ok: true, dailyCopyThrough: narrowed };
      }
    }
    if (byDate.size !== candidate.length) return { ok: false, reason: "daily_prefix_shape" };
    return { ok: true, dailyCopyThrough: plan.zoneStart };
  }

  /** 已落库的一行日指标 vs 重算出来的一行：业务值（浮点留余量）与分类/解释码（精确）都要一致。 */
  private dailyRowMatchesMetric(row: Record<string, unknown>, metric: DailyTrainingMetric): boolean {
    const sameNumber = (left: unknown, right: number | null): boolean => {
      if (left === null || left === undefined) return right === null;
      if (right === null) return false;
      const value = Number(left);
      return Number.isFinite(value) && Math.abs(value - right) <= 1e-6 * Math.max(1, Math.abs(right));
    };
    return String(row.trainingStatus) === metric.trainingStatus &&
      String(row.codesJson) === JSON.stringify(metric.statusExplanations.map((explanation) => explanation.code)) &&
      sameNumber(row.workoutCount, metric.workoutCount) &&
      sameNumber(row.load, metric.load) && sameNumber(row.current7dLoad, metric.current7dLoad) &&
      sameNumber(row.previous7dLoad, metric.previous7dLoad) && sameNumber(row.acuteEwma, metric.acuteEwma) &&
      sameNumber(row.chronicEwma, metric.chronicEwma) && sameNumber(row.loadRatio, metric.loadRatio) &&
      sameNumber(row.rampRate, metric.rampRate) && sameNumber(row.monotony, metric.monotony) &&
      sameNumber(row.strain, metric.strain) && sameNumber(row.confidence, metric.loadConfidence);
  }

  /**
   * 集合 SQL 拷贝安全前缀（O09 步骤 3），按依赖顺序：
   * `daily_zone_profiles` → `workout_training_loads`（含域快照）→ `workout_zone_summaries`
   * → `daily_training_metrics`。
   *
   * 外键口径：
   * - 新 id 由 SQL 现算（`<kind>:<新 run>:<业务键>`），**不**沿用源 run 的 id ——
   *   逐 run 分区的确定性 id 一旦带上旧 run，就是这个缺陷本身；
   * - `feature_id` / `zone_profile_id` 通过 JOIN 新 run 的行重映射
   *   （`workout_zone_summaries.zone_profile_id` 是 NOT NULL，必须先有分区行）；
   * - `daily_training_metrics` 的 `history_days` / `load_workout_count` 是累计列，**原样**拷贝。
   *
   * 拷贝是 INSERT…SELECT（每表一条语句），不是逐行循环；行数在计划阶段已证明等于父 run 的前缀行数，
   * 拷完再核对一次，少了就抛错（宁可任务失败重试，不可静默发布半份前缀）。
   */
  private copyMetricPrefixRows(metricRunId: string, plan: MetricReusePlan, dailyCopyThrough: string): void {
    const newFeatureRunId = String(this.database.prepare(
      "SELECT feature_run_id AS id FROM model_runs WHERE id = (SELECT model_run_id FROM training_metric_runs WHERE id = ?)"
    ).get(metricRunId)?.id ?? "");
    const newModelRunId = String(this.database.prepare(
      "SELECT model_run_id AS id FROM training_metric_runs WHERE id = ?"
    ).get(metricRunId)?.id ?? "");
    const parent = plan.parentMetricRunId;
    const profiles = this.database.prepare(`
      INSERT INTO daily_zone_profiles (
        id, training_metric_run_id, local_date, timezone_identifier, effective_at, data_through_at,
        resting_heart_rate_bpm, maximum_heart_rate_bpm, threshold_pace_seconds_per_km,
        heart_rate_source, pace_source, heart_rate_confidence, pace_confidence, profile_status,
        heart_rate_bands_json, pace_bands_json, evidence_json, created_at
      )
      SELECT ? || old.local_date, ?, old.local_date, old.timezone_identifier,
        old.effective_at, old.data_through_at, old.resting_heart_rate_bpm, old.maximum_heart_rate_bpm,
        old.threshold_pace_seconds_per_km, old.heart_rate_source, old.pace_source,
        old.heart_rate_confidence, old.pace_confidence, old.profile_status,
        old.heart_rate_bands_json, old.pace_bands_json, old.evidence_json, old.created_at
      FROM daily_zone_profiles old
      WHERE old.training_metric_run_id = ? AND old.local_date < ?
    `).run(`daily_zone_profile:${metricRunId}:`, metricRunId, parent, plan.zoneStart);
    const loads = this.database.prepare(`
      INSERT INTO workout_training_loads (
        id, training_metric_run_id, training_session_id, feature_id, local_date, timezone_identifier,
        distance_km, duration_seconds, training_load, intensity, load_source, confidence,
        heart_rate_coverage, average_heart_rate_bpm, elevation_gain_meters, rpe, session_type,
        explanation_codes_json, provenance_json, computed_at, zone_profile_id, stimulus_type,
        raw_hrr_trimp, internal_load, pace_load, distance_reference_meters, distance_exposure_ratio,
        distance_factor, heart_rate_load_confidence, pace_load_confidence
      )
      SELECT ? || old.training_session_id, ?, old.training_session_id, fresh.id,
        old.local_date, old.timezone_identifier, old.distance_km, old.duration_seconds, old.training_load,
        old.intensity, old.load_source, old.confidence, old.heart_rate_coverage, old.average_heart_rate_bpm,
        old.elevation_gain_meters, old.rpe, old.session_type, old.explanation_codes_json, old.provenance_json,
        old.computed_at, profile.id, old.stimulus_type, old.raw_hrr_trimp, old.internal_load, old.pace_load,
        old.distance_reference_meters, old.distance_exposure_ratio, old.distance_factor,
        old.heart_rate_load_confidence, old.pace_load_confidence
      FROM workout_training_loads old
      JOIN workout_features fresh ON fresh.feature_run_id = ? AND fresh.training_session_id = old.training_session_id
      JOIN daily_zone_profiles profile ON profile.training_metric_run_id = ? AND profile.local_date = old.local_date
      WHERE old.training_metric_run_id = ? AND old.local_date < ?
    `).run(`workout_training_load:${metricRunId}:`, metricRunId, newFeatureRunId, metricRunId, parent, plan.zoneStart);
    const summaries = this.database.prepare(`
      INSERT INTO workout_zone_summaries (
        id, training_metric_run_id, training_session_id, feature_id, zone_profile_id, stimulus_type,
        secondary_stimulus_types_json, stimulus_confidence, heart_rate_coverage, pace_coverage,
        heart_rate_exposure_json, pace_exposure_json, stimulus_scores_json, explanation_codes_json, computed_at
      )
      SELECT ? || old.training_session_id, ?, old.training_session_id, fresh.id,
        profile.id, old.stimulus_type, old.secondary_stimulus_types_json, old.stimulus_confidence,
        old.heart_rate_coverage, old.pace_coverage, old.heart_rate_exposure_json, old.pace_exposure_json,
        old.stimulus_scores_json, old.explanation_codes_json, old.computed_at
      FROM workout_zone_summaries old
      JOIN workout_training_loads load ON load.training_metric_run_id = ?
        AND load.training_session_id = old.training_session_id
      JOIN daily_zone_profiles profile ON profile.training_metric_run_id = ? AND profile.local_date = load.local_date
      JOIN workout_features fresh ON fresh.feature_run_id = ? AND fresh.training_session_id = old.training_session_id
      WHERE old.training_metric_run_id = ?
    `).run(`workout_zone_summary:${metricRunId}:`, metricRunId, metricRunId, metricRunId, newFeatureRunId, parent);
    const daily = this.database.prepare(`
      INSERT INTO daily_training_metrics (
        id, training_metric_run_id, local_date, timezone_identifier, distance_km, duration_seconds,
        workout_count, daily_load, current_7d_load, previous_7d_load, acute_ewma, chronic_ewma,
        load_ratio, ramp_rate, monotony, strain, recovery_evidence, history_days, load_workout_count,
        training_status, confidence, explanation_codes_json, explanation_json, computed_at
      )
      SELECT ? || old.local_date, ?, old.local_date, old.timezone_identifier,
        old.distance_km, old.duration_seconds, old.workout_count, old.daily_load, old.current_7d_load,
        old.previous_7d_load, old.acute_ewma, old.chronic_ewma, old.load_ratio, old.ramp_rate, old.monotony,
        old.strain, old.recovery_evidence, old.history_days, old.load_workout_count, old.training_status,
        old.confidence, old.explanation_codes_json, old.explanation_json, old.computed_at
      FROM daily_training_metrics old
      WHERE old.training_metric_run_id = ? AND old.local_date < ?
    `).run(`daily_training_metric:${metricRunId}:`, metricRunId, parent, dailyCopyThrough);
    // 逐训练域快照同时搬过去：新 run 的 `load_vector` / `zone_coherence` 覆盖度不能因为复用而残缺。
    this.database.prepare(`
      INSERT INTO model_domain_snapshots (model_run_id, domain, snapshot_key, as_of, payload_json, payload_hash)
      SELECT ?, old.domain, old.snapshot_key, old.as_of, old.payload_json, old.payload_hash
      FROM model_domain_snapshots old
      WHERE old.model_run_id = ? AND old.domain IN ('load_vector', 'zone_coherence')
        AND EXISTS (SELECT 1 FROM workout_training_loads load
          WHERE load.training_metric_run_id = ? AND load.training_session_id = old.snapshot_key
            AND load.local_date < ?)
    `).run(newModelRunId, plan.parentModelRunId, metricRunId, plan.zoneStart);
    const expectedProfiles = Number(this.database.prepare(
      "SELECT COUNT(*) AS n FROM daily_zone_profiles WHERE training_metric_run_id = ? AND local_date < ?"
    ).get(parent, plan.zoneStart)?.n ?? 0);
    const expectedLoads = Number(this.database.prepare(
      "SELECT COUNT(*) AS n FROM workout_training_loads WHERE training_metric_run_id = ? AND local_date < ?"
    ).get(parent, plan.zoneStart)?.n ?? 0);
    const expectedSummaries = Number(this.database.prepare(`
      SELECT COUNT(*) AS n FROM workout_zone_summaries old
      WHERE old.training_metric_run_id = ?
        AND EXISTS (SELECT 1 FROM workout_training_loads load
          WHERE load.training_metric_run_id = ? AND load.training_session_id = old.training_session_id
            AND load.local_date < ?)
    `).get(parent, parent, plan.zoneStart)?.n ?? 0);
    const expectedDaily = Number(this.database.prepare(
      "SELECT COUNT(*) AS n FROM daily_training_metrics WHERE training_metric_run_id = ? AND local_date < ?"
    ).get(parent, dailyCopyThrough)?.n ?? 0);
    const copied = {
      profiles: Number(profiles.changes), loads: Number(loads.changes),
      summaries: Number(summaries.changes), daily: Number(daily.changes)
    };
    if (copied.profiles !== expectedProfiles || copied.loads !== expectedLoads ||
      copied.summaries !== expectedSummaries || copied.daily !== expectedDaily) {
      throw new Error(
        `Metric prefix copy is incomplete (profiles ${copied.profiles}/${expectedProfiles}, ` +
        `loads ${copied.loads}/${expectedLoads}, summaries ${copied.summaries}/${expectedSummaries}, ` +
        `daily ${copied.daily}/${expectedDaily})`
      );
    }
  }

  /**
   * 滚动状态（O09 步骤 2/4）：分区链尾、**完整**的距离参考队列、日级平滑与累计种子。
   *
   * 队列刻意**不按天数截尾**：队列的用途是"任何未来的后缀都要拿它做 90 天参考"，
   * 而未来的边界可以落在任何历史位置 —— 截尾后的队列对更早的后缀就是**错的历史**。
   * 超过 {@link MAX_DISTANCE_QUEUE_ENTRIES} 时记 `distanceQueueComplete = false` 并存空队列：
   * 那是"不可复用"，不是"用一个不完整的队列凑合"。
   */
  private buildMetricCheckpointState(input: {
    metricRunId: string;
    zoneProfiles: Map<string, DailyZoneProfile>;
    throughDate: string;
    distanceQueue: readonly DistanceQueueEntry[];
    daily: readonly DailyTrainingMetric[];
    evidence: ZoneEvidenceSnapshot;
    physEvidence: readonly DailyPhysEvidence[];
  }): TrainingMetricCheckpointState {
    const tailProfile = input.zoneProfiles.get(input.throughDate) ??
      [...input.zoneProfiles.values()].at(-1) ?? null;
    const lastDaily = input.daily.at(-1) ?? null;
    const firstDaily = input.daily[0]?.localDate;
    const complete = input.distanceQueue.length <= MAX_DISTANCE_QUEUE_ENTRIES;
    return {
      version: TRAINING_METRIC_CHECKPOINT_VERSION,
      zonePrevious: this.zoneChainState(tailProfile),
      evidence: {
        sourceRunId: input.evidence.sourceRunId,
        labeled: [...input.evidence.labeled], performance: [...input.evidence.performance],
        threshold: [...input.evidence.threshold]
      },
      distanceQueueComplete: complete,
      distanceQueue: complete ? input.distanceQueue.map((entry) => ({ ...entry })) : [],
      daily: lastDaily === null ? null : {
        localDate: lastDaily.localDate, acuteEwma: lastDaily.acuteEwma, chronicEwma: lastDaily.chronicEwma,
        workoutCount: input.daily.reduce((sum, metric) => sum + metric.workoutCount, 0),
        historyDays: input.daily.length
      },
      // 没有日行就无法定义快照原点：写空值，下一 run 会走逐行证明（不会把"空"当"全一致"）。
      dailyEvidenceFrom: firstDaily ?? "",
      dailyEvidenceDays: firstDaily === undefined
        ? []
        : this.buildDailyEvidenceDays(input.physEvidence, firstDaily, input.throughDate),
      dailyRowsDigest: this.dailyRowsDigest(input.metricRunId)
    };
  }

  /**
   * 距离参考队列的**来源证明**：按父 run 的同一套判据重算一遍期望队列，逐条比对。
   *
   * 判据与 `buildTrainingLoadsRange` 里的 `!excluded && distanceMeters > 0` 逐字同义：
   * 会话必须 active、override 不得 exclude、平均配速不合理的训练除非被显式 include 否则排除、
   * 距离必须为正。比对的是**整条队列**（含顺序），所以截断、伪造、漏项都会被抓到。
   */
  private deriveDistanceQueue(featureRunId: string, overrideSnapshot: OverrideSnapshot): DistanceQueueEntry[] {
    const rows = this.database.prepare(`
      SELECT feature.workout_start_at AS startAt, feature.distance_km AS distanceKm,
             feature.missing_reasons_json AS missingReasons, feature.training_session_id AS trainingSessionId,
             session.status AS sessionStatus
      FROM workout_features feature
      JOIN training_sessions session ON session.id = feature.training_session_id
      WHERE feature.feature_run_id = ?
      ORDER BY feature.workout_start_at, feature.id
    `).all(featureRunId) as unknown as Array<{
      startAt: string; distanceKm: number | null; missingReasons: string;
      trainingSessionId: string; sessionStatus: string;
    }>;
    const queue: DistanceQueueEntry[] = [];
    for (const row of rows) {
      const override = overrideSnapshot.byTrainingSessionId.get(row.trainingSessionId) ?? null;
      const implausible = (parseJson<string[]>(row.missingReasons, []).includes("implausible_average_pace")) &&
        override?.statisticsParticipation !== "include";
      const excluded = row.sessionStatus !== "active" ||
        override?.statisticsParticipation === "exclude" || implausible;
      const distanceMeters = row.distanceKm === null ? null : Number(row.distanceKm) * 1000;
      if (excluded || distanceMeters === null || !(distanceMeters > 0)) continue;
      queue.push({ observedAt: row.startAt, distanceMeters });
    }
    return queue;
  }

  /**
   * 写本 run 的 checkpoint（O09 步骤 2）。
   *
   * 记录算法/配置版本、时区、override 摘要、输入绑定摘要与**滚动状态**；
   * `state_hash` 是写入侧的完整性戳（防改动，不代替形状校验）。
   * 状态一律从**已落库的行**里取（`zoneProfiles` 最后一天、`daily` 最后一行），
   * 于是"状态"与"表里的前缀"天然对得上 —— 恢复时两者都要能对上才复用。
   */
  private writeTrainingMetricCheckpoint(input: {
    metricRunId: string;
    request: RecomputeRequest;
    overrideSnapshot: OverrideSnapshot;
    throughDate: string;
    state: TrainingMetricCheckpointState;
    prefixFromLocalDate: string | null;
    prefixThroughLocalDate: string | null;
    counters: Pick<MetricReuseCounters, "loads" | "zoneProfiles" | "dailyMetrics">;
  }): boolean {
    // 摘要一律走**与读取侧同一对函数**（`overrideSnapshotDigest` / `metricInputBindingDigest`
    // / `metricPrefixCompatibilityDigest`）：两处各写一份必然会漂移，
    // 而漂移的后果是"输入变了却仍然复用"。
    // R05：`input_binding_digest` 存**身份摘要**（含代次，谱系用）；复用判据读的是
    // `prefix_compat_digest`（不含代次）—— 两列各有各的职责，同一处写出。
    const overrideDigest = this.overrideSnapshotDigest(input.overrideSnapshot);
    const inputBindingDigest = this.metricInputBindingDigest(input.overrideSnapshot);
    const prefixCompatDigest = this.metricPrefixCompatibilityDigest(input.overrideSnapshot);
    const stateJson = JSON.stringify(input.state);
    this.database.prepare(`
      INSERT OR REPLACE INTO training_metric_checkpoints (
        id, training_metric_run_id, checkpoint_version, load_algorithm_version, zone_algorithm_version,
        daily_algorithm_version, config_hash, zone_settings_digest, override_digest, input_binding_digest,
        timezone_identifier, through_local_date, through_at, prefix_from_local_date, prefix_through_local_date,
        state_json, state_hash, counters_json, created_at, prefix_compat_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deterministicId("training_metric_checkpoint", { metricRunId: input.metricRunId }),
      input.metricRunId, TRAINING_METRIC_CHECKPOINT_VERSION, TRAINING_LOAD_CONFIG_VERSION,
      TRAINING_ZONE_CONFIG_VERSION, DAILY_METRIC_ALGORITHM_VERSION,
      String(this.database.prepare("SELECT config_hash AS hash FROM training_metric_runs WHERE id = ?")
        .get(input.metricRunId)?.hash ?? ""),
      this.zoneSettingsDigest(), overrideDigest, inputBindingDigest,
      input.request.timezoneIdentifier, input.throughDate, input.request.evaluatedAt,
      input.prefixFromLocalDate, input.prefixThroughLocalDate,
      stateJson, configHash(input.state), JSON.stringify(input.counters), appNow(),
      prefixCompatDigest
    );
    return true;
  }

  /**
   * 逐训练负荷与分区摘要的**计算**（O09 步骤 3/6）：只产出领域对象、待写行与域快照。
   *
   * `skipTrainingSessionIds` = 已由集合拷贝搬过来的训练（前缀），不再重算；
   * `distanceSeed` = checkpoint 里的 90 天距离参考队列（从**边界之前**续上的那段历史）。
   */
  private buildTrainingLoadsRange(
    jobId: string,
    metricRunId: string,
    features: WorkoutFeatureVector[],
    sessions: Map<string, SessionRow>,
    request: RecomputeRequest,
    overrideSnapshot: OverrideSnapshot,
    zoneProfiles: Map<string, DailyZoneProfile>,
    options: { skipTrainingSessionIds: ReadonlySet<string> | null; distanceSeed: readonly DistanceQueueEntry[] }
  ): TrainingLoadPass {
    const loads: WorkoutTrainingLoad[] = [];
    const writes: StagedLoadWrite[] = [];
    const snapshots: StagedSnapshot[] = [];
    const modelId = String(this.database.prepare(
      "SELECT model_run_id AS model_run_id FROM training_metric_runs WHERE id=?"
    ).get(metricRunId)?.model_run_id);
    const priorDistances: DistanceQueueEntry[] = options.distanceSeed.map((entry) => ({ ...entry }));
    // R06 覆盖守卫（负荷阶段）：本阶段按会话读心率/速度明细与**高程聚合**（路线点）。
    // 取"实际会被算的会话"（`features` 去掉前缀跳过集）里最早的起点 —— 负荷的驱动量是
    // 会话而不是日，且日粒度与时刻粒度之间隔着时区偏移（`routeFrom` 已为此留一天余量，
    // 这里再判一次）。越界同样显式失败 + 回退，绝不静默少读高程/明细。
    const earliestLoadedStart = this.earliestWorkoutStartAt(
      options.skipTrainingSessionIds === null
        ? features
        : features.filter((feature) => !options.skipTrainingSessionIds!.has(feature.trainingSessionId))
    );
    const earliestLoaded = earliestLoadedStart === null
      ? null
      : new Date(earliestLoadedStart).toISOString();
    this.assertFactCoverage(earliestLoaded, "route", "training_loads");
    this.assertFactCoverage(earliestLoaded, "records", "training_loads");
    for (const [index, feature] of features.entries()) {
      this.throwIfCancelled(jobId);
      this.gate.yieldIfStale();
      if (options.skipTrainingSessionIds?.has(feature.trainingSessionId)) continue;
      const session = sessions.get(feature.trainingSessionId);
      const override = overrideSnapshot.byTrainingSessionId.get(feature.trainingSessionId) ?? null;
      const implausibleStatistics = feature.missingReasons.includes("implausible_average_pace") &&
        override?.statisticsParticipation !== "include";
      const excluded = session?.trainingSessionStatus !== "active" ||
        override?.statisticsParticipation === "exclude" || implausibleStatistics;
      const localDate = localDateAt(feature.workoutStartAt, request.timezoneIdentifier);
      const zoneProfile = zoneProfiles.get(localDate);
      if (!zoneProfile) throw new Error(`Missing zone profile for ${localDate}`);
      // O09 步骤 6：一次装配（心率/速度区间、30 秒平滑、高程聚合）在特征、最大心率证据、
      // 分区与负荷四个阶段之间复用；这里拿到的是同一份缓存对象。
      const assembly = session === undefined ? null : this.workoutAssembly(session);
      const heartMetricSamples = assembly?.heartSamples ?? [];
      const speedSamples = assembly?.speedSamples ?? [];
      const distanceMeters = feature.distanceKm === null ? null : feature.distanceKm * 1000;
      const averagePaceSecondsPerKm = feature.distanceKm !== null && feature.distanceKm > 0
        ? feature.durationSeconds / feature.distanceKm
        : null;
      const elapsedSeconds = session
        ? (Date.parse(session.workoutEndAt) - Date.parse(session.workoutStartAt)) / 1000
        : Number.NaN;
      const elapsedDurationSeconds = Number.isFinite(elapsedSeconds)
        ? Math.max(feature.durationSeconds, elapsedSeconds)
        : feature.durationSeconds;
      const zoneSummary = analyzeWorkoutZones({
        trainingSessionId: feature.trainingSessionId,
        durationSeconds: feature.durationSeconds,
        elapsedDurationSeconds,
        distanceMeters,
        sourceConfidence: feature.sourceConfidence,
        profile: zoneProfile,
        heartRateSamples: heartMetricSamples,
        speedSamples,
        averageHeartRateBpm: feature.averageHeartRateBpm,
        averagePaceSecondsPerKm
      });
      const cutoff = Date.parse(feature.workoutStartAt) - 90 * 86_400_000;
      const distanceValues = priorDistances
        .filter((item) => Date.parse(item.observedAt) >= cutoff)
        .map((item) => item.distanceMeters);
      const distanceReferenceMeters = distanceValues.length >= 5 ? percentile(distanceValues, 0.75) : null;
      const breakdown = calculateCompositeTrainingLoad({
        durationSeconds: feature.durationSeconds,
        elapsedDurationSeconds,
        distanceMeters,
        profile: zoneProfile,
        zoneSummary,
        heartRateSamples: heartMetricSamples,
        speedSamples,
        averageHeartRateBpm: feature.averageHeartRateBpm,
        averagePaceSecondsPerKm,
        distanceReferenceMeters,
        rpe: override?.rpe ?? null,
        sessionType: feature.sessionType,
        sourceConfidence: feature.sourceConfidence
      });
      const load = calculateWorkoutTrainingLoad({
        trainingSessionId: feature.trainingSessionId,
        localDate,
        durationSeconds: feature.durationSeconds,
        distanceMeters,
        heartRateSamples: heartMetricSamples.map((sample) => ({
          heartRate: sample.value,
          durationSeconds: sample.durationSeconds,
          ...(sample.startOffsetSeconds === undefined ? {} : { startOffsetSeconds: sample.startOffsetSeconds })
        })),
        ...(feature.heartRateCoverage === null ? {} : { heartRateCoverage: feature.heartRateCoverage }),
        averageHeartRate: feature.averageHeartRateBpm,
        restingHeartRate: zoneProfile.restingHeartRateBpm,
        observedMaxHeartRate: zoneProfile.maximumHeartRateBpm,
        rpe: override?.rpe ?? null,
        sessionType: feature.sessionType,
        elevationGainMeters: assembly === null ? null : assembly.elevationGainMeters(),
        sourceConfidence: feature.sourceConfidence,
        excluded,
        zoneSummary,
        loadBreakdown: breakdown
      });
      if (load) {
        snapshots.push({ domain: "load_vector", key: feature.trainingSessionId, asOf: feature.workoutStartAt, payload: buildLoadVectorV2({ load, zoneSummary }) });
        snapshots.push({ domain: "zone_coherence", key: feature.trainingSessionId, asOf: feature.workoutStartAt, payload: zoneSummary });
        writes.push({
          table: "workout_zone_summaries",
          values: [
            deterministicId("workout_zone_summary", { metricRunId, trainingSessionId: feature.trainingSessionId }),
            metricRunId, feature.trainingSessionId, feature.id, zoneProfile.id,
            zoneSummary.stimulusType, JSON.stringify(zoneSummary.secondaryStimulusTypes),
            zoneSummary.stimulusConfidence, zoneSummary.heartRateCoverage, zoneSummary.paceCoverage,
            JSON.stringify(zoneSummary.heartRateExposure), JSON.stringify(zoneSummary.paceExposure),
            JSON.stringify(zoneSummary.stimulusScores), JSON.stringify(zoneSummary.explanationCodes),
            request.evaluatedAt
          ]
        });
        writes.push({
          table: "workout_training_loads",
          values: [
            deterministicId("workout_training_load", { trainingMetricRunId: metricRunId, trainingSessionId: feature.trainingSessionId }),
            metricRunId,
            feature.trainingSessionId,
            feature.id,
            load.localDate,
            request.timezoneIdentifier,
            load.distanceMeters === null ? null : load.distanceMeters / 1000,
            load.durationSeconds,
            load.load,
            load.intensity,
            load.source,
            load.confidence,
            feature.heartRateCoverage,
            load.averageHeartRate,
            load.elevationGainMeters,
            load.rpe,
            load.sessionType,
            JSON.stringify(load.explanations.map((explanation) => explanation.code)),
            JSON.stringify({
              explanations: load.explanations,
              zoneExplanations: zoneSummary.explanationCodes,
              sourceConfidence: feature.sourceConfidence,
              loadComposition: {
                heartRateConfidence: load.breakdown.heartRateConfidence,
                paceConfidence: load.breakdown.paceConfidence,
                distanceFactor: load.breakdown.distanceFactor
              },
              statisticsParticipation: override?.statisticsParticipation ?? null
            }),
            request.evaluatedAt,
            zoneProfile.id,
            load.stimulusType,
            load.breakdown.rawHrrTrimp,
            load.breakdown.internalLoad,
            load.breakdown.paceLoad,
            load.breakdown.distanceReferenceMeters,
            load.breakdown.distanceExposureRatio,
            load.breakdown.distanceFactor,
            load.breakdown.heartRateConfidence,
            load.breakdown.paceConfidence
          ]
        });
        loads.push(load);
        this.updateJobProgress(jobId, "training_metrics", index + 1, features.length, "Training load calculated");
      }
      if (!excluded && distanceMeters !== null && distanceMeters > 0) {
        priorDistances.push({ observedAt: feature.workoutStartAt, distanceMeters });
      }
    }
    return { loads, writes, snapshots, distanceQueue: priorDistances, modelId };
  }

  /** 训练负荷/分区摘要/域快照的落库（O07 步骤 4：分块短事务）。 */
  private persistTrainingLoadWrites(pass: TrainingLoadPass): void {
    if (pass.writes.length === 0) return;
    const insertZoneSummary = this.database.prepare(`
      INSERT INTO workout_zone_summaries (
        id, training_metric_run_id, training_session_id, feature_id, zone_profile_id,
        stimulus_type, secondary_stimulus_types_json, stimulus_confidence,
        heart_rate_coverage, pace_coverage, heart_rate_exposure_json,
        pace_exposure_json, stimulus_scores_json, explanation_codes_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLoad = this.database.prepare(`
      INSERT INTO workout_training_loads (
        id, training_metric_run_id, training_session_id, feature_id,
        local_date, timezone_identifier, distance_km, duration_seconds,
        training_load, intensity, load_source, confidence, heart_rate_coverage,
        average_heart_rate_bpm, elevation_gain_meters, rpe, session_type,
        explanation_codes_json, provenance_json, computed_at, zone_profile_id,
        stimulus_type, raw_hrr_trimp, internal_load, pace_load,
        distance_reference_meters, distance_exposure_ratio, distance_factor,
        heart_rate_load_confidence, pace_load_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const releases = new SqliteModelReleaseRepository(this.database);
    const writer = new ChunkedWriter(this.database, this.gate);
    // 域快照先写：它是发布 gate 覆盖度的一部分，不能因为后面的载荷写入被截断而残缺。
    for (const snapshot of pass.snapshots) {
      releases.putSnapshot(pass.modelId, snapshot.domain, snapshot.key, snapshot.asOf, snapshot.payload);
    }
    for (const write of pass.writes) {
      writer.add(() => (write.table === "workout_zone_summaries"
        ? insertZoneSummary.run(...(write.values as SQLInputValue[]))
        : insertLoad.run(...(write.values as SQLInputValue[]))));
    }
    writer.flush();
  }

  private persistDailyTrainingMetrics(
    metricRunId: string,
    metrics: DailyTrainingMetric[],
    request: RecomputeRequest,
    ignoreExisting: boolean,
    writeFromIndex = 0
  ): void {
    const insert = this.database.prepare(`
      INSERT ${ignoreExisting ? "OR IGNORE" : ""} INTO daily_training_metrics (
        id, training_metric_run_id, local_date, timezone_identifier,
        distance_km, duration_seconds, workout_count, daily_load,
        current_7d_load, previous_7d_load, acute_ewma, chronic_ewma,
        load_ratio, ramp_rate, monotony, strain, recovery_evidence,
        history_days, load_workout_count, training_status, confidence,
        explanation_codes_json, explanation_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let cumulativeWorkoutCount = 0;
    // O07 步骤 4：逐日训练指标按分块短事务落地。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (const [index, metric] of metrics.entries()) {
      cumulativeWorkoutCount += metric.workoutCount;
      // 🔴 累计列必须**按行取值**再进闭包：`writer.add` 是延迟执行（≤100 行一批 + 收尾 flush），
      // 闭包若直接引用 `let cumulativeWorkoutCount`，等到真正执行时它已经涨到总数 ——
      // 于是每一天的 `load_workout_count` 都写成"全期总数"。这是本工作包在"增量 vs 从头"
      // 对照里先发现的现象（复制前缀保留父 run 的值、重算后缀拿到总数 ⇒ 同一天两个值）。
      // `history_days` / `load_workout_count` 是**累计**列；复用时只写后缀，但序号按整条序列算。
      const cumulativeThroughDay = cumulativeWorkoutCount;
      if (index < writeFromIndex) continue;
      writer.add(() => insert.run(
        deterministicId("daily_training_metric", { metricRunId, localDate: metric.localDate }),
        metricRunId,
        metric.localDate,
        request.timezoneIdentifier,
        metric.distanceMeters / 1000,
        metric.durationSeconds,
        metric.workoutCount,
        metric.load,
        metric.current7dLoad,
        metric.previous7dLoad,
        metric.acuteEwma,
        metric.chronicEwma,
        metric.loadRatio,
        metric.rampRate,
        metric.monotony,
        metric.strain,
        metric.recoveryEvidence,
        index + 1,
        cumulativeThroughDay,
        metric.trainingStatus,
        metric.loadConfidence,
        JSON.stringify(metric.statusExplanations.map((explanation) => explanation.code)),
        JSON.stringify(metric.statusExplanations),
        request.evaluatedAt
      ));
    }
    writer.flush();
  }

  private loadPersistedTrainingLoads(metricRunId: string): WorkoutTrainingLoad[] {
    return loadPersistedTrainingLoads(this.database, metricRunId);
  }

  /**
   * Build one physiological state per local calendar day. All inputs are
   * canonical facts and every baseline is strictly as-of the day being scored.
   * The resulting state is used by training status; recovery_evidence remains
   * null and is retained only as a compatibility column.
   */
  private loadDailyPhysEvidence(startDate: string, throughDate: string, timezoneIdentifier: string, asOfAt: string): DailyPhysEvidence[] {
    return loadDailyPhysEvidence(this.facts, startDate, throughDate, timezoneIdentifier, asOfAt);
  }

  private loadLegacyDailyPhysEvidence(startDate: string, throughDate: string, timezoneIdentifier: string, asOfAt: string): DailyPhysEvidence[] {
    if (throughDate < startDate) return [];
    const baselineStart = addDays(startDate, -60);
    const nightRows = this.facts.prepare(`
      SELECT wake_date AS wakeDate, wake_at AS wakeAt, asleep_union_minutes AS sleepMinutes
      FROM canonical_nights
      WHERE kind = 'main' AND timezone_identifier = ?
        AND wake_date >= ? AND wake_date <= ? AND wake_at < ?
      ORDER BY wake_date
    `).all(timezoneIdentifier, baselineStart, throughDate, asOfAt) as unknown as Array<{ wakeDate: string; wakeAt: string | null; sleepMinutes: number | null }>;
    const hrvRows = this.facts.prepare(`
      SELECT local_date AS localDate, window_end_at AS windowEndAt, hrv_sdnn_ms AS hrvMs
      FROM canonical_hrv_days
      WHERE timezone_identifier = ? AND local_date >= ? AND local_date <= ?
      ORDER BY local_date
    `).all(timezoneIdentifier, baselineStart, throughDate) as unknown as Array<{ localDate: string; windowEndAt: string | null; hrvMs: number | null }>;
    const rhrRows = this.facts.prepare(`
      SELECT start_at AS startAt, source_category AS sourceCategory, value_numeric AS value
      FROM health_records
      WHERE type = 'HKQuantityTypeIdentifierRestingHeartRate'
        AND source_category IN ('apple_watch', 'connect')
        AND start_at >= ? AND start_at < ? AND value_numeric IS NOT NULL
      ORDER BY start_at
    `).all(
      localDateStartAt(baselineStart, timezoneIdentifier),
      localDateStartAt(addDays(throughDate, 1), timezoneIdentifier)
    ) as unknown as Array<{ startAt: string; sourceCategory: string; value: number }>;

    const finiteValues = (values: Array<number | null | undefined>): number[] => values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const medianValue = (values: number[]): number | null => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    const baseline = (values: Map<string, number>, localDate: string): number | null => {
      const read = (days: number): number[] => {
        const from = addDays(localDate, -days);
        return [...values.entries()].filter(([date]) => date >= from && date < localDate).map(([, value]) => value);
      };
      const recent = read(28);
      if (recent.length >= 7) return medianValue(recent);
      const extended = read(60);
      return extended.length >= 7 ? medianValue(extended) : null;
    };
    const sleepByDate = new Map(nightRows.flatMap((row) => row.sleepMinutes == null || !Number.isFinite(Number(row.sleepMinutes)) ? [] : [[row.wakeDate, Number(row.sleepMinutes)]]));
    const asOfMs = Date.parse(asOfAt);
    const hrvByDate = new Map(hrvRows.flatMap((row) => row.hrvMs == null || !Number.isFinite(Number(row.hrvMs)) || (row.windowEndAt && Date.parse(row.windowEndAt) >= Date.parse(localDateStartAt(addDays(row.localDate, 1), timezoneIdentifier))) || (row.localDate === throughDate && row.windowEndAt && Date.parse(row.windowEndAt) >= asOfMs) ? [] : [[row.localDate, Number(row.hrvMs)]]));
    const rhrByDate = new Map<string, number>();
    for (let date = baselineStart; date <= throughDate; date = addDays(date, 1)) {
      const fullDayEnd = Date.parse(localDateStartAt(addDays(date, 1), timezoneIdentifier));
      const dayEnd = date === throughDate ? Math.min(fullDayEnd, Date.parse(asOfAt)) : fullDayEnd;
      const from = dayEnd - 36 * 60 * 60 * 1000;
      const selected = rhrRows.filter((row) => {
        const at = Date.parse(row.startAt);
        return Number.isFinite(at) && at >= from && at < dayEnd && Number.isFinite(Number(row.value));
      });
      const watch = selected.filter((row) => row.sourceCategory === "apple_watch");
      const values = finiteValues((watch.length ? watch : selected).map((row) => Number(row.value)));
      const value = medianValue(values);
      if (value !== null) rhrByDate.set(date, value);
    }
    const result: DailyPhysEvidence[] = [];
    for (let date = startDate; date <= throughDate; date = addDays(date, 1)) {
      const sleepBaseline = baseline(sleepByDate, date);
      const hrvBaseline = baseline(hrvByDate, date);
      const rhrBaseline = baseline(rhrByDate, date);
      const sleepMinutes = sleepByDate.get(date) ?? null;
      const hrvMs = hrvByDate.get(date) ?? null;
      const rhrBpm = rhrByDate.get(date) ?? null;
      const nightsBelowSleepBaseline = sleepBaseline === null ? 0 : [date, addDays(date, -1), addDays(date, -2)]
        .map((day) => sleepByDate.get(day))
        // Same compatibility threshold as the single-night rule (`@rai/readiness`):
        // "three consecutive bad nights" may not mean a different "bad" than one night.
        .filter((minutes): minutes is number => minutes !== undefined && minutes < sleepBaseline * READINESS_SLEEP_RATIO_THRESHOLD).length;
      result.push({
        localDate: date,
        physState: classifyPhysState({
          sleepMinutes,
          sleepBaselineMinutes: sleepBaseline,
          hrvSdnnMs: hrvMs,
          hrvBaselineMs: hrvBaseline,
          rhrBpm,
          rhrBaselineBpm: rhrBaseline,
          nightsBelowSleepBaseline
        })
      });
    }
    return result;
  }

  private resumeModelReplay(
    modelRun: ModelRun,
    request: RecomputeRequest,
    features: WorkoutFeatureVector[],
    baseline: PersonalBaseline
  ): ReplayResume | null {
    // O04（WP-20）：与特征前缀**同一份边界解析**（domains 优先、老 payload 回落）。
    const replayPlan = request.incrementalPlan;
    const dirtyFromAt = replayPlan?.domains ? replayPlan.domains.features : replayPlan?.dirtyFromAt;
    if (!dirtyFromAt || dirtyFromAt <= baseline.calibrationEndAt) return null;
    // A complete feature-prefix copy is a prerequisite for assessment reuse.
    // Newly eligible historical workouts or a timezone change invalidate it.
    const currentFeatureRun = this.database.prepare("SELECT parent_feature_run_id AS parent FROM feature_runs WHERE id=?")
      .get(modelRun.featureRunId) as { parent: string | null } | undefined;
    if (!currentFeatureRun?.parent) return null;
    const expectedModelHash = configHash({ version: MODEL_CONFIG_VERSION, engineVersion: SCORING_MODEL_VERSION, config: request.modelConfig });
    const expectedFeatureHash = configHash(request.featureConfig);
    const row = this.database.prepare(`
      SELECT checkpoint.model_run_id AS parentModelRunId,
             checkpoint.sequence_number AS sequenceNumber,
             checkpoint.state_json AS stateJson, checkpoint.state_hash AS stateHash
      FROM active_model_run active
      JOIN model_runs parent ON parent.id = active.model_run_id AND parent.status = 'succeeded'
      JOIN feature_runs feature ON feature.id = parent.feature_run_id AND feature.status = 'succeeded'
      JOIN model_checkpoints checkpoint ON checkpoint.model_run_id = parent.id
      WHERE active.singleton = 1 AND checkpoint.through_at < ?
        AND checkpoint.checkpoint_version = ? AND checkpoint.model_version = ?
        AND checkpoint.model_config_hash = ? AND checkpoint.feature_schema_version = ?
        AND checkpoint.feature_config_hash = ? AND checkpoint.timezone_identifier = ?
      ORDER BY checkpoint.through_at DESC, checkpoint.sequence_number DESC LIMIT 1
    `).get(
      dirtyFromAt,
      MODEL_CHECKPOINT_VERSION,
      MODEL_CONFIG_VERSION,
      expectedModelHash,
      FEATURE_SCHEMA_VERSION,
      expectedFeatureHash,
      request.timezoneIdentifier
    ) as unknown as { parentModelRunId: string; sequenceNumber: number; stateJson: string; stateHash: string } | undefined;
    if (!row || row.sequenceNumber >= features.length || configHash(parseJson(row.stateJson, {})) !== row.stateHash) {
      return null;
    }
    const prefix = this.database.prepare(`SELECT training_session_id AS sessionId FROM ability_assessments
      WHERE model_run_id=? AND sequence_number<=? ORDER BY sequence_number`)
      .all(row.parentModelRunId, row.sequenceNumber) as { sessionId: string }[];
    if (prefix.length !== row.sequenceNumber + 1 ||
        prefix.some((item, index) => features[index]?.trainingSessionId !== item.sessionId)) return null;
    const state = parseJson<ModelCheckpointState | null>(row.stateJson, null);
    if (!state?.baseline || !Number.isFinite(state.trueAbility) || !Number.isFinite(state.eligibleWorkoutCount)) {
      return null;
    }
    // The confirmation buffer has to be reconstructible, not defaulted: resuming
    // with an empty buffer would let a replayed prefix confirm a decline the live
    // run had not, and vice versa.
    if (!Array.isArray(state.pendingNegativeIds) ||
        state.pendingNegativeIds.some((id) => typeof id !== "string")) {
      return null;
    }
    this.database.prepare(`
      INSERT INTO ability_assessments (
        id, model_run_id, feature_id, training_session_id, sequence_number,
        assessment_status, current_ability, efficiency_score, pace_score, cardio_score,
        stability_score, recovery_score, effective_weights_json, confidence,
        confidence_factors_json, workout_contribution, evidence_strength, direction_factor,
        growth_resistance, true_ability_before, true_ability_after, true_ability_delta,
        updated_true_ability, explanation_codes_json, explanation_json, assessed_at
      )
      SELECT ? || ':' || old.training_session_id, ?, fresh.id, old.training_session_id,
        old.sequence_number, old.assessment_status, old.current_ability, old.efficiency_score,
        old.pace_score, old.cardio_score, old.stability_score, old.recovery_score,
        old.effective_weights_json, old.confidence, old.confidence_factors_json,
        old.workout_contribution, old.evidence_strength, old.direction_factor,
        old.growth_resistance, old.true_ability_before, old.true_ability_after,
        old.true_ability_delta, old.updated_true_ability, old.explanation_codes_json,
        old.explanation_json, old.assessed_at
      FROM ability_assessments old
      JOIN workout_features fresh ON fresh.feature_run_id = ?
        AND fresh.training_session_id = old.training_session_id
      WHERE old.model_run_id = ? AND old.sequence_number <= ?
      ORDER BY old.sequence_number
    `).run(`assessment:${modelRun.id}`, modelRun.id, modelRun.featureRunId, row.parentModelRunId, row.sequenceNumber);
    this.database.prepare(`
      UPDATE model_runs SET parent_model_run_id = ?, reused_assessment_count = ? WHERE id = ?
    `).run(row.parentModelRunId, row.sequenceNumber + 1, modelRun.id);
    this.database.prepare(`
      INSERT INTO model_checkpoints (
        id, model_run_id, sequence_number, through_at, checkpoint_version,
        model_version, model_config_hash, feature_schema_version, feature_config_hash,
        timezone_identifier, state_json, state_hash
      )
      SELECT ?, ?, sequence_number, through_at, checkpoint_version, model_version,
        model_config_hash, feature_schema_version, feature_config_hash,
        timezone_identifier, state_json, state_hash
      FROM model_checkpoints WHERE model_run_id = ? AND sequence_number = ?
    `).run(
      deterministicId("model_checkpoint", { modelRunId: modelRun.id, sequenceNumber: row.sequenceNumber }),
      modelRun.id, row.parentModelRunId, row.sequenceNumber
    );
    return { parentModelRunId: row.parentModelRunId, throughSequence: row.sequenceNumber, state };
  }

  private writeModelCheckpoint(
    modelRun: ModelRun,
    sequenceNumber: number,
    throughAt: string,
    request: RecomputeRequest,
    state: ModelCheckpointState
  ): void {
    const stateJson = JSON.stringify(state);
    this.database.prepare(`
      INSERT OR REPLACE INTO model_checkpoints (
        id, model_run_id, sequence_number, through_at, checkpoint_version,
        model_version, model_config_hash, feature_schema_version, feature_config_hash,
        timezone_identifier, state_json, state_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deterministicId("model_checkpoint", { modelRunId: modelRun.id, sequenceNumber }),
      modelRun.id, sequenceNumber, throughAt, MODEL_CHECKPOINT_VERSION,
      MODEL_CONFIG_VERSION, modelRun.modelConfigHash, FEATURE_SCHEMA_VERSION,
      configHash(request.featureConfig), request.timezoneIdentifier, stateJson, configHash(state)
    );
  }

  private replayModel(
    jobId: string,
    modelRun: ModelRun,
    features: WorkoutFeatureVector[],
    request: RecomputeRequest
  ): void {
    const sorted = sortWorkoutFeaturesChronologically(features);
    const calibrationFeatures: WorkoutFeatureVector[] = [];
    for (const feature of sorted) {
      if (feature.eligibilityStatus !== "eligible") continue;
      if (request.modelConfig.baselineReferenceStartAt && Date.parse(feature.workoutStartAt)<Date.parse(request.modelConfig.baselineReferenceStartAt)) continue;
      calibrationFeatures.push(feature);
      if (hasCompletedCalibration(calibrationFeatures, request.modelConfig)) break;
    }
    let baseline = hasCompletedCalibration(calibrationFeatures, request.modelConfig)
      ? createPersonalBaseline(calibrationFeatures)
      : null;
    const calibrationIds = new Set(baseline?.calibrationFeatureIds ?? []);
    const calibrationCompletionIndex = baseline
      ? Math.max(
          ...sorted
            .map((feature, index) => (calibrationIds.has(feature.id) ? index : -1))
            .filter((index) => index >= 0)
        )
      : Number.POSITIVE_INFINITY;
    const insert = this.database.prepare(`
      INSERT INTO ability_assessments (
        id, model_run_id, feature_id, training_session_id, sequence_number,
        assessment_status, current_ability, efficiency_score, pace_score,
        cardio_score, stability_score, recovery_score, effective_weights_json,
        confidence, confidence_factors_json, workout_contribution,
        evidence_strength, direction_factor, growth_resistance,
        true_ability_before, true_ability_after, true_ability_delta,
        updated_true_ability, explanation_codes_json, explanation_json, assessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const resume = baseline ? this.resumeModelReplay(modelRun, request, sorted, baseline) : null;
    if (resume) baseline = resume.state.baseline;
    const timeline: TimelineAssessment[] = resume
      ? this.loadTimelineAssessments(modelRun.id)
      : [];
    let trueAbility = resume?.state.trueAbility ?? 50;
    let lastEligibleLocalDate: string | null = resume?.state.lastEligibleLocalDate ?? null;
    let lastEligibleTrueAbility = resume?.state.lastEligibleTrueAbility ?? 50;
    let eligibleWorkoutCount = resume?.state.eligibleWorkoutCount ?? 0;
    // §6.9 confirmation buffer. Carried in the checkpoint on purpose: a resumed
    // replay must not silently re-count or lose an unconfirmed decline.
    let pendingNegativeIds: string[] = [...(resume?.state.pendingNegativeIds ?? [])];
    let lastCheckpointMonth: string | null = resume
      ? localDateAt(sorted[resume.throughSequence]?.workoutStartAt ?? "", request.timezoneIdentifier).slice(0, 7)
      : null;

    // Same bounded evidence window in full replay, checkpoint resume and offline reports.
    const adaptiveBaselines = buildAdaptiveBaselineTimeline(sorted, {
      ...defaultAdaptiveBaselinePolicy,
      minimumIndependentSessions: request.modelConfig.comparabilityPolicy.minimumIndependentSessions,
      minimumSpanDays: request.modelConfig.comparabilityPolicy.minimumSpanDays
    });
    const stratumHistoryByIndex = request.modelConfig.comparabilityHistoryMode === "bounded"
      ? adaptiveBaselines.map((value) => value.history)
      : buildLegacyStratumHistory(sorted);
    const baselineEpochId = this.fitnessEpochId(baseline, features, request, modelRun);

    // O07 步骤 4：能力评估的逐训练写入按分块短事务落地（checkpoint 另算，频率低）。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (const [index, feature] of sorted.entries()) {
      if (resume && index <= resume.throughSequence) continue;
      this.throwIfCancelled(jobId);
      this.gate.yieldIfStale();
      const assessmentId = deterministicId("ability_assessment", {
        modelRunId: modelRun.id,
        trainingSessionId: feature.trainingSessionId
      });
      const featureDate = localDateAt(feature.workoutStartAt, request.timezoneIdentifier);
      let assessment: AbilityAssessment;

      if (feature.eligibilityStatus === "excluded") {
        assessment = this.createCalibrationAssessment(
          assessmentId,
          modelRun.id,
          feature,
          index,
          "excluded",
          ["data_insufficient"]
        );
      } else if (!baseline || index <= calibrationCompletionIndex) {
        assessment = this.createCalibrationAssessment(
          assessmentId,
          modelRun.id,
          feature,
          index,
          "calibrating",
          ["calibrating"]
        );
      } else {
        if (lastEligibleLocalDate !== null) {
          trueAbility = trueAbilityAfterInactivity(
            lastEligibleTrueAbility,
            daysBetween(lastEligibleLocalDate, featureDate)
          );
        }
        const calibrationMaturity = clamp((eligibleWorkoutCount + 1) / 12, 0.25, 1);
        const score = scoreFeature(
          feature,
          baseline,
          calibrationMaturity,
          stratumHistoryByIndex[index] ?? null,
          request.modelConfig
        );
        const update = updateTrueAbilityFromFeatureScore(
          trueAbility,
          eligibleWorkoutCount,
          score,
          request.modelConfig,
          pendingNegativeIds.length
        );
        // Keep the ids in step with the count the scoring layer reported: it either
        // advanced by one (this feature), or reset to zero (applied, or contradicted
        // by a positive). A non-qualifying workout leaves it untouched.
        if (update.pendingNegativeConfirmations === pendingNegativeIds.length + 1) {
          pendingNegativeIds = [...pendingNegativeIds, feature.id];
        } else if (update.pendingNegativeConfirmations === 0) {
          pendingNegativeIds = [];
        }
        const explanationCodes = [...score.explanationCodes];
        // `fatigue_protected_negative_update` is deliberately no longer emitted:
        // the direction factor is no longer conditioned on the recovery score, so
        // nothing here can be "protected by fatigue" any more. The value and its
        // UI label are kept in contracts/web because historical assessments still
        // contain it and must keep rendering.
        const nextTrueAbility = update.nextTrueAbility;
        assessment = {
          id: assessmentId,
          modelRunId: modelRun.id,
          featureId: feature.id,
          trainingSessionId: feature.trainingSessionId,
          sequenceNumber: index,
          assessmentStatus: score.status,
          currentAbility: score.currentAbility,
          dimensions: score.dimensions,
          effectiveWeights: score.effectiveWeights,
          confidence: score.confidence,
          confidenceFactors: score.confidenceFactors,
          workoutContribution: score.workoutContribution,
          evidenceStrength: score.evidenceStrength,
          directionFactor: update.directionFactor,
          growthResistance: update.growthResistance,
          trueAbilityBefore: trueAbility,
          trueAbilityAfter: nextTrueAbility,
          trueAbilityDelta: nextTrueAbility - trueAbility,
          updatedTrueAbility: update.updated,
          explanationCodes: [...new Set(explanationCodes)],
          explanation: {
            featureEligibility: feature.eligibilityStatus,
            missingReasons: feature.missingReasons,
            baselineCalibrationEndAt: baseline.calibrationEndAt,
            baselineEpochId,
            baselinePolicyVersion: BASELINE_POLICY_VERSION,
            comparabilityHistoryMode: request.modelConfig.comparabilityHistoryMode,
            adaptiveBaseline: adaptiveBaselines[index] ?? null,
            confidenceV2: score.confidenceV2,
            stratumComparability: score.stratumComparability,
            learningObservation: score.learningObservation,
            // §6.9: the scoring layer is the only owner of *why* a TA update was
            // refused (it holds the gate); persisting that decision here is what makes
            // the per-reason report possible without re-deriving the thresholds.
            // `null` means the update was applied. JSON column ⇒ no migration.
            refusalReason: update.refusalReason
          },
          assessedAt: feature.workoutStartAt
        };
        trueAbility = nextTrueAbility;
        if (score.status === "eligible") {
          lastEligibleLocalDate = featureDate;
          lastEligibleTrueAbility = trueAbility;
          eligibleWorkoutCount += 1;
        }
      }

      writer.add(() => this.insertAssessment(insert, assessment));
      timeline.push({
        id: assessment.id,
        workoutStartAt: feature.workoutStartAt,
        assessmentStatus: assessment.assessmentStatus,
        trueAbilityAfter: assessment.trueAbilityAfter
      });
      if (baseline) {
        const month = featureDate.slice(0, 7);
        const shouldCheckpoint = index === calibrationCompletionIndex || (index + 1) % 25 === 0 ||
          (lastCheckpointMonth !== null && month !== lastCheckpointMonth) || index === sorted.length - 1;
        if (shouldCheckpoint) {
          this.writeModelCheckpoint(modelRun, index, feature.workoutStartAt, request, {
            baseline,
            trueAbility,
            lastEligibleLocalDate,
            lastEligibleTrueAbility,
            eligibleWorkoutCount,
            pendingNegativeIds
          });
        }
        lastCheckpointMonth = month;
      }
      this.updateJobProgress(jobId, "model_replay", index + 1, sorted.length, "Assessment replayed");
    }
    writer.flush();

    this.writeDailySnapshots(
      modelRun.id,
      timeline,
      request.evaluatedAt,
      request.timezoneIdentifier,
      false
    );
    this.database
      .prepare("UPDATE model_runs SET summary_json = ? WHERE id = ?")
      .run(
        JSON.stringify({
          featureCount: features.length,
          calibrationFeatureCount: baseline?.calibrationFeatureIds.length ?? 0,
          baseline: baseline ?? null
          ,reusedAssessmentCount: resume ? resume.throughSequence + 1 : 0
        }),
        modelRun.id
      );
  }

  private fitnessEpochId(baseline:PersonalBaseline|null, features:WorkoutFeatureVector[], request:RecomputeRequest, model:ModelRun):string|null {
    if (!baseline) return null;
    return semanticHash({policy:BASELINE_POLICY_VERSION,
      calibrationSessions:sortWorkoutFeaturesChronologically(features).filter((f)=>baseline.calibrationFeatureIds.includes(f.id))
        .map((f)=>({trainingSessionId:f.trainingSessionId,workoutStartAt:f.workoutStartAt})),
      // Learning-rate/confidence/history changes do not change score coordinates.
      // Including their config hash here would incorrectly waive regression gates.
      scaleConfig:{weights:request.modelConfig.dimensionWeights,zScale:request.modelConfig.dimensionScoreZScale},
      featureConfigVersion:FEATURE_CONFIG_VERSION,timezone:request.timezoneIdentifier,
      dimensions:{efficiency:baseline.dimensions.efficiency??null,pace:baseline.dimensions.pace??null,stability:baseline.dimensions.stability??null}});
  }

  private sealDomainSnapshots(model: ModelRun, metricRunId: string, features: WorkoutFeatureVector[], request: RecomputeRequest, lineage: ModelLineageV2): void {
    const releases = new SqliteModelReleaseRepository(this.database);
    const asOf=request.evaluatedAt;
    const put=(domain:string,payload:unknown)=>releases.putSnapshot(model.id,domain,"summary",asOf,payload);
    const assessments=this.database.prepare("SELECT * FROM ability_assessments WHERE model_run_id=? ORDER BY sequence_number").all(model.id);
    put("fitness",{lineage,assessments,daily:this.database.prepare("SELECT local_date,true_ability,snapshot_status FROM daily_ability_snapshots WHERE model_run_id=? ORDER BY local_date").all(model.id)});
    put("readiness",readinessForRun(this.facts,lineage));
    put("load",{lineage:{...lineage,modelVersion:"rai-training-load-v2.0.0",configVersion:TRAINING_LOAD_CONFIG_VERSION,configHash:semanticHash({config:defaultDailyMetricConfig,version:TRAINING_LOAD_CONFIG_VERSION}),baselineEpochId:null,calibrationCohortHash:null},days:this.database.prepare("SELECT * FROM daily_training_metrics WHERE training_metric_run_id=? ORDER BY local_date").all(metricRunId)});
    put("zones",{lineage:{...lineage,modelVersion:"rai-training-zones-v2.0.0",configVersion:TRAINING_ZONE_CONFIG_VERSION,configHash:semanticHash({version:TRAINING_ZONE_CONFIG_VERSION,physiology:"rai-physiology-v1.8.0"}),baselineEpochId:null,calibrationCohortHash:null},profiles:this.database.prepare("SELECT * FROM daily_zone_profiles WHERE training_metric_run_id=? ORDER BY local_date").all(metricRunId)});
    const cutoff=Date.parse(asOf)-56*86400000;
    const preparation=assessPreparation(features.filter((f)=>f.eligibilityStatus!=="excluded" && (f.distanceKm??0)>0 && Date.parse(f.workoutStartAt)>=cutoff)
      .map((f)=>({observedAt:f.workoutStartAt,distanceKm:f.distanceKm!,durationSeconds:f.durationSeconds})),asOf);
    const lateRuns=features.flatMap((feature)=>{
      const payload=feature.provenance.featurePayloadV4 as WorkoutFeaturePayloadV4|undefined;
      if(!payload||feature.eligibilityStatus!=="eligible"||Date.parse(feature.workoutStartAt)<cutoff||
        !["easy","steady","long_run"].includes(feature.sessionType)||feature.durationSeconds<75*60||
        payload.execution.aerobicDecouplingPct===null)return [];
      return [{trainingSessionId:feature.trainingSessionId,asOf:feature.workoutStartAt,
        rawDecouplingPct:payload.execution.aerobicDecouplingPct,pairedCoverage:payload.execution.pairedCoverage,
        normalizationStatus:payload.normalization.status}];
    });
    const comparableCount=lateRuns.filter((row)=>row.normalizationStatus==="not_needed"||row.normalizationStatus==="applied").length;
    const durability=assessDurability({lateRunStability:null,matchedPerformanceEvidence:null,lateRunEvidenceCount:comparableCount,evidenceTargetCount:2});
    const domainLineage={...lineage,modelVersion:DURABILITY_MODEL_VERSION,configVersion:"rai-preparation-config-v1",
      configHash:semanticHash({targets:PREPARATION_TARGETS,windowDays:PREPARATION_WINDOW_DAYS,penalty:"disabled_until_calibrated"}),baselineEpochId:null,calibrationCohortHash:null};
    put("durability",["five_k","ten_k","half_marathon"].map((distance)=>({
      ...buildDurabilitySnapshot({distance:distance as "five_k"|"ten_k"|"half_marathon",preparation,durability,lineage:domainLineage}),
      rawLateRunEvidence:lateRuns,validationStatus:"not_empirically_calibrated"
    })));

  }

  private createCalibrationAssessment(
    id: string,
    modelRunId: string,
    feature: WorkoutFeatureVector,
    sequenceNumber: number,
    status: "excluded" | "calibrating",
    explanationCodes: AbilityAssessment["explanationCodes"]
  ): AbilityAssessment {
    return {
      id,
      modelRunId,
      featureId: feature.id,
      trainingSessionId: feature.trainingSessionId,
      sequenceNumber,
      assessmentStatus: status,
      currentAbility: null,
      dimensions: { efficiency: null, pace: null, cardio: null, stability: null, recovery: null },
      effectiveWeights: {},
      confidence: feature.qualityScore,
      confidenceFactors: {
        coverage: feature.qualityScore,
        source: feature.sourceConfidence,
        comparability: 0,
        maturity: 0
      },
      workoutContribution: null,
      evidenceStrength: null,
      directionFactor: null,
      growthResistance: null,
      trueAbilityBefore: null,
      trueAbilityAfter: null,
      trueAbilityDelta: null,
      updatedTrueAbility: false,
      explanationCodes,
      explanation: { featureEligibility: feature.eligibilityStatus, missingReasons: feature.missingReasons },
      assessedAt: feature.workoutStartAt
    };
  }

  private insertAssessment(
    insert: ReturnType<DatabaseSync["prepare"]>,
    assessment: AbilityAssessment
  ): void {
    insert.run(
      assessment.id,
      assessment.modelRunId,
      assessment.featureId,
      assessment.trainingSessionId,
      assessment.sequenceNumber,
      assessment.assessmentStatus,
      assessment.currentAbility,
      assessment.dimensions.efficiency,
      assessment.dimensions.pace,
      assessment.dimensions.cardio,
      assessment.dimensions.stability,
      assessment.dimensions.recovery,
      JSON.stringify(assessment.effectiveWeights),
      assessment.confidence,
      JSON.stringify(assessment.confidenceFactors),
      assessment.workoutContribution,
      assessment.evidenceStrength,
      assessment.directionFactor,
      assessment.growthResistance,
      assessment.trueAbilityBefore,
      assessment.trueAbilityAfter,
      assessment.trueAbilityDelta,
      assessment.updatedTrueAbility ? 1 : 0,
      JSON.stringify(assessment.explanationCodes),
      JSON.stringify(assessment.explanation),
      assessment.assessedAt
    );
  }

  private loadTimelineAssessments(modelRunId: string): TimelineAssessment[] {
    return this.database
      .prepare(`
        SELECT
          assessment.id,
          feature.workout_start_at AS workoutStartAt,
          assessment.assessment_status AS assessmentStatus,
          assessment.true_ability_after AS trueAbilityAfter
        FROM ability_assessments assessment
        JOIN workout_features feature ON feature.id = assessment.feature_id
        WHERE assessment.model_run_id = ?
        ORDER BY assessment.sequence_number
      `)
      .all(modelRunId) as unknown as TimelineAssessment[];
  }

  private writeDailySnapshots(
    modelRunId: string,
    timeline: TimelineAssessment[],
    evaluatedAt: string,
    timezoneIdentifier: string,
    ignoreExisting: boolean
  ): void {
    const first = timeline[0];
    if (!first) return;
    const startDate = localDateAt(first.workoutStartAt, timezoneIdentifier);
    const endDate = localDateAt(evaluatedAt, timezoneIdentifier);
    const byDate = new Map<string, TimelineAssessment[]>();
    for (const assessment of timeline) {
      const date = localDateAt(assessment.workoutStartAt, timezoneIdentifier);
      const current = byDate.get(date) ?? [];
      current.push(assessment);
      byDate.set(date, current);
    }
    const insert = this.database.prepare(`
      INSERT ${ignoreExisting ? "OR IGNORE" : ""} INTO daily_ability_snapshots (
        id, model_run_id, local_date, timezone_identifier, true_ability,
        decay_points, growth_velocity_per_week, last_assessment_id,
        snapshot_status, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const snapshots: DailyAbilitySnapshot[] = [];
    let currentAbility: number | null = null;
    let lastEligibleDate: string | null = null;
    let lastEligibleAbility: number | null = null;
    let lastAssessmentId: string | null = null;

    // O07 步骤 4：逐日快照按分块短事务落地（`snapshots` 仍在循环内即时累积，`lastEligible*`
    // 的推进依赖它，所以只有写本身进批）。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
      this.gate.yieldIfStale();
      for (const assessment of byDate.get(date) ?? []) {
        lastAssessmentId = assessment.id;
        if (assessment.trueAbilityAfter !== null) currentAbility = assessment.trueAbilityAfter;
        if (assessment.assessmentStatus === "eligible" && assessment.trueAbilityAfter !== null) {
          lastEligibleDate = date;
          lastEligibleAbility = assessment.trueAbilityAfter;
        }
      }
      let decayPoints = 0;
      if (currentAbility !== null && lastEligibleDate !== null && lastEligibleAbility !== null) {
        const days = daysBetween(lastEligibleDate, date);
        const decayed = trueAbilityAfterInactivity(lastEligibleAbility, days);
        decayPoints = inactivityDecay(days);
        currentAbility = decayed;
      }
      const priorValues = snapshots
        .slice(-27)
        .map((snapshot) => snapshot.trueAbility)
        .filter((value): value is number => value !== null);
      const growthVelocity = this.theilSenVelocity([...priorValues, ...(currentAbility === null ? [] : [currentAbility])]);
      const snapshot: DailyAbilitySnapshot = {
        id: deterministicId("daily_snapshot", { modelRunId, date }),
        modelRunId,
        localDate: date,
        timezoneIdentifier,
        trueAbility: currentAbility,
        decayPoints,
        growthVelocityPerWeek: growthVelocity,
        lastAssessmentId,
        snapshotStatus:
          currentAbility === null ? "calibrating" : decayPoints > 0 ? "decay" : "active",
        computedAt: evaluatedAt
      };
      writer.add(() => insert.run(
        snapshot.id,
        snapshot.modelRunId,
        snapshot.localDate,
        snapshot.timezoneIdentifier,
        snapshot.trueAbility,
        snapshot.decayPoints,
        snapshot.growthVelocityPerWeek,
        snapshot.lastAssessmentId,
        snapshot.snapshotStatus,
        snapshot.computedAt
      ));
      snapshots.push(snapshot);
    }
    writer.flush();
  }

  private theilSenVelocity(values: number[]): number | null {
    if (values.length < 3) return null;
    const slopes: number[] = [];
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        const leftValue = values[left];
        const rightValue = values[right];
        if (leftValue !== undefined && rightValue !== undefined) {
          slopes.push((rightValue - leftValue) / (right - left));
        }
      }
    }
    const slope = median(slopes);
    return slope === null ? null : slope * 7;
  }

  private activateModelRunAndCompleteJob(jobId: string, modelRunId: string, featureCount: number): void {
    const completed = this.jobs.complete(
      jobId,
      "completed",
      featureCount,
      featureCount,
      "Model run activated",
      () => {
        // 🔴 绑定必须**先于** `activateSucceeded` 落库：发布短事务里的 `verifyAndPoint`
        // 要读它来做依赖级判据（决策 D4）。两者在同一个事务里，所以候选一旦激活，
        // "它算的是哪一版输入"就已经是持久事实 —— 不会出现"指针动了、绑定没写"。
        this.writeAnalysisInputBinding(modelRunId);
        this.modelRuns.activateSucceeded(modelRunId, appNow());
        // CA/feature rebuild changes residual baselines; drop active CatBoost until retrain.
        this.modelRuns.clearActivePredictionModel();
      }
    );
    if (!completed) throw new Error("Task cancellation requested");
    // Runs after the activation commits. Retiring superseded runs is
    // housekeeping, so it must never be able to roll back or fail a recompute
    // that already succeeded.
    this.pruneSupersededRuns();
  }

  /**
   * 写下"这条发布算了哪一版输入"（O06-A / WP-22）与**执行覆盖证据**（R02，v44）。
   *
   * 非直连任务（CLI `full_recompute`）没有捕获过绑定 ⇒ 不写行，行为与以前逐字节相同；
   * 老 release 因此没有绑定行，`verifyAndPoint` 会走**显式**的 legacy 严格分支。
   *
   * ⛔ 调用点必须在发布事务里（`complete()` 的 `beforeComplete`）——它记录的是
   * "与指针翻转同一时刻的输入"，写到事务外就等于两件事各说各话。
   */
  private writeAnalysisInputBinding(modelRunId: string): void {
    const capture = this.pendingInputCapture;
    if (capture === null) return;
    const binding = capture.binding;
    // 执行覆盖证据（R02 + B04）：计划**实际覆盖**的范围，**版本化**。
    // 旧形态用 SQL NULL 表示"全量重算"，与"v44 之前的绑定行没有证据"撞成同一种形状 ——
    // 结算方只能退回最宽松的判据。现在每次捕获都写一份 `{version:1, mode}`：
    // `rebuild` 明确覆盖一切，`partial` 带逐域真实边界；NULL 只剩"旧行缺证据"一种含义。
    const executedPlanJson = JSON.stringify(capture.executedPlan);
    this.database.prepare(`
      INSERT INTO analysis_run_input_bindings (
        run_id, job_id, scope, dataset_version, captured_raw_generation,
        captured_dependency_generation, target_raw_generation, target_dependency_generation,
        incumbent_release_id, timezone_identifier, override_digest, config_digest,
        cutoff_at, input_digest, created_at, executed_plan_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        job_id = excluded.job_id, scope = excluded.scope, dataset_version = excluded.dataset_version,
        captured_raw_generation = excluded.captured_raw_generation,
        captured_dependency_generation = excluded.captured_dependency_generation,
        target_raw_generation = excluded.target_raw_generation,
        target_dependency_generation = excluded.target_dependency_generation,
        incumbent_release_id = excluded.incumbent_release_id,
        timezone_identifier = excluded.timezone_identifier,
        override_digest = excluded.override_digest, config_digest = excluded.config_digest,
        cutoff_at = excluded.cutoff_at, input_digest = excluded.input_digest,
        executed_plan_json = excluded.executed_plan_json
    `).run(
      modelRunId, binding.jobId, binding.scope, binding.datasetVersion,
      binding.capturedRawGeneration, binding.capturedDependencyGeneration,
      binding.targetRawGeneration, binding.targetDependencyGeneration,
      binding.incumbentReleaseId, binding.timezoneIdentifier,
      binding.overrideDigest, binding.configDigest, binding.cutoffAt,
      binding.inputDigest, binding.createdAt, executedPlanJson
    );
    // 覆盖记录：这条任务把哪些导入批次算进去了（含捕获代次前进时并进来的那些）。
    // R02 之后这是**执行覆盖批次** = required ∪ 登记批次 —— 结算方不再改写这张表，
    // 它只核验"并集 ⊆ 这里"（见 `settleCoveredJobs`）。
    const jobId = binding.jobId;
    const from = binding.targetDependencyGeneration ?? binding.capturedDependencyGeneration;
    for (const batchId of capture.mergedBatchIds) {
      this.database.prepare(`
        INSERT INTO analysis_job_coverage (
          job_id, import_batch_id, dependency_generation_from, dependency_generation_to
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(job_id, import_batch_id) DO UPDATE SET
          dependency_generation_from = excluded.dependency_generation_from,
          dependency_generation_to = excluded.dependency_generation_to
      `).run(jobId, batchId, from, binding.capturedDependencyGeneration);
    }
  }

  private pruneSupersededRuns(): void {
    if (SUPERSEDED_RUN_RETENTION <= 0) return;
    try {
      new SqliteModelReleaseRepository(this.database).retireOldReleases(SUPERSEDED_RUN_RETENTION);
      this.gate.scope(() => this.store.pruneSupersededModelRuns({ keepRecent: SUPERSEDED_RUN_RETENTION }));
    } catch (error) {
      process.stderr.write(
        `Superseded run prune skipped: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  private throwIfCancelled(jobId: string): void {
    if (this.jobs.cancelIfRequested(jobId)) throw new Error("Task cancellation requested");
  }

  private setJobRunIds(jobId: string, featureRunId: string | null, modelRunId: string | null): void {
    this.jobs.setRunIds(jobId, featureRunId, modelRunId);
  }

  private updateJobProgress(
    jobId: string,
    phase: string,
    current: number,
    total: number,
    message: string
  ): void {
    if (!this.progressGate.shouldPublish(jobId, phase, current, total)) return;
    this.jobs.updateProgress(jobId, phase, current, total, message);
  }

  private measureCompute<T>(jobId: string, stage: string, operation: () => T): T {
    const started = performance.now();
    // 步骤 5：每个计算阶段开工前先核对依赖绑定未变（分段模式一变就抛 drift ⇒ 候选作废）。
    this.assertPinnedStage(jobId, stage);
    try { return operation(); }
    finally {
      const metrics = {
        stage, durationMs: performance.now() - started,
        processMaxRssKiB: process.resourceUsage().maxRSS,
        recordCacheHits: this.recordCache.hits, recordCacheMisses: this.recordCache.misses
      };
      this.jobs.logEvent(jobId, "performance", 0, 0, JSON.stringify(metrics));
      if (process.send && process.connected) process.send({ type: "rai:compute-performance", ...metrics }, () => {});
    }
  }

  private completeJob(
    jobId: string,
    phase: string,
    current: number,
    total: number,
    message: string
  ): void {
    if (!this.jobs.complete(jobId, phase, current, total, message)) {
      throw new Error("Task cancellation requested");
    }
  }

  private errorPayload(error: unknown): Record<string, unknown> {
    return {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error"
    };
  }

  private isCancellationError(error: unknown): boolean {
    return error instanceof Error && error.message === "Task cancellation requested";
  }
}
