# B04：课程编辑 API / S02-01–02

日期：2026-10-25（Asia/Shanghai）。状态：**S02-01–02 已验收；G2 等待 B05 最终 UI 验证**。本记录不签收 G2–G7。

## 身份与隔离

- HEAD：`1b6a10b4769526b2930090e79860d2f93cc50318`，branch `main`，dirty。开始时已有 B01–B03 的未提交实现；保留并复用，没有 reset/clean、提交、推送、生产迁移或部署。
- 实际源码逐文件 SHA-256、Node 与平台见 [source-snapshot.json](source-snapshot.json)，不能只用 HEAD 重现本次代码。
- 主库、控制库、runtime、epoch、端口均由测试在系统临时目录生成；真实 API 使用合成 fixture、loopback、随机端口及测试 token。未读取/修改用户日常健康库。
- 课程命令仅 `RAI_TRAINING_PLAN_SESSION_COMMAND_MODE=validation` 可启用，复用真实路径隔离校验：临时 runtime、两库在其下、loopback；默认生产关闭，与配置命令开关独立。

## 任务 → 文件 → 断言

| 任务 | 文件 | 实际断言 |
| --- | --- | --- |
| S02-01 | [session commands](../../apps/api/src/training-plan-session-commands.ts)、[safety](../../apps/api/src/training-plan-session-safety.ts)、[schemas](../../apps/api/src/schemas.ts) | move/edit/add/cancel/set_rest/unlock；严格字段、null/遗漏、整米整秒、距离/结构一致；已完成/取消/替换/过去课程拒绝 |
| S02-02 | session commands、[MobileGoalsStore](../../apps/api/src/mobile-goals.ts)、[server](../../apps/api/src/server.ts) | 零写预览；同 ID 改期、源日抑制、占位；候选绑定 scope/实例/修订/草稿/事实/政策/排期和 120 秒 TTL；add ID 在预览绑定 |
| 原子与恢复 | [command tests](../../apps/api/test/training-plan-session-commands.test.ts)、[two-process helper](../../apps/api/test/helpers/training-session-writer.ts) | 六个业务 SQL 写点与业务 COMMIT 故障全部回滚；双 SQLite 连接及双 OS 进程竞争仅一笔成功；操作重放先于 TTL/能力/事实读取和写许可 |
| 真实 HTTP / 安全 | [phase5 tests](../../apps/api/test/phase5-training-plan.test.ts)、[safety tests](../../apps/api/test/training-plan-session-safety.test.ts) | 六动作路由、结构/距离/类型、关写后重启重放；真实分区上下限、自然周实际量与其他保护课、赛前限制；不静默缩放用户结构 |

HMAC 候选是只读计算结果，不新增预览表。服务重启使尚未提交的预览失效；已提交操作先从 SQLite 重放，不依赖签名密钥或候选存活。新请求不能更换草稿后复用旧候选。

发布仍复用 `PlanPublicationService` 和控制库 transaction/CAS：goals、unified、两种历史和 operation result 同事务。现有 `weekPlanReplanRequired` 围栏保留；只有 schema 2 + 发布事务 + preserveWeekPlan 的内部课程编辑可调整意图，不能冒充规则教练重新确认，更不授设备执行权。

取消/明确休息是 metadata-only，事实更新中仍可撤销意图；加量/改期/解除保护使用既有 main-DB lease 与事实就绪门。主库/控制库继续 detect + retry，没有跨文件原子承诺。有效设备回执按 scope 参与候选身份，变化后旧候选拒绝；不自动调用 WorkoutKit。

## 已执行结果

| 命令 / 范围 | 结果与日志 |
| --- | --- |
| `npm run typecheck` | PASS；[最终类型检查](logs/rai-session-typecheck-final.log) |
| 定向 API / safety / schema / phase5，`--test-concurrency=2` | 38/38 PASS；[集成日志](logs/rai-session-integration-verified.log)。其后补充的设备证据、双进程用例分别见下；最终完整回归需覆盖最终清单 |
| 双进程 CAS 定向 | PASS，1 changed + 1 training_state_revision_conflict；[日志](logs/rai-session-process-cas.log) |
| scope 设备排期/候选失效 | PASS；[日志](logs/rai-session-device.log) |
| native Picker / OpenAPI schema 门 | 16/16 PASS；[日志](logs/rai-session-schemas-verified.log) |
| `npm run smoke:api` | PASS；[日志](logs/rai-session-smoke.log) |
| 完整后端回归 `RAI_TEST_CONCURRENCY=2 npm test` | PASS，2676 项 / 2673 通过 / 3 跳过 / 0 失败，耗时 2475 秒；[全量日志](logs/rai-session-backend-frozen.log)。三项跳过均为 Windows 平台专用语义，不冒充已验证。更早的 [全量失败过程](logs/rai-session-backend.log) 只有源码变化身份判据失败，予以保留 |
| 源码冻结验收重放 | 4/4 PASS；[冻结后重跑](logs/rai-session-replay-frozen.log)。先前全量执行期间新增测试文件，源码变化判据失败；该中间结果不当作全量通过 |
| single-writer / scripts / package-boundaries / acceptance-matrix | 已运行通过，最终门禁/完整日志随收口补齐 |

保留 [中间定向日志](logs/rai-session-targeted-verified.log)：其中 Picker 抓到 UI 提供了 API 不接受的 race 选项，已移除，最终 schema 检查通过。该日志为失败过程，不能当最终成功证据。

## 边界与剩余门

- B04 不新增执行关联、不启用事实驱动自动发布、不修改 HealthKit 同步或健康记录。
- G2 还依赖 B05 原生 journal/界面与最终实际 Simulator 复测；本批后端全量已通过；B06–B11 尚未在本记录签收。
- Linux、2C2G、iPhone 真机、配对 Watch、远端 CI、新旧构建交错与生产发布均未由本机后端验证替代。
- 关写回退保留 schema 2 读取、用户覆盖、操作查询和既有设备撤回；不能回滚到不认识 schema 2 的旧二进制。
