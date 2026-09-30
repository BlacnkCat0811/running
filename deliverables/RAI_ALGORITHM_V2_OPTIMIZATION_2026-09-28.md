# RAI 当前项目算法模型优化技术方案（V2）

> 2026-09-28 · 基于当前源码、只读本地数据核验及用户提供方案的修订版  
> 目标：Fitness / Readiness / Durability / Load / Prediction 职责清晰、证据可追溯、版本可回放。  
> 性质：**工程设计与实施计划，不是已完成的算法升级，也不是准确率验收报告。**

## 文档基线与阅读约定

- 仓库：`/Users/ta/running`。
- 核验提交：`62b4a97d8f3e04949b52c1715dc3a5ec660bc95c`；开始核验时工作树无已修改文件。
- 参考输入：用户提供的《RAI Algorithm V2 优化技术方案》，共 959 行。
- 核验范围：TypeScript 领域包、application 编排、SQLite、Node.js API、Python 残差训练、现有测试及项目决策记录。
- 本地数据：只读检查 `var/rai.sqlite`；**本地库不是线上生产库，不代表全体用户或线上模型状态**。
- 本次不执行数据库迁移、模型训练/激活、全量重算、线上部署或 iOS 源码修改。
- 文中“现状”指已从当前源码或本次命令输出确认的事实；“建议”指待实现设计；“候选参数”不是已经校准的生理常数。
- 源码证据使用绝对路径与函数名，关键处附行号；行号只对本次提交有效。
- 科学结论边界：本文是实现审计及工程设计，不是医学建议或外部文献综述；新增经验公式上线前仍需独立回测。
- 文中 TypeScript 是目标契约草图，沿用项目类型名并省略部分附属类型，不是本次已加入仓库的可编译实现。

### R1 修订说明：将评审意见变成执行条件

本轮依据用户第 2–9 项评审意见完善设计，不改变已核验源码或数据库。
新增条件分别落在 §6.1 权重消融、§6.2 稀疏分桶、§6.4 rebase、§6.7 confidence 空值、§6.9 双向更新、§7.4 状态规则有效性、§12.9 区间宣传边界、§15.7/§17.1 标签闭环。
**“文档已明确”不等于“实现或校准已完成”；本轮新增验收项均为待实施要求。**

## 目录

0. 执行结论与原方案修订
1. 当前真实实现与数据基线
2. 目标架构、模型语义与不变量
3. 版本、契约和兼容策略
4. 数据质量、时点与特征工程
5. 环境与生理可比性归一化
6. Fitness：CA、TA、双基线和证据更新
7. Readiness：统一恢复模型
8. Durability：专项准备度与耐久能力
9. Training Load：复合负荷、向量与状态
10. 动态分区和阈值证据
11. 生理预测与修正责任链
12. Ridge / CatBoost / 区间校准
13. Coach 单一决策源与接口迁移
14. 数据库存储、增量重算和发布
15. 统一离线回放、评估与反泄漏
16. 验收矩阵和测试设计
17. 分阶段实施、提交边界与回滚
18. 风险、取舍与最终验收
附录 A：文件级改造清单
附录 B：源码证据索引
附录 C：本次核验记录与复查命令
附录 D：参数台账和典型案例

---

## 0. 执行结论与原方案修订

### 0.1 总体判断

原方案提出的“恢复不再直接构成跑力、专项耐力独立表达、模型必须可回放”值得保留，但不能直接照单实施。
当前项目不是只有 Daniels、TRIMP 和简单恢复阈值的初始系统：已经存在复合负荷、阈值分段证据、环境条件修正、Ridge 残差、时间前推评估、CatBoost 发布留出集和模型版本闸门。

当前最需要的升级是：

1. **修正模型边界**：分清单次表现、长期能力、当天恢复、专项准备度，避免同一信号多次影响结果。
2. **统一恢复事实与规则源**：Coach 局部 SSoT 已有，但 feature、training-load、prediction 仍有独立恢复实现。
3. **保留已实现能力**：复用 Ridge、load breakdown、threshold evidence、验证闸门，而不是重写平行系统。
4. **先解决可验证性**：本地没有已激活 CatBoost；标签不足时，不用新公式制造“更准确”的假象。
5. **先建立候选回放再切换**：遵守项目已取消常驻影子重算的决策，不默认恢复线上 V1/V2 双跑。

### 0.2 必须订正的事实与设计

| 原方案描述或建议 | 当前实际 / 问题 | 本文处理 |
|---|---|---|
| CatBoost 当前为 `catboost-residual-v1` | 契约为 `race-residual-catboost-v3`，残差特征为 `race-residual-feature-v3` | 版本矩阵改按当前常量，不倒退命名 |
| 新增简单线性/Ridge challenger | `physiology/src/ridge.ts` 已有训练、推理、±12% 限幅，prediction-report 已回放比较 | 补统一三方发布 gate，不再新增重复 Ridge |
| 评估框架“无” | 已有 prediction-eval、walk-forward、bias calibration、CatBoost release holdout、bootstrap | 新增跨模型统一报告，而非从零开发预测评估 |
| 训练负荷主要只有 TRIMP | 已有 raw HRR TRIMP、internal load、pace load、distance factor、composite load | 默认保留 composite 主口径，Load Vector 是扩展，不是替换 |
| LTHR 仅 HRR 公式 | 已有 sustained/threshold-test/race segment 的多证据估计 | 改善来源优先级和独立可用性，不重新发明分段阈值 |
| 预测前尚无环境归一化 | `performanceVdotEvidence` 已对温湿度/爬升时间做修正 | 统一到版本化 adapter，阻止重复应用 |
| 恢复阈值是 0.80 / 0.85 / 1.05 | Coach 当前为睡眠 0.75、HRV 0.85、RHR 1.03；睡眠 streak 计数另用 0.80 | 先原样迁移，再单独比较候选阈值 |
| `assessRecovery` 已是全项目唯一恢复源 | 只在 Coach 评估和裁决之间成立 | 合并 feature、phys-state、prediction recovery 的独立口径 |
| 负向 TA 更新须 `environmentAdjusted=true` | 缺天气或无需修正的正常训练会永远不能下调 | 改用归一化状态与可比性，不强制发生数值修正 |
| 低 Readiness 冻结 TA，同时称完全正交 | 若冻结直接读取 Readiness，则 TA 仍依赖它 | 第一版严格不读 Readiness；约束状态只来自训练本身的证据 |
| 缺维度后 CA 一定不能更极端 | `50 + coverage × (CA_raw−50)` 并不保证对任意删维度单调 | 修正为“对同一剩余证据收缩”，并禁止缺证据 TA 负学习 |
| 准备度与新 Durability 连续扣罚 | 现有 race readiness 已用跑量、长跑、专项暴露 | 重命名/迁移为 preparation，不把同一信息再扣一遍 |
| 新增 full marathon | 当前 RaceDistance 仅 5K、10K、半马 | 本轮不扩全马，另行立项 |
| 常驻 shadow mode 上线 | 项目 2026-09-20 已明确去除影子系统/完整双跑 | 使用离线候选回放、保留版本 gate、原子发布与回滚 |
| V23 一次加入全部新表 | 当前已存在 run、snapshot、artifact、validation 相关结构 | 先最小增量迁移；编号以合并时最新 schema 为准 |

### 0.3 优先级

**P0：语义、工程安全和标签闭环。** Readiness 拆分、版本隔离、as-of 输入、覆盖度与缺失语义、旧分数解释、统一评估输入；同时优先打通已有比赛/测试标注到评估的可审计流程。

**P1：提高证据质量。** 课型可比性、环境 adapter、双基线、连续学习率、专项准备度迁移、分区来源和 Load Vector。

**P2：有标签之后的精度优化。** Durability 数值校准、三方残差竞争、P80/P90 统计校准、个体化参数。

**不以 P2 尚无数据为理由阻塞 P0，也不以 P0 测试通过宣称 P2 精度达标。**

---

## 1. 当前真实实现与数据基线

### 1.1 当前模块职责

| 模块 | 当前已经承担的职责 | 主要缺口 |
|---|---|---|
| `@rai/contracts` | canonical、features、ability、load、zones、physiology、ML 契约 | 缺独立 Readiness/Durability 和统一模型谱系 |
| `@rai/features` | 以纯计算为主、准入、课型、速度窗口、原始表现、恢复信号 | Fitness 与恢复同向量，环境未进入普通跑力特征；computedAt 默认值仍读时钟 |
| `@rai/scoring` | Median/MAD、CA、TA、校准期、停跑衰减 | 恢复占 CA 权重；TA 分段学习率；固定初始个人基线 |
| `@rai/physiology` | VO2max、Performance VDOT、阈值、Daniels、条件补偿、Ridge、偏差校准 | readiness 名称混杂，区间尚非统一 P80/P90 产品契约 |
| `@rai/training-load` | TRIMP fallback、EWMA、ramp、monotony、strain、状态 | 恢复分类独立；ACWR 仍可单独触发高负荷状态 |
| `@rai/training-zones` | 每日 HR/Pace 分区、来源、平滑、课型刺激、复合负荷 | source 粒度和配速/心率一致性解释待统一 |
| `@rai/prediction-inference` | ONNX 校验/推理、残差安全边界和回退 | 未统一与 Ridge 的生产竞争门槛 |
| `@rai/application` | 数据装配、回放、指纹、checkpoint、训练任务、预测评估 | 缺跨领域统一回放 envelope |
| `@rai/storage-sqlite` | 派生 run、发布指针、版本 gate、导入/删除事实 | V2 快照与完整谱系需扩展，避免复制注册表 |
| `mobile-coach.ts` | 恢复评估与裁决 SSoT、计划建议、解释 | 上游规则仍分散，输入仍过宽 |
| `research/rai_ml` | CatBoost、walk-forward、release holdout、bootstrap、ONNX parity | 新语义特征、三方比较和独立区间校准 |

### 1.2 当前 Fitness 基线

默认 CA 权重：Efficiency 0.375、Pace 0.3125、Cardio 0、Stability 0.1875、Recovery 0.125。

其他已确认参数：

- 初始校准至少 6 次有效训练，跨度至少 14 天。
- 可评分最低有效维度权重为 0.65；Efficiency/Pace 至少一个存在。
- TA 最低 confidence 为 0.60。
- 维度分数为 `clamp(50 + 10 × z, 0, 100)`。
- 稳健尺度为 `max(1.4826 × MAD, abs(median) × 0.03, 0.0001)`。
- confidence 为 coverage/source/comparability/maturity 的加权几何平均，权重 0.35/0.25/0.25/0.15。
- TA 学习率在 N≤10、N≤30、N>30 分别为 0.15、0.10、0.06。
- 残差截断 ±12；负向方向因子通常 0.4，低 recovery 分数时降到 0.25，正向为 1。
- 校准完成后使用所选初始 calibration features 构造 baseline；当前不是一个持续滚动的 28 日能力基线。

证据：`/Users/ta/running/packages/scoring/src/model.ts:27`、`/Users/ta/running/packages/scoring/src/index.ts:81`、`/Users/ta/running/packages/application/src/services/recompute-pipeline.ts:1710`。

### 1.3 当前特征准入

默认最小距离 1 km、最小时长 8 min、心率样本至少 10、心率覆盖率至少 0.5、合理平均配速 2.5–15 min/km。
长跑识别阈值为 75 min 或 15 km；间歇候选速度 CV 阈值 0.18，另有覆盖与重复结构判断。
这些是**本项目规则**，不是对所有运动人群成立的生理边界。

V2 首轮保留这些门槛；不要一边拆恢复、一边改课型识别和准入样本范围，否则无法归因分布变化。

### 1.4 当前预测基线

- 仅支持 `five_k`、`ten_k`、`half_marathon`。
- VO2max 与 Performance VDOT 已有区分；应用层注释明确防止同一 race/test 通过两条路径重复进入 VO2max ensemble。
- 普通训练可形成 training envelope；不能将轻松跑当成全力比赛标签。
- `loadRaceReadinessEvidence` 使用过去 56 天训练，计算跑量、最长跑、频率、目标距离暴露和近期性。
- 现有 recovery readiness 是另外一个恢复数值，参与疲劳条件补偿，不等于专项准备度。
- 阈值有 `multi_evidence_threshold_v2`；Ridge 有 `race-residual-ridge-v1`。
- Bias calibration 默认 3 个历史误差才启用，5 个才增加经验区间处理；这不等于这些样本量足以认证 P80/P90。

### 1.5 当前本地库与源码不是同一版本状态

本次只读查询得到：

| 项目 | 本地结果 | 解释 |
|---|---|---|
| SQLite migration 最大版本 | 22 | 与当前 migration 列表最高版本一致 |
| active training sessions | 268 | 不是 268 个全力测试/比赛标签 |
| 训练时间范围 | 2019-12-13 至 2026-08-25（UTC） | 不代表 2026-09-28 当天有训练或恢复数据 |
| active model run 的 `model_version` 原始值 | `rai-model-config-v3` | 是库中旧记录值，不能改述为当前 scoring engine 版本 |
| active model 的 evaluated_at | `2026-09-04T08:53:46.059Z` | 本地派生结果未自动跟随源码常量升级 |
| active feature schema | `workout-feature-v3` | 仍为旧特征契约 |
| prediction_model_runs | 0 行 | 本地没有训练记录 |
| active CatBoost | 无 | 不得宣称 CatBoost 已在本地生产预测中工作 |

因此必须区分三件事：**代码中有什么、库里已经算过什么、线上真正激活了什么**。
本次只确认前两项；不查询线上环境、不推断线上用户状态。

---

## 2. 目标架构、模型语义与不变量

### 2.1 目标依赖图

```text
canonical health / training sessions / overrides / timestamped context
                              |
                  as-of assembler + quality + provenance
                              |
       +----------------------+--------------------------+
       |                      |                          |
 workout normalization    daily recovery facts     training exposure
       |                      |                          |
 Fitness CA/TA           ReadinessSnapshot         Load / Preparation
       |                      |                          |
       |                      |                    Durability evidence
       +----------------------+--------------------------+
                              |
        Prediction orchestrator (baseline -> correction -> interval)
                              |
                    Coach decision + reason codes
                              |
                    Web / existing iOS consumers
```

不是所有箭头都表示“必须入公式”。例如 Fitness 分数可以作为解释背景，但不得未经校准直接线性换算 VDOT。
Coach 不写回 TA；Readiness 不成为 CA 的评分维度；模型领域包不访问数据库。

### 2.2 明确定义

| 名称 | 要回答的问题 | 不应解释成 |
|---|---|---|
| CA | 本次训练在相同参考系和可比条件下体现的表现水平 | 今日恢复分数、全力比赛能力的直接测量 |
| TA | 从合格表现证据中缓慢学习的个人长期能力指数 | VO2max、绝对生理真值、跨人排行榜 |
| Adaptive anomaly | 相对近期同类训练的偏差 | 替代长期 Fitness 的另一个跑力分 |
| Readiness | 当前恢复证据支持什么训练安排 | 生病诊断、能力下降、没有异常就百分之百恢复 |
| Preparation | 对某个目标距离是否具备足够训练暴露 | 通用体能、当天恢复 |
| Durability | 持续运动后保持表现的证据 | 仅靠周跑量便能精确推断的抗疲劳能力 |
| Load | 已发生训练的内部/外部负荷及其变化 | 伤病概率或身体损伤量 |
| Prediction | 明确情景和目标距离下的估计成绩及不确定性 | 保证能够跑出的承诺 |
| Coach | 在证据、计划、约束下采取的训练动作 | 再次计算恢复/跑力的第二套算法 |

“True Ability”保留内部兼容名称；面对用户建议解释为“长期能力估计”，避免“真实”被理解为精确测量。

### 2.3 硬不变量

1. **严格恢复隔离**：固定 workout、训练证据、Fitness baseline、配置和历史状态，仅修改睡眠/HRV/RHR，CA、TA 及 TA 是否更新均不变。
2. **恢复只影响安排/情景**：相同 Fitness 可以对应不同当日 Coach 建议与 race-day prediction。
3. **未知不是低值**：缺失必须是 null/unknown/not_assessed，而不是 0、健康或疲劳。
4. **先评分后更新基线**：训练自身不参与给自身评分的参考系。
5. **无未来泄漏**：事实发生时间和系统可得时间同时受 as-of 限制；仅有完成时间不够。
6. **一次修正一项责任**：专项暴露、短期恢复、环境、残差都有唯一主应用点。
7. **同参考系更新**：TA 和用于更新的 CA 必须共享 baseline epoch；不能把旧坐标 TA 与新坐标 CA 混算。
8. **不把缺信息学成退步**：向 50 收缩可以改变展示估计，但不能单凭缺维度拉低 TA。
9. **发布不可半成功**：同一 API 返回的快照来自一致的已发布 bundle，不混入失败候选。
10. **回滚不重写原始健康事实**：恢复兼容的代码、模型、指针与配置组合，不删除真实训练记录。

### 2.4 本轮范围边界

保持浏览器 Web、API/shared 包为主；保留既有 iOS API 消费兼容，不在 iOS 重写计算模型。
不新建 native 产品、不扩 Watch、不新增 HealthKit 写入、不改变窄屏冻结区域。
若后续确需调整 iOS 展示契约，应单独获准并运行 iOS gates；本文只列兼容要求。

---

## 3. 版本、契约和兼容策略

### 3.1 真实版本矩阵与建议目标

> 🔴 **订正（2026-09-29）**：下表原有的"当前源码"列是 **2026-09-28 的时点快照**，现已过期。
> 本版把它换成**实测列**，并新增"判定"列。原表被本表取代，历史见 git 历史的 09-28 提交。
>
> ⚠️ **订正的理由不是"数字变了"，而是原表会把人带向错误方向**：`feature config` 与
> `scoring config` 的实测值都**高于**原表写的目标值，照着原表去"升级"等于**降级**。
> 按本节首段自己的规则（"若实施前已有新版本，应顺延，不能覆盖既有版本含义"），
> 这两个目标值应作废、以实测为准。
>
> 实测口径：工作区（HEAD `62b4a97` + 未提交改动），取各领域 `*_VERSION` 常量；复查命令见附录 C.3。

| 领域 | 建议目标（09-28 设计） | 实测（09-29） | 判定 |
|---|---|---|---|
| canonical health | 默认保持 | `canonical-health-v2` | ✅ 未变 |
| workout feature schema | `workout-feature-v4` | `workout-feature-v4`（另 `LEGACY_FEATURE_SCHEMA_VERSION = workout-feature-v3`） | ✅ 已到位 |
| feature config | `feature-config-v9` | **`feature-config-v11`** | ⚠️ **已超过目标 2 版** |
| scoring config | `rai-model-config-v5` | **`rai-model-config-v12`** | ⚠️ **已超过目标 7 版** |
| scoring engine | `rai-v2.0.0` | `rai-v2.0.0` | ✅ 已到位 |
| physiology model | `rai-physiology-v1.8.0` | `rai-physiology-v1.8.0` | ✅ 已到位 |
| physiology output schema | `physiology-prediction-v2` | `physiology-prediction-v1` | 🟡 未升，且**不该**为对齐本表而升（要新语义/必需字段才升） |
| residual feature schema | `race-residual-feature-v4` | `race-residual-feature-v4` | ✅ 已到位 |
| CatBoost artifact family | `race-residual-catboost-v4` | `race-residual-catboost-v4` | ✅ 已到位 |
| Ridge | 兼容保留，语义变更后 v2 | `race-residual-ridge-v1` | ✅ 未变 |
| training load config | `training-load-config-v5` | `training-load-config-v5` | ✅ 已到位 |
| training zone config | `training-zone-config-v4` | `training-zone-config-v4` | ✅ 已到位 |
| Readiness | `rai-readiness-v1.0.0` | `rai-readiness-v1.0.0`（另 `READINESS_RULE_SET_VERSION = rai-readiness-ruleset-v1`） | ✅ 已到位 |
| Durability | `rai-durability-v1.0.0` | `rai-durability-v1.0.0` | ✅ 已到位 |
| normalization | `performance-normalization-v1` | 只有 identity adapter（N0），**无 fitted adapter** | 🔴 未落地（工程项，见 §5.2 与 Phase 3） |
| Coach | `rai-coach-v2.0.0` | 无独立常量 | 🔴 未落地（工程项） |
| 跨领域 eval | `rai-model-eval-v1` | `rai-model-eval-v1`（另 `MODEL_LINEAGE_SCHEMA_VERSION = model-lineage-v2`、`MODEL_CHECKPOINT_VERSION = rai-model-checkpoint-v2`） | ✅ 已到位 |
| SQLite | migrations 到 v22，v23 起增量 | **代码到 v24**；本地库仍 22 | 🟡 代码已备，**库未升级**（部署闸门见 §17.6） |

> **本表怎么用**：它只回答"命名与当前值是什么"。**不要**把"判定 ≠ 已到位"当成待办清单 ——
> `normalization` / `Coach` 的"未落地"是**尚未实施的工程项**（有各自的 Phase），
> 靠改常量名假装完成是本方案明令禁止的那一类作弊。

`MODEL_CONFIG_VERSION` 目前定义在 `/Users/ta/running/packages/scoring/src/model.ts`，不是 contracts。
契约层可以新增共享类型，但不要为照抄清单随意迁移常量所有权或制造循环依赖。

### 3.2 统一谱系

建议所有 V2 派生快照引用以下 envelope；名称可以按代码风格调整，信息不可省略：

```ts
interface ModelLineageV2 {
  sourceRunId: string;
  datasetVersion: string;
  factsSnapshotHash: string;
  overrideSnapshotHash: string;
  modelVersion: string;
  featureSchemaVersion: string;
  configVersion: string;
  configHash: string;
  baselineEpochId: string | null;
  normalizationVersion: string | null;
  normalizationConfigHash: string | null;
  timezoneIdentifier: string;
  asOf: string;
  dataThroughAt: string | null;
  calibrationCohortHash: string | null;
}
```

说明：

- `calibrationCohortHash` 无校准样本时为 null，不能写空 hash 伪装已校准。
- `asOf` 是计算时点，`dataThroughAt` 是实际使用事实的截止点；不能互相替代。
- 存储 `configHash` 的同时保留规范化配置正文，否则无法回放。
- 业务时区写入谱系，不能靠服务器所在时区隐式推断。
- 对输入排序、JSON canonicalization、非有限数、null 做统一定义。
- `createdAt`、耗时、任务 ID 等非语义字段不纳入“数值结果确定性”hash。

### 3.3 V3 → V4 不是类型断言

建议保留只读历史 V3 decoder，新增 V4 decoder 和 runtime validator。
仅把旧 JSON 改写 `schemaVersion` 不是升级。

转换有两种模式：

1. **完整重提取**：原始 workout、速度/心率时间线、路线和当时可得上下文齐全，使用 V4 extractor 生成新 run。
2. **历史兼容读取**：只有 V3 JSON 时保留旧字段；新增 decoupling、environment 等置 null 并标 `unavailable_in_legacy_feature`。此记录不能冒充完整 V4 Fitness 学习证据。

旧 Recovery/Cardio 字段冻结在旧类型及旧数据库列中，不删除历史内容；新 score vector 不再输出对应有效权重。

### 3.4 跨版本比较必须显式

V1/V2 分数不是天然同标尺。更改权重或基线后，历史曲线跳变可能来自算法，不是体能突变。

建议：

- V2 首次发布对可用历史重新回放，形成同版本完整时间线。
- 历史不足则展示“重新校准”，不强行延续 V1 TA。
- 导出/API 同时返回模型版本，UI 在切换点显示模型更新说明。
- 保留 V1 只读结果和可运行版本/构建产物，供比较与回滚。
- 旧 checkpoint 仅能由精确兼容的旧引擎复用；V2 必须全新 checkpoint 状态版本。

---

## 4. 数据质量、时点与特征工程

### 4.1 先解决证据接口，再增加公式

现有 `WorkoutFeatureSource` 已包含速度样本，但心率主要以 summary 表达；不能用一个平均 HR 和一个速度 CV 凭空推导前后半程解耦。
V4 应由 application 装配对齐后的时间序列，features 只做纯计算。

```ts
interface TimedWorkoutEvidenceV2 {
  trainingSessionId: string;
  startAt: string;
  endAt: string;
  activeDurationSeconds: number;
  elapsedDurationSeconds: number;
  speedSamples: TimedValue[];
  heartRateSamples: TimedValue[];
  elevationSamples: TimedValue[];
  availableAt: string | null;
  sourceConfidence: number;
}
interface TimedValue {
  startOffsetSeconds: number;
  durationSeconds: number;
  value: number;
}
```

需保留现有暂停/重叠样本去重规则，限定在 active 时间范围内汇总，禁止重复计算重叠秒数。

### 4.2 V4 特征结构

```ts
interface WorkoutFeatureVectorV4 {
  schemaVersion: "workout-feature-v4";
  id: string;
  featureRunId: string;
  trainingSessionId: string;
  workoutStartAt: string;
  sessionType: SessionType;
  eligibilityStatus: EligibilityStatus;
  raw: {
    speedMetersPerSecond: number | null;
    efficiencySpeedPerBpm: number | null;
  };
  comparable: {
    speedMetersPerSecond: number | null;
    efficiencySpeedPerBpm: number | null;
    stratumId: string | null;
    normalization: NormalizationTrace;
  };
  execution: {
    pacingConsistency: number | null;
    heartRateConsistency: number | null;
    aerobicDecouplingPct: number | null;
    intervalExecutionQuality: number | null;
  };
  evidence: {
    dataCoverage: number;
    comparability: number;
    effectiveObservationCount: number;
    flags: string[];
  };
  lineage: ModelLineageV2;
}
```

与参考方案有意不同：**不把完整 readinessEvidence 继续嵌入 Fitness feature**。
日级恢复通过独立 `ReadinessSnapshot` 关联；这样类型层就降低误用恢复重新进入 scoring 的概率。
历史解释如需关联夜间数据，可存 source ID，不作为 scoring 输入。

### 4.3 缺失和零值约定

| 情况 | 表达 | 禁止行为 |
|---|---|---|
| 无 HR | efficiency=null，reason=hr_missing | 用默认 150 bpm 填补 |
| 无天气 | normalization=unavailable | 将 15°C/50% 写成实测值 |
| 平路且修正量确为零 | status=not_needed，值可等于 raw | 与缺少坡度数据混为一谈 |
| 无后半程速度/HR 对齐 | decoupling=null | 用全程平均值估算 |
| 无机械负荷标定 | mechanical=null | 输出 0 表示无机械压力 |
| 无可评估恢复 | not_assessed，score=null | 默认为 50、0 或 ready |
| 有明确完整观察且没有训练 | daily observed load=0 | 把未导入的日期也当休息日 |

### 4.4 数据质量分层

至少区分：信号覆盖、设备来源、时序完整性、课型可比性、环境可比性、历史成熟度。
不要把当前 `qualityScore` 同时当三四个独立因子相乘，从而重复惩罚同一缺失。

候选做法：

- dataConfidence：覆盖、噪声/异常、时间对齐、来源可靠性。
- comparability：课型、强度分层、路面/环境、暂停结构。
- maturity：有效训练数、跨度、基线稳定性。
- evidenceCoverage：本次可用维度权重占比。

第一版这些是规则证据强度，不是“预测正确概率”。只有用外部结果校准后才可赋予概率解释。

### 4.5 稳定性与执行质量

稳态跑的 pacing consistency 和 HR consistency 可继续基于合格窗口 CV 生成，但须限定同类训练和时间长度。
慢跑中配速整齐不能直接等于能力高；间歇有意波动也不能直接等于能力差。

建议第一版：

- 原 stability 作为稳态表现可靠性的组成，不把所有 execution 特征都各自加一份 CA 权重。
- intervalExecutionQuality 只有在有目标区间、分段结构时输出；无结构则 null。
- aerobic decoupling 首先进入 Durability 的证据层，不立即同时进入 CA 与 Durability 数值罚分。
- 先保留旧 stability 兼容计算，新增指标做解释与离线消融，校准后再替换。

### 4.6 有氧解耦定义（候选）

选择持续、无明显间歇、环境相对一致的稳态片段；剔除热身/冷身和暂停，再按有效运动时间等分。

```text
EF_first  = mean_time_weighted(normalized_speed_first) / mean_time_weighted(HR_first)
EF_second = mean_time_weighted(normalized_speed_second) / mean_time_weighted(HR_second)
decouplingPct = 100 × (EF_first − EF_second) / EF_first
```

约束：

1. 前后半段均有足够 HR/速度共同覆盖；最低时长/覆盖率作为待回测配置。
2. EF_first≤0 或有非有限值直接不可用。
3. 正值代表后段效率下降；负值允许存在，不无条件截断为零。
4. 后半程爬坡、气温变化、补给/停顿、心率漂移均可能解释变化，不宣称它只测量耐力。
5. 仅用于匹配时长、强度、地形的比较，不跨全部训练直接排序。
6. 保存片段 ID、排除秒数、两段均值和 coverage，解释可重建。

### 4.7 迟到、删除和身份变化

V2 继续遵守现有 tombstone、训练 session 去重、override revision、dataset generation 机制。
某训练重复导入不应产生第二次 TA 学习，睡眠补录不应让旧训练再贡献一次负荷。

当迟到事实影响历史时：

- 恢复事实只重算相应恢复/Coach 窗口；严格隔离后的 Fitness 不因该事实变更。
- 训练距离/心率/路线变更可能影响 Fitness、负荷、Durability、预测；按各领域依赖传播。
- 被删除训练不能继续存在于 rolling exposure、模型标签、checkpoint 状态。
- 不将重新计算视为“新训练”；以事实版本与 run identity 判定。

---

## 5. 环境与生理可比性归一化

### 5.1 不重复已有预测修正

当前生理包已有热湿度/爬升 penalty，且 `performanceVdotEvidence` 使用：

```text
neutralSeconds = observedSeconds / (1 + historicalConditionPenalty)
```

升级目标是**统一 adapter 与修正谱系，并扩展到普通训练表现**，不是在这条链前再乘一次相同环境系数。

### 5.2 当前数据可得性

当前 canonical workout 有 metadata，route point 有 elevation；预测情景已有 temperature/humidity/elevation 字段。
但这不等于每次 workout 都有可用的同期天气，更不等于有风向、气压、精确坡度剖面。

本轮建议：

1. 先盘点每个字段的可用率/时点来源，报告而非猜测。
2. 对现有 metadata/route 可提取的字段建派生上下文，不强制升级 canonical contract。
3. 新天气服务不作为必需依赖；若引入，应另批 provider、缓存、定位隐私、调用成本和历史可得时间。
4. 坡度修正需要距离对齐的坡度分布；`totalGain / totalDistance` 不能替代有上下坡抵消的真实 profile。
5. 风速无相对路线风向时，第一版仅标环境不确定，不给精确风阻修正。

### 5.3 Adapter 契约

```ts
type NormalizationStatus =
  | "applied" | "not_needed" | "unavailable" | "out_of_domain";
interface NormalizationTrace {
  adapterVersion: string;
  configHash: string;
  status: NormalizationStatus;
  sourceContextHash: string;
  correctionFraction: number | null;
  comparability: number;
  reasonCodes: string[];
}
interface PerformanceNormalizationAdapter {
  version: string;
  normalize(input: NormalizationInput): NormalizedPerformance;
}
```

`not_needed` 表示有足够证据且处于 adapter 的参考条件；不是“缺信息所以不修正”。
缺数据时可保留 `rawComparableFallback` 用于低置信度解释，但 normalized 字段本身应为 null，不能谎报“已归一化”。

### 5.4 推进顺序

- N0：identity adapter + 状态/谱系，保持现有数值；收集覆盖报告。
- N1：将**现有**预测条件修正统一封装，保持 golden outputs。
- N2：有路线质量时加入坡度片段修正，独立回放。
- N3：温湿度候选校准；不同时上线多个未验证项。
- N4：风、海拔适应等复杂项不在本轮默认范围。

每步均留 `raw` 和 `normalized`，支持禁用 adapter 回到明确旧路径，不能覆盖原始事实。

### 5.5 环境责任账本

每个预测记录至少区分：

- 历史证据去环境偏差：作用于过去表现，推断中性能力。
- 目标比赛情景：作用于中性预测，给定未来温湿度/爬升。
- 残差模型输入：说明 baseline 是否已包含上述条件；残差只学习剩余偏差。

允许“过去热天去偏差 + 未来热天加情景”，因为是两个不同对象。
禁止“同一历史热惩罚被 adapter 与 `performanceVdotEvidence` 各去一次”。

---

## 6. Fitness：CA、TA、双基线和证据更新

### 6.1 权重方案：先隔离变化，再调参

建议至少建立两个候选，避免一次更改太多自由度：

| 候选 | Efficiency | Pace | Stability | Recovery | 用途 |
|---|---:|---:|---:|---:|---|
| V1 当前 | 0.375 | 0.3125 | 0.1875 | 0.125 | 旧对照 |
| V2-A 去恢复后等比例重归一 | 3/7 | 5/14 | 3/14 | 0 | 隔离恢复拆分影响 |
| V2-B 原方案候选 | 0.45 | 0.35 | 0.20 | 0 | A 验证后比较 |

Cardio 权重本来就是 0，删除新 scoring vector 字段不应改变数值。
首轮以 A 作为最小变更控制组：3/7≈0.4286、5/14≈0.3571、3/14≈0.2143。
这是去掉 0.125 Recovery 后除以 0.875 的代数结果，**不代表 A 的统计效果优于 B，也不代表权重已经校准**。
首轮若按兼容性选择 A，只能称“边界修复版本”，不能称“最优权重版本”；B 不因数字好看自动胜出。

Pace 与 efficiency 均含 speed，存在相关性；证据覆盖不能当作“三次独立测量”。
回放须报告相关性/消融结果，再决定是否进一步降低 pace 权重或调整课型输入。

**必须随权重 PR 提交的报告，不能留成可选 TODO：**

1. 同一事实快照、参考系、缺失政策下，比较 A、B、去 Pace、去 Efficiency、去 Stability 五个候选；删维度后剩余权重归一，但明确各候选可评分率和样本流失。
2. 对 raw 与 normalized 信号分别给出 Pearson/Spearman 相关性、样本量，并按 comparisonStratum 和设备来源分层；不把跨课型混合相关性当作层内冗余证据。
3. 同时报告公共可比较样本上的数值差异与全部目标样本上的 coverage，防止通过丢弃困难样本获得较好结果。
4. 报 CA 分布/饱和率、TA 更新幅度/方向接受率；有适用外部标签才报告外部效度，不拿 V1 分数当“真值”。
5. 无标签时仍需完成相关性和行为消融，但 A/B 精度排序必须为 `not_evaluable`；缺少上述工程报告则该权重 PR 不满足验收。

### 6.2 首要模型问题：训练意图与表现可比性

同一人轻松跑比节奏跑慢，并不说明能力下降。
仅去掉 Recovery 仍不能解决把“训练安排不同”误学成“Fitness 变化”。

建议采用 `comparisonStratum`：

- steady aerobic：稳定有氧、强度与持续时间在配置范围内。
- threshold / sustained hard：持续较高强度片段。
- race / standardized test：明确协议的全力证据。
- interval：只比较相近 work/recovery 结构；没有可比结构不做负向能力学习。
- recovery / unknown：允许展示，但默认不作为长期能力下降的强证据。

第一版不要建立几十个稀疏分桶。先以少量可解释层级和最低样本门槛运行；样本不足回退为不可比较，而不是自动跨课型混合。

将这条原则写成版本化配置，而非靠开发者自觉：

```ts
interface ComparabilityPolicy {
  allowedStrata: string[]; // 首版至多上述五类；不再按天气/设备做笛卡尔积拆桶
  maximumStrata: 5; // 配置解析必须拒绝超过上限，不只是文档建议
  minimumIndependentSessions: number;
  minimumSpanDays: number;
  lookbackDays: number;
  extendedLookbackDays: number | null;
  allowCrossStratumFallback: false;
  insufficientPolicy: "not_comparable";
}
```

- 候选最低门槛先沿用 6 次独立训练/14 天跨度，**只是兼容起点而非统计充分性保证**；须按桶检查，不用全局 N 替代。
- 一个 session 的多个窗口不算多次独立训练；比赛/测试协议也不能因同属一大类就互相替代。
- 首版近期窗口按已声明的 28→42 日单次扩窗政策评估；不能为凑 N 无限追溯或暗中放宽课型。
- 样本仍不足时 `comparabilityStatus=not_comparable`、`learningObservation=null`；缺少参考分布时 CA 也不强算。
- 不可比较同时约束正、负学习。不得只禁止负向、却允许同一类稀疏证据推高 TA。
- 回放必须输出每桶独立 session 数、跨度、可比较率、扩窗率、拒绝原因，以及禁止跨桶 fallback 的断言。
- 可比较率过低首先视为证据/分层设计问题；调整分层必须新政策版本和重新回放，不由运行时自行合桶。

### 6.3 双基线的真正含义

**Long-term reference**：定义 Fitness 的坐标系。
首轮可继续使用固定 calibration epoch 的 Median/MAD，只改变新输入和维度，不立即滚动重置。
后续候选可使用 90–180 日慢速参考，但必须解决标尺迁移。

**Adaptive baseline**：28 日候选窗口，样本不足可按配置扩到 42 日；用于近期异常和可比性，不直接替换 CA 的长期 center。
两个 baseline 都只使用本次训练前已可得的合格样本。

```ts
interface PersonalBaselineV2 {
  longTerm: {
    epochId: string;
    dimensions: RobustDimensionBaselines;
    sourceFeatureIds: string[];
    referenceThroughAt: string;
  };
  adaptive: {
    dimensions: RobustDimensionBaselines;
    windowDays: number;
    sampleCount: number;
    referenceThroughAt: string | null;
  };
}
```

### 6.4 防止“进步被滚动基线吃掉”

如果运动能力提升的同时 center 跟着上移，z 会回到 0，CA 回到 50，TA 可能被错误拉回。
因此：

1. 长期指数默认锚定 epoch，不每次训练更新尺度。
2. 如需 rebase，离线生成候选 epoch 和明确版本的新视图；历史事实时间线不原地覆写。新参考系重估过去分数属于回顾性展示，不冒充当时预测。
3. 不把一个聚合旧 TA 直接线性搬到新 baseline；多维评分与 clip 后不存在通用一维精确变换。
4. 必须在线过渡时，设计单独的 bridge calibration 和最小样本门槛，并明确旧新不可直接比较；不在首版引入。
5. 同一 evidence 被评估后才可加入 future adaptive baseline。

**Rebase 触发与频率（候选运维政策，尚未校准）：**

| 项目 | 首版政策草案 | 边界 |
|---|---|---|
| 检查频率 | 每 28 天最多一次，或用户请求检查 | 这是轻量统计检查，不是周期全量重算/双跑 |
| 自动重建 | 关闭；检查只生成候选请求 | 到日期不等于必须换标尺 |
| 最小 epoch 间隔 | 90 天 | 候选冷却期，不是人体适应周期结论 |
| 饱和触发 | 一个有效维度在近期合格证据中 ≥20% 达到上限或下限，连续两次检查成立 | 需独立训练至少 12 次；排除设备/输入错误后才建候选 |
| 证据不足 | `rebaseStatus=insufficient_evidence` | 保留旧 epoch、提示标尺/数据限制，不强行重建 |
| 正式启用 | 完成同事实、同截止时间比较与 transition gate | 更新必须带新 epoch/config 与发布记录 |

这些触发数字须进入配置与参数台账，回放前冻结；若分布分析不支持，改配置而非将其宣传为科学阈值。
由候选重建到正式发布仍按离线任务和原子发布流程执行，不恢复线上常驻双跑。

**长期曲线和用户解释必须同时实现：**

- 保存 `oldEpochId/newEpochId/effectiveAt/rebaseReason`，在切换点显示“参考基线已更新；分数标尺发生变化，不代表该日体能突变”。
- 默认事实曲线按 epoch 分段，切换处不连成日涨跌，不跨 epoch 计算“本周提升 X 分”。
- 如提供“按新标尺重估历史”视图，整条曲线使用同一展示版本并标注“回顾性重估”；旧视图仍可查看。
- 利用较晚数据形成的新参考系重估早期表现，不得回流为 `as_known_then` 训练特征/预测结果；历史评估继续使用当时有效 epoch。
- 新 epoch 的 TA 必须由切换时点之前可得的证据按新政策独立初始化/重建，不将旧聚合 TA 直接复制过去；证据不足则重新校准。
- rebase 后旧曲线不可写成“历史预测也变准确了”；基线饱和改善与外部预测精度改善分别验收。

### 6.5 缺失维度收缩：正确公式与正确承诺

设全部维度权重合计为 1，可用集合为 A：

```text
coverage = Σ(d∈A) w_d
CA_observed = Σ(d∈A) w_d × score_d / coverage
CA_display = 50 + coverage × (CA_observed − 50)
```

coverage=0、低于最低权重门槛或关键维度不可用时，CA=null，不能靠收缩强行给 50。
最低覆盖门槛初始保持 0.65，以便隔离变化。

**这个公式保证的是：相对于同一组剩余证据的 CA_observed，展示值更接近 50。**
它不保证删掉任意一个维度后，总分一定向 50 移动。

反例：两个维度各占 0.5，分数为 100 和 0，完整 CA=50；移除 0 分维度后，收缩值=75。
因此原方案的“缺数据绝不会更极端”必须改写，否则会写出数学上不成立的验收。

可执行的安全约束：

- 同一 observed score 下，coverage 越低，离 50 的偏离越小。
- 对固定可用维度，区间宽度不得因 coverage 下降而缩小。
- 原始维度值不变仅质量降低时，confidence 不得上升。
- coverage 不足不进入 TA 学习，必要时不发布数值分数。
- 不把缺失填成理想表现；明确告诉用户哪些维度没看到。

### 6.6 展示 CA 与 TA 学习目标分离

如果 TA=70，观测表现=70，coverage=0.65，则 CA_display=63。
若直接用 `63−70` 学 TA，会把“没有看到全部证据”错误解释为能力下降。

因此建议保留两层输出：

- `currentAbility`：经覆盖收缩的展示估计。
- `learningObservation`：完整/足够可比证据下的学习目标；不足时 null。

首轮保守策略：负向学习只允许完整关键维度和强可比证据；缺失情形不产生负向更新。
正向是否允许部分维度学习也需同一质量政策，不默认“只要表现好就破例”。
如后续采用概率状态估计，应使用观测方差而不是对同一缺失既收缩又多次乘惩罚。

### 6.7 Confidence V2

```ts
interface ConfidenceV2 {
  dataConfidence: number | null;
  comparability: number | null;
  maturity: number | null;
  evidenceCoverage: number;
  evidenceReliability: number | null;
  evidenceStatus: "available" | "insufficient_evidence";
  modelConfidence: number | null;
  overall: number | null;
  overallStatus: "not_calibrated" | "available" | "insufficient_evidence" | "out_of_domain";
  aggregationPolicyVersion: string;
  calibrationArtifactId: string | null;
  calibrationTarget: string | null;
}
```

第一版 `modelConfidence=null` 合法，表示尚无误差校准；不能随意赋 0.9。
**第一版不把 modelConfidence 与规则因子做几何平均；将“规则证据可靠性”和“经过联合校准的 overall”彻底分开。**

规则组合明确为：

```text
E = exp(w_data × log(dataConfidence)
      + w_comparability × log(comparability)
      + w_maturity × log(maturity))
evidenceReliability = E
```

三个权重必须在配置中为正且和为 1；候选可采用 .60/.25/.15，把原 coverage/source 权重归入 data 一项。
这只继承权重组织思路，不保证与旧 qualityScore/多次来源折扣的数值等价，需做差异报告。
dataConfidence 的信号覆盖和设备来源只能计入一次；evidenceCoverage 用于覆盖政策，不再默认额外乘入 E。

| 输入情形 | evidenceReliability | modelConfidence / overall | 下游动作 |
|---|---|---|---|
| 三项规则因子均有效，模型未校准 | 按 E 计算 | 均 null；overallStatus=not_calibrated | TA 按 E 与证据门控判断；不显示“总体正确率” |
| 任一必需规则因子缺失 | null | modelConfidence/overall 均 null；overallStatus=insufficient_evidence | 不执行 TA 学习；不忽略该因子重归一 |
| 任一必需因子确为 0 | E=0，显式零分支，不算 log(0) | modelConfidence/overall 均 null；overallStatus=insufficient_evidence | 禁止此次学习；0 不等于未知 |
| 存在校准报告但当前样本超出适用域 | E 可保留 | modelConfidence/overall=null；out_of_domain | 仅保留规则证据解释 |
| 所有输入满足联合校准 artifact 的合同 | E 可保留 | 由该 artifact 计算，不用任意乘积冒充概率 | 同时提供 target、版本与适用域 |
| NaN、Infinity 或超出 [0,1] | 输入校验失败 | 不产生可用 snapshot | 不用 clamp 或默认值掩盖错误 |

未校准情况下 `overall=null` 是产品合同，不是待前端补默认值的缺口。
必需规则因子完整且 E=0 时 `evidenceStatus=available`（已观测到零可靠性）；任一必需因子缺失才为 insufficient_evidence。两者均不允许此次 TA 学习，但诊断原因不得合并。
禁止 `modelConfidence ?? 1`、`overall ?? 0`、静默删除 null 因子或前端用 E 替换 overall。
TA 门控中的“confidence ≥0.75”在本版统一改指 **evidenceReliability ≥0.75**，不是 overall。
第一版只展示“证据可靠性（规则估计）”；未来联合校准须定义具体目标事件及独立验证，不能把任意 [0,1] 数值称为正确概率。

### 6.8 TA 连续学习率

候选：

```text
α(N) = α_min + (α_max − α_min) × exp(−N / k)
α_max = 0.15, α_min = 0.04, k = 25
```

这些值来自参考方案，作为待回放候选，不是本次优化的实测最优值。
N 定义为“本 epoch 内此前合格学习机会数”，不能由刷新页面、重算次数或导入次数累加。
固定 N 的计数时机，并写入 checkpoint。

### 6.9 TA 更新与双向门控

```text
residual = clamp(learningObservation − TA_before, −12, 12)
α_eff = α(N) × evidenceReliability × sessionEvidenceStrength × growthResistance
TA_after = clamp(TA_before + α_eff × residual, 0, 100)
```

`growthResistance` 仅正向按旧规则应用；负向为 1，避免双重减弱。
删除 `directionFactor(recovery)`，但不要顺便把所有负向学习增强 2.5–4 倍而不评估。
新门控与残差分布需共同比较。

负向学习候选条件：

- 当前为 eligible，不是 trial/excluded/calibrating。
- `evidenceReliability` 达到候选门槛 0.75，可比性达到候选门槛 0.90；其 null 规则按 §6.7。
- 足够完整的关键维度；同 baseline epoch。
- 当前训练可作为能力证据，不是恢复跑、无结构间歇或未解释的地形变化。
- normalization 为 applied 或证据充分的 not_needed；unavailable 并非永远禁止，而是由独立的可比性证据政策决定。
- 连续 K 次独立合格负残差或强协议测试确认；K 为候选 2–3，必须回测。

**禁止条件中读取 readiness score、睡眠、HRV、RHR 当天恢复比值。**
HR 本身作为 workout 内的效率观测允许存在；这里隔离的是恢复测量通道，不是禁止运动心率。

正向也要检验 GPS 速度尖峰、设备切换、下坡和比赛异常，避免“只防下降不防虚高”。
报告 positive/negative acceptance rate，防止 TA 成为只升不降的棘轮。

**接受率报告必须有不被门控本身改变的分母：**

```text
正/负候选机会 = 已能计算同参考系 candidateObservation、基础数据合法、残差超出版本化死区的独立训练
positiveAcceptanceRate = 正向门控接受次数 / 正向候选机会数
negativeAcceptanceRate = 负向门控接受次数 / 负向候选机会数
```

`candidateObservation` 是质量硬校验通过、评分参考系可用后，但尚未执行待比较 .75/.90/K 门控的诊断观测；不得用已经被门控清空的 learningObservation 反算机会数。
“基础数据合法”不包含待比较的 .75/.90/K 三个门槛，否则会把被拒的困难样本从分母排除。
连 candidateObservation 都无法形成的训练另报 `unscorableRate`；不把它们抹掉，也不将缺失接受率填成 0。
分母为 0 则该率=null，并报告 0 次机会；先算各组数量，再算比率。

必须按课型、`normalization.status`、环境数据覆盖、comparisonStratum、证据覆盖分别报告机会数、接受数、率及拒绝原因，并做以下验收：

1. 对同一份预先标注的真实连续退步案例，报告首次有效负学习所需的训练次数/天数、TA 累积响应；不能用 TA 自己下降来定义“真实退步”。
2. 真实案例不足时，模拟退步只能证明工程响应，实证检测效能必须 `not_evaluable`，不能伪称已验证。
3. 对训练质量相当但缺天气的病例，验证可比路线/片段仍可提供直接证据；`unavailable` 不等于 comparability 自动为 0。
4. 对有明确 work/recovery 结构的间歇训练，验证可以同结构比较；无结构 unknown 不强行给负向学习，正向也不例外。
5. 候选 grid 可比较 reliability .60/.70/.75、comparability .80/.85/.90、K=1/2/3；这些是回放实验值，不是上线默认值。一次只改变一个政策因素，并在留出案例中复验。
6. 在评估前配置每组最少机会数、可接受检测延迟与最大误判下降率；分布还未知时不要捏造一个全局“负接受率必须大于 X%”。
7. 有充分合格负机会却长期 0 接受，或预声明退步案例超过最大检测延迟，必须阻止该门控版本发布并复查/放宽非必要门槛；不能用“更保守”作为永久解释。
8. 放宽不得绕过伪 GPS、错误时间、epoch 不兼容等硬质量闸门，也不得用“目标接受率”强行制造 TA 下降。放宽后要重新验证正向虚高与负向误判。

正负接受率不要求相等；要避免的是**无法学习真实退步的系统性偏置**，不是让分数机械上下对称。

### 6.10 停跑与长期退训

保留旧停跑衰减作为第一版兼容 fallback：14 日后开始分段；不在本轮同步重新拟合。
但新增事实完整性前置条件：

- “最近没同步数据”不等于“最近没训练”。
- `daysSinceEligibleRun` 很大但观察窗口不完整时，展示数据过期，不直接推断持续停跑。
- 明确完整数据范围内的停跑才应用对应规则。
- 后续应区分“无 eligible Fitness 样本”与“完全无跑步”，低 HR 覆盖训练仍可能维持训练暴露。

---

## 7. Readiness：统一恢复模型

### 7.1 当前有四条相关路径

1. features 的 `calculateRecoveryParts`：睡眠/RHR/HRV/近期 load 构成 recoveryRaw。
2. training-load 的 `classifyPhysState`：日级身体状态分类。
3. prediction-data 的 `loadRecoveryReadinessEvidence`：恢复数值进入疲劳情景。
4. mobile-coach 的 `assessRecovery`：当日 coverage、assessment 和裁决触发。

当前 Coach 内部复用已经正确，但这四条不是一个统一领域模型。
Readiness V1 的第一目标是合并证据口径和规则所有权，而不是立即输出精确 0–100 分数。

### 7.2 新包职责

建议新增 `@rai/readiness`：

- 输入：as-of 已装配的恢复事实与个人基线。
- 输出：可评估性、单项信号、状态、解释、可选 score。
- 不读取 DB，不推导训练负荷，不调用 scoring，不读取系统时间。
- 不拥有 Coach 训练计划逻辑。

日级事实继续由 canonical nights / canonical HRV / RHR repository 提供。
`assessRecovery` 暂保留为 API 兼容 wrapper，调用新包；不得在 wrapper 继续维护第二套阈值。

### 7.3 输入与 freshness

```ts
interface RecoverySignalInput {
  value: number | null;
  baseline: number | null;
  observedAt: string | null;
  availableAt: string | null;
  evidenceLocalDate: string | null;
  source: string;
  baselineValidDays: number;
  quality: "adequate" | "sparse" | "missing";
}
interface ReadinessInput {
  asOf: string;
  localDate: string;
  timezoneIdentifier: string;
  sleep: RecoverySignalInput;
  hrv: RecoverySignalInput;
  restingHeartRate: RecoverySignalInput;
  recentNights: Array<RecoverySignalInput | null>;
}
```

按单信号判断 freshness，不能用最新的一条 HRV 将一周前睡眠“洗成今天”。
睡眠按主夜 wake local date 归属；午睡、跨日、夏令时场景单独测试。
基线不包含被评估当天；稀疏 baseline 不应伪装为完整比较。

### 7.4 输出契约

```ts
interface ReadinessSnapshot {
  modelVersion: "rai-readiness-v1.0.0";
  asOf: string;
  localDate: string;
  coverage: "none" | "partial" | "complete";
  assessment: "not_assessed" | "no_low_signal" | "low_signal" | "multiple_low_signals";
  state: "not_assessed" | "no_low_signal" | "caution" | "strained";
  stateEvidence: {
    method: "heuristic_rules";
    validationStatus: "not_empirically_validated" | "validated_for_declared_target";
    ruleSetVersion: string;
    validationTarget: string | null;
    validationReportId: string | null;
  };
  intendedUse: "training_guidance_not_diagnosis";
  score: number | null;
  scoreStatus: "not_calibrated" | "available";
  signals: Record<"sleep" | "hrv" | "rhr", ReadinessSignal>;
  reasonCodes: string[];
  lineage: ModelLineageV2;
}
```

有意不用 `no_low_signal = ready`：没有观察到低信号，尤其只有单项数据时，不等于完整恢复。
第一阶段允许所有 snapshot 的 score=null，由状态驱动 Coach，避免把旧阈值包装成未经验证的百分制。

**state 同样不是已校准结论。** 第一阶段所有 state（含 not_assessed/no_low_signal）必须携带
`method=heuristic_rules`、`validationStatus=not_empirically_validated`、实际 ruleSetVersion，validationTarget/reportId 均为 null。
现有阈值通过兼容单测，仅证明“新旧规则一致”，不能将 validationStatus 自动升级。
未来只有针对明确训练相关目标、适用样本人群和独立留出验证的报告，才允许标为 validated_for_declared_target；它仍不构成医学阈值或临床诊断有效性的声明。

API、Coach explanation、导出和 Web 提示均保留这层状态；规则版本和验证状态不能仅藏在后端。
推荐文案：“恢复提示：需谨慎（基于个人基线的经验规则，尚未经实证校准，仅供训练安排参考）”。
禁止文案：“医学阈值异常”“已证实恢复不足”“健康风险 85%”。没有低信号时也不能写“已确认完全恢复”。

### 7.5 第一阶段精确保留当前裁决阈值

| 信号 | 当前 Coach 阈值 | 第一阶段 |
|---|---|---|
| 睡眠低 | ratio < 0.75 | 保留 |
| HRV 低 | ratio < 0.85 | 保留 |
| RHR 升高 | ratio > 1.03 | 保留 |
| 睡眠 streak | count ≥ 3 | 保留调用语义，同时核验是否真连续 |
| 历史 nightsBelowSleepBaseline | 单夜 ratio < 0.80 | 保留为独立阈值，不与当天睡眠低混写 |

表中所有阈值均标记为 `heuristic_compatibility`；保留的依据是行为兼容，**不是本项目已证明的生理最优值或医学分界点**。

当前 `countNightsBelowSleepBaseline` 的实现是对传入 slots **计数**，函数自身不证明连续性。
所以“连续三夜”必须由调用者保证相邻三日 slots，或 V2 显式按日期计算连续 streak。
不能把“三个不相邻坏夜”说成“连续三夜”；修正行为需单独报告新旧判定差异。

### 7.6 恢复与负荷不互相重复造分

新 Readiness 的核心生理状态先只来自睡眠/HRV/RHR。
近期负荷作为 `context` 由 Coach 联合解释，不先降低 readiness 再被 Coach/Prediction 作为第二次负荷罚分。

如果后续确认需要负荷辅助恢复分数，必须：

- 独立标明 `physiologicalState` 与 `loadContext`。
- 通过消融比较验证是否有额外解释力。
- Prediction 的 fatigue correction 只读取统一最终状态或负荷项之一，明确排他策略。

### 7.7 四路迁移步骤

1. 抽取纯 `assessReadiness`，先复现现有 Coach case outputs。
2. Coach wrapper 和 `classifyPhysState` 改为同一个结果的枚举映射。
3. prediction recovery assembler 改为同源事实，但保留“近期背景”和“当天情景”的区别。
4. features 不再计算生产用 recoveryRaw；仅旧 V3 replay 继续使用冻结实现。
5. 静态依赖检查阻止 scoring 引入 readiness；对 wrapper 加委托测试。
6. 删除重复阈值实现前保留全部 compatibility tests。

---

## 8. Durability：专项准备度与耐久能力

### 8.1 不能把现有准备度当作空白

当前 `loadRaceReadinessEvidence` 实际已是专项准备度模型，窗口 56 天。
建议先将其语义迁移为 Preparation，保留旧计算，建立新快照；并不立即增加一个额外扣分。

当前配置摘要：

| 距离 | 周距离目标 | 最长跑目标 | 周频率 | 暴露距离/次数 | 权重 volume/long/frequency/exposure/recency |
|---|---:|---:|---:|---|---|
| 5K | 15 km | 8 km | 2.5 | ≥3 km / 2 次 | .25/.20/.25/.15/.15 |
| 10K | 25 km | 12 km | 3 | ≥6 km / 2 次 | .30/.25/.20/.10/.15 |
| 半马 | 35 km | 18 km | 3.5 | ≥12 km / 2 次 | .35/.35/.15/.05/.10 |

上述数值只是现有实现，不代表已由真实标签校准。
当前按固定 8 周分母统计，新用户仅导入两周时可能被当成训练不足；V2 要区分历史不完整与真实低跑量。

### 8.2 Preparation 与 Durability 分开存证据

- Preparation：跑量、长跑暴露、频率、目标距离相似性、持续性。
- Durability：长持续运动后，配速/效率/阈值表现是否维持。
- 可放在同一 `@rai/durability` 包中，但输出不能只有一个模糊总分。
- Race evidence 可辅助验证专项表现，但不要同一比赛既抬高 VDOT，又全额解除 preparation penalty，并再奖励 durability。

### 8.3 建议输出

```ts
interface DurabilitySnapshot {
  modelVersion: "rai-durability-v1.0.0";
  distance: "five_k" | "ten_k" | "half_marathon";
  preparationScore: number | null; // 0..1, legacy-compatible candidate
  durabilityScore: number | null; // 0..1, absent without calibrated evidence
  evidenceLevel: "insufficient" | "developing" | "established";
  historyCoverageDays: number;
  components: {
    volumePreparedness: number | null;
    longRunExposure: number | null;
    frequency: number | null;
    targetExposure: number | null;
    lateRunStability: number | null;
    matchedPerformanceEvidence: number | null;
  };
  reasonCodes: string[];
  lineage: ModelLineageV2;
}
```

一个人短跑很好但没有长跑记录时，输出 `insufficient`，不是断言“耐力差”。
充分完整历史中确实缺少目标距离暴露时，才可解释为 preparation 较低。

### 8.4 后段表现证据候选

- 8 周作为现有准备度窗口；12 周只作为另一个候选，不混在单个未标记版本里。
- 后段配速保持：同强度、同地形的分段对比。
- 有氧解耦：引用 features 的唯一计算结果，不在 durability 重算。
- repeated long-run evidence：多次合格片段比一次超长跑更可靠。
- 证据支持量：有效长跑数、可比时长总量、环境可用率、最新证据日期。

不把长跑越多越好写成无条件单调规律：超量/强度失配影响 Coach，但不通过重复的训练压力扣分污染 Durability。
单调测试只能约束固定质量和其他条件下的“证据暴露分”，不能扩展为生理因果结论。

### 8.5 接入预测顺序

D0：旧专项 readiness 改名 preparation，数值一致。

D1：输出 durability components / evidenceLevel，不改变成绩点预测。

D2：有独立历史标签后，比较“仅 Preparation”与“Preparation + Durability”的增量误差；通过才加入 correction。

D3：若 Durability 主要重复现有 preparation 信息，应合并/替换对应项，而不是继续叠加 penalty。

全马不在当前合同中，本轮不新增距离、目标、枚举或校准参数。

---

## 9. Training Load：复合负荷、向量与状态

### 9.1 保留真正的当前主线

不能将生产负荷退回“只有 Banister TRIMP”再称为升级。
当前 composite 模型已定义：

```text
HRR(t) = clamp((HR(t) − RHR)/(MaxHR − RHR), 0, 1)
rawHrrTrimp = Σ Δt_minutes × HRR(t) × exp(1.92 × HRR(t))
internalLoad = rawHrrTrimp × 100 / (60 × trimpMinute(0.85))
paceLoad = Σ Δt_hours × 100 × clamp(thresholdPace / actualPace, .5, 1.3)^2
w_hr = 0.6 × heartConfidence
w_pace = 0.4 × paceConfidence
baseLoad = (w_hr × internalLoad + w_pace × paceLoad) / (w_hr + w_pace)
distanceFactor = 1 + 0.15 × clamp(distanceExposureRatio − 1, 0, 1)
compositeLoad = baseLoad × distanceFactor
```

无可用 HR/Pace 时，已有 RPE 和课型代理 fallback。
区间覆盖和 average-only 路径有 confidence 折扣；V2 保留，不将 fallback 冒充直接观测。

训练负荷的 exponent 当前实际使用 1.92；代码虽定义 female 值 1.67，但当前分区输入尚不携带相应字段。
不在本轮未经契约/校准就自动切换系数，也不宣称当前已有性别自适应。

### 9.2 Load Vector 作为现有 breakdown 的扩展

建议不用无单位的四个新数字替代现有结构，而是：

```ts
interface LoadVectorV2 {
  rawHrrTrimp: number | null;
  internalLoad: number | null;
  paceLoad: number | null;
  compositeLoad: number;
  activeDurationMinutes: number;
  distanceMeters: number | null;
  elevationGainMeters: number | null;
  highIntensityMinutes: number | null;
  mechanicalLoad: number | null;
  mechanicalModelVersion: string | null;
  source: string;
  confidence: number;
}
```

保留 `TrainingLoadBreakdown` 已有字段与来源。
`activeDurationMinutes` 是时间而非“另一种 TRIMP”；`highIntensityMinutes` 要注明分区体系和可用覆盖。
机械负荷暂时展示距离/爬升等原始暴露即可；没有经过验证的映射时 mechanicalLoad=null。
不把距离、心率负荷、配速负荷再次任意加权为第二个 totalLoad。

### 9.3 EWMA 口径

当前 7 日与 28 日是 **half-life**，不是常见的 7/42 天时间常数：

```text
α(h) = 1 − exp(−ln(2)/h)
ATL_t = α(7) × L_t + (1−α(7)) × ATL_(t−1)
CTL_t = α(28) × L_t + (1−α(28)) × CTL_(t−1)
ACWR_t = ATL_t / CTL_t
```

保留首个已观测训练日初始化，不将未知前史补 0。
当前 ACWR 需至少 21 日历史、6 次训练、CTL≥5 才可用。
V2 不在同一变更中把 28 改为 42，否则全部阈值和残差特征语义随之变化。

### 9.4 RecoveryDebt 的正确命名

候选 `max(0, ATL−CTL)` 可计算，但其单位仍是日 EWMA 负荷，且只是 ATL/CTL 的派生量。
它不是睡眠债、不是真实生理恢复债，也不是新的独立证据。

建议内部命名 `acuteLoadExcess`，UI 文案“短期负荷高于长期负荷”；若保留 RecoveryDebt 必须注明“负荷代理”。
不得与 ATL、ACWR 三次分别投票提高风险。

### 9.5 ACWR 降权：两个位置都要改

当前：

- `classifyTrainingStatus` 在 ratio>1.5 或 >1.3 时可直接返回 attention/high_load。
- `decideVerdict` 还有独立 `loadRatio > 1.3` 的 highLoad 判据。

因此只改 training-load 模块不够，Coach 仍会单独按 ACWR 置红。
V2 建议输出 `LoadAssessment`，把数值指标与行动分类分开。

第一版联合策略候选：

1. 只有高 ACWR、历史充分、其他项正常：提高关注级别，不自动认定身体疲劳或禁止训练。
2. ACWR 异常并伴随显著 ramp、strain、强度集中或低恢复：根据计划课型降阶。
3. 历史不足：load risk=unknown；不能以 ratio 无法计算判 red。
4. 高恢复不自动抵消极端负荷跃升；保留可解释的独立训练安全上限。
5. 所有决策阈值先从现有规则兼容迁移，再在离线报告中比较变更影响。

### 9.6 负荷验证

- 同一 workout 的旧 compositeLoad 在“只增向量”阶段应保持 golden parity。
- partial HR coverage 不能复制整段时长使负荷翻倍。
- 暂停、同一秒多个 sample、跨日训练的口径固定。
- sourceConfidence 降低影响置信度，不凭空创建/删除训练事实。
- monotony 的零方差、全零窗口、strain P90 历史不足均保留明确边界。
- Load Vector 不新增回溯系统时间依赖。

---

## 10. 动态分区和阈值证据

### 10.1 现有能力必须保留

当前 DailyZoneProfile 已有 manual/automatic/fallback/carried_forward 来源。
MaxHR 使用合格观测峰值：最近 180 日观测窗口、365 日可比证据、上调最多 3 bpm/步及缓慢下降政策。
无年龄时公式 fallback 当前为 190；有年龄时为 `208−0.7×age`。
阈值配速已有新证据游标、confidence 与平滑更新；手工设置可以覆盖。

V2 不把“新增 observed hierarchy”写成这些能力从未存在。

### 10.2 来源细化与优先级

建议详细 provenance：

```text
manual setting（有效期内且数值有效）
  > validated observed evidence
  > carried-forward reliable estimate（带年龄、衰减和置信度）
  > inferred prior
  > formula/default fallback
```

分别存：

- RHR source、valid days、最新观测。
- MaxHR source、来源峰值 session IDs、最近可靠日期。
- thresholdPace source 与 thresholdHeartRate source，允许不同。
- 手工 override revision 与 effectiveFromLocalDate。

不能以统一 `heartRateSource=automatic` 掩盖 RHR/MaxHR 来源不同，也不能把 VDOT-derived pace 直接说成实测 LTHR。

### 10.3 当前 LTHR 的实际短板

`estimateLactateThresholdFromEvidence` 当前先计算 VO2max prior；prior 不可用会直接返回，后面的有效分段也无法独立救活结果。
V2 可补充“高质量阈值测试独立产出”的路径，这是比新增重复 evidence 类型更实际的改进。

建议顺序：

1. 明确协议、足够时长且质量通过的 threshold test。
2. sustained/race segment 多证据一致估计。
3. Performance VDOT 推断 threshold pace。
4. HRR fallback 推断 threshold HR。

“持续 30–60 分钟”不是自动阈值证据；当前提取器已有窗口、CV、HRR 和 drift 检查，必须继续保留。
低强度持续一小时不自动成为阈值测试。

### 10.4 HR/Pace coherence

已有 zones/stimulus 分析涉及双来源与冲突，V2 应复用，而不是在 Coach 再写一遍分区。

```ts
interface ZoneCoherence {
  agreement: "aligned" | "pace_high" | "hr_high" | "insufficient";
  comparisonPolicyVersion: string;
  pairedCoverage: number;
  sustainedConflictSeconds: number;
  reasonCodes: string[];
}
```

注意 HR zone 和 Pace zone 的类别并不完全同构，不能把各自数组下标相减当“冲突分”。
需要显式语义映射与运动阶段规则；间歇中的 HR 响应滞后不应成为常态冲突。

### 10.5 防止分区反馈闭环

若先用本次训练推高 threshold，再用新 threshold 评估本次 pace load，会低估此次负荷；随后负荷又影响下一轮预测。
要求：

- workout zones/load 使用训练开始前已生效 profile。
- 新阈值证据只影响之后的 profile。
- 同一候选证据拒绝后不因 confidence 自然衰减而反复重试产生漂移。
- 手工设置退出到自动模式时保留当前代码的显式切换语义。

---

## 11. 生理预测与修正责任链

### 11.1 保留 Daniels 数值基线

速度单位为 m/min、时间单位为 min：

```text
VO2(v) = −4.60 + 0.182258 × v + 0.000104 × v²
fraction(t) = 0.80 + 0.1894393 × exp(−0.012778t)
                   + 0.2989558 × exp(−0.1932605t)
VDOT = VO2(v) / fraction(t)
```

保持现有 100 次二分搜索和 golden tests，不在本轮换数值求解器。
VDOT 与直接测得/设备估计 VO2max 含义不同，保留当前独立证据通道。
Fitness 个人指数不能直接被当作 VDOT。

### 11.2 先明确预测问题

建议 PredictionMode：

| 模式 | 恢复和环境处理 | 适用 |
|---|---|---|
| neutral_potential | 不套用今天恢复，不指定未来天气 | 中性能力参考 |
| current_prepared | 当前专项准备度；环境中性，恢复缺省不装作已知 | 平时能力展示 |
| race_day_scenario | 目标日、当时可得恢复/情景、环境 | 明确比赛情景 |

“一个月后的目标赛”不直接使用今天睡眠低作为固定成绩罚分。
未来准备度提高也不能凭空假设；要么采用当前准备度，要么明确显示用户选择的假设情景。

### 11.3 输出分层

当前 `preparedSeconds` 在 `predictRaceTimes` 中只是局部变量，没有作为既有必需输出字段返回。
V2 若要输出它，属于明确契约变更。

建议：

```ts
interface RacePredictionV2 {
  distance: RaceDistance;
  mode: PredictionMode;
  targetDate: string | null;
  potentialSeconds: number | null;
  preparedSeconds: number | null;
  scenarioSeconds: number | null;
  predictedSeconds: number | null;
  corrections: PredictionCorrection[];
  interval: CalibratedInterval | null;
  status: "available" | "insufficient_data";
  lineage: ModelLineageV2;
}
```

### 11.4 唯一责任链

```text
historical evidence normalization
            ↓
neutral Performance VDOT → potentialSeconds
            ↓
Preparation adjustment（迁移现有距离准备度罚分）
            ↓
Durability adjustment（默认关闭，独立验证后启用）
            ↓
Target environment / elevation + acute readiness scenario（一次）
            ↓
ONE selected point correction: none / bias-only / ridge / catboost
            ↓
Interval calibration on the final point predictor
```

重要区别：原方案把 Readiness 的 VDOT penalty 与原 fatigue 时间补偿同时保留，可能对恢复扣两次。
本文首轮仍保留现有 fatigue 结构，改用统一 Readiness adapter；不新增第二个恢复 VDOT penalty。
若最终改为 VDOT 空间修正，则废弃相同责任的 fatigue 项，并重训残差。

### 11.5 现有专项准备度参数

当前默认 preparation 值分别 .70/.60/.45，VDOT penalty 上限分别 3/4/6。
缺乏专项证据时当前仍使用默认值，并输出 `endurance_readiness_unmodeled`。

V2 第一阶段可以保持兼容，但 UI/解释必须显示为先验估计；后续候选比较：

- 继续先验点预测 + 扩大不确定性。
- 只展示 potential，preparedSeconds 不可用。

不能将缺数据默认 .45 说成“你的半马准备度实测只有 45%”。

### 11.6 correction ledger

```ts
interface PredictionCorrection {
  kind: "preparation" | "durability" | "environment" | "elevation"
      | "acute_readiness" | "bias" | "ridge" | "catboost";
  ownerVersion: string;
  inputSnapshotIds: string[];
  inputHash: string;
  beforeSeconds: number;
  afterSeconds: number;
  applied: boolean;
  reasonCodes: string[];
}
```

验证 `after−before` 能逐项重建最终结果；不得将多个层同时写入同一个模糊 readinessAdjustment。
修正叠加后仍需检查距离越长总时间越长、时间为正、区间有序和所有结果有限。
不强制同一速度/配速排序代表所有距离生理合理性，应使用明确的合理性校验。

---

## 12. Ridge / CatBoost / 区间校准

### 12.1 模型选择不是模型堆叠

当前 Ridge 已有最低 12 样本、lambda=2、±12% 修正，且已有 walk-forward。
CatBoost 也是 log residual：

```text
y = log(actualSeconds / baselinePredictedSeconds)
correction = clamp(exp(y_hat) − 1, −0.12, 0.12)
predicted = baseline × (1 + correction)
```

保留限幅。它是点修正安全边界，不代表真实误差只能 ±12%。
不要顺序叠加“bias 修正 + Ridge + CatBoost”导致三次修正。
发布的是一个明确的点预测 policy；校准区间针对这个最终 policy 的残差。

### 12.2 已有 CatBoost 门槛

以下是**当前源码门槛**，不是本方案新拟定：

| 门槛 | 当前值 |
|---|---:|
| 总标签数 | ≥50 |
| 每距离标签数 | ≥8 |
| 实际训练分区样本 | ≥24 |
| 每距离训练样本 | ≥4 |
| 内层 walk-forward 预测 | ≥12 |
| 每距离 walk-forward 预测 | ≥3 |
| release holdout 总数 | ≥24 |
| 每距离 release holdout | ≥6 |
| 时间 embargo | 24 h |
| bootstrap 次数 | 2000 |
| 每 block 事件 | 3 |
| 最少有效 block | 6 |
| MAE 改善 | ≥5% |
| 单距离 MAE 退化 | 不超过 5% |
| 区间覆盖率下降 | 不超过 5 个百分点 |
| bootstrap 改善下界 | 应为正 |
| ONNX parity | 最大绝对差严格 <1e−6 |

不能因本地标签为 0 而下调这些门槛“让模型跑起来”。
满足总数也不代表所有分区条件自动满足；须按实际时间切分验证。

### 12.3 V2 新增的是统一竞争门槛

在同一批测试样本、同一 as-of、同一 baseline 和同一距离集合上比较：

- C0：当前可发布的物理/规则基线。
- C1：简单 bias-only，可作为诊断对照。
- C2：现有 Ridge challenger。
- C3：CatBoost。

CatBoost 必须优于 C0，也优于实际可用的 C2；若 Ridge 因样本不足不可训练，不能将它的误差填无穷大来宣称获胜。
可只发布 baseline，待充分样本再比较。

收益阈值预先写评估配置：现有相对 baseline ≥5% 继续保留；相对 Ridge 的额外收益要求由 cohort 验证前冻结。
不得看过 holdout 后微调阈值或树深，再沿用同一个 holdout 宣称独立验证。

### 12.4 特征语义升级必须重训

当前 23 个数值特征加 3 个 distance flags；schema hash 已硬校验。
现有 `readiness` 表示距离准备度，`recoveryReadiness` 表示恢复背景。
V2 不能保留列名/顺序但把前者改为当日恢复。

必须同步：

- contracts 的名称、顺序、schema JSON/hash。
- application 的训练样本和推理输入。
- Python contract 与解析/缺失处理。
- ONNX manifest、parity fixture、activation validator。
- baseline fingerprint；normalization/readiness/durability 语义版本进入 hash。
- Ridge feature mapping 与系数版本。

缺失值继续遵循运行时 schema（现有 ML NaN），不能与 DB/API 的 JSON null 编码混淆。

### 12.5 Artifact 与激活状态

项目已有 `prediction_model_runs`、events、active pointer 和 artifact hash，不新造一个重复的万能 registry。
现有 run status 与 active bool 分离；“active”不是当前 run status 枚举。

建议补齐 metadata：

- baseline policy/version/hash。
- training/calibration/release 时间范围、as-of、cohort hash。
- 训练/校准/测试的 event IDs hash 与数量，不在公开报告泄露原始健康记录。
- normalizer/config/schema hashes。
- 三方指标、分距离指标、bootstrap 区间。
- calibration artifact 版本/hash、适用距离。
- parity 最大误差和 vector 集 hash。

本次未确认存在的 metadata 作为新增项，不描述成已经落库。

### 12.6 区间预测的正确实施

当前 optimistic/pessimistic 是规则区间，并有历史 bias/经验宽度处理；不能直接重命名为 P80/P90。

建议使用最终点预测器的 out-of-sample log residual：

```text
r_i = log(actual_i / pointPrediction_i)
P80 = [point × exp(q_0.10(r)), point × exp(q_0.90(r))]
P90 = [point × exp(q_0.05(r)), point × exp(q_0.95(r))]
```

这是候选经验分位数方案。时间相关、分布漂移和小样本下，不自动具备独立同分布的覆盖保证。
可在后续比较 conformal/分层校准，但不能引用名字就声称有保证。

### 12.7 三段数据职责

- train：学习残差模型及标准化参数。
- calibration：选择残差分位数/必要的中心偏差政策。
- test/release：最终评估点误差、coverage、宽度，不再反向调参。

现有 release holdout 不能同时拿来拟合区间分位数又证明覆盖率。
数据不足时输出 `intervalStatus=insufficient_calibration`，规则范围保留 `heuristic_range` 标签。

若 `predictedSeconds` 只是基线/模型点预测而未经中位校准，不将它直接命名 `p50Seconds`。
欲输出 p50，需明确 `point × exp(q_0.50)` 的位置校准，并避免与 bias 层重复。

### 12.8 区间门槛

- 分别报告 5K、10K、半马，以及稀疏/完整证据组。
- 报 observed coverage、样本数、覆盖率置信区间、平均区间宽度、interval score。
- P90 不得窄于 P80；lower≤point≤upper 应由约定的中心和构造保证，越界须诊断。
- 不能用无限扩大区间换取“达标覆盖率”。
- 样本量门槛和 coverage 容许区间在评估前预注册；未满足时状态为未证实，而不是默认通过。

### 12.9 P80/P90 的产品合同：目标覆盖，不是保证

P80/P90 表示 **nominal coverage target**，不能直接翻译为“你有 80%/90% 的概率落在此范围”。
经验样本上的覆盖率不自动成为某个用户某场未来比赛的条件概率；采用 conformal 也不能跳过适用假设与时序漂移说明。

建议为每个区间同时输出：

```ts
interface PredictionIntervalEvidence {
  nominalCoverage: 0.80 | 0.90;
  status: "insufficient_calibration" | "empirically_evaluated" | "out_of_domain";
  lowerSeconds: number | null;
  upperSeconds: number | null;
  empiricalCoverage: number | null;
  evaluationSampleCount: number;
  coverageConfidenceInterval: { lower: number; upper: number } | null;
  evaluationCohortHash: string | null;
  evaluationWindow: { startAt: string; endAt: string } | null;
  calibrationVersion: string | null;
  domainMatch: "matched" | "unknown" | "mismatched";
  coverageClaim: "empirical_target_not_individual_guarantee";
}
```

- 只有 calibration artifact、独立评估和当前适用域均满足发布合同，才返回可用于产品展示的 P80/P90 bounds。
- 未校准/域未知时区间 bounds 为 null；仍需展示旧规则范围时使用独立的 `heuristicRange` 字段，不挂 P80/P90 名称。
- `empirically_evaluated` 表示已评估，不等于所有门槛通过；是否允许发布仍由 coverage/width/样本量 gate 决定。
- 页面、导出、通知、Coach 文案均消费这些 metadata；前端不得把 null 证据替换成“80%可靠”。
- 推荐文案：“经验预测区间（目标覆盖 80%；验证样本 n=…、实际覆盖 …%；不保证单场结果）”。
- 数据不足时文案：“参考范围尚未经足够样本校准”，不能仅用一个隐蔽 tooltip 修饰醒目的“90%保证”。
- 漂移、适用域改变或校准失效后停止展示经验 coverage 标签，保留可解释的规则回退及失效原因；失效政策需版本化。
- 加入产品文案/序列化测试，禁止保证性声明；营销文案更新不能绕过模型状态合同。

---

## 13. Coach 单一决策源与接口迁移

### 13.1 目标输入

```ts
interface CoachDecisionInputV2 {
  asOf: string;
  localDate: string;
  fitness: FitnessSnapshot;
  readiness: ReadinessSnapshot;
  loadAssessment: LoadAssessment;
  durability: DurabilitySnapshot | null;
  plan: PlannedWorkoutContext;
  zoneProfile: DailyZoneProfile | null;
  zoneCoherence: ZoneCoherence | null;
}
```

不再传原始睡眠/HRV/RHR 和允许重算的 baseline。
保留手工计划、赛事 taper 等现有行为，不让算法重构顺便改掉用户明确安排。

### 13.2 决策顺序建议

1. 检查事实/快照是否同一 bundle、同一天、同一时区。
2. 检查计划自身边界、已有用户约束和 taper。
3. 消费 LoadAssessment 与 Readiness 结论。
4. 依据计划课型调整强度/时长，不反写 Fitness。
5. 有专项目标时参考 Durability 证据，优先调整长跑递增策略，而非把当天长期能力打低。
6. 输出 action + reasonCodes + 参数；由 renderer 生成文案。

数据不足可保守不给质量课，但 tone=yellow 的理由应是“证据不足”，不能写“身体恢复差”。
同样没有 Readiness 也不代表禁止因明确极端训练负荷而给保守建议；必须写清证据来源。

### 13.3 输出与旧 API

建议新增版本化 snapshot 字段，旧 MobileVerdict 字段由同一决策生成兼容映射。
若旧 clients 对未知字段/枚举严格校验，采用显式 API version/capability，而不是直接改旧枚举值。

```ts
interface CoachDecisionV2 {
  version: "rai-coach-v2.0.0";
  bundleId: string;
  tone: "green" | "yellow" | "red";
  action: "keep_plan" | "reduce_intensity" | "reduce_duration"
        | "easy_only" | "rest" | "collect_evidence";
  reasons: Array<{ code: string; params: Record<string, string | number | null> }>;
  inputSnapshotIds: string[];
}
```

解释层只格式化/翻译 codes，不读取原始 ratio，也不重新执行阈值分支。
同一 policy 可以有 Web/iOS 不同措辞，但结论和参数必须一致。

### 13.4 静态与运行测试

- 类型约束：CoachDecisionInputV2 不包含原始恢复测量。
- 依赖约束：scoring 不 import readiness、API、storage。
- 委托约束：`assessRecovery` wrapper 只调用领域方法。
- renderer 测试：不存在“低恢复”文案却 no_low_signal 的输出。
- 相同 snapshot、更换显示语言，action/tone/reason codes 不变。
- 不只依靠源码字符串 grep；应增加类型编译和行为测试，避免简单改名绕过静态断言。

---

## 14. 数据库存储、增量重算和发布

### 14.1 不变更原始健康事实来存派生分数

保留 canonical 原始记录、tombstones、import generations 与用户 override 历史。
V2 主要扩展派生层；需额外环境上下文时优先建立有 provenance 的派生记录。

现有可复用结构：

| 当前物理表 | V2 用途 |
|---|---|
| feature_runs / workout_features | V4 features，独立 schema/config/run |
| model_runs / ability_assessments / daily_ability_snapshots | Fitness 新 run 与旧版本历史 |
| model_checkpoints | 新状态版本，严格兼容判定 |
| training_metric_runs / workout_training_loads / daily_training_metrics | 保留 composite 主口径，扩展 vector/assessment |
| daily_zone_profiles / workout_zone_summaries | 来源和 coherence |
| prediction_model_runs / prediction_model_events | ML 工件任务与元数据 |
| active_model_run / active_prediction_model | 现有激活入口，纳入 bundle 一致性 |
| model_validation_gates | 新 gate 版本，不删除现有审计 |
| canonical_nights / canonical_hrv_days | Readiness 事实来源 |

### 14.2 最小新增表建议（设计名，尚未实现）

1. `daily_readiness_snapshots`：日级恢复状态、信号、freshness、reason codes、lineage。
2. `daily_durability_snapshots`：日期/距离、准备度、耐久证据、覆盖与 lineage。
3. `model_evaluation_runs`：跨领域评估配置、cohort/hash、结果路径或 summary、gate 状态。
4. `prediction_calibration_artifacts`：interval/bias policy、残差分位数、样本范围与版本。
5. `model_release_bundles` 和单一 active bundle pointer：仅当现有指针无法安全表达多快照一致发布时新增。

不是必须一次新增五类表；第一阶段先解决日级恢复和发布谱系，后续按依赖实施。
新物理表是否采用 JSON payload 必须结合当前查询路径，不把所有字段都塞进无校验 JSON。

### 14.3 关键键与约束

建议日级快照唯一键含：`source_run_id, local_date, timezone_identifier, model_version`；Durability 再加 distance。
规则配置 hash 在关联 run 或唯一约束中保证一个 key 对应一种配置。
模型版本相同而 configHash 不同时不能覆盖旧快照。

新增表的外键/删除策略须匹配现有 run pruning：

- 活跃 bundle 引用的 run、校准 artifact 不得被清理。
- 最近可回滚 bundle 的全部依赖必须 pin。
- 中止候选可以清理，但保留失败 gate/审计摘要。
- 不凭空加 userId 后假设已实现多租户隔离；当前数据主体范围按既有数据库部署方式处理。

### 14.4 特别风险：engineVersion 与 configVersion 混在一起

当前 `createModelRun` 和 checkpoint 路径实际使用 `MODEL_CONFIG_VERSION` 写入/比较 `model_version`，而包还另有 `SCORING_MODEL_VERSION` 常量。
因此本地库的 `rai-model-config-v3` 不只是“奇怪字符串”，它反映现有字段语义。

V2 应显式新增/迁移：

- `engineVersion`：scoring 实现版本。
- `configVersion/configHash`：公式参数与政策版本。
- 旧 `model_version` 用兼容 decoder 解读，不批量替换文本伪造历史引擎。
- checkpoint 和 artifact fingerprint 同时包含 engine/config，避免改实现不改配置时误复用。

### 14.5 必须升级现有模型版本 gate

当前 gate 名称仍为 `rai-shadow-gate-v1`，但它是实际保留的**版本发布 gate**，不是已删除的第二遍 shadow replay。
当前门槛包括：

- recovery null rate 增量≤0.10。
- eligible session 相对变化≤0.05。
- CA mean absolute delta≤8、P95≤15。
- final TA absolute delta≤10。
- assessment status change rate≤0.10。
- recovery saturation rate≤0.20，且禁止无效 CA。

移除 Recovery scoring 后，其旧列可能合法变 null，会被旧 gate 直接拒绝。
不能绕过 gate，也不能为了过关填伪 recovery 分数。

建议新增 `rai-model-transition-gate-v2`：

1. 按 source/target schema 决定适用断言。
2. V1→V2 明确豁免已删除维度的分布连续性，改查独立 Readiness 输出完整性与隔离不变量。
3. 保留 NaN/范围/样本身份/发布完整性硬失败。
4. CA/TA 跨标尺变化只作为预声明迁移指标，不要求无条件贴近旧值。
5. V2→V2 同标尺版本更新继续执行严格分布和回归门槛。
6. 不允许零 matched sessions 自动作为通过；应 not_evaluable 并按发布政策阻断。
7. 写入 thresholds/config/cohort/hash，任何例外都留审计。

### 14.6 Checkpoint 和 dirty window

V2 checkpoint 至少保存：

- baseline epoch 及维度统计/来源摘要。
- TA、已处理训练游标、eligible learning count。
- 负向确认缓冲 K 个证据的稳定 ID。
- adaptive window 必需历史或可重建摘要。
- normalization/config/version hashes。
- 数据与 override fingerprints、timezone。

Median/MAD 不是简单累计和；不能只存 count/sum 便声称可精确恢复 rolling median。
保存有界窗口或可检索的 immutable reference，限制状态体积。

dirtyFromAt 必须回退到受影响训练之前的安全 checkpoint；滚动基线、EWMA、TA 有后向依赖传播，不能只重算变更当天。
readiness 事实变更不再触发 Fitness 重算，但会传播到依赖它的 Coach/情景预测。

### 14.7 离线验证与发布，不恢复常驻双跑

尊重 `/Users/ta/running/deliverables/SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md` 的既有产品决策。
建议发布流程：

```text
固定事实快照 / 数据副本
  → 离线 V1/V2 replay
  → 不变量 + 版本 transition gate + 如适用的 accuracy gate
  → candidate 快照/工件完成
  → 校验输入 generation 未变化
  → 发布事务中原子切换一致 bundle
  → 清缓存 / 更新 ETag 或 bundle key
  → 运行时一致性监控
```

数据库事务只包含短发布步骤，不把全量计算或 Python 训练放在长事务中。
发布前 generation 改变则重新校验/重算，不把旧数据候选压过新导入。

“shadow/candidate run”若用于离线报告，必须注明非线上每次导入双跑，不复用已废弃的 `validationMode=shadow` 当开关。

### 14.8 迁移与回滚

- 不修改 v1–v22 历史 migration 正文。
- 下一版本可以是 v23，但若并行任务已占用要顺延。
- 先迁移兼容读取和新增表，再部署新 writer，最后发布 V2 bundle。
- `up` 需事务化和迁移测试；大规模回填在任务层分批，不塞入启动 migration。
- 旧 binary 是否可打开新 schema 要实测；不能承诺“只切 active 指针即可代码回滚”。
- 首选支持双版本 decoder 的新 binary 回退到旧 bundle；或恢复经过验证的整套旧构建+库备份。
- 迁移备份必须使用一致 SQLite snapshot/backup 流程，不能单独复制一个正在写入的 `.sqlite` 文件并忽略 WAL。
- 本文不提供直接生产执行 SQL，实际字段/索引须在实施 PR 中对照 schema 编写。

---

## 15. 统一离线回放、评估与反泄漏

### 15.1 新增的不是另一个预测 CLI

现有 prediction report、walk-forward、Ridge 评估、Python release gate 都应保留。
新增 `@rai/model-eval` 的价值是统一输入 envelope、比较输出与 gate 报告，并覆盖 Fitness/Readiness/Load/Coach。
领域评估包只做纯比较；数据库读取、快照导出和文件 I/O 留在 application / research runner。

### 15.2 回放输入

```ts
interface ReplayCaseV2 {
  caseId: string;
  asOf: string;
  timezoneIdentifier: string;
  replayMode: "event_time_reconstruction" | "as_known_then";
  factsSnapshotHash: string;
  canonicalFacts: CanonicalFactsBundle;
  effectiveOverrides: OverrideSnapshot;
  independentlyAvailableScenario: RaceScenario | null;
  labels: OutcomeLabel[];
}
interface ReplayResultV2 {
  caseId: string;
  fitness: FitnessSnapshot;
  readiness: ReadinessSnapshot;
  load: LoadAssessment;
  durability: DurabilitySnapshot[];
  predictions: RacePredictionV2[];
  coach: CoachDecisionV2 | null;
  inputHash: string;
  semanticOutputHash: string;
}
```

说明：“labels”提供给评估器，不直接放入生成该次预测的领域模型输入。
同一比赛不能既当当前预测的解释特征，又当未来待预测标签。

### 15.3 两种时间回放必须分开

**event-time reconstruction**：使用今天掌握的历史记录，按发生时点重建表现。
适合比较模型行为，但不证明系统在历史当天真的知道这些数据。

**as-known-then**：要求事实、标签、override、天气情景在当时已到达系统。
适合评估真正线上可实现的预测性能。

当前历史 override 和 labelAvailableAt 已有保护；但健康记录 source createdAt 不等于系统入库 availableAt，不能推断所有原始事实已完整实现双时间历史。
如果旧记录缺少可靠到达时间，应：

- 标记 `availabilityUnknown`。
- 纳入 event-time reconstruction，不冒充严格线上回放。
- 严格 as-known-then cohort 排除或使用可审计的快照/导入账本。

### 15.4 防泄漏清单

1. 本次训练的结束后心率/成绩不用于训练开始前预测。
2. 当前 race 的 VDOT 不参与预测同一个 race。
3. 标签 availableAt=max(完成时间, 有效标注时间)，并遵守当前代码的历史 override 规则。
4. 后来补录的 race 标签不能提前让过去普通训练变成 race 特征。
5. 事后天气/路线结果不能作为赛前独立情景；当前残差 schema 已明确这个限制。
6. 归一化参数、scalers、Ridge 均值/方差都只 fit 训练段。
7. calibration residual 只能来自当时未训练过的预测结果。
8. 测试距离、运动员和时间分组策略固定；同一真实比赛的多条派生样本不得跨 train/test。
9. 当前 active feature run 不等于当年可得特征；需要 schema/override/facts 的完整回放。
10. 负荷和阈值使用训练前 profile，避免同场比赛自我提高阈值降低自身 load。
11. 人工反复查看 holdout 后的参数选择属于调参；下一轮需要新留出集或嵌套验证。
12. 不能把预测模型自身生成的成绩当作新标签来训练、再声称 MAE 下降。

### 15.5 各域指标

| 领域 | 必报指标 | 不能作为有效证据的替代品 |
|---|---|---|
| Fitness | 恢复反事实隔离率、TA 更新分布、正负接受率、缺失分层、标尺变化 | 分数曲线更平滑就代表更准确 |
| Fitness 外部效度 | 可比标准测试变化与能力趋势一致性、协议分层误差 | 把个人 TA 0–100 与比赛秒数直接求 MAE |
| Readiness | freshness 泄漏率、可评估覆盖、状态持续、规则一致性 | 没有症状标签也声称疾病/疲劳诊断准确率 |
| Durability | 证据覆盖、目标距离分层增量收益、后段表现关联 | 仅看更长长跑使分数更高 |
| Load | composite parity、累计守恒、覆盖/fallback 分布、状态变更率 | ACWR 降低就是伤病风险下降 |
| Prediction | MAE/RMSE/MAPE/median AE/signed bias、分距离及分层 | 只报整体平均掩盖半马退化 |
| Intervals | P80/P90 coverage、置信区间、宽度、interval score | 区间无限宽得到 100% coverage |
| ML | baseline/Ridge/CatBoost 同样本差异、block bootstrap、parity | 训练集拟合误差或随机分割的漂亮数字 |
| Coach | 同输入重放一致、动作变更率、reason/action 一致、unknown 处理 | 只看文案是否流畅 |
| Engineering | 运行耗时、峰值内存、DB 增量、发布完整性、回滚结果 | 一次热缓存速度被当线上 SLA |

### 15.6 Cohort 分层

至少按以下维度报告（样本不足标不足，不合并掩盖）：

- 5K / 10K / 半马。
- race / standardized test / time trial。
- 初始校准 / 成熟历史 / 近期缺失。
- HR 完整 / 部分 / 缺失。
- 地形和天气已知 / 未知 / out-of-domain。
- 稳态 / 间歇 / 长跑 / 恢复跑。
- 设备稳定 / 设备切换。
- 仅短距离暴露 / 有相应长跑证据。

当前单一本地库不能支持“跨人群泛化”的结论。
未来若多用户训练，应加入 subject-level grouping，并在明确授权与隐私政策下使用数据。

### 15.7 标签采集比扩模型更紧迫

本次 268 条 active sessions 对应 0 个可评估标签，说明“训练数据多”不能替代目标任务标签。
建议优先完善现有 performanceProtocol 的用户确认流程，不自动把最快跑标记为比赛。

**当前并非没有标注入口。** `/Users/ta/running/apps/web/src/components/OverrideDrawer.tsx` 已有“标准测试 / 比赛”选择，API 的 `/Users/ta/running/apps/api/src/schemas.ts` 已接受 performanceProtocol。
应优先复用该入口排查“用户未标注、协议不符、数据质量不足或历史时点不可得”等流失原因，不另建平行标签系统。

标签应记录：

- sessionId、protocol、实际距离、计时口径。
- 是否全力/测试目的、路线/跑步机、暂停情况。
- 实际完成时间、用户确认时间、修改 revision。
- 质量/排除理由。
- 独立情景如果存在，记录可得时间而非赛后回填当赛前预测。

当前 `thirty_min_threshold` 被 race outcome loader 排除，这是合理协议区别；可作阈值证据，不凑 5K/10K 比赛标签数。

**将标签闭环列为 Phase 0 的 P0 交付，而不是 Phase 4 训练时才补：**

| 步骤 | 实施内容 | 验收证据 |
|---|---|---|
| 发现 | 在已有训练详情/复盘入口提示可补充协议，用户主动确认；不自动推断全力标签 | 可达入口与清晰适用说明 |
| 确认 | 复用 performanceProtocol、revision；增补确有需要的计时/完整性信息 | 读取与写入保持一致，用户可以撤销/更正 |
| 质检 | 逐项解释距离、用时、协议、覆盖、重复/排除情况 | 不合格原因可见，不静默吞掉已标注记录 |
| 入评估 | 使用现有 labelAvailableAt 与 as-of；更正/删除触发相应失效 | 迟到标签不进入此前预测；重复导入不重复计数 |
| 报告 | 更新按距离、时间分区、标签来源的数量和缺口 | 一条真实合格结果能追踪到评估或明确拒绝原因 |
| 激活 | 沿用既有 train/holdout/gate | 有标签也不自动激活模型 |

每次回放输出标签漏斗：

```text
训练记录 → 用户确认的测试/比赛 → 去重后的有效结果 → 任务/协议适用标签
       → 有合格赛前输入的可评估样本 → 各 train/calibration/test 分区 → 达到发布门槛
```

漏斗每一步报告输入数、输出数、主要拒绝原因；允许附多原因诊断，但用于加总的主拒绝原因必须互斥。
已有“268 sessions / 0 labels”应继续如实展示，不靠将所有训练转为标签来消灭零值。

**标签闭环完成与标签规模达标分开验收：**

- 软件闭环可用 synthetic fixture 验证保存/读取/可得时间/撤销，但这些 fixture 不进入真实训练 cohort，也不计发布数量。
- 有可用真实历史结果时，经用户确认后验证一条端到端流转；没有时明确记录 `real_label_smoke=not_evaluable`，不为演示伪造真实比赛。
- 发布进度同时展示总数、各距离数量、时间分区可用数及离各现有门槛的差距；不能承诺“再标 50 条就一定达标”。
- 数据不足不阻止恢复隔离等工程修复，但数值精度调参/ML 激活必须继续 `not_evaluable`；扩模型优先级低于标签漏斗、可得性与质检。
- 比赛成绩标签可验证 race prediction/部分能力趋势，**不能自动验证 Readiness state**；恢复状态验证还需另行定义训练感受/实际表现等目标及其独立采集协议。
- 不为凑标签诱导用户增加训练负荷、频繁进行极限测试，优先利用既有且可确认的真实比赛/标准测试结果。

### 15.8 统一报告

每个版本比较产物至少包括：

1. repo SHA、版本矩阵、配置 hashes。
2. cohort 定义/时间边界/样本流失瀑布。
3. V1 与候选各输出指标。
4. 相同 case 的差异分布、异常案例与 reason codes。
5. 统计不可用项及原因。
6. 每个 gate 的 passed/failed/not_evaluable 状态。
7. 发布建议：工程可发布 / 精度尚未证实 / 应保留旧 policy。
8. 输入和语义输出 hash，复现命令。

“未评估”是正式状态，不是自动通过或失败。
不同门槛决定其动作：精度增强模块 not_evaluable 不激活；纯边界修复可按安全/行为门槛独立发布。

---

## 16. 验收矩阵和测试设计

### 16.1 必需 Golden / Metamorphic Tests

| ID | 场景 | 必需断言 | 层 |
|---|---|---|---|
| F01 | 同一训练仅替换睡眠/HRV/当天 RHR | CA、TA、更新标记、基线输入不变 | 全链路 Fitness |
| F02 | 把 Readiness 由 no_low_signal 改 strained | Coach 可降阶，Fitness 不变 | 跨域 |
| F03 | 同一可用维度分数，降低 coverage | 展示值向 50 收缩，置信度不提高 | scoring |
| F04 | 删掉与其他维度相反的证据 | 不强加错误的“必向 50”断言；区间/置信度反映缺失 | scoring |
| F05 | TA=70、观测=70、coverage=.65 | 不因展示收缩到63而负更新 | scoring |
| F06 | N=10/11、30/31 | 连续 α，无分段政策跳变 | scoring |
| F07 | 正常平路环境 status=not_needed | 高质量负残差不被强制冻结 | scoring |
| F08 | 快速下坡/速度尖峰 | 不产生未经质量门控的正向 TA 跳升 | features/scoring |
| F09 | 同一天导入两次同一训练 | N、TA、负荷贡献不重复 | application |
| F10 | 持续真实高质量变差 | TA 可以下降，不成为只升不降 | scoring |
| B01 | 本次训练参与 adaptive window | 只进入未来窗口，不参与本次自评分 | baseline |
| B02 | epoch 切换 | 不混用旧 TA、新 CA，完整重放或明确重校准 | application |
| R01 | 全恢复证据缺失 | not_assessed、score=null，不自动 red | readiness/coach |
| R02 | 今天 HRV + 旧睡眠 | 单信号 freshness，旧睡眠不计今天完整覆盖 | readiness |
| R03 | 测量有值但 baseline 缺失 | 不计作可比较证据 | readiness |
| R04 | 三个不相邻坏夜 | 不自动成为连续三夜 | readiness |
| R05 | 跨夜/午睡/时区转换 | 主夜归属正确，未来时间排除 | assembler |
| D01 | 两周数据但窗口默认八周 | unknown coverage 不等于低准备度 | durability |
| D02 | 只有短跑但半马目标 | insufficient，不给精确耐力差诊断 | durability |
| D03 | 地形不同导致后段变慢 | 降低可比性，不直接给耐力下降结论 | durability |
| L01 | 只增加 Load Vector | 原 compositeLoad 与日指标 golden 一致 | load |
| L02 | mechanical 输入不可用 | mechanicalLoad=null，不为0 | load |
| L03 | ACWR 单独升高 | 不自动覆盖所有恢复/计划信息 | load/coach |
| L04 | unknown prehistory | 不补零假装长期低负荷 | load |
| Z01 | 手工设置生效/失效 | 生效日期与来源可追溯 | zones |
| Z02 | 阈值 prior 不可用但有效测试存在 | 新路径可独立估计或明确拒绝理由 | physiology |
| Z03 | interval HR 滞后 | 不按稳态硬判持续冲突 | zones |
| P01 | Daniels 既有 golden | 无政策变更时结果不变 | physiology |
| P02 | 相同历史环境进入两层 | ledger 阻止重复去偏差 | prediction |
| P03 | 未来比赛但今天恢复差 | neutral/current-prepared 不受当天恢复永久罚分 | prediction |
| P04 | Preparation + Durability 同源信息 | 不重复套两次旧 readiness penalty | prediction |
| P05 | 仅一个 point correction policy | 不叠 bias/Ridge/CatBoost | prediction |
| M01 | schema hash/特征顺序错 | 拒绝模型，回退可解释 baseline | inference |
| M02 | ONNX 差≥1e−6 | 拒绝激活 | ML |
| M03 | 标签不足 | 所有精度指标 null，拒绝 ML 激活 | evaluation |
| M04 | Calibration 与 holdout 相同事件 | 数据切分验证失败 | evaluation |
| I01 | P80/P90 | 嵌套有序、样本/宽度/覆盖同时报告 | calibration |
| T01 | 迟到标签/override | 不进入此前 as-known-then 预测 | replay |
| T02 | 删除训练后重放 | 所有下游去除该事实影响 | replay |
| C01 | renderer 改语言 | action/tone/codes 不变 | coach |
| S01 | candidate 任一步失败 | active bundle 不变，旧结果可读 | storage/API |
| S02 | V2 null recovery_score | 使用新 transition gate，不填伪值绕旧 gate | storage |
| S03 | 旧 checkpoint + 新 config/schema | 拒绝复用并安全回放 | application |
| S04 | prune 历史 run | 活跃及回滚 bundle 依赖不被删 | storage |
| R06 | 旧恢复阈值命中任意 state | stateEvidence 保持 heuristic/not_empirically_validated；所有消费端保留 | contracts/API/UI |
| F11 | 权重 A/B 与三种删维度候选 | 相关性/行为消融报告齐全，无标签不得宣称最优 | evaluation |
| F12 | 任一分桶少于最低样本或跨度 | 双向学习不可用，不跨桶混合、不用重复窗口凑 N | features/scoring |
| F13 | 连续高质量退步且缺天气 | 报分层接受率/延迟；不因 unavailable 一律冻结 | evaluation/scoring |
| F14 | modelConfidence=null，但规则因子有效 | E 有值、overall=null；TA 只按明确的 E 门控 | confidence |
| F15 | 必需规则因子 null / 0 / NaN | 分别缺证据、真实零、校验失败；没有 null 默认填补 | confidence |
| B03 | rebase 定期检查/冷却/饱和 | 检查不等于自动切换；理由、样本、epoch 全部可追溯 | baseline/application |
| B04 | 新标尺重估历史 | 标注回顾性视图；旧事实曲线保留，不回灌 as-known-then | replay/UI |
| I02 | 无 calibration/域匹配/足够独立评估 | 不展示为 P80/P90 保证；只保留明确 heuristicRange | API/UI |
| T03 | 已标注结果不合格、重复、更正或撤销 | 漏斗计数可对账、理由可见、失效传播正确 | application/evaluation |

### 16.2 特别补充：隐性 RHR 通道

当前 features 会用 `source.restingHeartRate` 计算 HRR，再推断 sessionType；课型又改变 scoring 的 evidenceStrength/comparability。
所以仅把 recovery 权重设 0，并不能证明 RHR 对 Fitness 完全隔离。

V2 需将课型推断使用的 **长期静息心率参考/训练前分区** 与 **当天恢复 RHR** 分成不同字段。
F01 必须从原始事实装配入口运行，不能只构造相同 feature 调用 scoring 后声称全链路隔离通过。
长期参考重新校准可以改变未来课型解释，但必须是独立版本/epoch 行为，而非当天恢复信号实时回写。

### 16.3 确定性测试要排除当前时间默认值

当前 `extractWorkoutFeatureVector` 默认 `computedAt = new Date().toISOString()`，因此严格说并非“所有入参相同、全 JSON 永远一致”。
V2 纯领域入口必须显式传时钟值，或把运维时间放在领域输出外。

测试对比两类对象：

- 语义结果：同输入同配置，稳定排序后结果 hash 相同。
- 运维 metadata：时间/任务 ID 允许不同，不参与算法 parity。

不能为了让测试通过把真实数值误差一起从 hash 排除。

### 16.4 测试执行层级

仅本文档变更：源码证据核对 + 有针对性的已有算法测试 + 只读评估足够，不需要跑 Web build 或 iOS Simulator。

未来真正实现：

```bash
cd /Users/ta/running
npm run typecheck
npm test
npm run build
# 改到桌面交互/API 流程时再执行
npm run test:e2e:web
# 修改 apps/ios 时，单独获得范围授权并执行
npm run test:ios
# 修改 Python/ONNX 训练合同与发布时执行
npm run ml:test
```

不默认运行 responsive/full E2E，不修改 <1024px 冻结代码。
当前 `test:e2e:web` 与 responsive 的脚本名称虽不同但指向同一入口文件；后续运行前应按仓库规则确认测试内的筛选，不能误把全量窄屏验证带入范围。

---

## 17. 分阶段实施、提交边界与回滚

### 17.1 Phase 0：固定证据、标签闭环与评估底座（必须先做）

任务：

1. 固定当前代码/配置/数据 snapshot 与 baseline reports。
2. 补充 transition gate 设计及 V1→V2 兼容 decoder。
3. 统一 semantic output hash、as-of envelope、标签可得性。
4. 建立 F01/F05/S01/S02 等失败先行测试。
5. 标明 current local DB 是旧 active run，区分源码与运行结果。
6. 复用已有 performanceProtocol 入口，按 §15.7 完成标注—质检—时点—评估—撤销闭环及标签漏斗；不等待 ML 开发。
7. 固定启发式状态/区间文案合同、confidence null 传播和 rebase 候选政策，加入相关验收用例。

完成条件：能够对同一 cohort 运行旧/新候选，不修改线上指针；所有 unknown/not_evaluable 可表达；标签闭环的工程测试通过，真实标签核验有结果或明确不足状态。
不以“已有标注 UI”替代端到端漏斗验收，也不把要求用户立即提供足够真实比赛样本作为所有工程修复的阻塞条件。

停止条件：没有可重现旧输出，或输入 facts 在回放期间漂移；先修复评估条件，不开始公式调参。

### 17.2 Phase 1：恢复隔离与 V4 边界

任务：

1. 新增 readiness 纯规则包，复现现有 Coach 阈值。
2. 合并四路恢复口径，保留旧 V3 replay。
3. V4 features 不含生产 recovery/cardio scoring 维度；拆分长期 RHR 与当天恢复 RHR。
4. CA 先采用 V2-A 最小变化控制组，提交 §6.1 必需的相关性/行为消融报告；无标签时不宣称优于 B，明确 missing/coverage 契约。
5. V2 checkpoint/schema/engine-config 谱系和最小 Readiness migration。
6. Coach compatibility wrapper + 新旧 API 映射。

完成条件：全链路 F01 成立；旧记录可读；今天恢复变化只改变 Readiness/Coach/适用预测情景。

不要求此阶段证明预测 MAE 改善；不得以无标签阻止边界正确性修复。

### 17.3 Phase 2：Fitness 可比性与长期学习

任务：

1. identity/现有环境 adapter，分清 applied/not_needed/unavailable。
2. 少量课型可比层级及参考系。
3. 长期 anchor + adaptive baseline，禁止自评分泄漏。
4. 展示收缩与 learningObservation 分离。
5. 连续 α、负向证据确认、正向异常门控。
6. 停跑与数据缺口分开。

完成条件：覆盖缺失不误学退步、良好环境无需修正也可下调、按 §6.9 提交各课型/环境覆盖的机会数与双向接受率、退步响应及误判报告；真实案例不足时实证效果明确 not_evaluable。
稀疏分桶不得自动混合，rebase 必须包含检查政策、历史视图和用户解释；仅通过合成退步测试不能宣称真实退步检测已验证。
基线重置和权重 B 是独立实验，不与所有改动合并验证。

### 17.4 Phase 3：专项证据、负荷、分区

任务：

1. 迁移现有 race readiness 到 Preparation，保持数值兼容。
2. Durability 证据输出，未校准时不开数值 penalty。
3. 基于现有 breakdown 扩展 Load Vector。
4. ACWR 降权同时覆盖 training-load 和 Coach。
5. 细化 threshold/maxHR source，补 prior 不可用时强测试路径。
6. HR/Pace coherence 复用现有 zone 分析。

完成条件：Preparation 不重复扣罚、Load 口径连续、zone 证据时点正确、无新依赖环。

### 17.5 Phase 4：预测 policy、残差竞争与区间

任务：

1. 明确 neutral/current-prepared/race-day 模式和 correction ledger。
2. 更新 residual schema/hash，旧模型自动不兼容回退。
3. 复用 Ridge，加入与 CatBoost 的同样本发布比较。
4. 三段切分、区间校准 artifact 与留出验收。
5. 充分标签时训练/评估；不足时保留 baseline 和未校准提示。

完成条件：所有 ML/区间 gate 通过才启用增强模块；否则工程框架可以合并但增强仍关闭。
**当前本地零标签状态下，不能承诺 Phase 4 的精度增强可立即激活。**

### 17.6 Phase 5：发布与运行验收

任务：

1. 在一致数据快照上生成候选完整 bundle。
2. transition + hard invariant gates 检查。
3. 使用现有 mutation/publication 协调机制发布。
4. 检查 Web/API 结果一致，不擅自改 iOS 代码。
5. 实测回退到保留 bundle，记录重启/缓存/工件选择。
6. 观察有限值、空值异常、unknown/fallback 比例、耗时/空间。

不新增常驻 V1/V2 影子系统。

### 17.7 推荐 PR 边界

| PR | 主题 | 前置 | 独立回滚边界 |
|---|---|---|---|
| 01 | baseline reports、replay envelope、transition gate tests | 无 | 仅评估/测试 |
| 01a | 现有标签入口闭环、漏斗、质检/撤销、时点验证 | 01 | additive 记录/说明，保留既有 override |
| 02 | readiness 纯模型和 Coach compatibility adapter | 01 | 仍用旧裁决输出 |
| 03 | V4 contracts、decoder、最小 migration、版本谱系 | 01 | additive schema 与旧读取 |
| 04 | Fitness 恢复隔离、V2-A、RHR 通道修复 | 02/03 | 回退旧 bundle |
| 05 | coverage/learning 分离、连续 TA、双基线 | 04 | 单独 scoring config/policy |
| 06 | normalization adapter 与条件账本 | 03 | identity/旧 adapter |
| 07 | preparation 迁移、durability evidence | 03/06 | 不含新数值 penalty |
| 08 | vector/ACWR/zone provenance | 02/03 | 旧 load/zone policy |
| 09 | prediction modes、residual schema、Ridge 比较 | 06/07 | formula baseline |
| 10 | 区间校准、产品状态与 ML release gate | 01a/09 + 足够标签 | 禁用 ML/区间 artifact |
| 11 | bundle 发布/清理/回滚与最终验收 | 04–09 | 上一完整 release bundle |

其中依赖约束是重要部分；可以并行开发独立包，但不能先合并强制新 writer 再补 decoder/migration。
本次没有授权自动启动子代理或执行这些 PR，仅形成设计。

### 17.8 可独立上线的最小版本

如果希望缩短第一轮范围，建议仅交付：

- 统一 Readiness 规则 + 全天 freshness。
- Fitness 删除 recovery、修复间接 RHR 耦合。
- V2-A 权重、coverage/learning 分离、版本化新 gate。
- 确定性/反事实回放、旧时间线兼容、原子发布与回滚。
- 现有标签入口的端到端验证与数量/拒绝原因漏斗；不要求此时已积累足够 ML 标签。

Durability 数值罚分、全套环境拟合、CatBoost V4 和 P80/P90 不列为第一轮必须上线条件。

---

## 18. 风险、取舍与最终验收

### 18.1 风险登记表

| 风险 | 影响 | 处置 / 发布阻断 |
|---|---|---|
| 标签不足 | 无法证明预测改进 | P0 标签闭环先行；正式 not_evaluable，不激活 ML/经验区间 |
| heuristic state 被当作医学阈值 | 错误健康/精度宣传 | 状态级 validation metadata 与 API/UI 文案测试 |
| modelConfidence null 被当成 1 或 0 | 伪置信度或所有 TA 更新冻结 | E/overall 分离；null/0/非法值完整矩阵 |
| 分桶稀疏后偷偷混合 | 训练意图不可比 | 明确配置上限、最低 N/跨度、禁止跨桶 fallback |
| 经验 P80/P90 被当个人概率保证 | 误导预测可靠性 | nominal target/实测 coverage/适用域并列，不足则不展示 P 标签 |
| 恢复移出 CA 但经课型间接进入 | 假解耦 | 全链路 F01，不只单测评分函数 |
| 缺失收缩用于 TA 残差 | 缺数据被学成退步 | learningObservation 分离与证据门控 |
| 长期基线滚动导致标尺漂移 | 进步消失、TA 假跌 | anchor epoch，明确 rebase |
| 只允许高分更新 | TA 只升不降 | 正负门控对称审计，真实退步案例 |
| 环境/准备度/疲劳重复扣罚 | 预测系统性偏慢 | correction ledger、消融与唯一 owner |
| 机械负荷未校准 | 伪精确风险 | 先展示暴露、mechanical=null |
| 当前 gate 误拒 V2 | 无法发布或被迫绕过 | schema-aware transition gate |
| engine/config 共用版本字段 | 实现变更错误复用 | 拆分谱系与 checkpoint key |
| 同一 holdout 反复使用 | 过拟合发布标准 | 预注册、独立校准/测试、审计调参次数 |
| 原始事实可得时间不完整 | 历史泄漏 | 区分两类回放，严格 cohort 限制 |
| 旧 binary 不兼容新 schema | 回滚失败 | 双 decoder 或验证过的整套回滚 |
| 已清理旧 run/artifact | 只有回滚按钮没有内容 | pin 活跃与回滚依赖 |
| 环境/设备变化误判能力 | 用户不信任 | comparability、provenance、同类证据 |
| 运行开销扩大 | 导入/页面变慢 | 单次计算、多处复用；不恢复常驻双跑 |

### 18.2 必须保留

- 不可变版本化派生 run 和可追溯输入。
- Median/MAD 稳健基线与初始校准保护。
- Daniels、Performance VDOT 与直接 VO2max 的区分。
- 已有 Ridge、CatBoost residual-only、±12% cap、ONNX 校验。
- 复合负荷、TRIMP fallback 和分区证据政策。
- 既有模型版本发布 gate 的保护目的。
- Coach 判定与解释 SSoT。
- 数据 tombstone、override revision、增量一致性和只读回放。

### 18.3 必须迁移或修正

- Recovery 的 CA 权重与 directionFactor 依赖。
- 当天 RHR 借课型推断间接改变 Fitness 的通道。
- `readiness` 同时指恢复与专项准备度的命名。
- engine/config 版本字段混用。
- 缺证据向 50 收缩后直接用于 TA 负残差的设计。
- 仅靠 `environmentAdjusted=true` 才允许下调的设计。
- 旧 gate 对 recovery null rate 的跨 schema 不适用规则。
- 把 optimistic/pessimistic 当成统计 P80/P90 的展示意图。

### 18.4 明确不做

- 不增加全马、Watch/macOS/新 native 产品。
- 不在 iOS 复制 TypeScript 核心算法。
- 不扩大窄屏响应式范围。
- 不恢复每次导入常驻双跑。
- 不重新发明 Ridge、训练负荷 registry 或已有阈值证据模型。
- 不在零标签时宣称“已提高预测准确率”。
- 不自动访问外部天气/健康服务或训练多用户模型。
- 不在本次文档任务中修改生产算法、激活模型或迁移数据库。

### 18.5 最终验收条件

工程发布必须满足：

1. Fitness 恢复隔离全链路成立，缺失不被错误学习。
2. 历史/可得时间、baseline epoch、模型/config/schema 一致。
3. 新旧合同兼容、无 checkpoint 跨版本复用。
4. Load/Zone 的既有数值主线在未改政策时一致。
5. Prediction 无重复 correction，未知状态如实表达。
6. Coach 不重算底层规则，理由与动作一致。
7. 发布原子性、generation 校验、失败回退、旧工件保留经过测试。
8. 性能报告真实测量，不引用跨条件拼接的“提速”。

同时要求 R1 新增合同闭合：Readiness state 级 heuristic 标记、confidence null 传播、分桶配置与双向接受率报告、rebase 用户解释，以及标签漏斗和区间产品文案均完成各自测试。
这些要求未实现时，不能只凭旧单元测试通过宣称 R1 验收完成。

精度增强另需满足：

9. 充分且无泄漏的已标记结果；目标距离逐项达标。
10. CatBoost 同时优于适用基线和 Ridge，并满足既有强门槛。
11. 区间独立校准、独立测试、coverage/width/样本同时合格。
12. 样本不足时保持未激活，报告完整原因。

**最终目标不是增加更多分数，而是每个分数只有一个清楚的含义，每个变化都有可追溯的证据，每个版本都有可复现的发布与回滚依据。**

---

## 附录 A：文件级改造清单

下表是后续实施清单，未勾选项均未在本次实现。

| 代码位置 | 建议变更 | 不应做的事 |
|---|---|---|
| `/Users/ta/running/packages/contracts/src/index.ts` | V4 feature、Readiness、Durability、lineage、预测 v2；保留旧 decoder | 覆盖旧枚举/字段含义 |
| `/Users/ta/running/packages/features/src/index.ts` | 去恢复 score vector、时序输入、可比性、显式 computedAt、RHR 拆字段 | 把旧 JSON 改版本冒充 V4 |
| `/Users/ta/running/packages/features/src/speed-windows.ts` | 复用窗口汇总支持配对片段 | 另写一套不同暂停口径 |
| `/Users/ta/running/packages/scoring/src/model.ts` | V2-A/B、coverage/learningObservation、baseline epoch | 自动把个人指数当 VDOT |
| `/Users/ta/running/packages/scoring/src/index.ts` | 连续 α、无 recovery directionFactor、证据门控 | 不校准就放大负学习 |
| `/Users/ta/running/packages/readiness`（新增） | 单一恢复规则、freshness、reason codes | 引入 DB/I/O 依赖 |
| `/Users/ta/running/packages/durability`（新增） | 迁移 preparation、证据分层、可选耐久估计 | 与旧 preparation 重复罚分 |
| `/Users/ta/running/packages/physiology/src/index.ts` | adapter、预测情景、correction ledger、独立 threshold evidence 路径 | 改 Daniels 数值求解器 |
| `/Users/ta/running/packages/physiology/src/ridge.ts` | 复用 challenger、特征版本升级 | 新建重复线性模型 |
| `/Users/ta/running/packages/training-load/src/index.ts` | 同源 Readiness 映射、ACWR 语义、LoadAssessment | 擅改 EWMA 半衰期 |
| `/Users/ta/running/packages/training-zones/src/index.ts` | source 细化、coherence、向量扩展 | 重写 composite 主口径 |
| `/Users/ta/running/packages/prediction-inference/src/index.ts` | V4 artifact/schema 校验和已选 policy | 容忍 hash 不一致继续推理 |
| `/Users/ta/running/packages/application/src/prediction-data.ts` | 独立 readiness/preparation assembler、as-of | SQL 中重复恢复公式 |
| `/Users/ta/running/packages/application/src/prediction-report.ts` | 明确模式、三方比较、分层报告 | 混用校准和评估标签 |
| `/Users/ta/running/packages/application/src/prediction-training-data.ts` | 新特征语义/到达时间/切分 | race 结果 metadata 进入赛前特征 |
| `/Users/ta/running/packages/application/src/prediction-ability-baseline.ts` | fingerprint 包含全部上游语义版本 | 只改 UI version 不改 fingerprint |
| `/Users/ta/running/packages/application/src/prediction-model-service.ts` | 复用 registry、完善 challenger gate | 把 active 加成未经迁移的 status |
| `/Users/ta/running/packages/application/src/services/recompute-pipeline.ts` | 新状态版本、领域 dirty window、bundle 发布 | 恢复旧常驻 shadow |
| `/Users/ta/running/packages/storage-sqlite/src/database.ts` | 新增 migration、约束/索引、pruning 依赖 | 修改 v1–v22 migration |
| `/Users/ta/running/packages/storage-sqlite/src/model-run-repository.ts` | schema-aware transition gate | 删除保护或填伪 recovery |
| `/Users/ta/running/apps/api/src/mobile-coach.ts` | compatibility wrapper + snapshot-only verdict | 再从原始 ratio 独立分支 |
| `/Users/ta/running/apps/api/src/schemas.ts` | API v2/兼容序列化验证 | 假设所有客户端忽略未知枚举 |
| `/Users/ta/running/research/rai_ml/contract.py` | 与 TS schema/hash 同步 | 新列旧模型 |
| `/Users/ta/running/research/rai_ml/pipeline.py` | 同样本 challenger、三段切分和区间 gate | 放宽已有发布阈值 |
| `/Users/ta/running/packages/model-eval`（新增） | 统一比较器、跨域 invariants/report | 再新建一套预测公式 |

新增包还需更新 workspace/package dependencies、TypeScript 路径和 pure build 范围；只创建目录不算完成集成。

## 附录 B：源码证据索引

以下为本次核对的主要证据；优先用函数名检索，行号是本次快照定位。

| 编号 | 位置 / 符号 | 支撑结论 |
|---|---|---|
| E01 | `/Users/ta/running/packages/scoring/src/model.ts:27` `defaultRaiModelConfig` | CA 权重、校准、最低覆盖/置信度 |
| E02 | `/Users/ta/running/packages/scoring/src/model.ts:167` `createPersonalBaseline` | Median/MAD baseline |
| E03 | `/Users/ta/running/packages/scoring/src/model.ts:387` `updateTrueAbilityFromFeatureScore` | recovery directionFactor |
| E04 | `/Users/ta/running/packages/scoring/src/index.ts:81` `baseLearningRate` | 分段学习率 |
| E05 | `/Users/ta/running/packages/scoring/src/index.ts:107` `inactivityDecay` | 旧停跑衰减 |
| E06 | `/Users/ta/running/packages/features/src/index.ts:36` `defaultFeatureConfig` | 准入/课型配置 |
| E07 | `/Users/ta/running/packages/features/src/index.ts:410` `calculateRecoveryParts` | feature 恢复独立实现 |
| E08 | `/Users/ta/running/packages/features/src/index.ts:460` `extractWorkoutFeatureVector` | HRR/课型依赖与 computedAt 默认值 |
| E09 | `/Users/ta/running/apps/api/src/mobile-coach.ts:186` 恢复常量 | .75/.85/1.03、streak=3 |
| E10 | `/Users/ta/running/apps/api/src/mobile-coach.ts:217` `assessRecovery` | 今日覆盖与恢复 SSoT |
| E11 | `/Users/ta/running/apps/api/src/mobile-coach.ts:267` `decideVerdict` | ACWR 独立 highLoad 路径 |
| E12 | `/Users/ta/running/packages/training-load/src/index.ts:25` `classifyPhysState` | 另一恢复分类 |
| E13 | `/Users/ta/running/packages/training-load/src/index.ts:264` `buildDailyTrainingMetrics` | 7/28 half-life、ramp/strain |
| E14 | `/Users/ta/running/packages/training-zones/src/index.ts:178` `buildDailyZoneProfile` | 来源、观测/手工、平滑 |
| E15 | `/Users/ta/running/packages/training-zones/src/index.ts:637` `calculateCompositeTrainingLoad` | composite 不是单 TRIMP |
| E16 | `/Users/ta/running/packages/physiology/src/index.ts:309` `performanceVdotEvidence` | 已有环境归一化 |
| E17 | `/Users/ta/running/packages/physiology/src/index.ts:684` `estimateLactateThresholdFromEvidence` | 多证据阈值及 prior 前置 |
| E18 | `/Users/ta/running/packages/physiology/src/index.ts:819` `predictRaceTimes` | 准备度/环境/恢复链 |
| E19 | `/Users/ta/running/packages/physiology/src/index.ts:1093` `calibrateRacePrediction` | 已有偏差/经验区间 |
| E20 | `/Users/ta/running/packages/physiology/src/ridge.ts` `fitRaceResidualRidge` | 已有简单 challenger |
| E21 | `/Users/ta/running/packages/application/src/prediction-data.ts:467` `loadRaceReadinessEvidence` | 56 日专项准备度 |
| E22 | `/Users/ta/running/packages/application/src/prediction-data.ts:551` `loadRecoveryReadinessEvidence` | 独立预测恢复计算 |
| E23 | `/Users/ta/running/packages/application/src/prediction-report.ts` `historicalEvaluation` | Ridge/偏差历史回放 |
| E24 | `/Users/ta/running/packages/application/src/prediction-model-service.ts:36` 发布常量 | 已有严格 ML gate |
| E25 | `/Users/ta/running/packages/contracts/src/index.ts:938` residual schema | 版本/23+3列/hash |
| E26 | `/Users/ta/running/packages/prediction-inference/src/index.ts` `assertCatBoostArtifactManifest` | 版本、顺序、工件校验 |
| E27 | `/Users/ta/running/research/rai_ml/pipeline.py` `TrainingConfig` | Python 门槛及 release/embargo |
| E28 | `/Users/ta/running/packages/storage-sqlite/src/database.ts:1397` v22 | 当前 migration 上限 |
| E29 | `/Users/ta/running/packages/storage-sqlite/src/model-run-repository.ts:139` `evaluateValidationGate` | 旧 recovery gate 不适用 V2 |
| E30 | `/Users/ta/running/packages/application/src/services/recompute-pipeline.ts:211` | 已删除 shadow full replay、仍保留版本 gate |
| E31 | `/Users/ta/running/packages/application/src/services/recompute-pipeline.ts:1710` | 初始校准 baseline 创建 |
| E32 | `/Users/ta/running/packages/application/src/prediction-ability-baseline.ts` `currentAbilityBaselineHash` | 当前 baseline 指纹 |
| E33 | `/Users/ta/running/packages/application/src/prediction-historical-features.ts` `historicalOverrideJoin` | 按当时 override 查历史 |
| E34 | `/Users/ta/running/packages/storage-sqlite/src/read/prediction-recovery-read-repository.ts` | 近期恢复窗口与 provenance |

## 附录 C：本次核验记录与复查命令

### C.1 初稿核验实际执行

- 读取用户完整 959 行方案。
- 审阅上述源码、现有回放/发布 gate、仓库范围及去除影子系统决策。
- SQLite 使用 `mode=ro` 与 `PRAGMA query_only=ON` 查询聚合元数据；未读出或发布个人逐条生理数据。
- 执行已有只读 walk-forward CLI，固定 as-of 为 `2026-09-28T00:00:00.000Z`（北京时间 08:00）。
- 执行 9 个相关测试文件，共 **141 tests / 141 passed / 0 failed / 0 skipped**。
- 本次不代表全仓测试通过：未跑完整 `npm test`、build、浏览器、Python 或 iOS gates。

### C.2 初稿真实回放结果

```text
status: insufficient_labeled_outcomes
reportVersion: rai-prediction-walk-forward-v2
labeledOutcomeCount: 0
evaluatedOutcomeCount: 0
calibrationAppliedCount: 0
machineLearningCandidate.status: insufficient_walk_forward_samples
5K / 10K / 半马各距离 sampleCount: 0
MAE / RMSE / MAPE / bias / intervalCoverage: null
```

这是“没有足够可评估标签”，不是准确率 0，也不是模型完全不能给出规则预测。
本次只能确认评估的缺口和已有工程回归通过，不能得出 V2 比 V1 更准确的结论。

### C.3 可复查命令

```bash
cd /Users/ta/running
node --import tsx packages/application/src/prediction-walk-forward-cli.ts \
  --database /Users/ta/running/var/rai.sqlite \
  --as-of 2026-09-28T00:00:00.000Z

node --import tsx --test \
  packages/scoring/test/scoring.test.ts \
  packages/features/test/features.test.ts \
  packages/physiology/test/physiology.test.ts \
  packages/training-load/test/training-load.test.ts \
  packages/training-zones/test/training-zones.test.ts \
  packages/prediction-inference/test/prediction-inference.test.ts \
  packages/application/test/prediction-feature-schema.test.ts \
  packages/application/test/prediction-walk-forward-cli.test.ts \
  apps/api/test/mobile-coach.test.ts
```

机器可读核验摘要保存为：
`/Users/ta/running/deliverables/RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.verification.json`。
它记录源码 SHA、聚合查询、固定时间回放输出、测试命令和通过数，不包含本次未执行的 V2 模型精度指标。

### C.4 R1 文档修订核验

本轮仅修改此方案及其 verification JSON，核对现有 Web 标注入口与 API 字段，补充用户第 2–9 项意见对应的合同、政策和待实施验收。
检查主章节、代码围栏、源码定位、测试用例 ID、八项评审覆盖以及文档摘要 hash。
§C.1 的 141 项测试和 §C.2 的零标签回放是**初稿的实际执行记录**；本轮未重新运行算法测试、查询数据库或训练模型，不将旧结果描述成新增设计已通过验证。
新增 rebase/分桶/门控候选参数仍为启发式草案，尚无本次实证结果支持。

## 附录 D：参数台账和典型案例

### D.1 参数台账

| 参数 | 来源/状态 | 初版处置 | 后续校准依据 |
|---|---|---|---|
| 6 次 / 14 天校准 | 当前实现 | 保留 | 稀疏历史稳定性 |
| 最低有效权重 .65 | 当前实现 | 保留但检查新权重影响 | coverage 分层 |
| zScale=10 | 当前实现 | 保留 | 分布/饱和率 |
| 权重 V2-A | 去除恢复后的代数重归一，非最优值证明 | 最小变化控制组 | 强制相关性/删维度消融；无标签不排名精度 |
| 权重 .45/.35/.20 | 用户方案候选 | 不先验宣称最优 | A/B 回放 |
| α=.04+(.15−.04)exp(−N/25) | 用户方案候选 | 参数化 | 更新幅度/长期趋势 |
| 负向 E .75 / comparability .90 | 用户方案候选；E=evidenceReliability，非 overall | 配置并测试可达性 | 分层机会数/正负接受率、真实退步与误判 |
| 连续负证据 K=2–3 | 本方案候选 | 配置选择，不视为事实 | 误报/反应速度 |
| adaptive 28/42 日 | 用户方案候选 | 与长期 anchor 分开 | 分层稳定性 |
| long-term 90–180 日 | 本方案后续候选 | 首版不启用 rolling rebase | 标尺漂移回放 |
| 分桶上限 5、最低 6 次/14 天 | 本轮启发式配置草案 | 同桶独立训练，不跨桶回退 | 可比较率、扩窗率、稀疏组拒绝 |
| rebase 检查28天/冷却90天 | 本轮运维候选，非已验证周期 | 只检查，默认不自动重建 | 长期饱和率、切换成本与跳变说明 |
| 饱和触发20%/12次/连续2次检查 | 本轮候选，尚未实证校准 | 进入候选评估，不直接发布 | 各维度/epoch 的分布与适用性 |
| E 权重 .60/.25/.15 | 规则因子组织候选，非正确概率 | 原因去重、显式 null/0 | 与旧 confidence 差异报告 |
| 睡眠 .75 / HRV .85 / RHR 1.03 | 当前 Coach；heuristic_compatibility | 原样迁移并保留 state 级未验证标记 | 目标任务独立标签与政策验证 |
| 睡眠 streak 单夜 .80 | 当前 helper | 明确连续日期语义 | 连续/非连续用例 |
| preparation 56 日、距离目标 | 当前实现 | 迁移不重新拟合 | 分距离标签 |
| TRIMP exponent 1.92 | 当前主路径 | 保留 | 独立生理/数据校准 |
| EWMA half-life 7/28 | 当前实现 | 保留 | 不能和 time constant 混用 |
| 点残差 cap ±12% | 当前实现 | 保留 | 必须独立版本化改变 |
| P80/P90 nominal coverage | 目标产品语义 | 不直接声称达标 | 独立 calibration/test |

### D.2 场景一：同样的训练，昨晚睡不好

固定 workout、长期基线和 profile，只更换当日恢复事实。
预期：CA/TA 不变；Readiness 可能由 no_low_signal 变 caution；Coach 可将质量课降阶。
不能同时出现“长期能力下跌”解释。

### D.3 场景二：HR 丢失但速度正常

efficiency=null；CA 按覆盖政策变不确定或不输出。
TA 不因缺维度展示收缩而下调；负荷走已声明 fallback，confidence 降低。
“没有心率”不是“心肺能力低”。

### D.4 场景三：5K 测试强，但无半马训练暴露

Performance VDOT 可有较强短距离证据；半马 Preparation 可能低或 unknown，取决于历史完整性。
Durability 没有后段证据则 insufficient。
预测拆开 potential/prepared，不把同一长跑缺口扣两次，也不把 CA 重新拉低。

### D.5 场景四：近一周负荷增加但恢复信号正常

显示负荷变化与 ACWR 参考；结合 ramp/strain/强度分布和计划决策。
不得仅因 ACWR>1.3 在新旧两个层各加一次“身体疲劳”结论。
恢复无异常也不等于可以无限加量。

### D.6 场景五：本地数据库半年没更新

dataThroughAt 过期，Readiness not_assessed，Fitness 标明数据陈旧。
不能将半年未同步直接当作半年未训练应用确定性退训结论。

### D.7 场景六：天气修正没有必要

有平路、中性环境证据，adapter 返回 not_needed，normalized 可等于 raw。
高质量标准测试连续变慢仍允许 TA 学习下降；不被 `environmentAdjusted=false` 永久冻结。

### D.8 场景七：全新 V2 没有训练标签

仍可完成类型边界、恢复隔离、数据可追溯、发布和回滚验证。
Prediction 继续明确标识公式基线，ML/经验 P80/P90 不激活。
“框架可运行”和“准确率已验证”作为两项独立交付验收。

---

**文档结论：先把现有模型的职责、证据和版本边界做对，再用真正可得的标签证明精度提升；不要用更多参数、更复杂模型或更多分数替代证据。**
