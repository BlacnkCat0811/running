# RAI 阶段 2 剩余问题：A/B/C 实施与验收报告

**日期：2026-10-22（Asia/Shanghai）**  
**基线：`main` / `cfc5ba46c87e54add8e083155f54defaa0f03cef`；工作区含阶段 2 未提交改动与本次 A/B/C 改动**  
**实施依据：`RAI_Phase2_Remaining_Issues_Implementation_and_Acceptance_2026-10-21.md`（仓库外 Downloads，未复制进仓库）**  
**生产发布：未执行。本报告只做研发验收，不代表生产维护窗口、备份恢复或部署验收已完成。**

## 1. 结论摘要

| 项 | 实施状态 | 验收结论 | 关键证据 |
|---|---|---|---|
| A assessment 写入 P95 + 自动 checkpoint 证据闭环 | 已实施并重跑 | **A-01～A-08 全部通过**（正式组 empty-wal、near-threshold 三项 P95 均过门槛） | `evidence/write-amplification-d2-v3-final.json` + `.log`；独立验收 `--verify` 退出 0 |
| B 外部提交后首次 `/series` 阻塞 | 已实施：只读缓存 + 自适应精确回退 + 请求外 stats worker + `/series` 专属读 worker | **B-01～B-08 全部通过**（D2/D3；热读五窗口已改用未删除、可读训练重测，修复原 p50/oldest 404 假通过）。D2 事件循环 P95 7.2–11.2 ms、并发 `/health` 4.7–15.7 ms；D3 8.4–10.1 / 6.2–11.9 ms | `evidence/http-b-*.json`、`http-b-verdict-d2.json`、`http-b-verdict-d3-hot.json`、`http-b-verdict-*-hot-fixed*.json` |
| C 单请求重复构建 speedTrack | 已实施 | **C-01～C-07 全部通过**（真实调用 3→1；D0/D2 33 份完整正文逐字节相等；5 块中 4 块改善）；C-07 热读窗口使用修正后的有效 D2 证据 | `evidence/speedtrack-bench-d2.json`、`series-dump-*.json`、`http-b-*-hot-fixed*.json` |

**总裁决：** A、B、C 三项均已通过本轮验收：A 的写入门禁闭环补齐；B 的 stats 同步扫描移出主线程，首次 `/series` 由约 330–383 ms 降至 D2 44–71 ms、D3 78–92 ms，事件循环与并发健康检查回到 50 ms 以内；C 的同一请求 speedTrack 构建 3→1 且正文逐字节等价。原热读结论中 D2/D3 的 p50/oldest 实际是软删除训练的 404（见 §5.2.1），该两项旧样本不再作为通过证据；修正后以可读训练重测，D2/D3 五窗口均满足门槛。阶段 3 可提交正式实施启动决策；生产发布仍未就绪（无维护窗口、磁盘预算、备份恢复演练与生产迁移执行）。

## 2. 基线冻结

| 项目 | 值 |
|---|---|
| HEAD | `cfc5ba46c87e54add8e083155f54defaa0f03cef` |
| 分支 | `main` |
| Node / tsx / SQLite | v22.23.2 / 4.23.0 / 3.51.3 |
| 主机 | macOS Darwin 25.6.0 / x86_64 / 6 cores / 16 GiB |
| 四个锚点文件 SHA-256 | 与实施文档 §2.2 完全一致（见 `evidence/baseline-freeze.txt`） |
| D2 实验数据 | `d2` 与 `d2-candidate-c` 两份 243/243 MB 副本；`health_records=518,090`、`training_sessions=1,000`、`workout_features=900`、`ability_assessments=900`、`model_runs=1`；文件 SHA-256 见 `evidence/dataset-hashes.txt`；两侧仅 `idx_ability_assessments_session` 不同（`indexDiff`） |

> 2026-10-22 验收工具复核环境：Node `v24.21.0` / tsx `v4.23.0` / SQLite `3.53.4`；
> 上表的 Node/SQLite 是原始性能测量环境，未因本轮工具复核而改写。原始性能证据、
> 门槛和阶段 3 准入结论均未重算。

A 的正式样本使用 500 个 `workout_features JOIN training_sessions` 锚点；两侧锚点数组 SHA-256 相同（见最终 JSON `dataset.baseline.anchorsSha256` / `ability.anchorsSha256`）。每个正式样本从同一 pristine 副本恢复，先执行同一组只读页面预热（`ability_assessments`、`model_runs`、`workout_features`、`training_sessions`），再做 WAL 归一化/预填充；预热不改变数据，不计时。

> 说明：本次 A 的两次探索性运行（`write-amplification-d2-v3.json`、`...-rerun.json`）在 empty-wal/near-threshold 的 P95 上失败，已原样保留。失败原因是每个样本从 APFS 克隆新开连接时的冷页读取/COW 成本落在索引维护计时里（p50 差值仅 2.5–3.4 ms，p95 被尾部放大）；随后加入“两侧同一 SQL 的只读页面预热”后重跑 100 轮通过。该调整不改变门槛、不删样本、不放宽配置；完整的失败样本仍在证据目录中，不把探索性运行伪装成通过。

## 3. A：assessment 写入与 checkpoint 验收闭环

### 3.1 实施

入口：[`scripts/phase2-write-amplification.mjs`](../../scripts/phase2-write-amplification.mjs)、纯裁决器 [`scripts/phase2-write-verdict.mjs`](../../scripts/phase2-write-verdict.mjs)。

- 三组：`normalized`（autocheckpoint=0，TRUNCATE 后空 WAL，辅证）、`empty-wal`（autocheckpoint=1000，空 WAL）、`near-threshold`（autocheckpoint=1000，计时前 ballast 预填充到 950–999 帧）。
- 计时区间严格为 `BEGIN IMMEDIATE → 1 个模板 model run + 500 行 assessment → COMMIT`；`beginMs`/`insertMs`/`commitMs`/`lockMs`/`totalMs` 五点记录；`lockMs` 明确标注为应用层持锁区间近似。
- 每样本回读 `setupPragmas` 与 `timedPragmas`；`timedPragmas.walAutoCheckpoint` 验收组必须为 1000，normalized 为 0；`foreign_keys=1`、`journal_mode=wal`、`synchronous=1`、`busy_timeout=5000`、`page_size` 均回读。
- WAL 帧数使用 `PRAGMA wal_checkpoint(NOOP)` 的 `busy/log/checkpointed`；文件字节容量只记录为 `capacityPages`，不参与断言。empty-wal 断言起始 `log=0`；near-threshold 断言 `950 ≤ log < 1000`、提交后 `log ≥ 1000`、`checkpointed` 增加、`crossedThreshold=true`。
- 每个变体 1 轮独立预热不入样；正式 100 轮 AB/BA 轮换；每轮从 pristine 副本恢复；提交失败回滚并关闭连接。
- 事务结束后在隔离副本重新打开只读连接，核对 500 行 assessment、1 个 model run、`foreign_key_check=0`、`quick_check=ok`、目标索引在 ability 存在而在 baseline 缺失。
- 机器裁决：`--verify <json>` 用纯 JSON 夹具独立复算样本数、P95、PRAGMA、WAL 状态、持久化与索引；缺组、少样本、预热混入、错表、PRAGMA 冲突、未跨阈值、P95 超限、异常均退出 1。

### 3.2 结果（100 轮/变体/组，1 预热/变体）

| 组 | 指标 | baseline P95 (ms) | ability P95 (ms) | 增量 (ms) | 门槛 (ms) | 结果 |
|---|---|---:|---:|---:|---:|---|
| normalized（辅证） | 完整事务 / 持锁 / COMMIT | 28.46 / 28.44 / 4.57 | 32.55 / 32.52 / 4.60 | +4.10 / +4.09 / +0.03 | 5 / 5 / 5 | 通过（不作正式替代） |
| empty-wal | 完整事务 / 持锁 / COMMIT | 26.33 / 26.31 / 4.27 | 27.64 / 27.62 / 4.38 | +1.31 / +1.31 / +0.11 | 5 / 5 / 5 | **通过** |
| near-threshold | 完整事务 / 持锁 / COMMIT | 131.90 / 131.76 / 60.69 | 85.25 / 85.23 / 60.00 | -46.66 / -46.53 / -0.68 | 13.19 / 13.18 / 6.07 | **通过** |

- empty-wal：两侧起始 `logFrames=0`，提交后 74–75 / 86–91 帧，无自动 checkpoint。
- near-threshold：两侧起始 980 / 977 帧，提交后 1054–1055 / 1063 帧；100/100 样本 `crossedThreshold=true`；`checkpointed` 帧数增加。两侧都经历自动 checkpoint，绝对 P95 受 OS checkpoint 调度影响；门槛仍按配对的两个总体 P95 增量判定。
- 独立 `--verify`：`{"ok": true, "failures": []}`，退出码 0。
- 持久化：baseline `targetIndexPresent=false`，ability `true`；两侧 `rowsReadBack=500`、`modelRunsReadBack=1`、`foreignKeyViolations=0`、`quick_check=ok`。

### 3.3 A 验收清单

| ID | 结果 | 证据 |
|---|---|---|
| A-01 | 通过：两侧仅目标索引不同，500 锚点哈希相同；每事务 1 run + 500 assessment | `dataset`、`indexDiff`、`workload.anchorIdentityOk=true`、`samples[].rowsInserted=500` |
| A-02 | 通过：每侧每状态 100 正式样本 + 1 独立预热；无缺失/重复/预热混入 | `groups.*.samples`、`warmupSamples`、裁决器 sample_count/warmup_count |
| A-03 | 通过：正式组 timed 自动 checkpoint=1000，normalized=0；setup=0；汇总/样本一致 | 每样本 `timedPragmas`、`setupPragmas`、`pragmas` |
| A-04 | 通过：empty-wal 起始为空；near-threshold 起始 977/980，提交后 ≥1000 | `walBefore`、`walAfter`、`crossedThreshold` |
| A-05 | 通过：两个正式组三项 P95 增量均 ≤ max(10%,5ms) | §3.2 表 |
| A-06 | 通过：原始样本可复算；失败夹具覆盖 99 轮、预热混入、health 错表、PRAGMA 冲突、未跨阈值、P95 超限、缺组/异常 | `apps/api/test/phase2-write-verdict.test.ts`（10 个 JSON 夹具）；`--verify` 退出码 |
| A-07 | 通过：隔离副本读回、外键、quick_check、索引、连接关闭 | `persistence.baseline/ability`、`cleanup` |
| A-08 | 通过：本报告分列三组、脚本/环境/数据指纹；历史失败样本保留；区分研发验收与生产发布 | 本报告、`source-manifest.json` |

**限制：** 本次正式 A 证据只跑 D2（与阶段 2 原写入门禁同一尺度）；没有把 health 1000 行写入实验混入 assessment 验收；没有生产库、没有生产 PRAGMA 修改；A 的页面预热是测量方法的一部分（见 §2 说明），不是生产写路径改动。

## 4. C：单请求 speedTrack 复用

### 4.1 实施

- `packages/storage-sqlite/src/read/series-read-repository.ts`：新增 `SeriesSpeedTrackProvider`（惰性、可缓存 `null`、请求局部）、`speedTrackProvider()`、`measureSegmentsWithTrack()`、`workoutSplitsWithTrack()`；原 `measureSegments()` / `workoutSplits()` 保留独立调用兼容。另新增 `StoredSegmentAverages` / `segmentAveragesProvider()`，让分段与公里分段共享同一请求的心率/步频平均值（仍不跨请求缓存）。
- `apps/api/src/data.ts`：`workoutSeries` 创建本次请求的 provider，`segmentRun` 与 `workoutGradeContext` 共享；`workoutSeries` 用 `BEGIN DEFERRED` 短读快照（已有外层事务时复用，不嵌套），结束提交/异常回滚；上下文只存在于本次调用。
- `seriesRepository.metricSeries` 对完全无行的指标增加同一谓词的索引存在性检查，直接返回原空形状（`unit=fallbackUnit`、`totalSamples=0`、`points=[]`），避免为必然空的窗口跑排序窗口函数；不改变非空采样 SQL。

### 4.2 证据

| 项目 | 结果 |
|---|---|
| C-01 每请求构建次数 | 测试 `workoutSeries builds the speed track at most once per request...`：1 次；两次请求 1→2；无轨迹场景 `null` 也只 1 次 |
| C-02 独立仓储兼容 | `measureSegmentsWithTrack(track)` 与 `measureSegments()` 逐项相等；`workoutSplitsWithTrack(track)` 与 `workoutSplits()` 逐项相等；`null` 返回 `[]` |
| C-03 完整正文差分 | D0 3 份、D2 30 份 `workoutSeries` 正文逐字节相等（`series-dump-before-*` vs `after-*`，0 mismatch） |
| C-04 生命周期 | provider 只存在于一次调用；`workoutSeries` 返回后 `database.isTransaction=false`；跨请求计数测试 1→2 |
| C-05 真实调用计数 | 5 块 × 20 迭代：legacy 60 次/块（3/次），shared 20 次/块（1/次）；`buildCountsConsistent=true` |
| C-06 子步骤性能 | 5 块中 4 块通过（≥20% 或 ≥5 ms）：26.13→20.24（+5.89 ms, 22.5%）、25.82→20.75（+5.06, 19.6%）、22.06→17.44（+4.62, 20.9%）、23.44→19.09（+4.34, 18.5%，未过）、22.83→15.82（+7.01, 30.7%）；中位 +5.06 ms / 20.9% |
| C-07 完整 HTTP | 修正后的 D2 热读 200 次/窗口（排除软删除训练）：recent p95 64.5→67.9、p25 18.5→17.3、p50 21.1→24.5、p75 22.2→19.6、oldest 16.2→20.3 ms；五窗口全部 200、≤max(10%,20 ms)、身份与正文一致；并发 `/health` P95 4.7–15.7；无 5xx；无跨请求轨迹驻留。旧的 p50/oldest 404 样本已作废（见 §5.2.1） |

## 5. B：外部提交后首次 `/series` 阻塞

### 5.1 实施

- `HealthRecordDurationCache.tryLookupValid()`：只返回当前连接状态已验证的缓存；缺失/`data_version`/`total_changes` 失效时移除条目并返回 `null`，**不触发全类型统计扫描**。
- `readHealthRecordOverlap()`：命中已验证缓存才使用 bounded；否则立即走原有精确自适应查询。读期间状态改变仍丢弃 bounded 结果并精确重读。
- `HealthRecordOverlapStatsWorker`：缓存 miss 只入队；独立 read-only worker 计算统计；主线程按调度时捕获的 `(data_version,total_changes)` 核对后 `prime`，提交/换库即丢弃。一个 store 一个 worker、类型去重、`RaiReadStore.close()` 终止；worker 的 `message`/`error`/`exit` 和 in-flight 任务绑定到具体 `WorkerSlot`，旧实例退出只清理旧槽，不会清掉替换实例的任务。
- `SeriesReadWorker`：`/v1/workouts/:id/series` 的完整 `workoutSeries` 组装放到专属读 worker（自己的只读 `RaiReadStore`）；路由在 `readStores.lease()` 内等待，换库不能落在请求中间；文件 inode 变化时重建 worker。每个 worker 代次拥有独立的 ready promise、pending map 和事件监听，旧代次的延迟 ready/exit 不会结算新代次；准入在启动等待前计数，`maxPending` 覆盖冷启动等待，启动等待上限 10,000 ms；worker 故障才回退原同步路径，队列过载返回可重试 503，业务异常不再被 catch-all 重放。一个 worker、单请求队列上限 64、`onClose` 终止。
- `RuntimeTelemetry` 事件循环采样分辨率由 20 ms 调到 5 ms（测量精度；不影响业务响应）。

### 5.2 结果

#### D2（100 周期/状态，5 个 AB/BA 块，2 预热）

| 状态 | baseline 首次 `/series` P95 (ms) | candidate 首次 P95 (ms) | candidate 并发 `/health` P95 (ms) | candidate 事件循环 P95 (ms) |
|---|---:|---:|---:|---:|
| receipt | 366.5 | 68.8 | 12.1 | 10.8 |
| new-health | 372.2 | 69.1 | 10.0 | 10.9 |
| longer-record | 366.0 | 71.2 | 15.7 | 11.2 |
| revise | 364.5 | 64.8 | 10.8 | 10.3 |
| delete | 383.1 | 52.5 | 9.2 | 10.4 |
| route | 50.8 | 44.2 | 4.7 | 7.2 |
| workout-metadata | 45.6 | 45.6 | 5.5 | 7.5 |

- 首读约 330–383 ms 的 stats 扫描已消失；所有状态正文与 baseline 逐字节相同（`bodyEqual=true`），第二次 `/series` 也相同；状态 200、`serverErrors=0`。
- 热读窗口（200 请求/窗口，100 次预热；仅选 `workouts.deleted_at IS NULL` 的可读训练）：recent 64.5→67.9 ms、p25 18.5→17.3、p50 21.1→24.5、p75 22.2→19.6、oldest 16.2→20.3；全部 ≤max(10%,20 ms)。五个窗口均为 200，训练身份分别为 `s0/s249/s498/s748/s998`，正文与基线逐字节相同。
- RSS：100 周期内各状态变化 -26.4～-10.4 MiB（无增长）。

#### D3（100 周期/状态；首读与事件循环）

| 状态 | candidate 首次 `/series` P95 (ms) | candidate 并发 `/health` P95 (ms) | candidate 事件循环 P95 (ms) |
|---|---:|---:|---:|
| receipt | 83.9 | 8.6 | 9.5 |
| new-health | 91.6 | 9.7 | 9.8 |
| longer-record | 88.9 | 11.9 | 10.1 |
| revise | 77.8 | 11.0 | 9.1 |
| delete | 91.7 | 10.4 | 9.7 |
| route | 86.0 | 6.2 | 8.4 |
| workout-metadata | 80.9 | 8.1 | 9.2 |

D3 热读窗口（200 请求/窗口，基线与候选均 300 次预热；仅选可读训练）：recent 49.0→51.6、p25 20.4→18.3、p50 28.7→24.8、p75 17.7→14.4、oldest 17.2→21.4 ms；全部 ≤max(10%,20 ms)。五个窗口均为 200，训练身份分别为 `s0/s1249/s2498/s3748/s4998`，正文逐字节相同。D3 首次全状态 baseline 运行曾因旧缓存文件移除 `onMiss` 与 stats worker 不兼容而返回 500，该次不作为证据；100 次预热的候选热读曾在 p75 出现 143.9 ms 的未完成 stats 扫描尾部，作为失败运行保留在 `http-b-candidate-d3-hot-fixed-warmup100.json`，不纳入通过证据；正式重测将两侧预热统一为 300 次。

#### 5.2.1 热读窗口 404 验收缺陷修正（2026-10-22 复查）

原报告的“五窗口全部通过”不能成立：基准脚本按 `training_sessions` 选取分位窗口时没有过滤 `workouts.deleted_at`，D2 的 `p50=s499`、`oldest=s999` 和 D3 的 `p50=s2499`、`oldest=s4999` 都是软删除训练，200 个样本全部是 47 字节的 404 正文；旧比较器只比较延迟和正文哈希，因此“相同的错误正文”也能通过。原 `http-b-*-d2.json`、`http-b-*-d3-hot.json`、`http-c-*-d2.json` 保留为历史证据，但其中的 p50/oldest 数字不再计入验收。

修正内容：

- 选窗 SQL 加 `workout.deleted_at IS NULL`；D2 可读训练 990 条，D3 4950 条。
- 每次预热和正式请求都走 `requestSeries()`：断言状态 200、`trainingSessionId` 与请求训练一致，并要求 metric samples、splits、segments 至少一项非空；任何 404/身份错位/空正文都会中止整次测量，而不是记录一条低延迟样本。
- 热读比较器同时校验 baseline/candidate 的 200 样本数、状态集合、训练身份、业务内容和同一 session；旧 JSON 缺少这些字段会直接失败，无法再次“相同 404 正文”通过。
- 新增 `apps/api/test/phase2-series-hot-verdict.test.ts`，用 404、身份错位、空内容三个失败夹具守住比较器。

基线来自阶段 2 证据中的 `baseline-cfc5ba4.tar.gz`（SHA-256 `a2a65c56…b7cf6123`，完整快照 `cfc5ba4`），候选为当前工作区源码；D2 基准库 `bench-baseline-root/d2.sqlite`（SHA-256 `ace4da35…ec29f8df`）、D3 基准库 `bench-baseline-root/d3.sqlite`（SHA-256 `5846225d…fd5e6995e`）。D2 两侧 100 次预热；D3 两侧统一 300 次预热。

修正后重测（原始 JSON 见 §7）：

| 数据集 | p50 窗口 | oldest 窗口 | 结果 |
|---|---|---|---|
| D2 | `s498`，404→200，P95 21.1→24.5 ms | `s998`，404→200，P95 16.2→20.3 ms | 五窗口全部 200、≤max(10%,20 ms)、正文逐字节相同 |
| D3 | `s2498`，404→200，P95 28.7→24.8 ms | `s4998`，404→200，P95 17.2→21.4 ms | 同上；候选与基线统一 300 次预热 |

#### 5.2.2 热读窗口端点命名更正（2026-10-22 复盘）

§5.2 与 §5.2.1 的 `recent`/`oldest` 两列名称与实际训练时间相反：基准脚本按
`anchor_start_at, id` 升序取 `all[0]`，它是最老训练却被命名为 `recent`；`all.at(-1)`
是最新训练却被命名为 `oldest`。原始 JSON 保留不变。按实际时间重命名后：

| 数据集 | 实际 oldest | 实际 recent |
|---|---|---|
| D2 | `s0`：64.5 → 67.9 ms | `s998`：16.2 → 20.3 ms |
| D3 | `s0`：49.0 → 51.6 ms | `s4998`：17.2 → 21.4 ms |

`p25/p50/p75` 的训练与数值不变。该更正只改名称/元数据，不改变测量、性能门槛或
阶段 3 准入结论。新比较器默认要求选窗元数据；旧 JSON 只能用
`--allow-legacy-window-mapping` 做只读复核，并输出 `windowMappingVerified=false`。
详细复核见 [PHASE2_HOT_WINDOW_VERDICT_REVIEW_2026-10-22.md](PHASE2_HOT_WINDOW_VERDICT_REVIEW_2026-10-22.md)。

### 5.3 B 验收清单

| ID | 结果 | 说明 |
|---|---|---|
| B-01 | 通过 | 缓存失效后不再同步重建；D2/D3 首读均不再出现 0.37 s stats 扫描，主线程无 stats 扫描 |
| B-02 | 通过 | D2 七状态完整 `/series` 正文与 baseline 逐字节相同；D3 修正后热读五窗口正文逐字节相同；无分段/序列换速度 |
| B-03 | 通过 | D2 事件循环 P95 7.2–11.2 ms、`/health` 4.7–15.7 ms；D3 8.4–10.1 / 6.2–11.9 ms；均 ≤50 ms |
| B-04 | 通过 | D2 首次 P95 44.2–71.2 ms、D3 77.8–91.7 ms，均 <100 ms；D3 报告首读与热读 |
| B-05 | 通过 | D2/D3 修正后五窗口 P95 增量全部 ≤max(10%,20 ms)，且每窗口 200 个 200 样本、训练身份与正文一致（见 §5.2.1） |
| B-06 | 通过 | 单测覆盖 `tryLookupValid` 状态不符、worker `prime` 旧状态拒绝、读期间状态改变丢弃 bounded；插入/修订/删除/外部提交逐行等价；`series-read-worker.test.ts` 覆盖换库 inode 变化后 worker 重建、旧代次 ready/exit 不污染新代次、启动等待计入 `maxPending`、启动超时有界、业务异常与 worker 故障分流；`readStores.lease` 阻止请求中途换库 |
| B-07 | 通过 | D2/D3 所有状态 200，`serverErrors=0`；worker 不可用时才回退同步路径；队列过载返回 503 `series_read_overloaded` + `Retry-After: 1`，不退回主线程重算；业务异常按原异常传播；`seriesReadFailureAction` 断言三类分流，覆盖 worker 关闭后的拒绝行为 |
| B-08 | 通过 | 一个 series worker + 一个 stats worker per store；请求级不新增连接/worker；D2 RSS 变化 -26.4～-10.4 MiB、D3 -20.6～+1.6 MiB；`series-read-worker.test.ts` 覆盖关闭幂等与换库重建；stats worker 的旧 error/exit/message 只结算旧实例 |

## 6. 回归与静态检查

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（tsc pure + full） |
| `npm run check:package-boundaries` | 通过 |
| `npm run check:training-plan-single-writer` | 通过（违规 0） |
| `npm run check:scripts` | 通过（106 条 script） |
| `npm run check:acceptance-matrix` | 通过（80 条，missing 0） |
| `npm run check:docs` | 通过（57 文档，553 链接，0 问题） |
| `npm run smoke:api` | 通过（生产 API runtime smoke test） |
| `git diff --check` | 通过 |
| 全量 `npm test`（`RAI_TEST_CONCURRENCY=2`） | 见 `evidence/full-test.log` 与 §6.1 |
| 目标测试 | overlap 18、series 仓储 5、series worker 5、hot-window verdict 1、data/workout-segments/read-store/verdict 等 92 项通过 |

### 6.1 全量测试记录

- 命令：`RAI_TEST_CONCURRENCY=2 node scripts/run-tests.mjs`（与实施计划 §7.4 相同的测试入口；实际并发 2）。
- 结果：**2,285 项测试，2,272 通过、0 失败、13 跳过、0 取消；退出码 0；耗时 595,771.8 ms（约 9 分 56 秒）**。
- 完整 TAP 日志：`evidence/full-test.log`；修复前的全量记录保留为 `evidence/full-test-pre-p2-fixes.log`。本轮在源码冻结后使用 Node 22.23.2、`RAI_TEST_CONCURRENCY=2` 重跑；此前首轮因宿主 `PATH` 缺少 node/npm 及测试期间修改源文件而失败，未计入本轮通过。

### 6.2 2026-10-22 验收工具复核回归记录

- 工具版本：Node `v24.21.0` / tsx `v4.23.0` / SQLite `3.53.4`；已写入 `source-manifest.json`。
- 目标测试：`node --import tsx --test apps/api/test/phase2-series-hot-verdict.test.ts apps/api/test/phase2-series-window-selection.test.mjs`，**13/13 通过**（比较器 7 项、选窗纯函数 6 项，包含两侧同时写错元数据仍失败的夹具）。
- 全量：`RAI_TEST_CONCURRENCY=2 node scripts/run-tests.mjs`，2,297 项测试、2,282 通过、13 跳过、2 失败、退出码 1。两个失败均为宿主环境：`node-version.test.ts` 无法调用 npm（宿主 PATH 无 npm），`prediction-inference.test.ts` 的 ONNX 原生库签名无效；与本轮工具改动无关。日志：`evidence/full-test-tool-v2.log`。
- 静态检查：两套 `tsc` 通过；`check:docs` 0 问题；`check:acceptance-matrix` 80 条、missing 0；包边界/单写者门禁通过。

## 7. 证据索引

| 产物 | 说明 |
|---|---|
| `evidence/write-amplification-d2-v3-final.json` / `.log` / `-verify.json` | A 正式 100 轮三组证据（含原始样本、PRAGMA、WAL 帧、持久化）与独立 `--verify` 结果 |
| `evidence/write-amplification-d2-v3.json` / `...-rerun.json` | A 两次探索性失败运行（保留，不冒充通过） |
| `evidence/speedtrack-bench-d2.json` | C 5 块真实调用计数与子步骤 P95 |
| `evidence/series-dump-before-*.json` / `after-*.json` | C D0/D2 完整正文差分 |
| `evidence/http-c-baseline-d2.json` / `http-c-candidate-d2.json` | C 历史热读文件；其中 p50/oldest 为 404，已作废，不作为 C-07 证据 |
| `evidence/http-b-baseline-d2-hot-fixed.json` / `http-b-candidate-d2-hot-fixed.json` / `http-b-verdict-d2-hot-fixed.json` | 修正后 D2 热读五窗口：100 次预热、排除软删除训练、200/身份/内容校验（C-07 与 B-05 共用） |
| `evidence/http-b-baseline-d3-hot-fixed2.json` / `http-b-candidate-d3-hot-fixed2.json` / `http-b-verdict-d3-hot-fixed2.json` | 修正后 D3 热读五窗口：两侧 300 次预热、排除软删除训练、200/身份/内容校验 |
| `evidence/http-b-candidate-d3-hot-fixed-warmup100.json` / `http-b-verdict-d3-hot-fixed-warmup100.json` | D3 100 次预热的失败运行（p75 143.9 ms），保留但不纳入通过证据 |
| `evidence/http-b-baseline-d2.json` / `http-b-candidate-d2.json` | B D2 七状态 100 周期首读/事件循环；其中热读 p50/oldest 为历史 404，已作废 |
| `evidence/http-b-candidate-d3.json` | B D3 七状态 100 周期首读/事件循环 |
| `evidence/http-b-baseline-d3-hot.json` / `http-b-candidate-d3-hot.json` / `http-b-verdict-d3-hot.json` | B D3 历史热读文件；p50/oldest 为 404，已作废 |
| `evidence/http-b-verdict-d3.json` | B D3 七状态首读/事件循环/历史热读综合裁决 |
| `evidence/http-b-verdict-d2.json` | B D2 机器裁决（含历史 404 热读，仅作历史） |
| `deliverables/phase2-sqlite-2026-10-21/evidence/baseline-cfc5ba4.tar.gz` | 修正后热读基线源码快照（SHA-256 `a2a65c56…b7cf6123`） |
| `evidence/final-verdict.json` | A/B/C 最终机器裁决摘要（全部通过） |
| `evidence/dataset-hashes.txt`、`evidence/baseline-freeze.txt` | 数据/环境/锚点冻结 |
| `evidence/full-test.log`、`evidence/full-test-pre-p2-fixes.log`、`evidence/full-test-tool-v2.log`、`source-manifest.json` | 原始回归记录、修复前全量记录、2026-10-22 工具复核记录与源码指纹 |

## 8. 最终签收与阶段 3 准入

- **A：通过。** A-01～A-08 全部有可复核证据；v47 索引在 D2 的正式写入门禁（empty-wal/near-threshold）通过。A 是阶段 3 的剩余必查项，现已闭环。
- **C：通过。** 请求内速度轨迹 3→1，完整正文差分、生命周期、调用计数和 5 块性能均满足 C-01～C-07；C-07 的旧 404 窗口已作废，修正后的 D2 五窗口 200/身份/内容与门槛均通过。
- **B：通过。** B-01～B-08 均有 D2/D3 证据；`/series` 完整组装交给专属读 worker，主线程事件循环与并发健康检查回到 50 ms 内；热读五窗口在排除软删除训练后重测，全部为 200、身份一致、正文等价且满足门槛。
- **阶段 3：** A/B/C 均通过且既有 D0 差分/路径隔离/迁移冻结/回滚证据仍适用于当前代码（见阶段 2 报告与本次回归）。可以提交阶段 3 正式实施启动决策；健康索引/采样 SQL 重写仍保留为独立性能尾项，本报告不代表阶段 3 已获批准或已启动。
- **生产发布：** 不具备条件。没有生产维护窗口、磁盘预算、备份恢复演练和生产迁移执行；本次未打开仓库 `var/rai.sqlite`，未连接生产。
