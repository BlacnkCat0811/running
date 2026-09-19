import { RecomputeJobRepository } from "@rai/storage-sqlite";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { TaskAdmission } from "./task-admission.js";
const applyBusyTimeout = (database: DatabaseSync, milliseconds = 5000): void => { database.exec(`PRAGMA busy_timeout = ${milliseconds}`); };

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
    private readonly onDatabaseError: (error: unknown) => void = () => {},
    private readonly admission?: TaskAdmission
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
    this.admission?.withdraw();
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
    const release = this.admission ? this.admission.acquire() : () => {};
    if (!release) {
      this.queueDrain(250);
      return;
    }
    this.scheduled = false;
    this.running = true;
    try {
      this.recoverInterruptedJobs();
      while (!this.closing && existsSync(this.databasePath)) {
        const ran = await this.runOneInWorkerThread();
        if (ran) this.consecutiveFailures = 0;
        if (!ran) break;
        // Yield after each job so another executor cannot starve.
        if (this.admission) { this.scheduled = true; break; }
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
      release();
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

