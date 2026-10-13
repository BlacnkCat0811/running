// 写租约握手成本的**可复现测量**（docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md §3.2.1 修订 5）。
//
// 为什么需要它：PR4 步骤 3 要把"分析全程持写许可"改成"只在短写窗口内持许可"，而分析跑在
// **worker 线程**里（`apps/api/src/recompute-thread.ts`），许可却属于**主线程**的内存对象。
// 跨线程只能靠共享内存：`parentPort` 是异步的，而 pipeline 是同步的；`Atomics.wait` 在
// worker 线程合法、在 Node 主线程非法。于是"授权"必须是一次共享内存握手。
//
// 这个脚本量出**一次握手多少钱**，供窗口粒度决策：
//   node scripts/measure-write-lease.mjs [窗口数，默认 200]
//
// 实测（2026-10-13，本机）：200 个窗口 1468 ms ⇒ **每窗口 7.3 ms**
//（主线程 `setTimeout(1)` 轮询 + `Atomics.wait` 唤醒延迟；一次往返两跳）。
// 结论：逐语句租约不可行（一次年度重算约 10³ 条写语句 ⇒ 光握手 ~7 s）；
// 必须按**有界阶段窗口**发租约（每轮 10–40 个 ⇒ ~0.1–0.3 s）。
//
// ⚠️ 协议必须是**序列号**而不是标志位：朴素标志位协议在第一次授权之后 worker 会"跑飞"
//（后续窗口看到 GRANT 仍为 1 就直接通过，互斥其实已经失效）。本脚本用的就是序列号版本：
//   worker: REQUEST = seq（本窗口序号）→ 等到 GRANT === seq → 窗口结束置 REQUEST = 0
//   main:   GRANT !== 0 且 REQUEST !== GRANT ⇒ 释放（GRANT = 0）
//           REQUEST !== 0 且 GRANT === 0    ⇒ 授权（GRANT = REQUEST；真实实现里先取 admission）
// 真实实现还要处理：worker 退出/崩溃时主线程必须释放（否则租约泄漏）、
// 以及等待超时后的**失败开放**（记录诊断后继续写，而不是把整条队列挂死）。

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (!isMainThread) {
  const words = new Int32Array(workerData.buffer);
  const windows = Number(workerData.windows);
  const started = Date.now();
  for (let seq = 1; seq <= windows; seq += 1) {
    Atomics.store(words, 0, seq);
    const deadline = Date.now() + 5_000;
    while (Atomics.load(words, 1) !== seq) {
      if (Date.now() > deadline) {
        parentPort.postMessage({ error: "lease timeout", seq });
        process.exit(4);
      }
      Atomics.wait(words, 1, Atomics.load(words, 1), 5);
    }
    Atomics.store(words, 0, 0);
  }
  parentPort.postMessage({ windows, ms: Date.now() - started });
} else {
  const buffer = new SharedArrayBuffer(8);
  const words = new Int32Array(buffer);
  const windows = Number(process.argv[2] ?? 200);
  const worker = new Worker(new URL(import.meta.url), { workerData: { buffer, windows } });
  let timer = null;
  const poll = () => {
    const request = Atomics.load(words, 0);
    const grant = Atomics.load(words, 1);
    if (grant !== 0 && request !== grant) Atomics.store(words, 1, 0);
    else if (request !== 0 && grant === 0) Atomics.store(words, 1, request);
    else if (request !== 0 && grant === request) Atomics.notify(words, 1);
    timer = setTimeout(poll, 1);
  };
  poll();
  worker.on("error", (error) => {
    process.stderr.write(`worker error: ${String(error)}\n`);
    process.exit(2);
  });
  worker.once("message", (message) => {
    if (timer) clearTimeout(timer);
    if (message.error) {
      process.stderr.write(`FAILED: ${JSON.stringify(message)}\n`);
      process.exit(4);
    }
    const perWindow = message.ms / message.windows;
    process.stdout.write(
      `写租约握手：${message.windows} 个窗口 ${message.ms} ms ⇒ 每窗口 ${perWindow.toFixed(3)} ms\n`
    );
    process.exit(0);
  });
}
