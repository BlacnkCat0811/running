# RAI V2 批次 22 实施记录 —— §6.1 消融报告的发布条件校验

日期：2026-09-30
对象方案：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` §6.1-1…5、§6.9-6、§6.9-7
上一份记录：`deliverables/RAI_V2_BATCH21_NEGATIVE_GATE_DIAGNOSIS_2026-09-30.md`

## 0. 结论

§6.1 把权重消融报告列为**发布条件**（"缺少上述工程报告则该权重 PR 不满足验收"），
但"报告必须包含什么、以及**不许**宣称什么"此前只写在文档里，评审时靠人记。

本批把它变成**可执行校验** `assertCaWeightAblationReport`，并让生成端在写文件之前先自检。
这直接回应批次 19 的教训：那份报告的工具曾经因为一行 `import` 被插到 `#!` 之前而
**完全跑不起来**，而 deliverables 里的产物是更早的快照 —— 谁都没发现。

## 1. 校验覆盖的条款

| 条款 | 校验内容 | 为什么它值得一条断言 |
|---|---|---|
| §6.1-1 | 候选数 ≥ 5、候选名唯一、`dimensionWeights` 存在 | 少比较几个候选，报告看起来一样完整 |
| §6.1-3 | 每个候选同时有 `scorableRate` 与 `saturationRate` | 只有数值差异、没有 coverage，就无法判断"是不是靠丢样本变好的" |
| §6.1-2 | `correlations`、`correlationsByStratum`、`stratumCensus` 必须存在；`normalizedCorrelations.status` **为不可评估时必须写出原因** | 留空会被读成"没必要做"，而不是"做不到" |
| §6.1-4 | 每个候选必须有 `positive/negativeCandidates`、`positive/negativeAccepted` | 双向接受率是防棘轮的唯一证据 |
| §6.1-5 | `labeledOutcomeCount === 0 ⇒ accuracyComparison === "not_evaluable"` | 无标签时给精度排名，等于把 V1 分数当"真值" |
| §6.9-7 | 每个候选必须有 `refusalReasons`；`findings`/`releaseBlockers` 必须存在 | 说不出卡在哪道门，就无法"复查/放宽非必要门槛" |
| §6.9-6 | `negativeGatePreregistration.status === "not_configured"` 时 `recommendation` 必须是 `not_evaluable` | 预注册未冻结却给出"用哪个阈值"，就是拿实验结果当验收标准 |
| 通用 | 计数必须是非负整数；比率必须是有限数或 `null` | `NaN` 一旦写成 `null` 或 0，就变成一个看起来正常的数字 |

**校验不重算任何门槛**：它只检查报告是否**如实**包含 §6.1 要求的部分、以及是否越界宣称结论。

## 2. 生成端接线

```ts
// scripts/ablation-ca-weights.mts
assertCaWeightAblationReport(report);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
```

自检在**写文件之前**：报告缺项时宁可不产出文件，也不产出一份"看起来完整、评审时才发现少东西"的产物。

## 3. 一个我自己犯的错误（如实记录）

做突变验证时，我在**未提交**的改动上执行了 `git checkout -- packages/model-eval/src/index.ts`，
把本轮新增的 `assertCaWeightAblationReport` 整个回滚掉了。发现后按原文重新写回，
并用 `typecheck`＋17 条 model-eval 用例＋脚本实跑确认恢复。

**教训**：`git checkout --` 只适合丢弃**已提交版本之上不再需要**的改动；
在验证突变时应当用**备份文件还原**（本批前几次用的就是 `Copy-Item` + `Move-Item`），
而不是让版本控制替我做还原。

## 4. 变更清单

| 文件 | 改动 |
|---|---|
| `packages/model-eval/src/index.ts` | 新增 `assertCaWeightAblationReport` |
| `packages/model-eval/test/ablation-report-contract.test.ts` | 新增 7 条用例 |
| `scripts/ablation-ca-weights.mts` | 写文件前调用自检 |
| `deliverables/CA_WEIGHT_ABLATION.json` | 重新生成（经自检） |

## 5. 突变验证

| # | 突变 | 结果 |
|---|---|---|
| 1 | 去掉"无标签不得宣称精度"这条 | 🔴 `accuracy cannot be claimed while there are no labeled outcomes` |
| 2 | 去掉"预注册未冻结不得给建议"这条 | 🔴 `an unfrozen pre-registration cannot produce a recommendation` |

两条都实际执行、观察、还原（还原方式见 §3）。

## 6. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| node 侧全量 | **EXIT=0** = **1064 tests / 1046 pass / 0 fail / 18 skipped**（批次 21 后为 1057/1039，本轮 +7） |
| web 侧全量 | **EXIT=0** = 18 文件 / 111 tests（未变） |
| Python | **EXIT=0** = 26 passed（未变） |
| `npm run data:ablation-ca-weights` | **EXIT=0**，且通过自检 |

## 7. 仍未做

- `assertCaWeightAblationReport` 只在**生成端**被调用；没有任何 CI 步骤会在 PR 时自动跑消融脚本
  （它需要数据库）。真正的"随权重 PR 提交报告"仍要靠流程约束，本批只保证**报告本身不能是残缺的**。
- §6.4 的 rebase 报告目前记录 `previousEpoch/candidateEpoch/referenceStartAt/calibrationEndAt`，
  文档列出的 `effectiveAt` 与 `rebaseReason` **未落库**。`effectiveAt` 可由 run 的 `evaluatedAt` 推出，
  `rebaseReason` 需要一个真正的来源（`reviewBaselineRebase` 的检查结论）才不算造字段 —— 留待后续。
- F08 的正向 GPS 尖峰守卫仍未实现（见批次 21 §3：本机数据显示正向一侧同样被强门控，
  新增尖峰检测器属于新政策，需独立回放）。

## 8. 复现命令

```bash
cd D:\running
npm run data:ablation-ca-weights -- --database var/rai.sqlite --out deliverables/CA_WEIGHT_ABLATION.json
node --import tsx --test packages/model-eval/test/ablation-report-contract.test.ts
node --import tsx --test packages/model-eval/test/negative-learning-blockers.test.ts
```
