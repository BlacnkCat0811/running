# B08：事实反馈后的自适应发布 / S04-01–05

日期：2026-10-25（Asia/Shanghai）。状态：**已实现，定向、真实 HTTP 与 72s 自动收敛回归通过；G3 签收后 G4 已签收（研发门）**。本记录不签收 G5–G7。

## 身份与隔离

- HEAD：`1b6a10b4769526b2930090e79860d2f93cc50318`，branch `main`，dirty；保留 B01–B08 未提交实现。
- 测试只使用临时主库/控制库、loopback 和测试 token；自动发布只在 `RAI_TRAINING_PLAN_AUTO_PUBLISH_MODE=validation` 的隔离 runtime 打开，默认生产关闭。
- GET/更新读不写库；所有评估游标与内容修订只在既有 publication transaction 内提交。

## 任务 → 文件 → 断言

| 任务 | 文件 | 实际断言 |
| --- | --- | --- |
| S04-01 | [input identity](../../apps/api/src/training-plan-input-identity.ts)、[data input facts](../../apps/api/src/data.ts) | 输入键 = scope/业务日/最近 28 天至未来 7 天跑步事实/已发布分析身份/配置/用户保护与抑制/执行关联/policy；排除墙钟、输出 stateRevision/goalsRevision、自动 pending 课程内容；事实更正、新 run、新 release、配置/覆盖/执行变化会改变键；record-only 不变 |
| S04-02 | [coordinator](../../apps/api/src/training-plan-coordinator.ts)、[server](../../apps/api/src/server.ts)、[recompute worker](../../apps/api/src/recompute-worker.ts) | 启动/60 秒持久输入差异巡检；分析完成回调只加速；单飞；分析未发布时 `analysis_pending` 不生成；瞬态失败有界指数退避（5s→15min）并保持可观察 |
| S04-03 | [commands](../../apps/api/src/training-plan-commands.ts)、[evaluation repository](../../apps/api/src/training-plan-evaluation-repository.ts) | 内容/授权/保护/关联/goals 投影相同 ⇒ `outcome:"no_change"`：不增加 state/goals revision、不追计划/课程历史，只推进 `mobile_training_plan_evaluation`；内容/授权变化同事务写 `publishedInputKey` 与游标；operation result 与游标同 COMMIT，失败全回滚 |
| S04-04 | 现有 resolver/repair 输入闭包 | 自动发布会走同一 `materializePlan`/保护 resolver；用户保护、完成课、抑制与设备风险不因自动刷新丢失（由既有 B03 回归与 B08 输入键覆盖） |
| S04-05 | server 读状态、update view、phase5 真实 HTTP | 四阶段 facts/analysis/association/plan 各自带证据；GET 零写；`X-RAI-Training-Sessions:1 + X-RAI-Training-Updates:1` 才返回；未知/缺课程头 409；自动发布关闭时 plan 为 blocked + `auto_publish_disabled`；分析未跟上时 `analysis_pending` |


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

- `publishedInputKey` = 当前内容由哪份输入产生；评估游标 = 最新哪份输入已检查过且无需/已经改变内容。二者不是第二份计划 owner。
- no-change 不伪造内容修订：状态/目标/计划/课程历史均不增长，只推进游标和 operation result；重启后同一输入不再重复搜索。
- 自动发布与手动 refresh 分离：手动 refresh 始终可用；自动触发默认关闭，只有 validation 门和 60 秒巡检/分析回调才运行。
- 分析未发布/失败时保留旧计划并标注阶段，不用未就绪事实生成新计划。

## 已执行结果

| 命令 / 范围 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS（最终日志随收口） |
| `training-plan-input-identity.test.ts` | 4/4 PASS |
| `training-plan-evaluation.test.ts` | 1/1 PASS（单行游标/事务/回滚） |
| `training-plan-coordinator.test.ts` | 7/7 PASS（含 input_changed、cursor、analysis_pending、退避、操作键） |
| `training-plan-commands.test.ts` B08 no-change | PASS（changed→no_change→changed，revision/历史不膨胀，游标推进） |
| `phase5-training-plan.test.ts` B08 真实 HTTP | PASS（四阶段、GET 零写、no-change、新事实输入变化） |
| 启动/60 秒定时器真实服务用例 | PASS（managed 空窗口自动 refresh；paused/corrupt 不发布） |
| B08 真实服务“关联后自动收敛”用例 | PASS：确认一条合成 run 后等待 72 s，未手动刷新，更新读的 evaluatedInputKey 追平 desiredInputKey、plan.status=current、执行关联保持 confirmed（`phase5-training-plan.test.ts` B08 timer 用例） |
| `training-plan-*.test.ts` + `phase5` 定向全量（并发 2） | B08 输入身份 4/4、评估游标 1/1、协调器 7/7、命令 no-change、真实 HTTP 与自动收敛均 PASS |
| `RAI_TEST_CONCURRENCY=2 npm test`（最终源码身份） | PASS：2729 项 / 2726 通过 / 3 项 Windows 专属跳过 / 0 失败 |

## 边界与剩余门

- B08 后端完成 S04-01–05；iOS 四阶段文案已接入并随最终 iOS 聚合通过；G4 已签收。Linux/真机/2C2G 属 G5/G6，不在 G4 内。
- 未执行：Linux 真实锁/信号/重启、2C2G 资源、iPhone 真机、配对 Watch、生产启用。
- 回滚：关闭自动发布门保留手动 refresh、已发布计划、评估游标与 schema 5 读取；不能回退到不认识 schema 5 的旧二进制。
