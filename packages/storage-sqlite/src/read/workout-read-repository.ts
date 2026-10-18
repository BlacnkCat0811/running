import type { DatabaseSync } from "node:sqlite";
import { sessionFactPresentConditionSql, workoutPresentConditionSql } from "../sql/fragments.js";

import type { PerformanceProtocol, SessionType, StimulusType, WorkoutTrainingLoad } from "@rai/contracts";

import { adaptiveHealthRecordOverlapQuery, nullableNumber, paceSeconds, parseJson } from "./read-utils.js";
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
  assessmentStatus: string;
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

export class SqliteWorkoutReadRepository {
  /** 路线点只有这一个入口（视图 + 唯一判据），见 `read/route-point-reader.ts`。 */
  private readonly routePointReader: SqliteRoutePointReader;

  constructor(private readonly database: DatabaseSync) {
    this.routePointReader = new SqliteRoutePointReader(database);
  }

  latestWorkoutStartAt(): string | null {
    const latest = this.database
      .prepare(`
        SELECT MAX(workout_start_at) AS value
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
      `)
      .get() as Record<string, unknown>;
    return typeof latest.value === "string" ? latest.value : null;
  }

  buildListFilter(query: Omit<WorkoutListFilterQuery, "limit" | "offset">): WorkoutListSqlFilter {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.startedFrom) { clauses.push("julianday(f.workout_start_at) >= julianday(?)"); params.push(query.startedFrom); }
    if (query.startedBefore) { clauses.push("julianday(f.workout_start_at) < julianday(?)"); params.push(query.startedBefore); }
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
        clauses.push("f.workout_start_at >= ?");
        params.push(cutoff.toISOString());
      }
    }
    return {
      where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      params
    };
  }

  count(where: string, params: Array<string | number>): number {
    const count = this.database
      .prepare(`
        SELECT COUNT(*) AS total
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        JOIN training_sessions ts ON ts.id = a.training_session_id
        JOIN workouts w ON w.id = ts.canonical_workout_id AND ${workoutPresentConditionSql("w")}
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
          a.training_session_id AS session_id,
          f.workout_start_at,
          ts.anchor_end_at,
          f.duration_seconds,
          f.distance_km,
          f.average_heart_rate_bpm,
          f.missing_reasons_json,
          f.session_type,
          COALESCE(zs.stimulus_type, 'unclassified') AS stimulus_type,
          zs.stimulus_confidence,
          f.eligibility_status,
          f.quality_score,
          w.indoor,
          w.source_category,
          a.assessment_status,
          a.current_ability,
          a.confidence,
          a.true_ability_delta,
          EXISTS (
            SELECT 1
            FROM training_sessions ts
            JOIN workout_routes wr ON wr.workout_id = ts.canonical_workout_id
            WHERE ts.id = a.training_session_id AND wr.point_count > 0
          ) AS has_route
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        JOIN training_sessions ts ON ts.id = a.training_session_id
        JOIN workouts w ON w.id = ts.canonical_workout_id AND ${workoutPresentConditionSql("w")}
        LEFT JOIN active_workout_zone_summaries zs ON zs.training_session_id = ts.id
        ${where}
        ORDER BY f.workout_start_at DESC
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
    const row = this.database
      .prepare(`
        SELECT
          ts.id AS session_id,
          ts.anchor_end_at,
          ts.canonical_workout_id,
          w.indoor,
          w.source_category,
          mr.model_version,
          f.*,
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
          a.updated_true_ability,
          a.effective_weights_json,
          a.confidence_factors_json,
          a.explanation_codes_json,
          a.explanation_json,
          EXISTS (
            SELECT 1 FROM workout_routes wr
            WHERE wr.workout_id = ts.canonical_workout_id AND wr.point_count > 0
          ) AS has_route
        FROM training_sessions ts
        JOIN active_ability_assessments a ON a.training_session_id = ts.id
        JOIN workout_features f ON f.id = a.feature_id
        JOIN workouts w ON w.id = ts.canonical_workout_id AND ${workoutPresentConditionSql("w")}
        JOIN model_runs mr ON mr.id = a.model_run_id
        WHERE ts.id = ?
      `)
      .get(trainingSessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      startedAt: String(row.workout_start_at),
      endedAt: String(row.anchor_end_at),
      durationSeconds: Number(row.duration_seconds),
      distanceKm: nullableNumber(row.distance_km),
      averageHeartRateBpm: nullableNumber(row.average_heart_rate_bpm),
      indoor: row.indoor === null ? null : Number(row.indoor) === 1,
      sourceCategory: String(row.source_category),
      sessionType: String(row.session_type),
      eligibilityStatus: String(row.eligibility_status),
      assessmentStatus: String(row.assessment_status),
      missingReasons: parseJson<string[]>(row.missing_reasons_json, []),
      qualityScore: Number(row.quality_score),
      currentAbility: nullableNumber(row.current_ability),
      confidence: nullableNumber(row.confidence),
      trueAbilityDelta: nullableNumber(row.true_ability_delta),
      hasRoute: Number(row.has_route) === 1,
      canonicalWorkoutId: String(row.canonical_workout_id),
      modelVersion: String(row.model_version),
      updatedTrueAbility: Number(row.updated_true_ability) === 1,
      heartRateCoverage: nullableNumber(row.heart_rate_coverage),
      heartRateSampleCount: Number(row.heart_rate_sample_count ?? 0),
      routeQuality: nullableNumber(row.route_quality),
      routePointCount: Number(row.route_point_count ?? 0),
      sourceConfidence: Number(row.source_confidence),
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
    // 拆成两个各自可走索引 seek 的 UNION 分支（窗口内 start_at 双端；跨窗口起点
    // 只有 end_at 下界 + 24 h slack）；精确归属仍由 julianday 残差判断（与改造前逐行等价）。
    // 2026-10-18（复查 P1）：同一处"split 分支 B 只有 end_at 下界、窗口越老越慢"的自适应
    // （形状、成本模型与回退规则见 `read/read-utils.ts` 的 `HealthRecordOverlapShape`）。
    // 注意这里的投影**不含 unit**：本方法的去重键历来是 (start_at, end_at, value_numeric)，
    // 加 unit 会把"同区间同值、仅 unit 文本不同"的行从两行变一行，改变加权分母。
    const { sql, params } = adaptiveHealthRecordOverlapQuery(this.database, {
      type,
      sourceName: workout.source_name,
      startedAt: workout.start_at,
      endedAt: workout.end_at,
      columns: ["start_at", "end_at", "value_numeric"]
    });
    const rows = this.database.prepare(sql).all(...params) as Record<string, unknown>[];
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
    const records = this.database
      .prepare(`
        SELECT value_numeric, start_at, end_at
        FROM (
          SELECT DISTINCT value_numeric, start_at, end_at
          FROM health_records
          WHERE source_name = ?
            AND type = 'HKQuantityTypeIdentifierStepCount'
            AND value_numeric IS NOT NULL
            AND start_at < ? AND end_at > ?
        )
      `)
      .all(workout.source_name, workout.end_at, workout.start_at) as Record<string, unknown>[];
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
    qualityScore: Number(row.quality_score),
    currentAbility: nullableNumber(row.current_ability),
    confidence: nullableNumber(row.confidence),
    trueAbilityDelta: nullableNumber(row.true_ability_delta),
    hasRoute: Number(row.has_route) === 1
  };
}
