# 未提交到远程的改动说明与分级审查（2026-09-26）

> **口径**：本地 `HEAD` = `origin/main` = `49c9ef9`（2026-09-24 18:54），`git log origin/HEAD..HEAD` 为空
> ⇒ **没有任何未推送的提交**，"未提交到远程"= 工作区全部改动。
> **规模**：37 个已跟踪文件（`+1487 / −729`）+ 18 个未跟踪文件（8 个代码 / 10 个文档）。
> **方法**：按层读 diff，结论一律落到 `文件:行号` 或命令输出。
> **本轮实测**：`npm run typecheck` = **EXIT 0**。
> **沿用**：同日约 1 小时前在**同一工作区**跑过的门禁（node 836/833 pass/0 fail/3 skip、vitest 13 文件 86 tests、
> `test:ios` EXIT 0、`test:e2e:web` 11/10 pass/0 fail/1 skip、`rust:verify` EXIT 0、`bundle`/`smoke:api` EXIT 0），
> **本轮未重跑**（工作区仅多出一份 09-26 审计报告，业务代码逐字节未变）。

---

## 一、一句话结论

这批改动是**三批交织的代码 + 一批文档**，主题分别是「周课表不再一按即覆盖（预览-确认两阶段）」、
「竞赛目标统一进入减量/比赛日策略」、「预测模型缺测不再当 0 分 + 全链路溯源」。

**健康度：A-。没有发现 🔴 必修项**：新写端点已登记、契约无破坏性变更、iOS 解码全兼容、
门禁脚本随搬迁同步更新。**4 个 🟡 待处理**，其中只有 2 条建议在提交前动一下
（重复文档删除、兜底常量同源）。

---

## 二、这批改动是什么

| 批次 | 主题 | 已跟踪文件 | 未跟踪新文件 |
|---|---|---|---|
| **A** | 周课表「预览 → 确认」两阶段，杜绝一次点击覆盖既有分段 | `server.ts` `schemas.ts` `weekly-plan-service.ts` `api-contracts` + 3 个测试 | `weekly-plan-preview.ts` `weekly-plan-preview.test.ts` `TechPlanPreviewSheet.swift` |
| **B** | 竞赛目标进入 `race_day`/`taper` 策略；生成 / 手工编辑 / 手表导出**三处同源** | `race-plan-policy`① `weekly-plan-validate.ts` `mobile-coach.ts` `mobile-read.ts` `mobile-goals.ts` `data.ts` + 4 个测试 + 5 个 iOS 文件 | `local-date.ts` `manual-plan-policy.ts` `TechPlanView.swift` |
| **C** | 预测模型「缺测 ≠ 0 分」+ 恢复溯源 + `explainability` + walk-forward CLI | `prediction-data.ts` `prediction-report.ts` `contracts` `storage-sqlite`×2 `api-contracts` + 2 测试 + iOS 3 文件 + 2 个 Web 文件 | `prediction-walk-forward-cli.ts` |
| **D** | 文档（交付物） | `README.md` | 10 份 `.md`/`.json` |

① `race-plan-policy.ts` 本身是未跟踪新文件，其调用方 `weekly-plan-validate.ts` 是已跟踪改动。

---

## 三、逐批：改了什么

### 批 A —— 周课表「预览 → 确认」两阶段

**动机**：原 `POST /v1/mobile/workout-plan/generate` 一次调用即覆盖存库课表，用户没有反悔机会。

| 改动 | 位置 |
|---|---|
| 两个新端点 `preview` / `confirm`，**都已登记** `metadataOnlyMutationRoutes` | `server.ts:1108`、`server.ts:1131`、登记在 `server.ts:287-288` |
| 进程内预览状态机：最多 8 条、15 分钟过期、`candidateId+revision+fingerprint` 三重校验 | 新 `weekly-plan-preview.ts`（25 行） |
| **丢失确认后的重试不产生第二个 revision**（`item.committed` 短路） | `weekly-plan-preview.ts:19` |
| 输入指纹 sha256（goals/推荐 revision/日期/本周/同步时间/处方/上周跑量），生成期间数据变了即 409 | `server.ts:1096-1105` |
| legacy 路径也补 CAS 复查（LLM 返回后再读一次 goals 与 inputs） | `server.ts:1048-1056` |
| 写回改为**合并窗口**：只替换本周一之后的日期，周一之前保留 | `weekly-plan-service.ts:29-35` `mergePlanWindow()` |
| schema + OpenAPI 条目 | `schemas.ts:245`、`schemas.ts:736`、`schemas.ts:744` |
| iOS：preview/confirm 两个方法 + `confirmPlanPreview()` + 预览 UI（含"原计划 vs 新计划"逐日对照、替换日期、过期时间） | `APIClient.swift:164-174`、`NativeAppModel.swift:683/706`、新 `TechPlanPreviewSheet.swift`（105 行） |

**测试**：新 `weekly-plan-preview.test.ts` 5 条（幂等 / 过期+淘汰+重启 / 竞赛策略幂等 / 手工改写 / 越权拒绝）；
`server-runtime.test.ts` 走真实 HTTP 全流程（preview 不写库、confirm 写一次、**重试不重复写**、陈旧 409）；
`ModelRegression.swift:441-480` 补对应客户端断言。

### 批 B —— 竞赛目标统一进入计划策略

**动机**：减量/比赛日此前只活在教练建议里，**手工编辑周计划可以绕过它**写进"比赛日 interval"。

| 改动 | 位置 |
|---|---|
| 新增 `racePlanPhase()`（`build` / `taper`≤14天 / `race_day` / `past`）与 `taperDayCeiling()`（沿用既有 30% 减量、上限 10km） | 新 `race-plan-policy.ts`（16 行，`:8`/`:14`） |
| 新增真日历校验（拒 `2026-02-30`） | 新 `local-date.ts`（13 行） |
| `applyRacePlanPolicy()` **幂等**：比赛日改休息并写明"不等于比赛已完成"；taper 期降级为受上限的轻松跑；预算不足则改休息 | `weekly-plan-validate.ts:707-731` |
| 三个调用点统一：生成（LLM 经 `constrainUpcomingPlan`、启发式直调）、手工编辑、手表导出 | `weekly-plan-service.ts:133/171`、`manual-plan-policy.ts:31`、`mobile-read.ts:418` |
| `PUT /v1/mobile/goals` 落库前校验：①冻结日期逐字节比对 ②自然周预算 ③越权质量课 | 新 `manual-plan-policy.ts:31`，接线 `server.ts:1208-1214`，422 映射 `server.ts:1218` |
| `raceTarget.date` 从正则升级为真日历校验 | `mobile-goals.ts:193`、`mobile-goals.ts:619` |
| **"今日"改为遵循已保存课表**：`decidePlannedSession`（计划优先，显式休息不因"看起来状态好"升级）+ `decideUnplannedSession`（原逻辑） | `mobile-coach.ts:819` 起 |
| 恢复分从**恒 null** 改为可计算（仅当证据是今天且非 stale/unknown） | `mobile-coach.ts:972-987` |
| 重新锁定修复：新增 `lock.candidate` / `relockSuggested` 重算；relock 改用 `lock.candidate`，不再把 `lockedSession` 置 null 重算 | `mobile-read.ts:296-300`、`server.ts:1231/1244` |
| 导出窗口补齐：未来 7 天缺哪天补哪天并标 `executable:false`（不隐藏、不编造训练） | `mobile-read.ts:439-446` |
| `executableMobilePlan()`：`/v1/mobile/today` 与 `/v1/mobile/workout-plan` 共用同一执行窗口 | `data.ts:530-560` |
| iOS：竞赛目标支持「配速 ↔ 完赛时间」双输入与等价换算 | `TechRaceGoalEditor.swift:35-90`、`NativeFormat.swift:369-386` |
| iOS：锁定弹窗显示"原锁定 → 新建议"并支持重新锁定 | `TechLockSheet.swift:15/48/51` |
| iOS：周计划条 rest 日不再可编辑距离 | `NativeAppModel.swift:1076-1135` |

**测试**：`weekly-plan.test.ts`（跨周日预算 + 比赛日留白）、`mobile-coach.test.ts`（计划驱动今日 + 恢复分只认当天）、
`mobile.test.ts`（非法日期拒绝、执行窗口 7 天、recommendation 可解释性）、`schemas.test.ts:245`（新端点 schema + **Picker 契约扫描器**）。

### 批 C —— 预测：缺测不再当 0 分 + 溯源 + 可解释性

**动机**：`readiness` 无证据时返回 `{five_k:0, ten_k:0, half_marathon:0}`，把"没有数据"当成"能力最差"——是最大惩罚。

| 改动 | 位置 |
|---|---|
| 拆出 `loadRaceReadinessEvidence()`，无样本返回 `values:{}` + `status:"insufficient_data"`（不再填 0） | `prediction-data.ts:461-540` |
| `loadRecoveryReadinessEvidence()` 同构返回 `{value, provenance}` | `prediction-data.ts:548-574` |
| 性能包络补 56 天窗口；三个 SQL 绑定必须相邻（`node:sqlite` 缺绑定静默当 NULL） | `prediction-data.ts:64`、`:287-292` |
| 新增 `PredictionRecoveryProvenance`（`canonical`/`raw_compat`/`mixed`/`none` + coverage + latestObservedAt） | `prediction-recovery-read-repository.ts:13-19`、`:83-102`、`:179-241` |
| 报告带出 `readinessStatus/EvidenceCount/DataThroughAt` 与 `recoveryProvenance` | `prediction-report.ts:230-270` |
| 新增 `explainability`（`prediction-explainability-v1`）与 guidance code `race_readiness_missing` | `prediction-report.ts:625-650`、`:599-601`；`contracts/src/index.ts:840-858` |
| `readiness` 类型 `Record<RaceDistance, number>` → `number \| null`（**变宽**，非破坏） | `contracts/src/index.ts:903` |
| iOS 新增 explainability/modelSelection/race 修正项等**全 Optional** 字段 + `PredictionLoadState` 三态 | `APIModels.swift:370-470`；`NativeAppModel.swift:447-462/715-740` |
| iOS 展示：陈旧横幅、疲劳修正 | `TechAbilityDetailView.swift:212`、`:227` |
| 新 CLI + Node 生命周期门禁 | 新 `prediction-walk-forward-cli.ts`（29 行）、`package.json:67-68`、`README.md:128-132` |
| Web 补 `race_readiness_missing` 中文文案 | `Physiology.tsx:29`、`PredictionsPage.tsx:49`（`Record<GuidanceCode,string>` ⇒ **不补即编译失败**，编译器强制） |

**测试**：`prediction-data.test.ts`（包络窗口 + 缺测语义 + `explainability`）、
`prediction-recovery-read-repository.test.ts`（raw 溯源）、`ModelRegression.swift:162-200`（预测 DTO fixture，
含"缺测 readiness 不被填 0"）。

### 批 D —— 文档（10 份未跟踪）

`IOS_MODEL_AUDIT_2026-09-25.md`(253) · `IOS_MODEL_OPTIMIZATION_PLAN_2026-09-25.md`(466) ·
`IOS_MODEL_WALK_FORWARD_REVIEW_2026-09-25.md`(52) + `.json` · `IOS_PLAN_RACE_IMPLEMENTATION_2026-09-25.md`(69) ·
`IOS_PLAN_RACE_REVIEW_2026-09-25.md`(260) · `PROJECT_AUDIT_2026-09-24.md`(183) · `PROJECT_AUDIT_2026-09-26.md`(248) ·
`UNCOMMITTED_REVIEW_2026-09-25.md`(117) · **`IOS_MODEL_AUDIT_2026-09-25_副本.md`(重复，见 🟡-1)**

---

## 四、红线核对

| 检查 | 结果 | 证据 |
|---|---|---|
| 新写端点是否登记（两个集合互斥、纯 GET 不登记） | ✅ | `server.ts:287-288` 两条都在 `metadataOnlyMutationRoutes` ⇒ 50s LLM 生成不阻塞导入/重建 |
| 破坏性契约变更 | ✅ **无** | `api-contracts` 4 处全是 `?` 可选；`contracts` 的 `readiness` 是**类型变宽** |
| iOS 解码兼容 | ✅ | 新增字段全 Optional；`ModelRegression` 有 fixture 逐字段断言 |
| 业务钳制参数是否真接线 | ✅ | `previousWeekDistanceKm` 由 `server.ts:1048` 传入；`raceTarget` 传至 3 个调用点 |
| 测试是否随改动同步 | ✅ | 37 个已跟踪文件里 **12 个是测试**；iOS 门禁脚本同步纳入 `TechPlanView.swift` 并更新锚点（`run-tech-presentation-tests.sh:121-124`、`:187`） |
| 「搬迁 ≠ 删功能」 | ✅ | `TechViews.swift` `2688 → 2119` 行（`+35/−604`），`TechPlanView`+`TechPlanDaySheet` 整段移至新文件 `TechPlanView.swift:4/616` |
| 边界常量同源 | 🟡 **见 🟡-2** | `?? 30` 字面量 3 处未用既有常量 |
| 交付物卫生 | 🟡 **见 🟡-1** | `副本` 文件与正本 sha256 相同 |
| 新增 CLI 是否有测试 | 🟡 **见 🟡-4** | 仅 `README` 引用，无测试 |
| 安全门控是否被放宽 | ✅ | `mobileLockRejection`（`mobile-sync.ts:92-106`）仍只认 `syncStatus` + `expectedRevision`，未放宽 |

---

## 五、分级结论

### 🟡 待处理（4 条，均非阻断）

**🟡-1　重复文档（建议提交前删除）**
`deliverables/IOS_MODEL_AUDIT_2026-09-25_副本.md` 与 `IOS_MODEL_AUDIT_2026-09-25.md`
**SHA256 完全相同**（`633de19cfefd70…82fee0`，均为 17337 字节）⇒ 纯重复内容。
命令：`rm deliverables/IOS_MODEL_AUDIT_2026-09-25_副本.md`（未跟踪文件，不涉及 `git`）。

**🟡-2　周跑量兜底字面量未同源（建议顺手改）**
`DEFAULT_WEEKLY_DISTANCE_KM = 30` 定义在 `mobile-goals.ts:32`，但本次新增/改动处直接写死 `?? 30`：
- `data.ts:546`、`data.ts:556`、`mobile-read.ts:421`

含义：默认周跑量将来若调整，这三处会**静默漂移**。改动成本一行（改 import + 用常量）。
验收标准：`grep -rn "?? 30\b" apps/api/src/data.ts apps/api/src/mobile-read.ts` 返回空。

**🟡-3　手工计划校验在"读库不可用"时被跳过**
`server.ts:1209` 的条件是 `request.body.weekPlan !== undefined && databaseIsReady()`。
读库不可用时 `validateManualPlan` **不挂载**，此时 `weekPlan` 写入不受新增的三道校验保护。
这是**增强未全覆盖**（原先完全没有校验，非回归），但值得在文档或注释里写明。
另：`WeeklyPlanPreviews`（`weekly-plan-preview.ts:6`）是**进程内 Map** ⇒ 隐含单进程假设；
重启即失效（注释已声明）、多实例部署会静默退化为"预览已过期"。
验收标准：在部署文档中写明"preview/confirm 需粘性会话或单实例"。

**🟡-4　`data:prediction-walk-forward` 有 Node 门禁但无测试**
`package.json:67-68` 已有 `predata` 生命周期门禁（09-25 的 P1-1 真修 ✅），
但 `prediction-walk-forward-cli.ts` 在 `packages/application/test/` 与 `apps/api/test/` 中**零引用**（仅 `README.md:130`）。
属"手工分析工具"，不阻塞；若要闭环，最小成本是加一条"空库也能输出 `status` 且不抛"的测试。

### 🟡 观察（不作为提交阻断项，但需知情）

**🟡-5　`/v1/mobile/today` 的 `weekPlan` 未来日期已被改写为"执行版"**
`data.ts:508-516` 把未来日期替换为 `executableMobilePlan` 的结果（含比赛日留白、taper 降级、预算钳制），
而**编辑基线**是 `goals.weekPlan`（存库原值，`NativeAppModel` 的 `loadDraft()` 取 `native.goals.weekPlan`）。
⇒ 同一页面存在**两个来源**：非编辑态看执行版、编辑态看库版。
已确认差异**仅在有竞赛目标进入 taper/race_day、周预算被钳制、或库值与当前处方不一致时出现**，
其余情况两者一致（存库值本身就经过同一套 `validateWeeklyPlan`）。
这是**有意取舍**（`data.ts:530` 注释：export 永不替代锁定），不是缺陷；但用户可能问"为什么条上的距离和编辑页不一样"。

**🟡-6　`executableMobilePlan` 每次请求被算两遍（未实测开销）**
`mobileToday()` 内部调一次（`data.ts:508`），`mobileWorkoutPlan()` 又调一次（`data.ts:533`）。
每次内部会跑 `constrainUpcomingPlan` → 按自然周分组跑 `validateWeeklyPlan`。
**本轮未做性能实测**（按纪律：性能结论必须同条件实测，不得推断）。建议的实测方式：
干净 worktree 对照 `curl -w %{time_total}` 打 `/v1/mobile/today` 与 `/v1/mobile/workout-plan`。

### ✅ 通过项（明确列出做对的地方）

- **`preview` 幂等性有真防线**：`weekly-plan-preview.ts:19` 的 `item.committed` 让"确认成功但响应丢失后的重试"**不产生第二个 revision**，且 `server-runtime.test.ts` 有 HTTP 级断言。
- **竞赛策略是单一实现**：`applyRacePlanPolicy` 一处定义、生成/手工/导出三处调用，测试含**幂等性**断言（`weekly-plan-preview.test.ts` "race rule is idempotent"）。
- **门禁随搬迁同步**：`run-tech-presentation-tests.sh` 把 `TechPlanView.swift` 加入源清单、剥离注释、并把 `recentPlanExecution` 锚点从 `data.` 改为 `native.today?.` —— **没有留下"改了实现但门禁还在看旧文件"的缺口**。
- **契约层零破坏**：`api-contracts` 全部 `?` 可选，iOS `Codable` 新增字段全 Optional，且 `ModelRegression` 用**内联 JSON fixture** 逐字段断言（不是只测构造）。
- **"缺测不等于最差"是一致改动**：内核 ✓ / 报告 ✓ / 契约 ✓ / iOS ✓ / Web 文案 ✓（Web 那两处是 `Record<GuidanceCode,string>` 的**编译器强制**，不补即编译失败）。
- **安全门控未放宽**：relock 路径改动后，`mobileLockRejection` 仍要求 `syncStatus !== "failed"` 与 `expectedRevision === recommendationRevision`；且 `recommendationRevision` 新增 `candidate` 纳入哈希（`data.ts:488`），使判断与 UI 的 `relockSuggested` 同源。

---

## 六、提交建议（分组 + 验收 + 回滚）

**这批改动越过了 5 个公共文件**（`server.ts` / `schemas.ts` / `data.ts` / `mobile-read.ts` / `api-contracts`），
同一文件里躺着不同主题的 hunk ⇒ **需要 `git add -p`**，不能整文件 add。

| 组 | 提交信息建议 | 涉及 |
|---|---|---|
| 1 | `fix(api): 周课表改为预览-确认两阶段，避免一次点击覆盖既有分段` | `weekly-plan-preview.ts`、`server.ts`(preview/confirm/`mergePlanWindow` 相关 hunk)、`schemas.ts`、`weekly-plan-service.ts`、`api-contracts`(Preview)、`weekly-plan-preview.test.ts` |
| 2 | `feat(plan): 竞赛目标统一进入减量/比赛日策略（生成·手工·导出三处同源）` | `race-plan-policy.ts`、`local-date.ts`、`manual-plan-policy.ts`、`weekly-plan-validate.ts`、`mobile-goals.ts`、`mobile-coach.ts`、`mobile-read.ts`、`data.ts`、`server.ts`(其余 hunk) + 4 个测试 |
| 3 | `feat(prediction): 准备度缺测不再按 0 计分，并补溯源、可解释性与 walk-forward CLI` | `prediction-data.ts`、`prediction-report.ts`、`prediction-eval-cli.ts`、`prediction-walk-forward-cli.ts`、`contracts`、`storage-sqlite`×2、`api-contracts`(Explainability)、`apps/web`×2、`package.json`、`README.md` + 2 测试 |
| 4 | `feat(ios): 计划编辑/竞赛目标/预测状态适配两阶段课表与缺测语义` | `apps/ios/**`（含 `TechPlanView.swift`） |
| 5 | `docs(deliverables): 09-24~09-26 审查与方案文档` | 9 份新文档（**剔除重复的「副本」**） |

**验收标准（每组提交后）**：`npm run typecheck` + `npm test`（分 node 与 web 两段读数）+ `npm run test:ios`，
逐组 `EXIT=0`。⚠️ 按纪律：**"最终态全绿"≠"每个提交可用"** ⇒ 若在本地分组试跑，需按节点实跑，
不要只看最后一次全量。

**回滚方案**：全部为工作区改动，`git checkout -- <paths>` 即可整体还原；
新增的 8 个代码文件是未跟踪状态，`rm` 即撤销。**无 SQL 迁移、无破坏性契约变更**，
故不需要数据层回滚（`schema_migrations` 未被触碰）。

---

## 七、未覆盖与未实测（如实声明）

1. **本轮未重跑门禁** —— 沿用同日约 1 小时前**同一工作区**的实跑结果（业务代码逐字节未变，仅多一份 09-26 报告）。本轮只新鲜实测了 `typecheck`（EXIT 0）。
2. **未跑 `test:e2e:web` / `test:ios` / `rust:verify`** —— 同上，沿用。
3. **未做性能实测** —— 🟡-6 的重复计算开销**没有数字**，报告里不给结论。
4. **未做突变验证** —— 新增断言（如 preview 幂等、缺测语义）**未逐条改坏验证其会变红**。
5. **未上云机** —— 线上跑的是 `49c9ef9`，**不含这批改动**（HEAD 未 push）。
6. **真机行为未验证** —— HealthKit 后台同步、WorkoutKit 手表下发均为设备侧行为。
7. **模拟器视觉回归未跑** —— 且受上一轮已确认的 S-1 缺陷（`check-export-determinism-live.py` 源清单缺 `RouteSyncState.swift` + `RouteSyncStateMachine.swift`）阻塞。
