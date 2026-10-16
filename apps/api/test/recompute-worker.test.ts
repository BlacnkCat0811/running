import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DIRECT_SYNC_ANALYSIS_REQUEST_MODE } from "@rai/contracts";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";

import { RecomputeWorker } from "../src/recompute-worker.js";

/**
 * An idle `drain()` used to spawn a worker thread anyway, and that thread registers
 * `tsx` from scratch (~2.5 s measured on this machine). 那时整轮 drain 持着全局写许可，
 * 所以这段窗口里每个写路由都拿到 `409 mutation_conflict` —— `server-runtime.test.ts`
 * 曾经因此对着新起的 API 抖动。
 *
 * ⚠️ 2026-10-13（PR4 步骤 3 / A11）之后 drain **不再持锁**：许可只在 worker 线程的写语句期间被持有，
 * 所以"空闲也要 spawn 2.5 s"这件事现在的代价是**线程开销本身**（而不是"整窗口 409"）。
 * 这条用例仍然成立且仍然必要 —— 空队列不该付线程开销。
 *
 * `runOneInWorkerThread` is the only spawn site, so counting its invocations is the
 * direct measurement of "did an idle drain pay for a thread it had no work for".
 *
 * ⚠️ 2026-10-16（WP-41 / O12 第二阶段）**订正判据**：线程改为**常驻**（跨轮复用）之后，
 * "调用次数 = 起过几条线程"这个等式不再成立 —— 同一条线程可以跑很多轮。所以上面数的是
 * **轮数**（调度粒度），而"到底起了几条线程"改由 `workerStartupStats().started` 数出来
 * （见本文件末尾的常驻用例）。两问必须分开数，否则"复用"会被读成"没起线程"。
 */

interface RecomputeWorkerTestSurface {
  runOneInWorkerThread(): Promise<boolean>;
}

const withDatabase = async (action: (databasePath: string) => Promise<void>): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-worker-"));
  try {
    mkdirSync(join(root, "var"));
    const databasePath = join(root, "var", "rai.sqlite");
    (await RaiDatabase.open(databasePath, { createMigrationBackup: false })).close();
    await action(databasePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const enqueue = (databasePath: string, jobType: "snapshot_refresh" | "full_recompute"): void => {
  const database = new DatabaseSync(databasePath);
  try {
    new RecomputeJobRepository(database).enqueue(jobType, null, {});
  } finally {
    database.close();
  }
};

/** Stubs the spawn and counts it, mirroring the recompute-worker cases in worker.test.ts. */
const countingWorker = async (
  databasePath: string
): Promise<{ worker: RecomputeWorker; spawns: () => number; settle: () => Promise<void> }> => {
  const worker = new RecomputeWorker(databasePath);
  let spawns = 0;
  (worker as unknown as RecomputeWorkerTestSurface).runOneInWorkerThread = async () => {
    spawns += 1;
    return false;
  };
  return {
    worker,
    spawns: () => spawns,
    settle: async () => {
      const deadline = Date.now() + 10_000;
      while (worker.isRunning && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(worker.isRunning, false, "the scheduled drain must finish");
    }
  };
};

test("hasPending tracks queued and claimed jobs but not terminals", async () => {
  await withDatabase(async (databasePath) => {
    const database = new DatabaseSync(databasePath);
    try {
      const jobs = new RecomputeJobRepository(database);
      assert.equal(jobs.hasPending(), false, "a fresh database has nothing pending");
      const jobId = jobs.enqueue("snapshot_refresh", null, {});
      assert.equal(jobs.hasPending(), true, "a queued job is pending");
      jobs.claimNext();
      assert.equal(jobs.hasPending(), true, "a claimed (running) job must stay pending for recovery");
      jobs.fail(jobId, new Error("fixture"));
      assert.equal(jobs.hasPending(), false, "a terminal job is not pending");
    } finally {
      database.close();
    }
  });
});

test("an idle drain never spawns a worker thread", async () => {
  await withDatabase(async (databasePath) => {
    const { worker, spawns, settle } = await countingWorker(databasePath);
    try {
      worker.schedule();
      assert.equal(worker.isRunning, true, "schedule must mark the worker as running");
      await settle();
      assert.equal(
        spawns(), 0,
        "an idle drain must not spawn a thread: tsx registration costs ~2.5 s and the whole "
          + "worker-thread lifecycle is what we would be paying for nothing"
      );
    } finally {
      await worker.close();
    }
  });
});

test("a queued job still spawns a worker thread", async () => {
  await withDatabase(async (databasePath) => {
    enqueue(databasePath, "snapshot_refresh");
    const { worker, spawns } = await countingWorker(databasePath);
    try {
      worker.schedule();
      const deadline = Date.now() + 10_000;
      while (spawns() === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(spawns(), 1, "the idle guard must not skip a queued job");
    } finally {
      await worker.close();
    }
  });
});

/**
 * 2026-10-13 线上首爆：直连车道在事务里登记了 `recompute_jobs`，但没有任何人唤醒消费者
 * ⇒ 任务永远 `queued` ⇒ `isDatabaseWriteBusy()` 把 `queued` 算作忙 ⇒ 所有写端点 409，
 * 而被 409 就走不到后面的 `schedule()`（无自愈路径）。
 *
 * 这条用例钉住**兜底巡检**这条通道本身：空队列不动作，有任务就唤醒。
 * 与 `direct-sync-analysis-registration.test.ts` 里那条源码守卫配对 ——
 * 一条证明"巡检有效"，一条证明"终态回调确实接了巡检要补的那一次唤醒"。
 */
test("wakeIfPending：空队列不动作，有 queued 任务就唤醒（兜底巡检的有效性）", async () => {
  await withDatabase(async (databasePath) => {
    const { worker, spawns, settle } = await countingWorker(databasePath);
    try {
      // ① 空队列：巡檢不得 spawn（否则空转线程会变成定时成本）。
      worker.wakeIfPending();
      await settle();
      assert.equal(spawns(), 0, "空队列的巡检不得 spawn worker 线程");

      // ② 有 queued 任务：巡检必须真的把它唤醒 —— 这正是线上那次缺失的一步。
      enqueue(databasePath, "snapshot_refresh");
      worker.wakeIfPending();
      const deadline = Date.now() + 10_000;
      while (spawns() === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(spawns(), 1,
        "巡检必须唤醒 queued 任务：否则它永远停在 queued，写通道被封且无自愈路径");
    } finally {
      await worker.close();
    }
  });
});

/**
 * WP-41 / O12 第二阶段：分析线程**常驻**（跨轮复用）。
 *
 * 🔴 为什么这条必须与"空闲不 spawn"分开：那条钉的是"**有没有必要**起线程"（0 次），
 * 这条钉的是"起**几条**"。老实现一轮一条线程，于是"调用 3 次 ⇒ 3 条线程"；常驻之后
 * 同一等式不再成立（3 轮可能只有 1 条线程）。判据因此拆成两个独立数字：
 *   · `runOneInWorkerThread()` 调用次数 = **轮数**（调度粒度）；
 *   · `workerStartupStats().started` = **真正起过的线程数**（spawn 粒度）。
 * "3 轮 1 条线程"于是可以被直接断言 —— 复用省下的正是（轮数 − 1）次 tsx 注册与依赖链加载。
 */
test("常驻分析线程：连续多轮只起一条线程，且轮次之间不持有线程句柄", async () => {
  await withDatabase(async (databasePath) => {
    const worker = new RecomputeWorker(databasePath);
    const surface = worker as unknown as {
      runOneInWorkerThread(): Promise<{ ran: boolean }>;
      activeWorker: unknown;
    };
    try {
      for (let round = 0; round < 3; round += 1) {
        const outcome = await surface.runOneInWorkerThread();
        assert.equal(outcome.ran, false, "空队列的轮次必须如实报告「没跑」");
        assert.equal(surface.activeWorker, null,
          "轮次结束之后不得再持有线程句柄（常驻的是线程，不是「正在跑一轮」这个状态）");
      }
      assert.equal(worker.workerStartupStats().rounds, 3, "三轮就是三轮：轮数是调度粒度");
      assert.equal(worker.workerStartupStats().started, 1,
        "3 轮只允许起 1 条线程（老实现是 3 条：tsx 注册与依赖链加载每轮各付一遍）");
      assert.equal(worker.workerStartupStats().retired, 0, "没有崩溃就不得替换线程");

      // 租约必须在轮次之间**放回去**：常驻线程若把写许可也"常驻"下来，写路由会永久 409。
      assert.equal(worker.leaseStats(), null, "没有分析任务时不得留下租约统计（说明租约已归还）");
    } finally { await worker.close(); }
  });
});

/**
 * 组合验证：把三段拼起来**真跑一次**。
 *
 * 上面那条用 stub 计数证明"唤醒会发生"，`direct-sync-analysis-registration.test.ts` 的步骤 1 用例
 * 证明"消费者能跑直连载荷" —— 但两者合起来仍**不等于**"接起来能跑完"。这一条不 stub
 * `runOneInWorkerThread`，因此覆盖「登记 → 唤醒 → worker 线程 → claimNext → runDirectSyncAnalysis
 * → 终态」整条链路。
 *
 * 这正是 2026-10-13 线上缺的那一步：登记与消费之间的那一次 `schedule()`。
 */
test("组合验证：登记后经唤醒真的被消费者跑完（不 stub spawn）", async () => {
  await withDatabase(async (databasePath) => {
    // 与 `direct-sync-ingest.ts` 在同一个主库事务里做的事相同。
    const database = new DatabaseSync(databasePath);
    let jobId: string;
    try {
      jobId = new RecomputeJobRepository(database).enqueue("import", null, {
        mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE
      });
    } finally {
      database.close();
    }

    const worker = new RecomputeWorker(databasePath);
    try {
      worker.wakeIfPending();
      const deadline = Date.now() + 120_000;
      let status = "";
      let failure: string | null = null;
      let probeError: string | null = null;
      while (Date.now() < deadline) {
        // 🔴 探针用**读写连接 + `busy_timeout`**：WAL 下 `readOnly: true` 的连接撞上 worker 的写事务
        // 会直接抛 `database is locked`（该连接没有 `busy_timeout`）—— 那不是任务的结论。
        // 探针的读错误一律吞掉、下一轮再读，别把"读不到"当成"没跑完"。
        try {
          const probe = new DatabaseSync(databasePath);
          try {
            probe.exec("PRAGMA busy_timeout = 5000");
            const row = probe.prepare(
              "SELECT status, error_json AS error FROM recompute_jobs WHERE id = ?"
            ).get(jobId) as { status: string; error: string | null } | undefined;
            status = row?.status ?? "";
            failure = row?.error ?? null;
            probeError = null;
          } finally {
            probe.close();
          }
        } catch (error) {
          probeError = error instanceof Error ? error.message : String(error);
        }
        if (status === "succeeded" || status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal(
        status, "succeeded",
        `登记 → 唤醒 → 消费必须真的跑完；终态=${status}，error=${failure ?? probeError ?? "null"}`
      );
    } finally {
      await worker.close();
    }
  });
});
