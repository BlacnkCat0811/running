# deliverables/ 目录索引

本目录只放**当前口径**的产物。历史过程记录已移入 `archive/`（内容一字未改，只挪位置）。
判断标准：**顶层文件应当能回答"现在是什么状态"；只能回答"当时发生了什么"的一律进 `archive/`。**

## 一、权威当前（读这些就够）

| 文件 | 口径 | 时点 |
|---|---|---|
| `RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` | **V2 方案主干**：目标架构、不变量、版本矩阵、分阶段实施、验收矩阵 | 2026-09-28 |
| `RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.verification.json` | 上述方案的机器可读核验记录 | 2026-09-28 |
| `RAI_V2_STATUS_2026-09-30.md` | **当前实施状态**：门禁实跑、§16.1 覆盖（52/53）、11 项剩余项状态、被阻塞项与原因、下一步 | 2026-09-30 |
| `ARCHITECTURE_PRODUCT_STATUS_2026-09-28.md` | 产品架构现状基线（**被 `npm run check:doc-refs` 扫描**） | 2026-09-28 |
| `ARCHITECTURE_PRODUCT_STATUS_2026-09-28.linerefs.json` | 上条的行号引用基线快照（与文档成对，勿单独移动） | 2026-09-28 |

> ⚠️ `ARCHITECTURE_PRODUCT_STATUS_2026-09-28.md` 与它的 `.linerefs.json` 是 `check:doc-refs`
> 的唯一默认扫描对象。**动这一对之前先跑该门禁**，并注意改动会体现在"内容漂移"计数上。
>
> 📌 **状态类文档顶层只保留一份。** 批次记录（`RAI_V2_BATCH*`）与 09-29 的实施/进度/剩余项设计
> 已全部移入 `archive/`。新的一轮结束时应当**更新 `RAI_V2_STATUS_*.md`**，
> 而不是在顶层再并列一份新的时点快照（本规则此前被违反过：批次 16–23 曾直接堆在顶层）。

## 二、机器可读产物（可由脚本重跑复现）

> ⚠️ **必须写明"这份产物描述的是哪个数据库"。** 派生数据只有挂在具体库上才有意义：
> 同一个脚本在不同库上会给出不同数字。2026-09-30 实测发现 `NORMALIZATION_COVERAGE.json`
> 原本由 **macOS 主机**产出（`databasePath: /Users/ta/running/var/rai.sqlite`），
> 其"天气可得率 0%"被当成本工作区的事实引用；在本工作区的库上真实值是
> **温度/湿度 8.6%、爬升 61.9%**。数字错了整整一类结论。
> 新增/更新产物时，`databasePath` 一栏必须填**产出它的那份库**。

| 文件 | 生成脚本 / 口径 | `databasePath` | 可在此工作区复现 |
|---|---|---|---|
| `CA_WEIGHT_ABLATION.json` | `npm run data:ablation-ca-weights` | `D:\running\var\rai.sqlite` | ✅ |
| `READINESS_REPLAY_COVERAGE.json` | `npm run data:readiness-replay-coverage` | `D:\running\var\rai.sqlite` | ✅ |
| `NORMALIZATION_COVERAGE.json` | `scripts/normalization-coverage.mts` | `D:\running\var\rai.sqlite` | ✅ |
| `BASELINE_REBASE_REVIEW.json` | `npm run data:baseline-rebase-review` | `D:\running\var\rai.sqlite` | ✅ |
| `MODEL_VERSION_REPLAY_2026-09-30.json` | `scripts/model-version-replay.mts` | `var\rai.sqlite` | ✅ |
| `PHASE0_BASELINE.json` | `scripts/snapshot-phase0-baseline.mts` | `D:\running\var\rai.sqlite` | ✅ |
| `PREPARATION_MIGRATION_GOLDEN.json` | 专项准备度迁移 golden | 未声明 | — |

> 这些是**派生数据**，不是结论。引用时必须同时给出生成脚本与数据口径。

> **2026-09-30 已完成的整理**：此前有 5 份 JSON 描述的是**另一台主机（macOS）**的库。
> 其中两份**本工作区其实可以复现** —— 我上一版把 `PHASE0_BASELINE.json` 误标为"生成器不可用"，
> 而 `scripts/snapshot-phase0-baseline.mts` 一直存在。这两份已在本库重新生成，
> `databasePath` 现在指向本工作区。
> 另外三份（`RAI_V2_ABLATION_2026-09-29.json`、`RAI_V2_BOUNDED_CANDIDATE_2026-09-29.json`、
> `RAI_V2_EVALUATION_2026-09-29.json`）**确实没有生成器**（已核对 `scripts/` 与全部源码），
> 且描述的是那台机器的库，因此移入 `archive/` —— 它们只能回答"当时发生了什么"，
> 不能回答"现在是什么状态"。旧版 `MODEL_VERSION_REPLAY_2026-09-29.json` 同时移入 `archive/`。

> 两份基线产物的实测差异（**同一个脚本**、两台主机），这次是产物与产物之间的直接对照：

| 字段 | macOS 版（现在 `archive/`） | 本工作区重生成 |
|---|---|---|
| `database.path` | `/Users/ta/running/var/rai.sqlite` | `D:\running\var\rai.sqlite` |
| `activeTrainingSessions` | **268** | **257** |
| `modelRuns` | **6** | **24** |
| `activeModelRun` | **`rai-model-config-v3`** | **`rai-model-config-v2`** |
| `schemaMigrationMax` / `predictionModelRuns` / `activeFeatureSchema` / `labelOverrides` | 22 / 0 / `workout-feature-v3` / 0 | 同左（一致） |

## 三、仍有效的参考（非时点快照）

| 文件 | 为什么留在顶层 |
|---|---|
| `SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md` | 长期不变量，被多处引用 |
| `N2_IDENTITY_FREEZE_2026-09-24.md` | 身份算法冻结决策（长期约束） |
| `N3_DESIGN_OUT_OF_TREE_2026-09-24.md` | 越树设计决策 |
| `DATA_FRESHNESS_SEMANTICS_PLAN_2026-09-19.md` | 数据新鲜度语义（与 V2 freshness 统一直接相关） |
| `IOS_SYNC_DEVICE_CHECKLIST_2026-09-22.md` | 运行期操作清单 |
| `USER_EXPERIENCE_OPTIMIZATION_PLAN_2026-09-28.md` / `USER_EXPERIENCE_IMPLEMENTATION_2026-09-28.md` | 交互层方案与实施 |
| `workout-segments-v1.md` / `plan-page-week-v1.md` / `watch-app-design-v1.md` / `watch-plan-execution-v1.md` | 无日期版本化设计文档（现行） |

## 四、archive/

- `archive/`：**历史时点快照**——V2 批次记录（`RAI_V2_BATCH*`）、09-29 的实施/进度/剩余项设计、
  各类审计与复核（`PROJECT_AUDIT_*`、`UNCOMMITTED_REVIEW_*`、`AUDIT_VERIFICATION_*`）、
  问题根因报告、平台/部署方案、iOS 评审与实施记录、以及更早的 `gstack/` 调查原始件。
- 归档**只挪位置、不改内容**；文内互相引用已按新路径更新（含 `packages/storage-sqlite/src/v24-migration.ts`
  注释里指向剩余项设计文档的那一处）。
- 归档文档的结论**默认视为过期**：引用前先确认它是否已被顶层某份文档取代。

## 五、约定

1. **写完一份过程报告，先问它属于顶层还是 `archive/`**：只描述"当时发生了什么"的，直接写进 `archive/`。
2. **不要在这里保留同一主题的多个时点版本**。要保留历史，就带日期进 `archive/`，不要并列在顶层。
3. 新增产物时，把"生成脚本 / 数据口径 / 时点"写进本索引对应小节。
