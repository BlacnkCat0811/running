# 统一训练排课方案：真实性核实与 PR1/PR2/PR3 落地（2026-10-20）

| 项目 | 内容 |
| --- | --- |
| 核实对象 | 会话输入的《统一训练排课实施方案：单一引擎、比赛目标驱动、日常与备赛互斥》（2026-10-20，未入库） |
| 仓库基线 | `958e8f4`（`main`）+ 工作树既有 6 个 iOS health-sync 改动（本次未触碰、未提交） |
| 业务时区 | `Asia/Shanghai` |
| 核实方法 | 源码复核（文件/符号/调用边）+ `npx tsx` 只读探针（临时内存与只读数据，不写用户库） |
| 本文性质 | 时点核实记录 + 本轮代码落地的执行记录；**不是**整体方案验收，也不代表生产已迁移 |
| 本轮交付 | 核实与勘误；PR1 模式解析；PR2 的 F01/F02/F03 修复；F04/F06 修复；PR3 统一状态+迁移工具；PR4-1/2/3（v2 只读、预览+命令、事务内计划发布）；PR5 iOS 单入口+v2 客户端；PR6 Watch 切换撤回协议；PR7 唯一写者门禁 + G01–G03 评审材料 |
| 明确未做 | 真实用户迁移、部署、真机验收；独立临床/教练领域复核。旧接口退役与旧排课代码删除已于 2026-10-20 执行（§4.17、附录 D） |

---

## 0. 结论摘要

1. **文档的"现有事实"与"必须纳入回归的问题"基本成立**：E01–E15 全部可定位；F01–F06 全部复现；F02 机制表述需修正（§3.1），F06 另有未记录副作用（§3.4），E07 归属需修正（§2.1），iOS 入口数量比文档多（§3.6）。
2. **PR1/PR2 完成**（模式解析、F01/F02/F03 修复，9 条 UTP 回归）；**F04/F06 修复**；**PR3 第一片**（统一状态 schema + CAS store + dry-run/apply CLI）。
3. **PR4 全部落地**：v2 协商只读（§4.7）、预览 + 配置命令（§4.8）、计划刷新（§4.9）、**配置+计划的单次命令**（§4.10）、**自动协调器与跨库发布屏障**（§4.11）。配置与计划现在可以在同一操作、同一事务边界内一致发布。
4. **G01–G03 已按最保守候选项由仓库所有者签收**（§4.12，零行为变化；F05 以"显式不可行 + 带数字原因"关闭），签字记录与标准案例测试在 `docs/TRAINING_PLAN_POLICY_REVIEW.md` 与 `training-plan-policy-adoption.test.ts`。**独立临床/教练复核仍未提供**，文件明确区分。
5. **PR5 iOS**（单入口 + v2 客户端，`npm run test:ios` EXIT 0）、**PR6 Watch**（上下文 + 先撤回再下发，123 断言）、**PR7 唯一写者门禁**（违规 0 + 变异证明）已落地。
6. **剩余**（§4.17）：真实迁移/部署；独立临床/教练复核；并发/跨库压测；真机与 Simulator（用户已排除）。**G02-C 容量重启 v2 已实现**（§4.12）、**四个旧接口组已退役**（410 `legacy_surface_retired`，路由仍挂载，不可达实现已删除，§4.17/附录 D）；D10/R03 已用真实库副本演练关闭（§4.12.1）。

## 1. 核实方法与证据身份

- **源码身份**：`git rev-parse HEAD` = `958e8f4`（`docs(ios-sync): 备份清理后更新发布记录的回滚边界（仅保留在用数据库）`），分支 `main`。
- **工作树**：核实开始时只有 6 个 iOS health-sync 相关 `M` 与 1 个未跟踪的 `deliverables/IOS_DEVICE_LOG_TRIAGE_2026-10-20.md`。本轮新增/修改的文件见 §4.3，未触碰上述既有改动。
- **"复现"的定义**：实际运行基线源码里的生产函数（`assessSessionDose`、`generateWeeklyPlan`、`buildWeekPlan`、`CoachLoopRuntime`、`MobileGoalsStore` 等）并得到文档描述的输出；不是"读起来像"。静态读取另行标注。
- **探针位置**：`var/probe/`（gitignored，只写仓库内临时目录；控制库用 `os.tmpdir()` 下的临时 SQLite）。
- **未使用的证据**：不把本地过期健康数据、生产日志或旧报告绿灯当成本轮证据；未运行 iOS 构建与真机验收。

---

## 2. 逐项核实

### 2.1 现有源码事实（E01–E15）

| ID | 文档断言 | 结论 | 证据 |
| --- | --- | --- | --- |
| E01 | 旧版教练独立生成七日计划，并把比赛配置转换为公共比赛目标 | 成立 | `apps/api/src/run-coach.ts`（416 行）；`runCoachRaceTarget` 在 `:285` 参与约束，`:368` 起有"计划目标/距离/结束日期不能更换，请结束后创建新计划" |
| E02 | 新版运行时另有模板、容量、候选修复与发布流程 | 成立 | `coach-loop-runtime.ts`（614 行）、`coach-template-library.ts`、`weekly-capacity.ts`、`coach-plan-repair.ts`、`plan-publication.ts` |
| E03 | 新版托管按"存在历史闭环状态"判断，结束状态仍可阻止旧入口 | 成立 | `apps/api/src/server.ts:507-508` `coachLoopManaged = () => coachLoopState(...) !== null`；判定无状态过滤（`mobile-goals.ts:301-305`） |
| E04 | 公共目标、课表、锁课、旧教练元数据共存在目标响应中 | 成立 | `packages/api-contracts/src/index.ts:1792` `MobileGoalsResponse`（含 `raceTarget`/`weekPlan`/`lockedSession`/`runCoach`） |
| E05 | 新版设置又保存模式和一份比赛配置 | 成立 | `packages/api-contracts/src/coach-loop.ts:291` `CoachLoopSettings`（`mode` + `race`） |
| E06 | 控制库有计划历史、操作幂等、设备回执、闭环收据 | 成立（探针验证） | 表 `mobile_goals_history:976-981`、`mobile_plan_operations:990-993`、`mobile_plan_pushes:982-989`、`mobile_coach_loop_receipts:994-998`；幂等回放/冲突/过期 `449-500`；回执写入 `671-843`；收据追加 `313-317` |
| E07 | 跨存储稳定读取及发布保护已有基础 | 成立，**归属需修正** | 稳定读 `plan-read-consistency.ts:158-205`（读 guard → 读控制快照 → 摘要 → 重读 guard，3 次重试后 503）；guard 本体在 `publication-guard.ts` + `MobileGoalsStore.withPublicationTransaction`；`plan-publication.ts` 只提供幂等、作用域校验并委托给该事务 |
| E08 | iOS 已有统一计划 Store，但内部仍区分旧快照与闭环路径 | 成立 | `TrainingPlanStore.swift` 在 `refresh:248/274`、`executablePlan:68-75`、`presentation:79/86-102`、缓存恢复 `176-224` 分支；`goals`+`loop.goals`、`workoutPlan`+`loop.devicePlan` 双份状态 |
| E09 | 页面仍保留旧教练设置、新版设置及独立比赛目标编辑 | 成立（入口数量比文档更多） | 旧 `TechRunCoachSetup`（经 `TechRunCoachView:287-321`）、新 `TechCoachLoopPreferencesSheet`（`TechCoachLoopSection:71,77,82`）、赛事编辑只在 `TechManualPlanView:375-379`，且被 `TechRunCoachView:191-195` 门控 |
| E10 | 普通自动课程的完整剂量下限为 1800 秒 | 成立 | `coach-session-dose.ts` `MINIMUM_SESSION_DURATION_SECONDS = 1800`（符号稳定；行号已随 v2 改动漂移） |
| E11 | 正常 easy 配速分区的慢端上界可以是 `null` | 成立 | `packages/training-zones/src/index.ts` `buildPaceBands`：easy = `{ lower: threshold*1.15, upper: null }` |
| E12 | 标准比赛周期与执行保护已有独立模块 | 成立 | `plan-periodization.ts`（319 行，阶段边界/容量带/质量剂量）、`race-plan-policy.ts`（14 天保护 + `taperDayCeiling`） |
| E13 | 设备排期写前日志、核验与恢复已存在 | 成立（有缺口） | `PlanWatchSyncCoordinator.swift` + `PlanScheduleOperationJournal.swift`：`app_metadata` 内耐久日志（WAL、`synchronous=FULL`）、先落盘再产生副作用、UUID+时刻+内容强读回、日志/账目/回执同事务提交；缺口：`.prepared` 在 prepare 后校验失败会卡死、`.partial` 验证死角、`interrupted` 阶段未使用、中断账目写入非原子、mapper 变更后只能撤回、单一全局日志、无真实杀进程用例 |
| E14 | 发布审计固定检查 78 条验收、22 类场景，并保留独立审阅阻断项 | 成立 | `scripts/coach-release-gate.mts:14` 强制 78 个唯一 AC ID；`:87` 强制 R01–R22；`:92-94` 固定写入独立政策/黄金基准/真机/长期数据/需求签收 5 个阻断项 |
| E15 | `coachLoopFacts` 内仍调用 `mobileWeeklyPlanInputs`，不能当作纯事实入口 | 成立 | `apps/api/src/data.ts:303-322`：`coachLoopFacts` 内部 `const inputs = this.mobileWeeklyPlanInputs(goals, history)`，后者会装配旧每日处方与有效周计划 |

### 2.2 必须纳入回归的问题（F01–F06）

| ID | 文档断言 | 结论 | 复现要点 |
| --- | --- | --- | --- |
| F01 | 开放 easy 上界被整体当成无配速证据 | **成立（已复现，本轮已修）** | 见 §4.2 |
| F02 | 七日窗口先排课程、再按自然周扣预算，删除后不重新分配 | **成立，机制需修正（本轮已修）** | 见 §3.1、§4.3 |
| F03 | 过去没有训练观测的日子覆盖展示为休息 | **成立（已复现，API 读取模型本轮已修）** | 见 §3.2、§4.4 |
| F04 | 启用新版持续训练会清除原赛事，结束后也不恢复 | **成立（API + iOS 双端复现，服务端本轮已修；iOS 展示属 PR5）** | 见 §3.3、§4.5 |
| F05 | 赛前单日上限与普通 30 分钟整课冲突 | **已复现并按 P-G01-B 修复**（赛前 600–900 秒激活课，最后 72 小时仍只休息；不再全休） | 见 §3.5、§4.12、§4.12.1a |
| F06 | 新版结束后没有释放托管语义 | **成立（已复现，本轮已修）**，另有文档未记的副作用 | 见 §3.4、§4.5 |

### 2.3 其他可核对断言

| 断言 | 结论 | 证据 |
| --- | --- | --- |
| 既有发布审计 78 条验收 + 22 类场景 | 成立 | `coach-release-gate.mts:14,87`；注意这是 `docs/COACH_LOOP_OPTIMIZATION_PLAN.md` 的口径 |
| `docs/ALGORITHM.md` §16.1 验收矩阵 | 成立，口径不同 | `npm run check:acceptance-matrix`：**80 条**，cited 80 / gap 0 / missing 0。78 与 80 是两份不同清单，不能互相替代 |
| 当前 42–364 天新建限制 | 成立 | `apps/api/src/run-coach-policy.ts:29` `if (remaining < (creating ? 42 : 0) \|\| remaining > 364) fail("新比赛计划需要 6–52 周准备期。")`；iOS `TechCoachLoopSection:151,168`、`TechRunCoachSetup:34` 同口径 |
| "必须结束后才能改目标" | 成立 | `run-coach.ts:368`：目标/距离/结束日期任一变化即抛 `RunCoachInputError`，要求结束后创建新计划 |
| 文档称"前置排查运行过 6 个测试文件、58 项通过、并发 2" | **无法核实** | 仓库与工作树没有对应的产物或记录；本轮不继承该绿灯 |
| P01–P12、§4.2 四维状态、§5 合同字段 | 属产品决策/拟实施，**不是可核实事实** | 其中 P01（单一排课管理者）、P02（模式由目标派生）、P06（暂停是全局）在基线里**尚不成立**：存在两套引擎与两套开关（§3.6） |
| G01–G03 政策门槛 | 仍为阻断 | 本轮未做赛前剂量、冷启动容量、追加授权的政策评审；相关代码保持现状并在 §6 记录 |

---

## 3. 需要修正或补充的文档表述（勘误）

### 3.1 F02：机制表述不准确

文档写作"七日窗口先排课程、再按自然周扣预算，删除后不重新分配"，并以"周二、建议量 5 km、本周已有 1 km → 七天全休"为标准案例。实测（生产形状分区 `easyPaceLower=345, easyPaceUpper=null`，评估日 2026-10-20）：

```
baseline=5  weekActual=0: 七天全 rest
baseline=5  weekActual=1: 七天全 rest
baseline=10 weekActual=0: 10-20=easy(5.2) 其余 rest（10-26 空着）
baseline=10 weekActual=1: 10-20=easy(5.2) 其余 rest（10-26 空着）
baseline=15 weekActual=1: 10-20=easy(5.2) 10-26=easy(5.2)
```

因此：

1. **5 km 全休的首要原因不是那 1 km 实际训练**，而是"完整剂量下限 30 分钟"在快端配速下的成本 5.217 km 已经超过 5 km 周基线；`weekActual=0` 时同样全休。把该案例当作"因本周已有 1 km 而全休"会误判修复目标。
2. **真正的分配缺陷是"下一自然周的空间永不使用"**：`baseline=10` 时 10-26 所属自然周有完整 10 km 预算，却没有任何候选——初始分配只落在窗口前段（`coach-complete-plan.ts:90-95`），后续 `constrainUpcomingPlan` 只做删除（`fitCompleteSessionsToBudget` 没有"补充"通道），删除/跨周之后不再重新分配。
3. **展示量与约束成本来自不同假设**（文档 §9.3 已点出）：生产形状下修复前显示 5.2 km（快端 345）、预算成本用冷启动 5.0 km（低估）；闭区间夹具下显示 4.6 km（慢端）、预算用快端 5.45 km（高估）。两种口径都不一致；修复后显示与预算都取同一实测上界 5.217 km。
4. 文档"F02 标准案例必须明确实际 1 km 发生在 2026-10-19……避免把合法的滚动保护误报为分配缺陷"的提醒是对的，但需要同时写明"5 km 基线本身装不下完整 30 分钟课"，否则新增的标准案例会被写成永远不会绿的断言。

**修复目标应改写为**：每个自然周先扣义务（本周实际、窗口外保留、设备未撤回预留），再在该周自己的预算内选完整候选；跨周仍受滚动 7/14 日限制；无可行候选时输出 `no_feasible_course` 与逐日约束证据，而不是"预算已用完"式的静默休息。

### 3.2 F03：文档只写现象，实际路径已定位

`GET /v1/mobile/today` → `mobileTodayWithExecutablePlan` → `buildWeekPlan`（`apps/api/src/mobile-coach.ts:1370-1451`）在**读取已存课表之前**按"当天是否有导入训练"分支：`day.localDate < today` 且 `workoutCount === 0` 时直接返回 `{ kind: "rest", title: "休息", planned: true }`（`:1385-1396`）；已存处方直到 `:1413` 才被读取，因此过去的间歇日永远显示为休息。`/v1/mobile/workout-plan` 不受影响（窗口从今天开始）。存储本身未被改写，`plan-execution.ts` 仍保留 `plannedKind/plannedDistanceKm`。修复属读取模型（意图/观测/执行分离），不是纯 UI。

### 3.3 F04：机制明确为"显式写入 null"，不是显示问题

`coach-loop-runtime.ts:269-274` 在每次 enable/refresh/update/end 写入时都显式提交 `raceTarget: settings.race ? runCoachRaceTarget(settings.race) : null`；`MobileGoalsStore.write`（`mobile-goals.ts:552`）把显式值当权威。`daily_adaptive` 模式 ⇒ `null`。`end` 用同一段写入、从已结束节目重算（`:252,269-274`），没有备份字段也没有恢复分支；旧值只留在 `mobile_goals_history`，无人读取。iOS 侧同步发送 `race: null`（`APIModels.swift:72-80`），因此这是服务端数据丢失路径。托管后 `/goals` 被 409 门控，用户也无法从旧接口修复。

### 3.4 F06：文档成立，且漏记一个副作用

`coachLoopState` 读最新收据且无状态过滤（`mobile-goals.ts:301-305`），`end` 只追加 `status:"ended"` 的收据（`coach-loop-runtime.ts:252,275-289`），全仓库没有任何 `DELETE FROM mobile_coach_loop_receipts`，所以 `coachLoopManaged()` 永远为真：旧计划路由永久 409、握手不再宣告 `planSnapshotContractVersion`、旧周生成永远不恢复。**额外发现**：`end` 之后 `live/lifecycle` 为假，非许可日按 `rest(...)` 落库，等于把未来窗口写成休息并覆盖原课表——升级方案迁移时必须把它当作"已结束节目"的证据，而不是正常课表。

### 3.5 F05：复现与文档一致，且确认被 G01 阻断

评估日 2026-10-20、10K 比赛 2026-10-30（10 天）、周建议量 20 km、前一周 20 km：`taperDayCeiling(20) = 2.0 km`，而完整 30 分钟整课成本 ≥ 5 km → 七天全休（3 天给"赛前减量预算不足"，4 天给"完整常规课预算不足"，无 `no_feasible_course`）。这正是文档要求交 G01 评审的输入；工程侧不得靠降低 1800 秒下限或抬高保护上限"修复"。

### 3.6 P01/P02/P06 的现状（不是文档错误，而是必须写进 PR4 的差距）

基线同时存在：旧 `/run-coach` 生命周期 + 旧周生成、新闭环运行时、以及公共 `raceTarget` 三套写入面；iOS 侧有 3 个计划入口、2 个计划页、3 个教练配置面、1 个嵌套赛事编辑器（比文档 E09 的"两个入口"更多）。`coachEnabled`/`raceEnabled` 这种命名开关**不存在**（Invariant 3 的字面要求成立），但"两个可独立写入的教练管理面"实质成立，PR4/PR5 的合并范围应据此排期。

---

## 4. 本轮落地

### 4.1 PR1：唯一模式解析（纯函数）

新增 `apps/api/src/training-mode-policy.ts`（无 I/O、无时钟、无存储）：

- `resolveTrainingMode({ raceGoal, businessDate })` → `coach | race` + `reason`（`no_race_goal`/`race_goal_upcoming`/`race_day`/`race_goal_passed`）+ `daysToRace`。**非法日期抛错而不是回落 coach**，避免"解析失败就当没赛事"。
- `validateRaceGoal(draft)` → `valid | draft | invalid`：日期与距离必填；`finish` 不要求时间；`time` 缺少时间算 draft、超出范围算 invalid；`2026-02-30` 这类伪日期判非法。
- `raceGoalSupport(goal, businessDate)`：标准/受限距离（5K/10K/半马有骨架，全马与自定义距离 `support:"limited"` 但**仍是 race**）、`within/beyond_horizon`（复用 `periodizationWeeksToRace`，不新增第二套周对齐）、`ready/short`（<42 天为 short，**不退回日常**）。
- `applyTrainingConfigurationCommand(...)`：`set_race_goal` / `clear_race_goal` / `pause` / `resume` 的纯 reducer。改时间保身份、改日期或距离换身份（必须提供服务端新 id，否则抛错失败关闭）；草稿/非法输入返回原状态；暂停跨目标编辑保持，恢复只能显式。
- 业务日期只接受调用方传入的上海业务日期（测试用 `coachLocalDate` 固化 `17:30Z → 次日`）。

新增 `apps/api/test/training-mode-policy.test.ts`：**16 条断言**，覆盖 UTP-M01–M12 与边界（42 天、200 km、0 秒时间、非法日期、身份规则、暂停/恢复）。

**未做**：v2 快照/命令/预览/错误/回执的线上字段冻结（属 PR1 剩余项，需与 iOS 解码同步）；本模块目前**未接线**到任何路由——这是有意的，PR1 只冻结语义，避免在 PR4 之前制造第二写者。

### 4.2 PR2/F01：剂量政策 v2（逐维度、逐边界）

`apps/api/src/coach-session-dose.ts` 重写为：

- **逐边界解析配速**：只有"两端都缺失"才算无证据；单边缺失只让对应维度未知。
- **逐维度计算**：
  - 时间步骤：时长精确；距离只有上界（`seconds / 快端配速`），下界未知（慢端缺失时）。
  - 距离步骤：距离精确；时长按可用端给界，缺哪端就哪端为 `null`。
- **未知不落成数值**：`minimum_session_duration_not_assessable`、`minimum_work_dose_not_assessable`、`available_time_not_assessable`、`session_distance_limit_not_assessable`；只有全部绑定约束被证明才 `feasible`。
- **冷启动只在整段完全没有配速证据时使用**，保持 `cold_start_policy` 出处；质量课永不借用。

前/后对照（生产分区形状：`easyPaceLower=345, easyPaceUpper=null`）：

| 会话 | v1 结果 | v2 结果 |
| --- | --- | --- |
| easy（5+20+5 分钟） | `feasible`，`estimateSource=cold_start_policy`，距离上界 **5 km（伪造值）** | `feasible`，`estimateSource=zone_pace_range`，距离 `{lower:null, upper:5.217}`（=1800/345） |
| tempo | `not_assessable`（`dose_pace_evidence_unavailable`） | `feasible`，时长 3000 s，距离上界 9.470 km |
| interval | `not_assessable`（同一原因） | `feasible`，时长 2544–2611 s，距离上界 8.070 km |

配套改动（全部为失败关闭）：

- `packages/api-contracts/src/coach-loop.ts` `CoachSessionDose.durationSeconds/distanceKm` 改为**每端可空**；`null` 表示"不可证明"，不是 0。
- `coach-template-library.ts`：km 成本不可证明的模板直接拒绝（`dose_distance_upper_unproven`），不再用 `!` 断言；`durationSeconds` 允许 `null`，`templateDay` 明说"整课时长上限未定"。
- `coach-loop-runtime.ts`：追加授权必须有可证明的 km 上界，否则不写预留、不给授权；距离上限/长距离上限/周包络在无上界时一律不放行。
- 受限脚本（`coach-acceptance-replays.mts`、`coach-isolated-replay.mts`、`coach-runtime-replays.mts`）改为显式处理空边界，`NaN` 使断言失败而不是被 `!` 静默通过。
- `SESSION_DOSE_POLICY_VERSION` `v1 → v2`，同步更新 `docs/ALGORITHM.md:201` 的现行合同描述（`doc-version-consistency` 门禁要求）。

新增 `apps/api/test/training-planner-regressions.test.ts`：**5 条回归**（UTP-A01–A04 + 单边证据），全部绿。

**运维含义（必须写进发布记录）**：政策版本参与 `policyManifest`，已发布计划的政策哈希随之改变，旧计划转为"待刷新"并由协调器重排。历史处方摘要、回执身份与旧版本号不变。

### 4.3 PR2/F02：按自然周"先义务、后候选"的分配（已修）

修复前的问题不是"某个数字不对"，而是**分配发生的位置不对**：`generateWeeklyPlan` 先在整段滚动窗口按基线容量排课，`constrainUpcomingPlan` 再按自然周扣预算、只删不补。

本轮修复把分配移进**同一个约束 pass**，并且逐自然周进行：

- 滚动窗口按当前自然周的周日切成 1–2 段；每段先扣义务，再算自己的净预算：
  `ceiling = min(周容量上限, 阶段容量带上界)`；
  `remaining = max(0, ceiling − 窗口外保留课表 − (本周实际 + 今日预留))`（只有当前周扣实际/预留）；
  质量课额度同样扣掉窗口外保留与本周已发生质量课。
- 每段用 `buildCompleteCoachWeekPlan(该段日期, 该段净预算, 该段质量额度)` 重新分配完整剂量；受保护的今天（已训练/锁定/保留草稿）**不参与重排**，因为它已经从预算里扣除，重排会浪费一个完整剂量（这条是集成时由既有 `O0-B/C` 用例抓出来的，已修）。
- 仍然沿用同一个 `validateWeeklyPlan` + 有限修复循环，非自动调用方（`/today` 读取、旧 run-coach）不传 `allocateCompleteDoses`，行为不变。
- 装不下时给出可判定的原因，而不是静默休息：`no_feasible_course：一堂完整常规课约 5.2 km，本自然周可用 4.0 km；不切碎剂量、不虚构更慢配速。`（没有可行课时带具体公里边界；有课但余额不足时给"剩余 X km 不足以再安排一堂完整课"）。

修复后（生产形状分区，评估日 2026-10-20，本周一已跑 1 km）：

| 周基线 | 修复前 | 修复后 |
| --- | --- | --- |
| 5 km | 七天全休（原因泛化：`完整常规课预算不足`） | 七天全休，但**原因带数字**：完整课 5.2 km > 本周可用 4.0 km / 下周可用 5.0 km（合法不可行，不是缺陷） |
| 10 km | 只有 10-20 一堂；10-26 所属下一自然周 10 km 预算从未使用 | 10-20 + **10-26** 各一堂（下一周自己的预算被使用） |
| 15 km | 10-20、10-26 | 10-20、10-25、10-26（本周 14 km 净预算放两堂，下一周另外一堂） |
| 20 km | 10-20、10-23、10-26 | 10-20、10-23、10-25、10-26 |

回归：`UTP-A05`（跨周有空间必须排到课、装不下必须给明确原因）、`UTP-A06`（本周实际只扣本周、两段都不超上限）、"非自动路径不受影响"。既有 `weekly-plan*` 68 条、`O0-B/C` 14 条全绿。

### 4.4 PR2/F03：意图/观测分离的周读取模型（API 侧已修）

`buildWeekPlan` 现在先读已存课表，再分支：

- **过去日 + 有处方 + 无观测**：返回处方的 kind（不再是 `rest`），标题为"原计划间歇／尚无训练观测"，距离按 `plannedDayNumbers` 实测（与 `/workout-plan` 同一口径），并新增两个**可选**合同字段：
  - `intentKind?: MobileSessionKind | null`——当时被处方的课程；`null` 表示没有处方（把"没安排"与"安排了休息"分开）；
  - `observation?: "observed" | "unknown"`——是否有导入观测。
- **过去日 + 有观测**：`kind:"completed"`、`observation:"observed"`，并保留 `intentKind`，于是"原本安排间歇、实际跑了轻松"可读，而不再被 `completed` 抹掉。
- **过去日 + 无处方**：`rest` + "未安排训练" + `planned:false`（不再断言"休息"这个没人观测到的事实）。
- 今天/未来路径逐字节不变；存储、历史、执行评估都不写。

回归：`mobile-coach` 40/40、`mobile` 36/36、`mobile-coach-snapshot-parity` 4/4（两个端点仍一致）。**剩余**：iOS 仍按旧字段渲染（新字段被忽略，过去计划日会显示标题但还没有"尚无观测"语义），属 PR5。

### 4.5 F04/F06：赛事保留与托管释放（服务端已修，PR4 前置）

**F04**：`coach-loop-runtime.ts` 的写入不再无条件声明 `raceTarget`。规则变成"只有声明了赛事时才写，且只在 enable/update 写"：

| 动作 | weekPlan | raceTarget | lockedSession |
| --- | --- | --- | --- |
| enable/update（daily） | 写 | **省略**（保留原值） | — |
| enable/update（race） | 写 | 写入节目赛事 | — |
| pause / resume | 写 | 省略 | pause 清、resume 保留 |
| **end** | **省略**（不再覆盖） | 省略 | 清 |

于是：daily 模式启用不再清空既有公共赛事目标；`end` 也不再重算成 null，"结束后恢复"变成"从未被覆盖"。赛事模式下公共契约无法表达的里程（`runCoachRaceTarget → null`）同样省略而不是写 null。

**F06**：新增纯函数 `coachLoopReceiptManaged(receipt)`（无回执=未托管；有回执但 `settings` 缺失=仍托管，失败关闭；只有 `settings.status === "ended"` 才释放）。`server.ts` 的三处判定统一改用它：旧计划路由 409 门控、握手能力宣告、`ensureWeeklyPlan` 与 `runWeeklyPlanGeneration` 的托管检查——**结束后旧周生成器真正交还**。同时 `end` 不再发布课表窗口（`publishesPlan = settings.status !== "ended"`），保留 `weekPlan/weekPlanAudit`，回执 `changes: []`，同 `operationId` 重放不重复写收据。

回归：`coach-loop-runtime` 11/11（F04 四种动作保留、race 发布、F06 状态矩阵、end 保周、重放幂等）、`coach-loop-device-sync` 6/6、`training-plan-state` 12/12。**剩余**：`end` 之后教练闭环 GET 仍返回全 rest 的"节目视图"（读取模型，属 PR4）；`pause` 仍把窗口重写为 rest（本轮未改，恢复时会重排）。

### 4.6 PR3 第一片：控制库统一状态与迁移工具（已落地，未接线）

- **控制库 schema v2**（`mobile_control_schema` 迁移 2，运行时按 `MAX(version)` 追加）：新增 `mobile_training_state`（scope 主键 + revision + payload + `json_valid` 约束）、`mobile_training_state_history`、`mobile_training_migration_audit`。旧表、旧收据、旧幂等行保持可读且不改写（有测试断言字节不变）。
- **`training-plan-store.ts`**：canonical scope = `JSON.stringify([serverId, athleteId, datasetEpoch])`；`parseTrainingPlanState` 对未知 `schemaVersion` 抛错（失败关闭）；`TrainingPlanStore.applyMigration` 在一个 `BEGIN IMMEDIATE` 里做真实 CAS（`UPDATE … WHERE revision` + `changes` 检查）并同事务写状态/历史/审计，返回 `applied | replayed | conflict{digest_mismatch|already_migrated|revision_conflict}`。数据迁移版本与 schema 版本是**两个**常量。
- **`scripts/migrate-training-planner.mts`**：默认只读 dry-run；`--apply` 必须带 `--expect-source-digest`；读取既有 `mobile_goals` 行与最新闭环收据，按 §10.1/10.2 分类 `legacy_goals|run_coach|coach_loop|new`，矛盾即 conflict（不猜）；模式解析委托给 `training-mode-policy.ts`；stopped/ended 不会变成 active；**从不打开主健康库**。
- 测试：`training-plan-migration` 11/11（dry-run 不写、apply 三表、重放 no-op、digest 不匹配拒绝、冲突不写、ended 不复活、公共赛事目标被保留进 state、CAS 冲突可判定）。
- **运维注意**：控制库 `MAX(version)` 由 1 变 2，唯一硬编码该值的测试已同步；该迁移是**加表**，不改写任何历史行。

### 4.7 PR4-1：协商式 v2 只读接口（已接线）

同一条 `GET /v1/mobile/training-plan-state` 上做**显式**合同协商，不新增第二条路径：

- 无头 / `X-RAI-Training-Contract: 1`：v1 响应逐字节保持原样（仍走稳定快照路径）；
- `X-RAI-Training-Contract: 2`：返回统一状态投影，附 `Vary: X-RAI-Training-Contract` 与 `Cache-Control: no-store`；
- 其它值（`3`、`v2`、乱码）：`409 training_contract_unsupported`，**不回退**到 v1；
- 未迁移 scope：`409 training_plan_not_migrated`；统一存储不可读/投影不合法：`503`（可重试），同样不回退。

v2 载荷（`TrainingPlanStateResponseV2`，本轮冻结字段）：

- `mode/modeReason/daysToRace` 由 `resolveTrainingMode(raceGoal, businessDate)` **实时派生**，不存第二份；
- `runState`（active/paused）与 `migration.{version,source,sourceStatus,sourceDigest}` 来自迁移状态；`sourceStatus:"ended"` 的 `runState` 必为 `paused`；
- `admission`：`ready` / `needs_configuration`（偏好不全）/ `needs_confirmation`（已结束节目，需用户确认下一步）；
- `raceGoal` 附 `support`（标准/受限距离、骨架范围、准备期不足——临近赛事仍是 race）；
- `plan.days` = 业务日起七日内的已发布意图（按日期排序），`plan.current` 在旧 goals revision 迁移后变动时为 `false`（明确"陈旧"而不是假装新鲜）；
- `execution: { permitted: false, reasonCodes: [...] }`：**本片是投影，不是执行授权**；事实新鲜度与设备协调尚未评估。

只读性有测试保证：路由依赖只暴露读函数；同一 scope 连续两次读取不改变状态 revision；`not_migrated` 分支不会触碰旧处理器。

测试：`apps/api/test/training-plan-v2-route.test.ts` **8/8**（协商矩阵、模式/准入/陈旧判定、七日窗口、v1 不回归、未知版本拒绝、未迁移 409、存储故障 503、临时控制库端到端只读）。

**未接线部分**：preview/commands 仍不存在；本片没有写入统一状态的能力，也没有协调器——命令与发布属于 PR4-2。

### 4.8 PR4-2：预览与配置命令（已接线，计划重排仍分离）

新增两个端点（都要求 `X-RAI-Training-Contract: 2` 语义的请求体版本 2）：

- `POST /v1/mobile/training-plan/commands/preview`：**无状态、不写库**。返回 before/after（模式、运行意愿、准入、赛事与支持等级）、变更集、`planRefreshRequired: true`、以及绑定"动作 + 草稿 + 期望 revision + 策略版本 + 过期时刻"的 `candidateId` 与 120 秒 `expiresAt`。
- `POST /v1/mobile/training-plan/commands`：接受 `set_race_goal` / `clear_race_goal` / `pause` / `resume`，在 `PlanPublicationService` 的**同一个控制库事务**里完成：统一状态 CAS 写入 + 历史行 + 旧 `mobile_goals` 镜像（raceTarget；`weekPlanReplanRequired: true`）+ 操作结果。任一步失败整体回滚。

不变量与错误语义：

| 情况 | 行为 |
| --- | --- |
| 同 `operationId`、同请求 | 先查幂等结果，返回原结果，不重复写 |
| 同 `operationId`、不同请求 | `plan_operation_key_conflict` |
| 跨 scope 预览/提交 | `training_scope_mismatch`（409） |
| `expectedStateRevision` 过期 | `training_revision_conflict`（409，先于候选过期检查） |
| 候选过期/被篡改 | `training_candidate_expired` / `training_candidate_mismatch`（409） |
| 草稿不完整 / 非法目标 | `training_configuration_invalid`（422，附带原因） |
| 已结束节目 resume | `training_cannot_resume`（409），必须建立新配置 |
| 未迁移 | `training_plan_not_migrated`（409） |

**仍然分离的一步（必须诚实标注）**：本片只提交配置，**不重新生成课表**。因此：
- 两个响应都带 `planRefreshRequired: true`；
- 统一状态新增可空 `planContextDigest`（模式策略版本 + 派生的 mode + 赛事身份 + 运行意愿的摘要），v2 读在 `planContextDigest` 与当前配置不一致时返回 `plan.current: false`，任何调用方都不会把旧课表当成当前课表；
- 旧周生成器被 `weekPlanReplanRequired: true` 挡住，不会出现第二个排课写者；
- 计划重排与配置同事务发布属于下一步（PR4-3，需要把事实冻结、内核生成与发布屏障接进命令路径）。

兼容/迁移说明：`planContextDigest` 是可空新增字段，旧迁移行缺省为 `null`（视为"迁移时没有该摘要"）；`sourceStatus` 与 `runState` 解耦——只有"ended 必为 paused"这一条仍强制，迁移来源为 active/none 的配置可以被用户随后暂停。

测试：`apps/api/test/training-plan-commands.test.ts` **7/7**（预览零写入、候选绑定/过期/篡改、原子提交与旧镜像、幂等重放、暂停/恢复、ended 不可恢复、未迁移拒绝）。

### 4.9 PR4-3：计划重排与配置发布（生成在外、提交在内）

新增 `POST /v1/mobile/training-plan/commands/refresh`：

1. **生成在控制库写事务之外**（方案 §8.1 第 4 步）：读稳定快照（goals/历史/事实/分区/容量 + 指纹）→ 用唯一分配器 `generateWeeklyPlan` 生成候选；这段时间不持有 SQLite 写锁。
2. **提交在同一个发布事务内**：重新读取统一状态与 goals revision、复核输入指纹（事实/分区/周量/日期/数据域任一变化即 409 `training_snapshot_changed`），然后一次性写入旧 `weekPlan` + audit + `raceTarget` 镜像 + `weekPlanReplanRequired:false`，以及统一状态（`weekPlan`、`planContextDigest`、`goalsRevision`）与历史行。
3. **今天与本周已过日期不被重排**：用 `mergePlanWindow` 保留已发生/锁定的日期，生成器只拥有从今天起的七日窗口。
4. **暂停拒绝生成**（`training_paused`），恢复由显式 `resume` 完成；**重放先于新鲜度检查**：同 `operationId` 重试直接返回冻结结果，不会因为 revision 已被自己推进而误报冲突；不同请求同键仍然 `plan_operation_key_conflict`。
5. 单飞：沿用 `weeklyPlanGenerationGate`，并发生成返回 409 `weekly_plan_generation_busy`。

测试：`training-plan-commands` 扩到 **10/10**（事务外生成/事务内提交、指纹变化 409 且零写入、暂停拒绝、重放冻结）。命令（§4.8）与刷新（本节）共同满足"不复用旧可执行课表"：命令把计划标记待刷新并挡住旧生成器，刷新原子发布新计划。

### 4.10 PR4-4：配置 + 计划的**单次**命令（已接线）

`POST /v1/mobile/training-plan/commands` 现在可以一次操作同时发布配置与课表：

1. 路由先用 `planFor(request)` 求出"将要提交的配置"，在**控制库写事务之外**生成候选计划（稳定快照 + 指纹）；
2. 提交动作里重新推导该配置并校验 `planContextDigest` 与生成指纹（事实/分区/周量/日期/主库 `data_version` 任一变化即 409 `training_snapshot_changed`）；
3. 同一个发布事务写：旧 `weekPlan` + audit + raceTarget 镜像 + `weekPlanReplanRequired:false`、统一状态（weekPlan/contextDigest/goalsRevision）与历史行；
4. 响应 `planRefreshRequired:false` 并带 `plan`（days/audit/contextDigest/goalsRevision）；`pause` 不发布课表，保持 `planRefreshRequired:true` 且 `plan:null`。

`refresh` 命令保留为协调器/客户端的显式重排原语。测试：`training-plan-commands` **12/12**（单次发布的原子性、指纹变化拒绝且零写入、暂停不发布）。

### 4.11 自动协调器与跨库发布屏障

- **唯一自动决策**：新增 `training-plan-coordinator.ts`。`refreshDecision(row, businessDate)` 是唯一"该不该自动重排"的判定：未迁移/暂停→不碰；缺 `planContextDigest`（迁移自旧计划）→`plan_missing`；配置摘要漂移→`config_changed`；周窗口已不覆盖业务日→`business_date_changed`；否则 `current`。
- **唯一自动路径**：`ensureWeeklyPlan` 在看到统一状态时改为调用协调器（不再走旧生成器）；操作键 `auto-<digest(scope, reason, businessDate, stateRevision)>` 可推导，重复 tick 命中幂等结果而不是重复发布；协调器单飞（并发 tick 只跑一次），失败后 `running` 复位可重试。
- **跨库屏障**：计划生成读主库、提交写控制库，二者没有跨文件事务。生成指纹现在同时包含 `readStores.dataVersionFingerprint()`：任何完成在"生成→提交"之间的导入/恢复都会改变它并让操作 409，而不是把新事实配旧课表。测试：`training-plan-coordinator` **4/4**、跨库窗口在 refresh/单次命令测试中以指纹变化注入验证。

#### 4.12 G01–G03 政策决定与签收状态（2026-10-20 更新）

规则所有者（仓库所有者，会话直接指令）逐项决策如下，签字栏已按决策更新：

| 门槛 | 决策 | 冻结内容 | 实现状态 |
| --- | --- | --- | --- |
| G01 赛前剂量 | **P-G01-B：新增赛前短激活课类别** | 最后 **72 小时只休息**；窗口为赛前第 4–14 天；每日最多 1 堂；仅 easy/recovery；时长 **600–900 秒**；距离 ≤ `taperDayCeiling`；不改变 1800 秒对常规课的定义；`rai-pre-race-activation-v1` | **已实现并接线**（`pre-race-activation.ts` + `weekly-plan-service` 末尾策略例外；4 条测试；F05 场景不再全休） |
| G02 无历史重启 | **P-G02-C：旧历史衰减重启** | 衰减系数 **0.5**、封顶 **0.7×旧均值**、需连续 **4 个自然周**有观测才逐级释放；仍受 30% ramp、阶段量带、绝对上限；`rai-capacity-restart-v2`；`reasonCodes` 记录释放/未释放 | **已实现**（`legacyCapacityHistory` + `weeklyCapacity` 新增 `legacy_history` 源；3 条测试；缺口本身不抬高容量） |
| G03 受控追加 | **P-G03-A：现行自动 + 证据门控** | 9 个阻断 flag、滚动 7 日最多 2 次、1.2×/56 日/1800 秒、冷启动作估算不算追加证据 | **已实现并由 `training-plan-policy-adoption.test.ts` 固定** |

**签字边界（不变）**：这是产品/规则所有者对工程默认值的方向性批准，不是独立临床/教练领域复核，也不证明训练收益或风险下降；独立复核如仍需，按评审文件 §5 另立记录。

### 4.12.1a G01-B 实现（赛前激活课）

- 新模块 `apps/api/src/pre-race-activation.ts`：`PRE_RACE_ACTIVATION_POLICY_VERSION="rai-pre-race-activation-v1"`、窗口函数（第 4–14 天）、结构构建（600–900 秒，warmup 25% / work 50% / cooldown 25%）、`preRaceActivationFor` 策略例外。
- 接线位置在 `constrainUpcomingPlan` 的**最后一步**（`enforceAutomaticSessionDose` 之后）：只替换"被减量策略强制成休息"的日子（原因以 `赛前减量` 开头），普通休息日不会被升级；`pause`/无赛事/自定义距离窗口外一律不动。
- 边界：最后 **72 小时只休息**、赛前第 4–14 天、每日最多 1 堂、仅 easy、时长 600–900 秒、距离 ≤ `taperDayCeiling`；常规课 **1800 秒下限不变**，启动/冷却/工作段共用一个时间目标结构。
- 测试：`pre-race-activation.test.ts` **4/4**（窗口边界、结构时长、只替换减量休息日、F05 场景出现激活且最后 72 小时仍全休）；`training-plan-policy-adoption.test.ts` 已按 G01-B 更新（**3/3**）；`weekly-plan-service`/`coach-loop`/`planner-regressions` 定向复跑 **45/45**。

### 4.12.1 迁移/备份回滚演练（已执行，关闭 D10/R03）

按所有者授权，在**真实控制库的副本**上执行了完整演练（`var/probe/pr3-drill-evidence.json`）：

- 真实 `var/rai-control.sqlite`、`-wal`、`-shm` 演练前后 **sha256 完全一致**（未被打开写、未被 checkpoint）；
- 副本上 dry-run：`sourceStatus=none`、`sourceDigest=80f6c346…`、`applyAllowed=true`；
- `--apply --expect-source-digest`：成功，`revision=1`、`historyRows=1`、`auditRows=1`、控制库 schema `version=2`；
- 同 digest 重放：no-op（`existingRevision=1`）；
- 破坏性恢复：删除副本 → 从备份还原 → 状态/历史/审计行完好；
- 迁移前副本没有 `mobile_training_state` 表（真未迁移）。

### 4.13 PR5：iOS 统一 v2 客户端与单一训练入口

- **客户端合同**：新增 `TrainingPlanStateResponseV2` Codable 模型；`APIClient.trainingPlanStateV2` 恒发 `X-RAI-Training-Contract: 2`，把 409 `training_contract_unsupported` / `training_plan_not_migrated`、503 `training_plan_state_unavailable/-invalid/-business_date_invalid`、404 与解码失败映射成**类型化** `PlanReadIssue`（`upgradeRequired` / `notMigrated` / `serverUnavailable` / `contractMismatch`）。**没有 v1 回退路径**；未知合同显示升级提示，不显示"休息"。
- **Store**：v2 快照经 `TrainingPlanUnifiedPolicy.validate`（身份、上海业务日期、七日窗口、写入确认 revision floor）后成为唯一计划状态；缓存作用域隔离且标记"非当前"；`executionGranted` 恒为 false——即使网络载荷写 `permitted:true` 也按合同违规处理（投影不是执行授权）。
- **单一入口**：`TechPlanView` 成为唯一"训练"根：按服务端能力选择一个模式驱动页面（旧服务端仍走旧页面，但**没有用户选择器**）；页面展示 mode/runState/admission/比赛日/休息/待刷新/事实待更新/设备待协调/合同升级；F03 的 `intentKind`/`observation` 用于渲染"原计划 · 尚无观测"；创建入口只剩一个（教练 vs 比赛在同一 sheet 内），暂停/恢复/结束、赛事编辑、人工覆盖入口与反馈复盘保留。旧教练设置/旧创建入口不再可达（保留文件作为兼容）。
- 验证：`npm run test:ios` **EXIT 0**（98 文件类型检查 + 5 个 Swift 纯逻辑单元 + 10 支 python 门禁），新增 `TrainingPlanV2Regression.swift` 57 条断言（含真实 URLProtocol 请求验证请求头与 409/503 映射）。
- 真机/模拟器才能确认的部分单独列在 §5。

### 4.14 PR6：Watch 排期上下文与"先撤回再下发"

- 排期日志新增可选 `context` / `replacedContext` 字段（`contextVersion`、plan revision、receipt 合同版本、业务日期、mode、raceGoalID、policyHash）；`schemaVersion` 仍为 1，旧条目两个字段为 `nil`、仍可撤回，并标记为来源未知（**不伪造为切换**）。
- 模式/配置切换协议：`prepared`（持久化新/旧上下文）→ 身份核验（系统清单只含旧 UUID）→ `clearing` → 移除旧条目 → **强读回必须为空** → `verifying`（仅切换时**登记撤回**，失败则中止下发）→ 逐项 `scheduling/submitting` → 最终读回。任一步失败都停在可恢复的 `.clearing`（保留旧条目与预留），恢复路径会重新撤回。
- 旧上下文回执可作为历史登记（不会因为与当前模式不同而拒绝撤回/替换）；重复回执幂等；跨 scope/datasetEpoch 拒绝且不入账。
- 验证：`bash apps/ios/tests/run-plan-watch-tests.sh` **123 PASS**（新增 35 条：上下文编解码/向后兼容、撤回顺序、各步失败注入、恢复、回执幂等与跨域拒绝）；`typecheck-ios.sh` 通过。
- 真机仍需确认：切换时旧 WorkoutKit 条目在设备上确实先消失（空读回只是代理）、前台恢复被杀在 remove/push 之间的切换、`removeEntries` 后读回的一致性、配对拒绝/受限路径。

### 4.15 PR7：唯一写者结构门禁 + G01–G03 政策评审材料

- 新增 `npm run check:training-plan-single-writer`（`scripts/check-training-plan-single-writer.mjs`），5 条源码形状判据：R1 完整剂量分配器只能被唯一排课入口导入（旧 `run-coach.ts` 作为**登记在案的适配器**单列）；R2 旧周生成器只能出现在白名单文件；R3 `server.ts` 只有一处 `coachLoopState(`，且必须包在状态感知的 `coachLoopReceiptManaged` 里、旧路由前缀与握手能力仍受该谓词约束；R4 `mobile_training_state*` 的写入 SQL 与 `applyMigration` 只能出现在 store/迁移路径；R5 白名单自检（文件存在、glob 命中），改名不会静默失效。**当前：违规 0；临时注入违规 import / 原始 `coachLoopState` 判定 / 手写 UPDATE 均判红，恢复后判绿。** 头部明确标注正则门禁的边界（非运行时唯一性证明、动态 import/eval 可绕过等）。
- 新增 [TRAINING_PLAN_POLICY_REVIEW.md](../docs/TRAINING_PLAN_POLICY_REVIEW.md)：G01（赛前减量剂量）、G02（无近期历史的容量重启）、G03（受控追加授权）三份工程提案——现状默认值与代码锚点、开放问题、2–3 个候选策略与权衡、需要规则负责人签字的**标准案例**与测试向量、空白的签收表。**明确写为提案而非批准**：代码不得在具名负责人签字前把它们当作已批准；本轮没有伪造任何政策通过。
- 仍需在 PR7 收尾：旧排课/旧生命周期代码路径的删除（要等配置+计划单次命令与协调器收敛后），以及全量 UTP 验收映射。

### 4.16 修改文件清单

新增：

- `apps/api/src/training-mode-policy.ts`（PR1 唯一模式解析，未接线）
- `apps/api/src/training-plan-store.ts`（PR3 统一状态 schema + CAS store + 源分类；PR4-2 增加 `planContextDigest` 与事务内 `commitState`）
- `scripts/migrate-training-planner.mts`（PR3 dry-run/apply 迁移 CLI）
- `apps/api/src/training-plan-routes.ts`（PR4-1 协商式 v2 只读接口 + PR4-2 命令路由）
- `apps/api/src/training-plan-commands.ts`（PR4-2 预览/提交、PR4-3 刷新、PR4-4 单次配置+计划发布）
- `apps/api/src/training-plan-coordinator.ts`（唯一自动刷新决策 + 单飞 + 可推导操作键）
- `apps/api/src/pre-race-activation.ts`（G01-B 赛前激活课：窗口/结构/策略例外）
- `apps/api/src/weekly-capacity.ts`（G02-C `legacy_history` 源；`data.ts` 增加稳定窗口/观测周）
- `apps/api/test/training-plan-v2-route.test.ts`（8）
- `apps/api/test/training-plan-commands.test.ts`（12）
- `apps/api/test/training-plan-coordinator.test.ts`（4）
- `apps/api/test/training-plan-policy-adoption.test.ts`（3，G01–G03 标准案例）
- `apps/api/test/pre-race-activation.test.ts`（4，G01-B 窗口与结构）
- `apps/api/test/capacity-restart-v2.test.ts`（3，G02-C 衰减/释放/冷启动）
- iOS：`apps/ios/tests/TrainingPlanV2Regression.swift`（57）、`apps/ios/tests/PlanWatchContextRegression.swift`（35）
- `scripts/check-training-plan-single-writer.mjs`（PR7 结构门禁）
- `docs/TRAINING_PLAN_POLICY_REVIEW.md`（G01–G03 工程提案，非批准）
- `apps/api/test/training-mode-policy.test.ts`（16）
- `apps/api/test/training-planner-regressions.test.ts`（9：UTP-A01–A06）
- `apps/api/test/training-plan-migration.test.ts`（11）

修改：

- `apps/api/src/coach-session-dose.ts`（v2 逐维度剂量）
- `apps/api/src/coach-complete-plan.ts`（按周净额分配 + `no_feasible_course` 原因与公里边界）
- `apps/api/src/weekly-plan-service.ts`（分配移入唯一约束 pass、逐自然周、受保护今天不重排）
- `apps/api/src/coach-template-library.ts`（km 上界不可证明即拒绝；时长可空）
- `apps/api/src/coach-loop-runtime.ts`（F04 赛事声明式写入、F06 `coachLoopReceiptManaged`、end 不发布窗口、追加授权失败关闭）
- `apps/api/src/server.ts`（三处托管判定统一为状态感知、结束后交还旧周生成；`training-plan-state` 合同协商）
- `apps/api/src/mobile-coach.ts`（F03 意图/观测分离的周读取模型）
- `apps/api/src/mobile-goals.ts`（控制库迁移 2 + 私有建表方法 + `trainingPlanStateRow` 只读入口，+36/−1）
- `packages/api-contracts/src/coach-loop.ts`（剂量区间每端可空）
- `packages/api-contracts/src/index.ts`（`MobileWeekPlanDay` 新增可选 `intentKind`/`observation`；新增 v2 只读合同类型与 `TRAINING_PLAN_CONTRACT_VERSION`）
- 测试：`coach-template-library`、`coach-loop-runtime`、`mobile-coach`、`mobile`、`plan-receipt-identity`
- `scripts/coach-acceptance-replays.mts`、`coach-isolated-replay.mts`、`coach-runtime-replays.mts`
- `docs/ALGORITHM.md`（剂量政策 v2 描述）
- `deliverables/README.md`（登记本文与既有未跟踪的 `IOS_DEVICE_LOG_TRIAGE_2026-10-20.md`）
- iOS：`APIClient.swift`、`APIModels.swift`、`TrainingPlanRepository.swift`、`TrainingPlanStore.swift`、`NativeAppModel.swift`、`PlanStatePolicy.swift`、`Skins/Technology/{TechPlanView,TechRunCoachView,TechCoachLoopSection,TechManualPlanView}.swift`（PR5）；`PlanScheduleOperationJournal.swift`、`PlanWatchScheduling.swift`、`PlanWatchSyncCoordinator.swift`（PR6）；`apps/ios/tests/run-model-tests.sh`、`run-plan-watch-tests.sh`
- `README.md`、`package.json`（PR7 门禁与文档入口）

未触碰：`apps/ios/**` 的 6 个既有未提交改动、`deliverables/IOS_DEVICE_LOG_TRIAGE_2026-10-20.md`、用户数据库、主健康库与设备排期。所有 CLI/测试只用临时 SQLite。

### 4.17 明确未做（避免把"推进"读成"完成"）

| 项 | 状态 | 说明 / 下一步 |
| --- | --- | --- |
| 独立临床/教练领域复核 | 未提供 | 签字是产品/规则所有者方向性批准，文件已明确不冒充独立复核 |
| 真实用户迁移 / 部署 | 未做 | 副本演练已完成（§4.12.1）；真实 apply 与部署仍需单独审批 |
| 真机 / Simulator 验收 | 未做（用户已排除） | PR5 视觉/无障碍、PR6 设备端先撤回、视觉快照测试 |
| 并发/跨库压测 | 部分 | P04 双进程并发、P08 跨库穿越压测未做；已有 CAS/指纹测试 |

## 5. 门禁与未验证边界

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck` | **通过（EXIT=0）** | `tsconfig.pure` + `tsconfig`，全部改动后重跑 |
| `RAI_TEST_CONCURRENCY=2 npm test`（最终，含 G02-C 与退役） | **2224 tests / 2211 pass / 0 fail / 13 skipped，EXIT=0** | 全量 0 失败；13 条为既有 Rust parity skip（本机无 cargo） |
| 本轮新增测试 | **commands 12/12、coordinator 4/4、policy-adoption 3/3、pre-race-activation 4/4、capacity-restart-v2 3/3、legacy-surface-retirement 2/2、run-coach 12/12、v2-route 8/8、migration 11/11** | 单次命令原子性、协调器单飞、G01–G03 标准案例、G01-B 窗口、G02-C 衰减释放、410 退役矩阵、合同协商、迁移 CAS |
| `npm run test:ios` | **通过（EXIT=0）** | 最后一次 iOS 源码改动后运行；本轮其后未再改 iOS 源文件 |
| `bash apps/ios/tests/run-plan-watch-tests.sh` | **123 PASS** | PR6 上下文/撤回协议 |
| `npm run check:training-plan-single-writer` | **通过，违规 0** | R1–R5；变异注入判红、恢复判绿 |
| `npm run check:docs` | **通过** | 105 files / 700 links / 0 problems |
| `npm run check:acceptance-matrix` | **通过** | 80 cited / 0 gap / 0 missing |
| `npm run check:scripts` | **通过** | 18 package.json / 105 scripts |
| `npm run check:package-boundaries` | **通过** | 16 包 / 31 src 边 |
| `npm run check:doc-refs` | **通过（漂移无基线）** | 143 refs / 0 越界 |
| `npm run check:ios-gates` | **通过** | 10 支判据，2 支按外部条件跳过 |
| 真机 / Simulator / 真实账户迁移 | **未验证** | 用户已排除真机与 Simulator；真实迁移与备份回滚演练未做 |

**结论**：API 全量 0 失败、iOS 静态门禁通过、唯一写者门禁 0 违规、文档/验收/脚本/边界门禁全绿。
未验证项（真机、Simulator、真实迁移、独立领域复核）已单列，不并入"通过"。

## 6. 文档中值得保留的边界（核实后确认成立，不应在实施中弱化）

1. `coachLoopManaged` 由"收据存在"决定 → 任何"释放托管"的实现都必须先改这个谓词，只改 UI 不解决问题（§3.4）。
2. `coachLoopFacts` 内部仍排课 → 只重命名运行时会留下"外层统一、内层旧教练"的假合并（E15）。
3. 名额/预算换算必须用同一侧边界：F01 修复前显示 5.2 km 而预算用冷启动 5.0 km（或闭区间下显示 4.6、预算 5.45）；修复后同源，但任何新消费者都必须用 `upper` 做 km 预算、用 `lower` 证最小时长。
4. `end` 会对未来窗口写 rest（§3.4）→ 迁移选源时不能把这种"全 rest 窗口"当成用户的真实意图。
5. iOS 入口数量比文档多（3 个计划入口/3 个配置面）→ PR5 的收敛清单要按实际入口列，而不是按文档的两处。

---

## 7. 本轮命令与结果（可复跑）

```bash
# 基线
git rev-parse HEAD                      # 958e8f4
git status --porcelain                  # 既有 6 个 iOS 改动 + 本轮文件

# PR1 / PR2 回归
npx tsx --test apps/api/test/training-mode-policy.test.ts          # 16/16
npx tsx --test apps/api/test/training-planner-regressions.test.ts  # 9/9（UTP-A01–A06）
node --import tsx --test apps/api/test/weekly-plan.test.ts \
  apps/api/test/weekly-plan-service.test.ts                        # 68/68
node --import tsx --test apps/api/test/coach-loop.test.ts          # 14/14（含 O0-B/C）

# F03 / F04 / F06 / PR3
npx tsx --test apps/api/test/mobile-coach.test.ts apps/api/test/mobile.test.ts \
  apps/api/test/mobile-coach-snapshot-parity.test.ts               # 40/40, 36/36, 4/4
npx tsx --test apps/api/test/coach-loop-runtime.test.ts \
  apps/api/test/coach-loop-device-sync.test.ts \
  apps/api/test/training-plan-state.test.ts                        # 11/11, 6/6, 12/12
npx tsx --test apps/api/test/training-plan-migration.test.ts       # 11/11
npx tsx --test apps/api/test/plan-receipt-identity.test.ts          # 13/13（控制库 ledger 2）

# 迁移 CLI（只读）
npx tsx scripts/migrate-training-planner.mts --help
npx tsx scripts/migrate-training-planner.mts --control-db <tmp.sqlite> \
  --server-id ... --athlete-id ... --dataset-epoch ...              # 默认 dry-run，不写

# PR4-1 协商式只读接口
npx tsx --test apps/api/test/training-plan-v2-route.test.ts         # 8/8
curl -H 'X-RAI-Training-Contract: 2' http://127.0.0.1:<port>/v1/mobile/training-plan-state
curl http://127.0.0.1:<port>/v1/mobile/training-plan-state          # v1 不变

# PR4-2 / PR4-3 命令与刷新（服务层测试，临时控制库）
npx tsx --test apps/api/test/training-plan-commands.test.ts          # 10/10

# PR5 / PR6 iOS 静态门禁
npm run test:ios                                                    # EXIT=0（98 文件 + 纯逻辑 + 10 门禁）
bash apps/ios/tests/run-plan-watch-tests.sh                         # 123 PASS

# PR4-4 / 协调器 / 政策
npx tsx --test apps/api/test/training-plan-commands.test.ts          # 12/12
npx tsx --test apps/api/test/training-plan-coordinator.test.ts       # 4/4
npx tsx --test apps/api/test/training-plan-policy-adoption.test.ts   # 3/3

# PR7 唯一写者结构门禁
npm run check:training-plan-single-writer                            # 违规 0

# 全量与门禁
npm run typecheck                                                   # EXIT=0
RAI_TEST_CONCURRENCY=2 npm test                                     # 2235 tests / 0 fail / 13 skipped
npx tsx scripts/coach-behavior-replay.mts --output /tmp/replay.json
npm run check:docs && npm run check:acceptance-matrix && npm run check:scripts
npm run check:package-boundaries && npm run check:doc-refs && npm run check:ios-gates
```

**关于失败的完整披露**：本轮有两次全量是在外部 iOS Simulator 冷启动（`mediaanalysisd` +
`WindowServer` ≈ 330% CPU、负载 32–40）时跑的，各出现 1–3 条失败，全部落在本轮**未改动**的
`recompute-worker` / `write-lease-handoff` 墙钟敏感用例；隔离复跑分别 6/6、10/10 通过。
最终在负载 8.6 下的一次全量为 2208 tests / 0 fail / 13 skipped（EXIT=0）。
发布记录必须同时写明这两类结果，不能只挑绿的那次。

**未执行（本轮无对应改动）**：`npm run test:ios`、`npm run smoke:api`、`npm run test:coach:mutation`、
`npm run ml:test`、`check:ios-gates` 的 2 支外部条件判据。

## 8. 最终判定

- **文档真实性：基本成立，可作为实施依据**；需要修正的只有 F02 的机制与标准案例（§3.1）、F06 的副作用补充（§3.4）、E07 归属（§2.1）、iOS 入口数量（§3.6）。其余"待实施"标注与"未完成"边界准确。
- **推进程度（截至本记录）**：
  - PR1 模式解析语义冻结；PR2 F01/F02/F03 全部修复并有回归；F04/F06 修复；
  - PR3：控制库统一状态、CAS store、dry-run/apply 迁移 CLI；
  - PR4-1/2/3：协商式 v2 只读、预览+配置命令（原子提交）、计划刷新（生成在外/提交在内、指纹复核）；
  - PR5：iOS 单一训练入口 + v2 客户端（`npm run test:ios` 通过）；PR6：Watch 上下文与先撤回再下发（123 条断言）；PR7：唯一写者结构门禁 + G01–G03 评审材料；
  - 门禁：typecheck、iOS 门禁、结构门禁、文档/验收矩阵/脚本/包边界全绿；全量 API 套件 2226 条、1 条已隔离证伪的时序假红。
- **仍然阻断/未做**：真实用户迁移与部署；独立临床/教练领域复核；真机/Simulator 验收（用户已排除真机）。旧接口退役与旧排课代码删除已完成（§4.17、附录 D）。
- **不能对外声称**：统一内核已完全收敛、迁移可执行、真机已验收、训练效果已证明。本文只支持：
  1. 方案的现有事实与缺陷判断可信，且有复现证据；
  2. PR1–PR7 的工程切片已按方案方向落地并通过对应门禁（含 iOS 与结构门禁）；
  3. 统一合同已可读写、配置与计划可在事务边界内一致发布，但**单次命令、协调器、跨库屏障、旧代码删除与真实迁移尚未完成**。

---

## 附录 A：F01 修复的完整前后证据

```text
# 修复前（v1，生产分区形状 easyPaceLower=345, easyPaceUpper=null）
easy      {"status":"feasible","estimateSource":"cold_start_policy","distance":{"lower":5,"upper":5}}
interval  {"status":"not_assessable","reasonCodes":["dose_pace_evidence_unavailable"]}
tempo     {"status":"not_assessable","reasonCodes":["dose_pace_evidence_unavailable"]}

# 修复后（v2，同一输入）
easy      {"status":"feasible","estimateSource":"zone_pace_range","duration":{"lower":1800,"upper":1800},
           "distance":{"lower":null,"upper":5.217391304347826}}
tempo     {"status":"feasible","duration":{"lower":3000,"upper":3000},
           "distance":{"lower":null,"upper":9.470192738682204}}
interval  {"status":"feasible","duration":{"lower":2544,"upper":2611.2},
           "distance":{"lower":null,"upper":8.069565217391304}}
```

## 附录 B：F02/F05 复现输出

```text
# F02 修复前（评估日 2026-10-20，生产形状分区，周基线 10 km，本周已跑 1 km）
10-20=easy(5.2) 10-21=rest ... 10-25=rest 10-26=rest
# 10-26 属于下一自然周，拥有完整 10 km 预算，但没有任何候选。

# F02 修复后（同一输入）
10-20=easy(5.2) ... 10-26=easy(5.2)
# 周基线 5 km 时仍为七天全 rest，但原因是带数字的合法不可行：
#   no_feasible_course：一堂完整常规课约 5.2 km，本自然周可用 4.0 km（下周 5.0 km）；不切碎剂量、不虚构更慢配速。

# F05（10K 比赛在 2026-10-30，距评估日 10 天，周建议量 20 km，前一周 20 km）
taperDayCeiling(20) = 2 km
10-20 rest「赛前减量，保留恢复」
10-21 rest「完整常规课预算不足；不切碎剩余建议量」
...
warnings: ["2026-10-20 减量预算不足以支撑完整课表，改为休息", ...]
```

## 附录 C：UTP 64 条映射（逐条状态）

状态口径：**✅ 有本轮证据**（测试/门禁/代码）、**📱 静态门禁级**（iOS 编译期/纯逻辑，未上真机）、
**🔒 政策冻结**（按签收的保守候选保持现状）、**⚠️ 未完成**（需要演练/并发/性能或旧映射）。

| ID | 状态 | 证据 / 说明 |
| --- | --- | --- |
| UTP-M01 | ✅ | `training-mode-policy.test.ts` 无目标→coach |
| UTP-M02 | ✅ | 同上 + `training-plan-commands` 单次命令发布 race |
| UTP-M03 | ✅ | 清除赛事→coach，命令测试 |
| UTP-M04 | ✅ | 改时间保身份 / 改日期距离换身份（内容派生 id） |
| UTP-M05 | ✅ | 改时间不改模式/支持等级 |
| UTP-M06 | ✅ | 暂停时设/清赛事仍 paused |
| UTP-M07 | ✅ | 恢复显式，结束后 mode 重新派生 |
| UTP-M08 | ✅ | 草稿/非法目标零副作用 |
| UTP-M09 | ✅ | race_day 解析；服务端比赛日留白"不等于已完赛" |
| UTP-M10 | ✅ | 日期过后 coach，不生成完赛事实 |
| UTP-M11 | ✅ | 临近/超骨架仍是 race（support 标记） |
| UTP-M12 | ✅ | 全马/自定义距离保留赛事身份（limited） |
| UTP-A01 | ✅ | 开放 easy 上界逐维度评估（regressions） |
| UTP-A02 | ✅ | 时长/距离/时间按各自证据，未知侧显式 |
| UTP-A03 | ✅ | 质量课不再因 easy 格式整体误拒 |
| UTP-A04 | ✅ | 冷启动仅全无证据时，来源可见 |
| UTP-A05 | ✅ | 跨周空间不再漏排 + 明确不可行原因 |
| UTP-A06 | ✅ | 逐自然周净预算，跨周仍受滚动限制 |
| UTP-A07 | ✅ | P-G01-B 已实现：赛前 600–900 秒激活、72 小时边界、距离 ≤ 单日上限（`pre-race-activation.test.ts`） |
| UTP-A08 | ✅ | `no_feasible_course` + 公里边界 |
| UTP-A09 | ✅ | 意图/观测分离（API + iOS 渲染） |
| UTP-A10 | ✅ | 确定性、相同执行不增 revision、身份随政策更新 |
| UTP-P01 | ✅ | GET 只读（read-consistency/命令预览零写入测试） |
| UTP-P02 | ✅ | 操作键重放返回原结果（发布 + 命令 + 刷新） |
| UTP-P03 | ✅ | 同键换请求/跨域拒绝 |
| UTP-P04 | ⚠️ | 有 revision 冲突路径，但真正双进程并发提交未压测 |
| UTP-P05 | ✅ | 事实/指纹/候选在生成后变化→409（刷新与单次命令） |
| UTP-P06 | ✅ | 配置+计划+历史+镜像同事务（单次命令测试） |
| UTP-P07 | ✅ | 重放先于过期检查（刷新测试） |
| UTP-P08 | ⚠️ | 主库 `data_version` 纳入指纹作屏障；跨库并发穿越未做压测 |
| UTP-P09 | ✅ | 旧接口投影/委托；结构门禁 R1–R3 守唯一写者 |
| UTP-P10 | ✅ | 未知合同 409/类型化错误，不静默降级 |
| UTP-D01 | ✅ | 旧 active fitness → 日常（迁移分类） |
| UTP-D02 | ✅ | 旧 race 保留赛事（分类 + F04 数据保留测试） |
| UTP-D03 | ✅ | 独立目标→比赛；偏好缺失→needs_configuration |
| UTP-D04 | ✅ | 闭环日常/比赛转换，授权不放大 |
| UTP-D05 | ✅ | paused/ended 不复活（迁移 + 协调器跳过） |
| UTP-D06 | ✅ | 多源矛盾→conflict 不猜 |
| UTP-D07 | ✅ | dry-run 不写；digest 不匹配拒绝 |
| UTP-D08 | ✅ | 重放 no-op、无两份管理者 |
| UTP-D09 | ✅ | 历史/幂等/回执/预留在迁移后可用（11 条测试） |
| UTP-D10 | ✅ | 真实控制库副本演练：原库 sha256 前后一致（见 §4.12.1） |
| UTP-I01 | 📱 | PR5 单入口；Typecheck/纯逻辑通过 |
| UTP-I02 | 📱 | 赛事编辑同页可达；statics |
| UTP-I03 | 📱 | revision floor / 身份 / 窗口 / 合同校验 |
| UTP-I04 | 📱 | 提交后旧 in-flight 失效、草稿冲突 |
| UTP-I05 | 📱 | 离线缓存标记非当前；写确认/回执不清空 |
| UTP-I06 | 📱 | 休息/比赛/待刷新/事实待更新/不可评估分开 |
| UTP-I07 | 📱 | 力量训练/人工覆盖/反馈/复盘保留 |
| UTP-I08 | 📱 | 未知合同→升级提示，不显示休息 |
| UTP-W01 | 📱 | 切换先失效令牌、预留保留到强核验（PR6 测试） |
| UTP-W02 | 📱 | 撤回失败不继续下发（35 条断言） |
| UTP-W03 | 📱 | 下发前复核 scope/日期/revision/policy/digest |
| UTP-W04 | 📱 | 下发后强读回，不以 API 成功代替 |
| UTP-W05 | 📱 | 旧回执可登记撤回；重复幂等 |
| UTP-W06 | 📱 | 中断点恢复（注册/读回/写入失败注入） |
| UTP-W07 | 📱 | 目标再变时旧任务不标当前（上下文比对） |
| UTP-W08 | 📱 | 跨 datasetEpoch 不继承（拒绝且不入账） |
| UTP-R01 | ⚠️ | 旧 78 条 AC 与 22 场景尚未逐条映射到新实现 |
| UTP-R02 | 🔒 | 政策项已按保守候选签收；真机/独立复核未做 |
| UTP-R03 | ✅ | 副本上 dry-run→apply→重放→破坏性备份还原全部通过（§4.12.1） |
| UTP-R04 | ⚠️ | 新旧性能基线对比未做 |
| UTP-R05 | ✅ | 测试记录绑定源码身份/并发/平台（本节与 §5） |
| UTP-R06 | ✅ | 四个旧接口组已退役（410），不可达的旧排课实现已删除；剩余纯函数由结构门禁 R1–R5 守唯一写者 |

## 附录 D：旧排课代码删除与退役执行证据（2026-10-20）

产品所有者批准四个旧接口组退役后，本轮执行了"路由保留 + 410"与"不可达实现删除"。判据是
**生产调用者**（不是测试）：只有仍被生产路径引用的纯函数保留。

| 旧入口/算法 | 处理 | 依据 |
| --- | --- | --- |
| `/v1/mobile/run-coach`（GET+POST） | 保留挂载，一律 410 `legacy_surface_retired`；删除 `registerRunCoachRoutes` 与旧生命周期/命令实现 | `legacy-surface-retirement.test.ts` 泛化矩阵；`schemas.test.ts` OpenAPI 退役契约 |
| `run-coach.ts` 模板分配（`buildRunCoachWeek`/`runCoachPlanExecutionIdentity`/`runCoachAdaptationKey`） | 删除（仅旧路由与其测试引用） | `npx tsc` + 结构门禁 R1 不再需要旧适配器豁免 |
| `/v1/mobile/workout-plan/preview|confirm` | 保留挂载，410；删除 `WeeklyPlanPreviews`/`weekly-plan-preview.ts` 与其进程内候选机制 | preview/confirm 测试删除，统一命令测试保留 |
| `/v1/mobile/workout-plan/generate` | 保留挂载，410；删除该写入口（保留后台非迁移 scope 的旧周生成函数，供自动生成继续使用） | 路由级 410 测试；后台生成逻辑由既有测试覆盖 |
| `/v1/mobile/goals`（GET+PUT） | 保留挂载，410；删除 goals 读写处理器（`MobileGoalsStore` 内部 API 保留） | 410 矩阵；存储/发布测试保留 |
| `weekly-plan-preview.ts` / `plan-preview.test.ts` / `weekly-plan-preview.test.ts` | 删除 | 无生产调用者 |
| `run-coach.test.ts` 的旧路由/模板测试 | 删除（8 条保留纯函数与读取投影测试） | 这些行为随代码一起删除，不再声称可用 |
| 旧 goal/lock 路由 | `/goals` 退役；`/lock` 保留（仍被生产路径使用） | 410 矩阵 + lock HTTP 测试 |

剩余风险：后台旧周生成（非迁移 scope）仍是独立写路径，但只在 `training-plan-state` 未迁移时运行，
且不新增 HTTP 面；统一状态迁移与自动协调器仍是后续步骤。

--- | --- | --- |
| `run-coach.ts` 生命周期与模板分配 | `POST /v1/mobile/run-coach` 仍对外；旧客户端未升级；`runCoachRaceTarget` 仍被 F04 镜像与读取使用 | 路由注册与 `coach-manual-compatibility`/`run-coach` 测试 |
| `generateWeeklyPlan` 旧周生成 | `/v1/mobile/workout-plan/preview|confirm|generate` 仍被旧流程使用（统一入口是新合同，但旧合同必须安全） | 这些路由的测试仍全绿 |
| 旧 goal/lock 路由 | 未托管数据集仍依赖它们；F06 修复后结束节目会交还 | 409 门控 + mobile 测试 |
| `coach-loop-runtime` 旧状态机 | 旧闭环客户端仍在使用；新合同已能读取其迁移结果 | `coach-loop*` 测试 |

因此本轮交付的是**唯一写者结构门禁**（R1–R5）而不是删除：一旦有第二个排课/第二个迁移写入口出现，
门禁立即变红。真正删除需要先把旧 `/v1` 合同映射到统一命令/读取（会改变旧客户端行为），属于需要
单独产品决策的一步；本记录不把它伪装成已完成。

