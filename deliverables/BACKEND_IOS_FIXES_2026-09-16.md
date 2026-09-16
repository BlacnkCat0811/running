# RAI 后端 + iOS 修复报告 · 2026-09-16

> **来源**：`deliverables/BACKEND_IOS_AUDIT_2026-09-16.md`（基线 `b4cb6d9`）的分级问题清单，以及 2026-09-16 对未提交改动的独立审查。
> **范围**：后端（`apps/api/`、`packages/`）+ iOS（`apps/ios/`）。
> **门禁**：五条全量实跑，全部通过（见 §一）。
> **数据操作**：**未执行任何破坏性操作**。P0 迁移只写了代码，并在**真实库的副本**上验证；本地库与线上库都没有被迁移（见 §五）。
> **新增/修改**：**18 个已跟踪文件改动 + 2 个新代码文件**（§六）；另有 6 份 deliverables 文档。其中 P1-h 与 §四·N-1/N-2/N-3 来自本轮独立审查。

---

## 一、门禁（修复后实跑）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | ✅ **EXIT=0** |
| `node --import tsx --test packages/*/test/*.test.ts apps/api/test/*.test.ts` | ✅ **610 项 / 607 pass / 3 skip / 0 fail**（修复前 603 项） |
| `npx vitest run --root apps/web` | ✅ **13 文件 / 84 pass** |
| `bash apps/ios/tests/run-model-tests.sh` | ✅ 全绿，**122 条断言**（含新增 6 条收据归属 + 10 条 `WeekOffer`/文案） |
| `bash apps/ios/tests/typecheck-ios.sh` | ✅ **37 文件 / 0 error**（修复前 36，新增匹配器） |

新增的 6 条测试：4 条周计划 LLM（截断/正常/预算可配）+ 2 条迁移（收敛与拒绝未知形状）。

---

## 二、修复清单

### 🔴 P0　`health_records` 记录级重复：迁移 v22（**代码就绪，待执行**）

**修复前我对根因的判断不够**：上一轮说"删掉重复行即可"，实测后发现**删重复不够**。

我在真实库副本上重新复算了 id 归属（`/tmp/raiprobe26/idprobe2.mjs`，从 `raw_attributes_json` 还原 `attributes.value`）：

| 检验 | 实测 |
|---|---|
| 总行数 | 160,051 |
| 命中**旧**公式（含 `device`） | **160,051（100.00%）** |
| 命中**当前**公式（无 `device`） | **0（0.00%）** |
| 含 `HKMetadataKeySyncIdentifier` 的 record | **0** |

⇒ 库里每一行的 id 都是**旧公式**算的。所以：

1. 只删重复 → 剩 83,380 行仍带旧 id；
2. 完整重导出会算出 83,380 个**新** id，与现存 id **零交集** ⇒ 删除预览 = **83,380**；
3. `allowedRemovals = max(50, floor(83,380 × 5%)) = 4,169` ⇒ **仍然被 `import_removal_guard` 拒绝**。

**所以迁移必须同时做两件事**：删除重复行 + 把存活行的 id 重写成当前公式。

**为什么能精确重建**：`raw_attributes_json` 逐字保存了 XML 原始属性（`apple-health-parser.ts:384` 传 `currentRecord.attributes`），而"旧公式复现 100%"本身就是"这些输入完好"的证明。

**迁移 v22 的行为**（`packages/storage-sqlite/src/database.ts`）：

| 步骤 | 内容 |
|---|---|
| 1 | 逐行按**当前**公式重算 id |
| 2 | **守卫**：某行既不匹配当前、也不匹配旧公式 ⇒ **抛错并整体回滚**（不许猜健康数据） |
| 3 | 按重算后的 id 分组，每组保留一行：`device` 非空优先 → `created_at` 较新 → id 字典序（确定性） |
| 4 | 删除其余行，并删掉它们的 `import_entity_generations` / `import_entity_tombstones` |
| 5 | 全表移到 `__realign__` 前缀（`record_<hex>` 不可能以此开头）→ 用临时映射表一次性还原记录与两张依赖表 |

**在真实库副本上的实测结果**（`/tmp/raimigrate-check.mts`，只动副本）：

```
迁移前   行数=160051  唯一自然键=83380  冗余=76671  generations(record)=160051  schema_v=18
迁移耗时 44.3s
迁移后   行数=83380   唯一自然键=83380  冗余=0      generations(record)=83380   schema_v=22

COUNT(*) == 唯一自然键        PASS
行数 = 迁移前唯一自然键        PASS
每行 id 命中当前公式          PASS
无残留前缀 id                 PASS
generations 无悬空 record 引用 PASS
冗余行归零                    PASS
幂等（再次打开无变化）         PASS
```

**审计报表同步修好**（`packages/health-export-parser/src/audit.ts`）：

- `exactDuplicateRecords` 原先写 `Math.max(0, parsedRecords - uniqueRecords)`；`parsed` 是"上次导入解析量"、`unique` 是"表内存量"，两者相减在增量导入下**恒为 0** ⇒ 76,671 行真实重复**永远不会出现在报表里**。现改为**表内自然键的真实冗余行数**。
- 报表三行标签一并改准（"上次导入解析到" / "表内行数" / "其中冗余行"）。

**未采用的方案**：上一轮建议"写入 `stable_id_version` 标记"。实测表明不需要——id 重写后命中率就是 100%，再加一个标记只是多一个可能失去同步的状态位。

**验收**（迁移执行后应满足）：`COUNT(*) == COUNT(DISTINCT 自然键)`；`DataAuditPage` / `SettingsPage` 显示 83,380；完整重导出不再触发 removal guard。
**回滚**：迁移前 `POST /v1/backups`（`createMigrationBackup` 默认开启，会先自动建一份）；库文件级回滚。

---

### 🟡 P1-a　iOS 排期回读：改为**按日期**匹配（`b4cb6d9` 的假前提已消除）

`WorkoutKitBridge.swift` 的注释称 "`scheduledWorkouts` carries no date" —— SDK 里 `ScheduledWorkoutPlan.date` 明确存在。按内容匹配会让**同处方的另一天**替它背书。

**改法**：把匹配规则抽成不依赖 SDK 的纯函数 `apps/ios/RAI/PlanReceiptMatcher.swift`，按 `date` 消费式匹配；`WorkoutKitBridge` 只负责取数并调用它。

- 保留原 `verify` 语义：**一条 listed 只确认一条 pending**；
- 日期比较：先按 `DateComponents` **自带时区**求时刻，再在**课表时区**取 `year/month/day`。这样无论系统原样回读还是归一化成 UTC，都落到正确的那一天；
- 若**没有任何** listed 条目带可读日期 ⇒ 返回 `nil`，调用方回退到旧的内容匹配（今天不可达，但比"给出无依据的收据"更保守）。

**测试覆盖从 0 变 6**：`PlanReceiptMatcher.swift` 已加入 `run-model-tests.sh` 的编译列表。关键断言：

```
ok  a receipt names the day that reached the watch, not its identical twin   ← 正是原缺陷
ok  both days are confirmed when both reached the watch
ok  one listed day confirms exactly one planned day
ok  a listed instant is read as the day it falls on in the plan's timezone
ok  a listed instant in the plan's own zone keeps its day
ok  an empty read-back is not attributed
ok  a listed entry with no date cannot confirm anything
ok  a planned day with no date is never confirmed
```

> 实测踩到一个坑并已修：`Calendar.date(from: DateComponents())` **不返回 nil**，而是返回**参照日期**（2001-01-01）。若不显式检查 `year/month/day` 是否存在，"空日期"会被当成 2001-01-01 从而被视作**可读**，静默关掉回退路径。断言已钉住这一点。

---

### 🟡 P1-b　iOS 读授权：把"查询失败"从"放行"里拆出来

`HealthKitReadAuthorization` 新增 **`.unknown`**；`HealthKitExport.readAuthorizationState` 改为显式 `switch`：

- `statusForAuthorizationRequest` **抛错** → `.unknown`；
- 返回 `HKAuthorizationRequestStatusUnknown`（"因错误无法确定"）→ `.unknown`；
- `@unknown default` → `.unknown`（未来新增状态缺省**失败关闭**）。

`HealthKitSync` 增加 `.unknown` 分支，配新文案 `HealthKitExportError.authorizationCheckFailed`，**不再继续导出**。

---

### 🟡 P1-c　iOS 导出为空时给可行动提示

`HealthKitSync.exportMessage(base:exported:)`：当 `workoutCount == 0 && recordCount == 0 && routeCount == 0` 时，在消息后附上

> 未读到任何健康数据：若你曾在权限弹窗点过「不允许」，请在 iPhone 设置 → 健康 → 数据访问与设备 中打开 RAI 的读取权限。

覆盖"已是最新"与"已导入"两条终态路径。这是**读权限被拒**时唯一能给出的兜底（HealthKit 对已拒绝也返回 `.unnecessary`）。

---

### 🟡 P1-d　分段负偏移：钳位而非丢步

`apps/api/src/workout-segments.ts:197`：首步偏移为负时原先直接 `continue`，导致 `planned[index]` **逐位前移**、把「恢复」标成「训练」。

改为 `startMs = Math.max(startedAtMs, rawStartMs)`（`endMs` 仍按原始 `rawStartMs + durationMs`，后续步界不受影响）。

新增端到端断言 `a first step timed slightly before the workout start is clamped, not dropped`（`startMs: -250` ⇒ 四段标签保持 `热身/训练/整理放松/自由训练`），并跑过**突变载荷**验证：把 `.ts` 临时改回旧行为 ⇒ `not ok 8`，恢复后 `pass 15`。

---

### 🟡 P1-e / P1-f　磁盘残骸：加周期调度 + 扩回收模式

- **P1-e**：`server.ts` 新增每日 `sweepAbandonedDatabases()`（24h 间隔 + 启动后 60s 一次），并在 `onClose` 清理定时器。原先只有 `ensureBackupCapacity`（备份/网页导入时）会触发，**不再导入也不再备份的机器上残骸永久滞留**。
- **P1-f**：回收正则由 `\.replaced\.<uuid>$` 扩为 `\.(?:replaced\.[0-9a-fA-F-]{36}|importing\.[^/\\]+)$`，把 CLI 的 `<target>.importing.<uuid>` 与 worker 的 `rai.importing.<jobId>.sqlite` 纳入。二者都是**整库副本**，只在 `finally` 里删——进程被 SIGKILL/OOM/断电后不在任何回收路径内。

24h 年龄窗口保证在飞的导入（分钟级）不会被误删。

---

### 🟡 P1-g / 🔡 L-4　静默吞错改为可观测

- `worker.ts`：提交后删除 rollback 点失败（原先 `.catch(() => {})`）改为写 `stderr`（`Failed to remove the import rollback point after commit: …`）。它位于 `var/backups/`，会被 `enforceBackupPolicy` 计入 count/bytes，**挤掉真备份**。
- `maintenance.ts` `preserveCorruptDatabase`：`.partial-` staging 清理失败原先完全静默，现收集为 `AggregateError`（与同文件 `:392` 的既有模式一致）。

---

### 🔡 L-1　`json_each` 守卫：实测驱动

先实测 SQLite 行为（`/tmp/jsonprobe.mjs`），结论比文档更细：

```
json_each over array          => OK 2
json_each over quoted string  => OK 1
json_each over bare string    => THROW malformed JSON     ← 唯一会抛的形状
json_each(NULL)               => OK 0
```

墓碑匹配（`database.ts`）改为 `CASE WHEN json_valid(...)` 两层嵌套守卫（`CASE` 短路求值，保证非法列不会被 `json_extract` 求值），实现在 TS 里由一个局部函数生成四份 `EXISTS`，可读性与原版一致。

实测（同一探针）：

| 形状 | 旧写法 | 守卫写法 |
|---|---|---|
| `{"K1":["u1"]}` | 命中 | **命中**（语义不变） |
| `{"K1":["u1","u7"]}` | 命中 | **命中** |
| `{"K1":null}` / 键缺失 | 不命中 | 不命中 |
| `{"K1":"u5"}` 标量 | 不命中 | 不命中 |
| `"not json at all"` | **整条 DELETE 抛错** | **不命中、不抛错** |

---

### 🔡 L-2　`finish_reason` 检查 + 输出预算可配

- 新增 `finishReasonOf(payload)`；`finish_reason === "length"` ⇒ **抛出** `模型输出被 token 上限截断`，不再把截断的 JSON 当成"短计划"交给下游（那正是它被静默回退成模板的路径）。
- `LlmConfig` 增加可选 `maxTokens`，由 `RAI_LLM_MAX_TOKENS` 提供（非法值回退默认 8192，不会把 `NaN` 发到上游）。`createPlanModelClient` **仍以单参数调用**，不违反 `weekly-plan.test.ts` 里"生成路径不得自带预算"的源码级断言。

---

### 🟡 P1-h　面板文案与 bridge 对齐（**本轮审查发现，本次新修**）

**这是本次改动自己引入的回归。** `schedulableCount` 改成排除"已过去 / 已完成"之后，计数为 0 有了**两种完全不同的原因**，而两个皮肤的面板仍按旧语义写死了同一句话：

```
schedulableCount == 0 ⇒ "本周没有可上表的训练日，生成一份新的课表再同步。"
```

周计划跑完或整周已过去时，面板因此劝用户**重新生成课表**——而重新生成不改变"这一周已经过完"的事实。同一状态下 bridge 已经说出正确的话（`WorkoutKitBridge.swift:99-101`，"本周没有还需要上表的训练。"），**两个界面就同一状态给出互相矛盾的解释**。

**改法**：把分类从 bridge 提到 mapper，成为唯一事实来源 `WorkoutPlanMapper.WeekOffer`：

| 字段 | 含义 |
|---|---|
| `offered` | 仍欠的训练日（今天及以后且未完成）——即真正交给调度器的那一组 |
| `skipped` | 服务端给过但没通过映射（休息日、建不成的处方） |
| `expired` | 通过映射但已经过去的 |
| `alreadyTrained` | 还没到但 `/v1/mobile/today` 已报"已训练"的 |
| `isExhausted` | `offered` 为空且 `expired + alreadyTrained > 0`，即"这一周做完了/过去了" |
| `emptyOfferMessage` | 两条文案的分支，面板直接取用 |

`WorkoutKitBridge.sync` 改为读同一个 `weekOffer(...)`，**不再自己算 `skipped/expired/alreadyTrained`**；两个面板由 `schedulableCount` 改为读 `offer.emptyOfferMessage`。计数与文案因此不可能再各算各的。

**验收**（新增 10 条断言，`WorkoutPlanMapperRegression.swift`，实跑输出）：

```
ok  a fully trained week reads as finished
ok  the finished week names the trained days and no expired ones
ok  a week that is entirely over also reads as finished rather than as a bad plan
ok  a week whose prescriptions all failed to build is not reported as finished
ok  the unusable week is the one that tells the runner to regenerate
ok  the unusable week's line is the one the panel falls back to
ok  the finished week says the work is done instead of asking for a new plan
ok  the week that is over says so instead of asking for a new plan
ok  the classified offer and the printed count are the same set
ok  the expired count is what makes the printed number read below the week
```

**突变验证**：把 `emptyOfferMessage` 改回旧的一律"重新生成"文案 ⇒ 2 条断言转 `FAIL`（`the finished week…` / `the week that is over…`），恢复后全绿。即这两条断言确实钉住了本次修复，不是跟着实现写的同义反复。

> **仍未覆盖**：本节的断言钉住的是**分类**（走哪个分支、返回哪句话），不是视图渲染。仓库里唯一会渲染这两个面板的是 `apps/ios/tests/VisualAcceptance.swift`（`test03Plan` 里有 `capture("03-plan")`，截图 + accessibility tree），但它**只截图不断言文案**，且需要 workspace + 模拟器（`run-visual-tests.sh`）。因此"面板确实显示了这句话"仍未被自动验证，被验证的是"面板取到的就是这个字段"。两个皮肤的 `Text(...)` 取值已改为同一字段，但皮肤层本身是复制而非共享。

---

## 三、反向复核：本次**纠正**了什么

1. **P0 的修法被加深，不是照抄**。上一轮说"删重复 + 写版本标记"；实测表明**删重复不够**（存活行仍是旧 id，重导出仍被拒 83,380 > 4,169），且**不需要版本标记**（id 重写后命中率即 100%）。这条如果不实测，修完仍然会被守卫拦住。

2. **`scheduledWorkouts` 的假前提已从代码里移除**。原注释作为"设计依据"留在代码里，会继续误导后来者；现已替换为按日期的正确说明。

3. **L-5 判定为误报，未改代码**。`NativeAppModel.swift:175-206` 的四个 `try?` **不是**静默留旧值：紧跟着有 `failedPanels` 计数、两档 `errorMessage` 文案（"核心数据均未能更新" / "有 N 项数据未能更新"），以及"刻意不 `loadCachedData()`"的注释说明。报告把这个有意设计读成了缺陷。相邻的 `workoutPlan` 那处 `try?` 确有静默，但注释明确写了理由是"便利项失败不该把整页标成离线"——属可接受的降级，同样不改。

---

## 四、未修项与理由

| # | 项 | 为什么不修 |
|---|---|---|
| L-3 | 无 Origin + `allowAuthenticatedRemote` 直接放行（`local-request-security.ts:69`） | 当前**不可利用**：只在该环境变量为 `1` 时生效，且仓库里没有非 `/v1/` 的写路由。正确修法要把"该请求已鉴权"传进 `isTrustedUnsafeRequest`，会同时改动本地（`allowAuthenticatedRemote=false`）与线上两条分支——在那之前需要先确认线上运维脚本是否依赖"无 Origin 直连"。建议**单独排期**，附回归断言。 |
| **N-1** | **审计的"自然键"与迁移的"稳定 ID"不是同一个键** | 见下方 §四·1。**这一项直接动摇 v22 的验收标准**，必须在上线前理解。 |
| **N-2** | **`entity_inventory` 未随迁移收敛** | 见下方 §四·2。迁移前就存在（160,051 vs 83,116），非本次引入，但迁移只收敛 `health_records`，会把偏差固化。 |
| **N-3** | **`var/rai.sqlite.import.lock.stale.*` 不在回收范围内** | 见下方 §四·3。**有意排除**，写明以免下一轮审计重复报。 |

### 1　N-1：两处对"同一条记录"的定义不同（🔴 影响验收）

`audit.ts:404-410` 的冗余行判定按 **`(type, source_name, start_at, end_at, value_text, value_numeric, unit)`** 分组；而迁移 `database.ts:1449-1476` 复算 id 用的是 **`raw_attributes_json` 里的原始字符串** `attributes.value / attributes.unit`。二者在 **`value_numeric` 相同但原始文本不同**时分歧（`"2.7"` vs `"2.70"` 是真实存在的导出形态，Apple Health 的 `value` 保留尾随零）。

**构造库实测**（两条 legacy 行，raw 分别 `2.7` / `2.70`，numeric 同为 2.7）：

```
迁移后行数 = 2      ← 迁移认为这是两条不同的记录（id 不同），都保留
audit.exactDuplicateRecords = 1   ← 审计认为它们是同一自然键的冗余行
```

**对当前数据的影响：无。** 我在真实库上直接查过：

```sql
-- 自然键重复组中，raw_attributes_json 的 value 存在多种写法的组数
SELECT COUNT(*) FROM (SELECT COUNT(*) c,
  COUNT(DISTINCT json_extract(raw_attributes_json,'$.value')) raw_variants
  FROM health_records GROUP BY type, source_name, start_at, end_at,
    value_text, value_numeric, unit HAVING COUNT(*) > 1) WHERE raw_variants > 1;
-- => 0
```

即本库**恰好没有**这种分歧，所以 §五 步骤 3 的验收（"冗余行应为 0"）在当前数据上仍然成立。我在本机副本上跑完整迁移后复核：`COUNT(*) = 83,380 = 唯一自然键数`，且逐行重算 **83,380/83,380 命中当前公式**，`audit` 的冗余行报 **0**。

**为什么不修**：两者不是"其中一个写错了"，而是服务于不同目的——审计要回答"表里有多少行是重复的"（面向人去重），迁移要回答"这一行的 id 该怎么算"（面向解析器复现）。要统一，必须先决定**哪一个是记录身份的定义**：若以原始文本为准，则 `"2.7"` 与 `"2.70"` 是两条记录（现状即如此，迁移正确）；若以数值为准，则审计才反映意图，但那样迁移就不该保留两行。**这是数据模型决策，不是 bug 修复**，且会改变已入库数据的语义，不宜在本次改动里顺手改。**建议**：单独排期，先明确身份定义，再让审计与迁移共用同一个键（最好抽成一个具名常量/视图，避免第三次漂移）。

**上线前请据此调整 §五 步骤 3 的措辞**：应核对 `COUNT(*) == COUNT(DISTINCT 按 raw 的稳定键)`，而不是仅看审计的"冗余行 = 0"——后者在数据形态变化后可能非零而与迁移正确与否无关。

### 2　N-2：`entity_inventory` 与 `health_records` 的固有偏差

报表的「记录条数 / 占比」栏取自 `entity_inventory` 的 `item_count`（`audit.ts:352-368`），而表头「表内 Health records 行数」取自 `COUNT(*)`。实测：

| 时点 | `health_records` 行数 | `entity_inventory` SUM | 差 |
|---|---:|---:|---:|
| 迁移前（真实库，只读） | 160,051 | 83,116 | 76,935 |
| 迁移后（副本） | 83,380 | 83,116 | **264** |

迁移把 76,935 行的差消到 264，但**没有消到 0**：`entity_inventory` 是"上次导入解析到"的投影（与 `import_manifest.record_count = 83,116` 一致），迁移只有 `health_records` 的收敛逻辑，没有重建这份投影。

**为什么不修**：264 是**迁移前就存在的**库存差异（迁移前 160,051 − 83,116 = 76,935 里包含了它），来源是历史上增量导入的累积记账，与本次 id 收敛是两件事。要修必须先查清这 264 行的来源（是解析器少记，还是入库多写），否则重建 `entity_inventory` 会把一个未知偏差变成一个已知但错误的数字。**建议**：单独排期做一次 inventory 与表的对账。在那之前，报表读者会看到"表内行数 83,380"与分类型合计 83,116 并存——**这个不一致在迁移后依然可见，不要误判为迁移失败**。

### 3　N-3：`.stale.` 锁目录有意留在回收范围外

`var/` 下实测有 **11 个** `rai.sqlite.import.lock.stale.<hex>/`（每个约 4 KB，内含 `owner.json`），新正则 `ABANDONED_DATABASE_FILE_PATTERN`（`maintenance.ts:103`）**不匹配**它们。

**为什么不修**：它们的量级与本轮要解决的 36 GB 完全不是一个问题（11 × 4 KB ≈ 44 KB），而放宽正则去匹配 `.stale.` 会扩大删除面到**目录**，与 `reclaimDisplacedDatabases` 里"绝不递归、绝不碰目录"的既有约束（`maintenance.ts:662-663` 显式 `info.isFile()` 判断，测试 `leaves unrelated files, directories…` 也钉住了这一点）直接冲突。为一个 44 KB 的问题去动一条刚被测试钉死的安全边界，不划算。**建议**：若日后要清，走独立的、显式只处理目录的路径，附自己的测试。

---

## 五、P0 上线前置（**需你确认**）

⚠️ 迁移 v22 会在**任何写入进程打开数据库时自动应用**（`RaiDatabase.open`，带 `BEGIN IMMEDIATE` 事务与自动备份）。也就是说：

- **本地**：跑一次 `npm run dev` 或任何 API 进程，`var/rai.sqlite` 就会被迁移（并自动在 `var/backups/` 建一份迁移前备份）。
- **线上**：`systemctl restart rai-api` 之后同样自动应用。

所以在你确认之前，**请先不要在本地或线上启动写入进程**。

**执行前建议**（按仓库规范）：

1. **先在线上跑只读计数**，确认线上是否同样带这些重复行（本轮只测了本地副本，线上未接触）：
   `COUNT(*)` vs `COUNT(DISTINCT type, source_name, start_at, end_at, value_text, value_numeric, unit)`；
2. `POST /v1/backups`（数据/schema 变更，按规范必做；迁移本身也会另建一份）；
3. 迁移后核对：`COUNT(*)` 应等于步骤 1 的唯一自然键数；`/v1/data-audit` 的冗余行应为 0。

> ⚠️ **步骤 3 的措辞已按 §四·1 收紧**：迁移的 id 定义基于 `raw_attributes_json` 的原始文本，审计的冗余行判定基于 `value_numeric` 等规范化列。本库实测两者**恰好一致**（raw 写法分歧组数 = 0），所以"冗余行 = 0"现在有效；但若线上数据存在 `"2.7"` / `"2.70"` 这类同值不同写法的组，**冗余行非零并不代表迁移出错**，必须按 raw 的稳定键另行核对。步骤 1 的只读计数建议**同时**跑一遍按 raw 的分组，先确认线上有没有这种分歧。

**本地副本实测**（本次审查独立复跑，只动 `/tmp` 副本）：160,051 → 83,380 行，冗余 0，逐行重算 **83,380/83,380 命中当前公式**、0 行命中旧公式、0 行两者都不命中，`foreign_key_check` 无问题，无 `__realign__` 残留，二次打开 1.5 s 幂等。另注：迁移后 `entity_inventory` 合计仍为 83,116（见 §四·2），**这是预期内的既有偏差，不是迁移失败**。

**回滚**：库文件级（`var/backups/` 里 `rai.before-v22.*.sqlite`）+ `git revert` 迁移代码。

---

## 六、变更文件

**后端 / 包**

| 文件 | 改动 |
|---|---|
| `packages/storage-sqlite/src/database.ts` | 迁移 v22；墓碑匹配 `json_valid` 守卫 |
| `packages/storage-sqlite/test/health-record-id-migration.test.ts` | **新增**：收敛 + 拒绝未知形状（2 条） |
| `packages/health-export-parser/src/audit.ts` | 冗余行改为真实计数；报表标签 |
| `apps/api/src/workout-segments.ts` | 负偏移钳位 |
| `apps/api/src/maintenance.ts` | 回收模式扩展；`.partial-` 清理不再静默 |
| `apps/api/src/server.ts` | 每日残骸回收定时器 |
| `apps/api/src/worker.ts` | rollback 删除失败写 stderr |
| `apps/api/src/weekly-plan-llm.ts` | `finish_reason` 检查；`maxTokens` 可配 |
| `apps/api/test/{workout-segments,weekly-plan}.test.ts` | 新增 6 条断言 |

**iOS**

| 文件 | 改动 |
|---|---|
| `apps/ios/RAI/PlanReceiptMatcher.swift` | **新增**：按日期消费式匹配（纯 Foundation，可测） |
| `apps/ios/RAI/WorkoutPlanMapper.swift` | `WeekOffer` 分类（`offered/skipped/expired/alreadyTrained` + `emptyOfferMessage`）；`weekOffer(in:now:completedLocalDates:)` |
| `apps/ios/RAI/WorkoutKitBridge.swift` | 改用匹配器；移除假前提注释；改读 `weekOffer` 而非自算 |
| `apps/ios/RAI/NativeViews.swift` | 面板零计数文案改读 `emptyOfferMessage` |
| `apps/ios/RAI/Skins/Technology/TechViews.swift` | 同上（两个皮肤同改） |
| `apps/ios/RAI/HealthKitExport.swift` | `.unknown` 状态 + 失败关闭 |
| `apps/ios/RAI/HealthKitSync.swift` | `.unknown` 分支；空导出可行动提示 |
| `apps/ios/tests/WorkoutPlanMapperRegression.swift` | 6 条收据归属断言 + 10 条 `WeekOffer`/文案断言 |
| `apps/ios/tests/run-model-tests.sh` | 编译列表加入匹配器 |

---

*报告时点：2026-09-16 08:20（Asia/Shanghai）｜基线 `b4cb6d9` + 本次 16 个文件改动*
*探针：`/tmp/raimigrate-check.mts`（真实库副本，只读打开）｜`/tmp/jsonprobe.mjs`｜`/tmp/raiprobe26/idprobe2.mjs`*
