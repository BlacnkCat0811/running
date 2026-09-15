# 跑步分段：从「每公里」到「课表结构」v1

日期：2026-09-14 | 范围：`packages/storage-sqlite`、`packages/api-contracts`、`apps/api`、`apps/web`、`apps/ios`
触发：小唐用「一键同步到手表」的间歇课表跑了一次（6.0515 km / 2351 s），RAI 详情页仍只显示公里分段。

---

## 1. 根因：分段信息在链路四个环节断裂

| # | 断点 | 证据 | 本次处置 |
|---|---|---|---|
| ① | iOS 导出器**主动丢弃** lap/segment 事件 | `HealthKitExport.swift:320-334` 的 `eventTypeName` 只映射 pause/resume/motion\*，`default: nil` 把 `.lap/.segment/.marker` 丢掉 | ✅ 补三个 case（typecheck 通过） |
| ② | `workout_events` 表**只写不读** | 生产代码对该表零 `SELECT` | ✅ 新增 `workoutEventIntervals()` |
| ③ | PRD §11.10 要求的「暂停和分段事件」在 features/scoring 零引用 | — | ⏳ 未做（本次不涉及评分） |
| ④ | 服务端**没有「推送过哪份课表」的记录** | WorkoutKit 排期纯设备侧 | ✅ 新增 `POST /v1/mobile/workout-plan/synced` + `mobile_plan_pushes` |

**「Apple 不记分段」已被证伪**：`HKWorkout.h:112-121` 明写只有 `.lap` 与 `.segment` 支持非零 duration，
Apple 体能训练 App 的截图也正是这四段：热身 788 m / 训练 2600 m / 整理放松 773 m / 自由训练 1.89 km。

---

## 2. 方案 A（真实事件）与 B（课表反推）

- **A｜Apple 真实 lap/segment**：读 `workout_events` → 时间边界 → 按站内同一 speed track 测量。
  优先级最高，因为它是**测量**而非**回放**。
- **B｜课表结构反推**：把 `structure` 回放到实测 RunningSpeed 上。**小唐的用法决定了 B 不可省**——
  他同步的是**明天**的课表、当天就打开跑，`按 run 本地日期匹配课表必然指向休息日`。
- 两者都拿不到时，**明示原因**（`segmentNote`），公里分段保留为兜底，不静默。

### A 的时间语义（Apple 官方文档，非推测）

- **非零 duration**：`dateInterval.start` 是**段的起点**，`duration` 是段长 ⇒ `[start, start+duration]`。
- **零 duration（旧式 lap）**：`date` 标记段的**终点**，且「laps fill the entire workout completely」
  ⇒ 只取时间戳作边界，由调用方拼成区间。

> 依据：<https://developer.apple.com/documentation/healthkit/hkworkouteventtype/lap>（"newer lap events use
> the date interval to mark the start and the duration of the lap"）。

### B 的匹配规则（可解释，不赌）

`matchPlanDay` 的优先级与理由：

1. **36 小时内、早于本次跑步的推送回执** —— 唯一能覆盖「同步明天 → 今晚跑」的规则；
2. **同本地日的计划历史** —— 覆盖「第二天早上跑」与按计划日跑；
3. **前后一天的候选** —— 无回执时的同样用法。**仅限一天**，且要求该日计划距离 ≤ 本次跑量 ⇒ 该规则
   是**猜测**，所以它只负责给段贴标签：所有距离/配速/心率数字都从 track 实测，猜错只会贴错标签，
   不会凭空造出数字。

回放规则：`distance` 目标经 track 求时刻（所以 2600 m 段结束在**实际**跑完 2600 m 处），`time` 目标精确，
`open` 吸收余量。计划跑完后仍有剩余 ⇒ 单列一段 `unplanned`（小唐的「结束后又跑了一段」）。

---

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `apps/ios/RAI/HealthKitExport.swift` | `eventTypeName` 补 `.lap/.marker/.segment` |
| `packages/api-contracts/src/index.ts` | `WorkoutSegment` / `WorkoutSegmentPlanMatch`；`WorkoutSeriesResponse` 加 `segments` / `segmentPlan` / `segmentNote` |
| `packages/storage-sqlite/src/read/series-read-repository.ts` | 抽出共享 `speedTrack()`（原 `workoutSplits` 的构造逻辑原样搬家）；新增 `measureSegments()` 任意边界测量、`workoutEventIntervals()`；`StoredSeriesSession` 加 `canonicalWorkoutId` |
| `apps/api/src/workout-segments.ts`（新） | 纯逻辑：`eventBoundariesOf` / `layoutStructure` / `matchPlanDay` / `resolveSegmentation` / `toWorkoutSegments` |
| `apps/api/src/mobile-goals.ts` | 新增 `mobile_plan_pushes` 表 + `planHistory()` / `recordPlanPush()` / `planPushes()` |
| `apps/api/src/data.ts` | `workoutSeries(id, candidates)`；`segmentRun()` 串起 A→B→明示原因 |
| `apps/api/src/server.ts` | 候选装配 `planSegmentCandidates()`；`POST /v1/mobile/workout-plan/synced`；登记 `metadataOnlyMutationRoutes` |
| `apps/api/src/schemas.ts` | `mobilePlanSyncedBodySchema` + OpenAPI 路径 |
| `apps/web/src/pages/WorkoutDetailPage.tsx` | 新增「课表分段」面板，**置于公里分段之上**；`公里分段` 标题保留 |
| `apps/ios/RAI/{APIModels,APIClient,NativeAppModel,NativeViews,NativeFormat}.swift`、`Skins/Technology/TechViews.swift` | 双皮肤分段面板 + 同步成功后登记回执 |

**`workoutSplits` 输出逐值不变**：`data.test.ts` 的 4 个公里分段测试（含重叠、稀疏、跨设备、点样本）
全部保持绿色，重构只搬实现不动数值。

---

## 4. 验收标准（离机部分已达成）

| 项 | 判据 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ |
| Node 测试 | `node --import tsx --test packages/*/test/*.test.ts apps/api/test/*.test.ts` | ✅ 583（579 pass / 0 fail / 4 skip），基线 576 |
| Web 测试 | `npm test -w @rai/web` | ✅ 12 文件 / 81 通过 |
| 构建 | `npm run build` | ✅ |
| iOS 类型检查 | `bash apps/ios/tests/typecheck-ios.sh` | ✅ 36 文件 |
| 反推精度 | 单测断言四段 = 773/2600/775/1903 m、300/981/300/770 s | ✅ 与 Apple 截图误差 ≤2% |

**反推对拍（2026-09-14 那次真实训练）**

| 段 | 本方案重建 | Apple 体能训练 App | 误差 |
|---|---|---|---|
| 热身 5 min | 300 s / 773 m / 6'28" | 05:00 / 788 m / 6'20" | −1.9% |
| work 2600 m | 981 s / 2600 m / 6'17" | 16:23 / 2600 m / 6'18" | — |
| 整理放松 5 min | 300 s / 775 m / 6'27" | 05:00 / 773 m / 6'27" | +0.3% |
| 自由训练 | 770 s / 1903 m / 6'44" | 12:48 / 1890 m / 6'46" | +0.7% |

### 真机 / 线上验证（2026-09-15 14:35，两项均已完成）

| # | 判据 | 实测 |
|---|---|---|
| 1 | 新构建导出后库里是否出现 `HKWorkoutEventTypeSegment` | ✅ **33 行**（3 次结构化训练 × 11 个事件，集中在 09-09 / 09-10 / 09-14），另有 `Pause` 3 行、`Lap` **0** 行。`workout_13ba33ba21154357ec25f3ae7a621b77` 即 09-14 那次 |
| 2 | `GET /v1/workouts/training_session_7762eea67980ce682d51e79bf5592358/series` | ✅ 200，**10 段**、`segmentPlan.matchedBy="plan_history"`、`revision=3`、`explainedFraction=0.484` |

⚠️ **实测是 10 段，不是本节先前写的 4 段 —— 先前那个预期是错的。** 原因值得记下来：

上表的「四段」（热身 / work / 整理放松 / 自由训练）是 **Apple 体能训练 App 的展示口径**，
它把嵌套结构摊平了；而 HealthKit 里同一次跑步有 **11 个 `.segment` 事件**，且**互相嵌套/重叠**
（例如 `12:42:53` 同时存在 380.9 s 与 614.5 s 两个事件）。按"事件边界"切分自然得到 10 段。
两者不矛盾：一个是给人看的聚合，一个是原始记录。

`explainedFraction 0.484` 正是这种错位的量化 —— 只有约 **48%** 的路程落在课表步骤内，
其余如实标为「自由训练」，不编。实测分段：

```
热身 986m/381s  训练 616m/234s  整理放松 383m/145s  整理放松 1008m/377s
自由训练 ×6：221/86、768/298、829/320、178/73、1005/414、57/23
```

**两条 lane 都在线上验证到**：09-14 匹配上课表（出意图标签）；09-10 那次返回 10 段但
`segmentPlan=null` + note「…未匹配到课表」、标签回落为「第 N 段」
⇒ §2 那条「空面板必自述原因」的约束在线上成立。

**部署记录**：`00c0ccb → c1ecac7`（9 个提交）fast-forward → `npm run build`（`BUILD_EXIT=0`）
→ `systemctl restart rai-api`；部署前备份 `rai.manual.2026-09-15T06-33-15-371Z.f5f4fbb3.sqlite`（530 MB）。

🔴 **本次暴露的流程问题（比功能本身更值得记）**：iOS 已装新构建、而服务端仍是旧代码时，
客户端容错解码会把「**字段不存在**」渲染成和「**字段存在但为空**」完全一样的空态，
看起来像功能坏了。⇒ **排查顺序必须把"先查线上 HEAD"放在读代码之前**：
`git -C /opt/rai log --oneline -1` 一行就能排除这个分支。

---

## 5. 回滚方案

改动**不触碰** `data.ts` 的 schema 迁移：`mobile_plan_pushes` 是 `CREATE TABLE IF NOT EXISTS`，
落在**独立控制库**（`rai-control.sqlite`），删表或回滚代码都不影响主库与既有数据。

- 代码回滚：`git revert <commit>` + `systemctl restart rai-api`（API 侧 tsx 直跑，无需编译）。
- 前端回滚：只改 `apps/web` 时重新 `npm run build` 即可，不需要 restart。
- 唯一「只增不减」的数据是回执行；如需清空：
  `DELETE FROM mobile_plan_pushes`（**属数据变更，先取得小唐确认**）。
- 分段面板对旧响应是**容错解码**（Swift 用 `decodeIfPresent`，web 侧按契约要求字段）⇒ 端侧先升级、
  服务端后升级也不会崩。

---

## 6. 已知取舍

- 相邻日匹配（规则 3）是启发式：无回执时可能给段贴上**别的日子**的标签。数字仍来自实测；`segmentPlan.reason`
  会写明「按课表结构回放」，`matchedBy` 也会透出。**根治靠回执**，即规则 1。
- `MIN_SEGMENT_MS = 5 s`：< 5 s 的边界当噪声丢弃（HealthKit 事件时间戳本身不精确）。
- 回执覆盖**整周可执行日**而非单日：手表上表的就是整周，跑哪一天由 36 小时窗口决定。
