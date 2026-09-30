# deliverables/ 目录索引

本目录只放**当前口径**的产物。历史过程记录已移入 `archive/`（内容一字未改，只挪位置）。
判断标准：**顶层文件应当能回答"现在是什么状态"；只能回答"当时发生了什么"的一律进 `archive/`。**

## 一、权威当前（读这些就够）

| 文件 | 口径 | 时点 |
|---|---|---|
| `RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` | **V2 方案主干**：目标架构、不变量、版本矩阵、分阶段实施、验收矩阵 | 2026-09-28 |
| `RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.verification.json` | 上述方案的机器可读核验记录 | 2026-09-28 |
| `RAI_V2_IMPLEMENTATION_2026-09-29.md` | **实施记录**：已交付什么、明确未通过什么、还挂着的工程项 | 2026-09-29 14:58 |
| `RAI_V2_IMPLEMENTATION_2026-09-29.verification.json` | 上条的验证汇总与产物 hash | 2026-09-29 14:59 |
| `RAI_V2_BATCH16_REPLAY_AND_LEGACY_COMPAT_2026-09-29.md` | 批次 16：V1/V2 分版本回放真实性 + §3.3 旧数据兼容标记 | 2026-09-29 16:24 |
| `RAI_V2_PROGRESS_STATUS_2026-09-29.md` | 进度排查：断流点状态、P0 回归（模型切换 500）根因与修复、门禁实跑 | 2026-09-29 19:22 |
| `RAI_ALGORITHM_V2_REMAINING_DESIGN_2026-09-29.md` | **V2 剩余项设计**：11 项未完成工程项的现状证据、设计、验收判据、回滚与依赖顺序 | 2026-09-29 19:5x |
| `ARCHITECTURE_PRODUCT_STATUS_2026-09-28.md` | 产品架构现状基线（**被 `npm run check:doc-refs` 扫描**） | 2026-09-28 |
| `ARCHITECTURE_PRODUCT_STATUS_2026-09-28.linerefs.json` | 上条的行号引用基线快照（与文档成对，勿单独移动） | 2026-09-28 |

> ⚠️ `ARCHITECTURE_PRODUCT_STATUS_2026-09-28.md` 与它的 `.linerefs.json` 是 `check:doc-refs`
> 的唯一默认扫描对象。**动这一对之前先跑该门禁**，并注意改动会体现在"内容漂移"计数上。

## 二、机器可读产物（可由脚本重跑复现）

| 文件 | 生成脚本 / 口径 |
|---|---|
| `RAI_V2_ABLATION_2026-09-29.json` | CA 维度权重消融台账 |
| `RAI_V2_BOUNDED_CANDIDATE_2026-09-29.json` | bounded comparability 候选离线评估（**未启用**） |
| `RAI_V2_EVALUATION_2026-09-29.json` | 统一评估报告（含 not_evaluable 明细） |
| `CA_WEIGHT_ABLATION.json` | `scripts/ablation-ca-weights.mts` |
| `MODEL_VERSION_REPLAY_2026-09-29.json` | `scripts/model-version-replay.mts`（冻结 V1 引擎 vs 当前 V2 引擎） |
| `NORMALIZATION_COVERAGE.json` | `scripts/normalization-coverage.mts` |
| `PHASE0_BASELINE.json` | 阶段 0 证据基线 |
| `PREPARATION_MIGRATION_GOLDEN.json` | 专项准备度迁移 golden |

> 这些是**派生数据**，不是结论。引用时必须同时给出生成脚本与数据口径。

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

- `archive/`：**历史时点快照**——批次记录（`PHASE*_BATCH*`）、各类审计与复核
  （`PROJECT_AUDIT_*`、`UNCOMMITTED_REVIEW_*`、`AUDIT_VERIFICATION_*`）、问题根因报告、
  平台/部署方案、iOS 评审与实施记录、以及更早的 `gstack/` 调查原始件。
- 归档**只挪位置、不改内容**；文内互相引用已按新路径更新。
- 归档文档的结论**默认视为过期**：引用前先确认它是否已被顶层某份文档取代。

## 五、约定

1. **写完一份过程报告，先问它属于顶层还是 `archive/`**：只描述"当时发生了什么"的，直接写进 `archive/`。
2. **不要在这里保留同一主题的多个时点版本**。要保留历史，就带日期进 `archive/`，不要并列在顶层。
3. 新增产物时，把"生成脚本 / 数据口径 / 时点"写进本索引对应小节。
