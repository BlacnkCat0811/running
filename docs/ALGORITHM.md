# 算法合同与验收

维护日期：2026-10-11。本文是现行工程合同，取代已过期的 V1 PRD、分阶段 V2 方案和各批次状态报告。
代码已实现、候选政策、数据实证与实际激活必须分开表达。当前核验结果见 [项目审查](PROJECT_REVIEW.md)；运行操作见 [运维](OPERATIONS.md)。

## 0. 范围与证据边界

支持 5K、10K、半马，不新增全马/Watch 产品。TypeScript 领域代码由 API 执行，不在 iOS 重写。
无真实标签时精度指标为 null / not_evaluable，不能将规则通过、合成用例或有分数输出称为准确率达标。
不因缺天气/标签阻塞恢复隔离、版本安全和数据质量修复；也不因此降低 ML/经验区间发布门槛。

## 1. 版本源

- canonical、feature schema、残差 schema、Readiness、Load/Zone 常量：[contracts](../packages/contracts/src/index.ts)。
- feature config：[features](../packages/features/src/index.ts)；scoring engine：[scoring](../packages/scoring/src/index.ts)；scoring config：[model](../packages/scoring/src/model.ts)。
- physiology：[physiology](../packages/physiology/src/index.ts)；Coach：[api-contracts](../packages/api-contracts/src/index.ts)。
- schema / 冻结 migration checksum：[database](../packages/storage-sqlite/src/database.ts)。

本轮代码为 feature v4/config v11、scoring v2.0.0/config v12、physiology v1.8.0、residual/CatBoost family v5、load config v5、zone config v4、SQLite migrations 1–32。
这是源码版本，不证明任何本地/线上数据库已迁移或模型已激活。

## 2. 职责与不变量

| 输出 | 含义 | 不允许替代的东西 |
|---|---|---|
| CA | 本次可比训练的表现估计 | 当天恢复、跨人绝对能力 |
| TA | 合格表现证据累积的长期个人能力指数 | VO₂max、生理真值 |
| Adaptive anomaly | 相对近期同类训练的偏差 | 新的长期能力标尺 |
| Readiness | 当天可得恢复证据对安排的支持 | 医疗诊断、缺监测等于恢复良好 |
| Preparation | 目标距离的训练暴露 | 当天恢复、精确耐久能力 |
| Durability | 持续运动后保持表现的证据 | 用周跑量伪造的数值罚分 |
| Load | 已发生训练的内部/外部负荷和变化 | 伤病概率 |
| Prediction | 明确情景、距离及不确定性的成绩估计 | 保证成绩 |
| Coach | 依据已有快照、计划和约束选择动作 | 再计算一套恢复/跑力 |

固定训练、长期参考和配置，仅改变睡眠/HRV/当天 RHR，CA、TA 与更新决定必须不变。
事实发生时间与系统可得时间都受 as-of 限制；缺失是 null/unknown，不是 0。
训练先评分后进入基线；TA/CA 必须处在同一 epoch；候选失败不得半发布。
不在导入中恢复常驻 V1/V2 完整双跑。离线对照必须使用明确固定的事实/配置/时点。

## 3. 谱系与兼容

谱系包含 sourceRunId、datasetVersion、facts/override snapshot hashes、engine/config/schema、baseline epoch、normalization version/hash、时区、asOf、dataThroughAt 与可空 calibration cohort hash。
规范化配置正文与 hash 一起保留；JSON key order、非有限数和 null 的语义由 [semantic-json](../packages/contracts/src/semantic-json.ts) 统一。
任务 ID、运维耗时不参与算法语义 hash；数值误差不得被排除。
历史 V3 只读 decoder 保留，不能把旧 JSON 改 schemaVersion 冒充 V4；缺原始事实的新增特征为 null，不作为完整 V4 学习证据。
跨版本曲线要说明模型切换/重校准，不能把标尺跳变解释成体能突变。

## 4. 特征、缺失与可得性

[特征提取](../packages/features/src/v4.ts) 使用速度/心率共同时间覆盖和现有暂停、去重规则；普通训练不是比赛标签。
当天恢复 RHR 与课型推断的长期 RHR 参考隔离。纯入口使用显式 computedAt。
同样的信号缺失不能被 quality/coverage/comparability 多次惩罚。
解耦需要合格稳态、有效时长和前后半程共同覆盖；保留负值、片段/覆盖与排除原因，不凭全程平均值猜后段能力。
删除/tombstone/override 变更应触发必要重放，不能复活已删除事实。

## 5. 环境归一化

[normalization](../packages/normalization/src/index.ts) 区分 applied / not_needed / unavailable / out_of_domain；raw 始终保留。
已有生理条件修正与 identity adapter 不是“经过标签拟合的天气模型”。
历史表现去偏差和未来比赛情景补偿属于不同对象；同一对象/输入的同一责任只能应用一次。
无天气不能伪造 15°C/50% 实测值，也不能强制 environmentAdjusted=true 才允许负向学习。
引入新天气服务、拟合 N2/N3 或将新 comparability 硬接 TA 前，必须盘点覆盖、版本化并独立回放。

### 5.1 环境只读视图（2026-10-02）

修正本身早已存在且有唯一所有者：[performanceConditionPenaltyFraction](../packages/physiology/src/index.ts) 经 `createPhysiologyNormalizationAdapter` 作用于历史成绩证据与未来比赛情景（见[条件账本](../packages/normalization/src/index.ts)的两个 site）。缺的只是**读不出来**：30 °C/80% 的一次跑与 15 °C 的一次跑在界面上完全相同。

`WorkoutEnvironmentView`（[合同](../packages/contracts/src/index.ts)）是这次读出的形状，由 [buildWorkoutEnvironmentView](../packages/physiology/src/index.ts) 构造：

- 它调用**同一个** adapter，读者看到的修正量与证据实际使用的修正量不会分叉；
- `unavailable` 时 `correction` 与 `adjusted` 都是 `null` 并列出缺失字段；**部分已知不得当作完整修正**；
- `not_needed` 表示三项齐全且修正为零（显式 0，而不是 `null`）；
- 原始温度/湿度/爬升始终返回；来源仅限手表训练自带的元数据（HealthKit workout metadata），**不引入外部天气服务、不做历史回填**。

可得率是这条链的前提，所以它必须可被计数：[数据审计](../apps/api/src/data.ts) 用生产解析器统计三个字段的可得条数与“三项齐全”条数（键存在但读不出数值不算可得）。CLI 版本是 [normalization-coverage](../scripts/normalization-coverage.mts)（`npm run data:env-coverage`），报告与页面读同一个解析器。

### 5.2 等强配速（坡度归一化，2026-10-02）

[gradeAdjustedPace](../packages/physiology/src/index.ts) 用 Minetti(2002) 能耗多项式把测得配速折算为平地等效值，政策版本是 `GRADE_ADJUSTMENT_POLICY_VERSION`。它与 §5.5 的两个账本 site **是不同对象**：不改历史证据、不改未来情景；因此**不得**接进 `performanceVdotEvidence` / `predictRaceTimes` —— 那会变成同一字段被修正两次，正是 `validateConditionLedger` 拒绝的情形。

分段级证据来自同一次跑的路线点海拔（`route_points.elevation_meters`）：窗口内少于 2 个采样、分段短于 50 m、或 |坡度| 超过 60% 时，`gradePercent` 与等强配速都是 `null` 并给出理由码；**未知不是平坦**。汇总值是已覆盖分段的距离加权平均，并显式报告覆盖段数。

## 6. Fitness 与基线

[评分实现](../packages/scoring/src/model.ts) 保留 Median/MAD、初始至少 6 次有效训练/跨度 14 日、V2-A 控制组与最低覆盖保护；Recovery/Cardio 不作为 V4 有效权重。
展示 coverage 收缩与 learningObservation 分离；缺维度不能被学成退步。
规则 evidenceReliability 与 modelConfidence 分开：modelConfidence 未校准时 overall=null，不默认填 1，也不让有效规则证据全部冻结。
学习率连续；正负方向都要质量/可比性审计，连续负向证据按政策确认。
分桶上限、最少独立 session/跨度、不跨稀疏桶混合均是显式政策；bounded history、权重 B 和阈值变更是候选，不因“更复杂”自动启用。
双基线先评分后更新。Anchor rebase 不等于滚动抹平进步；新 epoch 完整重放并保留旧曲线解释。

### 6.4 Rebase 运维合同

[检查/记录](../packages/application/src/baseline-rebase-review.ts) 使用独立 session、有效维度饱和率、epoch 生效时间和已持久化检查历史。
默认 28 日检查、90 日 epoch 冷却、至少 12 次独立训练、20% 饱和、连续 2 次检查均为启发式政策，不是医学常量。
migration 25 保存 prospective review history；首次显式记录从现在开始观察，不伪造过去的连续检查。
not_due 不后移检查时间；重复同证据/截止时间应幂等；不同 epoch/政策/窗口隔离。
仅产生 candidate_requested，不自动发布；effectiveAt/rebaseReason 必须可追溯，回放训练日期不能冒充重建生效时间。
当前和保留rollback run依赖的epoch起始release必须作为清理依赖保留；仅在最后依赖退役后才能清理。不能因普通历史保留窗口删除当前epoch生效依据。

## 7. Readiness

唯一规则源：[readiness](../packages/readiness/src/index.ts)。兼容阈值：sleep ratio 0.75、HRV ratio 0.85、RHR ratio 1.03、连续差睡眠 3 夜。
coverage 与 assessment 分开；读数存在但 baseline 缺失不增加可比较覆盖；旧夜不能填充今天的恢复完整度。
Readiness state 带 heuristic_rules / not_empirically_validated；no_low_signal 不等于已证实健康。
一天多个窗口、跨午夜、午睡、迟到、更正和缺失必须保留各自来源与可得性。
旧记录级入库时间不可考时保持 unknown/保守上界，不能用 Apple creationDate 或当前墙钟反填历史真值。

## 8. Preparation / Durability

[durability](../packages/durability/src/index.ts) 迁移既有距离准备度，不重复追加同来源罚分。
缺历史完整性不等于低跑量；只有短距离证据不能精确诊断半马耐久。
未经独立标签校准，Durability 只输出证据/不足原因，不启用新的数值 penalty。

## 9. Training Load

[training-load](../packages/training-load/src/index.ts) 保留 composite 主线与 TRIMP fallback、7/28 日 EWMA 半衰期、ramp/monotony/strain。
Load Vector 是扩展，不重写 composite；未标定 mechanical 为 null。ACWR 单独升高不能自动覆盖恢复、计划和强度分布。
unknown prehistory/未同步日不能直接当作已观察到的休息日。Load 状态消费同源 Readiness。

### 9.6 状态曲线与恢复时间（2026-10-02）

[form.ts](../packages/training-load/src/form.ts) 增加两个**读时**派生量，都不写回 `daily_training_metrics`，因此没有模型尺度变化、迁移门禁看到的数字与之前完全一致：

- **状态** `form = chronicEwma − acuteEwma`（单位是日 EWMA 负荷），同时给 `formRatio` —— 绝对负荷单位不跨人可比。分档（±10% / ±25% / ±30%）是负荷管理的常规区间，写成具名常量，**没有**做过结果验证。
- **恢复时间** 以最近一次**已结束**训练为锚，按 `RECOVERY_BASE_HOURS[sessionType] × clamp(该次负荷 / 个人 chronic, 0.5, 3)` 外推，上限 96 小时；`isLoadProxy: true` 随响应一起走。

两者的边界都是硬的：

- 没有已结束训练、或没有 chronic 背景 ⇒ `insufficient_data` 且 `remainingHours = null`；**"不知道"不等于"已恢复"**，不能渲染成 0 小时；
- 它是 **负荷代理**，不是睡眠债、不是生理恢复债；UI 文案固定写"按负荷推算，非实测恢复状态"；
- 状态是**独立类型** `TrainingFormStatus`，不并入 §9.5 的 `TrainingStatusCode`（后者的阈值与验收测试有自己的含义，塞进第二套刻度会让那些测试静默换义）；
- 两者都**不覆盖** Readiness、计划或训练状态（对齐 L03）。`estimateRecoveryTime` 接受 `physState` 并在 strained 时放大，但**当前没有调用方传入**：physState 目前只有一个生产者（移动端 today 路径），在桌面上另算一份会让同一个早晨在两个界面上给出不同答案。接线的位置在那里，不在读侧。

界面上两者同处一块面板（"状态与恢复"）而不是两张卡：它们来自同一条负荷曲线，分开摆会诱导把恢复时间读成第四个测量值。

### 9.7 跑姿动态读侧（2026-10-02）

[dynamics](../packages/dynamics/src/index.ts) 是新的纯逻辑包，只依赖 contracts：手表上报的步频/步幅/垂直振幅/触地时间**已经进库、也已经在图上画出来**，但 `packages/features` 与 `packages/scoring` 对它们的引用数是 **0**。这条读侧把"存了但没分析"补上，边界是硬的：

- `evidenceStatus = device_estimated_not_lab_validated` 随每次响应走；**读数不得进入 CA/TA**（没有实验室校验，也没有标签）。
- 覆盖率按 **30 秒时间桶的占用时长 / 全程时长** 算，不按首尾跨度或样本数：采样密集但只覆盖两分钟、全程只有首尾两点都不能报高覆盖；非有限、越界偏移与同一时刻的重复点不扩大覆盖，末桶按实际时长计。低于 `MINIMUM_METRIC_COVERAGE` 报 `insufficient_coverage`，**均值与漂移都为 null**。
- 前后半程只在**配速可比**的窗口内比较（`COMPARABLE_SPEED_TOLERANCE_MPS`）：否则一次正分段会被渲染成"步频崩了"，而那是关于配速的结论穿上了跑姿的外衣。配对样本不足时报 `no_speed_matched_pairs` 且 `driftFraction = null`。
- 未知不是 0：没有样本 ⇒ `unavailable` + `no_samples`，均值/漂移都是 `null`。
- 配对发生在 [workout-dynamics.ts](../apps/api/src/workout-dynamics.ts)（存储格式的知识在 API 层），分析本身在纯包内。

## 20. 赛事倒推的周期骨架与依从性（2026-10-02）

[plan-periodization](../apps/api/src/plan-periodization.ts) 把教练从"只看一周"扩到"看得到比赛"：按目标赛事日期产出 base/build/peak/taper/race_week 的周序列，每周带量带、长距离上限与质量课剂量。

`rai-periodization-v2` 保留 5K 的 1 周、10K/半马的 2 周减量期，以及 2/3/4 周专项期；`peak` 为减量期之前的 1 周，不挤占减量或专项窗口。

三条硬边界：

- **读时且确定**：不调 LLM、不落库。改比赛日期立刻换骨架，没有过期窗口要清理；骨架也**不是**计划本身，它是周生成与校验要被约束在其中的信封。
- **状态有上限**：≤24 周；超过就给 `race_beyond_maximum_horizon`，比赛已过给 `race_in_the_past` 且不产出任何周；没有目标赛事就明说 `no_race_target`，不编一个阶段出来。
- **只对 5K/10K/半马**（与预测链一致）；量带是政策常量，**没有**做结果拟合，因此它只声明"这是教练想给的量"，不声明最优。

阶段边界的**唯一归属**是本节的 `PHASE_BOUNDARIES`（2026-10-07 收敛）。教练页通过 [run-coach-policy](../apps/api/src/run-coach-policy.ts) 的 `runCoachPhase` 适配器读它：骨架窗口内直接取今天页那一行（`current.phase`），窗口外（比赛已过、或超过 24 周）用同一张表和同一个周对齐（`periodizationWeeksToRace`）直接回答，`past` 因此仍然可达。此前教练侧另有一套按天推算的实现（`floor(days/7)` 配固定 `taper+5` 的 build 窗口），会给 5K 5 周、半马 4 周专项期（方向相反），让同一自然周内阶段跳变，并对自定义距离返回一个并不存在的阶段——三条都由 [run-coach-phase.test.ts](../apps/api/test/run-coach-phase.test.ts) 锁住。

近期周跑量使用当前周之前的四个完整自然周（周一到周日），按窗口内已观测总里程除以四；空周不缩短分母，窗口外的陈旧记录、当前周和未来记录不参与。这个量是已记录跑量，不把缺失日期认定为已观测休息；窗口内没有跑量时保留 `no_recent_weekly_volume`。

**周容量是推导值，不是用户设置**（[weekly-capacity](../apps/api/src/weekly-capacity.ts)，2026-10-06 起）。用户手工设定的"周跑量目标"已退役：它一度同时充当展示口径与排课容量，而这两者本来就该同源。现在的基线三档：

| 场景 | 基线 |
| --- | --- |
| 有比赛目标 | `RACE_WEEKLY_BASELINE_KM[距离]`（5K 15 / 10K 25 / 半马 35）× 当前阶段系数，再被 `max(5, 近期实测量 ×1.3)` 封顶 |
| 无比赛目标 | `max(5, 近期实测周跑量)` |
| 无任何训练数据 | 5 km 重启基线（复用周期化的 `MINIMUM_BAND_KM`） |

基线交给 `weeklyPlanVolumeCeiling` 再被"上周量 + 30%"收敛一次，得到真正约束排课的上限。**两个角色必须分开传**：教练消费的是**已收敛的上限**，而 `constrainUpcomingPlan` / `assembleMobileWorkoutPlan` 消费的是**基线** —— 把已收敛的数再喂给"自己会收敛"的函数会复合收紧，因为 `weeklyPlanVolumeCeiling` 对输入**不幂等**。

5 km 底托适用于无数据和近期记录量很小的重启期，不改写四周实测均值。否则首周完成 5 km 后，四周均值只有约 1.3 km，次周预算不足以容纳最小处方，就会连续休息到数据滚出窗口、重新冷启动。底托消除这一循环，但仍受上周斜坡、已完成量、恢复与强度闸门约束；缺失训练记录不能成为补课加量的依据。

有比赛时 `max(5, 近期量 ×1.3)` 这一层在 `weeklyCapacity` 里**显式写出**，没有委派给 `weeklyPlanVolumeCeiling`：后者把自己的斜坡底托在"目标的一半"，对一个 38.5 km 的比赛基线会放行 25 km，而 8 km 的一周只挣得 10.4 km。

**佳明教练参考边界**：原生入口现对齐新版 Garmin Run Coach 的日常自适应流程，独立手动课表继续使用预览确认。5 km、30% 和阶段剂量均为本项目政策，不声称复刻佳明内部算法；成绩预测仍仅覆盖 5K/10K/半马。新增自定义赛事设置不等于已扩展预测或验证超长距离训练能力，见 [RUN_COACH](RUN_COACH.md)。

[plan-adherence](../apps/api/src/plan-adherence.ts) 把"计划 vs 实际"变成可读的周依从性，并把**没有观测**与**没练**分开：

- 计划要求训练、当天没有任何观测 ⇒ `unknownDays`，状态 `unknown`；导入延迟与没戴表在系统里长得一样，而只有一个是对训练的事实陈述。
- `rai-plan-adherence-v3` 按**每日本地午夜**冻结该日义务；午夜没有该日处方时，采用当日首次创建的处方，后续编辑不能改写它。未来日期使用当前最新版本，因此周一或周中生成的计划也会计入，改本周计划不会改写上周。完成率、观测天数和观测跑量仅统计非休息处方所在日期，包含当天已导入的训练；计划创建前或休息日的训练不抵扣这些义务，休息日无记录也不计入未知天数。
- 没要求任何训练的一周不会被判成"达标"（`plannedDistanceKm = null`）。
- `rai-replan-v2`重排建议（连续两周有观测且低于计划量60%、当前周计划超出所处阶段的量带上限）**只产出理由**：独立手动课表走preview/confirm；启用新版跑步教练后，由用户授权的自适应命令改写未来窗口。2026-10-10移除仅因质量课日期未观测就建议重排的分支；`qualityObserved`仍是该日期有记录的兼容计数，不是质量完成。三层执行评价尚未接入，未知不推导漏练或补课。

**阶段已经接进生成与校验**（2026-10-02 第二轮）：

- `currentPeriodizationWeek` 给出"本周属于哪个阶段"，规则排课和读取使用同一阶段骨架；没有目标赛事时不附加阶段约束。
- 周课表仅由规则教练生成（2026-10-06），不调用大模型、不构建提示词；审计来源为 `heuristic`，模型与提示词版本均为 `null`。
- `weeklyPlanVolumeCeiling(weeklyKm, previousWeekKm, phaseCapFraction?)` 新增**可选**第三参：既有调用方的上限一字不变，且阶段只能**降低**上限、永不抬高。
- `constrainUpcomingPlan` 是成品周的**唯一**约束入口：规则教练和比赛策略都经过它，再由 `validateWeeklyPlan` / `fitWeekToCeiling` 对可执行课表结构收敛；已完成量、锁定处方及滚动窗口外保留处方的可执行里程和质量课先扣出自然周预算，最小训练也超预算时转为休息。旧模型课表迁移以服务端 `weekPlanPreservedDate` 保留迁移当日处方，确认后及重启仍不替换今日；按上海本地日期跨日失效。今日建议与 WorkoutKit 仅豁免迁移导致的容量缩量，恢复、负荷、校准和赛前减量闸门仍可降低处方；未来排课继续使用正常推导容量，先预留今日预算，不因保留旧课表抬高未来容量。
- `longRunCapKm` 同时约束长距离的存储里程和可执行结构，不以周总量合格替代单堂上限；无法缩到上限内的最小处方转为休息。手工编辑使用同一校验，超限拒绝保存；已完成或锁定日期不被改写。
- **这一轮抓到一个真 bug**：阶段此前按循环**偏移量**赋值而不是按"距比赛周数"，于是比赛周被标成 `base`、最远的一周被标成 `race_week`；因为阶段**数量**仍然正确，只断言数量的测试完全看不出来（现已补上对赋值本身的断言：最后一周必须是 `race_week`、`weeksToRace` 必须递减到 0）。

**2026-10-10教练闭环基础实现，非整个优化方案验收：**

- [剂量校验](../apps/api/src/coach-session-dose.ts)`rai-coach-session-dose-v1`以最终结构而非显示分钟判断1800秒下限。距离步骤按允许配速快/慢端取得时长范围，时间步骤按快端估计保守km成本；开放目标不可评估。未知分区的普通低强度课可用明确的360秒/km冷启动估量，不生成虚假配速目标，不用于追加资格。
- [完整课分配](../apps/api/src/coach-complete-plan.ts)用于新周生成和教练周生成：基础轻松结构为5分钟热身、20分钟工作、5分钟整理；沿用已有节奏3×8分钟与间歇4×800m构建器和既有强度规则。先减少整课再经过唯一周校验器，最终删除不满足完整剂量的课后重新检查低强度占比；不凭显示30分钟放行，不把剩余km均分给剩余日。
- 今日无计划/自动建议使用同一剂量出口；今日已有跑步或programme暂停/结束/到期不新增自动课。人工/锁定历史保留兼容口径，不把它们称为新自动保证；旧来源不明处方未静默迁移。完整剂量不能绕过恢复、14天保护、现行容量或工作量限制。
- [赛前策略](../apps/api/src/race-plan-policy.ts)的14天保护与骨架阶段分离；`executionPolicy`是解释元数据，实际限制仍在服务端。固定5K例`2026-10-18 → 2026-11-01`返回phase=peak及14天保护，而非第二个taper阶段。
- S/H纯函数仍可单独离线评价；[新合同运行服务](../apps/api/src/coach-loop-runtime.ts)已经把它接入显式接受policy hash后的发布：S20、实际20、H26且门控通过时，完整30分钟课可以在真实控制库事务中获准。训练前56日单次参考、最近7日异常与追加次数均参与判断，不改旧`weeklyCapacityKm`含义。原数据集未启用，新政策不是已验证医学安全线；具体证据及剩余验收见[实施状态](COACH_LOOP_IMPLEMENTATION_STATUS.md)。
- `npm run data:coach-replay -- --output /tmp/rai-coach-replay.json`复用`replayModelPair`的冻结输入、显式时钟与双次确定性检查；基础轮4个子场景，继续实施后扩为13个局部子场景，仍不是22类场景全验收。`npm run test:coach:mutation`在隔离源码副本先编译语义突变，再要求行为断言失败；编译失败不计成功拦截。产物明确实际发布、整体最小修补oracle、长期效果为`not_evaluable`，小窗口oracle另有独立测试。

**同日继续实施的增量：**

- 人工`PUT /v1/mobile/goals`保存课表使用`manual`审计，不继承旧`heuristic`来源；明确20分钟人工课可按既有约束保留，不被误称为自动30分钟保证。设置更新而不改课表不更换来源。
- 无骨架赛事使用原两天“禁止质量/长课”的兼容保护，生成与有效读取共享该规则；不伪造14天公里上限或比赛阶段。支持距离仍是14天；所有存储/历史文本保持。
- 既有`run-coach refresh`增加保守语义相等出口：事实/解释变动但执行内容及配置相同时不写goals/history，显式operationId沿用发布事务幂等，不仅为了`adaptationKey/adaptedAt`增修订；窗口外课表保留并参与预算。这尚不是新授权或最小搜索的完整发布合同。
- [执行评价](../apps/api/src/coach-execution-assessment.ts)、[最小修补](../apps/api/src/coach-plan-repair.ts)、[主观反馈](../apps/api/src/coach-subjective-feedback.ts)、[差距装配](../apps/api/src/coach-goal-gap.ts)保留可独立回放的纯函数，新合同消费其结果：真实步骤/信号适配、确认与未知统计、已知不满足限制、今日反馈与目标差距分别装配。原始信号首次可得时间缺失时仅认证本次评价，不能冒充历史as-known-then。
- v32仅追加主库反馈修订、命令幂等和预测伴随摘要表；不修改旧迁移checksum或封存bundle。反馈保存/撤回不重算Fitness，不复制RPE；预测通过显式异步命令调用一次既有构建器，提取摘要后事务复核身份。GET只查兼容摘要，不构建预测，不自动排队。
- 回放包含原13个纯模块子场景及12个真实SQLite发布子场景；另有HTTP、失败回滚、100次只读GET、模板与主库事实回归。它们覆盖各场景的选定断言，不等同于整份78条验收已经完成，也不证明个体训练收益。完整结果、跳过项和剩余人工审阅见[实施状态](COACH_LOOP_IMPLEMENTATION_STATUS.md)。

## 10. 分区

[training-zones](../packages/training-zones/src/index.ts) 保留手工设置有效期、threshold/maxHR 来源、平滑与课型刺激。
分区证据必须在训练前可得；强测试在 prior 缺失时独立估计或明确拒绝。
HR/Pace coherence 解释间歇心率滞后，不按稳态规则硬判全部间歇冲突。

## 11. Prediction policy

[编排](../packages/application/src/prediction-report.ts) 区分 neutral_potential / current_prepared / race_day_scenario。
Baseline → Preparation → target environment/fatigue → 一个 point residual policy → interval；不堆叠 bias/Ridge/CatBoost。
Fitness 不能未经校准线性换算 VDOT。直接 VO₂max 与同场 race/test VDOT 不重复进入 ensemble。
未来比赛不能永久继承今天的低恢复罚分；原有情景/ledger 必须可解释。

## 12. ML 与区间

[模型服务](../packages/application/src/prediction-model-service.ts)、[ONNX 推理](../packages/prediction-inference/src/index.ts) 和 [Python](../research/README.md) 共用版本/顺序/hash 合同。
只用已确认且合格的 5K/10K/半马比赛或标准测试；普通训练、CA/TA 不是标签。
严格事件/时间切分、embargo、train/calibration/independent holdout 分离；评估后不得用 holdout 重训后仍冒用旧 SHA。
CatBoost 与公式基线、Ridge 使用同样本发布比较；误差、安全上限、分距离退化、ONNX parity 与独立区间 gate 都必须满足。
保留 residual-only、±12% cap 和原严格门槛，不靠修改常量降低标准。

### 12.9 区间展示合同

规则区间为 heuristicRange.kind=heuristic_not_calibrated，不允许挂 nominal/empirical coverage。
P80/P90 只有独立 calibration artifact、独立 test cohort、适用域、样本数/coverage/width 都合格才可展示。
生产选择器执行 [展示闸门](../packages/model-eval/src/index.ts)，缺 cohort provenance 的旧 artifact 回退。
必须同时展示目标覆盖与实际覆盖，并声明 empirical_target_not_individual_guarantee；不把“目标80%”说成个人保证。

### 12.13 比赛候选检测（2026-10-02）

用户的决定是"手工录入历史成绩 **+ 一键确认已有训练**"。前者是 §12.10，后者是这个模块：**应用提议，跑者确认**，候选本身永远不会变成标签（确认走与手工录入完全相同的写入路径）。

候选的四条判据，每条都有理由：

- **落在标准距离的容差内**（±3%）：标签合同只接受 5K/10K/半马，所以一次漂亮的 8.3 km 无论多拼都不可能成为标签 —— 提议它就是提议一条 API 会拒绝的录入。
- **配速在写入路径的同一组边界内**：`rai-race-candidate-v2` 与写入路径共享成绩校验；GPS 实际距离和拟确认的标准距离都要满足配速 150–900 秒/km、用时 12 分钟–4 小时（含边界），避免距离偏差导致候选可见但确认被拒。
- **比跑者自己在该距离的中位配速更快**："看起来像比赛"是关于**这个人**的判断，不是人群判断：6:00/km 的半马对一个人是比赛，对另一个人是轻松长跑。
- **尚未被标注**：已确认的不是候选。确认写的是**手工成绩条目**而不是训练记录上的标记，所以"已标注"不能只看训练表 —— 去重键是 `日期|距离`（同一天早上的 5K 热身跑仍然会被提议）。

理由随候选一起返回：确认界面要能显示**为什么**提议它。跑者无法核对的建议，是跑者无法信任的建议。

### 12.12 训练范围：人群 / 个人（2026-10-02）

人群门槛是 50 条标签、每个距离 8 条。单个跑者到不了，而**降门槛会让"人群模型"这句话变成假话**。因此新增的是**范围**，不是更低的同一条线：

| 范围 | 标签 | 每个距离 | 激活判据 |
|---|---|---|---|
| `population`（缺省） | 50 | 8 | 优于规则基线 ≥5%，walk-forward、bootstrap、分距离回退上限 |
| `personal` | **24** | **4** | **完全相同** |

- 个人范围的两个数字**就是 artifact 自己的门槛**（`MINIMUM_ARTIFACT_TRAINING_LABELS` / `_PER_DISTANCE`），刻意不新造常量：否则"多少才够"会有第二个地方各自漂移。
- **三个距离都要**：artifact 合同要求模型支持全部距离（校验阶段会拒绝子集），所以个人范围也用 `每个距离 ≥4`，而不是"任意两个距离"。早一点拒绝，好过晚一点。
- **激活判据一个字不放宽**：个人范围降低的是**需要多少数据**，不是**必须多好**。仅仅"拟合出来了"不等于"比规则更好"，而混淆这两者的代价由跑者承担。
- **拒绝时引用实际采用的门槛**：个人请求失败不会被告知"你需要人群的 50 条"。
- **scope 落库**：写在 `request_json`（无需迁移）；回读时没有该字段的旧行一律按 `population` 解释 —— 把历史重新标记成"个人模型"是伪造记录。
- **scope 随产物走**：Python manifest 必须写 `population` 或 `personal`；runner、完成/激活边界和 ONNX 加载/推理都与请求范围校验，缺失、非法或不匹配不能使用。
- 缺省仍是 `population`：老客户端不会因为这次升级就拿到更低的门槛。

**时序训练约束（2026-10-03 订正）**：所有标签都在自己的 `observedAt` 重建基线与特征，并排除自身标签；`labelAvailableAt` 只决定标签何时可进入训练分区。不得把个人自校准的"当前全部证据减去自己"搬进监督训练集，否则未来证据会泄漏到过去样本，事件切分与 embargo 无法补救。补录成绩若没有可用赛前证据，只保留为标签及个人校准候选，不进入时序训练集；有真实赛前证据时仍可进入。漏斗单列 `trainingSampleCount`、`trainingExcludedOutcomeCount`，分距离的 `trainingSamples` 与真实数据集对账。决策与代价见 [ADR-005](adr/ADR-005-temporal-training-labels.md)。

**v5 模型合同**：`race-residual-catboost-v5` 有意拒绝 v4 run/产物，特征 schema/hash 不变。`currentAbilityBaselineHash` 中的 `modelVersion` 来自能力模型的 `model_runs`，不是 CatBoost 版本；仅升级 CatBoost 不会改变该哈希。能力模型、公式基线或生理模型版本变化仍会使旧基线失配。

### 12.11 个人自校准层（2026-10-02）

人群门槛要 50 条标签、24/24 校准与留出。对单个跑者这不可达，而**正确结论不是把门槛降下来**：N=8 时人群声明本身就是假的。单个跑者能拥有的是**自校准**区间：[个人层策略](../packages/model-eval/src/index.ts) `PERSONAL_CALIBRATION_POLICY`（标签 ≥8、独立距离 ≥2、跨度 ≥120 天）与 `fitPersonalInterval`（留一法残差的分位区间）。

它是**另一个对象，而不是同一个对象的弱化版**：

- 禁止借用人群词汇：`nominalCoverage` / `coverageP80` / `coverageP90` 出现在个人区间上会被 `assertPersonalIntervalPresentation` 直接拒绝；
- 必须逐字带上 `personal_self_calibrated_not_population_guarantee`；
- 低于标签地板**不产生区间**（返回 null，而不是给一条很宽的带）；非有限残差不参与拟合，但该标签仍计入样本数；
- `evaluated`（实际留出的残差数）必须 ≥ `samples − 1`，否则报"不是留一法"。

人群门槛（50/24/M03）**一个字没动**：个人层是并存的第二条通道。

**留一法回放**（`buildPersonalCalibrationSamples`）：逐标签用**真实预测链**算一次"如果这条成绩不在证据里，规则会预测多少"—— `buildFormulaPredictionBase` 是报告本身调用的同一个函数，只是多带一个 `excludeLabelIds` 参数；不另写一套证据链，否则两套实现迟早会分歧。

语义要写清楚：**仅个人自校准**用 `asOf` 时刻的全部证据减去被评分的那一条，不是 T01 的 as-known-then 回放。它描述当前证据下规则对自己的偏差，只作用于此后的个人带，不能冒充历史泛化评估或监督训练特征。时序训练与历史评估都使用样本发生时的证据；任何标签都不参与自己的留一法残差。

证明这条减法真的发生：**只有一条标签时，可用残差是 0**（规则手里空无一物，给不出预测）—— 这条断言在 `personal-calibration-pass.test.ts` 里。算不出来的标签被丢弃而不是编一个点估计：编出来的残差会进到用户的带里。

**当前交付边界**：`GET /v1/label-funnel` 返回漏斗 + 个人层状态 + **拟合好的相对带**（`band`），成绩预测页在满足门槛时显示"自校准带 −0.8% ~ +3.4%（中心 +1.2%）"。**尚未**把这条带内联渲染到每个距离的情景预测旁边（需要在情景行里乘一次并显示），属于下一步；预测本身仍走规则链，个人带不参与也不改写任何预测值。

**距离池化**：带按 `实际/预测` 的**比值**在距离间池化，而不是按距离分别拟合。同一距离八场是比"八条标签"高得多的门槛，对单个跑者几乎不可达；比值才是能跨距离迁移的量（系统性慢 2% 的人在 10K 和半马都慢 2%）。带被要求包含跑者自己的中心（中位比值）而**不是** 1：规则系统性偏乐观的人，他的带合法地整体高于 1，假装不是反而藏掉了样本里最有用的信息。

### 12.10 手工成绩条目（2026-10-02）

标签此前只有一条来源：挂在**训练记录**上的比赛/测试确认。于是"成绩都在手表之前"的跑者标签数为 0 —— 这正是本项目审查记录的状态（"零有效比赛/测试标签"）。[手工成绩](../packages/storage-sqlite/src/performance-entry-repository.ts)（迁移 27）补上这扇门：日期、距离、成绩。

两条 as-of 规则是硬约束（T01/T03）：

- **按录入时刻起算**：`labelAvailableAt = recordedAt`。今天录入的 2023 年成绩不得出现在昨天做出的预测里；比赛日期本身也必须已经过去。
- **撤销是墓碑不是删除**：`revokedAt` 保留，撤销后从该时刻起不再计入；行还在，账才能对。

迁移 28 保留候选确认的 `trainingSessionId` 和服务端复制的真实起止时间。纯日期成绩的特征截止于当天本地午夜，不猜测中午开赛；同日录入时，录入时刻只作为结束上界。训练、个人留一校准按整个事件排除训练包络、阈值、准备度、训练负荷及比赛期间的健康观测，手工/训练记录的重复表示只计一个结果；混合来源按绝对开赛时刻排序，再按 `labelAvailableAt` 做回放可用性过滤。

撤销、更正、训练覆盖修订或已确认源记录失效，会在同一事务内推进 `prediction_label_state.revision` 并清除活跃残差模型指针。规则基线版本升为 `rai-formula-prediction-base-v5`，其哈希包含该版本：旧模型不能重新激活，旧校准区间不能用于新基线，但历史工件保留供审计。失效采用保守的全局策略；新增独立日期成绩不使已有模型失效，关联确认及覆盖修订会失效。迁移 29 将同一本地日期且同距离范围内可对应已有训练事件的普通手工录入也纳入失效，不要求显式提供 `trainingSessionId`；升级时推进标签版本并清除旧指针，需重训及重新发布校准后才恢复 ML 发布。既有迁移及校验和保持不变。

事件排除关系也遵守特征截止时刻 `asOf`：间接关联只能由当时已录入且尚未撤销的成绩扩展，未来补录或已生效撤销不能把同日独立训练连成一个事件。明确指定的留一目标仍保留自身事件身份，即使确认发生在赛后；基线和训练负荷上下文使用同一排除集合。公式基线 v5 通过版本哈希隔离此前逻辑的残差模型与校准区间，无需新增数据库迁移。

其它边界：距离只允许 5K/10K/半马（与预测链一致）；时长与**隐含配速**双向校验（API schema 与仓储同界，两边不许对"什么算成绩"有分歧）；手工条目的 ID 带 `performance_entry_` 前缀，漏斗里 `manualEntryCount` 单独计数，`byDistance` 也把它们算进去 —— 否则 `byDistance` 会与 `usableOutcomeCount` 对不上，而可对账正是 T03 对漏斗的唯一要求。

同一本地日期、同一距离只允许一条未撤销手工成绩；更正须先撤销旧条目，旧墓碑与历史可见性保留。合格标签数不等于训练样本数，缺少赛前基线的成绩不进入监督训练。

**已知限制**：手工成绩没有 GPS/心率佐证，是用户自己的陈述。它因此**只作标签与评估证据**：不生成轨迹、不生成能力评估，也不因录入而让 CA/TA 变化。

## 13. Coach 与接口

[Coach](../apps/api/src/mobile-coach.ts) 选择动作/强度/tone/reason codes，renderer 只改语言和呈现。
兼容 DTO 不允许重新推导恢复规则；旧客户端缺枚举/新字段时按协议兼容，不在 iOS 复制评分。

## 14. 发布、删除与回滚

[重算](../packages/application/src/services/recompute-pipeline.ts)、[transition gate](../packages/storage-sqlite/src/model-transition-gate.ts)、[release repository](../packages/storage-sqlite/src/model-release-repository.ts) 负责谱系、快照完整性和原子指针。
同标尺比较保留分布保护；跨标尺用明确不变量替代不适用的 recovery null 阈值，不填伪恢复值绕过。
已知 inactive 删除与无解释候选漏行应区分；候选不能继续含删除训练，校准证据被删时可重校准/回到不足状态。
not_evaluable 是正式状态，不能按“不是 failed”绕过激活。
回滚只到仍保留、数据 generation 兼容的完整 bundle；不承诺恢复任意已清理 run/历史二进制。
原始健康事实不随算法回滚被删改；checkpoint 只在精确兼容配置/版本下复用。
激活/回滚还须匹配当前有效override快照（V4 lineage hash、V3 metric config ID序列）；不匹配时拒绝并保留两个active指针，同事实回滚仍允许。
全部训练明确删除时，只有现场证明剩余来源及候选各派生训练块均为空，才能发布空bundle；缺证明的零匹配、未知scale、残留数据继续阻断。

## 15. 评估、标签与报告

标签入口、质检、availableAt、去重、修订/撤销和漏斗必须闭合；as_known_then 与 event_time_reconstruction 分开。
跨版本对照同 cohort/asOf；禁止把 V1 分数当真值。无标签仍能报覆盖/行为消融，但不能给精度排名。
报告包含代码/配置版本、库标识或 hash、cohort/漏斗、输入/输出语义 hash、复现命令、各 gate 三态、未评估原因。
新 Load 回放复用生产装配器，但属于已发布派生快照可得性比较，不认证原始记录级历史回放。
性能比较同机同数据同缓存状态、相同轮次并至少两轮，报告离散度/原始轮次，不拼接冷/热单次“提速”。

## 16. 验收矩阵

保留下表作为持续合同；标题引用齐全不等于行为全部覆盖，更不等于精度认证。
[检查器](../scripts/check-acceptance-matrix.mts) 只检查 ID 引用/显式缺口，实际证据以测试断言和本轮审查为准。

### 16.1 必需 Golden / Metamorphic Tests

| ID | 场景 | 必需断言 | 层 |
|---|---|---|---|
| F01 | 同一训练仅替换睡眠/HRV/当天 RHR | CA、TA、更新标记、基线输入不变 | 全链路 Fitness |
| F02 | 把 Readiness 由 no_low_signal 改 strained | Coach 可降阶，Fitness 不变 | 跨域 |
| F03 | 同一可用维度分数，降低 coverage | 展示值向 50 收缩，置信度不提高 | scoring |
| F04 | 删掉与其他维度相反的证据 | 不强加错误的“必向 50”断言；区间/置信度反映缺失 | scoring |
| F05 | TA=70、观测=70、coverage=.65 | 不因展示收缩到63而负更新 | scoring |
| F06 | N=10/11、30/31 | 连续 α，无分段政策跳变 | scoring |
| F07 | 正常平路环境 status=not_needed | 高质量负残差不被强制冻结 | scoring |
| F08 | 快速下坡/速度尖峰 | 不产生未经质量门控的正向 TA 跳升 | features/scoring |
| F09 | 同一天导入两次同一训练 | N、TA、负荷贡献不重复 | application |
| F10 | 持续真实高质量变差 | TA 可以下降，不成为只升不降 | scoring |
| B01 | 本次训练参与 adaptive window | 只进入未来窗口，不参与本次自评分 | baseline |
| B02 | epoch 切换 | 不混用旧 TA、新 CA，完整重放或明确重校准 | application |
| R01 | 全恢复证据缺失 | not_assessed、score=null，不自动 red | readiness/coach |
| R02 | 今天 HRV + 旧睡眠 | 单信号 freshness，旧睡眠不计今天完整覆盖 | readiness |
| R03 | 测量有值但 baseline 缺失 | 不计作可比较证据 | readiness |
| R04 | 三个不相邻坏夜 | 不自动成为连续三夜 | readiness |
| R05 | 跨夜/午睡/时区转换 | 主夜归属正确，未来时间排除 | assembler |
| D01 | 两周数据但窗口默认八周 | unknown coverage 不等于低准备度 | durability |
| D02 | 只有短跑但半马目标 | insufficient，不给精确耐力差诊断 | durability |
| D03 | 地形不同导致后段变慢 | 降低可比性，不直接给耐力下降结论 | durability |
| L01 | 只增加 Load Vector | 原 compositeLoad 与日指标 golden 一致 | load |
| L02 | mechanical 输入不可用 | mechanicalLoad=null，不为0 | load |
| L03 | ACWR 单独升高 | 不自动覆盖所有恢复/计划信息 | load/coach |
| L04 | unknown prehistory | 不补零假装长期低负荷 | load |
| Z01 | 手工设置生效/失效 | 生效日期与来源可追溯 | zones |
| Z02 | 阈值 prior 不可用但有效测试存在 | 新路径可独立估计或明确拒绝理由 | physiology |
| Z03 | interval HR 滞后 | 不按稳态硬判持续冲突 | zones |
| P01 | Daniels 既有 golden | 无政策变更时结果不变 | physiology |
| P02 | 相同历史环境进入两层 | ledger 阻止重复去偏差 | prediction |
| P03 | 未来比赛但今天恢复差 | neutral/current-prepared 不受当天恢复永久罚分 | prediction |
| P04 | Preparation + Durability 同源信息 | 不重复套两次旧 readiness penalty | prediction |
| P05 | 仅一个 point correction policy | 不叠 bias/Ridge/CatBoost | prediction |
| M01 | schema hash/特征顺序错 | 拒绝模型，回退可解释 baseline | inference |
| M02 | ONNX 差≥1e−6 | 拒绝激活 | ML |
| M03 | 标签不足 | 所有精度指标 null，拒绝 ML 激活 | evaluation |
| M04 | Calibration 与 holdout 相同事件 | 数据切分验证失败 | evaluation |
| I01 | P80/P90 | 嵌套有序、样本/宽度/覆盖同时报告 | calibration |
| T01 | 迟到标签/override | 不进入此前 as-known-then 预测 | replay |
| T02 | 删除训练后重放 | 所有下游去除该事实影响 | replay |
| C01 | renderer 改语言 | action/tone/codes 不变 | coach |
| S01 | candidate 任一步失败 | active bundle 不变，旧结果可读 | storage/API |
| S02 | V2 null recovery_score | 使用新 transition gate，不填伪值绕旧 gate | storage |
| S03 | 旧 checkpoint + 新 config/schema | 拒绝复用并安全回放 | application |
| S04 | prune 历史 run | 活跃及回滚 bundle 依赖不被删 | storage |
| R06 | 旧恢复阈值命中任意 state | stateEvidence 保持 heuristic/not_empirically_validated；所有消费端保留 | contracts/API/UI |
| F11 | 权重 A/B 与三种删维度候选 | 相关性/行为消融报告齐全，无标签不得宣称最优 | evaluation |
| F12 | 任一分桶少于最低样本或跨度 | 双向学习不可用，不跨桶混合、不用重复窗口凑 N | features/scoring |
| F13 | 连续高质量退步且缺天气 | 报分层接受率/延迟；不因 unavailable 一律冻结 | evaluation/scoring |
| F14 | modelConfidence=null，但规则因子有效 | E 有值、overall=null；TA 只按明确的 E 门控 | confidence |
| F15 | 必需规则因子 null / 0 / NaN | 分别缺证据、真实零、校验失败；没有 null 默认填补 | confidence |
| B03 | rebase 定期检查/冷却/饱和 | 检查不等于自动切换；理由、样本、epoch 全部可追溯 | baseline/application |
| B04 | 新标尺重估历史 | 标注回顾性视图；旧事实曲线保留，不回灌 as-known-then | replay/UI |
| I02 | 无 calibration/域匹配/足够独立评估 | 不展示为 P80/P90 保证；只保留明确 heuristicRange | API/UI |
| T03 | 已标注结果不合格、重复、更正或撤销 | 漏斗计数可对账、理由可见、失效传播正确 | application/evaluation |
| N01 | 环境三项缺一 / 三项齐全且为零 / 三项齐全且有修正 | unavailable 不产出部分修正、not_needed 显式 0、applied 与证据同一计算；可得率按解析结果计数 | physiology/API/UI |
| N02 | 上坡 / 下坡 / 平坦的同一配速 | 等强配速随坡度单调、零坡度恒等、超出成本模型域时夹取并给理由 | physiology/API |
| N03 | 无海拔采样 / 单点采样 / 坡度超出可信范围 / 分段过短 | gradePercent 与等强配速均为 null 且带理由码，未知不得渲染为 0 | API/UI |
| L05 | 日指标叠加状态曲线 | 持久化字段逐位不变；chronic=0/NaN ⇒ insufficient_data 而非中性档；分档在边界上归属明确 | training-load/UI |
| M05 | 个人区间试图带人群词汇 / 换掉免责声明 | 断言拒绝：个人带不得出现 nominalCoverage/coverageP80/coverageP90，免责声明必须逐字 | model-eval/API/UI |
| T06 | 非标准距离 / 配速越界 / 已标注 / 已确认过 / 快慢不同的跑者 | 候选只提议写入路径会接受的录入；理由随候选返回；已确认的按 `日期\|距离` 去重不再出现；"更拼"以跑者自己的中位配速为基准 | API/UI |
| M12 | 人群/个人两个范围的门槛与激活 / 旧行 scope 回读 / 个人范围内单距离不足 | 人群门槛保持 50·8 不变；个人范围复用 artifact 门槛 24·4 且仍需三个距离；激活判据完全相同；无 scope 字段的旧行按 population 解释；拒绝信息引用实际门槛 | application/API/UI |
| M11 | 个人层状态报告的是录入数还是可用残差数 | 状态按留一法**可用残差**计数：只有一条标签时可用残差为 0，不得据录入数宣称已就绪 | application/API/UI |
| M06 | 标签数、距离数或跨度不足 / 残差非有限 / 残差并非留出 / 单条标签自我预测 | 不足时不产出区间（返回 null 并报告缺哪一项）；非有限残差不参与拟合但计入样本；evaluated < samples−1 报"不是留一法" | model-eval/API/UI |
| T04 | 手工成绩在录入时刻之前/之后 / 比赛日在未来 / 撤销后 | 录入前不可见（不进入此前预测）；比赛未发生不是标签；撤销按时刻生效且行保留为墓碑 | application/storage |
| T05 | 非法日期/距离/时长/隐含配速 / 手工标签计数 | 仓储与 API schema 同界拒绝；漏斗 manualEntryCount 与 byDistance 可对账；手工条目只作标签，不生成轨迹或能力评分 | storage/API/UI |
| G05 | 无目标赛事 / 减量周 / 无赛事时的上限 / 阶段归属 | 无目标赛事时不静默减量、不给假阶段；减量周处方落在阶段量带内；阶段只能降低上限；阶段按"距比赛周数"赋值（最后一周为 race_week 且 weeksToRace 递减到 0） | API/UI |
| G01 | 赛事距离/周数不同的骨架 / 超过 24 周 / 比赛已过 / 无目标 | 阶段边界按距离分档；减量周与比赛周量带显著小于专项期；超限与过期如实标注且不编造周 | API/UI |
| G02 | 周一/周中首次生成计划 / 本周编辑后回看上周依从性 | 义务按每日本地午夜冻结；无处方时采用当日首次版本；未来日用最新版，改本周不改上周 | API/UI |
| G03 | 计划要求训练但无观测 / 无计划历史 / 该周未要求训练 | 无观测记 unknownDays 而非未完成；无历史时整体 unknown；未要求训练的周不算达标 | API/UI |
| G04 | 连续低量 / 质量课未观测 / 计划超出阶段带 | 只产出重排理由与建议，不自动改写计划；单周低量不足以触发 | API/UI |
| V01 | 隐私区落在路线中段 / 起点 / 覆盖整条路线 | 区内点被删除**且**穿越线段被切断（不得留下穿区的弦）；整条被覆盖时卡片不含路线；重叠隐私区并成一处断开 | API/UI |
| V02 | 未配置隐私区 / 隐私区远离路线 | 无区时几何逐点不变（幂等）且卡片明示"未过滤"；不相关的区不改变任何点，但仍如实报告 applied | API/UI |
| V03 | 空路线 / 单点路线 / 非法坐标 / 非法隐私区参数 / 被拒绝的写 | 不产出折线也不编造统计；非法坐标与非法区参数被丢弃而不是静默删掉路线；写被拒绝时既有隐私区与 revision 保持不变 | storage/API/UI |
| Y01 | 采样密集但只覆盖一小段 / 覆盖率低于地板 | 覆盖率按时间计；低于地板给 insufficient_coverage + 真实覆盖率，不给漂移数值 | dynamics/API/UI |
| Y02 | 前后半程配速不同 / 无可比配速样本 | 不做跨配速比较；无配对样本时 driftFraction=null 且带理由码，不得把降速读成跑姿变化 | dynamics/API/UI |
| Y03 | 手表未记录某指标 / 序列含非有限值 | unavailable + no_samples，均值与漂移均为 null（不渲染为 0）；非有限样本被丢弃而非参与平均 | dynamics/API/UI |
| L06 | 无已结束训练 / 无 chronic 背景 / 负荷相对值达上限 / 窗口已过 | 前两者 insufficient 且 remainingHours=null（不渲染 0）；负荷越大估计越长并在上限处封顶；低置信度如实标注 | training-load/API/UI |

### 16.2 核验层级

默认 typecheck、npm test、build，桌面流程用 test:e2e:web；不因“完整审查”运行冻结窄屏。
iOS 自动门禁不替代真机 HealthKit/后台/地图与视觉验收；Python 训练合同另跑 ml:test。
精度未校准、原库未部署、失败或平台跳过必须分别列出。

## 17. 发布顺序

先修契约/反泄漏/标签闭环，再改证据/门控，再做真实精度优化；每次只改可归因的政策。
先在 SQLite backup 副本演练迁移、全量/增量、失败保持 incumbent、回滚/重开，再审查真实部署。
身份或 migration 语义变更不得就地覆盖历史 checksum；人工操作默认 dry-run，明确 --apply 才写指定库。

## 18. 完成判据

工程：恢复隔离、缺失语义、无未来泄漏、同 epoch、兼容 decoder/checkpoint、唯一 correction、快照一致与原子发布成立。
精度：真实独立标签、三方公平竞争、独立区间 calibration/test 与 domain match 成立。
未完成前者不能靠旧测试绿宣称完成；未满足后者必须维持公式 fallback 和不足状态。
