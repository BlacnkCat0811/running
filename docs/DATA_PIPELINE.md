# 数据管线与存储合同

维护日期：2026-10-20。本文只记录**现行**数据合同与 as-built 行为；条目来源是源码与生产发布记录，时点审查不算规范。
入口：[架构](ARCHITECTURE.md)；模型语义：[算法](ALGORITHM.md)；运维：[运维](OPERATIONS.md)；实现依据：[SQLite 直接增量同步设计](SQLITE_DIRECT_SYNC_DESIGN.md)。

口径：不把过期库统计写进合同；下面每条「行为」都能在源码或发布记录里找到对应实现。

## 1. 来源、上传与预检

[iOS](../apps/ios/README.md) 把 HealthKit 只读导出的运行相关样本打包为 ZIP，`POST /v1/imports/uploads` 上传；`POST /v1/imports/inspect` 可先做预检（内容未变时服务端直接回答 `unchanged`）。CLI（[health-export-parser CLI](../packages/health-export-parser/src/cli.ts)）提供同源的离线入口。

ZIP 先检查路径、大小、数量、重复条目与导出根目录：不能信任文件名、客户端 metadata 或解压后路径（[import-sources](../apps/api/src/import-sources.ts)）。失败/取消不切换主库，也不产生「半发布」。

## 2. 导入运行时（API）：两条直连车道

[导入 worker](../apps/api/src/import-worker.ts) 在同一个任务 Worker 内按**固定顺序**执行两条车道（顺序是显式数据，worker 侧 fail-closed 校验）：

1. **data-only 快通路**：入口判据更严（记录白名单 + 基线合同戳）。命中时只增量保存原始记录，不需要重算或切换数据库。
2. **direct-sync 统一接收器**：接受 Workout / 评分类型 / 显式删除 / GPX 路线，在一笔**主库事务**里写入事实、路线、导入账本与可持久查询的回执，并由账本决定是否登记分析任务；提交权归调用方。回执的 `analysisStatus`（`queued` / `not_required`）是唯一判据，不看车道、不看载荷形状。
3. **否则 `ImportLaneRefusal`**：带稳定 `failureCode` 的终态失败。**没有候选库回退**，也没有「失败就退回文件换库」的路径。

顺序不能交换：data-only 的判据比统一接收器更严，放到后面会让它的两道闸门失去意义。

失败与恢复：`202 queued` 不等于成功，终态由任务查询给出；回执与事实同事务提交，worker 回复丢失时从回执恢复「已提交成功」。**这条同步链路不做整库备份、不做整库 copy、不生成候选库、不做文件换库、不做全库 `quick_check`**；`PROHIBITED_DIRECT_SYNC_OPERATIONS` 与 `apps/api/test/direct-sync-prohibited-operations.test.ts` 用运行时计数证明这些操作在两条车道上均为 0，而不是只靠 UI 不显示。内容未变的上传走 **no-op 回执**路径：锚点绑定 `dataset_version`，任何后续导入都会让它失效，因此 no-op 也必须落可持久查询的回执。API 两条车道固定 TypeScript 引擎；Rust 可选引擎只属于 CLI 车道（§3）。

## 3. CLI 车道：候选库与文件换库（不同语义）

[CLI](../packages/health-export-parser/src/cli.ts) 仍保留完整离线链路：SQLite 在线 backup 生成私有候选库 → TS/Rust 引擎写入（`--engine` / `RAI_IMPORT_ENGINE`）→ 发布前强校验（对私有候选库跑 `PRAGMA quick_check` + 外键检查）→ 原子换库（`publishDatabaseFile`）→ 安装后轻量结构探针（只证明文件/header/schema 基本可读）→ read store 替换。

它服务离线导入、迁移与运维场景，与 API 运行期是两条不同语义：**API 不做候选库、不做文件换库、不做整库校验**。Rust 热循环的「受限写许可」只在这条链路上成立。

## 4. 身份、重复与删除

[稳定身份](../packages/contracts/src/index.ts) 与 [载荷身份](../apps/api/src/import-payload-identity.ts) 分开：

- 训练会话、canonical workout 和原始 workout 不是同一个 ID 概念；不能为了重导方便重建另一套身份。
- payload 摘要包含内容、canonical 合同、preserveAbsent 语义、引擎 name@version 和身份算法 fingerprint。
- 指纹更改必须审查是否有意、是否会触发全量重导；不能直接更新冻结值使红灯消失。
- tombstone、来源删除和 override revision 是事实，不因重导相同 ZIP 被复活。
- **删除的旧侧证据（P1-3，2026-10-23）**：任何写 `import_entity_changes` 的 `removed` 行都会同时保存 `previous_type / previous_effective_at / previous_end_at`。`effective_at` 只是兼容用的单点时刻；跨夜睡眠/HRV 的旧起点必须来自 `previous_effective_at`，否则删除会退化成"无边界"。历史账本里缺少旧侧的 `removed` 行一律让该批升级为 `full`（`legacy_removal_without_previous_range`），不得被同批另一条有界变更掩盖。
- **历史删除后的夜重建**：无旧侧的删除可能已经移走最后一条睡眠记录。全量夜窗口取剩余健康记录的时间、现有 `canonical_nights.wake_date` 与 `canonical_hrv_days.local_date`，以及可用的删除时刻，再向两侧各扩一天；即使原始记录表已空，也会清掉旧 canonical 行。回执 `from`/`to` 与实际重建窗口一致。
- **值更正取代（supersede，2026-10-18）**：没有 sample UUID 的记录，身份把 value/unit 折进 id，因此「值更正」会表现为一个新实体。`preserveAbsent` 增量会把同一自然键 `(type, source_name, start_at, end_at)` 的旧身份按**删除持久**处理（账本 `removed` + 墓碑 + 删行），而不是让两行共存。这是刻意的方向：上传是 at-least-once，延迟重试的旧批次不能把已更正的值写回去；代价是「值又改回旧值」同样会被墓碑拦住、不会复活。被拦下的数量可通过 `GET /v1/diagnostics` 的 `imports.tombstonedRecords` / `imports.supersededRecords` 观察到（来自 succeeded import_batches 的 `summary_json.xml` 聚合）。
- `created_at` 可能是数据源创建时间，不自动等于系统首次收到记录的时间。

## 5. 三种时间不能互换

| 时间 | 用途 |
|---|---|
| observed/event/end time | 健康事实/训练实际发生及结束 |
| available/ingested/computed time | 系统何时有资格使用该版本事实或派生结果 |
| generated/evaluated/asOf | 本次计算或响应的截止/生成时点 |

业务日期按显式时区计算，不靠服务器时区。as_known_then 要求事件与可得时间同时满足截止；event_time_reconstruction 是另一种语义。
历史缺记录级入库账本不能反填为已知；使用保守上界或 availabilityUnknown。快照旧/同步失败/今天没戴表/确实零负荷各自有状态，不合并为「疲劳」。

## 6. 睡眠和 HRV 事实

[canonicalize-nights](../packages/health-export-parser/src/canonicalize-nights.ts) 产生 canonical_nights / canonical_hrv_days；跨夜、午睡、设备来源优先级、区间并集和样本覆盖在此完成。
训练前证据必须已结束且可得；主夜按 wake date 归属，不能用未来的夜间结果解释早先训练。
重建时内容未变的 canonical 事实保留原可得时间；被更正的内容使用新可得时间。不能因全量重建把所有旧事实变成「今天才知道」。
[恢复装配](../packages/application/src/model-v2-snapshots.ts) 消费这些事实和个人参考；[readiness](../packages/readiness/src/index.ts) 是规则唯一来源。
历史 35/25/25/15 恢复加权等兼容字段不代表 V4 Fitness 仍包含 Recovery，也不是新的临床量表。
旧 schema 有表但没有 canonical 行时，需显式回填；不要把「迁移建表」当作「历史数据已重新计算」。

## 7. 特征、覆盖与 override

原始健康记录/路线 → 训练装配 → V4 特征 → eligibility/coverage/comparability → CA/TA 及负荷/分区。
速度、心率、路线各用自身覆盖；重复/重叠秒数不能提高可靠性。缺失值是 null，不用默认心率/天气填实测。
Override 保存修订和可得性。反馈保存之后的重算失败不应撤销已保存反馈；客户端要分别展示两种结果。
对已删训练，旧 run 可保留作历史证据，新 published run 不能继续使用其派生贡献。

## 8. 四个存储、schema 与版本

[主库](../packages/storage-sqlite/src/database.ts) 的迁移注册表是 schema 版本的**唯一来源**（导出的 `MIGRATION_VERSIONS` / `FROZEN_MIGRATION_CHECKSUMS`；本文**不写死**版本区间或条数，避免随每次新增迁移过期）；历史 migration 正文/checksum 冻结，不允许原地修改以「修复」旧库。

| 存储 | 责任 |
|---|---|
| 主库 `var/rai.sqlite` | 健康事实、训练、覆盖修订、不可变派生 run、发布指针；迁移注册表唯一来源 |
| 控制库 `var/rai-control.sqlite` | 计划状态与历史、发布结果、排期回执；schema 表 `mobile_control_schema` 当前 v2（`mobile_training_state` / `_history` / `_migration_audit` + legacy `mobile_goals`/`_history`、`mobile_plan_pushes`、`mobile_plan_operations`、`mobile_coach_loop_receipts`） |
| 运行时 `var/runtime.sqlite` | 来源/任务状态、导入回执索引与发布 journal |
| epoch 侧车 `var/rai.sqlite.dataset-epoch.sqlite` | dataset epoch 单行 + `dataset_deletion` 阶段日志；独立于可删除的事实库与 runtime 的损坏恢复，损坏/身份不匹配时失败关闭 |

主库表族（语义分组，不是完整清单）：

| 结构 | 责任 |
|---|---|
| health_records / workouts / route_points | 原始、来源和轨迹事实 |
| training_sessions / canonical_nights / canonical_hrv_days | 统一身份、训练与恢复事实 |
| workout_overrides / revision history | 用户覆盖与历史可得版本 |
| feature_runs / model_runs / checkpoints | 特征、引擎/配置与可复用状态 |
| training_metric_runs / daily snapshots | 负荷/分区/日级结果 |
| model_v2_runs / model_domain_snapshots / model_release_bundles | 谱系、不可变快照、完整发布验收（不可变由触发器强制） |
| active_model_run / active_model_release | 当前读取的受控指针 |
| prediction_model_runs / calibration artifacts | 残差工件及独立区间证据 |
| baseline_rebase_reviews | prospective 检查历史，不自动重建基线 |

控制库 schema 用独立版本表 `mobile_control_schema`（加表不改旧行）；v2 迁移脚本见 [migrate-training-planner](../scripts/migrate-training-planner.mts)（默认 dry-run，`--apply` 需 `--expect-source-digest`，只开控制库）。

当前源码支持不等于任一数据库已经升级。旧数据只读兼容与新 writer/migration 需一并验证。

## 9. 发布、恢复与备份边界

API 运行期的「发布」是**同库事务 + 受控指针 + publication guard**：主库与控制库不能原子提交，跨库一致性是 detect + retry（读端看到 guard/epoch 变化则重读，重试用尽返回 `503` + `Retry-After`），不是分布式事务。

文件级替换只发生在恢复与 CLI/运维场景，语义是离线、非事务：

- **恢复**：先校验备份身份，再对 staging 副本跑 `quick_check` + 外键校验，经 restore journal 原子安装，失败回滚，并改变 datasetEpoch；
- **CLI 导入**：候选库由导入流程写出，发布前先做 `quick_check` + 外键检查；通过后 `publishDatabaseFile` 原子换库，安装后再做轻量结构探针，随后 read store 换连接。

两条路径都不在 API 请求路径上。回滚窗口有限，已清理工件不可凭指针名「复活」。

**备份边界**：四个存储（主库、控制库、运行时、epoch 侧车）+ 上传 + 工件属于同一维护边界。应用**不提供备份创建/删除 API**（`POST /v1/backups` 与 `DELETE /v1/backups/:name` 返回 `410`）；但「删除数据集」与「恢复备份」仍各自写 `before-delete` / `before-restore` 安全快照，失败路径不消耗保留槽位。日常一致性备份由运维用 SQLite backup API 或存储快照完成；活跃 WAL 库不能只 `cp`，也不能漏掉 epoch 侧车。

## 10. 报告

`data:audit` / 导入 worker 生成的 `docs/DATA_AUDIT.md` 是运行时聚合报告，已取消 Git 跟踪；其 JSON 默认在 `var/reports/`。
每份报告必须说明哪份数据库、哪个截止、哪个代码/配置；机器数值不进入长期架构合同。
受控核验证据入口：[deliverables](../deliverables/README.md)。
