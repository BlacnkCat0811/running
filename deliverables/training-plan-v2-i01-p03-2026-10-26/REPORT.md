# I-01 / P-03 Skip 执行闭环修复记录

交付整理版：测试结果保持原样；原始报告见 [REPORT.source.txt](REPORT.source.txt)，来源哈希及未入库材料见 [精选清单](../training-plan-v2-final-2026-10-26/EVIDENCE_ALLOWLIST.json)。绝对路径只记录历史执行环境，不作为当前运行入口。


日期：2026-10-26（Asia/Shanghai）。IMPLEMENT，仅 I-01/P-03。未提交、推送或部署。

## 任务结果

I-01 修正 `hasCandidates` 为 `!page.candidates.isEmpty`。页面和动作共用模型中的 Skip 判定入口，继续复用既有纯策略；未加载、加载中、加载失败、失效响应、scope/实例/课程/执行/状态修订不符均不能放行。Skip 提交即清掉候选页，409 后不能继续用旧空页重试。

P-03 在现有 publication transaction 内重新检查 pending、实例、state/session/execution CAS 和 confirmed 关联，读取默认上海课程日 ±2 天的**全部真实候选**。存在候选返回 `409 training_execution_candidates_present`；读取或提交期间主库指纹变化返回 `409 training_execution_source_changed`。没有新增请求字段、迁移、数据库或写者。

## 修复前失败证据

- [服务端红测](red-api.log)：9 项中 4 失败，分别为新跑步事实到达、候选读取中版本变化、操作回执插入时版本变化未拒绝，以及 Skip 未取得事实租约。前三项为 `Missing expected exception`；它们直接读取隔离主库并断言控制库状态/历史/回执，不是客户端页面 Mock。
- [iOS 原模型红测](red-ios-final.log)：保存的原始 `NativeAppModel.swift` 在非空候选页发送 Skip，触发 `a nonempty candidate page must issue zero Skip requests` 断言，退出 132。
- iOS 红测使用 原始模型（原始外部归档，见精选清单）、固定回归输入（原始外部归档，见精选清单） 和 复现命令（原始外部归档，见精选清单），不回退或覆盖工作区。该聚焦入口从永久 `ModelRegression.swift` 的同一候选/Skip 回归抽取；完整入口仍运行永久用例。
- 中间测试夹具/编译输入变动和过时运行未计为通过；最终成功批次与预期红测分别列示。

## 事务、并发与幂等

主库保存跑步事实，控制库保存计划、历史和 operation result，两者不能用单个控制库事务实现原子提交。

1. HTTP Skip 与 Confirm/Correct 一样取得既有 `MutationCoordinator` 租约，持有至整个 publication（含控制库 COMMIT）结束。后台写者经 `TaskAdmissionScheduler` 使用同一协调器；现有 API/CLI 发布锁限制跨进程生产写者。Retract 仍使用保存身份，维持 metadata-only 行为。
2. 控制库 `BEGIN IMMEDIATE` 后检查实例、三类修订、课程和已确认关联，读取主库真实候选；候选前后检查现有 `inode:data_version` 指纹。
3. 注册同步提交前检查，在状态、冻结历史、operation result 写入和 owner reconciliation **之后、COMMIT 之前**再次核对主库指纹。冲突抛错使整笔控制库业务事务回滚；既有 publication guard 按原机制收口。租约阻止受支持事实写者进入最终校验至 COMMIT 的间隙。
4. 测试用真实 SQLite trigger，在 operation result 已插入后向独立主库写入跑步；断言真实事实仍存在，而控制库状态、课程/执行历史和 operation result 全部保持原样。另覆盖状态写、回执写、延迟外键 COMMIT 失败。
5. 原 operationId replay 先于能力、租约和事实检查；新事实到达甚至事实读取器不可用时仍返回不可变原结果。新键重复 Skip 维持 `training_session_not_editable`。并发 Skip/Confirm 后真实关联保留，Skip 失败；已完成/已确认课程及其历史不可被旧 Skip 覆盖。

这些保证依赖现行受支持写者遵守既有协调和独占发布边界；没有宣称一个控制库事务可以覆盖任意外部直接改库。

## 修改文件

| 文件 | 修改目的 |
|---|---|
| [NativeAppModel.swift](../../apps/ios/RAI/NativeAppModel.swift) | 参数方向、候选读取状态和修订校验、Skip 后旧页失效 |
| [TechTrainingExecutionReview.swift](../../apps/ios/RAI/Skins/Technology/TechTrainingExecutionReview.swift) | 按钮复用模型唯一 Skip 入口，避免另写一套状态判断 |
| [TrainingPlanExecutionPolicy.swift](../../apps/ios/RAI/TrainingPlanExecutionPolicy.swift) | 新稳定冲突码的用户提示 |
| [training-plan-execution-commands.ts](../../apps/api/src/training-plan-execution-commands.ts) | 真实候选、指纹、提交检查及事实租约 |
| [mobile-goals.ts](../../apps/api/src/mobile-goals.ts) | 同步提交前校验钩子及事务结束清理；不改变 A-01 reconciliation 逻辑 |
| [training-plan-closed-loop.ts](../../packages/api-contracts/src/training-plan-closed-loop.ts) | 新错误码 409 单源登记；距离合同未改 |
| [training-plan-execution-commands.test.ts](../../apps/api/test/training-plan-execution-commands.test.ts) | 两个独立 SQLite 文件下的新事实、版本、幂等、并发及失败回滚；旧合法 Skip 夹具改为真实空窗口 |
| [ModelRegression.swift](../../apps/ios/tests/ModelRegression.swift) | 生产模型/传输请求次数、成功重读及错误展示 |
| [闭环合同](../../docs/TRAINING_PLAN_V2_CLOSED_LOOP_CONTRACT.md) | Skip 的候选、跨库提交与错误合同 |

`training-plan-execution-match.ts` 复用现有窗口和 `factsInRange`，本阶段无修改。除上表及本证据目录外，未新增修改；[本阶段 Diff](stage.diff) 相对任务开始时的脏工作区生成。

## 验证结果

| 检查项目 | 结果 | 实际范围/入口 |
|---|---|---|
| 类型检查 | PASS | `npm run typecheck`，两份 tsconfig；[日志](typecheck.log) |
| L1 定向 | PASS | 执行命令文件 23/23；[API 日志](l1-api.log)；iOS 聚焦 15/15，[日志](l1-ios-final.log) |
| L2 影响 | PASS | 11 文件、91/91；命令/候选/存储/故障/合同/路由/租约/读一致性，[日志](l2-api.log) |
| L3 模块 | PASS | 68 文件、663/663；训练计划、教练、排期、发布、崩溃恢复、真实路由/启动/DTO；[主批](l3-api.log)、[关联批](l3-related.log) |
| L4 全仓 | NOT RUN | 按本阶段要求未执行 `npm test` / `npm run test:all` |
| iOS 验证 | PASS（有明确排除） | `npm run test:ios`，103 文件类型检查 + 纯逻辑聚合；[最终日志](test-ios-final.log) |
| iOS 源码门禁 | PASS（明确排除） | `npm run check:ios-gates`，11 支，2 支手工判据排除；[日志](ios-gates.log) |
| API 合同 | PASS | 错误码文档、候选/命令、OpenAPI 与真实 HTTP，含于 L2/L3 |
| 验收矩阵 | PASS | 80 条引用齐全；引用不等于覆盖强度，[日志](acceptance-matrix.log) |
| 文档 | PASS（引用边界检查有告警） | `check:docs`、`check:doc-refs`；后者有既有空行锚告警，内容漂移无基线 |
| 单一写者门禁 | PASS | `npm run check:training-plan-single-writer`，0 违规；[日志](single-writer.log) |
| 最终 Diff / LF | PASS | `git diff --check`；4 个 Swift 修改文件 i/lf w/lf |
| GitHub CI | NOT CHECKED | 未查询、未运行远程 CI |

明确文件列表及完整 Node 参数见 [manifest](verification-manifest.json)。没有修改测试发现/执行器、AGENTS.md、CI 或生产环境。

## 测试统计

- 最终成功 Node 批次共 **777 次执行**（23 + 91 + 289 + 374），通过 777、失败 0、跳过 0、取消 0。各批次有重复覆盖，不能称为 777 个独立测试。
- Node 命令耗时累计 **1132.567 秒**；批次曾并行，这不是任务墙钟耗时或性能优化结果。原始数字见 [统计](node-results.json)。
- 各 Node 批次 `--test-concurrency=2`；L3 两批曾同时运行，最多 4 个文件进程。iOS 使用现有脚本默认配置。
- iOS 聚焦检查 15 项通过；完整聚合没有统一案例计数，最终退出码 0，确认 103 个源码文件类型检查及完整纯逻辑聚合通过，不虚构聚合案例总数。iOS 命令未单独计时，不虚构总用例数或耗时。
- 预期红测单列：API 9 项中 4 失败；原 iOS 模型断言失败。过时/中断的 iOS 运行不计为通过。

## 风险与剩余事项

A-01 的历史状态保护未改；D-01/D-02 的 9 个未触及文件与前阶段 SHA256 一致，见 [保护记录](prior-phase-preservation.json)。两个直接依赖文件仅追加稳定错误登记和 Skip 合同。HEAD 仍为 `2e7c07bb66b3701c4e1b768c90f431b654584f5c`，没有暂存、提交、推送、清理或部署。

本阶段未验证真实设备 HealthKit 新事实同步、后台同步与 Skip 同时操作、弱网/断网下结果恢复、真机按钮与提示展示；未做完整 App 构建、Simulator 点击验收、AMap SDK 验证或生产数据库操作。完整 iOS 源码类型检查按既有入口排除 3 个高德 SDK 专属文件；逐条后台突变和 live export 两支手工判据未运行。

I-01/P-03 已修复并通过本阶段要求的本地验证。发布仍需 L4/Full CI、完整 App/设备验收及其他既有阻断项收口；D-03 本轮未处理，不进入 D-03 或 CI 优化。局部测试通过不代表发布验收完成。
