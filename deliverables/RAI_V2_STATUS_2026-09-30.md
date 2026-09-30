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

方案主干（P0/P1 的工程边界）**已实施并逐条有测试**；§16.1 的验收矩阵改为**可执行判据**：**54 条全部按 ID 被引用，缺口声明清零**（§三）。三条独立只读审计（§十）收窄了本文档的若干说法，其中两条是**它自己发现的真实缺陷**，已修并加了回归用例。
§18.5 的最终验收条件逐条走查见 §九。🔴 **该节原写"8 条工程条全部满足"，2026-09-30 的独立审计推翻了它**：
实际是 **7 条明确成立**（1–7；其中 5 与 7 补上了缺失的测试，1 还发现了原先没写进证据的**运行时闸门**）、**第 8 条建立了判据但尚未被真实产物行使**。条件 3 我中途一度误判为"只成立一半"，是**测量错位**（改了 checkpoint 版本却去观察特征复用），已在 §15.5 订正。
已按审计结论改写 §九。4 条精度条仍是 `not_evaluable`（0 标签）。
剩余的不是"还没写"，而是三类**不能靠写代码解决**的事：**被真实标签阻塞**、**被天气数据阻塞**、
**需要新增政策且必须先回放**。精度增强（ML、经验区间、Durability 数值、耐久罚分）**全部未激活**，
且**不应**在没有独立标签的情况下激活。

---

## 二、当前门禁（独占实跑，2026-09-30）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（现覆盖 `packages/`、`apps/`、**`scripts/`**） | **0** |
| node 侧全量 | `node --import tsx --test "packages/*/test/*.test.ts" "apps/api/test/*.test.ts"` | **1133 tests / 1115 pass / 0 fail / 18 skipped** |
| web 侧全量 | `npm run test -w @rai/web` | **18 文件 / 111 tests / 0 fail** |
| Python | `research\.venv\Scripts\python.exe -m pytest research/tests -q` | **26 passed** |
| 文档行号引用 | `npm run check:doc-refs` | 越界 2 / 漂移 99 / 空行锚 7（**已知且未扩大**；漂移来自 09-28 之后合法的源码演进） |
| **只读工具链全量实跑** | 7 个可直接跑的 CLI/脚本，逐一实跑 | **全部 exit=0，且 `var/rai.sqlite` 逐字节未变**（见下） |
| §16.1 验收矩阵 | `npm run check:acceptance-matrix`（**只认测试标题**，见 §十四） | **54 条 / cited 53 / declared-gap 1（T02）/ missing 0** |
| 包边界 | `npm run check:package-boundaries` | **15 个包 / 30 条 src 边 / 禁线 4 条 → 通过** |
| 速度合理性盘点 | `npm run data:speed-plausibility` | **11835 样本 / 0 越界**（只读，exit 0） |

> **工具链实跑（最新一轮，均只读）**：
> `ablation` 627 ms · `readiness-replay-coverage` 1846 ms · `rebase-review` 492 ms ·
> `speed-inventory` 555 ms · `normalization-coverage` 529 ms · `model-version-replay` 357 ms ·
> `phase0-baseline` 453 ms —— 全部 exit=0，跑前跑后 `var/rai.sqlite` 的 SHA-256 相同。
> 这一步的用途是抓"工具悄悄坏掉"：批次 19 的消融脚本曾经自 `017bf95` 起完全无法运行，
> 而没有任何门禁会因此转红。
> 另有 `walk-forward` / `prediction-eval` / `model-v2 inspect` / 两个**文件入参** CLI
> （`model-replay`、`prediction-challengers`，缺入参时按设计非 0 退出）。

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
| `cited` | 测试里按 ID 引用（机械可查 `\bID\b`） | **51** |
| `declared-gap` | 未被引用，但在检查脚本的 `KNOWN_GAPS` 里**逐条写明缺哪一半** | **0**（清单已空，且这是有意的） |
| `missing` | 既未引用也未声明 | **0**（非 0 即失败，退出码 1） |

本轮把 30 条**本来就已被测试覆盖、只是没按 ID 引用**的用例补上了引用
（沿用仓库既有的 `D03:` / `L04:` 前缀约定），19 → 49。

`KNOWN_GAPS` 的 **1** 条（每条都写明"哪一半有测试、缺的是哪一半"，不允许空泛写"待补"）：

| ID | 缺的是什么 |
|---|---|
| **P04** | race-evidence 单次预算有测试；「Preparation 与 Durability 不重复扣罚」要等 durability 数值罚分启用后才有可断言的路径 |

> **F08 / P02 已分别于批次 34 / 35 关闭**：F08 的检测器与检测率盘点见 §五-3；
> P02 的环境责任账本见 §五-10。检查脚本自己的**过期声明守卫**两次逼我删掉已经过时的缺口声明
> —— 缺口清单只能记"现在缺什么"，不能变成历史存档。


> **F02 已于批次 28 关闭**：新增一条用例在**同一对事实源**上同时断言两半
> （`packages/application/test/recovery-isolation-e2e.test.ts` 的
> `F02: the same recovery change downgrades the coach and leaves ability untouched`），
> 而不是把两条各测一半的用例拼起来当作覆盖。它同时暴露了共享夹具的一个性质：
> 该夹具只给静息心率基线，而**单独一个升高的 RHR 按设计就是 `no_low_signal`**
> （`classifyRecoveryFlags` 要求 `sleepLow || (hrvLow && rhrUp)`），
> 所以用例用 `amend` 缝单独补了睡眠基线 —— 否则夹具根本产生不了降阶，测试会"因为错误的理由通过"。

> **F13 已于批次 29 关闭**：「报分层接受率/延迟」这一半此前只存在于**产物**里而没有进入**契约** ——
> `acceptanceByGroup`（按 `stratum:` / `session:` / `source:` / `environment:` 四轴分层）
> 与 `negativeOpportunitiesToFirstAcceptance` 本来就在 `CA_WEIGHT_ABLATION.json` 里，
> 但 `assertCaWeightAblationReport` 不要求它们，**删掉也不会有任何检查转红**。
> 现在契约要求：每个候选必须有非空的 `acceptanceByGroup`、必须含 `session:` 与 `stratum:` 两轴
> （只报一个轴等于把分层退化成总量）、每组必须带机会数与接受数（分母为 0 要**看得见**是 0）、
> 接受数不得超过机会数，且**一旦接受过负向学习就必须报出检测延迟**。
> 「不因 `unavailable` 一律冻结」那一半仍由 `environment-does-not-freeze-learning.test.ts` 覆盖。

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

## 五、本状态文档新增的十条可执行结论

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

### 3. F08 的**检测率盘点已做完**：本库一个尖峰都没有（2026-09-30 更新）

现行政策下正向一侧同样被强门控（见上表），"只防下降不防虚高"不是当前可观测的失效模式。
方案给的下一步不是"上线一个阈值"，而是 §17.3 的**先盘点**。这一步已完成：

- 检测器：`packages/features/src/speed-plausibility.ts`（8 条用例）。
  **判定上限不是新参数**，由既有准入常量 `minimumPaceMinutesPerKilometer`（2.5 min/km ⇒ 6.667 m/s）
  导出 —— 那条规则本来就说"一次训练的平均配速不得快于此值"，样本级判定是它的自然外推。
- 盘点：`npm run data:speed-plausibility` → `deliverables/SPEED_PLAUSIBILITY_INVENTORY.json`。
  数据源是 `HKQuantityTypeIdentifierRunningSpeed`，**正是 `RecomputePipeline` 喂给特征的时间线**
  （`runningSpeedType`），所以这是管线输入的分布，不是远端代理。

| 指标 | 实测（11835 个样本） |
|---|---|
| 归一化后分布 | min 0.075 / p50 2.671 / p99 3.407 / **max 4.101 m/s** |
| 超过 2.5 min/km 上限 | **0**（上限 6.667 m/s，max 还差 38%） |
| 单位构成 | `km/hr` 7843、`m/s` 3992；**缺失单位 0** |

🔴 **第一版盘点得到的是假结论，必须记下来**：`unit` 列**不唯一**，我把两种单位混在一起排序，
于是得出"**7781/11835 个样本超限**"这种惊人的结果。按单位拆开归一化后是 **0**。
单位混用不是这个脚本特有的问题 —— 它正是 `convertSpeedToMetersPerSecond` 存在的理由，
所以脚本一律经**同一个**函数归一化（并因此把该函数从 `@rai/application` 导出，
而不是在报告里再写第二套单位逻辑）。

**第二个发现同样来自实测**：同一块表在本库以 **4 种编码拼写**出现
（`唐攀的Apple Watch` / `唐��的Apple Watch` / `��攀的Apple Watch` / `唐���的Apple Watch`）。
于是 `speedSourceBreakdown` 会把"一块表"报成"多个来源"。§6.9 把"设备切换"列为正向异常信号，
**若直接拿 `source` 串当设备身份，那个信号会在编码假象上持续误报**。身份归一化是它的前置条件；
这条已写进模块注释、盘点产物与这里的限制清单。

**F08 现在缺的不是检测能力，而是"接进学习门控后的效果"** —— §17.3 要求那一步回放，
不能靠读代码断言。因此它已从 `check-acceptance-matrix` 的 `KNOWN_GAPS` 移出（改用例引用），
门控效果记在本节而非缺口清单里。

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
多份 JSON 的 `databasePath` 写的是 `/Users/ta/running/var/rai.sqlite`。批次 24 之前，
"环境 adapter 被 0% 天气可得率阻塞"这个结论就是从那份**别的库**的报告里读出来的；
本库的真实类似结论应当改为"8.6% 温度/湿度、61.9% 爬升，仍不足以校准"。

**已做的处置（批次 30 完成收尾）**：

- 用本工作区的库**重新生成**全部**可复现**的产物：`NORMALIZATION_COVERAGE.json`、
  `PHASE0_BASELINE.json`、`MODEL_VERSION_REPLAY_2026-09-30.json`；`CA_WEIGHT_ABLATION.json`、
  `READINESS_REPLAY_COVERAGE.json`、`BASELINE_REBASE_REVIEW.json` 本来就是在本库生成的。
- 🔴 **订正我自己的上一版 README**：它把 `PHASE0_BASELINE.json` 标为"生成器不可用"，
  而 `scripts/snapshot-phase0-baseline.mts` **一直存在**。是核实不足，不是真的没有工具。
- 四份**确实没有生成器**的（已核对 `scripts/` 与全部源码）移入 `archive/`：
  `RAI_V2_ABLATION_2026-09-29.json`、`RAI_V2_BOUNDED_CANDIDATE_2026-09-29.json`、
  `RAI_V2_EVALUATION_2026-09-29.json`、`MODEL_VERSION_REPLAY_2026-09-29.json`。
  它们只能回答"当时发生了什么"。
- 两份**同脚本**基线产物的直接对照（这是比读文档更硬的证据）：

| 字段 | macOS 版（已入 `archive/`） | 本工作区重生成 |
|---|---|---|
| `database.path` | `/Users/ta/running/var/rai.sqlite` | `D:\running\var\rai.sqlite` |
| `activeTrainingSessions` | **268** | **257** |
| `modelRuns` | **6** | **24** |
| `activeModelRun` | **`rai-model-config-v3`** | **`rai-model-config-v2`** |

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

### 8. ✅ §15.8 的统一报告从"约定"变成"条件"

§15.8 规定"每个版本比较产物至少包括"八项。实测（2026-09-30）此前只有最新那份
（跨版本回放）带得起全部信息：`repoRevision` 只在三份里有、`reproduce` 只有一份有、
gate 状态只有一份有、`notEvaluable` 只有一份有 —— 也就是说，**一份产物可以把溯源信息
整个丢掉，而没有任何检查会转红**。

现在 `@rai/model-eval` 提供 `evaluationReportEnvelope` + `assertUnifiedEvaluationReport`
（`rai-eval-report-envelope-v1`），四份产物全部改为经它组装并**在写盘前自检**：

| 产物 | gates | notEvaluable |
|---|---|---|
| `CA_WEIGHT_ABLATION.json` | 3（含 `negative_learning_never_accepted=failed`） | 3 |
| `READINESS_REPLAY_COVERAGE.json` | 2（两项均 `not_evaluable`，各带原因） | 1 |
| `BASELINE_REBASE_REVIEW.json` | 3（`saturation_trigger=failed`、`minimum_independent_sessions=failed`） | 2 |
| `NORMALIZATION_COVERAGE.json` | 2（`comparability_wired_into_learning=failed`） | 2 |

检查范围**刻意只收在机器可核对的公共部分**：谁生成的、描述哪份库、哪个提交、怎么复现、
gate 三态、未评估项及原因。指标形状因领域而异（Fitness 比 CA/TA，Readiness 比裁决，
预测比秒数），强行统一只会逼出空字段。

两条判据值得单独记：**`repoRevision` 允许 null 但必须显式出现**（"少一个键"与
"当时确实不知道"是两件事）；**`status: not_evaluable` 的 gate 必须写原因** ——
不写，读的人会以为它没必要评估。`not_evaluable` 是正式状态，不是自动通过或失败。

### 9. ✅ §7.7-5 / §13.4 的依赖约束此前**没有任何东西在守**

方案两处要求同一条不变量（"scoring 不 import readiness、API、storage"），
并要求"不只依靠源码字符串 grep"。实测：**这条不变量今天成立，但拦不住任何人** ——
workspace 依赖允许写 `"@rai/readiness": "*"`，一旦有人加上，编译照过、测试照绿，
而"恢复不再影响 Fitness"这条 P0 不变量已经被悄悄破坏。

新增 `npm run check:package-boundaries`（已接进 pre-commit），四类判据各拦一种漂移：

| 判据 | 拦住的漂移 |
|---|---|
| **A 分层** | `packages/*/src` 不得 import `apps/*`（**只查 src**：仓库既有先例是包级测试可以 import app 实现） |
| **B 具名禁线** | scoring 不得触达 readiness / storage-sqlite / application / model-eval，每条禁线**写明理由**，报错信息本身就是设计说明 |
| **C 声明↔实际** | package.json 声明的 workspace 依赖必须与 src 实际 import 一致，**两个方向都查** |
| **D 边集白名单** | workspace→workspace 的边逐条列出；新增一条边必须有意改文件，review 时一定看得见 |

**顺手查出一处真实不一致**：`@rai/normalization` 声明了 `@rai/contracts`，
但 **src 与 test 都没用过** —— 声明比实际宽，会让人误判这个包允许依赖谁。已删除。

突变验证：让 `scoring` import `readiness` ⇒ **三条判据同时转红**（B 禁线、C 未声明、
D 未列边）；往白名单塞一条不存在的边 ⇒ 报"已不存在，请删除"，防止清单变成永久豁免。

> **一个必须记下来的自伤**：这个检查的第一版用了过宽的正则 `/@rai\/api/` 来识别"app 依赖"，
> 而 `@rai/api-contracts` 是**合法的契约包** —— 于是它报了 **57 处假阳性**。
> 假阳性比漏报更能毁掉一个门禁：它逼人把检查关掉。修正后只剩 1 处真阳性。

### 10. ✅ P02：环境责任账本从"能重建"升级到"能认出重复"

§5.5 允许"过去热天去偏差 + 未来热天加情景"（**两个不同对象**），
禁止"同一历史热惩罚被 adapter 与 `performanceVdotEvidence` 各去一次"。

实测：现行账本已经能验证 `after − before` 逐项重建最终成绩，但它**不记录每一步作用于什么证据**。
于是最危险的那种重复恰好漏网 —— 若某个 owner 把热惩罚折进 `potentialSeconds`（账本起点**之前**），
链式重建照样成立、断言照样通过，而惩罚已经扣了两次。

现在 `PredictionCorrectionStep` 声明 `object` / `ownerVersion` / `inputHash` / `applied` / `reasonCodes`，
由 `@rai/model-eval` 的 `assertPredictionCorrectionLedger` 断言三条规则：

| 规则 | 内容 |
|---|---|
| 1 重建 | applied 步骤按序叠加必须精确得到 `predictedSeconds`；每个 applied 步骤边界必须有限；**零变化且无理由的 applied 步骤**被拒（否则"什么都没改"与"漏了一整类修正"无法区分） |
| 2 不重复责任 | 同一 `(kind, object, inputHash)` 至多一个 `applied: true`，报错时**点名两个 owner** |
| 3 历史去偏差不得出现在 potential 之后 | `potentialSeconds` 的定义就是历史归一化之后；该步以 `applied: true` 出现在这条链上即判违规 |

`inputHash` 在真实路径上**不是占位符**：environment/elevation 两步消费的就是
`report` 的目标情景，所以取它的语义 hash —— 同一份情景被去两次时规则 2 抓得住。

**两处接线**，且第二处追加步骤后会**重新走一遍断言**（否则追加的那一步会绕过校验）：
主链在 `buildPredictionReportContext`，CatBoost 点修正在 `withSelection`。

**突变验证（含一次自我纠正）**：把 environment 步的 `object` 改成 `historical_evidence`。
第一次只跑了 `prediction-report.test.ts` ⇒ **3 passed / 0 failed**，看起来像"断言没牙"。
按批次 25 的纪律先怀疑"路径没走到"，改跑整个 `packages/application/test` ⇒
**`not ok 558 - P03: V2 prediction modes ... reconstructible correction ledger` 转红**。
即：**是文件选错了，不是断言无效** —— 这条规则的就地验证落在 P03 的整链路用例里。

**保留的诚实边界**：目前只有一个层（N0 identity + `performanceVdotEvidence`），
所以"两层各去一次"是**构造出来的**，不是线上可复现的。账本的职责正是**阻止**它，
而"阻止"这一点是可断言的；N2 落地后应再加一条"两个真实 owner"的用例。

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
| `MODEL_VERSION_REPLAY_2026-09-30.json` | `node --import tsx scripts/model-version-replay.mts --database var/rai.sqlite --out deliverables/MODEL_VERSION_REPLAY_2026-09-30.json` | `var\rai.sqlite`（**本工作区**） |
| `PHASE0_BASELINE.json` | `node --import tsx scripts/snapshot-phase0-baseline.mts --database var/rai.sqlite --out deliverables/PHASE0_BASELINE.json` | `D:\running\var\rai.sqlite`（**本工作区**） |
| `BASELINE_REBASE_REVIEW.json` | `npm run data:baseline-rebase-review -- --database var/rai.sqlite --out deliverables/BASELINE_REBASE_REVIEW.json` | `D:\running\var\rai.sqlite` |
| `archive/RAI_V2_ABLATION_2026-09-29.json` 等四份 | 09-28/09-29 会话产出（**无生成器**，已核对 `scripts/` 与全部源码） | 🔴 另一台主机（macOS）的库，**只作历史，不代表本工作区** |
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

---

## 九、§18.5 最终验收条件逐条走查

方案的收尾条件分三块：**8 条工程发布条件**、**R1 新增合同闭合**、**4 条精度增强条件**。
本节逐条给出**证据**，而不是结论；每条证据都落到 §16.1 的用例 ID 上 ——
那些 ID 的"确有测试"由 `npm run check:acceptance-matrix` 机械保证（§三），
所以这张表不会随代码漂移而悄悄失真。

### 9.1 工程发布条件（§18.5 第 1–8 条）—— 🔴 **订正为「7 明确 / 1 判据已建立但未被行使」**

> **本节原写"8/8 满足"，是错的。** 2026-09-30 的独立审计逐条复核后推翻了这个结论，
> 下表按审计结果改写。三条订正的共同原因是同一个：**"代码里实现了"被当成了"有东西在守"**。

| # | 条件 | 审计结论 | 依据 / 缺口 |
|---|---|---|---|
| 1 | Fitness 恢复隔离全链路成立 | ✅ **成立（且有运行时闸门，比用例更强）** | `recompute-pipeline.ts:977-981` 每次抽特征都跑**反事实**（把 RHR/HRV/睡眠/近期负荷换成极端值重算）并比较 `semanticHash`，结果进 `rai-bootstrap-invariants-v1` gate，`blocksActivation` 为真时 `:291` **抛错** —— 即这条不变量不只"当时被测过"，而是**每次重算都必须成立，违反会阻断激活**。另有 `recovery-isolation-e2e.test.ts` 从**原始事实装配入口**跑（注入 health_records/workouts/training_sessions，经 pipeline 私有 seam），不是手搓 feature；两个变体的 `restingHeartRateReference` 都是 50、HRR 分数相同 ⇒ 课型相同。配 F02/F05/F07 |
| 2 | 历史/可得时间、epoch、config/schema 一致 | ✅ **成立** | `packages/readiness/src/index.ts:265-281` 三段时序硬校验（`observed ≤ asOf ∧ arrived ≤ asOf ∧ arrived ≥ observed`）+ localDate 匹配，否则该信号不可得；epoch 由 `service.test.ts:865` 钉住（同一 epoch 稳定、rebase 后改变、旧快照逐字节不变）。⚠️ 附带订正：`ModelLineageV2` 确有 15 个字段，但 `domain-snapshot-narrowing.test.ts` 的 15 例测的是**载荷窄化**，不是逐字段谱系 —— 原表把两个 15 说成对应关系，属于巧合而非证据 |
| 3 | 新旧合同兼容、无 checkpoint 跨版本复用 | ✅ **成立（模型状态那半只由代码守）** | **两层各有自己的版本闸**：① 模型状态复用由 `recompute-pipeline.ts:1708` 的六个相等条件管（`checkpoint_version`/`model_version`/`model_config_hash`/`feature_schema_version`/`feature_config_hash`/`timezone`），`:1736-1739` 在 `pendingNegativeIds` 缺失时返回 null（拒绝而非补默认）；② **特征**前缀复用由 `reuseFeaturePrefix`（`:1015+`）自己的特征层版本管（`FEATURE_CONFIG_VERSION`+config、`FEATURE_SCHEMA_VERSION`、`parser_contract_version`、timezone，任一不等即整段重算）—— 特征复用本来就该由特征版本决定，不是 checkpoint 版本。S03 钉住了②的 config 一半。**唯一仍窄的缺口**：`grep rai-model-checkpoint-v1` 全仓 0 命中，没有测试构造过真正由旧版本写下的 checkpoint，所以①只有代码证据（详见 §15.5，我中途一度误判为"未被证明"） |
| 4 | Load/Zone 数值主线一致 | ✅ **成立** | **L01** golden parity（`:537-543`）并钉住具体数值（`load.load === 78`、距离修正后 86.25）；**L02/L04** mechanical 保持 null、未观测前史不补零；**Z01** 生效日期、**Z03** 30 s 滞后不构成冲突 |
| 5 | Prediction 无重复 correction | ✅ **成立（本批补齐了缺的那一半）** | 排他过滤原本只是 `buildPredictionReport` 里的一行内联 `filter` —— 那条路径要开库、要有已激活的 CatBoost 才走得到，所以审计判定"实现存在、测试不存在"。已把规则提成纯函数 `excludeCatBoostCorrectedDistances` 并加 4 条断言钉住：CatBoost 修过的距离必须从 bias 名单移除、没有 CatBoost 时名单原样保留、名单里有但本轮没有该距离预测时**保守保留**、全被修正时结果为空。突变验证：`!==` 改 `===` ⇒ 该用例转红 |
| 6 | Coach 不重算、理由与动作一致 | ✅ **成立** | `mobile-coach.ts:202-205` 四个恢复阈值是 `READINESS_*` 的**别名**而非字面量；`:1489-1501` 只做翻译后委派；`coach-decision-v2.test.ts` 的换文案 `deepEqual` 断言比"action/tone/codes 不变"更强 |
| 7 | 发布原子性、回退、旧工件保留 | ✅ **成立（本批补齐了缺的那一半）** | 原子性与失败回退本来**有**测试（`model-release-v2.test.ts`：注入失败后指针仍在 `a`、候选 `activated_at` 为 NULL；未通过的 gate 拒绝激活；封存快照不可变；数据集变化后拒绝回滚）。缺的是**回滚依赖保留**：审计指出没有任何 prune 用例写入 `model_release_bundles`，于是 `database.ts:2872-2874` 的"bundle 引用 ⇒ 保留"一次也没执行过。已加两条互为正反的用例：① 有 bundle 引用时该 run 必须存活、bundle 行必须还在、`foreign_key_check` 为空；② **没有**引用时老 run 仍须被清掉（缺这条，"保留"可以退化成"永不删除"而①依然全绿）。突变验证：把保留循环短路 ⇒ ①转红，报的是 `FOREIGN KEY constraint failed` —— 正好暴露第二条防线（`ON DELETE RESTRICT` 会让误删**抛错**，而不是留下悬挂引用） |
| 8 | 性能报告真实测量 | 🟡 **判据已建立（本批），但尚未被真实产物行使** | B5 那一行确有其事且结论正确（"21.7 s → 3.0 s"被受控探针推翻：预热缓存、3 轮中位数、单一变量下 **5,790 ms → 6,919 ms，慢约 19%**；"21.7 s"出自冷首跑、"3.0 s"冷热都不出现 ⇒ 跨条件拼接）。此前这条**只靠人把一句诚实的更正写进 markdown**。本批在 `@rai/model-eval` 里加了 `PerformanceComparison` + 断言：要比两个数，**两边**都必须声明 `subject/cacheState/rounds/environment`，且三者逐项相等、`rounds ≥ 2`、必须写出唯一变量 —— 条件不等直接抛，报错文案就是"a ratio between two different conditions is cross-condition stitching"。**第一条用例复刻的正是 B5 的形状**（冷首跑 1 次 vs 热跑 3 次）并被拒绝。⚠️ 诚实边界：它管的是**产物格式**，管不到 markdown 散文；而且当前没有任何产物携带性能声明，所以这条判据**还没被真实数据行使过** |

**共同教训（写进 §十四）**：三条订正都是"实现 ≠ 有守卫"。而它之所以此前看不出来，是因为
**矩阵检查把"文件正文里出现过这个 ID"当成"被引用"** —— 注释和时间戳模板都能满足它。
该口径已收紧为只认测试标题，收紧后立刻机械地暴露出 F01/T01/T02 三条（其中 F01/T01 断言本就存在、
只是标题没带 ID，已补；T02 是真实缺口，已如实声明）。

### 9.2 R1 新增合同闭合 —— **6/6 满足**

| 合同 | 证据 | 判定 |
|---|---|---|
| Readiness state 级 heuristic 标记 | **R06**：旧恢复阈值命中任意 state 时 `stateEvidence` 仍为 `heuristic_rules` / `not_empirically_validated`，且消费端保留 | ✅ |
| confidence null 传播 | **F14**（`modelConfidence=null` 但规则因子有效 ⇒ E 有值、overall=null）、**F15**（null / 0 / NaN 三种情形分别处理，无默认填补） | ✅ |
| 分桶配置与双向接受率报告 | **F12**（稀疏桶双向都不可学）、**F11**（消融报告契约）、**F13**（分层接受率与检测延迟入契约） | ✅ |
| rebase 用户解释 | **B03**（检查不等于自动切换，理由/样本/epoch 可追溯）；曲线分段与"两侧不可直接比较"文案见 `AbilityChart.tsx` | ✅ |
| 标签漏斗 | **T03**（不合格/重复/更正/撤销都对得上账、理由可见） | ✅ |
| 区间产品文案 | 两个**不同界面**各有断言，不是一句话覆盖两个面：`apps/web/test/pages.test.tsx` 在 **PredictionsPage** 上断言"参考区间（**非 P80/P90 保证**）"、"请把区间而不是单一点值作为主要参考"、"尚无合格标签，不能证明预测准确率或激活精度增强"；`historical-model-review.test.tsx` 检查**禁用措辞**（医学阈值/确诊/保证性结论）并以 **R06** 断言保存的 readiness 状态保留 heuristic 标签 | ✅ |

### 9.3 精度增强条件（§18.5 第 9–12 条）—— **4/4 `not_evaluable`**

| # | 条件 | 现状 | 判定 |
|---|---|---|---|
| 9 | 充分且无泄漏的已标记结果；目标距离逐项达标 | `labeledOutcomeCount = 0`（284 条 workout / 0 条已确认比赛或标准测试） | ❌ **`not_evaluable`** |
| 10 | CatBoost 同时优于适用基线和 Ridge，并满足既有强门槛 | `prediction_model_runs = 0`；无训练记录 | ❌ **`not_evaluable`** |
| 11 | 区间独立校准、独立测试、coverage/width/样本同时合格 | 无 calibration artifact；四份产物的 `notEvaluable` 均列出该项 | ❌ **`not_evaluable`** |
| 12 | 样本不足时保持未激活，报告完整原因 | **这一条已经满足**：`prediction-eval-cli` 报 `no_active_catboost_model`；`accuracyStatus` 处处为 `not_evaluable` 且**必带原因**（§15.8 envelope 的判据） | ✅ |

> **本节与 §一 的关系**：§一 说"精度增强全部未激活且不应激活"，正是第 9–12 条的直接后果。
> 工程条满足**不**蕴含精度条满足 —— 这两件事在本文档里始终分开陈述，这也是方案开头
> "不以 P0 测试通过宣称 P2 精度达标"的执行形态。

---

## 十、独立审计（2026-09-30，三个只读子智能体）

本文档此前的结论大多由**同一个上下文**自证。本节记录三条**独立**审计线的结果：它们各自
只读、只依据源码与实跑输出，并且**推翻/收窄了本文档的若干说法**。凡是与本文档冲突的，
以本节的证据为准。

### 10.1 §14.2 的"五张新表"：两张**早已实现**，三张被一张没被命名的表覆盖

方案 §14.2 把这五张表标为"设计名，尚未实现"。实测（在**内存库**上跑完全部 24 个迁移核对，
不碰 `var/rai.sqlite`）：

| 方案里的名字 | 判定 | 实际机制 |
|---|---|---|
| `prediction_calibration_artifacts` | ✅ **实现**（v23，**同名**） | interval policy / 残差分位数 / 样本范围 / 版本齐全，触发器保证不可变，生产预测路径在读它 |
| `model_release_bundles` + 单一 active 指针 | ✅ **实现**（v23，**两个名字都对**） | `model_release_bundles` + `active_model_release`（`singleton` 约束保证唯一），跨域快照一致性有 `snapshot_hash` 校验 |
| `daily_readiness_snapshots` | 🟡 **部分** | 没有日级表；readiness 以 JSON 封进通用表 `model_domain_snapshots`（`domain='readiness'`）。**缺的是日序列**：一行 = 一次 run，且实时 API 路径是重算而非回读 |
| `daily_durability_snapshots` | 🟡 **部分** | 同上，`domain='durability'`，payload 是三个距离的数组 |
| `model_evaluation_runs` | 🟡 **部分** | 无对应表：gate 在 `model_validation_gates`（v24 起四态），评估摘要在 `model_release_bundles.evaluation_json`，谱系在 `model_v2_runs`。**跨域评估 run 只以 `deliverables/*.json` 形式存在，没有任何表索引它们** |

> 🔴 **订正**：本文档此前把 §14.2 整体当作"未落地"。实际是 **2 张同名实现在 v23**、
> 3 张被一张方案从未命名的通用表 `model_domain_snapshots` 覆盖。方案的"尚未实现"标签
> 在 v23 之后已经过期 —— 这与 §3.1 那种"文档落后于代码"是同一类漂移，方向相反。

### 10.2 版本矩阵：19 个值全部仍准确，但有两处**遗漏与不可复现**

独立审计在**当前 HEAD**（比方案记录的 `62b4a97` 晚 28 个提交）重新推导了全部 19 个常量：
**没有一行数值漂移**。但有三处必须记下：

1. 🔴 **normalization 一行不完整**。方案写"只有 identity adapter（N0）"。这只对
   `packages/normalization` 成立：**另有一个非 identity、带版本的修正 adapter**
   `createPhysiologyNormalizationAdapter()`（`packages/physiology/src/index.ts:1198`），
   版本 `rai-physiology-v1.8.0:conditions-v1`，**且确实返回 `status: "applied"`**。
   同一行还漏了两个真实常量：`rai-normalization-identity-v1`、`rai-normalization-policy-v1`。
   （"没有 fitted adapter"这一半仍然成立：该版本串是模板拼接的，任何 `*_VERSION` grep 都找不到它。）
2. 🔴 **方案 §3.1 的可复现指针是坏的**：它说"复查命令见附录 C.3"，而 C.3 只有一条
   walk-forward CLI 和一组 `node --test`，**没有任何重新推导版本矩阵的命令**。
3. **Ridge 一行没有常量**：`race-residual-ridge-v1` 是字符串字面量类型 + 字面量值，
   没有 `RIDGE_VERSION` 导出。值对，但"取各领域 `*_VERSION` 常量"这个方法产不出它。

**Coach 一行（第 16 行）方案是对的**，而且比方案说的更彻底：不仅没有版本常量，
**根本不存在版本化的决策输出类型**。`CoachDecisionV2` 全仓 0 命中；
唯一的决策形状是 `MobileVerdict`（`packages/api-contracts/src/index.ts:638`，**无版本字段**）；
`decideVerdictFromSnapshots` 的注释写着 "V2 decision entry" 但返回类型就是 `MobileVerdict`。
唯一带版本的是 Coach 的**输入**（`ReadinessAssessmentResult.modelVersion`）。

### 10.3 环境去偏差的**完整**责任人清单（补 §五-10）

独立审计用穷举 grep + 实跑调用链给出完整清单，这比本文档 §五-10 的表述更准确：

| 对象 | owner | 是否施加修正 |
|---|---|---|
| `historical_evidence` | `performanceVdotEvidence`（经 physiology 的 condition adapter） | **是**（`index.ts:326` 的 `durationSeconds / (1 + penalty.total)`） |
| `target_scenario` | `predictRaceTimes` | **是**（目标情景，§5.5 明确允许） |
| —（显式 identity） | `createIdentityNormalizationAdapter` | **否** —— 从不返回 `applied` |
| `residual_input` | **无人**：静态账本 `defaultConditionLedger` 只有 2 条 | n/a |

关键补强：静态账本 `validateConditionLedger(defaultConditionLedger)` 在**模块加载时**执行
（`packages/normalization/src/index.ts:352`），任何第二个 site 声明同一个 `(object, field)` 即抛错。
**它与 §五-10 的运行时账本是两层互补**：静态层管"谁有权声明这个对象"，运行时层管"这一次预测里
同一份证据被用了几次"。

### 10.4 只读工具链：`var/rai.sqlite` **逐字节未变**，且工具比本文档记录的更多

独立审计实跑 13 个工具并对比前后哈希：

```text
var/rai.sqlite  SHA-256  BC3B117B…F14C  →  BC3B117B…F14C   （完全相同）
                大小     1,968,721,920    →  1,968,721,920
                mtime    2026-09-28T08:29:28.554Z（未变）
```

- **11/13 退出 0 且 JSON 可解析**；`envelopeVersion = rai-eval-report-envelope-v1` 出现在其中 5 份。
- **本文档此前漏记 2 个只读工具**：`data:predict`（`prediction-cli.ts`）与 `data:analyze`
  （`analyze-cli.ts`），两者都经 `RaiDatabase.openReadonly`、零写语句、只往 stdout 打 JSON。
- 2 个非 0 退出的都是**文件入参** CLI，都不打开数据库：
  `data:model-replay` 缺 as-of 快照（仓里确实没有该文件，属正确行为）；
  `data:prediction-challengers` 则暴露了一个**真实缺陷**（下一节）。

### 10.5 审计发现并已修掉的**两个真实缺陷**

| 缺陷 | 来源 | 修法 |
|---|---|---|
| `speed-plausibility-inventory` **写死 `repoRevision: null`** —— 五份 envelope 产物里唯一永远说不出自己出自哪个提交的一份 | 上一批次我自己引入 | 改为与四个兄弟脚本相同的 `git rev-parse` 取法（取不到才 null）。重跑后 `repoRevision=08489fb` |
| `prediction-challengers` 缺 `--challengers` 时报 **EISDIR** 而不是"你没给文件"：`optionValue(..., "")` → `resolve("")` 得到**当前目录** → `existsSync(目录)` 为真 → 守卫放行 → `readFileSync` 抛错 | 既存缺陷（非本次引入） | CLI 先判"参数是否为空"，库内再判"是否存在"与"是否为文件"。三条路径各有独立措辞，并加了一条断言**不得**出现 EISDIR 的回归用例 |

> 后一个缺陷值得单独记一笔：**"路径存在"与"路径是文件"是两件事**，
> 而 `resolve("")` 悄悄把它变成了当前目录 —— 一个空字符串就这样绕过了一道存在性检查。
> 断言里特意加了 `!/EISDIR/`，因为"能跑出错误"和"报对了错误"不是同一件事。

### 10.6 审计自身的两条过程记录

- 其中一个子智能体**第一批结果全部无效**：它用了名为 `$Args` 的 PowerShell 参数，
  与自动变量 `$args` 冲突，导致每条命令都以**无参数**运行（npm 无参数退出 1、裸 `node` 退出 0
  读空 stdin），于是呈现出"几乎全挂"的假象。它自己发现后作废重跑。
  **这与本文档反复记录的 PowerShell 陷阱是同一族**：静默替换 / 静默丢参。
- 它同时观察到工作树在审计期间被**并发修改**（4 个文件，含 `check-acceptance-matrix.mts`）并
  如实标注为"非我所为"—— 那正是我在同时编辑。它没有把这当成异常去"修"，
  而是把歧义留给了读者，这是正确的处置。
- 三个子智能体都只读、都把临时产物写到 `var\` 并在结束时删除，`var/rai.sqlite` 未被写入。

---

## 十一、第二轮独立审计（2026-09-30，两个只读子智能体）

与 §十 同样的做法：只读、只看源码与实跑输出、结论与本状态文档冲突时以审计为准。

### 11.1 §14.2 的"日级快照表"：**结论是不需要建**（负面结果）

方案 §14.2 建议新增 `daily_readiness_snapshots` / `daily_durability_snapshots`，
§14.3 还给了唯一键。审计读完每条读路径后的结论是 **`no_new_table_needed`**：

- **readiness 的每一个消费方都是"读时重算"**：`apps/api/src/mobile-read.ts:288` 每次都调
  `loadDatedReadiness(database, now, TZ)`，而它是 `assessDatedReadiness(loadDatedRecoveryFacts(...))`
  ——对 `canonical_nights` / `canonical_hrv_days` / `health_records` 的即时 SQL。
  Coach 与 prediction 各自也重算。**全仓没有任何日级序列的消费方**：
  `packages/storage-sqlite/src/read/` 里 readiness/durability 零命中，`server.ts` 没有序列端点，
  iOS 明确不解码 `readinessSnapshot`。
- 唯一"读存档"的路径是 `/v1/model-snapshots`，只服务一个 Web 组件做展示。
- 因此建表只会多一份**没人读、且随 run 一起被 prune 掉**的副本。审计实测：
  8 个 sealed run 经 `retireOldReleases(2)` + `pruneSupersededModelRuns` 后 readiness 行 **8 → 3**。

🔴 **更重要的是它顺手定位了一个真机制，而不是"数据不够"**：
历史某天之所以答不出来，是因为 `canonicalizeNights` 每次导入都
`DELETE FROM canonical_hrv_days; DELETE FROM canonical_nights;`（`canonicalize-nights.ts:160`）
再重新插入，而插入**不带 `computed_at`**（默认取 `now`）；RHR 的到达时间又受
`import_manifest.import_completed_at` 这个**全局标量**约束（每次导入覆盖）。
于是"在 D 当天评估 D"必然看到比 D 更晚的到达时间 ⇒ `coverage: none / not_assessed`。
审计用合成 fixture 复现了两侧：把 `computed_at` 回拨后同一天立刻变成 `partial / caution`。
**这与本文档 §五-4 报告的 769 天里只有 1 天可判定、302 天"有读数但到达时间不可考"是同一件事，
但给出了可修的位置** —— 修的是到达时间不被覆盖，不是再建一张表。

### 11.2 §14.8 的迁移编号**已过期**，且新迁移的约定被完整记录

- 方案说"下一版本可以是 v23"。实测代码已在 **v24**（v23 = V2 快照/发布/校准，
  v24 = engine 版本门三态 + refusals + epoch），**v25 才是下一个空位**。
- 校验和是**冻结**的（`database.ts:1673-1698`），历史迁移正文由
  `migration-policy.test.ts:143-159` 保证不可改；`database.ts:1666-1671` 明确写着
  **不要更新冻结表** —— 那是唯一会弄坏既有库的动作。
- 新 v25 的完整步骤（新文件 + import + 追加表项 + `transpiledChecksumFor(25)` 冻结）已记在审计报告里。
- 订正上一轮审计的一处说法：`RaiDatabase.open(":memory:")` **在全仓并不存在**；
  它在内存里确实可用（实测 24/24），但仓库的真实测试约定是**临时文件**
  （`v24-migration.test.ts:35` 的 `mkdtempSync` + `open(join(root,"db.sqlite"))`）。

### 11.3 Coach 决策面：一次 829,440 组输入的扫描查出**本批次自己写的 5 个矛盾**

这批扫描在 §十二 的实现过程中做的，结论直接改掉了实现（详见 §十二）。这里只记方法：
它按 12 个决策相关维度穷举，把每组输入同时过 legacy 与 V2 两个投影，
于是"枚举是否真的全"这个问题从设计争论变成了分布统计。
**这正是本文档一直在用的同一招：把"应该没问题"换成"实测是多少"。**

---

## 十二、§13.3 Coach 版本化输出：从"未落地"到有契约、有投影、有扫描

版本矩阵把 Coach 标为"🔴 未落地（工程项）"，审计确认得比方案更彻底：
**全仓不存在 Coach 版本常量，也不存在版本化的决策输出类型**，
唯一的决策形状是无版本字段的 `MobileVerdict`。

### 12.1 实现了什么

- `packages/api-contracts`：`COACH_MODEL_VERSION = "rai-coach-v2.0.0"`、
  `CoachAction`、`CoachDecisionV2`。
- `apps/api/src/mobile-coach.ts`：`CoachPlanDisposition`（9 值）+
  `decideNextSessionDecision`（返回 `{session, disposition}`）+
  `projectCoachDecisionV2`（纯翻译）。`decideNextSession` 变成一行包装，
  **处方函数体一字未改**（只改名为 `prescribeUnplannedSession` 再包一层）。

关键设计：**`action` 由决策自己报告的分支（disposition）决定，不靠比较课型倒推。**
倒推是二次解释 —— `decidePlannedSession` 有多条会产出**相同 kind** 的路径
（原样保留、被 taper 缩短、被周预算缩减），课型相同并不代表动作相同。

### 12.2 扫描查出的 5 个矛盾（都已修 + 各留回归用例）

| # | 修前 | 修后 |
|---|---|---|
| 1 | 比赛日无计划 ⇒ `keep_plan` 却**不说**"没有已保存计划"，与契约注释里的判据自相矛盾 | 无计划这个**事实**对每种 disposition 都如实出现；比赛日保留的是"比赛"这份承诺，所以仍是 `keep_plan`，但理由里同时有 `no_stored_plan_today` |
| 2 | `budget_exhausted` 一律 `reduce_duration`，而该分支可能直接给**休息**（57,600 组样本说"缩短时长"而教练开的是休息） | 看处方：`rest` ⇒ `rest`，其余 ⇒ `reduce_duration` |
| 3 | `collect_evidence` 放在最前，吞掉 483,840/829,440 组，含 161,280 个"比赛日留白" | 只在**唯一原因是证据不足**时才是动作；其余情形它留在 `reasons` 当正交标志 |
| 4 | `downgraded_quality` 的"其余一律 `reduce_intensity`"实际只落在 `long_run`，而长跑被砍的是**量** | 按最终处方选词：easy/recovery ⇒ `easy_only`，rest ⇒ `rest`，long_run ⇒ `reduce_duration` |
| 5 | recovery 课被标成 `easy_only`（丢掉了 verdict 自己做出的恢复跑区分） | 同上，恢复跑与轻松跑同档，是**有意的**合并，已写进注释 |

🔴 **并且必须记下一条本批次**自己**造成的：** 我在写这批代码时把
`COACH_MODEL_VERSION` 与类型一起放进了 `import type`，于是它在运行期只是个类型名字 ——
文件**编译不过**（`cannot be used as a value`）。是并发的只读审计先报出来的。
同一族的问题在本会话已出现第四次（静默替换、静默丢参、静默丢导入）。

### 12.3 接线已完成，两个硬约束都按它们**自己提供的方式**满足

`projectCoachDecisionV2` 现在是生产路径的一部分：`mobile-read.ts:307` 用
`decideNextSessionDecision` 同时取回处方与分支，`:334` 把投影放进 coach payload，
`data.ts:545` 的 `...coach` 把它带进响应，`MobileTodayResponse` 上是 `decision?: CoachDecisionV2`。

上一版本文档说"还没有接线"，并列了两个硬约束。两个都不是绕过，而是按它们**各自的机制**满足的：

| 约束 | 处置 |
|---|---|
| **iOS 字段覆盖门**（`run-tech-presentation-tests.sh:158-224`）：解析 `MobileTodayResponse` 每个字段，没有展示锚点又没写 `metadata_only` 理由就失败 | 在 `metadata_only` 里登记 `decision` 并写明理由：它的展示位**就是** `verdict`/`nextSession`（同一次决策的两个投影），再铺一遍会让同一个决定出现两种说法。这正是该门为"证据层字段"准备的通道，与 `readinessSnapshot` 同类 |
| **`recommendationRevision` 哈希**（`data.ts:508-520`）：对 `{..., verdict, nextSession, ...}` 取 SHA-256，往里面加不稳定字段会让每个 lock 变陈旧 | 新字段放在 `MobileVerdict`/`MobileNextSession` **之外**，**不进**那份哈希。`server-runtime.test.ts` 的 lock 往返用例（17/17）确认没有引入 409 |

**关于 `test:ios` 的可验证性（重要）**：该门需要 Linux/WSL，本机没有，所以
`npm run test:ios` 在这里**跑不起来**。为了不让这条约束因为环境而失去看护，
我把那道门里的 Python 判据**照原样**在这台机器上跑了一遍（读的是同一份契约与同一份脚本表）：
契约 29 个字段 = 展示锚点 23 + `metadata_only` 6，**unaccounted 0、stale 0、`decision` 已登记**，PASS。
这是一次性核对而不是新增一个镜像检查 —— 不把同一条规则实现第二遍，
否则以后有人会去改镜像而不是改门。

### 12.4 本轮新增的验证

- `mobile.test.ts`：真实 payload 上断言 `decision.version === "rai-coach-v2.0.0"`、
  `decision.tone` **逐字等于** `verdict.tone`、`action` 是已声明取值或刻意的 `null`、
  每个 reason 都带 `plan_disposition_*`、`inputSnapshotIds` 里没有空串。
- `coach-decision-v2.test.ts`：11 条，含扫描查出的两处矛盾的回归。

---

## 十三、到达时间被重建抹掉：机制已定位并修复（§15.3）

### 13.1 缺陷本身

`canonicalize-nights.ts` 重建两张 canonical 表时是
`DELETE FROM canonical_hrv_days; DELETE FROM canonical_nights;` +
重新插入，而**两条 INSERT 都不带 `computed_at`**（列有 `DEFAULT now`）。
偏偏 `model-v2-snapshots.ts` 读的就是 **`computed_at AS availableAt`**，
readiness 只在 `availableAt <= asOf` 时承认事实可得 ——
所以每次重建都把全部行的到达时间盖成"现在"。

这不是"少一点精度"：**同一份事实、同一个 `asOf`，答案会因为一次重建而改变。**
函数自己的注释原本就写着 "Canonical computed_at is known. Raw source-created time is never
treated as ingestion time." —— 全量重建恰好把那个 "known" 抹掉了。

### 13.2 两条**实测限定**（独立探针在修复前的修订上复现，20/20 断言）

这两条是独立子智能体跑出来的，它们收窄了症状的措辞，必须照写：

1. **退化成 `coverage:"none"/state:"not_assessed"` 需要 RHR 通道同时不可得。**
   带上 RHR 与 `import_manifest` 时（更接近真实库）可观测的是 `complete → partial`、
   sleep/hrv 的 value 变 null，而 **state 字符串仍然是 `no_low_signal`**。
   **结论没变、证据基础悄悄减半** —— 这比字符串变差更难被发现。
2. **触发点不是"第二次导入"。** **第一次**重建就已经把 `now` 盖在属于过去的行上，
   所以对历史库做一次全新重建就会丢掉全部历史日。
   修复只能保住**本来就存在**的到达时间；它**不能**、也不该把后来的事实说成早就到了。

### 13.3 修复：按**内容**保留，而不是按 id

- 重建前把 `(id, computed_at, 事实列指纹)` 存进临时表；插入完成后，
  **事实列逐字未变**的行还原原到达时间；**新增或事实改变**的行保持 `now`。
- 指纹用 `quote()` 逐列拼接（每个值自定界，无歧义），**排除 `provenance_json`**：
  算法换版重新推导出同一个事实，并没有让这条事实晚到；产出它的版本另有 provenance 记录。
- 为什么不用"id 还在就保留"：那会把**被更正过的旧事实**伪装成"当时就知道"，
  是往未来泄漏的反方向错。独立探针验证了这个方向：把某夜的 HRV 样本 2 → 3 之后，
  未变的 night 行保住原值，而变了的 hrv 行拿到新戳并转为 `hrv_unavailable_at_assessment`。

### 13.4 验证与**边界**

| 项 | 结果 |
|---|---|
| 行 id 是否稳定 | ✅ 稳定（内容派生），两次重建的 id 列表与"排除 `computed_at` 的内容指纹"逐字节相同 |
| 自测（本批新增） | `canonicalize-nights-range.test.ts` +2（未变保留 / 改正刷新）、`arrival-time-preservation.test.ts` +1（端到端） |
| 独立复现 | 修复前的修订上 REPRODUCED；打补丁后同一探针 20/20 通过 |
| 全量门禁 | node 1133 / 1115 pass / 0 fail |

⚠️ **必须写明的边界**：本工作区的 `var/rai.sqlite` 里 canonical 表是 **0 行**（schema 22，从未回填），
所以这个修复**在本库上没有任何可观测效果**，效果全部由合成用例钉住。
（已复跑核对：`readiness-replay-coverage` 修复前后逐字段相同 —— `assessableDays 1`、
`asKnownThenBlockedDays 302`、`coverage {none:768, partial:1, complete:0}`。）

### 13.5 🔴 **订正**：RHR 那条通道**不是**同一族缺陷，不能照这个思路修

上一版本文档把 RHR 的可得性（走 `import_manifest.import_completed_at`，一个每次导入覆盖的
全局标量）写成"同一族问题的另一条通道"，暗示它是待修的同类缺陷。**这个说法是错的**，
写下来以免有人照着去"修"：

- 那个标量的注释已经写明它是 **"a conservative upper bound, not a fabricated record-level
  arrival time"** —— 取**最近一次**发布作为上界，是在**故意保守**。
- 若改成"取 asOf 当时生效的那次发布"，就会让**后来才导入的记录**看起来在当时已经可得 ——
  那是**往未来泄漏**的方向错，正是 §15.4 明令禁止的。
- 真正要解决它，需要**记录级入库时间**（每条记录第一次被系统接受是什么时候），
  而现在没有这个东西：`health_records.created_at` 是**数据源**创建时间，
  契约明确拒绝把它当成入库时间。

所以这里的诚实结论是：**这一条是设计级缺口（缺 record-level ingest ledger），不是可以就地打的补丁。**
它的可观测后果是 RHR 通道在历史 `asOf` 上一律不可得，而这**恰好**是保守方向 ——
宁可说"那时还不知道"，也不谎称"那时已经知道"。

---

## 十四、验收矩阵检查的**口径缺陷**：它把"出现过"当成了"被引用"

### 14.1 缺陷与后果

`check-acceptance-matrix.mts` 第一版判"被引用"用的是
`new RegExp("\\b" + id + "\\b").test(整个测试文件正文)` —— 于是在**注释**里、
在**任何字符串字面量**里出现过一次就算数。独立审计（§十）抓到了它的直接后果：

- `T01` / `T02` 的"引用"**全部**来自 `${localDate}T02:00:00.000Z` 这类时间戳模板：
  `}` 与 `T` 之间是词边界，所以 `\bT02\b` 命中；而写成 `2026-07-10T02:00:00Z`
  （`0` 与 `T` 之间不是边界）反而不命中。**两个 ID 因此凭空"被覆盖"**，其中一个（T02）
  其实一条断言都没有。
- `F01` 只有注释提到它。

也就是说本报此前反复引用的那句"那些 ID 的『确有测试』由 `check:acceptance-matrix` 机械保证"，
**保证的只是"某个 ID 在某处出现过"**。这正是 §9.1 里条件 5 能读成"满足"而排他过滤无人守的原因。

### 14.2 修法：只认**测试标题**

现在从 `test(...)` / `it(...)` 的标题字符串里取 ID；标题里没有就不算引用。
收紧后**立刻机械地**暴露出三条，与审计的手工抽样完全一致：

| ID | 收紧后的处置 |
|---|---|
| **F01** | 断言本来就存在且是真的端到端（从原始事实装配入口跑），**只是标题没带 ID** ⇒ 补标题。**不放松检查口径** |
| **T01** | 同上：`historicalValuesAvailableAt` 的可见性判据就是 T01 要求的"迟到标签不进入更早的 as-of"，断言真实 ⇒ 补标题并让它明确写"label" |
| **T02** | **真实缺口**：导入层有"删除后不得复活"的守卫，但 §16.1 要求的"**重放后所有下游去除该事实的影响**"没有任何用例。如实写进 `KNOWN_GAPS`（连同"哪一半有、哪一半没有"），不拿相邻用例顶替 |

收紧后计数：**54 条 / cited 53 / declared-gap 1（T02）/ missing 0**。

> **这条教训比数字重要**：一个门禁如果判据比它声称的松，它就会把"没人守"读成"有人守"。
> 同类问题在本会话已出现多次（"路径存在"≠"路径是文件"、"能报错"≠"报对了错"、
> "implemented"≠"tested"）。**收紧判据时不要顺手把暴露出来的东西补成绿的** ——
> F01/T01 该补标题就补标题，T02 该认缺口就认缺口。

---

## 十五、条件 3：一次失败的测试尝试 → 我的推断被订正 → 结论是**代码是对的**（见 §15.5）

### 15.1 我原本接受的推断

§9.1 条件 3 写的是：`recompute-pipeline.ts:1708` 要求
`checkpoint.checkpoint_version = ?`，所以一个 v1 行**结构上无法**满足版本相等，跨版本复用
自然不可能。这个推断来自独立审计（它同时指出 `grep rai-model-checkpoint-v1` 全仓 0 命中，
即没有测试真的构造过 v1 checkpoint）。

### 15.2 我去补那个测试，结果它**证伪了推断的一半**

做法：跑完一次全量重算之后，把 `model_checkpoints` 里**每一行**的 `checkpoint_version`
改写成 `'rai-model-checkpoint-v1'`（其余列一字不动），**并在改写后立刻断言改写确实落库**
（否则"没复用"与"我的 UPDATE 被吞了"会给出同一个观察结果 —— 本会话踩过多次的假验证）。
然后在**同一 config** 下走增量增量重算。观察结果：

```text
前提断言：改写落库 ✅（表里只剩 rai-model-checkpoint-v1）
实际结果：feature_runs.parent_feature_run_id = feature_run_...574d  ← 非空
          reused = 5, recomputed = 2
```

**即：checkpoint 版本号被改成 v1 之后，特征前缀复用照样发生。**
所以 `checkpoint_version = ?` 并不是决定复用的唯一闸门，审计那句"结构上不可能"对
**`parent_feature_run_id` 这条链**并不成立 —— 而 `parent_feature_run_id` 正是 S03 用例实际测量的字段。

### 15.3 为什么单条 UPDATE 说不清全部因果（也说明这个测试为什么难写对）

复用分支会把**父 checkpoint 行整行拷进新 model run**，`checkpoint_version` 也在拷贝列里
（`:1768-1778` 的 `INSERT ... SELECT sequence_number, through_at, checkpoint_version, ...`）。
所以一次运行之后的版本号有一部分是**继承来的**，一次性 UPDATE 并不能干净地模拟
"这个 checkpoint 是旧二进制写下的"那个场景。诊断输出里同一个 run 同时出现 v1 与 v2 行，
就是这个拷贝造成的。

### 15.4 处置：**不留下一条我无法正当化的测试**

我**删掉了**那条测试，而不是把它改成断言"复用确实发生" —— 我没有证据说"复用是对的"，
把测出来的现状钉成期望行为等于用测试掩盖一个未决问题。

条件 3 的诚实状态应读作：
- **模型状态这条链**：代码里有版本相等闸门（`:1708`），这一半成立；
- **特征前缀这条链**：实测**不受**该版本闸门约束，"跨版本不复用"**未被证明**；
- 而且**仍然没有任何测试**构造过真正由旧版本写下的 checkpoint
  （改写现有行 ≠ 旧二进制写入），所以这一条只能在**代码层**成立，不能在**行为层**声称已验证。

这条记在这里而不是就地"修好"，是因为要回答的是设计问题：
**特征前缀复用是否也应该按 checkpoint/engine 版本设闸**？那不是本轮能定的。

### 15.5 ✅ **结论订正（同日）**：条件 3 其实是**对的**，错的是我上面那段推断

我继续追下去，找到了 `reuseFeaturePrefix`（`recompute-pipeline.ts:1015+`）真正的闸门。
它**确实按版本设闸**，只不过用的是**特征层**的版本，而不是 model checkpoint 的版本：

```text
parent.configHash    !== configHash({version: FEATURE_CONFIG_VERSION, config: request.featureConfig})
parent.schemaVersion !== FEATURE_SCHEMA_VERSION
parent.contractVersion !== (manifest 的 parser_contract_version ?? CONTRACT_VERSION)
parent.timezone      !== request.timezoneIdentifier
→ 任一不等即 return null（整段重算，不复用）
```

**这才是正确的分层**：特征前缀复用是**特征**的复用，就该由特征 schema/config/contract 决定；
`checkpoint_version` 管的是**模型状态**（TA/baseline）的复用（`:1708`）。两者是两件事，
各自有自己的版本闸。所以：

| §十五 上文的两句话 | 订正后 |
|---|---|
| "该版本闸门管不住特征前缀那条链" | 字面为真，但**推论错了**：那个闸门本来就不是管这条链的 |
| "'跨版本不复用'未被证明" | **不成立**。两层各自的版本闸都在代码里，S03 钉住了特征 config 那一半 |

**为什么我那次改写版本号的实验会得出误导性的结果**：我改的是 `checkpoint_version`，
它只影响**模型状态**复用这条链，而我去观察的是 `parent_feature_run_id`（**特征**复用那条链）。
两个观察对象错配，于是"没看到变化"被读成了"闸门不存在"。这是个测量错位，不是代码缺陷。

**仍然成立的**只有一点，而且它很窄：`grep rai-model-checkpoint-v1` 全仓 0 命中 ——
没有测试构造过**真正由旧版本写下**的 checkpoint，所以模型状态那条链的版本拒绝只有代码证据。
§9.1 条件 3 的判定据此回到 **✅ 成立（模型状态那半只由代码守）**。

### 15.6 🔎 顺带发现（原审计与我都没提到）：恢复隔离在生产路径上**有运行时闸门**

`recompute-pipeline.ts:977-981` 每次抽特征时都会跑一个**反事实**：
把 `restingHeartRate: 99, hrvSdnn: 1, sleepDurationMinutes: 1, recentLoadMinutes: 9999`
代进去重算一遍，然后比较两次的 `semanticHash`：

```ts
this.recoveryIsolationHolds &&= semanticHash(feature) === semanticHash(counterfactual);
```

而这个布尔值直接进 gate（`:284-286`）：

```text
gateVersion: "rai-bootstrap-invariants-v1"
status: recoveryIsolationHolds ? "passed" : "failed"
blocksActivation: !recoveryIsolationHolds
failureReasons: ["recovery_isolation_violated"]
```

并且 `:291` 在 `blocksActivation` 时**抛错**。也就是说 §2.3 不变量 1（严格恢复隔离）
不只是用例里的断言：**它在每次重算时被实际检查，违反会阻断模型激活**。

这比 §9.1 条件 1 原先列的"有端到端测试"更强一层 —— 测试证明它当时成立，
这个 gate 让它在**以后每次运行**都必须成立。已补进条件 1 的证据栏。
