# 阶段 4：多存储与发布一致性审查及实施方案

**日期：** 2026-10-23（Asia/Shanghai）

**性质：** 当前工作树的只读审查与后续实施方案；本文不代表阶段 4 的代码、故障演练或生产验收已经完成。

**审查基线：** `/Users/ta/running`，`main`，HEAD `36d79a95f42f854d54e7dfb91e27eb21152a1fa1`；审查开始时 `git status --porcelain` 为空。

**上游依据：** `/Users/ta/Downloads/RAI_Architecture_Optimization_Implementation_Plan.md` §7、[阶段 3 状态合同](phase3-import-analysis-2026-10-22/STATE_CONTRACT.md)、[阶段 3 发布记录](PHASE3_IMPORT_ANALYSIS_RELEASE_2026-10-23.md)、[导入恢复修复验收](IMPORT_RECOVERY_REVIEW_FIX_2026-10-23.md)、[项目优化方案 PR-06](../docs/PROJECT_OPTIMIZATION_PLAN.md)。

## 1. 审查结论与实施边界

阶段 4 应先形成**五类持久 SQLite 文件与非数据库工件的所有权、备份和恢复清单**，再用隔离副本验证跨文件提交窗口。现有实现已有单写者、发布锁、读租约、发布 guard、dataset epoch、导入回执/账本、删除操作日志及恢复意图；本阶段的起点是验证这些机制的责任覆盖，不是重新设计一套协调器。

### 1.1 已核实事实

| 编号 | 当前事实和证据 | 阶段 4 的处理 |
|---|---|---|
| F1 | `server.ts:166-168` 的主库、控制库、runtime 路径分别可配置；epoch 和 restore journal 从**主库路径**派生（`dataset-epoch.ts`、`restore-journal.ts:64-69`）。`deploy/rai.env.example:5-7` 给出云端模板，不能证明现网实际值。 | 用脱敏后的实际部署配置做路径闭包检查；`absent` 与“未查”分别记录。 |
| F2 | `restore-journal.ts:64-69` 定义独立的 `<main>.restore-journal.sqlite`；`docs/ARCHITECTURE.md:54`、`docs/DATA_PIPELINE.md:72,112`、`docs/OPERATIONS.md:165` 与 `deploy/README-UBUNTU.md:180` 仍按“四个存储/文件”描述维护边界。 | 这是已证实的文档偏差。阶段 4 文档修订须列第五类及其可选出现、WAL/SHM、恢复用途。不能把它合并进 runtime 库。 |
| F3 | `deploy/backup-runtime.sh:27-30,69-72` 停止 API 后归档**整个指定 runtime 根**，脚本明确要求无独立 CLI 写者、所有数据库与工件位于该根；脚本本身不读取 `RAI_DATABASE`/`RAI_CONTROL_DATABASE` 来验证路径包含关系。 | 当前模板路径可被覆盖，外置路径会落在归档外。先做路径审计和拒绝/显式清单方案，不能从一次 tar 成功推断整套状态可恢复。 |
| F4 | API 持有主库 publication lock（`server.ts:223`），主库迁移 CLI 也获取该锁（`packages/storage-sqlite/src/migrate-cli.ts:45`）；控制库数据迁移 CLI 只开控制库，`docs/DECISIONS.md` D19 和 `docs/OPERATIONS.md:187` 明确要求停服窗口。 | 审查所有可写 CLI 的锁/停服合同。控制库跨进程排他是现有方案 PR-06 的候选改动；需先用隔离环境证实并发窗口，再决定纳入本阶段代码批次。 |
| F5 | 阶段 3 的 `dataset_deletion`、`import_scope_evidence`、`scope_abandonments`、`restore_intent` 和恢复重裁决已实施；[发布记录](PHASE3_IMPORT_ANALYSIS_RELEASE_2026-10-23.md) 记载 `d03f4ae` 于 2026-10-23 部署，发布当次按用户要求**未运行** `npm test`/typecheck，仅有冷备、健康及只读冒烟。 | 不重复实现阶段 3 协议；以当前 HEAD 重跑适用门禁和定向故障测试。旧报告的“未部署”是其写作时点状态，不作为当前结论。 |
| F6 | 控制库 guard 先持久记录发布开始，再执行业务事务，读侧比较摘要与 guard 并有界重试（`mobile-goals.ts:392-455`、`plan-read-consistency.ts:158-204`）。模型发布指针在主库事务内验证运行包（`model-release-repository.ts:75-106`）。 | 分别验跨库稳定读取与同库指针原子性；不能把 guard 说成跨 SQLite 文件的原子事务。 |

**证据等级：** F1–F6 属当前源码/文档直接证据（E1），HEAD 与初始工作区状态属本次命令结果（E2）。外置路径是否存在、生产备份是否包含五类库、故障窗口是否存在未覆盖数据状态，均**未在本次验证**；它们是待核实风险，不是已发生事故。本次没有登录生产、读取生产数据库、执行备份/恢复或注入故障。

### 1.2 固定约束

- 保持 SQLite、单 API 进程与现有单写者策略；保持原生 SwiftUI iOS、全部 `/v1` 合同及退役路由的 `410` 语义。
- 不删除或弱化 publication lock、TaskAdmissionScheduler、MutationCoordinator、write lease、publication guard、dataset epoch、读租约、导入回执/账本、模型发布校验。
- 本阶段只碰存储所有权、迁移/发布互斥、备份/恢复一致性及其必要文档与测试；不提前实施阶段 5 的训练计划入口或阶段 6 的完整容量模型。
- 所有破坏性场景只在一次性合成库/脱敏隔离副本及子进程内执行；生产只允许经现有流程作只读配置核对和发布后只读验活。不得对活跃 WAL 库裸复制主文件，不向仓库/日志写健康原文、轨迹、Token。
- 既有 PR-06 中控制库 migration registry/checksum、跨进程控制库锁属于**可选代码批次**：只有下述审查证据和回滚设计齐备才纳入阶段 4。不得为了交付数量擅自重写历史迁移。

## 2. 目标不变量与权威性草表

下表是实施时逐表核对的**工作草表**，最终以源码、schema 和副本查询填写完整矩阵。`可重建` 仅指有可证明的上游和重建步骤，不能因为是“runtime”就认定可丢弃。

| 物理存储 | 路径规则与写者 | 权威状态/样例 | 丢失或不一致时的预期裁决 |
|---|---|---|---|
| 主健康库 | `RAI_DATABASE`；API 写请求与 worker 受单写者/租约约束，离线 CLI 须受 publication lock/维护窗口约束 | 健康事实、路线、导入批次/回执、`recompute_jobs`、模型 run/bundle/active 指针、主库内 dataset epoch | 回执不可读不得推断“未提交”；候选 run 不得成为 active；旧库替换须使读连接失效。 |
| 控制库 | `RAI_CONTROL_DATABASE`，默认位于 runtime；API 主线程，另有显式离线迁移 CLI | 统一训练计划状态/历史、operation idempotency、push/coach 回执、`mobile_publication_guard`、控制 schema | 不能从主库恢复推断控制库也已回退；读到跨库发布变化时重试或 503；数据迁移须保留 revision/来源摘要。 |
| runtime 库 | `<RAI_RUNTIME_ROOT>/var/runtime.sqlite`；API 主线程/导入 worker | `import_sources`、`import_jobs`、`import_publications`、作用域证据、runtime 实例 ID、放弃旧 scope 操作 | 账本损坏/重建不能重新签发 `pristine`；已提交主库回执优先于丢失的响应；上传来源在结果未核实时保留。 |
| dataset epoch 侧车 | `<RAI_DATABASE>.dataset-epoch.sqlite`；删库、恢复、首次写者阶段切换 | 生效 epoch、`dataset_deletion` 的 deletionId/快照摘要/账本实例/单调阶段 | 缺失/损坏/身份冲突不能猜新 epoch；旧 sync anchor 和缓存不得跨 epoch 复用。 |
| restore journal 侧车 | `<RAI_DATABASE>.restore-journal.sqlite`，按恢复流程可暂不存在；维护恢复写者 | `restore_intent` 的阶段、备份字节身份、planned epoch、删除操作绑定和主库摘要 | `committed` 但元数据未收口时重启重放；不匹配或不可读保持 `recovery_required`；空文件与不存在不能混同。 |

同时纳入**同一恢复边界**的非 SQLite 状态：主/控制/runtime/侧车各自可能出现的 `-wal`/`-shm`、导入来源和上传文件、模型/预测工件、保护快照及 quarantine manifest、配置中的 `serverId`/`athleteId`/configured epoch、迁移版本与当前应用代码。`var/backups` 内的安全快照不等于可再生缓存；保护快照是否仍是某个未收口意图的唯一回退点须逐项判断。锁文件是协调证据，不能把 tar 中残留的 PID 当作恢复授权。

阶段 4 至少应形成以下可检查不变量（用 ID 写入测试和最终报告）：

| ID | 不变量 | 最小证明 |
|---|---|---|
| I1 | 同一物理主库在任意时刻只有获准的 API/CLI 发布写者；控制库在线与离线 apply 不交叉。 | 双进程锁冲突、路径别名与停服窗口测试；失败进程不写数据。 |
| I2 | `queued` 的分析任务有持久任务记录；`not_required` 不虚构任务；导入最终成功与主库回执一致。 | 重启/响应丢失/重复请求后对账主库与 runtime。 |
| I3 | `dataset_deletion`、scope permit、runtime 实例和主库 epoch 绑定；未知、损坏或不匹配状态失败关闭。 | 各阶段强杀与错配负例，核对旧事实及来源未被清理。 |
| I4 | 绑定的 restore 意图在主库提交后到 sidecar/scope/发布意图收口前可幂等重放；未验证时不返回可用。 | prepared/installed/committed 与清 journal 前强杀，重启后比较字节摘要、epoch、阻断与结果。 |
| I5 | 跨主库/控制库读到的计划快照来自稳定窗口；guard 不可读、epoch 变化或待发布时不返回混合结果。 | 并发发布/读、guard 损坏/陈旧标记、重试上限与 503 合同。 |
| I6 | 模型 active 指针只指向通过 gate 且快照、lineage、输入绑定有效的 run；job 完成与指针提交一致。 | 发布事务前后强杀、非法 bundle/旧 incumbent 负例。 |
| I7 | 文件替换后不存在旧 inode 读连接或旧 epoch 缓存继续提供业务数据。 | 保持读租约、替换、释放及新读取；data_version、inode、epoch 分别断言。 |
| I8 | 归档覆盖配置中每个权威路径及其必要工件；从整套归档恢复后身份、schema 与未完成操作可解释。 | 脱敏路径 manifest、隔离冷备/恢复演练；外置路径时显式拒绝或有独立一致性方案。 |

## 3. 分步实施与阶段门

### 步骤 0：冻结基线和试验环境

1. 记录 HEAD、`git status --porcelain`、Node/SQLite 版本、五类库 schema 版本、实际配置键名及其**脱敏绝对路径**；只读取部署配置，不打印 Token。标记本地、隔离副本、现网三种证据来源。
2. 以阶段 3 发布记录与当前代码对齐：列出已部署提交、后来提交、既有恢复测试/故障点和发布当次未执行的测试。记录原始计划中“阶段 3 未开始/未部署”的历史口径已过时。
3. 在临时目录生成合成五库、上传/工件、预置操作状态和备份对象；锁定测试环境变量，保证故障测试只能访问临时根。为每次场景保存输入 manifest、SHA-256、进程退出码和重启后的查询结果。测试结束清理隔离目录；日志不保存健康数据。

**通过条件 G0：** 隔离进程无法解析到生产路径；工作树初始状态可复核；已列五类库的 `present/absent/unreadable`，没有用“文件不存在”自动推断首次安装；若缺少实际部署配置，路径覆盖结论只写“待确认”。

### 步骤 1：完成存储/表级所有权矩阵

1. 逐一枚举主库迁移注册表、控制库 `mobile_control_schema`、runtime 初始化 DDL、epoch sidecar 和 restore journal 的表/索引/触发器，标明 schema 升级者与版本识别方式。对控制库的 schema 自动追加、数据迁移显式 apply、runtime 启动迁移分别写出旧版本兼容性。
2. 对每个关键表/状态填写：权威来源、派生关系、作用域（serverId/athleteId/epoch）、唯一键/摘要/外键、写者及事务、正常删除、可重建条件、恢复顺序、旧版兼容与回滚影响。特别核对主库 receipt ↔ runtime job、主库 run ↔ active 指针、控制库 operation receipt ↔ plan revision、侧车 deletionId ↔ runtime instance。
3. 将 `imports/`、`reports/`、模型工件、quarantine、`var/backups` 和 CLI 迁移备份纳入文件级清单。按文件内容判断权威性，不能单凭目录名判定。

**通过条件 G1：** 五类库**每个实际表**及恢复必需的非库文件都有所有者与恢复动作；所有跨库存储边都有两个端点和冲突裁决；未知项列成阻断或显式人工步骤，不留空白“可重建”。产物为 `STORAGE_OWNERSHIP_MATRIX.md` 与机器可比对的路径 manifest。

### 步骤 2：画出协调机制与故障窗口

1. 沿 API 启动、导入、重算发布、控制库计划发布、删库、备份恢复、离线 CLI、API 关闭逐条画调用顺序。每个步骤写明持有/释放哪个 publication lock、task admission owner、mutation lock、write lease、read lease/replace gate、guard marker，以及在哪个库提交。
2. 对每个跨文件操作写“最后一个持久点 → 下一个持久点”窗口，列重启由哪个日志/回执裁决。区分**同库事务原子性**、**跨库 detect+retry**和**冷备恢复的一致性**。对 guard 的 stale 清理说明 API 生命周期锁前提；验证 CLI 是否能绕过该前提。
3. 单独枚举所有可写 CLI。主库 CLI 复核锁路径规范化；控制库迁移 CLI 核对“停服”能否由工具验证。若实测证实在线 apply 可能与 API 交叉，将控制库锁作为最小独立代码批次：API 在自动 schema 前取锁，CLI apply 取主库锁再取控制库锁，所有双锁路径固定同一顺序；dry-run 保持只读。同步修订 D19/运维合同及迁移兼容说明。若不纳入代码，则必须留下可审计的停服操作门禁和未消除风险。

**通过条件 G2：** 每条写路径都有一张“持久顺序 + 保护机制 + 恢复者”图；API 在线/两个 CLI 并发时预期拒绝且事实无变化；无锁顺序环；不能把 PID 存活或 HTTP 不通作为唯一互斥证据。所有机制的责任覆盖有测试或明确未验证项。

### 步骤 3：在隔离副本运行确定性故障矩阵

优先复用现有 `dataset-deletion-recovery.test.ts`、`restore-journal.test.ts`、`import-publication.test.ts`、`plan-read-consistency.test.ts`、`plan-publication-stress.test.ts`、`read-store-manager.test.ts`、`maintenance.test.ts` 及 `RAI_FAULT_POINT` 子进程屏障。新增测试必须停在**真实生产调用路径的持久边界**，不能靠随机 sleep 或只检查 HTTP 状态。每例保存杀前屏障、杀后未启动快照、重启后的结果，并重放一次证明幂等。

| 场景 | 注入/对照窗口 | 必须断言的结果 |
|---|---|---|
| T01 导入未提交 | 事实/路线写入后、主库事务 COMMIT 前强杀 | 事实、路线、batch、receipt、任务均无半提交；原来源保留，重试只提交一次。 |
| T02 导入已提交但响应丢失 | 主库 COMMIT 后、runtime 终态/HTTP 响应前强杀 | 从**原回执**恢复，重复同身份请求不重复事实/任务，不把数据库不可读当“确认无回执”。 |
| T03 分析候选未发布 | run/bundle 产生后、active 指针前失败 | 可保留不可见候选；active 指针保持原值，job 可恢复或有明确终态。 |
| T04 模型发布切换 | active 指针及 job 完成事务前/后强杀 | 两者同进同退；错误 bundle、旧 incumbent、lineage/快照不符均不能成为 active。 |
| T05 控制库发布 | guard marker 提交后、主库/控制库业务写之间并发读取/强杀 | 读者只得稳定快照或稳定 503；重启清死进程 marker 但保留 epoch；无永久假 pending。 |
| T06 读库替换 | 读租约持有时开始换库、释放后再读 | 换库等待或有界拒绝；替换后只读新 inode/epoch；WAL checkpoint 的 mtime 变化不误判为换库。 |
| T07 删库四阶段 | `prepared`、`main_removed`、`permit_issued`、`writer_entered` 各阶段强杀 | 同一 deletionId/nextEpoch 单调恢复；未知缺库不建新库；许可最多消费一次；来源与保护快照保留。 |
| T08 账本与侧车不匹配 | runtime 实例变化、侧车损坏、保护字节变化、旧版本日志 | 不重签许可、不猜 epoch；保持恢复入口与可审计诊断，主库字节不被覆写。 |
| T09 备份恢复三阶段 | restore `prepared`/`installed`/`committed`、收口前和 token 解除前强杀 | 旧库回滚或绑定新库重放，有且只有一个最终 epoch；未核实状态保持阻断；已恢复成功的旧任务/发布意图按现合同 supersede。 |
| T10 恢复失败 | 候选预检失败、安装失败且完整回滚、回滚失败 | 仅无副作用或可证明完整回滚释放临时冻结；不可证明时不宣称成功，恢复入口仍可用。 |
| T11 CLI 互斥 | API 在线时主库迁移/离线导入及控制库 apply，双 CLI 反序竞争 | 应拒绝在线修改或严格停服；锁冲突退出非零，五库状态不变；无死锁。 |
| T12 路径与冷备 | 默认路径、主库外置、控制库外置、缺一侧车、活跃 WAL 对照 | manifest 能识别遗漏；不接受不完整“整 runtime”结论；隔离恢复后五库、工件、scope、计划回执一致。 |

**通过条件 G3：** T01–T12 每项有测试名、输入摘要、故障屏障、退出码、重启查询和重放结果；已有测试可直接引用但须在当前 HEAD 重跑并记录版本/并发。故障后的 API 响应不能出现虚假成功、旧 epoch、旧缓存或无效 active 指针。未执行项单列，不以源码推断替代。

### 步骤 4：冷备、整套恢复和外置路径演练

1. 对云端模板和获准读取的实际部署配置构建**路径闭包**：resolve/realpath 后检查主库、控制库、runtime、两侧车、WAL/SHM、上传、工件、保护快照是否在归档根内；符号链接须检查最终目标。不要读取或输出 Token 值。
2. 检查 `backup-runtime.sh` 的 dry-run/`--apply`、停服后 ActiveState、独立 CLI 写者约束、tar manifest/校验和、失败时服务恢复和临时目录清理。若发现外置库/工件，先选择“拒绝并给出路径”或明确定义同一停写窗口的额外归档清单；不把脚本改为在线裸复制。
3. 用合成/脱敏隔离副本做**完整恢复**：核对归档 SHA-256 和目录 manifest → 停所有写者 → 移开旧隔离根 → 解包全套状态并恢复权限 → 对每个实际存在的 SQLite 库在副本上做 `quick_check`/必要外键与 schema 核对 → 启动 API → 核对 dataset epoch、runtime 实例/未完成任务、控制库 plan revision/operation receipt、主库 active run/导入回执、上传与工件可访问性。
4. 将“API 单库备份恢复”与“整 runtime 冷备恢复”写成两个不同操作手册。单库恢复按现有合同生成新 epoch，不得声称控制库/runtime 一同回到旧时间点；整套冷备恢复必须明确旧设备同步游标/请求幂等状态的处理和重放风险。

**通过条件 G4：** manifest 对五类文件与非库工件给出 `present/absent/external/unreadable`；默认路径完整，外置路径不能假绿；演练有归档摘要、恢复后查询及失败回滚记录。若无生产配置只确认模板/隔离环境，不给生产覆盖结论。RPO/RTO 只记录演练实测值与环境，不将 [PR-06 的建议目标](../docs/PROJECT_OPTIMIZATION_PLAN.md) 写成已承诺服务等级。

### 步骤 5：按证据实施最小修复并回归

1. **必做文档修正：** 更新架构、数据管线、运维与部署说明中的“四库”口径；区分五类持久 SQLite、可选的 restore journal、WAL/SHM 与非库工件。更新命令示例时保留退役备份创建/删除的 `410` 合同。
2. **按测试暴露的缺陷逐项修复：** 每个修复单独写“违反 I1–I8 哪条不变量、故障复现、最小代码变化、负例、旧数据兼容、代码/数据回滚”。跨文件恢复不能靠吞异常、清空账本、换随机 epoch 或把错误改成 200 解决。
3. 若实施 PR-06 的控制库锁或 schema/version 治理，先做独立设计与迁移兼容检查：fresh/v1/v2/未知未来版本/半步失败/并发 apply；不伪造旧 checksum，不改写已冻结的主库 migration。API/CLI 锁顺序和旧版本过渡必须有进程级测试，D19/运维说明同步修改。
4. 简化现有保护机制不属于默认修复。确需简化时另交责任覆盖图、故障证据和回滚设计，作为独立决定，不夹在文档修订或性能调整中。

**通过条件 G5：** 每个代码改动都有先红后绿的有效故障用例；旧 schema/旧 runtime 数据仍能正确读取或明确拒绝；无新写者、无跨库假原子承诺、无 iOS/API 合同退化。纯文档修订不宣称修复运行时风险。

### 步骤 6：门禁、证据包与阶段停止点

按最终修改范围执行并**记录原命令、退出码、环境与未执行项**：

| 改动范围 | 最低门禁 |
|---|---|
| 仅本文及 `deliverables/` | `npm run check:docs`、`git diff --check`；正文证据及链接复核。 |
| API/共享包/迁移代码 | `npm run typecheck`；定向故障套件；`RAI_TEST_CONCURRENCY=2 npm test`（记录并发值）；主库 migration freeze、package boundary、训练计划 single-writer 如触及相应路径。 |
| 测试或 `docs/ALGORITHM.md` | `npm run check:acceptance-matrix`，确认新测试在 `npm test` 的发现范围。 |
| `docs/`、README、AGENTS | `npm run check:docs`、`npm run check:doc-refs`。 |
| API 启动或 `deploy/` | `npm run smoke:api`；部署文本合同由 `npm test` 覆盖；实际 `nginx -t`/`systemctl daemon-reload` 留给服务器 runbook。 |
| npm scripts | `npm run check:scripts`，只使用跨 cmd/PowerShell/bash 可移植脚本体。 |
| `apps/ios`（原则上阶段 4 不应触及） | `npm run test:ios`、`npm run check:ios-gates`；无 Xcode 时明确“no iOS source was checked”。 |

阶段交付物：`STORAGE_OWNERSHIP_MATRIX.md`、`CONSISTENCY_WINDOWS.md`、`FAULT_MATRIX.md`、`BACKUP_RESTORE_REHEARSAL.md`、原始测试日志/manifest、阶段 4 报告（文件/符号/准确行号、前后行为、证据等级、风险、未执行项、迁移和回滚）。性能如未测量写“未测量”，不引用开发机数据冒充 2 核 2 GiB 产能。

**阶段 4 完成条件：** G0–G5 均满足，T01–T12 中所有与当前实现适用的场景有当前 HEAD 的行为证据；五类存储和外置路径覆盖结论明确；故障后无 I1–I8 违例；适用门禁通过或以具体失败阻断验收；报告明确旧版兼容、数据恢复与回滚。完成后提交证据并停在阶段门，不自动进入阶段 5 或生产部署。

## 4. 优先顺序、阻断与回滚原则

1. **P0：** 任何能够复现的虚假成功、旧 epoch/旧缓存返回、丢失唯一保护快照、许可重复签发或 active 指针无效；立即停止后续阶段，保留现场，在隔离环境修复并重跑对应故障矩阵。
2. **P1：** 备份清单缺第五类/外置路径、控制库在线 apply 互斥空档、恢复后任务准入或发布意图无法解释；先完成清单与并发/恢复证据，再决定最小代码修复。当前已直接证实的是**文档口径偏差和脚本路径前提**，并未证明生产备份实际漏文件。
3. **P2：** schema/version 治理和运维可观测性。若不影响本阶段 I1–I8，可保留为 PR-06 后续批次，不能为了“阶段完成”扩大迁移风险。

回滚按三种对象分别写：**代码**（旧版是否识别新 schema/字段）、**单库恢复**（必须生成新 dataset epoch 并重裁决其他库状态）、**整套冷备恢复**（同一时间点的五类库及工件整体恢复，并校验设备游标/操作回执）。发现主库、侧车或账本身份矛盾时保持 `recovery_required`，由运维根据保留的意图、快照和摘要裁决；不得手工清空日志或临时创建新空库来“恢复可用”。
