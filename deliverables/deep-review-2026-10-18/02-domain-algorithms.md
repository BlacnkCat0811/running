# RAI 全项目深度审查 · Lane 2：领域算法与合同

审查对象：`/Users/tp/running`，git HEAD `24aa7d8`（工作树干净）。只读审查，未修改任何 git 跟踪文件；全部探针写在 `/tmp`。
产出：本文件。审查日期 2026-10-18。

---

## 0. 结论摘要

本轮在 Lane 2 范围内确认 **4 项 P2、6 项 P3，无 P0/P1**。

| 严重度 | 数量 | 主题 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 4 | 恢复证据连续门槛口径不一致；缺失准备度被默认值静默惩罚；特征向量合同校验放过 NaN/Infinity/非法日期；同标尺 transition gate 在分布指标为 null 时直接放行 |
| P3 | 6 | 个人区间展示闸门无生产调用点；心率分区接受非正心率；N02"单调"文字超出测试覆盖；TA 拒绝归因未落库；条件责任账本无运行期对照；两套语义 JSON 规范化并存 |

**总体判断**：本包算法核心的强不变量（Fitness 不读当天恢复、null 不默认填补、个人/人群门槛不混用、手工成绩按录入时刻起算、个人区间禁人群词汇、ONNX 工件 hash/scope 校验、负向学习确认门）**在代码层面真实成立**，不是只写在文档里；定向测试 360 例全部通过。真正的问题集中在两类：

1. **"缺失"被替换成一个具体数字**（恢复连续门槛、准备度默认值、transition gate 的 null 指标），形式上字段还是 `null`，但参与计算的量已经是一个猜测值 —— 这是本项目最核心的"unknown ≠ 0"合同最容易失守的地方；
2. **合同校验器比它自己的注释弱**（`assertWorkoutFeatureVector` 放过 NaN/非法日期；展示闸门只有测试在调用），属于"文档声称强制、实际不强制"的语义缺口。

没有发现数据丢失、越权或生产不可用级问题；HEAD 的 ONNX 懒加载改动（`packages/prediction-inference`）经核对**未削弱**工件校验与 fallback 语义（见 §4.1）。

---

## 1. 范围与方法

### 1.1 静态审查范围

- `packages/contracts/src/{index.ts,semantic-json.ts}`（领域合同、schema、语义 JSON）
- `packages/scoring/src/{index.ts,model.ts}`（CA/TA、连续学习率、置信度 v2、负向确认、拒绝归因）
- `packages/readiness/src/index.ts`（当天恢复唯一来源、dated readiness、连续坏夜）
- `packages/training-load/src/{index.ts,form.ts}`（composite/TRIMP、状态曲线、恢复时间）
- `packages/training-zones/src/index.ts`（HR/Pace 分区、刺激、coherence）
- `packages/features/src/{index.ts,v4.ts,speed-windows.ts}`（V3/V4、质量分、eligibility）
- `packages/physiology/src/index.ts`（Daniels/VDOT、条件归一化、阈值、公式预测、bias 校准、坡度）
- `packages/normalization/src/index.ts`（identity adapter、条件责任账本）
- `packages/durability/src/index.ts`、`packages/dynamics/src/index.ts`
- `packages/prediction-inference/src/index.ts`（ONNX 工件校验、懒加载、残差 cap）
- `packages/model-eval/src/index.ts`（区间发布闸门、个人自校准、负学习阻断、报告信封）
- `packages/storage-sqlite/src/model-transition-gate.ts`（激活 gate，属本 lane 的"模型激活可绕过性"项）
- `docs/ALGORITHM.md`（含 §16.1 80 条矩阵）、`docs/DECISIONS.md`（D4/D10/D11/D12/D16）
- 与本 lane 交叉的生产装配点：`packages/application/src/{prediction-report.ts,prediction-data.ts,personal-calibration.ts,services/recompute-pipeline.ts}`（只读，用来判断纯函数语义是否被生产路径真正消费）

### 1.2 动态验证

| 命令 | 结果 |
|---|---|
| `npm run check:acceptance-matrix` | `§16.1 矩阵：80 条；cited 80；declared-gap 0；missing 0`，通过 |
| 自写脚本：80 个 ID → 引用文件分类 | 80/80 至少被 1 个 `test/` 下的文件引用（无"只在文档里出现"的条目） |
| `RAI_TEST_CONCURRENCY=1 node --import tsx --test packages/{scoring,readiness,training-load,model-eval}/test/*.test.ts` | **172 pass / 0 fail** |
| 同上，`packages/{features,physiology,contracts,dynamics,durability,normalization,prediction-inference,training-zones}/test/*.test.ts` | **188 pass / 0 fail** |
| `/tmp` 探针（直接 import 纯函数） | 见 §3 各项"已复现"证据 |

未跑全量 `npm test`（Lead 在后台跑）、未跑 `typecheck`（Lead 已跑 EXIT=0）、未触真实 `var/` 库。

---

## 2. 发现清单

| ID | 严重度 | 标题 | 位置 | 证据等级 |
|---|---|---|---|---|
| D-01 | P2 | 连续坏夜门槛 0.80 与单夜"睡眠低"门槛 0.75 不一致，且 0.80 是重复字面量 | `packages/readiness/src/index.ts:295`；`packages/application/src/services/recompute-pipeline.ts:3647` | 已复现（探针） |
| D-02 | P2 | 缺失准备度被替换为按距离递减的默认值参与预测；输出字段仍为 `null`，显式 `null` 还会被标成"已应用/低准备度" | `packages/physiology/src/index.ts:117-121,944-947`；`packages/application/src/prediction-report.ts:266-268`、`prediction-data.ts:581-590` | 已复现（纯函数探针）+ 生产路径代码阅读 |
| D-03 | P2 | `assertWorkoutFeatureVector` 放过 NaN `qualityScore`、Infinity `distanceKm`、非法 `workoutStartAt`，与"非有限必须拒绝"的合同不符 | `packages/contracts/src/index.ts:981-1000` | 已复现（探针） |
| D-04 | P2 | 同标尺 transition gate 对 `null` 分布指标直接放行（`exceeds(null)===false`），等于"未评估"被当成"合格" | `packages/storage-sqlite/src/model-transition-gate.ts:261-276,345-348` | 已复现（探针）+ 可达性代码阅读 |
| D-05 | P3 | 个人区间展示闸门 `assertPersonalIntervalPresentation` 在生产路径无调用点，M05 仅由测试与类型保证 | `packages/model-eval/src/index.ts:1165`；全仓 `grep` 无生产调用 | 代码阅读（grep 全仓） |
| D-06 | P3 | `heartRateZoneFor` 接受 0/负心率并归入 recovery；`analyzeWorkoutZones` 不先过滤非正心率样本 | `packages/training-zones/src/index.ts:364-372,706-713` | 已复现（探针） |
| D-07 | P3 | N02 矩阵写"等强配速随坡度单调"，实际 Minetti 在 −20% 以下非单调，测试只采样 [−6%,10%] | `packages/physiology/src/index.ts:314-325`；`packages/physiology/test/grade-adjustment.test.ts:14-27` | 已复现（探针） |
| D-08 | P3 | TA 更新的拒绝归因在生产唯一调用方被丢弃，未落库，承诺的"按原因统计"无法从评估表得到 | `packages/scoring/src/model.ts:623-721`；`packages/application/src/services/recompute-pipeline.ts:3897-3963` | 代码阅读（调用点逐字段核对） |
| D-09 | P3 | 条件修正责任账本只是声明表：`location` 字符串不校验，新增修正点不会触发任何检查（P02 的保护靠人工） | `packages/normalization/src/index.ts:289-352` | 代码阅读 |
| D-10 | P3 | 两套"语义 JSON"规范化并存：`plan-digest.stableJson` 用 `localeCompare(…, "en")`，`contracts.canonicalSemanticJson` 用 UTF-16 码元排序 | `apps/api/src/plan-digest.ts:57-67`；`packages/contracts/src/semantic-json.ts:75-84` | 代码阅读 |

---

## 3. 各项详情

### D-01（P2，已复现）连续坏夜门槛 0.80 与单夜门槛 0.75 不一致

**证据**（`packages/readiness/src/index.ts:289-296`）：

```ts
for (let offset = 0; offset < input.nights.length; offset++) {
  const date = ...
  const night = nights.get(date);
  if (!night || !available(night) || night.value! / night.baseline! >= 0.8) break;
  streak++;
}
```

同一文件顶部导出的兼容阈值是 `READINESS_SLEEP_RATIO_THRESHOLD = 0.75`（:24），单夜判定用它（:105、:224）；而"连续三夜"的每一夜用硬编码 `0.8` 判定。`0.8` 还在第三个位置重复了一份：

```ts
// packages/application/src/services/recompute-pipeline.ts:3646-3647
.filter((minutes): minutes is number => minutes !== undefined && minutes < sleepBaseline * 0.8).length;
```

我没有在本轮 HEAD 新增代码中找到该差异，已用 `git log -S` 追到 2026-09-04 的初始实现（`4be39dd`）：0.75 来自 Coach 的单夜规则、0.80 来自连续夜统计，抽取到 `@rai/readiness` 时逐字保留，因此这是**既存的兼容行为**，不是 HEAD 引入的回归；但以当前文档口径（§7 "兼容阈值：sleep ratio 0.75 … 连续差睡眠 3 夜"）它已经无法自洽。

**探针复现**（`/tmp/probe-readiness.mts`，今天 sleep ratio 0.95，前三夜各 0.78）：

```
coverage complete  assessment multiple_low_signals  streak true  sleepLow false  ratio 0.95  reasons [ 'sleep_streak' ]
```

即：`signals.sleep.low === false`（0.78 不满足 <0.75 的"睡眠低"），但 `sleepStreak === true`，`assessment` 直接升到 `multiple_low_signals`（`toReadinessState` → `strained`），`physStateFromReadiness` → `depleted`，下游 `classifyTrainingStatus` 的 `phys_state` 依据与 Coach 降阶都会读到它。

**影响**：三夜 78% 睡眠（按文档口径"不算低"）就能把当天恢复判成 `strained`，且 `reasonCodes` 只有 `sleep_streak`，信号面板与结论互相矛盾。属于用户可见的判断错误，但方向保守（多降不升），不是安全/数据问题。

**建议**：把"连续坏夜"的定义收敛到一个导出常量（建议直接复用 `READINESS_SLEEP_RATIO_THRESHOLD`，或在 contracts 新增 `READINESS_STREAK_SLEEP_RATIO_THRESHOLD` 并写进 §7），`recompute-pipeline` 改为引用同一常量；`assessDatedReadiness` 与 `assessReadiness` 的 N=3 连续规则加一条"0.75 ≤ ratio < 0.80"的回归测试锁住口径。

---

### D-02（P2，已复现 + 生产路径代码阅读）缺失准备度被默认值静默惩罚

**证据链**：

1. `packages/application/src/prediction-data.ts:581-590`：准备度证据不足时返回 `values: {}`（`status: "insufficient_data"`）。
2. `packages/application/src/prediction-report.ts:266-268`（`current_prepared` 及默认模式）：

```ts
const modelReadiness: PredictionReadiness = options.mode === "neutral_potential"
  ? { five_k: 1, ten_k: 1, half_marathon: 1 }
  : readinessEvidence.values;
```

3. `packages/physiology/src/index.ts:944-947`：

```ts
const readinessValue = clamp(
  readiness[distance] ?? config.defaultRaceReadiness[distance],
  0, 1
);
const readinessPenalty = (1 - readinessValue) * config.raceReadinessVdotPenalty[distance];
```

4. 默认值（`packages/physiology/src/index.ts:117-125`）：`five_k 0.7 / ten_k 0.6 / half_marathon 0.45`，罚分 `3 / 4 / 6` 个 VDOT 点。`docs/` 中没有任何一处记载这三个数。

**探针复现**（`/tmp/probe-predict.mts`，VDOT 50）：

```
empty {}       five_k 1215  ten_k 2550  half 5825   readiness=null  code=endurance_readiness_unmodeled  method=daniels_vdot_v1
readiness=1    five_k 1196  ten_k 2480  half 5491   readiness=1     code=race_readiness_applied
explicit null  five_k 1215  ten_k 2550  half 5825   readiness=null  code=race_readiness_applied+race_readiness_low  method=daniels_vdot_readiness_v2
```

即：**准备度缺失**时，预测时间仍按距离分别被拉慢 **+1.6% / +2.8% / +6.1%**（半马差 334 秒），而响应里 `readiness` 字段是 `null`、`readinessStatus = insufficient_data`、还带 `race_readiness_missing` 提示。更糟的是**显式 `null`**（文档语义 = unknown）走的是 `??` 分支并输出 `race_readiness_applied`、半马甚至 `race_readiness_low`、`method = daniels_vdot_readiness_v2` —— 字段是 `null`、证据码却说"已应用且偏低"，`assertPhysiologyPredictionSnapshot`（`packages/contracts/src/index.ts:1490-1533`）只校验范围，不校验这一致性，所以能通过。生产路径目前传的是 `{}`（`undefined`），显式 `null` 分支暂无调用方，属于"埋着的第二个坑"。

**影响**：只要"有成绩证据、但 56 天窗口内没有可算准备度的训练"（只录成绩不记训练、受伤/停训后回来、导入的历史全部超出窗口），`current_prepared` 的预测就系统性偏慢，且越长的距离被假设得越没准备 —— 正是 ALGORITHM §8/D01 想禁止的"缺历史完整性 ⇒ 当作低准备度"，只是发生在预测数值层而不是 preparation 标签层。训练侧同样受影响：`buildRaceResidualFeatureValues`（`packages/application/src/prediction-training-data.ts:302-303`）把 `readiness: null` 与含默认罚分的 `logPredictedSeconds` 一起作为训练特征，特征与目标口径不一致。

**建议**（按优先级）：
- 二选一并写进 §11：缺失准备度时 **a)** 按 `neutral_potential` 处理（`readinessValue = 1`，只给 unmodeled 证据码），或 **b)** 保留默认值但显式命名/文档化（`UNMODELED_RACE_READINESS`），并在响应中把"默认值参与计算"作为单独字段暴露；
- 无论选哪个，`readiness[distance] === null` 时不得输出 `race_readiness_applied` / `race_readiness_low` / `daniels_vdot_readiness_v2`；
- 在 `assertPhysiologyPredictionSnapshot` 增加不变量：`readiness === null` ⇒ `readinessAdjustmentSeconds === null`；`method.endsWith("readiness_v2")` ⇒ `readiness !== null`。

---

### D-03（P2，已复现）特征向量合同校验弱于自身声明

**证据**（`packages/contracts/src/index.ts:981-1000`）：校验器只查三个 ID 非空、`durationSeconds` 非负有限、三个比率区间、以及 `signals` 的 finite-or-null。`distanceKm`、`averageSpeedMetersPerSecond`、`averageHeartRateBpm`、`workoutStartAt`、`computedAt` 完全不校验；`qualityScore`/`heartRateCoverage`/`sourceConfidence` 的区间判断用 `< 0 || > 1`，NaN 两个比较都为 false 因此**放行**。

**探针复现**（`/tmp/probe-misc.mts`，构造合法向量后逐项污染）：

```
ACCEPTED: NaN qualityScore
ACCEPTED: Infinity distance
ACCEPTED: null speed with 0
ACCEPTED: bad date
rejected: NaN signal -> efficiencyRaw must be finite or null
rejected: negative duration -> durationSeconds must be a non-negative finite value
```

**影响**：这是 `packages/features` 写库前的最后一道合同闸（`features/src/index.ts:601`、`v4.ts:162,182`、`legacy-v3/index.ts:583`）。目前生产上游（canonical 事实 + 解析器）大体在更早的地方拦住了非法值，所以我没有观察到端到端污染；但一旦上游回归，NaN `qualityScore` 会一路进 `scoreFeature` → `windowed confidence` 的 `assertFinite` 抛错（重算整批失败），非法 `workoutStartAt` 会让 `sortWorkoutFeaturesChronologically` 的比较器返回 NaN（排序不稳定）—— 失败点离坏数据很远，难定位。按严重度定义属"防御性"缺口，但它是 §3/§16.1 "非有限数必须显式拒绝"这条合同的执行点，故给 P2。

**建议**：补 `assertFiniteOrNull` 到所有可选数值字段、`Number.isInteger`/区间到 `heartRateSampleCount`/`routePointCount`、日期用 `Number.isFinite(Date.parse(...))`、枚举校验 `sessionType`/`eligibilityStatus`/`missingReasons`；区间判断统一写成 `!(value >= 0 && value <= 1)` 以让 NaN 落网。

---

### D-04（P2，已复现 + 可达性代码阅读）同标尺 transition gate 对 null 指标放行

**证据**（`packages/storage-sqlite/src/model-transition-gate.ts:261-276,345-348`）：

```ts
const exceeds = (value: number | null, limit: number): boolean => value !== null && value > limit;
...
if (exceeds(metrics.currentAbilityMeanAbsoluteDelta, thresholds.maxCurrentAbilityMeanAbsoluteDelta)) { ... }
```

`null`（"算不出来"）与"在阈值内"共用同一个 false 结果，且不产生 `notEvaluableReason`。只有 `matchedSessions === 0`、`transition === "unknown"`、`no_base_run` 会进 `not_evaluable`。

**探针复现**（`/tmp/probe-gate.mts`，同 schema/同版本，`matchedSessions: 12`，五个分布指标全 `null`）：

```
status passed  blocksActivation false  reasons []  notEvaluable []  transition same_scale
```

**可达性**（代码阅读，未端到端复现）：`evaluateValidationGate` 产出的 `currentAbilityP95AbsoluteDelta` 在 `absDeltas.length === 0` 时就是 `null`（`packages/storage-sqlite/src/model-run-repository.ts:303`），而 `matchedSessions` 来自 `COUNT(*)`。只要两侧能配对但 `current_ability` 全为 NULL（例如全部 trial/excluded 的评估），就会出现"配对数 >0 而 CA 差值不可算"的组合，于是同标尺的分布保护整块被跳过。`recoveryNullRateDelta`/`recoverySaturationRate` 在 `baseTotal === 0` 时同样是 null 并同样跳过。

**影响**：ALGORITHM §14 明写"not_evaluable 是正式状态，不能按'不是 failed'绕过激活"。这里的实际效果是"null 指标不进入 not_evaluable，直接算 pass"，等于把未评估当成合格来激活一个同标尺模型。空数据集路径（`emptyCohort` 显式证明）是另一条合法分支，不受本项影响。

**建议**：同标尺下把"比较所需指标为 null"显式加入 `notEvaluableReasons`（可保留 `emptyCohort` 的例外），并为 `matchedSessions > 0 + CA 全空` 增加一条 gate 单测。若要保留"null = 不适用"，至少要像 `recoveryIsolationHolds` 那样给出区分字段（`:72-77` 已有先例）。

---

### D-05（P3）个人区间展示闸门无生产调用点

`packages/model-eval/src/index.ts:1165` 的 `assertPersonalIntervalPresentation` 自称是"个人带不得借人群词汇"的可执行形式；但全仓 `grep` 只在 `packages/model-eval/test/*` 命中，生产侧（`apps/api/src/data.ts:1889-1905`、`packages/application/src/personal-calibration.ts`）直接透传 `fitPersonalInterval` 的返回值。当前风险低：`fitPersonalInterval` 的返回类型是 `PersonalIntervalEvidence`（`coverageClaim` 为字面量、无 `nominalCoverage` 字段），TypeScript 已挡住大部分误用；风险在于"对象被 spread/拓宽成普通对象后再挂字段"时没有运行期闸门。建议在 `labelProgress()` 组装响应时调用一次（成本为常数级），或在契约层把字段定义为 `readonly` 并在响应序列化前断言。

### D-06（P3）心率分区接受非正心率

**探针**（`/tmp/probe-zones.mts`，profile 回退 resting=60/max=190）：

```
hr NaN -> null   hr Infinity -> null   hr 0 -> recovery   hr -10 -> recovery   hr 200 -> anaerobic
```

`packages/training-zones/src/index.ts:364-366` 只要求 finite 且 `max > rest`，没有 `heartRateBpm > 0`；`analyzeWorkoutZones`（:706-713）只对速度样本过滤 `> 0`，心率样本未过滤。一条字段损坏的心率样本（0 bpm）会被计为 recovery 暴露并计入 `heartCovered`，抬高心率覆盖率与恢复区时长。上游解析器大概率已拦住，故 P3；建议在 `heartRateZoneFor` 加 `heartRateBpm <= 0 → null`，与 `paceZoneFor` 已有的 150–900 边界保持同一风格。

### D-07（P3）N02"单调"文字超出测试与真实行为

**探针**（`/tmp/probe-grade.mts`，300 s/km 原配速，Minetti 多项式）：

```
grade -45%  cost 4.0134  adjusted 269.10
grade -40%  cost 3.5979  adjusted 300.18
grade -30%  cost 2.4585  adjusted 439.29
grade -25%  cost 2.0230  adjusted 533.86
grade -20%  cost 1.7993  adjusted 600.23
grade -15%  cost 1.8355  adjusted 588.41
grade   0%  cost 3.6000  adjusted 300.00
```

Minetti 的能耗在 −20% 附近最小、之后随坡度变陡重新上升（制动/离心成本），因此"等强配速随坡度单调"在 −20%…−45% 区间不成立（−20% 的 600 s/km 比 −30% 的 439 s/km 更慢）。这不是代码 bug（模型是已发表模型，N02 也允许域内夹取），而是**矩阵条目与测试的不一致**：`packages/physiology/test/grade-adjustment.test.ts:23` 只取 `[-6,-3,-1,0,1,3,6,10]`，恰好全部落在单调区间。建议把 N02 的断言改成"上坡段单调、零坡度恒等、下坡域内说明非单调并给出成本模型最低点"，或把测试采样扩到 ±45% 并按"U 形"断言。

### D-08（P3）TA 拒绝归因未落库

`updateTrueAbilityFromFeatureScore` 精心区分了 9 种 `TrueAbilityUpdateRefusal`（`packages/scoring/src/model.ts:623-652`），注释明确"报表据此统计拒绝原因，不必（也不许）自己重写阈值"。生产唯一调用方 `recompute-pipeline.ts:3897-3963` 只持久化 `updatedTrueAbility`、`directionFactor`、`growthResistance` 与 `explanation`（含 confidenceV2/comparability/learningObservation），**没有 `refusalReason` 字段**；全仓 `grep` 表明 `awaiting_negative_confirmation` 只出现在 scoring 测试里。离线消融脚本自己另算 `refusalReasons`（`scripts/ablation-ca-weights.mts:654`），与评估表无关。结果是"某次训练为什么没更新 TA"在数据库里无法回答，只能靠重算阈值（正是设计禁止的做法）。建议在 `explanation` JSON 里追加 `refusalReason`（无需迁移，`explanation` 已是 JSON 列），或在评估表加列并写迁移。

### D-09（P3）条件责任账本无运行期对照

`packages/normalization/src/index.ts:289-352` 的 `defaultConditionLedger` 在模块加载时 `validateConditionLedger`，但校验的是**表自身**（id 不重复、字段不重复、同一对象同一字段只有一个 owner）；`location` 只是 `文件:函数` 字符串，不校验函数是否存在，也不存在"代码里实际施加修正的地方 ⊆ 账本"的运行期检查。新增第三处修正点（例如把 `gradeAdjustedPace` 接进证据链）不会让任何测试或启动检查变红。P02 的"同一责任只能应用一次"因此在工程上依赖人工评审。建议至少加一个脚本级检查（`grep` 关键函数名 + 账本对账），把 `packages/physiology/src/index.ts` 的两处修正点变成可机检集合。

### D-10（P3）两套语义 JSON 规范化并存

`apps/api/src/plan-digest.ts:61-62` 的 `stableJson` 对对象键用 `localeCompare(left, right, "en")` 排序；`packages/contracts/src/semantic-json.ts:75-84` 用 `Object.keys(record).sort()`（UTF-16 码元）并显式注释"跨平台稳定"。两者都服务哈希，且都各有调用方（`digest()` 用于 `coherenceToken`/`historyDigest`/操作结果摘要；`canonicalSemanticJson` 用于谱系/语义 hash）。目前没有跨系统比较这两个哈希的路径，所以不是缺陷；但它意味着"同一份内容在两个域里可能得出不同摘要"，而 P2-13 刚把 TS/Swift 的数值口径统一到 `floor(x*1e6+0.5)`（见 §4.1），这里却仍有两套 key 排序。建议：若两者永不互通，在 `stableJson` 注释里写明"只用于服务端本地相等比较"；若要互通，统一到码元排序（`localeCompare("en")` 会把大小写/重音按语言规则排序，等于给"语义"引入了 locale 依赖）。

---

## 4. 证据等级与未验证边界

### 4.1 已核对且成立（正向结论，避免后续重复审查）

1. **D4 / F01–F02：Fitness 不读当天恢复。** `packages/scoring/src/**` 对 `readiness|sleep|hrv|rhr` 的引用数为 **0**（`grep` 无命中）；`features/src/v4.ts:18-24` 在调用旧抽取器时把 `restingHeartRate/hrvSdnn/sleepDurationMinutes/recentLoadMinutes/recoveryBaseline/recoveryContext` 全部置 `null` 并过滤掉 `recovery_data_missing`；`scoreFeature` 的维度权重里 `recovery: 0`（`model.ts:106-121`）；`packages/application/test/recovery-isolation-e2e.test.ts` 从原始事实装配做端到端 F01/F02 断言。**成立。**
2. **null ≠ 0 与未校准不罚分。** `evaluateConfidenceV2`（`scoring/src/index.ts:135-190`）显式区分 null（`insufficient_evidence`，`evidenceReliability=null`）、0（`available` 且可靠性 0，无 `log(0)`）、非有限/越界（抛错）；`modelConfidence`/`overall` 恒为 `null` 并带 `not_calibrated`，没有默认填 1。**成立。**
3. **连续学习率与负向确认。** `alpha(N) = 0.04 + 0.11·e^(−N/25)` 无分段跳变（`scoring/src/index.ts:315-323`）；负残差必须连续 `negativeConfirmationCount=2` 次才落地，`race` 协议测试豁免，`pendingNegativeConfirmations` 通过 checkpoint 持久化（`recompute-pipeline.ts:3718,3834,3979`）。**成立。**
4. **个人/人群门槛不混用。** 人群 `50/8`（`prediction-model-service.ts:39-40`）、个人 `24/4 = artifact 门槛`（:41-56）、个人自校准 `8 标签/2 距离/120 天`（`model-eval/src/index.ts:1012-1018`）；`predictionScopeFloors` 只降"需要多少数据"，`validateTrainingResult` 对两种 scope 走**同一套**激活判据（`maeImprovement ≥ 5%`、walk-forward、bootstrap、分距离回退、ONNX parity），scope 由 manifest 与 run 双向校验（`validateArtifactBoundary`/`assertCatBoostArtifactManifest`）。**成立。**
5. **手工成绩 labelAvailableAt = recordedAt。** 仓储层 `recordedAt` 由录入时刻生成（`performance-entry-repository.ts:119-143`），预测装配用 `max(recorded, completedAt)`（`prediction-data.ts:911`），且校准/回放按 `availableAt <= asOf` 过滤（`prediction-report.ts:344-347`）。**成立。**
6. **个人区间禁人群词汇。** `PersonalIntervalEvidence` 类型上无 `nominalCoverage/coverageP80/coverageP90`，`coverageClaim` 为固定字面量，`fitPersonalInterval` 低于地板返回 `null`、非有限残差不参与拟合但计入 `samples`（`model-eval/src/index.ts:1113-1145`）。生产透传未挂覆盖率字段。**成立（运行期闸门见 D-05）。**
7. **ONNX 工件与懒加载（HEAD 回归范围）。** `assertCatBoostArtifactManifest` 仍强制 `scope ∈ {population,personal}`、`status="accepted"`、三方 sha256、feature schema hash 与特征名逐字相等、`correctionCapFraction` 恰为契约常量（`prediction-inference/src/index.ts:80-130`）；`load()` 校验模型文件 hash、输入/输出名与 float32 元数据后才建 session（:171-197）；懒加载把 `InferenceSession/Tensor` 改为按需 `import()`，失败仍抛错，不静默降级；`prediction-report.ts:643-668` 在加载失败时清缓存并让上层落 `feature_schema_mismatch`/`inference_failed` 的显式 fallback 码。**成立。**
8. **数值口径（P2-13 回归）。** `prescriptionNumber` 与 Swift `PlanFingerprint.prescriptionDigest` 使用同一 `floor(x*1e6+0.5)` 整数微单位 + 定长拼接（TS `plan-digest.ts:36-55`；Swift `PlanStatePolicy.swift:156-178`），`-0→0`、`|x|>1e9` 抛错、kind 枚举校验均在。**成立。**（另一套 key 排序见 D-10。）
9. **验收矩阵。** `check:acceptance-matrix` 报 80/80 cited、0 gap；80 个 ID 每个都至少被一个 `test/` 文件引用（自写脚本）；F01/F02 有从原始装配出发的 e2e 测试，不是只在注释里出现。**成立**（条目质量抽查见 D-07 的反例）。
10. **定向测试**：scoring/readiness/training-load/model-eval **172 pass**；features/physiology/contracts/dynamics/durability/normalization/prediction-inference/zones **188 pass**，合计 **360 pass / 0 fail**。

### 4.2 本轮未验证的边界

- **未跑全量 `npm test`、未跑 `typecheck`**：前者 Lead 正在后台跑（约 9 分钟），后者 Lead 已跑 EXIT=0；本 lane 只用定向测试 + 纯函数探针，不重报整体绿灯。
- **未触真实库**：D-02 的生产可达性、D-04 的 SQLite 侧 null 组合均为"代码阅读推断"，没有在 `var/rai.sqlite` 副本上端到端复现（任务禁止读写真实库）；两项的纯函数部分已用探针复现。
- **未复跑 Swift**：D-10 与 §4.1-8 的 Swift 侧结论引用既有 HEAD 代码与上一批（P2-13）的交叉验证结果，本轮没有重新编译 Swift fixture。
- **未做突变验证**：本仓库只有 `test:coach:mutation` 与 `test:ios:mutation` / `test:ios:mutation:scope`；scoring/readiness/physiology 的 golden 断言都没有"故意改坏实现看测试是否变红"的突变证明。抽查 F06（`learning-rate-composition.test.ts:23-42`）与 F14/F15（`confidence-and-gating.test.ts:78-135`，null/0/抛错三态）都是真行为断言，未发现"测试自己实现一遍公式再对比"的假绿，但全绿本身仍不能证明这些门有牙。这是全仓级测试可信度边界，不单列 finding。

### 4.3 其它观察（未达 P3 门槛，供后续参考）

- `packages/model-eval/src/index.ts:181-213` 的 `assertIndependentTemporalPartitions` 用 `>` 与 `+embargoMs` 严格比较，边界方向正确；`predictionMetrics` 零样本返回全 null，不会"零标签宣称准确率"。
- `packages/dynamics/src/index.ts:101-118` 的覆盖率按 30 秒桶累计、`offsets.size < 2 → 0`、末桶按实际时长计，与 §9.7 的声明一致。
- `packages/training-load/src/form.ts:161-202` 两条 `insufficient_data` 分支都返回 `remainingHours: null`；`chronic <= 0` 也走 insufficient（L05/L06 成立）。小缺口：`recentLoads` 过滤了 `load > 0`，一条 load 为 0 的已结束训练不会被当作锚点，可能回退到更早的训练（影响很小，未列 P 级）。
- `packages/prediction-inference/src/index.ts:68-72` 缓存的 `onnxRuntime` 是 rejected promise 时也不会自愈（进程内一次失败后永久失败）。当前结果是"明确抛错 + 上层 fallback 码"，可接受；若未来支持运行时补装依赖需重置缓存。
- `packages/durability/src/index.ts:373` 的 `historyCoverageDays ?? 0` 是死代码（`assessPreparation` 两条返回路径都给出 number），非 null→0 语义问题。

---

## 5. 与既有审查关系

| 既有记录 | 本轮关系 |
|---|---|
| `docs/PROJECT_REVIEW.md`（2026-09-30，R1–R4 已修） | 未重报；本轮 P2/P3 均不在其清单内。 |
| `deliverables/training-plan-review-2026-10-18/`（3 P1 + 18 P2 + 21 P3） | 其 `03-domain-algorithms.md` 覆盖的是周期化骨架、处方摘要（P2-12/P2-13）、日期校验、`phases` 文档漂移，属 API/计划域；本轮的 10 项均不在该清单内（D-07 只涉及 §16.1 N02 的文字与测试，不涉及已修的 P2-16 矩阵条目）。 |
| P2-12（24 周口径）/P2-13（摘要 micro 量化）/P2-16（G06–G08 矩阵） | 已修且 HEAD 仍成立（§4.1-8、`check:acceptance-matrix` 80/80）。本轮 D-10 指出"同一仓两套语义 JSON key 排序"是**新**的、与 P2-13 数值口径相邻的问题，不是 P2-13 的回归。 |
| D4 / D10 / D11 / D12 / D16 | D4、D10、D11、D12 见 §4.1 正向结论；D16（阶段唯一来源）属计划域，本轮未审。 |
| HEAD 回归范围（`packages/prediction-inference` 懒加载、`packages/api-contracts`） | 懒加载改动经核对未削弱工件校验/fallback（§4.1-7）；`api-contracts` 新增的是 `MobilePlanOperationQueryResponse` 共享类型，属合同/HTTP 层，归 Lane 3/4，本轮只在类型层扫过（无算法语义）。 |

**对 D-01 的标注**：该不一致早于 HEAD 存在（2026-09-04 起），但从未被任一既有审查记录；按"当前 HEAD 仍违反即重报"的口径列为新发现，并在详情中说明了来源。

---

## 附：复现脚本（均在 `/tmp`，未纳入仓库）

- `/tmp/probe-readiness.mts` —— 连续三夜 0.78 → `multiple_low_signals` 且 `sleepLow=false`
- `/tmp/probe-predict.mts` —— 缺失/显式 null/readiness=1 三种输入的预测秒数与证据码
- `/tmp/probe-misc.mts` —— `assertWorkoutFeatureVector` 的 NaN/Infinity/非法日期放行
- `/tmp/probe-gate.mts` —— 分布指标全 null 时 transition gate `status=passed`
- `/tmp/probe-zones.mts` —— 非正心率落入 recovery
- `/tmp/probe-grade.mts` —— 坡度 −20%…−45% 的等强配速非单调表
