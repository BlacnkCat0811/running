# 最新跑步「训练详情缺数据」——线上只读排查报告

- **日期**：2026-10-15（京时，UTC+8）
- **排查对象**：最新一次跑步 `training_session_a561995e323c24753075e597e2976edb`（10-14 20:54–21:28 京时，5.22 km，Apple Watch）
- **方法**：匿名只读 API（`tpandmr.xyz`）+ 云机（`lhins-3gatdqed`）两库只读查询 + nginx 日志 + 本地源码对照。全程未写任何数据。
- **状态**：诊断完成；修复方案见 §五，等确认后执行。

---

## 一、结论（先行）

**不是这次跑步数据本身的问题，也不是服务端去重/写入缺陷。**

- **直接原因**：该次跑步在服务端**没有任何逐条心率样本**。详情里能看到的「平均心率 163.5」来自 workout 自带统计（`WorkoutStatistics`），不是逐条样本；据此算出的心率覆盖率仅 **3.0%**，命中 `heart_rate_coverage_low`，评估被降级为 **trial**，详情页表现为「缺数据」。
- **根本原因**：**服务端库里 10-13 21:11 京时之后再没进过任何一条健康记录样本**。手机端（iOS）自 10-14 起处于「**记录全史重放**」状态——52.7 万条历史记录要从旧到新重发一遍，**10-13 21:11 之后的新记录（含这次跑步的心率）排在队列末尾**，按当前推进速度远未轮到。
- **量化**：近 30 小时 4 批同步共消化约 **1.7 万 / 52.67 万条（≈3.2%）**；剩余约 **113 批**（4,500 条/批）。

---

## 二、判据链（逐条落证据）

### 2.1 这次跑步「缺了什么」

| 字段 | 线上值 | 含义 |
|---|---|---|
| `missingReasons` | `["heart_rate_coverage_low"]` | 唯一缺失项：心率覆盖率低 |
| `heartRateSampleCount` | **1** | 不是真的采到 1 条样本 —— 是「统计占位」（见 2.4） |
| `heartRateCoverage` | **0.030077** | = 1 ÷ (1994.856s ÷ 60) ≈ 3% |
| `averageHeartRateBpm` | 163.4975 | 来自 workout 自带 `WorkoutStatistics`，**非逐条样本** |
| `assessmentStatus` / `eligibilityStatus` | `trial` | 评估降级（非完整评估） |
| `stimulusConfidence` | 0.4 | 刺激类型置信度被压低 |
| `confidenceFactors.coverage` | 0.717 | 置信度因子中被覆盖率拖低 |
| `trueAbilityDelta` / `updatedTrueAbility` | 0 / false | 不参与能力更新 |
| 派生字段 | `averageCadenceSpm`、`averagePowerWatts`、`averageStrideLengthMeters`、`averageVerticalOscillationCm`、`averageGroundContactTimeMs` 全为 `null` | 次生缺失（同因） |

### 2.2 服务端记录「停在哪」

| 判据 | 实测值 | 来源 |
|---|---|---|
| `health_records` 全表最大 `start_at` | **2026-10-13T13:11:26Z**（京时 10-13 21:11） | `SELECT MIN/MAX/COUNT ... WHERE start_at >= '2026-10-13'` → 657 条全在 10-13 当天 |
| `start_at >= '2026-10-14'` 的样本数 | **0** | 云机只读查询 |
| 最后一次 `record` 类变更批次 | `web_import_mv6p9zyl`（10-13 21:16 京时） | `import_entity_changes`（`entity_kind='record'` 排序） |
| 最近一次成功导入完成时刻 | 10-13 21:16 京时（该批 5947 条记录全部为新插入） | `import_batches` |

### 2.3 10-14 以来 4 批同步：记录 0 插入（批级对账）

| 批次（京时） | 记录数 | 记录插入 | workout | route | 备注 |
|---|---|---|---|---|---|
| 10-14 18:29 | 3000 | **0** | 287 个（274 个被"更新"） | 62 个（46 个重写） | **全量回填首批**（34MB route 批） |
| 10-15 06:42 | 5000 | **0** | 10 | 10（0 变更） | 内容生成于 10-14 20:54（上传曾中断，见 3.3） |
| 10-15 16:32 | 4500 | **0** | 10（**买入 10-14 跑步 1 个**） | 10（**导入 1 个新 route**） | 跑步 workout 送达 |
| 10-15 17:01 | 4500 | **0** | 10 | 10（0 变更） | — |

**关键对照**：workout / route 侧「该插的插了、该跳的跳了」（route 甚至 9 跳过 + 1 导入），**证明服务端差分/去重判定工作正常**；唯独记录侧 4 批 4,500×N 条**全部判定为「已存在」**——说明**发来的这几千条记录 100% 是库里已有的旧数据**。

### 2.4 「sampleCount=1」的来源（已核实）

无逐条样本时，特征提取回落到 workout 自带的统计条目，并**故意**设 `sampleCount: 1`：

- `packages/application/src/recompute-helpers.ts:191-230` `fallbackStatisticSummary()`：`sampleCount: 1`（注释原文：*"keep count low so eligibility does not treat them as full series coverage"*）、`coveredDurationSeconds: null`
- `packages/features/src/index.ts:334-341` `heartRateCoverage()`：`coveredDurationSeconds` 为空时走采样密度分支 → `1 ÷ (1994.856/60) = 0.0301` ✓ 与线上精确吻合

### 2.5 「重放队列」的存在与速度

| 判据 | 值 | 来源 |
|---|---|---|
| 单批记录预算 | **4,500 条** = 服务端 `maxRecords` 5000 × 0.9 | `apps/ios/RAI/DirectSyncBatchBudget.swift:41-49` |
| 每批均满载（4500/5000） | 队列有大量积压 | 批级 summary |
| 每轮同步的推进 | 30 小时 = 4 次上传 = 4 批 | nginx access.log |
| 「续批」纪律 | 源码注释原文：*「用户不打开 App 就再也没人接着发下一批」* | `apps/ios/RAI/HealthKitSync.swift:1825-1828` |
| 全量基数 | 526,672 条记录 | `/v1/data-audit` `canonical.healthRecords` |
| 剩余批次 | ≈ (526,672−17,000) ÷ 4,500 ≈ **113 批** | 推算 |

### 2.6 为什么「workout 到了、记录没到」（同一条链上的分层）

- **workout / route 有窗口**：重读窗口为最近 14 天（`HealthKitExport.swift:248` `routeBackfillWindow = 14 * 24 * 60 * 60`），量小，**10-15 16:32 批已把 10-14 的跑步和 route 追平**。
- **记录没有窗口**：无锚点时走纯历史重放（`apps/ios/RAI/HealthKitRecordCursor.swift:151`：`if history, !decodedAvailable { return [.historyFromScratch] }`）——**从全史最旧开始**，量太大，追不上。
- **动态对照**：同一批里「workout 新的插入了、record 一条没插」——说明**不是通道死锁，是记录队列排队**。

---

## 三、事件时间线（京时，全部有线上痕迹）

1. **10-13 21:11**：最后一次「新记录」入库（5947 条；库内样本止于此）。
2. **10-13 晚起异常**：iOS 未完成该批的回执确认（服务端当天无拉取记录）。
3. **10-14 09:58–17:29**：iOS **反复读 10-13 那批的回执 30+ 次**——确认回路卡住（症状：同步"转"但不推进）。
4. **10-14 17:04**：服务端部署「收口版」（显式拒绝；`ed556a3`）。
5. **10-14 17:35**：iOS 上传「全量回填批」= **状态复位指纹**（287 个 workout、62 个 route、34MB route 数据）→ 被收口版 `xml_exceeds_bounds + route_exceeds_bounds` **双拒（400）**。
6. **10-14 18:23**：服务端放宽上界（`f7b2bc3`：xml 2→8MiB、route 32→64MiB）→ **18:29 重试成功**。**「全史重放」从此开始爬**。
7. **10-14 20:54:37**：另一次上传 **499（客户端中断）**——正值用户开跑（20:54:46）。
8. **10-15 06:42**：中断批重传补上（第 2 批重放）。
9. **10-15 16:32 / 17:01**：第 3、4 批重放；跑步与 route 追平；回执与分析对账回路均正常（16:32 批轮询到终态、17:01 批还做了分析任务对账）。
10. **当前**：重放进度 ≈ 3.2%；**10-13 21:11 之后的新记录仍在队尾**。

**注**：「全量回填 / 状态复位」的**触发者**（手动「重新导入全部」还是重装 App 后首次同步自动触发）无法从服务端判定，需你回忆 10-14 下午的操作；两种情况的行为等价（都从零重放）。

---

## 四、已证伪 / 未排除

**已证伪（别再查）**：
- ❌ 服务端去重/写入缺陷 —— route「9 跳过 + 1 导入」、workout 正常插入，差分正常。
- ❌ 数据源没产生 —— workout 自带统计 163.5、route 1995 点完整，手表在测。
- ❌ 同步链死锁 —— 回执轮询、分析对账、上传链路全部活着。
- ❌ 契约版本不符 —— 两端 `factsAnalysisContractVersion` 均为 1（`/v1/handshake` 实读）。
- ❌ 时区导致过滤 —— 无其它 timezone 分组迹象；样本绝对缺失而非"有行被滤掉"。

**未排除 / 待确认**：
- 🟡 10-14 白天「反复读回执却不前进」的精确机制（假设：旧格式回执缺 `directSync` 字段→ `.hold(no_receipt)`，未直接验证）。
- 🟡 「重放从最旧开始」为最强解释（全量首批指纹 + 0 插入 + 批批满载），但**批量内容无法回看**（源 zip 已被清理）。
- 🟡 重放进度 3.2% 是**推算**，精确进度只能从手机端同步状态看。

---

## 五、修复建议（分级，未执行）

### P0 — 恢复数据（二选一或并用）

**A. iOS 端：先「近端窗口」后「历史重放」（推荐，治本）**
- 现状：无锚点时 `RecordReplayPlan` 只有全史段（`HealthKitRecordCursor.swift:151`）。
- 改法：在历史段**之前**插入一个「窗口段」（如最近 7 天、按时间谓词查询全类型），把**近期数据优先送达**；历史重放继续在后台跑。
- 预期效果：**1–2 批即可补齐 10-13 21:11 之后的全部数据**（含本次跑步心率）。
- 备选改法：历史重放起点对齐服务端覆盖点（`/v1/data-audit` 的 `ranges.healthRecords.last` − 安全余量）；代价是会跳过跳过区内的删除事件，需设计权衡。

**B. 服务端：临时放宽 bounds —— ⚠️ 已降级为「R1–R4 修完后的可选加速项」（2026-10-15）**
- 依据同步链审查 §5：R1–R4（后台续批 / 无变化回执 / 删除预算 / 下溢）未修前，放大上限只是**改变故障触发点**、增加后台单次工作量，不应作为先行手段。
- 细节保留备查：`direct-sync-ingest.ts:62` `DIRECT_SYNC_MAX_XML_BYTES = 8 MiB`、`maxRecords 5000`；放宽后 iOS 预算自动跟随（×0.9），受 xml 上限卡位单批约可提到 ~1.5 万条；风险 = 单批事务时长 / 内存（`deploy/rai-api.service:33` `MemoryHigh=1100M`）+ 需连带更新钉常量的测试（如 `direct-sync-http-acceptance.test.ts`）。

### P1 — 补齐之后的「二次动作」（2026-10-15 修正：评分类型自动重算，无需手动）

- ~~原表述「记录批（record-only）恒为 `not_required`——记录到达不会自动重算既有 workout」~~ **已修正**：是否登记分析由**变更账本**决定（`record-delta-policy.ts:101-119`，默认方向是「必须分析」）——含心率/跑速/静息心率/睡眠/HRV/VO₂max 等**评分类型真实变更**（或未知类型/Workout/路线/删除）的批会登记分析任务（`analysisStatus: "queued"`、`analysisJobId` 非空）；只有「变更账本为空」或「仅非评分白名单类型变更」的批才是 `not_required`（`packages/contracts/src/index.ts:59-66`；`direct-sync-ingest.ts:564-581` 的 `ledgerFacts` 只含真变更）。
- ⇒ **心率样本补齐时会自动登记分析并重算**，不预设手动动作；本条保留为「万一没自动登记」时的排查点（先看该批 summary 的 `analysisJobId`）。

### P2 — 根因与观测（后续）

- 「重新导入全部」/重装后的重放成本提示与「优先近端」策略（产品级）。
- 重放场景下 274 个历史 workout「updated」的哈希稳定性复查（疑似与 10-14 全量批的内容表示漂移有关）。
- 训练详情页文案：缺数据时明示「同步队列中」而非只显示 trial。

### 立即注意事项

- 🔴 **不要点「重新导入全部」**——它会清零已推进的游标/水位，从头重放（当前 3.2% 的进度也会白费）。
- 想临时验证「每轮一批」：连续手动触发同步，每次可推进 ~4,500 条；**113 次不现实**，只用于验证。

---

## 六、证据索引

| 位置 | 内容 |
|---|---|
| `/v1/workouts/{id}`（线上） | 详情全字段（缺失项清单） |
| `/v1/data-audit`（线上） | `ranges.healthRecords.last=10-13T13:11:38Z`、`minimumHeartRateCoverage=0.0301` |
| `health_records` MAX(start_at)（云机主库） | `2026-10-13T13:11:26Z`；≥10-14 为 0 条 |
| `import_batches / import_entity_changes`（云机主库） | 4 批记录 0 插入；最后 record 批次 = mv6p9zyl |
| `import_jobs.performance_json`（云机 runtime 库） | lane 遥测：`data-only` 被拒 → `direct-sync` 接收 |
| nginx `access.log(.1)` | 10-14 回执重试 30+ 次；17:35 inspect 400；20:54 uploads 499；16:48/16:55 部署 |
| `apps/ios/RAI/DirectSyncBatchBudget.swift:41-49` | 预算 = bounds × 0.9（4,500 条/批） |
| `apps/ios/RAI/HealthKitRecordCursor.swift:151` | 无锚点 → 纯 `historyFromScratch` |
| `apps/ios/RAI/HealthKitSync.swift:1825-1828` | 「用户不打开 App 就再也没人接着发下一批」 |
| `apps/api/src/direct-sync-ingest.ts:62,719,782` | bounds 常量；`analysisRequired` 判定（:719）；`queued`/`not_required` 分支（:782，仅按账本变更判定） |
| `packages/application/src/recompute-helpers.ts:191-230` | `sampleCount: 1` 统计占位 |
| `packages/features/src/index.ts:334-341` | 覆盖率 = 1/(duration/60) ≈ 3% |

---

## 附：如果「什么都不改」——等待路径推演（2026-10-15 追加）

**前提**：不修 iOS、不放宽 bounds、正常使用（并守住下方三条红线）。

### 为什么「心率」会先到、睡眠会最后到

重放按**类型顺序**推进（`HealthKitExport.swift:918-966` 的 `descriptors` 数组：heartRate 排第 1、sleepAnalysis 排最后；`for … if budgetStopReason != nil { break }` = 预算停在哪个类型，下一轮从该类型续）。且每个类型内部从最旧→最新。已推的 4 批 ≈ 1.7 万条全部落在 **heartRate** 类型内。

### 推演表

| 时间（按 2–3 批/天节奏） | 状态 |
|---|---|
| **~1–2 周** | **heartRate 追平**（剩余 ≈ 9.36 万条 ≈ 21 批）：此后**新跑步的心率样本会到位** |
| ~3–5 周 | distance / energy / step / speed / power 等依次追平 |
| **~1.5–2 个月** | **sleepAnalysis 最后追平** → 睡眠 / HRV / 恢复评估恢复（全量剩余 ≈ 51 万条 ≈ 114 批） |
| 全程期间 | 每次跑步详情评估 = trial；恢复/睡眠覆盖持续停在 10-13；服务端空转（每批 ~2.5MB 重复上传 + 解析，累计数百 MB） |

### 与「什么都不改」绑定的四个事实

1. 🔴 **本次跑步（10-14）的 trial 会在心率送达时自动转正**（2026-10-15 修正）：原「记录补齐不触发重算（record-only → `not_required`）」的表述不准确——是否登记分析由**变更账本**决定，心率属评分类型，其**真实变更**会登记分析并自动重算（`record-delta-policy.ts:101-119`；`scoringHealthTypes` 含心率等 6 类）。前提只剩一条：重放队列真正把 10-13 21:11 之后的心率送达（见上表 ~1–2 周）。
2. **三条红线**（比「改什么」更重要）：
   - ① 不点「重新导入全部」（清零进度、从头再放）；
   - ② 不重装 App / 不清 App 数据（本地游标清零 = 从头再放）；
   - ③ 别让手机长期不开 App（后台只兜底；「用户不打开 App 就再也没人接着发下一批」）。
3. **半主动加速（不改任何代码）**：多触发同步 —— 每次 ≈ 4,500 条，每天触发 6–10 次可把 1.5–2 个月压到 1–2 周（手动节奏，烦但有效）。
4. **卡壳会暂停进度**：若再遇同步「转但不推进」，先看服务端是否还有新批入库；现版本（`9e08301`）已含显式失败/恢复加固，比 10-13 时结实，但仍可能停。

**结论**：纯等**不损坏数据**（HealthKit 是源、服务端数据完整）；心率约 1–2 周到位后会**自动登记分析并重算**（评分类型真实变更；2026-10-15 修正——不再假设需要手动重算），恢复评估约 1.5–2 个月。但等待期的代价（每次跑步 trial、恢复评估缺失、空转流量）仍然真实——最短路径依然是「近端窗口先行」（现已并入实施计划 B1：`IOS_SYNC_INGEST_REVIEW_OPTIMIZATION_2026-10-15.md` 的 R5）。
