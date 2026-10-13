import type { TaskAdmission } from "./task-admission.js";

/**
 * 分析侧的**短写租约**（`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §6；落地设计
 * `docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md` §3.2 / §3.2.1）。
 *
 * 问题：分析跑在 **worker 线程**里（`recompute-thread.ts`），而"单写者"许可
 * （`MutationCoordinator` 的 `activeOperation`）是**主线程**的内存状态。今天由
 * `RecomputeWorker.drain()` 在 spawn **之前**取、整轮结束才放 —— 于是 CPU 计算的每一毫秒都
 * 持着写许可，同一时刻的任何写路由都拿到 `409 mutation_conflict`（A11 要消掉的就是这个）。
 *
 * 跨线程只能靠共享内存：`parentPort` 是异步的，而 pipeline 是**同步**的；`Atomics.wait` 在
 * worker 线程合法、在 Node 主线程非法。所以协议是"worker 请求、主线程授权"。
 *
 * 🔴 协议必须是**序列号**，不能是标志位：朴素标志位版本在第一次授权之后 worker 会"跑飞"
 * —— 后续窗口看到 `GRANT` 仍为 1 就直接通过，互斥其实已经失效（2026-10-13 实测复现，
 * 见 `scripts/measure-write-lease.mjs` 头注释）。序列号版本：`GRANT === 本次 REQUEST` 才算授权。
 *
 * ⚠️ 成本实测：**每窗口约 7 ms**（200 窗口 1415 ms，本机）。所以调用方**不得**逐语句取租约；
 * 必须按**有界阶段窗口**取，并在长计算里用 {@link WriteLeaseClient.yieldIfStale} 让路。
 *
 * 三条失败模式的处理（每一条都有对应用例）：
 * - worker 崩溃/退出：主线程**必须** `dispose()`，否则租约泄漏、写路由永久 409；
 * - 主线程没能及时授权：worker 等到 `timeoutMs` 后**失败开放**（记录诊断后继续写），
 *   而不是把整条分析队列挂死；
 * - 让路：`yieldIfStale` 释放后**立刻重取**，而 `TaskAdmissionScheduler` 的 FIFO 保证
 *   已经在等的接收方先拿到许可（"接收优先"，不是无限提高 `busy_timeout` 去抢）。
 */

/** 共享槽位：[0] = REQUEST（本次窗口的序号，0 = 无请求），[1] = GRANT（已授权的序号，0 = 未授权）。 */
export const LEASE_REQUEST = 0;
export const LEASE_GRANT = 1;
export const LEASE_WORDS = 2;

/** 默认等待上界：超过它就失败开放（继续写 + 打诊断），避免分析队列被挂死。 */
export const LEASE_DEFAULT_TIMEOUT_MS = 30_000;
/** 让路的默认时间预算：持有超过它就释放并重取，把"接收优先"的等待上界压到这一段。 */
export const LEASE_DEFAULT_YIELD_MS = 50;
/** 主线程轮询间隔。 */
export const LEASE_POLL_MS = 1;

export interface WriteLeaseStats {
  /** 取到租约的窗口数。 */
  windows: number;
  /** 等待授权时经过的毫秒数（诊断用：分析被接收方让路拖慢了多少）。 */
  waitMs: number;
  /** 让路次数。 */
  yields: number;
  /** 等待超时（失败开放）的次数。**非 0 就是异常**，必须能在诊断里看见。 */
  timeouts: number;
}

export interface WriteLeaseClient {
  /** 在一个写窗口内持有租约；`fn` 抛错也会释放（`finally`）。可嵌套（只取一次）。 */
  scope<T>(fn: () => T): T;
  /** 长计算里的让路点：持有超过 `maxHoldMs` 就释放+重取（FIFO 让等待中的接收方先走）。 */
  yieldIfStale(maxHoldMs?: number): void;
  stats(): WriteLeaseStats;
}

/**
 * worker 线程侧的客户端。**同步**：pipeline 是同步的，所以这里不能有 `await`。
 */
export function createWriteLeaseClient(
  words: Int32Array,
  options: { timeoutMs?: number; onTimeout?: (message: string) => void } = {}
): WriteLeaseClient {
  const timeoutMs = options.timeoutMs ?? LEASE_DEFAULT_TIMEOUT_MS;
  const onTimeout = options.onTimeout ?? ((message: string) => process.stderr.write(`${message}\n`));
  let sequence = 0;
  let depth = 0;
  let heldSince = 0;
  let waiting = false;
  // 当前持有的窗口序号（0 = 未持有）。让路时用它把持有状态停掉再重取。
  let holding = 0;
  const stats: WriteLeaseStats = { windows: 0, waitMs: 0, yields: 0, timeouts: 0 };

  const acquire = (): void => {
    sequence += 1;
    Atomics.store(words, LEASE_REQUEST, sequence);
    // 🔴 必须 notify：主线程的授权循环挂在 REQUEST 上等（事件驱动，不轮询）。
    // 漏掉这一次唤醒 ⇒ 每个窗口都要等到超时才失败开放（实测：整轮分析变成几十秒的停顿）。
    Atomics.notify(words, LEASE_REQUEST);
    holding = sequence;
    const started = Date.now();
    const deadline = started + timeoutMs;
    waiting = true;
    for (;;) {
      const grant = Atomics.load(words, LEASE_GRANT);
      if (grant === sequence) break;
      if (Date.now() > deadline) {
        // 失败开放：撤回请求、记诊断、继续写。宁可让这一批少一层互斥保护，
        // 也不能把整条分析队列挂死在这里（挂死会让"接收优先"变成"谁也跑不了"）。
        Atomics.store(words, LEASE_REQUEST, 0);
        holding = 0;
        stats.timeouts += 1;
        onTimeout(
          `[write-lease] 等待写许可超过 ${timeoutMs} ms（窗口 ${sequence}），本窗口继续执行但不持许可`
        );
        break;
      }
      Atomics.wait(words, LEASE_GRANT, grant, 5);
    }
    waiting = false;
    stats.waitMs += Date.now() - started;
    stats.windows += 1;
    heldSince = Date.now();
  };

  const release = (): void => {
    if (holding === 0) return;
    holding = 0;
    Atomics.store(words, LEASE_REQUEST, 0);
    Atomics.notify(words, LEASE_REQUEST);
  };

  return {
    scope<T>(fn: () => T): T {
      if (depth === 0) acquire();
      depth += 1;
      try {
        return fn();
      } finally {
        depth -= 1;
        if (depth === 0) release();
      }
    },
    yieldIfStale(maxHoldMs = LEASE_DEFAULT_YIELD_MS): void {
      if (holding === 0 || waiting) return;
      if (Date.now() - heldSince < maxHoldMs) return;
      const resumed = depth;
      depth = 0;
      release();
      stats.yields += 1;
      if (resumed > 0) {
        depth = resumed;
        acquire();
      }
    },
    stats(): WriteLeaseStats {
      return { ...stats };
    }
  };
}

export interface WriteLeaseServerStats {
  /** 授权次数。 */
  grants: number;
  /** 释放次数（含让路、结束与 dispose）。 */
  releases: number;
  /** 想授权但许可被别人占着、回到等待的次数（诊断用）。回调 = 真的发生让路/争用。 */
  busyWaits: number;
}

export interface WriteLeaseServer {
  /** 释放并停止（worker 退出、崩溃、`close()` 都必须调用）。 */
  dispose(): void;
  stats(): WriteLeaseServerStats;
}

/**
 * 主线程侧的授予方：把共享内存上的请求翻译成 `TaskAdmission` 的取/放。
 *
 * 🔴 **事件驱动，不轮询**：主线程用 `Atomics.waitAsync`（它在主线程合法，`Atomics.wait` 不合法）
 * 挂在 REQUEST 槽上，worker 每次请求/结束都 `notify` 一次。
 * 这不是微优化：轮询版（`setTimeout(1)`）实测**每窗口 7.1 ms**
 * （`scripts/measure-write-lease.mjs`），事件驱动版实测**每窗口 0.070 ms**（400 窗口 28 ms）。
 * 差 100 倍决定了"能不能逐语句取租约" —— 而"写锁只覆盖短 SQL 事务"正是 A11 的判据。
 *
 * ⚠️ 它**不**自己持有许可 —— 取到的释放函数必须原样交回 `TaskAdmissionScheduler`，
 * 否则 FIFO 与 `controls`（取消窗口）的语义会漂移。
 */
export function createWriteLeaseServer(
  admission: TaskAdmission,
  words: Int32Array,
  options: { onError?: (error: unknown) => void } = {}
): WriteLeaseServer {
  const onError = options.onError ?? ((error: unknown) => {
    process.stderr.write(`[write-lease] 授权循环异常：${String(error)}\n`);
  });
  const stats: WriteLeaseServerStats = { grants: 0, releases: 0, busyWaits: 0 };
  let releaseAdmission: (() => void) | null = null;
  let grantedSequence = 0;
  let disposed = false;

  const releaseHeld = (): void => {
    if (grantedSequence !== 0) Atomics.store(words, LEASE_GRANT, 0);
    if (releaseAdmission) {
      releaseAdmission();
      releaseAdmission = null;
      stats.releases += 1;
    }
    grantedSequence = 0;
  };

  /**
   * 走一步状态机。返回值告诉调用方**要不要立刻重试**：
   * `"pending"` = 有请求但许可被别人占着（必须重试，否则 worker 会一直等到超时）、
   * `"idle"` = 可以挂起等下一次 notify。
   */
  const step = (): "idle" | "pending" => {
    if (disposed) return "idle";
    const request = Atomics.load(words, LEASE_REQUEST);
    const grant = Atomics.load(words, LEASE_GRANT);
    if (grant !== 0 && request !== grant) {
      // worker 让路或结束：立刻把许可交回去，让排队中的接收方先走。
      releaseHeld();
      return "pending";
    }
    if (request !== 0 && grant === 0) {
      const release = admission.acquire();
      if (!release) {
        // 🔴 这里**不能**就此收工：`TaskAdmissionScheduler.acquire()` 是"试一次"，返回 null
        // 只说明此刻许可被别人拿着或 FIFO 还没轮到 —— 而 worker 正阻塞在共享内存上等我们。
        // 不重试就是死锁（2026-10-13 实测：整轮分析卡到 120s 超时）。
        stats.busyWaits += 1;
        return "pending";
      }
      releaseAdmission = release;
      grantedSequence = request;
      Atomics.store(words, LEASE_GRANT, request);
      Atomics.notify(words, LEASE_GRANT);
      stats.grants += 1;
      return "pending";
    }
    if (request !== 0 && grant === request) {
      // 已授权、worker 还在写：补一次 notify 是廉价安全网（它可能刚进入等待）。
      Atomics.notify(words, LEASE_GRANT);
    }
    return "idle";
  };

  const loop = async (): Promise<void> => {
    while (!disposed) {
      try {
        if (step() === "pending") {
          // 有未满足的请求：短睡重试（只在**有请求**时醒来，空闲时不烧 CPU）。
          await new Promise((done) => setTimeout(done, 5));
          continue;
        }
        const request = Atomics.load(words, LEASE_REQUEST);
        // 挂起等下一次请求/结束。值已经变了 ⇒ waitAsync 立刻返回 not-equal，回到循环重新判定
        // （所以"错过一次 notify"不会卡死：状态永远在每轮开头重读）。
        const waiter = waitAsync(words, LEASE_REQUEST, request);
        if (waiter.async) await waiter.value;
        else await new Promise((done) => setImmediate(done));
      } catch (error) {
        onError(error);
        await new Promise((done) => setTimeout(done, 25));
      }
    }
  };
  void loop();

  return {
    dispose(): void {
      disposed = true;
      releaseHeld();
      Atomics.store(words, LEASE_REQUEST, 0);
      // 唤醒可能正在等待的授权循环，让它看到 disposed 退出。
      Atomics.notify(words, LEASE_REQUEST);
    },
    stats(): WriteLeaseServerStats {
      return { ...stats };
    }
  };
}

/**
 * 把一条 `DatabaseSync` 连接包成"每个写语句都经过租约闸门"的代理。
 *
 * 为什么用代理而不是在 pipeline 里逐处包窗口：**结构性完整**。
 * 逐处包是"我包了这几处"，漏一处就是"有写不在许可内"，而且只能在代码评审里靠眼睛发现；
 * 代理是"经过这条连接的所有写都在许可内"，漏写面收敛到**连接**这一个可枚举的点
 * （分析只允许有一条连接，`AnalysisStore.database` 就是这个代理）。
 *
 * 判据：`prepare(...).run(...)`（写）与 `exec(...)`（事务控制/DDL）取租约；
 * `get`/`all`/`iterate`（读）**不取** —— 读不需要写许可（§6 的许可表）。
 */
export function withWriteGate<T extends object>(database: T, gate: WriteGateClientLike): T {
  const wrapStatement = (statement: object): object => new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "run") {
        return (...args: unknown[]) =>
          gate.scope(() => (value as (...inner: unknown[]) => unknown).apply(target, args));
      }
      return (...args: unknown[]) => (value as (...inner: unknown[]) => unknown).apply(target, args);
    }
  });
  const gated = {
    scope: gate.scope,
    yieldIfStale: gate.yieldIfStale
  };
  return new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "prepare") {
        return (...args: unknown[]) =>
          wrapStatement((value as (...inner: unknown[]) => object).apply(target, args));
      }
      if (property === "exec") {
        return (...args: unknown[]) =>
          gated.scope(() => (value as (...inner: unknown[]) => unknown).apply(target, args));
      }
      return (...args: unknown[]) => (value as (...inner: unknown[]) => unknown).apply(target, args);
    }
  }) as T;
}

/**
 * `Atomics.waitAsync` 的本地类型（**不是为了兼容**：Node 24 上它一直存在）。
 * 仓库的编译目标 lib 还没到 ES2024，直接写会报 TS2550；这里只补形状，不改全局 lib。
 */
const waitAsync = (Atomics as unknown as {
  waitAsync(words: Int32Array, index: number, value: number): { async: boolean; value: Promise<string> | string };
}).waitAsync.bind(Atomics);

/** 闸门的最小形状（代理与 worker 客户端都满足它）。 */
export interface WriteGateClientLike {
  scope<T>(fn: () => T): T;
  yieldIfStale(maxHoldMs?: number): void;
}
