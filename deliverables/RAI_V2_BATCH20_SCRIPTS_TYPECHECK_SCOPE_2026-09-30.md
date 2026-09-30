# RAI V2 批次 20 实施记录 —— 把 `scripts/` 纳入 typecheck，并修掉它暴露的 3 个类型谎言

日期：2026-09-30
上一份记录：`deliverables/RAI_V2_BATCH19_ABLATION_TOOLING_AND_NEGATIVE_GATE_2026-09-30.md`

## 0. 结论

批次 19 修好了"跑不起来"的消融脚本。本批回答的是**为什么它能坏掉还没人发现**：
`tsconfig.json` 的 `include` 只有 `packages/**` 与 `apps/**`，**`scripts/` 完全不在
`npm run typecheck` 的覆盖范围内**。本批把它纳入，并修掉因此暴露的 3 个真实类型错误。

## 1. 证据： widened scope 确实能挡住那个 bug

把批次 19 的坏状态**重新造出来**（把 `import { decodeStoredFeature } …` 放回 `#!` 之前），
在纳入 `scripts/**/*.mts` 的配置下跑 `tsc --noEmit`：

```text
scripts/ablation-ca-weights.mts(1,10): error TS2300: Duplicate identifier 'decodeStoredFeature'.
scripts/ablation-ca-weights.mts(27,10): error TS2300: Duplicate identifier 'decodeStoredFeature'.
```

原因很直接：`#!` 只在文件第 0 个字符被当作 shebang，掉到第 2 行就退化成一行的**注释**，
于是同一符号出现两次。**也就是说，这条回归本来就会被类型检查拦下 —— 只是那个目录从来没人检查。**

> 这不是"加了检查之后顺手发现的"，而是**先造出坏状态、确认真能转红**，再决定纳入。

## 2. 纳入后暴露的 3 个真实缺陷（都不是新引入的）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `scripts/ablation-ca-weights.mts:228` | `comparabilityHistoryMode` 是 `string`，却要求 `"legacy" \| "bounded"`。运行时的 `throw` 校验是有效的，但 `runCandidate` 是**函数声明**，TypeScript 不会把模块作用域的收窄带进它的函数体 —— 类型上是无根据的 | 收窄后赋给**显式标注**的 const；注释写明为什么不能靠模块级收窄 |
| 2 | `scripts/ablation-ca-weights.mts:412` | `CandidateOutcome["acceptance"]` 里**根本没有** `firstNegativeAcceptanceAtAttempt` / `negativeOpportunitiesToFirstAcceptance`，而返回值一直在写这两个字段。**§6.9 明确要求的"首次有效负学习所需的训练次数/天数"（检测延迟）此前是"算出来但类型不承认"** | 两个字段补进接口；注释说明 `null` = 本次回放里**从未接受**，那是指标本身而不是缺数据 |
| 3 | `scripts/normalization-coverage.mts:53` | `as ReadonlyArray<{…}>` 直接从 `Record<string, SQLOutputValue>[]` 断言，两者不重叠 | 改为 `as unknown as …`，与同文件其它 SQL 读取的写法一致 |

第 2 条值得单独说：它不是拼写错误，而是**一个报告指标在类型层面不存在**。
`§6.9` 把"检测延迟"列为必报项，而唯一计算它的地方此前没有任何类型约束 ——
字段名改动、被删掉、被写错，编译器都不会响。

## 3. 变更清单

| 文件 | 改动 |
|---|---|
| `tsconfig.json` | `include` 增加 `scripts/**/*.mts` |
| `scripts/ablation-ca-weights.mts` | 显式标注 `comparabilityHistoryMode`；补全 `acceptance` 的两个检测延迟字段 |
| `scripts/normalization-coverage.mts` | SQL 行断言改为经 `unknown` |

**没有改任何算法或数值**：第 1 条是类型收窄（运行时行为不变），第 2 条是接口补全（输出不变），
第 3 条是断言写法。

## 4. 验证

| 验证 | 结果 |
|---|---|
| `npm run typecheck`（现在覆盖 `scripts/**/*.mts`） | **EXIT=0** |
| 坏状态重造 ⇒ 类型检查转红 | ✅ `TS2300` × 2（见 §1），已还原 |
| `npm run data:ablation-ca-weights` | **EXIT=0**（输出字段与批次 19 一致） |
| `node --import tsx scripts/normalization-coverage.mts` | **EXIT=0**（只读） |
| node 侧全量 | **EXIT=0** = 1053 tests / 1035 pass / 0 fail / 18 skipped |
| web 侧全量 | **EXIT=0** = 18 文件 / 111 tests |
| Python | **EXIT=0** = 26 passed |
| `npm run check:doc-refs` | 越界 3 / 漂移 98 / 空行锚 7（与批次 18 持平，未扩大） |

## 5. 仍未做

- `scripts/*.mjs`（`check-doc-line-refs.mjs`、`check-blob-size.mjs`、`benchmark-speed-windows.mjs`、
  `check-web-build.mjs`、`dev-device.mjs`、`mobile-smoke-check.mjs`、`rust-worker.mjs`）**仍未纳入**。
  它们已被门禁/pre-commit 实际调用，坏掉会立刻暴露，所以优先级低于 `.mts`；
  但"被调用 ⇒ 不会坏"只是经验判断，不是保证。
- 消融报告暴露的 §6.9-7 阻断（6 个候选全部 `never_accepted`）**本批没有推进**：
  按 §6.9-5/6 必须先**预注册**每组最少机会数、可接受检测延迟与最大误判下降率，再做候选 grid 回放。
  在那之前"该放宽哪些门槛"没有可判定的答案。

## 6. 复现命令

```bash
cd D:\running
npm run typecheck
npm run data:ablation-ca-weights -- --database var/rai.sqlite --out deliverables/CA_WEIGHT_ABLATION.json
node --import tsx scripts/normalization-coverage.mts --database var/rai.sqlite --out var/normalization-coverage.json
```
