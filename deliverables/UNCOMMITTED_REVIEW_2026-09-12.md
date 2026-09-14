# 未提交改动审查（2026-09-12）

审查对象：工作区 **34 项变更** —— 21 个已跟踪文件（+1962 / −77）+ 13 个未跟踪新文件（约 2599 行）。
改动主体：**周课表 LLM 生成器（`weekly-plan-*` + `session-structure`）→ 服务端校验钳制 → WorkoutKit 上表**，横跨 API / iOS / Web / 契约 / 文档五层。

方法：逐文件读 diff → 核对路由登记与持久化表结构 → **实测验证可疑点**（不只看码）→ 跑全量验证。
所有结论均落到 `文件:行号` 或命令输出。

---

## 一、结论摘要

| # | 级别 | 结论 | 证据 |
|---|---|---|---|
| 1 | 🔴 必修 | LLM 路径**存储** LLM 自称的 `distanceKm`，与结构实测不一致 | `weekly-plan-validate.ts:250` |
| 2 | 🟡 待决策 | 确定性回退模板同类问题：interval/tempo 天 stored≠measured，且**不过量上限校验** | `weekly-plan-validate.ts:350-368` |
| 3 | 🟡 待决策 | `previousWeekDistanceKm` 未接线 → 30% 周增幅钳制**在真实路径恒不生效** | `server.ts:752-757` |
| 4 | ✅ **已撤回** | ~~`/generate` 登记在 `metadataOnly`，DB 缺失时错误码退化为 500~~ —— **实测仍返回 409，原判断有误** | `read-store-manager.ts:45-48`；端到端 `server-runtime.test.ts` |
| 5 | 🟡 待决策 | `readControlGoals` 未 normalize → 旧数据 `weekPlanAudit` 为 `undefined` 而非 `null` | `mobile-goals.ts:243-248` |
| 6 | 🔡 清理 | schema 上限 80 与 validator clamp 60 不一致；测试文件格式回归 | `schemas.ts` / `ios-mobile-app.test.tsx` |
| 7 | ✅ 通过 | 路由登记、周一自动生成、merge 语义、零迁移、LLM 三道防线、iOS 设备侧二次边界、双皮肤分离 | 见 §四 |

> **修复状态**：1 / 2 / 3 / 5 / 6 与 §六 全部清理项**已修复并验证**，见 §七。#4 经复核为**误判，已撤回**。

**一句话**：架构分层与安全姿态是对的——契约先行、生产者无关、三层校验、失败必回退。**但"距离必须由结构反推"这条既有铁律，只在新加的 coach 路径上守住了，新加的 LLM 路径和回退模板都没守住**（#1/#2），而这两个值会被持久化并展示给用户。

**验证基线（全绿）**：`npm run typecheck` ✅ ｜ `npm test` = node:test **526 项 / 523 pass / 0 fail / 3 skip** + vitest **72 pass** ✅ ｜ `run-model-tests.sh` ✅ ｜ `typecheck-ios.sh`（36 文件）✅

---

## 二、🔴 必修

### 2.1 LLM 路径存储 LLM 自称的距离，与结构实测冲突

`weekly-plan-validate.ts:237-254` 把 LLM 给的 `distanceKm` 直接当作展示值落库：

```ts
const distanceHint = ... Math.min(60, raw.distanceKm) : null;   // ← LLM 自称
...
const day: MobilePlannedDay = {
  localDate, kind: sessionKind,
  distanceKm: distanceHint,        // ← 行 251：未由 structure 反推
  structure,
```

**实测复现**（临时探针，已删除）：构造一个"LLM 少报距离"的 easy 日（自称 1km、结构为 6300m work + 热身/放松各 300s），周上限 40km：

```
[LLM under-report] stored distanceKm  = 1
[LLM under-report] measured distanceKm = 7.84
[LLM under-report] clamped = []
```

**7.84 倍偏差，且没有任何 clamp 提示。**

为什么只在"总量超上限"时才被纠正：`validateWeeklyPlan` 的量控（`weekly-plan-validate.ts:298-299`）用的是 `measuredDay` 实测值判定，一旦触发 `scaleDistances` 就会重算 `distanceKm`；而**未超上限时保留 LLM 的 hint**。

**影响面**（该值会往下游走三跳）：
1. `PUT /v1/mobile/goals` → 持久化进 `weekPlan[].distanceKm`；
2. iOS `NativeAppModel.generationSummary` 把它汇总成给用户看的 **"合计 X km"**（`NativeAppModel.swift` 新增段）；
3. Web/iOS 周课表行显示它（`Home.tsx`、`NativeViews.planRow`）。

而 WorkoutKit 上表走的是 `structure`。⇒ **用户看到的公里数与手表实际执行的处方是两个数**。

违反项目既有铁律：*`distanceKm/durationMinutes` 必须由 `measureStructure` 反推，不得硬编码*。coach 路径已经做到（`mobile-coach.ts` 新增的 `structuredSession`：`distanceKm: measured ? round1(...)`，并有测试 `mobile-coach.test.ts:"reported distance and duration never contradict..."` 守住），**但 LLM 校验路径没有复用这个纪律**。

修复（validator 内已有 `measuredDay(day, args.prescription)` 可用）：

```ts
const measured = measuredDay(day, args.prescription);
distanceKm: measured ? Math.round(measured.distanceKm * 10) / 10 : distanceHint,
```

---

## 三、🟡 待决策项

### 3.1 确定性回退模板的同类不一致（且不过量校验）

`buildFallbackWeekPlan`（`weekly-plan-validate.ts:350-368`）对 interval/tempo 天用**默认结构**，但只按 `perDayKm = weeklyDistanceKm / 天数` 填 `distanceKm`。实测（`weeklyDistanceKm=50`，7 天）：

```
[fallback] 2026-09-09 interval  stored=  7.1 measured=7.51
[fallback] 2026-09-13 tempo     stored=  7.1 measured=8.80     ← 偏差 24%
```

两个后果：
- 与 #1 同源，展示值失真；
- **fallback 完全绕过 `validateWeeklyPlan`**（`weekly-plan-service.ts:143-156` 直接 return），所以回退课表既不做量上限校验、也不做质量课/轻松占比钳制。实测该例 7 天合计 ≈ 52km > 上限 50km。

回退路径"保守"是靠人工挑选的常数，不是靠钳制器。建议 fallback 产出后过一遍同一套钳制（至少量上限）。

### 3.2 30% 周增幅钳制未接线

`weekly-plan-validate.ts:301-305` 有 `RAMP_LIMIT_FRACTION = 0.3` 的 ramp 上限，但调用方没传参数：

```
grep previousWeekDistanceKm apps/api/src
  data.ts:348                     ← 只喂给 CoachInput（volume_ramp flag，事后告警）
  weekly-plan-service.ts:119      ← args.previousWeekDistanceKm ?? null
  ← server.ts:752-757 的 generateWeeklyPlan({ today, goals, prescription }) 缺该项
```

⇒ `rampCeiling` 恒为 `Infinity`，只剩 `weeklyDistanceKm` 绝对值上限。**"周量增幅 ≤30%"这条防线只在测试里存在**（`weekly-plan.test.ts:67` 显式传 `null`）。

注意：`volume_ramp` injuryFlag（本周已超上周 50%）仍会抑制质量课，属于**事后**兜底；但设计文档 §0 把"周量增幅必须被钳制器拦截"列为 🔴 最大风险，实现未闭环。

修复：`server.ts` 调用处补 `previousWeekDistanceKm: <上周实测跑量>`（`data.ts` 已有该数据源）。

### 3.3 `/generate` 的登记集合 —— 复核后撤回（原判断有误）

初判：`server.ts:159` 把 `POST /v1/mobile/workout-plan/generate` 放进 `metadataOnlyMutationRoutes`，而该集合在 `server.ts:186` 直接 `return`、跳过 `existsSync(databasePath)`，因此 DB 缺失时会「下沉到 handler 内 500」。

**复核结论：这是误判。** 链路上还有第二道闸门：

- `withReadStore` → `ReadStoreManager.use` → `read-store-manager.ts:45-48` 在 `!existsSync(databasePath)` 时抛 `DatabaseNotReadyError`，其 `statusCode = 409` / `code = "database_not_ready"`（`:20-28`）；
- `api-error.ts:11-13` 优先采用 `error.statusCode` ⇒ 最终返回 **409**，不是 500。

唯一的差别只是文案：preHandler 的 409 说「尚未就绪，请先导入或恢复数据」，异常路径说「不存在，请先导入 Apple Health 数据」——`status` 与 `code` 完全一致，调用方无法区分，也无从感知。

**端到端实证**：把该端点加入既有的「数据库被删除后写操作必须 409」守卫用例（`server-runtime.test.ts` 的 `guardedRequests`），实测通过 —— `ok 6 - database-backed writes cannot recreate a deleted database`，且断言了它不会重建数据库文件。

因此**保持登记在 `metadataOnly` 是正确的**：它是长任务（LLM 最长 50s），刻意不持有主库 mutation lock —— 这正是该集合注释所述的用途（"long/IO-only; they must not hold the mutation lock"）。若改登记为 `databaseRequired`，反而会让一次 50s 的生成阻塞导入与重建。

（顺带纠正本条初判的另一处措辞：我说「用它就该移入 `databaseRequiredMutationRoutes`」，那是**错的**——建议本身会引入性能退化。已撤回。）

### 3.4 `readControlGoals` 未过 normalize

`mobile-goals.ts:243-248` 直接 `JSON.parse(row.payload_json)` 后 spread，未做字段清洗：

- 本次新增的 `weekPlanAudit`：旧 payload 无此键 → 运行时 `undefined`，而契约声明 `MobilePlanAudit | null`（`api-contracts` `MobileGoalsResponse.weekPlanAudit`）。测试也固化了这个形状（`mobile.test.ts` 断言 `easy?.structure === undefined`）；
- `weekPlan[].structure/reason` 同样未清洗。

JSON 序列化会丢弃 `undefined` 键，且 `data.ts:410` 用 `?? null` 兜底、`assembleMobileWorkoutPlan` 用 `?? buildSessionStructure(...)` 兜底，所以**当前无实际故障**；但类型承诺与运行时取值之间有缝。建议在 `readControlGoals` 出口过一遍 `normalizePlanAudit` / `normalizeWeekPlan(value, [])`。

### 3.5 边界值不一致

| 项 | 位置 | 上限 |
|---|---|---|
| JSON Schema 校验 | `schemas.ts` `mobileWeekPlanItemSchema.distanceKm` | **80** |
| LLM 输出 clamp | `weekly-plan-validate.ts:239` | **60** |
| goals 写入 clamp | `mobile-goals.ts:normalizeWeekPlan` | **80** |

同一字段三处边界两个值。不致命，建议统一。

---

## 四、✅ 做得好 / 通过项

| 项 | 证据 |
|---|---|
| 写端点登记齐全，GET 只读不登记 | `server.ts:159` 登记 `/generate`；`/workout-plan` GET 明确不入表（注释说明"read-only, never mutates goals"） |
| 周一自动生成机制完整 | `server.ts:533-560`：hourly tick + **启动后 60s 首跑**（避免周一早重启漏生成）+ `unref()` + `onClose` 清理 timer |
| **零新增存储 / 零迁移** | 持久化在 `payload_json` blob（`mobile-goals.ts:174-179`），新增 `weekPlanAudit` 无需 migration |
| merge 语义正确且有测试 | `normalizeWeekPlan(value, previous)`：同日期**同类型**继承 `structure`+`reason`，类型变更不带旧结构，空数组仍清空；`mobile.test.ts` 三例覆盖 |
| LLM 三道防线齐备 | schema 校验（`validateWeeklyPlan:204-256`）→ 业务钳制（质量课 cap / 轻松占比地板 / 配速地板 / 间歇组数 / 量上限）→ 回退启发式（永不空课表） |
| LLM 客户端安全 | `weekly-plan-llm.ts`：key 不打印不落盘、**不回显响应体**、单次 45s + 总额 50s 预算（< 客户端 60s，避免"请求超时但已落库"）、401 不重试 |
| iOS 设备侧二次边界 | `WorkoutPlanMapper` 对服务端数据重新 bounded（`maxBlocks`/`maxIterations`/`maxStepMeters`/`maxAlertValue`），pace→speed **反转正确**且单独测试 |
| WorkoutKit 调用的诚实处理 | `WorkoutKitBridge.sync` 在 `schedule()`（非抛错）后**回读 `scheduledWorkouts` 比对**，不信任调用成功；每步至多 1 个 alert |
| 双皮肤未串味 | pixel 用 `PixelPanel/PixelColor`，technology 用 `TechPanel/TechColor`，无跨皮肤硬编码 |
| 覆盖 `MobileNextSession.structure` 必填的破坏性变更 | iOS `MobileGoalsPlanItem` 回传 structure，服务端 merge 兜底；`normalizeLockedSession` 补 `structure` |
| 测试非空转 | 新增 `weekly-plan.test.ts`（19 例：窗口外日期拒绝、超 cap 降级、轻松占比地板、配速收回、量上限迭代收敛、脏结构丢弃重建、覆盖告警、LLM 预算耗尽） |

---

## 五、修复顺序建议与验收标准

| 顺序 | 项 | 验收标准 | 回滚 |
|---|---|---|---|
| 1 | #1 `distanceKm` 反推 | 新增测试：LLM 少报（hint=1 / 实测 7.84）→ 存储值必须等于实测 ±0.1；`npm test` 全绿 | 单行改动，revert 即可 |
| 2 | 3.2 接线 `previousWeekDistanceKm` | 新增测试：上周 20km、本周目标 40km → 生成结果 ≤ 26km×1.05；`npm test` 全绿 | 恢复为不传参 |
| 3 | 3.1 fallback 过量校验 | fallback 产出后 `totalDistance ≤ ceiling×1.05` | 单函数边界 |
| 4 | 3.3 路由登记 | DB 缺失时 `/generate` 返回 409 `database_not_ready` | 移回 metadataOnly |
| 5 | 3.4/3.5/§六 清理 | 无行为变更，纯一致性 | 独立小改 |

**上线前必须**（项目约定）：`POST /v1/backups` → `git pull --ff-only` → `npm ci`（若依赖变化）→ `npm run build` → `systemctl restart rai-api`；随后核对 `git rev-parse --short HEAD` / `schema_migrations` 最新版本 / `/v1/health`。密钥走 `/etc/rai/rai.env`（`RAI_LLM_API_KEY` 必需，缺省时 `/generate` 不报错、回退并在 `warnings` 说明）。

---

## 六、清理项（无行为影响）

1. **Web 测试格式回归**：`apps/web/test/ios-mobile-app.test.tsx` 中
   `it("opens physiology detail from the body status card", () => {    renderApp("/");`
   两条语句挤成一行（原为两行）。仓库未配置 prettier/eslint，测试不受影响，建议还原。
2. **`run-model-tests.sh` 注释与命令不符**：注释写"只做类型检查"，紧随的命令实为编译并运行测试。
3. **周三后 `workout-plan` 窗口尾部为空**（复核后降级为观察项，未改）：`assembleMobileWorkoutPlan` 窗口是滚动 7 天（今天..+6），而 `weekPlan` 由周一生成、覆盖本周一..周日 ⇒ 周三之后窗口里的下周一/二没有课表。
   - ⚠️ **本条初判有一处错误需更正**：我写过「`windowDays` 与 `days.length` 会不一致」——**不成立**，实现的 `windowDays` 就是 `days.length`（`mobile-read.ts` 的返回体），两者必然相等。
   - 剩下的是**产品语义取舍**（自动生成频率「每周一」vs 窗口「滚动 7 天」），不是缺陷：用户随时可手动重新生成补齐。保持现状。
4. **`structureSummary` 双实现**：`apps/web/src/ios/shared.tsx` 与 `apps/ios/RAI/WorkoutPlanMapper.swift` 各一份，注释要求"must stay in step"但无共享测试保障，易漂移。
5. **`regenerateWeeklyPlan` 在 `goals == nil` 时 `expectedRevision: nil`** ⇒ 服务端跳过乐观锁，可能覆盖并发写入的计划。
6. **`refreshAll` 内已拉取 workoutPlan，`regenerateWeeklyPlan` 又显式 `refreshWorkoutPlan()`** ⇒ 一次重复请求（无害）。
7. **既有技术债**：`apps/ios/RAI/Keychain.swift:59` 的 `@MainActor` 转换警告，Swift 6 语言模式会升级为 error —— 已顺手修掉（见 §七）。

---

## 七、修复记录（2026-09-12 下午，全部已验证）

| 项 | 改动 | 文件 |
|---|---|---|
| 1 🔴 | LLM 日改为在 **clamp 之后**由 `measureStructure` 反推 `distanceKm`（先量后夹会高估，故顺序重要） | `weekly-plan-validate.ts:254-270` |
| 2 🟡 | 回退模板：质量课结构先建、其量先扣减周预算，余量再分摊给 easy 日；每天距离均反推 | `weekly-plan-validate.ts` `buildFallbackWeekPlan` |
| 3 🟡 | 抽出 `RaiReadStore.previousWeekDistanceKm(date)`，`mobileWeeklyPlanInputs` 随上下文返回，`server.ts` 调用处传入；并加 **`RAMP_BASE_FLOOR_FRACTION = 0.5`**（见 §八） | `data.ts` / `server.ts` / `weekly-plan-validate.ts` |
| 5 🟡 | `readControlGoals` 出口过 `normalizeWeekPlan` / `normalizePlanAudit` / `normalizeLockedSession` / `normalizeRaceTarget` | `mobile-goals.ts` |
| 6 🔡 | `MAX_PLANNED_DISTANCE_KM = 80` 收敛到 `session-structure.ts`，schema / goals / validator 三处引用；Web 测试格式还原 | `session-structure.ts` / `schemas.ts` / `mobile-goals.ts` / `ios-mobile-app.test.tsx` |
| 六.2 | 脚本注释改为与命令一致 | `run-model-tests.sh` |
| 六.4 | Web 与 iOS 各补**同组 6 条** `structureSummary` 断言，注释互相指向，杜绝双实现漂移 | `ios-mobile-app.test.tsx` / `WorkoutPlanMapperRegression.swift` |
| 六.5 | `regenerateWeeklyPlan` 在无 goals 快照时先拉取 goals 取 revision，不再静默跳过乐观锁 | `NativeAppModel.swift` |
| 六.6 | 去掉 `refreshAll` 之后的重复 `refreshWorkoutPlan()` | `NativeAppModel.swift` |
| 六.7 | `ServerSession.canonicalURL` 标 `nonisolated`（纯 URL 转换，无共享状态） | `ServerSession.swift` |
| — | 端到端固化：`/generate` 加入「DB 已删除」守卫用例 | `server-runtime.test.ts` |

**新增测试 10 项**
- `weekly-plan.test.ts`：模型少报距离被结构推翻 / 30% 增幅上限拦得住 / 回退模板每天可测且不超周目标
- `mobile.test.ts`：旧版本 goals 行仍读出 `null` 审计字段（strict equal）
- `ios-mobile-app.test.tsx` + `WorkoutPlanMapperRegression.swift`：`structureSummary` 6 例（米 / 公里 / 分钟 / 秒 / 组 / 空结构）

**验证（全绿）**
- `npm run typecheck` ✅
- `npm test` = node:test **530 项（527 pass / 0 fail / 3 skip）** + vitest **78 项** ✅
- `npm run build` ✅（13.19s）
- `apps/ios/tests/run-model-tests.sh` ✅（含 6 条新断言）
- `apps/ios/tests/typecheck-ios.sh` ✅ 36 文件，**Keychain 警告已消失**
- `server-runtime.test.ts` 端到端 ✅（`ok 6 - database-backed writes cannot recreate a deleted database`）

**验收标准（逐项）**：① 少报距离的日，存储值 = 结构反推值（±0.05km）；② 回退课表 7 天总量 ≤ 周目标 ×1.02 且每天 stored ≈ measured（±0.5km）；③ 上周 20km 时本周被压到 26km ×1.05 以内；④ 无需验收（已撤回）；⑤ 旧 payload 读出 `weekPlanAudit === null`。

**回滚**：全部为独立小改，逐文件 `git checkout -- <file>` 即可；无数据库迁移、无破坏性契约变更。

---

## 八、补充：ramp 下限保护 `RAMP_BASE_FLOOR_FRACTION = 0.5`

> **状态：小唐 2026-09-12 拍板「保持 A」—— 保留下限 0.5，ramp 约束继续生效。**
> 决策依据：`weeklyDistanceKm` 是设置页的**长期目标**而非"本周意图"；且缩量会写 `warnings`（`weekly-plan-validate.ts:354` → iOS `generationSummary`）告知用户，**不会静默**。
> 反向声明：若日后把它改为"当周意图"语义，应**显式删除 ramp 分支**（连同 `RAMP_LIMIT_FRACTION` 与两处测试），而不是把下限设在 ≥0.769 而留下永不触发的约束。

### 问题

`ceiling = min(周目标, 上周实测 × 1.3) × 1.05`。若上一周因病/伤只跑了 8 km，而本周目标 40 km，上限会被压到 **10.9 km** —— 相当于 App 无视自己刚被设定的目标。用户不会理解为"保守"，只会理解为"坏了"。

### 为什么下限不能取 0.8

设下限为该目标的 `f` 倍，则 ramp 上限为 `f × 周目标 × 1.3`。要它还能低于周目标（即 `Math.min` 仍可能选 ramp），必须：

```
f × 1.3 < 1   ⇒   f < 1 / 1.3 ≈ 0.769
```

**取 0.8 时 `0.8 × 1.3 = 1.04 > 1`，ramp 上限恒高于周目标，`Math.min` 永远取周目标 —— 这条规则会静默变成死代码**，与本次刚修掉的「`previousWeekDistanceKm` 未接线」是同一类缺陷（看似存在、实则不生效）。故取 **0.5**。

### 实测（周目标 40 km；模型每天报 20 km，合计 120 km）

| 上周 | 上限（有下限） | 上限（无下限） | 实际落库总量 | ramp 是否生效 |
|---|---|---|---|---|
| 8（伤病复出） | **27.3** | 10.9 | 27.8 | 是 |
| 20 | 27.3 | 27.3 | 27.8 | 是（下限恰等于真实值） |
| 30 | 41.0 | 41.0 | 41.0 | 是 |
| 38 | 42.0 | 42.0 | 42.2 | 否（上周已支持该目标） |
| 0（无历史） | 42.0 | ∞ | 42.2 | 否（不约束） |

复出场景的上限从 10.9 km 抬到 27.3 km（×2.5），而正常与高量场景的收紧行为全部保留。
> 落库总量略高于上限（+0.2~0.5 km）是每步 `roundKm` 到 0.1 km 的累积，测试容差取 +1 km。

### 验收与回滚

- **验收**：新增 `weekly-plan.test.ts` 两例 —— ① 上周 20 km / 目标 40 km ⇒ 总量 ≤ 27.3×1.05+1 且出现「超过上限」告警；② 上周 8 km / 目标 40 km ⇒ 总量 **高于**无下限时的 10.9 km（证明下限确实生效），且 ≤ 27.3×1.05+1。
- **回滚**：`RAMP_BASE_FLOOR_FRACTION` 改回与 `previousWeekDistanceKm` 相乘前的形式即可，单点改动。
