# ADR-004：HealthKit 后台同步的四条不变式（封板记录）

- **状态**：已接受（Accepted）· **封板日期**：2026-09-23
- **范围**：`apps/ios/RAI/` 的 HealthKit 同步写入路径 + `packages/health-export-parser/` 的 GPX 配额
- **历史来源**：封板讨论从 Git 查阅；下列决策仍有效，文中旧测试计数只代表封板时记录，不是当前审查结果。
- **依据规范**：《RAI HealthKit 后台可靠同步系统 V2.1 架构设计与实施规范》

> ### 🛑 如果你觉得下面某一条"写错了、像个 Bug"——先读这里
>
> 这四条**每一条都是先写成了看起来很合理的样子，然后被推翻的**。
> 它们的"奇怪"之处正是被红队质询之后剩下的形状，而不是没做完。
> 要改任何一条，必须先能回答：**"改完之后，哪个具体场景从错变对了？"**
> 答不上来就不要改——本仓已经在这四条上各付过一次代价。

> ### 编号说明（诚实记录，勿当疏漏）
>
> 本仓此前**没有 ADR 目录与编号惯例**，也没有 ADR-001 ~ ADR-003 的正式文本。
> 编号 `004` 沿用封板指令里给出的编号；`ADR-001 ~ 003` 目前**不存在**。
> 若要补齐，应优先回填这两条已被代码依赖但从未成文的历史决策：
> ① 服务端不改（2026-09-22 决策 D1：成功导入过的 HealthKit 上传会被 retain ⇒ 不得假设 `sourceId` 可跨小时复用）；
> ② 冻结 <1024px 响应式区（见 `AGENTS.md`）。

---

## 决策一：断言必须在**事务提交前**（Pre-Commit Assertion）

### 背景

成功收尾要一次做两件事：把 anchor / 导出水位写进 `sync_state`，并删掉 `sync_tasks` 里的任务行。
写入路径是 `SyncTaskStore.commitSuccess`（`apps/ios/RAI/SyncTaskStore.swift`）：

```text
BEGIN IMMEDIATE → 读旧值 → upsertState(UPSERT) → 回读断言 → DELETE sync_tasks + changes()==1 → COMMIT
```

### 曾经的反转

初版方案把回读断言放在 **`COMMIT` 之后**，理由是"先让提交落地，再验证它确实落地了"。
**红队质询后推翻。**

### 决定

**回读断言必须发生在 `COMMIT` 之前，且在同一个事务内。** 断言失败 ⇒ 整段 `ROLLBACK`，
对外只呈现"这次没提交上"这一个异常方向。

### 理由

提交之后再断言，失败时会同时出现两句互相矛盾的话：

- 客户端向 UI 报 **"同步失败"**；
- 而 `markSuccess` 早已把 `lastSyncAt` 写成 **"刚刚"**。

数据**已经入库**，用户看到的却是失败 —— 他会去重试、去怀疑数据丢了，而真相是"全都在，只是我们报错了"。
把断言放在提交前，"数据已入库"与"报失败"这两个状态**在物理上不可能同时出现**。

### 可证伪性（这条不是"写着好看"）

- **回归**：`apps/ios/tests/SyncStateCommitRegression.swift`（57 条）与
  `apps/ios/tests/RouteSyncStatePersistenceRegression.swift`（39 条）；
  2026-09-24 追加的第 3b / 第 11 节按职责分别住在这两处（水位在提交回归、route 在落盘回归），包含
  注入 `CREATE TRIGGER … BEFORE UPDATE ON sync_state` 与 `… BEFORE DELETE ON sync_tasks` 的**强制失败**用例，
  验证失败路径确实整段回滚、且不留下半份状态。
- **结构门禁**：`apps/ios/tests/check-background-capabilities.py` §14
  钉住 `readBackMatches(` 在 `commitSuccess` 体内、`ordered(BEGIN IMMEDIATE → upsertState → "COMMIT")`、
  以及 `guard removed == 1 else` / `guard touched == 1 else` 的**比较值**。

### ❌ 不要这样改

- 不要把回读断言挪到 `COMMIT` 之后（哪怕只是为了"更快返回"）。
- 不要把它降级成"打印一条 warning"。它是一道**闸门**，失败必须回滚。

---

## 决策二：严格**先删本地产物，再提交**（Remove Artifacts Before Commit）

### 背景

一次导出可以产出**几个 GB** 的 `upload-<payloadHash>.{zip,multipart}`
（`HealthKitSync.swift` 的 `removeTaskArtifacts(payloadHash:)` 负责删，`:1493-1501`）。

### 曾经的反转

初版方案主张**"提交是事实，清理是副作用"**，所以顺序改成 **提交 → 删产物**。**红队质询后推翻。**

### 决定

**保持"删产物成功 → 才提交"的顺序。** 提交与清理之间不存在"先提交更安全"这条。

### 理由

`removeTaskArtifacts` 的删除动作是 `try? FileManager.default.removeItem(at:)`（`:1499`）——
**失败是静默的**。而全仓**没有**任何全局孤儿回收进程：

- `removeAllTaskArtifacts()`（`:1507-1513`）的**唯一**其它调用点在 `:1621`，
  触发条件是"任务进度读不出来"（载荷解码失败路径），**不是**一个定时清理器；
- 也就是说：**提交成功后删文件失败，就没有第二个东西会来碰这份文件。**

后果是磁盘上留下无主的 GB 级 ZIP，且**不可归因**（没有任务行指向它，用户与日志都看不到它）。

反过来，现状顺序的失败方向是**便宜的**：删产物成功而提交失败 ⇒ 任务行还在
⇒ 下次唤醒拿同一份载荷、同一个 `payloadHash` 重传 ⇒ 服务端按幂等键命中同一条来源。**这条路径是幂等的。**

### 可证伪性

- 结构门禁钉住 `full` 重新导入必须**同时** `forgetState(scope:)` 与删老键，
  否则迁移期回退路径会把刚忘掉的锚读回来（`check-background-capabilities.py` §14e，突变已验证会红）。

> ⚠️ **2026-10-17 修订（见文末「修订 1」）**：`full` 入口已删除，判据改为
> 「`if full` 块与 `forgetState` 必须**不存在**」。本条其余论证仍成立。

### ❌ 不要这样改

- 不要把顺序改成"提交 → 删产物"，除非**同时**引入一个真正的孤儿回收机制
  （扫描产物目录、按 `payloadHash` 反查是否还有任务行）。
- 不要把 `try?` 改成 `try`（会让一次删文件失败中断整个收尾流程，代价大于收益）；
  两个方向的取舍已经算清：**留文件可回收，丢状态不可回收。**

---

## 决策三：GPX 配额熔断必须落 `pending`，**绝不能落 `invalid`**

### 背景

服务端超配额时有三种可能的下游状态：`pending` / `imported` / `invalid`
（`workout_routes.file_status`）。配额分支在 `packages/health-export-parser/src/gpx-parser.ts`。

### 曾经的反转

初版方案用 **`invalid`** 表达"这份文件不合格"。**红队质询后推翻。**

### 决定

**配额超限落 `pending`**（`gpx-parser.ts`）；`invalid` 只保留给**真的坏了**的文件
（解析失败的 `invalid_xml` 路径，`:446`）。

### 理由（这是四条里后果最重的一条）

`markRouteStatus(id, "invalid")` 会：

1. `DELETE FROM route_points`；
2. 把 `point_count` 归零。

而重算管线（`recompute-pipeline.ts`）的汇总**只统计 `file_status = 'imported'`**。
⇒ 用 `invalid` 表达"超配额"，会让**该次跑步的轨迹与高程增益静默消失**，
用户看到的不是"同步失败"，而是 **"这次跑步没有轨迹"** —— 不可归因，看起来像数据本身缺失，
而且 `invalid` 意味着**永远不会再重试**。

`pending` 是诚实的表述：**"我们知道这个文件，但我们还没有导入它。"**
两个状态的下游成本相同，但只有 `pending` 保留了重试的可能。

### 可证伪性

- `packages/health-export-parser/test/gpx-quota.test.ts` 第 2 条断言：
  超点数的路线被拒 ⇒ 状态为 `pending` + 产生 issue，且**兄弟路线仍是 `imported`**
  （证明"拒绝一份"不会波及整批）；第 3 条断言超字节的路线**完全未被改动**。
- 代码注释逐字记录了这次反转的推理（`gpx-parser.ts`）。

### ❌ 不要这样改

- 不要为了"状态语义更准确"把配额拒绝改回 `invalid`。
- 不要把"字节超限"的检查挪到 `beginRoutePointReplacement` **之后** ——
  现状是在它之前拒绝，被拒的文件**完全没被碰过**。

---

## 决策四：维持 `payloadHash` 的**动态**生成特征（不要"修"）

### 背景

`payloadHash` = **原始 ZIP 字节**的 sha256，被当作 batchId 用于 `X-RAI-Sync-Batch` 幂等头。
导出 ZIP 里带 `<ExportDate>`（**墙钟**，`HealthKitExport.swift`），
⇒ **每次导出 `payloadHash` 都不同**，看起来像一个幂等键缺陷。

### 曾经的反转

红队报告曾把这条列为缺陷（"幂等键每次都变 ⇒ 幂等失效"）。**主代理核对代码后否掉了这条。**

### 决定

**`payloadHash` 的生成逻辑保持不变。** 这个"每次变"是**已知且有意**的设计。

### 理由

幂等性并不依赖"同一个用户永远算出同一个 hash"，而是由**两道边界**保证：

1. 🔴 **盘上有持久化任务行 ⇒ 永远不返回 `.startFreshSync`**
   （`BackgroundSyncPolicy.swift`）。任务行的存在本身就说明"有一个批次还没走完"；
   想重新导出只有**一个合法入口**：用户显式点「重新导入全部」。
   这条不变式由 `BackgroundSyncPolicyRegression` 在**全参数组合**上钉死。

   > ⚠️ **2026-10-17 修订（见文末「修订 1」）**：该入口已删除。现在不存在任何"重新导出全部"
   > 的入口；损坏游标只能显式「修复增量游标」（只清坏掉的那一个）。
2. 内容层面另有一把**稳定的**摘要：`digestHealthKitExportContent`
   （`apps/api/src/import-sources.ts`，会剥掉 `<ExportDate>`），
   供"这份载荷是否就是产生当前主库的那一份"这类判断使用。

也就是说：**频控/防并发靠边界（规则 1），内容比较靠稳定摘要（规则 2），
`payloadHash` 只承担"这是哪一次导出"的短期身份。** 三者职责不同，不该合并。

### ❌ 不要这样改

- 不要把它改成"内容摘要"以求稳定 —— 那会让"两份来源、两个 job"的
  `BackgroundSyncPolicy.swift` 自述约束失效。
- 不要因为它"每次变"就认为幂等没生效：幂等的入口是
  `import_sources.idempotency_key = sha256(serverId\0athleteId\0datasetEpoch\0batchId)`，
  在同一次批次内是稳定的。

---

## 补充 A：GPX 三级配额的基准参数与"为什么不照抄规范"

规范给的三个数字是 **20 MB / 50,000 点 / 200,000 点**。本仓**三个都没照抄**，
固化为（`packages/health-export-parser/src/gpx-parser.ts,65,80`）：

| 层级 | 规范 | **本仓固化值** | 类别 |
| :--- | :--- | :--- | :--- |
| 单 GPX 文件 | 20 MB ⇒ 413 | **64 MiB** | 拒绝（413 语义） |
| 单 workout 轨迹 | 50,000 点 ⇒ 422 | **300,000 点** | 拒绝（落 `pending`） |
| 整批点数 | 200,000 点 ⇒ 422 | **20,000,000 点** | **只记 issue，从不拒绝** |

### 推导依据（每条都可核对）

1. **每点约 213 字节**：`HealthKitExport.swift` 的 `gpx(_ locations:)`
   逐点**无抽稀**地写 `trkpt` + `ele` + `time` + `speed` + `course` + `hAcc` + `vAcc`
   （`lat`/`lon` 在 `trkpt` 属性里）⇒ 8 个字段。
2. **24 小时百公里越野 ≈ 86,400 点 ≈ 18.4 MB**（按 1 Hz 采样）。
   ⚠️ **这个体量正好压在规范的 20 MB 线上** —— 规范阈值会把一次合法的超马轨迹误杀。
   取 **64 MiB ≈ 最坏合法值的 3.5 倍**。
3. **50,000 点 @1 Hz 只有 13.9 小时** —— 同样会误杀 24 小时越野。
   取 **300,000 点 ≈ 83 小时**，并**刻意低于字节上限能容纳的点数**
   （64 MiB ÷ 213 B ≈ **315,000**）：若点数上限高于字节上限能容纳的点数，
   它就是一个**永远不会生效的摆设**。
4. **200,000 点/批必须先算重建场景**：「重新导入全部」会导出**全部**跑步及其全部路线
   （`if full` ⇒ anchor 置空 ⇒ `runningWorkouts` 无日期谓词 ⇒ 全量）。
   一个三年、每周 3 小时的用户 ≈ **168 万点**，超 200,000 达 **8.4 倍**。
   ⇒ 整包被拒意味着**用户再也无法重建**，而且每次重试都会被拒。
   取 **2,000 万点 ≈ 4.3 GB 路线数据 ≈ 累计 5,500 小时**，
   落在 `DEFAULT_LIMITS.maxExtractedBytes`（12 GiB，`import-sources.ts`）之下 ⇒
   它是**异常观测**，不是闸门，因此**只记 issue**。

### ❌ 不要这样改

- 不要把这三个数字"对齐规范"以求一致。规范给的是**理论量级**，
  而这里的数字来自**本仓自己生成的文件的实际字节数**。
- 不要收紧到"刚好够用"。配额能成立的前提**不是"处置得巧"，而是"合法数据碰不到"**：
  超限的代价是那次跑步拿不到轨迹与海拔，而它**不可归因**。

---

## 补充 B：`sqlite3_bind_blob` 必须完全在 `withUnsafeBytes` 闭包**内部**

### 症状（实测，不是假想）

```swift
// ❌ 悬垂指针：baseAddress 只在闭包执行期间有效
sqlite3_bind_blob(statement, 2, anchor.withUnsafeBytes { $0.baseAddress }, Int32(anchor.count), SQLiteSupport.transient)
```

它**不是**崩溃，而是**写进去的 blob 内容不确定** ⇒ 同事务内的回读比对失败 ⇒ **整段回滚**。
当时的报错是 `Precondition failed: a commit with one pending task row succeeds`，
用一个独立的最小复现脚本才定位到"读回的 anchor 与写出的不一致"。

### 正确写法

```swift
// ✅ 绑定完全在闭包内完成
let bound = anchor.withUnsafeBytes { buffer in
    sqlite3_bind_blob(statement, 2, buffer.baseAddress, Int32(anchor.count), SQLiteSupport.transient)
}
guard bound == SQLITE_OK else { fail("state anchor bind"); return false }
```

落点：`apps/ios/RAI/SyncTaskStore.swift`（`upsertState`）。

### 为什么这条必须单独记一笔

1. **失败形态是"数据悄悄变成别的东西"**，编译器、类型检查、普通的单元测试都看不见；
   唯一能抓住它的是**同事务内的回读断言**（决策一）。
2. 这也反过来说明**决策一不是装饰**：它是这个 bug 的唯一探测器。
3. `save(_:scope:)` 原本就是这个正确形状；这条记录是为了防止后来者"顺手重排一行"。

### ❌ 不要这样改

- 不要把 `bind_blob` 的返回值丢掉（`sqlite3_bind_*` 会失败，尤其是 `SQLITE_TOOBIG`）。
- 不要为了"少一层闭包"把绑定挪到外面。

---

## 补充 C：`Date` ↔ REAL 列**不是双射** —— 落盘前必须吸附到不动点

*（2026-09-24 追加。这是决策一那道回读断言的**第二次**收获，第一次是补充 B。）*

### 症状（真机报出，本机已复现）

同步时用户看到：**「同步水位写入后无法读回一致的值，本次提交已回滚。」**

它不是偶发：`HealthKitExport.swift` 的 `let exportedThrough = Date()` 带完整小数秒，
而 `sync_state.export_end` 是 REAL 列，写入走 `timeIntervalSince1970`、读回走
`Date(timeIntervalSince1970:)` —— 这两步合起来**不是恒等映射**。

`Date` 内部存 `timeIntervalSinceReferenceDate`，与列里的 `timeIntervalSince1970` 差常量
978307200。对 2026 年的时间戳二者之比 ≈ 1.8（< 2），加法那一步落在 Sterbenz 引理的邻居
情形上：结果的 ulp（2⁻²¹）是原值网格（2⁻²³）的 2 倍 ⇒ **原值最低位为 1 的时间戳会被舍掉一位**。

本机逐 ulp 扫 200,000 个真实时间戳的实测：

| 形状 | 往返有损 |
| :--- | :--- |
| 逐 ulp 扫描 | **100,000 / 200,000**（恰好一半） |
| 整秒时间戳 | **0 / 200,000** |
| `Date()` 的当前值 | 有损 |

⇒ 回读断言拿**原始 Date** 去比读回来的 Date，约一半概率判不等 ⇒ 一次**完全成功的**提交被
整段回滚（决策一让异常方向只剩"这次没提交上"，所以它没有写坏数据，但用户就是同步不了）。
route 一侧同因：`HealthKitExport.swift` 的 `routeNow = Date()` 同样带小数秒。

### 🔴 为什么两层门禁此前都看不见它

`SyncStateCommitRegression.swift` 的 fixture 是 `Date(timeIntervalSince1970: 1_700_000_000)`
与 `1_800_000_000` —— **整秒**，而整秒的往返有损率是 0/200000 ⇒ 那批回归**永远绿**。
这是「跑绿 ≠ 断言有效」的教科书形态：**fixture 的值落在守卫的盲区里**。

### 决定

**写入前把时间点吸附到该映射的不动点**（`Date.canonicalForREAL`），写与回读断言**共用同一个值**：

- `commitSuccess` 入口：`let watermark = requested.storedInREAL`
- `upsertRouteStates`：对每条 record 的两个时间字段做同样处理，**且比较用的也是规范化后的
  record**（只规范化绑定值是没用的 —— 断言比的是整个 `RouteSyncRecord`）

代价：时间点被吸附到约 1e-7 秒的网格上。对"上次导出到哪儿 / 上次查过没有"这两个语义无关紧要。

### 可证伪性

- **回归**：`SyncStateCommitRegression.swift` 第 3b 节。fixture 取 `1_790_000_000` 的
  `base + 1 ulp`（**确定有损**），并**把前置条件也写成断言**
  （`the lossy fixture must actually lose a bit in the REAL round trip`）——
  这个 fixture 哪天变回无损，那几条会立刻红，而不是静默空转。
- **结构门禁**：`check-background-capabilities.py` §14h-2 钉的是**写入路径的调用点**
  （`requested.storedInREAL` / `canonicalForREAL`），不是只钉函数定义 ——
  删掉调用点、定义还在，故障照样回来。
- **突变**：`check-background-mutations.py` 两条（拿掉 `storedInREAL` / 拿掉 route 的
  `canonicalForREAL`），期望红在**可跑回归**上。

### ❌ 不要这样改

- 不要改回"拿原始 Date 直接比"（哪怕理由是"`Date` 的 `==` 更直观"）。
- 不要用"放宽断言"绕过（例如只比 `abs(a-b) < 1e-6`）—— 那会把"写入被静默忽略"与"写对了但
  最低位不同"混成同一种东西，决策一这道闸门就废了。
- 新增 REAL 时间列时不要另起一套比较 —— 落盘的时间点都必须过 `canonicalForREAL`。

### 与补充 B 的关系

两条是**同一个探针的两次收获**：补充 B 是"写进去的内容不确定"，补充 C 是"写进去的内容确定，
但**读回来的不是它**"。两条都只在**同事务内回读**这一处才会暴露 —— 这再一次说明决策一不是装饰。

---

## 这些不变式由什么守住（三层，缺一不可）

| 层 | 载体 | 挡的是 |
| :--- | :--- | :--- |
| **结构门禁** | `apps/ios/tests/check-background-capabilities.py` | "改错了照样编译通过"的形状问题：调用顺序、比较值、判据载体是否还在 |
| **可跑回归** | `SyncStateCommitRegression.swift`（57 条）、`RouteSyncStatePersistenceRegression.swift`（39 条）、`BackgroundSyncPolicyRegression`、`gpx-quota.test.ts`（4 条） | **语义**：锚点改名挡不住的那些（例如 `mayCommit` 被改成恒真） |
| **突变验证** | `apps/ios/tests/check-background-mutations.py` | 上面两层的**断言有效性**本身：跑绿只说明"没红"，不说明"改坏了会红" |

⚠️ 括号里的条数一律是**时点快照**，会随每次改动增减 —— 要引用数字就现跑一遍，别照抄这里的。
**本文件因此不写具体条数。** 2026-10-09 那批改动曾在这里写下"capabilities 256 / mutations 90"，
而这两行在**同一批改动的最终态**就已经不等于实测值 —— 说明"贴一个日期"本身并不赋予数字可信度：
数字会被同一天的后续改动立刻甩掉。要数字就跑
`python3 apps/ios/tests/check-background-capabilities.py` 与
`python3 apps/ios/tests/check-background-mutations.py` 看输出；capabilities 的 `MIN_CHECKS`
地板是**机器强制**的（少一条判据就红），比这里的文字可靠。
（更早这里写的 220 / 76 是**无日期**快照 —— 那才是真正会误导的形态：照它读会以为"门禁条数没变"，
把真实增量读成零。）

⚠️ 已知的效力边界：**结构门禁只钉调用顺序，钉不了语义**。
实测：把 `SyncStateCommitPlan.mayCommit` 改成恒返回 `true`，
结构门禁**照样绿**，红的是可跑回归（`Precondition failed: mayCommit disagrees with isBlocked at deferred_protected_data`）。
⇒ **两层都要有；少任何一层都会留下一个"静默通过"的方向。**

---

## 什么情况下应该重新审视这些决策

不是"永远不许改"，而是"要改必须先满足下列条件之一"：

- **决策一**：出现了"提交前断言会挡住某个合法路径"的可复现反例
  （例如某个合法写入被回读断言误判 —— 注意 `.advance` 的单调性已经被 `max($0, requested)` 处理过一次）。
- **决策二**：磁盘上出现了可归因的孤儿产物回收机制（定时清理或启动扫描）。
- **决策三**：`workout_routes` 新增了一个"超配额但仍保留轨迹"的独立状态，使 `pending` 的语义与新状态冲突。
- **决策四**：`BackgroundSyncPolicy` 的"有任务行即不重新导出"不再成立（例如引入了多批次并行上传）。

四条都要求同一个动作：**先写出"改完之后哪个场景从错变对"的判据，再去动代码。**


## 2026-09-24 补充：后台恢复与 scope 隔离

- 离线握手仅恢复候选身份，任务执行以在线握手为准；两者复用原有 64 位 URL 哈希缓存键。
- 轨迹状态键为 `(scope, workout_uuid)`。旧表没有可信归属，事务迁移只清除降频记忆，保留任务与水位；版本标记防止重复清除。
- 意图按代次确认，确认必须排在任务保存/成功提交之后。失败不确认，晚到通知不被旧代次吞掉。
- 纯策略断言不代替接线验证：真实 UserDefaults、SQLite 失败与旧库升级回归，以及结构门禁共同覆盖本次修复。

## 2026-09-24 补充（第二轮）：待办判定必须按目标读取

- **"这个目标还有没有事要做"是一个按 URL 现读的问题**，答案只能来自只读探针
  （`probePendingWork`），不能来自 `HealthKitSync` 上的展示标志 —— 后者属于最后一次写它的那个目标，
  而单飞闸门拒绝的一轮从未写过任何标志。探针的判定是**三值**：有任务 / 确认空 / 不知道。
  "不知道"（读盘失败、或库里有行但归属无法确定）既不许当成"没有待办"（会静默丢批次），
  也不该被当成"有待办"永久重排 —— 因此身份未知时以"整库是否有任何任务行"作旁证。
- **调度与完成回执共用同一个输入**：一个目标的待办快照。`reportedSuccess` 只在
  "确认空且没有挂着的通知/恢复请求"时为真；其余（含不知道）一律报失败。
- **意图与恢复请求是两个成因、两个存储槽**：合成一个槽会让一批旧 scope 的导出顺手确认掉
  "新 scope 还没有批次"这条依据。两者的观察点都在**导出起点**，只有真正重新读 HealthKit 的那条路
  才有资格认领通知；续传路径不得吃掉它之后到达的通知。
- **"有旧任务就合成一条新数据意图"是错的**：旧任务本身就是重试依据，而合成出来的意图既无人可确认
  （续传分支不认领），又会让后续多跑一次全量导出。
- **受控重开**：日志打开/迁移失败不再等于"这个进程的续传能力作废"。重开是安全的，因为失败的迁移
  已经回滚、版本标记幂等、且重开不删除任何文件。只读探针不重开；取得单飞所有权后、读取任务前
  每次执行最多重开一次，失败按 `unknown` 保留重排依据。
- **权威身份统一发布**：Native 页面连接、刷新及 HealthKit 同步都先为变化后的目标 scope 持久化
  恢复请求，再更新原有握手缓存。请求带代次，只有目标 scope 的新导出落盘才能确认。
- 依赖"两条回调谁先跑"（`applicationDidEnterBackground` 与 SwiftUI `scenePhase`）的写法一律不可接受：
  两者之间没有先后保证。

## 2026-10-09 补充：非 Workout 变更游标

- 记录事件日期不代表到达/删除时间：数量与睡眠查询的 anchored predicate 固定为 nil，
  按类型分页直到新增与删除均为空。历史补读先排空旧 anchor，再从 nil 读取；
  权限缺失/空结果从不升级为“缺席即删除”。
- 记录游标属于业务交付状态，不是 Route 降频记忆。候选游标随 ZIP 写入任务，
  所有恢复成功路径使用同一候选值；只有服务端确认后才与 Workout 水位、任务删除同事务提交。
- 新 manifest 能力以新增握手字段声明，不改变旧身份版本。服务端能力缺失时，
  新导出和已保存 v2 批次恢复都必须停止，绝不能接受忽略删除语义的成功。
- 源 UUID 映射由新增 v30 表承载，不改历史 ID 公式或原地重写记录 ID。
  明确删除先写源 tombstone，再扫描新增，避免同包旧 UUID 在 XML 后部覆盖新 UUID 替换值。
- 升级前已删除且从未携带 UUID 的记录不可猜测匹配：安全清理须走经过验证的完整 XML
  快照/移除保护。边界、迁移命令和可跑判据见 [记录同步 v2](../HEALTHKIT_RECORD_SYNC_V2.md)。

## 2026-10-09 补充（2）：投递的「记」与「跑」必须分开（P1 可达性）

**缺陷**：`SyncDeliveryPolicy.decide` 把"已有同步在跑"与"后台节流窗口内"两种情形一并判成
`.ignore`，而调用方（`RaiStartup.registerSyncEntryPoints`）在 `.ignore` 分支里直接 `break` ——
**这条健康数据通知既没有代次，也不驱动任何后续轮次**。正在跑的那一轮的导出起点早于这条通知，
它的字节覆盖不到这次变化；旧批次收工清空之后，后台按快照判定"无待办"，自动同步停在原地，
直到下一次投递、打开 App 或用户手动点同步。代次确认（`shouldAcknowledgeIntent`）只能保护
**已经记下来**的那一代。

**决定**：

- **单飞与节流只限制"执行"，不限制"记忆"。** 一次投递就是一次真实的数据变化，只要目标已绑定，
  就先 `recordBackgroundIntent`，再按 `decide` 的返回值决定这一轮怎么跑。`Decision` 上多出来的
  `deferToBackgroundLater` 表示"记下来，但排一次**延后**的后台执行"（`resubmitDelay`，与节流窗口
  同量级）；**只有未绑定服务端才是真的 `.ignore`**（没有目标 ⇒ 意图也没有东西能消费它）。
  判据的载体是 `Decision.recordsTheDelivery`，它回答"要不要记"，而 `decide` 只回答"现在跑不跑"。
- **不立即 `submit` 是刻意的**：BGTask 与正在跑的那一轮撞车只会被单飞静默拒绝，换来一条
  "跑过了"的假记录（见 `BackgroundRunPolicy.reportedSuccess` 的说明）。
- 🔴 **一轮收工后必须把"这一轮没覆盖到的那一代"接过去**（`SyncFollowUp.handoff`）：前台且还有
  额度 ⇒ 当场补跑（用户正看着界面）；否则排一次后台执行。**前台补跑有硬上限**
  （`maxForegroundRounds = 1`）—— HealthKit 大批导入期间会连发投递，没有上限的"补跑"就是前台自旋，
  每次自旋都是一轮 GB 级导出。这与 §15b 的后台重排是同一条纪律的两次应用：**"留下来"与"有人来接"
  是两件事**，少了接手的那一方，通知会一直躺在盘上。
- `PendingWork.hasUncoveredGeneration`（通知 + 恢复请求）与 `needsAnotherRound`（再加上"盘上卡着
  一批没走完的字节"）刻意分开：补跑新代次不该顺手重放一次失败的批次，那只会把网络错误原样重放一遍。

**可证伪性**：

- **可跑回归**：`BackgroundSyncPolicyRegression` 的 `unboundDeliveriesAreIgnored` /
  `aDeliveryDuringARunningSyncIsNeverDropped` / `aThrottledDeliveryIsStillRemembered` /
  `uncoveredGenerationsAreHandedOff`。期望值逐格手写（不拿实现推一遍），且 `main()` 的调用顺序
  决定"红在哪一条上" —— 每条突变只允许被**它自己那一条**断言抓住。
- **结构门禁**：`check-background-capabilities.py` §15c 钉"意图记在派发**之前**"
  （`ordered(recordsTheDelivery → switch decision)`）、`deferToBackgroundLater` 的排程接线、
  以及收工后的交接被生产调用（`SyncFollowUp.handoff` 不能是孤儿）。
- **突变**：`check-background-mutations.py` 七条（`[P1]` 组）：运行中⇒ignore、节流⇒ignore、
  未绑定也记意图、前台补跑无上限，以及三条结构门禁（分支里才记意图 / 不交接 / 不排执行）。

⚠️ 边界：这条修复保证的是**自动同步链路不会断**（每一代变化要么被某一轮导出覆盖，要么被记下
并且有一轮被排出来）。它**不**保证时延 —— BGProcessingTask 何时被系统派发仍由系统决定，
`earliestBeginDate` 只是下界。

---

## 修订 1（2026-10-17）：删除全量重导入口，恢复改为定点修复

### 变更

- 删除 `HealthKitSync.sync(full:)` / `performSync(full:)`、`SyncAtomicUnit.nextStep(full:)`
  重载、`AppWebView` 的 `full` 字段、设置页的「重新导入全部」按钮，以及 `if full` 重置分支
  （它 `forgetState` 删整行 `sync_state` + 删老锚键 + 清预算档位）。
- 删除随之失去生产者的开关：`recordsForceRescan` / `forceHistory` / `routeForceRescan` /
  `RouteQueryPolicy.isForceManualRescan`。`HealthKitRecordCursor.needsHistoryRead()` 不再有
  `force` 参数 —— 重放只能由"上一轮被预算截断"触发。
- 删除 `SyncTaskStore.forgetState`（整行删除），新增两个**窄原语**：
  `clearWorkoutAnchor(scope:)`（只清锚，保留 `export_end`，写后读回）
  与 `clearRecordCursors(_:scope:)`（只删指定类型的键，其余逐字节保留，写后读回）。
- 新增显式 `HealthKitSync.repairSyncCursor()`：只清**解不开**的那一个游标；记录侧的游标包
  整体不可解码时清该行。它同时复位预算收敛档位（该函数原本只有"全量重导"一个调用点）。
- `loadCommittedState()` 读失败从"返回 nil（退化成没有水位 ⇒ 全历史）"改为抛
  `stateStoreUnreadable` 明确阻塞。只有"确实没有行"（首装 / 换 scope）才是合法的无水位状态。
- 旧服务端页面仍可能下发 `full: true`：桥接层**明确拒绝**并提示改用定点修复，不静默忽略。

### 为什么

"不做全量同步、不自动清空游标"如果只靠 UI 约定，就不是结构约束。`full` 分支是**唯一**
会把 `sync_state` 整行删掉的地方；留着它，任何一次误触或旧页面都会把全部增量游标清零。
删除之后，"清空已提交状态"在类型层面不可达（`forgetState` 不存在），恢复只有窄原语。

### 代价（已接受）

- 记录侧游标损坏时无法先 drain 旧锚点（本来就解不开），只能从 `nil` 重读该类型；
  重读期间发生的删除事件无法上报（无锚点查询看不到 `deletedObjects`）。这不是新增回归。
- 服务端的数据重建不再经过手机：改用服务器侧 CLI 导入（`npm run data:import`）。
- 预算收敛档位不再由普通同步复位，只由显式修复复位（否则一次历史超界会永久折半）。

### 判据

- `check-background-capabilities.py`：`if full` / `forgetState` 必须不存在；修复入口必须调用
  `clearWorkoutAnchor(` 与 `clearBudgetConvergence()`；老锚键只允许两处删除（提交 + 修复）。
- `check-healthkit-record-sync.py`：`recordsForceRescan` / `forceHistory` / `routeForceRescan`
  必须不存在；`needsHistoryRead` 不得含 `force` 或时间参数；损坏锚不得静默触发重放。
- `SyncStateCommitRegression`：`clearWorkoutAnchor` 保留 `export_end` 与任务行；
  `clearRecordCursors` 只删指定类型、其余保留。
- 突变：见 `check-background-mutations.py` 的 `[第三轮]` 三条。
