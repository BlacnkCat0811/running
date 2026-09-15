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

> 🔴 **2026-09-15 17:00 修订**：本节原文把 A（Apple 真实 lap/segment）排在 B 之前，理由是"A 是**测量**、
> B 是**回放**"。**这条理由被实测证伪**，顺序已对调：B 第一、A 只作兜底。证据与处置见
> [§4.1](#41-修正10-段是错的切分粒度选错了来源2026-09-15)。

- **B｜课表结构反推**：把 `structure` 回放到实测 RunningSpeed 上。面板标题是「课表分段」，
  它欠读者的是**处方的步骤 + 实测数字**，所以 B 是主来源。**小唐的用法还决定了 B 不可省**——
  他同步的是**明天**的课表、当天就打开跑，`按 run 本地日期匹配课表必然指向休息日`。
- **A｜Apple 真实 lap/segment**：仅当**没有任何课表可解释这次跑步**时兜底（`第 N 段` + note），
  因为对这批导出而言它是手表**计圈设置**的产物，不是处方的步骤。
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
| `apps/api/src/workout-segments.ts`（新） | 纯逻辑：`eventBoundariesOf` / `layoutStructure` / `matchPlanDay` / `assemblePlanCandidates` / `resolveSegmentation` / `toWorkoutSegments` |
| `apps/api/src/mobile-goals.ts` | 新增 `mobile_plan_pushes` 表 + `planHistory()` / `recordPlanPush()` / `planPushes()` |
| `apps/api/src/data.ts` | `workoutSeries(id, candidates)`；`segmentRun()` 串起 B→A→明示原因 |
| `apps/api/src/server.ts` | 候选装配 `planSegmentCandidates()`（委派给纯函数 `assemblePlanCandidates`）；`POST /v1/mobile/workout-plan/synced`；登记 `metadataOnlyMutationRoutes` |
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
| 2 | `GET /v1/workouts/training_session_7762eea67980ce682d51e79bf5592358/series` | ✅ 200、`segmentPlan.matchedBy="plan_history"`；⚠️ **10 段与 `revision=3` 都是错的，见 §4.1** |

⚠️ **实测是 10 段，且这 10 段是错的 —— 见 §4.1。**

### 4.1 修正：「10 段」是错的，切分粒度选错了来源（2026-09-15）

小唐的反馈：`课表分段显示有10段分段，正常不应该有那么多，5分钟热身，2.6km的训练，5分钟的放松，剩下的都是自由训练，讲道理应该是这样4段`。

**先撤回上一版结论。** 上一版把 10 段解释成「Apple App 的聚合口径 vs HealthKit 原始记录，两者不矛盾」——
**这个解释是错的**：原始记录里根本没有课表步骤的边界，所以拿它切分不是"更细"，是"错源"。

#### 根因 1：11 个事件是**两套互相重叠、各自完整覆盖全程**的计圈划分

把 11 个 `HKWorkoutEventTypeSegment` 的 `duration` 当作"本段到哪结束"来还原，得到两条**自洽**的链条：

| 链 | 边界（偏移 s） | 各段距离 | 判读 |
|---|---|---|---|
| P7（7 段） | 0 / 381 / 760 / 1137 / 1521 / 1914 / 2328 / 2348 | 986 / 999 / 1008 / 989 / 1007 / 1005 / 57 m | **每 1 km 自动计圈** |
| P4（4 段） | 0 / 615 / 1223 / 1841 / 2348 | 1602 / 1612 / 1597 / 1240 m | **每 1.6 km 自动计圈** |

两条链各自的 `duration` 加总都精确等于全程 2348.4 s ⇒ 它们不是嵌套，是**同一段跑步的两套计圈设置**。
`eventBoundariesOf` 取两者并集 ⇒ 10 个内部边界 ⇒ 10 段。

#### 根因 2：这批事件与**课表无关**（决定性证据）

- 09-09、09-10 两次跑步**早于任何课表存在**（`mobile_goals_history` rev1 是 09-11 才写入），
  它们的 11 个事件却是**同一形态** ⇒ 事件来自手表侧，不可能来自课表。
- 课表步骤边界**不在事件集合里**：rev6 的 09-15 处方（热身 300 s / 训练 2600 m / 放松 300 s）
  回放到实测配速，步骤边界在 **300 s** 与 **≈1281 s**；10 个候选边界点里**一个都不是**。
- 库里 `HKWorkoutEventTypeLap` = **0 行** ⇒ 这两套计圈在导出里也标成 `Segment`，**光看类型名分不出计圈与步骤**。

⇒ 把 A 排在 B 之前，等于把「每公里分段」（面板下面**本来就有**）改个名叫「课表分段」。

#### 根因 3：选中的课表也是**过期的**（连带发现）

`segmentPlan` 当时是 `revision=3`（09-14 easy 2.4 km，work 目标 **1000 m**），
而小唐说的是「2.6km 的训练」——`work 2600 m` 只存在于 **rev6**（09-15 recovery 4.0 km / 09-19 easy 4.0 km）。

`planSegmentCandidates` 的洞：`rest` 日在 `seen` 判重**之前**就被 `continue` 掉，于是
**新版本把某天改成休息日时，遮蔽不了旧版本那天的课表**。rev4–6 已把 09-14 改成 rest，
rev3 的 09-14 easy 却活了下来，并在"同日优先"规则里胜出。

#### 处置

| # | 改动 | 位置 |
|---|---|---|
| ① | 权威顺序对调：**课表步骤为骨架**，事件仅在无课表可解释时兜底；删除「事件切分 + 课表贴标签」那条 lane | `workout-segments.ts` `resolveSegmentation` |
| ② | note 里写明被搁置的事件段数，避免"用了哪份记录"在手机上不可区分 | `workout-segments.ts` `eventFootnote` |
| ③ | **休息日也认领日期**（认领了就不产出候选） | `assemblePlanCandidates`（从 `server.ts` 抽出为纯函数） |
| ④ | 归因顺序调整：先判课表，再判事件 | `data.ts` `missingSegmentsNote` |
| ⑤ | 删除因此失效的 `dominantStep` | `workout-segments.ts` |

#### 验收标准

| 项 | 判据 | 结果 |
|---|---|---|
| 回归（真实事件） | 用 09-14 真实 11 事件 + rev6 处方 ⇒ **恰好 4 段**：[热身 773 / 训练 2600 / 整理放松 775 / 自由训练 1903] m，起始偏移 [0/300/1281/1581] s，note 含「手表另有 10 段 lap/segment 事件未参与分段」 | ✅ `workout-segments.test.ts` 用例 3 |
| 过期课表 | rev6(09-14=rest) + rev3(09-14=easy) ⇒ 候选只剩 `09-15 recovery rev6`，匹配到 `work 2600 m` | ✅ 用例 4 |
| 优先级 | 回执 > 锁定 > 最新版本；无 structure 的回执不入候选 | ✅ 用例 5 |
| 旧行为 | 课表步骤与 lap 对齐时仍得 4 段（不再依赖 lap） | ✅ 用例 2 |
| 类型 / Node / Web | `npm run typecheck`；`npm test`（**api 590 pass / 0 fail / 4 skip**；**web 84 pass**） | ✅ |

#### 回滚

`git revert <本次提交>` + `systemctl restart rai-api`（API 侧 tsx 直跑，无需 build）。无 schema、无数据变更。

#### 仍未定性的 🟡（不阻塞本次修复）——2026-09-15 17:30 复查后的结论

**"一次手表训练为何导出两套计圈"。已排除的（每条都有判据）：**

| 假设 | 判据 | 结论 |
|---|---|---|
| 库里有两条源 workout 被合并 | workout id = `hash(activityType, sourceName, syncId)`（`apple-health-parser.ts:186-194`），syncId 回落值 = `workout.uuid`（`HealthKitExport.swift:595-599`，本次数据里 `HKMetadataKeySyncIdentifier` 与 `RAIHealthKitWorkoutUUID` 同值 ⇒ 走回落）⇒ **两条 workout 必然两行**；实测各 canonical 组只有 **1 行** | ❌ 排除 |
| 导出器把事件枚举了两遍 | `workoutEventXML` 只迭代一次 `workout.workoutEvents`（`HealthKitExport.swift:306-318`） | ❌ 排除 |
| App 读/写了 `workoutActivities` | 全 `apps/ios` 无 `workoutActivities` / `HKWorkoutBuilder` / `HKWorkoutSession` 调用，只有 WorkoutKit **排期** | ❌ 排除 |
| 事件来自 parser 折叠 `<WorkoutActivity>` | **前提不成立**：这份 `export.xml` 是**我们自己的 App 合成**的（`HealthKitExport.swift:263`），**根本不写 `<WorkoutActivity>`** ⇒ 该假设只适用于 Apple 健康 App 的官方导出，与本链路无关 | ❌ 排除（**上午写的"第一嫌疑"已作废**） |
| 一套是课表步骤 | 处方步骤边界（300 s / ≈1281 s）不在 10 个候选边界点里；P7≈1 km、P4≈1.6 km 都与 3 步处方不符 | ❌ 排除 |

**⇒ 结论：这 11 个事件是 `HKWorkout.workoutEvents` 的原样内容**（导出器与解析器都只是忠实搬运），
两套重叠划分是 **HealthKit 侧的事实**，不是我们代码造的。🔴 **因此它不在我们可改的代码里，
判决点只能在手机上读 HealthKit。**

**🔴 而且复查发现一个比这个谜题更值钱的东西**：`HKWorkoutActivity` **不产生 `WorkoutEvent`** ——
一个 activity 只有 `startDate` / `duration` / `workoutConfiguration`。而 Fitness App 能显示那 4 段
（热身 788 m / 训练 2600 m / 整理放松 773 m / 自由训练 1.89 km ≈ 处方的 3 步 + 自由段），
说明**步骤结构很可能就活在 `workout.workoutActivities` 里，而我们从来没有导出过它**。
⇒ 若成立，「课表分段」可以从**按课表回放到实测配速的推算**升级为**实测边界**（真正的测量），
也不再依赖课表历史。**排查方案见 `.workbuddy/memory/NOTES-mobile-plan.md` 的同名小节（L0–L3 四级）。**

##### L2 已实施（2026-09-15 17:30，commit `810acd4`）：等一次真实同步

`HealthKitExport.swift` 新增一次性诊断，在 `workoutXML`（`:277`）里多发一条元数据
`RAIWorkoutStructureDiagV1`，内容为：

| 字段 | 说明 |
|---|---|
| `activityCount` / `activities[]` | 每个 activity 的 `uuid`、`startMs`、`durationMs`、`activityTypeRaw`、`locationRaw`、`metadataKeys`、**该 activity 自己的 `events[]`** |
| `eventCount` / `events[]` | 顶层事件的 `type` / `typeRaw` / `startMs` / `durationMs` / `metadataKeys` |

**偏移一律是相对 workout 起点的毫秒**，可以直接与处方边界（`start+300 s`、`start+≈1281 s`）比，不需要解析日期。
载体是普通 `<MetadataEntry>` ⇒ **不需要改契约、parser、schema**，直接落进 `workouts.metadata_json`。

两条设计约束（都踩过）：

- 🔴 **必须门控**（`guard !events.isEmpty || !activities.isEmpty`）：该 entry 计入 workout 的 content hash
  （`apple-health-parser.ts:413-415` 的 `stableId("workout_content", [...metadata...])`），
  无条件发会让**全部约 274 个 workout 在下次增量导入时被标 `updated` 逐行重写**。
- 🔴 活动身份属性在 Swift 里是 `activity.uuid`，**不是** `activity.UUID`（后者 Swift 3 已废弃；
  `typecheck-ios.sh` 会直接报 `'UUID' has been renamed to 'uuid'`）。

**判据（一发定论）**：读线上库的 `workouts.metadata_json`（命令见 `NOTES-mobile-plan.md` 同名小节，已实测能过 TAT；
⚠️ 要**双重 `JSON.parse`**——那个 key 的值本身是一个 JSON 字符串）。

| 观察 | 结论 | 后续动作 |
|---|---|---|
| `activityCount ≥ 2` 且某 activity 的 `events[]` 与两套链之一重合 | 两套计圈来自**两个 activity 层**，谜题闭合 | 把该 activity 的边界作为分段来源 |
| `activityCount = 1`，且其 `startMs/durationMs` 覆盖全程 | activities 不承载步骤 | 回放仍是上限，维持现状 |
| 任一 activity 的 `startMs` ≈ 300 000 / 1 281 000（ms） | **步骤可实测**，且 `HKWorkoutActivity` 确实是载体 | 把 activities 升级为分段主来源，摆脱课表历史依赖 |
| 全部 `metadataKeys` 里没有 `HKMetadataKeyLapLength` | 两套链都不是 watchOS 自动计圈标注的（该 key 按文档设在 `HKWorkout` 上，`HKMetadata.h:301`） | 缩小到「活动层各自划分」这一支 |

**生效前提（重要）**：诊断写进的是 **iOS 源码**，服务器 pull 到它**对手机没有任何作用**。
必须**重新 build + 安装到手机**，再触发一次**增量同步**才会出现。

增量同步会带上它，是因为 `runningWorkouts`（`:215-254`）在 `stored != nil` 时额外做了一次回填：
`backfillStart = (startDate ?? Date()) - routeBackfillWindow`，而 `routeBackfillWindow = 14 天`（`:80`）
⇒ 实际覆盖最近约 16 天 ⇒ **09-09 / 09-10 / 09-14 三次都在窗口内**，都会被重新读并发诊断。
若某个更早的 workout 需要诊断，用设置页的「**重新导入全部**」（`full: true` ⇒ anchor 与 lowerBound 都清空）
强制全量导出即可。

**小唐要做三步**（服务器侧已就绪，`/opt/rai` HEAD = `f4ac3eb`，`apps/ios/**` 是非运行时路径 ⇒ **无需重启**）：

1. Xcode 打开 **`RAI.xcworkspace`**（不是 xcodeproj）→ 在真机上 Run（重新 build + 安装）。
2. App 设置页点「**同步健康**」（`Settings.tsx:118`，`full: false` ⇒ 走增量，会带上诊断）。
3. 告诉我一声，我读 `workouts.metadata_json` 出判决（命令已预演通过，基线 `DIAG_ROWS 0`）。

判据就是上面那张表 —— 无论走哪一支都有结论，**不存在"跑完还是不知道"**。

**部署记录**：`00c0ccb → c1ecac7`（9 个提交）fast-forward → `npm run build`（`BUILD_EXIT=0`）
→ `systemctl restart rai-api`；部署前备份 `rai.manual.2026-09-15T06-33-15-371Z.f5f4fbb3.sqlite`（530 MB）。

**L2 那次部署（`e41379f → 810acd4 → f4ac3eb`）**：改动只有 `apps/ios/**` + `deliverables/**`（diff 实测），
属**非运行时路径** ⇒ 最小动作是**只 `git pull --ff-only`**，**不 build、不 restart、不做备份**
（不写数据、DIST 哈希不变、无新迁移）。线上核对：`HEAD=f4ac3eb`、工作树仅 `.npm/`/`.npmrc` 噪声、
`/v1/health` 无 token **401** / 带 token **200** + `databaseReady:true`。
🔴 但要讲清：**这次 deploy 对手机是 no-op** —— 见上面的「生效前提」。

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

- **B 优先于 A 的代价**：手表自己记下的间歇结构（若真有）会被课表骨架覆盖。**判据是**：只有
  `HKWorkoutEventTypeSegment` 落在课表步骤边界上时才算"真有"，而 09-14/09-09/09-10 三次全部落在
  计圈点上 ⇒ 这批数据里 A 不含步骤信息。若将来遇到 A 与 B 步骤边界吻合的样本，再考虑恢复"事件优先"。
- 相邻日匹配（规则 3）是启发式：无回执时可能给段贴上**别的日子**的标签。数字仍来自实测；`segmentPlan.reason`
  会写明「按课表结构回放」，`matchedBy` 也会透出。**根治靠回执**，即规则 1。
- `MIN_SEGMENT_MS = 5 s`：< 5 s 的边界当噪声丢弃（HealthKit 事件时间戳本身不精确）。
- 回执覆盖**整周可执行日**而非单日：手表上表的就是整周，跑哪一天由 36 小时窗口决定。
- 🟡 一次训练导出两套计圈的成因仍未定性（见 §4.1 末）。**不影响分段正确性**，但会让
  `eventBoundariesOf` 产出的段数偏多——只在无课表兜底时可见。
