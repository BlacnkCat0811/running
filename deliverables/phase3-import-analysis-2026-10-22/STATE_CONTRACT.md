# RAI 阶段 3 状态合同

**基线：** `16a12296d62a77b45be9a96a38d90163ce2f5b13`（2026-10-22，工作区干净）  
**定位：** 本文件描述**当前代码实际承担**的导入／分析责任边界，并把每条持久断言映射到权威表、生产符号和测试落点。它不是新的产品规范；与源码冲突时以源码和可执行测试为准，并回头修正本文。  
**证据口径：** `E1` = 已阅读源码；`E2` = 本会话实际执行并通过；`E3` = 仅推断、尚需行为证明。阶段 3 的最终结论见 `PHASE3_REPORT.md`。

## 1. 入口与执行体（符号级索引）

| 层 | 真实入口／符号 | 职责 | 源码 |
|---|---|---|---|
| HTTP 上传 | `POST /v1/imports/uploads` | 接收 ZIP、落不可变上传目录、计算来源身份 | `apps/api/src/routes/import-routes.ts` |
| HTTP 建作业 | `POST /v1/import-jobs` | 持久作业准入、scope/租约保护、返回 job id | 同上；`apps/api/src/import-worker.ts` `create()` |
| HTTP 查询 | `GET /v1/import-jobs/:id`、`/active`、`/latest` | 只读投影；不回写回执 | 同上；`ImportWorker.publicJob()` |
| HTTP 取消 | `POST /v1/import-jobs/:id/cancel` | 仅在非提交区可取消；`phase=activate` 返回 publishing | `ImportWorker.cancel()` |
| 主执行体 | `ImportWorker.run()` | 预检、车道派发、终态裁决、恢复 | `apps/api/src/import-worker.ts:581` |
| 常驻 ingest 线程 | `runImportDatabaseTask()` | `verify` / `audit` / `checkpoint` / `noop-receipt` / `import-lanes` | `apps/api/src/import-database-thread.ts` |
| 线程消息 | `IngestWorkerTaskMessage` → `IngestWorkerReply` | `taskId` 逐批归因；`ready` 单独计时；失败后线程不复用 | `apps/api/src/import-database-tasks.ts:115-148` |
| data-only 车道 | `applyDataOnlyImport()` | 记录白名单、TEMP 写守卫、不可变 XML 快照、原子提交 | `apps/api/src/data-only-import.ts` |
| direct-sync 车道 | `applyDirectSyncImport()` | 统一接收器、账本／代次／脏证据／分析任务同事务 | `apps/api/src/direct-sync-ingest.ts` |
| no-op 回执 | `writeNoopReceiptTask()` | 事务内重验 anchor 后只写回执 | `apps/api/src/import-database-thread.ts:131` |
| 持久回执 | `writeImportReceiptInDatabase()` / `readImportReceiptStrict()` | `BEGIN IMMEDIATE` 内写、提交前回读；严格读取区分缺失与不可读 | `apps/api/src/import-publication.ts` |
| 启动恢复 | `ImportWorker.loadJobs()` | 按持久作业＋回执裁决 queued/running 的终态 | `apps/api/src/import-worker.ts:2354` |
| 分析消费者 | `RecomputeWorker.schedule()` / `wakeIfPending()` / `recoverInterruptedJobs()` | 唤醒、巡检、回收 running 遗留 | `apps/api/src/recompute-worker.ts` |
| 导入终态唤醒 | `onTerminal` 中的 `recomputeWorker.schedule()` | direct-sync 登记任务后的唯一主线程唤醒点 | `apps/api/src/server.ts` 导入 worker 构造 |
| 分析执行 | `RaiApplicationService.runNextJob()` → `RecomputePipeline` | 捕获输入、复用证明、候选 run、发布 | `packages/application/src/services/recompute-pipeline.ts` |
| 发布出口 | `SqliteModelReleaseRepository.activateSucceeded()` / `verifyAndPoint()` | 输入绑定、bundle、active 指针同一事务 | `packages/storage-sqlite/src/model-release-repository.ts` |
| 读侧新鲜度 | `GET /v1/series` / mobile read projections | 以 raw/dependency 与持久任务表达 freshness | `apps/api/src/mobile-read.ts`、`apps/api/src/read-store-manager.ts` |

## 2. 车道状态机

```text
上传／来源检查 → 持久导入作业准入（scope、租约、dataset epoch）
  ├─ 同一作业已有可信持久回执 → 返回原回执（不重算、不改写）
  ├─ 内容摘要 + dataset anchor 预检命中
  │    └─ ingest 线程 BEGIN IMMEDIATE 内重验身份
  │         ├─ 成功 → 只提交 no-op 回执 → succeeded / not_required
  │         └─ 身份失效 → 不写回执 → 正式车道
  └─ 正式车道（一个 import-lanes 任务）
       ├─ data-only 接受 → 原子提交 → not_required
       └─ data-only 结构性拒收 → direct-sync
            ├─ 实际变更不影响分析 → 原子提交 → not_required
            ├─ 实际变更影响分析 → 原子提交 + 持久任务 → queued
            └─ 拒收 → ImportLaneRefusal 终态，无候选库 fallback

任意“可能已提交”的异常 → 先确认 ingest 线程已停
  ├─ 严格读取找到回执 → 恢复已提交结果
  ├─ 读取成功且确实不存在 → 按原错误／取消／重试政策处理
  └─ 无法核实 → recovery_required，不发布猜测终态、不释放写者
```

**顺序是数据且被双侧校验：** `IMPORT_LANE_SEQUENCE`（主线程下发）必须等于 `IMPORT_LANE_ATTEMPTS`（worker 侧类型和运行期校验，`assertLanePlan` 拒绝其他顺序）。data-only 在前是因为它的入口判据更严；反过来会让闸门失去意义。

## 3. 持久断言矩阵

| 场景 | 提交后必须成立 | 权威表／持久物 | 生产符号 | 行为测试（当前） |
|---|---|---|---|---|
| no-op | 当前库身份与 anchor 一致；持久回执；新回执 `analysisJobId=null`；raw/dependency 不推进；不建本批任务 | `import_manifest` 的 `rai.applied-import.<jobId>`；`import_manifest.source_payload_anchor` | `writeNoopReceiptTask` | `import-payload-preflight.test.ts`（anchor 失效/命中）、`import-worker-reuse.test.ts`（no-op 线程与丢回复） |
| data-only | 允许范围内事实、身份、墓碑、变更账本、batch、raw、anchor、receipt 同事务；dependency 不变 | `health_records`／`workouts`、`import_batches`、`import_entity_changes`、`import_entity_tombstones`、`import_generations`、`import_manifest` | `applyDataOnlyImport` | `data-only-import.test.ts`（插入/更正/删除/重放/SIGKILL/删除先到） |
| direct-sync / not_required | batch 与 receipt 一致；raw 推进；dependency 不变；无本批任务；回执显式 `analysisJobId=null`、`dependencyGeneration=null` | 同上 + `import_batches.summary_json` | `applyDirectSyncImport` | `direct-sync-ingest.test.ts`、`direct-sync-analysis-reconcile.test.ts`、`direct-sync-http-acceptance.test.ts` A17 |
| direct-sync / queued | 同事务存在 `job_type='import'` 任务；task.target 代次、batch、receipt 的 task id 一致；脏证据持久化 | `recompute_jobs`、`import_batches.summary_json`、`import_manifest` | `applyDirectSyncImport` 的提交前回读断言 | `direct-sync-analysis-reconcile.test.ts`、`import-worker-direct-sync.test.ts`、`analysis-job-merge.test.ts` |
| 同 job 重放 | 同身份返回原 receipt；事实／代次／任务不重复增长；duration/task id 不重新生成 | `import_manifest`、`import_batches`、`import_entity_changes` | 各车道入口的 receipt 先读 | `data-only-import.test.ts` 重放用例、`direct-sync-http-acceptance.test.ts` 同批重放 |
| 同标识不同内容 | 按身份冲突合同拒绝；既有成功批次不受影响 | `import_batches.xml_sha256` / `summary_json.payloadSha256` | `data-only-import.ts`、`direct-sync-ingest.ts` | `data-only-import.test.ts` 同批不同内容；`direct-sync-*` 身份用例 |
| 不同 job 相同内容 | 内容身份与账本判定 no-op／无有效变更；不得重复事实 | anchor + `import_entity_generations` | `detectUnchangedPayload`、`writeNoopReceiptTask` | `import-payload-preflight.test.ts` |
| 拒收／提交前失败 | 无本次新增成功事实、任务、代次或回执；既有数据不变；无候选换库 | 全部主库表 | `ImportLaneRefusal`、`rollbackCallerTransaction` | `direct-sync-ingest.test.ts` 写守卫/回执故障、`direct-sync-prohibited-operations.test.ts` |
| 分析完成 | 原回执不变；原 task 可查；发布输入绑定与实际覆盖一致；失败 run 指针不可见 | `recompute_jobs`、`model_runs`、`active_model_run`、`model_release_bundles`、输入绑定表 | `activateModelRunAndCompleteJob`、`activateSucceeded` | `analysis-job-merge.test.ts`、`analysis-failure-isolation.test.ts`、`recompute-job-bindings.test.ts` |
| task 合并／重排 | 保留覆盖关系与原 ID 查询；所有必要批次进入覆盖证据；不重复结算 | `recompute_jobs` 覆盖列、`import_batches`、`model_domain_snapshots` lineage | `RecomputeJobRepository` | `analysis-job-merge.test.ts`、`recompute-job-replan.test.ts` |
| 重启恢复 | found → 原回执；confirmed_absent → 原取消/重试政策；missing 只有**当前 pristine 作用域许可**放行；unreadable/missing 无许可 → recovery_required，不猜终态、不建库、不清理来源 | `var/runtime.sqlite` 作业队列（含 `firstEmptyEpoch`）+ `import_scope_evidence` 状态机 + 主库回执 | `loadJobs()` + `readImportReceiptForRecovery()` + `firstEmptyPermitIsValid()`（P1，复审三次加固） | `import-restart-receipt-recovery.test.ts`（14/14，A/B 双任务）+ `import-scope-evidence.test.ts`（9/9，旧库缺失/账本损坏/首次安装/写失败/epoch） |

“无分析任务”只针对**本批**，不要求全库 `recompute_jobs` 为空；“幂等”只针对可见业务效果，不要求 worker 永只尝试一次。

## 4. 回执三生产者字段矩阵

| 字段 | no-op | data-only | direct-sync（`not_required`） | direct-sync（`queued`） |
|---|---|---|---|---|
| `directSync.ingestStatus` | `committed` | `committed` | `committed` | `committed` |
| `directSync.analysisStatus` | `not_required` | `not_required` | `not_required` | `queued` |
| `directSync.receiptId` | job id | job id | job id | job id |
| `directSync.dependencyGeneration` | `null` | `null` | `null`（R2 修正后） | `String(import_generations.dependency)` |
| `analysisJobId` | `null`（R1 修正后显式键） | `null`（显式键） | `null`（显式键） | 持久 `recompute_jobs.id` |
| `directSync.publishedReleaseId` | `null` | `null` | `null` | `null`（分析未跑完） |
| `directSync.parentBatchId` | `null` | `null` | `null` | `null` |
| `directSync.records` | 省略 | 省略 | 本批计数 | 本批计数 |

**不可变性：** 回执是 COMMIT 快照。分析完成后**不得**把 `queued` 改成 `published`；分析进展通过 `GET /v1/jobs/:id`、任务覆盖关系与当前发布读模型查询。历史回执缺键或带旧 `dependencyGeneration` 值时原样读取、原样重放，不批量回填。

## 5. 身份表（不得互相代替）

| 身份 | 产生者 | 持久位置 | 用途 | 不能代替 |
|---|---|---|---|---|
| job id | `createImportJobId()` | `var/import-jobs.json`、`import_batches.id`、回执 key | 批次可见身份、重放判据 | 内容身份、任务 id |
| 客户端 batch id / source id | iOS / upload 入口 | `import_sources`、`var/imports` | 上传与来源生命周期 | job id |
| 实体 UUID / alias | HealthKit 记录、parser | `health_records`、`import_entity_aliases` | 实体身份、墓碑 | 批次身份 |
| payload digest | `computeImportPayloadSha256()` | `import_manifest.source_payload_anchor`、`import_batches.summary_json.payloadSha256` | no-op 与同内容判定 | job id、dataset_version |
| dataset_version | 车道的 `hashOf()` / `dataset_delta_*` | `import_manifest.dataset_version` | 数据集代次与 anchor 绑定 | raw/dependency |
| raw generation | `import_generations.raw_generation` | `import_generations`、`import_batches.raw_generation` | 原始事实推进 | dependency |
| dependency generation | `import_generations.dependency_generation` | 同上 | 分析输入推进 | raw |
| dataset epoch | `readDatasetEpoch()` / 配置 | `dataset_epoch`（或配置） | 外部数据集隔离 | 内部 dataset_version |
| analysis job id | `RecomputeJobRepository.enqueue()` | `recompute_jobs.id`、回执 `analysisJobId`、`import_batches.summary_json.analysisJobId` | 追踪本批分析 | import job id |
| run id | `RecomputePipeline` | `model_runs.id`、`active_model_run` | 候选／发布身份 | 批次 id |

## 6. 分析任务、覆盖与发布合同

- **登记：** direct-sync 在**同一个外层事务**内 `enqueue("import", datasetVersion, request, {targetRawGeneration, targetDependencyGeneration, expectedIncumbentReleaseId, dirty})`；提交前回读 `recompute_jobs`、`import_batches` 与回执三处一致。
- **唤醒：** 导入终态回调调用 `recomputeWorker.schedule()`；`wakeIfPending()` 作为巡检兜底；`recoverInterruptedJobs()` 在每轮开始时回收 `running` 遗留。没有持久任务永久无人唤醒。
- **输入捕获：** `SqliteAnalysisInputReader` 按 **最大**回看窗口 `RECORDS_MAX_LOOKBACK_MS = (365+180) 天` 捕获；不得用更短 dirty 窗口截断输入（`analysis-input-reader.ts:694/721`）。
- **复用证明：** 复用必须同时满足父 run／schema／config／时区／canonical／override／checkpoint／前缀覆盖条件；证伪即 `reused=0` 并全量。`domains` 内 `null` = 不可证明增量，不是“该域无变化”；合并计划不得用较晚边界覆盖 `null` 或更早边界（`mergeDirtyPlans`）。
- **发布：** 输入绑定先于激活、在同一完成事务写入；release 检查 lineage、snapshot、override、dataset 与 incumbent；失败候选不可见；active 指针无半更新。
- **raw 与 dependency 不要求相等：** 非评分批次只推进 raw；把两者不等读成 stale 会制造假落后。反过来 raw-only 批次是否兼容由覆盖证据决定，不靠名字猜。

## 7. 重启恢复四态合同与作用域首空状态机（P3-03 / P1，复审后三次加固）

### 7.1 回执四态

`loadJobs()` 对**同 scope、queued/running** 的作业必须得到四种结论之一：

| 状态 | 判定 | 行为 | 禁止 |
|---|---|---|---|
| `found` | 读取成功且回执通过严格形状校验 | 恢复原回执，`succeeded/completed`，不重算、不改写 | 重写回执、换 task id |
| `confirmed_absent` | 读取成功且确实没有该 job 的回执行 | 按既有政策：`cancelRequested` → cancelled；同 scope 且 attempts<3 → queued；否则 failed/interrupted | 把“读不到/库缺失”当“没有” |
| `missing` | 数据库文件不存在 | 只有任务持有**当前作用域 pristine 许可**（`queued + attempts=0 + firstEmptyEpoch` 匹配）才按首次空库走原政策；否则 `recovery_required` 阻断 | 仅凭 attempts=0、仅凭文件缺失、仅凭任务自己的入队标记就裁决 |
| `unreadable` | 打开／查询／JSON／形状校验失败（数据库忙、损坏、权限、坏 JSON） | 保持 queued/running，`phase=recovery_required`，设置恢复阻断并通知全局 admission；不 finalize、不清理来源、不发终态 | 发布 cancelled/failed/succeeded，释放写者许可 |

- **通知时序：** 构造器只登记 pending；`onRecoveryRequired` 只在启动依赖声明完成后的 `resume()` 显式兑现一次，不靠捕获 `ReferenceError`。

### 7.2 作用域首空状态机（`var/runtime.sqlite` → `import_scope_evidence`）

正常路径单调前进：`unknown → pristine → writer_entered → established`。无行 = `unknown`；`unknown` **不能**自动变成 `pristine`。例外：启动时显式观察到“主库存在但不可读”可把状态置为 `unknown` 以阻断自动建库（writer/dataset 时间戳保留为诊断证据，后续可读观察再登记 established）。

| 状态 | 唯一写入来源 | 含义／许可 |
|---|---|---|
| `unknown` | 无行；或启动观察到“主库存在但不可读”；或旧表迁移后的旧自动空行 | **未知**，一律不放行首次空库建库 |
| `pristine` | 受控初始化：`npm run data:init-scope`，或显式删除成功并为新 epoch scope 建立许可 | 一次性首空许可；与 scope（serverId/athleteId/datasetEpoch）绑定 |
| `writer_entered` | 导入 worker 在任何可能写主库的动作**之前**持久写入 | 许可永久失效；主库再丢失也不能重新建库 |
| `established` | 启动观察到可读主库；worker 建库成功；恢复旧库／维护恢复完成 | 该 scope 已有数据集 |

**启动顺序（必须早于 ImportWorker 构造 / `loadJobs()` / `resume()`）：** 在 `recoverInterruptedRestore()` 之后先做删库裁决（§7.3），再以裁决出的**生效 epoch** 调 `RuntimeStateStore.registerStartupDatabaseObservation(scope, databasePath)`：
- 主库存在且结构可读 ⇒ 持久 `established`；
- 主库存在但不可读 ⇒ 持久 `unknown` 并撤销任何 pristine 许可；
- 主库缺失 ⇒ 不写任何许可；没有行仍是 `unknown`，已有 `pristine` 保留。

**执行路径：** `ImportWorker.create()` 只**读取** `firstEmptyPermit()`，绝不创建；`run()` 首先 `markScopeWriterEntered()`（失败即 `recovery_required`，不写主库、不发布终态、不清理来源），创建/观察到主库后 `markScopeDatasetEstablished()`。`pristine` 一旦被写者进入、数据集建立或显式不可读观察撤销，不得因进程重启、文件暂时缺失或 `runtime.sqlite` 隔离重建而复活。

**受控初始化：** `npm run data:init-scope`（`apps/api/src/import-scope-cli.ts`）默认**只读检查**并输出配置 epoch、持久 epoch、scope、许可来源与删库阶段；`--apply --fresh-install` 仅在没有主库、没有删库记录、scope 无任何持久证据时写入一次 `pristine`；`--apply --deletion-id <id>` 只复用已记录的删库操作，不创建第二个 epoch。主库已存在时一律拒绝。显式删除成功并切换 dataset epoch 后，只为记录中的 `nextEpoch` 写入同一 `deletionId` 的许可；恢复旧库则收口删库意图并把最终 scope 登记为 `established`。旧 scope 的证据保持原样。

### 7.3 删库操作日志（`<rai.sqlite>.dataset-epoch.sqlite` → `dataset_deletion`）

删库跨“epoch 侧车 / 文件删除 / runtime 账本”三个持久状态，不能当成单事务。侧车在同一个 SQLite 事务里持久一条 `dataset_deletion`：

| 字段 | 含义 |
|---|---|
| `version` / `deletionId` | 新记录为 **v3**；记录版本与本次操作身份；所有阶段转移按 `deletionId` 做 CAS |
| `serverId` / `athleteId` | v3 必填：把删除日志绑定到唯一部署命名空间。读取时严格比较；v1/v2 记录仍可诊断/回滚未开始的删除，但**不得**据以签发或消费许可（需明确迁移或人工恢复） |
| `configuredEpoch` / `previousEpoch` / `nextEpoch` | 配置身份、删除前 epoch、删除后 epoch；`nextEpoch` 是唯一允许签发许可的 scope |
| `protectionSnapshot` / `protectionKind` | `DatabaseMaintenance.deleteDatabase()` 的保护快照与目录（backup/quarantine） |
| `protectionFiles` | v2 保护快照文件集（主文件及隔离时的 WAL/SHM）的大小和 SHA-256；恢复前逐项复核字节与文件集 |
| `runtimeInstanceId` | 删除时 runtime 账本的稳定实例标识；账本损坏被隔离重建后不得自动重签许可 |
| `stage` / `createdAt` / `updatedAt` | 单调阶段与审计时间 |

阶段只能前进：`prepared → main_removed → permit_issued → writer_entered`；未消费的意图以 `rolled_back` 收口，已进入写者且随后显式恢复备份的意图以 `superseded` 收口。`prepared` 在保护快照完成字节绑定、可恢复备份通过 SQLite 完整性检查、删除主库**之前**持久化；主库/WAL/SHM 移除且目录 fsync 完成后才写 `main_removed`；`RuntimeStateStore.establishDeletionPermit(scope, deletionId)` 成功后写 `permit_issued`；首次写者先写 runtime 账本 `writer_entered`，再写侧车 `writer_entered`，两者成功后才允许创建主库。旧 v1 记录没有摘要：备份须通过 SQLite 完整性检查才可继续，隔离快照保持阻断。

| 启动观察 | 裁决 |
|---|---|
| `prepared` + 主库可读 + 主库 epoch 等于 `previousEpoch` | 回滚意图、侧车 epoch 恢复旧值，旧 scope 登记 `established`；不签许可 |
| `prepared` + 主库可读但 epoch 不等于 `previousEpoch` | **阻断**：不得以旧 epoch 或 `nextEpoch` 继续提供数据；只开放诊断与显式备份恢复入口 |
| `prepared` + 主库缺失 | **阻断**：文件缺失不是删除完成证明；保持 `recovery_required`，运维恢复快照或显式 `--confirm-main-removed` 后完成。阻断本身**不撤销**任何已有许可（P1-2） |
| `main_removed` + 主库缺失 + 同源账本且未进入写者 | 幂等补写**同一** `deletionId` 的 `nextEpoch` 许可并推进 `permit_issued`；已是同一许可则视为重放成功 |
| `permit_issued` + 主库缺失 | 只验证删除 ID、完整 scope、账本实例与未消费原许可；**不要求保护快照仍存在**（P2-2：快照此时已完成使命，轮换/移走不应撤销有效许可）。许可缺失/已被消费/账本实例不符时阻断，**不生成新代次** |
| `writer_entered` + 主库缺失 | 阻断；runtime 账本损坏/丢失后也不得获得新 `pristine`、不得建新空库 |
| `main_removed` / `permit_issued` + 可读主库重新出现且显式 epoch = `previousEpoch` + 保护快照字节身份匹配 | 不签许可；回滚删除意图、侧车 epoch 恢复旧值并登记旧 scope `established` |
| `main_removed` / `permit_issued` + 可读主库为其他 epoch | **阻断**：无持久恢复意图的“可读且 epoch 不同”不是回滚成功；保持 `recovery_required`，不撤销许可、不关闭日志。只有绑定删除 ID、备份字节与预定 epoch 的 `committed` 恢复意图可将其收口 |
| `writer_entered` / 已收口阶段 + 可读主库 | 主库 epoch 等于 `nextEpoch`（或已收口侧车 epoch）时登记 `established`；出现其他 epoch 时，只有匹配的 `committed` 恢复意图可收口为 `superseded`，否则阻断 |
| 侧车损坏、配置 epoch 不匹配、快照暂时缺失、账本实例不符、写账本失败 | CLI/启动明确诊断并非零退出/拒绝启动；不写主库、不发布终态、不清理来源。除“主库实际存在且经检查不可读”外，启动阻断**不得**写 `unknown` 或撤销许可；持久日志保证下次启动重新裁决 |
| `writer_entered` + 主库缺失（建库前崩溃） | 阻断且不自动建库；`data:init-scope --apply --abandon-and-create-new-epoch --confirm-abandon <epoch> --reason <text>` 记录旧 scope `abandoned`、生成全新 epoch 与一次性许可；旧任务标 `superseded`（结果未核实），绝不伪造成 `failed` |
| `prepared` + 主库存在但不可读 | 除显式备份恢复外，只能 `--apply --quarantine-unreadable-main --deletion-id <id> --confirm-quarantine`：核验保护字节、隔离原文件并留下 manifest 后才推进 `main_removed` |

启动时若删库裁决为 `recovery_required`，API 只允许健康状态、运行状态、备份列举/下载与显式备份恢复等诊断恢复入口；业务读写、导入与后台任务均不得访问主库。CLI 与启动裁决共用 `deletionPermitProblem()`：`permit_issued` 只校验账本里仍存在且未消费的原许可，缺失时退出非零，绝不重签。`--fresh-install` 在受控锁下重新扫描主库/侧车/runtime/corrupt/任务历史，任何历史证据（或构造器刚隔离过损坏账本）都拒绝。显式恢复旧备份后侧车写入最终恢复 epoch，`superseded` 记录不会再把旧 `nextEpoch` 当成当前 scope。

显式备份恢复在替换主库前把 `version: 2` 恢复意图写入 `<db>.restore-journal.sqlite`，绑定 `deletionId`、备份名/大小/SHA-256、`plannedEpoch`、`configuredEpoch` 与部署身份；主库 checkpoint/fsync 后才写 `committed` 阶段和主库 SHA-256。sidecar、scope 与发布意图全部收口后才清除该意图；启动只依据这份意图和主库校验结果重放，不从“可读且 epoch 不同”推断恢复成功。

**迁移与回滚：** 旧 `runtime.sqlite` 没有该表／该 scope 行属于 `unknown`；旧版“入队即写 `first_empty_epoch=1`”的行在迁移时降为 `unknown`，绝不补写 `pristine`。旧代码忽略新表可以回滚，但回滚后再升级必须重新核对主库和账本；不得手工清空旧 scope 证据来获得首空许可。

## 8. 边界、时间与 epoch

- **data-only：** XML ≤ 2 MiB、Record ≤ 5000；白名单外类型、Workout、路线、未知类型直接拒收。
- **direct-sync：** XML ≤ 8 MiB、GPX 文件数 ≤ 200、GPX 合计 ≤ 64 MiB；`directSyncBounds.maxRecords=5000` **只约束删除配额**（`manifest.deletedRecords + deletedWorkoutIds`），**不约束 XML `<Record>` 条数**（`packages/api-contracts/src/index.ts` 明确说明；iOS `DirectSyncBatchBudget` 允许到 12,000 条）。manifest 与删除列表限制见 `direct-sync-ingest.ts` 的 `DIRECT_SYNC_MAX_*`。服务端用严格 `>`，恰好等于上限必须接收。
  - **阶段 3 方案勘误：** 计划 §4.3/T14 写的"direct-sync Record ≤ 5000"与现行产品合同冲突。本阶段按真实合同执行，**没有**收紧 XML 记录条数（否则会拒掉 iOS 合法批次）；证据见 `TEST_MATRIX.md` T14 与 `direct-sync-ingest.test.ts` 的 9000 条 2–8 MiB 用例。
- **摘要：** 覆盖实际 XML、manifest、GPX 与解析器身份；同大小、同 mtime、不同内容必须区分。
- **删除：** 显式删除与“载荷没有出现”分开；`preserveAbsent` 语义保留；批次缺失不得隐式整库删除。
- **路线：** `preserveAbsent` 下载荷**显式出现**的路径是权威归属；与旧 route 行同路径冲突时复用旧行 id 改归新训练，保留已发布点/指纹/版本；归属变化由事务内实际 UPDATE 观察器捕获，旧、新归属都进入 `routeDirtyTimes`（不依赖本批是否附带 GPX）。同批同一路径第二次归属变更确定性拒收。
- **时间：** dirty 计算使用规范化 ISO 时刻与 `DATABASE_TIMEZONE` 的本地日期；旧／新时间、路线旧／新归属、恢复旧夜都要覆盖。
- **epoch／scope：** 变化后旧 scope 的任务、no-op anchor、发布结果不得当作新数据集完成证据。

## 9. 当前未决／不在本阶段

- 五类存储的全局备份、恢复与所有权重构属于阶段 4。
- 生产导入、全量重算、压测、故障注入、VACUUM、迁移、部署均不在本阶段授权内。
- 未新增 schema 版本；本阶段默认不改变 v47 或历史迁移校验和。
