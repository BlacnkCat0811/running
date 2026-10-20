# iOS 同步后续项「未实施项」实际情况核实与优化建议（2026-10-19 第三轮）

- 依据：[IOS_SYNC_FOLLOWUP_PLAN_2026-10-19.md](IOS_SYNC_FOLLOWUP_PLAN_2026-10-19.md) §2 的五个
  “本轮不实施”项（B3 / B4 / B5 / B6 / C1）。
- 基线：**当前工作树**（`67028e1` + 未提交改动，含 R1–R6 与上一轮 R6 防御重放、B1、B2）。
  不是 HEAD —— `git status` 显示 37 个已改文件 + 若干未跟踪文件，R1–R6 批次尚未提交。
- 方法：只读核实（读码 / `git log` / 只读执行门禁）+ 本机可跑判据。**未修改任何源码、测试或
  既有文档**（本文是唯一新增文件），未部署、未连生产、未真机、未跑 mutation。
- 判定口径：**需要优化**（本轮应做）/ **暂缓**（不做，但给出触发条件）/ **不需要**。
- 证据一律 `file:line`；标“推断”的是代码路径推导，不是实测。

## 0. 结论摘要

| 项 | 计划原结论 | 本次核实到的事实 | 结论 | 优先级 |
|---|---|---|---|---|
| B3 查询前预算 hint | 本轮不实施，先测量 | 正式 `drain` 的 shrink 闭环成立（1000 页 / 折半 / 页首收手），hint 只省“每批 2–4 次查询 + 1 个整页渲染”，且**今天没有任何计数能验收它**；真正“既不收窄也不收缩”的是 48h 窗口通道，但修它要改“窗口完整性/水位推进”语义，收益只在重放期且没有测量支撑 | **不需要**（维持暂缓） | P3（只观察） |
| B4 批内精确去重 | 本轮不实施，先统计 | 批内重复确实存在、服务端安全吸收（P1-2 轻路径只计 `unchanged`，不报错、last-wins）；有生产数字的 95.9% 是**跨批重放重复**（B4 修不到）；R3 已消掉窗口通道的跨批重复；批内重叠今天**不可测**（导出目录导出即删） | **不需要**（去重暂缓）；可选“零行为统计” | P2 |
| B5 少一次 ZIP 复制 | 本轮不实施 | 每批只多写一遍 staging（Z 字节 + fsync），读省不掉；典型批 1–3 MB、路线批数十 MB，稳态 ≤4 批/h，用户不可见；该函数被 4 类判据钉死，改动要付真机验收 | **不需要**（暂缓；但计划给的理由要改写） | P3 |
| B6 测试缝替代文本门禁 | 本轮不实施（渐进重构） | 债务属实（约 500 处字面量锚 + 218 处顺序/计数锚，钉纯判据仅约 4%；近 8 天 25/128 个提交动过门禁、+2401/−235 行）；**并且发现一支门禁已死 6 天、跨平台入口没有任何自动执行者** | **需要** | **P0 止损 + P1 分批** |
| C1 raw ZIP / 新记录协议 | 暂缓 | 现协议 = ZIP/XML + multipart + 持久回执；无 raw ZIP/新协议半成品；无查询/渲染/传输瓶颈证据；C1 的前置 B5 未做 | **不需要**（维持暂缓） | — |
| 顺带（不在五项内） | — | R6“已实现”的接线与注释/回归不一致（修复轮变成**双重重放**）；B1 前台触发点无门禁且 `RAIApp.swift` 被类型检查排除；B2 helper 唯一性无门禁 | 建议下一轮修 | P1 / P2 |

一句话：**五项“未实施”里只有 B6 需要现在做；B3/B4/B5/C1 的暂缓结论仍然成立，但三条暂缓的
“理由”与“前置”需要按本文勘误改写。** 另外，B6 的 P0 不是重构债，而是**一支判据已经 6 天没执行**。

## 1. 本轮实跑与本机判据

| 检查 | 结果 | 说明 |
|---|---|---|
| `npm run test:ios` | **通过（EXIT=0）** | 类型检查 + 纯逻辑回归 + **9 支 python 门禁**（`run-model-tests.sh` 直跑 6 支，`run-health-sync-tests.sh:28/:255` 2 支，`run-tech-presentation-tests.sh:910` 1 支） |
| `npm run check:ios-gates` | **失败（EXIT=1）：10 支里 1 支失败** | 失败的是 `check-pr5-facts-analysis.py`（见 §5.2）；该入口不在 pre-commit / CI |
| `node --import tsx --test packages/health-export-parser/test/native-worker-availability.test.ts` | 1 test / 1 pass | 过期产物判据本身可用 |
| Rust 产物新鲜度 | **过期** | `target/release/rai-data-worker` = 2026-10-16 19:04；`crates/rai-data-worker/src/main.rs` = 2026-10-19 07:28；本机无 `cargo` ⇒ 与计划 §1.2 一致（“重跑 `npm run rust:build`”不可达） |
| `git status` | 37 改 + 未跟踪 | 本轮全部结论只对**工作树**成立 |
| 全量 `npm test` | **未跑** | 只读核实的范围是源码事实；全量套件要独占窗口，且与本问题的结论无关，不写成“通过” |
| mutation | **未跑** | `check-background-mutations.py` 会改坏 Swift 源码，只读约束下禁止 |

## 2. B3 · 查询前预算 hint

### 2.1 实际情况（代码事实）

- 正式记录 `drain` 的闭环：`HealthKitRecordCursor.swift:150-184`。`query(anchor, limit)` →
  `render` 整页 → `decide`；`accept` ⇒ `commit` + 推进锚点 + **`limit` 复位到满页**
  （`:171`）；放不下 ⇒ `limit = min(requested, limit/2)`（`:181`），`limit == 1` 仍放不下 ⇒
  页首收手（`:177-180`，零提交）。唯一生产调用点 `HealthKitExport.swift:2140-2184`，
  页大小常量 `recordPageLimit = 1000`（`:326`）。
- 收缩估算：`DirectSyncBatchBudget.shrinkLimit`（`DirectSyncBatchBudget.swift:108-115`）用本页
  实测“每记录字节”算剩余额度；`drain` 的夹紧规则保证**严格单调、有限步**终止。
- 预算口径：真实握手 8 MiB ⇒ `xmlBytesBudget = 7,549,747`、`maxRecords = 12,000`
  （`DirectSyncBatchBudget.swift:73-84`）；无握手回落保守档 1,887,436 B / 4,500 条（`:43-49`）。
- **没有任何查询前输入**：`limit` 只来自常量 1000 或上一次被拒后的收缩值。
- 五条子通道的对照（同一批内顺序：workout 定向窗口 → 迟到补读第一趟 → 48h 窗口 → 正式
  anchor drain → 补读 top-up）：

| 通道 | 查询前收窄 | 放不下后 | file:line |
|---|---|---|---|
| workout anchored 窗口（R3 新） | ✅ `shareLimitedPageSize` | `windowCut` + break（不重查） | `HealthKitExport.swift:1620-1626,:1688-1700` |
| 迟到补读（4 类 / 14 天） | ✅ `shareLimitedPageSize` | `continue`（不记账，下批） | `:1812-1819,:1841-1852` |
| **48h 记录窗口 pass** | ❌ 固定 1500 | **无收缩、无重查、静默跳过** | `:338,:1915-1999` |
| 正式 anchor drain | ❌ 固定 1000 | shrink + 折半重查 | `:2140-2184` |
| workout 页（含 GPX） | ❌ 固定 1000 | 先抓 GPX 再判字节 → 删 staging → 折半 | `:735-831,:889-897` |

- 现成统计：`ExportChannelCounts`（`SyncTaskState.swift:14-64`）只有 9 个“写进去了多少”的计数；
  **没有** query / render / retry / reject / limit / 字节字段。整批 `xmlBytes` 存在
  （`HealthKitExport.swift:56,:1054`）但只用于本地自校验（`HealthKitSync.swift:1873-1880`），
  **不进日志也不落盘**。

### 2.2 为什么判“不需要”

1. 收益上界很小：正式 drain 的尾页代价 = 条数先满时 **2 次多余查询 + 1 个整页渲染**；字节先满时
   靠近边界约 2–4 次。每批一次、只在“停下的那个类型”上发生（触顶后不再开始新类型，
   `HealthKitExport.swift:2037`）。相比一次 HealthKit 查询的固定成本，这属于噪声级。
2. 不可验收：计划 §2.1 步骤 4 的“接受前重查次数下降”需要 `rejectedPages/retryAttempts` 计数，
   而这类字段一个都不存在。先补 2 行日志比做 hint 更划算。
3. 计划把 B3 缩成了“drain 的第一次查询估小”，而真正代价大的形态在 **48h 窗口通道**
   （`HealthKitExport.swift:1941-1976`）：固定 1500 整页先查先渲，再用份额闸门判，失败即
   `continue`（不推进水位，下批同一窗口重来），**既无 shrink 也无查询前收窄**。它是唯一
   “两者皆无”的记录通道 —— 但：
   - 它只在“首读 / 历史重放未完成”时启用（`:1928-1930`），是**一次性阶段**；
   - 收窄 `limit` 会改“48h 窗口是否算覆盖”的语义：当前截断（≥1500）仍推进水位并声明“其余由
     锚点流补齐”（`HealthKitRecordCursor.swift:339-348` 的 `RecentWindowAccounting`）。把
     limit 收窄到份额大小会让**几乎所有高频类型**都变成“截断 + 推进水位”，即用“48h 准时交付”
     换“少几次查询”—— 这正是 2026-10-14 事故防复发通道的边界，不能用估算去换；
   - 且有更便宜的安全子集：份额剩余 ≤ 0 时跳过查询（严格等价，因为任何非空页都会被份额拒），
     但这种情况几乎不出现，修了也省不下主要开销。
4. 结论：**B3 维持“不做”**。把它写成“需要优化”会让一条高风险语义变更挂在没有测量的收益上，
   与计划自己“不能凭均值猜”的纪律冲突。

### 2.3 触发条件（将来重开时）

先做 §2.4 的度量，再按任一条件重开：

- 重放期真机日志显示 48h 窗口通道的查询耗时占单批导出 **>10%**，或
- 新增计数显示 `windowRejectedPages / 批` 中位数 **≥10**（说明绝大多数类型在“查 1500→丢弃”），或
- `recordPageLimit` 上调到 ≥2000，或批预算档下调到 ≤1 MiB（正式 drain 的尾页代价同比放大）。

### 2.4 若重开：完整实施步骤（按“先度量、后接线”）

1. **度量（0 行为改动，先行）**：`ExportChannelCounts` 增加**Optional** 字段
   `queries/windowQueries/windowRejectedPages/retriedPages`（必须 Optional：该类型用
   `try? container.decodeIfPresent` 解码，新增非 Optional 键会让老任务行整行丢）；日志扩
   `logLine`（`SyncTaskState.swift:59-63`）+ `HealthKitSync.swift:2561` 同一条 NSLog；同时把已有
   `xmlBytes` 打进日志（2 行）。
2. **纯判据**：`DirectSyncBatchBudget.pageSizeHint(shareBytesLeft:shareRecordsLeft:estimatePerRecord:pageLimit:)`
   —— 与 `shareLimitedPageSize` 同族，返回值 0 = “页首不查”。
3. **接线（若确定做）**：只改 48h 窗口循环，查询前算
   `pageLimit = shareLimitedPageSize(...)`；`guard pageLimit > 0 else { continue }`（**0 = 不限量**，
   见 `HealthKitExport.swift:2502` 的 `HKObjectQueryNoLimit`，漏这一步会把“没额度”变成“查全库”）；
   截断告警改 `recent.count >= pageLimit`；水位推进规则单独过一遍：**截断页是否仍推进必须显式
   决策**（现行为推进，收窄后截断会变成常态）。
4. **回归**：`DirectSyncBatchBudgetTests.swift` 补三条（份额 0 ⇒ 0；不足 1 条 ⇒ 1；满额 ⇒ 1500）；
   `check-healthkit-record-sync.py` 改 `:283` 的截断锚点 + 新增“guard 在 query 之前”。
5. **验收**：必须不变 —— 记录内容集合/顺序、四类游标字段、删除集合、`export.xml` 逐字节确定性
   （`check-export-determinism.py`）；另钉“停因分类不得从 `.recordPage` 翻成 `.recordNone`”
   （后者会给出用户可见的错误文案，`HealthKitSync.swift:3065-3070`）。
6. **回滚**：hint 返回 `pageLimit` 即恢复原行为（单行），不涉及持久字段/协议/服务端。

### 2.5 对计划 §2.1 的勘误

| # | 计划写法 | 事实 |
|---|---|---|
| E1 | “现有 `shrinkLimit` 已覆盖放不下后收缩”，暗含 B3 只差 drain | shrink 只覆盖正式 drain 与 workout 页；**48h 窗口两者皆无**（`:1941-1976`），R3 的新窗口通道有查询前收窄 ⇒ 两条“窗口”通道不对称 |
| E2 | `drain` 增加 `suggestedLimit(pageLimit:)` 参数 | 标量签名不可行：每次 `accept` 都复位 `limit = pageLimit`（`HealthKitRecordCursor.swift:171`），必须在**每次 query 前**求值 |
| E3 | 未提 0 语义 | `shareLimitedPageSize` 耗尽返回 0，而 0 = `HKObjectQueryNoLimit`；直接接线会把“没额度”变成“不限量” |
| E4 | “复用 `ExportChannelCounts`，只写计数” | 计划列出的 7 个字段**一个都不存在**（`SyncTaskState.swift:14-64`）；`xmlBytes` 也未进日志 |
| E5 | 验收只写“集合与游标不变” | 缺两条：accept 必须返回推进后的锚点（否则 drain 不退出，`HealthKitRecordCursorRegression.swift:341-345` 记录过一次挂死）；停因分类不得翻转 |
| E6 | “查询前 hint 减少重查” | R3 之后 workout 窗口已不走 drain 的 shrink 闭环，§2.1 应先按通道拆开写 |

## 3. B4 · 批内精确去重

### 3.1 实际情况（代码事实）

- 记录写入是**单 `export.xml` 顺序追加**，整批一个 `FileHandle`，没有去重。四条记录通道
  （计划写“三通道”，漏了一条）：
  1. workout 定向补齐窗口：`:1578-1785`，anchored 分页，份额 1/4（`DirectSyncBatchBudget.swift:431-433`）；
  2. 14d 迟到补读（4 类跑步动态）：`:1812-1859`，份额 1/7（`:413-415`）；
  3. 近 48h 窗口：`:1915-1999`，份额 1/5（`:391-393`），**只在首读/重放期启用**（`:1928-1930`）；
  4. 正式 anchor / 历史重放：`:2032-2260`。
- 同一 `(type,UUID)` 在同批出现两次：服务端**不报错**。第二次命中 P1-2“未变记录前置跳过”
  轻路径，只累加 `unchangedRecordCount`（`apple-health-parser.ts:633-655`、`:651`），
  行写入是 `ON CONFLICT DO UPDATE`（`database.ts:2115-2130`）⇒ last-wins。
- 已有批内去重：**注意级**，不是精确级 —— 迟到补读在本批覆盖过的类型，48h 窗口直接跳过
  （`windowCoveredTypes`，`HealthKitExport.swift:1491-1496,:1923`）。这是 type 级，不是 `(type,UUID)` 级。
- 统计能力：客户端回执 `records{parsed, inserted, unchanged}` 已解析（`HealthKitSync.swift:129-144,
  :2480-2485`）但**只进 UI、不落盘、不 NSLog**；服务端 `summary.directSync.records` 同样是派生值
  （`direct-sync-ingest.ts:992-1003`），且 `unchanged = parsed − inserted` **混入“内容更正/墓碑”**，
  不是“精确重复”。`import_batches.summary_json.xml` 里的 `unchangedRecordCount` 才是精确重复，
  但同样**不分批内/跨批**，且 `/v1/diagnostics` 未暴露。
- 批内**不可测**的根因：导出目录 `defer` 即删（`HealthKitExport.swift:554`），服务端成功后也删
  上传目录 ⇒ 没有任何留存的 `export.xml` 可离线重算；也没有批内 distinct-key 计数。
- R3 之后：窗口通道自身“每批重读同一前缀”的**跨批**重复已被 anchored 分页消掉
  （`WorkoutWindowPaging.swift`、`SyncTaskStore.swift:2011-2079`）；窗口 ↔ 正式 anchor 的
  **同批**重复形态不变 ⇒ B4 的可回收空间比 R3 前更小。

### 3.2 为什么判“不需要（暂缓）”

1. 有生产数字支撑的 95.9% 重复是**跨批**（历史重放重复发送服务端已有记录；6 批 27,000 条 /
   新增 1,111 条，43 批 192,500 / 8,117 条）。B4 对它为 0 —— 真正的跨批杠杆是 P1-1 覆盖表，
   而当前 `allowsHistorySkip = false`（`HealthKitRecordCursor.swift:507`）。
2. 必然同批重复只有三种形态：workout 窗口 vs anchor（稳态新训练；生产同类批 workout 相关
   仅 622 条，约 5% 预算）、重放期 48h 窗口 vs workout 窗口、首装补读 vs 窗口（后者已有 type 级去重）。
3. 去重会改 `export.xml` 字节、四通道记账、页预算与 R3 候选提交，是仓库最高危路径之一；收益是
   个位数百分比的预算，不划算。
4. 统计先行：回报的 `unchanged` 口径会把“内容更正”算成重复，直接拿来论收益会系统性偏高。

### 3.3 触发条件（任一）

- 同批重复 ≥900 条或 ≥0.75 MB，且 7 天内 ≥3 批；
- 30 天内“同批重复总量 / 总解析记录”≥5%；
- 去掉重复后同一数据集收敛批数下降 ≥10%。

两周 / ≥20 批内 <5%，或只出现在首装/升级后单轮 ⇒ **关闭 B4**。

### 3.4 若采纳“先统计”：Phase 0 步骤（0 行为改动，P2 可选）

1. 新增纯类型 `BatchRecordDedup`（`nonisolated`，放 `DirectSyncBatchBudget.swift` 旁，可被
   `DirectSyncBatchBudgetTests.swift` 单独编译）：键 = `type + U+001F + lowercase(uuid)`；容量 = 单批
   `maxRecords`（≤12,000 key ≈1 MB）；**每批重建、绝不持久化**。
2. 登记点必须在**四个 write 成功点之后**（`:1700/:1853/:1969/:2171`）。🔴 绝不能在
   `renderedRecordPage` 内登记：`drain` 在 `.retryWithLimit` 会用同一 anchor **重渲染**
   （`HealthKitRecordCursor.swift:166-182`），第二次渲染会把整页判成“已接受”→ 0 条 → 推进锚点
   ⇒ **该页数据永久丢失**。
3. `ExportChannelCounts` 新字段**必须 Optional**（`SyncTaskState.swift:358` 用 `try? container.decodeIfPresent`，
   新增非 Optional 键会让老任务行整行丢）；只写计数，不写 UUID/样本值。
4. 日志扩 `logLine`（`:59-63`）+ `HealthKitSync.swift:2561`；`receiptId` 与设备日志的关联留给后续。
5. 验收：把统计开关关掉时 `export.xml` 逐字节不变（`check-export-determinism.py`）；老任务行可解码
   （`SyncTaskMigrationRegression` 已有同类形态）；回滚 = revert（无持久字段）。

若统计后仍决定去重，前置硬规则（计划 §2.2 未写）：**key 只能在 commit 成功后入集合**；
**全重复页仍必须提交**（保留删除列表、`data` 为空，drain 接受/推进不变）；`workoutWindowRecords`
的计数口径要从 observed 改成 written（`HealthKitExport.swift:1783`），否则去重后计数失真。

### 3.5 对计划 §2.2 的勘误

1. **“三通道”漏了一条**：workout 定向补齐窗口（`:1578-1785`，25% 份额）才是稳态同批重复的主形态。
2. **“跳过渲染”表述危险**：`render` 同时承担页字节（预算判据）与删除列表（唯一出口 `:2316-2320`）。
   正确写法 = 过滤 `added` 入参、删除照旧渲染；且 key 必须 commit 后登记（见 §3.4-2）。
3. **统计没写“怎么读回来”与兼容**：回执 `unchanged` 混入更正/墓碑；新字段必须 Optional。
4. 漏了原报告 B4 步骤 4 的区分：`writtenTypes` 不能推导“时间窗已完整覆盖”（`windowCoveredTypes`
   是另一回事，`:1489-1496`）。
5. 验收场景不全：缺“内容更正 / 预算拒绝重渲染 / 全重复页含删除 / 墓碑与同批删除 / 上传前崩溃取消”。
6. 完全没提 R3：R3 已消掉窗口通道的跨批重复，B4 收益空间变小，结论方向要更新。

## 4. B5 · 少一次 ZIP 复制

### 4.1 实际情况（代码事实）

- 源 ZIP 由 `HealthKitExport.swift:1019-1022` 写进 `temporaryDirectory/apple-health-healthkit-<UUID>.zip`；
  `HealthSyncArchive.prepare` 在“导出成功之后、`saveTask` 之前”调用一次（`HealthKitSync.swift:1920-1922`）。
- `prepareFile`（`HealthSyncArchive.swift:66-107`）：分块读（64 KiB）同时算 SHA256 **并写 staging**
  （`:84-93`）→ fsync（`:91`）→ 名字 `upload-<hash>.zip`（`:19,:94`）→ `isNewFile`
  （`:95`，同名的唯一现实来源是“发布后、saveTask 前崩溃”的孤儿）→ 取消点（`:96`）→
  `moveItem` 或 `replaceItemAt` 发布（`:98-102`）→ `protect`（`:103`）→ 删源（`:104`）。
- 之后还有一次全量复制：`writeHealthKitMultipart` 把整份 ZIP 再读一遍写成
  `upload-<hash>.multipart`（`HealthKitSync.swift:3165-3168`、实现 `:3815-3839`）；
  交给后台 `URLSession` 的是 **multipart**（`HealthKitSync.swift:3195` →
  `BackgroundUploadSession.swift` 的 `upload(request:fromFile:)`）——**ZIP 从未被系统持有**。
- 可省的**只有** staging 那一次全量写（+一次 fsync）；**读省不掉**（哈希必须整读一遍源）。
  每批一次；重试/恢复不重跑 `prepare`（只重建 multipart）。典型批 Z ≈1–3 MB，含路线批可达
  数十 MB；无新数据的批只有 manifest。全量重放 118 批的既有记录（`DirectSyncBatchBudget.swift:59-60`；按基数推算还剩 ≈75 批，`HealthKitRecordCursor.swift:455-457`）
  ⇒ 累计百 MB 量级（**推断**，非设备实测）。这是“3 份 Z 写去掉 1 份 ≈ 减 1/3”，不是减半。
- 该函数被 4 类判据钉死：`HealthSyncArchiveRegression.swift` 的 8 条（含 `:61-62,:97-108`）、
  `check-health-sync-archive.py:63` 的 `replaceItemAt` 字面量与 `MIN_CHECKS = 18`（`:94`）、
  `check-background-mutations.py:1592-1600` 的突变条目。

### 4.2 为什么判“不需要（暂缓）” —— 但计划给的理由要改写

- 计划 §2.3 的理由是“取消/所有权语义需要成组改”。核实后**不成立**：在“先哈希再 move”方案下，
  四条链（`isNewFile` 属主、`discardIfUncommitted`、恢复只认目标文件 + 任务行、取消回收）逐条不变；
  改动面 = `prepareFile` 一个函数 + 2 条 Swift 回归 + 1 条 python 门禁字面量 + 2 条突变。
- 真正该暂缓的理由是**收益/风险比**：省的是稳态多为空/小批的一次写，用户不可见；而要动的
  是全仓最安全敏感的“发布/恢复”函数，还要付真机验收。
- 触发条件（任一）：
  - T1 真机出现归档写失败 / ENOSPC（当前全仓无剩余空间处理）；
  - T2 埋点显示“正在保存健康数据批次”阶段耗时或峰值驻留与 Z 成正比且占整轮 >10%；
  - T3 C1 raw ZIP 立项（multipart 消失后，归档层必须改成“边写边哈希发布”，B5 顺带完成）；
  - T4 真机观测多数批 Z >10 MB。
  若 T2 埋点还没有：先埋点、先不做（与 B3 同纪律）。

### 4.3 若触发的实施要点（不是本轮步骤）

1. 只读一遍源：`readChunks` 内 update hasher + `onChunk`（保留 `autoreleasepool` 与 chunkSize 字面量，
   门禁 `:59` 依赖）；发布前算好 `payloadHash/durableURL/isNewFile`。
2. **`protect(sourceURL)` 必须在 move 之前**（rename 保留源属性；否则崩在 move 与 protect 之间会留下
   “未排除备份/保护类来自 tmp”的 ZIP）。计划 §2.3 漏了这条。
3. `isNewFile` ⇒ 先 `moveItem`，`catch`（含 EXDEV）⇒ 回退复制并记日志；`!isNewFile` ⇒ **比大小**
   （O(1)）而不是“哈希相同但字节不同”（目标从未哈希过，判“字节不同”要再读一遍目标，抵消收益）。
4. 跨卷判断代码里没有、SDK 也无承诺 ⇒ 回退分支必须靠**注入**（把 publish 做成默认参数的内部函数）
   才能测到；静默吞掉 move 失败是错的方向。
5. 回归改 2 条 + 新增 3 条（同名复用/跨卷回退/protect 先于发布）；验收：`upload-<hash>.zip` 逐字节
   与 SHA256 不变、`payloadHash` 不变、multipart 逐字节不变、四个崩溃点的 `nextStep` 入参不变。
6. 回滚 = revert 单提交；磁盘契约（文件名/字节/任务行字段）完全不变 ⇒ 无迁移窗口。

## 5. B6 · 测试缝替代文本门禁 —— **需要优化**

### 5.1 实际情况（代码事实）

- 12 支门禁 / 7226 行 / 约 800 条断言。按“字面量 `in` 源码 + tail_after/ordered/计数”口径统计：
  约 **500 处**文本钉、**218 处**顺序/计数锚，真正“钉纯判据调用”的仅 **约 24 条（≈4%）**。
  风险最高：pr5（已死）> today-layout（90 裸 assert / 26 文本钉）> fresh-skin（37 字面量）>
  record-sync（178 文本钉）> capabilities（243 文本钉 / 40 tail_after / 22 ordered）。
- 成本已发生过：近 8 天 **25/128 个提交**动过 `check-*.py`（**+2401/−235 行**）；本轮两次合法搬迁
  都是“改门禁而不是改实现”：
  - `check-direct-sync-analysis-reconcile.py:228-241`：调用计数 2→3（B1 新增入口）；
  - `check-healthkit-record-sync.py:294-301`：钉 `lateBackfillBefore: previous?...` 字面量 → 改钉 helper；
  - 连带重锚 `check-background-mutations.py` **4 条**突变。

### 5.2 关键新发现：一支门禁已死 6 天，且跨平台入口没有执行者

1. **`check-pr5-facts-analysis.py` 在当前主机上根本不执行**：`:87/:106` 用 PEP 604 注解
   `str | None`，**没有** `from __future__ import annotations`。本机 `python3` =
   `/usr/bin/python3` = **3.9.6** ⇒ 导入即 `TypeError`，0 条判据执行，EXIT=1（本轮实测）。
   该文件自 `60678af`（2026-10-13）引入后**从未修改**；`f807393`（2026-10-15“门禁 Python 3.9 兼容”）
   只给同族 3 支加了 future import，漏了这一支。
2. **换 Python 3.12 也红**：基线 `var/reports/pr5-c9-baseline-keys.json` 被 `.gitignore:4` 的
   `var/` 忽略、**从未入库**；用本机 `python3.12` 实测 `13 checks / 3 failed`（baseline 缺失/无字段/
   无 commit），EXIT=1。
3. **没有执行者（最致命）**：它不在 `run-model-tests.sh` / `run-health-sync-tests.sh` /
   `run-tech-presentation-tests.sh` 任一链里；只有手跑 `npm run check:ios-gates` 才会执行。
   而 `check:ios-gates` **不在** `.githooks/pre-commit`（只有 blob/typecheck/check:docs/doc-refs/
   scripts/test:ios），也不在 `.github/workflows/ci.yml`（该 workflow 自述远端是 gitee、永不触发）。
   ⇒ 6 天零告警，且已被文档写成“预存在失败、与本轮无关”
   （`docs/IOS_SYNC_RECHECK_FIX_PLAN_2026-10-17.md:552`）—— 这正是本仓重复记录的
   “判据存在 ≠ 判据被执行”第 4 次复发。
4. 反过来说：`npm run test:ios` 在 macOS 上**确实跑 9/11 支**（这一点计划口径是对的）；缺的是
   pr5 与“Windows/Git Bash 通道”。`run-ios-python-gates.mjs` 的解释器预检只判 major == 3
   （`:69`），3.9 被当合格解释器，与“PEP 604 崩溃”不匹配。

### 5.3 结论与顺序

**需要优化**，但顺序必须是“先 P0 止损、再 P1 抽缝”，否则 B6 的验收（“搬迁后仍绿”）没有执行者。

- **P0（≈0.5–1 天，不涉重构）**：修 pr5（future import + 基线入库）+ 接执行链
  （`run-model-tests.sh`、pre-commit、CI）+ 解释器判据加严。
- **P1 批 1**：`check-healthkit-record-sync.py`（178 文本钉）→ 抽 `RecordPagePlan` 测试缝。
- **P1 批 2**：`check-background-capabilities.py`（40 tail_after / 22 ordered）→ 抽 `BackgroundRunPolicy`。
- **P2 批 3**：today-layout / fresh-skin **抽不出纯函数**（SwiftUI 结构与文案）⇒ 换机制（文案常量
  单源 + 模拟器视觉快照），不是“改钉调用点”。
- **P2 批 4**：`check-background-mutations.py` 自身 107 条 before/after 文本锚也要随缝自动重锚，
  否则修好门禁后成本继续沿 mutation 支付。

### 5.4 P0 完整实施步骤（本轮应做）

1. **修 pr5 门禁**
   - `apps/ios/tests/check-pr5-facts-analysis.py`：加 `from __future__ import annotations`（或把两处
     注解改成 `Optional[str]`）；同时把基线路径从 gitignored 的 `var/` 迁到入库位置
     （如 `apps/ios/tests/fixtures/pr5-c9-baseline-keys.json`）并提交基线；保留 `--require-baseline`
     这类“内容级核对”开关时，默认必须能绿。
   - 验收：`python3 apps/ios/tests/check-pr5-facts-analysis.py` EXIT=0；篡改基线一行 ⇒ 红；还原 ⇒ 绿。
2. **接执行链**
   - `apps/ios/tests/run-model-tests.sh`：在 6 支 python 门禁旁新增
     `python3 apps/ios/tests/check-pr5-facts-analysis.py`（这样 `npm run test:ios` 覆盖全部跨平台判据）。
   - `.githooks/pre-commit`：`apps/ios/` 有改动时，除 `npm run test:ios` 外追加
     `npm run check:ios-gates`（约秒级，全部是文本门禁）。
   - `.github/workflows/ci.yml`：macOS job 增 `npm run check:ios-gates`。
   - 验收：`npm run check:ios-gates` EXIT=0（10/10）；删掉 run-model-tests.sh 里新增那一行 ⇒
     `npm run test:ios` 应因 pr5 不在链上而“少一支”——用一个“执行者数量”断言钉住
     （参考 capabilities §15 自注册断言 `:1931` 的做法）。
3. **解释器判据**
   - `scripts/run-ios-python-gates.mjs:69`：probe 从“major == 3”改为 `sys.version_info[:2] >= (3, 9)`
     并打印实际版本；与 `run-ios-gates.sh:61-66` 的 `3.[0-8]` 拒绝口径对齐（两处判据不能一份严一份松）。
4. **门禁自身完整性**
   - 在 `run-ios-python-gates.mjs` 增一条“孤儿检测”：`apps/ios/tests/check-*.py` 里既不在
     `EXCLUDED`、也不被任一 `run-*.sh` 引用的，直接失败（pr5 这类“存在但没有执行者”就会当场红）。
5. **回滚**：三项各自独立提交（pr5 / 执行链 / probe），可单批 revert；无产品代码路径改动。

### 5.5 P1 批 1：record-sync（完整步骤）

1. **抽缝**：新增纯类型 `RecordPagePlan`（页装配 / 预算收缩估算 / 删除配额分配 / 通道份额），
   放 `DirectSyncBatchBudget.swift` 旁（该文件已被 `DirectSyncBatchBudgetTests.swift` 与
   `run-health-sync-tests.sh` 编译，不需要新执行者）。`HealthKitExport.writeGlobalRecords` 只做接线。
2. **门禁改钉**：`check-healthkit-record-sync.py` 的 178 处文本钉分三类处理：
   - 钉“调用点存在 + 参数来自纯判据”（例如 `drain(... decide: RecordPagePlan.decide ...)`）；
   - 删“实现细节字面量”（`min(12_000, max(4_500, xmlBytesBudget / 480))`、`Int(Double(...)*0.9)` 等）
     —— 这些改由 `DirectSyncBatchBudgetTests` 的行为断言承担；
   - 顺序断言保留但改为“符号序”（`ordered([...])` 里用函数名/常量名，不用整行文本）。
3. **先红后删**：先给 `check-background-mutations.py` 的 `RECORD_GATE` 补 ≥3 条突变
   （现仅 1 条），跑 `RAI_MUTATION_FOR=git npm run test:ios:mutation:scope` 确认 `assertion_hit=True`，
   再删对应文本断言；否则删完就没有“改坏会被抓住”的证据。
4. **验收**：`check-healthkit-record-sync.py` 断言数不下降（现 121）；3 条代表突变仍红；
   `npm run test:ios` 绿；做一次“真实搬迁演练”（把某段接线移进 helper）后门禁仍绿。
5. **回滚**：缝 / 门禁 / 突变锚点 **三次提交**，删文本断言单独 commit 且放在 mutation 验证之后。

### 5.6 P1 批 2：capabilities（完整步骤）

1. 抽 `BackgroundRunPolicy`：把 `HealthKitSync.performSync` 的收尾判据、后台额度、单飞与
   “生命周期中止不得冒充用户取消”搬成纯函数（部分已在 `BackgroundSyncPolicy` / `HealthSyncWorkPlanner`，
   先核对不要重复抽）。
2. `check-background-capabilities.py` 的 40 处 `tail_after` / 22 处 `ordered` 收敛为
   “符号存在 + 调用点 + 判据函数被调用”；保留它最有价值的自注册断言（`:1931`）。
3. 先跑现有 **61 条** PY_GATE 突变确认仍红，再删文本断言；验收同 §5.5-4。

### 5.7 P2 批 3 / 批 4

- today-layout（90 裸 assert）/ fresh-skin（37 字面量）：纯函数抽不出来（SwiftUI 结构/文案）⇒
  ①6 句用户可见状态文案抽常量单源、门禁断言“常量被视图引用”；②布局改用模拟器视觉快照基线
  （`run-visual-tests.sh` 已有基础设施，需 `var/rai.sqlite`，属手工验收）。
- mutation 锚点自动重锚：把突变条目的 `before/after` 文本改成“门禁 helper 导出的符号对 / 纯判据
  文件片段”，否则每次搬迁仍要人工重锚 4–6 条（本轮已发生）。

### 5.8 对计划 §2.4 的勘误

| # | 计划写法 | 事实 |
|---|---|---|
| a | 第 1 步假设“每条被钉路径都能抽纯函数” | today-layout + fresh-skin 共 169 条裸 assert 是 SwiftUI 结构与文案，无纯函数可抽；方案对它们无效，必须换机制 |
| b | 第 2 步“先在旧门禁上跑 mutation 确认仍能变红” | today-layout / parity / analysis-reconcile / pr5 **零 mutation 条目**（107 条突变只覆盖 5 个 oracle）；必须先建突变，而新突变的锚点又是新文本钉 |
| c | 第 2 步“每替换一批…再删除文本断言” vs 第 4 条“同批提交，不同批删文本断言” | **自相矛盾**；“不同批”的时点未定义，实操会漏还原点 |
| d | 验收“≥3 个曾误报门禁搬迁后仍绿” | 不可复现：没有“搬迁演练”夹具，无法区分“绿是因为缝起作用”还是“文本恰好没动” |
| e | 漏 mutation 脚本自身的 107 条文本锚 | 本轮已重锚 4 条，成本继续沿 mutation 支付 |
| f | 漏执行链前置 | `check:ios-gates` 不在 pre-commit/CI，pr5 已死 6 天；不修这条，“搬迁后仍绿”没有执行者 |
| g | 没给文件/顺序清单，也没有“非重构型失效”兜底 | 解释器 minor 版本、gitignored 基线这类失效不在方案覆盖内 |

## 6. C1 · raw ZIP / 新记录协议（维持暂缓）

### 6.1 实际情况（代码事实）

- 上传端：ZIP（`export.xml` + 路线 + `sync-manifest.json` v2；`HealthKitExport.swift:979-998,:1018-1022`）
  → multipart（`HealthKitSync.swift:3165-3180`）→ `POST /v1/imports/uploads`
  （`apps/api/src/routes/import-routes.ts:39,48,50`）。`X-RAI-Sync-Batch = payloadHash`
  做幂等（`HealthKitSync.swift:3180`）；**StoredZip 已启用 DEFLATE**（`StoredZip.swift:41-47,59-62`），
  “ZIP 无压缩”的旧说法不成立。
- 服务端：无 raw ZIP 通道（无 `addContentTypeParser`、无 `application/zip` body 解析、POST 路由清单
  里只有 imports/*）；持久回执 = `x-rai-sync-batch` → `importSources.saveUpload(idempotencyKey)`，
  job 先持久后 202（`import-routes.ts:24-32`）；回执契约 `DirectSyncReceipt`
  （`packages/contracts/src/direct-sync.ts:80-98`）。
- 握手能力位：`syncProtocolVersion=1`、`healthKitRecordSyncVersion=2`、`syncCoverageVersion=1`，
  **没有** raw-upload 能力位；生产代码里没有 raw ZIP / JSONL / Protobuf 半成品（grep 0 命中）。
- 暂缓理由仍成立：生产 `33f79fe` 与 HEAD/工作树的**上传线路代码一致**
  （`d037fc7..33f79fe` 的 `apps/api` `git diff` 为空；`33f79fe..HEAD` 只动 `data.ts` 与测试）；
  无测量证据（只有合成探针）；C1 的前置 B5 未做（`HealthSyncArchive.swift:75-102` 仍复制）。

### 6.2 结论与重新评估判据

**维持暂缓**（不需要优化）。重新评估需**同时**满足：

1. B5 落地并真机测量：ZIP/multipart 持久副本 + 上传仍是剩余主要写放大/占时；
2. 聚合级每阶段计时（query / render / zip / upload / receipt，非样本）连续 ≥N 个真实批次证明
   transport 是瓶颈，而不是 query/render/意图库；
3. 协议包批准：握手新增 raw-upload 能力位（服务端先发），有界流接收复用现幂等/鉴权/大小限/截断/
   同一导入回执，并保留 `/v1` multipart；
4. 旧 App（schema 4）与在途 `.zip/.multipart` 任务可继续，回滚不切换在途文件；
5. raw 通道下 manifest v2 的删除/身份语义不退化，同 ZIP 落相同事实与幂等身份。

### 6.3 勘误

计划 §2.5 引用的“旧 schema 4 App 不列为无损回滚”（`IOS_SYNC_REREVIEW_2026-10-19.md:602`）是
**本地 schema 5 意图/候选层**的回滚边界，不是 ZIP 传输层的；两层不能并列当证据（低风险，但会让
“回滚边界”显得比实际更宽松）。

## 7. 顺带核实：计划“已实现”项与代码的一致性

三项**均存在且已接线**，但有四处残余风险（建议下一轮，不在本轮五项内）：

| # | 风险 | 证据 | 严重度 |
|---|---|---|---|
| 1 | **R6 修复轮接线与注释/回归不一致 ⇒ 双重重放**：`decodedAnchor = nil`（`HealthKitExport.swift:2069`）但 `RecordReplayPlan.segments` 收到的是 `decodedAvailable: decoded != nil`（`:2088-2094`，旧锚点能解码 ⇒ true）⇒ 段计划 = `[.incremental, .historyFromScratch]`，而 `.incremental` 的起点是 `decodedAnchor` = nil（`:2095-2100`）⇒ 两段都从 nil 读，同一类型历史被读两遍；且从 nil 的 `.incremental` 看不到旧锚点之后的删除事件（与仓库自己的注释同源：`HealthKitRecordCursor.swift:480-481`）。回归只测了 `segments(decodedAvailable: false, ...)`（`HealthKitRecordCursorRegression.swift:563-573`）—— 这个输入在修复轮**永远不会**出现；门禁只钉函数调用存在（`check-healthkit-record-sync.py:435-438`） | 低概率（floor 从未被已提交构建写入）但**修复行为与设计不符**；最小修法：把该实参改成 `decodedAnchor != nil`（或 `!disabledFloorRepair && decoded != nil`），并补一条“接线级”判据 | P1/P2 |
| 2 | B1 的前台触发点无门禁且不受类型检查：`RAIApp.swift:67` 的 `onChange(of: scenePhase)` → `:81-83` 调 `reconcileAnalysisOnEntry`；`typecheck-ios.sh:101-104` 把 `*RAIApp.swift` 排除（高德依赖），`check-direct-sync-analysis-reconcile.py` 只读 `HealthKitSync.swift` | 删掉或写错签名可全绿 | P1 |
| 3 | B2 的“helper 是唯一构造点”无门禁：只钉了 `settingLateBackfill` 两次与内部透传（`check-healthkit-record-sync.py:294-301,341-347`），`advancingAnchor` / `settingRecentWindowReadAt` 的唯一性无断言（当前生产代码里确无直接构造，`grep "HealthKitRecordCursor(" apps/ios/RAI` 仅 helper 内部 2 处） | 回归退化成手抄字段仍然绿 | P2 |
| 4 | 计划文档计数与实现不符：§1.3 写“新增 9 条”回归（实际 12 条，`DirectSyncReceiptRegression.swift:705-755`）；§1.4 写“B2 回归 6 条”（实际 B2 新增 4 条，该文件本轮共新增 11 条） | 只影响可追溯性 | P3 |

> **修复状态（2026-10-19 第二轮）**：上表 4 条已全部修复并钉住 —— R6 接线改为
> `decodedAvailable: decodedAnchor != nil`（另修"坏锚点 + 旧 floor 整批失败"的边缘）、
> B1 前台触发点新增 6 条源码判据、B2 helper 唯一性新增 2 条判据、计划文档计数更正；
> 每条新判据都做了"改坏→红、还原→绿"的定向突变。记录见
> [IOS_SYNC_DEFECT_FIX_EXECUTION_2026-10-19.md](IOS_SYNC_DEFECT_FIX_EXECUTION_2026-10-19.md)。
> B6 的 P1 剩余批次与 P2（视觉快照）仍未做，理由见该记录 §6。

## 8. 边界与未验证

- 本轮**只做只读核实**：没有改产品代码、没有跑 mutation、没有跑全量 `npm test`（主机负载 + 与本问题
  结论无关），**没有**部署、重启生产、真机 HealthKit 证据。
- `npm run test:ios` 的绿是“本机判据”，不是端到端验收；`check:ios-gates` 的红是**已确认的真实缺陷**
  （不是环境噪声：3.9 与 3.12 两种解释器都 EXIT=1）。
- 所有“省多少 / 多少次”的量级都是**代码常量推导**，不是设备实测；B3/B4/B5 的收益判断依赖这个
  推导，若将来有真机埋点数据，应按本文触发条件重估。
- 本文不改动 `deliverables/README.md` 索引，以保持唯一新增文件；如需归档，后续按仓库约定补一行。
