import { statSync } from "node:fs";
import { parentPort } from "node:worker_threads";

import { RaiApplicationService, SqliteAnalysisInputReader } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";

import { createWriteLeaseClient, withWriteGate, type WriteLeaseStats } from "./write-lease.js";

/**
 * **常驻**分析 Worker 的线程入口（WP-41 / O12 第二阶段）。
 *
 * 从前这里是一个"一次性脚本"：`workerData` 给一份任务、跑一轮、`postMessage`、线程结束。
 * 于是 `RecomputeWorker.drain()` 每轮都要 `new Worker(...)` —— 每轮重新注册 tsx、重新加载
 * 整条分析依赖链。现在线程常驻，**每轮只发一条消息**；`ready` 只发生一次。
 *
 * 🔴 常驻带来的风险只有一个：**上一轮的东西被带进下一轮**。三个面各自断开：
 *
 * 1. **连接**：每轮 `RaiDatabase.open(..., { migrationPolicy: "refuse" })` 自己开、`finally`
 *    里关（先关只读输入连接，再关写连接 —— 见下面的顺序注释）。migration／恢复／目标切换
 *    之后不会把旧连接或 prepared statement 带到新库；库有待应用迁移时**直接抛错**，
 *    而不是拿旧 schema 接着算。
 * 2. **写许可缓冲区**：主线程**每轮**新分配一段共享内存（见 `RecomputeWorker`），
 *    本文件每轮新建客户端。上一轮残留的 REQUEST（线程被杀时的半开请求）因此不可能被当成
 *    "已经授出去的许可"。
 * 3. **数据库目标**：每轮重读 `dev:ino`，同一路径换了文件（恢复／换库）会被看见并回报
 *    （`targetChanged`），主线程据此在主日志里留痕。
 *
 * ⚠️ 单写者纪律没有放松：写仍然经过 {@link withWriteGate} 的连接代理，许可仍由主线程的
 * `TaskAdmission` 授权（`createWriteLeaseServer`），CPU 计算期间不持许可。
 */

export interface RecomputeRoundMessage {
  kind: "round";
  /** 轮次序号：线程常驻 ⇒ 回复必须能对上"是哪一轮"。 */
  round: number;
  databasePath: string;
  /** 本轮专用的写许可共享内存（每轮新分配，绝不跨轮复用）。 */
  lease?: SharedArrayBuffer;
}

export interface RecomputeRoundReply {
  kind: "round-result";
  round: number;
  ran: boolean;
  requeued: boolean;
  jobId: string | null;
  lease: WriteLeaseStats | null;
  /** 本轮观测到的数据库目标（`dev:ino`）。 */
  targetKey: string | null;
  /** 与上一轮相比目标换了文件 —— 连接已按当前文件重开，旧状态一律没有带走。 */
  targetChanged: boolean;
  rssKiB: number;
}

function databaseTargetKey(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * 跑**一轮**分析（真实入口：常驻循环每条 `round` 消息调它一次）。
 *
 * 返回值把"这一轮的结局"和"这一轮看到的目标"一起交出去，主线程据此结算与留痕。
 */
export async function runOneRecomputeRound(
  message: RecomputeRoundMessage,
  previousTargetKey: string | null
): Promise<{ reply: RecomputeRoundReply; targetKey: string | null }> {
  const databasePath = String(message.databasePath);
  const targetKey = databaseTargetKey(databasePath);
  const targetChanged = previousTargetKey !== null && targetKey !== null && targetKey !== previousTargetKey;

  // 🔴 每轮重新打开：连接与 prepared statement **不跨轮**（migration/恢复/目标切换之后
  // 旧连接描述的是另一个库）。`migrationPolicy: "refuse"` 让"有待应用迁移"变成一次显式
  // 失败，而不是用旧 schema 继续算。
  const store = await RaiDatabase.open(databasePath, { migrationPolicy: "refuse" });

  // 写租约（PR4 §3.2.1 / A11）：主线程持有"单写者"许可，本线程在**每个写语句**前后
  // 通过共享内存取/放。没有缓冲区时（单测、CLI、老调用方）一切照旧 —— 不经过代理。
  //
  // 🔴 用**连接代理**而不是在 pipeline 里逐处包窗口：代理让"经过这条连接的所有写都在许可内"
  // 结构性成立（漏写面收敛到"连接"这一个可枚举的点），逐处包只能靠代码评审保证不漏。
  const lease = message.lease ? createWriteLeaseClient(new Int32Array(message.lease)) : null;
  const gatedStore = lease === null ? store : {
    database: withWriteGate(store.database, lease),
    // 这条走 store 自己的连接（不经代理），所以显式包一层 —— 它也是写。
    pruneSupersededModelRuns: (options?: { keepRecent?: number }) =>
      lease.scope(() => store.pruneSupersededModelRuns(options))
  };

  // O06-A / WP-22：输入绑定要在**独立只读连接**的同一个读事务里捕获 —— 用写租约代理那条连接
  // 读"输入是哪一版"，读到的东西会被并发批次改动，而那正是 O06 的病灶。只读连接不参与写租约，
  // 也不影响单写者纪律（它不开写事务、不迁移）。
  const inputDatabase = RaiDatabase.openReadonly(databasePath);

  let completed: ReturnType<RaiApplicationService["runNextJob"]> = null;
  try {
    completed = new RaiApplicationService(
      gatedStore,
      "owned",
      undefined,
      lease === null ? undefined : { scope: (fn) => lease.scope(fn), yieldIfStale: (maxHoldMs) => lease.yieldIfStale(maxHoldMs) },
      new SqliteAnalysisInputReader(inputDatabase)
    ).runNextJob();
  } finally {
    // 🔴 先关连接（释放 SQLite 锁），**本轮结算之后**主线程才 dispose 租约（释放应用许可）。
    // 顺序反过来的话，"库还锁着、许可已经放回去"会短暂成立 —— 那正是 O07 的形态。
    inputDatabase.close();
    store.close();
  }
  return {
    targetKey,
    reply: {
      kind: "round-result",
      round: message.round,
      ran: completed !== null,
      // 可重试的调度失败（写许可等待超时）会让任务**回到 queued** 而不是终态失败；
      // 主线程据此退避一轮再调度，而不是立刻重跑同一批写。
      requeued: completed?.status === "queued",
      jobId: completed?.id ?? null,
      lease: lease?.stats() ?? null,
      targetKey,
      targetChanged,
      rssKiB: Math.round(process.memoryUsage().rss / 1024)
    }
  };
}

/** 常驻循环只在线程里启动（单测直接 import 本文件时 `parentPort` 为空）。 */
if (parentPort !== null && parentPort !== undefined) {
  const port = parentPort;
  let previousTargetKey: string | null = null;
  let busy = false;
  port.on("message", (message: RecomputeRoundMessage) => {
    if (message?.kind !== "round") return;
    if (busy) {
      // 主线程一次只发一轮（`drain()` 是串行的）；真出现并发说明调度坏了，宁可显式报错
      // 也不要两轮共用一个连接与一段共享内存。
      port.postMessage({
        kind: "round-result", round: message.round, ran: false, requeued: false, jobId: null,
        lease: null, targetKey: previousTargetKey, targetChanged: false, rssKiB: 0
      });
      return;
    }
    busy = true;
    void (async () => {
      try {
        const { reply, targetKey } = await runOneRecomputeRound(message, previousTargetKey);
        if (targetKey !== null) previousTargetKey = targetKey;
        port.postMessage(reply);
      } catch (error) {
        // 抛错也是"这一轮的结局"：按轮次回报，主线程照样 dispose 租约并决定重试/终态失败。
        // 线程**不被**这条错误弄死（下一轮会重新开连接），但错误必须可归因到轮次。
        const failure = error instanceof Error ? error : new Error(String(error));
        port.postMessage({
          kind: "round-failed", round: message.round, error: failure.message
        });
      } finally {
        busy = false;
      }
    })();
  });
  // 🔴 第一条消息就是 `ready`：线程内 tsx 注册与模块加载已经完成。主线程据此把
  // "启动成本"与"每一轮的分析成本"分开记账。
  port.postMessage({ kind: "ready" });
}
