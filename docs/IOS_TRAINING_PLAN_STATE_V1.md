# 训练计划事实快照、发布操作与排期恢复

实施日期：2026-10-09（Asia/Shanghai）。从干净的 `31c85b9` 基线实施本轮方案，不重做已有水位、CAS、强回读和页面拆分。本文补充 `IOS_TRAINING_PLAN_IMPLEMENTATION.md`，不是物理 Apple Watch 验收证明。

## 实施范围与产品选择

- PR0：核对已有门禁与设备边界；不自动提交代码。物理配对设备验收仍是发布前置条件。
- PR1：新增只读聚合端点、能力协商、闭区间窗口验证和分类读取错误。
- PR2：app 级写前日志、逐项提交阶段、定向撤回与前台中断恢复；预检任一必需训练失败时整体不替换。暂不提供“仅同步可导出日”开关。
- PR3：`TrainingPlanStore` 独占计划聚合、水位、接纳规则和读取状态；`TrainingPlanRepository` 封装网络/缓存 IO，`CacheStore` 执行持久化；`NativeAppModel` 是现有页面和全局业务的门面。
- PR4：控制库同事务保存发布操作结果、业务与历史；回执版本 2 保存核验事实及后续撤回/替换事件。
- PR5：完成迁移条件评估，暂不创建 `TrainingPlan` / 不可变 `PlanRevision` / `sessionId` 表。尚无已确认的多计划并存、完整周期历史或多端课表编辑需求，按方案不得为命名迁移或推造缺失历史。

旧服务仍可使用原读取和既有版本/租约保护，并明确提示它没有强事实快照保证；不宣称三次 GET 是同一事实。展示缓存不设新 TTL，仅作上次结果参照；不能授权离线新排期。中断核验与撤回、登记重试、发布查询全部由前台用户操作触发，不新增后台机制。

手工、赛事和教练编辑草稿同时绑定打开时的连接会话与 revision；同号 revision 不允许跨连接提交。教练暂停/恢复/结束确认使用打开确认时的 revision。展示标题或理由变化不改变执行指纹/租约；实际结构、执行资格、事实令牌、时区、完成状态或提醒时刻变化仍使租约失效。

## 读取契约

`handshake.planSnapshotContractVersion = 1` 时调用 `GET /v1/mobile/training-plan-state`，返回：

- `metadata`：契约、服务/运动员/数据集身份、`goalsRevision`、`coherenceToken`、固定 `Asia/Shanghai` 时区、当天、闭区间窗口、规则版本与参与决策的发布摘要。
- `goals`、`today`、`workoutPlan`、`coachSummary`：同一冻结主库视图派生。今日与有效窗口只计算一次，教练摘要复用其准备度和输入。
- `availability`：`ready` 或 `empty`。无教练配置不表示没有手工处方；完整休息窗口与网络/解码错误分开。

主库使用一个固定 SQLite 读取视图。摘要包含实际读取的导入、模型、分区发布行及恢复证据摘要；不把任意响应 JSON 当作输入身份。构建前后核验控制库目标/历史、主库 `data_version`、文件发布身份、服务数据集身份和业务日期。发生变化丢弃整个候选，最多重建三次，返回 `503 plan_snapshot_changed`。这不是两个数据库的分布式事务，也不阻止另一客户端在核验完成之后编辑。

新客户端验证完整身份、所有版本一致、时区、真实日期、逐日唯一且连续、窗口长度和首末日期；缺安全字段或不支持更高能力版本时拒绝执行，不降级猜测。

旧服务最多增加两轮前台重读。成功的独立目标读取可以保留编辑上下文，部分执行读取只能作为参照，不能拼成当前可执行聚合。取消、mutation、换连接或数据域使整轮接纳失效。

## 两种摘要

`coherenceToken` 表示冻结输入的事实一致性；它会在 goals revision 不变但恢复、导入、模型、分区或完成事实变化时改变。

执行内容摘要使用 `rai-prescription-v1`：按固定顺序串联训练类型、warmup、block 数量、iterations、step 数量和各 step 的 purpose、goal 类型/剂量、alert 类型/上下界、cooldown，以 `|` 分隔；null 为 `~`，数值使用六位小数的 POSIX 表示，距离为米、时长为秒、配速为秒/公里、心率为次/分钟。哈希为 UTF-8 的 SHA-256。字段枚举不允许分隔符；结构顺序不能重排。

`apps/ios/tests/fixtures/prescription-digests.json` 由 TS 与 Swift 测试共同读取。排期指纹不包含标题、理由、来源或 generatedAt；目标/剂量变化仍使指纹变化。执行 mapper 返回 `exact` / `normalized` / `unsupported` 和原因码。仅允许上下界排序，不允许步骤删减、剂量钳制、次数截断或单侧目标猜测。

## 发布操作

`handshake.planPublicationContractVersion = 1` 时，coach command、preview confirm、goals 保存和 lock 接受 UUID `operationId`，并要求 `operationScope` 声明原 serverId、athleteId 和 datasetEpoch。客户端先持久化原请求和身份，再提交；即使原意图从未到达服务端，也不能在更换数据集之后被执行。未确认结果阻止新的发布；查询原操作而不是提高 `expectedRevision`。

`GET /v1/mobile/plan-operations/:id` 返回 `committed`（含原结果）、`notFound`、`scopeMismatch` 或 `expired`。只有明确 `notFound` 才按原键、原字节及原身份重试。coach 和 confirm 同键重试在 CAS 和内存预览检查之前返回原结果；服务重启不再造成第二次发布。未成功发布的候选预览仍是进程内、15 分钟有效，不为未确认预览增加持久生命周期。

业务、历史与操作结果在同一控制库事务提交；任一写入失败全部回滚。同键不同请求返回 `plan_operation_key_conflict`；已知跨数据域键拒绝重放。完整结果保留 90 天；过期键留下摘要墓碑并返回 expired / HTTP 410，不重新执行。没有新增安装实例身份或虚构物理 Watch 标识。

收到业务成功但本地确认失败时保留原操作和独立水位 quarantine；恢复只确认与刷新，不重复业务发布。

## 排期写前日志

`PlanScheduleOperationJournal` 保存在 app 级安全元数据，不随展示缓存清空或淘汰。schema 1 记录 scope、operationId、goals revision、coherence token、身份、时区/窗口/提醒小时、每条 UUID/精确时刻/最小实际处方与摘要、清理目标及逐项阶段。文件沿用设备文件保护；不含 token、路线或原始健康样本。

顺序为：完整快照 → 全量 mapper/SDK/容量预检 → 持久 prepared 意图 → 持久 clearing 意图 → 清理 → 每条持久 submitting → schedule → 持久 returned → 持久 verifying → 强回读 → 日志/ledger/待登记回执原子提交。

日志写失败停止后续 SDK 副作用。调用返回不等于核验；部分、清理失败和存储失败不会被包装成成功。普通替换仅定向删除已知同 scope 的旧 UUID 和时刻，发现未知或其他 scope 的系统条目要求显式管理；`removeAll` 仅用于用户明确选择的全部撤回。

启动读取未结束操作只显示“中断，需核验/撤回”。恢复使用原日志的实际处方比较系统返回内容；定向撤回使用系统清单返回的真实 `WorkoutPlan`，不依赖旧进程内 plans 字典，也不拿新版服务端处方猜测旧条目。恢复可在离线、无计划、暂停/结束时操作；不自动恢复成功状态。与当前完整快照不一致的核验仍提示更新/撤回。

恢复核验与普通同步共用完整系统清单检查：UUID 与精确时刻逐项、消费一次匹配；未知条目、同 UUID 的额外时刻、重复条目或残留旧条目均不能算完整成功。清单异常时保留原 ledger 与未结束日志，不登记新核验回执。合法部分恢复仍保留未结束状态；旧条目已全部消失时，旧 `replaced` 事件与新核验回执、ledger、日志在同一本地事务提交。再次核验部分恢复只能结束原日志的旧替换目标，不能把新条目误记为 replaced。

## 回执版本与生命周期

`handshake.planReceiptContractVersion = 2` 是独立能力，不复用旧 `planReceiptMetadata` 布尔。

版本 2 必需：scope、localDate、kind、revision、workoutID、scheduledAt、verifiedAt、timezone、实际 structure、prescriptionDigest、operationId、coherenceToken 和 lifecycleEvent。`verifiedAt` 是本次客户端观察时间，`recordedAt` 是接收时间。服务端检查真实日期、规范化时刻、范围身份和实际摘要；当前覆盖还必须匹配当前处方与事实令牌。

旧版本真实核验可作为历史接纳，但 `matchesCurrent=false`；服务端登记不代表服务端直接观察 SDK，更不是物理表端交付证据。同 UUID/时刻同事件重复登记幂等，不同导出内容拒绝。`withdrawn` / `replaced` 追加事件，不删除或改写已登记历史；历史执行关联按核验至撤回/替换的有效区间解释。

历史回执重试与当前排期状态隔离：只有 scope、revision、localDate、UUID 与精确 scheduledAt 属于当前 ledger 的核验回执，才能因 `matchesCurrent=false` 或范围冲突将当前排期标为待撤回。UUID 大小写与等价 ISO 时刻表示不改变身份；旧条目登记为历史不会要求撤回已核验的新排期。

旧客户端四字段继续支持并标记 legacy。新客户端连接旧服务剥离新字段，不把生命周期事件伪装成新的 legacy 核验；兼容路径不提供新增保证。

本轮回执和生命周期事件沿用控制库历史的永久保留，不自动按 90 天删除；90 天仅适用于发布操作的完整结果。历史查询的 90 天窗口不等于存储保留期限。以后若增加归档/删除政策，需同时保留执行关联与撤回事件，不能删除墓碑后重放副作用。

## 读取故障、诊断和回滚

显式“全部撤回”还在同一本地事务中结束所有 scope 的待登记核验：旧排队 verified 不能在撤回后补发并重新成为覆盖，版本 2 保留实际结构并转为 withdrawn 事件等待原服务登记。没有 ledger 也不能把待登记账目当作不存在；任何 scope 的损坏账目均不猜测覆盖。

缓存读取结果区分 value、notFound、unsupportedSchema、corruptPayload 和 storageUnavailable。安全账目损坏不能当作空数组并覆盖；更高 schema 日志保持风险状态并阻止新替换。展示缓存可以联网重建，水位、日志、ledger、待登记回执和未确认发布不可被清缓存擦除。

诊断仅保留最多 500 条 operationId、scope 摘要、阶段/版本/数量/错误码事件。用户可从系统日程管理区主动生成并分享本地脱敏 JSON；不上传远端遥测。

按服务端先增能力、客户端后使用上线；回退不得删新增表、墓碑、事件或本地安全账目。发布前备份控制库，并用隔离数据库演练事务失败、重启、迁移/恢复。不可解析的安全账目应从备份恢复或人工诊断，不要删除后重新排期。

## 验证与仍需设备证据

自动入口：`npm run typecheck`、`npm test`、`npm run build`、`npm run test:ios`；定向排期/存储/Store 回归及反向突变门禁在 iOS 聚合入口内。完整 workspace 构建另覆盖高德依赖。没有响应式范围授权，本轮不运行 responsive / full E2E。

仍必须在配对 iPhone + Apple Watch 验证：UUID/时刻稳定、真实表端可见、读回延迟、授权各状态、运行期部分成功、定向/全部撤回、每个副作用后强杀重启、读回/回执期间改计划/提醒或跨午夜，以及新旧服务组合。fake scheduler、真实 SQLite 和 Simulator 编译均不能替代这些发布证据。

## 本轮实际验证记录

下表为首次实现记录；审查修复新增回归的结果见文末。

全部检查在 2026-10-09 的本地工作区运行，日志保存在 `output/ios-training-plan-state-20261009/`（忽略目录，未纳入 Git）。测试和编译不改真实健康数据库，未提交代码。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `npm run typecheck` | 两个 TypeScript 工程均通过 | `typecheck.log` |
| `npm test` | Node 1414 通过、0 失败、3 个 Windows 专属场景在 macOS 明示跳过；Web 25 文件 / 182 项通过 | `tests.log` |
| `npm run build` | Web 生产构建通过 | `build.log` |
| `npm run test:ios` | 87 份源码真实 SDK 类型检查通过；生产 AppModel、排期 62 项、独立 Store 15 项、生产 SQLite 存储 96 项、展示 200 项以及其余门禁均通过 | `ios-gates.log` |
| 完整 `RAI.xcworkspace` 模拟器构建 | `BUILD SUCCEEDED`；覆盖另外 3 个高德 SDK 依赖源码，未安装或启动应用 | `workspace-build.log` |
| 排期语义突变 | 忽略 UUID、把 pending 当覆盖、把清空当成功、先副作用后写日志：全部先成功编译，再被行为断言拒绝 | `watch-mutations.log` |
| 状态语义突变 | 删除持久水位、只比较租约 ID：全部先成功编译，再由对应行为断言拒绝 | `state-mutations.log` |
| 文档链接 / diff whitespace | 225 个本地链接、0 问题；`git diff --check` 通过 | `docs.log` / 本轮终端 |

本轮未运行 `test:e2e:responsive` 或 full E2E，也未执行 Simulator 视觉验收、真实 iPhone 安装/权限流程或配对物理 Watch 验收。上述未执行项不计通过，PR0 的设备发布门槛继续保留。PR5 条件性实体迁移没有被自动触发。

## 审查修复验证（2026-10-09）

- 新增完整清单恢复、历史回执隔离、部分恢复再核验与替换生命周期回归；排期回归增至 74 项，真实 SQLite 存储回归增至 101 项。注入回执写入失败后，旧 ledger、非终态日志与待登记账目均保持原状；重新打开数据库后验证成功事务同时保留新 verified 与旧 replaced。
- `npm run typecheck`、`npm run build`、`npm run test:ios` 及完整 `npm test` 复跑通过。全仓测试首轮未改动的分享卡测试出现一次超时，单独复跑和随后完整复跑均通过；最终 Node 1414 通过、3 项明示跳过，Web 182 通过。
- 原四项排期语义突变均被回归拒绝；另以临时源码恢复“历史回执误伤当前排期”和“恢复漏记 replaced”两个缺陷，均先成功编译，再被对应新增行为断言拒绝。所有复现使用隔离 API/cache 或 fake scheduler，没有新增真机、物理 Watch 或响应式验收证据，未自动提交代码。
