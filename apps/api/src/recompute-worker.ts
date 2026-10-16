import { RecomputeJobRepository } from "@rai/storage-sqlite";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { TaskAdmission } from "./task-admission.js";
import { createWriteLeaseServer, LEASE_WORDS, type WriteLeaseServer, type WriteLeaseStats } from "./write-lease.js";
import type { RecomputeRoundMessage, RecomputeRoundReply } from "./recompute-thread.js";
const applyBusyTimeout = (database: DatabaseSync, milliseconds = 5000): void => { database.exec(`PRAGMA busy_timeout = ${milliseconds}`); };

/** 可重试失败（写许可等待超时）之后重新调度的最小间隔：别把队列打成忙等。 */
const REQUEUE_BACKOFF_MS = 250;

/** 一次 worker 线程执行的结局：跑没跑、以及任务是否被**重排**（可重试失败）。 */
interface WorkerRunOutcome {
  ran: boolean;
  requeued: boolean;
  lease: WriteLeaseStats | null;
}

/** 线程回报的两种结局：跑完一轮（含"这轮没任务"），或这一轮抛错。 */
type RecomputeWorkerReply = RecomputeRoundReply | { kind: "round-failed"; round: number; error: string };

/** 在飞的一轮（常驻线程一次只跑一轮：`drain()` 是串行的）。 */
interface PendingRound {
  round: number;
  resolve: (outcome: WorkerRunOutcome) => void;
  reject: (error: Error) => void;
  /** 本轮的写许可授予方；轮次结束（含崩溃）必须 dispose，否则写路由永久 409。 */
  lease: WriteLeaseServer | null;
}

/**
 * 常驻分析线程的句柄（WP-41 / O12 第二阶段）。
 *
 * 从前"一轮一条线程"：每轮重新注册 tsx、重新加载分析依赖链、重新打开连接。现在线程跨轮
 * 复用，代价是**必须证明跨轮不串**：连接每轮重开（`recompute-thread.ts`）、写许可共享内存
 * 每轮新分配、数据库目标（`dev:ino`）每轮重查。
 */
interface ResidentRecomputeWorker {
  thread: Worker;
  /** 线程内 tsx 注册 + 模块加载完成（第一条 `ready` 消息）。 */
  ready: Promise<void>;
  startError: Error | null;
  retired: boolean;
  /** 轮次序号：线程常驻 ⇒ 回复必须按轮次对上，不能凭"收到一条消息"就当成当前这轮。 */
  round: number;
  pending: PendingRound | null;
  /**
   * 当前安装着的 `message` 监听器 —— **只在有轮次在飞时存在**。
   *
   * 🔴 为什么监听器要跟着轮次装卸：`Worker` 上的 `message` 监听器会引用住 `MessagePort`，
   * 即使 `unref()` 过也一样（Node v22 实测：只 `unref()` 进程仍不退出）⇒ 空闲的常驻线程
   * 会把整个进程钉在事件循环里。装上/卸下之后语义正好是想要的：**有轮次在飞 ⇒ 保活进程；
   * 空闲 ⇒ 不是进程存活的原因**。
   */
  listener: ((message: RecomputeWorkerReply) => void) | null;
}

export class RecomputeWorker {
  private scheduled = false;
  private running = false;
  private consecutiveFailures = 0;
  private closing = false;
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private activeWorker: Worker | null = null;
  /** 常驻分析线程：懒创建、跨轮复用、崩溃/退出后替换。 */
  private resident: ResidentRecomputeWorker | null = null;
  private readonly workerStats = { started: 0, rounds: 0, retired: 0 };
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
    // 🔴 常驻线程必须**显式**收掉：从前"一轮一条线程"时它跑完就结束了，常驻之后没有任何
    // 别的路径会回收它。`closing` 已在上面置位 ⇒ 退出处理器把未决轮次按"这一轮没跑"结算
    // （关闭不是任务的失败面），同时 dispose 租约。
    const resident = this.resident;
    if (resident) await resident.thread.terminate();
    else await this.activeWorker?.terminate();
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
    return this.runOneInResidentThread();
  }

  /**
   * 观测面：线程启动次数 / 跑过的轮数 / 因崩溃或失败被替换的次数。
   *
   * 🔴 为什么要有它：`apps/api/test/recompute-worker.test.ts` 从前用
   * `runOneInWorkerThread` 的**调用次数**证明"空队列不起线程"。线程常驻之后那个数字不再是
   * "起了几条线程"（同一条线程可以跑很多轮），所以判据换成：调用次数 = 调度的轮数，
   * 而**真正起线程**的次数由这里数出来 —— "20 轮 1 条线程"是可以在测试里直接断言的。
   */
  workerStartupStats(): { started: number; rounds: number; retired: number } {
    return { ...this.workerStats };
  }

  /**
   * 惰性创建常驻分析线程。
   *
   * ⛔ 空闲时**不**创建：`drain()` 的 `hasPendingJob()` 早退在调用本方法之前，所以
   * "空队列 ⇒ 零线程"这条纪律原样保留（`recompute-worker.test.ts` 用调用计数钉住它）。
   *
   * ⚠️ `unref()` + 监听器随轮次装卸：常驻线程**不得单独把进程留在事件循环里**。
   * 线程从"一轮一条"变成常驻之后，任何"创建它的对象没被收掉"的路径（例如某条测试提前
   * 抛错、跳过了 `close()`）都会让进程永远退不出去 —— 那是拿资源泄漏换启动成本。
   * 而 `unref()` **单独并不够**：`message` 监听器会引用住 `MessagePort`（Node v22 实测，
   * 只 `unref()` 进程照样不退出），所以监听器跟着轮次装上、结算时卸下（见
   * {@link armResidentListener} / {@link disarmResidentListener}）。语义因此正好是想要的：
   * 有轮次在飞 ⇒ 保活；空闲 ⇒ 常驻线程不是进程存活的原因。
   */
  private ensureResidentWorker(): ResidentRecomputeWorker {
    const existing = this.resident;
    if (existing && !existing.retired) return existing;
    const thread = new Worker(new URL("./recompute-worker-bootstrap.mjs", import.meta.url));
    thread.unref();
    const resident: ResidentRecomputeWorker = {
      thread, ready: Promise.resolve(), startError: null, retired: false, round: 0, pending: null, listener: null
    };
    this.resident = resident;
    this.workerStats.started += 1;
    resident.ready = new Promise<void>((resolveReady, rejectReady) => {
      thread.once("message", (message: { kind?: string }) => {
        if (message?.kind === "ready") resolveReady();
      });
      thread.once("error", (error: Error) => {
        resident.startError = error;
        rejectReady(error);
      });
    });
    // 🔴 崩溃必须（a）释放租约（否则写路由永久 409）、（b）按轮次 reject 或按关闭语义结算、
    // （c）把线程标记为不可复用 —— 下一次调度会拿到一条**新**线程。
    thread.once("error", (error: Error) => {
      const pending = this.retireResidentWorker(resident);
      pending?.reject(error);
    });
    thread.once("exit", (code: number) => {
      const pending = this.retireResidentWorker(resident);
      if (!pending) return;
      if (code !== 0 && !this.closing) {
        pending.reject(new Error(`Recompute worker thread exited with code ${code}`));
        return;
      }
      // 关闭时的退出、以及正常退出：这一轮"没跑"，不是失败面。
      pending.resolve({ ran: false, requeued: false, lease: null });
    });
    return resident;
  }

  /** 装上轮次监听器（并把线程 ref 回事件循环）：只在**投递轮次之前**调用。 */
  private armResidentListener(resident: ResidentRecomputeWorker): void {
    if (resident.listener) return;
    resident.thread.ref();
    const listener = (message: RecomputeWorkerReply): void => this.settleResidentRound(resident, message);
    resident.listener = listener;
    resident.thread.on("message", listener);
  }

  /** 卸下轮次监听器并 `unref()`：**没有轮次在飞时**必须调用（见 `ensureResidentWorker`）。 */
  private disarmResidentListener(resident: ResidentRecomputeWorker): void {
    const listener = resident.listener;
    if (!listener) return;
    resident.listener = null;
    resident.thread.off("message", listener);
    resident.thread.unref();
  }

  /** 一条轮次回报：按轮次结算（含 dispose 租约），并把可重试失败原样带回去。 */
  private settleResidentRound(resident: ResidentRecomputeWorker, message: RecomputeWorkerReply): void {
    const pending = resident.pending;
    if (!pending || pending.round !== message.round) {
      process.stderr.write(`Recompute worker reply for unknown round ${message.round} ignored\n`);
      return;
    }
    resident.pending = null;
    if (this.activeWorker === resident.thread) this.activeWorker = null;
    // 没有轮次在飞了 ⇒ 卸下监听器，让空闲的常驻线程不再保活进程。
    this.disarmResidentListener(resident);
    // 🔴 轮次结束（不是线程结束）就要放许可：常驻线程在两轮之间**不持有**写许可，
    // 否则"分析线程常驻"会变成"写许可常驻" —— 那正是 A11/O07 要消灭的形态。
    pending.lease?.dispose();
    if (message.kind === "round-failed") {
      pending.reject(new Error(`${message.error} (recompute round ${message.round})`));
      return;
    }
    if (message.targetChanged) {
      process.stderr.write(
        "Recompute worker: database target changed between rounds "
        + `(${message.targetKey}); connections were reopened from scratch\n`
      );
    }
    pending.resolve({ ran: message.ran, requeued: message.requeued, lease: message.lease });
  }

  /** 线程作废：dispose 租约、交出在飞轮次、终止线程。可重入（第一次生效）。 */
  private retireResidentWorker(resident: ResidentRecomputeWorker): PendingRound | null {
    if (resident.retired) return null;
    resident.retired = true;
    if (this.resident === resident) this.resident = null;
    if (this.activeWorker === resident.thread) this.activeWorker = null;
    this.workerStats.retired += 1;
    const pending = resident.pending;
    resident.pending = null;
    pending?.lease?.dispose();
    this.disarmResidentListener(resident);
    void resident.thread.terminate().catch(() => { /* 线程可能已经退出 */ });
    return pending;
  }

  /**
   * 常驻线程里跑**一轮**分析。
   *
   * 与"一轮一条线程"的差别只有生命周期：注册/加载只付一次；每轮的连接、许可缓冲区与
   * 数据库目标都重新来过（见 `recompute-thread.ts` 的头注释）。
   */
  private async runOneInResidentThread(): Promise<WorkerRunOutcome> {
    const resident = this.ensureResidentWorker();
    await resident.ready;
    if (resident.retired) {
      throw new Error(`Recompute worker unavailable: ${resident.startError?.message ?? "thread retired"}`);
    }
    // 写租约的共享内存（PR4 §3.2.1）：worker 线程请求、主线程授权。
    // 🔴 **每轮**新分配（而不是随线程创建/销毁）：常驻线程复用的只是执行体，共享内存不跨轮
    // —— 上一轮残留的请求（例如线程被杀时的半开请求）会让下一轮以为"许可已经授出去了"。
    const admission = this.admission;
    const buffer = admission
      ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * LEASE_WORDS)
      : null;
    const lease = admission && buffer ? createWriteLeaseServer(admission, new Int32Array(buffer)) : null;
    resident.round += 1;
    this.workerStats.rounds += 1;
    const round = resident.round;
    const message: RecomputeRoundMessage = {
      kind: "round", round, databasePath: this.databasePath,
      ...(buffer === null ? {} : { lease: buffer })
    };
    this.activeWorker = resident.thread;
    return new Promise<WorkerRunOutcome>((resolvePromise, reject) => {
      resident.pending = { round, resolve: resolvePromise, reject, lease };
      // 🔴 先装监听器再投递：轮次在飞 ⇒ 线程 ref 回来（进程保活、回复不丢）；
      // 轮次结算时卸下（见 `disarmResidentListener`）。
      this.armResidentListener(resident);
      resident.thread.postMessage(message);
    });
  }
}

