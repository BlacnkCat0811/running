# iOS 数据同步、解析与入库审查及优化方案

日期：2026-10-15（Asia/Shanghai）  
代码基线：`8081ed6`。本轮不修改业务代码、不连接生产服务、不读取真实健康数据。

## 1. 结论

现有链路已经具备可靠同步的重要基础：持久化批次、上传幂等、UUID/别名映射、显式删除墓碑、事实与回执同事务提交，以及客户端拿到提交回执后才推进游标。

**主要问题不在“缺少数据库事务”，而在分页、后台调度、无变化确认和事实版本之间尚未闭环。**

本轮确认 **4 项 P1、3 项 P2**。P1 是特定条件下会发生的停滞或崩溃，并不意味着每次同步都会触发。没有证据可以据此断言生产数据已经损坏。

建议顺序：

1. 先修后台待续页、无变化回执、删除配额、预算溢出四个正确性问题；
2. 再做近期优先与类型公平调度，解决“历史在回填、近期一直不完整”；
3. 统一事实/分析代次及旧新时间边界；
4. 最后依据基准测试优化重复解析、逐条 SQL 和分析任务放大。

## 2. 审查范围与方法

链路：

```text
HealthKit 查询
  → workout / record / route 导出
  → 本地 SQLite 任务日志 + ZIP / multipart
  → 后台 URLSession 上传
  → 上传来源管理 / inspect / 导入排队
  → data-only 或 direct-sync 接收器
  → XML / GPX 解析、身份去重、删除账本
  → SQLite 事实 + 批次 + 分析任务 + 回执
  → iOS 提交候选游标
  → 后台续批 / 分析对账
```

方法：当前源码逐段复核、已有定向测试、调用真实生产函数的临时库探针、编译真实 Swift 纯逻辑源文件的探针。

本轮没有复用旧报告的测试结果。旧报告仅作为线索，已落地修复不重复列为缺陷。工作区原有的 `deliverables/README.md` 修改及两份未跟踪报告未改动。

证据目录：`/tmp/rai-ios-sync-review-20261015/`。其中 SQLite 全为合成数据临时库，探针执行后已删除临时库；日志及探针源码留存。该目录不入 Git，长期留档需另行归档。

## 3. 问题清单

### R1 · P1：后台能发现待续页，却不会执行待续页

**位置**

- `/Users/ta/running/apps/ios/RAI/HealthKitSync.swift:755–757`
- `/Users/ta/running/apps/ios/RAI/HealthKitSync.swift:2684–2690`
- `/Users/ta/running/apps/ios/RAI/HealthSyncBackgroundRecovery.swift:109–116`
- `/Users/ta/running/apps/ios/RAI/AppDelegate.swift:272–280`

**机制**

`PendingWork.needsAnotherRound` 包含 `hasPendingContinuation`，因此 BGTask 会为待续页继续排期。

但真正执行时，`performBackgroundPass` 的 `wantsFresh` 只认通知或 scope 恢复请求，不认 continuation。上一批成功后任务行已删除；通知又可能早在 `saveTask` 的 `.taskPersisted` 检查点被确认。

于是会进入：

```text
无任务行 + 无通知 + 无恢复请求 + 有待续页
  → action = nothingToDo
  → 收工仍有待续页
  → resubmit = true
  → 下次仍然 nothingToDo
```

**实证**：使用真实策略函数组合，输出：

```text
CONTINUATION_ONLY action=nothingToDo resubmit=true reportsSuccess=false
```

**影响**：历史导入或大批变更可能在首批/前台续批额度耗尽后停止，后台反复排期但不推进。新的 HealthKit 通知或手动同步可能打破停滞，但不构成可靠续传。

**优化**

- 把同 scope 的 continuation 明确接入后台执行判定；有任务行时仍必须优先恢复旧任务。
- 不要伪造 HealthKit 通知来绕过判据；“新变化”与“旧流未读完”保持独立。
- 手动、回到前台、观察者、解锁恢复入口共用有界续批编排。目前 `handOffUncoveredGenerations` 并未覆盖所有入口。

**验收**：只保留 continuation、清空任务/通知/恢复请求；实际后台编排必须启动下一批，跨进程重启后仍能推进，最终清掉 continuation。

### R2 · P1：worker 的无变化成功没有回执，iOS 会永久等待同一个成功 job

**位置**

- `/Users/ta/running/apps/api/src/import-worker.ts:529–554`
- `/Users/ta/running/apps/ios/RAI/HealthKitSync.swift:1001–1021`
- `/Users/ta/running/apps/ios/RAI/HealthKitSync.swift:1509–1528`
- `/Users/ta/running/apps/ios/RAI/DirectSyncCursorPolicy.swift:86–91`

**机制**

worker 命中 `detectUnchangedPayload` 后直接返回 `succeeded / importMode=unchanged`，没有 `summary.directSync`，也没有该 job 的持久回执。

iOS 只有 **inspect 返回 unchanged** 的分支会显式设置 `requiresReceipt: false`。已经建立 job 的分支仍要求回执；因此该成功 job 落到 `.hold(no_receipt)`。下次优先 `.waitJob`，读到的还是同一份没有回执的成功响应。

**触发条件**：相同内容的两个来源先完成检查/排队、前一来源先提交；或其他调用方直接创建重复内容的 job。常规单设备、串行且在 inspect 就识别 unchanged 的路径不受此项影响。

**实证**

真实 `ImportWorker` 接收两个不同 sourceId 的重复载荷，两者均返回：

```text
status=succeeded
importMode=unchanged
directSync=null
persistentReceipt=null
```

将该响应的回执形状交给真实 iOS 策略：

```text
NOOP_JOB_WITHOUT_RECEIPT decision=hold(reason: "no_receipt")
```

**优化**

- 首选：给 no-op job 建立可持久查询的确认凭证；验证“当前库仍对应该载荷”的条件与凭证写入在同一事务内完成。
- 分析状态沿用真实依赖代次及已有分析任务关联，不因为内容相同就宣称分析已发布。
- 不要简单取消所有成功 job 的回执要求；那会削弱现有安全闸门。

**验收**：两个不同 sourceId 的同内容请求并发排队；第二个 job 无须重新解析，但 iOS 能完成确认、清任务、提交候选游标；在回复丢失和服务端重启后仍成立。

### R3 · P1：删除事件不计入导出预算，超配额后缩预算也无法收敛

**位置**

- `/Users/ta/running/apps/ios/RAI/HealthKitExport.swift:1024–1041`
- `/Users/ta/running/apps/ios/RAI/HealthKitExport.swift:1120–1123`
- `/Users/ta/running/apps/ios/RAI/HealthKitExport.swift:517–523`
- `/Users/ta/running/apps/api/src/direct-sync-ingest.ts:445–448`
- `/Users/ta/running/apps/ios/RAI/HealthKitSync.swift:1395–1414`

**机制**

记录页预算只检查 XML 字节和 `added.count`，删除 UUID 进入 manifest，不占上述两项。删除-only 页会一直被接受，直至读空。workout 删除同样整批进入 manifest。

但服务端限制 `deletedRecords + deletedWorkoutIds <= 5000`。客户端上传前检查能发现超限，却只会折半未约束删除数量的预算；同一删除集仍被完整导出，最后耗尽重导次数。

**实证**：以真实 `HealthKitRecordCursor.drain` 和 `DirectSyncBatchBudget`，模拟每页 1000 个、总计 6000 个删除事件：

```text
deletion-only: consumed=6000, budget=4500, anchor=6000, hasMore=false
```

这里的 anchor 是导出候选值，**并未实际提交到 HealthKit 或客户端正式状态**。

**影响**：用户批量删除历史数据后，删除同步可能确定性失败；问题不是数据被误删，而是删除和后续同步无法继续。

**优化**

- 预算增加独立的删除数及 manifest 序列化字节；记录与 workout 删除共用同一个总额度。
- 尽量通过更小查询页恢复前进性。
- 若底层返回不可再分的超限删除页，应持久暂存该页、拆成可恢复子批；所有子批获得回执后才能推进原页 anchor。
- **禁止只截断删除数组却提交完整查询页 anchor**，否则未发送删除会永久丢失。

**验收**：纯删除 5000/5001/10000 条、删除与新增混合、多类型累计删除、workout 与 record 合计超限；中途断网/重启后不漏、不重复应用错误状态。

### R4 · P1：预算收缩存在无符号下溢，workout XML 又未被写前预算约束

**位置**

- `/Users/ta/running/apps/ios/RAI/DirectSyncBatchBudget.swift:67–72`
- `/Users/ta/running/apps/ios/RAI/HealthKitExport.swift:492–507`
- `/Users/ta/running/apps/ios/RAI/HealthKitExport.swift:1552–1556`

**机制**

`max(0, UInt64(maxXmlBytes) - usedXmlBytes)` 先进行无符号减法；当已用字节大于上限时，尚未执行 `max` 就发生算术陷阱。

该输入并非完全不可达：workout 查询使用 `HKObjectQueryNoLimit`，workout XML 在进入记录分页前连续写出，没有相同的写前字节闸门。全量/大量积压或预算已收缩时，workout XML 可以先耗尽预算。

**实证**：编译真实预算源文件，调用 `maxXmlBytes=100、usedXmlBytes=101、pageRecords=1`，子进程以 `-4 / SIGILL` 退出。未启动或崩溃真实 App。

**优化**

1. 短期：先比较再相减，余量不足返回零；为边界添加运行时回归。
2. 根治：workout 也按完整查询页进行写前预算判定与分页；XML 外壳、workout、record 共用总字节账。
3. 不得省略未发送的 workout 后仍提交整批 `batch.next`；要保持“发送范围与游标范围一致”。
4. 上传前自校验继续保留，但不能代替导出阶段预算；算术陷阱发生时自校验根本到不了。

**验收**：已用字节等于/超过预算、只有 workout 的超大批、workout 用尽预算后仍有记录、收敛后的小预算；结果应为安全分批或明确可恢复错误，不能杀进程。

### R5 · P2：历史回填与固定类型顺序会长期挤占近期和恢复数据

**位置**

- `/Users/ta/running/apps/ios/RAI/HealthKitRecordCursor.swift:148–156`
- `/Users/ta/running/apps/ios/RAI/HealthKitExport.swift:918–970`
- `/Users/ta/running/apps/ios/RAI/BackgroundSyncPolicy.swift:121–128`

**机制**

无游标时只有历史读取段；类型按固定顺序遍历，心率在前、睡眠在最后，一旦预算耗尽就不再处理后续类型。

即使 R1 修复，大量历史心率仍可能持续占据每批额度，近期睡眠、HRV 等不能获得公平服务。workout/route 的发现策略又不同于记录流，因此可以出现“跑步和轨迹已送达、关联样本仍未送齐”。

**限定**：本轮确认调度机制，不假设 HealthKit 对无锚点结果承诺事件时间排序，也不由静态代码推算生产库追平天数。

**优化**

- 划分近期优先、普通增量、历史回填三种工作量，分别记录进度。
- 对已有无界增量流保持原 predicate/anchor；近期窗口作为独立查询及独立状态，不能拿窗口最大时间替换正式 anchor。
- 按 UUID 幂等合并近期与历史的重叠；删除仍由无界变更流保证。
- 每批为心率、HRV、睡眠等分配最小服务额度，持久化轮转起点，避免固定首类型长期占满。
- 暂停/继续历史回填不能清零已经提交的增量进度。

**验收**：合成大量历史心率、少量近期 HRV/睡眠及一笔新跑步；在有界批次数内三类近期数据都必须开始送达，同时历史游标单调推进。批次数目标应在数据夹具和基准测试后设定，不预先承诺“1–2 批必完成”。

### R6 · P2：事实版本更新不一致，新鲜度又比较了不同语义的计数器

**位置**

- `/Users/ta/running/apps/api/src/data-only-import.ts:163–207`
- `/Users/ta/running/apps/api/src/direct-sync-ingest.ts:721–727`
- `/Users/ta/running/packages/storage-sqlite/src/read/fact-read-view.ts:223–250`

**两个已确认的现象**

1. data-only 已更新原始记录和 `dataset_version`，但未推进 `import_generations.raw_generation`。真实探针中插入步数前后都是 `(raw=1, dependency=1)`。
2. direct-sync 对非分析批次只增加 raw；读侧却比较 `versions.analysis !== versions.facts`。二者本来就有不同的递增条件，不能用数值相等表达分析是否追平。

**实证**：心率批次后接非评分记录直连批次，再让真实应用消费者完成分析：

```text
ANALYSIS_RUN status=succeeded
FRESHNESS_AFTER_ANALYSIS:
  analysisStatus=published
  facts=2
  analysis=1
  stale=true
  reason=analysis_behind
```

非评分载荷可因目录形状或大小不适合 data-only 而合法进入 direct-sync。这样一旦两计数器产生差额，后续同时加一也不会使它们重新相等。

**影响**：事实版本可能漏变，或分析已发布仍一直显示落后。当前证据不足以宣称所有业务入口都因此不可用。

**优化**

- 两条车道共用事务内的代次更新函数，明确 no-op 是否推进以及推进的单位。
- 区分 `rawGeneration`、`requiredDependencyGeneration`、`publishedDependencyGeneration`。
- 新鲜度比较“已发布分析依赖代次 vs 当前所需依赖代次”，而不是 raw vs dependency。
- 将“是否需要分析”与“分析是否完成”分离，允许非评分事实更新后原有分析仍有效。
- **不能只给 data-only 补 raw 递增**：若不同时修正读侧比较，会扩大永久 stale 的触发面。

**验收**：交替经过两条车道，覆盖非评分、评分、删除、重复载荷；分析发布后正确追平，非评分数据变化不制造假落后，真正未发布的评分变更不能被报成最新。

### R7 · P2：更新只记录新时间，旧时间窗口的派生数据可能残留

**位置**

- `/Users/ta/running/packages/storage-sqlite/src/database.ts:3262–3284`
- `/Users/ta/running/apps/api/src/direct-sync-ingest.ts:501–525`
- `/Users/ta/running/apps/api/src/direct-sync-ingest.ts:583–594`

**机制**

更新账本的 `effective_at` 只保存传入的新起点；`nightWindow` 又只 JOIN 更新后的记录。若已接收记录的时间被更新到另一天，旧夜不进入重建窗口；分析的 dirty 起点也可能晚于实际受影响时间。

**实证**：调用真实接收器，把同一睡眠 UUID 从 1 月 1 日夜移到 1 月 10 日夜：

```text
第一批 canonical：2026-01-02
第二批重建窗口：2026-01-09 .. 2026-01-12
第二批 canonical：2026-01-02、2026-01-11
```

原始记录已经移动，但旧的 `2026-01-02` 派生夜仍存在。

**限定**：这是接收器已支持的 UUID 更新语义下的可复现缺口；本轮没有证明原生 HealthKit 日常查询会直接产生同 UUID 时间修改。应主要视为跨来源/兼容输入与未来扩展的完整性护栏。

**优化**

- 更新前保存旧 type/start/end，更新账本记录 before/after 影响范围。
- 夜窗口和训练 dirty 边界取旧新范围的并集；未知旧范围按明确策略扩大重算。
- 不依赖“当前表还能查到旧时间”；删除/覆盖后旧值已不可得。

**验收**：睡眠跨日移动、记录起止区间扩大/缩小、记录移动跨越已有 workout；旧派生残留消失，窗口外数据不变。

## 4. 需要纠正的旧结论

`/Users/ta/running/deliverables/LATEST_WORKOUT_MISSING_DATA_2026-10-15.md` 中“记录补齐不会自动重算”的概括，**不能用于当前全部记录类型**。

当前 `scoringHealthTypes` 包含心率、跑速、静息心率、睡眠、HRV、VO₂max。它们只要真正产生变更账本，就会由直连接收器登记分析任务；只有非评分白名单或无实际变更的记录批次才可能不登记。

本轮真实心率-only 导入结果：

```json
{
  "ingestStatus": "committed",
  "analysisStatus": "queued",
  "dependencyGeneration": "1"
}
```

因此恢复近期心率后，应先核验该批 `analysisJobId` 及发布结果，**不应预设一定还要手动全量重算**。旧报告未在本轮改写，避免覆盖其他工作。

## 5. 解析与入库的性能优化

以下是优化机会，不冒充已经测出的性能缺陷。

| 项目 | 当前观察 | 建议 | 验收指标 |
|---|---|---|---|
| 重复读取/扫描 | worker 摘要、接收器摘要复核、白名单检查、正式 SAX 解析有重叠工作 | 先记录各阶段字节/耗时；在不可变、带身份校验的准备产物上复用结果，不能直接删掉内容复核 | 每批读盘字节、解析次数、CPU、RSS |
| 逐条 SQL | UUID 解析、别名、代次、事实快照和提交前验证多处逐条 prepare/query | 连接级缓存语句；按批验证身份与账本；保持写守卫与提交前断言 | 4500 条下 prepare 次数、SQL 次数、写事务 p95 |
| 重复事实重写 | `saveHealthKitRecordFact` 对已接受 UUID 使用无条件 `INSERT OR REPLACE`，即使业务行未变也可能写快照 | 对内容相等做 UPSERT 的条件更新，验证替代 REPLACE 不改变身份/删除语义 | 重放批 WAL 增量、page writes、耗时 |
| GPX 读取 | 摘要、文件指纹、解析各有读文件的职责 | 先确认占比，再在不可变上传输入上复用已验证文件摘要；流式解析继续保留 | 路线读盘字节、点数/秒、峰值内存 |
| 分析任务放大 | 每个分析相关变更批次单独登记任务，消费者复用完整重算流程 | 后续引入按依赖代次合并/去抖；多个批次保留各自回执和可对账关联 | 连续多批时实际重算次数、最新分析延迟 |
| 大范围局部窗口 | `nightWindow` 取最早到最晚日期形成连续区间 | 若一批跨多年且稀疏，可合并离散受影响日期区间，避免重建中间无关夜 | 被触及夜数 vs 重建夜数 |

注意：

- 不能以优化为由关闭 `synchronous=FULL`、删除提交前断言、取消墓碑或令客户端先推进游标。
- 不建议第一步直接放大 XML/条数上限。R1–R4 未修前，扩大上限只是改变故障触发点；还会增加后台单次工作量。
- 原始事实与分析分离继续保留；不要让原始同步等待全量分析完成后才提交客户端游标。
- 本轮遵守 ADR-004：不改变动态批次 hash、不把 GPX 超额改成永久 invalid、不颠倒现有清理与提交顺序。

## 6. 分批落地方案

| 批次 | 内容 | 边界与回滚 |
|---|---|---|
| A：可靠性修复 | R1 后台 continuation；R2 no-op 回执；R4 安全余量计算及 workout 写前预算；R3 删除分页 | 按客户端/服务端可兼容的小提交落地；涉及子批暂存时单独版本化，升级后保留旧批次和候选游标 |
| B：近期可用性 | R5 近期独立通路、类型公平调度、统一入口续批 | 新增可选状态字段、灰度启用；关闭策略后仍能从原游标续传，不能要求用户清数据 |
| C：一致性 | R6 代次语义；R7 before/after 时间范围 | additive 迁移并先补读侧兼容；已有错误派生夜采用定向修复，不在同步时隐式整库重建 |
| D：性能与可观测 | 摘要/SQL 优化、分析合并、同步统计 | 每项先做基准、单独比较；无收益即回退，禁止以牺牲断言换吞吐 |

建议新增可观测字段：

- 按类型区分导出条数、删除数、历史/近期进度与最后成功处理时间；
- 服务端区分 observed / inserted / updated / unchanged / tombstoned / rejected；
- 每批记录阶段耗时、写事务时长、WAL 增量、候选游标是否推进及 hold 原因；
- 分开展示“最近一批已保存”“仍在补历史”“分析待发布”，不要只给一个最近同步时间；
- 日志不输出原始健康数值、完整 UUID、坐标或 token，以 scope/batch 的脱敏标识关联。

## 7. 验证结果与边界

本轮结果：

- `npm run typecheck`：通过。
- 定向 Node 测试六文件：**83/83 通过**，覆盖 direct-sync、data-only、载荷早退、HealthKit UUID/删除、GPX 配额和基础入库。
- 临时 Swift 探针：复现 R1、R2 的策略结果、R3 的删除预算缺口、R4 的算术陷阱。
- 临时真实接收器/worker/应用消费者探针：复现 R2、R6、R7，并确认心率-only 会登记分析任务。
- `npm run test:ios`：**整体 EXIT=1，不能报全绿**。94 个 iOS 文件类型检查通过；前置 Swift 纯逻辑、store、展示回归及后台能力检查已执行通过，随后默认 Python 3.9.6 在 `check-direct-sync-status-copy.py:130` 的 `str | None` 注解处退出。
- 使用已安装的 Python 3.12.14 独立补跑剩余三支门禁：status-copy **55**、contract-parity **21**、analysis-reconcile **43** 条全部通过。未以此冒充默认聚合命令成功。

门禁通过不等于上述边界已覆盖；探针恰好证明现有绿灯与这些问题可以同时存在。

**工具链补充建议**：声明并预检 Python 最低版本，或让门禁兼容系统 Python；当前 macOS 默认 Python 能启动检查但不能跑完全部脚本。不要通过忽略脚本退出码解决。本轮未修改工具链。

未做：全量 `npm test`、Web E2E、响应式测试、真实 HealthKit 授权/锁屏读取、BGTask 真机唤醒、后台 URLSession 跨进程上传、生产库审计或设备安装。后台问题的证据是源码接线和真实纯策略函数组合，不冒充已在真机复现。

外部文档校验：尝试检索/打开 Apple 官方 HealthKit 文档，但本轮浏览工具未返回可用内容；因此平台边界没有引入未经核实的新结论，尤其没有假设查询排序或删除页的系统分页保证。相关事项需要真机验证。

### 测试日志

- `/tmp/rai-ios-sync-review-20261015/typecheck.log`
- `/tmp/rai-ios-sync-review-20261015/node-tests.log`
- `/tmp/rai-ios-sync-review-20261015/ios-gates.log`
- `/tmp/rai-ios-sync-review-20261015/ios-python312-supplement.log`
- `/tmp/rai-ios-sync-review-20261015/runtime-policy-probe.log`
- `/tmp/rai-ios-sync-review-20261015/deletion-budget.log`
- `/tmp/rai-ios-sync-review-20261015/underflow.log`
- `/tmp/rai-ios-sync-review-20261015/ingest-probe.log`

