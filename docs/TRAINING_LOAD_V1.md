# RAI 训练统计与负荷算法 V2

> 算法版本：`training-load-config-v2`  
> Feature schema：`workout-feature-v2`  
> 时区：`Asia/Shanghai`  
> 自然周：周一至周日

## 1. 运行边界

训练统计是独立派生层。所有 `active` Training Session 默认计入跑量；`eligibility_override` 只控制 RAI，只有最新覆盖中的 `statistics_participation = exclude` 才同时排除跑量和负荷。Web 只读取 active 视图，不计算周期、负荷或状态。

每次完整重算创建不可变 `training_metric_runs`。只有 Feature、Model 和 Training Metric Run 全部成功，`active_model_run` 才在单一事务中切换。失败运行保留诊断信息，不能成为 active。

## 2. 单次训练负荷

负荷来源按以下顺序选择：

1. 心率序列覆盖率至少 70%；
2. 平均心率；
3. 用户 RPE；
4. 训练类型代理。

```text
HRR = clamp((HR - RestingHR) / (ObservedMaxHR - RestingHR), 0, 1)
minuteLoad = HRR * exp(1.92 * HRR)
WorkoutLoad = sum(durationMinutes * minuteLoad)
```

区间型心率按 Record 与训练窗口的重叠时长积分；瞬时采样最多推断至下一样本或 30 秒。覆盖率使用区间并集。覆盖达到 70% 后，观测负荷归一化到完整训练时长。平均心率、RPE 和训练类型使用同一 HRR 负荷函数，保证量纲一致。

基础置信度分别为心率序列 0.95、平均心率 0.80、RPE 0.65、训练类型 0.40，再乘来源置信度与心率覆盖率因素。缺失恢复证据保持 `null`，不写成 0 或 50%。

## 3. 每日负荷

时间序列包含无训练零负荷日：

```text
alpha = 1 - exp(-ln(2) / halfLife)
EWMA_today = alpha * load_today + (1 - alpha) * EWMA_yesterday
acute half-life = 7 days
chronic half-life = 28 days
loadRatio = acuteEWMA / chronicEWMA
```

负荷比仅在历史至少 21 天、至少 6 次有效负荷训练且慢性负荷至少 5 时可用。

```text
current7dLoad = 最近 7 个自然日负荷之和
previous7dLoad = 再前 7 个自然日负荷之和
personalFloor = max(10, chronicEWMA * 7 * 0.25)
rampRate = (current7dLoad - previous7dLoad) / max(previous7dLoad, personalFloor)
monotony = min(5, mean(last7d) / standardDeviation(last7d))
strain = current7dLoad * monotony
```

恢复证据为最近 7 天、最多 3 次训练的 `recoveryRaw` 指数加权平均。

## 4. 训练状态

状态按固定优先级判定：`insufficient_data`、`attention`、`high_load`、`recovery`、`effective_stimulus`、`maintaining`。输出必须包含解释代码与实际触发值。

状态只描述训练负荷和恢复节奏，不输出伤病概率、过度训练诊断或医学建议。

## 5. 周月年统计

周、月、年按训练本地日期聚合。当前未完成周期与上一周期相同已过天数比较。平均配速使用总时长除以有距离训练的总距离，平均心率按训练时长加权。

每个周期包含距离、时长、次数、负荷、累计爬升、最长单次跑、平均配速、平均心率、训练类型分布、同比变化、数据完整度和负荷置信度。同时提供滚动 7、28、30、365 日窗口。

## 6. 数据库与 API

主要表：`training_metric_runs`、`workout_training_loads`、`daily_training_metrics`。只读视图：`active_workout_training_loads`、`active_daily_training_metrics`。

接口：

- `GET /v1/training-statistics/overview`
- `GET /v1/training-statistics/history`
- `GET /v1/training-statistics/load`
- `GET /v1/workouts/:id` 中的 `trainingLoad`
- `PATCH /v1/workouts/:id/override` 中的 `statisticsParticipation`

## 7. 版本规则

算法公式、阈值、代理表、时区或统计口径变化时必须创建新算法版本和新的 Training Metric Run。历史负荷不原位更新。Schema v9 为所有 active 视图增加成功 Run 防御条件。
