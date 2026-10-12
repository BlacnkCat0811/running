# 数据管线与存储合同

入口：[架构](ARCHITECTURE.md)；模型语义：[算法](ALGORITHM.md)；操作：[运维](OPERATIONS.md)。
本文合并旧 parser/database/sleep-HRV/incremental/freshness 草案，源码为最终实现依据，不把过期库统计放在设计文档中。

2026-10-12目标改造（设计，未上线）：[SQLite直接增量同步](SQLITE_DIRECT_SYNC_DESIGN.md)。
用户要求普通同步不再执行项目备份、全库检查、候选主库复制或文件换库；备份由服务器独立运维负责。

## 1. 来源、上传与候选库

[导入worker](../apps/api/src/import-worker.ts) 处理ZIP来源、预检、队列和staging发布。
ZIP先检查路径/大小/数量/重复条目及导出根目录，不能信任文件名、客户端metadata或解压后路径。失败/取消不切主库。
已有库通过SQLite在线backup生成私有候选库；不要直接复制运行中的WAL主库文件。
增量同步依赖entity generation、路由指纹、dirty范围与精确兼容checkpoint。全量shadow已移除；质量gate、身份验证和离线对照仍保留。

## 2. 身份、重复与删除

[稳定身份](../packages/contracts/src/index.ts) 与 [载荷身份](../apps/api/src/import-payload-identity.ts) 分开：

- 训练会话、canonical workout和原始workout不是同一个ID概念；不能为了重导方便重建另一套身份。
- payload摘要包含内容、canonical合同、preserveAbsent语义、引擎name@version和身份算法行为fingerprint。
- 指纹更改必须审查是否有意、是否会触发全量重导；不能直接更新冻结值使红灯消失。
- tombstone、来源删除和override revision是事实，不因重导相同ZIP被复活。
- `created_at`可能是数据源创建时间，不自动等于系统首次收到记录的时间。

## 3. 三种时间不能互换

| 时间 | 用途 |
|---|---|
| observed/event/end time | 健康事实/训练实际发生及结束 |
| available/ingested/computed time | 系统何时有资格使用该版本事实或派生结果 |
| generated/evaluated/asOf | 本次计算或响应的截止/生成时点 |

业务日期按显式时区计算，不靠服务器时区。as_known_then要求事件与可得时间同时满足截止；event_time_reconstruction是另一种语义。
历史缺记录级入库账本不能反填为已知；使用保守上界或availabilityUnknown。快照旧/同步失败/今天没戴表/确实零负荷各自有状态，不合并为“疲劳”。

## 4. 睡眠和HRV事实

[canonicalize-nights](../packages/health-export-parser/src/canonicalize-nights.ts) 产生canonical_nights / canonical_hrv_days；跨夜、午睡、设备来源优先级、区间并集和样本覆盖在此完成。
训练前证据必须已结束且可得；主夜按wake date归属，不能用未来的夜间结果解释早先训练。
重建时内容未变的canonical事实保留原可得时间；被更正的内容使用新可得时间。不能因全量重建把所有旧事实变成“今天才知道”。
[恢复装配](../packages/application/src/model-v2-snapshots.ts) 消费这些事实和个人参考；[readiness](../packages/readiness/src/index.ts) 是规则唯一来源。
历史35/25/25/15恢复加权等兼容字段不代表V4 Fitness仍包含Recovery，也不是新的临床量表。
旧schema有表但没有canonical行时，需显式回填；不要把“迁移建表”当作“历史数据已重新计算”。

## 5. 特征、覆盖与override

原始健康记录/路线 → 训练装配 → V4特征 → eligibility/coverage/comparability → CA/TA及负荷/分区。
速度、心率、路线各用自身覆盖；重复/重叠秒数不能提高可靠性。缺失值是null，不用默认心率/天气填实测。
Override保存修订和可得性。反馈保存之后的重算失败不应撤销已保存反馈；客户端要分别展示两种结果。
对已删训练，旧run可保留作历史证据，新published run不能继续使用其派生贡献。

## 6. 存储与版本

[database](../packages/storage-sqlite/src/database.ts) 定义migrations 1–32；历史migration正文/checksum冻结，不允许原地修改以“修复”旧库。

| 结构 | 责任 |
|---|---|
| health_records / workouts / route_points | 原始、来源和轨迹事实 |
| training_sessions / canonical_nights / canonical_hrv_days | 统一身份、训练与恢复事实 |
| workout_overrides / revision history | 用户覆盖与历史可得版本 |
| feature_runs / model_runs / checkpoints | 特征、引擎/配置与可复用状态 |
| training_metric_runs / daily snapshots | 负荷/分区/日级结果 |
| model_v2_runs / model_domain_snapshots / model_release_bundles | 谱系、不可变快照、完整发布验收 |
| active_model_run / active_model_release | 当前读取的受控指针 |
| prediction_model_runs / calibration artifacts | 残差工件及独立区间证据 |
| baseline_rebase_reviews | prospective检查历史，不自动重建基线 |

当前源码支持不等于任一数据库已经升级。旧数据只读兼容与新writer/migration需一并验证。

## 7. 发布与恢复

数据库文件发布与模型bundle发布是不同层级：前者协调staging替换和read store，后者协调同库中的run/快照/指针。
必须验证generation、预期active、完整快照/hash、模型gate、失败回退、保留依赖和重启后读到同一结果。
回滚窗口有限；已清理工件不可凭指针名“复活”。SQLite backup、runtime/control数据库和工件需按同一维护边界备份。

## 8. 报告

`data:audit` / 导入worker生成的`docs/DATA_AUDIT.md`是运行时聚合报告，已取消Git跟踪；其JSON默认在`var/reports/`。
每份报告必须说明哪份数据库、哪个截止、哪个代码/配置；机器数值不进入长期架构合同。
受控核验证据入口：[deliverables](../deliverables/README.md)。
