# iOS 训练计划架构完善方案

现状复核与分阶段实施

评审日期：2026年10月9日，Asia/Shanghai。

代码基线：HEAD 为 73d68450f3df6fa4f771a80b710c442baa738560，同时纳入本地未提交的训练计划改动。文中“现状”指本次检查的工作区，不代表这些改动已经进入主干或发布。

适用对象：RAI 产品负责人、iOS 开发、API 开发与测试。本文用于确定后续设计和验收顺序，不直接授权代码改动。证据编号对应第 12 节。

## 1 方案结论与适用边界

建议保留“服务端生成处方，iOS 展示与适配，WorkoutKit 管理系统排期”的现有方向，在已完成的可靠性改造上继续完善。下一阶段先解决跨接口事实一致性和排期中断恢复，再收敛 iOS 状态写入边界；不把重建全部计划实体或再次拆分页面列为首要任务。

当前已经有 PlanPresentationSnapshot、持久化 revision 水位、串行排期协调器、UUID 与时刻及内容的强回读匹配、回执幂等和旧缓存版本检查。原文将其中部分能力视为缺失，已经不适合作为当前实施清单。[R2–R6]

仍需优先解决的两类问题是：第一，同一 goals revision 下，恢复证据、分区或训练事实可以改变有效处方，三个独立 GET 的 revision 相等不等于读取同一事实快照；第二，系统排期已发生但进程在 ledger 写入前终止时，现有持久化记录未必能描述本次未完成操作。[R2、R3、R5、R9]

### 1.1 本轮必须保留的约束

- 训练评分、准备度、预算、周期化和处方语义继续由现有 TypeScript 服务端负责，不在 Swift 中复制训练算法。
- 沿用 SwiftUI 原生路径和现有 Node.js API。不创建独立 Watch 应用，不引入新的原生客户端产品。
- HealthKit 保持只读。已授权的健康同步后台机制不扩展为计划自动排期或回执后台重试；本方案的恢复和重试默认由前台显式操作触发。
- ~~Web 仍以桌面为支持范围，不修改冻结的窄屏样式、导航或 390px 测试。~~ **2026-10-18 更正**：Web 与 macOS 已于 2026-10-17 退役删除（[DECISIONS](DECISIONS.md) D17、[ADR-006](adr/ADR-006-retire-web-and-macos.md)），原生 iOS 是唯一客户端；"冻结窄屏/390px 测试"不再存在，也不需要为它保留任何约束。
- 不因架构调整改变训练剂量常数、预测支持距离或“准备度不是达标概率”的产品语义。[R1、R11]

### 1.2 建议采用的实施顺序

| 阶段 | 决策重点 | 完成判据 |
| --- | --- | --- |
| P0 | 核验并冻结当前改造基线 | 已有门禁与真机边界明确，未提交代码先完成评审 |
| P0 | 统一有效处方快照与读取错误 | 同 revision 的事实变化可识别，错误不冒充无计划 |
| P0 | 补齐排期写前日志与中断恢复 | 任一 SDK 副作用后终止进程，重启仍能识别风险 |
| P1 | 收敛状态所有权与写操作重试 | 单一计划协调边界，丢回包不重复发布 |
| P2 | 评估持久计划身份与领域表演进 | 有真实历史或多端需求后再迁移，不为命名重建存储 |

## 2 对原文主要判断的复核

原文正确指出了可靠性逻辑分散、版本身份不清、设备排期非事务和缓存错误被隐藏的风险，也正确反对一次性重写。需要修订的是对当前实现程度、API 实际返回内容和优先级的判断。[R0]

| 原文关注点 | 当前结论 | 后续处理 |
| --- | --- | --- |
| revision 不一致直接表现为空 | 已有六类 PlanAvailability；真实无计划与部分失败仍不够独立 | 保留状态模型，补充空态与分类错误 |
| 一致性判断散落在 View | 两页主要读取 planPresentation；协调逻辑仍集中在大型 AppModel | 从 AppModel 抽取计划 Store，而非重建全部 UI |
| Watch 状态与回执需细化 | 已有逐日结果、强回读、部分覆盖和前台待登记账目 | 增加操作写前日志与回执生命周期 |
| 两条计划链路形成两套体系 | 两者已经共用 goals CAS、weekPlan、历史与写入路径 | 先抽发布规则，保留不同创建交互 |
| run-coach 返回整个计划 | 返回配置、生命周期和派生摘要，不返回整个周期逐日训练 | 明确四类读模型与时间范围 |
| iOS mapper 改变训练目标 | 展示 mapper 仍宽容；执行路径已有严格导出检查 | 显式区分展示与执行映射结果 |
| 教练 View 约 1386 行 | HEAD 是 1386 行，当前工作区是 307 行并已拆组件 | 不重复拆分；保持导航和编辑语义 |
| 缓存 schema 与 Codable 兼容 | 当前有 schema 1 与 2，未知与损坏数据可被识别 | 补齐错误传播和元数据读取分类 |
| 考虑以 actor 收敛并发 | 当前有 MainActor、epoch、requestID 和全局排期串行器 | 先固化不变量，不机械改成 actor |
| 增加 planId 和生命周期模型 | 教练已有 id 和 active paused ended；revision 是共享写版本 | 不把共享 revision 改称单计划版本 |

### 2.1 原文没有充分覆盖的剩余风险

三个 GET 各自读取 goals 和主库事实。服务端共享了有效处方生成函数，但函数复用不等于请求之间读取相同事实。客户端现有租约能够发现“已进入本地状态”的变动，不能发现尚未重新读取的远端变化。[R2、R7、R9]

当前 CacheStore 的展示缓存能报告 unsupportedSchema 或 corruptPayload，但安全元数据的 readMetadata 仍以 try? 返回 nil，pendingPlanReceipts 再把 nil 转为空数组。因此“账目为空”和“账目无法读取”仍可能混淆。此项是代码路径风险，不是已复现的数据丢失结论。[R3]

现有预览确认在同一进程、有效期内保留 committed 结果，可以避免部分丢回包重试增加 revision；预览本身是内存状态，15 分钟过期，服务器重启后不具备持久操作查询能力。CAS 防覆盖不等于完整的写操作幂等。[R8]

## 3 当前架构与真实数据流

### 3.1 服务端权威数据

生产配置下，MobileGoalsStore 把目标、当前课表、教练配置、历史和系统排期回执保存在控制库。goals 写入与历史追加在 SQLite 事务中执行，以 expectedRevision 做比较并交换，即 CAS。文件实现仍作为未传控制库路径时的兼容路径存在；不能把生产目标存储描述成纯 JSON 文件。[R7]

run-coach 的 start、update、refresh、pause、resume 和 end 命令最终写回同一个 goals 结构。手工编辑、规则生成后的 preview confirm 也进入 MobileGoalsStore.write。active 或 paused 的教练计划拒绝手工接管；结束后的显式手工保存或确认可清除教练管理状态。[R7、R8、R10]

有效处方不是 weekPlan 的原样回传。今天的安排使用恢复闸门、锁课与完成状态；未来安排还受预算、比赛政策与分区约束。mobileTodayWithExecutablePlan 同时产生 today 和 effective，并被两个读接口分别调用。[R9]

### 3.2 iOS 已建立的保护

NativeAppModel 在业务写成功后调用 acknowledgePlanWrite，先提高水位、失效旧执行读取并尝试持久化，再读取依赖接口。水位与展示缓存分离，清缓存或淘汰缓存不会使已确认版本回退。[R2、R3]

PlanSyncSnapshot 不只包含 revision，还包含 scope、配置身份、有效 days、时区、提醒小时、完成日期、本地日期、窗口与租约。两个页面共用 PlanWatchSyncCoordinator，SDK 等待前后重验租约；失效后只撤回本操作提交的条目，并串行等待 cleanup 结束。[R4、R5]

WorkoutKitBridge 是唯一 SDK 边界。执行导出要求保留必要步骤、剂量和目标；不支持时拒绝整日。回读必须同时匹配 UUID、规范化时刻、localDate、内容与未完成状态。只为核验成功的日期登记回执，部分成功不冒充全覆盖。[R5、R6]

### 3.3 现有时间范围

| 读模型 | 实际范围 | 建议界面或内部名称 |
| --- | --- | --- |
| run-coach | 计划配置与状态，周期阶段及派生摘要 | programmeSummary |
| today.weekPlan | 当前自然周，周一至周日 | calendarWeekPlan |
| workout-plan | 今天到第 6 天，默认七日闭区间 | rollingExecutionWindow |
| goals.weekPlan | 已保存的逐日安排，可能跨自然周 | storedPlannedDays |

生成预览也是从今天开始的滚动七日，不应因内部存在 weekly 命名就当成自然周。服务端当前业务时区为 Asia/Shanghai；本轮不改成随设备所在地自动改变的计划时区。[R8、R9、R11]

## 4 明确计划身份与版本语义

### 4.1 避免把不同版本概念合并

goals.revision 当前代表该 scope 下目标与计划聚合的持久写版本，修改目标、锁课或教练状态都可能提高它；workout-plan.planRevision 回传的也是这一版本。教练 plan.id 表示一个训练周期的身份，新建周期换 id，刷新或暂停不换 id。WorkoutPlan.id 是本次系统排期条目的 UUID，不是教练计划 id。[R2、R6、R7、R10]

today.recommendationRevision 是基于当日决策输入和规则相关输出计算的摘要，用于建议确认等流程。它没有完整表达所有未来训练日的有效结构，不能直接拿来作为整个七日执行窗口的唯一内容版本。[R9]

### 4.2 建议目标模型

| 概念 | 建议含义 | 使用边界 |
| --- | --- | --- |
| PlanScope | 服务地址与 serverId athleteId datasetEpoch | 缓存隔离和服务端身份绑定 |
| goalsRevision | 现有共享 CAS revision 的领域名称 | 单调水位与写冲突，不证明全部事实一致 |
| programmeId | 现有教练 plan.id | 当前可空；手工课表不伪造 id |
| EffectivePlanSnapshot | 同次读取的目标、今日与执行窗口 | 客户端展示和同步的完整聚合 |
| coherenceToken | 服务端签发的事实快照摘要 | 同 goalsRevision 的事实变化也会改变 |
| workoutKey | scope revision localDate prescriptionDigest | 当前一天一课；未来多课才加 sessionId |
| scheduleEntryId | WorkoutPlan UUID 与 scheduledAt | 本次系统副作用和回执身份 |
| operationId | 一次发布或排期操作的稳定键 | 重试查询与中断恢复 |

短期保留 HTTP 字段 revision 和 planRevision，内部采用 goalsRevision 的解释，不做无收益的 wire 重命名。真正需要跨周期历史、多计划并存或多端协作时，再引入统一持久 TrainingPlan 与不可变 PlanRevision；届时仍须保留 goalsRevision 的并发控制职责。

### 4.3 内容摘要规范

coherenceToken 应覆盖服务身份、goalsRevision、固定业务时区、本地日期与窗口、有效处方结构、执行资格、完成状态，以及参与决策的数据发布版本、分区版本和规则版本。generatedAt、请求时间、提示文案与 UI 排序不作为稳定内容版本。

当前 PlanFingerprint 已排除 generatedAt，但编码完整 days，因此理由或标题变化也可能使排期被提示更新。建议分别使用“事实一致性摘要”和“执行内容摘要”：前者用于聚合是否一致，后者只描述真正改变排期的语义字段。摘要采用确定的键排序、数组顺序、数值单位与 null 规则，TS 和 Swift 共享测试样例；不要各自哈希任意 JSON。[R4]

### 4.4 生命周期只映射真实业务

教练继续使用 active、paused、ended。周期日期已过可派生为“周期已结束”，不能展示为比赛完成或目标达成。preview 属于候选操作状态，不应塞进已发布计划 status；“服务端已保存待刷新”属于客户端读取状态，不能误当发布失败。

暂停或结束改变服务端安排，但不等于系统旧排期已经撤回。界面必须持续提供撤回入口并说明两者关系；本方案不自动修改系统排期。[R10、R11]

## 5 建立一致读取与单一状态所有权

### 5.1 优先新增聚合读取而非堆叠重试

建议新增具备能力协商的 GET /v1/mobile/training-plan-state，返回 metadata、goals、today、workoutPlan 和可选 coachSummary。metadata 至少包括 contractVersion、serverId、athleteId、datasetEpoch、goalsRevision、coherenceToken、timezone、localDate、windowStart 与 windowEnd。返回无教练计划不等于没有手工执行处方，应使用独立 availability 说明领域是否为空。

新协议要求 iOS 显式解码窗口边界，核对真实日期、连续且唯一的 days、windowDays 与闭区间长度；当前 Swift workout-plan DTO 尚未接收服务端已有的 windowStart 和 windowEnd。旧协议保留兼容解码，新协议缺少这些安全字段则拒绝执行，不用本机日期猜测补齐。[R9、R12]

服务端应一次计算 today 与 effective，并从同一批输入派生 coachSummary。沿用现有 mobileTodayWithExecutablePlan 的能力，通过明确的服务方法输出聚合，不复制处方公式。[R9]

控制库和健康主库是两个存储域，不能承诺“开两个 SQLite 事务即可原子快照”。实现应固定主库读取视图，采集控制库版本与数据发布身份，在构建前后核对 goalsRevision、datasetEpoch 及实际参与决策的发布版本。若期间变化则丢弃整组结果，有限重建后返回明确可重试错误。快照令牌必须描述真实冻结的输入，不能只哈希最终响应掩盖混合读取。

读取聚合不应顺便 POST refresh 或增加 revision。教练适应仍走现有显式命令链路，避免把只读端点变成隐式写操作。

### 5.2 旧服务兼容

在 handshake 增加独立的 planSnapshotContractVersion 能力位。只有服务端声明支持时，新客户端才调用聚合接口；缺省继续调用原三个 GET，并保留现有全部水位与租约保护。

旧协议最多先采用“一轮读取失败后最多两轮重读”的可配置前台策略，取消、身份变化或新 mutation 立即结束。该策略改善瞬态失败，但不能证明三个响应来自同一事实快照。旧协议下不宣传强事实一致性；高风险执行场景若必须具备该保证，应要求升级服务端，而不是降低校验。

### 5.3 从 AppModel 抽取计划 Store

建议在现有 MainActor 上引入 TrainingPlanStore，接管计划状态、写回执水位、刷新编排、请求失效和展示聚合。TrainingPlanRepository 负责网络与缓存 IO，返回完整领域结果；Store 决定结果是否可接纳。NativeAppModel 保留全局会话与其它业务，先作为旧调用点的转发门面。

不再增加一份完整镜像 AppModel 的 RunCoachViewModel。页面只有编辑草稿、sheet、选择日期等局部 UI 状态；多组件共用一个只读计划快照。

### 5.4 状态与错误分别表达

| 领域读取状态 | 展示要求 | 默认执行策略 |
| --- | --- | --- |
| empty | 服务端完整快照明确没有计划，不显示错误 | 不导出；保留旧排期管理 |
| loading 或 refreshing | 首次加载或正在确认新快照 | 未完成校验前不导出 |
| ready | 完整身份、日期、版本与内容通过校验 | 仍须通过平台支持与授权检查 |
| cached | 标明缓存时间，允许查看历史参照 | 不默认授权新的离线排期 |
| savedAwaitingRefresh | 业务已保存，依赖读取尚未成功 | 不重复发布，不执行旧处方 |
| inconsistent 或 failed | 给出版本冲突、网络、解码或存储原因 | fail closed，允许明确重试 |

旧 coherent 数据可以用于显式“上次安排”参照，但不得混入当前执行快照。展示状态和错误原因分开存储，避免新增十几种互斥 enum 来表达所有组合。

## 6 完善系统排期与中断恢复

### 6.1 保留现有核验边界

Apple 提供 schedule、scheduledWorkouts、remove 和 removeAllWorkouts 等排期接口，并单独提供 isSupported、authorizationState 与容量查询。官方说明排期可同步到 Apple Watch；本项目的 scheduledWorkouts 强匹配仍只证明调用端读到了相应系统日程，不据此宣称真实手表已可见。[A1–A3、R6]

现有执行路径的 UUID、精确时刻、内容、未完成状态与逐日覆盖检查应作为不可退化的不变量保留。不要为提高成功率放宽成只比日期、只比内容或只看 schedule 调用返回。容量从 SDK 读取，不写死数字。[R5、R6]

### 6.2 增加排期操作写前日志

现在 ledger 在整次调度返回后由 recordWatchResult 写入，submittedEntries 主要在内存中记录。若系统调用产生副作用后进程终止，串行器与取消 cleanup 不会继续运行，重启的 unknown 状态也不能完整描述本次意图。[R2、R5]

建议新增 app 级 PlanScheduleOperationJournal，而不是把它放进可淘汰展示缓存。日志至少记录 operationId、scope、goalsRevision、coherenceToken、目标窗口、提醒时刻、目标 UUID 与 scheduledAt、处方摘要、清理或提交阶段、逐项结果及 updatedAt。

1. 用户点击同步后获取完整快照并预检全部候选训练，生成本操作 UUID。
2. 在 removeAll 或第一条 schedule 之前写入操作意图。日志写失败则不启动新的破坏性副作用。
3. 每条 schedule 调用前持久化“待提交”，调用后持久化“调用已返回”。调用返回不等于核验成功。
4. 强回读后写入实际确认集合，并将最终 ledger 与待登记回执尽可能在同一本地事务中提交。
5. 若操作失效，记录撤回意图，只处理本操作条目。撤回读回未确认时保留 withdrawalRequired，不清账。
6. 前台重启读取未结束操作，先呈现“排期操作中断，需重新核验”，由用户选择核验或撤回，不直接恢复为成功。

恢复不能依赖旧的内存 plans 字典。应扩展 SDK adapter 的日程清单与按 UUID 和时刻定向删除能力，使用系统返回的真实 WorkoutPlan 操作；不要拿新版服务端处方重建旧条目后猜测删除。日志不保存 token、健康原始样本；必要处方数据按最小化和文件保护策略保存。

### 6.3 预检失败时不先删旧课表

当前流程完成 mapper 与 SDK 预检后仍会 removeAll，再下发通过预检的部分训练。出现“目标本来就有不可导出的训练”时，旧课表仍可能先被清空，最终只能得到部分覆盖。[R5]

建议默认采用全量替换预检：有任何 owed 训练因容量、必要目标或剂量失败时，不执行破坏性替换，先展示失败日期。若产品希望保留“仅同步可导出的训练”，必须让用户明确选择并确认覆盖影响；运行期部分成功仍按实际确认集合报告，不包装成全成功。

removeAll 保留为显式“撤回 RAI 全部系统旧排期”的操作，其范围是本 app 在系统中的日程。普通更新在写前日志与定向删除能力完善后可考虑按 UUID 差量替换；不能把删除其它 scope 的旧排期隐藏在常规刷新中。

### 6.4 分离排期状态与服务端登记状态

排期状态使用 prepared、clearing、scheduling、verifying、verified、partial、withdrawalRequired、withdrawn 或 interrupted 描述。服务端登记单独使用 pending、registered、failed。展示只暴露用户需要理解的几个状态，不必把全部内部阶段铺到页面。

同一回执 POST 失败不推翻已经核验的本地系统日程；服务端记录成功也不能把已撤回的日程继续解释成当前覆盖。撤回与替换应记录后续事件或状态，而非删除历史回执。任何历史执行关联都需要考虑回执有效时间和被替换状态。

### 6.5 读回延迟与远端变化

现有一次读回是保守策略。先测量真机读回延迟，再决定是否加入总时长和次数受限、可取消的重读。等待期间必须重验完整快照与租约；超时返回未核验，不猜测成功。[R5、R11]

没有远端租约或实时推送时，客户端不能保证排期期间另一客户端完全不改计划。建议调度前读取最新快照，回执登记时携带 coherenceToken，由服务端分别记录历史核验事实与“是否仍匹配当前快照”。过期回执不升级为当前覆盖，并提示撤回或更新。若业务要求阻止并发编辑，另行设计有期限的服务端执行租约，不在本轮隐含承诺分布式事务。

## 7 完善发布与回执协议

### 7.1 两条创建交互共享发布规则

教练命令和手工 preview confirm 已共用存储与 CAS，应先抽取共同的 PlanPublicationService，负责 scope 检查、CAS、有效日期保护、规范结构验证、历史追加和写操作结果记录。不同生成器仍负责不同输入与策略，不强行把教练命令改造成预览交互。[R7、R8、R10]

手工取消预览不写入，教练 paused 或 active 禁止手工接管，已训练日、锁课日与迁移保护日继续保持现有规则。generationMode 可以表达 coach 或 manual；现有 source 的 heuristic 或 llm 是生成来源，不是同一维度，不应被覆盖成 coach 或 manual。

### 7.2 业务写操作处理丢回包

建议对 coach command、preview confirm 和其它需要安全重试的发布操作增加 operationId。服务端在同一控制库事务中提交“业务修改、历史与操作结果”；同一键同一请求返回第一次结果，同一键不同请求拒绝。客户端只重试原操作，不提高 expectedRevision 拼成一个新写。

增加操作结果查询，或让同键重试可返回已提交结果。超时或断网时显示“结果尚未确认”，先查询原操作；CAS 409 要区分新冲突与原操作已成功，不把所有 409 都当成重新编辑的理由。已收到成功但本地持久化失败时，只恢复确认记录和刷新，不重复业务发布。

操作键绑定服务端身份与 datasetEpoch，跨数据集不重放。定期清理须有可说明的保留期限；过期键返回不可确定或已过期，不能重新执行原副作用。

### 7.3 回执新增字段采用新能力版本

现有 planReceiptMetadata=true 仅允许当前已实现的 workoutID、scheduledAt、idempotencyKey 和 exportNotes。新增 operationId、coherenceToken、verifiedAt、timezone 或 lifecycleEvent 时，必须升级独立能力版本，不能沿用旧布尔能力盲发未知字段；当前 schema 的 additionalProperties=false 会拒绝它们。[R6、R7、R12]

建议新回执契约要求 localDate、kind、goalsRevision、scheduleEntryId、scheduledAt、verifiedAt、timezone、实际 exportedStructure、prescriptionDigest 和 operationId。programmeId 保持可选，不要求所有手工计划突然具有 id。

verifiedAt 是客户端本次观察时间；recordedAt 是服务端接收时间，两者不能互换。系统未暴露可用的稳定 Watch 身份时，不编造 deviceId。确需区分安装实例时可增加匿名 installationId，但它不能被称为物理手表标识。

### 7.4 服务端接纳与旧协议降级

服务端检查真实日期、时刻与时区的一致性、规范结构和身份范围。旧 revision 的真实历史回执可以登记为历史，但不能冒充当前计划完成度；同 UUID 同时刻重复登记幂等，同键不同实际导出内容返回稳定错误码。客户端提交的核验事实不是服务端直接观察系统 SDK 的证据。

兼容旧客户端四字段回执，明确标记为 legacy 信息完整度，不反填虚构 UUID 或核验时间。新客户端连接旧服务仍发送旧字段，继续提示旧服务没有新增字段和幂等保证。不得为兼容把新的执行安全字段都改成 Optional。

## 8 缓存错误与可观测性

### 8.1 分开处理可丢弃数据与安全记录

展示缓存可以在 schema 不兼容时失效并联网重建。revision 水位、操作日志、撤回风险与待登记账目不是普通缓存，清缓存和容量淘汰必须继续保留。当前这一区分已经落地，下一阶段应统一读写结果类型与原子提交边界。[R3]

网络 DTO、缓存 envelope 与领域模型可以分层，但不要求第一步把所有 Codable 响应复制成三套结构。先为计划聚合、执行规格和操作日志建立稳定 envelope，包含 schemaVersion、scope、保存时间与内容摘要；新增字段按“安全字段必需、展示字段可缺省”区分。

当前 schema 1 与 2 使用相同 DTO 形状，只说明封装版本兼容，不证明任意历史协议可迁移。未来 schema 3 若改变安全语义，应显式迁移或拒绝执行并刷新，而非猜测默认值。

### 8.2 读取结果不能只有 nil

建议 CacheReadResult 区分 value、notFound、unsupportedSchema、corruptPayload 与 storageUnavailable。网络结果区分 offline、timeout、unauthorized、contractMismatch、revisionConflict 和 serverUnavailable，并附可重试性。

安全元数据损坏不能当作无记录；待登记账目损坏不能被 ?? [] 覆盖后再写空。先隔离损坏条目、标记风险并提示恢复，保留可用于诊断的脱敏原因。存储完全不可用时阻止新的排期替换，并明确无法保证跨重启恢复。

### 8.3 诊断事件与隐私

记录 operationId、脱敏 scope 摘要、请求类型、版本接纳或拒绝原因、阶段耗时、owed 与 confirmed 数量、错误码和回读重试次数。可观测事件包括 revision_mismatch、snapshot_changed、cache_decode_failed、schedule_readback_mismatch、withdrawal_unverified 和 receipt_retry_failed。

不记录 API token、Apple Health 原始 payload、路线或完整生理读数。需要关联设备测试时由用户主动导出脱敏诊断包，不在本轮新增远端遥测服务。先统计事实快照失败率、未核验比例和撤回失败情况，再决定性能或自动化投入。

### 8.4 规范训练结构与执行映射

沿用 MobileSessionStructure 作为服务端规范结构，明确距离用米、时长用秒、配速用秒每公里、心率用每分钟次数，目标和剂量由服务端验证。不要另造一套与现有结构并行的 Canonical Workout Specification 或在 Swift 重算强度区间。

建议 mapper 返回带原因码的 MappingResult，区分 exact、normalized 和 unsupported，并携带实际 exportedStructure 与逐步差异。normalized 仅允许不改变目标数值集合的上下界排序；必要步骤丢弃、次数截断、剂量钳制、单侧心率丢弃或阈值猜测都不能成为可执行结果。展示层可以解释异常数据，但不能将宽容展示映射直接交给 scheduler。

## 9 分阶段实施与变更范围

以下工期是便于拆分评审的粗略开发量，不含等待真机、跨角色评审或发布安排，不作为交付承诺。每个阶段合并前必须独立满足验收，不能用最终大重构掩盖中间的安全退化。

| 工作包 | 优先级 | 粗估开发量 | 前置条件 |
| --- | --- | --- | --- |
| PR0 当前基线审查和设备验证 | P0 | 1 至 2 人日加设备时间 | 当前工作区先锁定 |
| PR1 完整读取结果与快照契约 | P0 | 3 至 5 人日 | PR0，事实发布身份定义 |
| PR2 操作写前日志与前台恢复 | P0 | 3 至 5 人日 | PR0，可独立推进 |
| PR3 计划 Store 与 Repository | P1 | 2 至 4 人日 | PR1，既有语义回归保留 |
| PR4 发布幂等与回执生命周期 | P1 | 3 至 5 人日 | PR1 与 PR2 的身份契约 |
| PR5 持久计划实体演进 | P2 | 单独评估 | 历史或多端需求被确认 |

### 9.1 PR0 冻结现有改造

审查已有水位、schema、协调器、mapper 严格导出、回执与页面拆分，完成当前工作区评审或提交，再开始下一批设计。取得配对 iPhone 与 Apple Watch 的 UUID、时间、读回延迟和实际可见证据。未取得设备证据前不标记“手表交付已验收”。

### 9.2 PR1 一致快照与分类错误

主要范围是 API data 与路由、共享契约、iOS APIModels APIClient 和计划读取。验收包括同 revision 下恢复或分区变化令牌改变、同组结果不混合事实、真实空计划可识别、取消不覆盖新状态、新旧服务能力协商正确。

### 9.3 PR2 排期恢复

主要范围是 PlanWatchScheduling、WorkoutKitBridge、CacheStore 和协调器。所有破坏性操作前必须有持久意图；每个注入终止点重启后可核验或撤回；预检失败默认不清空旧日程；恢复必须覆盖无计划、已结束和离线情况。

### 9.4 PR3 状态所有权

在新增 TrainingPlanStore 与 Repository 后，NativeAppModel 逐步转发旧接口。验收不是文件变短，而是计划状态只有一个写入所有者、水位规则只有一份、两页只读取已校验聚合、测试不依赖 AppModel 里其它统计业务。

### 9.5 PR4 持久操作结果

主要范围是控制库操作结果表、发布服务、回执事件和 capability。验收包括服务端重启后的同键重试、已成功响应丢失、同键不同请求、撤回后历史保留及过期回执不计当前覆盖。旧客户端仍能使用原接口。

### 9.6 PR5 条件性领域迁移

只有需要完整周期历史、同时存在多个计划或多端课表编辑时，才设计 TrainingPlan、不可变 PlanRevision 和日内 sessionId。迁移应保留旧 revision、历史回执和实际导出结构，不能先清库再重建，也不能从 current weekPlan 推造缺失历史。

## 10 自动化验收与设备发布门槛

### 10.1 必须新增或保留的测试

| 测试域 | 核心场景 | 通过判据 |
| --- | --- | --- |
| 一致快照 | revision 相同但恢复、分区、导入或模型改变 | 旧聚合不进入当前执行；令牌变化可测 |
| 并发接纳 | 旧 GET 晚到、换服务或换数据集、连续 mutation | 不回退水位，不跨 scope 接纳 |
| 写操作重试 | 写成功丢回包、服务重启、同键不同请求 | 原结果可查询，不产生第二次发布 |
| 缓存与元数据 | schema 旧新未知、payload 损坏、SQLite 不可用 | 错误分类明确，风险账目不当空记录 |
| 中断恢复 | 清空后、任一 schedule 后、读回后或 POST 中终止 | 重启进入待核验，不默认成功 |
| 预检替换 | 必需目标不支持、剂量变化、容量不足 | 默认不删旧日程；部分更新需显式确认 |
| 强回读 | 错 UUID、错时刻、错内容、已完成、UTC 规范化 | 仅强匹配日可登记，owed 为覆盖分母 |
| 生命周期 | 暂停结束、无计划、离线、撤回失败与替换 | 保留管理入口和撤回风险，历史不被重写 |
| 时间边界 | 周日周一、跨月跨年、午夜及设备旅行 | 按服务端时区归属，七日闭区间一致 |
| 映射协议 | 单侧心率、异常配速、未知 enum、小数剂量 | 拒绝改变强度或剂量的执行导出 |

若以后支持不同业务时区，再加入夏令时跳过和重复时刻的计划协议测试。当前固定 Asia/Shanghai，不把 DST 写成现有服务端必需业务行为；SDK 时区规范化仍需真机核对。

### 10.2 执行入口

普通 API 与 iOS 改动使用 `npm run typecheck`、`npm test`、`npm run test:ios`；改文档时另跑 `npm run check:docs`、`npm run check:doc-refs`、`npm run check:acceptance-matrix`、`npm run check:scripts`。iOS 聚合门禁必须在有 Xcode 的主机执行，显式 skip 不计通过。完整 `RAI.xcworkspace` 构建另外覆盖高德 SDK 依赖文件，且只在本机 macOS 手工执行。

🔴 **D17 之后没有 Web 入口**：原文的 `npm run build`、`npm run test:e2e:web`、`test:e2e:responsive`、full `test:e2e` 已随 Web/macOS 退役**删除**（[DECISIONS](DECISIONS.md) D17）。它们不是"本轮不运行"，而是不再存在；本节保留原文的位置是为了记录当时的判断，不要照做、也不要把脚本加回 `package.json`。模拟器视觉验收仍走现有手工入口（`apps/ios/tests/run-visual-tests.sh`）并使用隔离数据库，不修改真实健康数据。[R1、R13]

保留反向验证：删掉水位、只比租约 ID、忽略 UUID、以 pending 为覆盖分母或把清空当成功的代码突变，都必须先编译成功再被指定行为断言拒绝。新增写前日志同样需要“日志未写先产生副作用”的突变测试。

### 10.3 本次重新执行的检查

> ⏱ **时点记录（2026-10-09）**：以下数字只对那一天成立。当前口径（2026-10-18，对齐提交 `09ed8d0`）以命令输出为准：`npm run test:ios` = **94 份源码类型检查 + 3 个仅依赖高德 SDK 的文件跳过、106 项 store 回归、200 项展示检查**；Node 侧以 `npm test` 输出为准。

本次仅重写方案，没有修改运行代码。定向 API 四文件共 41 项，全部通过，0 失败、0 跳过。npm run test:ios 已通过：84 份 iOS 源码通过真实 SDK 类型检查（**历史数字，现为 94 份**），排期回归 49 项、生产存储回归 82 项（**历史**，现为 106 项）、展示回归 200 项通过，模型与其余纯逻辑门禁也通过。3 个依赖高德 SDK 的文件不在这一类型检查通道内。workspace 构建、Simulator UI 与配对手表验收不在本次重新执行范围内；**完整 Web 已随 D17 删除，不再有"未重跑"一说**。

既有实施记录包含完整 TypeScript、Web 构建（**历史项，D17 后该构建不存在**）和 Simulator 检查，属于当时工作区的验证证据，不等同于本次重新执行；其 manifest 明确将配对物理手表验收标记为 pending。[R14]

### 10.4 真机放行条件

- 配对 iPhone 与 Apple Watch：UUID 与规范化时刻稳定，真实表端日程可见，部分成功及撤回可复现。
- 授权 notDetermined、denied 和 restricted：按钮与文案正确，恢复入口按实际系统确认，不默认建议重装或重置隐私。
- 调度等待、读回和回执登记时改变计划、提醒小时或跨午夜：旧结果不得显示成功；清理失败持续可见。
- 强制终止、重启、服务端更新与新旧版本组合：无重复发布、无错误成功提示，操作账目可恢复。

这些证据证明设备流程，不证明训练效果、比赛达标或后台执行保证。任何未执行项继续列为待验收，不能由 fake scheduler 或 Simulator 测试替代。

## 11 升级回滚与需要确认的产品决定

### 11.1 升级与回滚

按“服务端先增加新能力且继续支持旧协议，客户端再按能力使用新路径”的顺序错峰上线。新路径可按能力或功能开关回退到旧读取，但回退不降低 revision 水位、不删 operation journal、ledger 或待登记账目。

服务器回退旧版本时保留新增表和历史数据，停止新功能写入即可；不要让 schema rollback 擦除已确认的副作用。客户端不能解析更高版本安全日志时，保持待核验并允许显式恢复，不把它当作不存在。

发布前备份控制库并演练迁移与恢复，不在真实健康主库上直接验证故障注入。若计划副作用无法恢复或撤回，暂停新的替换操作，但继续提供诊断和显式旧排期管理。

### 11.2 必须明确的产品选择

1. 预检有不可导出日时，默认整体不替换；是否提供显式“仅下发可导出日”，以及覆盖提示形式。
2. 旧服务不支持事实快照时，哪些操作仍允许，哪些高保证执行操作要求升级。
3. 客户端只读缓存的可见期限与文案；本方案不默认允许离线新排期。
4. 调度中断后是先核验还是先撤回；两者都由用户前台确认，不增加新后台机制。
5. 发布操作幂等键和回执事件的保留期限；是否确实需要匿名安装实例身份。
6. 什么真实需求触发统一持久 planId；没有需求时不让这一迁移阻塞 P0。

最终建议是先把“哪一份事实生成了当前可执行处方”讲清，再保证“已产生的系统副作用在中断后仍可追踪”。现有 CAS、水位、强回读与页面拆分继续保留，后续每一批变更都以可验证的不变量为验收标准。

## 12 证据索引

以下位置对应 2026年10月9日检查时的工作区。后续代码移动后应以符号名核对，行号仅作为本次定位。

### 12.1 原文与代码

R0 原始设计评审。文件：/Users/ta/Documents/iOS训练计划功能_架构设计不足与改进建议.docx。十项不足、目标架构与原优先级。

R1 开发范围和测试约束。文件：/Users/ta/running/AGENTS.md。原生范围、HealthKit 权限、冻结 Web 范围及验证入口。

R2 iOS 状态与写入接纳。文件：/Users/ta/running/apps/ios/RAI/NativeAppModel.swift。refreshPlanState 第 1145 行；acknowledgePlanWrite 第 1222 行；planPresentation 第 1241 行；planSyncSnapshot 第 1269 行；回执登记第 1297 行；ledger 保存第 1344 行。

R3 缓存与安全记录。文件：/Users/ta/running/apps/ios/RAI/CacheStore.swift。独立水位表第 47 行；schema 检查第 79 行起；确认事务第 155 行；pendingPlanReceipts 第 206 行；readMetadata 第 221 行；scope 第 264 行。

R4 计划领域状态与串行器。文件：/Users/ta/running/apps/ios/RAI/PlanStatePolicy.swift，以及 /Users/ta/running/apps/ios/RAI/PlanWatchSyncCoordinator.swift。六类 availability、完整 snapshot、ledger fingerprint 和跨页面串行 cleanup。

R5 排期与强匹配。文件：/Users/ta/running/apps/ios/RAI/PlanWatchScheduling.swift，以及 /Users/ta/running/apps/ios/RAI/PlanReceiptMatcher.swift。预检第 176 行起；清空第 191 行；最终读回第 214 行；覆盖第 233 行；定向撤回第 239 行起。

R6 SDK 与执行映射。文件：/Users/ta/running/apps/ios/RAI/WorkoutKitBridge.swift，以及 /Users/ta/running/apps/ios/RAI/WorkoutPlanMapper.swift。唯一 SDK 边界、容量、强内容回读；safeExportedStructure 第 263 行。

R7 控制库与回执。文件：/Users/ta/running/apps/api/src/mobile-goals.ts，以及 /Users/ta/running/apps/api/src/server.ts。共享 revision、生产控制库、事务 CAS、recordPlanPush 第 372 行、synced 路由第 1129 行起及现有 preview confirm。

R8 规则预览与日期窗口。文件：/Users/ta/running/apps/api/src/weekly-plan-preview.ts，以及 /Users/ta/running/apps/api/src/weekly-plan-service.ts。8 个内存预览上限、15 分钟有效期、进程内 committed、滚动日期与合并规则。

R9 有效处方生成。文件：/Users/ta/running/apps/api/src/data.ts，以及 /Users/ta/running/apps/api/src/mobile-read.ts。mobileTodayWithExecutablePlan 第 359 行；recommendationRevision 第 601 行；mobileWorkoutPlan 第 656 行；默认七日第 503 行、窗口响应第 566 行。

R10 教练命令。文件：/Users/ta/running/apps/api/src/run-coach.ts。响应构建第 270 行；路由第 306 行起；周期身份、状态转换、幂等 refresh 与同一存储发布。

R11 现有契约与设备边界。文件：/Users/ta/running/docs/IOS_NATIVE_API_CONTRACT.md、/Users/ta/running/docs/RUN_COACH.md，以及 /Users/ta/running/docs/IOS_NATIVE_RUNBOOK.md。

R12 共享与 Swift DTO 及回执 schema。文件：/Users/ta/running/packages/api-contracts/src/index.ts、/Users/ta/running/apps/ios/RAI/APIModels.swift，以及 /Users/ta/running/apps/api/src/schemas.ts。回执 schema 第 285 行起，未知字段拒绝；Swift 暂未接收 windowStart windowEnd。

R13 门禁与针对性测试。文件：/Users/ta/running/package.json、/Users/ta/running/apps/ios/tests/run-ios-gates.sh、/Users/ta/running/apps/ios/tests/PlanWatchSchedulingRegression.swift、/Users/ta/running/apps/ios/tests/StoreRegression.swift，以及 /Users/ta/running/apps/api/test/mobile-plan-sync.test.ts。

R14 既有实施与验证记录。文件：/Users/ta/running/docs/IOS_TRAINING_PLAN_IMPLEMENTATION.md。原始记录目录：/Users/ta/running/var/reports/ios-training-plan-implementation-2026-10-09/。manifest 指定 physical Watch 待验收。

R15 页面体量复核。文件：/Users/ta/running/apps/ios/RAI/Skins/Technology/TechRunCoachView.swift。HEAD 为 1386 行，当前工作区 307 行。NativeAppModel 当前 1565 行；上述数值只说明职责与体量，不构成性能结论。

R16 本次检查日志。文件：/Users/ta/running/output/ios-training-plan-review-20261009/current-api-tests.log，以及 /Users/ta/running/output/ios-training-plan-review-20261009/current-ios-gates.log。只对应第 10.3 节列出的本次重新执行范围。

### 12.2 Apple 官方资料

A1 Apple Developer 的 WorkoutScheduler 文档。核对授权、支持性、系统排期清单、删除及 SDK 容量接口。资料链接由 Word 文档提供。

A2 Apple Developer WWDC23 的 Build custom workouts with WorkoutKit。核对授权后向系统排期以及 Apple Watch 日程同步的官方说明。

A3 Apple Developer 的 scheduledWorkouts 文档。其定义为应用当前安排的训练集合；本文不将这一定义扩展为物理手表交付确认。
