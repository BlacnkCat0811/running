# Lane 3：iOS 客户端（apps/ios）架构审查

- **基线**：`git HEAD = 9db450f`（`2f5f2b8 统一训练排课 v2` + `62f490b 同步复核 R1–R6` 之后）。审查对象是当前工作树，产品代码零改动，`git status` 只剩本文件。
- **方法**：只读代码审查（E1 逐行 / E2 跨文件交叉核对），未运行 `npm run test:ios`（Lead 统一跑）、未跑 Xcode 构建、未碰真机/Simulator、未读写 `var/`。行号全部对齐 HEAD 重新核对，不抄文档旧行号。
- **覆盖**：`apps/ios/RAI/**`（101 个 Swift / 38.7k 行，其中根目录 58 个 / 28.1k，`Skins/Technology` 43 个 / 10.6k）、`apps/ios/tests/**`（35 个回归 Swift / 16.4k 行 + 12 支 `check-*.py` / 7.4k 行 + 12 支 `run-*.sh`）、`RAI.xcodeproj/project.pbxproj`、`Podfile`、`Info.plist`；契约消费侧只读 `APIModels.swift` / `APIClient.swift`，服务端只用于核对合同（`apps/api/src/server.ts`、`training-plan-routes`、`mobile-goals.ts`）。
- **术语**：P0 数据丢失/安全漏洞/生产不可用；P1 发布阻断或硬架构不变量被破坏；P2 用户可见错误或高概率结构性风险；P3 低影响/可维护性。证据等级 E1 静态逐行确认、E2 跨文件交叉核对、E3 推断（写明前提）。

---

## 0 结论摘要

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 0 | 未发现客户端侧数据丢失、凭证泄露或生产不可用 |
| P1 | 1 | 计划**写**路径仍多路复用旧路由，其中 3 条在 HEAD 服务端已 410 退役；统一训练页仍暴露「手动课表」入口（I1） |
| P2 | 5 | 视图层穿透（I2）、写侧状态所有权未收敛（I3）、同步状态机横跨 5 文件且不可回归编译（I4）、410/退役码无分类，读侧语义错、写侧不锁死（I5，Lead 复核修正）、能力协商无注册表（I6） |
| P3 | 9 | 合并成表（§3 末），含 DTO god file、门禁脚本手维护编译表、AMap 依赖边界等 |

**总体判断**：这条 lane 的架构水位明显高于 2026-10-18 那轮——读侧已经收成"`TrainingPlanStore` 单一所有权 + `PlanStatePolicy` 纯函数判定 + `TrainingPlanRepository` 唯一网络/缓存入口"，同步侧把阶段闭集（`SyncPhase`）、锚点推进判据（`mayAdvanceAnchor`）、后台调度判据（`BackgroundSyncPolicy`/`HealthSyncBackgroundRecovery`）都抽成了可单测纯函数，并配了"阶段闭集 ↔ 展示文案"双向配平门禁（`run-tech-presentation-tests.sh:673-704`）。真正的架构缺口不在"分层有没有写出来"，而在**两处未收敛的边界**：一是**写路径**（`NativeAppModel` 仍是写入与发布编排的唯一所有者，且写入路由表里躺着 3 条已退役端点），二是**视图→网络**（5 个次级视图直接 `RaiAPIClient()` 取数，绕开 AppModel 与缓存/失效体系）。可测试性的天花板也很清楚：`HealthKitSync.swift`(3839) + `HealthKitExport.swift`(3026) = 6.9k 行、占生产代码 18%，**不被任何回归编译**，只有源码子串门禁。

**最该先做的 3 件事**：① 把「手动课表」入口按服务端能力隐藏或重接到 v2 命令端点，并加一条"客户端源码不得出现已退役路径"的结构门禁（I1）；② 把 5 个视图的直接取数搬回 AppModel/Store 并加门禁（I2）；③ 把 `publishPlan/replayPlanPublication` 的路由表与能力位一起收进 `TrainingPlanStore`/单一发布器，让写入只有一条路径（I3）。

---

## 1 实际架构（as-built）

### 1.1 组件与体量

| 层 | 文件 | 行数 | 职责 |
| --- | --- | --- | --- |
| 皮肤/视图 | `Skins/Technology/*.swift`（43） | 10 631 | SwiftUI 页面、视图局部状态（sheet/编辑草稿） |
| 应用门面 | `NativeAppModel.swift` | 2 309 | 会话编排、**全部计划写**、读取面板归并、缓存键 |
| 读侧状态 | `TrainingPlanStore.swift`(613) + `TrainingPlanRepository.swift` | 613+ | 计划读、revision 水位、回执账本、`accept*/acknowledge` |
| 纯策略 | `PlanStatePolicy`(630)、`SyncPhase`(263)、`DirectSyncCursorPolicy`(375)、`RouteSyncStateMachine`(331)、`SyncPresentationPolicy`(453)、`BackgroundSyncPolicy`(548)、`PlanMutationDisposition` | ~3.0k | 无副作用判据，全部可在 macOS 上单测 |
| 同步执行 | `HealthKitSync`(3839)、`HealthKitExport`(3026)、`HealthSyncIntentJournal`(478)、`HealthSyncBackgroundRecovery`(623)、`AppDelegate`(468) | ~8.4k | 采集/导出/上传/导入/提交/后台调度 |
| 本地持久化 | `SyncTaskStore`(2284)、`CacheStore`(493)、`HealthSyncArchive` | ~2.8k | `sync.sqlite`（14 表）、`cache.sqlite`（5 表）、产品文件 |
| 网络与 DTO | `APIClient`(617)、`APIModels`(2201/159 类型) | 2.8k | HTTPS Bearer、错误分类、Codable |
| 平台适配 | `WorkoutKitBridge`、`RouteSyncState`(1056)、`MapPrivacy`、`Keychain` | — | 唯一 SDK 边界 |

`@Observable` 只有 6 个：`NativeAppModel`、`TrainingPlanStore`、`ServerSession`、`ServerDiscovery`、`HealthKitSync`、`TrainingReminders`。默认隔离 `-default-isolation MainActor`（`run-model-tests.sh` 编译参数），`nonisolated` 只加在纯类型上。

### 1.2 真实依赖方向（与文档声明的差异）

声明的方向是 视图 → AppModel → 同步/存储/网络。实际有三条反向边：

1. **视图 → 网络**（5 条）：`TechDayWorkoutsView.swift:38`、`TechTodayMetrics.swift:44`、`TechSleepHistory.swift:42`、`TechShareCardView.swift:110`、`TechWorkoutExportView.swift:68` 各自 `RaiAPIClient()` 直接取数，并从 `ServerSession` 直接读 `apiToken`/`serverURL`。见 I2。
2. **视图 → 凭证身份**：`TechDayWorkoutsView.swift:12` 把 `native.feedbackScope + session.apiToken` 拼成 `.task(id:)` 的字符串（`:29`），凭证明文进入视图身份与比较逻辑（不进日志，但把 token 变成了 UI 状态机的一部分）。
3. **AppDelegate 与 HealthKitSync 并列作为同步编排者**：`AppDelegate.swift:33` 的 `registerSyncEntryPoints` 负责注册 observer、投递决策、BGTask 重排与"未覆盖代次"交接（`:129 handOffUncoveredGenerations`），`HealthKitSync` 负责执行。二者共同构成同步状态机，但**没有任何类型表达**这个分工（见 I4）。

正向依赖本身没有循环：`Skins` 不 import HealthKit（唯一例外 `TechRouteView.swift` 引 MapKit 类型），`NativeAppModel` 不 import HealthKit，`HealthKitSync` 不反向依赖视图。

### 1.3 三条数据流

- **健康数据**：HealthKit（只读）→ `HealthKitExport`（anchored 增量 + 窗口/cursor 记账）→ `HealthKitArchive`（ZIP 落 App Support/`rai-healthkit-<scope>/`）→ multipart → background URLSession → `inspect → startImport → waitJob` → `SyncTaskStore.commitSuccess`（单事务写 `sync_state`+`sync_record_cursors`+删任务行）→ 服务端评分 → `MobileTodayResponse` 等 DTO → 页面缓存。
- **计划**：`GET /v1/mobile/training-plan-state`（v2 合同，`X-RAI-Training-Contract: 2`）→ `TrainingPlanStore` 校验（身份/业务日/窗口/版本下限）→ `planPresentation`；写则 `NativeAppModel.publishPlan` → `planPublication` 持久账本 → 5 条路由之一。
- **缓存**：`cache.sqlite` 分两类——可淘汰 `cache_entries` 与**不可淘汰安全账目**（`plan_write_acknowledgements`、`plan_receipt_journal`、`app_metadata`），`clearCache` 只清前者（`CacheStore.swift:373-377` 的 `clear(scope:)` 只 DELETE `cache_entries`）。这一区分是文档承诺且代码成立，是本 lane 核到的少数"文档=实现"项。

### 1.4 与 `docs/ARCHITECTURE.md` 的差异

| 文档（2026-10-07） | HEAD 实际 |
| --- | --- |
| "iOS 有本地页面缓存和同步任务日志，不成为第二个独立评分/健康事实主库" | 成立：设备端零评分（`APIModels` 里 `score` 全是服务端字段），无 scorer 副本。但 `sync.sqlite` 已是**同步位置的唯一权威**（14 表、含重建逻辑 v1→v5），`sync_route_state`/`sync_observer_intents` 是不可重算的状态——"不是第二事实库"要读成"不是第二**健康**事实库" |
| "iOS 消费服务端结果" | 读侧成立；写侧仍是 5 条旧路由（其中 3 条已 410，见 I1） |
| 文档未写 | 视图层有 5 处直接取数；`NativeAppModel` 承担全部计划写与发布编排 |

---

## 2 架构评估（按 BRIEF §2 七维）

### 2.1 结构与边界 —— 读侧收敛、写侧与视图侧未收敛

分层不是画出来的：`TrainingPlanStore` 的 `private(set)` 属性（`:9-33`）让计划状态只能由 store 改，`TrainingPlanRepository` 把网络与缓存 IO 关在一个 `@MainActor struct` 里（`TrainingPlanRepository.swift:19-66`）。但**写**没有对应的所有者：`persistGoals`/`changeRunCoach`/`changeCoachLoop`/`saveCoachFeedback`/`lockNextSession` 全在 `NativeAppModel`，每个都自带 requestID/scope/configuration/token/URL 多重判据（如 `:1090-1093`、`:1758`），`acknowledgePlanWrite`(8 处)、`cancelInFlightPlanRefresh`(9 处)、`refreshPlanState`(20 处) 说明"发布成功后的一致性收尾"是**按调用点重复**的，不是一条路径。`TechManualPlanView` 的 `NativeGoalWeekDraft` 已经外移（`NativeAppModel.swift:2239-2260` 的注释记录了原因），这是正确的一步；同一手法尚未用于视图取数。

### 2.2 职责与单一数据源 —— 已收敛：阶段闭集、锚点判据、计划读

- 阶段值只有 `SyncPhase`（`SyncPhase.swift:13`，`String, CaseIterable`），`persistedPhases`/`terminalPhases` 由它派生；展示 `techSyncPhase`（`TechTheme.swift:572-594`）的文案与闭集**双向配平**由门禁跑（`run-tech-presentation-tests.sh:693-704`，缺文案或残留文案都红）。这是本仓"重复全集"缺陷的正面样板。
- 锚点推进唯一判据 `SyncPhase.mayAdvanceAnchor`，`HealthKitSync` 与 `SyncTaskStore.commitSuccess` 都调它，不是各自抄一份阻塞态清单。
- 计划读单一入口：`TrainingPlanStore.refresh`（`:309`）与 `refreshUnifiedPlan`（`:267`），AppModel 只转发（`NativeAppModel.swift:15-21`）。
- 未收敛的重复全集有两处：① 写路由表（`APIClient.swift:308` 的 5 字典 + `publishPlan(route:)` 的 5 个调用点 + `resolvePlanPublication` 的 4 个 case）：同一"路由集合"写在三处；② 能力位：服务端 handshake 14 个可选版本键（`server.ts:1042-1080`）↔ `RaiHandshake` 手抄（`APIModels.swift:8-31`），只有 direct-sync 一对有 parity 门禁（见 I6）。

### 2.3 一致性与并发模型 —— 设计可接受，靠调用方自觉的地方已收敛到少数

- 单写者是 `MainActor`（默认隔离）+ 单飞闸门，而不是 actor；跨异步的取消判据统一走 `isValid()` 闭包（requestID+epoch+scope+token+URL 五重），这是可接受的工程选择（提案 §2 也已明确"先固化不变量，不机械改 actor"）。
- 同步提交是"单事务 + COMMIT 前回读断言 + `sqlite3_changes()==1` + REAL 时间不动点"（`SyncTaskStore.commitSuccess`，见协议 §状态机）；失败方向是"整段回滚"，不是"写一半"。
- 阻塞态（`deferred_protected_data`/`auth_required`）绝不推进锚点，且不吃 15 分钟节流——这条是**硬不变量**，有独立回归 + 结构门禁。
- 需要承认的"靠自觉"面：`--` 无。已核查的边界是 `RouteSyncStateMachine.decide` 的 `shouldQuery == false ⇒ nextState 原样携带`，由遍历断言守。

### 2.4 故障隔离与可伸缩性 —— 客户端侧的背压与预算机制完整，但预算裁定不可测

分批（`DirectSyncBatchBudget`，服务端握手暴露上界）、单批记录/字节上限、窗口独立份额、每类型一页、30 分钟 job 轮询上限、上传只试一次（429 除外）、401 落 `auth_required` 不删产物——都有代码与文档对应。缺口是**预算裁定的顺序**（谁先跑、用哪份预算、记账落哪支）写在 `HealthKitExport.writeGlobalRecords` 里，只有源码子串门禁；上一轮 lane 4 的 I1（补读吃光批预算）正是这个缺口的产物，本轮核对仍然成立但**不是本轮新发现**。

### 2.5 可演进性 —— xcodeproj 已免维护，代价转移到了门禁脚本

`project.pbxproj` 用 `PBXFileSystemSynchronizedRootGroup`（`:25-33`，唯一例外集只排除 `Info.plist`），新增 Swift 文件**不需要改工程**——这是 iOS 侧最好的一处演进决定。代价转移到 `apps/ios/tests/run-model-tests.sh`：它用**手写 swiftc 参数表**列出每个参与回归的源文件（候选组一 `:32-42`、直连回执组 `:100-108` 等共 12 组），漏一个源文件的表现是"编译不过"（好）或"该文件没被回归覆盖"（坏）。`HealthKitSync`/`HealthKitExport` 落在这条线的盲区。

### 2.6 质量系统架构 —— 门禁执行者自检到位，"假绿"风险集中在两类

1. **有执行者**：12 支 `check-*.py` 全部被某个 `run-*.sh` 引用（实测逐支 grep：11 支被自动脚本引用，`check-background-mutations.py` 只经 `scripts/run-ios.mjs` 手工目标）；35 个回归 Swift 里只有 `VisualAcceptance.swift` 不属于任何 `run-*.sh`（它属于 Simulator 验收，属预期）。聚合链完整：`run-ios-gates.sh:69-71` → `typecheck-ios.sh` + `run-model-tests.sh` → 后者再链 7 支子 runner（+1 支可选突变脚本）与 7 支 python 门禁。
2. **跳过语义**：非 macOS/Xcode 显式打印"本次没有检查任何 iOS 源码"并 exit 0；缺 Python≥3.9 **按失败处理**（`run-ios-gates.sh:51-66`）。这是正确的方向（跳过 ≠ 通过）。
3. **强度上限**：结构门禁是**源码子串**判据（`check-background-capabilities.py`、`check-healthkit-record-sync.py` 等），`MIN_CHECKS` 是自报常数；突变验证（`check-background-mutations.py`）不在聚合入口、需手工且会改坏源码。真正钉行为的是 `*Regression.swift`（纯逻辑，实跑断言），而它们覆盖不到 `HealthKitSync`/`HealthKitExport`（不被编译）。
4. `-warnings-as-errors` 已进两条通道（`run-model-tests.sh` 头注释），把"该写 nonisolated 却没写"这类 Swift 6 未来错误挡在门外——强于上一轮。

### 2.7 安全与运维边界 —— Keychain 与日志纪律成立；上传产物是唯一"明文健康数据落盘"

`Keychain.swift` 用 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`（上一轮已核，本轮未改）；`ServerSession.swift:99-105` 在非 DEBUG 下强制 https；`Info.plist` 无 `NSAllowsArbitraryLoads`。本地敏感面两个：`cache.sqlite`/`sync.sqlite`/产物目录统一 `completeUntilFirstUserAuthentication`（`CacheStore.swift:68`、`SyncTaskStore.swift:196`、`HealthSyncArchive.swift:60`），以及**原始健康 ZIP/multipart** 会短期落在 App Support（`HealthKitSync.swift:3424-3431`），生命周期由终结结果驱动（成功删、确定性拒绝删、瞬时失败留）。这条与"锁屏时不可读健康库"并不矛盾：产物是应用加密文件，不依赖 HealthKit 硬件密钥，所以锁屏仍可续传——设计自洽，但意味着**锁屏期间设备上存在一份可读的原始健康导出**，属需要写明的残余风险（P3，非本轮引入）。

---

## 3 发现详情

### I1（P1，E2）计划**写**路径仍指向已退役路由，且统一页仍暴露「手动课表」入口

**位置**：`apps/ios/RAI/APIClient.swift:308`（路由字典）、`:314-317`（preview）；`apps/ios/RAI/NativeAppModel.swift:1661-1696`（`publishPlan`）、`:1168-1233`（`createWeeklyPlanPreview`）、`:1231`（`confirmPlanPreview`）；入口 `apps/ios/RAI/Skins/Technology/TechPlanView.swift:42,342-350`（统一页的 `manualPlanEntry`）→ `TechManualPlanView.swift:246,446`；服务端 `apps/api/src/server.ts:1658-1659,1767-1769,1793-1794`（410 `legacy_surface_retired`）。

**机制**：HEAD 服务端把 `/v1/mobile/goals`（GET/PUT）、`/v1/mobile/run-coach`（GET/POST）、`/v1/mobile/workout-plan/{preview,confirm,generate}` 一律 410，并新增 `/v1/mobile/training-plan/commands{/preview,/refresh}`（`server.ts:1636-1644`）。客户端**没有**任何 v2 命令消费者（全仓 grep `training-plan/commands` 在 `apps/ios` 零命中），写仍是 `publishPlan(route:)` 的 5 路复用 → `replayPlanPublication` 的路由表。`refreshRunCoach` 已被能力位挡住（`NativeAppModel.swift:490` `usesIntegratedPlanContract` 早退，HEAD 服务端恒定宣告 `coachLoopContractVersion: 1`，见 `server.ts:1052-1054`），但**手动课表这条路没有同等保护**：统一训练页把 `manualPlanEntry` 渲染在 `TechUnifiedTrainingView.body` 里（`TechPlanView.swift:42`），而 `TechManualPlanView` 只在 `isCoachLoopManaged`（有进行中/暂停的教练闭环计划）时隐藏编辑器；**无教练计划时**（正是该入口的文案场景）保存/预览/确认三个动作全部命中 410。

**影响**：用户点"保存计划"看到服务端原文"该旧接口已退役…请改用 …"（`friendlyMessage`→`RaiAPIClientError.server` 原文），且**没有任何客户端侧能力位或门禁**能提前判定"这台服务不支持手动写"。这是"退役接口是否真的没有消费者"的否定答案，属硬架构不变量（写路径唯一入口）被破坏。

**跨 lane 说明（待 Lead 合并）**：`deliverables/UNIFIED_TRAINING_PLAN_RELEASE_2026-10-20.md:101-105` 已把"统一页仍保留手动课表入口、仍会失败"列为**已知缺口**。本 lane 的增量是：① 给出精确可达链（统一页 → 手动课表 → 保存/预览/确认）与三个具体调用点；② 指出缺的是**结构约束**而非一行 UI：客户端没有任何"已退役路由"清单/门禁，也没有 v2 命令能力位，所以下次任何新写路径还会踩同一个坑。

**建议**：二选一并加门禁——(a) 客户端接入 `/v1/mobile/training-plan/commands`，`publishPlan` 路由表按握手能力选择；(b) 若本迭代不做，则按能力位隐藏 `manualPlanEntry` 与其子动作，并把 `legacy_surface_retired` 加入"终局错误"分类（见 I5）。门禁形态：在 `check-*` 里断言 `apps/ios/RAI` 中不出现已退役路径字面量，或断言"每个出站路径都有服务端路由存在"（跨仓对拍，现有 `check-direct-sync-contract-parity.py` 已有同型做法）。

### I2（P2，E2）5 个次级视图直接持 `RaiAPIClient` 与 `session.apiToken`，各自复制一套请求状态机

**位置**：`TechDayWorkoutsView.swift:8-56`（`@State items/total/message/busy` + `identity = feedbackScope + apiToken` + 手工分页去重 `:41-43`）、`TechTodayMetrics.swift:33-56`（自带 `failed`/`requestKey` 重试代次）、`TechSleepHistory.swift:41-55`（自带 `reloadCounter`）、`TechShareCardView.swift:110`、`TechWorkoutExportView.swift:68`。

**机制**：每处都 `RaiAPIClient()` 新建（`URLSessionConfiguration.ephemeral`，`APIClient.swift:211-222`）→ 不复用任何连接池、缓存、失效与 401 处理；请求身份用本视图自拼的字符串（`TechDayWorkoutsView:12` 含 token）；错误文案统一 `error.localizedDescription`，不经过 `PlanReadIssue`/`friendlyMessage` 的分类；分页正确性（`items.count` 作 offset、`seen` 去重）由视图自己保证。

**影响**：① 与 README（`apps/ios/README.md:58`）"新视图必须复用令牌/现有 AppModel，不能复制 API 状态机"直接冲突；② token 进入 SwiftUI 身份参与相等比较，任何后续 `print(identity)`/日志都会泄露；③ 这 5 条读没有"面板失败类别"（decoding vs offline vs 合同漂移），刷新全量时它们独立失败，用户的"数据状态"横幅无法反映；④ 无门禁：`check-fresh-skin.py` 只管视觉/触控，`grep` 全部 12 支门禁，**没有一条** 约束视图不得直接构造客户端。

**建议**：把这些读搬进 `NativeAppModel` 或新的只读 repository 方法（与 `refreshWorkouts`/`refreshBodyMetrics` 同形），视图只保留局部 UI 状态；随后在 `run-model-tests.sh` 的聚合链里加一条源码门禁：`Skins/` 下不得出现 `RaiAPIClient(`/`session.apiToken`。成本低（5 处 ≤ 120 行），收益是把"缓存/失效/错误分类/凭证"重新收进一层。

### I3（P2，E2）写侧状态所有权未收敛：`NativeAppModel` 仍是唯一发布编排者，收尾逻辑按调用点重复

**位置**：`NativeAppModel.swift:1661-1696`（`publishPlan`：编码、operationId、账本前置守卫、取消在飞读、`trainingPlanStore.invalidate()`）、`:1075-1119`（`persistGoals` 收尾）、`:1746-1797`（`resolvePlanPublication` 4 分支 set）、`:1825`（`recordPlanSyncReceipts`）；对比读侧 `TrainingPlanStore` 的 `private(set)`。

**机制**：读侧已经有单一所有者与单一校验入口（`PlanStatePolicy.validate`），写侧则是"每个动作各自认领一遍身份/版本/账本"。`acknowledgePlanWrite` 8 次、`cancelInFlightPlanRefresh` 9 次、`refreshPlanState` 20 次散落在 2.3k 行里；`publishPlan` 的 `durable` 分支（`:1672-1687`）自己实现"账目有未确认发布 ⇒ 409 拒绝新发布"的忙判据，与 `hasPendingPlanPublication`（`:1656`）是同一规则的第二个落点。上一轮 lane 4 的 P3（`decodingOnly` 未排除 `.validation`）已经通过抽出 `ReadPanelTally`（`:27-57`）修掉，说明"抽纯函数"这条路径可行，只是写侧还没走。

**影响**：`TrainingPlanStore` 的单一所有权只在"读/接受"成立；任何新增写动作必须复制那份多重判据，漏一项表现为"旧响应覆盖新状态"，且没有任何回归盯着这类判据。这不是今天的用户可见缺陷，而是**下一个写动作的必然成本**与回归面。

**建议**：把 `publishPlan` + 账本前置守卫 + `cancelInFlightPlanRefresh` + `accept*/acknowledge` 收尾合成 `TrainingPlanPublisher`（与 `TrainingPlanStore` 同主人，`NativeAppModel` 只做转发），并把 `route` 选择移进该类型——顺带解决 I1 的路由表重复。

### I4（P2，E2）同步状态机横跨 5 个文件 8.4k 行，其中 6.9k 行（生产代码 17.7%）不可回归编译

**位置**：`HealthKitSync.swift`（单类 3839 行 / 99 个 `func`，仅 3 个 `// MARK:`：`:388、:2626、:3422`）、`HealthKitExport.swift`（3026 行，`nonisolated enum` 全静态）、`AppDelegate.swift:33-180`、`HealthSyncBackgroundRecovery.swift`、`HealthSyncIntentJournal.swift`；证据：`run-model-tests.sh:84,121` 与 `run-health-sync-tests.sh:45` 三处注释自述"`HealthKitSync.swift` 不被任何回归脚本编译"。

**机制**：状态机本体（阶段迁移、恢复分支、预算裁定、observer 意图确认、BGTask 重排与回执）分散在 5 个文件，其中最大的两个（6 865 行、占 RAI 生产代码 18%）**不进编译**——它们被 `#if os(iOS)` + `import HealthKit` 锁死，回归只能覆盖被抽出来的纯函数（`SyncPhase`、`DirectSyncCursorPolicy`、`RouteSyncStateMachine`、`BackgroundSyncPolicy`）。`HealthKitSync` 内部的 99 个方法里，可数的"决策"点（`nextStep`、`mayAdvanceAnchor`、投递决策、对账时机）已外移，但**顺序**（谁先谁后、失败走哪支）仍在 3839 行里以 `if` 链表达，只有源码子串门禁盯"接线还在"。

**影响**：这是"状态机是否可证明"的诚实答案——**部分可证明**：纯判据可证（有回归），顺序与失败方向只能靠门禁子串 + 代码审查。一旦有人重排 `performSync` 的分支（历史上 2026-09-22 死锁、2026-10-11 `.waitJob` 缺失都是这一类），只有真机/线上能发现。`AppDelegate` 作为第二编排者进一步分散了"后台一轮到底发生了什么"的可读性。

**建议**：不改架构，只改可测面——把 `performSync`/`runBackgroundPass` 的分支选择抽成"`SyncAtomicUnit.nextStep` + 谓词表"形态的纯函数（已有 `SyncAtomicUnit`，把 `performSync` 的 switch 变成它的消费者），并让 `AppDelegate` 的投递决策返回一个可枚举的 `Envelope`（`BackgroundSyncPolicy` 已接近）。每抽一步，回归就能多证一条顺序。

### I5（P2，E2）退役码没有分类 —— 410 被当成"可重试的服务端错误"（**Lead 复核修正 2026-10-20**）

> 修正记录：原稿声称"410 重放命中后会撞 `plan_publication_pending` 把写路径锁死、只能靠『放弃』出口解锁"。**该结论已被 Lead 复核推翻并经本 lane 回源码确认成立**：写侧有两处泛化 4xx 清账分支，410 会当场作废账目。本节已收窄为"分类缺失 + 提示语义错"，原"写锁死"机制撤回。

**位置**：`TrainingPlanRepository.swift:67-84`（`PlanReadIssue.network`）；`APIClient.swift:154-170`（`RaiTrainingPlanContractError.classification`，只服务 v2 训练读）、`:575-582`（503+`Retry-After` 才升级 `.retryableServer`，其余 4xx 一律 `.server`）；写侧清账分支 `NativeAppModel.swift:1692-1695`、`:1730-1733`；前置守卫 `:1695-1698`；终局码白名单 `PlanMutationDisposition.swift:31-36`。

**机制**：410 走 `RaiAPIClientError.server(code:"legacy_surface_retired", status:410)`（`APIClient.swift:581`）。两侧处置不同：

- **读侧（真实缺口）**：`PlanReadIssue.network` 只识别 409→`revisionConflict`、404→`contractMismatch`，**410 落到 `serverUnavailable`** ⇒ 界面说"服务端暂时不可用，请稍后重试"，而事实是"这个接口已被产品退役，重试永远不会成功"。同一份"界面已消失的表面"在客户端有两种互斥解释（404 说"请升级"，410 说"稍后重试"），判据不一致。
- **写侧（不会锁死，原结论撤回）**：`publishPlan` 的 catch（`:1692-1695`）与 `resolvePendingPublication` 的 notFound→replay catch（`:1730-1733`）条件相同 —— "`(400..<500)` 且 `!code.hasPrefix("plan_operation_")`"即 `cache.savePublication(nil, scope:)` 清账。`legacy_surface_retired` 不以 `plan_operation_` 开头 ⇒ 410 当场清账，后续发布不会被 `plan_publication_pending`（`:1695-1698`）拦住。因此 `PlanMutationDisposition.terminalPlanPublicationErrorCodes` 缺该码**不构成缺陷**：泛化分支已覆盖，加进去是 no-op。

**唯一"保留账目"的分支（Lead 询问点，已核）**：`resolvePendingPublication` 首行的 `try await api.planOperation(...)`（`:1710`）抛出时，异常越过该函数的 catch 直接到 `resolvePlanPublication` 的 catch（`:1783-1792`，**不清账**）。但该端点 HEAD 仍存活（`apps/api/src/server.ts:1571`），且服务端不宣告 `planPublicationContractVersion` 时 `durable == false`、前置守卫根本不跑（`:1693-1698`）⇒ 该分支只对应"查询瞬时失败 ⇒ 保留待确认、稍后重试"的设计意图，与 410 无关，不恢复原结论。

**影响**：① 用户看到错误语义错（"可重试"实际永远不可重试），且混合版本（旧构建 + 新服务端）下这是唯一出口；② 无判据：12 支 `check-*.py` 与 35 个回归里没有一条覆盖"退役码分类"，属"改错了编译通过、肉眼也看不出来"那一类；③ 写侧的正确行为依赖一条**很宽的启发式**（任何非 `plan_operation_*` 的 4xx 都清账），下次有人为保住 revision 冲突而把它收窄成白名单时，本已正确的退役码处置会变成真正的账目残留 —— 本次未触发，但没有判据盯着这条边界。

**建议**：只做读侧分类（`PlanReadIssue.network` 增 `upgradeRequired`；`RaiTrainingPlanContractError.classification` 收 `legacy_surface_retired`→`.contractUnsupported`）并补一条纯函数回归；`PlanMutationDisposition` 白名单可加该码作为**文档性冗余**（不改行为），并在 `:1694` / `:1732` 的注释里写明"退役码由泛化 4xx 分支覆盖"，防止后人为了"看起来完整"去收窄条件。

### I6（P2，E2）能力协商是"无注册表的 14 个可选 Int"，三处手抄、只有一对有 parity 门禁

**位置**：服务端 `server.ts:1042-1080`；TS 契约 `packages/api-contracts`；Swift 镜像 `APIModels.swift:8-31`；唯一 parity 门禁 `apps/ios/tests/check-direct-sync-contract-parity.py`（只覆盖 direct-sync 相关键）。

**机制**：能力位是逐项 Optional 版本整数（`planSnapshotContractVersion`、`coachLoopContractVersion`、`planPublicationContractVersion`、`planReceiptContractVersion`、`factsAnalysisContractVersion(-View)`、`syncCoverageVersion`、`healthKitRecordSyncVersion`、`directSyncBounds` …），服务端**条件性省略**（`server.ts:1052`：数据集受教练闭环管理时不宣告 `planSnapshotContractVersion`，避免"宣告一条自己会 409 的路由"）。客户端按 `if let version = …`/`!= nil` 各自解释，没有集中"这台服务支持什么"的类型。新增一个能力位要同时改 3 处，漂移的失效方向是静默（少读一次新契约 = 走旧路径）。

**影响**：可演进性的真实成本不在"版本号方案"，而在"没有单一能力清单"。当前最贵的一次正是 I1：服务端新增了 v2 命令端点却**没有对应能力位**，于是客户端连"这台服务能不能写手动计划"都无法判断。

**建议**：短期不动 wire 形状（提案 §4.2 已论证过"不做无收益重命名"）：在 Swift 侧引入一个 `ServerCapabilities` 值类型，由 `RaiHandshake` 一次性派生（`supportsUnifiedPlanRead` / `supportsPlanCommands` / `supportsCoachLoop` / …），把散在 6 处的 `!= nil` 判断收成一处；再让 `check-direct-sync-contract-parity.py` 的键集对拍扩展到全部能力位（服务端 handshake 键集 ↔ Swift `RaiHandshake` 键集），这条门禁已有现成结构。

### P3 合并表（E2，除注明外）

| ID | 位置 | 机制/影响 |
| --- | --- | --- |
| P3-1 | `APIModels.swift`（2201 行 / 159 个类型） | DTO 与展示模型、缓存 envelope、wire 类型同处一文件；`windowStart/End` 已补（`:1286-1287、:1497-1498`）说明演进可行，但新增字段的检索/评审成本高 |
| P3-2 | `run-model-tests.sh:32,47,54,61,73,92`（6 组 swiftc）与 `:116-143`（7 支 python 门禁） | 回归编译表是手写 swiftc 参数，新增源文件必须手工登记；漏登记表现为"该文件永远不被回归"（已有注释警告，无门禁） |
| P3-3 | `Podfile:11,14-40` + 3 个 AMap 文件不进 `typecheck-ios.sh` | 依赖边界清晰（唯一 pod、`Pods/` 不入库、post_install 幂等补 umbrella header），代价是坐标/SDK 相关 3 文件只在 Simulator 手工对拍通道里被编译 |
| P3-4 | `HealthKitSync.swift:3424-3431` | 原始健康 ZIP/multipart 落 App Support（`completeUntilFirstUserAuthentication`）⇒ 首次解锁后锁屏期间仍可读；与"锁屏不读 HealthKit"不矛盾，但属需要写明的残余暴露面 |
| P3-5 | `TechTheme.swift:572-594` 与 `TechEnumPresentation.swift:54-62` | 两个"同步失败"文案源（设备阶段 vs 服务端 sync.status）共存，语义区分正确但命名不区分，易被下一处误用；已有门禁只钉前者与 `SyncPhase` 的配平 |
| P3-6 | `NativeAppModel.swift:1799-1824` | "放弃未确认发布"是二级破坏性动作，God-object 里的逃生阀，无 UI 直达路径的说明（依赖用户找到它） |
| P3-7 | `apps/ios/tests/VisualAcceptance.swift` | 唯一不被任何 `run-*.sh` 编译的回归（属 Simulator 手工验收，预期内），但"35 个回归文件只有 34 个有执行者"应写进 runbook 的口径 |
| P3-8 | `check-export-determinism-live.py`、`check-background-mutations.py` | 需模拟器/会改坏源码，均不在聚合链；它们守的恰是"导出确定性"与"门禁有效性"两类最高价值判据，当前只有发布前手工跑 |
| P3-9 | `CameraInfo` 类旧注释与新实现并存（如 `HealthKitExport.swift:1358-1359` vs `:1424-1428` 的相反注释） | 上一轮 I4 已报，本轮核对仍成立；属文档缺陷，失效方向不对称（一句话可导致重开已修缺陷），建议优先复制结论而非重报 |

---

## 4 量化指标（命令内联，均可复跑）

| 指标 | 值 | 命令 |
| --- | --- | --- |
| Swift 文件/行数 | 101 / 55 123 | `find apps/ios -name '*.swift' \| xargs wc -l` |
| 生产 / 测试行数 | 38 684 / 16 439（测试占 29.8%） | `wc -l apps/ios/RAI/{,Skins/Technology/}*.swift`、`wc -l apps/ios/tests/*.swift` |
| 最大 5 文件 | `HealthKitSync` 3839、`HealthKitExport` 3026、`TechViews` 2526、`NativeAppModel` 2309、`SyncTaskStore` 2284 | `find apps/ios/RAI -name '*.swift' \| xargs wc -l \| sort -rn` |
| 单类函数数 | `HealthKitSync` 99 个 `func` / 3 个 `// MARK:` | `grep -c 'func ' apps/ios/RAI/HealthKitSync.swift` |
| 视图→网络边 | 5 处直接 `RaiAPIClient()`（5 个文件） | `grep -rn 'RaiAPIClient()' apps/ios/RAI/Skins/Technology` |
| 视图→AppModel 边 | 14 个视图共 62 处 `await native.` | `grep -c 'await native\.' apps/ios/RAI/Skins/Technology/*.swift` |
| 本地库表 | `sync.sqlite` 14 表、`cache.sqlite` 5 表 | `grep -n 'CREATE TABLE' apps/ios/RAI/{SyncTaskStore,CacheStore}.swift` |
| 结构门禁 | 12 支 `check-*.py` / 7 401 行；11 支由自动脚本引用 | `wc -l apps/ios/tests/check-*.py`；逐支 grep 见 §2.6 |
| 回归文件执行者 | 35 个中 34 个被 `run-*.sh` 引用 | `for f in apps/ios/tests/*.swift; do grep -rq "$(basename $f)" apps/ios/tests/run-*.sh \|\| echo $f; done` |
| 编译不到的回归源 | `HealthKitSync`+`HealthKitExport` 6 865 行（生产代码 17.7%） | `grep -rn HealthKit apps/ios/tests/run-*.sh`（只命中注释） |
| 工程文件维护面 | `PBXFileSystemSynchronizedRootGroup` 1 处、例外 1 项（`Info.plist`） | `grep -n 'FileSystemSynchronized' apps/ios/RAI.xcodeproj/project.pbxproj` |
| 依赖 | CocoaPods 1 个 pod（`AMap3DMap`），`pod install` 后 `Pods/` 不入库 | `cat apps/ios/Podfile`；`grep -c '^  - ' apps/ios/Podfile.lock`=3 |

---

## 5 建议与优先级

**第一批（发布前，2–3 小时）**
1. **修 I1 的可达性**：按握手能力隐藏 `manualPlanEntry` 及其三个子动作（`saveGoals`/`createWeeklyPlanPreview`/`confirmPlanPreview`），或接 v2 命令端点。风险低、改动局部，不改变任何同步语义。
2. **补 I5 分类（仅读侧）**：`PlanReadIssue.network` 增 `upgradeRequired`，`RaiTrainingPlanContractError.classification` 收 `legacy_surface_retired`；终局码白名单只作文档性冗余（写侧已由泛化 4xx 分支清账，Lead 复核确认无锁死）。纯函数改动，回归可加在 `ModelRegression`/`TrainingPlanV2Regression`。
3. **加一条结构门禁**："`apps/ios/RAI` 不得出现 `retiredLegacyRoutes` 中的路径"，与服务端 `server.ts:427-432` 的集合对拍（同型做法见 `check-direct-sync-contract-parity.py`）。这条比修 UI 更重要：它让 I1 不会在下一个写路径复发。

**第二批（一周内）**
4. **I2**：5 个视图的直接取数搬回 `NativeAppModel`/repository + `Skins/` 禁止 `RaiAPIClient(`/`session.apiToken` 的门禁。顺带把 token 从 `TechDayWorkoutsView` 的视图身份里拿掉。
5. **I6**：Swift 侧引入 `ServerCapabilities` 值类型，能力判断从 6 处散落收到一处；parity 门禁扩展到全部能力位。
6. **I3**：抽 `TrainingPlanPublisher`（含路由选择），`NativeAppModel` 变转发门面；这是提案 §9.4 PR3 的继续，验收标准是"`acknowledgePlanWrite`/`cancelInFlightPlanRefresh` 的调用点从 8/9 降到 1/1"，而不是"文件变短"。

**第三批（条件性，需先有真机证据）**
7. **I4**：按"分支选择纯函数化"推进，一次只抽一条路径（优先 `performSync` 的 `.waitJob/.inspect/.upload` 选择），抽完立刻补回归。**不**建议为了可测性把 `HealthKitSync` 拆文件——拆分不改变可测面，抽纯函数才改变。
8. **P3-8**：把 `check-background-mutations.py` 的 `[P1]` 组纳入发布前手工清单（它守"门禁有效性"，无自动化替代品）。

**明确不建议**：改 actor 模型、重写 `HealthKitExport`、把 DTO 拆成三套 Codable（提案 §8.1 已论证）、恢复 Web 回退路径（D17 已退役）。

---

## 6 未验证边界（不得当作已通过）

| 项 | 原因 | 本 lane 的结论强度 |
| --- | --- | --- |
| `npm run test:ios` 实跑 | BRIEF §3 明确由 Lead 统一跑；本轮未执行任何 iOS 测试 | 所有"门禁存在/被引用"的判断是**静态** E1；"门禁现在是否绿"未验证 |
| 类型检查与回归的真实通过率 | 同上 | §2.6 的"有执行者"成立（结构上），"执行结果是绿"未验证 |
| 门禁有效性（能否被绕过） | `check-background-mutations.py` 会改坏源码，与只读约束冲突，未运行 | 所有 python 门禁的**强度**为未验证；只有 `*Regression.swift` 的纯逻辑断言属"存在即被编译" |
| HealthKit 真机行为：observer 投递、BGProcessingTask 调度、background URLSession 跨进程续传、锁屏错误、Watch 样本迟到 | 无真机/Simulator | I4 的"顺序不可证"部分是 E2 推断；§2.4 的机制描述来自文档+代码，运行时行为未验证 |
| WorkoutKit 排期读回时延、`scheduledWorkouts` 强匹配、配对手表可见性 | 需真机 + Apple Watch | 未验证（本 lane 未新增判断） |
| `run-visual-tests.sh` / `run-coordinate-sdk-check.sh` | 需 booted Simulator / `var/rai.sqlite`，本 lane 禁碰 | 未运行 |
| 服务端 410 矩阵在真实部署实例上的行为 | 本 lane 只读服务端源码与发布记录，未启动服务、未发请求 | I1 的"可达"是静态推断（E2）：链路、路由、UI 入口都在源码里逐行确认，但没有一次实跑 410 响应 |
| 客户端与服务端在同一台 HEAD 上的实际端到端交互 | 未启动 API、未连模拟器 | I1/I5/I6 的**用户可见**结论依赖"新服务端 + 新客户端"组合；旧服务端组合下 I1 不可达（能力位会走旧路径） |

**跨 lane 待 Lead 合并的事实**：① `retiredLegacyRoutes` 的 410 集合与 iOS 消费者共存（I1，与 API/契约 lane 重叠）；② `deliverables/UNIFIED_TRAINING_PLAN_RELEASE_2026-10-20.md:101-105` 已把手动课表 410 列为已知缺口，本 lane 的增量是"缺客户端能力位与结构门禁"；③ `HealthKitSync`/`HealthKitExport` 不可回归编译（I4）与同步 lane 的"状态机可证明性"直接相关；④ `PlanMutationDisposition` 终局码白名单与 `mobile-goals.ts` 的码集对拍（I5）落在服务端码集 lane —— 但客户端写侧另有泛化 4xx 清账分支（`NativeAppModel.swift:1692-1695`、`:1730-1733`），白名单缺 `legacy_surface_retired` 是 no-op，**不要**据此判成锁死。
