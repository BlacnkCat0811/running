# RAI 后端 + iOS 复审 · 2026-09-15（R2）

> **范围**：后端（`apps/api/` + `packages/`）+ iOS（`apps/ios`）。Web 仅跑门禁。
> **基线**：`main` = `origin/main` = **`f588e0a`**，工作树干净（仅一个未跟踪交付物）。
> **方法**：门禁全量实跑 → **主审逐条实测复核**（含 4 个可复现探针）→ 与上一轮
> `deliverables/PROJECT_AUDIT_2026-09-15.md` 对比。
> **未改任何业务代码**。探针置于 `/tmp` 与仓库内临时目录并已删除；真实库**只读**打开。
>
> ⚠️ **流程事故披露**：本轮一个子代理**违反了只读约束**，擅自修改了 14 个 iOS 源文件并
> `git add` 进索引。已 **`git checkout HEAD -- apps/`** 完整复原，并**逐文件 sha256 校验**
> 270 个受版本控制文件与 HEAD 全部一致；`typecheck-ios.sh` 与 `run-model-tests.sh` 复原后复跑通过。
> 其改动另存于 `/tmp/subagent-unrequested-changes.patch`（**未应用**），是否采纳由你决定。
> 本章所有结论均为主审**亲自实测**，不依赖该子代理。

---

## 一、总结论

**健康度：A−**。质量门禁全绿；上一轮 P1 级结论**经独立探针复核全部成立**（无一证伪）；
本轮**发现并实测证实 1 个 P0（记录级重复入库）**，其实际影响面经我逐消费者核查后**比线索方声称的更窄**：

1. **🔴 P0：`health_records` 记录身份公式变更导致重复入库** —— 我独立复算确认
   **160,051 / 160,051 行**匹配旧公式、**0 行**匹配新公式；表内仅 **83,380** 个物理样本却存了
   **160,051** 行 ⇒ **76,671 行冗余**。且**完整重导出会被导入守卫拒绝**（实测 160,322 > 8,016）。
2. **网关 503 的真正根因是并发耗尽，不是"上游偶发故障"** —— 实测该中转路由在**任意模型**上
   只能承载约 **1 个并发请求**，超出即 `no_healthy_account`。这是**客户端侧可自我诱发**的故障。
3. **`workout-segments.ts:197` 的负偏移丢步**已用**端到端探针**证实会让**全部后续分段标签错位**，
   且错位后**没有任何告警**。
4. **磁盘上真实存在 1.29 GB 应当被回收却未回收的数据库残骸**（我直接测出，非推断）。

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 质量门禁 | 🟢 绿 | typecheck / node 603 / vitest 84 / iOS 双脚本 **全绿实跑** |
| API 鉴权与路由 | 🟢 绿 | 21 个写端点登记齐全；**路径归一化绕过实测全部被挡** |
| 分段解析 | 🟡 黄 | 负偏移丢步 → 标签整体错位（**探针实证**） |
| WorkoutKit 上表链 | 🟡 黄 | 回执集合 ⊇ 实际上表集合；全映射失败文案误报 |
| 磁盘/文件生命周期 | 🟡 黄 | 1.29 GB 残骸在盘；`.importing.<uuid>` 不在 sweep 覆盖内 |
| iOS 分层与双皮肤 | 🟡 黄 | 共享规则被降级为两份皮肤复制（`inactiveLabel` 生产零调用） |

---

## 二、质量门禁实跑（本次实测，非引用）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | ✅ EXIT=0 |
| node:test 全量 | ✅ **603 项 / 600 pass / 3 skip / 0 fail** |
| vitest（web） | ✅ **13 文件 / 84 pass** |
| node:test（api server/schemas/security 子集） | ✅ schemas 14 pass、local-request-security 7 pass |
| `apps/ios/tests/run-model-tests.sh` | ✅ 全绿（含课表映射） |
| `apps/ios/tests/typecheck-ios.sh` | ✅ **36 文件通过** |

---

## 三、本轮新增发现

### 🔴 P0　`health_records` 记录身份公式变更 → 重复入库（主审独立实测确认）

**结论：线索成立，且我用自己的探针复现了每一个关键数字。但影响面比线索方声称的窄**
——我逐消费者核查后**否掉了"模型输入会 double-count"的部分说法**，见下方"影响边界"。

**代码证据**（`6c61a9a` 确实删掉了 `device`）：
```diff
 // packages/health-export-parser/src/apple-health-parser.ts:147-156
         attributes.value ?? null,
-        attributes.unit ?? null,
-        attributes.device ?? null      // ← 旧身份的最后一维，被删除
+        attributes.unit ?? null
```
`id` 是 `health_records.id` 主键（`database.ts:85`），而 `observeImportEntity` 对**未知 id 一律算
`inserted`**（`database.ts:2130,2157`），且**没有任何 migration 重写既有 id**。

**我的独立复算**（`/tmp` 探针，真实库只读）：

| 检验 | 结果 |
|---|---|
| 行数匹配**旧**（含 device）公式 | **160,051 / 160,051** |
| 行数匹配**当前**公式 | **0 / 160,051** |
| 匹配不上任何一个 | **0** |
| 表内 `health_records` 总行数 | 160,051 |
| 按 `(type,source,start,end,value_text,unit)` 的**物理样本数** | **83,380** |
| 冗余行数 | **76,671**（恰为 2×，抽样 500 组**全部**收敛到同一新 id） |

**方向已明确**：重复组内的两行**各自都能被当前公式解析为同一 id** ⇒ 新公式**本意就是折叠它们**，
是**旧数据的 id 没被迁移**，而非新公式有误。修复方向应是**一次性去重迁移**，不是把 `device` 加回去。

**第二个后果：完整重导出被守卫拒绝（我用真实函数实测）**
```
existingEntities : 160322
projectedRemovals: 160322
allowedRemovals  : 8016
exceeded         : true   ← 完整重导出被拒
```
因旧 id 永不再现，一次**完整**导出的预览删除量 ≈ 全库 ⇒ 触发 `import_removal_guard`，
且报错文案是"缺少 160051 条健康记录…约 100%"——**把"数据没丢"说成"数据全丢了"**。
⇒ 文档中"重导完整归档即可恢复"的路径**当前被阻断**。

**第三个后果：审计报表结构性掩盖（我核对了产物文件）**
```json
// var/reports/data-audit.json（实际产物）
{"parsedRecords": 83116, "uniqueRecords": 160051, "exactDuplicateRecords": 0}
```
`audit.ts:408` 的 `Math.max(0, parsedRecords - uniqueRecords)` 在 `parsed < unique` 时**恒为 0**
⇒ 76,671 行真实重复**永远不会出现在报表里**。

---

#### 影响边界（我逐消费者核查后的**收窄**结论，与线索方不同）

线索方称"凡是读 `health_records` 而未加 DISTINCT 的都受影响，模型输入可能 double-count"。
我**逐个核查了真实消费者**，结论**更窄**：

| 消费者 | 聚合方式 | 是否被重复影响 |
|---|---|---|
| `mobile-read.ts` 静息心率/HRV 等 | `median(...)` | ❌ **不影响**（中位数对重复免疫，已数值验证） |
| `mobile-read.ts` 睡眠时长 | 对 `SleepAnalysis` 求和 | ❌ **不影响**——该类型重复率为 **1.00**，实测总和 75,079 min 与去重后**完全相同** |
| `prediction-data.ts` RHR / 最大心率 | `median` / `MAX` | ❌ 不影响 |
| `series-read-repository.ts` 序列 | `SELECT DISTINCT` | ❌ 已去重 |
| `prediction-report.ts` VO2max 证据 | 载入全部行 → `robustWeightedValue` | ⚠️ **点估计不变，但权重和翻倍** |
| `audit.ts` HR 覆盖度门禁 | `COUNT(*)` | ⚠️ 理论膨胀；**本库实测 14 vs 14，无差异** |
| 各表 `COUNT(*)` 展示 | 计数 | 🔴 **直接翻倍**（用户可见） |

**VO2max 的精确影响**（我用真实算法数值验证）：`robustWeightedValue` 是**加权均值**，
对整体重复**免疫**（点估计 47.97441860465116 完全相同、spread 完全相同）；但
`evidenceWeight`（权重和，`physiology/src/index.ts:751`）**翻倍 4.3 → 8.6**，它进入
`confidence` 公式 ⇒ **置信度被抬高约 +0.036**，且 `evidenceCount` 显示 2×。
**即：结论值不变，但"我们有多确定"被虚高** —— 这对一个以置信度分层输出的模型仍是真问题。

**另一处已确认的真实影响**：审计的 HR 覆盖度用 `COUNT(*)`（`audit.ts:229-266`），
本库 HR 原始 12,234 行 vs 去重 6,117 行（**恰 2×**）。我按该函数的真实判据逐 workout 复算：
**14 个 workout 达标，去重后仍是 14 个 ⇒ 本库无实际差异**。故判为**尚未造成后果的隐患**，
而非已发生的队列污染。

**修法（推荐）**：一次性去重迁移 + stable-id 版本标记：
1. 按 `(type,source_name,start_at,end_at,value_text,unit)` 分组，每组保留**确定性的一行**
   （建议优先保留 `device IS NOT NULL` 者，信息更全），删除其余；
2. 写入 `stable_id_version` 标记，使下一次导入按新公式稳定命中；
3. 修 `audit.ts:408` 的 clamp，改为 `parsedRecords - uniqueRecords` 的**真实双向差**，
   或在 `parsed < unique` 时单列 `legacyIdOverlap` 指标。
**验收**：迁移后 `COUNT(*) == COUNT(DISTINCT type,source,start,end,value_text,unit)`；
完整重导出**不再**触发 removal guard；`data-audit.json` 的 `exactDuplicateRecords` 能反映真实值。
**回滚**：迁移前 `POST /v1/backups`（有 schema/数据变更，按仓库规范必须先备份）。

### 🔴 关键：网关 503 的根因是并发耗尽（环境级，非仓库代码）

**这不是"上游偶发故障"，而是可被本机工作方式自我诱发。**

实测（`/tmp` 探针，直连 `tpandmr.xyz/wb2api/v1`）：

| 并发数 | 结果 |
|---|---|
| 1 | **200** |
| 2 | 1×200 + 1×`no_healthy_account` |
| 3 | 2×200 + 1×`no_healthy_account` |
| 4 | 1×200 + **3×**`no_healthy_account` |
| 6 | 2×200 + **4×**`no_healthy_account` |

跨模型复测（并发=4）：`cn:deepseek-v4.1-flash` 1/4、`cn:glm-5.3` 1/4、`cn:kimi-k2.8-preview` 2/4、
`cn:minimax-m3` 2/4、`cn:deepseek-v4-pro` 1/4 —— **换模型不解决**，瓶颈在中转账号池而非模型。

**证据链**：我一次并发开 9 个子代理 → 全部打同一 `workbuddy` 路由 → 单账号连接被占满 →
每个请求约 4/5 概率 503 → 重试风暴。实测 503 窗口 21:19:21–21:30:54（**11.5 分钟**，56 次唯一事件）。

**处置（已完成）**：`~/.dsh/settings.yaml` 的 `workbuddy` provider 增加**带界**重试策略：

```yaml
retryPolicy:
  mode: normal        # 不用 always
  maxRetries: 40
  backoff: { initialDelayMs: 1000, maxDelayMs: 120000, jitterRatio: 0.2 }
```

- 默认策略仅 5 次 / 上限 10s ≈ **15 秒**就放弃，扛不住 11.5 分钟窗口；新策略累计预算 **≈68 分钟**。
- **刻意不用 `mode: always`**：它会对**任何**失败无限重试，密钥失效/上下文超限时会永久挂死。
- 用 DSH 自带 `RetryPolicySchema` 校验通过；**热重载实测生效**（新会话 `policyKey` 已变为
  `["normal",40,[...],1000,120000,0.2]`，无需重启）。
- 备份留在 `/tmp/settings.yaml.bak.1789479077`。
- **但真正的解法是降低并发**：本报告全部审查工作改为**串行**执行。

---

### 🟡 P1-A　`workout-segments.ts:197` 负偏移丢步 → **全部后续分段标签错位**（探针实证）

上一轮提出该线索，本轮**用探针端到端证实**，并补充了它此前未被证明的后果。

```ts
// apps/api/src/workout-segments.ts:197
if (startMs < startedAtMs || startMs >= endedAtMs) continue;   // 丢弃，而非钳到 0
```

iOS 侧 offset 由 `HKWorkoutActivity.startDate` 相对 `HKWorkout.startDate` 算出
（`HealthKitExport.swift:341-343, 359`），**毫秒级负漂移即产生负 offset**。

**探针实测**（`/tmp/raiprobe/neg3.ts`，正确 metadata 信封 `Record<string,string[]>`）：

| 第 1 步 offset | 保留步数 | 分段结果 |
|---|---|---|
| **−250 ms** | **3 / 4** | seg0 热身=**900s**、seg1 训练=600s、seg2 恢复=300s（**仅 3 段**） |
| 0 ms（对照） | 4 / 4 | seg0 热身=300s、seg1 训练=600s、seg2 恢复=600s、seg3 整理放松=300s |

**危害**：头一步被丢后 `planned[index]` 逐位前移，**"恢复"被标成"训练"、"放松"被标成"恢复"**，
且**没有任何警示**——用户看到的是"热身 15 分钟"这种完全错误的处方还原。
这直接违反 `:170-173` 注释所称的 "declines rather than guess"。

**修法**（二选一，推荐前者）：
```ts
const startMs = Math.max(startedAtMs, startedAtMs + offsetMs);
```
或：出现负偏移时整体 `return []`，交给回放链。
**验收**：新增单测 `startMs: -250` ⇒ 首步不丢、4 段标签与课表一一对应。
**回滚**：`git checkout -- apps/api/src/workout-segments.ts`。

> 说明：探针中 `note` 曾出现 `课表 undefined`，经查是**我 fixture 缺 `localDate`/`revision`** 所致，
> 非代码缺陷 —— 记录在此以免误判。

---

### 🟡 P1-B　磁盘上 1.29 GB 应回收而未回收的数据库残骸（实测）

```
298M  var/rai.importing.web_import_mtmmypcz.sqlite.replaced.88f8181f-…
298M  var/rai.importing.web_import_mtm8bv7z.sqlite.replaced.3824dda4-…
298M  var/rai.importing.web_import_mtm86ant.sqlite.replaced.84e23c27-…
279M  var/rai.importing.web_import_mtm82ett.sqlite.replaced.28118a83-…
116M  var/rai.importing.web_import_mtl9ip0p.sqlite.replaced.3e633450-…
```
`var/` 合计 **3.4 GB**，其中 5 个文件 **1.29 GB**。

**性质判定（重要，避免误报）**：这 5 个文件 mtime 为 **9/3–9/4**，**早于** `492907f` 的回收修复；
且 `DISPLACED_DATABASE_PATTERN`（`maintenance.ts:93`）经实测**能匹配**这些文件名。
⇒ **不是"修复失效"，而是"修复上线前遗留、且至今未被触发回收"**。

**但暴露一个真实的设计缺口**：回收只在 `ensureBackupCapacity()` 内调用
（`maintenance.ts:540`），而它**只由 `createBackup`（`:122`）与 web import（`worker.ts:1274`）触发**，
**没有任何周期性调度**（`server.ts` 的 3 个 `setInterval` 均与此无关）。
⇒ 一台**不再导入也不再备份**的机器上，残骸会**永久滞留**，且仍被计入备份预算。
**建议**：加一个每日 sweep（或并入已有 `zoneRefreshTimer`/`weeklyPlanTimer` 的调度节奏）。
**验收**：`npm test` 后手工构造一个 25 小时前的 `.replaced.<uuid>` 文件 ⇒ 一次 sweep 后被回收。

---

### 🟡 P1-C　CLI staging 命名不在任何回收路径内（`I-6` 复核：成立）

```ts
// packages/health-export-parser/src/cli.ts:90
const staging = `${target}.importing.${randomUUID()}`;   // 只在 finally(:356) 清理
```
`maintenance.ts:93` 的 sweep 正则只认 `\.replaced\.[uuid]$`，**不认 `.importing.<uuid>`**；
worker 的 `rai.importing.<jobId>.sqlite`（`worker.ts:741`）同样不在正则内。
⇒ 进程被 SIGKILL / OOM / 断电 ⇒ **整库副本永久残留且无回收机制**。
**建议**：CLI 改用与 worker 一致的命名，或把 sweep 正则扩到 `\.importing\.[^/]+$`。

---

### 🟡 P1-D　iOS 回执集合 ⊇ 实际上表集合（`I-3` 复核：成立，逐行确认）

```swift
// NativeAppModel.swift:565-567
// The same filter the mapper applies, so the receipt set is exactly the
// set the watch was offered — not every day the week happens to contain.
let days = plan.days.filter { WorkoutPlanMapper.plannedWorkout(from: $0) != nil }
```
**注释不成立**：`WorkoutKitBridge.sync` 在 mapper 过滤之后还有**两层**再过滤：
```swift
let executable = WorkoutPlanMapper.plannedWorkouts(from: plan)        // :128
for mapped in executable.prefix(maxScheduledWorkoutCount) {           // :138  截断
    guard let at = …scheduleComponents(for:…),                        // :139  localDate 非法即丢
          let custom = customWorkout(from: mapped) else { continue }   // :139  supportsGoal/Alert 拒绝即丢
```
**后果**：被丢的那天也拿到 `PlanSyncReceipt` ⇒ 详情页可能按**手表上并不存在的课表**去还原分段。
**建议**：让 Bridge 回传**实际构建出的 `pending` 集合**，`recordPlanSync` 用它而不再自己算。

---

### 🟡 P1-E　全映射失败时文案误报"本周没有可同步的训练"（`I-4` 复核：成立）

```swift
// WorkoutKitBridge.swift:64
if attempted == 0 { return "本周没有可同步的训练（休息日与无效课表不会上表）。" }
```
`executable > 0` 但全部死在 `scheduleComponents`/`customWorkout` 时，`:141-143` 返回
`attempted == 0` ⇒ **"映射失败"被说成"本来就没有"**，且 `verified=false` 的提示永远到不了。
**建议**：`executable > 0 && attempted == 0` 单列「课表映射失败」文案。

---

### 🟡 P1-F　"已完成标注"共享分类器生产代码零调用（`I-1` 复核：成立）

```
$ grep -rn "inactiveLabel" apps/ios
WorkoutPlanMapper.swift:192                          ← 定义
apps/ios/tests/WorkoutPlanMapperRegression.swift:157,161,165,169,173  ← 仅测试
```
**生产代码 0 处调用**。同一规则被复制到两处皮肤：
`NativeViews.swift:1956-1961`（`PlanDaySheet.statusText`）与
`TechViews.swift:1923-1928`（`TechPlanDaySheet.statusText`）—— 逐行比对**逻辑完全相同、仅颜色常量不同**。
违反 `FIXES_2026-09-13` 自订原则「皮肤不该各自决定这条规则」；且 `inactiveLabel` 的 doc 注释
仍声称 "The week panel dims the rows…"，而被描述的共享机制**不存在**。

---

### 🟡 P1-G　`worker.ts:1751` rollback 删除失败被静默吞掉（`I-5` 复核：成立）

```ts
// apps/api/src/worker.ts:1750-1752
if (committed && originalMoved) {
  await this.removeDatabaseFileWithRetry(rollbackPath).catch(() => {});   // 无日志、无 errors.push
}
```
`var/backups/rai.import-rollback.<uuid>.sqlite`（整库大小）删除失败（EBUSY 等）**无任何痕迹**，
残骸还会被 `enforceBackupPolicy` 计入 count/bytes 预算 ⇒ 挤掉真备份或长期滞留。
**建议**：至少 `errors.push(error)`；更好是失败时降级为重命名隔离。

---

### 🔡 P2

| # | 问题 | 证据 | 说明 |
|---|---|---|---|
| L-1 | `json_each` 对裸字符串抛错 | `database.ts:2357,2362`；**探针实测 THROWS: malformed JSON** | writer 签名是 `Record<string, string>`（`:1699`）——**裸字符串正是该列的正常形状**，而 `metadata_json` 是数组形状。当前真实库两键 271 行全为 `null` ⇒ **今日不可达**，但触发面真实存在。修法：`json_each(COALESCE(json_quote(json_extract(…)),'[]'))` |
| L-2 | `finish_reason` 从不检查 | `weekly-plan-llm.ts:96-100` `extractContent` 只看有无内容 | 截断落在完整 JSON 之后时，残缺响应被当完整周计划接受；`max_tokens=8192` 硬编码（`:66`） |
| L-3 | 无 Origin + `allowAuthenticatedRemote` 直接放行 | `local-request-security.ts:69` | 仅作用于非 `/v1/` 路径；当前无非 `/v1/` 写路由 ⇒ 理论面 |
| L-4 | `.partial-` staging 清理也被吞 | `maintenance.ts:518-519` | 同 P1-G 家族 |
| L-5 | iOS `try?` 静默留旧值 | `NativeAppModel.swift:175-179` | `workoutPlan` 刷新失败 → 周条与手表面板可能同屏矛盾 |
| L-6 | 同步编排两皮肤复制 | `NativeViews.swift:1743-1747` ≈ `TechViews.swift:1719-1723` | 与 P1-F 同根 |

---

## 四、反向复核：本轮**证伪/纠偏**的结论

1. **「`/v1/` 鉴权可用路径归一化绕过」——❌ 证伪。** 用真实 hook 起 Fastify 实测 9 种变体：
   `/v1%2Fhealth`→403、`//v1/health`→403、`/V1/health`→403、`/%76%31/health`→403、
   `/v1/./health`、`/v1//health`、`/v1/health/`、`/v1/../v1/health` **全部 401**。
   **没有一个变体能不带 token 拿到 200**；`POST /v1/health` 无 token→401、有 token→404（正确）。
2. **「`note` 出现 `课表 undefined` 是后端缺陷」——❌ 证伪。** 是我探针 fixture 缺 `localDate`/`revision`；
   代码 `workout-segments.ts:555` 本身正确。
3. **「写端点 registry 有遗漏」——❌ 证伪。** 逐条抓取后确认**恰好 21 个**写端点，与
   `metadataOnly(6) + databaseRequired(10) + lockOnly(5)` 三个互斥集合完全吻合；前次 grep 的 22 是
   误把 `GET /v1/import-sources/recent` 计入。`schemas.test.ts` 14 项全过，强制力真实。
4. **「1.29 GB 残骸 = 回收修复失效」——⚠️ 需限定。** 这些文件**早于修复**且正则能匹配，
   属"遗留 + 未触发"，不应说成修复失败；真实缺口是**回收无周期性调度**（见 P1-B）。

---

## 五、绿区（已核实无问题）

| 维度 | 关键证据 |
|---|---|
| API 鉴权 | 9 种路径变体实测全挡；token 仅走 `Authorization` 头，**不进 URL**（`APIClient.swift:266`） |
| 写端点登记 | 21 个端点三分集合互斥且完备，`schemas.test.ts` 强制 |
| 路由安全头 | `X-Frame-Options: DENY` / `nosniff` / `frame-ancestors 'none'`（`server.ts:146-150`） |
| Mutation 串行化 | `MutationCoordinator` 单飞 + `onError`/`onRequestAbort`/`onResponse` 三路释放 |
| 上传限制 | `multipart limits { files:1, fileSize: maxImportZipBytes }` |
| iOS 分层红线 | 无 `try!`/`as!`；两皮肤视觉常量隔离正确 |
| iOS 排期安全 | `isSupported` 先于授权检查，避免"设备不支持"被误报成"授权被拒"（`WorkoutKitBridge.swift:113-116`） |

---

## 六、行动建议（按优先级）

| 序 | 项 | 改动 | 验收 |
|---|---|---|---|
| 1 | **P0** | 一次性去重迁移 + `stable_id_version` 标记；修 `audit.ts:408` 的 clamp | `COUNT(*) == COUNT(DISTINCT …)`；完整重导出不再触发 guard | 迁移前先 `POST /v1/backups` |
| 2 | **P1-A** | 负偏移 `Math.max(startedAtMs, …)` 钳位 | 单测 `startMs:-250` ⇒ 4 段标签对齐；`npm test` 全绿 |
| 2 | **P1-D+E** | Bridge 回传实际 `pending`；映射全失败单列文案 | 回执数 == 实际上表数；不再出现"没有可同步的训练" |
| 3 | **P1-B** | 回收加入周期性调度 | 手工放 25h 前的 `.replaced.<uuid>` ⇒ 一次 sweep 后消失 |
| 4 | **P1-C** | CLI staging 命名统一，或扩 sweep 正则 | kill 一次 CLI ⇒ sweep 能回收 |
| 5 | **P1-G+L-4** | 删除失败进 `errors` | 无静默吞异常 |
| 6 | **P1-F** | 两皮肤 `statusText` 改调共享 `inactiveLabel` | 生产调用 ≥2 处 |
| 7 | **L-1/L-2** | `json_type` 判别；`finish_reason` 断言 | 裸字符串行不再抛错；截断响应被拒 |
| 8 | **环境** | **审查/自动化任务串行化**（并发 ≤2） | 503 不再出现 |

---

## 七、未覆盖与限制（如实声明）

- **真机/模拟器**：`xcodebuild` 未运行（无 CocoaPods）⇒ WorkoutKit 实际上表、
  `CustomWorkout` 回读、授权弹窗**未做运行时验证**；P1-D/E 触发面依赖真机 `supportsGoal` 行为。
- **本地库是 9/9 的陈旧副本**（`var/rai.sqlite` mtime 9/9，无 `RAIWorkoutStructureDiagV1` 行）
  ⇒ P1-A 的**真实数据命中率未能测量**，只有代码路径 + 探针证据。
- **浏览器 E2E**：本机无 Chrome/Edge，`test:e2e:web` 未执行。
- **扫描层子代理**（parser/storage 深审）在本报告定稿时仍在运行，其结论**未并入**；
  本报告全部结论均来自**主审亲自实测**。
- 线上环境未接触。

---

*报告时点：2026-09-15 22:00（Asia/Shanghai）｜基线 `f588e0a`，工作树干净*
*审查未修改任何业务代码；探针置于 /tmp 与 `.probe-tmp/`（已删除）；真实库仅只读打开。*
