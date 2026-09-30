# RAI V2 方案实施状态 —— 2026-09-30

对象方案：`RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md`
基线提交（方案核验时）：`62b4a97d8f3e04949b52c1715dc3a5ec660bc95c`
本文件位置：**唯一描述"现在是什么状态"的顶层文档**。过程记录（批次 16–23、09-29 的实施/进度/剩余项设计）
已按本目录约定移入 `archive/`。

> **口径声明**：本文区分三件此前被混为一谈的事 —— **代码里有什么 / 库里已经算过什么 / 线上真正激活了什么**。
> 本文只确认前两项；不查询线上环境，不推断线上用户状态。所有"通过"都指**工程门槛**，不是精度验收。

---

## 一、一句话结论

方案主干（P0/P1 的工程边界）**已实施并逐条有测试**；§16.1 的 53 条验收里 **52 条有行为覆盖**。
剩余的不是"还没写"，而是三类**不能靠写代码解决**的事：**被真实标签阻塞**、**被天气数据阻塞**、
**需要新增政策且必须先回放**。精度增强（ML、经验区间、Durability 数值、耐久罚分）**全部未激活**，
且**不应**在没有独立标签的情况下激活。

---

## 二、当前门禁（独占实跑，2026-09-30）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（现覆盖 `packages/`、`apps/`、**`scripts/`**） | **0** |
| node 侧全量 | `node --import tsx --test "packages/*/test/*.test.ts" "apps/api/test/*.test.ts"` | **1068 tests / 1050 pass / 0 fail / 18 skipped** |
| web 侧全量 | `npm run test -w @rai/web` | **18 文件 / 111 tests / 0 fail** |
| Python | `research\.venv\Scripts\python.exe -m pytest research/tests -q` | **26 passed** |
| 文档行号引用 | `npm run check:doc-refs` | 越界 3 / 漂移 98 / 空行锚 7（**已知且未扩大**；漂移来自 09-28 之后合法的版本常量演进） |

> **计数口径**：node 侧必须用**带引号的 glob**交给 node 自己展开。
> 直接 `npm run test` 在本机（Windows/cmd）只跑到 498 条 —— 那是脚本壳差异，不是回归。
> 18 skipped 是本沙箱既有基线（其中多数依赖 `ps` 探测进程身份，沙箱内 EPERM ⇒ 按设计 fail-safe 跳过）。

---

## 三、§16.1 验收矩阵覆盖状态

**52 / 53 有行为覆盖**。逐条对照表见 `archive/RAI_V2_BATCH18_ACCEPTANCE_MATRIX_2026-09-30.md`；
本状态文档只列**唯一缺口**与**新增覆盖**：

| 状态 | ID | 说明 |
|---|---|---|
| 🔴 **唯一未覆盖** | **F08** | 快速下坡/速度尖峰 ⇒ 不产生未经质量门控的正向 TA 跳升。缺的不是测试而是**检测器本身**（见 §五 第 3 条） |
| ✅ 本批新增 | F09 / S03 / F07 / L04 / C01（+R01） | 见 `archive/RAI_V2_BATCH18_…md` |
| ✅ 本批新增 | R05 / D03 | 见 `archive/RAI_V2_BATCH23_…md` |
| ✅ 此前已有 | 其余 47 条 | 每条都指到具名用例（批次 18 的对照表） |

---

## 四、11 项剩余工程项的当前状态

| # | 项 | 状态 | 依据 / 阻塞原因 |
|---|---|---|---|
| 1 | V4 特征全链路 | 🟡 **代码已就绪，真实库未重建** | `recompute-pipeline` 已走 `extractWorkoutFeatureVectorV4` + `encodeFeaturePayloadV4`；本机 268 条仍是 V3 存量。重建属于部署动作（迁移闸门见 §六） |
| 2 | 工程/配置版本落库分离、lineage | ✅ | v24 迁移 + `engine_version` 读端 + API/界面；`ModelLineageV2` 十五个字段齐全 |
| 3 | transition gate v2 + bundle 原子发布 | ✅ | 三态 gate、release bundle、拒绝留痕、回滚语义，均有测试 |
| 4 | assembler freshness 统一 | 🟡 | 到达时间（`latestAvailableAt` / `availabilityUnknown`）已成为可见事实；`as_known_then` 的**裁决**留给第一个真正按该模式回放的调用方 |
| 5 | rebase 发布流程与 epoch 分段曲线 | 🟡 | CLI `rebase` + 检查策略 + 曲线分段 + "两侧不可直接比较"文案已具备；**`effectiveAt` / `rebaseReason` 未落库**（`rebaseReason` 需要 review 状态持久化才不算造字段） |
| 6 | 环境 adapter 生产统一 | 🔴 **被数据阻塞** | `NORMALIZATION_COVERAGE.json`：温度 **0%**、湿度 **0%** 可得率（268 条）。N1（复用既有条件惩罚）已在 physiology 落地；N3 无法校准，且 §18.4 禁止自动接入天气服务 |
| 7 | 快照贯穿实际 API | 🟡 | fitness / load / readiness 三域已窄化且有真实消费方；durability / zones 等有消费方再做（不做投机抽象） |
| 8 | Ridge/CatBoost 同样本三方竞争 | ✅ | Python 产 `challengers.json` → TS 导入器 → 既有 `compareResidualChallengers`；缺列按"不能凭缺席获胜"处理 |
| 9 | 区间 calibration 持久化与选择器 | ✅ | 只差"独立标签到位后跑一次真校准" |
| 10 | 跨领域 replay | 🟡 | Fitness（冻结 V1 引擎 vs 当前 V2）、Readiness、Load 三个域均有入口，且各自只差一个**被声明的假设**；Coach 未做（决策层，无有效对照支） |
| 11 | 候选参数实证与真实退步验收 | ❌ **被真实标签阻塞** | 本机 `labeledOutcomeCount = 0`（268 条训练 / 0 条已确认比赛或标准测试），`real_label_smoke = not_evaluable` |

---

## 五、本状态文档新增的三条可执行结论

### 1. 负向学习的瓶颈已定位到**可靠性门槛**（不是可比性、不是 K）

按 §6.9-5 做的一次只改一个因素的 grid（权重固定为 §6.1 控制组 `v2a`，本机 257 条存量特征）：

```text
因素 / 取值                    负向接受/机会   首次接受延迟   正向接受/机会   最终 TA
reliability .60                   8/46             3          86/115        47.73
reliability .70                   7/43             6          85/118        47.63
reliability .75（现行）            0/26           从未         32/135        44.70
comparability .80/.85/.90（现行）   0/26           从未         32/135        44.70   ← 完全不动
confirmationCount 1 / 2（现行）/ 3  3/26 / 0/26 / 0/26  7 / 从未 / 从未
```

两条读得出来的事实：

- **可比性门槛（0.90）在本机数据上完全不 binding** —— 放宽到 .80 一个数字都没变；
- **可靠性门槛对两个方向同时 binding**（正向接受率 24% → 72%）。
  所以"0 负向接受"**不是**"只防下降不防上升"的不对称 bug。

**没有改任何阈值**：改值需要先按 §6.9-6 冻结"每组最少机会数 / 可接受检测延迟 / 最大误判下降率"，
而本机标签为 0 ⇒ **最大误判下降率目前无法测量**。报告里写了
`negativeGatePreregistration: { status: "not_configured", recommendation: "not_evaluable" }`。

### 2. §6.1 的消融报告工具曾经**完全跑不起来**，现在不可再静默腐烂

`scripts/ablation-ca-weights.mts` 自 `017bf95` 起因一行 `import` 被插到 `#!` 之前而无法运行，
`deliverables/CA_WEIGHT_ABLATION.json` 是那次改动**之前**的快照。修好之后：

- `scripts/**/*.mts` 已纳入 `npm run typecheck`（**先造出坏状态确认该检查确实会转红**，`TS2300`）；
- 生成端在写文件前调用 `assertCaWeightAblationReport`：无标签不得宣称精度、不可评估的段落必须写明原因、
  预注册未冻结时不得给出"用哪个阈值"的建议。

### 3. F08 需要的是**新政策**，不是新测试

现行政策下正向一侧同样被强门控（见上表），"只防下降不防虚高"不是当前可观测的失效模式。
但一次被 GPS 尖峰污染的**干净**训练仍会以高可靠性通过 —— 要挡住它必须新增速度合理性检测器，
其阈值需要独立回放（§6.9-8 要求放宽/收紧都不得绕过硬质量闸门，且必须重新验证两侧）。
**本方案不为它编一个未经验证的阈值。**

---

## 六、未执行的动作（明确列出，避免被读成"已完成"）

| 动作 | 为什么没做 |
|---|---|
| 本地库迁移到 v24 | 本机仍是 schema 22；属于部署动作，需停止 API + 一致备份 + `data:migrate --apply`。代码与迁移测试已就绪 |
| 全量 V4 重算 | 同上；且会改变 active run |
| 模型训练 / 激活 / 校准 | 标签为 0；ML 与经验区间**必须保持未激活** |
| 线上部署 | 超出本方案范围 |
| 接入天气服务 | §5.2 第 3 条要求另批 provider/缓存/隐私/成本；§18.4 明确不做 |
| 任何阈值调整 | §6.9-6 的预注册未冻结 |

---

## 七、产物索引（按"能否重跑复现"分类）

### 权威口径

| 文件 | 说明 |
|---|---|
| `RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` | 方案主干（目标架构、不变量、版本矩阵、分阶段实施、验收矩阵） |
| `RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.verification.json` | 方案核验的机器可读记录 |
| **`RAI_V2_STATUS_2026-09-30.md`**（本文件） | **当前实施状态** |
| `ARCHITECTURE_PRODUCT_STATUS_2026-09-28.md` (+`.linerefs.json`) | 产品架构现状基线（被 `check:doc-refs` 扫描） |

### 机器可读产物（可由脚本重跑）

| 文件 | 生成命令 |
|---|---|
| `CA_WEIGHT_ABLATION.json` | `npm run data:ablation-ca-weights -- --database var/rai.sqlite --out deliverables/CA_WEIGHT_ABLATION.json` |
| `MODEL_VERSION_REPLAY_2026-09-29.json` | `node --import tsx scripts/model-version-replay.mts --database var/rai.sqlite` |
| `NORMALIZATION_COVERAGE.json` | `node --import tsx scripts/normalization-coverage.mts --database var/rai.sqlite` |
| `RAI_V2_ABLATION_2026-09-29.json` / `RAI_V2_BOUNDED_CANDIDATE_2026-09-29.json` | 09-29 的消融台账与 bounded 候选离线评估（**候选未启用**） |
| `RAI_V2_EVALUATION_2026-09-29.json` | 统一评估报告（含 `not_evaluable` 明细） |
| `PHASE0_BASELINE.json` / `PREPARATION_MIGRATION_GOLDEN.json` | 阶段 0 证据基线 / 专项准备度迁移 golden |

> 引用这些产物时**必须同时给出生成脚本与数据口径**。它们是派生数据，不是结论。

### 过程与历史

`archive/` 保留全部批次记录与审计；**归档文档的结论默认视为过期**，引用前先确认是否已被本文件取代。

---

## 八、下一步（按"是否被阻塞"排序）

**可立即推进（无阻塞）**

1. §6.4 的 `effectiveAt` / `rebaseReason`：需要先把 rebase review 状态（上次检查时间、连续饱和次数）持久化，
   否则 `rebaseReason` 只能是一个编出来的枚举值。
2. §13.3 的 `CoachDecisionV2` 版本化输出：需要先把 `tone + next session` 到 `action` 的映射设计清楚，
   并保证它是**同一个决策**的兼容映射，而不是第二套裁决。
3. 跨领域 replay 的 Load/Readiness 入口接入日常评估报告（入口已在，缺的是例行调用）。

**被数据阻塞（等条件，不等代码）**

4. 环境 adapter N3：等天气字段可得率从 0% 起变化。
5. 区间校准 / CatBoost 激活 / Durability 数值：等 ≥24 条独立、无泄漏、用户确认的比赛或标准测试结果。
   标签闭环的**软件部分**已完成并有测试（`label-funnel.test.ts`），缺的是**真实结果本身**。

**被授权阻塞**

6. 本地库迁移 + 全量 V4 重算 + bundle 发布（§17.6 Phase 5）：需要停止 API、一致备份、并承担一次
   active run 切换；应在单独一轮中按迁移闸门执行。

**需要新政策（必须先回放）**

7. F08 的速度合理性检测器：先做**检测率盘点**（报告而不猜测），再决定是否成为门控。
