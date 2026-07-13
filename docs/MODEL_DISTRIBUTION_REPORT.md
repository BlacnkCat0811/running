# RAI V1 Gold 队列分布与参数调整报告

## 1. 范围与口径

本报告基于本地 Health 导入数据的完整历史回放，评估时间固定为 `2026-07-10T05:44:23.589Z`，时区为 `Asia/Shanghai`。不包含路线、设备名称、单条训练时间或其他可识别原始数据。

**Gold 队列**定义为：`training_session` 所属的 Workout Group 内，至少存在一条 Apple Watch、户外跑步来源副本。队列必须在训练实体层定义，不能只看当前 canonical Workout 的来源，否则同一次训练的来源副本会改变队列归属。

| 队列 | 训练实体数 | 用途 |
|---|---:|---|
| Gold evidence | 38 | 核心数据质量与评分分布检查 |
| Gold eligible | 36 | 可参与个人基线或 TA 更新的特征 |
| Gold assessed | 31 | 去除 5 条校准记录后的 CA / TA 分布 |
| 全部 eligible | 162 | 跨来源稳健性检查 |

Gold 队列中剩余的数据质量标记仅涉及极短距离、极短时长或缺失心率的记录；它们不进入 TA 更新。

## 2. 发现

### 2.1 心率资格规则错误地拒绝了高质量 Gold 记录

旧运行要求至少 10 条心率记录。Gold 队列中大量记录的时间跨度已覆盖整次训练，但导出形式只包含少量、长区间的记录；旧规则将它们误判为 `trial`。

| 指标 | 旧运行 | 新运行 |
|---|---:|---:|
| Gold eligible Feature | 7 | 36 |
| Gold assessed | 7 | 31 |
| 全部 eligible Feature | 104 | 162 |

新规则仍要求平均心率存在，且满足以下任一条件：至少 10 条记录，或记录时间跨度覆盖训练的至少 50%。少量瞬时心率记录仍保持 `trial`，不会因样本数降低而放行。

### 2.2 当前 Cardio 原始值不是有效的心肺能力代理

现有 `cardioRaw = durationMinutes * speed` 与距离高度同义。旧模型中它的 Gold 中位得分为 16.57，并以 20% 权重持续拉低 CA。这不能区分“短而快的高质量训练”和“长距离训练”，因此不符合 Cardio 的定义。

Cardio 原始值和诊断分数继续保存，方便未来回测；在 V1 当前能力计算中其权重设为 0。只有实现心率漂移、标准化有氧持续时间或一分钟心率恢复等有效信号后，才允许重新加入 CA。

### 2.3 z-score 尺度需要略微收紧

在修正 Gold 资格后，6 条、14 天的个人基线会让 Efficiency 的上端偏宽。将 `dimensionScoreZScale` 从 12 收紧到 10 后，Gold Efficiency 分数的 P90 为 83.24，只有 1 条达到 95 以上；没有出现 CA 的 0 或 100 饱和。

## 3. 最终 V1 参数

模型版本：`rai-model-config-v2`。

| 参数 | 值 | 原因 |
|---|---:|---|
| `calibrationMinimumSessions` | 6 | 保持原设定；当前样本可在至少 14 天内完成校准 |
| `calibrationMinimumSpanDays` | 14 | 保持原设定 |
| `dimensionScoreZScale` | 10 | 缩小小样本基线造成的上端挤压 |
| Efficiency 权重 | 37.5% | Cardio 移除后的比例重分配 |
| Pace 权重 | 31.25% | Cardio 移除后的比例重分配 |
| Cardio 权重 | 0% | 当前代理主要是距离，不参与 CA |
| Stability 权重 | 18.75% | Cardio 移除后的比例重分配 |
| Recovery 权重 | 12.5% | 保留当天状态影响；低恢复的负向 TA 更新仍受保护 |
| `minimumAvailableWeight` | 65% | 保持原设定 |
| `minimumConfidenceForTrueAbility` | 60% | 保持原设定 |

权重之和为 100%。模型配置作为不可变 JSON 快照写入 `model_runs`，本次变更不会覆盖历史评分。

## 4. 最终分布

下表为 Gold assessed（31 条）的分布，分位数为 P10 / P50 / P90。

| 指标 | P10 | P50 | P90 | 解释 |
|---|---:|---:|---:|---|
| Efficiency | 43.71 | 57.51 | 83.24 | 主要即时输出效率信号 |
| Pace | 47.20 | 54.37 | 66.06 | 速度表现，仍受训练意图影响 |
| Cardio（诊断） | 26.50 | 35.21 | 46.06 | 不参与 CA |
| Stability | 31.35 | 50.69 | 61.84 | 受间歇、暂停与记录粒度影响 |
| Recovery | 7.80 | 34.41 | 47.12 | 当天状态，不代表长期能力 |
| CA | 38.99 | 52.90 | 61.81 | 当日可发挥能力的个人指数 |
| TA 更新量 | -0.09 | +0.11 | +0.42 | 单次更新保持渐进 |

全部 eligible（156 条评分）CA 的 P10 / P50 / P90 为 **44.91 / 54.69 / 62.70**。这说明 CA 有区分度，且没有总分两端饱和；但它仍是个体内部指数，不能解释为百分位、VO2 Max 或与他人的横向比较。

截至评估时间，active daily snapshot 的 TA 为 **46.56**，GV 为 **-0.02 / week**。这两个值是新模型运行的结果；相较旧运行的 TA 34.17，变化主要来自资格修正、Cardio 去权和新个人基线，**不应被解读为一次真实训练带来的能力跃升**。

## 5. 运行对照与完整性

| 指标 | 旧 active run | 新 active run |
|---|---:|---:|
| Model Run | `rai-model-config-v1` | `rai-model-config-v2` |
| Gold CA P50 | 42.60 | 52.90 |
| 全部 CA P50 | 46.96 | 54.69 |
| 当前 TA | 34.17 | 46.56 |
| 共同可评分训练的 CA 变化 P50 | - | +9.61 |

本地 SQLite 完整性检查结果：`foreign_key_check = 0`；`active_model_run = 1`；active 指针指向成功完成的 Model Run。

后续可用以下只读命令按同一口径复查 active run，或将指定运行与历史运行对照：

```powershell
npm run data:analyze -- --database "D:\applerun\var\rai.sqlite"
npm run data:analyze -- --database "D:\applerun\var\rai.sqlite" --compare-with <历史 Model Run ID>
```

## 6. 当前限制与下一步验证

1. 6 条校准训练仍是较小样本。必须在后续数据积累后使用冻结时间切分和 walk-forward 回测，而不是继续依靠观感调参。
2. Recovery 分布偏低是当前状态公式的正常风险点。它只应影响即时 CA 和 TA 下降保护，不能作为长期能力下降的独立证据。
3. Cardio 必须以心率漂移、标准化耐力跑或心率恢复重建，之后才可重新赋权。
4. 下一轮验证需要用户填写训练类型、RPE、异常状态，并每 4–6 周执行一次相对标准化的 5 km 或 30 分钟测试跑。测试标签用于离线验证，不直接修改当次分数。
