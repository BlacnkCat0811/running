# 阶段 5：训练计划 v2 遗留入口审查与实施方案

**日期：** 2026-10-23（Asia/Shanghai）  
**状态：** 审查及实施方案已交付；本次没有修改产品代码、启用能力位、执行迁移或部署。  
**代码基线：** /Users/ta/running，HEAD **fc793e0db4f6ecb04f800f01d625f5f50edf5c68**；审查开始时工作区干净。  
**输入：** /Users/ta/Downloads/RAI_Architecture_Optimization_Implementation_Plan.md，第 8 节“阶段 5”。  
**建议：** 按“入口与合同冻结 → 服务端正确性 → 写入所有权 → iOS Publisher → 原生端到端验收 → 能力启用”推进。不能通过打开手动入口或补一个握手字段宣称阶段 5 完成。

## 1. 审查结论与阶段边界

阶段 5 有必要推进，但原计划需要细化为两个可区分的交付层次：

1. **5A：可独立推进的正确性与防回退工作。** 固定可达操作矩阵，修复命令 HTTP handler 的幂等重放缺陷，拆开旧协议授权与 v2 授权，修复验收脚本夹具，保留手动课表只读说明。完成 5A 只能称“遗留入口与已知缺陷收口”。
2. **5B：v2 编辑完整闭环。** 解决统一状态与 coach-loop/legacy 的所有权关系，确定缺失动作合同，再接入 iOS 发布编排和实际设备验证。只有 5B 验收完成，才能称“v2 写可用”或阶段 5 完整完成。

原文允许“合同不足时先交付扩展提案”，因此不能把手动周课表缺失动作偷偷拼成多个命令，也不能以隐藏入口替代完整功能验收。下文给出 5B 的推荐决定和具体步骤；决定尚未落地时，先完成不依赖该决定的 5A 工作。

### 1.1 本次确认的事实

- 手动课表入口已经是只读说明；没有证据支持“当前统一页仍可直接点击旧手动写入口”这一旧描述。
- iOS 仍保留旧服务兼容方法，但尚未调用 /v1/mobile/training-plan/commands 系列接口；当前统一页配置写入走 coach-loop。
- 服务端已经实现 v2 预览、提交和刷新，但故意不宣告 trainingPlanCommandContractVersion。路由存在不代表产品已可用。
- 当前 v2 动作只有 set_race_goal、clear_race_goal、pause、resume，刷新为独立端点。手动逐日课表、完整偏好、start/end 等旧教练动作没有一一对应的 v2 命令。
- 本次隔离复现：同一非 pause 命令通过生产 HTTP handler 首次提交 200，原样重试 409 training_revision_conflict；直接重试 service 则返回原结果。必须在启用写能力前修复。
- 现有 31 项定向 API 测试全部通过，退役出站门禁 623 项通过，单写者结构门禁通过。这些结果不能替代 iOS/API/WorkoutKit 的端到端验收。

### 1.2 与阶段 4、其他计划的关系

当前 HEAD 已包含阶段 4 的多存储/控制库发布锁工作。阶段 4 报告最新补充仍保留生产配置、真实 systemd 与生产恢复验证的人工门；本次未重新验收这些内容，也不把“代码已提交”写成“已生产部署”。这不阻止阶段 5 在隔离环境开发，但发布时必须继承这些未完成项。

仓库 [PROJECT_OPTIMIZATION_PLAN](../../docs/PROJECT_OPTIMIZATION_PLAN.md) 的 PR-03/PR-04 已记录计划所有权和 Publisher 依赖。本阶段应复用这些设计约束，只实施训练计划闭环所必需的部分；不顺带实施其他 PR、不重构全部 iOS 网络层、不进入阶段 6 容量测试。

原始下载文档的头部、阶段 0 尾部和全文尾部仍有阶段批准状态不一致的问题。其阶段 5 目标可作为范围依据，历史状态和旧行号不能直接当作当前事实。

### 1.3 固定约束

- 保留 SQLite、单 API 进程、现有 worker、单写者、控制库 publication transaction、CAS、guard、epoch 和持久操作账本。
- 只涉及原生 SwiftUI iOS、Node.js API 及共享合同；不创建 Web、WebView、macOS 或其他客户端。
- 保留 D19 的 5 条旧路径 / 7 个 method+path 操作及其 410 语义；不恢复旧写协议，不删仍有效的读、反馈、锁课和回执接口。
- 不改训练阈值、剂量算法、历史处方或历史回执。HealthKit 健康样本保持只读；WorkoutKit 排期仍遵循现有前台授权、撤回和强读回流程。
- 所有数据库测试使用独立临时目录与合成数据。本次未读取生产数据库、未访问生产主机，也未执行生产压测或迁移。

## 2. 证据口径及本次检查

本报告采用原计划口径：E1 为当前源码直接证据；E2 为本次实际执行的检查/隔离实验；E3 为源码推断或待实验确认。E2 必须同时注明测试边界，不能把 handler 测试写成真机端到端。

| 检查 | 结果 | 证据与边界 |
|---|---|---|
| git status --short；git rev-parse HEAD | EXIT 0；开始时干净 | 本次新增方案与审查证据，并补 deliverables/README.md 索引；未改已有产品文件 |
| Node 版本 | v22.23.2 | 本地主机；不是生产环境证据 |
| 退役出站源码门禁 | EXIT 0，623 checks | [retired-outbound.log](evidence/retired-outbound.log)；静态形状检查 |
| training-plan single-writer | EXIT 0，0 违规 | [single-writer.log](evidence/single-writer.log)；505 个生产源 / 145 个测试文件，存在既定测试豁免；不证明语义只有一个写者 |
| 5 个定向 API 测试文件 | EXIT 0，31 pass / 0 fail / 0 skip；文件并发 1 | [targeted-api.log](evidence/targeted-api.log)；包括真实服务路由退役矩阵，但不包括原生客户端 |
| 新增命令重放审查探针 | EXIT 0，成功复现缺陷 | [探针源码](evidence/command-route-replay-probe.mts)、[输出](evidence/command-route-replay-probe.log)；Fastify inject + 生产 handler/service + 临时控制库，计划生成器为合成替身 |

**探针 EXIT 0 表示“预期缺陷复现成功”，不表示被测功能合格。** 首次状态 revision=2，重试后仍为 2；没有重复写入，但重试错误地返回 409。底层 service 原样重放结果与首次一致。

本次没有运行完整 npm test、typecheck、test:ios、check:ios-gates、Xcode 构建、Simulator UI、配对 Apple Watch 验收或性能基准；它们都属于后续实施验收，不标为通过。实际命令与退出码见 [checks.json](evidence/checks.json)。

文档检查首次发现新文档未从 README 可达，已通过补交付物索引修复；首次失败日志保留在 evidence/docs.log。最终复验见 evidence/docs-final.log；git diff --check 及新增文档本地链接、UTF-8/LF、代码围栏配对检查通过。

## 3. 审查发现与处理优先级

以下行号对应上述 HEAD。实施时必须更新行号；不能继续引用本报告行号作为修改后定位。

### F1 — P1：HTTP 层在查幂等结果之前校验旧 revision，重试被错误拒绝

**定位：** apps/api/src/training-plan-routes.ts:263，createTrainingPlanCommandHandlers.submit；training-plan-commands.ts:202，planFor；同文件 :259，submit；:360，refresh。

**证据：E1 + E2。** 非 pause 的 handler 先执行 planFor，再生成计划，最后调用 service.submit。planFor 已检查 expectedStateRevision；首次提交已抬高 revision，因此同 operationId 原样重试尚未到 publication 幂等查询就被拒绝。现有 commands 单测直接调用 service.submit，未覆盖这层编排。refresh 已有提前重放查询，可参考其语义，但不要机械复制。

**修复要求：** 在读取当前 revision、检查候选 TTL、生成计划之前，通过同一持久操作服务核验 operationId、route、scope 和请求摘要；已 committed 返回原结果，同键异载荷拒绝，expired 不重执行。不存在的操作才进入新命令验证和生成，最终 publication transaction 仍需再次幂等检查与 CAS，以覆盖并发竞争。

**验收：** 相同 HTTP 请求重复提交、成功后响应丢失再重试、重启后重试均返回原结果；生成器不再次执行，unified/goals/history/operation 不新增第二次业务变化。异载荷必须返回键冲突，而不是提前返回 revision 冲突。

### F2 — P1：写能力判断仍会放行旧协议，无法直接启用 v2

**定位：** apps/ios/RAI/NativeAppModel.swift:86，planWritesAvailable；:1696，publishPlan；apps/ios/RAI/APIClient.swift:307，replayPlanPublication；apps/api/src/server.ts:1296，能力暂不宣告。

**证据：E1；真实 UI 触发影响尚未实测。** 当前读能力存在时，仅以“写能力字段非 nil”决定放行；未知版本也会通过。随后 APIClient 的 coach/confirm/goals 路由仍映射到旧接口。无握手时该布尔还默认为 true。当前只读入口和未宣告能力阻断了主要路径，但未来直接开启能力位会解除旧写守卫。

**修复要求：** 独立表示 legacy 兼容资格、v2 读能力、v2 写能力和执行授权；精确匹配已登记版本，缺失/未知/协商未完成不得新增 v2 写。已知旧服务器按其既有协议处理。当前新服务器的旧路由不得因为 v2 可写而重新获准。

**验收：** fake transport 检查实际 method、path、body、发出次数；不能仅断言按钮 disabled 或某布尔为 false。新增能力必须命中 v2 URL，旧路由调用数为 0。

### F3 — P1 前置：统一投影与 coach-loop 管理状态尚未形成一个写入所有者

**定位：** apps/api/src/server.ts:613–625，managed preHandler；:1294，握手条件；apps/api/src/mobile-goals.ts:329，commitTrainingPlanCommandState；:662，lockSession；apps/ios/RAI/NativeAppModel.swift:599，changeCoachLoop。

**证据：E1 + 部分 E2。** 当前 managed active/paused/异常 receipt 的 v2 读被 preHandler 返回 409；这是现行合同，不是可单独删掉的错误。真实 router 测试已覆盖该行为，旧“managed 夹具没有进入分支”的问题不能再作为未修复项。另一方面，lockSession 仍直接写 goals，统一命令另写 unified，iOS 配置走 coach-loop；结构门禁不能证明它们在业务上是同一份状态。

**处理要求：** 先定所有权，再同时调整服务、投影、managed 合同、授权读取和路由测试。不得仅放行 v2 GET，而继续让配置或锁从两条独立路径写入。

**验收：** lock/relock、set/clear goal、pause/resume、既有 coach-loop 命令和自动刷新均被列入写者矩阵；同一当前配置/意图/锁只有一个权威。pause 立即拒绝新的服务端执行授权，历史回执保持原样。

### F4 — 功能缺口：现有 v2 action 无法表达完整旧编辑器

**定位：** packages/api-contracts/src/index.ts:2222，TrainingPlanCommandAction；TechPlanView.swift:347，manualPlanEntry；NativeAppModel.swift:1199，createWeeklyPlanPreview；TrainingPlanRepository.swift:19。

**证据：E1。** 当前手动入口是只读说明；不能直接接 refresh 来冒充“保存我编辑的逐日课表”。现有 preview 是配置摘要预览，不承诺返回逐日候选计划。start/end、训练偏好等也不能擅自改名为 resume/pause。

**处理要求：** 保持只读安全状态，按第 4 节选择支持范围；如保留这些编辑功能，先交付独立、原子的合同扩展及存量兼容方案。

### F5 — P1 验收阻断：视觉测试准备脚本仍依赖退役接口

**定位：** apps/ios/tests/run-visual-tests.sh:55、64–65。

**证据：E1。** 脚本先 GET /v1/mobile/goals，再调用旧 preview/confirm 准备夹具；当前这些接口返回 410。不能把该脚本现状当作阶段 5 可直接执行的端到端验收入口。本次没有启动该脚本，结论为确定的接口依赖不兼容，不虚构运行失败日志。

**处理要求：** 采用停服的合成 fixture 初始化 + 正确迁移，再用有效 v2/执行合同准备 UI 情境；保留对旧接口 410 的负例测试。对认证 Token、本地端口、独立 runtime/control/主库路径做自检，不能通过恢复旧 API 或关闭全局鉴权让验收脚本跑通。

### F6 — P2 产品语义待定：七日窗口只要命中一天就判 current

**定位：** apps/api/src/training-plan-coordinator.ts:39–49，refreshDecision。

**证据：E1。** 当前 .some 判断未来七天窗口内任意一天；不证明今天存在，也不证明七日完整。现有行为不能直接判为产品缺陷；更改之前必须明确完整性要求。

**推荐：** 已发布处方保持真实；缺日明确显示“未生成/待刷新”，不补成休息、不改历史。若决定补齐未来窗口，再实现缺日判据和有界刷新，防止一份无法补齐的计划触发无限生成。

### F7 — P1 待验证风险：计划生成前后的事实指纹绑定

**定位：** apps/api/src/server.ts:1868–1885，prepareTrainingPlan / mainDataVersion。

**证据：E1 + E3。** prepare 中先读 weeklyPlanSnapshot，await 生成后才拼接 mainDataVersion。需要证明生成使用的事实版本与提交核验版本一致，不能只在生成结束时读取“当前版本”贴到旧输入上。本次未注入并发导入，不能写成已复现脏计划发布。

**处理要求：** 以 latch 控制“读输入后、生成完成前”的事实更新，实测现有 fingerprint 是否拒绝混合版本。若失败，冻结读输入时的完整事实/配置/epoch 指纹，提交时重新核验；同时核对缓存身份和数据库替换。不能取消 guard，也不引入跨文件原子事务假设。

## 4. 实施前要固化的决定与操作映射

这些是本方案的推荐选择，尚未替代已有产品决定。记录在现行决策文档或新 ADR 后再实施对应分支；本次交付方案无需等待这些选择。

| 决定 | 推荐选择 | 未确定时的处理 |
|---|---|---|
| D5-A 当前状态所有权 | unified 管配置、运行状态、计划意图、当前锁；goals 为兼容投影；coach-loop 提供决策事实并调用同一写入服务；历史证据账本独立 | 不启用 v2 写能力；保持现行 managed 合同；可先修 F1/F2/F5 |
| D5-B 手动课表及偏好 | 本阶段先接现有四动作 + refresh；手动逐日课表继续只读，若要求恢复则先批准最小扩展 | 不恢复旧写、不将 refresh 冒充手动保存；报告必须标明功能缺口 |
| D5-C start/end 等旧教练动作 | 逐项明确归属和终态；暂保留有效 coach-loop 协议并汇入同一所有者，不能简单暂停代替结束 | 不删除既有功能；未完成所有权适配前不宣告完整 v2 闭环 |
| D5-D 七日展示 | 每日区分已安排、明确休息、缺失；缺失不算休息；是否自动补齐另列判据 | 保持调度行为，使用准确的部分窗口文案 |
| D5-E 写能力版本与发布条件 | 在 TS/Swift/handshake registry 同时登记明确版本；候选构建隔离开启用于验收，通过后才生产宣告 | 不采用“字段存在即支持”；不为测试提前在生产开启 |

**范围控制：** 如果所有权决定尚不能确定，5A 可以完成并交付；5B 停在前置条件处。不得把大型所有权重构悄悄纳入“修一个 UI 入口”，也不得把 5A 完成写成整个阶段 5 通过。

### 4.1 用户动作与 wire 合同

| 用户操作 | 合同路径/动作 | 关键语义及 UI 验收 |
|---|---|---|
| 打开训练页/刷新展示 | GET training-plan-state，Header X-RAI-Training-Contract: 2 | 只读，无迁移、生成、发布副作用；投影不授权执行 |
| 保存赛事目标 | commands/preview → commands；set_race_goal | 预览配置变化，用户确认后原 candidate + revision + scope 提交；不能跳过确认 |
| 清除赛事目标 | 同上；clear_race_goal | 不是 end，也不是删除历史；展示转换后的模式 |
| 暂停 | 同上；pause | 发布配置状态，不生成新计划；拒绝新执行，物理手表旧条目仍待前台撤回 |
| 恢复 | 同上；resume | 已结束不可恢复；重新验证当前事实，不能自动安排到手表 |
| 刷新/重新生成 | commands/refresh | 原 scope/revision + operationId；当前合同无 candidateId，不伪造预览语义 |
| 取消预览/关闭编辑器 | 客户端本地撤销 | 不发 submit，无持久业务变化；不等于 pause/clear/end |
| 提交后取消等待 | 停止 UI 等待、保留 pending、查询 operationId | HTTP 取消不证明服务端回滚；不得提示“已撤销成功” |
| 冲突/候选过期后重试 | 重新读取 → 用户重新预览/确认 → 新操作 | 不自动提升 revision，不把旧 payload 绑定新候选 |
| 结果未知后的重试 | GET plan-operations/:id | committed 接纳原结果；只有明确 notFound 才可能原键原字节重放 |
| 手动偏好/逐日课表 | 当前无对应 v2 action | 保持说明；需要恢复时走 §4.2 扩展 |
| 锁课、反馈、排期回执 | 现有有效专用接口 | 保留其语义，接统一所有权；不因为不属于 commands 就一律退役 |

上表省略的前缀均为 /v1/mobile/。preview TTL 当前为 120 秒；operation 保留 90 天。二者用途不同，不能把候选过期当作已提交操作过期。

### 4.2 若要恢复手动编辑：最小合同扩展交付内容

在编码前先提交合同差异，而不是直接新增看似可用的按钮：

1. 定义拟新增动作，例如 update_preferences、replace_manual_week；名称仅为提案，需在共享合同中正式确定。明确哪些字段归 unified，哪些仅为投影，是否需要新的能力版本。
2. 偏好至少说明 easyDurationFloorFraction、qualitySessionCap、跑步日、每周目标等实际 UI 字段的验证、缺省、null、跨字段约束；不能只迁其中两项却宣称完整保存。
3. 手动周课表明确服务端 businessDate、可编辑未来日期、休息与缺失、历史完成日保护、当前锁课、处方结构及合法性。不得在客户端重写评分或训练政策。
4. 若 UI 承诺“确认这份逐日候选”，预览必须返回可核验的逐日结果，并把候选内容/配置/事实指纹/TTL 绑定到确认；现有配置摘要 preview 不满足此承诺。
5. 单次确认在同一控制库事务内提交 unified、goals 投影、计划历史和 operation result。不得用“保存偏好 → 保存周计划 → refresh”三次非原子写来冒充一个保存动作。
6. 为结束状态、撤回风险、既有 coach-loop 托管和旧客户端行为定义清晰结果。结束不可偷偷映射成 pause；新状态值需版本化。
7. 列出存量迁移、读取旧缓存、API/客户端交错升级及回滚兼容矩阵；没有迁移必要时明确写“无需迁移”，不能凭假设加 schema。

**扩展准入验收：** 每个可编辑字段都有权威存储、合法值、命令、错误码、事务范围、预览展示和自动化断言；任一缺失则该编辑入口继续关闭。

## 5. 分批实施步骤与退出条件

### S0 — 冻结基线、范围和决策（G0）

1. 保存 HEAD、工作区 diff、Node/SQLite/Xcode/Simulator 版本及目标 iOS 构建号；已有修改不得覆盖。
2. 核对阶段 4 最新报告、控制库锁与迁移约束，把未完成生产门继承到发布清单。
3. 将第 3 节发现逐项登记：已复现、源码已确认、待实验、产品选择分别标识。
4. 落实 D5-A～E；若只批准 5A，明确阶段完成口径，保持写能力未宣告。
5. 建立合成 fixture：未迁移/已迁移，unmanaged/managed active/paused/ended/损坏 receipt，已有锁、已有系统排期、不同 epoch。

**产物：** BASELINE.md、DECISION_MATRIX.md、fixture 清单；可合并到阶段报告。  
**G0：** 身份、测试写入路径与决定状态全部明确；不涉及生产文件；没有以过期文档覆盖当前实现。

### S1 — 补齐入口与能力矩阵，先加失败用例（G1）

1. 从 TechPlanView、TechCoachLoopSection、偏好 sheet、TechRunCoachView、TechManualPlanView、锁课和手表同步入口逐项追踪到 NativeAppModel、Repository/APIClient 和 method+path。
2. 清点正常点击、缓存恢复、旧 pending 重放、后台返回前台、快捷操作等可达路径，不以 URL 搜索结果代替运行时覆盖。
3. 为 F1 添加生产 handler 回归；补充有 planDeps 的非 pause 提交和 pause 的对照。
4. 为 F2 添加能力组合的 fake transport 用例，证明未完成握手/未知版本不会误发写入，v2 能力不会放行旧 URL。
5. 对当前 managed 409 和退役 410 保留基线断言，所有权方案生效后再有意识修订目标断言。

**产物：** ENTRY_MATRIX.md；每行包含入口、可用条件、方法、请求合同、失败表现、测试 ID。  
**G1：** 没有未归类的可达写操作；新增用例至少能在旧实现上暴露 F1/F2，且不会只重复实现中的布尔判断。

### S2 — 修复命令事务与幂等边界（G2）

1. 将 F1 的“已提交结果查询”置于当前 revision/TTL 检查及昂贵生成之前；统一校验 route/scope/payload，复用持久操作服务。
2. 保留最终事务中的重复请求裁决及 CAS；两条请求同时查到 notFound 时，也不能各提交一次。
3. 对 submit/refresh 的并发生成准入、释放 finally、异常和关闭路径做定向检查；需要统一准入时复用现有 gate，不另开第二个无限生成队列。
4. 执行 F7 的 latch 故障实验，核对生成前后事实、配置和 epoch 变化；仅在实测证据支持时修复指纹采样位置。
5. 在 unified、goals、history、operation 各写点之间注入故障；确认事务回滚，连接/租约/准入均释放。
6. 测试提交成功后断响应、进程重启和保留期过期；不要依赖内存候选对象来证明持久重放。

**主要文件：** training-plan-routes.ts、training-plan-commands.ts、plan-publication.ts、mobile-goals.ts、server.ts；只改证据涉及的位置。  
**G2：** T08–T16 通过；失败时不产生部分状态；已 committed 重放返回原结果且生成次数不增加；错误内容不泄漏路径或凭证。

### S3 — 收敛训练状态所有权与 managed 合同（G3，依赖 D5-A）

1. 列出配置、计划意图、锁课、运行状态、执行授权、receipt/history/operation 的权威来源与全部写入者。
2. 统一命令、自动刷新、lock/relock、coach-loop 的配置/计划变更进入同一应用服务。历史账本继续独立追加，不能把所有历史塞入 unified JSON。
3. unified CAS、兼容 goals 投影、历史与 operation result 保持同一控制库 publication transaction；跨主库事实保持 guard/fingerprint 检查。
4. 审查暂停/结束后的执行快照、锁课、同步预检和恢复：任一入口都不能重新授权旧未来计划。取消新的授权不代表已经撤掉物理手表上的日程。
5. 按已批准决定修订 managed preHandler 和能力宣告条件：已迁移且受支持的 v2 读可服务，v1 仍按自己的合同处理；异常/损坏状态继续 fail-closed，不能无条件放行。
6. 同步更新 IOS_NATIVE_API_CONTRACT 的 managed 段、handshake registry、OpenAPI/路由矩阵和真实 server 测试。未知 Header、未迁移 scope 必须保留各自明确错误。
7. 若当前字段足够则不做迁移；若需迁移，先离线 dry-run、隔离 apply、重复 apply、冲突和旧 schema 读取验证。继承阶段 4 的控制库发布锁与停写要求。
8. 按 D5-D 实施窗口显示或覆盖判据；冻结时钟测试上海跨日、月末、年末和部分窗口，缺失不变成休息，无循环重算。

**G3：** 配置/意图/锁的每种变更均有前后状态对照；无第二当前真相；T02–T05、T13–T18 通过；不删除旧表和有效路由，不修改历史处方及回执。

### S4 — 建立 iOS v2 DTO、能力路由与 Publisher（G4，依赖 G2/G3）

1. 在 APIModels/APIClient 实现 preview、submit、refresh 的 Codable DTO 与请求方法；包括显式合同版本、scope、operationId、candidateId、各 revision 和错误码。不要直接复用 legacy DTO 换 URL。
2. 新建 TrainingPlanPublisher.swift（建议名），由 Repository/APIClient 提供网络与持久化能力，NativeAppModel 转发 UI 状态。避免在新旧发布器各复制一套 pending/确认水位算法。
3. 拆开 legacyWritePolicy 与 v2CommandCapability；精确版本支持表，未完成握手只读。将 URL 的选择与合同类型绑定，禁止字符串 route 默认落入 goals。
4. preview 捕获草稿版本、服务 URL、serverId/athleteId/epoch、会话代次和 expectedStateRevision；草稿改动/身份切换后候选失效。
5. 用户确认时只编码一次提交体，持久化 operationId、原始 Data、命令类别、scope、候选及时间；落盘失败不发送。Token 不进入持久载荷或诊断日志。
6. submit 成功先持久化确认水位，再使旧读失效、完整重读；分别保存 stateRevision、goalsRevision 与现有执行水位，禁止用一个 max 混合不同含义的 revision。
7. 响应未知时进入 querying，不创建新 operationId。只对明确 notFound、身份仍一致、候选仍有效且允许执行的操作重放原字节；committed 接纳原结果；expired/scopeMismatch/未知状态不重放。
8. 服务端成功但本地确认落盘失败：保留可恢复账目并禁止新执行；不要再次提交业务命令。清账失败必须显示诊断，不能报告已经清除。
9. 旧 pending 解码保持兼容：只查询其原作用域；终局 410 只关闭相应本地 pending，不擦除排期 ledger、历史回执和撤回风险；不能把旧 payload 解释成 v2。
10. 更新实际 Swift 编译清单、Xcode source membership 和测试聚合链，确保新增文件既被产品编译，也被必要回归覆盖。

**建议状态机：** idle → previewing → previewReady → persistingIntent → submitting → committedAwaitingRead → ready；结果未知走 querying；候选/版本冲突回到 needsPreview；身份改变进入 invalidated；终局退役进入 retired。refresh 跳过 preview 状态，走自己的明确确认与提交路径。

**G4：** T01、T06–T12、T19–T25 通过；持久化/重启/迟到回包均不污染当前身份；Publisher 没有隐式 WorkoutKit 副作用。

### S5 — 接入原生 UI、保留设备安全边界（G5）

1. 设置/清除目标、暂停/恢复接对应 v2 命令；配置预览明确显示变化、警告和候选失效，不能称为逐日课表预览。
2. 确认中禁重复点击；预览取消零写入；提交后关闭页面只停止等待，显示可查询的待确认结果。
3. 409 revision/candidate 冲突保留草稿并提示重新预览；503 提供重读；410 显示退役；404 显示不支持/路径错误。所有重试按钮明确是重读、查询操作还是重新预览。
4. 手动周课表在扩展未通过前继续只读说明；如扩展通过，使用其候选合同恢复，不能改调用旧 preview/confirm。
5. start/end、反馈和锁课保持既有功能，并按 G3 的所有权调用链验证；不因迁移删除合法功能。
6. 命令成功后完整重读统一投影及对应执行快照；v2 execution.permitted=false 保持不变，只有既有执行合同能授权排期。
7. 前台切换继续“持久 intent → 精确 UUID/时刻撤回旧条目 → 强读回 → 登记撤回 → 新排期”；仅在用户授权的前台流程操作 WorkoutKit，不增加后台自动排课。
8. 身份变更关闭旧编辑器，旧回包丢弃；离线显示参考状态，不能从旧缓存激活新写或排期。

**G5：** 用户可达按钮与 ENTRY_MATRIX 一一对应，操作后 UI、服务端状态及本地持久水位一致；T17–T27 通过，无可点击后必然返回 410 的新服务写入口。

### S6 — 修复验收夹具，执行自动化及原生端到端（G6）

1. 先修 F5；fixture 使用服务端认可的离线初始化/迁移入口，起服务后再通过真实命令创建情境。不得往运行中的控制库随意 INSERT 伪造正式验收成功。
2. 区分 API/service 测试、URLProtocol 编解码测试、Simulator 到真实隔离 API、配对设备四层证据。fake generator 和 proxy 截图不能标成真实生成/网络端到端。
3. 执行第 7 节命令；保留失败日志、修复说明和最终通过日志，记录 skip 原因和测试并发度。
4. Simulator 至少完成设置目标→预览→取消→再次预览→确认→重读，以及冲突、响应丢失查询、重启恢复和能力关闭场景；保存 xcresult、必要截图及脱敏请求关联 ID。
5. 配对 iPhone/Apple Watch 验证已有日程切换、暂停后不能新增执行、拒绝授权/撤回失败/回执失败；服务端回执仅证明客户端读回系统日程，不能单凭 API 200 声称物理手表可见。
6. 结论分级：工程回归通过、Simulator 通过、配对设备通过、生产发布待执行。未跑的层级保持未执行。

**G6：** 验收矩阵中适用项均有证据，无未解释失败；没有 Xcode 或设备时可以交付研发结果，但不得宣告完整端到端或生产写能力验收通过。

### S7 — 能力启用、发布核对与停止点（G7）

1. 在隔离候选服务开启明确版本的写能力，让新客户端完成 G6；生产能力保持关闭直到所需验收完成。
2. 以新旧客户端/新旧服务端组合核对版本切换；旧 App 收到新能力也不能因 F2 重新发旧写。必要时采用已定义的客户端版本协商/发布次序，不能假设所有 App 同时升级。
3. 按第 8 节确定兼容及回滚，继承阶段 4 的备份/停写前置条件；记录 schema 和客户端持久格式是否变化。
4. 生产启用属于独立发布动作；完成发布后只做受控功能验证，不运行故障注入或阶段 6 压测。
5. 提交最终报告、操作矩阵、测试日志、残余风险和回滚步骤；明确 5A 或完整阶段 5 的验收级别，然后停止，不自动进入阶段 6。

**G7：** 能力宣告与实际可用性一致，未知版本被拒绝，历史/旧客户端保护不退化，发布与未发布事实清楚。

## 6. 验收矩阵（实施时逐行填结果与证据）

“请求数为 0”需用 transport spy/代理日志验证；“无写入”需比较控制库相关表和 revision，不能只看 HTTP 状态。标有条件的用例由已确定范围决定，不适用须写原因。

| ID | 场景与执行方式 | 必须满足的验收条件 |
|---|---|---|
| T01 | 能力：无握手、旧服、仅读、支持写、未知写版本、缺持久操作能力 | 新 v2 写仅在明确支持组合可用；未知能力零写请求；旧服兼容路径独立；当前新服旧写请求为 0 |
| T02 | unmanaged，迁移前/后，Header 缺省/1/2/未知 | 迁移前 v2 明确 409；迁移后符合当前约定；未知合同不静默降级；GET 不改表 |
| T03 | managed active/paused/ended/损坏 receipt，真实 server | 实施前锁定现行 409；所有权决定生效后只放行契约允许的 v2；损坏状态 fail-closed |
| T04 | 退役 5 路径/7 操作 + 不存在路径 | 已认证且允许进入业务路由时退役返回 410/stable code/replacement/no-store；未知路径 404；退役写不改 revision；鉴权仍先按既有合同处理 |
| T05 | 设置/清除比赛目标，v2 读及兼容执行读 | unified 配置、goals 投影和计划上下文一致；execution.permitted 始终 false |
| T06 | preview 后取消、修改草稿、TTL 120 秒边界 | preview/取消不提交业务状态；草稿改动候选失效；过期不能确认；重新预览后需用户再确认 |
| T07 | candidate 篡改、错误 action、未知 contractVersion、非法目标 | 明确拒绝；无写入、无历史追加；iOS 正确显示，不能当空计划/休息 |
| T08 | 非 pause 与 pause，同键同载荷 HTTP 重试 | 原响应结果一致；无重复副作用；非 pause 不重复生成；不能提前返回 revision 冲突 |
| T09 | 同键异载荷、跨 scope、过期操作 | 分别明确键冲突、域冲突、终局过期；不重新执行；不能把旧结果交给新域 |
| T10 | 提交成功后断响应，再查询 committed | 客户端接纳原结果；同一操作只提交一次，不生成新 UUID |
| T11 | 查询 notFound / HTTP 404 / expired / scopeMismatch / 未知状态 | 只有业务信封明确 notFound 才可按条件重放；404 不等于 notFound；未知/终局不重放 |
| T12 | 两端同时提交同 revision、连点确认 | 只有一个新业务提交，另一请求原结果重放或明确冲突；不自动上调 revision，不重复排期 |
| T13 | unified/goals/history/operation 写点逐点故障 | 全部提交或全部回滚；失败后重启不出现部分计划，锁/lease/gate 释放 |
| T14 | 生成读取后，提交前改变事实/配置/epoch | 原候选拒绝；新事实不能附着旧计划；无旧 scope 缓存误读；无指针/历史虚假成功 |
| T15 | 生成器拒绝、超时/关闭、busy、空计划 | 原计划不变，错误有稳定含义；准入释放，后续合法请求可继续，无无界排队 |
| T16 | 进程重启后重复原操作，候选 TTL 已过但 operation 已 committed | 仍返回持久原结果；未提交且候选过期才要求重新预览 |
| T17 | lock/relock、pause/resume、ended，跨读模型 | 锁身份一致；暂停/结束不能新增执行；恢复按当前事实；ended 不误用 resume |
| T18 | 空窗口、仅一天、缺今天、完整七日、上海跨日 | 按 D5-D 裁决；缺失不显示休息；无无限刷新；历史已完成日不改写 |
| T19 | pending 落盘失败；确认水位落盘失败；清账失败 | 首次落盘失败零请求；确认落盘失败阻止新执行并可恢复；清账失败不报告成功 |
| T20 | App 重启、页面关闭、Task 取消、请求迟到 | pending 不丢；先查询恢复；取消等待不等于取消服务端提交；迟到回包不能倒退状态 |
| T21 | 换 URL/Token/serverId/athleteId/epoch | 作废旧候选和当前回包资格；不跨域重放；凭证变化重新协商但不伪造数据集身份 |
| T22 | committed 后展示重读失败，旧读稍后返回 | UI 显示“已保存待刷新”；只重读不重写；旧读不能覆盖确认水位 |
| T23 | HTTP 401/404/409/410/422/503、未知 code | 分别处理认证、版本/路径、冲突、退役、验证及服务不可用；未知值不启用执行 |
| T24 | 旧 pending 格式和退役 route 恢复 | 原 scope 查询；410 终局；不转换成 v2 payload；ledger/receipt/撤回风险不被误删 |
| T25 | DTO 跨 TS/Swift fixture 编解码 | 版本/scope/revision 字段准确；null/省略按合同；原始请求 Data 在重试中一致；不依赖本地时区猜 businessDate |
| T26 | Simulator 真实 API 用户链路 | 保存/预览/确认/取消/冲突/查询恢复均有 UI 与 API 最终状态对照；截图之外还有请求和持久状态证据 |
| T27 | 配对设备切换/暂停/拒绝权限/撤回或回执失败 | 先撤回并强读回再新排期；无自动后台操作；失败不显示已同步，物理可见性单独记录 |
| T28 | 合同扩展的手动偏好/逐日课表（如纳入） | 单命令原子确认；候选逐日内容可核验；非法/冲突整体拒绝；历史及锁课保护不变 |
| T29 | 其他 iOS/健康同步及既有 API 回归 | 相关全量和 iOS 门禁通过；没有新增健康记录写入；有效端点未被错误退役 |
| T30 | 新旧 App/服务端交错升级及回滚 | 未支持版本只读；旧 App 不因写能力宣告误发退役写；pending/schema 兼容有实际演练结果 |

**完成判据：** 适用用例 100% 有明确结论；P0/P1 未解决项为 0；skip 必须列原因和影响，不能计入通过。若 T26/T27 未执行，只能给出分层研发结论，不能把它们留空后宣称完整阶段 5 通过。

## 7. 执行命令与门禁安排

命令均从 /Users/ta/running 执行。以下“实施必跑”不代表本次已执行；本次实际记录只见 §2。

### 7.1 本次审查命令（已执行）

~~~sh
python3 -B apps/ios/tests/check-retired-plan-outbound.py
node scripts/check-training-plan-single-writer.mjs
node --import tsx --test --test-concurrency=1 apps/api/test/training-plan-commands.test.ts apps/api/test/training-plan-v2-route.test.ts apps/api/test/training-plan-coordinator.test.ts apps/api/test/legacy-surface-retirement.test.ts apps/api/test/training-plan-error-sanitization.test.ts
node --import tsx deliverables/phase5-review-2026-10-23/evidence/command-route-replay-probe.mts
~~~

探针固定重现当前缺陷；修复后应转成正常回归用例，不能修改该历史证据使其看似当时已经通过。

### 7.2 实施必跑

~~~sh
npm run typecheck
npm run check:training-plan-single-writer
npm run check:package-boundaries
npm run test:ios
npm run check:ios-gates
npm run check:acceptance-matrix
npm run check:docs
npm run check:doc-refs
npm run check:scripts
git diff --check
git ls-files --eol apps/ios packages/api-contracts packages/contracts
~~~

完整 npm test 推荐文件并发 2。为避免把 POSIX 环境变量写法放进跨平台 npm script，可用下述跨平台启动命令（记录实际并发值）：

~~~sh
node --input-type=module -e "import {spawnSync} from 'node:child_process'; const r=spawnSync(process.execPath,['scripts/run-tests.mjs'],{stdio:'inherit',env:{...process.env,RAI_TEST_CONCURRENCY:'2'}}); process.exit(r.status ?? 1)"
~~~

该命令直接运行 npm test 所用入口；执行前仍须 npm run check:node。也可在当前 shell 正确设置 RAI_TEST_CONCURRENCY=2 后运行 npm test，发布报告应保留实际命令。不得把 VAR=x 写进 package.json 的 script body。

新增测试优先落在已有 commands、retirement、plan-publication、coach-loop-runtime-safety 及 iOS ModelRegression/TrainingPlanV2Regression 文件，必要时新建聚焦用例。确保 Node 测试发现器和 iOS run-model-tests.sh/run-ios-gates.sh 真正执行它们，不扩展豁免名单换绿灯。

### 7.3 条件门禁与人工验证

- 修改 server 启动/注册或 deploy：npm run smoke:api；不在本阶段运行生产 nginx/systemd 操作。
- 修改 schema/迁移：运行相应 migration freeze、training-plan-migration 及阶段 4 锁保护回归；验证停服 apply 和重复 apply。
- iOS 新文件：检查 Xcode 工程/编译清单及 git ls-files --eol，新跟踪的 .swift/.sh/.py/.pbxproj 应为 i/lf、w/lf；未跟踪文件额外检查换行，不能依赖 git 输出覆盖它们。
- Simulator：先完成 S6 的脚本修复，再运行 bash apps/ios/tests/run-visual-tests.sh。明确指定受控的 RAI_VISUAL_DATABASE、专用 Simulator 和输出目录；本次不使用默认 var/rai.sqlite。
- 无 Xcode 时 test:ios 的显式 skip 必须报告“no iOS source was checked”，check:ios-gates 通过不能补成编译通过。
- 配对设备记录 App/API build、系统版本、scope、操作关联 ID、可见排期、失败状态和前台撤回读回结果；不记录 Token 或原始健康数据。

## 8. 兼容、迁移、发布与回滚

### 8.1 兼容矩阵

| 组合 | 预期行为 |
|---|---|
| 新 App + 明确支持旧协议的旧服务器 | 既有兼容入口可按旧合同工作；不发送 v2；不能因缺字段猜测所有旧服务器都可写 |
| 新 App + 当前仅统一读服务 | 相应 v2 编辑只读；现有独立有效功能按其合同运行；无旧写回退 |
| 新 App + 新服务 + 已迁移可用 scope | 精确协商版本，走 Publisher 与 v2 命令，完整重读后才恢复当前展示 |
| 新 App + 新服务 + 未迁移/损坏/恢复中 scope | 明确不可写；不在 GET/启动/App 恢复中自动迁移 |
| 旧 App + 新服务 | 退役请求仍 410；尤其验证旧 planWritesAvailable 对新能力的行为；不能以恢复 v1 写来兼容 |
| App/服务端回滚 + 新 pending 或新 schema | 只有格式兼容已验证才可直接回滚；不能将旧程序对新操作的未知解码当成功或自动丢账 |

### 8.2 发布顺序

1. 先部署或交付禁用 v2 写能力的正确性修复；确认 F1/F2、防回退与旧客户端行为。
2. 所有权/合同变更先在隔离副本验证；有迁移则先演练，再按停写窗口执行。
3. 以隔离候选服务和新 App 完成端到端与设备验证，再制定生产能力启用批次。旧 App 不能被自动更新这一假设代替兼容测试。
4. 生产能力启用必须与真实 scope 就绪条件相符，不能仅全局写死一个字段。能力本身不是鉴权或服务端写屏障，服务器必须有自己的合同/准入检查。
5. 发布后核对少量授权功能链路与错误分布，保留 410/404 区分；性能容量评估留到阶段 6。

### 8.3 回滚规则

- **UI/能力回退：** 关闭新编辑入口并重新协商只读状态；仍需查询已发出的 operationId，不能直接删除 pending。
- **API 代码回退：** 优先撤销新写准入并保留操作查询；核对 unified/goals 投影、账本与 schema 是否被旧程序识别。只隐藏 handshake 不会阻止直调命令，不能当作完整服务器回滚屏障。
- **数据回退：** 不为取消一个用户命令恢复整库；业务撤销必须是新的受支持命令。需要灾难恢复时按阶段 4 的一致性备份、WAL/侧车和停写流程执行。
- **有 schema/持久格式变化：** 扩展优先向后兼容；不可逆变化必须单独说明恢复点和旧版读取限制，禁止旧服务直接打开未知格式。
- **设备回退：** API 回滚不会自动撤销已下发的手表日程，前台撤回、强读回与回执仍需完成。不能清 ledger 伪造设备已撤回。

## 9. 交付物、工作量与最终签收

建议按 S0–S7 拆成可评审的小批次。估计为工程规划量级，不是工期承诺：5A 约 2–4 个工作日；最小所有权收口与现有命令 Publisher 接入再约 6–10 个工作日；Simulator/配对设备与发布验证另预留 2–3 个工作日。手动课表/新状态合同扩展、复杂迁移与等待设备不含在上述估计内，应在 S0 决定后重新估算。

最终至少交付：

1. PHASE5_REPORT.md：最终 HEAD/文件符号行号、实际变更、决策、未执行项和阶段结论。
2. ENTRY_MATRIX.md：用户可达路径、能力组合、实际 HTTP 合同及对应测试。
3. COMMAND_STATE_MATRIX.md：preview/submit/refresh/取消/未知结果/冲突/恢复/终局错误的客户端和服务端状态。
4. OWNERSHIP_MATRIX.md：配置、意图、锁、执行授权、历史和操作账本的唯一责任。
5. API、Swift、Simulator、配对设备的原始证据及 SHA-256 清单；每条日志记录命令、退出码、环境和并发。
6. 新旧版本兼容与迁移/回滚演练记录；无迁移则明确写无迁移。

**签收清单：**

- [ ] F1 已用真实 handler/完整 router 的重放回归修复，不能仅引用 service 单测。
- [ ] F2 的旧写授权与 v2 授权分离，未知版本/无握手/交错升级都有行为证据。
- [ ] F3 所有权和 managed 合同一致，锁课/暂停/执行拒绝/历史证据闭环。
- [ ] F4 每个已开放动作都有正式合同；未支持功能明确只读，不宣称完整恢复。
- [ ] F5 验收脚本不依赖退役写面；F6 窗口语义已决策；F7 已完成实验并按结果裁决。
- [ ] 适用自动化、Simulator 与设备用例通过；未执行项分层记录，不冒充通过。
- [ ] 兼容、持久格式与回滚已演练，生产范围和阶段 4 未完成门清楚。
- [ ] 保留 SQLite/单写者/现有平台与健康样本只读约束；未进入阶段 6。

**本次结论：审查与可执行方案已完成，发现一项隔离复现的 HTTP 幂等缺陷及多项启用前置条件；阶段 5 的产品代码实施和完整验收尚未开始。**
