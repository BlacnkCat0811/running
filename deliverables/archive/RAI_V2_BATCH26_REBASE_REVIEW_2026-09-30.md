# RAI V2 批次 26 实施记录 —— §6.4 rebase 检查的只读盘点与"不可评估"的诚实报告

日期：2026-09-30
对象方案：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` §6.4 / §16.1 B03 / §17.1-7
上一份记录：`deliverables/archive/RAI_V2_BATCH25_CANONICAL_NIGHT_RANGE_2026-09-30.md`

## 0. 结论

`reviewBaselineRebase`（§6.4 的检查政策：每 28 天最多一次、冷却 90 天、饱和触发）
有实现、有单测，但**没有任何生产调用方** —— 仓库里唯一的引用是
`packages/scoring/test/baseline-v2.test.ts`。这与批次 19 的消融脚本、
批次 24 之前的 `replayReadinessRulings` 是同一类问题：**代码在那里、测试是绿的、
但它在任何真实路径上都不存在**。

本批给它一个只读调用方，并把**推不出来的输入明确标出来**，而不是用默认值糊成一个结论。

## 1. 六个输入里，四个可推导、两个没持久化

| 输入 | 可推导 | 来源 |
|---|---|---|
| `asOf` | ✅ | 默认取 active run 的 `evaluated_at`（**数据前沿**，不是墙上时钟） |
| `epochStartedAt` | ✅ | 最新 checkpoint 的 `state.baseline.calibrationEndAt` |
| `independentSessions` | ✅ | 窗口内 `assessment_status='eligible'` 的去重 `training_session_id` |
| `saturatedFraction` | ✅ | 存储的逐维度分数 vs `effective_weights_json` |
| `lastReviewedAt` | ❌ **未持久化** | 没有任何表记"上次检查时间" |
| `precedingSaturatedReviews` | ❌ **未持久化** | 没有任何表记"连续饱和次数" |

### 为什么不用默认值补上后两个

`reviewBaselineRebase` 里：

```ts
const saturatedReviews = input.saturatedFraction >= policy.saturationFraction
  ? input.precedingSaturatedReviews + 1 : 0;
status: saturatedReviews >= policy.consecutiveReviews ? "candidate_requested" : "keep_epoch"
```

`precedingSaturatedReviews` **直接决定** `candidate_requested` 还是 `keep_epoch`。
填 0 ⇒ 永远 `keep_epoch`（1 ≥ 2 不成立）；填 1 ⇒ 只要这次饱和就请求候选。
两个都是**确定但任意**的答案，会把"缺状态"伪装成"检查结论" —— 与"缺证据填 0"是同一类错误。

所以报告给 `review.status = "not_evaluable"`，并写出缺失项**门控了哪条分支**。
`reviewHistory.gatedBranches` 就是这个清单。

## 2. 本机实测（`deliverables/BASELINE_REBASE_REVIEW.json`，只读）

```text
schema 22 · asOf 2026-07-20T02:51:58.706Z（active run evaluated_at）
epoch 起点 2024-07-13T12:41:18Z（checkpoint baseline.calibrationEndAt）
       checkpoint rai-model-checkpoint-v1 · eligibleWorkoutCount 132 · TA 46.3128
窗口   2026-06-22 .. 2026-07-20（28 天，取自政策 reviewEveryDays）
证据   eligible 9 / 独立训练 9 / 覆盖 7 天 · 政策要求 ≥12 ⇒ **不满足**
饱和   saturatedFraction 0.111（只有 recovery 维度 1/9）· 阈值 0.2 ⇒ **未触发**
review not_evaluable / review_history_not_persisted · autoRebase false
```

### 这条实测改变了优先级

三个门里已经有两个**按实测数据**给出"保持当前 epoch"：

- 饱和触发 **未成立**（0.111 < 0.2）；
- 独立训练数 **不足**（9 < 12）。

也就是说：**"缺 review 历史"目前不是阻塞项**。补一张 review 历史表不会改变今天的结果 ——
先发生的会是"证据不足"。这比"文档说要持久化，那就去持久化"更省一次无谓的迁移。

（这不否定将来需要它：一旦窗口内独立训练数达到 12 且饱和率 ≥0.2，
缺 `precedingSaturatedReviews` 就会立刻变成唯一的阻塞项。）

### 另一个 `库未升级` 的实例

`epochIdStatus = not_available_at_this_schema`：schema 22 的 `daily_ability_snapshots`
没有 `baseline_epoch_id`，本库也没有 `model_v2_runs`。模块**不编一个 hash 冒充 epoch id** ——
那会得到一个看起来像标识符、实际与任何已发布 lineage 都对不上的字符串。
检测方式是 `PRAGMA table_info` + `sqlite_master`，缺失就如实报告。

## 3. 测试（新增 5 条），其中两条是"不许糊弄"的断言

`packages/application/test/baseline-rebase-review.test.ts`

| 用例 | 断言 |
|---|---|
| 可推导事实 | epoch 起点/来源、eligible 132、窗口 28 天、逐维度饱和度 |
| **只有有效维度参与** | cardio 分数条条贴边但权重为 0 ⇒ `effectiveEvidence 0`、`fraction null` |
| **缺历史 ⇒ 不可评估** | `review.status = not_evaluable`、两个输入为 null、`gatedBranches` 写明门控了哪条分支；即使饱和触发成立也不下结论 |
| 窗口由 asOf 回推 | 窗口外的证据不进分母 |
| 无证据 ⇒ null | `saturatedFraction` 是 `null` 而不是 `0`；`triggerMet` 也是 `null` |
| epoch 晚于 asOf | 抛错，不静默算出一个不自洽的检查 |

突变验证：
- 去掉"只有有效维度参与"的判据 ⇒ **用例 1 转红**；
- 用默认值补上缺失输入后输出真实 status ⇒ **用例 1–4 转红**（4/5 失败）。

## 4. 夹具纪律：不关外键

`ability_assessments` 有指向 `training_sessions`、`workout_features`、`model_runs` 的三个外键。
第一版夹具为省事想关掉 `PRAGMA foreign_keys`，最后改为**建出真实引用链**
（`feature_runs → model_runs → training_sessions → workout_features → ability_assessments`）：
关掉外键会让夹具描述一个数据库**不可能存在**的状态，而这类"夹具比现实宽松"
正是本方案反复警告的那类假通过。

过程中还确认了两条 schema 事实：`ability_assessments` 有
`UNIQUE(model_run_id, training_session_id)`（所以 session 与 assessment 今天必然 1:1），
以及 `workout_features` 有 `UNIQUE(feature_run_id, training_session_id)`。

## 5. 变更清单

| 文件 | 改动 |
|---|---|
| `packages/application/src/baseline-rebase-review.ts` | 新增（只读盘点，明确不可评估） |
| `packages/application/src/index.ts` | 导出入口 |
| `scripts/baseline-rebase-review.mts` | 新增（只读 CLI，`--out` 可选） |
| `packages/application/test/baseline-rebase-review.test.ts` | 新增 5 条 |
| `package.json` | `data:baseline-rebase-review` + `pre` 钩子 |
| `deliverables/BASELINE_REBASE_REVIEW.json` | 新增（机器可读产物，`databasePath` 指向本工作区） |

## 6. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0** |
| node 侧全量 | **EXIT=0** = **1086 tests / 1068 pass / 0 fail / 18 skipped**（批次 25 后 1081/1063，本轮 +5） |
| web 侧全量 | **EXIT=0** = 18 文件 / 111 tests |
| Python | **EXIT=0** = 26 passed |
| `npm run check:doc-refs` | 越界 3 / 漂移 98 / 空行锚 7（未变） |
| 新 CLI 实跑 | **EXIT=0**，`review.status = not_evaluable` |

**未对 `var/rai.sqlite` 执行任何写操作**（`new DatabaseSync(..., { readOnly: true })`）。

## 7. 复现命令

```bash
cd D:\running
npm run data:baseline-rebase-review -- --database var/rai.sqlite --out deliverables/BASELINE_REBASE_REVIEW.json
node --import tsx --test packages/application/test/baseline-rebase-review.test.ts
```
