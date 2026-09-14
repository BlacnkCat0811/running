# RAI Apple Watch 方案 v1.1（课表上表版）

> 2026-09-11 · v1.0 多智能体讨论 → **v1.1 根据"课表无法一键写入官方体能训练"这一约束重构**
> 状态：**设计稿，未执行**。代码引用均经实测（文件:行号）。
> v1.0 的核心结论（数据链路复用 HealthKit）**仍然成立**，但产品形态与分期被 v1.1 取代。

---

## 0. 结论先行（v1.1 翻转点）

| 问题 | v1.0 判断 | **v1.1 修正判断** |
|---|---|---|
| 课表上表 | 未覆盖，WorkoutKit 被排在 M2 | 🔴 **这是核心需求，提到 M0**。Apple 有官方通道：**WorkoutKit** |
| 要不要开发 Watch App | M0 做镜像 companion | 🟢 **要"课表上表"就不需要自研 Watch app**——WorkoutKit 排期后，课表直接出现在**系统"体能训练" app** 里，带 RAI 图标与名字 |
| WorkoutKit 定位 | M2 远期可选 | **M0 主角**：iOS 端一个桥接模块即可交付 |

**一句话**：RAI 课表进不了官方体能训练，不是 Apple 不给路，是**从没接过 WorkoutKit**。而 RAI 现有课表结构（单段配速+心率区间处方）与 WorkoutKit 的表达能力**匹配度很高**——M0 只需在 iPhone 端加一个桥接层，零 Watch target、零 entitlements、零 Podfile 改动。

---

## 1. RAI 课表的实际形态（实测）

| 事实 | 证据 |
|---|---|
| 课表 = `MobileNextSession`，含 kind/title/reason/distanceKm/durationMinutes/**配速区间**/**心率区间** | `packages/api-contracts/src/index.ts:529-539` |
| kind 枚举：`rest / recovery / easy / long_run / tempo / interval` | 同上 `:483-489` |
| 课表由服务端教练逻辑生成（含闸门、锁定、周计划） | `apps/api/src/mobile-coach.ts:392-402`（session 构造器） |
| 已有**锁定今日课表**能力 | `POST /v1/mobile/lock`（`docs/WEB_IMPLEMENTATION.md:115`）、`MobileLockedSession`（`index.ts:615-620`） |
| 已有**整周计划**（localDate/kind/title/distanceKm/planned） | `MobileWeekPlanDay`（`index.ts:605-613`）、`buildWeekPlan`（`mobile-read.ts:263`） |
| 已有**三档配速/心率处方表**（easy / threshold / interval 各自的上下限） | `CoachZonePrescription`（`mobile-coach.ts:35-46`） |
| 🔴 **课表没有段落结构**：无 reps / work-recovery / blocks 字段 | `mobile-coach.ts:392-402` 单段构造，确认无区间组成 |

**推论**：`easy / recovery / long_run / tempo` 可以直接映射为官方课表；**`interval` 目前只能降级成"单段阈值跑"**，要真正的 4×800m 结构必须扩展契约（§4）。

---

## 2. WorkoutKit：官方唯一通道（实测能力边界）

来源：Apple WorkoutKit 文档（iOS 17+ / watchOS 10+）。

| 能力 | 事实 |
|---|---|
| 可排期到 Watch 的**官方体能训练** | ✅ `WorkoutScheduler.schedule(_:at:)`；计划出现在 Workout app 顶部**专属区，带你的 app 图标和名字** |
| 四种课型 | `CustomWorkout`（区间）/ `SingleGoalWorkout`（单目标）/ `PacerWorkout`（配速跑）/ `SwimBikeRunWorkout` |
| 授权 | `WorkoutScheduler.requestAuthorization()`——**独立授权**，不是 HealthKit 写权限 ✅ 不触碰 AGENTS.md "no HealthKit write" 红线 |
| 管理 | `scheduledWorkouts` / `markComplete(_:at:)` / `remove` / `removeAllWorkouts` / `maxAllowedScheduledWorkoutCount` |
| 一键打开 | `WorkoutPlan.openInWorkoutApp()` |
| 窗口 | 用户可见**未来 7 天 / 过去 7 天** |

**硬约束（决定方案的三个坑）**：
1. 🔴 **alert 只在 CustomWorkout 可用**；`SingleGoalWorkout` 没有提醒。→ 要配速/心率提醒，必须用 CustomWorkout。
2. 🔴 **每个 step 最多 1 个 alert**。→ 配速提醒和心率提醒**不能同时**出现在同一步，必须取舍或拆步。
3. 🟡 每步必须有 goal（time / distance / open）；游泳不支持 CustomWorkout；alert 类型限配速（平均/当前）、步频、功率、心率区间。

---

## 3. 分期（v1.1）

### M0 — 课表一键上表（只动 iPhone 端，**无 Watch target**）

1. **iOS 桥接模块** `apps/ios/RAI/WorkoutKitBridge.swift`：
   - 拉取 `MobileTodayResponse`（`weekPlan` + `nextSession`）+ zones 处方 → 映射为 WorkoutKit 计划；
   - 首次 `requestAuthorization()`，UI 明确告知"课表会出现在系统体能训练里"；
   - **「一键写入本周课表」**= 遍历 `weekPlan`（跳过 `rest` 与已完成日）逐个 `schedule(_:at:)`；
   - 「只写今天」= `nextSession` 单条 `openInWorkoutApp()` 预览或直接排期；
   - 回写完成状态：`scheduledWorkouts` / `markComplete` 与 RAI 的 `postRun` / `lock` 状态对齐。
2. **映射表**（v1 裁决）：

| RAI kind | WorkoutKit 课型 | 提醒 | 理由 |
|---|---|---|---|
| `easy` / `recovery` | CustomWorkout（warmup 开 + 单步 distance/time goal + cooldown 开） | 配速 或 心率（二选一，默认**配速**） | 需提醒 → 必须 CustomWorkout |
| `long_run` | 同上，goal=distance | 心率 | 长距离盯心率优于配速 |
| `tempo` | CustomWorkout，goal=distance + threshold 配速区间 | 配速 | 阈值跑配速是主指标 |
| `interval` | ⚠️ **降级为单步**（无段落可映射） | 配速 | 要真结构 → §4 |
| `rest` | 不排期 | — | — |

3. **明确不做**：写 HealthKit、自研 Watch target、Watch 评分、地图、双皮肤移植。

### M1 — 区间课表结构化 + Watch 镜像（可选）

- 契约扩展，让 `interval` 能表达 reps/blocks（见 §4）。
- 若需要"跑动中看到 RAI 的判决/能力/跑后裁决"，才引入自研 watchOS app（此时按 v1.0 的数据链路：数据仍走 HealthKit → iPhone 增量同步，不新增 ingestion）。

### M2 — 远期

WorkoutKit 与 RAI 训练计划的动态联动（按训练日自动重排）、Complication、跑力实时提示。

---

## 4. Interval 课表的缺口（P1，需你决策）

现状：`MobileNextSession` 只有单段处方 → "4×800m @ 配速X / 组间 90s" 无法表达。

- **(a) 扩契约**：`MobileNextSession` 增加 `structure?: { blocks: [{ iterations, steps: [{ purpose, goal, alert }] }] }`，同步改 `mobile-coach.ts` 生成逻辑、`api-contracts`、web 渲染。**收益**：interval 课表在官方 Workout app 里真正可执行、有分段提醒与语音播报。**成本**：服务端契约 + 教练逻辑改动，需回归 `apps/api/test/mobile.test.ts`。
- **(b) 不改契约**：interval 降级为单段阈值跑。**收益**：零成本。**代价**：interval 是最需要分段提醒的课型，降级等于没解决。

🧭 **我的裁决：做 (a)，但排在 M0 之后单独一次迭代**——理由：契约扩展是纯增量可选字段，对现有读取方零破坏；而 interval 降级的价值损失不可接受。

---

## 5. 合规与风险

| 风险 | 级 | 说明 / 缓解 |
|---|---|---|
| 触碰"不许 HealthKit write" | 🟢 | WorkoutKit 是独立授权（`WorkoutScheduler.requestAuthorization`），RAI 不调用任何 `HKHealthStore.save`。用户在官方 app 里跑的记录由**系统**写入 HealthKit，RAI 仍是只读 |
| 排期数量上限 | 🟡 | `maxAllowedScheduledWorkoutCount` 具体值需真机确认；>7 天的计划会被窗口裁掉 → **只排本周，每次刷新重排** |
| 完成状态回写不闭环 | 🟡 | `markComplete` / `scheduledWorkouts` 的真实行为需真机验证；RAI 侧必须容忍"系统说没完成" |
| 每步单 alert 导致提醒取舍 | 🟡 | 已按课型固定取舍（§3.2），并在 UI 说明 |
| 课程在 Watch 上不可见（未配对/未同步） | 🟡 | 排期后需 iPhone 与 Watch 同网同步；验收须真机 |
| 真机验收是唯一门禁 | 🔴 | 沙箱内 xcodebuild 必失败（宏插件 SIGKILL），WorkoutKit 必须在真机 + 真账号验证 |

**零污染验收**：M0 只新增 `WorkoutKitBridge.swift` + 少量 UI 入口，主 RAI target 无结构性改动；CI 现有 ios job 不受影响。

---

## 6. 待小唐确认（v1.1 更新）

1. ~~M0 纯镜像是否接受~~ → **已被课表需求取代**。新问题：M0 是否就定义为"课表一键上表"？
2. 配速 vs 心率提醒的取舍是否接受（每步只能一个 alert）？
3. interval 契约扩展（§4a）是否现在做，还是先上 M0 再迭代？
4. **需要"跑动中看 RAI 判决/评分"吗**？——需要才做自研 Watch app，否则整个 Watch target 都可以不做。
5. 付费开发者账号：WorkoutKit 不需要特殊权限，但真机验收需要能装 app 的账号环境。
