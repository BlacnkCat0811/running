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
  SqlitePerformanceEntryRepository,
  SqlitePrivacyZoneRepository,
  SqliteCoachFactsRepository,
  activeDurationSecondsSql,
  loadPerformanceEventSessions,
  readFactReadViewInTransaction,
  sessionFactPresentConditionSql,
  workoutPresentConditionSql,
  type FactReadView,
  type FactReadViewLimits,
  type StoredPerformanceEntry,
  type StoredPrivacyZone,
  type StoredSeriesSession,
  type StoredWorkoutDetailRow,
  type StoredWorkoutListItem
} from "@rai/storage-sqlite";
import { DATABASE_TIMEZONE, SHARE_CARD_POLICY_VERSION, localCalendarFormatter } from "@rai/contracts";
import { fitPersonalInterval, personalCalibrationReadiness } from "@rai/model-eval";
import type { PersonalCalibrationProgress } from "@rai/contracts";
import { candidateEntryKey, findRaceCandidates, nearestStandardDistance, type RaceCandidate } from "./race-candidate.js";
import {
  buildLabelFunnel,
  buildPersonalCalibrationSamples,
  loadLabeledRaceOutcomes,
  type LabelFunnelReport
} from "@rai/application";
import { estimateRecoveryTime, withTrainingForm } from "@rai/training-load";
import type { SubjectiveFeedback, WorkoutExecutionAssessment, CoachPredictionSummary } from "@rai/api-contracts";
import { coachPredictionIdentity } from "./coach-prediction-companion.js";
import { coachLocalDate, shiftCoachDate, type CoachRunFact } from "./coach-loop-facts.js";
import { assessWorkoutExecution, coachQualityExecutionSummary, type CoachExecutionWorkout, type CoachExecutionAssociation } from "./coach-execution-assessment.js";
import { prescriptionDigest } from "./plan-digest.js";

import type {
  AbilityMetricSet,
  DataSummaryResponse,
  DataAuditResponse,
  DashboardResponse,
  DiagnosticExportResponse,
  MobileCoverage,
  MobileCoverageMetric,
  MobileGoalsResponse,
  MobileStatisticsResponse,
  MobileTodayResponse,
  MobileTrendsResponse,
  MobileWorkoutPlanResponse,
  TrainingPlanStateResponse,
  ModelRunComparisonResponse,
  ModelRunSummary,
  RecomputeJobDto,
  RecomputeJobEventDto,
  ShareCardResponse,
  RecoveryTimeEstimate,
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
import { environmentCoverage, environmentViewForWorkout, splitGradeContexts } from "./workout-environment.js";
import { buildRunningDynamics } from "./workout-dynamics.js";
import { trimRouteForShare } from "./share-card.js";
import { mobileSyncStatus, type MobileRefreshOutcome } from "./mobile-sync.js";
import { planDayWithLock, type MobileGoalsStore, type PlanHistoryRevision } from "./mobile-goals.js";
import { digest, executionContent } from "./plan-digest.js";
import { runCoachResponse } from "./run-coach.js";
import { PlanOperationError } from "./plan-publication.js";
import { assembleMobileCoach, assembleMobileWorkoutPlan, zonePrescription } from "./mobile-read.js";
import { constrainUpcomingPlan } from "./weekly-plan-service.js";
import { weeklyPlanVolumeCeiling } from "./weekly-plan-validate.js";
import { weeklyCapacity } from "./weekly-capacity.js";
import { runCoachEndDate, runCoachIsTraining, runCoachWeekday } from "./run-coach-policy.js";
import { DEFAULT_EASY_DURATION_FLOOR, DEFAULT_QUALITY_SESSION_CAP, plannedDayNumbers } from "./mobile-coach.js";
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

const localDateInShanghai = (value: Date): string => localCalendarFormatter(DATABASE_TIMEZONE, "day").format(value);

/**
 * Mean recorded distance over the last four complete calendar weeks, in km.
 *
 * Complete weeks only: the week in progress is systematically short, and feeding it
 * into the phase bands would shrink every plan a little more each day. Missing
 * days do not shorten the denominator or constitute proof of observed rest.
 */
export function recentWeeklyKm(
  metrics: ReadonlyArray<{ localDate: string; distanceMeters: number }>,
  today: string
): number {
  const currentWeekStart = mobileWeekStart(today);
  const windowStart = shiftMobileDate(currentWeekStart, -28);
  let totalMeters = 0;
  for (const metric of metrics) {
    if (metric.localDate < windowStart || metric.localDate >= currentWeekStart) continue;
    totalMeters += metric.distanceMeters;
  }
  return Math.round((totalMeters / 4_000) * 10) / 10;
}

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
 * Per-metric record coverage for one date.
 *
 * `historical` is a first-class state, not a degraded `current`: a night that
 * woke yesterday is real data the app may show as a reference, and only the
 * absence of any record at all is `none`.
 */
const coverageMetric = (latestDate: string | null, today: string): MobileCoverageMetric => ({
  state: latestDate == null ? "none" : latestDate === today ? "current" : "historical",
  latestDate
});

/** Shanghai local date of a stored ISO instant, or null when it is not a parseable instant. */
const coverageDate = (iso: string | null): string | null =>
  iso == null || Number.isNaN(Date.parse(iso)) ? null : localDateInShanghai(new Date(iso));

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
  private readonly privacyZoneRepository: SqlitePrivacyZoneRepository;
  private readonly performanceEntryRepository: SqlitePerformanceEntryRepository;
  private cacheVersion = -1;
  private readonly cache = new Map<string, unknown>();

  constructor(
    private readonly path: string,
    /**
     * The import worker's view of the newest refresh.
     *
     * The data database can only record refreshes that *completed*: an import
     * writes into a staging copy that becomes visible only on publication, so a
     * failed attempt is rolled back and leaves no trace behind it. `failed`
     * therefore cannot be answered from here, and a store without a worker
     * honestly reports `never`/`ok` instead of guessing.
     */
    private readonly refreshOutcome: () => MobileRefreshOutcome | null = () => null
  ) {
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
    this.privacyZoneRepository = new SqlitePrivacyZoneRepository(this.database);
    this.performanceEntryRepository = new SqlitePerformanceEntryRepository(this.database);
  }

  close(): void {
    this.database.close();
  }

  invalidateCache(): void {
    this.cache.clear();
    this.cacheVersion = -1;
  }

  /** One read transaction for actual training, today's gates and subjective facts.
   * Availability is conservative session materialization time, never event time. */
  coachLoopFacts(goals: MobileGoalsResponse, history: PlanHistoryRevision[],
    scope: { athleteId: string; datasetEpoch: string }, asOf = new Date().toISOString()) {
    const date = coachLocalDate(asOf);
    this.database.exec("BEGIN DEFERRED");
    try {
      const rows = this.database.prepare(`SELECT s.id, s.anchor_start_at AS startedAt,
        s.anchor_end_at AS endedAt, s.anchor_distance_km AS distanceKm, w.duration_seconds AS durationSeconds,
        s.updated_at AS availableAt
        FROM training_sessions s JOIN workouts w ON w.id=s.canonical_workout_id
        WHERE s.status='active' AND ${workoutPresentConditionSql("w")}
          AND s.activity_type='HKWorkoutActivityTypeRunning'
          AND julianday(s.anchor_start_at)>=julianday(?) AND julianday(s.anchor_end_at)<=julianday(?)
        ORDER BY s.anchor_start_at,s.id`).all(`${shiftCoachDate(date, -100)}T00:00:00+08:00`, asOf) as
        Array<{ id: string; startedAt: string; endedAt: string; distanceKm: number; durationSeconds: number; availableAt: string }>;
      const facts: CoachRunFact[] = rows.filter(row => row.distanceKm > 0 && row.durationSeconds > 0).map(row => ({
        id: row.id, startedAt: row.startedAt, distanceKm: row.distanceKm, durationSeconds: row.durationSeconds,
        availableAt: Number.isFinite(Date.parse(row.availableAt)) ? new Date(row.availableAt).toISOString() : null,
        revisionOrHash: digest(row)
      }));
      const inputs = this.mobileWeeklyPlanInputs(goals, history);
      const repository = new SqliteCoachFactsRepository(this.database);
      const feedback = repository.feedback<SubjectiveFeedback>(JSON.stringify([scope.athleteId, scope.datasetEpoch]), asOf);
      const qualityDates = (this.database.prepare(`SELECT local_date AS date,session_type AS kind
        FROM active_workout_training_loads load
        JOIN training_sessions session ON session.id = load.training_session_id
        WHERE load.local_date>=? AND load.local_date<=? AND ${sessionFactPresentConditionSql("session")}
          AND (load.session_type IN ('tempo','interval','race') OR load.stimulus_type IN ('lactate_threshold','anaerobic','vo2max'))
        ORDER BY local_date`).all(shiftCoachDate(date, -28), date) as Array<{ date: string; kind: string }>);
      const execution = this.coachExecutionAssessments(history, facts, asOf);
      const executionSummary = coachQualityExecutionSummary({ asOf, assessments: execution,
        observedDates: facts.map(fact => coachLocalDate(fact.startedAt)),
        prescriptions: execution.flatMap(row => {
          const revision = history.find(rev => rev.revision === row.planRevision);
          const day = revision ? planDayWithLock(revision, row.localDate) : undefined;
          return revision && day ? [{ day, revision: revision.revision, createdAt: revision.changedAt, availableAt: revision.changedAt,
            evidenceRef: { source: "plan_history", id: `${revision.revision}:${day.localDate}`, observedAt: revision.changedAt,
              availableAt: revision.changedAt, revisionOrHash: row.prescriptionDigest } }] : [];
        }) });
      const predictionIdentity = coachPredictionIdentity(this.database, scope);
      const predictionSummary = predictionIdentity ? repository.summary<CoachPredictionSummary>(
        JSON.stringify([scope.athleteId, scope.datasetEpoch]), digest(predictionIdentity), asOf) : null;
      const factsHash = digest({ scope, date, facts, feedback, zones: inputs.prescription,
        recovery: inputs.today.recoveryAssessment, injury: inputs.today.injuryFlags, calibration: inputs.today.calibration,
        training: inputs.today.weekStructure, recent: inputs.recentWeeklyKm, previous: inputs.previousWeekDistanceKm,
        sync: inputs.today.sync, predictionIdentity, predictionSummaryId: predictionSummary?.id ?? null });
      this.database.exec("COMMIT");
      return { asOf, date, facts, factsHash, inputs, feedback, execution, executionSummary, qualityDates, predictionIdentity, predictionSummary,
        historyCoverageFrom: facts.length ? facts.map(row => coachLocalDate(row.startedAt)).sort()[0]! : null };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  coachExecutionAssessments(history: PlanHistoryRevision[], facts: CoachRunFact[], asOf: string): WorkoutExecutionAssessment[] {
    const today = coachLocalDate(asOf), dates = new Set(history.flatMap(row => [
      ...row.weekPlan.map(day => day.localDate), ...(row.lockedSession ? [row.lockedSession.localDate] : [])
    ]));
    const assessments: WorkoutExecutionAssessment[] = [];
    for (const date of [...dates].filter(date => date >= shiftCoachDate(today, -28) && date <= today).sort()) {
      const midnight = `${date}T00:00:00+08:00`;
      const known = history.filter(row => Date.parse(row.changedAt) <= Date.parse(asOf) &&
        planDayWithLock(row, date) !== undefined).sort((a, b) => a.revision - b.revision);
      const frozen = known.filter(row => Date.parse(row.changedAt) <= Date.parse(midnight)).at(-1) ?? known[0];
      if (!frozen) continue;
      const day = planDayWithLock(frozen, date)!;
      const evidenceRef = { source: "plan_history", id: `${frozen.revision}:${date}`, observedAt: frozen.changedAt,
        availableAt: frozen.changedAt, revisionOrHash: prescriptionDigest(day.kind, day.structure ?? null) };
      const workouts: CoachExecutionWorkout[] = [], associations: CoachExecutionAssociation[] = [];
      for (const fact of facts.filter(fact => coachLocalDate(fact.startedAt) === date)) {
        const series = this.workoutSeries(fact.id, day.structure ? [{ localDate: date, kind: day.kind, revision: frozen.revision,
          matchedBy: "plan_history", structure: day.structure, distanceKm: day.distanceKm, pushedAt: null }] : []);
        if (!series) continue;
        const session = this.seriesRepository.sessionForSeries(fact.id);
        const signalIntervals: CoachExecutionWorkout["signalIntervals"][number][] = session ? this.seriesRepository.metricIntervals("HKQuantityTypeIdentifierHeartRate",
          session.sourceName, session.startedAt, session.endedAt).map(interval => ({
            channel: "heart_rate" as const, startOffsetSeconds: (interval.startMs - Date.parse(fact.startedAt)) / 1000,
            durationSeconds: (interval.endMs - interval.startMs) / 1000, value: interval.value, availableAt: asOf
          })) : [];
        if (session) {
          const track = this.seriesRepository.speedTrack(session.startedAt, session.endedAt, session.sourceName, fact.distanceKm);
          for (const sample of track?.samples ?? []) if (sample.metersPerSecond > 0) signalIntervals.push({
            channel: "pace", startOffsetSeconds: (sample.startMs - Date.parse(fact.startedAt)) / 1000,
            durationSeconds: (sample.endMs - sample.startMs) / 1000, value: 1000 / sample.metersPerSecond,
            // Raw signal first-availability is not retained independently;
            // certify current evaluation only, never historical as-known-then.
            availableAt: asOf
          });
        }
        workouts.push({ id: fact.id, startedAt: fact.startedAt, endedAt: series.endedAt, availableAt: fact.availableAt,
          distanceMeters: fact.distanceKm * 1000, durationSeconds: fact.durationSeconds,
          evidenceLevel: series.hasMeasuredWorkoutSteps ? "measured_steps" : series.segmentPlan ? "reconstructed_segments" : "summary_only",
          measuredStepsComplete: series.hasMeasuredWorkoutSteps === true && !!day.structure &&
            series.segments.length === (day.structure.warmup ? 1 : 0) + (day.structure.cooldown ? 1 : 0) +
              day.structure.blocks.reduce((sum, block) => sum + block.iterations * block.steps.length, 0),
          segments: series.segments, signalIntervals,
          evidenceRef: { source: "workout", id: fact.id, observedAt: fact.startedAt, availableAt: fact.availableAt, revisionOrHash: fact.revisionOrHash } });
        // A same-day timestamp is not a binding. The segmentation matcher must
        // independently select this exact pre-existing revision.
        if (series.segmentPlan?.revision === frozen.revision && Date.parse(frozen.changedAt) <= Date.parse(fact.startedAt))
          associations.push({ workoutId: fact.id, prescriptionDigest: evidenceRef.revisionOrHash,
            method: series.hasMeasuredWorkoutSteps ? "measured_steps_with_plan" : "plan_history",
            validFrom: frozen.changedAt, validUntil: null, availableAt: fact.availableAt, retractedAt: null, evidenceRef });
      }
      assessments.push(assessWorkoutExecution({ asOf, prescription: { day, revision: frozen.revision,
        createdAt: frozen.changedAt, availableAt: frozen.changedAt, evidenceRef }, workouts, associations }));
    }
    return assessments;
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
    startedFrom?: string;
    startedBefore?: string;
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

  /**
   * 追加两块视图的 `/v1/workouts`（PR5 S4 / D1.5）。
   *
   * 🔴 为什么要包一层而不是把两块塞进 `workouts()`：两块必须在**一个读事务**里取齐
   * （C1），而 `workouts()` 自己不开事务（列表与计数由 `listByQuery` 一次拿完）。
   * 这里用一个 `BEGIN DEFERRED` 把"旧字段"与"两块"压在同一快照上 ——
   * 旧字段一个字节都没变，新块来自**恰好一次**的版本读。
   */
  workoutsWithViews(query: Parameters<RaiReadStore["workouts"]>[0]): WorkoutListResponse {
    return this.factAnalysisBlocks(
      () => this.workouts(query),
      (base, view) => ({ ...base, currentFacts: view.facts, publishedAnalysis: view.analysis })
    );
  }

  /**
   * 两块视图（`currentFacts` / `publishedAnalysis`）的**唯一组装点**。
   *
   * 三件事在这里一次做完，缺一条 D1 就没落地：
   * 1. **一个** `BEGIN DEFERRED`：`base` 的读取与两块的读取共用同一个快照。这**不是**
   *    "两次查询恰好看到同一版本"—— SQLite 的 deferred 事务在第一次读时取 WAL 快照，
   *    此后本连接的所有读都在那个快照上（C1 的机械实现）。
   * 2. **两块默认 `null`**：`base` 里没有这两侧视图时就是 `null`，不补空对象（D1.2）。
   * 3. **旧字段原样透传**：`base` 是既有端点的返回值，这里只 `...base` 追加两个键
   *    —— 旧字段的取值与键集在这一层不可能被改动（C9）。
   *
   * ⚠️ `base` 的读取**也必须在事务内**：`BEGIN DEFERRED` 在 SQLite 里是"第一次读时取快照"，
   * 所以 `readBase()` 与本函数里的版本读落在同一个 WAL 快照上；顺序反过来也一样。
   */
  private factAnalysisBlocks<T extends object>(
    readBase: () => T,
    assemble: (base: T, view: FactReadView) => T,
    limits?: Partial<FactReadViewLimits>
  ): T {
    this.database.exec("BEGIN DEFERRED");
    try {
      const base = readBase();
      const view = readFactReadViewInTransaction(this.database, {
        // 事实块的行数跟着端点的分页走：它回答的是"这一页有哪些事实"，
        // 读的比 `base` 多会让响应里出现"列表里没有、块里有"的行。
        factRows: limits?.factRows ?? 100,
        analysisRows: limits?.analysisRows ?? 200
      });
      const result = assemble(base, view);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** A single read transaction keeps export rows and their count on one active snapshot. */
  workoutExportSnapshot(query: Parameters<RaiReadStore["workouts"]>[0]): WorkoutListResponse {
    this.database.exec("BEGIN DEFERRED");
    try {
      const result = this.workouts(query);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  trainingPlanState(store: MobileGoalsStore, identity: () => { serverId: string; athleteId: string; datasetEpoch: string }): TrainingPlanStateResponse {
    for (let attempt = 0; attempt < 3; attempt++) {
      const fileIdentity = statSync(this.path);
      const scope = identity();
      const goals = store.read();
      const controlDigest = digest({ goals, history: store.planHistory(200) });
      const version = this.database.prepare("PRAGMA data_version").get()!.data_version;
      let result: TrainingPlanStateResponse;
      this.database.exec("BEGIN DEFERRED");
      try {
        const localDate = mobileLocalDate();
        const publications = {
          import: this.database.prepare("SELECT key, value FROM import_manifest ORDER BY key").all(),
          model: this.database.prepare("SELECT * FROM active_model_run ORDER BY singleton").all(),
          zones: this.database.prepare("SELECT * FROM training_zone_profile_settings ORDER BY revision DESC LIMIT 1").all(),
          datasetEpoch: scope.datasetEpoch,
          recoveryNights: this.database.prepare(`SELECT id, wake_date, timezone_identifier, kind, source_rank, has_stages,
            sleep_onset_at, wake_at, asleep_union_minutes, awake_minutes, stage_minutes_json
            FROM canonical_nights WHERE wake_date >= ? AND timezone_identifier = ? ORDER BY wake_date, id`).all(shiftMobileDate(localDate, -70), DATABASE_TIMEZONE),
          recoveryHrv: this.database.prepare(`SELECT id, local_date, night_id, hrv_sdnn_ms, sample_count, confidence, window_end_at
            FROM canonical_hrv_days WHERE local_date >= ? AND timezone_identifier = ? ORDER BY local_date, id`).all(shiftMobileDate(localDate, -70), DATABASE_TIMEZONE),
          restingHeartRate: this.database.prepare(`SELECT id, start_at, source_category, value_numeric FROM health_records
            WHERE type = 'HKQuantityTypeIdentifierRestingHeartRate' AND start_at >= ? ORDER BY start_at, id`).all(`${shiftMobileDate(localDate, -70)}T00:00:00Z`)
        };
        const measuredGoals = store.read({ prescription: this.mobilePlanPrescription() });
        const computed = this.mobileTodayWithExecutablePlan(measuredGoals, store.planHistory(200));
        const { today, effective } = computed;
        const inputs = this.mobileWeeklyPlanInputs(measuredGoals, undefined, computed);
        const ruleVersion = "rai-effective-plan-v1";
        const publicationDigest = digest(publications);
        const windowStart = today.today.localDate;
        const windowEnd = shiftMobileDate(windowStart, effective.windowDays - 1);
        const coherenceToken = digest({
          scope, goalsRevision: goals.revision, ruleVersion, publicationDigest,
          timezone: DATABASE_TIMEZONE, localDate: windowStart, windowStart, windowEnd,
          calibration: today.calibration.status, injury: today.injuryFlags.map(flag => flag.code),
          training: today.today, week: today.week, capacity: inputs.weeklyVolumeBaselineKm,
          previous: inputs.previousWeekDistanceKm, recent: inputs.recentWeeklyKm,
          completed: today.weekPlan.filter(day => day.completedWorkoutId !== null).map(day => day.localDate),
          prescription: inputs.prescription, content: executionContent(effective.days)
        });
        // 两块视图在**同一个**读事务里取（`factAnalysisBlocks` 会再开一个 `BEGIN DEFERRED`，
        // 所以这里必须用它的**事务内**形态，而不是 `factAnalysisBlocks` 自己）。
        const planView = readFactReadViewInTransaction(this.database, {
          factRows: 100, analysisRows: 200
        });
        result = {
          metadata: { contractVersion: 1, ...scope, goalsRevision: goals.revision, coherenceToken,
            timezone: DATABASE_TIMEZONE, localDate: windowStart, windowStart, windowEnd, ruleVersion, publicationDigest },
          availability: effective.days.some(day => day.executable && day.kind !== "rest") ? "ready" : "empty",
          goals: measuredGoals, today, workoutPlan: { ...effective, windowStart, windowEnd },
          coachSummary: runCoachResponse(measuredGoals, inputs),
          // 🔴 `versions`/`freshness` **必须**在这儿补，不能写进上面那个 `metadata` 字面量：
          // `coherenceToken`（`:491-499`）吃的是同一次读出来的 `publicationDigest` 等输入，
          // 把新字段塞进字面量会改变 `digest` 的输入 ⇒ 同一个库、同一天算出的
          // `coherenceToken` 会与今天不同 ⇒ 所有已保存的 `coherenceToken` 立刻失效（C9）。
          // 追加两个**可选**字段则不动任何既有取值（PR5 §1.2 锚点 21：iOS 的 `Metadata`
          // 是非可选字段结构体，所以只能加可选字段，加必填会让老客户端 decode 失败）。
          // 两块也一并挂在这里：它们**必须**与 `metadata` 来自同一个 `BEGIN DEFERRED`
          // （上面 `:467` 那个），所以用**事务内**入口读，不另开事务（SQLite 不支持嵌套）。
          currentFacts: planView.facts,
          publishedAnalysis: planView.analysis
        };
        result.metadata = { ...result.metadata, versions: planView.versions, freshness: planView.freshness };
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      const unchanged = version === this.database.prepare("PRAGMA data_version").get()!.data_version &&
        controlDigest === digest({ goals: store.read(), history: store.planHistory(200) }) &&
        digest(scope) === digest(identity()) && result.metadata.localDate === mobileLocalDate();
      const currentFile = statSync(this.path);
      if (fileIdentity.ino !== currentFile.ino || fileIdentity.mtimeMs !== currentFile.mtimeMs) {
        throw new PlanOperationError("plan_snapshot_changed", "训练数据库在读取期间发布，请重读完整快照。", 503);
      }
      if (unchanged) return result;
      this.cache.clear();
    }
    throw new PlanOperationError("plan_snapshot_changed", "训练事实在读取期间变化，请重试完整快照。", 503);
  }

  mobileToday(
    goals?: Pick<MobileGoalsResponse, "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget" | "weekPlan" | "lockedSession" | "weekPlanPreservedDate" | "runCoach">,
    planHistory?: PlanHistoryRevision[]
  ): MobileTodayResponse {
    return this.mobileTodayWithExecutablePlan(goals, planHistory).today;
  }

  /**
   * 追加两块视图的 `/v1/mobile/today`（PR5 S4 / D1.5）。
   *
   * 🔴 为什么必须让 `base` 与两块落在**同一个** `BEGIN DEFERRED` 里：`mobileToday` 的
   * 数字来自今天的事实（今日负荷、周汇总、`planActual`），两块来自版本视图 ——
   * 若分两次读，它们之间的那次提交会让响应出现"汇总说 7 次、事实块说 6 行"，
   * 而那正是 C1 要挡的跨快照混合。旧字段的取值一个字都不动，只是多两个键。
   */
  mobileTodayWithViews(
    goals?: Pick<MobileGoalsResponse, "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget" | "weekPlan" | "lockedSession" | "weekPlanPreservedDate" | "runCoach">,
    planHistory?: PlanHistoryRevision[]
  ): MobileTodayResponse {
    return this.factAnalysisBlocks(
      () => this.mobileToday(goals, planHistory),
      (base, view) => ({ ...base, currentFacts: view.facts, publishedAnalysis: view.analysis })
    );
  }

  /**
   * `mobileToday` 与它内部那次 `executableMobilePlan` 的**同一次**计算结果。
   *
   * 必须一起返回，而不是让调用方再算一遍：`executableMobilePlan` 只从 `today` 读
   * today / week / nextSession / lock / weekStructure / injuryFlags，**从不读
   * `today.weekPlan`**；而 `mobileToday` 会在算完之后把 `result.weekPlan` 就地改写成
   * 执行版。于是"先算一次用于改写，再为 `workout-plan` 重算一次"里的第二次调用，拿到的是
   * **同一个对象、但 `weekPlan` 已被换过**的输入 —— 两次结果必然相同，第二次纯属重复
   * （实测 1.5ms/次，占该端点 118ms 的 ~1.3%）。
   *
   * 单独看性能这不足以成为改动理由；真正的理由是它把"第二次调用看到的输入"变成了一件
   * 只在偶然中成立的事（`executableMobilePlan` 一旦开始读 `weekPlan`，第二次就会去读
   * 自己上一轮的输出）。让同一次结果显式传出去，比让它被重算更安全。
   */
  private mobileTodayWithExecutablePlan(
    goals?: Pick<MobileGoalsResponse, "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget" | "weekPlan" | "lockedSession" | "weekPlanPreservedDate" | "runCoach"> &
      Partial<Pick<MobileGoalsResponse, "weekPlanAudit">>,
    planHistory?: PlanHistoryRevision[]
  ): { today: MobileTodayResponse; effective: MobileWorkoutPlanResponse; preparation: ReturnType<typeof assembleMobileCoach>["preparation"] } {
    const today = mobileLocalDate();
    // A paused/ended programme never falls back to an invented daily run after
    // its saved seven-day window expires. Imported history remains observable.
    if (goals?.runCoach) {
      const programme = goals.runCoach;
      const stopped = !runCoachIsTraining(programme, today);
      const saved = new Map(goals.weekPlan.map(day => [day.localDate, day]));
      const window = Array.from({ length: 7 }, (_, index) => {
        const localDate = shiftMobileDate(today, index);
        const preservedToday = localDate === today &&
          (goals!.weekPlanPreservedDate === today || goals!.lockedSession?.localDate === today);
        const raceDay = programme.raceDate === localDate;
        const unavailable = raceDay || localDate > runCoachEndDate(programme) ||
          (!preservedToday && !programme.runningDays.includes(runCoachWeekday(localDate)));
        if (!stopped && !unavailable && saved.has(localDate)) return saved.get(localDate)!;
        return { localDate, kind: "rest" as const, distanceKm: null,
          reason: stopped ? "教练计划未在进行。" : raceDay ? "比赛日留白；不等于比赛已完成。" : unavailable ? "非可跑步日或训练周期已结束。" : "教练训练安排待刷新。" };
      });
      goals = { ...goals, ...(stopped || programme.raceDate === today ? { lockedSession: null } : {}), weekPlan: [...goals.weekPlan.filter(day => day.localDate < today), ...window,
        ...(stopped ? [] : goals.weekPlan.filter(day => day.localDate > shiftMobileDate(today, 6)))] };
    }
    const weekStart = mobileWeekStart(today);
    const weekEnd = shiftMobileDate(weekStart, 6);

    const anchorRow = this.database.prepare(`
      SELECT MAX(load.local_date) AS anchor
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE ${sessionFactPresentConditionSql("session")}
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
    // What records exist per metric, and how far the feed itself has advanced.
    // Kept apart from what the evidence says: the runner not wearing a watch on
    // a given night is a coverage fact, never a recovery verdict, and the newest
    // sample of any type is what separates "the feed stopped" from "there was
    // nothing new to measure".
    const coverage: MobileCoverage = {
      latestTrainingDate: latestDataDate,
      latestHealthSampleAt: this.recoveryRepository.latestHealthSampleAt(),
      sleep: coverageMetric(recoveryDate, today),
      hrv: coverageMetric(this.recoveryRepository.latestHrvDate(DATABASE_TIMEZONE), today),
      restingHeartRate: coverageMetric(coverageDate(this.recoveryRepository.latestRestingHeartRateAt()), today)
    };
    const sync = mobileSyncStatus(lastSyncedAt, this.refreshOutcome());

    const todayRow = this.database.prepare(`
      SELECT
        COALESCE(SUM(distance_km), 0) AS distance_km,
        COALESCE(SUM(duration_seconds), 0) AS duration_seconds,
        COUNT(*) AS workout_count
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE load.local_date = ? AND ${sessionFactPresentConditionSql("session")}
    `).get(today) as Record<string, unknown>;
    const todayEnergy = this.database.prepare(`
      SELECT COALESCE(SUM(stat.sum_value), 0) AS energy_kcal
      FROM active_workout_training_loads load
      JOIN training_sessions ts ON ts.id = load.training_session_id
      JOIN workout_statistics stat ON stat.workout_id = ts.canonical_workout_id
        AND stat.type = 'HKQuantityTypeIdentifierActiveEnergyBurned'
      WHERE load.local_date = ? AND ${sessionFactPresentConditionSql("ts")}
    `).get(today) as Record<string, unknown>;

    const dailyRows = this.database.prepare(`
      SELECT
        local_date,
        COALESCE(SUM(distance_km), 0) AS distance_km,
        COUNT(*) AS workout_count
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE load.local_date BETWEEN ? AND ? AND ${sessionFactPresentConditionSql("session")}
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
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE load.local_date BETWEEN ? AND ? AND ${sessionFactPresentConditionSql("session")}
    `).get(weekStart, weekEnd) as Record<string, unknown>;

    const weekDistanceKm = Number(weekRow.distance_km ?? 0);
    const recentWorkouts = this.workoutsRepository.list("", [], 5, 0).map((item) => this.toWorkoutListItem(item)!);
    const priorFourStart = shiftMobileDate(weekStart, -56);
    const priorFourEnd = shiftMobileDate(weekStart, -29);
    const recentFourStart = shiftMobileDate(weekStart, -28);
    const recentFourEnd = shiftMobileDate(weekStart, -1);
    const volumeRows = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN load.local_date BETWEEN ? AND ? THEN load.distance_km ELSE 0 END), 0) AS recent_km,
        COALESCE(SUM(CASE WHEN load.local_date BETWEEN ? AND ? THEN load.distance_km ELSE 0 END), 0) AS previous_km
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE ${sessionFactPresentConditionSql("session")}
    `).get(recentFourStart, recentFourEnd, priorFourStart, priorFourEnd) as Record<string, unknown>;
    const previousFourKm = Number(volumeRows.previous_km ?? 0);
    const recentFourKm = Number(volumeRows.recent_km ?? 0);
    const fourWeekDistanceChangeFraction = previousFourKm > 0 ? (recentFourKm - previousFourKm) / previousFourKm : null;
    const dashboard = this.dashboard();
    const latestMetric = this.statisticsRepository.latestMetric();
    const metricEnd = latestMetric?.localDate ?? latestDataDate ?? today;
    const recentMetrics = this.statisticsRepository.metricsBetween(shiftMobileDate(metricEnd, -56), metricEnd);
    // Aggregate the entire calendar week, never the five recent-workout previews.
    const running = this.database.prepare(`
      SELECT SUM(load.distance_km) AS distance, SUM(load.duration_seconds) AS duration,
        SUM(CASE WHEN load.average_heart_rate_bpm > 0 THEN load.average_heart_rate_bpm * load.duration_seconds ELSE 0 END) AS hr_weighted,
        SUM(CASE WHEN load.average_heart_rate_bpm > 0 THEN load.duration_seconds ELSE 0 END) AS hr_duration
      FROM active_workout_training_loads load
      JOIN training_sessions ts ON ts.id = load.training_session_id
      WHERE load.local_date BETWEEN ? AND ? AND ts.activity_type LIKE '%Running%'
        AND ${sessionFactPresentConditionSql("ts")}
    `).get(weekStart, weekEnd) as Record<string, number | null>;
    const exposures = this.database.prepare(`
      SELECT zs.* FROM active_workout_zone_summaries zs
      JOIN active_workout_training_loads load ON load.training_session_id = zs.training_session_id
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE load.local_date BETWEEN ? AND ? AND ${sessionFactPresentConditionSql("session")}
    `).all(weekStart, weekEnd) as Array<Record<string, unknown>>;
    const weekZones = (kind: "heart_rate" | "pace") => {
      const totals = new Map<string, number>();
      for (const row of exposures) {
        // Same evidence threshold as the statistics page, independently per metric.
        if (Number(row[`${kind}_coverage`]) < 0.3) continue;
        for (const exposure of parseJson<ZoneExposureRow[]>(row[`${kind}_exposure_json`], [])) {
          if (!exposure || typeof exposure.zone !== "string") continue;
          const seconds = Number(exposure.durationSeconds);
          if (!Number.isFinite(seconds) || seconds <= 0) continue;
          totals.set(exposure.zone, (totals.get(exposure.zone) ?? 0) + seconds);
        }
      }
      const total = [...totals.values()].reduce((sum, seconds) => sum + seconds, 0);
      return [...totals].map(([zone, durationSeconds]) => ({ zone, durationSeconds, fraction: durationSeconds / total }))
        .sort((a, b) => b.durationSeconds - a.durationSeconds);
    };
    const week = {
      averageSpeedKmPerHour: Number(running.duration) > 0 && Number(running.distance) > 0
        ? Number(running.distance) * 3600 / Number(running.duration) : null,
      averagePaceSecondsPerKm: Number(running.duration) > 0 && Number(running.distance) > 0
        ? Number(running.duration) / Number(running.distance) : null,
      averageHeartRateBpm: Number(running.hr_duration) > 0
        ? Number(running.hr_weighted) / Number(running.hr_duration) : null,
      heartRateZones: weekZones("heart_rate"),
      paceZones: weekZones("pace"),
      periodStart: weekStart,
      periodEnd: weekEnd,
      distanceKm: weekDistanceKm,
      durationSeconds: Number(weekRow.duration_seconds ?? 0),
      workoutCount: Number(weekRow.workout_count ?? 0)
    };
    // One observation query feeds both the seven-day execution strip and §20
    // adherence: two queries would be two chances for them to disagree.
    const planActual = this.database.prepare(`
      SELECT local_date AS localDate, SUM(distance_km) AS distanceKm, COUNT(*) AS workoutCount
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE load.local_date >= ? AND load.local_date <= ? AND ${sessionFactPresentConditionSql("session")}
      GROUP BY load.local_date
    `).all(shiftMobileDate(today, -28), today) as Array<{ localDate: string; distanceKm: number; workoutCount: number }>;
    // Capacity is derived from training facts, never from a stored preference. The
    // coach decision and the WorkoutKit export must obey the same ceiling, and it
    // must move when the athlete's actual volume moves.
    const previousWeekDistanceKm = this.previousWeekDistanceKm(today);
    const recentWeeklyKmValue = recentWeeklyKm(recentMetrics, today);
    const capacityBaselineKm = weeklyCapacity({
      today,
      raceTarget: goals?.raceTarget ?? null,
      runCoach: goals?.runCoach ?? null,
      recentWeeklyKm: recentWeeklyKmValue,
      previousWeekDistanceKm
    }).baselineKm;
    // Two roles, one source. The coach *spends* against a ceiling, while the plan
    // generator and the export re-derive their own ceiling from the baseline —
    // handing an already-ramped number to code that applies the ramp again would
    // compound the guard and quietly shrink every generated week.
    const capacityCeilingKm = weeklyPlanVolumeCeiling(capacityBaselineKm, previousWeekDistanceKm);
    const zones = this.trainingZonesCurrent();
    const preservedToday = goals?.weekPlanPreservedDate === today ? goals.weekPlan.find(day => day.localDate === today) : null;
    // Protect only today's volume from the migration; live recovery/load gates
    // still resolve the session, and future days keep the derived weekly budget.
    const todayCeilingKm = preservedToday ? Math.max(capacityCeilingKm, weekDistanceKm +
      (plannedDayNumbers(preservedToday.kind, preservedToday.structure, preservedToday.distanceKm, zonePrescription(zones)).distanceKm ?? 0)) : capacityCeilingKm;
    const { preparation, ...coach } = assembleMobileCoach({
      database: this.database,
      dashboard,
      latestMetric,
      recentMetrics,
      zones,
      recentWorkouts,
      week,
      weekDaily,
      today,
      latestDataDate,
      goals: {
        easyDurationFloorFraction: goals?.easyDurationFloorFraction ?? DEFAULT_EASY_DURATION_FLOOR,
        qualitySessionCap: goals?.qualitySessionCap ?? DEFAULT_QUALITY_SESSION_CAP,
        raceTarget: goals?.raceTarget ?? null,
        runCoach: goals?.runCoach ?? null,
        weekPlanPreservedDate: goals?.weekPlanPreservedDate ?? null,
        weekPlanAudit: goals?.weekPlanAudit ?? null,
        weekPlan: goals?.weekPlan ?? [],
        lockedSession: goals?.lockedSession ?? null
      },
      coverage,
      fourWeekDistanceChangeFraction,
      previousWeekDistanceKm,
      weeklyVolumeCeilingKm: todayCeilingKm,
      planHistory: planHistory ?? [],
      recentWeeklyKm: recentWeeklyKmValue,
      planActual
    });
    const recentPlanExecution = planHistory === undefined ? undefined : buildPlanExecution(today, planHistory, planActual);
    // Kept for clients that have not shipped the `sync`/`coverage` reads yet, and
    // now derived from the refresh outcome alone. It used to answer "is there a
    // main night dated today", which reported an ordinary coverage gap — a night
    // the runner did not wear the watch — as an expired dataset, and let a
    // historical night decide today's arrangement. It says nothing about how
    // fresh the data is; that is what `coverage` is for.
    const freshness: MobileTodayResponse["freshness"] = {
      state: sync.status === "never" ? "unknown" : sync.status === "failed" ? "stale" : "valid",
      checkedAt: lastSyncedAt,
      latestTrainingDate: latestDataDate,
      recoveryDate
    };
    // Bound to the decision inputs and the rule version, not to every clock that
    // moves beside them: a revision that flipped with a sync heartbeat would make
    // the lock the runner is about to confirm stale for no reason. The recovery
    // terms are the assessment's own output, so the hash changes exactly when the
    // recovery judgement behind the recommendation changes.
    const recommendationRevision = createHash("sha256")
      .update(JSON.stringify({
        today,
        latestDataDate,
        recoveryCoverage: coach.recoveryAssessment.coverage,
        recoveryAssessment: coach.recoveryAssessment.assessment,
        verdict: coach.verdict,
        nextSession: coach.nextSession,
        candidate: coach.lock.candidate,
        planRevision: (goals as { revision?: number } | undefined)?.revision ?? 0,
        activeModel: dashboard.activeModel?.id ?? null
      }))
      .digest("hex");
    const result: MobileTodayResponse = {
      generatedAt: new Date().toISOString(),
      timezone: DATABASE_TIMEZONE,
      latestDataDate,
      lastSyncedAt,
      sync,
      coverage,
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
      ...coach,
      recommendation: { ...coach.recommendation, planRevision: (goals as { revision?: number } | undefined)?.revision ?? 0 }
    };
    const effective = this.executableMobilePlan(result, capacityBaselineKm, recentWeeklyKmValue, goals);
    result.weekPlan = result.weekPlan.map(day => {
      if (day.localDate <= today) return day;
      const prescribed = effective.days.find(item => item.localDate === day.localDate);
      if (!prescribed) return day;
      return { ...day, kind: prescribed.kind, title: prescribed.title, distanceKm: prescribed.distanceKm ?? 0, structure: prescribed.structure };
    });
    return { today: result, effective, preparation };
  }

  /**
   * Executable week for the WorkoutKit bridge. Reuses `mobileToday` so today's
   * row always carries the gate-resolved, lock-applied prescription — and reuses
   * the very same `executableMobilePlan` result instead of recomputing it.
   */
  mobileWorkoutPlan(
    goals?: Pick<
      MobileGoalsResponse,
      "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget" | "weekPlan" | "lockedSession" | "weekPlanAudit" | "revision" | "weekPlanPreservedDate" | "runCoach"
    >
  ): MobileWorkoutPlanResponse {
    return this.mobileTodayWithExecutablePlan(goals).effective;
  }

  private executableMobilePlan(
    today: MobileTodayResponse,
    weeklyVolumeBaselineKm: number,
    recentWeeklyKm: number,
    goals?: Pick<MobileGoalsResponse, "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget" | "weekPlan" | "lockedSession" | "weekPlanPreservedDate" | "runCoach"> &
      Partial<Pick<MobileGoalsResponse, "weekPlanAudit" | "revision">>
  ): MobileWorkoutPlanResponse {
    const currentZones = this.trainingZonesCurrent();
    const previousWeekDistanceKm = this.previousWeekDistanceKm(today.today.localDate);
    const executablePlan = constrainUpcomingPlan(goals?.weekPlan ?? [], {
      // Today's actual/effective session is reserved; export never replaces a lock.
      today: { ...today, lock: { ...today.lock, present: true } },
      goals: { easyDurationFloorFraction: today.weekStructure.easyDurationFloorFraction,
        qualitySessionCap: today.weekStructure.qualitySessionCap, raceTarget: goals?.raceTarget ?? null, runCoach: goals?.runCoach ?? null },
      weeklyVolumeBaselineKm,
      recentWeeklyKm,
      prescription: zonePrescription(currentZones),
      previousWeekDistanceKm,
      automaticDosePolicy: goals?.weekPlanAudit?.generatedBy === "heuristic"
    });
    return assembleMobileWorkoutPlan({
      today: today.today.localDate,
      todaySession: today.nextSession,
      ...(goals?.weekPlanPreservedDate === today.today.localDate ? { todayPlanSource: "llm" as const } : {}),
      todayCompleted: today.today.workoutCount > 0,
      relockSuggested: today.lock.relockSuggested,
      raceTarget: goals?.raceTarget ?? null,
      weeklyVolumeCeilingKm: weeklyVolumeBaselineKm,
      storedPlan: executablePlan,
      zones: currentZones,
      audit: goals?.weekPlanAudit ?? null,
      planRevision: goals?.revision ?? 0
    });
  }

  /**
   * Same coach snapshot the today endpoint returns, plus everything the weekly
   * plan generator needs. Reusing `mobileToday` keeps the gate rules in one
   * place; the previous week's volume travels with it because the generator's
   * ramp ceiling is `previous week + 30%`.
   *
   * Capacity travels too, derived here by the same rule the today payload uses:
   * a generator that computed its own baseline could disagree with the card the
   * runner is looking at.
   */
  mobileWeeklyPlanInputs(
    goals?: Pick<
      MobileGoalsResponse,
      "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget" | "weekPlan" | "lockedSession" | "weekPlanAudit" | "revision" | "weekPlanPreservedDate" | "runCoach"
    >,
    planHistory?: PlanHistoryRevision[],
    computed?: ReturnType<RaiReadStore["mobileTodayWithExecutablePlan"]>
  ): {
    today: MobileTodayResponse;
    prescription: ReturnType<typeof zonePrescription>;
    previousWeekDistanceKm: number;
    recentWeeklyKm: number;
    weeklyVolumeBaselineKm: number;
    /**
     * The prep assessment the today payload was built from, handed to the coach so
     * the confidence card explains the same numbers the race card shows instead of
     * re-reading the facts (two reads = two chances to disagree).
     */
    preparation: ReturnType<typeof assembleMobileCoach>["preparation"];
  } {
    const { today, preparation } = computed ?? this.mobileTodayWithExecutablePlan(goals, planHistory);
    const previousWeekDistanceKm = this.previousWeekDistanceKm(today.today.localDate);
    // Mirror the window `mobileTodayWithExecutablePlan` uses for its own recent
    // volume, so both paths read the same four complete weeks.
    const latestMetric = this.statisticsRepository.latestMetric();
    const metricEnd = latestMetric?.localDate ?? today.latestDataDate ?? today.today.localDate;
    const recent = recentWeeklyKm(
      this.statisticsRepository.metricsBetween(shiftMobileDate(metricEnd, -56), metricEnd),
      today.today.localDate
    );
    return {
      today,
      prescription: zonePrescription(this.trainingZonesCurrent()),
      previousWeekDistanceKm,
      recentWeeklyKm: recent,
      preparation,
      weeklyVolumeBaselineKm: weeklyCapacity({
        today: today.today.localDate,
        raceTarget: goals?.raceTarget ?? null,
        runCoach: goals?.runCoach ?? null,
        recentWeeklyKm: recent,
        previousWeekDistanceKm
      }).baselineKm
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
      SELECT COALESCE(SUM(load.distance_km), 0) AS distance_km
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE load.local_date BETWEEN ? AND ? AND ${sessionFactPresentConditionSql("session")}
    `).get(shiftMobileDate(weekStart, -7), shiftMobileDate(weekStart, -1)) as Record<string, unknown>;
    return Number(row.distance_km ?? 0);
  }

  mobileStatistics(): MobileStatisticsResponse {
    const today = mobileLocalDate();
    const anchorRow = this.database.prepare(`
      SELECT COALESCE(MAX(load.local_date), ?) AS anchor
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE ${sessionFactPresentConditionSql("session")}
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
      WHERE substr(load.local_date, 1, 7) >= ? AND ${sessionFactPresentConditionSql("ts")}
      GROUP BY month
      ORDER BY month DESC
      LIMIT 3
    `).all(threeMonthsAgo) as unknown as Array<Record<string, unknown>>;

    const rollingRows = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN load.local_date > ? THEN load.distance_km ELSE 0 END), 0) AS current_km,
        COALESCE(SUM(CASE WHEN load.local_date <= ? THEN load.distance_km ELSE 0 END), 0) AS previous_km,
        COALESCE(SUM(CASE WHEN load.local_date > ? THEN load.duration_seconds ELSE 0 END), 0) AS duration_seconds,
        COALESCE(SUM(CASE WHEN load.local_date > ? THEN 1 ELSE 0 END), 0) AS workout_count
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE load.local_date > ? AND ${sessionFactPresentConditionSql("session")}
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
      timezone: DATABASE_TIMEZONE,
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
      SELECT COALESCE(MAX(load.local_date), ?) AS anchor
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE ${sessionFactPresentConditionSql("session")}
    `).get(today) as Record<string, unknown>;
    const anchor = String(anchorRow.anchor ?? today);
    const anchorWeekStart = mobileWeekStart(anchor);
    const oldestWeekStart = shiftMobileDate(anchorWeekStart, -11 * 7);
    const currentCalendarWeekStart = mobileWeekStart(today);

    // ISO week = Monday of local_date; emit 12 consecutive weeks ending at the data-anchor week.
    const weekRows = this.database.prepare(`
      SELECT
        date(local_date, '-' || ((CAST(strftime('%w', local_date) AS INTEGER) + 6) % 7) || ' days') AS period_start,
        SUM(load.distance_km) AS distance_km,
        COUNT(*) AS workout_count
      FROM active_workout_training_loads load
      JOIN training_sessions session ON session.id = load.training_session_id
      WHERE load.local_date >= ? AND load.local_date <= ? AND ${sessionFactPresentConditionSql("session")}
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
      timezone: DATABASE_TIMEZONE,
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
    const startDate = dates[0]!;
    const nights = new Map(this.recoveryRepository.loadMainNightsRange(startDate, endDate, DATABASE_TIMEZONE)
      .map((night) => [night.wakeDate, night]));
    const hrvs = new Map(this.recoveryRepository.loadHrvDaysRange(startDate, endDate, DATABASE_TIMEZONE)
      .map((hrv) => [hrv.localDate, hrv]));
    const points = dates.map((date) => {
      const night = nights.get(date);
      const hrv = hrvs.get(date);
      return { date, sleepMinutes: night?.asleepUnionMinutes ?? null, hrvSdnnMs: hrv?.hrvSdnnMs ?? null, hrvSampleCount: hrv?.sampleCount ?? 0, hrvConfidence: hrv?.confidence ?? "missing", sourceCategory: night?.sourceCategory ?? null };
    });
    const latestDataDate = [...points].reverse().find((point) =>
      point.sleepMinutes !== null || point.hrvSdnnMs !== null
    )?.date ?? null;
    return {
      generatedAt: now.toISOString(),
      asOf: endDate,
      timezone: DATABASE_TIMEZONE,
      latestDataDate,
      days: points
    };
  }

  workout(id: string, options: { includeRoute?: boolean } = {}): WorkoutDetailResponse | null {
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
      // §5 read-out of the correction that physiology already applies. Absent
      // weather is reported as `unavailable` with the missing fields named; it is
      // never folded into a zero penalty that would read as "reference conditions".
      environment: environmentViewForWorkout({
        metadataJson: this.seriesRepository.workoutMetadata(row.canonicalWorkoutId),
        distanceMeters: distance === null ? null : distance * 1000,
        durationSeconds: duration
      }),
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
      route: options.includeRoute === false ? [] : this.seriesRepository.routePoints(row.canonicalWorkoutId) as RoutePointDto[],
      override: this.mapOverride(this.workoutsRepository.override(id)),
      trainingLoad: this.workoutsRepository.trainingLoad(id),
      zoneSummary,
      zoneProfile: zoneSummary ? this.zonesRepository.profileById(zoneSummary.zoneProfileId) : null,
      // 两块视图的**路线**半边（PR5 S5 / D5 最后一段）。行视图那半边在
      // `currentFacts`/`publishedAnalysis` 的列表端点上；这里回答的是同一个问题的
      // "轨迹"部分：同一次发布的两张轨迹图，各自来自自己的版本。
      ...this.detailRouteBlocks(row, options.includeRoute !== false)
    };
  }

  /**
   * 详情路线的两块（PR5 S5，判据 C8）。
   *
   * 🔴 三个决定，每一个都是 C8 的突变靶子：
   * 1. **分析块读版本表**（`routeVersions.publishedRouteVersionId` →
   *    `route_version_points` 按 `sequence`），**不是**当前 `route_points`。
   * 2. **事实块读当前 `route_points`**。两块走两张表，所以"分析块偷偷读了当前轨迹"
   *    可以被一条断言钉住（两条轨迹的内容在夹具里刻意不同）。
   * 3. **老库退化必须标注**：指针为 `NULL` ⇒ 分析块退回当前 `route_points`，且
   *    `routeVersionId` 是 `null`。若不标注，"读了版本表"与"退化了"在响应里
   *    完全一样 —— 那正是 C8 的突变靶子（"让分析块继续读当前 route_points 且不标注退化"）。
   *
   * ⚠️ `includeRoute === false`（匿名公开读）时**一个坐标查询都不许发生**：这不是本批新增的
   * 约束，而是 `/v1/workouts/:id` 既有的安全语义（`data.test.ts` 用 `mock.callCount() === 0`
   * 钉住"公开详情连私密坐标都不查"）。所以两块在这里给空轨迹 + `routeVersionId: null`：
   * **没有查过坐标**比"查了但不返回"更诚实，后者会把坐标留在进程内存里。
   */
  private detailRouteBlocks(
    row: StoredWorkoutDetailRow,
    includeRoute: boolean
  ): Pick<WorkoutDetailResponse, "facts" | "analysis"> {
    // 两类事实都不依赖坐标，所以公开读也能给出：分析行的存在性（`assessment`）与
    // 已发布版本指针（`pointer`）。指针本身不是坐标，公开它是安全的 —— 客户端需要它
    // 才知道"这块路线是版本内容还是退化内容"。
    const assessed = this.workoutsRepository.getDetailRow(row.sessionId) !== null;
    const pointer = this.workoutsRepository.routePointer(row.canonicalWorkoutId);
    const publishedVersionId = pointer?.publishedRouteVersionId ?? null;
    const currentRoute = includeRoute
      ? this.seriesRepository.routePoints(row.canonicalWorkoutId) as RoutePointDto[]
      : [];
    const versionRoute = !includeRoute || publishedVersionId === null
      ? null
      : this.seriesRepository.routePointsByVersion(publishedVersionId) as RoutePointDto[] | null;
    return {
      facts: {
        workoutId: row.sessionId,
        route: currentRoute,
        // 事实块**永远**没有版本指针：它读的就是当前 `route_points`（D5）。写成字面量
        // `null` 而不是省略，让"这一侧没有版本概念"变成可断言的取值。
        routeVersionId: null,
        analysisState: assessed ? "analyzed" : "pending"
      },
      analysis: {
        workoutId: row.sessionId,
        releaseId: null,
        // 退化分支：指针 NULL（老库）**或**版本内容读不到 ⇒ 用当前轨迹，并**标注** null。
        route: versionRoute ?? currentRoute,
        routeVersionId: versionRoute === null ? null : publishedVersionId,
        // 退化读（或公开读）不是"那次发布的输入"，所以如实标 stale。
        stale: versionRoute === null,
        factDeleted: false
      }
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
      timezone: DATABASE_TIMEZONE,
      status: overview.status,
      recoveryTime: this.recoveryEstimate(overview.status?.chronicEwma ?? null),
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
      timezone: DATABASE_TIMEZONE,
      granularity,
      periods: this.statisticsRepository.history(granularity, limit)
    };
  }

  trainingLoadTimeline(days: number): TrainingLoadTimelineResponse {
    const timeline = this.statisticsRepository.loadTimeline(days);
    if (!timeline) {
      return { generatedAt: new Date().toISOString(), timezone: DATABASE_TIMEZONE, days: [], components: [] };
    }
    return {
      generatedAt: new Date().toISOString(),
      timezone: DATABASE_TIMEZONE,
      // §9.6 form is read-time only: the persisted daily metric is unchanged, so
      // no model-run scale moves and the transition gate sees the same numbers.
      days: withTrainingForm(timeline.days),
      components: timeline.components
    };
  }

  /**
   * §9.6 load-proxy recovery estimate.
   *
   * Anchored on the newest finished session and scaled by that session's load
   * relative to the athlete's own chronic EWMA. It is deliberately **not** merged
   * with today's Readiness here: `physState` has exactly one producer (the mobile
   * today path) and inventing a second one on the desktop surface would let the
   * two screens disagree about the same morning. `estimateRecoveryTime` already
   * accepts `physState`; wiring it in belongs where that value exists.
   */
  private recoveryEstimate(chronicEwma: number | null): RecoveryTimeEstimate {
    return estimateRecoveryTime({
      now: new Date(),
      recentLoads: this.statisticsRepository.recentLoads(5),
      chronicEwma
    });
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

  private workoutGradeContext(session: StoredSeriesSession) {
    const { id, startedAt, endedAt, sourceName, distanceKm } = session;
    const splits = this.seriesRepository.workoutSplits(startedAt, endedAt, sourceName, distanceKm);
    const elevationSeries = this.seriesRepository.routeElevationSeries(id);
    // Grade is computed here rather than inside the splits query: the splits read
    // repository is a data accessor, and the cost model lives in @rai/physiology.
    const grade = splitGradeContexts({
      startedAtMs: Date.parse(startedAt),
      splits,
      elevationPoints: elevationSeries.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.value
      }))
    });
    return { splits, elevationSeries, grade };
  }

  workoutSeries(id: string, candidates: PlanCandidateDay[] = []): WorkoutSeriesResponse | null {
    const session = this.seriesRepository.sessionForSeries(id);
    if (!session) return null;
    const { startedAt, endedAt, sourceCategory, sourceName } = session;
    const segmentation = this.segmentRun(session, candidates);
    const { splits, elevationSeries, grade } = this.workoutGradeContext(session);
    const series = {
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
      elevation: this.asMetricSeries(elevationSeries),
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
    };
    return {
      trainingSessionId: id,
      startedAt,
      endedAt,
      sourceCategory,
      splits: splits.map((split, index) => ({ ...split, grade: grade.splits[index] ?? null })),
      grade: grade.summary,
      segments: segmentation.segments,
      segmentPlan: segmentation.plan,
      segmentNote: segmentation.note,
      hasMeasuredWorkoutSteps: segmentation.hasMeasuredWorkoutSteps,
      // §19: coverage and speed-matched drift, computed at read time like the
      // segments. Display-only — nothing here reaches CA/TA.
      dynamics: buildRunningDynamics({
        durationSeconds: Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
        series
      }),
      series
    };
  }

  /**
   * §12.10 manually entered race results, newest first.
   *
   * Returns revoked rows too: the list is the record of what was entered, and hiding
   * a withdrawn entry would make the label count impossible to reconcile by hand.
   */
  performanceEntries(): StoredPerformanceEntry[] {
    return this.performanceEntryRepository.list();
  }

  /**
   * §12.11 how far the runner is from a personal calibration tier.
   *
   * Reports the funnel (which is the reconciliation view T03 asks for) plus the
   * floors still unmet. It deliberately does **not** produce an interval: a band is
   * only fitted from held-out residuals, and this read path has no predictor run.
   */
  labelProgress(): {
    funnel: LabelFunnelReport;
    personal: PersonalCalibrationProgress;
    candidates: RaceCandidate[];
  } {
    const asOf = new Date().toISOString();
    const pass = buildPersonalCalibrationSamples(this.database, asOf);
    const readiness = personalCalibrationReadiness(pass.samples);
    const fitted = readiness.available ? fitPersonalInterval({ samples: pass.samples }) : null;
    return {
      funnel: buildLabelFunnel(this.database, asOf),
      personal: {
        ...readiness,
        labelCount: pass.labelCount,
        scoredCount: pass.scoredCount,
        band: fitted
      },
      candidates: this.raceCandidates(asOf)
    };
  }

  /**
   * §12.13 sessions that look like a race or a time trial.
   *
   * Read-only suggestions: confirming one posts a manual entry, so the candidate list
   * can never become a label on its own.
   */
  private raceCandidates(asOf: string): RaceCandidate[] {
    const labelled = new Set(loadLabeledRaceOutcomes(this.database, asOf).map((outcome) => outcome.id));
    const rows = this.database
      .prepare(`
        SELECT session.id,
          session.anchor_end_at AS completedAt,
          session.anchor_distance_km AS distanceKm,
          ${activeDurationSecondsSql("session")} AS durationSeconds
        FROM training_sessions session
        WHERE session.status = 'active' AND ${sessionFactPresentConditionSql("session")}
          AND session.anchor_distance_km IS NOT NULL
          AND session.anchor_distance_km > 0
          AND session.anchor_end_at <= ?
        ORDER BY session.anchor_end_at DESC
        LIMIT 400
      `)
      .all(asOf) as unknown as Array<{
        id: string;
        completedAt: string;
        distanceKm: number;
        durationSeconds: number;
      }>;
    // Manual entries are the confirmation record: an entry made for a date+distance
    // retires the candidate that suggested it.
    const entered = new Set(
      this.performanceEntryRepository
        .list()
        .filter((entry) => entry.revokedAt === null)
        .map((entry) => candidateEntryKey(entry.localDate, entry.distance))
    );
    return findRaceCandidates(
      rows.filter(row => {
        const standard = nearestStandardDistance(row.distanceKm * 1_000);
        if (!standard) return false;
        return !loadPerformanceEventSessions(this.database, {
          localDate: localDateInShanghai(new Date(row.completedAt)),
          distance: standard.distance,
          trainingSessionId: row.id
        }, asOf).some(session => session.eligibilityOverride === "exclude");
      }).map((row) => ({
        trainingSessionId: row.id,
        completedAt: row.completedAt,
        localDate: localDateInShanghai(new Date(row.completedAt)),
        distanceMeters: row.distanceKm * 1_000,
        durationSeconds: row.durationSeconds,
        labelled: labelled.has(row.id)
      })),
      { existingEntryKeys: entered }
    )
      // Newest first, and only the strongest few: a list of forty suggestions is a
      // list nobody reads.
      .sort((left, right) => right.localDate.localeCompare(left.localDate))
      .slice(0, 12);
  }

  /** Configured privacy zones (docs/DECISIONS.md D9). Token-gated at the route. */
  privacyZones(): { revision: number; stateToken: string; zones: StoredPrivacyZone[] } {
    return { revision: this.privacyZoneRepository.revision(), stateToken: this.privacyZoneRepository.stateToken(), zones: this.privacyZoneRepository.list() };
  }

  /**
   * Share card for one run: the numbers plus the **already trimmed** route.
   *
   * Trimming happens here, on the server, so the credential that can see raw
   * coordinates is not the one that renders the card. Clients draw `polylines` and
   * cannot reconnect across a cut because the cut is a separate array element.
   */
  workoutShareCard(id: string): ShareCardResponse | null {
    const row = this.workoutsRepository.getDetailRow(id);
    if (!row) return null;
    const zones = this.privacyZoneRepository.list();
    const points = this.seriesRepository.routePoints(row.canonicalWorkoutId);
    const trimmed = trimRouteForShare(
      points.map((point) => ({ latitude: point.latitude, longitude: point.longitude })),
      zones.map((zone) => ({
        centerLatitude: zone.centerLatitude,
        centerLongitude: zone.centerLongitude,
        radiusMeters: zone.radiusMeters
      }))
    );
    const distanceKm = row.distanceKm;
    const durationSeconds = row.durationSeconds;
    const session = this.seriesRepository.sessionForSeries(id);
    const grade = session ? this.workoutGradeContext(session).grade.summary : null;
    // 2026-10-15（审查 🟡-B4/B5）：判定顺序修正 —— 先回答"有没有轨迹"，再区分"未配置"
    // 与"配置了但参数无效"。旧顺序下无 GPS 的室内跑会被报成"未配置隐私区：卡片显示完整
    // 轨迹"（而它根本没有轨迹），且 iOS 的兜底文案永不生效。
    const note = trimmed.polylines.length === 0
      ? (trimmed.zonesApplied === 0
        ? "本次训练暂无可分享的 GPS 路线。"
        : "整条轨迹都在隐私区内，卡片不含路线。")
      : zones.length === 0
        ? "未配置隐私区：卡片显示完整轨迹。"
        : trimmed.zonesApplied === 0
          ? "已配置的隐私区参数无效（半径或坐标异常），当前未生效；卡片显示完整轨迹。"
          : trimmed.gaps > 0
            ? `路线在隐私区处断开（${trimmed.gaps} 处），区域内的坐标从未离开服务器。`
            : "隐私区未与本次路线相交。";
    return {
      trainingSessionId: id,
      generatedAt: new Date().toISOString(),
      privacy: {
        policyVersion: SHARE_CARD_POLICY_VERSION,
        zonesApplied: trimmed.zonesApplied,
        redactedPoints: trimmed.redactedPoints,
        gaps: trimmed.gaps,
        unfiltered: trimmed.zonesApplied === 0
      },
      workout: {
        startedAt: row.startedAt,
        sessionType: row.sessionType,
        distanceKm,
        durationSeconds,
        averagePaceSecondsPerKm: paceSeconds(durationSeconds, distanceKm),
        averageHeartRateBpm: row.averageHeartRateBpm,
        elevationGainMeters: this.workoutsRepository.elevationGain(row.canonicalWorkoutId),
        gradeAdjustedPaceSecondsPerKm: grade?.gradeAdjustedPaceSecondsPerKm ?? null
      },
      polylines: trimmed.polylines,
      note
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
      engineVersion: summary.engineVersion,
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
    return this.cached("data-audit", () => ({
      ...this.auditRepository.dataAudit(),
      // §5.2 "count first, then decide": the availability of the environment
      // fields decides whether a fitted correction can ever be honest, so it is
      // reported in the product rather than only in a CLI run on a DB copy.
      environment: environmentCoverage(this.auditRepository.workoutMetadataRows())
    }));
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
    /** v35 的分析任务绑定列（PR5 清单 18）。**可选**：老任务没有绑定。 */
    targetRawGeneration?: number;
    targetDependencyGeneration?: number;
    expectedIncumbentReleaseId?: string;
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
      completedAt: job.completedAt,
      // 🔴 原样透传，**不做 `?? null`**：`RecomputeJobRepository.map()` 只在列真的有值时
      // 才设这三个键，所以"没有绑定"的正确 DTO 形态是**缺键**（`undefined` 不参与
      // `JSON.stringify`），而不是 `null`。补成 `null` 会让客户端无法区分
      // "老任务（v35 之前）"与"绑定了一个空值"，而 `/v1/jobs` 是唯一的读取面
      // —— 这份绑定信息读不出去时，C10 断言的正是"它读得出"。
      ...(job.targetRawGeneration === undefined ? {} : { targetRawGeneration: job.targetRawGeneration }),
      ...(job.targetDependencyGeneration === undefined
        ? {} : { targetDependencyGeneration: job.targetDependencyGeneration }),
      ...(job.expectedIncumbentReleaseId === undefined
        ? {} : { expectedIncumbentReleaseId: job.expectedIncumbentReleaseId })
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
