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
  LEASE_WORDS,
  withWriteGate,
  type WriteLeaseStats
} from "../src/write-lease.js";

/** 一个最小 worker：按脚本取/放租约，用来单独验证协议（不碰数据库）。 */
const WORKER_SCRIPT = `
import { parentPort, workerData } from "node:worker_threads";
import { createWriteLeaseClient } from ${JSON.stringify(new URL("../src/write-lease.ts", import.meta.url).href)};
const words = new Int32Array(workerData.buffer);
const client = createWriteLeaseClient(words, { timeoutMs: workerData.timeoutMs ?? 5000,
  onTimeout: (message) => parentPort.postMessage({ diagnostic: message }) });
for (const instruction of workerData.script) {
  if (instruction === "window") client.scope(() => { Atomics.add(words, 0, 0); });
  else if (instruction === "hold") { client.scope(() => {}); }
  else if (instruction === "yield") client.yieldIfStale(0);
  else if (instruction === "sleep") { const until = Date.now() + 60; while (Date.now() < until) {} }
}
parentPort.postMessage({ done: true, stats: client.stats() });
`;

interface LeaseRun {
  stats: WriteLeaseStats;
  diagnostics: string[];
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
    worker.on("message", (message: { done?: boolean; stats?: WriteLeaseStats; diagnostic?: string }) => {
      if (message.diagnostic !== undefined) diagnostics.push(message.diagnostic);
      if (message.done === true && message.stats) resolve({ stats: message.stats, diagnostics });
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

test("协议：拿不到许可时**失败开放**（有诊断、不挂死），而不是把分析队列堵住", async () => {
  const mutations = new MutationCoordinator();
  const scheduler = new TaskAdmissionScheduler(mutations);
  const blocker = mutations.acquire("HTTP");
  try {
    const run = await runLeaseWorker(scheduler, ["window"], { timeoutMs: 150 });
    assert.equal(run.stats.timeouts, 1, "等不到授权必须记一次超时");
    assert.equal(run.diagnostics.length, 1, "超时必须留下诊断（失败开放要能被看见）");
    assert.match(run.diagnostics[0]!, /写许可/);
  } finally {
    blocker();
  }
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
