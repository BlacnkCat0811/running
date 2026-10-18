# 训练计划 iOS 客户端审查（状态机 / 排期 / 回执 / 缓存 / UI）

- 审查日期：2026-10-18（Asia/Shanghai）
- 审查者：ios-plan-reviewer（只读审查；未修改仓库任何源文件，临时脚本仅在 `/tmp`）
- 审查对象：`apps/ios/RAI` 下训练计划相关 Swift 源码、`apps/ios/RAI/Skins/Technology` 计划 UI、`apps/ios/tests` 计划回归与 fixture
- 承诺行为基线：`docs/IOS_TRAINING_PLAN_STATE_V1.md`、`docs/IOS_TRAINING_PLAN_IMPLEMENTATION.md`、`docs/IOS_TRAINING_PLAN_ARCHITECTURE_PROPOSAL.md`、`docs/TODAY_PLAN_CARDS_REVIEW.md`、`docs/COACH_LOOP_IMPLEMENTATION_STATUS.md`、`docs/IOS_NATIVE_API_CONTRACT.md`、`docs/DECISIONS.md`（D6/D13/D15/D16）
- 结论口径：区分「已证实」（读代码 + 必要时 `/tmp` 脚本复算）与「待确认」（需真机 / 真实 HTTP / Simulator）；文档已声明限制标为 known limitation，不计缺陷；文档声称已修复而代码没有的单列「文档漂移」。

---

## 1. 审查范围与执行记录

### 1.1 逐文件阅读（必读清单全部读过）

| 文件 | 行数 | 关注点 |
| --- | --- | --- |
| `TrainingPlanStore.swift` | 368 | `@Observable @MainActor`、revision 水位、accept/invalidate/configure、refresh 的 requestID/epoch/isValid、validate / validateCoachLoop、presentation |
| `TrainingPlanRepository.swift` | 70 | 聚合/三 GET、partial read、`PlanReadIssue.network` 错误分类 |
| `PlanStatePolicy.swift` | 203 | `PlanAvailability`、`PlanPresentationSnapshot`、`PlanSyncSnapshot.matchesForExecution`、ledger、`PlanFingerprint` / `prescriptionDigest`、`CacheReadResult` |
| `PlanWatchScheduling.swift` | 350 | 授权→预检→journal→clear→schedule→readback→confirm、superseded、recover |
| `PlanWatchSyncCoordinator.swift` | 87 | 全局串行、refresh 后快照、commit、回执、撤回、恢复 |
| `PlanScheduleOperationJournal.swift` | 110 | schema 1、phase/itemPhase、`requests()` 重建、`finish` / `finishWithdrawal` |
| `PlanReceiptMatcher.swift` | 57 | UUID+精确时刻+内容+未完成的强匹配、consume-once、清单全匹配 |
| `PlanMutationDisposition.swift` | 76 | 发布/回执/反馈终局码白名单及边界 |
| `WorkoutPlanMapper.swift` | 623 | exact/normalized/unsupported、strict export、时段回卷、weekOffer |
| `WorkoutKitBridge.swift` | 153 | 唯一 SDK 边界、`removeEntries` 按 UUID+时刻、readBack contentMatches |
| `TrainingReminders.swift` / `TrainingReminderPolicy.swift` | 100/26 | 授权、去重、时区、7 日窗口、完成集合 |
| `CacheStore.swift`（plan 相关） | 493 | cache schema 1/2、ack 事务、ledger、pending receipts、journal、clear/prune、scope |
| `NativeAppModel.swift`（plan 流程） | 1899 | plan 门面、写路径、publish 幂等、resolve、回执登记、journal/ledger 写回、recover |
| `APIClient.swift` | 406 | plan GET/POST、缓存策略、超时、取消、`recordPlanSync` 线格式 |
| `APIModels.swift`（plan DTO） | 2041 | `TrainingPlanStateResponse`、`MobileWorkoutPlanResponse`、`CoachLoopResponse`、`PlanSyncReceipt`、handshake 能力位 |
| `Skins/Technology`（12 个计划视图文件） | 约 4.2k | 今日页推荐卡/阶段卡、计划页、手动课表、教练 setup、预览、锁课、赛事目标、提醒、手表区 |
| `apps/ios/tests`（8 个计划测试 + `fixtures/*`） | 约 4.9k | Store/排期/Model/Store durability/Mapper/展示/视觉/fixtures |

### 1.2 iOS 门禁（已在本机运行，exit 0）

命令：`node scripts/run-ios.mjs gates`（子集，2–4 分钟；未跑全量 `node scripts/run-tests.mjs`）。日志 `/tmp/ios-gates-iosplanreview.log`。

- 类型检查：**94 个文件通过**（按脚本明示跳过 3 个仅依赖高德 SDK 的文件，非静默通过）。
- `All model regression checks passed`；**Plan scheduling regression: 74 checks passed**；**TrainingPlanStore regression: 34 checks passed**；**106 store regression checks passed**；**Technology presentation: 200 checks passed**；Today layout、workout plan mapper、UX/提醒纯函数等门禁全部通过。
- 门禁是源码级类型检查 + 纯逻辑回归；**不含** Simulator 视觉验收、真实 HTTP、真实 WorkoutKit、配对手表。

### 1.3 复算脚本（`/tmp/rai-ios-plan-receipt-probe.mjs`，不读健康库）

用仓库 `plan-digest.ts` / `session-structure.ts` 复算「Swift 省略 nil 键」的线格式后果：

```
digest(original)  = 384ac66e... (省略 warmup/cooldown/alert 键)
digest(normalized)= 3ea3721e... (显式 null)
equal?  false
prescriptionDigest THROWS: TypeError Cannot read properties of undefined (reading 'purpose')
patched digest equal? true
```

---

## 2. 结论摘要

- **未发现 P0**：没有发现可导致跨身份执行、静默改写历史、或把未确认副作用当作成功的设计缺陷。核心安全边界与文档一致：
  - revision 水位单调且与展示缓存隔离（`CacheStore.acknowledgePlanWrite` 同事务写水位+删执行缓存，`clear`/`clearAll`/`prune` 只碰 `cache_entries`）；
  - `refresh` 的 requestID/epoch/scope/isValid 取消语义在测试中被明确钉住（迟到聚合不能回退水位、取消不留下 current、换 scope 拒绝迟到读、更高能力版本 fail-closed）；
  - 排期是「写前日志 → SDK 副作用 → 强回读 → 原子提交」，预检任一必需训练失败整体不替换，清空失败不会被包装成成功；
  - 回执登记区分「服务端登记」与「本地核验」，`matchesCurrent=false` 只影响当前 ledger，历史回执不误伤新排期；终局拒绝码白名单避免了本地账目永久楔死。
- **P1 一条（R-01）**：非教练闭环路径发出的 **v2 回执线格式缺少显式 null**（`warmup`/`cooldown`/step `alert`），服务端在 `prescriptionDigest` 处会 `TypeError`（→ 500）或 `digest(normalize) ≠ digest`（→ 422 `plan_receipt_evidence_mismatch`）。422 被客户端列为**终局**并丢弃回执、把当前 ledger 标为待撤回；500 则让回执永久待登记。教练闭环分支在 `APIClient.recordPlanSync` 里已做显式 null 补丁，**非教练闭环分支没有**。
- **P2 五条**：legacy 三 GET 路径缺本地日期/窗口校验却置 current；安全校验失败被归为「协议版本不兼容」；`refreshRunCoach` 与 `TrainingPlanStore` 的能力判定不一致（可能混读新旧教练合同）；教练闭环下提醒功能静默不排程；赛事目标日期用设备时区而非业务时区。
- **P3 五条**：缓存时间丢失、服务端计划 GET 仅聚合端点 no-store、撤回 cleanup 只按 UUID 不核对时刻、两处强制 `as!`、今日页计划卡 C1–C4 仍未决（非回归）。
- 其余「看起来像缺陷但已核实安全」的项列在 §7，避免把 known limitation 当缺陷。

---

## 3. 发现（P0–P3）

> 每条给出：位置 / 现象 / 证据 / 触发条件 / 用户可见后果 / 建议 / 验证状态。编号 `R-xx`。

### P0

无。

### P1

#### R-01（P1）非教练闭环的 v2 回执线格式缺少显式 null，导致服务端 500 或错误终局撤回

- **位置**
  - `apps/ios/RAI/APIClient.swift:176-219`（`recordPlanSync`：只有 `receipt.coachLoop != nil` 分支做 null 补丁；else 分支直接 `send(body: receipt)`）
  - `apps/ios/RAI/APIModels.swift:398-413`（`MobileWorkoutStep.alert`、`MobileSessionStructure.warmup/cooldown` 均为 Optional，Swift 合成 Codable 用 `encodeIfPresent` 省略 nil 键）
  - `apps/ios/RAI/NativeAppModel.swift:1578-1589`（`enrichPlanReceipts`：只要快照有 `coherenceToken` + `serverIdentity` 就把回执升级为 contractVersion 2，与是否教练闭环无关）
- **现象**：计划快照契约（`planSnapshotContractVersion=1`）+ 回执契约 2、但用户**未启用教练闭环**时，`PlanWatchSyncCoordinator.sync` 会把 `request.exportedStructure`（真实导出结构，warmup/cooldown/无 alert 的 step 都为 nil）作为 v2 回执 `structure` 发出。Swift 编码后 JSON 里这些键**直接缺失**：

  ```json
  {"localDate":"2026-10-09","kind":"easy","revision":12,
   "structure":{"blocks":[{"iterations":1,"steps":[{"purpose":"work","goal":{"type":"distance","meters":4000}}]}]},
   "contractVersion":2,"scope":{...},"operationId":"...", ...}
  ```
- **服务端后果（已用脚本复算）**
  - `server.ts:1217` `prescriptionDigest(body.kind, body.structure!)`：`plan-digest.ts:16-33` 的 `step()` 只对 `null` 走 `["~"]`，对 `undefined` 继续解引用 `value.purpose` → **TypeError → 500 `internal_error`**（多数日子：warmup/cooldown 为 nil）。
  - 若 warmup/cooldown 非 nil（间歇/节奏课），`server.ts:1218` `digest(normalizeSessionStructure(structure)) !== digest(structure)`：normalize 会给缺失的 `alert`/`warmup`/`cooldown` 补 `null`，与省略键的稳定 JSON 不同 → **422 `plan_receipt_evidence_mismatch`**。
  - 教练闭环回执被 `APIClient.swift:181-210` 显式补 `warmup/cooldown/alert/lower/upper/decisionRef` 的 null，因此**只有该分支能通过**；这反证补丁是专门给教练闭环加的，非教练闭环被遗漏。
- **客户端后果**
  - 422 `plan_receipt_evidence_mismatch` 在 `PlanMutationDisposition.terminalPlanReceiptErrorCodes`（`PlanMutationDisposition.swift:44-52`）中 → `NativeAppModel.recordPlanSyncReceipts`（`NativeAppModel.swift:1499-1510`）把它当**终局**：丢弃该回执、把匹配 ledger 的 `requiresWithdrawal = true`、`watchState = .stale`，并提示「…被服务端终局拒绝（数据校验冲突），已作废不再重试；请撤回旧排期后重新同步手表」。即：**本机已经强回读核验成功的系统排期，被客户端自己的线格式问题误判成需要撤回**。
  - 500 不属终局 → 回执保留在 `plan_receipt_journal` 反复重试；`hasPendingPlanReceipts` 恒真 → 后续 `changeCoachLoop("enable")` 的「旧系统排期/未登记回执未协调」门禁（`NativeAppModel.swift:436-441`）永久拦住从旧计划切换到新版教练。
- **建议**
  1. 把 `recordPlanSync` 的 null 补丁抽成「v2 回执编码器」，对 contractVersion == 2 的**所有**回执使用（不只 coachLoop）；或更彻底：给 `MobileSessionStructure`/`MobileWorkoutStep`/`MobileStepAlert` 写显式 `encode(to:)`（v2 诊断上下文）或用单独 wire DTO 固定 null 语义。注意 v1/legacy 与缓存/兼容解码不能一起改（`PlanSyncReceipt.useLegacyContract` 之后应继续走旧省略语义）。
  2. 增加线格式回归：构造一个**非 coachLoop** 的 v2 回执，断言 JSON 中 `structure.warmup`、`structure.cooldown`、每个 step 的 `alert` 均存在（可为 null），并与服务端 `mobilePlanSyncedBodySchema` 的 `additionalProperties:false` + 强匹配要求对齐；最好直接复用 API 测试里的 receipt schema 校验器。
  3. 短期止血：在服务端 422/500 修复前，客户端在 `PlanWatchSyncCoordinator.sync` 遇到非教练闭环 v2 回执时不要当作「已登记」，但**绝不要把 `plan_receipt_evidence_mismatch` 当成撤回依据**——此码在本问题下可能是客户端自身格式问题，服务端并未拒绝证据本身。
- **验证状态**：**已证实（静态代码 + `/tmp` 脚本）**：省略键确实使 `prescriptionDigest` 抛 TypeError、使 `digest(normalize)≠digest`；未运行真实 HTTP（无隔离 API 实例），因此「线上实际返回 500 还是 422」按日子结构不同而不同，均待真实请求确认。
- **与 API 报告的关系**：本条与 `02-api-write.md` 的 R-1（回执 v2「结构已规范化」校验与 iOS 线格式不兼容）同源；API 侧可放宽 schema/规范化判定，iOS 侧应把 v2 回执的显式 null 编码补齐，两侧都应有回归，不能只依赖一侧。

### P2

#### R-02（P2）legacy 三 GET 刷新缺少本地安全日期/窗口校验，却把结果标成 `current`

- **位置**：`TrainingPlanStore.swift:328-343`、`:173-245`（成功分支 `:231-244`）；对照聚合路径 `:344-366`。
- **现象**
  ```swift
  // validate(_:handshake:)
  guard let aggregate = value.aggregate else { return }   // 328-340：legacy 在这里直接返回
  guard UserDataNoticePolicy.isCurrentDay(value.today.today.localDate, ...) // 341-343：只对聚合执行
  ...
  (1...14).contains(value.workoutPlan.windowDays)          // 354：只对聚合执行
  ```
  而 legacy 成功分支无条件 `isCurrent = true; availability = .current`（`refresh` :235-236），`trainingPlanStore.executablePlan` 只比较 `planRevision == revision`（:43-51），`NativeAppModel.currentWorkoutPlan`（:91-93）直接采用它。
- **触发**：旧服务（handshake 无 `planSnapshotContractVersion`）返回 `today.localDate` 非当前业务日、`windowDays` 越界、`days` 不唯一/不连续、或时区无法解析（含被中间缓存返回的上一日响应，见 R-08）。
- **后果**：不会错误下发到手表——`planSyncSnapshot`（`NativeAppModel.swift:1258-1266`）与 `PlanWatchScheduling.sync`（:159-165）会再次校验，锁课走 `canConfirmToday`；但 (a) `refreshPlanState` 返回成功、`workoutPlanError` 置空，用户看不到「未确认当前安排」；(b) `watchNeedsUpdate`/`watchNeedsClear` 用这份未校验的 plan 计算，可能把旧的系统日程判成「已核验/无需更新」；(c) 缓存会把这份数据当参照写入。属于**展示 fail-open、执行 fail-closed**。
- **建议**：legacy 分支至少补「可本地判定」的安全检查：today.localDate 必须等于按 `today.timezone` 计算的当前业务日、`workoutPlan.timezone` 可解析且与 today 一致、`windowDays ∈ 1...14`、`days.map(\.localDate)` 唯一连续且首日==today.localDate；不满足时置 `issue = .contractMismatch/.revisionConflict` 且 `availability` 走 `.savedAwaitingRefresh`/`.unavailable`，不要置 current。若认为旧服务本就无法证明事实一致性，至少不要把「无法本地校验通过」的响应标成 current（文档 §5.2 的口径是「不宣传强一致」，不是「不校验」）。
- **验证状态**：已读代码证实；测试仅覆盖聚合路径的同类校验（`TrainingPlanStoreRegression.swift:56-75`）与 legacy「revision 不匹配」场景（`ModelRegression.swift:546-548`），**无 legacy 日期/窗口负例**。

#### R-03（P2）安全校验失败被归类为「协议版本不兼容」，误导升级方向

- **位置**：`TrainingPlanRepository.swift:57-69`（`case RaiAPIClientError.decoding: code = .contractMismatch`）；抛出点 `TrainingPlanStore.swift:355/365`、`:295/307`、`:313`；面板分类 `NativeAppModel.swift:544-546`、`:317-335`。
- **现象**：`validate`/`validateCoachLoop` 用 `RaiAPIClientError.decoding("完整快照的安全身份或窗口字段无效")` 表达**数据安全校验失败**；经 `PlanReadIssue.network` 变成 `.contractMismatch`；`planPanelOutcome` 再把 `.contractMismatch` 当「契约漂移」。如果只有计划面板失败，`refreshAll` 的 `decodingOnly` 分支会显示「有 1 项数据未能更新（数据格式与当前版本不兼容），其余已刷新」。
- **触发**：服务端返回 `contractVersion=1` 但身份/窗口/逐日唯一/摘要非法（服务端 bug、中间层篡改/截断、部署版本混杂）。
- **后果**：用户被告知升级 App（错误方向）；诊断事件 `snapshot_rejected` 记录为 contract mismatch；同时该错误不可重试（`retryable` 不含 contractMismatch），legacy 前台重读也被跳过。注意**有测试固定了这个分类**（`TrainingPlanStoreRegression.swift:74` 断言 `issue?.code == .contractMismatch`），说明是有意选择，但它把「数据损坏/安全拒绝」与「协议形状不兼容」混为一谈。
- **建议**：`PlanReadIssue.Code` 增加 `securityValidationFailed`（不可重试）或 `corruptSnapshot`，UI 文案改为「服务端计划快照未通过安全校验，已拒绝使用；重试或检查服务端状态」，不得提示升级客户端；诊断码单独 `snapshot_validation_failed`。同步更新测试断言（原断言改为新码）。
- **验证状态**：已读代码；未运行服务端变异验证（不需要，分类逻辑是确定的）。

#### R-04（P2）`refreshRunCoach` 与 Store 的能力协商判定不一致，可能混读新旧教练合同

- **位置**：`NativeAppModel.swift:341-375`；`TrainingPlanStore.swift:188-213`。
- **现象**：Store 的刷新**先看** `handshake.coachLoopContractVersion != nil` 走 `/v1/mobile/coach-loop`（:188-210），与 `planSnapshotContractVersion` 无关；而 `refreshRunCoach` 只在 `handshake.planSnapshotContractVersion != nil` 时转发到 `refreshPlanState`（:342），否则走旧 `GET /v1/mobile/run-coach` 并 `acceptCoach`（:355-358）。若服务端能力组合为「coachLoopContractVersion=1，无 planSnapshotContractVersion」（错峰上线允许的能力子集），同一次前台刷新会出现：
  1. `refreshPlanState` 走新教练合同，`coachLoop` 被设置、`today=nil`；
  2. `refreshAll` 末尾 `if goals?.runCoach != nil { await refreshRunCoach() }`（:337）走旧合同，把旧 `MobileRunCoachResponse` 写进 `coach`（`acceptCoach`）。
- **后果**：`knownCoachState`（`TrainingPlanStore.swift:38-41`）同时可见旧 plan 状态，若旧状态不是 active/paused/ended（未知值）会直接把 `executablePlan` 判 nil → 页面显示「未确认当前安排」；若旧状态合法但数据与 `coachLoop` 不一致，UI（`TechPlanWatchSection` 之外）可能短暂展示两套教练状态。不会错误下发（`planSyncSnapshot` coachLoop 分支要求 `isCoachLoopManaged` + 租约），但状态所有权被破坏（文档 ARCHITECTURE §5.3 要求「计划状态只有一个写入所有者」）。
- **附带**：:372-374 的 `if value.plan?.status == "active", value.revision == currentPlanRevision` 在 :361-363 已提前 `return` 之后，是**不可达死代码**。
- **建议**：能力判定收敛为一个 computed 属性（`isCoachLoopCapable`），`refreshRunCoach` 对 coachLoop 能力一律转发 `refreshPlanState`；`acceptCoach` 在 `coachLoop != nil` 时拒绝写入旧教练对象；删除死分支。补一个「coachLoop=1 + snapshot=nil」组合回归。
- **验证状态**：已读代码；测试只用两种组合（全新能力全给 / 旧服务全 nil，见 `TrainingPlanStoreRegression.swift:102-104, 148-151`），无混合组合覆盖。

#### R-05（P2）教练闭环模式下「训练提醒」静默不排程，且 UI 没有说明

- **位置**：`NativeViews.swift:61-66`（`reconcile(..., plan: native.currentWorkoutPlan, available: native.canConfirmToday)`）；`NativeAppModel.swift:46-51`（`canConfirmToday` 需要 `today`）；`TrainingPlanStore.swift:205`（教练闭环路径 `today = nil`）；`TrainingReminders.swift:72`；`TechTrainingReminderView.swift:17-35`。
- **现象**：教练闭环（`coachLoop.settings != nil`）下 `today` 恒为 nil → `canConfirmToday == false` → `TrainingReminders.reconcile` 的 `guard enabled, available, ...` 直接返回，**一条通知都不会安排**。但设置页仍允许「开启训练提醒」，关闭/开启按钮、文案「只为已读取的未来七天有效计划安排本地提醒」都照常工作；`configure` 成功后也只提示「仅提醒已读取的未来训练…」。
- **后果**：用户在教练闭环模式授权通知、看到成功文案，却永远收不到提醒；没有「新版教练只提醒今天」的说明。不是安全缺陷，但与 PlanAvailability/「当前安排」语义不一致（当前可执行课明明存在）。
- **建议**：`available` 改用明确的「当前可执行计划存在且属于当前业务日」（如 `trainingPlanStore.isCurrent && !planPersistenceFailed && executablePlan != nil`），教练闭环下用 `loop.today` 与 `devicePlan` 生成今日提醒，或在设置页显式声明「新版教练模式暂不提醒未来日」；`TrainingReminders.reconcile` 增加一层显式 `supportsFutureReminders` 输入，避免调用方靠 `canConfirmToday` 隐式表达。
- **验证状态**：已读代码；`UserExperienceRegression.swift:29-35` 只覆盖纯函数 `slots`，无 `reconcile`/教练闭环场景。

#### R-06（P2）赛事目标日期使用设备本地时区，与计划固定业务时区不一致

- **位置**：`NativeFormat.swift:475-483`（`NativeRaceGoalDraft.dateFormatter` 未设 `timeZone`）；`TechRaceGoalEditor.swift:54-56`（「所选日期已过」比较 `native.today?.today.localDate`（服务端业务日）与设备时区格式化的日期）、`:117-122`（保存时用同一 formatter 输出 `date`）；对照 `TechRunCoachSetup.swift:23-36, 71-74, 155-158` 已显式使用 plan 时区构造日期/范围。
- **触发**：设备时区 ≠ 服务端业务时区（亚洲/上海），尤其在上海午夜附近编辑。
- **后果**：保存的 `raceTarget.date` 可能比业务日差一天；页面「所选日期已过」误报/漏报（`native.today` 在教练闭环下为 nil 时回退到设备本地今天，口径来源不一致）；服务端按业务时区解释比赛日期，倒计时/准备度与用户输入可能错位。
- **建议**：`NativeRaceGoalDraft` 统一要求调用方传入业务时区（或使用 `UserDataNoticePolicy.localDate(now:timezone:)` 的固定 `Asia/Shanghai`），`DatePicker` 的显示/格式化与保存同源；「已过」比较只用服务端业务日，today 缺失时不要用设备日期兜底成「已过」。
- **验证状态**：已读代码；`ModelRegression` 的 race date 用例在主机本地时区下通过，未构造跨时区设备场景（`NativeRaceGoalDraft` 的 `dateFormatter` 未加时区这一事实是确定的）。

### P3（最多 5 条，已满）

#### R-07（P3）legacy/单条缓存路径丢失缓存时间，离线文案无法说明「缓存于何时」

- **位置**：`TrainingPlanStore.swift:154-170`（`cachedAt = aggregate?.cachedAt`；goals/today/workout-plan 单独读时丢弃各自 `cachedAt`）；`PlanStatePolicy.swift:21-31`（`cached` 文案不引用时间）；`NativeAppModel.swift:1098-1104`。
- **后果**：旧服务（无聚合缓存）或只有单条缓存时，`PlanAvailability.cached(asOf: nil)` 与 `lastCacheUpdate` 丢失时间；文档要求缓存态「标明缓存时间/缓存日期」（IMPLEMENTATION §5.4、STATE_V1:14），当前做不到。属于展示完整性问题。
- **建议**：取 coach-loop / goals / today / workout-plan / aggregate 各自 `cachedAt` 的最大值；缓存文案在有时间时显示日期（并明确不是服务端数据截止时间）。
- **验证**：已读代码。

#### R-08（P3）服务端只有聚合端点设 `no-store`；客户端当前不命中 HTTP 缓存，但防线单薄

- **位置**：`apps/api/src/server.ts:1325-1327`（`/training-plan-state` 设置 `Cache-Control: no-store`）；`:1317-1323`（`/mobile/today` 无）、`:1344-1347`（`/mobile/workout-plan` 无）、`:1530`（`/mobile/goals` 无）、run-coach 无。客户端：`APIClient.swift:93-99`（`URLSessionConfiguration.ephemeral`）、`:326-328`（每个请求 `reloadIgnoringLocalCacheData`）。
- **结论**：**客户端侧不会命中 URLSession HTTP 缓存**（临时会话 + 请求级忽略缓存），所以不是当前缺陷；但服务端未对 today/workout-plan/goals/run-coach 禁缓存是防御性缺口——任何未来客户端配置、调试代理或中间层都可能缓存这三类 GET，而「三个 GET 的 revision 相同 ≠ 同一事实快照」（ARCHITECTURE §2.1）会被缓存进一步放大，正好触发 R-02。
- **建议**：属 API 侧（见 02-api-write 报告）；客户端保持现状即可，但应在计划读取路径上继续显式 `reloadIgnoringLocalCacheData`，不要因为服务端补了 no-store 就放宽。
- **验证**：已读客户端与服务端代码。

#### R-09（P3）撤回 cleanup 只按 UUID 判断残留，不核对精确时刻

- **位置**：`PlanWatchScheduling.swift:287-292`（`cleanupVerified = !left.contains { ids.contains($0.workoutID) }`）；对照 `WorkoutKitBridge.swift:30-39`（`removeEntries` 按 UUID **且** `instant == scheduledAt` 才删除）；文档 STATE_V1:60 要求「UUID 与精确时刻逐项」。
- **触发**：系统清单出现同 UUID、不同 `scheduledAt` 的条目（本客户端每次生成新 UUID，实际概率极低；但 WorkoutKit 回读时刻若被系统规范化到不同精度/时区表示，也可能触发）。
- **后果**：这种残留会被判为「撤回已核验」，而实际条目仍在系统日程；与「强匹配」的文档措辞不一致（低概率，风险方向是**过度乐观**）。
- **建议**：`cleanupVerified` 要求 `left` 中不出现「UUID ∈ submitted 且 `instant == entry.scheduledAt`」的条目；对同 UUID 异时刻也按 residue 处理（或至少降级为未核验）。补一条 fake scheduler「同 UUID 不同时刻」回归。
- **验证**：已读代码；现有测试只覆盖「删除失败/未知 UUID/错时刻」，未覆盖「同 UUID 不同时刻残留」（见 `PlanWatchSchedulingRegression.swift:143-146`）。

#### R-10（P3）主线程强制 `as!` 转换（编码形状变化即 trap）

- **位置**：`APIClient.swift:185-186`（`jsonObject(...) as! [String: Any]`、`object["coachLoop"] as! [String: Any]`）；`NativeAppModel.swift:1284`（`publishPlan` 的 `as! [String: Any]`）。
- **风险**：当前 `receipt.coachLoop != nil` / `Input: Encodable` 都是 struct，运行时不可触发；但未来把某个 Input 改成顶层数组、或编码器行为变化，会在 MainActor 上直接 trap（整个 App 崩溃），而这条路径是发布/回执的关键路径。
- **建议**：用 `try JSONSerialization.jsonObject` + guard/cast + `RaiAPIClientError.decoding`，与项目其它错误处理一致。
- **验证**：已读代码；gates 类型检查通过，未做编码形状变异。

#### R-11（P3）今日页计划卡权威性与口径冲突（C1–C4）仍未决

- **位置**：`TechViews.swift:344-408`（「今日推荐训练」推荐卡 + 「锁定安排」）、`:427-490`（`planPhaseLine` 阶段卡：标题是阶段名、正文「本周 15–18 km · 长距离 ≤6 km · 质量课 ≤1」，头部 `adherence.status` 显示「按计划」但未标窗口，完成度行仍是「已完成 / 计划」未加「课表」限定）；`TechCoachWeekSection.swift`（计划页的「本周进度」同源展示）；`TechRunCoachView.swift:92-97`。
- **当前状态（对照 TODAY_PLAN_CARDS_REVIEW）**
  - C1（两张视觉同级卡、无权威说明）：**仍存在**。今日页 `recommendationPanel` 与 `planPhaseLine` 仍是两个 `TechPanel`，后者仍无任何动作/说明自己是「阶段信封」。
  - C2（阶段量带 vs 课表处方两个「本周」数打架）：**仍存在**；A1/A2 文案分层未落地（当前文案没有「阶段建议量带」「课表计划」字样）。
  - C3（「按计划」与「建议重新生成课表」同屏、窗口不写）：**仍存在**；`planPhaseLine` 直接渲染 `replan.reasons.first?.detail`，卡头 `adherence.status` 无窗口限定；服务端 `plan_below_phase_band` 判据未加。
  - C4（强度加权负荷 vs 里程依从性方向相反）：**仍存在**（服务端两套口径未交叉核对）。
- **定性**：该文档状态为「未决（本轮只诊断，未改任何代码）」，因此**不算文档漂移、不计缺陷**；但它是训练计划客户端当前最大的用户口径风险，建议在本轮整改中至少落 A1/A2 文案分层（`npm run test:ios` 的 tech presentation 门禁不检查这两句，需要新增断言并做突变验证），或在计划页明确「执行以今日推荐训练/手表课表为准」。
- **验证**：已读今日页/计划页视图；`TechPresentationRegression.swift` 与 `check-today-layout.py` 对 `periodization/adherence/replan` 有展示位与顺序锚点，但不校验这两句文案（与 TODAY_PLAN_CARDS_REVIEW §4 结论一致）。

### 补充观察（未单独编号，均不构成缺陷）

- `TechPlanWatchSection.swift:52` 用 `workoutPlanError ?? availability.message`：`workoutPlanError` 是原始 `LocalizedError` 文案（如「服务返回的数据版本不兼容：…」），与 `PlanAvailability` 的语义文案叠在一起，口径不完全统一；建议只保留 `availability.message`，错误细节进诊断。
- `PlanWatchSyncCoordinator.sync/clear` 对 `beginPlanSync` 返回 nil 统一提示「另一次计划操作尚未结束」，但 nil 还可能来自「未确认发布」「离线」（`NativeAppModel.swift:1216-1223`）；回执重试被 `hasPendingPlanReceipts`/`hasPendingPlanPublication` 挡住时用户会看到错误归因。建议 `beginPlanSync` 返回带原因的枚举。
- `commitWatchResult`（`NativeAppModel.swift:1601-1621`）返回 false 时 coordinator 追加「系统副作用后的本地账目提交失败」，但 false 也可能来自「清空未核验」（`clearVerified=false`）——此时本地账目并未提交失败，只是 SDK 清空未确认。建议按原因分开文案。
- `NativeAppModel.refreshRunCoach` 每次 `refreshAll` + 计划页 `.task` 都会触发旧合同 `refresh` 命令（D15 说明服务端幂等、事实不变不写修订），不构成缺陷，但重复命令次数值得在 API 侧观测。

---

## 4. 状态机与排期时序（文本）

### 4.1 读取状态机（`TrainingPlanStore`）

```
                 configure(scope:) / invalidate()
                 +------------------------------+
                 | epoch++ requestID++          |
                 | isCurrent=false              |
                 v                              |
  [unavailable] --refresh 开始--> [refreshing]   |
        ^                              |         |
        |                 +------------+---------+
        |                 |  valid()? requestID/epoch/scope/isValid/未取消
        |                 v
        |       +--- 聚合契约(planSnapshotContractVersion=1) ---> GET training-plan-state
        |       |        validate(identity/timezone/date/window/days/token/summary)
        |       |        成功 -> goals/today/workoutPlan/coach/metadata
        |       |                 minimumRevision=max(...,goalsRevision)
        |       |                 isCurrent=true; availability=.current|.empty
        |       |                 persist aggregate (展示缓存)
        |       |        失败 -> issue=.network(err); availability=.unavailable|.revisionMismatch
        |       |
        |       +--- 教练闭环(coachLoopContractVersion=1) ----> GET coach-loop
        |       |        validateCoachLoop(scope/token/facts/7日连续/授权/映射 exact)
        |       |        成功 -> coachLoop(settings!=nil) -> today=nil/workoutPlan=devicePlan(仅今天)
        |       |                 isCurrent=true; availability=.current|.empty|.savedAwaiting
        |       |        失败或回退 -> decoding（禁止降级旧协议）
        |       |
        |       +--- 旧协议(无能力位) -----------------------> GET goals + today + workout-plan
        |                validate 仅 revision/timezone/coach 状态（**无日期窗口校验，R-02**）
        |                成功 -> isCurrent=true; availability=.current（3 次独立读取，非快照）
        |                失败 -> partial goals 保留编辑上下文，执行仍不可用
        |
  [cached] <-- loadCache（只作参照，isCurrent=false，executablePlan=nil）
  [savedAwaitingRefresh] <-- acknowledge()/persistenceFailed/quarantine（写成功但未刷新）
  [revisionMismatch] <-- 409 / revision 不一致
```

关键不变量（已由测试钉住）：

- `minimumRevision` 只增不减；`acceptGoals/acceptCoach` 只接受 `revision >= revision`；迟到低 revision 被丢弃。
- `acknowledge()` 先 `invalidate()`（epoch++）再写水位，晚到的刷新必然失效（`TrainingPlanStoreRegression.swift:76-81`）。
- 取消/换 scope/换配置都不留下 `isCurrent` 或卡住的 spinner（:87-94）。
- 更高 `planSnapshotContractVersion` / `coachLoopContractVersion` fail-closed，不降级（:95-98, 152-154）。
- `executablePlan` 统一要求 `isCurrent && !persistenceFailed && knownCoachState && planRevision == revision`；教练闭环再加 `!refreshRequired && 当前业务日`。

### 4.2 系统排期（写入设备日程）

```
用户点「同步跑步课表到系统日程」
  |
  v
PlanWatchSyncCoordinator.sync   (全局 running=true；hasInterruptedSchedule 检查)
  |-- beginPlanSync()：isPlanBusy/离线/未确认发布 检查
  |-- refreshPlanState() 完整三读/聚合读 -> planSyncSnapshot(lease=id)
  |     (legacy 要求 today.localDate==当前业务日；coachLoop 要求 settings 且 !refreshRequired)
  |-- makeScheduleJournal(snapshot)：scheduleStateChanged -> previousEntries=本 scope ledger.entries
  |
  v
PlanWatchScheduling.sync
  1) isSupported -> authorization（notDetermined 才请求一次）
  2) 校验 plan.timezone / windowDays 1..14 / 逐日唯一
  3) owed = kind!=rest && localDate>=today && !completed && executable
     expired/alreadyTrained/filtered 分类
  4) 全量预检：executableMapping（exact/normalized/unsupported）+ scheduleComponents
     + instant + localDate 一致 + scheduler.prepare
     **任一必需日失败 -> validationError，整个替换不执行（旧日程不动）**
  5) journal.prepare(requests) -> 持久 .prepared            <-- 写前日志
  6) readBack() -> 系统现有条目必须全部 ∈ previousEntries，否则要求显式管理
  7) journal.persist(.clearing) -> removeEntries(previousEntries) -> readBack
     **清空未核验 -> skipped，不下发新训练**
  8) 逐条：persist(.scheduling, item=.submitting) -> schedule() -> persist(.returned)
     每个 await 边界重验 isCurrent lease
  9) persist(.verifying) -> readBack()
     hasOnlyRequestedEntries（未知/重复/额外条目 -> 不完整）
     confirm（UUID + 精确时刻 + contentMatches + !complete + 本地日期一致）
 10) 返回 outcome（confirmed/receipts/verified/clearVerified/superseded/storageError）
  |
  v
Coordinator 收尾
  |-- storageError 或 superseded  -> recordWatchInterrupted（保留/撤回风险）
  |-- isCurrentPlanSync 失效      -> withdrawSuperseded（定向删除本操作 UUID+时刻，读回）
  |-- commitWatchResult：journal.finish(verified/partial) + ledger + receipts 同事务
  |     失败 -> 保留非终态日志，要求重新核验
  |-- recordPlanSyncReceipts：逐条前台 POST；matchesCurrent=false 只影响当前 ledger；
  |     历史回执 → historicalReceipts；终局码 → 作废该条回执 + 标 ledger requiresWithdrawal
  |-- 回执期间再次失效 -> withdrawSuperseded -> recordWatchInterrupted
```

### 4.3 撤回与中断恢复

```
启动/变更：scheduleStateChanged()
   journal(非 terminal) -> interruptedSchedule  -> UI「中断，需核验/撤回」
   app_metadata/ledger/pending receipts 读取失败 -> scheduleStorageIssue（禁止新替换）
   未结束日志存在时 sync 直接拒绝；clear 允许（显式全部撤回）

clear（可离线）：
   makeClearJournal（复用中断 journal 或新 clear-all journal）
   prepareClear(.prepared) -> removeAll -> readBack
   空且当前且持久化 -> journal .verifying -> commitScheduleWithdrawal
        -> 同事务：journal.withdrawn + ledger=nil + 所有 scope 的 pending verified 转 withdrawn
   否则保留 withdrawalRequired 风险

recover（可离线）：
   读 journal -> 重建 requests（实际导出结构 + prescriptionDigest 校验，失败只能撤回）
   核验：强匹配清单；清单异常保留原 ledger/journal，不登记新回执
   撤回：removeAll 或 removeEntries(items 非 prepared + previousEntries) -> readBack
   合法部分恢复仍保留非终态；旧 replaced 事件与新回执/ledger/journal 同事务提交
```

---

## 5. 与文档契约的偏差 / 未决项

| 文档口径 | 代码现状 | 判定 |
| --- | --- | --- |
| STATE_V1 §读取契约：「新客户端验证完整身份、所有版本一致、时区、真实日期、逐日唯一且连续、窗口长度和首末日期；缺安全字段拒绝执行」 | 聚合路径与教练闭环路径已实现且测试覆盖；**旧协议路径只校验 revision/timezone/coach 状态**（R-02） | 旧协议属文档明示的兼容降级（「旧服务最多两轮重读」「不宣传强事实一致性」），但本地可做的日期/窗口校验缺失，且 current 语义被高估 → P2 |
| STATE_V1 §发布操作：「未确认结果阻止新的发布；查询原操作而不是提高 expectedRevision」 | `publishPlan` 先持久化 `PendingPlanPublication` 再提交；查询/重放路径遵守 `committed/scopeMismatch/notFound/expired`；`finishPlanPublication` 在本地确认失败时保留账目 | 一致 |
| STATE_V1 §排期写前日志：完整快照 → 预检 → prepared → clearing → 清理 → 逐条 submitting → schedule → returned → verifying → 强回读 → 原子提交；日志写失败停止副作用 | 与 `PlanWatchScheduling.sync` 逐行对应；测试含 3 个注入终止点 + 日志失败先于副作用 + 部分/清空失败/容量/必需目标拒绝 | 一致 |
| STATE_V1 §回执版本 2：必需字段、幂等、历史隔离、`matchesCurrent=false` 只影响当前 ledger | `PlanSyncReceipt.hasRequiredVerificationFields` 校验字段；`matchingLedger` 用 scope+revision+UUID+localDate+精确时刻隔离；终局码白名单 → 作废该条不碰历史 | 服务端登记侧一致；但**客户端线格式导致 v2 登记失败（R-01）**，属实现缺陷而非契约偏差 |
| STATE_V1 §读取故障：cache 结果分五类；安全账目损坏不作空数组；清缓存不清水位/日志/ledger/待登记回执 | `CacheReadResult` 五类；写入路径均先 `isFailure` 检查；`clear/clearAll/prune` 只碰 `cache_entries`；`hasPendingPlanReceipts`/`hasPendingPlanPublication` 读失败即 true（fail-closed） | 一致（`pendingPlanReceipts`/`watchLedger()` 仍保留 nil 兜底 getter，但已无消费方用于决策；见 §7） |
| IMPLEMENTATION §2：SQLite 落盘失败 → 本会话 fail-closed + UserDefaults quarantine；联网完整读回后确认成功才解除；UI 显示「服务端已保存，本地确认记录未持久化」 | `acknowledge()` 失败写 quarantine（`rai.plan-write-unpersisted.<scope>`），`restoreSafety` 读回并置 `persistenceFailed`，`presentation` 的 reference 被 `!persistenceFailed` 挡住；在线确认成功才清 key；`TechPlanWatchSection` 显示该文案 | 一致 |
| COACH_LOOP §7：只导出今天已发布的完整课；追加 decisionRef/执行令牌进入日志/回执/恢复/撤回；不因网络失败重发 UUID | `CoachLoopResponse.devicePlan` windowDays=1；`PlanScheduleOperationJournal.coachLoop`；`enrichPlanReceipts`/`recordRecoveredSchedule` 保留 coachLoop 上下文；重试/恢复复用 journal 的 UUID | 一致（但 v2 登记线格式问题同样影响教练闭环之外的路径，见 R-01） |
| TODAY_PLAN_CARDS_REVIEW：C1–C4 与 A1–A3 | 全部未落地（文档状态「未决」，非漂移） | 未决产品项，R-11 |
| ARCHITECTURE §2.1：`readMetadata` 仍 `try?` → nil，`pendingPlanReceipts` 把 nil 转空数组 | `CacheStore.pendingPlanReceipts` 仍 `?? []`；但所有决策方改为读 `...Result` 的 `isFailure`，写路径先检查 `isFailure`，该 getter 当前无消费方 | 风险已降级为「潜在 API 陷阱」，未见实际路径 → 不计缺陷，建议删除/标注 deprecated |

**文档漂移**：未发现「文档声称已修复但代码没有」的条目。上述 R-01/R-02/R-04/R-05/R-06 是文档未覆盖或实现与更严格口径之间的差距，不是文档虚报。

---

## 6. 未覆盖 / 需真机或真实服务验证

1. **R-01 的真实 HTTP 行为**（500 vs 422、不同 kind/结构下的具体码）未在隔离 API 上执行；本报告只做了静态代码 + 同仓库 TS 函数复算。建议用隔离 control DB + 老/新能力组合的 API 实例跑一次 `/v1/mobile/workout-plan/synced`（coachLoop 缺失、v2、结构含 nil warmup）确认。
2. **物理 iPhone + Apple Watch**：UUID/规范化时刻稳定性、读回延迟、真实表端可见性、授权 notDetermined/denied/restricted、运行期部分成功、定向/全部撤回、每个副作用后强杀重启、跨午夜、旧/新服务组合——均未执行（STATE_V1 §验证与仍须设备证据 retained）。
3. **Simulator 视觉/UI 验收**：`apps/ios/tests/run-visual-tests.sh` 未运行（本审查只跑了 gates；视觉脚本需 booted Simulator 与隔离服务）。
4. **WorkoutKitBridge 实际行为**：gates 只做真实 SDK 类型检查，不执行 `WorkoutScheduler`；`removeEntries`/`readBack`/`contentMatches` 的真实系统语义未在设备上验证。
5. **提醒的跨时区/跨午夜真实通知触发**：只验证了纯函数 `slots`；`UNUserNotificationCenter` 排队、去重、时区变更后的行为未测。
6. **R-06 跨时区设备**：需要用非 Asia/Shanghai 时区设备/模拟器构造午夜边界，核对 raceTarget 保存日期与倒计时。
7. **后台/终止注入**：gates 的排期回归用 fake scheduler + 存储写失败模拟终止；真实「Side effect → 进程被杀 → 重启恢复」未在设备上演练（文档已列为发布门槛）。

---

## 7. 「看起来像缺陷但已核实安全」的项（避免误报）

- **展示缓存不覆盖安全账目**：`CacheStore.clear(scope:)`/`clearAll()`/`prune()` 只操作 `cache_entries`；水位在 `plan_write_acknowledgements`、ledger/发布账目/待登记回执/日志在 `app_metadata` / `plan_receipt_journal`。`StoreRegression.swift:264-310` 覆盖清缓存/重开/故障注入。
- **迟到聚合/迟到回执不能回退**：`acknowledge()` 先 bump epoch；`acceptGoals/acceptCoach/refresh` 均有 `>= revision` 守卫；`acknowledgePlanWrite` 的 SQL `WHERE excluded.revision >= ...` 防降级写；测试覆盖。
- **清空伪成功**：`clearVerified = afterClear.isEmpty`；`withdrawSuperseded`/`recover` 都重新读回；测试覆盖 silent clear failure / unknown entry / duplicate / wrong time / content / complete。
- **回执历史隔离**：`matchingLedger` 要求 scope+revision+UUID+localDate+精确 scheduledAt；`matchesCurrent=false` 只标当前 ledger；历史回执只记 `historicalReceipts`；`STATE_V1` 回归在 2026-10-09 记录中已覆盖（gates 74 项含此项）。
- **`pendingPlanReceipts`/`watchLedger()` nil→[] 兜底**：仍存在（`CacheStore.swift:211-232`），但决策路径均使用 `…Result().isFailure`（`NativeAppModel.swift:1275-1278, 1418-1421, 1540-1543`），写路径先检查 `isFailure`；未找到「账目损坏被当空数组覆盖」的可达路径。
- **教练闭环回滚**：`refresh` 在 `coachLoop?.settings != nil` 且服务端不再宣告 `coachLoopContractVersion` 时直接拒绝并提示「旧协议执行禁止，旧排期需显式撤回」（`TrainingPlanStore.swift:211-213`），测试 `AC4-12/AC0-21` 覆盖；更高版本 fail-closed。
- **未知枚举 fail-closed**：`MobileStepGoal` 未知 type 解码失败（`PlanWatchSchedulingRegression.swift:189-190`）；教练 plan status 未知不解释成 active（`knownCoachState` + `presentation` 过滤）；今日页 `canConfirmToday` 要求业务日一致。
- **`PlanWatchScheduling.sync` 侧 `before.allSatisfy(previousIDs)` 只比 UUID**：看似弱于文档「UUID 与精确时刻」，但同 UUID 异时刻的旧条目无法被 `removeEntries` 删除 → `afterClear.isEmpty` 为 false → 清空不核验 → 不下发新训练；方向安全，不算缺陷（残留判断见 R-09 只影响「撤回 cleanup」的成功判定）。
- **`PlanMutationDisposition` 不收 `coach_receipt_unknown_*`**：注释已说明服务端事实推进后同一回执可能通过，保留重试是安全方向；与文档一致。
- **`TrainingReminders` 去重/时区**：identifier 前缀 + epoch，reconcile 先清本前缀 pending/delivered 再按 plan.timezone 绝对时刻排；`slots` 做了真实日期往返校验、7 日窗口、完成集合过滤；纯函数测试通过。

---

## 8. 建议的修复优先级

1. **R-01（P1）**：v2 回执统一显式 null 编码 + 线格式回归（阻断回执误判/永久待登记/无法切换教练闭环）。这需要和 API 侧 R-1（回执 v2 规范化校验过严）协同：任一侧修都能止血，但两侧都应补回归，避免将来互相回退。
2. **R-02/R-04（P2）**：legacy 本地安全校验 + 能力协商单点化（状态所有权与 fail-closed 语义）。
3. **R-03（P2）**：错误分类与 UI 文案分离（避免误导升级/重试）。
4. **R-05/R-06（P2）**：提醒在教练闭环下的真实语义 + 赛事日期统一业务时区。
5. **R-07–R-11（P3）** 与 §3 补充观察可在同一批文案/防御性修复中处理。

> 本报告所有结论基于 2026-10-18 工作区源码与 gates 结果；未修改仓库源文件（唯一新增文件即本报告）。
