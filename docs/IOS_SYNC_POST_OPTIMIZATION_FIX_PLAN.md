# iOS 同步优化后复查：七项问题修复实施方案

- 日期：2026-10-16，Asia/Shanghai（2026-10-17 追加 R06 裁剪物化实施记录）。
- 文档编制基线：`c986309`。
- 来源：上一轮对优化结果的源码复查、隔离合成夹具与本机微基准。
- 状态：**全部工作包已实施（2026-10-16 晚 + 2026-10-17）。** F00／F10／F11／F12／F30（服务端侧
  R01/R02/R05）与 F20／F21／F22（iOS 侧 R03/R04/R07）已落地并验证（含突变验证）；
  F31（R06）**三部分全部落地**：有界探针 + 快照索引 + **裁剪物化**（2026-10-17）——
  输入捕获只物化必要行（明细按 545 天回看窗、路线点按被算会话），越界由覆盖守卫显式
  失败并**关闭裁剪重捕获一次**（见 §0 的 F31 行与 §4-R06 的实施记录）。
- ~~本次交付：仅新增本文档及 README 入口，不修改业务代码、不执行同步或数据迁移。~~
  （编制轮的限制；实施轮见下方"实施进度"。）
- 前序：[初次审查与优化方案](IOS_SYNC_PERFORMANCE_REVIEW.md)、
  [上一轮实施记录](../deliverables/SYNC_OPTIMIZATION_EXECUTION_PLAN_2026-10-16.md)。

## 0. 实施进度（2026-10-16 晚）

| 工作包 | 状态 | 落地与证据 |
|---|---|---|
| F00 复现夹具 | ✅ | 新增 `packages/application/test/analysis-coverage-merge.test.ts`：修复前 **3/3 精确失败**（断言值 = 缺陷行为），修复后 4/4 绿 |
| F10 覆盖计划 | ✅ | `SqliteAnalysisInputReader.capture` 改为「可信基线（active release 输入绑定）起算 ∪ 原任务计划」；合并实现单点 `mergeDirtyPlans`（`health-export-parser/dirty-range.ts`）；无可信基线时"未覆盖影响批次"检查拒绝 partial（`coverage_unverifiable`） |
| F11 R01 | ✅ | `replanAfterInputDrift` 不再清空原计划（registry 计划并入，逐域取最早）；边界只保持/向前扩大 |
| F12 R02 | ✅ | 合并任务保留成员稳定语义字段；`analysis_job_coverage` 改由**执行方**在发布事务写（`capture.mergedBatchIds`）；结算只核验不写表，并新增 `publication_missing_union_batch`、`executed_plan_evidence_invalid`、`executed_*_range_later_than_covered` 判据；v44 迁移新增 `analysis_run_input_bindings.executed_plan_json` |
| F30 R05 | ✅ | 复用判据拆成「前缀兼容摘要（不含代次，`prefix_compat_digest`）+ 覆盖基线存在」；直连增量复用有可核对行数（T09 夹具）；旧 checkpoint 缺新摘要拒绝（`prefix_compat_missing`） |
| F20 R03 | ✅ | `RouteFetch` 四态判别（`.observation`/`.unreadable`/`.budgetDeferred`/`.oversized`）替代 `!budgetExhausted` 近似；**读取失败不进完成候选**（保留待办）；`upsertRouteStates(removePendingTodos:)` 把状态落盘与待办移除并成**一个本地短事务**；`SyncTaskState.completedRouteTodos` 跨进程透传（缺键 = 不移除）；Swift 回归 +19 检查（110 checks） |
| F21 R04 | ✅ | `RouteBatchFileList` 跨页按相对路径去重（后页版本原子替换引用）；**页级 staging 目录**（拒绝页/缩页重试物理隔离，滚动回滚不触碰已接受文件）；打包前自校验（路径唯一 + 文件存在，`duplicateArtifactPath`/`missingArtifact`）；`StoredZip.write` 重复路径**失败关闭**（`duplicateEntry`）；行为测试 4 条 |
| F22 R07 | ✅ | 原因归类修正（`routeBudget` vs `routeOversized`，满额判据含多段合计）；`PendingRouteTodo` 调度字段（`sched_state`/`attempt_count`/`last_attempt_at`/`next_retry_at`/`blocked_budget_fingerprint`，表列幂等补齐、旧行一律映射 ready）；`RouteTodoScheduler`（有界退避 ≤12h、可执行上限 20 + 最老优先、`blocked-size` 只在**能力提高**时重开）；导出层只把可执行子集送进发现/查询并按结局记账 |
| F31 R06 | ✅ | **三部分全部落地**。①有界探针（行超限后不再做任何 `SUM(LENGTH)`，如实标记下界）；②物化快照重放源库索引（区间查询不再 SCAN）+ 被裁表按 `ORDER BY rowid` 复制（行序与全量一致）；③**裁剪物化（2026-10-17）**：`factPruneFor` 从**覆盖计划**推导边界（逐域最早 − 545 天；路线点按被算会话，边界再早一天吸收时区偏移），表级谓词单点 `buildFactTableFilters`（白名单类型全史 + 明细按窗 + 被算会话的路线点），探针与物化**共用同一份谓词**；pipeline 侧三处**覆盖守卫**（`assertFactCoverage`：特征装配 / 分区日链 / 负荷）在越界时显式失败 ⇒ `runDirectSyncAnalysis` **关闭裁剪重捕获一次**（事件留痕 `fallback:"fact_pruning_disabled"`）；全局最早证据改由捕获值提供（照读被裁快照的 `MIN` 会静默换答案）。证据：单元 6 条 + 端到端 4 条（含"裁剪开/关发布产物逐位一致"与"历史 ×10 行数不 ×10"），T11 的**行数判据**达标；⚠️ p95 时延目标（§6.3 第 5 条）**未测**，仍不得宣称 |

**本批回归数字（2026-10-16 晚，本机）**：
- TypeScript 侧：`typecheck` 全绿；`application` **253/253** 绿；
  `storage-sqlite` 192 项 190 绿（1 条 `connection-contention` 时序失败 + 1 条 PID-reuse skip
  ——失败已在干净 worktree（`c986309`）逐字节复现为**预存在**）；`health-export-parser`+`contracts`
  203 项 202 绿（1 条 Rust 等价性 `import_entity_changes` 失败，同样以干净树复现为预存在）；
  `apps/api` 同步/分析链路 51/51 绿；`check:scripts`、`check:package-boundaries`、`check:docs` 绿；
  三份设计文档（PR2_PR3/PR4/PR5）的行号引用按**语义重定位**到当前工作树（138 处 / 0 越界 / 0 空行锚）。
- iOS 侧：`typecheck-ios` 94 文件通过；`npm run test:ios`（gates）**EXIT=0** ——
  `check-healthkit-record-sync` **71/0**、`check-background-capabilities` **289/0**、
  export determinism 14/0、direct-sync 合同/文案/对账门禁全过；Swift 纯逻辑回归全绿
  （route 落盘 **110 checks**、budget 91 checks、cancellation regression 含 ZIP 重复路径失败关闭）。
- 突变验证：R05 注回旧 `input_binding_digest` 全比对 ⇒ T09 转红（已回退）；
  R07 两条（删第四条件的调度通道 / 删闸门 `shouldQuery` 调用）逐条手工突变到红：
  应用 ⇒ 对应断言红（`the loop must consume the todo scheduler` /
  `the route query happens BEFORE the state machine is consulted`，前者即被改坏的那条判据、
  后者是与"必须咨询"同一设计约束的顺序半边）⇒ 逐字节回退。
  iOS 裁剪突变矩阵（`RAI_MUTATION_FOR=git`）有一次**中途被并发编辑污染并主动中止**的记录：
  不可信，不作为证据（教训：跑突变矩阵期间不得对同一批源文件做编辑——哪怕短暂）。
- 未测项不写"通过"：真机端到端与目标服务器性能分段仍是未测状态。
- F31 裁剪物化**已实施（2026-10-17）**，见下方 2026-10-17 追加的回归数字与 §4-R06 实施记录；
  T11 的**行数判据**达标，**捕获 p95 时延**仍未测（§6.3 第 5 条），两者不得混为一谈。

**本批追加回归数字（2026-10-17，R06 裁剪物化，本机）**：
- TypeScript 侧：`typecheck` 全绿；`analysis-input-pruning` **4/4**、`analysis-input-materialization`
  **15/15**、`analysis-input-pinning` **6/6** 绿。
- 按包分组门禁（本机 load 4–13，逐批独占）：`packages/application` 五批合计 **278/278** 绿；
  `apps/api` 分析／直连链路 **61/61** 绿（analysis-failure-isolation + analysis-job-merge +
  direct-sync-analysis-reconcile/registration/plan + recompute-worker **28**；direct-sync-ingest **19**；
  handshake-capability + prohibited-operations + import-worker-direct-sync **14**）。
- 文档门禁：`check:docs` 69 文件 / 513 链接 / 0 问题；`check:doc-refs` 138 处 / 0 越界 / 0 空行锚
  （⚠️ 漂移检测在**无 `.linerefs.json` 基线**时是真空的 —— 本次不拿"0 漂移"当证据，
  而是回源码核了受本次行号移动影响的唯一引用：PR4 设计文档的 `process.send` 阶段耗时
  从 `recompute-pipeline.ts:3998` 重定位到 `:4173`）。
- ⚠️ **未取得全量 `npm test` 的 `EXIT=0`**：本机被外部常驻进程压到 load 11–202，
  `RAI_TEST_CONCURRENCY=1 npm test` 跑到 169 条后 **23 分钟无输出**，按"高负载下全量会伪造失败"
  的既有纪律**主动中止**（日志 `.workbuddy/runlogs/full-r06c-node.log`，退出码 143 = 我发的 SIGTERM）；
  `apps/api/test/direct-sync-http-acceptance.test.ts`（既有重文件：每例真子进程 24–34 s）两次被沙箱
  掐断在 6/… 条（掐断前 0 失败），同样如实记录，两项都**不得**写成"通过"。
- 实测（合成夹具，本机，无真实健康数据）：30 场 2022 老历史 + 1 场 2025 晚场的一次增量直连
  运行（复用 `verified`），捕获 **213 行** vs 关闭裁剪 **815 行**；两次基线全量分别 783／873 行。
  T11 判据（历史 ×10 ⇒ 捕获行数不近似 ×10）成立，且对照侧断言必须 ≥8 倍增长（防止夹具不长大）。
- 突变验证（逐条手工突变到红 ⇒ `Edit` 反向回退）：①覆盖守卫失效 ⇒ 守卫用例红（回退事件缺失）；
  ②全局最早改回照读被裁快照 ⇒ 全局最早证据用例红（产物字段从 `false` 翻成 `true`）；
  ③裁剪整体禁用 ⇒ 6 条红（单元/等价/T11/守卫/全局最早）；④裁剪窗缩到 365 天 ⇒ 3 条红
  （边界字面值 + 合法路径"不得有多余捕获"）。回退后三份文件复跑全绿（4/4、15/15、6/6）。

---

## 1. 目标和硬约束

本轮不是再次重做 O01–O12，而是修复优化后复查发现的七项残留／新增问题：
先保证不漏算、不漏同步，再消除生产增量路径中的无效复用和全历史读取。

### 1.1 明确禁止

1. 不执行全量同步，不重置 anchor，不通过“重新导入全部”修复问题。
2. 不创建业务数据库备份、候选主库副本，不复制真实数据库做测试，不通过文件换库发布分析。
3. 不把整段历史事实复制到内存作为普通增量计算的默认前置步骤。
4. 不关闭事务或持久化保护，不放宽 ZIP 重复路径检查，不删掉发布前版本、配置和 override 校验。
5. 不重写评分公式、不把 TypeScript 评分核心移到 iOS，不改变缺失值及时间语义。
6. 不修改冻结的窄屏 Web 区域，不扩展未经授权的后台机制。

允许保留断点续传所需的小批暂存、游标、UUID 待办、覆盖证明和持久回执。
它们不构成整库备份；已确认批次的临时产物仍按既有生命周期清理。
必要的服务端派生结果重建与“重新同步全部健康数据”是两件事，不能相互替代。

### 1.2 必须保留

- [ADR-004](adr/ADR-004-healthkit-sync-invariants.md) 的提交前回读、产物清理顺序、配额及批次身份不变式。
- 事实、变更账本、必要分析任务与回执同事务提交。
- `preserveAbsent: true`；没有明确删除证据，不以缺席推断删除。
- `committed` 只表示原始事实已保存，不能冒充分析已经发布。
- 失败时继续保留可读的旧发布及明确的新鲜度状态，不把旧分数标成最新。
- 已确认原始批次不得因分析失败而要求手机重新导出、重新上传。

## 2. 问题、证据与交付优先级

以下数字均来自上一轮**合成数据／本机**复查，不是真实健康记录，也不是真机端到端结果。

| 编号 | 级别 | 问题 | 复查证据 |
|---|---|---|---|
| R01 | P1 | 输入漂移重排丢掉原任务尚未发布的脏范围 | 2026-09-13 的更正应得到平均心率 148.6；重排发布后仍为 145 |
| R02 | P1 | 合并部分任务，实际却标记覆盖全库最新代次 | 未合并批次的训练应为 147.67，发布仍为 144，却绑定到第 4 代 |
| R03 | P1 | 路线读取失败仍可能从待办队列移除 | `observation == nil` 的失败结果进入完成分支；源码确认 |
| R04 | P1 | 近期附件与正式查询页重复输出同一 GPX 路径 | 分页合并最小夹具＋生产 ZIP 写入器产生重复路径，实际接收器拒收 |
| R05 | P2 | 生产增量的负荷／分区前缀复用被代次摘要恒定拒绝 | 一条心率更正仍重算 7 次训练、46 天分区和日指标，原因 `input_binding` |
| R06 | P2 | 输入捕获复制全部历史事实，内存快照还丢失查询索引 | 同一近期脏范围：1 万条捕获约 253ms，10 万条约 2,242ms；快照查询为 `SCAN` |
| R07 | P2 | 超大路线没有真正的跨轮阻塞／退避 | 原因字段未参与调度，续批继续读取同一不可装入路线；源码确认 |

复查已确认有效的改进包括普通训练内心率更正的回退修复，以及写许可交接提速。
租约微基准 30 轮、每轮 200 空窗口：p50 为 **95ms**、p95 为 **152ms**，
本次满足原脚本的 p50 小于 100ms 门槛，不能再照抄旧记录称其未达成。
但这不证明端到端同步和计算已达标。

## 3. 共用基础：先修“实际覆盖范围”，不能只修表面边界

R01 和 R02 共享根因：**“读到了当前事实”不等于“从旧发布到当前的全部变更都已重新计算”。**
二者必须通过同一个计划器处理，不能分别在重排和合并函数中各写一套 `MIN(dirty)`。

### 3.1 建议增加的执行计划

以下为拟新增结构示意，不是当前可调用 API：

```ts
interface AnalysisCoveragePlan {
  contractVersion: 1;
  baseReleaseId: string | null;
  baseRawGeneration: number | null;
  baseDependencyGeneration: number | null;
  capturedRawGeneration: number;
  capturedDependencyGeneration: number;
  scheduledJobIds: string[];  // 本轮调度／合并的任务
  requiredBatchIds: string[]; // 本次输入中尚未被旧发布证明覆盖的事实批次
  executedBatchIds: string[]; // 实际执行计划覆盖的批次
  boundaries: {
    features: string | null;
    fitness: string | null;
    readiness: string | null;
  };
  evaluatedAt: string;
  configDigest: string;
  overrideDigest: string;
  proofDigest: string;
}
```

必须区分：

- **调度成员**：受成员数、时间跨度、配置兼容及防饿死规则限制。
- **事实覆盖范围**：由实际输入版本与当前已发布版本之间的未覆盖变更决定。
- **请求目标代次**：原任务登记时的承诺，不得随意改写成计算证据。
- **捕获代次**：实际读取的版本，不能为了让测试通过而改写成成员最大代次。

`boundaries` 沿用现有“null 不允许安全前缀复用”的保守含义。
若未来需表达“该域完全不受影响”，使用版本化的显式状态，不能悄悄复用 null 的另一种解释。

### 3.2 覆盖计划生成算法

1. 在一个短只读事务内读取当前 active release 的实际输入绑定、当前代次、
   配置／override／设置修订、请求截止点以及相关账本。
2. 有可信旧发布绑定时，从旧发布的捕获 raw 代次之后，读取到本次捕获 raw 代次为止的
   **全部未覆盖事实批次**，不按 job 是否 queued／failed 过滤。
3. 将这些批次与原任务、历次重排尚未发布的范围取并集；逐域取最早影响边界。
4. 来源包括记录和训练的新旧区间、显式删除、路线变更及 canonical 恢复事实变化。
   不允许因路线不在 `import_entity_changes` 的既有枚举中而把路线-only 变更当作不存在。
5. 现有账本不足以重建的证据，优先追加每批最小 dirty 元数据：
   版本、逐域边界、原因及必要的实体引用；与事实和回执同事务写入。
   这些是覆盖证据，不保存另一份原始健康样本。
6. 历史元数据缺失表示未知，不补零、不伪造覆盖；不能沿用未经证明的前缀。
   旧发布无绑定时走显式兼容路径，必要时分段重建已入库事实的派生结果，不重新同步数据。
7. CPU 和候选落地只消费这份执行计划。发布前校验其摘要、实际执行范围、
   前缀复用证明及当前依赖／控制修订。
8. 只有计划完整覆盖当前所需依赖范围时才能标为最新；否则保留旧发布和待更新状态。

覆盖硬条件：

```text
执行所需变更 = 旧发布之后未覆盖的变更 ∪ 原任务未发布范围 ∪ 后续新增变更
实际执行范围必须包含执行所需变更
新鲜度只能来自当前 active release 的实际覆盖证明
```

## 4. 七项修复的具体实施方法

### R01：重排保留原任务及所有未发布范围

**主要文件**

- [analysis-input-reader.ts](../packages/application/src/services/analysis-input-reader.ts)
- [recompute-pipeline.ts](../packages/application/src/services/recompute-pipeline.ts)
- [recompute-job-repository.ts](../packages/storage-sqlite/src/recompute-job-repository.ts)
- [analysis-input-pinning.test.ts](../packages/application/test/analysis-input-pinning.test.ts)

**实施步骤**

1. 将 `replanAfterInputDrift` 中“丢掉原计划，只读取漂移后批次”的做法，
   替换为第 3 节的覆盖计划生成。
2. 对每个域分别合并边界；任一输入明确不允许复用时，该域不能被较晚的新边界覆盖。
3. 把原任务的 `importBatchIds`、删除和来源更正证据并入执行证据，不能只保留一条代表批次。
4. 重排只重新规划必要元数据，不先复制全部事实到内存再丢弃。
5. 优先将原任务安全退回 queued，保留原 `analysisJobId` 供客户端继续查询。
   原登记请求与目标代次保留原始含义，实际执行计划单独保存。
6. 若采用新后继任务，必须同事务建立原任务到后继任务的持久关联；
   原 id 的查询要能沿关联返回进度，不能永久停在失败而后继已成功。
7. 失败候选置为失败且不激活；配置、override、incumbent 或依赖变化导致的发布拒绝，
   与读取期间漂移一样进入明确的重排策略，不能漏掉物化模式的发布拒绝路径。
8. 重排次数和等待均有上限；到顶后保留明确错误及旧发布，不无限自旋，不要求手机重传。
   历史固定 `asOf` 请求不能被改成“计算到现在”。

**验收**

- 原变更 A 早于新变更 B，A 在发布前漂移：后继结果必须同时包含 A 和 B。
- 2026-09-13 合成更正后的平均心率为 148.6，不再复用为 145。
- 物化、分段两种路径均测试；连续两次漂移后边界只能保持或向前扩大，不能后移。
- 原始回执仍为 committed，原任务 id 可查询真实进度；没有额外手机导出／上传。

### R02：调度合并与事实覆盖分离

**主要文件**

- [recompute-job-repository.ts](../packages/storage-sqlite/src/recompute-job-repository.ts)
- [analysis-input-reader.ts](../packages/application/src/services/analysis-input-reader.ts)
- [analysis-input-coverage.ts](../packages/contracts/src/analysis-input-coverage.ts)
- [model-release-repository.ts](../packages/storage-sqlite/src/model-release-repository.ts)
- [fact-read-view.ts](../packages/storage-sqlite/src/read/fact-read-view.ts)
- [analysis-job-merge.test.ts](../apps/api/test/analysis-job-merge.test.ts)

**实施步骤**

1. `planCoveringJob` 继续用成员数、跨度和兼容键选调度成员；
   但不再仅对成员求 dirty 后，直接宣称覆盖全库最新代次。
2. 实际捕获当前事实时，必须调用第 3 节计划器，将未入选但已影响当前输入的批次纳入计算范围。
   若不能证明完整覆盖，拒绝发布为最新，而不是伪造较小捕获代次。
3. 合并任务保留成员共同的稳定语义字段，包括 feature／model 配置和时区，
   不得重建请求时丢掉这些字段而使用默认配置。
4. `analysis_job_coverage` 只记录执行计划确实覆盖的批次。
   禁止在结算时先把调度成员写入覆盖表，再把该表当作“已经计算”的证明。
5. 成员结算必须验证实际 binding、逐域边界、配置／override 一致性和批次覆盖。
   未覆盖、取消、失败或配置不兼容的成员不能被置为 succeeded。
6. 新鲜度只依据当前 active release 的真实执行证明；
   queued job 的最大目标代次、历史成功 job 的最大代次都不能替代它。
7. 保留防饿死机制；修复不得通过取消成员／时间上限来规避复现。

**验收**

- 3 个批次中第三个因时间窗未入选，且影响日期最早：必须计算其影响或保持 stale。
- 33 个批次、成员上限为 32 时，第 33 个的早期更正不能被漏掉。
- “结果仍为 144，却发布到第 4 代”的夹具必须转为正确值约 147.67，或明确拒绝发布。
- 同配置可合并，不同配置不误结算；原任务／回执 id 保持可查询。

### R03：路线失败与真正完成分开，原子结算待办

**主要文件**

- [HealthKitExport.swift](../apps/ios/RAI/HealthKitExport.swift)
- [HealthKitSync.swift](../apps/ios/RAI/HealthKitSync.swift)
- [SyncTaskStore.swift](../apps/ios/RAI/SyncTaskStore.swift)
- [SyncTaskState.swift](../apps/ios/RAI/SyncTaskState.swift)
- [RouteSyncStatePersistenceRegression.swift](../apps/ios/tests/RouteSyncStatePersistenceRegression.swift)

**实施步骤**

1. 将路线结果改成明确的可判别状态，例如完整观测、暂不可读、预算延后、超大阻塞；
   不再仅用 `budgetExhausted == false` 判断成功。
2. `observation == nil`、授权错误、部分分段失败及文件写出异常均不能加入完成待办。
   完整、有效的零点观测与读取失败仍是不同状态。
3. 有路线文件时，只有实际进入本批 XML 引用和唯一文件清单的路线才成为交付候选。
4. 服务端确认批次前保留待办；若服务端明确延后该路线，应继续保留。
   不能把“读取完成”“原始批次接收”“路线实际可读”三个结论合并成一个布尔。
5. 需要跨进程恢复的结算候选写入任务可选字段，并接入显式 `init(from:)`。
   老任务缺字段表示没有完成证明，安全方向是保留待办。
6. 原始批次提交成功后，再用一个本地短事务执行“路线状态落盘＋待办移除”。
   状态落盘失败则不移除；不能先记录 warning，再继续把唯一待办删掉。
7. 结算失败不否认已保存的原始事实；待办残留可重试，但必须有后续调度入口。

**验收**

- 无状态行的历史 UUID 遇到权限／部分读取失败，重启后仍可查询和续查。
- 完整有点、完整零点、失败无观测分别测试；失败分支不能执行待办删除。
- 注入路线状态写入失败，待办仍在；重复成功结算幂等。
- 成功后退出／恢复不遗漏收尾；不能只测纯函数，必须覆盖真实 SQLite 和生产接线。

### R04：批次级去重，防止重复 GPX 与文件覆盖

**主要文件**

- [HealthKitExport.swift](../apps/ios/RAI/HealthKitExport.swift)
- [StoredZip.swift](../apps/ios/RAI/StoredZip.swift)
- [import-sources.ts](../apps/api/src/import-sources.ts)
- [HealthSyncArchiveRegression.swift](../apps/ios/tests/HealthSyncArchiveRegression.swift)

**实施步骤**

1. 将正式 anchored 页与近期／待办附件分为独立工作流，不再把全部附件永久并进第一页重试。
   两条工作流共用批次级训练及路线清单；附件也有有界预算和公平处理机会。
2. 按规范化训练 UUID、路线相对路径维护本批唯一身份，跨页去重而不只是页内字典去重。
3. 正式流后续出现已经作为附件处理的训练时，仍消费该查询页和删除事件；
   不因去重跳过真实更正，也不重复加入相同 GPX 路径。
4. 同 UUID 出现不同内容时，采用确定的权威顺序／内容版本规则更新暂存对象，
   原子替换对应 XML 与路线引用，不能“遇到重复就丢弃后者”。
5. 拒绝页和缩页重试使用独立临时目录；页接受后才合并批次清单。
   失败页不能覆写或删除已经接受页引用的文件。
6. 打包前验证路径集合唯一、XML 引用可解析、manifest 与文件清单一致。
   `StoredZip.write` 也增加重复路径的失败关闭检查，作为最后一道防线，不负责静默去重。
7. 服务端“ZIP 包含重复路径”的检查保留，不能通过放宽接收规则来修客户端。

**验收**

- 第一页附件含近期训练，第二页正式流再次返回它：ZIP 内每个 GPX 只能出现一次。
- 执行真实 ZIP 写入及服务端上传／解压验证，而不只是断言数组去重。
- 缩页重试、同 UUID 内容变化、删除与新增混合时，anchor 仍只推进已交付页。
- 完整批次上传成功；若本地发现冲突，必须在上传之前报错且保留可恢复状态。

### R05：分离输入身份与前缀兼容性

**主要文件**

- [recompute-pipeline.ts](../packages/application/src/services/recompute-pipeline.ts)
- [analysis-input-binding.ts](../packages/application/src/analysis-input-binding.ts)
- [training-metric-domain-reuse.test.ts](../packages/application/test/training-metric-domain-reuse.test.ts)

**实施步骤**

1. 拆开两种摘要：
   - 输入身份摘要：保留实际 raw／dependency 代次、截止点等，用于谱系、固定输入和发布核验。
   - 前缀兼容摘要：只包含算法／checkpoint 版本、配置、时区、来源策略及有关控制修订。
2. `metricInputBindingDigest` 不再要求父子 raw／dependency 代次逐字相等。
   不能全局删除输入绑定；改变的是前缀复用判据，不是发布安全判据。
3. 以 R01／R02 的覆盖计划证明“父发布到当前之间，复用边界之前没有未处理影响”；
   再检查 checkpoint 状态、外键映射、来源证据及前缀完整性。
4. 新旧证明使用不同版本，旧 checkpoint 缺少必要证明时拒绝复用，不按默认零状态续算。
5. 为通过证明的前缀执行集合复用，只计算后缀；复用计数与真实落库行数一致。
6. 测试必须使用 `SqliteAnalysisInputReader` 和真实直连导入，
   不能只用无输入绑定的 CLI 路径证明生产复用有效。

**验收**

- 连续两次真实增量批次代次不同，但安全前缀的 loads／zones／daily 复用数量均大于零。
- 一条末次训练心率更正不再导致 7 次训练、46 天结果全部重算。
- 与同输入、配置、截止点的离线参考数值一致。
- 修改配置、override、早期原始记录或 checkpoint 状态时，仍能拒绝不安全复用。

### R06：必要输入有界读取，不能默认复制全部历史

**主要文件**

- [analysis-input-reader.ts](../packages/application/src/services/analysis-input-reader.ts)
- [analysis-fact-view.ts](../packages/application/src/services/analysis-fact-view.ts)
- [recompute-pipeline.ts](../packages/application/src/services/recompute-pipeline.ts)
- [model-v2-snapshots.ts](../packages/application/src/model-v2-snapshots.ts)
- [analysis-input-materialization.test.ts](../packages/application/test/analysis-input-materialization.test.ts)

**实施步骤**

1. 先根据覆盖计划、兼容 checkpoint、计算后缀和算法回看窗口生成 `AnalysisReadPlan`；
   分别列出训练、记录类型／区间、路线 ID 和小型控制数据。
2. 将通用事实 SQL 逐步收敛为带读取意图的接口，例如训练输入、恢复区间、路线质量和聚合证据。
   每个接口校验请求没有越过捕获范围，越界必须显式失败或重新规划，不能默默返回空。
3. 只装配实际重算训练的心率／速度，及其所需的恢复、分区和滚动历史证据。
   90／180 天等窗口按真实算法依赖处理；累积状态从 checkpoint 恢复，不按任意固定天数截尾。
4. 全局 `MIN`／`MAX` 等语义使用原库索引聚合或同快照下的小型证据，
   不能把事实表截到近期后继续执行原来的全局查询，否则结果会静默改变。
5. 如保留内存 SQLite，仅写本次必要行、小型聚合和控制数据；
   按查询计划建立必要的类型／来源＋时间索引，不复制所有旧 run 或无关路线点。
   必要路线点按选中路线读取，能用聚合时不物化全部点。
6. 预算探针先按有界读取计划计数，达到上限立即停止；禁止为了判断“是否超限”
   又对全部历史做 `SUM(LENGTH(...))`。
   字节按实际 UTF-8／载荷开销估算并留余量，不能把字符串字符数当作内存硬上界。
7. 超预算改为 keyset 分页／阶段输入块，不使用无界 `all()` 后仅记 warning 的伪限制。
   各块在短读事务内校验完整 binding，包括依赖、incumbent 及控制修订；漂移走 R01。
8. 读事务不跨长 CPU 阶段；超预算或漂移不能无校验地拼接“下一段最新数据”。
9. 临时兼容路径如仍需广范围读取，显式标记原因和成本，不能计入增量性能达标。

**验收**

- 相同近期变更、相同有效 checkpoint，1 万／10 万／更大合成历史对照；
   捕获的原始行数应随所需窗口增长，而不是随全历史近似线性增长。
- 区间查询 `EXPLAIN QUERY PLAN` 使用预期索引，不再在快照中 `SCAN health_records`。
- 保留全局证据、跨夜和 as-of 对照；不得以少读数据换取看似更快的错误结果。
- 记录输入捕获、SQL、CPU、峰值内存及事务持有时长，禁止只报告总耗时。

**实施记录（2026-10-17）——裁剪物化**

*读面分类（先审计后动手）*：事实读取面逐口核对（`recompute-pipeline` / `prediction-data` /
`model-v2-snapshots` / `readiness-replay-coverage` 四份消费文件对 `health_records` 的类型引用），
结论是**只有四类记录被读**：静息心率与 `VO2Max`（证据链"任意 asOf 可重算"，必须**全史**保留）、
心率与跑速明细（只被"训练窗 ∪ 回看窗"读取）。其余类型（体成分等）整类不进快照。
`analysis-input-pruning.test.ts` 有源码级判据把这份清单钉死：消费文件里出现任何新的类型引用，
都必须先落到 `FACT_PRUNE_ALWAYS_KEPT_RECORD_TYPES` / `FACT_PRUNE_WINDOWED_RECORD_TYPES`
（或那张带理由的"不读 health_records"免检表）里，否则测试红。

*边界推导（单点实现）*：`factPruneFor`（输入读取器）从**覆盖计划**取值 —— `recordsFrom` =
逐域最早边界 − **545 天**（乳酸阈值证据链：`evaluatedAt − 365d` 的会话 × 每场再回看 180 天的
最大心率），`routeFrom` = 边界**再早一天**（路线读取的驱动量是"会话所属本地日"，与过滤列
`workout.start_at` 之间隔着时区偏移，一天余量吸收它）。边界取 `min` 的前提是它来自覆盖计划：
拿登记计划当边界会**偏晚**，那正是"读了错误版本还不自知"的入口 —— 所以捕获里物化必须排在
计划计算**之后**。

*守卫与回退（越界绝不静默少读）*：pipeline 四个阶段级守卫点各自用**该阶段真实的最大回看窗**
比较"需要的最早时刻"：特征装配（最早会话 − 180 天）与会话路线点（会话起点）、证据链
（`evaluatedAt − 545 天`）、分区日链（`localDateStartAt(fromDate) − 365 天`，`comparableEvidence`）、
负荷（实际会被算的会话里最早的起点）。越界 ⇒ `AnalysisInputCoverageOutOfBoundsError` ⇒
`runDirectSyncAnalysis` **关闭裁剪重捕获一次**（事件 `fallback:"fact_pruning_disabled"` 记录
`kind/requiredFrom/coverageFrom/context`），绝不循环、不走漂移重排。
⚠️ 实测（合成夹具）证明确有必要：一次"复用被拒 ⇒ 分区日链从头算"的运行确实在守卫处越界，
没有守卫时它会对着被裁快照静默少读 2022 年 1 月起的峰值证据（需要的最早时刻 2021-01-03）。

*两个容易漏掉的一致性点*：①全局最早证据（`sourceBackfillEvidence` 与发布 gate）在裁剪后**不能**
照读快照的 `MIN(start_at)`（那是"被裁集合的最小值"），必须用捕获读事务里算出的值 ——
`analysis-input-pruning.test.ts` 用一个"本批插入了一条比既有行更早的明细"的夹具把两种实现分开
（照读快照会让产物字段从 `false` 翻成 `true`）；②被裁表的复制必须 `ORDER BY rowid`，
快照内的行序要与全量复制一致（同刻并列的 tie-break 依赖它）。

*证明先于写入*：`reuseFeaturePrefix` 拆成 `featurePrefixPlan`（只读决策）+ `copyFeaturePrefix`
（写入），覆盖守卫落在两者之间 —— 否则越界回退时前缀行已经拷进 `workout_features`，
库里会多出一份挂在废弃 feature run 下的孤儿行。

### R07：超大路线持久阻塞、可恢复退避，不无限续批

**主要文件**

- [RouteSyncState.swift](../apps/ios/RAI/RouteSyncState.swift)
- [SyncTaskStore.swift](../apps/ios/RAI/SyncTaskStore.swift)
- [HealthKitExport.swift](../apps/ios/RAI/HealthKitExport.swift)
- [HealthKitSync.swift](../apps/ios/RAI/HealthKitSync.swift)
- [BackgroundSyncPolicy.swift](../apps/ios/RAI/BackgroundSyncPolicy.swift)

**实施步骤**

1. 先修原因归类：余额不足写 `routeBudget`，确实超过满额才写 `routeOversized`；
   判断满额能否容纳时同时考虑该 workout 的全部路线分段和文件数。
2. 待办增加显式状态和调度字段：ready／retry-wait／blocked-size、
   `lastAttemptAt`、`nextRetryAt`、阻塞时的预算／能力指纹、重试次数。
3. 区分“还有待办”和“现在有可执行待办”：
   - ready 且可装入：继续下一批；
   - 暂不可读：保留待办，按有界退避重试；
   - blocked-size：保留可见状态，不持续安排即时前台／后台补跑。
4. 查询待办必须有数量上限和公平顺序，不能每次把全队列所有 UUID 一次性送入 HealthKit。
5. 只有预算能力提高、路线内容发生可信变化或用户明确重试该条时，才重新打开 size 阻塞。
   重试针对指定 UUID，不重置训练或记录 anchor。
6. 若未来需要单条路线分片上传，另做能力协商及原子路线发布协议；
   本轮不自动抽稀、截断、不提高服务端硬上限来掩盖问题。
7. 新列以兼容方式追加；旧 reason 映射保守，预算不足不能迁移成永久 size 阻塞。
   不删除既有未交付 UUID。

**验收**

- 单条路线永远超过满额时，跨多次唤醒及重启不会无限重读同一 GPX。
- 只剩阻塞路线时不即时自旋，但界面能显示还有未交付数据。
- 阻塞路线不饿死其他 ready 路线；预算变化后能够定点恢复。
- 临时不可读不被误判完成，和 R03 的删除待办判据一致。

## 5. 工作包和执行顺序

| 工作包 | 内容 | 依赖 | 可验收产物 |
|---|---|---|---|
| F00 | 固化七项复现和当前检查基线 | 无 | 新夹具在当前缺陷上精确失败；不删现有守卫 |
| F10 | 共用覆盖计划、最小 dirty 证据及发布核验 | F00 | 覆盖集合、逐域边界、输入绑定同源 |
| F11 | R01 重排守恒、原任务查询闭环 | F10 | 漂移后原范围不丢，前后结果与离线参考一致 |
| F12 | R02 合并成员与事实覆盖分离 | F10、F11 | 3 批时间窗／33 批限额边界通过 |
| F20 | R03 路线结果类型与待办原子结算 | F00 | 失败不清待办，真实 SQLite 故障注入通过 |
| F21 | R04 批次清单及页级文件隔离 | F20 | 重复附件夹具通过真实 ZIP／接收器测试 |
| F22 | R07 阻塞、退避和公平调度 | F20、F21 | 多轮重启不空转，不丢待办 |
| F30 | R05 前缀兼容证明 | F11、F12 | 真实直连路径产生有效复用，拒绝不安全复用 |
| F31 | R06 必要输入有界装配和索引 | F10、F30 | 历史量放大测试、数值对照和资源上限通过 |
| F40 | 综合回归与真机／目标服务器验收 | 全部 | 正确性、禁止操作、分段性能证据齐全 |

F10／F11／F12 涉及同一组 application／storage 文件，应顺序集成；
F20／F21／F22 涉及同一组 iOS 文件，也应顺序集成，避免交叉覆盖。
本文件不代表授权创建新聊天或启动多智能体任务。

## 6. 回归与验收方法

### 6.1 必须新增的行为用例

| 测试编号 | 场景 | 必须断言 |
|---|---|---|
| T01 | 早期更正 A＋较晚变更 B 导致重排 | A、B 都进入结果，边界不后移 |
| T02 | 物化输入发布前被新批次推进 | 安全重排或拒绝发布，不把旧结果报最新 |
| T03 | 第三批因时间窗未入选且日期最早 | 实际覆盖包含其影响，或保持 stale |
| T04 | 33 批超过 32 成员上限 | 上限之外的当前事实不能被漏算后冒认覆盖 |
| T05 | 路线失败无 observation | 任务及 UUID 待办保留 |
| T06 | 路线状态落盘失败 | 待办不删除，原始 committed 事实不被否认 |
| T07 | 附件先出现、正式页后出现同一训练 | 唯一 XML／GPX 清单，实际上传成功 |
| T08 | 缩页重试碰到已接受页文件 | 旧文件不被覆盖／删除，anchor 不提前 |
| T09 | 两个真实直连批次代次不同 | 安全负荷／分区／日级前缀确实复用 |
| T10 | 早期更正、配置或 checkpoint 变化 | 不安全复用被拒绝，数值与参考一致 |
| T11 | 固定近期变更，历史量扩大 10 倍 | 必要读取行数不跟着扩大 10 倍，区间查询走索引 |
| T12 | 超大路线跨多轮／重启 | 不无限查询；阻塞可见；其他路线能继续 |
| T13 | 分段读取期间发生控制／事实漂移 | 不拼接不同绑定，走明确的重排策略 |

建议扩展现有 input-pinning、analysis-job-merge、training-metric-domain-reuse、
Swift 路线落盘与归档回归；需要的新测试文件列入相应聚合入口。
生产接线必须有行为验证，不能只检查函数名字或源码字符串存在。

### 6.2 基本检查

```sh
npm run typecheck
npm test
npm run test:ios
npm run check:scripts
npm run check:docs
```

涉及共享契约或 Web 消费时再补 `npm run build`；
确有桌面浏览器交互变化才运行 `npm run test:e2e:web`，不运行冻结的响应式／移动 E2E。
平台不支持的 iOS 检查必须显式跳过，不能把“没有检查”报成通过。
新增 Swift／脚本／工程文件按仓库规则验证 LF。

### 6.3 性能测量

1. 使用程序生成的合成库，不复制生产数据库；相同硬件、代码、配置和输入比较。
2. 冷启动与热路径分开；每个工况预热后至少运行 30 次，记录 p50／p95／最大值。
3. 分别记录查询／导出、上传、解析、提交、输入捕获、CPU、候选写入和发布耗时。
4. 普通近期变更、历史训练内更正、删除积压、路线阻塞、连续批次和历史量放大均需覆盖。
5. R06 的初始扩展性门槛：相同必要窗口下，历史量扩大 10 倍，捕获行数不近似扩大 10 倍；
   捕获 p95 的 2 倍以内作为待校准目标，不能提前标记已达成。
   （2026-10-17：**行数判据已在合成夹具上落地并有回归测试**；p95 仍**未测**，两项分开报。）
6. R05 首先要求真实增量路径有可核对的复用行数，再比较 CPU／SQL 减少量；
   不能拿“错误地复用旧特征所以很快”作为性能基线。
7. 租约 200 空窗口 p50 小于 100ms 的已有目标保留，p95 单独报告。
   租约提速不替代端到端 p95 验收。
8. 真机／目标服务器的同步和分析时延预算在实际测量后确定，未测不承诺具体秒数。

### 6.4 红灯和证据口径

上一轮复查：typecheck、build、iOS 门禁通过；定向 Node 共 188 项，187 通过、1 失败，
失败为 TS／Rust `import_entity_changes` 等价性。完整 `npm test` 的前序执行记录另有
鉴权源码字面量守卫失败，详见前序实施记录，不能与本次定向结果混算。

本次仅编制文档，未重新运行上述业务测试。实施验收时应重新记录基线与修复后的结果：
不凭“某段写路径没改”就认定某项失败一定既有；未定位的失败继续列为未决。
退出码必须直接保存，不能通过 `| tail` 后取得错误的成功退出码。
日志只保留合成计数、批次标识、原因和耗时，不保存真实健康明细或令牌。

## 7. 迁移、上线与失败处置

### 7.1 迁移

- 服务端最小 dirty／覆盖证明、checkpoint 合同如需扩展，追加新迁移；
  编号以实施时实际占用为准，不修改历史迁移或冻结 checksum。
- iOS 待办新列及任务可选字段先保证旧版本可读取／安全保留。
  明确区分缺键、显式空值和损坏，损坏不能当空队列推进。
- 只保存必要执行证据，不增加原始健康数据副本，不做全库回填或轨迹复制。
- 需要受控结构迁移时，由维护者确认目标、停写及兼容版本后显式执行；
  不创建迁移备份，不把维护扫描放进普通同步。

### 7.2 上线顺序

1. 先落地复现和正确性修复，禁止单独上线放宽复用／发布判据。
2. 覆盖证据生产端先上线，新计算消费者和发布校验一起接入；
   证据缺失走明确兼容路径，不能先消费不存在的证明。
3. iOS 新待办持久化／解码先兼容，再启用新的完成、去重和退避逻辑。
4. R05／R06 以相同合成输入完成数值对照后再启用；上线后观察复用、输入行数和重排原因。
5. 任何开关只能回退到已知正确的增量路径，不能重新启用会漏算的旧计划。

### 7.3 已产生错误结果的处理

- 不能仅修改代码就宣布历史错误已自动修复。
- 对有可信账本／UUID 证据的受影响范围，定点重算服务端派生结果或定点补交路线；
  不要求手机全量同步，不重置 anchor。
- 对缺失可信账本的范围明确记录未知，不能猜测删除、伪造历史覆盖或默默修改评分结果。
- 发布失败保留旧结果并显示待更新；达到重试上限保留可操作的错误。
  若没有可靠的正确回退版本，暂停相应分析发布而不是继续激活错误候选。

## 8. 完成定义

七项问题只有同时满足以下条件，才能标记完成：

- [ ] T01–T13 行为用例覆盖生产装配，缺陷在修复前可被精确抓住。
- [ ] 新增、更正、删除、路线待办无遗漏，原回执与原任务 id 可查询真实进度。
- [ ] 旧发布到捕获输入之间的未覆盖变更全部进入执行证明，不再出现虚假最新。
- [ ] 真实直连增量路径确实复用安全前缀，不只是 CLI 夹具通过。
- [ ] 输入捕获不默认复制全部历史，区间查询走索引，超预算不无限读取。
- [ ] 超大路线跨轮不空转，暂时失败不被误判完成。
- [ ] 禁止操作为零：无全量同步、anchor 重置、整库备份、候选主库及文件换库。
- [ ] 检查结果、未决红灯、目标设备分段性能均有可复核记录，未测项不写“通过”。
