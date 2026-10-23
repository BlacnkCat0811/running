# 阶段 3 复审剩余两项问题：完整修复方案与验收条件

- 日期：2026-10-22（Asia/Shanghai）
- 依据：`/Users/ta/Downloads/RAI_Phase3_Implementation_Plan_2026-10-22.md`、本目录的阶段报告/测试矩阵/证据，以及 `/Users/ta/running` 当前源码。
- 性质：**后续实施与验收方案**。编写本文档只读取现有源码和日志；**不修改代码，不运行会写库的测试，不部署生产**。
- 范围：仅现有 iOS 所用 Node.js API、SQLite 导入/维护和共享分析包；不增加客户端、主库或常驻写者。

## 0. 结论、优先级与验收边界

前次 P1 的“未知缺库不得自动建库”和 F01 的“删除 + GPX 在同一未提交事务中强杀”已有直接行为证据。剩余两项分别是**删库后恢复的可用性/安全边界**与**T12 端到端验收口径**，不等于已证明发生生产数据损坏。

| 优先级 | 问题 | 当前可证明的范围 | 完成标志 |
|---|---|---|---|
| P2 | 删库提交与新 scope 的 `pristine` 许可跨两个持久状态，强杀后可能缺许可；初始化 CLI 又可能定位到错误 epoch | 正常删库和重启后的首包已通过；没有覆盖“主库已删、许可未写” | 任一中断点重启都不会错误建库；能根据持久操作证据恢复新 scope，或明确保持阻断并有受控恢复入口 |
| P2 | T12 在真实导入后改 canonical 到达时间，删除事务登记的任务并另建任务 | XML 接收、局部夜重建、真实 partial 计划与受控 A/B 产物等价已通过 | A 的原始登记任务（或其正式覆盖任务）实际被消费并发布；测试不事后改 canonical/导入时间；报告只声称真实证明的范围 |

实施顺序：先修删库恢复协议及 CLI，再补 T12 主路径测试，最后更新阶段报告、测试矩阵和证据清单。两项验收未完成前，`T12 单条真实任务贯通`及`删库任意中断可恢复`不得写成无保留通过。

## 1. 问题一：删库后 epoch 与首空许可之间的中断窗口

### 1.1 现状与可复现时序

`apps/api/src/server.ts` 的 `DELETE /v1/database` 先通过 `writeDeletedDatasetEpoch()` 将新 epoch 写入 `<rai.sqlite>.dataset-epoch.sqlite`，`DatabaseMaintenance.deleteDatabase()` 随后删除主库；返回之后才调用 `establishPristineScope()` 为新 scope 写许可。两步跨不同 SQLite 文件和文件删除操作，不能视为单事务。

强杀在“主库已删、许可未写”之间：重启的 `readDatasetEpoch()` 会从侧车读出新 epoch；启动观察发现主库缺失且该 scope 没有可信许可，正确地阻断自动建库。此时 `data:init-scope` 却直接用环境变量 `RAI_DATASET_EPOCH`（通常仍是配置值 `default`）构造 scope，而非读取侧车中实际生效的随机 epoch。它可能因旧 scope 已有证据而拒绝，也可能在空账本里错误地给旧 scope 写一张无用许可。已有 `P1-8` 只直接调用状态库方法，不经过真实删库、侧车读取、强杀与 CLI。

**必须保持的安全不变量：**文件缺失本身永远不是首次安装或删库完成的证明；旧 scope 的许可不可复活；一张新 scope 的许可只能对应一次可信的显式初始化/删除操作，并在写者进入后永久失效。无法判明删除是否完成、账本是否曾被消费或两份状态是否同源时，保持 `recovery_required`。

### 1.2 推荐实现：持久删除操作记录 + 同源 scope 校验

1. **给删除操作分配身份。** 在维护锁/单写者边界内生成 `deletionId`、`previousEpoch`、`nextEpoch`。在现有 dataset-epoch 侧车中扩展一条持久删除操作记录（或同等独立持久介质），包含配置 epoch、以上三项、保护快照标识、状态与更新时间；不把它当成第二份健康主库。安全快照已经由 `deleteDatabase()` 创建，记录应能绑定这份快照。所有字段形状及配置身份必须严格校验；异常、缺键或不匹配均拒绝恢复。
2. **明确单调阶段。** 建议阶段为 `prepared → main_removed → permit_issued → writer_entered`。`prepared` 在保护快照确认可用且删除主库前持久化；主库及 WAL/SHM 移除、目录持久化完成后才写 `main_removed`；`RuntimeStateStore.establishPristineScope(newScope, "explicit_database_delete:<deletionId>")` 成功后写 `permit_issued`。首次写者必须先持久化 runtime 账本的 `writer_entered`，再持久化侧车的 `writer_entered`，两者成功后才写主库。任一写入失败都阻断：若只完成第一步，许可已撤销但主库未写，属于可诊断的保守停机。顺序中每一步都可重放或保守阻断，绝不靠“文件现在不存在”补造 `main_removed`。
3. **绑定 runtime 账本实例。** 删除操作记录保存 `runtime.sqlite` 的稳定实例标识或等效校验值。恢复时必须同时满足同一个 `deletionId`、`nextEpoch`、scope、账本实例及未消费状态；账本损坏被隔离重建、实例标识变化时不得自动重签许可。若要支持这种情况，只能在核对保护快照与操作记录后走显式运维恢复，不能把新建空账本解释为从未有写者。现有 `unknown/pristine/writer_entered/established` 语义保持不变。
4. **启动恢复必须按阶段裁决。** `prepared + 主库仍在`：使用主库中的旧 epoch，保持旧 scope；核对并收口遗留意图。`prepared + 主库缺失`：无法区分删除已发生与暂时不可见，阻断并要求运维选择恢复旧库或在核对快照后完成删除。`main_removed + 主库缺失 + 同源账本未写者进入`：可幂等补写同一操作的许可；已有同一 `deletionId` 的 `pristine` 视为重放成功。`permit_issued + 主库缺失`：仅允许消费原许可，不能生成新代次。任何阶段若发现主库已存在、账本已是 `writer_entered/established` 或身份冲突，都不得签发许可，并按现存主库/恢复事实裁决。
5. **修正 CLI 的身份来源与模式。** `data:init-scope` 应以与 API 相同的 `readDatasetEpoch(databasePath, configuredEpoch)` 取得**生效 epoch**，同时校验配置身份；输出配置 epoch、持久 epoch、scope 和许可来源。把“全新安装”与“恢复一笔已记录的删库操作”区分为显式模式：前者仅在无删除操作且无历史证据的受控初始化条件下使用；后者必须指定/核对 `deletionId`，默认只读检查，执行时复用该操作而不创建第二张许可。侧车损坏、主库存在、账本不匹配或操作已消费时退出非零，不改变主库。CLI 与 API 不得各自实现一套 epoch 选择规则。
6. **与现有维护恢复协调。** `DatabaseMaintenance.deleteDatabase()` 当前对普通异常会尝试从安全快照恢复；新操作记录需在回滚成功时收口并回到旧 epoch。SIGKILL 不执行 `catch/finally`，必须依赖启动恢复阶段。恢复备份成功后应把**最终生效** scope 登记为 `established`，并使尚未消费的删库意图不再发放许可；回滚旧库时最终 scope 是旧 epoch，显式恢复并生成新 epoch 时则是恢复后的新 scope。不得通过清空旧账本、手工改随机 epoch 或直接新建主库来“修复”中断。

**实现取舍：**可以使用独立删除 journal 而非扩展 epoch 侧车，但必须与侧车相互绑定，并保留上述阶段/实例校验。若暂不实现自动重放，允许把 `main_removed` 后的恢复做成显式运维命令；验收仍须证明命令定位正确 epoch、操作幂等且失败关闭。`prepared + 主库缺失` 不得自动转成 `main_removed`。

### 1.3 故障注入与验收条件

在隔离的真实 API 子进程、真实 `DatabaseMaintenance`、真实侧车/runtime/main SQLite 上注入确定性屏障；每次 SIGKILL 后用**原目录**重启，不能由测试手工修补状态。至少覆盖：

| 中断/输入 | 必须观察到 |
|---|---|
| 首次安装，没有主库/删除记录 | 显式初始化写当前生效 scope 的一张许可；首包建库一次；第二次初始化拒绝 |
| `prepared` 写入前或刚写入，主库仍存在 | 旧主库/epoch 可见且数据不变；新 scope 无可消费许可 |
| `prepared` 已写、删除主库中途强杀，主库缺失 | `recovery_required`；无自动建库、无猜测终态、来源保留；运维恢复旧库或显式核实后完成删除 |
| 主库已删、`main_removed` 已持久化，但 `pristine` 未写时强杀 | 重启/显式恢复只为侧车中的 **nextEpoch** 补写一次许可；`data:init-scope` 不碰旧配置 scope；首包可成功 |
| `pristine` 写入后、响应前强杀 | 同一操作重放不产生第二张许可/第二个 epoch；首包一次；旧 scope 不复活 |
| 首包写者已进入后主库再次消失；runtime 账本损坏或丢失 | 不再获得 `pristine`；不创建新空库；保持恢复阻断 |
| 侧车损坏、配置 epoch 不匹配、快照缺失、账本实例不符、写账本失败 | 明确诊断并退出非零；不写主库、不发布终态、不清理来源 |
| 保护快照回滚或恢复旧库 | 旧库事实/回执保持；未消费的新 scope 许可不可再用；恢复后 scope 为 `established` |

**问题一完成条件：**以上状态转移在正常、强杀和重复恢复中均单调；CLI 输出的 scope 与 API 重启采用的 scope 完全相同；没有任何“旧库暂时缺失/账本隔离重建”序列创建新主库。保护快照、epoch 侧车、runtime 账本与上传来源均纳入断言。验收日志记录 `deletionId`、每次阶段转移、故障点、恢复决策和最终 epoch，但不记录健康数据。

## 2. 问题二：T12 测试未执行导入事务登记的原任务

### 2.1 现状及证据边界

`apps/api/test/phase3-t12-real-lane.test.ts` 已让 A/B 两库经过真实 v2 XML 接收、局部 canonical 重建与 `recompute_jobs` 登记。随后 `discardQueuedJob()` 直接 `DELETE` 原任务，A 取原 `incrementalPlan` 另建任务；B 也删任务后另建全量任务。`alignCanonicalArrivalTimes()` 还把 `canonical_nights.computed_at`、`canonical_hrv_days.computed_at` 以及 `import_completed_at` 统一回写到早于导入的固定日期。这些时间字段参与 readiness 的可用性判断（`model-v2-snapshots.ts` 按 `computed_at <= asOf` 过滤，并读取导入完成时刻），不是可以任意忽略的执行标识。因此该用例证明的是**经过真实接收的受控状态上的算法/发布等价**，仍未证明原登记任务的领取、绑定复核、合并/重排与发布，也没有证明自然到达时间下的 as-known-then 行为。

### 2.2 推荐实现：A 走原任务，B 是明确标注的全量对照

1. **保留 A 的原任务 ID。** 从导入回执 `analysisJobId` 和 `recompute_jobs.request_json.importBatchId` 双向核对同一行；断言目标 raw/dependency generation、父发布 ID、`dirty_json` 与 `import_batches.analysis_dirty_plan_json` 一致。不要对 A 执行原始 SQL `DELETE`，也不要把 `incrementalPlan` 复制到一条新任务。通过生产使用的 `RaiApplicationService.runNextJob()` 或 API recompute worker 领取并执行该任务。若既有合并策略产生覆盖任务，则要求 `analysis_job_merges` 显示原 ID 被正式覆盖并随覆盖任务发布，不能仅有一条新的无关联任务成功。
2. **把时间控制放在写入前。** 对测试夹具引入可审计的内部时钟注入（生产默认仍使用真实时钟），覆盖导入提交时刻、canonical 计算时刻、任务 `evaluatedAt` 与发布时刻；不要用全局 `Date` 猴子补丁，也不要导入后 `UPDATE canonical_*` 或重写 `import_completed_at`。A/B 使用同一确定性时钟序列。每个模拟上传的采样结束时间不得晚于它的模拟到达时间；若保留 70 天的逐日 readiness 中间期比较，应分日/分段真实导入，使被比较日期在当时确有可用事实。若采用一次历史回填，则将早于回填到达时刻的 readiness 预期明确为“当时未知”，不能把它回填成已知。
3. **固定相同的父发布和最终事实。** A/B 基线输入、模型/配置、时区、父 release、最终 XML 修订和评估时刻相同。修订仍覆盖 day 5/day 50 两个不相邻时期，并核对旧新夜变化、中间 canonical 行、批次与代次。A 执行原任务的实际 partial 计划；B 是同父发布上的完整计算对照。B 如需取消其导入时登记的任务，应走仓库现有任务取消/覆盖接口或明确隔离的对照构建流程，不能用裸 `DELETE` 破坏任务历史并把它描述成生产调度路径。
4. **核对实际消费而非仅核对登记。** A 执行后读取原任务（或正式覆盖任务）的状态、执行计划、覆盖记录、input binding、`training_metric_runs` 复用证明、`model_release_bundles`、`active_model_run` 与可读状态。断言 `reuse.proof=verified` 且安全前缀 `reused>0`；原任务必须得到持久成功/覆盖发布结论，不能留下未消费的 queued 行或由另一条无关联任务替它发布。
5. **保持业务比较器严格。** A/B 的 readiness 更正后真实变化且逐字段相等；Fitness 指标与解释不因睡眠/HRV 修订改变；中间 canonical/逐日 readiness 在其明确的 as-of 语义下不变；15 张业务表/投影、bundle、`evaluation_json`、active 指针、freshness 与 binding 零未解释差分。只归一化预先列明的随机 ID/执行身份；`computed_at`、`availableAt`、`import_completed_at`、依赖代次和业务 lineage 不得为通过比较而从库中改写或事后从比较结果里抹掉。增加一个“改变到达时间或任务绑定会使验收失败”的负对照。
6. **成本受限时拆成两条诚实证据。** 如 70 天分日导入使完整套件预算不可接受，可保留现有受控 A/B 作为“应用层/历史状态等价”，另加一条较小、真实到达时间且 A 原任务被消费的 XML→发布闭环；矩阵和报告明确说明两条证据的组合范围，不再称单条 T12 测试已证明完整生产调度。不能为了速度恢复直接改 canonical 行或删 A 原任务。

### 2.3 验收条件

| 验收项 | 必须观察到 |
|---|---|
| 接收与绑定 | 两库真实 v2 XML 导入；A 回执 `analysisJobId` 指向原 `recompute_jobs.id`；batch/代次/脏证据一致 |
| 调度与发布 | A 原 ID 由真实消费者领取并成功，或有正式 `analysis_job_merges` 覆盖并发布；最终 release/bundle/active 指针可追到该批 |
| 时间语义 | 测试没有对 `canonical_nights`、`canonical_hrv_days`、`import_completed_at` 做导入后直改；所有被认为可用的样本满足 `observedAt <= availableAt <= asOf`，A/B 用同一可解释时钟 |
| 局部重建 | 两个不相邻修订时期的旧新夜发生预期变化；未触及中间 canonical 行逐字段不变 |
| 增量有效性 | A 持久实际计划为 partial、覆盖边界不晚于最早脏时刻，复用证明有效且 `reused>0`；不可证明时退化全量并如实记录，不能假称 partial |
| A/B 结果 | readiness 修订后变化且 A=B；Fitness 业务指标/解释与修订前及 B 相等；15 表/投影、发布和可读状态零未解释差分 |
| 负对照 | 故意篡改到达时间、任务绑定或 active 指针时，比较/门禁确实失败；测试结束无无主 queued 任务 |

**问题二完成条件：**一条主路径直接把真实导入登记的 A 任务运行到可读发布，或采用上述“两条诚实证据”并同步收窄报告结论。`phase3-t12-real-lane.test.ts` 的注释、测试矩阵与阶段报告必须与实际执行路径一致。日志应给出原 job ID、实际执行/覆盖 ID、evaluatedAt、到达时间区间、计划边界、复用计数、release ID 和差分数量。

## 3. 统一回归与证据更新

实施代码后按 `/Users/ta/running/AGENTS.md` 执行适用门禁，并记录 Node/npm 版本、macOS 主机、`RAI_TEST_CONCURRENCY`、完整命令、退出码、跳过项及日志路径：

1. `npm run typecheck`；相关删库/恢复/epoch/作用域与 T12 目标套件。
2. `RAI_TEST_CONCURRENCY=2 npm test`；不得只用目标用例通过代替全量回归。
3. 测试或 `docs/ALGORITHM.md` 改动时运行 `npm run check:acceptance-matrix`；`docs/`、README 或 AGENTS 改动时运行 `npm run check:docs`。
4. 服务启动或维护路径改动时运行 `npm run smoke:api`；若 npm script 变化，运行 `npm run check:scripts`。跨平台 npm 命令保持 Windows/macOS 同形；需要 Xcode 的 iOS 验收仍单列，不计入本轮 API 修复通过数。
5. 更新 `TEST_MATRIX.md`、`DEPENDENCY_MATRIX.md`、`PHASE3_REPORT.md` 与 `evidence/manifest.json`。证据清单列出文件哈希及日志，`notExecuted` 明确记录生产导入/故障注入未跑的部分。只有在两项完成条件及适用门禁均满足后，才把相关结论改为无保留通过。

本文档不授权直接删库、恢复真实健康数据、部署或生产故障注入。
