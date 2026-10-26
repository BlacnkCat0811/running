# B07：原生执行关联、纠错与 managed 回顾 / S03-05

日期：2026-10-25（Asia/Shanghai）。状态：**iOS 实现、聚合自测与 Simulator 点击链通过；G3 待最终全量回归签收**。

## 范围与文件

- [APIModels](../../apps/ios/RAI/APIModels.swift)：执行候选/命令/执行视图/`WorkoutExecutionAssessment` 镜像；`TrainingPlanSessionsView.executions` 可选兼容解码，删除旧的拒绝解码分支。
- [APIClient](../../apps/ios/RAI/APIClient.swift)：候选 GET + 执行命令 POST，三个精确协商头；新路由 404 若无 `training_session_not_found` 映射为“路由不支持/需升级”，不当 operation notFound。
- [TrainingPlanPublisher](../../apps/ios/RAI/TrainingPlanPublisher.swift)：执行命令复用唯一 pending row/journal；原 UUID/字节一次编码持久化；重启先查原操作；仅业务 notFound 按原字节重放；committed 不重提；只写 state/goals 水位。
- [TrainingPlanStore](../../apps/ios/RAI/TrainingPlanStore.swift)：缓存可选 executions；旧 GET 不能覆盖新写/换实例；`acknowledgeExecution`。
- [PlanStatePolicy](../../apps/ios/RAI/PlanStatePolicy.swift)：严格校验 execution/assessment 枚举与关联语义，未知值 fail-closed。
- [NativeAppModel](../../apps/ios/RAI/NativeAppModel.swift)：课程详情按需拉候选；确认/纠正/撤回/跳过走 execution command；提交前取消旧读、失败保留草稿、成功后完整重读；不调用 WorkoutKit。
- 新增 [TrainingPlanExecutionPolicy](../../apps/ios/RAI/TrainingPlanExecutionPolicy.swift)：候选选择、关联/评价文案、skip/retract 资格、历史回顾、中文错误码、快照水位判定。
- 新增 [TechTrainingExecutionReview](../../apps/ios/RAI/Skins/Technology/TechTrainingExecutionReview.swift)，接入现有 `TechPlanView` / `TechTrainingSessionEditor`：计划 vs 实际、关联状态、实际距离/时长/起止、剂量/刺激、候选/确认/改选/撤回/跳过、能力缺失只读。
- 回归：[TrainingPlanExecutionRegression](../../apps/ios/tests/TrainingPlanExecutionRegression.swift)、[V2](../../apps/ios/tests/TrainingPlanV2Regression.swift)、[Store](../../apps/ios/tests/TrainingPlanStoreRegression.swift)、[Publisher](../../apps/ios/tests/TrainingPlanPublisherRegression.swift)；已登记到 `run-model-tests.sh` 与既有 `run-*.sh` 聚合链。

## 语义

- 候选**永不自动确认**；`needs_confirmation` 与 `verified_identity` 都在用户点选后才提交。同日多跑、一跑多课保留给用户。
- `sessions.executions` 缺位按“执行视图未知”展示，不当空历史；未关联行不宣称未完成。
- 确认/纠正/撤回/跳过产生新的 executionRevision；撤回保留原完成处方和当次评价历史，当前评价转 invalidated。
- 剂量、刺激、关联、生命周期分开显示；partial 只在明确剂量不足时显示，summary-only 保持未知。
- 新路由 404 与 410 区分：未知路由提示升级；410 仍是退役终局。持久 operation 只在已知 committed/业务 notFound 时重放，未知结果保留原 journal。

## 已执行结果

| 命令 / 范围 | 结果 |
| --- | --- |
| `npm run test:ios`（聚合） | EXIT=0：typecheck 102 files；V2 133 checks；Publisher regression；Execution regression 64 checks；Store 67 checks；iOS source gates 通过 |
| `TrainingPlanExecutionRegression.swift` | 64 checks PASS（DTO、状态机、候选、评价文案、journal 重放/水位） |
| `TrainingPlanV2Regression.swift` | 原“拒绝 executions”改为兼容解码后 PASS |
| `TrainingPlanStoreRegression.swift` | 67 checks PASS（executions 缓存、旧 GET 拒绝、实例切换） |
| Simulator `testExecutionConfirmRetract`（B10 串行执行） | 1/1 PASS（最终复跑 75.5 s；首次 160.8 s）：隔离合成 run 出现在候选、确认后 API 读回 `completed/confirmed`、撤回后 `pending/invalidated`；截图 [确认](simulator-execution/screenshots/execution-confirmed.png) / [撤回](simulator-execution/screenshots/execution-retracted.png) |

## 剩余门

- Simulator 真实点击链已执行：`RAI_VISUAL_EXECUTION_FACTS=1` 的隔离 fixture 合成一条 run，`testExecutionConfirmRetract` 1/1 通过；截图与服务端 API 断言一致。
- 未执行：iPhone 12 Pro Max 真机、配对 Watch、HealthKit 真机链路、生产启用。
- G3 待最终全量回归/签收记录；B06 后端真实 API 与 B07 Simulator 点击链均已通过。
