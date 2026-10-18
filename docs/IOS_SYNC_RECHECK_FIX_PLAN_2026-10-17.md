# 同步与计算第二轮复查：五项残留问题修复实施方案

- 日期：2026-10-17，Asia/Shanghai。
- 状态：**B01–B05 均已落地并跑定向回归。** 已实施条目的证据见 §12；
  真机 HealthKit、目标服务器端到端与完整 `npm test` **仍未验收**。
- 编制依据：本聊天最近一轮源码复查、隔离合成数据验证、真实 SQLite 最小验证及本机租约基准。
- 基线：`HEAD=c986309` **加当前未提交工作区**，不能只用该提交号复现本轮结果。
- 范围：本轮发现的五项残留问题；不把前序已修复问题重新列为未修复。
- 前序：[七项问题方案及其实施记录](IOS_SYNC_POST_OPTIMIZATION_FIX_PLAN.md)、
  [初次审查](IOS_SYNC_PERFORMANCE_REVIEW.md)。
- 本次交付：只新增本文档和 README 入口，保留用户已有代码及文档改动；不实施业务修复。

## 1. 目标与不能改变的边界

### 1.1 本轮目标

1. 路线恢复结算不能消灭后续补查入口。
2. 阻塞、退避及公平调度必须控制最终 HealthKit 查询，不能只控制某个发现入口。
3. 自动重排成功后，客户端仍能通过原 `analysisJobId` 得到真实结果。
4. 完整计算与增量计算都保留真实覆盖证据，合并成员不因证据丢失反复计算。
5. 普通含 GPX 的新增跑步也能走必要范围计算，而不是无条件重算整个历史。

### 1.2 硬约束

- **不全量同步，不重置 anchor，不使用“重新导入全部”作为修复或重试入口。**
- **不创建业务数据库备份，不复制生产库做测试，不建候选主库，不通过文件换库发布分析。**
- 普通增量计算不默认复制全部历史事实到内存。
- 不通过关闭事务、降低持久化等级、取消提交前断言、扩大锁等待或放宽 ZIP 校验换速度。
- 不修改评分公式，不把 TypeScript 模型核心搬到 iOS。
- 保留 `preserveAbsent: true`，缺席不能代替明确删除证据。
- 保留 [ADR-004](adr/ADR-004-healthkit-sync-invariants.md) 的批次身份、提交前回读、
  产物清理顺序及路线配额不变式。
- 不改冻结的窄屏 Web 区域，不引入新的后台机制。

允许增加最小恢复／结算元数据、覆盖证明和未完成小批暂存。
这些数据不包含另一份健康库或 GPX 备份；必须有明确生命周期和回收条件。

## 2. 五项问题与证据

编号使用 **B01–B05**，避免与前序 R01–R07 混淆。
“已复现”不代表已经在真实手机和目标服务器上验收。

| 编号 | 优先级 | 残留问题 | 本轮证据 | 对应前序 |
|---|---|---|---|---|
| B01 | P1 | 恢复只带完成 UUID、不带路线观测，却仍删除待办 | 真实 SQLite：待办 1／状态 0 → 成功结算后待办 0／状态仍为 0 | R03 |
| B02 | P2 | 近期／重新发现通道绕过路线阻塞与退避 | 生产查询条件最小夹具：调度器拒绝 blocked-size、retry-wait，最终条件仍允许 fetch | R07 |
| B03 | P2 | 后继分析成功，原分析任务仍永久失败 | 合成端到端：后继成功，原 job 为 failed，覆盖关联不存在 | R01 |
| B04 | P2 | 完整计算丢掉覆盖清单，合并成员发布后仍排队 | 两个 VO₂ 合成批次：覆盖任务 succeeded，两个成员 queued，关联 released | R02 |
| B05 | P2 | 普通含 GPX 的新增训练无条件退回全历史计算 | 实际直连接收合成 ZIP 目录：`route_evidence_unmerged`，重算 8 次训练、47 天指标，裁剪为空 | R06／增量计算 |

### 已确认有效，不应回退

- 漂移后的早期心率更正已计算正确：合成案例结果为 **148.6**。
- 合并时未入选批次的更正已纳入计算：合成案例结果约 **147.67**。
- 本轮专项 Node 回归 **94/94**；typecheck、iOS 门禁、脚本与文档检查通过。
- 租约生产实现基准：30 轮，每轮 200 空窗口，**p50 96ms、p95 114ms**。

这些是前一轮复查结果，不是本文编制时重新运行的结果。
本轮没有取得完整 `npm test` 通过证据，也未完成真机 HealthKit／目标服务器端到端验收。
不能用已有门禁全绿否定上述生产接线缺口。

## 3. B01：恢复结算必须同时具备观测和待办证据

### 3.1 根因与改动范围

恢复分支传入 `restored.completedRouteTodos`，但任务没有对应的路线状态；
`markSuccess` 的默认空状态数组最终仍会进入待办删除。
“状态落盘与待办移除在同一事务”只能保证两次写原子，
**不能证明这次真的有状态可写**。

主要文件：

- [SyncTaskState.swift](../apps/ios/RAI/SyncTaskState.swift)
- [HealthKitSync.swift](../apps/ios/RAI/HealthKitSync.swift)
- [SyncTaskStore.swift](../apps/ios/RAI/SyncTaskStore.swift)
- [RouteSyncState.swift](../apps/ios/RAI/RouteSyncState.swift)
- [路线落盘回归](../apps/ios/tests/RouteSyncStatePersistenceRegression.swift)

### 3.2 推荐实现：最小持久结算队列

1. 定义版本化 `RouteCommitCandidate`，保存：
   scope、批次身份、实际完整观测得到的路线状态、完成 UUID、发现游标。
   只保存点数、摘要和状态等最小信息，不保存另一份路线点。
2. 将候选作为任务的**可选新字段**保存到 `SyncTaskState`，
   显式接入 `init(from:)`；新版本任务在上传之前就持久化候选。
3. 校验候选内部关系：
   - 每个拟删除 UUID 都必须有该批次的完整观测／等价的有效完成证明；
   - 读取失败、部分读取、预算拒绝均不构成证明；
   - 完整零点观测与读取失败保持不同语义；
   - scope、批次和 UUID 规范化口径必须一致。
4. 新增本地最小结算表，例如 `sync_route_settlements`，
   以 `(scope, batch_id)` 唯一，保存候选 payload。
5. 收到 durable committed receipt 后，在现有 `commitSuccess` 事务里，
   将本批候选放入结算表，再完成 anchor／记录游标更新及任务清除。
   **不能先删任务、再另行保存候选**，否则两者之间退出仍会丢失结算证据。
6. 原始提交后，用另一个短事务完成：

   ```text
   读取待结算候选
   → 校验 scope／批次／完成证明
   → 写路线状态并提交前回读
   → 删除有证明的待办 UUID
   → 删除该条结算候选
   → COMMIT
   ```

7. 退出或失败时，候选和待办至少保留一份可靠入口。重复结算幂等；
   结算失败不能把已 committed 的原始事实改报成未保存。
8. 调度探针必须认识“可执行的未完成结算”，下次启动／同步先消费小型本地结算，
   不必重新读取 HealthKit 或上传。
9. 旧任务只有 `completedRouteTodos`、没有完整候选时，**不删除待办**。
   缺证据应走安全兼容分支，不能从 UUID 猜造观测状态。
10. 如服务端明确延后或拒收了某条路线，不得按该条已交付结算。
    当前协议无法给出逐路线确认时，保留重查依据，不能把客户端读取成功等同于服务端路线可读。

### 3.3 验收与突变靶子

- 复现“待办 1、状态 0”的恢复场景：缺证明时仍保留待办。
- 完整候选恢复后，状态与待办同时正确结算；同一候选重复运行不重复计入。
- 在原始提交前、原始提交后、状态写入后、待办删除前后注入退出。
- 注入状态写失败／删除失败，短事务全部回滚。
- 删掉观测透传、允许空状态删待办、把候选移交挪到任务清除后，分别必须使对应测试失败。

## 4. B02：所有路线来源统一经过最终执行闸门

### 4.1 根因与改动范围

`RouteTodoScheduler.executable` 只筛选待办发现集合。
近期训练和 rediscovery 仍可能重新带回同一 UUID，
最终 fetch 条件没有把其 blocked-size／retry-wait 状态作为硬约束。

主要文件：
[HealthKitExport.swift](../apps/ios/RAI/HealthKitExport.swift)、
[RouteSyncState.swift](../apps/ios/RAI/RouteSyncState.swift)、
[RouteSyncStateMachine.swift](../apps/ios/RAI/RouteSyncStateMachine.swift)、
[HealthKitSync.swift](../apps/ios/RAI/HealthKitSync.swift)。

### 4.2 具体实施步骤

1. 将所有发现来源归并为统一输入：
   正式 workout 页、近期训练、rediscovery、ready 待办、用户针对 UUID 的显式重试。
   来源只说明“为什么发现它”，不授予绕过调度的权限。
2. 增加纯决策 `RouteQueryPolicy`，在**最终 fetch 之前**统一返回 execute／defer／blocked 及原因。
3. 决策顺序固定：
   - 设备锁屏／身份不符／不可读取：不执行，不伪造空结果；
   - 已有 blocked-size 且能力未提高、没有定点显式重试：阻止全部来源；
   - retry-wait 尚未到期：阻止全部普通来源；
   - 到期／被允许重开：再检查本批预算、去重和公平执行份额；
   - 最后处理既有路线状态的查询间隔。
4. 明确区分两个计时器：实际失败产生的退避，与稳定路线的降频。
   已到期的明确待办不能又被 settled 降频永久挡住；
   但“近期发现”也不能绕过失败退避。
5. `hasWorkoutChange` 本身不等于“已证明超大路线现在变小”，不得自动清除 size 阻塞。
   没有可靠内容变化信号时，只在能力提高或用户**定点**重试时重开。
6. 不再将“重新导入全部”作为显式重试的生产入口。
   为指定 UUID 提供小范围重试，保留全部训练／记录 anchor。
7. 各来源对同一 UUID 先去重，执行上限和最老优先顺序跨来源统一计算。
8. 分开三个状态：
   - 队列有数据；
   - 当前有可执行数据；
   - 到未来某时点才有可执行数据。
   仅有阻塞项不能触发连续即时补跑；退避项保留到期唤醒依据，继续使用已授权后台机制。
9. 更新调度状态时使用完整旧对象，不让新构造的三字段 todo 意外把阻塞／退避列清空。

### 4.3 验收与突变靶子

- blocked-size、retry-wait 分别从近期、正式页、rediscovery 和待办四条入口进入，
  实际 route query 替身调用次数均应为 0。
- 到期、能力提高、定点显式重试各自允许一次正确执行；其他 UUID 不受影响。
- 只有 blocked-size 时，跨多次同步／重启不重复读取同一 GPX。
- 删掉任意来源的最终闸门，必须使该来源的行为测试失败，
  不能仅断言源码里存在 `RouteTodoScheduler` 名称。

## 5. B03：原任务 ID 与自动重排结果闭环

### 5.1 根因与改动范围

`replanAfterInputDrift` 创建新 job，旧 job 仍经 `jobs.fail` 进入 failed；
旧回执中的 `analysisJobId` 不变，却没有持久后继关联。
iOS 已有“终态失败不被普通迟到读取覆盖”的保护，因此不能只改一句 UI 文案。

主要文件：

- [recompute-pipeline.ts](../packages/application/src/services/recompute-pipeline.ts)
- [service.ts](../packages/application/src/service.ts)
- [recompute-job-repository.ts](../packages/storage-sqlite/src/recompute-job-repository.ts)
- [任务读取 data.ts](../apps/api/src/data.ts)
- [DirectSyncCursorPolicy.swift](../apps/ios/RAI/DirectSyncCursorPolicy.swift)

### 5.2 首选实现：原 job 安全退回 queued

1. 将可重排输入漂移定义为明确、可识别的调度结果，
   区别于数据损坏、模型 gate 拒绝、用户取消等终态原因。
2. 优先不新建 job：在短写事务内废弃本次未发布候选，清除当前候选执行引用，
   保留失败尝试事件，将**原 job** 从 running 退回 queued。
3. 保留原回执、原 `analysisJobId`、原请求和登记代次的含义。
   重试次数及实际执行计划单独保存，不能为了重排篡改原登记证据。
4. 下一次领取原任务时，从当前 active release 的可信基线重新生成覆盖计划，
   继续合并原未发布范围和新增变更，不重新读取手机全部数据。
5. 检查所有漂移入口：分段读中漂移，以及物化输入固定后发布时依赖推进。
   只有可证明属于“可重新规划”的拒绝才重排，不把所有发布错误都当成可重试。
6. 原任务查询在自动重排期间返回 queued／running 及明确阶段，不提前返回终态 failed。
   成功发布时，原 job 与指针在同事务完成。
7. 重排次数和调度等待有界，用户取消优先；达到上限才给出真实终态错误。
   不取消现有发布 gate，不吞掉最终失败。
8. 若确需保留新后继 job 的架构，必须改用同事务持久关联方案：
   原 id 查询沿关联报告进度，校验 scope／配置／覆盖范围，防循环与重复结算；
   不能只把新 id 打进日志。

### 5.3 已有失败任务的兼容

对修复前“原任务 failed、后继成功”的记录，不凭时间相近猜关联。
只有持久批次覆盖和发布证据能证明时，才建立明确恢复关系。
客户端如已记下终态失败，需要通过显式、版本化的纠正证据更新结论，
不能全局取消终态单调保护。

### 5.4 验收与突变靶子

- 读取中漂移、发布前依赖变化：原 id 在重试期间不报终态失败，最后能读到真实成功。
- 早期更正仍计算为 148.6，证明生命周期修复没有重新丢掉原 dirty 范围。
- 取消、达到重排上限、任务恢复、Worker 退出分别测试。
- 去掉原 id 重排／关联、提前写 failed、丢掉原计划，分别精确转红。

## 6. B04：计算模式与覆盖清单必须独立

### 6.1 根因与改动范围

覆盖计划退回完整计算时，多个分支返回空 `mergedBatchIds`。
运行方随后只补回代表批次，发布后成员结算因缺少并集覆盖证据而释放，
已做过的计算又进入队列。

主要文件：
[analysis-input-reader.ts](../packages/application/src/services/analysis-input-reader.ts)、
[recompute-pipeline.ts](../packages/application/src/services/recompute-pipeline.ts)、
[recompute-job-repository.ts](../packages/storage-sqlite/src/recompute-job-repository.ts)、
[analysis-coverage-merge.test.ts](../packages/application/test/analysis-coverage-merge.test.ts)、
[analysis-job-merge.test.ts](../apps/api/test/analysis-job-merge.test.ts)。

### 6.2 具体实施步骤

1. 覆盖计划输出明确拆开：

   ```text
   executionMode      = partial / rebuild-required
   dirtyDomains       = 逐域影响边界
   requiredBatchIds   = 可信基线之后必须覆盖的真实批次
   registeredBatchIds = 原任务／合并任务登记批次
   executedBatchIds   = 实际执行并由发布验证覆盖的批次
   ```

2. 保守放弃前缀复用，只能改变 executionMode／边界，
   **不能顺手清空 required／registered 批次集合**。
3. 对完整计算路径，执行方仍验证全部声明批次真实、scope 一致、
   不晚于捕获代次，且已被本次截止点下的执行语义覆盖。
   未知代次或账本缺口继续显式标记未知，不能为了结算添加伪造批次。
4. 发布事务由执行方写真实 `executedBatchIds`；结算方只核验，不补写调度成员制造证明。
5. 完整计算证明使用显式版本化模式，例如 `{version: 1, mode: "rebuild", ...}`。
   不让同一个 SQL NULL 同时表示“旧版本缺证据”和“新版本已完整执行”。
6. 校验解析器必须严格验证版本、模式、域字段及时间值；
   对损坏证据失败关闭，不能把缺字段自动解释为“该域全部算过”。
7. 同事务完成：输入绑定／执行证明、覆盖记录、发布指针、覆盖任务及合格成员结算。
   任一写失败则整体回滚，取消／失败成员不冒认成功。

### 6.3 验收与突变靶子

- 两个 VO₂ 批次触发完整计算：一份覆盖结果发布后，两个原成员都完成，
  不再出现 `publication_missing_union_batch` 导致重新排队。
- 路线证据兼容回退、未知边界、单个成员要求完整计算，分别覆盖。
- 不止断言“某轮成功”：继续 drain 到空，检查模型运行次数和队列最终为空。
- 清掉完整计算的批次集合、结算方伪造覆盖、损坏证据按缺省放行，各自必须转红。

## 7. B05：GPX 的脏范围进入批次证据，普通跑步保持增量

### 7.1 根因与改动范围

接收时已能得到 `changedRouteIds` 和相关训练时刻，
但捕获端不能重建完整路线证据，遇到含路线批次就统一 `route_evidence_unmerged`。
于是新增一次普通带轨迹训练也关闭裁剪并重算历史。

主要文件：

- [direct-sync-ingest.ts](../apps/api/src/direct-sync-ingest.ts)
- [gpx-parser.ts](../packages/health-export-parser/src/gpx-parser.ts)
- [dirty-range-input.ts](../packages/health-export-parser/src/dirty-range-input.ts)
- [dirty-range.ts](../packages/health-export-parser/src/dirty-range.ts)
- [analysis-input-reader.ts](../packages/application/src/services/analysis-input-reader.ts)
- [analysis-fact-view.ts](../packages/application/src/services/analysis-fact-view.ts)
- [analysis-input-pruning.test.ts](../packages/application/test/analysis-input-pruning.test.ts)

### 7.2 具体实施步骤

1. 在接收事务中，为每批持久化最小、版本化的分析影响证据，
   例如追加 `import_batches.analysis_dirty_plan_json` 或独立的按批次证据表。
   编号以实际迁移占用为准，不提前指定下一个版本号。
2. 证据包含：合同版本、真实路线／训练身份、变更前后所属训练起点、
   逐域最早影响边界、原因和明确的不确定状态。
   不存 GPX 副本或另一份路线点，不回填整个历史库。
3. 对路线-only 更正、路线归属变化及明确删除，在修改前保留必要旧范围；
   不能只取更新后的训练时间而漏掉原训练影响。
4. 新增 Workout＋GPX 的登记计划、批次持久证据和后续捕获计划，
   使用同一份 dirty 装配逻辑，避免接收端和消费端各算一套边界。
5. 原始事实、路线发布、dirty 证据、任务登记及回执同事务提交，
   提交前回读必要字段，回复丢失仍恢复同一批次。
6. 捕获端读取旧发布之后所有未覆盖批次的 dirty 证据，
   将路线影响与记录／训练／canonical 变化取并集。
   证明齐全时不再仅因“有 GPX”就设置完整计算。
7. 更新特征、负荷／分区和后续累积模型所需范围；
   从兼容 checkpoint 续算到截止点，不把“只改一条路线”误解成“只改一行分数”。
8. 事实裁剪按合并后的真实计划执行；路线点仅装配需要重算的训练。
   原有覆盖守卫和最终发布 gate 保留，不能取消守卫来让增量测试通过。
9. 旧批次缺新证据时，走明确兼容路径并记录原因和成本；
   安全所需的服务端派生重建不等于全量同步，但不能计入普通增量达标结果。
10. 接入 B04：无论增量还是兼容重建，覆盖清单都不能丢失。

### 7.3 验收与突变靶子

- 使用真实直连接收器导入“已有可信基线＋新增一场 Workout＋有效 GPX”的合成输入。
- 不再出现无条件 `route_evidence_unmerged`；
  安全前缀 reused 大于零，重算训练数量随本批影响后缀增长。
- 对原“8 次训练、47 天”夹具，分别断言原始查询量、recomputed 数和完整最终结果，
  不能只改 summary 中的计数。
- 轨迹更正／删除／归属前后移动与离线参考结果一致。
- 缺证据、未知版本和事务失败时仍保守，不发布半条路线、不冒认最新。
- 去掉路线 before 范围、强制路线一律完整计算、停止消费新证据，分别使相应测试失败。

## 8. 实施顺序与文件协作

| 工作包 | 内容 | 依赖 | 完成条件 |
|---|---|---|---|
| G00 | 固化本轮五项复现，记录工作区基线 | 无 | 修复前各夹具精确失败，不只检查源码字符串 |
| G10 | B01 路线候选持久移交和原子结算 | G00 | 缺观测不删待办，退出窗口可恢复 |
| G11 | B02 最终查询闸门和来源统一 | G10 | 所有发现入口都服从阻塞／退避 |
| G20 | B03 原任务重排闭环 | G00 | 原 analysisJobId 可查询真实结局 |
| G21 | B04 计算模式／覆盖集合分离 | G20 | 覆盖任务及成员一次结算，队列排空 |
| G30 | B05 路线 dirty 持久证据与增量消费 | G21 | 普通含 GPX 的新增跑步不再默认历史重算 |
| G31 | 定点重试、路线旧归属与三域边界补完 | G30 | 指定 UUID 可单条重开；路线点时刻退到训练开始 |
| G40 | 综合回归、目标设备分段测速及上线 | 全部 | 正确性、禁止操作和性能证据齐全 |

G10／G11 顺序修改共享 iOS 文件；G20／G21／G30 顺序修改共享 analysis／storage 文件。
每包小步提交；如与其他开发并行，先核对现有未提交改动，不能覆盖、重置或暂存丢弃用户工作。
本文不自动授权新聊天、多智能体、数据迁移或上线操作。

## 9. 验证清单

### 9.1 最小行为矩阵

| 用例 | 场景 | 核心断言 |
|---|---|---|
| U01 | 恢复任务只有完成 UUID | 待办保留，不伪造状态 |
| U02 | 完整路线候选，原始提交后立即退出 | 下次无需 HealthKit 重读也可完成本地结算 |
| U03 | 状态写、待办删或候选回收失败 | 同一结算事务回滚，恢复入口仍在 |
| U04 | 阻塞／退避 UUID 来自四种发现入口 | 不执行 route query，状态不意外复位 |
| U05 | 到期、能力提高、定点重试 | 只执行允许的 UUID，其他待办不饿死 |
| U06 | 分段读取期间漂移 | 原 id 自动重排，原 dirty 范围不后移 |
| U07 | 物化后发布前依赖推进 | 安全重排或明确最终拒绝，不错报新鲜度 |
| U08 | 两个需完整计算的合并成员 | 一次发布后成员完成，drain 不重复计算 |
| U09 | 证据缺失／损坏／成员取消 | 不伪造覆盖，不误结算 |
| U10 | 新增普通 Workout＋GPX | 真接收／真捕获／真发布，前缀实际复用 |
| U11 | 路线-only 更正、删除、归属变动 | 新旧范围全覆盖，最终数值与参考一致 |
| U12 | 大历史＋同一近期 GPX 变更 | 必要输入量不随无关全历史线性放大 |

### 9.2 检查命令和证据纪律

实施时按范围运行：

```sh
npm run typecheck
npm run test:ios
npm run check:scripts
npm run check:docs
npm test
```

- 定向补跑 input-pinning、coverage-merge、job-merge、domain-reuse、pruning、
  direct-sync-ingest 以及 Swift 路线持久化／后台恢复回归。
- ~~共享契约影响 Web 消费时补 `npm run build`；确有桌面交互变化才跑 `npm run test:e2e:web`。
  不运行冻结的响应式／移动 Web E2E。~~
  > **2026-10-18 更正（D17）**：Web 与 macOS 已于 2026-10-17 退役删除，`npm run build` 与
  > `test:e2e:web` 随之**删除、不可复跑**；保留原句仅为历史可追溯，不要照做
  > （[DECISIONS](DECISIONS.md) D17、[ADR-006](adr/ADR-006-retire-web-and-macos.md)）。
- 新 npm 脚本使用跨平台 Node 实现；新增 Swift、脚本和工程文件验证 LF。
- 基准与参考计算使用程序生成的合成库，不复制生产健康库。
- 保留已有不通过项的准确记录，未定位问题不凭“这次没改”就宣称无关。
- 日志直接保存真实退出码，不用 `| tail` 后的成功码冒充测试通过。
- 需要突变验证时使用隔离测试目录，不能在共享工作区运行突变的同时编辑同一源文件。
- 本地 Swift 纯逻辑测试不替代真实 HealthKit、锁屏及后台恢复验收。

### 9.3 性能验收

1. 各工况预热后至少运行 30 次，记录 p50、p95、最大值，冷启动单独统计。
2. 分开记录 HealthKit 查询、打包／上传、解析／入库、输入捕获、CPU、候选写入和发布耗时。
3. B01 的恢复结算应只处理小型本地元数据，不重新导出已确认批次。
4. B02 的阻塞／未到期路径 route query 次数为零；只剩阻塞项不即时自旋。
5. B03 自动重排期间不触发手机重传；B04 已覆盖成员不重复执行模型计算。
6. B05 近期普通 GPX 增量应实际复用前缀；固定必要窗口下，历史量扩大 10 倍，
   输入行数和计算量不能近似扩大 10 倍。
7. 以本轮正确数值结果为基线，不以漏算或虚报复用得到的低耗时作比较。
8. 已有租约目标保留：200 空窗口 p50 小于 100ms；p95 独立报告，
   不把该微基准换算成端到端同步承诺。
9. 真机及目标服务器的时延预算须在实际测量后确定，未测不填写达标秒数。

## 10. 迁移、上线和失败处置

### 10.1 兼容迁移

- 服务端新增执行模式／路线 dirty 字段使用追加迁移；
  当前 v44 仍处于工作区中，后续编号以实际集成顺序为准。
- 不修改已冻结历史迁移，不原地更新 checksum 让门禁变绿。
- 本地 iOS 结算表及任务字段兼容旧任务，明确区分缺键、空值和损坏。
- 不生成业务或迁移备份；确需结构迁移时由维护者核对目标、停写和兼容版本后显式执行，
  不把维护扫描放到每次同步里。
- 不全库回填路线证据，不把未知历史伪装成已验证覆盖。

### 10.2 上线顺序

1. 先交付复现和正确性保护，再交付提速，不能先放宽复用／发布判据。
2. 路线候选的持久写入与恢复消费同批接通；未升级记录按缺证据保留待办。
3. 路线 dirty 证据生产端先就绪，新消费端兼容旧批次缺字段。
4. 新执行证明读写同批接通；更新任务查询及必要的 iOS 终态纠正合同。
5. 部分功能关闭时只能退回已知正确的增量路径，不恢复原有漏算、漏待办或全量同步链路。

### 10.3 已有错误状态

- 对已丢路线待办，只在有可信 UUID／scope／批次证据时定点恢复，不扫描全部健康历史猜测。
- 对原 job failed、后继已成功的历史情况，只能凭真实覆盖证明纠正，不按时间近似匹配。
- 对已重复排队的成员，以当前发布实际覆盖证明结算，不能仅看到某个成功 job 就批量改成功。
- 兼容失败时保留旧发布和明确的待更新状态；没有安全回退版本时暂停相应分析发布，
  不以“先继续跑”冒认正确。

## 11. 完成定义

- [ ] 五项缺陷各有修复前失败、修复后通过的生产接线行为证据。
- [ ] U01–U12 覆盖退出、恢复、取消、损坏证据和并发输入推进。
- [ ] 恢复不丢路线状态／待办，所有发现来源都服从最终调度闸门。
- [ ] 原 `analysisJobId` 可查询真实结局，已覆盖成员不会重复重算。
- [ ] 普通含 GPX 的新增跑步有完整 dirty 证明、真实前缀复用和正确最终结果。
- [ ] 原始 committed 事实不因分析或本地结算失败而被否认。
- [ ] 全量同步、anchor 重置、整库备份、候选主库和文件换库均未进入修复路径。
- [ ] 所有未测、未通过项目如实列出，不用“已实施”替代“已验收”。

## 12. 实施记录（2026-10-17，第二轮）

> 基线：`HEAD=c986309` + 当时工作区（含前序 R01–R07 的未提交改动）。
> 本轮只改与本方案相关的文件；未提交、未上线、未真机验收。

### 12.1 已完成（G10 → G11 → G20 → G21）

| 包 | 缺陷 | 落地内容 | 判据（可执行） |
|---|---|---|---|
| G10 | B01 | `RouteCommitCandidate`（版本化：scope／批次／观测／完成 UUID／游标）持久化进 `SyncTaskState.routeCommit`；`RouteCommitSettlement` 逐条核对“每个要删的 UUID 必须有本批完整观测”；`sync_route_settlements` 结算槽在 `commitSuccess` **同一事务**写入；`settlePendingRouteCommit()` 是唯一结算入口（提交后当场 + 启动时补结算共用） | `RouteCommitSettlementRegression`（40 条）、`RouteSyncStatePersistenceRegression` 的 B01 段（18 条，真库） |
| G11 | B02 | `RouteQueryPolicy` 统一最终 fetch 闸门：`blocked-size`／未到期 `retry-wait` 先于一切来源；预算其次；查询间隔最后。`HealthKitExport` 删掉四个并行放行口，改为单一 `decide(...)`；预算分支保留完整旧 todo（不再把调度列清成 ready） | `RouteCommitSettlementRegression` 的 B02 段（四条入口 + 到期/能力提高/显式重试 + 防饿死） |
| G20 | B03 | `RecomputeJobRepository.requeueForReplan()`：原任务 `running → queued`（同 id、同回执、同登记证据），半写 run 结算为 `InputDriftReplan`；`replanAfterInputDrift` 不再 `enqueue` 后继，`runDirectSyncAnalysis` 在重排成功时**不抛错** | `recompute-job-replan.test.ts`（3 条）；`analysis-input-pinning.test.ts` 的漂移用例改为断言**原 id** `queued` + `replan_pending` + 无后继 + 新计划 |
| G21 | B04 | `mergedBatchIds` 与 `executionMode` 解耦：所有 rebuild 分支保留「登记批次 ∪ 本路径可归因批次」；`executedPlan` 版本化为 `{version:1, mode:"partial"\|"rebuild"}`，SQL NULL 只剩“旧绑定缺证据”一种含义；解析器对未知版本/模式/`rebuild` 带边界失败关闭 | `analysis-coverage-merge.test.ts` 2 条（rebuild 覆盖清单、partial 版本化边界）+ `analysis-job-merge.test.ts` 20 条 |
| G30 | B05 | 新增 v45 `import_batches.analysis_dirty_plan_json`；接收端在同一事务里写入版本化证据（`{version:1, full, dirtyFromAt, domains, routeDirtyTimes, recoveryBoundaries, reasons}`）并**提交前回读**；消费端 `planDirtyForBatches` **逐批取证再合并** —— 含路线的批次不再"有 GPX 就全量"，缺证据/损坏/该批 `full` 仍退回显式全量 | `batch-dirty-evidence.test.ts` 9 条（解析三态）；`analysis-coverage-merge.test.ts` 3 条（证据重建、损坏拒绝、`full` 保持全量）；`direct-sync-ingest.test.ts` 的 GPX 用例新增 5 条断言（真接收器 + 真 ZIP 目录） |
| G31 | 补完三项 | ①定点 UUID 重试；②路线旧归属快照；③路线点时刻进相交回退 | 定点重试 4 条、`dirty-range-route` 4 条、GPX 用例三域断言 |

### 12.2 附带修正（不是新缺陷，是统一闸门后自然消失的第二实现）

旧 fetch 条件里的 `previous.status != .settled` 让 **`cooling` 路线的 12 小时间隔形同虚设**：
`cooling != settled` 恒真 ⇒ 每一轮都会重新查，`RouteSyncStateMachine.coolingInterval` 只在
`rediscoveryCandidates` 里生效。统一走 `RouteQueryPolicy` 之后，`cooling` 恢复按
`shouldQuery` 的间隔执行；`settled` + 明确待办仍会执行（不会被降频饿死）。
方向是"少查"，不是"漏查"——`shouldQuery` 到期后照样查。

### 12.3 B05（G30）：路线 dirty 证据的落点与边界

**已实施**。核心判断是：接收端**本来就算过**这份计划（`loadDirtyRangeInput(db, [jobId], routeDirtyTimes, …)`
里的 `routeDirtyTimes` 就是"路线变更所属训练的开始时刻"），缺的只是**持久化**与**消费端读取**。
所以没有新造一套边界算法，只把同一份结果挂到批次行上。

落地：

1. **迁移 v45**：`ALTER TABLE import_batches ADD COLUMN analysis_dirty_plan_json TEXT`，
   名称 `batch_analysis_dirty_evidence`，冻结校验和随迁移一同写入。
2. **证据形态**（`batch-dirty-evidence.ts`）：`{version:1, full, dirtyFromAt, domains,
   routeDirtyTimes, recoveryBoundaries, reasons}`。只含时刻与边界，**不存 GPX、不存轨迹点**。
3. **接收端**（`direct-sync-ingest.ts`）：在 `analysisRequired` 分支里，`dirtyRange` 算完后
   立刻写入，**提交前回读**；不匹配抛普通 `Error`（数据库问题，不冒充对外拒收码），整批回滚。
4. **消费端**（`analysis-input-reader.ts`）：`planDirtyForBatches` **逐批**取证再合并 ——
   有证据的批次用证据（`full` ⇒ 全量），损坏 ⇒ 全量，`absent`（v45 之前）且带路线摘要 ⇒
   兼容全量；`absent` 且无路线 ⇒ 仍然只做**一次**批量账本重建（省掉 N 次全表扫描）。
5. **B04 接入**：rebuild 分支的 `mergedBatchIds` 已包含这些批次，覆盖清单不因 B05 丢失。

失败方向没变：缺证据 ⇒ `route_evidence_unmerged` ⇒ 全量。收益只在"证据齐全"时兑现。

### 12.3.1 补完的三项（G31）

1. **定点 UUID 重试**（§4.2 步骤 6）——完整链路已通：
   - `RouteQueryPolicy.decide(isExplicitRetry:)`：只重开点名的 UUID，**其余阻塞/退避原样保留**
     （"其他待办不饿死"是同一条判据的另一半）；
   - `HealthKitExport.exportArchive(routeRetryWorkoutIDs:)`：点名的 UUID 即使没有待办也临时登记
     一条 —— 否则 `todo == nil` 会让它服从状态机降频（settled 未到期 ⇒ 不查），界面上点了
     "重试"却什么也没发生；随后走 `reopened`；
   - `HealthKitSync.sync(routeRetryWorkoutIDs:)` ← `AppWebView` bridge 的 `routeRetryWorkoutIds`；
   - Web（iOS 壳）训练详情页的「重试这条轨迹」按钮（`WorkoutDetail.tsx`）。
   - ⚠️ 入口只在 iOS WebView 壳可见（`hasNativeBridge()`）；桌面 Web 没有 HealthKit，不显示。

2. **路线归属变化的旧范围**（§7.2 步骤 3）——接收端在解析**之前**快照
   `route.id → 旧归属训练开始时刻`，`routeDirtyTimes` 取「旧 ∪ 新」。
   ⚠️ **如实说明**：当前 `preserveAbsent: true` 下，同一路径的冲突会保留旧 owner
   （`deleteRoutesByPathExcept` 返回 false、新行不插入），所以"归属移动"在直连车道**不可达**；
   这次是**防御性**加固（关闭 preserveAbsent 或未来更换 owner 语义时不再漏），
   没有生产级复现夹具，不能说成"已验收的缺陷修复"。

3. **路线影响进入负荷/分区**（§7.2 步骤 7）——发现并修了一个**真实缺陷**：
   `planIncrementalAnalysisDirtyRange` 对 `route` / `activity_summary` 只做 `addInstant`、
   **不进相交回退**，于是落在训练中段的路线时刻不会退到训练开始 ⇒ 训练前半段的特征、负荷与
   分区不会被重算（"只改一条路线"被误解成"只改一行分数"）。现在点时刻也构造点区间进回退，
   三域都取该边界。

   同一处还补了两条守卫（都是"看起来绿、其实漏"的形态）：

   - **`activity_summary` 与 `route` 共用 `else` 分支** —— 判据必须两条实体都钉，否则将来
     有人按实体拆分支时，活动摘要会静默退化成"只取时刻"；
   - **只有 `end` 没有 `start`** ⇒ 全量（`invalid_health_interval`）。旧实现会把 `end` 当
     变更起点，等于把更早的那半段留在边界之外。判断这条时**必须同时给一条能产生边界的
     变更**：孤立场景本来就会因 `health_boundary_unknown` 变全量，删掉守卫也照样绿（假绿）。

   ⚠️ **区分力在哪**：`direct-sync-ingest` 的 GPX 用例断言了三域同值，但它的 `routeDirtyTimes`
   来自"该路线所属训练的开始时刻"，天然等于训练起点 —— **旧代码也能过**，那是集成检查、
   不是缺陷复现。真正能区分新旧的是纯函数用例里的 `09:20`（训练 09:00–09:30 中段）：
   旧代码给 09:20，新代码回退到 09:00（突变 A 已验证它转红）。

未做的事（如实列出）：

- §7.3 的"重算训练数量随本批影响后缀增长"没有构造 8 训练/47 天的对照夹具；本轮证明的是
  **计划形态**（partial 而非全量）与**证据链路**（接收端写入 → 消费端读出），不是最终的
  训练计数。端到端计数验收仍属 G40。
- 定点重试的**界面验收**（真机点击 → 只重查那一条）没有跑；本轮只到类型检查与纯策略断言。

### 12.4 实跑结果（本机，2026-10-17）

| 门禁 | 结果 |
|---|---|
| `RouteCommitSettlementRegression` | 44 条通过（含定点重试的 4 条） |
| `RouteSyncStatePersistenceRegression`（真库） | 128 条通过（含 B01 的 18 条） |
| `SyncTaskMigrationRegression`（新增损坏候选降级用例）/ `SyncStateCommitRegression` | 均通过（后者 72 条） |
| `analysis-coverage-merge.test.ts` | 9/9 通过（含 B05 的证据重建、损坏拒绝、`full` 保持全量） |
| `analysis-input-materialization.test.ts` | 19/19 通过 |
| `analysis-input-pruning.test.ts` | 19/19 通过 |
| `analysis-job-merge.test.ts` | 20/20 通过 |
| `recompute-job-replan.test.ts` | 3/3 通过 |
| `analysis-input-pinning.test.ts` | 6/6 通过（漂移用例已按 B03 的新契约改写：原 id `queued`，不是 `failed`） |
| `recompute-job-repository` / `service` / `training-metric-domain-reuse` / `route-point-snapshot` | 41/41 通过 |
| `batch-dirty-evidence.test.ts`（B05 解析器） | 9/9 通过 |
| `dirty-range-route.test.ts`（路线/活动摘要三域边界） | 6/6 通过 |
| `direct-sync-ingest.test.ts`（真接收器 + 真 ZIP 目录） | 19/19 通过；GPX 用例新增 8 条断言（版本、`full=false`、边界、路线时刻指向该训练、三域同时推进） |
| `migration-policy.test.ts` / `direct-sync-migrations.test.ts` | 13/13 通过（v45 冻结校验和 + 新列） |
| `check:scripts` / `check:docs` | 通过（116 条 script / 543 个链接 0 问题） |
| `npm run typecheck` | 通过（`tsconfig.json` 与 `tsconfig.pure.json` 均 `EXIT=0`） |
| `npm run test:ios` | 通过（类型检查 94 个文件 + 纯逻辑回归，`EXIT=0`） |
| `npm run check:ios-gates` | 10 支里 9 支通过；`check-pr5-facts-analysis.py` **预存在**失败（缺 `var/reports/pr5-c9-baseline-keys.json`，`var/` 不入库，与本轮改动无关） |
| 完整 `npm test` | **未跑**（本轮只跑受影响的定向文件） |

突变验证（每条都在隔离副本上改坏、跑红、再改回）：

- 把 `RouteCommitSettlement.isObservation` 改成恒 `true` ⇒ 哨兵用例转红（`precondition failed: a baseline sentinel is not proof of observation`）；
- 删掉 `RouteQueryPolicy` 的 `blocked-size` 拦截 ⇒ 四条入口用例转红；
- 把 `route_evidence_unmerged` 的覆盖批次改回 `[]` ⇒ B04 用例转红；
- 把 `requeueForReplan` 的 `status='queued'` 改成 `'failed'` ⇒ B03 用例转红；
- 把 `routeCommit` 的解码从 `try?` 改回 `try` ⇒ 一份损坏的候选让**整份任务**解码失败
  （`keyNotFound: scope`），`SyncTaskMigrationRegression` 的损坏容错用例转红；
- 把接收端的 `UPDATE import_batches SET analysis_dirty_plan_json = …` 删掉 ⇒ 提交前回读不匹配，
  整批失败（`analysis dirty plan read-back mismatch`），GPX 用例转红；
- 把 `planDirtyForBatches` 改成直接 `return null`（忽略证据）⇒ R02 与 B05 的 partial 用例一起转红；
- 把 `pickInstant` 的 `undefined` 改回按 `null` 处理（缺字段当成"该域全算"）⇒
  `batch-dirty-evidence` 的"缺 domains 字段"用例转红（这条是**测试先抓到的真缺陷**，
  不是事后补的突变）；
- 把点时刻的 `intervals.push` 删掉（回到"只 `addInstant`"）⇒ `dirty-range-route` 第 3、4 条
  （`route` 与 `activity_summary`）同时转红；
- 把"只有 `end` 没有 `start`"的守卫改回裸 `continue` ⇒ 第 5 条转红
  （带另一条能产生边界的变更时，partial 会替代应有的全量）。

### 12.5 未验证 / 已知残留

- **真机 HealthKit**：B01 的“提交后立即杀进程 → 下次启动只凭本地候选结算”没有在 iPhone 上跑过；B02 的四条来源只在纯策略层断言，没有真实 `HKWorkoutRouteQuery` 调用计数。
- **目标服务器**：B03/B04/B05 没有在线上库副本上跑过（没有复制生产库，按硬约束）。
- **B05 的 v45 迁移**：只在 `RaiDatabase.open()` 的合成库上验证过；目标库执行前仍需按 §10.1
  核对 pending、停写与兼容版本。未做全库回填（老批次保持 `NULL` ⇒ 兼容全量）。
- **B05 的端到端计数**：证明的是"计划形态是 partial + 证据链路通"，不是"重算训练数从 8 降到 N"。
  8 训练/47 天夹具的前缀复用计数与最终数值等价仍属 G40 验收。
- **完整 `npm test`**：未跑。移动端/Web 端未受影响，但“全套绿”这句话本轮不能讲。
- **定点重试的界面验收**：链路已通（Web 按钮 → bridge → `exportArchive` → policy），但真机上“点一次只重查那一条”没有跑过。

