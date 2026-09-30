# 用户体验优化 —— 核查报告

> 核查对象：`deliverables/USER_EXPERIENCE_IMPLEMENTATION_2026-09-28.md`（下称"实施记录"）所声称的实现与验证
> 核查方式：**只读**。未修改任何源码（自证见 §7）
> 代码基线：`eb5965d`，工作区 38 改 + 19 新增 = 57 个文件，未提交、未推送（`origin/main...main` = `0 0`）
> 核查日期：2026-09-28

---

## 一、结论先行

**实施记录基本成立，且罕见地诚实**：12 个工作包的**代码实现我逐条找到了触发路径**，声明的 9 条边界无一虚报，7 项"发布前仍需人工执行"清单也确实都是静态门禁照不到的面。§4 的门禁数字与本地日志**逐字一致**，我用三次独立实跑复现了其中三项。

**但门禁全绿不等于没有缺口**。我找到 **4 条真实缺陷/缺口 + 1 条瑕疵**，全部位于门禁结构上照不到的位置（详见 §6 归因）。同时我**推翻了自己先前的两个错误印象**（§3），两个都属于"印象 vs 证据"的经典分歧。

| # | 严重度 | 结论 | 位置 |
|---|---|---|---|
| 1 | 🟡 | `isCurrentDay` 的时区判据**没有任何断言守得住**（突变探针实测：删掉时区赋值，测试仍绿） | `apps/ios/tests/UserExperienceRegression.swift:5-7` |
| 2 | 🟡 | Web 反馈抽屉在**重试**路径上被确定性 4xx 卡死，且错误文案误导（叫用户去重试一个必然失败的操作） | `apps/web/src/components/OverrideDrawer.tsx:110,124` |
| 3 | 🟡 | "会持久化没人看见的计划"这一理由已过期，但**在两个文件里各留一份副本** | `apps/api/src/weekly-plan-llm.ts:45-48`；`apps/api/test/weekly-plan.test.ts:1101-1103` |
| 4 | 🟡 | 新增运维脚本**零执行者**（仅有 2 份文档引用），按本仓自定判据属孤儿脚本 | `deploy/check-runtime-readonly.sh` |
| 5 | 🔡 | 普通列表路由复用了"导出专用"模块，报错文案莫名提"导出" | `apps/api/src/server.ts:892` |

**核查判定口径**（每一条"成立"都必须同时满足三条，缺一不算）：①原始触发路径能逐句对上代码；②修复**自带执行者**（有真跑它的门禁）；③修复引入的**新状态自己也有清理与幂等路径**。

---

## 二、逐条核查证据

### 2.1 门禁数字与代码冻结（§4）

| 检查项 | 实施记录 | 我实跑 / 复核 | 判定 |
|---|---|---|---|
| `npm run typecheck` | 通过 | `TYPECHECK_EXIT=0`（2026-09-28 重跑） | ✅ 一致 |
| `npm test` Node/API/共享包 | 845 / **842** 通过 / **3** 跳过 / 0 失败 | 845 / **841** 通过 / **4** 跳过 / 0 失败 | ✅ 见下方差额解释 |
| `npm test` Web | 15 文件 / 92 项 | 15 文件 / 92 项 | ✅ 逐字一致 |
| `npm run test:ios` | 67 个源文件 | `类型检查 67 个文件（已跳过 3 个仅依赖高德 SDK 的文件）`，`IOS_EXIT=0` | ✅ 逐字一致 |
| `git diff --check` | 通过 | `EXIT=0` | ✅ 一致 |
| 日志目录 `var/verification/ux-2026-09-28/` | 存在 | 真实存在，8 个文件，时间戳 12:51–13:08 | ✅ 非事后补造 |

**唯一差额（1 条）的机制解释**：验证日志 `test.log:5083` 是 `ok 786 - publication lock rejects PID reuse when the process identity differs`（无 SKIP），我这里同一条变成 `# SKIP process identity probing is unavailable in this environment`。原因是该用例在 macOS 上靠 `spawnSync("ps", …)` 探测进程身份，本机子进程被拒（`EPERM`）⇒ 按设计 fail-safe 跳过。**总数 845 与失败数 0 均不变，只有 pass→skip 的 1 例位移**，不是回归、不是覆盖丢失。⇒ 实施记录 `:92` 写的是**验证当时的时点快照**，数字本身没错。

**代码冻结已证伪"验证后工作区被改动"的怀疑**：`source-manifest.json` 记 `base: eb5965daeb49…` + 57 个文件 sha256。我逐文件重算 ⇒ **57/57 一致，0 不一致、0 缺失**。`diff-stat.txt` 记的 35 files/570 insertions 与当前 38/615 的差异，**全部来自 3 个文档**（`apps/ios/README.md`、`deploy/README-UBUNTU.md`、`docs/IOS_NATIVE_API_CONTRACT.md`，均于 13:07:21 追加），**没有一个代码文件**在验证后被动过。

### 2.2 A1 首页降噪 —— 成立，且有真执行的回归守卫

- 首页确实移除了状态大卡：`TechViews.swift:15-16`（原 `TechSyncStatus(showsHistory: false)` 与条件渲染的 `TechFreshnessBanner` 已删）
- **不是删除而是移位**：`TechSyncStatus(` 仍在 `TechDataSyncDetailView.swift:10`（`showsActions: false`）、`TechFreshnessBanner` 仍在 `TechViews.swift:672` 与 `TechDataSyncDetailView.swift:16` 使用 ⇒ **无孤儿组件**
- 全局错误 sheet 已从 `NativeViews.swift` 删除；但 `errorMessage` **仍有 5 个真实消费者**（`TechViews.swift:32,578`、`TechLockSheet.swift:53`、`TechRaceGoalEditor.swift:142`、`TechPlanView.swift:607`、`TechDataSyncDetailView.swift:18`）⇒ 删的是"模态呈现"，不是错误数据。与实施记录 `:35` 相符
- **守卫是真门禁**：`apps/ios/tests/check-today-layout.py:12-15` 断言 `"TechSyncStatus(" not in body`、`"TechFreshnessBanner(" not in body`、`"TechDataSyncDetailView" in views`、`"!native.canConfirmToday" in views`，且 `run-model-tests.sh:79` **真的执行它**。同一文件的 `:74-78` 恰好在注释里记录了这条脚本曾是孤儿的历史教训 ⇒ 已挂载

### 2.3 A1 建议真实性 —— 成立，且是模型层强制而非 UI 提示

新增状态 `isTodayAvailable` 与派生判据 `canConfirmToday`（`NativeAppModel.swift:29-33`）：

```
canConfirmToday = isTodayAvailable && UserDataNoticePolicy.isCurrentDay(today.today.localDate, timezone: today.timezone)
```

三条口径逐项落地：
- **危险动作被模型层挡住**：`NativeAppModel.swift:579` 的 `lockNextSession` 守卫含 `canConfirmToday`。这是**写操作的入口**，不是按钮的灰化
- **缓存永远不给确认权**：`loadCachedData()`（`:883`）、`reset`（`:953`）、`serverConfigurationChanged`（`:121`）、离线分支（`:211`）、快照不新鲜分支（`:240,1039`）**全部把 `isTodayAvailable` 置 false**，只有"取到 today 且快照版本一致"时才置 true（`:236,1035`）⇒ 新状态自带清理且每次刷新幂等重算
- **8 处消费**：`TechViews.swift:348,351,413,417`（标题降级为"训练建议参考"、动作禁用、说明文案）、`TechLockSheet.swift:50`、`TechPlanView.swift:71`、`TechTrainingReminderView.swift:32`、`NativeViews.swift:66,79`

⚠️ 但见 §3 更正与 §一 缺陷 #1：这个判据的**日期部分**没有断言守得住。

### 2.4 B0 安全写入（CAS）—— 成立，且败者不写库已被实测

`packages/application/src/service.ts:148-193`：

```
BEGIN IMMEDIATE                      ← :152 取写锁，串行化
SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM workout_overrides WHERE training_session_id = ?
if (input.expectedRevision !== undefined && input.expectedRevision !== Number(revisionRow.revision) - 1)
  throw new WorkoutOverrideRevisionConflictError();       ← :158-165 比对在事务内
```

语义正确：`expectedRevision === MAX(revision)` 放行，新 revision 为 `MAX+1`。客户端两侧都发这个值（Web `OverrideDrawer.tsx:95`、iOS `NativeWorkoutFeedbackInput.init` ⇒ `expectedRevision = detail.override?.revision ?? 0`），与"无覆盖时为 0"一致。

**最强的一条证据**是 `apps/api/test/command-queue.test.ts` 新增用例：同一 `expectedRevision: 0` 被两个命令使用，后者带 `rpe: 9` ⇒ 断言 `status === "failed"` 且 `error.code === "workout_override_revision_conflict"`，然后**直接查库**：

```
assert.equal(rows.length, 1); assert.equal(rows[0]?.rpe, 5);      ← 败者的 9 没写进去
assert.deepEqual(await applyMutationCommand(…one), queue.get(one.id)?.result);   ← 回执重放返回同一结果
```

⇒ **"版本检查在真正执行的事务内，不只在入队时"（实施记录 `:39`）有实测支撑**，同时证明了幂等回执重放。

PATCH 与命令路径共用同一实现：`apps/api/src/server.ts:979-981` 与命令执行路径都走 `appendWorkoutOverride` ⇒ 实施记录 `:15` 成立。

### 2.5 B1 跑后反馈 —— 成立，幂等键与显式 null 都被断言

- **先落盘再提交**：`NativeAppModel.swift` 的 `saveFeedback` 里 `cache.write(NativeFeedbackPending(command: command), …)` 在 `api.submitFeedback` **之前**，且写失败直接返回"无法安全保留本次操作…尚未提交"
- **丢响应复用同一命令**：`let command = retained ?? NativeFeedbackCommand(idempotencyKey: UUID().uuidString, payload: input)`
- **完整快照而非补丁**：`APIModels.swift` 给 `NativeWorkoutFeedbackInput` 写了自定义 `encode(to:)` 逐字段编码 ⇒ 清空 RPE/备注时发**显式 null**，不会因为省略键而保留旧值。`UserExperienceRegression.swift:29-33` 断言 `encoded["rpe"] is NSNull && encoded["note"] is NSNull`
- `ModelRegression.swift` 新增 4 条断言：丢响应保留命令且 `firstPayload.payload == feedbackInput`；**重试复用同一幂等键**（`retried.idempotencyKey == firstPayload.idempotencyKey`）；分析任务失败仍报"已保存"（`text.contains("反馈已保存") && text.contains("分析更新未完成")`）；400 拒绝后解锁重编辑（`pendingFeedback == nil`）；CAS 冲突报"别处更新"

### 2.6 B2 训练纠正 —— 成立（Web 侧一处分支例外，见 §一 #2）

`OverrideDrawer.tsx` 两段式："查看最新记录（保留输入）" → 展示最新 RPE/备注 → 用户**显式**点"放弃当前输入，使用最新记录重新编辑"。不自动覆盖旧草稿 ⇒ 与实施记录 `:45` 相符。iOS 侧同轴拆分（`eligibilityOverride` / `statisticsParticipation` 独立）。

### 2.7 C1 按日查询 —— 成立，真接到 SQL 过滤

`localDate` 查询项贯通全链：`schemas.ts:36` → `server.ts:887-892`（展开成 `startedFrom`/`startedBefore`）→ `workout-read-repository.ts:129-130`：

```
julianday(f.workout_start_at) >= julianday(?)   /   julianday(f.workout_start_at) < julianday(?)
```

`apps/ios/RAI/APIClient.swift` 的 `workouts(...)` 加了 `localDate: String? = nil` 查询项 ⇒ 实施记录 `:18`"不拿最近训练冒充指定日期"成立。

### 2.8 C1 Watch 措辞 —— 成立，且旧句子**零副本残留**

`"已完成"` → `"已记录训练"` 是一次系统性改词（`WorkoutKitBridge.swift:52,108-109,120`、`WorkoutPlanMapper.swift:124,203,354,379`），`WorkoutPlanMapperRegression.swift` 的 **6 条断言同步更新而非删除**（`:169,173,401,447,526,634,638`）。

反向 grep `"已完成的日期不会重复下发"` ⇒ **0 命中** ⇒ 作者把 4 处副本全找齐了（这正是我在既有纪律里记过的那类问题：同一句错话会在别的文件里留副本）。

核查过其余 3 处 `"已完成"` 不构成遗漏：`TechViews.swift:550` 是**本周距离**标签、`NativeFormat.swift:124` 是会话类型兜底、`NativeFormat.swift:343` 是通用任务/模型状态 —— **均与"某天的训练是否已完成"不同概念**。

### 2.9 D1 预测 —— 成立

`TechViews.swift:875` 新增显示 `race.confidence`（"可信度 x%"）；计划页有入口；未另建预测算法。实施记录 `:20` 的"原架构报告『iOS 完全没有预测』不准确"这一自我更正，与我读到的代码一致。

### 2.10 D2 安全导出 —— 成立，安全边界**由真实子进程验证过**

这是我见过质量最高的一条：`apps/api/test/server-runtime.test.ts` 新增用例**真的 spawn 了 `server.ts`**（带 `RAI_API_TOKEN` + `RAI_PUBLIC_HOSTS: 127.0.0.1`），断言：

| 请求 | 期望 | 意义 |
|---|---|---|
| `GET /v1/health` | 200 | 服务确实活着（否则后续断言无意义） |
| `GET /v1/exports/…` 无令牌 | **401** | 公开 Host 下仍不可匿名导出 |
| 携正确 Bearer | 200 + `cache-control: no-store` + `count: 0` + 含表头 | 正常路径 |
| `from=2026-02-29`（不存在的日期） | **400** | 日期真实性与范围校验在读库前完成 |

`csvCell` 的公式注入防护**有专门测试**（`apps/api/test/workout-summary-export.test.ts:16-18`），覆盖 `=1+1`、` +cmd`（前导空格）、`@SUM(A1)`、`-1+2`、`\t=1`、`\n=1` 六个向量 + 引号/换行转义 + `null`；`csvCell` 也**确实被 export**（`workout-summary-export.ts:23`）。

白名单是**真投影**：`workout-summary-export.ts:36-37` 只取 5 列，测试用一个塞了 `note`/`averageHeartRateBpm`/`route`/`id` 的 fixture 断言 `!csv.includes("PRIVATE") && !csv.includes("latitude")`。

iOS 侧同样成立且细节到位（`TechWorkoutExportView.swift`）：日期控件 `:29,31` 用 `.environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)` **钉死时区**；改日期即 `preview = nil`（`:41-42`）⇒ 不能保存过期预览；identity 变化清 preview（`:43`）；`prepare()` 在 await 后重新校验 `scope == identity` 且起止日期未变（`:65`）。实施记录 `:54,58,59` 逐项属实（含 `:58` 的 Blob + `setTimeout(revokeObjectURL, 1000)`，`:59` 的 CSS 恰好是 `min-width: 1024px` 断点）。

### 2.11 E1 训练提醒 —— 成立：代次校验 + 先清后排 + 失败清本代次

`TrainingReminders.swift` 的 `reconcile`：**先全清**（`:60` 清 pending、`:63` 清 delivered，均按 prefix 过滤）**再排**，每个 `await` 之后校验 `epoch == generation`（`:59,62,65,69,83,87`）；`:89` 的失败路径只清**本 epoch 的 id**（`prefix + epoch.uuidString`）而不影响其他代次 ⇒ 幂等与新状态清理齐备。

`bind(scope:)`（`:20-28`）换身份时**只改内存状态、不清理旧通知** —— 我一度判为缺口，但追调用点后**证伪**：`NativeViews.swift:63-67` 用 `.task(id: reminderSnapshot)` 驱动 reconcile，而 `reminderSnapshot`（`:79`）**包含 `native.feedbackScope`** ⇒ 身份变化必然触发 reconcile ⇒ 旧通知在"先清"里被带走。**后果由调用方闭合**。

纯策略层 `TrainingReminderPolicy.slots` 有 6 条断言（`UserExperienceRegression.swift:17-23`）：只取可执行非休息未完成日、`fireAt` 按**计划时区**落在 `2026-09-29T00:00:00Z`（= 上海 08:00）、已完成日跳过、`hour: 22` 静默、超出七天窗口跳过、无计划跳过。

### 2.12 架构收敛与 F1

删除项**全部零残留**：`read-store-manager.ts` 的 `invalidate()`、`mobile-read.ts` 的 `loadSleepWindow`/`loadMetricWindow`/`metricValues`、`APIClient.swift` 的 `generateWeeklyPlan` —— grep 全仓均无调用者。`schemas.ts:733` 标 `deprecated: true`，`server.ts:1179` 加 `Deprecation: @1790553600`（**我已验证 = `2026-09-28T00:00:00Z`**），服务端路由保留 ⇒ `:23` 成立。

`weekly-plan.test.ts` 的旧断言**被重指向而非删除**：正则从 `timeoutSelf.generateTimeoutInterval` 改为 `func previewWeeklyPlan…path: "/v1/mobile/workout-plan/preview"…timeout: Self.generateTimeoutInterval`；时长不变量（`DEFAULT_TOTAL_BUDGET_MS < clientMs < resourceMs`）继续保留 ⇒ 这是"旧行为逐点对照"做对了的样板。

**新增文件无孤儿**：4 个新 Swift 视图全部有真实导航入口 —— `TechDayWorkoutsView` ← `TechPlanPreviewSheet.swift:80`；`TechTrainingReminderView` / `TechWorkoutExportView` ← `TechViews.swift:1886,1889`；`TechWorkoutFeedbackView` ← `TechViews.swift:1326` 的 `.sheet(item:)`（顺带解释了 `WorkoutDetailResponse` 为何要加 `Identifiable`）。`NativeWorkoutExport` 也有消费者（`TechWorkoutExportView.swift:18`、`APIClient.swift:242`）⇒ D2 在 iOS 侧**真的实现了**，不是只加了类型。

**"BUILD SUCCEEDED 覆盖了新文件"已独立验证**：`RAI.xcodeproj/project.pbxproj:32-36` 用的是 `PBXFileSystemSynchronizedRootGroup`，同步根 `path = RAI`（整个目录）⇒ 新文件自动进 target。所以"pbxproj 里搜不到新文件名"是**正确的**，不是缺口。

---

## 三、我推翻的两个自身印象（核实纪律）

这两条我先前判错了，一并记录，因为它们正是"印象不能替代证据"的样本：

1. **`csvCell` 并非无测试** —— 我此前认为它未被 export、防护从未被执行。实测：`workout-summary-export.ts:23` 有 `export`，`workout-summary-export.test.ts:5` 有 import，`:16-18` 有 6 个注入向量的断言。**原判断错误**。
2. **D1 时区语义并不同时矛盾** —— 我此前认为 `exportWindow` 按 UTC 解析却声称 Asia/Shanghai。实测 `:19-20`：`startedFrom` 是**字符串拼接** `${from}T00:00:00${ISO_UTC_OFFSET}`（不经过 `Date.parse`），`startedBefore` 由 `${through}T00:00:00+08:00` 加一天再转 ISO；`Date.parse` 只用于 `valid()` 自洽检查与天数差值（两侧同为 UTC，差值正确）。`data.test.ts` 还**实测了日界**：`2025-01-22…+08:00` 命中 1 条、`2025-01-23…+08:00` 命中 0 条。**原判断错误**。

---

## 四、报告未覆盖、但会影响修复方案的前置事实

1. **`ModelRegression.swift:576-580` 把固定夹具改成了"跟随运行日"**：`todayJSON.replacingOccurrences(of: "2026-09-16", with: 当前上海日期)`。这是 `canConfirmToday` 生效的**必要条件**（否则硬编码的过去日期会让所有锁定用例失败），但代价是：该测试从"固定夹具"变成"日期依赖运行时刻"。同一段夹具里 `:726,755,767,775` 的**目标计划项**仍是固定 `2026-09-16`，未被替换 ⇒ 夹具内存在"今天 = 运行日"与"周计划 = 固定日"的不一致。当前用例照跑不误（模型不交叉校验这两者），但若跨日运行或日后有人让 `canConfirmToday` 去查周计划，就会抖动。
2. **`tokenRequiredReadRoutes` 没有运行时消费者**：它只被 `/v1/health` 计数；执行者是测试 `server-runtime.test.ts:1496-1507`（断言两个 Set 非空且不重叠）。真正有运行时强制的是 `publicReadRoutes`（经 `installLocalRequestSecurity`，`server.ts:346-348`）。⇒ **导出端点的安全性实际由 `server.ts:908-916` 里手写的 Bearer 比较提供**，登记只是"新增 GET 必须显式分类"的防漏制度。这决定了修复时不能把安全性寄望于名单。
3. **`check-export-determinism.py` / `check-background-capabilities.py` 与本次无关**：它们针对 `HealthKitExport.swift` 的 export.xml 确定性与后台能力结构，属既有脚本（未出现在本次改动清单）。核实这一点是为了避免把它们的绿灯误算作 D2 的证据。

---

## 五、报告之外的未验收高风险点（我**未**验证 = 不能说通过）

- 真机 HealthKit 首次授权/无记录/后台恢复/断网重连；Apple Watch 系统日程真正可见；通知触达；VoiceOver 与动态字体；模拟器视觉审阅 —— 实施记录 `:129-136` 自己列为待办，措辞诚实，我**未代其验收**
- `xcodebuild`：我只读了 `xcode-build.log`（123KB，`BUILD SUCCEEDED`），**未重跑**
- `npm run test:e2e:web`：只读日志（11 tests / 10 pass / 1 skip，390px 用例按约定跳过），**未重跑**
- `TrainingReminders`（调度类本身）无法在无 `UNUserNotificationCenter` 的环境单测 ⇒ 只有纯策略层被断言。实施记录 `:131` 已承认
- Linux 生产只读检查脚本的实际输出 —— 本机非 Linux，脚本按设计 `exit 2`，**没有真实运行过**

---

## 六、为什么门禁全绿仍然漏掉这五条（结构性归因）

- 漏掉的 4 条里，**3 条落在门禁结构上照不到的位置**：
  - **说明性文字**（缺陷 #3）：没有任何门禁检查"注释/测试名是否仍与代码同义"。#3 的同一句错话在**两个文件各留一份**，正是因为没有反向 grep 的自动机制
  - **未被测试单元引用的 UI 事件处理器**（缺陷 #2）：`OverrideDrawer.submit` 的 catch 只在 e2e 的 **500 传输失败**分支被走到，确定性 4xx 分支**零覆盖**（全仓无 `OverrideDrawer` 单测）。而"Web 待确认命令与端到端覆盖"在 `:115` 被列为已覆盖 ⇒ **覆盖描述是真的，只是覆盖不到这一支**
  - **运维脚本**（缺陷 #4）：本仓没有"脚本必须有执行者"的自动检查。`check-today-layout.py`、`check-background-capabilities.py` 都是**靠注释提醒后人手工挂载**的（`run-model-tests.sh:68-89`）
- 第 1 条不同：它**在门禁内**，但**不能被突变杀死** —— 属"跑绿 ≠ 断言有效"。这正是我在本仓既有纪律里记过的那一类：断言必须突变到红才算数。此处 `isCurrentDay` 守的是 A1"建议真实性"这条安全属性的**唯一日期实现**，却没有突变守卫。

---

## 七、判定与建议

**总判定：实施记录所声称的 12 个工作包，代码实现全部成立；验证数字与日志真实且可复现；声明的边界无一虚报。** 不需要返工，需要的是**补 4 个缺口**。

建议的修复次序（**本轮只报告，未动手**）：

| 优先 | 动作 | 验收标准 |
|---|---|---|
| P0 | 给 `isCurrentDay` 加能杀死时区变体的断言：改用 `2026-09-28T16:30:00Z`（上海 = 09-29、UTC = 09-28）并**两条都断言** | 删掉 `formatter.timeZone` 赋值后该断言必须变红 |
| P0 | 修 `OverrideDrawer.tsx` catch：`FeedbackSubmissionRejected`（确定性 4xx）**无条件**清 `pending` 解锁表单；错误文案按类别区分（确定性拒绝 vs 传输不确定 vs 凭证变化） | 新增 `OverrideDrawer` 单测覆盖"重试遇 4xx 后可重新编辑"；e2e 加 400 分支 |
| P1 | 订正过期理由的**两处副本** + `APIClient.swift:88-93` 的同一段 | `grep -rn "no plan was written"` 只剩符合 preview 语义的表述 |
| P1 | 文档给 `deploy/check-runtime-readonly.sh` 标注"不进自动门禁，需人工在服务器执行" | 实施记录 `:24` 与 `deploy/README-UBUNTU.md` 各写明 |
| 🔡 | `/v1/workouts?localDate=` 不再复用 `exportWindow`，或让它的报错文案与"导出"解耦 | 列表场景下的非法日期不再出现"导出"字样 |

**自证：本次核查未修改任何源码。** 依据：对 `var/verification/ux-2026-09-28/source-manifest.json` 的 57 个 sha256 逐文件重算，**0 不一致、0 缺失**；`git status --porcelain` 仍为 `38 M + 19 ??`；`HEAD` 仍为 `eb5965d`；`origin/main...main` 仍为 `0 0`。全部产物只写入 `/tmp/rai-verify/`（`test.log`、`typecheck-rerun.log`、`ios-rerun.log`）。
