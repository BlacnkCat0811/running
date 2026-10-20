# iOS 同步补齐 R1–R6 实施记录（2026-10-19）

- 基线：`67028e1`（本记录只描述工作树改动；**尚未提交**）。
- 依据：[IOS_SYNC_REREVIEW_2026-10-19.md](IOS_SYNC_REREVIEW_2026-10-19.md) 第 7–11 节的 R1–R3
  实施方案，以及同文档 §3 的 R4–R6 复审项。
- 范围：`apps/ios`（R1/R2/R3/R5/R6）、`apps/api` 与 `packages/storage-sqlite`（R4/R5 的服务端读侧）。
- **没有部署、没有重启生产、没有改写生产数据。**本记录不替用户做发布验收。
- 真机 HealthKit、手机安装构建号、杀进程恢复仍**未取得**；本文所有“通过”都是本机判据，
  不是端到端验收。

## 1. 落地内容

### R1（P1）· 到期窗口“被看到但不执行” / 未来复查无人负责

| 改动 | 文件 |
|---|---|
| 统一待办快照 `WorkoutWindowWork`（立即页 / 到期探测 / 最早未来时刻 / 过期数 / 读失败） | `HealthSyncBackgroundRecovery.swift` |
| 唯一执行计划 `HealthSyncWorkPlanner.plan`（任务 → 阻塞 → 新代次 → 窗口页/探测 → 续页 → 未来 → idle） | `HealthSyncWorkPlanner.swift`（新） |
| 探针一次遍历给出 due/未来/过期三态，读失败 = unknown | `RouteSyncState.swift`（`WorkoutBackfillScheduler.probe`）、`SyncTaskStore.probeWorkoutWindowWork` |
| 后台 action 消费统一计划；新增 `.runWorkoutWindowPass` | `BackgroundSyncPolicy.swift`、`HealthKitSync.performBackgroundPass` |
| 前台 handoff 接住窗口工作（走续读预算，不扣新代次额度） | `AppDelegate.handOffUncoveredGenerations`、`SyncFollowUp.handoff` |
| 后台/切后台按 `nextProbeAt` 安排既有 BGTask；更早的待发请求不被更晚重排推迟 | `BackgroundRunPolicy.nextBackgroundRequest` / `shouldReplacePendingRequest`、`AppDelegate.submitBackgroundRun` |
| 7 天过期在选取前用短事务落 `expired`（列 + `types_json` 同事务，回读断言） | `SyncTaskStore.settleExpiredWorkoutWindows`、`HealthKitSync.performSync/performBackgroundPass` |
| 零进展退避（窗口页装不下时不留原地自旋） | `HealthKitExport.writeGlobalRecords` 窗口循环 |

### R2（P1）· observer 跨线程写入后旧确认删新通知

| 改动 | 文件 |
|---|---|
| SQLite 意图表 `sync_observer_intents`（schema v5，与任务行同库） | `SyncTaskStore.swift` |
| 独立串行队列 + 独立连接 + 有界 busy timeout 的意图日志；`record` 事务内回读、`acknowledge` **条件删除**（`WHERE url_scope = ? AND generation = ?`） | `HealthSyncIntentJournal.swift`（新） |
| 生产写入/读取/确认全部改走 journal；观察者 `recordThenComplete` 的 record 闭包用它 | `HealthKitSync.swift` |
| 旧 UserDefaults 意图按 scope 迁移：事务内导入 → 回读 → COMMIT → 删旧键；新写入优先，不倒退 | `HealthSyncIntentJournal.migrateLegacy` |
| 启动时按当前目标 URL scope 显式迁移 | `HealthKitSync.publishObserverTarget` |

`changes = 0` 是合法无操作（新代次已覆盖/旧代次已确认），**不会**随后无条件删除；SQL 失败
返回 `.failed` 并把意图原样留在库里。存储持续不可写且进程退出时**不承诺**耐久保存，这条
边界写进代码注释、没有用无限重试掩盖。

### R3（P1）· 分页仍未实现 / 类型计数不是交付进度

| 改动 | 文件 |
|---|---|
| 独立分页键 `(scope, workoutUUID, windowRevision, recordType)`、状态闭集、页接受/EOF/缺锚点/删除-only/授权失败/被拒的纯判据 | `WorkoutWindowPaging.swift`（新） |
| `HKAnchoredObjectQuery` 分页查询（窗口谓词固定、锚点即下一页断点、缺锚点不推进） | `HealthKitExport.anchoredWindowPage` |
| 窗口通道改为 anchored 分页：公平轮转（`lastServedAt`）、满页继续、EOF 保留 anchor 等下次探测 | `HealthKitExport.writeGlobalRecords` |
| schema v5：`sync_workout_type_pages`（committed anchor、state、next_check_at、eof…） | `SyncTaskStore.swift` |
| 任务行携带 `pendingWorkoutPages`（上传前落盘、恢复轮透传、显式 `decodeIfPresent` 降级） | `SyncTaskState.swift`、`HealthKitSync.saveTask/恢复分支` |
| 页进度只在 `commitSuccess` 的**同一事务**里提交，且带前驱锚点 CAS（陈旧候选只跳过、不倒退） | `SyncTaskStore.commitSuccess`、`HealthKitSync.markSuccess` |
| 纯空查询走窄事务 `commitEmptyWorkoutPageObservations`（不生成空 ZIP、不碰正式游标） | `SyncTaskStore.swift`、`HealthKitSync.performSync` |
| 窗口扩宽 ⇒ revision +1（新行、从 nil 重读），旧在途 revision 仍可结算 | `WorkoutWindowPaging.windowRevision` |

### R4（P2）· 分析新鲜度漏掉路线与旧时间区间

- 新增 `packages/storage-sqlite/src/read/batch-analysis-dirty-evidence.ts`：对
  `import_batches.analysis_dirty_plan_json`（v45）做严格解析（absent / invalid / ok）。
  不能直接 import `@rai/health-export-parser`（依赖方向相反，会成环）。
- `workout-read-repository.ts` 的 `SessionTouchMatcher` 增加：`dirtyFromAt`（与写侧同一谓词
  的级联）、`routeDirtyTimes`/`recoveryBoundaries` 落在窗口内的时刻、`full`/无效证据的
  “所有训练”、以及 `previous_effective_at` / `previous_end_at` 合并后的区间。
  脏证据只对已经处于 uncovered/in-flight/failed 的批次读取（不造第二事实源）。
- 回归：`packages/storage-sqlite/test/analysis-freshness-dirty-evidence.test.ts`（7 条）+
  `apps/api/test/workout-visibility-freshness.test.ts` 两条三入口一致性用例。

### R5（P2）· 三态字段只解码、展示仍沿用旧“完整”语义

- `SyncPresentationPolicy.swift`：新增唯一的 `isPartial` 推导。有新三态字段时：
  分析未发布 / `stabilityState == settling` / 任一指标 `not_seen_yet` ⇒ 仍在补齐；
  没有三态（老服务端）⇒ 仍按 `completeness != complete`。
  已发布 + stable + 没有 `not_seen_yet` ⇒ 即使旧 `completeness == partial` 也不再显示横幅/轮询。
- 文案不再断言「Apple Watch 仍在传输」：改为「部分指标尚未观察到，可能仍在补传或同步」；
  `unsupported` 不进入“等待”。
- API `completeness` 契约**未改**（保持旧客户端兼容），新语义在客户端消费；服务端
  `deliveryState/analysisState/stabilityState` 字段与响应不变。
- 回归：`TechPresentationRegression.swift` 增加 11 条（delivered+complete+power not_seen_yet、
  published+stable+partial、unsupported-only、legacy fallback…）。

### R6（P2）· 覆盖跳过关闭后历史带过滤锚的恢复方案

**已实现防御性逐类型修复**（第二轮，2026-10-19）。核实与实现：

- 证据：`git log -S 'allowsHistorySkip' -- apps/ios/RAI/HealthKitRecordCursor.swift`
  全历史只命中 `33f79fe`，值就是 `false` ⇒ **没有任何已提交/已分发构建写入过
  `historyCoverageFloor`**。但无法证明用户没装过带 `true` 的本地调试构建。
- 检测：`SyncCoveragePolicy.hasDisabledCoverageFloor(cursor)` —— 开关关闭却读到 floor
  即“来源不可信”。
- 迁移：`HealthKitExport` 对该类型丢弃旧锚点（`decodedAnchor = nil`）、强制
  `.historyFromScratch` 历史重放一次（**不能** `.historyResume`：旧锚点建立在旧谓词上），
  重放完成后新游标不写 floor，自然清除；不影响其它类型/正式水位/已入库事实。
- 回归：3 条检测 + 2 条段计划 + 结构门禁调用点；详细见
  [IOS_SYNC_FOLLOWUP_PLAN_2026-10-19.md](IOS_SYNC_FOLLOWUP_PLAN_2026-10-19.md)。

### 并发审查提出的 A1/A2/A3 修正（本轮已并入）

同一工作区的独立核验报告（`HEALTHKIT_SYNC_REPORT_VERIFICATION_AND_PLAN_2026-10-19.md`）指出了
本实施首版的三处缺口，本轮已修：

- **A1 · 意图库阻塞边界**：`HealthSyncIntentJournal` 的 busy timeout 从 2000ms/3 次降到
  250ms/2 次；MainActor 路径（`recordBackgroundIntent`、`markSuccess` 确认、启动迁移）改为
  `recordInBackground` / `acknowledgeInBackground` / `migrateLegacyInBackground`（同一串行队列，
  只入队不等写事务）；观察者回调仍同步落库（`completion()` 前耐久），有 250ms 上界。
  连接显式 `journal_mode=WAL; synchronous=FULL`，并暴露 `journalMode` 供回归核对（配置失败
  写诊断，不伪装成功）。回归新增 4 条（WAL、后台记录可见、后台确认生效、异步旧确认不删新代次）。
- **A2 · 公平排序真正接入导出**：`HealthKitExport` 的窗口循环改为
  `WorkoutWindowPaging.serviceOrder(pages, now:)` + `descriptorIndexByType` 映射，不再按旧数组
  下标配对；结构门禁新增对应判据（只测 `serviceOrder` 本身不算接线证据）。
- **A3 · Coverage 请求短路**：`SyncCoveragePolicy.needsCoverageQuery` 增加 `allowSkip`（默认取
  `allowsHistorySkip`，当前为 `false`）⇒ 关闭历史跳过时不发覆盖请求、也不再打印“历史段将
  跳过已覆盖部分”；回归新增默认关闭时缺游标/历史续读都不请求的两条。

### 服务端/文档外的其它改动

- `SQLiteSupport` 标记 `nonisolated`（意图日志在观察者队列上使用同一套底层封装）。
- 结构门禁更新：`check-background-capabilities.py` 的窗口判据改为 anchored 分页形态
  （`observed: result.added.count` + `pageLimit`），不再要求“A2 尚未实现”的旧注释。

## 2. 本机验证（截至本记录）

| 检查 | 结果 |
|---|---|
| `npm run test:ios` | **通过**（类型检查 98 文件、跳过 3 个仅高德依赖文件；含全部 Python 结构门禁 342 条；receipt 153 / cursor 96） |
| `bash apps/ios/tests/run-health-sync-tests.sh` | 通过：intent journal 71 条、分页纯判据 17 条、分页落盘 26 条、窗口/恢复/提交既有判据全绿 |
| `node --import tsx --test --test-concurrency=1`（R4） | 17/17（新脏证据文件 7 + API freshness 10，含路线-only/时间迁移三入口） |
| 完整 storage 套件（R4 lane） | 249/249；`apps/api/test/pr5-read-side.test.ts` 42/42 |
| `npm run typecheck` | 通过（两个 tsconfig） |
| `npm run check:docs` / `check:doc-refs` | 通过：97 文件 / 656 本地链接 / 0 问题；143 处引用、0 越界 |
| `npm run check:acceptance-matrix` | 通过（80 条 cited / 0 missing） |
| `RAI_TEST_CONCURRENCY=2 npm test` | **2159 条：2155 通过 / 1 失败 / 3 跳过**。唯一失败是 `packages/health-export-parser/test/native-worker.test.ts` 的 Rust/TS `import_entity_generations` 行哈希不一致，**与本次改动无关**（该文件未修改，本机 Rust worker 为既有产物）；单跑同样失败，不能写成"全绿"。 |
| `npm run test:ios:mutation:scope` | **104/107 选中突变判定正确**（首轮）。发现的 5 个问题全部是**门禁自身**的陈旧/过宽锚点（manifest 旧写法 0 命中、`hasMorePages` 片段重复 2 次、`commitSuccess` 单行调用已改写、runner 注释里的文件名造成反孤儿锚点重复、`routeEntries` 突变插入缺 `(` 而无法被顺序判据抓住），不是产品代码失败。逐条修锚后 5 条均重新 `RED assertion_hit=True`；最后一次 targeted 复跑：baseline GREEN，1/1 通过，restored GREEN。**仍不是全量验收**（`RAI_MUTATION_FOR` 只跑输入面命中的 107 条）。 |
| 真机 HealthKit / 手机安装构建 / 杀进程恢复 | **未取得**，仍是独立验收项 |

## 3. 未完成 / 必须真机验收的部分

1. **app 未编译成安装包**：本机只做到 `typecheck` + 纯逻辑/结构门禁。`HealthKitExport`/
   `HealthKitSync` 不在任何回归编译单元里，anchored 分页的真实返回形态（空结果是否给 anchor、
   删除回调、部分读权限）必须真机确认；不满足预期时**禁用窗口分页开关**。
2. **回归矩阵的 T01/T04/T20 只走到调用方装配/计划层**，没有把“探针 → 导出 → 上传 →
   committed → 本地提交”整条真机链路跑出来。T15（同一时间戳跨页 UUID 全集）也只能真机验。
3. **R5 的视图图标/文案**已改，但 `TechViews`/`TechSeriesChart` 不进入本机可执行门禁
   （无 xcodebuild），只能靠类型检查与人工核对。
4. **R6 未实现**，理由见 §1；不得把“覆盖跳过关闭”当成旧带过滤锚已迁移。
5. 生产仍是 `33f79fe`；本地这些改动**没有部署**。iOS 修复是否生效取决于手机安装的构建。
6. **Rust parity 的 10 条用例仍未真正执行**：本机无 cargo，工作区 `target/release` 产物
   早于 `c644c49`。本轮修的是“把过期产物误报成产品失败”；真正跑通仍需在带 Rust 工具链的
   机器上 `cargo build --release`（`RAI_REQUIRE_RUST_TESTS=1` 可作为发布闸门）。
7. **并发审查 A1/A2/A3 已修**（非阻塞 MainActor 写、公平轮转接入生产、Coverage 短路）；
   **B1/B2 已在第二轮实现**；B3–B6/C1 的可执行方案与验收见
   [IOS_SYNC_FOLLOWUP_PLAN_2026-10-19.md](IOS_SYNC_FOLLOWUP_PLAN_2026-10-19.md)。

## 4. 回滚边界

1. 本地 schema 纯追加（v5 两张表），不做 down migration、不删新表；旧任务按原路径先跑完。
2. 分页通道若有真机问题：用**仍认识 schema 5** 的新构建关闭窗口分页（保留已生成的候选与
   `caught_up` 行），页面诚实显示“补齐未完成”，再回到正式增量通道；不要退回不认识新候选的
   旧 schema 4 App 并声称无损。
3. 意图日志失败时不要退回“observer 写 UserDefaults、MainActor 读删”的双真源；正确的回退是
   保留 journal 并把失败分类交给诊断（回退到双真源会原样长回 R2 的竞态）。
4. 任何修改全局记录游标策略/observer 失败确认合同的尝试都要单独评审，不混在本次性能改造里。
