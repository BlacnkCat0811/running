# 审查结果核查 —— iOS 同步链路 3 条缺陷（2026-09-24）

**核查对象**：一份针对 iOS 同步链路的审查报告（P1 后台冷启动、P1 轨迹状态无 scope、P2 后台意图早删）。
**核查方式**：逐条读码定位 + 实跑门禁 + 追溯改动归属。**未修改任何源码**（`git status` 与核查前逐字相同：
11 个已修改文件 + 1 个未跟踪文件）。

---

## 一、结论先行

| 报告条目 | 核查判定 | 关键差异 / 补充 |
|---|---|---|
| 1. [P1] 后台冷启动无法恢复已有同步任务 | ✅ **成立，且比报告描述的更深** | 不只是 "activeScope 是 unbound"：真实行落在 `syncScope` 下、且 `isCurrentTask` 还要求 `activeIdentity` 非空 ⇒ **只修 scope 不够**。修复所需的离线身份**已经存在**（`rai.handshake.<urlScope>`），不必每次唤醒打握手。影响上限被报告高估：不是永久失效，是"停摆到用户下次打开 App"。 |
| 2. [P1] 切换服务端后永久缺失历史轨迹 | ✅ **成立** | 报告未提两点：①触发面更宽 —— **同服务端 `datasetEpoch` 变化同样触发**；②修复必须**带一次性表重建**（本仓 iOS 侧无任何 schema 迁移机制，`CREATE TABLE IF NOT EXISTS` 对已安装设备静默不生效）。 |
| 3. [P2] 首次后台同步失败后丢失重试意图 | ✅ **成立** | 补充定性：这是**漏用既有规则**，不是新设计问题 —— 同一份代码里已有两处在失败路径补回意图（`:565` / `:959`），这两处反证了"应当恢复"是既有口径。 |

**报告未覆盖、由本次核查补出的一条未验收疑点**（不是"我又找了个 bug"，是本次未提交改动的**已知未验收项**）：
`:525-535` 新增的 1 秒看门狗在真机 BGTask 下有**两种方向相反**的可能失败模式，其中一种会让整个 P2 后台链路静默空转。
详见第四节。

**门禁数字复核**：报告的门禁段**逐项属实**（含 819/3 与实测 818/4 的差额解释）。详见第五节。

---

## 二、逐条证据

### 条目 1 —— 后台冷启动读不到待续接的任务

**结论成立。** 证据链：

- `HealthKitSync.swift:20-21`：`activeScope = "unbound"`、`activeServerURL: URL?`。
  全仓**只有两处**赋值，都在 `performSync` 内：`:497-498`（`urlScope`）与 `:579`（握手后改 `syncScope`）。
  ⇒ **冷启动进程里两者必然为空/未绑定**，直到本进程跑过一次 `performSync`。
- `:429` `let task = loadTask()` 是 `runBackgroundPass` 的第一次读盘（报告写 `:428`，428 是函数签名行，差 1 行，实质无误）。
- `:1647` `taskStore.load(scope: activeScope)` ⇒ 读的是 `'unbound'` 那一行；
  `:1652` 第三个候选依赖 `activeServerURL`，冷启动为 `nil` ⇒ 只剩两个必空的候选。
- 🔴 **比报告更深的一层**：`:1664 guard isCurrentTask(task)` → `:1686` 要求
  `task.target == activeServerURL?.absoluteString`。`activeServerURL` 为 `nil` 时**任何**任务行都被拒；
  `:1687-1689` 还要求 `activeIdentity` 非空（当前写入点 `:875-892` 一律写 `serverId`/`athleteId`/`datasetEpoch`）
  ⇒ 这三样都得恢复，才算"读得到"。
- 🔴 **"真实 scope" 不是 urlScope 而是 `syncScope`**：`:1638 saveTask` 用 `activeScope`（握手后 = `syncScope` = `hash(url|serverId|athleteId|datasetEpoch)`，`:1740`）
  ⇒ **把 `activeScope` 设成 `urlScope(serverURL)` 依然读不到那一行**。这一条决定了修复方案的形状（见第六节）。
- 后果链（报告描述准确）：`:430 hasPendingTask=false` → `:455 wantsFresh=false`（意图若已被消费）
  → `:456 BackgroundRunPolicy.action(hasTask:false, jobId:nil, …, wantsFreshSync:false)` = `.nothingToDo`
  → `:470 return` → `AppDelegate.swift:192-196 shouldResubmit(false,false)=false` ⇒ **不再重排**
  → `:200 setTaskCompleted(success: true)` ⇒ 还向系统报成功。
- **意图记录端同样失效**（报告描述准确）：`:403-406 recordBackgroundIntent()` 与 `:417-420 hasBackgroundIntent`
  都以 `activeServerURL` 为前置 ⇒ 冷启动健康数据通知走 `AppDelegate.swift:55` 的 `.deferToBackground` 时，
  **意图被静默丢弃**（该分支后面照旧 `submitBackgroundRun()`，于是换来一次必然 `.nothingToDo` 的空跑）。
- **同根因的第二落点**（报告未提）：`:251` `syncIfNeeded` 读盘判阻塞态，注释 `:249-250` 明写
  "判据必须读盘上那份自述：进程重启之后内存 phase 回到 idle" —— 但冷启动下 `loadTask()` 同样读不到，
  于是回退恒为 `nil`，`isBlocked` 只剩内存里的 `idle`（`SyncPhase.swift:81` blocked 集合只有 `deferredProtectedData`/`authRequired`）。
  **该注释宣称的行为在进程重启这一态下并未实现**。影响较轻（解锁通知那条路走 `force: true`，`:100`），但性质同类。
- **影响上限（修正报告口径）**：不是"数据永久丢失"。用户下次把 App 拉到前台时
  `RAIApp.swift:69-74` 会 `syncIfNeeded` → `performSync` 重新握手拿到真 scope → `:587` 读回那批继续跑。
  准确措辞：**后台链路静默停摆，直到下一次投递或用户下次打开 App**。

### 条目 2 —— 轨迹状态没有 scope，换服务端后历史轨迹永久缺失

**结论成立。** 证据链：

- `SyncTaskStore.swift:60-68`：`CREATE TABLE sync_route_state (workout_uuid TEXT PRIMARY KEY, …)` —— **没有 scope 列**。
- 读 API 本身就没有 scope 形参：`:420 loadRouteStates(uuids: String? = nil)`；`:427-431` 传 `nil` 即**整表读**。
- 消费路径不按 scope 过滤：`HealthKitSync.swift:837 taskStore.loadRouteStates()`
  → `:855 routeStates:` → `HealthKitExport.swift:326 previous = routeStates[routeKey]`（只按 workout uuid 查）。
- 跳过判定与"记忆留存"：`RouteSyncStateMachine.swift:79-93` —— `settled` ⇒ `shouldQuery == false`；
  `HealthKitExport.swift:347-359` 跳过时 `routeFiles = []` 且 **`routeDecisions` 不写这一条**
  （`:341` 只在查询分支写）⇒ `HealthKitSync.swift:1084` 只 upsert 查过的那些 ⇒ **旧的 `settled` 行原样留存，下一轮继续跳过**。
- 新服务端首同步为什么是"全窗口但跳过轨迹"：`HealthKitSync.swift:826-831` 新 scope 无 `sync_state` 行
  ⇒ `lowerBound = nil` / `anchor = nil`（全量窗口），但 `:858 routeForceRescan: full`，而 `full` 只来自 UI 的
  "重新导入全部"（`full` 的无参默认值是 `false`，`:391`）⇒ 默认**不**强制重扫。
- 唯一人工出口确实存在，但正因如此才叫"永久"：`RouteSyncStateMachine.swift:90-92` 只有 `isForceManualRescan` 能唤醒 `settled`；
  `HealthKitSync.swift:808-815` 的 `full` 只 `forgetState(scope:)`、**不**清 `sync_route_state`
  （它靠 `routeForceRescan=true` 在这一轮把每个 workout 重查一次，所以人工出口有效）。
  文档同口径：`docs/IOS_NATIVE_SYNC_PROTOCOL.md:251` "`settled` 的唯一唤醒通道是'重新导入全部'"。
  ⇒ **缺陷 = 这个"唯一通道"被跨 scope 继承的 `settled` 提前触发**。
- 载体范围证明"换服务端不会清库"：`SyncTaskStore.swift:14-19` 固定 `Application Support/RAI/sync.sqlite`，
  全仓无删除点（`grep sync.sqlite` 只命中构造）。
- 🔴 **触发面比报告描述的更宽**：报告说"切换服务端"，但按 `:1740 syncScope` 的定义，
  **同一服务端换了数据集（新 `datasetEpoch`）同样产生新 scope**，症状完全一样。
- 报告说"已用临时 SQLite 和生产状态机复现" —— 该方法论可信：`RouteSyncStatePersistenceRegression.swift:35`
  就是用 `SyncTaskStore(directory:)` 注入临时目录跑真 SQLite 的。
- **设计理由不冲突**：`RouteSyncState.swift:21-25` 论证的是"主键必须是 workout uuid，而不是伪造一个 route anchor"；
  复合主键 `(scope, workout_uuid)` 与这条理由**不矛盾** —— 修复不必推翻既有论证。
- 🔴 **修复的隐藏前提（报告未提）**：全仓无 `PRAGMA user_version`、无 `ALTER TABLE`
  （`grep -nE "user_version|ALTER TABLE" RAI/*.swift` 为空），schema 每次 open 走 `CREATE TABLE IF NOT EXISTS`（`:41-74`）。
  ⇒ **只改建表语句，在已安装设备上静默不生效**（正本项目口径的"改了代码但线上不生效"）。
  必须配一次性重建（新表 + `INSERT SELECT` 或直接丢弃 + `DROP`），且**需要一个只跑一次的标记**。

### 条目 3 —— 首次后台同步失败后丢失重试意图

**结论成立。** 证据链：

- `:455 let wantsFresh = task == nil && consumeBackgroundIntent(scope: Self.urlScope(for: serverURL))`，
  而 `:409-414 consumeBackgroundIntent` 是**读即删**（`removeObject`）。
- 消费之后到"任务落盘"之间的全部顺序：
  `sync()` `:391-396` → `performSync` `:497-498` 绑身份 → `:568-578` **握手**（失败即 `return`，只写内存 `phase=.failed`）
  → `:808-861` **导出** → `:875-892` **第一次 `saveTask`**。
- ⇒ 报告点名的两条路都成立：
  ① **握手断网** ⇒ 返回时既无任务行、也无意图；
  ② **导出被中断**（`handleCancellation` `:1020-1027` → `finishCancelled` `:1004-1013`）⇒ 同样在 `saveTask` 之前返回。
- 后果：`AppDelegate.swift:192-195` 读到的 `hasPendingTask=false`（`:479` 重读仍为 `nil`）、
  `hasBackgroundIntent=false`（此刻 `activeServerURL` 已被 `:497` 设上，但键已被删）⇒ `shouldResubmit=false`
  ⇒ 不再重排；`:200` 仍 `setTaskCompleted(success: true)`。
- 🔴 **定性补充（这条最重要）**：这**不是**一个"新技术问题"，而是**漏用既有规则**。
  同一份代码里已经有两处在失败路径补回意图：`:565`（锁屏预检被打回）与 `:959`（导出途中 `databaseLocked`）。
  两处的存在说明"失败要恢复意图"本来就是本文件的既定口径 ⇒ 修法与既有写法一致，无新设计争议。
- **影响上限**：与条目 1 相同 —— 下一次有数据变化的投递、或用户下次打开 App 会补上；不是永久丢。

---

## 三、报告未覆盖的两点（不是新缺陷，是修复方案的前置事实）

| # | 事实 | 对修复的意义 |
|---|---|---|
| A | 离线身份**已持久化**：`NativeAppModel.swift:839-850` 把 `RaiHandshake` 存在 `rai.handshake.<urlScope>`，`:76` 启动即读 | 报告建议"在后台决策前恢复目标身份"**可行且不必加一次握手**。若不知道有这个键，实现者会退化成"每次后台唤醒先打一次 HTTP 握手"（或干脆做不成）。 |
| B | iOS 侧 SQLite **无 schema 迁移机制**（无 `user_version` / `ALTER TABLE`） | 条目 2 的修复必须自带一次性重建逻辑，否则新装设备有效、老设备静默无效。 |

⚠️ 对 A 的一个必要约束（否则会引入新一类 bug）：离线身份只能当**闸门**用 ——
它决定"要不要为这批待办启动一次同步"；`activeScope` 的**权威重取**仍必须留在 `performSync` 的真实握手之后（`:579`）。
否则一旦持久化的握手是陈旧的（服务端已换 epoch），会拿陈旧 scope 把一批早已作废的行判成"可续接"。

---

## 四、报告之外的未验收高风险疑点：1 秒看门狗 × `backgroundTimeRemaining`

**这不是审查漏报，是今天日志已记录的"未做真机验收"项**，但它有两种**方向相反**的失败模式，值得在验收时优先钉死：

- 位置：`HealthKitSync.swift:525-535`（本次未提交改动新增），常量 `:133 = 5`。
- 判据：`applicationState != .active && backgroundTask != .invalid && backgroundTimeRemaining < 5` ⇒ `suspendForLifecycle()`。
- 模式 ①（**过激**）：若真机 BGTask 运行期间 `backgroundTimeRemaining` 读作 `< 5`（该 API 在"已有系统级后台断言"时的口径未在本仓验证过），
  则**每一次后台同步都会在启动约 1 秒后自杀**（`.lifecycle`，静默，界面只有一句"同步已暂停"）⇒ 整个 P2 后台链路空转。
- 模式 ②（**失效**）：若后台调用 `beginBackgroundTask`（`:511`）返回 `.invalid`，则 `backgroundTask != .invalid` 守卫恒假
  ⇒ 看门狗**永不触发**，本次修复想解决的 OOM/超时回退问题原样存在。
- 两种模式的判据是**同一个数**、后果相反 ⇒ 靠读码无法判定，必须真机。
- **判死判据**（一次后台运行、两行日志即可）：在 `performSync` 入口打一行
  `backgroundTimeRemaining` 与 `backgroundTask != .invalid`，看这两个读数落在哪一侧。
- 依据：本仓 2026-09-24 日志已记录"设备/模拟器实机验证（30s 看门狗实际收尾、零高度 rect）未做"。

---

## 五、门禁段复核（实跑，非引用）

| 项 | 报告 | 本次实测 | 判定 |
|---|---|---|---|
| API/共享包 | 819 通过 / 3 跳过 | `# tests 822 / # pass 818 / # fail 0 / # skipped 4`，`EXIT=0` | ✅ **同一套**：822 = 819+3 = 818+4。差额 1 恰为 `publication lock rejects PID reuse…` 在本沙箱被判 `EPERM` 而按设计 fail-safe 跳过（既知项，见项目备忘；**不是**本次改动引起） |
| Web | 86 通过 | 13 files / **86 passed**，`EXIT=0` | ✅ 逐字一致 |
| iOS 门禁 | 通过 | `typecheck-ios.sh`：**55 个文件**（已跳过 **3** 个仅依赖高德 SDK 的文件）→ `iOS 类型检查通过`；`npm run test:ios` → `iOS 门禁通过`，含 `Background capability checks: 225 checks, 0 failed` | ✅ 一致 |
| Timer actor 警告 | "有" | ✅ **2 条**：`:528 warning: main actor-isolated static property 'backgroundTimeSafetyMargin' can not be referenced from a Sendable closure`；`:530 warning: call to main actor-isolated instance method 'suspendForLifecycle()' in a synchronous nonisolated context` | ✅ 一致 |
| 未跑浏览器 E2E / 模拟器 / 真机后台验收 | 未跑 | 无相反证据（报告主动声明，边界诚实） | ✅ 一致 |

---

## 六、为什么门禁全绿仍然漏掉这三条（结构性归因）

| 条目 | 为什么不可见 |
|---|---|
| 1、3 | `apps/ios/tests/run-health-sync-tests.sh:29` **自己写着**："`HealthKitSync.swift` 本身不被任何回归编译，判据留在它里面就等于没有执行者。" ⇒ 这两条落在**没有任何执行者**的文件里。 |
| 1、3 | `check-background-capabilities.py` 确实读了 `runBackgroundPass` 的函数体（`:828-831`），但只做 **regex 形状断言**（如"是否把 `hasBackgroundUploadTask` 喂进 policy"），不做行为断言 ⇒ 看不出 `loadTask()` 的时机。 |
| 2 | `RouteSyncStatePersistenceRegression.swift` 每个用例都注入**独立目录**（`:35`），全篇只有一处出现 `scope`（`:187`，且与 route 无关）⇒ **从不跨 scope**，串味不可见。`StoreRegression.swift` 有 cache/task 的 scope 隔离用例，**没有** route 的。 |

⇒ 结论：报告的"验证结果全绿"与"三条缺陷存在"**并不矛盾**，是覆盖面的问题，不是报告自相矛盾。

---

## 七、判定与建议（仅给判据，本次不改代码）

1. **条目 1 与 3 是同一个修复面**：`runBackgroundPass` 在做任何决策之前必须恢复
   `(activeServerURL, activeIdentity, activeScope)` 三名。离线身份源已存在（`rai.handshake.<urlScope>`）。
   验收判据：后台启动一次后，`[RAI] background pass: action=` 这一行**不得**在不该出现 `.nothingToDo` 时出现它，
   且盘上那批能被推进（可用现有 `[RAI]` 日志面判；`HealthKitSync.swift` 不被编译，所以这条只能靠真机日志）。
2. **条目 2 的修复要点三条**：复合主键；**一次性表重建**（否则老设备静默无效）；旧行归属取**安全方向**
   （当作"未知"⇒ 每 route 重查一次，代价一次全量轨迹读；**不可**归给"当前 scope"，那正是缺陷本身）。
   验收判据：换 scope 后首同步必须仍产出 GPX（可在真机上比对同一 workout 的 `route_points` 是否补齐）。
3. **想让这三条不再复发，判据必须下沉**：`HealthKitSync.swift` 不进任何回归编译单元
   ⇒ 要么把 `runBackgroundPass` 的决策抽成纯函数（照 `BackgroundSyncPolicy` 的做法），
   要么把断言移到能编译的那一侧。否则修完仍然没有执行者（正项目口径的第 2 条纪律）。
4. **真机验收优先级**：第四节那两个相反读数 > 本次三条修复的端到端确认。

---

*核查人：小满｜证据均落在上述 `文件:行号` 与实跑命令输出上。本次未修改任何代码。*
