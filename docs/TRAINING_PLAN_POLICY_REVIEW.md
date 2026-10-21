# 统一训练排课：三项独立政策评审（G01–G03）

> **状态：已采纳（adopted，2026-10-20）。** 仓库所有者（角色：产品/规则所有者，会话直接指令）
> 按 §4 签字表逐项批准 P-G01-B / P-G02-C / P-G03-A，代码已实现并由测试钉住
> （见 §4 的实现锚点）。**这是方向性批准，不是独立临床/教练领域复核**，也不证明训练收益或风险下降；
> 独立复核如仍需，按 §5 另立记录。
>
> 采纳后的约束：
>
> - 实现必须保持 §4 冻结的常量与失败关闭语义，**不得自行放宽**；任何数值/边界变更都是 policy version 变更，
>   并让既有已发布计划转为“待刷新”；
> - 不得靠改常数（`MINIMUM_SESSION_DURATION_SECONDS`、`taperDayCeiling`、
>   `NO_HISTORY_WEEKLY_KM`、`MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS` 等）来“修复”行为；
> - **G01-B 是行为变化**：新增赛前短激活课类别（最后 72 小时只休息）；G02-C 与 G03-A 是对现行默认值的冻结，
>   不改变既有行为。
>
> 本文**没有临床结论，也没有外部引用**：它只描述现行工程实现、可执行的常量、产品层
> 的取舍问题与验收测试形状。文中任何“更保守/更宽松”都指工程边界，不指医学安全性。

## 0. 范围、编号与通用规则

### 0.1 三项门槛

| 门槛 | 含义 | 现行状态（2026-10-20） |
|---|---|---|
| **G01** 赛前剂量（near-race dose） | 比赛前 14 天、比赛周与比赛日的单日剂量上界，以及"排不下一堂完整课"时如何表达 | **已批准 P-G01-B 并实现**：新增赛前短激活课（`rai-pre-race-activation-v1`，第 4–14 天、600–900 秒、最后 72 小时只休息）；`taperDayCeiling` 与 1800 秒对常规课的定义不变 |
| **G02** 无近期历史的容量重启（no-recent-history capacity restart） | 没有最近 4 周观测（或观测覆盖不足）时的周容量起点与可解释性 | **已批准 P-G02-C 并实现**：`rai-capacity-restart-v2`，旧历史衰减 0.5、封顶 0.7×旧均值、需连续 4 个自然周有观测才逐级释放；原有 5 km 重启下限保留 |
| **G03** 受控追加授权（controlled extension authorization） | 超过本周常规建议量后，是否/如何再放行一堂完整课 | **已批准 P-G03-A 并冻结**：现行自动 + 证据门控；9 个阻断旗标、滚动 7 日最多 2 次、1.2×/56 日/1800 秒不变 |

> **编号撞车提醒**：`docs/ALGORITHM.md` §16.1 的验收合同矩阵里也有 `G01`–`G05`，
> 那套编号讲的是周期化/依从性/重排验收，**与本文的 G01–G03 不是同一套编号**。
> 本文的 G01–G03 专指统一训练排课方案里的三个政策门槛；引用时请带"政策门槛"限定语。

### 0.2 现行代码落点

- 赛前保护与减量上界：[race-plan-policy.ts](../apps/api/src/race-plan-policy.ts)（`raceExecutionProtection`、
  `taperDayCeiling`、`executionPolicyContext`）、[weekly-plan-validate.ts](../apps/api/src/weekly-plan-validate.ts)
  （`applyRacePlanPolicy`、`weeklyPlanVolumeCeiling`）。
- G01-B 赛前激活课：[pre-race-activation.ts](../apps/api/src/pre-race-activation.ts)（窗口/结构/策略例外），
  接线于 [weekly-plan-service.ts](../apps/api/src/weekly-plan-service.ts)。
- G02-C 旧历史重启：[weekly-capacity.ts](../apps/api/src/weekly-capacity.ts) 的 `legacy_history` 源
  （`CAPACITY_RESTART_POLICY_VERSION`、`LEGACY_HISTORY_DECAY`、`LEGACY_HISTORY_CAP_FRACTION`）。
- 剂量评估：[coach-session-dose.ts](../apps/api/src/coach-session-dose.ts)（`assessSessionDose`、
  `MINIMUM_SESSION_DURATION_SECONDS`、`COLD_START_ESTIMATE_SECONDS_PER_KM`）。
- 完整课分配：[coach-complete-plan.ts](../apps/api/src/coach-complete-plan.ts)（`buildCompleteCoachWeekPlan`、
  `enforceAutomaticSessionDose`、`fitCompleteSessionsToBudget`、`no_feasible_course` 证据）。
- 周容量：[weekly-capacity.ts](../apps/api/src/weekly-capacity.ts)（`weeklyCapacity`、
  `NO_HISTORY_WEEKLY_KM`、`coachCapacityEnvelope`）、[plan-periodization.ts](../apps/api/src/plan-periodization.ts)
  （`MINIMUM_BAND_KM`、阶段量带）。
- 追加资格：[coach-extension-eligibility.ts](../apps/api/src/coach-extension-eligibility.ts)
  （`assessExtensionEligibility`）、[coach-loop-runtime.ts](../apps/api/src/coach-loop-runtime.ts)
  （预留与授权写入口）、[coach-template-library.ts](../apps/api/src/coach-template-library.ts)
  （`extension_easy_only`）。
- 训练负荷历史充分性：[training-load](../packages/training-load/src/index.ts)
  （`defaultDailyMetricConfig`）。

### 0.3 通用规则（对三项门槛都适用）

1. **Fail closed**：证据不足、不可评估、写回失败时保持原计划/休息并给出原因码，不把未知填成默认值。
   现行剂量 v2 已经把未知的一侧标成 `*_not_assessable`，不伪造配速或时长。
2. **政策变更 = 版本变更**：任何被批准的数值/边界必须 bump 对应 policy version
   （例如 `SESSION_DOSE_POLICY_VERSION`、`EXTENSION_ELIGIBILITY_CANDIDATE_VERSION`、
   `PERIODIZATION_POLICY_VERSION`），并让既有已发布计划转为"待刷新"；
   历史处方摘要、回执身份不得回写成新政策。
3. **文档同步**：政策签字落地时必须同步改 `docs/ALGORITHM.md` 的现行合同描述与
   `docs/RUN_COACH.md` 的产品边界；若新增验收 ID，`npm run check:acceptance-matrix` 必须跟着更新。
4. **不做第二写者**：本文件讨论的所有决策都不得绕过唯一发布/写入入口；结构约束由
   [check-training-plan-single-writer.mjs](../scripts/check-training-plan-single-writer.mjs) 守形状。
5. **签字材料最小集**：具名规则所有者要在 §4 的签字栏写下"批准/修改/拒绝"、冻结的常量或
   案例编号、对应 policy version 与日期。没有这一行，就仍是提案。

---

## 1. G01：赛前剂量（near-race dose）

### 1.1 现行工程默认（代码事实）

**保护窗口**（[race-plan-policy.ts](../apps/api/src/race-plan-policy.ts)）：

- `PRE_RACE_EXECUTION_PROTECTION_DAYS = 14`：`0 < daysToRace <= 14` 为 pre-race；`daysToRace === 0` 为比赛日；
  `daysToRace < 0` 为 past。
- 有骨架的标准距离（5K/10K/半马）在 pre-race 生效两条执行约束：
  `replace_quality_with_easy` 与 `cap_distance = taperDayCeiling(weeklyDistanceKm)`；
  比赛日约束为 `no_extra_training`。
- 无骨架距离（全马/自定义）走兼容保护：`UNSUPPORTED_RACE_EXECUTION_PROTECTION_DAYS = 2`，
  只禁止质量课/长距离，不虚构专项阶段，也没有 `taperDayCeiling`。

**减量单日上限**：

```
taperDayCeiling(weeklyKm) = max(1, round(min(10, weeklyKm / 7 * 0.7) * 10) / 10)
```

即"周量 ÷ 7 × 0.7"，四舍五入到 0.1 km，单日下限 1 km、上限 10 km。常用值：

| 周量 | 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 50 | 60 |
|---|---|---|---|---|---|---|---|---|---|---|
| `taperDayCeiling` | 1.0 | 1.0 | 1.5 | 2.0 | 2.5 | 3.0 | 3.5 | 4.0 | 5.0 | 6.0 |

**完整课的最小成本**（[coach-session-dose.ts](../apps/api/src/coach-session-dose.ts)）：

- `MINIMUM_SESSION_DURATION_SECONDS = 1800`（30 分钟）；自动排课以"完整课"为单位，
  不把剂量切碎成短课。
- 时间型轻松课的 km 成本上界 = `1800 / 最快允许轻松配速`。生产形状示例（最快轻松配速
  345 s/km、轻松区慢端开放）下约为 **5.217 km**；若整堂课完全没有配速证据，才允许使用
  冷启动估算 `COLD_START_ESTIMATE_SECONDS_PER_KM = 360`（约 5 km），且标注
  `cold_start_policy`，**不用于追加授权**。

**执行与表达**（[weekly-plan-validate.ts](../apps/api/src/weekly-plan-validate.ts) `applyRacePlanPolicy`）：

- pre-race 日：轻松/恢复课若实测 ≤ 单日上限 + 0.05 km，保留原课；否则按上限重建轻松课
  （`targetDistanceKm = min(measured || ceiling, ceiling)`）。
- 若重建后仍超过上限 + 0.1 km，则落为休息，原因 `赛前减量，保留恢复。`，并附警告
  `减量预算不足以支撑完整课表，改为休息`。
- 比赛日：任何非休息课都改为休息（`比赛日留白；不等于比赛已完成。`）。

**按自然周的完整课分配**（[coach-complete-plan.ts](../apps/api/src/coach-complete-plan.ts)）：

- 先扣本周实际/窗口外保留/今日预留，再在该周净预算内放完整课；放不下时给出
  `no_feasible_course：一堂完整常规课约 X km，本自然周可用 Y km；不切碎剂量、不虚构更慢配速。`
  若已放下一堂课、只是余额不足以再放，则给"本自然周剩余 X km 不足以再安排一堂完整课"。
- **重要边界**：`no_feasible_course` 只表达"自然周净预算装不下一堂完整课"，
  **不表达**"单日赛前上限低于完整课成本"。两者是不同的不可行性，不能被同一句原因代替。

**已记录的现实案例（来自核验报告，本轮未重跑）**：评估日 2026-10-20、10K 比赛 2026-10-30
（10 天）、周建议量 20 km、前一周 20 km：`taperDayCeiling(20) = 2.0 km`，而完整 30 分钟
轻松课成本约 5.217 km ⇒ 七天全部休息；其中 3 天给"赛前减量预算不足"、4 天给
"完整常规课预算不足"，且**没有** `no_feasible_course`。证据见
[统一排课核实报告 §3.5](../deliverables/UNIFIED_TRAINING_PLAN_VERIFY_2026-10-20.md)。

**现行默认不做的事**：不降低 1800 秒下限、不抬高 `taperDayCeiling`、不为凑时间编造更慢配速、
不把 20 分钟课伪装成完整课、不在比赛日排训练。这正是 G01 阻断的现状。

### 1.2 待决问题（规则所有者必须回答）

1. **Q1 最低剂量**：赛前 14 天内是否允许存在**短于 1800 秒**的轻松课？若允许，最小分钟数与
   最小剂量类别是什么？若不允许，10 天赛前可能"零训练"，产品是否接受并如何展示？
2. **Q2 单日上限的语义**：`taperDayCeiling` 是"每一天都必须低于"，还是"减量期平均/周总量"
   的上界？是否允许减量周里有 1 天完整课、其余天休息？
3. **Q3 不可行表达**：当单日上限低于任何完整课成本时，是否必须输出一个新的显式原因
   （类似 `no_feasible_course` 但包含单日上限与成本），以及是否需要在周级/UI 级给出
   "赛前减量期无法安排完整课"的明确状态，而不是只写"休息"？
4. **Q4 保护窗口边界**：14 天保护是否覆盖比赛周全部 7 天？最后 2–3 天是否仍允许轻松跑？
   比赛日前后是否沿用"比赛日留白"？
5. **Q5 无骨架/受限距离**：全马/自定义距离当前只有 2 天兼容保护；是否维持"不虚构专项阶段"，
   还是在有明确政策前继续只做兼容保护？

### 1.3 候选政策（已采纳 P-G01-B；A/C 未采纳）

| 编号 | 政策 | 工程内容 | 取舍 |
|---|---|---|---|
| **P-G01-A** | 双下限保留 + 显式不可行 | 不改 1800 秒与 `taperDayCeiling`；为 pre-race 日新增显式原因码（含单日上限、完整课成本、建议"休息"），周级/UI 显示"赛前减量期无法安排完整课"。 | 最保守、零新剂量类别；但 10 天赛前可能 7 天全休，用户容易读成缺陷；需要新增原因码与前端文案。 |
| **P-G01-B** | 赛前专用短课类别 | 在 14 天窗口内引入一个被签字的短课类别（例如 10–15 分钟轻松/恢复，且必须 ≤ 当日上限），作为独立 dose 政策；不改变 1800 秒对常规课的定义，不改变 `taperDayCeiling`。 | 能保留"赛前有动作"的产品体验；但引入低于常规下限的新课类，需新模板、新剂量评估、新回执/policy hash，且必须明确它不适用于比赛日/最后 24–72 小时（具体边界待签字）。 |
| **P-G01-C** | 减量期"一顿完整课"例外 | 保留 1800 秒最小完整课；允许在 14 天窗口内、非比赛日，最多 1 堂完整轻松课（约 5.2 km）越过单日 `taperDayCeiling`，但整周仍受阶段量带（如 taper 的 0.55–0.75）与 30% ramp 约束。 | 最接近"正常训练"体验，不新增短课类；但需要明确定义"最多 1 堂"、可用的日期窗口、以及该例外如何进入回执/审计；风险是比赛临近时仍排完整课，必须由规则所有者签字。 |

### 1.4 标准案例（规则所有者逐行签字）

> **as-of 说明**：下表的“现行默认”列描述的是 **2026-10-20 批准前**的代码行为，保留用于对照；
> 批准并实现后的现行行为见 P-G01-B 列对应的“已实现”结论（`pre-race-activation.test.ts` 与
> `training-plan-policy-adoption.test.ts` 钉住）。G01-C01/C03 不再是“整段全休”。

记号：`W` = 周建议量/观测容量，`prev` = 前一周实际量；配速取生产形状（最快轻松 345 s/km，
完整课成本 5.217 km）。"现行"列是**批准前代码**的预期结果；A/B/C 列是各候选政策的**预期决策**。

| 案例 | 输入 | 现行默认 | P-G01-A | P-G01-B | P-G01-C |
|---|---|---|---|---|---|
| **G01-C01** | 2026-10-20，10K 比赛 10-30（10 天），W=20，prev=20 | 7 天全休；单日上限 2.0；3 天"赛前减量预算不足"、4 天"完整课预算不足"；无 `no_feasible_course` | 同现行结果，但每天给出"上限 2.0 < 完整课 5.2"的显式原因；UI 显示"减量期无法安排完整课" | 可选 1–2 天短课（10–15 分钟，≤2.0 km），其余休息；比赛前最后 2 天不排 | 选 1 个非比赛日放 1 堂完整轻松课（5.2 km，越过单日上限）；其余休息；整周仍 ≤ taper 量带 |
| **G01-C02** | 同上但比赛在 20 天后 | 未进入 14 天保护，按正常周生成 | 不变 | 不变 | 不变 |
| **G01-C03** | 半马比赛 13 天后，W=35，prev=35 | 单日上限 3.5 < 5.2，pre-race 日全休 | 显式"上限 3.5 < 完整课 5.2" | 允许短课（≤3.5 km） | 最多 1 堂完整轻松课（5.2 km > 3.5，越过单日上限） |
| **G01-C04** | 比赛日当天 | 非休息课全改休息，原因"比赛日留白" | 不变 | 不变 | 不变 |
| **G01-C05** | 比赛已过（past） | 不套用 pre-race 约束，恢复正常周生成 | 不变 | 不变 | 不变 |
| **G01-C06** | 全马/自定义距离，赛前 1 天（2 天兼容保护内） | 仅兼容保护生效（禁质量课/长距离）；无骨架、无 `taperDayCeiling` | 不变 | 不新增骨架，维持兼容保护 | 不新增骨架，维持兼容保护 |
| **G01-C07** | 无比赛目标 | 无赛前保护 | 不变 | 不变 | 不变 |

### 1.5 测试向量（已按 P-G01-B 钉住）

以下向量优先写成**纯函数测试**（`executionPolicyContext`、`applyRacePlanPolicy`、
`taperDayCeiling`）再加一条 `generateWeeklyPlan` 集成；编号由规则所有者批准时冻结。

| 向量 | 断言 |
|---|---|
| **G01-V01** | `taperDayCeiling` 对 5/10/15/20/25/30/35/40/50/60 分别返回 1.0/1.0/1.5/2.0/2.5/3.0/3.5/4.0/5.0/6.0（纯函数边界表）。 |
| **G01-V02** | 有骨架的 pre-race 日 `executionPolicyContext` 必含 `replace_quality_with_easy` 与 `cap_distance = taperDayCeiling(W)`；比赛日必含 `no_extra_training`；无骨架只含 `no_quality_or_long_run`。 |
| **G01-V03** | `applyRacePlanPolicy`：pre-race 日 6 km 轻松课在 W=20（上限 2.0）下变为休息或 ≤2.1 km；警告文本包含上限或"改为休息"；任何结果都不得 > `ceiling + 0.1`。 |
| **G01-V04** | 比赛日任何非 rest 输入都输出 rest，且 reason 指明比赛日留白，不把它写成"完成"或"未完成"。 |
| **G01-V05** | past 比赛不触发 pre-race 限制（与无比赛目标的同一输入同结果）。 |
| **G01-V06** | 集成：G01-C01 的输入经 `generateWeeklyPlan` 后，若采用 A：每天的非 rest 数为 0 且原因明确含"单日上限/完整课成本"；若采用 B/C：断言被签字的例外日期集合与最大 km；两种情况下都不得出现静默"休息"而无原因。 |
| **G01-V07** | 无骨架距离不产生 `taperDayCeiling` 约束，也不产生专项阶段（policy version 仍为 unsupported 保护版本）。 |

**测试落点（已落地）**：`apps/api/test/pre-race-activation.test.ts`（窗口/结构/只替换减量休息日/F05 场景）、
`apps/api/test/training-plan-policy-adoption.test.ts`（G01 标准案例与 `taperDayCeiling` 边界）、
以及既有的 `apps/api/test/coach-loop.test.ts`、`apps/api/test/weekly-plan.test.ts`、
`apps/api/test/training-planner-regressions.test.ts`。新增断言不得修改既有断言来“顺便变绿”。

### 1.6 G01 采纳后代码不得做

- 不为 pre-race 日静默排完整课来“避免全休”；赛前短课只允许 `pre-race-activation` 定义的类别与窗口；
- 不把单日上限的不可行性冒充成本周预算的 `no_feasible_course`（除非 Q3 签字统一语义）。

---

## 2. G02：无近期历史的容量重启（no-recent-history capacity restart）

### 2.1 现行工程默认（代码事实）

**容量来源优先级**（[weekly-capacity.ts](../apps/api/src/weekly-capacity.ts) `weeklyCapacity`）：
`race_target` → `recent_volume` → `legacy_history`（2026-10-20 起，G02-C）→ `no_history`，互斥。

- `NO_HISTORY_WEEKLY_KM = MINIMUM_BAND_KM = 5`（[plan-periodization.ts](../apps/api/src/plan-periodization.ts)）。
  该常量必须高于 `weekly-plan-validate.ts` 的 `MIN_PLANNED_DISTANCE_KM = 1`，否则周上限会被
  自身下限钉死、后续 ramp 无法把周量抬起来。
- `recent = 最近四个完整自然周的均值`；`previous = 最近 7 天实际量`。
- **没有任何观测**（`recent <= 0 && previous == null`）：`source = "no_history"`、`coldStart = true`、
  `baselineKm = 5`，原因码 `no_recent_weekly_volume`（无赛事目标时再加 `no_race_target`）。
- **观测很小**（`recent < 5` 但 > 0）：附 `restart_volume_floor`，无赛事目标时
  `baselineKm = max(5, recent)`；有赛事目标时 `recentCeiling = max(5, recent * 1.3)`，
  `baselineKm = min(raceTargetKm, recentCeiling)`。
- **有观测但不足 5 km**：不会被当成"没历史"；下限仍是 5 km。
- **旧于 28 天的历史**：不参与 `recentWeeklyKm`/`previousWeekDistanceKm`。G02-C 已批准并实现
  （`CAPACITY_RESTART_POLICY_VERSION = "rai-capacity-restart-v2"`）：28 天前最后一次稳定的 4 周均值
  可按 `LEGACY_HISTORY_DECAY = 0.5` 衰减、封顶 `LEGACY_HISTORY_CAP_FRACTION = 0.7` × 旧均值，
  且需连续 4 个自然周有观测/完成轻松课才逐级释放；仍受 30% ramp、阶段量带与绝对上限约束。
- 共享周上限 `weeklyPlanVolumeCeiling(w, prev)`：`max(1, w)` 与 `max(prev, w*0.5)*1.3`
  （`RAMP_LIMIT_FRACTION = 0.3`、`RAMP_BASE_FLOOR_FRACTION = 0.5`）取小；validator 在校验时
  再乘 `VOLUME_CEILING_TOLERANCE = 1.05`。`prev` 缺失表示"没有 ramp 约束"（`Infinity`），
  不会把周量压成 0。
- 阶段量带在 `recentWeeklyKm == 0` 时也用 `MINIMUM_BAND_KM` 作为基线；因此"无历史"同时
  影响周期化量带与 `weeklyCapacity`，两处共享同一个 5 km 起点。

**训练负荷历史充分性**（[training-load](../packages/training-load/src/index.ts)）：
`defaultDailyMetricConfig = { minimumHistoryDays: 21, minimumWorkoutCount: 6, minimumChronicLoad: 5 }`。
历史不足时推荐结论的 `basis = "insufficient_training_history"`；运行时把它映射成
`loadHistorySufficient = false`，追加资格与容量证据都因此失败关闭。

**容量锚证据**（`buildCoachCapacityAnchor` / `coachCapacityEnvelope`，运行时已接线）：

- 锚只看本周一之前 28 天的可见跑步：`coverageDays`（导入覆盖天数，最多 28）、
  `observedDays`（有跑步的不同日期数）、`recentWeeklyKm`（28 天总量 / 4）、`previousWeekKm`。
- `evidenceSufficient = coverageDays >= 28 && observedDays >= 8 && recentWeeklyKm > 0 &&
  previousWeekKm > 0 && loadHistorySufficient`。
- 证据充分时用 `min(recent*1.3, previous*1.3, absoluteProtectionKm)`；不充分时退回
  `legacyProtectionKm`（即今天的建议量）与 `absoluteProtectionKm` 的较小值；阶段硬上限仍可继续收紧。
- `coverageDays`/`observedDays` 的 28/8 与训练负荷的 21/6/5 是两套不同用途的历史充分性判据，
  仍是现行工程常数；G02-C 只冻结衰减系数/封顶/确认窗口，变更这些阈值需单独决定。

### 2.2 待决问题

1. **Q1 5 km 重启下限**：是否对所有"无近期观测"的人都用同一个 5 km 周起点？是否区分
   "从未训练"、"停训很久后回来"与"设备/导入有缺口"三种情况？
2. **Q2 旧历史能否用**：28 天以前的历史是否可以作为"重启上界"（例如按停训时长衰减），
   还是只能作为 UI 解释、不进入剂量？若可用，衰减系数、停训时长上限与确认窗口由谁定？
3. **Q3 覆盖与观测的区别**：`coverageDays` 足够但 `observedDays == 0`（例如设备未佩戴/未导入）
   与"确实没有练"是否必须有不同的用户可见状态与剂量含义？
4. **Q4 重启后的升级节奏**：重启第 1 周、第 2 周、第 3 周分别允许的周量上限是多少？
   30% ramp 与 5 km 下限谁先起作用？何时允许回到赛事目标量带？
5. **Q5 赛事目标与无历史并存**：有比赛目标但无历史时，现行仍从 5 km 起步（赛事目标只作远期上界）。
   这是否是产品预期？还是需要在报名/目标确认时给"先建立基础"的显式交互？

### 2.3 候选政策（已采纳 P-G02-C；A/B 未采纳）

| 编号 | 政策 | 工程内容 | 取舍 |
|---|---|---|---|
| **P-G02-A** | 固定保守重启（现行） | 无/近零历史固定 5 km 基线；28 天外历史不进入剂量；赛事目标只作远期上界；证据不足时沿用建议量上限。 | 简单、可解释、最不易被旧数据或缺口误导；但"停训 3 个月的老手"与"新跑者"得到同一剂量，容易显得过轻；数据缺口与真实停训不可区分。 |
| **P-G02-B** | 覆盖感知重启 | 区分"覆盖不足"与"覆盖足够但零观测"：前者只给 5 km 并明确"导入覆盖不足"；后者给 5 km 并明确"已覆盖、无训练观测"；两者都需满足 `evidenceSufficient` 后才允许按观测提升。 | 不需要旧历史就能解释状态；但要把 `historyCoverageFrom`/`coverageDays` 暴露到周计划读模型与 UI，并新增状态与原因码；不改变 5 km 数值本身。 |
| **P-G02-C** | 衰减旧历史重启 | 在 5 km 下限之上，允许用 28 天以前最后一次稳定的 4 周均值 × 一个签字确认的衰减系数，且只在连续 N 周有观测/完成轻松课后逐级放开；仍受 30% ramp、阶段带与绝对上限约束。 | 对回归用户更友好；但引入新常量、新状态与更长确认链，错误使用旧数据的风险最高，且需要迁移/审计记录证明使用了哪段历史。 |

### 2.4 标准案例（规则所有者逐行签字）

> **as-of 说明**：下表的“现行默认”列描述 **2026-10-20 批准前**的代码行为；G02-C 已批准并实现，
> 冻结参数为衰减 `0.5`、封顶 `0.7×旧均值`、连续 **4 个自然周**有观测才逐级释放
> （`capacity-restart-v2.test.ts` 与 `training-plan-policy-adoption.test.ts` 钉住）。
> 因此 G02-C02 的“系数待签字”已确定为上述值；C01/C03/C05 在旧历史不可用时仍与现行一致。

| 案例 | 输入 | 现行默认 | P-G02-A | P-G02-B | P-G02-C |
|---|---|---|---|---|---|
| **G02-C01** | 新用户，28 天内 0 次跑步，无导入覆盖信息，无比赛 | `source=no_history`、`coldStart=true`、基线 5、`no_recent_weekly_volume`+`no_race_target` | 同现行 | 5 km + 显式"覆盖不足"；不接受无观测提升 | 5 km；不使用旧历史 |
| **G02-C02** | 停训 12 周，停训前 4 周均值 40 km；最近 28 天 0 次，无比赛 | 基线 5、`coldStart=true`；40 km 历史不参与 | 同现行 | 5 km + "覆盖内无观测"；仍不提升 | 5 km 起；在签字确认的确认窗口后，允许按 40 × 衰减系数逐级抬升（系数待签字） |
| **G02-C03** | 导入覆盖 28 天、设备未佩戴导致 0 次跑步 | 与 C01 同结果（基线 5） | 与 C01 同结果 | 基线 5 + "已覆盖、无训练观测"；与 C01 状态可区分 | 基线 5；不得用"未佩戴"推断"未训练"，也不得据此抬量 |
| **G02-C04** | 最近 4 周均值 3 km、前一周 6 km、无比赛 | `source=recent_volume`、`restart_volume_floor`、基线 `max(5,3)=5`；共享上限仍 5 | 同现行 | 同现行，另显式"重启下限生效" | 同现行（3 km 观测不足以启用旧历史） |
| **G02-C05** | 10K 比赛 5 周后，28 天内 0 次跑步、无覆盖信息 | `source=no_history`、基线 5；赛事目标 25×阶段比例不用于抬升 | 同现行 | 同现行 + 覆盖不足原因 | 同现行；旧历史不可用，赛事目标仍只作远期上界 |
| **G02-C06** | 覆盖 28 天、8 个有跑步日期、recent=12、prev=12、负荷历史充分 | 证据充分：envelope 上限 `min(12*1.3, 12*1.3, 200) = 15.6`（仍受阶段/赛事带约束） | 同现行 | 同现行 | 同现行（已有观测，不触发旧历史） |
| **G02-C07** | 覆盖 28 天、只有 5 个有跑步日期、recent=12、prev=12 | `evidenceSufficient=false` → envelope 退回建议量上限；`weeklyCapacity` 本身仍按观测给 12 | 同现行 | 显式"证据不足（observedDays<8）"，不按观测提升保护上限 | 同现行，旧历史不参与 |

### 2.5 测试向量（已按 P-G02-C 钉住）

| 向量 | 断言 |
|---|---|
| **G02-V01** | `weeklyCapacity({recent:0, prev:null})`：`source=no_history`、`coldStart=true`、`baselineKm=5`、原因码含 `no_recent_weekly_volume`；无比赛时含 `no_race_target`。 |
| **G02-V02** | `weeklyCapacity({recent:3, prev:6})`：`source=recent_volume`、原因码含 `restart_volume_floor`、`baselineKm=5`。 |
| **G02-V03** | 有赛事目标 + 无历史：`source=no_history`、`baselineKm=5`，赛事目标不抬高基线（现有 W05 已断言，保留）。 |
| **G02-V04** | `weeklyPlanVolumeCeiling(5, null) = 5`、`weeklyPlanVolumeCeiling(0, null) = 1`（下限保护）；`prev` 缺失不把周量压成 0。 |
| **G02-V05** | `coachCapacityEnvelope`：覆盖 28/观测 8/recent>0/prev>0/loadHistorySufficient ⇒ `evidenceSufficient=true`，base 取 1.3 倍较紧值；任一条件不满足 ⇒ `evidenceSufficient=false` 且退回 `min(legacy, absolute)`。 |
| **G02-V06** | 若采用 B：读模型/状态必须能区分"覆盖不足"与"覆盖内无观测"，且两者都不允许按 0 观测提升容量。 |
| **G02-V07** | 若采用 C：旧历史只在签字确认的确认窗口后生效，且必须记录所用历史区间与政策版本；未确认窗口内与现行 A 完全一致。 |

**测试落点（已落地）**：`apps/api/test/weekly-capacity.test.ts` 的 W01–W05 纯函数断言、
`apps/api/test/capacity-restart-v2.test.ts`（衰减/释放/冷启动）、
`apps/api/test/training-plan-policy-adoption.test.ts`，以及 `apps/api/test/coach-loop-runtime*.test.ts` 的容量锚。

### 2.6 G02 采纳后代码不得做

- 不改 `NO_HISTORY_WEEKLY_KM`/`MINIMUM_BAND_KM`/`RAMP_LIMIT_FRACTION` 来"看起来合理"；
- 旧历史只能按 G02-C 冻结的衰减系数/封顶/确认窗口使用，不得扩大使用范围；
- 不把"没有导入覆盖"当成"确认没训练"；
- 不把 5 km 下限与阶段量带下限改成两个不同的"重启数字"。

---

## 3. G03：受控追加授权（controlled extension authorization）

### 3.1 现行工程默认（代码事实）

**资格纯函数**（[coach-extension-eligibility.ts](../apps/api/src/coach-extension-eligibility.ts)）
`assessExtensionEligibility` 按顺序检查（任一命中都进入原因列表）：

| 检查 | 原因码 | 性质 |
|---|---|---|
| 生命周期不允许、非跑步日、用户请求休息 | `training_not_permitted` | 阻断 |
| 今天已有训练（事实或计划） | `today_session_already_present` | 阻断 |
| 负荷历史不足或同步未就绪（`syncStatus !== "ok"`） | `extension_evidence_insufficient` | 证据不足 |
| 恢复受限或出现任一追加阻断旗标 | `recovery_restriction` | 阻断 |
| 赛前（14 天）、比赛日、past、`taper`/`race_week`、赛事模式缺阶段/日期 | `pre_race_extension_blocked` | 阻断 |
| 最近 7 天内单次跑量超过此前 56 天单次最大值的 1.2 倍 | `recent_single_run_spike` | 阻断（每个 spike 一条） |
| 缺 56 天单次参考 | `extension_evidence_insufficient` | 证据不足 |
| 剂量不可行或整课时长不是恰好 1800 秒 | `minimum_session_not_feasible` | 阻断 |
| 自然周/滚动负荷约束未通过 | `weekly_protection_reached` / `rolling_load_limit` | 阻断 |
| 最近 7 天已批准追加数 ≥ 2 | `extension_count_limit` | 阻断 |
| 以上都没有 | `extension_allowed` | 信息 |

最终状态：有任一"阻断"原因 ⇒ `blocked`；无阻断但命中证据不足 ⇒ `insufficient_evidence`；
否则 `eligible`。"eligible"只表示**有资格**，仍需原子发布才能落课。

**关键常量**（[coach-extension-eligibility.ts](../apps/api/src/coach-extension-eligibility.ts)）：

- `MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS = 2`；滚动 7 天计数包含 pending/completed/设备未撤回
  且已匹配的回执。
- `EXTENSION_BLOCKING_FLAGS = { volume_ramp, week_jump, ramp_rate, load_ratio, strain,
  quality_cluster, long_run_jump, sleep_streak, monotony }`（9 个既有负荷/恢复旗标）。
- 单次暴露参考窗口：最近 7 天 vs 此前 56 天；比值 1.2；缺参考不算通过。
- 最小剂量：`MINIMUM_SESSION_DURATION_SECONDS = 1800`，且要求 `lower === upper === 1800`
  （不是"至少 1800"，是"恰好 30 分钟"的整课）。
- 追加候选只有轻松课（[coach-template-library.ts](../apps/api/src/coach-template-library.ts)
  `extension_easy_only`）；追加时不使用冷启动估算（`allowColdStartEstimate: !quality && !extension`）。
- 授权写入口（[coach-loop-runtime.ts](../apps/api/src/coach-loop-runtime.ts)）：只有
  `candidate.dose.distanceKm.upper != null` 才写 `allocation: "extension"` 的预留并给
  `decisionRef`；上界不可证明则不写预留、不给授权。
- 版本：`EXTENSION_ELIGIBILITY_CANDIDATE_VERSION = "rai-coach-extension-eligibility-candidate-v1"`；
  资格常量与 `coachCapacityEnvelope` 的 28/8 等都属于候选/待评审参数。
- 产品叙事见 [COACH_LOOP_OPTIMIZATION_PLAN §1.7](COACH_LOOP_OPTIMIZATION_PLAN.md)：
  第一版只放行 30 分钟完整轻松/低强度有氧课；赛前保护、质量课、长课不因追加被绕过；
  1.2、7/56 天窗口、1.30 ramp 在文档里本身就被标为"候选/待评审起点"。

### 3.2 待决问题

1. **Q1 自动还是请求**：今天的实现会在每日重排时**自动**判定并放行合格追加；这符合产品预期吗？
   还是必须由用户显式请求"今天想再跑一堂"，资格只做门控？
2. **Q2 次数与窗口**：滚动 7 天最多 2 堂是否合理？计数应按自然周还是滚动 7 天？设备未撤回的
   预留如何计入（现行计入）？跨周如何结转？
3. **Q3 证据充分性**：缺 HRV/睡眠设备时，只要负荷历史充分且无不利信号就不阻断（现行）；
   是否维持？`syncStatus` 为 `pending`/`failed`/`unknown` 时一律不放行是否过严？
4. **Q4 追加与建议量的关系**：追加课是否计入本周"建议量完成"？是否允许用户为了凑满建议量
   而触发追加（即"计划内补课"与"额外加课"是否同一条路径）？
5. **Q5 课型与剂量**：是否永远只放行 30 分钟整轻松课？未来开放更长/更强追加必须走新 policy
   version —— 谁有权签字？连续追加 2 天后是否强制次日休息？

### 3.3 候选政策（已采纳 P-G03-A；B/C 未采纳）

| 编号 | 政策 | 工程内容 | 取舍 |
|---|---|---|---|
| **P-G03-A** | 自动 + 证据门控（现行） | 保留现行资格函数与所有硬保护；每天自动重排时，合格即写预留并发布，用户可拒绝/取消。 | 体验最顺，规则集中；但用户可能"没要求也得到一堂课"，需要 UI 能解释并撤回；政策常量仍需签字冻结。 |
| **P-G03-B** | 显式请求 + 同一门控 | 资格规则完全不变，但只有在用户显式请求"额外轻松课"时才评估/发布；无请求时按常规/休息。 | 用户意图更清晰、更容易解释；但增加一次交互，且需要新的请求/幂等键/回执语义（不得变成第二个写入口）。 |
| **P-G03-C** | 迁移验证前暂停追加 | 在 PR3 迁移验证与 G03 签字完成前，始终不返回 extension（原因 `policy_pending` 或等价），只给常规计划与休息。 | 最安全、最小行为面；但移除既有产品能力，且与现行自动路径相反，作为临时状态必须有退出条件与日期。 |

### 3.4 标准案例（规则所有者逐行签字）

> **as-of 说明**：下表“现行默认”列描述 2026-10-20 批准前的行为；P-G03-A 已批准并冻结，
> 即现行行为 = P-G03-A 列（`training-plan-policy-adoption.test.ts` 与
> `coach-extension-eligibility`/`coach-loop-runtime` 测试钉住）。

"现行"列 = 当前 `assessExtensionEligibility` 的预期结果；A/B/C 为候选政策的**预期决策**。
所有案例都假定：生命周期允许训练、今天为跑步日、未请求休息、无今天训练、无赛前保护，
除表中显式变化的字段外。

| 案例 | 输入差异 | 现行默认 | P-G03-A | P-G03-B | P-G03-C |
|---|---|---|---|---|---|
| **G03-C01** | 历史充分、sync=ok、无旗标、无 spike、approved=0、轻松课恰好 1800 秒、全部约束通过 | `eligible`（`extension_allowed`） | 自动放行 1 堂 | 仅用户请求后放行 | 不放行 |
| **G03-C02** | 同 C01，但最近 7 天已批准 2 堂 | `blocked`（`extension_count_limit`） | 同现行 | 同现行 | 不放行 |
| **G03-C03** | 同 C01，但 sync=pending | `insufficient_evidence`（`extension_evidence_insufficient`） | 不放行 | 不放行（请求也不放行） | 不放行 |
| **G03-C04** | 同 C01，但半马比赛 10 天后 | `blocked`（`pre_race_extension_blocked`） | 同现行 | 同现行 | 不放行 |
| **G03-C05** | 同 C01，但最近 7 天有一次跑步、此前 56 天没有任何跑步参考 | `insufficient_evidence` | 同现行 | 同现行 | 不放行 |
| **G03-C06** | 同 C01，但最近单次 8 km > 此前最大 5 km（1.6 倍） | `blocked`（`recent_single_run_spike`） | 同现行 | 同现行 | 不放行 |
| **G03-C07** | 同 C01，但 `basis=high_load` 或恢复低信号 | `blocked`（`recovery_restriction`） | 同现行 | 同现行 | 不放行 |
| **G03-C08** | 同 C01，但候选轻松课只有 20 分钟（或时长任一端未知） | `blocked`（`minimum_session_not_feasible`） | 同现行 | 同现行 | 不放行 |
| **G03-C09** | 同 C01，但没有 HRV/睡眠设备，负荷历史充分、无不利信号 | 不阻断（recovery 为 `no_evidence`，不是低信号） | 同现行 | 同现行 | 不放行 |
| **G03-C10** | 同 C01，但今天已有训练/计划 | `blocked`（`today_session_already_present`） | 同现行 | 同现行 | 不放行 |

### 3.5 测试向量（已按 P-G03-A 冻结）

| 向量 | 断言 |
|---|---|
| **G03-V01** | 合格输入（C01）→ `status="eligible"`，`reasons` 含且仅含 `extension_allowed`；runtime 写 1 条 `allocation="extension"` 预留，`distanceKm == dose.distanceKm.upper`。 |
| **G03-V02** | 次数上限（C02）→ `status="blocked"`、`extension_count_limit`；不写预留、不给 `decisionRef`。 |
| **G03-V03** | 证据不足（sync=pending、历史不足、缺 56 天参考）→ `insufficient_evidence`；不写预留。 |
| **G03-V04** | 赛前/比赛周/past（C04）→ `blocked` + `pre_race_extension_blocked`；与 G01 保护叠加时仍阻断。 |
| **G03-V05** | 单次突增（C06）→ `blocked` + `recent_single_run_spike`；缺参考 → `insufficient_evidence`（两者不可混同）。 |
| **G03-V06** | 恢复受限/9 个阻断旗标（C07）→ `blocked` + `recovery_restriction`，旗标列表进入 params。 |
| **G03-V07** | 剂量不是恰好 1800 秒（C08）→ `blocked` + `minimum_session_not_feasible`；时长未知也不得当成可行。 |
| **G03-V08** | 无 HRV/睡眠但无不利信号（C09）→ 不产生 `recovery_restriction`（恢复"没有证据"≠"低信号"）。 |
| **G03-V09** | 若采用 B：未请求时不产生 extension；同一请求 `operationId`/幂等键重放不重复写预留/回执。 |
| **G03-V10** | 若采用 C：所有输入都返回策略暂停原因，且不改变既有周计划、不写预留、不 bump 计划版本。 |

**测试落点（已落地）**：`apps/api/test/training-plan-policy-adoption.test.ts`（G03 标准案例与常量冻结）
与 `apps/api/test/coach-loop-runtime.test.ts`（AC0-13 等追加发布/回执/幂等）、
`apps/api/test/coach-loop-runtime-safety.test.ts`；
当前仍没有针对 `assessExtensionEligibility` 的独立纯函数测试，后续补测应逐条钉住上表。

### 3.6 G03 采纳后代码不得做

- 不改 `MAXIMUM_EXTENSIONS_IN_ROLLING_7_DAYS`、1.2 单次比值、7/56 天窗口或 1800 秒门槛；
- 不把"没有恢复监测数据"当成"恢复良好"或"恢复不佳"；
- 不在赛前保护、质量课、长课路径上开追加；
- 不新增第二个追加写入口/第二个发布路径；请求（若采用 B）也必须走同一运行时的原子发布。

---

## 4. 签字栏

规则所有者按门槛逐项签字；每项须写明冻结的是“案例编号 + 常量 + policy version”，
不是笼统的“同意方向”。下表已于 **2026-10-20** 签字。

| 门槛 | 规则所有者（姓名/角色） | 决策（批准/修改/拒绝） | 冻结内容（案例 + 常量/版本） | 日期 | 对应实现 PR |
|---|---|---|---|---|---|
| G01 赛前剂量 | 仓库所有者（会话直接指令；角色：产品/规则所有者） | **批准 P-G01-B（赛前短激活课类别）** | 标准案例 G01-C1…C7（新增边界案例：最后 72 小时只休息、赛前第 4–14 天、每日最多 1 堂、仅 easy/recovery、时长 600–900 秒、距离 ≤ `taperDayCeiling`、不改变 1800 秒对常规课的定义）；新增 policy version `rai-pre-race-activation-v1`；不改 `taperDayCeiling` 公式 | 2026-10-20 | 已实现（`pre-race-activation.ts`，接线于 `weekly-plan-service`） |
| G02 无历史重启 | 仓库所有者（会话直接指令；角色：产品/规则所有者） | **批准 P-G02-C（旧历史衰减重启）** | 标准案例 G02-C1…C7；衰减系数 **0.5**（28 天前稳定 4 周均值 × 0.5）、封顶 **0.7×旧均值**、需**连续 4 个自然周有观测或完成轻松课**才逐级释放、始终受 30% ramp / 阶段量带 / 绝对上限约束；`rai-capacity-restart-v2`（`CAPACITY_RESTART_POLICY_VERSION`）；旧历史使用以 `reasonCodes` 记录（`legacy_history_restart`/衰减系数/未释放原因） | 2026-10-20 | PR2/PR3（已实现，`capacity-restart-v2.test.ts`） |
| G03 受控追加 | 仓库所有者（会话直接指令；角色：产品/规则所有者） | **批准 P-G03-A（现行自动 + 证据门控，规则常量冻结）** | 标准案例 G03-C1…C10；9 个阻断 flag、滚动 7 日最多 2 次、1.2× 单次暴露/56 日参考/1800 秒精确剂量、冷启动不算追加证据 | 2026-10-20 | PR2（剂量）/现有教练闭环 |

> **批准边界（必须一起读）**：以上签字是**产品/规则所有者对工程默认值/候选的方向性批准**，
> 不是独立的临床/教练领域复核，也不证明任何训练收益或风险下降。独立领域复核如仍需，按第 5 节的
> 退出条件另立记录；在它之前，实现必须保持本表冻结的常量与失败关闭语义，不得自行放宽。
> **行为变化边界**：G02-C 与 G03-A 是对现行默认值的冻结（零行为变化）；
> **G01-B 是行为变化**——新增赛前短激活课类别（最后 72 小时只休息），
> 因此本次采纳后已发布计划可能被协调器重排（`SESSION_DOSE_POLICY_VERSION` v1→v2 也改变 policy hash）。

### 4.1 实现锚点（2026-10-20）

| 门槛 | 实现 | policy version | 测试 |
|---|---|---|---|
| G01-B | `apps/api/src/pre-race-activation.ts`（窗口/结构/策略例外），接线于 `apps/api/src/weekly-plan-service.ts` | `rai-pre-race-activation-v1` | `apps/api/test/pre-race-activation.test.ts`、`training-plan-policy-adoption.test.ts` |
| G02-C | `apps/api/src/weekly-capacity.ts` 的 `legacy_history` 源 | `rai-capacity-restart-v2` | `apps/api/test/capacity-restart-v2.test.ts`、`training-plan-policy-adoption.test.ts` |
| G03-A | `apps/api/src/coach-extension-eligibility.ts` + `coach-loop-runtime.ts` 的预留/授权入口 | `rai-coach-extension-eligibility-candidate-v1` | `training-plan-policy-adoption.test.ts`、`coach-loop-runtime*.test.ts` |

三项测试在 2026-10-20 文档收敛时实跑：**10 tests / 10 pass / 0 fail**。

签字后落地顺序（本次实际执行顺序，记录用）：

1. 先改 policy 常量/纯函数并补纯函数测试（上表向量），接线到自动路径；
2. 再更新 `docs/ALGORITHM.md` 与验收矩阵（剂量政策 v2 已写入现行合同描述）；
3. 通过统一发布入口激活，旧计划转为“待刷新”由协调器重排；真实用户迁移与部署按发布记录单独执行。

---

## 5. 明确不做 / 未决事项

- 本文 §4 已记录 2026-10-20 的采纳；§5 只列仍未做/未决事项，不改变 §4 冻结的常量与语义。
- 本文不提出新的临床假设，不引用外部研究，不声称任何剂量能降低受伤风险或提升成绩。
- G01 的**替代候选**（A/C）、G03 的请求式追加（B）与暂停（C）未被采纳，不应进入实现；
  已采纳的 G01-B/G02-C/G03-A 必须各自保持 policy version 与回执/审计语义。
- 三项门槛之间的相互影响（例如"无历史 + 赛前"、"无历史 + 追加"）必须在签字时一起看：
  现行实现会同时失败关闭（更保守），任何候选政策都不能只改一侧。
- 本文件由 `npm run check:docs` 做链接/可达性检查；它不参与运行时逻辑，也不被
  `check-training-plan-single-writer` 读取（后者只守源码形状）。
