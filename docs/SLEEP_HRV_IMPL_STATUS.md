# 睡眠 / HRV 设计落地排查报告

> 历史快照说明：本文主体记录 2026-09-04 的排查结果，原有“实际”列不随代码自动更新。2026-09-07 的当前实现校准见下节；阅读旧表格时应以该校准和现行代码为准。

| 字段 | 值 |
|---|---|
| 排查时间 | 2026-09-04 |
| 排查依据 | `docs/SLEEP_HRV_DESIGN.md`（PR1 / PR2 / PR3a / PR3b） |
| 排查范围 | 工作树 `main` @ `b451f04`、活库 `var/rai.sqlite`；本轮已开始 PR1-PR3 分阶段实现 |
| 基线健康度 | `npm run typecheck` 通过；完整测试中的 server runtime 失败为沙箱禁止监听端口（`listen EPERM`） |

---

## 一句话结论

**设计文档已完成审查，当前工作树已落地 PR1 的事实层和 PR2/PR3 的兼容性改造。**
schema 已加入 v17，canonical 表、导入挂钩、恢复 repository、Coach/趋势读取和预测 null 传播已实现；
个人基线的完整 as-of 接入与训练状态全量切换仍需在真实数据 shadow run 后验收。

## 2026-09-07 当前实现校准

本次项目优化已改变以下状态。这里的“已实现”仅表示代码、契约和回归测试已具备，不代表模型科学准确性或生产部署验收已经完成。

| 范围 | 当前状态 | 现行行为 |
|---|---|---|
| 恢复事实趋势 | 已接入桌面趋势页 | `TrendsPage` 请求 `/v1/recovery-trends?days=28`，展示近期睡眠、HRV、样本数和事实日期；当前接口不返回 RHR、基线带或睡眠阶段图层 |
| 恢复趋势日期 | 已修正 | API 按 `Asia/Shanghai` 本地日生成窗口，并返回 `generatedAt`、`asOf`、`timezone`、`latestDataDate`；`days` 为 1–365 的整数 |
| 恢复趋势契约 | 已共享 | `packages/api-contracts` 导出 `RecoveryTrendResponse`；缺失睡眠/HRV 保持 `null`，不补成正常值 |
| 控制库 | 已迁移到独立 SQLite | `rai-control.sqlite` 保存 `mobile_goals` 与 `mobile_goals_history`；旧 `mobile-goals.json` 只作为一次性迁移来源，目标和历史在同一事务内提交 |
| Model Run 激活 | 已统一入口 | HTTP 路由调用 `SqliteModelRunRepository.activateSucceeded()`；候选校验、active 切换和清理预测 active 在同一事务中完成 |
| 尚未完成 | 保持后续项 | 控制库与业务库的完整备份 bundle、RHR/基线趋势扩展、外部标签模型回测仍未在本次优化中完成 |

---

## 一、落地状态总表

| PR | 标题 | 落地 | 关键判据 | 状态 |
|---|---|---|---|---|
| 1 | Store nightly facts | **已落地** | migration v17、两张表、canonicalizer、CLI 挂钩与 repository 已实现 | 🟢 |
| 2 | Trends + Coach 事实卡 | **核心已落地** | `classifyPhysState`、`/v1/recovery-trends`、Coach canonical facts 已接入；桌面专用图表待补 | 🟡 |
| 3a | Feature + TA 个人基线 | **部分落地** | feature/model 版本已 bump，load-only 已禁止；完整个人基线接入待 shadow run | 🟡 |
| 3b | 训练状态 + 预测 | **部分落地** | prediction readiness 支持 null、训练状态支持 phys state；全量 pipeline 接线待验收 | 🟡 |

---

## 二、PR1 — Store nightly facts（🔴 未落地）

| 设计项 | 期望 | 实际 | 证据 |
|---|---|---|---|
| Branch | 有实现提交 | **空分支，0 提交** | 分支指向 `f70fe81`，`git log main..<branch>` 为空 |
| Schema | v17 | **v16**（`prediction_model_ability_baseline_fingerprint`） | `packages/storage-sqlite/src/database.ts`；活库 `max(version)=16` |
| `canonical_nights` | 已建表 | **MISSING** | 活库查询报 `no such table` |
| `canonical_hrv_days` | 已建表 | **MISSING** | 同上 |
| `canonicalizeNights()` | 存在 | **不存在** | `packages/health-export-parser/src/` 下无此文件，`index.ts` 未导出 |
| `localDateAt` / `localDateTimeAt` | parser utils 导出 | **不存在** | `packages/health-export-parser/src/utils.ts` 无时区函数（只有 `training-load` 有 `localDateInTimeZone`） |
| `recovery-facts-read-repository.ts` | 存在 | **不存在** | — |
| CLI 挂钩 | `importCommand` 后调用 | **挂钩点存在，未接** | `cli.ts` 已 import 并调用 `canonicalizeRunningWorkouts`，其后无 nights 调用 |
| 服务端回填 | `recoverDatabaseJobs` 挂钩 | **未接** | `apps/api/src/server.ts:263-275` 仅做 job recovery |
| 测试 | 2 个新测试文件 | **均无** | — |

### 🔴 分支已落后，需先 rebase

PR1 分支起点是 `f70fe81`，`main` 已前进 3 个提交：

- `5c966ce` audit: 全仓健康度审查与 P1/P2 修复
- `6a0d7d7` ci: Gitee Go 主干门禁草案
- `fd311ac` docs: 报告补充 gitee CI 迁移草案

其中 `5c966ce` 是全仓审查修复，与 PR1 改动区域（schema / parser / storage）有重叠风险。
**开始 PR1 前必须先 `git rebase main`。**

---

## 三、PR2 — Trends + Coach 事实卡（🔴 未落地）

| 设计项 | 期望 | 实际 |
|---|---|---|
| `classifyPhysState()` | training-load 导出纯函数 | **0 命中**（全仓 `grep` 无结果） |
| `countNightsBelowSleepBaseline()` | 同 | **0 命中** |
| `PhysState` / `recovered_phys` | 类型已定义 | **0 命中** |
| `RecoveryFactsNightDto` | api-contracts 已定义 | **不存在** |
| `/v1/recovery-trends` | 端点已注册 | **不存在**（只有 `/v1/trends`） |
| `RecoveryFactsChart.tsx` | apps/web 已建 | **不存在**（components 下 12 个文件，无此文件） |
| 桌面事实卡 1440×900 | 已渲染 | **不存在**（全仓无「昨夜恢复」/「过夜 HRV」文案） |
| `MobileRecoveryBreakdown` 扩展 | 带 `state` / `sleepStages` / `hrvSampleCount` / `triggers` | **仍是旧版 8 字段**（`packages/api-contracts/src/index.ts:508-517`） |
| `ios/Home.tsx` 渲染 recovery | 已渲染 | **无 recovery 引用**（文件存在，9KB，无匹配） |
| `state: "unknown"`（iPhone-only 表） | 已实现 | **未实现** |

**Coach 现状（缺陷 #3 原样保留）** —— `apps/api/src/mobile-coach.ts:398-427`：

```
return { score: input.recoveryEvidence, ... }
```

卡片上的 `score` 字段**仍然是训练负荷 EWMA**，与睡眠/HRV 无关。这是设计文档明令要拆掉的
「负荷戴生理帽子」问题，未动。

---

## 四、PR3a — Feature + TA 个人基线（🔴 未落地）

| 设计项 | 期望 | 实际 | 证据 |
|---|---|---|---|
| `FEATURE_CONFIG_VERSION` | `v8` | **`v7`** | `packages/features/src/index.ts` |
| `MODEL_CONFIG_VERSION` | `v3` | **`v2`** | `packages/scoring/src/model.ts` |
| 库内 feature 版本分布 | 含 v8 | **804 行全是 `feature-config-v7`** | 活库 `provenance_json` 统计 |
| `recoveryRaw` 子权重 35/25/25/15 | 已实现 | **旧公式**（`loadMinutes / (7*60)` 项仍在） | `packages/features/src/index.ts:448-450` |
| 三生理全缺 → `null` | 已实现 | **未实现** | 同上，`average(recoveryParts)` 无 null 短路 |
| `directionFactor` 分支 | `(dimensions.recovery ?? 50) < 40` → `recoveryRaw === null` 分支 | **仍是 `?? 50`** | `packages/scoring/src/model.ts:354` |

> ⚠️ **PR3a 的版本 bump 不能漏。** 设计文档已明确：只改公式不 bump 版本，
> `configHash` 会让新公式复用旧 prefix 的缓存，CA 会静默冻在旧值上。

---

## 五、PR3b — 训练状态 + 预测（🔴 未落地）

| 设计项 | 期望 | 实际 |
|---|---|---|
| `buildDailyTrainingMetrics(recovery: PhysDailyEvidence[])` | 类型已换 | **仍是 `RecoveryEvidence[]`**（`packages/training-load/src/index.ts:34, 212`） |
| `loadRecoveryReadiness` 删掉无条件 `scores.push(负荷)` | 已删 | **仍在**（`packages/application/src/prediction-data.ts:531-535`，无条件 push 4 个分数） |
| 三生理全缺 → `recoveryReadiness = null` | 已实现 | **函数签名返回 `number`，永不 null**（`:494-497`） |
| `RacePredictionConditions.recoveryReadiness: number \| null` | 可变 null | **仍为 `number`**，默认值 `0.87`（`packages/physiology/src/index.ts:867-870`） |

---

## 六、活库事实复核（设计文档的「事实层核对」全部属实）

| 指标 | 设计文档 | 活库实测 | 一致 |
|---|---|---|---|
| Sleep 总行数 | 5693 | **5693** | ✅ |
| Watch 睡眠行 | ~5479 | **5479** | ✅ |
| iPhone 睡眠行（全 InBed） | 214 | **214，全部 `HKCategoryValueSleepAnalysisInBed`** | ✅ |
| HRV SDNN 点 | 1532 | **1532** | ✅ |
| RHR 点 | 413（206+207） | **413** | ✅ |
| Schema 版本 | v16 | **v16** | ✅ |

---

## 七、缺陷在活数据上的实证（新增，超出原设计文档）

从 804 行 `workout_features.features_json` 提取 CA/TA **实际吃到的**生理输入：

| 字段 | n | min | p50 | p95 | max | 判读 |
|---|---|---|---|---|---|---|
| `sleepDurationMinutes` | 363 | 1.5 | **424.2** | **702.5** | **938.0** | 🔴 缺陷 #1 实证 |
| `hrvSdnnMs` | 588 | 21.2 | 47.0 | 53.9 | 56.9 | 🔴 缺陷 #2 实证 |
| `restingHeartRateBpm` | 600 | 57.2 | 71.3 | 87.3 | 101.0 | 正常 |
| `recentLoadMinutes` | 735 | 7.6 | 164.5 | 364.9 | 884.3 | 正常 |

### 🔴 缺陷 #1：重叠 `Asleep*` 求和 —— 43.8% 的「夜」超过 8 小时

- **159 / 363（43.8%）** 的 `sleepDurationMinutes > 480 min`
- **48 / 363（13.2%）** 超过 600 min（10 小时）
- 最大值 **938 分钟 = 15.6 小时**，物理上不可能

直接后果：`recoveryRaw` 的睡眠子项 `min(sleep/480, 1)` 在近半数样本上**恒等于 1.0**，
该子信号事实上被静音。

### 🔴 缺陷 #2：28 天全样本均值 —— HRV 被压成一条平线

- 全样本极差仅 **35.7 ms**，但 **p50→p95 只差 6.9 ms**（47.0 → 53.9）
- 个体内真实的日间 SDNN 变异通常在 ±15–25 ms，现算法把它压到 ±7 ms 以内

直接后果：HRV 子项 `min(hrv/100, 1)` 在全部样本上落在 **0.21 – 0.57** 的窄带内，
**几乎不携带区分度**。恢复维度当前实质上由 sleep（已失真）+ load 主导。

> 补充观察：按 `loadSleepDurationMinutes` 的 36h 窗口复算，粗分组最大可达
> **1328 分钟（22 小时）**。该数字口径为「(源, 日历日) 朴素聚合」，比设计文档的
> 739 min（Watch-only 分组）更宽松，仅作量级佐证，不作为验收基准。

---

## 八、阻塞项与下一步建议

### 立即可解（无依赖）

1. **PR1 分支先 rebase 到 `main`**（落后 3 个提交，含全仓审查修复 `5c966ce`）。
2. 按设计文档 §PR1 落地 schema v17 + `canonicalizeNights` + CLI 挂钩 + 空表回填。

### 需要你确认的两个决策点

| # | 问题 | 背景 |
|---|---|---|
| 1 | **PR1 的 schema v17 是否顺带修正 `docs/DATABASE_DESIGN.md`？** | 该文档当前未标注 schema 版本号（`grep v16/v17` 无命中），已与 `database.ts` 脱节。建议 PR1 一并补上，否则下一个 PR 又会踩同一处。 |
| 2 | **PR3a 的 804 行历史 feature 如何处理？** | bump 到 v8 后全量重算即可，但需确认是否接受一次全量 Model Run 的耗时与 CA 重排（CA 数值会整体位移）。 |

### 不建议现在做的

- 不要跳 PR1 直接做 PR2/PR3a。PR1 的两张表是 PR2 事实卡和 PR3a 基线的唯一数据源，
  跳过会让 PR2 被迫从 `health_records` 现算，等于把缺陷 #1/#2 复制进新 UI。
- 不要在 PR1 里动 `analyzeDatasetChange`（设计文档 §决策 11 已明确：睡眠仍触发
  full Model Run，避免 CA 冻在旧求和上）。

---

## 九、排查方法备注

本轮采用「四路独立取证」而非只读文档：

1. **Git 取证** —— 分支提交数、分支与 main 的落后关系、stash / 远程分支。
2. **代码取证** —— 对设计文档列出的每一个新符号做全仓 `grep`，以「0 命中」为未落地的硬判据。
3. **活库取证** —— 直接查 `var/rai.sqlite` 的 `schema_migrations` 与表存在性，
   不以文档描述为准。
4. **数值取证** —— 从 `workout_features.features_json` 反解出 CA 真实输入分布，
   用分位数验证缺陷是否真的影响模型，而不只是「代码里看着不对」。
