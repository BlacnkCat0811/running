# 训练计划写入 / 发布 / 回执链路审查（API 侧）

- 审查日期：2026-10-18（Asia/Shanghai）
- 审查者：api-write-reviewer（只读审查，未修改仓库文件；临时脚本在 `/tmp/rai-review/`）
- 审查对象：`apps/api/src/*` 中训练计划写入、发布操作、回执登记链路，以及 iOS 客户端与之对接的线格式（只读派生，不修改 iOS 代码）
- 承诺基线：`docs/IOS_TRAINING_PLAN_STATE_V1.md`（发布操作、回执版本 2、写前日志）、`docs/IOS_TRAINING_PLAN_IMPLEMENTATION.md`、`docs/COACH_LOOP_IMPLEMENTATION_STATUS.md`、`docs/DECISIONS.md`（D5/D13/D15/D16）
- 结论口径：每条发现区分「已证实（代码路径 + 复现）」「待确认（需 HTTP/设备证据）」；文档已声明的限制标为 known limitation，不计缺陷。

---

## 1. 审查范围

必读文件全部逐行阅读：

| 文件 | 关注点 |
| --- | --- |
| `apps/api/src/plan-publication.ts`（24 行） | `PlanOperationError`、`publish` 身份校验、`result` |
| `apps/api/src/mobile-goals.ts`（1134 行） | `publicationOperation` / `publicationResult` / `recordPlanPush` / `planPushIsActive` / `activePlanPushes` / `planHistory` / `write` / `writeControlGoals` / `retireLegacyModelPlan` / CAS |
| `apps/api/src/server.ts`（2113 行） | goals PUT（1522-1581）、lock/relock（1583-1612）、coach command（coach-loop、run-coach）、preview（1434-1460）、confirm（1461-1475）、`/v1/mobile/workout-plan/synced`（1203-1246）、`/v1/mobile/plan-operations/:id`（1330-1333）、mutation 路由注册表（307-333）与 preHandler 门禁（380-430）、全局错误处理（2049-2060） |
| `apps/api/src/mutation-coordinator.ts`、`write-lease.ts`、`dataset-epoch.ts`、`restore-journal.ts` | busy 门禁、写租约、数据集 epoch 与恢复日志 |
| `apps/api/src/coach-loop-runtime.ts`（498）、`coach-loop-routes.ts`（86）、`coach-loop-device-sync.ts`、`run-coach.ts`（410） | 教练命令/设备回执的发布事务、写入前校验 |
| `apps/api/src/weekly-plan-preview.ts`（27）、`manual-plan-policy.ts`（64） | 预览 15 分钟、候选 fingerprint、人工课表策略 |
| 辅助：`plan-digest.ts`、`session-structure.ts`、`schemas.ts`、`api-error.ts` | 摘要与规范化、请求 schema、错误映射 |
| 测试 | `mobile.test.ts`、`mobile-plan-sync.test.ts`、`coach-loop*.test.ts`、`mutation-coordinator.test.ts`、`request-mutation-lifetime.test.ts`、`coach-manual-compatibility.test.ts`、`server-runtime.test.ts`（发布/回执段） |

**定向测试结果**（`node --import tsx --test`，未跑全量）：

- `mobile-plan-sync.test.ts`、`mutation-coordinator.test.ts`、`request-mutation-lifetime.test.ts`、`coach-loop.test.ts`：通过（合计 27 项通过）。
- `mobile.test.ts`、`coach-loop-device-sync.test.ts`、`coach-loop-runtime.test.ts`、`coach-loop-runtime-safety.test.ts`、`coach-manual-compatibility.test.ts`：**测试文件无法加载**（`onnxruntime-node` 的 `onnxruntime_binding.node` 在本机因代码签名 `ERR_DLOPEN_FAILED` 被拒，属主机环境问题，不是断言失败）。这 5 个文件中与写路径相关的断言未执行，见 §5「未覆盖项」。
- 合成用例（`/tmp/rai-review/probe1/3/4.mjs`，隔离临时目录 + 隔离 control DB，不触碰真实健康库）覆盖：发布幂等/冲突/跨域/回滚/重启/90 天边界/回执身份，见各发现「证据」。

---

## 2. 结论摘要

链路主干的原子性与幂等设计是成立的，**已实测证实**：

- `goals` / `lock` / `confirm` / `run-coach` / `coach-loop` 共用 `PlanPublicationService.publish` → `MobileGoalsStore.publicationOperation`，业务数据（`mobile_goals`）、历史（`mobile_goals_history`）与操作结果（`mobile_plan_operations`）在**同一个 `BEGIN IMMEDIATE` 事务**提交；`action()` 抛错时三者全部回滚，`cached` 与读缓存被清空（probe1：revision / history / operation 行均无变化；同键可重试成功）。
- 同键同请求返回冻结的原结果（probe1：action 只执行一次，返回初次结果；服务重启后 `GET /plan-operations/:id` 仍为 `committed`，同键重放不再执行）；同键不同请求 `plan_operation_key_conflict` 409；跨路由（`goals` vs `lock`）同样被 digest 拒绝；跨 scope（另一 `datasetEpoch`）在 `publicationOperation` 内被 `plan_operation_scope_mismatch` 拒绝；`PlanPublicationService.publish` 在进事务前还按 `operationScope` 摘要做了一次身份校验（`plan-publication.ts:14-17`）。
- 完整结果 90 天、过期即 tombstone：`expires_at = 提交时刻 + 90×86400_000`，判定为 `Date.parse(expires_at) <= Date.now()`（**恰好 90 天即过期**）；过期后 `result_json` 置 NULL、保留 `request_digest`，`GET` 返回 `expired`，写入重放返回 410 `plan_operation_expired`（probe1 全部通过）。
- CAS 无丢更新窗口：`write()` 用读到的 `current.revision` 作 `expectedRevision`，`writeControlGoals` 在事务内 `UPDATE ... WHERE singleton=1 AND revision=?` 并检查 `changes===1`，失败抛 `MobileGoalsRevisionConflictError`；发布路径下该 CAS 与 operation 结果同事务，非发布路径下 CAS 与历史追加同事务（`mobile-goals.ts:826-859`）。合成测试未发现丢更新。
- 请求 schema 层：`Fastify({ ajv: { customOptions: { removeAdditional: false } } })`（`server.ts:190-192`）+ `additionalProperties:false`，客户端无法通过 body 注入 `matchesCurrent` / `coachLoop` 等内部字段；回执 `timezone` 是 `const DATABASE_TIMEZONE`，非法时区在 schema 层就被拒，不会触发 `Intl` 异常。

**主要问题**集中在两处：

1. **回执 v2 的「结构已规范化」校验与 iOS 实际线格式不兼容**（R-1，P1）：Swift `Codable` 省略 nil 可选字段，而服务端要求 `digest(normalizeSessionStructure(structure)) === digest(structure)`；凡含「无 alert 的步骤」的回执会被 422 终局拒绝（客户端随即丢弃回执并把当前排期标为需撤回），若 `warmup`/`cooldown` 键缺失则 `prescriptionDigest` 直接 `TypeError` → **500**。
2. **`MobileGoalsRevisionConflictError` 缺少 `statusCode`，`/v1/mobile/coach-loop` 与 `/v1/mobile/lock` 未捕获**（R-2，P1）：一个常规的「版本已变化」被映射成 `500 internal_error`，客户端拿不到 `mobile_goals_revision_conflict`，带 operationId 的待确认发布因「500 非 4xx」不清账，会永久重放同一份过期 payload。

其余 P2/P3 见 §3。未发现 P0（未发现数据损坏、静默改写历史或跨身份执行的现象）。

---

## 3. 发现

### R-1（P1）回执 v2 结构校验与 iOS 线格式不兼容：合法回执被 422 终局拒绝，或触发 500

**位置**

- `apps/api/src/server.ts:1216-1220`（`/v1/mobile/workout-plan/synced` 的 v2 校验谓词）
- `apps/api/src/plan-digest.ts:18-24`（`prescriptionDigest` 的 `step()` 不处理 `undefined`）
- `apps/api/src/session-structure.ts:61-83`（`normalizeAlert` 会重排上下界）、`:123-135`（`normalizeSessionStructure` 补齐 `alert:null`）
- 客户端侧：`apps/ios/RAI/APIClient.swift:101`（`JSONEncoder()` 默认配置）、`:176-196`（只有 `coachLoop != nil` 才补显式 null）、`apps/ios/RAI/PlanWatchSyncCoordinator.swift:36`（非教练客户端同样以 v2 回执发送）、`apps/ios/RAI/PlanMutationDisposition.swift:33-42`（`plan_receipt_evidence_mismatch` 属终局码）、`apps/ios/RAI/NativeAppModel.swift:1499-1510`（终局即丢弃回执 + `requiresWithdrawal = true`）

**现象**

服务端对 v2 回执要求「结构必须已经是 `normalizeSessionStructure` 的规范化形态」：

```ts
// server.ts:1209-1220
let matchesCurrent: boolean | undefined;
if (body.contractVersion === 2) {
  const required = [body.scope, body.operationId, body.coherenceToken, body.workoutID, body.scheduledAt,
    body.verifiedAt, body.timezone, body.prescriptionDigest, body.lifecycleEvent, body.structure];
  if (required.some(value => value == null) || body.revision == null) throw new PlanOperationError("plan_receipt_contract_mismatch", ...);
  if (digest(body.scope) !== digest({ serverId, athleteId, datasetEpoch })) throw new PlanOperationError("plan_receipt_scope_mismatch", ...);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: body.timezone, ... }).format(new Date(body.scheduledAt!));
  if (date !== body.localDate || Date.parse(body.verifiedAt!) > Date.now() + 300_000 ||
      prescriptionDigest(body.kind, body.structure!) !== body.prescriptionDigest ||
      digest(normalizeSessionStructure(body.structure)) !== digest(body.structure)) {   // ← 严格相等
    throw new PlanOperationError("plan_receipt_evidence_mismatch", "日期、核验时刻或实际导出摘要不匹配。", 422);
  }
```

而 iOS 用默认 `JSONEncoder()` 编码 `PlanSyncReceipt`：Swift 合成 `Codable` 对 nil 可选字段**省略键**（`MobileWorkoutStep.alert`、`MobileSessionStructure.warmup/cooldown`，见 `APIModels.swift:409-413、398-402`）。`prescriptionDigest`/`normalizeSessionStructure` 会把「键缺失」当成「值为 null 但键存在」的不同 JSON：`stableJson` 保留 `"alert":null` 键，而缺键不保留 → 摘要不同。

客户端自己也知道这一点：`APIClient.recordPlanSync` 只在 `receipt.coachLoop != nil` 时手工把 `warmup/cooldown/alert/lower/upper` 补成 `NSNull`（`APIClient.swift:181-196`，注释原文「Synthesized Codable omits nil optionals. The new contract needs an explicit null decisionRef ... canonical null alerts/bounds」），**非教练分支（`/v1/mobile/workout-plan/synced`）直接 `send` 原始 Codable**（`:199-203`）。

**证据（已证实，谓词级复现）**

用与路由完全相同的谓词与函数复现（`/tmp/rai-review/probe3.mjs`）：

```text
swift-shaped (nulls omitted)          -> 500 internal_error (TypeError: Cannot read properties of undefined (reading 'purpose'))
api-shaped   (explicit nulls)         -> ACCEPT
warmup present / cooldown null        -> 422 plan_receipt_evidence_mismatch
```

- 缺 `warmup`（或 `cooldown`）键时，`prescriptionDigest` 的 `step(value)` 只判断 `value === null`，`undefined` 进入 else 分支后读 `value.purpose` 抛 `TypeError`（`plan-digest.ts:18-19`），全局错误处理把它映射成 `500 internal_error`。
- 保留 `warmup` 但某步骤缺 `alert` 键时：`prescriptionDigest` 一致（`alert` 用可选链），但 `digest(normalize(structure)) !== digest(structure)` 成立 → 422 `plan_receipt_evidence_mismatch`。
- 规范化本身不是幂等的语义等价：`normalizeAlert` 会在 `lower > upper` 时交换上下界（`session-structure.ts:69-73`），而 mapper 明确把「上下界重排」视为合法导出（`WorkoutPlanMapper.swift:69-71`，`differences: ["target_bounds_reordered"]`）——这类合法回执同样被 422。
- 服务端测试未覆盖该形状：`server-runtime.test.ts:2150-2164` 用 `structure: day.structure`（JS 对象，显式含 `null`）构造回执，因此通过；`/_synced` 无其他 HTTP 级测试。iOS 回归只对 `coachLoop` 分支断言了显式 null（`ModelRegression.swift:1818-1823`），没有非教练分支的线格式断言。

**影响**

- 常规计划（未启用新版教练）的 v2 报工回执在真实 App 上会被 422 终局拒绝：`PlanMutationDisposition.terminalPlanReceiptErrorCodes` 含 `plan_receipt_evidence_mismatch`（`PlanMutationDisposition.swift:33-42`）→ 客户端**删除待登记回执**，并把当前排期标为 `requiresWithdrawal`/`watchState = .stale`（`NativeAppModel.swift:1499-1510`）——用户被引导撤回一个实际正确的排期；服务端没有登记「已核验排期」，执行关联（`workout-segments.ts` 的 push 候选）缺失。
- 若结构缺少 `warmup/cooldown` 键（手工课表、或客户端未来版本省略更多可选键），则得到 500 `internal_error`；该码不在客户端终局清单里 → 无限重试，`hasPendingPlanReceipts` 恒真，永久阻塞教练启用（`NativeAppModel.swift:437`）。

**建议**

1. 服务端把「线格式宽容、语义校验严格」分开：先做 `const normalized = normalizeSessionStructure(body.structure)`，用 **normalized** 计算 `prescriptionDigest` 与 `digest` 比对，并把 `normalized`（而不是原始 body）落库；对 `prescriptionDigest` 增加 `undefined` 防御（`step()` 用 `value == null`）。
2. 若坚持「回执必须是规范化形态」，则必须在客户端**所有**回执路径统一补显式 null（把 `APIClient.recordPlanSync` 的 coach 分支补丁提取为对任意 `PlanSyncReceipt` 都执行的 wire 归一化），并增加一条以「Swift 编码形状」为输入的 TS 回归（缺 `warmup/cooldown/alert` 键）。
3. 补一条 HTTP 级用例：`/v1/mobile/workout-plan/synced` 用「省略可选 null」的结构断言 200（或明确 422 的错误码 + 客户端终局处置），锁死该契约。

**验证状态**：已证实（谓词级复现 + 客户端代码路径）；HTTP 端到端未跑（见 §5）。

---

### R-2（P1）`MobileGoalsRevisionConflictError` 无 statusCode，coach-loop/lock 路由未捕获 → 500 且待确认发布永不结清

**位置**

- `apps/api/src/mobile-goals.ts:871-876`：

```ts
export class MobileGoalsRevisionConflictError extends Error {
  readonly code = "mobile_goals_revision_conflict";
  constructor(readonly currentRevision: number) {
    super("训练目标已在其他页面更新，请重新加载后再保存");
  }
}
```

- 未捕获点：`apps/api/src/coach-loop-routes.ts:27-28`（`async request=>args.runtime.command(request.body)`，无 try/catch）→ `apps/api/src/coach-loop-runtime.ts:104-106` 在发布 action 内 `if (goals.revision !== command.expectedRevision) throw new MobileGoalsRevisionConflictError(...)`；`apps/api/src/server.ts:1583-1612`（`/v1/mobile/lock`）→ `mobileGoalsStore.lockSession` → `writeControlGoals` CAS 失败。
- 对照：`/v1/mobile/goals`（server.ts:1566-1575）、`/v1/mobile/run-coach`（run-coach.ts:404-407）、`/v1/mobile/workout-plan/confirm`（server.ts:1472-1475）、`generate`（server.ts:1489-1494）都显式把该错误映射成 409 + `mobile_goals_revision_conflict`。
- 全局映射：`apps/api/src/api-error.ts:20-33`（无 `statusCode` ⇒ 500，body code 被压成 `internal_error`）。

**证据（已证实，映射实测）**

`/tmp/rai-review/probe1.mjs`：

```text
stale expectedRevision inside publish -> revision conflict
  MobileGoalsRevisionConflictError code=mobile_goals_revision_conflict status=500 bodyCode=internal_error
  body={"code":"internal_error","message":"本地服务处理请求失败"}
```

即：同一个错误类在 goals 路由是 409 + 可读 code，在 coach-loop 路由是 500 + `internal_error`。

**影响**

- 客户端契约要求「未确认结果阻止新的发布；查询原操作而不是提高 expectedRevision」（基线文档 §发布操作）。`internal_error` 既不是 4xx、也不在 `terminalPlanPublicationErrorCodes`，客户端 `publishPlan` 的清理条件是「4xx 且 code 不以 `plan_operation_` 开头」（`NativeAppModel.swift:1305-1307`），因此 pending publication 保留；下一次 `resolvePendingPublication` 查到 `notFound` → 重放**同一份** payload（含过期 `expectedRevision`）→ 再次 500，形成永久循环；`plan_publication_pending` 守卫（`:1288-1291`）从此拒绝该 scope 的所有计划写与排期。
- 触发条件：coach-loop 命令的 `expectedRevision` 在客户端读与请求之间被另一写者改变（多客户端/另一设备、丢响应后重放旧 payload、或服务端状态被后台推进）。不是日常路径，但一旦发生无自愈出口（除非用户清缓存/放弃）。
- `/v1/mobile/lock` 同族：CAS 冲突（跨进程写者）会 500，而不是 409。

**建议**

1. 给 `MobileGoalsRevisionConflictError` 加 `readonly statusCode = 409`（与 `WeeklyPlanConfirmationRequiredError`、`PlanPreviewError` 一致），这样任何漏捕获点也至少是 409 + `mobile_goals_revision_conflict`。
2. 在 `/v1/mobile/coach-loop` 路由补与 goals 相同的 catch（409 + currentRevision），lock 路由同样处理 CAS 冲突。
3. 在 `server-runtime.test.ts` 增加「coach-loop 过期 revision → 409 + code」的 HTTP 断言，防止再次回归。

**验证状态**：已证实（类定义缺失 + `apiErrorPayload` 实测 + 路由无 catch；触发条件为读代码推导）。

---

### R-3（P2）回执身份按字节比较：等价 ISO 时刻 / UUID 大小写被当作不同系统条目

**位置**

- `apps/api/src/mobile-goals.ts:484-497`（v2 以 `json_extract(payload,'$.workoutID') = ?` 且 `scheduledAt = ?` 精确匹配）
- `apps/api/src/mobile-goals.ts:498-525`（幂等键分支比较 `original.scheduledAt !== input.scheduledAt`）
- `apps/api/src/mobile-goals.ts:526-534`（同事件早退同样精确匹配）
- `apps/api/src/mobile-goals.ts:556-563`（`planPushIsActive` 精确匹配）
- `apps/api/src/server.ts:1218`（`scheduledAt` 只按 schema `format: date-time` 接受，未规范化后存储）

**现象**

服务端从不规范化 `scheduledAt`/`workoutID`：同一瞬间的 `2026-10-19T07:00:00+08:00` 与 `2026-10-18T23:00:00Z` 是两条不同记录，撤回事件只停用「同字符串」的那一条。

**证据（已证实，合成用例）**

`/tmp/rai-review/probe4.mjs`：

```text
equivalent ISO instant: active(+08:00)= true active(Z)= false | rows= 2
```

即：先登记 verified(`+08:00`)，再登记 withdrawn(`Z`)，`planPushIsActive(verified 的字符串)` 仍是 `true`，`activePlanPushes()` 继续把它计为占用（`coach-loop-runtime.ts:202-221` 的 `unresolvedDeviceReservations` 与 `workout-segments.ts:380-390` 的 `validUntil` 都依赖该身份）。

**影响**

- 只要同一系统条目的 `scheduledAt`/`workoutID` 拼写发生变化（另一客户端、或 App 升级更换 `ISO8601DateFormatter` 选项、或引入毫秒），撤回/替换事件就不再停用旧回执：教练决策会看到「未解决的设备占用」，`matchesCurrent`/`activePlanPushes` 可能误判，用户看到陈旧排期与额外占用。
- 文档第 70 行明确「UUID 大小写与等价 ISO 时刻表示不改变身份」。该句位于「历史回执重试与当前排期状态隔离」段落，实现归属在 iOS ledger（`PlanReceiptMatcher.matches` 用 `UUID(uuidString:)` 与 ISO 解析后比较 Date，`:20-27`），服务端未镜像这一语义 → 服务端与客户端对「同一条目」的定义不一致。

**当前影响程度**：待确认。iOS 现有序列化是固定形状（`ISO8601DateFormatter()` 默认 UTC 无毫秒、`UUID.uuidString` 大写），单一客户端下不会触发；属于跨客户端/升级兼容风险。

**建议**

- 服务端在 `recordPlanPush` 入口把 `workoutID` 规范化为大写、`scheduledAt` 解析为 Date 后规范化为 UTC ISO（保存规范化值，并同时用于所有查找/去重 SQL）；读路径同样规范化输入。
- 若决定保持字节身份，则文档应删去「等价 ISO 时刻表示不改变身份」的服务端暗示，明确该保证只在 iOS ledger 内成立。

**验证状态**：服务端行为已证实；影响待确认（取决于客户端序列化是否变化）。

---

### R-4（P2）`/synced` 的 `matchesCurrent` 在控制库事务外计算，存在 TOCTOU

**位置**

- `apps/api/src/server.ts:1221-1225`（在 `withReadStore(...)` 里读取当前训练计划快照并算 `matchesCurrent`）
- `apps/api/src/server.ts:1228-1244`（随后 `mobileGoalsStore.recordPlanPush(...)` 另开 `BEGIN IMMEDIATE` 写入）

**现象**

`matchesCurrent` 依赖 `current.metadata.goalsRevision`、`coherenceToken`、当天 `kind`/`prescriptionDigest`，这些来自主库读快照；写完主库快照到控制库插入回执之间没有锁，另一个发布（goals PUT / confirm / coach 命令）可以提交，使「回执登记的核验结论」对应的是一个已被替换的 revision。

**影响**

文档第 66 行要求「当前覆盖还必须匹配当前处方与事实令牌」。实现只在**计算瞬间**匹配：可能在计划已变更后仍把 `matchesCurrent=true` 落库（或相反，把刚恢复的当前计划标 false）。客户端据此决定 `requiresWithdrawal`（`NativeAppModel.swift:1476-1486`），错误方向会误导用户；下一次刷新通常能纠正，但「已登记回执」本身不再可重算。

**建议**

- 把「读取当前快照 + 计算 matchesCurrent + 插入回执」放进同一个 `publicationOperation`（或至少先拿控制库写锁、再读主库快照），并在同一事务内复算一次；文档也明确该结论的时点。

**验证状态**：代码路径已证实；实际触发窗口窄，影响待确认（未构造并发 HTTP 用例）。

---

### R-5（P2）回执幂等/去重键不完整：v2 幂等键分支与 v1 分支都不比较 scope，重复登记早退不比较 localDate

**位置**

- `apps/api/src/mobile-goals.ts:483-497`：v2「同 UUID+时刻」冲突比较**有** scope，但只在该 block 命中时执行。
- `apps/api/src/mobile-goals.ts:498-525`：幂等键命中的分支比较 `local_date/revision/kind/workoutID/scheduledAt/lifecycleEvent/prescriptionDigest/structure`，**不含 scope**；v1 分支（515-523）更只比较 payload（v1 body 无 scope 字段）。
- `apps/api/src/mobile-goals.ts:526-534`：`repeated` 早退只按 `workoutID+scheduledAt+lifecycleEvent`，不比较 `localDate`（也不同时验证结构）。
- `apps/api/src/mobile-goals.ts:732-734`：`idx_mobile_plan_pushes_idempotency` 是**全局**表达式唯一索引（`json_extract($.idempotencyKey)`），不按 scope 分区。

**证据（已证实，合成用例）**

`/tmp/rai-review/probe4.mjs`：

```text
different localDate accepted as same entry: true recordedAt= 2026-10-19T00:00:00.000Z
```

即同 `workoutID+scheduledAt+lifecycleEvent`、不同 `localDate` 的回执被当成重复，返回原 `pushedAt` 且不写新行。跨 scope 场景为读码推导：scope A 先登记 `idempotencyKey=K`；scope B（恢复/删除后 epoch 变更）以同键同内容发送时，v2 幂等分支只比较内容与 localDate → 相同 → 直接返回 A 的 `pushed_at`，B 域没有回执行；若内容不同则返回 409 `plan_receipt_key_conflict`（客户端视为终局，丢弃回执）。

**影响**

- 数据域切换（备份恢复/删除后重建）或同机多数据集场景下，v1 回执会被静默去重（服务端返回「已记录」但当前域查不到该推送）；v2 只在同 UUID+时刻时才有 scope 保护。
- `localDate` 不在身份内虽然当前不可能产生两条不同 localDate 的合法回执（路由用 `scheduledAt → Asia/Shanghai` 反算并强校验），但会让「重复登记」早退跳过 `localDate` 校验，使未来放宽时区/重试路径时出现隐患。

**建议**

- 把 scope（或 `serverId/athleteId/datasetEpoch`）加入幂等键与唯一索引的组成（例如索引表达式改为 `(scope, workoutID, scheduledAt, lifecycleEvent)` 或对 v1 也写入 scope），并在 `repeated` 早退前比较 `localDate`。
- 数据域切换后的旧回执语义（拒绝 vs 静默去重）写进文档，并在客户端按该语义处理。

**验证状态**：`localDate` 部分已证实（合成用例）；跨 scope 去重为读码推导，待确认。

---

### R-6（P2）数据库未就绪时，`goals` PUT 完全跳过 manual-plan-policy 校验（含冻结日期保护）

**位置**

- `apps/api/src/server.ts:1522-1581`（`PUT /v1/mobile/goals`）：`if (request.body.weekPlan !== undefined && databaseIsReady()) { ... options.validate = candidate => validateManualPlan(...) }`（`:1550`）
- `apps/api/src/server.ts:307-333`：`/v1/mobile/goals` 属 `metadataOnlyMutationRoutes`，**不**受 `databaseRequiredMutationRoutes` 的 `database_not_ready` 409 门禁约束
- `apps/api/src/manual-plan-policy.ts:28-34`（冻结日期保护）、`:35-58`（周预算/质量课/长距离/伤情校验）都在 `validateManualPlan` 内

**现象**

当 `databaseIsReady()` 为 false（数据库文件缺失/恢复中/删除后、`rai.sqlite` 尚未建立），`weekPlan` 写入仍被执行，但 `validateManualPlan` 不会被安装：`normalizeWeekPlan` 只做逐字段边界（结构 schema、距离上限），**不做**周跑量预算、质量课数量、长距离上限、伤情限制、以及「历史/已完成/已锁定/迁移保留日期不能改写」的冻结保护。

**影响**

- 无数据库状态下（或恢复窗口内，`metadataOnlyMutationRoutes` 提前返回，只受 `assertDatasetAccepting` 约束）客户端可以保存违反策略的周计划，甚至可以改写过去日期——这类写入之后不会在服务端重新校验；执行视图 `assembleMobileWorkoutPlan` 虽然会在读取时用 `constrainUpcomingPlan` 重新钳制，但 `/v1/mobile/goals` 回显的 `weekPlan` 是未校验的存储内容，后续 `planHistory` 也会把它作为「当时的计划」，影响执行关联。
- 与文档「写入前校验」的意图不符（文档未声明该降级为已知限制）。

**建议**

- 校验不依赖主库时也应至少执行静态部分（冻结日期、race-day 保护、schema 级剂量），或在数据库未就绪时返回 409 `database_not_ready` 拒绝 `weekPlan` 写入（其余 goals 字段仍允许）。
- 若保留现有降级，需在基线文档中记为 known limitation，并让响应明确「本次保存未做策略校验」。

**验证状态**：代码路径已证实；未构造真实 `databaseIsReady()=false` 的 HTTP 用例。

---

### R-7（P3）预览最多 8 条：早于文档承诺的 15 分钟失效

**位置**：`apps/api/src/weekly-plan-preview.ts:10-14`（`while (this.entries.size >= 8) this.entries.delete(oldest)`）、`:16-18`（过期判定）；文档第 44 行「未成功发布的候选预览仍是进程内、15 分钟有效」。

**现象**：第 9 次 `preview` 会立即淘汰最早的候选，即使它尚未到期；`confirm` 随后抛 `plan_preview_stale`（「预览已过期，请重新生成」），文案与真实原因不符（是被容量淘汰，不是超时）。

**影响**：用户连续预览多次后确认旧候选会得到「已过期」；无数据损坏（不会重复写）。属文档—实现偏差。

**建议**：把容量上限（例如按需淘汰最旧但最好 ≥ 15 分钟）与过期清理分开，或把 8 条上限写进文档；淘汰时返回可区分的错误码。

**验证状态**：已证实（代码 + 现有测试外的计数用例未跑）。

---

### R-8（P3）confirm 的 `remember=false` 让「带 operationId 的首次成功」不留内存结果

**位置**：`apps/api/src/server.ts:1471`（`weeklyPlanPreviews.confirm(..., request.body.operationId === undefined)`）、`apps/api/src/weekly-plan-preview.ts:20-24`（`if (item.committed) return item.committed; ... if (remember) item.committed = result;`）。

**现象**：带 operationId 的首次确认成功后不记录 `committed`；若客户端因任何原因改用**新的** operationId 重试同一候选，`publicationOperation` 查不到原键，action 重新进入 `confirm`，此时目标已递增 revision → 重算 fingerprint 不匹配 → `plan_preview_stale`（409），而不是「返回原结果」。不会重复写（CAS/指纹挡住了），但语义与「同键重试返回原结果」只靠客户端坚持同一 operationId。

**影响**：只在客户端更换 operationId 的场景出现，错误信息误导（「目标已变化」）；无数据损坏。

**建议**：无论是否带 operationId 都记录 `committed`（operation 键不同也安全：payload digest 已能拒绝不同请求），或在 `confirm` 内按候选身份返回上一次已提交结果。

**验证状态**：代码路径已证实；未构造双 operationId 用例。

---

### R-9（P3）`/synced` v2 不校验 `operationId` 是否对应已提交的发布操作

**位置**：`apps/api/src/server.ts:1209-1225`（只要求 `operationId` 非空，未查 `mobile_plan_operations`）；对照 `apps/api/src/coach-loop-device-sync.ts:45-57`（教练通道会查 `knownPublication`/`decisionRef`，不匹配则 422 `coach_receipt_unknown_prescription`）。

**现象**：普通通道的回执可以携带任意 UUID 作为 `operationId`，服务端以 `informationLevel:"verifiedClient"` 登记；该字段随后用于诊断（最多 500 条 operationId 事件）与客户端 pending/ledger 关联。

**影响**：回执与真实发布操作的关联不可信（不存在的操作、其他数据集的操作都会被接受）——与教练通道的证据标准不一致；不改变执行/排期。

**建议**：至少校验「该 operationId 在 `mobile_plan_operations` 中存在且属当前 scope、且结果中的 revision 与 `body.revision` 一致」；若不希望耦合，文档应明确 operationId 只是客户端标注而非服务端证据。

**验证状态**：代码路径已证实；影响为审计/诊断层。

---

### R-10（P3）控制库被其他连接持有写锁时：同步阻塞约 5 秒且返回 500

**位置**：`apps/api/src/mobile-goals.ts:697-700`（`PRAGMA busy_timeout = 5000`）、`:270`（发布前 `BEGIN IMMEDIATE`）、`:293-298`（catch 直接 `ROLLBACK` 后抛出）。

**证据（已证实，合成用例）**

`/tmp/rai-review/probe4.mjs`：第二连接 `BEGIN IMMEDIATE` 后调用发布：

```text
busy failure after 5102ms: Error: database is locked code=ERR_SQLITE_ERROR status=500
```

`node:sqlite` 是同步 API，`busy_timeout` 期间**阻塞事件循环约 5.1 秒**；随后错误被映射成 `500 internal_error`（本可映射 503/busy）。另注：`BEGIN IMMEDIATE` 位于 `try` 之外（`mobile-goals.ts:270` vs `:272`），因此 busy 失败按原始 `ERR_SQLITE_ERROR` 抛出、不会被 `catch` 里的 `ROLLBACK` 掩盖；但 `catch` 内 `ROLLBACK`（`:294`）在「BEGIN 之后、事务已不在」的罕见失败（例如 COMMIT 已实际落盘却报错）会把原始错误替换成 `cannot rollback - no transaction is active`——本机未能构造到该窗口，记为待确认。

**影响**：控制库写者只应是本进程（D5 单写者）；但如果出现第二个 API 实例/CLI/测试共享同一 control DB，单次发布会让整个 HTTP 事件循环卡顿 5 秒并返回 500。属于稳健性缺陷，非当前部署的常规路径。

**建议**：把 `BEGIN IMMEDIATE` 与 `ROLLBACK` 的失败分类（`SQLITE_BUSY` → 503/429 + Retry-After），并考虑对 busy 场景降低 `busy_timeout`（control DB 事务都是毫秒级）。

**验证状态**：已证实（第二连接持锁模拟）；多进程真实并发未跑。

---

### R-11（P3）`PlanPublicationService` 的身份校验依赖可选 `identity`

**位置**：`apps/api/src/plan-publication.ts:10-18`（`if (input.operationId && this.identity)`——缺少 identity 时跳过 `operationScope` 校验，直接进 store，仅靠 store 的 scope 串判跨域）；`apps/api/src/run-coach.ts:335`（`args.scope ?? (() => "legacy")` 的兜底构造方式使「只传 scope 不传 identity」是合法写法）。

**现象**：当前生产注册点（`server.ts:451-452`、`run-coach.ts:334`、`coach-loop-runtime.ts:103`）都传了 identity，因此实际不可绕过；但类型允许一个路由在忘传 identity 时静默失去「客户端声明的原身份必须等于当前身份」的保护，只剩 store 层「op id 已存在于其他 scope」这一反向检查（无法拦截「从未提交过的旧意图在新数据集下首次执行」——而这正是文档要求拒绝的场景）。

**建议**：把 `identity` 设为必填（构造参数非可选），或在 `publish` 中 `if (input.operationId && !this.identity) throw new PlanOperationError("plan_operation_contract_mismatch", ..., 422)`。

**验证状态**：代码路径已证实；当前无触达路由，属防御性缺陷。

---

## 4. 与文档契约偏差

| # | 文档承诺 | 实现 | 判定 |
| --- | --- | --- | --- |
| D-1 | 第 46 行「过期键留下摘要墓碑并返回 expired / HTTP 410」 | `GET /plan-operations/:id` 始终 200 + `status:"expired"`；只有**写入重放**返回 410（`mobile-goals.ts:257-261、280`） | 文档歧义，建议拆成「查询返回 expired / 重放返回 HTTP 410」；实现本身自洽 |
| D-2 | 第 46 行「完整结果保留 90 天」 | `expires_at = 提交 + 90d`，`<=` 判定（恰好 90 天即过期）；tombstone 永久保留并保留 `request_digest` | 一致（边界含 90 天整）；时钟回拨/前拨无防护，未声明为限制 |
| D-3 | 第 70 行「UUID 大小写与等价 ISO 时刻表示不改变身份」 | 服务端字节精确比较；只有 iOS `PlanReceiptMatcher` 做了 UUID/时刻规范化 | 与文档叙述不一致（服务端未镜像），见 R-3 |
| D-4 | 第 44 行「未成功发布的候选预览仍是进程内、15 分钟有效」 | 另有「最多 8 条、先淘汰最旧」的容量上限，可在 15 分钟前失效 | 偏差，见 R-7 |
| D-5 | 第 66 行「当前覆盖还必须匹配当前处方与事实令牌」 | 只在校验瞬间匹配；回执落库与控制库写锁之间无原子性 | 时点未声明，见 R-4 |
| D-6 | 第 42 行「coach command、preview confirm、goals 保存和 lock 接受 UUID operationId」 | 四个 schema 均含 `operationId`/`operationScope`（preview 本身不接受，符合文档）；`coach-loop` 另要求 `contractVersion`/`expectedFactsHash` | 一致 |
| D-7 | 第 44 行「coach 和 confirm 同键重试在 CAS 和内存预览检查之前返回原结果；服务重启不再造成第二次发布」 | `publicationOperation` 在 action 之前查原结果并 COMMIT（`mobile-goals.ts:276-284`）；`server-runtime.test.ts` 覆盖 confirm 重启重放 | 一致（已实测复现） |
| D-8 | 第 46 行「同键不同请求返回 plan_operation_key_conflict」 | `digest({route, input})` 用稳定 JSON（`stableJson` 排序键），同键不同 route/input 均 409 | 一致（已实测） |
| D-9 | 第 68 行「`withdrawn`/`replaced` 追加事件，不删除或改写已登记历史」 | `recordPlanPush` 对 v2 按 UUID+时刻+事件去重后 INSERT，新行追加；旧行不改 | 一致（已实测 withdrawn 后 `matchesCurrent=false`） |
| D-10 | 第 12/42 行 D5 单写者与 mutation/publication 协调 | `/v1/mobile/goals|lock|confirm|run-coach|coach-loop...` 均被归入 `metadataOnlyMutationRoutes`（不取 mutation 锁、不做 DB 就绪门禁），但其注释「Submission only persists intent; executors acquire the shared writer lease」已与实现不符——这些路由**同步持久化**；它们只写控制库并靠自身事务/`assertDatasetAccepting` 隔离 | 行为未见缺陷，但分类理由过时，建议更新注释或重新归类，避免后续按注释做错误推断 |

**已确认符合文档的部分（positive control，供合并审查参考）**

- 业务数据 + 历史 + 操作结果同事务：`mobile-goals.ts:270-291`（probe1 回滚用例通过）。
- 90 天 / tombstone / 410：probe1 全部通过；`expired` 查询不重放副作用。
- 同键同请求冻结结果、重启后可查、跨路由/跨域拒绝：probe1 全部通过。
- `GET /v1/mobile/plan-operations/:id` 只有 id：按当前 scope 查不到时反向探测「同 id 其他 scope」⇒ `scopeMismatch`（`mobile-goals.ts:250-263`），与文档四状态一致；该路由需 token 且绕过教练合同门禁（`server.ts:399-406、1330`），旧客户端可查未结操作。
- 回执 v2 必需字段、scope 摘要、`scheduledAt→localDate`（经 `Intl`，时区为 `const DATABASE_TIMEZONE`，schema 层排除非法时区）、`verifiedAt` 未来上界 +5 分钟、`prescriptionDigest` 重算：`server.ts:1209-1226`；`verifiedAt` 未来上界与 coach 通道一致（`coach-loop-device-sync.ts:21`）。
- `removeAdditional:false` + `additionalProperties:false`：客户端不能注入 `matchesCurrent`（`mobile-goals.ts:158`）/`coachLoop` 等内部字段，v1 回执路径对 v2-only 字段返回 422（`server.ts:1226`）。
- 教练通道证据更强：`coach-loop-device-sync.ts:38-57` 校验原排期存在、scope、digest、coachLoop 上下文、`knownPublication`/`decisionRef`，撤销未知排期返回 409；且 publicationOperation 保证回执与操作结果原子。
- 写前校验：`validateManualPlan` 在 `persistGoals` 之前对**已测量候选**执行（`mobile-goals.ts:366-368`、`manual-plan-policy.ts`），confirm 在写前重算 snapshot fingerprint（`server.ts:1466-1470`），coach 命令在写前比较 `factsHash`/`expectedRevision`（`coach-loop-runtime.ts:105-145`），未发现「先写后校验」路径（除 R-6 的无数据库降级）。

**文档已声明、不计缺陷的 known limitation**

- 预览是进程内、重启即失效、不持久化（第 44 行）；未确认发布不做持久生命周期。
- 90 天只适用于发布操作完整结果；回执/生命周期事件永久保留（第 74 行）。
- 服务端登记 ≠ 服务端直接观察 SDK，更不等于物理手表交付（第 43、66 行）。
- 快照端点不是两库分布式事务，允许核验完成后另一客户端再编辑（第 26 行）。
- 跨数据集旧意图不得在新数据集执行（第 42 行），已由 probe1 证实。
- `planSnapshot` 的 503 `plan_snapshot_changed` 与恢复机制不在本次范围。

---

## 5. 未覆盖项

1. **HTTP 级端到端未执行**：`/v1/mobile/workout-plan/synced`、`/v1/mobile/coach-loop`、`/v1/mobile/lock` 的实际 HTTP 行为未用真实 server 子进程验证（本机 `onnxruntime-node` 原生绑定因代码签名 `ERR_DLOPEN_FAILED`，`mobile.test.ts`、`coach-loop-*.test.ts`、`coach-manual-compatibility.test.ts` 整文件无法加载；`server-runtime.test.ts` 全文件未跑）。R-1 的 500/422、R-2 的 500 均为「路由谓词 + 错误映射」级复现，建议补 HTTP 用例。
2. **多进程真实并发未跑**：R-10 用同一 control DB 的第二连接持锁模拟 busy；未验证「两个 API 进程同时发布」的真实行为（D5 声明单写者，故仅作稳健性发现）。
3. **iOS 线格式为代码推导**：R-1 依赖 Swift 合成 `Codable` 省略 nil 的语义（`JSONEncoder()` 默认 + 无自定义 `encode`），未在真机抓包或 `npm run test:ios` 中直接断言非教练路径的 JSON 形状（iOS 回归只断言了 coachLoop 分支的显式 null）。建议以 `ModelRegression` 增加「普通 v2 回执 wire 形状」用例。
4. **时钟偏差**：90 天过期与 `verifiedAt` 未来上界都直接用 `Date.now()`/`Date.parse`，未注入时钟回拨/前拨用例；文档亦未声明时钟假设。
5. **`mobile_plan_operations` 长期增长**：tombstone 行不清理（符合文档「留下墓碑」），但未评估多年运行后的表规模与查询代价（无 `expires_at` 索引，`BEGIN IMMEDIATE` 内每次发布都做一次全表 `UPDATE ... WHERE expires_at <= now`）。
6. **`retireLegacyModelPlan` 启动路径**：`server.ts:452` 在启动时调用，若与另一写者 CAS 冲突会抛 `MobileGoalsRevisionConflictError` → 进程启动失败（未捕获）；因单写者部署不可达，未计入发现，建议一并用 try/catch 包裹为告警。
7. **`planPushIsActive`/`activePlanPushes` 的 N+1**：`activePlanPushes` 对每个带 UUID+时刻的回执再查一次 SQL（`mobile-goals.ts:572-576`），coach-loop 读/命令都调用；回执表约每天一行，长期运行后可评估，但本次未测性能。
8. **`/v1/mobile/workout-plan/generate`（legacy）** 与 preview/confirm 的迁移交互、以及 `mutation-coordinator`/`request-mutation-lifetime` 的完整门禁覆盖，本次只读了写路径相关段落。

---

## 6. 附：复现脚本

| 脚本 | 覆盖 |
| --- | --- |
| `/tmp/rai-review/probe1.mjs` | 幂等/冻结结果/同键冲突/跨路由/跨域/回滚/重启/90 天边界与 tombstone/410/CAS 冲突映射 |
| `/tmp/rai-review/probe3.mjs` | 回执 v2 结构校验谓词：Swift 形状 → 500、显式 null → 接受、仅缺 alert → 422 |
| `/tmp/rai-review/probe4.mjs` | 控制库 busy（5.1s → 500）、回执随发布事务回滚、等价 ISO 身份、localDate 不参与身份 |

所有脚本使用 `mkdtempSync` 隔离目录与独立 control DB，运行后删除；未触碰 `var/` 下的真实数据库，未修改仓库文件。
