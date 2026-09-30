# RAI V2 批次 23 实施记录 —— 关闭 §16.1 最后两个部分项（R05 / D03）

日期：2026-09-30
对象方案：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` §16.1 R05 / D03
上一份记录：`deliverables/archive/RAI_V2_BATCH22_ABLATION_REPORT_CONTRACT_2026-09-30.md`

## 0. 结论

批次 18 逐条核对 §16.1 时留下两个"部分覆盖"（R05、D03）。本批把这两条补成**可执行断言**，
并顺手确认了一件容易误判的事：**§10.2 的分区来源细化其实已经实现**（见 §3）。

至此 §16.1 的 53 条里，**只有 F08 一条没有行为覆盖**，而它需要一个新的检测器政策（见 §5）。
本轮未改任何生产算法：两次突变验证后均按备份逐字还原。

## 1. R05：主夜归属与未来时间排除

**现状证据**：`canonical_nights.kind ∈ {main, nap}`，且 `main` 在
`(wake_date, timezone_identifier)` 上唯一（`idx_canonical_nights_main`，partial unique index）；
装配器 `loadDatedReadiness` 的夜查询带 `kind='main'`。**schema 与消费端各守一半。**

新增 `packages/application/test/readiness-main-night.test.ts`（3 条）：

| 场景 | 断言 |
|---|---|
| 今天**只有午睡** | `signals.sleep.value === null`、`quality === "missing"`、assessment 不得是 `no_low_signal` —— 午睡不能充当主夜 |
| 主夜 + 一个**长得多**的午睡（600 min） | 今天的睡眠值、比值与"没有午睡时"**逐位相同** —— 午睡不得把主夜"洗"成更大的值 |
| 存在**明天**的主夜（wake_at 晚于 asOf） | 今天读到的仍是主夜 300 min；`localDate` 仍是今天；`sleepStreak` 不受影响 |

这三点分别对应"未知不得被另一条通道读成有个值""同一事实不得被两条通道重复计入""未来时间必须排除"。

**突变验证**：把装配器夜查询里的 `kind='main'` 去掉 ⇒ 用例 1、2 转红（3 条中 2 条）。
⇒ 断言确实在守那半条防线，而不是在复述 schema 的约束。

## 2. D03：后段变慢不得变成"耐力下降"结论

**现状证据**：`DurabilityInput` **没有地形或可比性输入**；`assessDurability` 恒返回
`durabilityScore: null` 且 `reasonCodes` 恒含 `penalty_withheld_pending_calibration`。

所以 D03 的实质要求（"只能降低可比性，不能给耐力下降结论"）在本包里是**由构造保证**的 ——
但没有测试钉住它，而"没有测试钉住的构造保证"在重构里最先消失。

新增 1 条用例（`packages/durability/test/durability.test.ts`）：
同一暴露量下，`lateRunStability = 0.95` 与 `0.2` 必须给出**同一种结论形状** ——
都无分数、证据等级相同、理由码完全相同、理由码里不出现任何 `decline/decreas/degrad/endurance_loss`
字样；原始观测如实保留；越界值抛错而不是被夹到合法区间。

**突变验证**：让 `evidenceLevel` 受 `lateRunStability < 0.5` 影响 ⇒ 该用例转红。
⇒ 断言真的在守"证据等级只由暴露量决定"。

## 3. 顺带确认：§10.2 已经实现

核对 §10.2 时发现它**不是缺口**，不需要新增代码：

- `DailyZoneProfile.evidence.valueSources` 分别给出
  `restingHeartRate` / `maximumHeartRate` / `thresholdPace` / `thresholdEvidence` 四项来源，
  与粗粒度的 `heartRateSource` / `paceSource` 并存 —— 正是 §10.2 "不能以统一 `heartRateSource=automatic`
  掩盖 RHR/MaxHR 来源不同"要求的实现；
- 手工设置带 `revision` 与 `effectiveFromLocalDate`（`TrainingZoneProfileSettings`）；
- §10.4 的 `ZoneCoherence` 用**显式语义映射**（并注明两条梯子不同构，禁止下标相减）。

记录在此，避免下一轮把它当成待办再"实现"一遍。

## 4. 变更清单

| 文件 | 改动 |
|---|---|
| `packages/application/test/readiness-main-night.test.ts` | 新增（3 条，R05） |
| `packages/durability/test/durability.test.ts` | 新增 1 条（D03） |

**生产源码零改动**（两次突变验证后按 `var/*.bak` 备份逐字还原，`git diff` 已确认）。

## 5. §16.1 剩余状态

对照批次 18 的逐条表，本批后只剩 **F08**（快速下坡/速度尖峰 ⇒ 不产生未经质量门控的正向 TA 跳升）
没有行为覆盖。它缺的不是测试而是**检测器本身**：

- 批次 21 的 grid 已经显示，本机数据上正向一侧同样被 `reliability` 门槛强约束
  （现行政策正向接受 32/135 ≈ 24%，降到 .70 后 85/118 ≈ 72%），
  所以"只防下降不防虚高"**不是当前可观测的失效模式**；
- 但一次 GPS 尖峰污染的**干净**训练仍会以高可靠性通过 —— 要挡住它必须新增一个速度合理性检测器；
- 那属于新增政策（阈值需要独立回放），按 §6.9-8「放宽/收紧都不得绕过硬质量闸门、且必须重新验证两侧」
  的纪律，本方案不为它编一个未经验证的阈值。

## 6. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| node 侧全量 | **EXIT=0** = **1068 tests / 1050 pass / 0 fail / 18 skipped**（批次 22 后为 1064/1046，本轮 +4） |
| web 侧全量 | **EXIT=0** = 18 文件 / 111 tests（未变） |
| Python | **EXIT=0** = 26 passed（未变） |

## 7. 复现命令

```bash
cd D:\running
node --import tsx --test packages/application/test/readiness-main-night.test.ts
node --import tsx --test packages/durability/test/durability.test.ts
```
