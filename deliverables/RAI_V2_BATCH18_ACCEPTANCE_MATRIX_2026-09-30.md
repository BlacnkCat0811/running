# RAI V2 批次 18 实施记录 —— §16.1 验收矩阵覆盖补齐

日期：2026-09-30
对象方案：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` §16.1
上一份记录：`deliverables/RAI_V2_BATCH17_CHALLENGERS_READINESS_EPOCH_LOAD_2026-09-30.md`

## 结论

本轮把 §16.1 的 53 条验收 ID **逐条对照了现有测试**，并补齐了其中 5 条**确实没有行为覆盖**的：
**F09、S03、F07、L04、C01（含 R01 的一半）**。
其余各条都能指到具名用例（见 §2 的对照表），**不再靠"我记得测过"**。

本轮没有改任何生产算法：新增的全部是测试，唯一的源码改动是三次突变验证后**逐字还原**（`git diff` 为空）。

## 1. 本轮新增的用例与它们的突变验证

| ID | 新文件 / 位置 | 断言要点 |
|---|---|---|
| **F09** | `packages/application/test/import-idempotency-and-checkpoint.test.ts` | 同一份导出导入两次：会话、特征、负荷各只算一次；再跑一次同样的全量重算，TA 逐位不变 |
| **S03** | 同上 | 同口径增量重算**确实会复用**（正对照：复用 5 / 重算 2），换 feature config 后**一条都不复用**且 `parent_feature_run_id` 为 null |
| **F07** | `packages/application/test/environment-does-not-freeze-learning.test.ts` | 只换环境上下文（`not_needed` vs `unavailable`）⇒ 投影出的评分输入逐位相同；两种状态下连续两次负残差**都被接受**且下调幅度相同 |
| **L04** | `packages/training-load/test/training-load.test.ts` | 序列从第一次观测日起，未知前史不落成 0；`acuteEwma = chronicEwma = 观测负荷`；当天只能判 `unknown`；**观测到的**休息日仍按 0 计入并衰减 |
| **C01 / R01** | `apps/api/test/mobile-coach-snapshot-parity.test.ts` | 原始读数入口与快照入口对同一证据给出**相同 tone 与相同理由码**（5 个病例）；快照里被夹带的原始读数在入口处被清空；没有可评估恢复时**不自动红**、缺失被显式命名、且不写成"恢复良好" |

### 突变验证（每条都实跑、观察、还原）

| # | 突变 | 结果 |
|---|---|---|
| 1 | `reuseFeaturePrefix` 不再比较 feature config | 🔴 S03 用例转红 |
| 2 | 解析器：`matches = []`（不再认领既有训练） | 🔴 F09 用例转红 —— 以 `UNIQUE constraint failed: training_sessions.id` 的形式 |
| 3 | `projectFeatureV4`：环境未知时把配速填成默认 3.0 | 🔴 F07 两条全红 |
| 4 | EWMA 播种改成补 0（`acute === null ? 0 : …`） | 🔴 L04 转红，另有 3 条既有用例同时转红 |
| 5 | `decideVerdictFromSnapshots` 把 `hrvLow` 与 `rhrLow` 接反 | 🔴 C01 转红（**但第一版用例集没有转红，见下**） |

### 🔴 本轮最重要的一条：一个"没牙齿"的断言

C01 的第一版病例集只有 `healthy` 与 `poor（睡眠/HRV/RHR 三者同时低）`。
把 `hrvLow` 与 `rhrLow` **接反**的突变**照样全绿** —— 因为三者同时低时，交换两个通道不改变任何结论。
这正是本项目反复点名的"跑绿 ≠ 断言有效"。

修法不是加一句注释，而是**把单信号病例补进夹具**（sleep-only / hrv-only / rhr-only），
并额外加一条**夹具守卫**断言三个病例各自只点亮一个通道
（`["true,false,false","false,true,false","false,false,true"]`）。
补完之后同一个突变立刻转红。

过程中还纠正了一个**过强的夹具假设**：最初把守卫写成"每个单信号病例都必须与健康日不同色"，
还原突变后它自己红了 —— 因为**单独一个 RHR 升高按设计就不升级**
（`packages/readiness/test/readiness.test.ts` 已写明 "a lone raised resting heart rate … does not by itself escalate"）。
断言改成检查信号标记而不是最终 tone。

## 2. §16.1 逐条对照（本轮核对结果）

| ID | 覆盖位置 |
|---|---|
| F01 | `packages/application/test/recovery-isolation-e2e.test.ts`（4 条，全链路） |
| F02 | `apps/api/test/mobile-coach.test.ts`「verdict is green…」「poor sleep with HRV and RHR together is red」；Fitness 不变由 F01 覆盖 |
| F03–F06 | `packages/scoring/test/learning-and-coverage.test.ts` |
| F07 | **本轮新增**（见 §1） |
| F08 | 🟡 **部分**：质量门控**双向**成立已由 `stratum-comparability.test.ts`「refuses learning in both directions」与 `confidence-and-gating.test.ts` §6.9 覆盖；**没有 GPS 尖峰/下坡检测器** —— 那是新增政策，本方案未授权 |
| F09 | **本轮新增** |
| F10 | `packages/scoring/test/negative-confirmation.test.ts`（两条：第二次负残差必须下调；100→收敛不得越过观测） |
| F11 | 🟡 报告产物 `deliverables/CA_WEIGHT_ABLATION.json` + `scripts/ablation-ca-weights.mts` 存在；**无单元断言** |
| F12 | `packages/scoring/test/stratum-comparability.test.ts` |
| F13 | 🟡 分层接受率在 `deliverables/RAI_V2_ABLATION_2026-09-29.json`；**无单元断言** |
| F14 / F15 | `packages/scoring/test/confidence-and-gating.test.ts`（§6.7 四条） |
| B01 | `packages/scoring/test/baseline-v2.test.ts`「adaptive baseline excludes future, same-session…」 |
| B02 | `packages/application/test/service.test.ts`（epoch 切换）+ `apps/web/test/ability-chart-epoch.test.tsx` |
| B03 | `packages/scoring/test/baseline-v2.test.ts`「rebase is a reviewed candidate, never an automatic epoch/TA change」 |
| B04 | `apps/web/test/ability-chart-epoch.test.tsx` + `apps/web/test/historical-model-review.test.tsx` |
| R01 | **本轮新增**（快照入口；无证据不自动红、缺失被命名） |
| R02 | `packages/readiness/test/dated-readiness.test.ts`「cannot wash stale sleep into today with fresh HRV」 |
| R03 | 同上「invalid/zero measurements and absent references cannot inflate coverage」 |
| R04 | 同上「streak is consecutive canonical local dates, not count of nonadjacent low nights」 |
| R05 | 🟡 跨夜/时区由 `health-export-parser/test/local-calendar.test.ts`、`contracts/test/timezone.test.ts` 覆盖；**午睡（`kind='main'` 之外的夜）无专测** |
| R06 | `apps/api/test/readiness-delegation.test.ts` + `packages/contracts/test/domain-snapshot-narrowing.test.ts` + `historical-model-review.test.tsx` 文案用例 |
| D01 | `packages/durability/test/durability.test.ts`「fixed 8-week denominator is preserved even when history is shorter」+「evidence level separates incomplete history from genuinely low volume」 |
| D02 | 同上「durability never produces a score without calibration」 |
| D03 | 🟡 `packages/features/test/v4.test.ts`「missing/interval data stays unknown」；**地形差异降低可比性无专测** |
| L01 / L02 | `packages/training-load/test/training-load.test.ts`「load vector passes compositeLoad through untouched（§9.6 golden parity）」「mechanical load stays null until a mapping is validated」 |
| L03 | 同上「assessLoad exposes exactly one basis, so three signals cannot each vote」 |
| L04 | **本轮新增** |
| Z01 | `packages/training-zones/test/training-zones.test.ts`「manual values take precedence only after their effective date」 |
| Z02 | `packages/physiology/test/observed-threshold.test.ts`（3 条） |
| Z03 | `packages/training-zones/test/training-zones.test.ts`「a brief divergence is not a standing conflict」 |
| P01 | `packages/physiology/test/physiology.test.ts`（Daniels golden 与往返） |
| P02 | `packages/normalization/test/normalization.test.ts`（条件账本：同对象同字段二次修正被拒） |
| P03 / P05 | `packages/application/test/prediction-data.test.ts`「V2 prediction modes isolate recovery and give an exactly reconstructible correction ledger」（未来比赛 `recoveryReadiness: null`；`pointCorrection: "none"`） |
| P04 | `packages/durability/test/durability.test.ts`「the shipped race-evidence ledger is valid and spends the single-race budget」 |
| M01 / M02 | `packages/prediction-inference/test/prediction-inference.test.ts`（manifest / ONNX 契约） |
| M03 / M04 | `packages/model-eval/test/model-eval.test.ts`（空数据全 null；三段切分事件身份） |
| I01 | 同上「empirical intervals are nested, independently evaluated and not individual guarantees」 |
| I02 | `apps/web/test/pages.test.tsx`「参考区间（非 P80/P90 保证）」 |
| T01 / T02 | `packages/application/test/prediction-model-service.test.ts`、`packages/model-eval/test/model-eval.test.ts`、`packages/readiness/test/dated-readiness.test.ts` |
| T03 | `packages/application/test/label-funnel.test.ts`（3 条：未确认/迟到确认/撤回、协议不符与 threshold-only、修订去重） |
| C01 | **本轮新增** |
| S01 | `packages/storage-sqlite/test/model-release-v2.test.ts`（原子发布、拒绝失败/陈旧/被改动的候选） |
| S02 | `packages/storage-sqlite/test/model-transition-gate.test.ts`（`not_evaluable` 不是失败态也不放行）+ `v24-migration.test.ts` |
| S03 | **本轮新增** |
| S04 | `packages/storage-sqlite/test/superseded-run-prune.test.ts`（保留活跃 run 与祖先链） |

**仍然空缺的三条**（都写明了原因，不是遗漏）：
F08 需要一个尚不存在的 GPS 尖峰/下坡检测器（新增政策，须独立回放后才可上线）；
F11 / F13 的证据是**报告产物**而非单元断言，把报告生成器接进 CI 是下一步；
R05 的午睡归属与 D03 的地形可比性各缺一条。

## 3. 门禁（本轮，独占跑）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| node 侧全量 | **EXIT=0** = **1048 tests / 1030 pass / 0 fail / 18 skipped**（批次 17 后为 1039/1021，本轮 +9） |
| web 侧全量 | **EXIT=0** = 18 文件 / 111 tests（未变） |
| Python（`pytest research/tests`） | **EXIT=0** = 26 passed（未变） |
| `npm run check:doc-refs` | 越界 3 / 漂移 **98** / 空行锚 7 |

> **漂移 98 不是本轮引入的。** 我把改动 stash 后在 HEAD 上重跑，得到**同样的 98**；
> 批次 17 记录里引用的 95 是 09-29 的时点值。差值的来源是批次 17 之前已提交的版本常量演进
> （`workout-feature-v3 → v4`、`feature-config-v8 → v11` 等），本批新增的用例文件不改动被引用文档的行号。
> 这个数字**没有被"修好"**，因为那需要改写一份历史基线文档或重建基线 —— 不属于本批范围。

计数口径同批次 17：node 侧必须用**带引号的 glob**交给 node 自己展开；
直接 `npm test` 在 Windows/cmd 下只跑到 498 条，那是环境问题不是回归。

## 4. 剩余 11 项工程缺口的最新状态

本批没有推进这 11 项（它们是实现工作，不是测试覆盖）：

| # | 项 | 状态 |
|---|---|---|
| 1 | V4 特征全链路 | 🟡 代码已是 V4；真实库仍是 V3，重建未做 |
| 2 | 版本/谱系落库分离 | ✅ |
| 3 | transition gate v2 + bundle 原子发布 | ✅ |
| 4 | assembler freshness 统一 | 🟡 到达时间已成可见事实 |
| 5 | rebase 发布流程与 epoch 分段曲线 | 🟡 曲线已分段；整套重建发布未做 |
| 6 | 环境 adapter 生产统一 | 🔴 **被数据阻塞**：本机温度/湿度可得率 **0%**（`deliverables/NORMALIZATION_COVERAGE.json`），N3 无法校准；§18.4 禁止自动接入天气服务 |
| 7 | 快照贯穿实际 API | 🟡 fitness / load / readiness 已有窄化与消费方 |
| 8 | 三方残差竞争同样本 | ✅ 批次 17 |
| 9 | 区间 calibration 持久化与选择器 | ✅ 只差"独立标签到位后跑一次真校准" |
| 10 | 跨领域 replay | 🟡 Fitness / Readiness / Load 有入口；Coach 未做 |
| 11 | 候选参数实证与真实退步验收 | ❌ 受真实标签约束（本地 0 条已确认比赛/测试） |

## 5. 复现命令

```bash
cd D:\running
npm run typecheck
node --import tsx --test "packages/*/test/*.test.ts" "apps/api/test/*.test.ts"
npm run test -w @rai/web
research\.venv\Scripts\python.exe -m pytest research/tests -q

# 本批新增
node --import tsx --test packages/application/test/import-idempotency-and-checkpoint.test.ts
node --import tsx --test packages/application/test/environment-does-not-freeze-learning.test.ts
node --import tsx --test apps/api/test/mobile-coach-snapshot-parity.test.ts
node --import tsx --test packages/training-load/test/training-load.test.ts
```
