# 阶段 6 统计摘要（自动生成）

- 输入：`/Users/ta/rai-phase6-lab/phase6-dev-d3`
- 生成时间：2026-10-24T05:38:42.510Z
- 场景数：4

| 场景 | 请求 | 成功 | 成功率 | P50 ms | P95 ms | P99 ms | 超时 | 5xx | oracle 失败 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S01 | 3 | 3 | 100.00% | 21.3 | 91.7 | insufficient_samples | 0 | 0 | 0 |
| S02 | 8 | 8 | 100.00% | 64.6 | 15700.3 | insufficient_samples | 0 | 0 | 0 |
| S03 | 24 | 24 | 100.00% | 93.6 | 532.0 | insufficient_samples | 0 | 0 | 0 |
| S04 | 4 | 4 | 100.00% | 33.7 | 34669.2 | insufficient_samples | 0 | 0 | 0 |

## 说明

- P99 仅在单组成功样本 ≥ 10,000 时发布；否则显示 insufficient_samples。
- 分位数为 nearest-rank，未平均不同运行。
- DEV 的 macOS RSS 采样不是 CLOUD cgroup 内存峰值；cgroup 列为空表示未测。

