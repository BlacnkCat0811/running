# RAI 原生 iOS API 契约

状态：P1 已落地，服务端字段以 `packages/api-contracts/src/index.ts` 和 `apps/api/src/server.ts` 为准。

## 身份与版本

`GET /v1/handshake` 返回：

```json
{
  "serverId": "local",
  "athleteId": "athlete_1",
  "datasetEpoch": "default",
  "syncProtocolVersion": 1,
  "apiVersion": "v1"
}
```

所有 `/v1` 请求都必须携带 `Authorization: Bearer <token>`，唯一例外是三条无健康数据
的存活/协商端点：`GET /v1/health`、`GET /v1/handshake`、`GET /v1/runtime-status`（即使
服务端配置了 `RAI_PUBLIC_HOSTS` 也只放开这三条；Web SPA 退役后不再有匿名业务读）。

页面缓存的命名空间同时包含服务 URL、`serverId`、`athleteId` 和 `datasetEpoch`。服务端数据库恢复或替换数据集时，改变 `datasetEpoch`，旧缓存和游标不得继续作为当前结果使用。

## 读接口

| 用途 | 接口 | 客户端处理 |
| --- | --- | --- |
| 今日 | `GET /v1/mobile/today` | 读取恢复、建议、周进度和最近训练；显示 `latestDataDate` 与 `generatedAt` |
| 训练列表 | `GET /v1/workouts?limit=&offset=&sessionType=` | 以 `id` 去重，按分页追加 |
| 训练详情 | `GET /v1/workouts/{id}` | 读取缺失指标的 `null`，不以零替代；`analysisPublishStatus=pending` 时按“分析中”展示 |
| 时序 | `GET /v1/workouts/{id}/series` | 各指标使用自身 `unit` 和同一时间轴 |
| 训练新鲜度 | `GET /v1/workouts/{id}/freshness` | 事实批次与分析到齐程度；`not_seen_yet` 不得当成“设备没有该能力” |
| 同步覆盖 | `GET /v1/sync/coverage?types=` | 只用于避免重传服务端已有历史；不得清除本地游标 |
| 统计 | `GET /v1/mobile/statistics` | 月度、总量和心率区间直接展示服务端结果 |
| 趋势 | `GET /v1/mobile/trends` | 12 周、增幅、纪录和洞察直接展示服务端结果 |
| 目标 | `GET /v1/mobile/goals` | 保存当前 revision 和逐日计划 |
| 跑步教练 | `GET /v1/mobile/run-coach` | 读取计划、阶段、容量说明和力量补充；读取不写入 |

日期字符串保持服务端返回的 ISO/本地日期语义。页面显示使用本地格式化，不能把缓存时间冒充健康数据截至时间。

## 写接口

`PUT /v1/mobile/goals` 在已有目标上必须带 `expectedRevision`，其余字段**皆可省略**：请求里没出现的字段沿用已存值，因此"只改比赛目标"不会顺手改写其它设置。可编辑字段为轻松训练下限、质量课上限、比赛目标和逐日计划（**周跑量目标已退役**，见 `DECISIONS.md`；周容量改由比赛目标或近期实测跑量推导）；锁课由 `POST /v1/mobile/lock` 专门维护，不随目标保存请求发送。服务端以 revision 做并发检查；`409 mobile_goals_revision_conflict` 时重新读取后提示用户，不静默覆盖。

`GET /v1/mobile/goals` 可返回服务端只读 `weekPlanPreservedDate: string | null`，表示旧课表迁移当日的保护日期；客户端不得在 `PUT` 中回传。该保护不随预览确认清除，仅在上海本地日期相等时生效；今日建议和 WorkoutKit 使用同一处方，恢复与负荷闸门仍有效，未来课表容量不被抬高。旧 Swift 客户端可忽略这一新增字段，保护、过期及校验均在服务端完成。

`runCoach` 也是 goals 的只读元数据，不得在 `PUT` 中回传。`POST /v1/mobile/run-coach` 接受 `{ expectedRevision, action, config? }`，action 为 `start|update|refresh|pause|resume|end`；仅 start/update 携带完整 config。返回 `{ revision, plan, phase, phases, daysToRace, elapsedWeeks, weeklyCapacityKm, notices, strength }`。配置及边界见 [RUN_COACH](RUN_COACH.md)。

教练命令与 goals 共用 CAS；无效状态/配置为 `422 run_coach_invalid`，过期修订为 `409 mobile_goals_revision_conflict`。active/paused 期间，直接 PUT 目标或逐日计划返回 `409 run_coach_managed`，旧生成和预览也被拒绝。独立手动课表在结束后显式保存或确认时清除教练管理状态。

旧协议原生全量刷新和教练入口先 GET，再对 active 计划 POST refresh，事实相同不会增加 revision。支持完整快照的新协议入口只读取；适应通过用户显式点击“按最新训练事实调整计划”执行。命令确认成功后刷新完整计划，依赖读取失败只报告“已保存但未刷新”，不伪装成保存失败。教练缓存按服务身份和 revision 隔离，已确认的新教练缓存可独立于较旧 goals 缓存恢复；旧修订的今日处方和手表课表不得展示为新计划，缺少匹配安排时显示尚未刷新。旧读取不能覆盖新命令；离线不执行命令。手表同步和撤回仍需用户手动操作，教练状态变化不会自动修改设备。

`POST /v1/mobile/lock` 带 `action: lock|relock` 和当前 `recommendationRevision`。服务端只拒绝两种情形：上次健康同步失败（`409 mobile_refresh_failed`），或建议版本已过期（`409 mobile_recommendation_stale`）。**今天没有恢复记录不是拒绝理由** —— 没戴表是普通的覆盖缺口，不应阻止锁课；锁课只允许联网执行。

健康同步上传在 `POST /v1/imports/uploads` 带 `X-RAI-Sync-Batch` 请求头。该标识绑定当前服务实例的持久化同步批次；同一标识重复上传返回原来源，不重新创建来源。客户端只使用 SHA-256 批次值，服务端拒绝格式异常的标识。

## 错误

服务端错误至少包含 `code` 和 `message`。Swift 客户端将：

- `401` 映射为凭证错误，不自动重试。
- `409` 映射为数据/建议/目标冲突，并保留本地缓存。
- 超时、断网映射为不可用，允许读取缓存。
- 解码失败映射为协议不兼容，保留诊断上下文。

新增字段优先兼容扩展。Swift DTO 不复制 TypeScript 评分、恢复或预测逻辑；未知枚举按字符串保留，页面使用默认标签。

## 2026-09-28 增量契约：反馈与脱敏导出

### 训练反馈

复用 `POST /v1/commands`，`kind: "workout_override"`，payload 为完整训练覆盖字段与 `trainingSessionId`，新版客户端另传 `expectedRevision`（尚无覆盖时为 0）。服务端在真正执行事务中检查当前 revision，不只在入队时检查。

- 202/queued/running 不是保存成功；查询 `GET /v1/commands/:id` 的终态。
- `workout_override_revision_conflict` 表示另一端已修改，必须读取新版本并由用户决定，不静默覆盖。
- 重试同次操作使用原 idempotencyKey，保留所有未编辑字段。清空 RPE/备注时发送显式 null。
- succeeded 表示反馈保存；`result.jobId` 指向后续分析任务，分析失败不撤销反馈保存事实。
- 旧 `PATCH /v1/workouts/:id/override` 同样支持 expectedRevision。为了旧版兼容暂不强制，不能因此宣称旧客户端也具有冲突保护。

### 按日查看训练

`GET /v1/workouts?localDate=YYYY-MM-DD&limit=30&offset=0`，日期按 Asia/Shanghai 自然日解释，包含该日起点、不包含次日起点。返回既有分页 DTO，不从无记录推断漏课。

### 摘要导出

`GET /v1/exports/workout-summary?from=YYYY-MM-DD&through=YYYY-MM-DD`：需配置且携带 Bearer Token，公开 Host 也不允许匿名使用。

返回 `{ from, through, timezone, count, csv }`；有效范围最多 366 日、最多 2000 条，否则明确返回 400。CSV 仅包含已分析训练的开始时间、类型、距离、时长、配速；无路线、备注、健康原始值或内部 ID。结束日完整包含。响应禁止缓存，用户必须先预览再显式导出。

### 旧周计划生成接口

原生已不再定义直接 `generate` 客户端方法，使用 preview/confirm 两阶段。服务端旧接口为兼容保留并标记 deprecated，不再作为新客户端集成入口。

## 2026-10-07 增量契约：跑步教练的准备度与预算

`GET` / `POST /v1/mobile/run-coach` 新增两个字段，均为**兼容扩展**（旧客户端忽略即安全）：

- `confidence`：`null`（无比赛计划或体能计划）或 `{ status, value, band, basis, components, evidenceLevel, reasonCodes, note }`。
  - `value` 是 0–100 的**备赛准备度**，不是达标概率；`note` 每次都声明这一点。
  - `status !== "available"` 时 `value` / `band` / `components` / `evidenceLevel` 一律为 `null`。**客户端不得把 `null` 显示为 `0`** —— 0 会被读成"准备度为零"这个断言（与 `@rai/durability` 对 `durabilityScore` 的红线同形）。空态必须显示"暂无法给出信心值"。
  - `band` 分界 70 / 40 是 policy 常数、未拟合；校准未完成时不允许 `high`。
  - `reasonCodes` 含 `unsupported_distance` 表示该距离不在预测链内（当前 5K / 10K / 半马之外均如此）。
- `unplannedDays`：`[{ localDate, code, detail }]`，只覆盖**用户自选的跑步日**中本周没有排入训练的那些天。`code` 是事实码（`no_session_scheduled` / `pre_race_taper`），`detail` 是可观测计数，不含动机判断。

同时修正 `weeklyCapacityKm` 的语义：它现在是**本周可花预算**（`min(容量, 本周量带上限)`），与生成侧和今天页量带上限同源。它此前的值是未按阶段裁剪的容量，与生成侧实际使用的数字不一致；**同名同型，取值口径变了**，如果客户端把它当作"上限"来做二次裁剪，请改用今天页的 `periodization.current.volumeBandKm.upper`。

## 2026-10-18 增量契约：事实可见性、新鲜度与覆盖探测（同步诊断 P0-1/P0-3/P1-1）

背景：一次训练的事实与它的分析发布**不是同一时刻**（生产实测相差 102.5 s）。此前读侧以“已发布分析”
为唯一入口，这段窗口里列表看不到、详情 404，且响应里没有任何“仍在补齐”的字段。以下三个变化
都是**兼容扩展**（只加字段 / 把 404 场景变 200 / 新增读端点），既有字段语义不变。

### 事实已提交、分析未发布时的读契约

`GET /v1/workouts` 的 `items[]` 与 `GET /v1/workouts/{id}` 现在**事实驱动**：

- 事实（workout + training_session + records）存在 ⇒ 列表包含该行、详情返回 **200**；
  只有**事实不存在**（或已软删）才 404（详情仍是 `{"message": "未找到该训练记录"}`）。
- 每行新增可选字段 `analysisPublishStatus`：`"pending" | "published" | "failed"`。
  `pending` 时派生字段是 `null`/占位，**不是**结论：
  - `sessionType = "unclassified"`、`eligibilityStatus = "pending"`、`qualityScore = 0`、
    `modelVersion = ""`、`assessmentStatus = null`、`currentAbility/confidence/trueAbilityDelta = null`、
    `dimensions` 全为 `null`；
  - 事实侧能回答的照常给出：`startedAt/endedAt/durationSeconds/distanceKm/averageHeartRateBpm`
    （来自 workout/session/`workout_statistics`；没有证据时保持 `null`，不编造）；
  - 详情 `facts.analysisState = "pending"`，且 `analysis` 块为 `null`（没有已发布 release）。
  - ⚠️ 2026-10-19（A6）扩展：**旧分析可读但未覆盖最新事实**时状态同样是 `pending`，但派生字段是
    旧分析取值 —— 由 `analysisAvailable` 区分，见下面的 2026-10-19 增量契约。本段的“null/占位”
    只适用于 `analysisAvailable = false`。
- 客户端**不得**把 `qualityScore = 0` 或空维度显示成真实分数；应显示“分析中”。
- 带特征过滤（`status`/`sessionType`/`confidence`/`participation`）时 pending 行会被排除，
  这是契约允许的（它还没有 eligibility/sessionType）；**不带**过滤时必须包含 pending 行。

### `GET /v1/workouts/{id}/freshness`

```jsonc
{
  "workoutId": "training_session_…",
  "facts":   { "committedAt": "2026-10-18T12:29:38.755Z",
               "lastBatchAt": "2026-10-18T12:31:50.405Z", "batches": 6 },
  "analysis":{ "status": "pending", "jobId": "recompute_job_…", "publishedAt": null },
  "series":  [ { "metric": "heartRate", "samples": 512, "state": "present", "lastAvailableAt": null },
               { "metric": "strideLength", "samples": 0, "state": "not_seen_yet", "lastAvailableAt": null } ],
  "completeness": "partial"
}
```

- `metric` 固定集合：`heartRate/speed/power/cadence/strideLength/verticalOscillation/groundContactTime/elevation`；
  `samples` 与 `/series` 同口径（窗口内去重样本数；`elevation` 为可读路线点数）。
- `state = not_seen_yet` 表示“目前没有样本，可能还在传输”，**不是**“设备不支持该指标”；
  界面用“数据仍在传输”，不要用“暂无数据/设备不支持”。
- `lastAvailableAt` 是 P2-2（`health_records.available_at`）落地后的每指标最近接收时刻；
  旧库/未迁移时为 `null`（表示“不知道”，不是“从未到达”）。客户端按可选字段处理。
- `completeness = complete` **仅当**分析已发布且 `lastBatchAt` 距当前 ≥ 24h；
  其余为 `partial`。24h 是“数据已稳定”的下界证据，不是“永远不会再补齐”。
- 鉴权与 `/v1/workouts/{id}` 相同；事实不存在 ⇒ 404。

### `GET /v1/sync/coverage?types=a,b`

```jsonc
{ "datasetEpoch": "default",
  "types": [ { "type": "HKQuantityTypeIdentifierStepCount",
               "knownFrom": "2024-01-01T00:00:00.000Z", "knownUntil": "2026-10-18T11:40:00.000Z",
               "sampleCount": 534789 } ] }
```

- `types` 可选（逗号分隔）；缺省返回全部类型；未知类型不补空行。
- 覆盖区间是“已落库样本的端点”，**不证明区间内没有空洞**；客户端只能据此**跳过重传**
  服务端已有历史，不得删除本地游标、不得跳过真正的待办。
- `datasetEpoch` 与 `/v1/handshake` 同源；epoch 变化后旧结论作废。
- `/v1/handshake` 新增可选能力位 `syncCoverageVersion`（当前 `1`）；老服务端省略 ⇒ 客户端
  必须回落“照常重放”，不得假设服务端已覆盖。

### 直连回执的记录计数

`/v1/import-jobs` 的 `summary.directSync`（持久回执，写入后**不可改写**）新增可选块：

```jsonc
"records": { "parsed": 4500, "inserted": 622, "unchanged": 3878 }
```

`parsed` = 本批 XML 的 `<Record>` 条数，`inserted` = 新增行数，`unchanged = parsed - inserted`
（显式删除事件不在 `parsed` 内）。老服务端省略该键 ⇒ 客户端按“未提供”处理，不得当成 0。
它让“本批 0 新增”可以被回执直接解释；不改变 `ingestStatus` / `analysisStatus` 的既有语义。

## 2026-10-19 增量契约：分析发布状态与三态新鲜度（A6 / A5，P2-2 / P2-3）

背景：`analysisPublishStatus` 此前只回答“有没有评估行”，于是**旧评估已发布 + 更新的分析任务仍排队/失败**
被读成 `published`（审计 A6 复现：`jobId` 指向新任务，`status` 仍是 `published`）。同时 `/freshness` 的
`completeness` 把“事实到没到 / 分析跟没跟上 / 观测是否稳定”混成一个值（审计 A5：power 0 样本仍报 `complete`）。
本轮是**兼容扩展**：只加字段，`/v1` 既有字段不删；`completeness` 语义本轮**不变**。

### 分析发布状态：区分“旧分析可用”与“新分析未发布”

- `analysisPublishStatus` 的 `"pending"` 含义扩展为**“没有覆盖本训练最新事实代次”**，不再等价于
  “从未发布”；`"failed"` 表示更新事实的分析任务失败。两个状态都可能**仍有旧分析可读**。
- 新可选字段 `analysisAvailable`（`/v1/workouts` 的 `items[]` 与 `/v1/workouts/{id}` 的 `workout` 块）：
  `true` = 存在指向当前 active release 的评估行（旧分析可读）。
  - `published` ⇒ `analysisAvailable = true`，派生字段是最新结论；
  - `pending` + `analysisAvailable = true` ⇒ **旧分析可用、新分析未发布**：详情仍 **200**，派生字段是
    **旧分析**的取值（`currentAbility/modelVersion/...` 非 null），但**不得**当作最新结论展示；
  - `pending` + `analysisAvailable = false` ⇒ 从未发布过分析，派生字段是 null/占位（2026-10-18 的语义）；
  - `failed` ⇒ 更新事实的分析任务失败；旧分析（若有）仍可读，界面应显示“分析未完成”而不是“分析中”。
- 服务端判据（读侧推断，不新增存储）：已发布评估视为最新 ⟺ 它覆盖的依赖代次 ≥ 影响本训练的最新批次代次。
  证明点优先用当前 active release 的 `analysis_run_input_bindings.captured_dependency_generation`（v39+），
  退化时退回 `active_model_run.activated_at` 与批次完成时刻的比较；另外，指向未覆盖批次的
  `queued|running` 任务一律视为“新分析未发布”，`failed` 任务视为 `failed`。
- 详情 `facts.analysisState = "analyzed"` 且 `analysis` 块仍返回（旧分析可读），与 `pending` 可同时出现；
  “是否最新”只看 `analysisPublishStatus`。列表、详情、`/freshness` 三处由同一判据派生，必须一致。
- 老服务端省略 `analysisAvailable` ⇒ 客户端必须把 `pending` 一律按“占位行”处理（保守，不把旧分数冒充最新）。

### `GET /v1/workouts/{id}/freshness`：`deliveryState` / `analysisState` / `stabilityState`

```jsonc
{
  "workoutId": "training_session_…",
  "facts":   { "committedAt": "2026-10-18T12:29:38.755Z",
               "lastBatchAt": "2026-10-18T12:31:50.405Z", "batches": 6 },
  "analysis":{ "status": "pending", "available": true,
               "jobId": "recompute_job_…", "publishedAt": "2026-10-18T12:31:21.265Z" },
  "series":  [ { "metric": "heartRate", "samples": 512, "state": "present", "lastAvailableAt": null } ],
  "deliveryState": "delivered",
  "analysisState": "pending",
  "stabilityState": "settling",
  "completeness": "partial"
}
```

- `analysis.available`（A6）：旧分析是否仍可读（语义与列表项 `analysisAvailable` 相同）；`true` 时
  `publishedAt` 是**旧发布**时刻，`status = pending` 表示它没有覆盖最新事实代次。
- `analysisState`：`published | pending | failed`，与 `analysis.status` **同值同源**（不要各自解释）。
- `stabilityState`：`stable`（`facts.lastBatchAt` 距当前 ≥ 24h）| `settling`（仍可能有新批次）。
  **24h 静默只影响本字段**，不参与 `deliveryState` / `analysisState`。
- `deliveryState`：`delivered | partial | unknown`。服务端只能给**到达证据**（没有客户端“本次读到哪些类型”
  的回执）：
  - `unknown`：没有任何到达证据（`facts.batches = 0`）——“不知道”，**不得**据此显示“Apple Watch 仍在传输”；
  - `partial`：只有窗口内记录账本、没有 workout 实体写入证据 ⇒ 数据面不完整；
  - `delivered`：本训练实体已由成功批次交付到服务端。它**不**声称“手机已读尽”，也不声称设备具备某指标；
    逐类型是否“应当有”留给下一版（与逐类型读取回执同批）。
- `completeness` 语义本轮**不变**（仍 = 分析已发布 && 24h 静默）；下一版才改为
  `deliveryState = delivered && analysisState = published`。
- 老服务端省略三个新字段 ⇒ 客户端按可选字段处理（`nil` = 不知道，不要当作 `delivered/stable`）。

## 训练计划一致性与排期回执（2026-10-09）

后续增量：完整聚合能力 `planSnapshotContractVersion=1`、持久发布能力 `planPublicationContractVersion=1`、回执事件能力 `planReceiptContractVersion=2`。端点、必需安全字段、版本降级、90 天结果保留、墓碑与恢复规则见 [IOS_TRAINING_PLAN_STATE_V1](IOS_TRAINING_PLAN_STATE_V1.md)。新增能力独立协商，不能用旧 `planReceiptMetadata` 布尔发送版本 2 字段。

实现与兼容政策见 [IOS_TRAINING_PLAN_IMPLEMENTATION](IOS_TRAINING_PLAN_IMPLEMENTATION.md)。
`/workout-plan/synced` 的准确语义是客户端**本地系统日程已核验**；不是物理手表收到的证明。
新可选字段：`workoutID`（UUID）、`scheduledAt`（ISO 8601 时刻）、`idempotencyKey`、`exportNotes`。
`structure` 是实际导出的结构，不是未加说明的原始处方。相同幂等键不同内容拒绝；相同内容重试返回首次 recordedAt。
旧客户端照常发送原四字段；新客户端通过可选 `handshake.planReceiptMetadata` 能力位决定是否发送新增字段。

客户端安全字段（revision、timezone、windowDays、executable、结构的 goal 类型/剂量）不得用乐观默认掩盖缺失。
解释字段新增使用 Optional 或明确的 decodeIfPresent 策略；普通 stored-property 默认值不是缺键解码策略。
未知计划状态不解释成 active，未知可执行目标不解释成 open。legacy today 缺 planRevision 可解码，但不能用于当前训练确认或手表同步。
写成功后读取失败仍算“已保存待刷新”，不能暴露低版本执行缓存，不能引导重复提交；缓存清理不删除确认水位。
