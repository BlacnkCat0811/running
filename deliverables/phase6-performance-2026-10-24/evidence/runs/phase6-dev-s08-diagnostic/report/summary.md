# 阶段 6 统计摘要（自动生成）

- 输入：`/Users/ta/rai-phase6-lab/phase6-dev-s08-diagnostic`
- 生成时间：2026-10-24T05:48:18.689Z
- 场景数：1

| 场景 | 请求 | 成功 | 成功率 | P50 ms | P95 ms | P99 ms | 超时 | 5xx | oracle 失败 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S08 | 267 | 266 | 99.63% | 4.8 | 42.9 | insufficient_samples | 0 | 1 | 0 |

## 说明

- P99 仅在单组成功样本 ≥ 10,000 时发布；否则显示 insufficient_samples。
- 分位数为 nearest-rank，未平均不同运行。
- DEV 的 macOS RSS 采样不是 CLOUD cgroup 内存峰值；cgroup 列为空表示未测。

