import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
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
  type RecomputeJobType,
  type RunStatus,
  type SessionType,
  type TrainingZoneProfileSettings,
  type UpdateTrainingZoneProfileInput,
  type WorkoutFeatureVector,
  type WorkoutOverride,
  type WorkoutZoneSummary
} from "@rai/contracts";
import {
  defaultFeatureConfig,
  extractWorkoutFeatureVector,
  type FeatureConfig,
  type NumericSeriesSummary,
  type WorkoutFeatureSource
} from "@rai/features";
import { RaiDatabase, type RecomputePlan } from "@rai/health-export-parser";
import {
  createPersonalBaseline,
  defaultRaiModelConfig,
  hasCompletedCalibration,
  inactivityDecay,
  MODEL_CONFIG_VERSION,
  scoreFeature,
  trueAbilityAfterInactivity,
  updateTrueAbilityFromFeatureScore,
  type RaiModelConfig,
  type PersonalBaseline
} from "@rai/scoring";
import {
  buildDailyTrainingMetrics,
  calculateWorkoutTrainingLoad,
  defaultDailyMetricConfig,
  type HeartRateSample,
  type RecoveryEvidence
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
  loadPerformanceVdotEvidence
} from "./prediction-data.js";

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
} from "./utils.js";

const runningType = "HKWorkoutActivityTypeRunning";
const heartRateType = "HKQuantityTypeIdentifierHeartRate";
const runningSpeedType = "HKQuantityTypeIdentifierRunningSpeed";
const restingHeartRateType = "HKQuantityTypeIdentifierRestingHeartRate";
const hrvType = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
const sleepType = "HKCategoryTypeIdentifierSleepAnalysis";
const distanceType = "HKQuantityTypeIdentifierDistanceWalkingRunning";

interface SessionRow {
  trainingSessionId: string;
  trainingSessionStatus: "active" | "inactive" | "ambiguous";
  canonicalWorkoutId: string;
  workoutStartAt: string;
  workoutEndAt: string;
  durationSeconds: number;
  indoor: number | null;
  sourceCategory: string;
  sourceName: string;
  distanceValue: number | null;
  distanceUnit: string | null;
}

interface StatisticRow {
  averageValue: number | null;
  minimumValue: number | null;
  maximumValue: number | null;
  unit: string | null;
}

interface RecordRow {
  value: number;
  startAt: string;
  endAt: string;
}

interface RouteQualityRow {
  pointCount: number;
  averageHorizontalAccuracy: number | null;
}

interface TimelineAssessment {
  id: string;
  workoutStartAt: string;
  assessmentStatus: EligibilityStatus | "calibrating";
  trueAbilityAfter: number | null;
}

interface RecomputeRequest {
  evaluatedAt: string;
  timezoneIdentifier: string;
  featureConfig: FeatureConfig;
  modelConfig: RaiModelConfig;
  incrementalPlan?: RecomputePlan;
  validationMode: "off" | "shadow";
}

export interface RecomputeOptions {
  evaluatedAt?: string;
  timezoneIdentifier?: string;
  featureConfig?: FeatureConfig;
  modelConfig?: RaiModelConfig;
  validationMode?: "off" | "shadow";
}

const MODEL_CHECKPOINT_VERSION = "rai-model-checkpoint-v1";

interface ModelCheckpointState {
  baseline: PersonalBaseline;
  trueAbility: number;
  lastEligibleLocalDate: string | null;
  lastEligibleTrueAbility: number;
  eligibleWorkoutCount: number;
}

interface ReplayResume {
  parentModelRunId: string;
  throughSequence: number;
  state: ModelCheckpointState;
}

export interface AppendWorkoutOverrideInput {
  trainingSessionId: string;
  eligibilityOverride: "include" | "exclude" | null;
  statisticsParticipation?: "include" | "exclude" | null;
  sessionType: SessionType | null;
  performanceProtocol: PerformanceProtocol | null;
  rpe: number | null;
  conditionTags: string[];
  note: string | null;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const asNullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function convertDistanceToKilometers(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  switch (unit?.toLowerCase()) {
    case "km":
      return value;
    case "m":
      return value / 1000;
    case "mi":
      return value * 1.609344;
    default:
      return null;
  }
}

function convertSpeedToMetersPerSecond(value: number, unit: string | null): number {
  switch (unit?.toLowerCase()) {
    case "km/hr":
    case "km/h":
      return value / 3.6;
    case "mi/hr":
    case "mph":
      return value * 0.44704;
    default:
      return value;
  }
}

function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  if (mean === 0) return null;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

interface WeightedRecordInterval {
  value: number;
  startMs: number;
  endMs: number;
  durationSeconds: number;
}

function weightedRecordIntervals(
  rows: RecordRow[],
  workoutStartAt: string,
  workoutEndAt: string,
  converter: (value: number) => number
): WeightedRecordInterval[] {
  const workoutStartMs = Date.parse(workoutStartAt);
  const workoutEndMs = Date.parse(workoutEndAt);
  return rows.flatMap((row, index) => {
    const rowStartMs = Math.max(workoutStartMs, Date.parse(row.startAt));
    const rawEndMs = Date.parse(row.endAt);
    const nextStartMs = Date.parse(rows[index + 1]?.startAt ?? workoutEndAt);
    const inferredEndMs = rawEndMs > Date.parse(row.startAt)
      ? rawEndMs
      : Math.min(nextStartMs, Date.parse(row.startAt) + 30_000);
    const rowEndMs = Math.min(workoutEndMs, inferredEndMs);
    if (!Number.isFinite(rowStartMs) || !Number.isFinite(rowEndMs) || rowEndMs <= rowStartMs) return [];
    return [{
      value: converter(row.value),
      startMs: rowStartMs,
      endMs: rowEndMs,
      durationSeconds: (rowEndMs - rowStartMs) / 1000
    }];
  });
}

function coveredDurationSeconds(intervals: WeightedRecordInterval[]): number {
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs);
  let coveredMs = 0;
  let currentStart = -1;
  let currentEnd = -1;
  for (const interval of sorted) {
    if (currentStart < 0) {
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
    } else if (interval.startMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.endMs);
    } else {
      coveredMs += currentEnd - currentStart;
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
    }
  }
  if (currentStart >= 0) coveredMs += currentEnd - currentStart;
  return coveredMs / 1000;
}

function sustainedThirtySecondPeak(
  intervals: WeightedRecordInterval[],
  workoutStartAt: string,
  workoutEndAt: string
): number | null {
  const startMs = Date.parse(workoutStartAt);
  const durationSeconds = Math.max(0, Math.ceil((Date.parse(workoutEndAt) - startMs) / 1000));
  if (!Number.isFinite(startMs) || durationSeconds < 30 || durationSeconds > 24 * 3600) return null;
  const perSecond = new Array<number | null>(durationSeconds).fill(null);
  for (const interval of intervals) {
    const start = Math.max(0, Math.floor((interval.startMs - startMs) / 1000));
    const end = Math.min(durationSeconds, Math.ceil((interval.endMs - startMs) / 1000));
    for (let second = start; second < end; second += 1) perSecond[second] = interval.value;
  }
  let peak: number | null = null;
  for (let start = 0; start + 30 <= perSecond.length; start += 1) {
    const values = perSecond.slice(start, start + 30).filter((value): value is number => value !== null);
    if (values.length < 24) continue;
    const value = median(values);
    if (value !== null && (peak === null || value > peak)) peak = value;
  }
  return peak;
}

function summaryFromRecords(
  rows: RecordRow[],
  unit: string | null,
  workoutStartAt: string,
  workoutEndAt: string,
  converter: (value: number, unit: string | null) => number = (value) => value
): NumericSeriesSummary {
  const intervals = weightedRecordIntervals(
    rows,
    workoutStartAt,
    workoutEndAt,
    (value) => converter(value, unit)
  );
  if (intervals.length === 0) {
    return {
      average: null,
      minimum: null,
      maximum: null,
      sampleCount: 0,
      firstAt: null,
      lastAt: null,
      coefficientOfVariation: null,
      coveredDurationSeconds: null
    };
  }
  const totalWeight = intervals.reduce((total, interval) => total + interval.durationSeconds, 0);
  const weightedAverage = intervals.reduce(
    (total, interval) => total + interval.value * interval.durationSeconds,
    0
  ) / totalWeight;
  const weightedVariance = intervals.reduce(
    (total, interval) => total + (interval.value - weightedAverage) ** 2 * interval.durationSeconds,
    0
  ) / totalWeight;
  const values = intervals.map((interval) => interval.value);
  return {
    average: weightedAverage,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    sampleCount: values.length,
    firstAt: new Date(Math.min(...intervals.map((interval) => interval.startMs))).toISOString(),
    lastAt: new Date(Math.max(...intervals.map((interval) => interval.endMs))).toISOString(),
    coefficientOfVariation: weightedAverage === 0 ? null : Math.sqrt(weightedVariance) / Math.abs(weightedAverage),
    coveredDurationSeconds: coveredDurationSeconds(intervals)
  };
}

function fallbackStatisticSummary(
  statistic: StatisticRow | null,
  workoutStartAt: string,
  workoutEndAt: string,
  converter: (value: number, unit: string | null) => number = (value) => value
): NumericSeriesSummary {
  if (statistic === null || statistic.averageValue === null) {
    return {
      average: null,
      minimum: null,
      maximum: null,
      sampleCount: 0,
      firstAt: null,
      lastAt: null,
      coefficientOfVariation: null,
      coveredDurationSeconds: null
    };
  }
  const average = statistic.averageValue;
  const convertedAverage = converter(average, statistic.unit);
  const convertedMinimum =
    statistic.minimumValue === null ? null : converter(statistic.minimumValue, statistic.unit);
  const convertedMaximum =
    statistic.maximumValue === null ? null : converter(statistic.maximumValue, statistic.unit);
  return {
    average: convertedAverage,
    minimum: convertedMinimum,
    maximum: convertedMaximum,
    // An aggregate WorkoutStatistic is sufficient evidence but does not expose its raw count.
    sampleCount: 10,
    firstAt: workoutStartAt,
    lastAt: workoutEndAt,
    coefficientOfVariation:
      convertedMinimum !== null && convertedMaximum !== null && convertedAverage !== 0
        ? Math.abs(convertedMaximum - convertedMinimum) / (4 * Math.abs(convertedAverage))
        : null,
    coveredDurationSeconds: Math.max(0, (Date.parse(workoutEndAt) - Date.parse(workoutStartAt)) / 1000)
  };
}

function defaultRequest(options: RecomputeOptions = {}): RecomputeRequest {
  return {
    evaluatedAt: options.evaluatedAt ?? appNow(),
    timezoneIdentifier: options.timezoneIdentifier ?? "Asia/Shanghai",
    featureConfig: options.featureConfig ?? defaultFeatureConfig,
    modelConfig: options.modelConfig ?? defaultRaiModelConfig,
    validationMode: options.validationMode ?? "off"
  };
}

export class RaiApplicationService {
  constructor(private readonly store: RaiDatabase) {}

  get database(): DatabaseSync {
    return this.store.database;
  }

  enqueueFullRecompute(options: RecomputeOptions = {}): string {
    return this.enqueueJob("full_recompute", defaultRequest(options));
  }

  enqueueIncrementalRecompute(plan: RecomputePlan, options: RecomputeOptions = {}): string | null {
    if (plan.mode === "none") return null;
    const request = defaultRequest(options);
    return this.enqueueJob("full_recompute", {
      ...request,
      ...(plan.mode === "partial" && plan.dirtyFromAt !== null ? { incrementalPlan: plan } : {})
    });
  }

  enqueueSnapshotRefresh(options: Pick<RecomputeOptions, "evaluatedAt" | "timezoneIdentifier"> = {}): string {
    return this.enqueueJob("snapshot_refresh", defaultRequest(options));
  }

  recoverInterruptedJobs(): number {
    const jobs = this.database.prepare(`
      SELECT id, feature_run_id AS featureRunId, model_run_id AS modelRunId,
        cancel_requested AS cancelRequested
      FROM recompute_jobs WHERE status = 'running' ORDER BY created_at
    `).all() as unknown as Array<{
      id: string;
      featureRunId: string | null;
      modelRunId: string | null;
      cancelRequested: number;
    }>;
    if (jobs.length === 0) return 0;
    const now = appNow();
    const failure = JSON.stringify({
      name: "InterruptedRecompute",
      message: "Local API restarted before the recompute completed"
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const job of jobs) {
        if (job.featureRunId) {
          this.database.prepare(`
            UPDATE feature_runs SET status = 'failed', completed_at = ?, failure_json = ?
            WHERE id = ? AND status = 'running'
          `).run(now, failure, job.featureRunId);
        }
        if (job.modelRunId) {
          this.database.prepare(`
            UPDATE training_metric_runs SET status = 'failed', completed_at = ?, failure_json = ?
            WHERE model_run_id = ? AND status = 'running'
          `).run(now, failure, job.modelRunId);
          this.database.prepare(`
            UPDATE model_runs SET status = 'failed', completed_at = ?, failure_json = ?
            WHERE id = ? AND status = 'running'
          `).run(now, failure, job.modelRunId);
        }
        const cancelled = job.cancelRequested === 1;
        this.database.prepare(`
          UPDATE recompute_jobs
          SET status = ?, started_at = NULL, completed_at = ?, progress_phase = ?,
              progress_current = 0, progress_total = 0, cancel_requested = 0,
              error_json = ?
          WHERE id = ?
        `).run(
          cancelled ? "cancelled" : "queued",
          cancelled ? now : null,
          cancelled ? "cancelled" : "recovered",
          cancelled ? failure : null,
          job.id
        );
        this.database.prepare(`
          INSERT INTO recompute_job_events (
            id, job_id, phase, progress_current, progress_total, message, created_at
          ) VALUES (?, ?, ?, 0, 0, ?, ?)
        `).run(
          opaqueId("recompute_job_event"),
          job.id,
          cancelled ? "cancelled" : "recovered",
          cancelled ? "Interrupted task was cancelled" : "Interrupted task returned to the queue",
          now
        );
      }
      this.database.exec("COMMIT");
      return jobs.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  appendTrainingZoneProfileSettings(
    input: UpdateTrainingZoneProfileInput,
    timezoneIdentifier = "Asia/Shanghai"
  ): TrainingZoneProfileSettings {
    const validateManual = (mode: "auto" | "manual", value: number | null, low: number, high: number, name: string): void => {
      if (mode === "manual" && (!finiteNumber(value) || value < low || value > high)) {
        throw new Error(`${name} manual value must be between ${low} and ${high}`);
      }
      if (mode === "auto" && value !== null) throw new Error(`${name} automatic mode must not include a value`);
    };
    validateManual(input.restingHeartRate.mode, input.restingHeartRate.valueBpm, 35, 110, "Resting heart rate");
    validateManual(input.maximumHeartRate.mode, input.maximumHeartRate.valueBpm, 120, 230, "Maximum heart rate");
    validateManual(input.lactateThresholdPace.mode, input.lactateThresholdPace.valueSecondsPerKm, 150, 900, "Threshold pace");
    if (
      input.restingHeartRate.mode === "manual" && input.maximumHeartRate.mode === "manual" &&
      input.restingHeartRate.valueBpm !== null && input.maximumHeartRate.valueBpm !== null &&
      input.maximumHeartRate.valueBpm - input.restingHeartRate.valueBpm < 30
    ) throw new Error("Maximum heart rate must be at least 30 bpm above resting heart rate");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM training_zone_profile_settings")
        .get() as unknown as { revision: number };
      if (Number(row.revision) !== input.expectedRevision) throw new Error("Training zone settings revision conflict");
      const revision = Number(row.revision) + 1;
      const createdAt = appNow();
      const effectiveFromLocalDate = addDays(localDateAt(createdAt, timezoneIdentifier), 1);
      this.database.prepare(`
        INSERT INTO training_zone_profile_settings (
          id, revision, effective_from_local_date, resting_mode, resting_value_bpm,
          maximum_mode, maximum_value_bpm, threshold_pace_mode,
          threshold_pace_seconds_per_km, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        opaqueId("training_zone_settings"), revision, effectiveFromLocalDate,
        input.restingHeartRate.mode, input.restingHeartRate.valueBpm,
        input.maximumHeartRate.mode, input.maximumHeartRate.valueBpm,
        input.lactateThresholdPace.mode, input.lactateThresholdPace.valueSecondsPerKm,
        createdAt
      );
      this.database.exec("COMMIT");
      return {
        revision,
        effectiveFromLocalDate,
        restingHeartRate: input.restingHeartRate,
        maximumHeartRate: input.maximumHeartRate,
        lactateThresholdPace: input.lactateThresholdPace,
        createdAt
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  appendWorkoutOverride(input: AppendWorkoutOverrideInput): string {
    if (input.rpe !== null && (!Number.isInteger(input.rpe) || input.rpe < 1 || input.rpe > 10)) {
      throw new Error("RPE must be an integer from 1 through 10");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const session = this.database
        .prepare("SELECT id FROM training_sessions WHERE id = ?")
        .get(input.trainingSessionId) as unknown as { id: string } | undefined;
      if (!session) throw new Error(`Unknown training session: ${input.trainingSessionId}`);

      const revisionRow = this.database
        .prepare(
          "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM workout_overrides WHERE training_session_id = ?"
        )
        .get(input.trainingSessionId) as unknown as { revision: number };
      const overrideId = opaqueId("workout_override");
      this.database
        .prepare(`
          INSERT INTO workout_overrides (
            id, training_session_id, revision, eligibility_override, session_type,
            statistics_participation, performance_protocol, rpe, condition_tags_json, note
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          overrideId,
          input.trainingSessionId,
          revisionRow.revision,
          input.eligibilityOverride,
          input.sessionType,
          input.statisticsParticipation ?? null,
          input.performanceProtocol,
          input.rpe,
          JSON.stringify(input.conditionTags),
          input.note
        );
      this.enqueueFullRecompute();
      this.database.exec("COMMIT");
      return overrideId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  requestJobCancellation(jobId: string): "requested" | "terminal" | "not_found" {
    const updated = this.database
      .prepare("UPDATE recompute_jobs SET cancel_requested = 1 WHERE id = ? AND status IN ('queued', 'running')")
      .run(jobId);
    if (Number(updated.changes) === 1) return "requested";
    const existing = this.database
      .prepare("SELECT 1 FROM recompute_jobs WHERE id = ?")
      .get(jobId);
    return existing ? "terminal" : "not_found";
  }

  runNextJob(): RecomputeJob | null {
    const job = this.claimNextJob();
    if (!job) return null;

    try {
      if (job.jobType === "full_recompute") {
        this.runFullRecompute(job);
      } else if (job.jobType === "snapshot_refresh") {
        this.runSnapshotRefresh(job);
      } else {
        throw new Error(`Unsupported application job type: ${job.jobType}`);
      }
      return this.getJob(job.id);
    } catch (error) {
      this.failJob(job.id, error);
      return this.getJob(job.id);
    }
  }

  private enqueueJob(jobType: RecomputeJobType, request: RecomputeRequest): string {
    const id = opaqueId("recompute_job");
    const datasetVersion = this.manifestValue("dataset_version");
    this.database
      .prepare(`
        INSERT INTO recompute_jobs (
          id, job_type, status, dataset_version, request_json, progress_phase
        ) VALUES (?, ?, 'queued', ?, ?, 'queued')
      `)
      .run(id, jobType, datasetVersion, JSON.stringify(request));
    this.logJobEvent(id, "queued", 0, 0, "Task queued");
    return id;
  }

  private claimNextJob(): RecomputeJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare(`
          SELECT * FROM recompute_jobs
          WHERE status = 'queued'
          ORDER BY created_at, id
          LIMIT 1
        `)
        .get() as unknown as Record<string, unknown> | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }
      this.database
        .prepare(`
          UPDATE recompute_jobs
          SET status = 'running', started_at = ?, progress_phase = 'claimed'
          WHERE id = ?
        `)
        .run(appNow(), String(row.id));
      this.database.exec("COMMIT");
      this.logJobEvent(String(row.id), "claimed", 0, 0, "Single worker claimed task");
      return this.getJob(String(row.id));
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private getJob(id: string): RecomputeJob | null {
    const row = this.database.prepare("SELECT * FROM recompute_jobs WHERE id = ?").get(id) as unknown as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapJob(row) : null;
  }

  private mapJob(row: Record<string, unknown>): RecomputeJob {
    return {
      id: String(row.id),
      jobType: String(row.job_type) as RecomputeJobType,
      status: String(row.status) as RunStatus,
      datasetVersion: typeof row.dataset_version === "string" ? row.dataset_version : null,
      featureRunId: typeof row.feature_run_id === "string" ? row.feature_run_id : null,
      modelRunId: typeof row.model_run_id === "string" ? row.model_run_id : null,
      request: parseJson(String(row.request_json), {}),
      progressPhase: String(row.progress_phase),
      progressCurrent: Number(row.progress_current),
      progressTotal: Number(row.progress_total),
      cancelRequested: Number(row.cancel_requested) === 1,
      error: parseJson<Record<string, unknown> | null>(
        typeof row.error_json === "string" ? row.error_json : null,
        null
      ),
      createdAt: String(row.created_at),
      startedAt: typeof row.started_at === "string" ? row.started_at : null,
      completedAt: typeof row.completed_at === "string" ? row.completed_at : null
    };
  }

  private runFullRecompute(job: RecomputeJob): void {
    const request = this.parseRequest(job.request);
    const datasetVersion = this.manifestValue("dataset_version") ?? "dataset_unknown";
    const featureRun = this.createFeatureRun(datasetVersion, request.featureConfig);
    this.setJobRunIds(job.id, featureRun.id, null);
    this.updateJobProgress(job.id, "feature_extraction", 0, 0, "Extracting canonical workout features");

    let features: WorkoutFeatureVector[];
    try {
      features = this.extractFeatures(job.id, featureRun, request);
      this.finishFeatureRun(featureRun.id, "succeeded", null);
    } catch (error) {
      this.finishFeatureRun(featureRun.id, this.isCancellationError(error) ? "cancelled" : "failed", error);
      throw error;
    }

    this.throwIfCancelled(job.id);
    const modelRun = this.createModelRun(datasetVersion, featureRun.id, request);
    this.setJobRunIds(job.id, featureRun.id, modelRun.id);
    const metricRunId = this.createTrainingMetricRun(modelRun.id, request);
    try {
      this.updateJobProgress(job.id, "training_metrics", 0, features.length, "Calculating training load");
      this.replayTrainingMetrics(job.id, metricRunId, features, request);
      this.finishTrainingMetricRun(metricRunId, "succeeded", null);
      this.updateJobProgress(job.id, "model_replay", 0, features.length, "Replaying ability timeline");
      this.replayModel(job.id, modelRun, features, request);
      this.finishModelRun(modelRun.id, "succeeded", null);
      if (request.validationMode === "shadow" && request.incrementalPlan) {
        this.runShadowValidation(job.id, modelRun, request);
      }
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

  private runShadowValidation(jobId: string, candidate: ModelRun, request: RecomputeRequest): void {
    const datasetVersion = this.manifestValue("dataset_version") ?? "dataset_unknown";
    const fullRequest: RecomputeRequest = { ...request, validationMode: "off" };
    delete fullRequest.incrementalPlan;
    this.updateJobProgress(jobId, "shadow_validation", 0, 4, "Building full replay reference");
    const featureRun = this.createFeatureRun(datasetVersion, fullRequest.featureConfig);
    let reference: ModelRun | null = null;
    let metricRunId: string | null = null;
    try {
      const features = this.extractFeatures(jobId, featureRun, fullRequest);
      this.finishFeatureRun(featureRun.id, "succeeded", null);
      reference = this.createModelRun(datasetVersion, featureRun.id, fullRequest);
      metricRunId = this.createTrainingMetricRun(reference.id, fullRequest);
      this.replayTrainingMetrics(jobId, metricRunId, features, fullRequest);
      this.finishTrainingMetricRun(metricRunId, "succeeded", null);
      this.replayModel(jobId, reference, features, fullRequest);
      this.finishModelRun(reference.id, "succeeded", null);
      const comparison = this.compareRunOutputs(candidate.id, reference.id);
      this.database.prepare(`
        INSERT INTO recompute_validations (
          id, job_id, candidate_model_run_id, reference_model_run_id,
          mode, status, hashes_json, mismatch_json
        ) VALUES (?, ?, ?, ?, 'shadow', ?, ?, ?)
      `).run(
        opaqueId("recompute_validation"), jobId, candidate.id, reference.id,
        comparison.mismatches.length === 0 ? "matched" : "mismatched",
        JSON.stringify(comparison.hashes),
        comparison.mismatches.length === 0 ? null : JSON.stringify(comparison.mismatches)
      );
      if (comparison.mismatches.length > 0) {
        throw new Error(`Shadow recompute mismatch: ${comparison.mismatches.join(", ")}`);
      }
      this.updateJobProgress(jobId, "shadow_validation", 4, 4, "Incremental replay matches full replay");
    } catch (error) {
      this.finishFeatureRun(featureRun.id, "failed", error);
      if (metricRunId) this.finishTrainingMetricRun(metricRunId, "failed", error);
      if (reference) this.finishModelRun(reference.id, "failed", error);
      throw error;
    }
  }

  private compareRunOutputs(candidateModelRunId: string, referenceModelRunId: string): {
    hashes: Record<string, { candidate: string; reference: string }>;
    mismatches: string[];
  } {
    const domains = {
      features: {
        sql: `SELECT feature.* FROM workout_features feature JOIN model_runs model ON model.feature_run_id = feature.feature_run_id WHERE model.id = ? ORDER BY feature.workout_start_at, feature.training_session_id`,
        ignored: new Set(["id", "feature_run_id", "computed_at"])
      },
      assessments: {
        sql: `SELECT * FROM ability_assessments WHERE model_run_id = ? ORDER BY sequence_number`,
        ignored: new Set(["id", "model_run_id", "feature_id"])
      },
      snapshots: {
        sql: `SELECT * FROM daily_ability_snapshots WHERE model_run_id = ? ORDER BY local_date`,
        ignored: new Set(["id", "model_run_id", "last_assessment_id", "computed_at"])
      },
      workoutTrainingLoads: {
        sql: `SELECT load.* FROM workout_training_loads load JOIN training_metric_runs run ON run.id = load.training_metric_run_id WHERE run.model_run_id = ? ORDER BY load.local_date, load.training_session_id`,
        ignored: new Set(["id", "training_metric_run_id", "feature_id", "zone_profile_id", "computed_at"])
      },
      dailyTrainingMetrics: {
        sql: `SELECT metric.* FROM daily_training_metrics metric JOIN training_metric_runs run ON run.id = metric.training_metric_run_id WHERE run.model_run_id = ? ORDER BY metric.local_date`,
        ignored: new Set(["id", "training_metric_run_id", "computed_at"])
      },
      dailyZoneProfiles: {
        sql: `SELECT profile.* FROM daily_zone_profiles profile JOIN training_metric_runs run ON run.id = profile.training_metric_run_id WHERE run.model_run_id = ? ORDER BY profile.local_date`,
        ignored: new Set(["id", "training_metric_run_id", "created_at"])
      },
      workoutZoneSummaries: {
        sql: `SELECT summary.* FROM workout_zone_summaries summary JOIN training_metric_runs run ON run.id = summary.training_metric_run_id WHERE run.model_run_id = ? ORDER BY summary.training_session_id`,
        ignored: new Set(["id", "training_metric_run_id", "feature_id", "zone_profile_id", "computed_at"])
      }
    };
    const hashes: Record<string, { candidate: string; reference: string }> = {};
    const mismatches: string[] = [];
    for (const [name, domain] of Object.entries(domains)) {
      const hash = (modelRunId: string): string => {
        const rows = this.database.prepare(domain.sql).all(modelRunId) as unknown as Array<Record<string, unknown>>;
        return configHash(rows.map((row) => Object.fromEntries(
          Object.entries(row).filter(([key]) => !domain.ignored.has(key))
        )));
      };
      const candidateHash = hash(candidateModelRunId);
      const referenceHash = hash(referenceModelRunId);
      hashes[name] = { candidate: candidateHash, reference: referenceHash };
      if (candidateHash !== referenceHash) mismatches.push(name);
    }
    return { hashes, mismatches };
  }

  private runSnapshotRefresh(job: RecomputeJob): void {
    const request = this.parseRequest(job.request);
    const active = this.database
      .prepare("SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1")
      .get() as unknown as { modelRunId: string } | undefined;
    if (!active) {
      this.completeJob(job.id, "no_active_model", 0, 0, "No active model run to refresh");
      return;
    }
    this.setJobRunIds(job.id, null, active.modelRunId);
    const timeline = this.loadTimelineAssessments(active.modelRunId);
    this.writeDailySnapshots(
      active.modelRunId,
      timeline,
      request.evaluatedAt,
      request.timezoneIdentifier,
      true
    );
    const metricRun = this.database
      .prepare("SELECT id FROM training_metric_runs WHERE model_run_id = ? AND status = 'succeeded'")
      .get(active.modelRunId) as unknown as { id: string } | undefined;
    if (metricRun) {
      const featureRun = this.database.prepare("SELECT feature_run_id AS featureRunId FROM model_runs WHERE id = ?")
        .get(active.modelRunId) as unknown as { featureRunId: string } | undefined;
      if (featureRun) {
        this.buildAndPersistZoneProfiles(
          metricRun.id,
          this.loadFeatureRunVectors(featureRun.featureRunId),
          new Map(this.loadSessions().map((session) => [session.trainingSessionId, session])),
          request
        );
      }
      const loads = this.loadPersistedTrainingLoads(metricRun.id);
      const throughDate = localDateAt(request.evaluatedAt, request.timezoneIdentifier);
      const existingThrough = this.database
        .prepare("SELECT MAX(local_date) AS localDate FROM daily_training_metrics WHERE training_metric_run_id = ?")
        .get(metricRun.id) as unknown as { localDate: string | null };
      if (existingThrough.localDate === null || existingThrough.localDate < throughDate) {
        const recovery = this.loadRecoveryEvidence(active.modelRunId, request.timezoneIdentifier);
        const daily = buildDailyTrainingMetrics(loads, throughDate, recovery);
        this.persistDailyTrainingMetrics(metricRun.id, daily, request, true);
      }
    }
    this.completeJob(job.id, "snapshot_refreshed", 1, 1, "Current-day snapshot appended");
  }

  private parseRequest(value: Record<string, unknown>): RecomputeRequest {
    const parsed = value as Partial<RecomputeRequest>;
    return {
      evaluatedAt: typeof parsed.evaluatedAt === "string" ? parsed.evaluatedAt : appNow(),
      timezoneIdentifier:
        typeof parsed.timezoneIdentifier === "string" ? parsed.timezoneIdentifier : "Asia/Shanghai",
      featureConfig: { ...defaultFeatureConfig, ...(parsed.featureConfig ?? {}) },
      modelConfig: { ...defaultRaiModelConfig, ...(parsed.modelConfig ?? {}) }
      ,validationMode: parsed.validationMode === "shadow" ? "shadow" : "off"
      ,...(parsed.incrementalPlan?.mode === "partial" && typeof parsed.incrementalPlan.dirtyFromAt === "string"
        ? { incrementalPlan: parsed.incrementalPlan }
        : {})
    };
  }

  private manifestValue(key: string): string | null {
    const row = this.database
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
        configHash(config),
        createdAt,
        createdAt
      );
    return {
      id,
      datasetVersion,
      canonicalContractVersion,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      featureConfig: config as unknown as Record<string, unknown>,
      featureConfigHash: configHash(config),
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
    const hash = configHash({ version: MODEL_CONFIG_VERSION, config });
    this.database
      .prepare(`
        INSERT INTO model_runs (
          id, feature_run_id, dataset_version, model_version, model_config_json,
          model_config_hash, evaluated_at, status, created_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
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
        createdAt
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

  private createTrainingMetricRun(modelRunId: string, request: RecomputeRequest): string {
    const id = opaqueId("training_metric_run");
    const createdAt = appNow();
    const config = {
      dailyMetrics: defaultDailyMetricConfig,
      zoneVersion: TRAINING_ZONE_CONFIG_VERSION,
      heartRateReserveBoundaries: [0.6, 0.7, 0.8, 0.9],
      paceThresholdMultipliers: [1.15, 1.06, 0.97, 0.9]
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
    this.database.prepare(`
      UPDATE training_metric_runs
      SET status = ?, summary_json = ?, failure_json = ?, completed_at = ?
      WHERE id = ?
    `).run(
      status,
      summary === null ? null : JSON.stringify(summary),
      error === null ? null : JSON.stringify(this.errorPayload(error)),
      appNow(),
      id
    );
  }

  private loadSessions(): SessionRow[] {
    return this.database
      .prepare(`
        SELECT
          session.id AS trainingSessionId,
          session.status AS trainingSessionStatus,
          workout.id AS canonicalWorkoutId,
          workout.start_at AS workoutStartAt,
          workout.end_at AS workoutEndAt,
          workout.duration_seconds AS durationSeconds,
          workout.indoor,
          workout.source_category AS sourceCategory,
          workout.source_name AS sourceName,
          (
            SELECT statistic.sum_value FROM workout_statistics statistic
            WHERE statistic.workout_id = workout.id AND statistic.type = ?
            ORDER BY statistic.ordinal LIMIT 1
          ) AS distanceValue,
          (
            SELECT statistic.unit FROM workout_statistics statistic
            WHERE statistic.workout_id = workout.id AND statistic.type = ?
            ORDER BY statistic.ordinal LIMIT 1
          ) AS distanceUnit
        FROM training_sessions session
        JOIN workouts workout ON workout.id = session.canonical_workout_id
        WHERE session.activity_type = ? AND session.status IN ('active', 'ambiguous')
        ORDER BY workout.start_at, session.id
      `)
      .all(distanceType, distanceType, runningType) as unknown as SessionRow[];
  }

  private loadOverride(trainingSessionId: string): WorkoutOverride | null {
    const row = this.database
      .prepare("SELECT * FROM effective_workout_overrides WHERE training_session_id = ?")
      .get(trainingSessionId) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      trainingSessionId: String(row.training_session_id),
      revision: Number(row.revision),
      eligibilityOverride:
        row.eligibility_override === "include" || row.eligibility_override === "exclude"
          ? row.eligibility_override
          : null,
      sessionType: typeof row.session_type === "string" ? (row.session_type as SessionType) : null,
      performanceProtocol:
        typeof row.performance_protocol === "string"
          ? (row.performance_protocol as PerformanceProtocol)
          : null,
      statisticsParticipation:
        row.statistics_participation === "include" || row.statistics_participation === "exclude"
          ? row.statistics_participation
          : null,
      rpe: typeof row.rpe === "number" ? row.rpe : null,
      conditionTags: parseJson(typeof row.condition_tags_json === "string" ? row.condition_tags_json : "[]", []),
      note: typeof row.note === "string" ? row.note : null,
      createdAt: String(row.created_at)
    };
  }

  private loadStatistic(workoutId: string, type: string): StatisticRow | null {
    const row = this.database
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
    return this.database
      .prepare(`
        SELECT value_numeric AS value, start_at AS startAt, end_at AS endAt
        FROM health_records
        WHERE source_name = ?
          AND type = ?
          AND value_numeric IS NOT NULL
          AND start_at <= ?
          AND end_at >= ?
        ORDER BY start_at
      `)
      .all(sourceName, type, workoutEndAt, workoutStartAt) as unknown as RecordRow[];
  }

  private loadRecoveryAverage(type: string, workoutStartAt: string): number | null {
    const cutoff = new Date(Date.parse(workoutStartAt) - 28 * 86_400_000).toISOString();
    const row = this.database
      .prepare(`
        SELECT AVG(value_numeric) AS value
        FROM health_records
        WHERE type = ? AND value_numeric IS NOT NULL
          AND start_at >= ? AND start_at < ?
      `)
      .get(type, cutoff, workoutStartAt) as unknown as { value: number | null } | undefined;
    return asNullableNumber(row?.value);
  }

  private loadObservedMaximumHeartRate(workoutStartAt: string): number | null {
    const cutoff = new Date(Date.parse(workoutStartAt) - 180 * 86_400_000).toISOString();
    const row = this.database
      .prepare(`
        SELECT MAX(value_numeric) AS value
        FROM health_records
        WHERE type = ? AND value_numeric IS NOT NULL
          AND start_at >= ? AND start_at < ?
      `)
      .get(heartRateType, cutoff, workoutStartAt) as unknown as { value: number | null } | undefined;
    return asNullableNumber(row?.value);
  }

  private loadSleepDurationMinutes(workoutStartAt: string): number | null {
    const cutoff = new Date(Date.parse(workoutStartAt) - 36 * 3_600_000).toISOString();
    const rows = this.database
      .prepare(`
        SELECT start_at AS startAt, end_at AS endAt, value_text AS valueText
        FROM health_records
        WHERE type = ? AND start_at >= ? AND end_at <= ?
      `)
      .all(sleepType, cutoff, workoutStartAt) as unknown as Array<{
      startAt: string;
      endAt: string;
      valueText: string | null;
    }>;
    const minutes = rows
      .filter((row) => row.valueText?.includes("Asleep") ?? false)
      .reduce((total, row) => total + Math.max(0, Date.parse(row.endAt) - Date.parse(row.startAt)) / 60_000, 0);
    return minutes > 0 ? minutes : null;
  }

  private loadRecentLoadMinutes(workoutStartAt: string): number | null {
    const cutoff = new Date(Date.parse(workoutStartAt) - 7 * 86_400_000).toISOString();
    const row = this.database
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

  private loadRouteQuality(workoutId: string): RouteQualityRow {
    const row = this.database
      .prepare(`
        SELECT
          COUNT(point.sequence) AS pointCount,
          AVG(point.horizontal_accuracy_meters) AS averageHorizontalAccuracy
        FROM workout_routes route
        LEFT JOIN route_points point ON point.route_id = route.id
        WHERE route.workout_id = ? AND route.file_status = 'imported'
      `)
      .get(workoutId) as unknown as RouteQualityRow | undefined;
    return {
      pointCount: Number(row?.pointCount ?? 0),
      averageHorizontalAccuracy: asNullableNumber(row?.averageHorizontalAccuracy)
    };
  }

  private loadElevationGain(workoutId: string): number | null {
    const rows = this.database.prepare(`
      SELECT point.elevation_meters AS elevation
      FROM workout_routes route
      JOIN route_points point ON point.route_id = route.id
      WHERE route.workout_id = ? AND point.elevation_meters IS NOT NULL
      ORDER BY point.sequence
    `).all(workoutId) as unknown as Array<{ elevation: number }>;
    if (rows.length < 2) return null;
    let gain = 0;
    let previous = Number(rows[0]!.elevation);
    for (const row of rows.slice(1)) {
      const current = Number(row.elevation);
      const delta = current - previous;
      // Reject GPS altitude spikes while preserving ordinary climbing.
      if (Number.isFinite(delta) && delta > 0 && delta < 30) gain += delta;
      previous = current;
    }
    return gain;
  }

  private buildFeatureSource(row: SessionRow): WorkoutFeatureSource {
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
          "km/hr",
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
      heartRate,
      restingHeartRate: this.loadRecoveryAverage(restingHeartRateType, row.workoutStartAt),
      hrvSdnn: this.loadRecoveryAverage(hrvType, row.workoutStartAt),
      sleepDurationMinutes: this.loadSleepDurationMinutes(row.workoutStartAt),
      recentLoadMinutes: this.loadRecentLoadMinutes(row.workoutStartAt),
      observedMaximumHeartRate: this.loadObservedMaximumHeartRate(row.workoutStartAt),
      override: this.loadOverride(row.trainingSessionId)
    };
  }

  private extractFeatures(
    jobId: string,
    featureRun: FeatureRun,
    request: RecomputeRequest
  ): WorkoutFeatureVector[] {
    const allSessions = this.loadSessions();
    const reuse = this.reuseFeaturePrefix(featureRun, request);
    const sessions = reuse === null
      ? allSessions
      : allSessions.filter((session) => session.workoutStartAt >= reuse.dirtyFromAt);
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
    for (const [index, session] of sessions.entries()) {
      this.throwIfCancelled(jobId);
      const featureId = deterministicId("workout_feature", {
        featureRunId: featureRun.id,
        trainingSessionId: session.trainingSessionId
      });
      const feature = extractWorkoutFeatureVector(
        featureId,
        featureRun.id,
        this.buildFeatureSource(session),
        request.featureConfig,
        request.evaluatedAt
      );
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
        JSON.stringify(feature.signals),
        JSON.stringify(feature.provenance),
        feature.computedAt
      );
      features.push(feature);
      this.updateJobProgress(jobId, "feature_extraction", index + 1, sessions.length, "Feature extracted");
    }
    this.database.prepare(`
      UPDATE feature_runs SET reused_feature_count = ?, recomputed_feature_count = ? WHERE id = ?
    `).run(reuse?.count ?? 0, features.length, featureRun.id);
    return reuse === null ? features : this.loadFeatureRunVectors(featureRun.id);
  }

  private reuseFeaturePrefix(
    featureRun: FeatureRun,
    request: RecomputeRequest
  ): { count: number; dirtyFromAt: string } | null {
    const dirtyFromAt = request.incrementalPlan?.dirtyFromAt;
    if (!dirtyFromAt) return null;
    const parent = this.database.prepare(`
      SELECT feature.id, feature.feature_config_hash AS configHash,
             feature.feature_schema_version AS schemaVersion,
             feature.canonical_contract_version AS contractVersion
      FROM active_model_run active
      JOIN model_runs model ON model.id = active.model_run_id AND model.status = 'succeeded'
      JOIN feature_runs feature ON feature.id = model.feature_run_id AND feature.status = 'succeeded'
      WHERE active.singleton = 1
    `).get() as unknown as { id: string; configHash: string; schemaVersion: string; contractVersion: string } | undefined;
    const contract = this.manifestValue("parser_contract_version") ?? CONTRACT_VERSION;
    if (!parent || parent.configHash !== configHash(request.featureConfig) ||
        parent.schemaVersion !== FEATURE_SCHEMA_VERSION || parent.contractVersion !== contract) return null;

    const rows = this.database.prepare(`
      SELECT * FROM workout_features WHERE feature_run_id = ? AND workout_start_at < ? ORDER BY workout_start_at, id
    `).all(parent.id, dirtyFromAt) as unknown as Array<Record<string, unknown>>;
    const insert = this.database.prepare(`
      INSERT INTO workout_features (
        id, feature_run_id, training_session_id, canonical_workout_id, workout_start_at,
        duration_seconds, distance_km, average_speed_mps, average_heart_rate_bpm,
        heart_rate_sample_count, heart_rate_coverage, route_point_count, route_quality,
        source_confidence, session_type, session_type_source, eligibility_status, quality_score,
        missing_reasons_json, features_json, provenance_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        deterministicId("workout_feature", { featureRunId: featureRun.id, trainingSessionId: row.training_session_id }),
        featureRun.id, row.training_session_id as SQLInputValue, row.canonical_workout_id as SQLInputValue,
        row.workout_start_at as SQLInputValue, row.duration_seconds as SQLInputValue, row.distance_km as SQLInputValue,
        row.average_speed_mps as SQLInputValue, row.average_heart_rate_bpm as SQLInputValue,
        row.heart_rate_sample_count as SQLInputValue, row.heart_rate_coverage as SQLInputValue,
        row.route_point_count as SQLInputValue, row.route_quality as SQLInputValue, row.source_confidence as SQLInputValue,
        row.session_type as SQLInputValue, row.session_type_source as SQLInputValue, row.eligibility_status as SQLInputValue,
        row.quality_score as SQLInputValue, row.missing_reasons_json as SQLInputValue,
        row.features_json as SQLInputValue, row.provenance_json as SQLInputValue, row.computed_at as SQLInputValue
      );
    }
    this.database.prepare("UPDATE feature_runs SET parent_feature_run_id = ? WHERE id = ?").run(parent.id, featureRun.id);
    return { count: rows.length, dirtyFromAt };
  }

  private loadFeatureRunVectors(featureRunId: string): WorkoutFeatureVector[] {
    const rows = this.database.prepare(`
      SELECT * FROM workout_features WHERE feature_run_id = ? ORDER BY workout_start_at, id
    `).all(featureRunId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
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

  private metricSamplesForSession(
    session: SessionRow,
    type: string,
    converter: (value: number) => number
  ): TimedMetricSample[] {
    const intervals = weightedRecordIntervals(
      this.loadRecordSeries(session.sourceName, session.workoutStartAt, session.workoutEndAt, type),
      session.workoutStartAt,
      session.workoutEndAt,
      converter
    );
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
      const values = perSecond.slice(Math.max(0, second - 29), second + 1).filter(finiteNumber);
      const value = median(values);
      if (value === null) continue;
      smoothed.push({ value, durationSeconds: 1, startOffsetSeconds: second, distanceMeters: value });
    }
    return smoothed.length >= 30 ? smoothed : [];
  }

  private loadRestingHeartRateEvidence(evaluatedAt: string): RestingHeartRateEvidence[] {
    return (this.database.prepare(`
      SELECT value_numeric AS valueBpm, start_at AS observedAt
      FROM health_records
      WHERE type = ? AND value_numeric IS NOT NULL AND start_at < ?
      ORDER BY start_at
    `).all(restingHeartRateType, evaluatedAt) as unknown as RestingHeartRateEvidence[]);
  }

  private loadDateOfBirth(): string | null {
    const row = this.database.prepare("SELECT attributes_json AS attributesJson FROM profile WHERE id = 1")
      .get() as unknown as { attributesJson: string } | undefined;
    const attributes = parseJson<Record<string, unknown>>(row?.attributesJson, {});
    const value = attributes.HKCharacteristicTypeIdentifierDateOfBirth;
    return typeof value === "string" ? value.slice(0, 10) : null;
  }

  private loadZoneProfileSettings(): TrainingZoneProfileSettings[] {
    const rows = this.database.prepare(`
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
    const profiles = new Map<string, DailyZoneProfile>();
    if (features.length === 0) return profiles;
    const restingEvidence = this.loadRestingHeartRateEvidence(request.evaluatedAt);
    const maximumEvidence: MaximumHeartRateEvidence[] = [];
    for (const feature of features) {
      if ((feature.heartRateCoverage ?? 0) < 0.7 || feature.sourceConfidence < 0.6) continue;
      const session = sessions.get(feature.trainingSessionId);
      if (!session) continue;
      const intervals = weightedRecordIntervals(
        this.loadRecordSeries(session.sourceName, session.workoutStartAt, session.workoutEndAt, heartRateType),
        session.workoutStartAt,
        session.workoutEndAt,
        (value) => value
      );
      const peak = sustainedThirtySecondPeak(intervals, session.workoutStartAt, session.workoutEndAt);
      if (peak !== null) maximumEvidence.push({
        peakBpm: peak,
        observedAt: feature.workoutStartAt,
        coverage: feature.heartRateCoverage ?? 0,
        sourceConfidence: feature.sourceConfidence
      });
    }
    const directVo2 = loadDirectVo2Evidence(this.database, request.evaluatedAt);
    const labeledPerformance = loadLabeledPerformanceEvidence(this.database, request.evaluatedAt);
    const performanceEvidence = loadPerformanceVdotEvidence(this.database, request.evaluatedAt);
    const thresholdEvidence = loadLactateThresholdEvidence(this.database, request.evaluatedAt);
    const settings = this.loadZoneProfileSettings();
    const firstDate = features
      .map((feature) => localDateAt(feature.workoutStartAt, request.timezoneIdentifier))
      .sort()[0]!;
    const throughDate = localDateAt(request.evaluatedAt, request.timezoneIdentifier);
    const dateOfBirth = this.loadDateOfBirth();
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO daily_zone_profiles (
        id, training_metric_run_id, local_date, timezone_identifier, effective_at,
        data_through_at, resting_heart_rate_bpm, maximum_heart_rate_bpm,
        threshold_pace_seconds_per_km, heart_rate_source, pace_source,
        heart_rate_confidence, pace_confidence, profile_status,
        heart_rate_bands_json, pace_bands_json, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let previous: DailyZoneProfile | null = null;
    for (let date = firstDate; date <= throughDate; date = addDays(date, 1)) {
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
      const eligibleVo2 = [...directVo2, ...labeledPerformance].filter((item) => item.observedAt < effectiveAt);
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
      insert.run(
        profile.id, metricRunId, profile.localDate, profile.timezoneIdentifier,
        profile.effectiveAt, profile.dataThroughAt, profile.restingHeartRateBpm,
        profile.maximumHeartRateBpm, profile.lactateThresholdPaceSecondsPerKm,
        profile.heartRateSource, profile.paceSource, profile.heartRateConfidence,
        profile.paceConfidence, profile.status, JSON.stringify(profile.heartRateBands),
        JSON.stringify(profile.paceBands), JSON.stringify(profile.evidence), profile.createdAt
      );
      profiles.set(date, profile);
      previous = profile;
    }
    return profiles;
  }

  private heartRateSamplesForSession(session: SessionRow): HeartRateSample[] {
    const rows = this.loadRecordSeries(
      session.sourceName,
      session.workoutStartAt,
      session.workoutEndAt,
      heartRateType
    );
    return weightedRecordIntervals(
      rows,
      session.workoutStartAt,
      session.workoutEndAt,
      (value) => value
    ).map((interval) => ({
      heartRate: interval.value,
      durationSeconds: interval.durationSeconds
    }));
  }

  private replayTrainingMetrics(
    jobId: string,
    metricRunId: string,
    features: WorkoutFeatureVector[],
    request: RecomputeRequest
  ): void {
    const sessions = new Map(this.loadSessions().map((session) => [session.trainingSessionId, session]));
    const zoneProfiles = this.buildAndPersistZoneProfiles(metricRunId, features, sessions, request);
    const insert = this.database.prepare(`
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
    const insertZoneSummary = this.database.prepare(`
      INSERT INTO workout_zone_summaries (
        id, training_metric_run_id, training_session_id, feature_id, zone_profile_id,
        stimulus_type, secondary_stimulus_types_json, stimulus_confidence,
        heart_rate_coverage, pace_coverage, heart_rate_exposure_json,
        pace_exposure_json, stimulus_scores_json, explanation_codes_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const loads: WorkoutTrainingLoad[] = [];
    const priorDistances: Array<{ observedAt: string; distanceMeters: number }> = [];
    for (const [index, feature] of features.entries()) {
      this.throwIfCancelled(jobId);
      const session = sessions.get(feature.trainingSessionId);
      const override = this.loadOverride(feature.trainingSessionId);
      const implausibleStatistics = feature.missingReasons.includes("implausible_average_pace") &&
        override?.statisticsParticipation !== "include";
      const excluded = session?.trainingSessionStatus !== "active" ||
        override?.statisticsParticipation === "exclude" || implausibleStatistics;
      const localDate = localDateAt(feature.workoutStartAt, request.timezoneIdentifier);
      const zoneProfile = zoneProfiles.get(localDate);
      if (!zoneProfile) throw new Error(`Missing zone profile for ${localDate}`);
      const heartMetricSamples = session
        ? this.metricSamplesForSession(session, heartRateType, (value) => value)
        : [];
      const speedSamples = session
        ? this.metricSamplesForSession(session, runningSpeedType, (value) => convertSpeedToMetersPerSecond(value, "km/hr"))
        : [];
      const distanceMeters = feature.distanceKm === null ? null : feature.distanceKm * 1000;
      const averagePaceSecondsPerKm = feature.distanceKm !== null && feature.distanceKm > 0
        ? feature.durationSeconds / feature.distanceKm
        : null;
      const zoneSummary = analyzeWorkoutZones({
        trainingSessionId: feature.trainingSessionId,
        durationSeconds: feature.durationSeconds,
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
        distanceMeters,
        profile: zoneProfile,
        zoneSummary,
        heartRateSamples: heartMetricSamples,
        speedSamples,
        averageHeartRateBpm: feature.averageHeartRateBpm,
        averagePaceSecondsPerKm,
        distanceReferenceMeters,
        rpe: override?.rpe ?? null,
        sessionType: feature.sessionType
      });
      const load = calculateWorkoutTrainingLoad({
        trainingSessionId: feature.trainingSessionId,
        localDate,
        durationSeconds: feature.durationSeconds,
        distanceMeters,
        heartRateSamples: heartMetricSamples.map((sample) => ({ heartRate: sample.value, durationSeconds: sample.durationSeconds })),
        ...(feature.heartRateCoverage === null ? {} : { heartRateCoverage: feature.heartRateCoverage }),
        averageHeartRate: feature.averageHeartRateBpm,
        restingHeartRate: zoneProfile.restingHeartRateBpm,
        observedMaxHeartRate: zoneProfile.maximumHeartRateBpm,
        rpe: override?.rpe ?? null,
        sessionType: feature.sessionType,
        elevationGainMeters: session ? this.loadElevationGain(session.canonicalWorkoutId) : null,
        sourceConfidence: feature.sourceConfidence,
        excluded,
        zoneSummary,
        loadBreakdown: breakdown
      });
      if (load) {
        insertZoneSummary.run(
          deterministicId("workout_zone_summary", { metricRunId, trainingSessionId: feature.trainingSessionId }),
          metricRunId, feature.trainingSessionId, feature.id, zoneProfile.id,
          zoneSummary.stimulusType, JSON.stringify(zoneSummary.secondaryStimulusTypes),
          zoneSummary.stimulusConfidence, zoneSummary.heartRateCoverage, zoneSummary.paceCoverage,
          JSON.stringify(zoneSummary.heartRateExposure), JSON.stringify(zoneSummary.paceExposure),
          JSON.stringify(zoneSummary.stimulusScores), JSON.stringify(zoneSummary.explanationCodes),
          request.evaluatedAt
        );
        insert.run(
          deterministicId("workout_training_load", {
            trainingMetricRunId: metricRunId,
            trainingSessionId: feature.trainingSessionId
          }),
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
        );
        loads.push(load);
      }
      if (!excluded && distanceMeters !== null && distanceMeters > 0) {
        priorDistances.push({ observedAt: feature.workoutStartAt, distanceMeters });
      }
      this.updateJobProgress(jobId, "training_metrics", index + 1, features.length, "Training load calculated");
    }
    const throughDate = localDateAt(request.evaluatedAt, request.timezoneIdentifier);
    const recovery = features
      .filter((feature) => feature.signals.recoveryRaw !== null)
      .map((feature) => ({
        localDate: localDateAt(feature.workoutStartAt, request.timezoneIdentifier),
        value: feature.signals.recoveryRaw!
      }));
    const daily = buildDailyTrainingMetrics(loads, throughDate, recovery);
    this.persistDailyTrainingMetrics(metricRunId, daily, request, false);
  }

  private persistDailyTrainingMetrics(
    metricRunId: string,
    metrics: DailyTrainingMetric[],
    request: RecomputeRequest,
    ignoreExisting: boolean
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
    for (const [index, metric] of metrics.entries()) {
      cumulativeWorkoutCount += metric.workoutCount;
      insert.run(
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
        cumulativeWorkoutCount,
        metric.trainingStatus,
        metric.loadConfidence,
        JSON.stringify(metric.statusExplanations.map((explanation) => explanation.code)),
        JSON.stringify(metric.statusExplanations),
        request.evaluatedAt
      );
    }
  }

  private loadPersistedTrainingLoads(metricRunId: string): WorkoutTrainingLoad[] {
    const rows = this.database.prepare(`
      SELECT * FROM workout_training_loads
      WHERE training_metric_run_id = ? ORDER BY local_date, training_session_id
    `).all(metricRunId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      trainingSessionId: String(row.training_session_id),
      localDate: String(row.local_date),
      distanceMeters: row.distance_km === null ? null : Number(row.distance_km) * 1000,
      durationSeconds: Number(row.duration_seconds),
      load: Number(row.training_load),
      intensity: Number(row.intensity),
      source: String(row.load_source) as WorkoutTrainingLoad["source"],
      confidence: Number(row.confidence),
      rpe: row.rpe === null ? null : Number(row.rpe),
      sessionType: String(row.session_type) as SessionType,
      averageHeartRate: row.average_heart_rate_bpm === null ? null : Number(row.average_heart_rate_bpm),
      elevationGainMeters: row.elevation_gain_meters === null ? null : Number(row.elevation_gain_meters),
      stimulusType: String(row.stimulus_type ?? "unclassified") as WorkoutTrainingLoad["stimulusType"],
      breakdown: {
        rawHrrTrimp: asNullableNumber(row.raw_hrr_trimp),
        internalLoad: asNullableNumber(row.internal_load),
        paceLoad: asNullableNumber(row.pace_load),
        distanceReferenceMeters: asNullableNumber(row.distance_reference_meters),
        distanceExposureRatio: asNullableNumber(row.distance_exposure_ratio),
        distanceFactor: Number(row.distance_factor ?? 1),
        compositeLoad: Number(row.training_load),
        heartRateConfidence: Number(row.heart_rate_load_confidence ?? 0),
        paceConfidence: Number(row.pace_load_confidence ?? 0)
      },
      explanations: parseJson<{ explanations: WorkoutTrainingLoad["explanations"] }>(
        String(row.provenance_json),
        { explanations: [] }
      ).explanations
    }));
  }

  private loadRecoveryEvidence(modelRunId: string, timezoneIdentifier: string): RecoveryEvidence[] {
    const rows = this.database.prepare(`
      SELECT feature.workout_start_at AS workoutStartAt, feature.features_json AS featuresJson
      FROM model_runs model
      JOIN workout_features feature ON feature.feature_run_id = model.feature_run_id
      WHERE model.id = ? ORDER BY feature.workout_start_at
    `).all(modelRunId) as unknown as Array<{ workoutStartAt: string; featuresJson: string }>;
    return rows.flatMap((row) => {
      const signals = parseJson<Record<string, unknown>>(row.featuresJson, {});
      const value = asNullableNumber(signals.recoveryRaw);
      return value === null ? [] : [{ localDate: localDateAt(row.workoutStartAt, timezoneIdentifier), value }];
    });
  }

  private resumeModelReplay(
    modelRun: ModelRun,
    request: RecomputeRequest,
    features: WorkoutFeatureVector[],
    baseline: PersonalBaseline
  ): ReplayResume | null {
    const dirtyFromAt = request.incrementalPlan?.dirtyFromAt;
    if (!dirtyFromAt || dirtyFromAt <= baseline.calibrationEndAt) return null;
    const expectedModelHash = configHash({ version: MODEL_CONFIG_VERSION, config: request.modelConfig });
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
    const state = parseJson<ModelCheckpointState | null>(row.stateJson, null);
    if (!state?.baseline || !Number.isFinite(state.trueAbility) || !Number.isFinite(state.eligibleWorkoutCount)) {
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
    const sorted = [...features].sort((left, right) =>
      left.workoutStartAt.localeCompare(right.workoutStartAt)
    );
    const calibrationFeatures: WorkoutFeatureVector[] = [];
    for (const feature of sorted) {
      if (feature.eligibilityStatus !== "eligible") continue;
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
    let lastCheckpointMonth: string | null = resume
      ? localDateAt(sorted[resume.throughSequence]?.workoutStartAt ?? "", request.timezoneIdentifier).slice(0, 7)
      : null;

    for (const [index, feature] of sorted.entries()) {
      if (resume && index <= resume.throughSequence) continue;
      this.throwIfCancelled(jobId);
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
        const score = scoreFeature(feature, baseline, 1, request.modelConfig);
        const update = updateTrueAbilityFromFeatureScore(
          trueAbility,
          eligibleWorkoutCount,
          score,
          request.modelConfig
        );
        const explanationCodes = [...score.explanationCodes];
        if (score.currentAbility !== null && score.currentAbility < trueAbility && update.directionFactor === 0.25) {
          explanationCodes.push("fatigue_protected_negative_update");
        }
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
            baselineCalibrationEndAt: baseline.calibrationEndAt
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

      this.insertAssessment(insert, assessment);
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
            eligibleWorkoutCount
          });
        }
        lastCheckpointMonth = month;
      }
      this.updateJobProgress(jobId, "model_replay", index + 1, sorted.length, "Assessment replayed");
    }

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

    for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
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
      insert.run(
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
      );
      snapshots.push(snapshot);
    }
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
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const model = this.database
        .prepare("SELECT status FROM model_runs WHERE id = ?")
        .get(modelRunId) as unknown as { status: string } | undefined;
      if (model?.status !== "succeeded") {
        throw new Error("Only succeeded model runs can become active");
      }
      const metricRun = this.database
        .prepare("SELECT status FROM training_metric_runs WHERE model_run_id = ?")
        .get(modelRunId) as unknown as { status: string } | undefined;
      if (metricRun?.status !== "succeeded") {
        throw new Error("Model run requires a succeeded training metric run before activation");
      }
      this.database
        .prepare(`
          INSERT INTO active_model_run (singleton, model_run_id, activated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            model_run_id = excluded.model_run_id,
            activated_at = excluded.activated_at
        `)
        .run(modelRunId, appNow());
      const completedAt = appNow();
      this.database
        .prepare(`
          UPDATE recompute_jobs
          SET status = 'succeeded', completed_at = ?, progress_phase = 'completed',
              progress_current = ?, progress_total = ?
          WHERE id = ?
        `)
        .run(completedAt, featureCount, featureCount, jobId);
      this.database
        .prepare(`
          INSERT INTO recompute_job_events (
            id, job_id, phase, progress_current, progress_total, message
          ) VALUES (?, ?, 'completed', ?, ?, 'Model run activated')
        `)
        .run(opaqueId("recompute_job_event"), jobId, featureCount, featureCount);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private throwIfCancelled(jobId: string): void {
    const row = this.database
      .prepare("SELECT cancel_requested AS cancelRequested FROM recompute_jobs WHERE id = ?")
      .get(jobId) as unknown as { cancelRequested: number } | undefined;
    if (row?.cancelRequested === 1) {
      this.database
        .prepare("UPDATE recompute_jobs SET status = 'cancelled', completed_at = ? WHERE id = ?")
        .run(appNow(), jobId);
      throw new Error("Task cancellation requested");
    }
  }

  private setJobRunIds(jobId: string, featureRunId: string | null, modelRunId: string | null): void {
    this.database
      .prepare(`
        UPDATE recompute_jobs
        SET feature_run_id = COALESCE(?, feature_run_id),
            model_run_id = COALESCE(?, model_run_id)
        WHERE id = ?
      `)
      .run(featureRunId, modelRunId, jobId);
  }

  private updateJobProgress(
    jobId: string,
    phase: string,
    current: number,
    total: number,
    message: string
  ): void {
    this.database
      .prepare(`
        UPDATE recompute_jobs
        SET progress_phase = ?, progress_current = ?, progress_total = ?
        WHERE id = ?
      `)
      .run(phase, current, total, jobId);
    this.logJobEvent(jobId, phase, current, total, message);
  }

  private logJobEvent(
    jobId: string,
    phase: string,
    current: number,
    total: number,
    message: string
  ): void {
    this.database
      .prepare(`
        INSERT INTO recompute_job_events (
          id, job_id, phase, progress_current, progress_total, message
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(opaqueId("recompute_job_event"), jobId, phase, current, total, message);
  }

  private completeJob(
    jobId: string,
    phase: string,
    current: number,
    total: number,
    message: string
  ): void {
    this.database
      .prepare(`
        UPDATE recompute_jobs
        SET status = 'succeeded', completed_at = ?, progress_phase = ?,
            progress_current = ?, progress_total = ?
        WHERE id = ?
      `)
      .run(appNow(), phase, current, total, jobId);
    this.logJobEvent(jobId, phase, current, total, message);
  }

  private failJob(jobId: string, error: unknown): void {
    const current = this.getJob(jobId);
    if (current?.status === "cancelled") {
      this.logJobEvent(jobId, "cancelled", current.progressCurrent, current.progressTotal, "Task cancelled");
      return;
    }
    this.database
      .prepare(`
        UPDATE recompute_jobs
        SET status = 'failed', completed_at = ?, error_json = ?
        WHERE id = ?
      `)
      .run(appNow(), JSON.stringify(this.errorPayload(error)), jobId);
    this.logJobEvent(jobId, "failed", 0, 0, "Task failed");
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
