import { PREDICTION_MODEL_LEASE_TIMEOUT_MS, PredictionModelService, type PredictionModelTrainer } from "@rai/application";
import type { PredictionModelTrainingRequest, PredictionModelTrainingResult } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskAdmission } from "./task-admission.js";
import { terminateProcessTree } from "./worker-process.js";
const applyBusyTimeout = (database: DatabaseSync, milliseconds = 5000): void => { database.exec(`PRAGMA busy_timeout = ${milliseconds}`); };
export const predictionModelWorkerRetryDelay = (consecutiveFailures: number): number =>
  Math.min(30_000, 1_000 * (2 ** Math.max(0, consecutiveFailures - 1)));

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
        "--scope",
        request.scope ?? "population",
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
    private readonly onDatabaseError: (error: unknown) => void = () => {},
    private readonly admission?: TaskAdmission
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
    this.admission?.withdraw();
    this.scheduled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.activeAbortController?.abort();
    await this.drainPromise;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const release = this.admission ? this.admission.acquire() : () => {};
    if (!release) { this.queueDrain(250); return; }
    this.scheduled = false;
    this.running = true;
    let leasedRunRemains = false;
    try {
      while (!this.closing && existsSync(this.databasePath)) {
        const store = await RaiDatabase.open(this.databasePath, { migrationPolicy: "refuse" });
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
          const shutdownStore = await RaiDatabase.open(this.databasePath, { migrationPolicy: "refuse" });
          try {
            this.service(shutdownStore).releaseLeaseForShutdown(runId, workerToken);
          } finally {
            shutdownStore.close();
          }
          break;
        }
        await this.execute(runId, workerToken);
        if (this.admission) { this.scheduled = true; break; }
      }
    } finally {
      release();
      this.running = false;
      if (!this.closing && this.scheduled) this.queueDrain(20);
      else if (!this.closing && leasedRunRemains) {
        this.queueDrain(PREDICTION_MODEL_LEASE_TIMEOUT_MS + 250);
      }
    }
  }

  private async execute(runId: string, workerToken: string): Promise<void> {
    const readStore = await RaiDatabase.open(this.databasePath, { migrationPolicy: "refuse" });
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
      const shutdownStore = await RaiDatabase.open(this.databasePath, { migrationPolicy: "refuse" });
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
      const shutdownStore = await RaiDatabase.open(this.databasePath, { migrationPolicy: "refuse" });
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
        scope: run.scope,
        databasePath: this.databasePath,
        artifactDirectory
      }, abortController.signal);
      if (this.closing) throw new Error("prediction_training_shutdown");
      const store = await RaiDatabase.open(this.databasePath, { migrationPolicy: "refuse" });
      try {
        const service = this.service(store);
        if (this.closing) service.releaseLeaseForShutdown(runId, workerToken);
        else service.completeAndActivate(runId, result, workerToken);
      } finally {
        store.close();
      }
    } catch (error) {
      const store = await RaiDatabase.open(this.databasePath, { migrationPolicy: "refuse" });
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
