# 阶段 2 热读窗口裁决复核（2026-10-22）

本轮只修改验收工具，不改变既定性能门槛，也不改变上一轮阶段 3 准入结论。原始
JSON 证据保持原样；本文件记录旧证据的只读复核结果和新格式说明。

## 1. 问题确认

| 问题 | 确认结果 |
|---|---|
| 比较器直接信任汇总 `p95` | 确认。`phase2-series-hot-compare.mjs` 与 `phase2-series-cache-compare.mjs` 的热读分支都使用 `next.p95 - base.p95`，从不读取 `samples[].ms`；把 200 个样本改成 1000 ms 并保留旧 `p95` 可以绕过性能门槛。 |
| `recent` / `oldest` 命名颠倒 | 确认。`phase2-series-cache-bench.mjs` 的 SQL 按 `anchor_start_at, id` 升序，`all[0]` 是最老训练却命名为 `recent`，`all.at(-1)` 是最新训练却命名为 `oldest`。五个窗口覆盖与性能判断不受影响，但名称和报告阅读会误导。 |

## 2. 修改后的裁决规则

- 共享模块：`scripts/phase2-series-hot-verdict.mjs`，两个比较入口共用。
- 每个窗口每侧必须恰好 200 个正式样本；每个 `samples[].ms` 必须是有限、非负的数字。缺失、字符串、`null`、负数、非有限值直接使证据失败，不做过滤、不补零、不继续计算。
- P95 固定为最近秩法：`sorted[ceil(N × 0.95) − 1]`；200 个样本取第 190 个值。
- 重算并核对 `p50/p95/min/max/mean`；汇总字段允许 `0.000001 ms` 的浮点误差。该容差只用于汇总一致性，不参与性能门槛。
- 性能裁决使用重算 P95：`增量 = 候选重算 P95 − 基线重算 P95`，`允许增量 = max(基线重算 P95 × 10%, 20 ms)`。
- 选窗元数据不只比较“两侧相同”：按统一的 `readableSessions` 用
  `expectedWindowIndex(name, N)` 计算 `oldest/p25/p50/p75/recent` 的期望下标，并校验
  下标是否在 `[0, N-1]` 内。两侧同时把 `recent` 写成 0、`oldest` 写成 `N-1`，
  或写成 999，都会报 `hot_window_index_mismatch`。
- 同一侧五个窗口的 `readableSessions` 必须一致，按 `oldest → p25 → p50 → p75 → recent`
  的 `startedAt` 必须非降序（相同开始时按训练 ID 升序）；每个窗口必须满足
  `startedAt <= endedAt`。违反时分别报 `hot_window_timeline` / `hot_window_time_range`。
- 证据无效（样本数/耗时/状态/身份/内容/正文/选窗元数据不一致或汇总不一致）时，窗口 `performance` 为 `not_evaluable`、`pass` 为 `null`，总裁决失败并以非零码退出；顶层同时输出 `windowTimelineVerified` 和 `windowMappingVerified`。

## 3. 旧证据只读复核

命令（两个入口的 hot 分支使用同一夹具）：

```text
node scripts/phase2-series-hot-compare.mjs \
  --baseline <baseline.json> --candidate <candidate.json> --dataset D2|D3 \
  --json <absolute-out> --allow-legacy-window-mapping

node scripts/phase2-series-cache-compare.mjs \
  --baseline <baseline.json> --candidate <candidate.json> --dataset D2|D3 \
  --json <absolute-out> --hot-only --allow-legacy-window-mapping
```

`--allow-legacy-window-mapping` 只用于旧 JSON：旧证据没有 `window` 选窗元数据，
复核结果会明确写 `windowMappingVerified=false` 和 5 条
`hot_window_mapping_unverified` 警告，不会把“名称未验证”伪装成已验证。

本轮复核的正式有效证据：

| 数据集 | 文件对 | 结果 |
|---|---|---|
| D2 | `http-b-baseline-d2-hot-fixed.json` / `http-b-candidate-d2-hot-fixed.json` | 五窗口均 200 样本，声明 P95 与重算值逐项一致，增量均 ≤ max(10%,20 ms)，正文哈希一致 |
| D3 | `http-b-baseline-d3-hot-fixed2.json` / `http-b-candidate-d3-hot-fixed2.json` | 同上；D3 基线与候选均 300 次预热 |

按实际训练时间修正名称后（旧 JSON 字段名不变，仅解释名称）：

| 数据集 | 实际 oldest | 实际 recent |
|---|---|---|
| D2 | `s0`：64.5 → 67.9 ms | `s998`：16.2 → 20.3 ms |
| D3 | `s0`：49.0 → 51.6 ms | `s4998`：17.2 → 21.4 ms |

D2/D3 的 `p25/p50/p75` 训练分别为 `s249/s498/s748` 与 `s1249/s2498/s3748`，名称和数值不变。旧报告中的 `recent`/`oldest` 两列应以上表为准；原始 JSON、门槛和准入结论均不变。

## 4. 新证据格式

基准脚本现在输出 `windowSelection` 与每个窗口的 `window` 元数据：

```json
{
  "windowSelection": {
    "version": "phase2-series-window-selection-v1",
    "orderBy": "anchor_start_at ascending, id ascending",
    "quantileMethod": "floor((N-1) * ratio) over readable sessions; inclusive endpoints",
    "quantileBasis": "readable training count, not calendar-time span",
    "readableSessions": 990
  },
  "hotWindows": {
    "oldest": {
      "window": {
        "selectionVersion": "phase2-series-window-selection-v1",
        "name": "oldest",
        "trainingSessionId": "s0",
        "startedAt": "2025-01-01T00:00:00.000Z",
        "endedAt": "2025-01-01T00:45:00.000Z",
        "indexFromOldest": 0,
        "readableSessions": 990
      }
    }
  }
}
```

（上面的时间/ID 是结构示例，不是本轮新测量。）新比较器默认要求基线与候选的
`selectionVersion`、同窗口训练 ID、开始时间、结束时间、`indexFromOldest` 与
`readableSessions` 全部一致；缺失或不兼容直接拒绝比较。新格式证据尚未重测，
待下一轮在隔离副本上按既有预热次数、每窗口 200 个正式样本和原性能门槛生成。

## 5. 本机选窗抽查与限制

用本机 `var/rai.sqlite` 的 268 条可读训练执行纯选窗函数：`recent` 为
`2026-08-25T12:31:25.000Z`（下标 267），`oldest` 为 `2019-12-13T12:48:07.000Z`
（下标 0），`p25/p50/p75` 分别落在 2024-06-11、2024-09-27、2025-01-08，
方向正确。该库是待迁移快照，真实 API 启动因 pending migrations 退出 78，因此
本轮没有生成新的性能测量证据；这不影响纯夹具、旧证据复核和代码交付。

## 6. 工具版本与回归记录

- 本轮验收工具：Node `v24.21.0` / tsx `v4.23.0` / SQLite `3.53.4`，已写入重新生成的 `source-manifest.json`。
- 目标测试：`apps/api/test/phase2-series-hot-verdict.test.ts` + `apps/api/test/phase2-series-window-selection.test.mjs`，**13/13 通过**；其中包含“两侧同时把 recent/oldest 写反、下标 999、结束早于开始、时间顺序颠倒、总数不一致”的失败夹具。
- 全量回归：`RAI_TEST_CONCURRENCY=2 node scripts/run-tests.mjs`，2,297 项测试、2,282 通过、13 跳过、2 个宿主环境失败（缺少 npm；ONNX 原生库签名无效），日志见 `evidence/full-test-tool-v2.log`。
- 静态检查：两套 `tsc`、`check:docs`、`check:acceptance-matrix`、包边界与单写者门禁均通过。
