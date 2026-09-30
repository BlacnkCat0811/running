# RAI V2 方案实施状态 —— 2026-09-30

对象方案：`RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md`
基线提交（方案核验时）：`62b4a97d8f3e04949b52c1715dc3a5ec660bc95c`
本文件位置：**唯一描述"现在是什么状态"的顶层文档**。过程记录（批次 16–23、09-29 的实施/进度/剩余项设计）
已按本目录约定移入 `archive/`。

> **口径声明**：本文区分三件此前被混为一谈的事 —— **代码里有什么 / 库里已经算过什么 / 线上真正激活了什么**。
> 本文只确认前两项；不查询线上环境，不推断线上用户状态。所有"通过"都指**工程门槛**，不是精度验收。
>
> 🔴 **本工作区的数据库与方案 §1.5 记录的数据库不是同一份**（见 §五-6）。方案 §1.5 的
> "268 条 session / active `rai-model-config-v3` / 2026-09-04 激活"是 **macOS 主机**上的快照；
> 本文所有数字都来自 `D:\running\var\rai.sqlite` 的**实测**。

---

## 一、一句话结论

方案主干（P0/P1 的工程边界）**已实施并逐条有测试**；§16.1 的验收矩阵改为**可执行判据**：54 条中 49 条按 ID 被引用、5 条在检查脚本里逐条声明缺哪一半、0 条既未引用也未声明（§三）。
剩余的不是"还没写"，而是三类**不能靠写代码解决**的事：**被真实标签阻塞**、**被天气数据阻塞**、
**需要新增政策且必须先回放**。精度增强（ML、经验区间、Durability 数值、耐久罚分）**全部未激活**，
且**不应**在没有独立标签的情况下激活。

---

## 二、当前门禁（独占实跑，2026-09-30）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（现覆盖 `packages/`、`apps/`、**`scripts/`**） | **0** |
| node 侧全量 | `node --import tsx --test "packages/*/test/*.test.ts" "apps/api/test/*.test.ts"` | **1086 tests / 1068 pass / 0 fail / 18 skipped** |
| web 侧全量 | `npm run test -w @rai/web` | **18 文件 / 111 tests / 0 fail** |
| Python | `research\.venv\Scripts\python.exe -m pytest research/tests -q` | **26 passed** |
| 文档行号引用 | `npm run check:doc-refs` | 越界 3 / 漂移 98 / 空行锚 7（**已知且未扩大**；漂移来自 09-28 之后合法的版本常量演进） |
| **只读工具链全量实跑** | 8 个已文档化的 CLI/脚本，逐一实跑 | **全部 exit=0**（见下） |

> **工具链实跑（2026-09-30，均只读）**：
> `walk-forward` 2004 ms · `model-version-replay` 643 ms（gate `rai-shadow-gate-v1` 通过：
> CA 均值 |Δ| 3.47、最终 TA |Δ| 1.61）· `ablation` 1286 ms（6 候选、**6 个发布阻断**）·
> `normalization-coverage` 481 ms · `readiness-replay-coverage` 1826 ms ·
> `backfill-canonical-nights`（dry-run）436 ms · `model-v2 --action inspect` 411 ms ·
> `prediction-eval` 286 ms（`no_active_catboost_model`）· `baseline-rebase-review`
> （`review.status = not_evaluable`，见 §五-7）。
> 这一步的用途是抓"工具悄悄坏掉"：批次 19 的消融脚本曾经自 `017bf95` 起完全无法运行，
> 而没有任何门禁会因此转红。

> **计数口径**：node 侧必须用**带引号的 glob**交给 node 自己展开。
> 直接 `npm run test` 在本机（Windows/cmd）只跑到 498 条 —— 那是脚本壳差异，不是回归。
> 18 skipped 是本沙箱既有基线（其中多数依赖 `ps` 探测进程身份，沙箱内 EPERM ⇒ 按设计 fail-safe 跳过）。

---

## 三、§16.1 验收矩阵覆盖状态

> 🔴 **本节此前写的是"52 / 53 有行为覆盖"—— 两个数字都不对，且"有行为覆盖"是无法机械复核的断言。**
> 2026-09-30 实测：矩阵共 **54** 条（不是 53；R1 修订加了 R06/F11–F15/B03/B04/I02/T03），
> 而按 ID 在测试里被引用的只有 **19** 条 —— 但"没引用"与"没覆盖"是两件不同的事，
> 光看数字区分不了。所以本节改为**可执行的判据**，不再给一个靠人读出来的总数。

**现行判据（`npm run check:acceptance-matrix`，已接进 pre-commit）**：把每条判成三态 ——

| 状态 | 含义 | 数量 |
|---|---|---|
| `cited` | 测试里按 ID 引用（机械可查 `\bID\b`） | **50** |
| `declared-gap` | 未被引用，但在检查脚本的 `KNOWN_GAPS` 里**逐条写明缺哪一半** | **4** |
| `missing` | 既未引用也未声明 | **0**（非 0 即失败，退出码 1） |

本轮把 30 条**本来就已被测试覆盖、只是没按 ID 引用**的用例补上了引用
（沿用仓库既有的 `D03:` / `L04:` 前缀约定），19 → 49。

`KNOWN_GAPS` 的 5 条（每条都写明了"哪一半有测试、缺的是哪一半"，不允许空泛写"待补"）：

| ID | 缺的是什么 |
|---|---|
| **F08** | 快速下坡/速度尖峰。**没有覆盖**，且是刻意的：要挡住它需要**新增检测器政策**，阈值必须先独立回放（见 §五-3） |
| **P02** | 环境去偏差的单层行为有测试；「同一历史环境被两层各去一次」的 ledger 断言没有 —— 当前只有 N0 identity adapter，没有第二层 |
| **P04** | race-evidence 单次预算有测试；「Preparation 与 Durability 不重复扣罚」要等 durability 数值罚分启用后才有可断言的路径 |
| **F13** | 「缺天气不冻结负学习」有测试；「报分层接受率/检测延迟」由消融**报告**承担，不是测试 |

> **F02 已于批次 28 关闭**：新增一条用例在**同一对事实源**上同时断言两半
> （`packages/application/test/recovery-isolation-e2e.test.ts` 的
> `F02: the same recovery change downgrades the coach and leaves ability untouched`），
> 而不是把两条各测一半的用例拼起来当作覆盖。它同时暴露了共享夹具的一个性质：
> 该夹具只给静息心率基线，而**单独一个升高的 RHR 按设计就是 `no_low_signal`**
> （`classifyRecoveryFlags` 要求 `sleepLow || (hrvLow && rhrUp)`），
> 所以用例用 `amend` 缝单独补了睡眠基线 —— 否则夹具根本产生不了降阶，测试会"因为错误的理由通过"。

历史逐条对照表见 `archive/RAI_V2_BATCH18_ACCEPTANCE_MATRIX_2026-09-30.md`（其总数口径已过时，
结论仍有效，但请以本节的可执行判据为准）。

**新增覆盖**：

| 状态 | ID | 说明 |
|---|---|---|
| ✅ 批次 18 | F09 / S03 / F07 / L04 / C01（+R01） | 见 `archive/RAI_V2_BATCH18_…md` |
| ✅ 批次 23 | R05 / D03 | 见 `archive/RAI_V2_BATCH23_…md` |
| ✅ 批次 27 | 30 条补引用（19 → 49 cited） | 见 `archive/RAI_V2_BATCH27_ACCEPTANCE_MATRIX_CHECK_2026-09-30.md` |
| ✅ 此前已有 | 其余 47 条 | 每条都指到具名用例（批次 18 的对照表） |

---

## 四、11 项剩余工程项的当前状态

| # | 项 | 状态 | 依据 / 阻塞原因 |
|---|---|---|---|
| 1 | V4 特征全链路 | 🟡 **代码已就绪，真实库未重建** | `recompute-pipeline` 已走 `extractWorkoutFeatureVectorV4` + `encodeFeaturePayloadV4`；本工作区的 `feature_runs` 仍是 v1×7 / v2×5 / **v3×12**，257 条 canonical workout 未重建为 V4。重建属于部署动作（迁移闸门见 §六） |
| 2 | 工程/配置版本落库分离、lineage | ✅ | v24 迁移 + `engine_version` 读端 + API/界面；`ModelLineageV2` 十五个字段齐全 |
| 3 | transition gate v2 + bundle 原子发布 | ✅ | 三态 gate、release bundle、拒绝留痕、回滚语义，均有测试 |
| 4 | assembler freshness 统一 | 🟡 | 到达时间（`latestAvailableAt` / `availabilityUnknown`）已成为可见事实；`as_known_then` 的**裁决**留给第一个真正按该模式回放的调用方 |
| 5 | rebase 发布流程与 epoch 分段曲线 | 🟡 | CLI `rebase` + 检查策略 + 曲线分段 + "两侧不可直接比较"文案已具备；本批给 `reviewBaselineRebase` 补了只读 runner（§五-7），结论 `not_evaluable`（review 历史未持久化，且**当前两个实测门已给出 keep_epoch**）；**`effectiveAt` / `rebaseReason` 仍未落库** |
| 6 | 环境 adapter 生产统一 | 🟡 **覆盖率已实测，仍不足以校准** | 本工作区库（`NORMALIZATION_COVERAGE.json`，257 条 canonical workout）：**温度 8.6%（22）、湿度 8.6%（22）、爬升 61.9%（159）**。N1（复用既有条件惩罚）已在 physiology 落地；状态枚举**不再退化**（`out_of_domain 16`、`not_needed 1`）。但把 comparability 接进学习门控会让 **256/257** 低于门槛，所以 §5.1 的警告仍成立；N3 校准需要更多同条件样本，且 §18.4 禁止自动接入天气服务 |
| 7 | 快照贯穿实际 API | 🟡 | fitness / load / readiness 三域已窄化且有真实消费方；durability / zones 等有消费方再做（不做投机抽象） |
| 8 | Ridge/CatBoost 同样本三方竞争 | ✅ | Python 产 `challengers.json` → TS 导入器 → 既有 `compareResidualChallengers`；缺列按"不能凭缺席获胜"处理 |
| 9 | 区间 calibration 持久化与选择器 | ✅ | 只差"独立标签到位后跑一次真校准" |
| 10 | 跨领域 replay | 🟡 | Fitness（冻结 V1 引擎 vs 当前 V2）、Readiness 两个域有**可跑的 runner**；Load 有纯回放模块但**没有库侧事实装配器**（缺它就必须再写一套 SQL→域映射，正是"两套口径"的开端）；Coach 未做（决策层，无有效对照支） |
| 11 | 候选参数实证与真实退步验收 | ❌ **被真实标签阻塞** | 本工作区 `labeledOutcomeCount = 0`（284 条 workout / 257 条 canonical / 0 条已确认比赛或标准测试），`real_label_smoke = not_evaluable` |

---

## 五、本状态文档新增的七条可执行结论

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

### 4. 🔴 Readiness 在本机库上**一天都判不了**，而且原因是结构性的（2026-09-30 新增）

新增 `deliverables/READINESS_REPLAY_COVERAGE.json`（`npm run data:readiness-replay-coverage`，只读）
给出这个指标的第一个真实数字：

```text
窗口 2024-06-12 .. 2026-07-20（769 天）
coverage        none 768 / partial 1 / complete 0
assessableDays  1        （严格支真正能判定的只有 1 天）
leakageStatus   single_comparable_day ⇒ leakageRate = null（**不是 0**）
asKnownThenBlockedDays  302   （有读数却无法考据到达时间）
```

两个**互不相干**的原因，都已在代码里定位：

1. **`canonical_nights` / `canonical_hrv_days` 各 0 行**，而原始睡眠段有 5222 行、HRV 有 684 行。
   设计文档（`SLEEP_HRV_DESIGN.md` v17 迁移策略）写明的启动期空表回填
   **从未接线** —— 仓库里 `canonicalizeNights` 只被 import CLI 调用。
   本批补上 `npm run data:backfill-canonical-nights`（默认预览，`--apply` 才写）。
   **注意**：回填在真实库副本上已验证（2.65 s → 170 主夜 + 5 午睡 + 170 HRV 日），
   但**不会**让历史日变得可判定 —— 回填行的 `computed_at` 是现在，
   历史某天当时既没有读数也没有基线。**它能修的是未来，不能追溯历史。**
2. **静息心率的到达时间只有"数据集发布上界"**（本机为 2026-07-20 的一次性导入），
   晚于几乎所有观测日 ⇒ 302 天有读数但到达时间不可考。

⇒ 结论：**§7 的 Readiness 在本机基线上不可验收**，且这不是模型问题，是数据到达时间与
canonical 化缺失的问题。`as_known_then` 回放在本库上**永远**不可用。

### 5. ✅ `canonicalizeNights` 的夜表日期范围截断（已修，v1 → v2）

日期范围原来看每个睡眠段的**开始**时刻，而一夜的 InBed/Asleep 段通常开始于**前一晚**。
只要这一夜里**有任何一段**开始于本地午夜之后，范围就已经覆盖它的 wake date；
但如果**所有**段都开始于午夜之前（数据在这一夜中途结束、或这一夜很短），整夜会被丢掉。

**订正**：这一步曾被描述为"每次导入都会丢掉最近的那一夜"——**过强**。实测口径：

```text
本机 3 年库副本   v1 = 170 主夜 / 5 午睡 / 170 HRV 日
                  v2 = 170 主夜 / 5 午睡 / 170 HRV 日   ← 0 差异
```

它是**范围截断**，不是必然命中的缺陷；真实库的末夜恰好有午夜后的段。
修复后 `CANONICAL_NIGHT_ALGORITHM_VERSION` bump 到 `canonical-night-v2`
（`canonicalizeNights` 本就是 DELETE + 全量重建，不产生混排状态）。
合成用例钉住边界，突变（改回只看开始）令 3 条转红。

> **验证纪律补充**：突变验证里"没有转红"**首先**要怀疑"突变是否真的施加了"。
> 本轮第一次突变因 PowerShell 替换静默失效而得到"全绿"，若据此断言
> "这些断言没有牙齿"就会得出与事实相反的结论。

### 6. 🔴 方案 §1.5 记录的是**另一台主机的库**，与本文的数字系统性不同

本次对 `D:\running\var\rai.sqlite` 做**只读**实测（文件 mtime 仍是 2026-09-28 16:29，未被任何操作写过）：

| 项目 | 方案 §1.5（macOS） | 本工作区实测 | 结论 |
|---|---|---|---|
| migration 最大版本 | 22 | **22** | ✅ 一致 |
| canonical workout 数 | 268 | **257** | 🔴 不同 |
| active run 的 `model_version` | `rai-model-config-v3` | **`rai-model-config-v2`** | 🔴 不同 |
| active run 的 `evaluated_at` | `2026-09-04T08:53:46.059Z` | **`2026-07-20T02:51:58.706Z`** | 🔴 不同 |
| active 特征契约 | `workout-feature-v3` | `feature_runs` = v1×7 / v2×5 / **v3×12** | 🟡 同代不同批 |
| `prediction_model_runs` | 0 | **0** | ✅ 一致 |
| 恢复事实（夜/HRV） | 未记录 | **canonical 各 0 行**（原始睡眠 5222 / HRV 684） | §五-4 |
| 天气字段可得率 | 温度 0% | **温度 8.6% / 湿度 8.6% / 爬升 61.9%** | 🔴 不同 |

**这不是"两台机器数据略有差异"，而是曾经拿另一台机器的产物当本工作区的事实**：
`deliverables/NORMALIZATION_COVERAGE.json` 与 `PHASE0_BASELINE.json` 等四份 JSON 的
`databasePath` 写的是 `/Users/ta/running/var/rai.sqlite`。批次 24 之前，
"环境 adapter 被 0% 天气可得率阻塞"这个结论就是从那份**别的库**的报告里读出来的；
本库的真实类似结论应当改为"8.6% 温度/湿度、61.9% 爬升，仍不足以校准"。

**已做的处置**：

- 用本工作区的库**重新生成** `NORMALIZATION_COVERAGE.json`（`databasePath` 现在写的是
  `D:\running\var\rai.sqlite`）；`CA_WEIGHT_ABLATION.json` 与 `READINESS_REPLAY_COVERAGE.json`
  本来就是在本库生成的。
- `deliverables/README.md` 的产物表新增 **`databasePath` 一列**，标出四份**不可在本工作区复现**
  的 macOS 时点快照 —— 结构上防止同一类误读复发。
- 方案主干（`RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md`）**不改**：它是一份注明日期与
  核验提交的文档，记录 macOS 基线是合法的。要防的是"把它的数字当成本工作区的现状"。

### 7. 🟡 §6.4 的 rebase 检查**没有生产调用方**，且它的结论目前**不可评估**

`reviewBaselineRebase` 有实现、有单测，但仓库里唯一的引用是它自己的测试文件 ——
检查政策（每 28 天最多一次 / 冷却 90 天 / 饱和触发）从未在真实数据上跑过。
这与批次 19 的消融脚本、批次 24 之前的 `replayReadinessRulings` 是同一类问题。

新增只读 runner（`npm run data:baseline-rebase-review`）后，本机实测：

```text
epoch 起点 2024-07-13（checkpoint baseline.calibrationEndAt）· checkpoint v1 · eligibleWorkoutCount 132
窗口 2026-06-22 .. 2026-07-20（28 天，取自政策）· eligible 9 / 独立训练 9 / 覆盖 7 天
饱和 saturatedFraction 0.111（只有 recovery 维度 1/9）· 阈值 0.2 ⇒ 未触发
review not_evaluable / review_history_not_persisted
```

`reviewBaselineRebase` 的六个输入里，`lastReviewedAt` 与 `precedingSaturatedReviews`
**没有持久化**。**不用默认值补上**：后者直接决定 `candidate_requested` 还是 `keep_epoch`
（填 0 ⇒ 永远 keep_epoch；填 1 ⇒ 只要这次饱和就请求候选），
两个都是确定但任意的答案，会把"缺状态"伪装成"检查结论"。

🔴 **这条实测改变了优先级**：三个门里已经有两个**按实测数据**给出"保持当前 epoch"
（饱和未触发 0.111 < 0.2；独立训练 9 < 12）。所以"缺 review 历史"**目前不是阻塞项** ——
补一张 review 历史表不会改变今天的结果。这比"文档说要持久化就去持久化"省一次无谓的迁移。

---

## 六、未执行的动作（明确列出，避免被读成"已完成"）

| 动作 | 为什么没做 |
|---|---|
| 本地库迁移到 v24 | 本机仍是 schema 22；属于部署动作，需停止 API + 一致备份 + `data:migrate --apply`。代码与迁移测试已就绪 |
| **执行 `data:backfill-canonical-nights --apply`** | 会写 `canonical_nights` / `canonical_hrv_days`（本机 0 → 175 行）。已在**副本**上验证可行，但改的是用户库，留给用户决定 |
| **把空表回填接进 API 启动路径** | 设计文档要求接线，但那条路径的失败语义是 `databaseRecoveryRequired`（整个 API 拒绝就绪）。对一次可重试的回填来说代价过高，需单独决策 |
| 全量 V4 重算 | 会改变 active run；属部署动作 |
| 模型训练 / 激活 / 校准 | 标签为 0；ML 与经验区间**必须保持未激活** |
| 线上部署 | 超出本方案范围 |
| 接入天气服务 | §5.2 第 3 条要求另批 provider/缓存/隐私/成本；§18.4 明确不做 |
| 任何阈值调整（含 §6.9 门控） | §6.9-6 的预注册未冻结；`labeledOutcomeCount = 0` ⇒ 最大误判下降率无法测量 |

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

| 文件 | 生成命令 | `databasePath` |
|---|---|---|
| `CA_WEIGHT_ABLATION.json` | `npm run data:ablation-ca-weights -- --database var/rai.sqlite --out deliverables/CA_WEIGHT_ABLATION.json` | `D:\running\var\rai.sqlite` |
| `READINESS_REPLAY_COVERAGE.json` | `npm run data:readiness-replay-coverage -- --database var/rai.sqlite --out deliverables/READINESS_REPLAY_COVERAGE.json` | `D:\running\var\rai.sqlite` |
| `NORMALIZATION_COVERAGE.json` | `node --import tsx scripts/normalization-coverage.mts --database var/rai.sqlite --out deliverables/NORMALIZATION_COVERAGE.json` | `D:\running\var\rai.sqlite` |
| `MODEL_VERSION_REPLAY_2026-09-29.json` | `node --import tsx scripts/model-version-replay.mts --database var/rai.sqlite` | 🔴 **另一台主机（macOS）**；脚本可跑，需重新生成才是本库 |
| `RAI_V2_ABLATION_2026-09-29.json` / `RAI_V2_BOUNDED_CANDIDATE_2026-09-29.json` / `RAI_V2_EVALUATION_2026-09-29.json` / `PHASE0_BASELINE.json` | 09-28/09-29 会话产出 | 🔴 **另一台主机（macOS）**，生成器不可用 |
| `PREPARATION_MIGRATION_GOLDEN.json` | 专项准备度迁移 golden | 未声明 |

> 引用这些产物时**必须同时给出生成脚本与数据口径**。它们是派生数据，不是结论。

### 过程与历史

`archive/` 保留全部批次记录与审计；**归档文档的结论默认视为过期**，引用前先确认是否已被本文件取代。

---

## 八、下一步（按"是否被阻塞"排序）

**可立即推进（无阻塞）**

1. **决定是否执行 `data:backfill-canonical-nights --apply`**，以及是否按设计文档把空表回填
   接进 `recoverDatabaseJobs`。两者都已在副本上验证可行；差别只在失败语义
   （接线后回填失败 ⇒ `databaseRecoveryRequired`，整个 API 拒绝就绪）。
2. §6.4 的 `effectiveAt` / `rebaseReason`：需要先把 rebase review 状态（上次检查时间、连续饱和次数）持久化，
   否则 `rebaseReason` 只能是一个编出来的枚举值。
3. §13.3 的 `CoachDecisionV2` 版本化输出：需要先把 `tone + next session` 到 `action` 的映射设计清楚，
   并保证它是**同一个决策**的兼容映射，而不是第二套裁决。
4. ~~修 `canonicalizeNights` 的末夜边界~~ —— **已完成**（批次 25，`canonical-night-v2`）。
   下一步是决定是否对真实库执行一次 `data:backfill-canonical-nights --apply`
   （它会让夜表从 0 行变成约 175 行，但**不会**让历史日变得可判定）。

**被数据阻塞（等条件，不等代码）**

5. 环境 adapter N3：本库温度/湿度可得率 **8.6%**、爬升 **61.9%**（不是 0%）。要校准仍需更多同条件样本，且须独立回放后才可接入。
6. 区间校准 / CatBoost 激活 / Durability 数值：等 ≥24 条独立、无泄漏、用户确认的比赛或标准测试结果。
   标签闭环的**软件部分**已完成并有测试（`label-funnel.test.ts`），缺的是**真实结果本身**。
7. **Readiness 的实证验收**：本机 769 天里只有 1 天可判定（见 §五-4）。
   要让 Readiness 可验收，需要**增量导入**（产生真实的记录级到达时间），
   而不是再补一个一次性回填。

**被授权阻塞**

8. 本地库迁移 + 全量 V4 重算 + bundle 发布（§17.6 Phase 5）：需要停止 API、一致备份、并承担一次
   active run 切换；应在单独一轮中按迁移闸门执行。

**需要新政策（必须先回放）**

9. F08 的速度合理性检测器：先做**检测率盘点**（报告而不猜测），再决定是否成为门控。
