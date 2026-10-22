### D1

| 查询 | baseline p50 | baseline p95 | 窄索引 p50 | 窄索引 p95 | 覆盖索引 p50 | 覆盖索引 p95 | v47 p50 | v47 p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| metricSeries.heartRate.dense | 13.65 | 18.98 | 13.07 | 16.37 | 12.98 | 17.66 | — | — |
| metricSeries.speed.dense | 4.69 | 7.28 | 4.12 | 5.59 | 3.99 | 5.67 | — | — |
| metricSeries.heartRate.regular | 13.59 | 16.81 | 13.11 | 16.32 | 12.61 | 15.43 | — | — |
| metricSeries.stepCount.broad | 100.30 | 172.87 | 90.01 | 103.66 | 74.04 | 83.79 | — | — |
| metricIntervals.heartRate | 6.45 | 9.45 | 5.74 | 8.05 | 5.39 | 6.91 | — | — |
| workouts.list.limit30 | 1.76 | 2.88 | — | — | — | — | — | — |
| workouts.list.offset1000 | 1.47 | 2.32 | — | — | — | — | — | — |
| workouts.count | 0.56 | 1.00 | — | — | — | — | — | — |
| workouts.list.status | 2.30 | 3.83 | — | — | — | — | — | — |
| workouts.list.route | 2.36 | 3.54 | — | — | — | — | — | — |

| 完整端点 | baseline p50 | baseline p95 | v47 p50 | v47 p95 | p50 变化 | p95 变化 |
|---|---:|---:|---:|---:|---:|---:|
| endpoint.workouts | 2.14 | 4.21 | 2.01 | 3.54 | -6.0% | -16.1% |
| endpoint.workoutsWithViews | 4.59 | 6.27 | 4.00 | 6.02 | -12.8% | -4.0% |
| endpoint.workoutSeries.dense | 37.46 | 41.56 | 38.00 | 44.57 | 1.4% | 7.3% |

索引体积：baseline 25550848 B；窄 29917184 B；覆盖 31895552 B；v47 25632768 B。
索引构建：窄 166.2 ms；覆盖 235.4 ms；v47 1.0 ms。

差分：
- narrow: 全部相等
- cover: 全部相等
- ability: 全部相等

| 审计/连接/端点 | p50 | p95 | 样本 |
|---|---:|---:|---:|
| audit.dataSummary.cold | 5.87 | 9.79 | 10 |
| audit.dataSummary.warm | 0.02 | 0.05 | 300 |
| audit.dataAudit.cold | 42.74 | 43.91 | 5 |
| audit.dataAudit.warm | 0.02 | 0.04 | 120 |
| audit.dataSummary.afterCommit | 2.80 | 6.14 | 30 |
| connection.cachedUse | 0.03 | 0.08 | 1000 |
| connection.useDatabase | 2.35 | 3.67 | 500 |
| endpoint.workouts.limit30 | 2.12 | 3.19 | 300 |
| endpoint.workoutsWithViews.limit30 | 4.85 | 7.90 | 300 |
| endpoint.workoutSeries.dense | 39.14 | 44.77 | 60 |

| 重叠统计 | p50 | p95 | 样本 |
|---|---:|---:|---:|
| overlap.coldStats | 22.53 | 27.28 | 50 |
| overlap.warm | 3.94 | 6.06 | 500 |
| overlap.afterNoopReceipt | 25.98 | 36.25 | 30 |
| overlap.afterCommit | 24.04 | 28.97 | 60 |

### D2

| 查询 | baseline p50 | baseline p95 | 窄索引 p50 | 窄索引 p95 | 覆盖索引 p50 | 覆盖索引 p95 | v47 p50 | v47 p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| metricSeries.heartRate.dense | 16.06 | 27.48 | 13.23 | 17.78 | 12.81 | 15.70 | — | — |
| metricSeries.speed.dense | 5.84 | 11.26 | 4.16 | 5.59 | 4.01 | 5.59 | — | — |
| metricSeries.heartRate.regular | 14.87 | 24.07 | 13.15 | 16.06 | 12.88 | 15.69 | — | — |
| metricSeries.stepCount.broad | 1326.60 | 1957.04 | 1180.56 | 2805.29 | 937.53 | 2397.89 | — | — |
| metricIntervals.heartRate | 6.78 | 10.48 | 5.79 | 7.50 | 5.54 | 7.27 | — | — |
| workouts.list.limit30 | 8.96 | 12.40 | — | — | — | — | — | — |
| workouts.list.offset1000 | 9.60 | 14.00 | — | — | — | — | — | — |
| workouts.count | 5.05 | 8.75 | — | — | — | — | — | — |
| workouts.list.status | 12.52 | 16.38 | — | — | — | — | — | — |
| workouts.list.route | 13.74 | 22.67 | — | — | — | — | — | — |

| 完整端点 | baseline p50 | baseline p95 | v47 p50 | v47 p95 | p50 变化 | p95 变化 |
|---|---:|---:|---:|---:|---:|---:|
| endpoint.workouts | 12.29 | 15.09 | 12.29 | 14.95 | 0.0% | -0.9% |
| endpoint.workoutsWithViews | 94.95 | 99.48 | 21.29 | 24.68 | -77.6% | -75.2% |
| endpoint.workoutSeries.dense | 38.20 | 43.22 | 37.76 | 40.99 | -1.1% | -5.2% |

索引体积：baseline 243163136 B；窄 285659136 B；覆盖 304873472 B；v47 243261440 B。
索引构建：窄 2093.4 ms；覆盖 2905.6 ms；v47 3.3 ms。

差分：
- narrow: 全部相等
- cover: 全部相等
- ability: 全部相等

| 审计/连接/端点 | p50 | p95 | 样本 |
|---|---:|---:|---:|
| audit.dataSummary.cold | 16.87 | 19.45 | 10 |
| audit.dataSummary.warm | 0.02 | 0.04 | 300 |
| audit.dataAudit.cold | 373.84 | 390.14 | 5 |
| audit.dataAudit.warm | 0.02 | 0.03 | 120 |
| audit.dataSummary.afterCommit | 16.02 | 25.13 | 30 |
| connection.cachedUse | 0.03 | 0.14 | 1000 |
| connection.useDatabase | 2.49 | 4.37 | 500 |
| endpoint.workouts.limit30 | 13.36 | 17.66 | 300 |
| endpoint.workoutsWithViews.limit30 | 100.63 | 112.85 | 300 |
| endpoint.workoutSeries.dense | 42.88 | 52.98 | 60 |

| 重叠统计 | p50 | p95 | 样本 |
|---|---:|---:|---:|
| overlap.coldStats | 199.50 | 301.99 | 50 |
| overlap.warm | 4.68 | 12.71 | 500 |
| overlap.afterNoopReceipt | 200.72 | 745.86 | 30 |
| overlap.afterCommit | 184.42 | 201.64 | 60 |

### D3

| 查询 | baseline p50 | baseline p95 | 窄索引 p50 | 窄索引 p95 | 覆盖索引 p50 | 覆盖索引 p95 | v47 p50 | v47 p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| metricSeries.heartRate.dense | 11.92 | 18.79 | — | — | — | — | — | — |
| metricSeries.speed.dense | 4.46 | 7.36 | — | — | — | — | — | — |
| metricSeries.heartRate.regular | 13.12 | 17.66 | — | — | — | — | — | — |
| metricSeries.stepCount.broad | 6139.62 | 35191.43 | — | — | — | — | — | — |
| metricIntervals.heartRate | 9.25 | 31.40 | — | — | — | — | — | — |
| workouts.list.limit30 | 59.99 | 86.14 | — | — | — | — | — | — |
| workouts.list.offset1000 | 63.07 | 82.31 | — | — | — | — | — | — |
| workouts.count | 34.44 | 42.32 | — | — | — | — | — | — |
| workouts.list.status | 80.17 | 95.34 | — | — | — | — | — | — |
| workouts.list.route | 83.41 | 96.45 | — | — | — | — | — | — |

| 完整端点 | baseline p50 | baseline p95 | v47 p50 | v47 p95 | p50 变化 | p95 变化 |
|---|---:|---:|---:|---:|---:|---:|
| endpoint.workouts | 78.70 | 106.72 | 77.32 | 87.07 | -1.7% | -18.4% |
| endpoint.workoutsWithViews | 2103.95 | 2333.35 | 130.38 | 146.40 | -93.8% | -93.7% |
| endpoint.workoutSeries.dense | 39.26 | 46.41 | 36.38 | 41.55 | -7.4% | -10.5% |

索引体积：baseline 941735936 B；窄 — B；覆盖 — B；v47 941891584 B。
索引构建：窄 — ms；覆盖 — ms；v47 71.0 ms。

差分：
- narrow: 未测
- cover: 未测
- ability: 全部相等

| 审计/连接/端点 | p50 | p95 | 样本 |
|---|---:|---:|---:|
| audit.dataSummary.cold | 60.80 | 79.04 | 10 |
| audit.dataSummary.warm | 0.02 | 0.05 | 180 |
| audit.dataAudit.cold | 1668.42 | 1716.74 | 5 |
| audit.dataAudit.warm | 0.02 | 0.04 | 120 |
| audit.dataSummary.afterCommit | 59.99 | 74.01 | 30 |
| connection.cachedUse | 0.03 | 0.10 | 600 |
| connection.useDatabase | 2.82 | 4.60 | 300 |
| endpoint.workouts.limit30 | 81.12 | 98.50 | 180 |
| endpoint.workoutsWithViews.limit30 | 2059.04 | 2305.84 | 180 |
| endpoint.workoutSeries.dense | 39.31 | 46.00 | 60 |

| 重叠统计 | p50 | p95 | 样本 |
|---|---:|---:|---:|
| overlap.coldStats | 716.48 | 798.83 | 30 |
| overlap.warm | 3.96 | 6.19 | 300 |
| overlap.afterNoopReceipt | 706.01 | 841.01 | 30 |
| overlap.afterCommit | 725.26 | 804.13 | 60 |

