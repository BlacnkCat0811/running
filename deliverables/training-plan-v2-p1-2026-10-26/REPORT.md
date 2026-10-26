# 训练计划 V2 P1 集中收敛记录 — 2026-10-26

交付整理版：测试结果保持原样；原始报告见 [REPORT.source.txt](REPORT.source.txt)，来源哈希及未入库材料见 [精选清单](../training-plan-v2-final-2026-10-26/EVIDENCE_ALLOWLIST.json)。绝对路径只记录历史执行环境，不作为当前运行入口。


模式：IMPLEMENT；本轮只处理 DOC-01、A-01-01、EXEC-01/02/03、EDIT-01、COMPAT-01。
本报告记录实际完成的验证，不授权生产写入、部署或迁移。

## 任务结果

已完成全部指定阻断项及 EXEC-03 内补充确认的 no-change 回执遮蔽缺陷。最终 L3 为 49 文件、495/495，iOS 类型检查/纯逻辑聚合及要求的全部文档/结构门禁均通过。
本轮未发现仍阻止进入最终 L4 的已确认 P0/P1；整体合并与生产启用条件尚未满足，仍需 L4、CI、生产副本核查和设备验收。
没有自动提交、推送、部署、修改 GitHub CI、启用生产能力或连接生产数据库。

## 工作区与回滚证据

起始分支 main，HEAD `2e7c07bb66b3701c4e1b768c90f431b654584f5c`，暂存区为空。
[原文件哈希清单](workspace-baseline.json)覆盖 183 个原有修改和未跟踪文件，含此前四轮及 B08 产品代码/交付证据。
[工作区保护检查](workspace-preservation.json)确认原有文件无缺失，162 个文件哈希不变，21 个原文件仅叠加授权修改，另改 3 个原本干净的 tracked 文件。
独立回退内容见 [P1.patch](P1.patch)，不混入此前未提交修改；[最终反向检查](rollback-check-final.json)仅执行 `git apply --reverse --check`，exit 0，未实际回滚。
原始快照保存在本机外部临时归档，不写入仓库；本目录是经 allowlist 精选的副本。回退必须先核对后续改动并复验补丁，不得直接恢复整个 HEAD 或覆盖共享工作区。

## 阻断项修复前后

| 项目 | 修复前证据 | 修复后行为及证据 |
|---|---|---|
| DOC-01 | [红测](doc01-red.log)：孤儿 D-03 REPORT，exit 1 | 现行合同恢复 D-03 索引；[绿测](doc01-green.log) exit 0，未改孤儿规则 |
| A-01-01 | [红测](a01-red.log)：合法 rest lock 被审计拒绝，18 pass / 1 fail，exit 1 | [43 项影响回归](a01-green.log) exit 0；audit/inspect/apply 同类判定，保留锁及旧历史，仅跳过同日重复 explicit_rest；错误 digest/真实跑课冲突零写入 |
| EXEC-01 | [红测](exec01-red.log)：paused/ended 的 Confirm、Correct、Skip 六种组合均未拒绝，25 pass / 6 fail，exit 1 | [65 项回归](exec01-green.log) exit 0；服务层统一 409，旧提交精确重放保持，历史 Retract 可用且不恢复运行权限 |
| EXEC-02 | [红测](exec0203-red.log)：候选/评价身份不一致、记录时长误用墙钟时差、评价和回执后事实变化未拒绝 | [真实双库及协调回归](exec0203-l2.log)：73/73，exit 0；评价身份、摘要和最终提交检查一致 |
| EXEC-03 | [独立红测](exec03-red.log)：回执后事实恢复仍提交错误失效，0 pass / 1 fail，exit 1 | 73 项回归及后续 [66 项最终影响测试](exec03-final-l2.log)覆盖最终 COMMIT 检查、后台租约、CLI 进程交错及补充的回执遮蔽修复 |
| EDIT-01 | [Swift 红测](edit01-red.log)：抽取原编辑器资格谓词后，后台刷新交错断言失败，exit 132；不是 Simulator 操作证据 | [Swift 定向](swift-targeted.log)：79 checks，exit 0；固定原身份及处方，不读取新 currentSession 修订包装旧草稿；模型网络边界交错由 [模型定向](model-targeted.log)和 [iOS 聚合](ios.log)真实执行通过 |
| COMPAT-01 | [HTTP 红测](compat01-red.log)：服务器没有独立省略距离协商，0 pass / 1 fail，exit 1 | 新增可选精确能力位及同请求头；旧合法 payload 保留；Swift 缺位/未知版本拒绝新省略请求 |

补充发现并在实施前报告的 P1（仍属 EXEC-03）：预扫描发现失效、事务内事实恢复会保存 `changed:0` 回执，下一次同一事实失效被旧回执永久遮蔽。
[独立双红测](exec03-poison-red.log)为 0 pass / 2 fail，exit 1：一项直接显示新增的 changed:0 回执，另一项证明后来删除仍返回 0（预期 1）。
修复把指纹范围前移至预扫描，无变化尝试内部回滚且不保存业务回执；后台内部键升级 reconcile-v2，旧 v1 回执和用户 operationId 结果均保持不可变。
[最终影响测试](exec03-final-l2.log)66/66、0 skip，exit 0，另含旧 v1 回执兼容回归；因此重跑完整同一份 49 文件 L3，前一轮 493/493 不作为最后代码的最终 L3 证据。

非业务失败记录：EXEC-03 初次合成 Fixture 写入了 schema 不接受的 `deleted` 状态，改用现有合法 `inactive` 后重新取得独立行为红测；未改生产约束或旧断言。
COMPAT 与补充 EXEC-03 的首次筛选命令被 zsh 的未加引号 glob 拒绝，未执行测试；随后加引号运行取得真实红测，不把 shell 错误当作复现。

## 历史兼容与事务边界

- 合法 rest lock 与同日物化 rest 是一份意图。迁移保留 lockedSession、旧 state/goals 历史及迁移审计；不生成同日 explicit_rest。其他休息日照常物化。
- 跑课 lock + rest、任何 lock + 既有 explicit_rest 仍拒绝；不自动裁决或修补真实历史。失败比较全部表与 DDL，保持原样。
- active 允许符合其余合同的 Confirm/Correct/Skip；paused/ended 禁止新增这些命令。Correct 即使纠正旧关联也会创建新认领；Retract 仅撤回保存的 ID/摘要，允许在停止状态使用，保留历史且不改变 runState。
- operationId 的同键同摘要已提交重放先于新授权、事实、能力和租约检查，旧不可变回执不重算。
- 主库和控制库是两个独立 SQLite 文件，**不是单事务原子提交**。控制库 state、session/execution 历史和 operation 回执在已有单个控制事务内提交或回滚。
- 原有 MobileGoalsStore 的最终提交钩子在全部业务/回执写入及 owner reconciliation 后、真实 COMMIT 前复核 inode/data_version；事实变化为 `409 training_execution_source_changed`。原始事实外部变更保留，控制事务回滚。
- 同进程事实写者通过既有 MutationCoordinator/TaskAdmission 互斥；API 持有主库/控制库进程级 publication lock，受支持离线 CLI 使用相同发布锁。服务方法保持同步，不在已持租约内再申请租约；HTTP 和后台入口各获取一次并覆盖 COMMIT。
- Confirm/Correct 的候选与 workout assessment 必须共享训练 ID、起止、距离、记录时长及 sourceFactDigest；评价摘要直接引用同一候选事实身份。Correct no_change 新回执同样经过最终检查。
- Reconcile 事务内复核实例、状态修订和运行授权，并复核事实恢复；追加失效修订保留原处方和旧评价。预扫描也在同一指纹区间，无变化尝试回滚且不保存 changed:0。
- 后台内部 reconcile-v2 键避开旧 v1 无变化回执；已存在的旧回执逐字保留可查询/重放，用户执行命令的 operationId 合同不变。

## 跨进程与事实交错验证

[执行命令测试](../../apps/api/test/training-plan-execution-commands.test.ts)全部使用临时合成库；事实一致性测试使用真实、独立的 `facts.sqlite` / `control.sqlite`。

1. Confirm/Correct 在 workout 读取后由独立 SQLite 连接更改事实；稳定 409，控制业务、历史及回执逐表不变。
2. 真实 SQLite AFTER INSERT 回执触发器注入主库更新，包含 Correct no_change；最终钩子拒绝，回执及前序写入回滚。
3. Reconcile 扫描失效事实后，在回执插入时恢复事实；最终钩子拒绝错误 invalidation，旧历史保持。
4. HTTP Confirm 和后台 Reconcile 共用真实 MutationCoordinator/TaskAdmission；事实 worker 先持租约，释放后后台/HTTP 才继续；每入口一次申请，已提交重放不取租约。
5. 预扫描与事务之间恢复源事实会得到 409，控制库零写入；随后同一事实再失效仍能新增唯一失效修订，不被旧 no-change 回执遮蔽。旧 v1 no-change 回执保留且不会阻断新核对。
6. 独立 Node CLI 写者进程使用生产 publication-lock API：API 持锁时退出 9 且没有写入；释放后退出 0 并真实提交；重新取得 API 锁后 Reconcile 追加唯一失效修订。

前 1–3 项故障注入刻意绕过受支持写者的互斥来验证回滚兜底；第 4–5 项验证正常协调边界，不能将这些测试解读为任意绕锁外部写者也受保护。

## iOS stale editor

表单保存不可变 DraftIdentity（scope、planInstanceId、stateRevision、sessionId、sessionRevision）及原处方，读取新快照只用于判定是否过期。
过期后预览/保存均禁用并显示“旧草稿不能提交”；“重新读取并重建草稿”明确用最新课程重建表单，需要重新编辑、预览和确认。
新增课程也绑定原实例与状态修订。NativeAppModel 在网络入口和预览响应回到时再次检查绑定；不会用新状态修订装饰旧草稿。
Swift 定向覆盖修订、实例与新增课交错；生产模型回归覆盖后台 refresh 后零 preview/submit 请求、显式重建可达预览及旧服务器拒绝省略距离请求，见 [模型定向日志](model-targeted.log)与独立编译入口（一次性脚本留在原始外部归档），exit 0。
未执行 Simulator 点击或真机后台刷新验收，不能将纯逻辑回归当作设备证据。

## 新旧能力矩阵

新增键 `trainingPlanSessionDistanceOmissionContractVersion` 与请求头 `X-RAI-Client-Training-Session-Distance-Omission`，精确值均为 1；仍依赖课程命令 1 和其已有依赖。

| 客户端 / 服务器 | 协商结果 | 允许请求 |
|---|---|---|
| 旧 V2 客户端 / 新服务器 | 无新头，新键省略 | 既有合法显式距离、null、旧 patch 和原课程动作；无新要求强加到旧客户端 |
| 新客户端 / 旧 V2 服务器 | 旧服务器忽略新头，缺新键不算支持 | 显式合法整米、纯时间 null、原样历史显式距离、reason-only patch；新 mixed/需省略的内容变更提示升级 |
| 新客户端 / 新服务器，精确协商 | 新键 1 | add/edit 可省略距离，服务端唯一测量；仍需预览/CAS/安全和事实检查 |
| 新客户端 / 未知版本、缺依赖或写能力关闭 | 缺位/未知均关闭省略路径 | 不推导、不发未支持请求，不恢复旧写入 URL |
| 原 journal / 服务器降级或能力关闭 | 仍查询原 operation | committed 读取原回执；notFound 且原 payload 需省略时保留账目，不改写 payload 重试 |

未启用第二套计划系统，未恢复退役的 legacy API/LLM 排课。

## 修改文件

实际 24 文件见 [机器清单](task-files.json)及独立补丁；位置为本轮完成时的一基行号；详细函数/回归定位见 [代码位置](source-locations.json)。

| 文件/代码位置 | 本轮用途 |
|---|---|
| [data.ts](../../apps/api/src/data.ts#L1976) | workout 与候选共享同一事实字段、摘要与记录时长 |
| [server.ts](../../apps/api/src/server.ts#L1298) | 后台 Reconcile 使用入口租约；握手显式协商及 Vary |
| [training-plan-execution-commands.ts](../../apps/api/src/training-plan-execution-commands.ts#L136) | 统一执行授权、评价身份检查、提交前事实检查、后台状态复核及单次租约 |
| [training-plan-session-migration.ts](../../apps/api/src/training-plan-session-migration.ts#L191) | 保留合法 rest lock，跳过同日重复 suppression |
| [training-plan-session-state.ts](../../apps/api/src/training-plan-session-state.ts#L25) | 严格读取、审计和迁移共用合法 rest lock 分类 |
| [phase5-training-plan.test.ts](../../apps/api/test/phase5-training-plan.test.ts#L531) | 真实服务端精确能力协商、缺位/未知版本兼容 |
| [training-plan-execution-commands.test.ts](../../apps/api/test/training-plan-execution-commands.test.ts#L594) | 状态授权、真实双库回滚、HTTP/后台及独立进程交错 |
| [training-plan-history-compatibility.test.ts](../../apps/api/test/training-plan-history-compatibility.test.ts#L222) | 替换固定错误预期，合法 rest lock 审计/迁移/历史/重放及失败零写入 |
| [APIClient.swift](../../apps/ios/RAI/APIClient.swift#L238) | 握手发送独立省略距离协商头 |
| [APIModels.swift](../../apps/ios/RAI/APIModels.swift#L30) | 可选能力镜像、精确判定及原 journal payload 兼容判定 |
| [NativeAppModel.swift](../../apps/ios/RAI/NativeAppModel.swift#L1660) | 禁用停止状态的新执行动作，编辑器身份及能力网络入口防护，降级重放准入 |
| [TechTrainingExecutionReview.swift](../../apps/ios/RAI/Skins/Technology/TechTrainingExecutionReview.swift#L167) | Confirm/Correct 按运行授权禁用，历史 Retract 保留 |
| [TechTrainingSessionEditor.swift](../../apps/ios/RAI/Skins/Technology/TechTrainingSessionEditor.swift#L67) | 固定原修订与处方、明确重建入口、能力控制距离编码 |
| [TrainingPlanExecutionPolicy.swift](../../apps/ios/RAI/TrainingPlanExecutionPolicy.swift#L48) | 集中 active/ended 执行资格谓词 |
| [TrainingPlanSessionEditorPolicy.swift](../../apps/ios/RAI/TrainingPlanSessionEditorPolicy.swift#L9) | 不可变草稿身份及距离省略降级策略（原未跟踪文件继续保留） |
| [ModelRegression.swift](../../apps/ios/tests/ModelRegression.swift#L2818) | 生产模型 refresh/旧草稿网络零请求、显式重建、未确认能力和 paused 行为 |
| [TrainingPlanExecutionRegression.swift](../../apps/ios/tests/TrainingPlanExecutionRegression.swift#L287) | active、paused、ended 与历史撤回区别 |
| [TrainingPlanSessionEditorRegression.swift](../../apps/ios/tests/TrainingPlanSessionEditorRegression.swift#L29) | stale 草稿、实例/修订交错和能力兼容矩阵 |
| [run-model-tests.sh](../../apps/ios/tests/run-model-tests.sh#L40) | 模型编译单元添加现有 editor policy 依赖；原有测试发现/失败处理不变 |
| [OPERATIONS.md](../../docs/OPERATIONS.md#L215) | 修正合法 rest lock 的审计与迁移说明 |
| [CLOSED_LOOP_CONTRACT.md](../../docs/TRAINING_PLAN_V2_CLOSED_LOOP_CONTRACT.md#L72) | DOC-01 索引、统一授权/事实边界、stale editor 与能力兼容合同 |
| [handshake-registry.ts](../../packages/api-contracts/src/handshake-registry.ts#L107) | 独立能力语义、依赖与缺位行为登记 |
| [api-contracts/index.ts](../../packages/api-contracts/src/index.ts#L198) | 可选能力字段，保持旧 DTO 兼容 |
| [training-plan-closed-loop.ts](../../packages/api-contracts/src/training-plan-closed-loop.ts#L14) | 新能力常量与稳定 409 错误注册 |


## 验证结果

环境见 [environment.json](environment.json)：macOS 26.6.2 x64、Node v22.23.2、Apple Swift 6.3.2 / Xcode；Node 批次显式 `--test-concurrency=2`。
每条实际命令、真实退出码与墙钟耗时均保存于同名 `.json` / `.log`。

| 检查项目 | 结果 | 范围/命令 | 耗时与退出码 |
|---|---|---|---|
| 类型检查 | PASS | `npm run typecheck`，最终命令；[日志](typecheck-post-reconcile.log) | 45.978 s；exit 0 |
| L1 定向测试 | PASS | EXEC-03 最终 2 文件，52/52；A-01 5 文件 43/43；[日志](exec03-final-l1.log) | 14.009 s；exit 0 |
| L2 影响测试 | PASS | 执行/协调/合同 4 文件，66/66；[日志](exec03-final-l2.log) | 12.637 s；exit 0 |
| L2 能力/历史兼容 | PASS | 真实 HTTP/握手/课程 5 文件，93/93；[日志](compat01-green.log) | 430.541 s；exit 0 |
| L2 算法依赖 | PASS | 执行评价完整纯逻辑集合，10/10；[日志](assessment-l2.log) | 1.016 s；exit 0 |
| L3 模块回归 | PASS | [49 个明确存在文件](l3-files.json)，495/495，0 fail/skip/cancel；[日志](l3-final.log) | 442.351 s；exit 0 |
| Swift 编辑器定向 | PASS | 79 checks，包含 stale 与能力矩阵；[日志](swift-targeted.log) | 28.768 s；exit 0 |
| Swift 生产模型定向 | PASS | 完整第一编译单元及行为回归；无统一 checks 总数；[日志](model-targeted.log) | 404.750 s；exit 0 |
| iOS 聚合验证 | PASS | `npm run test:ios`，103 文件真实类型检查及纯逻辑回归；既有 3 个 AMap SDK 文件排除；[日志](ios.log) | 1449.919 s；exit 0 |
| iOS 跨平台门禁 | PASS | `npm run check:ios-gates`，11 支执行；2 支外部条件门禁排除；[日志](ios-gates.log) | 5.017 s；exit 0 |
| 文档链接 | PASS | `npm run check:docs`，含交付报告可达性；未绕过孤儿检查；[日志](docs-delivery.log) | 0.811 s；exit 0 |
| 文档行引用 | PASS（有告警） | `npm run check:doc-refs`，153 处、0 越界/无法解析；8 空行告警，缺漂移基线；[日志](refs-delivery.log) | 0.717 s；exit 0 |
| 验收矩阵 | PASS | `npm run check:acceptance-matrix`，80 cited / 0 missing；不代表设备验收；[日志](acceptance-final.log) | 3.139 s；exit 0 |
| single-writer | PASS | `npm run check:training-plan-single-writer`；结构判据不代替运行时测试；[日志](single-writer-final.log) | 1.277 s；exit 0 |
| npm scripts 可移植性 | PASS | `npm run check:scripts`，18 package / 117 scripts；[日志](scripts-portable.log) | 0.982 s；exit 0 |
| 独立补丁与 diff | PASS | `git apply --reverse --check` / `git diff --check`，仅检查未回滚；[日志](rollback-check-final.log) | 0.054 s；exit 0 |
| L4 全量测试 | NOT RUN | 未运行 `npm test` / `npm run test:all` | 按本轮限定 |
| GitHub CI | NOT CHECKED | 未查询或修改工作流/门禁 | 不宣称绿色 |
| 完整 App 构建 / Simulator / 真机 | NOT RUN | 未以源码或主机纯逻辑通过替代设备验收 | 后续独立执行 |

## 测试统计

- 最终 L3 独立有效集合：实际 495 项、通过 495、失败 0、跳过 0、取消 0；49 文件，442.351 秒。
- 全轮 Node 绿色验证累计 1439 次执行（各批次重叠，含补充修复前一轮 L3）：通过 1439、失败 0、跳过 0、取消 0；不是同等数量的独立用例。
- 红测另外累计 97 次执行：通过 74、预期复现失败 23、跳过 0；含已纠正的合成状态 Fixture 错误。不能把红测失败抹除或算成最终未修复失败；原始结果全部保留。
- Swift 编辑器定向 79 checks；执行策略聚合日志单列 80 checks；生产模型及整个 iOS 聚合无统一用例总数，不把 PASS 行数当用例总数，也不与 Node 相加。
- iOS 聚合耗时 1449.919 秒，exit 0；实际检查 103 个源码文件，3 个 SDK 依赖文件未检查；2 支外部条件源码门禁未执行，均未记录为通过。
- 上表有日志的验证命令耗时累计 2841.966 秒（同一并发任务可能重叠，不是任务总历时）；Node 均使用并发 2，未提高并发或超时取得通过。
- 未覆盖：L4 全仓、GitHub CI、完整 Xcode App 构建、Simulator 视觉/AMap SDK、真实 HealthKit/后台执行与 WorkoutKit、生产数据库副本分布。
- [机器统计](test-summary.json)保留每个 Node 批次的实际测试数、通过/失败/跳过/取消、命令和退出码。

## 风险与剩余事项

本轮增量具备提交审查条件，但依赖此前四轮与 B08，不能脱离原有未提交内容单独落地；整体尚不满足合并或生产启用条件。

- 本轮已具备进入最终 L4/CI/设备验收的前置条件，尚不满足合并或生产启用条件；L4、GitHub CI、完整 Xcode App 构建、Simulator 视觉及真机 HealthKit/WorkoutKit 验收均未执行。
- 生产库未读取或修复。后续仅在独立一致副本上审计全部 schema 1/2 scope/revision、goals owner、锁定证据、原执行评价/摘要、session 历史、迁移 digest 与原 operation 回执；另外核对历史 reconcile-v1 changed:0 的实际分布，不删改旧回执。
- 既有可能受旧错误影响的执行评价不自动重算或回写；需在副本核对时间/摘要后另行处理真实数据。
- 真机需覆盖编辑器停留时后台刷新/切换实例、暂停/结束后候选及按钮、历史 Retract、同步导入与 Confirm/Correct 交错、断网未知提交恢复、升级/降级握手、WorkoutKit 排期撤回与服务器状态区分。
- 文档行引用门禁仍有既有空行告警且缺内容漂移基线；不是完整语义核查。

## 安全拆分提交建议

此处仅建议，不实际暂存/提交。现有工作树包含前四轮与 B08 依赖，应先审查并按既有主题保存那些变更，不能仅提交本轮补丁造成依赖缺失。

1. DOC-01：恢复 D-03 索引。
2. A-01-01：共用冲突分类、迁移去重、修正历史测试及运维说明。
3. EXEC-01/02/03：统一授权、事实身份/最终钩子、后台租约、真实双库/跨进程回归和稳定错误合同；这些强关联变更建议作为一个可验证提交。
4. EDIT-01：不可变表单身份、模型网络防护、重建入口及 Swift 交错回归（需保留此前未跟踪 policy/测试文件）。
5. COMPAT-01：新可选能力位、registry/握手/Swift 镜像和 journal 准入、兼容矩阵测试；TS/Swift/文档应一并提交。

共享文件应按 hunk 审查并检查暂存 diff，不用整文件覆盖前轮改动。最终合并仍需独立 L4、CI 和设备验收。
