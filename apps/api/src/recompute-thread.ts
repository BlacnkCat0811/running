import { parentPort, workerData } from "node:worker_threads";

import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";

import { createWriteLeaseClient, withWriteGate } from "./write-lease.js";

const data = workerData as { databasePath: string; lease?: SharedArrayBuffer };
const databasePath = String(data.databasePath);
const store = await RaiDatabase.open(databasePath, { migrationPolicy: "refuse" });

// 写租约（PR4 §3.2.1 / A11）：主线程持有"单写者"许可，本线程在**每个写语句**前后
// 通过共享内存取/放。没有缓冲区时（单测、CLI、老调用方）一切照旧 —— 不经过代理。
//
// 🔴 用**连接代理**而不是在 pipeline 里逐处包窗口：代理让"经过这条连接的所有写都在许可内"
// 结构性成立（漏写面收敛到"连接"这一个可枚举的点），逐处包只能靠代码评审保证不漏。
const lease = data.lease ? createWriteLeaseClient(new Int32Array(data.lease)) : null;
const gatedStore = lease === null ? store : {
  database: withWriteGate(store.database, lease),
  // 这条走 store 自己的连接（不经代理），所以显式包一层 —— 它也是写。
  pruneSupersededModelRuns: (options?: { keepRecent?: number }) =>
    lease.scope(() => store.pruneSupersededModelRuns(options))
};

let completed: ReturnType<RaiApplicationService["runNextJob"]> = null;
try {
  completed = new RaiApplicationService(
    gatedStore,
    "owned",
    undefined,
    lease === null ? undefined : { scope: (fn) => lease.scope(fn), yieldIfStale: (maxHoldMs) => lease.yieldIfStale(maxHoldMs) }
  ).runNextJob();
} finally {
  // 🔴 先关连接（释放 SQLite 锁），线程退出后主线程才 dispose 租约（释放应用许可）。
  // 顺序反过来的话，"库还锁着、许可已经放回去"会短暂成立 —— 那正是 O07 的形态。
  store.close();
}
parentPort?.postMessage({
  ran: completed !== null,
  // 可重试的调度失败（写许可等待超时）会让任务**回到 queued** 而不是终态失败；
  // 主线程据此退避一轮再调度，而不是立刻重跑同一批写。
  requeued: completed?.status === "queued",
  jobId: completed?.id ?? null,
  lease: lease?.stats() ?? null
});
