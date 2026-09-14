# 未提交改动审查（2026-09-13 · 第二轮 / R2）

审查对象：当前工作区 **72 项未提交变更**（51 个已跟踪 M + 21 个未跟踪 ??，+4001 / −232）。
定位：经 mtime 核对，**工作区自 15:04 起无新改动**，而 `deliverables/FIXES_2026-09-13-REVIEW.md` 落盘于 15:03。
⇒ 本轮的价值不在于"再挑一遍刺"，而在于 **对上一份修复自述做独立复核**：承认它做对的部分，并找出它没看见的部分。

方法：逐层读 diff → **独立探针复现（不采信自述）** → **突变验证守卫** → 跑全部门禁。
所有结论落到 `文件:行号` 或命令输出；数值结论一律临时探针实测（跑完即删，工作区零残留）。

---

## 一、结论摘要

| # | 级别 | 结论 | 证据 |
|---|---|---|---|
| 1 | 🔴 **必修** | `PUT /v1/mobile/goals` 与 `POST /v1/mobile/lock` **信任客户端直供的 `structure`**，而距离由该结构反推、**无总量钳制** ⇒ 可写入单日 **2000km**（声称上限 80km），且该课会经 `/v1/mobile/workout-plan` **上表到手表**。**本轮新引入**（HEAD 版硬钳 `Math.min(80,…)` 且不收 structure） | 探针实测 `落库 distanceKm = 2000`；`mobile-goals.ts:453-454`、`:558`；`session-structure.ts:28-33`；HEAD 对照见 §二 |
| 2 | ✅ 已闭环 | 上一轮 🔴#1（goals merge 让同一天两个距离）**已修且接线完整**：写侧与读侧都改为结构反推 | `mobile-goals.ts:453-454`；`mobile-coach.ts:1000-1007`；`server.ts:880/823/866` |
| 3 | ✅ 已闭环 | 上一轮 🟡#1（LLM 预算 50s > 客户端 45s）改用**跨语言常量断言**解决，且实测是**真守卫**（突变即红） | `APIClient.swift:68/80/134`；`weekly-plan.test.ts:770-823`；突变 60→40 精确命中 |
| 4 | ✅ 已闭环 | 上一轮 🟡#2（回退模板超自己 ceiling）**已修**：7 组探针全部装下（含上轮 4/4 全超那 4 组） | 探针输出 §四 |
| 5 | ✅ 已闭环 | 上一轮 🟡#3（`demoteToEasy` 落库未取整浮点）已修 | `weekly-plan-validate.ts:216-220` |
| 6 | ✅ 已闭环 | 上一轮 🟡#4（两个新端点未进 OpenAPI）已补 | `schemas.ts:621/624` |
| 7 | ✅ 已闭环 | 上一轮 🔡（`NativeHeartRateChart` 硬编码单皮肤色）已全量走皮肤分流 | `NativeHeartRateChart.swift:12-19` |
| 8 | ✅ 已验证 | `FIXES-REVIEW` 声称的 **3 条 P0 经独立复现全部成立**，数字与自述逐位一致 | 探针输出 §四 |
| 9 | ✅ 已验证 | 新发现的 `addHook` 守卫**修复真实有效**（突变载荷被精确捕获，非空转） | `schemas.test.ts:454-467`；突变见 §四 |
| 10 | 🟡 待决策 | `MAX_PLANNED_DISTANCE_KM` 的注释宣称"schema / goals store / validator 三方同守"，**实现不含 goals store** —— 修 #1 时一并订正注释 | `session-structure.ts:28-33` |
| 11 | 🟡 已知 | 退化区（上限低于最短 easy）不收敛：已登记且**文案诚实**，不谎称合规 | `weekly-plan-validate.ts:613-618/685-697` |
| 12 | ⚠️ 环境 | `test:e2e:web` 本机不可运行（10 fail / 1 skip，原因＝无 Chrome/Edge） | 日志原文见 §五 |

**一句话**：上一轮的红队结论**基本被自己兑现了**——我复现的 3 条 P0、外加 4 条 🟡/🔡 全部真修，且跨语言常量守卫与 `addHook` 守卫经突变验证都不是装饰。
**但这一轮的修法本身带出一个新缺口**：#1 把"距离由结构反推"从生成器一路推进到 goals store，却在最后一个入口**只信任结构、不钳结构**——HEAD 时代 `Math.min(80, …)` 的那道闸门，在重写中消失了。

---

## 二、🔴 必修 —— 客户端直供的结构绕过单日上限

### 2.1 现象与复现

临时探针（`_probe_goals.mts`，已删）直接调用存储层公开 API `MobileGoalsStore.write`：

```
单日上限 MAX_PLANNED_DISTANCE_KM = 80km
客户端送入 distanceKm             = 5km
落库 distanceKm                  = 2000km
落库 structure                    = {"warmup":null,"blocks":[{"iterations":20,"steps":[{"purpose":"work",
                                     "goal":{"type":"distance","meters":100000},"alert":null}],"cooldown":null}]
>>> 绕过成立：落库值 2000 超过 80 上限
```

同一个 `write` 入口里，`distanceKm` 的清洗是**正确**的（`Math.min(MAX_PLANNED_DISTANCE_KM, …)`，`mobile-goals.ts:406-408`），但该值随后被结构反推**覆盖**。

### 2.2 代码路径

```ts
// apps/api/src/mobile-goals.ts:431-462
const trustedStructure = staleEcho ? null : suppliedStructure;   // :431 ← 客户端直供结构被信任
const stored = trustedStructure ?? (rebuildAtHint ? null : (prior?.structure ?? null));  // :441
const structure = stored ?? (prescription !== undefined && item.kind !== "rest"
  ? buildSessionStructure(item.kind, prescription, { targetDistanceKm: clientDistance }) : null);  // :445-449

if (item.kind === "rest") distanceKm = null;
else if (prescription !== undefined && structure != null) {
  distanceKm = roundKm(measureStructure(structure, item.kind, pacesFromZones(prescription)).distanceKm);  // :454 ← 反推，无上限
}
```

**同源的第二处入口**（lock）：

```ts
// apps/api/src/mobile-goals.ts:558
structure: normalizeSessionStructure(value.session.structure)   // 同样只做形状清洗，不做总量钳制
```
而 `resolveLockedNextSession` 也按结构反推（`mobile-coach.ts:1042-1053`）⇒ `/v1/mobile/today` 的 `nextSession` 会照单全收。

### 2.3 为什么 schema 拦不住

单步边界**都在**，但 schema 无法表达"总距离 ≤ 80"：

| 约束 | 位置 | 值 |
|---|---|---|
| 单步距离 | `schemas.ts:158` | `maximum: MAX_STEP_METERS` = 100 000 m |
| 单块组数 | `schemas.ts:203` | `maximum: MAX_BLOCK_ITERATIONS` = 20 |
| 块数 | `schemas.ts:197` | `maxItems: MAX_BLOCKS` = 8 |
| 单日 `distanceKm` | `schemas.ts:219` | `maximum: MAX_PLANNED_DISTANCE_KM` = 80 ✅ 但**被反推值覆盖** |

1 块 × 20 组 × 100 km = **2000 km**，全部字段合法 ⇒ 通过 schema。理论上限为 8 × 20 × 8 × 100 km。

### 2.4 可达性（不是纸上路径）

- iOS 客户端**确实携带 `structure` 回传**：`MobileGoalsPlanItem.structure`（`APIModels.swift:573`），注释自述「carried through unchanged on save」。
- 于是正常客户端不会主动构造巨结构 —— **但这是服务端唯一信任客户端结构的地方，且它决定的不是"显示什么"，而是"手表执行什么"**。
- 上表路径：`assembleMobileWorkoutPlan` 对未过期的存量日设 `executable: numbers.structure != null && kind !== "rest"`（`mobile-read.ts:351`）⇒ 2000 km 结构 `executable=true` ⇒ 交给 `WorkoutPlanMapper`。

### 2.5 定性：本轮新引入

```ts
// git show HEAD:apps/api/src/mobile-goals.ts
function normalizeWeekPlan(value: Array<{ localDate; kind; distanceKm }>) {   // ← 类型里没有 structure
  ...
  distanceKm: distance == null || !Number.isFinite(distance) ? null : Math.min(80, Math.max(0, distance))
}
```

HEAD 版既不接受 `structure`，也硬钳 80 ⇒ **当时不存在该缺口**。本轮为了修上一轮 🔴#1（"距离必须由结构反推"）扩大了信任面，却没把旧闸门搬过来。
对照：validator 对**模型**输出的结构有 `capDayDistance`（`weekly-plan-validate.ts:372-397`），而**客户端**输入的走在同一条持久化路径上却没有 —— 这种不对称正是缺口本身。

### 2.6 修法（两条入口都要）

1. **形状之外加总量钳制**：在 `normalizeWeekPlan` 的反推分支前，对超出 `MAX_PLANNED_DISTANCE_KM` 的 `structure` **重建**（只钳 `distanceKm` 不够 —— 结构才是上表内容）：
   `buildSessionStructure(kind, prescription, { targetDistanceKm: MAX_PLANNED_DISTANCE_KM - DISTANCE_ROUNDING_KM })`。
   建议把 validator 的 `capDayDistance` 抽成共享函数，避免第二份实现漂移。
2. `normalizeLockedSession`（`:558`）同样处理。
3. 订正 `session-structure.ts:28-33` 的注释（三方同守 → 实际是 schema + validator；goals store 在补上后才名副其实）。

**验收标准**
- 探针复跑：直供 1×20×100 km 结构后，`weekPlan[0].distanceKm ≤ 80`，**且 `structure` 的实测值 ≤ 80**；
- lock 路径同样满足；
- 新增回归（`apps/api/test/mobile.test.ts`，紧邻 `:768` 的既有反推用例），断言引用 `MAX_PLANNED_DISTANCE_KM` 常量而非字面量 80。

**回滚**：`git checkout -- apps/api/src/mobile-goals.ts apps/api/test/mobile.test.ts`。**无迁移、无破坏性契约变更**（`MobilePlannedDay` 形状不变）。

---

## 三、🟡 待决策

### 3.1 `MAX_PLANNED_DISTANCE_KM` 注释与实现不符

`session-structure.ts:28-33`：

```
 * Single-day distance ceiling. Shared by the JSON schema, the goals store and
 * the plan validator so a value one layer accepts is never silently truncated
 * by the next.
```

实际：schema ✅ / validator ✅ / **goals store ❌**（§2）。把注释改成真话，或（更好）把 §2 修掉让它成立。

### 3.2 退化区不收敛（沿用 FIXES-REVIEW 的登记，我复核为真）

上限低于最短 easy 时无法收敛，**文案如实说"已到结构下限，仍高于上限"**（`weekly-plan-validate.ts:685-697`）—— 不谎称合规，这是正确处置。我的独立探针也命中该分支（`goal=4` 落库 2.50 ≤ 4.20，`goal=2` 全周 rest/0km）。

### 3.3 已完成日的两端点差异是**刻意的**（复核 A 队结论）

`/v1/mobile/today` 对已完成日给实绩（`mobile-coach.ts:956-966` 的 completed 分支，`planned:false` + `structure:null` + `completedWorkoutId`），`/v1/mobile/workout-plan` 给处方（`executable=false`）。链条自洽，且有披露：
- 服务端：`mobile-read.ts:334` `!args.todayCompleted` ⇒ 今天已完成时 `executable=false`；
- 客户端：`inactiveLabel` 返回「已完成」，**两皮肤都用**（`NativeViews.swift:438`、`TechViews.swift:334`），各用本皮肤色值；
- 有 5 条模型级断言（`WorkoutPlanMapperRegression.swift:157-174`，含"已完成优先于休息"）。

⇒ 与 FIXES-REVIEW §四 的处置一致，**不列为缺陷**。

---

## 四、✅ 通过项与独立复现

### 4.1 上一轮 🔴#1 已闭环（读侧 + 写侧都统一）

| 环节 | 行号 | 现在的做法 |
|---|---|---|
| goals 写（merge） | `mobile-goals.ts:453-454` | 由结构反推 |
| goals 读（响应） | `mobile-goals.ts:154-167` + `:489-503` | `toResponse` 逐日 `measurePlanDay` |
| today 的 weekPlan | `mobile-coach.ts:1000-1007` | `plannedDayNumbers` 反推（不再用存值） |
| today 的 today 行 | `mobile-coach.ts:984-994` | 同上 |
| workout-plan | `mobile-read.ts:340-352` | 同上 |

**接线核对**（这是"已修 vs 未修"的分水岭）：`PUT /v1/mobile/goals` 传 `planPrescription()`（`server.ts:880`），该函数在 DB 就绪时返回 `{ prescription }`（`server.ts:865-866`）；`/generate` 落库时也传（`server.ts:823`）。⇒ 反推分支**真的会走**，不会掉到 `distanceKm = clientDistance`。

### 4.2 FIXES-REVIEW 的 3 条 P0：独立复现，数字逐位一致

临时探针（`_probe_p0.mts`，已删）直接打 `validateWeeklyPlan`：

```
[P0-1 open 结构 ×49km]  goal=40 ceiling=42.00
  落库总=41.30  非休息日=7/7  √ 装下
  告警: ["…课表结构含开放式工作段，无法估算距离，已按 49km 重建", …]

[P0-2 7×5.7km 只超落库]  goal=37.8095 ceiling=39.70
  落库总=39.20  非休息日=7/7  √ 装下
  告警: ["周总跑量 39.9km 超过上限 39.7km，已缩减至 39.2km"]

[P0-3 退化区质量课]  goal=4 ceiling=4.20
  落库总=2.50  非休息日=1/7  √ 装下
  告警: ["轻松时段占比低于下限，已降级 … 的质量课", "周跑量预算不足以支撑 2 堂质量课，已降为轻松跑"]
```

与 `FIXES_2026-09-13-REVIEW.md` §二 的自述**逐位相符**（41.3 / 39.2≤39.7 / 降级），且 P0-2 的"7 堂全留"确认成立（旧行为是丢 1 堂）。
补充证据：`weekly-plan-prompt.ts:27` 第 5 条**仍邀请** `{"type":"open"}` ⇒ `isFullyDosed` 的重建路径**不是死代码**，会被真实触发。

### 4.3 回退模板 ceiling：7 组全装下

临时探针（已删），`buildFallbackWeekPlan` + 双读数（measured / stored）：

```
goal  prev  measured   stored   ceiling   over?
8     null  7.815      7.700    8.400     ok
15    null  14.885     14.800   15.750    ok
30    null  29.700     29.500   31.500    ok
40    8     25.823     25.700   27.300    ok
4     null  3.938      3.900    4.200     ok
2     null  0.000      0.000    2.100     ok      ← 预算不足则不排课，保守正确
60    10    38.700     38.500   40.950    ok
```

前 4 组正是上一轮 §3.2 记录"4/4 全超"的那 4 组 ⇒ **已修**（`trimToCeiling` + `weekTotal` 循环，`weekly-plan-validate.ts:829-850/892-893`），`weeklyPlanVolumeCeiling` 的注释（`:84-90`）也随之改为真话。

### 4.4 守卫经突变验证 —— 两条都是真守卫

| 守卫 | 载荷 | 结果 |
|---|---|---|
| 跨语言常量 | 把 `APIClient.swift:68` 的 `generateTimeoutInterval` 由 60 → 40 | 第 30 例**精确失败**（`the client waits longer for a generated plan than the server spends on it`） |
| `addHook` 写操作 | 往 `apps/api/src/` 植入 `__probe_hook.ts`（`app.addHook("onRequest", … INSERT INTO …)`） | **精确捕获**：`src/__probe_hook.ts 的 onRequest 钩子里出现写语句…` |

干净对照：植入前 `schemas.test.ts` **14 pass / 0 fail**；植入后 13 pass / **1 fail**，且失败**就是**目标那一条（没有把无关断言的失败当成自己的功劳）。

跨语言守卫本身的写法也值得记录（`weekly-plan.test.ts:775-823`）：剥注释 → 行首锚定声明 → **同时**断言 `generateTimeoutInterval`(60s) 与 `timeoutIntervalForResource`(75s) 都 > 服务端 50s → 并钉死服务端预算表达式（防止 `?? DEFAULT × 2` 这类绕过）。

### 4.5 其它核对通过项

- **P0-1/2/3 的宿主逻辑**：闸门用 `weekTotal = max(实测, 落库)`（`:576-585`），`fitWeekToCeiling` 以 `sizeOf = max(weekSizeOf, storedTotalOf)` 做 12 轮二分（`:339-355`），退化区用 `asPrescribed` 快照（`:588-589`）—— 与 FIXES-REVIEW 描述一致。
- **服务端接线**：`previousWeekDistanceKm` 已传入生成器（`server.ts:796`）；空结果**不写库**（`server.ts:801-809`），`ensureWeeklyPlan` 另有一道日期窗口守卫（`server.ts:577`）⇒ 上一轮 §3.5 提的"理论路径"已被双重守住。
- **两新端点登记 / OpenAPI**：generate 在 `metadataOnlyMutationRoutes`（`server.ts:178`），GET 不登记；两条路径已进 `openapiDocument`（`schemas.ts:621/624`）。
- **双皮肤**：`inactiveLabel` 是共享分类器（`WorkoutPlanMapper.swift:192-197`），两个皮肤只做渲染（各用 `PixelColor`/`TechColor`）⇒ 符合"皮肤不该各自决定这条规则"。
- **`MobileWorkoutPlanDay` 未被加字段**（`APIModels.swift:604-621` 仍全 `let` + 合成 Codable）⇒ 设备旧缓存不会解码失败。
- **Web**：`useRemote` 超时用**竞速**而非只 abort，且 `finally` 清定时器（`hooks.ts:61-94`）—— 请求先完成时不会留未处理 rejection；`ErrorBoundary` 拆出函数组件用 `useNavigate`，且确实挂在 `<BrowserRouter>` 内（`main.tsx:34-37`）⇒ 不会"回退 UI 自己崩"。

---

## 五、验证证据（本轮实跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| TS 类型 | `npm run typecheck` | ✅ EXIT=0（pure + full） |
| 全仓测试 | `npm test` | ✅ EXIT=0；node:test **572 / 568 pass / 0 fail / 4 skip**；vitest **12 文件 / 81 pass** |
| 构建 | `npm run build` | ✅ EXIT=0，`✓ built in 14.02s`（先 `mv apps/web/dist` 绕沙箱 safe-delete 护栏） |
| iOS 类型 | `bash apps/ios/tests/typecheck-ios.sh` | ✅ EXIT=0，**36 文件**（首跑因我在其编译期间改 Swift 文件报 `modified during the build`，**属我操作失误**，已还原文件后重跑） |
| iOS 模型 | `bash apps/ios/tests/run-model-tests.sh` | ✅ EXIT=0，`All workout plan mapper checks passed.` |
| 浏览器 e2e | `npm run test:e2e:web` | ⚠️ **环境不可运行**：`error: '未找到可用于 E2E 的本机 Chrome 或 Edge'`（10 fail / 1 skip） |

> 与 `FIXES_2026-09-13-REVIEW.md` 自述的 572 / 568 / 0 / 4 **一致**。
> 唯一缺口照旧：浏览器流程与 iOS 视觉层在本机**无法验证**（后者是编译级 + 模型级，不是观感）。

---

## 六、修复顺序与验收

| 顺序 | 项 | 验收标准 | 回滚 |
|---|---|---|---|
| 1 | §2 结构总量钳制（goals + lock 两入口） | 直供 1×20×100km 结构后落库 `distanceKm ≤ 80` **且结构实测 ≤ 80**；lock 同；新增回归引用 `MAX_PLANNED_DISTANCE_KM` | `git checkout -- apps/api/src/mobile-goals.ts apps/api/test/mobile.test.ts` |
| 2 | §3.1 订正 `MAX_PLANNED_DISTANCE_KM` 注释 | 注释与实现一致（或随 #1 自然成立） | `git checkout -- apps/api/src/session-structure.ts` |
| 3 | §3.2 退化区（可选） | 已有诚实文案，可按产品决定是否收敛 | — |

**全局回滚**：全部改动仍在工作区、**未提交**，逐文件 `git checkout -- <path>`；未跟踪文件直接删除。
**库结构**：本轮无新增迁移（v21 只建索引不碰数据）。
**数据安全**：本轮**未触碰** `/var/lib/rai`、`var/rai.sqlite`、任何备份；探针全部在 `/tmp` 副本或临时新增文件上进行，**已逐个删除并核对工作区零残留**。

---

## 七、清理项

- 临时探针 3 个（`apps/api/test/_probe_fallback.mts`、`_probe_goals.mts`、`_probe_p0.mts`）与突变载荷 1 个（`apps/api/src/__probe_hook.ts`）**已全部删除**；`git status` 复查 **0 残留**；探针创建的 `/tmp/rai-probe-goals-*` 已 `rm -rf`。
- 工作区项数：审查开始 **72**（51 M + 21 ??）→ 结束 **72**（一致；`APIClient.swift` 经突变→还原，内容与初态相同）。
- 提醒：`deliverables/` 现有 7 份 09-10～09-13 审查/修复文档，同一问题在多份中各写一遍的迹象已经出现（如"LLM 预算"出现在 3 份里）。建议下一步按"结论 + 未闭环项"做一次归并。

---

## 八、修复记录（2026-09-13 当日闭环）

### 8.1 🔴 §2 结构总量钳制：两处写入 + 两处读取

新增共享函数 **`capStructureToDayCeiling(structure, kind, zones)`**（`mobile-coach.ts`）：

- 按 `measureStructure` **实测**判定；未超限**原样返回**（不重建，保住生成器调优过的 rep 数）；
- 超限则重建 —— interval 用 reps 杠杆、其余用 `targetDistanceKm`，一律取 `MAX_PLANNED_DISTANCE_KM - DISTANCE_ROUNDING_KM`（避免"请求在上限上、实测越界"）；
- 重建后**仍**超限（tempo 是固定剂量、忽略 `targetDistanceKm`，配速极端时会）⇒ 返回 `null`；调用方于是不存结构 ⇒ `executable=false` ⇒ **不上表**，而不是把超限处方塞给手表。

接入 4 处，每一处都对应一条真实读/写路径：

| 路径 | 位置 | 作用 |
|---|---|---|
| goals 写入 | `mobile-goals.ts` `normalizeWeekPlan` | 防新写入超限 |
| lock 写入 | `mobile-goals.ts` `normalizeLockedSession`（新增 `zones` 参数，调用点传 `options?.prescription`） | 同上 |
| goals 读取 | `mobile-goals.ts` `measurePlanDay` / `measureLockedSession` | 治"已落库的旧值"（`/v1/mobile/goals` 带 prescription） |
| today / lock 渲染 | `mobile-coach.ts` `buildWeekPlan` 的 saved 分支、`resolveLockedNextSession` | `/v1/mobile/today` 是**不带 prescription** 读库的，这两处是它唯一能拿到 zones 的地方 |

§3.1 一并解决：`DISTANCE_ROUNDING_KM = 0.1` 由 `weekly-plan-validate.ts` 的私有常量**提升到 `session-structure.ts`**，与 `MAX_PLANNED_DISTANCE_KM` 同源；后者的注释改为"**字段上限不等于总量上限**，故各层还要按测量值钳制"。

### 8.2 实测（探针跑完即删）

```
单日上限 = 80km；载荷实测 = 2000.0km   （1 块 × 20 组 × 100km，每个字段都合法）

[1] goals 写路径   落库 distanceKm = 79.9   落库结构实测 = 79.9km
[2] lock  写路径   落库 distanceKm = 79.9   落库结构实测 = 79.9km
[3] 正常结构（7km easy） 原样返回 √ 未改动
[4] cap(huge): easy 79.9 | long_run 79.9 | tempo 8.8 | interval 11.9   全部 ≤ 上限
```

### 8.3 ⚠️ 本轮最值得记的教训：**测试判据选错了出口，突变不红**

第一版回归用例断言的是 `store.write(...)` 的**返回值**。去掉入口钳制后它**仍然全绿**（28/28）——因为 `write()` 的返回值经过 `toResponse`，而我在读取路径也加了钳制，出口把结构改小了。
⇒ 那条断言实际测的是"**视图**被钳制"，而不是"**落库**被钳制"。

**改法**：追加 `store.read()`（**不带 options**）的断言 —— 这正是 `/v1/mobile/today` 的读法（`mobileGoalsStore.read()` 无参数），它返回**落库原值**。改完后突变才红：

| 突变 | 结果 |
|---|---|
| 去掉 goals 入口钳制 | ✅ 第 26 例失败：`持久化的结构实测必须 ≤ 上限，否则上表处方仍超限` |
| 去掉 lock 入口钳制 | ✅ 同一例精确失败 |

> **通用判据**：验证"写入侧的约束"时，断言必须取自**持久化之后的读**，且读法与真实调用点同形；不能取写入函数的返回值——返回对象往往已被出口加工过。
> 这与上一轮"`addHook` 守卫空转"是同一类错误的两个面：**守卫/断言看着在测 A，实际在测 B。**

### 8.4 门禁与回滚

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | ✅ EXIT=0 |
| `npm test` | ✅ EXIT=0；node:test **574 / 570 pass / 0 fail / 4 skip**；vitest **12 文件 / 81 pass** |
| `npm run build` | ✅ EXIT=0 |
| `typecheck-ios.sh` / `run-model-tests.sh` | 未重跑 —— 本轮**未触碰任何 iOS 文件** |
| `test:e2e:web` | ⚠️ 环境不可运行（同 §五） |

新增回归 **2 例**（`apps/api/test/mobile.test.ts`）：超限结构（goals + lock 双路径，断言取持久化读）；未超限结构原样保留。

**回滚**：
```bash
git checkout -- apps/api/src/mobile-goals.ts apps/api/src/mobile-coach.ts \
                apps/api/src/session-structure.ts apps/api/src/weekly-plan-validate.ts \
                apps/api/test/mobile.test.ts
```
**无迁移、无 schema 变更、无契约变更**（`MobilePlannedDay` / `MobileWorkoutPlanDay` 形状不变）。

### 8.5 明确不处置项（说明理由，非遗漏）

| 项 | 为何不动 |
|---|---|
| §3.2 退化区不收敛 | **不可修**：结构地板本身高于上限（`minEasyKm` 由配速决定）。现有文案已如实写"已到结构下限，仍高于上限"，不谎称合规——这比强行收敛诚实 |
| §3.3 已完成日两端点差异 | 复核判定为**刻意的处方 vs 实绩区分**（已给依赖证据链），且双皮肤标签已披露。抹平数字反而会让"手表课表"变成撒谎 |

### 8.6 §2.6 残留闭环：单日上限只剩一份实现（2026-09-14）

§2.6 的第 4 条是**建议**而非处方：「把 validator 的 `capDayDistance` 抽成共享函数，避免第二份实现漂移」。当日只做完 3 条处方，这条**只做了一半**——新建了 `capStructureToDayCeiling`，validator 的 `capDayDistance` 原地未动，于是同一上限存在两份实现。本次补完。

**改法（只抽重建核，不并策略）**

新增 `rebuildStructureUnderDayCeiling(kind, zones)`（`mobile-coach.ts`）：区间用 reps 杠杆、其余用 `targetDistanceKm`，请求一律取 `MAX_PLANNED_DISTANCE_KM - DISTANCE_ROUNDING_KM`。两侧改为调用它 —— `capStructureToDayCeiling`（coach 侧）与 `capDayDistance`（validator 侧）。

**刻意不合并的部分**：重建后仍超限时的**处置策略属各自契约** —— validator 保留该日（它的输出是「一周的日子」，删一天会改变计划形状），coach 返回 `null`（让这堂课不上表）。两支当前都不可达（`buildSessionStructure` 只在 `kind === "rest"` 返 `null`，而 rest 的 size 为 0 已在前面早退），且契约不同，故不合并，并在两侧注释里写明理由。

**漂移已消除**：原差异中「最小间歇组数 `2`（validator 字面量）vs `INTERVAL_MIN_REPS`(=4)（coach）」现只在共享核里定义一次。`scaleDistances`（`:257`）的 `2` 是**另一个语义**（按周预算向下缩放时允许低于教练最小值），未动，也不应并入。

**行为中性验证**：改动前后逐位一致 —— node:test 574/570/0/4 + vitest 12 文件 → 改动后 575/571/0/4 + vitest 12 文件，增量即下述新用例。

**新增回归 1 例**（`apps/api/test/weekly-plan.test.ts`）：

> `a model-supplied structure over the single-day ceiling is rebuilt at the cap`

- 载荷：`long_run`，单块 `iterations: 20` × 10km 工作步 ≈ **201.5km**，每个字段都合法（`MAX_BLOCK_ITERATIONS` = 20），只有总量不合法。
- **尺寸是刻意选的**：高于单日上限（80）、**低于**周量上限（`weeklyDistanceKm` 取 schema 最大值 500）。这是把「周闸门」排除在外 —— 否则 `fitWeekToCeiling` 自带一份同值钳制会把日子拉回来，这条单日闸门就永远不是被测对象。
- **突变验证（第一次无效，第二次才有效，过程如实记录）**：

| 突变 | 结果 |
|---|---|
| 共享核的 `cap` 改成 `MAX_PLANNED_DISTANCE_KM * 100` | ❌ 只被 coach 路径捕获（`mobile.test.ts` #26「over the single-day ceiling is rebuilt」），**validator 侧全绿** |
| `capDayDistance` 的越限条件改成恒假（**整条闸门废掉**） | ✅ 精确失败：`落库距离 201.5 必须 ≤ 80：周闸门管不到这一档，只有单日闸门能拦` |

⇒ 两条结论：① 第一次突变暴露出 **validator 侧的单日上限原先没有任何测试覆盖**，这就是本次要补的洞；② **改上限常量的突变会被 `fitWeekToCeiling` 的同值钳制掩盖，只有「废掉整条闸门」的突变才能证明它承重** —— 与「失败路径是 `continue` 的守卫必须突变验证」同源。已回写 `.workbuddy/memory/MEMORY.md` 的核验纪律。

**门禁**：`npm run typecheck` EXIT=0；`npm test` EXIT=0（575 / 571 pass / 0 fail / 4 skip；vitest 12 文件 / 81 pass）；探针零残留。未跑 `npm run build`（本轮只改 API，web 未触及）。

**回滚**：
```bash
git checkout -- apps/api/src/mobile-coach.ts     # 已跟踪，直接回退
# apps/api/src/weekly-plan-validate.ts 与 apps/api/test/weekly-plan.test.ts 是未跟踪新文件
# （本次工作集内新建），git checkout 无效，需手动回退 §8.6 的两处 hunk：
#   1) 删除 capDayDistance 中调用 rebuildStructureUnderDayCeiling 的改动
#   2) 从 mobile-coach.js 的 import 列表移除 rebuildStructureUnderDayCeiling
```
**无迁移、无 schema 变更、无契约变更。**
