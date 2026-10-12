# 直接增量同步：PR2/PR3 实施与验收记录

- 日期：2026-10-12
- 设计依据：[docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md](../docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md)（§9 含逐步实测证据）
- 前置：[PR1 记录](DIRECT_SYNC_PR1_2026-10-12.md)
- 状态：**实施完成（PR2+PR3 范围）**，但**全量门禁在本次未能取得 `EXIT=0`** —— 原因与判据见 §4，**不掩盖**。

---

## 1. 范围

本文档覆盖设计 §13 的 **PR2**（迁移 v34/v35：版本化事实列 + `route_versions` 等）与
**PR3**（直接车道写入路径：形状约束、补种/删除判定、路线版本、局部 canonical、`FactsReader`），
即设计 §8 实施顺序的**步骤 1–6**。六步全部落地，另有一步**按设计有意未做**（步骤 6b 的"登记本身"）。

## 2. 改动清单

| 类别 | 文件 |
|---|---|
| 迁移 | `packages/storage-sqlite/src/v34-migration.ts`、`v35-migration.ts`（新增，已冻结校验和） |
| 存储 | `packages/storage-sqlite/src/database.ts`（`transactionOwner`、`flushIfOwned/rollbackIfOwned`、路线双槽位版本、`close()` 语义） |
| 存储 | `packages/storage-sqlite/src/recompute-job-repository.ts`（`enqueue` 绑定列、`recoverInterrupted` 按谁能执行分派） |
| 存储 | `packages/storage-sqlite/src/read/facts-reader.ts`（新增，固定代次只读读取器） |
| 契约 | `packages/contracts/src/direct-sync.ts`（§14.1 清单 + `storeMethod`/`vacuousOnDirectLane` 通道）、`packages/contracts/src/index.ts`（`APPLICATION_CONSUMABLE_JOB_TYPES`、`EXTERNALLY_OWNED_JOB_TYPES`）、`packages/api-contracts/src/index.ts` |
| 解析器 | `packages/health-export-parser/src/apple-health-parser.ts`（补种/删除判定合并为单一判据）、`gpx-parser.ts`（版本化写入 + 失败分派）、`canonicalize-nights.ts`（`canonicalizeNightsForWindow`） |
| API | `apps/api/src/direct-sync-plan.ts`（新增：车道判定 + 形状约束）、`data-only-import.ts`、`import-worker.ts`、`import-database-thread.ts` |
| 新增测试 | `direct-sync-plan`、`direct-sync-prohibited-operations`、`direct-sync-analysis-registration`、`direct-sync-migrations`、`transaction-owner`、`route-version`、`generation-seeding-pairing`、`canonicalize-nights-window`、`facts-reader`、`recompute-job-bindings`、`recompute-job-recovery` |

## 3. 验收证据（实跑）

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | `EXIT=0`，0 个 `error TS` |
| `npm run check:docs` | 36 文件 / 338 链接 / **0 问题** |
| `npm run check:doc-refs` | 越界 0 / 无法解析 0 / 内容漂移 0 / 锚在空行 0 |
| 解析器 + 存储全包（早于后两处改动） | 266 条 / 265 pass / 0 fail / 1 skip |
| API + application 定向（早于后两处改动） | 267 条 / 267 pass / 0 fail |
| `transaction-owner` | 11 / 11 |
| `route-version` | 5 / 5 |
| `recompute-job-recovery` | 4 / 4 |
| `generation-seeding-pairing` | 3 / 3 |
| `canonicalize-nights-window` + range | 14 / 14、6 / 6 |
| `facts-reader` | 14 / 14 |
| `contracts` + §14.1 守卫 + 6b 门禁 | 45 / 45 |
| **全量 `npm test`（独占窗口）** | ⛔ **`EXIT=1`：1667 条 / 1660 pass / 3 fail / 4 skip** —— 见 §4 |

### 3.1 突变验证（纪律：跑绿 ≠ 断言有效）

本批每处关键不变量都做了"破坏一点点、证明测试会红、再回退复绿"。汇总（共 20+ 次，逐次记录见设计 §9）：

| 步骤 | 突变 | 红了哪条 |
|---|---|---|
| 1 | 改历史迁移的 `up` / 删冻结校验和 | 漂移门禁点名；约束红 |
| 2 | 短路 `assertStoreOwnsTransaction` / 去掉 savepoint 最内层检查 | `Missing expected exception` |
| 3 | 往 `ImportDatabaseTask` 加成员不加分支 | **`typecheck` EXIT=2** + 分发器与穷尽守卫同时红 |
| 4 | 跳过补种 / 恢复未配对写法 | 漏删方向红；增量白补种方向红 |
| 5 | 去掉发布前完整性校验 / 恢复破坏性 `markRouteStatus` / 版本 id 改非确定性 | 三条各自红（含 TS↔Rust 等价性） |
| 6a | 窗口加载上/下界收窄、守卫短路、`sourceRank` 改错、决胜排序反转 | 差分全绿 ⇒ **只有绝对锚（golden / 前置断言）红** |
| 6b | 给消费者加 `import` 分支 / `enqueue` 漏写一列 | 门禁红；绑定测试红 |

⭐ **步骤 6a 的突变演示了一条通则，已写进设计**：**差分/对拍无法发现"两边同坏"**，所以每个对拍门禁
都必须另配**绝对锚**（手算 golden 或"该形状确实走到目标分支"的前置断言）。PR5 要做的正是"读侧老新对拍"，
评审时必须按这条要求检查。

## 4. 全量门禁的真实状态（**必须如实标注**）

**`EXIT=1`，3 条失败**：`data-only-import-queue`（#111）、`server-runtime`（#559）、`worker`（#801）。

**这 3 条不是本批改动引起的回归**，依据是三层独立证据：

1. **逐个单跑全绿**：`data-only-import-queue` 5/5、`server-runtime` **30/30**、`worker` **96 pass / 0 fail / 1 skip**。
2. **失败集合跨运行会翻转**：`#559` 在两次全量里都红，在"三个文件一起跑"里**绿**。
   同一份代码、同一批文件，红绿会变 —— 内容层面的回归不会这样。
3. **失败用例的路径与本批改动不相交**：三者都不调用 `importGpxRoutes` / `seedImportGenerations` /
   `recoverInterrupted`（本批最重的改动集中在路线发布与恢复流程）。

**机制（读门禁脚本 + 量化 + 控制变量实验，不是推测）**：`scripts/run-tests.mjs` 把**全部**测试文件
一次性交给 `node --test` 且**不设 `--test-concurrency`** ⇒ 默认并发 = `os.availableParallelism()` = **6**。
而 `worker.test.ts:214` 的 `waitFor` 只给 **5000 ms** 墙钟、`data-only-import-queue.test.ts:61` 的
`wait` 给 **30 000 ms**，同批里 `server-runtime`（单跑 443s）与 `worker`（349s）必然重叠 ⇒ 预算越界。

**控制变量实验（决定性）——同一份代码、同一批文件，唯一变量是并发：**

| 配置 | 结果 |
|---|---|
| 三个文件各自单跑 | 5/5、30/30、96/0/1 ✅ |
| 三个文件一起，**默认并发 6** | **EXIT=1，2 条失败** ❌ |
| 三个文件一起，**`--test-concurrency=1`** | **EXIT=0，132 条 / 131 pass / 0 fail / 1 skip** ✅ |
| 全量，默认并发 6 | EXIT=1，3 条失败 ❌ |

⇒ **这是本仓门禁在 6-CPU 机器上的结构性脆弱，与本次改动无关。**

**本轮为此加的旋钮（默认行为未改）**：`scripts/run-tests.mjs` 新增
`RAI_TEST_CONCURRENCY`（配 `testConcurrency()` / `nodeSuiteArgs()` 两个导出函数）。
**未设置时 argv 与历史逐字相同**（已写成断言：谁改默认，测试先红）；非法值（`0` / `-1` / `abc` /
`1.5` / `" 2"` / `0x2` / `1e2` / `+2`）**响亮拒绝**，不静默回落 —— 用例
`packages/application/test/test-runner.test.ts`（6/6）。需要一份确定性的独占结果时：

```
RAI_TEST_CONCURRENCY=1 npm test
```

⚠️ **本记录的结论边界**：**不能**据此认为"PR2/PR3 已通过全量门禁"。要取得可验收的 `EXIT=0`，
必须在一个**真正独占**的窗口重跑（本次第一轮把门禁与两条写入线并行开，结果作废；第二轮的残留红
已归因如上）。

### 4.1 取证过程：两趟制**不够用**，最终走串行

**先试了"两趟制"**（重文件走单独一次串行 pass + 其余默认并发），结果证明**不够**：

| 趟 | 内容 | 结果 |
|---|---|---|
| 1 | 除三个重文件外的 **208** 个文件，默认并发 | ⛔ `EXIT=1`：1537 条 / 1532 pass / **2 fail** / 3 skip |
| — | 失败的仍是**单跑曾绿**的两条：`benchmark-import`（单跑 1/1）、`native-import-worker`（单跑 3/3） | |

⇒ **并发敏感的文件不止 3 个，至少 5 个**。在这台 6-CPU 机器上，重/子进程类测试的并行执行
**普遍不可靠**，不是个别文件的问题；靠"排除清单"要一直加下去。

**⇒ 取得确定性结果的唯一可靠方式是把 node 套件串行**（新旋钮正是为此）：

```
RAI_TEST_CONCURRENCY=1 npm test
```

日志：`.workbuddy/runlogs/full-gate-serial.log`（同时反过来端到端验证了该旋钮真的把并发传到了
子进程）。⚠️ 串行会明显更慢 —— 代价与收益的这一取舍**属项目决策**，本批只提供工具、未改默认。

## 5. 覆盖边界（未做 / 有意不做）

- **步骤 6b 的"登记本身"**：按设计**有意未做**。已落地的是"能力 + 门禁"：`enqueue` 支持绑定列、
  四道门禁（登记 `import` 会被消费者判失败 / `deltaMode` 恒 `record-only` /
  `analysisStatus` 恒 `not_required` / 回执唯一产出方）。**上线顺序**：消费者先认识 `import` 类型 →
  再登记 → 最后切路。
- **PR4 / PR5 / PR6 未开始**：分析消费者与发布、读侧改走版本表、`route_points` 退役。
- **快照表（canonical / 评分 / 预测）仍是全量重建**：局部化只做到 canonical 窗口，且尚未接线。
- **`FactsReader` 今天没有生产调用方**，且 `import_fact_history` / `valid_from_generation` 的
  **写入方也还没落地** ⇒ 它现在实质只能读到"当前行"。这是契先行的有意安排，**不是"已可用"**。

## 6. 已知风险与技术债（如实登记，不声称已守）

| 项 | 说明 |
|---|---|
| 判据 8 只覆盖 update | `FactsReader` 对**已删除**实体在任何代次都读不到。**PR4 必须闭掉**这条口径 |
| `cli.ts` 置 succeeded 无 `status='running'` 守卫 | 理论上覆盖并发状态变化；红队标"未证实、可达性低"，本批不修 |
| `fromAt`/`toAt` 收紧为绝对时刻 | 只写日期会抛错。零生产调用方 ⇒ 零兼容风险；将来要宽松语义现在改是免费的 |
| `route_versions` 环状外键 | 删 `workout_routes` 时级联顺序无测试覆盖 |
| `route_points` 与版本表**双写** | 过渡期代价；PR5/PR6 让读侧改走版本表后 `route_points` 退役 |

## 7. 建议的推进方式

1. **先修门禁**：给 `scripts/run-tests.mjs` 一个**有界并发**（或把重文件拆成单独一次串行 pass），
   而不是调大测试里的 5s/30s 预算 —— 后者是"把测试调弱换绿灯"，本仓明令禁止。
   这一条动的是门禁语义与耗时，**属项目决策**，本批未擅自修改。
2. **在独占窗口重跑全量**，取得 `EXIT=0` 后再进 PR4。
3. **PR4 开工前**先闭掉 §6 的两条：判据 8 的 delete 口径、`import` 类型的语义重载
   （登记前分支入口须拒绝 `request.mode === "cli_export_import"`）。
