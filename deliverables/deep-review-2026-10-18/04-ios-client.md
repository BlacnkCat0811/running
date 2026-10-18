# Lane 4：iOS 客户端（apps/ios）深度审查

- 审查对象：`git HEAD = 24aa7d8`（工作树干净），重点为 `09ed8d0`（跑步动态迟到样本补读 + 空窗水位修正）与 `09ed8d0..HEAD`（回执 v2 / Retry-After / 状态机 / 提醒 / 时区 / 文案，iOS 侧 27 个文件）。
- 审查方式：**只读**代码审查 + 实跑 `npm run test:ios`。未修改任何被跟踪文件，未使用真实健康数据或 `var/` 库，未尝试真机。
- 严重度定义：P0 数据丢失/安全漏洞/生产不可用；P1 发布阻断或契约/安全语义被破坏；P2 用户可见错误或高概率边界缺陷；P3 低影响/防御性/可维护性。

---

## 0 结论摘要

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 0 | 未发现数据丢失、凭证泄露或生产不可用级缺陷 |
| P1 | 0 | 未发现发布阻断或契约语义被破坏（回执 v2 wire 形状、处方摘要跨语言一致性、503/Retry-After 分类均与 `apps/api` 一致） |
| P2 | 1 | 迟到样本补读不设批内份额，可把整批预算吃光（见 I1） |
| P3 | 9 | 窗口/分页边界三处、文案与诊断口径、测试门禁强度等（见 I2–I10） |

总体判断：**iOS 客户端本轮改动（回执 v2、Retry-After、状态机、教练闭环提醒、业务时区）质量高于上一轮**，其共同特征是把"隐式约定"抽成纯函数 + 回归（`HealthKitRecordCursor` / `RecordReplayPlan` / `RecentWindowAccounting` / `LateDynamicsBackfill` / `PlanFingerprint` / `TrainingReminderPolicy.context`），并且 `npm run test:ios` 实跑全绿（exit 0、1132 条 PASS、29 组回归/门禁摘要）。本轮**没有**发现需要阻断发布的问题；唯一 P2 是新增的迟到样本补读通道与既有批预算之间的份额缺失 —— 它的失效方向是"同步变慢/其它类型被饿"，不是数据丢失，且自限（记完账即恢复）。9 条 P3 里最值得先做的是 I4（同一段代码里两条互相矛盾的注释，指向的正是 2026-10-14 那个事故的成因）与 I6/I7（安全/身份判据里的兜底默认值与错误文案分类）。

---

## 1 范围与方法

### 1.1 覆盖范围

- `apps/ios/RAI/`（54 个 Swift 源文件）重点读：`HealthKitExport.swift`(2361) 的记录分页/窗口/补读段，`HealthKitRecordCursor.swift`(287)，`DirectSyncBatchBudget.swift`，`HealthKitSync.swift`(3252) 的后台生命周期/单飞闸门段，`BackgroundUploadSession.swift`(297)，`APIClient.swift` 的 `Retry-After`/错误分类，`NativeAppModel.swift`(1950) 的读取面板/回执增强/计划写段，`TrainingPlanStore.swift`(502)、`TrainingPlanRepository.swift`、`PlanStatePolicy.swift`、`PlanScheduleOperationJournal.swift`、`PlanWatchScheduling.swift`、`PlanReceiptMatcher.swift`、`TrainingReminderPolicy.swift`、`CacheStore.swift`(493)、`Keychain.swift`、`ServerSession.swift`、`NativeViews.swift`、`Info.plist`。
- `apps/ios/tests/`：`run-ios-gates.sh`、`run-model-tests.sh`、`run-health-sync-tests.sh`、`check-healthkit-record-sync.py`、`HealthKitRecordCursorRegression.swift`、`fixtures/prescription-digests.json`。
- 文档：`docs/adr/ADR-004-healthkit-sync-invariants.md` 的判据段落（用于确认"先前已修 vs 当前仍存在"）。
- 对照实现：`apps/api/src/api-error.ts`、`apps/api/src/plan-digest.ts`、`apps/api/src/mobile-goals.ts`（只用于核对客户端与服务端的契约/摘要/分类一致性，不在本 lane 的发现范围内）。

### 1.2 实跑结果（`npm run test:ios`）

命令：`npm run test:ios` → `node scripts/run-ios.mjs gates` → `apps/ios/tests/run-ios-gates.sh`（`set -e` 链接 `typecheck-ios.sh` + `run-model-tests.sh`）。

```
类型检查 94 个文件（已跳过 3 个仅依赖高德 SDK 的文件）

iOS 类型检查通过
...
iOS 门禁通过（类型检查 + 纯逻辑回归）
EXIT_CODE=0
```

- 退出码：**0**；`^PASS` 行合计 **1132** 条；回归/门禁摘要 **24** 组，含：
  - `All model regression checks passed`、`Plan scheduling regression: 88 checks`、`TrainingPlanStore regression: 54 checks`、`Direct sync receipt regression: 141 checks`、`HealthKit record cursor regression: 45 checks`、`77 sync-state commit regression checks`、`128 route state persistence regression checks`、`106 store regression checks`、`Technology presentation: 200 checks`；
  - python 结构门禁：`Background capability checks: 297 checks, 0 failed`、`Export determinism checks: 14 checks, 0 failed`、`HealthKit record sync wiring: 78 checks, 0 failed`、`Direct-sync status copy checks passed (55 checks)`、`Direct-sync contract parity checks passed (21 checks)`、`OK: analysis terminal-state reconciliation gate (43 checks)`。
- 与本轮改动直接相关的实跑证据（摘录自同一份日志）：
  - 处方摘要跨语言 parity：`PASS: cross-language deterministic prescription digest …` ×9（含 half-up 微单位、`-0`、`heart_rate`、多 block、1e9 边界）+ `PASS: shared digest fixture covers half-up micro quantisation, -0, heart_rate, multi-block and the 1e9 bound`；
  - 回执 wire 形状：`PASS: non-coach v2 receipt writes explicit null warmup/cooldown/alert for the canonical digest`、`PASS: recovered replacement events retain the old actual UUID/time/prescription evidence`；
  - Retry-After：`PASS: 503 with Retry-After: 1 becomes a retryable server error carrying the hint`、`PASS: 503 with an HTTP-date Retry-After stays .server`、`PASS: Retry-After: 9 is clamped to five seconds`、`PASS: 429 keeps the legacy server error plus its retry hint`；
  - 游标状态机：`HealthKit record cursor regression: 45 checks passed`。

时间型断言漂移说明：本次运行与其它 lane 并行、CPU 有争用，但本 lane 的回归断言均为逻辑断言（无墙钟阈值），日志中未见 flaky/重试痕迹；耗时本身不作结论使用。

### 1.3 明确未验证项（不得当作已通过）

| 项 | 原因 |
| --- | --- |
| `apps/ios/tests/run-visual-tests.sh`（Simulator 视觉验收） | 需要 booted Simulator + `var/rai.sqlite`（`var/` 不入库），本环境不满足；**未运行** |
| `apps/ios/tests/run-coordinate-sdk-check.sh` | 需要 `apps/ios/Pods` + Simulator；**未运行** |
| `npm run test:ios:live`（导出确定性真机/模拟器执行） | 需把探针装进模拟器；`test:ios` 只跑 `check-export-determinism.py` 的**结构**门禁；**未运行** |
| `npm run test:ios:mutation`（判据有效性突变验证） | 该门禁会逐条**改坏 Swift 源码**再跑门禁，与本轮"只读、不得修改被跟踪文件"的约束冲突；**未运行**。因此本轮所有 python 结构门禁的"有效性（能不能被绕过）"均为**未验证**，只验证了"当前跑绿" |
| HealthKit 真机行为（background delivery、锁屏、Watch→iPhone 传输延迟、背景 URLSession 跨进程续传） | 无真机，只能代码阅读；相关结论一律标 E2/E3 |
| Swift 6 严格并发检查 | 仓库以 `-default-isolation MainActor` + Swift 5 模式编译（`typecheck-ios.sh` / `run-model-tests.sh:59`），未见 `-strict-concurrency=complete`；并发结论为代码阅读 |

### 1.4 证据等级定义（下文每项标注）

- **E1 已跑测试/已复现**：有本次实跑输出或可复现命令。
- **E2 代码阅读 + 交叉核对**：读码得出结论，且与服务端/契约/文档另一处实现互相印证。
- **E3 代码阅读推断**：仅读码推断，未执行（涉及 HealthKit/iOS 运行时行为的多为 E3）。

---

## 2 发现清单

| ID | 严重度 | 标题 | 位置 | 证据等级 |
| --- | --- | --- | --- | --- |
| I1 | P2 | 迟到样本补读只用全量批预算、不占窗口份额，可整批吃光预算并饿住 anchor 流与窗口 pass | `apps/ios/RAI/HealthKitExport.swift:1364-1398`；`HealthKitRecordCursor.swift:242`；`DirectSyncBatchBudget.swift:52-58,90-92` | E2 |
| I2 | P3 | 空窗水位永不推进 ⇒ 重放期间每批对每个空类型重复一次 48h 查询（无界重试，靠 30 天兜底） | `apps/ios/RAI/HealthKitExport.swift:1519-1530`；`HealthKitRecordCursor.swift:215-224` | E2 |
| I3 | P3 | 补读分页下界按**当前** `now` 重算 14 天窗口 ⇒ 多批补读时窗口前缘漂移，最老一小段被永久跳过却记"已完成" | `apps/ios/RAI/HealthKitExport.swift:1371-1372,1404,1412` | E2 |
| I4 | P3 | 同一段代码里两条互相矛盾的注释（"空结果同样记账" vs "空页不记账"），指向的正是 2026-10-14 事故成因 | `apps/ios/RAI/HealthKitExport.swift:1358-1359` vs `:1424-1428` | E1（逐行原文） |
| I5 | P3 | "该有却没有"告警只在重放/首装期间可能触发；稳态（2026-10-14 事故的真实状态）恒不触发 | `apps/ios/RAI/HealthKitExport.swift:1467-1470,1546-1556` | E2 |
| I6 | P3 | `PlanReceiptMatcher.planTimeZone` 对无法解析的时区静默回落 UTC+8，用于"撤回是否残留"的**身份比较** | `apps/ios/RAI/PlanReceiptMatcher.swift:54-56`；调用点 `PlanWatchScheduling.swift:290-291,325-326` | E2 |
| I7 | P3 | `decodingOnly` 把 `.validation` 也算进"契约漂移"⇒ 混合失败时仍提示"请升级应用"，与 P2-8 的修复意图不完全一致 | `apps/ios/RAI/NativeAppModel.swift:345,348-349,359` | E2 |
| I8 | P3 | 回执摘要算不出时把 v2 回执**静默降级**成 v1 形状，无诊断记录；服务端会按旧信息级登记（不报错） | `apps/ios/RAI/NativeAppModel.swift:1626-1631`；服务端 `apps/api/src/mobile-goals.ts:679,690-705` | E2 |
| I9 | P3 | `Retry-After` 全局夹取 `0...5`，429 的用户文案也用它 ⇒ 服务端若发更长等待，界面会显示成"建议 5 秒"（当前服务端只发 1/5，属潜在） | `apps/ios/RAI/APIClient.swift:117-126,433-441`；服务端 `apps/api/src/api-error.ts:45-56` | E2 |
| I10 | P3 | 测试门禁强度边界：新增的游标/补读判据全是**源码子串**检查，MIN_CHECKS 为自报常数；本轮因只读未做突变验证 | `apps/ios/tests/check-healthkit-record-sync.py:261-282,327` | E1（文件原文）+E3（有效性未验证） |

附：`NativeViews.swift:103-110` 每次 body 求值都在 MainActor 上 JSON 编码整份计划（`.task(id: reminderSnapshot)`），属**先前已存在**的实现，本轮只是把 `reminderContext` 也算了一遍；量级为几 KB，列为观察项而非独立 finding。

---

## 3 发现详情

### I1（P2）迟到样本补读不设批内份额，可整批吃光预算并饿住 anchor 流与窗口 pass

**证据（E2，`apps/ios/RAI/HealthKitExport.swift:1364-1398`）**

```swift
for (type, unit, xmlType, xmlUnit) in descriptors {
    guard LateDynamicsBackfill.types.contains(xmlType) else { continue }
    guard let before = cursors[xmlType],
          LateDynamicsBackfill.needs(cursor: before, now: now) else { continue }
    ...
    if !late.isEmpty {
        let page = try renderedRecordPage(...)
        guard budget.accepts(
            xmlBytes: xml.offsetInFile, records: count,      // ← 全量批预算
            pageBytes: page.data.count, pageRecords: page.recordCount
        ) else { continue }
        try xml.write(contentsOf: page.data)
        count += page.recordCount
    }
```

对比同文件窗口 pass 的写法（`:1499-1503`）——窗口有**独立份额**：

```swift
let windowShare = DirectSyncBatchBudget.recentWindowShare(of: budget)
let windowFits = windowBytesUsed + page.data.count <= windowShare.maxBytes
    && windowRecordsUsed + page.recordCount <= windowShare.maxRecords
if windowFits && budget.accepts(...) { ... }
```

**量级**：`LateDynamicsBackfill.limit = 1500`、类型 4 个（`HealthKitRecordCursor.swift:233-245`）⇒ 单批最多尝试 **6000 条**；而预算为 `maxRecords: 4_500` / `maxXmlBytes: 1_887_436`（`DirectSyncBatchBudget.swift:52-58`，握手后为 0.9×）。补读循环排在窗口 pass（`:1454`）与正式 anchor 循环（`:1561`）**之前**。

**后果链**（E2）：
1. 升级后的第一批：4 个跑步动态类型都 `lateBackfillAt == nil` ⇒ 全部触发补读。
2. 若跑者有密集跑步动态（跑步功率/触地时间常见 1–5 s 一个样本；14 天轻松超过 1500 条），该批会被补读吃满 4500 条 / ~1.4 MB。
3. 窗口 pass 与 anchor 循环拿不到预算：`decide` 走 `.retryWithLimit(shrinkLimit(...))`，剩余记录额度为 0 ⇒ `shrinkLimit` 返回 1 ⇒ `drain` 在 `limit == 1` 时 `return (anchor, true, true)`（`HealthKitRecordCursor.swift:143-146`）⇒ 本类型**零进展**，`budgetStopReason = .recordNone`。
4. 每批都如此，直到该类型 14 天窗口被分页读完；期间**心率/睡眠/步数等所有其它类型**的正式流零进展（它们与补读共用同一批预算）。
5. 用户可见：`HealthKitSync.swift:2485-2486` 的文案会显示"单条记录放不进本批剩余预算，该类型本轮零进展"；同步需要很多轮才恢复，而补读本身仍在推进（不是死锁，也不会丢数据）。

**为什么是 P2 而不是 P1**：账目按批提交、补读分页上界持久化（`lateBackfillBefore`），失效方向是"慢 + 其它类型被饿"而不是丢数据；`LateDynamicsBackfill.retryInterval`（30 天）保证它不会永久自锁。但对"跑者主力用户"命中概率高，且用户无法理解为什么心率同步停了。

**建议（不在本 lane 实施）**：让补读也受 `DirectSyncBatchBudget.recentWindowShare(of:)` 约束（或单批最多尝试 1 个补读类型），或把补读循环挪到 anchor 循环**之后**、仅在还有剩余预算时执行 —— 二者都不改变恢复语义（补读是加速器/恢复通道，不是唯一通道，见 `HealthKitExport.swift:1440-1445` 对窗口的同口径表述）。

---

### I2（P3）空窗水位永不推进 ⇒ 重放期间每批重复查询空类型

**证据（E2）**：`HealthKitExport.swift:1519-1521`

```swift
if let previousWindow,
   let mark = RecentWindowAccounting.nextMark(
       written: windowWritten ? recent.count : 0, now: now) {
```

```swift
// HealthKitRecordCursor.swift:221-223
static func nextMark(written: Int, now: Date) -> Date? {
    written > 0 ? now : nil
}
```

这是 2026-10-17 的有意修正（空窗不得宣称"已交付"，否则迟到样本永久缺失 —— 见 `HealthKitRecordCursor.swift:207-214` 与本文件 `:1512-1518` 的注释），**不构成回归**。代价是：只要某类型在近 48h 没有样本（跑步功率最常见），`recentWindowReadAt` 就一直是 `nil`，而 `windowStart = max(now-48h, (recentWindowReadAt ?? .distantPast) - 6h)` ⇒ 每批都重查一次该类型 48h 窗口。窗口 pass 只在 `previousWindow == nil || previousWindow.needsHistoryRead()`（`:1467-1469`）时启用，因此**历史重放持续多久（可达数天）就重复多久**，每批 ≤ 17 个类型各一次 `HKSampleQuery`（limit 1500）。

影响：纯成本（查询次数/耗电/同步时长），无正确性风险。建议后续加"空窗计数 + 指数退避（仍受 30 天/重启约束）"，或在注释里显式承认这条无界重复（当前注释只说"成本只是一次 `HKSampleQuery`"，未说明"每批一次、可重复数天"）。

---

### I3（P3）补读分页下界按当前 `now` 重算 14 天窗口 ⇒ 前缘漂移

**证据（E2，`HealthKitExport.swift:1369-1372`）**

```swift
// 分页上界：上一批被单类型上限截断时，本批只读 `[windowStart, before)` 那段
let windowStart = now.addingTimeInterval(-LateDynamicsBackfill.lookback)   // now = 本批的 Date()
let pageUpperBound = before.lateBackfillBefore ?? now
```

`now` 在函数入口取一次（`:1286`），但**每批重新取**。被截断后 `lateBackfillBefore = oldestSample`（`:1415-1423`），下一批的下界是"那一刻的 now − 14 天"，比上一批前移了批次间隔（分钟到小时）。于是补读到最后一页时 `windowStart` 已经越过最初的左下沿，而 `pageOutcome`（`HealthKitRecordCursor.swift:273-286`）在 `oldestSample <= windowStart` 时返回 `.completed` ⇒ 记 `lateBackfillAt = now`，**声明整窗已覆盖**，但那几分钟~几小时的左下沿从未被读过。若恰好有一段跑步动态落在该段（且迟于正常投递），要等 30 天 `retryInterval` 才有下一次机会。

影响小、需两个条件同时成立（补读跨批 + 迟到样本落在那段窗口边沿），故 P3。建议把窗口下界也持久化（例如复用 `lateBackfillBefore` 的兄弟字段 `lateBackfillWindowStart`），或首次判定时固定窗口下界。

---

### I4（P3）同一段代码里两条互相矛盾的注释（**建议优先修**）

**证据（E1，原文逐行）**：`HealthKitExport.swift:1356-1360` 的纪律清单写：

```swift
//   ③ 每个类型只在 `lateBackfillAt == nil` 时跑一次，成功后记 `now`（空结果同样记账：
//      该类型这 14 天确实没有样本，不必每批重查）；
```

而同一段循环的实现分支（`:1424-1428`）是：

```swift
case .retry:
    // 🔴 空页**不记账**：HealthKit 对未授权读取、或样本还没从手表同步到手机时
    // 都只返回空、不报错。把一次空查询当成"补过了"，这条唯一的恢复通道就被
    // 自己关死 —— 升级后第一次同步若恰好碰上权限未开/样本未到，就再也补不回来。
    continue
```

`HealthKitRecordCursor.swift:54-56` 的同一规则再看第三遍（"空页不记账"）。两者**语义相反**，而"空窗/空页也算已交付"正是 2026-10-14 那次事故的成因（`deliverables/RUNNING_POWER_GCT_MISSING_2026-10-17.md`）。实现是对的，但注释 ③ 会让下一个维护者"修代码去迎合注释"，把已修的缺陷重新打开。属纯文档缺陷，但风险不对称（一句话 → 一次数据永久缺失），建议按 ④ 的写法改 ③。

---

### I5（P3）"该有却没有"告警只在重放/首装期间可达

**证据（E2）**：`HealthKitExport.swift:1467-1470`

```swift
let needsRecentWindow = previousWindow == nil
    || previousWindow!.needsHistoryRead()
guard needsRecentWindow else { continue }
windowEligible.insert(xmlType)
```

而 `windowReturnedEmpty`（`:1488`）只在这个循环内填值，告警判据是 `windowReturnedEmpty.contains(...)`（`:1546-1553`）。稳态（游标已建立、`historyReplayPhase == nil`）下窗口 pass 整体被跳过 ⇒ `windowReturnedEmpty` 恒空 ⇒ 这条为 2026-10-14 事故新增的可见性告警**在事故当时的同一状态下不会触发**（当时是稳态增量，不是重放）。它只在首装/重放/`repairSyncCursor` 后有效。

影响：排查时的又一条"看起来有其实没有"的通道（本仓历史上反复吃亏的形态）。建议把判据改为"本轮该类型的 anchor 流水位没有前进 且 服务端近 N 天该类型为 0"之类不依赖重放态的条件，或至少在注释里写明可达范围。

---

### I6（P3）`planTimeZone` 静默回落 UTC+8，却用于"撤回是否残留"的身份比较

**证据（E2，`PlanReceiptMatcher.swift:50-56`）**

```swift
/// 计划业务时区的解析入口：调用方只允许在已验证的 timezone 字符串上使用。
static func planTimeZone(_ identifier: String) -> TimeZone {
    TimeZone(identifier: identifier) ?? TimeZone(secondsFromGMT: 8 * 3600)!
}
```

调用点是撤回收尾的两条判据（`PlanWatchScheduling.swift:290-291` 与 `:324-326`）：

```swift
outcome.cleanupVerified = !PlanReceiptMatcher.hasResidualEntries(outcome.submittedEntries, in: left,
    timeZone: PlanReceiptMatcher.planTimeZone(journal.operation.timezone))
```

`cleanupVerified` 决定"旧条目是否算已撤回"，一旦误判为 true，账本会把残留当作已清理（用户看到"已撤回"，Watch 上仍留着排期）。

当前**不可达**为假阳性：`journal.operation.requests()` 在时区不可解析时返回 `[]`（`PlanScheduleOperationJournal.swift:33`），而 `submittedEntries` 源自该 `requests()`；`recover(withdraw:)` 路径的 `entries` 也来自 items/previousEntries，若时区坏掉 `removeEntries` 会按同一个坏时区算出 `at`，两处一致。但"注释要求已验证时区"与"函数本身无条件兜底"是矛盾的两句话，且兜底的默认值是**一个具体时区**（不是"无法判定"）。建议改成返回 `TimeZone?`，为 nil 时按"无法核验"（`cleanupVerified = false`，保留风险账目）处理 —— 与同文件 `hasResidualEntries` 引入的 fail-closed 精神一致。

---

### I7（P3）`decodingOnly` 把 `.validation` 也算成契约漂移

**证据（E2，`NativeAppModel.swift:345-363`）**

```swift
let decodingOnly = failedPanels > 0 && panelOutcomes.allSatisfy { $0 != .failure }
let validationOnly = failedPanels > 0 && panelOutcomes.contains(.validation) &&
    panelOutcomes.allSatisfy { $0 == .ok || $0 == .validation }
...
if validationOnly { errorMessage = "计划快照未通过安全校验…" }
else if failedPanels == 4 && decodingOnly { errorMessage = "数据格式与当前版本不兼容（4 项均未能解析），请升级应用…" }
```

四个面板是 plan / statistics / trends / workouts（`:317-340`）。`.validation` 只可能来自 plan 面板（`planPanelOutcome`，`:577-584`），`.decoding` 可能来自其它三个面板的 `panelOutcome(for:)`。当"plan 面板 = validation，另有一个面板 = decoding，其余 failure"时：`decodingOnly` 为真（因为 `.validation != .failure`），`validationOnly` 为假 ⇒ 用户看到"请升级应用"，而真实原因是**这一份计划快照不可信**（P2-8 要分开的正是这两种）。分支要求 4 个面板同时失败，命中概率低，故 P3；修法一行：`decodingOnly` 的谓词改为 `$0 == .ok || $0 == .decoding`。

---

### I8（P3）回执摘要算不出时静默降级为 v1 形状

**证据（E2，`NativeAppModel.swift:1623-1631`）**

```swift
guard let digest = try? PlanFingerprint.prescriptionDigest(kind: receipt.kind, structure: receipt.structure) else {
    return receipt        // ← contractVersion 保持 1，不带 scope/coherenceToken/lifecycleEvent
}
var value = receipt
value.contractVersion = 2; value.scope = identity; ...
```

服务端 `recordPlanPush` 对 `contractVersion !== 2` 的回执走旧路径（`apps/api/src/mobile-goals.ts:679`，`:690-705` 只对 `isV2` 做身份/结构校验），因此**不会** 422 —— 这条降级是安全的（注释所述"服务端按旧信息级登记"成立）。但降级的触发条件（未知 kind / 非有限 / |x|>1e9，见 `PlanStatePolicy.swift:160-200`）意味着**服务端数据异常**，此时既没有 v2 证据、也没有任何 `diagnostic(...)`/warning，线上只会表现为"这一天的执行证据缺失"而无人知道原因。建议至少加一条计划诊断码（`prescription_digest_unavailable`）。

---

### I9（P3）`Retry-After` 全局夹取 `0...5` 也作用于 429 的用户文案

**证据（E2，`APIClient.swift:113-126, 429-441`）**

```swift
nonisolated enum RaiRetryAfter {
    static let allowedRange: ClosedRange<TimeInterval> = 0...5
    static func seconds(from rawValue: String?) -> TimeInterval? { ... min(max(parsed, lower), upper) }
}
...
if status == 429, let headerRetryAfter { retryHint = "（建议 \(Int(headerRetryAfter)) 秒后重试）" }
```

服务端今天只会发 `"1"` / `"5"`（`apps/api/src/api-error.ts:45-56`：429 ⇒ 5；503+snapshot/busy ⇒ 1），所以当前不产生错误文案。但客户端把"服务端建议"改写后**仍以服务端口吻呈现**（"建议 N 秒"）：若将来服务端/反代发 `Retry-After: 60`，界面会显示"建议 5 秒后重试"并在 5 秒后重试 —— 建议与行为都偏离服务端意图且用户不可知。夹取本身合理（不阻塞前台），但建议区分"用于退避的值"与"展示给用户的原文"，或文案改为"（服务端建议稍后重试）"。

---

### I10（P3）测试门禁的强度边界（游标/补读判据为源码子串检查）

**证据（E1，`apps/ios/tests/check-healthkit-record-sync.py:261-282`）**

```python
check("lateBackfillAt" in cursor and "lateBackfillBefore" in cursor
      and "LateDynamicsBackfill.needs(cursor: before, now: now)" in export, ...)
check("LateDynamicsBackfill.pageOutcome(" in export
      and "lateBackfillBefore: previous?.lateBackfillBefore" in export ...
check("RecentWindowAccounting.nextMark(" in export
      and "written: windowWritten ? recent.count : 0" in export, ...)
check("else if let previousWindow" not in records, ...)
check("windowReturnedEmpty.insert(" in export, ...)
```

这些是**源码文本**判据：字符串可被注释满足（本文件自己的相邻注释就大量复述了这些片段），`MIN_CHECKS = 77` 是自报常数而不是"每条判据都被执行"的证明。它们钉住的是"接线还在"，而不是"行为正确"。**真正钉住行为的是** `HealthKitRecordCursorRegression.swift`（45 checks，纯逻辑、本次实跑通过），它覆盖 `drain` 的页首/收缩收敛、`RecordReplayPlan.segments`、`LateDynamicsBackfill.pageOutcome`、`RecentWindowAccounting.nextMark`。

因此本条不是"假绿"，而是**上限**：`HealthKitExport.writeGlobalRecords` 的接线语义（谁先跑、用哪份预算、记账落在哪条分支）只有源码级证据，且本轮按只读约束**未做突变验证**（`test:ios:mutation` 未运行）。建议后续把 `writeGlobalRecords` 的预算裁决顺序抽成可测纯函数（与 `RecordReplayPlan` 同一手法），这是 I1/I2/I3 都难以被现有回归抓住的根本原因。

---

## 4 证据等级与未验证边界

**E1（本次实跑，可直接复述）**
- `npm run test:ios` exit 0；`iOS 类型检查通过`；`iOS 门禁通过（类型检查 + 纯逻辑回归）`；1132 条 `PASS`；29 组回归/门禁摘要（见 §1.2）。
- 处方摘要跨语言 parity 由 fixture 驱动并全绿（`PASS: cross-language deterministic prescription digest …` ×9）。
- 逐行注释原文（I4）、python 门禁原文（I10）：直接读文件所得，不依赖运行。
- 单点复跑建议（本轮未单独跑，聚合入口已覆盖）：`bash apps/ios/tests/run-model-tests.sh`、`bash apps/ios/tests/run-health-sync-tests.sh`。

**E2（代码阅读 + 交叉核对）**
- I1/I2/I3/I5/I6/I7/I8/I9：均为纯 Swift 逻辑/常量，且与服务端实现（`api-error.ts` / `plan-digest.ts` / `mobile-goals.ts`）或本仓 ADR/历史产物互相印证。
- 并发与生命周期结论经交叉核对后为**未见缺陷**（见下"已核实无问题"），但含 `#if os(iOS)` 的运行时行为（HealthKit 回调线程、后台 session 跨进程）仍属 E3。

**E3（仅代码阅读推断，未在真机/模拟器验证）**
- HealthKit `HKAnchoredObjectQuery` 在"空结果"时是否给非 nil anchor（`HealthKitExport.swift:1753-1759` 已自述为"前提未被验证"，`anchoredWorkouts` 采用相反处置）—— 本轮未改变该判断，仍然只有文档级依据。
- `backgroundTimeRemaining` 看门狗（`HealthKitSync.swift:962-976`）在真机上的准时性、主线程被大任务占用时 Timer 是否失准。
- 背景 URLSession 的 `handleEventsForBackgroundURLSession` → `urlSessionDidFinishEvents` 时序、跨进程重投递。

**已核实无问题（供 Lead 合并时不必重复排查）**
1. **凭证**：token 只存 Keychain（`Keychain.swift:50-72`，`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`，写入安全失败可见）；全仓 `NSLog/print` 无一携带 token；`ServerSession.serverURL` 在 `#if !DEBUG` 下强制 https（`ServerSession.swift:101-105`）；`Info.plist` 的 ATS 无 `NSAllowsArbitraryLoads`（仅有 `NSAllowsLocalNetworking`，且 WebView 已于 D17 退役）。
2. **continuation 安全**：`QueryContinuation`（`HealthKitExport.swift:193-260`）用 `NSLock` 保护"单次 resume + cancel 先手"，含 `execute` 竞态双检；`RaiBackgroundUploadSession`（`BackgroundUploadSession.swift:36-53,170-269`）把"谁在等结果"（`waiters`）与"字节是否在飞"（`descriptions`）拆成两张表，`abandonWaiting` 保证取消必 resume（避免 `isBusy` 永久 true），锁不进 `async` 上下文（`:150-164`）。
3. **删除事件失败关闭**：`DirectSyncPendingDeletions.restoredFromTask` 的 `.corrupted` 抛用户可见失败而非静默丢弃（`HealthKitSync.swift:1855-1864`）；`nonisolated extension` 修正是真实需要的（否则跨 actor 调用无法编译）。
4. **处方摘要跨语言一致性**：`PlanFingerprint.prescriptionDigest` 的微单位量化（`floor(x*1e6+0.5)`、`micro==0 ⇒ "0.000000"`、整数拆分而非 `%.6f`）与 `apps/api/src/plan-digest.ts:35-58` 逐条对应；`1e9` 上界保证 `|micro| ≤ 1e15 < 2^53`。已由 fixture 回归钉住（E1）。
5. **回执 v2 wire 形状**：`planSyncWireBody`（`APIClient.swift:251-292`）对 `warmup/cooldown/alert/lower/upper/decisionRef` 统一写显式 `null`，并用 `guard let ... as?` 取代 `as!`（P3-17）；legacy 路径仍走合成 Codable（省略 nil），与 `useLegacyContract` 语义一致。
6. **快照重试**：`TrainingPlanStore.refresh` 的 503 退避重试有界（`maxAttempts = 1 + delays.count`）、只重读不重放写、每步 `valid()`/取消即弃（`:231-260, 320-350`）；`snapshotRetryDelay` 为纯函数且服务端提示优先、夹取 `0.1...5`。
7. **BGTask 配置**：`Info.plist` 的 `BGTaskSchedulerPermittedIdentifiers = app.rai.running.health-sync` 与 `UIBackgroundModes = [healthkit, processing]` 到位；背景上传只走 `uploadTask(with: request, fromFile:)`（后台 session 唯一支持形态）。
8. **缓存/水位**：`CacheStore.read` 对 `schema_version ∉ {1,2}` 返回 `.unsupportedSchema` 而非静默当缓存未命中（`CacheStore.swift:89-92`）；`acknowledgePlanWrite` 用单事务同时落 revision 水位 + 失效 + 回写（`:173-208`），并有 `excluded.revision >= ...` 的单调保护；`planRevisionFloor` 在元数据不可解码时仍以标量为准（`:155-168`）。

---

## 5 与既有审查的关系

| 既有产物 | 关系 |
| --- | --- |
| `deliverables/training-plan-review-2026-10-18/`（iOS 状态机/WorkoutKit/回执 3 P1 + 18 P2 + 21 P3） | 本轮逐条核对 HEAD：回执 v2 显式 null（P1-1）、Retry-After（P2-6）、安全字段校验分类（P2-8）、能力协商单源（P2-9）、教练闭环提醒（P2-10）、业务时区（P2-11）、摘要不可量化 fail-closed（P2-13）、缓存时间文案（P3-15）、撤回残留身份（P3-16）、`as!` 移除（P3-17）**均已落地**并在本 lane 实跑中通过（见 §1.2 的 PASS 摘录）。**当前仍存在**的只有 I7：`decodingOnly` 的谓词未排除 `.validation`，属 P2-8 的残留口径问题（降级为 P3）。 |
| `deliverables/RUNNING_POWER_GCT_MISSING_2026-10-17.md` + `09ed8d0`（迟到样本补读 / 空窗水位） | 修复的**方向正确**（`RecentWindowAccounting.nextMark` 空窗不推进、`LateDynamicsBackfill` 空页不记账、写前判定、分页上界持久化，均已在 `HealthKitRecordCursorRegression` 45 checks 中钉住）。本轮新增 3 条**新的窗口/预算**问题：I1（补读不占份额，P2）、I2（空窗重复查询的代价未写明，P3）、I3（分页下界前缘漂移，P3）；以及 I4（注释与实现相反，P3）。`deliverables/` 原结论中"迟到样本已可恢复"成立，**但不能理解为"补读不消耗资源"**。 |
| `docs/PROJECT_REVIEW.md`（2026-09-30） | 该快照早于回执 v2 与教练闭环合同，其中的 iOS 结论已被后续批次覆盖；本轮未据其重报任何问题。 |
| `docs/adr/ADR-004-healthkit-sync-invariants.md` | 本轮核对其"游标/窗口/补读"判据段落与代码一致（`check-healthkit-record-sync.py` 78 checks 全绿，含 2026-10-17 新增 5 条）。ADR 未覆盖"补读批内份额"，这正是 I1 的空白点。 |
| `deliverables/IOS_BACKEND_AUDIT*` 等历史产物 | 结论未与 HEAD 冲突；本轮无重报。 |
| 产品边界（AGENTS.md / D17 / 2026-09-22 决定） | 未建议恢复 Web 壳或 macOS target。**一处措辞需要 Lead 决定是否统一**：`Info.plist:24-26` 声明 `NSHealthUpdateUsageDescription`（"使用「体能训练」写入权限…把每周课表排期到 Apple Watch"），且 `WorkoutKitBridge.swift:14` 通过 `WorkoutScheduler` 取授权 —— 即 WorkoutKit 排期需要 HealthKit **写**授权（HKWorkoutType），而 AGENTS.md/任务简报表述为"HealthKit 只读、未授权写入"。样本同步侧确为只读（`HealthKitExport.swift:344` `requestAuthorization(toShare: [], read: readTypes)`）。这是**先前已存在**的产品边界措辞差异（不是本轮改动引入的缺陷），本 lane 只记录，不建议改代码。 |

---

### 附：本 lane 未做的事（避免与其它 lane 重复）

- 未审查 `apps/api` / `packages/*` 的实现质量（仅用于核对客户端契约一致性），不产出 API/算法结论。
- 未审查 `docs/` 的完整性、未跑 `npm test`（由 Lead 的其它 lane 负责）。
- 未运行任何会修改工作树的命令（突变验证、格式化、生成器）；`git status` 在本 lane 结束时应仍为干净（唯一新增文件即本报告）。
