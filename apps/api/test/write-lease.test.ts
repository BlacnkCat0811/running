// 短写租约（PR4 步骤 3 / §14.2 A11）的可执行判据。
//
// A11 的原文：**后台计算不长期占写锁** —— CPU 分析期间仍可接收新批次；写锁仅覆盖短 SQL 事务；
// 不能仅把旧长事务换到 Worker。证据要求：调度/锁时间线、并发导入及轻量 API 延迟。
//
// 这个文件分三层证明：
//   1. **协议**：真 worker 线程 + 共享内存，逐窗口取/放；worker 退出（含"持着租约崩"）必须释放，
//      否则写路由永久 409；等不到授权时必须**失败开放**而不是把队列挂死。
//   2. **覆盖**：连接代理让"经过这条连接的所有写"都在许可内（读不取），这条是结构性的 ——
//      它把"漏写"从"代码评审要记得"变成"只有一条连接可走"。
//   3. **时间线**：真 `RecomputeWorker`（真线程）跑一次真分析，主线程持续采样 `MutationCoordinator`
//      ——断言分析进行中**能**拿到写许可，且最长连续占用远小于整轮时长（旧行为是整轮持锁）。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { DATABASE_TIMEZONE } from "@rai/contracts";
import { RaiApplicationService } from "@rai/application";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";

import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { RecomputeWorker } from "../src/recompute-worker.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import {
  createWriteLeaseClient,
  createWriteLeaseServer,
  isWriteStatement,
  LEASE_WORDS,
  transactionDelta,
  withWriteGate,
  WriteLeaseTimeoutError,
  type WriteLeaseStats
} from "../src/write-lease.js";

/** 一个最小 worker：按脚本取/放租约，用来单独验证协议（不碰数据库）。 */
const WORKER_SCRIPT = `
import { parentPort, workerData } from "node:worker_threads";
import { createWriteLeaseClient } from ${JSON.stringify(new URL("../src/write-lease.ts", import.meta.url).href)};
const words = new Int32Array(workerData.buffer);
const client = createWriteLeaseClient(words, { timeoutMs: workerData.timeoutMs ?? 5000,
  onTimeout: (message) => parentPort.postMessage({ diagnostic: message }) });
let failure = null;
let holdYield = null;
try {
  for (const instruction of workerData.script) {
    if (instruction === "window") client.scope(() => { Atomics.add(words, 0, 0); });
    else if (instruction === "hold") { client.scope(() => {}); }
    else if (instruction === "yield") client.yieldIfStale(0);
    else if (instruction === "scopeYield") {
      // 对照半段：**事务之外**的让路点。它必须真的让路，否则"事务内不让路"这条判据
      // 可能只是因为 yield 压根没跑（假绿）。
      client.scope(() => { client.yieldIfStale(0); });
    }
    else if (instruction === "holdYield") {
      // 事务开着（hold 拿住）时的让路点：必须**什么都不做**。
      const release = client.hold();
      client.yieldIfStale(0);
      holdYield = { yields: client.stats().yields, request: Atomics.load(words, 0), grant: Atomics.load(words, 1) };
      release();
    }
    else if (instruction === "sleep") { const until = Date.now() + 60; while (Date.now() < until) {} }
  }
} catch (error) {
  // 超时现在是**抛出**而不是失败开放 ⇒ 必须把错误的形状回传，否则判据只能看计数。
  failure = { name: String(error?.name ?? "Error"), message: String(error?.message ?? error),
    retryable: error?.retryable === true };
}
parentPort.postMessage({ done: true, stats: client.stats(), failure, holdYield });
`;

interface LeaseRun {
  stats: WriteLeaseStats;
  diagnostics: string[];
  failure: { name: string; message: string; retryable: boolean } | null;
  holdYield: { yields: number; request: number; grant: number } | null;
  /**
   * 线程结束**之前**的授权侧观测值。
   *
   * 🔴 为什么必须在 `dispose()` 之前取：`dispose()` 自己也会撤销排队位（崩溃时必须如此），
   * 于是"超时撤回有没有撤销排队位"这条判据在 dispose 之后就**恒为真**——
   * 一个没有牙齿的断言比没有断言更糟，它会让人以为这条路径被守住了。
   */
  serverStats: { grants: number; releases: number; busyWaits: number; withdraws: number };
  waitingBeforeDispose: string[];
}

/** 用真 worker 线程跑一段脚本，返回客户端统计与超时诊断。 */
async function runLeaseWorker(
  scheduler: TaskAdmissionScheduler,
  script: string[],
  options: { timeoutMs?: number; holdBeforeExit?: boolean } = {}
): Promise<LeaseRun> {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * LEASE_WORDS);
  const words = new Int32Array(buffer);
  const server = createWriteLeaseServer(scheduler.owner("recompute"), words);
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SCRIPT)}`), {
    workerData: { buffer, script, timeoutMs: options.timeoutMs }
  });
  const diagnostics: string[] = [];
  const settled = new Promise<LeaseRun>((resolve, reject) => {
    worker.on("message", (message: {
      done?: boolean;
      stats?: WriteLeaseStats;
      diagnostic?: string;
      failure?: LeaseRun["failure"];
      holdYield?: LeaseRun["holdYield"];
    }) => {
      if (message.diagnostic !== undefined) diagnostics.push(message.diagnostic);
      if (message.done === true && message.stats) {
        const run: LeaseRun = {
          stats: message.stats,
          diagnostics,
          failure: message.failure ?? null,
          holdYield: message.holdYield ?? null,
          serverStats: { grants: 0, releases: 0, busyWaits: 0, withdraws: 0 },
          waitingBeforeDispose: []
        };
        // 🔴 线程已经结束，但**授权循环还没跑完**：它挂在 `Atomics.waitAsync`/短睡上，
        // "请求已撤回"这件事要等它下一轮 `step()` 才被处理。立刻读 stats 会读到撤回**之前**
        // 的快照，于是"撤销排队位"这条判据时红时绿。给循环一个明确的窗口再取观测值。
        setTimeout(() => {
          run.serverStats = server.stats();
          run.waitingBeforeDispose = [...scheduler.snapshot().waiting];
          resolve(run);
        }, 50);
      }
    });
    worker.on("error", reject);
  });
  const result = await settled;
  // 线程退出后必须释放：这里模拟的正是 drain 在 `exit` 时调用 `dispose()`。
  server.dispose();
  await worker.terminate();
  return result;
}

test("协议：逐窗口取/放，窗口之间写许可对别人可用；worker 退出后必须已释放", async () => {
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  const run = await runLeaseWorker(scheduler, ["window", "sleep", "window", "sleep", "window"]);
  assert.ok(run.stats.windows >= 3, `三个窗口都要真的取到许可（实际 ${run.stats.windows}）`);
  assert.equal(run.stats.timeouts, 0);
  // 线程已退出且 dispose 已调用 ⇒ 写许可必须立刻可用（否则写路由永久 409）。
  const release = mutations.acquire("HTTP");
  release();
  assert.deepEqual(run.diagnostics, []);
  assert.equal(scheduler.snapshot().active, null);
});

test("协议：拿不到许可时**可重试失败**（撤回请求、拒绝写入），而不是失败开放或无许可写入", async () => {
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  const blocker = mutations.acquire("HTTP");
  try {
    const run = await runLeaseWorker(scheduler, ["window"], { timeoutMs: 150 });
    // 🔴 语义变更（O07 / 决策 D1，2026-10-16）。旧行为：超时后**记录诊断并继续写**
    //（"失败开放"），代价是"数据库锁被 SQLite 拿着、应用许可却是空的"成为常态。
    // 新行为：撤回请求 + 抛可重试错误 —— 这一批不写，任务回到队列稍后重跑。
    assert.equal(run.stats.timeouts, 1, "等不到授权必须记一次超时");
    assert.equal(run.stats.windows, 0, "超时的窗口**没有**取到许可，绝不能算作已授权窗口");
    assert.equal(run.diagnostics.length, 1, "超时必须留下诊断（可重试失败要能被看见）");
    assert.match(run.diagnostics[0]!, /写许可/);
    assert.match(run.failure?.name ?? "", /WriteLeaseTimeoutError/, "必须是可重试的错误类型");
  } finally {
    blocker();
  }
  // 撤回请求之后许可必须**立刻**可用（旧实现里排队位会一直占着队首）。
  const release = mutations.acquire("HTTP");
  release();
  assert.equal(scheduler.snapshot().active, null);
  assert.deepEqual(scheduler.snapshot().waiting, [],
    "worker 撤回请求之后 admission 的排队位必须一起撤销 —— 否则队首被一个不存在的请求占着，其它 owner 永久拿不到许可");
});

test("协议：超时**不停留**在 admission 等待队列里（撤销排队位）", async () => {
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  const blocker = mutations.acquire("HTTP");
  let run: LeaseRun;
  try {
    run = await runLeaseWorker(scheduler, ["window"], { timeoutMs: 150 });
  } finally {
    blocker();
  }
  assert.equal(run.stats.timeouts, 1);
  // 🔴 判据必须看**线程还活着时**的授权侧状态（`dispose()` 自己也会撤销，见 `LeaseRun`）。
  assert.ok(run.serverStats.withdraws >= 1,
    "worker 超时撤回请求之后没有撤销 admission 排队位 —— 队首会被一个不存在的请求永远占住");
  assert.ok(!run.waitingBeforeDispose.includes("recompute"),
    `超时之后 recompute 仍留在等待队列里（${run.waitingBeforeDispose.join(",")}）—— ` +
    "`TaskAdmissionScheduler.acquire()` 的 FIFO 判据是『队首必须是自己』，滞留即其它 owner 永久 409");
  assert.ok(run.serverStats.busyWaits >= 1,
    "对照：本用例必须真的走到『许可被别人占着、admission 拿不到』那条分支 —— " +
    "否则排队位从未被设置，『撤销』自然无事可撤，本判据就没有牙齿");
  // 另一个 owner 现在必须能拿到许可。
  const other = scheduler.owner("import").acquire();
  assert.notEqual(other, null,
    "recompute 超时撤回后，import 仍拿不到许可 ⇒ 滞留的等待位卡住了队首");
  other?.();
});

test("覆盖：连接代理让每个写语句都在许可内，读不取许可", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE t (id TEXT, n INTEGER)");
  let scopes = 0;
  const gate = {
    scope<T>(fn: () => T): T { scopes += 1; return fn(); },
    yieldIfStale(): void {}
  };
  const gated = withWriteGate(database, gate);
  gated.exec("INSERT INTO t VALUES ('a', 1)");
  const afterExec = scopes;
  gated.prepare("INSERT INTO t VALUES (?, ?)").run("b", 2);
  assert.equal(scopes, afterExec + 1, "写语句必须恰好取一次租约");
  const read = gated.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
  assert.equal(read.n, 2);
  gated.prepare("SELECT id FROM t ORDER BY id").all();
  assert.equal(scopes, afterExec + 1, "读不得取写许可（§6 的许可表）");
  gated.prepare("UPDATE t SET n = 9 WHERE id = 'a'").run();
  assert.equal(scopes, afterExec + 2);
  database.close();
});

test("A11 时间线：真分析跑在真线程里时，写许可在窗口之间是**空的**（不是整轮占用）", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-write-lease-"));
  try {
    mkdirSync(join(root, "var"));
    const databasePath = join(root, "var", "rai.sqlite");
    const store = await RaiDatabase.open(databasePath, { createMigrationBackup: false });
    try {
      const database = store.database;
      database.prepare("INSERT INTO import_manifest (key, value) VALUES (?, ?)")
        .run("dataset_version", "lease_fixture_v1");
      const insertWorkout = database.prepare(`INSERT INTO workouts (
        id, activity_type, source_name, source_category, source_version, device,
        start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
        VALUES (?, 'HKWorkoutActivityTypeRunning', 'Watch', 'apple_watch', '1', 'Watch', ?, ?, 1800, 0, '{}', '{}', 1)`);
      const insertStatistic = database.prepare(`INSERT INTO workout_statistics
        (workout_id, ordinal, type, unit, sum_value, average_value, minimum_value, maximum_value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertSession = database.prepare(`INSERT INTO training_sessions
        (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
        VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 5, ?, 'active')`);
      const insertOverride = database.prepare(`INSERT INTO workout_overrides
        (id, training_session_id, revision, eligibility_override, session_type, statistics_participation,
         performance_protocol, rpe, condition_tags_json, note)
        VALUES (?, ?, 1, 'include', NULL, NULL, NULL, NULL, '[]', NULL)`);
      // 四十条训练：足够让"整轮持锁"与"逐语句持锁"在时间线上区分得开。
      for (let index = 0; index < 40; index += 1) {
        const start = new Date(Date.UTC(2025, 0, 1 + index * 3)).toISOString();
        const end = new Date(Date.parse(start) + 1_800_000).toISOString();
        insertWorkout.run(`lease_workout_${index}`, start, end);
        insertStatistic.run(`lease_workout_${index}`, 0,
          "HKQuantityTypeIdentifierDistanceWalkingRunning", "km", 5, null, null, null);
        insertStatistic.run(`lease_workout_${index}`, 1,
          "HKQuantityTypeIdentifierHeartRate", "count/min", null, 145, 130, 165);
        insertStatistic.run(`lease_workout_${index}`, 2,
          "HKQuantityTypeIdentifierRunningSpeed", "km/hr", null, 10, 9, 11);
        insertSession.run(`lease_session_${index}`, start, end, `lease_workout_${index}`);
        insertOverride.run(`lease_override_${index}`, `lease_session_${index}`);
      }
      new RaiApplicationService(store).enqueueFullRecompute({
        evaluatedAt: new Date(Date.UTC(2025, 6, 1)).toISOString(),
        timezoneIdentifier: DATABASE_TIMEZONE
      });
    } finally {
      store.close();
    }

    const mutations = new MutationCoordinator();
    const scheduler = new TaskAdmissionScheduler(mutations);
    const worker = new RecomputeWorker(databasePath, () => {}, scheduler.owner("recompute"));
    let samples = 0;
    let available = 0;
    let busyMs = 0;
    let longestBusyMs = 0;
    const interval = 10;
    const sampler = setInterval(() => {
      samples += 1;
      try {
        const release = mutations.acquire("HTTP");
        release();
        available += 1;
        busyMs = 0;
      } catch {
        busyMs += interval;
        longestBusyMs = Math.max(longestBusyMs, busyMs);
      }
    }, interval);
    try {
      worker.schedule();
      const deadline = Date.now() + 120_000;
      while (worker.isRunning && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.ok(Date.now() < deadline, "分析必须在超时前结束");
    } finally {
      clearInterval(sampler);
      await worker.close();
    }

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const job = database.prepare(
        "SELECT status FROM recompute_jobs ORDER BY created_at DESC LIMIT 1"
      ).get() as { status: string };
      assert.equal(job.status, "succeeded", "分析本身必须成功（拆锁不能把分析弄坏）");
      assert.equal(Number(database.prepare("SELECT COUNT(*) AS n FROM active_model_run").get()!.n), 1,
        "成功的分析仍然要发布 release");
    } finally {
      database.close();
    }

    // 🔴 判据本体：分析进行中**能**拿到写许可；最长连续占用远小于整轮。
    // 旧行为（drain 全程持锁）下 available 恒为 0、longestBusyMs ≈ 整轮时长。
    assert.ok(available > 0,
      `分析进行中必须有拿得到写许可的采样点（采样 ${samples} 次，成功 ${available} 次）—— ` +
      "0 次就说明写锁仍被整轮占用");
    assert.ok(longestBusyMs <= 500,
      `最长连续占用 ${longestBusyMs} ms：写锁只应覆盖短 SQL 事务，不该覆盖 CPU 阶段`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("结构判据：分析只有一条连接且它经过闸门；drain 不得再整轮持锁", () => {
  const read = (relative: string): string =>
    readFileSync(new URL(relative, import.meta.url), "utf8");
  // ① 分析侧不得自己开第二条连接：代理只在"唯一那条连接"上成立，
  //    多开一条就是"有写不在许可内"，而且是运行期才会暴露的那种。
  for (const file of ["../../../packages/application/src/service.ts",
    "../../../packages/application/src/services/recompute-pipeline.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /new DatabaseSync\(/,
      `${file} 直接开了数据库连接 —— 分析必须只用注入的那一条（闸门挂在它上面）`);
    assert.doesNotMatch(source, /RaiDatabase\.open\(/,
      `${file} 自己打开了 RaiDatabase —— 同上，写就绕过了闸门`);
  }
  // ② worker 线程必须把连接包成"每个写语句都过闸门"的代理。
  assert.match(read("../src/recompute-thread.ts"), /withWriteGate\(store\.database/,
    "recompute-thread.ts 没有把连接包进写闸门 —— 那样分析的全部写都不在许可内");
  // ③ drain 不得再整轮持锁（A11 的反例守卫）：许可只能由租约服务器在窗口内取。
  const worker = read("../src/recompute-worker.ts");
  assert.match(worker, /createWriteLeaseServer\(/);
  assert.doesNotMatch(worker, /this\.admission\.acquire\(\)/,
    "drain 又自己取了写许可 —— 整轮持锁会让分析期间的每个写路由回到 409（A11 的原始缺陷）");
});

test("回归：RecomputeWorker 在没有 admission 时也必须能跑（不引入必需依赖）", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-write-lease-noadm-"));
  try {
    mkdirSync(join(root, "var"));
    const databasePath = join(root, "var", "rai.sqlite");
    (await RaiDatabase.open(databasePath, { createMigrationBackup: false })).close();
    const database = new DatabaseSync(databasePath);
    try { new RecomputeJobRepository(database).enqueue("snapshot_refresh", null, {}); }
    finally { database.close(); }
    const worker = new RecomputeWorker(databasePath);
    try {
      worker.schedule();
      const deadline = Date.now() + 60_000;
      while (worker.isRunning && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.ok(Date.now() < deadline);
    } finally {
      await worker.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// O07 复现夹具（2026-10-16 审查 §2.4 的"事务许可最小验证"；WP-02 固化、WP-21 转绿）。
//
// 缺陷：`withWriteGate` 逐语句包 `exec`/`run`，而 `BEGIN IMMEDIATE … COMMIT` 是三条
// 独立语句 ⇒ 事务未结束时许可已被释放 ——「许可空闲但数据库仍被锁」。
//
// ⚠️ **夹具的 gate 在 WP-21 同批扩了 `hold()`，这是有论证的适配，不是放宽**：
// 同步的 `scope()` 调用**不可能**横跨两次独立的 `exec()`（它进了就必须出），
// 所以"许可在事务期间仍被持有"这件事只有在一个能"拿着不放"的 gate 上才可表达。
// 下面三条断言与两个对照半段**逐字保留**：许可必须在事务期间被持有（缺陷本体）、
// 另一条连接必须真的被 SQLite 挡住（前提对照）、COMMIT 之后必须回到空闲（反向对照）。
test("O07 复现：事务的许可覆盖必须等于事务本身（BEGIN→COMMIT 之间不许出现许可空窗）", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-o07-lease-window-"));
  const databasePath = join(root, "lease.sqlite");
  try {
    const raw = new DatabaseSync(databasePath);
    raw.exec("CREATE TABLE t (id TEXT)");
    // 记录型闸门：可观测"此刻许可是否被某个 scope / hold 持有"。
    let permitHeld = false;
    const gate = {
      scope<T>(fn: () => T): T {
        permitHeld = true;
        try { return fn(); } finally { permitHeld = false; }
      },
      hold(): () => void {
        permitHeld = true;
        return () => { permitHeld = false; };
      },
      yieldIfStale(): void {}
    };
    const gated = withWriteGate(raw, gate);
    gated.exec("BEGIN IMMEDIATE");
    // 事务已开始、尚未 COMMIT。正确语义：此刻许可仍应被持有。
    const permitFreeInsideTransaction = !permitHeld;
    // 对照：另一条连接此刻写库必须被 SQLite 锁挡 —— 证明事务确实开着。
    let otherWriterBlocked = false;
    const other = new DatabaseSync(databasePath);
    other.exec("PRAGMA busy_timeout=0");
    try {
      other.exec("INSERT INTO t VALUES ('probe')");
    } catch (error) {
      otherWriterBlocked = /busy|locked/i.test(String(error));
    } finally {
      other.close();
    }
    gated.exec("COMMIT");
    // 提交后许可必须回到空闲（对照另一半：防止夹具绑死在"永远持锁"的假实现上）。
    const permitFreeAfterCommit = !permitHeld;
    raw.close();

    assert.equal(otherWriterBlocked, true,
      "对照失败：事务未开始或 SQLite 锁未生效 —— 本用例的前提不成立，不能据此判断许可边界");
    assert.equal(permitFreeInsideTransaction, false,
      "事务未结束时许可已空闲 —— 应用许可与数据库锁边界不一致（O07；WP-21 目标：许可覆盖整个短事务）");
    assert.equal(permitFreeAfterCommit, true, "COMMIT 之后许可必须回到空闲（短事务原则不变）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-21 追加：**生产路径**上的同一判据。
//
// 上面那条夹具驱动的是代理本身；这条换成真实仓库方法（`RecomputeJobRepository.claimNext`）
// 与**真实** `TaskAdmissionScheduler` 许可：判据是"一个许可窗口 = 一个短事务"，
// 而不是"代理在某个手写场景下看起来对"。
test("O07 生产路径：claimNext 的 BEGIN→COMMIT 落在**一个**许可窗口内，事务期间别人拿不到许可", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-o07-claim-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath, { createMigrationBackup: false });
  try {
    const raw = store.database;
    new RecomputeJobRepository(raw).enqueue("snapshot_refresh", null, {});

    const mutations = new MutationCoordinator();
    const scheduler = new TaskAdmissionScheduler(mutations);
    const admission = scheduler.owner("recompute");
    let permitHeld = false;
    let holds = 0;
    let statementWindows = 0;
    const gate = {
      scope<T>(fn: () => T): T {
        statementWindows += 1;
        permitHeld = true;
        try { return fn(); } finally { permitHeld = false; }
      },
      hold(): () => void {
        holds += 1;
        const release = admission.acquire();
        assert.notEqual(release, null, "许可此刻应当是空闲的（夹具前提）");
        permitHeld = true;
        return () => { permitHeld = false; release?.(); };
      },
      yieldIfStale(): void {}
    };
    // 探针连接：`BEGIN IMMEDIATE` 刚执行完时，许可必须仍被持有、且 HTTP 拿不到许可。
    let permitFreeInsideTransaction: boolean | null = null;
    let httpBlockedInsideTransaction: boolean | null = null;
    const probe = {
      exec(sql: string): void {
        raw.exec(sql);
        if (transactionDelta(sql) > 0) {
          permitFreeInsideTransaction = !permitHeld;
          try {
            mutations.acquire("HTTP")();
            httpBlockedInsideTransaction = false;
          } catch {
            httpBlockedInsideTransaction = true;
          }
        }
      },
      prepare: (sql: string) => raw.prepare(sql),
      close: () => raw.close()
    };
    const gated = withWriteGate(probe as unknown as typeof raw, gate);
    const job = new RecomputeJobRepository(gated).claimNext();
    assert.notEqual(job, null, "夹具前提：必须真的领到一条任务");
    assert.equal(job!.status, "running");

    assert.equal(permitFreeInsideTransaction, false,
      "claimNext 的事务开着时许可已空闲 —— 生产路径上的 O07 未修复");
    assert.equal(httpBlockedInsideTransaction, true,
      "事务期间 HTTP 仍然拿到了写许可 ⇒ 应用许可没有覆盖整个短事务");
    assert.equal(holds, 1, `整个事务只应取一次许可（实际 ${holds} 次）`);
    assert.equal(statementWindows, 0,
      `事务内的语句都应复用外层许可，不该各自开窗口（实际 ${statementWindows} 次）`);
    assert.equal(permitHeld, false, "事务结束后许可必须放回去");

    // 反向对照：事务结束之后，HTTP 必须能拿到许可（不是"永远持锁"的假实现）。
    const after = mutations.acquire("HTTP");
    after();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O07 生产路径：写许可超时 ⇒ 任务**重排**而不是终态失败，超过上限才失败", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-o07-retry-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath, { createMigrationBackup: false });
  try {
    const jobs = new RecomputeJobRepository(store.database);
    const jobId = jobs.enqueue("snapshot_refresh", null, {});
    const claimed = jobs.claimNext();
    assert.equal(claimed?.id, jobId);
    // 第一次可重试失败：回到 queued，进度重置，尝试次数 +1。
    jobs.fail(jobId, new WriteLeaseTimeoutError(30_000, 1));
    const afterFirst = jobs.get(jobId)!;
    assert.equal(afterFirst.status, "queued",
      "写许可等待超时是**可重试的调度失败**，不该把任务结算成用户可见的 failed");
    assert.equal(afterFirst.progressPhase, "retry_pending");
    assert.equal(afterFirst.error?.name, "WriteLeaseTimeoutError", "重排原因必须留痕");

    // 反复超时：有界。到顶 ⇒ 终态失败可见（无限重排会让用户永远看不到结论）。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const next = jobs.claimNext();
      if (next === null) break;
      jobs.fail(next.id, new WriteLeaseTimeoutError(30_000, attempt + 2));
      if (jobs.get(jobId)!.status === "failed") break;
    }
    assert.equal(jobs.get(jobId)!.status, "failed",
      "超过尝试上限必须终态失败 —— 否则任务在队列里无限打转");
    // 反向对照：非可重试错误第一次就终态失败，不得被重排（判据不能是"总是重排"）。
    const otherId = jobs.enqueue("snapshot_refresh", null, {});
    jobs.claimNext();
    jobs.fail(otherId, new Error("genuine data error"));
    assert.equal(jobs.get(otherId)!.status, "failed",
      "普通错误不得被当成可重试失败 —— 那会把真实缺陷藏进重试里");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O07：事务语句的净增量判定覆盖合并串与 SAVEPOINT（不靠 startsWith）", () => {
  assert.equal(transactionDelta("BEGIN IMMEDIATE"), 1);
  assert.equal(transactionDelta("begin deferred transaction"), 1);
  assert.equal(transactionDelta("COMMIT"), -1);
  assert.equal(transactionDelta("END"), -1);
  assert.equal(transactionDelta("ROLLBACK"), -1);
  // `ROLLBACK TO` **不结束**事务 —— 少这一条会把 SAVEPOINT 回滚误判成事务结束、提前放许可。
  assert.equal(transactionDelta("ROLLBACK TO rai_model_activation"), 0);
  assert.equal(transactionDelta("ROLLBACK TO x; RELEASE x"), 0);
  assert.equal(transactionDelta("SAVEPOINT rai_model_activation"), 0);
  assert.equal(transactionDelta("RELEASE rai_model_activation"), 0);
  // 生产上真实存在的合并串（`apps/api/src/runtime-state.ts`）：PRAGMA 与 BEGIN 同一次 exec。
  assert.equal(transactionDelta("PRAGMA synchronous=FULL; BEGIN IMMEDIATE"), 1);
  assert.equal(transactionDelta("INSERT INTO t VALUES ('a;b')"), 0,
    "字符串字面量里的分号不得被当成语句分隔");
  assert.equal(transactionDelta("CREATE INDEX idx ON t(a); INSERT INTO t VALUES ('x')"), 0);
});

test("O07 步骤 5：写与读按 SQL 语义判定 —— RETURNING 写经 get/all 也必须进许可", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE t (id TEXT, n INTEGER)");
    let scopes = 0;
    const gate = {
      scope<T>(fn: () => T): T { scopes += 1; return fn(); },
      yieldIfStale(): void {}
    };
    const gated = withWriteGate(database, gate);
    gated.exec("INSERT INTO t VALUES ('a', 1)");
    const baseline = scopes;

    // `UPDATE … RETURNING` 经 `get()` 执行：它是**写**，必须取许可。
    // 只按调用名判定（"run 才是写"）会把它当成读，于是这条写落在许可之外。
    const returned = gated.prepare("UPDATE t SET n = n + 1 WHERE id = 'a' RETURNING n").get() as { n: number };
    assert.equal(returned.n, 2);
    assert.equal(scopes, baseline + 1, "RETURNING 写经 get() 没有取写许可 —— 这是一条在许可之外的写");

    const rows = gated.prepare("SELECT id, n FROM t").all();
    assert.equal(rows.length, 1);
    assert.equal(scopes, baseline + 1, "纯 SELECT 不得取写许可（读不需要许可）");

    // 反向对照：INSERT 经 run 仍然只取一次。
    gated.prepare("INSERT INTO t VALUES (?, ?)").run("b", 1);
    assert.equal(scopes, baseline + 2);
  } finally {
    database.close();
  }
});

test("O07 步骤 5：isWriteStatement 的判据覆盖 CTE 写与纯读", () => {
  assert.equal(isWriteStatement("INSERT INTO t VALUES (1)"), true);
  assert.equal(isWriteStatement("UPDATE t SET n = 1"), true);
  assert.equal(isWriteStatement("DELETE FROM t"), true);
  assert.equal(isWriteStatement("REPLACE INTO t VALUES (1)"), true);
  assert.equal(isWriteStatement("  insert into t values (1)"), true, "前导空白不得让判据失效");
  assert.equal(isWriteStatement("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"), true,
    "CTE 写必须以写对待");
  assert.equal(isWriteStatement("SELECT * FROM t"), false);
  assert.equal(isWriteStatement("WITH x AS (SELECT 1) SELECT * FROM x"), false,
    "纯读 CTE 不得被误判成写（误判会让纯读去等写许可）");
  assert.equal(isWriteStatement("PRAGMA table_info(t)"), false);
  assert.equal(isWriteStatement("SELECT 'insert into t' AS s"), false,
    "字符串字面量里的写关键字只在 WITH 分支上会被误判，普通 SELECT 不受影响");
});

test("O07 结构判据：连接代理暴露 withWriteTransaction，且事务内语句不再各开窗口", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE t (id TEXT)");
    let windows = 0;
    let holds = 0;
    const gate = {
      scope<T>(fn: () => T): T { windows += 1; return fn(); },
      hold(): () => void { holds += 1; return () => {}; },
      yieldIfStale(): void {}
    };
    const gated = withWriteGate(database, gate);
    // `withDatabaseTransaction` 靠**结构**发现代理（`@rai/storage-sqlite` 不 import 本文件）。
    const scoped = gated as unknown as { withWriteTransaction<T>(fn: () => T): T };
    assert.equal(typeof scoped.withWriteTransaction, "function",
      "代理必须暴露 withWriteTransaction —— 否则仓库层只能逐语句写裸 BEGIN/COMMIT，许可边界又散掉");
    scoped.withWriteTransaction(() => {
      gated.prepare("INSERT INTO t VALUES (?)").run("a");
      gated.prepare("INSERT INTO t VALUES (?)").run("b");
      gated.exec("SAVEPOINT nested");
      gated.prepare("INSERT INTO t VALUES (?)").run("c");
      gated.exec("RELEASE nested");
    });
    assert.equal(holds, 1, `一个短事务只应取一次许可（实际 ${holds}）`);
    assert.equal(windows, 0,
      `事务内的语句必须复用外层许可、不得各开窗口（实际 ${windows}）`);
    const count = gated.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
    assert.equal(count.n, 3);
  } finally {
    database.close();
  }
});

test("O07 判据：事务开着时 yieldIfStale 不得释放许可（真 worker + 真租约）", async () => {
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  // 控制半段：事务**之外**的 yield 必须真的发生 —— 否则"yields === 0"可能只是没跑到。
  const outside = await runLeaseWorker(scheduler, ["scopeYield"]);
  assert.equal(outside.stats.yields, 1, "对照失败：事务之外的让路点没有真的让路，本判据无从判断");

  const inside = await runLeaseWorker(scheduler, ["holdYield"]);
  assert.notEqual(inside.holdYield, null);
  assert.equal(inside.holdYield!.yields, 0,
    "事务途中发生了让路 —— SQLite 事务还开着，许可却被交了回去（O07 的病灶）");
  assert.notEqual(inside.holdYield!.request, 0,
    "让路之后共享内存里的请求被清零了 —— 许可已经不在这条线程手里");
  assert.equal(inside.holdYield!.grant, inside.holdYield!.request);
  // 反向对照：hold 结束之后许可必须回到空闲（不是"永远拿住"）。
  const release = mutations.acquire("HTTP");
  release();
  assert.equal(scheduler.snapshot().active, null);
});
