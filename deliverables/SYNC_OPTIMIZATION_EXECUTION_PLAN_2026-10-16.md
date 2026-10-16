# RAI 同步与计算优化 · 落地方案（O01–O12 → 16 工作包 / S0–S5）

> 依据：[iOS 增量同步、解析入库与模型计算审查及实施方案](../docs/IOS_SYNC_PERFORMANCE_REVIEW.md)
> （审查日期 2026-10-16，源码基线 `2e7a231`）。
> 本文档是**执行锚定文档**：把审查文档的 12 项优化（O01–O12）转成可执行、可验证、可回滚的工作包与执行序。
> **状态：S0 + S1 执行中**（本轮范围经确认）；S2–S5 方案齐备、待排期。
> 核实：三方只读核实（iOS 端 / API 端 / 存储与计算端）逐条落到 `文件:行号`，全部与审查文档一致；
> 唯一失败门禁实跑 **1 fail / 6 pass**（`direct-sync-analysis-registration.test.ts`，第三 `directSync` 产出方
> = `apps/api/src/import-worker.ts` 的 no-op 回执）——S0 修复，不得删守卫。

## 一、范围、优先级与本轮交付

- **优化目标**（沿用审查文档 §1.1）：同步成本随「新增/更正/删除/待续量」增长而非随历史库增长；计算只算受影响后缀；
  并行推进时不丢记录、不混代、不把旧结果显示为最新；「事实已保存」与「分析已发布」两个独立结论保留。
- **不做**：全量同步/重置 anchor/整库备份/候选库/文件换库/全库检查作为优化或恢复手段；不把评分核心搬到 iOS；
  不改评分公式、时间语义、缺失值语义、来源优先级（审查文档 §1.2 全表效力不变）。
- **优先级**：O01–O07 = **P1**（正确性，含两条会丢数据/错复用的实测缺陷）；O08–O12 = **P2**（性能，先建正确基线再比速度）。
- **本轮（S0+S1）交付**：WP-00（文档入库）→ WP-01（no-op 门禁）→ WP-02（复现夹具）→ WP-12（O03）→ WP-10（O01）
  → WP-13（O05）→ WP-11（O02）；每包独立门禁 + 分组提交；S1 收官后与真机验收同批（build 打包）。

## 二、12 项优化逐条（执行视图）

> 详细实施步骤以审查文档 §3–§5 为权威版本（本文给出执行要点与验收口径；不重复其全部论证）。
> 「风险」只列该项特有的；全局纪律与共享风险见 §四/§六。

### O01（P1·WP-10）训练页、载荷页与 anchor 一致
- **模块**：`HealthKitExport.swift`（`runningWorkouts` / `exportArchive` / `writeGlobalRecords`）、`SyncTaskState.swift`、
  `SyncTaskStore.swift`、`DirectSyncBatchBudget.swift` + iOS 回归。
- **现状（已亲验）**：`runningWorkouts` 无界累积到查询流末尾并返回末尾 anchor；`exportArchive` 渲染页在页首被字节闸门
  截至（`workoutStop = .workoutBytes`），返回时仍回传**查询末尾** anchor ⇒ 被截断训练永久跳过（补读窗口仅 14 天）。
- **改动**：①拆开「正式 anchored 训练流」与「近期/待办路线发现」；②训练页处理器携带
  `anchorBefore`/`anchorAfter`（后者在处理完该页前只是候选）；③一次查询一页、先渲染再以**实际序列化字节**校验；
  ④整页放不下 ⇒ 不写该页、不推进 anchor、缩小 limit 从同一 `anchorBefore` 重查；⑤单条超满额 ⇒ 可见阻塞态 + 保留起点；
  ⑥仅当「新增全入载荷 + 删除已发送或进持久待办」才生成 `anchorAfter` 候选 → 随任务落盘 → durable receipt 后
  由 `commitSuccess` 原子提交；⑦未交付路线交 O02 队列（复用 WP-12 的统一收尾装配通道）。
- **预期效果**：被截断训练不再被跳过；查询侧不再预积累全部训练，峰值输入受页预算约束。
- **验收**：超两页训练强制第二页字节拒绝 ⇒ 首批 anchor 只到已交付页；各注入点退出后 UUID 并集与输入一致；
  删除-only 页不是 EOF。
- **风险**：anchor 推进过快=丢数据、过慢=重复读 ⇒ 以「页全交付」为唯一生成条件；门禁切片锚不得被注释劫持。

### O02（P1·WP-11）未查路线持久待办
- **模块**：O01 的 iOS 文件 + `RouteSyncStateMachine.swift`（`rediscoveryCandidates`）。
- **现状（已亲验）**：预算拒绝路径只写易失标记 `routeStopReason = .routeFile`，不写 routeDecisions；
  `rediscoveryCandidates` 只遍历已有状态行 ⇒ 从未查过的历史训练被挡住后**无法再被找到**；`sync_pending_routes` 表不存在。
- **改动**：①本地 SQLite 新表 `sync_pending_routes`（`(scope, workout_uuid)` 唯一 + 原因/重试/公平轮转字段，纯 UUID 队列）；
  ②预算不足时未查 UUID 入候选待办（替代布尔标记）；③`SyncTaskState` 可选字段 + 显式 `init(from:)`，服务端确认后
  `commitSuccess` 同事务更新队列与 anchor；④下批从队列取有限 UUID 经 `knownRunningWorkouts` 定点查询；
  ⑤仅整条路线交付成功才移除；不可达/锁屏不伪造；⑥超大路线阻塞态、不触发无进展补跑。
- **预期效果**：近期窗口之外的训练被挡后重启仍能定点续查；两条路线可跨批交付且不互相阻塞。
- **验收**：重启续查、两批交付、超大单条不无限补跑三个场景；「预算不足」不得写成 `lastCheckedAt`/settled 证据。
- **风险**：新表引入（用 `IF NOT EXISTS` 免升库或幂等迁移）；队列公平轮转防饿死。

### O03（P1·WP-12，S1 首个落地）删除队列守恒
- **模块**：`HealthKitExport.swift`（三分预扣与回传）、`HealthKitSync.swift`（`markSuccess` 恢复分支）、
  `SyncTaskState.swift`、`SyncTaskStore.swift`、新增纯函数 `partitionPendingDeletions`。
- **现状（已亲验）**：旧槽超预算的尾部被 `prefix` 截掉后**既不发送也不回写**（永久丢失）；回传余量只含本批两段溢出；
  `markSuccess` 在两条恢复分支遗漏 `pendingDeletions` 透传（`.waitJob` 与 `.inspect → startImport` 两处）。
- **改动**：①纯函数统一去重/限额/结算（身份 `(type, lowercasedUUID)`；旧待办先于新增；额度只扣实际发送）；
  ②余量 = 旧记录尾 + 旧训练尾 + 本批新增溢出；③空对象语义：新任务显式空 / 老任务缺键不更新 / 解码失败保留任务并报错；
  ④统一收尾装配（供全部收尾入口复用）；⑤`commitSuccess` 原子更新删除待办+anchor+游标+续批标记+任务删除。
- **守恒式**（按唯一身份集合）：`旧待办 ∪ 本批确认消费的新增删除 = 本批实际发送 ∪ 下批持久待办`，且两侧交集为空。
- **预期效果**：删除不丢、空队列可清、跨批有限步完成。
- **验收**：1 万条删除分 4500/4500/1000 全部交付；混合场景守恒；三态语义不合并；真实 store + 生产装配路径均测。
- **风险**：三态语义 off-by-one ⇒ 以守恒断言 + 突变到红钉住。

### O04（P1·WP-20）统一生成覆盖依赖的脏范围
- **模块**：`direct-sync-ingest.ts`（`dirtyFromAt`）、新增 `planIncrementalAnalysisDirtyRange`、`health-change-plan.ts`、
  计算侧 `extractFeatures`。
- **现状（核实一致）**：脏范围只取账本事件时间；特征按 `workoutStartAt >= dirtyFromAt` 选训练 ⇒ 记录时间更正
  （训练中段心率）不会回退到相交训练起点，错误复用旧特征（合成库已复现：更正后仍复用 7 个旧特征）。
- **改动**：①抽不依赖 previous 附加库的纯函数；②每条更正/删除取新、旧区间并集（删除用账本 before，v37 已备）；
  ③训练内输入查相交训练（`start_at <= changedEnd AND end_at >= changedStart`）取最早起点；④按影响域分别给出
  feature/Fitness/负荷/分区/readiness 边界（路线-only 也纳入）；⑤匹配不全拒绝复用；⑥checkpoint 续算不按固定天数截断。
- **预期效果**：更正一条心率正确重算受影响训练；增量结果与从头计算一致。
- **验收**：夹具进 `import-idempotency-and-checkpoint.test.ts`；覆盖跨训练起点/跨夜/删除/时间前后移/路线-only。
- **风险**：范围过大白算、过小错复用 ⇒ 双侧都有对照用例。

### O05（P1·WP-13）近期窗口独立限额、正式增量保证前进
- **模块**：`HealthKitExport.swift`（窗口 pass）、`DirectSyncBatchBudget.swift`、`SyncTaskState.swift`。
- **现状（已亲验）**：窗口 pass 无条件执行、与正式 drain **共用同一总预算**、先于正式流程 ⇒ 窗口吃满时正式 anchor 不动；
  命中 `recentWindowLimit`(1500) 也照推 `recentWindowReadAt`（无截断标记）。
- **改动**：①正常有游标且无积压时不重复补读窗口；②窗口 ≤ 总预算 **20%** / 正式 ≥ **80%**（初始值，待基准校准，
  窗口不借正式保留份额）；③窗口类型公平调度（睡眠/HRV/静息心率/训练优先）；④批内 `(type,UUID)` 去重、正式页被
  完整覆盖也须消费删除事件并等回执；⑤命中 limit 只判「可能截断」；⑥续批原因分项记录（未读页/删除待办/路线待办）。
- **预期效果**：正式 anchor 每轮都有前进机会；「窗口写了数据但正式游标不动」可报警。
- **验收**：三类型各 1500 条时正式流仍处理 ≥1 条或报告确定性阻塞；同输入多批收敛到无待办。
- **风险**：条件化开关必须成对（条件引入与条件退出同批）；截断不得假冒整窗完整。

### O06（P1·WP-22 [A]+WP-40 [B]）输入固定 + 代次连通（本项目最大工程）
- **A（随 S2 交付，发布并行前必须完成）**：`AnalysisInputBinding`（scope / 实际 raw 代次 / dependency 代次 / incumbent /
  配置·时区·override 摘要 / 截止 / 输入摘要）；独立只读连接同一读事务读取 + `AnalysisInputReader`/`AnalysisStore` 拆分；
  依赖代次超前时读「已发布依赖代次之后、捕获之前」的全部账本合并 dirty；新增迁移
  `analysis_run_input_bindings` + `analysis_job_coverage`；发布短事务核验绑定后原子发布+结算；
  新鲜度读**当前 active release 绑定的实际覆盖代次**。**保留 `verifyAndPoint` 全部现有校验**（不回退、不偷换）。
- **B（S4）**：只合并同 scope/同绑定未执行任务；生成覆盖任务（dirty 取最早、证据取并集）；新增迁移建「原任务→覆盖任务」
  关联（不改 iOS 枚举、不新增 `superseded` 状态）；覆盖任务真正发布后才结算被覆盖任务；防饿死（年龄/合并次数上限）。
- **预期效果**：不混代、不错误复用、发布拒绝不再来自「输入半途变化」；旧 `analysisJobId` 沿关联可查真实结果。
- **验收**：特征/负荷/时间线/发布前注入下一批导入 ⇒ 同绑定发布或安全重排；10 个排队批次只执行一份覆盖计算。
- **风险**：🔴 最高风险项（发布一致性）⇒ 严格校验保留 + 新绑定合同独立提交 + 配置变更必拒旧候选的断言。

### O07（P1·WP-21）写许可覆盖完整短事务
- **模块**：`write-lease.ts`（`withWriteGate`）、`recompute-job-repository.ts` 与全部事务点。
- **现状（核实一致）**：`withWriteGate` 分别包装 `exec` 与 `run` ⇒ `BEGIN IMMEDIATE`、写语句、`COMMIT` 可能处于
  **不同许可窗口**（许可空闲时数据库仍被锁）。
- **改动**：①新增 `withWriteTransaction(gate, database, op)`（异常回滚不覆盖原始错误）；②枚举改造 claim/complete/fail/
  recover/分块落地/发布/清理全部事务点，SAVEPOINT 复用外层许可；③事务深度 >0 时 `yieldIfStale` 不释放；
  ④分块 ≤100 行/≈50ms 并记录实际耗时；⑤写路径 `RETURNING`/`get`/`all` 纳入显式写接口；⑥租约超时改为可重试调度失败
  （**失败开放策略行为变更**，同批改回归）；⑦崩溃先关连接释放 SQLite 锁。
- **预期效果**：许可空闲时库不再被锁；无「应用许可 ↔ 数据库锁」互等；超时可恢复。
- **验收**：分析事务持有时导入拿不到许可、提交后能拿到；每条语句间插入另一执行者不互等；四类异常后无永久 busy。
- **风险**：策略行为契约变化（决策点 ②）⇒ 同批回归 + 文档对齐。

### O08（P2·WP-30）租约交接消除固定等待放大
- **模块**：`write-lease.ts`（`step()`/`loop()`）、仓库级租约基准（替换演示脚本 `scripts/measure-write-lease.mjs` 的口径）。
- **现状（核实一致）**：授权/释放完成后仍返回 `pending`，主循环据此固定 `setTimeout(5)` 等待 ⇒ 空窗口实测约 11ms/窗口
  （200 窗口 ≈ 2.17s）。
- **改动**：①状态机分 `progressed`/`blocked`/`idle`（授权/释放 = progressed 立即继续）；②仅被占用才 blocked 等待
  （有界退避 + admission 通知）；③`waitAsync` 用本轮已处理观测值作 expected；④保留序号协议/退出唤醒/重复释放保护；
  ⑤接入 O07 分块；⑥输出 windows/waitMs/yields/timeouts。
- **预期效果**：200 空窗口目标 <100ms（先消固定延时，再评估可达性）。
- **验收**：基准改调**生产实现**；三类竞态用例；先过互斥正确性再比耗时。
- **风险**：唤醒丢失 ⇒ 竞态用例全员覆盖。

### O09（P2·WP-32）负荷/分区/日级分域增量复用
- **模块**：`recompute-pipeline.ts`（`replayTrainingMetrics`/`buildAndPersistZoneProfiles`）、`training-load-data.ts`。
- **现状（核实一致）**：三个域全量遍历；`loadDailyPhysEvidence` 逐日装配重复查询重叠历史窗口。
- **改动**：①O04 分域 dirty；②带版本 checkpoint（算法/配置/时区/override/输入绑定/滚动状态，缺失即不复用）；
  ③安全前缀集合 SQL 复用 + 外键重映射；④checkpoint 恢复滚动状态（平滑/累积不按天数截尾）；⑤一输入快照批量读 +
  双指针基线窗口（保留 observedAt/availableAt/asOf 区分）；⑥一次装配复用 + 限额缓存；⑦发布 gate 保留。
- **预期效果**：近期小变更只重算受影响后缀；分析 CPU/原始查询行数较**正确基线**降 ≥50%（初始目标）。
- **验收**：增量 vs 离线从头计算一致（浮点留余量、分类/missing reason 精确比较）；每域输出 reused/recomputed 计数。
- **风险**：复用条件放宽致死 ⇒ 复用证明带版本、失败不假装。

### O10（P2·WP-31，可提前泳道）局部睡眠重建从读取阶段局部化
- **模块**：`canonicalize-nights.ts`（`loadSegments`/`loadHrv`/`canonicalizeNightsForWindow`）、按需追加索引迁移。
- **现状（核实一致）**：窗口重建先无窗口读全量，再在 JS 过滤。
- **改动**：①两加载器加可选范围参数（旧入口保语义）；②SQL 边界加在 `GROUP BY` 前、沿用本地夜间边界换算、
  先证明时间格式同口径；③保留折叠/并集/排序/`computed_at` 还原；④多不相邻时期合并夜窗口；⑤`EXPLAIN QUERY PLAN`
  实测决定索引（追加迁移，禁改历史）。
- **预期效果**：输入装配行数随窗口而非全历史；10 倍历史不 10 倍读取。
- **验收**：窗口前后边界用例 + `canonicalize-nights-range.test.ts` 一并扩展；窗口外行逐字节不变。
- **风险**：时间格式口径；索引收益必须实测。

### O11（P2·WP-50）路线读端统一、消除点数据重复复制
- **模块**：`database.ts`（`publishRouteVersion`）、全部 `route_points` 读者、新增 route point reader。
- **现状（核实一致）**：发布时从暂存分别复制到 `route_points` 与 published 版本点表（真双写）；published 槽位固定复用。
- **改动**：①枚举全部读者 → 统一 reader 按已发布 complete 版本读；②双读对照期后退役双写（不先删旧表）；
  ③legacy 读分支（下次真实更正逐条转换，不全库回填）；④staging 唯一版本 ID、pending→complete 同行提升；
  ⑤摘要命中复用；⑥版本生命周期（无引用证明前不删）；⑦与 O06 路线输入绑定一致。
- **预期效果**：点数据写放大消除；无半发布。
- **验收**：中断/失败/超配额时旧路线仍可读；点表写入行数与 WAL 字节下降。
- **风险**：先删旧表会读空 ⇒ 双读对照为硬门槛；退役双写单独立项确认。

### O12（P2·WP-41）复用 Worker、保持车道安全
- **模块**：`import-worker.ts`、`recompute-worker.ts`。
- **现状（核实一致）**：每任务建 Worker；record-only 拒收后通用车道再次建 Worker；Recompute 逐任务建线程。
- **改动**：①两导入车道移入同一任务 Worker（保资格判定/表写守卫/身份复核）；②不可变输入传递预检结果；
  ③第二阶段常驻 ingest + 受控 analysis Worker（单写者纪律）；④每任务重查 scope/schema、重建连接；
  ⑤错误对 task ID、崩溃替换线程、导入成功仍从持久回执恢复；⑥RSS 监测；⑦启动/等待/解析/事务分开计时。
- **预期效果**：20 连续小批不反复启动；省下的启动成本可测量。
- **验收**：20 小批基准；任务隔离；不绕过 O06/O07 一致性保护。
- **风险**：单写者纪律；任务间污染 ⇒ 每任务重查 + 有界缓存。

## 三、16 工作包与执行序

| Wave | 工作包 | O 项 | 优先级 | 前置 | 完成标志 |
|---|---|---|---|---|---|
| **S0** | WP-00 文档入库（含门禁挂载） | 元 | — | 无 | `check:docs` + `check:doc-refs` 实跑；**首个提交** |
| **S0** | WP-01 no-op 门禁补齐 | §2.4 缺口 | — | 无 | 原用例 7/7 绿 + no-op 行为断言 + 突变到红 |
| **S0** | WP-02 复现夹具固化 | O01/02/03/04/05/07 | — | WP-00 | 夹具在未修复基线**先红** |
| **S1** | WP-12 删除队列守恒 | O03 | P1 | WP-02 | 守恒用例 + 真实 store 路径 + 突变到红 |
| **S1** | WP-10 训练页/anchor 一致 | O01 | P1 | WP-12 | 第二页拒绝 ⇒ anchor 只到已交付页 |
| **S1** | WP-13 窗口独立限额 | O05 | P1 | WP-10 | 同输入收敛无待办；正式流保证前进 |
| **S1** | WP-11 路线持久待办 | O02 | P1 | WP-10 | 重启续查；两批交付；超大不空转 |
| **S2** | WP-20 脏范围 | O04 | P1 | WP-02 | 心率更正增量==从头计算 |
| **S2** | WP-21 事务边界 | O07 | P1 | WP-02 | 许可/锁不互等；四类异常可恢复 |
| **S2** | WP-22 输入绑定（O06-A） | O06 | P1 | WP-20/21 | 混代注入 ⇒ 同绑定发布或安全重排 |
| **S3** | WP-30 租约交接 | O08 | P2 | WP-21 | 生产基准 200 窗口 <100ms |
| **S3** | WP-31 范围 SQL | O10 | P2 | WP-02 | 窗口回归 + 10× 扩展性（可提前泳道） |
| **S3** | WP-32 分域复用 | O09 | P2 | WP-20/22 | 离线从头对照 + 复用计数 |
| **S4** | WP-40 任务合并（O06-B） | O06 | P2* | WP-22/32 | 10 批 → 1 覆盖计算，旧 job 可查 |
| **S4** | WP-41 Worker 复用 | O12 | P2 | WP-21/22 | 20 小批不反复启动 |
| **S5** | WP-50 路线读端统一 | O11 | P2 | WP-11/22/40 | 双读对照 + 写放大下降 |

\* O06 整体定级 P1（B 部分为性能合并但属同一项的收口）。

**关键路径**：`WP-02 → WP-12 → WP-10 → WP-11 → WP-20 → WP-21 → WP-22 → WP-32 → WP-40 → WP-50`；
并行支线：WP-00/01（S0）、WP-31（可提前）、WP-41（S4）。
**S1 执行序的定稿理由（D1）**：O03 的 `partitionPendingDeletions` + 统一收尾装配是 O01 步骤 6、O02 步骤 3、O05 步骤 5
的共同底座——先做 O03 避免「先写临时删除处理、随后被替换」的返工与暂态漏数。

## 四、执行纪律（每工作包统一）

- **门禁**：`npm run typecheck`；iOS 包加 `npm run test:ios`（新 Swift 文件必须挂进 `run-health-sync-tests.sh` 编译清单）；
  服务端包用审查文档 §7.1 专项命令（`node --import tsx --test --test-concurrency=1 <文件…>`）；
  通用 `check:scripts` / `check:docs` / `check:doc-refs`。全部实跑、分别报告 EXIT。
- 🔴 **新守卫必须突变到红**（含「方法仍在、逻辑失效」形态）；「跑绿 ≠ 断言有效」。
- 🔴 **改码使行号漂移 ⇒ 同批修正审查文档的 `文件:行号` 引用**（审查文档已挂进 `check-doc-line-refs.mjs` 的
  `DEFAULT_DOCS`；⚠️ 首跑实测其当前 0 处行号引用——是真空，别当已保护）。
- iOS 代码注释不得含门禁锚字面；`SyncTaskState` 新字段一律 Optional + 显式 `init(from:)`；
  服务端迁移追加式（当前最新 v37），`sync_pending_routes` 用 `IF NOT EXISTS`。
- 提交按工作包分组（`rai-commit-push` 惯例）；回滚只回退到「正确的增量实现」——**禁止**回退到漏数据实现或整库备份链路。

## 五、决策点（动工前逐项确认）

1. **O06-A 发布判据放宽**：是否引入 dependency 级发布判据放行 raw-only 批次——建议 S2 首批仍严格，放宽作为独立可开关提交。
2. **O07 租约超时语义**：从「失败开放继续写」改「可重试调度失败」是行为变更，需确认对 409/忙语义与 iOS 重试的影响。
3. **O05 预算比例**：20%/80% 为待基准校准的初始值，需确认接受先上线后校准。
4. **迁移编号**：`sync_pending_routes`（iOS）+ `analysis_run_input_bindings`/`analysis_job_coverage`（v38+）+
   覆盖任务关联 + O10 索引 + O11：谁先合并谁占版本号。
5. **O11 双写退役时机**：建议分两步（先读端统一 + 双读对照，退役双写单独立项）。
6. **O12 第二阶段常驻 Worker**：本期做还是仅第一阶段。
7. **真机验收与全量测试排期**：模拟器/Swift 门禁不能替代真机 HealthKit。
8. **文档入库形态**：WP-00 独立提交（已按此执行）。

## 六、最高风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 发布一致性（O06）：放宽判据或混代 ⇒ 旧计算当最新展示 | 严格校验保留；新绑定独立提交；配置变更必拒旧候选断言 |
| R2 | 脏范围欠算（O04）：漏相交训练/路线-only ⇒ 静默复用旧特征（已实测的真实缺陷） | WP-02 先红断言；区间并集 + 相交查询 + 账本 before；增量 vs 从头对照 |
| R3 | 删除守恒（O03）：off-by-one ⇒ 漏删或反复重发 | 唯一身份集合守恒断言；三态分离；真实 store 路径;失败不提交 |
| R4 | 事务/许可边界（O07/O08）：死锁或长事务持锁 | 事务内只短 SQL；语句间插入执行者验互等；分块实测耗时 |
| R5 | 批次前进性与 anchor（O01/O05）：早提交漏交；窗口占满正式流不动 | 候选 anchor 仅在整页交付后生成；「窗口写数据但游标不动」报警；收敛用例 |

（次级 R6：O09 复用证明缺失时把默认零当有效状态 ⇒ 带版本 checkpoint，缺失即不复用。）

## 七、核实记录与对审查文档的修正点

1. 三方核实全部一致；唯一失败门禁实跑 1 fail / 6 pass（见文档头）；O01 末尾 anchor 回传、O03 丢弃点、
   O07 许可释放点、`publishRouteVersion` 真双写均已逐段复核。
2. 措辞修正：审查文档 §2.4「白名单只包含两个文件」实为**精确集合 deepEqual 断言**（语义一致）。
3. 补充：O10 还应扩展 `canonicalize-nights-range.test.ts`（审查文档 §5 只引用了 window 测试）。
4. 行号锚点补强（实施用）：`withWriteGate`/放大点在 `write-lease.ts`；`dirtyFromAt` 在 `direct-sync-ingest.ts`；
   `publishRouteVersion` 在 `database.ts`——具体行号以实施时实读为准。
5. 审查文档当前 **0 处 `文件:行号` 引用**（用 markdown 链接形态，27 链接由 `check:docs` 覆盖）；
   其行号级保护为真空——本方案不据此声称已保护，后续补行号证据时门禁自动生效。

---

## 八、执行记录（S0+S1，2026-10-16）

**提交清单（全部已推送 origin/main）**：

| 提交 | 工作包 | 内容 | 关键验证 |
|---|---|---|---|
| `19a48bd` | WP-00 | 审查文档 + 落地方案入库；`check-doc-line-refs.mjs` DEFAULT_DOCS 挂载审查文档 | `check:docs` 476 链接 0 问题；doc-refs 139 处 0 越界（审查文档自身 0 处行号引用＝真空，已如实标注） |
| `4a91732` | WP-01 | no-op 回执登记为第三产出方（白名单 2→3，附行为守卫指引） | 组合 19/19 绿；突变 `analysisStatus→queued` ⇒ preflight 精确红 |
| `f34930b` | WP-02 | O07 许可边界复现夹具（skip 形态，WP-21 转绿） | 去 skip 实跑红（`true!==false`）→ 恢复 6 pass + 1 skip |
| `2e681dc` | WP-12 (O03) | 删除队列守恒：`DirectSyncDeletionPartition`（旧槽尾部入余量）+ 三态恢复 + 5 处统一入口 + `pendingDeletions` 去默认值 + 空余量显式编码 | Budget 77/77；record-sync 59/0（MIN_CHECKS 58）；4 突变命中 |
| `a2c9ede` | WP-10 (O01) | 查询页=交付单位：`workoutPage` 单页原语 + `deliveredAnchor` 只随完整交付页推进 + `WorkoutPageShrink` 收缩 + 删除池 UUID 去重 | Budget 83/83；record-sync 62/0；3 突变命中 |
| `96f480b` | WP-13 (O05) | 窗口条件化（复用 `needsHistoryRead` 生产判据）+ `recentWindowShare` 20% 独立份额 + 命中上限记 warnings | Budget 85/85；record-sync 66/0；3 突变命中（含首版判据盲区被突变实测修正） |
| `d4dcf9d` | WP-11 (O02) | `sync_pending_routes` 待办队列：预算拒绝两路径登记（页交付生效）+ `knownRunningWorkouts` 定点消费 + 超前登记/提交后移除 | PersistenceRegression 79/79（+13）；record-sync 70/0（MIN_CHECKS 69）；3 突变命中 |

**S1 收官态全量门禁**（2026-10-16）：`typecheck-ios` EXIT=0（94 文件）· `run-health-sync-tests.sh` EXIT=0 ·
`check-background-capabilities.py` 289/0 · `check-export-determinism.py` 14/0 · 每包 pre-commit 全过。
（长跑门禁的稳定姿势：hook 带 `apps/ios/` 时走后台任务提交，前台直跑两次被平台信号掐断——非门禁失败。）

**设计偏离（如实记录，两处）**：
1. **O02 未走 `SyncTaskState`/`commitSuccess` 通道**（审查文档 §3-O02 步骤 3 的建议），改
   「超前登记（导出后立即）+ 提交后移除（markSuccess 内、与 `upsertRouteStates` 同款收尾写）」两阶段。
   依据：锚的提交链在任务行与回执之后，任何崩溃窗口只会造成"待办早到"（upsert 幂等、下批多查一次），
   绝不丢数据；走完整同通道需再动 `SyncTaskState` 三态语义，风险/收益不划算。
2. **O05 步骤 5「窗口与正式流批内按 (type, UUID) 去重」未做** —— 服务端按 id 幂等去重，
   重复 XML 是字节效率问题（非正确性）；去重需要在 drain 渲染层加过滤，改动面大。
   留待基准校准阶段连同"去重收益"一起评估。

**遗留（S1 之外）**：
- 真机验收（A3/R1 行为 + build①/②/③）仍待排期；模拟器/Swift 门禁不替代真机 HealthKit 证明。
- 全量突变门禁（`test:ios:mutation`）本批未整体跑完（两次被平台信号掐断，抽查 2 条全 RED+hit）；
  每包 3–4 个手工突变逐条命中。顺手修复 1 条 R3b 遗留的失配锚 + 修正 1 条判据盲区。
- S2 起各决策点（§五）在对应工作包动工前逐项确认。

---

## 九、执行记录（S2/S3 进行中，2026-10-16 同轮）

**决策点裁决（§五，本轮一次性确认）**：

| # | 决策 | 裁决 |
|---|---|---|
| 1 | O06-A 发布判据放宽 | **同批引入 dependency 级判据并默认开启**（WP-22a 已落地；证明不完整一律拒绝） |
| 2 | O07 租约超时语义 | **改为可重试调度失败**（撤回请求 + 撤销排队位 + 有界重排；不再失败开放） |
| 3 | O05 预算比例 | 沿用 S1 已落地的 20%/80%（WP-13） |
| 4 | 迁移编号 | 按**落地顺序**占用：v38（WP-21）→ v39（WP-22a）→ v40（WP-31）；后序工作包各自追加 |
| 5 | O11 双写退役时机 | **一次做到底**（读端统一 + 退役 `route_points` 双写；待 WP-50） |
| 6 | O12 第二阶段常驻 Worker | **两阶段一起做**（待 WP-41） |
| 7 | 真机验收与全量测试排期 | 仍待排期（见下"遗留"） |
| 8 | 文档入库形态 | 沿用 WP-00 的独立提交 |

**提交清单（全部已推送本地主干）**：

| 提交 | 工作包 | 内容 | 关键验证 |
|---|---|---|---|
| `95ef798` | WP-21（O07） | 写许可覆盖完整短事务（代理按 SQL 净事务增量开合 + `withWriteTransaction` + `hold()`）；超时改可重试失败（撤回 + 撤销 admission 排队位 + `attempts` 有界重排）；`ChunkedWriter` 分块短事务；写/读按 SQL 语义判定 | write-lease 15/15（含去 skip 的 O07 夹具 + 生产路径夹具）；定向 104/104；5 突变命中 |
| `7c86f16` | WP-30（O08） | 租约交接三态状态机（授权/释放 = progressed）+ `waitForWake`（通知 + 有界退避）+ 观测值作 expected + `waitedOn` 归因；基准改调**生产实现** | 34/34；8 突变命中；200 空窗口 p50 101–141 ms（旧 2397 ms，≈20–23×）——**<100 ms 目标未达成**，见下 |
| `aef5951` | WP-22a/WP-31 共享 | v39 `analysis_run_input_bindings` + `analysis_job_coverage` + `import_batches` 三列；v40 `(type, end_at, start_at)` 索引 | migration-policy 8/8；冻结校验和经 tsx 通道生成 |
| `b44ea80` | WP-31（O10） | 夜间范围谓词下推 SQL（比较域 ms→文本，带 G1/G2 守卫与精确回落）；`nightWindow` 合并不相邻时期 | 28/28；8 突变命中（含"守卫触发回落而正确性用例全绿"的对照） |
| `93fd898` | WP-22a（O06-A） | 输入绑定（只读连接单读事务捕获）+ 未覆盖账本合并 + 发布短事务核验 + **D4 依赖级判据**（计算端与发布端同一实现）+ 新鲜度读 active release 绑定 | 109/109；3 突变命中；两处车道补提交前**回读断言** |
| `b798448` | WP-31 收尾 | 逐时期重建的永久回归（间隙金丝雀）+ 修正被本次改动弄漂的 `canonicalize-nights.ts` 行号引用 | 19/19；突变（改回全局跨度）只红该条 |

**如实记录的三个未达成/未做**：

1. **O08 的「200 空窗口 < 100 ms」未达成**：实测 p50 101–141 ms、min 74–78 ms。剩余成本不在
   握手逻辑 —— 每窗口必须付两次跨线程唤醒，本机主线程 `Atomics.waitAsync` 唤醒延迟
   p50 0.22–0.29 ms、p95 最坏 6.8 ms，而**不含任何生产代码**的裸 ping-pong 同口径也要
   71–168 ms。固定延时放大（10.9 ms/窗口 → 0.5–0.7 ms/窗口）已消除；目标是否可达取决于目标机器，
   **未调测量、未改目标**，基准脚本未达成时退出码 1。
2. **WP-22b 未做**：把事实读取整体拆到 `AnalysisInputReader` 的**有界物化**（审查文档 §4-O06 步骤 3–5）
   尚未落地。本轮的 WP-22a 只交付出「绑定 / 覆盖证明 / 发布判据 / 新鲜度」这一半，
   即文档所说"发布并行前必须完成"的那半。
3. **`database.ts` 的行号引用本来就已漂**（v33 时代的锚），本次 v38–v40 又各加若干行。
   逐条重锚是独立的文档审计，不在本包范围 —— 只记录事实，不假装已修好。
   ⚠️ 另：`check-doc-line-refs.mjs` 的**漂移比对在全仓是真空的**（没有任何 `*.linerefs.json` 基线），
   所以行号漂移不会被门禁发现；本轮 `canonicalize-nights.ts` 的修正是人工逐条核对的。

**执行中的共享文件顺序耦合（如实记录）**：O06-A 与 O10 的迁移同时注册在
`packages/storage-sqlite/src/database.ts` 一个文件里，而"注册了迁移模块却不带上模块文件"
就是坏提交 ⇒ 两个迁移先合成一个自洽的 schema 提交（`aef5951`），代码各自随后落地。
同理 `apps/api/src/direct-sync-ingest.ts` 同时承载 O06-A 与 O10 的 hunk，落在 `93fd898`。

**S3/S4/S5 待办**：WP-22b、WP-32（O09）、WP-40（O06-B）、WP-41（O12）、WP-50（O11）；
以及全量 `npm test` 与性能工况基准（审查文档 §6.1 的六类工况）。
