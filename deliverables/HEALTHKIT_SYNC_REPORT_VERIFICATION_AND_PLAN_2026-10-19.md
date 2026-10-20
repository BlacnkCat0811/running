# HealthKit 同步审查报告：真实性核验与可实施优化方案

日期：2026-10-19；时区：Asia/Shanghai。

## 0. 结论与适用边界

**这份报告不是凭空编造，但混合了真实代码事实、过度推断、已经完成的优化，以及未经测量的收益承诺，不能原样作为实施清单。**

最值得立即处理的不是重写协议或删除补偿通道，而是：

1. 消除意图库在 MainActor 上的同步锁等待；本轮真实 SQLite 合成竞争复现了一次 **6.23 秒**的失败等待。
2. 补齐窗口分页的生产接线：公平排序函数存在，但导出循环没有调用。
3. 短路关闭历史跳过后仍发出的 Coverage 请求，并纠正误导日志。
4. 补冷启动/前台的分析对账；重构游标更新，降低漏传字段风险。
5. 在现有 ZIP/XML、持久回执与后台文件上传框架内，按测量结果削减重复渲染和归档复制。

**本轮没有证据认定新增 P0；不能把一次无效请求标成数据安全 P0，也不能把“nil anchor 可能出现”写成已复现的漏数事故。** 下文优先级是本轮实施建议，不沿用原报告的编号。

### 核验基线

- Git HEAD：`67028e1322ba38e62dc1d0c854d4b632a0338e06`。
- 实际审查对象：**2026-10-19 本地工作树，含任务开始前就存在的未提交/未跟踪改动**，不是 HEAD 的干净版本。
- 代码快照：**2026-10-19 16:09:57 +08:00**；逐文件 SHA-256见本地临时证据 `var/reports/healthkit-report-verification-2026-10-19/review-baseline.json`。
- 当前工作树已经有 `HealthSyncIntentJournal`、`HealthSyncWorkPlanner`、`WorkoutWindowPaging` 和本地 schema v5；不能再次按“这些功能尚不存在”排实施任务。
- 另两份当日材料仅作背景：[前轮复审](IOS_SYNC_REREVIEW_2026-10-19.md)、[工作树实施记录](IOS_SYNC_OPTIMIZATION_EXECUTION_2026-10-19.md)。**本轮独立核对代码，不继承其中的测试通过、生产读数或部署结论。**
- 本轮仅新增方案文档、更新索引；探针与日志放在忽略的 `var/reports/`。**未改产品代码、未连接生产、未部署、未读取真实健康库/上传载荷。**
- 共享工作区在核验期间仍被修改，涉及 `SyncTaskStore.swift`、窗口落盘回归及门禁/回归脚本；最终差异清单见临时证据 `verification.json`。两次工作树iOS检查均因输入文件修改中断。后续验证以冻结快照单独标注，不充作最新工作树全量验收；本轮结论所用的Store打开/WAL配置代码前缀经对比未变化。

这是一份当轮工作文档；收尾后按本目录约定合并入项目审查/同步规范，避免长期维护第二套产品规范。

## 1. 逐项真实性核验

判定口径：**成立**＝实现或探针支持；**部分成立**＝问题存在但范围/因果夸大；**不成立**＝与当前代码冲突；**未验证**＝缺真机或性能证据。

| ID | 原报告主张 | 核验结果 | 当前证据与修正 |
|---|---|---|---|
| V01 | 工业级、零静默丢数据、任意时刻被杀均可无损恢复 | **过度结论** | 有页级预算、回执后提交、条件删除等防护，不等于形式证明。意图库自己明确声明持续不可写后退出不能保证通知耐久；没有本轮真机杀进程/断电证据。 |
| V02 | 有四条记录读取通道及多槽位状态 | **成立** | `HealthKitExport.writeGlobalRecords` 确实有 workout 窗口、迟到动态、48h 窗口、正式 anchored 流；`SyncTaskStore` 与 schema v5 表也存在。迟到动态份额实际为 `1/7≈14.29%`，不是精确 15%；workout/近期分别为 `1/4`、`1/5`。 |
| V03 | 锁屏、授权或空数据都不会推进任何 Anchor | **部分成立** | 锁屏错误被单独处理，补偿窗口空结果不会被当成完整覆盖。但 `HealthKitRecordCursor.drain` 对合法空变更页会返回 `page.next`，这是正常的流进度；不能与“空时间窗不能证明历史完整”混为一谈。Apple 不让 App 判断某类型读权限是拒绝还是无数据，报告不能据此宣称已排除全部授权漏数。[S1][S2] |
| V04 | 写前页闸门、删除溢出、确定性文件名和恢复状态机 | **实现成立，强保证未验收** | `budget.accepts`、`DirectSyncDeletionAllocation`、`SyncAtomicUnit.nextStep`、哈希文件名及固定 boundary 均有实际调用。没有本轮故障注入覆盖所有崩溃点，不能由源码直接升级成“任意故障零丢失”。 |
| V05 | Observer 在 completion 前登记，旧代次不会误删新代次 | **正常存储路径成立** | 已用 SQLite 条件 `DELETE … WHERE url_scope AND generation`，不再是 UserDefaults 三步读删。写失败仍调用 completion 并记录失败；此时只证明失败可见，不能承诺该通知已保存。[S3] |
| V06 | 多通道重复采集，依赖服务端去重 | **部分成立** | 跨通道重叠仍存在；但 workout 候选已有按 UUID 合并，迟到补读通过 `windowCoveredTypes` 跳过部分48h重复。稳态类型的48h pass也已经关闭。不能按“四通道始终全跑”估算收益。 |
| V07 | 游标字段手动重建容易漏传 | **成立，属维护风险** | `HealthKitRecordCursor` 共有8个存储属性，多个构造点复制相同字段；没有证明当前又漏了某个字段。`anchor/historyReadAt` 是 `let`，不能照建议直接全部改成可变赋值。 |
| V08 | 18种类型串行，空窗每批最多多18次查询 | **部分成立** | 查询循环串行，当前类型集合最多18个；空窗成本集中在首装/重放类型，且受份额及已有覆盖短路影响。不能扩展为每次稳态同步都额外18次，也不能在没有 trace 时定性为主要耗电来源。 |
| V09 | 页放不下会重查，尾部可能约10次IPC | **机制成立，实际频率/成本未测量** | `drain` 会重查，但已经调用实测字节均值 `budget.shrinkLimit`，不是每次纯折半。本轮均匀大小合成页从1000直接收缩到1，接受前仅2次查询；另有1次正常EOF查询。这不否定报告所说的多次重查可能性；workout页也仍有折半路径。不能承诺加估算后所有页都只需1–2次。 |
| V10 | 磁盘写放大约3倍 | **重复复制成立，口径不完整** | ZIP→持久ZIP→multipart有三份近似ZIP量级的写入；但还应计算XML/GPX原件和压缩临时文件。prepare已经把哈希与复制合成一次读取并在后台执行，不能再列“先哈希再复制”这项不存在的浪费。见§3。 |
| V11 | Journal没设WAL，若先初始化就可能使用回滚日志 | **独立打开成立；不能据此认定正常生产路径未用WAL** | `HealthKitSync.swift:173` 的 `taskStore = SyncTaskStore()` 是属性初始值，在 `init()` 内创建 journal 前已执行。TaskStore显式WAL/FULL；探针“TaskStore→Journal”得到 `wal`。Journal单独新建库则为 `delete`。WAL是数据库持久模式，不要求每条连接重复设置才能继承。[S4] |
| V12 | `queue.sync` + 2000ms busy timeout + 3次重试会卡主线程 | **成立，已合成复现** | MainActor调用 `observe/migrateLegacy/acknowledgeResult`；另一连接持写锁时，真实 `acknowledgeResult` 等待6.23秒后返回 `.failed`，旧意图保留。队列排队时间还不包含在单次busy timeout内。不能只看2秒或毫秒级sleep。 |
| V13 | StoredZip无压缩，换JSON/Protobuf可减少60%–80% | **无压缩不成立；收益无证据** | `StoredZip.swift:39–62` 已先Deflate并在更小时用ZIP method 8，否则method 0。本轮合成XML也实测method 8。XML重复字段本就可压缩；必须比较“现有压缩ZIP”与“候选压缩格式”，不能把未压缩XML当基线。 |
| V14 | 两个核心文件不进入本机纯逻辑回归，文本门禁易碎 | **成立，但需补充覆盖层次** | 原文限定“纯逻辑回归脚本”，这个判断属实，不应误读成“项目未检查它们的类型”。`typecheck-ios.sh` 包含它们，执行真正的iOS SDK类型检查；未覆盖的是主体编排的运行行为。文本门禁确有脆弱切片/字符串匹配，但并非唯一防线；纯函数及真实SQLite回归已存在。 |
| V15 | 冷启动分析对账缺入口 | **成立** | `reconcilePendingAnalysis` 只有同步收尾调用；`sync_analysis_reconcile` 已持久化任务，但没有独立启动/前台对账。这是展示/状态缺口，不是原始健康事实未入库的证明。 |
| V16 | Coverage跳过关闭，但仍请求覆盖表 | **成立** | `allowsHistorySkip=false`；`needsCoverageQuery` 未检查它；握手能力位+缺游标/重放时仍发请求，`historyFloor` 最终nil。稳态不会无条件发这次请求。日志却仍称“将跳过…”，也需一起纠正。 |
| V17 | 零样本记录返回nil anchor会失败，两处策略不一致 | **不一致成立；nil可达性未验证** | records抛 `missingRecordAnchor`，workouts归零兜底。Apple接口的optional签名和描述不能证明“无错误且空页时必定nil”，更不能证明某台手机已因此卡死。必须真机取证，暂不改成统一归零。[S2] |

### 不应丢失的正面设计

必须保留：写前真实字节校验、完整页对应锚点、删除事件预算守恒、服务器持久回执后再提交、scope隔离、后台上传文件所有权，以及生命周期取消和人工取消的区别。优化不能通过移除这些边界换取“速度提升”。

### 本轮额外发现：公平分页只有函数，没有生产调用

当前工作树：

- `apps/ios/RAI/WorkoutWindowPaging.swift` 的 `serviceOrder`（快照第164行）按 `lastServedAt` 排序。
- 纯逻辑测试确实调用并验证它。
- `HealthKitExport.swift:1592–1608` 却按 descriptor生成数组，再执行 `for index in pages.indices`；没有调用该排序函数。

因此，“已有独立分页”成立，“生产已按最后服务时间公平轮转”尚不成立。[实施记录](IOS_SYNC_OPTIMIZATION_EXECUTION_2026-10-19.md)对此的完成描述不能直接当验收证据。

这不证明每个高密度窗口都永远不收敛：前面的类型读完后，后面的类型仍可能被服务。但预算持续被前序类型占用时，后序类型缺少公平性保证。**建议P1先补接线及生产调用级回归，而不是再写一套排序纯函数。**

## 2. 本地复现结果与证据强度

全部使用合成数据与临时SQLite目录；无真实健康数据。

| 探针 | 实际结果 | 能证明什么／不能证明什么 |
|---|---|---|
| Coverage缺游标 | `allowsHistorySkip=false`，`needsCoverageQuery=true`，`historyFloor=nil` | 纯策略组合存在无效请求条件；不是抓到了手机真实HTTP流量。 |
| 意图库独立初始化 | `journal_mode=delete` | 独立入口缺少显式配置。 |
| TaskStore后初始化意图库 | `journal_mode=wal` | 正常初始化顺序继承WAL；不证明所有异常打开路径都成功。 |
| 持写锁后同步确认 | 6.228秒，结果 `.failed`，旧代次保留 | 真实SQLite等待可达；不是线上卡顿频率，也不是每次确认固定6秒。 |
| 1000条均匀大小页、仅剩100B | 查询limit依次 `[1000,1,1000]`；渲染1001条、提交1条 | 当前缩页已能按均值直降；最后一次查询是EOF，不能计为预算重试。 |
| 重复内容XML归档 | 输入1,110,000B；ZIP 3,404B；method 8 | 已使用Deflate。极易压缩的合成夹具**不是**真实健康包的压缩率或新协议收益。 |

证据位于本机 `var/reports/healthkit-report-verification-2026-10-19/`：

- `VerificationProbe.swift`、`probe-results.json`：真实生产类型/函数探针及输出。
- `review-baseline.json`、`source-snapshot/`：时间、HEAD、源码哈希及本轮快照。
- `verification.json`：输入报告/交付文档哈希、最终验证摘要与快照后的文件变更清单。
- `test-ios.log`：第一轮在类型检查期间报“SyncTaskStore.swift was modified during the build”；**不是通过，也不归因成源码类型错误**。
- `test-ios-retry.log`：重跑结果见§7。
- `targeted-regressions.json`、各 `*-regression.log`：快照源码的定向回归、编译命令与测试源码哈希。
- `typecheck-snapshot.log`：冻结快照的iOS SDK类型检查结果。
- Apple/SQLite官方材料摘取原文：用于核对平台语义，不替代真机实验。

不把前轮生产报告的6km训练、缺项数量和耗时搬成“本轮再次确认”。本轮没有手机构建号、HealthKit实际回调、后台唤醒记录或生产部署证据。

## 3. 正确的性能模型

### 3.1 磁盘I/O：先分清压缩前后、累计量与峰值

设：

- `U`：XML、GPX、manifest等原始暂存文件总字节。
- `C`：Deflate临时文件累计写入量；即使最后选method 0，也可能先尝试压缩。
- `Z`：最终ZIP大小；`H`：multipart封装头尾。

按当前App可见的文件写入，近似为：

```text
W_current ≈ U + C + Z(打包) + Z(持久副本) + (Z + H)(multipart)
          = U + C + 3Z + H
```

这是代码路径推导，不是设备测量；不含SQLite、文件系统元数据、缓存、系统上传进程可能产生的内部复制。并且这些文件并非全部同时存活，**不能把累计写入量当峰值驻留量**。

后续目标：

- ZIP写出时同步算哈希、在持久目录内原子发布：主要省掉约 `Z` 的额外写和一次ZIP重读；**不自动消除Deflate临时文件**。
- raw ZIP上传：再省约 `Z+H` 的App文件写入；只相对“ZIP+multipart两份持久产物”接近减半，不保证整个同步峰值或闪存写量减半。

### 3.2 查询：计算真正的重复与重试

现有 `ExportChannelCounts` 已记录通道条数，应增量扩展，不能又造一套计数真相。建议每批记录：

- `(channel,type)` 的query次数、返回条数、空页数、耗时；budget-retry次数与EOF次数分开。
- 已渲染/已接受/重复抑制的条数及字节；记录重试导致的重复渲染量。
- XML、压缩、归档发布、multipart、上传、回执等待分别计时；重叠阶段不可直接相加当总耗时。
- 意图库排队、SQL执行、busy等待分别计时，观察MainActor长任务。

只保留计数/时长/大小和原因码；不要记录健康值、原始UUID、精确路线或Token。性能估算和hint失败只能导致多查/缩页，不能授权推进游标。

## 4. 分批实施方案

估时为单工程师的规划估计，不是已有吞吐测量；真机验证和发版等待另计。

### A1 · P1 · 意图库异步边界与连接配置（约2–3工程日）

**文件**：`HealthSyncIntentJournal.swift`、`HealthKitSync.swift`、`HealthSyncBackgroundRecovery.swift`、`SQLiteSupport.swift`及相关回归。

1. 给MainActor使用的 `observe/acknowledge/migrate/reopen` 提供异步入口，由同一专用串行队列执行SQL，通过continuation返回值；事务内部不跨 `await`。
2. 排查构造期 `queue.sync { openLocked() }`；初始化/恢复数据库也不能把数秒锁等待搬到App主线程。按单飞所有权准备存储，准备失败明确保留恢复需求。
3. observer可以把持久化安排到受控队列后返回回调栈，但**必须由持久化完成路径调用completion**；不能为了不阻塞而先completion后落库。保留失败分类与日志；持续磁盘不可写仍不承诺零丢失。
4. 抽取两个连接共用的配置纪律：显式 `journal_mode=WAL`、**`synchronous=FULL`**，并检查实际返回模式。WAL配置失败不应伪装成成功；只对明确busy/locked做有限重试，排队时间也需观测。
5. **不采纳原报告的 `synchronous=NORMAL`**。它在WAL下保一致性但可能丢失硬重启前已提交事务，与“completion前耐久交接”的目标不符。[S4]
6. 保留条件删除、scope及代次语义，不改回UserDefaults；不要顺手把MainActor TaskStore直接扔进 `Task.detached`，其隔离和事务边界需单独设计。

**验收**：另一连接持锁时，MainActor心跳仍可执行；确认失败不删意图；旧确认/新记录两个顺序都不吞新代次；任一Store先打开都为WAL，两个连接都显式FULL；关闭/重开和旧键迁移成功后再删键。

**回滚**：兼容保留v5表及已登记意图，只回退调用实现；禁止删库、清意图或降耐久模式。此包不要求新schema。

### A2 · P1 · 把公平窗口调度真正接入导出（约1–2工程日）

**文件**：`HealthKitExport.swift`、`WorkoutWindowPaging.swift`、窗口分页回归及接线测试。

1. 生产循环消费 `WorkoutWindowPaging.serviceOrder(pages, now:)`；用 `recordType → descriptor` 映射取类型，不能排序page后仍按旧数组index配对。
2. 维持 `(scope,workoutUUID,windowRevision,type)`、固定predicate、候选anchor及回执后CAS提交；本批仅接受的页才产生可提交候选。
3. 逐类型份额不足时，区分“剩余预算不够”和“单记录超过完整预算”。当前窗口路径已有 `shareLimitedPageSize` 预估；真实渲染仍超限时要有有界缩页/退避，不能下一批永远重查相同大页。
4. 统一检查窗口与page状态的 `nextCheckAt`：有可服务续页即保留续接需求；到期才探测；过期有持久结算。复用现有planner和BGProcessingTask，不新加调度机制。
5. 将公平性测试放到**生产使用的遍历/执行缝**上，不只测试 `serviceOrder` 本身。

**验收**：限制每批只能接受一个页，先前已服务的心率不能再次挤掉从未服务的功率；重启后仍公平；页与descriptor不串类型；预算拒绝不推进anchor；receipt前杀进程仍从原anchor恢复。

**回滚**：保留已确认分页行。若需暂停，停止创建新窗口页并先排空在途任务，继续正式anchor流；不清正式/窗口anchor，不把被禁用的窗口标成已完成。实际开关需新增和测试，不能假定仓库已经有可用开关。

### A3 · P2 · Coverage请求短路与升级风险盘点（约0.5–1工程日）

**文件**：`HealthKitRecordCursor.swift`、`HealthKitSync.swift`、`HealthKitRecordCursorRegression.swift`及调用级回归。

1. `needsCoverageQuery` 在关闭开关时直接false；同步调用方相应无请求。保持 `/v1/sync/coverage` 服务端路由和既有契约，不因客户端不用就删API。
2. 更新目前断言“缺游标应请求”的回归，新增全局关闭时缺游标/历史续读/稳态均不请求的行为测试；不要只改函数却留下测试与文案矛盾。
3. 关闭时删除“历史段将跳过服务端已覆盖部分”的误导日志。
4. 盘点已安装构建及旧 `historyCoverageFloor` 是否可达；无法证明从未分发时，按已知升级风险单列处理。
5. **不在本包自动清旧anchor或全库重放**。旧带谓词anchor迁移须有独立设计：保住删除流、按类型有界补偿、回执后换代，并经过真机验证；不能简单去掉floor后复用旧anchor就宣布历史已补齐。

**验收**：开关false时覆盖查询次数0；已有同步结果、删除事件和候选anchor不变；API仍可供兼容客户端调用。

**限制**：即使未来返回 `segments`，若只是把已有服务端样本聚合成时间段，也不能证明手机没有未传样本。重新开放跳过需要同源store/类型/predicate/数据集身份和已确认交付范围的可验证证明，不只是字段从MIN/MAX改名为segments。

### B1 · P2 · 启动/前台分析终态对账（约1工程日）

**文件**：`HealthKitSync.swift`、实际启动/前台入口、`DirectSyncReceiptState.swift`及对账回归。

1. 用已有 `loadAnalysisReconcile` 槽，恢复连接身份及认证后，在现有单飞边界内发起一次有界 `GET /v1/jobs/:id`。
2. 明确传入并捕获scope、服务端身份和job；await后验证身份未切换，不能把旧服务器终态写到新scope或覆盖新同步文案。
3. 不读取HealthKit、不触发上传、不改原始回执和已提交anchor；网络失败/401只影响对账提示，不把事实已保存改成同步失败。
4. 在启动与前台多次触发时合并请求；无pending为0请求、非终态不热轮询；已持久终态直接恢复展示，避免每次联网。

**验收**：服务端先完成分析、App后重启，无需新一轮健康导出即可更新状态；覆盖失败、取消、切目标、旧服务端/任务不存在和重复前台进入。

**回滚**：关闭新增触发入口，保留原有同步收尾对账及槽内容。

### B2 · P2 · 游标更新集中化（约0.5–1工程日）

**文件**：`HealthKitRecordCursor.swift`、`HealthKitExport.swift`及游标兼容回归。

1. 近期/迟到补读这种不改anchor的更新，使用原值copy后只改对应可变字段。
2. 正式anchor及 `historyReadAt` 更新使用集中helper：接收旧cursor和本次明确变更，统一构造新值，保留未涉及通道字段。
3. 首装无cursor必须单独初始化；不要为了少写构造器把所有属性改成任意可变，也不要引入难以区分“保持nil”和“清成nil”的通用Optional参数API。
4. JSON键和缺键默认语义不变；不新增平行存储或自动重置策略。

**验收**：三条更新路径各以所有字段非默认的cursor作输入，逐字段验证仅预期字段变化；旧payload缺键可解码；anchor损坏仍fail-closed。

**回滚**：仅回退helper及调用，序列化格式与已保存数据不变。

### B3 · P2 · 查询前预算hint，不拆分伪造锚点（约1–2工程日）

**文件**：`DirectSyncBatchBudget.swift`、`HealthKitRecordCursor.swift`、`HealthKitExport.swift`及预算/分页回归。

1. 先采集query/render/retry数据；复用已有 `shrinkLimit` 和窗口 `shareLimitedPageSize`，不是重写同名能力。
2. 给正式drain每次query前提供有界limit hint，依据剩余条数/字节和本类型已接受页的字节分布；首批无历史用保守默认。
3. 保留真实字节 `accepts` 和失败后严格收缩到1的兜底；hint只是性能建议，不是安全判据。不要把“平均大小”误当最大大小。
4. 绝不截取缓存页前N条后配整页next anchor提交。HealthKit没有给这个前缀的对应anchor时，必须重查；deletion也不能随切片丢弃。
5. 建议仅作批内hint，先不增加持久字段或迁移。workout含GPX的页单独测量，不套用普通Record的均值。

**验收**：均匀/高度偏斜/超大单条/删除-only/接近满额及取消场景都保持相同交付语义；统计接受前的预算重查次数下降。**不设“每页必定1–2次”的不实保证**。

**回滚**：关闭hint回原limit，仍保留原写前闸门及缩页。

### B4 · P2 · 批内精确去重，再评估通道收敛（约1–2工程日，不含观察期）

**文件**：`HealthKitExport.swift`、现有通道统计、导出/入库对拍回归。

1. 先统计通道重叠，区分“返回重复”“渲染重复”“传输重复”；服务端inserted较低不自动等于客户端查询全是浪费。
2. 去重只针对**本批已接受载荷**中的相同 `(type,UUID,规范化记录内容)`；同UUID内容变化不能被旧版本遮蔽。集合大小受单批预算约束。
3. 页面预算与游标仍按真实接受载荷处理；重复页对应的候选进度必须依附包含原记录的同批durable回执，不能走“空导出就成功”的捷径。删除事件独立守恒。
4. 不用“某类型写过”推导另一个时间窗已经完整覆盖；已有 `writtenTypes/windowCoveredTypes` 的区分必须保留。
5. **本阶段不删14天迟到补读、不删重放期48h通道**。先验证正式anchor与workout窗口在迟到、权限变化、历史积压下的交付集合，再按独立开关逐通道减量；至少覆盖36–72小时迟到、超过48h、超过7天及30天再武装的回归场景。以上是测试场景，不是Apple的传输时限保证。

**验收**：对同一合成HealthKit事件日志，对拍“记录内容集合+删除集合+最终游标”；传输更少但集合一致，且版本更新不被旧记录压住。保留真实设备观察期，不能用纯函数对拍代替权限/跨设备返回语义。

**回滚**：关去重，恢复多发不漏的原行为；不清任何已确认游标。

### B5 · P2 · 少一次ZIP复制，保持上传文件所有权（约2–3工程日）

**文件**：`StoredZip.swift`、`HealthSyncArchive.swift`、`HealthKitExport.swift`、`HealthKitSync.swift`及归档/取消回归。

1. 在Application Support下建立受保护、排除备份的staging文件；让ZIP最终字节写出时经同一sink更新SHA-256，包含local header、内容、central directory及尾记录。
2. 输出仍保持现有Deflate参数、条目顺序和确定性元数据；若将来writer需要seek回写，必须重新设计哈希覆盖，不能继续套增量hash。
3. 完整写入、同步并关闭后，在同一目录/卷内原子发布为 `upload-<hash>.zip`；发布后才将其纳入任务恢复边界，文件缺失仍走既有恢复策略。
4. 保留已有同hash文件与在途上传的所有权；取消只能删本次未承诺产物，不能覆盖/删掉旧任务依赖。兼容恢复旧版 `.zip/.multipart`，不在升级时批量清理它们。
5. 第一阶段继续multipart后台文件上传，不动服务器协议；再测写量/峰值。解耦的归档回归必须覆盖disk full、读取失败、发布前后取消和同hash复用。

**验收**：相同fixture最终ZIP/hash逐字节不变；App可见持久副本写量少约Z；重传命中同一批；后台session仍可重挂。

**回滚**：新批回原prepare复制路径；已持久化及在途产物按原文件名继续恢复。

### B6 · P2 · 测试缝替代易碎文本门禁，而非一刀切删除（约2–4工程日，可分步）

**文件**：同步/导出编排、`apps/ios/tests`、现有门禁入口。

1. 先抽实际生产调用的页执行器/待办执行器，用窄的异步接口注入query、writer、receipt client和时钟；传递值类型/opaque anchor，不向纯逻辑层泄漏HKHealthStore/UIKit。
2. iOS adapter继续负责真实HealthKit和系统生命周期；Foundation-only编排可在宿主执行。这是测试组织，不增加macOS App/客户端目标。
3. 优先替换A2公平接线、预算拒绝不提交、候选回执后CAS、启动对账身份隔离的文本判据；用刻意拆掉生产调用的突变验证测试能变红。
4. 删除旧判据前，逐条建立“原护栏→新行为用例→突变”映射。保留适合静态验证的entitlements、Info.plist、禁止健康样本写入及后台能力声明等门禁。
5. 继续运行现有iOS SDK类型检查；Mock通过不能证明真实HealthKit回调、background delivery或BGProcessingTask已被系统触发。

**验收**：移除公平排序/把commit放到receipt前/先completion后record，各自至少一个行为用例失败；等价重命名/进度文案修改不再误伤迁移过的判据。

**回滚**：保留旧门禁到新判据经突变验证完成；一次只迁移一组，不大规模删Python。

### C1 · 暂缓：raw ZIP与新记录协议

当前 `/v1/imports/uploads` 用 `request.file()` 接收multipart；文件part允许ZIP不等于整个HTTP请求已支持raw ZIP。后台URLSession跨进程上传也要求稳定文件，不能直接换成内存/stream上传。[S5]

如B5后实测multipart仍值得优化，单独走协议变更包：

- 服务端先增加可协商能力与有界raw ZIP流接收，复用幂等、鉴权、解压校验、大小限制、截断处理及同一导入回执；不移除原 `/v1` multipart路径。
- 新客户端仅在握手确认后选择raw文件，保留旧任务按旧格式恢复；不能把内容类型变更当客户端单方面优化。
- 对同一ZIP，两条通道落成相同事实和幂等身份；部署顺序服务端→客户端，回滚时不得切换在途文件。

JSONL/Protobuf/Zstandard再往后排：先用脱敏合成fixture比较现有压缩ZIP/XML与候选格式的压缩大小、双端CPU/RSS、解析错误、删除与元数据语义、后台能耗；必须有协议版本和兼容设计。**现阶段不承诺60%–80%收益，不重写TypeScript算法，不另起健康导入管线。**

## 5. 实施顺序与发布闸门

推荐拆成小提交/PR，不把所有模块重构绑成一次发布：

| 批次 | 内容 | 前置条件 | 发布判断 |
|---|---|---|---|
| 第一批 | A1、A2、A3 | 固定审查基线；取得本轮工作树既有R1–R5改动的所有权/合并状态 | 主线程不等待SQL锁、生产公平接线、Coverage零请求；必须补行为证据，不以源码匹配绿灯代替。 |
| 第二批 | B1、B2 | 第一批稳定；scope及旧payload夹具齐全 | 无新健康读取即可对账；游标字段无意外变化。 |
| 第三批 | B3、B4 | 通道/预算重试基线可观测 | 同一事件日志交付集合不变；性能指标有相同fixture对比。 |
| 第四批 | B5 | 归档、取消、恢复旧任务回归完备 | 字节/hash不变；disk full与杀进程恢复通过。 |
| 持续项 | B6 | 每条待替换护栏都有行为测试和突变证据 | 逐条迁移，不先拆安全网。 |
| 独立提案 | C1 | 测量确认剩余瓶颈；协议版本/双端兼容方案批准 | 服务端先行、旧客户端/旧任务可继续；不因优化移除既有API。 |

不据此承诺系统后台任务在某分钟必定执行或手机“所有指标一次同步齐全”。“事实已交付、分析状态、当前未观察到指标、观测稳定性”继续分开呈现；未知不等于Watch一定还在传输。

## 6. 最小验收矩阵

| 编号 | 用例 | 必须保持的不变量 |
|---|---|---|
| T01 | Coverage关闭×缺游标/续读/稳态 | 0请求、0历史跳过，不清既有anchor。 |
| T02 | 任一连接先初始化；连接重开 | 实际WAL，两连接显式FULL；模式失败不假成功。 |
| T03 | 外部持写锁/队列积压 | MainActor可运行；失败不丢意图；等待/排队有诊断。 |
| T04 | 旧确认先/新记录先/确认时失败 | 新代次不被误删；条件删除0行无后续无条件删除。 |
| T05 | 旧UserDefaults意图迁移中断 | COMMIT前保旧键，成功后删；新代次优先。 |
| T06 | 一批一页，前序已服务、后序未服务 | 下一批服务后序；重启保持；生产executor实际调用排序。 |
| T07 | 预算估计过小、超大单条、删除-only | 真字节闸门有效；有限停止；删除守恒；无伪造anchor。 |
| T08 | 取页后/文件发布前/回执前/回执后杀进程 | 未确认页重发，确认页不漏；原文件所有权不破坏。 |
| T09 | 空结果、拒绝/部分读权限、锁屏中途发生 | 不把未知读成完整；正常EOF与“所有数据都没有”分开。 |
| T10 | 零样本类型、已有anchor后空页 | 记录真机newAnchor是否nil；无结论前不归零兜底。 |
| T11 | 分析完成后重启；401/网络失败/切目标 | 无HealthKit查询；不串scope；不改已保存事实/回执。 |
| T12 | 游标旧payload、所有字段非默认、单类型损坏 | 更新不覆盖别的通道；损坏不静默重置整行。 |
| T13 | 多通道重复及同UUID内容更正 | 精确去重不压住新版本；候选仍等同批回执。 |
| T14 | 迟到>48h、>7天、历史积压、30天再武装 | 未证明等价前保留恢复通道；不以空窗/年龄清全局anchor。 |
| T15 | ZIP取消/写满/发布失败/旧同hash在途 | 不发布半文件；旧任务仍可恢复；新旧格式兼容。 |
| T16 | 历史带floor游标的升级 | 独立证明补偿覆盖与删除流；不靠关闭开关宣称迁移完成。 |

T03/T04/T05/T06/T07/T11/T12/T13/T15应有宿主行为回归；T08/T09/T10/T14/T16必须包含真机证据。真机日志只记类型、数量、anchor存在性/摘要与错误码，不复制原始样本。

## 7. 本轮验证记录与后续执行命令

以下仅记录本轮执行；不将历史报告的绿灯迁入本栏。

| 检查 | 本轮结果 |
|---|---|
| 生产类型/真实SQLite合成探针 | 已运行；结果见§2，6.23秒竞争复现不等于问题已修。 |
| `npm run test:ios` 第一轮 | 中断：编译期间共享工作树 `SyncTaskStore.swift` 被修改；未通过。 |
| `npm run test:ios` 重跑 | 再次因同一文件在编译期间修改而退出1；未取得工作树全量绿灯。 |
| 冻结快照定向回归 | 5组全部exit 0：cursor 85项、intent 67项、paging 17项，以及archive、cancellation两组；不包含真实HealthKit编排运行。 |
| 冻结快照iOS SDK类型检查 | exit 0：98个文件通过；既有3个高德SDK依赖文件按脚本排除。不是安装包构建，也不是共享工作树全量门禁通过。 |
| `npm run check:docs` | 通过：97文件、656本地链接、2个锚点、0问题。 |
| 本文行号引用核验 | 3处可解析引用，0越界/无法解析；无 `.linerefs.json`，工具未检查内容漂移，关键内容本轮人工核对。未跟踪文件的公平排序位置另按符号/快照手工核对。 |
| `git diff --check` | 通过。 |
| 全量 `npm test` / TypeScript typecheck | 未运行；本轮没有API/算法代码修改，不作为发布验收。 |
| 真机/模拟器UI/生产与App构建核实 | 未运行；不能据本文宣称发版或端到端验收完成。 |

后续改代码时至少执行：

```bash
npm run test:ios
npm run check:docs
npm run check:scripts
npm run check:acceptance-matrix
```

API/共享包或协议变更再执行 `npm run typecheck` 与全量 `npm test`；忙主机通过环境设置 `RAI_TEST_CONCURRENCY=2`，发布记录写明并发度。不要把POSIX环境赋值语法写入npm script；跨平台入口继续使用Node `.mjs`。涉及server启动或deploy时再跑 `npm run smoke:api`。

源码门禁替换须跑对应突变探针；模拟器验收及AMap交叉检查继续按仓库手工runbook执行。新增/修改Swift、shell文件检查LF，不以文件名大小写在当前机器可用代替跨平台核对。

## 8. 外部依据（本轮查阅的第一方文档）

下列只用于平台语义核实；不将文档说明当作这台手机的实测。正文[S1]–[S5]对应：

- **S1 · Apple，Authorizing access to health data**：App无法区分某类型读取被拒绝与没有可见数据；授权请求完成不是“所有类型已允许”。`https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data`
- **S2 · Apple，HKAnchoredObjectQuery及其initializer**：anchor描述的是前次返回对象边界，limit描述样本数量；optional newAnchor不能单独证明空页nil的实际可达性。`https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery`；`https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery/init(type:predicate:anchor:limit:resultshandler:)`
- **S3 · Apple，HKObserverQueryCompletionHandler**：处理完成需调用completion；三次不响应会停止后台更新。文档没有支持原报告“永久、无法恢复”的额外断言。`https://developer.apple.com/documentation/healthkit/hkobserverquerycompletionhandler`
- **S4 · SQLite，Write-Ahead Logging / PRAGMA synchronous**：WAL模式持久，NORMAL与FULL的硬重启耐久性不同；不能为消除UI等待而默认降低意图提交耐久性。`https://sqlite.org/wal.html`；`https://sqlite.org/pragma.html#pragma_synchronous`
- **S5 · Apple，Downloading files in the background**：后台session也覆盖上传，跨进程支持file-based upload，不支持退出后的Data/stream上传。`https://developer.apple.com/documentation/foundation/downloading-files-in-the-background`

**最终取舍**：保留现有可靠性边界，先补真实接线与非阻塞存储，再减少多余查询和文件复制；协议重构、通道删除及nil anchor策略变更都以独立证据为前提，不凭报告中的收益数字推进。
