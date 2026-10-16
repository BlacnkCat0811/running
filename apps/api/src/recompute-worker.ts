import { RecomputeJobRepository } from "@rai/storage-sqlite";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { TaskAdmission } from "./task-admission.js";
import { createWriteLeaseServer, LEASE_WORDS, type WriteLeaseStats } from "./write-lease.js";
const applyBusyTimeout = (database: DatabaseSync, milliseconds = 5000): void => { database.exec(`PRAGMA busy_timeout = ${milliseconds}`); };

/** 可重试失败（写许可等待超时）之后重新调度的最小间隔：别把队列打成忙等。 */
const REQUEUE_BACKOFF_MS = 250;

/** 一次 worker 线程执行的结局：跑没跑、以及任务是否被**重排**（可重试失败）。 */
interface WorkerRunOutcome {
  ran: boolean;
  requeued: boolean;
  lease: WriteLeaseStats | null;
}

export class RecomputeWorker {
  private scheduled = false;
  private running = false;
  private consecutiveFailures = 0;
  private closing = false;
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private activeWorker: Worker | null = null;
  /** 上一轮线程回报的租约统计（诊断面：`/v1/performance`）。 */
  private lastLeaseStats: WriteLeaseStats | null = null;
  /** 上一轮是因为可重试失败被重排的 —— 用退避而不是立刻重跑。 */
  private lastRunRequeued = false;

  constructor(
    private readonly databasePath: string,
    private readonly onDatabaseError: (error: unknown) => void = () => {},
    private readonly admission?: TaskAdmission
  ) {}

  get isRunning(): boolean {
    return this.running || this.scheduled;
  }

  /**
   * 写租约的最近一轮统计（O07/O08 的观测面：windows / waitMs / yields / timeouts /
   * transactions / slowTransactions）。
   *
   * 🔴 为什么必须暴露出来：`timeouts` 非 0 就是异常（可重试失败），而此前 worker 线程
   * **回传了却被丢弃**（`recompute-thread.ts` post、`recompute-worker.ts` 只读 `ran`）——
   * 一个"看得见才算数"的诊断项，读不到就等于没有。
   */
  leaseStats(): WriteLeaseStats | null {
    return this.lastLeaseStats === null ? null : { ...this.lastLeaseStats };
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

  /**
   * 🔴 兜底巡检：**只在确有待处理任务时**才唤醒；空闲时只做一次只读查询，不 spawn 线程。
   *
   * 为什么需要它（2026-10-13 线上首爆）：`recompute_jobs` 的**登记方**与**唤醒方**在不同的
   * 执行体里 —— 直连车道在 worker 线程的主库事务里 `enqueue`（`direct-sync-ingest.ts`），
   * 而 `schedule()` 只有主线程的少数几个入口会调。漏掉那一次唤醒，任务就永远停在 `queued`：
   * `isDatabaseWriteBusy()`（`server.ts`）把 `queued` 算作忙 ⇒ **每个写端点都 409**，
   * 而被 409 的请求走不到它后面的 `schedule()` ⇒ 这条链没有自愈路径。
   *
   * 巡检不绕过任何判据、不改变失败语义 —— 它只是把「该被唤醒」从「依赖某次调用记得」
   * 变成「最多等一个周期」。
   */
  wakeIfPending(): void {
    if (this.closing) return;
    let pending: boolean;
    try {
      pending = this.hasPendingJob();
    } catch (error) {
      // 库暂不可用（迁移中 / 恢复中）不是「没有任务」，但也不是巡检该处理的事：
      // 报给既有的数据库错误观测通道，库恢复后由既有入口重新调度。
      this.onDatabaseError(error);
      return;
    }
    if (pending) this.schedule();
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
        const outcome = await this.runOneInWorkerThread();
        this.lastLeaseStats = outcome.lease;
        if (outcome.lease && outcome.lease.timeouts > 0) {
          // 可重试失败必须**看得见**：任务会回到队列而不是终态失败，静默重排会让人
          // 以为"分析跑得慢"，实际是许可一直拿不到。
          process.stderr.write(
            `Recompute lease timed out ${outcome.lease.timeouts} time(s); ` +
            `windows=${outcome.lease.windows} waitMs=${outcome.lease.waitMs} yields=${outcome.lease.yields}\n`
          );
        }
        this.lastRunRequeued = outcome.requeued;
        if (outcome.ran) this.consecutiveFailures = 0;
        if (!outcome.ran) break;
        // 被重排的任务不要立刻重跑：退避一轮，让持有许可的那些写先走完。
        if (outcome.requeued) { this.scheduled = true; break; }
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
        // 重排过的任务用固定退避；普通失败仍按连续失败次数指数退避。
        const retryDelay = this.lastRunRequeued
          ? REQUEUE_BACKOFF_MS
          : Math.min(1000, 20 * (2 ** this.consecutiveFailures));
        this.lastRunRequeued = false;
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

  private runOneInWorkerThread(): Promise<WorkerRunOutcome> {
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
      let outcome: WorkerRunOutcome | null = null;
      let workerError: Error | null = null;
      const finish = (): void => {
        // 🔴 线程退出（含崩溃）必须释放租约，否则写路由会永久 409。
        lease?.dispose();
      };
      worker.once("message", (message: { ran?: boolean; requeued?: boolean; lease?: WriteLeaseStats | null }) => {
        outcome = {
          ran: message.ran === true,
          requeued: message.requeued === true,
          lease: message.lease ?? null
        };
      });
      worker.once("error", (error) => {
        workerError = error;
      });
      worker.once("exit", (code) => {
        finish();
        if (this.activeWorker === worker) this.activeWorker = null;
        if (workerError) reject(workerError);
        else if (code !== 0 && !this.closing) reject(new Error(`Recompute worker thread exited with code ${code}`));
        else resolvePromise(outcome ?? { ran: false, requeued: false, lease: null });
      });
    });
  }
}

