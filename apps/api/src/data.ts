import type { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import {
  RaiDatabase,
  RecomputeJobRepository,
  SqliteAuditReadRepository,
  SqliteDashboardReadRepository,
  SqliteModelRunRepository,
  SqliteSeriesReadRepository,
  SqliteTrainingStatisticsReadRepository,
  SqliteTrendsReadRepository,
  SqliteWorkoutReadRepository,
  SqliteZoneReadRepository,
  type StoredWorkoutListItem
} from "@rai/storage-sqlite";

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

const paceSeconds = (duration: number, distance: number | null): number | null =>
  distance !== null && distance > 0 ? duration / distance : null;

export class RaiReadStore {
  private readonly database: DatabaseSync;
  private readonly modelRunsRepository: SqliteModelRunRepository;
  private readonly jobsRepository: RecomputeJobRepository;
  private readonly dashboardRepository: SqliteDashboardReadRepository;
  private readonly workoutsRepository: SqliteWorkoutReadRepository;
  private readonly zonesRepository: SqliteZoneReadRepository;
  private readonly statisticsRepository: SqliteTrainingStatisticsReadRepository;
  private readonly seriesRepository: SqliteSeriesReadRepository;
  private readonly trendsRepository: SqliteTrendsReadRepository;
  private readonly auditRepository: SqliteAuditReadRepository;
  private cacheVersion = -1;
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly path: string) {
    this.database = RaiDatabase.openReadonly(path);
    this.modelRunsRepository = new SqliteModelRunRepository(this.database);
    this.jobsRepository = new RecomputeJobRepository(this.database);
    this.dashboardRepository = new SqliteDashboardReadRepository(this.database);
    this.workoutsRepository = new SqliteWorkoutReadRepository(this.database);
    this.zonesRepository = new SqliteZoneReadRepository(this.database);
    this.statisticsRepository = new SqliteTrainingStatisticsReadRepository(this.database);
    this.seriesRepository = new SqliteSeriesReadRepository(this.database);
    this.trendsRepository = new SqliteTrendsReadRepository(this.database);
    this.auditRepository = new SqliteAuditReadRepository(this.database);
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
    const latestSnapshot = this.dashboardRepository.latestAbilitySnapshot();
    const sevenDaysAgo = latestSnapshot
      ? this.dashboardRepository.abilitySnapshotOnOrBefore(latestSnapshot.localDate, 7)
      : null;
    const latest =
      this.toWorkoutListItem(
        this.workoutsRepository.list("WHERE a.assessment_status = 'eligible'", [], 1, 0)[0]
      ) ??
      this.toWorkoutListItem(this.workoutsRepository.list("", [], 1, 0)[0]) ??
      null;
    const latestAssessment = latest
      ? this.dashboardRepository.assessmentDimensions(latest.id)
      : null;
    const totals = this.dashboardRepository.eligibilityTotals();
    return {
      generatedAt: new Date().toISOString(),
      activeModel: this.activeModel(),
      latestSnapshot: latestSnapshot
        ? {
            localDate: latestSnapshot.localDate,
            trueAbility: latestSnapshot.trueAbility,
            decayPoints: latestSnapshot.decayPoints,
            growthVelocityPerWeek: latestSnapshot.growthVelocityPerWeek,
            changeFrom7DaysAgo:
              latestSnapshot.trueAbility !== null &&
              sevenDaysAgo !== null &&
              sevenDaysAgo.trueAbility !== null
                ? latestSnapshot.trueAbility - sevenDaysAgo.trueAbility
                : null,
            status: latestSnapshot.status
          }
        : null,
      latestWorkout: latest,
      dimensions: latestAssessment
        ? {
            efficiency: latestAssessment.efficiency,
            pace: latestAssessment.pace,
            cardio: latestAssessment.cardio,
            stability: latestAssessment.stability,
            recovery: latestAssessment.recovery
          }
        : null,
      explanationCodes: latestAssessment?.explanationCodes ?? [],
      totals,
      calibration: this.dashboardRepository.calibrationProgress(),
      recentWorkouts: this.workoutsRepository.list("", [], 6, 0).map((item) => this.toWorkoutListItem(item)!),
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
    const result = this.workoutsRepository.listByQuery(query);
    return {
      items: result.items.map((item) => this.toWorkoutListItem(item)!),
      total: result.total,
      limit: query.limit,
      offset: query.offset
    };
  }

  workout(id: string): WorkoutDetailResponse | null {
    const row = this.workoutsRepository.getDetailRow(id);
    if (!row) return null;
    const zoneSummary = this.zonesRepository.workoutZoneSummary(id);
    const duration = row.durationSeconds;
    const distance = row.distanceKm;
    const workout: WorkoutDetailResponse["workout"] = {
      id: row.sessionId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSeconds: duration,
      distanceKm: distance,
      averagePaceSecondsPerKm: paceSeconds(duration, distance),
      averageHeartRateBpm: row.averageHeartRateBpm,
      indoor: row.indoor,
      sourceCategory: row.sourceCategory,
      sessionType: row.sessionType,
      stimulusType: zoneSummary?.stimulusType ?? "unclassified",
      stimulusConfidence: zoneSummary?.stimulusConfidence ?? null,
      eligibilityStatus: row.eligibilityStatus,
      assessmentStatus: row.assessmentStatus,
      missingReasons: row.missingReasons,
      qualityScore: row.qualityScore,
      currentAbility: row.currentAbility,
      confidence: row.confidence,
      trueAbilityDelta: row.trueAbilityDelta,
      hasRoute: row.hasRoute,
      elapsedSeconds: Math.max(0, (Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000),
      activeEnergyKcal: this.workoutsRepository.workoutStatistic(
        row.canonicalWorkoutId,
        "HKQuantityTypeIdentifierActiveEnergyBurned",
        "sum"
      ),
      elevationGainMeters: this.workoutsRepository.elevationGain(row.canonicalWorkoutId),
      averageCadenceSpm: this.workoutsRepository.averageCadence(row.canonicalWorkoutId, duration),
      averagePowerWatts: this.workoutsRepository.workoutStatistic(
        row.canonicalWorkoutId,
        "HKQuantityTypeIdentifierRunningPower",
        "average"
      ),
      averageStrideLengthMeters: this.workoutsRepository.workoutStatistic(
        row.canonicalWorkoutId,
        "HKQuantityTypeIdentifierRunningStrideLength",
        "average"
      ),
      averageVerticalOscillationCm: this.workoutsRepository.workoutStatistic(
        row.canonicalWorkoutId,
        "HKQuantityTypeIdentifierRunningVerticalOscillation",
        "average"
      ),
      averageGroundContactTimeMs: this.workoutsRepository.workoutStatistic(
        row.canonicalWorkoutId,
        "HKQuantityTypeIdentifierRunningGroundContactTime",
        "average"
      ),
      modelVersion: row.modelVersion,
      updatedTrueAbility: row.updatedTrueAbility,
      heartRateCoverage: row.heartRateCoverage,
      heartRateSampleCount: row.heartRateSampleCount,
      routeQuality: row.routeQuality,
      routePointCount: row.routePointCount,
      sourceConfidence: row.sourceConfidence,
      effectiveWeights: row.effectiveWeights,
      confidenceFactors: row.confidenceFactors,
      explanationCodes: row.explanationCodes,
      explanation: row.explanation,
      trueAbilityBefore: row.trueAbilityBefore,
      trueAbilityAfter: row.trueAbilityAfter,
      workoutContribution: row.workoutContribution
    };
    return {
      workout,
      dimensions: row.dimensions,
      route: this.seriesRepository.routePoints(row.canonicalWorkoutId) as RoutePointDto[],
      override: this.mapOverride(this.workoutsRepository.override(id)),
      trainingLoad: this.workoutsRepository.trainingLoad(id),
      zoneSummary,
      zoneProfile: zoneSummary ? this.zonesRepository.profileById(zoneSummary.zoneProfileId) : null
    };
  }

  trainingZonesCurrent(): TrainingZonesCurrentResponse | null {
    const profile = this.zonesRepository.latestProfile();
    if (!profile) return null;
    return {
      generatedAt: new Date().toISOString(),
      profile,
      settings: this.zonesRepository.settings(),
      previousProfile: this.zonesRepository.previousProfile(profile.localDate)
    };
  }

  trainingZonesHistory(days: number): TrainingZonesHistoryResponse {
    return {
      generatedAt: new Date().toISOString(),
      profiles: this.zonesRepository.history(days)
    };
  }

  trainingStatisticsOverview(): TrainingStatisticsOverviewResponse {
    const overview = this.statisticsRepository.overview();
    return {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      status: overview.status,
      statusConfidence: overview.rolling7Days.loadConfidence,
      week: overview.week,
      month: overview.month,
      year: overview.year,
      rolling7Days: overview.rolling7Days,
      rolling28Days: overview.rolling28Days
    };
  }

  trainingStatisticsHistory(
    granularity: TrainingStatisticsGranularity,
    limit: number
  ): TrainingStatisticsHistoryResponse {
    return {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      granularity,
      periods: this.statisticsRepository.history(granularity, limit)
    };
  }

  trainingLoadTimeline(days: number): TrainingLoadTimelineResponse {
    const timeline = this.statisticsRepository.loadTimeline(days);
    if (!timeline) {
      return { generatedAt: new Date().toISOString(), timezone: "Asia/Shanghai", days: [], components: [] };
    }
    return {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      days: timeline.days,
      components: timeline.components
    };
  }

  workoutSeries(id: string): WorkoutSeriesResponse | null {
    const session = this.seriesRepository.sessionForSeries(id);
    if (!session) return null;
    const { startedAt, endedAt, sourceCategory, sourceName, distanceKm } = session;
    return {
      trainingSessionId: id,
      startedAt,
      endedAt,
      sourceCategory,
      splits: this.seriesRepository.workoutSplits(startedAt, endedAt, sourceName, distanceKm),
      series: {
        heartRate: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierHeartRate",
            "count/min",
            startedAt,
            endedAt,
            sourceCategory
          )
        ),
        speed: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierRunningSpeed",
            "km/hr",
            startedAt,
            endedAt,
            sourceCategory
          )
        ),
        power: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierRunningPower",
            "W",
            startedAt,
            endedAt,
            sourceCategory
          )
        ),
        cadence: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierStepCount",
            "spm",
            startedAt,
            endedAt,
            sourceCategory,
            (value, row) => {
              const seconds = Math.max(
                1,
                (Date.parse(String(row.end_at)) - Date.parse(String(row.start_at))) / 1000
              );
              return value / (seconds / 60);
            },
            true
          )
        ),
        elevation: this.asMetricSeries(this.seriesRepository.routeElevationSeries(id)),
        strideLength: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierRunningStrideLength",
            "m",
            startedAt,
            endedAt,
            sourceCategory
          )
        ),
        verticalOscillation: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierRunningVerticalOscillation",
            "cm",
            startedAt,
            endedAt,
            sourceCategory
          )
        ),
        groundContactTime: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierRunningGroundContactTime",
            "ms",
            startedAt,
            endedAt,
            sourceCategory
          )
        )
      }
    };
  }

  trends(days: number): TrendResponse {
    return this.trendsRepository.load(days);
  }

  modelRuns(limit = 30): ModelRunSummary[] {
    return this.modelRunsRepository.listSummaries(limit);
  }

  compareModelRuns(baseId: string, candidateId: string): ModelRunComparisonResponse | null {
    const summaries = this.modelRunsRepository.getSummariesByIds([baseId, candidateId]);
    const baseSummary = summaries.find((row) => row.id === baseId);
    const candidateSummary = summaries.find((row) => row.id === candidateId);
    if (!baseSummary || !candidateSummary) return null;
    const toDto = (summary: typeof baseSummary): ModelRunSummary => ({
      id: summary.id,
      featureRunId: summary.featureRunId,
      datasetVersion: summary.datasetVersion,
      modelVersion: summary.modelVersion,
      modelConfigHash: summary.modelConfigHash,
      evaluatedAt: summary.evaluatedAt,
      status: summary.status,
      createdAt: summary.createdAt,
      completedAt: summary.completedAt,
      featureCount: summary.featureCount,
      assessmentCount: summary.assessmentCount,
      snapshotCount: summary.snapshotCount,
      active: summary.active
    });
    const comparison = this.modelRunsRepository.compareMetrics(baseId, candidateId);
    return {
      base: toDto(baseSummary),
      candidate: toDto(candidateSummary),
      metrics: {
        matchedSessions: comparison.matchedSessions,
        currentAbilityMeanDelta: comparison.currentAbilityMeanDelta,
        currentAbilityMeanAbsoluteDelta: comparison.currentAbilityMeanAbsoluteDelta,
        confidenceMeanDelta: comparison.confidenceMeanDelta,
        finalTrueAbilityDelta: comparison.finalTrueAbilityDelta,
        assessmentStatusChanged: comparison.assessmentStatusChanged
      },
      topChangedWorkouts: comparison.topChangedWorkouts
    };
  }

  jobs(limit = 30, activeOnly = false): RecomputeJobDto[] {
    return this.jobsRepository.list(limit, activeOnly).map((job) => this.mapJobFromDomain(job));
  }

  dataSummary(): DataSummaryResponse {
    return this.cached("data-summary", () => {
      const summary = this.auditRepository.dataSummary();
      return {
        databaseBytes: statSync(this.path).size,
        datasetVersion: summary.datasetVersion,
        importCompletedAt: summary.importCompletedAt,
        counts: summary.counts,
        issues: summary.issues
      };
    });
  }

  dataAudit(): DataAuditResponse {
    return this.cached("data-audit", () => this.auditRepository.dataAudit());
  }

  diagnostics(): DiagnosticExportResponse {
    const summary = this.dataSummary();
    const audit = this.dataAudit();
    const active = this.auditRepository.diagnosticsActiveModel();
    const modelSummary = parseJson<{
      baseline?: { calibrationFeatureIds?: string[] };
    }>(active?.summaryJson, {});
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
      activeModel: active
        ? {
            id: active.id,
            modelVersion: active.modelVersion,
            modelConfigHash: active.modelConfigHash,
            featureRunId: active.featureRunId,
            calibrationFeatureIds: modelSummary.baseline?.calibrationFeatureIds ?? []
          }
        : null,
      calibration: active ? this.dashboardRepository.calibrationProgress() : null,
      jobs: this.jobs(20),
      issues: audit.issues,
      exclusionReasons: audit.missingReasons
    };
  }

  job(id: string): RecomputeJobDto | null {
    const job = this.jobsRepository.get(id);
    if (!job) return null;
    const events = this.jobsRepository.listEvents(id);
    return { ...this.mapJobFromDomain(job), events: events.map((event) => this.mapJobEvent(event)) };
  }

  private toWorkoutListItem(item: StoredWorkoutListItem | undefined): WorkoutListItem | null {
    if (!item) return null;
    return { ...item };
  }

  private asMetricSeries(series: {
    unit: string;
    totalSamples: number;
    points: Array<{ timestamp: string; offsetSeconds: number; value: number }>;
  }): WorkoutMetricSeries {
    return series;
  }

  private mapOverride(
    override: ReturnType<SqliteWorkoutReadRepository["override"]>
  ): WorkoutOverrideDto | null {
    if (!override) return null;
    return {
      revision: override.revision,
      eligibilityOverride: override.eligibilityOverride,
      statisticsParticipation: override.statisticsParticipation,
      sessionType: override.sessionType,
      performanceProtocol: override.performanceProtocol as WorkoutOverrideDto["performanceProtocol"],
      rpe: override.rpe,
      conditionTags: override.conditionTags,
      note: override.note,
      createdAt: override.createdAt
    };
  }

  private activeModel(): ModelRunSummary | null {
    return this.modelRunsRepository.activeSummary();
  }

  private mapJobFromDomain(job: {
    id: string;
    jobType: string;
    status: string;
    progressPhase: string;
    progressCurrent: number;
    progressTotal: number;
    cancelRequested: boolean;
    modelRunId: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  }): RecomputeJobDto {
    const failed = job.status === "failed";
    return {
      id: job.id,
      jobType: job.jobType,
      status: job.status,
      progressPhase: job.progressPhase,
      progressCurrent: job.progressCurrent,
      progressTotal: job.progressTotal,
      cancelRequested: job.cancelRequested,
      modelRunId: job.modelRunId,
      error: failed ? { code: "task_failed", message: "任务执行失败" } : null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt
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

// Keep type re-exports used by callers that previously inferred from private helpers.
export type {
  AbilityMetricSet,
  DailyTrainingMetric,
  DailyZoneProfile,
  TrainingPeriodSummary,
  TrainingZoneProfileSettings,
  WorkoutTrainingLoad,
  WorkoutZoneSummary
};
