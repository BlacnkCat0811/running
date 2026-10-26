# RAI 原生 iOS API 契约

状态：**现行（2026-10-23 阶段 5 增补 v2 命令 Publisher 与候选能力说明）**。本文只写「iOS ↔ API 的 wire 事实」；设备侧排课/回执不变量见
[IOS_NATIVE_PLAN_SCHEDULING](IOS_NATIVE_PLAN_SCHEDULING.md)，同步协议见 [IOS_NATIVE_SYNC_PROTOCOL](IOS_NATIVE_SYNC_PROTOCOL.md)，
运行与真机步骤见 [IOS_NATIVE_RUNBOOK](IOS_NATIVE_RUNBOOK.md)。未决缺口见 [PROJECT_REVIEW](PROJECT_REVIEW.md) 的 AR-1。

服务端字段的单一来源是 `packages/api-contracts/src/index.ts`、`apps/api/src/server.ts`、
`apps/api/src/training-plan-routes.ts` 与 `apps/api/src/training-plan-commands.ts`。本文与它们不一致时以代码为准。

## 1. 身份、鉴权与作用域

所有 `/v1` 请求携带 `Authorization: Bearer <token>`。唯一例外是三条不含健康数据的存活/协商端点：
`GET /v1/health`、`GET /v1/handshake`、`GET /v1/runtime-status`。服务端配置 `RAI_PUBLIC_HOSTS` 时也只放开这三条；
Web SPA 退役后不存在匿名业务读。

所有本地状态按 **四元作用域** 隔离：服务 URL + `serverId` + `athleteId` + `datasetEpoch`
（缓存见 `CacheStore.scope`，同步任务见 `SyncTaskStore`）。服务端恢复/替换数据集时 `datasetEpoch` 改变，
旧缓存与游标不得继续当作当前结果。

数据域被新版教练合同托管（coach-loop managed）时，`/v1/mobile/today`、`/v1/mobile/workout-plan`
（及其子路径，含 `/workout-plan/synced`）与 `/v1/mobile/lock`（以及缺省/`1` 的
`/v1/mobile/training-plan-state`）返回 `409 coach_loop_contract_required`；已迁移且
`trainingPlanOwnerReady` 的 scope 可用 `X-RAI-Training-Contract: 2` 读取统一投影（阶段 5/D20）。
退役面不参与这条（仍返回 410），教练闭环路由本身不受影响。老服务端/未托管数据域维持原行为。

## 2. 握手（`GET /v1/handshake`）

实际响应（2026-10-21）：

```json
{
  "serverId": "local",
  "athleteId": "athlete_1",
  "datasetEpoch": "default",
  "syncProtocolVersion": 1,
  "apiVersion": "v1",
  "healthKitRecordSyncVersion": 2,
  "planReceiptMetadata": true,
  "planSnapshotContractVersion": 1,
  "trainingPlanContractVersion": 2,
  "coachLoopContractVersion": 1,
  "planPublicationContractVersion": 1,
  "planReceiptContractVersion": 2,
  "factsAnalysisContractVersion": 1,
  "factsAnalysisViewContractVersion": 1,
  "syncCoverageVersion": 1,
  "directSyncBounds": { "maxXmlBytes": 8388608, "maxRecords": 5000, "maxRouteFiles": 200, "maxRouteBytes": 67108864 }
}
```

| 字段 | 当前值 | 条件/语义 |
| --- | --- | --- |
| `serverId` / `athleteId` / `datasetEpoch` | 服务实例身份 | 一律返回 |
| `syncProtocolVersion` | `1` | 同步身份主版本；不等于客户端支持的版本时 App 显式提示升级 |
| `apiVersion` | `"v1"` | 路由族版本 |
| `healthKitRecordSyncVersion` | `2` | 类型作用域 UUID 删除的 v2 记录同步；不改变 `syncProtocolVersion` |
| `planReceiptMetadata` | `true` | 旧回执扩展字段能力（legacy 形状） |
| `planSnapshotContractVersion` | `1` | **条件返回**：coach-loop 托管的数据域省略（避免宣告同一份握手文档无法履约的读路由） |
| `trainingPlanContractVersion` | `2` | **统一训练读能力**（`X-RAI-Training-Contract: 2`）；非托管数据域返回，coach-loop 托管但 `trainingPlanOwnerReady`（已迁移、投影/回执一致）时也返回；损坏/缺口继续省略 |
| `trainingPlanCommandContractVersion` | `2`（条件） | 统一训练写命令能力。仅在 `RAI_TRAINING_PLAN_COMMAND_MODE` 为 `validation` 或 `production` 且客户端发送 `X-RAI-Client-Training-Commands: 2` 时宣告；命令路由本身也要求同一请求头，缺位 ⇒ 只读，不得用 `coachLoopContractVersion` 猜测。生产启用是独立发布动作（D20/D5-E） |
| `trainingPlanSessionContractVersion` | `1`（条件） | 课程身份只读扩展；仅 schema 2、owner-ready 的 scope 宣告。缺位时 `X-RAI-Training-Sessions: 1` 返回 409，不得当作空课程 |
| `trainingPlanSessionCommandContractVersion` | `1`（条件） | 课程编辑命令；仅 `RAI_TRAINING_PLAN_SESSION_COMMAND_MODE` 为 `validation` 或 `production` + schema 2/owner-ready + publication + `X-RAI-Client-Training-Session-Commands: 1` 时宣告 |
| `trainingPlanExecutionCommandContractVersion` | `1`（条件） | 执行关联命令；仅 `RAI_TRAINING_PLAN_EXECUTION_COMMAND_MODE` 为 `validation` 或 `production` + schema 2/owner-ready + publication + `X-RAI-Client-Training-Execution-Commands: 1` 时宣告；与课程写独立 |
| `trainingPlanUpdateContractVersion` | `1`（条件） | 四阶段更新只读扩展；随 `trainingPlanSessionContractVersion` 宣告，不授权自动发布；缺位/未知时 `X-RAI-Training-Updates` 返回 409 |
| `coachLoopContractVersion` | `1` | 新教练闭环合同 |
| `planPublicationContractVersion` | `1` | 控制库持久发布操作能力；不支持控制库时省略 |
| `planReceiptContractVersion` | `2` | 回执 v2（独立版本，不复用 `planReceiptMetadata` 布尔） |
| `factsAnalysisContractVersion` | `1` | **直连原始回执**：`summary.directSync` 带 `ingestStatus`/`analysisStatus` |
| `factsAnalysisViewContractVersion` | `1` | **读侧两块行视图**（`currentFacts`/`publishedAnalysis`）。与上一项是两个不同的键，不得合并 |
| `syncCoverageVersion` | `1` | 支持 `GET /v1/sync/coverage` |
| `directSyncBounds` | 8 MiB / 5000 / 200 文件 / 64 MiB | 直连单批上界；`maxRecords` 在直连车道只约束**删除配额**，不约束 XML 记录条数 |

所有写模式默认关闭；缺位、未知值或 `disabled` 均不准入。`validation` 继续要求临时隔离路径和 loopback；
`production` 要求非空 `RAI_API_TOKEN` 及显式 runtime/主库/控制库路径，未满足时启动拒绝且不打开数据库。
2026-10-25 用户要求在部署最新版本时再启用；当前未修改任何实际服务配置。见[运维启用说明](OPERATIONS.md#训练计划-v2-写能力部署时启用)。

🔴 **读能力不等于写能力，也不等于该 scope 已迁移。** `trainingPlanContractVersion` 只说明
`GET /v1/mobile/training-plan-state` 接受 `X-RAI-Training-Contract: 2`（§3.1）；未迁移的 scope
仍返回 `409 training_plan_not_migrated`，客户端必须分别处理「能力存在」与「scope 未迁移」。
`trainingPlanCommandContractVersion` 是独立的写侧注册项：**默认不宣告**，显式开启 validation/production 模式、owner-ready
且收到 `X-RAI-Client-Training-Commands: 2` 后才宣告；缺位时客户端不得回退到已退役的旧写面，
也不得把 `coachLoopContractVersion == 1` 当成统一命令可用。iOS 的
`legacyPlanWritesSupported` 与 `trainingPlanV2CommandsSupported` 是两个独立判定：
精确匹配版本才允许 v2 写，v2 能力永远不放行旧 URL。

兼容规则：老服务端省略某能力位 ⇒ 客户端按「不支持」保守回落，不得假设服务端具备该能力；
能力位只用于选实现路径，不改变数据集身份。

全部握手键的语义、宣告前提、消费者与缺位行为登记在
`packages/api-contracts/src/handshake-registry.ts`；`apps/api/test/handshake-registry.test.ts`
从 `HandshakeResponse` 源码核对键集合，漏登记或重复登记会变红。

2026-10-25 B01 另冻结 `trainingPlanSessionContractVersion`、`trainingPlanSessionCommandContractVersion`、
`trainingPlanExecutionCommandContractVersion`、`trainingPlanUpdateContractVersion`，各自精确版本为 1。
**B04 起课程命令在隔离 validation 有条件宣告并挂载预览/提交；B06 起执行命令按独立能力接入；B08 起更新读随课程读扩展宣告。生产课程/执行写仍关闭，自动发布另有独立开关。**请求头、依赖及旧构建兼容规则见
[训练计划闭环合同](TRAINING_PLAN_V2_CLOSED_LOOP_CONTRACT.md)。已有配置命令 2 不推导课程写能力。

B02 已增加身份只读兼容：在 v2 GET 同时发送 `X-RAI-Training-Sessions: 1`，且该 scope 已显式升级至
payload schema 2 时，顶层可选 `sessions` 返回稳定实例/课程/修订、原建议、用户覆盖、保护与抑制。
schema 1 或未知课程扩展版本返回 `409 training_session_contract_unsupported`，不隐式升级、不分配 ID。
B03/G1 起 handshake 只在已完成该受控迁移且 owner-ready 的 scope 宣告 `trainingPlanSessionContractVersion: 1`；
它仍是只读扩展，不授权课程写、执行关联或自动发布。
v2 响应统一带 `Vary: X-RAI-Training-Contract, X-RAI-Training-Sessions, X-RAI-Training-Updates`；
缺少对应扩展头不返回该扩展字段，Vary 同时区分未请求、精确版本和未知版本。
扩展只在 unified read 2 下解释，v1 路径保持原合同。B04 的课程写仅在
`RAI_TRAINING_PLAN_SESSION_COMMAND_MODE=validation`、临时隔离 runtime/两库、loopback、schema 2/owner-ready、
持久 publication 支持和请求头 `X-RAI-Client-Training-Session-Commands: 1` 同时满足时宣告/准入；
与原配置命令开关独立。课程路由为 `/v1/mobile/training-plan/session-commands/preview` 和
`/v1/mobile/training-plan/session-commands`（均 POST、contractVersion 1）。六动作和错误按闭环合同，
预览零写，提交复用控制库原子发布、CAS、事实/排期输入再验证和幂等；已提交重放先于能力/TTL/事实门。
取消/明确休息允许 metadata-only；其余动作须事实就绪及既有安全约束。服务重启只使未提交预览失效，已提交结果仍从 SQLite 恢复。
B05 原生编辑/journal 已通过 G2（普通与 Accessibility XXXL 两轮真实点击），不授予生产启用。
B06 执行命令仅在独立模式为 `validation` 或 `production` 且完成请求协商时宣告；B08 更新读在课程读扩展存在时宣告，
但只报告阶段，不授权自动发布。

B07 起 iOS 按 `trainingPlanExecutionCommandContractVersion == 1`（同时要求 sessions 1 与 publication 1）
消费执行关联；服务端 B06 仍按独立开关决定该键是否宣告，缺失/未知一律只读。候选读为
`GET /v1/mobile/training-plan/sessions/:sessionId/execution-candidates`（query：`planInstanceId` 必填，
可选 `rangeStart`/`rangeEnd`/`cursor`），写为
`POST /v1/mobile/training-plan/execution-commands`，两者都带
`X-RAI-Training-Contract: 2`、`X-RAI-Training-Sessions: 1`、`X-RAI-Client-Training-Execution-Commands: 1`。
候选只用于用户确认，`verified_identity` 也不自动完成；同日多跑保留歧义，默认窗口为课程日 ±2 天，可扩大到最多 31 天。
新路由的 HTTP 404 若不带 `training_session_not_found`，客户端提示升级而不是当作 `plan_operation_notFound`；
410 仍是退役终局，409/422/503 沿用闭环合同分类。执行命令复用唯一 pending row/journal：原 UUID 与字节一次编码后持久化，
重启先按原 operationId 查询，已知 committed 不重提，只有业务 `notFound` 才按原字节重放；能力关闭仍可查询已提交操作。
成功确认只把 state/goals 水位写入本地，不伪造 session/execution 全局水位；随后必须完整重读执行快照与统一状态。
`TrainingPlanStateResponseV2.sessions.executions` 是可选数组：缺位表示执行视图未知，不是空历史；老缓存可兼容解码。
B08 起同一读在同时发送 `X-RAI-Training-Updates: 1` 时增加可选 `update`：facts/analysis/association/plan 四阶段各自带证据，
`plan.status` 由持久 `publishedInputKey` 和评估游标派生；自动发布关闭时可为 `blocked` 并带 `auto_publish_disabled`，
不是“计划已更新”。更新读 GET 零写，不触发分析或发布。
更新扩展必须与精确课程读头同时协商；缺位表示更新状态未知。未知更新版本、缺少课程协商、
schema 1 或服务端未提供更新读能力均返回 `409 training_update_contract_unsupported`。
iOS 拒绝未经协商的 update、缺少 sessions 的 update、未知阶段和超出快照修订的评估水位。

## 3. 统一训练计划 v2

### 3.1 读：`GET /v1/mobile/training-plan-state`

同一条路径承载两个 wire 合同，由请求头协商：

| `X-RAI-Training-Contract` | 结果 |
| --- | --- |
| 缺省 / 空串 / `1` | v1 聚合载荷（`metadata` + `availability` + `goals` / `today` / `workoutPlan` / `coachSummary`，可带 `versions`/`freshness` 与两块只读视图 `currentFacts`/`publishedAnalysis`），语义与字节都不变 |
| `2` | v2 统一投影（本节的 `TrainingPlanStateResponseV2`） |
| 其它值 | `409 training_contract_unsupported`；**不回退 v1** |

- v2 响应必带 `Vary: X-RAI-Training-Contract, X-RAI-Training-Sessions, X-RAI-Training-Updates`，
  包括未请求扩展及扩展协商失败的响应；v1 和未知统一读版本带 `Vary: X-RAI-Training-Contract`。
  所有这些读响应均带 `Cache-Control: no-store`。
- 服务端**不迁移、不发布、不写入**；状态未迁移时 `409 training_plan_not_migrated`；
  统一状态损坏/业务日期不可解析时 `503 training_plan_state_unavailable` / `training_plan_state_invalid`。
- 业务日期只有一个来源（Asia/Shanghai 自然日），`businessDate` 由服务端给出。

v2 载荷（`TrainingPlanStateResponseV2`）：

```jsonc
{
  "contractVersion": 2,
  "scope": { "serverId": "local", "athleteId": "athlete_1", "datasetEpoch": "default" },
  "businessDate": "2026-10-20",
  "stateRevision": 7,
  "migratedAt": "2026-10-19T03:00:00.000Z",
  "migration": { "version": 1, "source": "legacy_goals", "sourceStatus": "active", "sourceDigest": "…" },
  "mode": "race",                 // coach | race
  "modeReason": "race_goal_upcoming",
  "daysToRace": 35,
  "runState": "active",           // active | paused
  "admission": "ready",           // ready | needs_configuration | needs_confirmation
  "raceGoal": null,               // TrainingPlanRaceGoalView | null
  "plan": { "goalsRevision": 7, "currentGoalsRevision": 7, "current": true,
            "days": [ /* MobilePlannedDay */ ], "lockedToday": false },
  "execution": { "permitted": false, "reasonCodes": ["projection_only", "…"] }
}
```

- `execution.permitted` **恒为 false**：投影不是执行授权；执行授权只能来自执行快照（v1 聚合读）。
- 未知 `mode`/`admission`/`plan` 状态不得解释成 `active`/`ready`；`plan.current=false` 表示配置已变、计划需刷新。
- 客户端**不提供 v1 回退**：404（老服务端没有该路由）与 `training_contract_unsupported` 都映射成
  `upgradeRequired`，`training_plan_not_migrated` 映射成 `notMigrated`，503 映射成可重试的服务不可用
  （见 `apps/ios/RAI/APIClient.swift` 的 `RaiTrainingPlanContract` / `RaiTrainingPlanContractError`）。

### 3.2 预览：`POST /v1/mobile/training-plan/commands/preview`

请求体（`TrainingPlanCommandPreviewRequest`，**body 内**声明合同版本，不看请求头）：

```jsonc
{ "contractVersion": 2,
  "operationScope": { "serverId": "local", "athleteId": "athlete_1", "datasetEpoch": "default" },
  "action": "set_race_goal",     // set_race_goal | clear_race_goal | pause | resume
  "expectedStateRevision": 7,    // 可选
  "raceGoal": { "date": "2026-11-22", "distanceKm": 21.0975, "goal": "time", "targetTimeSeconds": 6300 } }
```

响应（`TrainingPlanCommandPreviewResponse`）：`contractVersion`、`candidateId`、`expiresAt`（TTL **120 s**）、
`expectedStateRevision`、`before`/`after`（`TrainingPlanStateSummary`）、`changes`、`planRefreshRequired: true`、`warnings`。
预览**不落库**；`candidateId` + TTL 把提交绑定到「刚刚预览过的那份配置」。

### 3.3 提交：`POST /v1/mobile/training-plan/commands`

所有新的命令请求（preview/submit/refresh）必须同时带
`X-RAI-Client-Training-Commands: 2`；缺失或未知值返回 `409 training_commands_disabled`，不得执行。
已提交 `operationId` 的幂等重放先于该检查，仍可在只读模式下查询原结果。

请求体（`TrainingPlanCommandRequest`）：`contractVersion: 2`、`operationId`（UUID，持久幂等键）、
`operationScope`、`expectedStateRevision`、`candidateId`、`action`、可选 `raceGoal`。

响应：`operationId`、`stateRevision`、`goalsRevision`（与 unified stateRevision 及设备执行水位**分开**保存）、
`before`/`after`、`changes`、`planRefreshRequired`、`plan`（`days`/`audit`/`contextDigest`/`goalsRevision`，
未发布计划时为 `null`）、`warnings`。
配置（赛事目标/暂停/恢复）与计划在**同一发布事务**内提交；`pause` 永不发布计划，因此 `planRefreshRequired` 保持 `true`。
`pause` 在该事务内清空 unified 与 goals 的当前锁课；历史处方、回执与设备撤回账目保留。
暂停后的 `/today` 与 v1 聚合返回停止训练的休息建议、无当前锁；所有执行窗口均不可执行。
恢复须重新生成计划，不能恢复已撤销的锁课。

### 3.4 刷新：`POST /v1/mobile/training-plan/commands/refresh`

请求体（`TrainingPlanRefreshRequest`）：`contractVersion: 2`、`operationId`、`operationScope`、`expectedStateRevision`。
响应：`operationId`、`stateRevision`、`goalsRevision`、`plan { days, audit, current: true, contextDigest }`、`warnings`。
计划在控制事务外生成（读主库事实），提交时复核事实指纹与配置摘要；并发生成返回 `409 weekly_plan_generation_busy`。
所有新生成路径（设置/清除目标、恢复、显式刷新与自动刷新）在读取事实前及提交前检查事实更新任务是否完成，
导入/重算仍在进行时返回 `409 coach_sync_pending`。已提交结果的幂等重放先于该检查；暂停不生成计划，允许在事实更新期间撤销执行。
已迁移且 owner-ready 的 managed scope 由启动后及每小时的统一 Coordinator 判断刷新；暂停或所有权损坏时不发布。

### 3.5 命令错误码

| 状态 | code | 含义 |
| --- | --- | --- |
| 422 | `training_contract_required` | body 的 `contractVersion` 不是 2 |
| 422 | `training_configuration_invalid` | 目标/动作字段不合法 |
| 409 | `training_scope_mismatch` | `operationScope` 与服务身份不一致 |
| 409 | `training_plan_not_migrated` | 该数据域尚未迁移 |
| 409 | `training_revision_conflict` | `expectedStateRevision` 已过期 |
| 409 | `training_candidate_expired` / `training_candidate_mismatch` | 预览过期或与候选不符 |
| 409 | `training_cannot_resume` | 已结束的训练节目不能恢复 |
| 409 | `training_paused` | 暂停中不能刷新课表 |
| 409 | `training_snapshot_changed` | 生成期间配置/事实变化；原计划未改动 |
| 409 | `coach_sync_pending` | 训练事实仍在更新；待导入/重算完成后重新读取并生成 |
| 409 | `training_commands_disabled` | 服务端未处于隔离候选/写能力未宣告；只读 |
| 409 | `coach_policy_changed` | coach-loop 规则版本变化；须先通过既有 update 合同明确接受当前规则，统一生成不会代替用户接受 |
| 503 | `training_plan_owner_invalid` | 统一状态与 coach-loop receipt 的所有权指针不一致；fail-closed |
| 422 | `training_command_invalid` | 缺少 `operationId`、scope 不完整或动作不在四动作内 |
| 422 | `training_plan_empty` | 未生成有效课表；原计划保持不变 |
| 503 | `training_plan_state_invalid` / `training_plan_state_unavailable` | 统一状态不可读 |

### 3.6 发布操作幂等与保留（`/v1/mobile/plan-operations/:id`）

- 持久发布的每个写操作都带 `operationId`（UUID）。控制库按 `(scope, operationId)` 保存**原结果**：
  同键 + 同请求字节 ⇒ 直接返回原结果，**不重新执行副作用**；同键 + 不同请求 ⇒ `409 plan_operation_key_conflict`；
  跨作用域 ⇒ `409 plan_operation_scope_mismatch`；带 `operationId` 却没有 `operationScope` ⇒ `422 plan_operation_contract_mismatch`。
- 结果保留 **90 天**（`mobile_plan_operations.expires_at = now + 90d`）。过期后重放该键 ⇒ `410 plan_operation_expired`，
  **不得重新执行**。
- 查询信封：`GET /v1/mobile/plan-operations/:id` 返回 `200` + 下列四状态之一：
  `committed`（带原 `result`）、`notFound`、`scopeMismatch`、`expired`（`result` 为空，**终局**）。
  只有明确的 `notFound` 才允许按原键、原字节、原身份重试；`scopeMismatch`/`expired` 都是终局。
- 老服务端没有该端点（缺 `planPublicationContractVersion`）时，客户端不得把「查不到」当成 `notFound` 去重放。

### 3.7 客户端现状（阶段 5 收口）

2026-10-23 阶段 5（D20）：iOS 已接入 v2 命令编排，且仍保留“未宣告能力即只读”的边界：

- `APIClient` 新增 preview/submit/refresh 的 v2 DTO 与请求方法；
  `TrainingPlanPublisher.swift` 持久化 `operationId`、原始请求 Data、命令类别与独立
  `stateRevision`/`goalsRevision` 水位，负责 preview→确认→提交→完整重读与 `plan-operations` 恢复。
  关闭预览（按钮或手势）及草稿改变会作废在途预览；迟到回包不能恢复候选，重新打开须重新预览。
  确认还须匹配当前编辑草稿；提交或查询中的 journal 不因关闭面板而删除。
- `NativeAppModel` 把 `legacyPlanWritesSupported`（旧服务器兼容）与
  `trainingPlanV2CommandsSupported`（精确 `trainingPlanContractVersion=2`、
  `trainingPlanCommandContractVersion=2`、`planPublicationContractVersion=1`）分开；
  未完成握手/未知版本不会发出任何 v2 写，v2 能力也不会放行 `/goals`、`/run-coach`、
  `/workout-plan/preview|confirm|generate`。
- 统一训练页的配置面板只对四动作 expose：设置/清除比赛目标、暂停、恢复；刷新走独立
  `POST /training-plan/commands/refresh` 并单独确认。手动逐日课表继续只读说明
  （`manualPlanEntry`），不把 refresh 冒充手动保存；完整偏好/start-end 仍由既有 coach-loop
  合同处理并汇入同一 unified 所有者。
- 服务端仍保留 5 条路径 / 7 个操作并一律 410；旧服务器页面（`TechRunCoachView`）只在使用
  旧协议的服务上展示。客户端把 410 映射为终局升级状态：`legacy_surface_retired` 与任意未知
  410 都清掉本地 pending 发布并提示「已退役」，不写回排期 ledger / 回执历史 / revision 水位。

剩余缺口不是重新打开旧端点：手动课表/完整偏好需要方案 §4.2 的独立原子合同扩展；
Simulator、配对设备与生产能力启用按阶段 5 G6/G7 分层验收（见
[阶段 5 报告](../deliverables/phase5-implementation-2026-10-23/PHASE5_REPORT.md)）。
本文与实现不一致时以代码与报告中的实测证据为准。

统一状态保留迁移来的 `runCoach` 偏好证据，直到显式配置的 coach-loop 回执接替它；
兼容 goals 中的旧 programme 清空不删除该证据。同一赛事的日期、距离不变时保留其 ID；
比赛日期过去后保留历史目标，当前执行按上海业务日切回日常训练。
首次发布意图落盘失败且尚未发送时，客户端重读后允许重新预览、明确确认；
服务端已提交后的确认/清账失败仍保留原操作并阻止新增排期。待重读状态不阻止显式撤回旧排期，
撤回仍须通过本机排期账目的持久化与读回校验。

## 4. 已退役面（410 矩阵）

2026-10-20 起以下 **5 条路径 / 7 个操作**路由保留挂载，但一律返回 `410` + `legacy_surface_retired`
（带 `replacement`），旧实现不可达；OpenAPI 里保留路径并标 `deprecated`，只声明 410 响应：

| 路径 | 操作 | replacement（服务端原话） |
| --- | --- | --- |
| `/v1/mobile/goals` | `GET` | `/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands` |
| `/v1/mobile/goals` | `PUT` | 同上 |
| `/v1/mobile/run-coach` | `GET` / `POST` | 同上 |
| `/v1/mobile/workout-plan/preview` | `POST` | `/v1/mobile/training-plan/commands/preview` |
| `/v1/mobile/workout-plan/confirm` | `POST` | `/v1/mobile/training-plan/commands` |
| `/v1/mobile/workout-plan/generate` | `POST` | `/v1/mobile/training-plan/commands/refresh` |

```json
{ "code": "legacy_surface_retired",
  "message": "该旧接口已退役，不再执行旧协议；请改用 …。",
  "replacement": "/v1/mobile/training-plan/commands" }
```

- **410 不是 404**：410 表示「刻意移除、请迁移」，404 表示「路径/版本写错」。客户端必须能区分。
- 托管数据域（coach-loop managed）也不会把退役面变成 409：退役优先于「这份数据集受管理」。
- 另一组独立的退役能力：`POST /v1/backups` = `410 backup_creation_retired`、`DELETE /v1/backups/:name` =
  `410 backup_deletion_retired`，两者都不碰文件；决策见 DECISIONS D18。

**仍存活、容易与退役面混淆的路径**（iOS 仍在用，勿按退役处理）：

- `GET /v1/mobile/workout-plan`：**v1 可执行周**（`MobileWorkoutPlanResponse`，供 WorkoutKit 排期；只读）。
- `POST /v1/mobile/workout-plan/synced`：回执登记（§5）。
- `GET /v1/mobile/training-plan-state`（v1 聚合或 v2 投影，§3.1）。
- `/v1/mobile/coach-loop`、`/v1/mobile/coach-loop/synced`、`/v1/mobile/coach-execution`、
  `/v1/mobile/coach-feedback`、`/v1/mobile/coach-prediction-refresh`：教练闭环合同（iOS 当前配置写入口）。

## 5. 回执与排期登记

`POST /v1/mobile/workout-plan/synced` 与 `POST /v1/mobile/coach-loop/synced` 登记「客户端已核验本地系统日程」。
语义边界：它证明调用端读到了系统日程，**不**证明物理手表已可见，也不是服务端观察到 SDK。

- 旧客户端照常发送 `localDate` / `kind` / `revision` / `structure` 等旧字段（`localDate`、`kind` 必填）。
- v2 回执另带 `contractVersion: 2`、`scope`、`operationId`、`coherenceToken`、`verifiedAt`、`timezone`、
  `prescriptionDigest`、`lifecycleEvent`（`verified|withdrawn|replaced`）、`workoutID`、`scheduledAt`、
  `idempotencyKey`、`exportNotes`。
- 使用新增字段却不带 `contractVersion: 2` ⇒ `422 plan_receipt_contract_mismatch`；日期非法 ⇒ `422 plan_receipt_date_invalid`。
- 服务端接受「显式 null」与「省略 nil」两种线形状，但**规范线形状是显式 null**
  （`warmup`/`cooldown`/`alert`/`alert.lower`/`alert.upper`、教练闭环的 `decisionRef`）。
- 响应：`POST /v1/mobile/workout-plan/synced` 返回 `recordedAt`、`matchesCurrent`（仅当服务端判定了
  当前性时出现）、`informationLevel`（v2 = `verifiedClient`，旧 = `legacy`）；
  `POST /v1/mobile/coach-loop/synced` 返回 `recordedAt` 与 `informationLevel: "verifiedClient"`。
  `matchesCurrent` 只用于发现「旧排期」，不是物理交付证据。
- 能力闸门：客户端以 `planReceiptContractVersion == 2` 决定是否发送 v2 字段；
  `planReceiptMetadata` 只在没有 v2 回执能力时用于选择 legacy 形状。
- 设备侧的撤回/替换/强读回不变量见 [IOS_NATIVE_PLAN_SCHEDULING](IOS_NATIVE_PLAN_SCHEDULING.md) §6–§7。

## 6. 读接口

| 用途 | 接口 | 客户端处理 |
| --- | --- | --- |
| 今日 | `GET /v1/mobile/today` | 恢复、建议、周进度、最近训练；展示 `latestDataDate` 与 `generatedAt` |
| 执行周 | `GET /v1/mobile/workout-plan` | 可执行处方（v1，供排期）；`planRevision` 用于与确认水位比较 |
| 训练列表 | `GET /v1/workouts?limit=&offset=&sessionType=` | 以 `id` 去重，按分页追加；支持 `localDate=YYYY-MM-DD` 按日查看 |
| 训练详情 | `GET /v1/workouts/{id}` | 缺失指标为 `null`，不以零替代；不存在（或已软删）才是 404 |
| 时序 | `GET /v1/workouts/{id}/series` | 各指标使用自身 `unit` 与同一时间轴 |
| 新鲜度 | `GET /v1/workouts/{id}/freshness` | 事实/分析/时序到齐程度（§7） |
| 同步覆盖 | `GET /v1/sync/coverage?types=` | 只用于避免重传服务端已有历史；不得清除本地游标 |
| 统计 / 趋势 | `GET /v1/mobile/statistics` / `GET /v1/mobile/trends` | 直接展示服务端结果（12 周、增幅、纪录、洞察） |
| 锁课 | `POST /v1/mobile/lock` | 见 §8 |
| 摘要导出 | `GET /v1/exports/workout-summary?from=&through=` | 见 §8 |

## 7. 事实可见性、新鲜度与覆盖

`GET /v1/workouts` 的 `items[]` 与 `GET /v1/workouts/{id}` 都是**事实驱动**：事实（workout + training_session +
records）存在即 200；只有事实不存在（或已软删）才 404。每行可带：

- `analysisPublishStatus`：`pending | published | failed`。
  - `pending` 的含义是「**没有覆盖本训练最新事实代次**」，不再等价于「从未发布」；
  - `analysisAvailable`：存在指向当前 active release 的评估行（旧分析仍可读）。
    `pending + analysisAvailable=true` ⇒ 旧分析可读但**不是最新结论**；`false` ⇒ 派生字段为 null/占位，
    客户端显示「分析中」且**不得**把 `qualityScore=0` 或空维度当真实分数。
- 详情 `facts.analysisState = "analyzed"` 可同时出现在 `pending` 下（旧分析可读）；「是否最新」只看 `analysisPublishStatus`。
- 带特征过滤（`status`/`sessionType`/`confidence`/`participation`）时 `pending` 行会被排除；不带过滤时必须包含。

`GET /v1/workouts/{id}/freshness`：

```jsonc
{ "workoutId": "training_session_…",
  "facts": { "committedAt": "…", "lastBatchAt": "…", "batches": 6 },
  "analysis": { "status": "pending", "available": true, "jobId": "…", "publishedAt": "…" },
  "series": [ { "metric": "strideLength", "samples": 0, "state": "not_seen_yet", "lastAvailableAt": null } ],
  "deliveryState": "delivered", "analysisState": "pending", "stabilityState": "settling",
  "completeness": "partial" }
```

- `metric` 固定集合：`heartRate/speed/power/cadence/strideLength/verticalOscillation/groundContactTime/elevation`。
- `state = not_seen_yet` = 「目前没有样本，可能还在传输」，**不是**「设备不支持」。
- `analysisState` 与 `analysis.status` 同值同源；`stabilityState = stable` 仅当 `facts.lastBatchAt` 距今 ≥ 24h
  （24h 只影响这一个字段）；`deliveryState` 只表达**服务端到达证据**（`unknown` = 没有到达证据，
  不得显示成「手表仍在传输」）；`completeness` 仍 = 分析已发布 && 24h 静默。
- 老服务端省略三个新字段 ⇒ 客户端按「不知道」处理，不得当作 `delivered/stable`。

`GET /v1/sync/coverage?types=`：返回 `datasetEpoch` 与每个类型的 `knownFrom`/`knownUntil`/`sampleCount`。
覆盖区间只说明「已落库样本的端点」，不证明区间内没有空洞；客户端只能据此跳过重传，**不得**删除本地游标或跳过真正的待办。

直连回执 `summary.directSync.records`：`{ parsed, inserted, unchanged }`，`unchanged = parsed - inserted`
（显式删除不在 `parsed` 内）。老服务端省略该键 ⇒ 按「未提供」处理，不得当成 0。

回执 `summary.routesUpdated`（P2-8，2026-10-23 明确）：**本批内容或归属发生变化的唯一路线数**，
按 route id 去重。内容变化计 1；内容字节未变但父训练归属变化也计 1，包括原本无父训练的孤儿路线被 XML 训练认领且本批没有重传 GPX 文件；同一路线重复只计 1。
它不是「路线文件数」或「路线点数」，也不能据此推断分析重算范围（见 `recomputeReasons`）。
iOS 展示文案必须用「更新路线」而不是「路线文件」，避免用户把归属变化读成新增文件。

导入任务的稳定失败码 `failureCode`（`GET /v1/jobs/:id` 与单次查询同源）：`direct_sync_route_ownership_conflict`
表示同一批把一条路线声明或改归到多个训练（按完整 `WorkoutRoute` 声明集判定，与 XML 顺序无关；载荷自相矛盾，整批回滚）；客户端必须清任务并重新生成同步批次
（与 `direct_sync_input_not_allowed` 同档，**不可重试**），不得保留同一 `sourceId` 反复重传。

## 8. 写接口（存活）

- **反馈**：`POST /v1/commands`，`kind: "workout_override"`，payload 为完整训练覆盖字段 + `trainingSessionId`；
  新版另传 `expectedRevision`（无覆盖时为 0，服务端在真正执行的事务里检查）。202/queued/running 不是保存成功，
  终态查 `GET /v1/commands/:id`（`succeeded` 表示反馈已保存；`result.jobId` 是后续分析任务）。
  冲突码 `workout_override_revision_conflict` 必须读新版本并由用户决定，不静默覆盖；重试沿用原 `idempotencyKey`。
  旧 `PATCH /v1/workouts/:id/override` 同样接受可选 `expectedRevision`（为旧版兼容不强制，不能因此宣称旧客户端有冲突保护）。
- **锁课**：`POST /v1/mobile/lock`，`action: lock|relock` + 当前 `recommendationRevision`。
  服务端只拒绝两种业务情形：上次健康同步失败（`409 mobile_refresh_failed`）或建议已过期
  （`409 mobile_recommendation_stale`）。**今天没有恢复记录不是拒绝理由**（没戴表是普通覆盖缺口）。
- **摘要导出**：`GET /v1/exports/workout-summary?from=&through=`，必须 Bearer（公开 Host 也不允许匿名）。
  返回 `{ from, through, timezone, count, csv }`；范围最多 366 日、最多 2000 条，否则 `400`
  （`invalid_export_range` / `export_too_large`）。CSV 只含已分析训练的开始时间/类型/距离/时长/配速，
  无路线、备注、健康原始值或内部 ID；结束日完整包含；响应禁止缓存，用户先预览再显式导出。
- **健康数据上传**：`POST /v1/imports/uploads`（ZIP）+ 可选的 `X-RAI-Sync-Batch`（SHA-256 批次值）。
  服务端按「scope + 批次值」幂等：同一标识重复上传返回原来源，不重新创建；格式异常 ⇒ `400 invalid_sync_batch_id`。
  上传 → `POST /v1/imports/inspect` → `POST /v1/import-jobs` 的业务顺序与恢复规则见同步协议文档。

## 9. 错误与客户端映射

服务端错误至少包含 `code` 与 `message`；410 额外带 `replacement`。iOS 映射（`RaiAPIClientError`）：

- `401` → 凭证错误（`unauthorized`），不自动重试。`403` 不折叠成凭证错误：它通常是来源/Host 被拒
  （`local-request-security`），客户端按服务端错误展示并保留诊断上下文，不盲目重试。
- `409` → 数据/建议/目标/合同冲突，保留本地缓存与草稿，由用户决定是否重读。
- `410` → **终局**：该能力已永久移除，不得重试，应显示迁移指引。2026-10-21 起客户端把
  `legacy_surface_retired` 与任意未知 410 都按终局处理：计划发布清掉本地 pending 账目并提示
  重开新版编辑，但保留系统排期 ledger、回执历史、撤回风险与 revision 水位；读路径按
  「升级/不支持」展示，不归成可重试的服务暂不可用。
- `429` + `Retry-After` → 容量/并发瞬时满，展示服务端建议等待秒数。
- `503` + `Retry-After` → 可重试的服务端忙（前台按夹取后的短退避重读）。
- 超时 → `timedOut`；其它网络失败 → `unavailable`；两者都允许读缓存，文案不同。
- 解码失败 → 协议不兼容，保留诊断上下文。

新增字段一律按**兼容扩展**处理；未知枚举按字符串保留并显示默认标签。Swift DTO 不复制 TypeScript 评分、
恢复或预测逻辑；设备端不做评分重算。
