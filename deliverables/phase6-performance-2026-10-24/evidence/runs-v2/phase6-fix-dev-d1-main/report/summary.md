# 阶段 6 统计摘要（自动生成）

- 输入：`/Users/ta/rai-phase6-lab-fix/run-final3-main-001`
- 生成时间：2026-10-24T08:08:58.885Z
- 场景数：11

| 场景 | 请求 | 成功 | 成功率 | P50 ms | P95 ms | P99 ms | 超时 | 5xx | oracle 失败 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S01 | 3 | 3 | 100.00% | 26.5 | 95.6 | insufficient_samples | 0 | 0 | 0 |
| S02 | 8 | 7 | 87.50% | 22.9 | 83.1 | insufficient_samples | 0 | 0 | 0 |
| S03 | 24 | 24 | 100.00% | 51.7 | 282.4 | insufficient_samples | 0 | 0 | 0 |
| S04 | 4 | 4 | 100.00% | 9.1 | 104.2 | insufficient_samples | 0 | 0 | 0 |
| S05 | 175 | 175 | 100.00% | 4.4 | 25.3 | insufficient_samples | 0 | 0 | 0 |
| S06 | 23 | 23 | 100.00% | 7.3 | 97.8 | insufficient_samples | 0 | 0 | 0 |
| S07 | 17 | 17 | 100.00% | 7.5 | 109.3 | insufficient_samples | 0 | 0 | 0 |
| S08 | 160 | 156 | 97.50% | 5.1 | 77.4 | insufficient_samples | 0 | 0 | 0 |
| S09 | 65 | 65 | 100.00% | 12.8 | 35.6 | insufficient_samples | 0 | 0 | 0 |
| S12 | 4 | 4 | 100.00% | 60.0 | 79.1 | insufficient_samples | 0 | 0 | 0 |
| S14 | 254 | 238 | 93.70% | 5.9 | 15578.3 | insufficient_samples | 0 | 16 | 0 |

## 说明

- P99 仅在单组成功样本 ≥ 10,000 时发布；否则显示 insufficient_samples。
- 分位数为 nearest-rank，未平均不同运行。
- DEV 的 macOS RSS 采样不是 CLOUD cgroup 内存峰值；cgroup 列为空表示未测。

