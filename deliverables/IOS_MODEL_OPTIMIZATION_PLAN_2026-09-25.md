# iOS 跑力 / 成绩预测 / 恢复 / 疲劳模型优化实施方案

- 方案日期：2026-09-25（Asia/Shanghai）
- 依据：`deliverables/IOS_MODEL_AUDIT_2026-09-25.md`
- 目标范围：服务端预测链路、预测 API 合约、iOS 原生展示与缓存
- 不包含：重写 TypeScript 评分核心、设备端重新计算模型、HealthKit 写入、Watch 独立产品
- 当前工作区：脏树；实施前必须保留现有改动，不要用 reset/checkout 覆盖用户代码

## 1. 最终目标

让每一次 iOS 预测都满足四个条件：

1. **证据正确**：训练、比赛、恢复数据的时间窗口和 SQL 绑定完整，不静默产生空结果。
2. **缺测中性**：没有证据时返回 `insufficient_data/unmodeled`，不把缺测编码成 0 分或最大惩罚。
3. **可解释**：客户端能够显示模型版本、生成时间、数据截至时间、证据来源、修正秒数和覆盖状态。
4. **失败可见**：请求失败、解码失败、旧缓存和未知枚举不能伪装成当前有效结果。

产品语义固定为：

- **跑力/VDOT**：当前能力和表现证据。
- **成绩预测**：在当前跑力、专项准备度、环境和恢复情景下的估计。
- **恢复状态**：面向训练建议的生理状态。
- **疲劳修正**：成绩预测中的场景修正。

恢复状态和疲劳修正可以相关，但不合并成一个分数。

## 2. 实施顺序与发布闸门

| 阶段 | 内容 | 目标 | 闸门 |
|---|---|---|---|
| P0 | 修复训练证据 SQL、缺测语义 | 消除错误输入 | 合成库和真实只读库对账通过 |
| P1 | 预测报告解释协议、恢复来源协议 | 服务端结果可解释 | TypeScript 合约/报告测试通过 |
| P2 | iOS DTO、缓存、失败和未知状态 | 不再显示伪当前结论 | iOS 回归覆盖成功/失败/旧缓存 |
| P3 | UI 展示、恢复环、可访问性 | 用户理解结果 | 1440×900 模拟器视觉验收 |
| P4 | 评估、灰度、回滚 | 安全上线 | walk-forward 与线上诊断指标达标 |

P0 未完成前，不切换模型版本、不激活新的 ML 模型、不把页面标记为“模型已验收”。

## 3. P0：修复证据供给和缺测语义

### 3.1 M-01：修复 training-envelope 查询

涉及文件：

- `packages/application/src/prediction-data.ts`
- `packages/application/test/prediction-data.test.ts`
- `packages/application/src/prediction-report.ts`

实施：

1. 定义共享窗口常量，例如 `PERFORMANCE_ENVELOPE_WINDOW_DAYS = 56`。
2. 在 `loadPerformanceVdotEvidence` 中明确：
   - override 的历史截止时间：`asOf`
   - 训练起始时间：`asOf - 56 days`
   - 训练结束时间：`asOf`
3. 按 SQL 占位符顺序显式绑定：
   ```ts
   .all(asOf, windowStart, asOf)
   ```
4. 加参数数量保护。不要仅依赖 SQLite 少绑定参数时的静默 NULL 行为。
5. 过滤规则保持不变并加回归：
   - active session；
   - 距离 3–30 km；
   - 起止时间位于窗口；
   - excluded 不进入；
   - 未来训练不进入；
   - 已有 race/time-trial 标签的记录不重复计入 training-envelope。

验收：

- 合成数据库含 5 km、10 km、半马普通训练时，`performanceVdotEvidenceCount > 0`；
- 未来、excluded、超距离和异常配速记录不进入；
- 真实只读 `var/rai.sqlite` 复核时，查询结果与 SQL 行集一致；
- `/v1/predictions` 返回的 `inputs.performanceVdotEvidence` 与实际证据行数一致。

### 3.2 M-02：将 readiness 缺失与低 readiness 分开

涉及文件：

- `packages/application/src/prediction-data.ts`
- `packages/application/src/prediction-report.ts`
- `packages/physiology/src/index.ts`
- `packages/contracts/src/index.ts`
- 相关 physiology/application tests

推荐设计：

1. 不再用 `{ five_k: 0, ten_k: 0, half_marathon: 0 }` 表示“没有训练证据”。
2. `loadRaceReadiness` 返回：
   ```ts
   {
     values: {
       five_k: number | null,
       ten_k: number | null,
       half_marathon: number | null
     },
     status: "available" | "insufficient_data",
     evidenceCount: number,
     dataThroughAt: string | null
   }
   ```
3. 预测核心收到 `null/undefined` 时使用已有的**中性默认准备度**：
   - 5 km：0.70
   - 10 km：0.60
   - 半马：0.45
4. 只有真实 readiness 值存在时才施加 `race_readiness_applied` 和低准备度证据码。
5. 无专项证据时：
   - `readiness` 序列化为 `null`；
   - 添加 `endurance_readiness_unmodeled`；
   - 不添加 `race_readiness_low`；
   - guidance 增加 `race_readiness_missing`。

这会改变报告输入中 readiness 的类型，因此将报告协议升为 v3；旧 iOS 通过兼容解码继续显示旧缓存，但新响应必须按 v3 处理。

验收三组固定样本：

| 样本 | readiness | 预测行为 |
|---|---:|---|
| 无训练 | `null` | 不施加“最大准备度惩罚” |
| 仅普通短跑/短距离 | 可能部分 `null` | 逐距离表达缺测 |
| 有效专项训练 | 0–1 | 应用专项 readiness，并显示证据 |

### 3.3 恢复读取的事实口径

涉及文件：

- `packages/storage-sqlite/src/read/prediction-recovery-read-repository.ts`
- `packages/application/src/prediction-data.ts`
- `packages/application/test/prediction-data.test.ts`

实施：

1. 保留 canonical 优先。
2. raw HRV fallback 只作为兼容路径，并返回来源标记，不得无声降级。
3. 为每个指标返回：
   ```ts
   {
     source: "canonical" | "raw_compat" | "none",
     recentValue: number | null,
     baselineValue: number | null,
     recentSampleCount: number,
     baselineSampleCount: number,
     latestObservedAt: string | null
   }
   ```
4. canonical 表缺失可以进入 `raw_compat`；SQL 执行错误必须抛出并进入错误监控，不能被当成“表不存在”。
5. 明确窗口：
   - recent：最近 7×24 小时；
   - baseline：前 28 天；
   - 所有边界使用同一个 `asOf` 和 timezone 语义。

## 4. P1：统一预测解释协议

### 4.1 服务端协议扩展

涉及文件：

- `packages/contracts/src/index.ts`
- `packages/api-contracts/src/index.ts`
- `apps/api/src/schemas.ts`
- `packages/application/src/prediction-report.ts`
- `apps/api/test/schemas.test.ts`

在 `PhysiologyPredictionReport` 增加可选兼容字段：

```ts
interface PredictionExplainability {
  schemaVersion: "prediction-explainability-v1";
  recovery: {
    readiness: number | null;
    status: "available" | "insufficient_data" | "stale" | "compat_fallback";
    source: "canonical" | "raw_compat" | "none";
    asOf: string;
    latestObservedAt: string | null;
    coverage: "full" | "partial" | "none";
  };
  readiness: Record<RaceDistance, {
    value: number | null;
    status: "available" | "insufficient_data";
    evidenceCount: number;
    dataThroughAt: string | null;
  }>;
}
```

顶层已有字段应直接复用，不重复制造第二套数值：

- `generatedAt`
- `snapshot.modelVersion`
- `snapshot.dataThroughAt`
- `snapshot.races[*].fatigueAdjustmentSeconds`
- `snapshot.races[*].evidenceCodes`
- `snapshot.races[*].method`

API 兼容策略：

- 新字段第一版全部可选；
- 核心字段缺失仍视为解码失败；
- 服务端同时保留旧 `reportVersion` 一版；
- iOS 在旧版本服务端上显示“解释信息不可用”，不伪造默认来源。

### 4.2 证据码规范

保留已有证据码，新增并固定语义：

- `race_readiness_applied`：有专项 readiness 且确实应用；
- `endurance_readiness_unmodeled`：没有专项证据，使用中性默认；
- `fatigue_adjustment`：恢复情景实际改变了预测；
- `recovery_data_insufficient`：恢复数据不足；
- `recovery_compat_fallback`：使用 raw HRV 兼容路径；
- `future_evidence_excluded`：存在但被 asOf 排除的未来证据。

证据码必须由模型层生成，iOS 只做映射和展示，不重新推断。

## 5. P2：iOS DTO、缓存和失败语义

涉及文件：

- `apps/ios/RAI/APIModels.swift`
- `apps/ios/RAI/APIClient.swift`
- `apps/ios/RAI/NativeAppModel.swift`
- `apps/ios/RAI/CacheStore.swift`
- `apps/ios/tests/ModelRegression.swift`

### 5.1 NativePredictionResponse 完整解码

将当前手工缩减 DTO 扩展为：

- `reportVersion`
- `generatedAt`
- `inputs`
- `modelSelection`
- `guidanceCodes`
- `snapshot`
- `explainability`

`snapshot` 核心字段保留必填；新增解释字段使用 `decodeIfPresent`，以支持旧服务端。

Swift 类型建议：

```swift
enum PredictionLoadState {
    case current(generatedAt: Date?, dataThroughAt: Date?)
    case stale(lastSuccessAt: Date?, failureMessage: String)
    case unavailable(message: String)
}

enum MobileRecoveryState {
    case recovered
    case reduced
    case depleted
    case unknown(raw: String?)
}
```

未知状态必须显示“未识别状态”，不能落到“基线不足”。

### 5.2 刷新失败和旧缓存

当前行为保留旧值但没有明确状态。改为：

1. 请求成功：
   - 更新 `predictions`；
   - 记录 payload 的 `generatedAt/dataThroughAt`；
   - `predictionLoadState = .current(...)`；
   - 写入缓存。
2. 请求失败或 DTO 解码失败：
   - 不删除旧缓存；
   - `predictionLoadState = .stale(...)`；
   - 保存失败时间、HTTP 状态/解码错误类别；
   - 页面必须显示“显示的是旧结果，最近刷新失败”。
3. 没有旧缓存：
   - `predictionLoadState = .unavailable(...)`；
   - 页面显示空态，不显示 0。
4. `refreshRacePrediction` 必须返回可观察错误状态，不能只 `return`。

`CachedValue.cachedAt` 继续表示本地写入时间；不要把它当作模型生成时间。

### 5.3 恢复环

在确认 API score 单位后实现：

- score 为 0–100：`progress = score / 100`
- score 为 0–1：`progress = score`
- `nil`：`progress = 0`，但显示“暂无数据”，不可显示“0%”

增加单元测试：0、50、100、nil、越界值。

## 6. P3：iOS 页面改造

涉及文件：

- `apps/ios/RAI/Skins/Technology/TechViews.swift`
- `apps/ios/RAI/Skins/Technology/TechAbilityDetailView.swift`
- `apps/ios/RAI/Skins/Technology/TechTodayRecovery.swift`
- `apps/ios/RAI/Skins/Technology/TechCharts.swift`
- `apps/ios/tests/run-tech-presentation-tests.sh`

页面最低展示内容：

### 跑力

- VDOT 数值/区间；
- 证据数量；
- 最新证据时间；
- 方法；
- “证据不足”而不是静默旧数字。

### 成绩预测

- 预测区间；
- readiness 是否真实可用；
- fatigue adjustment 秒数；
- environment/elevation adjustment 秒数；
- model method；
- generatedAt/dataThroughAt；
- evidence codes 的用户友好文案。

### 恢复

- score 和状态；
- source：canonical/raw compat/none；
- coverage：full/partial/none；
- 最近样本时间；
- unknown 状态原文；
- 恢复状态与成绩预测疲劳修正的区别说明。

所有页面文案遵守：

- “没有数据”不写成“很差”；
- “未知状态”不写成“基线不足”；
- “旧缓存”不写成“当前结果”；
- “预测区间”不写成比赛承诺。

## 7. P4：测试和质量闸门

### TypeScript

新增或扩展：

1. SQL 三占位符/三参数结构测试；
2. 合成库 training-envelope 11 类边界测试；
3. readiness 缺失、部分缺失、真实低 readiness；
4. canonical/raw fallback 来源和覆盖；
5. HTTP 报告字段完整性；
6. report v2/v3 兼容；
7. evidence code 与 adjustment 秒数一致性；
8. `dataThroughAt <= generatedAt`；
9. 未来证据和 excluded 证据排除。

### iOS

在 `apps/ios/tests/run-model-tests.sh` 或已有聚合入口加入：

1. 完整 `NativePredictionResponse` JSON 解码；
2. 缺失可选扩展字段仍可解码；
3. 缺失核心字段解码失败；
4. 未知 recovery state 映射为 `.unknown(raw:)`；
5. 0/50/100/nil 恢复环；
6. predictions HTTP 500 后旧缓存标记 stale；
7. decode failure 后不得标记 current；
8. 没有缓存时显示 unavailable；
9. refreshRacePrediction 失败产生错误状态；
10. readiness `null` 不显示“0%”；
11. fatigue adjustment/evidence/method 展示；
12. 生成时间和数据截至时间展示。

### 必跑命令

```bash
npm run typecheck
npm test
npm run build
npm run test:ios
npm run test:e2e:web
```

不运行 `npm run test:e2e:responsive`，除非后续改动触及冻结的窄屏代码。

## 8. 观测、灰度和回滚

### 服务端指标

记录但不记录健康原始值：

- `prediction.performance_vdot_evidence_count`
- `prediction.readiness_status`
- `prediction.recovery_source`
- `prediction.recovery_coverage`
- `prediction.generated_at_age_seconds`
- `prediction.data_through_age_seconds`
- `prediction.client_decode_error`
- `prediction.client_stale_display`

### 灰度顺序

1. 本地合成库；
2. 当前真实只读副本；
3. 本地 iOS 模拟器；
4. 内部设备；
5. 小范围用户；
6. 默认全量。

### 回滚开关

保留以下开关至少一个版本：

- `PREDICTION_REPORT_V3_ENABLED`
- `PREDICTION_READINESS_MISSING_IS_NEUTRAL`
- `PREDICTION_RECOVERY_CANONICAL_ONLY`
- iOS `usePredictionExplainability`

回滚只切换报告协议/展示，不回滚健康数据、不删除缓存、不切换 active model 指针。

## 9. 完成标准

只有满足以下条件，才可将 iOS 模型页面标记为“已验收”：

- M-01 至 M-08 均有自动化测试；
- 真实只读库的 training-envelope 不再静默为空；
- readiness 缺失不会产生最大准备度惩罚；
- 恢复来源、覆盖和时效可追踪；
- iOS 旧缓存、HTTP 失败、解码失败、未知枚举均可见；
- 恢复环和数字一致；
- `npm run typecheck`、`npm test`、`npm run build`、`npm run test:ios`、`npm run test:e2e:web` 全部通过；
- 至少有一轮 walk-forward 评估报告，包含 MAE、RMSE、MAPE、区间覆盖率，不能用单元测试数量代替准确率证据；
- 完成 1440×900 模拟器视觉验收；
- 记录服务端报告版本、模型版本、数据截至时间和回滚点。

## 10. 推荐实施拆分

建议拆成以下互不混淆的提交：

1. `fix(prediction): bind performance envelope window parameters`
2. `fix(prediction): represent missing race readiness explicitly`
3. `feat(prediction): expose recovery provenance and explainability`
4. `feat(ios): decode prediction report metadata`
5. `fix(ios): surface stale prediction cache and request failures`
6. `fix(ios): render recovery gauge from score`
7. `test(prediction): add evidence, fallback, and protocol regressions`
8. `test(ios): add prediction cache and unknown-state regressions`
9. `docs(prediction): publish walk-forward and rollout evidence`

每个提交都应保持可编译、可回滚；不要把 SQL 修复、模型参数调整和 UI 重构放在同一提交中。

## 11. 2026-09-25 实施记录

本轮已落地：

- 修复 training-envelope 三个 SQL 占位符的绑定，并固定 56 天窗口；
- 普通训练在真实只读库中恢复为 11 条 VDOT 证据；
- readiness 无证据时返回空值和 `insufficient_data`，不再返回 0；
- 新增 `race_readiness_missing` guidance；
- 增加预测报告 explainability：恢复来源、覆盖、截至时间、专项 readiness 证据；
- 增加 canonical/raw HRV fallback provenance；
- iOS 扩展预测 DTO，展示 fatigue adjustment/method，并区分当前、陈旧和不可用状态；
- 未知恢复状态显示“未识别状态”；
- 修复恢复环使用 score 的 0–100 到 0–1 映射；
- 增加 TypeScript、iOS DTO 和真实数据库回归。

仍需后续单独完成：

- 线上指标接入和灰度开关；
- 模拟器视觉/真机 HealthKit 验收；
- 完整 walk-forward 准确率门槛与线上脱敏样本评估；
- 完整突变测试。
