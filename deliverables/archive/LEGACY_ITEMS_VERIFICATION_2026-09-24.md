# 遗留未修项核实 —— iOS 后台同步 4 项（2026-09-24 18:2x）

**核实对象**：`2026-09-24` 工作日志里"发现的遗留（4 项，均未修）"那一段。
**核实基线**：当前工作区 = `HEAD` = `9ff2211`，`git status --short` **为空**（未提交改动为 0）。
**核实方式**：逐条读码定位 + 与起点 `b34d95c` 版本对比 + 实跑门禁。**未修改任何源码。**

---

## 一、结论先行

| # | 15:28 记录的遗留 | 判定 | 一句话理由 |
|---|---|---|---|
| 1 | `handleEnterBackground` 未接恢复 ⇒ 冷启动进程按 `"unbound"` 读盘；"有任务无意图"那一态切后台不重排 | 🟡 **部分闭合**（事实成立 / 后果不成立） | 它确实不调 `restoreBackgroundContext`；但**重排的真实入口已经不在它身上** —— `RaiAppDelegate.applicationDidEnterBackground` 自己按 `session.serverURL` 现读探针，与它无先后依赖。残留影响降级为"展示层标志可能短暂为 false，且该时刻 UI 不可见"。 |
| 2 | `runBackgroundPass` 包进单飞闸门 ⇒ 被拒时 `hasPendingTask` 不再刷新 ⇒ 重排与回执基于陈旧快照 | ✅ **已修** | `runBackgroundPass` 改成 `@discardableResult -> PendingWork?`，收工按**本次目标**现读快照返回；调用方的 `shouldResubmit` / `setTaskCompleted` 全部改用返回值；门禁已禁止 AppDelegate 读那个展示标志。 |
| 3 | `performBackgroundPass` 在"有任务、无意图"时合成意图 ⇒ 孤儿 ⇒ 下一轮 `.startFreshSync` 造成一次多余全量导出 | ✅ **已修** | 合成调用已删除（只剩注释说明为什么删）；`wantsFresh` 现在**要求盘上没有任务行**；`recordBackgroundIntent` 的两处真实调用都在 `performSync` 的锁屏分支。 |
| 4 | 迁移失败 ⇒ `isAvailable=false` + `database=nil`，且不原地重试（要等下次冷启动新建实例） | ✅ **已修** | 新增 `SyncTaskStore.reopenIfUnavailable()`（受控重开），在**每个被接受的单飞入口**之前调用；两条回归分别覆盖"可用时不无谓重开"与"迁移锁释放后同一实例能重开"。 |

**净结论**：4 项里 **3 项已闭合、1 项部分闭合**；日志里"均未修"这句**已经过期**，不要再照抄。

---

## 二、逐条证据

### 第 1 项 —— `handleEnterBackground` 与恢复

**成立的部分**：`HealthKitSync.swift:317-331` 里没有 `restoreBackgroundContext` 的调用。

```swift
317  func handleEnterBackground() {
329      let pending = activeServerURL.flatMap { probePendingWork(for: $0) }
330      let inFlightTask: SyncTaskState? = isBusy ? loadTask() : nil
331      hasPendingTask = inFlightTask != nil || (pending?.hasUnfinishedWork ?? false)
332      guard isBusy else { return }
```

- `restoreBackgroundContext` 全仓调用点只有 3 处：`:276`（`syncIfNeeded`）、`:597` 与 `:676`（`performBackgroundPass`）——**`:317` 不在其中**。
- 而它的签名是 `restoreBackgroundContext(for serverURL: URL)`（`:2006`），**需要外部传入 URL**；`HealthKitSync` 不持有 session，`handleEnterBackground()` 也没有参数 ⇒ **它无法自救**，这是"没接"的结构性原因。

**不成立的部分（原报的后果）**：

1. 调用点是 `RAIApp.swift:79-83`，条件是 `scenePhase == .background` ⇒ 只在**有 UI 场景**的进程里触发；被 BGTask 冷启动的进程没有 scene，不会产生 `scenePhase` 变化 ⇒ **"冷启动进程里跑 handleEnterBackground"这个场景不存在**。
2. 同一个 `onChange` 的 `.active` 分支（`:70-77`）会调 `syncIfNeeded(to: model.session.serverURL, …)`，而恢复就在它里面，且**排在节流判断之前**（`:276` 在 `:282-286` 之前）⇒ 只要进程 active 过，`activeServerURL` 就被绑定过。
3. 🔴 **重排的决策者不是它**：`AppDelegate.swift:292-299` 的 `applicationDidEnterBackground` **自己**读快照：

```swift
295      guard let pending = model.healthSync.probePendingWork(for: model.session.serverURL),
296            BackgroundRunPolicy.shouldResubmit(pending) else { return }
297      RaiStartup.submitBackgroundRun()
```

   注释 `:288-291` 把理由写明了：它与 `handleEnterBackground` 之间**没有先后保证**，所以"自己读快照，不依赖任何先跑过的回调"。用的是 `model.session.serverURL`（会话真实 URL），**不需要 `active*` 已绑定**。

4. 即便第 331 行把标志写成 `false`，也**不影响任何决策**：`HealthSyncLifecycle.enterBackground` 的入参只有 `phase / isBusy / hasJobId / hasUploadTask`（`:333-341`），不含该标志；而 `:332` 的 `guard isBusy else { return }` 让冷启动进程直接早退。

**残留**：`hasPendingTask` 唯一消费者是展示层（`TechSyncStatus.swift:115`）。在"进程从未完成恢复 + 立刻切后台"这个窄窗口里，它可能被写成 `false`，而此时 App 已进后台、UI 不渲染 ⇒ 实际不可见，回前台时 `syncIfNeeded` 会重新刷新。

> 修订后的严重度：从"切后台不重排"（功能性）降为"展示标志在窄窗口里可能偏低，且该窗口不可见"（指示性）。

### 第 2 项 —— 单飞被拒时的口径

```swift
560  @discardableResult
561  func runBackgroundPass(to serverURL: URL?, apiToken: String) async -> HealthSyncBackgroundRecovery.PendingWork? {
...
568      let accepted = await syncOwner.run { … await self.performBackgroundPass(…) }
573      if !accepted { Self.report("…; reading this target's own snapshot") }
579      return probePendingWork(for: serverURL)
```

- 返回值**无条件**是"按本次目标现读的快照"（`:579`）⇒ 被拒那一路拿到的是**自己的**结论，不再是别人的标志。
- 调用方 `AppDelegate.swift:195-209`：`let pending = await …` → `shouldResubmit(pending)` → `setTaskCompleted(success: pending.map(reportedSuccess) ?? false)`；快照为 `nil` 时**保守报失败**（`:206-209`）。
- 门禁已钉住：`check-background-capabilities.py:687` 断言 `"healthSync.hasPendingTask" not in app_delegate`；`:1640-1644` 断言 `runBackgroundPass` 必须把 target-bound 快照交给调用方。
- `hasPendingTask` 现在只被 `TechSyncStatus.swift:115` 读取（展示层）；被拒时它保持的值属于**那个正在跑的目标**，对 UI 而言依旧是"当前实际在跑的目标"。

### 第 3 项 —— 合成意图

- `recordBackgroundIntent` 的调用点全仓只有 3 处：`HealthKitSync.swift:780`（`performSync` 里"受保护数据不可用"分支）、`:1188`（`performSync` 的 catch 里 `databaseLocked` 分支）、`AppDelegate.swift:59`（真实投递）——**没有一处属于 `performBackgroundPass`（`:596-687`）**。
- `:630-639` 是**注释**，写明合成已被删掉及两个方向的理由；判定 `wantsFresh` 的代码在 `:647-649`：`let wantsFresh = task == nil && (hasNotification || hasRecoveryRequest)` ⇒ **盘上有任务行时绝不走 `.startFreshSync`**。
- 门禁 `check-background-capabilities.py:883-888`：`"recordBackgroundIntent" not in without_comment_lines(background_pass)`；突变脚本 `check-background-mutations.py:734` 正是往这里**注入**合成意图、期望门禁变红 ⇒ 该断言有执行者。

### 第 4 项 —— 迁移失败的重试

```swift
119  func reopenIfUnavailable() -> Bool {
120      guard !isAvailable else { return true }
121      open()
122      return isAvailable
123  }
```

- 调用点：`HealthKitSync.prepareJournalForExecution()`（`:585-594`），而它位于**两个被接受的单飞入口**之前（`syncIfNeeded:275`、`runBackgroundPass:570`）⇒ 失败后**下一次进入同步就会原地重开**，不再依赖"下次冷启动新建实例"。
- 为什么重开安全，`:110-115` 写清了：迁移失败**已经 `ROLLBACK`**（`migrateRouteStateSchema` 的 `defer`，`SyncTaskStore.swift:144-146`）；`PRAGMA user_version` 是幂等标记（`:139-141`）；**不删任何文件**。
- 回归：`StoreRegression.swift:256`（"迁移锁释放后同一个 store 能重开"）、`HealthSyncBackgroundRecoveryRegression.swift:282-285`（可用时不无谓重开 / 不可用返回 false）。
- 门禁 `check-background-capabilities.py:1675-1676`：要求 `reopenIfUnavailable()` 存在**且不出现在 `probePendingWork` 里**（探针必须只读）。

---

## 三、归属：预存在 还是 本次引入

用起点 `b34d95c` 的同名文件逐处对照：

| 项 | 起点 `b34d95c` | 结论 |
|---|---|---|
| 1 | `handleEnterBackground` 用 `let task = loadTask()` + `hasPendingTask = task != nil`（`b34d95c:275-279`） | 起点版**更差**（按内存 `activeScope` 读盘）。本次改成按目标探针 = **改进**，但恢复仍未接入 ⇒ 属"本次修复的未覆盖点" |
| 2 | 起点版 `runBackgroundPass` 是 `async`（无返回值，`b34d95c:423`）、**体内没有 `syncOwner.run`**；`AppDelegate.swift:187/194/200` 用 `hasPendingTask` 做重排与回执 | 那个副作用（被拒不刷新）**是本次引入的**，而本次**同时用返回值把它闭合** ⇒ 净结果为已修 |
| 3 | 起点版 `runBackgroundPass` 范围是 `:423-476`，体内**没有** `recordBackgroundIntent`（该符号在起点版仅 `:539`/`:933`，均属 `performSync`） | "合成意图"**从未进入起点版本**，它是修复过程中的中间态；最终态已删除 ⇒ 不是既有缺陷 |
| 4 | 起点版无迁移机制、也就没有"迁移失败"这一态 | 属本次新增能力的**新状态**，本次自己补上了重试与幂等路径 |

---

## 四、门禁复核（实跑）

```
npm run test:ios   →   EXIT=0
  Background capability checks: 252 checks, 0 failed
  57 sync-state commit regression checks passed
  49 route state persistence regression checks passed
  62 store regression checks passed
  35 route state machine checks passed
  Export determinism checks: 14 checks, 0 failed
```

**为什么门禁全绿仍会漏掉第 1 项的残留？**
`check-background-capabilities.py:841-861` 对该函数的两条断言是**字符串形状**：

```python
check("probePendingWork(for:" in enter_background, "handleEnterBackground asks the active context instead of probing the target: …")
check("pending?.hasUnfinishedWork" in enter_background, "… no longer derives the pending flag from the probe snapshot …")
```

`activeServerURL == nil` 导致的退化**不改变任何一个字符** ⇒ 断言照样绿。这与本仓既有的两条教训同族：**"判据存在 ≠ 判据被执行"**、**"形状断言只钉住接线，不覆盖行为"**。
反过来说，第 2/3/4 项的断言都**另有行为侧执行者**（回归真跑 SQLite、突变脚本注入后必须变红），所以它们不是"只钉形状"。

---

## 五、判定与建议（**未修改任何源码**）

- 小唐问的"是否已经修复了"：**第 2、3、4 项已修复且带有行为侧执行者；第 1 项部分闭合**。
- 第 1 项要不要再动，取决于是否认可"展示标志在窄窗口可能偏低"值得修。**我倾向不动**：修它需要在 `handleEnterBackground` 里拿到 serverURL（改签名或注入 session），而这个改动的收益是"让一个不可见时刻的展示标志更准"——按本仓"为微小收益去放宽既有结构 ⇒ 默认作废"的口径，不划算。若真要修，最小形状是把 `handleEnterBackground(for serverURL: URL?)` 加上参数，并在探针前先恢复。
- 仍**未验收**（与本次核实无关，但别混为一谈）：真机后台验收（冷启动实际续传、看门狗在 BGTask 下的预算读数、新 scope 的 GPX 交付）；全量 77 条突变未重跑（只跑过按范围裁剪的部分）。
