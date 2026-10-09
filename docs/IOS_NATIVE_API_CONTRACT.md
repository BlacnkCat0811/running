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

页面缓存的命名空间同时包含服务 URL、`serverId`、`athleteId` 和 `datasetEpoch`。服务端数据库恢复或替换数据集时，改变 `datasetEpoch`，旧缓存和游标不得继续作为当前结果使用。

## 读接口

| 用途 | 接口 | 客户端处理 |
| --- | --- | --- |
| 今日 | `GET /v1/mobile/today` | 读取恢复、建议、周进度和最近训练；显示 `latestDataDate` 与 `generatedAt` |
| 训练列表 | `GET /v1/workouts?limit=&offset=&sessionType=` | 以 `id` 去重，按分页追加 |
| 训练详情 | `GET /v1/workouts/{id}` | 读取缺失指标的 `null`，不以零替代 |
| 时序 | `GET /v1/workouts/{id}/series` | 各指标使用自身 `unit` 和同一时间轴 |
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
