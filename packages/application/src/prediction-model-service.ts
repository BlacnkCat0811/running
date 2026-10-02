import { SqliteCalibrationRepository } from "@rai/storage-sqlite";
import { catBoostCalibrationKey } from "./prediction-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  CATBOOST_PREDICTION_MODEL_VERSION,
  PREDICTION_CORRECTION_CAP_FRACTION,
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
  type PredictionModelEvent,
  type PredictionModelEvaluationMetrics,
  type PredictionModelRun,
  type PredictionModelScope,
  type PredictionModelTrainingRequest,
  type PredictionModelTrainingResult,
  type RaceDistance
} from "@rai/contracts";
import type { DatabaseSync } from "node:sqlite";

import {
  buildRaceResidualTrainingDataset,
  raceResidualFeatureSchemaHash
} from "./prediction-training-data.js";
import { currentAbilityBaselineHash } from "./prediction-ability-baseline.js";

export { currentAbilityBaselineHash } from "./prediction-ability-baseline.js";

const distances: RaceDistance[] = ["five_k", "ten_k", "half_marathon"];

function sanitizeClientFacingError(message: string): string {
  const withoutPaths = message
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .replace(/\/(?:Users|home|var|tmp|private)[^\s"']*/g, "[path]")
    .replace(/\\/g, "/");
  if (withoutPaths.length > 240) return `${withoutPaths.slice(0, 240)}…`;
  return withoutPaths || "预测训练失败";
}

export const MINIMUM_PREDICTION_LABELS = 50;
export const MINIMUM_LABELS_PER_DISTANCE = 8;
export const MINIMUM_ARTIFACT_TRAINING_LABELS = 24;
export const MINIMUM_ARTIFACT_TRAINING_LABELS_PER_DISTANCE = 4;
export const MINIMUM_HOLDOUT_PREDICTIONS = 24;
export const MINIMUM_HOLDOUTS_PER_DISTANCE = 6;
export const MINIMUM_WALK_FORWARD_PREDICTIONS = 12;
export const MINIMUM_WALK_FORWARD_PER_DISTANCE = 3;
/**
 * Personal scope's floors **are** the artifact's own floors.
 *
 * Deliberately not a new pair of numbers: a personal model is trained on one runner,
 * and what it needs is exactly what the artifact contract already requires before it
 * can be fitted at all (24 labels, 4 per distance). Inventing separate constants would
 * be a second place for "how much is enough" to drift.
 */
export const PERSONAL_MINIMUM_LABELS = MINIMUM_ARTIFACT_TRAINING_LABELS;
export const PERSONAL_MINIMUM_LABELS_PER_DISTANCE = MINIMUM_ARTIFACT_TRAINING_LABELS_PER_DISTANCE;

export interface PredictionScopeFloors {
  scope: PredictionModelScope;
  requiredLabels: number;
  requiredLabelsPerDistance: number;
}

export function predictionScopeFloors(scope: PredictionModelScope): PredictionScopeFloors {
  return scope === "personal"
    ? {
        scope,
        requiredLabels: PERSONAL_MINIMUM_LABELS,
        requiredLabelsPerDistance: PERSONAL_MINIMUM_LABELS_PER_DISTANCE
      }
    : {
        scope,
        requiredLabels: MINIMUM_PREDICTION_LABELS,
        requiredLabelsPerDistance: MINIMUM_LABELS_PER_DISTANCE
      };
}

export const MINIMUM_MAE_IMPROVEMENT = 0.05;
export const MAXIMUM_DISTANCE_MAE_REGRESSION = 0.05;
export const MAXIMUM_INTERVAL_COVERAGE_DROP = 0.05;
export const ONNX_PARITY_TOLERANCE = 1e-6;
export { PREDICTION_CORRECTION_CAP_FRACTION } from "@rai/contracts";
export const WALK_FORWARD_INITIAL_TRAINING_SIZE = 12;
export const RELEASE_HOLDOUT_EMBARGO_HOURS = 24;
export const RELEASE_BOOTSTRAP_ITERATIONS = 2000;
export const RELEASE_BOOTSTRAP_BLOCK_EVENTS = 3;
export const MINIMUM_RELEASE_BOOTSTRAP_BLOCKS = 6;

export const CATBOOST_V1_HYPERPARAMETERS = {
  loss_function: "RMSE",
  iterations: 300,
  depth: 4,
  learning_rate: 0.03,
  l2_leaf_reg: 10,
  random_seed: 20260711,
  allow_writing_files: false,
  verbose: false,
  thread_count: 1
} as const;

interface PredictionModelRunRow {
  id: string;
  algorithm: "catboost";
  modelVersion: string;
  featureSchemaVersion: string;
  featureSchemaHash: string | null;
  abilityBaselineHash: string | null;
  trainingDataHash: string | null;
  trainingDataThroughAt: string;
  hyperparametersJson: string;
  status: PredictionModelRun["status"];
  labelCount: number;
  labelCountByDistanceJson: string;
  holdoutPredictionCount: number;
  metricsJson: string | null;
  supportedDistancesJson: string;
  artifactPath: string | null;
  artifactSha256: string | null;
  cancelRequested: number;
  failureJson: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  activatedAt: string | null;
  requestJson: string;
  workerToken: string | null;
  heartbeatAt: string | null;
  attemptCount: number;
  active: number;
}

/**
 * Scope of a stored run, read back from `request_json`.
 *
 * A run with no recorded scope predates the field and was trained under the
 * population gate — that is the honest default, not "personal".
 */
function storedScope(requestJson: string): PredictionModelScope {
  try {
    const parsed = JSON.parse(requestJson) as { scope?: unknown };
    return parsed.scope === "personal" ? "personal" : "population";
  } catch {
    return "population";
  }
}

interface PredictionModelEventRow {
  id: string;
  predictionModelRunId: string;
  phase: string;
  progressCurrent: number;
  progressTotal: number;
  message: string;
  createdAt: string;
}

export interface PredictionTrainingPreflight extends PredictionScopeFloors {
  available: number;
  availableByDistance: Record<RaceDistance, number>;
  eligible: boolean;
}

export class PredictionTrainingPreconditionError extends Error {
  readonly code = "insufficient_labeled_outcomes" as const;

  constructor(readonly preflight: PredictionTrainingPreflight) {
    super(
      `CatBoost 训练（${preflight.scope === "personal" ? "个人" : "人群"}范围）至少需要 ` +
      `${preflight.requiredLabels} 个标签，且每个距离至少 ${preflight.requiredLabelsPerDistance} 个；` +
      `当前共有 ${preflight.available} 个`
    );
  }
}

export class PredictionTrainingInProgressError extends Error {
  readonly code = "prediction_training_in_progress" as const;

  constructor(readonly existingRunId: string) {
    super("已有预测模型训练任务正在排队或执行");
  }
}

export class PredictionTrainingInputError extends Error {
  readonly code = "invalid_prediction_training_input" as const;
}

export class PredictionAbilityBaselineUnavailableError extends Error {
  readonly code = "prediction_ability_baseline_unavailable" as const;

  constructor() {
    super("An active ability model is required before prediction model training");
  }
}

export class PredictionModelActivationCompatibilityError extends Error {
  readonly code = "prediction_model_incompatible" as const;

  constructor(
    readonly reasons: Array<
      "model_version_mismatch" |
      "feature_schema_version_mismatch" |
      "feature_schema_hash_mismatch" |
      "ridge_challenger_missing" |
      "ability_baseline_mismatch"
    >
  ) {
    super(`预测模型与当前推理版本不兼容：${reasons.join(", ")}`);
  }
}

export type PredictionCancellationResult = "requested" | "cancelled" | "terminal";

export const PREDICTION_MODEL_LEASE_TIMEOUT_MS = 30_000;
export const MAXIMUM_PREDICTION_TRAINING_ATTEMPTS = 3;

export interface EnqueuePredictionTrainingInput {
  asOf?: string;
  /** Defaults to `population`: an unqualified training request keeps the old gate. */
  scope?: PredictionModelScope;
}

interface PredictionModelStore {
  database: DatabaseSync;
}

export interface PredictionModelTrainer {
  train(
    request: PredictionModelTrainingRequest,
    signal?: AbortSignal
  ): Promise<PredictionModelTrainingResult>;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function emptyDistanceCounts(): Record<RaceDistance, number> {
  return { five_k: 0, ten_k: 0, half_marathon: 0 };
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function predictionTrainingSourceFingerprint(database: DatabaseSync): string {
  const dataVersion = database.prepare("PRAGMA data_version").get() as unknown as {
    data_version: number;
  };
  const row = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM training_sessions) AS sessionCount,
      (SELECT MAX(anchor_end_at) FROM training_sessions) AS latestSessionAt,
      (SELECT COUNT(*) FROM health_records) AS healthRecordCount,
      (SELECT MAX(end_at) FROM health_records) AS latestHealthRecordAt,
      (SELECT COUNT(*) FROM workout_overrides) AS overrideCount,
      (SELECT MAX(created_at || ':' || revision) FROM workout_overrides) AS latestOverride,
      (SELECT model_run_id FROM active_model_run WHERE singleton = 1) AS activeModelRunId
  `).get() as unknown as Record<string, unknown>;
  return JSON.stringify({ dataVersion: dataVersion.data_version, ...row });
}

export class PredictionModelService {
  private readonly artifactRoot: string;

  constructor(
    private readonly store: PredictionModelStore,
    artifactRoot?: string,
    private readonly transactionMode: "owned" | "savepoint" = "owned",
    private readonly clock:()=>string = ()=>new Date().toISOString()
  ) {
    const main = store.database.prepare("PRAGMA database_list").all()
      .find((row) => (row as { name?: unknown }).name === "main") as { file?: unknown } | undefined;
    const databaseDirectory = dirname(String(main?.file ?? resolve("var", "rai.sqlite")));
    const runtimeVar = basename(databaseDirectory).toLowerCase() === "var"
      ? databaseDirectory
      : resolve(databaseDirectory, "var");
    this.artifactRoot = resolve(artifactRoot ?? runtimeVar, artifactRoot ? "" : "model-artifacts/prediction");
  }

  preflight(asOf: string, scope: PredictionModelScope = "population"): PredictionTrainingPreflight {
    if (!isIsoDate(asOf)) {
      throw new PredictionTrainingInputError("asOf 必须是带时区的有效 ISO 8601 时间");
    }
    if (Date.parse(asOf) > Date.now()) {
      throw new PredictionTrainingInputError("asOf must not be in the future");
    }
    const samples = buildRaceResidualTrainingDataset(this.store.database, asOf).samples;
    const availableByDistance = emptyDistanceCounts();
    for (const sample of samples) availableByDistance[sample.distance] += 1;
    const floors = predictionScopeFloors(scope);
    return {
      ...floors,
      available: samples.length,
      availableByDistance,
      eligible:
        samples.length >= floors.requiredLabels &&
        distances.every(
          (distance) => availableByDistance[distance] >= floors.requiredLabelsPerDistance
        )
    };
  }

  enqueue(input: EnqueuePredictionTrainingInput): string {
    const id = `prediction_model_${randomUUID()}`;
    const now = this.clock();
    const asOf = input.asOf ?? now;
    if (!isIsoDate(asOf)) {
      throw new PredictionTrainingInputError("asOf must be a valid timezone-qualified ISO 8601 timestamp");
    }
    const existingBeforePreflight = this.store.database.prepare(`
      SELECT id, training_data_through_at AS trainingDataThroughAt
      FROM prediction_model_runs
      WHERE status IN ('queued', 'running', 'validating')
      ORDER BY created_at, id
      LIMIT 1
    `).get() as unknown as { id: string; trainingDataThroughAt: string } | undefined;
    if (existingBeforePreflight) {
      if (input.asOf === undefined || existingBeforePreflight.trainingDataThroughAt === asOf) {
        return existingBeforePreflight.id;
      }
      throw new PredictionTrainingInProgressError(existingBeforePreflight.id);
    }
    const sourceFingerprint = predictionTrainingSourceFingerprint(this.store.database);
    const scope: PredictionModelScope = input.scope ?? "population";
    const preflight = this.preflight(asOf, scope);
    if (!preflight.eligible) throw new PredictionTrainingPreconditionError(preflight);
    const abilityBaselineHash = currentAbilityBaselineHash(this.store.database);
    if (abilityBaselineHash === null) {
      throw new PredictionAbilityBaselineUnavailableError();
    }
    this.store.database.exec(this.transactionMode === "owned" ? "BEGIN IMMEDIATE" : "SAVEPOINT rai_prediction_mutation");
    try {
      const existing = this.store.database.prepare(`
        SELECT id, training_data_through_at AS trainingDataThroughAt
        FROM prediction_model_runs
        WHERE status IN ('queued', 'running', 'validating')
        ORDER BY created_at, id
        LIMIT 1
      `).get() as unknown as { id: string; trainingDataThroughAt: string } | undefined;
      if (existing) {
        if (input.asOf === undefined || existing.trainingDataThroughAt === asOf) {
          this.store.database.exec(this.transactionMode === "owned" ? "COMMIT" : "RELEASE rai_prediction_mutation");
          return existing.id;
        }
        throw new PredictionTrainingInProgressError(existing.id);
      }
      if (
        predictionTrainingSourceFingerprint(this.store.database) !== sourceFingerprint ||
        currentAbilityBaselineHash(this.store.database) !== abilityBaselineHash
      ) {
        throw new PredictionTrainingInputError(
          "Prediction training data changed during preflight; retry the request"
        );
      }
      this.store.database.prepare(`
        INSERT INTO prediction_model_runs (
          id, algorithm, model_version, feature_schema_version,
          ability_baseline_hash, training_data_through_at,
          hyperparameters_json, request_json, status,
          label_count, label_count_by_distance_json, created_at
        ) VALUES (?, 'catboost', ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(
        id,
        CATBOOST_PREDICTION_MODEL_VERSION,
        PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
        abilityBaselineHash,
        asOf,
        JSON.stringify(CATBOOST_V1_HYPERPARAMETERS),
        JSON.stringify({ asOf, scope }),
        preflight.available,
        JSON.stringify(preflight.availableByDistance),
        now
      );
      this.insertEvent(id, "queued", 0, 5, "CatBoost 训练任务已排队", now);
      this.store.database.exec(this.transactionMode === "owned" ? "COMMIT" : "RELEASE rai_prediction_mutation");
    } catch (error) {
      this.store.database.exec(this.transactionMode === "owned" ? "ROLLBACK" : "ROLLBACK TO rai_prediction_mutation; RELEASE rai_prediction_mutation");
      throw error;
    }
    return id;
  }

  claimNext(workerToken = `worker_${randomUUID()}`): PredictionModelRun | null {
    if (workerToken.length < 8 || workerToken.length > 200) {
      throw new Error("workerToken 长度无效");
    }
    const now = this.clock();
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      const queued = this.store.database.prepare(`
        SELECT id, cancel_requested AS cancelRequested
        FROM prediction_model_runs
        WHERE status = 'queued'
        ORDER BY created_at, id
        LIMIT 1
      `).get() as unknown as { id: string; cancelRequested: number } | undefined;
      if (!queued) {
        this.store.database.exec("COMMIT");
        return null;
      }
      if (queued.cancelRequested === 1) {
        this.store.database.prepare(`
          UPDATE prediction_model_runs
          SET status = 'cancelled', completed_at = ?
          WHERE id = ?
        `).run(now, queued.id);
        this.insertEvent(queued.id, "cancelled", 0, 5, "训练在开始前已取消", now);
        this.store.database.exec("COMMIT");
        return null;
      }
      const claimed = this.store.database.prepare(`
        UPDATE prediction_model_runs
        SET status = 'running', started_at = ?, worker_token = ?, heartbeat_at = ?,
          attempt_count = attempt_count + 1
        WHERE id = ? AND status = 'queued'
      `).run(now, workerToken, now, queued.id);
      if (Number(claimed.changes) !== 1) {
        throw new Error("预测模型任务未能取得执行租约");
      }
      this.insertEvent(queued.id, "dataset", 1, 5, "正在生成防未来数据泄漏的训练数据集", now);
      this.store.database.exec("COMMIT");
      return this.get(queued.id);
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(id: string, workerToken: string): boolean {
    const result = this.store.database.prepare(`
      UPDATE prediction_model_runs
      SET heartbeat_at = ?
      WHERE id = ? AND worker_token = ? AND status IN ('running', 'validating')
    `).run(this.clock(), id, workerToken);
    return Number(result.changes) === 1;
  }

  recoverAbandoned(
    leaseTimeoutMs = PREDICTION_MODEL_LEASE_TIMEOUT_MS,
    now = new Date()
  ): number {
    if (!Number.isFinite(leaseTimeoutMs) || leaseTimeoutMs < 0) {
      throw new Error("leaseTimeoutMs 必须是非负有限数");
    }
    const cutoff = new Date(now.getTime() - leaseTimeoutMs).toISOString();
    return this.recoverLeases(cutoff, now);
  }

  recoverAllLeases(now = new Date()): number {
    return this.recoverLeases(null, now);
  }

  private recoverLeases(cutoff: string | null, now: Date): number {
    const recoveredAt = now.toISOString();
    let recovered = 0;
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      const stale = this.store.database.prepare(`
        SELECT id, cancel_requested AS cancelRequested, attempt_count AS attemptCount
        FROM prediction_model_runs
        WHERE status IN ('running', 'validating')
          AND (? IS NULL OR heartbeat_at IS NULL OR heartbeat_at <= ?)
        ORDER BY created_at, id
      `).all(cutoff, cutoff) as unknown as Array<{
        id: string;
        cancelRequested: number;
        attemptCount: number;
      }>;
      for (const run of stale) {
        if (run.cancelRequested === 1) {
          const changed = this.store.database.prepare(`
            UPDATE prediction_model_runs
            SET status = 'cancelled', completed_at = ?, worker_token = NULL, heartbeat_at = NULL
            WHERE id = ? AND status IN ('running', 'validating')
          `).run(recoveredAt, run.id);
          if (Number(changed.changes) === 1) {
            this.insertEvent(run.id, "cancelled", 0, 5, "worker 退出后完成取消", recoveredAt);
            recovered += 1;
          }
        } else if (run.attemptCount >= MAXIMUM_PREDICTION_TRAINING_ATTEMPTS) {
          const changed = this.store.database.prepare(`
            UPDATE prediction_model_runs
            SET status = 'failed', completed_at = ?, worker_token = NULL, heartbeat_at = NULL,
              failure_json = ?
            WHERE id = ? AND status IN ('running', 'validating')
          `).run(
            recoveredAt,
            JSON.stringify({ code: "worker_lease_exhausted", attempts: run.attemptCount }),
            run.id
          );
          if (Number(changed.changes) === 1) {
            this.insertEvent(run.id, "failed", 0, 5, "worker 多次异常退出，任务已停止重试", recoveredAt);
            recovered += 1;
          }
        } else {
          const changed = this.store.database.prepare(`
            UPDATE prediction_model_runs
            SET status = 'queued', started_at = NULL, worker_token = NULL, heartbeat_at = NULL
            WHERE id = ? AND status IN ('running', 'validating')
          `).run(run.id);
          if (Number(changed.changes) === 1) {
            this.insertEvent(run.id, "recovered", 0, 5, "worker 租约过期，训练任务已重新排队", recoveredAt);
            recovered += 1;
          }
        }
      }
      this.store.database.exec("COMMIT");
      return recovered;
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
  }

  hasInFlight(): boolean {
    return Boolean(this.store.database.prepare(`
      SELECT 1 FROM prediction_model_runs
      WHERE status IN ('queued', 'running', 'validating') LIMIT 1
    `).get());
  }

  recordProgress(
    id: string,
    phase: string,
    progressCurrent: number,
    progressTotal: number,
    message: string
  ): void {
    const row = this.store.database
      .prepare("SELECT status FROM prediction_model_runs WHERE id = ?")
      .get(id) as unknown as { status: string } | undefined;
    if (!row) throw new Error("预测模型运行不存在");
    if (!["running", "validating"].includes(row.status)) {
      throw new Error("只能为运行中的预测模型记录进度");
    }
    this.insertEvent(id, phase, progressCurrent, progressTotal, message);
  }

  isCancellationRequested(id: string): boolean {
    const row = this.store.database.prepare(`
      SELECT cancel_requested AS cancelRequested
      FROM prediction_model_runs WHERE id = ?
    `).get(id) as unknown as { cancelRequested: number } | undefined;
    return row?.cancelRequested === 1;
  }

  requestCancellation(id: string): PredictionCancellationResult {
    const now = this.clock();
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.store.database.prepare(`
        SELECT status FROM prediction_model_runs WHERE id = ?
      `).get(id) as unknown as { status: PredictionModelRun["status"] } | undefined;
      if (!row) throw new Error("预测模型运行不存在");
      if (["succeeded", "rejected", "failed"].includes(row.status)) {
        this.store.database.exec("COMMIT");
        return "terminal";
      }
      if (row.status === "cancelled") {
        this.store.database.exec("COMMIT");
        return "cancelled";
      }
      if (row.status === "queued") {
        const changed = this.store.database.prepare(`
          UPDATE prediction_model_runs
          SET cancel_requested = 1, status = 'cancelled', completed_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(now, id);
        if (Number(changed.changes) === 1) {
          this.insertEvent(id, "cancelled", 0, 5, "训练任务已取消", now);
        }
      } else {
        const changed = this.store.database.prepare(`
          UPDATE prediction_model_runs SET cancel_requested = 1
          WHERE id = ? AND status IN ('running', 'validating') AND cancel_requested = 0
        `).run(id);
        if (Number(changed.changes) === 1) {
          this.insertEvent(id, "cancelling", 0, 5, "已请求取消训练任务", now);
        }
      }
      this.store.database.exec("COMMIT");
      return row.status === "queued" ? "cancelled" : "requested";
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
  }

  markCancelled(id: string, workerToken?: string): void {
    const now = this.clock();
    const changed = this.store.database.prepare(`
      UPDATE prediction_model_runs
      SET status = 'cancelled', cancel_requested = 1, completed_at = ?,
        worker_token = NULL, heartbeat_at = NULL
      WHERE id = ? AND status IN ('running', 'validating')
        AND (? IS NULL OR worker_token = ?)
    `).run(now, id, workerToken ?? null, workerToken ?? null);
    if (Number(changed.changes) === 1) {
      this.insertEvent(id, "cancelled", 0, 5, "训练任务已取消", now);
    }
  }

  releaseLeaseForShutdown(id: string, workerToken: string): void {
    const now = this.clock();
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.store.database.prepare(`
        SELECT cancel_requested AS cancelRequested
        FROM prediction_model_runs
        WHERE id = ? AND worker_token = ? AND status IN ('running', 'validating')
      `).get(id, workerToken) as { cancelRequested: number } | undefined;
      if (!row) {
        this.store.database.exec("COMMIT");
        return;
      }
      if (row.cancelRequested === 1) {
        this.store.database.prepare(`
          UPDATE prediction_model_runs
          SET status = 'cancelled', completed_at = ?, worker_token = NULL, heartbeat_at = NULL
          WHERE id = ? AND worker_token = ? AND status IN ('running', 'validating')
        `).run(now, id, workerToken);
        this.insertEvent(id, "cancelled", 0, 5, "服务关闭时完成取消", now);
      } else {
        this.store.database.prepare(`
          UPDATE prediction_model_runs
          SET status = 'queued', started_at = NULL, worker_token = NULL, heartbeat_at = NULL,
            attempt_count = MAX(0, attempt_count - 1)
          WHERE id = ? AND worker_token = ? AND status IN ('running', 'validating')
        `).run(id, workerToken);
        this.insertEvent(id, "recovered", 0, 5, "服务关闭，训练任务已重新排队", now);
      }
      this.store.database.exec("COMMIT");
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeAndActivate(
    id: string,
    result: PredictionModelTrainingResult,
    workerToken?: string
  ): PredictionModelRun {
    const current = this.get(id);
    if (!current) throw new Error("预测模型运行不存在");
    if (["succeeded", "rejected"].includes(current.status)) return current;
    if (current.status !== "running") throw new Error("预测模型不在可完成状态");
    if (this.isCancellationRequested(id)) {
      this.markCancelled(id, workerToken);
      return this.get(id)!;
    }

    const validatingAt = this.clock();
    const validating = this.store.database.prepare(`
      UPDATE prediction_model_runs SET status = 'validating', heartbeat_at = ?
      WHERE id = ? AND status = 'running' AND cancel_requested = 0
        AND (? IS NULL OR worker_token = ?)
    `).run(validatingAt, id, workerToken ?? null, workerToken ?? null);
    if (Number(validating.changes) !== 1) {
      if (this.isCancellationRequested(id)) {
        this.markCancelled(id, workerToken);
        return this.get(id)!;
      }
      throw new Error("预测模型运行租约已失效");
    }
    this.insertEvent(id, "validation", 4, 5, "正在验证 walk-forward 指标与 ONNX 一致性", validatingAt);

    const rejectionReasons = this.validateTrainingResult(result);
    const now = this.clock();
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.store.database.prepare(`
        SELECT status, cancel_requested AS cancelRequested, worker_token AS workerToken
        FROM prediction_model_runs WHERE id = ?
      `).get(id) as unknown as {
        status: PredictionModelRun["status"];
        cancelRequested: number;
        workerToken: string | null;
      } | undefined;
      if (!latest) throw new Error("预测模型运行不存在");
      if (latest.cancelRequested === 1) {
        this.store.database.prepare(`
          UPDATE prediction_model_runs
          SET status = 'cancelled', completed_at = ?, worker_token = NULL, heartbeat_at = NULL
          WHERE id = ? AND status = 'validating'
        `).run(now, id);
        this.insertEvent(id, "cancelled", 0, 5, "训练任务已取消", now);
        this.store.database.exec("COMMIT");
        return this.get(id)!;
      }
      if (latest.status !== "validating" || (workerToken && latest.workerToken !== workerToken)) {
        throw new Error("预测模型运行租约已失效");
      }
      const activeAbilityBaselineHash = currentAbilityBaselineHash(this.store.database);
      if (
        current.abilityBaselineHash === null ||
        activeAbilityBaselineHash === null ||
        current.abilityBaselineHash !== activeAbilityBaselineHash
      ) {
        rejectionReasons.push("ability_baseline_mismatch");
      }
      // Legacy method name: point-validation success can remain an inactive
      // candidate. All supported distances must have independent calibrated
      // intervals before the publication pointer is changed.
      const accepted = rejectionReasons.length === 0;
      const calibrated = accepted && this.intervalActivationReasons(result.artifactSha256,current.abilityBaselineHash,now).length === 0;
      const updated = this.store.database.prepare(`
        UPDATE prediction_model_runs
        SET feature_schema_hash = ?, training_data_hash = ?, label_count = ?,
          label_count_by_distance_json = ?, holdout_prediction_count = ?,
          metrics_json = ?, supported_distances_json = ?, artifact_path = ?,
          artifact_sha256 = ?, status = ?, failure_json = ?, completed_at = ?,
          activated_at = CASE WHEN ? = 1 THEN ? ELSE activated_at END,
          worker_token = NULL, heartbeat_at = NULL
        WHERE id = ? AND status = 'validating'
      `).run(
        result.featureSchemaHash,
        result.trainingDataHash,
        result.labelCount,
        JSON.stringify(result.labelCountByDistance),
        result.holdoutPredictionCount,
        JSON.stringify({...result.metrics,...(result.ridgeComparison?{ridgeComparison:result.ridgeComparison}:{})}),
        JSON.stringify(result.supportedDistances),
        result.artifactPath,
        result.artifactSha256,
        accepted ? "succeeded" : "rejected",
        accepted ? null : JSON.stringify({ code: "activation_gate_failed", reasons: rejectionReasons }),
        now,
        calibrated ? 1 : 0,
        now,
        id
      );
      if (Number(updated.changes) !== 1) throw new Error("预测模型完成状态更新失败");
      if (calibrated) {
        this.store.database.prepare(`
          INSERT INTO active_prediction_model (
            singleton, prediction_model_run_id, activated_at
          ) VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            prediction_model_run_id = excluded.prediction_model_run_id,
            activated_at = excluded.activated_at
        `).run(id, now);
        this.insertEvent(id, "activated", 5, 5, "离线门槛通过，CatBoost 已直接激活", now);
      } else if (accepted) {
        this.insertEvent(id,"awaiting_calibration",5,5,"点预测验证完成；等待独立 P80/P90 区间校准，模型尚未激活",now);
      } else {
        this.insertEvent(id, "rejected", 5, 5, "离线门槛未通过，公式基线保持激活", now);
      }
      this.store.database.exec("COMMIT");
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
    return this.get(id)!;
  }

  fail(id: string, error: unknown, workerToken?: string): void {
    const now = this.clock();
    const rawMessage = error instanceof Error ? error.message : String(error);
    const publicMessage = sanitizeClientFacingError(rawMessage);
    const failure = error instanceof Error
      ? { name: error.name, message: publicMessage }
      : { message: publicMessage };
    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.store.database.prepare(`
        UPDATE prediction_model_runs
        SET status = 'failed', failure_json = ?, completed_at = ?,
          worker_token = NULL, heartbeat_at = NULL
        WHERE id = ? AND status IN ('running', 'validating')
          AND (? IS NULL OR worker_token = ?)
      `).run(JSON.stringify(failure), now, id, workerToken ?? null, workerToken ?? null);
      if (Number(changed.changes) === 1) {
        this.insertEvent(id, "failed", 0, 5, publicMessage, now);
      }
      this.store.database.exec("COMMIT");
    } catch (transactionError) {
      this.store.database.exec("ROLLBACK");
      throw transactionError;
    }
  }

  activate(id: string): PredictionModelRun {
    const run = this.get(id);
    if (!run) throw new Error("预测模型运行不存在");
    if (run.status !== "succeeded") throw new Error("只能激活验证成功的预测模型");
    const compatibilityReasons = this.activationCompatibilityReasons(run);
    if (compatibilityReasons.length > 0) {
      throw new PredictionModelActivationCompatibilityError(compatibilityReasons);
    }
    const intervalReasons=this.intervalActivationReasons(run.artifactSha256,run.abilityBaselineHash,this.clock());
    if(intervalReasons.length)throw new Error(`预测模型区间校准门槛未通过：${intervalReasons.join(", ")}`);
    if (run.active) return run;
    if (run.artifactPath) {
      const artifactReasons = this.validateArtifactBoundary(
        run.artifactPath,
        run.artifactSha256 ?? ""
      );
      if (artifactReasons.length > 0) {
        throw new Error(`历史预测模型 artifact 校验失败：${artifactReasons.join(", ")}`);
      }
    }
    const now = this.clock();
    this.store.database.exec(this.transactionMode === "owned" ? "BEGIN IMMEDIATE" : "SAVEPOINT rai_prediction_mutation");
    try {
      this.store.database.prepare(`
        INSERT INTO active_prediction_model (singleton, prediction_model_run_id, activated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          prediction_model_run_id = excluded.prediction_model_run_id,
          activated_at = excluded.activated_at
      `).run(id, now);
      this.store.database.prepare(`
        UPDATE prediction_model_runs SET activated_at = ? WHERE id = ?
      `).run(now, id);
      this.insertEvent(id, "activated", 5, 5, "已回滚并激活该历史预测模型", now);
      this.store.database.exec(this.transactionMode === "owned" ? "COMMIT" : "RELEASE rai_prediction_mutation");
    } catch (error) {
      this.store.database.exec(this.transactionMode === "owned" ? "ROLLBACK" : "ROLLBACK TO rai_prediction_mutation; RELEASE rai_prediction_mutation");
      throw error;
    }
    return this.get(id)!;
  }

  list(limit = 50): PredictionModelRun[] {
    const rows = this.store.database.prepare(`${this.selectRunSql()}
      ORDER BY run.created_at DESC LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 200)) as unknown as PredictionModelRunRow[];
    return rows.map((row) => this.mapRun(row));
  }

  get(id: string): PredictionModelRun | null {
    const row = this.store.database.prepare(`${this.selectRunSql()}
      WHERE run.id = ?
    `).get(id) as unknown as PredictionModelRunRow | undefined;
    return row ? this.mapRun(row) : null;
  }

  events(id: string): PredictionModelEvent[] {
    const rows = this.store.database.prepare(`
      SELECT id, prediction_model_run_id AS predictionModelRunId, phase,
        progress_current AS progressCurrent, progress_total AS progressTotal,
        message, created_at AS createdAt
      FROM prediction_model_events
      WHERE prediction_model_run_id = ?
      ORDER BY created_at, rowid
    `).all(id) as unknown as PredictionModelEventRow[];
    return rows;
  }

  private validateTrainingResult(result: PredictionModelTrainingResult): string[] {
    const reasons: string[] = [];
    // Prefer the Python evaluation gate: rejected models must never activate even if
    // TypeScript metric thresholds happen to pass on a forged or partial result.
    if (result.evaluationStatus !== "accepted") {
      reasons.push("evaluation_status_not_accepted");
      for (const reason of result.rejectionReasons ?? []) {
        if (typeof reason === "string" && reason.length > 0 && reason.length < 120) {
          reasons.push(`python:${reason}`);
        }
      }
      return reasons;
    }
    const ridge = result.ridgeComparison;
    if (!ridge || ridge.status !== "passed" ||
      ![ridge.walkForwardImprovement,ridge.releaseImprovement,ridge.bootstrapLower].every(finite) ||
      ridge.walkForwardImprovement < MINIMUM_MAE_IMPROVEMENT || ridge.releaseImprovement < MINIMUM_MAE_IMPROVEMENT || ridge.bootstrapLower <= 0) {
      reasons.push("ridge_challenger_not_passed");
    }
    if ((result.rejectionReasons ?? []).length > 0) {
      reasons.push("evaluation_rejection_reasons_present");
    }
    if (!isSha256(result.featureSchemaHash)) {
      reasons.push("feature_schema_hash_invalid");
    } else if (result.featureSchemaHash !== raceResidualFeatureSchemaHash()) {
      reasons.push("feature_schema_hash_mismatch");
    }
    if (!isSha256(result.trainingDataHash)) reasons.push("training_data_hash_invalid");
    if (!isSha256(result.artifactSha256) || result.artifactPath.length === 0) {
      reasons.push("artifact_invalid");
    } else {
      reasons.push(...this.validateArtifactBoundary(result.artifactPath, result.artifactSha256));
    }
    if (result.labelCount < MINIMUM_ARTIFACT_TRAINING_LABELS) reasons.push("label_count_below_minimum");
    for (const distance of distances) {
      if (result.labelCountByDistance[distance] < MINIMUM_ARTIFACT_TRAINING_LABELS_PER_DISTANCE) {
        reasons.push(`${distance}_label_count_below_minimum`);
      }
      if (result.metrics.byDistance[distance].sampleCount < MINIMUM_HOLDOUTS_PER_DISTANCE) {
        reasons.push(`${distance}_holdout_count_below_minimum`);
      }
    }
    if (result.holdoutPredictionCount < MINIMUM_HOLDOUT_PREDICTIONS) {
      reasons.push("holdout_count_below_minimum");
    }
    if (!this.validMetrics(result.metrics)) reasons.push("metrics_invalid");
    if (result.metrics.maeImprovement < MINIMUM_MAE_IMPROVEMENT) {
      reasons.push("mae_improvement_below_5_percent");
    }
    if (
      result.metrics.maeImprovementBootstrap95Lower !== null &&
      result.metrics.maeImprovementBootstrap95Lower !== undefined
    ) {
      if (
        !finite(result.metrics.maeImprovementBootstrap95Lower) ||
        result.metrics.maeImprovementBootstrap95Lower <= 0
      ) {
        reasons.push("bootstrap_mae_improvement_not_positive");
      }
    }
    if (result.metrics.regressesAnyDistanceByMoreThan5Percent) {
      reasons.push("distance_regression_above_5_percent");
    }
    if (result.metrics.intervalCoverageChange < -MAXIMUM_INTERVAL_COVERAGE_DROP) {
      reasons.push("interval_coverage_regression_above_5_points");
    }
    if (result.metrics.onnxMaximumAbsoluteError >= ONNX_PARITY_TOLERANCE) {
      reasons.push("onnx_native_mismatch");
    }
    if (!distances.every((distance) => result.supportedDistances.includes(distance))) {
      reasons.push("required_distance_not_supported");
    }
    return reasons;
  }

  /**
   * Boundary check for activation: artifact directory confinement under
   * model-artifacts/prediction, model.onnx presence, and SHA-256 match.
   * Full ONNX session load remains the runner's responsibility for accepted
   * evaluations; this gate prevents path escape / hash spoofing at activate time.
   */
  private validateArtifactBoundary(artifactPath: string, artifactSha256: string): string[] {
    const reasons: string[] = [];
    if (artifactPath.length === 0 || !isSha256(artifactSha256)) {
      reasons.push("artifact_invalid");
      return reasons;
    }
    let artifactDirectory: string;
    try {
      artifactDirectory = resolve(artifactPath);
    } catch {
      reasons.push("artifact_path_invalid");
      return reasons;
    }
    const modelPath = resolve(artifactDirectory, "model.onnx");
    try {
      if (!existsSync(modelPath) || !statSync(modelPath).isFile()) {
        reasons.push("artifact_model_missing");
        return reasons;
      }
    } catch {
      reasons.push("artifact_model_missing");
      return reasons;
    }
    // Authoritative confinement uses realpaths: this.artifactRoot is derived from
    // SQLite's canonicalized database path (PRAGMA database_list resolves symlinks,
    // e.g. macOS /var -> /private/var), while a runner reports the artifact path it
    // was given. Comparing realpaths keeps both on the same basis and avoids
    // false positives from symlink prefixes such as /var/folders on macOS.
    try {
      const realRoot = realpathSync(this.artifactRoot);
      const realArtifact = realpathSync(artifactDirectory);
      const realModel = realpathSync(modelPath);
      const artifactFromRoot = relative(realRoot, realArtifact);
      const modelFromArtifact = relative(realArtifact, realModel);
      if (
        artifactFromRoot === "" || isAbsolute(artifactFromRoot) || artifactFromRoot === ".." ||
        artifactFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      ) reasons.push("artifact_path_outside_root");
      if (
        isAbsolute(modelFromArtifact) || modelFromArtifact === ".." ||
        modelFromArtifact.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      ) reasons.push("artifact_path_escape");
    } catch {
      // realpath can only fail if the artifact or its root vanished between checks;
      // fall back to lexical confinement so the gate stays fail-closed.
      const relativeArtifact = relative(resolve(this.artifactRoot), artifactDirectory);
      if (
        relativeArtifact === "" || isAbsolute(relativeArtifact) || relativeArtifact === ".." ||
        relativeArtifact.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      ) reasons.push("artifact_path_outside_root");
      const normalizedDir = artifactDirectory.replace(/\\/g, "/").toLowerCase();
      const normalizedModel = modelPath.replace(/\\/g, "/").toLowerCase();
      const expectedPrefix = normalizedDir.endsWith("/") ? normalizedDir : `${normalizedDir}/`;
      if (
        normalizedModel !== `${normalizedDir}/model.onnx` &&
        !normalizedModel.startsWith(expectedPrefix)
      ) reasons.push("artifact_path_escape");
    }
    try {
      const digest = createHash("sha256").update(readFileSync(modelPath)).digest("hex");
      if (digest.toLowerCase() !== artifactSha256.toLowerCase()) {
        reasons.push("artifact_sha256_mismatch");
      }
    } catch {
      reasons.push("artifact_unreadable");
    }
    return reasons;
  }

  private intervalActivationReasons(artifactSha:string|null,baselineHash:string|null,asOf:string):string[] {
    if(!artifactSha||!baselineHash)return ["calibration_identity_missing"];
    const repository=new SqliteCalibrationRepository(this.store.database);
    return distances.flatMap(distance=>repository.select(catBoostCalibrationKey(artifactSha),baselineHash,distance,asOf,1)
      ? [] : [`${distance}_independent_interval_not_validated`]);
  }

  private validMetrics(metrics: PredictionModelEvaluationMetrics): boolean {
    const topLevel = [
      metrics.baselineMaeSeconds,
      metrics.modelMaeSeconds,
      metrics.maeImprovement,
      metrics.intervalCoverageChange,
      metrics.onnxMaximumAbsoluteError
    ];
    if (!topLevel.every(finite) || metrics.baselineMaeSeconds <= 0 || metrics.modelMaeSeconds < 0) {
      return false;
    }
    if (
      metrics.maeImprovementBootstrap95Lower !== null &&
      metrics.maeImprovementBootstrap95Lower !== undefined &&
      !finite(metrics.maeImprovementBootstrap95Lower)
    ) {
      return false;
    }
    return distances.every((distance) => {
      const metric = metrics.byDistance[distance];
      return Number.isInteger(metric.sampleCount) && metric.sampleCount >= 0 &&
        [metric.baselineMaeSeconds, metric.modelMaeSeconds, metric.maeImprovement]
          .every((value) => value === null || finite(value));
    });
  }

  private activationCompatibilityReasons(
    run: PredictionModelRun
  ): PredictionModelActivationCompatibilityError["reasons"] {
    const reasons: PredictionModelActivationCompatibilityError["reasons"] = [];
    const ridge=run.metrics?.ridgeComparison;
    if(run.modelVersion===CATBOOST_PREDICTION_MODEL_VERSION && (!ridge||ridge.status!=="passed"||
      ![ridge.walkForwardImprovement,ridge.releaseImprovement,ridge.bootstrapLower].every(finite)||
      ridge.walkForwardImprovement<MINIMUM_MAE_IMPROVEMENT||ridge.releaseImprovement<MINIMUM_MAE_IMPROVEMENT||ridge.bootstrapLower<=0)) {
      reasons.push("ridge_challenger_missing");
    }
    if (run.modelVersion !== CATBOOST_PREDICTION_MODEL_VERSION) {
      reasons.push("model_version_mismatch");
    }
    if (run.featureSchemaVersion !== PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION) {
      reasons.push("feature_schema_version_mismatch");
    }
    if (run.featureSchemaHash !== raceResidualFeatureSchemaHash()) {
      reasons.push("feature_schema_hash_mismatch");
    }
    const activeAbilityBaselineHash = currentAbilityBaselineHash(this.store.database);
    if (
      run.abilityBaselineHash === null ||
      activeAbilityBaselineHash === null ||
      run.abilityBaselineHash !== activeAbilityBaselineHash
    ) {
      reasons.push("ability_baseline_mismatch");
    }
    return reasons;
  }

  private insertEvent(
    runId: string,
    phase: string,
    progressCurrent: number,
    progressTotal: number,
    message: string,
    createdAt = this.clock()
  ): void {
    this.store.database.prepare(`
      INSERT INTO prediction_model_events (
        id, prediction_model_run_id, phase, progress_current,
        progress_total, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `prediction_event_${randomUUID()}`,
      runId,
      phase,
      progressCurrent,
      progressTotal,
      message,
      createdAt
    );
  }

  private selectRunSql(): string {
    return `
      SELECT run.id, run.algorithm, run.model_version AS modelVersion,
        run.feature_schema_version AS featureSchemaVersion,
        run.feature_schema_hash AS featureSchemaHash,
        run.ability_baseline_hash AS abilityBaselineHash,
        run.training_data_hash AS trainingDataHash,
        run.training_data_through_at AS trainingDataThroughAt,
        run.hyperparameters_json AS hyperparametersJson, run.status,
        run.label_count AS labelCount,
        run.label_count_by_distance_json AS labelCountByDistanceJson,
        run.holdout_prediction_count AS holdoutPredictionCount,
        run.metrics_json AS metricsJson,
        run.supported_distances_json AS supportedDistancesJson,
        run.artifact_path AS artifactPath, run.artifact_sha256 AS artifactSha256,
        run.cancel_requested AS cancelRequested, run.failure_json AS failureJson,
        run.created_at AS createdAt, run.started_at AS startedAt,
        run.completed_at AS completedAt, run.activated_at AS activatedAt,
        run.request_json AS requestJson,
        run.worker_token AS workerToken, run.heartbeat_at AS heartbeatAt,
        run.attempt_count AS attemptCount,
        CASE WHEN active.prediction_model_run_id = run.id THEN 1 ELSE 0 END AS active
      FROM prediction_model_runs run
      LEFT JOIN active_prediction_model active ON active.singleton = 1
    `;
  }

  private mapRun(row: PredictionModelRunRow): PredictionModelRun {
    return {
      id: row.id,
      algorithm: row.algorithm,
      modelVersion: row.modelVersion,
      scope: storedScope(row.requestJson),
      featureSchemaVersion: row.featureSchemaVersion,
      featureSchemaHash: row.featureSchemaHash,
      abilityBaselineHash: row.abilityBaselineHash,
      trainingDataHash: row.trainingDataHash,
      trainingDataThroughAt: row.trainingDataThroughAt,
      hyperparameters: parseJson(row.hyperparametersJson, {}),
      status: row.status,
      labelCount: row.labelCount,
      labelCountByDistance: parseJson(row.labelCountByDistanceJson, emptyDistanceCounts()),
      holdoutPredictionCount: row.holdoutPredictionCount,
      metrics: parseJson<PredictionModelEvaluationMetrics | null>(row.metricsJson, null),
      supportedDistances: parseJson<RaceDistance[]>(row.supportedDistancesJson, []),
      artifactPath: row.artifactPath,
      artifactSha256: row.artifactSha256,
      cancelRequested: row.cancelRequested === 1,
      failure: parseJson<Record<string, unknown> | null>(row.failureJson, null),
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      activatedAt: row.activatedAt,
      active: row.active === 1
    };
  }
}
