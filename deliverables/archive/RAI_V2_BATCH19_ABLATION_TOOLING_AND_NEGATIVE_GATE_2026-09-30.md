# RAI V2 批次 19 实施记录 —— §6.1 消融报告工具修复与 §6.9-7 发布阻断判据

日期：2026-09-30
对象方案：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` §6.1 / §6.9-7
上一份记录：`deliverables/archive/RAI_V2_BATCH18_ACCEPTANCE_MATRIX_2026-09-30.md`

## 0. 结论

1. 🔴 **`scripts/ablation-ca-weights.mts` 自 `017bf95` 起根本跑不起来** —— 一行 `import` 被插到了
   `#!` 之前，esbuild 直接报 `Syntax error "!"`。也就是说，**§6.1 规定的"权重 PR 必须随附的报告"
   在提交里已经无法生成**，而 `deliverables/CA_WEIGHT_ABLATION.json` 是那次改动**之前**的产物。
   本轮修好并跑通。
2. §6.9-7 的发布阻断判据从"留给读者自己看数字"变成**报告里的显式字段**，并有单元测试。
3. 跑通之后暴露出一个**方案自己预告过的风险**：全部 6 个候选都是
   **有 21–59 次合格负机会、一次都没接受**。按 §6.9-7，这个门控版本**不得发布**。

## 1. 修的是什么（先证明它坏了）

```text
$ node --import tsx scripts/ablation-ca-weights.mts --database var/rai.sqlite
Error [TransformError]: Transform failed with 1 error:
scripts/ablation-ca-weights.ts:2:1: ERROR: Syntax error "!"
```

`git blame` 指向 `017bf95`（"feat(core): V2 算法包、存储迁移 v24 与应用层装配"）：
那一版在文件顶部插入了 `import { decodeStoredFeature } from "@rai/features";`，
于是 `#!/usr/bin/env node` 掉到了第 2 行 —— 对 esbuild 来说它不再是 shebang，而是一个非法的 `!`。

**修法**：`#!` 回到第 1 行；`@rai/features` 的 import 并入下方的 import 组。
修好后同一命令 **EXIT=0，620 ms**（只读）。

**为什么之前没人发现**：这个脚本没有被 `package.json` 引用，也没有被任何测试调用，
只在 `README.md` 与交付文档里被提及。**"文档里写了"不等于"跑得起来"。**
本轮同时把它接进 npm：

```json
"predata:ablation-ca-weights": "npm run check:node",
"data:ablation-ca-weights": "tsx scripts/ablation-ca-weights.mts",
```

## 2. §6.9-7：把"必须阻断发布"从注释变成判据

文档原文：**"有充分合格负机会却长期 0 接受 … 必须阻止该门控版本发布并复查/放宽非必要门槛；
不能用'更保守'作为永久解释。"**

新增 `packages/model-eval` 的 `negativeLearningReleaseBlockers(candidates)`：

| 状态 | 条件 | 是否阻断 |
|---|---|---|
| `no_opportunity` | 负机会 = 0 | 否，**但必须作为独立状态被报告** —— 把"没有机会"读成"通过"，是这条规则最容易被绕过的方式（覆盖不足的库会安静拿到绿灯） |
| `never_accepted` | 机会 > 0 且接受 = 0 | **是**（`code: "negative_learning_never_accepted"`） |
| `accepted` | 接受 ≥ 1 | 否 |

**刻意没有引入"负接受率必须大于 X%"**：§6.9-6 明确说"分布还未知时不要捏造一个全局门槛"。
判据只用文档自己的措辞（机会 > 0 且接受 = 0）。非整数/负数/接受数大于机会数一律抛错，
而不是算出一个看起来正常的比率。

消融报告的顶层现在多出：

```text
findings:        [{ candidate, status, negativeOpportunities, negativeAccepted }, …]
releaseBlockers: [{ candidate, code, negativeOpportunities }, …]
negativeLearningNote: §6.9-7 的措辞与"no_opportunity ≠ 通过"
```

## 3. 跑通之后看到的东西（本机只读，2026-09-30）

```text
modelConfigVersion = rai-model-config-v12      featureCount = 257
labeledOutcomeCount = 0                        accuracyComparison = not_evaluable

candidate         正机会/接受     负机会/接受    CA 饱和率
v1_current        32/119          0/42          0
v2a               32/135          0/26          0
v2b               32/136          0/25          0
drop_pace         31/133          0/28          0
drop_efficiency   34/102          0/59          0
drop_stability    32/140          0/21          0
```

两点必须分开说：

1. **`labeledOutcomeCount = 0` ⇒ 精度排名一律 `not_evaluable`。** 这六个候选之间**没有任何**
   "谁更准"的结论；上表是**行为**消融，不是精度比较。
2. 🔴 **全部 6 个候选都是 `never_accepted`（负机会 21–59，接受 0）。**
   按 §6.9-7 这**不是**"更保守"，而是"无法学习真实退步的系统性偏置"，必须阻断该门控版本发布。

这**不等于**已经证明门控有 bug：本机特征仍是 V3 存量、`comparabilityHistoryMode` 默认 `legacy`，
且 §6.9 要求的**预注册**（每组最少机会数、可接受检测延迟、最大误判下降率）**尚未配置**，
所以"0 接受"目前既可能是门槛过严，也可能是这份数据里根本没有"真实且可比的退步"。
**这正是报告必须把它标成阻断项、而不是标成通过的原因。**

下一步（不在本批范围，需要先预注册再评估）：
按 §6.9-5 做候选 grid 回放（reliability .60/.70/.75 × comparability .80/.85/.90 × K=1/2/3），
逐层报告机会数/接受数/拒绝原因，并在**评估前**冻结每组最少机会数与最大检测延迟。

## 4. 变更清单

| 文件 | 改动 |
|---|---|
| `scripts/ablation-ca-weights.mts` | 修 shebang 位置与 import 顺序；接入 `negativeLearningReleaseBlockers`；报告新增 `findings` / `releaseBlockers` / `negativeLearningNote` |
| `packages/model-eval/src/index.ts` | 新增 `NegativeLearningCensusEntry` / `NegativeLearningStatus` / `NegativeLearningFinding` / `NegativeLearningReleaseBlocker` 与 `negativeLearningReleaseBlockers` |
| `packages/model-eval/test/negative-learning-blockers.test.ts` | 新增 5 条用例 |
| `package.json` | 新增 `data:ablation-ca-weights` 与其 `pre` 钩子 |
| `deliverables/CA_WEIGHT_ABLATION.json` | **重新生成**：`rai-model-config-v10 → v12`、features `268 → 257`、含新的 `releaseBlockers` |

> 旧产物里连 `labeledOutcomeCount` 字段都没有（本次实测该字段为 `undefined`），
> 说明它确实是很早以前的快照。重新生成的口径与当前源码一致。

## 5. 突变验证

| # | 突变 | 结果 |
|---|---|---|
| 1 | `never_accepted` 不再推入 `releaseBlockers` | 🔴 用例 1、4 转红 |
| 2 | `negativeOpportunities === 0` 判成 `"accepted"`（即"没机会 = 通过"） | 🔴 用例 3 转红 |

两条都实际执行、观察、还原（`git diff` 已确认还原干净）。

## 6. 门禁（本轮，独占跑）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| node 侧全量 | **EXIT=0** = **1053 tests / 1035 pass / 0 fail / 18 skipped**（批次 18 后为 1048/1030，本轮 +5） |
| web 侧全量 | **EXIT=0** = 18 文件 / 111 tests（未变） |
| Python | **EXIT=0** = 26 passed（未变） |
| `npm run data:ablation-ca-weights` | **EXIT=0**（修复前为转换失败） |

## 7. 复现命令

```bash
cd D:\running
npm run data:ablation-ca-weights -- --database var/rai.sqlite --out deliverables/CA_WEIGHT_ABLATION.json
node --import tsx --test packages/model-eval/test/negative-learning-blockers.test.ts
# 只读；不写数据库，不激活模型
```
