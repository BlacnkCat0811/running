# ADR-004：HealthKit 后台同步的四条不变式（封板记录）

- **状态**：已接受（Accepted）· **封板日期**：2026-09-23
- **范围**：`apps/ios/RAI/` 的 HealthKit 同步写入路径 + `packages/health-export-parser/` 的 GPX 配额
- **来源**：多智能体讨论 + 红队质询后的实施轮，报告见 `deliverables/RAI_HK_BACKGROUND_V21_INCR_2026-09-23.md`
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
写入路径是 `SyncTaskStore.commitSuccess`（`apps/ios/RAI/SyncTaskStore.swift:219-258`）：

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

- **回归**：`apps/ios/tests/SyncStateCommitRegression.swift`（53 条），包含
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

### ❌ 不要这样改

- 不要把顺序改成"提交 → 删产物"，除非**同时**引入一个真正的孤儿回收机制
  （扫描产物目录、按 `payloadHash` 反查是否还有任务行）。
- 不要把 `try?` 改成 `try`（会让一次删文件失败中断整个收尾流程，代价大于收益）；
  两个方向的取舍已经算清：**留文件可回收，丢状态不可回收。**

---

## 决策三：GPX 配额熔断必须落 `pending`，**绝不能落 `invalid`**

### 背景

服务端超配额时有三种可能的下游状态：`pending` / `imported` / `invalid`
（`workout_routes.file_status`）。配额分支在 `packages/health-export-parser/src/gpx-parser.ts:418-446`。

### 曾经的反转

初版方案用 **`invalid`** 表达"这份文件不合格"。**红队质询后推翻。**

### 决定

**配额超限落 `pending`**（`gpx-parser.ts:433`）；`invalid` 只保留给**真的坏了**的文件
（解析失败的 `invalid_xml` 路径，`:446`）。

### 理由（这是四条里后果最重的一条）

`markRouteStatus(id, "invalid")` 会：

1. `DELETE FROM route_points`；
2. 把 `point_count` 归零。

而重算管线（`recompute-pipeline.ts:751`）的汇总**只统计 `file_status = 'imported'`**。
⇒ 用 `invalid` 表达"超配额"，会让**该次跑步的轨迹与高程增益静默消失**，
用户看到的不是"同步失败"，而是 **"这次跑步没有轨迹"** —— 不可归因，看起来像数据本身缺失，
而且 `invalid` 意味着**永远不会再重试**。

`pending` 是诚实的表述：**"我们知道这个文件，但我们还没有导入它。"**
两个状态的下游成本相同，但只有 `pending` 保留了重试的可能。

### 可证伪性

- `packages/health-export-parser/test/gpx-quota.test.ts` 第 2 条断言：
  超点数的路线被拒 ⇒ 状态为 `pending` + 产生 issue，且**兄弟路线仍是 `imported`**
  （证明"拒绝一份"不会波及整批）；第 3 条断言超字节的路线**完全未被改动**。
- 代码注释逐字记录了这次反转的推理（`gpx-parser.ts:418-425`）。

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
   （`BackgroundSyncPolicy.swift:118-123`）。任务行的存在本身就说明"有一个批次还没走完"；
   想重新导出只有**一个合法入口**：用户显式点「重新导入全部」。
   这条不变式由 `BackgroundSyncPolicyRegression` 在**全参数组合**上钉死。
2. 内容层面另有一把**稳定的**摘要：`digestHealthKitExportContent`
   （`apps/api/src/import-sources.ts:238-283`，会剥掉 `<ExportDate>`），
   供"这份载荷是否就是产生当前主库的那一份"这类判断使用。

也就是说：**频控/防并发靠边界（规则 1），内容比较靠稳定摘要（规则 2），
`payloadHash` 只承担"这是哪一次导出"的短期身份。** 三者职责不同，不该合并。

### ❌ 不要这样改

- 不要把它改成"内容摘要"以求稳定 —— 那会让"两份来源、两个 job"的
  `BackgroundSyncPolicy.swift:120-123` 自述约束失效。
- 不要因为它"每次变"就认为幂等没生效：幂等的入口是
  `import_sources.idempotency_key = sha256(serverId\0athleteId\0datasetEpoch\0batchId)`，
  在同一次批次内是稳定的。

---

## 补充 A：GPX 三级配额的基准参数与"为什么不照抄规范"

规范给的三个数字是 **20 MB / 50,000 点 / 200,000 点**。本仓**三个都没照抄**，
固化为（`packages/health-export-parser/src/gpx-parser.ts:54,65,80`）：

| 层级 | 规范 | **本仓固化值** | 类别 |
| :--- | :--- | :--- | :--- |
| 单 GPX 文件 | 20 MB ⇒ 413 | **64 MiB** | 拒绝（413 语义） |
| 单 workout 轨迹 | 50,000 点 ⇒ 422 | **300,000 点** | 拒绝（落 `pending`） |
| 整批点数 | 200,000 点 ⇒ 422 | **20,000,000 点** | **只记 issue，从不拒绝** |

### 推导依据（每条都可核对）

1. **每点约 213 字节**：`HealthKitExport.swift:950-973` 的 `gpx(_ locations:)`
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

落点：`apps/ios/RAI/SyncTaskStore.swift:280-291`（`upsertState`）。

### 为什么这条必须单独记一笔

1. **失败形态是"数据悄悄变成别的东西"**，编译器、类型检查、普通的单元测试都看不见；
   唯一能抓住它的是**同事务内的回读断言**（决策一）。
2. 这也反过来说明**决策一不是装饰**：它是这个 bug 的唯一探测器。
3. `save(_:scope:)` 原本就是这个正确形状；这条记录是为了防止后来者"顺手重排一行"。

### ❌ 不要这样改

- 不要把 `bind_blob` 的返回值丢掉（`sqlite3_bind_*` 会失败，尤其是 `SQLITE_TOOBIG`）。
- 不要为了"少一层闭包"把绑定挪到外面。

---

## 这些不变式由什么守住（三层，缺一不可）

| 层 | 载体 | 挡的是 |
| :--- | :--- | :--- |
| **结构门禁** | `apps/ios/tests/check-background-capabilities.py`（191 checks / 0 failed） | "改错了照样编译通过"的形状问题：调用顺序、比较值、判据载体是否还在 |
| **可跑回归** | `SyncStateCommitRegression.swift`（53 条）、`BackgroundSyncPolicyRegression`、`gpx-quota.test.ts`（4 条） | **语义**：锚点改名挡不住的那些（例如 `mayCommit` 被改成恒真） |
| **突变验证** | `apps/ios/tests/check-background-mutations.py`（62 条） | 上面两层的**断言有效性**本身：跑绿只说明"没红"，不说明"改坏了会红" |

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
