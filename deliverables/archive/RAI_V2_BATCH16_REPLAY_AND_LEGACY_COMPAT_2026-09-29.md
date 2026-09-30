# 批次 16：中断任务的收口 —— 分版本回放真实性 + §3.3 旧数据兼容标记

日期：2026-09-29
基线提交：`62b4a97d8f3e04949b52c1715dc3a5ec660bc95c`
对象文档：`deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md`（§3.3 / §3.4 / §15.3 / §15.8）

## 结论先行

上一轮做到「分版本回放 + 旧数据兼容检查」时被中断：**新增文件已落盘，但门禁与断言有效性都没有验过**。
本批先做审计，再收口。结论：

| 项 | 结论 |
|---|---|
| 中断任务是否真落盘 | ✅ 齐全（含两处 python `.replace` 都真落了盘，已 Grep 回读） |
| typecheck | ✅ `EXIT=0` |
| 回放测试断言是否有效 | 🔴 **有一处假绿，已修复**（测试名声称"两引擎消费相同事实"，实测只验了 V1 一侧） |
| §3.3 旧数据兼容标记 | 🔴 **真缺口**，已补（原为"要求只活在文档里"） |
| 分版本回放能否跑在真实库 | ✅ 新增只读脚本，首次跑通；旧引擎/新引擎在同一份特征上对比 |
| 真实库升级 / 模型激活 / 部署 | ❌ 未做（保持原状，schema 22、active model 未变） |

## 1. 审计：中断任务的实际状态（先验事实）

落盘清单（均为未跟踪新文件）：

- `packages/scoring/src/legacy-v1/index.ts`、`model.ts` —— 从 `62b4a97` 冻结的 V1 引擎副本。
- `packages/features/src/legacy-v3/index.ts` —— 冻结的 V3 特征提取器（`./speed-windows.js` 路径已改为 `../`）。
- `packages/application/src/model-replay-v2.ts`、`model-replay-cli.ts`。
- `packages/application/test/model-replay-v2.test.ts`。

三处改动都已落盘（用 Grep 回读确认，未出现"同一批两个 Edit 静默丢一个"）：

- `packages/application/src/services/recompute-pipeline.ts:405,1639` —— `configHash` 纳入 `engineVersion: SCORING_MODEL_VERSION`
  （对应 §14.4「engineVersion 与 configVersion 混在一起」）。
- `packages/application/src/prediction-report.ts:1050` —— predictorKey 追加 scenario hash。
- `packages/scoring/src/model.ts:27` —— `MODEL_CONFIG_VERSION` v11 → v12，`apps/api/test/data.test.ts:143` 同步。

`v11` 仅残留在两份历史产物（`RAI_V2_ABLATION_2026-09-29.json`、`RAI_V2_IMPLEMENTATION_2026-09-29.md`），
属**时点快照**，按纪律"标时间口径而非改数字"处理，未改。

## 2. 🔴 假绿修复：测试名声称的事，断言没验

`model-replay-v2.test.ts` 的测试名为
「frozen V1 and V2 consume **identical facts** deterministically…」，原断言只有：

```ts
assert.equal(a.base.output.timeline.length, 9);   // 只验了 V1 一侧
```

突变实验（把候选侧事实砍到 1 条，`run(false, facts.sources.slice(0,1))`）：

| 突变 | 修复前 | 修复后 |
|---|---|---|
| V1 侧事实砍到 5 条 | 红（expected 9, actual 5） | 红 |
| **V2 侧事实砍到 1 条** | **绿 —— 漏抓** | 红（expected 9, actual 1） |

修复补的断言：两侧 timeline 长度均为 9、两侧 `sessionId` 序列**逐项相等**、
`calibrationCount` 相等、且序列等于输入的 `trainingSessionId` 序列。

## 3. 🔴 两条"突变"其实不是突变（新增判据）

对"到达时间守卫"与"legacy 标记"做突变时，有两条改写**照样绿**，但都不是真突变：

1. `availableAt===null||!Number.isFinite(Date.parse(availableAt))`
   → `!Number.isFinite(Date.parse(availableAt??""))`：`Date.parse("")` 同样是 `NaN`，
   **两者语义等价**。真突变须写成 `availableAt!==null&&…`（让 null 不再抛）⇒ 才红。
2. 去掉 legacy 侧的 `featureSchemaVersion` 戳：分类器"无戳即判 legacy"方向正确，该戳对**分类结果**冗余。
   真正该突变的是 **V4 侧**的戳（去掉后 `storedFeatureSchema` 把 V4 读成 legacy ⇒ 红）。

⇒ **判据：改完先问"这个改写到底改变了哪条可观测路径"；答不上来就不是突变，不能拿它当证据。**
（与既有"红的是 `ReferenceError`、突变根本没跑起来"同族。）

## 4. §3.3 旧数据兼容：真缺口与补法

原文要求：只有 V3 JSON 时保留旧字段，新增 decoupling / environment 置 null 并
**标 `unavailable_in_legacy_feature`**，且**不能冒充完整 V4 Fitness 学习证据**。

实测缺口：

- `decodeStoredFeature` 的 legacy 分支只返回 `{...metadata, signals: raw}`，**与 V4 读取不可区分**。
- `unavailable_in_legacy_feature` **全仓无实现**——只出现在文档，以及报表里的**分组名**
  `unavailable_in_stored_v3_features`（不是记录级标记）。

补法（**读取期标记，不写库**，因此对持久化零风险）：

| 落点 | 内容 |
|---|---|
| `packages/contracts/src/index.ts` | `missingReasonCodes` 增成员 `unavailable_in_legacy_feature` |
| `packages/features/src/v4.ts` legacy 分支 | 追加该 `missingReasons`（带去重守卫） + `provenance.featureSchemaVersion = "workout-feature-v3-legacy"` |
| `packages/features/src/v4.ts` `projectFeatureV4` | `provenance.featureSchemaVersion = "workout-feature-v4"` |
| 新增导出 `storedFeatureSchema()` | **无戳一律判 legacy，不做"信任式升格"** |

突变验证（4 条）：

| 突变 | 结果 |
|---|---|
| V4 侧去掉 schema 戳 | 🔴 红（expected `workout-feature-v4`，actual `workout-feature-v3-legacy`） |
| legacy 侧去掉缺失原因标记 | 🔴 红 |
| 缺失原因无脑追加（标记累积） | 🔴 红 |
| legacy 侧去掉 schema 戳 | ⚪ 绿 —— **冗余，不算缺口**，如实记录 |

真实库验证（见 §5）：`cohort.legacyReadsMarked = 268 / 268`。
该数**只统计本次新增的标记**，去掉标记立刻变 0 —— 比 `legacySchemaRows`（按分类器默认判据统计，
去不去标记都一样）更强的判据。

## 5. 分版本回放第一次跑在真实库上

新增 `scripts/model-version-replay.mts`（**只读**）。它补上文档点名的缺口：

> 既有的 `v1_current` 只是**旧权重在新引擎下**的控制组，**不是真正旧引擎回放**。

本脚本用**冻结 V1 引擎**（`legacy-v1`，62b4a97）与**当前 V2 引擎**在同一份已存特征上回放，
**引擎是唯一变量**。

产物：`deliverables/MODEL_VERSION_REPLAY_2026-09-29.json`

| 项 | 值 |
|---|---|
| 库 / 特征 run | `var/rai.sqlite` / `feature_run_1f07836f…` |
| schema / active model | 22 / `model_run_00a5cc10…`（**未改**） |
| 特征快照 sha256 | `44d7b917686c323c…` |
| 特征总数 / eligible / trial / excluded | 268 / 45 / 205 / 18 |
| legacy 读标记 | **268 / 268** |
| 版本矩阵 | engine `rai-v2.0.0`（对照 `rai-v1.0.0-dev@62b4a97`）、config `rai-model-config-v12`、feature `feature-config-v11`、physiology `rai-physiology-v1.8.0`、eval `rai-model-eval-v1` |

引擎对比：

| | V1（冻结） | V2（当前） |
|---|---|---|
| TA 更新次数 | 39 | **31** |
| final TA | 46.118 | 44.688 |
| CA 可评估数 / TA 可评估数 | 39 / 156 | 39 / 156（**coverageDelta = 0 / 0**） |

差异分布（V2 − V1，取绝对值）：

- CA：mean **1.111**、p50 0.772、p95 **3.651**、max 3.700（39 个可比会话）。
- TA：mean 1.323、p95 1.842、max 2.115（156 个可比会话）。
- final TA 绝对差 **1.430**；**statusChanged = 0**（状态变更率 0）。
- 分层：`steady_aerobic` 20 个可比 → mean 0.925；`threshold_sustained` 17 个 → 1.422；`interval` 1 个 → 0.669。

既有发布 gate（`rai-shadow-gate-v1`，阈值 CA mean≤8 / p95≤15 / TA≤10 / 状态变更率≤0.10）：
**四项全部 passed**。

> ⚠️ 口径说明（写在产物里，不只写在注释里）：
> 1. **gate 全绿不是精度认证** —— 产物 `accuracyStatus` 仍为 `not_evaluable`，`notEvaluable` 列出
>    `external_label_accuracy`、`interval_calibration`、`negative_acceptance_truthfulness`、
>    `as_known_then_replay`。本地库 **0 个已确认比赛/测试标签**。
> 2. `scope` 明示这是**引擎对比**：特征提取与环境归一化被**固定**（存储行早于 V4，268/268 都是 legacy 读），
>    **不是**特征版本回放。
> 3. `coverageDelta = 0/0` 是报差值分布的**前提**；两侧可评估覆盖不一致时，差值分布不可比。

只读副作用：`node:sqlite` 只读打开仍会就地生成 `var/rai.sqlite-shm`，探完已删除；
核对 DB 本体 mtime 仍为 `2026-09-17 11:19`，**未变**。

## 6. 归因：doc-refs 漂移增量不是我造成的

`npm run check:doc-refs -- --problems-only`：**漂移 95 / 空行锚 7 / 越界 3**。

漂移数较今日早先记录的 **84** 上升。**不靠推理，做 A/B**：临时回退本批的契约改动重跑 ⇒ **仍是 95 / 7**
⇒ 增量来自**此前未提交批次**，本批未扩大漂移。改动已恢复并回读确认。
（另有既有"锚在空行 7 处"与"越界 3 处"为预先存在。）

## 7. 门禁实跑

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | `EXIT=0` |
| `npm test` — node 侧 | **`EXIT=0`** = **994 tests / 990 pass / 0 fail / 4 skipped** |
| `npm test` — web 侧 | **16 文件 / 99 tests 全 pass** |
| 受影响包独占复验 | `features` + `application` + `contracts` = **141 / 141 pass / 0 fail**，typecheck `EXIT=0` |
| `npm run check:doc-refs` | 漂移 95 / 空行锚 7 / 越界 3（较今日早先的 84 上升，已在 §6 用 A/B 归因为**先前未提交批次**） |

`npm test` 与 `typecheck` **分开跑、分开报**（`tsx` 只剥离类型不检查）。
4 skipped 是本沙箱既有基线（`publication lock rejects PID reuse` 靠 `ps` 探测进程身份，
沙箱内 `EPERM` ⇒ 按设计 fail-safe 跳过），**不是覆盖丢失**。
最后一行"受影响包独占复验"的存在原因如实说明：§6 的 A/B 归因曾在门禁运行期间短暂改动过源码
（秒级即恢复，且该改动在 `tsx` 下不影响可观测行为），为不靠推理，在**最终源码、无并发改动**下重跑了一次。

## 8. 本批未做（如实记录）

- 真实库 migration、全量 recompute、模型激活、生产部署、Git 提交：**均未做**。
- 对象文档所列剩余工程项仍全部未完成，尤其是：
  V4 特征契约与提取/存储/读取全链路、transition gate v2 发布接入与 bundle 原子发布、
  rebase 发布流程与分段长期曲线 UI、`@rai/model-eval` 接入 Python runner 的三方对比、
  区间 calibration artifact 持久化与生产选择器、环境 adapter 生产统一、跨领域 V1/V2 replay 完整框架。
- 本批新增的 `model-version-replay.mts` 覆盖的是**评分引擎**跨版本对比；
  **特征版本**（V3→V4）回放仍缺一份可从原始事实重建 `WorkoutFeatureSource` 的提取器。

## 9. 复现命令

```bash
cd /Users/ta/running
npm run typecheck
npm test
npm run check:doc-refs -- --problems-only
node --import tsx scripts/model-version-replay.mts \
  --database var/rai.sqlite --out deliverables/MODEL_VERSION_REPLAY_2026-09-29.json
node --import tsx --test packages/application/test/model-replay-v2.test.ts
node --import tsx --test packages/features/test/v4.test.ts
```
