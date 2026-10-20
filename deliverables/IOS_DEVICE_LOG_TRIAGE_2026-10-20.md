# iOS 真机日志分诊（2026-10-20）

设备日志：`app.rai.running.debug-default`（iOS 26.x 真机）  
代码基线：`HEAD 958e8f4` + 工作树未提交改动（6 个 `M`，均为既有的 health-sync 注解/测试脚本改动，不改变本文引用的行为）  
方法：只读静态分析 + iOS 26.5 模拟器最小工程实测（Swift Charts / 键盘告警）+ 4 路独立并行复核；每条结论标「事实」「实测」「强推断」或「需真机复测」。

---

## 0. 结论速览

**没有发现 P0 级功能故障。** 健康同步的两行通道计数是「历史重放期、单批打满 12000 条上限」的正常指纹；`BGTaskScheduler` 注册与重排逻辑正常。真正值得动的是三类，按性价比排序：

| 优先级 | 事项 | 性质 | 改动量 | 收益 |
|---|---|---|---|---|
| **P1** | 通道计数日志补 `source=restored\|batch`、补 `anchorTypes` | 诊断可读性 | 小 | 本次“两行计数到底哪行是恢复、`types=5` 为何偏小”这类问题不再靠猜 |
| **P1** | `BGTaskScheduler.keep` 行按 60 s 窗口聚合（补 `delay=`/`existing`/`n=`） | 诊断信噪比 | 小 | 消除每次冷启动 ~20 行刷屏，同时保留唯一观察面 |
| **P2** | `TechSeriesChart` 的 `.chartOverlay` 顺序加固（frame 放最后） | 零风险加固 | 2 分钟 | 排除一处理论触发面；真机 A/B 用 |
| **P2** | `TechKeyboardDismiss` 的 keyboard toolbar 改为按需安装 | 降噪（系统告警放大器） | 小 | 减少无焦点时提前安装键盘跟踪设施 |
| **P2** | 高德 SDK 懒初始化 + `setAlcLogConfig(recordStorage:NO)` | 第三方 SDK 治理 | 小 | 冷启动不再初始化 Foundation；停止 `Documents/amap` 本地写入 |
| **P3** | `submitBackgroundRun` 读→提交未序列化；提交层重导循环；`steadyStateGapDiagnostics` 看不到 anchor 写入 | 结构观察项 | 需设计 | 本轮只记录，不改 |

**不需要改的**：`PointerUI`、`cannot add handler to 0 from 0 - dropping`、`InputUI.keyboard` 场景、`Reading from public effective user settings.`、`AX Safe category …` 均为系统/模拟器噪声；`replay=1`/`window=233` 是重放期正常形态；**不要**为消 `nehelper` 日志去加 Wi-Fi entitlement 或定位权限。

---

## 1. 日志逐行归因

| 日志行 | 来源 | 判定 | 处置 |
|---|---|---|---|
| `[RAI] BGTaskScheduler.register ok …` | `AppDelegate.swift:251-274`（`:271` 注册成功才打印） | 正常，真机验收判据 | 保留 |
| `[RAI] BGTaskScheduler.keep earlier pending request` ×21 | `AppDelegate.swift:301`，`submitBackgroundRun` 的 keep 分支 | 冷启动观察者投递风暴的**纯 no-op**，每次付一次 `getPendingTaskRequests` | 改日志聚合，不删（§2.2） |
| `[RAI] 本批通道计数 …` ×2 | 恢复轮 `HealthKitSync.swift:1310-1316` 或新批次 `:1895-1897` | 重放期正常打满批；两行出处无标记 | 补 `source=`、`anchorTypes`（§2.1） |
| `nehelper sent invalid result code [1] for Wi-Fi information request` ×22 | 高德 `AMapStatistics fetchSSIDInfo` → `CNCopyCurrentNetworkInfo` | 无 Wi-Fi entitlement/定位授权 ⇒ 必然失败；非 bug | 懒初始化可减；**不要**加权限（§2.4） |
| `[alc-inner] / QA_SETTING / UPLOADER` 段 | 高德 `MAMapKit` 的 ALC 日志子系统 | 写 `Documents/amap/600log`，有上传端点 | `setAlcLogConfig(recordStorage:NO)`（§2.4） |
| `Charts: Using the chartOverlay or chartBackground modifier without a chart…` | Swift Charts 框架；仓库仅两处用法 | 模拟器实测：只有挂到不含 Chart 的子树才触发；仓库两处按 26.5 语义**不触发** | 顺序加固 + 真机 A/B（§2.3） |
| `Got a keyboard will change/hide … keyboard was not even present.` | 系统键盘/无障碍跟踪层；App 的 keyboard toolbar 是放大器 | 系统噪声为主 | 条件安装 toolbar（§2.3） |
| `The tracking window controller is unable to get the keyboard scene … ForegroundInactive` | UIKit 键盘跟踪窗口在启动/切场景时取键盘 scene | 系统侧，不可清零 | 减少无焦点 toolbar 可降低概率 |
| `No scene exists for identity: com.apple.InputUI.keyboard…` | InputUI 键盘 UI 进程场景未建立 | 系统侧；硬件键盘/模拟器更常见 | 不改 |
| `non-launching port is incompatible … PointerUI…` | PointerUI 系统服务 | 实测 SpringBoard 自己也会打印 | 不改 |
| `cannot add handler to 0 from 0 - dropping` | 系统 HID/事件/键盘仲裁层（App 无相关 API） | 中置信系统噪声；26.5 未复现 | 不改 |
| `Reading from public effective user settings.` / `AX Safe category …` / `(null)` | 系统进程（CFPreferences/UIKit/第三方 printf） | 纯噪声 | 不改 |

---

## 2. 需要优化的事项（按优先级）

### 2.1 P1 · 通道计数日志：两行无法区分出处，`types=` 系统性少报

**事实（代码可证）**

1. `anchor=` / `window=` 是**本批写入条数**，不是游标值（`SyncTaskState.swift:14-32`、`:58-63`）。
2. 两行的总量都精确等于 12000：`11767+233 = 11768+232 = 12000`，而 12000 是客户端单批记录上限（`DirectSyncBatchBudget.swift:79`；服务端 8 MiB 见 `apps/api/src/direct-sync-ingest.ts:65`）。这是「预算被记录条数打满」的指纹，**`anchor 11767→11768` 不代表“第二批只写了 1 条”**。
3. `types=` 只统计 workout 窗口、late backfill、48h 窗口三条子通道（`writtenTypes.insert` 仅 `HealthKitExport.swift:1705 / 1858 / 1974`）；**anchor/历史重放段的 `commit` 从不 insert**（`:2185-2199`），最终在 `:2292` 取并集大小。所以本批 `types=5` 只是 48h 窗口写到的 5 个类型，anchor 写的类型一个都没算进去。
4. 两个打印点共用同一格式串、没有来源标记：恢复轮 `HealthKitSync.swift:1310-1316`，新批次 `:1895-1897`，函数 `:2561-2563`。
5. `historySkipped=0` 是**结构必然**：`SyncCoveragePolicy.allowsHistorySkip = false`（`HealthKitRecordCursor.swift:489-514`）⇒ 覆盖下界恒为 nil ⇒ 计数恒 0，且覆盖探测请求本身都不会发（`:537-550`、`HealthKitSync.swift:1771-1797`）。不要读成“服务端说没有可跳过的历史”。

**推断（强）**

- 你贴出的这段日志里只有这两行计数，没有更早的 `anchor=11767`；按“恢复值必须等于上一批落盘值”的约束（`lastExportCounts` 只在 `saveTask(phase: exported)` 写入，`HealthKitSync.swift:1938-1987`），**最可能是两次连续的新批次导出**。判别法：在整段日志里搜 `anchor=11767`——若更早处还有一条新批次行，则第一行是恢复行，两行是“上一批恢复 + 本轮新批”。
- `replay=1` 只统计“本轮实际开始处理”的 history 类型（`HealthKitExport.swift:2128`），预算打满即 `break`（`:2035-2037`），所以它既不等于“全局只有 1 个类型在重放”，也不等于“同一个类型连续两批都卡住”（类型轮转，`HealthKitExport.swift:2028-2039`、`HealthKitSync.swift:3559-3567`）。`anchor≈11767` 说明有类型连续提交十几页、游标在前进，不是页首卡死（页首卡死的批次 `anchor=0`，`HealthKitRecordCursor.swift:172-180`）。

**建议（低风险、优先做）**

1. `logExportCounts` 增加来源标记：`source=restored|batch`（`HealthKitSync.swift:1310-1316` 与 `:1895-1897` 各改一处，格式串 `:2561-2563`）。
2. `ExportChannelCounts` 增加 `anchorTypes`（Optional，向后兼容，`SyncTaskState.swift:14-64`；`logLine` 末尾追加字段，不要动 `anchor=` 开头顺序）。**不要**把 anchor 类型并入 `writtenTypes`：后者同时供用户告警 `dynamicsSiblingsWritten`（`HealthKitExport.swift:2010-2013`）与稳态诊断（`:2025-2027`）使用，并入会改变告警语义。
3. 可选：逐类型 replay 行（每批 ≤18 行、只写计数/枚举）：`type=… cursor=yes/no phase=… records=… pages=… advanced=yes/no`。这是把“某个类型是否卡在重放”从推断变事实的唯一办法。
4. 附带修一个**潜在误报**：`steadyStateGapDiagnostics(writtenTypes:)` 在 anchor 循环**之前**调用（`HealthKitExport.swift:2025-2027`），而 `writtenTypes` 不含 anchor 写入 ⇒ 若 backfill/workout 写了同族其它跑步动态、anchor 写了功率，会误报“本批没写功率”；稳态下 anchor 写入则完全不可见。正确做法是把该诊断移到 anchor 循环之后，传入 `writtenTypes ∪ anchorTypes`（单列变化，不要动用户告警）。

**门禁影响**：`logLine` 保持以 `anchor=` 开头、字段往返完整（`apps/ios/tests/SyncTaskMigrationRegression.swift:331-390`）；新增字段用 Optional；改日志不碰 `check-export-determinism.py` 的三组判据；在 `HealthKitExport.swift` 内加代码需过 `check-healthkit-record-sync.py` 的文本钉。

---

### 2.2 P1 · `BGTaskScheduler.keep` ×21：结构性噪信，不是调度 bug

**事实（代码可证）**

1. 全仓唯一出处 `AppDelegate.swift:301`；keep 分支除这行日志外**无任何副作用**（不 submit、不 cancel、不改状态，`:296-303`），但它和 submit 分支一样先付一次 `BGTaskScheduler.getPendingTaskRequests`（`:292`，判据在异步回调内）。
2. 能在秒级窗口内被调用 10~20+ 次的只有观察者投递的两支：`.deferToBackground` → `submitBackgroundRun()`（`:78`）与 `.deferToBackgroundLater` → `submitBackgroundRun(after: 900)`（`:84`）。其余 7 个入口（切后台 `:463`、BGTask 收工 `:361/:363`、后台 URLSession `:435`、同步收尾 `:155/:177/:193`）都是每事件 ≤1 次。
3. 观察者数量上界 = 2 + `recordSampleTypes.count` = 2 + 18 = **20 个**（`HealthKitSync.swift:637-642`；`HealthKitExport.swift:1083-1119`、`:1129-1137`：15 个基础 quantity/category + 3 个可选 quantity）。一次冷启动注册 20 个观察者查询，HealthKit 对每个查询的首次投递各回调一次；投递处置见 `SyncDeliveryPolicy.decide`（`BackgroundSyncPolicy.swift:59-97`）。
4. 一旦第一条投递排下 `delay=0` 请求，后续 proposal 单调递增，而 `shouldReplacePendingRequest` 只在严格更早时替换（`BackgroundSyncPolicy.swift:468-471`）⇒ **N 条投递天然产出 N-1 行 keep**，且簇内不会出现 `submit ok`。这与日志形态完全一致，**21 ≈ 20 个观察者 + 1 次其他重排**（强推断，需 Console 定案）。

**结构缺口（可证，非本行日志的错）**：`submitBackgroundRun` 是 `nonisolated` + 异步回调（`AppDelegate.swift:290-322`），“读待发请求 → submit”没有序列化；两次调用若在同一 IPC 往返窗口内进入，可能都读到“无待发请求”而各自 submit，后一次写入会覆盖前一次。R1 的“更早请求不被推后”目前是 best-effort。是否真能并发触发需真机复测。

**建议**

- **P0（本轮就做）**：keep 行按 60 s 窗口聚合，补 `delay=…s`、`existing in …s`、窗口内累计 `n=`。本仓没有 `#if DEBUG` 先例，`[RAI]` 行本身是真机验收判据载体 ⇒ release 也保留「一行/窗口」，不要整行删掉。去重状态需 `nonisolated` + 锁（可抄 `HealthSyncBackgroundRecovery.swift:462-472,531-557` 的既有范式）。
- **P1（可选）**：把同一批投递的在飞 submit 合并（in-flight 标志 + 取最小 `proposed`，首个 submit 的时机不变）。不要用 `probePendingWork` 的 snapshop 做“已有意图就跳过 submit”的去重——一旦某次 submit 抛错，后台会静默停摆。
- **P2（不建议）**：进程内缓存 pending 来省 IPC。收益毫秒级，风险是“后台同步从此不发生且无日志”，且与 `check-background-capabilities.py:2197-2203`（必须查待发请求）正面冲突。
- 门禁：`BackgroundSyncPolicyRegression.swift:834-858` 需新增聚合策略用例；`check-background-capabilities.py:1069-1088` 未钉这行（建议顺手 pin 住新文本）；`check-background-mutations.py:916-951` 的锚点不要动；`AppDelegate.swift` 在 `typecheck-ios.sh` 覆盖范围内，新增静态状态必须显式 `nonisolated`。

**真机验证**：`log stream --device --predicate 'eventMessage CONTAINS "[RAI]"'` 抓全量；看 21 行的时间跨度（秒级=投递风暴）、簇前是否只有一条 `submit ok (delay=0s)`、簇内是否一直没有 `BGProcessingTask launched`。负对照：前台停留 5 分钟不产生新健康数据 ⇒ 期望 0 行 keep。

---

### 2.3 P2 · UI 告警：一处零风险加固、一处可减触发、两条纯噪声

**Swift Charts 告警（已实测触发条件，真机命中点未闭环）**

- 用 `/tmp/chartprobe` 最小 App 在 iPhone 17 Pro / iOS 26.5 / Charts 4.4.4 上跑了 12 个 variant（必须 `simctl launch --console-pty` 才能看到 Charts 的 stderr；`--console` 不转发）。**只有把 `chartOverlay`/`chartBackground` 挂到完全不含 Chart 的子树时才打印**；`Chart{}.frame(height:).chartOverlay`（`TechSeriesChart.swift:152-153` 的现写法）、`Chart{}.chartBackground.frame()`（`TechViews.swift:566-574`）、完整轴 + frame + overlay 复刻、ScrollView 包裹、空 Chart、全零 SectorMark **全部静默**。
- 结论：仓库两处按 26.5 语义**不触发**；真机告警可能来自 26.0–26.4 的严格判定、运行时 chart 子树瞬时缺失，或**根本不是本 App 进程**（你贴的日志混有系统进程输出；Console 需看 `Process` 列）。Pods 已 grep 排除第三方用法。
- 建议（2 分钟、零行为风险）：把 `TechSeriesChart.swift:141-162` 的 `.frame(height:)` 挪到 `.chartOverlay` 之后（overlay 直接挂 Chart、frame 最后）；`TechViews.swift` 已是对的，保持并加一行顺序注释。真机进训练详情展开图表复测：若该行消失则闭环；若仍出现，**停止顺序类修改**，改用一次性 `os_log` 确认是不是“运行时瞬时无 chart”，不要为此重构。

**键盘 / 场景类告警（系统层消息；App 侧有可疑放大器，需 A/B 证实）**

- 这类文本来自系统键盘/无障碍跟踪层（UIKit/TextInput）。本次复测中，启动一个没有任何 `FocusState`/toolbar/TextField 的最小 App 并抓 6 秒日志**没有复现**（`/tmp/kbd-probe.log` 仅 3 行、全是 log stream 头）——所以“纯系统噪声”目前只是**高置信推断**，不是实测结论；反过来，“应用侧触发”同样没有被直接证实。日志分诊时应带进程列（`log stream --style compact` 默认输出进程名），先确认行来自 `RAI` 还是 `SpringBoard`/`AccessibilityUIServer`。
- App 侧可证的可疑触发面：`TechKeyboardDismiss`（`TechLayout.swift:118-133`）里的 `.toolbar { ToolbarItemGroup(placement: .keyboard) … }` 被 `TechSetupView.swift:86`（未连接服务器时的**启动首屏**）、`TechViews.swift:2281`（设置根页）、`:2298`（设置详情页）**无条件安装**。`ToolbarItemGroup(placement: .keyboard)` 会在没有焦点时也参与键盘工具栏基础设施的建立，是“无键盘却收到键盘通知 / 去取键盘 scene”的合理触发面；`FocusState` 仅在用户点按时聚焦（`TechSetupView.swift:10-54`），这一点没问题。
- 建议（A/B 验证，不强承诺清零）：给 `TechKeyboardDismiss` 增加条件参数（如 `showsKeyboardToolbar`），只在真正需要「完成输入」的数字键盘页安装 toolbar（`TechManualPlanView`、`TechRunCoachSetup`、`TechRaceGoalEditor`、`TechCoachLoopSection`）；`TechSetupView`/设置页只保留 `.scrollDismissesKeyboard`（URL/令牌键盘本身有 Return 键）。验收：冷启动首屏告警行是否减少/消失（同时看进程列）；数字键盘「完成输入」仍可用（`keyboard.done` 无障碍标识回归）。若带条件后仍出现且进程列是系统进程 ⇒ 归为系统噪声，不再改。

**纯噪声，不改**

- `non-launching port is incompatible … PointerUI.pointeruid.default-service`：实测 SpringBoard 自身打印同类 PointerUI scene 错误；对用户可见行为零影响。
- `cannot add handler to 0 from 0 - dropping`：仓库无 HID/事件 handler 注册、`Info.plist` 无 scene/方向/指针配置、Pods 无相关用法；26.5 对照实验未复现。中置信系统噪声。
- `No scene exists for identity: com.apple.InputUI.keyboard…`：InputUI 键盘 UI 进程场景尚未建立，硬件键盘/模拟器下更常见；App 不可控。

---

### 2.4 P2 · 高德 SDK：启动时机、nehelper 刷屏与 ALC 本地日志

**事实**

1. `AppModel.init` 在**冷启动**就调用 `MapPrivacy.configureIfAgreed()`（`RAIApp.swift:17-21`）；用户已同意（state=agreed）时立即初始化 AMapFoundation（`MapPrivacy.swift:37-40,58-74`），**不依赖是否进入路线页**。`MAMapView` 本身只在路线页/分享卡片真正显示时创建（`TechRouteView.swift:73-74,229,236-237,537-542`）。隐私门控顺序正确（`updatePrivacyShow/updatePrivacyAgree` 均在任何 `MAMapView` 之前）。
2. 22 条 `nehelper` 不是 Wi-Fi 定位：仓库只有 `AMap3DMap`/`AMapFoundation`（无 `AMapLocation`），无定位权限；静态库符号与反汇编确认来源是 `-[AMapStatistics fetchSSIDInfo]` → `CNCopyCurrentNetworkInfo`（`wifiname`/`wifi` 统计字段）。没有 Access WiFi Information entitlement（`RAI.entitlements` 仅 HealthKit）且无定位授权 ⇒ 每次调用必然被 nehelper 拒绝。
3. `[alc-inner]`/`QA_SETTING`/`UPLOADER` 全部来自 `MAMapKit` 的 ALC 日志子系统，落盘 `Documents/amap/600log`（`debug_setting.cfg`/`tra.cfg`/`debugCfg`），上传端点含 `https://m5-x.amap.com/ws/shield/alc/collect`。Debug/Release 用同一份 vendored 静态库。
4. `AMap3DMap 11.2.100` 提供公开开关：`+[MAMapView setAlcLogConfig:recordStorage:]`（`MAMapView.h:706-715`，since 11.2.100，必须在任何 `MAMapView` 实例化之前调用），`recordStorage:NO` 可不写 ALC 本地 storage。`AMapServices.analysisAgree` 默认 YES，但反汇编显示它只影响上报字段，**不能证明能阻止 SSID 采集**，不要承诺。

**建议**

1. **懒初始化**：把 `MapPrivacy.configureIfAgreed()` 从 `AppModel.init` 移到路线页建图前（`RouteMapContainer` 在创建 `MAMapView` 前补一次；分享卡片 `TechRouteView.swift:541` 已有），保持 `updatePrivacyShow/updatePrivacyAgree` 在任何 `MAMapView` 之前的顺序。收益：冷启动不再初始化 Foundation（减少统计/SSID 采集与 Foundation 日志上传器），未进路线页的会话不再有 nehelper/ALC 噪声。
2. **关闭 ALC 本地写入**：在 `MapPrivacy.configure()` 最前面调用 `MAMapView.setAlcLogConfig(MAALCLogLevelFatal, recordStorage: false)`（Swift 桥接写法见头文件），必须早于任何 `MAMapView`。真机（最好 Release）验证 `Documents/amap` 是否停止增长。
3. **不要**为消日志加 `com.apple.developer.networking.wifi-info` 或定位权限——仓库没有定位功能，为第三方统计申请定位是隐私倒退；也不建议引入 AMapLocation。
4. 可选（产品决策）：路线底图 + 分享卡片之外并无在线地图需求，若中文地名/道路标注非硬需求，可评估移除 AMap（离线轨迹 + GCJ02 换算仍可用），彻底消除 nehelper/ALC 与静态库体积。

---

### 2.5 P3 · 结构观察项（本轮只记录，不修改）

1. **提交层重导循环风险**：游标只在 `markSuccess → commitSuccess` 提交（`HealthKitSync.swift:2431`）；`.abandonBatch` 只删本地产物、不清任务行（`:3119-3126`、`:3459-3467`）。若服务端持续给出确定性拒绝（400/409/413/415 等，`SyncPhase.swift:242-262`），下一轮会用 committed 游标重读同一段历史：每轮 ~12000 条 anchor 白读 + 白传。生产实测 43 批/192,500 条中新增仅 8,117（≈95.8% 重复，`HealthKitRecordCursor.swift:460-464`）。**判别**：日志里反复出现总量相同（11767/233 这类）的满批 + upload/inspect 失败，才是这个形态；本段日志没有失败行，暂不成立。
2. **`submitBackgroundRun` 读→提交未序列化**（§2.2）：只有在做 in-flight 合并时一并修，并补聚合策略回归。
3. **`historySkipped=0` 与覆盖探测**是开关关闭的结构结果（§2.1），不是“服务端无覆盖”；不要为提速打开 `allowsHistorySkip`（它证明不了区间连续，会引入永久缺失）。
4. **空窗不推进 `recentWindowReadAt`**（`HealthKitExport.swift:1978-1991`、`HealthKitRecordCursor.swift:320-355`）是 2026-10-14“迟到样本永久缺失”事故的防复发通道，不要加“空窗跳过 N 批”的降频。
5. **`replay=1` 不是卡死证据**：类型轮转保证同一类型不会连续两批吃满预算（`HealthKitExport.swift:2028-2039`），聚合计数看不到单类型进展；要判断卡死必须补逐类型日志（§2.1 建议 3）。

---

## 3. 不建议做的事（避免过度优化）

- 不要为 `nehelper` 加 Wi-Fi entitlement / 定位权限，也不要引入 AMapLocation。
- 不要删掉 `BGTaskScheduler.keep` 行或把 `[RAI]` 诊断整体 `#if DEBUG` 掉（仓内零先例，且真机验收依赖这些行）；聚合即可。
- 不要用 `#if DEBUG` 或降低日志级别来“让日志变干净”——问题在重复调用，不在级别。
- 不要为省 `getPendingTaskRequests` 的 IPC 做进程内 pending 缓存；不要用“意图已存在”跳过 submit。
- 不要为了“让历史重放快点结束”缩小 48h 窗口份额、给空窗降频，或打开 coverage skip：这三条都会重新打开数据完整性缺口。
- 不要因为真机 Charts 告警就在两处反复重构；本仓库两处按 26.5 语义不触发，先做顺序加固 + 进程归因，再决定。
- 不要把 `types=5` 解读成“只有 5 类健康数据”——它只是窗口通道的类型数（§2.1）。

---

## 4. 真机复测与验收

**日志抓取**

```bash
# 全量 [RAI]（含 BGTask/同步诊断）
log stream --device --predicate 'eventMessage CONTAINS "[RAI]"'
# 按告警类别过滤
log stream --device --predicate 'eventMessage CONTAINS "Charts:"'
log stream --device --predicate 'eventMessage CONTAINS "nehelper" OR eventMessage CONTAINS "alc-inner"'
```

**场景与期望**

| 场景 | 期望（改前） | 期望（改后） |
|---|---|---|
| 冷启动、不打开路线页、停留 2 分钟 | ~20 行 `keep`；22 行 `nehelper` 视是否初始化 SDK | `keep` 聚合为 1 行/60 s（含 `n=`）；不初始化 SDK 时 nehelper/alc 显著减少 |
| 进训练详情、展开指标图 | `Charts:` 可能 1 行 | 若来自 `TechSeriesChart` 应消失；若仍在，记录 `Process` 列判断归属 |
| 冷启动到首屏（未连接） | keyboard will change/hide 各 1~2 行 | 应减少（数字键盘页仍保留「完成输入」） |
| 打开路线详情 | `[alc-inner]` 段 + nehelper 若干 | `Documents/amap` 不再新增 ALC storage；`alc-inner` 可能部分保留（头文件只保证本地 storage） |
| 连续两次同步 | 两行计数，总量各 12000 | 两行分别带 `source=batch`；`types`/`anchorTypes` 可区分 |

**负对照**：前台停留 5 分钟不产生新健康数据 ⇒ 不应新增 `keep`；反复前后台切换 5 次 ⇒ 期望 ~5 行、且每次与一次前台激活成对，而不是连续 20 行。

---

## 5. 证据索引

- BGTask 日志与调用面：`apps/ios/RAI/AppDelegate.swift:63-87`、`:129-194`、`:290-322`、`:359-365`、`:416-436`、`:452-466`；`apps/ios/RAI/BackgroundSyncPolicy.swift:59-97`、`:110-194`、`:404-471`
- 观察者注册与类型：`apps/ios/RAI/HealthKitSync.swift:628-686`；`apps/ios/RAI/HealthKitExport.swift:1083-1119`、`:1129-1137`
- 通道计数：`apps/ios/RAI/SyncTaskState.swift:14-64`；`apps/ios/RAI/HealthKitSync.swift:1310-1316`、`:1895-1897`、`:2561-2563`；`apps/ios/RAI/HealthKitExport.swift:1702-1705`、`:1845-1859`、`:1970-1974`、`:2128`、`:2185-2199`、`:2292`
- 预算与重放状态机：`apps/ios/RAI/DirectSyncBatchBudget.swift:41-46`、`:60-83`；`apps/ios/RAI/HealthKitRecordCursor.swift:104-106`、`:172-184`、`:284-305`、`:489-514`、`:537-550`；`apps/ios/RAI/HealthKitExport.swift:1928-1944`、`:1978-1991`、`:2000-2027`、`:2145-2151`
- UI：`apps/ios/RAI/Skins/Technology/TechSeriesChart.swift:141-162`；`TechViews.swift:566-574`；`TechLayout.swift:118-133`；`TechSetupView.swift:86`；`TechViews.swift:2281`、`:2298`
- 高德：`apps/ios/RAI/RAIApp.swift:17-29`；`apps/ios/RAI/MapPrivacy.swift:37-74`；`apps/ios/RAI/Skins/Technology/TechRouteView.swift:73-74,229,236-237,537-542`；`apps/ios/Pods/AMap3DMap/MAMapKit.framework/Headers/MAMapView.h:706-715`；`apps/ios/RAI/RAI.entitlements:5-10`
- 门禁/回归：`apps/ios/tests/BackgroundSyncPolicyRegression.swift:834-858`；`apps/ios/tests/SyncTaskMigrationRegression.swift:331-390`；`apps/ios/tests/check-background-capabilities.py:1069-1088`、`:2197-2203`；`apps/ios/tests/check-background-mutations.py:916-951`；`apps/ios/tests/typecheck-ios.sh:98-104`
- 并行分析笔记（只读、位于 gitignore 的 `output/log-triage/`）：`bg-scheduler.md`、`health-export.md`、`ui-noise.md`、`amap-noise.md`
