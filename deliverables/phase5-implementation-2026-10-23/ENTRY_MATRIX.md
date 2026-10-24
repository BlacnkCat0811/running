# 阶段 5 用户入口与 wire 合同矩阵

**日期：** 2026-10-23（Asia/Shanghai）  
**范围：** 原生 iOS 可达入口（`apps/ios/RAI`）→ `NativeAppModel`/`TrainingPlanPublisher`/`APIClient`
→ 方法+路径。旧服务器页面（`TechRunCoachView`/`TechManualPlanView`）只在服务未宣告
`coachLoopContractVersion` 时展示；新服务上不可达。

| 入口 | 可用条件 | 方法 + 路径 | 请求合同/关键字段 | 失败表现 | 测试 ID |
|---|---|---|---|---|---|
| 打开训练页 / 下拉刷新 | 已连接；统一读可用 | `GET /v1/mobile/training-plan-state` | Header `X-RAI-Training-Contract: 2`；只读 | 404/409/503 映射为升级/未迁移/可重试；不写表 | T02/T03/T26 |
| 打开训练页（执行快照） | 已连接 | `GET /v1/mobile/today`、`GET /v1/mobile/workout-plan` | 既有 v1 执行合同 | 失败保留参考状态；暂停/结束强制 `executable=false` | T17/T26 |
| 编辑目标 / 暂停恢复 / 刷新（按钮） | `trainingPlanCommandContractVersion == 2` 且 `canEditTrainingPlanV2` | 先 `POST /v1/mobile/training-plan/commands/preview` | `contractVersion:2`、`operationScope`、`action`、`expectedStateRevision`、可选 `raceGoal` | 409 重读/重新预览；410 退役；503 重读 | T01/T06/T07/T26 |
| 保存赛事目标（设置） | 同上 | `POST /v1/mobile/training-plan/commands` | `operationId`、`candidateId`、`action=set_race_goal`、`raceGoal` | 键冲突/候选过期/修订冲突均不写业务行 | T05/T07/T08 |
| 清除赛事目标 | 同上 | 同上 | `action=clear_race_goal` | 不是 `end`；不删除历史；展示转换后模式 | T05/T07 |
| 暂停 | 同上 | 同上 | `action=pause` | 发布配置状态，不生成计划；拒绝新执行；手表旧条目待前台撤回 | T05/T17 |
| 恢复 | 同上 | 同上 | `action=resume` | 已结束返回 `training_cannot_resume`；不自动排期 | T05/T17 |
| 刷新/重新生成（独立确认） | 同上 | `POST /v1/mobile/training-plan/commands/refresh` | `operationId`、`scope`、`expectedStateRevision`；**无 candidateId** | 409 busy/revision/snapshot；不伪造预览语义 | T08/T15/T16 |
| 取消预览/关闭编辑器 | `previewReady` | 无网络写 | 客户端本地撤销 | 零业务变化；不等于 pause/clear/end | T06 |
| 提交后取消等待 | `submitting`/`querying` | 停止等待；`GET /v1/mobile/plan-operations/:id` | 持久 `operationId` | HTTP 取消不证明回滚；UI 显示待查询 | T10/T11/T20 |
| 冲突/候选过期后重试 | `needsPreview` | 重新读 → 重新预览 → 新 submit | 新 revision/candidate/operationId | 不自动提升 revision；旧 payload 不绑新候选 | T06/T09/T12 |
| 结果未知后查询 | `querying`/pending | `GET /v1/mobile/plan-operations/:id` | 原 operationId；只有业务 `notFound` 才可原字节重放 | 404 不等于 notFound；expired/scopeMismatch 终局 | T10/T11 |
| 手动课表/逐日编辑 | **不可用（D20.2）** | 无 | 只读说明；当前无对应 v2 action | 不调用退役 `/goals`/`workout-plan/*` | T04/T28（N/A） |
| 训练偏好/创建模式（coach-loop） | `coachLoopContractVersion == 1` | `POST /v1/mobile/coach-loop` | 既有 coach-loop 命令；写入汇入 unified owner | 事实/修订/策略冲突显示稳定错误；不新增第二写者 | T03/T17 |
| 结束当前模式 | `coachLoopContractVersion == 1` | `POST /v1/mobile/coach-loop` `action=end` | 既有合同 | 生命周期结束，不是 pause/删除；不回写全休息为“完成” | T17 |
| 锁课 / 重新锁课 | 执行快照可用且 unified active | `POST /v1/mobile/lock` | 既有 `LockMobileSessionRequest` | 暂停/结束 409 `training_paused`；不新增执行 | T17 |
| 反馈 / 手表排期回执 | 既有合同 | `POST /v1/mobile/coach-feedback`、`POST /v1/mobile/workout-plan/synced` | 既有专用接口 | 失败保留 pending/回执；不伪造设备可见性 | T27（设备层） |
| 旧服务器手动/旧教练页面 | 仅旧服务（无 `coachLoopContractVersion`） | 旧 `/v1/mobile/goals`、`/run-coach`、`/workout-plan/*` | 已登记旧协议 | 新服务上一律 410；客户端 `legacyPlanWritesSupported` 必须为真才发 | T01/T04/T30 |

## 1. 能力组合

| 组合 | 客户端行为 | 测试 |
|---|---|---|
| 无握手 / 未知服务 | 不新增 v2 写；不把缺字段当支持 | T01 |
| 仅 `trainingPlanContractVersion=2`（生产候选关闭） | 统一读可用；v2 写按钮不出现/禁用；coach-loop 生命周期入口保留 | T01/T03 |
| `trainingPlanContractVersion=2` + `trainingPlanCommandContractVersion=2` + `planPublicationContractVersion=1` | v2 preview/submit/refresh 可用；旧 URL 请求数 0 | T01/T08/T26 |
| 未知 command 版本（如 999） | 只读；零 v2 写请求 | T01 |
| 缺 `planPublicationContractVersion` | 无持久操作账目；不进入 v2 命令流程 | T01 |
| 已迁移且 owner-ready 的 managed scope | v2 读允许；v1 managed 读仍 409 | T03 |
| 损坏 receipt/owner 指针 | fail-closed 409；不自动迁移 | T03 |
| 旧服务器（明确旧协议） | 按其既有协议；不发送 v2 | T01/T30 |

## 2. 退役负例

所有新服务上的 5 条路径 / 7 个操作必须 410 + `legacy_surface_retired` + replacement + `no-store`；
未知路径 404；退役写不改 revision。证据：`legacy-surface-retirement.test.ts`（真实 router 矩阵）与
`phase5-training-plan.test.ts`（`/v1/mobile/goals` 410、未知路径 404、认证 401）。
