# RAI 后端 + iOS 审查报告 · 2026-09-16

> **范围**：后端（`apps/api/` + `packages/`）+ iOS（`apps/ios/`）。Web 只跑门禁，不做改动审查。
> **基线**：`main` = `b4cb6d9`（2026-09-15 23:14），工作树干净（仅 3 个未跟踪交付物）。
> **对比的上轮**：`deliverables/BACKEND_IOS_REVIEW_2026-09-15-R2.md`（基线 `f588e0a`）
> 与 `deliverables/IOS_CODE_REVIEW_2026-09-15.md`（同基线）。
> **增量**：`f588e0a..b4cb6d9` = **1 个提交、15 个文件、+956/−309**，全部在 `apps/ios`。
> **方法**：门禁四条全量实跑 → 逐条读码 → **5 个可复现探针**（真实库副本，只读）→
> 上轮每一条结论都**重新实测**，不复用任何旧 ✅。
> **未改任何业务代码**；探针在 `/tmp/raiprobe26/`；真实库**只读**打开副本，未触碰线上。

---

## 一、总结论

**健康度：B+**。质量门禁四条全绿；上一轮 iOS 那批修复（`b4cb6d9`）**方向正确、大多数落点扎实**，
但我实测出**两个新缺陷**，其中一个直接推翻该提交自己的核心论证。

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 质量门禁 | 🟢 绿 | typecheck / node 603 / vitest 84 / iOS 双脚本 **全部实跑通过** |
| 记录层身份与去重 | 🔴 红 | 76,671 行冗余仍在，用户可见计数虚高 **1.92×**；重导出必经路被守卫拒绝 |
| iOS 排期回读 | 🟡 黄 | consume-once 建立在**假前提**上：`date` 其实存在；只修计数、不修归属 |
| iOS 读授权 | 🟡 黄 | 查询失败/`.unknown` 被映射成**放行**；被拒绝的设备仍报"同步成功" |
| 分段解析 | 🟡 黄 | 负偏移丢步未修（`workout-segments.ts:197`） |
| 磁盘/文件生命周期 | 🟡 黄 | 1.22 GiB 残骸在盘；回收仍无周期调度 |
| API 鉴权/路由登记 | 🟢 绿 | 21 个写端点三集合互斥；断言是**枚举式**的，漏登记会直接失败 |
| iOS 分层与共享规则 | 🟢 绿 | 上轮 P1-D/E/F 已闭合；`inactiveLabel` 重新有生产调用 |

---

## 二、质量门禁实跑（本次实测，非引用）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | ✅ **EXIT=0** | 双 tsconfig，77s |
| `node --import tsx --test packages/*/test/*.test.ts apps/api/test/*.test.ts` | ✅ **603 项 / 600 pass / 3 skip / 0 fail** | 91.9s |
| `npx vitest run --root apps/web` | ✅ **13 文件 / 84 pass** | 22.1s |
| `bash apps/ios/tests/run-model-tests.sh` | ✅ EXIT=0（含新增课表映射与收据断言） | 83s |
| `bash apps/ios/tests/typecheck-ios.sh` | ✅ **36 文件 / 0 error** | 105s |

> `typecheck-ios.sh` 本轮**实跑通过**（该脚本 09-12 曾因环境抖动失败），与上轮一致 ⇒ 未复现抖动。

---

## 三、分级问题清单

### 🔴 P0　`health_records` 记录级重复未消除：76,671 行冗余，用户可见计数虚高 1.92×（我独立重测，并把证明收紧）

上一轮标为 P0、**至今一行未动**。我没有引用上轮数字，而是自己重跑了三个探针。

**代码事实**（身份公式已删除 `device` 维度）：

```diff
// packages/health-export-parser/src/apple-health-parser.ts:146-156
   const id = syncIdentifier
     ? stableId("record", [type, sourceName, syncIdentifier])
     : stableId("record", [type, sourceName, startAt, endAt,
-                          attributes.value ?? null, attributes.unit ?? null, attributes.device ?? null]);
+                          attributes.value ?? null, attributes.unit ?? null]);
```

**我的实测**（`/tmp/raiprobe26/probe.mjs`，真实库副本只读）：

| 检验 | 实测值 |
|---|---|
| `health_records` 总行数 | **160,051** |
| 唯一 `id` 数 | 160,051 |
| 自然键 `(type, source_name, start_at, end_at, value_text, value_numeric, unit)` 唯一样本数 | **83,380** |
| **冗余行数** | **76,671** |
| 重复组总数 | **76,671**（每组恰好 2 行） |
| 其中「组内两行 `device` 确有差异」 | **76,671 / 76,671（100%，不是抽样）** |

**我这次的证明比上轮更硬，且不依赖"能否重建原始 value 字符串"**：

1. 76,671 个重复组内，两行的**其余六列完全相同、`id` 却不同**；
2. 按**当前**公式，六列相同的两行**必然算出同一个 `id`** ⇒ 这 76,671 组里**每组至少有一行的 id 永久不可复现**；
3. 而"完整重导出"的删除预览 = 「现存但新导入集合中不存在的实体数」⇒ **预览 ≥ 76,671**；
4. 守卫阈值 `allowedRemovals = max(50, floor(existingEntities × 0.05))`（`import-guard.ts:16-17,37-43`，
   实测常量 `MIN=50 / RATIO=0.05`），`existingEntities = 160,322` ⇒ `allowedRemovals = 8,016`；
5. **76,671 > 8,016 ⇒ 完整重导出必然被 `import_removal_guard` 拒绝** —— 这是**下界证明**，
   上轮的 160,322 是一个点测量，我这个结论不依赖任何字符串重建。
   （独立旁证：我另用当前公式逐行复算，命中率 **0 / 160,051 = 0.00%**。）

**用户可见面**（这一层上轮未点明到行）：

| 展示处 | 取值 | 实测 |
|---|---|---|
| `apps/web/src/pages/DataAuditPage.tsx:44`「总记录条数 / 健康记录」 | `/v1/data-audit` → `COUNT(*)`（`audit-read-repository.ts:108`） | 显示 **160,051**，真实 **83,380** |
| `apps/web/src/pages/SettingsPage.tsx:459` 数据摘要 | `/v1/data-summary` → `COUNT(*)`（`server.ts:632` → `data.ts:1114` → `audit-read-repository.ts:70`） | 同上 |

**根因定性（这次讲清楚）**：变更 `6c61a9a`（2026-09-04 17:27）的提交标题就是
**"fix: deduplicate health metrics"** —— 也就是说这次改动**本意就是去重**。
它确实让**新导入**的样本会折叠成一行，但**存量行一行没迁移**（无 migration 重写既有 id）。
⇒ 这正是最危险的一种"看起来生效了"：代码改对了、新数据也对，**只有已经躺在库里的 76,671 行没人管**，
而计数展示直接读 `COUNT(*)`，用户看到的是一个**虚高 92%** 的数字。

**审计报表也在结构性掩盖**：`packages/health-export-parser/src/audit.ts:408`
的 `Math.max(0, parsedRecords - uniqueRecords)` 在 `parsed < unique` 时**恒为 0**
⇒ 76,671 行真实重复**永远不会出现在 `data-audit.json` 里**。

**修法（维持上轮方向，补两点）**：
1. 一次性去重迁移：按自然键分组，每组保留**确定的一行**（优先 `device IS NOT NULL`），删其余；
2. 写入 `stable_id_version` 标记，使下一次导入按新公式稳定命中；
3. 把 `audit.ts:408` 的 clamp 改成**真实双向差**，或单列 `legacyIdOverlap`；
4. **补一步**：迁移前必须确认**线上库**是否同样带这些重复行（见 §八 未覆盖项）。

**验收**：`COUNT(*) == COUNT(DISTINCT type, source_name, start_at, end_at, value_text, value_numeric, unit)`；
完整重导出**不再**触发 removal guard；`DataAuditPage` 与 `SettingsPage` 显示 83,380。
**回滚**：迁移前 `POST /v1/backups`（有 schema/数据变更，按仓库规范必做）。

---

### 🟡 P1-a　iOS 回读匹配建立在**假前提**上，只修了计数、没修归属（`b4cb6d9` 新增）

`b4cb6d9` 的核心论证写在注释里（`apps/ios/RAI/WorkoutKitBridge.swift:214`）：

```swift
// Matching is *consume-once* on purpose. `scheduledWorkouts` carries no
// date and `CustomWorkout` equality is content-only, ...
```

**"carries no date" 是错的。** 我从本机 SDK 的接口文件直接读出来：

```swift
// .../iPhoneSimulator.sdk/System/Library/Frameworks/WorkoutKit.framework/Modules/
//   WorkoutKit.swiftmodule/x86_64-apple-ios-simulator.swiftinterface:166-171
public struct ScheduledWorkoutPlan : Swift.Equatable, Swift.Hashable, Swift.Sendable {
  public var plan: WorkoutKit.WorkoutPlan
  public var date: Foundation.DateComponents { get set }     // ← 日期就在这儿
  public var complete: Swift.Bool { get set }
}

// :125-128
final public var scheduledWorkouts: [WorkoutKit.ScheduledWorkoutPlan] { get async }
final public func schedule(_ workout: WorkoutKit.WorkoutPlan, at: Foundation.DateComponents) async
```

`date` 就是 `schedule(_:at:)` 传进去的 `at`，桥接层自己构造的那个 `item.at`。

**后果（我按代码逐行走了一遍）**：consume-once 只把"一条 listed 顶两天"变成"一天顶一条"，
但**匹配仍然只按内容**（`:222-224`）：

```swift
var unmatched = await WorkoutScheduler.shared.scheduledWorkouts.map(\.plan.workout)   // :219
for item in pending {
    guard let index = unmatched.firstIndex(of: .custom(item.custom)) else { continue } // :222
    unmatched.remove(at: index)                                                        // :223
    confirmed.append(item.localDate)                                                   // :224
}
```

构造反例：`pending = [周一A, 周二B]`，两天处方 byte 级相同（同是 `RAI · 轻松跑 8.0km`），
`schedule` 只在周一静默失败。此时 listed 里只有 B 那条 ⇒ 循环先处理 A，
`firstIndex` 把 **B 的那条** 匹配给 A ⇒ `confirmed = [周一A]`。

**手表上真实存在的是周二，收据却记在周一头上** —— 这正是该提交自己声明要消灭的东西
（commit message: "a receipt for a day the watch never saw is worse than no receipt"）。
计数是对的（`verified == false` 会提示未回读确认），**归属仍然错**。

**正解（比现在更简单）**：按 `date` 匹配，而不是按内容消费：

```swift
for item in pending {
    guard let index = unmatched.firstIndex(where: { $0.date == item.at }) else { continue }
    unmatched.remove(at: index)
    confirmed.append(item.localDate)
}
```
建议比较到**日粒度 + `timeZone`**（`year/month/day`），以免 scheduler 归一化时间分量造成不等。

**测试覆盖为 0**：`WorkoutKitBridge.swift` 需要 iOS SDK，`run-model-tests.sh` 编不进去；
新增的 4 条收据断言（`apps/ios/tests/ModelRegression.swift:250-276`）钉的是
**调用方是否跟随桥接返回集**（`recordPlanSync(_:localDates:)` 的契约），
**不是桥接自己怎么算这个集合**。上轮声称的突变 M7 打掉的也是前者 —— 这条真空白。
若要补，建议把"匹配"抽成一个不依赖 SDK 的纯函数（入参：`[(内容, 日期)]` + `listed`），
就能进 `run-model-tests.sh`。

**验收**：新增断言「两天内容相同、只有一天上表 ⇒ 收据归属上表的那一天」。
**回滚**：`git checkout b4cb6d9^ -- apps/ios/RAI/WorkoutKitBridge.swift`。

---

### 🟡 P1-b　读授权：**查询失败被映射成放行**（`b4cb6d9` 新增）

```swift
// apps/ios/RAI/HealthKitExport.swift:114-125
static func readAuthorizationState(requestingIfNeeded: Bool = true) async -> HealthKitReadAuthorization {
    guard HKHealthStore.isHealthDataAvailable() else { return .unavailable }
    let store = HKHealthStore()
    let before = try? await store.statusForAuthorizationRequest(toShare: [], read: readTypes)
    if before == .shouldRequest, requestingIfNeeded {
        try? await store.requestAuthorization(toShare: [], read: readTypes)
    }
    let after = try? await store.statusForAuthorizationRequest(toShare: [], read: readTypes)  // :121
    return after == .shouldRequest ? .notDetermined : .decided                                // :125
}
```

`HKAuthorizationRequestStatus` 有**三个**取值，不是两个：

```objc
// iPhoneOS.sdk/System/Library/Frameworks/HealthKit.framework/Headers/HKDefines.h:95-104
 @constant  HKAuthorizationRequestStatusUnknown  The authorization request status could not be
                                                 determined because an error occurred.
typedef NS_ENUM(NSInteger, HKAuthorizationRequestStatus) {
    HKAuthorizationRequestStatusUnknown = 0,
    HKAuthorizationRequestStatusShouldRequest,
    HKAuthorizationRequestStatusUnnecessary,
};
```

于是 `:125` 的一行三元把**两种失败**都倒进了"放行"分支：
- `after == .unknown`（**查询本身报错**）⇒ `.decided`；
- `after == nil`（`:121` 的 `try?` 吞掉了 **throw**）⇒ `.decided`。

**危害**：这两种情况下代码会**继续导出**，导出一个空档并报"同步成功"——
正是这个修复声称要消灭的失败模式。而模块自己的注释（`:115-118`）与 memory 里的通用判据
（"非抛错 API 的失败/成功必须靠状态前后对比区分"）都要求相反的做法。
**修法**：`after` 为 `nil` 或 `.unknown` 时归入 `.notDetermined`（或单列 `.unknown` 并复用同一条可行动文案）。
`before` 抛错同理。

**验收**：新增断言（或至少注释）说明 `nil` / `.unknown` 走拒绝路径；`run-model-tests.sh` 保绿。

---

### 🟡 P1-c　"拒绝读取授权"仍与"授权但无数据"不可区分（修复只覆盖"从未询问"）

`statusForAuthorizationRequest` 一旦用户**回答过**（允许**或拒绝**）就返回 `.unnecessary`
⇒ 归入 `.decided` ⇒ 走完导出、导出 0 条、**报成功**。

上一轮 iOS 报告把 🟡-1 描述为"**拒绝把「没授权」报成「同步了 0 条」**"——
这个说法**只对"从未询问"成立**：被拒绝的设备今天仍然会看到一条成功的同步。

HealthKit 对**读**权限天然不可查询（Apple 有意如此），所以这不是"再判一个枚举"能修的。
**真正的兜底是：对 0 条结果单独给一条可行动的提示**。当前只有 warnings 通道
（`HealthKitSync.swift:501-503`），而**导出为空不产生任何 warning** ⇒ 无提示。
**建议**：`exported.workoutCount == 0 && 样本数 == 0` 时明确提示
"未读到任何健康数据：若你曾在权限弹窗点过「不允许」，请在 设置→健康→数据访问与设备 中打开 RAI"。

---

### 🟡 P1-d　`workout-segments.ts:197` 负偏移丢步（上轮 P1-A，未修）

```ts
// apps/api/src/workout-segments.ts:196-197
const startMs = startedAtMs + offsetMs;
if (startMs < startedAtMs || startMs >= endedAtMs) continue;   // 丢弃，而不是钳到 0
```
上轮已用探针端到端证实：`−250ms` 的首步被丢 ⇒ `planned[index]` 逐位前移 ⇒
**"恢复"被标成"训练"**，且无任何告警。本轮**代码未变**。
**修法**：`const startMs = Math.max(startedAtMs, startedAtMs + offsetMs);`
**验收**：单测 `startMs: -250` ⇒ 4 段标签与课表一一对应。

### 🟡 P1-e　磁盘 1.22 GiB 残骸仍在，且回收**无周期调度**（上轮 P1-B，未修）

**我实测**（`ls -l var/*.replaced.*`，合计 **1,309,851,648 bytes = 1.22 GiB**；`var/` 合计 3.4 GB）：

```
298M  var/rai.importing.web_import_mtmmypcz.sqlite.replaced.88f8181f-…  (9/4 15:32)
298M  var/rai.importing.web_import_mtm8bv7z.sqlite.replaced.3824dda4-…  (9/4 08:42)
296M  var/rai.importing.web_import_mtm86ant.sqlite.replaced.84e23c27-…  (9/4 08:38)
287M  var/rai.importing.web_import_mtm82ett.sqlite.replaced.28118a83-…  (9/4 08:35)
122M  var/rai.importing.web_import_mtl9ip0p.sqlite.replaced.3e633450-…  (9/3 16:28)
```

**性质**：正则 `DISPLACED_DATABASE_PATTERN = /\.replaced\.[0-9a-fA-F-]{36}$/`（`maintenance.ts:91`）**能匹配** ⇒
不是"修复失效"，是"修复上线前的遗留 + 至今未被触发"。
**真实缺口**：sweep（`maintenance.ts:616`）只在 `ensureBackupCapacity()`（`:537`）内被调用，
而它只由 `maintenance.ts:122`（createBackup）与 `worker.ts:1274`（web import）触发；
`server.ts` 的三个 `setInterval`（`:280` 上传清理 / `:563` 训练区间 / `:588` 周计划）**都不涉及**。
⇒ 一台**不再导入也不再备份**的机器上，残骸永久滞留且仍占备份预算。
**建议**：加每日 sweep（或并入已有定时器节奏）。**验收**：手工放一个 25h 前的 `.replaced.<uuid>` ⇒ 一次 sweep 后被回收。

### 🟡 P1-f　CLI staging 命名不在任何回收路径内（上轮 P1-C，未修）

```ts
// packages/health-export-parser/src/cli.ts:90
const staging = `${target}.importing.${randomUUID()}`;   // 只在 finally 清理
```
sweep 正则只认 `\.replaced\.<uuid>$`（`maintenance.ts:91`），**不认 `.importing.<uuid>`**；
worker 的 `rai.importing.<jobId>.sqlite` 同样不在内 ⇒ 进程被 SIGKILL/OOM/断电即**整库副本永久残留**。
**建议**：CLI 改用与 worker 一致的命名，或把正则扩到 `\.importing\.[^/]+$`。

### 🟡 P1-g　`worker.ts:1751` rollback 删除失败被静默吞掉（上轮 P1-G，未修）

```ts
// apps/api/src/worker.ts:1749-1753
} finally {
  if (committed && originalMoved) {
    await this.removeDatabaseFileWithRetry(rollbackPath).catch(() => {});   // 无日志、无 errors.push
  }
}
```
整库大小的 `var/backups/rai.import-rollback.<uuid>.sqlite` 删除失败（EBUSY 等）**零痕迹**，
残骸还会被 `enforceBackupPolicy` 计入 count/bytes ⇒ 挤掉真备份。**建议**：至少 `errors.push(error)`。

### 🔡 P2（承上轮，均未修）

| # | 问题 | 证据 |
|---|---|---|
| L-1 | `json_each` 对**裸字符串**抛错 —— **今日不可达，我改成直接执行来验证**（见 §八.1） | `database.ts:2357,2362` |
| L-2 | `finish_reason` 从不检查；`max_tokens=8192` 硬编码 | `weekly-plan-llm.ts:94-100`、`:66` |
| L-3 | 无 Origin + `allowAuthenticatedRemote` 直接放行（仅非 `/v1/` 路径，当前无非 `/v1/` 写路由） | `local-request-security.ts:69` |
| L-4 | `.partial-` staging 清理同样被吞 | `maintenance.ts:518-519` |
| L-5 | iOS `try?` 静默留旧值 | `NativeAppModel.swift:175-179` |

> 上轮的 L-6「同步编排两皮肤复制」**已闭合**：两处都改为读 `outcome.scheduledLocalDates`
> （`NativeViews.swift:1764-1766` / `TechViews.swift:1740-1742`）。

---

## 四、上轮遗留项闭环核验（逐条重测，不复用旧 ✅）

| 上轮项 | 本轮结论 | 证据 |
|---|---|---|
| R2 **P0** 记录级重复 | ❌ **未修**（我重测并收紧证明） | 见 §三 P0；76,671 冗余、1.92× 虚高 |
| R2 **P1-A** 负偏移丢步 | ❌ 未修 | `workout-segments.ts:197` |
| R2 **P1-B** 回收无周期调度 | ❌ 未修 | 残骸 1.22 GiB 仍在；`server.ts:280/563/588` 均不涉及 |
| R2 **P1-C** CLI staging | ❌ 未修 | `cli.ts:90` vs `maintenance.ts:91` |
| R2 **P1-D** 回执 ⊇ 实际上表集 | ✅ **真修** | `WorkoutKitBridge.swift:54,235`（`scheduledLocalDates`）+ 两皮肤调用点 + 4 条断言 |
| R2 **P1-E** 全映射失败文案误报 | ✅ **真修** | `WorkoutKitBridge.swift:82-88`（`offered` 分流两句话） |
| R2 **P1-F** 共享分类器零调用 | ✅ **真修**（数字需修正，见 §八.2） | `unofferedDays` → `inactiveLabel`（`WorkoutPlanMapper.swift:278`）；两皮肤均改调 |
| R2 **P1-G** rollback 吞错 | ❌ 未修 | `worker.ts:1751` |
| iOS **🔴-1** 墓碑身份分裂 | ⛔ **撤回正确，我独立确认**（见 §八.4） | 导出侧双键 + 后端四路匹配 + `addMetadata` 恒产出数组 |
| iOS **🔴-2** 回读内容相等 | ⚠️ **部分** | 计数已修；**归属仍错**，见 §三 P1-a |
| iOS **🟡-1…-11** | ✅ 均已落地 | 逐条在 `b4cb6d9` diff 内可定位；`typecheck-ios.sh` 36 文件覆盖 |

---

## 五、绿区（已核实无问题）

| 维度 | 证据 |
|---|---|
| 写端点登记完备性 | `metadataOnly(6) + databaseRequired(10) + lockOnly(5) = 21`（`server.ts:177-209`）；`schemas.test.ts:325-341` 逐条要求出现在 `openapiDocument.paths` |
| **登记漏项的强制力（比上轮更硬的点）** | `schemas.test.ts:344-357` 用**枚举式**断言：从源码解析出的写路由数 **必须等于** 挂载令牌数（`app.post/put/patch/delete` 与 `app.route`、`app["post"]` 都计入）⇒ 漏登记一条**直接失败**，不靠人记得 |
| iOS 授权不会死锁 | `readAuthorizationState(requestingIfNeeded:)` 默认 `true`（`HealthKitExport.swift:114`），调用点 `HealthKitSync.swift:282` 未传参 ⇒ **仍会弹窗**，不存在"永不请求" |
| iPhone 端 shell JS 统一 | `iosShellJavaScript(chromeTop:)`（`AppWebView.swift:373-381`）四行齐全（`dataset.shell` + 3 个 CSS 变量）；三处调用点（`:384`、`:390`、`:433`、`:487`）全部指向同一字符串 |
| 墓碑删除链路（端到端） | 导出侧**每条训练双键写入**（`HealthKitExport.swift:319-320`）；后端**四路匹配**（`database.ts:2342-2365`）；解析侧 `addMetadata` **恒产出 `string[]`**（`utils.ts:90-100`）⇒ `json_each` 形状安全 |
| 课表映射日期校验 | `scheduleComponents` 回读 `year/month/day` 并要求全等（`WorkoutPlanMapper.swift:141-145`），`02-30` 与非闰年 `02-29` 均被拒（断言在案） |
| pace 丢弃 / 心率截断分离 | `maxPaceSecondsPerKm=1800`（丢弃）vs `maxHeartRateBpm=240`（截断），两条独立路径（`WorkoutPlanMapper.swift:328-352`） |
| 两皮肤共享判据 | `weekStripStatus` / `schedulableCount` / `unofferedDays` / `NativeGoalWeekDraft` 全部下沉，两皮肤只留颜色 |
| 新增断言的实质度 | `ModelRegression.swift` / `WorkoutPlanMapperRegression.swift` 新增断言**不是同义反复**：`flagOnButBroken` 夹具专门让 `executable` 计数与"可映射"计数**分离**，突变 M3 才抓得住 |

---

## 六、行动建议（按优先级）

| 序 | 项 | 改动 | 验收 | 回滚 |
|---|---|---|---|---|
| 1 | **🔴 P0** | 一次性去重迁移 + `stable_id_version`；修 `audit.ts:408` clamp | `COUNT(*) == COUNT(DISTINCT 自然键)`；完整重导出不再触发 guard；页面显示 83,380 | `POST /v1/backups` 后执行；库文件级回滚 |
| 2 | **🟡 P1-a** | 桥接改按 `date` 匹配（日粒度 + timeZone） | 新断言「内容相同的两天只有一天上表 ⇒ 收据归上表那天」 | `git checkout b4cb6d9^ -- …/WorkoutKitBridge.swift` |
| 3 | **🟡 P1-b** | `nil` / `.unknown` → `.notDetermined` | 新增断言/注释；iOS 双脚本保绿 | 单文件 revert |
| 4 | **🟡 P1-c** | 导出 0 条时给可行动提示 | 拒绝授权后不再显示"同步成功" | 单文件 revert |
| 5 | **🟡 P1-d** | `Math.max(startedAtMs, …)` 钳位 | 单测 `startMs:-250` ⇒ 4 段对齐；`npm test` 绿 | `git checkout -- apps/api/src/workout-segments.ts` |
| 6 | **🟡 P1-e/f/g** | 回收加周期调度；staging 命名统一；删除失败进 `errors` | 手工放 25h 前 `.replaced.<uuid>` ⇒ 一次 sweep 后消失；无静默吞异常 | 各自单文件 revert |
| 7 | 🔡 L-1/L-2 | `json_type` 判别；`finish_reason` 断言 | 裸字符串行不再抛错；截断响应被拒 | 单文件 revert |

---

## 七、反向复核：本轮**纠正**了谁、纠了什么

1. **纠正上轮 L-1 的数据描述（结论不变）**。上轮写"当前真实库两键 **271 行全为 `null`**"。
   我实测：`metadata_json.HKMetadataKeySyncIdentifier` **271/271 行非空，且全部是 `array`**；
   `raw_attributes_json` 的两键确实 **0 行**。所以"全为 null"这句话不准确。
   更重要的是**判据换法**：我不再由形状推断可达性，而是**直接把四条 `json_each` 表达式拿去执行**
   —— 全部 `OK`、**零抛错**。结论（今日不可达）成立，但依据从"推断"升级为"实跑"。

2. **纠正上轮 iOS 报告的一处计数**。该报告称 `inactiveLabel` 取得"**2 处**生产调用"。
   精确说法：`inactiveLabel` 只有 **1 处**生产调用（`WorkoutPlanMapper.swift:278` 的 `unofferedDays` 内部），
   "2 处"是 `unofferedDays` 的 **UI 调用点**（`NativeViews.swift:1663` / `TechViews.swift:1641`）。
   结论（重复规则已消除）不变，但数字要准。

3. **收窄上轮 iOS 报告的 🟡-1 表述**。"拒绝把'没授权'报成'同步了 0 条'"只对**从未询问**成立；
   已拒绝的设备今天**仍报成功**（见 §三 P1-c）。把一个窄修复说成普遍修复，会掩盖真实缺口。

4. **独立确认（不引用）两条既有结论**：
   - **墓碑裸 UUID 能命中 —— 撤回正确，且不需要 `WorkoutIdentityMap`**。链路：导出侧对每条训练同时写
     `HKMetadataKeySyncIdentifier`（`:319`）与 `RAIHealthKitWorkoutUUID`（`:320`，= `workout.uuid`）；
     后端四路匹配这两键（`database.ts:2342-2365`）；`utils.ts:90-100` 保证值是 `string[]`，`json_each` 安全。
   - **`b4cb6d9` 的 P1-D/E/F 是真修**，不是"改完看起来修了"：改动都带可定位的行号与断言，且断言能分辨两个判据。

5. **本轮唯一推翻上轮的地方**：上轮（与 iOS 报告）都接受了"`scheduledWorkouts` 不带日期"这一前提，
   并据此把 consume-once 判为合格修复。**该前提为假**（SDK 明确有 `date`），
   修复因此只治了计数、没治归属 —— 详见 §三 P1-a。

---

## 八、未覆盖与限制（如实声明）

- **真机 / 模拟器**：本机 `pod` 不存在、`Pods/` 不入库 ⇒ `xcodebuild` **跑不起来**。
  WorkoutKit 实际上表、`CustomWorkout` 回读、授权弹窗、`ScheduledWorkoutPlan.date` 的**运行时归一化行为**
  均**未做运行时验证** —— 本轮 iOS 结论是**编译级 + 纯逻辑级 + SDK 接口级**。
  （P1-a 的 `date` 比较在真机上是否会被 scheduler 归一化，需真机确认；建议先只比 `year/month/day`。）
- **浏览器 E2E**：本机**无 Chrome/Edge**（实测 `/Applications` 无 chrome/edge）⇒ `test:e2e:web` **未执行**。
- **线上环境**：**未接触**。P0 的**线上命中率未实测**；仅能从"仓库里没有任何重写既有 id 的 migration"
  推断线上同样存在这些重复行，**这是推断，不是实测**。去重迁移前请先在线上库跑一次只读计数。
- **本地库是 2026-09-09 的陈旧副本**（`var/rai.sqlite` mtime 9/9，271 个 workout，`RAIHealthKitWorkoutUUID` 0 行）
  ⇒ 新导出键的**真实落地形状未在真实数据上验证**（只有代码级推断）。
- 本轮**未做** parser/storage 的逐模块深审（上轮列于此处的扫描层结论本轮同样未并入）。
- 审查**未修改任何业务代码**；探针在 `/tmp/raiprobe26/`（含库副本），**未动** `var/` 内任何文件。

---

*报告时点：2026-09-16 07:55（Asia/Shanghai）｜基线 `b4cb6d9`，工作树干净*
*探针：`/tmp/raiprobe26/{probe,idprobe,tombstone}.mjs`（真实库**只读**副本）*
