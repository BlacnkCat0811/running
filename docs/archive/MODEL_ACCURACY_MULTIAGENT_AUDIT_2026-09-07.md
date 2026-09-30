# 跑力 / 恢复准备度 / 训练课 计算模型准确性 —— 多智能体审计报告

- 日期：2026-09-07
- 研究基线：commit `6ccf559`（`git fetch origin` 后与 origin/main 同步，落后 0；工作树干净）
- 方法：4 个并行研究代理（跑力 / 恢复准备度 / 训练课与负荷 / 校准与数据完整性）+ 主代理逐条实证复核（含 node:sqlite 行为实测、SQL 占位符核对、阈值与公式对照）
- 范围：只读代码研究，未修改任何文件；未运行完整预测管线
- 相关版本契约：rai-physiology-v1.7.0、feature-config-v8、rai-model-config-v4

---

## 一、结论先行

四类计算引擎**核心数学与因果口径总体可靠**：Daniels VDOT 动力学、ACWR 负荷、恢复分量方向与归一化、as-of 重算纪律均符合领域共识且无未来函数，未发现系统性 🔴 级数值错误。主要风险集中在**证据获取层的一个静默空查询**（跑力训练包络证据恒缺失）、若干**无文献引用的经验系数/阈值**、以及**模型维度缺口**（睡眠单维、性别系数未接通、无时间衰减）。

| 模型域 | 评级 | 一句话结论 |
|---|---|---|
| 跑力（VO2max/VDOT/LTHR/成绩预测） | 4/5 | 核心动力学教科书级准确、闭环自洽，扣分在海拔罚分低估与经验系数无引用 |
| 恢复准备度（睡眠/HRV/RHR→readiness） | 4/5 | 方向与归一化正确，扣分在睡眠单维、置信度/新鲜度未进分、权重无依据 |
| 训练课特征 + 训练负荷 | 3.5~4/5 | 负荷公式与 ACWR 合规；课型 HRR 带与心率区间带两套口径脱节 |
| 校准与数据完整性（cross-cutting） | 3.5/5 | as-of/幂等/回测契约设计优秀，但存在 1 个 🔴 静默空查询与能力模型无时间衰减 |

**最需优先处置的一条**（主代理实证确认，非代理报告原样）：

> 🔴 `packages/application/src/prediction-data.ts:242-272` `loadPerformanceVdotEvidence` 的 SQL 含 **3 个占位符**（override 子查询 1 + `anchor_start_at>=?` 1 + `anchor_end_at<=?` 1），但 `.all(asOf, asOf)` 只传 **2 个参数**。node:sqlite 少传参数**不报错**（实测），第 3 个占位符按 NULL 绑定 → `anchor_end_at <= NULL` 恒假 → **该查询恒返回 0 行**。结果：非比赛/非测试标记的"训练包络"跑力证据**系统性永久缺失**（静默降级，不崩溃）。对照同文件 `loadRaceReadiness:462` 的正确写法 `.all(asOf, cutoff, asOf)`，此处应补 `const cutoff = ...`（如 56 天前）并传 3 参。

---

## 二、分级发现总表

严重度：🔴 高（确凿缺陷/显著偏差）｜🟡 中（口径/阈值/维度风险）｜🟢 低（符合共识）。

| # | 域 | 级别 | 位置 | 发现 | 状态 |
|---|---|---|---|---|---|
| F1 | 跑力-证据 | 🔴 | prediction-data.ts:242-272 | training-envelope SQL 3 占位符只传 2 参 → 恒空，训练包络 VDOT 证据永久缺失 | ✅ 主代理实证复核 |
| F2 | 跑力-成绩预测 | 🟡 | physiology/index.ts:241-256 | 海拔罚分 `爬升m/km × 0.00035`（100m/km≈3.5%，封顶10%）：普通公路赛合理，但越野/陡坡山赛系统性低估（Minetti 2002 坡道代谢成本在陡坡远高于线性模型） | ✅ 抽查一致 |
| F3 | 跑力-成绩预测 | 🟡 | physiology/index.ts:115-124, 856-857 | 默认 readiness 半马=0.45 → 无输入时固定扣 ~3.3 VDOT，对备赛充分者过度保守；系数无引用 | 代理 A |
| F4 | 跑力-环境 | 🟡 | physiology/index.ts:224-239 | 热/湿度罚分量级与 El Helou 马拉松折减研究接近（合理），但为经验常数无直接引用 | 代理 A |
| F5 | 跑力-校准 | 🟡 | physiology/index.ts:1075,1107 | bias 校准最小样本仅 3 条 → 过拟合风险；建议 ≥8 | 代理 A |
| F6 | 恢复-维度 | 🟡 | features/index.ts:114-119,456 | 恢复分仅用睡眠**时长**单维，未纳入效率/深睡/阶段（Whoop/Garmin 含组成） | ✅ 抽查一致 |
| F7 | 恢复-置信度 | 🟡 | canonicalize-nights.ts:187 vs features:462-464 | HRV 单样本标 sparse、多样本 confident，但打分时同权使用 | 代理 B |
| F8 | 恢复-截断 | 🟡 | features/index.ts:457,460,463 | sleep/HRV/RHR 比均 clamp [0,1]，优于基线部分被截顶，优秀恢复无法表达 | ✅ 抽查一致 |
| F9 | 恢复-新鲜度 | 🟡 | features:451-499 vs mobile-coach:177-184 | features 层计算 recoveryRaw 不检查新鲜度，陈旧夜仍全额进分；仅 coach verdict 层门控 | 代理 B |
| F10 | 恢复-复用 | 🟡 | features:456-464 / training-load:31-40 / mobile-coach:189-259 | 同一比值逻辑三处重复实现（clamp 口径不一），漂移风险 | 代理 B |
| F11 | 恢复-权重 | 🟡 | features/index.ts:114-119 | sleep .35/rhr .25/hrv .25/load .15 无文献依据，HRV（最敏感急性标记）与 RHR 同权 | ✅ 抽查一致 |
| F12 | 恢复-基线 | 🟡 | recompute-pipeline.ts:744-749 | 28/60 天中位数自参照：旅行/生病 2 周会拉低基线，掩盖真实耗竭 | 代理 B |
| F13 | 恢复-时区 | 🟡 | canonicalize-nights.ts:148 | 默认 Asia/Shanghai 硬编码，非上海用户夜间归属可能偏移 | 代理 B |
| F14 | 训练课-分区 | 🟡 | features:46-48 vs training-zones:157-162 | 课型 HRR 阈值（recovery<0.5/easy<0.65/steady<0.75）与区间带（recovery<0.6/aerobic 0.6-0.8/LT 0.8-0.9）两套口径：HRR∈[0.5,0.6] 归 easy 而非 recovery，aerobic_base 层在课型中不可达；且课型用当课 observedMax、区间带用公式 max，双 HRR 源 | ✅ 抽查一致 |
| F15 | 负荷-性别 | 🟡 | training-load/index.ts:91-97 | 女性 TRIMP 系数 1.67 已定义但未接通（注释自认 DailyZoneProfile 无性别）→ 女性负荷系统性偏高 e^(0.25·HRR)≈+21% | ✅ 抽查一致（代码注释明示） |
| F16 | 负荷-常数 | 🟡 | training-load/index.ts:135-139 | Banister 指数 TRIMP 缺 0.64 归一常数：绝对负荷与文献不可比，比值类（ACWR/单调）不受影响 | ✅ 抽查一致 |
| F17 | 训练课-间歇 | 🟡 | features:247-298,44 | 间歇识别需 ≥3 个 ≥60s 工作段+2 个 ≥30s 恢复段+CV≥0.18：30s 短间歇易漏判为 easy/steady，fartlek 高波动可能误判 | 代理 C |
| F18 | 训练课-配速界 | 🟡 | features:40-41,388 | 配速合法窗 [2.5,15] min/km，15min/km(4km/h) 硬排除会误杀快走/爬坡恢复课（implausible_average_pace 为硬排除） | 代理 C |
| F19 | 评分-衰减 | 🟡 | scoring/model.ts:27-29 | 能力更新 α 仅按课次分段(0.15/0.10/0.06)，不随样本量收敛至 0；校准基线冻结不刷新 → 陈旧成绩永久 100% 权重 | 代理 D（主代理修正定性） |
| F20 | 评分-门槛 | 🟡 | scoring model.ts:28-29 / physiology:1075 | calibrationMinimumSessions=6、spanDays=14 偏激进，MAD 由 6 点估计方差高 | 代理 D |
| F21 | 预测-静默降级 | 🟡 | recompute-pipeline.ts:2108 | 每次重算成功清空激活 CatBoost → 重训窗口内预测退回纯公式，无告警 | 代理 D |
| F22 | 预测-Python 端 | 🟡 存疑 | prediction-model-service（Python 端 research/scripts） | TS 侧仅校验最终 split 契约；逐样本 as-of 特征构造在 Python 端，未直接核验是否真按 labelAvailableAt 截止 | 代理 D，需补验 |
| G1 | 跑力-核心 | 🟢 | physiology:182-189 | danielsFractionOfVo2Max 常数与 Daniels《Running Formula》逐位一致 | ✅ 抽查一致 |
| G2 | 跑力-闭环 | 🟢 | physiology:212-292 | vdotFromPerformance ↔ performanceSecondsFromVdot 二分收敛、互逆自洽 | 代理 A |
| G3 | 跑力-疲劳 | 🟢 | physiology:870 | fatiguePenalty=(1-readiness)×0.04，最大 4%，与训练疲劳 2-6% 成绩折损研究量级相符 | 代理 A |
| G4 | 跑力-无泄漏 | 🟢 | physiology:356-361 | estimateVo2Max 排除 ageDays<0（证据晚于 asOf） | ✅ 抽查一致 |
| G5 | 恢复-方向 | 🟢 | features:456-464 | RHR=基线/实际（越低越好→反比正确）；HRV/睡眠=实际/基线，无反向错误 | ✅ 抽查一致 |
| G6 | 恢复-归一化 | 🟢 | features:474-484 | 缺失维度从权重剔除并重归一（非当 0/1），无除零（load 用 max(baseline,1)） | ✅ 抽查一致 |
| G7 | 恢复-口径 | 🟢 | canonicalize-nights.ts:138 | sleepDurationMinutes 用 asleep_union_minutes（入睡时长）非在床时长 | 代理 B |
| G8 | 负荷-ACWR | 🟢 | training-load:74-80,229-240 | acute 7d/chronic 28d EWMA；风险带 0.9-1.3 effective、>1.5 attention 与共识一致 | 代理 C |
| G9 | 负荷-as-of | 🟢 | training-load:243-280 + recompute:1538-1593 | 逐日只聚合 ≤当日 数据，无未来函数 | 代理 C |
| G10 | 负荷-降级 | 🟢 | training-load:130-133,149-174 | HRR 分母≤0 返回 null 并降级到 RPE→session_type 链 | 代理 C |
| G11 | 完整性-as-of | 🟢 | recompute-pipeline.ts:713-743,1857 | 恢复基线查询全部 `< workoutStartAt`，无"今日基线写进历史日" | ✅ 抽查一致 |
| G12 | 完整性-回测 | 🟢 | prediction-training-runner.ts:413-433 | temporal_event_grouped_holdout_v1 + embargo + walk-forward + bootstrap 95% 下限>0 才 accept | 代理 D |
| G13 | 完整性-幂等 | 🟢 | recompute + job-repository | 排序确定 + deterministicId + state_hash + BEGIN IMMEDIATE 原子认领，无半套新旧数据 | 代理 D |
| G14 | 完整性-并发 | 🟢 | recompute-job-repository.ts:38-63,98-155 | running→queued 中断恢复，激活在 complete() 事务内 | 代理 D |

---

## 三、代理误报更正（主代理复核，重要）

**D 代理原报**：`prediction-data.ts:462` 使用未声明变量 `cutoff` → 运行时 ReferenceError，公式预测与 CatBoost 训练整条链路崩溃。

**主代理复核结果：误报。**
- `cutoff` 在 `loadRaceReadiness` 函数内第 441 行声明（`const cutoff = ... 56 天前 ...`），462 行 `.all(asOf, cutoff, asOf)` 为**同函数内正常使用**，作用域无误、参数与 3 占位符匹配。该函数正确。
- D 代理将行号错配到 `loadPerformanceVdotEvidence`。真正的问题在**该函数自己**的 SQL（242-272 行）：3 占位符仅传 2 参（F1）。D 代理"嗅到"了问题但定错了位置与性质。

**主代理实证（F1 确证过程）**：
1. 统计 `prediction-data.ts` 各查询占位符与传参：`loadRaceReadiness:462` 3 占位符/3 参 ✅；`loadPerformanceVdotEvidence:272` 3 占位符/2 参 ❌。
2. node:sqlite 行为实测：`3ph/2params => OK rows=0`（不抛错，缺位按 NULL）；`1ph/2params => ERROR: column index out of range`（多传才报错）。→ 少传参数 = **静默**，与 F1 症状吻合。
3. 调用链确认：`buildFormulaPredictionBase`(prediction-report.ts:211) ← 公式预测主路径；`recompute-pipeline.ts:1182` 也调用。→ 影响所有跑力公式预测的证据供给。

---

## 四、分域详细说明

### 4.1 跑力模型（physiology v1.7.0）评级 4/5
- **正确性锚点**（G1-G4）：VDOT 曲线、氧耗曲线、成绩↔VDOT 二分闭环、LTHR（1h 配速 + 85%HRR）、疲劳罚分、无泄漏。核心数学可与 Daniels 原书逐位对照，无需改动。
- **主要问题**：F1 证据层恒空是**供给端**缺陷——训练包络证据缺失后，非比赛标记的普通跑者的 VDOT 估计将依赖更少证据（direct VO2 / 少数标记课），置信度与样本量受损；F2 海拔罚分对越野赛事低估；F3 默认 readiness 偏保守导致成绩预测系统性偏慢。

### 4.2 恢复准备度模型 评级 4/5
- **正确性锚点**（G5-G7）：三分量方向、缺失重归一、睡眠口径、基线中位数 + 排除当日。属于方法学上"教科书正确"的实现。
- **主要问题**集中在"表达力"与"一致性"：F6/F8 单维时长 + 上限截顶 → 恢复"多好"无区分度；F7/F9 置信度与新鲜度没有参与打分；F10 三处重复实现是后续维护风险点。**建议动作**：收敛为单一计算函数 + 补睡眠效率维度 + sparse HRV 降权 + 陈旧降级。

### 4.3 训练课特征与负荷 评级 3.5-4/5
- **正确性锚点**（G8-G10）：Banister 指数形式、ACWR 7/28 EWMA、风险带、as-of、降级链。负荷引擎是**本项目最干净的部分**。
- **主要问题**：F14 课型分区与心率区间带两套 HRR 口径（阈值与 HRR 上限源均不同）——直接影响"这节课被标成什么强度"以及后续所有强度派生（zone 分布、负荷、训练建议）；F15 女性系数未接通影响约半数用户；F17/F18 间歇与步行边界阈值偏武断。
- **建议动作**：统一 HRR 上限源与分区边界 → 补 sex 字段 → 间歇识别参数化并增加短课覆盖。

### 4.4 校准与数据完整性 评级 3.5/5
- **正确性锚点**（G11-G14）：as-of 纪律、回测契约、幂等、并发互斥、原子激活——工程护栏是**优秀水平**，与量化系统的防泄漏标准对齐。
- **主要问题**：F1（跨域影响，见上）；F19 能力模型无时间衰减（陈旧成绩永久权重）属**方法学缺口**而非泄漏；F21 CatBoost 每次重算后静默清空重训（降级窗口无监控）；F22 Python 端 as-of 构造待核验。
- **建议动作**：修 F1 → 给能力更新加时间衰减与滚动校准 → 为 F21 加重训窗口告警。

---

## 五、修复优先级建议（P0-P2）

### P0（确认缺陷，应立即修）
- **F1** prediction-data.ts:272 补第 3 参并加 `cutoff`（对齐 loadRaceReadiness:441/462 的 56 天窗口写法；若意图是"全部历史"，则应改为 `anchor_start_at <= asOf` 语义——需实现者确认窗口意图）。修复后应对比修复前后 `loadPerformanceVdotEvidence` 返回行数（预期显著 >0）。

### P1（影响面大，建议近期修）
- **F14** 统一课型分区与心率区间带：单一 HRR 上限源 + 单一分区边界（建议 0.6/0.7/0.8/0.9 对齐 zones）。
- **F15** 补 sex 字段并接通 1.67 系数（或至少在无性别时用中间系数并在文档声明）。
- **F19** 能力模型加时间衰减（如 180 天半衰期）或滚动校准窗口。
- **F10** 收敛三处恢复比值为单一函数。
- **F6/F7/F9** 恢复分补睡眠效率维度、sparse HRV 降权、features 层新鲜度门控。

### P2（增强项 / 需补依据）
- **F2** 海拔罚分：对>50m/km 爬升改用分段/坡度成本模型。
- **F3/F11/F16** 为经验系数（默认 readiness、恢复权重、0.64 常数）补文献引用或改写为可配置。
- **F5/F20** 校准最小样本 3→8、6→10、spanDays 14→28。
- **F8** clamp 上限放宽（如 [0,1.2] 后截断展示）或记录原始比值供分析。
- **F13** 时区参数化（从用户 profile 传入，勿硬编码）。
- **F17/F18** 间歇参数化 + 步行恢复单独处理。
- **F21/F22** 重训窗口告警 + Python 端 as-of 构造专项核验（可与 prediction-training-runner 契约测试配合）。

---

## 六、局限与后续验证建议

1. 本审计为**静态代码 + 局部实测**，未端到端运行预测管线。建议修复 F1 后跑一次 `recompute` 并抽查 formula prediction 的 evidence 数量与输出。
2. F22（Python 端）与 F15（用户性别覆盖度）需要运行期数据/代码佐证，已标注存疑。
3. 恢复权重（F11）与课型阈值（F14/F17）的"最优值"依赖产品人群数据，建议以内部数据做敏感性分析后再定稿，而非纯文献搬运。
4. 未验证项：ridge 校准与 CatBoost 训练的超参（在 Python 端 research/scripts），如需可另开专项。
