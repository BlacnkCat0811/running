# 训练计划领域算法、周期化、依从性与跨语言摘要一致性审查

- 审查员：plan-algorithms-reviewer（Team Lead 的 teammate，任务 task-3）
- 日期：2026-10-18（Asia/Shanghai）
- 性质：**只读**代码审查。未修改仓库文件；临时脚本仅写在 `/tmp`，未读写真实健康数据库。
- 承诺基线：`AGENTS.md`、`README.md`、`docs/ALGORITHM.md`（§9/§20）、`docs/DECISIONS.md`（D13/D14/D16）、`docs/TODAY_PLAN_CARDS_REVIEW.md`、`docs/COACH_LOOP_IMPLEMENTATION_STATUS.md`、`docs/IOS_TRAINING_PLAN_STATE_V1.md`。
- 严重级别定义（本报告自定）：**P0** 数据/安全/核心契约可被破坏；**P1** 高影响逻辑错误（用户可见的错误结论、保护失效）；**P2** 中影响：边界错误、跨端契约偏差、生产可达性受限的缺陷；**P3** 低影响：文档漂移、可维护性与测试缺口（上限 5 条）。

## 1. 审查范围

逐文件读毕（`file:line` 均按本工作树当前内容）：

| 领域 | 文件 |
| --- | --- |
| 周期化 | `apps/api/src/plan-periodization.ts`、`race-plan-policy.ts`、`run-coach-policy.ts`、`weekly-capacity.ts` |
| 依从性/执行窗口 | `apps/api/src/plan-adherence.ts`、`plan-execution.ts`、`workout-date-window.ts` |
| 课表生成/校验 | `apps/api/src/weekly-plan-service.ts`、`weekly-plan-validate.ts`、`manual-plan-policy.ts`、`coach-complete-plan.ts`、`coach-template-library.ts` |
| 剂量/闭环候选 | `coach-session-dose.ts`、`coach-goal-gap.ts`、`coach-extension-eligibility.ts`、`coach-plan-repair.ts`、`coach-execution-assessment.ts`、`coach-loop-decision.ts` |
| 摘要/结构 | `apps/api/src/plan-digest.ts`、`session-structure.ts`、`race-candidate.ts` |
| 契约 | `packages/api-contracts/src/index.ts`（plan/coach-loop 类型，`MobilePeriodization*`、`MobilePlanAdherence`、`MobileRunCoachResponse`）、`packages/contracts/src/timezone.ts`（`ISO_UTC_OFFSET`/`DATABASE_TIMEZONE`） |
| iOS | `apps/ios/RAI/PlanStatePolicy.swift`（`PlanFingerprint.prescriptionDigest`）、`apps/ios/tests/fixtures/prescription-digests.json`、`apps/ios/tests/PlanWatchSchedulingRegression.swift`（fixture 消费段）、`apps/ios/RAI/APIModels.swift`（`MobileSessionStructure`/`MobileStepAlert` 解码，用于对照） |
| 接线 | `apps/api/src/data.ts`（`recentWeeklyKm`/`previousWeekDistanceKm`/`weeklyCapacity`/`buildPlanExecution` 接线）、`mobile-read.ts`（`planSurfaces`）、`server.ts`（自动生成/预览调用）、`run-coach.ts`（`runCoachWeeklyBudget`） |

方法：
1. 先读文档承诺，再读实现，用合成输入在 `/tmp` 复算（`node --import tsx`）。
2. 摘要协议用**真实 Swift 源码**编译对照：`xcrun swiftc` 编 `APIModels.swift` + `PlanStatePolicy.swift` + `/tmp` harness，对同一组 JSON 输入分别跑 TS/Swift 摘要并逐字比较（未改仓库）。
3. 定向测试（未跑全量）：

| 命令/文件 | 结果 |
| --- | --- |
| `node --import tsx --test apps/api/test/plan-periodization.test.ts apps/api/test/plan-execution.test.ts apps/api/test/run-coach-phase.test.ts` | 27 pass / 0 fail |
| `... apps/api/test/weekly-plan.test.ts` | 65 pass / 0 fail |
| `... race-candidate.test.ts session-structure.test.ts coach-template-library.test.ts coach-execution-assessment.test.ts coach-plan-repair.test.ts` | 34 pass / 0 fail |
| `apps/api/test/run-coach.test.ts`、`mobile-coach.test.ts` | **无法运行（环境问题）**：导入链加载 `node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node` 报 `ERR_DLOPEN_FAILED`（代码签名 Team ID 不匹配）。不计为代码缺陷，但其断言在本机未核验。 |

## 2. 结论摘要

- **未发现 P0/P1**。周期化阶段边界、量带、ramp、14 天赛前保护、依从性"未观测≠没练"、D14 同源、D16 单一来源在主体路径上成立。
- **2 条 P2（均已证实）**：
  - R-01：距比赛**恰好 24 个自然周**时，当前周被从骨架中丢掉，`current = null`，今天页无阶段/量带卡片，`weeklyCapacity` 的阶段系数失效；文档口径是"≤24 周"支持。
  - R-02：`rai-prescription-v1` 的六位小数格式 TS 与 Swift **在十进制半值输入上结果不同**（`1.0000005`：TS `1.000001` / Swift `1.000000`）；`≥1e21` 也不同。当前生产路径因结构规范化（取整）而不可达，但契约与 fixture 未覆盖该边界。
- **5 条 P3**：弱日期校验重复实现（R-03）、摘要分隔符碰撞未被契约强制（R-04）、赛前保护 14 天常量在赛卡处硬编码（R-05）、D13 中"`phases` 仍以 base 填充"的文档记录已过时（R-06）、`generateWeeklyPlan` 的 `automaticDosePolicy` 形参被忽略且两个计数恒为 0（R-07）。
- **文档声明的未决项经复核仍在**（非缺陷，见 §5）：`replanAdvice` 无"低于量带下限"建议（B1 未实现）；`consecutive_low_volume_weeks` 文案仍写"当前周量可能已经不现实"，而判据只统计已结束周。
- 摘要专项（§4）：fixture 3 例 TS/Swift 双向一致；我另造 12 组边界输入，整数/小数/心率告警/`-0`/小负数/空结构/多 block 均一致，仅半值与 `≥1e21` 不一致。
- D16 复核：`PHASE_BOUNDARIES` 是唯一阶段边界定义，`runCoachPhase`、`executionPolicyContext`、`weeklyCapacity`、`phaseForPlanDate`、`coach-loop-runtime` 全部委托 `plan-periodization`，未见第二套 build/taper 推导。
- D14 复核：今天页量带与排课预算均取 `recentWeeklyKm`（最近 4 个完整自然周、窗口外与当前周不计、空周不缩短分母，`data.ts:136-150`）；"基线 vs 已收敛上限"两个角色在 `data.ts:826-845`、`weekly-plan-service.ts:177`、`manual-plan-policy.ts:48` 分开传，未见把已收敛上限再喂回 `weeklyPlanVolumeCeiling` 的复合收紧。

## 3. 发现（P0–P3）

### R-01（P2，已证实）周期化骨架在"恰好 24 周"边界丢掉当前周与阶段系数

- 位置：`apps/api/src/plan-periodization.ts:247-250`、`:256`、`:259-265`、`:291-292`。
- 关键代码：

```ts
// :247
if (weeksToRace > PERIODIZATION_MAXIMUM_WEEKS) reasonCodes.push("race_beyond_maximum_horizon");
...
// :255-256  注释："24 weeks means 24 rows, not 25"
const firstOffset = Math.max(0, weeksToRace - (PERIODIZATION_MAXIMUM_WEEKS - 1));
for (let offset = firstOffset; offset <= weeksToRace; offset += 1) {
  const weekStart = shiftDate(raceWeekStart, -7 * (weeksToRace - offset));
  if (weekStart < currentWeekStart) continue;          // 恰好 24 周时 offset=0 被 firstOffset 排除
  ...
}
// :291-292
const current = weeks.find((week) => week.weekStart === currentWeekStart) ?? null;
if (current === null && weeks.length > 0) reasonCodes.push("current_week_outside_window");
```

- 现象：`weeksToRace === 24` 时（只拒绝 `>24`），`firstOffset = 1`，当前周的 offset=0 行不被枚举；返回 24 行（23 周前 → 比赛周），`current = null`，并附带未在文档出现的 `current_week_outside_window`。`weeksToRace = 23` 及以下正常。
- 证据（`/tmp/periodize-check.mts`、`/tmp/boundary24.mts`，half_marathon）： 

```
weeksToRace=23 rows=24 current=base@2026-10-05 first=2026-10-05 reasons=
weeksToRace=24 rows=24 current=null first=2026-10-12 reasons=current_week_outside_window
weeksToRace=25 rows=24 current=null reasons=race_beyond_maximum_horizon,current_week_outside_window

weeksToRace=23 todayPageCurrent=base capacityPhase=base baseline=36.75 reasons=race_target_baseline
weeksToRace=24 todayPageCurrent=null capacityPhase=null baseline=35    reasons=race_target_baseline
```

- 影响：
  1. 距比赛 168 天（按自然周对齐）的那一周，今天页 `periodization.current === null` → iOS 阶段/量带卡不渲染（`apps/ios/RAI/Skins/Technology/TechCoachWeekSection.swift:7,35` 读的是 `MobilePeriodizationWeek?`），但教练页 `runCoachPhase` 走 `?? periodizationPhaseFor` 仍返回 `base` → **同一周两个界面一个有阶段、一个没有**。
  2. `weeklyCapacity` 的 phase 变 `null`（`weekly-capacity.ts:121-123`），比赛基线不再乘 base 系数：half 目标 baseline 35 而非 36.75；`replanAdvice` 的"计划高于量带上限"也因 `periodization.current === null` 不参与判断（`plan-adherence.ts:226-232`）。
  3. `current_week_outside_window` 只在此边界出现，容易把"支持的 24 周"读成"超窗"。
- 测试缺口：`apps/api/test/plan-periodization.test.ts:89-96` 只测 40 周（断言 24 行），未测恰好 24 周；`run-coach-phase.test.ts` 也未覆盖 24 周边界。
- 建议（二选一，需先确定口径）：
  - 若"≤24 周"包含当前周：`weeksToRace > PERIODIZATION_MAXIMUM_WEEKS - 1` 才报超限，或 horizons 允许 25 行（含当前周时 24 行是"比赛周 + 23 周预备"）。
  - 若原意是"24 行含比赛周、当前周在窗口外"：把边界改为 `weeksToRace >= PERIODIZATION_MAXIMUM_WEEKS` 报 `race_beyond_maximum_horizon`，并更新 `docs/ALGORITHM.md:157` 的"≤24 周"表述；同时补恰好 24 周（和 23 周）断言 `current !== null` 或 `current === null` 的显式测试。
- 验证状态：已证实（合成输入复算 + 代码路径）。

### R-02（P2，已证实差异；生产可达性受限）`rai-prescription-v1` 六位小数在 TS/Swift 十进制半值上不一致

- 位置：
  - `apps/api/src/plan-digest.ts:17` `const number = (value) => value == null ? "~" : (Object.is(value, -0) ? 0 : value).toFixed(6);`
  - `apps/ios/RAI/PlanStatePolicy.swift:130-133`

```swift
func number(_ value: Double?) -> String {
    guard let value else { return "~" }
    return String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), value == 0 ? 0 : value)
}
```

- 现象：JS `toFixed(6)` 对**精确二进制值**取最近、平局取大；Swift 带 `locale:` 的 `String(format:)` 走十进制最短表示 + 半偶（half-even）。对第 7 位小数为 5 的输入两者会给出不同的六位小数，从而得到**不同的 SHA-256**。
- 证据（用真实 Swift 源码 + 同一 JSON 输入；脚本 `/tmp/digestswift/`、`/tmp/digest-ts.mts`）：

```
rounding-half  meters=1.0000005   TS digest 3bcf1809…  Swift digest a99631db…   DIFF
big-1e21      meters=1e21        TS digest b4e5f5f7…  Swift digest 8bc54bed…   DIFF（TS 输出 "1e+21"，Swift 输出完整十进制）
```

格式层对照（同值不同格式）：

| 值 | TS `toFixed(6)` | Swift `String(format:"%.6f",locale:)` |
| --- | --- | --- |
| `1.0000005` | `1.000001` | `1.000000` |
| `1.0000015` | `1.000001` | `1.000002` |
| `2.0000005` | `2.000001` | `2.000000` |
| `1e20` | `100000000000000000000.000000` | 同左（一致） |
| `1e21` | `1e+21` | `1000000000000000000000.000000` |

- 影响：若同一结构的摘要在两端计算，可能把同一处方判成"不同"，导致回执 `plan_receipt_key_conflict` / `matchesCurrent=false` / 租约失效。**但当前生产路径不可达（已核实两道闸门）**：
  1. 写入/读取课表都先经 `normalizeSessionStructure`（`session-structure.ts:80-95`：meters/seconds `Math.round`，alert 也取整），持久化结构全是整数；`1.0000005 m` 规范化后为 `1 m`。
  2. 新版回执在比较前要求"结构等于其规范化结果"：`apps/api/src/coach-loop-device-sync.ts:23-24` `digest(normalizeSessionStructure(body.structure)) !== digest(body.structure)` 否则 422；实测 `normalize(1.0000005) !== 1.0000005`（digest 不等）。
- 结论：这是**契约与 fixture 的潜在缺陷**，不是当前线上可触发的错误；一旦有人绕过 `normalizeSessionStructure` 直接把用户/网络结构交给 `prescriptionDigest`（该函数是 `export`，且文档称其为跨端身份），立刻变成真实分歧。
- 测试缺口：`apps/ios/tests/fixtures/prescription-digests.json` 仅 3 例（null / 4 km distance / interval），没有小数、没有 `heart_rate` 告警、没有上下界。TS 侧 `apps/api/test/training-plan-state.test.ts:24-28` 与 iOS `PlanWatchSchedulingRegression.swift:17-23` 都只回放这 3 例。
- 建议：
  - 让两端都先对数值做十进制规范化（例如统一 `Number(value.toFixed(6))` 或先 `Math.round(value * 1e6)` 再格式化），或在契约层明确"输入必须为整数"并由 `prescriptionDigest` 内部断言/抛错。
  - 至少补 fixture：`1.0000005`、`1.0000015`、`-0`、`-1e-9`、`heart_rate` 告警、两 block、`blocks: []`；在 fixture 测试里同时校验格式化函数而非只比哈希。
- 验证状态：差异已证实；生产不可达已用 normalization 闸门证实；"未来某路径可达"待确认。

### R-03（P3，已证实弱校验；上游目前严格）周期化模块内重复且宽松的日期校验

- 位置：`apps/api/src/plan-periodization.ts:120`、`apps/api/src/weekly-capacity.ts:68`，对照严格实现 `apps/api/src/local-date.ts:2-13`。
- 代码：`const isLocalDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));`
- 现象：V8 会把 `2026-02-30T00:00:00Z` 规范化为 3 月 2 日，因此 `2026-02-30` 被当作合法本地日期；`buildPeriodization` 的 `generatedFor` 保留原串，但 `weekStart` 变成 `2026-03-02`。`weeklyCapacity` 的 `isLocalDate` 更弱（仅正则，不解析）。
- 证据：`/tmp/periodize-check.mts`

```
invalid today accepted: 2026-02-30 "2026-03-02"
```

- 影响：当前上游都有严格校验——`normalizeRaceTarget`（`mobile-goals.ts:894-897`）和 `validateRunCoachConfig`（`run-coach-policy.ts:27`）用 `isValidLocalDate`（真实历法），所以 API 正常写入路径不可达。但 `periodizationPhaseFor` 是导出函数（`race-plan-policy.ts:59-60` 调用，文档保证"callers hold a validated plan"），一旦有新的调用方、手工改库或导入捷径，非法日期会被**静默移到邻日**而不是报错（与 `workout-date-window.isValidWorkoutDate:4-6` 的"规范化后必须逐字相等"做法相反）。
- 建议：删除本地复制的 `isLocalDate`，统一改用 `local-date.isValidLocalDate`；若保留解析路径，加"`toISOString().slice(0,10) === value`"断言（与 `workout-date-window.ts:4-6` 同款）。
- 验证状态：已证实（合成输入）；生产可达性低（上游严格）。

### R-04（P3，已证实）摘要分隔符碰撞：`kind` 未做枚举/分隔符约束，`|` 可制造跨结构同哈希

- 位置：`apps/api/src/plan-digest.ts:16-33`（`parts = ["rai-prescription-v1", kind]`，`parts.join("|")`）；文档要求见 `docs/IOS_TRAINING_PLAN_STATE_V1.md:36`"字段枚举不允许分隔符；结构顺序不能重排"。
- 现象：`kind` 是 `string` 且函数不校验。构造 `kind = "easy|~|0"` 且 `structure = null`，其拼接结果为 `rai-prescription-v1|easy|~|0|~`，与 `kind = "easy"`、`structure = {warmup:null, blocks:[], cooldown:null}`（编码恰为 `~|0|~`）**完全相同**。
- 证据：`/tmp/collision.mts` 与 Swift harness（`/tmp/digestswift/cases2.json`）：

```
A easy   + {null,[],null} → 6f72c038289670f5aa4d2016c92ffb830ae7e837a96baad17e704808e2258bb0
B "easy|~|0" + null      → 6f72c038289670f5aa4d2016c92ffb830ae7e837a96baad17e704808e2258bb0   collision=true
Swift 两例同为 6f72c038…（两端"一致地碰撞"）
```

- 影响：两端行为一致，且现有消费方对 `kind` 有独立相等校验（`mobile-goals.ts:475` `SESSION_KINDS.has`；`coach-loop-device-sync.ts:35-36,55-56` 要求 `current.today.day.kind === body.kind`、`historicalDay.kind === body.kind`），因此**未发现可利用路径**。但摘要函数的契约声明"枚举不允许分隔符"并未实现，未来若新增按摘要匹配而省略 kind 等值校验的调用点（或把自定义课型字符串传入），会变成可伪造"同一处方"。注意这不是跨端分歧（TS/Swift 同撞）。
- 建议：`prescriptionDigest` 开头断言 `kind` 属于 `MOBILE_SESSION_KINDS`（或至少不含 `|`/`~`），或改为长度前缀/JSON 数组序列化替代裸 `join("|")`；在 fixture 加一条"非法 kind 必须抛错"的测试。
- 验证状态：碰撞已证实；可利用性经代码路径核查未发现。

### R-05（P3，已证实）赛卡"减量"判断硬编码 14，未用唯一常量

- 位置：`apps/api/src/mobile-coach.ts:1340` `const taper = days != null && days >= 0 && days <= 14;`；唯一常量在 `apps/api/src/race-plan-policy.ts:7` `PRE_RACE_EXECUTION_PROTECTION_DAYS = 14`。
- 影响：`raceExecutionProtection`（`race-plan-policy.ts:12-22`）与赛卡是两个 14；一旦保护窗口被评为别的值（例如赛前 10 天），赛卡说明与执行限制会不同步——正是 D16/§20 反复消除的那类"同一个问题两个答案"。另外 `days >= 0` 把**比赛日当天**也算成 `taper=true`，文案会写"进入减量"。
- 建议：改用 `raceExecutionProtection(input.today, target.date)` 的 `preRace`（与执行限制共享），比赛日单独判断。
- 验证状态：已证实（静态对照）；属展示文案层。

### R-06（P3，文档漂移）`docs/DECISIONS.md` D13 称 `phases` 仍以 `"base"` 填充，代码已改为空数组

- 位置：`docs/DECISIONS.md:144`（"同批**未**处理、留待单独决定：`phases` 区间数组对无骨架计划仍以 `"base"` 填充"）对照 `apps/api/src/run-coach.ts:303-311`：

```ts
for (let date = plan.startedOn; date <= runCoachEndDate(plan); date = runCoachShiftDate(date, 1)) {
  const phase = runCoachPhase(date, plan);
  if (phase === null) continue;   // 无骨架 → 不填充
```

以及 `apps/api/test/run-coach.test.ts:586-589` 明确断言 `response.phases` 为 `[]`。
- 影响：文档把已解决的口径列为未决，容易让后续维护者"按文档补回 base 填充"，反而破坏现在的契约。代码本身正确（与 `phase: null` 自洽）。
- 建议：更新 D13 末段（或在 DECISIONS 中追加"2026-10-18 复核：已改为空数组并由 run-coach.test 锁定"），避免反向漂移。
- 验证状态：已证实（代码 + 测试）；该测试文件因环境原因本机未能运行，但断言内容为读码所得（环境失败原因见 §1）。

### R-07（P3，已证实）`generateWeeklyPlan` 忽略 `automaticDosePolicy` 形参；`rejectedCount`/`clampedCount` 恒为 0

- 位置：`apps/api/src/weekly-plan-service.ts:113-120`、`:127-128`、`:141-146`。
- 代码：

```ts
  /** Automatic generation only; manual/legacy validation keeps its stored text. */
  automaticDosePolicy?: boolean;
  ...
  const finish = (proposed) => constrainUpcomingPlan(proposed, { ...args, automaticDosePolicy: true }, warnings);
```

调用方传 `false`/不传都被强制为 `true`；而类型与注释暗示该开关可区分"自动生成 vs 手工/旧校验"。同时 `rejectedCount: 0, clampedCount: 0` 是硬编码，注释（`:16-18`）却称"Counters useful for the API response and for after-the-fact review"——`warnings` 里实际有 rejected/clamped 文案。
- 影响：目前没有消费者读这两个计数（grep 仅本文件），所以是**契约/审计不一致**而非线上错误；一旦预览/审计界面开始使用计数，"0 拒绝、0 钳制"会与 warnings 直接矛盾。形参被静默覆盖则让未来想复用此函数做旧策略对照的人得到错误行为。
- 建议：要么删除这两个形参与计数字段（并更新注释），要么从 `constrainUpcomingPlan` 的 validation 结果回填真实计数并尊重调用方传入的 `automaticDosePolicy`。
- 验证状态：已证实（静态与 grep）。

## 4. 摘要一致性专项（TS / Swift / fixture）

### 4.1 规则逐项对照

`rai-prescription-v1`（`docs/IOS_TRAINING_PLAN_STATE_V1.md:36`）要求：固定顺序 = 训练类型、warmup、block 数量、iterations、step 数量、各 step 的 purpose/goal 类型/剂量/alert 类型/上下界、cooldown；`|` 分隔；null→`~`；数值六位小数；距离米/时长秒/配速秒每公里/心率 bpm；UTF-8 SHA-256；枚举不允许分隔符；结构顺序不能重排。

| 规则 | TS（`plan-digest.ts`） | Swift（`PlanStatePolicy.swift`） | 结论 |
| --- | --- | --- | --- |
| 前缀/kind 顺序 | `["rai-prescription-v1", kind]` | 同 | 一致 |
| null 结构 | `push("~")` | `append("~")` | 一致 |
| null step（warmup/cooldown） | `step(null) = ["~"]` | `guard let ... else ["~"]` | 一致（但**缺字段**而非 `null` 时 TS 会 `TypeError`，Swift 解为 nil；仅非规范输入） |
| goal 编码 | `distance`→`["distance", n]`；`time`→`["time", n]`；`open`→`["open","~"]` | 同 | 一致 |
| alert 编码 | `kind ?? "~"`, `number(lower)`, `number(upper)` | 同 | 一致 |
| block 编码 | `number(iterations)`, `String(steps.length)` | `number(Double(iterations))`, `String(count)` | 一致（整数） |
| 数字格式 | `toFixed(6)`；`-0`→`0` | `%.6f`（locale）+ `value == 0 ? 0` | **半值输入不一致**（R-02） |
| `≥1e21` | `1e+21` | 完整十进制 | **不一致**（整数上界 100000 使其不可达） |
| 哈希 | `sha256(utf8(joined))` hex | 同 | 一致 |
| kind 分隔符 | 不校验 | 不校验 | 一致（但都弱，R-04） |

### 4.2 实测对照（真实 Swift 源码编译 + 同一 JSON 输入）

通过 `xcrun swiftc` 编译 `APIModels.swift` + `PlanStatePolicy.swift` 与 `/tmp/digestswift/main.swift` 得到 `PlanFingerprint.prescriptionDigest` 的真实输出，与 `node --import tsx` 调用 TS `prescriptionDigest` 对比：

| # | 输入 | TS | Swift | 一致 |
| --- | --- | --- | --- | --- |
| 1 | fixture easy + null | `db18762a…` | 同 | ✅ |
| 2 | fixture easy + 4 km | `16ae0248…` | 同 | ✅ |
| 3 | fixture interval（6×800m，pace 270–300，open cooldown） | `57369dd2…` | 同 | ✅ |
| 4 | warmup `heart_rate` 100–150（fixture 未覆盖） | `20c96b05…` | 同 | ✅ |
| 5 | 小数：4000.5 m / 90.25 s / pace 270.5–300.25 | `78795056…` | 同 | ✅ |
| 6 | 单侧 alert（lower=null, upper=150） | `ed123557…` | 同 | ✅ |
| 7 | `-0` / `0` alert 界 | `2fa9e13a…` | 同（`0.000000`） | ✅ |
| 8 | `-1e-9` / `1e-9` | `b7bff85c…` | 同（`-0.000000`） | ✅ |
| 9 | `meters=1.0000005` | `3bcf1809…` | `a99631db…` | ❌ R-02 |
| 10 | `meters=1e20` | `d5978dd3…` | 同 | ✅ |
| 11 | `meters=1e21` | `b4e5f5f7…` | `8bc54bed…` | ❌ R-02（不可达） |
| 12 | 两 block（tempo 3×480s + 1×1000m） | `3dfa45b4…` | 同 | ✅ |
| 13 | iterations=20 × 3 steps | `20856f5f…` | 同 | ✅ |
| 14 | `kind="easy|x"` + null / `kind="easy"` + 空结构 | 两端各自与对方一致；但 `"easy|~|0"` 与空结构碰撞 | ❌ 契约（R-04） |

fixture 覆盖评估：`apps/ios/tests/fixtures/prescription-digests.json` 只有 3 例，**未覆盖** `heart_rate` alert、多 block、`-0`/负零/极小负数、小数半值、各字段上界（100000 m / 14400 s / 1200 s/km / 240 bpm / 20 iterations / 8 blocks）、空 `blocks: []`、`kind` 非法。建议把上表 4–14 中"一致"的用例补进 fixture（尤其是 R-02 之前先统一格式），并保留一条"非整数输入必须拒绝或被规范化"的回归。

## 5. 与文档契约的偏差

### 5.1 已核对且一致（正向结论）

- **D16 单一来源**：`PHASE_BOUNDARIES` 只在 `plan-periodization.ts:67` 定义；`phaseFor` 唯一；`runCoachPhase`（`run-coach-policy.ts:73-78`）、`executionPolicyContext`（`race-plan-policy.ts:59-60`）、`weeklyCapacity`（`weekly-capacity.ts:121-123`）、`phaseForPlanDate`（`weekly-plan-service.ts:21-34`）、`coach-loop-runtime`（`:233,301,350,386`）全部委托；未发现第二套 build/taper 推导。
- **D14 同源**：`recentWeeklyKm`（`data.ts:136-150`）取 `[本周一-28d, 本周一)`，空周不缩短分母；`weeklyCapacity` 的 B/P/H、28 日/8 日资格（`weekly-capacity.ts:210-215`）与文档 `docs/ALGORITHM.md:164-176` 一致；"基线/已收敛上限"两个角色分开传（`data.ts:834-845` 给 coach 上限、`:933` 给执行器基线）；`weeklyPlanVolumeCeiling` 对输入不幂等这一约束在生成/手工/校验三处均为单次应用。
- **G02/G03 语义**（`docs/ALGORITHM.md:180-185`）：每日本地午夜冻结、午夜无处方取当日首版、未来用最新版、休假日不计义务、未观测→`unknown` 不判"没练"、无要求训练的周不判 `met`——`plan-adherence.ts:100-180` 与测试 `plan-periodization.test.ts:160-320` 覆盖，定向测试 27/27 通过。
- **G05 保护**：`raceExecutionProtection`/`unsupportedRaceExecutionProtection` 是同一对纯函数，生成与有效读取共享（`race-plan-policy.ts:12-42`、`weekly-plan-service.ts:156-158`）；`executionPolicy` 只读元数据不含放行能力。
- **剂量**：`coach-session-dose.ts:104-113` 的 1800 秒下限、interval 4×800m、tempo 3×8min、easy work 1200s 与 `docs/ALGORITHM.md:198-200`/`DECISIONS.md:98` 一致；距离步按快/慢端取区间、时间步按快端计 km、快端 360s/km 冷启动仅用于非追加资格（`:82-88`），与文档"不用于追加资格"一致。
- **执行窗口日期数学**：`shiftMobileDate`/`periodizationWeekStart`/`buildPlanExecution` 全部用 UTC 解析本地日期串（无 DST 影响），跨年/闰年实测正确（`2027-01-01`→周一 `2026-12-28`；`2028-02-29`→`2028-02-28`；`2024-02-29`→`2024-02-26`）；`ISO_UTC_OFFSET` 由 `DATABASE_UTC_OFFSET_HOURS` 派生（`packages/contracts/src/timezone.ts:45-47`），Asia/Shanghai 1991 后无 DST，固定 +08:00 正确。
- **plan-execution 窗口**：`buildPlanExecution` 返回 `[today-7, today-1]` 连续 7 日，边界按上海午夜 `Date.parse(localDateT00:00:00+08:00)` 冻结，同日写入不推断（`plan-execution.ts:14-21`，测试 `plan-execution.test.ts:36-45` 锁定）。与 `plan-adherence` 的"当日首版"策略不同，但代码注释与测试都明确这是有意差异（执行条 vs 义务冻结）。

### 5.2 文档声明为"未决/未实现"，代码确实仍未实现（非缺陷，仅复核结论）

- **"低于量带下限无建议"仍在**：全仓无 `plan_below_phase_band`；`replanAdvice` 仅两条判据（`plan-adherence.ts:214-237`）。与 `docs/TODAY_PLAN_CARDS_REVIEW.md:38-45`（C2，"剩下的一半仍在"）一致。
- **"本周/已结束周混用文案"仍在**：`plan-adherence.ts:217` 仍写"…当前周量可能已经不现实。"，而 `completedWeeks` 判据只统计已结束周（`:203`）。与 `TODAY_PLAN_CARDS_REVIEW.md:47-55`（C3）及方案 A3 一致——文档标注"未决（本轮只诊断，未改任何代码）"，不计缺陷。
- `weeklyPlanVolumeCeiling` 的可选第三参 `phaseCapFraction` 在生产调用中没有实参（仅测试 `plan-periodization.test.ts` 使用）；文档措辞是"既有调用方上限一字不变"，并未声称生产已接，故不算漂移；但若期望"阶段直接限制 ramp 上限"，目前是经 `phase.volumeBandKm.upper` 在 `weekly-plan-service.ts:177` 生效，二者不要混淆。

### 5.3 其它小偏差

- `docs/ALGORITHM.md:208` 提到"无骨架赛事使用原两天'禁止质量/长课'的兼容保护"：`applyUnsupportedRacePlanPolicy`（`race-plan-policy.ts:31-42`）与 `constrainUpcomingPlan`（`weekly-plan-service.ts:156-158`）已接；但 `executionPolicyContext` 对 `unsupported` 返回的 `pre_race_execution_protection` 约束是 `no_quality_or_long_run`，与两天兼容规则一致。
- `race-candidate.ts` 与 §12.13 一致：±3% 距离、150–900 s/km、12 min–4 h、更快于自身中位配速 5%、`localDate|distance` 去重键（`race-candidate.ts:87-88,94-145`）。

## 6. 未覆盖项

1. **`apps/api/test/run-coach.test.ts` / `mobile-coach.test.ts` 未能在本机运行**（ONNX 原生绑定代码签名 `ERR_DLOPEN_FAILED`，环境问题）。R-06 的测试断言与 run-coach 预算断言均来自读码，不是执行证据。
2. **未运行全量 `npm test` / `npm run typecheck` / `npm run test:ios`**（按任务要求只跑定向测试）；Swift 侧只编了一个摘要 harness，没有跑 iOS 模拟器/真机与 WorkoutKit 映射。
3. **未使用真实数据库**：本机 `var/` 下没有当前库；所有日期/容量/依从性结论均来自合成输入与代码路径，未在真实 `/v1/mobile/today` payload 上复算。
4. `weekly-plan-validate.ts` 1,027 行中，我逐行读了导出入口与 `validateWeeklyPlan` 主体、`fitWeekToCeiling`/`scaleDistances`/`clampStepTargets`/`demoteToEasy`/`applyRacePlanPolicy`/`buildCoachWeekPlan` 关键段；`clampStepTargets` 的配速上界（只抬下限、不压低过慢上限）与 `clampIntervalReps` 截断后的时长/距离重测未做穷举式突变验证。
5. `coach-loop-runtime.ts`、`coach-loop-device-sync.ts`、`weekly-plan-preview.ts`、`run-coach.ts` 的写入事务/幂等分支只是为核对摘要与周期化接线而读，未按完整审计标准审查。
6. 摘要一致性：未做随机/属性测试（fuzz），未覆盖 ICU/Node 版本差异对 `toFixed`/`%.6f` 的影响；未验证 Swift 在 arm64 设备上的 `%.6f` 行为（本机 x86_64 macOS 26）。
7. 未评估 `stableJson`（`plan-digest.ts:4-12`）的 `localeCompare(..., "en")` 在不同 ICU 版本下的排序稳定性；它只用于服务端内部比较，目前无跨端消费。

## 7. 复现脚本（均在 `/tmp`，未纳入仓库）

- `/tmp/periodize-check.mts`：24 周边界、量带、闰年/跨年、非法日期。
- `/tmp/boundary24.mts`：23 vs 24 周的今天页 current 与 capacity baseline/phase。
- `/tmp/digest-ts.mts` + `/tmp/digestswift/`（`main.swift`、`cases.json`、`cases2.json`、编译出的 `digesttest`/`digesttest2`）：TS/Swift 摘要实测对照与碰撞。
- `/tmp/collision.mts`、`/tmp/reach.mts`：分隔符碰撞、规范化闸门可达性。

## 8. 证据目录（仓库内）

- 现有测试：`apps/api/test/plan-periodization.test.ts`、`plan-execution.test.ts`、`run-coach-phase.test.ts`、`weekly-plan.test.ts`、`race-candidate.test.ts`、`session-structure.test.ts`、`coach-*.test.ts`。
- fixture：`apps/ios/tests/fixtures/prescription-digests.json`；iOS 摘要实现：`apps/ios/RAI/PlanStatePolicy.swift:114-155`；TS 摘要实现：`apps/api/src/plan-digest.ts:16-34`。
