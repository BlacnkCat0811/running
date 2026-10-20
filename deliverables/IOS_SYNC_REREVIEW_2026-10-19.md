# iOS 同步与入库优化复审（2026-10-19）

- 复审基线：本地 `67028e1322ba38e62dc1d0c854d4b632a0338e06`，对比前轮 `d037fc7`。
- 生产实查：2026-10-19 12:57—13:04，北京时间；SSH key 认证成功。
- 生产 HEAD：`33f79fed212c77e84563ca53b06f120d2a814359`，进程自 11:29:05 运行，状态 active/running。
- 范围：只读生产数据库、runtime 任务、认证 API、限定时段 journal；本地读码、类型检查、定向回归与合成复现。
- **没有部署、重启、迁移、改写生产数据，也没有修改产品代码。未读取/输出 SSH 私钥或 API Token；API Token 仅在服务器进程内用于本机回环认证请求。**

## 1. 结论

**优化有实际进展，但不能验收为“最新训练一次操作完整同步”。**

本轮仍有 **3 项 P1、3 项 P2**：其中包含上次已知而尚未实现的分页，以及这次改造的接线/并发缺口。最需要先修的是：

1. 到期窗口只接入“还要重排”，没有接入“实际执行什么”，后台可以反复空转；未来检查时间也没有可靠重排。
2. observer 改为跨线程写入后，旧代次确认的读/删不是原子操作，可能删除新通知。
3. 逐类型进度目前不是分页断点，高密度窗口仍重复读取同一个前缀。

**部署与代码必须分开看**：线上已包含事实可见性、VO2Max 有界脏范围等第一批服务端修复；本地 `5333895` 的 A3/A5/A6/A8 后续代码并未在线上。iOS 修复是否生效，仍取决于手机安装的构建；本轮没有取得手机构建号。

## 2. 生产实查：2026-10-18 晚 6 km 跑步

数据库：`/var/lib/rai/var/rai.sqlite`，schema v46；只用 `mode=ro` + `query_only` 查询，没有复制生产库。

| 项目 | 本轮生产读数 |
|---|---|
| 会话 | `training_session_2aac5780f95010e0e0af1be6966f0c1b` |
| 训练时间 | 2026-10-18 **19:46:38—20:28:46** |
| 距离 | **6.0125 km** |
| 心率 | **505** 条 |
| 步幅 | **482** 条 |
| 路线 | imported，**2527** 点 |
| 速度 / 功率 / 步频 / 垂直振幅 / 触地时间 | **各 0 条** |
| 其它记录 | PhysicalEffort 106 条、VO2Max 1 条 |

跨来源查询同一训练时段，仍只有上述四类健康记录；缺失指标不是“换了来源名就被详情过滤掉”。当前认证 `/series` 也与数据库一致：心率 505、步幅 482、高程 2527，其余上述指标 0。

**因此，这些时序当前确实没有入生产库，不是仅仅图表没刷新。** 但服务器不能证明它们当时是否已对手机上的本 App 可读；还需设备的逐类型查询证据，不能直接推断“手表一定还在传输”。

本轮没有取得含这些缺失指标的原始上传载荷，因而**没有证据证明“客户端已经传了，但解析器丢弃了”**。相关接收事务、身份幂等和 VO2Max 回归通过；这也不能替代原载荷与记录账本逐项核对。

### 真实时间线（北京时间）

| 阶段 | 时刻 |
|---|---|
| workout/心率等事实批次提交 | 2026-10-18 **20:29:38.755** |
| 步幅批次提交 | **20:30:23.066** |
| 分析任务开始 | **20:29:44.942** |
| 分析指针发布 | **20:31:21.265** |
| 分析任务完成 | **20:31:21.669** |

- 事实提交到分析发布 **102.510 秒**；分析任务本身耗时 **96.727 秒**。
- 原批次的持久脏计划确为 `full:true`、原因 `vo2_evidence_changed`，不是本轮根据注释猜测。
- 六个跑后批次每批 4,500 条，共解析 27,000 条，只新增 1,111 条；不能把“批次成功”当作“所有训练指标齐全”。
- 当前线上三条端点（详情、series、freshness）均 **200**。`/freshness` 尚无新三态/`analysis.available` 字段，与线上仍为 `33f79fe` 相符。
- 最新导入仍为 **2026-10-19 06:43:12.056**，早于本次部署的 11:29。因此**尚无部署后的真实新同步批次**，不能证明新版本已经在真机上改善了端到端体验。
- 历史行 `available_at` 为 NULL，符合追加列不回填的迁移规则；不能用它补造手机可读时刻。

## 3. 逐项复审

### R1 · P1 · 到期窗口“被看到但不执行”，未来复查也无人负责

**已复现，调用方接线源码确认；前轮 A4 只修了一半。**

代码：

- `/Users/ta/running/apps/ios/RAI/HealthKitSync.swift:918-929`：探针写入 `hasDueWorkoutWindow`。
- 同文件 `:1033-1052`：后台 `wantsFresh` 仍只看通知/恢复，`wantsContinuation` 只看续页；完全没读取到期窗口。
- `/Users/ta/running/apps/ios/RAI/AppDelegate.swift:125-135`：前台 handoff 同样只传通知/恢复/续页。
- `/Users/ta/running/apps/ios/RAI/HealthSyncBackgroundRecovery.swift:120-123`：却把到期窗口计入重排。

实调生产策略、使用与调用方相同的参数装配：

```text
无任务 / 无通知 / 无续页 / 有到期窗口
探针 needsAnotherRound = true
后台 action = nothingToDo
前台 handoff = nothing
后台 shouldResubmit = true
```

后台被派发后不导出，只再次重排，直至其它通知/人工同步打破条件或窗口过期。当前门禁只测“有窗口要重排”，没有测“重排后实际能执行”。

另一个分支：一次窗口查询成功后，`afterPass` 把 `nextCheckAt` 推到 15 分钟后；此时 `hasDueWindow=false`，`shouldResubmit=false`。代码没有把“未来仍需检查”的最早时刻交给现有 BGProcessingTask，因此下一次迟到检查也可能不再发生。

**修复建议**：统一形成含 `dueNow` / `nextCheckAt` / 预算中断页的待办快照；前台续读、后台 action、后台重排都消费它。未来时刻只安排现有 BGTask，不立即执行。补完整“探针→执行→提交→未来重排”的行为测试，不仅检查新增字段存在。

### R2 · P1 · observer 跨线程写入后，旧确认可以删除新通知

**确定性合成复现；本轮新增并发风险，不是生产已观察到的事故。**

位置：`/Users/ta/running/apps/ios/RAI/HealthSyncBackgroundRecovery.swift:268-280`。

`acknowledge` 是：

```text
读 currentGeneration → 比较旧 observation → removeObject(key)
```

新版本 observer 会在 HealthKit 队列写同一个 scope key；原确认仍在 MainActor。`UserDefaults` 单个方法线程安全，不会把这三步变为原子比较删除；channel 的锁只保护 scope/计数，不保护 store 的读/写/确认。

本轮通过 `UserDefaults` 的可控调度缝，调用真实 store：

```text
旧批次观察到 old
ack 读到 old
observer 写入 new，且回读校验成功
ack 按旧快照删除 key
结果：ack=true，new 意图不存在
```

之后的 MainActor observer Task 若执行，可能重新登记；但进程在该 Task 前被挂起/结束时，“completion 前已经留下可靠意图”的新保证已被破坏。

**修复建议**：生产者与确认者通过同一个共享串行存储边界执行原子 compare-and-delete，或用短 SQLite 事务/条件删除。锁不能只存在某个 channel 实例内，也不能只包住 read。新增上述交错时序及写入后杀进程的恢复验证。当前 set+同进程回读也未证明崩溃后的磁盘耐久性。

### R3 · P1 · 分页仍未实现，新增类型计数不能替代交付进度

**已知 A2 未关闭；生产预算函数+同形循环模型复现，不是真机查询实测。**

位置：

- `/Users/ta/running/apps/ios/RAI/HealthKitExport.swift:1530-1555, 1612-1622`
- `/Users/ta/running/apps/ios/RAI/RouteSyncState.swift:896-927`

每批仍从固定类型顺序开始；`recentSamples` 只查第一页。预算截断后 `afterBlockedPass` 虽会写 observed/delivered，却不保存下一页断点或下一类型位置，下一批再次从头开始。

在握手预算 12,000 条、窗口份额 3,000 条的合成密度下：

```text
第 1/2/3 轮都只查询 HR + distance，各 1500 条
power 始终未被访问
nextCheckAt 不变
```

新代码不再把满页误当 EOF，这是修正；但不能据此说“份额耗尽后可收敛”。而过期窗口只是被 `due()` 排除，行本身仍 `completedAt=nil`、原因 blocked，并没有落成记录所称的 expired 终态。

**修复建议**：实现 `(scope,workoutUUID,type)` 有限分页、同时间戳 UUID 边界与公平调度；已确认页不再占后续额度。超限应继续读剩余页，而不是清游标重来；过期要有明确持久结算。A2 可以单独排期，但在完成前不能验收一般情形的“一次操作齐全”。

### R4 · P2 · 新分析新鲜度判定漏掉路线和旧时间区间

**真实 `RaiReadStore` + 合成 SQLite 两个场景复现；本地 P2 尚未部署。**

位置：`/Users/ta/running/packages/storage-sqlite/src/read/workout-read-repository.ts:979-998`。

`touchMatcher` 只匹配 workout 变化，以及 record 的当前 `MIN/MAX(effective_at)`。它没有读取已有的 `import_batches.analysis_dirty_plan_json`，也没有合并 `previous_effective_at / previous_end_at`。

两个实际读仓库复现：

1. 旧 release 捕获依赖代次 1；新路线批次代次 2、queued，dirty plan 明确指向该训练。XML 的 workout 内容未变，可能没有 workout 账本变化。结果仍返回 **published**。
2. 训练内心率的时间被更正到训练外；旧区间明确落在训练内，dirty plan 已回退到训练开始。结果仍返回 **published**。

写侧分析任务和脏范围可以是正确的，但读侧仍把待更新的旧结论称为最新。此前 A6 的直接窗口内记录用例能通过，不覆盖这两类。

**修复建议**：复用持久脏证据及其域边界，合并新旧记录区间、路线影响和恢复影响；不要再发明只有当前点时间的窄匹配器。补路线-only、时间迁移及恢复事实影响后继训练的三入口一致性测试。

### R5 · P2 · 三态字段只完成解码，展示仍沿用旧“完整”语义

**API 实调复现 + iOS 消费点核对；前轮 A5 未形成用户可见修复。**

- `/Users/ta/running/apps/api/src/data.ts:1976-1991`：`deliveryState=delivered` 只证明 workout 实体交付；`completeness` 仍是 published + 24h 静默。
- `/Users/ta/running/apps/ios/RAI/SyncPresentationPolicy.swift:47-49, 69-83, 163-165`：横幅/重取仍看旧 completeness，并把缺项解释成“Apple Watch 仍在传输”。
- `deliveryState/stabilityState/analysisAvailable` 在当前 App 只有 DTO 声明，没有实际展示消费。

合成结果仍可同时出现：

```text
deliveryState=delivered
completeness=complete
power.samples=0，power.state=not_seen_yet
```

此时现有 UI 会隐藏“仍在补齐”的横幅并停止依赖 partial 的刷新。反过来，没有缺项的新训练也会保持 partial 24h。执行记录如实写了“只加字段，语义未改”，所以这里应标**未完成**，不能把字段上线当作 A5 解决。

本轮也实调了 Swift 展示策略：上述缺功率的响应得到 `banner=nil`、`shouldReload=false`。

**修复建议**：新增字段保持兼容，但新客户端真正消费；分离实体已收到、当前已读页已交付、指标尚未观察到、分析是否最新、观测是否安静。没有手机读取/交付证据时保持 unknown，不把 workout 到达等同训练详情全部到齐，也不确定归因 Watch。

### R6 · P2 · 覆盖跳过关闭后，历史带过滤锚没有恢复方案

**条件性升级风险，未证实用户手机曾安装启用过滤的构建。**

位置：`/Users/ta/running/apps/ios/RAI/HealthKitExport.swift:1938-1953, 1981-1989`。

`allowsHistorySkip=false` 关闭新下界是正确的。但对已保存 `historyCoverageFloor` 的旧游标，现在只是把 predicate 下界改成 nil，仍复用原 anchor。`needsHistoryRead()` 只看 phase，`shouldRestartHistory` 又因新 floor=nil 不会启动历史补偿。

生产纯策略复现：旧 floor 非空、anchor 有效、phase=nil ⇒ 计划仍只有 `.incremental`。即使新谓词看得见更早记录，插入序早于原锚的缺传历史也不会凭空变成锚后的新增。

**修复建议**：如果能证明从未分发过该构建，明确记录并限制支持边界；否则为这类旧游标设计受控、逐类型的补偿与迁移，不能只丢 floor，也不要自动清空全部游标。需用真实 HealthKit 验证谓词/锚升级路径。

## 4. 前轮问题状态

| 前轮 | 本轮判断 |
|---|---|
| A1 新登记窗口不入本批 | **代码已修**：接受页登记与持久窗口合并；仍待新 App 真机验收 |
| A2 分页不收敛 | **未修**，见 R3，执行记录也明确未实现 |
| A3 总数相同就收口 | **部分修正**：逐类型、截断页不误 EOF；但分页/未来检查/过期结算仍不闭环 |
| A4 窗口未接待办 | **部分修正、核心接线仍缺**，见 R1 |
| A5 完整性语义 | **未完成用户可见修复**，见 R5 |
| A6 旧分析冒充最新 | **直接记录场景已修**；路线/旧区间漏判，见 R4；新代码未上线 |
| A7 MAX 推完整覆盖 | **新跳过已关闭**；旧带谓词游标条件性迁移风险，见 R6 |
| A8 completion 先于登记 | **顺序已修**；新并发确认缺口，见 R2；崩溃耐久性未验收 |

服务端第一批修复（事实可见性、VO2Max 有界重算、记录未变轻路径、v46 可得时间）已部署；本轮相关定向回归通过。**这解决了“事实已提交却等分析才看得到”的重要问题，不等于缺失指标已被补进库。**

## 5. 验证与证据

临时脱敏证据目录：`/Users/ta/running/output/ios-sync-rereview-2026-10-19/`。

| 检查 | 结果 |
|---|---|
| SSH / 认证健康 / 详情 / series / freshness | 成功；三个训练读取端点均 200 |
| 生产数据库、任务及历史批次 | 只读核实；无部署后新同步批次 |
| 定向 API/解析/VO2Max 回归，`--test-concurrency=2` | **47 通过 / 0 失败 / 0 跳过** |
| 审查 API 复现，`--test-concurrency=1` | **3 个边界复现**：路线漏判、旧区间漏判、缺项仍 complete |
| Swift 审查探针 | 到期/未来调度、并发确认、旧带过滤游标、重复窗口前缀及过期状态均复现 |
| `npm run typecheck` | 通过 |
| `npm run test:ios` | **exit 0**：95 个源文件类型检查与纯逻辑/结构回归通过；3 个仅依赖高德 SDK 的文件按既有脚本跳过 |
| `npm run check:docs` | 通过，95 文件、649 本地链接、0 问题 |
| `npm run check:doc-refs` | 143 处，0 越界/无法解析；无基线，内容漂移未核对；1 处空行锚告警 |
| `git diff --check` | 通过 |
| 全量 `npm test` | 本轮未重跑；不把定向通过替代全量发布验收 |
| 真机 HealthKit / 手机安装构建 / 杀进程恢复 | 本轮未取得，仍为独立验收项 |

复现通过的意思是“危险输出被确认”，不是相应产品行为正确。没有用合成样本条数冒充用户真实数据。

主要命令：

```bash
node --import tsx --test --test-concurrency=2 apps/api/test/workout-visibility-freshness.test.ts apps/api/test/direct-sync-ingest.test.ts apps/api/test/direct-sync-analysis-reconcile.test.ts apps/api/test/direct-sync-analysis-registration.test.ts packages/application/test/vo2-fitness-domain-convergence.test.ts packages/health-export-parser/test/record-unchanged-fast-path.test.ts
node --import tsx --test --test-concurrency=1 --test-name-pattern='REVIEW REPRO' output/ios-sync-rereview-2026-10-19/api-review-probes.test.ts
xcrun swiftc -parse-as-library -disable-sandbox apps/ios/RAI/APIModels.swift apps/ios/RAI/DirectSyncBatchBudget.swift apps/ios/RAI/RouteSyncState.swift apps/ios/RAI/HealthKitRecordCursor.swift apps/ios/RAI/HealthSyncBackgroundRecovery.swift apps/ios/RAI/BackgroundSyncPolicy.swift apps/ios/RAI/SyncPresentationPolicy.swift output/ios-sync-rereview-2026-10-19/SyncRereviewProbes.swift -o /tmp/rai-sync-rereview-probes
/tmp/rai-sync-rereview-probes
```

## 6. 下一步顺序

1. **先修 R1 和 R2**：否则“待补齐”仍无人执行，或新通知被旧确认删掉。
2. **完成 R3 后再验收一次操作齐全**；保留自动分批，不要求所有类型塞进一个请求。
3. 服务端修 R4，新客户端接 R5；按手机是否曾用过过滤锚处理 R6。
4. 确认手机构建号，发布经过检查的服务端/App 版本；本轮审查不替用户部署。
5. 真机做一次“健康中各类型已可读→只点一次同步”的时间线，对齐查询、导出、服务端 COMMIT、分析发布和当前页面。验证含历史积压、单类型超页、迟到 20 分钟、后台冷启动及提交期间新通知。

**验收口径**：手机中已存在且本 App 可读的数据，一次前台操作自动分批交付；尚不可读的类型保持有原因、可执行的后续补齐。不能以服务器健康、普通测试全绿、字段已增加或后台任务已重排，替代这一端到端判据。

## 7. R1–R3 详细实施方案（2026-10-19 补充；实施状态见执行记录）

以下是可拆成代码提交的实施设计。**实施状态**：R1/R2/R3 与 R4/R5 已在工作树落地，R6 未实施
（理由与边界见 [IOS_SYNC_OPTIMIZATION_EXECUTION_2026-10-19.md](IOS_SYNC_OPTIMIZATION_EXECUTION_2026-10-19.md)）。
基线仍为 `67028e1`；本节保留当时的方案原文，不把“已写代码”读成“已部署/已真机验收”。

### 7.1 明确目标与不变式

“一次同步”定义为**一次用户操作，可以包含多个上传批次和数据库事务**，不是强求一个 ZIP 装下所有数据。

本次目标集合为本轮发现的近期训练及其当前可读数据；不能被所有历史重放拖住。前台时间预算用尽时保留自动续接和明确的未完成状态，不要求用户再次点击，也不能承诺任意大数据都在 60 秒内结束。

实施必须保留：

1. 已存在的上传任务先续传，不能为了最新训练覆盖旧任务、重新生成 batchId。
2. 有载荷的页，必须拿到该批次持久 committed 回执，才提交该页的本地查询进度。
3. 正式全局记录 anchor 与训练窗口 anchor **独立**；本方案不重置正式游标、不恢复全量重导按钮。
4. 工作窗口、类型、谓词版本与 anchor 绑定；窗口扩宽不能拿旧 anchor 换谓词继续用。
5. 未来复查只安排既有 BGProcessingTask，不增加定时器、其它后台机制或独立 Watch 产品。
6. 没读到、无授权、锁屏、页未读尽、窗口过期，不能合并成“完整”。
7. ADR-004 的提交前断言、产物清理顺序、GPX pending 与批次身份规则不变。

### 7.2 文件级任务拆分

以下新文件名为建议，实施时可按现有模块边界调整，但职责不能重新塞回不可执行回归的大函数。

| 模块 | 具体工作 |
|---|---|
| `HealthSyncBackgroundRecovery.swift` | 增加统一待办快照；现有 intent API 转调同一个意图存储器 |
| 新 `HealthSyncWorkPlanner.swift` | 纯函数：执行决策、前台续批、下一次唤醒时间、无进展退避 |
| `BackgroundSyncPolicy.swift` | 消费统一计划，不再独立拼一份窗口条件 |
| `AppDelegate.swift` | 前台 handoff、后台执行完成、启动/前台恢复三处按计划派发/重排 |
| 新 `HealthSyncIntentJournal.swift` | 非 MainActor 的短事务意图写入与原子条件确认 |
| `SyncTaskStore.swift` | 本地 schema 4→5、窗口类型分页行、同事务提交分页候选、过期结算 |
| 新 `WorkoutWindowPaging.swift` | 纯状态机与可注入查询接口；页接受、缩页、轮转、EOF 与重试 |
| `HealthKitExport.swift` | 窗口通道改用上述分页接口；HealthKit 适配层只查询/渲染，不自行决定提交 |
| `HealthKitSync.swift` | 持久化候选、恢复入口透传、回执后原子提交；派发不再遗漏窗口 |
| `SyncTaskState.swift` | 新增可选分页候选字段，显式兼容解码与恢复 |
| `SyncPresentationPolicy.swift` 等展示点 | 至少区分“本批保存”“当前可读页已交付”“仍待补齐”，不能只看上传队列空 |

此三项主体不需要改服务端解析格式：沿用现有 ZIP/XML、v2 UUID/删除清单及 committed 回执。R4 的分析影响范围漏判应单独修，不以此方案冒充已解决。

## 8. R1 实施：让同一份待办同时决定“执行”和“重排”

### 8.1 用结构化快照代替新增一个孤立 Bool

建议新增：

```swift
struct WorkoutWindowWork {
    let immediatePageCount: Int
    let dueProbeCount: Int
    let nextProbeAt: Date?
    let expiredWindowCount: Int
    let readFailed: Bool
}
```

- `immediatePageCount`：上批预算截断、已确认位置之后尚未读完的窗口类型页。
- `dueProbeCount`：到时间且未过期、需要检查迟到样本的窗口类型。
- `nextProbeAt`：未过期窗口类型中最早的未来检查时间；不是“现在就要再跑”。
- 到期窗口和在途任务分开；scope 不明确/数据库读失败保留 unknown，不能退化为空队列。

由 `SyncTaskStore` 的只读查询生成，不能依赖 `lastError`、内存 phase 或上一次同步的全局展示字段。首次合并的新窗口也必须进入本轮可执行快照。

### 8.2 一处生成执行计划

纯策略输出使用显式原因，而不是调用方分别计算 Bool：

```text
resumeExistingTask
export(reason: newDelivery | regularContinuation | workoutPage | workoutProbe)
defer(until, reason)
blocked(reason)
idle
```

优先级：

1. 已有可恢复任务 → 按原任务接续。
2. 锁屏/凭证等阻塞 → 不做注定失败的导出，保留待办。
3. 真实新通知/身份恢复 → 既有同步路径，包含最新训练窗口。
4. 已确认窗口的剩余页/到期探测 → 必须可以直接驱动导出，不要求再有通知。
5. 正式记录流待续 → 继续现有游标。
6. 只有未来探测 → 返回其时间，不导出。
7. 没有任何依据 → idle。

窗口与历史不能互相饿死：计划决定一次执行的原因，批内分页调度再决定份额与公平性。不能用“给窗口更高优先级”取消历史流最低进展。

### 8.3 接齐四条调用路径

1. `performBackgroundPass`：消费完整计划；仅有到期窗口时不得再是 `nothingToDo`。
2. `handOffUncoveredGenerations`：新增窗口页/窗口探测分支，使用续读时间预算，不扣“新通知”额度。
3. 后台结束：按 `nextProbeAt` 重排现有 BGTask；不能只在 `dueNow=true` 时重排。
4. 启动、回到前台、解锁、绑定/切换服务端：重新读取相应 scope 的计划；离线缓存不是权威身份，执行前仍握手。

`BGProcessingTask` 是一次性的请求。下一次请求时间要综合：

```text
有暂时失败/系统收回额度/前台预算用尽：
    按已有 backoff 安排可恢复工作
只有未来探测：
    earliestBeginDate = nextProbeAt
无未来工作：
    不再创建空任务
```

独立的更早工作不能被较晚重排推迟：先查询同 identifier 的待发请求，保留更早的；确需提前时只调整该待发请求，不取消正在运行的系统任务。提交失败必须留诊断，并在下一次已有入口重新协调。

**不能把 `earliestBeginDate` 当实际执行时间保证。** 正在前台时可按预算及时处理；后台由系统决定何时派发。

### 8.4 无进展与过期

“提交批次代次 +1”不再独自代表窗口有进展。记录窗口的**确认游标、EOF 状态、调度位置**是否发生有效变化；仅更新时间戳、重复计数或重新生成同样载荷不算窗口进展。

- 一波内同一类型再次零进展 → 停止立即补跑，分类为 budget / unreadable / oversized / error，按原因退避。
- 7 天过期在选取前通过短事务明确落 `expired`，记未交付类型与原因；不只从查询结果里过滤掉。
- 若有在途任务引用该窗口，先允许原任务结算已提交数据；过期不得覆盖任务、删除原 ZIP 或丢候选。

## 9. R2 实施：所有通知写入与确认使用同一个原子存储边界

### 9.1 选定方案

目标实现采用 **SQLite 意图表 + 原子条件删除**，不是给某个 channel 临时加一把锁。

原因：共享锁可以修进程内读删竞争，但单靠 UserDefaults 同进程回读，仍不足以给“completion 前已经耐久交接”背书。SQLite 已是本项目的本地同步存储，不引入新后台机制。

建议同库追加：

```sql
CREATE TABLE sync_observer_intents (
    url_scope TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    updated_at REAL NOT NULL
);
```

使用 URL scope 承接 HealthKit 通知，身份恢复仍用独立现有槽，不能把两个成因混成一条记录。generation 使用随机身份字符串，不复用墙钟时间。

### 9.2 线程与连接所有权

- `HealthSyncIntentJournal` 由进程唯一 runtime 持有，拥有专用串行执行队列和 SQLite 连接；MainActor、observer、后台恢复必须共享该入口。
- 初始化/迁移在注册 observer 前完成；observer 不能绕过 MainActor 隔离去调用现有 `SyncTaskStore` 实例。
- 同一连接只在所属队列使用，不能把 actor-isolated 指针通过 `@unchecked Sendable` 直接跨线程共享。
- 与 `SyncTaskStore` 使用同一文件、不同受控连接。意图事务只做数条 SQL；不得在持有写锁时 await MainActor、执行 HealthKit 查询、网络或打包。
- 配置短 busy timeout 和有限重试；具体毫秒值通过目标机验证，不把 fsync 描述成严格微秒级操作。

### 9.3 写入与确认算法

记录：

```text
BEGIN IMMEDIATE
UPSERT(url_scope, freshGeneration, now)
回读校验 generation
COMMIT
返回 recorded(generation)
```

确认：

```sql
DELETE FROM sync_observer_intents
WHERE url_scope = :scope AND generation = :observedGeneration;
```

条件删除放在短事务中提交：

- changes=1：恰好确认本轮观察到的代次。
- changes=0：新代次已经覆盖旧代次，或旧代次已被确认；这是合法无操作，**不允许随后无条件删除**。
- SQL/提交失败：返回不可确认，保留 unknown/待处理状态，不报“队列已清空”。

因此两种执行顺序都安全：

```text
旧确认先提交 → 新记录随后插入 → 新记录保留
新记录先提交 → 旧确认条件不匹配 → 新记录保留
```

必须改完 `record / observe / hasIntent / acknowledge` 的全部调用方；禁止 observer 用 SQLite、而 MainActor 仍读写旧 UserDefaults 真源。

### 9.4 completion 与异常边界

- 回调快速把持久化工作交给专用队列；completion 用一次性包装器，写入成功 COMMIT 后调用，再派发后续同步。
- 不让 completion 等导出、上传或服务端分析；它只等短的本地交接。
- 保留现有“失败路径也恰好一次 completion”的产品行为，但必须返回/记录 `handoffFailed`，不能把失败叫 recorded。
- 磁盘满、受保护数据库不可达、有限重试耗尽：记录分类故障、置进程内 reconcile-required；已有解锁/前台入口在存储恢复后，从正式已提交游标做补查，不能只因意图表为空就认为无变化。
- **存储持续不可写且进程随后退出时，不能承诺该通知已耐久保存。** 日志和后台请求不能冒充持久队列；验收报告必须保留该故障边界。不得靠无限重试或永久不调用 completion 掩盖它。

### 9.5 旧意图迁移

启动时按已知绑定 URL scope 导入旧 generation：

1. 读取旧键。
2. 在 SQLite 事务内导入并回读；新表已有更新 generation 时保留新值。
3. COMMIT 后按共享迁移边界处理旧键；成功前旧键不得先删。
4. 写入明确迁移完成标记，之后新版本只认 SQLite 真源。

未知归属的遗留键不猜 scope、不清空；恢复时按旧兼容规则读取。App 退回旧版不能宣称无损：见第 11 节的回滚约束。

## 10. R3 实施：训练窗口使用独立 anchored 分页，不用时间戳猜下一页

### 10.1 分页技术选择

推荐使用 **`HKAnchoredObjectQuery` 的独立窗口游标**，不是继续在 `recentSamples(limit:)` 上加一个时间偏移。

每个键为：

```text
(syncScope, workoutUUID, windowRevision, recordType)
```

其谓词固定为该 revision 的训练时间窗 `[start−5min, end+5min]`。该游标只服务补齐通道，与正式全局记录游标完全分离。

这样不需要用“最早时间减一秒”“扩大 limit 然后跳过已见 UUID”来猜下一页；同一时间戳下很多样本不会因为时间边界截断而被跳过。此方案**替代**此前实施记录中的时间戳分页草案，不能两套混用。

Apple 官方说明支持使用上次返回的 anchor 继续获取变化；但空结果、删除页与部分授权的实际返回形态仍需本项目真机门禁验证，不以文档替代验收。

### 10.2 本地分页表

schema 4→5 同批追加：

```sql
CREATE TABLE sync_workout_type_pages (
    scope TEXT NOT NULL,
    workout_uuid TEXT NOT NULL,
    window_revision INTEGER NOT NULL,
    record_type TEXT NOT NULL,
    predicate_json TEXT NOT NULL,
    committed_anchor BLOB,
    state TEXT NOT NULL,
    next_check_at REAL,
    last_served_at REAL,
    eof_observed_at REAL,
    last_error_code TEXT,
    PRIMARY KEY (scope, workout_uuid, window_revision, record_type)
);
```

建议状态为 `ready / paging / caught_up / retry_wait / blocked / expired`；每个状态均有纯函数转换与原因码。已有 `types_json` 保留诊断/兼容用途，但不能同时成为第二份分页真源。

- `ready/paging`：当前数据还有页要交付，属于立即续批。
- `caught_up`：本次已经读到 EOF，不代表未来不会来数据；等待下一次探测或对应类型通知。
- `retry_wait/blocked`：有明确原因及后续资格，不每批原地重试。
- `expired`：退出主动窗口补齐，不删除正式游标或已入库事实。

`predicate_json` 保存规范化窗口、类型及谓词版本；时间按仓库 REAL 规范化规则持久化。窗口扩大时 revision 增加，**只创建该训练的新补齐游标**；旧在途 revision 仍可结算，不自动清空正式 anchor。

### 10.3 查询、预算和候选推进

逐页算法：

```text
从 committedAnchor / 本批已接受的候选 anchor 查询一页
→ 渲染实际 XML，计算真实字节与删除配额
→ 页放得下：追加载荷，记本批候选 nextAnchor
→ 页放不下：不写、不推进；同 anchor 缩小 limit 重查
→ 连最小页也装不下：分类 blocked/oversized，不进入无限续批
```

- 非空页不靠 `count < limit` 声明完整；继续到一次可靠的 additions-empty 且 deletions-empty 结果，才记录本次 EOF。
- 删除-only 页不是 EOF。窗口与正式流发现的删除按 `(type,UUID)` 去重，走现有删除配额/溢出暂存，不能因窗口已读尽而丢删除。
- 非空结果缺候选 anchor、取消、锁屏、授权错误：不推进已确认游标。空结果缺 anchor 的真机边界未验证前也不能归零兜底或伪造 EOF。
- 同批多个通道按 `(type,UUID)` 去重后再核预算，但被去重记录必须确实已包含在本批接受载荷中；不能只因“之前查询过”就跳过。
- 不缓存整条训练的全部样本或无限 UUID 集合；保留当前页和有限候选。

### 10.4 必须连通持久化任务与回执提交

新增可选 `pendingWorkoutPages`，内容包括完整作用域、workout、revision、type、起始确认指纹、候选 anchor、EOF、下次探测时间。它必须：

1. **上传前**进入 `SyncTaskState`，显式 `decodeIfPresent`；旧任务缺字段继续恢复且不清新表。
2. 所有 `.waitJob / inspect / 重传原 ZIP / 正常新导出` 成功路径透传同一候选，不能只在新导出路径生效。
3. 拿到该批 committed 回执后，由 `commitSuccess` 在**同一事务**更新窗口页、正式游标、删除余量/续批状态，并删除任务行。
4. 在提交前核对 scope、revision、预期前驱指纹和回读结果；不匹配整段回滚，不能把陈旧候选覆盖较新的进度。
5. API 事实提交成功、本地提交失败 → 继续恢复原任务和回执，不重新查询第一页、不换 batchId。

这项分页进度**不能继续放在当前 `markSuccess` 之后的 best-effort 窗口统计更新里**；否则崩溃会失去已交付页的恢复依据。

**纯空查询的处理**：从已确认 anchor 查询到空页，没有新载荷/删除时，不必制造一个空 ZIP。增加窄的本地 `commitEmptyWindowObservation` 事务，校验前驱/revision 且没有冲突在途候选，再写 EOF/nextCheck；不推进全局 anchor、不删除无关任务。读到非空但没写出的页绝不能走此入口。

### 10.5 公平调度与迟到数据

- 每个窗口类型先发一个有界页，再轮转到下一类型；持久化 `lastServedAt`/轮转位置，不能每次重启都回到心率。
- 当前操作目标中的最新训练有优先资格，但队列中其它训练保留轮转机会。
- 初版保留窗口 25% 上限与历史最低份额；窗口有积压而其它通道确实闲置时，可在第二趟借用未使用预算，不能侵占仍有待办的历史保底。
- 单类型 3,000 条应跨批推进其两个 1,500 页，而不是每批重发前 1,500；同时其它类型要有被访问的机会。
- `caught_up` 后保留窗口 anchor。到 `nextCheckAt` 或对应类型通知时继续读取新增变化，而不是从 nil 重扫整窗。
- observer 传递类型标识只用于将相应有效窗口提前到期，不证明其数据已齐；前台单飞仍保留新代次，不为每个回调另起导出。
- 0 样本可记“本次未观察到”，不能记 unsupported；当前可读页交付完成与未来迟到检查分开。7 天退出主动补齐不等于“证明完整”。

## 11. 提交顺序、测试与上线

### 11.1 建议分四个提交

| 提交 | 内容 | 关闭范围 |
|---|---|---|
| C1 | 待办计划、前后台执行接线、未来复查、无进展和过期结算 | R1；不宣称分页已修 |
| C2 | schema 4→5、意图表/专用存储、原子确认、迁移与故障分类 | R2；同时建好分页表但不启用分页 |
| C3 | 独立窗口 anchored 分页、任务候选、原子提交、恢复与公平调度 | R3 主体 |
| C4 | 当前操作目标/未完成展示、真实 HealthKit 验收与发布记录 | 一次操作体验验收 |

可先用所有实例共享的锁补 R2 竞争热修，但必须明确它只修竞争、不修耐久保证；不能把此临时步骤标成 C2 已全部完成。

### 11.2 必测行为矩阵

| ID | 场景 | 通过标准 |
|---|---|---|
| T01 | 只有到期窗口，无任务/通知/普通续页 | 前台与后台均能真正发起窗口查询 |
| T02 | 只有未来 15 分钟探测 | 现在不导出，但保留未来后台请求 |
| T03 | 已有更早待发后台请求 | 后来的重排不能把它推迟 |
| T04 | 单飞被占/前台预算用尽 | 待办保留，安排接续，不另造新批次 |
| T05 | 数据库读取失败 | 返回 unknown，不报空队列 |
| T06 | 窗口 7 天到期且有在途页 | 允许原任务结算，后续明确 expired |
| T07 | 旧观察→新记录→旧确认 | 新 generation 保留 |
| T08 | 旧确认→新记录 | 新 generation 保留 |
| T09 | 两个 observer 同时记录、另线程确认 | 无无条件删除，最终未确认代次可读 |
| T10 | 不同 URL/epoch 恢复请求 | 不交叉确认、不混淆两种成因 |
| T11 | 意图 COMMIT 后立即结束进程 | 新进程读到未确认通知 |
| T12 | 意图写失败/短时锁竞争 | 有限处理、completion 恰好一次、无虚假 recorded |
| T13 | 旧默认域意图迁移中崩溃 | 至少一份可恢复，不先删旧键 |
| T14 | 单类型 3,000 条 | 已确认页不重读，下一批继续后半页 |
| T15 | 多个样本相同 startAt 跨页 | UUID 全集最终一致，无时间边界漏样本 |
| T16 | 份额总被前两类用满 | 后续类型和其它训练仍有有限步进展 |
| T17 | 删除-only 页 / 删除超额度 | 不当 EOF，删除余量跨批保留 |
| T18 | 页字节超限与缩页 | 重查同 anchor，拒绝页零推进 |
| T19 | 已导出未上传 / 上传断网 / 回执丢失 | 原任务、原 ZIP、原 batchId 续接 |
| T20 | 服务端提交后、本地提交前崩溃 | 原回执恢复同一候选，页不丢、不重启第一页 |
| T21 | 本地 COMMIT 前注入写失败 | 页/续批/任务删除整体回滚 |
| T22 | 只有 EOF 空查询 | 无空 ZIP，窄本地事务不碰正式游标 |
| T23 | 功率晚 20 分钟到达 | 沿窗口 anchor 自动增量补入，不要求第二次点击 |
| T24 | 窗口扩大/旧 revision 任务恢复 | 不混 anchor/predicate，旧候选不覆盖新 revision |
| T25 | 老任务、老 v4 行、损坏分页 payload | 兼容恢复或明确阻塞，不静默清空正式游标 |
| T26 | 有大量历史积压的新 6 km 训练 | 最新当前可读类型优先交付，历史仍推进 |

测试分三层：纯策略、真实 SQLite/进程恢复、真实 iPhone。至少 T01/T02/T16/T20 要测**调用方装配到提交后的完整路径**，不能只断言 helper 的单个返回值或源码里出现了字段名。

真机预验收门：先验证各类型带固定窗口谓词的 anchored 查询、分页、空样本与部分读权限、删除回调；若不满足预期，停止启用窗口分页，不临时退回有漏样本风险的时间戳猜页。

代码实施后的命令：

```bash
npm run typecheck
npm run test:ios
RAI_TEST_CONCURRENCY=2 npm test
npm run check:acceptance-matrix
npm run check:docs
npm run check:doc-refs
```

发布记录写明并发、跳过和失败。原复审里的 47 项通过与此文档检查都不能冒充新实现的测试结果。

### 11.3 上线和回滚边界

1. 仅 App 本地追加 schema，不需要为这三项迁移云端健康库；服务端保持现有兼容回执。
2. 分页开关默认关闭，先完成真机门，再在新 App 构建启用；关闭时仍能续接已经生成的新任务，不能丢候选。
3. 本地 schema 纯追加，不做 down migration、不删除新表。旧任务按原路径先跑完。
4. 安全回退优先使用**仍认识 schema 5 和新候选的新构建**关闭新导出，再回到正式增量通道；页面诚实显示补齐未完成。
5. 直接退回旧 schema 4 App 不具备消费新意图/候选的能力，**不列为无损回滚**。必须先排空相关任务、核对回执，并做明确前台增量对账；没有这些条件不得声称可安全降级。
6. 若要改变 observer 失败确认合同、全局游标策略或其它既有不变式，先单独评审；不混入性能改造。

官方合同核对入口（实施时复查；不代表真机已验证）：

```text
https://developer.apple.com/documentation/healthkit/executing-anchored-object-queries
https://developer.apple.com/documentation/healthkit/hkobserverquerycompletionhandler
https://developer.apple.com/documentation/backgroundtasks/bgprocessingtaskrequest
```
