import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import type { ImportJobResponse } from "@rai/api-contracts";
import {
  healthTypes,
  type PredictionModelTrainingRequest,
  type PredictionModelTrainingResult
} from "@rai/contracts";
import {
  PREDICTION_MODEL_LEASE_TIMEOUT_MS,
  PredictionModelService,
  currentAbilityBaselineHash,
  type PredictionModelTrainer
} from "@rai/application";
import {
  ImportRemovalGuardError,
  type RemovalGuardPayload,
  stageAuditFiles,
  type StagedAuditFiles,
} from "@rai/health-export-parser";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";
import { resolvePreserveAbsent } from "./import-sources.js";
import { RuntimeStateStore } from "./runtime-state.js";
import { backupPolicyFromEnvironment, DatabaseMaintenance } from "./maintenance.js";

/** Client-visible import failure text; full diagnostics stay in server logs only. */
export const PUBLIC_IMPORT_FAILURE_ERROR = "导入失败，请查看服务日志";

/**
 * Finds a removal-guard failure anywhere in an error chain. The guard message is
 * authored for the operator and carries no paths or stack details, so it is the
 * one import failure safe to return to a client verbatim.
 */
function findRemovalGuardError(error: unknown): ImportRemovalGuardError | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ImportRemovalGuardError) return current;
    if (current instanceof AggregateError) queue.push(...current.errors);
    else if (current instanceof Error && current.cause !== undefined) queue.push(current.cause);
  }
  return null;
}

const applyBusyTimeout = (database: DatabaseSync, milliseconds = 5000): void => {
  database.exec(`PRAGMA busy_timeout = ${milliseconds}`);
};

export const predictionModelWorkerRetryDelay = (consecutiveFailures: number): number =>
  Math.min(30_000, 1_000 * (2 ** Math.max(0, consecutiveFailures - 1)));

export class RecomputeWorker {
  private scheduled = false;
  private running = false;
  private consecutiveFailures = 0;
  private closing = false;
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private activeWorker: Worker | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly onDatabaseError: (error: unknown) => void = () => {}
  ) {}

  get isRunning(): boolean {
    return this.running || this.scheduled;
  }

  schedule(): void {
    if (this.closing) return;
    if (this.scheduled) return;
    if (this.running) {
      this.scheduled = true;
      return;
    }
    this.consecutiveFailures = 0;
    this.scheduled = true;
    this.queueDrain(20);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.scheduled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.activeWorker?.terminate();
    await this.drainPromise;
  }

  private queueDrain(delayMs: number): void {
    if (this.closing || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const promise = this.drain();
      this.drainPromise = promise;
      void promise.finally(() => {
        if (this.drainPromise === promise) this.drainPromise = null;
      });
    }, delayMs);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.scheduled = false;
    this.running = true;
    try {
      this.recoverInterruptedJobs();
      while (!this.closing && existsSync(this.databasePath)) {
        const ran = await this.runOneInWorkerThread();
        if (ran) this.consecutiveFailures = 0;
        if (!ran) break;
      }
    } catch (error) {
      this.onDatabaseError(error);
      this.consecutiveFailures += 1;
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Recompute worker failed: ${message}\n`);
      if (!this.closing && this.consecutiveFailures < 3) {
        this.scheduled = true;
      } else if (!this.closing) {
        try {
          this.failOutstandingJobs(error);
        } catch (terminalError) {
          const terminalMessage = terminalError instanceof Error
            ? terminalError.stack ?? terminalError.message
            : String(terminalError);
          process.stderr.write(`Recompute worker could not release failed jobs: ${terminalMessage}\n`);
          this.scheduled = true;
        }
      }
    } finally {
      this.running = false;
      if (!this.closing && this.scheduled) {
        const retryDelay = Math.min(1000, 20 * (2 ** this.consecutiveFailures));
        this.queueDrain(retryDelay);
      }
    }
  }

  private recoverInterruptedJobs(): void {
    if (!existsSync(this.databasePath)) return;
    this.withJobRepository((jobs) => {
      jobs.recoverInterrupted();
    });
  }

  private failOutstandingJobs(error: unknown): void {
    this.withJobRepository((jobs) => {
      jobs.failOutstanding(error);
    });
  }

  private withJobRepository(action: (jobs: RecomputeJobRepository) => void): void {
    const database = new DatabaseSync(this.databasePath);
    applyBusyTimeout(database, 2_000);
    try {
      action(new RecomputeJobRepository(database));
    } finally {
      database.close();
    }
  }

  private runOneInWorkerThread(): Promise<boolean> {
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(new URL("./recompute-worker-bootstrap.mjs", import.meta.url), {
        workerData: { databasePath: this.databasePath }
      });
      this.activeWorker = worker;
      let result: boolean | null = null;
      let workerError: Error | null = null;
      worker.once("message", (message: { ran?: boolean }) => {
        result = message.ran === true;
      });
      worker.once("error", (error) => {
        workerError = error;
      });
      worker.once("exit", (code) => {
        if (this.activeWorker === worker) this.activeWorker = null;
        if (workerError) reject(workerError);
        else if (code !== 0 && !this.closing) reject(new Error(`Recompute worker thread exited with code ${code}`));
        else resolvePromise(result ?? false);
      });
    });
  }
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onExit);
      resolvePromise(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    child.once("error", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

function waitForShutdown<T>(promise: Promise<T> | null, timeoutMs: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for worker shutdown")), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      const taskkillExited = await waitForProcessExit(killer, 1_500);
      if (taskkillExited && killer.exitCode === 0 && await waitForProcessExit(child, 1_500)) return;
    }
    throw new Error("Failed to terminate Windows worker process tree");
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    if (!await waitForProcessExit(child, 1_500)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  if (!await waitForProcessExit(child, 1_500)) throw new Error("Timed out terminating worker process tree");
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
    if (signal?.aborted) return Promise.reject(new Error("prediction_training_cancelled"));
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
        void terminateProcessTree(child).catch(() => child.kill("SIGKILL"));
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
  private closing = false;
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private activeAbortController: AbortController | null = null;
  private consecutiveDrainFailures = 0;

  constructor(
    private readonly databasePath: string,
    private readonly projectRoot: string,
    private readonly runtimeRoot = projectRoot,
    private readonly trainer: PredictionModelTrainer =
      new ExternalPredictionModelTrainer(projectRoot, runtimeRoot),
    private readonly onDatabaseError: (error: unknown) => void = () => {}
  ) {}

  get isRunning(): boolean {
    return this.running || this.scheduled;
  }

  private service(store: RaiDatabase): PredictionModelService {
    return new PredictionModelService(
      store,
      resolve(this.runtimeRoot, "var", "model-artifacts", "prediction")
    );
  }

  schedule(): void {
    if (this.closing) return;
    if (this.scheduled) return;
    if (this.running) {
      this.scheduled = true;
      return;
    }
    this.scheduled = true;
    this.queueDrain(20);
  }

  private queueDrain(delayMs: number): void {
    if (this.closing || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const promise = this.drain().then(() => {
        this.consecutiveDrainFailures = 0;
      }).catch((error) => {
        this.onDatabaseError(error);
        this.running = false;
        this.consecutiveDrainFailures += 1;
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`Prediction model worker failed: ${message}\n`);
        if (!this.closing) {
          const retryDelay = predictionModelWorkerRetryDelay(this.consecutiveDrainFailures);
          this.queueDrain(retryDelay);
        }
      });
      this.drainPromise = promise;
      void promise.finally(() => {
        if (this.drainPromise === promise) this.drainPromise = null;
      });
    }, delayMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.scheduled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.activeAbortController?.abort();
    await this.drainPromise;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.scheduled = false;
    this.running = true;
    let leasedRunRemains = false;
    try {
      while (!this.closing && existsSync(this.databasePath)) {
        const store = await RaiDatabase.open(this.databasePath);
        let runId: string | null = null;
        let workerToken: string | null = null;
        try {
          const service = this.service(store);
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
        if (this.closing) {
          const shutdownStore = await RaiDatabase.open(this.databasePath);
          try {
            this.service(shutdownStore).releaseLeaseForShutdown(runId, workerToken);
          } finally {
            shutdownStore.close();
          }
          break;
        }
        await this.execute(runId, workerToken);
      }
    } finally {
      this.running = false;
      if (!this.closing && this.scheduled) this.queueDrain(20);
      else if (!this.closing && leasedRunRemains) {
        this.queueDrain(PREDICTION_MODEL_LEASE_TIMEOUT_MS + 250);
      }
    }
  }

  private async execute(runId: string, workerToken: string): Promise<void> {
    const readStore = await RaiDatabase.open(this.databasePath);
    if (this.closing) {
      try {
        this.service(readStore).releaseLeaseForShutdown(runId, workerToken);
      } finally {
        readStore.close();
      }
      return;
    }
    const run = this.service(readStore).get(runId);
    const attempt = readStore.database.prepare(`
      SELECT attempt_count AS attemptCount
      FROM prediction_model_runs WHERE id = ?
    `).get(runId) as unknown as { attemptCount: number } | undefined;
    readStore.close();
    if (!run || !attempt) {
      const shutdownStore = await RaiDatabase.open(this.databasePath);
      try {
        this.service(shutdownStore).releaseLeaseForShutdown(runId, workerToken);
      } finally {
        shutdownStore.close();
      }
      return;
    }
    const artifactDirectory = predictionModelArtifactDirectory(
      this.runtimeRoot,
      runId,
      attempt.attemptCount
    );
    await mkdir(dirname(artifactDirectory), { recursive: true });
    if (this.closing) {
      const shutdownStore = await RaiDatabase.open(this.databasePath);
      try {
        this.service(shutdownStore).releaseLeaseForShutdown(runId, workerToken);
      } finally {
        shutdownStore.close();
      }
      return;
    }

    const abortController = new AbortController();
    this.activeAbortController = abortController;
    if (this.closing) abortController.abort();
    const leaseDatabase = new DatabaseSync(this.databasePath);
    applyBusyTimeout(leaseDatabase, 2000);
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
      } catch (error) {
        this.onDatabaseError(error);
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
      if (this.closing) throw new Error("prediction_training_shutdown");
      const store = await RaiDatabase.open(this.databasePath);
      try {
        const service = this.service(store);
        if (this.closing) service.releaseLeaseForShutdown(runId, workerToken);
        else service.completeAndActivate(runId, result, workerToken);
      } finally {
        store.close();
      }
    } catch (error) {
      const store = await RaiDatabase.open(this.databasePath);
      try {
        const service = this.service(store);
        if (this.closing) {
          service.releaseLeaseForShutdown(runId, workerToken);
        } else if (service.isCancellationRequested(runId) || abortController.signal.aborted) {
          service.markCancelled(runId, workerToken);
        } else {
          service.fail(runId, error, workerToken);
        }
      } finally {
        store.close();
      }
    } finally {
      if (this.activeAbortController === abortController) this.activeAbortController = null;
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
  preserveAbsent?: boolean;
  removalGuard?: RemovalGuardPayload;
  onTerminal?: (succeeded: boolean, durable: boolean) => void | Promise<void>;
}

export interface ImportWorkerSource {
  kind?: string | null;
  displayName?: string | null;
  originalPath?: string | null;
}

interface ImportDatasetChange {
  mode: "unchanged" | "data-only" | "incremental" | "full";
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
  private closing = false;
  private timer: NodeJS.Timeout | null = null;
  private runPromise: Promise<void> | null = null;
  private activeChild: ChildProcess | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly projectRoot: string,
    private readonly runtimeRoot = projectRoot,
    private readonly beforeActivate: () => void | Promise<void> = () => {},
    private readonly afterActivate: () => void | Promise<void> = () => {},
    private readonly onDatabaseError: (error: unknown) => void = () => {}
  ) {
    this.jobStatePath = resolve(runtimeRoot, "var/import-jobs.json");
    this.state = new RuntimeStateStore(runtimeRoot);
    this.state.migrateLegacyJobs(this.jobStatePath);
    this.loadJobs();
  }

  get isRunning(): boolean {
    return this.running;
  }

  create(
    inputPathValue: string,
    onTerminal?: (succeeded: boolean, durable: boolean) => void | Promise<void>,
    sourceId?: string,
    source?: ImportWorkerSource
  ): ImportJobResponse {
    if (this.closing) throw new Error("导入服务正在关闭");
    if (this.running) throw new Error("已有导入任务正在执行");
    const inputPath = resolve(inputPathValue);
    if (!existsSync(inputPath) || !statSync(inputPath).isDirectory()) {
      throw new Error("Apple Health 导出目录不存在");
    }
    if (!existsSync(resolve(inputPath, "export.xml")) && !existsSync(resolve(inputPath, "导出.xml"))) {
      throw new Error("目录中未找到 export.xml 或导出.xml");
    }
    const id = `web_import_${Date.now().toString(36)}`;
    // Absence-as-deletion is opt-in via the client's sync manifest; an archive
    // filename is only consulted when no manifest is present.
    const snapshot = resolvePreserveAbsent(inputPath, source ?? {});
    const preserveAbsent = snapshot.preserveAbsent;
    const job: MutableImportJob = {
      id,
      status: "queued",
      phase: "queued",
      message: "导入任务已排队",
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      inputPath,
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(preserveAbsent ? { preserveAbsent: true } : {})
    };
    if (onTerminal) job.onTerminal = onTerminal;
    this.jobs.set(id, job);
    this.persistJobs();
    this.running = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      const promise = this.run(job).catch((error) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`Import worker failed unexpectedly: ${message}\n`);
      });
      this.runPromise = promise;
      void promise.finally(() => {
        if (this.runPromise === promise) this.runPromise = null;
      });
    }, 20);
    this.timer.unref();
    return this.publicJob(job);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running && !this.runPromise) {
      const job = [...this.jobs.values()].at(-1);
      if (job && ["queued", "running"].includes(job.status)) {
        job.status = "failed";
        job.phase = "interrupted";
        job.message = "导入因本地服务关闭而中断，可重新提交导入";
        job.error = PUBLIC_IMPORT_FAILURE_ERROR;
        job.completedAt = new Date().toISOString();
        let durable = false;
        let persistenceError: unknown;
        try {
          await this.persistJobsWithRetry();
          durable = true;
        } catch (error) {
          persistenceError = error;
        }
        try { await this.runTerminalCallbackWithRetry(job, false, durable); }
        catch { /* Terminal cleanup is best-effort during shutdown. */ }
        this.running = false;
        if (persistenceError) throw persistenceError;
      }
      this.running = false;
    }
    let terminationError: unknown;
    try {
      if (this.activeChild) await terminateProcessTree(this.activeChild);
    } catch (error) {
      terminationError = error;
      this.activeChild?.kill("SIGKILL");
    } finally {
      if (terminationError) await waitForShutdown(this.runPromise, 3_000);
      else await this.runPromise;
    }
    if (terminationError) throw terminationError;
  }

  get(id: string): ImportJobResponse | null {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job) : null;
  }

  findBySourceId(sourceId: string): ImportJobResponse | null {
    const job = [...this.jobs.values()]
      .filter((candidate) => candidate.sourceId === sourceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    return job ? this.publicJob(job) : null;
  }

  latest(): ImportJobResponse | null {
    const jobs = [...this.jobs.values()];
    const job = jobs.at(-1);
    return job ? this.publicJob(job) : null;
  }

  private async run(job: MutableImportJob): Promise<void> {
    const startedAtMs = Date.now();
    const stagingDatabase = resolve(this.runtimeRoot, "var", `rai.importing.${job.id}.sqlite`);
    const stagedMarkdownReport = resolve(this.runtimeRoot, "var", `data-audit.${job.id}.md`);
    const stagedJsonReport = resolve(this.runtimeRoot, "var", `data-audit.${job.id}.json`);
    const finalMarkdownReport = resolve(this.runtimeRoot, "docs/DATA_AUDIT.md");
    const finalJsonReport = resolve(this.runtimeRoot, "var/reports/data-audit.json");
    let currentBackupPath: string | null = null;
    let auditPublication: StagedAuditFiles | null = null;
    let terminalSucceeded = false;
    let publishTerminalState: (() => void) | null = null;
    try {
      job.status = "running";
      this.persistJobs();
      await this.removeDatabaseFiles(stagingDatabase);
      this.assertNotClosing();
      currentBackupPath = await this.createCurrentBackup(job.id);
      this.assertNotClosing();
      if (currentBackupPath) await copyFile(currentBackupPath, stagingDatabase);
      this.assertNotClosing();
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
        stagedMarkdownReport,
        "--json-report",
        stagedJsonReport,
        ...(currentBackupPath ? ["--batch-id", job.id] : ["--replace"]),
        // Absence-as-deletion is opt-in, so the CLI needs to be told explicitly
        // when a payload declared itself a complete snapshot. A falsy flag means
        // "not preserving", matching how the parser reads the same option.
        ...(currentBackupPath
          ? [job.preserveAbsent ? "--preserve-absent" : "--replace-absent"]
          : [])
      ]);
      this.assertNotClosing();
      const change = currentBackupPath
        ? this.analyzeDatasetChange(stagingDatabase, currentBackupPath, job.id, job.preserveAbsent)
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
        terminalSucceeded = true;
        publishTerminalState = () => {
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
        };
        return;
      }
      let featureSummary = { reused: 0, recomputed: 0 };
      if (change.mode !== "data-only") {
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
        this.assertNotClosing();
        featureSummary = this.latestFeatureRunSummary(stagingDatabase);
      }
      job.phase = "activate";
      job.message = change.mode === "data-only"
        ? "导入完成，正在保存无需重算的数据"
        : "验证完成，正在切换本地数据库";
      this.persistJobs();
      auditPublication = this.stageAuditReports(
        stagingDatabase,
        finalMarkdownReport,
        finalJsonReport,
      );
      await this.activateDatabase(
        stagingDatabase,
        job.id,
        currentBackupPath,
        () => auditPublication?.commit(),
      );
      auditPublication.finalize();
      terminalSucceeded = true;
      publishTerminalState = () => {
        job.status = "succeeded";
        job.phase = "completed";
        job.message = change.mode === "data-only" ? "导入完成，分析数据没有变化" : "导入与模型重算完成";
        job.completedAt = new Date().toISOString();
        job.summary = {
          importMode: change.mode === "data-only" ? "incremental" : change.mode,
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
      };
    } catch (error) {
      this.onDatabaseError(error);
      let failure: unknown = error;
      try {
        auditPublication?.rollback();
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          "Import failed and audit report publication could not be rolled back",
        );
      }
      terminalSucceeded = false;
      const removalGuard = findRemovalGuardError(failure);
      publishTerminalState = () => {
        const detail = failure instanceof Error
          ? (failure.stack ?? failure.message)
          : String(failure);
        // Keep full diagnostics in server logs only; never return child stderr or paths to clients.
        console.error(`Import job ${job.id} failed: ${detail}`);
        job.status = "failed";
        job.phase = "failed";
        job.message = "导入失败，原始导出文件未被修改";
        // The guard refusal is a deliberate safety stop, not an opaque crash, so
        // the operator is told exactly what was about to be deleted and why.
        job.error = removalGuard ? removalGuard.userMessage : PUBLIC_IMPORT_FAILURE_ERROR;
        if (removalGuard) job.removalGuard = removalGuard.toPayload();
        job.completedAt = new Date().toISOString();
      };
    } finally {
      try {
        await Promise.all([
          this.removeDatabaseFiles(stagingDatabase),
          // Only on the committed path: after a failure the displaced database may
          // be the only usable recovery point, so it must survive for an operator.
          ...(terminalSucceeded ? [this.reclaimDisplacedImportDatabases(stagingDatabase)] : []),
          rm(stagedMarkdownReport, { force: true }),
          rm(stagedJsonReport, { force: true }),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`Failed to clean up import staging database: ${message}\n`);
      } finally {
        let terminalStatePersisted = false;
        try {
          publishTerminalState?.();
          if (publishTerminalState) {
            await this.persistJobsWithRetry();
            terminalStatePersisted = true;
          }
        } catch (error) {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          process.stderr.write(`Failed to persist terminal import state for ${job.id}: ${message}\n`);
        } finally {
          try {
            await this.runTerminalCallbackWithRetry(job, terminalSucceeded, terminalStatePersisted);
          } catch (error) {
            const message = error instanceof Error ? error.stack ?? error.message : String(error);
            process.stderr.write(`Failed to finalize import source for ${job.id}: ${message}\n`);
          } finally {
            this.running = false;
          }
        }
      }
    }
  }

  private async persistJobsWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        this.persistJobs();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw lastError;
  }

  private async runTerminalCallbackWithRetry(
    job: MutableImportJob,
    succeeded: boolean,
    durable: boolean
  ): Promise<void> {
    if (!job.onTerminal) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await job.onTerminal(succeeded, durable);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw lastError;
  }

  private stageAuditReports(
    databasePath: string,
    markdownPath: string,
    jsonPath: string,
  ): StagedAuditFiles {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return stageAuditFiles(database, markdownPath, jsonPath);
    } finally {
      database.close();
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

  private analyzeDatasetChange(
    stagingPath: string,
    previousPath: string,
    batchId?: string,
    preserveAbsent?: boolean
  ): ImportDatasetChange {
    const database = new DatabaseSync(stagingPath);
    applyBusyTimeout(database);
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
           OR current.anchor_distance_km IS NOT old.anchor_distance_km
           OR current.status IS NOT old.status`);
      const unchangedWorkouts = count(`SELECT COUNT(*) AS count FROM training_sessions current
        JOIN previous.training_sessions old ON old.id = current.id
        WHERE current.canonical_workout_id IS old.canonical_workout_id
          AND current.anchor_start_at = old.anchor_start_at
          AND current.anchor_end_at = old.anchor_end_at
          AND current.anchor_distance_km IS old.anchor_distance_km
          AND current.status IS old.status`);
      const relevantTypes = `(${[
        healthTypes.heartRate,
        healthTypes.restingHeartRate,
        healthTypes.hrvSdnn,
        healthTypes.runningSpeed,
        healthTypes.sleepAnalysis,
        healthTypes.vo2Max
      ].map((type) => `'${type}'`).join(", ")})`;
      const batch = batchId ? database.prepare(`
        SELECT status FROM import_batches WHERE id = ?
      `).get(batchId) as { status: string } | undefined : undefined;
      const useChangeLedger = batch?.status === "succeeded";
      const ledgerBatchId = batchId ?? "";
      const healthChanged = useChangeLedger ? Number((database.prepare(`
        SELECT COUNT(*) AS count
        FROM import_entity_changes change
        LEFT JOIN health_records current ON current.id = change.entity_id
        LEFT JOIN previous.health_records old ON old.id = change.entity_id
        WHERE change.batch_id = ?
          AND change.entity_kind = 'record'
          AND COALESCE(current.type, old.type) IN ${relevantTypes}
      `).get(ledgerBatchId) as { count: number }).count) > 0 : count(`SELECT COUNT(*) AS count FROM (
        SELECT id FROM (
          SELECT id FROM health_records WHERE type IN ${relevantTypes}
          EXCEPT SELECT id FROM previous.health_records WHERE type IN ${relevantTypes}
        )
        UNION ALL
        SELECT id FROM (
          SELECT id FROM previous.health_records WHERE type IN ${relevantTypes}
          EXCEPT SELECT id FROM health_records WHERE type IN ${relevantTypes}
        )
      )`) > 0;
      const anyHealthRecordChanged = useChangeLedger ? Number((database.prepare(`
        SELECT COUNT(*) AS count FROM import_entity_changes
        WHERE batch_id = ? AND entity_kind = 'record'
      `).get(ledgerBatchId) as { count: number }).count) > 0 : count(`SELECT COUNT(*) AS count FROM (
        SELECT id FROM (
          SELECT id FROM health_records
          EXCEPT SELECT id FROM previous.health_records
        )
        UNION ALL
        SELECT id FROM (
          SELECT id FROM previous.health_records
          EXCEPT SELECT id FROM health_records
        )
      )`) > 0;
      const activitySummaryChanged = useChangeLedger ? Number((database.prepare(`
        SELECT COUNT(*) AS count FROM import_entity_changes
        WHERE batch_id = ? AND entity_kind = 'activity_summary'
      `).get(ledgerBatchId) as { count: number }).count) > 0 : count(`SELECT COUNT(*) AS count FROM (
        SELECT date_components, attributes_json FROM (
          SELECT date_components, attributes_json FROM activity_summaries
          EXCEPT SELECT date_components, attributes_json FROM previous.activity_summaries
        )
        UNION ALL
        SELECT date_components, attributes_json FROM (
          SELECT date_components, attributes_json FROM previous.activity_summaries
          EXCEPT SELECT date_components, attributes_json FROM activity_summaries
        )
      )`) > 0;
      const profileChanged = count(`SELECT COUNT(*) AS count FROM (
        SELECT id, attributes_json FROM (
          SELECT id, attributes_json FROM profile
          EXCEPT SELECT id, attributes_json FROM previous.profile
        )
        UNION ALL
        SELECT id, attributes_json FROM (
          SELECT id, attributes_json FROM previous.profile
          EXCEPT SELECT id, attributes_json FROM profile
        )
      )`) > 0;
      const inventoryChanged = count(`SELECT COUNT(*) AS count FROM (
        SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM (
          SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM entity_inventory
          EXCEPT
          SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM previous.entity_inventory
        )
        UNION ALL
        SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM (
          SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM previous.entity_inventory
          EXCEPT
          SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM entity_inventory
        )
      )`) > 0;
      const auditManifestChanged = count(`SELECT COUNT(*) AS count FROM (
        SELECT key, value FROM (
          SELECT key, value FROM import_manifest WHERE key IN ('dataset_version', 'record_count')
          EXCEPT
          SELECT key, value FROM previous.import_manifest WHERE key IN ('dataset_version', 'record_count')
        )
        UNION ALL
        SELECT key, value FROM (
          SELECT key, value FROM previous.import_manifest WHERE key IN ('dataset_version', 'record_count')
          EXCEPT
          SELECT key, value FROM import_manifest WHERE key IN ('dataset_version', 'record_count')
        )
      )`) > 0;
      const importIssuesChanged = count(`SELECT COUNT(*) AS count FROM (
        SELECT severity, code, object_id, message, occurrence_count FROM (
          SELECT severity, code, object_id, message, COUNT(*) AS occurrence_count
          FROM import_issues GROUP BY severity, code, object_id, message
          EXCEPT
          SELECT severity, code, object_id, message, COUNT(*) AS occurrence_count
          FROM previous.import_issues GROUP BY severity, code, object_id, message
        )
        UNION ALL
        SELECT severity, code, object_id, message, occurrence_count FROM (
          SELECT severity, code, object_id, message, COUNT(*) AS occurrence_count
          FROM previous.import_issues GROUP BY severity, code, object_id, message
          EXCEPT
          SELECT severity, code, object_id, message, COUNT(*) AS occurrence_count
          FROM import_issues GROUP BY severity, code, object_id, message
        )
      )`) > 0;
      const routeFingerprintChanged = count(`SELECT COUNT(*) AS count FROM (
        SELECT key, value FROM (
          SELECT key, value FROM import_manifest WHERE key = 'source_gpx_bundle_sha256'
          EXCEPT
          SELECT key, value FROM previous.import_manifest WHERE key = 'source_gpx_bundle_sha256'
        )
        UNION ALL
        SELECT key, value FROM (
          SELECT key, value FROM previous.import_manifest WHERE key = 'source_gpx_bundle_sha256'
          EXCEPT
          SELECT key, value FROM import_manifest WHERE key = 'source_gpx_bundle_sha256'
        )
      )`) > 0;
      const routeChanges = routeFingerprintChanged ? database.prepare(`
        WITH changed_routes(route_id) AS (
          SELECT current.route_id
          FROM route_file_fingerprints current
          LEFT JOIN previous.route_file_fingerprints old ON old.relative_path = current.relative_path
          WHERE old.relative_path IS NULL OR old.sha256 <> current.sha256 OR old.route_id <> current.route_id
          UNION
          SELECT old.route_id
          FROM previous.route_file_fingerprints old
          LEFT JOIN route_file_fingerprints current ON current.relative_path = old.relative_path
          WHERE current.relative_path IS NULL OR current.sha256 <> old.sha256 OR current.route_id <> old.route_id
        ), route_times(value) AS (
          SELECT workout.start_at FROM changed_routes changed
          JOIN workout_routes route ON route.id = changed.route_id
          JOIN workouts workout ON workout.id = route.workout_id
          UNION ALL
          SELECT workout.start_at FROM changed_routes changed
          JOIN previous.workout_routes route ON route.id = changed.route_id
          JOIN previous.workouts workout ON workout.id = route.workout_id
        )
        SELECT
          (SELECT COUNT(*) FROM changed_routes) AS count,
          (SELECT MIN(value) FROM route_times) AS dirtyFromAt
      `).get() as { count: number; dirtyFromAt: string | null } : { count: 0, dirtyFromAt: null };
      const hasGranularRouteChanges = routeChanges.count > 0;
      const ignoreUngranularPreserveAbsentRoutes =
        Boolean(preserveAbsent) && routeFingerprintChanged && !hasGranularRouteChanges;
      const routeChangeAffectsDirtyRange = routeFingerprintChanged && !ignoreUngranularPreserveAbsentRoutes;
      const routesUpdated = routeChangeAffectsDirtyRange
        ? hasGranularRouteChanges ? Number(routeChanges.count) : count("SELECT COUNT(*) AS count FROM workout_routes")
        : 0;
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
              OR current.status IS NOT old.status
      )`).get() as unknown as { dirtyFromAt: string | null };
      const hasWorkoutChange = insertedWorkouts + updatedWorkouts + removedWorkouts > 0;
      // A deletion can arrive before its entity. Publish the tombstone even if
      // no workout or scoring input changed, and persist authoritative clears.
      const tombstonesChanged = [
        ["import_entity_tombstones", "entity_kind, entity_id, source_identifier"],
        ["import_source_tombstones", "entity_kind, source_identifier"]
      ].some(([table, columns]) => {
        const previousExists = database.prepare(
          "SELECT 1 FROM previous.sqlite_master WHERE type = 'table' AND name = ?"
        ).get(table!) !== undefined;
        if (!previousExists) return count(`SELECT COUNT(*) AS count FROM ${table}`) > 0;
        return count(`SELECT COUNT(*) AS count FROM (
          SELECT * FROM (SELECT ${columns} FROM ${table} EXCEPT SELECT ${columns} FROM previous.${table})
          UNION ALL
          SELECT * FROM (SELECT ${columns} FROM previous.${table} EXCEPT SELECT ${columns} FROM ${table})
        )`) > 0;
      });
      if (!hasWorkoutChange && !routeChangeAffectsDirtyRange && !healthChanged && !profileChanged) {
        return {
          mode: anyHealthRecordChanged || activitySummaryChanged || inventoryChanged ||
            auditManifestChanged || importIssuesChanged || tombstonesChanged
            ? "data-only"
            : "unchanged",
          dirtyFromAt: null,
          insertedWorkouts,
          updatedWorkouts,
          removedWorkouts,
          unchangedWorkouts,
          routesUpdated
        };
      }
      const granularDirtyFromAt = [dirty.dirtyFromAt, routeChanges.dirtyFromAt]
        .filter((value): value is string => value !== null)
        .sort()[0] ?? null;
      const dirtyFromAt = routeChangeAffectsDirtyRange && !hasGranularRouteChanges && !dirty.dirtyFromAt
        ? (database.prepare("SELECT MIN(anchor_start_at) AS value FROM training_sessions").get() as { value: string | null }).value
        : granularDirtyFromAt;
      return {
        mode: healthChanged || profileChanged || !dirtyFromAt ? "full" : "incremental",
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
    const maintenance = new DatabaseMaintenance(
      this.databasePath,
      this.runtimeRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backupPolicyFromEnvironment()
    );
    if (!this.isReadableDatabase(this.databasePath)) {
      this.onDatabaseError(new Error("Main database is corrupt or failed its integrity check"));
      await maintenance.preserveCorruptDatabase(`before-web-import-${jobId}-corrupt`);
      return null;
    }
    await maintenance.ensureBackupCapacity();
    const backupPath = resolve(backupDirectory, `rai.before-web-import.${jobId}.sqlite`);
    const stagingBackupPath = `${backupPath}.partial-${randomUUID()}`;
    const currentDatabase = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      await this.backupDatabase(currentDatabase, stagingBackupPath);
      await rename(stagingBackupPath, backupPath);
    } catch (error) {
      try {
        await this.cleanupPartialBackup(stagingBackupPath);
      } catch (cleanupError) {
        if (error && typeof error === "object") {
          try {
            (error as { cleanupError?: unknown }).cleanupError = cleanupError;
          } catch { /* Preserve the original backup error even when it is immutable. */ }
        }
      }
      throw error;
    } finally {
      currentDatabase.close();
    }
    try {
      await maintenance.enforceBackupPolicy(basename(backupPath));
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Import backup retention cleanup failed after backup was published: ${message}\n`);
    }
    return backupPath;
  }

  private async backupDatabase(database: DatabaseSync, destination: string): Promise<void> {
    await backup(database, destination);
  }

  private async cleanupPartialBackup(path: string): Promise<void> {
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.removePartialBackupFile(path);
        return;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (!["EBUSY", "EPERM", "EACCES"].includes(code) || attempt === attempts) throw error;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
  }

  private async removePartialBackupFile(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  private preserveHistoricalState(stagingDatabase: string, previousDatabase: string): void {
    const database = new DatabaseSync(stagingDatabase);
    applyBusyTimeout(database);
    let attached = false;
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.prepare("ATTACH DATABASE ? AS previous").run(previousDatabase);
      attached = true;
      database.exec("BEGIN IMMEDIATE");
      this.stabilizeTrainingSessionIds(database);
      const activeAbilityBaselineHash = currentAbilityBaselineHash(database);
      const previousPredictionColumns = new Set(
        (database.prepare("PRAGMA previous.table_info(prediction_model_runs)").all() as Array<{ name: string }>)
          .map((column) => column.name)
      );
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

        INSERT OR IGNORE INTO training_zone_profile_settings
        SELECT historical.*
        FROM previous.training_zone_profile_settings historical;

        INSERT OR IGNORE INTO daily_zone_profiles
        SELECT historical.*
        FROM previous.daily_zone_profiles historical
        WHERE EXISTS (
          SELECT 1 FROM training_metric_runs current_metric_run
          WHERE current_metric_run.id = historical.training_metric_run_id
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

        INSERT OR IGNORE INTO workout_zone_summaries
        SELECT historical.*
        FROM previous.workout_zone_summaries historical
        WHERE EXISTS (
          SELECT 1 FROM training_metric_runs current_metric_run
          WHERE current_metric_run.id = historical.training_metric_run_id
        ) AND EXISTS (
          SELECT 1 FROM training_sessions current_session
          WHERE current_session.id = historical.training_session_id
        ) AND EXISTS (
          SELECT 1 FROM workout_features current_feature
          WHERE current_feature.id = historical.feature_id
        ) AND EXISTS (
          SELECT 1 FROM daily_zone_profiles current_profile
          WHERE current_profile.id = historical.zone_profile_id
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

      `);
      database.exec(`
        INSERT OR IGNORE INTO prediction_model_runs (
          id, algorithm, model_version, feature_schema_version, feature_schema_hash,
          training_data_hash, training_data_through_at, hyperparameters_json, request_json,
          status, label_count, label_count_by_distance_json, holdout_prediction_count,
          metrics_json, supported_distances_json, artifact_path, artifact_sha256,
          cancel_requested, failure_json, created_at, started_at, completed_at, activated_at,
          worker_token, heartbeat_at, attempt_count, ability_baseline_hash
        )
        SELECT
          historical.id, historical.algorithm, historical.model_version,
          historical.feature_schema_version, historical.feature_schema_hash,
          historical.training_data_hash, historical.training_data_through_at,
          historical.hyperparameters_json, historical.request_json, historical.status,
          historical.label_count, historical.label_count_by_distance_json,
          historical.holdout_prediction_count, historical.metrics_json,
          historical.supported_distances_json, historical.artifact_path,
          historical.artifact_sha256, historical.cancel_requested, historical.failure_json,
          historical.created_at, historical.started_at, historical.completed_at,
          historical.activated_at, historical.worker_token, historical.heartbeat_at,
          historical.attempt_count,
          ${previousPredictionColumns.has("ability_baseline_hash") ? "historical.ability_baseline_hash" : "NULL"}
        FROM previous.prediction_model_runs historical
        WHERE historical.status IN ('succeeded', 'rejected', 'failed', 'cancelled');

        INSERT OR IGNORE INTO prediction_model_events
        SELECT historical.*
        FROM previous.prediction_model_events historical
        WHERE EXISTS (
          SELECT 1 FROM prediction_model_runs current_run
          WHERE current_run.id = historical.prediction_model_run_id
        );
      `);
      if (previousPredictionColumns.has("ability_baseline_hash")) {
        database.prepare(`
          INSERT OR REPLACE INTO active_prediction_model
          SELECT historical.*
          FROM previous.active_prediction_model historical
          JOIN previous.prediction_model_runs historical_run
            ON historical_run.id = historical.prediction_model_run_id
          JOIN prediction_model_runs current_run
            ON current_run.id = historical.prediction_model_run_id
          WHERE current_run.status = 'succeeded'
            AND historical_run.ability_baseline_hash IS NOT NULL
            AND historical_run.ability_baseline_hash = ?
            AND current_run.ability_baseline_hash = ?
        `).run(activeAbilityBaselineHash, activeAbilityBaselineHash);
      }
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

  activeInputPaths(): string[] {
    return [...this.jobs.values()]
      .filter((job) => ["queued", "running"].includes(job.status))
      .map((job) => job.inputPath);
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

  private async activateDatabase(
    stagingDatabase: string,
    jobId: string,
    existingBackupPath?: string | null,
    beforeCommit: () => void | Promise<void> = () => {},
  ): Promise<void> {
    if (!existsSync(stagingDatabase)) throw new Error("临时数据库未生成");
    // undefined means activation owns the backup step; null means the caller
    // already handled the active database and no usable backup was produced.
    const backupPath = existingBackupPath === undefined
      ? await this.createCurrentBackup(jobId)
      : existingBackupPath;
    const rollbackDirectory = resolve(this.runtimeRoot, "var/backups");
    const rollbackPath = resolve(rollbackDirectory, `rai.import-rollback.${randomUUID()}.sqlite`);
    await mkdir(rollbackDirectory, { recursive: true });
    this.assertNotClosing();
    let gateEntered = false;
    try {
      await this.beforeActivate();
      gateEntered = true;
    } catch (error) {
      throw error;
    }

    const originalExisted = existsSync(this.databasePath);
    const originalReadable = originalExisted && this.isReadableDatabase(this.databasePath);
    if (originalExisted && !originalReadable) {
      this.onDatabaseError(new Error("Main database is corrupt or failed its integrity check"));
    }
    let originalMoved = false;
    let committed = false;
    let commitBoundaryEntered = false;
    try {
      this.assertNotClosing();
      if (originalExisted) {
        if (originalReadable) this.checkpointDatabase(this.databasePath);
        await this.removeDatabaseSidecarsWithRetry(this.databasePath);
        await this.moveDatabaseFile(this.databasePath, rollbackPath);
        originalMoved = true;
      }
      this.assertNotClosing();
      await mkdir(dirname(this.databasePath), { recursive: true });
      await this.installDatabase(stagingDatabase, this.databasePath);
      if (!this.isReadableDatabase(this.databasePath)) {
        throw new Error("Imported database is not readable after activation");
      }
      commitBoundaryEntered = true;
      await beforeCommit();
      await this.releaseActivateGate();
      gateEntered = false;
      committed = true;
    } catch (error) {
      const errors: unknown[] = [error];
      if (originalMoved) {
        errors.push(...await this.restoreImportDatabase(rollbackPath, backupPath));
      } else if (!originalExisted && commitBoundaryEntered) {
        try {
          this.checkpointDatabase(this.databasePath);
          await this.removeDatabaseSidecarsWithRetry(this.databasePath);
          await this.removeDatabaseFileWithRetry(this.databasePath);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
      const activeReadable = this.isReadableDatabase(this.databasePath);
      if (gateEntered && (activeReadable || (originalExisted && !originalReadable && existsSync(this.databasePath)))) {
        try {
          await this.releaseActivateGate();
          gateEntered = false;
        } catch (releaseError) {
          errors.push(releaseError);
        }
      }
      throw errors.length === 1
        ? error
        : new AggregateError(errors, "Import activation failed and required recovery actions also failed");
    } finally {
      if (committed && originalMoved) {
        // The rollback point is a full copy of the database and it lives in
        // `var/backups/`, so leaving it behind wastes a whole database's worth of
        // space and counts against `enforceBackupPolicy`, squeezing out real
        // backups. A locked file (EBUSY/EPERM) is not worth failing a committed
        // import over, but it must not be silent either.
        try {
          await this.removeDatabaseFileWithRetry(rollbackPath);
        } catch (cleanupError) {
          const message = cleanupError instanceof Error
            ? cleanupError.stack ?? cleanupError.message
            : String(cleanupError);
          process.stderr.write(`Failed to remove the import rollback point after commit: ${message}\n`);
        }
      }
    }
  }

  private async restoreImportDatabase(rollbackPath: string, backupPath: string | null): Promise<unknown[]> {
    const errors: unknown[] = [];
    const activeExists = existsSync(this.databasePath);
    const activeReadable = activeExists && this.isReadableDatabase(this.databasePath);
    if (activeReadable) {
      try {
        this.checkpointDatabase(this.databasePath);
        await this.removeDatabaseSidecarsWithRetry(this.databasePath);
        await this.moveDatabaseFile(rollbackPath, this.databasePath);
      } catch (error) {
        errors.push(error);
      }
    } else {
      if (activeExists) {
        try {
          try { this.checkpointDatabase(this.databasePath); } catch { /* Candidate is already unreadable. */ }
          await this.removeDatabaseSidecarsWithRetry(this.databasePath);
          await this.removeDatabaseFileWithRetry(this.databasePath);
        } catch (error) {
          errors.push(error);
        }
      }
      if (!existsSync(this.databasePath)) {
        try {
          await this.moveDatabaseFile(rollbackPath, this.databasePath);
        } catch (rollbackError) {
          errors.push(rollbackError);
          if (backupPath && existsSync(backupPath)) {
            errors.push(...await this.restoreOnlineBackup(backupPath));
          }
        }
      }
    }
    if (!this.isReadableDatabase(this.databasePath)) {
      errors.push(new Error("Import rollback did not restore a readable active database"));
    }
    return errors;
  }

  private async restoreOnlineBackup(backupPath: string): Promise<unknown[]> {
    const errors: unknown[] = [];
    const stagingPath = `${this.databasePath}.import-backup-restore.${randomUUID()}`;
    let installed = false;
    try {
      await this.copyDatabaseFile(backupPath, stagingPath);
      if (!this.isReadableDatabase(stagingPath)) {
        throw new Error("Online import backup is not readable before restoration");
      }
      await this.moveDatabaseFile(stagingPath, this.databasePath);
      if (!this.isReadableDatabase(this.databasePath)) {
        throw new Error("Online import backup is not readable after restoration");
      }
      installed = true;
    } catch (error) {
      errors.push(error);
      for (const candidate of [
        `${this.databasePath}-shm`,
        `${this.databasePath}-wal`,
        this.databasePath
      ]) {
        try {
          await this.removeDatabaseFileWithRetry(candidate);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
    } finally {
      for (const candidate of [stagingPath, `${stagingPath}-shm`, `${stagingPath}-wal`]) {
        try {
          await this.removeDatabaseFileWithRetry(candidate);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
    }
    if (!installed && existsSync(this.databasePath)) {
      errors.push(new Error("Failed online import backup restoration exposed an active database file"));
    }
    return errors;
  }

  private checkpointDatabase(path: string): void {
    const database = new DatabaseSync(path);
    applyBusyTimeout(database);
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
  }

  private isReadableDatabase(path: string): boolean {
    if (!existsSync(path)) return false;
    try {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        return (database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined)?.quick_check === "ok";
      } finally {
        database.close();
      }
    } catch {
      return false;
    }
  }

  private async releaseActivateGate(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.afterActivate();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw lastError;
  }

  private async removeDatabaseSidecarsWithRetry(path: string): Promise<void> {
    await this.removeDatabaseFileWithRetry(`${path}-shm`);
    await this.removeDatabaseFileWithRetry(`${path}-wal`);
  }

  private async removeDatabaseFileWithRetry(path: string): Promise<void> {
    const attempts = 20;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.removeDatabaseFile(path);
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

  private async installDatabase(source: string, destination: string): Promise<void> {
    await rename(source, destination);
  }

  private async moveDatabaseFile(source: string, destination: string): Promise<void> {
    await rename(source, destination);
  }

  private async copyDatabaseFile(source: string, destination: string): Promise<void> {
    await copyFile(source, destination);
  }

  private async removeDatabaseFile(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  private async removeDatabaseFiles(path: string): Promise<void> {
    for (const candidate of [path, `${path}-shm`, `${path}-wal`]) {
      await rm(candidate, { force: true });
    }
  }

  /**
   * Reclaims the rename-aside rollback points the CLI produced for this import
   * (`<stagingDatabase>.replaced.<uuid>`).
   *
   * `packages/health-export-parser/src/cli.ts` intentionally retains the displaced
   * database, and the worker cannot unilaterally revoke that contract. But this
   * worker already wrote `var/backups/rai.before-web-import.<jobId>.sqlite` before
   * the import started, so its own rollback point is redundant once the import has
   * committed. Leaving it behind costs a full database copy per web import
   * (2026-09-15: 89 files / 36 GB accumulated online, taking a 50 GB disk to 98%).
   */
  private async reclaimDisplacedImportDatabases(stagingDatabase: string): Promise<void> {
    const directory = dirname(stagingDatabase);
    if (!existsSync(directory)) return;
    const prefix = `${basename(stagingDatabase)}.replaced.`;
    const names = (await readdir(directory)).filter((name) => name.startsWith(prefix));
    await Promise.all(names.map((name) => this.removeDatabaseFiles(resolve(directory, name))));
  }

  private command(args: string[]): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Import worker is shutting down"));
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: this.projectRoot,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      });
      this.activeChild = child;
      if (this.closing) void terminateProcessTree(child).catch(reject);
      let errorOutput = "";
      let removalGuard: ImportRemovalGuardError | null = null;
      child.on("message", (message: unknown) => {
        if (ImportRemovalGuardError.fromPayload(message)) {
          removalGuard = ImportRemovalGuardError.fromPayload(message) ?? removalGuard;
          // Acknowledge receipt before the child disconnects so the guard
          // cannot be lost between IPC delivery and the close event.
          if (child.connected) child.send({ type: "rai:removal-guard-ack" });
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        errorOutput = `${errorOutput}${chunk.toString()}`.slice(-4000);
      });
      child.on("error", (error) => {
        if (this.activeChild === child) this.activeChild = null;
        reject(error);
      });
      child.on("close", (code) => {
        if (this.activeChild === child) this.activeChild = null;
        if (code === 0) resolvePromise();
        else reject(removalGuard ?? new Error(errorOutput.trim() || `导入进程退出，代码 ${String(code)}`));
      });
    });
  }

  private assertNotClosing(): void {
    if (this.closing) throw new Error("Import worker is shutting down");
  }

  private publicJob(job: MutableImportJob): ImportJobResponse {
    const removalGuard = job.status === "failed"
      ? ImportRemovalGuardError.fromPayload(job.removalGuard) : null;
    const publicError = job.error === null || job.error === undefined
      ? job.error
      : removalGuard?.userMessage ?? PUBLIC_IMPORT_FAILURE_ERROR;
    return {
      id: job.id,
      ...(job.sourceId === undefined ? {} : { sourceId: job.sourceId }),
      status: job.status,
      phase: job.phase,
      message: job.message,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: publicError
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
          value.error = PUBLIC_IMPORT_FAILURE_ERROR;
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
