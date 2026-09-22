# RAI 原生 iOS 同步协议

状态：P4 持久化准备 + P1 原子单元闭环 + **P2 后台三机制**均已落地代码（2026-09-22）。
三项机制——HealthKit background delivery（唤醒触发器）、`BGProcessingTask`（主载荷）、带 identifier 的
background `URLSession`（字节搬运）——都已在 `apps/ios/RAI/` 里接线，静态判据由
`tests/check-background-capabilities.py` 与 `BackgroundSyncPolicyRegression` 钉住
（判据有效性由 `npm run test:ios:mutation` 逐条突变验证）。
🔴 **但"代码走到了"不等于"在真机上被调度了"**：真机验收是一个**独立验收项**，完成前不得把
静态审查或模拟器构建写成"后台可用"（判据见文末）。在那之前，前台行为与 P1 完全一致；
唯一已确定改变的是"切到后台"不再等于"用户取消"。HealthKit 导出仍复用
`HealthKitExport.swift` 的 ZIP/XML 管道。

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

当前任务数据包含：目标 URL、阶段、source ID、job ID、批次校验值、待确认 HealthKit anchor、导出结束时间和跑步数量；P1 另加 `schemaVersion` 与一组**只存文件名**的产物字段
（`zipFileName` / `multipartFileName` / `multipartBoundary` / `uploadState` …）。
🔴 `uploadTaskId` 这个键**目前没有任何写入点**：判据用的是 `RaiBackgroundUploadSession` 内部按
identifier 索引的两张表（`waiters` / `descriptions`），把它当"字节归系统"的依据会得到**恒假**，
于是每次唤醒都重传一遍。结构门禁会拦下这类读取。
任务在上传前创建，在 source/job ID 变化后立即更新；批次校验值（`payloadHash`）同时作为
`X-RAI-Sync-Batch` 幂等标识传给服务端。服务端重复收到同一标识时返回原来源；服务端成功前不会推进普通导出水位。

## 字节归谁：唯一判据是「本进程还在等它的结局吗」

`uploading` 之后，字节可能同时有两个"主人"：我方的等待者，与系统持有的传输任务。这两件事在
**生命周期中止**时分离——中止要的是**前者停下、后者继续**（那正是 background `URLSession` 的全部价值），
所以 `RaiBackgroundUploadSession.abandonWaiting` 只摘等待者，**不**碰 `URLSessionTask`。

于是"这个系统任务要不要留"必须由一个明确判据回答，它是纯函数
`BackgroundUploadReattach.disposition(isAwaitedInThisProcess:)`：**在 `waiters` 里就留，否则取消**。

- 判据**不是**"它属于哪一批"。服务端没有按批次查来源的接口（`sourceByIdempotencyKey` 只在
  `saveUpload` 内部用；`GET /v1/import-sources/recent` 只返回 `lastUsedAt != null` 的来源，而
  "已上传未导入"恰好是 `null`），所以上个进程那次上传的**结局拿不回来** —— `sourceId` 只能靠
  **重传同一份字节**让服务端幂等命中（`import-sources.ts:323-331` 按归档字节比对，返回同一条来源）。
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

⚠️ P2-4 之后 `uploading` 这一行要读准：**传输本身**可以跨会话（字节归系统），但这一阶段属于
**原子单元**、其中的"拿到 `sourceId`"跨不了会话 —— 重启后系统手上那次传输的结局拿不回来
（服务端没有按批次查来源的接口），只能靠重传同一份字节让幂等命中重新拿回 `sourceId`。
所以"允许跨会话 = 否"说的是**原子单元的推进**，不是"字节不会继续传"。

v1 不单独设置“确认游标”端点：导入 job 的 `succeeded` 状态只在服务端完成数据库激活、审计文件发布和终态 job 持久化后返回。手机把这个持久化终态作为服务端确认，再提交本地待确认 anchor 和导出水位；若 App 在此后退出，恢复时先查询已有 source/job，不重新产生业务数据。未来若服务端拆分导入发布和游标确认，可在保持本状态机的前提下增加独立端点。

🔴 **`inspect` 是 `POST /v1/import-jobs` 的强制前置门。** 成功导入过的 HealthKit 上传会被
服务端 retain（`import-source-finalization.ts:35-39`：记录在、目录已删），对这类来源直接建任务
只会得到一个必然失败的 job。`inspect` 返回 `unchanged` 时必须走"删除暂存来源 + 提交游标"分支，
**不得创建任务**。

恢复时**下一步由字段推导**（`SyncAtomicUnit.nextStep`：`jobId` > `sourceId` > 本地文件），
不按阶段文字猜。2026-09-22 的线上死锁正是"按阶段猜"的后果：当时 `uploaded` 与 `importing`
被混写成同一个 `importing`，恢复分支只能二选一，线上的表现是 nginx 里**再没有出现过任何 uploads**。

## 重试与恢复

- 上传、检查、创建导入任务使用最多三次退避重试。**上传本身只尝试一次**（600s 超时 ×3 最坏阻塞
  30 分钟，超过整个导入窗口），唯一例外是服务端说"现在不行"（429 `import_upload_busy`）——
  那会退避一次后用**同一个 batchId** 重试。
- `401`、不兼容协议和坏数据立即停止。
- 任务有 source ID 时先查询并恢复已有 source/job，不重新产生业务记录；创建导入任务遇到已有活动任务时先读取活动任务并按 source ID 接续。
- 导入任务轮询最长 30 分钟；短暂轮询失败会重新连接，连续失败后**保留 jobId 与任务**，
  等下次唤醒续接（服务端没有推送机制，后台空转轮询零收益）。
- 本地产物（`Application Support/rai-healthkit-<scope>/upload-<payloadHash>.{zip,multipart}`）
  的生命周期由**终结结果**驱动：成功时删、服务端确定性拒绝时删、瞬时失败时**留着**给下次唤醒续传。
  刻意不落 `/tmp`（系统会清理，失效方式是"某天起续传悄悄变成重导"）。
  🔴 因此 `upload()` 里**没有** `defer { removeItem }`：函数返回只代表"这次等待结束了"，
  不代表系统不再搬这批字节（生命周期中止会把等待者摘掉而让传输继续）。
- 启动/发起上传之前先盘点系统手上的传输（"字节归谁"一节）：**没人在等结局的**一律取消，
  由这一轮用盘上的字节重传，避免两份同样的字节同时打向服务端。
- 上传失败分三态，判据在 `SyncUploadRecovery`（每个错误码都能在服务端源码里找到出处，
  结构门禁会做跨仓核对）：瞬时失败保留批次同 batchId 重传；并发占用退避重试；**服务端确定性拒绝
  的批次永不重传**（连本地产物一起作废）。其余 4xx（鉴权/路由）保留批次 —— 修好通道后重传比
  重新导出一次便宜。
- 同步成功后才清除本地产物与任务。**失败时任务被刻意留着**：它就是"下次接着传"那条记录，
  `SyncAtomicUnit` 下次会从同一份产物、同一个 batchId 继续。
- 每个服务地址使用独立作用域；切换服务不会复用游标、任务或失败上传。

## HealthKit 规则

跑步 anchor 与时间窗口采用重叠补查；每次 anchored 增量同步还会回读最近 14 天的跑步，用于发现训练保存后才到达的路线。恢复、HRV、静息心率即使没有新增跑步也随窗口导出。部分读取权限或没有样本会形成空/部分结果，不解释为远程删除。删除事件由 HealthKit 导出清单携带，服务端使用导入元数据中的 workout UUID 负责来源失效处理。

## 尚待完成

服务端目前已经有上传、预检、导入任务和 job 查询接口；批次幂等由运行时状态库中的 `idempotency_key` 和活动/历史 job 查询保证。服务端成功确认复用已持久化的 job 终态，v1 不要求额外游标确认端点。自动化异常矩阵和真实设备上的生命周期中断、路线晚到、删除传播及大历史内存测试仍未运行。

🔴 **后台三机制的真机验收是一个独立验收项，完成前不得把静态审查或模拟器构建写成"后台可用"。**
可执行清单见 **`deliverables/IOS_SYNC_DEVICE_CHECKLIST_2026-09-22.md`**（= 方案 §11.0–11.4 + 落地后新增的
V11/V12，含前置条件、构建期检查、逐条操作与回传模板）；方案原文见
`~/.workbuddy/plans/blazing-nebula-lovelace-RGwzqGbx.md` §11。V1–V12 每条都要求
"机制被调度的证据 + 逻辑正确的证据 + 服务端对账"三者齐全，并区分「系统根本没调度」与
「逻辑失败」—— 两者在控制台、nginx 日志、系统设置上留下的痕迹完全不同。
模拟器上无法验证 background delivery 与 `BGProcessingTask`（包签名为空、无 HealthKit entitlement），
所以那两项**只能**在真机上判定。background URLSession 虽然在模拟器里"看起来能跑"，但那不构成证据：
本仓的判据是"进程被杀之后系统还把字节传完"，而模拟器里没有真实的进程回收与重新拉起。

P2-4 另有三条只能上真机才能定的东西，已列进 §11：

1. `URLSessionUploadTask.taskDescription` 与 `X-RAI-Sync-Batch` 头在**进程重启后**是否仍可读
   （§15 第 2 项）。它现在只影响日志里的 `cancelledCurrentBatch` / `cancelledOthers` 之分，
   不影响任何动作 —— 所以即使答案是"不可读"，结论也只是一句"把口径记得悲观一点"。
2. `getAllTasks` 在**新进程**里到底能看到几个任务。日志行
   `reattached system uploads: kept … cancelled … for the current batch, … from other batches`
   就是这条证据：`foundAny == false` 而线上确实少了一批 ⇒ 系统没有把任务重挂起来（该查
   `makeSession()` 的 identifier 与 `UIBackgroundModes`）；`cancelledCurrentBatch == 0` 而
   `cancelledOthers > 0` ⇒ 重挂了但批次对不上（`persistZip` 的逐字节一致性值得怀疑）。
3. 生命周期中止期间的**重传冗余**实际发生率（"字节归谁"一节末段）。量它的口径是：
   同一次数据变化在 nginx 上出现了几个 `POST /v1/imports/uploads`，以及服务端的
   `import_upload_busy`（429）出现了几次 —— 后者若为 0，说明我们确实只让一份字节在传。
