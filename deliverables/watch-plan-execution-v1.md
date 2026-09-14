# RAI 周课表方案 v2.0（LLM 每周生成 + 一键上表）

> 2026-09-12 · 依据小唐最新要求：**后端 LLM 每周分析一次最近跑步数据 → 生成整周课表 → 一键同步到手表体能训练**；interval 用**距离制**
> 状态：**M0a + M0b 已实现**（服务端 / iOS / web / 文档同批完成）。本文保留设计论证；实现落点见 §8。

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 周课表谁生成 | **后端 LLM**，每周一次（手动触发 + 可选定时），产出未来 1–7 天骨架 |
| 今天的课表呢 | **仍由现有闸门决策**——这不是我加的约束，是 `buildWeekPlan` 的现有行为（§2.2） |
| 落库通道 | 🟢 **零新增存储**：复用已有 `PUT /v1/mobile/goals` 的 `weekPlan` 字段（含 revision 乐观锁） |
| 上表通道 | WorkoutKit（`WorkoutScheduler`），读新增的 `GET /v1/mobile/workout-plan` |
| interval | **距离制**（800m 重复跑），结构走 `MobileSessionStructure` |
| 🔴 最大风险 | LLM 不得绕过硬风控：周量增幅、质量课数量、配速区间必须被**钳制器**拦截 |

**一句话**：LLM 只是**第三个结构生产者**。先把契约（`MobileSessionStructure`）定死，启发式与 LLM 产出同一形状，WorkoutKit 上表层完全不需要知道课表是谁写的——这让 M0a/M0b 可以分批上线且零返工。

---

## 1. 现状实测（决定方案形状的四个事实）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **RAI 零 LLM 基础设施**：apps 下无任何 openai/anthropic/deepseek 调用，生产 env 里也没有模型密钥 | `deploy/*.example` 仅 `RAI_API_*` / `RAI_BACKUP_*` |
| 2 | **已有可持久化周计划通道**，且带乐观锁 | `GET/PUT /v1/mobile/goals`（`server.ts:702-717`），`weekPlan` 字段（`data.ts:222`）、revision 冲突返 409 |
| 3 | **周计划渲染已消费存储值**，且今天的课表走闸门 | `buildWeekPlan`（`mobile-coach.ts:684-729`）：已完成日→completed、过去日→rest、**今天→`next`（闸门决策）**、未来日→`stored` |
| 4 | **已有保守阈值可直接当钳制器** | `qualitySessionCap`（`DEFAULT_QUALITY_SESSION_CAP=2`，`mobile-coach.ts:23`）、`volume_ramp 30%`（`buildInjuryFlags:577-582`）、`easyDurationFloorFraction` |

---

## 2. 架构分层

### 2.1 数据流（生产者无关的契约）

```
[数据层]  已有：训练史 / 负荷 / 恢复 / zone 处方（DB + training-zones）
              │
   ┌──────────┴───────────┐
   │  生成层（两个生产者）  │
   │  (a) 启发式 decideNextSession  → 今天（天然过闸门）
   │  (b) LLM 周计划生成器（新增）    → 未来 1–7 天骨架
   └──────────┬───────────┘
              ↓  产出同一形状：MobileSessionStructure
[校验层]  新增：schema 校验 → 业务钳制（复用既有阈值）→ 失败回退启发式
              ↓
[存储层]  已有：PUT /v1/mobile/goals.weekPlan（revision 乐观锁）+ 审计字段（新增）
              ↓
[读取层]  已有：GET /v1/mobile/today.weekPlan（buildWeekPlan 自动消费）
              ↓
[上表层]  新增：GET /v1/mobile/workout-plan → WorkoutKit 映射 → 系统"体能训练"
```

### 2.2 🟢 "LLM 出题、闸门判卷"是白送的

`buildWeekPlan` 的现有分支逻辑（`mobile-coach.ts:684-729`）决定了：

| 日期 | 课表来源 |
|---|---|
| 已完成 | 实测数据（completed） |
| 过去空白日 | rest |
| **今天** | **`decideNextSession` + 闸门**（LLM 计划**不参与**） |
| 未来日 | `stored.weekPlan` ← **LLM 写这里** |

即：LLM 即使排了"今天 interval"，今天若 verdict=red，用户看到的仍是休息/恢复跑。**这不是妥协，是现有代码的正确行为**——LLM 是处方建议，闸门是执行许可。符合"下行风险优先"。

### 2.3 🟢 契约先行 = M0a / M0b 可分批

`MobileSessionStructure`（`warmup + blocks[{iterations, steps[{purpose, goal, alert}]}] + cooldown`）既是启发式的输出形状，也是 **LLM 的 JSON 输出 schema**。先定契约（M0a），LLM 层（M0b）接上时上表层零改动。

---

## 3. LLM 层设计（M0b，新增）

### 3.1 输入（喂最小充分集，不是全量数据）

近 4 周周跑量/时长 · 最近 N 次训练的 kind/配速/心率/刺激匹配 · 真实能力与 7 日变化 · 负荷指标（`loadRatio`/`rampRate`/`strain`/`monotony`）· 恢复（睡眠/HRV/RHR vs 基线）· **当前 zone 处方（各档配速/心率区间）** · `raceTarget` · `injuryFlags` · 用户目标（`weeklyDistanceGoalKm`、`easyDurationFloorFraction`、`qualitySessionCap`）。

### 3.2 输出（严格 JSON，未来 1–7 天）

```jsonc
{ "days": [ { "localDate": "2026-09-14", "kind": "interval",
              "distanceKm": 9.6, "reason": "…",
              "structure": { "warmup": {...}, "blocks": [{ "iterations": 5, "steps": [...] }], "cooldown": {...} } } ] }
```

### 3.3 🔴 三道防线（风控核心，缺一不可）

| 防线 | 内容 | 失败处理 |
|---|---|---|
| ① schema 校验 | 类型/枚举/日期必须是**未来 7 天集合内**（防幻觉日期）；`alert` 每步最多 1 个 | 拒绝该日 |
| ② 业务钳制（clamp） | 周量增幅 ≤ **30%**（复用 `volume_ramp` 阈值）· 质量课 ≤ `qualitySessionCap`(2) · 单次距离 ≤ 周目标 40% · `reps ≤ 8` · **配速不得快于 interval 区间下限** · rest 日不得排质量课 · 有 `injuryFlags` 时不排质量课 | 钳制后重算距离一致性 |
| ③ 回退 | LLM 超时/输出非法/钳制后不成形 | **退回现有启发式**（永不出现"没有课表"） |

### 3.4 审计与可复现（你要逐项复核，所以必须有）

存储追加元数据：`generatedBy: "llm" | "heuristic"` · `model` · `promptVersion` · `generatedAt` · 原始输出 JSON 留档。
**理由**：LLM 输出不可复现，出了问题必须能回溯"当时喂了什么、模型回了什么、钳制改了什么"。

### 3.5 触发与密钥

- **触发**：手动按钮（web/iOS「生成本周课表」）+ 可选每周定时（可挂 automation）
- **密钥**：走 `/etc/rai/rai.env`（与现有 `RAI_API_TOKEN` 同级），**不入库、不入仓**（沿用高德 Key 的既有纪律）
- **成本**：每周 1 次调用，可忽略；重点是超时与失败回退，不是省钱

---

## 4. 改动清单

### M0a — 契约 + 上表层（原 v1.1 的 11 项，不变）

契约 `MobileSessionStructure` → `mobile-coach.ts` 生成（interval：**距离制 800m**，`reps = clamp(4+floor(daysSinceLastQuality/5), 4, 8)`，疲劳闸门压到 4）→ `GET /v1/mobile/workout-plan` → iOS `WorkoutPlanMapper`（纯函数）+ `WorkoutKitBridge`（SDK，物理分离）→ 双皮肤入口 → web 渲染 + 文档同步。

### M0b — LLM 层（新增 6 项）

| # | 文件 | 改动 |
|---|---|---|
| 12 | `apps/api/src/weekly-plan-prompt.ts` | 提示词与输入装配 |
| 13 | `apps/api/src/weekly-plan-llm.ts` | provider 客户端（超时/重试/成本日志） |
| 14 | `apps/api/src/weekly-plan-validate.ts` | 🔴 **三道防线**（schema + 钳制 + 回退） |
| 15 | `packages/api-contracts/src/index.ts` | `weekPlan` schema 扩展（支持 `structure` + 审计字段） |
| 16 | `apps/api/src/server.ts` | `POST /v1/mobile/workout-plan/generate`（触发一次生成） |
| 17 | web / iOS UI | 「生成本周课表」按钮 + 生成结果预览与差异提示 |

🔴 注意：该 `POST` 是写操作 → **必须登记进** `server.ts:151-168` 的 `metadataOnlyMutationRoutes` 或 `databaseRequiredMutationRoutes`（与 M0a 的纯 GET 端点不同）。

---

## 5. 验收标准

| 层 | 验收 | 环境 |
|---|---|---|
| 契约 | `structure` 为可选字段，老读取方忽略不报错 | ✅ 沙箱 |
| 钳制器 | 单测覆盖：周量增幅 >30% 被压 · 质量课 >2 被降 · reps>8 被截 · 幻觉日期被拒 · 配速越界被钳 · 有 injuryFlags 时不排质量课 | ✅ 沙箱 |
| 回退 | 模拟 LLM 超时/非法 JSON → 输出等于启发式结果 | ✅ 沙箱 |
| 审计 | 生成后 `goals` 含 `generatedBy/model/promptVersion/generatedAt` | ✅ 沙箱 |
| 上表 | 一键同步后系统"体能训练"出现 RAI 专区、分段与提醒正确 | 🔴 真机 |
| 安全 | 密钥不在库/不在仓；日志不打印密钥 | ✅ 沙箱审查 |
| 回滚 | 全新增文件 + 1 GET + 1 POST + 可选字段，**无 schema 破坏、无数据迁移** | — |

---

## 6. 风险

| 风险 | 级 | 缓解 |
|---|---|---|
| LLM 给出激进计划伤身 | 🔴 | 防线 ②，阈值复用既有 `volume_ramp/qualitySessionCap` |
| LLM 幻觉日期/距离/配速 | 🔴 | 防线 ① 日期集合校验；② 配速区间钳制 |
| 不可复现、事后无法复盘 | 🔴 | 审计字段 + 原始输出留档 |
| 与手动编辑冲突 | 🟡 | 已有 revision 乐观锁（409）→ UI 提示"课表已更新，请重生成" |
| LLM 服务不可用 | 🟡 | 回退启发式，永不空课表 |
| 成本失控 | 🟢 | 每周 1 次 + token 上限 |
| 真机是唯一门禁 | 🔴 | 沙箱内 xcodebuild 必失败（宏插件 SIGKILL） |

---

## 7. 决策记录（2026-09-12 小唐确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 分批 | **一起做**（M0a + M0b 同批交付） |
| 2 | LLM provider | **先用 DeepSeek**，后期扩展 GPT 等（provider 抽象已就位） |
| 3 | 生成频率 | **每周一自动 + 手动重生成** |
| 4 | 钳制阈值 | **沿用现有值**（周量增幅 30%、质量课 ≤2） |
| 5 | 今天由闸门决定 | **接受**（LLM 不覆盖今天） |

---

## 8. 实现落点（as-built）

### 8.1 服务端

| 文件 | 内容 |
|---|---|
| `packages/api-contracts/src/index.ts` | `MobileSessionStructure` / `MobileWorkoutStep` / `MobileStepGoal` / `MobileStepAlert` / `MobilePlanAudit` / `MobileWorkoutPlanDay` / `MobileWorkoutPlanResponse` / `MobileWeeklyPlanGenerationResponse`；`MobileNextSession.structure`、`weekPlan: MobilePlannedDay[]`、`weekPlanAudit` |
| `apps/api/src/mobile-coach.ts` | `measureStructure`（权威度量）、`buildSessionStructure`（interval 距离制 800m）、`sessionRanges`（kind→zone 唯一来源）、`intervalReps` |
| `apps/api/src/session-structure.ts` | 结构归一化与边界（`MAX_BLOCK_ITERATIONS=20`、`MAX_BLOCKS=8` 等） |
| `apps/api/src/mobile-read.ts` | `assembleMobileWorkoutPlan`：今天来自闸门/锁定，未来来自持久化周计划；每天按自身结构重新度量 |
| `apps/api/src/mobile-goals.ts` | `weekPlanAudit` 持久化；**周计划 merge**（见 §8.4） |
| `apps/api/src/weekly-plan-{prompt,llm,validate,service}.ts` | 提示词 / provider 客户端 / 🔴 三道防线 / 编排与回退 |
| `apps/api/src/server.ts` | `GET /v1/mobile/workout-plan`（只读）、`POST /v1/mobile/workout-plan/generate`（已登记 `metadataOnlyMutationRoutes`）、周一自动生成定时器 |

### 8.2 iOS

| 文件 | 内容 |
|---|---|
| `APIModels.swift` | 上述契约的 Swift 侧 `Codable`（含 `MobileStepGoal` 的 union 手写编解码） |
| `WorkoutPlanMapper.swift` | 纯函数映射（**不 import WorkoutKit**）：设备侧再边界化 + `paceBounds`（配速→速度反演）+ `scheduleComponents` |
| `WorkoutKitBridge.swift` | 唯一 `import WorkoutKit` 处；`CustomWorkout` → `WorkoutScheduler`；**回读 `scheduledWorkouts` 验证** |
| `NativeAppModel.swift` | `refreshWorkoutPlan()` / `regenerateWeeklyPlan()` / `generationSummary`（说清是模型还是回退） |
| `NativeViews.swift` + `Skins/Technology/TechViews.swift` | **双皮肤**各自的「手表课表」面板：逐日分段摘要、生成本周课表、一键同步到手表 |

### 8.3 web / 文档

- `apps/web/src/ios/shared.tsx` 的 `structureSummary`（镜像 iOS 规则，仅展示层）+ `Home.tsx` 「分段」行。
- `docs/WEB_IMPLEMENTATION.md` 的移动端路由清单已同步两个端点与 `structure` 语义。

### 8.4 🔴 实现中发现并修掉的缺陷

**`PUT /v1/mobile/goals` 会把已生成的结构抹掉。**
根因：`normalizeWeekPlan` 是**全量替换**，而 iOS 的目标编辑器只携带 `localDate/kind/distanceKm`
（`MobileGoalsPlanItem`），于是任何一次「保存周里程」都会把 LLM 调好的 `structure`（含自定组数）
与 `reason` 清空；读侧只能按 kind 兜底重建——间歇会被重建成**最小 4 组**，与生成结果不一致。

修法（服务端 merge，对所有客户端生效）：同日期**同类型**的既有 `structure`/`reason` 会被继承；
类型改变则不带旧结构（由读侧按 kind 重建）；显式传空数组仍然清空。
覆盖用例：`apps/api/test/mobile.test.ts` → "a goals edit keeps the generated structure unless the session kind changes"。

### 8.5 本机可执行的验证

| 命令 | 覆盖 |
|---|---|
| `npm run typecheck` | 全仓 TS（含 web） |
| `node --import tsx --test packages/*/test/*.test.ts apps/api/test/*.test.ts` | 521 项（含 `weekly-plan.test.ts` 15 项钳制/回退/客户端） |
| `bash apps/ios/tests/run-model-tests.sh` | macOS 通道：模型层 + 坐标 + **44 项课表映射** |
| `bash apps/ios/tests/typecheck-ios.sh` | **新增**：沙箱内对 36 个 iOS 源文件做真实 `swiftc -typecheck`（含两个皮肤视图） |
| `npx vitest run test/ios-mobile-app.test.tsx`（apps/web） | iOS 壳渲染 + 新「分段」行 |

🔴 仍需真机：`WorkoutScheduler` 授权、系统「体能训练」中是否真的出现 RAI 专区、分段与提醒是否正确。
