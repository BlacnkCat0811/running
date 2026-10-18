import type { DatabaseSync } from "node:sqlite";
import { sessionFactPresentConditionSql, workoutPresentConditionSql } from "../sql/fragments.js";

import type { PerformanceProtocol, SessionType, StimulusType, WorkoutTrainingLoad } from "@rai/contracts";

import { nullableNumber, paceSeconds, parseJson } from "./read-utils.js";
import { readHealthRecordOverlap } from "./health-record-overlap-reads.js";
import { SqliteRoutePointReader } from "./route-point-reader.js";

const rawAverageMetricTypes = new Set([
  "HKQuantityTypeIdentifierRunningPower",
  "HKQuantityTypeIdentifierRunningStrideLength",
  "HKQuantityTypeIdentifierRunningVerticalOscillation",
  "HKQuantityTypeIdentifierRunningGroundContactTime"
]);

export interface StoredWorkoutOverride {
  revision: number;
  eligibilityOverride: "include" | "exclude" | null;
  statisticsParticipation: "include" | "exclude" | null;
  sessionType: string | null;
  performanceProtocol: PerformanceProtocol | null;
  rpe: number | null;
  conditionTags: string[];
  note: string | null;
  createdAt: string;
}

export interface WorkoutListFilterQuery {
  limit: number;
  offset: number;
  status?: string;
  sessionType?: string;
  stimulusType?: string;
  participation?: string;
  environment?: string;
  days?: number;
  startedFrom?: string;
  startedBefore?: string;
  sourceGroup?: string;
  confidence?: string;
  route?: string;
}

/**
 * 读侧可见性（P0-1，2026-10-18 同步诊断）。
 *
 * `pending` = 事实（workout/session/records）已提交、派生分析尚未发布。
 * 这一行必须可读：2026-10-18 生产实测里，事实提交到分析发布之间差了 102.5 s，
 * 旧读侧用 `INNER JOIN active_ability_assessments` 把这段窗口呈现成 404 ——
 * 与"这条训练不存在"完全同形。
 */
export type StoredAnalysisPublishStatus = "pending" | "published";

export interface StoredWorkoutListItem {
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
  /** 可见性状态；`pending` 时上面的派生字段为 null/占位（见 `data.ts` 的映射）。 */
  analysisPublishStatus: StoredAnalysisPublishStatus;
}

export interface StoredWorkoutDetailRow {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  distanceKm: number | null;
  averageHeartRateBpm: number | null;
  indoor: boolean | null;
  sourceCategory: string;
  sessionType: string;
  eligibilityStatus: string;
  assessmentStatus: string | null;
  /** 可见性状态；`pending` 时 `modelVersion` 等派生字段是占位值。 */
  analysisPublishStatus: StoredAnalysisPublishStatus;
  missingReasons: string[];
  qualityScore: number;
  currentAbility: number | null;
  confidence: number | null;
  trueAbilityDelta: number | null;
  hasRoute: boolean;
  canonicalWorkoutId: string;
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
  dimensions: {
    efficiency: number | null;
    pace: number | null;
    cardio: number | null;
    stability: number | null;
    recovery: number | null;
  };
}

export interface WorkoutListSqlFilter {
  where: string;
  params: Array<string | number>;
}

/** `freshness.series[]` 的一行（P0-3）：与 `/series` 同口径的窗口内样本数。 */
export interface StoredWorkoutFreshnessMetric {
  /** 逻辑指标名（heartRate/speed/power/cadence/strideLength/verticalOscillation/groundContactTime/elevation）。 */
  metric: string;
  samples: number;
  /**
   * P2-2：该指标最近一次被服务端接收的时刻（`health_records.available_at`）。
   * 旧库/尚未迁移（v46 之前）时为 `null` —— 那是诚实的"不知道"，不是"从未到达"。
   */
  lastAvailableAt: string | null;
}

export interface StoredWorkoutFreshness {
  sessionId: string;
  /** workout 实体第一次被提交的批次完成时刻；`null` = 旧库/异常，没有到达证据。 */
  committedAt: string | null;
  /** 最近一次把本训练窗口事实写入服务端的批次完成时刻。 */
  lastBatchAt: string | null;
  /** 触及本训练的批次数（workout 实体 + 窗口内记录）。 */
  batches: number;
  analysis: {
    status: StoredAnalysisPublishStatus | "failed";
    /** 触发本训练分析的 recompute job id；无关联任务时为 `null`。 */
    jobId: string | null;
    /** 分析发布（active model run 激活）时刻；未发布为 `null`。 */
    publishedAt: string | null;
  };
  metrics: StoredWorkoutFreshnessMetric[];
}

/** 同步覆盖探测的一行（P1-1）：某个记录类型在服务端已知的覆盖区间。 */
export interface StoredSyncCoverageType {
  type: string;
  knownFrom: string | null;
  knownUntil: string | null;
  sampleCount: number;
}

/**
 * 指标 → HealthKit 记录类型。**顺序就是响应顺序**，`elevation` 例外（它不是
 * `health_records` 行，而是路线点数，放在数组末尾由 {@link samples} 单独取）。
 *
 * 🔴 这七个类型与 `apps/api/src/data.ts` 的 `workoutSeries()` 逐项对应：
 * freshness 回答"该指标到齐没有"，用的必须是 `/series` 的同一批记录类型，
 * 否则会出现"freshness 说 power 没到、series 里却有 5 个点"这种互相打脸的响应。
 */
const freshnessMetricTypes = [
  ["heartRate", "HKQuantityTypeIdentifierHeartRate"],
  ["speed", "HKQuantityTypeIdentifierRunningSpeed"],
  ["power", "HKQuantityTypeIdentifierRunningPower"],
  ["cadence", "HKQuantityTypeIdentifierStepCount"],
  ["strideLength", "HKQuantityTypeIdentifierRunningStrideLength"],
  ["verticalOscillation", "HKQuantityTypeIdentifierRunningVerticalOscillation"],
  ["groundContactTime", "HKQuantityTypeIdentifierRunningGroundContactTime"]
] as const;

/**
 * 距离/心率的**事实侧兜底**（P0-1）。
 *
 * 派生分析未发布时 `workout_features` 还没有这一行，但 `workout_statistics` 是
 * 同事务落库的原始事实 ⇒ 列表/详情可以用它给出距离与平均心率。
 * 单位换算与 v2 迁移的 `anchor_distance_km` 同源（km/m/mi），口径漂移会让同一个
 * 数字在两个入口上不一致。没有统计行 ⇒ `NULL`（契约允许，**不编造**）。
 */
const statisticDistanceSql = (workoutAlias: string): string => `(
  SELECT CASE stat.unit
    WHEN 'km' THEN stat.sum_value
    WHEN 'm' THEN stat.sum_value / 1000.0
    WHEN 'mi' THEN stat.sum_value * 1.609344
    ELSE stat.sum_value END
  FROM workout_statistics stat
  WHERE stat.workout_id = ${workoutAlias}.id
    AND stat.type = 'HKQuantityTypeIdentifierDistanceWalkingRunning'
  ORDER BY stat.ordinal
  LIMIT 1)`;

const statisticAverageHeartRateSql = (workoutAlias: string): string => `(
  SELECT stat.average_value
  FROM workout_statistics stat
  WHERE stat.workout_id = ${workoutAlias}.id
    AND stat.type = 'HKQuantityTypeIdentifierHeartRate'
  ORDER BY stat.ordinal
  LIMIT 1)`;

/**
 * 事实侧的"这次训练从什么时候开始"。
 *
 * 三档兜底：已发布特征（冻结的输入时刻）→ 原始 workout 行 → 会话锚点。
 * 🔴 排序、`days` 窗口与 `latestWorkoutStartAt()` 必须用**同一个表达式**：
 * 2026-10-18 的缺陷就是"列表按已发布特征排序、days 按已发布特征取最新"，
 * 于是一条 pending 训练既进不了窗口、也排不到前面。
 */
const factWorkoutStartSql = (featureAlias: string | null, workoutAlias: string, sessionAlias: string): string =>
  `COALESCE(${featureAlias === null ? "" : `${featureAlias}.workout_start_at, `}${workoutAlias}.start_at, ${sessionAlias}.anchor_start_at)`;

const factWorkoutEndSql = (workoutAlias: string, sessionAlias: string): string =>
  `COALESCE(${sessionAlias}.anchor_end_at, ${workoutAlias}.end_at)`;

const factDurationSql = (featureAlias: string | null, workoutAlias: string, sessionAlias: string): string =>
  `COALESCE(${featureAlias === null ? "" : `${featureAlias}.duration_seconds, `}${workoutAlias}.duration_seconds,
    MAX(0, (julianday(${factWorkoutEndSql(workoutAlias, sessionAlias)}) - julianday(${factWorkoutStartSql(featureAlias, workoutAlias, sessionAlias)})) * 86400))`;

const factDistanceSql = (featureAlias: string | null, workoutAlias: string, sessionAlias: string): string =>
  `COALESCE(${featureAlias === null ? "" : `${featureAlias}.distance_km, `}${sessionAlias}.anchor_distance_km,
    ${statisticDistanceSql(workoutAlias)})`;

const factAverageHeartRateSql = (featureAlias: string | null, workoutAlias: string): string =>
  `COALESCE(${featureAlias === null ? "" : `${featureAlias}.average_heart_rate_bpm, `}
    ${statisticAverageHeartRateSql(workoutAlias)})`;

export class SqliteWorkoutReadRepository {
  /** 路线点只有这一个入口（视图 + 唯一判据），见 `read/route-point-reader.ts`。 */
  private readonly routePointReader: SqliteRoutePointReader;

  constructor(private readonly database: DatabaseSync) {
    this.routePointReader = new SqliteRoutePointReader(database);
  }

  latestWorkoutStartAt(): string | null {
    // 2026-10-18（P0-1）：`days` 窗口的锚点必须来自**事实侧**。
    // 旧实现取 `active_ability_assessments ⋈ workout_features` 的最大起点 ——
    // 一条事实已提交、分析未发布的训练不在其中，于是"最近一次训练"停留在旧值，
    // 这条新训练连 days=28 的窗口都进不去（即使列表门已经放开）。
    const latest = this.database
      .prepare(`
        SELECT MAX(COALESCE(w.start_at, ts.anchor_start_at)) AS value
        FROM training_sessions ts
        JOIN workouts w ON w.id = ts.canonical_workout_id AND ${workoutPresentConditionSql("w")}
      `)
      .get() as Record<string, unknown>;
    return typeof latest.value === "string" ? latest.value : null;
  }

  buildListFilter(query: Omit<WorkoutListFilterQuery, "limit" | "offset">): WorkoutListSqlFilter {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    // 时间窗口用事实侧起点（与 `list` 的排序/`latestWorkoutStartAt` 同一个表达式）：
    // 带时间窗过滤时 pending 行必须按它的真实开始时间参与，而不是被 `f.workout_start_at IS NULL` 排除。
    const factStart = factWorkoutStartSql("f", "w", "ts");
    if (query.startedFrom) { clauses.push(`julianday(${factStart}) >= julianday(?)`); params.push(query.startedFrom); }
    if (query.startedBefore) { clauses.push(`julianday(${factStart}) < julianday(?)`); params.push(query.startedBefore); }
    if (query.status) {
      clauses.push("f.eligibility_status = ?");
      params.push(query.status);
    }
    if (query.sessionType) {
      clauses.push("f.session_type = ?");
      params.push(query.sessionType);
    }
    if (query.stimulusType) {
      clauses.push("COALESCE(zs.stimulus_type, 'unclassified') = ?");
      params.push(query.stimulusType);
    }
    if (query.participation === "included") clauses.push("f.eligibility_status = 'eligible'");
    if (query.participation === "not_included") clauses.push("f.eligibility_status <> 'eligible'");
    if (query.environment === "outdoor") clauses.push("w.indoor = 0");
    if (query.environment === "indoor") clauses.push("w.indoor = 1");
    if (query.environment === "unknown") clauses.push("w.indoor IS NULL");
    if (query.sourceGroup === "apple_watch") clauses.push("w.source_category = 'apple_watch'");
    if (query.sourceGroup === "third_party") {
      clauses.push("w.source_category NOT IN ('apple_watch', 'manual', 'unknown')");
    }
    if (query.sourceGroup === "manual") clauses.push("w.source_category = 'manual'");
    if (query.confidence === "high") clauses.push("a.confidence >= 0.8");
    if (query.confidence === "medium") clauses.push("a.confidence >= 0.6 AND a.confidence < 0.8");
    if (query.confidence === "low") clauses.push("a.confidence < 0.6");
    if (query.route === "available") {
      clauses.push(
        "EXISTS (SELECT 1 FROM workout_routes filter_route WHERE filter_route.workout_id = w.id AND filter_route.point_count > 0)"
      );
    }
    if (query.route === "missing") {
      clauses.push(
        "NOT EXISTS (SELECT 1 FROM workout_routes filter_route WHERE filter_route.workout_id = w.id AND filter_route.point_count > 0)"
      );
    }
    if (query.days && query.days > 0) {
      const latest = this.latestWorkoutStartAt();
      if (latest) {
        const cutoff = new Date(latest);
        cutoff.setUTCDate(cutoff.getUTCDate() - query.days + 1);
        clauses.push(`julianday(${factStart}) >= julianday(?)`);
        params.push(cutoff.toISOString());
      }
    }
    return {
      where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      params
    };
  }

  count(where: string, params: Array<string | number>): number {
    // 2026-10-18（P0-1）：**事实驱动**。旧实现以 `active_ability_assessments` 为驱动表，
    // 事实已提交但分析未发布时整条训练不在总数里；现在以 `training_sessions` 驱动、
    // 分析侧 LEFT JOIN，pending 行计入（派生字段由 `mapListItem` 填占位值）。
    const count = this.database
      .prepare(`
        SELECT COUNT(*) AS total
        FROM training_sessions ts
        JOIN workouts w ON w.id = ts.canonical_workout_id AND ${workoutPresentConditionSql("w")}
        LEFT JOIN active_ability_assessments a ON a.training_session_id = ts.id
        LEFT JOIN workout_features f ON f.id = a.feature_id
        LEFT JOIN active_workout_zone_summaries zs ON zs.training_session_id = ts.id
        ${where}
      `)
      .get(...params) as Record<string, unknown>;
    return Number(count.total ?? 0);
  }

  list(where: string, params: Array<string | number>, limit: number, offset: number): StoredWorkoutListItem[] {
    const rows = this.database
      .prepare(`
        SELECT
          ts.id AS session_id,
          ${factWorkoutStartSql("f", "w", "ts")} AS workout_start_at,
          ${factWorkoutEndSql("w", "ts")} AS anchor_end_at,
          ${factDurationSql("f", "w", "ts")} AS duration_seconds,
          ${factDistanceSql("f", "w", "ts")} AS distance_km,
          ${factAverageHeartRateSql("f", "w")} AS average_heart_rate_bpm,
          f.missing_reasons_json,
          COALESCE(f.session_type, 'unclassified') AS session_type,
          COALESCE(zs.stimulus_type, 'unclassified') AS stimulus_type,
          zs.stimulus_confidence,
          COALESCE(f.eligibility_status, 'pending') AS eligibility_status,
          COALESCE(f.quality_score, 0) AS quality_score,
          w.indoor,
          w.source_category,
          a.assessment_status,
          a.current_ability,
          a.confidence,
          a.true_ability_delta,
          (a.id IS NOT NULL) AS analysis_published,
          EXISTS (
            SELECT 1
            FROM workout_routes wr
            WHERE wr.workout_id = w.id AND wr.point_count > 0
          ) AS has_route
        FROM training_sessions ts
        JOIN workouts w ON w.id = ts.canonical_workout_id AND ${workoutPresentConditionSql("w")}
        LEFT JOIN active_ability_assessments a ON a.training_session_id = ts.id
        LEFT JOIN workout_features f ON f.id = a.feature_id
        LEFT JOIN active_workout_zone_summaries zs ON zs.training_session_id = ts.id
        ${where}
        ORDER BY ${factWorkoutStartSql("f", "w", "ts")} DESC, ts.id ASC
        LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return rows.map(mapListItem);
  }

  listByQuery(query: WorkoutListFilterQuery): { items: StoredWorkoutListItem[]; total: number } {
    const filter = this.buildListFilter(query);
    return {
      items: this.list(filter.where, filter.params, query.limit, query.offset),
      total: this.count(filter.where, filter.params)
    };
  }

  getDetailRow(trainingSessionId: string): StoredWorkoutDetailRow | null {
    // 2026-10-18（P0-1）：详情同样改为**事实驱动 + 分析侧 LEFT JOIN**。
    // 旧实现 `JOIN active_ability_assessments` ⇒ 事实已提交、分析未发布时返回 `null`
    // ⇒ `/v1/workouts/:id` 回 404，与"这条训练不存在"完全同形（生产 102.5 s 窗口）。
    //
    // 派生字段在未发布时取**占位值**（`modelVersion ''`、`qualityScore 0` 等），
    // 由 `data.ts` 的 `workout()` 连同 `analysisPublishStatus: "pending"` 一起解释；
    // 事实侧能给出的（开始/结束/时长/距离/心率）走 {@link factWorkoutStartSql} 一族的兜底，
    // 没有任何证据的量仍是 `null`（不编造）。
    const row = this.database
      .prepare(`
        SELECT
          ts.id AS session_id,
          ${factWorkoutStartSql("f", "w", "ts")} AS workout_start_at,
          ${factWorkoutEndSql("w", "ts")} AS anchor_end_at,
          ${factDurationSql("f", "w", "ts")} AS duration_seconds,
          ${factDistanceSql("f", "w", "ts")} AS distance_km,
          ${factAverageHeartRateSql("f", "w")} AS average_heart_rate_bpm,
          ts.canonical_workout_id,
          w.indoor,
          w.source_category,
          f.missing_reasons_json,
          COALESCE(f.session_type, 'unclassified') AS session_type,
          COALESCE(f.eligibility_status, 'pending') AS eligibility_status,
          COALESCE(f.quality_score, 0) AS quality_score,
          COALESCE(f.heart_rate_sample_count, 0) AS heart_rate_sample_count,
          f.heart_rate_coverage,
          COALESCE(f.route_point_count, 0) AS route_point_count,
          f.route_quality,
          COALESCE(f.source_confidence, 0) AS source_confidence,
          COALESCE(mr.model_version, '') AS model_version,
          a.assessment_status,
          a.current_ability,
          a.efficiency_score,
          a.pace_score,
          a.cardio_score,
          a.stability_score,
          a.recovery_score,
          a.confidence,
          a.true_ability_before,
          a.true_ability_after,
          a.true_ability_delta,
          a.workout_contribution,
          COALESCE(a.updated_true_ability, 0) AS updated_true_ability,
          a.effective_weights_json,
          a.confidence_factors_json,
          a.explanation_codes_json,
          a.explanation_json,
          (a.id IS NOT NULL) AS analysis_published,
          EXISTS (
            SELECT 1 FROM workout_routes wr
            WHERE wr.workout_id = w.id AND wr.point_count > 0
          ) AS has_route
        FROM training_sessions ts
        JOIN workouts w ON w.id = ts.canonical_workout_id AND ${workoutPresentConditionSql("w")}
        LEFT JOIN active_ability_assessments a ON a.training_session_id = ts.id
        LEFT JOIN workout_features f ON f.id = a.feature_id
        LEFT JOIN model_runs mr ON mr.id = a.model_run_id
        WHERE ts.id = ?
      `)
      .get(trainingSessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      startedAt: String(row.workout_start_at),
      endedAt: String(row.anchor_end_at),
      durationSeconds: Number(row.duration_seconds ?? 0),
      distanceKm: nullableNumber(row.distance_km),
      averageHeartRateBpm: nullableNumber(row.average_heart_rate_bpm),
      indoor: row.indoor === null ? null : Number(row.indoor) === 1,
      sourceCategory: String(row.source_category),
      sessionType: String(row.session_type),
      eligibilityStatus: String(row.eligibility_status),
      analysisPublishStatus: Number(row.analysis_published) === 1 ? "published" : "pending",
      assessmentStatus: typeof row.assessment_status === "string" ? row.assessment_status : null,
      missingReasons: parseJson<string[]>(row.missing_reasons_json, []),
      qualityScore: Number(row.quality_score ?? 0),
      currentAbility: nullableNumber(row.current_ability),
      confidence: nullableNumber(row.confidence),
      trueAbilityDelta: nullableNumber(row.true_ability_delta),
      hasRoute: Number(row.has_route) === 1,
      canonicalWorkoutId: String(row.canonical_workout_id),
      modelVersion: String(row.model_version ?? ""),
      updatedTrueAbility: Number(row.updated_true_ability) === 1,
      heartRateCoverage: nullableNumber(row.heart_rate_coverage),
      heartRateSampleCount: Number(row.heart_rate_sample_count ?? 0),
      routeQuality: nullableNumber(row.route_quality),
      routePointCount: Number(row.route_point_count ?? 0),
      sourceConfidence: Number(row.source_confidence ?? 0),
      effectiveWeights: parseJson<Record<string, number>>(row.effective_weights_json, {}),
      confidenceFactors: parseJson<Record<string, number>>(row.confidence_factors_json, {}),
      explanationCodes: parseJson<string[]>(row.explanation_codes_json, []),
      explanation: parseJson<Record<string, unknown>>(row.explanation_json, {}),
      trueAbilityBefore: nullableNumber(row.true_ability_before),
      trueAbilityAfter: nullableNumber(row.true_ability_after),
      workoutContribution: nullableNumber(row.workout_contribution),
      dimensions: {
        efficiency: nullableNumber(row.efficiency_score),
        pace: nullableNumber(row.pace_score),
        cardio: nullableNumber(row.cardio_score),
        stability: nullableNumber(row.stability_score),
        recovery: nullableNumber(row.recovery_score)
      }
    };
  }

  /**
   * `GET /v1/workouts/:id/freshness` 的**只读事实侧**（P0-3，2026-10-18 同步诊断）。
   *
   * 回答的是三个可核对的量，不做推断：
   *   1. 事实到齐程度：哪些批次写过这条训练窗口（`import_entity_changes` ⋈ `import_batches`）；
   *   2. 分析状态：是否已发布（`active_ability_assessments` + `active_model_run`），
   *      未发布时关联到"最近一次登记给它的事实批次"上的分析任务（`recompute_jobs.request_json`）；
   *   3. 每指标窗口内样本数：与 `/series` **同一条** `type + source_name + start_at` 谓词与去重键，
   *      外加 `elevation` = 可读路线点数（走唯一路线点入口）。
   *
   * 会话不存在（或事实已被软删）⇒ `null`（路由回 404 「未找到该训练记录」，与详情一致）。
   */
  freshness(trainingSessionId: string): StoredWorkoutFreshness | null {
    const session = this.database
      .prepare(`
        SELECT ts.id AS id, ts.canonical_workout_id AS canonicalWorkoutId,
          ts.anchor_start_at AS startedAt, ts.anchor_end_at AS endedAt,
          w.source_name AS sourceName
        FROM training_sessions ts
        JOIN workouts w ON w.id = ts.canonical_workout_id AND ${workoutPresentConditionSql("w")}
        WHERE ts.id = ?
      `)
      .get(trainingSessionId) as
      { id: string; canonicalWorkoutId: string; startedAt: string; endedAt: string; sourceName: string }
      | undefined;
    if (!session) return null;

    // ① 批次证据。只认 `succeeded` 且带完成时刻的批次：`running`/`failed` 不是"到了"。
    const workoutBatches = this.database
      .prepare(`
        SELECT DISTINCT change.batch_id AS batchId, batch.completed_at AS completedAt,
          change.change_type AS changeType
        FROM import_entity_changes change
        JOIN import_batches batch ON batch.id = change.batch_id
        WHERE change.entity_kind = 'workout' AND change.entity_id = ?
          AND batch.status = 'succeeded' AND batch.completed_at IS NOT NULL
      `)
      .all(session.canonicalWorkoutId) as Array<{ batchId: string; completedAt: string; changeType: string }>;
    // 窗口内记录：`effective_at` 是账本里**记录自身的时刻**（不是批次时刻），
    // 因此它能回答"这批是不是真的碰了这次训练"，而不是"这批有没有写过任何记录"。
    const recordBatches = this.database
      .prepare(`
        SELECT DISTINCT change.batch_id AS batchId, batch.completed_at AS completedAt
        FROM import_entity_changes change
        JOIN import_batches batch ON batch.id = change.batch_id
        WHERE change.entity_kind = 'record'
          AND change.effective_at IS NOT NULL
          AND change.effective_at >= ? AND change.effective_at <= ?
          AND batch.status = 'succeeded' AND batch.completed_at IS NOT NULL
      `)
      .all(session.startedAt, session.endedAt) as Array<{ batchId: string; completedAt: string }>;

    const batchCompletedAt = new Map<string, string>();
    for (const row of [...workoutBatches, ...recordBatches]) {
      const previous = batchCompletedAt.get(row.batchId);
      if (previous === undefined || row.completedAt > previous) batchCompletedAt.set(row.batchId, row.completedAt);
    }
    // 首次提交 = 第一次把 workout 实体**写入**（inserted/updated）的批次完成时刻；
    // 删除批次（removed）不构成"这条训练到过"。没有任何写入证据（旧库/异常）⇒ null。
    const committedAt = workoutBatches
      .filter((row) => row.changeType === "inserted" || row.changeType === "updated")
      .map((row) => row.completedAt)
      .sort()[0] ?? null;
    const lastBatchAt = [...batchCompletedAt.values()].sort().at(-1) ?? null;

    // ② 分析状态。发布 = 存在指向 active model run 的评估行；`publishedAt` 取指针激活时刻。
    const published = this.database
      .prepare(`
        SELECT active.activated_at AS publishedAt
        FROM training_sessions ts
        JOIN active_ability_assessments assessment ON assessment.training_session_id = ts.id
        JOIN active_model_run active ON active.model_run_id = assessment.model_run_id
        WHERE ts.id = ?
        LIMIT 1
      `)
      .get(trainingSessionId) as { publishedAt: string } | undefined;
    const job = this.analysisJobForBatches([...batchCompletedAt.keys()]);
    const analysisStatus: StoredWorkoutFreshness["analysis"]["status"] = published !== undefined
      ? "published"
      : job?.status === "failed" ? "failed" : "pending";

    // ③ 每指标样本数（与 `/series` 同口径）。`DISTINCT` 的键与 `metricSeries` 的
    // `SELECT DISTINCT start_at, end_at, value_numeric, unit` 逐列相同 —— 重复行不抬高样本数。
    const typeToMetric = new Map(freshnessMetricTypes.map(([metric, type]) => [type, metric]));
    const placeholders = [...typeToMetric.keys()].map(() => "?").join(",");
    const counts = new Map<string, number>(
      (this.database
        .prepare(`
          SELECT type, COUNT(*) AS samples
          FROM (
            SELECT DISTINCT type, start_at, end_at, value_numeric, unit
            FROM health_records
            WHERE type IN (${placeholders})
              AND source_name = ?
              AND start_at >= ? AND start_at <= ?
              AND value_numeric IS NOT NULL
          )
          GROUP BY type
        `)
        .all(...typeToMetric.keys(), session.sourceName, session.startedAt, session.endedAt) as
        Array<{ type: string; samples: number }>)
        .map((row) => [row.type, Number(row.samples)])
    );
    const lastAvailableAt = this.lastAvailableAtByType(
      [...typeToMetric.keys()], session.sourceName, session.startedAt, session.endedAt
    );
    const elevationSamples = this.routePointReader.routeQualityForWorkout(session.canonicalWorkoutId).pointCount;
    const metrics: StoredWorkoutFreshnessMetric[] = [
      ...freshnessMetricTypes.map(([metric, type]) => ({
        metric,
        samples: counts.get(type) ?? 0,
        lastAvailableAt: lastAvailableAt.get(type) ?? null
      })),
      // elevation 不是 `health_records` 行：它回答"轨迹到哪儿了"，走唯一路线点入口。
      { metric: "elevation", samples: elevationSamples, lastAvailableAt: null }
    ];

    return {
      sessionId: session.id,
      committedAt,
      lastBatchAt,
      batches: batchCompletedAt.size,
      analysis: {
        status: analysisStatus,
        jobId: job?.id ?? null,
        publishedAt: published?.publishedAt ?? null
      },
      metrics
    };
  }

  /**
   * 与给定事实批次关联的**最近一条**分析任务。
   *
   * 关联键是 `recompute_jobs.request_json.importBatchId` —— 接收事务把分析任务登记在
   * 同一批上（PR4 §4.2），所以这是"这条训练的分析"在库里唯一的结构性连接。
   * 用 `json_valid` 兜住历史畸形行：一条解析不了的 request 不该让 freshness 整个 500。
   * 批次的产物（任务）可能被合并/重排，因此只按时间取最新一条并原样报它的终态。
   */
  private analysisJobForBatches(batchIds: string[]): { id: string; status: string } | undefined {
    if (batchIds.length === 0) return undefined;
    const placeholders = batchIds.map(() => "?").join(",");
    return this.database
      .prepare(`
        SELECT job.id AS id, job.status AS status
        FROM recompute_jobs job
        WHERE json_valid(job.request_json)
          AND json_extract(job.request_json, '$.importBatchId') IN (${placeholders})
        ORDER BY job.created_at DESC, job.id DESC
        LIMIT 1
      `)
      .get(...batchIds) as { id: string; status: string } | undefined;
  }

  /**
   * `health_records.available_at`（P2-2，v46）存在时，每指标窗口内 `MAX(available_at)`。
   *
   * 🔴 列存在性是**运行期探测**而不是假设：v46 由另一条 lane 落地，两个改动的发布顺序
   * 不保证。没迁移的库上 `lastAvailableAt` 一律 `null`（契约允许，"不知道"不是"没到"），
   * 迁移后同一条代码自动开始给值 —— 不需要第二版读路径。
   */
  private lastAvailableAtByType(
    types: string[], sourceName: string, startedAt: string, endedAt: string
  ): Map<string, string> {
    if (!this.hasHealthRecordAvailableAt()) return new Map();
    const placeholders = types.map(() => "?").join(",");
    return new Map(
      (this.database
        .prepare(`
          SELECT type, MAX(available_at) AS lastAvailableAt
          FROM health_records
          WHERE type IN (${placeholders})
            AND source_name = ?
            AND start_at >= ? AND start_at <= ?
            AND value_numeric IS NOT NULL
            AND available_at IS NOT NULL
          GROUP BY type
        `)
        .all(...types, sourceName, startedAt, endedAt) as Array<{ type: string; lastAvailableAt: string }>)
        .map((row) => [row.type, String(row.lastAvailableAt)])
    );
  }

  private healthRecordAvailableAtColumn: boolean | null = null;

  private hasHealthRecordAvailableAt(): boolean {
    if (this.healthRecordAvailableAtColumn !== null) return this.healthRecordAvailableAtColumn;
    const columns = this.database.prepare("PRAGMA table_info(health_records)").all() as Array<{ name: string }>;
    this.healthRecordAvailableAtColumn = columns.some((column) => column.name === "available_at");
    return this.healthRecordAvailableAtColumn;
  }

  /**
   * `GET /v1/sync/coverage` 的取数（P1-1）：每个记录类型在服务端已知的覆盖区间。
   *
   * 语义边界（客户端据此**只**决定"不必重传"，不能当成"完整"）：
   * - `knownFrom` / `knownUntil` = `MIN(start_at)` / `MAX(end_at)`，是**已落库样本覆盖的端点**，
   *   不证明区间内没有空洞；离线期间的类型本来就不该被跳过，所以这里不提供"完整"信号。
   * - `sampleCount` = `COUNT(*)`（未去重）：它回答"服务端有多少行"，与 `samples` 的展示口径不同，
   *   刻意不在 SQL 里做 DISTINCT —— 那会让这条覆盖查询变成全类型去重扫描。
   * - `types` 为空 = 全部类型；给了过滤键就只回这些类型（不存在的类型**不补空行**：
   *   "服务端没有这个类型"本身就是可用的信息）。
   */
  syncCoverageTypes(types?: string[]): StoredSyncCoverageType[] {
    const filter = types !== undefined && types.length > 0;
    const placeholders = filter ? types.map(() => "?").join(",") : "";
    const rows = this.database
      .prepare(`
        SELECT type,
          MIN(start_at) AS knownFrom,
          MAX(end_at) AS knownUntil,
          COUNT(*) AS sampleCount
        FROM health_records
        ${filter ? `WHERE type IN (${placeholders})` : ""}
        GROUP BY type
        ORDER BY type
      `)
      .all(...(filter ? types : [])) as Array<{
        type: string; knownFrom: string | null; knownUntil: string | null; sampleCount: number;
      }>;
    return rows.map((row) => ({
      type: row.type,
      knownFrom: row.knownFrom ?? null,
      knownUntil: row.knownUntil ?? null,
      sampleCount: Number(row.sampleCount)
    }));
  }

  /**
   * 该训练**已发布路线版本的指针**（PR5 S5 / D5 最后一段）。
   *
   * 返回 `null` 有两层含义，调用方**必须**自己区分，不要在这里合并：
   * - `workout_routes` 行不存在（这条训练没有轨迹）⇒ 事实块与分析块**都**没有路线；
   * - 行存在但 `published_route_version_id IS NULL` ⇒ **老库**（v35 之前发布的路线），
   *   此时分析块**允许退化**读当前 `route_points` 并标 `routeVersionId: null`
   *   —— 不猜、不假装它有版本。
   *
   * 刻意同时返回 `usableRoute`：调用方若只看指针，会把"有指针但轨迹不可用
   * （`file_status = 'pending'`）"当成"有轨迹"。判据与写侧同源（`usableRouteConditionSql()`）。
   */
  routePointer(workoutId: string): { routeId: string; publishedRouteVersionId: string | null; usable: boolean } | null {
    return this.routePointReader.routePointer(workoutId);
  }

  workoutStatistic(
    workoutId: string,
    type: string,
    preference: "sum" | "average"
  ): number | null {    const row = this.database
      .prepare(`
        SELECT sum_value, average_value
        FROM workout_statistics
        WHERE workout_id = ? AND type = ?
        ORDER BY ordinal
        LIMIT 1
      `)
      .get(workoutId, type) as Record<string, unknown> | undefined;
    const storedValue = row
      ? preference === "sum"
        ? nullableNumber(row.sum_value) ?? nullableNumber(row.average_value)
        : nullableNumber(row.average_value) ?? nullableNumber(row.sum_value)
      : null;
    if (storedValue !== null && storedValue !== undefined) return storedValue;
    // Apple Health commonly exports running dynamics as time-series Records
    // without a matching WorkoutStatistics aggregate.
    if (preference === "average" && rawAverageMetricTypes.has(type)) {
      return this.averageRawMetric(workoutId, type);
    }
    return storedValue ?? null;
  }

  private averageRawMetric(workoutId: string, type: string): number | null {
    const workout = this.database
      .prepare(`SELECT source_name, start_at, end_at FROM workouts
        WHERE id = ? AND ${workoutPresentConditionSql()}`)
      .get(workoutId) as Record<string, unknown> | undefined;
    if (
      typeof workout?.source_name !== "string" ||
      typeof workout.start_at !== "string" ||
      typeof workout.end_at !== "string"
    ) return null;
    const workoutStartMs = Date.parse(workout.start_at);
    const workoutEndMs = Date.parse(workout.end_at);
    if (!Number.isFinite(workoutStartMs) || !Number.isFinite(workoutEndMs) || workoutEndMs <= workoutStartMs) {
      return null;
    }
    // 2026-10-18（P0-1）：与 `SqliteSeriesReadRepository.metricIntervals` 同一条
    // "OR 分支让 start_at 失去下界 ⇒ 全来源历史扫描"的谓词（同一类读放大）。
    // 2026-10-18（复查 P2）：改走 `read/health-record-overlap-reads.ts` 的**有界计划**
    // （该 type 最长记录时长把候选起点收紧成固定宽度区间；中段/老窗口不再走半段历史），
    // 拿不到有界证据时回退两种逐行等价的 split / legacy 形状。
    // 注意这里的投影**不含 unit**：本方法的去重键历来是 (start_at, end_at, value_numeric)，
    // 加 unit 会把"同区间同值、仅 unit 文本不同"的行从两行变一行，改变加权分母。
    const { rows } = readHealthRecordOverlap(this.database, {
      type,
      sourceName: workout.source_name,
      startedAt: workout.start_at,
      endedAt: workout.end_at,
      columns: ["start_at", "end_at", "value_numeric"]
    });
    let weightedValue = 0;
    let coveredMs = 0;
    for (const [index, row] of rows.entries()) {
      const sourceStartMs = Date.parse(String(row.start_at));
      const startMs = Math.max(workoutStartMs, sourceStartMs);
      const recordedEndMs = Date.parse(String(row.end_at));
      const nextStartMs = Date.parse(String(rows[index + 1]?.start_at ?? workout.end_at));
      const inferredEndMs =
        recordedEndMs > sourceStartMs ? recordedEndMs : Math.min(nextStartMs, sourceStartMs + 30_000);
      const endMs = Math.min(workoutEndMs, inferredEndMs);
      const value = nullableNumber(row.value_numeric);
      if (
        !Number.isFinite(sourceStartMs) ||
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        value === null ||
        endMs <= startMs
      ) continue;
      const durationMs = endMs - startMs;
      weightedValue += value * durationMs;
      coveredMs += durationMs;
    }
    return coveredMs > 0 ? weightedValue / coveredMs : null;
  }

  averageCadence(workoutId: string, durationSeconds: number): number | null {
    const steps = this.workoutStatistic(workoutId, "HKQuantityTypeIdentifierStepCount", "sum");
    if (steps !== null && durationSeconds > 0) return steps / (durationSeconds / 60);

    const workout = this.database
      .prepare(`SELECT source_name, start_at, end_at FROM workouts
        WHERE id = ? AND ${workoutPresentConditionSql()}`)
      .get(workoutId) as Record<string, unknown> | undefined;
    if (
      typeof workout?.source_name !== "string" ||
      typeof workout.start_at !== "string" ||
      typeof workout.end_at !== "string"
    ) return null;
    const workoutStartMs = Date.parse(workout.start_at);
    const workoutEndMs = Date.parse(workout.end_at);
    if (!Number.isFinite(workoutStartMs) || !Number.isFinite(workoutEndMs) || workoutEndMs <= workoutStartMs) {
      return null;
    }
    // 2026-10-18（复查 P2）：原始 step 回退读此前是 `start_at < 窗口终点 AND end_at > 窗口起点`
    // 的单条谓词 —— 只有 `end_at` 下界时，老 workout 会随时间轴增长扫描整段历史
    // （与 metricIntervals 的 P0-1 前形态同类，只是没有 julianday 残差）。现在改走
    // `readHealthRecordOverlap` 的有界计划（该 type 最长记录时长收紧候选起点，与窗口
    // 位置无关），拿不到有界证据时回退 `pureOverlap` 的 split / legacy 两种逐行等价形状。
    // 谓词仍是纯文本比较（`start_at < U AND end_at > L`），与历史实现逐行一致。
    const { rows: records } = readHealthRecordOverlap(this.database, {
      type: "HKQuantityTypeIdentifierStepCount",
      sourceName: workout.source_name,
      startedAt: workout.start_at,
      endedAt: workout.end_at,
      columns: ["start_at", "end_at", "value_numeric"],
      predicate: "pureOverlap"
    });
    const recordedSteps = records.reduce((total, record) => {
      const value = nullableNumber(record.value_numeric);
      const startMs = Date.parse(String(record.start_at));
      const endMs = Date.parse(String(record.end_at));
      if (value === null || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return total;
      }
      const overlapMs = Math.max(0, Math.min(workoutEndMs, endMs) - Math.max(workoutStartMs, startMs));
      return total + value * overlapMs / (endMs - startMs);
    }, 0);
    return recordedSteps > 0 && durationSeconds > 0
      ? recordedSteps / (durationSeconds / 60)
      : null;
  }

  /**
   * 这条训练的高程增益（GPS 尖峰过滤：单段上升 < 30 m 才计入）。
   *
   * 🔴 改造前这里 `JOIN route_points` 而**一个字都不判**，于是同一次训练可以在
   * `loadRouteQuality` 那边"没有点"、在这边"有高程"。现在两边都走同一个入口
   * （`readable_route_points` 视图），数字对**在两种判据下都可读**的路线逐位不变
   * （见 `test/route-point-reader.test.ts` 的对照金标）。
   */
  elevationGain(workoutId: string): number | null {
    return this.routePointReader.elevationGain(workoutId);
  }

  override(trainingSessionId: string): StoredWorkoutOverride | null {
    const row = this.database
      .prepare("SELECT * FROM effective_workout_overrides WHERE training_session_id = ?")
      .get(trainingSessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      revision: Number(row.revision),
      eligibilityOverride:
        row.eligibility_override === "include" || row.eligibility_override === "exclude"
          ? row.eligibility_override
          : null,
      statisticsParticipation:
        row.statistics_participation === "include" || row.statistics_participation === "exclude"
          ? row.statistics_participation
          : null,
      sessionType: typeof row.session_type === "string" ? row.session_type : null,
      performanceProtocol:
        typeof row.performance_protocol === "string"
          ? (row.performance_protocol as PerformanceProtocol)
          : null,
      rpe: nullableNumber(row.rpe),
      conditionTags: parseJson(typeof row.condition_tags_json === "string" ? row.condition_tags_json : "[]", []),
      note: typeof row.note === "string" ? row.note : null,
      createdAt: String(row.created_at)
    };
  }

  trainingLoad(trainingSessionId: string): WorkoutTrainingLoad | null {
    const row = this.database
      .prepare(`SELECT * FROM active_workout_training_loads WHERE training_session_id = ?`)
      .get(trainingSessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      trainingSessionId: String(row.training_session_id),
      localDate: String(row.local_date),
      distanceMeters:
        nullableNumber(row.distance_km) === null ? null : Number(row.distance_km) * 1000,
      durationSeconds: Number(row.duration_seconds),
      load: Number(row.training_load),
      intensity: Number(row.intensity),
      source: String(row.load_source) as WorkoutTrainingLoad["source"],
      confidence: Number(row.confidence),
      rpe: nullableNumber(row.rpe),
      sessionType: String(row.session_type) as SessionType,
      averageHeartRate: nullableNumber(row.average_heart_rate_bpm),
      elevationGainMeters: nullableNumber(row.elevation_gain_meters),
      stimulusType: String(row.stimulus_type ?? "unclassified") as StimulusType,
      breakdown: {
        rawHrrTrimp: nullableNumber(row.raw_hrr_trimp),
        internalLoad: nullableNumber(row.internal_load),
        paceLoad: nullableNumber(row.pace_load),
        distanceReferenceMeters: nullableNumber(row.distance_reference_meters),
        distanceExposureRatio: nullableNumber(row.distance_exposure_ratio),
        distanceFactor: Number(row.distance_factor ?? 1),
        compositeLoad: Number(row.training_load),
        compositeIntensity: Number(row.intensity ?? 0),
        heartRateConfidence: Number(row.heart_rate_load_confidence ?? 0),
        paceConfidence: Number(row.pace_load_confidence ?? 0)
      },
      explanations:
        parseJson<{ explanations?: WorkoutTrainingLoad["explanations"] }>(row.provenance_json, {})
          .explanations ?? []
    };
  }
}

function mapListItem(row: Record<string, unknown>): StoredWorkoutListItem {
  const duration = Number(row.duration_seconds);
  const distance = nullableNumber(row.distance_km);
  return {
    id: String(row.session_id),
    startedAt: String(row.workout_start_at),
    endedAt: String(row.anchor_end_at),
    durationSeconds: duration,
    distanceKm: distance,
    averagePaceSecondsPerKm: paceSeconds(duration, distance),
    averageHeartRateBpm: nullableNumber(row.average_heart_rate_bpm),
    indoor: row.indoor === null ? null : Number(row.indoor) === 1,
    sourceCategory: String(row.source_category),
    sessionType: String(row.session_type),
    stimulusType: String(row.stimulus_type ?? "unclassified"),
    stimulusConfidence: nullableNumber(row.stimulus_confidence),
    eligibilityStatus: String(row.eligibility_status),
    assessmentStatus: typeof row.assessment_status === "string" ? row.assessment_status : null,
    missingReasons: parseJson<string[]>(row.missing_reasons_json, []),
    qualityScore: Number(row.quality_score ?? 0),
    currentAbility: nullableNumber(row.current_ability),
    confidence: nullableNumber(row.confidence),
    trueAbilityDelta: nullableNumber(row.true_ability_delta),
    hasRoute: Number(row.has_route) === 1,
    // 派生字段的"有没有"只由这一位解释：NULL 分数 + published 是"分析过但该量无值"，
    // NULL 分数 + pending 是"分析还没发布"。两者在响应里必须可分辨（P0-1）。
    analysisPublishStatus: Number(row.analysis_published) === 1 ? "published" : "pending"
  };
}
