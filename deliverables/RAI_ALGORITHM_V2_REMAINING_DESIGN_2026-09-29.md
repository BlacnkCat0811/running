# RAI V2 剩余待优化项设计 —— 2026-09-29

对齐：工作区（HEAD `62b4a97` + 未提交改动）；方案主干 `RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md`；
实施记录 `RAI_V2_IMPLEMENTATION_2026-09-29.md`；进度排查 `RAI_V2_PROGRESS_STATUS_2026-09-29.md`。

**本文主体是设计**；唯一已落地的代码是 §4 的最小切片与 §7 的迁移 v24（D1 + D4 + D5 的列）。

> 实施状态以 §7 / §4 的"实跑证据"小节为准；其余各项只声明设计，不宣称已实现。

---

## 0. 阅读约定

- 每条结论后面跟 `文件:行号`；写"未核到消费点"的地方，指的是**两种写法各查过、均为 0**，
  而不是"我没找到"。
- 三类状态：**已实现（有测试）** / **部分实现** / **未实现**。部分实现的必须写清"差哪一段"。
- 凡涉及持久化的设计，都给出**回滚**与**是否需要新迁移**。本方案禁止改历史迁移的 `up`。

---

## 1. 结论先行：11 项剩余工程项的真实状态

| # | 项 | 状态 | 差的那一段（本文要补的设计） |
|---|---|---|---|
| 1 | V4 特征契约与提取/存储/读取全链路 | 部分 | V4 提取器/编解码/兼容投影已有；**生产仍写 V3 特征**，`feature_runs.feature_schema_version` 虽有 V4 常量但存量库全是 V3 |
| 2 | 工程版本/配置版本落库分离、lineage 迁移 | 部分 | `configHash` 已纳入 `engineVersion`；`model_v2_runs` 已存 lineage；**缺独立 `engineVersion` 列与谱系回读 API** |
| 3 | transition gate v2 接入、bundle 原子发布 | 部分 | gate 纯函数 + release bundle + 回滚已有；**`model_validation_gates` 的 CHECK 装不下 `not_evaluable`**，且拒绝原因未持久化 |
| 4 | 所有 assembler 的 freshness/availability 统一 | 部分 | 严格入口 `loadDatedReadiness` 只覆盖 `mobile-read` 的 v4 分支与 recompute 的 phys 证据；**预测路径仍是旧 loader** |
| 5 | rebase 发布流程与按 epoch 分段曲线 UI | 部分 | CLI `rebase` + 只读 `HistoricalModelReview` 已有；**曲线没有 epoch 分段边界，也没有"重新校准"区间标记** |
| 6 | 环境 adapter 生产统一 | 部分 | identity adapter（N0）接入 V4 提取与 physiology；**没有真实条件修正，`normalization.status` 永不 `applied`** |
| 7 | 耐久/负荷向量/zone 快照贯穿实际 API | 部分 | 五个 domain 都封存了；**唯一读端是 `/v1/model-snapshots` 原样返回 blob** |
| 8 | Ridge/CatBoost 同样本三方对比接入 Python runner | 部分 | Python 侧已产出 ridge 与 catboost 候选；**两边没有喂进同一个 `compareResidualChallengers`** |
| 9 | 区间 calibration 持久化与生产选择器 | **已实现** | 仅剩"独立标签到位后跑一次真校准" |
| 10 | 完整跨领域 V1/V2 replay framework | 部分 | Fitness 引擎跨版本回放可跑真实库；**Readiness/Load/Coach 无回放入口** |
| 11 | 候选参数实证与真实连续退步验收 | 未实现 | 受真实标签约束：本地库 **0** 个已确认比赛/测试标签 |

---

## 2. 版本矩阵：方案 §3.1 已过期，须以实测为准

方案 §3.1 那张"建议目标"表写于 09-28，其中的目标值**多数已被超过**。实测（`git grep` 版本常量）：

| 领域 | 方案 §3.1 目标 | **实测当前** |
|---|---|---|
| canonical health | 保持 | `canonical-health-v2` |
| workout feature schema | `workout-feature-v4` | ✅ `workout-feature-v4`（另有 `LEGACY_FEATURE_SCHEMA_VERSION = workout-feature-v3`） |
| feature config | `feature-config-v9` | ⚠️ **`feature-config-v11`**（超前 2 版） |
| scoring config | `rai-model-config-v5` | ⚠️ **`rai-model-config-v12`** |
| scoring engine | `rai-v2.0.0` | ✅ `rai-v2.0.0` |
| physiology model | `rai-physiology-v1.8.0` | ✅ |
| residual feature schema | `race-residual-feature-v4` | 见 `RACE_RESIDUAL_FEATURE_SCHEMA_VERSION` |
| CatBoost artifact family | `race-residual-catboost-v4` | ✅ `race-residual-catboost-v4` |
| training load config | `training-load-config-v5` | ✅ |
| training zone config | `training-zone-config-v4` | ✅ |
| Readiness | `rai-readiness-v1.0.0` | ✅（另有 `rai-readiness-ruleset-v1`） |
| Durability | `rai-durability-v1.0.0` | ✅ `DURABILITY_MODEL_VERSION` |
| Coach | `rai-coach-v2.0.0` | 无独立常量 |
| 跨领域 eval | `rai-model-eval-v1` | ✅ |
| transition gate | `rai-model-transition-gate-v2` | ✅ |
| 工程版本 | — | `MODEL_LINEAGE_SCHEMA_VERSION = model-lineage-v2`、`MODEL_CHECKPOINT_VERSION = rai-model-checkpoint-v2` |
| SQLite | v23 起增量 | 代码到 **v23**，本地库仍 **22** |

> **设计动作 D0**：把 §3.1 的表改成"**实测值 + 目标值**"两列，并标注该表是**时点快照**（对齐 09-28 提交）。
> 现在这张表会误导实施者去"升级"到比现状更低的版本。这是文档债，不是代码缺口。

---

## 3. 逐项设计（按依赖顺序）

### D1（对应 #2）版本与谱系落库彻底分离

**现状证据**：`MODEL_CONFIG_VERSION` 定义在 `packages/scoring/src/model.ts:27`（不在 contracts）；
`recompute-pipeline.ts:405,1639` 已把 `configHash` 写成 `{version, engineVersion, config}`；
谱系落在 `model_v2_runs`（`recordLineage`，`model-release-repository.ts:12`）。

**缺口**：`engineVersion` 目前**只活在 hash 的输入里**，没有独立列、没有独立读取；
于是"查询某个 engine 版本产出过哪些 run"只能靠 `model_version` 列，而它语义仍是 config 版本。

**设计**：
1. 新迁移 v24 给 `model_runs` 加 `engine_version TEXT NULL`，并在 recompute 写入时回填；
   **不改历史迁移的 `up`**，只在 v24 里 `ALTER TABLE ... ADD COLUMN`（SQLite 支持，且可空 ⇒ 旧库安全）。
2. `model_v2_runs` 已有 `engineVersion` 列（`recordLineage(runId, engineVersion, configVersion, lineage)`），
   把它暴露为读 API：`GET /v1/model-runs` 的每行加 `engineVersion`。
3. 旧行 `engine_version` 为 `NULL` 时，读端必须显示 **`unknown`**，不得用 `MODEL_CONFIG_VERSION` 兜底
   （那正是 §14.4 要消灭的混淆）。

**验收判据**：新库跑一次全量 recompute 后，`model_runs.engine_version` 行行非空且等于 `rai-v2.0.0`；
对 v23 及更早的库，读端 `engineVersion` 全为 `null` 且 API 标注 `unknown`。
**回滚**：列可空，回滚只需停用读端；不需要 DROP。

### D2（对应 #1）V4 特征全链路

**现状证据**：`packages/features/src/v4.ts` 已有 `extractWorkoutFeatureVectorV4`（:10）、
`encodeFeaturePayloadV4`（:94）、`projectFeatureV4`（:123）、`decodeStoredFeature`（:139，含 legacy 分支标记）；
`FEATURE_SCHEMA_VERSION = "workout-feature-v4"` 已被 recompute 写进 `feature_runs`。

**缺口**：**存量库的 `features_json` 全是 V3**（本机实测 268/268 都是 legacy 读），
也就是说 V4 提取器**在生产路径上一次都没跑过**。这不是"改字符串"，需要真正的重建。

**设计**：
1. **一次性重建**，不是并行双写：`full_recompute` 已经是"新 feature_run + 新 model_run"的模式，
   把 V4 提取接在 `buildFeatureSource` 之后即可；关键是**新旧 run 必须能同时存在**（已有），
   以便对账与回滚。
2. **对账口径**：重建后必须产出 `V3 → V4 特征对账表`：逐 session 列出
   `efficiencyRaw/paceRaw/stabilityRaw` 的差异、`decoupling` 由 null 变有值的条数、
   `normalization.status` 分布。**每条差异都要能归因**到"V4 新增了什么"。
3. 读取端一律走 `decodeStoredFeature`，并用 `storedFeatureSchema()` 分类；
   legacy 记录带 `unavailable_in_legacy_feature` 标记（已实现，见 §4 同批的前一批）。

**验收判据**：重建后 `feature_runs.feature_schema_version` 为 v4 的行 `storedFeatureSchema()` 一律返回
`workout-feature-v4`；V4 与 V3 的 `paceRaw` 在无环境修正时**逐位相等**（identity adapter ⇒ 不得引入差异）。
**回滚**：保留 V3 feature_run，active 指针切回即可；V4 行不删除。

### D3（对应 #4）freshness / availability 统一

> 🔴 **本节原设计的前提已被证伪，按原样实施会造出一个没人调用的守卫。**
> 实际做法改成"先把可用性维度造出来"，见 §9。

**现状证据**：严格入口 `loadDatedReadiness`（`model-v2-snapshots.ts:8`）要求"发布上界"，
本机有回归 `model-v2-readiness.test.ts`；调用点只有 `mobile-read.ts:288`（v4 分支）与
`recompute-pipeline.ts:1581`。预测路径走 `loadRecoveryReadinessEvidence`（`prediction-data.ts:504`，
被 `prediction-report.ts:259` 消费）。

**🔴 关键设计判断：预测路径**不要**切到严格入口。** 方案 §7.5 与 §11.1 明确要求第一阶段
**精确保留当前裁决阈值**、保留 Daniels 数值基线；实施记录也写明该路径是"明确标注的 legacy background 语义"。
把它切过去会**改预测数值**，属于政策变更而不是工程修复。

**缺口**：真正缺的是**逐信号的 `observedAt` / `availableAt` 是否超出 `asOf`** 的检查没有覆盖所有装配器，
而这正是 §7.3 说的泄漏源。

**设计**：
1. 抽出**只做检查、不改数值**的守卫：`assertSignalAvailability(signals, asOf)` —— 对每个信号断言
   `observedAt <= asOf` 且 `availableAt <= asOf`，违反即抛出，**不返回替代值**。
2. 在 `loadRecoveryReadinessEvidence` 内部调用它（保持 legacy 公式不变），
   于是"数值不变 + 泄漏可被检出"两件事同时成立。
3. 守卫的前置条件**也要写成断言**：fixture 必须先让 `availableAt` 存在，否则守卫是死代码
   （本项目已踩过：守卫住在早退之后 ⇒ 对整套测试不可见）。

**验收判据**：构造一条 `availableAt > asOf` 的 canonical_night 记录 ⇒ 装配器抛错；
同时**预测数值与改动前逐位不变**（这条是"只加检查"的内部一致性证据）。
**回滚**：守卫是纯检查，删除调用点即可。

### D4（对应 #3）transition gate v2 的持久化与原子发布闭环

**现状证据**：gate 纯函数在 `packages/storage-sqlite/src/model-transition-gate.ts`（259 行，
三态 `passed/failed/not_evaluable`，`blocksActivation = status !== "passed"`）；
recompute 已接入（`recompute-pipeline.ts:268`）并把结果写进 **release bundle**
（`releases.recordEvaluation({... status: gate.status ...})`，:280）；
`verifyAndPoint` 以 `bundle.status !== "passed"` 拒绝（`model-release-repository.ts:59`）。

**缺口（两条，均已在本轮核到）**：
1. `model-validation-gates` 侧的 CHECK 只允许 `('passed','failed','skipped')`
   —— 该模块自己的注释（`model-transition-gate.ts:29-33`）说"持久化刻意不在范围内，
   接入要等那条迁移"。**但接入其实已经发生了**（走 release bundle），所以这段注释已经过期。
2. **发布被拒绝时没有任何持久记录**：`activateSucceeded` 抛错 → 路由 409 → 库里查不到"当时为什么被拒"。

**设计**：
1. 迁移 v24（与 D1 同一个迁移）把 `model_validation_gates.status` 的 CHECK 扩到含 `not_evaluable`；
   SQLite 改 CHECK 需要重建表 ⇒ 用 **新表 + 拷贝 + 改名** 的标准手法，且必须在事务里。
2. 拒绝要留痕：新增轻量表 `model_release_refusals(model_run_id, reason_codes_json, detected_at)`
   （**只增不删**），在 `activateSucceeded` 捕获 `release_gate` 时写入。
   理由：§15.8 要求"每个 gate 的 passed/failed/not_evaluable 状态"可查，而 409 响应不是持久证据。
3. 修正 `model-transition-gate.ts:29-33` 的过期注释（它现在会误导人以为"还没接入"）。

**验收判据**：对一条未封存 bundle 的 V4 run 调激活 ⇒ API 返 409 **且** `model_release_refusals`
新增一行，reason 含 `release_gate`；对 `not_evaluable` 的 bundle ⇒ 同样拒绝且状态可查。
**回滚**：新表可留（只增）；CHECK 扩宽是单向兼容，回滚只需恢复旧读端。

### D5（对应 #5）rebase 发布流程与 epoch 分段曲线

**现状证据**：`HistoricalModelReview.tsx` 渲染单次 run 的 `fitness/summary.daily`，
并把 `lineage.baselineEpochId` 传给每个点；CLI 有 `--action rebase`。

**缺口**：曲线**没有 epoch 边界**，也没有"重新校准"区间标记。于是用户看到的是一条连续曲线，
而方案 §3.4 明确要求"历史曲线跳变可能来自算法，不是体能突变"必须显式可见。

**设计**：
1. 读端：`/v1/model-snapshots` 的 `fitness` payload **已经带 `lineage`**（:2030），
   但**没有逐日 epoch**。给 `daily` 的每行加 `baseline_epoch_id`（写入侧由 `daily_ability_snapshots`
   的 `snapshot_status` 推导不出，需要 `fitnessEpochId` 在写入时落列）⇒ 迁移 v24 给
   `daily_ability_snapshots` 加 `baseline_epoch_id TEXT NULL`。
2. UI：在 epoch 变化处画分割线 + 文案"此处基线重建，标尺已变；两侧不可直接比较"；
   对 `snapshot_status === 'calibrating'` 的区间用底色区分。
3. **拒绝**把不同 epoch 的两个点连成一条趋势线（这是当前实现的隐患）。

**验收判据**：fixture 造两个 epoch 的 daily ⇒ UI 出现 1 条分割线、两侧颜色不同、
且**不**出现跨 epoch 的斜率标注。
**回滚**：列可空；UI 分支可单独关。

### D6（对应 #6）环境 adapter 生产统一

**现状证据**：`createIdentityNormalizationAdapter()`（`packages/normalization/src/index.ts:175`）
被 `features/src/v4.ts:13` 与 `physiology/src/index.ts:318` 使用；`v4.ts:23` 里
`normalization.normalized` 在 identity 下永远是 null ⇒ `status` 只可能是
`not_needed / unavailable / out_of_domain`，**永远不可能是 `applied`**。

**缺口**：没有真实的温湿度/海拔修正，`normalized.speedMetersPerSecond` 恒为 null。
方案 §5.2 要求"不重复已有预测修正"且"未知天气不能补成实测值"——当前**方向是对的**（宁可 null），
缺的是**在有实测条件时真的修正**。

**设计**：
1. 先做**覆盖率**而不是先做模型：`scripts/normalization-coverage.mts` 已能测
   "多少条训练有可用的温度/湿度/海拔"。**只有覆盖率足够时才允许接真实 adapter**。
2. adapter 契约已有（`PerformanceNormalizationAdapter`），新增 `fitted-adapter-v1`：
   只用训练段拟合、参数与版本一起进 `normalizationConfigHash`；
   未知条件⇒ `out_of_domain` 且 `normalized` 保持 null。
3. **不得**把 `out_of_domain` 静默当 `not_needed`（那会把"没测"变成"不用修正"）。

**验收判据**：`normalization-coverage` 报告给出"有实测条件的训练占比"；
adapter 接上后，同一 fixture 在 `temperatureC=null` 与 `temperatureC=30` 两种输入下
`normalization.status` 分别为 `out_of_domain` 与 `applied`，且后者 `normalized !== null`。
**回滚**：换回 identity adapter（配置项），历史派生数据不删。

### D7（对应 #7）快照贯穿实际 API

**现状证据**：五个 domain 都在 `sealDomainSnapshots` 写入（`recompute-pipeline.ts:2030-2053`）；
**唯一读端**是 `apps/api/src/server.ts:1360` 的 `/v1/model-snapshots`（原样返回 blob），
加上 gate 自己的一次消费（`recompute-pipeline.ts:275` 的 `readinessOutputCoverage`）。

**缺口**：这些快照目前"**写得进去、读不出结构**"——消费方拿到的是 `unknown`。

**设计**（与本轮切片同一条线）：
1. 契约层**只承诺信封**（`domain/key/asOf/payload`），`payload` 保持 `unknown`
   —— 声明一个窄 payload 形状是契约撒谎（本轮已在 `api-contracts` 里按此原则实现）。
2. **逐 domain 各自出一个窄化函数**，放在**产出该 payload 的那一侧**（application），
   而不是放在 web：`readFitnessSnapshot(payload)` / `readLoadSnapshot(payload)` …
   每个函数必须**校验必需字段**，缺字段返回 null 而不是读 `undefined`。
3. 只对**真正有消费方**的 domain 做窄化：`fitness`（进度条/曲线）、`load`（负荷页）、
   `readiness`（今日状态）。`durability`/`zones` 暂不窄化，等有消费方再说 —— 不做投机抽象。

**验收判据**：`fitness` 窄化函数对 V4 写入的 payload 与 legacy 分支的 payload **都能读出 daily**；
对 `load` 的 payload（`{lineage, days}`）必须返回 null 而不是把 `days` 当 `daily`。
**回滚**：窄化函数是纯函数，删除即可。

### D8（对应 #8）Ridge/CatBoost 同样本三方对比

**现状证据**：TS 侧 `compareResidualChallengers`（`model-eval/src/index.ts:250`）已接入报告
（`prediction-report.ts:473`）；Python 侧 `research/rai_ml/pipeline.py` 同时产出
catboost（:111）与 ridge（`_ridge_predict` :135，逐样本 :263）。

**缺口**：两边的候选**没有喂进同一个三方对比**。TS 侧的调用点走的是 TS 内计算，
Python 侧的 `ridge_raw` 没有汇入同一批 `EvaluationCase`。

**设计**：
1. 定一个**同一份样本表**：`{eventId, distance, predictedAt, outcomeAt, availableAt, actualSeconds}`
   + 三列预测（baseline / ridge / catboost）。TS 与 Python 都必须按这个表输出，
   **`eventId` 与时间字段必须逐位相同**（`compareResidualChallengers` 已经强制这点，:270 起）。
2. Python runner 产出 `challengers.json`；TS 侧新增一次性导入把它变成 `EvaluationCase[]`
   再调 `compareResidualChallengers`。**不要**在 Python 里重写门槛逻辑。
3. **缺 challenger 不得当作无限差**（该函数已实现：缺一列即 `not_evaluable` 且 `blocksActivation`）。

**验收判据**：喂入缺 ridge 的样本 ⇒ `status = not_evaluable` 且 `blocksActivation = true`；
喂入 catboost 与 baseline 完全相同的样本 ⇒ `status = failed`（**这是防止"集合相等也过"的关键反例**）。
**回滚**：导入器是只读工具，删掉不影响现有报告。

### D9（对应 #9）区间校准：只剩"跑一次真校准"

已实现：`SqliteCalibrationRepository`、`catBoostCalibrationKey`（`prediction-policy.ts`）、
`intervalActivationReasons` 激活门槛、`model-v2-maintenance` 的建模事件排除校验、CLI `activate-prediction`。
**剩余**：需要 ≥24 条独立校准样本 + ≥24 条独立测试样本（`INTERVAL_RELEASE_POLICY`），
而这些**必须来自真实比赛/测试标签**（当前 0 条）。⇒ 本项**不是工程缺口**。

### D10（对应 #10）跨领域 replay

已实现：Fitness 引擎跨版本回放可跑真实库（`scripts/model-version-replay.mts`，只读）。
**剩余**：Readiness / Load / Coach 无回放入口。

**设计**：复用 `@rai/model-eval` 的 `replayModelPair`（冻结输入 + 两个 adapter）。
每个新领域只需要提供一个 `run(input, descriptor)` 纯函数；**不要**为每个领域再造回放框架。
优先级：**Readiness 最高**（§7.3 的 freshness 泄漏最可能出在这里），Load 次之，Coach 最后
（Coach 是决策层，回放它等于回放上游）。

**验收判据**：同一 domain 的两次回放 `semanticEqual === true`（确定性）；
且 `as_known_then` 模式下缺到达时间的记录**必须抛错**（已有实现，见 D3 的守卫）。

### D11（对应 #11）真实退步验收：定义"什么时候才能做"

这不是工程任务，是**数据门槛**。当前：268 条训练 / **0 条已确认比赛或标准测试**。

**设计**：
1. **不许**为了让某个门槛变绿而把普通训练标成测试（方案 §15.7 明令）。
2. 定义**可判定条件**：某距离上累计 ≥ N 条独立、无泄漏、用户确认的合格结果时，
   才允许对该距离做"负机会是否被接受"的统计。N 取 `INTERVAL_RELEASE_POLICY` 的样本门槛（24）。
3. 在此之前，`RAI_V2_EVALUATION` 报告里所有精度相关 gate 保持 `not_evaluable`
   —— **`not_evaluable` 是正式状态，不是失败**。

---

## 4. 本轮已实现的最小可上线切片

**切片**：把 `/v1/model-snapshots` 契约化，并让 web 端不再自己声明一份响应形状。

**为什么选它**：
- 这条路由是上一轮（断流的会话）新加的，**从未进契约层**；web 端在
  `HistoricalModelReview.tsx` 里**本地重复声明**了一个 `SavedModel` 形状
  —— 这正是本项目反复吃亏的"跨进程契约漂移"。
- 它同时是 D7 的第一步（信封先契约化，payload 保持 `unknown`）。
- **additive，无迁移，不改任何现有消费方的行为**。

**改动**：

| 文件 | 改动 |
|---|---|
| `packages/api-contracts/src/index.ts` | 新增 `ModelSnapshotDomain` / `ModelSnapshotEntry` / `ModelSnapshotsResponse`（按 `status` 判别的联合） |
| `apps/api/src/server.ts` | 处理器标注 `ModelSnapshotsResponse`；行查询补类型（注解把一处未类型化行暴露出来了） |
| `apps/web/src/components/HistoricalModelReview.tsx` | 改为消费契约类型；`payload` 用 `unknown` + 显式收窄；**把 `not_published/not_found/legacy` 三种拒绝码显示出来** |
| `apps/web/test/historical-model-review.test.tsx` | 新增 2 个用例：拒绝码分支、非 `daily` 形状的 payload |

**关键设计点**：payload 声明为 `unknown` 而不是某个窄形状。
`fitness` 存的是 `{lineage, assessments, daily}`，`load` 存 `{lineage, days}`，
`durability` 存的是**数组**（`recompute-pipeline.ts:2050`）。
声明一个统一窄形状会让消费方去读一个产出端根本没写的字段 —— 契约层宁可要 `unknown` 让调用方收窄。

**验证**（全部实跑）：

| 门禁/验证 | 结果 |
|---|---|
| `npm run typecheck` | `EXIT=0` |
| `npx vitest run historical-model-review` | **3 passed / 0 failed** |
| 突变 A：去掉拒绝码分支 | 🔴 红（`surfaces a refusal status…`） |
| 突变 B：不校验 payload 形状直接当数组 | 🔴 红（`treats an unexpected fitness payload as absent…`） |

**顺带修掉的两个坑**：
1. `typecheck` 第一次以 `EXIT=2` 失败 —— 注解让 `model.asOf` 的
   `SQLOutputValue | undefined` 暴露出来（原代码是隐式 `any`）。已补行类型。
2. 该测试文件是**多用例**的，而 `vitest.config.ts` 没开 `globals`/`setupFiles`
   ⇒ 没有自动 DOM 清理，第二个用例查到两个 `combobox`。已加 `afterEach(cleanup)`。

---

## 5. 依赖顺序与建议 PR 边界

```
D0（文档：§3.1 表改为实测+目标）        —— 无依赖，可立即做
D1 + D4（同一个迁移 v24：engine_version / CHECK 扩宽 / refusal 表 / epoch 列）
D3（只加检查，不改数值）                 —— 无依赖
D7 窄化函数（fitness → load → readiness）—— 依赖契约（本轮已完成信封）
D2（V4 重建）                            —— 依赖 D1（否则重建后 engine/config 仍混）
D6（真实 adapter）                       —— 依赖 D2 + 覆盖率报告
D5（epoch 分段 UI）                      —— 依赖 D1 的 epoch 列
D8（Python 三方对比导入）                —— 无依赖
D10（Readiness 回放优先）                —— 依赖 D3
D9 / D11                                 —— 被真实标签阻塞，不是工程任务
```

**迁移只用一个 v24**：D1/D4/D5 的列与表一次性加完，避免连续小迁移。
⚠️ **不得改任何历史迁移的 `up`** —— 那会让所有既有库永久打不开。

---

## 6. 复现命令

```bash
cd /Users/ta/running

# 本轮切片
npm run typecheck
npm run test -w @rai/web -- historical-model-review

# 迁移 v24
node --import tsx --test packages/storage-sqlite/test/v24-migration.test.ts
node --import tsx --test packages/storage-sqlite/test/migration-policy.test.ts

# 文档整理后的门禁（应与整理前一致：越界 3 / 漂移 ~96 / 空行 ~6）
npm run check:doc-refs
```

---

## 7. 已实施：迁移 v24（D1 + D4 + D5 的列）

**一次迁移补齐四项，全部 additive，唯一破坏性动作是 `model_validation_gates` 的表重建**
（SQLite 改不了 CHECK），且逐列拷贝全部既有行、索引与 UNIQUE 一并重建。

| 改动 | 落点 |
|---|---|
| `model_runs.engine_version TEXT NULL` | `v24-migration.ts` |
| `daily_ability_snapshots.baseline_epoch_id TEXT NULL` | 同上 |
| `model_validation_gates.status` CHECK 加 `not_evaluable` | 同上（重建表） |
| `model_release_refusals` 新表（只增不删） | 同上 |

**接线（四处 + 两处调用方）**

| 位置 | 接线内容 |
|---|---|
| `recompute-pipeline.ts:444` | 新 run 写入 `engine_version = SCORING_MODEL_VERSION` |
| `recompute-pipeline.ts:236` 之后 | epoch 已知后**回填**本次 run 的逐日快照（快照先于 epoch 落地 ⇒ 回填而不是重排序） |
| `import-worker.ts`（跨库拷贝） | 快照拷贝**保持旧列集**，源库确有该列时再条件回填 —— 直接引用新列会让"从 v23 备份导入"整条 SQL 报错 |
| `model-run-repository.ts` | `activateSucceeded` 把拒绝载荷挂到 `ModelRunActivationError.refusal` |
| `server.ts:1549` / `command-queue.ts:208` | **在 ROLLBACK 之后**写审计行 |

### 🔴 一个必须先说的设计陷阱

拒绝审计行**不能**写在 `activateSucceeded` 里：激活永远发生在调用方的事务中
（HTTP 路由有 `BEGIN IMMEDIATE`、命令队列也有），仓库里写的行会被调用方的 `ROLLBACK` 一起撤掉。
连仓库自己的 `SAVEPOINT` 回滚也会撤掉它。⇒ 所以拆成两步：**仓库只报告，持有事务的一方在回滚后落库**。

> 这条是被测试**强制**下来的，而且我第一版写错了。更要紧的是：我最初写的
> "仓库自己不该写审计行"那条断言**是空的** —— 突变验证（把内联写放回去）**照样绿**，
> 因为它被仓库自己的 savepoint 回滚了，两种实现下结果都为空。
> 已改成断言「错误必须携带 `refusal` 载荷」，并把顺序要求交给 ②③ 两条真正有牙齿的断言。

### 实跑证据

| 验证 | 结果 |
|---|---|
| `npm run typecheck` | `EXIT=0` |
| **全量门禁**（前半 node） | `EXIT=0` = **1004 tests / 1000 pass / 0 fail / 4 skipped**（+2 条为本轮新增的 v24 用例） |
| **全量门禁**（后半 web） | `EXIT=0` = 17 文件全过 |
| 全新库：四项目标存在 | ✅ 列/表齐全；`passed/failed/skipped/not_evaluable` 四值均接受，`bogus` 仍被 CHECK 拒绝（没被放宽成"什么都行"） |
| **真实库副本 v22 → v24** | ✅ `gates 2→2`、`runs 6→6`、`snaps 14760→14760` **数据无损**；2 条 gate 索引重建；`PRAGMA quick_check = ok`；`foreign_key_check` 为空 |
| 历史行不猜引擎版本 | ✅ `model_runs.engine_version IS NOT NULL` 计数 = 0 |
| `v24-migration.test.ts` | 2/2 通过 |
| 突变 A：CHECK 收回 `not_evaluable` | 🔴 转红 |
| 突变 B：仓库在事务内落库 | ⚠️ **未转红** ⇒ 证明原断言是空的，已重写（见上） |
| 突变 C：错误不带拒绝载荷 | 🔴 转红 |
| `migration-policy.test.ts` | ✅ 其中一条把备份版本号写死成 `23` ⇒ 已改为从 `MIGRATION_VERSIONS` 推导（否则每次新增迁移都会过期） |

**未做**：真实库尚未应用 v24（本机 `var/rai.sqlite` 仍是 22）；未提交；未部署。
应用前按既有闸门执行并在停止 API 后跑 `npm run data:migrate -- --database <path> --apply`。
**回滚**：两列与新表都可留（只增）；CHECK 扩宽是单向兼容，回滚只需停用读端。

### 设计文档相应下调的项

- **D1（engine_version 落库分离）**：列已落地并接线；**仍缺**读端（`GET /v1/model-runs` 暴露 `engineVersion`，`NULL` 显示 `unknown`）。
- **D4（gate 三态与拒绝留痕）**：**已落地并被测试覆盖**；预测侧的两个拒绝阶段（`activation_compatibility` / `artifact_boundary`）**未接线**，因此 CHECK 只登记 `release_gate` 一个值 —— 不留"允许但永不写入"的枚举值。
- **D5（epoch 分段）**：列已落地并回填；**仍缺** UI 分段与"跨 epoch 不连成一条趋势线"的守卫。

---

## 8. 已实施：D0 文档订正 + D1 读端 + D7 快照窄化

### D0 —— 方案 §3.1 版本矩阵订正（文档债）

**为什么必须改**：原表的"当前源码"列是 09-28 快照，而 `feature config` / `scoring config` 的**实测值高于原表写的目标值**
⇒ 照着原表去"升级"等于**降级**。按该表首段自己的规则（"若实施前已有新版本，应顺延"），这两个目标值作废。
已改为「建议目标 / **实测（09-29）** / 判定」三列，并加了一句护栏：
**"判定 ≠ 已到位"不是待办清单**（`normalization` / `Coach` 的未落地是尚未实施的工程项，不是改个常量名就算完成）。

实测变化一览：`feature-config-v11`（原目标 v9）、`rai-model-config-v12`（原目标 v5）、
`residual-feature-v4`、`race-residual-catboost-v4`、`training-load-config-v5`、`training-zone-config-v4`、
`rai-readiness-v1.0.0`、`rai-durability-v1.0.0`、`rai-model-eval-v1` 均已到位；
`SQLite` 代码已到 **v24**（库仍 22）。

### D1 读端 —— `engineVersion` 贯通到 API 与界面

`modelVersion` 是**配置**版本、`engineVersion` 是**引擎**版本，此前只有后者没有出口。

| 层 | 改动 |
|---|---|
| `model-run-repository.ts` | `StoredModelRunSummary.engineVersion` + `mapModelRunSummary` 映射 |
| `api-contracts` `ModelRunSummary` | 新增 `engineVersion: string \| null`，注明 `null` = 未知 |
| `data.ts` | 比较接口的 DTO 透传该字段 |
| `DataModelPage.tsx` | 模型列表显示「引擎 {version \| 未知}」，并在 `title` 里解释为什么未知 |

🔴 **关键不变量（有断言守）**：v24 之前的行**没有这一列** ⇒ 必须映射成 `null`，
**不得**用当前 `MODEL_CONFIG_VERSION` 兜底 —— 那会把"未知"伪装成"确定"。
新增 `model-run-repository.test.ts` 用例把期望值**写死成 `null`**（不引用任何版本常量），
突变验证：改成兜底当前版本 ⇒ **转红**。

### D7 快照窄化 —— fitness / load（readiness 待续）

信封（`ModelSnapshotEntry.payload`）刻意是 `unknown`；消费方若自己断言形状，就会去读产出端**没写过**的字段。
所以窄化只做一次，放在**双方共享的契约层**，经 `api-contracts` re-export 给 web（web 未新增包依赖）。

| 函数 | 守的不变量 |
|---|---|
| `readFitnessSnapshot` | 只认 `daily`；**`load` 的 `days` 一律不认**（否则会把负荷日次当能力日次画出来且不报错） |
| `readLoadSnapshot` | 只认 `days`；fitness 的 `daily` 一律不认 |
| 两者共用 | 必需键缺失 ⇒ 跳过该行；全部无效 ⇒ `null`；非有限 `true_ability` ⇒ 归一到 `null`（不让 `NaN` 漏进图表） |

web 侧删掉了我上一批临时写的本地 `fitnessSeries`，改调共享函数 —— **同一份窄化只有一处实现**。

> **readiness 未做**：它的 payload 由 `readinessForRun` 产出，形状是
> `ReadinessAssessmentResult & {lineage}`。要窄化就必须先把它的**必需字段**读全，
> 否则只能写成"检查 lineage 存在"这种假校验。这是刻意留下的下一步，不是遗漏。

### 实跑证据（本轮）

| 验证 | 结果 |
|---|---|
| `npm run typecheck` | `EXIT=0` |
| node 侧全量 | `EXIT=0` = **1010 / 1006 pass / 0 fail / 4 skipped**（+6 为本轮新增用例） |
| web 侧全量 | `EXIT=0` = 17 文件全过 |
| `model-run-repository.test.ts` | 4/4；突变「兜底当前版本」⇒ 🔴 |
| `domain-snapshot-narrowing.test.ts` | 5/5；突变「fitness 也接受 `days`」⇒ 🔴；突变「非有限值透传」⇒ 🔴 |
| `historical-model-review.test.tsx` | 3/3（改调共享函数后仍绿） |

---

## 9. 已实施：D3 重做 —— 先造"可用性"这个维度，而不是先造裁决

### 🔴 原 D3 的前提是错的

原设计写的是"在恢复路径加 `assertSignalAvailability`，违反即抛"。动手前的核对把它否掉了，两条证据：

1. **唯一的消费方声明的是"不需要可用性"的模式**：`prediction-report.ts:465` 写死
   `replayMode: "event_time_reconstruction" as const`。契约（`contracts/src/index.ts:1340-1345`）对该模式的定义是
   "用今天持有的数据重建过去" —— **按定义就不要求事实在 `asOf` 之前到达**。
   在这条路径上抛错，等于把一个**被声明为合法**的模式判成非法。
2. **全仓没有任何调用方请求 `as_known_then`**（`replayMode` 只出现在那一处）。
   ⇒ 守卫即使写出来也无人调用，正是本方案反复点名的"未接线的枚举/守卫"。

**所以改做另一件事**：把可用性**变成可见的事实**。在此之前，恢复证据的 provenance 里
**根本没有到达时间**，只有观测时间 —— 也就是说"这条数据是 `asOf` 之后才进系统的"这件事，
在数据上**不可见**，任何上游都无从判断。

### 改动

| 位置 | 改动 |
|---|---|
| `PredictionRecoveryProvenance` | 新增 `latestAvailableAt`（canonical 取 `computed_at`、原始记录取 `created_at`）与 `availabilityUnknown` |
| `prediction-recovery-read-repository.ts` | 到达时间与数值取自**同一条 SQL 的同一 WHERE**（原始路径收敛到共用的 `rawMetricScope`）；列不存在 ⇒ `availabilityUnknown`，**不是**"已可用" |
| 预测报告 | `recoveryProvenance` 早已透传 provenance ⇒ 两个新字段**自动出现在报告与 API 响应里**，无需新接线 |

🔴 **关键设计约束**：到达时间必须**从产出数值的同一批行**里取。
另写一份筛选条件去查到达时间，迟早与数值用的条件分叉；分叉的后果是
"算数用了一批行、判可用性用了另一批"，而且**不会报错**（纪律 17 的同族）。

### 为什么这不算半成品（也不冒充完成）

- **数值逐位不变**：新增的只有元数据；测试明确断言 `recentRestingHeartRate` 不受影响。
- **有真实消费方**：provenance 已进预测报告与 API 响应。
- **它让裁决成为可能**：有了 `latestAvailableAt`，将来接 `as_known_then` 的调用方**才写得出**
  "`latestAvailableAt > asOf` ⇒ 拒绝"这一行。**裁决留给第一个真正需要它的调用方。**
- **仍未做**：`as_known_then` 的裁决本身。前提是出现一个真按该模式回放的调用方（见 §3 的 D10）。

### 实跑证据

| 验证 | 结果 |
|---|---|
| 两个维度确实分开 | 新用例造"观测 01-29 / 导入 02-05"的记录：`latestObservedAt = 2026-01-29T00:00:00Z`、`latestAvailableAt = 2026-02-05T00:00:00Z`（**晚于 asOf**）|
| 缺到达列 ⇒ 未知（不是"已可用"）| 既有用例的 fixture 没有 `created_at` 列 ⇒ `latestAvailableAt: null` + `availabilityUnknown: true` |
| 突变 G：到达时间复述观测时间 | 🔴 2 条转红 |
| 突变 H：可用性永远为已知 | 🔴 1 条转红 |
| `typecheck` / node 侧 / web 侧 | `EXIT=0` / **1011 tests，1007 pass，0 fail，4 skip** / 17 文件全过 |

⚠️ 过程记录：期间出现过一次 `server-runtime.test.ts` 失败（断言"队列不再是 queued"）。
**单跑该文件 17/17 通过，独占重跑全量 0 失败** ⇒ 判定为**资源争抢抖动**
（当时机器 14 分钟前刚重启、5 分钟负载 24.7；该用例轮询任务状态，对负载敏感）。
**不是本轮改动引入**，也没有据此放宽任何断言。

---

## 10. 已实施：D10 跨领域 replay —— Readiness 优先

### 做了什么

`packages/application/src/readiness-replay-v2.ts`：用**既有**的 `@rai/model-eval` 框架
（`replayModelPair`，全泛型）给 Readiness 一个回放入口。没有为这个领域另造框架。

### 🔴 两个必须写下来的设计判断

**判断一：两条分支必须调用同一个生产函数，只差"到达时间假设"。**

Readiness 没有"历史版本 vs 当前版本"这种干净的对照组：`assessReadiness`（通用）与
`assessDatedReadiness`（严格）里，后者**本身就是调用前者**。若把两者当两支，等于把
"外层的到达门 + 内层规则"拆成对照组，而且夜晚连续天数规则只在内层算 ⇒ 会诱使我在
反事实支里**重写一遍规则**（纪律 17：报表不得自己重写阈值）。

改成：

| 分支 | 到达时间假设 |
|---|---|
| `observation_only_counterfactual` | 把 `availableAt` **一律**改写成 `observedAt`（"假设事实发生时即刻到达"）|
| `rai-readiness-ruleset-v1` | 按**真实** `availableAt` 判定（`null` 即不可用）|

两者之差 = **"拿观测时间当可用性"会改变多少裁决**，也就是 §7.3 的泄漏量本身。
这一支刻意叫 `counterfactual`：它**不冒充**上线过的规则集。

**判断二：`semanticEqual` 在这个领域恒为 false，不能当判据。**

反事实支必然改写 `availableAt`，而结果会把到达时间**原样回显**到
`signals[*].availableAt / observedAt / evidenceLocalDate` ⇒ 整份输出的语义 JSON
**永远**不相等，两支的真实差别被淹没在元数据里。

⇒ 新增 `rulingEqual`：显式投影出**裁决字段**（`coverage` / `assessment` / `state` /
`reasonCodes` / 逐信号的 `value`·`ratio`·`low`·`quality`）再比较。
**这是本批最重要的一条**：直接用框架默认的相等判定，会得到一个恒为 false 的信号，
既指不出问题也守不住回归。

### 为什么这正好补齐了 D3 的缺口

D3 的结论是"裁决留给第一个真正需要它的调用方"。本模块就是那个调用方 ——
但它**只报告**（`arrivalSensitiveReasonCodes` = 只有严格支才有的理由码），**不裁决**。
`as_known_then` 的拒收仍由框架负责（`replayModelPair` 在 `availabilityUnknown` 时抛错，已有断言）。

### 实跑证据

| 验证 | 结果 |
|---|---|
| 到达时间未被用到 ⇒ 裁决相同 | 两支 `rulingEqual: true`、`arrivalSensitiveReasonCodes: []` |
| 到达时间改变了裁决 | 造"观测 06:00 / 到达 09:00 / asOf 08:00"的 HRV ⇒ `rulingEqual: false` 且严格支含 `hrv_unavailable_at_assessment`，反事实支**不含** |
| 到达时间未知 | 两支裁决不同；且 `as_known_then` + `availabilityUnknown` ⇒ 框架**抛错**（断言了这条） |
| 确定性 | 同一冻结事实两次回放 `candidate.semantic` 相同 |
| 突变 I：只在"到达时间缺失"时才假设即时到达 | 🔴 转红（**这个 bug 我第一版就写错了，靠"两支必须不同"的断言抓到**）|
| 突变 J：`rulingEqual` 恒为 true | 🔴 2 条转红 |
| `typecheck` / node 侧 / web 侧 | `EXIT=0` / **1015 tests，1011 pass，0 fail，4 skip** / 17 文件全过 |

### 仍未做

Load / Coach 的回放入口。它们可以照同一模式加（各写一个 `run(input, descriptor)` 纯函数），
但**前提是先找到"只差一个假设"的对照支**；没有对照支就不要造（见 §9 的教训）。
