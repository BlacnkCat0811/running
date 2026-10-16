// 写租约**交接成本**的仓库级基准（O08 / WP-30；替换了此前内联演示协议的旧口径）。
//
// 为什么需要它：PR4 步骤 3 把"分析全程持写许可"改成"只在短写窗口内持许可"，而分析跑在
// **worker 线程**里（`apps/api/src/recompute-thread.ts`），许可却属于**主线程**的内存对象。
// 跨线程只能靠共享内存：`parentPort` 是异步的，而 pipeline 是**同步**的；`Atomics.wait` 在
// worker 线程合法、在 Node 主线程非法。于是"授权"必须是一次共享内存握手 —— 而这个握手
// 每次窗口都要发生，它的单价决定了"能不能逐语句取租约"。
//
// 🔴 它测的是**生产实现**：真 worker 线程 + 真 `SharedArrayBuffer` + 真
// `createWriteLeaseClient` / `createWriteLeaseServer` + 真 `TaskAdmissionScheduler`。
// ⛔ 旧版本在本文件里**重写了一遍协议**（`setTimeout(1)` 轮询 + 内联主线程状态机），
// 于是它测的是演示脚本自己的轮询设计，不是仓库里跑的代码 —— 那种数字不能用来验收。
//
//   node scripts/measure-write-lease.mjs [窗口数，默认 200] [轮数，默认 30]
//
// 实测（2026-10-16，Node v22.23.2，本机 `darwin/x64`、AMD Ryzen 5 3600X 6 核；
// 测量期间同一台机器上还有别的测试套件在跑，1 分钟负载 ≈7 ⇒ 下面是**并发负载下**的口径，
// 换机器/换时刻请以当次输出为准）：
//   · O08 之前（把"授权/释放之后也等一次"这个旧行为装回去，用**同一个**基准测）：
//     200 空窗口 p50 2397 ms（min 2391 / max 2437）⇒ **12.0 ms/窗口** —— 与审查文档
//     §O08 的 2170 ms / 10.9 ms/窗口 是同一量级。旧注释里"每窗口 ~7 ms（轮询设计）"说的是
//     **旧脚本自己内联的演示协议**，不是这条生产路径，已作废。
//   · O08 之后：200 空窗口 p50 113–141 ms、p95 175–209 ms、max 242 ms、**min 74–78 ms**
//     （3 批 × 30 轮），每窗口 p50 0.57–0.71 ms。⚠️ 目标 <100 ms **只在负载低的那几轮
//     达成**（min 74 ms），并发负载下 p50 还没进线 —— 但剩下的成本已经不在握手逻辑里：
//       · 一个窗口必须付**两次跨线程唤醒**（worker→主线程授权、主线程→worker 发许可）；
//       · 本机主线程 `Atomics.waitAsync` 的唤醒延迟 p50 0.22–0.29 ms / p95 0.7–1.9 ms
//         （实测见下），两次唤醒就是 0.5 ms 量级；
//       · **不含任何生产代码**的裸 ping-pong（一次性临时探针，未入库：同样的共享内存协议、
//         无 admission、无客户端）同口径实测 200 窗口 71–168 ms —— 与上面一致，说明差值
//         不在租约实现里。
//     400 次唤醒 × ~0.25 ms ≈ 100 ms：目标就压在本机唤醒延迟的天花板上。
//
// ⚠️ 协议必须是**序列号**而不是标志位：朴素标志位协议在第一次授权之后 worker 会"跑飞"
//（后续窗口看到 GRANT 仍为 1 就直接通过，互斥其实已经失效）。生产实现用的就是序列号版本：
//   worker: REQUEST = seq（本窗口序号）→ 等 GRANT === seq → 窗口结束置 REQUEST = 0
//   main:   GRANT !== 0 且 REQUEST !== GRANT ⇒ 释放许可（GRANT = 0）
//           REQUEST !== 0 且 GRANT === 0    ⇒ 取 admission 后授权（GRANT = REQUEST）
//           admission 拿不到 ⇒ blocked（有界退避 + 状态变化通知），而不是固定等待
//
// ⚠️ 本脚本的数字是**本机微基准**，不是对手机或云主机的承诺：那里的调度粒度、核数、
// 是否被抢占都不同。它回答的是"这次改动有没有把固定等待留在路径上"。
// 退出码：0 = 200 窗口的中位数 < 100 ms（O08 验收目标）；1 = 未达成（数字照样打印）。

import { register } from "tsx/esm/api";

// 生产代码是 TypeScript：主线程用 tsx 的运行时注册器加载（`node --import tsx` 等价，
// 但本脚本要求 `node scripts/measure-write-lease.mjs …` 直接可跑），worker 线程里
// loader hook 不继承，所以 worker 自己再注册一次（见下面的 workerSource）。
register();

const os = await import("node:os");
const { Worker } = await import("node:worker_threads");

const { createWriteLeaseServer, LEASE_WORDS } = await import("../apps/api/src/write-lease.ts");
const { TaskAdmissionScheduler } = await import("../apps/api/src/task-admission.ts");
const { MutationCoordinator } = await import("../apps/api/src/mutation-coordinator.ts");

const windows = Number.parseInt(process.argv[2] ?? "", 10) || 200;
const runs = Number.parseInt(process.argv[3] ?? "", 10) || 30;
/** 每次握手的最坏可接受等待：真卡住时**不要**静默跑成"很慢的基准"。 */
const windowTimeoutMs = 5_000;
/** 验收目标（O08）：200 个空窗口的总耗时上界。 */
const targetMs = 100;
/** 控制槽（本基准自己的，不属于租约协议）：`LEASE_WORDS` 之后的一个字。 */
const CONTROL = LEASE_WORDS;
const tsxApiUrl = import.meta.resolve("tsx/esm/api");
const leaseUrl = new URL("../apps/api/src/write-lease.ts", import.meta.url).href;

// worker 线程里 `--import tsx` 不会被继承（实测：worker 只跑 Node 自带的 strip-only），
// 而 strip-only 拒绝 TypeScript 参数属性等语法 ⇒ 必须在 worker 内显式注册同一个 loader。
// 装载发生在**计时区间之外**：这里量的是握手，不是 worker 启动。
const workerSource = `
import { parentPort, workerData } from "node:worker_threads";
const { register } = await import(${JSON.stringify(tsxApiUrl)});
register();
const { createWriteLeaseClient } = await import(${JSON.stringify(leaseUrl)});
const words = new Int32Array(workerData.buffer);
const client = createWriteLeaseClient(words, { timeoutMs: workerData.timeoutMs });
parentPort.postMessage({ ready: true });
try {
  for (let run = 1; run <= workerData.runs; run += 1) {
    // 等主线程发令。worker 线程里 Atomics.wait 合法（主线程不合法，所以只能用这个方向）。
    while (Atomics.load(words, workerData.control) !== run) {
      Atomics.wait(words, workerData.control, Atomics.load(words, workerData.control), 50);
    }
    const started = Date.now();
    for (let index = 0; index < workerData.windows; index += 1) client.scope(() => {});
    parentPort.postMessage({
      run, ms: Date.now() - started, windows: client.stats().windows, stats: client.stats()
    });
  }
  parentPort.postMessage({ done: true, stats: client.stats() });
} catch (error) {
  parentPort.postMessage({ error: { name: String(error?.name ?? "Error"), message: String(error?.message ?? error) } });
}
`;

const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (LEASE_WORDS + 1));
const words = new Int32Array(buffer);
const mutations = new MutationCoordinator();
const scheduler = new TaskAdmissionScheduler(mutations);
const server = createWriteLeaseServer(scheduler.owner("recompute"), words);
const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`), {
  workerData: { buffer, windows, runs, timeoutMs: windowTimeoutMs, control: CONTROL }
});

/** 收满 N 条消息（ready / 每轮结果 / done）；任何一条是 error 就直接失败。 */
const inbox = [];
const waiters = [];
worker.on("message", (message) => {
  if (message.error) {
    process.stderr.write(`基准失败：${message.error.name}: ${message.error.message}\n`);
    process.exit(1);
  }
  const resolve = waiters.shift();
  if (resolve) resolve(message);
  else inbox.push(message);
});
worker.on("error", (error) => {
  process.stderr.write(`worker error: ${String(error)}\n`);
  process.exit(2);
});
const receive = () => inbox.length > 0
  ? Promise.resolve(inbox.shift())
  : new Promise((resolve) => waiters.push(resolve));

const percentile = (sorted, fraction) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

await receive(); // ready
const perRun = [];
for (let run = 1; run <= runs; run += 1) {
  Atomics.store(words, CONTROL, run);
  Atomics.notify(words, CONTROL);
  const message = await receive();
  perRun.push(message.ms);
}
const finished = await receive(); // done
await worker.terminate();
const serverStats = server.stats();
server.dispose();

const sorted = [...perRun].sort((left, right) => left - right);
const client = finished.stats;
const perWindow = (ms) => ms / windows;
const cpu = os.cpus()[0]?.model ?? "unknown";
// ⚠️ 只输出计数与耗时，不输出任何健康数据（本基根本来也不碰数据）。
process.stdout.write(
  [
    `写租约交接基准（生产实现：createWriteLeaseServer + createWriteLeaseClient + TaskAdmissionScheduler）`,
    `运行环境：Node ${process.version} ${process.platform}/${process.arch}，${cpu} ×${os.cpus().length}，` +
      `轮数 ${runs} × 窗口 ${windows}（每轮之间空转，不含 worker 启动）`,
    `每轮 200 空窗口耗时：p50 ${percentile(sorted, 0.5)} ms / p95 ${percentile(sorted, 0.95)} ms / ` +
      `max ${sorted[sorted.length - 1]} ms / min ${sorted[0]} ms`,
    `每窗口：p50 ${perWindow(percentile(sorted, 0.5)).toFixed(3)} ms / ` +
      `p95 ${perWindow(percentile(sorted, 0.95)).toFixed(3)} ms / max ${perWindow(sorted[sorted.length - 1]).toFixed(3)} ms`,
    `客户端统计（worker 线程回报）：windows=${client.windows} waitMs=${client.waitMs} yields=${client.yields} ` +
      `timeouts=${client.timeouts} transactions=${client.transactions} slowTransactions=${client.slowTransactions}`,
    `授权侧统计（主线程）：grants=${serverStats.grants} releases=${serverStats.releases} ` +
      `busyWaits=${serverStats.busyWaits} withdraws=${serverStats.withdraws} waitedOn=${JSON.stringify(serverStats.waitedOn)}`,
    `验收（O08）：${windows} 空窗口 < ${targetMs} ms —— ` +
      `${percentile(sorted, 0.5) < targetMs ? "达成" : "未达成"}（p50 ${percentile(sorted, 0.5)} ms）`
  ].join("\n") + "\n"
);
process.exit(percentile(sorted, 0.5) < targetMs ? 0 : 1);
