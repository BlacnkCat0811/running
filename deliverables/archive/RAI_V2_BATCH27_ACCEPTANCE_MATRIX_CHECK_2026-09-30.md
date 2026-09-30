# RAI V2 批次 27 实施记录 —— §16.1 验收矩阵从"断言"变成"可执行判据"

日期：2026-09-30
对象方案：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` §16.1 / §17.1
上一份记录：`deliverables/archive/RAI_V2_BATCH26_REBASE_REVIEW_2026-09-30.md`

## 0. 结论

状态文档此前写着"§16.1 的 53 条验收里 **52 条有行为覆盖**"。本批实测发现：

1. **矩阵不是 53 条，是 54 条。** R1 修订加了 R06 / F11–F15 / B03 / B04 / I02 / T03 共 10 条，
   总数从 44 变成 54，而节标题里的数字没跟着改。
2. **"有行为覆盖"这个说法无法机械复核。** 按 ID 在测试里被引用的只有 **19 / 54**。
   但"没引用"与"没覆盖"是两件不同的事 —— 光看这个数字区分不了，
   所以"52 条有覆盖"既不能被证实也不能被否证，它只是一个断言。

本批把它换成**三态可执行判据**，并把 30 条**本来就已被测试覆盖、只是没按 ID 引用**的用例补上引用。

## 1. 判据

`scripts/check-acceptance-matrix.mts`（`npm run check:acceptance-matrix`，已接进 pre-commit）：

| 状态 | 含义 | 结果 |
|---|---|---|
| `cited` | 测试里按 ID 引用（`\bID\b`，机械可查） | **49** |
| `declared-gap` | 未被引用，但在脚本的 `KNOWN_GAPS` 里**逐条写明缺哪一半** | **5** |
| `missing` | 既未引用也未声明 | **0**（非 0 ⇒ 退出码 1） |

矩阵从方案文档的 `### 16.1` 段解析，**只取正文**，不取附录 B 的证据索引（E01–E34）；
解析不到就报错退出，避免表格格式一变就静默通过。

**它拦得住什么**：新增一条 §16.1 验收用例而不写测试、也不写缺哪一半 ⇒ 提交被拒。
`KNOWN_GAPS` 里若出现"暂未覆盖"这类空泛措辞，评审时应当直接打回 —— 每一条都必须答出
"哪一半有测试、缺的是哪一半"。

另有**过期声明**检查：`KNOWN_GAPS` 里的 ID 若后来被引用（或已不在矩阵中），
检查会以 🟡 报出并要求删除，防止这份清单变成永久豁免。

## 2. 补引用（19 → 49）

沿用仓库既有的前缀约定（`D03: …`、`L04: …`），给 30 条**已确认覆盖**的用例加上 ID 前缀：

| ID | 落点 |
|---|---|
| B01 / B03 | `packages/scoring/test/baseline-v2.test.ts` |
| F10 | `packages/scoring/test/negative-confirmation.test.ts` |
| F11 | `packages/model-eval/test/ablation-report-contract.test.ts` |
| F12 | `packages/scoring/test/stratum-comparability.test.ts` |
| F14 / F15 | `packages/scoring/test/confidence-and-gating.test.ts` |
| D01 / D02 | `packages/durability/test/durability.test.ts` |
| L01 / L02 / L03 / R04 | `packages/training-load/test/training-load.test.ts` |
| Z01 / Z03 | `packages/training-zones/test/training-zones.test.ts` |
| Z02 | `packages/physiology/test/observed-threshold.test.ts` |
| P01 | `packages/physiology/test/physiology.test.ts` |
| P03 / M03 | `packages/application/test/prediction-data.test.ts` / `prediction-walk-forward-cli.test.ts` |
| P05 | `packages/application/test/prediction-report.test.ts` |
| M01 | `packages/prediction-inference/test/prediction-inference.test.ts` |
| M02 / M04 | `packages/application/test/prediction-model-service.test.ts` / `packages/model-eval/test/model-eval.test.ts` |
| I01 | `packages/model-eval/test/model-eval.test.ts` |
| S01 | `packages/storage-sqlite/test/model-release-v2.test.ts` |
| S02 | `packages/storage-sqlite/test/model-transition-gate.test.ts` |
| S04 | `packages/storage-sqlite/test/superseded-run-prune.test.ts` |
| R02 | `packages/readiness/test/dated-readiness.test.ts` |
| R03 | `apps/api/test/readiness-delegation.test.ts` |
| T03 | `packages/application/test/label-funnel.test.ts` |

**只改标题前缀，不改任何断言。** 这一点有独立证据：全量用例数与通过数**完全不变**
（1086 / 1068 pass / 0 fail / 18 skipped，与批次 26 相同）。

### 一条纪律：引用必须与用例要求的断言相符

加 ID 前缀很容易变成装饰。本批的做法是：**先读用例标题、必要时读断言**，
确认它断言的正是矩阵那一行要求的东西，才加前缀。举两个因此**没有**加的例子：

- **F02**（Readiness strained ⇒ Coach 可降阶**且** Fitness 不变）：两个半场各有测试，
  但没有一条同时断言两半。只在其中一条上加 F02 会让读者以为跨域组合被钉住了 —— 所以列入缺口。
- **P04**（Preparation + Durability 同源信息不重复扣罚）：`durability.test.ts` 拒绝同一比赛的
  第二次全额声明，那是 race-evidence 预算，不是 P04 要求的重复扣罚路径 —— 所以列入缺口。

## 3. 五个声明缺口（`KNOWN_GAPS`）

| ID | 缺的是什么 |
|---|---|
| **F08** | 快速下坡/速度尖峰。**没有覆盖**，且是刻意的：要挡住它需要**新增检测器政策**，阈值必须先独立回放（状态文档 §五-3） |
| **F02** | 「Fitness 不变」与「Readiness→Coach 降阶」各有测试，但**没有一条同时断言两半** |
| **P02** | 环境去偏差的**单层**行为有测试；「同一历史环境被两层各去一次」的 ledger 断言没有 —— 当前只有 N0 identity adapter，没有第二层可重复去偏差的路径 |
| **P04** | race-evidence 单次预算有测试；「Preparation 与 Durability 不重复扣罚」要等 durability 数值罚分**启用后**才有可断言的路径 |
| **F13** | 「缺天气不冻结负学习」一半有测试；「报分层接受率/检测延迟」一半由消融**报告**承担，不是测试 |

## 4. 突变验证

删掉一条引用（B01）⇒ `cited 48 / missing 1`、🟡/🔴 逐条报出、**退出码 1**；恢复 ⇒ 退出码 0。
即这个检查真的会因为"少了一条可追溯的覆盖"而拦下提交。

## 5. 变更清单

| 文件 | 改动 |
|---|---|
| `scripts/check-acceptance-matrix.mts` | 新增（三态判据 + 过期声明检查） |
| `.githooks/pre-commit` | 新增一段（每次提交都跑，约 0.3 s） |
| `package.json` | `check:acceptance-matrix` + `pre` 钩子 |
| 14 个测试文件 | 仅加 ID 标题前缀（30 条），断言零改动 |
| `deliverables/RAI_V2_STATUS_2026-09-30.md` | §一 与 §三 的 53/52 断言换成可执行判据 |

## 6. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| node 侧全量 | **EXIT=0** = **1086 tests / 1068 pass / 0 fail / 18 skipped**（与批次 26 相同 ⇒ 标题改动未影响任何断言） |
| web 侧全量 | **EXIT=0** = 18 文件 / 111 tests |
| Python | **EXIT=0** = 26 passed |
| `npm run check:acceptance-matrix` | **EXIT=0** = 54 条 / cited 49 / declared-gap 5 / missing 0 |
| `npm run check:doc-refs` | 越界 3 / 漂移 98 / 空行锚 7（未变） |

## 7. 复现命令

```bash
cd D:\running
npm run check:acceptance-matrix
node --import tsx --test "packages/*/test/*.test.ts" "apps/api/test/*.test.ts"
```
