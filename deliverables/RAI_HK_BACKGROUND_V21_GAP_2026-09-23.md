# RAI HealthKit 后台同步 V2.1 · 差距分析与首批实施报告

- **日期**：2026-09-23
- **依据文档**：《RAI HealthKit 后台可靠同步系统 V2.1 架构设计与实施规范》（下称「规范」）
- **本次范围**：规范 §3.4（锁屏 / Protected Data 防御）、§3.3（后台 401 处理）
- **结论**：✅ 已实施并通过全部门禁；⚠️ 另有 **1 处规范与现行门禁直接冲突**需产品决策（见 §4.1）

> **2026-09-23 后续（本轮增补）**：本文 §4 的后续项已经过一轮多智能体讨论 + 红队质询并落地，
> 结论与证据见 `RAI_HK_BACKGROUND_V21_INCR_2026-09-23.md`。状态一览：
> §4.2 ✅ 已实施（`sync_state` + 单事务提交）· §4.6 ✅ 已实施（GPX 配额，**但三个数字都没照抄规范**）·
> §4.1 ✅ 已定案（**零行为变更**，只改判据口径 —— 红队推翻了"收窄续期范围"这个方向）·
> §4.4 🟡 本轮只补了门禁判据，状态机仍未做（理由见新报告 §4）·
> §4.5/§4.7 ✅ 定案为**不做**。
>
> ⚠️ **行号勘误**：本文 §1.2 / §4.1 / §4.4 里描述"改动前"现状的几处 `文件:行号` 引的是
> 本轮改动**之前**的基线（`HealthKitSync.swift:906,914,917,922`、`check-background-capabilities.py:250-262`、
> `HealthKitSync.swift:464-478`、`HealthKitExport.swift:168,414-428`），已就地更正为当前工作区的行号。
> 教训：同一份文档里混了两套基线，比行号写错更难发现 —— 报告头部必须写明基线。

---

## 0. 结论先行

**现状远比规范假设的成熟。** 规范 Phase 0–4 的**主体已在更早的迭代里落地** —— 三大后台机制  
（Background Delivery / BGProcessingTask / Background URLSession）**都已注册且实现**，  
`scenePhase.background → cancelSync()` 的误杀也早已移除。真正的缺口集中在规范 §3.3、§3.4、§3.5  
与 §5.1/§5.2，而其中**属于数据正确性**的是前两项，本次已实施。

本次交付三件事：

| #  | 内容                                                      | 规范条款      | 状态    |
| :- | :------------------------------------------------------ | :-------- | :---- |
| 1  | 锁屏熔断：预检查 + 运行时熔断 + 解锁自动恢复 + 落 `deferred_protected_data` | §3.4、§3.1 | ✅ 已实施 |
| 2  | 凭证阻塞：401/403 与"确定性拒绝"分流，落 `auth_required`，后台不再无限重试      | §3.3      | ✅ 已实施 |
| 3  | 门禁与回归：新增 12 节判据（22 条）+ 7 组回归 + 3 处门禁口径修正                | —         | ✅ 已实施 |

**验证结果**：`npm run test:ios` → `Background capability checks: 162 checks, 0 failed`，  
全部回归通过；负面自检确认新判据在不变式被破坏时**会红**（见 §3）。

> 区分：本文所有"现状"判断均来自**实际读代码**（附 `文件:行号`）；标"无法确认"的是本机环境  
> 无法取证的部分（如真机锁屏行为、云机 runtime.sqlite 状态）。

---

## 1. 逐条差距矩阵

图例：✅ 已达标 · 🟡 部分达标 / 有等价物 · 🔴 缺失

### 1.1 三大后台机制（规范 §1.2）

| 规范要求                                                             | 现状                                                                                                                                                         | 证据                                                                 | 判定                                                                                              |
| :--------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| Background Delivery 只登记、零耗时、立即回调 `completionHandler`，严禁查询/压缩/网络  | Observer 闭包内 `completion()` 是**第一条语句**，随后只 `Task { onObserverChange }`；派发决策在 `RaiStartup`（不在闭包内）                                                           | `HealthKitSync.swift:299-311`、`AppDelegate.swift:34-60`            | ✅ 且门禁钉住"`completion()` 早于任何 `Task`/`await`/`guard`"（`check-background-capabilities.py:319-340`） |
| `enableBackgroundDelivery(frequency:)`                           | 已开启，但 frequency = **`.hourly`**                                                                                                                            | `HealthKitSync.swift:323`                                          | 🟡 规范未指定 frequency；`.hourly` 是系统节流下的稳妥选择（见 §4.3）                                                |
| BGProcessingTask 事件驱动、不得硬编码时间、必须有 `expirationHandler` 且超时 3 秒内中断 | 完全符合：identifier `app.rai.running.health-sync`，注册在 `didFinishLaunching` 返回**之前**且检查返回值，`expirationHandler → suspendForLifecycle()`，重排 delay = 15 min（非固定钟点） | `AppDelegate.swift:73-159`、`BackgroundSyncPolicy.swift:16,186-191` | ✅                                                                                               |
| Background URLSession 必须文件 URL、严禁内存 Data、严禁阻塞回调                  | 完全符合：`uploadTask(with:fromFile:)`；Delegate 回调无 `sleep`/`while`/`DispatchGroup.wait()`；唯一"等待"是异步 `withCheckedContinuation`                                  | `BackgroundUploadSession.swift:172,62-76,124-128`                  | ✅                                                                                               |
| 严禁依赖 301/302（会丢鉴权头）                                              | 有重定向守卫并共用同源判据 `RaiSameOrigin.allowsRedirection`                                                                                                            | `BackgroundUploadSession.swift:271-284`、`APIClient.swift:12-53`    | ✅                                                                                               |

### 1.2 四大铁律（规范 §2）

| 铁律                                                          | 现状                                                                                          | 证据                                                                                           | 判定                                                                           |
| :---------------------------------------------------------- | :------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| 原则 1：三种标识符生命周期解耦（`batchId` 长期 / `sourceId` 短期 / `jobId` 长期） | `payloadHash` 充当 `batchId`（作为 `X-RAI-Sync-Batch` 幂等头）；`sourceId`/`jobId` 都随任务落 `sync_tasks` | `HealthKitSync.swift:1062`、`SyncTaskState.swift:43-45`、`SyncPhase.swift:55`（`inspect` 强制前置门） | ✅                                                                            |
| 原则 2：两阶段 Anchor（200 ≠ Commit）                               | ✅ **无任何"HTTP 200 即推进 anchor"路径**；`markSuccess` 只在 `inspect == unchanged` 或 job 成功终态后被调用     | `HealthKitSync.swift:549-555,574-580,804-828,905-907`                                        | 🟡 语义达标，但**未按 §2.1 的 `committedAnchor = candidateAnchor` 形式落到 DB 列**（见 §4.2） |
| 原则 3：单状态源真相（废除 UserDefaults）                                | ✅ **本轮已达标**（2026-09-23 增补）：anchor / 导出水位搬进 `sync_state` 表，与任务行**同一事务**提交；`lastSyncAt`/`lastWorkoutCount`/`lastAutoSync` 三个键**有意留在 `UserDefaults`**（丢了无害，且搬会静默改掉 scope 语义） | `SyncTaskStore.swift`（`sync_state` + `commitSuccess`）、`HealthKitSync.swift:markSuccess`（`mayCommit` 守卫） | ✅ 详见 `RAI_HK_BACKGROUND_V21_INCR_2026-09-23.md` §1 |
| 原则 4：URLSession 后台回调不阻塞                                     | ✅ 完全符合（见 1.1 第三条）                                                                           | 同上                                                                                           | ✅                                                                            |

### 1.3 核心机制（规范 §3）

| 条款                                             | 现状                                                                                                              | 判定                                                                |
| :--------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------- |
| §3.1 客户端状态机                                    | 有闭环 `SyncPhase`（唯一来源，`persistedPhases`/`terminalPhases` 均由它派生）。但**缺** `deferred_protected_data`、`auth_required` | 🟡 → 本次补齐这两个（其余命名与规范不同，如 `collecting`≈`preparing`、`uploaded`≈过渡态） |
| §3.2 三级收口（前台 / BGTask / Silent Push）           | 前置两级已实现且判据可执行；**Silent Push 未实现**                                                                               | 🟡 规范自述 push 仅"加速器"，缺失不影响最终一致性                                    |
| §3.3 后台 401 处理                                 | 🔴 **缺失**：无 `authRequired` 状态、无 Batch Token、401 落入默认 `.keepForNextWake`（后台每次唤醒重撞）                               | 🔴 → 本次实施                                                         |
| §3.4 锁屏 / Protected Data 防御                    | 🔴 **缺失**：无 `isProtectedDataAvailable`、无 `errorDatabaseInaccessible` 识别、无解锁恢复                                   | 🔴 → 本次实施                                                         |
| §3.5 Route 状态机（UNKNOWN→ACTIVE→COOLING→SETTLED） | 🔴 仍为"锚定同步时回看 14 天有界窗口"                                                                                         | 🔴 见 §4.4                                                         |

### 1.4 文件、传输与服务端（规范 §4、§5）

| 条款                                                                        | 现状                                                                                                                 | 证据                                                        | 判定                                       |
| :------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------- | :--------------------------------------- |
| §4.1 严禁 `/tmp`、`Caches`；唯一持久化路径 + `CompleteUntilFirstUserAuthentication`  | ✅ 落在 `Application Support/rai-healthkit-<scope>/`；`protect()` 设了保护等级 + `isExcludedFromBackup`                      | `HealthKitSync.swift:1289-1293,1303-1321`                 | ✅（目录形状与规范的 `batches/{batchId}/` 不同，语义等价） |
| §4.2 批次 10–20 MB、Canonical HTTPS、禁重定向                                     | 不引 chunk 协议（依赖系统整包续传）；重定向有守卫                                                                                       | 见 1.1 末条                                                  | ✅                                        |
| §5.1 `sync_batches` 表 + `UNIQUE(athlete_id, dataset_epoch, content_hash)` | 🔴 无此表；但**已有等效幂等**：`import_sources.idempotency_key UNIQUE`（= `sha256(serverId\0athleteId\0datasetEpoch\0batchId)`） | `runtime-state.ts:291,324-325`、`server.ts:115-117`        | 🟡 等价物已工作（见 §4.5）                        |
| §5.2 Zip Slip 防御 + 流式 SAX/StAX                                            | ✅ **超出规范要求**：拒绝绝对路径/`..`/NUL/软链/重复路径/文件-目录冲突/Windows 别名，实际字节计量（防"声明小于实际"），压缩比与条目数上限                                | `import-sources.ts:597-720,586-595`                       | ✅                                        |
| §5.2 GPX 点数 / 批次点数配额（50,000 / 200,000）                                    | 🔴 无点数上限（仅插入分批 1000）                                                                                               | `packages/health-export-parser/src/gpx-parser.ts:160-162` | 🔴 见 §4.6                                |
| §5.3 `POST /v1/imports/batch` + `GET /v1/sync/batches/:batchId`           | 🔴 无此二端点；等效物为 `POST /v1/imports/uploads` + `GET /v1/import-jobs/:id`（轮询）                                           | `import-routes.ts:38,117`                                 | 🟡 功能等价，纯命名/契约差异（见 §4.5）                 |

### 1.5 实施纪律（规范 §6.1 Phase 0–9）

| Phase                      | 现状                                                                                                                                      |
| :------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| 0 清理坏代码                    | 🟡 `cancelSync` 误杀**已移除**（`RAIApp.swift:79-84` 改调 `handleEnterBackground()`）；但 `beginBackgroundTask` **仍在包裹整个 `performSync`** —— 见 §4.1 |
| 1 SyncTaskStore 模式升级       | 🟡 是 SQLite + WAL，但只有一张 `sync_tasks(scope,updated_at,payload)`，**无** `sync_transactions` 严格表结构、无 candidate/committed 双列                 |
| 2 Background Delivery 重构   | ✅ 已落地                                                                                                                                   |
| 3 BGProcessingTask 注册与本地落盘 | ✅ 已落地                                                                                                                                   |
| 4 Background URLSession    | ✅ 已落地                                                                                                                                   |
| 5 服务端状态机与流式安全              | 🟡 安全防护超预期；`sync_batches` 表未建                                                                                                           |
| 6 客户端两阶段提交绑定               | ✅ 语义达标（无提前 commit 路径）                                                                                                                   |
| 7 401 拦截与凭证恢复              | ✅ 本次实施                                                                                                                                  |
| 8 Route 状态机                | 🔴 未做                                                                                                                                   |
| 9 回归测试与真机验收                | 🟡 静态/回归已覆盖；**真机验收仍未执行**（清单见 `deliverables/IOS_SYNC_DEVICE_CHECKLIST_2026-09-22.md`）                                                    |

---

## 2. 本次实施（改动清单）

### 2.1 规范 §3.4 —— 锁屏 / Protected Data 防御

**问题（读代码确认）**：锁屏时 `HKAnchoredObjectQuery` 的错误**是被抛出的**（`HealthKitExport.swift:1056-1060`），  
所以**不会**出现"静默把锁屏当成 0 条记录"这一最危险的形态 —— 现状在**数据安全上已经是对的**。  
真正的缺陷是**状态语义**：

1. 无预检查 ⇒ 锁屏时要等第一次查询失败才发现；而更早的 `readAuthorizationState()`  
   （`HealthKitSync.swift:694`）在锁屏时也读不到状态、返回 `.unknown`，于是**先落 `failed`**  
   ——用户看到一次"同步失败"，而解锁后什么都不会自己发生；
2. 无解锁恢复 ⇒ 即使用户手动重试也要等下一次投递。规范 §3.1 的  
   `deferred_protected_data → queued` 那条边**根本不存在**。

**改动**：

| 文件                                                         | 改动                                                                                                                                           |
| :--------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/ios/RAI/SyncPhase.swift:45`                          | 新增 `case deferredProtectedData = "deferred_protected_data"`（蛇形 rawValue，与规范 §3.1 逐字对齐）                                                       |
| `apps/ios/RAI/SyncPhase.swift:77,92`                       | 新增 `blocked` 集合与 🔴 **不变式函数 `mayAdvanceAnchor(_:)`**                                                                                         |
| `apps/ios/RAI/HealthSyncBlockedRecovery.swift`（新，88 行）     | 落点映射 `phase(for:)`、反向 `reason(for:)`、恢复判据 `shouldResume(...)`、批次保留 `keepsLocalArtifacts(_:)`                                                 |
| `apps/ios/RAI/HealthKitExport.swift:40,458,1149`           | 新增 `case databaseLocked`；`isDatabaseInaccessible(_:)` 用 `HKError.Code.errorDatabaseInaccessible`（**不硬编码码元**）；在 `runningWorkouts` 的 catch 里映射 |
| `apps/ios/RAI/HealthKitSync.swift:101-105`                 | 新增唯一来源 `isProtectedDataAvailable`                                                                                                            |
| `apps/ios/RAI/HealthKitSync.swift:533-541`                 | **预检查**：锁屏则落 `deferred_protected_data` + 记意图位 + 立即返回（不握手、不读 HK）                                                                              |
| `apps/ios/RAI/HealthKitSync.swift:899-905`                 | **运行时熔断**：查询途中被锁 ⇒ 同样落阻塞态（兜底 catch **不许**覆盖成 `failed`）                                                                                       |
| `apps/ios/RAI/HealthKitSync.swift:438-440`                 | 后台一轮遇阻塞态**早退**（否则每 15 min 派一次注定失败的导出）                                                                                                        |
| `apps/ios/RAI/HealthKitSync.swift:527-535`（`syncIfNeeded`） | 阻塞态**豁免 15 分钟节流**（条件刚满足就被挡下等于白等一轮）                                                                                                           |
| `apps/ios/RAI/AppDelegate.swift:77-107,227`                | 新增 `observeProtectedDataAvailability()` 监听 `protectedDataDidBecomeAvailableNotification`，解锁后按 `shouldResume` 自动恢复                            |

**两道锁为什么不是二选一**：预检查挡"进来时就已经锁着"，运行时熔断挡"检查通过之后、查询途中被锁上"  
（锁屏可以发生在任意两次 `await` 之间）。

### 2.2 规范 §3.3 —— 后台 401 处理

**问题**：401 落入 `SyncUploadRecovery.disposition` 的第 ④ 分支 `.keepForNextWake`  
（`SyncPhase.swift:196`），即"保留批次、下次再试"——而"下次"每 15 分钟来一次，永远拿到同一个 401。  
规范 §3.3 明确禁止对 401 自动无限重试。

**改动**：

| 文件                                             | 改动                                                                                                                                                      |
| :--------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/ios/RAI/SyncPhase.swift:238-244`         | 新增 `credentialFailureStatuses = [401, 403]` 与 `isCredentialFailure(statusCode:)` —— **刻意不并进** `contentRejectionCodes`（并进去会 `abandonBatch` 删掉一份**有效批次**） |
| `apps/ios/RAI/SyncPhase.swift:53`              | 新增 `case authRequired = "auth_required"`                                                                                                                |
| `apps/ios/RAI/HealthSyncBlockedRecovery.swift` | `case credential` 的落点与恢复判据                                                                                                                              |
| `apps/ios/RAI/HealthKitSync.swift:1076-1086`   | `uploadWithRecovery` **先判凭证**：落 `auth_required`、盘上任务同步改写 `updateTask(phase: .authRequired)`、抛专用 `SyncCredentialRequiredError`                           |
| `apps/ios/RAI/HealthKitSync.swift:907-910`     | 兜底 catch 识别该错误并**直接 return**（不覆盖成 `failed`）                                                                                                             |

**1.1 未做的部分（如实说明）**：规范要求的 **Batch-Scoped Upload Credential**（批次作用域、24h 有效）  
与 **TLS challenge delegate 职责隔离**未实现 —— 现状是单一 `Bearer` token。前者需要服务端新增  
签发端点，属跨端契约变更，见 §4.7。

### 2.3 门禁、回归与展示层

| 文件                                                                  | 改动                                                                                                                                   |
| :------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------- |
| `apps/ios/tests/check-background-capabilities.py`                   | 新增**第 12 节（12a–12h，共 22 条判据）**；修正 `declared` 正则支持带 rawValue 的 case，并**拆成两份口径**（case 名 vs 落盘值）；3c 判据改为剥注释后比对                          |
| `apps/ios/tests/HealthSyncBlockedRecoveryRegression.swift`（新，212 行） | 7 组回归（落盘值稳定、映射往返、**不变式**、非终态、恢复四象限、批次保留、生命周期保留）                                                                                      |
| `apps/ios/tests/run-health-sync-tests.sh`                           | 新增第 6 个编译单元                                                                                                                          |
| `apps/ios/tests/HealthSyncLifecycleRegression.swift`                | 既有断言"非终态一律 `.keepWorking`"需排除阻塞态（它们**没有**在飞工作）——否则回归会红，或更糟：把"在等解锁"记成"正在跑"                                                            |
| `apps/ios/RAI/HealthSyncLifecycle.swift:88-98`                      | `enterBackground` 显式列出两个阻塞态 → `.doNothing`（不落 `default`，避免将来的新阶段静默继承错误判据）                                                            |
| `apps/ios/RAI/Skins/Technology/TechTheme.swift:578-581`             | 两个新阶段的文案（"等待设备解锁"/"等待重新登录"）                                                                                                          |
| `apps/ios/RAI/Skins/Technology/TechSyncPresentation.swift:7-36`     | 阻塞态判为 `.pending`，且**必须排在 `hasPendingTask`/`hasSyncDate` 之前** —— `deferred_protected_data` 恰恰是**盘上没有任务**的阻塞，否则界面会显示"上次同步 12:30"或干脆不显示 |
| `apps/ios/RAI/Skins/Technology/TechSyncStatus.swift:113-137`        | 按阶段分流 `.pending` 的正文与图标（"数据已保存在本机"在锁屏那一支**不成立**）                                                                                     |
| `apps/ios/tests/run-tech-presentation-tests.sh:317-328`             | 展示侧对账改为按**落盘值**收集闭集（原正则同样漏掉带 rawValue 的 case）                                                                                        |
| `docs/IOS_NATIVE_SYNC_PROTOCOL.md:83-97,120-126,148-175`            | 阶段表补两行 + 两条硬约束 + 锁屏双重防御说明 + V2.1 未做项清单                                                                                               |

---

## 3. 验证证据

### 3.1 门禁（实测）

```
npm run test:ios
→ Background capability checks: 162 checks, 0 failed
→ Health sync blocked-recovery regression tests passed
→ Health sync lifecycle / cancellation / resume / atomic-unit / task-migration / background-policy 全通过
```

### 3.2 负面自检（关键：证明判据**不是恒绿**）

把不变式改坏（`mayAdvanceAnchor` 恒返回 `true`）后重跑回归：

```
Fatal error: mayAdvanceAnchor disagrees with isBlocked at deferred_protected_data —
the invariant 'a blocked sync never advances the anchor' is broken
EXIT=132
```


改回后恢复全绿。这证明"阻塞态绝不推进 anchor"这条判据**可被证伪**。

### 3.3 连带修正的三处门禁缺陷（本次暴露）

三处都是同一个根因：**"case 名 == rawValue"这个此前恰好成立的前提**。

1. `check-background-capabilities.py` 的 `declared` 正则漏掉带显式 rawValue 的 case；
2. 同一文件的 3c 判据把"case 名"当"落盘值"比对（`switch phase` 比的是字符串）；
3. `run-tech-presentation-tests.sh:321` 同源 —— 会同时报"没有标签"和"标签是死的"两条**假红**。

> 顺手发现第 4 处：3c 判据只剥整段注释才可信，因为它抓的 `switch` 块里，注释逐字写着阶段名  
> （"非终态一律 keepWorking"这类），整段抓会把中文短语当成阶段。

### 3.4 node 侧

`npm test` 在本机跑到 305 个测试**全部 `ok`、0 fail** 后被 SIGTERM（本机资源限制，  
已知问题，见工作区记忆）。本次改动 100% 位于 `apps/ios/`，且 `check-background-capabilities.py`  
对 `apps/api/src/*.ts` 的跨仓核对已通过，node 侧不受影响。

---

## 4. 仍需确认 / 后续处理

### 4.1 🟡 `beginBackgroundTask` —— 规范与现行门禁的冲突（**已定案：零行为变更**）

- 规范 §Phase 0 明文要求「移除 `HealthKitSync.swift` 中使用 `beginBackgroundTask` 强行包裹整套流程的操作」；
- 本仓结构门禁 `check-background-capabilities.py:269-281` **要求它存在**（`len(background_task_lines) >= 1`），  
  并只约束"到期走 `suspendForLifecycle()`、不许 `cancelSync()`"；
- 现状：`HealthKitSync.swift:506-519` 确实包裹整个 `performSync`，但 `expirationHandler`  
  已正确走 lifecycle（不冒充用户取消）。

**两种改法各有代价**：移除它 = 用户点同步后立刻切后台会被系统挂起（只能靠 BGTask 续，
而 BGTask 是"择机"而非"立刻"）；保留它 = 正式偏离规范 Phase 0。

**定案（2026-09-23 本轮）**：**保留，零行为变更**，只把口径写清（见下文三点）。原建议"把续期范围收窄到
收尾落盘"**已被红队推翻**并撤回：收窄后 `performSync` 中途被系统收回时间就真的会被挂起，
等于用一次真实的可用性退化去换一次"与规范字面一致"，而规范要防的"系统到期被当成用户取消"
在 `expirationHandler → suspendForLifecycle()` 里**已经防住了**。判别理由三条：

1. 移除或收窄都**拿不出可证伪的收益**（没有"规范化后哪个场景变对了"的判据）；
2. 现有实现已满足规范的**意图**（到期不冒充用户取消），只是**形式**上仍包裹整个流程；
3. 门禁要求它存在是**有意**的（`check-background-capabilities.py:320-331` 还钉住
   "`suspendForLifecycle()` 在窗口内、`cancelSync()` 不在"）—— 改它等于同时改行为契约与门禁契约。

因此这条记为**有意偏离规范 §Phase 0**，不再列为待办。

### 4.2 ✅ anchor / 水位已收进 SQLite 单事务（规范原则 3）—— *本节为改动前的分析，保留作记录*

现状分工：任务进度在 `sync_tasks`（SQLite/WAL），anchor 与导出水位在 `UserDefaults`  
（`HealthKitSync.swift:983,991,994,999` —— 勘误：本表早先写的 `:906,914,917,922` 是**改动前**的行号）。
**两阶段提交因此不是原子的**（写 anchor 与清任务跨两个存储）。**2026-09-23 已实施**，见下方 §4.2 的收尾说明。

- **实际风险等级：低** —— 两种崩溃方向都不会写坏数据（anchor 写了任务没清 ⇒ 幂等重跑；  
  任务清了 anchor 没写 ⇒ 重导一段窗口）。所以本次没动它。
- **要做的话**：新增 `sync_state` 表（或规范的 `sync_transactions`）承接 anchor，`markSuccess`  
  内用**单事务**同时写 anchor 与清任务，并保留"新表未命中 ⇒ 回退读 UserDefaults"的迁移路径。  
  需要你确认是否排期 —— 它有**升级期窗口重导**的迁移代价。

### 4.3 🟡 `enableBackgroundDelivery` 的 frequency

现状 `.hourly`（`HealthKitSync.swift:323`）。规范未指定取值。改成 `.immediate` 会让唤醒更频繁、  
耗电更高，且系统本身仍会节流。**建议维持 `.hourly`**，除非真机验收发现"新跑步要等太久才同步"。

### 4.4 🔴 Route 回填仍是 14 天窗口（规范 §3.5）

现状：`HealthKitExport.swift:179`（常量）、`:425-439`（回填分支）—— 勘误：本表早先写的
`:168,414-428` 是**改动前**的行号。锚定同步时回看的窗口是 14 天，  
对**每个** workout 重取路线。规范要求按单 workout 建 `UNKNOWN → ACTIVE → COOLING → SETTLED` 状态机  
（0–24h 必查 / 1–3d 降频 12h / >3d 彻底休眠）。

**未做的理由**：它要新增一份"每个 workout 的路线稳定性"持久状态（`routeAnchor` 概念在代码里**完全不存在**），
并把 `HealthKitExportResult` 的输入输出一并改掉 —— 是一次独立的重构，混进本次会让两个改动互相掩护。
**收益**是稳态下省掉大部分 Route 查询（`HKWorkoutRouteQuery` 是导出里最慢的一步）。

**本轮（2026-09-23 增补）实际做了的**：只把这条**钉进判据**（窗口常量、14 天常量与回填分支的锚点），
让"有人顺手把窗口改成别的值 / 把回填删掉"会红；状态机本身仍未做 —— 记为**待排期的独立重构**。

### 4.5 🟡 服务端 `sync_batches` 表 / 新端点 —— 建议**不新建**

规范 §5.1/§5.3 要求的 `sync_batches` 表与 `POST /v1/imports/batch`、`GET /v1/sync/batches/:batchId`，  
在代码里**都不存在**；但等价能力已经工作：

- 幂等：`import_sources.idempotency_key UNIQUE` = `sha256(serverId\0athleteId\0datasetEpoch\0batchId)`  
  （`server.ts:115-117`、`runtime-state.ts:291`）—— 语义上与规范的 `UNIQUE(athlete_id, dataset_epoch, content_hash)` **等价**；
- 状态查询：`GET /v1/import-jobs/:id` 提供 `status/phase/progress`（轮询）。

**新建表 + 新端点 = 两套幂等机制并存**，而线上正跑着的那套已经在多轮审计里被验证。  
**建议保持现状**，除非你要的是"契约与规范逐字一致"。若确实要改，必须**先决定旧端点是否下线**。

### 4.6 ✅ 服务端 GPX 配额已实施（规范 §5.2）—— *本节为改动前的分析，保留作记录*

规范要求：单 GPX > 20 MB ⇒ 413；单 workout 轨迹 > 50,000 点 ⇒ 422；整批 > 200,000 点 ⇒ 422。  
现状**无点数上限**（`gpx-parser.ts:160-162` 只有插入分批 1000）。

**这是本次唯一"纯增量、无争议"的后续项**，实现也直接（流式解析器里加计数器 + 熔断），  
但它在服务端 + 需要配套测试，所以未混进本次。**建议下一批优先做**。

### 4.7 🟡 Batch-Scoped Upload Credential（规范 §3.3）

规范要求"批次作用域、24h、仅对特定 `batchId` 有效"的上传凭证。现状是单一 `Bearer` token。

**未做的理由**：需要服务端新增签发/校验端点（跨端契约变更），且当前 `Bearer` 已由  
`local-request-security.ts` 严格门禁。本次只把**客户端的失败处置**做对了（401 → `auth_required`，  
不再无限重试）—— 这是规范 §3.3 里真正影响正确性的那一半。

### 4.8 ⚠️ 无法在本机确认的事项

- **锁屏路径的真机行为**：模拟器无法触发 `errorDatabaseInaccessible`，也无法验证  
  `protectedDataDidBecomeAvailable` 通知的真实时序 ⇒ 必须真机验收（清单见  
  `deliverables/IOS_SYNC_DEVICE_CHECKLIST_2026-09-22.md`）。
- **`errorDatabaseInaccessible` 的码元是否被 SDK 调整**：代码用 `HKError.Code.errorDatabaseInaccessible`  
  （不硬编码），但**未在真机/模拟器上实测过该错误码真的会以这个形态抛出**。
- **门禁突变验证**：`check-background-mutations.py`（会改写源码、约 4.5 分钟）本次**未运行**；  
  我已用一次手动负面自检（§3.2）替代验证"新判据会红"。新增判据的**突变项**尚未补进该脚本。

---

## 5. 回滚方式

本次改动是**纯增量 + 局部**，回滚粒度可按需选择：

| 粒度         | 操作                                                                           | 影响                                                          |
| :--------- | :--------------------------------------------------------------------------- | :---------------------------------------------------------- |
| 完全回滚       | `git checkout -- apps/ios/ docs/` + 删除两个新文件                                  | 回到改动前；`sync_tasks` 里**不会有**阻塞态的旧数据（这两个状态只在内存与运行时写入，老任务不受影响） |
| 仅关掉解锁自动恢复  | 注释 `AppDelegate.swift:227` 的 `RaiStartup.observeProtectedDataAvailability()` | 锁屏仍会落 `deferred_protected_data`（不再是 `failed`），只是不会自动恢复      |
| 仅关掉 401 分流 | 断开 `HealthKitSync.swift:1076` 的分支                                            | 401 回到 `.keepForNextWake` 的旧行为（后台会重撞）                       |
| 判据回滚       | 只还原 `apps/ios/tests/*`                                                       | 代码行为不变，门禁回到改动前                                              |

**兼容性**：两个新阶段的 `rawValue` 与老 payload 无冲突（老值集合未变），  
`SyncPhase.migrate` 对未知值仍落 `.idle`，所以**升级/降级都不需要数据迁移**。

---

## 6. 验收标准（建议）

- [x] `npm run test:ios` → 0 failed（实测 162 checks / 0 failed）
- [x] 破坏 `mayAdvanceAnchor` 不变式 ⇒ 回归必须红（实测已验）
- [ ] **真机**：设置锁屏密码的 iPhone 上，锁屏时触发同步 ⇒ 界面显示"等待设备解锁"（**不是**"同步失败"），  
  解锁后**自动**继续；`os_log` 中出现 `protected data became available; resuming the blocked sync`
- [ ] **真机**：把服务端 token 临时置为失效 ⇒ 界面显示"等待重新登录"，本地 ZIP/multipart **仍在**，  
  且后台不再每 15 分钟重撞上传端点（服务端日志中该批次不再重复出现）
- [ ] 真机：确认锁屏时 `sync_tasks` 的 anchor **未被推进**（对比同步前后的 anchor 值）
