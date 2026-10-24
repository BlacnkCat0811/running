# 阶段 6 统计摘要（自动生成）

- 输入：`/Users/ta/rai-phase6-lab/phase6-dev-d1`
- 生成时间：2026-10-24T05:38:42.788Z
- 场景数：12

| 场景 | 请求 | 成功 | 成功率 | P50 ms | P95 ms | P99 ms | 超时 | 5xx | oracle 失败 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S01 | 3 | 3 | 100.00% | 84.5 | 176.2 | insufficient_samples | 0 | 0 | 0 |
| S02 | 8 | 8 | 100.00% | 32.4 | 150.4 | insufficient_samples | 0 | 0 | 0 |
| S03 | 24 | 24 | 100.00% | 78.8 | 982.8 | insufficient_samples | 0 | 0 | 0 |
| S04 | 4 | 4 | 100.00% | 16.8 | 79.0 | insufficient_samples | 0 | 0 | 0 |
| S05 | 190 | 190 | 100.00% | 4.3 | 42.5 | insufficient_samples | 0 | 0 | 0 |
| S06 | 24 | 24 | 100.00% | 9.2 | 95.0 | insufficient_samples | 0 | 0 | 0 |
| S07 | 20 | 20 | 100.00% | 6.9 | 135.7 | insufficient_samples | 0 | 0 | 0 |
| S08 | 180 | 179 | 99.44% | 4.5 | 98.5 | insufficient_samples | 0 | 1 | 0 |
| S09 | 77 | 77 | 100.00% | 12.4 | 98.8 | insufficient_samples | 0 | 0 | 0 |
| S12 | 4 | 4 | 100.00% | 80.0 | 86.3 | insufficient_samples | 0 | 0 | 0 |
| S13 | 60 | 60 | 100.00% | 50.9 | 264.4 | insufficient_samples | 0 | 0 | 0 |
| S14 | 310 | 310 | 100.00% | 6.2 | 16365.0 | insufficient_samples | 0 | 16 | 0 |

## 说明

- P99 仅在单组成功样本 ≥ 10,000 时发布；否则显示 insufficient_samples。
- 分位数为 nearest-rank，未平均不同运行。
- DEV 的 macOS RSS 采样不是 CLOUD cgroup 内存峰值；cgroup 列为空表示未测。

