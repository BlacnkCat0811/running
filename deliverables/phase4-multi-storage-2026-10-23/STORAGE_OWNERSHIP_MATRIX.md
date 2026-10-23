# 阶段 4 存储所有权与恢复矩阵

**基线：** `/Users/ta/running`，`main`，HEAD `36d79a95f42f854d54e7dfb91e27eb21152a1fa1`（2026-10-23）。
**性质：** 当前工作树的**可执行事实清单**；表名/列名来自当前 HEAD 的 schema dump，写者来自源码符号。它不是新的产品规范；与源码冲突时以源码和可执行测试为准。
**证据口径：** E1 = 当前源码/schema；E2 = 本次在隔离临时目录执行并核对；E3 = 仅推断/未执行。

## 0. 结论摘要

- 同一恢复边界内有**五类持久 SQLite**：主库、控制库、runtime 库、dataset epoch 侧车、restore journal 侧车。restore journal 在正常运行时**不存在**；epoch 侧车在正常首次安装也可能不存在。两者都**不能**并进 runtime 库。
- 当前 HEAD 的主库 schema：`schema_migrations` 最新 **v47**（47 条 migration，checksum 冻结）；控制库 `mobile_control_schema` **v1–v2**；runtime 库**无版本表**，只有启动期幂等 DDL；两侧车**无版本表**，身份在 JSON payload 的 `version/configuredEpoch/epoch/phase` 字段里。
- 主库 71 张表 / 8 个视图；控制库 10 张表；runtime 8 张表；epoch 侧车 2 张表；restore journal 1 张表。逐表所有权见 §2–§5。
- 已证实的文档偏差（四库口径）已在本轮修正：`docs/ARCHITECTURE.md` §4、`docs/DATA_PIPELINE.md` §8/§9、`docs/OPERATIONS.md` 迁移表、`deploy/README-UBUNTU.md` 数据目录、`README.md`、`deploy/rai.env.example`。
- 已证实的路径前提（F3）：`deploy/backup-runtime.sh` 只归档 runtime 根；本轮新增 `scripts/check-runtime-backup-paths.mjs` 做路径闭包检查，外置主库/控制库/侧车时**拒绝备份**，并把 manifest 写进归档（见 [BACKUP_RESTORE_REHEARSAL](BACKUP_RESTORE_REHEARSAL.md)）。

## 1. 五类物理存储

| # | 存储 | 路径规则 | 版本识别 | 正常是否存在 | 写入者 | 丢失/不一致的裁决 |
|---|---|---|---|---|---|---|
| S1 | 主健康库 | `RAI_DATABASE`（代码默认 `<projectRoot>/var/rai.sqlite`；生产 env 必须显式设为 `<runtime>/var/rai.sqlite`） | `schema_migrations`（`MIGRATION_VERSIONS`，v47；冻结 checksum） | 是（部署实例） | API 请求/worker；`data:migrate`、`data:import`、`data:recompute` 等 CLI（持主库 publication lock） | 回执不可读不得推断“未提交”；候选 run 不得成为 active；旧库替换必须使读连接失效 |
| S2 | 控制库 | `RAI_CONTROL_DATABASE`（默认 `<runtime>/var/rai-control.sqlite`） | `mobile_control_schema`（v1–v2，仅加表） | 是 | API 主线程；`migrate-training-planner --apply`（持控制库 lock） | 不能从主库恢复推断控制库也回退；跨库发布变化重试或 503；数据迁移保留 revision/来源摘要 |
| S3 | runtime 库 | `<RAI_RUNTIME_ROOT>/var/runtime.sqlite` | 无版本表；`runtime_meta['rai.runtime-instance-id']` + 幂等 DDL | 是 | API 主线程/导入 worker/各 worker 状态写入 | 账本损坏/重建不能重新签发 `pristine`；已提交主库回执优先；来源在结果未核实时保留 |
| S4 | dataset epoch 侧车 | `<RAI_DATABASE>.dataset-epoch.sqlite` | 无版本表；`dataset_epoch.payload` / `dataset_deletion.payload` 的 JSON `version`（删库记录 v1/v2/v3） | 否（首次安装/无删库/无恢复时可 absent） | 删库、恢复、放弃作用域、旧库回填 | 缺失/损坏/身份冲突不能猜新 epoch；旧 sync anchor/缓存不得跨 epoch 复用 |
| S5 | restore journal 侧车 | `<RAI_DATABASE>.restore-journal.sqlite` | 无版本表；`restore_intent.payload` 的 JSON `version`（legacy / v2 bound） | 否（只有恢复未收口时存在） | 只由 `DatabaseMaintenance` 恢复流程写入 | `committed` 但元数据未收口时重启重放；不匹配/不可读保持 `recovery_required`；空文件≠不存在 |

**WAL/SHM：** S1–S5 每个文件都可能出现 `<path>-wal` / `<path>-shm`。活跃 WAL 不能只 `cp` 主文件；冷备必须在停写窗口归档整个根（含侧车），单库恢复必须先 checkpoint。锁文件（`*.import.lock`、`*.import.lock.stale.*`、`var/import-scope-init.lock`）是**协调证据**，不是数据权威，也不能把 tar 中残留的 PID 当作恢复授权。

## 2. 主库（S1）逐表矩阵

写者缩写：**IMP** = data-only/direct-sync 导入事务（`applyDataOnlyImport` / `applyDirectSyncImport`）；**AN** = 分析发布事务（`RecomputeJobRepository.complete` 内 `beforeComplete`）；**USR** = 用户写路由（override/privacy/performance/profile 等）；**PRED** = 预测模型训练/激活；**DER** = 可重建的派生维护（recompute/backfill）；**SCH** = 显式迁移；**REC** = 恢复/删库路径。
权威列：**A** = 权威状态（丢失不可由本仓材料重造）；**D** = 可由上游事实重算的派生；**L** = 审计/历史；**C** = 协调/指针。

| 表 | 权威 | 写者与事务 | 恢复动作 |
|---|---|---|---|
| `schema_migrations` | A | SCH：`data:migrate --apply`，每版本一个事务 | 保留原版本；旧库先迁移到 v47 再启动；不得删表/改 checksum |
| `import_manifest` | A | IMP/AN/REC：receipt、`dataset_version`、anchor、`rai.dataset-epoch` 同事务 | 回执按 job id 保留；缺失/不可读时按恢复阻断；epoch 行与 S4 对账 |
| `import_batches` | A | IMP：批次成功/失败摘要与代次 | 保留；与 runtime job、receipt 对账；不得用空库重签 |
| `import_batch_files` | A | IMP：上传文件清单/哈希 | 随批次保留；来源文件缺失时标记不可重建 |
| `import_batch_partitions` | A | IMP：分批回执 | 随批次保留；部分批次按回执裁决 |
| `import_entity_changes` | A | IMP：事实变更账本 | 保留；用于重放/审计与脏证据 |
| `import_entity_generations` | A | IMP：实体代次/内容哈希 | 保留；丢失会使去重与覆盖判据失效 |
| `import_entity_tombstones` | A | IMP：实体删除墓碑 | 保留；不得因恢复旧库复活已删实体 |
| `import_fact_history` | L | IMP：事实历史版本 | 随主库保留；只读审计 |
| `import_generations` | A | IMP：raw/dependency 单调代次（单行） | 保留；发布判据 `dependencyCoverageHolds` 的输入 |
| `import_issues` | L | IMP/审计：导入问题 | 可重建但仅作诊断 |
| `import_source_tombstones` | A | IMP：来源级删除 | 保留；影响后续同来源导入 |
| `health_records` | A | IMP：原始健康事实 | 权威；来源 ZIP 被清理后不可重建 |
| `healthkit_record_aliases` | A | IMP：HealthKit 样本 UUID → 记录 | 保留；丢失会导致重复导入 |
| `healthkit_record_facts` | A | IMP：原始记录 JSON/哈希 | 保留；与 aliases/sources 同事务 |
| `healthkit_record_sources` | A | IMP：记录来源映射 | 保留 |
| `workouts` | A | IMP：训练事实 | 权威；不可由统计行反推 |
| `workout_statistics` | A | IMP：训练统计 | 随 workout 保留 |
| `workout_events` | A | IMP：训练事件 | 随 workout 保留 |
| `workout_routes` | A | IMP：路线元数据/文件指针 | 与 `var/imports` 路线文件同边界 |
| `route_points` | A | IMP：旧路线点（v43 前形态） | 保留；可读入口是 `readable_route_points` 视图 |
| `route_versions` | A | IMP：路线版本 | 保留；与 `route_version_points` 绑定 |
| `route_version_points` | A | IMP：已发布路线点 | 保留；与版本表一起恢复 |
| `route_file_fingerprints` | A | IMP：路线文件身份 | 保留；防止重复/错配 |
| `training_sessions` | A | IMP/USR：训练身份与覆盖归属 | 保留；canonical 映射不可由 workout 单表重造 |
| `workout_overrides` | A | USR：用户覆盖（revision 历史） | 权威；发布门禁读取 `effective_workout_overrides` |
| `workout_groups` / `workout_group_members` | A | IMP/USR：训练分组 | 保留；组关系丢失会改变去重 |
| `activity_summaries` | D | IMP：日汇总 | 可由 `health_records` 重建（需同来源/时区） |
| `canonical_nights` | D | DER：睡眠 canonical 化 | 可由睡眠记录 + `backfill-canonical-nights` 重建 |
| `canonical_hrv_days` | D | DER：HRV 日聚合 | 同上 |
| `profile` | A | USR：用户资料 | 权威；恢复后身份需与 `serverId/athleteId` 核对 |
| `privacy_zones` / `privacy_zone_revisions` | A | USR：隐私区及历史 | 权威；恢复不得回退已确认修订 |
| `performance_entries` | A | USR：手工比赛成绩 | 权威；不可由健康数据重造 |
| `training_zone_profile_settings` | A | USR：分区设置 | 权威 |
| `feature_runs` | D | AN/DER：特征 run 元数据 | 可由事实 + 配置重算；`status` 与输入绑定需一致 |
| `workout_features` | D | DER：特征行 | 重算可重建 |
| `model_runs` | D | AN/DER：候选/历史 run | 可重算；但 active 指针引用的 run 必须保留 |
| `model_v2_runs` | D | AN：lineage | 与 bundle 同事务；active bundle 的 lineage 不可丢 |
| `model_domain_snapshots` | A | AN：不可变域快照（触发器保护） | active bundle 的快照必须保留；丢失则 bundle 不可验证 |
| `model_release_bundles` | A | AN：发布门禁/激活时间 | active/候选 bundle 保留；`activated_at` 是回滚授权 |
| `model_release_refusals` | L | AN：拒绝审计 | 可保留；不参与恢复 |
| `model_validation_gates` | L | AN/PRED：门禁结果 | 可保留；诊断 |
| `active_model_run` | C | AN：发布事务内翻转 | 单一指针；恢复后必须指向通过 gate 的 run |
| `active_model_release` | C | AN：发布事务内翻转 | 与 `active_model_run` 同事务；不得只恢复一个 |
| `active_prediction_model` | C | PRED：预测模型激活 | 与 `prediction_model_runs` 工件同边界 |
| `model_checkpoints` | D | DER：可复用检查点 | 可重算；丢失只影响性能 |
| `training_metric_runs` | D | AN/DER：负荷/分区结果 run | 可重算；active 指针引用时保留 |
| `training_metric_checkpoints` | D | DER：指标检查点 | 可重算 |
| `daily_training_metrics` | D | DER：日负荷/状态 | 可重算 |
| `daily_zone_profiles` | D | DER：日分区 | 可重算 |
| `ability_assessments` | D | AN：能力评估 | 可重算；与 `daily_ability_snapshots` 同 run |
| `daily_ability_snapshots` | D | AN：日能力 | 可重算 |
| `baseline_rebase_reviews` | L | AN：基线重设审查 | 历史证据；不自动重建 |
| `recompute_jobs` | A | AN/IMP：持久任务队列与终态 | 权威；重启按它恢复/重排；不得以“队列空”推断成功 |
| `recompute_job_events` | L | AN：任务事件 | 诊断；随 job 保留 |
| `recompute_validations` | L | AN：验证结果 | 诊断 |
| `analysis_job_coverage` | A | AN：执行覆盖证据（发布绑定） | active run 的覆盖证据必须保留；丢失则发布判据退化 |
| `analysis_job_merges` | A | AN：任务合并/结算状态 | 保留；与 job 一起恢复 |
| `analysis_run_input_bindings` | A | AN：候选输入绑定 | active run 必须保留；`verifyAndPoint` 的依赖判据 |
| `prediction_model_runs` | A | PRED：预测模型 run 元数据 | 与 `var/model-artifacts/prediction/*` 同边界 |
| `prediction_model_events` | L | PRED：事件审计 | 诊断 |
| `prediction_calibration_artifacts` | D | PRED/DER：校准工件元数据 | 可由标签重训；active 模型的工件必须保留 |
| `prediction_label_state` | D | DER：标签状态 | 可重算 |
| `coach_fact_operations` | A | USR/command：幂等回执 | 保留；重复请求返回原结果 |
| `coach_feedback_revisions` | A | USR：主观反馈历史 | 权威；不可由健康数据重造 |
| `coach_prediction_summaries` | D | AN/DER：预测摘要 | 可重算 |
| `entity_inventory` | L | DER：实体盘点 | 可重建 |
| `workout_training_loads` | D | DER：训练负荷 | 可重算 |
| `workout_zone_summaries` | D | DER：训练分区 | 可重算 |

**视图（8 个，只读派生，不单独恢复）：** `active_ability_assessments`、`active_daily_ability_snapshots`、`active_daily_training_metrics`、`active_daily_zone_profiles`、`active_workout_training_loads`、`active_workout_zone_summaries`、`effective_workout_overrides`、`readable_route_points`。视图由当前 schema 重建；旧库没有视图时以迁移 v43/v47 等补齐。

## 3. 控制库（S2）逐表矩阵

| 表 | 权威 | 写者与事务 | 恢复动作 |
|---|---|---|---|
| `mobile_control_schema` | A | API 启动 `ensureControlSchema`，每版本一个 `BEGIN IMMEDIATE` | 只增不删；旧库缺 v2 时启动幂等追加 |
| `mobile_training_state` | A | `TrainingPlanStore`/`MobileGoalsStore` 写事务；`withPublicationTransaction` 外层 guard | 计划当前状态；恢复后 revision 必须可解释 |
| `mobile_training_state_history` | A | 同上：每次状态转移同事务追加 | 历史；只增不删 |
| `mobile_training_migration_audit` | L | `migrate-training-planner --apply` 同事务写 | 迁移来源/结果摘要；重放幂等 |
| `mobile_goals` | A | legacy 单行；旧写路由 410 后只由迁移/读取维护 | 保留；v2 迁移的来源 |
| `mobile_goals_history` | L | 旧版 goals 变更历史 | 保留；只读 |
| `mobile_plan_pushes` | A | `/v1/mobile/lock`、`/synced` 等排期回执 | 保留；scope/idempotency 唯一索引 |
| `mobile_plan_operations` | A | 发布操作幂等结果（`publicationOperation`） | 保留；恢复后旧 operation id 不得在新 epoch 重放 |
| `mobile_coach_loop_receipts` | A | coach-loop 运行回执（append-only） | 保留；决定 legacy 读是否 409 |
| `mobile_publication_guard` | C | `beginPublicationGuard`/`endPublicationGuard`；启动清 stale marker | 单行 epoch 单调；恢复时保留 epoch 以便读端检测跨库变化 |

控制库没有独立的数据迁移 CLI 之外的写者；`migrate-training-planner --apply` 只开该库，取 `<control>.import.lock`，与 API 的控制库锁互斥（见 [CONSISTENCY_WINDOWS](CONSISTENCY_WINDOWS.md) §2.7）。

## 4. runtime 库（S3）逐表矩阵

| 表 | 权威 | 写者与事务 | 恢复动作 |
|---|---|---|---|
| `runtime_meta` | A | `RuntimeStateStore.initialize`：`rai.runtime-instance-id` 单行（`INSERT OR IGNORE`） | 实例身份必须随库保留；重建空账本 = 新实例，旧删库记录不得匹配 |
| `import_sources` | A | 上传/来源登记、`migrateLegacySources` | 来源记录；与 `var/imports/<id>/` 同边界 |
| `import_jobs` | A | `ImportWorker` 准入/终态；`upsertJob`/`finalizeImportJob` | 作业状态；启动按主库回执裁决 queued/running |
| `import_publications` | C | `ImportPublicationJournal.prepare/commit/clear`（旧 CLI 文件换库意图） | 恢复时 `supersedeWithRestore`；不得当作当前主库冲突 |
| `import_publication_supersessions` | L | 恢复提交后同事务写 | 旧发布意图的取代记录；只增不删 |
| `import_scope_evidence` | A | `establishPristineScope`/`markScopeWriterEntered`/`markScopeDatasetEstablished`/删库许可 | 首次安装/写者进入/数据集建立的唯一持久证据；损坏不得补写 `pristine` |
| `scope_abandonments` | L | `abandonWriterEnteredScope` 同事务 | 旧 scope → 新 epoch 的运维决定；只增不删 |
| `mutation_commands` | A | `CommandQueue`：命令幂等/终态 | 保留；重启按状态恢复 |

## 5. 侧车（S4/S5）矩阵

| 存储 | 表 | 权威 | 写者 | 恢复动作 |
|---|---|---|---|---|
| epoch 侧车 | `dataset_epoch` | A | `writeSidecarDatasetEpoch`/`advanceSidecarDatasetEpoch`，`BEGIN IMMEDIATE` 比较后写 | 与主库 `rai.dataset-epoch` 对账；缺失=可回退 configured epoch；有表无行=失败关闭 |
| epoch 侧车 | `dataset_deletion` | A | `beginDeletionOperation`/`advanceDeletionOperation`/`closeDeletionOperation` | 阶段单调 `prepared→main_removed→permit_issued→writer_entered`；记录 `deletionId/nextEpoch/保护快照/runtime 实例` |
| restore journal | `restore_intent` | A | `RestoreJournal.write`：`prepared→installed→committed` | `committed` + bound v2：核对 `mainSha256`/planned epoch 后重放 sidecar/scope/publication 收口；legacy committed 只能人工 |

## 6. 跨库/跨文件存储边（两个端点 + 冲突裁决）

| 边 | 端点 A | 端点 B | 冲突裁决 |
|---|---|---|---|
| 导入回执 | 主库 `import_manifest` key `rai.applied-import.<jobId>` | runtime `import_jobs.id` | 回执存在 ⇒ 已提交；回执缺失但库不可读 ⇒ `recovery_required`，不判失败 |
| 导入发布意图 | runtime `import_publications.id` | 主库文件路径/`rollbackPath` | 重启按 `phase` 重放；恢复提交后 `supersedeWithRestore` |
| 分析任务 | 主库 `recompute_jobs.id` | 主库 `import_manifest` 回执 `analysisJobId` | 同库事务；任务存在与回执同提交，重复请求按 job id 幂等 |
| 模型 active | 主库 `active_model_run.model_run_id` | 主库 `model_release_bundles.model_run_id` | 同一发布事务；一个不动则另一个也不动（T04） |
| 计划 revision | 控制库 `mobile_training_state.revision` | 控制库 `mobile_training_state_history` | 同库事务 + CAS；读端 digest/guard 检测混合 |
| 计划操作幂等 | 控制库 `mobile_plan_operations(scope,operation_id)` | 控制库 `mobile_training_state` revision | 原 operation id 只能在原 scope/epoch 重放；跨域拒绝 |
| 删库许可 | sidecar `dataset_deletion.deletionId/nextEpoch` | runtime `import_scope_evidence.permit_source='explicit_database_delete:<id>'` | 许可最多消费一次；实例/字节不符 ⇒ 不重签 |
| 数据集 epoch | 主库 `import_manifest['rai.dataset-epoch']` | sidecar `dataset_epoch.payload` | 不一致/不可读 ⇒ `recovery_required`；禁止猜 |
| 恢复意图 | journal `restore_intent.backupName/backupSha256` | `var/backups/<name>`（或 quarantine） | 字节/大小不符 ⇒ 不安装；保留 journal |
| 恢复 epoch | journal `plannedEpoch` | 主库写入的 epoch + sidecar | `committed` 后核对三者；不匹配 ⇒ 阻断 |
| 来源文件 | runtime `import_sources.input_path/original_path` | `var/imports/<id>/source.zip` + `extracted/` | 结果未核实时保留；清理只能由带终态确认的作业触发 |
| 预测工件 | 主库 `prediction_model_runs.artifact_path` | `var/model-artifacts/prediction/*` | 工件缺失 ⇒ 模型不可激活；备份必须同边界 |
| 迁移备份 | `schema_migrations` 版本 | `<main>/backups/*.before-vN.*.sqlite` | 备份是迁移回退点；不能当成当前数据 |

## 7. 文件级清单（非 SQLite）

| 路径 | 内容 | 权威性 | 恢复动作/备注 |
|---|---|---|---|
| `var/imports/<upload_id>/source.zip` | 上传的原始 ZIP | A（来源证据） | 与 `import_sources` 同边界；已终态且确认后可清理 |
| `var/imports/<upload_id>/extracted/export.xml`、`workout-routes/` | 解压后的导入输入 | A（当次导入） | 导入任务未终态时不可清理；路线文件与 `workout_routes` 指针绑定 |
| `var/imports/sources.json` | 旧版来源元数据 | L（已迁移） | 启动 `migrateLegacySources` 后以 runtime 表为准；保留作证据 |
| `var/reports/*` | `data:audit` 等生成的报告 | D | 可重建；不参与恢复正确性 |
| `var/model-artifacts/prediction/*` | 预测模型/校准工件 | A | 与 `prediction_model_runs` 同边界；丢失的 active 模型不可用 |
| `var/backups/*.sqlite` | `before-delete`/`before-restore` 安全快照、手工备份 | A | **不是可再生缓存**；保留策略 `RAI_BACKUP_*` 不得把它当普通缓存清理 |
| `var/backups/*.before-vN.*.sqlite` | 主库迁移前备份 | A（回退点） | 与主库同等级保护 |
| `var/quarantine/*` | 损坏主库/WAL/SHM 组、保护快照 | A（现场证据） | 可能是唯一可回退点；不得自动删除；恢复前核字节 |
| `<main>.import.lock` / `.stale.*` / `.candidate.*` | publication lock 协调记录 | C | 不是数据权威；stale 回收按 PID/进程身份规则 |
| `var/import-scope-init.lock` | 作用域初始化锁 | C | 与主库锁顺序：主库 → 初始化锁 |
| `*.restoring.*` / `*.partial-*` | 恢复/备份临时文件 | 临时 | 失败清理；不得当成正式库 |
| `<control>.import.lock` | 控制库 publication lock | C | 阶段 4 新增；API 在线持有，planner apply 互斥 |

**路径闭包规则（复核 R1/R2）：** `var/imports`、`var/model-artifacts/prediction`、`var/backups`、`var/quarantine` 中的 A 级文件必须能以归档内的普通文件条目恢复。整 runtime 冷备对这些树做递归扫描，**任何符号链接（外部/悬空/根内）都拒绝备份**，并在 `path-manifest.json` v2 的 `inventory` 中记录相对路径、类型、大小和 SHA-256；tar 后再逐项比对归档条目与摘要。`<main>.import.lock` 等锁文件的锁名是数据库文件的**物理身份**（realpath；缺失库用已存在祖先 + 剩余组件），不是调用方的词法拼写；`nlink > 1` 的库文件被拒绝取锁。

## 8. 恢复顺序（整套冷备）

1. 停所有写者（API + CLI），确认无 `*.import.lock` 活主。
2. 归档/解包整个 runtime 根，保留 `-wal`/`-shm`/`-journal` 与 `path-manifest.json`。
3. 对每个实际存在的 SQLite 做 `quick_check`；`absent` 的侧车保持 absent（不要创建空侧车）。
4. 启动 API：先 `recoverInterruptedRestore`，再 `reconcileDatasetDeletionAtStartup`；任何不匹配保持 `recovery_required`。
5. 核对主库 epoch（`rai.dataset-epoch`）与 sidecar；核对 runtime scope 的 `established/pristine`；核对控制库 revision/operation receipt；核对 active run/bundle 与预测工件。
6. 若只恢复**单库**：必须为它生成新 dataset epoch，并显式重裁决其他库/任务；不得声称控制库/runtime 也回到同一时点。

## 9. 未决/阻断项

| 项 | 状态 | 说明 |
|---|---|---|
| 生产实际部署配置 | **未读取** | 本机无生产 `/etc/rai/rai.env`；路径覆盖结论只覆盖模板与隔离环境（E2），不给生产结论 |
| 生产备份是否真的包含五类库 | **未验证** | 需要运维在维护窗口对生产归档跑一次 `path-manifest.json` 核对；本轮只有隔离演练 |
| `PR-06` 控制库 schema registry/checksum | **未实施** | 本阶段只加跨进程锁；控制库仍只有 `mobile_control_schema` 版本表，没有主库级冻结 checksum |
| 外置工件（如自定义 `RAI_RUNTIME_ROOT` 之外的预测目录） | **未支持** | 当前代码只允许 `predictionArtifactRoot` 固定为 runtime 下；若未来可配置，必须扩展 manifest 或拒绝 |
| `restore journal` 旧 legacy committed 记录 | **人工** | 无 planned epoch/mainSha256，无法自动收口；保持 `recovery_required` |

## 10. 机器可复核入口

```bash
# schema/表清单（隔离临时库；不打开生产）
node scripts/check-runtime-backup-paths.mjs --runtime-root <runtime> --json
# 表覆盖核对（71+10+8+2+1；missingFromMatrix 必须为空）
cat deliverables/phase4-multi-storage-2026-10-23/evidence/storage-table-coverage.json
# 单元/行为证据
node --import tsx --test apps/api/test/phase4-storage-locks.test.ts
node --import tsx --test apps/api/test/phase4-model-release-crash.test.ts
```
