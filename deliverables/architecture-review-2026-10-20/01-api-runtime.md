# Lane 1：API 运行时 / 安全 / 契约 / 任务链架构审查

- 基线：`git HEAD = 9db450f`（工作树只读；本报告落盘前后产品代码零改动，`git status` 只有本 lane 新文件）。
- 方法：E1 静态逐行阅读 `apps/api/src/**`、`apps/api/test/**`（抽样测试架构）、`packages/api-contracts`；E2 实跑三个**定向**门禁/测试（见 §4 命令与输出）；E3 用代码注释中的事故记录作背景（不当作本轮事实）。未跑全量 `npm test`/smoke/部署、未读写 `var/` 真实库。
- 覆盖：路由面与登记表、OpenAPI/schemas、鉴权/上传/备份恢复、任务链/202 终态、worker_threads/命令队列/单写者链、`server.ts`/`data.ts`/`mobile-goals.ts`/`training-plan-*` 的职责边界。
- 不覆盖：包内部实现（Lane 2/3）、iOS 本体（Lane 4）、`deploy/` 模板与 nginx/systemd 文件本体（Lane 5/Lead）。跨 lane 事实在 §3 末尾单列。

## 0 结论摘要

| 级别 | 数量 | 一句话 |
| --- | --- | --- |
| P0 | 0 | 未发现数据丢失、未授权写入、生产不可用级缺陷 |
| P1 | 0 | 鉴权矩阵、上传解包、恢复事务、410 退役矩阵、写路由登记均成立且有门禁 |
| P2 | 4 | ①计划两套真相/所有权未收口；②同步读无超时、可用性靠 watchdog 杀进程；③契约四份手写表示、门禁只覆盖集合与少量字段；④v2 读合同缺 handshake 能力位 |
| P3 | 8 | 500 错误绕过脱敏、HTTP 层业务编排、god file、迁移运维入口、门禁语义边界、鉴权三层、任务链四套状态机、可观测性 |

**总体判断（3 条）**

1. **依赖方向是一致的，但"分层"是 hub-and-spoke 而非洋葱。** `packages/*` 从不 import `apps/*`（包边界门禁 16 包/31 边/4 条禁线，实跑通过），API 只单向消费包；但 `server.ts` 同时是 composition root、路由 handler、后台任务宿主与跨库策略层（58 个顶层 import、7 个后台定时器、6 个 worker/queue/store 构造、88 个路由注册中的 69 个）。"Fastify → 业务模块 → 队列/线程 → storage"在依赖方向上成立，在**职责边界**上不成立：业务判定在 HTTP 层、read-model、控制库三处都有。
2. **并发模型比"单进程单写者"复杂得多，且总体失败方向正确（fail-closed）。** 真正的互斥由五层机制叠加：发布锁文件（跨进程）、`TaskAdmissionScheduler`（进程内整作业 FIFO）、`MutationCoordinator`（请求级）、`write-lease`（跨线程事务窗口，超时即撤回不写）、publication-guard/inode+data_version（跨两个 SQLite 文件的读一致性）。残余缺口不是"谁拿到了锁"，而是**读路径没有预算**：全部同步跑在主事件循环上，唯一兜底是 systemd watchdog 在 120 s 后杀进程。
3. **2026-10-20 的统一训练排课 v2 是"并行的第二真相"，不是替换。** 新四件套（store/commands/routes/coordinator，2090 行）本身边界清晰、有结构门禁，但它脚下的持久化仍是 legacy `mobile-goals.ts`（1612 行）；v2 只把自己的配置/计划镜像进 legacy goals，lock/receipt/coach-loop 仍只写 legacy，v2 读只投影统一状态。所有权、退出条件与"另一条路径怎么写"目前靠调用约定与产品决定，没有代码不变量。

**最该先做的 3 件事**：①给 v2 读合同补 handshake 能力位并明确 unified state 的所有权（否则版本偏斜/双写迟早出用户可见分歧）；②为 HTTP 读路径加可观测的耗时代理与"超预算返回可重试 503"的语义（不必重写成异步 worker）；③把 response DTO 的必填字段从 `api-contracts` 生成进 OpenAPI（或加对拍测试），并顺手收口训练计划路由的 500 错误映射。

## 1 实际架构（as-built）

### 1.1 进程 / 线程 / 子进程

```text
主进程（单事件循环，Fastify）
├─ HTTP 读：RaiReadStore（只读连接缓存，ReadStoreManager，inode 失效）→ 同步返回
├─ HTTP 写：MutationCoordinator（请求级）→ 直接调 @rai/application / 控制库
│           └─ 控制库 mobile-goals / training-plan-store：同步 SQLite（WAL, busy_timeout=2000）
├─ ImportWorker ── worker_threads：import-database-thread（两条导入车道，整作业持 admission）
│                  └─ import-analysis-thread（数据集分析，按需）
├─ RecomputeWorker ── worker_threads：recompute-thread（常驻，跨轮复用）
│                  └─ 写许可：SharedArrayBuffer 序列号协议（write-lease），窗口=短事务
├─ PredictionModelWorker ── child_process：packages/application/src/prediction-training-runner.ts
└─ CommandQueue：runtime.sqlite 持久命令队列（容量 16），同一任务许可内执行
```

- `server.ts` 启动顺序：发布锁文件（`acquireDatabasePublicationLock`）→ 恢复中断的恢复/删除 → datasetEpoch → ReadStoreManager → MobileGoalsStore（控制库 schema v1→v2 + 清 publication marker）→ 各 worker/queue → 路由注册 → systemd READY → listen。**整条生命周期在一个模块顶层 await 里**。
- 后台循环共 7 个：周计划小时 tick + 启动 60 s 探针、zone 回填 5 min、recompute 兜底巡检 60 s、上传清理 1 h、废弃库清扫 24 h + 启动 60 s。全部 `unref()`。

### 1.2 路由面（实测量）

- **88 个 handler 注册 / 80 条唯一路径**：GET 51、POST 29、DELETE 4、PUT 2、PATCH 2。
- GET 分类：`publicReadRoutes` 3 条（`/v1/health`、`/v1/handshake`、`/v1/runtime-status`），`tokenRequiredReadRoutes` 48 条；新增 GET 必须显式分类，否则 `server-runtime.test.ts:1827` 红。
- 写路由登记表：`metadataOnlyMutationRoutes` 16 + `databaseRequiredMutationRoutes` 17 + `lockOnlyMutationRoutes` 4 = 37（= 实测 mounted 写路由数）；`retiredLegacyRoutes` 5 条路径 / 7 个操作，全部挂 410 `legacy_surface_retired` + `replacement`。
- OpenAPI `paths` 80 条，与 mounted 唯一路径（`:id`↔`{id}`）**逐条相等**；退役操作标 `deprecated`、只声明 410、不声明 200。
- 读接口面远大于写：`data.ts` 的 `RaiReadStore` 有 **约 37 个公开读方法**（另有 4 个生命周期/诊断方法）（today/workout-plan/statistics/trends/series/freshness/share-card/coverage/…），全部同步、全部经 `withReadStore`。

### 1.3 新四件套的边界

| 文件 | 行数 | 职责 | 判断 |
| --- | --- | --- | --- |
| `training-plan-store.ts` | 1249 | 控制库 schema（migration 2）、state 解析/校验、CAS（`applyMigration`/`commitState`）、迁移分类与 sourceDigest | 持久化 + 迁移；无 HTTP、无跨库 |
| `training-plan-commands.ts` | 475 | 命令语义（set/clear race goal、pause/resume）、preview 候选、submit/refresh 的 CAS+幂等+发布 | 领域服务；依赖注入 `prepare`/`fingerprint`，不读 HTTP |
| `training-plan-routes.ts` | 254 | header 协商（1/2/unsupported）、v2 投影、HTTP 错误映射 | 适配层；边界清晰 |
| `training-plan-coordinator.ts` | 112 | `refreshDecision`（纯函数）+ 单飞定时 tick + 确定性 operationId | 纯决策；无 I/O |

**结论：四件套不是新的 god module，是这条业务的一个规整切片。** 但它们的跨库编排留在 `server.ts`：跨库 fingerprint = `weeklyPlanSnapshot().fingerprint + dataVersion`（`server.ts:1588-1621,1749-1763`），`prepare` 闭包也在 HTTP 层。也就是说"生成在主库外、提交在控制库内"的核心一致性规则由 HTTP 文件持有。

### 1.4 与 `docs/ARCHITECTURE.md` 的差异

- 文档写"API 负责 HTTP/控制，重型导入和重算由现有串行协调机制执行"——**成立**；但没说清控制库本身也是同步主线程写、读也没有超时预算。
- 文档写"读端使用兼容快照/bundle；写命令具备 revision/idempotency/generation 约束"——**成立且本轮已加强**（guard + 重试 + 503 + Retry-After）；未写"v2 合同是投影、执行授权恒 false"这一过渡事实（`training-plan-routes.ts:130-133`），这是本轮新增的设计状态。
- 文档写"主库保存…已发布指针；iOS 有本地页面缓存"——当前实际有**两个计划状态库**（legacy goals + unified state），文档只描述了前者。

### 1.5 并发 / 单写者链的接线与失败方向（BRIEF 问题 2 的正面回答）

| 机制 | 覆盖范围 | 谁持有 | 拿不到时 | 代码 |
| --- | --- | --- | --- | --- |
| 发布锁文件 | 跨进程、每 DB 路径 | API 进程整个生命周期；CLI 迁移/导入短暂持有 | 后启动进程拒绝启动（PID+processIdentity 判活） | `server.ts:183-190`、`storage-sqlite/publication-lock.ts` |
| `TaskAdmissionScheduler` | 进程内、整个作业（import/recompute/prediction/command）+ 控制行取消 | 各 worker 的 `owner()`；FIFO，控制行优先 | 等待方有界重试，HTTP 写端以 409 收场 | `task-admission.ts:25-122` |
| `MutationCoordinator` | 进程内、单个 HTTP 请求 | `preHandler` 按请求取/放（onError+abort+onRoute 包装保释放） | `mutation_conflict` 409；短等待仅 2 s | `mutation-coordinator.ts:10-38`、`request-mutation-lifetime.ts` |
| `write-lease` | 跨线程、一个短事务窗口 | 主线程 `TaskAdmission` 授权，recompute 线程按窗口申请 | 30 s 超时→**撤回请求并抛可重试错误（不写）** | `write-lease.ts:40-107`、`recompute-thread.ts:1-60` |
| publication guard | 跨两个 SQLite 文件（主库+控制库）的发布窗口 | 发布者在控制库先提交 `epoch/pending_since` | 读端重试 3 次后 503 `plan_snapshot_changed`+`Retry-After: 1` | `publication-guard.ts:36-151`、`plan-read-consistency.ts` |
| 读租约/换库 gate | 进程内、文件替换 | `ReadStoreManager.beginReplace/endReplace` | 20 s 内等不到空闲→409 `database_busy` | `read-store-manager.ts:167-199` |
| 命令幂等回执 | 主库同一事务 | `CommandQueue` 执行前查 `import_manifest` receipt | 已执行则以 receipt 结果返回，不重复施加 | `command-queue.ts:186-231` |
| 导入发布 journal | 主库换文件 | `ImportPublicationJournal.prepare/commit/clear` | 提交不明→`databaseRecoveryRequired`，写路由 409 直到重启 | `import-publication.ts`、`server.ts:889-895` |
| 恢复 journal | 主库 + 备份目录 | `RestoreJournal`（prepare→installed→committed） | 启动 `recoverInterruptedRestore()` 回滚/完成；否则 503 需重启 | `maintenance.ts:157-…,312-470`、`restore-journal.ts` |

**判断**：真正被代码强制的不变量是"主库写入同一时刻只有一个持有者"（发布锁 + admission + write-lease + 换库 gate 的叠加），以及"计划读不能读到混合发布"（guard）。靠调用约定的是：**控制库只在主线程写**（无跨进程锁；控制库无自己的 publication lock，仅 API 进程的 DB 发布锁间接保护）、unified state 只能经 `commitState` 写（结构门禁 R4 只拦 SQL 文本，拦不住新写入口）。预测训练子进程以 `readOnly: true` 打开主库（`prediction-training-runner.ts:674`），只把工件/结果写到磁盘，DB 行由父进程记录，故不构成第二个写者。

## 2 架构评估（按 BRIEF §2 七维度）

1. **结构与边界**：依赖方向一致、无反向 import（包门禁实跑）；但 API 内部无强制分层——`server.ts` 直接 `new RaiApplicationService(store)` 9 处、裸 SQL 读 10 处、`withReadStore/withReadDatabase` 49 处；控制库写入只允许 `training-plan-store`（R4 结构门禁），主库写入不允许出现在 GET/hook（`schemas.test.ts:415` 源码扫描），这两条是真正的"边界被执行"。
2. **职责与单一数据源**：业务规则的单源程度不均——计划 generation 单源（R1/R2 门禁）、phase 单源（D16）、发布 guard 单源；但"计划状态"有两个写栈（见 P2-1），鉴权有三处判定（P3-6），任务状态有四种形状（P3-7）。
3. **一致性与并发模型**：五层互斥（见摘要）；失败方向：write-lease 超时→不写（fail-closed）、guard 读失败→重试后 503（fail-closed）、无 guard 的 store→digest-only（文档化 fail-open）、`isDatabaseRestoreBusy` 读库异常→false（为允许恢复，fail-open 且有意）、publication marker 崩溃残留→120 s 租约后忽略。**"哪些靠调用约定"**：`mobile_training_state` 只能经 `commitState` 写、write-lease 只由 recompute 线程用、子进程预测训练不回写主库状态——前两条有结构门禁，第三条只有调用约定。
4. **故障隔离与可伸缩性**：线程隔离导入/重算，CPU 与 HTTP 分离；但读与主写共享事件循环，主库再大也没有读 worker；单用户单写者是产品前提，不是瓶颈；预测训练是独立子进程（可被杀），导入/重算线程崩溃有 retire/重排（recompute 可重试、导入整作业失败带 recovery 门）。
5. **可演进性**：`/v1` 只增不删（410 退役而非 404），能力位按"可选数字/键"追加，写路由三表分类强制显式；缺口在 v2 合同没有能力位（P2-4）与响应形状无门禁（P2-3）。
6. **质量系统**：路由集合/写登记/OpenAPI paths/退役 410/单一写者形状都有真门禁，且我实跑复核（§4）；但结构门禁自述"不证明运行时互斥/可达性"，响应字段级对拍只在 direct-sync/PR5 两个专题存在。
7. **安全与运维边界**：架构上是**集中式**的——一个 `onRequest` 鉴权 hook、一个 ZIP 解包choke point（`import-sources.ts:615`）、一个恢复事务状态机（restore journal + 原子 rename + epoch 变更）、一个错误脱敏策略；散落的是少数 D9 敏感路由的重复 token 校验（P3-6）。上传/恢复/匿名读的具体实现见 §3 已核实部分。

## 3 发现详情

### P2-1 计划状态有两套真相、所有权尚未收口（E1+E2）

- **位置**：legacy 写 `server.ts:1796-1834`（lock 只调 `mobileGoalsStore.lockSession` → `mobile-goals.ts:662-663` 只写 legacy goals/history；`/synced` 回执同理）、v2 写 `training-plan-commands.ts:321,407`（唯一 `commitTrainingPlanCommandState`）；v2 读 `training-plan-routes.ts:75-135`（只读 `mobile_training_state`，`lockedToday` 取 `state.lockedSession`，`execution.permitted` 恒 false）；legacy 读 `data.ts:596-…`（`trainingPlanState`）；托管 gate `server.ts:486-500`（coach-loop managed 时连 `/v1/mobile/training-plan-state` 的 v1+v2 一起 409）；迁移 source 含 `coach_loop`（`training-plan-store.ts:117`）。
- **机制**：控制库里并存两份状态：`mobile_goals(payload_json, revision)` 与 `mobile_training_state(payload_json, revision)`。v2 命令把 raceTarget/weekPlan 单向镜像进 goals；反过来，lock、排期回执、coach-loop 运行时、周计划 history 只写 goals，不回写 unified。于是"暂停/锁课之后 v2 读仍报旧状态"，而"v2 命令写入的配置在 legacy 今日页/可执行周上只能看到被镜像的部分"。`coach_loop` 来源迁移后 unified 反而被 legacy 托管 gate 关闭（read 与 v2 同路径），即新合同的可用性由旧合同生命周期决定。
- **影响**：新客户端一旦通过 v2 命令改配置，读取面（today/workout-plan 或 v2）会与写入面出现分歧；`lockedToday` 会长期停在上一次迁移值。当前 iOS 只把 v2 当参考（`TrainingPlanStore.swift` 注释"只作参考，从不置为当前"），且不 POST v2 命令，所以**尚未触发**；协议已交付但无消费者（见 §3 跨 lane）。
- **建议**：先做所有权决定：①unified state 为唯一计划真相 → lock/receipt/coach-loop 同事务写 unified，legacy goals 降为只读镜像/短期兼容；②unified 只是迁移影子 → 对 v2 写端点加"managed/双写未启用"的显式 409，并在 handshake 里不宣告。两条都要加一个结构门禁：除白名单外不得同时出现两个计划写入口。

### P2-2 读路径同步、无请求超时；可用性兜底是 watchdog 杀进程（E1）

- **位置**：`server.ts:748-782`（`withReadStore/withReadDatabase/withReadDatabaseAsync` 全部同步回调 `readStores.use`）、`read-store-manager.ts:73-114`（缓存只读连接、inode 失效、lease 阻止换库）；`data.ts:267` 起的 `RaiReadStore` 约 37 个公开读方法全同步；`mobile-goals.ts:1010-1045` 控制库同步写（`busy_timeout=2000`）；`server.ts:197-200` Fastify 只配 logger/ajv，**没有 requestTimeout/路由级预算**；`systemd-notify.ts:1-40` 记录 2026-10-18 的 13.4 s 同步读挂死全站；`server.ts:2319-2331` READY/WATCHDOG（40 s 心跳，120 s 判死）。
- **机制**：读多连接缓存 + WAL 保证正确性，但所有 SQLite 调用于主事件循环同步执行；一次全库扫描/大排序会阻塞所有 HTTP、后台定时器与 watchdog 心跳。进程内的失败语义只有"请求晚到/客户端超时"，没有"本请求超预算 → 可重试 503"。
- **影响**：读放大时全站停摆，客户端看到连接超时；watchdog 重启期间进行中的导入/重算靠 journal/lease 恢复（机制存在），但用户请求直接失败。没有按压测复现（见 §6），但事故注释与代码结构足以定为结构性风险。
- **建议**：不需要立刻上异步读 worker。第一步给 `withReadStore` 加耗时代理 + 阈值日志/指标（route 维度 p95），并对已知慢读（工作台/趋势/详情）加 `progress_handler`/行数上限或分页；第二步让"超过 N ms 的读"返回 503 `database_busy` + `Retry-After`（客户端已有该语义），把"卡死"变成"可重试"；长期再评估只读 worker（写许可模型已为此预留）。

### P2-3 契约有四份手写表示，门禁覆盖"集合 + 少量字段"（E1+E2）

- **位置**：TS DTO `packages/api-contracts/src/index.ts`（2293 行）；请求 JSON Schema + OpenAPI 文档都在 `apps/api/src/schemas.ts`（1239 行），其中**响应成功形状是手写 required 名单** `successSchema`/`objects`（`schemas.ts:740-790`）；路由没有声明 `schema.response`（grep 0 处，Fastify 不校验响应）；Swift DTO 手写在 `apps/ios/RAI/APIModels.swift`。
- **已覆盖**：路由集合 vs 运行期路由表（`server-runtime.test.ts:1827-1945`）、写路由三表归类（`schemas.test.ts:337-414`）、退役 410 矩阵（`legacy-surface-retirement.test.ts:119-172`、`schemas.test.ts:399-414`）、部分枚举由共享常量派生（`IMPORT_STAGES`/`MOBILE_PLAN_OPERATION_QUERY_STATUSES`，`schemas.ts:845-860`、`schemas.test.ts:582-690`）、direct-sync 与 PR5 两个专题的跨语言字段门禁（`apps/ios/tests/check-direct-sync-contract-parity.py`、`check-pr5-facts-analysis.py`）。
- **未覆盖**：通用响应 DTO 字段/必填/可空性没有 TS↔OpenAPI↔Swift 对拍；OpenAPI 的响应只到"部分 required 名单"，不是完整形状。改字段/加可空只会让客户端解码失败。
- **影响**：契约漂移的唯一发现机制是客户端运行时；与仓库"能力位必须可选、字面量单源"的纪律不对称。本轮实测未见漂移（80/80 路径一致）。
- **建议**：把 `api-contracts` 的关键响应接口生成成 OpenAPI components（或至少对拍 required 集合 + 可空性），加一个 `check:api-contract-shape` 门禁；Swift 侧至少对 `HandshakeResponse`、`TrainingPlanStateResponseV2`、ImportJob 三组做字段级 python gate。

### P2-4 v2 训练读合同没有 handshake 能力位，版本偏斜无法协商（E1）

- **位置**：`HandshakeResponse`（`packages/api-contracts/src/index.ts:166-210`）已有 `healthKitRecordSyncVersion/planSnapshotContractVersion/coachLoopContractVersion/planPublicationContractVersion/planReceiptContractVersion/factsAnalysisContractVersion/factsAnalysisViewContractVersion/syncCoverageVersion/directSyncBounds` 九组可选能力；v2 训练合同只有请求头 `X-RAI-Training-Contract`（`training-plan-routes.ts:49-59,149-160`）与响应体 `contractVersion`，**没有**对应 handshake 位（grep `TRAINING_PLAN_CONTRACT_VERSION` 仅出现在 api-contracts 定义、commands、routes）。
- **机制/影响**：新客户端无法在握手时知道服务端是否支持 v2，只能盲发 2。老服务端会忽略未知 header、按 v1 返回 200，客户端按 v2 解码失败 → 用户看到"数据版本不兼容"，而不是仓库其他合同统一的"老服务端省略能力位 ⇒ 客户端回落/提示升级"。当前单版本部署未触发，但这是客户端与服务端独立升级时的常态场景。
- **建议**：handshake 加 `trainingPlanContractVersion?: 2`（可选、字面量单源），客户端无该位时明确走"需升级服务端/客户端"分支；v2 投影里的 `contractVersion` 保持，二者不合并。

### P3（合并表）

| ID | 级别 | 位置 | 机制 / 建议 |
| --- | --- | --- | --- |
| P3-1 | P3 | `training-plan-commands.ts:463-474`（500 兜底 `message=error.message`）+ `training-plan-routes.ts:229-231,248-250` + `server.ts:1644-1648` | 这三处 `reply.send({code,message})` 绕过 `apiErrorPayload`（`api-error.ts:40-50,62-77`）的 5xx 脱敏白名单；未预期异常（如 SQLite 路径/约束）会原文回给已认证调用者。改为抛给 `setErrorHandler` 或复用白名单。 |
| P3-2 | P3 | `server.ts:1368-1449`（`/synced` 回执证据规则+matchesCurrent+幂等键）、`1796-1834`（lock 业务规则）、`1588-1621,1749-1763`（跨库 fingerprint/generation）、`486-507`（托管/退役策略 gate）、裸 SQL `712,789,795,847,850,1459,1912,1915,1921-1922` | HTTP 层持有领域判定与跨库编排；写操作都有锁/事务（方向对），但改一条计划规则要同时改 server/routes/service/gate，回归面集中。建议把 `/synced` 证据规则与 lock 决策下沉到 commands/service，server.ts 只留路由与装配。 |
| P3-3 | P3 | `mobile-goals.ts`(1612：文件 JSON 回退+控制库 schema/迁移+goals/history+push/coach receipts+publication op/guard+缓存+coach-loop 状态)、`data.ts`(2479 行/约 37 个公开读方法) | 真正的 god file 不是四件套而是它们脚下的 store 与 read model。建议按"控制库仓储 / 发布账本 / 读模型"拆文件，四件套保持不变。 |
| P3-4 | P3 | `scripts/migrate-training-planner.mts:1-30`（"deliberately not wired into anything"）、release 记录要求"停 rai-api → --apply → 启动" | v2 写路径的启用入口只有 CLI + 当轮 deliverable；`docs/` 无操作手册、README 文档表无入口；脚本不强制停机、无 publication lock（只用控制库、`timeout: 2000`）。建议在 OPERATIONS 增加"迁移/回滚/验收"小节，脚本加 `--require-no-live-api` 或明确提示。 |
| P3-5 | P3 | `scripts/check-training-plan-single-writer.mjs` 头注释（R1–R5 自述"不检查并发锁/可达性"）；`server.ts:992-995,1682-1684`（legacy/coordinator 二选一分支） | 结构门禁证明"形状"，运行时互斥靠 `server.ts` 的 migrated 判定；新增第二个排课入口只会被 R1/R2 拦，若从白名单文件内新增调用则可绕过。建议给"同一 scope 只能有一个生成者"补运行时断言/指标。 |
| P3-6 | P3 | 全局 hook `local-request-security.ts:155-191`；handler 内重复 token `server.ts:1160-1171,1250-1271`；`RAI_ALLOW_ANONYMOUS_ROUTES` 分支 `server.ts:1163-1171` | 鉴权在架构上集中（一个 hook + 三张路由表），但 D9 敏感路由仍各自内联一次 token 比较，共三处；当前一致、属纵深防御，但未来改鉴权策略要三处同改。建议抽 `requireToken(request, reply)` 单一 helper 并保留纵深语义。 |
| P3-7 | P3 | 命令队列 `command-queue.ts:104-140`（202/429、cap 16）；导入 `import-worker.ts:415-460`（202/413/429/507、maxPending 8）；重算/预测 `server.ts:929-960`（job 表+60 s 巡检）；计划发布 `plan-publication.ts:60-90`（同步 200+operationId 账本） | 四套任务模型、四个查询面（`/v1/commands/:id`、`/v1/import-jobs/:id`、`/v1/jobs/:id`、`/v1/mobile/plan-operations/:id`）、三种失败形状（`code`/`failureCode`/`error`）。客户端要四套状态机。建议至少在 api-contracts 里定义统一 `TaskStatus` 词汇并在文档里列四者的"终态/可重试/可取消"矩阵。 |
| P3-8 | P3 | `runtime-telemetry.ts`（进程均值/最大/p95）、`server.ts:1090-1093`（`/v1/performance` 只有 admission/pending 布尔） | 无按路由/按队列/按线程的指标，无法从进程外回答"哪个端点/哪个 job 在拖慢"。建议按 route 打点（复用 `onResponse` 已有的 start 时间）并输出 p50/p95/max + 慢请求 top-N；不引入新依赖。 |

### 已核实「不是缺陷」（防止重复排查）

- 匿名读已按 D17 收敛为 3 条无健康数据路由（`server.ts:271-275`），写不受匿名放宽影响（`local-request-security.ts:171-180`），并有分类门禁（`server-runtime.test.ts:1900-1938`）。
- ZIP 上传的解包边界完整：magic/符号链接/`..`/绝对路径/Windows 保留名/大小声明/压缩比/逐条预算/`wx` 排他创建/磁盘余量（`import-sources.ts:590-740`），失败码 400/413/415/429/507 稳定。
- 备份创建/删除已按产品决定退役为 410（`server.ts:2187-2200,2219-2224`）；恢复仍是"确认词 + 空闲检查 + 候选校验 + restore journal + 原子安装 + 回滚 + epoch 变更 + safety backup"（`maintenance.ts:312-470`、`server.ts:2242-2268`），失败方向 fail-closed（`RestoreRecoveryRequiredError` → 503 + 重启）。
- 错误脱敏策略有单一入口与白名单（`api-error.ts:40-77`）；`Retry-After` 只给自述可重试的 503/429；`/v1/mobile/*` 统一 `Cache-Control: no-store`（`server.ts:462-468`）。
- 单写者链的跨进程前提成立：`acquireDatabasePublicationLock` 硬链接原子锁 + PID/processIdentity 存活判定，API 进程生命周期持有（`server.ts:183-190`；storage-sqlite 实现）。
- 写路由登记表与真实路由表由运行期 `RAI_ROUTE_DUMP` 对比（E2 实测 37 条写路由全部恰好归一类、51 条 GET 全部归类）；OpenAPI 与 mounted GET 逐条相等。

### 跨 lane 事实（待 Lead 合并，不单独计级）

1. **v2 读的消费者状态**：iOS 把 v2 当"只作参考、从不置为当前"（`TrainingPlanStore.swift` unified 注释），仍以 legacy aggregate 为可执行读；iOS 代码中**没有** `GET` 之外的 `/v1/mobile/training-plan/commands` 调用（只发 `X-RAI-Training-Contract: 2` 读取）。因此 P2-1 的写入分歧当前无可达客户端。
2. **旧写面退役后的可达性**：HEAD 服务端恒宣告 `coachLoopContractVersion: 1`（`server.ts:1052`），iOS `usesUnifiedTrainingPage = usesCoachLoopContract || isCoachLoopManaged`（`NativeAppModel.swift:78`），因此 HEAD iOS 连 HEAD 服务端时旧手动计划编辑器不可达（`TechPlanView.swift:14`）；已安装旧 App 会收到 410（release 记录已声明）。与 Lane 3 的 I1 对拍：**服务端不再有"宣告可用但客户端无消费者"的能力位**（v2 合同无 handshake 位，见 P2-4，是反向缺口）。
3. **v2 读被 legacy 托管 gate 关闭**：coach-loop managed 数据集上 `/v1/mobile/training-plan-state`（v1 与 v2 同路径）返回 409（`server.ts:486-500`）；迁移 source 可为 `coach_loop`（`training-plan-store.ts:117`），即"从教练闭环迁移来的数据域"在程序进行中无法读 v2。若产品预期是"迁移后 v2 取代教练闭环"，这里需要反向调整；请 Lane 3/Lead 确认口径。

## 4 量化指标（命令与输出）

| 指标 | 值 | 来源/命令 |
| --- | --- | --- |
| API 生产源码 | 92 个 `.ts` / 31,277 行 + 3 个线程 bootstrap `.mjs` | `find apps/api/src -name '*.ts' \| xargs wc -l` |
| 最大文件 | server 2366 / data 2479 / import-worker 2263 / mobile-coach 1714 / mobile-goals 1612 / training-plan-store 1249 / schemas 1239 | `wc -l` |
| 路由 | 88 handler / 80 唯一路径；GET 51 / POST 29 / DELETE 4 / PUT 2 / PATCH 2 | 源码扫描（`/tmp/route-scan.mjs`），与 OpenAPI 80 逐条一致 |
| 读分类 | public 3 / token 48 | `server.ts:271-362` 实读 |
| 写登记 | 16 + 17 + 4 = 37，与 mounted 写路由数相等 | 同上 + E2 测试 |
| 退役面 | 5 条路径 / 7 个操作，全部 410 + replacement | `server.ts:427-443`、`legacy-surface-retirement.test.ts` |
| 测试架构（API） | 117 个 `*.test.ts` / 37,961 行 / 1,016 个顶层 `test()`；11 个 spawn 真进程、9 个直接构造 Fastify | `ls`/`grep`/`wc` |
| 四件套 | 2090 行（store 1249 / commands 475 / routes 254 / coordinator 112） | `wc -l` |
| composition root | 58 顶层 import / 7 后台定时器 / 6 worker·queue·store 构造 / 9 处 `new RaiApplicationService` / 10 处裸 SQL | `grep`/`sed` |
| E2-1 写路由归类 | `✔ every mounted write route is classified` tests 1/pass 1，4.7 s | `node --import tsx --test --test-name-pattern "every mounted write route" apps/api/test/server-runtime.test.ts` |
| E2-2 包边界 | `16 个包 / 31 条 src 边；禁线 4 条；通过` | `node scripts/check-package-boundaries.mjs` |
| E2-3 单写者结构门禁 | `R1–R5 / 生产源文件 465 / 测试文件 122 / 违规 0；通过` | `node scripts/check-training-plan-single-writer.mjs` |

## 5 建议与优先级

| 批次 | 内容 | 风险/依赖 |
| --- | --- | --- |
| A（本周，低风险） | P2-4 handshake 能力位；P3-1 错误映射收口；P3-4 迁移 runbook；P3-8 路由耗时打点 | 都是增量，不改业务语义；P2-4 需客户端一起改（但可先服务端加位、旧客户端忽略即安全） |
| B（下次计划合同前） | P2-1 所有权决定与实现（unified 为唯一真相 或 v2 写显式 409）；补"同一 scope 只有一个生成者/计划写者"的运行时断言 | 需要产品确认"暂停/锁课/回执"归属；会改 DB 写入路径，需迁移+回滚脚本；依赖 iOS 侧何时切换写 |
| C（可靠性） | P2-2 读预算/慢读 503 + 指标；再评估只读 worker | 需要基准库或合成大库压测（本轮未做）；不要为了"异步化"改写全部读模型 |
| D（契约与质量） | P2-3 响应形状门禁；P3-5 结构性门禁补运行时维度；P3-6 鉴权 helper；P3-7 任务终态矩阵 | 不改变运行行为，但直接决定下一次"绿灯是否可信" |

不做的事：不建议引入 PM2 cluster/多 API 写者（D5 明确）；不建议把 legacy 路由删掉（D17）；不建议把 API 层整个重写成 clean architecture——现状的主要风险是"双真相 + 读预算 + 契约漂移"，不是目录结构。

## 6 未验证边界

1. 全量 `npm test` 由 Lead 执行（2224 tests / 2211 pass / 0 fail / 13 skipped，concurrency=2，598 s），本 lane 未独立复核该基线；本 lane 只跑了 §4 的三个定向门禁/测试。
2. 未在真实 325 MB 库或合成大库上压测"同步读阻塞"的时延与占比；P2-2 的 13.4 s 是 `systemd-notify.ts` 注释中的事故记录，不是本轮实跑。
3. 未构造"migrated + legacy lock + v2 读"的端到端探针验证 P2-1 分歧（静态证据 + 结构门禁 R4 足以证明写点集合，但未实跑分歧现场）。
4. P2-4 的版本偏斜行为是静态推断（老服务端忽略未知 header 属 Fastify/HTTP 常规行为），未用旧构建实跑。
5. 未审计 `deploy/` 的 nginx/systemd 模板本体（属 Lane 5/Lead）；未验证 systemd watchdog 在真实部署中的 NOTIFY_SOCKET/NotifyAccess 配置（只读代码与注释）。
6. 未实跑预测训练子进程与主进程的交互（静态看子进程只读主库、写磁盘工件，DB 行由父进程记录；未做跨进程并发/中断演练）。
7. 未验证旧 iOS 构建对 410 的处理路径（`legacy_surface_retired` 不在终局码集合，但 `!code.hasPrefix("plan_operation_")` 的 4xx 分支会清账目——静态阅读为可自愈，未实跑旧构建）。
8. Lane 2/3 的包内迁移、算法语义与数据管线结论未在本 lane 复核，报告只引用其与 API 接线的交集。
