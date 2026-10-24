# 核验产物

本目录只保留**当前证据**与**固定时点机器证据**，不是第二套产品规范/实施计划。
现行说明统一从 [项目 README](../README.md) 进入；现行状态、未决问题与已收尾批次指针只维护
[项目审查](../docs/PROJECT_REVIEW.md)。

## 1. 当前证据（2026-10-25）

- [GitHub CI 审计与修复](ci-audit-2026-10-25/README.md)：真实运行失败基线、Linux/macOS/iOS 覆盖、Windows Job 退役与本机验证；新修订未推送时不宣称远端通过。

- [阶段 6 性能基线与容量模型](phase6-performance-2026-10-24/PHASE6_REPORT.md)：
  实施 6A 工具链（隔离 runner、安全门禁、D0–D3/DX 夹具、HTTP 驱动、资源采样、离线统计/裁决）并执行 DEV 基线；
  [审查修复记录](phase6-performance-2026-10-24/REVIEW_FIXES_2026-10-24.md)和[当前机器状态](phase6-performance-2026-10-24/CURRENT_STATUS.json)说明原 DEV PASS 属历史代码身份，当前代码待全量重跑；
  无隔离 Linux 目标，CLOUD 容量按文档标 **BLOCKED**。先读 [基线](phase6-performance-2026-10-24/BASELINE.md)、
  [协议](phase6-performance-2026-10-24/protocol.json)、[未关闭项](phase6-performance-2026-10-24/open-items.md) 与
  [源代码身份](phase6-performance-2026-10-24/source-manifest.json)。

- [阶段 5 训练计划 v2 实施与验收](phase5-implementation-2026-10-23/PHASE5_REPORT.md)：
  5A 主要修复与 5B R1–R4 审计修复已落地；当轮回归与边界见 [2026-10-24 修复记录](phase5-implementation-2026-10-23/PHASE5_AUDIT_FIXES_2026-10-24.md)。
  T26 Simulator 部分通过、T27 配对设备未执行、T30 交错升级/回滚部分；生产能力仍关闭。分册：[入口矩阵](phase5-implementation-2026-10-23/ENTRY_MATRIX.md)、
  [命令状态](phase5-implementation-2026-10-23/COMMAND_STATE_MATRIX.md)、
  [所有权矩阵](phase5-implementation-2026-10-23/OWNERSHIP_MATRIX.md)、`phase5-implementation-2026-10-23/evidence/`。
- [阶段 5 训练计划 v2 审查与实施方案](phase5-review-2026-10-23/PHASE5_REVIEW_AND_IMPLEMENTATION_PLAN.md)：
  方案交付；31 项定向 API 回归通过，隔离复现命令 HTTP handler 的幂等重放缺陷。该报告是实施前基线，
  实施结果以上一行的阶段 5 报告为准。

按“每个交付面一份最新记录”保留；被下一版发布或下一轮审查取代后，按下文约定并入
[项目审查](../docs/PROJECT_REVIEW.md) 后删除。

- [阶段 4 多存储与发布一致性实施与验收](phase4-multi-storage-2026-10-23/PHASE4_REPORT.md)：
  按[实施方案](PHASE4_MULTI_STORAGE_PUBLICATION_IMPLEMENTATION_PLAN_2026-10-23.md)完成存储所有权矩阵、
  一致性窗口、T01–T12 故障矩阵、冷备/整套恢复演练与最小修复（五库文档口径、冷备路径闭包、
  控制库跨进程锁）；**停在阶段门，未部署生产**。后续[复核与优化实施方案](phase4-multi-storage-2026-10-23/PHASE4_REVIEW_REMEDIATION_PLAN.md)
  发现锁路径别名、冷备路径闭包与默认路径不一致等发布阻断项；修复批次 A–C 已完成，G2/T11/I1 与 G4/T12/I8
  在隔离环境完成当轮复验（报告 §13；新增 `verify-runtime-backup-archive.mjs` 与 47/47 扩展演练）。
  [二次审查与优化验收方案](phase4-multi-storage-2026-10-23/PHASE4_SECOND_REVIEW_AND_ACCEPTANCE_PLAN.md)
  复现了备份配置覆盖导致的漏库路径及归档校验窗口；N1–N3 已按方案修复，本轮隔离定向测试 41/41、恢复演练 47/47（报告 §14）。生产前人工门仍未完成。分册：
  [所有权矩阵](phase4-multi-storage-2026-10-23/STORAGE_OWNERSHIP_MATRIX.md)、
  [一致性窗口](phase4-multi-storage-2026-10-23/CONSISTENCY_WINDOWS.md)、
  [故障矩阵](phase4-multi-storage-2026-10-23/FAULT_MATRIX.md)、
  [冷备恢复演练](phase4-multi-storage-2026-10-23/BACKUP_RESTORE_REHEARSAL.md)、
  [初验证据](phase4-multi-storage-2026-10-23/evidence/SHA256SUMS)、[复核复验证据](phase4-multi-storage-2026-10-23/evidence/remediation-2026-10-23/SHA256SUMS)、[二次审查修复证据](phase4-multi-storage-2026-10-23/evidence/second-review-2026-10-23/SHA256SUMS)。
- [PHASE3_IMPORT_ANALYSIS_RELEASE_2026-10-23.md](PHASE3_IMPORT_ANALYSIS_RELEASE_2026-10-23.md)：
  阶段 3 发布记录（`d03f4ae`，2026-10-23 部署生产）——发布前冷备、主库无迁移、
  runtime schema 启动维护、健康检查/只读冒烟与回滚边界；**按用户要求未运行测试套件**。
- [IMPORT_RECOVERY_REVIEW_FIX_2026-10-23.md](IMPORT_RECOVERY_REVIEW_FIX_2026-10-23.md)：
  导入恢复审查三项问题修复的验收记录——恢复后任务准入 token、恢复失败的结构化证据与临时冻结、
  放弃旧 scope 的唯一 epoch 重放；含故障注入点与逐条验收映射。
- [IMPORT_RECOVERY_REVIEW_FIX_2_2026-10-23.md](IMPORT_RECOVERY_REVIEW_FIX_2_2026-10-23.md)：
  第二轮只读复审两个问题（可读外来主库误判为删库回滚成功、路线归属冲突依赖 XML 顺序）的
  修复与回归记录；含显式恢复意图的崩溃重放、保护快照身份校验与 A→B/B→A 顺序测试。
- [IMPORT_RECOVERY_REVIEW_FIX_3_2026-10-23.md](IMPORT_RECOVERY_REVIEW_FIX_3_2026-10-23.md)：
  第三轮只读复审五项问题（旧 scope 终态作业永久 pending、prepared 删除窗口阻断自动回滚、
  放弃重试跳过许可校验、失败测试日志生成通过摘要、证据清单漏掉未跟踪文件）的修复与
  定向回归记录。
- [IMPORT_RECOVERY_REVIEW_FIX_4_2026-10-23.md](IMPORT_RECOVERY_REVIEW_FIX_4_2026-10-23.md)：
  第四轮只读复审七项问题（initial rollback 误安装、完成放弃的幂等重试、permit_issued
  快照轮换、存量主库 epoch 回填、RestoreJournal fail-open、abandoned 终态、证据清单
  跨平台路径）的修复与回归记录。
- [阶段 3 复审问题逐项修复实施方案](phase3-import-analysis-2026-10-22/PHASE3_REVIEW_ISSUES_IMPLEMENTATION_PLAN_2026-10-23.md)：
  2026-10-23 当轮复核；列出 P1/P2/P3、验收证据问题的修改位置、实施步骤与完成判据，尚未实施。
- [PHASE3_REPORT.md](phase3-import-analysis-2026-10-22/PHASE3_REPORT.md)：
  阶段 3 实施与复审修复——回执合同 R1/R2、重启恢复四态与作用域首空状态机（P1/R3）、
  T05 未知记录全量兜底、T11 纯 GPX/路线归属/仅 XML 改归属修复、D1 原始 epoch 校准集合
  重映射、T12 真实到达 + 原任务消费的 readiness/Fitness A/B、F01 删除+GPX 同事务确定性屏障、删库任意中断恢复协议、逐域完整业务产物与发布投影差分；配套
  [三项问题修复方案](phase3-import-analysis-2026-10-22/PHASE3_REVIEW_THREE_ISSUES_FIX_PLAN_2026-10-22.md)、
  [剩余两项问题修复方案](phase3-import-analysis-2026-10-22/PHASE3_REVIEW_TWO_REMAINING_ISSUES_FIX_PLAN_2026-10-22.md)、
  [状态合同](phase3-import-analysis-2026-10-22/STATE_CONTRACT.md)、
  [依赖矩阵](phase3-import-analysis-2026-10-22/DEPENDENCY_MATRIX.md)、
  [T/F 测试矩阵](phase3-import-analysis-2026-10-22/TEST_MATRIX.md) 与 `evidence/`；
  **研发验收记录；目标 macOS 主机上总体验收通过（完整 `npm test` exit 0），未部署生产、未进入阶段 4**。
- [PHASE2_SQLITE_RELEASE_2026-10-22.md](PHASE2_SQLITE_RELEASE_2026-10-22.md)：
  阶段 2 发布记录（`9364270`，2026-10-22 部署生产，主健康库 v46 → v47）——发布前冷备、迁移计数、
  部署后健康检查/只读冒烟与代码/数据回滚边界；**按用户要求未运行测试套件**。
- [PHASE2_FOLLOWUP_A_B_C_2026-10-22.md](phase2-followup-2026-10-21/PHASE2_FOLLOWUP_A_B_C_2026-10-22.md)：
  阶段 2 剩余问题 A/B/C——A（assessment 写入 P95 + 自动 checkpoint）、B（外部提交后首次 `/series`，含专属读 worker 与代次隔离）、
  C（请求内 speedTrack 复用）全部通过；热读五窗口已按“可读训练、200、身份与非空内容”修正并重测；
  研发验收记录，生产部署见上方发布记录。
- [PHASE2_SQLITE_QUERY_TRANSACTION_CONNECTION_2026-10-21.md](phase2-sqlite-2026-10-21/PHASE2_SQLITE_QUERY_TRANSACTION_CONNECTION_2026-10-21.md)：
  阶段 2 SQLite 查询/事务/连接优化与验收——隔离 D0–D3 测量、SQL 台账、v47 索引迁移、checkpoint
  返回值语义修复、差分/迁移/回滚证据；研发验收记录，生产部署见上方发布记录。
- [PHASE1_MAIN_THREAD_BLOCKING_2026-10-21.md](PHASE1_MAIN_THREAD_BLOCKING_2026-10-21.md)：
  阶段 1 补修与验收补齐——worker 冷启动关闭、严格回执裁决、真实线程故障回归、可复现源码快照、
  HTTP 5×60 秒锁窗口与 100 批资源证据；满足进入阶段 2 条件（阶段 2 已交付，见上方 PHASE2 记录）。
- [UNIFIED_TRAINING_PLAN_RELEASE_2026-10-20.md](UNIFIED_TRAINING_PLAN_RELEASE_2026-10-20.md)：
  统一训练排课 v2 发布记录（`2f5f2b8`，已部署生产、控制库 `mobile_training_state` 迁移已执行）——
  本机判据、生产 410/v2 读写矩阵、备份与代码/数据回滚边界、已知缺口。
- [UNIFIED_TRAINING_PLAN_VERIFY_2026-10-20.md](UNIFIED_TRAINING_PLAN_VERIFY_2026-10-20.md)：
  统一训练排课方案的真实性核实与 PR1–PR7 落地记录——E01–E15 / F01–F06 逐条结论、四处文档勘误、
  剂量政策 v2、控制库 v2、G01–G03 签收材料（截至 2026-10-20 的实测与测试计数）。
- [IOS_SYNC_RELEASE_2026-10-20.md](IOS_SYNC_RELEASE_2026-10-20.md)：
  iOS 同步 R1–R6 发布记录（`62f490b`，已部署生产、无 schema 迁移）——本机判据、生产实测、
  回滚边界与剩余真机验收项。
- [IOS_DEVICE_LOG_TRIAGE_2026-10-20.md](IOS_DEVICE_LOG_TRIAGE_2026-10-20.md)：
  iOS 真机日志分诊（当轮）——未发现 P0；P1–P3 改进项**尚未实施**，是当前未决证据。
- [IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md](IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md)：
  五项未实施项（B3/B4/B5/B6/C1）的逐项核实与“暂缓 + 触发条件”；B6 已做 P0 止损，其余仍按触发条件保留。
- [SYNC_OPTIMIZATION_EXECUTION_PLAN_2026-10-16.md](SYNC_OPTIMIZATION_EXECUTION_PLAN_2026-10-16.md)：
  同步与计算优化（O01–O12 → 16 工作包）执行锚点；自述“S0+S1 执行中、S2–S5 待排期”，
  仍被两份现行 docs 引用，作为实施锚点暂时保留。
- [plan-remove-web-keep-ios-api.md](plan-remove-web-keep-ios-api.md)：
  Web/macOS 退役的可执行实施文档与执行记录（B0–B5 已执行、云端已上线；回滚锚点与遗留真机项）；
  被 [DECISIONS](../docs/DECISIONS.md) D17 引用。
- [ARCHITECTURE_REVIEW_2026-10-20.md](ARCHITECTURE_REVIEW_2026-10-20.md)：
  全项目架构深度审查（2026-10-20，基线 `9db450f`；4 lane + Lead 复核）——**当前审查证据**，
  分 lane 报告见 [architecture-review-2026-10-20/](architecture-review-2026-10-20/BRIEF.md)。

## 2. 固定时点机器证据（不改写、不删除）

- [project-review-2026-09-30/](project-review-2026-09-30/)：2026-09-30 审查的探针与验证产物——
  `model-boundaries.json`（修复前 3 项违反）、`model-boundaries-after.json`（修复后 0 项）、
  `verification.json`（文档删除/保留映射与来源 hash）、`fixes-verification.json`（四项修复后的回归摘要）。
  说明与修复优先级见 [项目审查 §6](../docs/PROJECT_REVIEW.md)。
- `v2-audit-2026-09-30/`：macOS 本机固定截止的算法实施核验——`baseline.json`（schema22/268 次训练，
  不代表线上）、`normalization.json`（天气覆盖盘点，不是精度）、`walk-forward.json`（零有效标签，
  指标 null 不是准确率 0）、`load-replay.json`、`release-rehearsal.json`、`verification.json`
  （命令/结果/来源 hash；原库前后 hash 未变）。
  这些文件记录生成当时的状态；不要改写历史 hash，也不要把过去结果当作今天重跑过。

## 3. 已收尾批次指针（原文已删除，Git 可恢复）

2026-10-20 文档收敛按“当轮报告在下一轮并入 PROJECT_REVIEW 或删除”的约定，删除了 55 份已收尾批次文档
（`git status` 可见删除；分支历史仍保留全文）。取回单份原文：

```bash
git show <收尾提交>:<原路径>      # 取回全文
git log --follow -- <原路径>      # 定位精确的最后改动提交
```

| 主题 | 收尾提交 | 已删除文档 | 当前事实在哪 |
|---|---|---|---|
| 直接增量同步 PR1–PR6（2026-10-12 ~ 10-15） | `60678af`（PR6）、`9e08301`（尾页根治）、`6ee6b8c`、`63b68c2` 等 | `ACCEPTANCE_INVENTORY_DIRECT_SYNC_2026-10-13`、`DIRECT_SYNC_A10_ANALYSIS_ISOLATION_2026-10-13`、`DIRECT_SYNC_ANALYSIS_WAKE_FIX_2026-10-13`、`DIRECT_SYNC_PR1_2026-10-12`、`DIRECT_SYNC_PR2_PR3_2026-10-12`、`DIRECT_SYNC_PR4_2E_2026-10-13`、`DIRECT_SYNC_PR4_STEP1_2026-10-13`、`DIRECT_SYNC_PR4_STEP2AB_2026-10-13`、`DIRECT_SYNC_PR4_STEP2CD_2026-10-13`、`DIRECT_SYNC_PR4_STEP3_REVISION_2026-10-13`、`DIRECT_SYNC_PR4_STEP3_WRITE_LEASE_2026-10-13`、`DIRECT_SYNC_PR5_S1S2_2026-10-13`、`DIRECT_SYNC_PR6_A15_A17_AND_PR5_S3S6_2026-10-13`、`DIRECT_SYNC_PR6_DEVICE_VERIFICATION_2026-10-13`、`DIRECT_SYNC_TAIL_PAGE_ROOT_FIX_PLAN_2026-10-14` | `docs/SQLITE_DIRECT_SYNC_*_DESIGN.md`、[数据管线](../docs/DATA_PIPELINE.md)、现行直连实现与测试 |
| 2026-10-18 全项目深度审查 | `2f98ac9` | `DEEP_REVIEW_2026-10-18` + `deep-review-2026-10-18/`（README、5 份 lane、FIXES） | 11 P2 + 42 P3 已同轮修复；现行结论见 [架构审查 2026-10-20](ARCHITECTURE_REVIEW_2026-10-20.md) |
| 2026-10-18 训练计划审查 | `24aa7d8` | `TRAINING_PLAN_REVIEW_2026-10-18` + `training-plan-review-2026-10-18/`（README、5 份 lane、FIXES_A、FIXES_BC） | 3 P1 + 18 P2 已修复；v2 已替换其描述的写面，见 [训练排课发布](UNIFIED_TRAINING_PLAN_RELEASE_2026-10-20.md) |
| iOS 同步 2026-10-19/20 执行与复审 | `62f490b`（发布）、`67028e1` | `IOS_SYNC_B6_FIX_EXECUTION_2026-10-19`、`IOS_SYNC_DEFECT_FIX_EXECUTION_2026-10-19`、`IOS_SYNC_EXECUTION_2026-10-19`、`IOS_SYNC_FOLLOWUP_PLAN_2026-10-19`、`IOS_SYNC_INGEST_AUDIT_2026-10-19`、`IOS_SYNC_OPTIMIZATION_EXECUTION_2026-10-19`、`IOS_SYNC_REREVIEW_2026-10-19`、`IOS_SYNC_VERIFY_AND_PLAN_2026-10-19`、`HEALTHKIT_SYNC_REPORT_VERIFICATION_AND_PLAN_2026-10-19` | [iOS 同步发布](IOS_SYNC_RELEASE_2026-10-20.md)、[未实施项核实](IOS_SYNC_UNIMPLEMENTED_VERIFY_2026-10-19.md) |
| Web/macOS 退役旧方案 | `91dbed9` | `WEB_DESKTOP_REMOVAL_PLAN_2026-10-15` | [退役实施手册](plan-remove-web-keep-ios-api.md)、D17/ADR-006 |
| 2026-10-11 ~ 10-17 当轮审查/事故/后端记录 | `694b5f1`、`91dbed9`、`9e08301`、`09ed8d0`、`3f3b07d`、`16b841a`、`dc1e618`、`e2344dc`、`8081ed6`、`9a1e2c8` 等 | `API_HANG_TRIAGE_2026-10-11`、`IMPORT_PUBLICATION_REDESIGN_2026-10-11`、`LATEST_WORKOUT_MISSING_DATA_2026-10-15`、`RUNNING_POWER_GCT_MISSING_2026-10-17`、`INCREMENTAL_SYNC_IMPLEMENTATION_PLAN_2026-10-14`、`UNCOMMITTED_REVIEW_2026-10-11`、`UNCOMMITTED_REVIEW_2026-10-12`、`INGEST_PERSIST_CHAIN_REVIEW_2026-10-15`、`IOS_BACKEND_AUDIT_2026-10-15`、`IOS_BACKEND_FIX_LANDING_2026-10-15`、`IOS_SYNC_INGEST_REVIEW_OPTIMIZATION_2026-10-15`、`SYNC_DATA_PIPELINE_AUDIT_2026-10-15`、`review-ios-sync-data-ingest` | 结论已落到代码/测试；运维铁律进 [运维](../docs/OPERATIONS.md)，产品决定进 [决策](../docs/DECISIONS.md) |

> 说明：表中“收尾提交”是批次收尾/发布的代表提交；每份文档的**最后改动**提交可能不同，
> 用 `git log -1 --format=%h -- <路径>` 精确查询。删除不改变历史结论与数字。

## 4. 新产物约定

- 实验/临时输出优先 `var/reports/`；只有用于明确验收的脱敏证据才保留到本目录。
- 至少记录 database identity/hash、as-of、时区、代码/配置版本、复现命令、通过/失败/不可评估与原因。
- 不得提交原始健康数据、Token、精确路线、上传 ZIP 或 SQLite。
- **当轮审查报告**：可以临时列在 §1（标明“当轮”），下一轮并入
  [项目审查](../docs/PROJECT_REVIEW.md) 的指针表或删除；本目录不长期保留重复批次、实施计划或 archive 副本。
- 保留的 release / verify / triage 记录在**同一交付面出现更新版本时**，把旧记录并入
  [项目审查 §5](../docs/PROJECT_REVIEW.md) 指针表后删除；回滚边界与运维事实同步进
  [运维](../docs/OPERATIONS.md)。
