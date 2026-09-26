# iOS 跑力 / 成绩预测 / 恢复预测 / 疲劳模型定向审查

- 审查日期：2026-09-25（Asia/Shanghai）
- 审查范围：`apps/ios` 原生端及其直接依赖的预测/恢复服务端链路
- 当前基线：工作区脏树；本次未修改业务代码
- 关联审计：
  - `docs/MODEL_ACCURACY_MULTIAGENT_AUDIT_2026-09-07.md`
  - `docs/ARCHITECTURE_MODEL_AUDIT_2026-09-07.md`
  - `deliverables/IOS_PLAN_RACE_REVIEW_2026-09-25.md`

## 一、结论先行

**总体评级：🟡，不建议把当前 iOS 页面当作“模型已验收”。**

iOS 端的架构方向是对的：评分核心留在 TypeScript，原生端只负责请求、解码、缓存和展示；没有发现 iOS 在设备端重复计算跑力或恢复分。但四类模型在进入 iOS 之前存在一个已实证的 🔴 证据供给缺陷，端上还存在若干会把“缺失/失败/不同口径”呈现成数值结论的风险。

| 域 | 评级 | 判断 |
|---|---|---|
| 跑力 | 🔴 | training-envelope 查询因少绑定参数恒空，真实库复核返回 0 行；普通训练的 VDOT 证据永久缺失 |
| 成绩预测 | 🟡 | 公式链路有因果/区间护栏，但 iOS 没展示方法、证据代码和疲劳修正，且空准备度被解释成极差准备度 |
| 恢复预测 | 🟡 | 查询已抽到独立 repository 并有时窗，但 raw HRV fallback、canonical 口径和端上 DTO 容错仍需补强 |
| 疲劳模型 | 🟡 | 没有独立疲劳模型：成绩预测使用 0–4% 线性 recovery penalty，训练建议又使用另一套 physState 规则，端上无法解释差异 |
| iOS 测试可信度 | 🟡 | `npm run test:ios` 通过，但 iOS 专项没有预测 DTO/缓存/失败语义断言；完整突变未跑 |

## 二、审查方法与实跑结果

### 已实跑

1. `npm run test:ios`：**EXIT=0**。
   - 类型检查 59 个 iOS 文件；跳过 3 个仅依赖高德 SDK 的文件。
   - 纯逻辑回归、模型/DTO、缓存、计划映射、展示结构、后台同步等聚合门禁通过。
2. 定向 TypeScript 模型测试：**53/53 通过，0 fail**。
   ```text
   node --import tsx --test \
     packages/physiology/test/physiology.test.ts \
     packages/features/test/features.test.ts \
     packages/application/test/prediction-data.test.ts \
     packages/application/test/prediction-report.test.ts
   ```
3. 真实只读健康库验证：
   ```text
   loadPerformanceVdotEvidence(/Users/ta/running/var/rai.sqlite,
     asOf=2026-09-25T00:00:00.000Z)
   => {"count":0,"sample":[]}
   ```
4. 对同库做简化 SQL 对账：窗口内 `training_sessions` 在距离 3–30 km 且 `2026-07-31..2026-09-25` 可命中 **11** 行；同一类查询若把 `anchor_end_at <= NULL` 纳入条件则为 0 行，证明“少绑定参数 → 静默空结果”而不是数据天然为空。

### 未完成

- 未运行完整 `test:ios:mutation`：该脚本会原地改写源码，本轮按只读审查边界未执行；不能声称 83 条突变均通过。
- 未做模拟器视觉、真机 HealthKit、Apple Watch 排期/真实设备到达验证。
- 未做线上目标机器预测性能或脱敏样本准确率评估。
- 两个辅助审查子代理因服务端 **403 insufficient balance** 失败；本报告不引用其未完成结果。代码结论均由主审查直接读取与实跑复核。

## 三、分级问题清单

### 🔴 M-01：training-envelope VDOT 证据恒为空

**证据**

- `packages/application/src/prediction-data.ts:242-272`：查询包含：
  - `historicalOverrideJoin("LEFT JOIN")` 里的 `override.created_at <= ?`；
  - `session.anchor_start_at >= ?`；
  - `session.anchor_end_at <= ?`。
- `:272` 实际只传 `.all(asOf, asOf)` 两个参数。
- node:sqlite 少传参数不抛异常，缺位按 NULL 参与比较；`anchor_end_at <= NULL` 恒为 UNKNOWN/false。
- 真实库调用 `loadPerformanceVdotEvidence(..., 2026-09-25)` 返回 0 条；同库简化窗口查询可命中 11 条。
- 该函数被 `packages/application/src/prediction-report.ts:204-235` 的 `buildFormulaPredictionBase` 调用，最终进入 API `/v1/predictions`（`apps/api/src/server.ts:1293-1317`），因此会直接影响 iOS 的 VDOT、成绩预测和区间。

**影响**

普通训练的 training-envelope 不进入 performance VDOT ensemble；模型可能仍返回结果，但证据数量、当前能力和置信度被系统性压低。由于是静默空查询，API 和 iOS 不会报错提醒。

**建议修复**

明确窗口意图后补齐第三个绑定参数（建议与同文件 `loadRaceReadiness` 的 56 天窗口模式一致），并加一个真实 SQL/合成库回归：3 个占位符必须有 3 个参数；有合格非标记训练时 `performanceVdotEvidenceCount > 0`。如果产品意图是全部历史，改成显式的 `anchor_start_at <= asOf` 语义，不要只机械补参数。

**验收**

- 5/10/半马训练包络各至少一条时，查询非空；
- 未来训练、被排除训练、标记比赛不会混入；
- `performanceVdotEvidenceCount` 与行集对账；
- API `/v1/predictions` 与 iOS 页面能显示“证据不足”而不是静默旧缓存。

**回滚**：保留当前函数签名，回滚 SQL 窗口/参数改动即可；不触碰健康库和 active model 指针。

### 🟡 M-02：无训练证据时 readiness=0，被当成最大准备度惩罚

**证据**

- `packages/application/src/prediction-data.ts:467-474`：`usable.length === 0` 返回 `{ five_k: 0, ten_k: 0, half_marathon: 0 }`。
- `packages/physiology/src/index.ts:827-858`：缺省 readiness 参与 `(1 - readinessValue) * raceReadinessVdotPenalty`，0 即最大 readiness penalty；随后 `preparedSeconds` 变慢。
- 预测仍可能有 VO2 evidence，因此不是“无预测”，而是“没有赛事专项训练证据却按最差准备度扣分”。
- iOS `APIModels.swift:403-410` 解码为可选 readiness；`TechAbilityDetailView.swift:221-225` 和 `TechViews.swift:868` 直接显示“准备度 0%”。

**判断**

缺测不是差评。此前项目自身的恢复语义也明确要求“覆盖不足是缺测，不是差评”。这里应区分 `unmodeled/insufficient_data` 与真实 0 分准备度。

**建议修复**

将 `loadRaceReadiness` 无 usable 记录改为返回缺失语义（或额外返回 evidence status），由预测层在无专项证据时不施加最大惩罚，或使用显式保守先验但在 payload 中标注 `unmodeled`。不要仅把 0 改成 0.5 而不改变语义。

**验收**：无训练、仅普通短跑、有效专项训练三组分别验证 predictedSeconds、readiness、confidence 和 evidenceCodes；iOS 文案不能把“无数据”显示为“准备度 0%”。

### 🟡 M-03：恢复查询存在两套事实口径，fallback 仍读 raw HRV

**证据**

- `packages/storage-sqlite/src/read/prediction-recovery-read-repository.ts:89-113`：有 `canonical_hrv_days` 时读 canonical；表不存在时 fallback 到 raw `health_records` 的 HRV 中位数。
- 同文件 `:74-80` 计算最近 7 天与前 28 天窗口；睡眠在 canonical 表存在时按 `canonical_nights`，否则不提供睡眠值。`timezoneIdentifier` 只用于 canonical 查询；raw fallback 的 `start_at` 是绝对 UTC 窗口。
- 历史架构审计 `docs/ARCHITECTURE_MODEL_AUDIT_2026-09-07.md:17-26` 已指出 raw HRV 与 canonical 来源选择/夜间聚合不一致、旧表缺失与真实 SQL 故障需要区分。

**影响**

不同数据库迁移状态可能得到不同的恢复 readiness；端上只看到一个分数，无法知道是 canonical 还是 raw fallback，也没有看到数据覆盖和时效理由。

**建议修复**

fallback 只能是明确兼容策略：返回 source/coverage 状态，给 raw HRV 与 canonical HRV 单独 evidence code；旧库缺表只允许在已确认 schema 版本时降级，真实 SQL 错误必须上抛/告警。恢复分、恢复状态和成绩预测输入应共享同一事实口径。

### 🟡 M-04：恢复与疲劳不是一个模型，iOS 无法解释差异

**证据**

- 成绩预测：`packages/physiology/src/index.ts:867-877` 使用 `fatiguePenalty = (1 - recoveryReadiness) * 0.04`，最多让时间增加 4%。
- 训练建议：`packages/training-load/src/index.ts:25-46` 使用睡眠/HRV/RHR 比值和“三晚低睡眠”等分支输出 `unknown/recovered_phys/reduced/depleted`。
- iOS `APIModels.swift:178-200` 仅解码 recovery score/state/note；`NativeRacePrediction`（`:403-410`）没有 fatigueAdjustmentSeconds、evidenceCodes、method。
- 页面 `TechAbilityDetailView.swift:205-225` 只显示预测区间和“准备度”；没有显示预测使用的恢复快照、疲劳修正秒数或模型方法。

**影响**

同一用户可能看到“恢复状态 reduced”但比赛预测只慢几个百分点，或恢复缺测时成绩预测依然可用；这可能是合理的不同用途模型，但当前协议没有向用户解释，容易把 readiness、恢复状态、疲劳和达标概率混为一谈。

**建议修复**

先冻结产品语义：恢复状态用于训练建议，疲劳修正用于场景成绩预测，两者不强行合并。然后在 API/iOS 增加可解释字段（source date、coverage、fatigueAdjustmentSeconds、evidenceCodes、method），明确“恢复状态 ≠ 目标成绩达成概率”。

### 🟡 M-05：iOS predictions 硬解码 + `try?`，协议演进/失败会静默显示旧值

**证据**

- `apps/ios/RAI/APIModels.swift:368-412`：`NativePredictionResponse`、VO2、VDOT、阈值和 race 字段大多为非 optional；服务端报告字段持续演进时缺字段会整体解码失败。
- `apps/ios/RAI/NativeAppModel.swift:428-470`：四路请求并发，预测请求 `try? await`；失败只计数并设置 `bodyMetricsError`，不清除此前 `predictions`，页面仍可继续显示缓存/旧结果。
- `:735-744` `refreshRacePrediction` 也以 `try?` 失败即返回，没有错误状态。
- `:846-874` 从缓存恢复 predictions，缓存没有明确生成时间/数据截止时间字段。

**影响**

用户可能看到“刷新后”的旧跑力/成绩预测，却无法知道预测生成时间、数据截止时间或本次请求失败；对于健康与训练建议，旧预测的误导性高于空态。

**建议修复**

将 prediction payload 包装为带 `generatedAt/dataThroughAt/modelVersion` 的 DTO（服务端已有 report 字段，可在 API contract 中暴露），端上缓存同步保存状态；刷新失败时显示“数据来自某时刻/刷新失败”，不要只保留数字。对可选扩展字段使用 `decodeIfPresent`，对核心字段保留契约测试而不是全量 `try?` 吞掉。

**验收**：预测成功、HTTP 500、字段缺失、旧缓存、切换服务端五种场景；页面不得把旧值标成当前快照。

### 🟡 M-06：恢复面板的进度环永远为空

**证据**

- `apps/ios/RAI/Skins/Technology/TechViews.swift:809-815`：显示 `summary.recovery.score`，但传给 `TechGauge` 的是 `progress: 0`。
- `TechGauge` 在 `apps/ios/RAI/Skins/Technology/TechCharts.swift:71-97` 按 progress 绘制填充弧，因此恢复环恒为空；数字与环不一致。

**影响**

这是确定的展示缺陷，不是视觉偏好：用户看到恢复数字，却看到“0%”的空环。

**建议修复**

若服务端 score 语义是 0–100，传 `score.map { $0 / 100 }`；若是 0–1，则直接传入。必须先以 API contract/真实响应确认单位，再加 0、50、100、nil 的展示回归，不能盲改。

### 🟡 M-07：未知恢复状态静默折叠为“基线不足”

**证据**

- `apps/ios/RAI/APIModels.swift:190-198`：只识别 `recovered/recovered_phys`、`reduced`、`depleted`；任何新增 state 都进入 default，再按是否有样本显示“基线不足”。
- `TechTodayRecovery.swift:49-55` 对未知状态也只给 muted 颜色。

**影响**

服务端扩展枚举后，旧 iOS 版本可能把新状态错误解释成“基线不足”，而不是“不兼容/未知”。

**建议修复**

增加 `.unknown` 显式状态和原始 code 的记录；页面显示“服务端返回了未识别状态，请刷新/升级”，不把未知当作证据不足。加契约测试覆盖未知枚举。

### 🟡 M-08：iOS 四类模型没有专门的预测 DTO/缓存/失败回归

**证据**

- `apps/ios/tests/run-model-tests.sh:26-32` 编译 `APIModels.swift/APIClient.swift/NativeAppModel.swift/ModelRegression.swift`，并聚合其它 iOS 逻辑门禁。
- `apps/ios/tests/ModelRegression.swift:165-169` 只测 `MobileRecoveryBreakdown.stateLabel`；`:278-300` 的 today JSON 含 recovery/race 字段，但不是 `NativePredictionResponse` 专项解码、刷新失败或缓存新鲜度测试。
- `npm run test:ios` 绿只能说明已有纯逻辑/结构门禁通过，不能证明四类模型端到端契约成立。

**建议补测**

1. NativePredictionResponse 完整 JSON 解码，覆盖 null race seconds、未知 evidence、缺失扩展字段。
2. predictions HTTP 500/JSON decode failure 后，旧缓存必须带 stale 标记，不得伪装当前。
3. recovery score 单位和状态枚举覆盖；未知状态显式 unknown。
4. race readiness 缺失 vs 0、fatigue adjustment/evidenceCodes/method 展示语义。
5. `refreshRacePrediction` 失败必须产生可观察状态。

## 四、绿区与已验证设计

- `apps/ios/RAI/Skins/Technology/TechAbilityDetailView.swift:4-7` 明确端上不重算评分，避免 TS/Swift 双实现漂移。
- `apps/ios/RAI/APIClient.swift:193-210` 预测、恢复趋势接口分离，职责清楚。
- `packages/physiology/src/index.ts:212-222,277-291` VDOT 与成绩互算闭环；`packages/physiology/test/physiology.test.ts:24-27` 已验证 5K 代表值和反解误差。
- `packages/physiology/src/index.ts:349-360` 排除 asOf 之后的证据；测试 `physiology.test.ts:67-80` 已覆盖未来证据排除。
- `packages/physiology/src/index.ts:879-896` 预测区间保留乐观/悲观边界；iOS 明确显示“区间参考”，没有把它宣称为比赛承诺。
- `packages/features/src/index.ts:410-456` 恢复分量缺失会剔除并重归一，load-only 不单独制造恢复分；`features.test.ts:90-144` 已覆盖缺失基线与 load-only。
- `packages/training-load/src/index.ts:34-46` 无证据返回 unknown，符合“缺测不是差评”的安全原则。
- `packages/storage-sqlite/src/read/prediction-recovery-read-repository.ts:74-149` 恢复读取有明确 recent/baseline 时间窗，且 canonical HRV/睡眠路径已独立封装。

## 五、行动顺序、验收与回滚

### P0：修复 M-01

- 先明确 training-envelope 的 asOf/window 语义，修复 SQL 绑定。
- 加 3 占位符/3 参数的结构测试与合成数据库行数对账。
- 验收：真实脱敏副本或合成库中普通训练证据非空；未来/排除行不进入；`/v1/predictions` 的 `performanceVdotEvidenceCount` 变化可解释。
- 回滚：回滚应用层查询和测试，不改健康数据/模型指针。

### P1：修复 M-02/M-03/M-05

- 区分 readiness 缺失、真实低准备度和保守先验。
- 给恢复读数返回 source/coverage/freshness；canonical/raw fallback 明确标记。
- prediction DTO 增加 generatedAt/dataThroughAt/modelVersion，iOS 缓存携带 stale/error 状态。
- 验收：空训练、陈旧睡眠、canonical/raw 冲突、HTTP 失败、字段演进均不会产生伪当前结论。
- 回滚：DTO 扩展字段使用可选兼容；服务端保留旧字段一版，不切换模型版本。

### P1：修复 M-06/M-07/M-08

- 修复恢复环单位映射前先锁定 score 单位。
- 未知 state 显式呈现 unknown。
- 添加 NativePredictionResponse 与 NativeAppModel 请求/缓存回归。
- 验收：score 0/50/100/nil 和未知 state 全部可判定；刷新失败可见；旧值标 stale。
- 回滚：仅回滚展示/DTO 增量，不触碰评分核心。

### P2：统一模型解释协议

- 保留“恢复状态”和“成绩预测疲劳修正”作为不同业务用途，但在同一报告中提供来源日期、覆盖、修正秒数、evidenceCodes、method。
- 只有真实 walk-forward 标签达到样本量门槛后，才评估调整系数或激活 ML；不以当前 53 个单元测试替代模型准确率证据。

## 六、辅助结论反向复核

- 历史 `MODEL_ACCURACY_MULTIAGENT_AUDIT_2026-09-07.md` 的 F1 本轮不是直接照抄：我重新读取当前代码、在真实只读数据库调用 `loadPerformanceVdotEvidence`，并做 SQL 行数对账，确认仍存在。
- 历史架构审计称预测恢复事实来源/时效存在风险；当前代码已抽出 `SqlitePredictionRecoveryReadRepository` 并增加 7/28 日窗口，说明该项已**部分修复**，但 raw HRV fallback 与 source/coverage 不透明仍保留。
- “iOS 只展示服务端模型”得到当前代码支持，不把端上页面误报成第二套评分核心。
- 两个并行审查代理因 403 余额不足失败；因此没有把其未完成内容写成独立证据，所有结论均来自本轮主审查读取和命令实跑。

## 七、范围声明

本报告不覆盖：真实 iPhone/Apple Watch 到达效果、HealthKit 授权行为、模拟器视觉验收、线上机器数据规模与性能、完整突变套件、模型在真实比赛标签上的 MAE/RMSE/区间覆盖率，以及未列出的 Web 页面。