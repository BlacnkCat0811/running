# 未提交改动审查（2026-09-13）

审查对象：工作区 **68 项变更** —— 50 个已跟踪文件（+2600 / −168）+ 18 个未跟踪文件（其中 `weekly-plan-*` / `session-structure` / `WorkoutPlanMapper` / `WorkoutKitBridge` 约 2800 行）。
改动主体分三层叠加：① 周课表 LLM 生成器 → WorkoutKit 上表（09-12 在途工作，已在 `UNCOMMITTED_REVIEW_2026-09-12.md` 审过一次并修复 5 项）；② 09-13 的 13 项优化修复 + 4 项回归（`deliverables/FIXES_2026-09-13.md`）；③ 工程化交付（`deploy/upgrade.sh`、v21 迁移、`typecheck-ios.sh`）。

方法：逐文件读 diff → 核对路由登记 / 持久化 / 契约 → **实测验证可疑点（不只看码）** → 跑全量门禁。
所有结论都落到 `文件:行号` 或命令输出；性能类结论用 `EXPLAIN QUERY PLAN`，数值类结论用临时探针（跑完即删）。

---

## 一、结论摘要

| # | 级别 | 结论 | 证据 |
|---|---|---|---|
| 1 | 🔴 必修 | goals 编辑器写入的 `distanceKm` 会被保留，而同日的 `structure` 沿用旧值 ⇒ **同一天出现两个距离**（`/v1/mobile/today` 与 `/v1/mobile/workout-plan` 各说一个数，同屏并列） | `mobile-goals.ts:327,330-333`；`mobile-coach.ts:965`；`mobile-read.ts:355-363`；实测 7km vs 9.7km |
| 2 | 🟡 待决策 | 服务端 LLM 总预算 **50s** > iOS POST 超时 **45s**，注释却断言"客户端 60s"；慢模型下客户端先超时、服务端随后照常落库 | `weekly-plan-llm.ts:36-48` vs `APIClient.swift:68,213` |
| 3 | 🟡 待决策 | 回退模板**会**超出自己的上限，与注释"can land exactly on the ceiling and does not"相反 | `weekly-plan-validate.ts:79-81,467-493`；实测 4/4 组全部 over |
| 4 | 🟡 待决策 | 降级（demoteToEasy）日落库未取整浮点：`7.838461538461538`，同批其它日是 `7.8` | `weekly-plan-validate.ts:198-205` |
| 5 | 🟡 待决策 | 两个新端点未登记进 OpenAPI（相邻 mobile 端点都登记了） | `schemas.ts:602-620` |
| 6 | 🔡 清理 | `NativeHeartRateChart` 的 tech 分支仍内联硬编码色值；回退测试容忍度 0.5km（LLM 路径 0.05km） | `NativeHeartRateChart.swift:12-17`；`weekly-plan.test.ts:667` |
| 7 | 🔡 顺带 | **（非本轮引入）** 目标编辑器的"稳态跑/steady"是死选项，保存必 400 | `NativeViews.swift:1740`（HEAD 已有）；实测 `kind=steady → HTTP 400` |
| 8 | 🔡 顺带 | `deploy/upgrade.sh` 三处小问题：缺 token 时静默退出、`--help` 打印代码、dry-run 的 lockfile 判断有误导 | `:69`、`:26`、`:88-99` |
| 9 | ✅ 通过 | 路由登记、埋点接线、ramp 下限、measureStructure 三处反推、读回 normalize、常量同源、v21 索引、双皮肤、Web 六项修复、iOS 编译级验证 | 见 §四 |

> **验证基线（全绿）**：`npm run typecheck` EXIT=0 ｜ `npm test` EXIT=0（node:test **538 / 534 pass / 0 fail / 4 skip** + vitest **12 文件 / 81 pass**）｜ `npm run build` EXIT=0（11.68s）｜ `typecheck-ios.sh` EXIT=0（**36 文件 0 error**）｜ `run-model-tests.sh` EXIT=0。
> 唯一缺口：`npm run test:e2e:web` 本机不可运行（`/Applications` 无 Chrome/Edge/Chromium，已核实）。

**一句话**：这一轮把 09-12 指出的两类问题（距离不由结构反推、ramp 未接线）在**生成器路径**上真正堵死了，并且做得干净——三处生产者都过 `measureStructure`、ramp 下限带着"必须生效"的反向断言、迁移索引有 EXPLAIN 背书。
**但同一条铁律在第四个生产者——goals 编辑器的 merge 路径——上没有守住**（#1），而且是**唯一会同时出现在同一屏上的两个数字**；这条不是这一轮引入的，但这一轮的 `normalizeWeekPlan` 改动把它从"偶尔不一致"变成了"结构性保留不一致"。

---

## 二、🔴 必修

### 2.1 goals 编辑器的 merge 让同一天有两个距离

`PUT /v1/mobile/goals` 的 `weekPlan` 是 merge 语义。`normalizeWeekPlan(value, previous)` 的两半来自不同来源：

```ts
// apps/api/src/mobile-goals.ts:324-335
const day: MobilePlannedDay = {
  localDate: item.localDate,
  kind: item.kind,
  distanceKm: distance == null ? null : Math.min(MAX_PLANNED_DISTANCE_KM, Math.max(0, distance))  // :327 ← 客户端
};
const prior = previous.find((entry) => entry.localDate === item.localDate && entry.kind === item.kind);
const structure = normalizeSessionStructure(item.structure) ?? prior?.structure ?? null;            // :332 ← 旧结构
```

两条读路径随后各取一半，于是**同一天有两个数**：

| 读路径 | 取哪个 | 行号 |
|---|---|---|
| `GET /v1/mobile/today` → `weekPlan[].distanceKm` | `saved.distanceKm`（编辑器写的） | `mobile-coach.ts:965` |
| `GET /v1/mobile/workout-plan` → `days[].distanceKm` | 由 `structure` 反推 | `mobile-read.ts:355-363` |

**实测复现**（临时探针，已删除；存 6×800m 结构 + 客户端写 7km）：

```
stored structure 6x800m measures        = 9.723km -> roundKm 9.7
/v1/mobile/today  -> buildWeekPlan uses = 7km    (mobile-coach.ts:965)
/v1/mobile/workout-plan re-measures     = 9.7km  (mobile-read.ts:363)
divergence = 2.7km (39%)
```

对照：同形状走**生成器**路径时 `stored=4.8 measured=4.8 drift=0.0000` —— 说明 #1 不是"哪里算错"，而是 merge 路径刻意没做反推。

**用户可达**：目标编辑器有逐日距离输入框与类型 Picker（`NativeViews.swift:1724-1744`），保存时把编辑后的距离连同 `structure` 一起提交（`NativeViews.swift:1797-1801`）。而本轮新增的 `workoutPlanPanel()` 与既有的 `weekPanel()` **在同一屏**（`NativeViews.swift:150-153`）⇒ 同屏两个数字。

**旧数据也不自愈**：09-12 之前落库的 plan 存的是 LLM 自称距离（上一轮 🔴#1）。`readControlGoals` 只做 normalize、不重测（`mobile-goals.ts:256`），`normalizeWeekPlan(..., [])` 也不会修正 ⇒ 这批行会**永久**保持矛盾，只有重新生成才消失。

**为什么算必修**：`structure` 是手表真正执行的处方（WorkoutKit 上表走 `structure`），`distanceKm` 是用户看到的数。二者分裂正是上一轮立下的"铁律"要防的事；而且这次是同屏并列，无法用"两个页面口径不同"解释。

**修法（两者都要，缺一有缝）**：
- **A（读侧统一，推荐先做）**：`buildWeekPlan` 对有 `structure` 的计划日也改成结构反推，与 `assembleMobileWorkoutPlan` 同源。口径统一为"结构即真相"。
- **B（写侧归一）**：`normalizeWeekPlan` 在沿用旧 `structure` 时，用结构反推值覆盖 `distanceKm`（需要把 `prescription` 传进 store，侵入更大，但能一次性把旧数据拉正）。

**验收标准**：写入 `{localDate, kind:"interval", distanceKm:7}`（旧结构 6×800m）后，
① `/v1/mobile/today` 与 `/v1/mobile/workout-plan` 对同一天返回**相同** `distanceKm`；
② 该值等于 `measureStructure(structure, kind, pacesFromZones(prescription))`（±0.1km）；
③ 新增回归用例锁死这一点（可放在 `mobile.test.ts` 的 `workout plan re-measures every day` 旁）。

**回滚**：`git checkout -- apps/api/src/mobile-coach.ts apps/api/src/mobile-goals.ts apps/api/test/mobile.test.ts`（A 方案只动 `mobile-coach.ts`；B 方案另动 `mobile-goals.ts` + 两处调用点）。**无迁移、无破坏性契约变更。**

---

## 三、🟡 待决策

### 3.1 服务端 LLM 预算（50s）超过 iOS POST 超时（45s）

`weekly-plan-llm.ts` 的注释把自己的不变量写得很清楚：

```
// weekly-plan-llm.ts:37-45
 * The generate endpoint waits on this request, and clients time out at 60 s, so
 * two full 45 s attempts would let the client give up while the server was still
 * working — and then persist a plan nobody saw. Staying under the client budget
 * keeps "the request failed" and "no plan was written" the same event.
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_TOTAL_BUDGET_MS = 50_000;
```

但真实客户端预算不是 60s：

```swift
// apps/ios/RAI/APIClient.swift:213
request.timeoutInterval = method == "GET" ? 15 : 45
// 配置默认值：APIClient.swift:68 timeoutIntervalForRequest = 15
```

`generateWeeklyPlan` 是 **POST** ⇒ 45s。而服务端**单次**尝试上限就是 `min(45_000, 50_000) = 45_000`，加连接/校验/落库开销必然超过客户端预算；重试一次可到 50s。
⇒ 慢模型下**客户端先报失败，服务端随后照常写入** —— 正是这段注释声称已经避免的场景。

**修法**：`DEFAULT_TIMEOUT_MS = 20_000` / `DEFAULT_TOTAL_BUDGET_MS = 35_000`（留 10s 给非 LLM 开销），或给该端点单独的 iOS 超时（60s）。两条都做最稳，并**订正注释**（把"客户端 60s"改成实测值）。

**验收标准**：把 `RAI_LLM_BASE_URL` 指向一个只挂起不返回的地址，`POST /v1/mobile/workout-plan/generate` 应在 **40s 内**返回 200（走 heuristic 回退 + warnings），且客户端不出现 `.timedOut`。
**回滚**：`git checkout -- apps/api/src/weekly-plan-llm.ts`（改常量，无迁移）。

### 3.2 回退模板会超出自己的上限

`weekly-plan-validate.ts:79-81` 的注释断言回退模板不需要 ×1.05 容差：

```
 * Returned before `VOLUME_CEILING_TOLERANCE`: the validator needs the tolerance
 * because a model's per-day rounding can overshoot, while the deterministic
 * fallback can land exactly on the ceiling and does not.
```

**实测（4/4 组全部超）**：

| goal | prev | fallback total | ceiling | over? |
|---|---|---|---|---|
| 8 | – | 8.115 | 8.000 | ✅ 超 |
| 15 | – | 15.123 | 15.000 | ✅ 超 |
| 30 | – | 30.200 | 30.000 | ✅ 超 |
| 40 | 8 | 26.123 | 26.000 | ✅ 超 |

**根因**：`buildSessionStructure("easy", target)` 在 target 低于结构不可约下限时会回落到 `overhead + 1km`（实测 `target=2km → 2.5385km`），而 `minEasyKm`（2.5）与 `perEasyKm`（`roundKm`）用的是假设值，最后一天只吸收"向下"的残差（`:486-493`），不吸收这部分向上漂移。
量级 0.1–0.2km（≤0.8%），仍在 ×1.05 容差内，**不是数据风险**；但注释是**错的事实陈述**，且"回退模板绝不超过上限"这条被依赖的保证并不成立。

**修法**：把注释改成真话 + 给回退模板自己加一次收敛（例如按实测 `minEasyKm` 计算 `easyCount` 后，把最后一天的 `target` 收敛到 `ceiling - 已分配实测值`）。**验收**：上表 4 组用例改为 `total <= ceiling + 1e-6`（新增用例，不放松现有断言）。**回滚**：`git checkout -- apps/api/src/weekly-plan-validate.ts`。

### 3.3 降级日落库未取整浮点

`demoteToEasy` 把**原始** measured 值写进 `distanceKm`：

```ts
// apps/api/src/weekly-plan-validate.ts:196-205
const measured = measuredDay(day, prescription);
const target = measured && measured.distanceKm > 0 ? measured.distanceKm : day.distanceKm;
return { ..., distanceKm: target ?? null, structure: buildSessionStructure("easy", ...) };
```

实测（4 天 tempo、cap=2）：

```
2026-09-08 tempo  stored=7.8                   measured=7.8
2026-09-09 tempo  stored=7.8                   measured=7.8
2026-09-10 easy   stored=7.838461538461538     measured=7.8   ← 15 位小数
2026-09-11 easy   stored=7.838461538461538     measured=7.8   ← 15 位小数
```

它与 `roundKm`（`:66-67` 注释："Rounds to the 100 m the UI shows, so stored and measured values agree"）以及同文件其它出口（`:314`、`:221`）都不一致，且该值会经 `PUT goals` 持久化、被 `generationSummary` 求和展示。**修法**：`distanceKm: target == null ? null : roundKm(target)`。**验收**：新增断言"降级日的 `distanceKm` 小数位 ≤ 1 且 |stored − measured| ≤ 0.05"。

### 3.4 两个新端点未登记 OpenAPI

`schemas.ts:602-620` 登记了 `/v1/mobile/today|statistics|trends|goals|lock`，**没有** `/v1/mobile/workout-plan` 与 `/v1/mobile/workout-plan/generate`（`schemas.ts` 全文 grep 无匹配；`server.ts:586` 会把 `openapiDocument` 直接暴露在 `/v1/openapi.json`）。`MobileGoalsUpdate` 组件本身是复用 `mobileGoalsBodySchema` 的（`:569`），所以只是路径缺失。**修法**：补两条 `operation(...)`，generate 的 requestBody 指向 `mobileWeeklyPlanGenerateBodySchema`。**验收**：`schemas.test.ts` 加一条"每个已注册 mutation 路由都在 paths 里"的断言（可选）。

### 3.5 清理项

| 项 | 位置 | 说明 |
|---|---|---|
| tech 分支硬编码色值 | `NativeHeartRateChart.swift:12-17` | `labelAccent` 的 tech 分支仍是 `Color(red: 0.64, green: 0.40, blue: 0.53)`，建议进 `TechColor`（本轮目标就是"不硬编码单皮肤视觉"） |
| 回退测试容忍度偏松 | `weekly-plan.test.ts:667` | 容忍 0.5km，而 LLM 路径（`:599`）是 0.05km——同一条不变式松了 10 倍；总量断言（`:671`）兜住了，但建议收到 0.1km |
| `ensureWeeklyPlan` 的防御 | `server.ts:531-541` | 若 `weeklyPlanDates()` 返回空会写空数组（清空周计划）；`mobileLocalDate()` 实际不可能产出非法日期，属理论路径，可加一行守卫 |

---

## 四、✅ 通过项（明确列出，别只挑刺）

**路由与鉴权**
- `POST /v1/mobile/workout-plan/generate` 登记在 `metadataOnlyMutationRoutes`（`server.ts:157-161`）—— 50s 级 LLM 调用**不持主库写锁**；`GET /v1/mobile/workout-plan` 是只读 GET，不登记。
- **09-12 撤回的结论已被固化成回归**：`server-runtime.test.ts:609-618` 把 generate 加进"DB 缺失必须仍是 409"的端到端表。这正是我当时判错的那条（`read-store-manager.ts:45-48` 抛 `statusCode=409`，`api-error.ts:11-13` 采信）——现在有测试兜底了。

**距离/时长由结构反推（三处生产者全部守住，我逐个实测）**

| 生产者 | 行号 | 实测 |
|---|---|---|
| coach | `mobile-coach.ts:545-560` | 用例 `mobile-coach.test.ts` "reported distance and duration never contradict…" |
| LLM 校验 | `weekly-plan-validate.ts:308-314`（clamp 之后才测） | 模型自称 1km / 结构 6×800m → `stored=4.8 measured=4.8 drift=0.0000` |
| 回退模板 | `weekly-plan-validate.ts:449,503-507` | 6 天全 `|stored−measured| ≤ 0.05` |
| goal 编辑 merge | — | ❌ 唯一缺口，见 §2.1 |

**业务钳制的参数真的接线了**
- `previousWeekDistanceKm` 从 `server.ts:757` 传入，来源是 `data.ts:434-441` 新抽出的 `previousWeekDistanceKm(date)`，与 `mobileToday` 用同一个 `mobileWeekStart`（`data.ts:87-90`，周一为周首）⇒ 语义与旧代码一致、但 coach 与生成器**共用一个数**。ramp 30% 上限不再恒为 Infinity。
- `RAMP_BASE_FLOOR_FRACTION = 0.5 < 1/1.3 ≈ 0.769`（`weekly-plan-validate.ts:45-57` 的注释把交叉点算清楚了）。**并且有用例守住下限"必须生效"**：`weekly-plan.test.ts:625-647` 同时断言"≤ 有下限的上限"与"必须 > 无下限的上限"，不是空转断言。

**持久化与契约**
- 读回也 normalize：`mobile-goals.ts:243-261`；`mobile.test.ts` 有专门用例锁"缺 `weekPlanAudit` 必须读出 `null` 而不是 `undefined`"。
- 边界常量单点同源：`MAX_PLANNED_DISTANCE_KM` / `MAX_STEP_METERS` / `MAX_STEP_SECONDS` / `MAX_BLOCK_ITERATIONS` / `MAX_BLOCKS` / `MAX_ALERT_*` 都定义在 `session-structure.ts:22-33`，schema（`schemas.ts:5-12` 导入）与 store（`mobile-goals.ts:17`）共用 —— 上一轮记的 "80 vs 60" 不一致已消除。
- `weekPlanAudit` 落在 `payload_json` blob 里 ⇒ **零迁移**（`mobile-goals.ts:265-273`）。
- `structure` 是 iOS 侧 `Codable` 的 optional（`APIModels.swift:170-172`），旧服务端仍可解；TS 侧必填、所有构造点已补齐（typecheck 通过）。

**v21 迁移（EXPLAIN 实测，不是读码）**
- 两列都存在（`workout_routes.workout_id` `database.ts:154-167`、`workout_group_members.workout_id` `:217-223`），全仓无同名/同列既有索引（唯一 `idx_route_points_time` 与此无关）。
- 迁移前 → 迁移后：
  - `SEARCH wr EXISTS USING AUTOMATIC PARTIAL COVERING INDEX (workout_id=?)` → `SEARCH wr EXISTS USING COVERING INDEX idx_workout_routes_workout_point_count (workout_id=? AND point_count>?)`
  - `SCAN workout_group_members USING COVERING INDEX sqlite_autoindex_…` → `SEARCH workout_group_members USING INDEX idx_workout_group_members_workout (workout_id=?)`
- `workout-route-index-migration.test.ts` 含"删索引 + 删 version 记录 → 重放"的幂等验证。
- 🟡 小建议（非缺陷）：`workout_routes` 的索引做成了覆盖索引 `(workout_id, point_count)`，`workout_group_members` 的 `(workout_id)` 对 `SELECT group_id` 非覆盖；若要一致可改 `(workout_id, group_id)`。

**iOS**
- 双皮肤：`NativeHeartRateChart` 全部颜色/圆角改走 `@Environment(\.appSkin)`；两个皮肤各自实现 `workoutPlanPanel`/`planRow`，**没有**共享组件硬编码单皮肤视觉（事故 18067cb 的同型问题已消除）。
- `WorkoutPlanMapper` 的配速→速度反演方向正确（`paceBounds`：`slowest = 1000/max(pace)`），并且**设备侧二次边界**齐备（`maxBlocks/maxStepsPerBlock/maxIterations/maxStepMeters/maxAlertValue`）。
- `WorkoutKitBridge` 不信任 `schedule()` 的静默成功，回读 `scheduledWorkouts` 比对（`WorkoutKitBridge.swift:89-104`）；`skipped` 的加总不会重复计数；`removeAllWorkouts` 先清理再重排，避免手表上留下已撤销的处方。
- 取消语义修得对：`withRetry` 把 `CancellationError`/`URLError.cancelled` 直接抛出（不再退避重试）；`sync()` 用 `guard !Task.isCancelled` 取代形同虚设的 `try? Task.checkCancellation()`（且**没有**采纳"改成 `try`"那个会编译失败的建议——`sync()` 非 throwing）。
- `ServerSession.canonicalURL` 加 `nonisolated` 有据：`RAI.xcodeproj/project.pbxproj:381/428` 设了 `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`，而 `Keychain`（非隔离 enum）在 `Keychain.swift:59` 调它。
- 大包上传改 `withRetry(attempts: 1)` 合理（600s×3 ≈ 30 分钟超出后台窗口；失败时 ZIP 已持久化可恢复）。

**Web**
- Hook 顺序：`App()` 拆成外壳分流 + `BrowserApp()`，外壳读 `dataset.shell` 不再与 hooks 混排（`App.tsx:194-210`）。
- `ErrorBoundary` 用 `useNavigate` 是**安全**的：它挂在 `<BrowserRouter>` 内部（`main.tsx:34-37`），不会出现"回退 UI 自己崩"。
- `useRemote` 超时用**竞速**而非只 abort，且 `finally` 里 `clearTimeout` ⇒ 请求先完成时不会留下未处理的 rejection（新增用例正好覆盖这两点）。
- `GlobalTaskStatus` 隐藏时不轮询、`visibilitychange` 回前台补一次；`WorkoutsPage` effect 依赖改字符串；`DashboardPage` 补空态；`user select`/XHR 头未受影响。
- 新增单测都是真断言（`hooks.test.tsx` 2 例、`global-task-status.test.tsx` 1 例），不是渲染即通过。

**测试与工程化**
- `local-request-security.test.ts` 补了**此前完全没有覆盖**的 token 分支（含"query 参数不算凭据"、"`/v1read` 不被 token 网关拦截"、"带 token 但 origin 不可信仍 403"）。
- `production-runtime-smoke.mjs` 把随机端口改成 OS 分配的空闲端口，消除并行跑的偶发冲突。
- 4 个 skip 全部带原因且都是平台/环境条件（win32 ×3 + `context.skip` 运行时判定），不是掩盖失败。
- `deploy/upgrade.sh` 的骨架是对的：默认 dry-run、脏树前置检查（只查已跟踪文件，避开 `.npm/` 噪声）、**备份失败即 `exit 1`**、lockfile 变了才 `npm ci`、重启后校验 401/200 + `schema_migrations`；顺序与 `deploy/README-UBUNTU.md` 一致。

---

## 五、验证证据（本轮实跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| TS 类型 | `npm run typecheck` | ✅ EXIT=0（pure + full） |
| 全仓测试 | `npm test` | ✅ EXIT=0；node:test **538 / 534 pass / 0 fail / 4 skip**；vitest **12 文件 / 81 pass** |
| 构建 | `npm run build` | ✅ EXIT=0，`✓ built in 11.68s` |
| iOS 类型 | `bash apps/ios/tests/typecheck-ios.sh` | ✅ EXIT=0，**36 文件 / 0 error**（修复后，见 §七） |
| iOS 模型 | `bash apps/ios/tests/run-model-tests.sh` | ✅ EXIT=0（含 `WorkoutPlanMapperRegression`） |
| 浏览器 e2e | `npm run test:e2e:web` | ⚠️ **环境不可运行**：`/Applications` 无 Chrome/Edge/Chromium（已 `ls` 核实） |

> 与 `FIXES_2026-09-13.md` 的差异：该文档记 "535 pass / 3 skip"，本轮为 **534 / 4**。多的那一个 skip 来自 `context.skip`（运行时判定，如 junction / 进程身份探测），**非**新增失败。

---

## 六、修复顺序与验收

| 顺序 | 项 | 验收标准 | 回滚 |
|---|---|---|---|
| 1 | §2.1 读侧统一（A）+ 写侧归一（B） | 编辑器写 7km 后，两个端点同一天 `distanceKm` 相同且等于结构反推；新增回归用例 | `git checkout -- apps/api/src/mobile-coach.ts apps/api/src/mobile-goals.ts apps/api/test/*` |
| 2 | §3.1 LLM 预算降到客户端预算内 | hang 住模型时 `/generate` ≤ 40s 返回 200（回退） | `git checkout -- apps/api/src/weekly-plan-llm.ts` |
| 3 | §3.3 demoteToEasy 取整 | 降级日 `distanceKm` 小数位 ≤ 1 且 drift ≤ 0.05 | `git checkout -- apps/api/src/weekly-plan-validate.ts` |
| 4 | §3.2 回退模板收敛（或订正注释） | 4 组探针用例 `total ≤ ceiling + 1e-6` | 同上 |
| 5 | §3.4 OpenAPI 补两条路径 | `/v1/openapi.json` 含两个新路径 | `git checkout -- apps/api/src/schemas.ts` |
| 6 | §3.5 + §七 清理项 | — | — |

**全局回滚**：全部改动仍在工作区、**未提交**，逐文件 `git checkout -- <path>`；未跟踪文件直接删。
**本轮无 migration v21 之外的库结构变更；v21 只建索引不碰数据**，回退方式：
`DROP INDEX idx_workout_routes_workout_point_count; DROP INDEX idx_workout_group_members_workout;` + `DELETE FROM schema_migrations WHERE version = 21`。
**本轮未触碰** `/var/lib/rai`、线上库、任何备份；所有库操作都在 `/tmp` 副本上只读进行。

---

## 七、修复记录（本轮审查中发现并当场修掉的）

### 7.1 `apps/ios/tests/typecheck-ios.sh` —— 恢复 iOS 编译级验证通道

这不是业务代码，而是**验证门禁本身**，而它本轮整体失效（EXIT=1 / 203 error）。已查明根因并修好：

- **现象**：`swift-plugin-server ... produced malformed response`，集中在 `@Observable` 类；重跑 3 次（含 `dangerouslyDisableSandbox`）全部复现。
- **根因（实测）**：swift-driver 把插件服务包在 `sandbox-exec` 里，而本环境拒绝嵌套沙箱 —— 编译输出第一行就是
  `sandbox-exec: sandbox_apply: Operation not permitted`（**macOS 目标同样复现**，用最小 `@Observable` 样本可 3 秒验证）。
  因此"环境抖动、隔天自愈"的说法不准确：这是可复现的。
- **修法**：给 `swiftc` 加 `-disable-sandbox`（跳过这层包装）。加完后 **36 文件 0 error**。
- **顺带**：脚本在"一个源文件都没匹配到"时会**打印「通过」并退出 0**（只检查替身模块、零错误）。已在遍历前后各加一道 `[ ${#keep[@]} -eq 0 ]` / `[ ${#files[@]} -eq 0 ]` 守卫并 `exit 1`。
  > 守卫必须放在 `for file in "${files[@]}"` **之前**：bash 3.2 下空数组的 `"${files[@]}"` 会先抛 `unbound variable`，放在后面拦不住。
- **两条路径都实测**：正常路径 EXIT=0 + "iOS 类型检查通过"；空列表路径 EXIT=1 + 明确错误。
- **意义**：iOS 那 800 行改动（含双皮肤 `NativeViews/TechViews`、`WorkoutKitBridge`、`ServerSession.nonisolated`）从"未验证"变成**有编译级背书**。

---

## 八、清理项

- 临时探针（`apps/api/test/_probe_plan_invariants.mts`、`_probe_steady.mts`）与 `/tmp` 下所有临时文件**已删除**，工作区无残留。
- 工作区项数：审查开始 68（50 M + 18 ??）→ 结束 68（唯一差异是 §7.1 修好的 `typecheck-ios.sh`，它本就是未跟踪文件）。
- 提醒：`deliverables/` 下已有 4 份 09-10～09-13 的审查/修复文档，`docs/` 38 份。若继续叠加，建议按"结论 + 未闭环项"做一次归并，避免同一问题在多份文档里各写一遍。
