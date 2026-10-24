# 阶段 5 训练命令状态矩阵

**日期：** 2026-10-23（Asia/Shanghai）  
**合同：** `POST /v1/mobile/training-plan/commands/{preview,}` 与 `POST /training-plan/commands/refresh`；
body 声明 `contractVersion: 2`。候选 TTL 120 秒，操作结果保留 90 天。

## 1. 服务端状态

| 阶段/查询结果 | 产生条件 | 持久副作用 | 客户端必须做什么 |
|---|---|---|---|
| `preview`（无状态） | `commands/preview` 合法请求 | 无；不写 unified/goals/history/operation | 展示 before/after 和警告；确认前重新检查 revision/candidate/身份 |
| 新 `submit` / `refresh` | 候选/revision 仍有效且 operation key 未存在 | 同一 control publication transaction 写 unified、goals 投影、计划历史、plan operation result | 只发送一次；落盘 operationId 与原始 Data 后再发 |
| `committed` | `GET /plan-operations/:id` 查到未过期结果 | 无（只读） | 接纳原结果；完整重读 unified + 执行快照后才恢复编辑 |
| `notFound` | 该 scope 没有 operation 行 | 无 | 仅当身份仍一致、候选仍有效且允许执行时，按原键/原字节/原 UUID 重放；HTTP 404 不等于它 |
| `scopeMismatch` | 同 operationId 属于另一 scope | 无 | 终局：关闭该本地 pending；不跨域重放 |
| `expired` | 操作超过 90 天保留期 | 服务端将结果置空（不重新执行） | 终局：显示过期；需要新预览/新操作 |
| `training_revision_conflict` | `expectedStateRevision` 已过期 | 无 | 重读 → 用户重新预览/确认；不得自动提升 revision |
| `training_candidate_expired` / `training_candidate_mismatch` | 预览超过 120 秒、候选被改动 | 无 | 保留草稿；重新预览，旧 payload 不可绑定新候选 |
| `training_snapshot_changed` | 生成期间主库事实/配置/epoch 变化 | 无；原计划不变 | 重新读事实并重新预览；不重试旧候选 |
| `coach_sync_pending` | 导入/重算等事实更新尚未完成；生成前与提交前检查 | 无；重放已提交结果仍优先；暂停允许撤销执行 | 待更新任务完成后重读并重新预览 |
| `training_commands_disabled` | 未在隔离候选或能力未宣告 | 无 | 只读；不发写请求 |
| `training_plan_empty` / `training_scope_mismatch` / `training_plan_not_migrated` | 生成器空结果/迁移/范围错误 | 无 | 原计划不变，展示稳定错误 |
| `training_paused` | 暂停中刷新 | 无 | 恢复后才能生成；不得自动 resume |
| `training_cannot_resume` | 已结束节目请求 resume | 无 | 结束不可逆；建立新配置 |
| `training_plan_owner_invalid` | unified/receipt 指针不一致或损坏 | 无 | fail-closed；提示恢复控制库，不写 |
| `weekly_plan_generation_busy` | 同一时刻已有生成中的请求 | 无 | 有界等待/稍后重试；不另开队列 |

## 2. iOS `TrainingPlanPublisher` 状态机

`idle → previewing → previewReady → persistingIntent → submitting → committedAwaitingRead → ready`

| 状态 | 入口 | 退出/失败 | 关键断言 |
|---|---|---|---|
| `idle` | 打开训练页、取消预览 | `makePreview`；`invalidate` | 取消预览零写入、无 pending |
| `previewing` | `makePreview` | 成功 `previewReady`；失败 `needsPreview`/`querying`；关闭/草稿变化 → `idle` | 取消推进 generation，迟到回包不得恢复候选；不写 operation |
| `previewReady` | 预览成功 | 用户确认；草稿变化/关闭 → `idle` | 候选绑定服务 URL、serverId/athleteId/epoch、会话代次、stateRevision；确认匹配当前草稿 |
| `persistingIntent` | 确认/刷新 | 落盘成功 → `submitting`；未发送即落盘失败 → `needsPreview`，重读后可重新预览 | 落盘失败**零写请求**，不进入无 pending 的恢复死角 |
| `submitting` | `persistAndSubmit` | 成功 `committedAwaitingRead`；409/410/422 终局拒绝；未知 `querying` | 原操作 UUID/Data 只在 journal 中；不因 Task 取消而假定服务端回滚 |
| `querying` | 提交结果未知、`recover` | committed 接纳；notFound 条件重放；expired/scopeMismatch 关闭；未知保留 | HTTP 404 ≠ 业务 `notFound` |
| `committedAwaitingRead` | 收到持久 result | 完整重读成功且 `finishRead` 清账 → `ready`；重读失败保持 | 只重读、不重写；旧读不能覆盖确认水位 |
| `storageFailure` | 确认水位/清账落盘失败 | 恢复后可重试查询 | 不报告“已撤销/已清除”；阻止新增排期，仍允许通过本机账目显式撤回 |
| `needsPreview` | 冲突/候选过期/验证错误 | 重新预览 | 保留草稿；所有重试按钮明确是重读、查询还是重新预览 |
| `invalidated` | 身份/URL/token/配置变化 | 下一次 preview | 旧回包丢弃；旧候选不跨域重放 |

## 3. 双水位与幂等

| 水位 | 存储 | 语义 | 约束 |
|---|---|---|---|
| `stateRevision` | `TrainingPlanCommandWatermark`（独立 app_metadata） | unified 当前 revision | 不接受回退；完整重读后比较 |
| `goalsRevision` | 同上（同一记录中独立字段） | goals 投影/执行快照 revision | 与 `stateRevision` 分开比较，禁止用一个 `max` 混合 |
| 执行计划 revision | 既有 `PlanWriteAcknowledgement` / `minimumRevision` | 执行快照可确认水位 | 仍只由既有执行读/写确认提高 |
| operationId + 原始 Data | `PendingPlanPublication` | 持久意图与重放字节 | 落盘失败不发送；终局 410 只关闭对应 pending，不擦 ledger/回执/撤回风险 |

## 4. 状态与 UI 文案

- 409：保留草稿，提示“当前状态或候选已变化，请重读后重新预览并确认”。
- 410：终局退役，关闭本地 pending，提示升级；不能当 notFound 重放。
- 503：可重试的服务不可用；先重读，不自动重提。
- 404：路径/版本错误；不能当业务 notFound。
- 未知状态/未知 code：不重放、不启用执行，保留 pending 并显示诊断。
- 提交后关闭页面只停止等待；待确认结果仍可查询。取消 HTTP Task 不等于服务端回滚。
