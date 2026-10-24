# 阶段 5 训练状态所有权矩阵

**日期：** 2026-10-23（Asia/Shanghai）  
**范围：** 原生 iOS ↔ Node API ↔ 共享合同；不包含已退役的 Web/macOS 客户端。  
**决策：** [DECISIONS D20](../../docs/DECISIONS.md)；方案：[阶段 5 审查与实施方案](../phase5-review-2026-10-23/PHASE5_REVIEW_AND_IMPLEMENTATION_PLAN.md)。

## 1. 唯一责任表

| 数据/语义 | 权威来源 | 允许的写入者 | 兼容投影/读取 | 禁止的做法 |
|---|---|---|---|---|
| 迁移来的训练偏好证据 | unified 的 `runCoach`；配置 coach-loop 后由其不可变回执接替 | 迁移器；显式配置 coach-loop | goals 中清空旧 programme 后仍保留 unified 证据；该旧生命周期不再授权执行 | 用兼容投影中的 null 覆盖仍有效的偏好证据 |
| 当前赛事目标、运行状态（`raceGoal`、`runState`、`sourceStatus`） | `mobile_training_state`（unified） | `TrainingPlanCommandService.submit`；coach-loop 的 enable/update/pause/resume/end（经 `MobileGoalsStore.write` + `reconcileTrainingPlanOwner`）；迁移器 | `mobile_goals.raceTarget` 投影；v2 读与 coach-loop 读从 unified 派生 | 直接改 `mobile_goals` 后不回写 unified；GET 时迁移；用 `end` 冒充 `pause` |
| 计划意图与当前计划窗口（`weekPlan`、`planContextDigest`、审核行） | unified（同一行） | `submit`/`refresh` 的 publication transaction；coordinator 的唯一 refresh 入口；coach-loop 的 `write` | `mobile_goals.weekPlan` 与执行快照；v2 `plan.days` | 第二个调度器；客户端重写评分/处方；把 `refresh` 当手动保存 |
| 当前锁课（`lockedSession`） | unified | `/v1/mobile/lock` 的 lock/relock（经同一 publication transaction）；pause/end 清锁 | `mobile_goals.lockedSession` 投影；执行快照 | 锁课绕过 unified；暂停/结束后仍授权新执行 |
| 执行授权 | **只属于既有执行快照**（`/v1/mobile/today`、`/v1/mobile/workout-plan` 的可执行处方） | 只由现有执行合同产生 | v2 投影的 `execution.permitted` **恒为 false** | 用 unified 投影授权 WorkoutKit；用命令成功代替设备撤回 |
| 计划历史 | `mobile_training_state_history` / `mobile_goals_history` | publication transaction 内追加 | 读侧按 scope 读取 | 更新/删除历史；把历史塞进 unified JSON |
| 持久操作账本 | `mobile_plan_operations` | `PlanPublicationService` / `MobileGoalsStore.publicationOperation` | `GET /v1/mobile/plan-operations/:id` | 同键异载荷复用；过期重执行；删除 pending 冒充完成 |
| coach-loop 决策回执 | `mobile_coach_loop_receipts`（append-only） | `CoachLoopRuntime` 命令；统一命令的 `publishCoachEvidence` | unified 的 `coachLoop` 指针；`currentCoachLoopState` | 修改旧 receipt；用旧 receipt 覆盖当前配置；无指针的孤儿 receipt 当当前 |
| 旧 `mobile_goals` 行 | 兼容投影（当 unified 存在时） | 只经 `MobileGoalsStore` 的同一事务/同一所有者写入 | 旧服务器/旧客户端的既有协议 | 在新服务上重新开放旧写面；把 goals 当第二当前真相 |

## 2. 写入路径与事务边界

1. **统一命令**：`TrainingPlanCommandService.preview` 只读；`submit`/`refresh` 在
   `PlanPublicationService.publish` 内执行，`MobileGoalsStore.withPublicationTransaction` 提供
   control-DB `BEGIN IMMEDIATE`、publication guard、CAS 和 operation 结果写入。
2. **coach-loop**：`CoachLoopRuntime.command` 同样经 `PlanPublicationService.publish("coach-loop", ...)`；
   在同一个事务内写 goals、追加 receipt；事务结束前 `reconcileTrainingPlanOwner` 将
   `goalsRevision`、`weekPlan`、`lockedSession`、`legacyRaceTarget`、`coachLoop` 指针同步进 unified。
3. **lock/relock**：`POST /v1/mobile/lock` 使用同一 `publicationTransaction`；若 unified 不存在则保持旧行为；
   若 `runState !== active` 或 `sourceStatus === ended`，在任何锁写入前返回 `409 training_paused`。
4. **自动刷新**：`TrainingPlanCoordinator.tick` 只决定“是否需要刷新”；它调用统一 `service.refresh`
   的同一入口，不直接写表，不另开生成队列。
5. **迁移**：只由离线 `scripts/migrate-training-planner.mts` 写；GET/启动/App 恢复不自动迁移。

## 3. 不变量与验收映射

| 不变量 | 代码/测试 |
|---|---|
| 同一当前配置/意图/锁只有一个权威，goals 仅为投影 | `OWN-01`：`phase5-training-plan.test.ts` 读取 `mobile_training_state` 与 `mobile_goals` 逐字段比对 |
| 暂停/结束后不新增执行授权，历史回执不变 | `OWN-02`：`phase5-training-plan.test.ts` 的 unmanaged lock → pause → today/v1/v2/workout-plan → resume；暂停故障回滚；managed pause 与 end；历史/设备账目保留 |
| 损坏 receipt/owner 指针 fail-closed | `OWN-03`：`phase5-training-plan.test.ts` 删除 receipt 后 v2 GET 409 |
| 计划/配置 CAS 与回滚 | `OWN-04`：`training-plan-commands.test.ts` 五个写点触发器故障注入、revision 冲突 |
| 历史只追加 | `OWN-05`：迁移/命令/发布测试检查历史表计数与内容不变（`training-plan-commands.test.ts`、`training-plan-migration.test.ts`） |
| 执行授权不来自 v2 | `OWN-06`：`training-plan-v2-route.test.ts` 断言 `execution.permitted === false` |
| 客户端不跨域重放 | `OWN-07`：`TrainingPlanPublisherRegression.swift` 的 token/identity/scope 用例；`ModelRegression.swift` 旧 pending 用例 |
| managed 自动刷新经过真实服务定时入口 | `OWN-08`：`phase5-training-plan.test.ts` 等待真实 60 秒 startup tick；空窗口发布一次，paused/损坏 owner 零写入 |

**结论口径：** 代码所有权已在隔离测试中收口；生产环境仍依赖既有执行合同和设备撤回流程，
不把 unified 读当作 WorkoutKit 授权。生产部署/能力启用不属于本矩阵的完成声明。
