import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
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
  SqliteRecoveryFactsReadRepository,
  type StoredWorkoutListItem
} from "@rai/storage-sqlite";

import type {
  AbilityMetricSet,
  DataSummaryResponse,
  DataAuditResponse,
  DashboardResponse,
  DiagnosticExportResponse,
  MobileGoalsResponse,
  MobileStatisticsResponse,
  MobileTodayResponse,
  MobileTrendsResponse,
  MobileWorkoutPlanResponse,
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
  RecoveryTrendResponse,
  TrendResponse,
  WorkoutDetailResponse,
  WorkoutMetricSeries,
  WorkoutListItem,
  WorkoutListResponse,
  WorkoutOverrideDto,
  WorkoutZoneSummary,
  WorkoutSeriesResponse
} from "@rai/api-contracts";
import { buildPlanExecution } from "./plan-execution.js";
import type { PlanHistoryRevision } from "./mobile-goals.js";
import { assembleMobileCoach, assembleMobileWorkoutPlan, zonePrescription } from "./mobile-read.js";
import { DEFAULT_EASY_DURATION_FLOOR, DEFAULT_QUALITY_SESSION_CAP } from "./mobile-coach.js";
import {
  matchPlanDay,
  measuredStepsOf,
  resolveSegmentation,
  toWorkoutSegments,
  type MatchedPlanDay,
  type PlanCandidateDay
} from "./workout-segments.js";

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

const localDateInShanghai = (value: Date): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(value);

export const mobileLocalDate = (): string => localDateInShanghai(new Date());

const shiftMobileDate = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/** Monday of the ISO week containing `date`. */
const mobileWeekStart = (date: string): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
};

/**
 * Why a run has no segments.
 *
 * Empty segments are a legitimate outcome — a treadmill run has no Watch lap
 * events and may match no plan — but an unexplained blank panel reads as a bug.
 * The plan is named first because it is now the primary producer: reaching this
 * function with a matched plan means the plan, not the Watch, was the constraint.
 */
const missingSegmentsNote = (eventCount: number, plan: MatchedPlanDay | null): string => {
  if (plan !== null) return "匹配到的课表结构不足以形成分段（至少需要两个步骤）";
  if (eventCount > 0) return "手表记录的 lap/segment 事件不足两段，无法形成分段";
  return "这次训练没有手表 lap/segment 事件，也没有可匹配的课表，只能按公里分段";
};

interface ZoneExposureRow {
  zone: string;
  durationSeconds: number;
}

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
  private readonly recoveryRepository: SqliteRecoveryFactsReadRepository;
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
    this.recoveryRepository = new SqliteRecoveryFactsReadRepository(this.database);
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

  mobileToday(
    goalDistanceKm: number | null,
    goals?: Pick<MobileGoalsResponse, "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget" | "weekPlan" | "lockedSession">,
    planHistory?: PlanHistoryRevision[]
  ): MobileTodayResponse {
    const today = mobileLocalDate();
    const weekStart = mobileWeekStart(today);
    const weekEnd = shiftMobileDate(weekStart, 6);

    const anchorRow = this.database.prepare(`
      SELECT MAX(local_date) AS anchor FROM active_workout_training_loads
    `).get() as Record<string, unknown> | undefined;
    const latestDataDate = anchorRow && anchorRow.anchor != null ? String(anchorRow.anchor) : null;
    const syncRow = this.database.prepare(`
      SELECT value FROM import_manifest WHERE key = 'import_completed_at'
    `).get() as { value?: string } | undefined;
    const lastSyncedAt = typeof syncRow?.value === "string" ? syncRow.value : null;
    const recoveryRow = this.database.prepare(`
      SELECT MAX(wake_date) AS recovery_date
      FROM canonical_nights
      WHERE kind = 'main' AND timezone_identifier = 'Asia/Shanghai'
    `).get() as { recovery_date?: string } | undefined;
    const recoveryDate = recoveryRow?.recovery_date ?? null;

    const todayRow = this.database.prepare(`
      SELECT
        COALESCE(SUM(distance_km), 0) AS distance_km,
        COALESCE(SUM(duration_seconds), 0) AS duration_seconds,
        COUNT(*) AS workout_count
      FROM active_workout_training_loads
      WHERE local_date = ?
    `).get(today) as Record<string, unknown>;
    const todayEnergy = this.database.prepare(`
      SELECT COALESCE(SUM(stat.sum_value), 0) AS energy_kcal
      FROM active_workout_training_loads load
      JOIN training_sessions ts ON ts.id = load.training_session_id
      JOIN workout_statistics stat ON stat.workout_id = ts.canonical_workout_id
        AND stat.type = 'HKQuantityTypeIdentifierActiveEnergyBurned'
      WHERE load.local_date = ?
    `).get(today) as Record<string, unknown>;

    const dailyRows = this.database.prepare(`
      SELECT
        local_date,
        COALESCE(SUM(distance_km), 0) AS distance_km,
        COUNT(*) AS workout_count
      FROM active_workout_training_loads
      WHERE local_date BETWEEN ? AND ?
      GROUP BY local_date
      ORDER BY local_date
    `).all(weekStart, weekEnd) as unknown as Array<Record<string, unknown>>;
    const dailyByDate = new Map(dailyRows.map((row) => [String(row.local_date), row]));
    const weekDaily: MobileTodayResponse["weekDaily"] = [];
    for (let cursor = weekStart; cursor <= weekEnd; cursor = shiftMobileDate(cursor, 1)) {
      const row = dailyByDate.get(cursor);
      weekDaily.push({
        localDate: cursor,
        distanceKm: row ? Number(row.distance_km ?? 0) : 0,
        workoutCount: row ? Number(row.workout_count ?? 0) : 0
      });
    }

    const weekRow = this.database.prepare(`
      SELECT
        COALESCE(SUM(distance_km), 0) AS distance_km,
        COALESCE(SUM(duration_seconds), 0) AS duration_seconds,
        COUNT(*) AS workout_count
      FROM active_workout_training_loads
      WHERE local_date BETWEEN ? AND ?
    `).get(weekStart, weekEnd) as Record<string, unknown>;

    const weekDistanceKm = Number(weekRow.distance_km ?? 0);
    const recentWorkouts = this.workoutsRepository.list("", [], 5, 0).map((item) => this.toWorkoutListItem(item)!);
    const priorFourStart = shiftMobileDate(weekStart, -56);
    const priorFourEnd = shiftMobileDate(weekStart, -29);
    const recentFourStart = shiftMobileDate(weekStart, -28);
    const recentFourEnd = shiftMobileDate(weekStart, -1);
    const volumeRows = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN local_date BETWEEN ? AND ? THEN distance_km ELSE 0 END), 0) AS recent_km,
        COALESCE(SUM(CASE WHEN local_date BETWEEN ? AND ? THEN distance_km ELSE 0 END), 0) AS previous_km
      FROM active_workout_training_loads
    `).get(recentFourStart, recentFourEnd, priorFourStart, priorFourEnd) as Record<string, unknown>;
    const previousFourKm = Number(volumeRows.previous_km ?? 0);
    const recentFourKm = Number(volumeRows.recent_km ?? 0);
    const fourWeekDistanceChangeFraction = previousFourKm > 0 ? (recentFourKm - previousFourKm) / previousFourKm : null;
    const dashboard = this.dashboard();
    const latestMetric = this.statisticsRepository.latestMetric();
    const metricEnd = latestMetric?.localDate ?? latestDataDate ?? today;
    const recentMetrics = this.statisticsRepository.metricsBetween(shiftMobileDate(metricEnd, -56), metricEnd);
    const week = {
      periodStart: weekStart,
      periodEnd: weekEnd,
      distanceKm: weekDistanceKm,
      durationSeconds: Number(weekRow.duration_seconds ?? 0),
      workoutCount: Number(weekRow.workout_count ?? 0),
      goalDistanceKm: goalDistanceKm,
      goalProgressFraction:
        goalDistanceKm !== null && goalDistanceKm > 0
          ? Math.min(1, weekDistanceKm / goalDistanceKm)
          : null
    };
    const coach = assembleMobileCoach({
      database: this.database,
      dashboard,
      latestMetric,
      recentMetrics,
      zones: this.trainingZonesCurrent(),
      recentWorkouts,
      week,
      weekDaily,
      today,
      latestDataDate,
      goals: {
        easyDurationFloorFraction: goals?.easyDurationFloorFraction ?? DEFAULT_EASY_DURATION_FLOOR,
        qualitySessionCap: goals?.qualitySessionCap ?? DEFAULT_QUALITY_SESSION_CAP,
        raceTarget: goals?.raceTarget ?? null,
        weekPlan: goals?.weekPlan ?? [],
        lockedSession: goals?.lockedSession ?? null
      },
      fourWeekDistanceChangeFraction,
      previousWeekDistanceKm: this.previousWeekDistanceKm(today)
    });
    const recentPlanExecution = planHistory === undefined ? undefined : buildPlanExecution(today, planHistory,
      this.database.prepare(`
        SELECT local_date AS localDate, SUM(distance_km) AS distanceKm, COUNT(*) AS workoutCount
        FROM active_workout_training_loads WHERE local_date >= ? AND local_date < ? GROUP BY local_date
      `).all(shiftMobileDate(today, -7), today) as Array<{ localDate: string; distanceKm: number; workoutCount: number }>
    );
    const freshness: MobileTodayResponse["freshness"] = {
      state: lastSyncedAt == null ? "unknown" : recoveryDate === today ? "valid" : "stale",
      checkedAt: lastSyncedAt,
      latestTrainingDate: latestDataDate,
      recoveryDate
    };
    const recommendationRevision = createHash("sha256")
      .update(JSON.stringify({
        today,
        latestDataDate,
        recoveryDate,
        freshness: freshness.state,
        verdict: coach.verdict,
        nextSession: coach.nextSession,
        activeModel: dashboard.activeModel?.id ?? null
      }))
      .digest("hex");
    return {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      latestDataDate,
      lastSyncedAt,
      freshness,
      recommendationRevision,
      ...(recentPlanExecution === undefined ? {} : { recentPlanExecution }),
      today: {
        localDate: today,
        distanceKm: Number(todayRow.distance_km ?? 0),
        durationSeconds: Number(todayRow.duration_seconds ?? 0),
        paceSecondsPerKm: paceSeconds(
          Number(todayRow.duration_seconds ?? 0),
          Number(todayRow.distance_km ?? 0) > 0 ? Number(todayRow.distance_km) : null
        ),
        energyKcal: Number(todayEnergy.energy_kcal ?? 0) > 0 ? Number(todayEnergy.energy_kcal) : null,
        workoutCount: Number(todayRow.workout_count ?? 0)
      },
      week,
      weekDaily,
      recentWorkouts,
      ...coach
    };
  }

  /**
   * Executable week for the WorkoutKit bridge. Reuses `mobileToday` so today's
   * row always carries the gate-resolved, lock-applied prescription.
   */
  mobileWorkoutPlan(
    goalDistanceKm: number | null,
    goals?: Pick<
      MobileGoalsResponse,
      "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget" | "weekPlan" | "lockedSession" | "weekPlanAudit" | "revision"
    >
  ): MobileWorkoutPlanResponse {
    const today = this.mobileToday(goalDistanceKm, goals);
    return assembleMobileWorkoutPlan({
      today: today.today.localDate,
      todaySession: today.nextSession,
      todayCompleted: today.today.workoutCount > 0,
      storedPlan: goals?.weekPlan ?? [],
      zones: this.trainingZonesCurrent(),
      audit: goals?.weekPlanAudit ?? null,
      planRevision: goals?.revision ?? 0
    });
  }

  /**
   * Same coach snapshot the today endpoint returns, plus everything the weekly
   * plan generator needs. Reusing `mobileToday` keeps the gate rules in one
   * place; the previous week's volume travels with it because the generator's
   * ramp ceiling is `previous week + 30%`.
   */
  mobileWeeklyPlanInputs(
    goalDistanceKm: number | null,
    goals?: Pick<
      MobileGoalsResponse,
      "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget" | "weekPlan" | "lockedSession" | "weekPlanAudit" | "revision"
    >,
    planHistory?: PlanHistoryRevision[]
  ): {
    today: MobileTodayResponse;
    prescription: ReturnType<typeof zonePrescription>;
    previousWeekDistanceKm: number;
  } {
    const today = this.mobileToday(goalDistanceKm, goals, planHistory);
    return {
      today,
      prescription: zonePrescription(this.trainingZonesCurrent()),
      previousWeekDistanceKm: this.previousWeekDistanceKm(today.today.localDate)
    };
  }

  /**
   * Zone prescription used to turn a stored plan day's structure back into the
   * distance it actually amounts to. Exposed so the goals writer can re-measure
   * a merged day with exactly the paces the read paths use.
   */
  mobilePlanPrescription(): ReturnType<typeof zonePrescription> {
    return zonePrescription(this.trainingZonesCurrent());
  }

  /**
   * Distance actually run in the seven days before the week containing `date`.
   * Shared by the coach (volume-ramp flag) and the weekly plan generator so both
   * read the same number.
   */
  private previousWeekDistanceKm(date: string): number {
    const weekStart = mobileWeekStart(date);
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(distance_km), 0) AS distance_km
      FROM active_workout_training_loads
      WHERE local_date BETWEEN ? AND ?
    `).get(shiftMobileDate(weekStart, -7), shiftMobileDate(weekStart, -1)) as Record<string, unknown>;
    return Number(row.distance_km ?? 0);
  }

  mobileStatistics(): MobileStatisticsResponse {
    const today = mobileLocalDate();
    const anchorRow = this.database.prepare(`
      SELECT COALESCE(MAX(local_date), ?) AS anchor FROM active_workout_training_loads
    `).get(today) as Record<string, unknown>;
    const anchor = String(anchorRow.anchor ?? today);
    const threeMonthsAgo = shiftMobileDate(`${anchor.slice(0, 7)}-01`, -62).slice(0, 7);

    const monthRows = this.database.prepare(`
      SELECT
        substr(load.local_date, 1, 7) AS month,
        COALESCE(SUM(CASE WHEN ts.activity_type LIKE '%Running%' THEN load.distance_km ELSE 0 END), 0) AS running_km,
        COALESCE(SUM(CASE WHEN ts.activity_type LIKE '%Cycling%' THEN load.distance_km ELSE 0 END), 0) AS cycling_km,
        COALESCE(SUM(load.distance_km), 0) AS total_km,
        COALESCE(SUM(load.duration_seconds), 0) AS duration_seconds,
        COUNT(*) AS workout_count
      FROM active_workout_training_loads load
      JOIN training_sessions ts ON ts.id = load.training_session_id
      WHERE substr(load.local_date, 1, 7) >= ?
      GROUP BY month
      ORDER BY month DESC
      LIMIT 3
    `).all(threeMonthsAgo) as unknown as Array<Record<string, unknown>>;

    const rollingRows = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN local_date > ? THEN distance_km ELSE 0 END), 0) AS current_km,
        COALESCE(SUM(CASE WHEN local_date <= ? THEN distance_km ELSE 0 END), 0) AS previous_km,
        COALESCE(SUM(CASE WHEN local_date > ? THEN duration_seconds ELSE 0 END), 0) AS duration_seconds,
        COALESCE(SUM(CASE WHEN local_date > ? THEN 1 ELSE 0 END), 0) AS workout_count
      FROM active_workout_training_loads
      WHERE local_date > ?
    `).get(
      shiftMobileDate(anchor, -28), shiftMobileDate(anchor, -28), shiftMobileDate(anchor, -28),
      shiftMobileDate(anchor, -28), shiftMobileDate(anchor, -56)
    ) as Record<string, unknown>;

    const zoneTotals = new Map<string, number>();
    const exposureRows = this.database.prepare(`
      SELECT zs.heart_rate_exposure_json
      FROM active_workout_zone_summaries zs
      JOIN active_workout_training_loads load
        ON load.training_session_id = zs.training_session_id
      WHERE zs.heart_rate_coverage >= 0.3
        AND load.local_date > ?
    `).all(shiftMobileDate(anchor, -28)) as unknown as Array<Record<string, unknown>>;
    for (const row of exposureRows) {
      const exposures = parseJson<ZoneExposureRow[]>(row.heart_rate_exposure_json, []);
      for (const exposure of exposures) {
        if (!exposure || typeof exposure.zone !== "string") continue;
        const seconds = Number(exposure.durationSeconds ?? 0);
        if (!Number.isFinite(seconds) || seconds <= 0) continue;
        zoneTotals.set(exposure.zone, (zoneTotals.get(exposure.zone) ?? 0) + seconds);
      }
    }
    const zoneTotalSeconds = [...zoneTotals.values()].reduce((sum, value) => sum + value, 0);
    const heartRateZones = [...zoneTotals.entries()]
      .map(([zone, durationSeconds]) => ({
        zone,
        durationSeconds,
        fraction: zoneTotalSeconds > 0 ? durationSeconds / zoneTotalSeconds : 0
      }))
      .sort((a, b) => b.durationSeconds - a.durationSeconds);

    const totalsDistanceKm = Number(rollingRows.current_km ?? 0);
    const totalsDurationSeconds = Number(rollingRows.duration_seconds ?? 0);
    const previousKm = Number(rollingRows.previous_km ?? 0);
    return {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      months: monthRows.map((row) => ({
        month: String(row.month),
        runningDistanceKm: Number(row.running_km ?? 0),
        cyclingDistanceKm: Number(row.cycling_km ?? 0),
        otherDistanceKm: Math.max(0, Number(row.total_km ?? 0) - Number(row.running_km ?? 0) - Number(row.cycling_km ?? 0)),
        totalDistanceKm: Number(row.total_km ?? 0),
        durationSeconds: Number(row.duration_seconds ?? 0),
        workoutCount: Number(row.workout_count ?? 0)
      })).reverse(),
      totals: {
        distanceKm: totalsDistanceKm,
        durationSeconds: totalsDurationSeconds,
        workoutCount: Number(rollingRows.workout_count ?? 0),
        averagePaceSecondsPerKm: paceSeconds(totalsDurationSeconds, totalsDistanceKm > 0 ? totalsDistanceKm : null),
        distanceChangeFraction: previousKm > 0 ? (totalsDistanceKm - previousKm) / previousKm : null
      },
      heartRateZones
    };
  }

  mobileTrends(): MobileTrendsResponse {
    const today = mobileLocalDate();
    const anchorRow = this.database.prepare(`
      SELECT COALESCE(MAX(local_date), ?) AS anchor FROM active_workout_training_loads
    `).get(today) as Record<string, unknown>;
    const anchor = String(anchorRow.anchor ?? today);
    const anchorWeekStart = mobileWeekStart(anchor);
    const oldestWeekStart = shiftMobileDate(anchorWeekStart, -11 * 7);
    const currentCalendarWeekStart = mobileWeekStart(today);

    // ISO week = Monday of local_date; emit 12 consecutive weeks ending at the data-anchor week.
    const weekRows = this.database.prepare(`
      SELECT
        date(local_date, '-' || ((CAST(strftime('%w', local_date) AS INTEGER) + 6) % 7) || ' days') AS period_start,
        SUM(distance_km) AS distance_km,
        COUNT(*) AS workout_count
      FROM active_workout_training_loads
      WHERE local_date >= ? AND local_date <= ?
      GROUP BY period_start
    `).all(oldestWeekStart, shiftMobileDate(anchorWeekStart, 6)) as unknown as Array<Record<string, unknown>>;
    const weekByStart = new Map(weekRows.map((row) => [String(row.period_start), row]));
    const weeks: MobileTrendsResponse["weeks"] = [];
    for (let offset = 11; offset >= 0; offset -= 1) {
      const periodStart = shiftMobileDate(anchorWeekStart, -offset * 7);
      const periodEnd = shiftMobileDate(periodStart, 6);
      const row = weekByStart.get(periodStart);
      weeks.push({
        periodStart,
        periodEnd,
        distanceKm: row ? Number(row.distance_km ?? 0) : 0,
        workoutCount: row ? Number(row.workout_count ?? 0) : 0,
        isComplete: periodEnd < currentCalendarWeekStart
      });
    }

    let distanceChangeFraction4Weeks: number | null = null;
    if (weeks.length >= 8) {
      const recent = weeks.slice(-4).reduce((sum, week) => sum + week.distanceKm, 0);
      const previous = weeks.slice(-8, -4).reduce((sum, week) => sum + week.distanceKm, 0);
      distanceChangeFraction4Weeks = previous > 0 ? (recent - previous) / previous : null;
    }

    const recordQuery = (lowerKm: number, upperKm: number): { distanceKm: number; paceSecondsPerKm: number; startedAt: string } | null => {
      const row = this.database.prepare(`
        SELECT f.distance_km, f.duration_seconds, f.workout_start_at
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        WHERE f.eligibility_status = 'eligible'
          AND f.distance_km BETWEEN ? AND ?
          AND f.duration_seconds > 0
        ORDER BY f.duration_seconds / f.distance_km ASC
        LIMIT 1
      `).get(lowerKm, upperKm) as Record<string, unknown> | undefined;
      if (!row) return null;
      const distanceKm = Number(row.distance_km);
      const durationSeconds = Number(row.duration_seconds);
      if (!(distanceKm > 0) || !(durationSeconds > 0)) return null;
      return {
        distanceKm,
        paceSecondsPerKm: durationSeconds / distanceKm,
        startedAt: String(row.workout_start_at)
      };
    };
    const longestRow = this.database.prepare(`
      SELECT f.distance_km, f.workout_start_at
      FROM active_ability_assessments a
      JOIN workout_features f ON f.id = a.feature_id
      WHERE f.eligibility_status = 'eligible' AND f.distance_km IS NOT NULL
      ORDER BY f.distance_km DESC
      LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    const biggestMonthRow = this.database.prepare(`
      SELECT substr(local_date, 1, 7) AS month, SUM(distance_km) AS distance_km
      FROM active_daily_training_metrics
      GROUP BY month
      ORDER BY distance_km DESC
      LIMIT 1
    `).get() as Record<string, unknown> | undefined;

    const insights: MobileTrendsResponse["insights"] = [];
    if (distanceChangeFraction4Weeks !== null) {
      const percent = Math.round(distanceChangeFraction4Weeks * 100);
      if (percent > 30) {
        insights.push({
          kind: "warning",
          title: "跑量增幅偏快",
          detail: `近 4 周跑量较前 4 周 +${percent}%，超过 30% 安全阈值，建议控制本周总量或安排恢复日。`
        });
      } else if (percent > 0) {
        insights.push({
          kind: "positive",
          title: "跑量爬坡健康",
          detail: `近 4 周跑量较前 4 周 +${percent}%，处于安全区间（<30%），可维持当前节奏。`
        });
      }
    }
    if (weeks.length >= 2) {
      const currentWeek = weeks[weeks.length - 1];
      const previousWeek = weeks[weeks.length - 2];
      if (currentWeek && previousWeek && previousWeek.distanceKm > 0 &&
          currentWeek.distanceKm > previousWeek.distanceKm * 1.5 && currentWeek.distanceKm > 5) {
        insights.push({
          kind: "warning",
          title: "单周跑量跳升",
          detail: `本周跑量较上周 +${Math.round((currentWeek.distanceKm / previousWeek.distanceKm - 1) * 100)}%，注意疲劳管理，避免连续两周大幅增量。`
        });
      }
    }

    const abilitySeries = this.trendsRepository.load(84);
    const latestAbility = abilitySeries.daily.at(-1);
    if (abilitySeries.daily.length >= 2) {
      const start = abilitySeries.daily[0]?.trueAbility;
      const end = latestAbility?.trueAbility;
      if (start != null && end != null && end > start + 0.5) {
        insights.push({
          kind: "positive",
          title: "真实能力在爬升",
          detail: `近 ${abilitySeries.daily.length} 日 TA 从 ${start.toFixed(1)} 到 ${end.toFixed(1)}。`
        });
      } else if (latestAbility && latestAbility.decayPoints > 0) {
        insights.push({
          kind: "warning",
          title: "停跑衰减中",
          detail: `真实能力已计入 ${latestAbility.decayPoints.toFixed(1)} 点停跑衰减，与训练表现分开看。`
        });
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      weeks,
      distanceChangeFraction4Weeks,
      records: {
        fastest5k: recordQuery(4.9, 5.2),
        fastest10k: recordQuery(9.8, 10.5),
        longestDistance: longestRow
          ? { distanceKm: Number(longestRow.distance_km), startedAt: String(longestRow.workout_start_at) }
          : null,
        biggestMonth: biggestMonthRow
          ? { month: String(biggestMonthRow.month), distanceKm: Number(biggestMonthRow.distance_km ?? 0) }
          : null
      },
      insights,
      ability: abilitySeries.daily.map((day) => ({
        date: day.date,
        trueAbility: day.trueAbility,
        decayPoints: day.decayPoints,
        growthVelocityPerWeek: day.growthVelocityPerWeek,
        status: day.status
      })),
      currentAbility: abilitySeries.workouts.map((workout) => ({
        id: workout.id,
        date: workout.date,
        currentAbility: workout.currentAbility,
        confidence: workout.confidence,
        assessmentStatus: workout.assessmentStatus,
        distanceKm: workout.distanceKm
      })),
      growthVelocityPerWeek: latestAbility?.growthVelocityPerWeek ?? null,
      decayPoints: latestAbility?.decayPoints ?? 0
    };
  }

  recoveryTrends(days: number, now = new Date()): RecoveryTrendResponse {
    const normalizedDays = Math.min(365, Math.max(1, Math.trunc(Number.isFinite(days) ? days : 28)));
    const endDate = localDateInShanghai(now);
    const dates: string[] = [];
    for (let i = normalizedDays - 1; i >= 0; i -= 1) dates.push(shiftMobileDate(endDate, -i));
    const points = dates.map((date) => {
      const night = this.recoveryRepository.loadCanonicalNight(date, "Asia/Shanghai");
      const hrv = this.recoveryRepository.loadHrvDay(date, "Asia/Shanghai");
      return { date, sleepMinutes: night?.asleepUnionMinutes ?? null, hrvSdnnMs: hrv?.hrvSdnnMs ?? null, hrvSampleCount: hrv?.sampleCount ?? 0, hrvConfidence: hrv?.confidence ?? "missing", sourceCategory: night?.sourceCategory ?? null };
    });
    const latestDataDate = [...points].reverse().find((point) =>
      point.sleepMinutes !== null || point.hrvSdnnMs !== null
    )?.date ?? null;
    return {
      generatedAt: now.toISOString(),
      asOf: endDate,
      timezone: "Asia/Shanghai",
      latestDataDate,
      days: points
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

  /**
   * Segments for one run: the Watch's measured steps first, the matched plan's
   * steps replayed onto the speed track second, the Watch's lap/segment
   * boundaries third, an explicit explanation fourth.
   *
   * The measurement decides *where* each step ended and the plan decides *what
   * it was*, so the two are complements rather than rivals. Both producers
   * measure against the same scaled speed track
   * ({@link SqliteSeriesReadRepository.speedTrack}), so a measured step and a
   * replayed one are comparable numbers.
   */
  private segmentRun(
    session: {
      startedAt: string;
      endedAt: string;
      sourceName: string;
      distanceKm: number | null;
      canonicalWorkoutId: string;
    },
    candidates: PlanCandidateDay[]
  ): {
    segments: WorkoutSeriesResponse["segments"];
    plan: WorkoutSeriesResponse["segmentPlan"];
    note: string | null;
    hasMeasuredWorkoutSteps: boolean;
  } {
    const startedAtMs = Date.parse(session.startedAt);
    const endedAtMs = Date.parse(session.endedAt);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs <= startedAtMs) {
      return { segments: [], plan: null, hasMeasuredWorkoutSteps: false, note: "这次训练的时间区间无效，无法生成分段" };
    }
    const events = this.seriesRepository.workoutEventIntervals(session.canonicalWorkoutId);
    // The Watch's own step layer, when the export carried one. Absent for older
    // runs and for imports that never came through the app, which is why the
    // replay below still exists.
    const steps = measuredStepsOf(
      this.seriesRepository.workoutMetadata(session.canonicalWorkoutId),
      startedAtMs,
      endedAtMs
    );
    const track = this.seriesRepository.speedTrack(
      session.startedAt,
      session.endedAt,
      session.sourceName,
      session.distanceKm
    );
    const plan = matchPlanDay({
      candidates,
      startedAtMs,
      localDate: localDateInShanghai(new Date(startedAtMs)),
      distanceKm: session.distanceKm
    });
    if (!track) {
      return {
        segments: [],
        plan: null,
        hasMeasuredWorkoutSteps: false,
        note: "缺少可用的速度序列（或与总里程偏差过大），无法重建分段，请按公里分段参考"
      };
    }
    const segmentation = resolveSegmentation({
      startedAtMs,
      endedAtMs,
      events,
      steps,
      plan,
      track: { samples: track.samples, officialMeters: track.officialMeters }
    });
    const measured =
      segmentation.boundaries.length < 2
        ? []
        : this.seriesRepository.measureSegments(
            session.startedAt,
            session.endedAt,
            session.sourceName,
            session.distanceKm,
            segmentation.boundaries
          );
    const segments = toWorkoutSegments(measured, segmentation.descriptors, startedAtMs);
    if (segments.length === 0) return { segments: [], plan: null, hasMeasuredWorkoutSteps: false, note: missingSegmentsNote(events.length, plan) };
    return { segments, plan: segmentation.plan, note: segmentation.note, hasMeasuredWorkoutSteps: steps.length >= 2 };
  }

  workoutSeries(id: string, candidates: PlanCandidateDay[] = []): WorkoutSeriesResponse | null {
    const session = this.seriesRepository.sessionForSeries(id);
    if (!session) return null;
    const { startedAt, endedAt, sourceCategory, sourceName, distanceKm } = session;
    const segmentation = this.segmentRun(session, candidates);
    return {
      trainingSessionId: id,
      startedAt,
      endedAt,
      sourceCategory,
      splits: this.seriesRepository.workoutSplits(startedAt, endedAt, sourceName, distanceKm),
      segments: segmentation.segments,
      segmentPlan: segmentation.plan,
      segmentNote: segmentation.note,
      hasMeasuredWorkoutSteps: segmentation.hasMeasuredWorkoutSteps,
      series: {
        heartRate: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierHeartRate",
            "count/min",
            startedAt,
            endedAt,
            sourceName
          )
        ),
        speed: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierRunningSpeed",
            "km/hr",
            startedAt,
            endedAt,
            sourceName
          )
        ),
        power: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierRunningPower",
            "W",
            startedAt,
            endedAt,
            sourceName
          )
        ),
        cadence: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierStepCount",
            "spm",
            startedAt,
            endedAt,
            sourceName,
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
            sourceName
          )
        ),
        verticalOscillation: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierRunningVerticalOscillation",
            "cm",
            startedAt,
            endedAt,
            sourceName
          )
        ),
        groundContactTime: this.asMetricSeries(
          this.seriesRepository.metricSeries(
            "HKQuantityTypeIdentifierRunningGroundContactTime",
            "ms",
            startedAt,
            endedAt,
            sourceName
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
