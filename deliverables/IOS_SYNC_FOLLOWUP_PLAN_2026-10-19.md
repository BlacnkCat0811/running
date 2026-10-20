# iOS 同步后续项核实与可实施方案（2026-10-19 第二轮）

- 基线：本地工作树（`67028e1` + 前轮 R1–R6 实施改动，尚未提交）。
- 触发：上轮交付明确留下的三块未完成项 —— R6 代码迁移、`npm test` 的 1 条既有失败、
  并发报告 B1–B6/C1。
- 边界：只读核实 + 本机代码/回归；**没有部署、没有重启生产、没有真机 HealthKit 证据**。
  本文所有“通过”都是本机判据，不是端到端验收。

## 0. 结论摘要

| 项 | 核实结论 | 本轮处置 |
|---|---|---|
| R6 旧覆盖下界 | 可证明**没有任何已提交/已分发构建写入过** floor（`allowsHistorySkip` 全历史只出现过一次，值就是 `false`）；但调试构建无法证明 | **已实现防御性逐类型历史重放**：检测到“开关关闭仍带 floor”的游标时，丢弃旧锚点、从 nil 重读该类型一次（不清其它游标、不删正式水位） |
| `npm test` 1 条失败 | 不是产品回归：**HEAD 上同样失败**；根因是本机 Rust 产物（10-16）早于 parity 修复 `c644c49`（10-18），且本机没有 cargo 无法重建 | **已修测试/启动判据**：产物早于 Rust 源码时按“不可用”跳过并打印重建命令；`RAI_REQUIRE_RUST_TESTS=1` 仍强制失败；Rust 引擎启动时拒绝过期产物 |
| B1 启动/前台分析对账 | **真实缺口**：对账只在同步收尾调用，冷启动/前台不触发 | **已实现**：新增有界入口（不读 HealthKit/不触发上传，已持久终态不联网），单飞/身份/目标/文案新旧判据 + 12 条纯回归 |
| B2 游标更新集中化 | **真实缺口**：4 处手抄 8 字段的游标重建 | **已实现**：3 个集中 helper + 首装显式初始化；4 条逐字段回归（2026-10-19 复核更正：原写 6 条），结构门禁改为钉 helper |
| B3 查询前预算 hint | 现有 `shrinkLimit` 已覆盖“放不下后收缩”；“查询前 hint”需先采集 query/render/retry 数据 | 本轮不实施，给出可执行步骤与验收（§2.1） |
| B4 批内精确去重 | 当前跨通道重复依赖服务端 UUID 幂等；无批内去重；报告本身要求先统计 | 本轮不实施，给出统计口径与实施/回滚（§2.2） |
| B5 少一次 ZIP 复制 | 真实存在一次“分块读 + 哈希 + 复制”；但取消/所有权语义需要成组改 | 本轮不实施，给出安全实施顺序（§2.3） |
| B6 测试缝替代文本门禁 | 真实债务（大量结构门禁依赖源码文本）；属于渐进式重构 | 本轮不实施，给出分阶段方案（§2.4） |
| C1 raw ZIP / 新记录协议 | 并发报告自身结论是**暂缓**；与“已部署 33f79fe 兼容性/回滚”冲突 | 不实施，维持现有 ZIP/XML + 持久回执协议（§2.5） |

## 1. 核实证据

### 1.1 R6：旧覆盖下界从未被已提交构建写入

```bash
git log --oneline -S 'allowsHistorySkip' -- apps/ios/RAI/HealthKitRecordCursor.swift
# 33f79fe fix(ios): 同步补齐闭环——覆盖跳过闸门、本批窗口生效、到期窗口接入待办
git show 33f79fe:apps/ios/RAI/HealthKitRecordCursor.swift | grep -n 'allowsHistorySkip'
# 445:    static let allowsHistorySkip = false
```

- 全历史只有 `33f79fe` 一次命中，且值就是 `false`；生产 `33f79fe` 与本地 `67028e1`
  同值。
- `historyCoverageFloor` 的写入路径只在 `allowsHistorySkip == true` 时取到非 nil 下界
  （`currentQueryFloor` / `segmentFloor` 的三条分支都由该开关门控）；因此**已提交构建
  不可能写出 floor**。
- 仍保留的不可证明项：某人手工安装过带 true 的本地调试构建。故实现防御性修复，而不是
  只写一句“不会发生”。

实现（`HealthKitRecordCursor.swift` / `HealthKitExport.swift`）：

```swift
static func hasDisabledCoverageFloor(_ cursor: HealthKitRecordCursor?) -> Bool {
    !allowsHistorySkip && cursor?.historyCoverageFloor != nil
}
```

- 命中时：`decodedAnchor = nil`，`history = true`，段计划只有 `.historyFromScratch`
  （**不能** `.historyResume` —— 旧锚点是用旧谓词建立的）；
- 成本：只影响该类型一次历史重放；不清正式水位、不清其它类型游标、不删除数据；
- 回归：3 条检测判据 + 2 条段计划判据；结构门禁钉住 `HealthKitExport` 的调用点。

### 1.2 `npm test` 的 1 条失败：HEAD 同样失败，根因是过期 Rust 产物

证据（本机）：

```bash
git worktree add --detach /tmp/head67028 67028e1
ln -s /Users/ta/running/node_modules /tmp/head67028/node_modules
ln -s /Users/ta/running/target/release/rai-data-worker /tmp/head67028/target/release/rai-data-worker
cd /tmp/head67028 && node --import tsx --test --test-concurrency=1 \
  packages/health-export-parser/test/native-worker.test.ts
# not ok 1 - Rust decoded data preserves TS stable IDs, metadata, routes, updates, and tombstones
```

- HEAD（未含本轮任何改动）同样失败 ⇒ 与本轮代码无关。
- 产物 `target/release/rai-data-worker` mtime = **2026-10-16 19:04**；parity 修复
  `c644c49`（“增量账本补齐 before 侧字段，恢复 TS↔Rust parity”）提交于 **2026-10-18**。
- 本机无 `cargo`/`rustc`（`cargo --version` → 127），无法重建产物；失败信息因此把
  “环境产物过期”报成了“产品 parity 坏了”。

本轮处置：

1. `native-worker.ts` 新增 `nativeWorkerAvailability()` / `nativeArtifactState()` /
   `newestNativeSourceMtimeMs()`：产物存在但**早于** Rust 源文件或 Cargo 清单 ⇒ `stale`，
   原因指向 `npm run rust:build`；源码树不存在（打包部署）不判过期。
2. `native-worker.test.ts` / `native-import-worker.test.ts` / `healthkit-record-sync.test.ts`
   改用该判据：过期时测试**显式跳过并打印原因**；`RAI_REQUIRE_RUST_TESTS=1` 仍抛错，
   强制有产物的人必须先重建。
3. `apps/api/src/server.ts`：Rust 引擎 + `fallback=none` 时，过期产物与缺失同等对待
   （拒绝启动 Rust 车道），避免旧 worker 把与 TS 不一致的结果写进真实健康库。
4. 新增 `native-worker-availability.test.ts`（缺失/过期/最新/打包部署四种形态）。

### 1.3 B1：启动/前台对账是真实缺口，已实现

核实：`reconcilePendingAnalysis` 的唯一生产调用点在 `performSync` 的 `settled` 分支；
对账槽 `sync_analysis_reconcile` 已持久化 `receiptId/analysisJobId`，但冷启动/回到前台
没有入口 —— 服务端先算完、App 后重启时，界面会一直停在旧结论直到下一次同步收尾。

实现：

- `HealthSyncSync.reconcileAnalysisOnEntry(to:apiToken:)`：取离线握手/URL scope → 读槽；
  - 槽已是终态：`publishPersistedAnalysisMessage` 直接恢复文案，**不联网**；
  - 需要终态且 token 非空：单飞闸门 + `AnalysisReconcileEntryPolicy.shouldAttempt`，
    最多一次 `GET /v1/jobs/:id`；
  - `await` 之后只有“没有新一轮同步 + 服务端未切 + 权威 scope 未切”才改文案；否则只写
    捕获 scope 的槽（`canPublishAnalysisMessage`）。
- 纯判据 `AnalysisReconcileEntryPolicy`（`DirectSyncCursorPolicy.swift`）：
  `shouldAttempt` / `usesPersistedTerminal` / `canPublishMessage`。
- 触发点：`RAIApp` scenePhase `.active`（冷启动与回到前台都经过）。
- 回归：`DirectSyncReceiptRegression` 新增 12 条（2026-10-19 复核更正：原写 9 条）；结构门禁更新为“入口调用 + 单飞/判据 +
  持久终态分支”，并保留“对账不得进入 `markSuccess`”的既有判据。

### 1.4 B2：游标手抄字段是真实缺口，已实现

核实：`HealthKitExport` 有 4 处 `HealthKitRecordCursor(...)` 重建，每处手写全部 8 个字段；
新增通道字段时任何一处漏带都是静默的（历史上 `lateBackfillWindowStart` 漏带造成补读每批
重读同一页）。

实现（`HealthKitRecordCursor.swift`）：

```swift
func settingRecentWindowReadAt(_ value: Date) -> HealthKitRecordCursor
func settingLateBackfill(at: Date?, before: Date?, windowStart: Date?) -> HealthKitRecordCursor
func advancingAnchor(anchor: Data, historyReadAt: Date,
                     historyReplayPhase: HistoryReplayPhase?,
                     historyCoverageFloor: Date?) -> HealthKitRecordCursor
static func established(anchor:historyReadAt:historyReplayPhase:historyCoverageFloor:)
```

- 结构门禁从“钉 `lateBackfillBefore: previous?...` 字面量”改为“钉两处重建都走 helper +
  helper 内部透传”，避免门禁绑定实现细节。
- 回归：4 条（B2 新增；该文件本轮共新增 11 条 = B2 4 + A3 2 + R6 5。2026-10-19 复核更正：原写 6 条）。

## 2. 未实施项的可执行方案（本轮不代码化）

### 2.1 B3 · 查询前预算 hint（先测量，后接线）

前提：现有 `HealthKitRecordCursor.drain` 已有“放不下 → `shrinkLimit` 严格收缩 → 同锚点重查”
的安全闭环；hint 只是把**第一次**查询的 `limit` 估小，减少“渲染完整页后被拒绝”的重查。
报告本身要求先采集 query/render/retry 数据，不能凭均值猜。

步骤：

1. 采集：在 `drain` 每次 query 前/后记录 `(type, limit, returned, renderedBytes, renderedRecords,
   rejectedByBudget, retryCount)` 的**聚合计数**（复用 `ExportChannelCounts`，只写计数）；
2. 估参：按类型维护“上批已接受页的每记录字节”滑动值（进程内即可，不持久化）；
3. 接线：`drain` 增加 `suggestedLimit(pageLimit:)` 参数（默认 = 现行为），只作 hint；
   `acceptsWithin` 与 `shrinkLimit` 仍是安全判据，hint 不参与正确性；
4. 验收：均匀/偏斜/超大单条/删除-only/接近满额/取消六组用例交付集合与游标不变；
   统计“接受前重查次数”下降且无新增超界；
5. 回滚：删除 hint 参数即回原 limit。

⛔ 不做：缓存页切片 + 整页 anchor 提交（前缀没有对应 anchor，必须重查）；不做持久字段。

### 2.2 B4 · 批内精确去重（先统计，再按通道收敛）

现状：窗口/补读/正式 anchor 三通道可能返回同一 `(type, UUID)`，客户端有意依赖服务端
UUID 幂等；把 `insertedRecords` 低直接当“查询浪费”会误判。

步骤：

1. 统计：本批维护 `acceptedRecordKeys: Set<String>`（受单批预算约束），记录“同一 key 被
   第二通道再次写入”的计数（`duplicateRecordsByChannel`），先观察真实重叠率；
2. 去重：仅当**本批已接受载荷**中已有同 `(type,UUID,规范化内容)` 时跳过渲染；同 UUID
   内容变化不得被旧值遮蔽；
3. 守恒：删除事件独立计；候选游标只依附“包含原记录的同批 durable 回执”，禁止走
   “空导出就成功”；
4. 验收：同一合成事件日志对拍“记录内容集合 + 删除集合 + 最终游标”，传输更少但集合一致；
   36–72h 迟到、>48h、>7d、30d 再武装四类场景全覆盖；
5. 回滚：关去重恢复“多发不漏”，不清任何已确认游标。

### 2.3 B5 · 少一次 ZIP 复制（先改所有权，再省拷贝）

现状：`HealthSyncArchive.prepare` 对源 ZIP 做“分块读 + SHA256 + 复制到 artifacts 目录”，
随后删除源文件。能省的是这次复制，但必须同时处理：取消发生在哈希后/移动前、同名归档
已存在、后台 URLSession 已持有源文件所有权、崩溃恢复时源与目标谁是真源。

步骤：

1. 先在导出目录内计算哈希（`fileHash` 已有），再 `moveItem` 到按哈希命名的目标；
2. 目标已存在且哈希相同 ⇒ 直接删源；哈希相同但字节不同（理论上不）⇒ 拒绝并保留两者；
3. 取消点只允许在 move 之前；move 是原子同卷操作，之后按“已发布”处理；
4. 回归：取消各阶段、同名、跨卷回退（move 失败 ⇒ 回退复制）、崩溃重开；
5. 验收：上传字节不变、`payloadHash` 不变、恢复路径不变；`git diff` 只影响归档层；
6. 回滚：保留复制实现作为 fallback 开关。

### 2.4 B6 · 测试缝替代易碎文本门禁（渐进式）

现状：`check-background-capabilities.py` / `check-healthkit-record-sync.py` 等用
`tail_after`/`ordered`/字符串计数钉接线；本轮已两次因实现搬家而误报（不是产品失败）。
但“一刀切删门禁”会丢掉真正的结构保护。

步骤（按文件分批）：

1. 给每个被钉的生产路径抽一个**可注入的纯决策函数**（如 `BackgroundRunPolicy`、
   `RecordReplayPlan`、`AnalysisReconcileEntryPolicy`），让结构门禁只钉“调用点存在 +
   参数来自纯函数”，不再钉内部字段名；
2. 每替换一批，先在旧门禁上跑 mutation（确认仍能变红），再删除对应文本断言；
3. 验收：至少 3 个曾被误报的门禁在搬迁实现后仍绿；3 条代表突变仍 `assertion_hit=True`；
4. 回滚：门禁与测试缝同批提交，不同批删文本断言。

### 2.5 C1 · raw ZIP / 新记录协议（维持暂缓）

并发报告结论：暂缓。理由与本次边界一致：生产 `33f79fe` 仍在用现有 ZIP/XML + 持久回执；
换协议需要服务端/客户端/回滚三线同时发布，且当前没有“查询/渲染”瓶颈证据支持它。
本轮回滚边界仍要求“旧 schema 4 App 不列为无损回滚”。

## 3. 本轮实施与验证

### 3.1 文件

- R6：`apps/ios/RAI/HealthKitRecordCursor.swift`、`HealthKitExport.swift`、
  `HealthKitRecordCursorRegression.swift`、`check-healthkit-record-sync.py`。
- `npm test` 失败：`packages/health-export-parser/src/native-worker.ts`、`index.ts`、
  `apps/api/src/server.ts`、三个测试文件 + 新增
  `packages/health-export-parser/test/native-worker-availability.test.ts`。
- B1：`DirectSyncCursorPolicy.swift`、`HealthKitSync.swift`、`RAIApp.swift`、
  `DirectSyncReceiptRegression.swift`、`check-direct-sync-analysis-reconcile.py`。
- B2：`HealthKitRecordCursor.swift`、`HealthKitExport.swift`、
  `HealthKitRecordCursorRegression.swift`、`check-healthkit-record-sync.py`。

### 3.2 验证

| 检查 | 结果 |
|---|---|
| `npm run test:ios` | **通过**：类型检查 98 文件；Direct sync receipt 150 条；Record cursor 96 条；record-sync 结构门禁 121 条；capabilities 342 条 |
| `node --import tsx --test ...`（native 四文件） | **33 tests / 23 pass / 0 fail / 10 skip**；跳过原因统一为“binary older than sources; rebuild with npm run rust:build” |
| `npm run typecheck` | 通过 |
| `RAI_TEST_CONCURRENCY=2 npm test` | 见 §3.3（本轮重跑结果） |
| `npm run check:docs` / `check:doc-refs` / `check:acceptance-matrix` | 见 §3.3 |
| 真机 / 部署 | **未做**，仍是独立验收项 |

### 3.3 全量命令结果

- `RAI_TEST_CONCURRENCY=2 npm test`：**2160 条：2147 通过 / 0 失败 / 13 跳过**。
  跳过数从 3 增至 13 的原因是 10 条 Rust parity 用例现在**显式跳过并打印原因**
  （本机产物早于源码、无 cargo 可重建），而不是伪装成产品失败。要真正跑这 10 条：
  `cargo build --release`（或 `npm run rust:build`）后重跑；`RAI_REQUIRE_RUST_TESTS=1`
  会在产物过期/缺失时直接抛错，不会静默跳过。
- `npm run test:ios`：通过（类型检查 98 文件；receipt 150；cursor 96；record-sync 121；
  capabilities 342；其余既有回归全绿）。
- `node --import tsx --test`（native 四文件）：33 tests / 23 pass / 0 fail / 10 skip，
  skip 原因均为“rebuild with npm run rust:build”。
- `npm run check:docs`：通过（98 文件 / 659 本地链接 / 0 问题）；
  `npm run check:doc-refs`：143 处引用，0 越界/无法解析；
  `npm run check:acceptance-matrix`：通过（80 条 cited / 0 missing）。
- `git diff --check`：通过。
- `npm run test:ios:mutation:scope`：**本轮未重跑**（新增代码没有配套突变条目；上一轮
  已有的门禁锚点已按实现搬迁逐条修复并 targeted 复跑）。不把“没跑”写成通过。
