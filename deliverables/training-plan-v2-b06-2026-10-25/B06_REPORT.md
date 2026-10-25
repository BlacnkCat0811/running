# B06：执行关联、执行状态与纠错 / S03-01–04

日期：2026-10-25（Asia/Shanghai）。状态：**已实现，定向与真实 HTTP 回归通过；B07 原生链与 Simulator 点击链通过后 G3 已签收**。本记录不签收 G4–G7。

## 身份与隔离

- HEAD：`1b6a10b4769526b2930090e79860d2f93cc50318`，branch `main`，dirty。工作区保留 B01–B08 未提交实现，没有 reset/clean、提交、推送、生产迁移或部署。
- 所有测试使用系统临时目录下的独立主库/控制库、随机端口和测试 token；未读取/修改用户日常健康库。
- 执行关联写只在 `RAI_TRAINING_PLAN_EXECUTION_COMMAND_MODE=validation`、schema 2 / owner-ready、publication 和精确请求头同时满足时准入；默认生产关闭，和配置/课程写开关独立。

## 任务 → 文件 → 断言

| 任务 | 文件 | 实际断言 |
| --- | --- | --- |
| S03-01 | [execution repository](../../apps/api/src/training-plan-execution-repository.ts)、[session state parser](../../apps/api/src/training-plan-session-state.ts)、[MobileGoalsStore](../../apps/api/src/mobile-goals.ts) | 控制库 DDL 4：`mobile_training_execution` 当前行 + `mobile_training_execution_history` 不可变修订；`(scope, training_session_id)` confirmed 部分唯一；`(scope, session_id)` 主键；执行修订从 1 单调 +1；非事务写入/回滚/缺 id/缺摘要均拒绝 |
| S03-02 | [matcher](../../apps/api/src/training-plan-execution-match.ts)、[data facts](../../apps/api/src/data.ts) | 默认课程日 ±2 天、最多 31 天；按 startedAt 的上海自然日筛选，跨午夜不按 endedAt 重归；分页 50 + 稳定 cursor；同日多跑/一跑多候选保留 `needs_confirmation`，只有已 confirmed 且摘要相同才 `verified_identity`；不按日期/距离/排期回执自动确认 |
| S03-03 | [execution commands](../../apps/api/src/training-plan-execution-commands.ts)、[assessment](../../apps/api/src/coach-execution-assessment.ts) | 关联、观测、剂量、刺激分开返回；completed = 可靠关联的已结束实际训练；只有明确 dose partial/not_met 才 partial；summary-only 的剂量/刺激保持 not_assessable；不把计划段落当实测证据 |
| S03-04 | execution commands、repository、server 路由 | confirm/correct/retract/skip；confirm 只认领未关联/待确认课，correct 原子替换并释放本课旧占位，retract 用保存摘要（源删除后仍可撤回），skip 仅 pending 且未确认；源摘要变化拒绝 confirm/correct；后台 reconcile 把删除/更正/合并的源关联转 invalidated 并追加修订，旧完成历史保留 |
| 读扩展 | [training-plan-routes.ts](../../apps/api/src/training-plan-routes.ts)、server | 统一读 `sessions.executions` 可选数组；缺位=未知，空数组=已知无关联；执行写关闭仍可读；`trainingPlanExecutionCommandContractVersion` 只在独立 validation + 精确头下宣告 |
| HTTP / 恢复 | [phase5 tests](../../apps/api/test/phase5-training-plan.test.ts)、[commands tests](../../apps/api/test/training-plan-execution-commands.test.ts) | 真实路由 GET 候选/POST confirm/retract；同键重放原结果；关写后重放；404 非业务 notFound；统一读执行快照与 operation 同事务 |


## 源码身份（最终）

| 文件 | SHA256 |
| --- | --- |
| `apps/api/src/training-plan-execution-repository.ts` | `5c30d82dcf3af2462bec32cfb9509dfd9ba89261db7d5d762dd9f9afb2b8093a` |
| `apps/api/src/training-plan-execution-commands.ts` | `f17484cf2e52d781a2a06d67c1c370b3a452cbce6e483522d326ccb8fffdaf2f` |
| `apps/api/src/training-plan-execution-match.ts` | `b3b4d092899a3ab585562987af43b3e6ae1b2496ef6778b493cc9f246269b480` |
| `apps/api/src/training-plan-input-identity.ts` | `5980962d2b2acddb8f343f9c328dc0385bdc56001e232ec5daa1d1dbfaf12bb8` |
| `apps/api/src/training-plan-evaluation-repository.ts` | `37db0a44b0820d686fba879b4364a516b70ed6420359fa24fd209c92ecda8fbf` |
| `apps/api/src/training-plan-commands.ts` | `00dfafb60795b1976e3c43af7cb04c6b113ec67942858b77a48d2221217e2d1a` |
| `apps/api/src/server.ts` | `f833ef86a8634e52ade4994d66a9cf913d342fea1aec955a4b2e48f0af660c89` |

## 关键语义

- 处方身份：执行评价使用 **开跑前已发布、已可得且生效** 的课程修订（`trainingPlanSessionAt(startedAt)`），不用事后编辑的当前课冒充当时处方。
- 生命周期：confirm/correct 后 `completed`，明确剂量不足为 `partial`；skip 为用户明确 skipped；retract 把 completed/partial 恢复为 pending。执行修订独立递增，不伪造 `sessionRevision`。
- 关联唯一：一个实际训练最多确认一堂课；并发第二笔由部分唯一索引/事务拒绝为 `training_execution_link_conflict`；纠错必须显式 correct。
- 设备边界：API 不调用 WorkoutKit、不自动更新设备排期；保存关联只返回 `planUpdate: pending` 和排期警告。

## 已执行结果

| 命令 / 范围 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS（最终日志随收口） |
| `training-plan-execution-repository.test.ts` | 3/3 PASS（事务/修订/唯一约束/回滚） |
| `training-plan-execution-match.test.ts` | 6/6 PASS（窗口/跨午夜/分页/生命周期/事实摘要/提前延后同日多跑） |
| `training-plan-execution-commands.test.ts` | 8/8 PASS（confirm/correct/retract/skip、CAS、源变化、reconcile、重放） |
| `phase5-training-plan.test.ts` B06 真实 HTTP | PASS（候选→确认→统一读→重放→撤回） |
| `training-plan-*.test.ts` + `phase5` 定向全量（并发 2） | B06 相关 17 项单元 + 1 项真实 HTTP PASS |
| `RAI_TEST_CONCURRENCY=2 npm test`（最终源码身份，含 B09 crash test） | PASS：2729 项 / 2726 通过 / 3 项 Windows 专属跳过 / 0 失败 |

## 边界与剩余门

- B06 完成 S03-01–04；S03-05 原生关联/回顾由 B07 验证，G3 已签收。
- 未执行：Linux 真机、2C2G、iPhone 物理设备、配对 Watch、生产发布；这些不由本机定向测试代签。
- 回滚：关闭 `RAI_TRAINING_PLAN_EXECUTION_COMMAND_MODE` 保留 schema 4 读取、已提交操作查询、用户覆盖和既有设备撤回；不能回滚到不认识 schema 4 的旧二进制。
