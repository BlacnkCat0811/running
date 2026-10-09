# RAI 原生 iOS 同步协议

状态：P4 持久化准备 + P1 原子单元闭环 + **P2 后台三机制**均已落地代码（2026-09-22）。
三项机制——HealthKit background delivery（唤醒触发器）、`BGProcessingTask`（主载荷）、带 identifier 的
background `URLSession`（字节搬运）——都已在 `apps/ios/RAI/` 里接线，静态判据由
`tests/check-background-capabilities.py` 与 `BackgroundSyncPolicyRegression` 钉住
（判据有效性由 `npm run test:ios:mutation` 逐条突变验证；
日常改动用 `npm run test:ios:mutation:scope` 按改动范围裁剪 —— 它只看改动文件落在哪个门禁的输入里，
**不是**验收手段，产物带 `partial: true`）。
🔴 **但"代码走到了"不等于"在真机上被调度了"**：真机验收是一个**独立验收项**，完成前不得把
静态审查或模拟器构建写成"后台可用"（判据见文末）。在那之前，前台行为与 P1 完全一致；
唯一已确定改变的是"切到后台"不再等于"用户取消"。HealthKit 导出仍复用
`HealthKitExport.swift` 的 ZIP/XML 管道。

anchor/导出水位在 `sync_state` 单事务提交；服务端 GPX 有字节/点数/批次点数限额。
Route 使用逐 workout 的 UNKNOWN → ACTIVE → COOLING → SETTLED 伴生状态机。
取舍与失败方向见 [ADR-004](adr/ADR-004-healthkit-sync-invariants.md)，真机步骤见 [runbook](IOS_NATIVE_RUNBOOK.md)。
旧机器收益和历史批次计数不作为当前性能承诺。

2026-10-09：非 Workout 记录改为逐类型、无事件日期过滤的分页 anchored 增量。
v2 manifest 携带类型作用域 UUID 删除，服务端 v30 映射保留历史数据库 ID；
新增能力字段不改变原有同步身份版本。迁移、兼容性及升级边界见
[HealthKit 记录同步 v2](HEALTHKIT_RECORD_SYNC_V2.md)。

## 状态机

**会话边界**是这套状态机的第一等概念：`upload → inspect → startImport` 三步
构成一个**原子单元**，必须在同一次唤醒内走完；只有"拿着 `jobId` 等终态"允许跨会话。
理由是服务端不改（2026-09-22 决策 D1）：成功导入过的 HealthKit 上传会被 retain
（留记录、**删目录**），因此**不得假设 `sourceId` 可跨小时复用**。

```text
[同一次唤醒内必须走完 —— 原子单元]
待执行 -> 采集(collecting) -> 本地批次落盘(exported) -> 上传(uploading)
       -> 已上传(uploaded) -> 服务端检查(inspect) -> 创建导入任务(startImport)

[允许跨会话 —— 由 jobId 续接]
       -> 等待终态(importing) -> 服务端成功 -> 提交 anchor/水位 -> 清理本地产物
```

阶段取值是一个**闭集**，唯一来源是 `apps/ios/RAI/SyncPhase.swift` 的 `SyncPhase`；
`HealthSyncLifecycle.persistedPhases` 与 `terminalPhases` 都由它派生，客户端不再手打阶段名
（结构门禁 `tests/check-background-capabilities.py` 会红）。
`recomputing` 只存在于**老 payload** 里，语义与 `importing` 相同，`SyncPhase.migrate` 会归一。

本机 `sync.sqlite` 的 `sync_tasks` 表按服务作用域保存当前任务 JSON。旧版本写入 `UserDefaults` 的任务会在首次读取时迁移。页面缓存使用独立的 `cache.sqlite`，清页面缓存不会清除同步任务。

同库还有一张 `sync_state` 表（`scope` 主键 / `workout_anchor` / `export_end` / `updated_at`），存**已提交的** anchor 与导出水位。
`sync_record_cursors` 保存按 scope 隔离的非 Workout 各类型 anchor；它与水位、任务删除
共同进入 `commitSuccess` 事务并在 COMMIT 前回读校验，而非采用 Route 的成功后 best-effort 写入。
两张表在成功收尾时由**同一个事务**写入（`SyncTaskStore.commitSuccess`）。为什么非要在同一事务里：两份状态是
"这次同步已提交"的两半，拆开就存在「任务行删成功、水位写失败」这个窗口 —— 结果是**旧 anchor + 没有任务 + 界面报成功**
⇒ 每次同步重导同一段；而导出里带 `<ExportDate>`（墙钟）⇒ `payloadHash` 每次都变 ⇒ 服务端**每次新建一份导入来源**。
用户在这一路上看不到任何异常。此外：

- 事务内**先读旧值再写**，然后在 `COMMIT` 之前**回读断言**（比对"应该写成的值"，`.advance` 是单调取大）；
  断言放在提交前而不是提交后 —— 提交后失败会把一份**已经入库**的数据报成"同步失败"，而同一屏的"上次同步：刚刚"刚被写好。
- 🔴 落盘 REAL 时间列之前，先把时间点吸附到该映射的**不动点**（`Date.canonicalForREAL`）：
  `Date` ↔ `timeIntervalSince1970` **不是双射**（实测逐 ulp 扫 200,000 个真实时间戳，**恰好一半有损**），
  而 `exportedThrough` / `routeNow` 都是带小数秒的 `Date()` ⇒ 回读断言会按约一半的概率把一次
  **完全成功的**提交判成失败并整段回滚，用户看到「同步水位写入后无法读回一致的值」。
  写与断言必须**共用同一个规范化后的值**；`sync_route_state` 那一侧还要连**参与比较的 record** 一起规范化。
  详见 `docs/adr/ADR-004-healthkit-sync-invariants.md` 补充 C。
- `DELETE FROM sync_tasks` 要校验 `sqlite3_changes() == 1`：删 0 行在原地是**静默**的（旧的 `clear(scope:)` 只判
  `sqlite3_step == SQLITE_DONE`），于是"我以为提交了"可以是假的。
- 提交前还要过 `SyncStateCommitPlan.mayCommit`（= `SyncPhase.mayAdvanceAnchor`）：**阻塞态绝不推进 anchor**。
- `scope` 从未提交过时**没有行**（不是"两个字段都是空"）—— 迁移期正是靠这个区分退回读老 `UserDefaults` 键；
  「重新导入全部」用 `forgetState` 删**整行**，并**同时**删掉老键，否则回退路径会把刚忘掉的锚读回来。

当前任务数据包含：目标 URL、阶段、source ID、job ID、批次校验值、待确认 HealthKit anchor、导出结束时间和跑步数量；P1 另加 `schemaVersion` 与一组**只存文件名**的产物字段
（`zipFileName` / `multipartFileName` / `multipartBoundary` / `uploadState` …）。
v2 另存可选的 `pendingRecordCursors`，四条恢复成功路径都提交这份原批次的候选游标；
老任务缺字段仍可恢复，且不清除已经提交的记录游标。新导出与 v2 批次恢复均检查服务端记录能力。
🔴 `uploadTaskId` 这个键**目前没有任何写入点**：判据用的是 `RaiBackgroundUploadSession` 内部按
identifier 索引的两张表（`waiters` / `descriptions`），把它当"字节归系统"的依据会得到**恒假**，
于是每次唤醒都重传一遍。结构门禁会拦下这类读取。
任务在上传前创建，在 source/job ID 变化后立即更新；批次校验值（`payloadHash`）同时作为
`X-RAI-Sync-Batch` 幂等标识传给服务端。服务端重复收到同一标识时返回原来源；服务端成功前不会推进普通导出水位。

### 按 workout 定频：Route 伴生状态机

同库还有第三张表 `sync_route_state`（复合主键 `(scope, workout_uuid)`，UUID 小写化，口径同 `HealthKitExport.routeFileWorkoutId`），
存**每条 workout 的路线查询记忆**。它是"降频记忆"，和 `sync_state` 一样必须与任务同库 ——
**不许落 `UserDefaults`、不许落独立 JSON、不许落内存单例**（门禁判 `UserDefaults` 零出现）。

状态的主键是 workout uuid：先用 `HKQuery.predicateForObjects(from:)` 找到所属 route sample，
再用 `HKWorkoutRouteQuery` 逐点取回。sample 的变化通知不能证明路线点已经完整到达或可读，
所以降频依据是每个 workout 的点数/摘要观测，而不是通知或 sample anchor。
这是 **Workout-Scoped Companion State**。

四态闭集 `unknown` / `active`（24 h，按 **workout 年龄**而非"距上次查询"）/ `cooling`
（查询节流 12 h，按 `lastCheckedAt`）/ `settled`（`> 3 d` 后转入低频复查）。判据在
`RouteSyncStateMachine`（纯函数、无副作用、可 100% 单测），落盘在
`SyncTaskStore.loadRouteStates` / `upsertRouteStates`（`BEGIN IMMEDIATE` 单事务 + 逐行
`sqlite3_changes() == 1` + 提交**前**回读断言，与 `commitSuccess` 同源）。

🔴 两条不变式，各自都有独立回归 + 突变验证：

1. **「跳过一轮」绝不改动任何状态**（`lastCheckedAt` 不动、`stableCheckCount` 不加）。
   破了它不是报错，是**静默丢数据**：一条刚变更过的轨迹会被当成"又一次确认稳定"，
   直接降到 `settled`，错过及时补齐窗口。
   这与 `ADR-004` 决策二「没读到 ≠ 没变化」是同一条不变式在客户端的另一处落点。
2. **降频记忆只在 `commitSuccess` 之后落盘**（`HealthKitSync.markSuccess`）。
   反方向会造出**不可自愈**的窗口：状态机记成"已稳定、可以少查"，而这一批数据从未真正交付
   （上传失败 / 导入失败 / 进程被杀），之后一路降到 `settled`。现在这个方向最坏只是"下一轮多查一次"。
   记忆写失败**不**让本次同步变红（durable 的部分已经提交），但**不静默**：推 `taskStore.lastError` + `NSLog`。

`RouteSyncStateMachine.decide` 的输出契约是 `Decision { shouldQuery, nextState }`；
`shouldQuery == false` 时 `nextState` **原样携带**，这条由一条对全部状态成立的遍历断言守。

**受控重新发现（2026-10-09）**：`settled` 的空路线（零点数或无摘要）每 24 h、
已有路线每 7 d 才有资格复查，均从上次实际查询计时；复查无变化继续休眠，
点数或摘要变化回到 `active` 并清零稳定计数。Workout anchor 返回的真实新增/变化
可以绕过路线节流；最近窗口回读不算变化。路线类型加入既有 HealthKit observer /
后台意图链路，但通知本身不会触发全历史轨迹扫描，也不保证当轮立即查询所有路线。

每次正常导出最多额外处理 **20 条历史/休眠候选**，其中也包含近期窗口内的休眠路线；
窗口外的 `unknown` / `active` / 到期 `cooling` 同样可进入队列。历史 workout 按
候选 UUID 定点取回，不依赖最近 14 天窗口。`sync_route_discovery` 按 scope 持久化
字典序轮转位置，和观测同事务、在成功交付之后 best-effort 写入；它不是 HealthKit anchor。
已删除/不可读的 workout 也跨过候选位置，但不改动观测，防止队首饿死其他路线。
候选位置随 ZIP 写入任务的可选 `pendingRouteDiscoveryCursor`，四个续传成功分支同样推进它，
避免每批都因后台中断而永久卡在首批；旧任务缺字段仍可恢复。点数/摘要观测仍仅在本轮导出
直接完成时落盘，续传后仍以旧观测判定频率（可能重复查询，不会漏掉路线），
不能为不可读的 workout 伪造观测。

HealthKit 不暴露读取权限是否被授予，因此后续开放路线权限通过低频复查恢复，
不靠猜测授权布尔值。查询报权限/无数据错误或任一段读取失败时，观测为 `nil`，
不推进 `lastCheckedAt` / 稳定计数，也不输出部分 GPX；成功查询返回空集合仍是合法零点观测。
以上间隔只约束既有同步机会，不新增后台定时机制；`full` 人工重扫仍不受间隔和批量上限限制。

## 字节归谁：唯一判据是「本进程还在等它的结局吗」

`uploading` 之后，字节可能同时有两个"主人"：我方的等待者，与系统持有的传输任务。这两件事在
**生命周期中止**时分离——中止要的是**前者停下、后者继续**（那正是 background `URLSession` 的全部价值），
所以 `RaiBackgroundUploadSession.abandonWaiting` 只摘等待者，**不**碰 `URLSessionTask`。

于是"这个系统任务要不要留"必须由一个明确判据回答，它是纯函数
`BackgroundUploadReattach.disposition(isAwaitedInThisProcess:)`：**在 `waiters` 里就留，否则取消**。

- 判据**不是**"它属于哪一批"。服务端没有按批次查来源的接口（`sourceByIdempotencyKey` 只在
  `saveUpload` 内部用；`GET /v1/import-sources/recent` 只返回 `lastUsedAt != null` 的来源，而
  "已上传未导入"恰好是 `null`），所以上个进程那次上传的**结局拿不回来** —— `sourceId` 只能靠
  **重传同一份字节**让服务端幂等命中（`import-sources.ts` 按归档字节比对，返回同一条来源）。
  既然横竖要重传，留着一个仍在跑的上传只是让两份同样的字节同时打向服务端，其中一份必然撞
  `import_upload_busy`（429）。
- 判据**也不是**"登记过没有"。生命周期中止之后登记还在而等待者已被摘掉，那正是**要取消**的状态；
  拿登记当判据，会让"中止之后重进一次同步"变成两份字节同时在传。

调用点三处，全部在"准备发起（或重新打算发起）一次上传之前"：`performSync` 推导下一步之前、
`runBackgroundPass` 决定推进哪一步之前、`handleEnterBackground`（走同步可读的快速判据
`hasInFlightUpload`，因为切后台的处理必须在几十毫秒内返回）。

盘点结果里 `matchesCurrentBatch` **不是判据**（两种取值下的动作都是取消），它只决定**重传的代价**：
命中 ⇒ 服务端不新建来源；不命中 ⇒ 服务端多一份没人来取的来源（靠 24h TTL 回收）。真机验收要靠这个数
把"白传了一次字节"与"服务端多了一份垃圾"分开——只看日志这两件事长得一模一样。

**已知的、有意接受的一处冗余**：生命周期中止发生在传输途中时，那次上传的结局会被丢弃（等待者已摘），
所以下一次同步会把这批字节**完整重传一遍**（幂等，不会多出来源）。在真机上这是常见路径而非罕见路径
（`beginBackgroundTask` 只有约 30 秒，而全量导出可以是几个 GB）。要消掉它需要一条"把孤儿结局写回
`sync_tasks`"的通道；那是一条新的持久化不变式，收益只是省一次带宽，所以**先不做**，改为在真机验收里
测量它的实际发生率与代价。

三个上传相关阶段互不替代，边界如下：

| 阶段 | 含义 | 允许跨会话 |
| --- | --- | --- |
| `uploading` | multipart 已就绪，传输在途 | 否 |
| `uploaded` | 服务端已收下这一批（`sourceId` 已落盘），`inspect`/`startImport` 未完成 | 否 |
| `importing` | `jobId` 已落盘，等服务端终态 | **是** |
| `deferred_protected_data` | 设备锁屏 / 开机后未首次解锁，健康数据库硬件加密不可读（V2.1 §3.4） | 取决于盘上任务 |
| `auth_required` | 批次凭证失效（401/403），本地批次完好（V2.1 §3.3） | 取决于盘上任务 |

**两个阻塞态**（`SyncPhase.blocked`）不是终态、也**不是**在飞的工作 —— 它们在等一个外部条件。
两条硬约束：

1. 🔴 **阻塞态绝不推进 anchor。** "这次没读到"（锁屏）与"这次没送达"（401）都**不是**
   "数据没有变化"的证据；把前者当成后者，那段健康数据会被**永久**跳过（下次查询从新水位起步，
   它再也不会出现在任何一次导出里）。判据是 `SyncPhase.mayAdvanceAnchor`，由
   `HealthSyncBlockedRecoveryRegression` 执行，结构门禁钉住它的存在。
2. **落点与恢复判据只有一份**（`HealthSyncBlockedRecovery`）：`deferred_protected_data` 由
   `protectedDataDidBecomeAvailable`（用户解锁）唤醒，`auth_required` 由"回到前台且凭证已就绪"唤醒。
   唤醒这两个阶段的是**外部条件而不是时间** —— 所以后台一轮（`runBackgroundPass`）遇到阻塞态
   直接早退（否则每 15 分钟派一次注定失败的导出/上传），而 `syncIfNeeded` 的 15 分钟节流
   对阻塞态**不生效**（条件刚满足就被节流挡下等于白等一轮）。

⚠️ P2-4 之后 `uploading` 这一行要读准：**传输本身**可以跨会话（字节归系统），但这一阶段属于
**原子单元**、其中的"拿到 `sourceId`"跨不了会话 —— 重启后系统手上那次传输的结局拿不回来
（服务端没有按批次查来源的接口），只能靠重传同一份字节让幂等命中重新拿回 `sourceId`。
所以"允许跨会话 = 否"说的是**原子单元的推进**，不是"字节不会继续传"。

v1 不单独设置“确认游标”端点：导入 job 的 `succeeded` 状态只在服务端完成数据库激活、审计文件发布和终态 job 持久化后返回。手机把这个持久化终态作为服务端确认，再提交本地待确认 anchor 和导出水位；若 App 在此后退出，恢复时先查询已有 source/job，不重新产生业务数据。未来若服务端拆分导入发布和游标确认，可在保持本状态机的前提下增加独立端点。

🔴 **`inspect` 是 `POST /v1/import-jobs` 的强制前置门。** 成功导入过的 HealthKit 上传会被
服务端 retain（`import-source-finalization.ts`：记录在、目录已删），对这类来源直接建任务
只会得到一个必然失败的 job。`inspect` 返回 `unchanged` 时必须走"删除暂存来源 + 提交游标"分支，
**不得创建任务**。

恢复时**下一步由字段推导**（`SyncAtomicUnit.nextStep`：`jobId` > `sourceId` > 本地文件），
不按阶段文字猜。2026-09-22 的线上死锁正是"按阶段猜"的后果：当时 `uploaded` 与 `importing`
被混写成同一个 `importing`，恢复分支只能二选一，线上的表现是 nginx 里**再没有出现过任何 uploads**。

## 重试与恢复

- 上传、检查、创建导入任务使用最多三次退避重试。**上传本身只尝试一次**（600s 超时 ×3 最坏阻塞
  30 分钟，超过整个导入窗口），唯一例外是服务端说"现在不行"（429 `import_upload_busy`）——
  那会退避一次后用**同一个 batchId** 重试。
- `401`/`403` 立即停止并落 `auth_required`：本地批次**完好**，缺的只是通道，所以**不删产物**、
  也**不在后台自动重试**（每次唤醒撞同一个 401，永远好不了）。等前台拿到有效凭证后用**同一个
  `batchId`** 重传 —— 服务端按归档字节幂等命中同一条来源。不兼容协议和坏数据立即停止。
- 上传失败分三态，判据在 `SyncUploadRecovery`（每个错误码都能在服务端源码里找到出处，
  结构门禁会做跨仓核对）：瞬时失败保留批次同 batchId 重传；并发占用退避重试；**服务端确定性拒绝
  的批次永不重传**（连本地产物一起作废）。凭证失败（401/403）是**第四态**、刻意不并进上面三态
  —— 并进"确定性拒绝"会删掉一份有效批次，并进默认的"保留等下次"又会在后台无限空转。
- 导入任务轮询最长 30 分钟；短暂轮询失败会重新连接，连续失败后**保留 jobId 与任务**，
  等下次唤醒续接（服务端没有推送机制，后台空转轮询零收益）。
- 本地产物（`Application Support/rai-healthkit-<scope>/upload-<payloadHash>.{zip,multipart}`）
  的生命周期由**终结结果**驱动：成功时删、服务端确定性拒绝时删、瞬时失败时**留着**给下次唤醒续传。
  刻意不落 `/tmp`（系统会清理，失效方式是"某天起续传悄悄变成重导"）。
  🔴 因此 `upload()` 里**没有** `defer { removeItem }`：函数返回只代表"这次等待结束了"，
  不代表系统不再搬这批字节（生命周期中止会把等待者摘掉而让传输继续）。
- 启动/发起上传之前先盘点系统手上的传输（"字节归谁"一节）：**没人在等结局的**一律取消，
  由这一轮用盘上的字节重传，避免两份同样的字节同时打向服务端。
- 任务有 source ID 时先查询并恢复已有 source/job，不重新产生业务记录；创建导入任务遇到已有活动任务时先读取活动任务并按 source ID 接续。
- 同步成功后才清除本地产物与任务。**失败时任务被刻意留着**：它就是"下次接着传"那条记录，
  `SyncAtomicUnit` 下次会从同一份产物、同一个 batchId 继续。
- 每个服务地址使用独立作用域；切换服务不会复用游标、任务或失败上传。

## HealthKit 规则

跑步 anchor 与时间窗口采用重叠补查；每次 anchored 增量同步还会回读最近 14 天的跑步，用于发现训练保存后才到达的路线。**这条 14 天窗口现在只决定"候选集"**——真正的路线查询由逐 workout 的伴生状态机决定（见上文「按 workout 定频」），所以"在窗口里"不再等于"每次同步都重拉轨迹"。恢复、HRV、静息心率及其他数量记录使用独立类型 anchor，不再随事件日期窗口导出；初次升级读取可见历史，手动同步及达到补读间隔后的后台同步重读历史以覆盖权限扩大。部分读取权限或没有样本会形成空/部分结果，不解释为远程删除。Workout 删除保持原 UUID 语义；非 Workout 删除由 v2 清单携带 `{type, uuid}`，服务端通过持久化源映射及 tombstone 处理来源失效。

🔴 **锁屏（Protected Data）是两道锁，不是一道。** 设备锁屏、或开机后尚未首次解锁时，HealthKit
数据库被硬件级加密锁死，**任何**读取都会被拒（`HKError.errorDatabaseInaccessible`）：

1. 进 `performSync` 时先查 `UIApplication.isProtectedDataAvailable`，锁着就**不去读**，直接落
   `deferred_protected_data`。这道预检查刻意排在握手与 `readAuthorizationState()` **之前** ——
   后者在锁屏时同样读不到状态、会返回 `.unknown`，排在它后面就会被先落成 `failed`
   （一次正常锁屏被报成"同步失败"，且解锁后不会自己恢复）；
2. 检查通过之后设备仍可能在查询途中被锁上，所以 `HealthKitExport.runningWorkouts` 另外把
   `errorDatabaseInaccessible` 映射成 `HealthKitExportError.databaseLocked`。两道锁挡的是两件事，
   不是二选一。

⚠️ 这一条**不是**"能不能读到"的优化，而是"会不会丢数据"的护栏：`errorDatabaseInaccessible`
与 `errorNoData` 的码相邻，而后者确实该被当成"空结果"。因此 `optionalSamples` 只吞
`errorNoData` 与鉴权错误，锁屏错误一律抛出到调用方 —— 一旦有人把两者合并，"锁屏"就会变成
"这份数据是空的"，Anchor 随之推进，那段数据永久跳过。


## 冷启动恢复、轨迹隔离与意图交接

后台读取任务前，在单飞所有权内从既有 `rai.handshake.<64位URL哈希>` 恢复 URL、离线身份和同步 scope。
离线身份只决定是否启动工作；真正执行仍以在线握手为准，并更新同一缓存。健康数据通知显式携带目标 URL，
不依赖本进程曾经前台同步。日志读取失败保守保留待办，不能当成空队列。

轨迹降频记忆按同步 scope 隔离（含 serverId、athleteId、datasetEpoch）。`sync.sqlite` 的 `user_version=2`
迁移在事务中重建旧轨迹表，丢弃无法确定归属的降频记忆；任务与水位保留。重复打开不再清除新表。

后台意图采用代次，在本批任务可靠落盘或同步提交成功后才确认。握手/导出/写盘失败和生命周期中断不确认。
新通知写入的新代次不被旧批次确认；续传时已存在的新数据意图保留给后续导出。
生产存储器和交接协调器由 `HealthSyncBackgroundRecoveryRegression` 执行，scope/迁移由真实 SQLite 回归执行。

真机仍需验证冷启动实际续传、新 scope GPX 交付，以及看门狗在 BGProcessingTask 下的预算读数；本机门禁不替代真机验收。

## 按目标读取的待办快照、恢复请求与受控重开

**待办快照（只读探针）**。判据是 `HealthKitSync.probePendingWork(for:)`：按**目标 URL** 现读，
返回 `HealthSyncBackgroundRecovery.PendingWork`，其中 `verdict` 有三值 ——
`pending`（该目标盘上有任务行）/ `empty`（确认空：身份已知且两个候选 scope 都没有行，
或身份未知但整库无行）/ `unknown`（读盘失败，或库里有行却都无法归属到本目标）。
`.unknown` **不许**当成"没有待办"：调度（`shouldResubmit`）把三值里除 `empty` 以外的都算"还有事"，
回执（`reportedSuccess`）只在 `empty` 且没有挂着的意图/恢复请求时才报成功。
`BGProcessingTask` 的重排与完成回执、`applicationDidEnterBackground` 的重排、观察者的投递决策
一律用快照，**不用** `HealthKitSync.hasPendingTask` 那个展示标志（原先给调度用的
`hasBackgroundIntent` / `hasBackgroundIntent(for:)` 访问器随本轮删除，因为"这个目标有没有意图"
现在只能由快照回答）—— 展示标志属于最后一次写它们的那个目标，而单飞闸门拒绝的一轮什么都没碰过。
探针只读：不改 `active*`、不重开或迁移数据库、不删文件；数据库不可用时返回 `unknown`。
`loadTask()` 不能当探针：它认 `activeScope`，且会把老 `UserDefaults` 候选补写回 `sync_tasks`。

**意图的成因与观察点**。意图分两类、分开存：`healthData`（HealthKit 真实投递）与
`scopeRecovery`（在线握手确认权威 scope 变了 ⇒ 新 scope 还没批次）。二者不共用一个槽，
否则一次旧 scope 的成功会顺手确认掉新 scope 的重试依据。
取消"有旧任务就合成新数据意图"：旧任务本身就是重试依据，合成出来的通知永远等不到确认（确认点只在导出起点），
最终变成一次多余的全量导出。人工取消**不再**丢弃意图/恢复请求（中止的是这一趟，不是那条通知）。
两个成因的观察点都在**导出起点**（`observeBackgroundIntentsForExportStart`）：只有"这一次导出真的开始了"
才能说"它覆盖了那条通知"，代次比对排掉导出期间新到的通知；`inspect` 续接与重传已落盘 ZIP 两条
恢复分支不重新读 HealthKit，因此不可能替通知背书。前台与后台共用这一处与同一个确认函数。
`HealthSyncIdentityPublisher.publish` 是 Native 页面连接、刷新与 HealthKit 同步的统一在线身份发布入口：
它先比较旧、新 sync scope，并在变化时将目标 scope 与代次写成恢复请求，再写既有握手缓存键。
旧 scope 的完成或旧代次不能清除新 scope 的请求；只有新 scope 导出后的任务落盘或成功提交才能确认。
反过来的崩溃窗口里新身份已发布、盘上什么都没记，下一轮纯后台冷启动会静默 `nothingToDo`。

**受控重开**。`SyncTaskStore` 打开或迁移失败时不再只能靠重启 App 摆脱：`reopenIfUnavailable()`
在单飞接纳后的执行入口、任何任务读取之前最多重试一次打开；失败保留待办，探针报告 `unknown`。
重开安全的前提是迁移失败已 `ROLLBACK`、`PRAGMA user_version` 幂等、
且**不删任何文件**（打不开就是打不开，不做"删库重来"）。

## 投递的「记」与「跑」：单飞与节流只限制执行（2026-10-09）

**缺陷**（P1）。`SyncDeliveryPolicy.decide` 曾把"已有同步在跑"与"后台节流窗口内"一并判成
`.ignore`，而派发方在 `.ignore` 分支里直接 `break` ⇒ 这条投递**既没有代次、也不驱动任何后续轮次**。
正在跑的那一轮的导出起点早于这条通知，它的字节覆盖不到这次变化；旧批次收工清空之后，后台按快照
判定"无待办"，自动同步停在原地（要等下一次投递、打开 App 或手动点同步）。

**规则**。

- **只要目标已绑定（`session.serverURL != nil`），一次投递就先 `recordBackgroundIntent`，
  再按 `decide` 的返回值决定这一轮怎么跑。** `Decision.recordsTheDelivery` 回答"要不要记"，
  `decide` 只回答"现在跑不跑"。**只有未绑定服务端才是真的 `.ignore`** —— 没有目标，
  意图也没有任何东西能消费它。
- `decide` 的两个"不跑"成因（单飞被占 / 节流窗口内）都落在 `deferToBackgroundLater`：
  记下意图，并排一次**延后**的后台执行（`BackgroundRunPolicy.resubmitDelay`，与节流窗口同量级）。
  立即 `submit` 是错的 —— BGTask 与正在跑的那一轮撞车只会被单飞静默拒绝，换来一条"跑过了"的假记录。
- 🔴 **一轮收工后必须把"这一轮没覆盖到的那一代"接过去**：判据 `SyncFollowUp.handoff`
  （前台且还有额度 ⇒ 当场补跑；否则排一次后台执行），额度 `maxForegroundRounds = 1` 是**硬上限** ——
  HealthKit 大批导入期间会连发投递，没有上限的"补跑"就是前台自旋，每次自旋都是一轮 GB 级导出。
  与"后台重排"同一条纪律：**"留下来"与"有人来接"是两件事**。
- `PendingWork.hasUncoveredGeneration`（通知 + 恢复请求）与 `needsAnotherRound`
  （再加上"盘上卡着一批没走完的字节"）**刻意分开**：补跑新代次不该顺手重放一次失败的批次。

**判据**。`BackgroundSyncPolicyRegression` 的 `unboundDeliveriesAreIgnored` /
`aDeliveryDuringARunningSyncIsNeverDropped` / `aThrottledDeliveryIsStillRemembered` /
`uncoveredGenerationsAreHandedOff`（期望值逐格手写，`main()` 的调用顺序决定"红在哪一条上"）；
结构门禁 `check-background-capabilities.py` §15c；突变 `[P1]` 组七条。
边界：这条修复保证**自动同步链路不会断**，不保证时延 —— BGProcessingTask 何时被系统派发仍由系统决定。

## 仍需真机验收的边界

服务端已提供上传、预检、导入任务、幂等和job终态查询；不能假定sourceId跨小时保留原上传目录。
当前实现有意保留覆盖performSync的beginBackgroundTask收尾窗口，过期走suspendForLifecycle而不是用户取消；不把“移除它”当作未完成任务。
anchor使用单事务+提交前回读断言，而非为照抄外部方案增加平行candidate/committed列。
日志中的成功、编译通过、模拟器测试都不证明系统实际触发了background delivery/BGProcessingTask。
**未决（2026-10-09）**：非 Workout 记录的分页查询在"本次没有返回任何对象"时，completion 给出的 anchor 是否为 nil **没有实测**（只有 Apple 文档那句 "an anchor object corresponding to the last object returned by this query" 可读，它读得出 nil 可达）。当前实现把 nil 当硬错误（`HealthKitExport.anchoredRecords` 抛 `missingRecordAnchor`），而同一文件的跑步查询对同一情形用 `fromValue: 0` 兜底 —— 两处处置**相反**。判定手段＝挑一个**零样本**的记录类型跑一次导出，看 completion 是否给出 nil；若 nil 可达，该批次会**永久失败**（游标永不推进）。在该结论落地前不要改成兜 nil（归零会让游标每轮全量重读，且违反上文「阻塞态绝不推进 anchor」）。

真机至少需覆盖权限变化、锁屏错误、进程回收、background URLSession重挂、迟到路线、删除传播、目标切换和大历史内存；步骤见[runbook](IOS_NATIVE_RUNBOOK.md)。
记录“机制实际被调度”“逻辑正确”“服务端对账”三类证据，区分系统没有调度与代码执行失败。
后台调度时间不作保证；前台进入也需满足权限、网络和服务可用性，不能承诺一定补齐。
