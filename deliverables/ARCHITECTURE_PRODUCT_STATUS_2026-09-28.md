# RAI 架构与产品现状（开发文档）

> **文档性质**：as-is 现状基线，供后续开发与评审引用。**不是**改造计划。  
> **日期**：2026-09-28 ｜ **基线**：`main @ aec32b0` + 工作区未提交改动（见 §0.4）  
> **方法**：4 路只读侦察（iOS / 中枢层 / 数据层 / 部署）+ 裁决层对关键断言亲验  
> **约束**：本次未修改任何代码

---

## 0. 结论先行

### 0.1 三条最重要的判断

**① iOS 的定位是「薄客户端 + 强同步代理」，而不是「本地优先 App」。**  
它自己只算三件与评分无关的事：坐标转换（WGS-84→GCJ-02）、WorkoutKit 计划映射、打包与哈希。  
评分、特征、聚合、预测**全部在服务端**（`apps/ios/README.md:16,98`）。  
它的「一等公民」地位体现在**同步能力**（后台三机制 + 跨会话续接）与**写操作权限**（7 项）上，  
而不是在算法上——手机端零复刻、零评分写入。

**② 中枢层的真实形态是「本地优先的 Node 单机服务 + Nginx 边缘」，不是「云平台」。**  
腾讯云 2C2G 单机，Node 只监听 `127.0.0.1:8787`，Nginx 承担 TLS + 静态托管 + `/v1` 反代，  
Bearer 校验在**后端**而非 Nginx（`deploy/README-UBUNTU.md:3,8`；`deploy/nginx-rai.conf:7-9,66-76`）。  
能力上限被两条硬约束钉住：单机资源封顶（`MemoryMax=1400M` / `CPUQuota=150%`，`deploy/rai-api.service:33-37`）  
与「迁移必须停服」（`apps/api/src/server.ts:507-509`）。

**③ 最大缺口不在算法，而在「跨端体验不统一」与「用户无法回话」。**  
但需**纠正上一轮判断**：`adherence` 的观测层**已实现且在手机上可见**——  
`TechPlanView.swift:57-59` 渲染 `recentPlanExecution`，面板文案见 `TechPlanPreviewSheet.swift:64-85`。  
**刻意不做的**是「漏课 / 依从性判断」：`plan-execution.ts:37` 的 `status` 闭集只有  
`observed | pending | unknown`，源码注释明写 *"Same-day plans are deliberately not inferred until  
receipt-level reconciliation exists"*（`plan-execution.ts:19`）。这是一个**产品价值观选择**（不制造漏课羞耻感），  
不是遗漏。真正的缺口是：**iOS 原生不能录入主观反馈**（§3.6）。

### 0.2 证据等级说明

| 标记       | 含义                        |
| -------- | ------------------------- |
| ✅**亲验**  | 裁决层本轮独立复核过（读源码/实跑）        |
| 🔍**侦察** | 子代理只读侦察所得，带 `文件:行号`，未逐条复跑 |
| ⚠️**漂移** | 代码事实与仓库文档不一致，以代码为准        |

### 0.3 ⚠️ 本文档成立的前提：仓库文档已多处过期

| # | 文档说法                                                                                    | 代码事实                                                                | 证据                                                                                                                   |
| - | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1 | `ARCHITECTURE.md` 称 iOS 是「WKWebView + HealthKit 只读增量同步」的调试壳；移动端技术栈写 React Native / Expo | 生产路径是 **SwiftUI 原生**（冰蓝科技唯一视觉，2026-09-18 起）；WKWebView 仅存在于非 iOS 分支  | `docs/ARCHITECTURE.md:3,29,260,346` vs `apps/ios/RAI/RootView.swift:46-70`、`apps/ios/README.md:5-10`                 |
| 2 | schema 写 v1–v18                                                                         | 实际 **v1–v22**（v11 为历史占位）                                                 | `docs/DATABASE_DESIGN.md:3`、`README.md:236` vs `packages/storage-sqlite/src/database.ts:89,1397`；冻结校验和表 `:1669-1692` |
| 3 | `apps/ios/README.md` 称 `recentPlanExecution`「尚无展示位，该断言因此是红的」                            | **已有展示位且门禁配平**：`TechPlanView.swift:57-59` 渲染；门禁把它列在 `field_anchors` | `apps/ios/README.md:81` vs `apps/ios/tests/run-tech-presentation-tests.sh:187` ✅**亲验**                               |
| 4 | 同文档称 UI 门禁有「3 个元数据例外」                                                                   | 实际 **4 个**（2026-09-19 起含 `freshness`）                               | `apps/ios/tests/run-tech-presentation-tests.sh:200-208` ✅**亲验**                                                      |
| 5 | 同文档称 HealthKit 授权 fail-closed 在 `HealthKitSync.swift:293`                               | 该行现为「不丢弃意图位」注释；fail-closed 实际在 `:1003-1026`                         | `apps/ios/README.md:86` vs `apps/ios/RAI/HealthKitSync.swift:293,1003-1026`                                          |

> **处置建议**：这 5 条都是「改了代码没回改文档」，属文档债。**开工前先按本文档对齐**，  
> 否则新人（或半年后的自己）会按 `ARCHITECTURE.md` 去找一个不存在的 React Native 工程。
>
> ✅ **状态（2026-09-28）：本表 5 条 + §6.2 清单 7 条已全部修完，另有 6 处同类陈旧表述在反向扫描中被一并修掉。**
> 结清记录、实跑证据、刻意未改项与回滚命令见 **§6.2.1**。上表保留为「改动前后对照」的历史记录 —— 下文若引用这 5 条，请按修好的版本来读。

### 0.4 本次基线（含未提交改动）

工作区有 11 个文件、+180/−22 行的**未提交改动**，性质是收尾重构，不影响架构结论：

| 文件                                                                    | 改动性质                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/data.ts`                                                | 消除 `executableMobilePlan` 的重复计算（`mobileTodayWithExecutablePlan` 抽出，同一次结果复用）；硬编码 `30` → `DEFAULT_WEEKLY_DISTANCE_KM` |
| `apps/api/src/mobile-read.ts`                                         | 同上，替换魔法数字                                                                                                           |
| `apps/ios/RAI/{Keychain,ServerSession,TechSetupView,TechViews}.swift` | 服务配置与展示微调                                                                                                           |
| `apps/ios/tests/*` + `run-tech-presentation-tests.sh`                 | 新增「预览 sheet 不得隐式落库」守卫（+44 行）                                                                                        |

> 🔴 **读本文档时的注意**：文中行号取自**工作区版本**。若行号对不上，先 `git stash` 或按符号名检索。

> 📌 §6.2.1 结清后，工作区在此基础上**另增 8 个文档文件改动**（`+38 −34`，纯文档 + 一处 nginx 注释）；
> 上表列出的在途**代码**改动一项未动，仍与上表一致。

---

## 1. iOS 端：一等公民的定位与职责

### 1.1 定位声明

| 维度      | 结论                                                                                                                                                                       | 证据                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 是什么     | **跑者的每日主入口 + 健康数据上行代理 + 手表处方下发器**                                                                                                                                        | §1.2–1.7                                                 |
| 不是什么    | 不跑 Node.js / 评分核心 / 服务端 SQLite；**不向 Apple 健康写入**                                                                                                                         | `apps/ios/README.md:16,98`；`WorkoutKitBridge.swift:8-11` |
| 自算什么    | 坐标转换（`CoordinateConversion.swift`）、WorkoutKit 映射（`WorkoutPlanMapper.swift`）、打包/哈希（`StoredZip.swift`、`HealthKitExport.swift:198-200`）、格式化（`NativeFormat.swift`）——**均非评分** | 🔍侦察                                                     |
| 在线/离线   | API 优先、离线展示缓存；**所有写操作要求联网**                                                                                                                                              | `apps/ios/README.md:127-129`                             |
| 本地数据库   | 两个：缓存库 `cache.sqlite`（`CacheStore.swift:16-50`）、同步日志库（`SyncTaskStore.swift:71`）——**都不是业务库**                                                                              | 🔍侦察                                                     |
| 客户端超时预算 | 必须在服务端 50s 预算之上：`generateTimeoutInterval=60`、resource 75s                                                                                                                | `APIClient.swift:88-94,100-112`                          |

### 1.2 五入口信息架构

`NativeTab`（`NativeViews.swift:13-39`）→ `NativeRootView` 分流（`:76-91`）：

| Tab           | 标题 | View                                                  | 承担内容                                                     |
| ------------- | -- | ----------------------------------------------------- | -------------------------------------------------------- |
| `.home`       | 今日 | `TechTodayView`（`TechViews.swift:7`）                  | Hero（今日距离/时长/配速/kcal/周目标环）、恢复、判定、本周结构、今日推荐、跑力卡、今日指标、比赛摘要 |
| `.workouts`   | 训练 | `TechWorkoutsView`（`:1088`）                           | 6 类课型筛选、本月 Hero、分页列表 → 详情                                |
| `.statistics` | 统计 | `TechAnalysisView(initialMode:"statistics")`（`:1593`） | 三月里程柱、心率区间分布                                             |
| `.trends`     | 趋势 | `TechAnalysisView(initialMode:"trends")`              | 12 周柱、4 周增幅、洞察、个人纪录、跑步能力入口                               |
| `.settings`   | 设置 | `TechNativeSettingsView`（`:1827`）                     | 服务连接、Apple 健康、地图底图、本地缓存、关于、同步动作/状态                       |

二级页面（NavigationLink 进入）：训练计划 `TechPlanView`、本周活动 `TechWeekOverviewView`、  
身体指标 `TechBodyMetricsView`、跑步能力 `TechAbilityDetailView`、逐日明细 `TechPlanDaySheet`。

### 1.3 写操作权限清单（7 项，穷举）

iOS 端**全部** HTTP 调用点集中在 `APIClient.swift:156,165,170,186,243,251` + `HealthKitSync.swift:1495,1530,1554,1584`，  
除此之外无写路径（🔍侦察，可复核）。

| # | 写操作          | 端点                                                                                                  | Swift 调用点                       | UI 触发点                                                  |
| - | ------------ | --------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| 1 | 周目标编辑        | `PUT /v1/mobile/goals`                                                                              | `NativeAppModel.swift:537-541`  | `TechPlanView.swift:51,597`                             |
| 2 | 比赛目标设置/编辑/清除 | `PUT /v1/mobile/goals`                                                                              | 同上                              | `TechRaceGoalEditor.swift:112,119,139`                  |
| 3 | 锁课 / 重锁      | `POST /v1/mobile/lock`                                                                              | `NativeAppModel.swift:582-586`  | `TechLockSheet.swift:48-55`                             |
| 4 | 周计划预览（不落库）   | `POST /v1/mobile/workout-plan/preview`                                                              | `NativeAppModel.swift:683-687`  | `TechPlanView.swift:316-317`                            |
| 5 | 周计划确认（落库）    | `POST /v1/mobile/workout-plan/confirm`                                                              | `NativeAppModel.swift:720`      | `TechPlanPreviewSheet.swift:53`                         |
| 6 | 手表下发回执       | `POST /v1/mobile/workout-plan/synced`                                                               | `NativeAppModel.swift:813-822`  | `TechPlanView.swift:341,369`                            |
| 7 | 健康同步四连       | `POST /v1/imports/uploads` → `/inspect` → `POST /v1/import-jobs` → `DELETE /v1/import-sources/{id}` | `HealthKitSync.swift:1493-1584` | 设置页 `TechViews.swift:2030`、`TechSyncStatus.swift:15,94` |

**并发保护**：全部写路径用 requestID/epoch + `expectedRevision` 乐观锁；  
`409 mobile_goals_revision_conflict` / `plan_preview_stale` 会**重读而非静默覆盖**  
（`NativeAppModel.swift:554-558,695-700,732-736`）。

### 1.4 明确的「不做」（零命中证明）

| 不能做的事                                         | 证据（零命中）                                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 **训练级 override 写入**（RPE / 备注 / 改课型 / 排除记录） | `override` 全部命中均为**只读解码或只读渲染**：`APIModels.swift:887,936-942`、`TechViews.swift:1283,1575-1590`。无任何 API 客户端方法发往训练 override                      |
| 🔴 **用户级数据导出 / 分享**                           | `ShareLink` / `UIActivityViewController` / `UIDocumentPicker` / `fileExporter` **零命中**；唯一 `.gpx` 是导出包内部文件（`HealthKitExport.swift:978`，设备→服务端） |
| **编辑「今天」那一行计划**                               | 编辑器只允许未来日期：`TechPlanView.swift:444-457`（`editablePlanIndexes` 仅 `> today`）                                                                    |
| 向 Apple 健康写入                                  | `apps/ios/README.md:98`；`WorkoutKitBridge.swift:8-11`                                                                                         |
| 本地跑评分 / 聚合                                    | DTO 全为 `Codable` 解码（`APIModels.swift` 全文），无评分实现                                                                                               |

> 复现命令（应只返回上表的只读命中）：  
> `rg -n 'override|rpe' apps/ios/RAI` ／ `rg -n 'ShareLink|UIActivityViewController|fileExporter' apps/ios/RAI`（后者应为空）

### 1.5 HealthKit 同步链路

| 阶段     | 落点                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| 授权状态判定 | `HealthKitExport.readAuthorizationState()`，调用 `HealthKitSync.swift:1003`；分支 `:1005-1026`                   |
| 读取类别   | 跑步 workout、sleepAnalysis、HRV SDNN、restingHeartRate（`HealthKitSync.swift:370-375`）                          |
| 导出 ZIP | `HealthKitExport.exportArchive`（`HealthKitExport.swift:273-430`）                                           |
| 上传     | `HealthKitSync.upload`（`:1480-1524`），带 `X-RAI-Sync-Batch` 幂等键（`:1501`）                                     |
| 服务端导入  | `inspect` `:1526` → `startImport` `:1539` → `submitImport` `:1550` → `waitForJob` `:1607`（轮询 `:1659-1661`） |
| 水位提交   | `markSuccess` `:1276-1350` + `SyncStateCommitPlan.swift`                                                   |
| 刷新页面   | `dataUpdatedGeneration`（`HealthKitSync.swift:18`）→ `NativeViews.swift:62-67`                               |

### 1.6 后台三机制（这是 iOS「一等公民」的核心证据）

| 机制                                  | 标识                                   | 入口                                                                                              |
| ----------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| HealthKit observer（启动期注册，**早于 UI**） | —                                    | `AppDelegate.swift:33-65`，由 `didFinishLaunching` 驱动 `:229-237`；实现 `HealthKitSync.swift:364-389` |
| `BGProcessingTask`（承载导出+导入提交）       | `app.rai.running.health-sync`        | 常量 `BackgroundSyncPolicy.swift:16`；注册 `AppDelegate.swift:120-142`；运行 `:174-211`                 |
| background `URLSession`（承载上传字节）     | `app.rai.running.health-sync.upload` | 常量 `BackgroundSyncPolicy.swift:24`；回调 `AppDelegate.swift:256-276`                               |

**两条不变量（违反即数据错乱）**：

1. `upload → inspect → startImport` 是**一个原子单元**，必须同一次唤醒内走完；只有「拿 `jobId` 等终态」可跨会话（`SyncPhase.swift:113-171`）。
2. 判据按 `jobId` / `sourceId` 字段优先，**不信 `phase` 文字**（`SyncPhase.swift:136-155`）。
3. ⚠️ 观察者必须挂在 `didFinishLaunching`，**不能挂 `onAppear`**——后台唤醒时视图不会出现（`apps/ios/README.md:116-117`）。

### 1.7 WorkoutKit 下发到 Apple Watch

入口：`TechPlanView.syncPlanToWatch`（`:340-373`）→ `WorkoutKitBridge.sync`（`:180-317`）。

**关键设计约束**：`WorkoutScheduler.schedule(_:at:)` 是 `async` 但**非 throwing**，  
静默失败与成功同形 ⇒ **每次同步必须回读 `scheduledWorkouts` 比对**（`WorkoutKitBridge.swift:13-15,276-303`）。

失败模式被显式建模（`SyncOutcome`，`:20-130`）：

| 字段                                       | 含义                 | 为什么要分开                                          |
| ---------------------------------------- | ------------------ | ----------------------------------------------- |
| `deviceUnsupported`                      | 模拟器 / 无配对手表        | **与「未授权」分开**：该设备永远不会变可调度，提示授权会把用户引到死路（`:26-30`） |
| `authorizationState`                     | 授权态扁平化为字符串         | 拒绝时要说清「被什么挡住」（`:35,79-91`）                      |
| `timeZoneFallback`                       | 课表没带时区，退化为手机时区     | 影响「已过期」判定（`:39,200,311`）                        |
| `offered` / `expired` / `alreadyTrained` | 已过去/已完成的日子**不算缺口** | 否则计划生成后每天都像同步失败（`:44-53,212-220`）               |
| `verified`                               | 回读校验结果             | 见上「非 throwing」                                  |

其他：先 `removeAllWorkouts()` 再重排（陈旧处方比没有更糟，`:269`）；空集时撤回并回读（`:223-241`）；  
`supportsGoal`/`supportsAlert` 预检，不支持的目标显式丢弃并计数（`:330,376,402`）；  
回执按**日期**匹配而非内容（`PlanReceiptMatcher.swift`）。

### 1.8 离线与缓存

`CacheStore`（`CacheStore.swift`）：SQLite `cache.sqlite`，表 `cache_entries(scope, cache_key, cached_at, payload)`  
（`:31-45`）；文件保护 `completeUntilFirstUserAuthentication`（`:46-49`）；  
命名空间由 `baseURL+serverId+athleteId+datasetEpoch` 派生 SHA-256（`:139-148`）；  
淘汰策略 **240 条 / 100 MB**，按 `cached_at` 最旧先删（`:115-137`）。

- **可离线看**：today / statistics / trends / goals / workout-plan / predictions / dashboard / training-zones / training-statistics / workouts（`NativeAppModel.swift:865-907`）。**无硬 TTL**，陈旧由 `TechFreshnessBanner` 显式告知（`:899`、`TechViews.swift:1008-1086`）。
- **离线禁止**（`guard !isOffline`）：保存目标 `:519`、锁课 `:564`、确认计划 `:707`、手表下发 `:1028`。
- **唯一离线判据**：`isOffline = !workoutsSucceeded`（`NativeAppModel.swift:263`）。

### 1.9 iOS 边界情况清单

| 场景                | 现状                                                       | 需要关注的点                                                                                           |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 模拟器无 HealthKit 能力 | 授权检查按设计 **fail closed**（`HealthKitSync.swift:1003-1026`） | 模拟器上「重试同步」必然失败，是**预期行为**，不是 bug（`apps/ios/README.md:86`）                                         |
| 无配对手表             | `deviceUnsupported`，不进授权流程                               | 不能提示「去授权」（死路）                                                                                    |
| 一批上传跨入后台          | 原子单元在续期额度内跑完；「等服务端终态」立即收手                                | **不允许**触碰已在系统手上的传输（连 `inspect` 都不做，`apps/ios/README.md:105-108`）                                 |
| 失败批次文件            | 刻意不删，按 `payloadHash` 命名                                  | 它就是「下次接着传」的记录；删了会丢恢复点（`:111-113`）                                                                |
| 用户想重新全量导出         | 唯一合法入口是显式点「重新导入全部」                                       | 重新导出会换 `ExportDate` → 新 `payloadHash` → 新 batchId，服务端幂等键失效（`BackgroundSyncPolicy.swift:118-122`） |
| 缓存命名空间            | 由 datasetEpoch 参与派生                                      | 服务端切 epoch（回滚旧库）会让本地缓存**整体失效**——这是设计意图，不是 bug                                                    |



---

## 2. 云服务器中枢层能力

### 2.1 拓扑与进程角色

```
iPhone / 浏览器
   → 云 Nginx（TLS + 静态 dist + /v1 反代 + 限速）
      → Node API 127.0.0.1:8787（HTTP / 鉴权 / 持久化队列 / 幂等 / 发布回退）
         → 串行导入 + 重算（单写者）
         → 可选 Rust 子进程（仅解码与写候选库）
         → /var/lib/rai（主库 + 控制库 + 运行时库 + 备份 + 模型 artifact）
```

| 结论 | 证据 |
|---|---|
| 2C2G 腾讯云单机；域名 `tpandmr.xyz` | `deploy/README-UBUNTU.md:3`；`deploy/README-CLOUD-2C2G.md:6-15` |
| Node 只监听本机；Nginx 提供 HTTPS + 静态 Web | `deploy/README-UBUNTU.md:8` |
| **N100 迁移方案已作废、从未执行** | `deliverables/N100_MIGRATION_PLAN_2026-09-19.md:3-15`（状态字段明写「已作废」） |
| Rust 只做解码+写候选库，不做发布/幂等/鉴权 | `docs/RUST_DATA_ENGINE.md:8-17` |

### 2.2 中枢层能力矩阵

| 能力面 | 载体 | 关键机制 | 边界 |
|---|---|---|---|
| **模型** | `packages/scoring`（CA/TA/Decay/GV）经 `packages/application/services/recompute-pipeline.ts` | Model Run 版本化 + active 指针 + **shadow gate `rai-shadow-gate-v1`** | 中枢层**不直连**算法包（唯一例外 `@rai/training-load`，`mobile-read.ts:23`） |
| **存储** | 主库 `var/rai.sqlite` + 控制库 `var/rai-control.sqlite` + 运行时库 `var/runtime.sqlite` | repository 唯一入口；publication lock；原子切换 | 两库**无跨库外键**（控制库的锁课可能指向主库不存在的记录） |
| **数据分析** | `packages/features` / `training-load` / `training-zones` / `physiology` | 纯函数 + 版本化配置 | 特征工程不做 I/O，查询由 repository 前置完成 |
| **adherence** | `apps/api/src/plan-execution.ts` | **观测层**：07 天滚动「计划 vs 已导入」 | **刻意不做** missed/依从性分级（§2.7） |
| **预测** | `packages/physiology` + `packages/prediction-inference`（CatBoost ONNX） | 公式链路 + walk-forward 残差候选；离线门槛 `decision="accepted"` 才激活 | 预测模型激活阈值与评分模型门禁是**两套** |
| **跨端一致性** | `packages/api-contracts` 单一契约源 | OpenAPI **手写**（`schemas.ts:634-883`）+ 测试对齐；iOS 侧另有字段覆盖门禁 | 契约改字段而无人展示 ⇒ iOS 门禁自己变红 |

### 2.3 路由全景（按功能分组）

| 组 | 端点 | 挂载点 |
|---|---|---|
| 健康/元信息 | `GET /v1/health` `/handshake` `/openapi.json` `/performance` | `server.ts:817,830,837,838` |
| 概览/审计 | `GET /v1/dashboard` `/data-summary` `/data-audit` `/diagnostics` `/runtime-status` | `:843-852` |
| 训练与覆盖 | `GET /v1/workouts` `/workouts/:id` `/workouts/:id/series`；`PATCH /workouts/:id/override` | `:884,905,926,948` |
| 趋势/恢复/统计/分区 | `GET /v1/trends` `/recovery-trends` `/training-statistics/{overview,history,load}` `/training-zones/{current,history}`；`PATCH /training-zones/profile` | `:985,1180,989,993,1002,1010,1253,1261` |
| 预测与模型 | `GET /v1/predictions` `/prediction-models[/:id]` `/model-runs[/compare]`；`POST /prediction-models/train|:id/cancel|:id/activate`、`POST /model-runs[/:id/activate]` | `:1294-1500` |
| 任务与命令 | `GET /v1/jobs[/:id]`、`POST /jobs/:id/cancel`、`POST /commands`、`GET /commands/:id`、`POST /commands/:id/cancel` | `:1526-1534`、`routes/command-routes.ts:12,16,21` |
| 导入 | `POST /v1/import-jobs[/:id/cancel]` `/imports/uploads` `/imports/inspect` `/import-sources/discover`；`DELETE /import-sources/:id`；`GET /import-sources/recent` `import-jobs/{active,latest,:id}` | `routes/import-routes.ts:16-117` |
| 移动端聚合 | `GET /v1/mobile/{today,statistics,trends,goals,workout-plan}`；`PUT /v1/mobile/goals`；`POST /v1/mobile/lock`；`POST /v1/mobile/workout-plan/{preview,confirm,generate,synced}` | `server.ts:932,1016,1024,1111,1133,1152,1177,1179,1196,1198,1225` |
| 设置/备份 | `GET/POST /v1/backups`、`GET/DELETE /v1/backups/:name`、`POST /v1/backups/:name/restore`、`DELETE /v1/database` | `:1557-1602` |

### 2.4 写端点登记制度（新增写端点必须做三件事）

| 集合 | 语义 | 定义 |
|---|---|---|
| `metadataOnlyMutationRoutes` | 只落 intent/元数据，不碰主库 ⇒ 不取写锁、不校验 DB 就绪 | `server.ts:275-290` |
| `databaseRequiredMutationRoutes` | 需主库存在且未 blocked ⇒ 取写锁 + readiness 闸门 | `server.ts:291-302` |
| `lockOnlyMutationRoutes` | 取写锁但**允许无库**（导入/恢复/删除的自救路径） | `server.ts:317-321` |

**三重把关**（任何一条漏做，门禁变红）：
1. `schemas.test.ts:349-356` 断言每个写路由 `owners.length === 1`；
2. `schemas.test.ts:332-335` 断言每个写路由都在 `openapiDocument.paths` 里；
3. `server-runtime.test.ts:1429-1486` 用**解释器自己的路由表**（`RAI_ROUTE_DUMP`，`server.ts:1636-1640`）比对三个集合。

运行时执行：`preHandler` hook（`server.ts:347-374`）。

### 2.5 模型链与门禁

| 概念 | 落点 |
|---|---|
| shadow gate 实现 | `model-run-repository.ts:139 evaluateValidationGate`，`gateVersion = "rai-shadow-gate-v1"`（`:139-140`），阈值 `:141-149`，持久化 `:253` |
| 门禁**唯一活调用点** | `recompute-pipeline.ts:219`（incumbent 存在时强制比较，`failed` 抛错阻断激活） |
| 门禁表 | `database.ts:1312-1330`（v18 `model_validation_gates`） |
| active 指针（跑力） | `model-run-repository.ts:98 activateSucceeded` → `INSERT INTO active_model_run` |
| active 指针（预测） | `prediction-model-service.ts:688/755`；离线门槛 `:801-839` |

> ⚠️ **易误判**：`recompute-pipeline.ts:211-217` 注释说 shadow **full-replay 对比已删除**——
> 被删的只是全量重放对照（见 `SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md`）；
> **真门禁 `evaluateValidationGate` 保留且强制生效**（🔍侦察 + `UNCOMMITTED_REVIEW_2026-09-21.md:111`）。
> 两个概念不要混为一谈。

### 2.6 导入与切换（原子发布）

`apps/api/src/import-worker.ts`（`ImportWorker.run`，`:462`）：

`上传 → 载荷级早退 → 备份 → staging 拷贝 → 解析 → 变更分析 → 重算 → 写回执 → 原子 rename 切换 → 终态清理`

| 关键保护 | 证据 |
|---|---|
| 载荷级早退（相同导出直接提示「已是最新」，**在备份之前**） | `:507 detectUnchangedPayload`（`:500-538`） |
| staging 是独立文件 `rai.importing.<job>.sqlite` | `:477,541-546` |
| 发布意图 Journal（防丢库） | `import-publication.ts:33 recover()`，启动期 repair `server.ts:238` |
| 失败**不回切** active | 见 `README.md:80-84`；`import-worker.ts:681 activateDatabase` |
| Rust 引擎：`unavailable` 时 job 转 `waiting_engine`（**不失败**） | `:729-738` |

### 2.7 adherence 的真实状态（对上一轮判断的修正）

| 层次 | 状态 | 证据 |
|---|---|---|
| **观测层** | ✅ **已实现**：`buildPlanExecution` 纯函数 | `apps/api/src/plan-execution.ts:6-40` ✅**亲验** |
| **填充** | 仅 `/v1/mobile/today` 路径（传 `planHistory(200)`） | `server.ts:1019` → `data.ts:470-475,515` |
| **未填充** | `/v1/mobile/lock` **不传** planHistory ⇒ 该路径字段被省略 | `server.ts:1231` |
| **iOS 展示** | ✅ 已接线：`TechPlanExecutionPanel` | `TechPlanView.swift:57-59` + `TechPlanPreviewSheet.swift:64-85` ✅**亲验** |
| **状态闭集** | `observed` \| `pending` \| `unknown`，**无 `missed`** | `plan-execution.ts:37` ✅**亲验** |
| **设计意图** | 注释明写「同日计划在收据级对账存在前刻意不推断」 | `plan-execution.ts:19` ✅**亲验** |
| **消费方（另一处）** | 周课表 LLM 提示词 | `weekly-plan-prompt.ts:96` |

**面板实际文案**（用户看到什么）：
- 标题「近七日执行记录」，副标题「仅比较已导入的跑量，不把未导入判为未完成，也不据此评价训练质量。」（`TechPlanPreviewSheet.swift:69-71`）
- 每天：`日期 · 计划类型` / `计划 X km · 已导入 Y km · N 次` / 状态标签「已观测 / 等待训练数据，暂不判断 / 缺少计划快照，无法比较」（`:74-79`）

> **结论**：这是一条**克制且自洽**的产品线。要「做 adherence」的正确问法不是「加功能」，
> 而是「是否要引入 missed 判断」——那是一个改变产品价值观的决策（§6.3）。

### 2.8 任务队列与运行时状态

| 机制 | 存储 | 证据 |
|---|---|---|
| 重算队列（CPU 密集、单写者） | 主库 `recompute_jobs` | `recompute-worker.ts:118-139`；执行在 worker thread `recompute-thread.ts:10` |
| 预测模型队列 | 主库 `prediction_model_runs` + lease | `prediction-worker.ts`，`server.ts:438` |
| 异步写命令 | **运行时库** `var/runtime.sqlite` 的 `mutation_commands` | `command-queue.ts:69-73` |
| 导入任务/来源 | 运行时库 `import_jobs` / `import_sources` | `runtime-state.ts:46,298-304` |
| 发布意图 | 运行时库 `import_publications` | `import-publication.ts:37-38` |
| 调度准入 | **内存态**（FIFO + blocked + controls） | `task-admission.ts:9-60` |
| 崩溃恢复 | 三处 `resume()`：命令 `server.ts:730`、导入 `:729`、发布 repair `:238` | — |

### 2.9 鉴权与跨端一致性机制

| 项 | 结论 | 证据 |
|---|---|---|
| Token 来源与校验 | `RAI_API_TOKEN`；`onRequest` 比对 `Bearer` | `server.ts:108`；`local-request-security.ts:141-161` |
| 匿名只读（公网 SPA） | 需 **safe method + 路由白名单 + Host 白名单**三条件同时满足 | `local-request-security.ts:57-68`；装配 `server.ts:334-346` |
| 🔴 匿名只读的隐私代价 | 轨迹含起终点坐标 ≈ 公开常跑路线与居住区域 | `deploy/README-UBUNTU.md:82-84`；仍要 Token 的敏感读见 `:81` |
| OpenAPI | **手写静态对象**（非生成） | `schemas.ts:634-883`；由 `schemas.test.ts:317-374` 对齐 |
| 契约单一源 | `packages/api-contracts/src/index.ts` | 全端 import 该文件 |
| 同步身份锚点 | `sha256([serverId, athleteId, datasetEpoch, batchId])` | `server.ts:118-120` |

---

## 3. 项目架构与需求排查

### 3.1 包分层与依赖方向（单向，无环）

```
apps/api ─→ packages/application ─→ { scoring, features, physiology,
                                     prediction-inference, training-zones }
                     │
                     └─→ storage-sqlite / health-export-parser
apps/api ─→ packages/{api-contracts, contracts, training-load, storage-sqlite, health-export-parser}
                    （唯一 API 层直连算法包：training-load）
packages/contracts ← 所有包都依赖它，它不依赖任何包
```

| 包 | 职责 | 被谁依赖 |
|---|---|---|
| `contracts` | canonical 类型 + **全部版本常量** + 时区唯一出口 | 全部 |
| `api-contracts` | HTTP DTO / OpenAPI 契约 | `apps/api`、`apps/web` |
| `health-export-parser` | XML/GPX 解析、canonical 化、睡眠/HRV canonicalization、增量、稳定 ID | `application`、`apps/api` |
| `scoring` | 纯 TS 评分核心（CA/TA/Decay/GV） | 仅 `application` |
| `physiology` | VO₂max / VDOT / 乳酸阈 / 比赛预测 | 仅 `application` |
| `prediction-inference` | CatBoost ONNX 校验与推理 | 仅 `application` |
| `features` | Workout Feature Vector | 仅 `application` |
| `training-load` | 负荷、训练状态、`PhysState` | `training-zones`、`application`、**`apps/api`** |
| `training-zones` | 分区与时间线 | 仅 `application` |
| `application` | 用例门面 + RecomputePipeline | `apps/api` |
| `storage-sqlite` | schema/migrations/repository/发布锁/备份 | `health-export-parser`、`application`、`apps/api` |

### 3.2 契约版本常量（改动前必读）

| 常量 | 值 | 定义 | 改动的后果 |
|---|---|---|---|
| `CONTRACT_VERSION` | `canonical-health-v2` | `contracts/src/index.ts:8` | 🔴 **导入早退锚点的唯一人工闸门**：改解析语义不 bump ⇒ 锚点继续命中、新算法**静默进不了库** |
| `FEATURE_SCHEMA_VERSION` | `workout-feature-v3` | `contracts/src/index.ts:132` | 列布局/校验变化 |
| `FEATURE_CONFIG_VERSION` | `feature-config-v8` | `features/src/index.ts:12` | 公式变化必须 bump（`configHash` 挡前缀复用） |
| `MODEL_CONFIG_VERSION` | `rai-model-config-v4` | `scoring/src/model.ts:16` | 折进 `modelConfigHash`，决定 Model Run 可否复用 |
| `TRAINING_LOAD_CONFIG_VERSION` | `training-load-config-v4` | `contracts/src/index.ts:288` | 决定训练指标是否重建 |
| `TRAINING_ZONE_CONFIG_VERSION` | `training-zone-config-v3` | `contracts/src/index.ts:287` | 写进 zone run 的 `zoneVersion` |
| `PHYSIOLOGY_MODEL_VERSION` | `rai-physiology-v1.7.0` | `physiology/src/index.ts:17` | 预测口径 |

> ⚠️ `FEATURE_SCHEMA_VERSION`（结构）与 `FEATURE_CONFIG_VERSION`（公式）是**两个层级**，不可混用。

### 3.3 数据模型（v1–v22）

| 版本段 | 内容 |
|---|---|
| v1 | 原始层：`import_manifest` / `profile` / `health_records` / `workouts` / `workout_statistics` / `workout_events` / `workout_routes` / `route_points` / `activity_summaries` / `entity_inventory` / `import_issues` / `workout_groups`（`database.ts:89-245`） |
| v2–v3 | 派生层：`training_sessions` / `feature_runs` / `workout_features` / `model_runs` / `ability_assessments` / `daily_ability_snapshots` / **`workout_overrides`** / `recompute_jobs` / `active_model_run` + performance_protocol（`:247-571`） |
| v4–v5 | 预测模型：`prediction_model_runs` / `active_prediction_model` + worker lease 单飞（`:573-665`） |
| v6–v9 | 训练负荷与统计参与：`training_metric_runs` / `workout_training_loads` / `daily_training_metrics` + active 视图硬化（`:667-931`） |
| v10 / v12–v13 | 增量血缘：`import_batches` / `import_entity_generations` / `route_file_fingerprints` / `model_checkpoints`（`:933-987,996-1022,1024-1066`） |
| v11 | **无 SQL 的历史占位**（保持版本连续，`:989-994`） |
| v14–v15 | 分区与复合负荷：`daily_zone_profiles` / `workout_zone_summaries` + `load_source='composite'`（`:1068-1243`） |
| v16–v18 | 预测基线指纹 / **`canonical_nights` + `canonical_hrv_days`** / **`model_validation_gates`**（`:1245-1333`） |
| v19–v22 | 删除墓碑（entity/source）/ 查询索引 / **稳定 ID 重写与去重**（`:1341-1432`） |


**核心表速查**：

| 概念 | 表 | 版本 |
|---|---|---|
| 用户覆盖（RPE/备注/课型/纳入） | `workout_overrides`（编辑只新增更大 revision） | v2 `:430-441`；v3 `:528-539`；v6 `:674-679` |
| 能力评估 | `ability_assessments`（五维分、置信度因子、TA 前后值、解释 JSON） | v2 `:379-408` |
| 模型状态 | `model_runs` + `active_model_run`（成功 Run 永不覆盖旧结果） | v2 `:360-374,480-484` |
| 睡眠/HRV 唯一事实源 | `canonical_nights` / `canonical_hrv_days` | v17 `:1262-1306` |
| 门禁 | `model_validation_gates`（唯一 `candidate+gate_version`） | v18 `:1315-1326` |
| ⚠️ 历史遗留 | `recompute_validations` **恒空**，仅为兼容历史迁移 | `:1046-1056` |

**迁移闸门（部署必用）**：

| 项 | 结论 |
|---|---|
| API/worker 打开策略 | 一律 `migrationPolicy:"refuse"`（`server.ts:491,563`、`recompute-thread.ts:7`、`command-queue.ts:179`、`prediction-worker.ts` 多处） |
| 有 pending 的现象 | `log.fatal` + **`process.exit(78)`**（`server.ts:507-510`），systemd 不重启（`rai-api.service:18-20`） |
| 判断待执行 | `npm run data:migrate -- --database <path>` **默认 dry-run**，输出 `pending` 必须为 `[]`（`migrate-cli.ts:15-30`） |
| 🔴 不可改历史迁移的 `up` | 已应用迁移走**冻结 checksum 表**（`database.ts:1669-1692`），改了 ⇒ 所有既有库永久打不开 |
| 迁移非单一事务 | 每个版本各自 `BEGIN IMMEDIATE`，序列失败**不回到最初**（`:1915-1930`） |

### 3.4 双库分工（+ 第三库）

| 库 | 存什么 | 证据 |
|---|---|---|
| 主库 `var/rai.sqlite` | 事实层 + 派生层 + 导入状态层 | `server.ts:103` |
| 控制库 `var/rai-control.sqlite` | 移动端周目标 / 周计划 / 锁课 / `revision` / 比赛目标（表 `mobile_goals` / `mobile_goals_history` / `mobile_plan_pushes`） | `mobile-goals.ts:169,456-477`；`server.ts:104` |
| 运行时库 `var/runtime.sqlite` | `import_jobs` / `import_sources` / `mutation_commands` / `import_publications` | `runtime-state.ts:46`；`command-queue.ts:69-73`；`import-publication.ts:37-38` |

> 🔴 **边界**：三个库之间**无跨库外键**。恢复历史备份时，控制库里的锁课可能指向主库不存在的记录。
> 完整恢复**必须**包含 runtime 库 / 控制库 / 模型 artifact / 导入目录 / 身份变量，单份 `POST /v1/backups` 不够
> （`deploy/n100/README.md:170-173`）。

### 3.5 单一计算源（防「两端解释不一致」）

| 单一源 | 定义 | 多消费方 |
|---|---|---|
| `assessRecovery()` | `mobile-coach.ts:217` | ① `decideVerdict` 闸门 ② 对外的 `recoveryAssessment` 字段（`mobile-read.ts:288-293` 注释「One assessment, two consumers」） |
| `decideVerdict(input, assessed?)` | `mobile-coach.ts:267` | 接受已算好的评估，禁止二次计算（`:274-278`） |
| `MOBILE_SESSION_KINDS` | `contracts/src/index.ts:676-685` | 类型 union / JSON Schema / 各处 `Set` 全部派生（曾有四份手写副本） |
| 时区 | `contracts/src/timezone.ts` | 全部包（`Intl.DateTimeFormat` 记忆化） |

> **为什么这条重要**：同一语义在两处计算 ⇒ 接口字段与决策闸门漂移，用户看到「App 的解释」与
> 「Coach 实际决定」不一致，且**静默无报错**（历史事故见 `UNCOMMITTED_REVIEW_2026-09-14.md:26,143`）。

### 3.6 需求覆盖排查（缺口清单）

| # | 能力 | 现状 | 缺口性质 |
|---|---|---|---|
| 1 | 主观反馈录入（RPE / 备注 / 状态标签） | 表 ✅（v2）、端点 ✅（`PATCH /v1/workouts/:id/override`）、Web ✅（`OverrideDrawer.tsx:99`）、**iOS ❌** | 🔴 **采集端缺入口**（§1.4） |
| 2 | 改训练类型 / 排除记录 | 同上：Web 有、iOS 无 | 🔴 同上（一行代码的 `override.sessionType` iOS 只能看） |
| 3 | 计划-执行对账 | 观测层 ✅ + iOS 展示 ✅；missed 判断**刻意无** | 🟡 **这是产品决策，不是缺口**（§2.7） |
| 4 | 成绩预测 | 服务端 ✅（`/v1/predictions`）、Web ✅（`/predictions`）、**iOS ❌**（五入口无此项） | 🟡 跨端不一致 |
| 5 | 主动触达（通知） | **零命中**（仅 `BGProcessingTask` 做静默同步） | 🟡 纯被动型 App |
| 6 | 用户级数据导出 / 分享 | **零命中** | 🟡 |
| 7 | 训练列表筛选 | iOS **6 项课型**（`TechViews.swift:1091-1098`）；Web **8 维**含模型参与/来源/置信度/路线 | 🟡 跨端不一致 |
| 8 | 首页信息密度 | iOS 原生 **8 块**（`TechViews.swift:7-46`）；Web iOS 壳 **3 块**（`ios/Home.tsx:86-158`） | 🟡 同一体验两种密度 |
| 9 | 跑中执行（手表看处方） | ✅ **已解决**：WorkoutKit 下发（§1.7）——**不是缺口** | — |

### 3.7 部署形态要点

| 项 | 结论 | 证据 |
|---|---|---|
| Nginx 静态 | `/opt/rai/apps/web/dist`；SPA 白名单回退，未命中 404 | `nginx-rai.conf:53-54,95-105` |
| 上传放宽 | `/v1/imports/uploads` 单独 `client_max_body_size 4g` | `:80-91`（默认 1m 见 `:49`） |
| 限速 | 5 r/s + `burst=100 nodelay`，429 | `:25-26,67,81` |
| systemd | 仓库仅 1 个 unit；**timer 不在仓库**（文档内 heredoc 模板） | `deploy/rai-api.service`；`README-UBUNTU.md:113-138` |
| 资源封顶 | `MemoryMax=1400M` / `CPUQuota=150%` / `TasksMax=128` | `rai-api.service:33-37` |
| 沙箱 | `ProtectSystem=strict` / `ReadWritePaths=/var/lib/rai` / `UMask=0077` | `:24-29` |
| 环境变量 | `EnvironmentFile` 启动注入 ⇒ **改任一项都要 restart** | `rai.env.example`；`server.ts:102-136` |
| Rust 引擎 | 二进制在仓库外 `/opt/rai-native/rai-data-worker`；**同批写 3 个变量**；生产 `RAI_RUST_FALLBACK=typescript` | `docs/RUST_DATA_ENGINE.md:79-107,150-156,165-175` |
| 🔴 Rust 生效判据 | 「API 起来了」≠「引擎生效」；唯一判据是读 `/proc/<MainPID>/environ` | `docs/RUST_DATA_ENGINE.md:185-196` |
| 备份 | 热备 `POST /v1/backups`（14 份 / 10 GiB / 1 GiB）；冷备 `backup-runtime.sh`（默认 dry-run） | `maintenance.ts:80-84`；`rai.env.example:43-46` |

---

## 4. 关键设计要点（跨领域，最容易踩的）

| # | 要点 | 判据 |
|---|---|---|
| 1 | **「已部署」≠「代码走到了」** | 一律看**接收端**有没有把它记下来（数据层 `typeof` / 配置文件 / 跨进程契约 / 接收端枚举白名单 / 上游改了下游吃旧数据） |
| 2 | **新增写端点 = 三选一登记 + OpenAPI + 路由表** | 三条都由测试守，漏一条变红（§2.4） |
| 3 | **契约字段无展示位 ⇒ iOS 门禁自己变红** | `run-tech-presentation-tests.sh:210`（`unaccounted` 集合必须为空） |
| 4 | **观测与判断要分开** | `plan-execution.ts` 只给事实，不给评级（§2.7）；`assessmentStatus` 与 `score` 同理 |
| 5 | **纯领域包无 I/O** | `scoring` 不读系统时间、不访问库（`ARCHITECTURE.md:196-204`） |
| 6 | **算法包只经 application 触达** | 唯一例外 `training-load`（`mobile-read.ts:23`）——新增直连要三思 |
| 7 | **原子单元不可拆** | `upload → inspect → startImport` 必须同一唤醒（§1.6） |
| 8 | **非 throwing 的 async API 必须回读校验** | `WorkoutScheduler.schedule`（§1.7） |

---

## 5. 边界情况总清单

| # | 场景 | 现状 | 风险 / 判据 |
|---|---|---|---|
| 1 | 服务端有 pending 迁移 | `exit 78`，systemd 不重启（`rai-api.service:18-20`） | 部署前必须 dry-run 核 `pending: []` |
| 2 | 控制库锁课指向主库不存在的记录 | 无跨库外键 | 恢复历史备份后需人工核对；完整恢复要带 runtime 库 |
| 3 | 匿名只读暴露轨迹 | 设计如此，文档标为**隐私降级** | 起终点坐标 ≈ 居住区域（`README-UBUNTU.md:82-84`） |
| 4 | datasetEpoch 变化 | iOS 缓存命名空间随之失效 | 这是防「跨库混读」的设计意图 |
| 5 | 重新全量导出 | 换 `ExportDate` → 新 `payloadHash` → 服务端幂等键失效，可能两份来源两个 job | 唯一合法入口是显式「重新导入全部」 |
| 6 | iOS 无配对手表 | `deviceUnsupported` | 不能提示「去授权」（死路） |
| 7 | 模拟器跑 HealthKit | 设计上 fail closed | 「同步未完成」是预期行为 |
| 8 | `RAI_RUST_FALLBACK=none` | `unsupported_xml` 直接 `failed`（无回退） | 生产**必须** `typescript` |
| 9 | Rust 二进制缺失 + fallback=typescript | **不校验、不报错**，静默走 TS | 判据只有 `/proc/<MainPID>/environ` |
| 10 | 单次 CA 残差 | 截断 ±12（`ARCHITECTURE` / PRD §11.13） | 防止一次异常训练大幅波动 |
| 11 | 备份保留策略 | 14 份 × 40 分钟 ⇒ 回滚窗口约 9.3h 上界 | 需要更早的回滚点就只能靠冷备 |
| 12 | 运行中打开备份文件 | 只读也会就地产生 `-shm`/`-wal` 侧车 | 排查完必查必清 |
| 13 | iOS 离线 | 可看缓存，**禁止一切写** | 判据 `isOffline = !workoutsSucceeded` |
| 14 | 周计划预览 sheet | 打开**不得**产生任何写入 | 已由门禁钉死（`run-tech-presentation-tests.sh` 末段） |

---

## 6. 孤儿资产与待决事项

### 6.1 孤儿 / 准孤儿（有代码、无生产调用方）

| 对象 | 位置 | 判定 |
|---|---|---|
| 🔴 `POST /v1/mobile/workout-plan/generate` | 服务端 `server.ts:1153`（登记于 `:286`）；iOS 客户端方法 `APIClient.swift:149-155`；**Web 零命中** | **孤儿端点**：iOS 定义了方法但从不调用（走 preview+confirm），Web 也不用 |
| `loadSleepWindow` | `apps/api/src/mobile-read.ts:644-677` | 孤儿（已被 `SqliteRecoveryFactsReadRepository` 取代） |
| `loadMetricWindow` / `metricValues` | `mobile-read.ts:679-692,694-701` | 孤儿（后者只被前者引用） |
| `ReadStoreManager.invalidate()` | `read-store-manager.ts:152-154` | 孤儿方法（勿与 `invalidateDatabaseReadiness` 混） |
| `benchmark-import.ts` / `import-equivalence.ts` | `apps/api/src/` | 准孤儿（仅被测试使用） |
| `recompute_validations` 表 | `database.ts:1046-1056` | 恒空，历史兼容 |

> 处置原则（沿用项目既有共识）：**每个端点/导出必须有 ≥1 个生产调用方，否则删除或明确标注为调试保留**。
> 删除前先确认迁移是否仍依赖（`import_entity_generations` 一类的教训）。

### 6.2 文档债（§0.3 的 5 条 + 2 条）

| # | 待修文档 | 修什么 |
|---|---|---|
| 1 | `docs/ARCHITECTURE.md` | iOS 描述改为 SwiftUI 原生；删除 React Native 现状口吻；§7 范围段重写 |
| 2 | `docs/DATABASE_DESIGN.md:3` + `README.md:236` | v1–v18 → v1–v22 |
| 3 | `apps/ios/README.md:81` | 删「recentPlanExecution 无展示位 / 断言是红的」 |
| 4 | `apps/ios/README.md:86` | fail-closed 行号 `293` → `1003-1026` |
| 5 | `apps/ios/README.md:16` | 删「WKWebView 保留为回退路径」（iOS 已无该分支） |
| 6 | `design/TECHNOLOGY_SKIN.md` | 门禁例外数 3 → 4（含 `freshness`） |
| 7 | `docs/ARCHITECTURE.md:236-240` | 该段列出的条目与上文物列表错位（迁移/Node SQLite 等被误列为 infrastructure 子项） |

### 6.2.1 结清记录（2026-09-28）

七条**全部修完**。执行时对全仓做反向扫描，又抓到 **6 处同类陈旧表述**（同一缺陷、散在别的文件里），一并修掉。
净改动 **8 个文件 / +38 −34 行**，全部落在文档与一处 nginx 注释，**未触碰任何代码**。

**§6.2 原清单（7/7 完成）**

| # | 文件（改动量） | 改了什么 | 判据 |
|---|---|---|---|
| 1 | `docs/ARCHITECTURE.md`（+21 −19） | iOS 描述改 SwiftUI 原生；删 React Native 现状口吻；mermaid 的 `MobileApp` / `HealthKit` / `HealthKitAdapter` / `WebNow` 节点、§5 目录树、§7 范围段、§11 测试表、§12 实施顺序同步对齐 | 反向 grep：`调试壳` **零命中**；`React Native` 仅剩「未立项」语境 |
| 2 | `docs/DATABASE_DESIGN.md:3`、`README.md:236` | v1–v18 → **v1–v22** | 对齐 `packages/storage-sqlite/src/database.ts` 迁移表 |
| 3 | `apps/ios/README.md:81` | 删「断言是红的 / `recentPlanExecution` 无展示位」，改为实跑值 `23/27 有锚点、4 个元数据例外`，并补 `TechPlanView.swift:57-59` 与 `EXIT=0` | 门禁实跑复现 |
| 4 | `apps/ios/README.md:86` | fail-closed 行号 `HealthKitSync.swift:293` → **`:1003-1026`** | 实读源码 |
| 5 | `apps/ios/README.md:16` | 删「WKWebView 保留为回退路径」 | `RootView.swift:47-48`：iOS 分支无回退路径 |
| 6 | `apps/ios/design/TECHNOLOGY_SKIN.md:50,128,140,155` | 门禁例外数 3 → **4**（含 `freshness`）；把 09-17 的红断言块改为「已于 2026-09-28 闭合」，历史保留 | 门禁实跑复现 |
| 7 | `docs/ARCHITECTURE.md:236` | 补回丢失的主语：`基础设施层还包含（均落在 apps/api 或 packages/storage-sqlite）：` | 回读确认 |

**反向扫描新增（6 处，超出原清单）**

| 文件 | 改了什么 | 判据 |
|---|---|---|
| `docs/ARCHITECTURE.md:90,261` | mermaid `MobileApp["React Native UI / Expo Custom Dev Client"]` → `独立移动端 UI（未立项）`；目录树 `桌面 + iOS 壳像素 UI` → `桌面 + Web iOS 壳像素 UI` | 反向 grep |
| `README.md:255` | `iOS 调试壳说明与设计稿→API 映射见` → `iOS 应用说明…` | 反向 grep |
| `docs/WEB_IMPLEMENTATION.md:16` | 删「（iOS 调试壳 WKWebView 加载即此界面）」；改为 `?raiShell=ios`（`apps/web/src/main.tsx:9`）并注明**这是 Web 侧历史界面** | 反向 grep + `RootView.swift:47-48` |
| `deploy/README-UBUNTU.md:68` | 删「由壳把 Token 注入页面」；改为 iOS **首次连接页**（`TechSetupView.swift:45-56` 的「服务地址」/「访问令牌」）填写地址与 Token，Token 存 Keychain | 实读源码（`TechSetupView.swift:39,51,54`） |
| `deploy/nginx-rai.conf:6,8-9` | 注释里同样删掉「WKWebView 调试壳」与「WKWebView 无法处理 Basic Auth」；改述为 iOS 原生应用直接请求 `/v1`。**仅注释，零行为影响** | 回读确认 |
| `apps/ios/design/TECHNOLOGY_SKIN.md:130,142` | 带日期小节里的「41 条展示断言」补时间口径（2026-09-28 实跑 **52** 条） | 门禁实跑复现 |

**刻意未改**（不是漏，是口径原因）

| 位置 | 为什么不动 |
|---|---|
| `docs/PROJECT_HEALTH_AUDIT_2026-09-09.md`、`…2026-09-10.md`、`docs/IOS_CLOUD_REVIEW_PLAN_2026-09-07.md`、`docs/SLEEP_HRV_DESIGN.md`（日期 2026-09-04）、`deliverables/**` | **带日期的时点快照**，按项目既有约定不回写；改它们等于伪造历史 |
| `TECHNOLOGY_SKIN.md` 里的 `43` / `47` / `48 文件` | 类型检查文件数随 glob 单调增长（09-18 → 43、09-22 → 45、09-24 → 55/56、09-26 → 55、**09-28 → 59**），且只出现在带日期小节里、各自当时自洽 ⇒ 不是债务 |
| `TECHNOLOGY_SKIN.md:130,142` 的 `41` 原值 | 同上：保留原值，只加时间口径标注 |
| `AGENTS.md` 的 "former WKWebView shell remains only as a development fallback" | 🟡 **该文件是范围契约，不由我单方面改**。但现表述容易被读成「回退路径可触发」，而 `RootView.swift:47-48` 的 iOS 分支已是**无条件**原生 ⇒ 建议改为「`AppWebView` 仅保留非 iOS 分支」 |

**本轮实跑证据**（重跑，不是引述别处的数字）

```
$ bash apps/ios/tests/run-tech-presentation-tests.sh     → EXIT=0
  Technology presentation: 52 checks passed
  Technology color tokens: 24 foreground/background pairs meet the 4.5:1 project target
  Field coverage: 23/27 MobileTodayResponse fields have a Technology display slot and
      4 are metadata by design (freshness, lastSyncedAt, recommendationRevision, timezone);
      9 closed-set enum mappings cover every contract value
  Phase labels: 12 SyncPhase values, 11 explicit labels
  Plan preview gate: confirm-only, with both replaced-date and previous-prescription branches present

$ bash apps/ios/tests/typecheck-ios.sh                   → EXIT=0
  类型检查 59 个文件（已跳过 3 个仅依赖高德 SDK 的文件）
```

**回滚方案**：这 8 个文件在本轮之前**都不在** §0.4 的未提交清单里（§0.4 只有 `apps/api/src/*` 与 `apps/ios/RAI/*`、`apps/ios/tests/*`），
因此下面一条命令可精确回退本轮全部改动，不会波及在途代码：

```bash
git checkout -- README.md docs/ARCHITECTURE.md docs/DATABASE_DESIGN.md docs/WEB_IMPLEMENTATION.md \
  deploy/README-UBUNTU.md deploy/nginx-rai.conf apps/ios/README.md apps/ios/design/TECHNOLOGY_SKIN.md
```

### 6.3 待决事项（需要产品判断，不是技术判断）

| # | 事项 | 决策点 | 影响面 |
|---|---|---|---|
| 1 | **是否给 iOS 加主观反馈入口** | 采集端无入口 = 永远没数据；表与端点都已就绪（§3.6-1） | 小改动，收益明确 |
| 2 | **是否引入 `missed` 判断** | 这是**产品价值观选择**：引入后「漏课」会被显式呈现 | 改变现有克制立场（§2.7） |
| 3 | **两个 iOS 体验谁是标准** | Web iOS 壳（`?raiShell=ios`）与原生 App 并存，首页密度 3 vs 8、预测页有/无 | 需先定标准再对齐 |
| 4 | 是否做通知子系统 | 全仓零命中 ⇒ 从零建（entitlement + 权限引导 + 触发规则） | 建议先观察 |
| 5 | 孤儿端点 `workout-plan/generate` 留还是删 | 留着是第二个生成口径的隐患 | 小 |
| 6 | 是否引入用户级导出 | 当前零命中；PRD 只描述过「诊断导出（去坐标）」 | 中 |

---

## 附：本次侦察的自我校正记录

| 事项 | 上一轮说法 | 本轮核实结果 |
|---|---|---|
| 计划-执行对账 | 「缺失 / 零命中」 | ⚠️ **不准确**。观测层已实现且 iOS 已接线（`TechPlanView.swift:57-59`）；缺的是 missed 判断，且属**刻意不做** |
| iOS 首页跑力卡位置 | 「排第 6」 | 成立（`TechViews.swift:7-46` 中 abilityCard 在 recommendationPanel 之后） |
| iOS 无本地通知 | 「零命中」 | 成立（`UNUserNotificationCenter` 等零命中） |
| iOS 无成绩预测页 | 「五入口无此项」 | 成立（`NativeViews.swift:13-39`） |

---

*生成：小满 🧭 ｜ 2026-09-28 ｜ 4 路只读侦察 + 关键断言亲验 ｜ 未修改任何代码*
