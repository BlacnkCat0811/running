# D-01/D-02 课程距离合同修复 — 2026-10-26

交付整理版：测试结果保持原样；原始报告见 [REPORT.source.txt](REPORT.source.txt)，来源哈希及未入库材料见 [精选清单](../training-plan-v2-final-2026-10-26/EVIDENCE_ALLOWLIST.json)。绝对路径只记录历史执行环境，不作为当前运行入口。


## 任务结果

D-01/D-02 修复完成，服务端 L1/L2/L3、完整 iOS 门禁复跑通过。本阶段目标达到，但不满足整体合并或生产验收条件。本阶段不进入 I-01/P-03。

分支 `main`，起始 HEAD `2e7c07bb66b3701c4e1b768c90f431b654584f5c`。未提交、推送、部署、迁移或访问生产 SQLite。
前置 [A-01 实施记录](../training-plan-v2-a01-2026-10-26/REPORT.md) 的真实生产副本审计与 L4 验收仍未完成；本阶段不替代这些验收。

## 最终距离合同

| 名称 | 含义与精度 |
|---|---|
| persisted distance | `MobilePlannedDay.distanceKm`。兼容存储/展示字段；历史自动课程可为 0.1 km。不能独立于结构指定另一套剂量 |
| measured distance | 唯一 TypeScript `measureStructure` 产生的派生值。距离段按米/1000；时间段按服务端配速转换；重复、热身、恢复和整理均计入 |
| measured duration | 同一测量函数产生：时间段直接累计秒，距离段按服务端配速折算秒。不是新增持久化事实 |
| display distance | 0.1 km 展示值，不能据此覆盖精确结构。纯距离编辑输入保留整米精度 |

服务端沿用 `pacesFromZones`：work 使用 kind 对应配速，其余用途使用 easy 配速，现有回退不变。iOS 不实现这些规则。
纯时间结构的 `distanceKm:null` 表示没有独立的距离处方；服务端仍测量估计距离和时长用于剂量/安全限制。null 不等于 0。

- 显式非 null 距离必须大于 0 且不超过 80 km，与完整结构的服务端测量结果按整米比较。
- 历史舍入例外只用于 edit：kind、完整结构（包括 alert）与 persisted distance 均未变，且该距离恰等于当前测量值的 0.1 km 舍入值。不能以相同的舍入桶代替完整结构相等。
- add 省略距离，或 edit 在 kind/structure 改变时省略距离，表示请求服务端测量。有距离段时返回整米距离，纯时间时返回 null。预览中清楚呈现有效处方。
- edit 的结构/类型未变且省略距离，保留原存储值；不会因为打开编辑器或修改说明就将历史距离改成整米值。
- 显式提交 null 且仍有距离段、显式 0、结构变化后仍显式带旧舍入值、确实不一致的剂量继续拒绝。
- 测量结果始终先经过 80 km / 4 小时限制，再走原有安全校验。没有静默缩放结构，没有放宽版本、事实或事务校验。

## D-01 / D-02 实现

D-01 在课程应用层增加上述受限的历史兼容分支。距离解析在 userOverride、课程修订和 weekPlan/impact 快照形成前完成，使所有投影引用同一个有效处方。
原样编辑保留结构和历史字段；改变结构后显式距离仍严格按整米校验。没有修补历史行、修改迁移或引入第二套剂量存储。

D-02 在原生策略中区分 time-only、distance-only 与 mixed。mixed 不再返回仅 distance steps 的小计；编辑器省略距离交给服务端，并在预览展示有效结果。
混合课程不再提供误导性的总距离输入，切换到 mixed 时清除旧表单距离输入，避免隐藏的无效输入阻断预览；这不修改持久状态。
纯时间原样编辑保留历史值，新建/改变后的纯时间草稿可使用 null。草稿无效时直接展示 `draftIssue`，不再只显示不可点击的按钮。

## API 与历史客户端兼容

读响应 DTO 和持久化 schema 不变，没有新增 measuredDistanceKm / measuredDurationSeconds 字段。
仅扩展命令请求的距离省略语义；add 的 `distanceKm` 由必填改为可省略，OpenAPI 同步。旧客户端合法的显式距离/纯时间 null 仍接受。
旧客户端原样提交历史 0.1 km 课程可通过；结构变化后显式发送旧舍入值继续被拒绝，需要精确值或省略距离重新预览。

Swift add 编码默认仍发送原有 distance 字段，只有 `deriveDistance` 的本地编码选项省略该键；这个选项不作为新 wire 字段发送。
既有 `TrainingPlanSessionPreview` 读取完整 impact，不依赖回显 draft 的必填距离；没有新增响应字段需要旧客户端解析。
同一草稿用于 preview/submit；签名候选仍绑定原始省略/null/值、scope、实例、state/session 修订、事实、业务日和设备状态。

## 跨端固定基准

[同一份合成 Fixture](../../apps/ios/tests/fixtures/training-session-distance-v1.json) 包含七堂固定课程，覆盖要求中的全部结构语义。
easy/interval/tempo 直接冻结 `buildCompleteCoachWeekPlan` 的输出，Node 测试重新生成并逐字段比对。
warmup/recovery/cooldown 和循环通过生成课程、mixed 与 historical-distance-only 覆盖。

| 课程 | persisted km | measured km | measured 秒 | display km | iOS 原样编辑距离编码 |
|---|---:|---:|---:|---:|---|
| easy | 4.4 | 4.422604 | 1800.00 | 4.4 | omit |
| interval | 7.3 | 7.327764 | 2483.20 | 7.3 | omit |
| tempo | 8.9 | 8.921263 | 3000.00 | 8.9 | omit |
| distance-only | 8.05 | 8.050000 | 3276.35 | 8.1 | value |
| time-only | null | 4.422604 | 1800.00 | 4.4 | null |
| mixed | 5.822 | 5.821622 | 1870.20 | 5.8 | omit |
| historical-distance-only | 8.1 | 8.060000 | 3280.42 | 8.1 | value |

Node 验证固定测量值、展示精度、原样编辑、每堂课合法调整、非法显式距离、旧舍入例外边界、空/0 拒绝与范围限制。
Swift 从同一 JSON 解码，验证原样编辑处理和真实编码器的省略/null/显式值；mixed 的服务端基准大于 4.2 km 距离段小计。
Swift 没有复制服务端配速计算。Node 消费相同的 `editorDistanceMode` 语义并完成真实 preview/submit。
事实变化与 COMMIT 失败两类拒绝都验证六张业务/历史/操作表没有部分写入；COMMIT 失败后的相同请求可重试成功。

## 修改文件

以下仅列本阶段实际改动，不把工作区已有改动全部归为本任务：

| 文件 | 目的 |
|---|---|
| [training-plan-session-commands.ts](../../apps/api/src/training-plan-session-commands.ts) | 受限历史舍入兼容、服务端测量省略距离、统一形成有效处方 |
| [schemas.ts](../../apps/api/src/schemas.ts) | add 请求允许省略距离，保留结构必填 |
| [training-plan-closed-loop.ts](../../packages/api-contracts/src/training-plan-closed-loop.ts) | 命令类型与省略语义 |
| [APIModels.swift](../../apps/ios/RAI/APIModels.swift) | add 编码可省略距离，默认编码兼容 |
| [TrainingPlanSessionEditorPolicy.swift](../../apps/ios/RAI/TrainingPlanSessionEditorPolicy.swift) | mixed 识别、历史保留与基础校验 |
| [TechTrainingSessionEditor.swift](../../apps/ios/RAI/Skins/Technology/TechTrainingSessionEditor.swift) | 服务端测量草稿、mixed 输入处理与实时错误原因 |
| [training-plan-session-commands.test.ts](../../apps/api/test/training-plan-session-commands.test.ts) | 固定生成课程、严格边界、合法调整、事务回滚 |
| [schemas.test.ts](../../apps/api/test/schemas.test.ts) | preview/submit OpenAPI 与旧 payload 兼容 |
| [TrainingPlanSessionEditorRegression.swift](../../apps/ios/tests/TrainingPlanSessionEditorRegression.swift) | 修正 mixed 错误预期，同 Fixture 编码回归 |
| [training-session-distance-v1.json](../../apps/ios/tests/fixtures/training-session-distance-v1.json) | 合成的跨端固定语义基准 |
| [现行闭环合同](../../docs/TRAINING_PLAN_V2_CLOSED_LOOP_CONTRACT.md) | 明确三类距离、历史兼容与省略规则 |

本目录保存本报告、原始日志、命令/测试清单、[任务独立 Diff](D01_D02.diff) 与 [工作区保护证据](workspace-preservation.json)。
Policy 和 Swift 回归文件在任务开始时已是未跟踪文件；本阶段是在其现有内容上叠加修改。
没有修改 A-01 逻辑、Skip、区块上限、训练负荷/恢复算法、CI、测试执行器、AGENTS.md 或生产数据。

## 修复前红测与中途失败

- [服务端红测](red-server.log)：38 项，32 通过、6 失败。easy/interval/tempo 与历史纯距离原样编辑因舍入差拒绝；changed mixed 和 add 省略请求未被支持。退出码 1。
- [Swift 红测](red-ios.log)：真实编译后运行，在服务端总量 5.822 km 的 mixed 草稿被本地距离小计拒绝的断言处终止，退出码 132。
- [OpenAPI 红测](red-openapi.log)：完整 schemas 批次 17 项，16 通过、1 失败；add 省略距离被 schema 当成缺失字段。退出码 1。
- 新增 Swift 用例早期尝试修改只读 iterations，编译失败；改为构造新结构后重跑完整定向编译/回归，54 项通过。
- [类型检查中途失败](typecheck-initial.log)：新增 OpenAPI 测试缺少 requestBody 类型收窄；修正测试类型后重跑完整 `npm run typecheck` 通过。
- [iOS 首轮完整批次](ios-initial.log) 因编译期间修改 APIModels.swift 注释，被 Swift 的输入变更检查中止；该轮不记作 PASS。[补充源码检查](ios-source-check-interrupted.log) 同样检测到该输入变化。
  已停止所有 Swift 源码编辑，重新执行完整 `npm run test:ios`，不只重跑出错的编译单元；结果见下一节。
- 文档门禁最初发现既有 A-01 报告未从 README 可达。本阶段报告正常引用其前置状态，现行合同链接本报告后，文档检查通过；没有修改 A-01 文件或放宽门禁。

## 验证结果

环境：macOS 26.6.2 / x86_64，Node v22.23.2，Apple Swift 6.3.2。Node 批次显式使用 `--test-concurrency=2`；未设置 `RAI_TEST_CONCURRENCY`，未更改测试执行器。
[完整命令](validation-commands.json)、[L3 文件清单](l3-files.json)、[Node 统计](node-results.json)、[iOS 耗时与退出码](ios-result.json) 均保存。

| 检查项目 | 结果 | 真实执行范围 / 命令 |
|---|---|---|
| 类型检查 | PASS | `npm run typecheck`，两份 tsconfig；[日志](typecheck.log) |
| L1 定向测试 | PASS | 3 文件、60 项，课程命令 + 结构 + OpenAPI；[日志](l1-server.log) |
| L2 影响测试 | PASS | 17 文件、253 项，命令/状态/安全/保护、生成/协调、读路由、合同与真实服务器；[日志](l2-server.log) |
| L3 模块回归 | PASS | 67 文件、638 项，训练计划全模块及生成、同步、排期回执、发布/崩溃恢复；[日志](l3-server.log) |
| L4 全仓回归 | NOT RUN | 未执行 `npm test` / `npm run test:all` |
| iOS 验证 | PASS（有明确排除） | 完整重跑 `npm run test:ios`，933.55 秒，103 个源码文件类型检查 + 纯逻辑聚合；排除 3 个高德 SDK 专属源码文件；[日志](ios.log) |
| Swift D-01/D-02 定向检查 | PASS | 54 项，独立定向运行和完整聚合中均通过；[定向日志](l1-ios.log) |
| iOS 跨平台源码门禁 | PASS（有明确排除） | `npm run check:ios-gates`，11 支判据，2 支需外部条件的手工判据排除；[日志](ios-gates.log) |
| API 合同 | PASS | OpenAPI preview/submit schema、旧显式 payload、同 Fixture 的 Swift 编码和服务端解析；已包含在 L1/L2/L3 与 iOS 结果中 |
| 文档链接 | PASS | `npm run check:docs`；[日志](docs.log) |
| 文档行号引用 | PASS（边界检查） | `npm run check:doc-refs`，0 越界/无法解析；8 个空行锚告警，内容漂移未核对（无基线）；[日志](doc-refs.log) |
| 验收矩阵 | PASS | `npm run check:acceptance-matrix`，80 条均有引用；不据此声称覆盖强度；[日志](acceptance-matrix.log) |
| 最终 Diff / 行尾 | PASS | `git diff --check`，涉及 Swift 文件均为 LF；38 个无关既有已跟踪 Diff 一致 |
| GitHub CI | NOT CHECKED | 未查询、未运行远程 CI |

L2 是较早完成的影响批次；之后新增的 OpenAPI/事务回归及其完整测试文件均由最终 L1/L3 覆盖。所有失败的定向批次均完整复跑，iOS 输入变更中断后也重新运行了整个聚合入口。
数据库测试使用隔离临时 Fixture；日志中的 `(production)` 只表示临时测试环境的能力开关模式，不是生产部署。


## 测试统计

- 最终保留的成功 Node 批次：60 + 253 + 638 = **951 次测试执行**，均通过，失败 0、跳过 0、取消 0；这些批次有重复覆盖，不能称为 951 个独立测试。
- Node 成功批次命令耗时分别为 7.433、177.064、475.742 秒，累计 **660.240 秒**。这是命令耗时累计，不是任务墙钟耗时。
- 完整 iOS 复跑：**933.55 秒**，退出码 0；其中课程编辑固定回归 54 项。其他 Swift/源码判据没有统一的案例计数，保留原始日志，不虚构聚合测试数量。
- 明确排除：3 个高德 SDK 专属源码文件；2 支需要外部条件的手工源码判据。它们不计为通过。手工模拟器/真机及其他未运行范围见下节。
- 红测单列：服务端 38 项中 6 失败；OpenAPI 17 项中 1 失败；Swift mixed 断言失败。没有把这些原始失败隐藏或计为成功。
- 并发：Node 各批次 `--test-concurrency=2`；iOS 使用现有脚本默认配置。批次存在并行执行，以上累计耗时不能作为性能优化结果或端到端任务耗时。


## 工作区保护与风险

38 个与本任务无关的既有已跟踪 Diff 与开始时逐文件比对一致，未覆盖其他任务修改。已有 A-01 文件保持原位，未清理或重写。
HEAD 未变。没有 stash、reset、clean、暂存、提交、推送或部署。

兼容风险限定为新的距离省略请求需要更新后的服务端支持；旧合法显式 payload 继续有效。响应结构和持久化结构没有新增字段。
历史兼容不代表生产历史数据已完成审计；超限、损坏或不符合当前测量舍入值的旧剂量不会被无条件放行。

未执行：全仓 `npm test` / `npm run test:all`、GitHub CI、完整 Xcode App 构建、Simulator 点击验收、真机编辑/排期/同步验收、AMap SDK 验证、真实生产副本审计。
结构门禁明确排除的逐条后台突变与 live export 判据本次也未执行。源码检查中三个高德 SDK 专属文件明确排除。

当前仍不满足整体合并/部署条件：A-01 的真实生产副本审计和必要 L4 尚未完成，CI 未检查，不能据本阶段局部验证宣称生产验收通过。
本阶段结束后停止，不自动进入其他缺陷修复。
