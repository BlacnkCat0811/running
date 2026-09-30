# RAI V2 批次 21 实施记录 —— 负向学习的拒绝归因与 §6.9-5 门控 grid

日期：2026-09-30
对象方案：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` §6.9-5 / §6.9-6 / §6.9-7 / §6.9-8
上一份记录：`deliverables/archive/RAI_V2_BATCH20_SCRIPTS_TYPECHECK_SCOPE_2026-09-30.md`

## 0. 结论

批次 19 发现"6 个候选全部 `never_accepted`"。§6.9-7 要求**复查/放宽非必要门槛**，
但当时的报告只说"一次都没接受"，**说不出卡在哪一道门上** —— 那样就没法复查。

本批做两件事：

1. 让门控**如实报出拒绝原因**（`refusalReason`），归因仍只有一处实现；
2. 按 §6.9-5 做**一次只改一个因素**的候选 grid，并在报告里明确
   `recommendation: not_evaluable`（§6.9-6 的预注册尚未冻结，不许替用户挑值）。

**结果：本机数据上真正的瓶颈是 `minimumEvidenceReliabilityForLearning = 0.75`；
`minimumComparabilityForLearning = 0.90` 完全不 binding。**

## 1. 拒绝归因（`packages/scoring`）

`updateTrueAbilityFromFeatureScore` 的返回值新增：

```ts
refusalReason: TrueAbilityUpdateRefusal | null   // null = 本次更新已应用
```

```ts
type TrueAbilityUpdateRefusal =
  | "not_eligible" | "no_learning_target" | "no_evidence_strength"
  | "reliability_missing" | "reliability_below_learning_minimum"
  | "comparability_missing" | "comparability_below_learning_minimum"
  | "awaiting_negative_confirmation" | "unchanged_after_update";
```

关键区分是 **`awaiting_negative_confirmation`（证据够格，只差一次确认）** 与
**`reliability_below_learning_minimum`（证据本身不够格）** —— 这两者的处置是相反的：
前者只要再等一次训练，后者要么改数据质量、要么改门槛。把两者压成一句 `updated: false`，
§6.9-7 的"复查"就无从下手。

> 实现方式是把原来那个**单一布尔条件**按同样的顺序拆成 `refuse(reason)` 分支，
> 每个分支返回的数值与拆分前逐字相同。**阈值仍只有一处实现**，报表不重算任何门槛。

## 2. §6.9-5 的候选 grid（脚本侧）

固定权重为 §6.1 的控制组 `v2a`，**一次只改一个因素**：

| 因素 | 取值 |
|---|---|
| `minimumEvidenceReliabilityForLearning` | .60 / .70 / **.75（现行）** |
| `minimumComparabilityForLearning` | .80 / .85 / **.90（现行）** |
| `negativeConfirmationCount` | 1 / **2（现行）** / 3 |

## 3. 本机实测（只读，2026-09-30，257 条存量 V3 特征）

```text
因素 / 取值                          负向接受/机会   首次接受延迟   正向接受/机会   最终 TA
reliability .60                        8/46            3           86/115        47.73
reliability .70                        7/43            6           85/118        47.63
reliability .75（现行）                 0/26           从未          32/135        44.70
comparability .80                      0/26           从未          33/135        44.79
comparability .85                      0/26           从未          32/135        44.70
comparability .90（现行）               0/26           从未          32/135        44.70
confirmationCount 1                    3/26            7           32/135        44.45
confirmationCount 2（现行）             0/26           从未          32/135        44.70
confirmationCount 3                    0/26           从未          32/135        44.70
```

按候选拆开的**负向**拒绝归因（现行政策）：

```text
candidate         负机会   可靠性过低   可比性过低   待确认   不合资格
v1_current          42        33           2         3        4
v2a                 26        20           2         3        1
v2b                 25        19           2         3        1
drop_pace           28        21           2         4        1
drop_efficiency     59        46           2         1       10
drop_stability      21        17           0         3        1
```

### 三条读得出来的事实

1. **binding 的是可靠性门槛（0.75），不是可比性门槛（0.90）。**
   把可比性从 .90 放宽到 .80，**一个数字都没变**。而可靠性从 .75 降到 .70，
   负向接受从 0 变成 7，正向接受从 32 变成 85。
2. **这个门槛对两个方向同时 binding。** 现行政策下正向接受率只有 32/135 ≈ 24%，
   降到 .70 后是 85/118 ≈ 72%。所以"0 负向接受"**不是**"只防下降不防上升"的不对称 bug，
   而是本机证据可靠性普遍落在 .70–.75 之间 —— 门槛正好切在分布的密集处。
3. **K 也 binding，但只在可靠性放行之后才看得见。** 现行政策下负向根本没走到确认那一步，
   所以 K=2→3 没有任何变化；K=1 的 3 次接受，正是那 3 次 `awaiting_negative_confirmation`。

### 刻意**没有**给出的东西

报告里同时写入：

```json
"negativeGatePreregistration": {
  "status": "not_configured",
  "recommendation": "not_evaluable",
  "note": "§6.9-6 要求在评估前配置每组最少机会数、可接受检测延迟与最大误判下降率。这三项尚未冻结，
           所以本 grid 只描述权衡，不给出'该用哪个值'的结论；§6.9-5 也明确 grid 值是回放实验值，
           不是上线默认值。"
}
```

**没有改任何阈值**：把 0.75 改成 0.70 需要先冻结验收标准（多少机会才算"充分"、
可接受多长的检测延迟、允许多大的误判下降率），再做留出复验（§6.9-5 最后一句）。
本机 `labeledOutcomeCount = 0`，"误判下降率"目前**无法测量** —— 这正是不能现在改值的理由。

## 4. 变更清单

| 文件 | 改动 |
|---|---|
| `packages/scoring/src/model.ts` | 新增 `TrueAbilityUpdateRefusal` 与 `refusalReason`（行为不变的拆分） |
| `packages/scoring/test/refusal-attribution.test.ts` | 新增 4 条用例，钉住"待确认 ≠ 证据不够格" |
| `scripts/ablation-ca-weights.mts` | 每候选 `refusalReasons` / `negativeRefusalReasons`；新增 `negativeGateGrid` 与 `negativeGatePreregistration`；`runCandidate` 接受 gate 覆盖 |
| `deliverables/CA_WEIGHT_ABLATION.json` | 重新生成（含归因与 9 格 grid） |

## 5. 验证

| 验证 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| `packages/scoring` 全量 | **49 条既有用例全过**（证明拆分未改变行为）+ 新增 4 条 |
| `npm run data:ablation-ca-weights` | **EXIT=0**，`blockers=6 gridCells=9 prereg=not_configured` |
| node 侧全量 | 见 §6 |
| 两个脚本实跑 | EXIT=0（只读，不写数据库） |

## 6. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| node 侧全量 | **EXIT=0** = **1057 tests / 1039 pass / 0 fail / 18 skipped**（批次 20 后为 1053/1035，本轮 +4） |
| web 侧全量 | **EXIT=0** = 18 文件 / 111 tests（未变） |
| Python | **EXIT=0** = 26 passed（未变） |

## 7. 复现命令

```bash
cd D:\running
npm run data:ablation-ca-weights -- --database var/rai.sqlite --out deliverables/CA_WEIGHT_ABLATION.json
node --import tsx --test packages/scoring/test/refusal-attribution.test.ts
```
