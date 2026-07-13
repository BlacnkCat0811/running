import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import type { ImportJobResponse } from "@rai/api-contracts";
import type { PredictionModelTrainingRequest, PredictionModelTrainingResult } from "@rai/contracts";
import {
  PREDICTION_MODEL_LEASE_TIMEOUT_MS,
  PredictionModelService,
  type PredictionModelTrainer
} from "@rai/application";
import { RaiDatabase } from "@rai/health-export-parser";
import { RuntimeStateStore } from "./runtime-state.js";

export class RecomputeWorker {
  private scheduled = false;
  private running = false;
  private consecutiveFailures = 0;

  constructor(private readonly databasePath: string) {}

  get isRunning(): boolean {
    return this.running || this.scheduled;
  }

  schedule(): void {
    if (this.scheduled || this.running) return;
    this.consecutiveFailures = 0;
    this.scheduled = true;
    setTimeout(() => void this.drain(), 20);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.scheduled = false;
    this.running = true;
    try {
      while (existsSync(this.databasePath)) {
        const ran = await this.runOneInWorkerThread();
        this.consecutiveFailures = 0;
        if (!ran) break;
      }
    } catch (error) {
      this.consecutiveFailures += 1;
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Recompute worker failed: ${message}\n`);
      if (this.consecutiveFailures < 3) this.scheduled = true;
    } finally {
      this.running = false;
      if (this.scheduled) {
        const retryDelay = Math.min(1000, 20 * (2 ** this.consecutiveFailures));
        setTimeout(() => void this.drain(), retryDelay);
      }
    }
  }

  private runOneInWorkerThread(): Promise<boolean> {
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(new URL("./recompute-thread.ts", import.meta.url), {
        workerData: { databasePath: this.databasePath },
        execArgv: ["--import", "tsx"]
      });
      let settled = false;
      worker.once("message", (message: { ran?: boolean }) => {
        settled = true;
        resolvePromise(message.ran === true);
      });
      worker.once("error", (error) => {
        if (!settled) reject(error);
      });
      worker.once("exit", (code) => {
        if (!settled && code !== 0) reject(new Error(`Recompute worker thread exited with code ${code}`));
        else if (!settled) resolvePromise(false);
      });
    });
  }
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export class ExternalPredictionModelTrainer implements PredictionModelTrainer {
  constructor(
    private readonly projectRoot: string,
    private readonly runtimeRoot = projectRoot
  ) {}

  async train(
    request: PredictionModelTrainingRequest,
    signal?: AbortSignal
  ): Promise<PredictionModelTrainingResult> {
    const resultDirectory = resolve(this.runtimeRoot, "var", "prediction-training-results");
    await mkdir(resultDirectory, { recursive: true });
    const resultPath = resolve(resultDirectory, `${request.runId}.json`);
    await rm(resultPath, { force: true });
    try {
      await this.command([
        "--import",
        "tsx",
        "packages/application/src/prediction-training-runner.ts",
        "--database",
        request.databasePath,
        "--run-id",
        request.runId,
        "--as-of",
        request.asOf,
        "--artifact-directory",
        request.artifactDirectory,
        "--result",
        resultPath
      ], signal);
      if (!existsSync(resultPath)) throw new Error("训练进程未生成结果文件");
      return JSON.parse(readFileSync(resultPath, "utf8")) as PredictionModelTrainingResult;
    } finally {
      await rm(resultPath, { force: true });
    }
  }

  private command(args: string[], signal?: AbortSignal): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: this.projectRoot,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      const append = (chunk: Buffer): void => {
        output = `${output}${chunk.toString()}`.slice(-8000);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const abort = (): void => {
        terminateProcessTree(child);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.on("error", reject);
      child.on("exit", (code, exitSignal) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(new Error("prediction_training_cancelled"));
        else if (code === 0) resolvePromise();
        else reject(new Error(output.trim() || `训练进程退出，代码 ${String(code)}, 信号 ${String(exitSignal)}`));
      });
    });
  }
}

export class PredictionModelWorker {
  private scheduled = false;
  private running = false;
  private readonly instanceToken = `prediction_worker_${randomUUID()}`;

  constructor(
    private readonly databasePath: string,
    private readonly projectRoot: string,
    private readonly runtimeRoot = projectRoot,
    private readonly trainer: PredictionModelTrainer =
      new ExternalPredictionModelTrainer(projectRoot, runtimeRoot)
  ) {}

  get isRunning(): boolean {
    return this.running || this.scheduled;
  }

  schedule(): void {
    if (this.running || this.scheduled) return;
    this.scheduled = true;
    this.queueDrain(20);
  }

  private queueDrain(delayMs: number): void {
    setTimeout(() => {
      void this.drain().catch(() => {
        this.running = false;
        setTimeout(() => this.schedule(), 1_000).unref();
      });
    }, delayMs).unref();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.scheduled = false;
    this.running = true;
    let leasedRunRemains = false;
    try {
      while (existsSync(this.databasePath)) {
        const store = await RaiDatabase.open(this.databasePath);
        let runId: string | null = null;
        let workerToken: string | null = null;
        try {
          const service = new PredictionModelService(store);
          service.recoverAbandoned();
          workerToken = `${this.instanceToken}_${randomUUID()}`;
          const run = service.claimNext(workerToken);
          if (!run) {
            leasedRunRemains = service.hasInFlight();
            break;
          }
          runId = run.id;
        } finally {
          store.close();
        }
        await this.execute(runId, workerToken);
      }
    } finally {
      this.running = false;
      if (this.scheduled) this.queueDrain(20);
      else if (leasedRunRemains) {
        setTimeout(() => this.schedule(), PREDICTION_MODEL_LEASE_TIMEOUT_MS + 250).unref();
      }
    }
  }

  private async execute(runId: string, workerToken: string): Promise<void> {
    const readStore = await RaiDatabase.open(this.databasePath);
    const run = new PredictionModelService(readStore).get(runId);
    const attempt = readStore.database.prepare(`
      SELECT attempt_count AS attemptCount
      FROM prediction_model_runs WHERE id = ?
    `).get(runId) as unknown as { attemptCount: number } | undefined;
    readStore.close();
    if (!run || !attempt) return;
    const artifactDirectory = predictionModelArtifactDirectory(
      this.runtimeRoot,
      runId,
      attempt.attemptCount
    );
    await mkdir(dirname(artifactDirectory), { recursive: true });

    const abortController = new AbortController();
    const leaseDatabase = new DatabaseSync(this.databasePath);
    leaseDatabase.exec("PRAGMA busy_timeout = 2000");
    const cancellationPoll = setInterval(() => {
      if (!existsSync(this.databasePath)) return;
      try {
        const heartbeat = leaseDatabase.prepare(`
          UPDATE prediction_model_runs SET heartbeat_at = ?
          WHERE id = ? AND worker_token = ? AND status IN ('running', 'validating')
        `).run(new Date().toISOString(), runId, workerToken);
        if (Number(heartbeat.changes) !== 1) {
          abortController.abort();
          return;
        }
        const row = leaseDatabase.prepare(`
          SELECT cancel_requested AS cancelRequested
          FROM prediction_model_runs WHERE id = ?
        `).get(runId) as { cancelRequested: number } | undefined;
        if (row?.cancelRequested === 1) abortController.abort();
      } catch {
        // A short SQLite writer lock must not kill a healthy training process.
      }
    }, 1_000);
    cancellationPoll.unref();

    try {
      const result = await this.trainer.train({
        runId,
        asOf: run.trainingDataThroughAt,
        databasePath: this.databasePath,
        artifactDirectory
      }, abortController.signal);
      const store = await RaiDatabase.open(this.databasePath);
      try {
        new PredictionModelService(store).completeAndActivate(runId, result, workerToken);
      } finally {
        store.close();
      }
    } catch (error) {
      const store = await RaiDatabase.open(this.databasePath);
      try {
        const service = new PredictionModelService(store);
        if (service.isCancellationRequested(runId) || abortController.signal.aborted) {
          service.markCancelled(runId, workerToken);
        } else {
          service.fail(runId, error, workerToken);
        }
      } finally {
        store.close();
      }
    } finally {
      clearInterval(cancellationPoll);
      leaseDatabase.close();
    }
  }
}

export function predictionModelArtifactDirectory(
  runtimeRoot: string,
  runId: string,
  attemptCount: number
): string {
  if (!/^prediction_model_[0-9a-f-]{36}$/i.test(runId)) {
    throw new Error("预测模型 Run ID 无效");
  }
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error("预测模型训练尝试次数无效");
  }
  return resolve(
    runtimeRoot,
    "var",
    "model-artifacts",
    "prediction",
    runId,
    `attempt-${attemptCount}`
  );
}

interface MutableImportJob extends ImportJobResponse {
  inputPath: string;
  onTerminal?: (succeeded: boolean) => void | Promise<void>;
}

interface ImportDatasetChange {
  mode: "unchanged" | "incremental" | "full";
  dirtyFromAt: string | null;
  insertedWorkouts: number;
  updatedWorkouts: number;
  removedWorkouts: number;
  unchangedWorkouts: number;
  routesUpdated: number;
}

export class ImportWorker {
  private readonly jobs = new Map<string, MutableImportJob>();
  private readonly jobStatePath: string;
  private readonly state: RuntimeStateStore;
  private running = false;

  constructor(
    private readonly databasePath: string,
    private readonly projectRoot: string,
    private readonly runtimeRoot = projectRoot,
    private readonly beforeActivate: () => void | Promise<void> = () => {},
    private readonly afterActivate: () => void | Promise<void> = () => {}
  ) {
    this.jobStatePath = resolve(runtimeRoot, "var/import-jobs.json");
    this.state = new RuntimeStateStore(runtimeRoot);
    this.state.migrateLegacyJobs(this.jobStatePath);
    this.loadJobs();
  }

  get isRunning(): boolean {
    return this.running;
  }

  create(inputPathValue: string, onTerminal?: (succeeded: boolean) => void | Promise<void>): ImportJobResponse {
    if (this.running) throw new Error("已有导入任务正在执行");
    const inputPath = resolve(inputPathValue);
    if (!existsSync(inputPath) || !statSync(inputPath).isDirectory()) {
      throw new Error("Apple Health 导出目录不存在");
    }
    if (!existsSync(resolve(inputPath, "export.xml")) && !existsSync(resolve(inputPath, "导出.xml"))) {
      throw new Error("目录中未找到 export.xml 或导出.xml");
    }
    const id = `web_import_${Date.now().toString(36)}`;
    const job: MutableImportJob = {
      id,
      status: "queued",
      phase: "queued",
      message: "导入任务已排队",
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      inputPath
    };
    if (onTerminal) job.onTerminal = onTerminal;
    this.jobs.set(id, job);
    this.persistJobs();
    this.running = true;
    setTimeout(() => void this.run(job), 20);
    return this.publicJob(job);
  }

  get(id: string): ImportJobResponse | null {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job) : null;
  }

  latest(): ImportJobResponse | null {
    const jobs = [...this.jobs.values()];
    const job = jobs.at(-1);
    return job ? this.publicJob(job) : null;
  }

  private async run(job: MutableImportJob): Promise<void> {
    const startedAtMs = Date.now();
    job.status = "running";
    this.persistJobs();
    const stagingDatabase = resolve(this.runtimeRoot, "var", `rai.importing.${job.id}.sqlite`);
    let currentBackupPath: string | null = null;
    try {
      await this.removeDatabaseFiles(stagingDatabase);
      currentBackupPath = await this.createCurrentBackup(job.id);
      if (currentBackupPath) await copyFile(currentBackupPath, stagingDatabase);
      job.phase = "import";
      job.message = currentBackupPath
        ? "正在临时数据库中增量同步 Apple Health 数据"
        : "正在临时数据库中解析 Apple Health 导出文件";
      this.persistJobs();
      await this.command([
        "--import",
        "tsx",
        "packages/health-export-parser/src/cli.ts",
        currentBackupPath ? "incremental-import" : "import",
        "--input",
        job.inputPath,
        "--database",
        stagingDatabase,
        "--report",
        resolve(this.runtimeRoot, "docs/DATA_AUDIT.md"),
        "--json-report",
        resolve(this.runtimeRoot, "var/reports/data-audit.json"),
        ...(currentBackupPath ? ["--batch-id", job.id] : ["--replace"])
      ]);
      const change = currentBackupPath
        ? this.analyzeDatasetChange(stagingDatabase, currentBackupPath)
        : {
            mode: "full" as const,
            dirtyFromAt: null,
            insertedWorkouts: this.countRows(stagingDatabase, "training_sessions"),
            updatedWorkouts: 0,
            removedWorkouts: 0,
            unchangedWorkouts: 0,
            routesUpdated: this.countRows(stagingDatabase, "workout_routes")
          };
      if (change.mode === "unchanged") {
        job.status = "succeeded";
        job.phase = "completed";
        job.message = "导出文件中没有影响分析的新数据";
        job.completedAt = new Date().toISOString();
        job.summary = {
          importMode: "unchanged",
          ...change,
          featuresReused: 0,
          featuresRecomputed: 0,
          modelReplayFrom: null,
          durationMs: Date.now() - startedAtMs,
          backupName: currentBackupPath ? currentBackupPath.split(/[\\/]/).at(-1) ?? null : null
        };
        this.persistJobs();
        return;
      }
      // Incremental staging starts from an online backup, so overrides and immutable
      // histories already remain attached to their stable training-session identities.
      job.phase = "recompute";
      job.message = "导入完成，正在重算 RAI 时间线";
      this.persistJobs();
      await this.command([
        "--import",
        "tsx",
        "packages/application/src/cli.ts",
        "recompute",
        "--database",
        stagingDatabase,
        "--timezone",
        "Asia/Shanghai",
        ...(change.mode === "incremental" && change.dirtyFromAt
          ? ["--dirty-from", change.dirtyFromAt, "--shadow-validate"]
          : [])
      ]);
      const featureSummary = this.latestFeatureRunSummary(stagingDatabase);
      job.phase = "activate";
      job.message = "验证完成，正在切换本地数据库";
      this.persistJobs();
      await this.activateDatabase(stagingDatabase, job.id, currentBackupPath);
      job.status = "succeeded";
      job.phase = "completed";
      job.message = "导入与模型重算完成";
      job.completedAt = new Date().toISOString();
      job.summary = {
        importMode: change.mode,
        insertedWorkouts: change.insertedWorkouts,
        updatedWorkouts: change.updatedWorkouts,
        removedWorkouts: change.removedWorkouts,
        unchangedWorkouts: change.unchangedWorkouts,
        routesUpdated: change.routesUpdated,
        featuresReused: featureSummary.reused,
        featuresRecomputed: featureSummary.recomputed,
        modelReplayFrom: change.mode === "incremental" ? change.dirtyFromAt : null,
        durationMs: Date.now() - startedAtMs,
        backupName: currentBackupPath ? currentBackupPath.split(/[\\/]/).at(-1) ?? null : null
      };
      this.persistJobs();
    } catch (error) {
      job.status = "failed";
      job.phase = "failed";
      job.message = "导入失败，原始导出文件未被修改";
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date().toISOString();
      this.persistJobs();
    } finally {
      await this.removeDatabaseFiles(stagingDatabase);
      this.running = false;
      try { await job.onTerminal?.(job.status === "succeeded"); } catch { /* Cleanup metadata must not change the completed import result. */ }
    }
  }

  private countRows(databasePath: string, table: string): number {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    } finally { database.close(); }
  }

  private latestFeatureRunSummary(databasePath: string): { reused: number; recomputed: number } {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare(`
        SELECT reused_feature_count AS reused, recomputed_feature_count AS recomputed
        FROM feature_runs ORDER BY created_at DESC LIMIT 1
      `).get() as unknown as { reused: number; recomputed: number } | undefined;
      return { reused: Number(row?.reused ?? 0), recomputed: Number(row?.recomputed ?? 0) };
    } finally { database.close(); }
  }

  private analyzeDatasetChange(stagingPath: string, previousPath: string): ImportDatasetChange {
    const database = new DatabaseSync(stagingPath);
    try {
      database.prepare("ATTACH DATABASE ? AS previous").run(previousPath);
      const count = (sql: string): number => Number((database.prepare(sql).get() as { count: number }).count);
      const insertedWorkouts = count(`SELECT COUNT(*) AS count FROM training_sessions current
        WHERE NOT EXISTS (SELECT 1 FROM previous.training_sessions old WHERE old.id = current.id)`);
      const removedWorkouts = count(`SELECT COUNT(*) AS count FROM previous.training_sessions old
        WHERE NOT EXISTS (SELECT 1 FROM training_sessions current WHERE current.id = old.id)`);
      const updatedWorkouts = count(`SELECT COUNT(*) AS count FROM training_sessions current
        JOIN previous.training_sessions old ON old.id = current.id
        WHERE current.canonical_workout_id IS NOT old.canonical_workout_id
           OR current.anchor_start_at <> old.anchor_start_at
           OR current.anchor_end_at <> old.anchor_end_at
           OR current.anchor_distance_km IS NOT old.anchor_distance_km`);
      const unchangedWorkouts = count(`SELECT COUNT(*) AS count FROM training_sessions current
        JOIN previous.training_sessions old ON old.id = current.id
        WHERE current.canonical_workout_id IS old.canonical_workout_id
          AND current.anchor_start_at = old.anchor_start_at
          AND current.anchor_end_at = old.anchor_end_at
          AND current.anchor_distance_km IS old.anchor_distance_km`);
      const relevantTypes = `(
        'HKQuantityTypeIdentifierHeartRate',
        'HKQuantityTypeIdentifierRestingHeartRate',
        'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
        'HKCategoryTypeIdentifierSleepAnalysis'
      )`;
      const healthChanged = count(`SELECT COUNT(*) AS count FROM (
        SELECT id FROM health_records WHERE type IN ${relevantTypes}
        EXCEPT SELECT id FROM previous.health_records WHERE type IN ${relevantTypes}
        UNION ALL
        SELECT id FROM previous.health_records WHERE type IN ${relevantTypes}
        EXCEPT SELECT id FROM health_records WHERE type IN ${relevantTypes}
      )`) > 0;
      const routeFingerprintChanged = count(`SELECT COUNT(*) AS count
        FROM import_manifest current JOIN previous.import_manifest old ON old.key = current.key
        WHERE current.key = 'source_gpx_bundle_sha256' AND current.value <> old.value`) > 0;
      const routesUpdated = routeFingerprintChanged ? count("SELECT COUNT(*) AS count FROM workout_routes") : 0;
      const dirty = database.prepare(`SELECT MIN(value) AS dirtyFromAt FROM (
        SELECT current.anchor_start_at AS value FROM training_sessions current
          WHERE NOT EXISTS (SELECT 1 FROM previous.training_sessions old WHERE old.id = current.id)
        UNION ALL
        SELECT old.anchor_start_at FROM previous.training_sessions old
          WHERE NOT EXISTS (SELECT 1 FROM training_sessions current WHERE current.id = old.id)
        UNION ALL
        SELECT current.anchor_start_at FROM training_sessions current
          JOIN previous.training_sessions old ON old.id = current.id
          WHERE current.canonical_workout_id IS NOT old.canonical_workout_id
             OR current.anchor_end_at <> old.anchor_end_at
             OR current.anchor_distance_km IS NOT old.anchor_distance_km
      )`).get() as unknown as { dirtyFromAt: string | null };
      const hasWorkoutChange = insertedWorkouts + updatedWorkouts + removedWorkouts > 0;
      if (!hasWorkoutChange && !routeFingerprintChanged && !healthChanged) {
        return { mode: "unchanged", dirtyFromAt: null, insertedWorkouts, updatedWorkouts, removedWorkouts, unchangedWorkouts, routesUpdated };
      }
      const dirtyFromAt = routeFingerprintChanged && !dirty.dirtyFromAt
        ? (database.prepare("SELECT MIN(anchor_start_at) AS value FROM training_sessions").get() as { value: string | null }).value
        : dirty.dirtyFromAt;
      return {
        mode: healthChanged || !dirtyFromAt ? "full" : "incremental",
        dirtyFromAt,
        insertedWorkouts, updatedWorkouts, removedWorkouts, unchangedWorkouts, routesUpdated
      };
    } finally {
      try { database.exec("DETACH DATABASE previous"); } catch { /* Database is closing. */ }
      database.close();
    }
  }

  private async createCurrentBackup(jobId: string): Promise<string | null> {
    if (!existsSync(this.databasePath)) return null;
    const backupDirectory = resolve(this.runtimeRoot, "var/backups");
    await mkdir(backupDirectory, { recursive: true });
    const backupPath = resolve(backupDirectory, `rai.before-web-import.${jobId}.sqlite`);
    const currentDatabase = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      await backup(currentDatabase, backupPath);
    } finally {
      currentDatabase.close();
    }
    return backupPath;
  }

  private preserveHistoricalState(stagingDatabase: string, previousDatabase: string): void {
    const database = new DatabaseSync(stagingDatabase);
    let attached = false;
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.prepare("ATTACH DATABASE ? AS previous").run(previousDatabase);
      attached = true;
      database.exec("BEGIN IMMEDIATE");
      this.stabilizeTrainingSessionIds(database);
      database.exec(`
        INSERT OR IGNORE INTO feature_runs
        SELECT * FROM previous.feature_runs;

        INSERT OR IGNORE INTO workout_overrides (
          id, training_session_id, revision, eligibility_override, session_type,
          rpe, condition_tags_json, note, created_at, performance_protocol,
          statistics_participation
        )
        SELECT
          historical.id,
          historical.training_session_id,
          historical.revision,
          historical.eligibility_override,
          historical.session_type,
          historical.rpe,
          historical.condition_tags_json,
          historical.note,
          historical.created_at,
          historical.performance_protocol,
          historical.statistics_participation
        FROM previous.workout_overrides historical
        WHERE EXISTS (
          SELECT 1 FROM training_sessions current_session
          WHERE current_session.id = historical.training_session_id
        );

        INSERT OR IGNORE INTO workout_features
        SELECT historical.*
        FROM previous.workout_features historical
        WHERE EXISTS (
          SELECT 1 FROM training_sessions current_session
          WHERE current_session.id = historical.training_session_id
        );

        INSERT OR IGNORE INTO model_runs
        SELECT historical.*
        FROM previous.model_runs historical
        WHERE EXISTS (
          SELECT 1 FROM feature_runs current_feature_run
          WHERE current_feature_run.id = historical.feature_run_id
        ) AND (
          SELECT COUNT(*) FROM previous.workout_features previous_feature
          WHERE previous_feature.feature_run_id = historical.feature_run_id
        ) = (
          SELECT COUNT(*) FROM workout_features current_feature
          WHERE current_feature.feature_run_id = historical.feature_run_id
        );

        INSERT OR IGNORE INTO ability_assessments
        SELECT historical.*
        FROM previous.ability_assessments historical
        WHERE EXISTS (
          SELECT 1 FROM model_runs current_model
          WHERE current_model.id = historical.model_run_id
        ) AND EXISTS (
          SELECT 1 FROM workout_features current_feature
          WHERE current_feature.id = historical.feature_id
        ) AND EXISTS (
          SELECT 1 FROM training_sessions current_session
          WHERE current_session.id = historical.training_session_id
        );

        INSERT OR IGNORE INTO daily_ability_snapshots (
          id, model_run_id, local_date, timezone_identifier, true_ability,
          decay_points, growth_velocity_per_week, last_assessment_id,
          snapshot_status, computed_at
        )
        SELECT
          historical.id,
          historical.model_run_id,
          historical.local_date,
          historical.timezone_identifier,
          historical.true_ability,
          historical.decay_points,
          historical.growth_velocity_per_week,
          CASE
            WHEN historical.last_assessment_id IS NULL THEN NULL
            WHEN EXISTS (
              SELECT 1 FROM ability_assessments current_assessment
              WHERE current_assessment.id = historical.last_assessment_id
            ) THEN historical.last_assessment_id
            ELSE NULL
          END,
          historical.snapshot_status,
          historical.computed_at
        FROM previous.daily_ability_snapshots historical
        WHERE EXISTS (
          SELECT 1 FROM model_runs current_model
          WHERE current_model.id = historical.model_run_id
        );

        INSERT OR IGNORE INTO training_metric_runs
        SELECT historical.*
        FROM previous.training_metric_runs historical
        WHERE EXISTS (
          SELECT 1 FROM model_runs current_model
          WHERE current_model.id = historical.model_run_id
        );

        INSERT OR IGNORE INTO workout_training_loads
        SELECT historical.*
        FROM previous.workout_training_loads historical
        WHERE EXISTS (
          SELECT 1 FROM training_metric_runs current_metric_run
          WHERE current_metric_run.id = historical.training_metric_run_id
        ) AND EXISTS (
          SELECT 1 FROM training_sessions current_session
          WHERE current_session.id = historical.training_session_id
        ) AND (
          historical.feature_id IS NULL OR EXISTS (
            SELECT 1 FROM workout_features current_feature
            WHERE current_feature.id = historical.feature_id
          )
        );

        INSERT OR IGNORE INTO daily_training_metrics
        SELECT historical.*
        FROM previous.daily_training_metrics historical
        WHERE EXISTS (
          SELECT 1 FROM training_metric_runs current_metric_run
          WHERE current_metric_run.id = historical.training_metric_run_id
        );

        INSERT OR IGNORE INTO recompute_jobs
        SELECT historical.*
        FROM previous.recompute_jobs historical
        WHERE historical.status IN ('succeeded', 'failed', 'cancelled')
          AND (historical.feature_run_id IS NULL OR EXISTS (
            SELECT 1 FROM feature_runs current_feature_run
            WHERE current_feature_run.id = historical.feature_run_id
          ))
          AND (historical.model_run_id IS NULL OR EXISTS (
            SELECT 1 FROM model_runs current_model
            WHERE current_model.id = historical.model_run_id
          ));

        INSERT OR IGNORE INTO recompute_job_events
        SELECT historical.*
        FROM previous.recompute_job_events historical
        WHERE EXISTS (
          SELECT 1 FROM recompute_jobs current_job
          WHERE current_job.id = historical.job_id
        );

        INSERT OR IGNORE INTO prediction_model_runs
        SELECT * FROM previous.prediction_model_runs
        WHERE status IN ('succeeded', 'rejected', 'failed', 'cancelled');

        INSERT OR IGNORE INTO prediction_model_events
        SELECT historical.*
        FROM previous.prediction_model_events historical
        WHERE EXISTS (
          SELECT 1 FROM prediction_model_runs current_run
          WHERE current_run.id = historical.prediction_model_run_id
        );

        INSERT OR REPLACE INTO active_prediction_model
        SELECT historical.*
        FROM previous.active_prediction_model historical
        WHERE EXISTS (
          SELECT 1 FROM prediction_model_runs current_run
          WHERE current_run.id = historical.prediction_model_run_id
            AND current_run.status = 'succeeded'
        );
      `);
      const violations = database.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new Error("历史派生数据迁移后外键校验失败");
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* No active transaction. */ }
      throw error;
    } finally {
      if (attached) {
        try { database.exec("DETACH DATABASE previous"); } catch { /* Database is closing. */ }
      }
      database.close();
    }
  }

  private stabilizeTrainingSessionIds(database: DatabaseSync): void {
    type SessionIdentityRow = {
      id: string;
      activityType: string;
      anchorStartAt: string;
      anchorEndAt: string;
      anchorDistanceKm: number | null;
    };
    const current = database.prepare(`
      SELECT id, activity_type AS activityType, anchor_start_at AS anchorStartAt,
        anchor_end_at AS anchorEndAt, anchor_distance_km AS anchorDistanceKm
      FROM training_sessions ORDER BY anchor_start_at
    `).all() as unknown as SessionIdentityRow[];
    const previous = database.prepare(`
      SELECT id, activity_type AS activityType, anchor_start_at AS anchorStartAt,
        anchor_end_at AS anchorEndAt, anchor_distance_km AS anchorDistanceKm
      FROM previous.training_sessions WHERE status <> 'inactive' ORDER BY anchor_start_at
    `).all() as unknown as SessionIdentityRow[];
    const currentIds = new Set(current.map((session) => session.id));
    const previousIds = new Set(previous.map((session) => session.id));
    const usedPreviousIds = new Set(current.filter((session) => previousIds.has(session.id)).map((session) => session.id));
    const matches = (candidate: SessionIdentityRow, historical: SessionIdentityRow): boolean => {
      if (candidate.activityType !== historical.activityType) return false;
      const candidateStart = Date.parse(candidate.anchorStartAt);
      const candidateEnd = Date.parse(candidate.anchorEndAt);
      const historicalStart = Date.parse(historical.anchorStartAt);
      const historicalEnd = Date.parse(historical.anchorEndAt);
      if (![candidateStart, candidateEnd, historicalStart, historicalEnd].every(Number.isFinite)) return false;
      if (Math.abs(candidateStart - historicalStart) > 120_000) return false;
      const overlap = Math.max(0, Math.min(candidateEnd, historicalEnd) - Math.max(candidateStart, historicalStart));
      const shorterDuration = Math.max(1, Math.min(candidateEnd - candidateStart, historicalEnd - historicalStart));
      if (overlap / shorterDuration < 0.85) return false;
      if (candidate.anchorDistanceKm !== null && historical.anchorDistanceKm !== null) {
        const tolerance = Math.max(0.2, 0.03 * Math.max(candidate.anchorDistanceKm, historical.anchorDistanceKm));
        return Math.abs(candidate.anchorDistanceKm - historical.anchorDistanceKm) <= tolerance;
      }
      return Math.abs((candidateEnd - candidateStart) - (historicalEnd - historicalStart)) <= Math.max(
        120_000,
        0.05 * Math.max(candidateEnd - candidateStart, historicalEnd - historicalStart)
      );
    };
    const insertSession = database.prepare(`
      INSERT INTO training_sessions (
        id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status, created_at, updated_at
      )
      SELECT ?, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status, created_at, updated_at
      FROM training_sessions WHERE id = ?
    `);
    const groupIds = database.prepare(
      "SELECT id FROM workout_groups WHERE training_session_id = ?"
    );
    const clearGroups = database.prepare(
      "UPDATE workout_groups SET training_session_id = NULL WHERE training_session_id = ?"
    );
    const restoreGroup = database.prepare(
      "UPDATE workout_groups SET training_session_id = ? WHERE id = ?"
    );
    const removeSession = database.prepare("DELETE FROM training_sessions WHERE id = ?");
    const insertIssue = database.prepare(`
      INSERT INTO import_issues (severity, code, object_id, message)
      VALUES ('warning', 'AMBIGUOUS_TRAINING_SESSION_MATCH', ?, ?)
    `);
    for (const session of current) {
      if (previous.some((historical) => historical.id === session.id)) {
        usedPreviousIds.add(session.id);
        continue;
      }
      const candidates = previous.filter(
        (historical) => !usedPreviousIds.has(historical.id) && !currentIds.has(historical.id) && matches(session, historical)
      );
      if (candidates.length > 1) {
        insertIssue.run(session.id, "Imported training session matched more than one historical session; identity was not changed.");
        continue;
      }
      const historical = candidates[0];
      if (!historical) continue;
      const groups = groupIds.all(session.id) as unknown as Array<{ id: string }>;
      clearGroups.run(session.id);
      insertSession.run(historical.id, session.id);
      for (const group of groups) restoreGroup.run(historical.id, group.id);
      removeSession.run(session.id);
      usedPreviousIds.add(historical.id);
    }
  }

  private async activateDatabase(stagingDatabase: string, jobId: string, existingBackupPath: string | null = null): Promise<void> {
    if (!existsSync(stagingDatabase)) throw new Error("临时数据库未生成");
    const backupPath = existingBackupPath ?? await this.createCurrentBackup(jobId);
    await this.beforeActivate();
    try {
      await this.removeDatabaseFilesWithRetry(this.databasePath);
      await mkdir(dirname(this.databasePath), { recursive: true });
      await rename(stagingDatabase, this.databasePath);
    } catch (error) {
      if (!existsSync(this.databasePath) && backupPath && existsSync(backupPath)) {
        await copyFile(backupPath, this.databasePath);
      }
      throw error;
    } finally {
      await this.afterActivate();
    }
  }

  private async removeDatabaseFilesWithRetry(path: string): Promise<void> {
    const attempts = 20;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.removeDatabaseFiles(path);
        return;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (!["EBUSY", "EPERM", "EACCES"].includes(code) || attempt === attempts) throw error;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
  }

  private async removeDatabaseFiles(path: string): Promise<void> {
    for (const candidate of [path, `${path}-shm`, `${path}-wal`]) {
      await rm(candidate, { force: true });
    }
  }

  private command(args: string[]): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: this.projectRoot,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let errorOutput = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errorOutput = `${errorOutput}${chunk.toString()}`.slice(-4000);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(errorOutput.trim() || `导入进程退出，代码 ${String(code)}`));
      });
    });
  }

  private publicJob(job: MutableImportJob): ImportJobResponse {
    return {
      id: job.id,
      status: job.status,
      phase: job.phase,
      message: job.message,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: job.error
      ,...(job.progress === undefined ? {} : { progress: job.progress })
      ,...(job.summary === undefined ? {} : { summary: job.summary })
    };
  }

  private loadJobs(): void {
    try {
      const parsed = this.state.jobs(20) as MutableImportJob[];
      for (const value of parsed) {
        if (!value || typeof value.id !== "string" || typeof value.inputPath !== "string") continue;
        if (["queued", "running"].includes(value.status)) {
          value.status = "failed";
          value.phase = "interrupted";
          value.message = "上次导入因本地服务重启而中断，可重新提交导入";
          value.error = "Local API restarted before the import completed";
          value.completedAt = new Date().toISOString();
        }
        this.jobs.set(value.id, value);
      }
      this.persistJobs();
    } catch {
      // Corrupt task metadata must not block the local API or the health database.
    }
  }

  private persistJobs(): void {
    const jobs = [...this.jobs.values()].slice(-20);
    for (const { onTerminal: _onTerminal, ...job } of jobs) this.state.upsertJob(job);
  }
}
