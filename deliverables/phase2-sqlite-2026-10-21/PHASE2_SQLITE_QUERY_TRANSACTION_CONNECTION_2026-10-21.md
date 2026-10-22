# RAI 阶段 2：SQLite 查询、事务与连接优化实施与验收报告

**日期：2026-10-21（Asia/Shanghai）**  
**起点：`main` / `cfc5ba46c87e54add8e083155f54defaa0f03cef`（阶段 1 完成后的 HEAD）**  
**终点：同一 HEAD 上的工作区改动（未提交；见 §2 与 `source-manifest.json`）**  
**实施依据：`RAI_Phase2_SQLite_Implementation_Plan_2026-10-21.md`（仓库外 Downloads，只读引用，未复制进仓库）**  
**结论：阶段 2 的副本级 P95 写入门禁已补齐并通过（100 轮配对、每轮从 pristine 副本恢复、预热不入样；另补 autocheckpoint=1000 下同一 500 行 assessment 的空 WAL 与临近阈值压力组），D0 非空断言、基准失败退出码、HTTP 隔离与 C15 服务器级回滚证据齐备；v47 索引与 checkpoint 语义修复保留。但本报告不宣布阶段 2 整体验收完成、也不启动阶段 3：健康记录大索引因空间与写入 P95 不达标不入选，查询重写与 speedTrack 复用不在本批实施；**生产发布已于 2026-10-22 以 `9364270` 执行（主健康库 v46 → v47，见[阶段 2 发布记录](../PHASE2_SQLITE_RELEASE_2026-10-22.md)），本报告原时点结论保留。**

---

## 1. 执行摘要

| 项目 | 结果 |
|---|---|
| 隔离实验环境 | 通过。全部数据库、WAL、备份位于仓库外实验根；未打开仓库 `var/rai.sqlite`，未连接生产 |
| 数据集 | D0 语义边界、D1 50k 健康记录/100 训练、D2 518k/1,000、D3 2.0M/5,000（合成、固定 seed） |
| 合入项 1 | 迁移 **v47**：`ability_assessments(training_session_id, model_run_id)` 覆盖索引 |
| 合入项 2 | checkpoint 语义：必须完成的恢复/换库/删除路径检查 `busy`；已提交回执的 checkpoint 允许延后 |
| 主要收益 | `/v1/workouts` 完整组装（含 `currentFacts`/`publishedAnalysis`）D2 p50 **94.95 → 21.29 ms（-77.6%）**，p95 **99.48 → 24.68 ms（-75.2%）**；真实 HTTP `/v1/workouts?limit=30` p50 **115.70 → 27.21 ms（-76.5%）**、p95 **148.35 → 34.24 ms（-76.9%）**；D1/D3 同向，见 §6 |
| 未合入 | `health_records(type,source_name,start_at)` 窄索引与覆盖索引：延迟有收益，但 D2 空间 +17.5%/+25.4% 超出 15% 预算，宽窗口 `stepCount` p95 不稳定；100 轮写入 P95 增量窄 **+12.07 ms（不通过）**、覆盖 **+18.66 ms（不通过）**；`metricSeries` 窗口函数重写不足 5 ms/请求门槛；audit/overlap 仅做缓存后成本说明 |
| 语义 | D0/D1/D2/D3 的所有比较项逐字节相等；D0 先做**非空断言**再差分：HR 9 点、速度 2 点、步数 3 点、区间 10 行，峰值 190 并列、单位 `count/min`/`km/hr`、右端/跨起点/偏移文本边界均有显式期望；另覆盖 pending/旧分析/软删 |
| 迁移 | v46 真实 schema 副本 → v47 通过；冻结 checksum 一致；迁移语句事务内可回滚；兼容回滚构建的 API 启动、性能成绩写入、优雅关闭与落盘验证通过（C15） |
| 门禁 | 原报告全量 `npm test`（`RAI_TEST_CONCURRENCY=2`）通过；本轮重跑 typecheck、check:docs、check:acceptance-matrix、check:scripts、check:package-boundaries、check:training-plan-single-writer、`git diff --check` 均通过；基准脚本对异常/差分不等/D0 断言失败/缺场景统一非零退出，详见 §12 |
| 生产发布 | **未执行**。没有维护窗口与磁盘预算，不能宣称生产发布就绪（计划 §10.3/§11.3） |

**一句话结论：** 阶段 2 的证据支持 v47 小索引和 checkpoint 正确性修复；按原计划 P95 写入门槛已通过（v47 完整事务/持锁/COMMIT P95 增量 +3.61/+3.61/+0.62 ms（WAL 归零辅助组））。不支持为时间序列新增大型索引或重写采样 SQL。副本级门禁已补齐，但整体验收、生产发布与阶段 3 仍需单独决策。

### 1.1 复审整改对照

| 审查项 | 整改与证据 | 结论 |
|---|---|---|
| D0 差分比较空序列 | 样本窗口改为 `w-old` 的 `BASE_MS + DAY_MS` 当天；新增 `assertions.d0`（baseline/窄/覆盖/v47 各 4 份）：非空、峰值 190 并列、单位、重复折叠、单位变体、右端/跨起点/偏移文本边界。`phase2-evidence-d0.json` 的 `verdict.ok=true` | 通过 |
| 写放大只测 COMMIT / 用 P50 代替 P95 / 压力组未覆盖 assessment | `phase2-write-amplification.mjs` 改为 100 轮配对、每轮从同一 pristine 副本恢复、1 轮预热不入样；计时覆盖 `BEGIN IMMEDIATE → INSERT → COMMIT`，外键 ON、WAL、`synchronous=NORMAL`、`busy_timeout=5000` 并回读断言。v47 500 行 assessment：WAL 归零辅助组完整事务/持锁/COMMIT P95 增量 +3.61/+3.61/+0.62 ms；`autocheckpoint=1000` 空 WAL 组 +0.41/+0.41/+0.63 ms；临近阈值组从 971 页起测、提交后 1046/1058 页，P95 增量 -67.40/-67.41/-8.54 ms，均 ≤ max(10%,5ms)。压力组使用同一 assessment 写入器，checkpoint 成本计入 COMMIT | 通过 |
| 基准失败仍退出 0 / 合法跳过误判 | 主基准写 `verdict.ok`：异常、差分 `equal:false`、metric 空序列、D0 断言失败、缺场景均置失败并退出 1；write-amplification 与 migration 证据同样有 verdict/退出码。`--skip-health-candidates` 现在写入 `skippedCandidates`，`narrow`/`cover` 的 differential 用 `null` 表示按设计跳过；D1 以该参数复跑得到 `verdict.ok=true`、0 failure，不再把空对象误报为漏执行 | 通过 |
| HTTP 隔离保护不完整 | `--root` 必填；仓库根/`var/`、**包含仓库的上级目录（如 `/Users/ta`）**、符号链接根/数据库、baseline=candidate（realpath 与 inode）均阻断；baseline/candidate/source 目标另行独立检查不得位于仓库内。`--root /Users/ta` 自检在打开数据库前退出 2。逐请求保存 ms/状态/字节数/SHA-256，分位数可复算 | 通过 |
| C15 兼容回滚只验证读 | `phase2-migration-evidence.mjs` 在 v47 副本上启动真实 API，`POST /v1/performance-entries`、读回、SIGTERM 关闭并核验落盘与 v47 索引；D0/D2 两份证据均通过 | 通过 |
| 指纹口径/未跟踪文件 | 指纹改为路径+NUL+**原始 SHA-256 字节**；未跟踪阶段 2 文件逐项写入 `sha256/bytes` 并计算内容指纹，见 `source-manifest.json` | 通过 |

---

## 2. 起点、终点与改动清单

### 2.1 源码/环境指纹

| 项目 | 起点 | 终点 |
|---|---|---|
| HEAD | `cfc5ba46c87e54add8e083155f54defaa0f03cef` | 同一 HEAD（改动未提交） |
| 已跟踪文件 | 1,065 | 1,065 |
| 已跟踪内容指纹（计划 §1.1 口径） | `00b4240b9bdac6344b9680b449670b949568f3238d9a89f53eb25de0f52464a0` | `443aeb8700d43226097b408022eb78b49bf07125d9850861d095d0bc1fb4a8f9` |
| 未跟踪阶段 2 文件 | 无 | `29` 项（含本轮 P95 写入、D1 合法跳过回归与证据日志），逐项 `sha256/bytes` + 未跟踪内容指纹见 `source-manifest.json` |
| Node / tsx | v22.23.2 / 4.23.0 | 同左 |
| SQLite（进程实际） | 3.51.3 | 3.51.3 |
| 主机 | macOS 26.6.2 / x86_64 / 6 cores / 16 GiB | 同左 |

> 指纹口径与计划一致：`git ls-files -z` 路径按字节排序，依次纳入路径原文、NUL 和文件内容 SHA-256 的**原始摘要字节**（不是十六进制文本）；不是 Git tree hash。终点指纹包含本轮 docs/脚本修改，不包含未跟踪文件；未跟踪阶段 2 文件（含新增迁移、checkpoint、基准脚本与证据）在 `deliverables/phase2-sqlite-2026-10-21/source-manifest.json` 中逐项记录内容 SHA-256、字节数和 `untrackedStage2ContentFingerprint`。

### 2.2 生产代码/测试/文档改动

| 文件 | 改动 | 理由 |
|---|---|---|
| `packages/storage-sqlite/src/v47-migration.ts` | 新增 v47 迁移：`idx_ability_assessments_session(training_session_id, model_run_id)` | D2 `/v1/workouts` 完整端点实测 -77.6% p50 |
| `packages/storage-sqlite/src/database.ts` | 登记 v47、追加冻结 checksum | 迁移纪律 |
| `packages/storage-sqlite/src/checkpoint.ts` | 新增严格/可延后两种 checkpoint 语义 | R2-13：busy 返回值处理不一致 |
| `packages/storage-sqlite/src/index.ts` | 导出 checkpoint helpers | 供 API 与解析器共用 |
| `apps/api/src/maintenance.ts` | 恢复/换库/删除前 checkpoint 改为严格检查 | 防止 busy 时继续搬文件/删侧车 |
| `apps/api/src/import-database-tasks.ts` | `checkpointImportDatabase` 复用严格 helper，保留原错误文案 | 导入任务必须完成路径 |
| `apps/api/src/import-publication.ts` | 已提交回执后的 checkpoint 明确为可延后 | 不把“已提交、checkpoint 未完成”误报为未提交 |
| `packages/health-export-parser/src/cli.ts` | 发布前 checkpoint 改为严格检查 | 同一类文件替换前置条件 |
| `packages/storage-sqlite/test/checkpoint.test.ts` | 严格/可延后 checkpoint 单测 | C13 |
| `apps/api/test/checkpoint-semantics.test.ts` | 导入 helper 与已提交回执延后语义 | C11/C13 |
| `apps/api/test/maintenance.test.ts` | 新增 deleteDatabase 在 checkpoint busy 时拒绝删除的用例 | C13 |
| `packages/storage-sqlite/test/ability-session-index-migration.test.ts` | v47 真实 v46 升级、幂等、计划守卫 | C14 |
| `scripts/bench-sqlite-phase2.mjs` | 隔离基准、数据生成、D0 非空断言、索引实验、差分、失败退出码 | WP2-0/1/2 |
| `scripts/phase2-source-fingerprint.mjs` | 原始摘要字节口径的源码/环境指纹 + 未跟踪文件内容哈希 | WP2-0 |
| `scripts/phase2-migration-evidence.mjs` | v46→v47 迁移/回滚证据 + 回滚构建服务器启动/写入/关闭 | WP2-6、C15 |
| `scripts/phase2-report-tables.mjs` | 从原始 JSON 生成报告表格 | 防止手抄数字 |
| `scripts/phase2-write-amplification.mjs` | 1000 行健康 + 500 行 assessment 完整事务写入放大 | WP2-6 写入代价 |
| `scripts/phase2-http-bench.mjs` | 真实隔离 API HTTP 端点基准、逐请求样本、提交后首读/事件循环 | WP2-1 完整调用成本 |
| `package.json` | 新增 `bench:sqlite-phase2` npm script | 可复现入口 |
| `docs/IOS_NATIVE_SYNC_PROTOCOL.md`、`docs/PROJECT_REVIEW.md`、`docs/HEALTHKIT_RECORD_SYNC_V2.md` | schema 版本 v46 → v47 | 文档与代码一致 |

没有修改 iOS、API 合同、训练计划 v2 写协议、退役接口或部署模板。

---

## 3. 隔离实验环境与数据集

### 3.1 隔离检查

- 实验根：`/tmp/rai-phase2-review-d0`、`/tmp/rai-phase2-review-write`、`/tmp/rai-phase2-review-http`、`/tmp/rai-phase2-review-migration(-d2)`（均为仓库外绝对路径）。
- 主基准、写放大、HTTP、迁移四个脚本都要求 `--root` **显式必填**；拒绝仓库根、仓库 `var/`、**包含仓库的上级目录（如 `/Users/ta`）**、符号链接根与符号链接数据库；baseline/candidate/source 目标另行独立检查不得位于仓库内；`realpath` 同时用于阻断，不只记录。HTTP 还要求 baseline/candidate 的 realpath 与 inode 均不同。`--root /Users/ta` 的四脚本自检都在打开数据库前退出 2。
- 所有数据集/数据库路径经真实路径 containment 检查；缺失路径先解析最近存在祖先，避免父目录符号链接逃逸。
- 未打开仓库默认 `var/rai.sqlite`；未连接生产；未复制仍在活跃写入的 WAL 主库；本次审查后的重跑只使用上述副本。
- 所有 API/仓储基准只在实验根内的合成库上运行；基线、候选 A/B/C 从同一份已 checkpoint 的不可变副本复制。

### 3.2 数据集矩阵

| 数据集 | health_records | workouts | training_sessions | workout_features / assessments | 用途 | 文件大小（baseline） |
|---|---:|---:|---:|---:|---|---:|
| D0 语义边界 | 18 | 3 | 3 | 1 / 1 | 重复、并列时间/峰值、NULL、多单位、偏移文本、pending/旧分析/软删 | 0.9 MiB |
| D1 小库 | 53,000 | 100 | 100 | 90 / 90 | 小库防退化 | 24.4 MiB |
| D2 代表规模 | 518,000 | 1,000 | 1,000 | 900 / 900 | 主 SQL、端点、写入代价 | 243.2 MB |
| D3 放大规模 | 2,018,000 | 5,000 | 5,000 | 4,500 / 4,500 | 增长趋势、空间/迁移窗口 | 898.1 MiB |

每个库的 seed、内容 SHA-256、表行数、schema 版本、索引 DDL、来源/类型分布、稠密窗口样本数、文件大小均写入对应 `phase2-manifest-*.json`。

---

## 4. SQL 台账与完整调用成本（WP2-1）

### 4.1 采集方法

- 计时与台账分离：正式计时关闭插桩；台账单独用 `DatabaseSync` 代理采集真实 SQL、参数、返回行数、耗时。
- 计时：每项先按探测耗时选择预热（20/5/2 次），再 5 轮；快速查询每轮 40 次（合计 200 样本），慢查询每轮 10–30 次（合计 50–150 样本），原始每轮样本保存在证据 JSON。
- 仓储级测量用于 SQL 归属；另起**真实隔离 API 进程**做 HTTP 端点测量（1 并发与 4 并发，Bearer token，`RAI_DATABASE`/`RAI_CONTROL_DATABASE`/`RAI_RUNTIME_ROOT` 全在实验根），结果见 §6.3。

### 4.2 D2 隔离工作负载成本排名（baseline，按 SQL 总耗时）

| 排名 | queryId / 入口 | 调用数 | 返回行 | 总耗时（单次采集） | 关键计划 |
|---:|---|---:|---:|---:|---|
| 1 | `metricSeries.stepCount.broad`（3 年窗口，1 类来源） | 4 | 1,885 | 1,277.5 ms | `SEARCH idx_health_records_source_time` + `TEMP B-TREE DISTINCT` + 4 次窗口排序 |
| 2 | `readHealthRecordOverlapStats`（HR，缓存失效后） | 1 | 1 | 178.4 ms | `SEARCH idx_health_records_type_end (type=?)` 覆盖索引扫描 |
| 3 | `workouts.list.limit30` 事实块（100 行） | 2 | 30 | 16.5 ms | 每个 session 相关子查询扫 `active_ability_assessments` |
| 4 | `workouts.list.status` | 1 | 30 | 6.7 ms | 同上 + `workout_features` |
| 5 | `workouts.list.route` | 1 | 30 | 5.9 ms | 同上 + `workout_zone_summaries` |
| 6 | `workouts.count` | 1 | 1 | 5.5 ms | `training_sessions` 驱动 + 3 个 LEFT JOIN |
| 7 | `metricSeries.heartRate.dense` | 1 | 1,402 | 5.0 ms（单条 SQL；完整仓储调用 16.1 ms p50） | `idx_health_records_source_time` + `TEMP B-TREE` |
| 8 | `analysisVisibilityEvidence` / 批次证据 | 4 | 4 | 0.4 ms | 小表 |
| 9 | `latestWorkoutStartAt` | 1 | 1 | 0.5 ms | 事实侧 MAX |
| 10 | `PRAGMA data_version` | 7 | 7 | 0.2 ms | — |

台账的“总耗时”是**一次**采集的累计值，不等于 p50；完整分布见 `phase2-evidence-d2.json` 的 `ledger.d2.aggregated`。

### 4.3 查询计划采集

- 进程实际 SQLite：3.51.3；`sqlite_stat1/sqlite_stat4` 不存在（未运行 ANALYZE/optimize）。
- 所有候选的前后计划原始行保存在 `indexExperiment.*.plans`；关键差异见 §5/§6。
- `metricSeries` 的 `DISTINCT`、4 个窗口排序、最终排序在 baseline 中存在；覆盖索引可消除 `DISTINCT` 的临时 B-tree，但不能消除窗口排序（这是不重写 SQL 时的上限）。
- `workouts` 列表的计划在 v47 前后不变；v47 只改变事实/分析附加块中 `EXISTS` 的访问路径。

---

## 5. 候选一：`health_records` 复合索引（测量后不入选）

### 5.1 实验 DDL

```sql
-- 候选 A（窄）
CREATE INDEX idx_health_records_type_source_start
  ON health_records(type, source_name, start_at);

-- 候选 B（覆盖）
CREATE INDEX idx_health_records_type_source_series
  ON health_records(type, source_name, start_at, end_at, value_numeric, unit);
```

### 5.2 计划变化

| 查询 | baseline | 候选 A | 候选 B |
|---|---|---|---|
| `metricSeries.heartRate.dense` | `SEARCH idx_health_records_source_time (source_name=? AND start_at>? AND start_at<?)` + `TEMP B-TREE DISTINCT` | `SEARCH idx_health_records_type_source_start (type=? AND source_name=? AND start_at>? AND start_at<?)` + `TEMP B-TREE` | `SEARCH COVERING INDEX idx_health_records_type_source_series (...)`，无 DISTINCT 临时 B-tree |
| `metricSeries.stepCount.broad` | 同上 | 同上 | 覆盖索引，仍保留窗口排序 |
| `metricIntervals.heartRate` | bounded 计划（不依赖新索引） | bounded | bounded |

### 5.3 耗时（D2，5 轮；每项样本数见括号）

| 查询 | baseline p50 / p95 | 窄索引 p50 / p95 | 覆盖索引 p50 / p95 |
|---|---:|---:|---:|
| `metricSeries.heartRate.dense`（400） | 16.06 / 27.48 ms | 13.23 / 17.78 ms（-17.6% / -35.3%） | 12.81 / 15.70 ms（-20.2% / -42.9%） |
| `metricSeries.speed.dense`（400/200） | 5.84 / 11.26 ms | 4.16 / 5.59 ms | 4.01 / 5.59 ms |
| `metricSeries.heartRate.regular`（400） | 14.87 / 24.07 ms | 13.15 / 16.06 ms | 12.88 / 15.69 ms |
| `metricSeries.stepCount.broad`（50） | 1,326.6 / 1,957.0 ms | 1,180.6 / 2,805.3 ms | 937.5 / 2,397.9 ms |
| `metricIntervals.heartRate`（150） | 6.78 / 10.48 ms | 5.79 / 7.50 ms | 5.54 / 7.27 ms |

D1 同向但幅度更小（例如 dense HR baseline 13.65 / 18.98 ms，覆盖 12.98 / 17.66 ms）。D3 只测了 baseline（健康候选在 D2 已因空间/稳定性被否决，未在 D3 重复建大索引）：dense HR 11.92 / 18.79 ms、speed 4.46 / 7.36 ms、stepCount broad 6,139.62 / 35,191.43 ms，说明宽窗口成本随规模继续放大，但这不是 `/series` 的 1 小时窗口路径。

### 5.4 空间、构建与写入代价（D2）

| 项目 | baseline | 窄索引 | 覆盖索引 |
|---|---:|---:|---:|
| 主库文件 | 243,163,136 B | 285,659,136 B | 304,873,472 B |
| 相对增长 | — | **+17.5%** | **+25.4%** |
| 索引构建 | — | 2,093 ms | 2,906 ms |
| 1000 行 health **完整事务** p50 / p95（100 轮配对，每轮从 pristine 副本恢复；BEGIN→1000 INSERT→COMMIT，外键 ON、WAL、NORMAL） | 35.64 / 43.56 ms | 44.43 / 55.63 ms（**p50 +8.79 ms，p95 +12.07 ms**） | 44.65 / 62.22 ms（**p50 +9.01 ms，p95 +18.66 ms**） |
| 写入 P95 门槛（完整事务/持锁/COMMIT 增量 ≤ max(10%, 5ms)） | — | **不通过（完整事务 p95 +12.07 ms > 5 ms）** | **不通过（完整事务 p95 +18.66 ms > 5 ms；P50 +9.01 ms、空间 +25.4% 亦不入选）** |

> 主基准的 `measureInsertCost` 仍为 5 轮短测，只用于候选初筛；本表 P95 判定以 `phase2-write-amplification.mjs` 的 100 轮配对为准。

### 5.5 语义差分

D2 的 13 项比较（10 个仓储工作负载 + `store.workoutsWithViews` + `store.dataSummary` + `store.dataAudit`）全部**逐字节相等**；D0 的重复、并列时间、并列峰值、NULL、多单位、偏移文本也全部相等。索引没有改变可见抽样顺序或 `first_unit`。

### 5.6 结论：暂缓

- 延迟收益真实（覆盖索引 D2 dense HR p95 -42.9%），但：
  1. **空间 +17.5%/+25.4%**，超过计划 §11.3 的 15% 默认预算；
  2. `metricSeries.stepCount.broad` 的 p95 在候选上反而变差（1,957 → 2,805/2,398 ms），说明宽窗口/离群值下没有稳定净收益；
  3. **完整事务写入 P95 增量窄 +12.07 ms、覆盖 +18.66 ms，均超过 max(10%, 5ms) 的 5 ms 门槛**；覆盖索引的 P50 +9.01 ms、空间 +25.4% 也在辅证上不入选。旧证据只测 COMMIT 时漏掉了这项索引维护成本；
  4. 新索引需要 v47/v48 迁移、停服窗口、兼容回滚构建，代价与收益不匹配；
  5. 索引不能消除窗口函数排序，真正的剩余成本在 SQL 形状，不在访问路径。
- 按计划 §6.3/§11.3，**不为凑优化数量合入**。如果未来产品愿意支付 >15% 空间并接受宽窗口 p95 波动，可把覆盖索引作为独立取舍重新提案；本次不进入迁移。

### 5.7 附带实验：`metricSeries` SQL 局部重写（不入选）

把 `COUNT(*) OVER ()` 改为 `stats` 标量子查询、把 `FIRST_VALUE`/`ROW_NUMBER` 合并到命名窗口后，D2 dense HR 从 **10.24 → 8.83 ms**（直接 SQL 5 轮 ×40 次，-13.8%），D1 覆盖索引下从 10.90 → 9.52 ms。收益约 **1.4 ms/请求**，低于计划“每请求至少减少 5 ms 可归因同步工作”的门槛，且会改动并列顺序敏感的窗口 SQL；本次不合并。原始对比见 `/tmp/profile-variants*.mjs`（开发机临时脚本，未纳入仓库）。

---

## 6. 候选二：v47 `ability_assessments` 会话查找索引（合入）

### 6.1 问题与证据

`/v1/workouts` 的 `currentFacts`/`publishedAnalysis` 附加块在同一 `BEGIN DEFERRED` 内对每一行执行：

```sql
EXISTS (SELECT 1 FROM active_ability_assessments presence
        WHERE presence.training_session_id = session.id)
```

`ability_assessments` 现有唯一索引都以 `model_run_id` 打头；只按 `training_session_id` 查找时无法 seek，计划退化为每个 session 扫评估表。D2 baseline 中事实块 100 行 **39.2 ms**、`countPendingAnalysis`（1,000 sessions）**36.9 ms**；完整 `workoutsWithViews` **94.95 ms**。

### 6.2 迁移与计划

```sql
CREATE INDEX IF NOT EXISTS idx_ability_assessments_session
  ON ability_assessments(training_session_id, model_run_id);
```

| 查询 | baseline 计划 | v47 计划 |
|---|---|---|
| 事实块 `EXISTS` | `SCAN assessment USING COVERING INDEX sqlite_autoindex_ability_assessments_2` | `SEARCH assessment USING COVERING INDEX idx_ability_assessments_session (training_session_id=?)` |
| `countPendingAnalysis` | `SCAN assessment ...`（每个 session 一次） | `SEARCH assessment USING COVERING INDEX idx_ability_assessments_session (training_session_id=?)` |

### 6.3 端点收益

| 数据集 | 端点 | baseline p50 / p95 | v47 p50 / p95 | p50 变化 | p95 变化 |
|---|---|---:|---:|---:|---:|
| D1（250 样本） | `workoutsWithViews` | 4.59 / 6.27 ms | 4.00 / 6.02 ms | -12.8% | -4.0% |
| D2（300 样本） | `workoutsWithViews` | **94.95 / 99.48 ms** | **21.29 / 24.68 ms** | **-77.6%** | **-75.2%** |
| D2 | `workouts`（旧字段） | 12.29 / 15.09 ms | 12.29 / 14.95 ms | 0.0% | -0.9% |
| D2 | `workoutSeries.dense` | 38.20 / 43.22 ms | 37.76 / 40.99 ms | -1.1% | -5.2% |
| D3（60 样本） | `workoutsWithViews` | **2,103.95 / 2,333.35 ms** | **130.38 / 146.40 ms** | **-93.8%** | **-93.7%** |

D2 的 `endpoint.workoutsWithViews` 在独立 `auditAndConnection` 场景中同样从 100.63 / 112.85 ms 降到能力索引后的 21.3 左右（能力端点表为 21.29/24.68）；两组独立采集方向一致。
**真实 HTTP（D2 隔离 API，同一份 v47 账本；只切换 `idx_ability_assessments_session` 是否存在）**

| 端点 | baseline p50 / p95 | v47 p50 / p95 | p50 变化 | p95 变化 | 响应体（逐请求样本） |
|---|---:|---:|---:|---:|---|
| `GET /v1/workouts?limit=30`（60 s / 497 vs 2,122 样本，1 并发） | 115.70 / 148.35 ms | **27.21 / 34.24 ms** | **-76.5%** | **-76.9%** | 单一变体 `be1a4c…` |
| 同上（60 s / 568 vs 2,404 样本，4 并发） | 294.97 / 432.07 ms | **68.36 / 101.59 ms** | **-76.8%** | **-76.5%** | 单一变体 `be1a4c…` |
| `GET /v1/workouts/s0/series`（60 s / 1,237 vs 1,255 样本，1 并发） | 46.74 / 57.24 ms | 45.17 / 60.86 ms | -3.4% | +6.3%（+3.62 ms，<20 ms 门槛） | 单一变体 `982ba8…` |

HTTP 测量使用真实 `apps/api/src/server.ts`、临时 control DB、Bearer token、回环地址；每个请求的毫秒数、状态码、响应体字节数和 SHA-256 都保存在 `http-benchmark-d2.json` 的 `samples`，分位数可独立复算，所有响应均为 200 且每个端点的响应体只有 1 个哈希变体。baseline 与 candidate 都是 v47 账本/同一数据，仅索引存在与否不同，因此差值归因于索引访问路径，而不是版本差异绝对值随主机负载有波动：上一轮 1 并发 baseline/candidate p95 为 125.09/37.90 ms，本轮为 148.35/34.24 ms，方向与幅度一致；验收使用本轮逐请求样本。

**外部提交后首次 `/series`＋并发健康检查＋事件循环延迟（D2，12 个测量周期）**

| 指标 | baseline p50 / p95 | v47 p50 / p95 |
|---|---:|---:|
| 外部 no-op 回执提交后首次 `GET /v1/workouts/s0/series` | 368.7 / 399.3 ms | 364.9 / 393.3 ms |
| 与 `/series` 并发 `GET /v1/health` | 368.9 / 399.8 ms | 365.1 / 393.5 ms |
| 事件循环 `eventLoopP95Ms` | 379.1 / 409.5 ms | 376.4 / 392.4 ms |

每个周期先用 `GET /v1/performance?reset=1` 清零直方图，外部连接提交 `import_manifest` no-op 回执，再并发发起 `/series` 与 `/health`，等待 50 ms 采样窗口后读取 `/v1/performance`。结论：任意外部提交都会让 overlap 统计缓存失效，首次 `/series` 约 0.37 s 并同步阻塞事件循环，`/health` 只能排队；baseline 与 v47 同向且量级相同，不是 v47 引入的退化，但它是真实的尾项（§13 登记，不在本批改生产代码）。

D3 的 baseline `workoutsWithViews` 为 2,103.95 / 2,333.35 ms，v47 为 130.38 / 146.40 ms；D3 `endpoint.workouts` 78.70/106.72 → 77.32/87.07 ms，`workoutSeries.dense` 39.26/46.41 → 36.38/41.55 ms，均未退化。

### 6.4 空间、构建、写入

| 项目 | baseline | v47 |
|---|---:|---:|
| 主库文件（D2） | 243,163,136 B | 243,261,440 B |
| 主库文件（D3） | 941,735,936 B | 941,858,816 B |
| 相对增长 | — | **+0.04%（D2，98,304 B）/ +0.013%（D3，122,880 B）** |
| 索引构建 | — | **3.3 ms（D2）/ 71.0 ms（D3）** |
| 500 行 assessment **完整事务** p50 / p95（WAL 归零辅助组，100 轮配对，每轮从 pristine 副本恢复） | 27.22 / 31.64 ms | **29.85 / 35.24 ms（p50 +2.63 ms，p95 +3.61 ms）** |
| 验收：`autocheckpoint=1000` **空 WAL**（100 轮配对） | 27.43 / 35.69 ms | **29.25 / 36.11 ms（P95 +0.41 ms）** |
| 验收：`autocheckpoint=1000` **临近阈值**（971 页起测，提交后 1046/1058 页） | 71.91 / 161.84 ms | **77.32 / 94.43 ms（P95 -67.40 ms）** |
| 临近阈值组 checkpoint 命中 | 100/100 完整事务 >50 ms；33/100 COMMIT >50 ms | 100/100 完整事务 >50 ms；55/100 COMMIT >50 ms |
| v47 写入 P95 门槛 max(10%, 5ms)：完整事务/持锁/COMMIT | — | **三组均通过**：WAL 归零 +3.61/+3.61/+0.62 ms；空 WAL +0.41/+0.41/+0.63 ms；临近阈值 -67.40/-67.41/-8.54 ms |

> 临近阈值组两侧都经历了 WAL autocheckpoint，绝对 P95 会受 OS checkpoint 调度影响；门槛仍按配对 P95 增量判定，重点是 checkpoint 成本已进入完整事务/持锁/COMMIT 计时区间。

写入测量由 `phase2-write-amplification.mjs` 独立执行：每个变体先跑 1 轮预热且不入样；每轮从同一 pristine 副本恢复（macOS 使用 APFS clone），避免上一轮 INSERT 改变表/索引规模；`BEGIN IMMEDIATE → 500/1000 次 INSERT → COMMIT` 全区间计时，`foreign_keys=ON`、`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000` 并回读断言。WAL 归零辅助组在计时前执行 `wal_checkpoint(TRUNCATE)` 且 `wal_autocheckpoint=0`，只测索引维护与持久化；验收压力组保留 `wal_autocheckpoint=1000`，使用同一 500 行 assessment 写入器：空 WAL 组从 0 页起测，临近阈值组先用 950 行 `import_manifest` 填充到 971 页，再执行 500 行 assessment，使 COMMIT 跨过 1000 页阈值，checkpoint 成本落在完整事务/持锁/COMMIT 计时内。

### 6.5 语义差分

D0/D1/D2 的 13 项比较全部逐字节相等，包括 `store.workoutsWithViews`、`store.dataSummary`、`store.dataAudit`；D0 的 pending/旧分析/软删状态、排序、total 均保持。索引只改变访问路径，不改 SQL/排序/过滤。

D0 不再只比较“两个空序列”：`phase2-evidence-d0.json` 的 `assertions.d0` 对 baseline/窄/覆盖/v47 四份结果分别断言 HR 9 点（峰值 190 并列、单位 `count/min`、右端 170 包含、跨起点 130 排除）、速度 2 点（`km/hr` 与 `m/s` 保留）、步数 3 点（单位 `count`）、区间 10 行（精确重复折叠、同起点不同终点、`-05:00` 偏移文本解析（绝对时刻仍落在窗口内）、窗口右端零长丢弃）。四份断言全部 `ok=true`。

### 6.6 迁移与回滚

- v47 在 v46 schema 的合成 D0 副本（以及修复了基准写入行外键的 D2 副本）上 apply 通过；D2 apply 15.3 ms（含 open/检查），不是生产数据副本；冻结 checksum：`4eaa5dc02cab39ff2c35e8fb63bd0c677bc77b6b617189a8d570d07800129242`。
- `schema_migrations` 47 行 checksum 与 `FROZEN_MIGRATION_CHECKSUMS[47]` 一致；`foreign_key_check` 0 违规。
- 迁移语句在事务内 `CREATE INDEX` 后 `ROLLBACK`，索引与账本均回到 v46 状态（证据见 `migration-evidence.json`）。
- 兼容回滚：当前构建认识 v47 且**没有改任何查询 SQL**，因此它就是“认识新账本、使用旧查询实现”的回滚构建。除 `workoutsWithViews`/`dataSummary` 读取外，本次在 v47 副本上启动真实 API 进程（`apps/api/src/server.ts`）：`POST /v1/performance-entries` 成功、读回 1 条、SIGTERM 退出码 0，关闭后数据库中存在该成绩且 v47 索引仍在；D0/D2 两份证据均通过。旧 v46 二进制会因未知 47 拒绝启动（符合计划 §10.4，不承诺直接回退旧二进制）。
- `data:migrate` dry-run 在 v46 副本上输出 pending 47；apply 由迁移测试与 CLI 测试覆盖；未在生产执行。

---

## 7. Checkpoint 返回值语义修复（WP2-5/R2-13）

### 7.1 改动

新增 `packages/storage-sqlite/src/checkpoint.ts`：

- `runWalCheckpointTruncate(database)`：读取 `PRAGMA wal_checkpoint(TRUNCATE)` 的 `busy/log/checkpointed`；`busy != 0` 抛 `WalCheckpointBusyError`（`code = "wal_checkpoint_busy"`）。
- `tryWalCheckpointTruncate(database)`：返回结果而不因 busy 抛错，供“已成功 COMMIT 的回执”使用。

调用点分类：

| 调用点 | 语义 | 处理 |
|---|---|---|
| `maintenance.ts` 恢复/换库/删除前 | 必须完成 | 严格；busy 阻止后续文件移动/侧车删除 |
| `maintenance.ts` 恢复候选/staging | 必须完成 | 严格 |
| `import-database-tasks.checkpointImportDatabase` | 导入 helper 必须完成 | 严格，保留 `Import database checkpoint is busy` 文案 |
| `import-publication.writeImportReceipt` | 已提交回执后的维护 | 可延后；busy 不改变“已提交”事实 |
| `health-export-parser` 发布前 `prepareOriginal` | 文件替换前置条件 | 严格 |

### 7.2 复现与测试

隔离多连接实验：读连接 `BEGIN DEFERRED` + `SELECT` 持有旧快照，写连接提交一条记录后执行 `TRUNCATE` checkpoint，返回 `busy != 0`。旧实现只 `exec()`，忽略返回值；新实现：

- `checkpointImportDatabase` 抛 `Import database checkpoint is busy`（`apps/api/test/checkpoint-semantics.test.ts`）；
- 严格 helper 抛 `WalCheckpointBusyError`（`packages/storage-sqlite/test/checkpoint.test.ts`）；
- 已提交回执在 checkpoint busy 时仍可读回，不被误报未提交（同测试）；
- 读事务结束后严格 checkpoint `busy = 0`；
- `maintenance.deleteDatabase` 在 busy 时拒绝删除，数据库与 marker 行仍在（`maintenance.test.ts`）。

### 7.3 未做

- 未新增后台 checkpoint 调度器；
- 未改恢复协议/五库一致性；
- 未把已提交回执改成“checkpoint 失败即回滚”；
- `maintenance.ts` 中“候选库已不可读”的 catch 路径仍允许忽略 checkpoint 失败（对象已无数据可保）。

---

## 8. Audit、Overlap、连接与 WAL 的测量结论（保持现状）

### 8.1 Audit 聚合（WP2-4）

| 场景 | D1 p50 / p95 | D2 p50 / p95 | 说明 |
|---|---:|---:|---|
| `dataSummary` 冷（新 store） | 5.87 / 9.79 ms | 16.87 / 19.45 ms | 含 `routePointReader.countReadablePoints`、文件 stat |
| `dataSummary` 热 | 0.02 / 0.05 ms | 0.02 / 0.04 ms | `data_version` 缓存命中 |
| `dataAudit` 冷 | 42.74 / 43.91 ms | **373.84 / 390.14 ms** | 多次全表/全索引聚合；运维/诊断端点 |
| `dataAudit` 热 | 0.02 / 0.04 ms | 0.02 / 0.03 ms | 缓存命中 |
| 外部提交后 `dataSummary` 首读 | 2.80 / 6.14 ms | 16.02 / 25.13 ms | 缓存按 `data_version` 失效，无 TTL |

结论：`dataAudit` 冷读的 374 ms（D2）主要来自 `source_category` 全表 GROUP BY、`MIN(start_at)`/`MAX(end_at)` 无法用现有索引做 O(log n)、以及 `type` 分组扫描。它是运维/诊断端点且按 `data_version` 缓存，不是 iOS 常规读路径；本次不增加持久汇总表/触发器，也不新增低选择性索引。D3 `dataAudit` 冷读 1,668.42 / 1,716.74 ms、`dataSummary` 冷读 60.80 / 79.04 ms；两者热缓存均约 0.02 ms。若未来诊断频率上升，优先做“一次请求内共享 + 类型级 min/max 缓存”，而不是复制聚合口径。

### 8.2 Overlap 时长统计（WP2-4）

| 场景 | D1 p50 / p95 | D2 p50 / p95 |
|---|---:|---:|
| 冷 stats（新 cache） | 22.53 / 27.28 ms | **199.50 / 301.99 ms** |
| 热（同 cache） | 3.94 / 6.06 ms | 4.68 / 12.71 ms |
| no-op 回执提交后首读 | 25.98 / 36.25 ms | **200.72 / 745.86 ms** |
| 外部提交新健康记录后首读 | 24.04 / 28.97 ms | 184.42 / 201.64 ms |

结论：`HealthRecordDurationCache` 的失效判据（`data_version` + `total_changes`）保持不变；no-op 回执提交确实会让所有 type 的 stats 重算（计划 R2-06/C07 的预期），D2 首次约 200 ms，热读 4.7 ms。未用 TTL/dataset_version 替代；未新增表达式索引（会带来显著写入/空间代价）。该成本作为已知边界记录：每次外部提交后、每个 type 首次 overlap 读约 200 ms（D2）；D3 冷 stats 716.50 / 798.82 ms、no-op 回执后 706.03 / 841.00 ms、外部提交后 725.26 / 804.14 ms，热读 4.00 / 6.18 ms。

### 8.3 连接与 WAL（WP2-5）

| 场景 | D2 p50 / p95 | 说明 |
|---|---:|---|
| `ReadStoreManager.use` 缓存同步短读 | 0.03 / 0.14 ms | 复用已缓存 `RaiReadStore` |
| `useDatabase`（每次新开只读连接） | 2.49 / 4.37 ms（D2）；2.82 / 4.60 ms（D3） | 短连接成本；未改造成连接池 |

- 未新增通用连接池、常驻写连接、跨线程 `DatabaseSync`；
- `ReadStoreManager` 仍按 **inode** 重开，mtime/checkpoint 不重开；`read-store-manager.test.ts` 覆盖；
- WAL 模式/synchronous/busy_timeout 未统一调整；
- checkpoint 的必须完成/可延后分类见 §7；
- 长读事务阻止 checkpoint 的隔离复现见 §7.2。

---

## 9. 语义差分与验收矩阵

### 9.1 差分方法

- 同一 seed 生成 baseline；候选从同一已 checkpoint 副本复制；时钟/生成标识固定。
- 数组按业务顺序逐项比较；对象键序列化后逐字节比较（`JSON.stringify`）；不排序后比较。
- 只排除 `dataSummary.databaseBytes`（不同副本的文件 stat 必然不同）；不排除 total、状态、版本、单位或边界值。
- D0 覆盖：重复行、同 `start_at` 不同值/单位/`end_at`、并列峰值、NULL `value_numeric`、偏移文本、窗口右端/跨起点、pending/旧分析/软删、多来源/多单位。
- **先断言非空再差分**：`assertions.d0` 对每个候选检查 HR/速度/步数序列的 `totalSamples`、点数、单位、峰值、重复折叠和区间边界；任何一项失败都会使基准退出 1，不再允许“两份空结果相等”。

### 9.2 结果

| 数据集 | 候选 A（窄） | 候选 B（覆盖） | 候选 C（v47） |
|---|---|---|---|
| D0（10 仓储 + 3 store 级 + 非空断言） | 10/10 仓储相等 + 34/34 断言 | 10/10 仓储相等 + 34/34 断言 | 13/13 全部相等 + 34/34 断言 |
| D1（13 项） | 13/13 相等 | 13/13 相等 | 13/13 相等 |
| D2（13 项） | 13/13 相等 | 13/13 相等 | 13/13 相等 |
| D3（v47） | 未测（跳过健康候选） | 未测 | 13/13 相等 |

### 9.3 C01–C16 映射

| 编号 | 本次证据 | 结果 |
|---|---|---|
| C01 | D0 的 `w-pending`/`w-old`/`w-deleted` + `store.workoutsWithViews` 差分；`workout-visibility-freshness.test.ts` | 通过 |
| C02 | D1/D2 的 limit/offset/status/route/days 工作负载；`workout-date-window.test.ts` | 通过 |
| C03 | `workoutsWithViews` 在同一 `BEGIN DEFERRED` 内读取；`pr5-read-side.test.ts`（既有） | 通过（未改事务边界） |
| C04 | D0 非空断言：HR 9 点/峰值 190 并列/单位 `count/min`；`series-read-repository.test.ts` | 通过 |
| C05 | D0 `metricIntervals` 10 行非空断言（重复折叠、同起点不同终点、偏移文本）；`health-record-overlap*.test.ts` | 通过 |
| C06 | `overlap.afterCommit` 失效测量；`health-record-overlap-reads.test.ts` | 通过 |
| C07 | 真实 HTTP：外部 no-op 提交后首次 `/series` p50 365–369 ms、并发 `/health` 同量级、事件循环 p95 376–379 ms；结果新鲜 | 通过（成本已记录，见 §13 尾项） |
| C08 | 既有 `read-store-manager.test.ts` inode/mtime 用例 | 通过 |
| C09 | 既有 `read-store-manager.test.ts` lease/替换用例 | 通过 |
| C10 | 既有 `transaction-owner.test.ts`、`write-lease*.test.ts` | 通过 |
| C11 | `checkpoint-semantics.test.ts`（已提交回执延后）；`import-publication.test.ts` | 通过 |
| C12 | D0/D1/D2 写入后差分；`data-only-import`/`direct-sync*` 全量套件 | 通过 |
| C13 | `checkpoint.test.ts` + `checkpoint-semantics.test.ts` + `maintenance.test.ts` 的 deleteDatabase busy 拒绝 | 通过 |
| C14 | `ability-session-index-migration.test.ts`、`migration-policy.test.ts`、`migration-startup.test.ts` | 通过 |
| C15 | `phase2-migration-evidence.mjs`：v47 库读取 + 真实 API 启动/`POST /v1/performance-entries`/读回/SIGTERM 关闭/落盘与索引核验；D0、D2 两份证据 | 通过 |
| C16 | 全量 `legacy-surface-retirement` 与 API 合同测试（未改路由/JSON） | 通过 |

> 性能绝对值不进入普通 CI；语义、访问结构和迁移账本断言进入常规测试。C01–C16 的“通过”指本次适用测试/差分通过，不代表生产发布就绪。

---

## 10. 迁移、发布与回滚（WP2-6）

### 10.1 无 schema 改动的部分

checkpoint 修复走正常代码发布；回滚前停止新任务准入、等待写事务/worker 结束，不删除已提交回执/任务/事实。

### 10.2 v47 迁移

- 版本：v47（当前源码最高 v46 + 1；实施时未变化）。
- 文件：`packages/storage-sqlite/src/v47-migration.ts`；登记在 `database.ts`；只追加 47 的冻结 checksum，v1–v46 正文/冻结值未改。
- 建索引不在请求/worker 首包/只读开库路径；由 `data:migrate` 显式执行。
- v46 schema 合成副本 → v47：D0 apply 13.7 ms、D2 apply 15.3 ms（含 open/检查）；D2 logical bytes 245,645,312 → 245,665,792（+20,480 B）；`foreign_key_check` 0 违规。文件/WAL 细节见 `migration-evidence*.json`。
- 中断：迁移语句执行后 `ROLLBACK`，索引与账本回到 v46；多项 pending 迁移仍逐项原子，不声称整条链一个事务。
- API 遇到 pending migration 仍拒绝启动；不在线隐式升级。

### 10.3 兼容回滚

- v47 后旧 v46 二进制会因未知迁移版本拒绝打开（符合计划 §10.4；“只有索引所以可直接回退旧代码”不成立）。
- 兼容回滚构建 = 当前构建：认识 v47 账本/checksum，查询 SQL 与 v46 完全一致（本批次没有改任何查询 SQL）。已在 v47 副本上验证 `workoutsWithViews`、`dataSummary` 读取，并验证真实 API 服务器启动、`POST /v1/performance-entries` 写入、读回、SIGTERM 优雅退出（exitCode 0）、关闭后落盘与 v47 索引仍在；D0/D2 两份迁移证据的 `rollbackServer.ok` 均为 true。
- 若未来要移除索引，走新的受控补偿迁移；不删除 `schema_migrations` 行、不伪造 checksum、不手工删库。

### 10.4 生产发布

未执行。维护窗口、磁盘预算、生产备份窗口未提供；本次只完成开发机/副本验收，不宣称生产发布就绪。发布 runbook 按计划 §10.3 留给有窗口的运维批次。

---

## 11. 性能门槛对照（计划 §11.3）

| 门槛 | 本次结果 | 判定 |
|---|---|---|
| 候选入选：主目标参数族 P95 下降 ≥20%，或每请求减少 ≥5 ms；至少 4/5 轮同向 | v47 `workoutsWithViews` D2 P95 -75.2%，5 轮同向；D1 同向但幅度小 | **通过** |
| 其他主要读路径：五轮 P95 中位数增量 ≤ max(基线10%, 2ms) | v47 对 `workouts`/`workoutSeries` 无退化（P95 -0.9%/-5.2%）；健康索引对宽窗口 `stepCount` P95 退化，故不入选 | 通过（合入项）；候选 A/B 不通过 |
| 完整业务 HTTP：目标端点可复现收益，健康/普通读 P95 增量 ≤ max(10%,20ms)，5xx/错误码变化 0 | `/v1/workouts?limit=30` p95 148.35→34.24 ms（1 并发）、432.07→101.59 ms（4 并发）；`/series` p95 +6.3%（+3.62 ms，<20 ms）；逐请求样本全部 200，每个端点响应体仅 1 个哈希变体 | **通过** |
| 写入放大：各代表批次完整事务 P95、持锁 P95、COMMIT P95 增量分别 ≤ max(基线10%,5ms) | v47 500 行 assessment：WAL 归零辅助组 **+3.61/+3.61/+0.62 ms**；`autocheckpoint=1000` 空 WAL **+0.41/+0.41/+0.63 ms**；临近阈值（971→1046/1058 页） **-67.40/-67.41/-8.54 ms**，三组均通过；1000 行 health：窄 **+12.07 ms（不通过）**、覆盖 **+18.66 ms（不通过）** | v47 **通过（P95，含 checkpoint 压力组）**；健康索引 A/B 不入选 |
| 数据库空间：D2/D3 增长分别报告；默认 ≤15% | v47 **+0.04%（D2）/ +0.013%（D3）**；窄 +17.5%、覆盖 +25.4% | v47 通过；健康索引不通过 |
| 资源/关闭：连接数/内存不单调增长；100 轮回到稳态 | 未做 100 轮长跑；连接缓存测试 1,000 次 use 无增长；本次不新增连接复用 | **部分未测**，见 §12 |
| WAL：不新增请求内 TRUNCATE；长读结束后实验维护可完成 checkpoint | 未新增请求内 TRUNCATE；checkpoint 分类修复；长读阻塞复现 | 通过 |
| 迁移窗口：实施前约定预算 | 未提供维护窗口/预算 | **未取得，不能宣称生产就绪** |
| 回滚：无 schema 改动完成代码回滚；有新迁移完成兼容回滚构建启动 | v47 兼容回滚构建的读取、API 启动、成绩写入、读回、优雅关闭与落盘均通过（D0/D2）；生产回滚演练未执行 | 副本级通过，生产未演练 |

---

## 12. 实际命令、并发、退出码与未执行项

### 12.1 本次实际执行

| 命令 | 并发/环境 | 退出码 | 结果 |
|---|---|---|---|
| `node scripts/phase2-source-fingerprint.mjs --rev HEAD --out ...` | Node 22.23.2 | 0 | 起点指纹（原始摘要字节口径） |
| `node scripts/phase2-source-fingerprint.mjs --out ...` | Node 22.23.2 | 0 | 终点指纹 + 未跟踪文件内容哈希；见 §2.1 |
| `node --import tsx scripts/bench-sqlite-phase2.mjs --root /tmp/rai-phase2-review-d0 --scenario d0 ...` | 单进程，隔离根 | 0 | D0 非空断言 + 差分；`verdict.ok=true` |
| 同上 `--scenario d1 --rounds 2 --iterations 10` | 单进程，隔离根 | 0 | D1 复核（含完整写事务）；`verdict.ok=true` |
| 同上 `--scenario d2 --rounds 5 --iterations 40` | 单进程，隔离根 | 0 | 原报告 D2 索引/端点证据（本轮未重跑） |
| 同上 `--scenario d3 --rounds 3 --iterations 20 --skip-health-candidates` | 单进程，隔离根 | 0（旧证据） | 原报告 D3 证据（本轮未重跑）；同一合法跳过代码路径已用 D1 复现，D3 的 `narrow`/`cover` 不再被误报为缺失比较 |
| 同上 `--scenario d9`（故意未知场景） | 单进程，隔离根 | **2** | 参数校验拒绝，不再可能静默 0 |
| `node --import tsx scripts/phase2-migration-evidence.mjs --source ... --root ...`（D0） | 隔离副本 | 0 | 迁移/回滚 + 回滚服务器启动/写入/关闭 |
| 同上（D2，523,115 health rows） | 隔离副本 | 0 | 同上；`rollbackServer.ok=true` |
| `node scripts/phase2-write-amplification.mjs --root ... --rounds 100` | D2 隔离副本，100 轮配对 + 每变体 1 轮预热 | 0 | 1000 行 health + 500 行 assessment；预热不入样；v47 P95 gate 通过（WAL 归零 +3.61/+3.61/+0.62 ms；空 WAL +0.41/+0.41/+0.63 ms；临近阈值 -67.40/-67.41/-8.54 ms） |
| `node --import tsx scripts/bench-sqlite-phase2.mjs --root ... --scenario d1 --rounds 2 --iterations 10 --skip-health-candidates` | 单进程，隔离根 | 0 | 合法跳过 `narrow`/`cover`；`verdict.ok=true`、0 failure |
| `node scripts/phase2-write-amplification.mjs --root /Users/ta` / `node --import tsx scripts/phase2-http-bench.mjs --root /Users/ta ...` | 只做路径检查，不打开数据库 | **2** | 拒绝包含仓库的上级目录；HTTP 数据库目标另有独立仓库排除检查 |
| `node --import tsx scripts/phase2-http-bench.mjs ...` | D2 隔离 API，1/4 并发 + 提交后首读 | 0 | 逐请求样本、分位数可复算；`verdict.ok=true` |
| `npm run typecheck` | — | 0 | 通过 |
| `RAI_TEST_CONCURRENCY=2 npm test` | 2 | 0（原报告） | **本轮未重跑**；原报告 2,261 tests 通过，见 §12.2 |
| `npm run check:docs` | — | 0 | 56 文件/550 链接/2 锚点/0 问题 |
| `npm run check:acceptance-matrix` | — | 0 | 80 条 cited，0 missing |
| `npm run check:scripts` | — | 0 | 18 个 package.json / 106 条 script |
| `npm run check:package-boundaries` | — | 0 | 16 包/31 边 |
| `npm run check:training-plan-single-writer` | — | 0 | 0 违规 |
| `npm run smoke:api` | 隔离临时根/空库 | 0（原报告） | 原报告 Production API runtime smoke test passed（含 v47 迁移启动）；本轮未重跑 |
| `npm run check:ios-gates` | — | 0（原报告） | 原报告 11 支跨平台判据通过；2 支需 Simulator/Xcode 的跳过；本轮未重跑 |
| `npm run check:doc-refs` | — | 0（原报告） | 原报告 153 处引用，0 越界/无法解析；本轮未重跑 |
| `git diff --check` | — | 0 | 无空白错误 |

隔离自检：`phase2-http-bench.mjs --root /Users/ta/running` 退出 2（仓库根拒绝）；同一 baseline/candidate 退出 2（同一文件拒绝）；`phase2-write-amplification.mjs` 缺 `--root` 退出 2；主基准未知场景 `--scenario d9` 退出 2。上述均为脚本参数/隔离失败，不是基准 0 退出。

### 12.2 测试统计

**本轮未重跑全量 `npm test`**；以下为原报告冻结代码时的结果，供追溯：`RAI_TEST_CONCURRENCY=2 npm test` **2,261 tests / 2,248 pass / 0 fail / 13 skipped / 0 cancelled；退出码 0；实际并发 2；总耗时 577,515 ms（约 9 分 38 秒）**。本轮改动只涉及未跟踪基准脚本与报告，`npm run typecheck` 已重跑通过。

失败与修复记录（按顺序）：

1. 第一次全量运行在 `coach-acceptance-replays.test.ts` 报 `Source changed during coach behavior replay`：运行期间仍在编辑 `package.json`/报告，触发了该套件的“源码在回放期间变化”守卫。冻结改动后重跑，该项通过。
2. 第二次全量运行（新增 `maintenance.test.ts` 之前）出现两个**与本批代码无关的时序抖动**：`recompute-worker.test.ts` 的 `cancelledByParent`（子测试未在 event loop 结束前完成）和 `connection-contention.test.ts` 的 `open() 只用了 129 ms —— 没有在锁上等过`（持锁窗口 600 ms 被 tsx 子进程启动时间吃掉）。两项分别在隔离运行中重复通过：`recompute-worker.test.ts` 6/6 pass；`connection-contention.test.ts` 连续 3 次 2/2 pass。
3. 最终全量运行：2,261 tests / 2,248 pass / 0 fail / 13 skipped，退出码 0。没有调大墙钟预算、没有弱化断言、没有扩大排除列表；主机负载（WindowServer/mediaanalysisd 长期占用）是上述抖动的已记录外部因素。

### 12.3 明确未执行

- 生产库打开、生产迁移、生产压测、VACUUM/REINDEX/ANALYZE/PRAGMA optimize、quick_check 全库。
- 生产网络/公网延迟、生产 API 进程；HTTP 基准只在回环地址、隔离 API、合成 D2 数据上完成。
- iOS 构建/Simulator/设备验收（未改 iOS）；`npm run check:ios-gates` 已跑（11 支通过、2 支按设计跳过），`npm run test:ios` 的 Xcode/Simulator 部分未跑。
- 100 轮请求/批次资源长跑、RSS/连接数稳态；只做了 1,000 次缓存 use/500 次短连接测量。
- 生产维护窗口、磁盘预算、备份/恢复演练；因此不宣称生产发布就绪。
- 真实健康数据副本（只使用合成数据）。

---

## 13. 取舍、暂缓与阶段 3 建议

1. **合入 v47**：小索引、低风险、端点收益大；100 轮配对下 WAL 归零辅助组完整事务 P95 +3.61 ms、持锁 +3.61 ms、COMMIT +0.62 ms；`autocheckpoint=1000` 空 WAL 组 +0.41/+0.41/+0.63 ms，临近阈值组 -67.40/-67.41/-8.54 ms，均低于 max(10%,5ms)；继续观察重算发布的锁等待。
2. **暂缓健康记录索引**：空间 +17.5%/+25.4% 超预算，宽窗口 `stepCount` p95 不稳定，且完整事务 P95 增量窄 +12.07 ms、覆盖 +18.66 ms 均超过门槛；不再以旧 COMMIT-only 数据为其辩护。
3. **暂缓 metricSeries 重写**：剩余成本是窗口排序；任何全序/并列规则变化都需要产品明确的语义决定，不能冒充纯性能改动。
4. **Audit/Overlap**：本次只交付“冷/热/提交后”成本与阈值；若 D3/生产诊断频率上升，优先做请求内共享和类型级 min/max 复用，不建持久汇总表。
5. **连接**：保持现有 `RaiReadStore` 缓存 + 短只读连接；除非 open/PRAGMA/schema 检查成为主要成本，不引入通用池。
6. **阶段 3**：parser 重构、导入拆批、增量分析/发布合同属于阶段 3；本阶段未动。

### 13.1 性能尾项登记（阶段 3 启动前复核）

| 尾项 | 本次实测 | 决定 |
|---|---|---|
| 提交后 overlap 首读阻塞 | D2 外部 no-op 提交后首次 `/series` p50 **364.9–368.7 ms**、p95 393–399 ms；并发 `/health` 同量级；事件循环 p95 **376–409 ms**。baseline 与 v47 同向 | **未解决**（不得标为已解决）；本批不改生产代码。阶段 3 优先评估“统计缓存持久化/类型级 min/max”，或在请求外预热；验收要求首次 `/series` 不得同步阻塞事件循环超过约定阈值（建议 50 ms） |
| 同请求重复 `speedTrack` | `workoutSeries` 一次请求内 `segmentRun`、`workoutSplits`、`measureSegments` 各调用一次；同一快照内重复计算 | **本批未改**；阶段 3 评估把已构建 track 传入测量/分段函数的复用方案；必须保留现有单位、缩放和区间语义，并以 D0 差分守门 |
| 审计冷读 | D2 `dataAudit` 冷读约 374 ms、D3 约 1.67 s；热缓存约 0.02 ms | **登记暂缓**；诊断/运维端点，按实际调用频率决定，不建持久汇总表 |

阶段 3 进入条件（研发侧）：D0 非空断言、完整写事务 P95 证据、基准失败退出码、HTTP 隔离、C15 服务器级回滚和源码指纹均已补齐；但这只确认阶段 2 副本级门禁，不替代阶段 3 启动决策。生产维护窗口尚未确定，生产发布仍未就绪。

---

## 附录：证据文件

- `deliverables/phase2-sqlite-2026-10-21/evidence/phase2-evidence-d0.json`
- `.../phase2-evidence-d1.json`
- `.../phase2-evidence-d2.json`
- `.../phase2-evidence-d3.json`
- `.../phase2-manifest-d0.json` / `d1` / `d2` / `d3`
- `.../phase2-evidence-d1-skip.json`（`--skip-health-candidates` 合法跳过回归）
- `.../write-amplification-d2.json`
- `.../write-amplification-d2.log`
- `.../http-benchmark-d2.json`
- `.../migration-evidence.json`（D0）
- `.../migration-evidence-d2.json`（D2）
- `.../source-manifest.json`（终点；含未跟踪阶段 2 文件逐项 `sha256/bytes` 与 `untrackedStage2ContentFingerprint`）
- `.../source-manifest-start.json`（HEAD 起点；原始摘要字节口径）
- `.../baseline-cfc5ba4.tar.gz`（`git archive HEAD` 的起点源码快照，34 MB）
- [report-tables.md](evidence/report-tables.md)（由原始 JSON 生成的表格，报告正文引用）
