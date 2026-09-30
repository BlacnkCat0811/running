# RAI V2 批次 17 实施记录 —— 三方残差竞争、Readiness 窄化、epoch 分段与 Load 回放

日期：2026-09-30
对象方案：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md`
上一份记录：`deliverables/RAI_V2_IMPLEMENTATION_2026-09-29.md`、`deliverables/RAI_ALGORITHM_V2_REMAINING_DESIGN_2026-09-29.md`

## 结论

**本轮关闭了剩余项里的 4 项工程缺口（D8、D7 剩余、D5 剩余、D10 的 Load 部分），全部带测试与突变验证。**
仍未关闭的是 D6（真实环境 adapter）、D2 的真实库重建与 D11（真实退步验收，受真实标签约束）。
本轮**没有**执行数据库迁移、全量重算、模型激活或部署；本地库仍是 09-04 激活的那一个。

## 1. D8：Ridge / CatBoost / baseline 同样本三方竞争

**改之前**：Python runner 产出 `ridgeChallenger.releaseHoldout`，TS 侧另有 `compareResidualChallengers`，
但**两边从未喂进同一批样本**，所以"CatBoost 是否同时优于基线与 Ridge"这个问题没有同一份证据能回答。

**改之后**：Python 产出同一份样本表，TS 侧只负责读表并把门槛交给既有函数。

| 层 | 改动 | 关键约束 |
|---|---|---|
| `research/rai_ml/pipeline.py` | 新增 `_challenger_document(...)` 与 `challengers.json`（进 `artifactFiles`，同 `evaluation.json` 里登记一行 `challengers`） | 三列预测**必须逐事件对齐**；缺少的列写 `null`，写 `0` 会被读成"完美预测"、写 `Infinity` 会被读成"无限差" |
| `packages/application/src/prediction-challengers.ts` | `readResidualChallengerImport` / `evaluateResidualChallengers` | **不重写任何门槛**；缺列时把该列置空，让 `@rai/model-eval` 既有的"缺一列即 `not_evaluable` 且 `blocksActivation`"规则生效 |
| `packages/application/src/prediction-challengers-cli.ts` | `npm run data:prediction-challengers`（只读，不碰数据库） | 外层判别键叫 `report`，**不叫** `status` —— `status` 属于门槛结论，不能被报告类型盖掉 |

`challengers.json` 的形状（`rai-residual-challengers-v1`）：

```text
{ challengersVersion, predictorVersion, ridgeVersion, asOf, partition, caseCount,
  incompletePredictionColumns, cases: [{ eventId, distance, predictedAt, outcomeAt,
  availableAt, actualSeconds, baselinePredictedSeconds, ridgePredictedSeconds,
  catboostPredictedSeconds }] }
```

`asOf` 取**训练标签截止时间**（`_validate_training_cutoff` 已保证全部 `label_available_at ≤ asOf`），
所以 TS 侧 `validateCases` 的 as-of 断言是真在起作用的，而不是一个恒真的装饰。

### 一个被冒烟测试抓到的真 bug

CLI 第一版写的是 `document: parseResidualChallengerFile(path)`，而那个函数当时返回**已导入**的结构，
于是 `evaluateResidualChallengers` 又对它做了一次导入校验 —— **校验跑在转换后的对象上，等于没有校验**，
运行时直接报 `Unsupported challenger document version: undefined`。
修法不是加判断，而是让 `parseResidualChallengerFile` 只做"读文件 + JSON 解析"，返回原始文档，
校验只保留一处。**这是"函数名承诺的层次"与"实际返回的层次"不一致造成的**，只跑单元测试不会暴露，
因为它需要一次真实的文件读取路径。

## 2. D7 剩余：`readiness` 域快照的窄化，并接上真实消费方

窄化函数（`packages/contracts`）在**任一必需字段缺失或畸形**时返回 `null`，从不回落：

- `coverage`/`assessment`/`state`/`scoreStatus` 必须是各自联合的成员 —— **不认识就是"这不是一份 readiness 快照"**，
  不是"今天没评估"；
- `stateEvidence` 必需，`method` 必须是 `heuristic_rules`、`validationStatus` 必须在枚举内 ——
  §7.4 的启发式/验证标签因此不可能被读端静默丢掉；
- 缺 `score` 键 ≠ `score: null`；`NaN`/`Infinity`/字符串一律判畸形，不归一成 `0`；
- `signals` 的 `sleep`/`hrv`/`rhr` **缺一即整份 `null`** —— 少一个通道不是"更小的快照"，而是不可比的另一份；
  每个通道的 `name` 必须等于它所在的键（否则消费方取 `signals.sleep` 会拿到另一条通道且不报错）；
- 本轮**补充**了 `sleepStreak`（布尔，必需）与 `reasonCodes`（非空字符串数组；**空数组合法**）：
  解释层只格式化这些码，不重跑阈值分支（§13.3）。缺键是畸形，补一个 `false`/`[]` 就是把
  "这份快照没说"读成"规则说了没有"。

**消费方**：`HistoricalModelReview` 现在多显示一段已封存的恢复状态（`恢复提示：需谨慎（信号齐全；基于个人基线的经验规则，尚未经实证校准，仅供训练安排参考）` + 依据码 + 规则集版本）。
缺失或形状不符时**整段不显示**，不回落成"未见低信号"。文案测试同时禁止"医学阈值""已证实""完全恢复"这类措辞。

## 3. D5 剩余：epoch 分段的长期曲线

- `trendChartSeries`：换标尺后的**第一个点**从 `null` 开始（曲线断开）。断点落在新 epoch 的第一天，
  错位一天会让读者以为旧标尺还多撑了一天。
- `trendEpochSegments` / `trendEpochBoundaries`：`null`（未知 epoch）是**自己的一段**，
  不并进上一段 —— 并进去等于用一个不知道的标尺去延续一条已知标尺的曲线。
- 分段底色（第一个 epoch 不上色，之后每段加底色），epoch 变化处画分割线并标"基线重建"；
  图下文案："此处基线重建（日期）：分数标尺已变，不代表该日体能突变；两侧不可直接比较，也不跨基线计算区间涨跌。"
- `calibrating` 区间单独用紫色底色 + 文案说明（样本仍在积累，分数尚未定型）。

## 4. D10：Load 域的跨策略回放

`packages/application/src/load-replay-v2.ts`，与已交付的 Readiness 回放同构：
**两条分支调用同一个生产函数** `buildDailyTrainingMetricsV2`，只差"到达时间假设"。

| 分支 | 到达时间假设 |
|---|---|
| `observation_time_arrival_counterfactual` | 把观测时间直接当作到达时间（"事实发生时即刻到达"） |
| `training-load-config-v5` | 按**真实** `availableAt` 判定（`null` 即不可用） |

两者之差 = **"把观测时间当可用性"会改变多少天的负荷裁决**。实测（合成 8 周历史 + 一条 01-20 观测、
02-20 才导入的训练，as-of=02-01）：

| 分支 | 纳入事实 | 当日训练状态 | 长期 EWMA | ACWR |
|---|---:|---|---:|---:|
| 反事实（即刻到达） | 29 | `effective_stimulus` | 67.18 | 0.980 |
| 生产（真实到达） | 28 | `maintaining` | 61.57 | 0.827 |

⇒ `rulingEqual: false`，`arrivalSensitiveExplanationCodes: ["load_maintaining"]`。
**负荷序列是滚动的**：一条迟到导入的训练会改写它之后每一天的 ATL/CTL，所以"当时是否已经知道这条记录"
在本域是**实打实会改变裁决**的，不是元数据装饰。报告同时明确 `accuracyStatus: "not_evaluable"` ——
它衡量的是可用性口径的影响，不是模型精度。

## 5. 门禁（本轮，独占跑）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| node 侧全量 | **EXIT=0** = **1039 tests / 1021 pass / 0 fail / 18 skipped**（基线 1015/997/0/18，本轮 +24） |
| web 侧全量 | **EXIT=0** = **18 文件 / 111 tests**（基线 17/102，本轮 +1 文件 +9 用例） |
| Python（`pytest research/tests`） | **EXIT=0** = **26 passed**（基线 23，本轮 +3） |

> 计数口径：node 侧用**带引号的 glob**交给 node 自己展开。
> 直接跑 `npm test` 在本机（Windows/cmd）只会跑到 498 条 —— 这一点已实测，记录在此以免下次误判为回归。

## 6. 突变验证（每条都实际执行、观察、还原）

| # | 突变 | 结果 |
|---|---|---|
| 1 | Python：删掉挑战者列长断言 | 🔴 `test_challenger_document_refuses_misaligned_columns` |
| 2 | TS：删掉"声明完整性 vs 数据"比对 | 🔴 `D8: a document cannot declare itself complete while carrying a null column` |
| 3 | TS：部分缺失的 ridge 列直接透传 | 🔴 `D8: a missing Ridge column is not_evaluable and blocks activation` |
| 4 | TS：`null` 预测读成 `0` | 🔴 3 条转红（缺列、声明不符、null baseline） |
| 5 | Readiness：`sleepStreak` 缺失回落 `false` | 🔴 `readiness narrowing keeps the streak flag and reason codes faithful to the rules` |
| 6 | D5：TA 跨 epoch 不断线 | 🔴 `B02/D5: breaks the TA line at an epoch change` |
| 7 | D5：删掉"标尺已变"文案 | 🔴 `B04/D5: the chart states that two epochs are not directly comparable` |
| 8 | D10：生产支忽略到达时间 | 🔴 2 条转红 |
| 9 | D10：裁决投影过粗（只看"是否评估了当天"） | 🔴 5 条全红（该突变同时打断了 `explanationCodes`，比预期更宽） |
| 10 | Web：恢复状态缺失时回落成 `no_low_signal` | 🔴 `R01/I02: no readiness claim is rendered when the sealed payload is absent or malformed` |

## 7. 剩余 11 项的最新状态

| # | 项 | 状态 |
|---|---|---|
| 1 | V4 特征全链路 | 🟡 代码路径已是 V4（`recompute-pipeline.ts` 走 `extractWorkoutFeatureVectorV4` + `encodeFeaturePayloadV4`）；**真实库仍是 V3**，重建未做 |
| 2 | 版本/谱系落库分离 | ✅ 列、读端、API、界面均已接通（批次 16） |
| 3 | transition gate v2 + bundle 原子发布 | ✅ 含拒绝留痕与回滚语义（批次 16） |
| 4 | assembler freshness 统一 | 🟡 到达时间已成为可见事实；`as_known_then` 的裁决留给真正按该模式回放的调用方 |
| 5 | rebase 发布流程与 epoch 分段曲线 | 🟡 CLI `rebase` + 本轮 epoch 分段 UI 已完成；**整套重建发布流程未做** |
| 6 | 环境 adapter 生产统一 | 🟡 N1（复用既有条件惩罚）已在 physiology 落地；**没有 fitted adapter**，V4 特征路径的环境状态永不 `applied` |
| 7 | 快照贯穿实际 API | 🟡 fitness / load / readiness 三个域已窄化并有消费方；durability / zones 等有消费方再做 |
| 8 | Ridge/CatBoost 同样本三方对比 | ✅ **本批完成**（Python 产出 + TS 导入 + CLI + 双侧测试） |
| 9 | 区间 calibration 持久化与选择器 | ✅ 已实现；只差"独立标签到位后跑一次真校准" |
| 10 | 跨领域 replay | 🟡 Fitness（跨版本）、Readiness、**Load（本批）** 均有入口；Coach 未做（决策层） |
| 11 | 候选参数实证与真实退步验收 | ❌ 受真实标签约束（本地 0 条已确认比赛/测试） |

## 8. 复现命令

```bash
cd D:\running
npm run typecheck

# node 侧全量（必须带引号，交给 node 自己展开 glob）
node --import tsx --test "packages/*/test/*.test.ts" "apps/api/test/*.test.ts"

npm run test -w @rai/web
research\.venv\Scripts\python.exe -m pytest research/tests -q

# 本批新增的定向用例
node --import tsx --test packages/application/test/prediction-challengers.test.ts
node --import tsx --test packages/application/test/load-replay-v2.test.ts
node --import tsx --test packages/contracts/test/domain-snapshot-narrowing.test.ts
npm run test -w @rai/web -- ability-chart-epoch
npm run test -w @rai/web -- historical-model-review

# 三方对比 CLI（只读；--minimum-samples 默认取发布门槛）
npm run data:prediction-challengers -- --challengers <artifact>/challengers.json
```
