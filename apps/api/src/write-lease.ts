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
 * ## O07（2026-10-16）：许可必须覆盖**整个短事务**，不是每条语句一段
 *
 * 逐语句包 `exec`/`run` 的代理有一个结构性缺口：`BEGIN IMMEDIATE … COMMIT` 是三条独立语句，
 * 于是事务**开着**的时候许可已经交回去了 —— "许可空闲但数据库仍被锁"（`apps/api/test/write-lease.test.ts`
 * 末例在修复前精确红）。修法有两半，缺一不可：
 *
 * - {@link withWriteTransaction}：显式的"一个许可窗口 = 一个短事务"边界；
 * - `withWriteGate` 的代理**自身**按事务语句开合保留（`BEGIN` 保留、`COMMIT`/`ROLLBACK` 交还），
 *   因为有些事务控制是直接从连接上 `exec` 的（`runtime-state.ts` 还有
 *   `"PRAGMA …; BEGIN IMMEDIATE"` 这种合并串）。
 *
 * 保留/交还走 {@link WriteGateClientLike.hold}：`scope` 是"进了又出"，`hold` 是"拿着不放"。
 * 老 gate 只实现 `scope` 时仍可工作（回落逐语句），但**生产 gate 必须实现 hold** ——
 * 那条由结构测试钉住，不靠评审记得。
 *
 * 三条失败模式的处理（每一条都有对应用例）：
 * - worker 崩溃/退出：主线程**必须** `dispose()`，否则租约泄漏、写路由永久 409；
 * - 主线程没能及时授权：worker 等到 `timeoutMs` 后**撤回请求并抛出可重试错误**
 *   （{@link WriteLeaseTimeoutError}）—— ⛔ 不再"失败开放"地继续写（O07 决策 D1：
 *   少一层互斥保护地写库，比这一批晚一点跑更糟）；
 * - 让路：`yieldIfStale` 释放后**立刻重取**，而 `TaskAdmissionScheduler` 的 FIFO 保证
 *   已经在等的接收方先拿到许可（"接收优先"，不是无限提高 `busy_timeout` 去抢）。
 *   ⛔ 事务开着时**绝不让路**（见下）。
 */

/** 共享槽位：[0] = REQUEST（本次窗口的序号，0 = 无请求），[1] = GRANT（已授权的序号，0 = 未授权）。 */
export const LEASE_REQUEST = 0;
export const LEASE_GRANT = 1;
export const LEASE_WORDS = 2;

/** 默认等待上界：超过它**撤回请求并抛可重试错误**（不再失败开放）。 */
export const LEASE_DEFAULT_TIMEOUT_MS = 30_000;
/** 让路的默认时间预算：持有超过它就释放并重取，把"接收优先"的等待上界压到这一段。 */
export const LEASE_DEFAULT_YIELD_MS = 50;
/** 主线程待重试时的退避间隔（有未满足请求时才醒来，空闲不烧 CPU）。 */
export const LEASE_POLL_MS = 5;
/** 授权循环自身异常后的退避。 */
export const LEASE_ERROR_BACKOFF_MS = 25;

/**
 * 可重试的调度失败：等待写许可超时。**不是**数据/逻辑错误 —— 重排一次就可能成功。
 *
 * 🔴 语义变更（O07 决策 D1，2026-10-16）：旧实现超时后"失败开放"，即记录诊断后
 * **在无许可的情况下继续写**。这条契约已被否决：数据库锁与"单写者"应用许可的边界不一致时，
 * 正确做法是这一批**不写**、把任务放回队列稍后重试，而不是让两个写者同时进库。
 * 于是 `retryable = true` 让 `RecomputeJobRepository.fail` 把任务重新排队而不是终态失败。
 */
export class WriteLeaseTimeoutError extends Error {
  /** 可重试标记：跨包按**结构**识别（`@rai/storage-sqlite` 不 import 本文件）。 */
  readonly retryable = true;
  readonly waitedMs: number;
  readonly sequence: number;

  /**
   * ⛔ 刻意**不用**参数属性（`constructor(readonly waitedMs: number)`）：本文件会被 worker
   * 线程直接 import，而那条路径可能走 Node 的 strip-only 类型剥离 ——
   * 参数属性在那里是**语法错误**（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`），
   * 现象是整支协议回归莫名其妙地起不来。赋值写在体内，两种通道都能跑。
   */
  constructor(waitedMs: number, sequence: number) {
    super(`写许可等待超过 ${waitedMs} ms（窗口 ${sequence}）：已撤回请求，本窗口不执行任何写`);
    this.name = "WriteLeaseTimeoutError";
    this.waitedMs = waitedMs;
    this.sequence = sequence;
  }
}

export interface WriteLeaseStats {
  /** 取到租约的窗口数。 */
  windows: number;
  /** 等待授权时经过的毫秒数（诊断用：分析被接收方让路拖慢了多少）。 */
  waitMs: number;
  /** 让路次数。 */
  yields: number;
  /** 等待超时（**可重试失败**）的次数。非 0 就必须能在诊断里看见。 */
  timeouts: number;
  /** 完整短事务数（O07：许可覆盖 BEGIN…COMMIT 的窗口）。 */
  transactions: number;
  /** 上述事务的累计耗时（毫秒）。分块预算（≤100 行／≈50ms）按它校准。 */
  transactionMs: number;
  /** 超过分块目标（{@link WriteLeaseStats.transactionBudgetMs}）的事务数。 */
  slowTransactions: number;
  /** 分块目标（毫秒）—— 超过即计入 `slowTransactions`，供超时 SQL 定位。 */
  transactionBudgetMs: number;
}

export interface WriteLeaseClient {
  /** 在一个写窗口内持有租约；`fn` 抛错也会释放（`finally`）。可嵌套（只取一次）。 */
  scope<T>(fn: () => T): T;
  /**
   * 拿住许可直到调用返回的释放函数被调用（可嵌套：只有最外层真的取/放）。
   *
   * 这是"许可覆盖整个短事务"的机制：{@link withWriteTransaction} 在 `BEGIN` 前 `hold()`、
   * 在 `COMMIT`/`ROLLBACK` 之后释放。⛔ 拿住期间不得执行长 CPU 或网络。
   */
  hold(): () => void;
  /** 长计算里的让路点：持有超过 `maxHoldMs` 就释放+重取（FIFO 让等待中的接收方先走）。 */
  yieldIfStale(maxHoldMs?: number): void;
  /** 记一次完整短事务的耗时（供分块预算校准）。 */
  recordTransaction(durationMs: number): void;
  stats(): WriteLeaseStats;
}

/**
 * worker 线程侧的客户端。**同步**：pipeline 是同步的，所以这里不能有 `await`。
 */
export function createWriteLeaseClient(
  words: Int32Array,
  options: {
    timeoutMs?: number;
    onTimeout?: (message: string) => void;
    transactionBudgetMs?: number;
  } = {}
): WriteLeaseClient {
  const timeoutMs = options.timeoutMs ?? LEASE_DEFAULT_TIMEOUT_MS;
  const transactionBudgetMs = options.transactionBudgetMs ?? LEASE_DEFAULT_TRANSACTION_BUDGET_MS;
  const onTimeout = options.onTimeout ?? ((message: string) => process.stderr.write(`${message}\n`));
  let sequence = 0;
  let waiting = false;
  // 当前持有的窗口序号（0 = 未持有）。让路时用它把持有状态停掉再重取。
  let holding = 0;
  let heldSince = 0;
  /**
   * 未结算的引用数：语句窗口 + 事务保留。
   *
   * 🔴 为什么不是"scope 嵌套深度"：`hold()` 拿住之后，事务里的**每条语句**仍然各走一次
   * `scope`，但那不是嵌套 —— 是同一个许可被反复复用。用引用计数才能让
   * "BEGIN 拿住 → N 条语句 → COMMIT 放开"只取/放一次许可。
   */
  let refs = 0;
  /** 开着的短事务数（`hold()` 的净层数）。让路与超时都要看它。 */
  let transactionDepth = 0;
  const stats: WriteLeaseStats = {
    windows: 0, waitMs: 0, yields: 0, timeouts: 0,
    transactions: 0, transactionMs: 0, slowTransactions: 0, transactionBudgetMs
  };

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
        // 🔴 O07 / D1：**撤回请求**，然后**抛错**。旧实现在这里"失败开放"继续写 ——
        // 那条路径让"数据库锁已被 SQLite 拿住、应用许可却是空的"变成常态。
        // 现在这一批不写：请求归零（主线程据此撤销 admission 等待位），错误可重试。
        Atomics.store(words, LEASE_REQUEST, 0);
        Atomics.notify(words, LEASE_REQUEST);
        holding = 0;
        stats.timeouts += 1;
        const message =
          `[write-lease] 等待写许可超过 ${timeoutMs} ms（窗口 ${sequence}）：已撤回请求，本窗口不写`;
        onTimeout(message);
        waiting = false;
        throw new WriteLeaseTimeoutError(timeoutMs, sequence);
      }
      Atomics.wait(words, LEASE_GRANT, grant, LEASE_POLL_MS);
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

  /** 引用计数 0→1 时取许可；取不到会把引用数留在 0（调用方的 `fn` 不会执行）。 */
  const retain = (): void => {
    if (refs === 0) acquire();
    refs += 1;
  };

  const dropRef = (): void => {
    refs -= 1;
    if (refs === 0) release();
  };

  return {
    scope<T>(fn: () => T): T {
      retain();
      try {
        return fn();
      } finally {
        dropRef();
      }
    },
    hold(): () => void {
      retain();
      transactionDepth += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        transactionDepth -= 1;
        dropRef();
      };
    },
    yieldIfStale(maxHoldMs = LEASE_DEFAULT_YIELD_MS): void {
      if (holding === 0 || waiting) return;
      // 🔴 事务开着时**绝不**让路：SQLite 事务此刻已经拿着数据库锁，交回应用许可
      // 制造出来的正是 O07 要消灭的"许可空闲但库仍被锁"。让路点是"提交当前分块之后、
      // 开始下一块之前"，不是事务中途。
      if (transactionDepth > 0) return;
      if (Date.now() - heldSince < maxHoldMs) return;
      const resumed = refs;
      refs = 0;
      release();
      stats.yields += 1;
      if (resumed > 0) {
        try {
          refs = resumed;
          acquire();
        } catch (error) {
          refs = 0;
          throw error;
        }
      }
    },
    recordTransaction(durationMs: number): void {
      stats.transactions += 1;
      stats.transactionMs += durationMs;
      if (durationMs > stats.transactionBudgetMs) stats.slowTransactions += 1;
    },
    stats(): WriteLeaseStats {
      return { ...stats };
    }
  };
}

/** 单个短事务的目标耗时上界（超出即计入 `slowTransactions`，用于定位慢 SQL）。 */
export const LEASE_DEFAULT_TRANSACTION_BUDGET_MS = 50;

export interface WriteLeaseServerStats {
  /** 授权次数。 */
  grants: number;
  /** 释放次数（含让路、结束与 dispose）。 */
  releases: number;
  /** 想授权但许可被别人占着、回到等待的次数（诊断用）。回调 = 真的发生让路/争用。 */
  busyWaits: number;
  /**
   * 撤销等待位的次数。
   *
   * 🔴 为什么必须有它：`TaskAdmissionScheduler.acquire()` 一调用就把 owner 名字放进
   * `waiting`；FIFO 判据是"队首必须是自己"。worker 超时撤回请求之后如果**不撤销**，
   * 那个名字会永远卡在队首 —— 之后**任何**其它 owner（import / HTTP）都拿不到许可，
   * 表现为永久 409。所以"请求消失"必须伴随一次 withdraw。
   */
  withdraws: number;
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
  const stats: WriteLeaseServerStats = { grants: 0, releases: 0, busyWaits: 0, withdraws: 0 };
  let releaseAdmission: (() => void) | null = null;
  let grantedSequence = 0;
  let disposed = false;
  /** 已经向 admission 排过队、但还没拿到许可（`acquire()` 返回 null）。 */
  let queuedForAdmission = false;

  const releaseHeld = (): void => {
    if (grantedSequence !== 0) Atomics.store(words, LEASE_GRANT, 0);
    if (releaseAdmission) {
      releaseAdmission();
      releaseAdmission = null;
      stats.releases += 1;
    }
    grantedSequence = 0;
  };

  /** 请求已经不在了（撤回/超时/退出）：把 admission 里的排队位一起撤掉，别卡住队首。 */
  const withdrawQueued = (): void => {
    if (!queuedForAdmission) return;
    queuedForAdmission = false;
    admission.withdraw();
    stats.withdraws += 1;
  };

  /**
   * 走一步状态机。返回值告诉调用方**要不要立刻重试**：
   * `"pending"` = 有请求但许可被别人占着（必须重试，否则 worker 会一直等到超时）、
   * `"idle"` = 可以挂起等下一次 notify。
   */
  const step = (): "idle" | "pending" => {
    if (disposed) {
      withdrawQueued();
      return "idle";
    }
    const request = Atomics.load(words, LEASE_REQUEST);
    const grant = Atomics.load(words, LEASE_GRANT);
    if (request === 0) {
      // worker 让路 / 结束 / **超时撤回**。撤回情形下必须撤销 admission 排队位，
      // 否则队首被一个已经不存在的请求占着，其它 owner 永远拿不到许可。
      withdrawQueued();
    }
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
        queuedForAdmission = true;
        stats.busyWaits += 1;
        return "pending";
      }
      queuedForAdmission = false;
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
          await new Promise((done) => setTimeout(done, LEASE_POLL_MS));
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
        await new Promise((done) => setTimeout(done, LEASE_ERROR_BACKOFF_MS));
      }
    }
  };
  void loop();

  return {
    dispose(): void {
      disposed = true;
      releaseHeld();
      withdrawQueued();
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
 *
 * ## O07：事务语句要**保留**许可，不是"进了又出"
 *
 * 分类按 SQL 文本的**净事务增量**（见 {@link transactionDelta}）：`BEGIN` +1、
 * `COMMIT`/`END`/`ROLLBACK`（不含 `ROLLBACK TO`）-1，`SAVEPOINT`/`RELEASE`/`ROLLBACK TO` 0
 * （复用外层许可，不另取一把）。增量 >0 时先 `hold()` 再执行；<0 时先执行再释放。
 * 一次 `exec` 里可以有多条语句（`"PRAGMA synchronous=FULL; BEGIN IMMEDIATE"`），
 * 所以按分号切分逐条判定，而不是 `startsWith("BEGIN")`。
 *
 * 老 gate（只有 `scope`/`yieldIfStale`）仍可工作：事务语句回落成"每条语句一个窗口"。
 * 生产 gate 必须实现 `hold` —— 那条由 `apps/api/test/write-lease.test.ts` 的结构判据钉住。
 */
export function withWriteGate<T extends object>(database: T, gate: WriteGateClientLike): T {
  // 🔴 事务控制必须打在**原连接**上（不是代理）：代理的 `exec` 会递归回到这里，
  // 于是"开事务"这件事自己又开一层，事务深度永远对不上。
  const raw = database as unknown as { exec(sql: string): unknown };
  const holdable = typeof gate.hold === "function" ? gate.hold.bind(gate) : null;
  /** 代理自己开着的短事务层数（= 已通过 `hold()` 拿住的层数）。 */
  let transactionDepth = 0;
  let transactionRelease: (() => void) | null = null;
  let transactionStartedAt = 0;
  let nestedSequence = 0;

  const beginTransactionHold = (): void => {
    if (holdable === null) return;
    if (transactionDepth === 0) {
      transactionRelease = holdable();
      transactionStartedAt = Date.now();
    }
    transactionDepth += 1;
  };

  const endTransactionHold = (): void => {
    if (transactionDepth === 0) return;
    transactionDepth -= 1;
    if (transactionDepth > 0 || transactionRelease === null) return;
    const release = transactionRelease;
    transactionRelease = null;
    release();
    if (gate.recordTransaction) gate.recordTransaction(Date.now() - transactionStartedAt);
  };

  /** 已经拿着许可（事务开着）就直接跑；否则单独开一个语句窗口。 */
  const runHeld = <R>(fn: () => R): R => (transactionDepth > 0 ? fn() : gate.scope(fn));

  /**
   * 一个许可窗口 = 一个短事务。这是 O07 的**显式**形态，供仓库层调用
   * （见 `@rai/storage-sqlite` 的 `withDatabaseTransaction`）。
   *
   * 已经在一个事务里时用 SAVEPOINT 嵌套：**复用外层许可**，不另取一把。
   */
  const withWriteTransaction = <R>(operation: () => R): R => {
    if (transactionDepth > 0) {
      nestedSequence += 1;
      const savepoint = `rai_nested_tx_${nestedSequence}`;
      raw.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = operation();
        raw.exec(`RELEASE ${savepoint}`);
        return value;
      } catch (error) {
        try {
          raw.exec(`ROLLBACK TO ${savepoint}`);
          raw.exec(`RELEASE ${savepoint}`);
        } catch {
          // 🔴 回滚失败**不得覆盖原始错误**：原始错误是"为什么这一批失败"的唯一证据。
        }
        throw error;
      }
    }
    beginTransactionHold();
    try {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const value = operation();
        raw.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          // 同上：原始错误优先。
        }
        throw error;
      }
    } finally {
      endTransactionHold();
    }
  };

  const wrapStatement = (statement: object, sql: string): object => {
    // 事务控制**只**允许走 `exec` 或 `withWriteTransaction`：`prepare("BEGIN …").run()`
    // 会绕过上面那套开合判定。全仓今天没有这种写法（已 grep 核实），这里把它变成显式错误，
    // 免得以后有人顺手写出来又把许可边界打散。
    if (transactionDelta(sql) !== 0) {
      throw new Error(
        "Transaction control must go through exec() or withWriteTransaction(), not a prepared statement"
      );
    }
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        // 🔴 O07 步骤 5：**按 SQL 语义**判定"这是不是写"，不按调用名判定。
        // 只认 `run` 是不够的 —— `INSERT/UPDATE/DELETE … RETURNING` 完全可能经
        // `get()`/`all()` 执行（今天仓里没有这种写法，但那是**当前事实**，不是不变式）。
        // 判据落在语句文本上：以后谁写出 RETURNING 写，它自动进许可，不靠谁记得改这里。
        const writing = isWriteStatement(sql);
        if (property === "run" ||
            (writing && (property === "get" || property === "all" || property === "iterate"))) {
          return (...args: unknown[]) => runHeld(() => (value as (...inner: unknown[]) => unknown).apply(target, args));
        }
        return (...args: unknown[]) => (value as (...inner: unknown[]) => unknown).apply(target, args);
      }
    });
  };

  /**
   * `exec` 的事务感知包装：净开事务时**先拿住许可再执行**，净关事务时**先执行再释放**。
   * 中间那些（PRAGMA/DDL/SAVEPOINT）都在当前许可下跑。
   */
  const execThroughGate = (
    exec: (...inner: unknown[]) => unknown,
    target: object,
    args: unknown[]
  ): unknown => {
    const sql = String(args[0] ?? "");
    const delta = holdable === null ? 0 : transactionDelta(sql);
    const run = (): unknown => exec.apply(target, args);
    if (delta > 0) {
      for (let index = 0; index < delta; index += 1) beginTransactionHold();
      try {
        return runHeld(run);
      } catch (error) {
        for (let index = 0; index < delta; index += 1) endTransactionHold();
        throw error;
      }
    }
    if (delta < 0) {
      try {
        return runHeld(run);
      } finally {
        for (let index = 0; index < -delta; index += 1) endTransactionHold();
      }
    }
    return runHeld(run);
  };

  return new Proxy(database, {
    get(target, property) {
      // 事务 API 挂在代理上（不是原连接上）：仓库层按**结构**发现它，没有就走裸事务。
      if (property === "withWriteTransaction") return withWriteTransaction;
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "prepare") {
        return (...args: unknown[]) => wrapStatement(
          (value as (...inner: unknown[]) => object).apply(target, args),
          String(args[0] ?? "")
        );
      }
      if (property === "exec") {
        return (...args: unknown[]) => execThroughGate(
          value as (...inner: unknown[]) => unknown, target, args
        );
      }
      return (...args: unknown[]) => (value as (...inner: unknown[]) => unknown).apply(target, args);
    }
  }) as T;
}

/** 一条 SQL 字符串里的**净事务层数增量**（见 {@link withWriteGate} 的说明）。 */
export function transactionDelta(sql: string): number {
  let delta = 0;
  for (const statement of splitSqlStatements(sql)) {
    const head = statement.trim().toLowerCase();
    if (/^begin\b/.test(head)) delta += 1;
    else if (/^(commit|end)\b/.test(head)) delta -= 1;
    else if (/^rollback\b/.test(head) && !/^rollback\s+to\b/.test(head)) delta -= 1;
  }
  return delta;
}

/**
 * 这条语句是不是**写**（O07 步骤 5：判据在 SQL 语义上，不在调用名上）。
 *
 * 覆盖 `INSERT` / `UPDATE` / `DELETE` / `REPLACE`，以及以 `WITH` 开头的 CTE 写
 * （`WITH x AS (…) INSERT/UPDATE/DELETE …`）。`SELECT` / `PRAGMA` / `EXPLAIN` 不算写。
 *
 * ⚠️ 判据刻意**宁可少认**：把读误判成写会让 pipeline 为了一个纯读去等写许可
 * （不是死锁，但会平白多出一段等待）；把写漏判成读才是真正危险的。
 * 因此 `WITH` 只在文本里确实出现写关键字时才算写 —— 字符串字面量里的写关键字会误判成写，
 * 那是安全方向。
 */
export function isWriteStatement(sql: string): boolean {
  return splitSqlStatements(sql).some((statement) => {
    const text = statement.trim();
    if (/^(insert|update|delete|replace)\b/i.test(text)) return true;
    return /^with\b/i.test(text) && /\b(insert|update|delete|replace)\b/i.test(text);
  });
}

/** 按 `;` 切分，但忽略单引号字符串字面量里的分号（`quote()` 出来的值可能含它）。 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (inString) {
      current += character;
      if (character === "'") {
        if (sql[index + 1] === "'") {
          current += "'";
          index += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (character === "'") {
      inString = true;
      current += character;
      continue;
    }
    if (character === ";") {
      statements.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  statements.push(current);
  return statements.filter((statement) => statement.trim().length > 0);
}

/**
 * `Atomics.waitAsync` 的本地类型（**不是为了兼容**：Node 24 上它一直存在）。
 * 仓库的编译目标 lib 还没到 ES2024，直接写会报 TS2550；这里只补形状，不改全局 lib。
 */
const waitAsync = (Atomics as unknown as {
  waitAsync(words: Int32Array, index: number, value: number): { async: boolean; value: Promise<string> | string };
}).waitAsync.bind(Atomics);

/**
 * 闸门的最小形状（代理与 worker 客户端都满足它）。
 *
 * `hold`/`recordTransaction` 是**可选**的：老 gate（单测里的记录型 gate、`NO_WRITE_GATE`）
 * 只实现 `scope`/`yieldIfStale` 时仍然可用，只是退回"逐语句窗口"。
 */
export interface WriteGateClientLike {
  scope<T>(fn: () => T): T;
  yieldIfStale(maxHoldMs?: number): void;
  /** 拿住许可直到释放函数被调用（可嵌套）。缺省 ⇒ 代理无法跨越 BEGIN…COMMIT。 */
  hold?(): () => void;
  /** 记一次短事务耗时（分块预算校准用）。 */
  recordTransaction?(durationMs: number): void;
}
