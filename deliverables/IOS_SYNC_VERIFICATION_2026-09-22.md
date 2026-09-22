# iOS 同步逻辑核实报告

日期：2026-09-22 · 范围：`apps/ios`（只读核实，未改动任何代码）
方法：源码逐行核对 + `git log -S/-G` 追溯引入点 + 全仓 grep 反证（含负证据）

> 🔴 **本报告是"修复前"的快照，不是当前代码的描述。**
> 同日稍晚已按小唐授权落地 P0 止血（判据抽成纯函数 `apps/ios/RAI/HealthSyncLifecycle.swift`；
> `RAIApp.swift` 切后台改调 `handleEnterBackground()`；后台额度到期改走 `suspendForLifecycle()`）。
> 因此 §二~§三 里凡是"`.background` 立即 `cancelSync()` / 窗口可用时间 ≈ 0 / 这条路径零测试覆盖"的表述，
> **描述的是本报告核查当时的状态**。当前状态与判据契约见
> `apps/ios/RAI/HealthSyncLifecycle.swift` 文件头 + `apps/ios/tests/HealthSyncLifecycleRegression.swift`
> + `NOTES-ios.md`「同步的后台语义」章（已就地更正）。
> 一处结论性错误也已同批更正：§3.3-2 关于 `waitsForConnectivity` 的"语义重叠"判断（详见该条）。

## 一、五问速答

| # | 问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 是否调用 `beginBackgroundTask` | ✅ 调用，**覆盖整条 `performSync`**（不只上传） | `HealthKitSync.swift:141-146`、`147-153` |
| 2 | `.background` 是否立即 `cancelSync()` | ✅ 是，且**仅** `.background` 触发 | `RAIApp.swift:65-80`（第 75-77 行） |
| 3 | 两者是否冲突 | 🔴 **是。后台窗口一开就被自己关掉** | 见 §三 |
| 4 | 上传实现 / 配置类型 / identifier | `session.upload(for:request:fromFile:)`；`URLSessionConfiguration.ephemeral`；**无 identifier** | `HealthKitSync.swift:619-642`、`57-64` |
| 5 | 是否已用后台 URLSession | ❌ **零使用**，配套能力也全部缺失 | 全仓 grep 见 §五 |

---

## 二、逐项核实

### 1. `beginBackgroundTask` 的调用、用途与覆盖范围

调用点 `apps/ios/RAI/HealthKitSync.swift`：

```swift
139  let previousIdleTimerState = UIApplication.shared.isIdleTimerDisabled
140  UIApplication.shared.isIdleTimerDisabled = true
141  var backgroundTask = UIBackgroundTaskIdentifier.invalid
142  backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "rai-health-sync") {
143      self.cancelSync()
144      UIApplication.shared.endBackgroundTask(backgroundTask)
145      backgroundTask = .invalid
146  }
147  defer {
148      isBusy = false
149      UIApplication.shared.isIdleTimerDisabled = previousIdleTimerState
150      if backgroundTask != .invalid {
151          UIApplication.shared.endBackgroundTask(backgroundTask)
152      }
153  }
```

- **位置**：在 `performSync` 内部，`isBusy = true` 之后、`api.handshake`（159）**之前**。
- **用途（按代码意图）**：两件事被并列写在一起——
  - `isIdleTimerDisabled = true`（140）：屏幕不自动熄，defer 里还原。这只与**屏幕**有关，不是后台执行。
  - `beginBackgroundTask`（142）：申请切后台后的**续期窗口**，目的是让"用户切走时在飞的工作"能跑完。
- **覆盖范围 = 整个 `performSync`**。即：handshake → 恢复分支（183/258）→ HealthKit 授权检查（326）→ HealthKit 导出（410-421）→ multipart 构造 → upload（638）→ inspect（644）→ startImport（657）→ `waitForJob` 轮询（725-775，上限 **30 分钟**）。**它不是"只为上传"申请的。**
- **结束点**：`defer`（147-153）无条件收尾。expiration handler 里则先 `cancelSync()` 再 `endBackgroundTask`。
- **额度现实**：iOS 13+ 的 `beginBackgroundTask` 约 **30 秒**（更早版本 180s），且只是"续期"，不能让 App 长期驻留。所以它本来就撑不住上面的 30 分钟轮询。

### 2. `.background` → `cancelSync()` 的触发条件与关联

`apps/ios/RAI/RAIApp.swift:65-80`：

```swift
65  .onChange(of: scenePhase) { _, phase in
66      if phase == .active {
67          model.discovery.start()
68          Task { await model.healthSync.syncIfNeeded(...) }
74      } else {
75          if phase == .background {
76              model.healthSync.cancelSync()
77          }
78          model.discovery.stop()
79      }
80  }
```

- **触发条件**：`scenePhase == .background`，**且仅此**。`.inactive` 已不再取消。
- **引入与收窄历史**（`git log -G` 实测）：
  - `6a8e0c3`（2026-09-09，"add resilient HealthKit sync lifecycle"）首次加入 `else { cancelSync() }` —— 当时**任何非 active** 都会取消。
  - `4801c2e`（2026-09-10，"remove unusable background sync"）删除了 `BGProcessingTask` 注册 + `scheduleHealthSync()` + Info.plist 里的 identifier，**但没有动 `beginBackgroundTask`**。
  - `c83e7eb`（2026-09-17）把条件从"非 active"收窄为"仅 `.background`"，commit message 原文：
    > "Health sync can be cancelled by a background transition without publishing a late result"
- **"解锁"关联：不存在。** 全仓无 `protectedDataWillBecomeUnavailable` / `willResignActive` 绑定。绑定的是 **SwiftUI `scenePhase`**。`isIdleTimerDisabled` 只关屏幕，与"解锁"无关。**请把方案里"解锁/切后台的关联"这一前提修正掉。**
- **取消链路**：`cancelSync()`（81-84）→ `guard syncOwner.cancel() || isBusy` → `HealthSyncTaskOwner.cancel()`（`HealthSyncCancellation.swift:161-165`）→ `task.cancel()`。同一个 task handle 也被 UI 按钮与 App Intent 取消复用（单飞语义）。
  - ⚠️ 注意 `|| isBusy`：即使 owner 里已无 task，只要 `isBusy` 为真也会走 `finishCancelled()`，把 `phase` 置成 `"cancelled"`。
- 🔴 **这条路径没有任何测试覆盖**：`apps/ios/tests/` 全目录 grep `RAIApp|scenePhase` → **零命中**。

### 3. 冲突判定

🔴 **成立，且是实质性冲突，不是理论问题。** 完整时序：

1. 前台同步进行中，`performSync` 持有 `backgroundTask`（141-146）。
2. 用户切后台 → SwiftUI `scenePhase` 变 `.background` → `RAIApp.swift:76` 调 `cancelSync()`。
3. `cancelSync()` 取消**同一个** `Task`（`HealthSyncTaskOwner` 里的 worker）。
4. Swift 的 async URLSession API（`session.upload` / `session.data`）**随 Task 取消而取消**底层 `URLSessionTask` → 抛 `URLError(.cancelled)`。
5. `handleCancellation`（527-534）命中 → `finishCancelled()`（516-520）→ `phase = "cancelled"`。
6. `performSync` 返回 → `defer`（150-151）执行 `endBackgroundTask` → **后台窗口当场关闭**。

结论：**除"窗口自然到期"这一种情形外，`backgroundTask` 从拿到到归还之间不存在任何有意义的执行时间。** 它当前是一个"begin/end 配对齐全、但收益恒为 0"的结构。

需要精确区分责任方：**抵消窗口的不是 expiration handler（143），而是 `RAIApp.swift:75-77`。** expiration handler 只在窗口到期时兜底，而它前面永远轮不到。

**定性**：这不是 bug，是 `4801c2e` 那次"移除不可用的后台同步"的**遗留半成品**——真正的后台机制（`BGProcessingTask`）删掉了，续期壳留下了，且 `apps/ios/README.md:100` 已经写上"健康同步仅在前台执行，不注册或调度后台同步任务"，与 141-146 的共存语义不一致（技术上 `beginBackgroundTask` ≠ 后台同步，但代码与文档已互相打架）。

### 4. 上传的具体实现

`apps/ios/RAI/HealthKitSync.swift:619-642`：

```swift
619  private func upload(zipURL: URL, to serverURL: URL, batchId: String?) async throws -> String {
621      let boundary = "rai-\(UUID().uuidString)"
622      let multipartURL = FileManager.default.temporaryDirectory
623          .appendingPathComponent("rai-upload-\(UUID().uuidString).multipart")
624      defer { try? FileManager.default.removeItem(at: multipartURL) }
625      try await HealthSyncCancellation.runDetached(priority: .utility) {
626          try writeHealthKitMultipart(zipURL: zipURL, boundary: boundary, to: multipartURL)
627      }
630      var request = URLRequest(url: endpoint(serverURL, path: "/v1/imports/uploads"))
631      addAuthorization(to: &request)            // Bearer token
632      request.httpMethod = "POST"
633      request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
634      if let batchId, !batchId.isEmpty {
635          request.setValue(batchId, forHTTPHeaderField: "X-RAI-Sync-Batch")   // 幂等键 = payloadHash
636      }
637      request.timeoutInterval = 600
638      let (data, response) = try await session.upload(for: request, fromFile: multipartURL)
641      return try JSONDecoder().decode(UploadResponse.self, from: data).sourceId
642  }
```

- **`session.upload(for:request:fromFile:)`：✅ 使用，且是唯一的上传路径。** 调用者 3 处：`265`（恢复持久化批次）、`360`（重试失败批次）、`449`（本次新批次）。multipart 由 `writeHealthKitMultipart`（1058-1082）手工拼装，1 MB 分块 + 逐块 `Task.checkCancellation()`。
- **配置类型**（57-64）：

  ```swift
  58  let configuration = URLSessionConfiguration.ephemeral
  59  configuration.timeoutIntervalForRequest = 30
  60  configuration.timeoutIntervalForResource = 600
  61  configuration.waitsForConnectivity = true
  62  configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
  63  return RaiURLSession.make(configuration: configuration)
  ```
- **session identifier：无。** `ephemeral` 在概念上就没有 identifier——identifier 只属于 `URLSessionConfiguration.background(withIdentifier:)`。（`URLSession.shared` 是默认 config，也非 background。）
- 全仓 `URLSessionConfiguration` 出现点仅 3 类：`HealthKitSync.swift:58`、`APIClient.swift:75`（`ephemeral`，15s/75s，`waitsForConnectivity = false`）、`tests/*`（`ephemeral`）。
- 🔴 **一条值得注意的自述证据**：262-263 / 358 / 447-450 三处注释写着"大包上传不做自动重试：600s 超时 ×3 最坏阻塞 30 分钟，超过整个导入窗口，**也远超 iOS 后台任务的执行时限**" ⇒ **代码自己已经承认没有可靠后台窗口。**

### 5. 后台 URLSession 使用情况

❌ **完全没有使用，且所有配套能力都缺。**

| 能力 | 状态 | 证据 |
|---|---|---|
| `URLSessionConfiguration.background(withIdentifier:)` | 0 命中 | 全仓 grep |
| `UIBackgroundModes` | 0 命中 | `RAI/Info.plist`、`project.pbxproj`（`INFOPLIST_KEY_*` 只有 CFBundleDisplayName / LSApplicationCategoryType / NSHealthShareUsageDescription / NSHumanReadableCopyright） |
| `BGTaskScheduler` / `BGProcessingTask` / `BGAppRefresh` | 0 命中 | `apps/ios/RAI` 下 grep（`4801c2e` 已移除） |
| HealthKit `enableBackgroundDelivery` / `backgroundDelivery` | 0 命中 | `apps/ios/RAI` 下 grep |
| `HKObserverQuery` 后台唤醒 | 被显式关掉 | `HealthKitSync.swift:102`：`guard UIApplication.shared.applicationState == .active else { return }` |
| entitlements | 仅 HealthKit 读写基础项 | `RAI.entitlements:5-8`，`com.apple.developer.healthkit.access` 为空数组 |

即：**当前"后台"相关的实现只有 `beginBackgroundTask` 一处，且如 §3 所述是无效的。**

---

## 三、对提案的适配性评估

提案：将前后台同步彻底拆分、采用三级执行策略、改用带 identifier 的 Background URLSession 实现持久化上传。

**总评：方向正确，但按当前架构直接落地会失败。有一个前提必须先满足，另有两处是不可回避的既有裁决/边界。**

### 3.1 适配点（可复用，不必重写）

1. **上传形态天然兼容 background session。** Background session **只支持** `fromFile:` / `fromFile`-style body，不支持 `httpBody` 数据体或 stream。项目现在用的正是 `upload(for:fromFile:)`（638），**这是唯一一种能平滑迁移的形态**。改动集中在 session 构造与生命周期，不必重写请求构造。
2. **可恢复任务日志已经做完，可直接当 background session 的相位机。**
   `SyncTaskStore`（SQLite）+ `SyncTaskState`（`phase/sourceId/jobId/payloadHash/pendingAnchor/exportEnd/workoutCount`，1043-1056）+ 恢复分支（183-316）已经把"崩溃后从哪里继续"实现完毕。background session 需要 `getAllTasks` + 重挂 delegate 后做状态对齐——**复用这套 phase 机即可，不要新建第二套状态机。**
3. **幂等键已就位。** `X-RAI-Sync-Batch = payloadHash`（634-636，另见 360 用文件 hash）+ 服务端 `inspect` 的 `status == "unchanged"` 分支（189 / 274 / 368 / 459）。系统重放上传**不会**产生重复训练。这是"允许系统重投递"的必要条件，**已满足**。
4. **单飞闸门已存在。** `HealthSyncTaskOwner` 保证同一时刻只有一个 sync（`taskOwnerEnforcesSingleFlight`，`HealthSyncCancellationRegression.swift:180-206`），可直接作为"前台/后台不并发"的互斥点。

### 3.2 冲突点（🔴 不解决就落不了地）

1. 🔴 **`RAIApp.swift:75-77` 与"后台持久化上传"在语义上互斥。**
   background session 的价值全在"进程挂起/被杀后上传继续"。而这行在切后台的瞬间取消同一个 `Task`，**`Task.cancel()` 会连带取消底层 `URLSessionTask`** ⇒ 持久化上传一次也活不下来。方案的第一步必然是删/改这行。
   ⚠️ **但改它会动到被回归钉住的语义**：`HealthSyncCancellationRegression.swift:208-220` 明确断言"取消必须挡住上传闸门"（`"cancelled sync crossed the upload gate"`）。**持久化上传必须跑在一个不随 `scenePhase` 取消的 Task 上**——这是一处容易被忽略的耦合，也是全案最关键的改动点。
2. 🔴 **仓库内三处显式边界，方案需要小唐显式授权才能突破。**
   - `AGENTS.md`：`"do not add HealthKit write, background delivery, or a standalone Watch/macOS/mobile product unless the user explicitly asks"`
   - `apps/ios/README.md:100`：`"健康同步仅在前台执行，不注册或调度后台同步任务。"`
   - `docs/IOS_CLOUD_REVIEW_PLAN_2026-09-07.md:170`（更早的正式裁决）：`"先支持前台同步与返回前台续接；当前有限后台执行时间不能当作可靠后台同步承诺。HealthKit 持续后台 delivery 留待单独立项。"`
   ⇒ 这不是技术选型问题，是**范围变更**：需授权 + 同批更新上述三处文档。
3. 🟡 **`waitForJob` 的 30 分钟轮询是 background session 解决不了的那一段。**
   流水线为：HealthKit 导出（可能数分钟）→ multipart 构造 → **上传（background session 可覆盖）** → `inspect`（`data(for:)`）→ `startImport`（`data(for:)`）→ **`waitForJob` 轮询最长 30 分钟（725-775）**。后三者都是普通请求，**进程一挂就断**。
   ⇒ 三级策略若只解决"上传"，会新增一种故障形态：**上传成功、导入结果永远读不到**。轮询段必须另行设计（服务端改推送，或明确"回前台靠 `jobId` 续接"——后者项目**已有**，即 183-257 那条恢复分支）。
4. 🟡 **`applicationState == .active` 门控（102）与"后台被健康数据变化唤醒"这一级互斥。** 若三级策略含该级，需要 `enableBackgroundDelivery` + `UIBackgroundModes: [healthkit]`，属**新增权限与合规面**（PRD 的 `SYN-07` 只承诺"前台同步兜底"，`RAI_PRD_V1.0.md:1265`）。

### 3.3 潜在风险

1. 🔴 **multipart 临时文件位置不适合作为后台上传的源。**
   622-623 把它写在 `FileManager.default.temporaryDirectory`，624 立即 `defer remove`。前台模式下无碍（`await` 返回即删）；**background session 下系统 daemon 可能要在 App 被杀后继续读它，而 `/tmp` 会被系统清理**，且删除时机与 transfer 完成不再严格同步。
   ⇒ 迁移前**必须**挪到 `applicationSupportDirectory`（项目里 `persistZip` 840-852 已是这个做法），并保留到 transfer 完成回调。**这是最容易漏、且表现为"偶发上传失败/文件不存在"的一类缺陷。**
2. 🟡 **`waitsForConnectivity = true`（61）不是"语义冲突"，而是"从可选变强制"——真正的口径问题在别处。**

   - SDK 原文（`iPhoneOS26.5.sdk/System/Library/Frameworks/Foundation.framework/Headers/NSURLSession.h:778-779`）：
     *"Default value is NO. **Ignored by background sessions, as background sessions always wait for connectivity.**"*
     同一份头文件 `:1022-1023`：`URLSession(_:taskIsWaitingForConnectivity:)` *"**will never be called for background sessions**, because the waitForConnectivity property is ignored by those sessions."*
     ⇒ **不存在"混用导致行为不一致"**：后台 session 只是把"等"变成**不可关闭**，前台那套 `isDiscretionary` / `sessionSendsLaunchEvents` 是另一组开关，两者不重叠。
   - ⚠️ **迁移前真正要定口径的是这一句**（同头文件 `:769-771`）：
     *"When waiting for connectivity, the **timeoutIntervalForRequest** property does not apply, but the **timeoutIntervalForResource** property does."*
     ⇒ 当前配置 `timeoutIntervalForRequest = 30` / `timeoutIntervalForResource = 600`（62-63）在"等待连通"期间**唯一有效的上界是 600s**，30s 那层不生效。迁 background session（永远在等）之前必须为此单独定口径，否则"上传卡住"的表现形式是**最长 10 分钟无进展**，而不是 30s 报错。
   - ❎ **本报告初版此处写作"语义重叠 / 混用会出现『看着在等、实际已失败』"** —— 该结论**已被 SDK 原文推翻**，2026-09-22 更正。留在这里是为了记住这个错法的形状：**"两个机制都涉及同一件事"不等于"它们冲突"**，判定必须先读被调用方的文档，不能从名字推。
3. 🟡 **重定向守卫必须一并挂上。** `RaiRedirectGuard`（`APIClient.swift:3-27`）是同源才放行；服务地址由用户配置（`ServerSession`），跨源不是理论情况。background session 漏挂这个 delegate 会导致跨源行为与前台不一致。
4. 🟡 **"三级执行策略"目前没有落地判据，且可能打破 `SyncTaskStore` 的并发不变量。** 代码里没有"级"的概念，只有一条线性 `performSync`。若三级之间可并发（如前台取消、后台仍在传），两边会**同时写同一个 scope 的 SQLite journal**（`SyncTaskStore.save/clear`），互相覆盖 `phase/sourceId`。这是本方案**最可能打破的既有不变量**。
5. 🟡 **进度提交时机不得放宽。** `markSuccess`（536-570）会推进 `lastExportEnd` 与 workout anchor。既定约束是 `IOS_CLOUD_REVIEW_PLAN` 第 4 步第 6 点："**只有服务器确认导入并发布后提交本地锚点**"。若三级策略允许"上传完成即记进度"，会退化成"上传成功但导入失败 ⇒ 下次不再重传 ⇒ 静默丢批次"。

---

## 四、建议（按可逆性排序）

### 第一步：消除自相矛盾（零功能风险，建议立刻做）

`beginBackgroundTask` 与"切后台即取消"**只能留一个**。我倾向**保留取消、删除 begin/end 配对**：

- 取消是产品边界（前台 only）的体现，且有回归钉住（`HealthSyncCancellationRegression.swift:208-220`）；
- `begin/end` 配对是 `4801c2e` 清理时的漏网之鱼，**删它除了少一次 API 调用外零行为变化**；
- 同批把 `apps/ios/README.md:100` 附近的措辞与代码对齐。

**验收标准**：`npm run test:ios` + `run-health-sync-tests.sh` 全绿；全仓 grep `beginBackgroundTask` → 0 命中且 README 无遗留矛盾表述。
**回滚**：单文件改动，`git revert` 即可。

### 第二步：Background URLSession 单独立项（触碰持久化与跨进程契约）

按 `docs/IOS_CLOUD_REVIEW_PLAN_2026-09-07.md` 第 5 步的既有裁决路径走，前置条件：

1. **先拿授权**，并同批更新 `AGENTS.md` / `apps/ios/README.md` / `IOS_CLOUD_REVIEW_PLAN` 三处边界；
2. **先把"三级"写成判据**（每级的进入条件、级间交接、单飞闸门位置、`SyncTaskStore` 的独占规则），先冻结 `SyncTaskStore` 的并发不变量假设，再动 session；
3. **先解决两个真难点**：multipart 源文件改持久目录；`waitForJob` 轮询段的续接方案（推荐复用已有的 `jobId` 恢复分支，而不是新造机制）；
4. **验收必须先验等价性再验收益**：同夹具下"旧实现 vs 新实现"的导入结果逐字段一致（训练数/日期/字段值），再谈后台完成率。**不要用绝对阈值当验收标准。**

---

## 五、依据清单（可逐项复核）

| 判据 | 位置 |
|---|---|
| `beginBackgroundTask` / expiration handler / `defer` 收尾 | `apps/ios/RAI/HealthKitSync.swift:139-153` |
| `scenePhase` 后台取消 | `apps/ios/RAI/RAIApp.swift:65-80` |
| `cancelSync` 与 owner 取消 | `HealthKitSync.swift:81-84`、`HealthSyncCancellation.swift:134-172` |
| 上传（fromFile + 临时文件 + 幂等头） | `HealthKitSync.swift:619-642`、`1058-1082` |
| session 配置 | `HealthKitSync.swift:57-64`、`APIClient.swift:29-33,74-86` |
| 30 分钟轮询 | `HealthKitSync.swift:725-775` |
| 恢复分支（jobId 续接已存在） | `HealthKitSync.swift:183-316` |
| 进度提交（watermark / anchor） | `HealthKitSync.swift:536-570` |
| 取消必须挡住上传闸门（回归） | `apps/ios/tests/HealthSyncCancellationRegression.swift:208-220` |
| 移除 BGProcessingTask 的提交 | `git show 4801c2e` |
| 收窄为仅 `.background` | `git show c83e7eb -- apps/ios/RAI/RAIApp.swift` |
| 后台交付的既有裁决 | `docs/IOS_CLOUD_REVIEW_PLAN_2026-09-07.md:170` |
| 前台 only 的产品边界 | `apps/ios/README.md:100`、`AGENTS.md` |
| 无 `UIBackgroundModes` | `apps/ios/RAI/Info.plist`、`apps/ios/RAI.xcodeproj/project.pbxproj` |
