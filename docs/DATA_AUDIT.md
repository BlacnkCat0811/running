# Apple 健康导出数据审计

> 生成时间：2026-09-17T04:32:53.902Z  
> 数据源：var/rai.sqlite  
> 数据集版本：dataset_03e90c69d86a52330a8677744818d423  
> 隐私：本报告只包含聚合统计，不包含原始来源名称、健康值、精确时间或路线坐标。

## 1. 数据总览

| 对象 | 数量 |
|---|---:|
| 上次导入解析到的 Health records | 83116 |
| 表内 Health records 行数 | 83380 |
| 其中冗余行（自然键重复） | 0 |
| Workouts | 271 |
| Activity summaries | 0 |
| GPX routes | 92 |
| GPX points | 204284 |
| Import issues | 0 |

## 2. 跑步数据

| 指标 | 数值 |
|---|---:|
| 原始 Running Workout | 271 |
| 去重后的 canonical 跑步 | 268 |
| 重复组 | 3 |
| 排除的重复副本 | 3 |
| 户外 | 267 |
| 室内 | 1 |
| 室内/户外未知 | 0 |
| 有可用路线 | 46 |

### 原始来源类别

| 来源类别 | 数量 |
|---|---:|
| connect | 148 |
| apple_watch | 46 |
| huawei | 41 |
| coros | 36 |

### canonical 来源类别

| 来源类别 | 数量 |
|---|---:|
| connect | 146 |
| apple_watch | 46 |
| huawei | 40 |
| coros | 36 |

### 数值分布

| 指标 | 最小 | P25 | 中位数 | P75 | 最大 |
|---|---:|---:|---:|---:|---:|
| 距离 km | 0.12 | 3.70 | 5.63 | 10.02 | 21.64 |
| 时长 min | 0.60 | 22.22 | 34.72 | 58.69 | 772.99 |
| 原始平均配速 min/km | 4.68 | 5.66 | 5.98 | 6.37 | 345.64 |

## 3. 模型可用性

| 队列 | 数量 | 用途 |
|---|---:|---|
| Gold：Apple Watch 户外 + 距离/时长/心率合格 | 44 | 初始高质量校准与公式验证 |
| Extended：全部来源 canonical 户外 + 核心数据合格 | 44 | 扩展样本、来源偏差分析 |
| canonical 且存在心率证据 | 45 | 心率效率可计算性检查 |

### 当前排除原因（可重叠）

| 原因 | 数量 |
|---|---:|
| insufficient_heart_rate | 223 |
| duration_below_8min | 16 |
| distance_below_1km | 9 |
| implausible_average_pace | 2 |
| indoor_workout | 1 |

## 4. WorkoutStatistics 覆盖

| 指标 | canonical 跑步数 |
|---|---:|
| distance | 268 |
| active_energy | 268 |
| heart_rate | 45 |

## 5. 相关 Health Records

| 类型 | 数量 | 最早月份 | 最晚月份 | 单位 |
|---|---:|---|---|---|
| distance | 10965 | 2024-06 | 2026-08 | m |
| active_energy | 10874 | 2024-06 | 2026-08 | kcal |
| running_speed | 10825 | 2024-06 | 2026-08 | m/s |
| running_power | 10821 | 2024-06 | 2026-08 | W |
| step_count | 10803 | 2024-06 | 2026-08 | count |
| heart_rate | 6117 | 2024-06 | 2026-08 | count/min |
| HKCategoryTypeIdentifierSleepAnalysis | 5664 | 2023-10 | 2026-09 | - |
| vertical_oscillation | 5274 | 2024-06 | 2026-08 | cm |
| ground_contact_time | 5269 | 2024-06 | 2026-08 | ms |
| stride_length | 5257 | 2024-06 | 2026-08 | m |
| HKQuantityTypeIdentifierHeartRateVariabilitySDNN | 762 | 2024-06 | 2026-09 | ms |
| HKQuantityTypeIdentifierRestingHeartRate | 408 | 2024-06 | 2026-09 | count/min |
| HKQuantityTypeIdentifierVO2Max | 57 | 2024-06 | 2026-08 | mL/kg·min |

## 6. 结论

- 导出中共有 271 条 Running Workout，经保守的时间重叠和距离匹配后形成 268 个 canonical 跑步组。
- 44 次 canonical Apple Watch 户外跑同时满足距离、时长、心率和合理配速条件，可作为最高质量的初始验证队列。
- 44 次跨来源 canonical 户外跑满足同一组核心条件，可作为扩展验证队列，但必须控制来源偏差。
- Apple Watch 跑步拥有最完整的路线和跑姿指标；旧设备及第三方记录不能在没有来源置信度的情况下与其等价混合。
- 睡眠、静息心率和 HRV 均存在，但时间覆盖不完全；恢复维度缺失时必须重分配权重，不能默认填入 50 分。

## 7. 限制

- Apple Health XML does not expose the same object associations available to live HealthKit queries. Time-series-to-workout links are inferred by source and time overlap.
- Near-duplicate grouping is conservative and must remain reviewable; no raw workout is deleted.
- Indoor/outdoor metadata is missing for some imported sources. Unknown is kept separate from outdoor.
- ECG CSV files and export_cda.xml are intentionally out of scope for running ability scoring.
- No medical inference is made from heart-rate or recovery records.
