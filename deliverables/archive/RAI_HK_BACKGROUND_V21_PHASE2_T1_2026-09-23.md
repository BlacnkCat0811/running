# RAI HealthKit 后台可靠同步 V2.1 · 第二阶段任务 1：Workout 伴生 Route 状态机

**日期**：2026-09-23　**范围**：`apps/ios/` 内 Route 追踪的定频改造　**状态**：完成，全部门禁绿

---

## 0. 结论先行

| # | 结论 | 级别 |
|---|---|---|
| 1 | 固定 14 天"每次同步重查窗口内**全部** workout 轨迹"已被**按 workout 的伴生状态机**取代。单次常规同步的 `HKWorkoutRouteQuery` 数从「窗口内 workout 数」降到「真正还可能变化的 workout 数」（稳态通常 0–3）。 | 🟢 已落地 |
| 2 | Route 状态**只有一个住处**：`SyncTaskStore.sqlite` 的 `sync_route_state` 表。无 `UserDefaults`、无独立 JSON、无内存单例。 | 🟢 已落地 |
| 3 | 「跳过一轮」**不改动任何状态**（`lastCheckedAt` 不动、`stableCheckCount` 不加）。这是本轮最危险的一条不变式，有独立回归 + 突变验证。 | 🟢 已落地并验证 |
| 4 | 降频记忆写在 `commitSuccess` **之后**（`HealthKitSync.markSuccess`）。方向刻意选成"失败只多查一次"，而不是"记成已稳定、服务端却永远收不到"。 | 🟢 已落地 + 门禁钉了顺序 |
| 5 | 省略 GPX **不是删除**，前提是 manifest 声明 `sourceScope: "healthkit"`。这条前提已被读代码确认，并新加了一条门禁判据钉住它。 | 🟢 已确认 |
| 6 | 🔴 **预计的收益比我最初估的小得多。** 老实算：1 次/天同步时 14 天累计只有 **−49%**，不是"−80%"。真正显著的是**单次同步**的开销（20 → 0–3），不是总量。依据见 §5。 | 🔴 **下调预期** |
| 7 | 🟡 改动引入一个新的载荷变数：被跳过的 route 不进载荷 ⇒ 内容摘要变化 ⇒ 服务端"未变化"早退锚点可能落空。影响面与建议见 §6.1。 | 🟡 已知，未修 |
| 8 | 🟡 `settled` 行永不清理；`sync_route_state` 随跑步次数单调增长。量级可忽略（每行 ~100 B），但是有意选择，见 §6.2。 | 🟡 有意选择 |

**本轮所有结论要么有可跑的判据，要么明确标成「读代码推断」/「无法确认」。** 逐条见 §4 与 §7。

---

## 1. 步骤 0：审计与迁移方案

### 1.1 改造前的形态（读代码，已逐行核对）

`apps/ios/RAI/HealthKitExport.swift:405-444` `runningWorkouts(store:from:anchorData:)`：

- 有锚点时，除锚点查询外，**再合并一个 14 天窗口**内的全部跑步（`:425-439`，窗口常量 `routeBackfillWindow` 在 `:179`）。这一步是**发现**（把 workout 放进候选集），本身不贵。
- 昂贵的是紧接着的逐 workout 循环 `:282-296`：对候选集里**每一个** workout 调
  `routeEntries(for:store:directory:warnings:)`（定义 `:863-905`），后者对每个 workout：
  1. 发一次 `HKQuery.predicateForObjects(from: workout)` 取 `HKWorkoutRoute`（`:869-875`）；
  2. 对每条 route 发一次 `HKWorkoutRouteQuery` 逐点取回（`:920-948`）—— 这是整个导出里最慢的一步；
  3. 把点写成 GPX（`:950-973`，每点 8 个字段，无抽稀）。

也就是说：**只要 workout 在 14 天窗口里，每次同步都会重新拉一次它的全部轨迹点**，哪怕内容一个字节都没变。

### 1.2 为什么不能用"Route Anchor"

Apple HealthKit **没有** route anchor：

- `HKAnchoredObjectQuery` 只作用于 sample 类型，`HKWorkoutRoute` 不是被那样索引的；
- route 是**附着在 `HKWorkout` 上的衍生资源** —— 要先 `HKQuery.predicateForObjects(from: workout)` 找到它，再用 `HKWorkoutRouteQuery` 逐点取。

⇒ 状态的**主键只能是 workout uuid**。这就是"Workout-Scoped Companion State"的由来，也是本次没有发明任何 API 的地方。

### 1.3 迁移方案：幂等 `CREATE TABLE IF NOT EXISTS`，**不做版本跳变**

`SyncTaskStore.init(directory:)` 用**一条** `sqlite3_exec` 执行一个 `schema` 字符串（`:41-64`），
其中已有 `sync_tasks` 与 `sync_state` 两张表，且注释写明"两张表要么都成，要么整个库不可用"。
新表追加在同一个字符串里，于是它继承了同一条语义。

选它而不是版本号跳变的理由：
1. 本库没有 `user_version` 之类的迁移框架，引入一套就是给一个三表库加一层机制；
2. `IF NOT EXISTS` 对**已有库**和**新装空库**是同一条路径 —— 没有"只在新装时才跑"的分支；
3. 老设备上的库会直接多出一张空表，`loadRouteStates()` 返回空字典 ⇒ 每个 workout 按首查处理 ⇒ 安全。

---

## 2. 改动点清单

| 文件 | 改动 |
|---|---|
| `apps/ios/RAI/RouteSyncState.swift` | **新增**。`RouteSyncStatus` 四态闭集（`unknown`/`active`/`cooling`/`settled`，`String` rawValue 与落盘字符串逐字一致）+ `RouteSyncRecord`（`workoutUUID` / `workoutEndDate` / `status` / `pointCount` / `routeHash` / `lastCheckedAt` / `stableCheckCount`）。 |
| `apps/ios/RAI/RouteSyncStateMachine.swift` | **新增**。`RouteObservation`（观测）+ 纯状态机 `RouteSyncStateMachine`：`baseline` / `shouldQuery` / `decide`，输出契约 `Decision { shouldQuery, nextState }`。无副作用、不读时钟、不读盘。 |
| `apps/ios/RAI/SyncTaskStore.swift` | `schema` 加 `sync_route_state` 表 + `idx_route_status_cooling` 索引；新增 `loadRouteStates(uuids:)`（整表或分块定点读）、`upsertRouteStates(_:)`（单事务批量写 + 事务内回读断言）。 |
| `apps/ios/RAI/HealthKitExport.swift` | `import CryptoKit`；`HealthKitExportResult` 加 `routeStates`；`exportArchive` 加 `routeStates` / `routeForceRescan` 参数；逐 workout 循环改为**先问状态机、再决定查不查**；`routeEntries` 返回 `RouteFetch { entries, observation }`（GPX 内容 SHA256 作摘要）。 |
| `apps/ios/RAI/HealthKitSync.swift` | 导出前 `taskStore.loadRouteStates()` 取快照；`routeForceRescan: full`；两条成功分支把 `exported.routeStates` 交给 `markSuccess`；`markSuccess` 在 `commitSuccess` **之后** flush 记忆。 |
| `apps/ios/tests/RouteSyncStateMachineTests.swift` | **新增**。35 条判据（含 §3.3 那条不变式与一条对全部状态成立的遍历断言）。 |
| `apps/ios/tests/RouteSyncStatePersistenceRegression.swift` | **新增**。35 条判据，真 SQLite：跨实例持久、NULL 与空串可分、分块边界 401 行、注入触发器验证单事务回滚、闭集外的落盘值被扣下而不污染整批。 |
| `apps/ios/tests/run-health-sync-tests.sh` | 新增 2 个编译单元；给既有 `sync-state-commit` 单元补 `RouteSyncState.swift`。 |
| `apps/ios/tests/run-store-tests.sh` | 补 `RouteSyncState.swift`（`SyncTaskStore` 新增的依赖）。 |
| `apps/ios/tests/check-background-capabilities.py` | §14g 语义改写 + 新增 §14h（22 条）、§14i（2 条）、§10k 名单 +2；`MIN_CHECKS` 190 → **216**。 |
| `apps/ios/tests/check-background-mutations.py` | 新增 12 条突变（`[本轮新增2]` 前缀）；`SOURCES` 加 `RouteSyncStateMachine.swift` 与 `run-store-tests.sh`。 |

### 2.1 四个**没有**改动的位置（有意）

- **14 天窗口本身保留**（`routeBackfillWindow`，`:179`）。它现在只决定"候选集"，不再决定"查谁"。
  一条早已 `settled` 的老 workout 一旦滑出窗口，就再也不会被看到 ⇒ 每轮都复核一遍"这批老的还是不是 settled"，
  而复核本身不花任何 HealthKit 查询。门禁 §14g 的三条判据一个字没动。
- **`HealthKitExportResult.routeCount` 的语义变了**（从"窗口里有轨迹的 workout 数"变成"这一轮真的查到了轨迹的 workout 数"）。
  已核对：它唯一的消费点是 `HealthKitSync.swift:1097` 的"空导出"三判据之一，另两个是 `workoutCount`/`recordCount`，不会误判。**不展示给用户。**
- **`gpx-parser.ts` 与 `import-sources.ts` 一个字没改。** 见 §4.3 —— 省略 route 之所以安全，靠的是服务端**已有**语义。
- **`beginBackgroundTask` 与 V2.1 §Phase 0 的冲突未动**（上一轮遗留，仍需产品决策）。

---

## 3. 核心状态机

### 3.1 四态与阈值

| 常量 | 值 | 含义 |
|---|---|---|
| `activeWindow` | 24 h | 高频窗口（按 **workout 年龄**，不是"距上次查询"） |
| `coolingInterval` | 12 h | 冷却期查询节流，按 **`lastCheckedAt`** 计 |
| `settleWindow` | 3 d | 休眠阈值 |
| `stabilityToCool` | 2 | 降频所需的**连续**一致观测次数 |

`shouldQuery`：

```swift
if isForceManualRescan { return true }
switch existing.status {
case .unknown: return true      // 从未观测过，不查就永远没有点数/摘要
case .active:  return true      // 窗口内每次查；窗口外也要查，直到攒够稳定证据
case .cooling: return now.timeIntervalSince(existing.lastCheckedAt) >= coolingInterval
case .settled: return false     // 永久休眠，只有人工重扫能唤醒（已在上面拦掉）
}
```

`decide` 的三处关键点：

```swift
// ① 没查 ⇒ 状态一动不动。宁可下一轮再判，也不许把"这次没看"记成一次检查。
guard needsQuery, let observation else {
    return Decision(shouldQuery: needsQuery, nextState: existing)
}

// ② 首查必然算「变化」：基线里的 (0, nil) 是哨兵，不是观测值。
let isFirstObservation = existing.status == .unknown
let changed = isFirstObservation
    || observation.pointCount != existing.pointCount
    || observation.routeHash != existing.routeHash

// ③ 人工重扫的复位放在变化判定**之前**：
//    一条恰好没变的轨迹若保留旧 stableCheckCount，重扫完第一轮就又够格降频 —— 等于没重扫。
if isForceManualRescan { next.status = .active; next.stableCheckCount = 0; return ... }
```

### 3.2 状态转移（按"是否变化"与"年龄"两轴）

| 当前 | 观测 | 年龄 | 结果 |
|---|---|---|---|
| `unknown` | — | — | `active`，`stable = 0` |
| `active` | 变化 | — | `active`，`stable = 0` |
| `active` | 一致 | `< 24 h` | `active`，`stable += 1` |
| `active` | 一致 | `≥ 24 h` 且 `stable+1 ≥ 2` | **`cooling`** |
| `active` | 一致 | `≥ 24 h` 且 `stable+1 < 2` | `active` |
| `cooling` | 变化 | — | `active`，`stable = 0` |
| `cooling` | 一致 | `> 3 d` | **`settled`** |
| `cooling` | 一致 | `≤ 3 d` | `cooling` |
| `settled` | — | — | `settled`（`shouldQuery` 恒 false ⇒ 走不到这里） |
| 任意（跳过） | `nil` | — | **原样携带** |

### 3.3 那条最危险的不变式

> **「跳过一轮」绝不产生稳定证据。**

破了它不是报错，是**静默丢数据**：一条刚变更过的轨迹会被当成"又一次确认稳定"，
直接降到 `settled`，而 `settled` 只有人工重扫能唤醒 ⇒ 服务端永远收不到它。
这与 ADR-004 决策二「没读到 ≠ 没变化」是同一条不变式在客户端的另一处落点。

它被三层守住：
1. 回归 `RouteSyncStateMachineTests.swift` 的独立边界用例（含一条判别性断言：
   若跳过时错误地盖上 `lastCheckedAt`，12 小时的窗口会被推后，那条断言当场红）；
2. 对**全部状态**成立的遍历断言（以后新增状态会自动被覆盖）；
3. 突变 `[本轮新增2] 跳过的那一轮也把 lastCheckedAt 盖上「现在」` → RED，`assertion_hit=True`。

### 3.4 存储层：批量读写的形状

```sql
CREATE TABLE IF NOT EXISTS sync_route_state (
    workout_uuid TEXT PRIMARY KEY,
    workout_end_date REAL NOT NULL,
    route_status TEXT NOT NULL,
    point_count INTEGER NOT NULL,
    route_hash TEXT,
    last_checked_at REAL NOT NULL,
    stable_check_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_status_cooling
    ON sync_route_state(route_status, last_checked_at);
```

`upsertRouteStates` 沿用 `commitSuccess` 的三条护栏（ADR-004 决策一）：`BEGIN IMMEDIATE` 单事务 ·
每行 `sqlite3_changes() == 1` · **提交前**读回断言逐字段比对。
读写均为批量：`loadRouteStates(uuids:)` 传 `nil` 读全部、传具体 uuid 分块（每块 400）读一批，
不存在 N+1。

---

## 4. 安全性与范围论证

### 4.1 导出侧为什么不能碰数据库

`HealthKitExport.exportArchive` 跑在 `HealthSyncCancellation.runDetached`（脱离主线程）里，
而 `SyncTaskStore` 是 `@MainActor`。⇒ 导出侧**收到**一份 `[String: RouteSyncRecord]` 快照、
**回传**一份决策结果，全程不落盘。这也是 `HealthKitExportResult.routeStates` 必须 `Sendable` 的原因。

### 4.2 为什么降频记忆写在提交**之后**

`markSuccess` 的顺序是 `commitSuccess(...)` → `upsertRouteStates(...)`（门禁 §14h 用 `ordered()` 钉住）。

- 反过来（记忆先落）会造出一个**不可自愈**的窗口：状态机记成"已稳定、可以少查"，
  而这一批数据从未真正交付（上传失败 / 导入失败 / 进程被杀），之后一路降到 `settled` ⇒ 服务端永远收不到。
- 现在这个方向（提交成功、记忆没写上）只损失"下一轮再多查一遍"，且下一轮会自己补上。
- 记忆写失败**不**让本次同步变红（durable 的部分已经提交）：`upsertRouteStates` 会把原因推进
  `taskStore.lastError`，并由 `HealthKitSync` 打一条带原因的 `NSLog`。**不静默，但也不升级成用户可见的失败。**

### 4.3 省略 GPX 不等于删除 —— 逐行核对

| 环节 | 证据 | 结论 |
|---|---|---|
| 载荷声明 | `HealthKitExport.swift:326` 写 `"sourceScope": "healthkit"` | ✅ |
| 服务端判定 | `import-sources.ts:203` `if (declared === "healthkit") return { preserveAbsent: true, reason: "manifest-healthkit" }` | ✅ |
| 孤儿清扫 | `gpx-parser.ts:306` `if (!preserveAbsent) store.pruneOrphanRoutes(allPaths);` | 整句不跑 |
| 文件缺席 | `gpx-parser.ts:328-341`：`if (preserveAbsent) { unresolvedRoutePaths.push(...); continue; }` —— 只有**列在归档里却打不开**才算异常 | 不标 `missing` |
| 收尾清扫 | `gpx-parser.ts:460-475` 整段在 `if (!preserveAbsent)` 内 | 不跑 |
| 候选集 | `database.ts:2175-2181` `routesToImport()` = `SELECT ... WHERE relative_path IS NOT NULL`（**含已 imported**） | 省略的文件根本不进入 `:316` 的循环 ⇒ 一行都不动 |

⇒ 被跳过的 route 在服务端保持原状态、原有 `route_points` 一个字节不变。
**这条安全性完全依赖 manifest 的 `sourceScope: "healthkit"` 声明** —— 已加门禁判据钉住它（§14h）。
一旦哪天改成导出全量快照，跳过 route 就会变成删除轨迹。

### 4.4 跨 actor 与依赖范围

改完后，凡是编译 `SyncTaskStore.swift` 的编译单元都额外需要 `RouteSyncState.swift`。
本轮**实测踩了两次**（`run-health-sync-tests.sh` 与 `run-store-tests.sh`），
而 `typecheck-ios.sh` 是**全量一起编译**的 ⇒ 类型检查照样绿、只在真跑 iOS 门禁时炸。
已加门禁 §14i 用**扫描**代替"记得改三处"。

---

## 5. 降频收益：老实算一遍（**这是模型估算，不是实测**）

### 5.1 方法

- 窗口内 W = 20 次跑步，均匀分布在 14 天（每 0.7 天一次）；
- 同步频率 f 次/天，持续时间 14 天；
- **旧**：workout 只要还在 14 天窗口内，每次同步都查 ⇒ 14 天累计 = Σ(它出生后到第 14 天之间的同步次数)；
- **新**：每个 workout 一生只查约 4–7 次（随 f 变），与之后同步多少次无关。

### 5.2 结果

| 同步频率 | 旧（14 天累计） | 新（14 天累计） | 降幅 |
|---|---|---|---|
| 1 次/天 | ≈ 157 | 80 | **−49%** |
| 2 次/天 | ≈ 306 | 140 | **−54%** |
| 3 次/天 | ≈ 452 | 120 | **−73%** |

**1 次/天时每个 workout 的完整生命周期（4 次查询）**：
`d1` 首查→`active`(s0)；`d2` 一致→`active`(s1)；`d3` 一致且已过 24 h→`cooling`(s2)；`d4` 冷却期满 12 h→一致且年龄 > 3 d→`settled`。此后永不再查。

### 5.3 真正显著的是**单次同步**，而不是总量

| 单次常规同步 | 旧 | 新（稳态） |
|---|---|---|
| 窗口内 20 次跑步**全部已稳定**（典型的一天） | **20** | **0** |
| 窗口内有 1 次昨天的跑步 | 20 | 1 |
| 2 次近两天的跑步 + 1 条冷却期且已过 12 h | 20 | 3 |

🔴 **必须说清楚的话**：`HKWorkoutRouteQuery` 是导出里最慢的一步（`HealthKitExport.swift:920-948`，
逐点回传 + 逐点写盘）。所以"单次同步从 20 条降到 0–3 条"直接体现在**用户等待时间**上，
而 14 天累计的降幅取决于同步频率 —— **同步越勤，省得越多；一天只同步一次，只有大约一半。**
我把最初"约 5–8 倍"的直觉估计下调成上面这张表，因为按真实的时间滑窗算下来它站不住。

---

## 6. 已知问题（🟡，未修）

### 6.1 跳过 route 会改变载荷摘要，可能让服务端"未变化"早退锚点落空

`digestHealthKitExportContent`（`import-sources.ts:254-291`）把 `workout-routes/` 下每个 GPX 的
**文件名 + 字节数 + 内容**都混进摘要。于是：

- `active`/`settled` 的 workout：每轮都查（都在载荷里）或每轮都不查（都不在载荷里）⇒ **集合稳定，摘要稳定**；
- `cooling` 且同步间隔 **< 12 h** 的 workout：查询与跳过交替 ⇒ 载荷里 route 集合在两个形状间翻转 ⇒ 摘要跟着变 ⇒ 锚点命中不了 ⇒ 服务端每次都走完整导入。

**影响面**：只在"冷却态 + 高频同步"这个交叉窗口里存在，量级是每条这样的 route 一次翻转。

**为什么本轮不修**：要修就得动服务端摘要口径（例如让 route 集合由 manifest 显式声明，而不是靠"盘上有什么"推导），
那是另一个范围的决定，不该塞进这次改造。

**建议的后续**：
1. 先把 `coolingInterval`（当前 12 h）确认成"≥ 典型同步间隔"，翻转窗口自然消失；
2. 若确要治本，让 `digestHealthKitExportContent` 只对**载荷声明的** route 集合做摘要，
   同时要求客户端在 manifest 里声明"本轮未包含哪些 route"。

**验证方式**：在真机/服务端上连续两次常规同步，比对 `import_manifest.source_payload_anchor` 是否命中；
本机无法确认（云机通道多数会话未连接）。

### 6.2 `settled` 行永不清理

`sync_route_state` 随累计跑步次数单调增长（每行约 100 B；一年 300 次跑步 ≈ 30 KB）。
**有意不清理**：删掉一条 `settled` 行会让那次同步重新把它当作首查（成本一次查询），
而清理本身需要一个"这条 workout 再也不在窗口里了"的判据 —— 引入新状态不如留着。

### 6.3 `stableCheckCount` 的口径值得写下来

首查记 **0**（因为基线里的 `(0, nil)` 是哨兵不是观测），所以
`stableCheckCount == 2` 意味着"共 3 次观测、其中 2 次与上一次一致"。
回归用例 2 就是按这个口径写的两正一反；**如果以后有人把首查改成记 1，降频会提前一轮**，
`RouteSyncStateMachineTests` 会在那里红。

### 6.4 `settleWindow` 是严格不等号

`age > 3 d`（不是 `≥`）。恰好 72 h 的那次同步仍留在 `cooling`，下一次（≥12 h 后）才 `settled`。
回归用例 6 把这条边界钉住了（`end + 12h` 的 `cooling` → `settled`）。

---

## 7. 验收证据

### 7.1 `npm run test:ios` → **EXIT=0**

```
类型检查 55 个文件（已跳过 3 个仅依赖高德 SDK 的文件）
iOS 类型检查通过
All model regression checks passed.
All ServerSession regression checks passed.
53 sync-state commit regression checks passed        ← 既有，未被扰动
35 route state persistence regression checks passed   ← 新增（35/35）
35 route sync state machine checks passed             ← 新增（35/35）
42 store regression checks passed
Background capability checks: 217 checks, 0 failed
Export determinism checks: 14 checks, 0 failed
iOS 门禁通过（类型检查 + 纯逻辑回归）
```

门禁条数从 **191 → 217**（+26），`MIN_CHECKS` 同步从 190 → **216**（零容忍：少一条就红）。

### 7.2 突变验证 —— **全量**（`python3 apps/ios/tests/check-background-mutations.py`，6m06s）

```
baseline: exit=0 GREEN
mutation check: 74 mutations, 0 failed
负向对照: verdict=COMPILE-ERROR          ← 分类器自身被验证
restored: exit=0 GREEN
FULL_EXIT=0
```

判决分布：`{RED: 74, COMPILE-ERROR: 1}`，**0 条 BAD**，`assertion_hit=True` × 74。
突变总数 **62 → 74**（本轮新增 12 条）。

本轮新增的 12 条：

| 突变 | 门禁 | 预期红在哪条判据 |
|---|---|---|
| 循环里去掉 `shouldQuery` 过滤（写成 `if true`） | PY | 循环不再问状态机 |
| 把降频记忆挪到 `commitSuccess` **之前** | PY | §14h 的 `ordered()` |
| manifest `sourceScope` 改 `full-snapshot` | PY | 不再声明 healthkit |
| 导出前不再读伴生状态快照 | PY | 快照读取点消失 |
| `routeForceRescan` 不再接 `full` | PY | 人工重扫无唤醒通道 |
| 删掉批量写的事务内回读断言 | PY | 回读断言消失 |
| 从 `run-store-tests.sh` 摘掉 `RouteSyncState.swift` | PY | §14i 交叉依赖 |
| **跳过时也盖 `lastCheckedAt`** | SWIFT | 状态没被原样携带 |
| `cooling` 的 12 h 节流改恒真 | SWIFT | 未满 12 h 也查了 |
| 批量写不再 `BEGIN IMMEDIATE` | SWIFT | 半批落盘 |
| 反孤儿 ×2（摘掉两个新回归） | PY | §10k 名单 |

🔴 **一处如实记录**：`不再 BEGIN IMMEDIATE` 这条我最初猜的期望消息是错的 —— 它实际红在**第一条**断言上。
原因值得留档：没有事务时 `COMMIT` 自己会报 `no transaction is active`，
于是 `upsertRouteStates` **报失败、行却已经落下** —— 正是这个形态让"我以为没写"和"其实写了"分不开。
突变的期望消息与描述已按实测改正（`assertion_hit=True`）。

### 7.3 突变后还原 —— 逐字节可证

- `var/mutation-backup/IN-PROGRESS` 标记已清；
- **18 个受管文件与跑前备份的 SHA-256 逐一比对：`mismatch: 0 of 18`**（不是自我报告，是跑前备份的字节）；
- 突变文本扫描（`full-snapshot` / `carried.lastCheckedAt = now` / `Disabled` / `routeForceRescan: false,`）零命中；
- 关键锚点复位（`RouteSyncStateMachine.shouldQuery(` ×1、`routeForceRescan: full,` ×1、`RouteSyncState.swift` 在 store runner 内 ×1）；
- 还原后 `check-background-capabilities.py` → **217 checks / 0 failed**；
- `git status` 条目数与跑前一致（30）。

> ⚠️ **上面这条 `0 of 18` 的时效性**（事后补记，2026-09-23 16:30）：它成立的时间点是**还原那一刻**（15:52）。
> 之后 `routeCount` 语义漂移按"文档债"处理，给 `HealthKitExport.swift` / `HealthKitSync.swift` 各加了一段注释
> ⇒ 现在再比会出现 **2 处 DIFF**，且逐行核对证明**全部是注释行**（`///` / `//`，无一行可执行代码）。
> 复核方法与当轮读数见 `deliverables/RAI_HK_BACKGROUND_V21_PHASE2_T1_MUTATION_2026-09-23.md` §6。
> 保留原文不改写：那句判断对**它自己的时间点**是对的，且这条漂移本身值得留痕。


### 7.4 Node/API 全量基线

`npm test` → **EXIT=0**：`# tests 813 / # pass 809 / # fail 0 / # skipped 4`，Web 侧单跑 `13 files / 86 tests passed`。
**0 fail 才是判据**（上一轮基线是 809/805/0/4，本轮多出的 4 条来自既有的 GPX 配额测试文件，非本次改动）。

---

## 8. ADR-004 不变式继承核对（逐条）

| ADR-004 条目 | 本轮是否遵守 | 证据 |
|---|---|---|
| 决策一：提交**前**断言 + 整事务回滚 | ✅ 同样施加到新表 | `SyncTaskStore.upsertRouteStates` 的三条护栏 + 突变验证 |
| 决策二：先删产物再提交 | ✅ 未触碰 | `HealthKitSync.swift:879/898` 顺序未变 |
| 决策三：GPX 超配额落 `pending` 不落 `invalid` | ✅ 未触碰 | `gpx-parser.ts` 未改 |
| 决策四：`payloadHash` 保持动态 | ✅ 未触碰 | `HealthKitExport.swift:305-341` manifest 仍不带墙钟 |
| 单状态源真相（原则 3） | ✅ 扩展到位 | route 状态进 `SyncTaskStore.sqlite`，门禁判 `UserDefaults` 零出现 |
| 补充 B：`sqlite3_bind_blob` 必须在 `withUnsafeBytes` 闭包内 | ✅ 不适用但留了绊线 | `route_hash` 是 TEXT（走 `withCString`+`transient`）；门禁判 `route_hash TEXT`，改类型时会提示回看 ADR |
| 阻塞态绝不推进 anchor | ✅ 未触碰；且新增顺序判据 | `SyncStateCommitPlan.mayCommit` 调用点未变；§14h 的 `ordered()` |

---

## 9. 验收标准与回滚

### 9.1 验收标准（已全部满足）

1. `npm run test:ios` EXIT=0，且门禁条数 217 / 0 failed；无回归文件变成孤儿（§10k 名单已 +2）。
2. `npm test` 基线不劣化（§7.4）。
3. 新增回归两条各 35 条判据、全绿；`[本轮新增2]` 12 条突变全 RED。
4. `sync_route_state` 是 Route 状态的唯一住处（门禁 3 条判据）。
5. 「跳过不产生稳定证据」有独立回归用例 + 突变验证。

### 9.2 回滚方式

| 层 | 动作 | 影响 |
|---|---|---|
| 最快（**不改代码、不重启**） | 在 App 沙盒里 `DELETE FROM sync_route_state;` | 下次同步全部按首查 ⇒ 行为等价于改造前 |
| 代码回滚 | `git revert` 本轮 commit；或临时把 `HealthKitExport.exportArchive` 的 `routeStates` 传 `[:]` 且 `routeForceRescan: true` | 每个 workout 每轮都查 ⇒ 完全回到改造前 |
| 只关过滤、留表 | `routeForceRescan: true` 常开 | 表照写但永不生效；适合"收益有副作用、先观察" |

**三层都不涉及服务端、不涉及导入链路、不涉及 `sync_state` 水位。** 这是刻意的：
降频记忆是**缓存**，把它丢掉只会多花时间，不会丢数据。

---

## 10. 红队质询与自我推翻

| 质询 | 结论 |
|---|---|
| "你说省 5–8 倍，怎么算的？" | **推翻了自己。** 按真实的 14 天滑窗算，1 次/天同步只有 −49%。见 §5。 |
| "跳过 route 会不会把服务端的轨迹删了？" | 不会，但**前提是 manifest 声明 healthkit**。逐行核对见 §4.3，并加了门禁判据。 |
| "记忆先落盘会怎样？" | 会造出不可自愈的窗口。已改成提交后落盘 + 门禁钉顺序。 |
| "`stableCheckCount` 首查算 0 还是 1？" | 我最初按 1 写测试，**被自己的回归打红**，改回 0 并写进 §6.3。 |
| "`Date` 经 SQLite REAL 往返能直接 `==` 吗？" | **实测过，能。** 因为 `t1970 ≈ 1.756e9` 与 `978307200` 之比 < 2，减法满足 Sterbenz 引理因而精确；200,000 组样本（含小数秒、含 `.distantPast`）0 组有损。所以用的是严格 `==` 而不是容差。 |
| "`routeCount` 语义变了，会不会误导用户？" | 已核对唯一的消费点并确认不展示。 |
| "为什么不动 14 天窗口？" | 滑出窗口就再也看不到那条 workout，复核"它还是不是 settled"就没了。窗口留着，代价是 0 次 HealthKit 查询。 |

---

## 11. 明确无法确认的事

1. **§6.1 的摘要翻转在真实链路上到底发生多少次** —— 需要连续两次真机同步 + 服务端
   `import_manifest.source_payload_anchor` 的命中记录。本机云机通道多数会话未连接，无法取证。
2. **模拟器上的端到端行为** —— HealthKit 的 `HKWorkoutRouteQuery` 在模拟器里没有真实轨迹可读，
   本条改造的运行时表现只能靠真机验收。模拟器能力边界见
   `deliverables/RAI_HK_BACKGROUND_V21_GAP_2026-09-23.md`。
3. **§5 的模型估算**：假设了同步频率恒定、workout 均匀分布。真实设备上 `BGProcessingTask`
   的唤醒时机不可控，实际分布会更不均。量级方向不受影响，具体百分比会漂。
