# Phase 3 — T/F 行为测试矩阵（P3-04 / P3-07）

- 基线：`/Users/ta/running`，HEAD `16a1229`（审查开始时干净；实施期间工作区包含 Lead 的 P3 生产修复与其他 teammate 的测试改动）。
- 日期：2026-10-22（Asia/Shanghai）。
- 范围：测试审计、验收与本轮 P2/T12 修复；生产源改动（删库操作日志、启动裁决、CLI、到达时钟注入）属于 Lead，见 §5 与 `PHASE3_REPORT.md`。
- 结果口径：**只有本次会话实际运行过的命令才写 pass/fail**；未运行写 `not run`。
- 并发：所有行为运行使用 `RAI_TEST_CONCURRENCY=2` 与 `--test-concurrency=2`。

## 1. 覆盖汇总

| 指标 | 数量 |
|---|---|
| 矩阵行总数 | 26（T01–T14 + F01–F12） |
| covered（有直接行为证据且本次通过） | 26 |
| partial（已有行为测试覆盖主干，但有明确未覆盖子断言/变体） | 0 |
| gap（无行为证据） | 0 |
| 本次失败/不可用作通过证据 | 0 |

> 说明：T09/T11/T12/T13 的 A/B 业务产物等价与 F07 的 checkpoint 拒绝证据由 `phase3-business-artifact-differential.test.ts` + `training-metric-domain-reuse.test.ts` 双文件套件提供；本轮执行结果为 **42 tests / 42 pass / 0 fail**；真实车道 T12 由 `apps/api/test/phase3-t12-real-lane.test.ts` 单列 G10，删库中断恢复由 `apps/api/test/dataset-deletion-recovery.test.ts` 单列 G11。整套比较器现直接比较 raw `baselineEpochId` / `calibrationCohortHash`，并把 `training_sessions` 自身行与发布投影（bundle / `evaluation_json` / active 指针 / 可读状态）纳入同条件对照。

## 2. 矩阵

### T 行

| ID | 场景 | 覆盖测试文件::测试名（existing / new） | 命令/组 | 最近执行结果 | 备注/限制 |
|---|---|---|---|---|---|
| T01 | 空库首个合法 v2 包、第二包；旧身份不兼容明确拒收 | `apps/api/test/direct-sync-ingest.test.ts::空库首包（四项身份全缺）+ v2 载荷 ⇒ 就地初始化：四要素齐备、第二包照常（S3.2/D3）`（existing）；`apps/api/test/direct-sync-ingest.test.ts::拒收码词典：缺文件 / 缺 v2 身份 / 删除超界 / 契约代际不符 / 库不存在 / 批次无回执 各自带正确 reason`（existing）；`apps/api/test/data-only-import.test.ts::missing/old parser attestation and uninitialized legacy hashes use the normal path without writes`（existing） | G1 | pass | 空库四要素（dataset_version / import_completed_at / parser_contract_version / parser_identity_algorithm）+ 第二包；`baseline_rebuild_required` 覆盖“有身份痕迹但代际不符”。 |
| T02 | data-only 新增／修订／白名单删除：原子提交、not_required、无本批 task、raw+1/dependency 不变 | `apps/api/test/data-only-import.test.ts::raw inserts, corrections, deletions, UUID facts, ledger and receipt commit together without replacement`（existing）；`apps/api/test/data-only-import.test.ts::a durable same-batch replay performs no writes and refuses a changed payload identity`（existing）；`apps/api/test/phase3-import-matrix.test.ts::T10 data-only 白名单删除：not_required、无本批任务、raw+1 且 dependency 不变`（new，补 generation/task 断言） | G1 / G6 | pass | 既有用例断言事实/账本/回执/墓碑与 `analysisJobId:null`；新用例补 `recompute_jobs=0`、raw+1、dependency 不变。 |
| T03 | direct-sync record-only（超过 fast-path 字节门槛） | `apps/api/test/direct-sync-ingest.test.ts::record-only 载荷：事实+账本+回执同事务落库，回执 not_required 且**没有**登记分析任务`（existing）；`apps/api/test/direct-sync-ingest.test.ts::收口窗口 (2, 8] MiB：data-only 拒、统一接收器接受（P2-4）`（existing，9000 条夹具已恢复）；`apps/api/test/import-receipt-fields.test.ts::direct-sync record-only：新回执 dependencyGeneration=null / analysisJobId=null，无本批任务`（existing，其他 teammate 文件） | G1 / G8 | pass | 字节门槛用例证明 >2 MiB 由统一接收器接收；回执字段合同由 record-only 用例与 receipt-fields 用例分别钉住。限制：收口窗口用例本身只断言落库条数，未在同一条里断言回执字段。 |
| T04 | 新 Workout／评分记录：queued 与持久 task/batch/代次一致；分析可完成 | `apps/api/test/direct-sync-ingest.test.ts::Workout 载荷：同事务登记分析任务，回执 queued，且消费者能把它跑完（闭环）`（existing）；`apps/api/test/direct-sync-analysis-reconcile.test.ts::需要分析的批次：回执的 analysisJobId 等于 recompute_jobs 那一行，且与批次账本同源`（existing） | G1 | pass | 闭环真的用 `RaiApplicationService.runNextJob()` 跑完并移动 `active_model_run`；绑定列 raw/dependency 与任务一致。 |
| T05 | 未知 record、未知+已知混合变更：不进入 data-only；要求分析；未知依赖不得被局部边界掩盖 | `packages/health-export-parser/test/dirty-range.test.ts::T05：未知记录类型单独出现 ⇒ full（unknown_record_type，不猜域依赖）`、`::T05：未知类型与有界已知变更混合 ⇒ 仍 full，已知边界不得掩盖未知影响`、`::T05：已知非评分类型与有界评分变更混合 ⇒ 仍按已知边界 partial（不误伤白名单）`（existing，Lead 本次新增）；`apps/api/test/phase3-import-matrix.test.ts::T05 未知 record 类型（单独 / 与有界已知变更混合）都必须登记分析且不产出有界增量计划`（new） | G2 / G6 | pass | 新用例走真直连事务并读取 `recompute_jobs.request_json`：`incrementalPlan === undefined`、`dirty_json.from === null`、`analysis_dirty_plan_json.full === true` 且三域 null；单独未知类型同样 full。data-only 入口对未知类型返回 `null` 且零写入。 |
| T06 | 同 job 同内容重试/并发重复：原 receipt，一份可见效果；事实/任务/代次不重复 | `apps/api/test/direct-sync-http-acceptance.test.ts::A17/A06：真实上传→inspect→import-jobs→终态（需要分析 ⇒ queued），且同批同内容重放取回**原回执**`（existing，HTTP 层）；`apps/api/test/phase3-import-matrix.test.ts::T06 同 job 同内容重放（worker 层）：返回原回执，事实/任务/代次不重复`（new）；`apps/api/test/data-only-import.test.ts::a durable same-batch replay performs no writes and refuses a changed payload identity`（existing，data-only 层） | G5 / G6 / G1 | pass | HTTP 用例断言重传命中同 source/job、`summary` 逐字段相同、facts/workouts/sessions/raw generation/batches/recomputeJobs 不增长、持久回执字节不变；worker 新用例补 `applyDirectSyncImport` 直接重放路径。 |
| T07 | 同 batch 标识不同内容、跨 scope 重用：身份合同拒绝冲突或隔离 | `apps/api/test/phase3-import-matrix.test.ts::T07 同 job id 不同内容：显式身份冲突拒绝，原成功批次与回执不变`（new）；`apps/api/test/data-only-import.test.ts::a durable same-batch replay performs no writes and refuses a changed payload identity`（existing，data-only）；`apps/api/test/direct-sync-http-acceptance.test.ts::会话身份：批次标识的合法性与 scoping 是 HTTP 层事实，不是客户端约定`（existing，HTTP source scoping） | G6 / G1 / G5 | pass | 直连冲突抛 `reused with different content`，事实/批次/代次/原回执不变；data-only 抛 `Data-only batch id was reused with different content`；HTTP 层证明同批次标识命中同 source、不同标识建不同 source。 |
| T08 | 不同 job 同内容、no-op anchor 事务内失效：可证才 no-op，失效走正式车道 | `apps/api/test/import-payload-preflight.test.ts::an import records the payload anchor and the next identical sync skips the whole pipeline`（existing）；`::a database that moved since the anchor was recorded disables the short-circuit`（existing）；`::worker no-op 回执任务：重验通过才提交，anchor 失效返回 not_verified 且不写回执`（existing）；`apps/api/test/direct-sync-ingest.test.ts::P0-3/P2-3：回执带 records 计数（parsed/inserted/unchanged），提交成功的批次带四段阶段账本`（existing，不同 job 同内容 → inserted 0 / unchanged 2） | G1 | pass | 覆盖 anchor 命中、库移动失效、worker 事务内复验、不同 job 同内容不重复事实。 |
| T09 | 心率／训练时间前移、后移、训练内更正：新旧范围均脏，回退到受影响训练起点；A/B 等价 | `packages/health-export-parser/test/dirty-range.test.ts::训练内更正：边界回退到相交训练起点（旧实现只到更正时刻）`、`::新旧区间并集：时间前移后旧范围同样是脏下界`（existing）；`apps/api/test/direct-sync-ingest.test.ts::O04：训练内的记录变更把脏下界回退到相交训练起点（不再是变更时刻）`（existing）；`packages/application/test/training-metric-domain-reuse.test.ts::O09: an in-training heart-rate correction rewinds the boundary and equals an offline run`、`::O09: a newly imported workout keeps the prefix and equals an offline from-scratch run`（existing，G4 通过） | G2 / G1 / G4 | pass | 脏范围主干由 `dirty-range` + `direct-sync-ingest::O04` 通过；A/B 业务产物等价由双文件套件 42/42 通过（含 **15 张**业务表投影、逐会话 load/zone、training_sessions、发布 bundle/可读状态、input binding/coverage）。 |
| T10 | 删除-only、先删后到、共享 UUID 来源：墓碑防复活；不误删其他来源；按车道分析策略 | `apps/api/test/phase3-import-matrix.test.ts::T10 直连删除先于到达：墓碑阻止复活；删除-only 必须要求分析`（new）；`::T10 直连共享 UUID 来源：删除一个来源不误删另一来源`（new）；`::T10 data-only 白名单删除：not_required、无本批任务、raw+1 且 dependency 不变`（new）；`apps/api/test/data-only-import.test.ts::deletion before arrival cannot resurrect a carried or later UUID`、`::a deletion-only delta restores a surviving shared UUID and records the correction`（existing）；`apps/api/test/direct-sync-ingest.test.ts::删除-only 载荷：显式删除先于到达也要求分析，且不误删同来源其它事实`（existing，workout 删除） | G6 / G1 | pass | 直连删除-only → `analysis-required`/queued 且有持久任务；墓碑阻止后到记录；共享 canonical 行在删除一个 UUID 后仍保留另一来源（live source=1，已删来源的别名行保留作墓碑证据）；data-only 白名单删除仍 `not_required`、无任务、raw+1/dependency 0。 |
| T11 | GPX 内容改、同大小改、路线归属 A→B、仅 XML 改归属：真实版本与旧/新归属均脏；完整 A/B 等价 | `apps/api/test/phase3-import-matrix.test.ts::T11 同大小 GPX 内容替换：发布新路线版本，并按路线归属把分析标脏`（new）；`::T11 路线归属 A→B（同内容）：旧、新归属都必须进入脏证据`（new）；`::T11 仅 XML 改归属、未附 GPX：旧 A/新 B 都脏，路线点与已发布版本保留`（new）；`::T11 同批同一路径出现两次归属变更：确定性拒收，整批回滚`（new）；`packages/application/test/training-metric-domain-reuse.test.ts::P3-06 T11: an XML-only route move dirties the old owner and equals offline-full`（new，完整 A/B）；`apps/api/test/direct-sync-ingest.test.ts::GPX 路线`（existing） | G6 / G4 / G1 | pass | 同大小替换：已发布 `route_versions.content_sha256` 变化；A→B：旧/新起点均进 `routeDirtyTimes`；仅 XML 变体：无 GPX 文件仍 `routesUpdated=1`，A/B 均脏，route id/点数/已发布版本保留；完整 A/B：loads 39/2、zones 39/4、daily 39/4、features 39/2、assessments 32，A `routePointCount=0`、B=3；同批矛盾归属被整批拒收。 |
| T12 | 睡眠／HRV 跨夜修订、两个不相邻时期：真实到达的 v2 XML 接收 → 局部夜重建 → **原任务**领取/绑定复核/partial 分析 → 发布 A/B 零差分 | `apps/api/test/phase3-t12-real-lane.test.ts::P3-06 T12（原任务主路径）：真实到达的 v2 XML→原任务 partial 消费→发布，A/B 零差分`（new，两个独立库 52 天、真实 `applyDirectSyncImport`、可审计时钟注入）；`packages/application/test/training-metric-domain-reuse.test.ts::P3-06 T12: ...`（existing，应用层补充）；`apps/api/test/direct-sync-ingest.test.ts::O10`、`::R7`（existing，夜窗口）；`packages/health-export-parser/test/canonicalize-nights-window.test.ts`（existing，窗口等价） | G10 / G5 / G1 / G2 / G9 / G4 | pass | 两库按真实到达顺序分段导入 52 天（第 1–33 天分段、34–52 天逐日；每批样本结束 ≤ 模拟到达），A 直接领取导入事务登记的 `analysisJobId`（无 DELETE、无复制计划、无事后改 `computed_at`/`import_completed_at`），核对回执↔批次↔raw/dependency↔父发布↔`dirty_json`，再经生产消费者运行：`input binding`、`analysis_job_coverage=[t12-revision]`、`reuse.proof=verified` 且 loads/zones/daily `reused=4`；B 是“生产导入修订批次 + 生产取消接口取消原分析任务 + 测试 `enqueueControlledFull()` 受控全量分析”的对照侧（不是生产全量主路径）。changed nights 恰好 2026-01-06/07 + 02-20/21；中间 36..49 的 canonical（含 `computed_at`）与逐日 readiness 不变；完整 15 表投影 A=B；readiness 变化且 A=B；Fitness=修订前=B；到达时间与 active 指针两项负对照均使比较/门禁失败。命令见 §4 G10；并发 2；exit 0；日志 `evidence/g10-t12-real-lane-final-2.log`。 |
| T13 | VO2-only、窗口边界前后证据、晚到历史记录：安全边界、真实复用、产物等价 | `packages/application/test/vo2-fitness-domain-convergence.test.ts::P0-2 消费侧：VO2Max-only 计划有界复用（不复用被拒/不退化全量），结果与从头全量一致`（existing）；`packages/health-export-parser/test/dirty-range.test.ts::P0-2：vo2Max 变更不再 full——样本在训练之前时取下界本身（fitness 域得到边界）`、`::P0-2：vo2Max 样本落在训练内 ⇒ 边界回绕到相交训练起点`（existing）；`packages/application/test/analysis-input-pinning.test.ts::历史固定截止点的直连任务保持自己的 asOf（不被'当前数据更新了'偷换语义）`（existing，晚到/历史） | G2 | pass | VO2 有界复用与全量结果一致；非法/无区间仍 full；历史 asOf 不被新数据替换。 |
| T14 | 8 MiB/5000/200/64 MiB 及 data-only 2 MiB/5000：等于上限接收，超限终态 refusal，零半批 | `apps/api/test/direct-sync-ingest.test.ts::边界：恰好等于 8 MiB 不算超（服务端语义是严格 >，P2-4）`（existing）；`::超限/杂物载荷 ⇒ **带码拒收**（回退旧链路）且零写入（观测版 S1.1）`（existing，>8 MiB 零写入）；`::收口窗口 (2, 8] MiB：data-only 拒、统一接收器接受（P2-4）`（existing，9000 条 XML 记录仍被接收）；`apps/api/test/phase3-import-matrix.test.ts::T14 上限常量未被放宽：直连 8 MiB / 删除配额 5000 / 200 / 64 MiB，data-only 2 MiB / 5000`（new）；`::T14 data-only 纯判据：2 MiB 恰好接收、+1 字节拒绝；5000 条接收、5001 条拒绝`（new）；`::T14 直连 XML record 数不设上限（maxRecords 只限删除配额）：5001 条在 8 MiB 内必须接收`（new，含删除配额 5000/5001）；`::T14 GPX 边界：200 文件恰好接收、201 拒绝；64 MiB 恰好接收、+1 字节拒绝`（new） | G1 / G6 | pass | **计划前提更正（不是缺陷）**：Phase 3 方案 §4.3 写“direct-sync Record ≤5000”，但当前产品合同（`packages/api-contracts/src/index.ts:223-229`、`docs/IOS_NATIVE_API_CONTRACT.md:66`）明确 `directSyncBounds.maxRecords` **只约束删除配额**，iOS `DirectSyncBatchBudget.swift:79` 允许 12,000 条 XML 记录。因此本项目不按 5000 拒收 XML 记录：5001 条在 8 MiB 内必须接收（既有 9000 条窗口用例同样接收）。真正按 5000 严格 `>` 判定的是 manifest 删除配额（恰好 5000 接收，5001 `deletions_exceed_bounds`）。8 MiB 精确值只走 preflight（既有测试边界），>8 MiB 的终态拒收与零写入由既有用例覆盖。 |

### F 行

| ID | 场景 | 覆盖测试文件::测试名（existing / new） | 命令/组 | 最近执行结果 | 备注/限制 |
|---|---|---|---|---|---|
| F01 | COMMIT 前杀测试进程，含**真实删除 + GPX**：屏障证明两者已写入同一未提交事务；全部回滚，重启同 job 恰好一次 | `apps/api/test/direct-sync-http-acceptance.test.ts::A05/F01：COMMIT 前确定性屏障证明删除与 GPX 同事务写入 ⇒ SIGKILL 全回滚，同 job 恰好重试一次`（new）；`apps/api/test/data-only-import.test.ts::SIGKILL immediately before the receipt write leaves no accepted facts or partial deletion state`（existing） | G5 / G1 | pass | 基线先经 HTTP 提交 2 条稳定 UUID 事实（1 待删 + 1 对照）；待杀批次的 v2 manifest 显式删除待删 UUID，同时提交 Workout + 3 点 GPX。屏障是**回执 INSERT 触发器 + 同连接测试函数**：同一事务内先 `RAISE(ABORT)` 断言待删 UUID 已不可见、对照仍在、Workout/路线版本/3 点/墓碑已写入，再落盘计数并暂停；外部只读连接看到批次前快照且无回执。SIGKILL 后 15 张表的逐表快照逐字节等于批次前（含原删除目标），`foreign_key_check` 为空；重启同 job 恰好一次：13 条记录（2−1+12）、1 Workout/路线/版本/3 点/1 指纹、2 批次、2 回执；重放不改变任何表。命令见 §4 G5；并发 2；exit 0；日志 `evidence/g5-f01-delete-gpx-http-worker.log`。 |
| F02 | COMMIT 后回复丢失／父进程退出：原持久 receipt 恢复；不重复事实、不换 task ID | `apps/api/test/direct-sync-http-acceptance.test.ts::A05：COMMIT 后丢回复 ⇒ 重启从**持久回执**恢复成功（不重传、不重算、不留第二个终态说法）`（existing）；`apps/api/test/import-worker-reuse.test.ts::真实 worker 提交后回复丢失：线程终止后从持久回执恢复同一成功结果`（existing）；`::提交后回复丢失：从持久回执恢复同一个 no-op 成功结果`（existing） | G5 | pass | HTTP 用例断言重启后 workouts/sessions/batches/raw generation/recomputeJobs 不重复、持久回执一字未改；worker 用例断言恢复结果来自持久回执而非内存回复。 |
| F03 | F02 + 重启时主库缺失/回执读失败 + 取消／attempts 耗尽：无猜测终态；恢复后按真实结果收敛 | `apps/api/test/import-scope-evidence.test.ts`（9 条：旧库升级/首次登记前缺失/启动后消失/账本损坏/真正首次安装/写失败/epoch）；`apps/api/test/import-restart-receipt-recovery.test.ts::helper 四态：found / confirmed_absent / missing / unreadable`；`::已提交回执 + 持久 running`；`::损坏数据库 + cancelRequested`；`::损坏数据库 + attempts=3`；`::首次空库 + queued attempts=0`；`::create 入队时把主库缺失写进持久队列证据`；`::缺失库 + attempts=0 但没有入队时空库证据：恢复阻断`；`::已提交 + 重启时主库暂时缺失 + cancelRequested：阻断而非 cancelled；恢复后返回原回执`；`::外 scope 旧任务`（均 G7）；`apps/api/test/import-worker-reuse.test.ts::提交结果不确定且数据库不可访问`；`apps/api/test/import-publication.test.ts::strict receipt read rejects a missing database`、`::strict receipt read rejects corrupt databases, malformed JSON, and JSON null receipts` | G7 / G5 / G3 | pass | 四态 `found / confirmed_absent / missing / unreadable`；缺失库不再默认“无回执”，只有**当前 pristine 作用域许可**（任务 `firstEmptyEpoch` 匹配 + 账本状态 pristine）可放行；已提交+缺失库恢复后返回原回执且不重复事实；通知恰好一次、重复 resume 不重复；外 scope 旧任务保持原收口。 |
| F04 | receipt 写入／task 登记／dirty evidence 回读失败：整批回滚，无 queued 无 task / 成功无账本 | `apps/api/test/phase3-import-matrix.test.ts::F04 分析脏证据写入被静默忽略（回读不一致）⇒ 事实/批次/任务/回执整批回滚`（new）；`apps/api/test/direct-sync-ingest.test.ts::A04 形态：回执写入点故障注入 ⇒ 事实/批次/任务/回执整批回滚`（existing）；`apps/api/test/data-only-import.test.ts` 的 17 条触发器回滚用例（existing） | G6 / G1 | pass | 新用例用 `BEFORE UPDATE OF analysis_dirty_plan_json ... RAISE(IGNORE)` 让回读与写入不一致，断言 facts/workouts/batches/jobs/generations/receipt 全 0；既有 A04 覆盖回执写点失败；data-only 触发器矩阵覆盖 receipt 静默忽略/重写、任务与账本晚删。限制：没有单独注入“task 登记 INSERT 失败”的用例，但 A04 的回执失败已覆盖同事务任务回滚。 |
| F05 | 丢失调度唤醒：持久任务由巡检或启动恢复继续，无永久悬挂 | `apps/api/test/recompute-worker.test.ts::a queued job still spawns a worker thread`（existing）；`::wakeIfPending：空队列不动作，有 queued 任务就唤醒（兜底巡检的有效性）`（existing）；`::组合验证：登记后经唤醒真的被消费者跑完（不 stub spawn）`（existing）；`packages/storage-sqlite/test/recompute-job-recovery.test.ts::中断的直连分析任务（同一个 'import' 类型、直连载荷）回到队列，可被消费者重跑`（existing） | G3 / G2 | pass | 巡检从**持久** `recompute_jobs` 读取；组合用例不 stub spawn，真的走 claimNext → runDirectSyncAnalysis → 终态；重启恢复把中断的直连任务放回 queued。 |
| F06 | worker ready 前错误、迟到回复、close、terminate 失败：不串批；确认停写前不读回执裁决/不释放写者 | `apps/api/test/import-worker-reuse.test.ts::worker 冷启动期间 close：ready 与任务结算，关闭完成且不重建线程`；`::ready 前真实退出：启动等待被结算，任务不悬挂`；`::ready 前 error 事件：启动等待同样被拒绝，close 不悬挂`；`::任务异常只污染那一批：线程被替换，下一批拿到新线程且回执互不串`；`::terminate 同步抛错/异步拒绝：集合清空后仍返回停止未确认，后续成功不得清除失败`；`::恢复分支中 terminate 同步抛错/异步拒绝：进入恢复阻断，全局写者无法取得许可`（均 existing） | G5 | pass | 覆盖 ready 前 exit/error/close、任务隔离、terminate 失败不误判 stopped、恢复阻断下全局写者不能取许可。 |
| F07 | checkpoint hash／版本／状态／父行缺失／校准 cohort 损坏：拒绝复用、计数/原因可信、全量结果正确 | `packages/application/test/training-metric-domain-reuse.test.ts::O09: a tampered checkpoint state is refused (hash), never resumed from defaults`；`::O09: a parent computed without an evidence source is refused, never resumed from defaults`；`::O09: a parent whose zone-chain tail no longer matches the checkpoint is refused`；`::O09: a prefix whose daily rows no longer match is narrowed, not copied`；`::P3-06: a corrupt parent calibration cohort refuses the resume, never an empty cohort`（new）；`::P3-06: consecutive incremental replay keeps the raw baseline epoch stable`（new） | G4 | pass | 双文件套件：42 tests / 42 pass / 0 fail（73.9 s）；tampered checkpoint / 无证据父 run / zone-chain 尾不匹配 / 日行不匹配 / 重复校准 id 均被拒绝且全量结果正确；连续两轮增量 raw epoch/cohort 稳定，checkpoint 只保存当前 run feature id。 |
| F08 | 多批合并、运行中漂移重排、覆盖任务失败／取消：范围不丢、原 ID 可查、成员正确完成或释放 | `apps/api/test/analysis-job-merge.test.ts::验收①：10 条兼容排队批次只执行一份覆盖计算，10 个原 analysisJobId 各自查到真实结果`；`::验收②（安全重排）：计算期间来了推依赖代次的批次 ⇒ 发布被拒、成员留队列、绝不混代次`；`::验收②（同绑定发布）：计算期间只来了 raw-only 批次 ⇒ D4 放行、同绑定发布并结算`；`::验收③（新鲜度派生）：被覆盖任务的状态沿持久覆盖关系读，不由内存推断`；`::验收④（服务端任务查询）：覆盖任务在跑时，GET /v1/jobs/:id 沿原 id 报它的真实进度`（均 existing） | G3 | pass | 10 批 → 一份 feature/model run；10 个原 id 都可查；重排释放成员回 queued、同绑定发布结算为 published；覆盖任务失败后成员 `replan` 回 queued（验收④）。 |
| F09 | 分析中追加 raw-only vs analysis-required：前者仅凭完整证据兼容，后者不能发布过时候选 | `apps/api/test/analysis-job-merge.test.ts::验收②（同绑定发布）：计算期间只来了 raw-only 批次 ⇒ D4 放行、同绑定发布并结算`；`::验收②（安全重排）：计算期间来了推依赖代次的批次 ⇒ 发布被拒、成员留队列、绝不混代次`（existing）；`packages/storage-sqlite/test/analysis-input-binding-release.test.ts::D4②：只有 raw-only 批次进来 ⇒ 放行（依赖代次没动就是证明）`；`::D4③：依赖代次前进之后 ⇒ 拒绝（候选真的旧了，不能当最新发布）`（existing）；`packages/application/test/analysis-input-pinning.test.ts::注入下一批（合法 raw-only）⇒ 同绑定发布，且代次前进仍留痕`；`::注入下一批（含新训练、推依赖代次）⇒ 候选只含固定输入的训练，且不得混代发布`（existing） | G3 / G2 | pass | raw-only：发布绑定 `capturedDependency=3`，成员 published；analysis-required：发布被拒、成员 released 回 queued、候选不是 active；pinning 用例证明候选只含固定输入。 |
| F10 | 候选生成后崩溃、发布事务失败、发布后丢回复：旧发布稳定或新发布完整，无半指针或重复可见发布 | `packages/storage-sqlite/test/model-release-v2.test.ts::S01: v23 releases atomically publish/rollback and reject failed, stale and changed snapshots`（existing，发布事务 `active_model_run` 触发器失败 → 旧指针稳定、bundle 未激活；failed/stale/changed snapshot 拒绝）；`apps/api/test/phase3-analysis-publication.test.ts::F10 候选已生成但发布前中断：旧发布稳定、候选不可见；补发同一发布幂等且无重复 release`（new） | G2 / G6 | pass | 新用例：候选 run succeeded + bundle passed 但未激活时 active run/release 仍是旧 A；重放发布到 B 后指针 B、`activated_at` 首次值不被改写、active_model_run/release 单行、bundle 单份、旧 A 仍 `isPublished`。限制：没有进程级 crash（SIGKILL）夹具；“发布事务失败”由既有 model-release-v2 触发器用例覆盖。 |
| F11 | epoch／scope 变化、删库中断与同路径换库：旧任务/缓存/候选不能当作新数据集完成证据；任一断点重启不得错误建库 | `apps/api/test/dataset-epoch.test.ts`（持久 epoch、损坏日志失败关闭）；`apps/api/test/import-worker-reuse.test.ts`（同路径换库）；`apps/api/test/dataset-deletion-recovery.test.ts`（19 条：原 9 条故障注入 + P2-9 可读主库 epoch 冲突、P2-10 已发许可行缺失、P2-11 写者进入后恢复备份、P2-12 快照字节损坏 + P1-2/P1-4/P1-5/P2-5/P2-9/P1-7）；`apps/api/test/import-scope-evidence.test.ts`（历史 established 时间与当前 unknown 状态并存） | G3 / G5 / G11 / G12 | pass | 真实 API 子进程、维护层、侧车/runtime/main SQLite；prepared epoch 冲突时业务读写 409 且显式恢复入口可用；`permit_issued` 丢失许可时 CLI 与启动均不重签；写者进入后恢复备份记为 `superseded` 且重启采用恢复 epoch；快照存在但摘要不符时自动和 CLI 均拒发许可；WAL 尚未 checkpoint 的可读主库重启不误判为缺失。 |
| F12 | 裁剪越界、materialized/segmented 切换、coverage 缺失：有界读、明确重捕获/全量兜底，不截断后伪成功 | `packages/application/test/analysis-input-materialization.test.ts::超过预算：转为分段读（不是无限读），读数仍然完整且每条读之后不留事务`；`::分段模式：单条读越过 maxReadRows 直接失败，绝不截断后当完整输入计算`；`::分段模式：依赖代次前进 ⇒ 抛 AnalysisInputDriftError（候选作废，不拼接）`；`::漂移重排：raw-only 批次不产出可复用边界 ⇒ 显式 coverage_gap（全量），绝不静默复用`；`::R06：预算探针有界 —— 行数超限后不再做任何 SUM(LENGTH)`；`packages/application/test/analysis-input-pruning.test.ts::R06 覆盖守卫：边界被人为收紧 ⇒ 显式失败 + 关闭裁剪重捕获一次，结果与不裁剪一致`（均 existing） | G2 | pass | 分段读失败不截断、漂移作废、coverage_gap 全量、预算探针有界、裁剪覆盖守卫显式重捕获。 |

## 3. 未覆盖/降级项与理由

1. **T12 原任务真实消费（已补齐）**：`phase3-t12-real-lane.test.ts` 现在按真实到达顺序导入 52 天，A 直接领取导入事务登记的 `analysisJobId` 并经生产消费者完成 partial 发布（不再 DELETE 原任务/复制计划/事后改 canonical 到达时间）；B 用生产取消接口取消登记任务后在同一父发布上全量对照。input binding、coverage、`reuse.proof=verified`、15 表投影/readiness/Fitness 零差分与到达时间/active 指针负对照均有直接证据。
2. **F01 删除 + GPX 确定性屏障（已补齐）**：回执 INSERT 触发器在同一事务连接内证明删除已执行、GPX 版本/3 点已写入，再 SIGKILL；15 张表逐字节回滚、同 job 恰好重试一次。WAL 阈值不再作为屏障证据。
3. **发布投影 / `training_sessions` 自身行（已补齐）**：`business-artifact-projection.ts` 现包含 `training_sessions` 全部业务列、`model_release_bundles`（bundle/`evaluation_json`/快照域/激活事实）、`release_readable_state`（active 指针、freshness、可读域）；每个 A/B 场景自动逐字段比较。负对照证明改训练 session 字段、改 evaluation、错 active 指针都会失败。
4. **T14 8 MiB 精确值**：既有用例只调用 `preflightDirectSyncPayload`，不执行解析/提交；这是既有测试的边界，不是本次削弱。>8 MiB 的终态拒收与零写入由另一条既有用例覆盖。
5. **T14 计划前提更正（不是缺陷）**：Phase 3 方案 §4.3 的“direct-sync Record ≤5000”与当前产品合同冲突——`directSyncBounds.maxRecords` 只约束删除配额（`packages/api-contracts/src/index.ts:223-229`、`docs/IOS_NATIVE_API_CONTRACT.md:66`；iOS `DirectSyncBatchBudget.swift:79` 允许 12,000 条）。实施中曾短暂加入 `records_exceed_bounds` 生产校验，核对合同后已由 Lead 回退；测试改为断言 5001 条 XML 记录合法接收，删除配额仍 5000/5001 精确判定。
6. **删库恢复协议（已补齐）**：`dataset-deletion-recovery.test.ts` 共 19 条真实子进程故障与恢复用例；覆盖四阶段、CLI 恢复、侧车/配置/快照/账本实例/写失败关闭、旧备份恢复，并补测 epoch 冲突、许可行缺失、已消费意图被备份恢复替代、快照字节损坏。中断后一律原目录重启，测试不手工修补状态。
7. **T02/T03 回执字段的 cross-file 组合**：T02 的 `not_required`/无任务由 data-only 用例与 receipt-fields 用例分别证明；T03 的字节门槛与回执字段也分属两条用例。矩阵按“组合覆盖”标记，不声称单条测试全包。

## 4. 本次实际运行的命令与结果

所有命令在 `/Users/ta/running` 执行。行为套件用 Node `v22.23.2`（`export PATH="/Users/ta/.nvm/versions/node/v22.23.2/bin:$PATH"`）；完整 `npm test` 用同一运行时（npm `10.9.8`）。最终完整日志在 `deliverables/phase3-import-analysis-2026-10-22/evidence/full-suite-final-2026-10-23.log`，目标套件日志见 `evidence/g4-*.log`、`g5-*.log`、`g7-*.log`、`g12-*.log`。

| 组 | 命令 | 结果 |
|---|---|---|
| G1 | `RAI_TEST_CONCURRENCY=2 node --import tsx --test --test-concurrency=2 apps/api/test/direct-sync-ingest.test.ts apps/api/test/data-only-import.test.ts apps/api/test/direct-sync-analysis-registration.test.ts apps/api/test/direct-sync-analysis-reconcile.test.ts apps/api/test/import-payload-preflight.test.ts apps/api/test/import-worker-direct-sync.test.ts apps/api/test/direct-sync-prohibited-operations.test.ts apps/api/test/direct-sync-table-dispositions.test.ts` | 82 tests, 82 pass, 0 fail (`g1-ingest-core.log`) |
| G2 | `RAI_TEST_CONCURRENCY=2 node --import tsx --test --test-concurrency=2 packages/health-export-parser/test/dirty-range.test.ts packages/health-export-parser/test/dirty-range-route.test.ts packages/health-export-parser/test/direct-sync-payload-class.test.ts packages/application/test/analysis-input-pinning.test.ts packages/application/test/analysis-input-materialization.test.ts packages/application/test/analysis-input-pruning.test.ts packages/application/test/analysis-input-batch-floor.test.ts packages/application/test/vo2-fitness-domain-convergence.test.ts packages/storage-sqlite/test/recompute-job-recovery.test.ts packages/storage-sqlite/test/recompute-job-bindings.test.ts packages/storage-sqlite/test/recompute-job-replan.test.ts packages/storage-sqlite/test/direct-sync-migrations.test.ts packages/storage-sqlite/test/migration-policy.test.ts packages/storage-sqlite/test/model-release-v2.test.ts packages/storage-sqlite/test/analysis-input-binding-release.test.ts` | 92 tests, 92 pass, 0 fail (`g2-parser-application-storage.log`) |
| G3 | `RAI_TEST_CONCURRENCY=1 node --import tsx --test --test-concurrency=1 apps/api/test/analysis-job-merge.test.ts apps/api/test/analysis-failure-isolation.test.ts apps/api/test/import-publication.test.ts apps/api/test/recompute-worker.test.ts apps/api/test/dataset-epoch.test.ts packages/application/test/analysis-coverage-merge.test.ts` | 42 tests, 42 pass, 0 fail / 17.3 s（`evidence/g3-server-worker-final-2026-10-23.log`；并发 1；2026-10-23 journal 结构化恢复与 epoch 用例） |
| G4 | `RAI_TEST_CONCURRENCY=2 node --import tsx --test --test-concurrency=2 packages/application/test/training-metric-domain-reuse.test.ts packages/application/test/phase3-business-artifact-differential.test.ts` | **42 tests / 42 pass / 0 fail / 73.9 s**（应用层 A/B、15 表发布投影与 22 条负对照） |
| G5 | `RAI_TEST_CONCURRENCY=2 node --import tsx --test --test-concurrency=2 apps/api/test/direct-sync-http-acceptance.test.ts apps/api/test/import-worker-reuse.test.ts` | **36 tests, 36 pass, 0 fail**（HTTP 12 含 F01 删除+GPX 确定性屏障 + worker 24） |
| G6 | `RAI_TEST_CONCURRENCY=2 node --import tsx --test --test-concurrency=2 apps/api/test/phase3-import-matrix.test.ts apps/api/test/phase3-analysis-publication.test.ts` | 16 tests, 16 pass, 0 fail（matrix 15 + publication 1；含 T11 仅 XML/矛盾归属） |
| G7 | `RAI_TEST_CONCURRENCY=2 node --import tsx --test --test-concurrency=2 apps/api/test/import-restart-receipt-recovery.test.ts apps/api/test/import-scope-evidence.test.ts` | **23 tests, 23 pass, 0 fail**（restart 14 + scope 9；含旧库升级/首次登记前缺失/启动后消失/账本损坏/首次安装/写失败/epoch） |
| G8 | `RAI_TEST_CONCURRENCY=2 node --import tsx --test --test-concurrency=2 apps/api/test/import-receipt-fields.test.ts` | 4 tests, 4 pass, 0 fail (`g8-receipt-fields.log`) |
| G9 | `RAI_TEST_CONCURRENCY=2 node --import tsx --test --test-concurrency=2 packages/health-export-parser/test/canonicalize-nights-window.test.ts` | 20 tests, 20 pass, 0 fail (`g9-nights-window.log`) |
| G10 | `RAI_TEST_CONCURRENCY=2 node --import tsx --test --test-concurrency=1 apps/api/test/phase3-t12-real-lane.test.ts` | **1 test, 1 pass, 0 fail / 14.3 s**（真实到达的 52 天 v2 XML→原任务 partial 消费/发布 A/B；含到达时间与 active 指针负对照） |
| G11 | `RAI_TEST_CONCURRENCY=1 node --import tsx --test --test-concurrency=1 apps/api/test/dataset-deletion-recovery.test.ts` | **19 tests, 19 pass, 0 fail**（删库四阶段强杀恢复、普通异常保护快照回滚、CLI 恢复与失败关闭、旧备份恢复，以及 2026-10-23 新增 P1-2 快照轮换、P1-4 待迁移阻断、P1-5 显式放弃、P2-5 不可读隔离） |
| G12 | `node --import tsx --test --test-concurrency=2 apps/api/test/dataset-deletion-recovery.test.ts apps/api/test/import-scope-evidence.test.ts apps/api/test/maintenance.test.ts apps/api/test/dataset-epoch.test.ts apps/api/test/server-runtime.test.ts` | **100 tests / 99 pass / 0 fail / 1 skipped / 205.6 s**（`evidence/g12-recovery-review-fixes.log`；跳过项为仅 Windows 可复现的锁文件用例；新增 P2-9 至 P2-12、账本迁移保持 unknown、WAL 未 checkpoint 的重启回归） |
| G13 | `node --import tsx --test --test-name-pattern='P2-12' apps/api/test/dataset-deletion-recovery.test.ts`；`node --import tsx --test --test-name-pattern='组合验证：登记后经唤醒真的被消费者跑完' apps/api/test/recompute-worker.test.ts`；`node --import tsx --test --test-name-pattern='A05/F01' apps/api/test/direct-sync-http-acceptance.test.ts` | **各 1/1 pass**（`evidence/snapshot-digest-equal-size-g12.log`：同大小单字节篡改；`evidence/recompute-wake-fixed-g12.log`：常驻线程关闭；`evidence/direct-sync-f01-lock-fixed-g12.log`：后台写锁下的只读验收） |
| FULL | `RAI_TEST_CONCURRENCY=2 npm test`（Node 22.23.2 / npm 10.9.8） | **2419 tests / 2406 pass / 0 fail / 0 cancelled / 13 skipped / 626.4 s，exit 0**（`evidence/full-suite-final-2026-10-23.log`） |

## 5. 本次新增测试与改动

### 新增文件

- `apps/api/test/phase3-import-matrix.test.ts` — 15 tests：
  - T05 未知类型（单独/混合）
  - T06 worker 层同 job 同内容重放
  - T07 同 job id 不同内容
  - T10 删除先于到达、共享 UUID、data-only 删除策略
  - T11 同大小 GPX 替换、路线归属 A→B、仅 XML 改归属（无 GPX）、同批矛盾归属拒收
  - T14 上限常量、data-only 2 MiB/5000、直连 5001 条 XML 记录接收 + 删除配额 5000/5001、GPX 200/201 与 64 MiB/64 MiB+1
  - F04 dirty evidence 回读失败整批回滚
- `apps/api/test/phase3-analysis-publication.test.ts` — 1 test：F10 候选生成后中断 + 发布重放幂等。

### 改动的既有测试

- `apps/api/test/import-publication.test.ts`：新增“committed journal + 主库暂时缺失不误报回执丢失、intent 保留”。（`direct-sync-ingest.test.ts` 的 `收口窗口 (2, 8] MiB` 夹具曾在实施中临时改为 4500 条 + 长 value；核对合同后已恢复原 **9000 条**夹具并复跑通过。）
- `apps/api/test/import-queue.test.ts`：把“可读但无回执行 + attempts=1”夹具显式落成可读空库；缺失库/已提交作业的恢复语义由 `import-restart-receipt-recovery.test.ts` 覆盖。
- `apps/api/test/import-restart-receipt-recovery.test.ts`：新增 3 条（per-job only 阻断、create 作用域证据、A/B 双任务故障恢复），总计 14 tests。
- `apps/api/test/direct-sync-http-acceptance.test.ts`：新增 F01 删除+GPX 同事务确定性屏障 SIGKILL 变体（基线 2 条稳定 UUID + 12 条新记录 + Workout + 3 点 GPX），总计 12 tests。
- `apps/api/test/phase3-t12-real-lane.test.ts`：T12 原任务主路径（52 天真实到达 v2 XML、两处跨夜修订、A 原 `analysisJobId` partial 消费/发布、B 同父 direct-sync 全量、15 表投影、到达时间/active 指针负对照）。
- `apps/api/test/import-scope-evidence.test.ts`：新增 P1 七路径（旧库升级/首次登记前缺失/启动后消失/账本损坏/首次安装/写失败/epoch）。
- `packages/application/test/training-metric-domain-reuse.test.ts`：新增 `P3-06 T12` 双库 readiness/Fitness A/B（70 天、两处跨夜修订、中间期不变）；`assertSameBusiness` 现在强制发布投影非空且 active 指针自洽。
- `packages/application/test/business-artifact-projection.ts`：新增 `training_sessions` 全业务列、`model_release_bundles`（含 normalized evaluation / snapshot projection hash / 激活事实）、`release_readable_state`（active run/release 指针、bundle 状态、可读域、freshness）；evaluation 中的原始 run id 以插入序号替换。
- `packages/application/test/phase3-business-artifact-differential.test.ts`：新增 3 条负对照（training_sessions 字段、evaluation 报告、active 指针），总计 15 tests。

### 生产侧修复（由 Lead 完成；本报告只记录，不声称本次实现）

- P1 复审：`RuntimeStateStore` 的 `import_scope_evidence` 改为 unknown/pristine/writer_entered/established 状态机；启动登记旧库、受控 `data:init-scope`、显式删除/恢复 scope 转移；入队只读 pristine permit，执行前 `markScopeWriterEntered`，缺失库无 permit 则 `recovery_required`；旧版自动空行迁移为 unknown。
- T05：`planIncrementalAnalysisDirtyRange` 对未知记录类型强制 `full` + `unknown_record_type`。
- T14：**无生产修复**。核对产品合同后确认 `directSyncBounds.maxRecords` 只限删除配额，XML `<Record>` 条数不受 5000 约束；短暂加入的 `records_exceed_bounds` 校验已回退（计划前提更正，见 §3 第 5 条）。
- T11(a)：直连不再把 `routeDirtyTimes` 传入 `canonicalizeRunningWorkouts`，避免纯 GPX 变化触发未记账的净零 workout 写。
- T11(b)：`saveWorkout` 在 `preserveAbsent` 下允许显式引用路径改归新训练（复用旧 route id，保留点/指纹/版本）。
- T11(c)：`RaiDatabase.observeRouteOwnershipChanges()` 在事务内实际 UPDATE 处发出旧/新归属；直连接收器合并事件到 `changedRouteIds` / `routeDirtyTimes`，不再依赖 GPX 文件清单；同批重复归属变更拒收。
- D1：`remapResumedCheckpointState()` 按训练 session 重映射父 checkpoint 校准集合；比较器改为 raw epoch/cohort 直接比较。

### 已删除的临时探针

- `apps/api/test/zz-phase3-probe.test.ts` 仅用于定位上述 T05/T11 缺陷与 T14 计划前提差异，**已删除**；最终目录不含该文件，也不含 `console.log` 探针。

## 6. 结论

- 26 行全部有本次实际通过的行为证据；partial = 0，gap = 0。
- T11 的三类变体（同大小内容替换、带 GPX 的 A→B、仅 XML 的 A→B）与完整 A/B 业务投影均有直接证据；T12 真实车道 readiness/Fitness A/B、F01 删除+GPX 确定性屏障、发布 bundle/evaluation/active/可读状态投影、`training_sessions` 自身行逐字段比较均已补齐。
- 完整 `npm test` 门禁的最终结果见 §4 与 `evidence/manifest.json`；本机已通过 nvm 的 Node 22.23.2 提供 npm，且 `onnxruntime-node` 在该运行时下可加载。

## 6. 2026-10-23 复审问题新增回归

| 编号 | 回归文件与用例 | 验收点 |
|---|---|---|
| P1-1 | `apps/api/test/dataset-epoch-legacy.test.ts`（5 条） | 主库无 epoch 行时保持旧侧车 epoch；侧车损坏/配置不符阻断；主库值优先；回填 compare-before-write；v2/v3 身份绑定 |
| P1-2 | `apps/api/test/dataset-deletion-recovery.test.ts::P1-2 保护快照暂时移走再放回` | 快照暂时缺失不撤销/伪造许可；放回后同一许可只消费一次 |
| P1-3 | `packages/health-export-parser/test/dirty-range.test.ts`（3 条）、`packages/storage-sqlite/test/import-removal-ledger.test.ts`（2 条）、`apps/api/test/phase3-t12-real-lane.test.ts` | 删除旧侧类型/区间；跨夜删除；别名副本；历史缺旧侧 `full` |
| P1-4 | `apps/api/test/dataset-deletion-recovery.test.ts::P1-4 待迁移主库 + 删库裁决` | 不退出 78；恢复前不跑作业恢复；主库字节不变 |
| P1-5 | `apps/api/test/dataset-deletion-recovery.test.ts::P1-5 写者进入后建库前 SIGKILL` | 显式放弃生成新 epoch；旧任务 `superseded`；旧 scope 不复活 |
| P1-6 | `apps/api/test/import-publication.test.ts`（P1-6 三条） | committed/prepared 的 missing/unreadable 保留 journal 与现场；构造器不退出 |
| P1-7 | `apps/api/test/import-publication.test.ts::P1-7` | 恢复裁决任务不算写者；显式 restore 不被 `hasPending` 否决 |
| P1-8 | `apps/api/test/import-scope-fresh-install.test.ts`（5 条） | 任何历史证据/隔离账本/旧任务都拒绝 `--fresh-install` |
| P1-9 | `apps/api/test/deletion-failure-evidence.test.ts` | 损坏库恢复不得登记 established；gate 释放与结构化证据 |
| P2-1 | `apps/api/test/import-scope-evidence.test.ts`（2 条） | 零字节/损坏不 established；established 诊断写失败不阻断 |
| P2-2 | `apps/api/test/dataset-deletion-recovery.test.ts::P1-2` | `permit_issued` 不依赖快照字节 |
| P2-3 | `apps/api/test/deletion-failure-evidence.test.ts::P2-3` | 先撤许可后收口；中间态不可消费 |
| P2-4 | `deletion-recovery.ts` writer_entered 分支 + G11 | 恢复后主库 epoch 幂等收口为 superseded |
| P2-5 | `apps/api/test/dataset-deletion-recovery.test.ts::P2-5 不可读主库只能通过显式隔离` | 保护字节匹配 + 显式确认才推进 |
| P2-6 | `apps/api/test/import-worker-direct-sync.test.ts::P2-6`、`phase3-import-matrix.test.ts::T11` | 稳定 `route_ownership_conflict`；整批回滚 |
| P2-7 | `apps/api/test/dataset-epoch-legacy.test.ts::P2-7`（2 条） | v3 部署身份；v1/v2 不能签发许可 |
| P2-8 | `phase3-import-matrix.test.ts::T11` + `docs/IOS_NATIVE_API_CONTRACT.md` | `routesUpdated` 去重口径：内容/归属变化；内容不变为 0 |
| P2-9 | `apps/api/test/dataset-deletion-recovery.test.ts::P2-9 删除恢复期间` | 退役路由 410、未知 404、现役 409、恢复入口 200 |
| §3.1 | `scripts/phase3-equivalence-summary.mts` + `evidence/equivalence-summary.json` | 同一次运行 × 8 场景 × 15 表；缺表/空表直接失败 |
| §3.3 | `packages/application/test/import-idempotency-and-checkpoint.test.ts::F10 production path` | 真实 `runNextJob()` 发布路径故障注入；重试只产生一个可见发布 |
| §3.4 | `packages/application/test/phase3-business-artifact-differential.test.ts`（22 条） | 15 表完整规范；三张新增投影的缺表/缺列/业务值控制 |
