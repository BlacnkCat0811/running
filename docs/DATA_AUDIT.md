# Apple 健康导出数据审计

> 生成时间：2026-07-20T02:16:13.406Z  
> 数据集版本：dataset_6a250b0dad7eb33b1ae5be28c04fc1a5  
> 隐私：本报告只包含聚合统计，不包含原始来源名称、健康值、精确时间或路线坐标。

## 1. 数据总览

| 对象 | 数量 |
|---|---:|
| 解析到的 Health records | 552192 |
| 稳定 ID 去重后的 Health records | 551740 |
| 完全相同的 record 副本 | 452 |
| Workouts | 284 |
| Activity summaries | 379 |
| GPX routes | 48 |
| GPX points | 102313 |
| Import issues | 0 |

## 2. 跑步数据

| 指标 | 数值 |
|---|---:|
| 原始 Running Workout | 260 |
| 去重后的 canonical 跑步 | 257 |
| 重复组 | 3 |
| 排除的重复副本 | 3 |
| 户外 | 180 |
| 室内 | 1 |
| 室内/户外未知 | 76 |
| 有可用路线 | 43 |

### 原始来源类别

| 来源类别 | 数量 |
|---|---:|
| connect | 140 |
| apple_watch | 42 |
| huawei | 41 |
| coros | 36 |
| other | 1 |

### canonical 来源类别

| 来源类别 | 数量 |
|---|---:|
| connect | 138 |
| apple_watch | 42 |
| huawei | 40 |
| coros | 36 |
| other | 1 |

### 数值分布

| 指标 | 最小 | P25 | 中位数 | P75 | 最大 |
|---|---:|---:|---:|---:|---:|
| 距离 km | 0.12 | 3.52 | 5.86 | 10.02 | 21.64 |
| 时长 min | 0.60 | 21.48 | 35.73 | 59.28 | 772.99 |
| 原始平均配速 min/km | 4.68 | 5.65 | 5.97 | 6.36 | 345.64 |

## 3. 模型可用性

| 队列 | 数量 | 用途 |
|---|---:|---|
| Gold：Apple Watch 户外 + 距离/时长/心率合格 | 40 | 初始高质量校准与公式验证 |
| Extended：全部来源 canonical 户外 + 核心数据合格 | 84 | 扩展样本、来源偏差分析 |
| canonical 且存在心率证据 | 85 | 心率效率可计算性检查 |

### 当前排除原因（可重叠）

| 原因 | 数量 |
|---|---:|
| insufficient_heart_rate | 172 |
| indoor_status_unknown | 76 |
| duration_below_8min | 16 |
| distance_below_1km | 9 |
| implausible_average_pace | 2 |
| indoor_workout | 1 |

## 4. WorkoutStatistics 覆盖

| 指标 | canonical 跑步数 |
|---|---:|
| distance | 257 |
| active_energy | 256 |
| HKQuantityTypeIdentifierBasalEnergyBurned | 180 |
| vertical_oscillation | 43 |
| stride_length | 43 |
| running_speed | 43 |
| running_power | 43 |
| ground_contact_time | 43 |
| step_count | 42 |
| heart_rate | 42 |

## 5. 相关 Health Records

| 类型 | 数量 | 最早月份 | 最晚月份 | 单位 |
|---|---:|---|---|---|
| step_count | 88819 | 2020-02 | 2026-07 | count |
| heart_rate | 83792 | 2024-06 | 2026-07 | count/min |
| distance | 50108 | 2020-02 | 2026-07 | km |
| HKQuantityTypeIdentifierPhysicalEffort | 40688 | 2024-06 | 2026-07 | kcal/hr·kg, kcal/hr��kg |
| active_energy | 33820 | 2024-06 | 2026-07 | kcal |
| running_power | 11850 | 2024-06 | 2026-07 | W |
| running_speed | 11835 | 2024-06 | 2026-07 | km/hr, m/s |
| vertical_oscillation | 7797 | 2024-06 | 2026-07 | cm |
| ground_contact_time | 7792 | 2024-06 | 2026-07 | ms |
| stride_length | 7789 | 2024-06 | 2026-07 | m |
| HKCategoryTypeIdentifierSleepAnalysis | 5222 | 2023-10 | 2026-07 | - |
| HKQuantityTypeIdentifierHeartRateVariabilitySDNN | 684 | 2024-06 | 2026-07 | ms |
| HKQuantityTypeIdentifierRestingHeartRate | 363 | 2024-06 | 2026-07 | count/min |
| HKQuantityTypeIdentifierVO2Max | 51 | 2024-06 | 2026-07 | mL/min·kg |
| HKQuantityTypeIdentifierHeartRateRecoveryOneMinute | 30 | 2024-06 | 2026-07 | count/min |

## 6. 结论

- 导出中共有 260 条 Running Workout，经保守的时间重叠和距离匹配后形成 257 个 canonical 跑步组。
- 40 次 canonical Apple Watch 户外跑同时满足距离、时长、心率和合理配速条件，可作为最高质量的初始验证队列。
- 84 次跨来源 canonical 户外跑满足同一组核心条件，可作为扩展验证队列，但必须控制来源偏差。
- Apple Watch 跑步拥有最完整的路线和跑姿指标；旧设备及第三方记录不能在没有来源置信度的情况下与其等价混合。
- 睡眠、静息心率和 HRV 均存在，但时间覆盖不完全；恢复维度缺失时必须重分配权重，不能默认填入 50 分。

## 7. 限制

- Apple Health XML does not expose the same object associations available to live HealthKit queries. Time-series-to-workout links are inferred by source and time overlap.
- Near-duplicate grouping is conservative and must remain reviewable; no raw workout is deleted.
- Indoor/outdoor metadata is missing for some imported sources. Unknown is kept separate from outdoor.
- ECG CSV files and export_cda.xml are intentionally out of scope for running ability scoring.
- No medical inference is made from heart-rate or recovery records.
