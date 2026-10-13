# PR4 步骤 3：短写租约（§14.2 A11）落地记录（2026-10-13）

依据：[PR4 落地设计 §3.2.1/§3.2.2](../docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md)、
[上位设计 §6](../docs/SQLITE_DIRECT_SYNC_DESIGN.md)。

**判据（§14.2 A11）**：后台计算不长期占写锁 —— CPU 分析期间仍可接收新批次；
写锁仅覆盖短 SQL 事务；不能仅把旧长事务换到 Worker。

---

## 1. 做了什么

| 项 | 位置 | 说明 |
|---|---|---|
| 租约协议 | `apps/api/src/write-lease.ts`（新） | 共享内存 + **序列号**协议（标志位协议会"跑飞"，见 §3）；主线程 `Atomics.waitAsync` 事件驱动授权；worker 侧 `Atomics.wait` 同步等待 |
| 分析侧接线 | `apps/api/src/recompute-thread.ts` | 把分析**唯一那条连接**包成 `withWriteGate(...)` 代理；`pruneSupersededModelRuns` 显式包一层（它走 store 自己的连接） |
| drain 改造 | `apps/api/src/recompute-worker.ts` | **不再在 spawn 之前取许可**；许可只在 worker 线程存活期内按窗口授予；线程退出（含崩溃）`dispose()` 释放 |
| 覆盖收窄 | `packages/application/src/write-gate.ts`（新） | 新增 `AnalysisStore`：分析只用到 `database` 与 `pruneSupersededModelRuns` **两个**成员 ⇒ 新增成员会**编译失败**，而不是运行期悄悄绕过闸门 |
| 闸门注入 | `service.ts` / `recompute-pipeline.ts` | 可选第 4 个构造参数（默认 `NO_WRITE_GATE`）⇒ CLI、单测、老调用方**行为逐字节不变** |
| 让路点 | `recompute-pipeline.ts` 六个计算循环 | `gate.yieldIfStale()`（50 ms 预算）；逐语句租约下它基本是常数级早退，作为长单语句的安全网 |

## 2. 机制：写许可只在**单个 SQL 语句**期间被持有

- 代理把 `prepare(...).run(...)` 与 `exec(...)` 包进闸门；**读不取许可**（`get`/`all`/`iterate`），
  与 §6 许可表一致。
- 为什么用代理而不是在 pipeline 里逐处包窗口：逐处包是"我包了这几处"，漏一处就是"有写不在许可内"；
  代理把漏写面收敛到**连接**这一个可枚举的点，并由上表的 `AnalysisStore` 收窄从类型上加固。
- 实测（`scripts/measure-write-lease.mjs`）：轮询授权 **7.1 ms/窗口** ⇒ 逐语句不可行；
  `Atomics.waitAsync` 事件驱动 **0.070 ms/窗口**（400 窗口 28 ms）⇒ 逐语句可行。
  这是本步能直接满足"写锁仅覆盖短 SQL 事务"（而不是"有界窗口近似"）的原因。

## 3. 实施中撞到并修掉的两个真缺陷（都是用例当场抓到）

| # | 缺陷 | 形态 | 修法 |
|---|---|---|---|
| 1 | worker 只 `store` 不 `notify` | 主线程的 `waitAsync` 永不醒 ⇒ **每个窗口都走满 30 s 超时**（协议用例 3 个窗口跑了 15 s） | 请求与释放都补 `Atomics.notify` |
| 2 | 服务器只试一次就收工 | `TaskAdmissionScheduler.acquire()` 是"试一次，null = 此刻不行"，而 worker 正阻塞等我们 ⇒ **死锁**（A11 时间线用例跑满 120 s 超时） | 只要还有未满足的请求就以 5 ms 重试；空闲时才挂起等 notify |

这两个都不是设想中的风险：它们在写完代码后的**第一次**运行里就以"用例超时"的形式暴露了，
所以本步的判据里保留了协议层用例（真 worker 线程），而不是只测时间线。

## 4. 判据与实测

新用例 `apps/api/test/write-lease.test.ts`（**6/6**）：

| 用例 | 断言 |
|---|---|
| 协议：逐窗口取/放 | 三个窗口都真取到许可（`windows ≥ 3`、`timeouts = 0`）；线程退出 + `dispose()` 之后写许可**立刻可用**（否则写路由永久 409） |
| 协议：拿不到许可时失败开放 | 占住许可 ⇒ 客户端 150 ms 后超时、**留下诊断**、不挂死（`timeouts = 1`） |
| 覆盖：连接代理 | 写语句恰好取一次租约；`exec` 取；**读不取**；更新语句再取一次 |
| **A11 时间线** | 真 `RecomputeWorker`（真线程）跑一次真分析（40 条训练）：分析期间主线程采样 `MutationCoordinator`，**成功拿到写许可的采样点 > 0**，且**最长连续占用 ≤ 500 ms**；分析本身必须 `succeeded` 且发布 release |
| 结构判据 | 分析侧不得自己开第二条连接（源码扫描 `new DatabaseSync(` / `RaiDatabase.open(`）；`recompute-thread.ts` 必须包代理；`recompute-worker.ts` **不得**再出现 `this.admission.acquire()` |
| 回归 | 没有 admission 时 `RecomputeWorker` 仍能正常跑完（不引入必需依赖） |

**突变验证（2 处）**

| # | 突变 | 结果 |
|---|---|---|
| 1 | drain 恢复整轮持锁（worker 仍请求租约） | 时间线用例转红 —— **死锁**形态（120 s 超时）。这条如实记录：它证明的是"许可不能两处同时要"，不是时间线断言本身 |
| 2 | **忠实还原旧行为**：drain 整轮持锁 + worker 完全不请求租约 | 时间线用例 **1.8 s 内转红**（`available === 0`，即分析期间一个写许可都拿不到）⇒ 这正是 A11 原始缺陷的形态，也是本用例真正的靶子 |

## 5. 受影响面回归

`tsc`（pure + full）EXIT=0；`worker.test.ts` + `service.test.ts` + `pipeline-*.test.ts` +
`import-queue-live.test.ts` 共 **116 例 / 115 通过 / 0 失败**（1 例跳过）；
默认 `NO_WRITE_GATE` 使未接线的路径行为不变。

## 6. 如实标注的边界

- ⚠️ **读不取许可**（§6 许可表如此），所以分析输入在窗口之间可能被并发批次改动。
  这要等 PR4 的"固定 `FactsReader`"落地才算真正解决；在那之前依赖既有时序
  （后续批次会重新登记分析）。这条**必须与租约同批说明**，不能当成已解决。
- ⚠️ 失败开放（30 s 超时后继续写 + 诊断）是**有意**的取舍：把整条分析队列挂死比"这一批少一层
  互斥保护"更糟。诊断在客户端统计的 `timeouts` 里可见，但目前还没有接到作业事件里
  （P01–P06 的目标云机实测时再决定是否需要用户可见）。
- ⚠️ §14.3 P01–P06 未测（需要目标云机）。本步给出的是**机制**与**时间线判据**，不是性能结论。
- ⚠️ `runSnapshotRefresh`（另一种作业类型）也走同一条注入路径，但它读写的是**已发布**的 run；
  本步没有为它单独做窗口分析。

## 7. 对验收矩阵的影响

§14.2 的 `未覆盖` 从 **1 项（A11）减为 0 项** —— 18 条 A 项现在每一项都至少有一条行为级或
可执行的结构级证据（A11 两者都有：时间线 + 结构判据）。
