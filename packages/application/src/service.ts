import { DATABASE_TIMEZONE } from "@rai/contracts";
import type { DatabaseSync } from "node:sqlite";

import type {
  RecomputeJob,
  RecomputeJobType,
  TrainingZoneProfileSettings,
  UpdateTrainingZoneProfileInput
} from "@rai/contracts";
import type { RecomputePlan } from "@rai/health-export-parser";
import {
  RaiDatabase,
  SqliteModelRunRepository,
  RecomputeJobRepository,
  SqliteTrainingSessionRepository,
  type JobCancellationResult
} from "@rai/storage-sqlite";

import { appNow, opaqueId } from "./utils.js";
import {
  WorkoutNotFoundError,
  WorkoutOverrideRevisionConflictError,
  TrainingZoneProfileValidationError,
  TrainingZoneProfileRevisionConflictError,
  type AppendWorkoutOverrideInput,
  type AppendWorkoutOverrideResult,
  type RecomputeOptions,
  type RecomputeRequest
} from "./service-types.js";
import { defaultRequest, finiteNumber, normalizeInstant } from "./recompute-helpers.js";
import { RecomputePipeline } from "./services/recompute-pipeline.js";
import { addDays, localDateAt } from "./utils.js";

export {
  WorkoutNotFoundError,
  WorkoutOverrideRevisionConflictError,
  TrainingZoneProfileValidationError,
  TrainingZoneProfileRevisionConflictError,
  type AppendWorkoutOverrideInput,
  type AppendWorkoutOverrideResult,
  type RecomputeOptions
} from "./service-types.js";

/**
 * Application facade: job enqueue, user mutations, and recompute orchestration.
 * Heavy recompute work lives in {@link RecomputePipeline}.
 */
export class RaiApplicationService {
  private readonly jobs: RecomputeJobRepository;
  private readonly modelRuns: SqliteModelRunRepository;
  private readonly sessions: SqliteTrainingSessionRepository;
  private readonly pipeline: RecomputePipeline;

  constructor(private readonly store: RaiDatabase, private readonly transactionMode: "owned" | "savepoint" = "owned", elevationGains?: ReadonlyMap<string, number | null>) {
    this.jobs = new RecomputeJobRepository(store.database);
    this.modelRuns = new SqliteModelRunRepository(store.database);
    this.sessions = new SqliteTrainingSessionRepository(store.database);
    this.pipeline = new RecomputePipeline(store, this.jobs, this.modelRuns, this.sessions, elevationGains);
  }

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
      ...(plan.mode === "partial" && plan.dirtyFromAt !== null
        ? { incrementalPlan: { ...plan, dirtyFromAt: normalizeInstant(plan.dirtyFromAt, "dirtyFromAt") } }
        : {})
    });
  }

  enqueueSnapshotRefresh(options: Pick<RecomputeOptions, "evaluatedAt" | "timezoneIdentifier"> = {}): string {
    return this.enqueueJob("snapshot_refresh", defaultRequest(options));
  }

  recoverInterruptedJobs(): number {
    return this.jobs.recoverInterrupted();
  }

  appendTrainingZoneProfileSettings(
    input: UpdateTrainingZoneProfileInput,
    timezoneIdentifier: string = DATABASE_TIMEZONE
  ): TrainingZoneProfileSettings {
    const validateManual = (mode: "auto" | "manual", value: number | null, low: number, high: number, name: string): void => {
      if (mode === "manual") {
        if (!finiteNumber(value) || value < low || value > high) {
          throw new TrainingZoneProfileValidationError(`${name} manual value must be between ${low} and ${high}`);
        }
      }
      if (mode === "auto" && value !== null) {
        throw new TrainingZoneProfileValidationError(`${name} automatic mode must not include a value`);
      }
    };
    validateManual(input.restingHeartRate.mode, input.restingHeartRate.valueBpm, 35, 110, "Resting heart rate");
    validateManual(input.maximumHeartRate.mode, input.maximumHeartRate.valueBpm, 120, 230, "Maximum heart rate");
    validateManual(input.lactateThresholdPace.mode, input.lactateThresholdPace.valueSecondsPerKm, 150, 900, "Threshold pace");
    if (
      input.restingHeartRate.mode === "manual" && input.maximumHeartRate.mode === "manual" &&
      input.restingHeartRate.valueBpm !== null && input.maximumHeartRate.valueBpm !== null &&
      input.maximumHeartRate.valueBpm - input.restingHeartRate.valueBpm < 30
    ) throw new TrainingZoneProfileValidationError("Maximum heart rate must be at least 30 bpm above resting heart rate");
    this.database.exec(this.transactionMode === "owned" ? "BEGIN IMMEDIATE" : "SAVEPOINT rai_app_mutation");
    try {
      const row = this.database.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM training_zone_profile_settings")
        .get() as unknown as { revision: number };
      if (Number(row.revision) !== input.expectedRevision) {
        throw new TrainingZoneProfileRevisionConflictError();
      }
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
      this.database.exec(this.transactionMode === "owned" ? "COMMIT" : "RELEASE rai_app_mutation");
      return {
        revision,
        effectiveFromLocalDate,
        restingHeartRate: input.restingHeartRate,
        maximumHeartRate: input.maximumHeartRate,
        lactateThresholdPace: input.lactateThresholdPace,
        createdAt
      };
    } catch (error) {
      this.database.exec(this.transactionMode === "owned" ? "ROLLBACK" : "ROLLBACK TO rai_app_mutation; RELEASE rai_app_mutation");
      throw error;
    }
  }

  appendWorkoutOverride(input: AppendWorkoutOverrideInput): AppendWorkoutOverrideResult {
    if (input.rpe !== null && (!Number.isInteger(input.rpe) || input.rpe < 1 || input.rpe > 10)) {
      throw new Error("RPE must be an integer from 1 through 10");
    }
    this.database.exec(this.transactionMode === "owned" ? "BEGIN IMMEDIATE" : "SAVEPOINT rai_app_mutation");
    try {
      if (!this.sessions.exists(input.trainingSessionId)) {
        throw new WorkoutNotFoundError(input.trainingSessionId);
      }

      const revisionRow = this.database
        .prepare(
          "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM workout_overrides WHERE training_session_id = ?"
        )
        .get(input.trainingSessionId) as unknown as { revision: number };
      if (input.expectedRevision !== undefined && input.expectedRevision !== Number(revisionRow.revision) - 1) {
        throw new WorkoutOverrideRevisionConflictError();
      }
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
      const jobId = this.enqueueFullRecompute();
      this.database.exec(this.transactionMode === "owned" ? "COMMIT" : "RELEASE rai_app_mutation");
      return { overrideId, jobId };
    } catch (error) {
      this.database.exec(this.transactionMode === "owned" ? "ROLLBACK" : "ROLLBACK TO rai_app_mutation; RELEASE rai_app_mutation");
      throw error;
    }
  }

  requestJobCancellation(jobId: string): JobCancellationResult {
    return this.jobs.requestCancellation(jobId);
  }

  runNextJob(): RecomputeJob | null {
    const job = this.jobs.claimNext();
    if (!job) return null;

    try {
      if (job.jobType === "full_recompute") {
        this.pipeline.runFullRecompute(job);
      } else if (job.jobType === "snapshot_refresh") {
        this.pipeline.runSnapshotRefresh(job);
      } else {
        throw new Error(`Unsupported application job type: ${job.jobType}`);
      }
      return this.jobs.get(job.id);
    } catch (error) {
      this.jobs.fail(job.id, error);
      return this.jobs.get(job.id);
    }
  }

  private enqueueJob(jobType: RecomputeJobType, request: RecomputeRequest): string {
    const row = this.database.prepare("SELECT value FROM import_manifest WHERE key = ?")
      .get("dataset_version") as { value: string } | undefined;
    return this.jobs.enqueue(jobType, row?.value ?? null, request);
  }
}
