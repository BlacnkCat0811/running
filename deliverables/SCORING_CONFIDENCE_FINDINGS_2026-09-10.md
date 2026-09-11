# 评分设计中「置信度」的审计结论

日期：2026-09-10 · 范围：只读分析，未改动任何代码
触发问题：为什么 9.9 之后的排查中，佳明（connect）跑步的负荷置信度只有 0.02 量级？

---

## 0. 结论先行

| # | 结论 | 级别 |
|---|---|---|
| 1 | 佳明跑步**不更新 true ability**，真因是**维度权重门禁**（`minimumAvailableWeight=0.65`），**与 0.02 无关**。即使置信度给 1.0，结果一样是 `trial`。 | 🔴 |
| 2 | 0.02 是真实缺陷。但**线上真正的倒挂不在「距离」，在「阈值配速」**：同样有距离、无心率的数据，只因 zone profile 里没有阈值配速就被判「无任何证据」，反拿 **0.26~0.32**；真正算出配速轴的 150 条只有 **0.015~0.018**。**差 14~21 倍**（全库 267 条实测）。 | 🔴 |
| 3 | 根因是**两套置信度量纲并存**：手设 Banister 阶梯（`0.4 × sourceConfidence`）vs 乘性实测阶梯（`source × coverage × profileConfidence`）。回退常数区间 0.16~0.40 直接压死整条配速轴（上界仅 0.22）。R3-15 与「单轴特判」是同一根因的两个补丁，都没治根。 | 🔴 |
| 4 | P1（单轴改 `max()`）**不建议单独发布**：它翻掉一个显式钉死该行为的测试（`training-load/test/training-load.test.ts:183-189`），且结果 0.0454 仍低于 0.26，不改变任何下游决策。 | 🟡 |
| 5 | P2 有真实用户可见后果：`loadConfidence` 被当成「训练状态置信度」渲染（`data.ts:772` → `StatisticsPage.tsx:82`），会显示「训练状态：维持 ｜ 置信度 2%」——而该状态是按 100% 权重的原始负荷算出来的，纯误导。 | 🔴 |

---

## 1. 评分体系是两层，彼此独立

| 层 | 计算入口 | 置信度含义 | 落库位置 | 佳明实测 |
|---|---|---|---|---|
| **负荷层** | `calculateCompositeTrainingLoad` → `calculateWorkoutTrainingLoad` | 这条负荷值有多可信 | `active_workout_training_loads.confidence` | **0.0196 ~ 0.0202** |
| **能力层** | `scoreFeature` → `confidenceScore` | 这次能力估计有多可信 | `ability_assessments.confidence` | **0.6568**（≥0.6 门槛，**通过**） |

关键：能力层用的是 `feature.sourceConfidence`（connect = **0.6**，`packages/features/src/index.ts:144-157`），**不是**负荷层的 confidence。
`packages/scoring/src/model.ts:315-321`：

```ts
const confidenceFactors = { coverage, source: feature.sourceConfidence, comparability, maturity };
const confidence = confidenceScore(confidenceFactors);   // 几何加权：0.35/0.25/0.25/0.15
```

---

## 2. 佳明跑步为何零贡献：维度权重门禁（真因）

配置 `packages/scoring/src/model.ts:27-42`：

```
minimumAvailableWeight: 0.65
dimensionWeights: efficiency .375 | pace .3125 | cardio 0 | stability .1875 | recovery .125
```

佳明跑步（无心率序列、无 GPS、无逐秒速度）的维度可用性：

| 维度 | 权重 | 佳明是否可得 | 依据 |
|---|---|---|---|
| efficiency | 0.375 | ❌ null | `efficiencyRaw = speed / avgHR`，无 avgHR（`features/src/index.ts:597-598`） |
| pace | 0.3125 | ✅ 有 | `paceRaw = speed`（由总距离/时长推出平均配速） |
| cardio | 0（不参与） | — | 配置显式置 0（`model.ts:32-33`） |
| stability | 0.1875 | ❌ null | `1 - avg([speedCv, hrCv])`，两者皆无（`:543-547`） |
| recovery | 0.125 | ✅ 有 | Garmin 会写 `RestingHeartRate`（实测 RHR 69/70） |

可用权重 = 0.3125 + 0.125 = **0.4375 < 0.65** → `scoreFeature` 返回 `status = "trial"`（`model.ts:338-351`）。

**线上实测（2026-08-17 ~ 08-22，6 次佳明跑步）**：

```
assessment_status   = trial
confidence          = 0.6568        confidence_factors = {coverage:0.4333, source:0.6, comparability:1, maturity:1}
effective_weights   = {"pace":0.714,"recovery":0.286}     ← 0.4375 归一化后的结果
efficiency_score    = null          stability_score = null
current_ability     = null          workout_contribution = null
true_ability_before = 46.12303450623899 == true_ability_after
explanation_codes   = ["data_insufficient"]
```

`updateTrueAbilityFromFeatureScore` 要求 `score.status === "eligible"`（`model.ts:398-410`），trial 直接 `updated = false`。

→ **佳明跑步 100% 无法更新能力值，拦截点是 status，不是 confidence。**

---

## 3. 0.02 的精确来源：三层相乘

以 2026-08-22 那次为例，全部数值可逐层复算：

| 层 | 公式 | 实值 | 依据 |
|---|---|---|---|
| ① profile 配速置信度 | `daily_zone_profiles.pace_confidence`（provisional，随距上次配速证据衰减） | **0.2062** | 线上 `daily_zone_profiles` 实测 |
| ② 平均配速折扣 | `averageOnlyPace` → `paceCoverageForLoad = min(0.4, coverage)` | **0.4** | `training-zones/src/index.ts:704-706` |
| ③ 来源可信度 | `sourceConfidence("connect")` | **0.6** | `features/src/index.ts:152-153` |
| = composite paceConfidence | `0.6 × 0.4 × 0.2062` | **0.0495** | 与 DB `pace_load_confidence=0.0495` 吻合 |
| ④ 外层加权 | `0.6·hr + 0.4·pace`，hr 分量 = 0 | `0.4 × 0.0495` | `training-load/src/index.ts:195-197` |
| = 最终 confidence | | **0.0198** | 与 DB 完全一致 |

对照 Apple Watch（2026-09-09）：`hrc=0.5995`、`pc=0.1921`、`confidence=0.4366`
→ `0.6×0.5995 + 0.4×0.1921 = 0.4365` ✓ 同一公式，因心率轴存在而少一层 0.4 折扣。

---

## 4. 🔴 缺陷：单轴二次折扣 + 反单调

`packages/training-load/src/index.ts:187-198`：

```ts
if (input.loadBreakdown) {
  source = "composite";
  intensity = breakdown.compositeIntensity;
  // Pure RPE/session fallbacks store Banister target confidences on one axis
  // with both modality loads null — use them as-is so the 0.6/0.4 blend does
  // not drag 0.65 → 0.39 or 0.4 → 0.24.
  if (breakdown.internalLoad === null && breakdown.paceLoad === null) {
    confidence = clamp(Math.max(breakdown.heartRateConfidence, breakdown.paceConfidence));
  } else {
    confidence = clamp(0.6 * breakdown.heartRateConfidence + 0.4 * breakdown.paceConfidence);
  }
}
```

注释本身证明作者**已知**这套加权会系统性压低置信度，但只特判了「两轴都空」，**没处理「单轴有真实负荷」**。

后果矩阵（同一场佳明跑步）：

| 场景 | internalLoad | paceLoad | confidence | 说明 |
|---|---|---|---|---|
| 现状：有距离/配速 | null | 55.4 | **0.0198** | 0.4 × 0.0495 |
| 反事实：连距离也没有 | null | null | **0.24** | 0.4 × 0.6，走 `max()` 特判 |
| 反事实：只有心率没配速 | 48.6 | null | **0.6 × hrConf** | 同样被 0.6 压低，方向相反 |

**多一条真实证据（距离/配速），置信度反而降到 1/12。** 这是非单调的，逻辑不成立。

同源记录：`docs/PROJECT_AUDIT_2026-07-17_R3.md:77` ——
`R3-15 | domain | bug | composite load 忽略 sourceConfidence / average-only 折扣；RPE conf blend 后 0.39≠0.65`

### 4.1 🔴 线上实测：倒挂不止一层，主因在「阈值配速」而非「距离」

上表里的「反事实」在**线上真实存在**，而且触发条件不是距离，是 **zone profile 里有没有阈值配速**。

`calculateCompositeTrainingLoad` 的配速分支要求 `threshold !== null`（`training-zones/src/index.ts:669,678,689`）：
没有阈值配速 ⇒ `paceLoad = null` ⇒ 两轴全空 ⇒ 走 session_type 回退 ⇒ `0.4 × sourceConfidence`。

全库 267 条负荷按「是否产出证据轴」实测：

| 组 | n | 平均 confidence | 内部/配速轴 | 有距离？ |
|---|---|---|---|---|
| coros | 30 | **0.3200** | 两轴全空（profile 无阈值配速） | ✅ 全部有 |
| huawei | 39 | **0.2600** | 两轴全空（profile 无阈值配速） | ✅ 全部有 |
| connect | 144 | **0.0181** | 仅配速轴 | ✅ 全部有 |
| coros | 6 | **0.0154** | 仅配速轴 | ✅ 全部有 |
| apple_watch | 46 | 0.4040 | 双轴齐全 | ✅ 全部有 |
| connect | 1 | 0.1255 | 双轴齐全 | ✅ |
| apple_watch | 1 | 0.0751 | 仅配速轴 | ✅ |

验证查询（`pace_load is null` 的 69 条）：
```
select (p.threshold_pace_seconds_per_km is null) thrNull, count(*) n
from active_workout_training_loads l join daily_zone_profiles p on p.id = l.zone_profile_id
where l.pace_load is null group by 1;
→ {thrNull: 1, n: 69}        全部 69 条都是「阈值配速为空」
且 distance_km is null 的条数 = 0   全部都有距离
```

**结论：同样是有距离、无心率的数据，仅仅因为 zone profile 里没有阈值配速，就被判为「无任何证据」并拿到 0.26~0.32 —— 比真正算出配速轴的那 150 次高 14~21 倍。** 因为「没有阈值配速」这一侧本来信息更少，却拿到更高的置信度，这是彻底的逻辑倒挂。

### 4.2 🔴 根因：两套置信度量纲并存，互不可比

| 阶梯 | 出处 | 取值 | 量纲 |
|---|---|---|---|
| 手设 Banister 阶梯 | `training-load/src/index.ts:157-172` | 0.95 / 0.8 / 0.65 / **0.4×source** | 直接给定 |
| 乘性实测阶梯 | `training-zones/src/index.ts:707-712` | `source × coverage × profileConfidence` | 连乘 |

而 `profileConfidence` 实测被封在低位：`daily_zone_profiles.heart_rate_confidence = 0.6`；`pace_confidence` 全库绝大多数行为 **0.19 左右**（`pace_source` 在 46,779 行里 46,759 行是 `carried_forward`，即靠衰减继承，只有 860 行是 `automatic`）。

于是上界变成：
- 实测心率轴最高 ≈ `1.0 × 1.0 × 0.6` = **0.60**
- 实测配速轴最高 ≈ `1.0 × 1.0 × 0.22` = **0.22**
- 而「什么都没有」的回退常数 = `0.4 × sourceConfidence` = **0.16 ~ 0.40**

→ **回退常数直接压死了整条配速轴。** 只要没有心率，配速跑再详实也不可能超过「什么都没测到」的那次。

R3-15 的注释（"so the 0.6/0.4 blend does not drag 0.65 → 0.39 or 0.4 → 0.24"）说明作者当时已经在**试图把乘性阶梯的产物对齐到手设阶梯** —— 即根因是「两套量纲」，R3-15 是它的第一个补丁，单轴特判是第二个，都没治根。

---

## 5. 0.02 的实际影响面

| 用途 | 是否受 0.02 影响 | 依据 |
|---|---|---|
| true ability 更新 | ❌ 不受影响（0.6568 已过门槛，且被 trial 拦掉） | `ability_assessments` 实测 |
| 急性/慢性 EWMA、loadRatio、rampRate、monotony、strain | ❌ 不受影响——`buildDailyTrainingMetrics` 用**原始 load** 求和，confidence 完全不参与加权 | `training-load/src/index.ts:257-259, 277` |
| `/v1/workouts?confidence=high/medium/low` 筛选 | ✅ 受影响，佳明跑步**永远**落 low | `storage-sqlite/src/read/workout-read-repository.ts:149-151` |
| UI / 统计接口 `loadConfidence` | ✅ 受影响 —— 且被暴露为 **`statusConfidence`**，即「训练状态的置信度」 | `apps/api/src/data.ts:772`、`StatisticsPage.tsx:151,82` |
| 预测训练数据 | ❌ 用的是 `qualityScore × sourceConfidence`，不是负荷 confidence | `application/src/prediction-data.ts:294` |

→ 即：**佳明跑步的 43~55 负荷被全额计入训练负荷曲线，却被标称 2% 可信度。** 两头都不像：既没有按可信度衰减，也没有排除。

`apps/api/src/data.ts:772`：

```ts
statusConfidence: overview.rolling7Days.loadConfidence,
```

`apps/web/src/pages/StatisticsPage.tsx:82` 把它直接渲染在训练状态卡片上：

```tsx
<span>置信度 {confidence === null ? "--" : `${Math.round(confidence * 100)}%`}</span>
```

→ **用户看到的会是「当前训练状态：维持 ｜ 急性/慢性 1.05 ｜ 置信度 2%」。** 而那个「维持」状态是用 100% 权重的原始负荷算出来的。这是纯误导，也是 P2 必须处理的真正理由。

---

## 6. 判断与建议（未改代码）

1. **现状方向是对的**：佳明跑步进时间线、但不更新 true ability —— 无心率的能力估计本就不可靠，`trial` 拦截是正确取向。**不建议为了让它"算数"而放宽 0.65 门禁。**

2. **P1（单轴特判用 `max()`）—— 结论修正：不建议单独发布。**
   改动点 `training-load/src/index.ts:193`，与已修 R3-15 同构，能把 0.0181 → 0.0454。但：
   - 🔴 **它不是静默修 bug，而是行为变更** —— 已有测试把它钉死了：`packages/training-load/test/training-load.test.ts:183-189`
     ```ts
     const paceOnly = make(0, 1, 0.8, 1);   // heartRateConfidence=0, paceConfidence=1
     assert.deepEqual([paceOnly?.source, paceOnly?.intensity, paceOnly?.confidence],
                      ["composite", 0.8, 0.4]);   // ← 显式期望 0.4
     ```
     测试名就叫 `composite metadata covers pace-only ...`。要改它必须先承认这是**语义变更**，而不是把测试改绿。
   - 🔴 **收益为零决策影响**：0.0454 仍远低于 0.6，`/v1/workouts?confidence=` 的 high/medium/low 分桶（阈值 0.8/0.6）不变；EWMA、能力、预测都不吃这个数。
   - 🔴 **只抹平 2.5 倍，不解决 14~21 倍倒挂**：0.0454 仍 < 0.26/0.32。
   → 应当**并入 P1b 一起做**，或干脆不做。

3. **P1b（治根：统一两套量纲）—— 这才是真正该做的。**
   目标：让「实测轴置信度」与「回退常数」落在同一刻度。两种可选口径（需你定）：
   - 口径 A（改回退）：把 `fallbackHeartConfidence = 0.4 * sourceConfidence`（`training-zones:728,734`）也乘上 profile 因子，使其与实测轴同构。改动小，但会**下调** huawei/coros 那 69 条从 0.26/0.32 到 ~0.07，属于「把虚高的打下去」。
   - 口径 B（改实测轴）：提高 `profile.paceConfidence` 的可信上限（当前实测量纲 0.19 明显被 `carried_forward` 长期衰减压死，`training-zones:251` 的 `0.5^(1/180)` 衰减值得复核）。改动大，会影响 zone 分析本身。
   - 验收：单测断言「有距离且算出配速轴」组 confidence > 「有距离但两轴全空」组；八月的 connect 行 ≥ 同库 huawei/coros 回退行。
   - 回归：`npm run typecheck && npm test`；`packages/training-load/test/*`、`packages/training-zones/test/*`、`packages/scoring/test/*`；重算后比对新旧 `ability_assessments` 快照（应当**完全不变**，因为 trial 已拦截）。
   - 回滚：单 commit revert + `full_recompute` 幂等重算。
   - 风险：口径 A 会改变 `statusConfidence` 的数值区间，需同步检查 `StatisticsPage` 的展示与 `apps/web/test/*`、`apps/ios` 的 `APIModels.swift:315`。

4. **P2（语义/呈现）—— 建议优先做，且不依赖 P1。**
   现状矛盾：`confidence` 不参与任何加权（`training-load/src/index.ts:257` 用原始 load），却被当作「训练状态置信度」呈现。三个选项：
   - ②A **让它真的生效**：在 EWMA 里按 confidence 加权/截断。代价大、属模型变更，会改变 acute/chronic、loadRatio、rampRate、monotony、strain，进而可能把训练状态推成 `attention/high_load` —— 需要重新校准，**风险侧变更，不建议顺手做**。
   - ②B **改名**：把 `loadConfidence` / `statusConfidence` 对外语义改为「数据完整度」。零数值风险，但触及 API contract（`packages/contracts/src/index.ts:341,372,387`）、Web、iOS 三处。
   - ②C **只改呈现（推荐）**：保留字段与计算，但把卡片上那个 `置信度 2%` 换成构成项（有无心率序列 / 有无配速轴 / 数据来源），不显示未校准的合成小数。改动面最小，直接消除误导。

5. **P3 暂不动**：若要让佳明跑步对能力有贡献，需要给「仅配速」路径单独的降权规则（如阈值降到 ~0.45）。**我反对现在做**——无心率的能力估计会污染主线。

---

## 7. 本次分析未涉及 / 已知边界

- Garmin 数据缺失属**数据源限制**（HealthKit 通道拿不到 GPS 与心率序列），不是 bug；补数据只能新增 Garmin 导入通道（FIT/TCX/GPX 或 API），属新功能。
- 本次为**只读分析**，线上库与本地代码均未修改。
- **修订记录（18:57）**：应「解释 P1/P2」之请，补做全库 267 条负荷分组实测，追加 §4.1 / §4.2，并把 P1 从「建议修」下调为「不建议单独发布」，新增 P1b（统一量纲）与 P2 的②C 选项。§6 结论以本版为准。
