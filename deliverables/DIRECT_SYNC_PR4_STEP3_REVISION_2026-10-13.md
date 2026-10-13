# PR4 步骤 3 动工前的实测修订：短写租约的窗口粒度（2026-10-13）

对应 [PR4 落地设计 §3.2.1](../docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md)。本轮**不落地**租约本身，
只把"能不能按 §3.2 的四窗口直接动手"这个问题**用实测回答掉**，并把结论写进设计文档。

**为什么必须先做这件事**：§3.2 是按"整轮 drain 持锁 = 一个长事务"的假设写的。
假设错一处，实现就会错一整片 —— 而 PR4 的 §9 本来就把"pipeline 内部是否存在跨阶段未提交写的
相互依赖"列为**动工前必须定掉**的未决项。

---

## 1. 审计结论（逐行核对 + 第二条连接实测）

| # | 结论 | 证据 |
|---|---|---|
| 1 | **分析根本没有长事务**：`runFullRecompute` 内无 `BEGIN`/`COMMIT`/`SAVEPOINT`（全文件 `.exec(` 命中 0），pipeline 直接 `prepare().run()` 绕开了 `RaiDatabase` 自己的事务入口 ⇒ 每句自动提交。实测（`AFTER INSERT` 探针里开第二条只读连接）：跑到 `INSERT INTO model_runs` 时 `feature_runs` **已对别的连接可见**；跑到 `INSERT INTO training_metric_runs` 时 `model_runs` 也已可见；只有发布指针（`jobs.complete` 的 `BEGIN IMMEDIATE`）真正原子 | `packages/application/src/services/recompute-pipeline.ts:193-350`；`packages/storage-sqlite/src/database.ts:2118-2123`；`recompute-job-repository.ts:308` |
| 2 | ⇒ **要改的不是事务边界，而是"何时持写许可"**；"中间态对读侧可见"今天就已存在，不是拆分引入的 | 同上 |
| 3 | **窗口顺序不能照抄 §3.2 的语义标签**：代码里 `createModelRun`（:219）**先于** `createTrainingMetricRun`（:221），而 `training_metric_runs.model_run_id` 是 `REFERENCES model_runs(id)` 且外键 ON ⇒ 按标签切会在指标窗口撞 `FOREIGN KEY constraint failed` | `recompute-pipeline.ts:219-221`；`database.ts:722` |
| 4 | **跨阶段读回自己刚写的行是常态，但都靠"同一连接 + 逐窗口提交"成立**：(a)→(c) 复用前缀与 `INSERT…SELECT`；(b)→(d) 发布阶段读 `daily_training_metrics`/`daily_zone_profiles`/`training_metric_runs.status`；(c)→(d) 发布阶段读候选的 assessments/snapshots/bundles | §3.2.1 修订 3 的清单 |
| 5 | **(d) 内部不许再切**：`verifyAndPoint` 重读 bundle/lineage/snapshots 并与指针同事务 | `model-release-v2.test.ts:63-66`；`service.test.ts:484-513` |
| 6 | **不许引入"阶段间全有全无"**：两条既有用例**依赖**候选行在后续失败后仍存在（失败路径是状态写入，从不回滚删除） | `service.test.ts:484-513`；`apps/api/test/analysis-failure-isolation.test.ts`（A10） |
| 7 | **非事务副作用**：`process.send({type:"rai:compute-performance"})` 每轮 3 次，窗口边界不得移动 `measureCompute` 的包围范围，否则诊断口径静默变化 | `recompute-pipeline.ts:2413-2425` |

## 2. 握手成本实测（决定窗口粒度）

worker 线程与主线程之间只能靠共享内存（`parentPort` 异步 vs pipeline 同步；`Atomics.wait`
在 worker 合法、在主线程非法）。可复现脚本：`scripts/measure-write-lease.mjs`。

```text
写租约握手：200 个窗口 1415 ms ⇒ 每窗口 7.075 ms
写租约握手： 40 个窗口  254 ms ⇒ 每窗口 6.350 ms
```

- ⚠️ **朴素标志位协议有正确性缺陷**：第一次授权后 worker 会"跑飞"（后续窗口看到 `GRANT` 仍为 1
  就直接通过，互斥已失效）。必须用**序列号**协议（`GRANT === 本次 REQUEST`）——这正是脚本里跑的那版。
- ⇒ **逐语句租约不可行**：一次年度重算约 10³ 条写语句 ⇒ 光握手 ~7 s。
- ⇒ 采用**有界阶段窗口**（每轮 10–40 个 ⇒ ~0.1–0.3 s）+ 长计算里的**显式让路点**。

## 3. 修订后的窗口形状（取代 §3.2 的四窗口标签）

W1 特征轮 → W2 模型/指标轮（**顺序与代码一致**）→ W3 时间线重放轮 → W4 发布（不可再切）
→ W5 作业簿记。细则见设计文档 §3.2.1 的表。

两条配套：
- **让路点**：三个计算循环每 N 条调用一次 `gate.yield()`，把"接收优先"的等待上界从"一整轮"
  压到"一批"。
- **结构性判据**：必须能证明"分析路径上没有不经过 gate 的写"，而不是"我包了这几处"。

## 4. 本轮**没有**做的事（如实标注）

- ⛔ 租约机制本身（`WriteGate`/共享内存协议/`RecomputeWorker.drain()` 改造）**未实现**，代码零改动。
  A11 仍然**未覆盖**（§14.2 的未覆盖项仍是 1 项：A11）。
- ⛔ 窗口的 N（让路频率）未定，实施时以实测为准。
- ⛔ "读阶段不持许可"之后的**分析输入稳定性**依赖 PR4 的"固定 `FactsReader`"（未做）；
  在它落地之前，稳定性依赖"后续批次会重新登记分析"这一既有时序 —— 这一点必须与租约同批说明。

## 5. 下一步

按修订后的形状实现：①共享内存租约协议（序列号 + 退出释放 + 超时失败开放 + 诊断）；
②`RecomputeWorker.drain()` 去掉全程持锁，改为线程存活期内的授权循环；③pipeline 的 W1–W5 窗口
+ 让路点；④A11 的锁时间线用例（分析进行中仍能接收新批次、轻量 API 无 409 窗口）。
