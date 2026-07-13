import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";

import type {
  AbilityMetricSet,
  DataSummaryResponse,
  DataAuditResponse,
  DashboardResponse,
  DiagnosticExportResponse,
  ModelRunComparisonResponse,
  ModelRunSummary,
  RecomputeJobDto,
  RecomputeJobEventDto,
  RoutePointDto,
  DailyTrainingMetric,
  DailyZoneProfile,
  StimulusType,
  TrainingZoneProfileSettings,
  TrainingZonesCurrentResponse,
  TrainingZonesHistoryResponse,
  TrainingLoadTimelineResponse,
  TrainingPeriodSummary,
  TrainingStatisticsGranularity,
  TrainingStatisticsHistoryResponse,
  TrainingStatisticsOverviewResponse,
  WorkoutTrainingLoad,
  TrendResponse,
  WorkoutDetailResponse,
  WorkoutMetricSeries,
  WorkoutListItem,
  WorkoutListResponse,
  WorkoutOverrideDto,
  WorkoutZoneSummary,
  WorkoutSeriesResponse
} from "@rai/api-contracts";

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const paceSeconds = (duration: number, distance: number | null): number | null =>
  distance !== null && distance > 0 ? duration / distance : null;

export class RaiReadStore {
  private readonly database: DatabaseSync;
  private cacheVersion = -1;
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly path: string) {
    this.database = new DatabaseSync(path, { readOnly: true });
  }

  close(): void {
    this.database.close();
  }

  invalidateCache(): void {
    this.cache.clear();
    this.cacheVersion = -1;
  }

  private cached<T>(key: string, load: () => T): T {
    const row = this.database.prepare("PRAGMA data_version").get() as { data_version: number };
    if (row.data_version !== this.cacheVersion) {
      this.cache.clear();
      this.cacheVersion = row.data_version;
    }
    if (this.cache.has(key)) return this.cache.get(key) as T;
    const value = load();
    this.cache.set(key, value);
    return value;
  }

  dashboard(): DashboardResponse {
    const latestSnapshot = this.database
      .prepare(`
        SELECT local_date, true_ability, decay_points, growth_velocity_per_week, snapshot_status
        FROM active_daily_ability_snapshots
        ORDER BY local_date DESC
        LIMIT 1
      `)
      .get() as Record<string, unknown> | undefined;
    const sevenDaysAgo = latestSnapshot
      ? this.database.prepare(`
          SELECT true_ability
          FROM active_daily_ability_snapshots
          WHERE local_date <= date(?, '-7 day')
          ORDER BY local_date DESC
          LIMIT 1
        `).get(String(latestSnapshot.local_date)) as Record<string, unknown> | undefined
      : undefined;
    const latest = this.workoutRows("WHERE a.assessment_status = 'eligible'", [], 1, 0)[0] ?? null;
    const latestAssessment = latest
      ? (this.database
          .prepare(`
            SELECT efficiency_score, pace_score, cardio_score, stability_score, recovery_score,
                   explanation_codes_json
            FROM active_ability_assessments
            WHERE training_session_id = ?
          `)
          .get(latest.id) as Record<string, unknown> | undefined)
      : undefined;
    const totals = this.database
      .prepare(`
        SELECT
          COUNT(*) AS sessions,
          SUM(CASE WHEN f.eligibility_status = 'eligible' THEN 1 ELSE 0 END) AS eligible,
          SUM(CASE WHEN f.eligibility_status = 'trial' THEN 1 ELSE 0 END) AS trial,
          SUM(CASE WHEN f.eligibility_status = 'excluded' THEN 1 ELSE 0 END) AS excluded
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
      `)
      .get() as Record<string, unknown>;
    return {
      generatedAt: new Date().toISOString(),
      activeModel: this.activeModel(),
      latestSnapshot: latestSnapshot
        ? {
            localDate: String(latestSnapshot.local_date),
            trueAbility: nullableNumber(latestSnapshot.true_ability),
            decayPoints: Number(latestSnapshot.decay_points ?? 0),
            growthVelocityPerWeek: nullableNumber(latestSnapshot.growth_velocity_per_week),
            changeFrom7DaysAgo:
              nullableNumber(latestSnapshot.true_ability) !== null && nullableNumber(sevenDaysAgo?.true_ability) !== null
                ? Number(latestSnapshot.true_ability) - Number(sevenDaysAgo?.true_ability)
                : null,
            status: String(latestSnapshot.snapshot_status)
          }
        : null,
      latestWorkout: latest,
      dimensions: latestAssessment ? this.dimensions(latestAssessment) : null,
      explanationCodes: parseJson<string[]>(latestAssessment?.explanation_codes_json, []),
      totals: {
        sessions: Number(totals.sessions ?? 0),
        eligible: Number(totals.eligible ?? 0),
        trial: Number(totals.trial ?? 0),
        excluded: Number(totals.excluded ?? 0)
      },
      calibration: this.calibrationProgress(),
      recentWorkouts: this.workoutRows("", [], 6, 0),
      runningJob: this.jobs(1, true)[0] ?? null
    };
  }

  workouts(query: {
    limit: number;
    offset: number;
    status?: string;
    sessionType?: string;
    stimulusType?: string;
    participation?: string;
    environment?: string;
    days?: number;
    sourceGroup?: string;
    confidence?: string;
    route?: string;
  }): WorkoutListResponse {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
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
    if (query.sourceGroup === "third_party") clauses.push("w.source_category NOT IN ('apple_watch', 'manual', 'unknown')");
    if (query.sourceGroup === "manual") clauses.push("w.source_category = 'manual'");
    if (query.confidence === "high") clauses.push("a.confidence >= 0.8");
    if (query.confidence === "medium") clauses.push("a.confidence >= 0.6 AND a.confidence < 0.8");
    if (query.confidence === "low") clauses.push("a.confidence < 0.6");
    if (query.route === "available") clauses.push("EXISTS (SELECT 1 FROM workout_routes filter_route WHERE filter_route.workout_id = w.id AND filter_route.point_count > 0)");
    if (query.route === "missing") clauses.push("NOT EXISTS (SELECT 1 FROM workout_routes filter_route WHERE filter_route.workout_id = w.id AND filter_route.point_count > 0)");
    if (query.days && query.days > 0) {
      const latest = this.database
        .prepare("SELECT MAX(workout_start_at) AS value FROM active_ability_assessments a JOIN workout_features f ON f.id = a.feature_id")
        .get() as Record<string, unknown>;
      if (typeof latest.value === "string") {
        const cutoff = new Date(latest.value);
        cutoff.setUTCDate(cutoff.getUTCDate() - query.days + 1);
        clauses.push("f.workout_start_at >= ?");
        params.push(cutoff.toISOString());
      }
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = this.database
      .prepare(`
        SELECT COUNT(*) AS total
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        JOIN training_sessions ts ON ts.id = a.training_session_id
        JOIN workouts w ON w.id = ts.canonical_workout_id
        LEFT JOIN active_workout_zone_summaries zs ON zs.training_session_id = ts.id
        ${where}
      `)
      .get(...params) as Record<string, unknown>;
    return {
      items: this.workoutRows(where, params, query.limit, query.offset),
      total: Number(count.total ?? 0),
      limit: query.limit,
      offset: query.offset
    };
  }

  workout(id: string): WorkoutDetailResponse | null {
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
        JOIN workouts w ON w.id = ts.canonical_workout_id
        JOIN model_runs mr ON mr.id = a.model_run_id
        WHERE ts.id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const zoneSummary = this.zoneSummary(id);
    const duration = Number(row.duration_seconds);
    const distance = nullableNumber(row.distance_km);
    const workout: WorkoutDetailResponse["workout"] = {
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
      stimulusType: zoneSummary?.stimulusType ?? "unclassified",
      stimulusConfidence: zoneSummary?.stimulusConfidence ?? null,
      eligibilityStatus: String(row.eligibility_status),
      assessmentStatus: String(row.assessment_status),
      missingReasons: parseJson<string[]>(row.missing_reasons_json, []),
      qualityScore: Number(row.quality_score),
      currentAbility: nullableNumber(row.current_ability),
      confidence: nullableNumber(row.confidence),
      trueAbilityDelta: nullableNumber(row.true_ability_delta),
      hasRoute: Number(row.has_route) === 1,
      elapsedSeconds: Math.max(0, (Date.parse(String(row.anchor_end_at)) - Date.parse(String(row.workout_start_at))) / 1000),
      activeEnergyKcal: this.workoutStatistic(String(row.canonical_workout_id), "HKQuantityTypeIdentifierActiveEnergyBurned", "sum"),
      elevationGainMeters: this.elevationGain(String(row.canonical_workout_id)),
      averageCadenceSpm: this.averageCadence(String(row.canonical_workout_id), duration),
      averagePowerWatts: this.workoutStatistic(String(row.canonical_workout_id), "HKQuantityTypeIdentifierRunningPower", "average"),
      averageStrideLengthMeters: this.workoutStatistic(String(row.canonical_workout_id), "HKQuantityTypeIdentifierRunningStrideLength", "average"),
      averageVerticalOscillationCm: this.workoutStatistic(String(row.canonical_workout_id), "HKQuantityTypeIdentifierRunningVerticalOscillation", "average"),
      averageGroundContactTimeMs: this.workoutStatistic(String(row.canonical_workout_id), "HKQuantityTypeIdentifierRunningGroundContactTime", "average"),
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
      workoutContribution: nullableNumber(row.workout_contribution)
    };
    return {
      workout,
      dimensions: this.dimensions(row),
      route: this.route(String(row.canonical_workout_id)),
      override: this.override(id),
      trainingLoad: this.trainingLoad(id),
      zoneSummary,
      zoneProfile: zoneSummary ? this.zoneProfile(zoneSummary.zoneProfileId) : null
    };
  }

  trainingZonesCurrent(): TrainingZonesCurrentResponse | null {
    const row = this.database.prepare(`
      SELECT * FROM active_daily_zone_profiles ORDER BY local_date DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const profile = this.mapZoneProfile(row);
    const previousRow = this.database.prepare(`
      SELECT * FROM active_daily_zone_profiles
      WHERE local_date < ? ORDER BY local_date DESC LIMIT 1
    `).get(profile.localDate) as Record<string, unknown> | undefined;
    return {
      generatedAt: new Date().toISOString(),
      profile,
      settings: this.trainingZoneSettings(),
      previousProfile: previousRow ? this.mapZoneProfile(previousRow) : null
    };
  }

  trainingZonesHistory(days: number): TrainingZonesHistoryResponse {
    const rows = this.database.prepare(`
      SELECT * FROM active_daily_zone_profiles
      ORDER BY local_date DESC LIMIT ?
    `).all(days) as unknown as Record<string, unknown>[];
    return {
      generatedAt: new Date().toISOString(),
      profiles: rows.reverse().map((row) => this.mapZoneProfile(row))
    };
  }

  trainingStatisticsOverview(): TrainingStatisticsOverviewResponse {
    const latest = this.latestTrainingMetric();
    const generatedAt = new Date().toISOString();
    const asOf = latest?.localDate ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const rolling7Days = this.periodSummary("rolling", this.shiftDate(asOf, -6), asOf, asOf);
    return {
      generatedAt,
      timezone: "Asia/Shanghai",
      status: latest,
      statusConfidence: rolling7Days.loadConfidence,
      week: this.periodSummary("week", this.periodStart(asOf, "week"), asOf, asOf),
      month: this.periodSummary("month", this.periodStart(asOf, "month"), asOf, asOf),
      year: this.periodSummary("year", this.periodStart(asOf, "year"), asOf, asOf),
      rolling7Days,
      rolling28Days: this.periodSummary("rolling", this.shiftDate(asOf, -27), asOf, asOf)
    };
  }

  trainingStatisticsHistory(granularity: TrainingStatisticsGranularity, limit: number): TrainingStatisticsHistoryResponse {
    const latest = this.latestTrainingMetric();
    if (!latest) return { generatedAt: new Date().toISOString(), timezone: "Asia/Shanghai", granularity, periods: [] };
    const items: TrainingPeriodSummary[] = [];
    const firstRow = this.database.prepare("SELECT MIN(local_date) AS value FROM active_workout_training_loads").get() as Record<string, unknown>;
    const earliestPeriod = typeof firstRow.value === "string" ? this.periodStart(firstRow.value, granularity) : this.periodStart(latest.localDate, granularity);
    let start = this.periodStart(latest.localDate, granularity);
    for (let index = 0; index < limit; index += 1) {
      if (granularity === "year" && start < earliestPeriod) break;
      const next = this.nextPeriod(start, granularity);
      const naturalEnd = this.shiftDate(next, -1);
      const end = index === 0 && latest.localDate < naturalEnd ? latest.localDate : naturalEnd;
      items.push(this.periodSummary(granularity, start, end, latest.localDate));
      start = this.previousPeriod(start, granularity);
    }
    return { generatedAt: new Date().toISOString(), timezone: "Asia/Shanghai", granularity, periods: items };
  }

  trainingLoadTimeline(days: number): TrainingLoadTimelineResponse {
    const latest = this.latestTrainingMetric();
    if (!latest) return { generatedAt: new Date().toISOString(), timezone: "Asia/Shanghai", days: [], components: [] };
    const start = this.shiftDate(latest.localDate, -days + 1);
    const rows = this.database.prepare(`
      SELECT * FROM active_daily_training_metrics
      WHERE local_date BETWEEN ? AND ? ORDER BY local_date
    `).all(start, latest.localDate) as unknown as Record<string, unknown>[];
    const componentRows = this.database.prepare(`
      SELECT local_date,
        SUM(internal_load) AS internal_load,
        SUM(pace_load) AS pace_load,
        SUM(training_load) AS composite_load,
        SUM(CASE WHEN internal_load IS NOT NULL THEN 1 ELSE 0 END) AS internal_count,
        SUM(CASE WHEN pace_load IS NOT NULL THEN 1 ELSE 0 END) AS pace_count
      FROM active_workout_training_loads
      WHERE local_date BETWEEN ? AND ?
      GROUP BY local_date ORDER BY local_date
    `).all(start, latest.localDate) as unknown as Record<string, unknown>[];
    return {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      days: rows.map((row) => this.mapDailyMetric(row)),
      components: componentRows.map((row) => ({
        localDate: String(row.local_date),
        internalLoad: Number(row.internal_count ?? 0) > 0 ? Number(row.internal_load) : null,
        paceLoad: Number(row.pace_count ?? 0) > 0 ? Number(row.pace_load) : null,
        compositeLoad: Number(row.composite_load ?? 0)
      }))
    };
  }

  workoutSeries(id: string): WorkoutSeriesResponse | null {
    const session = this.database
      .prepare(`
        SELECT ts.id, ts.anchor_start_at, ts.anchor_end_at, w.source_category
        FROM training_sessions ts
        JOIN workouts w ON w.id = ts.canonical_workout_id
        WHERE ts.id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    if (!session) return null;
    const startedAt = String(session.anchor_start_at);
    const endedAt = String(session.anchor_end_at);
    const sourceCategory = String(session.source_category);
    return {
      trainingSessionId: id,
      startedAt,
      endedAt,
      sourceCategory,
      series: {
        heartRate: this.metricSeries(
          "HKQuantityTypeIdentifierHeartRate",
          "count/min",
          startedAt,
          endedAt,
          sourceCategory
        ),
        speed: this.metricSeries(
          "HKQuantityTypeIdentifierRunningSpeed",
          "km/hr",
          startedAt,
          endedAt,
          sourceCategory
        ),
        power: this.metricSeries(
          "HKQuantityTypeIdentifierRunningPower",
          "W",
          startedAt,
          endedAt,
          sourceCategory
        ),
        cadence: this.metricSeries(
          "HKQuantityTypeIdentifierStepCount",
          "spm",
          startedAt,
          endedAt,
          sourceCategory,
          (value, row) => {
            const seconds = Math.max(1, (Date.parse(String(row.end_at)) - Date.parse(String(row.start_at))) / 1000);
            return value / (seconds / 60);
          },
          true
        ),
        elevation: this.routeMetricSeries(id),
        strideLength: this.metricSeries("HKQuantityTypeIdentifierRunningStrideLength", "m", startedAt, endedAt, sourceCategory),
        verticalOscillation: this.metricSeries("HKQuantityTypeIdentifierRunningVerticalOscillation", "cm", startedAt, endedAt, sourceCategory),
        groundContactTime: this.metricSeries("HKQuantityTypeIdentifierRunningGroundContactTime", "ms", startedAt, endedAt, sourceCategory)
      }
    };
  }

  trends(days: number): TrendResponse {
    const end = this.database
      .prepare("SELECT MAX(local_date) AS value FROM active_daily_ability_snapshots")
      .get() as Record<string, unknown>;
    const endDate = typeof end.value === "string" ? end.value : null;
    const startDate = endDate
      ? new Date(`${endDate}T00:00:00Z`)
      : null;
    if (startDate) startDate.setUTCDate(startDate.getUTCDate() - Math.max(days - 1, 0));
    const start = startDate?.toISOString().slice(0, 10) ?? null;
    const daily = this.database
      .prepare(`
        SELECT local_date, true_ability, decay_points, growth_velocity_per_week, snapshot_status
        FROM active_daily_ability_snapshots
        WHERE (? IS NULL OR local_date >= ?)
        ORDER BY local_date
      `)
      .all(start, start) as Record<string, unknown>[];
    const workouts = this.database
      .prepare(`
        SELECT a.training_session_id, f.workout_start_at, a.current_ability, a.confidence,
               a.assessment_status, f.distance_km, f.duration_seconds, a.workout_contribution,
               a.efficiency_score, a.pace_score, a.cardio_score, a.stability_score, a.recovery_score
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        WHERE (? IS NULL OR substr(f.workout_start_at, 1, 10) >= ?)
        ORDER BY f.workout_start_at
      `)
      .all(start, start) as Record<string, unknown>[];
    const context = this.database
      .prepare(`
        SELECT substr(f.workout_start_at, 1, 10) AS local_date,
               SUM(COALESCE(f.distance_km, 0)) AS distance_km,
               SUM(f.duration_seconds) / 60.0 AS duration_minutes,
               SUM((f.duration_seconds / 60.0) * COALESCE(json_extract(f.features_json, '$.heartRateReserveFraction'), 0.5)) AS training_load
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        WHERE (? IS NULL OR substr(f.workout_start_at, 1, 10) >= ?)
        GROUP BY substr(f.workout_start_at, 1, 10)
        ORDER BY local_date
      `)
      .all(start, start) as Record<string, unknown>[];
    const modelRuns = this.database
      .prepare(`
        SELECT mr.id, mr.evaluated_at, mr.model_version, amr.model_run_id IS NOT NULL AS active
        FROM model_runs mr
        LEFT JOIN active_model_run amr ON amr.model_run_id = mr.id
        WHERE mr.status = 'succeeded' AND (? IS NULL OR substr(mr.evaluated_at, 1, 10) >= ?)
        ORDER BY mr.evaluated_at
      `)
      .all(start, start) as Record<string, unknown>[];
    return {
      startDate: daily[0] ? String(daily[0].local_date) : null,
      endDate: daily.at(-1) ? String(daily.at(-1)?.local_date) : null,
      daily: daily.map((row) => ({
        date: String(row.local_date),
        trueAbility: nullableNumber(row.true_ability),
        decayPoints: Number(row.decay_points ?? 0),
        growthVelocityPerWeek: nullableNumber(row.growth_velocity_per_week),
        status: String(row.snapshot_status)
      })),
      workouts: workouts.map((row) => ({
        id: String(row.training_session_id),
        date: String(row.workout_start_at),
        currentAbility: nullableNumber(row.current_ability),
        confidence: nullableNumber(row.confidence),
        assessmentStatus: String(row.assessment_status),
        distanceKm: nullableNumber(row.distance_km),
        durationSeconds: Number(row.duration_seconds),
        workoutContribution: nullableNumber(row.workout_contribution),
        dimensions: this.dimensions(row)
      })),
      context: context.map((row) => ({
        date: String(row.local_date),
        distanceKm: Number(row.distance_km ?? 0),
        durationMinutes: Number(row.duration_minutes ?? 0),
        trainingLoad: Number(row.training_load ?? 0)
      })),
      modelRuns: modelRuns.map((row) => ({
        id: String(row.id),
        date: String(row.evaluated_at),
        modelVersion: String(row.model_version),
        active: Number(row.active) === 1
      }))
    };
  }

  modelRuns(limit = 30): ModelRunSummary[] {
    const rows = this.database
      .prepare(`
        SELECT mr.*, amr.model_run_id IS NOT NULL AS active,
               (SELECT COUNT(*) FROM ability_assessments a WHERE a.model_run_id = mr.id) AS assessment_count,
               (SELECT COUNT(*) FROM daily_ability_snapshots s WHERE s.model_run_id = mr.id) AS snapshot_count
        FROM model_runs mr
        LEFT JOIN active_model_run amr ON amr.model_run_id = mr.id
        ORDER BY mr.created_at DESC
        LIMIT ?
      `)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapModel(row));
  }

  compareModelRuns(baseId: string, candidateId: string): ModelRunComparisonResponse | null {
    const modelRows = this.database
      .prepare(`
        SELECT mr.*, amr.model_run_id IS NOT NULL AS active,
               (SELECT COUNT(*) FROM ability_assessments a WHERE a.model_run_id = mr.id) AS assessment_count,
               (SELECT COUNT(*) FROM daily_ability_snapshots s WHERE s.model_run_id = mr.id) AS snapshot_count
        FROM model_runs mr
        LEFT JOIN active_model_run amr ON amr.model_run_id = mr.id
        WHERE mr.id IN (?, ?)
      `)
      .all(baseId, candidateId) as Record<string, unknown>[];
    const baseRow = modelRows.find((row) => row.id === baseId);
    const candidateRow = modelRows.find((row) => row.id === candidateId);
    if (!baseRow || !candidateRow) return null;
    const metrics = this.database
      .prepare(`
        SELECT
          COUNT(*) AS matched_sessions,
          AVG(c.current_ability - b.current_ability) AS ca_mean_delta,
          AVG(ABS(c.current_ability - b.current_ability)) AS ca_mean_abs_delta,
          AVG(c.confidence - b.confidence) AS confidence_mean_delta,
          SUM(CASE WHEN c.assessment_status <> b.assessment_status THEN 1 ELSE 0 END) AS status_changed
        FROM ability_assessments b
        JOIN ability_assessments c ON c.training_session_id = b.training_session_id
        WHERE b.model_run_id = ? AND c.model_run_id = ?
      `)
      .get(baseId, candidateId) as Record<string, unknown>;
    const finalSnapshot = (modelRunId: string): number | null => {
      const row = this.database
        .prepare(`
          SELECT true_ability
          FROM daily_ability_snapshots
          WHERE model_run_id = ?
          ORDER BY local_date DESC
          LIMIT 1
        `)
        .get(modelRunId) as Record<string, unknown> | undefined;
      return nullableNumber(row?.true_ability);
    };
    const baseFinal = finalSnapshot(baseId);
    const candidateFinal = finalSnapshot(candidateId);
    const changes = this.database
      .prepare(`
        SELECT
          b.training_session_id,
          ts.anchor_start_at,
          b.current_ability AS base_ca,
          c.current_ability AS candidate_ca,
          c.current_ability - b.current_ability AS delta
        FROM ability_assessments b
        JOIN ability_assessments c ON c.training_session_id = b.training_session_id
        JOIN training_sessions ts ON ts.id = b.training_session_id
        WHERE b.model_run_id = ? AND c.model_run_id = ?
          AND b.current_ability IS NOT NULL AND c.current_ability IS NOT NULL
        ORDER BY ABS(c.current_ability - b.current_ability) DESC, ts.anchor_start_at DESC
        LIMIT 10
      `)
      .all(baseId, candidateId) as Record<string, unknown>[];
    return {
      base: this.mapModel(baseRow),
      candidate: this.mapModel(candidateRow),
      metrics: {
        matchedSessions: Number(metrics.matched_sessions ?? 0),
        currentAbilityMeanDelta: nullableNumber(metrics.ca_mean_delta),
        currentAbilityMeanAbsoluteDelta: nullableNumber(metrics.ca_mean_abs_delta),
        confidenceMeanDelta: nullableNumber(metrics.confidence_mean_delta),
        finalTrueAbilityDelta:
          baseFinal !== null && candidateFinal !== null ? candidateFinal - baseFinal : null,
        assessmentStatusChanged: Number(metrics.status_changed ?? 0)
      },
      topChangedWorkouts: changes.map((row) => ({
        trainingSessionId: String(row.training_session_id),
        startedAt: String(row.anchor_start_at),
        baseCurrentAbility: nullableNumber(row.base_ca),
        candidateCurrentAbility: nullableNumber(row.candidate_ca),
        delta: nullableNumber(row.delta)
      }))
    };
  }

  jobs(limit = 30, activeOnly = false): RecomputeJobDto[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM recompute_jobs
        ${activeOnly ? "WHERE status IN ('queued', 'running')" : ""}
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapJob(row));
  }

  dataSummary(): DataSummaryResponse {
    return this.cached("data-summary", () => this.loadDataSummary());
  }

  private loadDataSummary(): DataSummaryResponse {
    const manifestRows = this.database
      .prepare("SELECT key, value FROM import_manifest")
      .all() as Array<{ key: string; value: string }>;
    const manifest = new Map(manifestRows.map((row) => [row.key, row.value]));
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM health_records) AS health_records,
        (SELECT COUNT(*) FROM workouts) AS workouts,
        (SELECT COUNT(*) FROM training_sessions) AS training_sessions,
        (SELECT COUNT(*) FROM route_points) AS route_points,
        (SELECT COUNT(*) FROM active_ability_assessments) AS assessments
    `).get() as Record<string, unknown>;
    const issues = this.database
      .prepare("SELECT severity, COUNT(*) AS count FROM import_issues GROUP BY severity ORDER BY severity")
      .all() as Record<string, unknown>[];
    return {
      databaseBytes: statSync(this.path).size,
      datasetVersion: manifest.get("dataset_version") ?? null,
      importCompletedAt: manifest.get("import_completed_at") ?? null,
      counts: {
        healthRecords: Number(counts.health_records ?? 0),
        workouts: Number(counts.workouts ?? 0),
        trainingSessions: Number(counts.training_sessions ?? 0),
        routePoints: Number(counts.route_points ?? 0),
        assessments: Number(counts.assessments ?? 0)
      },
      issues: issues.map((row) => ({ severity: String(row.severity), count: Number(row.count) }))
    };
  }

  dataAudit(): DataAuditResponse {
    return this.cached("data-audit", () => this.loadDataAudit());
  }

  private loadDataAudit(): DataAuditResponse {
    const manifestRows = this.database
      .prepare("SELECT key, value FROM import_manifest")
      .all() as Array<{ key: string; value: string }>;
    const manifest = new Map(manifestRows.map((row) => [row.key, row.value]));
    const ranges = this.database.prepare(`
      SELECT
        (SELECT MIN(start_at) FROM health_records) AS first_record,
        (SELECT MAX(end_at) FROM health_records) AS last_record,
        (SELECT MIN(start_at) FROM workouts) AS first_workout,
        (SELECT MAX(end_at) FROM workouts) AS last_workout
    `).get() as Record<string, unknown>;
    const canonical = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM health_records) AS health_records,
        (SELECT COUNT(*) FROM workouts) AS workouts,
        (SELECT COUNT(*) FROM workouts WHERE is_canonical = 1) AS canonical_workouts,
        (SELECT COUNT(*) FROM workout_groups) AS workout_groups,
        (SELECT COUNT(*) FROM training_sessions) AS training_sessions,
        (SELECT COUNT(*) FROM workout_routes) AS routes,
        (SELECT COUNT(*) FROM route_points) AS route_points
    `).get() as Record<string, unknown>;
    const quality = this.database.prepare(`
      SELECT
        AVG(f.quality_score) AS average_quality_score,
        AVG(f.heart_rate_coverage) AS average_hr_coverage,
        MIN(f.heart_rate_coverage) AS minimum_hr_coverage,
        MAX(f.heart_rate_coverage) AS maximum_hr_coverage
      FROM active_ability_assessments a
      JOIN workout_features f ON f.id = a.feature_id
    `).get() as Record<string, unknown>;
    const grouped = (sql: string): Record<string, unknown>[] =>
      this.database.prepare(sql).all() as Record<string, unknown>[];
    return {
      datasetVersion: manifest.get("dataset_version") ?? null,
      importCompletedAt: manifest.get("import_completed_at") ?? null,
      ranges: {
        healthRecords: {
          first: typeof ranges.first_record === "string" ? ranges.first_record : null,
          last: typeof ranges.last_record === "string" ? ranges.last_record : null
        },
        workouts: {
          first: typeof ranges.first_workout === "string" ? ranges.first_workout : null,
          last: typeof ranges.last_workout === "string" ? ranges.last_workout : null
        }
      },
      canonical: {
        healthRecords: Number(canonical.health_records ?? 0),
        workouts: Number(canonical.workouts ?? 0),
        canonicalWorkouts: Number(canonical.canonical_workouts ?? 0),
        workoutGroups: Number(canonical.workout_groups ?? 0),
        trainingSessions: Number(canonical.training_sessions ?? 0),
        routes: Number(canonical.routes ?? 0),
        routePoints: Number(canonical.route_points ?? 0)
      },
      featureQuality: {
        averageQualityScore: nullableNumber(quality.average_quality_score),
        averageHeartRateCoverage: nullableNumber(quality.average_hr_coverage),
        minimumHeartRateCoverage: nullableNumber(quality.minimum_hr_coverage),
        maximumHeartRateCoverage: nullableNumber(quality.maximum_hr_coverage)
      },
      recordTypes: grouped(`
        SELECT type, COUNT(*) AS count
        FROM health_records
        GROUP BY type
        ORDER BY count DESC, type
        LIMIT 24
      `).map((row) => ({ type: String(row.type), count: Number(row.count) })),
      sourceCategories: grouped(`
        SELECT source_category, COUNT(*) AS count
        FROM workouts
        GROUP BY source_category
        ORDER BY count DESC, source_category
      `).map((row) => ({ category: String(row.source_category), count: Number(row.count) })),
      sessionStatuses: grouped(`
        SELECT status, COUNT(*) AS count
        FROM training_sessions
        GROUP BY status
        ORDER BY count DESC, status
      `).map((row) => ({ status: String(row.status), count: Number(row.count) })),
      missingReasons: grouped(`
        SELECT reasons.value AS reason, COUNT(*) AS count
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        JOIN json_each(f.missing_reasons_json) reasons
        GROUP BY reasons.value
        ORDER BY count DESC, reason
      `).map((row) => ({ reason: String(row.reason), count: Number(row.count) })),
      issues: grouped(`
        SELECT severity, code, COUNT(*) AS count
        FROM import_issues
        GROUP BY severity, code
        ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, count DESC, code
      `).map((row) => ({ severity: String(row.severity), code: String(row.code), count: Number(row.count) }))
    };
  }

  diagnostics(): DiagnosticExportResponse {
    const summary = this.dataSummary();
    const audit = this.dataAudit();
    const active = this.database
      .prepare(`
        SELECT mr.id, mr.feature_run_id, mr.model_version, mr.model_config_hash, mr.summary_json
        FROM model_runs mr
        JOIN active_model_run amr ON amr.model_run_id = mr.id
      `)
      .get() as Record<string, unknown> | undefined;
    const modelSummary = parseJson<{
      baseline?: { calibrationFeatureIds?: string[] };
    }>(active?.summary_json, {});
    return {
      generatedAt: new Date().toISOString(),
      privacy: {
        coordinatesRemoved: true,
        healthTimeSeriesRemoved: true,
        sourceNamesRemoved: true
      },
      dataset: {
        version: summary.datasetVersion,
        importedAt: summary.importCompletedAt,
        counts: summary.counts
      },
      activeModel: active ? {
        id: String(active.id),
        modelVersion: String(active.model_version),
        modelConfigHash: String(active.model_config_hash),
        featureRunId: String(active.feature_run_id),
        calibrationFeatureIds: modelSummary.baseline?.calibrationFeatureIds ?? []
      } : null,
      calibration: active ? this.calibrationProgress() : null,
      jobs: this.jobs(20),
      issues: audit.issues,
      exclusionReasons: audit.missingReasons
    };
  }

  job(id: string): RecomputeJobDto | null {
    const row = this.database
      .prepare("SELECT * FROM recompute_jobs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const events = this.database
      .prepare("SELECT * FROM recompute_job_events WHERE job_id = ? ORDER BY created_at, id")
      .all(id) as Record<string, unknown>[];
    return { ...this.mapJob(row), events: events.map((event) => this.mapJobEvent(event)) };
  }

  private workoutRows(
    where: string,
    params: Array<string | number>,
    limit: number,
    offset: number
  ): WorkoutListItem[] {
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
        JOIN workouts w ON w.id = ts.canonical_workout_id
        LEFT JOIN active_workout_zone_summaries zs ON zs.training_session_id = ts.id
        ${where}
        ORDER BY f.workout_start_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapWorkout(row));
  }

  private mapWorkout(row: Record<string, unknown>): WorkoutListItem {
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

  private dimensions(row: Record<string, unknown>): AbilityMetricSet {
    return {
      efficiency: nullableNumber(row.efficiency_score),
      pace: nullableNumber(row.pace_score),
      cardio: nullableNumber(row.cardio_score),
      stability: nullableNumber(row.stability_score),
      recovery: nullableNumber(row.recovery_score)
    };
  }

  private route(workoutId: string): RoutePointDto[] {
    const points = this.database
      .prepare(`
        SELECT rp.latitude, rp.longitude, rp.elevation_meters, rp.speed_mps, rp.timestamp
        FROM workout_routes wr
        JOIN route_points rp ON rp.route_id = wr.id
        WHERE wr.workout_id = ?
        ORDER BY rp.sequence
      `)
      .all(workoutId) as Record<string, unknown>[];
    const stride = Math.max(1, Math.ceil(points.length / 500));
    return points
      .filter((_, index) => index % stride === 0 || index === points.length - 1)
      .map((row) => ({
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        elevationMeters: nullableNumber(row.elevation_meters),
        speedMetersPerSecond: nullableNumber(row.speed_mps),
        timestamp: typeof row.timestamp === "string" ? row.timestamp : null
      }));
  }

  private metricSeries(
    type: string,
    fallbackUnit: string,
    startedAt: string,
    endedAt: string,
    sourceCategory: string,
    transform: (value: number, row: Record<string, unknown>) => number = (value) => value,
    forceFallbackUnit = false
  ): WorkoutMetricSeries {
    const rows = this.database
      .prepare(`
        SELECT start_at, end_at, value_numeric, unit
        FROM health_records
        WHERE type = ?
          AND source_category = ?
          AND start_at >= ?
          AND start_at <= ?
          AND value_numeric IS NOT NULL
        ORDER BY start_at
      `)
      .all(type, sourceCategory, startedAt, endedAt) as Record<string, unknown>[];
    const stride = Math.max(1, Math.ceil(rows.length / 600));
    return {
      unit: !forceFallbackUnit && typeof rows[0]?.unit === "string" ? rows[0].unit : fallbackUnit,
      totalSamples: rows.length,
      points: rows
        .filter((_, index) => index % stride === 0 || index === rows.length - 1)
        .map((row) => ({
          timestamp: String(row.start_at),
          offsetSeconds: Math.max(0, (Date.parse(String(row.start_at)) - Date.parse(startedAt)) / 1000),
          value: transform(Number(row.value_numeric), row)
        }))
        .filter((point) => Number.isFinite(point.offsetSeconds) && Number.isFinite(point.value))
    };
  }

  private routeMetricSeries(trainingSessionId: string): WorkoutMetricSeries {
    const rows = this.database
      .prepare(`
        SELECT ts.anchor_start_at, rp.timestamp, rp.elevation_meters
        FROM training_sessions ts
        JOIN workout_routes wr ON wr.workout_id = ts.canonical_workout_id
        JOIN route_points rp ON rp.route_id = wr.id
        WHERE ts.id = ? AND rp.timestamp IS NOT NULL AND rp.elevation_meters IS NOT NULL
        ORDER BY rp.sequence
      `)
      .all(trainingSessionId) as Record<string, unknown>[];
    const stride = Math.max(1, Math.ceil(rows.length / 600));
    const startedAt = typeof rows[0]?.anchor_start_at === "string" ? rows[0].anchor_start_at : "";
    return {
      unit: "m",
      totalSamples: rows.length,
      points: rows
        .filter((_, index) => index % stride === 0 || index === rows.length - 1)
        .map((row) => ({
          timestamp: String(row.timestamp),
          offsetSeconds: Math.max(0, (Date.parse(String(row.timestamp)) - Date.parse(startedAt)) / 1000),
          value: Number(row.elevation_meters)
        }))
        .filter((point) => Number.isFinite(point.offsetSeconds) && Number.isFinite(point.value))
    };
  }

  private workoutStatistic(
    workoutId: string,
    type: string,
    preference: "sum" | "average"
  ): number | null {
    const row = this.database
      .prepare(`
        SELECT sum_value, average_value
        FROM workout_statistics
        WHERE workout_id = ? AND type = ?
        ORDER BY ordinal
        LIMIT 1
      `)
      .get(workoutId, type) as Record<string, unknown> | undefined;
    if (!row) return null;
    return preference === "sum"
      ? nullableNumber(row.sum_value) ?? nullableNumber(row.average_value)
      : nullableNumber(row.average_value) ?? nullableNumber(row.sum_value);
  }

  private averageCadence(workoutId: string, durationSeconds: number): number | null {
    const steps = this.workoutStatistic(workoutId, "HKQuantityTypeIdentifierStepCount", "sum");
    return steps !== null && durationSeconds > 0 ? steps / (durationSeconds / 60) : null;
  }

  private elevationGain(workoutId: string): number | null {
    const rows = this.database
      .prepare(`
        SELECT rp.elevation_meters
        FROM workout_routes wr
        JOIN route_points rp ON rp.route_id = wr.id
        WHERE wr.workout_id = ? AND rp.elevation_meters IS NOT NULL
        ORDER BY rp.sequence
      `)
      .all(workoutId) as Record<string, unknown>[];
    if (rows.length < 2) return null;
    let gain = 0;
    let previous = nullableNumber(rows[0]?.elevation_meters);
    for (const row of rows.slice(1)) {
      const current = nullableNumber(row.elevation_meters);
      if (current !== null && previous !== null) {
        const delta = current - previous;
        if (delta > 0 && delta < 30) gain += delta;
      }
      if (current !== null) previous = current;
    }
    return gain;
  }

  private calibrationProgress(): DashboardResponse["calibration"] {
    const active = this.database
      .prepare(`
        SELECT mr.model_config_json, mr.summary_json
        FROM model_runs mr
        JOIN active_model_run amr ON amr.model_run_id = mr.id
      `)
      .get() as Record<string, unknown> | undefined;
    const config = parseJson<{
      calibrationMinimumSessions?: number;
      calibrationMinimumSpanDays?: number;
    }>(active?.model_config_json, {});
    const summary = parseJson<{
      baseline?: { calibrationStartAt?: string; calibrationEndAt?: string };
    }>(active?.summary_json, {});
    const observed = this.database
      .prepare(`
        SELECT COUNT(*) AS sessions,
               SUM(f.duration_seconds) / 60.0 AS duration_minutes,
               MIN(f.workout_start_at) AS first_at,
               MAX(f.workout_start_at) AS last_at,
               SUM(CASE WHEN f.heart_rate_coverage >= 0.8 THEN 1 ELSE 0 END) AS high_coverage
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        WHERE f.eligibility_status = 'eligible'
      `)
      .get() as Record<string, unknown>;
    const first = typeof observed.first_at === "string" ? observed.first_at : null;
    const last = typeof observed.last_at === "string" ? observed.last_at : null;
    const spanDays = first && last
      ? Math.max(0, Math.floor((Date.parse(last) - Date.parse(first)) / 86_400_000))
      : 0;
    const sessions = Number(observed.sessions ?? 0);
    return {
      status: summary.baseline ? "completed" : sessions > 0 ? "calibrating" : "not_started",
      eligibleSessions: sessions,
      eligibleDurationMinutes: Number(observed.duration_minutes ?? 0),
      spanDays,
      highCoverageSessions: Number(observed.high_coverage ?? 0),
      requirements: {
        sessions: config.calibrationMinimumSessions ?? 6,
        durationMinutes: 120,
        spanDays: config.calibrationMinimumSpanDays ?? 14,
        highCoverageSessions: 4
      },
      baselineStartAt: summary.baseline?.calibrationStartAt ?? null,
      baselineEndAt: summary.baseline?.calibrationEndAt ?? null
    };
  }

  private override(id: string): WorkoutOverrideDto | null {
    const row = this.database
      .prepare("SELECT * FROM effective_workout_overrides WHERE training_session_id = ?")
      .get(id) as Record<string, unknown> | undefined;
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
        typeof row.performance_protocol === "string" ? row.performance_protocol as WorkoutOverrideDto["performanceProtocol"] : null,
      rpe: nullableNumber(row.rpe),
      conditionTags: parseJson<string[]>(row.condition_tags_json, []),
      note: typeof row.note === "string" ? row.note : null,
      createdAt: String(row.created_at)
    };
  }

  private trainingLoad(id: string): WorkoutTrainingLoad | null {
    const row = this.database.prepare(`
      SELECT * FROM active_workout_training_loads WHERE training_session_id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? {
      trainingSessionId: String(row.training_session_id), localDate: String(row.local_date),
      distanceMeters: nullableNumber(row.distance_km) === null ? null : Number(row.distance_km) * 1000, durationSeconds: Number(row.duration_seconds),
      load: Number(row.training_load), intensity: Number(row.intensity),
      source: String(row.load_source) as WorkoutTrainingLoad["source"], confidence: Number(row.confidence),
      rpe: nullableNumber(row.rpe), sessionType: String(row.session_type) as WorkoutTrainingLoad["sessionType"],
      averageHeartRate: nullableNumber(row.average_heart_rate_bpm), elevationGainMeters: nullableNumber(row.elevation_gain_meters),
      stimulusType: String(row.stimulus_type ?? "unclassified") as WorkoutTrainingLoad["stimulusType"],
      breakdown: {
        rawHrrTrimp: nullableNumber(row.raw_hrr_trimp),
        internalLoad: nullableNumber(row.internal_load),
        paceLoad: nullableNumber(row.pace_load),
        distanceReferenceMeters: nullableNumber(row.distance_reference_meters),
        distanceExposureRatio: nullableNumber(row.distance_exposure_ratio),
        distanceFactor: Number(row.distance_factor ?? 1),
        compositeLoad: Number(row.training_load),
        heartRateConfidence: Number(row.heart_rate_load_confidence ?? 0),
        paceConfidence: Number(row.pace_load_confidence ?? 0)
      },
      explanations: parseJson<{ explanations?: WorkoutTrainingLoad["explanations"] }>(row.provenance_json, {}).explanations ?? []
    } : null;
  }

  private zoneSummary(id: string): WorkoutZoneSummary | null {
    const row = this.database.prepare(`
      SELECT * FROM active_workout_zone_summaries WHERE training_session_id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      trainingSessionId: String(row.training_session_id),
      zoneProfileId: String(row.zone_profile_id),
      stimulusType: String(row.stimulus_type) as StimulusType,
      secondaryStimulusTypes: parseJson<WorkoutZoneSummary["secondaryStimulusTypes"]>(row.secondary_stimulus_types_json, []),
      stimulusConfidence: Number(row.stimulus_confidence),
      heartRateCoverage: Number(row.heart_rate_coverage),
      paceCoverage: Number(row.pace_coverage),
      heartRateExposure: parseJson<WorkoutZoneSummary["heartRateExposure"]>(row.heart_rate_exposure_json, []),
      paceExposure: parseJson<WorkoutZoneSummary["paceExposure"]>(row.pace_exposure_json, []),
      stimulusScores: parseJson<WorkoutZoneSummary["stimulusScores"]>(row.stimulus_scores_json, []),
      explanationCodes: parseJson<string[]>(row.explanation_codes_json, [])
    };
  }

  private mapZoneProfile(row: Record<string, unknown>): DailyZoneProfile {
    return {
      id: String(row.id),
      localDate: String(row.local_date),
      timezoneIdentifier: String(row.timezone_identifier),
      effectiveAt: String(row.effective_at),
      dataThroughAt: typeof row.data_through_at === "string" ? row.data_through_at : null,
      restingHeartRateBpm: Number(row.resting_heart_rate_bpm),
      maximumHeartRateBpm: Number(row.maximum_heart_rate_bpm),
      lactateThresholdPaceSecondsPerKm: nullableNumber(row.threshold_pace_seconds_per_km),
      heartRateSource: String(row.heart_rate_source) as DailyZoneProfile["heartRateSource"],
      paceSource: String(row.pace_source) as DailyZoneProfile["paceSource"],
      heartRateConfidence: Number(row.heart_rate_confidence),
      paceConfidence: Number(row.pace_confidence),
      status: String(row.profile_status) as DailyZoneProfile["status"],
      heartRateBands: parseJson<DailyZoneProfile["heartRateBands"]>(row.heart_rate_bands_json, []),
      paceBands: parseJson<DailyZoneProfile["paceBands"]>(row.pace_bands_json, []),
      evidence: parseJson<DailyZoneProfile["evidence"]>(row.evidence_json, {
        restingHeartRateDays: 0,
        maximumHeartRateWorkouts: 0,
        thresholdEvidenceCount: 0
      }),
      createdAt: String(row.created_at)
    };
  }

  private zoneProfile(id: string): DailyZoneProfile | null {
    const row = this.database.prepare(`
      SELECT * FROM active_daily_zone_profiles WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapZoneProfile(row) : null;
  }

  private trainingZoneSettings(): TrainingZoneProfileSettings {
    const row = this.database.prepare(`
      SELECT * FROM training_zone_profile_settings ORDER BY revision DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    if (!row) {
      return {
        revision: 0,
        effectiveFromLocalDate: "",
        restingHeartRate: { mode: "auto", valueBpm: null },
        maximumHeartRate: { mode: "auto", valueBpm: null },
        lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null },
        createdAt: ""
      };
    }
    return {
      revision: Number(row.revision),
      effectiveFromLocalDate: String(row.effective_from_local_date),
      restingHeartRate: {
        mode: String(row.resting_mode) as "auto" | "manual",
        valueBpm: nullableNumber(row.resting_value_bpm)
      },
      maximumHeartRate: {
        mode: String(row.maximum_mode) as "auto" | "manual",
        valueBpm: nullableNumber(row.maximum_value_bpm)
      },
      lactateThresholdPace: {
        mode: String(row.threshold_pace_mode) as "auto" | "manual",
        valueSecondsPerKm: nullableNumber(row.threshold_pace_seconds_per_km)
      },
      createdAt: String(row.created_at)
    };
  }

  private latestTrainingMetric(): DailyTrainingMetric | null {
    const row = this.database.prepare(`SELECT * FROM active_daily_training_metrics ORDER BY local_date DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    return row ? this.mapDailyMetric(row) : null;
  }

  private mapDailyMetric(row: Record<string, unknown>): DailyTrainingMetric {
    return {
      localDate: String(row.local_date), distanceMeters: Number(row.distance_km) * 1000, durationSeconds: Number(row.duration_seconds),
      workoutCount: Number(row.workout_count), load: Number(row.daily_load), current7dLoad: Number(row.current_7d_load),
      previous7dLoad: Number(row.previous_7d_load), acuteEwma: Number(row.acute_ewma), chronicEwma: Number(row.chronic_ewma),
      loadRatio: nullableNumber(row.load_ratio), rampRate: Number(row.ramp_rate ?? 0), monotony: nullableNumber(row.monotony),
      strain: nullableNumber(row.strain), recoveryEvidence: nullableNumber(row.recovery_evidence),
      trainingStatus: String(row.training_status) as DailyTrainingMetric["trainingStatus"],
      loadConfidence: nullableNumber(row.confidence),
      statusExplanations: parseJson<DailyTrainingMetric["statusExplanations"]>(row.explanation_json, [])
    };
  }

  private periodSummary(granularity: TrainingPeriodSummary["granularity"], startDate: string, endDate: string, asOf: string): TrainingPeriodSummary {
    const rows = this.database.prepare(`
      SELECT load.*
      FROM active_workout_training_loads load
      WHERE load.local_date BETWEEN ? AND ? ORDER BY load.local_date
    `).all(startDate, endDate) as unknown as Record<string, unknown>[];
    const distance = rows.reduce((sum, row) => sum + Number(row.distance_km ?? 0), 0);
    const duration = rows.reduce((sum, row) => sum + Number(row.duration_seconds ?? 0), 0);
    const load = rows.reduce((sum, row) => sum + Number(row.training_load ?? 0), 0);
    const weightedHrSeconds = rows.reduce((sum, row) => sum + Number(row.average_heart_rate_bpm ?? 0) * Number(row.duration_seconds ?? 0), 0);
    const hrSeconds = rows.reduce((sum, row) => sum + (nullableNumber(row.average_heart_rate_bpm) === null ? 0 : Number(row.duration_seconds ?? 0)), 0);
    const types = new Map<string, { workoutCount: number; distanceKm: number; trainingLoad: number }>();
    const stimuli = new Map<string, { workoutCount: number; distanceKm: number; trainingLoad: number }>();
    for (const row of rows) {
      const key = String(row.session_type); const value = types.get(key) ?? { workoutCount: 0, distanceKm: 0, trainingLoad: 0 };
      value.workoutCount += 1; value.distanceKm += Number(row.distance_km ?? 0); value.trainingLoad += Number(row.training_load ?? 0); types.set(key, value);
      const stimulusKey = String(row.stimulus_type ?? "unclassified");
      const stimulus = stimuli.get(stimulusKey) ?? { workoutCount: 0, distanceKm: 0, trainingLoad: 0 };
      stimulus.workoutCount += 1;
      stimulus.distanceKm += Number(row.distance_km ?? 0);
      stimulus.trainingLoad += Number(row.training_load ?? 0);
      stimuli.set(stimulusKey, stimulus);
    }
    const naturalEnd = granularity === "rolling" ? endDate : this.shiftDate(this.nextPeriod(startDate, granularity), -1);
    return {
      granularity, periodStart: startDate, periodEnd: endDate, isComplete: endDate >= naturalEnd && endDate < asOf,
      distanceMeters: distance * 1000, durationSeconds: duration, workoutCount: rows.length, totalLoad: load,
      elevationGainMeters: rows.reduce((sum, row) => sum + Number(row.elevation_gain_meters ?? 0), 0),
      longestRunMeters: rows.reduce((max, row) => Math.max(max, Number(row.distance_km ?? 0) * 1000), 0),
      averagePaceSecondsPerKm: distance > 0 ? duration / distance : null,
      averageHeartRate: hrSeconds > 0 ? weightedHrSeconds / hrSeconds : null,
      loadConfidence: load > 0
        ? rows.reduce((sum, row) => sum + Number(row.confidence) * Number(row.training_load ?? 0), 0) / load
        : null,
      dataCompleteness: rows.length ? rows.filter((row) => row.load_source !== "session_type").length / rows.length : 0,
      comparison: this.periodComparison(granularity, startDate, endDate, { distance, duration, count: rows.length, load }),
      typeDistribution: [...types].map(([sessionType, value]) => ({
        sessionType: sessionType as WorkoutTrainingLoad["sessionType"],
        workoutCount: value.workoutCount,
        distanceMeters: value.distanceKm * 1000,
        load: value.trainingLoad
      })),
      stimulusDistribution: [...stimuli].map(([stimulusType, value]) => ({
        stimulusType: stimulusType as StimulusType,
        workoutCount: value.workoutCount,
        distanceMeters: value.distanceKm * 1000,
        load: value.trainingLoad
      }))
    };
  }

  private periodComparison(granularity: TrainingPeriodSummary["granularity"], start: string, end: string, current: { distance: number; duration: number; count: number; load: number }): TrainingPeriodSummary["comparison"] {
    const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
    const naturalEnd = granularity === "rolling" ? end : this.shiftDate(this.nextPeriod(start, granularity), -1);
    const previousStart = granularity === "rolling"
      ? this.shiftDate(start, -days)
      : this.previousPeriod(start, granularity);
    const previousEnd = granularity !== "rolling" && end !== naturalEnd
      ? this.shiftDate(previousStart, days - 1)
      : this.shiftDate(start, -1);
    const row = this.database.prepare(`SELECT COALESCE(SUM(distance_km),0) distance, COALESCE(SUM(duration_seconds),0) duration, COUNT(*) count, COALESCE(SUM(training_load),0) load FROM active_workout_training_loads WHERE local_date BETWEEN ? AND ?`)
      .get(previousStart, previousEnd) as Record<string, unknown>;
    const fraction = (value: number, previous: number): number | null => previous > 0 ? (value - previous) / previous : null;
    return { distanceChangeFraction: fraction(current.distance, Number(row.distance)), durationChangeFraction: fraction(current.duration, Number(row.duration)), workoutCountChangeFraction: fraction(current.count, Number(row.count)), loadChangeFraction: fraction(current.load, Number(row.load)) };
  }

  private periodStart(date: string, granularity: TrainingStatisticsGranularity): string {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (granularity === "week") parsed.setUTCDate(parsed.getUTCDate() - ((parsed.getUTCDay() + 6) % 7));
    if (granularity === "month") parsed.setUTCDate(1);
    if (granularity === "year") { parsed.setUTCMonth(0); parsed.setUTCDate(1); }
    return parsed.toISOString().slice(0, 10);
  }
  private shiftDate(date: string, days: number): string { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
  private nextPeriod(start: string, granularity: TrainingStatisticsGranularity): string { const value = new Date(`${start}T00:00:00Z`); if (granularity === "week") value.setUTCDate(value.getUTCDate() + 7); if (granularity === "month") value.setUTCMonth(value.getUTCMonth() + 1); if (granularity === "year") value.setUTCFullYear(value.getUTCFullYear() + 1); return value.toISOString().slice(0, 10); }
  private previousPeriod(start: string, granularity: TrainingStatisticsGranularity): string { const value = new Date(`${start}T00:00:00Z`); if (granularity === "week") value.setUTCDate(value.getUTCDate() - 7); if (granularity === "month") value.setUTCMonth(value.getUTCMonth() - 1); if (granularity === "year") value.setUTCFullYear(value.getUTCFullYear() - 1); return value.toISOString().slice(0, 10); }

  private activeModel(): ModelRunSummary | null {
    const row = this.database
      .prepare(`
        SELECT mr.*, 1 AS active,
               (SELECT COUNT(*) FROM ability_assessments a WHERE a.model_run_id = mr.id) AS assessment_count,
               (SELECT COUNT(*) FROM daily_ability_snapshots s WHERE s.model_run_id = mr.id) AS snapshot_count
        FROM model_runs mr
        JOIN active_model_run amr ON amr.model_run_id = mr.id
      `)
      .get() as Record<string, unknown> | undefined;
    return row ? this.mapModel(row) : null;
  }

  private mapModel(row: Record<string, unknown>): ModelRunSummary {
    const summary = parseJson<{ featureCount?: number }>(row.summary_json, {});
    return {
      id: String(row.id),
      featureRunId: String(row.feature_run_id),
      datasetVersion: String(row.dataset_version),
      modelVersion: String(row.model_version),
      modelConfigHash: String(row.model_config_hash),
      evaluatedAt: String(row.evaluated_at),
      status: String(row.status),
      createdAt: String(row.created_at),
      completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
      featureCount: typeof summary.featureCount === "number" ? summary.featureCount : null,
      assessmentCount: Number(row.assessment_count ?? 0),
      snapshotCount: Number(row.snapshot_count ?? 0),
      active: Number(row.active) === 1
    };
  }

  private mapJob(row: Record<string, unknown>): RecomputeJobDto {
    return {
      id: String(row.id),
      jobType: String(row.job_type),
      status: String(row.status),
      progressPhase: String(row.progress_phase),
      progressCurrent: Number(row.progress_current ?? 0),
      progressTotal: Number(row.progress_total ?? 0),
      cancelRequested: Number(row.cancel_requested) === 1,
      modelRunId: typeof row.model_run_id === "string" ? row.model_run_id : null,
      error: parseJson<Record<string, unknown> | null>(row.error_json, null),
      createdAt: String(row.created_at),
      startedAt: typeof row.started_at === "string" ? row.started_at : null,
      completedAt: typeof row.completed_at === "string" ? row.completed_at : null
    };
  }

  private mapJobEvent(row: Record<string, unknown>): RecomputeJobEventDto {
    return {
      id: String(row.id),
      phase: String(row.phase),
      progressCurrent: Number(row.progress_current ?? 0),
      progressTotal: Number(row.progress_total ?? 0),
      message: String(row.message),
      createdAt: String(row.created_at)
    };
  }
}
