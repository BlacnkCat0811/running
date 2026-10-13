import { RecomputeJobRepository } from "@rai/storage-sqlite";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { TaskAdmission } from "./task-admission.js";
import { createWriteLeaseServer, LEASE_WORDS } from "./write-lease.js";
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
    // 🔴 **不再在 spawn 之前取写许可**（PR4 §3.2 / §3.2.1，A11）。
    // 从前这里 `admission.acquire()` 一直持到整轮 drain 结束：spawn 线程要 ~2.5 s、
    // 分析 CPU 要几秒到几分钟，这段时间里**每个写路由都拿到 409**。
    // 现在许可只在 worker 线程的**短写窗口**内被持有：授权由 `createWriteLeaseServer`
    // 在 `runOneInWorkerThread` 的生命周期内完成（见那里），窗口之间的让路点是
    // pipeline 里的 `gate.yieldIfStale()`。
    this.scheduled = false;
    this.running = true;
    try {
      // Spawning a worker thread re-registers `tsx` from scratch: ~2.5 s measured on
      // this machine. 空队列仍然早退（不 spawn），否则拆锁会把空转 spawn 2.5 s 重新引入。
      if (!this.hasPendingJob()) return;
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
      this.running = false;
      if (!this.closing && this.scheduled) {
        const retryDelay = Math.min(1000, 20 * (2 ** this.consecutiveFailures));
        this.queueDrain(retryDelay);
      }
    }
  }

  /** True when a queued or claimed task exists; an idle drain must not spawn a thread. */
  private hasPendingJob(): boolean {
    if (!existsSync(this.databasePath)) return false;
    return this.withJobRepository((jobs) => jobs.hasPending());
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

  private withJobRepository<T>(action: (jobs: RecomputeJobRepository) => T): T {
    const database = new DatabaseSync(this.databasePath);
    applyBusyTimeout(database, 2_000);
    try {
      return action(new RecomputeJobRepository(database));
    } finally {
      database.close();
    }
  }

  private runOneInWorkerThread(): Promise<boolean> {
    return new Promise((resolvePromise, reject) => {
      // 写租约的共享内存（PR4 §3.2.1）：worker 线程请求、主线程授权。
      // 缓冲区随线程创建/销毁，**不跨轮复用** —— 否则上一轮的残留请求（例如线程被杀时）
      // 会让下一轮以为"许可已经被授出去了"。
      const admission = this.admission;
      const buffer = admission
        ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * LEASE_WORDS)
        : null;
      const lease = admission && buffer ? createWriteLeaseServer(admission, new Int32Array(buffer)) : null;
      const worker = new Worker(new URL("./recompute-worker-bootstrap.mjs", import.meta.url), {
        workerData: { databasePath: this.databasePath, ...(buffer === null ? {} : { lease: buffer }) }
      });
      this.activeWorker = worker;
      let result: boolean | null = null;
      let workerError: Error | null = null;
      const finish = (): void => {
        // 🔴 线程退出（含崩溃）必须释放租约，否则写路由会永久 409。
        lease?.dispose();
      };
      worker.once("message", (message: { ran?: boolean }) => {
        result = message.ran === true;
      });
      worker.once("error", (error) => {
        workerError = error;
      });
      worker.once("exit", (code) => {
        finish();
        if (this.activeWorker === worker) this.activeWorker = null;
        if (workerError) reject(workerError);
        else if (code !== 0 && !this.closing) reject(new Error(`Recompute worker thread exited with code ${code}`));
        else resolvePromise(result ?? false);
      });
    });
  }
}

