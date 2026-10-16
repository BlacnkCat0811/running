// ─────────────────────────────────────────────────────────────────────────────
// O08（WP-30）租约**交接**的判据：三态状态机、三类竞态、以及"固定等待不得回来"。
//
// 为什么单独一个文件：`write-lease.test.ts` 证明的是**协议与许可覆盖**；本文件证明的是
// **交接本身**（`docs/IOS_SYNC_PERFORMANCE_REVIEW.md` §O08 的实施步骤 1–3 与回归/验收）。
// 三件事，缺一不可：
//
//   1. **成本**：授权与释放属于 `progressed`（立刻继续判定），只有"许可被别的 owner 占着"
//      才是 `blocked`。旧实现把三种情形都返回 `pending`，主循环据此固定 `setTimeout(5)`，
//      一个窗口两跳 ⇒ 200 空窗口 2170 ms（≈10.9 ms/窗口）。于是"每窗口中位数远低于一个
//      5 ms"是**可判定**的回归判据；而"200 空窗口 < 100 ms"是验收目标，由
//      `scripts/measure-write-lease.mjs`（调生产实现的仓库基准）把关，见下面第一条用例的
//      diagnostic 打印。
//   2. **竞态**：①请求落在"判定"与"等待"之间、②取消时尚未授权、③退出时尚有等待者。
//      ①与②是**丢唤醒**的两副面孔：主线程一旦睡在一个"已经到达但尚未处理"的请求上，
//      worker 会一直等 GRANT 直到超时 —— 现象是偶发的 30 s 停顿 + 可重试失败，不是崩溃。
//   3. **通知钩子**：`TaskAdmission.onChange` 是**可选**的纯增益（老实现退化为有界退避）；
//      被阻塞的窗口在许可交还的那一刻重判，而不是空转到下一个退避 tick。同时它必须可退订
//      （`dispose()` 之后不得再持有监听器）。
//
// 🔴 一条单线程事实（它决定了竞态①的写法）：主线程的 `step()` 与 `waitAsync` 之间**没有**
// await，测试代码不可能插进那一段。所以"请求落在判定与等待之间"只能用**假 admission**
// 在 `acquire()` 内部（此刻正处在 `step()` 里）改 REQUEST 来构造 —— 这是唯一确定性的办法，
// 而它构造的正是真实竞态：worker 的撤回/新请求完全可以在主线程这两行之间落地。
//
// ⚠️ 断言的分工：**互斥正确性**（用例 2）先于任何耗时比较；耗费用例只钉"每窗口远低于固定
// 5 ms"这一条，不把 <100 ms 写死在这里 —— 本机 p95 唤醒延迟在并发负载下会到 1.5–6.8 ms
// （同一台机器上还有别的测试在跑），把目标写进单测会让它变成测机器而不是测代码。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler, type TaskAdmission } from "../src/task-admission.js";
import {
  createWriteLeaseServer,
  LEASE_POLL_MS,
  LEASE_WORDS,
  type WriteLeaseServer,
  type WriteLeaseServerStats,
  type WriteLeaseStats
} from "../src/write-lease.js";

/** 一个最小 worker：用**生产**客户端按脚本取/放租约（与 `write-lease.test.ts` 同款）。 */
const WORKER_SCRIPT = `
import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { createWriteLeaseClient } from ${JSON.stringify(new URL("../src/write-lease.ts", import.meta.url).href)};
const words = new Int32Array(workerData.buffer);
const client = createWriteLeaseClient(words, { timeoutMs: workerData.timeoutMs ?? 5000,
  onTimeout: (message) => parentPort.postMessage({ diagnostic: message }) });
const perWindow = [];
let failure = null;
try {
  const flags = workerData.flags ? new Int32Array(workerData.flags) : null;
  for (let index = 0; index < workerData.count; index += 1) {
    const started = performance.now();
    client.scope(() => {
      // "窗口开着"的标记：主线程据此在**窗口**内采样写许可（互斥判据的对照半段）。
      // 1 ms 忙等只是把窗口拉宽到采样看得见，不改变任何协议语义。
      if (flags) {
        Atomics.store(flags, 0, 1);
        const until = Date.now() + 1;
        while (Date.now() < until) { /* 模拟一次短写事务 */ }
        Atomics.store(flags, 0, 0);
      }
    });
    perWindow.push(performance.now() - started);
  }
} catch (error) {
  // 超时现在是**抛出**（可重试失败）而不是失败开放 ⇒ 形状必须回传，否则判据只能看计数。
  failure = { name: String(error?.name ?? "Error"), message: String(error?.message ?? error),
    retryable: error?.retryable === true };
}
parentPort.postMessage({ done: true, perWindow, stats: client.stats(), failure });
`;

interface HandoffRun {
  stats: WriteLeaseStats;
  perWindow: number[];
  diagnostics: string[];
  failure: { name: string; message: string; retryable: boolean } | null;
}

interface Handoff {
  /** worker 跑完的观测（每窗口耗时、客户端统计、可重试失败）。 */
  result: Promise<HandoffRun>;
  /** 共享槽位（判据需要直接读写 REQUEST/GRANT 时用：竞态①②）。 */
  words: Int32Array;
  server: WriteLeaseServer;
  /** 授权侧统计（`dispose()` 之前的快照；dispose 自己也会撤销排队位）。 */
  serverStats(): WriteLeaseServerStats;
  close(): Promise<void>;
}

/**
 * 起一个真 worker 线程 + 真共享内存 + 真授权循环。
 *
 * `admission` 可以是真 `TaskAdmissionScheduler.owner(...)`，也可以是只实现
 * `acquire`/`withdraw` 的假实现（用来构造单线程测试插不进去的时序）。
 */
function startHandoff(
  admission: TaskAdmission,
  options: { count?: number; timeoutMs?: number; flags?: SharedArrayBuffer } = {}
): Handoff {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * LEASE_WORDS);
  const words = new Int32Array(buffer);
  const server = createWriteLeaseServer(admission, words);
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SCRIPT)}`), {
    workerData: {
      buffer, count: options.count ?? 1, timeoutMs: options.timeoutMs, flags: options.flags
    }
  });
  const diagnostics: string[] = [];
  const result = new Promise<HandoffRun>((resolve, reject) => {
    worker.on("message", (message: {
      done?: boolean; perWindow?: number[]; stats?: WriteLeaseStats;
      diagnostic?: string; failure?: HandoffRun["failure"];
    }) => {
      if (message.diagnostic !== undefined) diagnostics.push(message.diagnostic);
      if (message.done !== true || !message.stats) return;
      resolve({
        stats: message.stats,
        perWindow: message.perWindow ?? [],
        diagnostics,
        failure: message.failure ?? null
      });
    });
    worker.on("error", reject);
  });
  return {
    result,
    words,
    server,
    serverStats: () => server.stats(),
    async close() {
      server.dispose();
      await worker.terminate();
    }
  };
}

/** 让出几次宏任务，等授权循环走完一轮（判据只关心"有没有发生"，不关心多久）。 */
const tick = (times = 1): Promise<void> => {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    chain = chain.then(() => new Promise<void>((done) => setImmediate(done)));
  }
  return chain;
};

/** 有界轮询（诊断计数用）：到点就停，绝不挂死用例。 */
const waitFor = async (predicate: () => boolean, budgetMs = 2_000): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
};

test("O08 交接成本：200 个空窗口不再为授权/释放支付固定 5 ms 等待", async (t) => {
  const scheduler = new TaskAdmissionScheduler(new MutationCoordinator());
  const handoff = startHandoff(scheduler.owner("recompute"), { count: 200 });
  const run = await handoff.result;
  await handoff.close();

  assert.equal(run.stats.timeouts, 0, "空窗口不该超时");
  assert.equal(run.stats.windows, 200, `200 个窗口都要真的取到许可（实际 ${run.stats.windows}）`);
  assert.deepEqual(run.diagnostics, []);
  // 🔴 判据：旧实现每个窗口两次 `setTimeout(5)`（授权、释放各一次）⇒ 中位数 ≈10 ms。
  // 只要固定等待回来，中位数立刻回到 5 ms 以上 —— 于是 `LEASE_POLL_MS / 2` 这条界
  // 既远离新实现的实测值（本机 p50 0.4 ms 量级），又远离旧行为（≈10 ms）。
  const sorted = [...run.perWindow].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? Number.POSITIVE_INFINITY;
  const total = run.perWindow.reduce((sum, value) => sum + value, 0);
  t.diagnostic(
    `O08 交接：200 空窗口共 ${total} ms（每窗口 p50 ${median} ms / p95 ${p95} ms）；` +
    `验收目标 <100 ms 由 scripts/measure-write-lease.mjs 的 30 轮基准把关`
  );
  assert.ok(median < LEASE_POLL_MS / 2,
    `每窗口中位 ${median} ms —— 授权/释放又变成了"退避等待"：固定 5 ms 的放大回来了`);
});

// 先证明正确、再比快慢（O08 验收原文）：窗口开着时**别的 owner 必须拿不到**写许可。
// 采样点只在 worker 的窗口体内（共享标记为 1 时）才尝试取许可，并单独断言"真的采到过
// 窗口开着的样本"—— 否则 worker 秒退、采样全落在窗口之外，判据会变成没有牙齿的绿。
test("O08 互斥正确性：窗口开着时 HTTP 拿不到写许可（交接不得撕开互斥）", async () => {
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  const flags = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const marker = new Int32Array(flags);
  const handoff = startHandoff(scheduler.owner("recompute"), { count: 40, flags });

  let sampling = true;
  let openWindowSamples = 0;
  let leaks = 0;
  const sampler = (async () => {
    while (sampling) {
      await tick();
      if (Atomics.load(marker, 0) !== 1) continue;
      openWindowSamples += 1;
      try {
        const release = mutations.acquire("HTTP");
        release();
        leaks += 1;
      } catch {
        // 期望：窗口开着 ⇒ MutationConflictError。
      }
    }
  })();

  const run = await handoff.result;
  sampling = false;
  await sampler;
  await handoff.close();

  assert.equal(run.stats.windows, 40);
  assert.equal(run.stats.timeouts, 0);
  assert.ok(openWindowSamples > 0,
    "对照失败：采样从未落在窗口开着的时候 —— 本判据无法证明互斥");
  assert.equal(leaks, 0,
    `窗口开着时 HTTP 拿到了写许可 ${leaks} 次 —— 交接把互斥撕开了（这正是 O08 不得引入的缺陷）`);
});

// 竞态①+②：请求在**判定与等待之间**被撤回（worker 超时/取消）。这是"丢唤醒"的确定性构造：
// 假 admission 的 `acquire()` 此刻正跑在 `step()` 里，它在返回 null 之前把 REQUEST 清零 ——
// 于是 `step()` 手里那个观测值已经过期。正确实现必须**立刻重判**（waitAsync 用观测值 ⇒
// not-equal ⇒ 一次宏任务内就重新判定），并在看到 REQUEST=0 时撤销 admission 排队位。
// 若把"观测值"换成"等待前重读"，服务器会睡在 REQUEST=0 上，撤销要等到退避计时器 ——
// 下面 `oneTick` 之后的断言就是那条分界。
test("O08 竞态①②：取消落在判定与等待之间 ⇒ 必须立刻重判并撤销排队位（不得等待已到达的新状态）", async () => {
  let withdrawals = 0;
  let attempts = 0;
  const wordRef: { words: Int32Array | null } = { words: null };
  const admission: TaskAdmission = {
    acquire: () => {
      attempts += 1;
      // 🔴 这一步就是"worker 在授权循环正判定时撤回了请求"，位置精确到 `step()` 内部：
      // 它让 `step()` 手里的观测值立刻过期。单线程测试没法插进 step() 与 waitAsync 之间，
      // 只有在 admission 里做得到 —— 而真实 worker 的撤回确实可以落在那两行之间。
      if (attempts === 1 && wordRef.words) {
        Atomics.store(wordRef.words, 0, 0);
        Atomics.notify(wordRef.words, 0);
      }
      return null;
    },
    withdraw: () => { withdrawals += 1; },
    blocker: () => "holder"
  };
  const handoff = startHandoff(admission, { count: 1, timeoutMs: 300 });
  wordRef.words = handoff.words;

  // 等第一次授权尝试发生（worker 线程起来要几十毫秒，不能靠"睡一下"）。
  const attempted = await waitFor(() => attempts === 1, 2_000);
  assert.equal(attempted, true, "夹具前提：worker 必须真的发出请求、授权循环必须真的试过");
  // 🔴 判据：正确实现在**同一个宏任务**里就重新判定完（观测值过期 ⇒ 重判 ⇒ 看到 REQUEST=0
  // ⇒ 撤销排队位）。"等待前重读"的版本会把 REQUEST=0 当成新的静默基线睡下去，撤销要等到
  // 5 ms 退避计时器 —— 而这里紧跟着断言，等待没有发生的余地。
  assert.equal(withdrawals, 1,
    "请求在判定与等待之间被撤回，但排队位没有被撤销 —— 授权循环睡在了一个已经到达的" +
    "新状态上（真实后果：worker 等 GRANT 到超时，其它 owner 被卡在队首后面）");

  // 收尾：请求已撤回且不再授权 ⇒ worker 必须走**可重试失败**，而不是静默继续写。
  handoff.server.dispose();
  const run = await handoff.result;
  await handoff.close();
  assert.equal(run.stats.windows, 0, "撤回之后不得再授权");
  assert.equal(run.stats.timeouts, 1);
  assert.equal(run.failure?.retryable, true);
});

test("O08 竞态②：取消（超时撤回）时尚未授权 —— 排队位必须让给下一个人", async () => {
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  const holder = scheduler.owner("import").acquire();
  assert.notEqual(holder, null, "夹具前提：import 应当拿到许可");
  const handoff = startHandoff(scheduler.owner("recompute"), { count: 1, timeoutMs: 150 });
  const run = await handoff.result;
  // 🔴 必须在 dispose **之前**读授权侧统计：dispose 自己也会撤销排队位，那会让断言恒真。
  const serverStats = handoff.serverStats();
  const waitingBeforeDispose = [...scheduler.snapshot().waiting];
  await handoff.close();
  holder?.();

  assert.equal(run.stats.timeouts, 1, "等不到授权必须记一次可重试超时（不是失败开放）");
  assert.equal(run.stats.windows, 0, "超时的窗口没有取到许可，不能算作已授权窗口");
  assert.ok(serverStats.withdraws >= 1, "撤回请求之后必须撤销 admission 排队位");
  assert.ok(!waitingBeforeDispose.includes("recompute"),
    `超时之后 recompute 仍留在等待队列里（${waitingBeforeDispose.join(",")}）—— ` +
    "FIFO 判据是『队首必须是自己』，滞留即其它 owner 永久 409");
  // 反向对照：取消之后许可必须**立刻**可用（不是"等下一个 tick"）。
  const next = scheduler.owner("commands").acquire();
  assert.notEqual(next, null, "recompute 撤回后 commands 仍拿不到许可 ⇒ 排队位滞留");
  next?.();
});

test("O08 竞态③：退出时尚有等待者 —— dispose 必须交还许可、撤销排队位，且不留下死等", async () => {
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  const holder = scheduler.owner("import").acquire();
  assert.notEqual(holder, null);
  const handoff = startHandoff(scheduler.owner("recompute"), { count: 1, timeoutMs: 300 });
  // 等授权循环真的排上队（否则"退出时尚有等待者"这个前提不成立）。
  const queued = await waitFor(() => scheduler.snapshot().waiting.includes("recompute"), 1_000);
  assert.equal(queued, true, "夹具前提：recompute 必须已经进过 admission 队列");

  handoff.server.dispose(); // 模拟 drain 结束时 worker 线程已死：必须先释放许可
  assert.equal(Atomics.load(handoff.words, 1), 0, "dispose 之后 GRANT 槽必须清零");
  assert.ok(!scheduler.snapshot().waiting.includes("recompute"),
    "dispose 没有撤销排队位 —— 队首会被一个不存在的请求占住");
  const run = await handoff.result;
  await handoff.close();
  holder?.();

  assert.equal(run.stats.windows, 0, "dispose 之后不得再授权");
  assert.equal(run.stats.timeouts, 1, "worker 仍在等 ⇒ 必须走可重试失败，而不是无声地写下去");
  assert.equal(run.failure?.retryable, true, "写给调用方的必须是可重试标记");
  // 反向对照：许可必须立刻回到空闲（不是"永久被占"）。
  const after = mutations.acquire("HTTP");
  after();
});

test("O08 通知钩子：被阻塞的窗口在许可交还的那一刻重判，不等退避计时器", async () => {
  let grantable = false;
  let permitHeld = false;
  let attempts = 0;
  const listeners = new Set<() => void>();
  const admission: TaskAdmission = {
    acquire() {
      attempts += 1;
      if (!grantable) return null;
      permitHeld = true;
      let released = false;
      return () => { if (released) return; released = true; permitHeld = false; };
    },
    withdraw: () => {},
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    blocker: () => "holder"
  };
  const handoff = startHandoff(admission, { count: 1, timeoutMs: 5_000 });
  // 等退避已经放大到上界（4 次尝试 ⇒ 5→10→20→25 ms），这样"计时器"与"通知"可分。
  const blocked = await waitFor(() => attempts >= 4, 1_000);
  assert.equal(blocked, true, "夹具前提：服务器必须进入 blocked 并重试过若干次");
  assert.equal(listeners.size, 1, "授权循环没有订阅 admission 状态变化 —— 被阻塞时只能空转到退避");

  const before = attempts;
  grantable = true;
  for (const listener of [...listeners]) listener(); // 状态变化：许可交还
  await tick(); // 一次宏任务（远小于此刻 ~25 ms 的退避余量）
  assert.ok(attempts > before,
    `状态变化之后一个宏任务内没有重判（尝试次数仍是 ${attempts}）—— ` +
    "通知没有接到授权循环上，窗口要白等到退避计时器");

  const run = await handoff.result;
  const serverStats = handoff.serverStats();
  await handoff.close();
  assert.equal(run.stats.windows, 1);
  assert.equal(run.stats.timeouts, 0);
  assert.equal(serverStats.waitedOn.holder, 1, "被阻塞的窗口必须归因到挡住它的 owner");
  assert.equal(permitHeld, false, "窗口结束后许可必须交还（dispose 也要释放）");
  assert.equal(listeners.size, 0, "dispose 之后不得再持有 admission 监听器（否则监听器泄漏）");
});

test("O08 通知钩子是可选的：不实现它的老 TaskAdmission 退化为有界退避，仍然能拿到许可", async () => {
  let grantable = false;
  let attempts = 0;
  // ⛔ 刻意不实现 `onChange` / `blocker`：老调用方（import-worker / command-queue /
  // prediction-worker 之外的自定义实现）就是这个形状。行为必须与今天一致 —— 靠退避重试。
  const admission: TaskAdmission = {
    acquire: () => {
      attempts += 1;
      if (!grantable) return null;
      return () => {};
    },
    withdraw: () => {}
  };
  const handoff = startHandoff(admission, { count: 1, timeoutMs: 5_000 });
  assert.equal(await waitFor(() => attempts >= 2, 1_000), true, "夹具前提：先被挡一次再放行");
  grantable = true;
  const run = await handoff.result;
  const serverStats = handoff.serverStats();
  await handoff.close();

  assert.equal(run.stats.windows, 1, "没有通知钩子时必须靠有界退避重试拿到许可");
  assert.equal(run.stats.timeouts, 0);
  assert.equal(serverStats.waitedOn.unknown, 1,
    "没有 blocker() 的实现在等待分布里记为 unknown（诊断不得因此报错）");
});

// 通知**来源**的判据：真调度器只在"可得性上升"的迁移上通知，且撤销排队位算一次变化。
// 通知发多了会把被阻塞的等待方互相叫醒去失败一次（空转轮询），发少了就退化成纯计时器。
test("O08 通知来源：真 TaskAdmissionScheduler 只在可得性上升时通知，且可退订", () => {
  const scheduler = new TaskAdmissionScheduler(new MutationCoordinator());
  const compute = scheduler.owner("recompute");
  const imports = scheduler.owner("import");
  let changes = 0;
  const unsubscribe = compute.onChange?.(() => { changes += 1; });
  assert.equal(typeof unsubscribe, "function", "owner() 必须提供 onChange（它是 O08 步骤 2 的接线点）");

  const held = imports.acquire();
  assert.notEqual(held, null);
  assert.equal(changes, 0,
    "拿到许可 / 进队列都不是『别人更可能拿到许可』—— 为此通知会让等待方互相空转");
  held?.();
  assert.ok(changes >= 1, "许可交还之后必须通知（这是等待方唯一必须醒来的那一刻）");

  // 撤销一个**真实存在**的排队位 = 队首空出来 ⇒ 要通知；重复撤销不是变化 ⇒ 不通知。
  const holder = imports.acquire();
  assert.notEqual(holder, null);
  assert.equal(compute.acquire(), null, "夹具前提：compute 此刻拿不到许可（import 拿着）");
  const beforeQueueChange = changes;
  compute.withdraw();
  assert.equal(changes, beforeQueueChange + 1, "撤销排队位必须通知：否则队首后面的 owner 只能等计时器");
  compute.withdraw();
  assert.equal(changes, beforeQueueChange + 1, "重复撤销不是状态变化，不该再通知（副作用最小）");
  // 取消窗口的 `controls`（`acquireControl` 的释放）也属于"可得性上升"。
  const control = scheduler.acquireControl("import");
  assert.notEqual(control, null);
  control?.();
  assert.ok(changes > beforeQueueChange + 1, "cancel 窗口结束后必须通知排队的导入方");
  holder?.();

  assert.equal(compute.blocker?.(), "unknown", "没有阻塞源时归因为 unknown（不编造 owner）");
  const blocker = imports.acquire();
  assert.notEqual(blocker, null);
  assert.equal(compute.blocker?.(), "import", "被谁挡着必须能说出来（owner 等待分布的键）");
  blocker?.();
  scheduler.blockUntilRestart("recovery");
  assert.equal(compute.blocker?.(), "restart", "恢复中的阻塞要单独归因，不能记成某个 owner");

  const beforeUnsubscribe = changes;
  unsubscribe?.();
  const last = imports.acquire();
  last?.();
  assert.equal(changes, beforeUnsubscribe, "退订之后不得再回调（dispose 依赖它不泄漏监听器）");
});

// 端到端：真调度器 + 真 worker。被 import 挡住的窗口必须①归因到 import、②在 import 交还
// 许可的**同一个宏任务**内拿到授权（而不是等到 25 ms 退避上界）。这里刻意先等退避放大到
// 上界，好让"通知"和"计时器"在时间上分得开。
test("O08 通知接线（真调度器）：持有者交还许可 ⇒ 被阻塞的窗口同一轮就拿到授权", async () => {
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  const holder = scheduler.owner("import").acquire();
  assert.notEqual(holder, null);
  const handoff = startHandoff(scheduler.owner("recompute"), { count: 1, timeoutMs: 5_000 });
  const blocked = await waitFor(() => handoff.serverStats().busyWaits >= 4, 1_000);
  assert.equal(blocked, true, "夹具前提：被 import 挡住并重试到退避上界");
  assert.equal(handoff.serverStats().waitedOn.import, 1, "被阻塞的窗口必须归因到挡它的 import");

  holder?.(); // 许可交还：调度器通知 ⇒ 授权循环重判
  await tick();
  assert.equal(handoff.serverStats().grants, 1,
    "许可交还之后一个宏任务内仍未授权 —— 通知没有接到授权循环上，窗口只能等退避计时器");
  const run = await handoff.result;
  await handoff.close();
  assert.equal(run.stats.windows, 1);
  assert.equal(run.stats.timeouts, 0);
});

// 结构判据：上面那些竞态用例都只能用假 admission 构造，而"等待前重读 REQUEST"这个改动
// 恰好会把它们全部变绿（假 admission 里没有别的线程）。所以再钉一条**源码级**判据：
// 授权循环里的 waitAsync 必须吃 `step()` 已处理过的观测值，循环体不得重读 REQUEST。
test("O08 结构判据：waitAsync 用本轮已处理的观测值，授权循环不得重读 REQUEST", () => {
  const source = readFileSync(new URL("../src/write-lease.ts", import.meta.url), "utf8");
  const loopStart = source.indexOf("const loop = async ()");
  assert.ok(loopStart > 0, "找不到授权循环（改名了？判据必须跟着改，而不是静默失效）");
  const loop = source.slice(loopStart, source.indexOf("void loop();", loopStart));
  assert.match(loop, /await waitForWake\(outcome\.request/,
    "授权循环没有把 step() 的观测值交给等待 —— 等待前重读 REQUEST 会睡在已到达的请求上");
  assert.doesNotMatch(loop, /Atomics\.load\(words, LEASE_REQUEST\)/,
    "授权循环里出现了 REQUEST 重读 —— 观测值必须是本轮已处理的那个（O08 步骤 3）");
  // 反向对照：观测值确实由 step() 产出（否则上面两条可以靠"什么都不读"蒙过去）。
  assert.match(source, /const request = Atomics\.load\(words, LEASE_REQUEST\);/,
    "step() 里必须有一次 REQUEST 读取，它才是等待的 expected");
});
