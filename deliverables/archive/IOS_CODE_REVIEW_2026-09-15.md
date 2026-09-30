# iOS App 端代码审查报告（apps/ios）

- **日期**：2026-09-15
- **审查范围**：`apps/ios` 全部 46 个 Swift 文件（约 16,000 行），基线 HEAD `f588e0a`
- **方法**：三路并行深审（数据同步链路 / 课表映射 / UI+地图），所有 🔴 与关键 🟡 均经原文逐条复核（`文件:行号` 可直接定位）
- **本文档状态**：**已含修复闭环**。原审查结论全部保留（撤回项就地标注），每条附"修复状态 + 验收证据"。

> ⚠️ **撤回说明（重要）**：初版 🔴-1「删除墓碑与 sourceIds 身份体系不一致」经逐行复核**不成立，已撤回**。
> 依据见下方 🔴-1 节，我据此回滚了为它写的一整条 `WorkoutIdentityMap` 机制（约 80 行）。
> 保留这条记录是因为**误报本身有信息量**：它差点让一份没必要的持久化映射进主分支。

---

## 修复状态总表

| 编号 | 问题 | 状态 | 落点 |
|------|------|------|------|
| 🔴-1 | 墓碑身份体系分裂 | ⛔ **误报，已撤回** | 无需修改 |
| 🔴-2 | 回读内容相等匹配 → `verified` 虚高 | ✅ 已修 | `WorkoutKitBridge.swift` 回读改**消费一次** |
| 🟡-1 | 读授权无 `.restricted` 处理 | ✅ 已修 | `HealthKitReadAuthorization` + 拒绝报"同步 0 条" |
| 🟡-2 | `Calendar` 宽松语义折算 `02-30` | ✅ 已修 | 回读 components round-trip 校验 |
| 🟡-3 | 全 open 步日丢弃 → 回执集合错位 | ✅ 已修 | 回执集合改为**桥接层回读结果** |
| 🟡-4 | 空周 `removeAllWorkouts()` 无回读 | ✅ 已修 | 清空后回读、`verified = remaining == 0` |
| 🟡-5 | `deleteUpload` 吞错累积孤儿 | ✅ 已修 | 返回 `Bool`（404 视为成功）+ 提示后缀 |
| 🟡-6 | `waitForJob` 把 4xx 也当可重试 | ✅ 已修 | 4xx 立即失败 |
| 🟡-7 | `refreshAll` 全有全无 + 覆盖陈旧缓存 | ✅ 已修 | 逐面板容错，**不再回退缓存** |
| 🟡-8 | `recordPlanSync` 无取消/换服守卫 | ✅ 已修 | 循环内 `isCurrent()`，剩余日计为失败 |
| 🟡-9 | `SyncTaskStore` 静默 no-op | ✅ 已修 | `isAvailable` + `sqlite3_step` 返回码检查 |
| 🟡-10 | 目标编辑器两皮肤整段复制 | ✅ 已修 | 规则下沉 `NativeGoalWeekDraft` |
| 🟡-11 | 时区回退静默 | ✅ 已修 | `timeZoneFallback` + `report` |
| 🔡 ×9 | 见文末清单 | ✅ 已修 8 项 / 1 项判为无需修 | — |

外部审计 `deliverables/BACKEND_IOS_REVIEW_2026-09-15-R2.md` 的 P1-D / P1-E / P1-F 与本轮重叠，已一并闭合（详见"跨报告闭合"节）。

---

## 🔴 高危

### ⛔ 🔴-1（撤回）删除墓碑与 sourceIds 身份体系不一致 → 该删不删

**原判据**：`HealthKitExport.swift:151` 的 `deletedSourceIds` 用裸 UUID，而 `sourceIds` 走 `workoutSyncId`（优先 `HKMetadataKeySyncIdentifier`），推测墓碑匹配会对不上。

**实测结论：不成立。** 后端墓碑匹配器**四路并行匹配**，同时认两个键：

```sql
-- packages/storage-sqlite/src/database.ts:2342-2365
WHERE EXISTS (... json_extract(metadata_json, '$.HKMetadataKeySyncIdentifier') ...)
   OR EXISTS (... json_extract(metadata_json, '$.RAIHealthKitWorkoutUUID') ...)
   OR EXISTS (... json_extract(raw_attributes_json, '$.HKMetadataKeySyncIdentifier') ...)
   OR EXISTS (... json_extract(raw_attributes_json, '$.RAIHealthKitWorkoutUUID') ...)
```

而导出侧**每条训练都写入 `RAIHealthKitWorkoutUUID`**：

```swift
// apps/ios/RAI/HealthKitExport.swift:319
body += "    <MetadataEntry key=\"RAIHealthKitWorkoutUUID\" value=\"\(escape(workout.uuid.uuidString))\"/>\n"
```

`HKDeletedObject` 只带 UUID —— 那正是 `RAIHealthKitWorkoutUUID` 的值。解析侧同样双键读取（`packages/health-export-parser/src/apple-health-parser.ts:420`），且有专门回归 `packages/health-export-parser/test/tombstone-deletion.test.ts:175` 对两个键各跑一遍。

⇒ **裸 UUID 墓碑能正确命中**。原方案要求的 `uuid → SyncIdentifier` 持久化映射是**纯粹的额外复杂度**，已整体回滚。

### 🔴-2 排期回读用内容相等匹配 → 同周重复课表时 verified 虚高

- 原代码 `WorkoutKitBridge.swift:156-159`：`listed.contains { $0.plan.workout == .custom(item.custom) }`
- `CustomWorkout` 相等**只比内容**（`displayName` = 标题+距离），**不含日期**。两个 `RAI · 轻松跑 8.0km` 会让**一条** listed 记录同时确认**两个** pending。
- `WorkoutScheduler.schedule(_:at:)` 是 `async` 但**非抛错**，静默失败与成功无法区分 —— 回读是本文件唯一的信任机制，被击穿即整条链路不可信。

**修法（已实施）**：回读改为**消费一次** —— `firstIndex(of:)` + `remove(at:)`：

```swift
// apps/ios/RAI/WorkoutKitBridge.swift
if let index = listed.firstIndex(where: { $0.plan.workout == .custom(item.custom) }) {
    listed.remove(at: index)          // 一条 listed 只能确认一天
    confirmed += 1
}
```

**验收**：`syncedLocalDates` 由回读结果产生（`SyncOutcome.scheduledLocalDates`），排期后逐日校验，重复内容日不再互相顶替。

---

## 🟡 应修（可靠性 / 健壮性）

| # | 原位置（基线） | 问题 | 修复落点 |
|---|------|------|----------|
| 🟡-1 | `HealthKitExport.swift:859-864` | 读授权只有事后错误推断，**无 `.restricted`**；受限用户查询静默返回空 → "成功同步 0 条"假象 | 新增 `HealthKitReadAuthorization`（`.unavailable/.notDetermined/.decided`）+ `readAuthorizationState(requestingIfNeeded:)`；`.notDetermined` 抛 `authorizationUndecided`，**拒绝把"没授权"报成"同步了 0 条"** |
| 🟡-2 | `WorkoutPlanMapper.swift:110-123` | 日期只校验 `(1...31)`，`Calendar.date(from:)` 把 `02-30` 折算到 3 月 | `scheduleComponents` 加回读校验：`dateComponents([.year,.month,.day])` 必须与输入全等，否则 `nil`；迟到路径同时钉 `second = 0` |
| 🟡-3 | `WorkoutPlanMapper.swift:78-84` + `NativeAppModel.swift:567` | 回执集合按 `plannedWorkout != nil` 反推，与"实际上表集合"脱节 | `recordPlanSync(_:localDates:)` 改收**桥接层回读集合** `outcome.scheduledLocalDates` |
| 🟡-4 | `WorkoutKitBridge.swift:132-135` | 空周清空无回读，失败时旧处方留表而 UI 报成功 | 清空后读回 `scheduledWorkouts`，置 `verified = remaining == 0` |
| 🟡-5 | `HealthKitSync.swift:536` | `deleteUpload` 用 `_ = try?` 吞掉全部错误 | 返回 `Bool`（**404 = 成功**，重复删除不是故障），`cleanupNoteSuffix` 追加到提示 |
| 🟡-6 | `HealthKitSync.swift:565-571` | `waitForJob` 用 `?? true` 把 401/404 也当可重试，满 30 分钟才报错 | 按状态码分流：4xx（除 429）立即判定失败 |
| 🟡-7 | `NativeAppModel.swift:157-188` | 四个 `async let` 全有全无；任一抛错 → 三个成功结果被丢 + `loadCachedData()` 覆盖回陈旧缓存 | `try?` 逐面板容错；失败面板**保持原值**，成功面板照常落缓存；**删掉此处 `loadCachedData()`**；`errorMessage` 区分"全部失败"与"N 项未能更新" |
| 🟡-8 | `NativeAppModel.swift:572-587` | 收据上报循环无取消/配置守卫 | 循环内 `isCurrent()`（含 `!Task.isCancelled` + `cacheScope`）；中断时**剩余日期计入失败**，避免"整周已登记"的假象 |
| 🟡-9 | `SyncTaskStore.swift:22-26, 75` | 打开失败后静默 no-op，断点续传无声失效 | `isAvailable` 标志 + `sqlite3_step` 返回码检查 + `report()` 经 `NSLog`；FileProtection 扩展到 `-wal`/`-shm` |
| 🟡-10 | `NativeViews.swift:1519-1944` vs `TechViews.swift:1455-1913` | `distanceDrafts`/`areDistancesValid`/保存序列化（含"kind 或距离变了就清 structure"）**两皮肤整段复制** | 新增 `enum NativeGoalWeekDraft`（`NativeAppModel.swift`）：`parsedDistance` / `weeklyDistanceIsValid` / `dayDistanceIsValid` / `drafts(from:)` / `distancesAreValid(_:for:)` / `normalized(_:drafts:loaded:)`。两皮肤只留视觉 |
| 🟡-11 | `WorkoutKitBridge.swift:129` | `plan.timezone` 非法时静默回退设备时区 | `SyncOutcome.timeZoneFallback` + `report` 追加"（课表未带时区，已按手机当前时区排期）" |

### 同根清理：跨皮肤重复的业务判据

审计期间确认两皮肤另有两条被复制的共享规则，一并下沉（均落在 `WorkoutPlanMapper`）：

| 项 | 原状 | 现状 |
|----|------|------|
| 周条状态词 | 两皮肤各自 4 分支（`NativeViews.swift:1956-1961` ≈ `TechViews.swift:1923-1928`） | `WorkoutPlanMapper.weekStripStatus(completed:isRest:isToday:)`，两处生产调用（`NativeViews.swift:1967` / `TechViews.swift:1936`） |
| "可上表天数" | 面板数服务端 `executable` 标志 | `WorkoutPlanMapper.schedulableCount(in:)` —— 与桥接层**同一判据**；两处生产调用 |

> `executable` 是**更松**的问题：一个 `executable: true` 但结构缺失/步骤无目标的日子仍过不了映射。旧代码会出现「面板写 5 项可上表，手表只收到 4 项」。现在两处 `watchPlanPanel` 还额外列出**具体哪几天不会上表及原因**。

---

## 🔡 次要（打磨项）

| 项 | 原状 | 现状 |
|----|------|------|
| `HealthKitExport.swift:783-784` `value as? Bool` 死分支 | 不可达 | ✅ 删除 |
| `WorkoutPlanMapper.swift:258-261` `maxAlertValue=1800` pace/心率共用 | pace 截断会**变相加速处方** | ✅ 拆为 `maxPaceSecondsPerKm = 1800`（**丢弃**，绝不截断）与 `maxHeartRateBpm = 240`（截断无损）；`paceBound`/`heartRateBound` 两条独立路径 |
| `HealthKitSync.swift:298, 438` `lastWorkoutCount ?? 0` 可能持久化 0 | 恢复路径把计数清零 | ✅ `markSuccess(recordWorkoutCount:)`，恢复任务不再覆盖计数 |
| `ServerDiscovery.swift:57` IPv6 带接口名拼 URL 返回 nil | 候选静默丢弃 | ✅ `nonisolated static httpURL(host:port:)` 走 `URLComponents` |
| `HealthKitExport.swift:890-896` XML 转义不滤控制字符 | 非法 XML 1.0 字符进产物 | ✅ `escape` 过滤控制字符 |
| `AppWebView.swift:365-386, 482-488` safe-area CSS 三份 | 复制 | ✅ 抽 `iosShellJavaScript(chromeTop:)` |
| `MapPrivacy.swift:67` 发布版 `print` | 诊断进 stdout | ✅ 改 `NSLog` |
| `StoredZip.swift:99-162` vs `:347-368` 两套 ZIP 写入、flag 不一致 | `0` vs `0x0800` | ✅ 删除未被调用的 `write(entries:)` 及其孤立 `deflate`/`crc32`（-113 行）；保留唯一实现（`0x0800` = UTF-8） |
| 回归缺口（Feb-30、重复内容日、全 open 步日、hour/minute 钳位） | 未覆盖 | ✅ 全部补齐（见下） |

---

## 已验证正确的关键判据

| 判据 | 结论 |
|------|------|
| Bearer 鉴权走 header 不走 query | ✅ `APIClient.swift:266`、`HealthKitSync.swift:607`；redirect 跨域掐断（`APIClient.swift:13-16`） |
| toShare 为空（只读授权） | ✅ `HealthKitExport.swift:85` |
| WorkoutKit 授权四态含 `.restricted` | ✅ `WorkoutKitBridge.swift:80-88, 51-61`，denied 未当 unsupported |
| WGS-84 存储、渲染层才转 GCJ02 | ✅ GPX 直写原始坐标（`HealthKitExport.swift:719`）；`CoordinateConversion.swift` 数学与标准算法一致且 `nonisolated` |
| 隐私同意前零 SDK 初始化 | ✅ `MapPrivacy.swift:37-46`；全仓唯一 `MAMapView()` 在 `TechRouteView.swift:131` 且受同意态门控 |
| 高德 Key 不入库 | ✅ `MapPrivacy.swift:65` 从 Info.plist 读（xcconfig 链路） |
| lap vs segment 事件类别 | ✅ `HealthKitExport.swift:410-412/350`，diag 带 `typeRaw` 可消歧 |
| pace→speed 反演方向 | ✅ `WorkoutPlanMapper.swift:143-156`，有注释与测试背书 |
| 内存/泄漏 | ✅ RouteMapContainer 重试 `[weak self]`、WebCoordinator 弱引用、dismantleUIView 移除 handler，无 Timer/NotificationCenter 泄漏点 |

---

## 验收证据

**两条通道（职责不同，缺一不可）**

```
bash apps/ios/tests/run-model-tests.sh   → EXIT=0   143 断言通过 / 0 失败
bash apps/ios/tests/typecheck-ios.sh     → EXIT=0   36 文件 / 0 error / 0 warning
```

- `run-model-tests.sh`：纯逻辑（`--disable-sandbox` 必需，否则 `@Observable` 全报 malformed）
- `typecheck-ios.sh`：唯一能编到 `WorkoutKitBridge`（需 iOS SDK）与两皮肤视图的通道

**突变验证（7/7 全部被捕获，文件恢复后 sha256 一致）**

| 突变 | 破的规则 | 被哪条断言抓住 |
|------|----------|----------------|
| M1 | 删掉日期 round-trip 校验 | `a day the calendar would roll forward is refused` |
| M2 | `weekStripStatus` 前后分支对调 | `completion outranks rest` |
| M3 | `schedulableCount` 退回 `\.executable` | `an executable day whose prescription was not built is not counted as offerable` |
| M4 | `unofferedDays` 判据取反 | `only the broken training day is unoffered, never the rest day` |
| M5 | pace 越界改为截断 | `an impossible pace bound is dropped, the usable one is kept` |
| M6 | 去掉心率上限截断 | `an impossible heart-rate ceiling is clamped to what a human reaches` |
| M7 | 回执集合改回按映射器反推 | `only the day the bridge reported back is registered as a receipt` |

> M3 值得单独说明：**原定夹具抓不住它** —— 原 `plan` 里 `executable` 计数恰好等于可映射计数（都是 2）。补了 `flagOnButBroken`（服务端标 `executable: true` 但结构缺失）才让两个判据真正分离。这是"夹具恰好同构 ⇒ 突变漏检"的实例。

**新增断言位置**

- `tests/WorkoutPlanMapperRegression.swift`：`schedulableCount` / `eligibility`（4 态）/ `unofferedDays` / pace-drop vs HR-clamp / `02-30` 与 `2026-02-29` 非闰日 / `2028-02-29` 真闰日 / `weekStripStatus`（5 例）
- `tests/ModelRegression.swift`：收据集合跟随桥接（4 例，含空集与越界日期）/ `NativeGoalWeekDraft`（17 例，含 kind 变、距离变、清空三条 structure 失效路径）

---

## 跨报告闭合（对 `BACKEND_IOS_REVIEW_2026-09-15-R2.md`）

| R2 编号 | 结论 | 闭环方式 |
|---------|------|----------|
| P1-D | 回执集合 ⊇ 实际上表集合 | `recordPlanSync(_:localDates:)` 改收桥接回读集；`ModelRegression` 4 例钉住 |
| P1-E | 全映射失败误报"本周没有可同步的训练" | `SyncOutcome.offered` + `attempted == 0` 分流为两句话 |
| P1-F | "已完成标注"共享分类器生产零调用 | `inactiveLabel` 经 `unofferedDays` 取得 **2 处生产调用**；`weekStripStatus` 另下沉 2 处 |

---

## 剩余风险（需真机）

1. `WorkoutScheduler` 回读行为、授权弹窗流程**未做运行时验证** —— 本轮只到编译级与纯逻辑级。M7 钉住的是"集合怎么算"，不是"系统是否照做"。
2. 🔴-2 的消费一次匹配逻辑正确性靠代码审查 + 纯逻辑断言；真机上"两个内容相同日 + 一个静默失败"的用例尚未构造。
3. 本文档所述修复**尚未提交**（截至撰写时），工作区快照见 `/tmp/rai-ios-fixes/`。
