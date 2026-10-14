# RAI 纯增量原地同步改造 · 实施方案（可执行版）

**文档状态**：可执行（v2，2026-10-14）。本版在初稿基础上按代码基线 `51b19cf` 逐条核实，修正了 8 处与代码实况不符或不可实现的点（见 §2.6），补齐缺失的章节：前置条件、逐步操作（含输入/输出/验收）、风险登记册、回滚方案、术语表。
**代码基线**：`51b19cfe3960219812a74ec772f5309b3b869441` —— 本地工作树 = `origin/main` = 生产 HEAD（三方对齐，工作区干净）。本文所有 `文件:行号` 均锚定该提交。
**依据文档**：
1. 《RAI Stage 0 — 只读基线核实报告（2026-10-14，第二次执行）》（以下简称"Stage 0 报告"）
2. 《〈RAI 纯增量同步重构与 PostgreSQL 迁移实施方案〉审查报告与修订版工程实施方案》（以下简称"审查报告"）
3. 初稿《RAI 纯增量原地同步架构与工程实施方案》（本版取代其全部内容）

**关键取舍（一句话）**：本方案 = 审查报告"路径 A"（不引入 PostgreSQL，先收口增量）的完整落地版；目标是把同步链路的 **回退率降到 0 + 消灭两次全库校验成本**，不动数据库引擎、不反转 A18、不加 schema 迁移 —— 因此**几乎全程可回滚**。

---

## §1 目标与范围

### 1.1 要解决的问题（全部有 Stage 0 实测证据）

| # | 问题 | 证据（2026-10-14 实测） |
|---|---|---|
| P1 | **正常同步走"重路径"**：iOS 同步先试直连车道，被拒后回退候选链路（整库备份 → 暂存副本 → CLI 导入 → 重算 → 换库） | `runtime.sqlite.import_jobs` 全窗口 242 条：带遥测的 118 条中 **115 条（97%）走了候选链路**、直连仅 3 条；上传 30/30 = iOS 客户端 |
| P2 | **单次成本 71.5–76.9% 是两次对 2.15 GB 全库的 `PRAGMA quick_check`**（197–323 s × 2），且随库体积增长 | `#28827`：`backupVerify` 242.9 s + `activation_verify` 296.1 s = 76.9%；`#29331`：214.2 s + 264.8 s = 71.5%。10-11 起每次 9.9–13.3 min；慢档 10 次均值校验占 **74.5%**；对照直连作业 `#29129`/`#29250` 仅 **12.6–29.8 s** |
| P3 | **回退是静默的**：直连段与接收器**拒收原因零日志**，"为什么这次走了 11 分钟"当前不可观测 | `import-worker.ts` 直连段与 `direct-sync-ingest.ts` 全文无 log/stderr 语句 |
| P4 | **旧语义文案原样上屏**：三条"备份/临时数据库/切换数据库"文案经 `job.message` 直接显示给用户 | `import-worker.ts:635`、`:651-652`、`:758-760`；iOS `HealthKitSync.swift:2311-2314` 原样上屏 + `phase` 英文 token 兜底 |

### 1.2 目标（按优先级）

1. **降低回退率至 0**：合规载荷 100% 走直连车道（`direct`），`candidate`/`mixed` 新增为 0。
2. **删除候选链路**：从同步工作流中移除 `backupCopy`/`backupVerify`/`stagingCopy`/`activationSwap`/`activation_verify`，单次同步回到 **5–30 s**。
3. **拒收显式化 + 可观测**：超界/不合规载荷返回明确错误码与日志，客户端可据此拆批；不再"悄悄降级"。
4. **文案收口**：同步状态文案来自受控词表，服务端不再输出内部维护语义。
5. **恢复保障先行**：任何触碰生产前，取得**带校验的冷备**并完成**副本上的恢复验证**（当前生产无校验、无演练，这是唯一硬阻断项）。

### 1.3 范围

**In scope（本方案要做）**
- 服务端 `apps/api`：同步链路（import-worker / direct-sync-ingest / direct-sync-plan / import-database-tasks）、准入与错误码、观测日志、文案、`/v1/handshake` 能力位、`RAI_IMPORT_MAX_ZIP_BYTES`、CLI 写入口锁（`packages/application/src/cli.ts`）。
- iOS `apps/ios`：单批预算（页边界）、真实 `hasMorePages`、多页续传接线、状态文案映射、相关门禁脚本。
- 生产运维：冷备、定时器清理、部署与观察期操作。
- 后置（阶段 5，可选）：旧模块退役（import-publication / restore-journal / storage-sqlite 的文件换库发布器）。

**Out of scope（本方案明确不做）**
- **PostgreSQL 迁移（审查报告"路径 B"）**：需用户显式书面授权反转 A18 后另行立项；本方案的全部收益不依赖它。
- 每次上传的**服务端分片**（chunked continuation）：`import_batch_partitions` 无写入方，断点续传前提不成立（审查 P0-5/P0-6）。本方案用"iOS 页级分批 + 整批重放"替代。
- Web 双 UI 改版、窄屏/响应式区（`AGENTS.md` 冻结区）、HealthKit 后台机制扩展、Rust 引擎切换。
- 数据库 schema 变更：**本方案不新增任何迁移**（回滚简单性的前提，务必保持）。

### 1.4 成功判据（总表，最终以 §6 用例与 §5.5 生产指标为准）

| 维度 | 判据 |
|---|---|
| 车道 | 部署后新增正常同步作业 100% `direct`；`candidate`/`mixed` 新增 = 0 |
| 耗时 | p50 ≤ 30 s；`performance_json` 无任何 `backup*`/`activation*` 阶段 |
| 结构 | 主库 inode 不变（`statSync(main).ino`）；`var/` 无新增 `backups`/`rai.importing.*` 临时库 |
| 观测 | 任一拒收产生含 `jobId` + 错误码的结构化日志 |
| 资源 | `MemoryPeak < MemoryMax×0.85`（< 1,190 MiB）；24 h 零 OOM |
| 数据 | 账目幂等：重复批次不重复计数；删除不复活；游标只在 `succeeded` 后推进 |

---

## §2 现状锚点（全部于 `51b19cf` 亲测核实）

### 2.1 代码与链路现状（服务端）

**直连两车道**（`import-worker.ts:556-623`）：

| 环节 | 位置 | 说明 |
|---|---|---|
| 车道判定（纯函数，6 条否决理由） | `direct-sync-plan.ts:47-56` | `not_queued` / `fast_path_disabled` / `engine_<name>` / `engine_version_mismatch` / `payload_is_a_complete_snapshot` / `no_existing_database`；**无体积判据** |
| 快通路（record-only） | `import-worker.ts:572`（`dataOnlyApply`） | 拒收 → 继续统一接收器 |
| 统一接收器（事实+账本+回执+分析登记同事务） | `import-worker.ts:597`（`directSyncApply`）→ `direct-sync-ingest.ts:413` | 提交点唯一：`store.commitCallerTransaction()`（`:613`） |
| **回退候选链路** | `import-worker.ts:617-620`（决策）→ `:624-822`（实现块） | 备份→校验→暂存→CLI→重算→换库；三处旧文案 `:635`、`:651-652`、`:758-760`；成功文案覆盖 `:806` |
| 提交前 3 项回读断言 | `direct-sync-ingest.ts:590-612` | 账目齐全 / 分析任务真在 / 回执真落库（**保留，不得删**） |
| 写守卫（fail-closed 表清单 + TEMP 触发器） | `direct-sync-ingest.ts:183-220` | 34 张 `analysis` 类表拒写；`INGEST_TABLE_DISPOSITIONS` 共 67+ 条声明 |
| 单批上界 | `direct-sync-ingest.ts:56-64` | XML/manifest ≤ **2 MiB**（`DATA_ONLY_MAX_XML_BYTES`，`record-delta-policy.ts:15`）；记录 ≤ **5,000**；route ≤ **200 文件 / 32 MiB** |
| 超界处置（现状） | `direct-sync-ingest.ts:274-302`（`preparePayload` 的 7 处 `return null`）、`:415`、`:418`、`:421` | 一律 `return null` → 回退候选链路 |
| 身份资格 | `direct-sync-ingest.ts:358-362`（`eligibleIdentity`）、`:421`、`:450-451` | 需 `dataset_version` + `import_completed_at` + `parser_contract_version` + `parser_identity_algorithm` 四项齐备 |
| 全库校验（两次） | `import-database-tasks.ts:15-27`（`PRAGMA quick_check`）；调用点 `import-worker.ts:1213`（backupVerify）、`:1727`（activation_verify） | 另有 `:248`（启动恢复，保留）、`:1749/:1790/:1820/:1832/:1836`（激活/回滚路径，随候选删除处置） |
| 备份接口已退役 | `server.ts:1957-1964`（POST 410）、`:1978-1984`（DELETE 410）；文档 `deploy/README-UBUNTU.md:110-127` | 备份责任移交运维 `deploy/backup-runtime.sh` |
| 直连开关 | `server.ts:168-169`、`:477`（`RAI_IMPORT_DATA_ONLY_FAST_PATH`，默认 `1`）；`deploy/rai.env.example:17` | 现状 `=0` 退回候选链路（**收口后该语义要改，见 §4.2**） |
| ZIP 上限 | `server.ts:132`（默认 4 GiB）；`deploy/rai.env.example:9`；`import-sources.ts:98-106`（解压 12 GiB / 存储 16 GiB / 余量门 512 MiB） | 现状默认值威胁磁盘（50 GB 盘，已用 17 GB） |

**候选链路测试耦合（删除时必须同批处置）**：`apps/api/test/worker.test.ts`（12 处直接调用 `activateDatabase` 等方法）、`direct-sync-prohibited-operations.test.ts:340-363`（**阳性对照靠旧候选路径证明守卫有牙**）、`restore-journal.test.ts`、`import-publication.test.ts` 等 10+ 文件（完整清单见附录 §10.3）。

### 2.2 现状（iOS）

| 项 | 位置 | 说明 |
|---|---|---|
| 游标推进核心 | `HealthKitRecordCursor.swift:18-32`（`drain`） | `while true` 拉页（`limit: 1000`，`HealthKitExport.swift:955`），仅当 `added` 与 `deleted` 同时为空才收手；**无预算** |
| drain 调用点 | `HealthKitExport.swift:897`（`writeGlobalRecords` 内） | 逐条写 `export.xml`（`FileHandle`，创建于 `:340-342`；写函数 `:1436`） |
| 续传判定硬编码 | `HealthKitSync.swift:1659-1664` | `hasMorePages: false`（`:1661`）+ `deletionOnlyPage: false`（`:1662`）—— 预算落地前恒为假 |
| 游标唯一提交点 | `HealthKitSync.swift:1726`（`taskStore.commitSuccess`） | 闸门 `DirectSyncCursorPolicy.decision`（`:1648-1651`）在前；失败/取消一个字都不写 |
| 续传持久化 | `SyncTaskState.swift:48`（`pendingRecordCursors`）、`:97`（`needsContinuation`）；`SyncTaskStore.swift:383`（`commitSuccess` 事务） | 已具备骨架 |
| 状态文案 | `HealthKitSync.swift:23`（`enum DirectSyncCopy` 六句）；上屏 `:2311-2314`（`job.message` 原样 + `job.phase` 英文兜底） | 六句文案为 §10.3 受控词表，由门禁逐字钉死 |
| 幂等与重试 | `HealthKitSync.swift:2178`（`X-RAI-Sync-Batch: payloadHash`）；409 `mutation_conflict` 自动重试 `:2214-2222` | 保留契约 |
| 后台预算（时间） | `BackgroundSyncPolicy.swift:164`（`softBudget=120s`）、`:225`（仅接在轮询上）、`:116`（`maxForegroundRounds=1`） | **时间预算不替代载荷预算** |
| 上传 | `HealthKitSync.swift:2768`（multipart 文件名 `apple-health-healthkit.zip`）→ `POST /v1/imports/uploads` | 全流程 1 ZIP = 1 上传（现状：整个增量一次装包） |
| 导出清单 | `HealthKitExport.swift:436-441` | 恒定 `"version": 2` + `"sourceScope": "healthkit"` + `deletedRecords`/`deletedSourceIds` —— **iOS 从不产生全量快照** |
| 能力位读取 | `APIModels.swift:21`（`RaiHandshake.factsAnalysisContractVersion`）；`HealthSyncIdentityPublisher.swift:28` | iOS 读 **`/v1/handshake`**（不是 `/v1/health`） |

### 2.3 生产运行现状（Stage 0 报告摘要，用于验收对照）

- 主库 `rai.sqlite` 2,303,938,560 B / 迁移 **36/36 无缺号** / 67 用户表 + 7 视图 + 12 触发器 / `freelist=0`；控制库 176,128 B、**30 行**；运行库 `import_jobs` 保留窗口 242 条。
- 服务器：2 vCPU / 1,935 MB / swap 已用 229.6 MB / 磁盘 50 GB 已用 17 GB；`rai-api` MemoryCurrent 594.6 MiB、**MemoryPeak 1,100.7 MiB（已触 MemoryHigh=1100M）**、MemoryMax 1,400M、CPUQuota 150%；OOM 0（日志窗口 11 天）。
- 备份：日志 1,342 行、1,334×HTTP 200（09-04 → 10-13）；接口退役后定时器 10-13 16:26:11 停用；现存 3 份工件（6.3 GB）**无校验、无恢复演练**。
- 生产 `var/` 残留：4 个 stale 锁目录；本地 `var/`：**79 个 `.import.lock.stale.*` 目录 + 12 个 `.import.lock.candidate.*` 文件**（本次复核一致）。

### 2.4 仓库工具链现状（验收命令的前提）

| 项 | 事实 |
|---|---|
| 全量测试 | `npm test`（`scripts/run-tests.mjs`）会并行跑重文件（`worker` 单跑 349 s、`server-runtime` 443 s）；**默认并发下会出现"全量红、单跑绿"** ⇒ 全量验收用 `RAI_TEST_CONCURRENCY=2 npm test` |
| 提交钩子 | `.githooks/pre-commit`：blob≤1.5 MB、`typecheck`、`check:docs`、`check:scripts`；**触碰 `apps/ios/` 时跑 `test:ios`**，Windows 上会跳过并**要求 `RAI_IOS_UNVERIFIED=1` 显式认账**（跳过≠通过） |
| iOS 门禁 | `npm run check:ios-gates` 在 Windows 可跑全部 **10 支**跨平台 Python 门禁（本次实测绿）；`check-direct-sync-status-copy.py`（48 checks）、`check-healthkit-record-sync.py`（31 checks，含 `:58` limit 1000 / `:66` drain 驱动生产查询 / `:104` 恢复分支计数 **== 5**） |
| iOS 编译/真机 | 只在 macOS（`run-ios-gates.sh` 判 `uname -s`）；Windows 侧只能做实现 + 文本门禁 |
| 部署 | `deploy/upgrade.sh`（默认 dry-run；`--apply`；`--migrate --database` 显式授权）；健康判据 = `status=ok && databaseReady=true`（不能只看 HTTP 200） |
| 冷备脚本 | `deploy/backup-runtime.sh`：默认 dry-run；`--apply` 停服→整 runtime tar→`SHA256SUMS`→恢复原服务状态；**输出目录必须在 runtime 树之外** |
| 迁移 CLI | `npm run data:migrate -- --database PATH [--apply]`（默认只读预演；默认自动备份） |
| 探针模板 | `C:\Users\Administrator\Desktop\subagents\RAI_STAGE_0_SERVER_READONLY_PROBE_{3,4,5,6}.sh`（生产只读取证可复用改造） |

### 2.5 保留清单（动不得，删除即有断链风险）

| 模块 | 为什么保留 |
|---|---|
| `mutation-coordinator.ts` + `task-admission.ts` | 进程内单写者仲裁 + FIFO 调度 + 409 `mutation_conflict`（**iOS 消费契约**，`HealthKitSync.swift:2214-2222`） |
| `write-lease.ts` | 主线程↔worker 线程写许可移交；删它 → 分析退回"整轮持锁" |
| `publication-lock.ts`（`.import.lock`） | 跨进程互斥（`server.ts:170`、`parser/cli.ts:204`、`migrate-cli.ts:35`、`model-v2-cli.ts:57`），且经 `packages/health-export-parser/src/index.ts:56` 公共导出 |
| `record-delta-policy.ts`（2 MiB/5000 常量） | 被 3 个生产文件消费并对外导出；删掉后服务端**没有任何载荷上界**（两条直连都用 `readFileSync` 整体读入） |
| `import-payload-identity.ts` | 准入↔落库摘要同源校验（防 TOCTOU，`direct-sync-ingest.ts:291-300` 调用） |
| `read-store-manager.ts` | 承载 `database_not_ready`（409）与 `PRAGMA data_version` 读缓存失效；只可简化"换库排空"，不可删文件 |
| `direct-sync-plan.ts` | 结构守卫（`directSyncParserOptions` 写死 `preserveAbsent:true`）—— 与存储无关 |
| 提交前 3 项回读断言 + 写守卫 | 账本完整性的证明，删掉后"账目齐全"退化为声称 |

### 2.6 对初稿的修正记录（重要——实施时以本节为准）

| # | 初稿说法 | 实况 / 修正 |
|---|---|---|
| R1 | 发布顺序"先服务端、后 iOS" | **反转为"iOS 分批版先行（阶段 2），服务端收口版后行（阶段 3）"**。理由：收口版会令**旧 iOS 的超界批次硬失败**（它没有拆批能力，重试同一载荷 → 该批同步停摆），而 Stage 0 已实测到直连尝试 5/8 被拒（原因未见日志，不能假定旧包全部合规）；反向顺序下 iOS 分批版在**旧服务端上即可收割主要收益**（每批 ≤ 上界 → 直连接住 → 回退率归零） |
| R2 | 预算"在完整 XML 实体边界切页" | **只能按"页边界"切**。`HKAnchoredObjectQuery` 的 anchor 粒度是页（opaque，无实体级续传点）：页中途停 → 要么重读整页（预算恒定 ⇒ 同一位置反复停 = **死循环**），要么跳到页尾（**丢数据**）。修正为：drain 每消费完一页检查预算，超限即在该页**末尾**返回 `(page.next, hasMorePages:true)`；保证每轮至少消费 1 整页 |
| R3 | `directSyncBounds` 放 `GET /v1/health` | 放 **`/v1/handshake`**（capability bits 的既有位置；iOS 已在此读 `factsAnalysisContractVersion`）。`/v1/health` 只做就绪判据 |
| R4 | 备份命令 `--output-dir /var/lib/rai/var/backups/stage0-verified` | **会被脚本拒绝**（"Backup output must be outside the runtime tree"）。修正：`sudo bash deploy/backup-runtime.sh --output-dir /srv/rai-backups`（先 dry-run 再 `--apply`；root 执行，因需 `systemctl stop`） |
| R5 | 候选块范围 `:617-810`；文案 `:651-652` | 修正：决策在 `:617-620`；实现块 `:624-822`；文案三处 = `:635`、`:651-652`、`:758-760`；成功文案覆盖 `:806`；`activationSwap` 包裹 `:793-801` |
| R6 | `database-file-publisher.ts`（未注路径） | 实际位于 **`packages/storage-sqlite/src/database-file-publisher.ts`**（`packages/storage-sqlite/src/index.ts:12` 再导出） |
| R7 | 阳性对照处理未提 | 补：`direct-sync-prohibited-operations.test.ts:340-363` 依赖旧候选路径；删除 run() 候选块后**改写为直接调用保留方法的对照**（见 S3.4） |
| R8 | "移除 `import-database-tasks.ts` 的 quick_check 调用"表述过宽 | 修正：只移除**同步链路**的两处（`:1213`/`:1727`），保留 `:248` 启动恢复；`import-publication.ts:98` 的 rollback 校验随阶段 5 退役一并处置 |

---

## §3 前置条件

### 3.1 阻断级（不满足则不得开始任何生产操作）

| # | 条件 | 操作 | 验收 |
|---|---|---|---|
| C1 | **带校验的生产冷备（唯一硬阻断）** | 维护窗口内：`sudo bash deploy/backup-runtime.sh --output-dir /srv/rai-backups`（dry-run 确认）→ `--apply` | 产出 `rai-runtime-<UTC>-<pid>/{runtime.tar, SHA256SUMS, format-version.txt}`；`sha256sum -c SHA256SUMS` 通过；**tar 含 4 个库（主/控制/运行/侧车）与 `etc` 身份配置**；记录磁盘余量 |
| C2 | **恢复能力验证（副本上，不触碰生产）** | 解包 tar 到 `/srv/rai-backups/restore-verify/`；对副本执行 `PRAGMA quick_check`（主库约 200–300 s）+ 打开控制库/运行库计数 | 三个库 `quick_check=ok`；主库计数与本报告 §2.3 一致（44 表实测口径）；**恢复记录落盘归档** |
| C3 | **门禁基线全绿并记录** | `npm run typecheck && RAI_TEST_CONCURRENCY=2 npm test && npm run check:docs && npm run check:scripts && npm run check:ios-gates` | 全绿；输出存档（此后任何阶段不得让基线变红；重文件失败的假红先用法 §2.4 的并发旋钮排除） |
| C4 | 生产基线快照（只读） | 复用 `RAI_STAGE_0_SERVER_READONLY_PROBE_6.sh`（Desktop\subagents） | 记录 HEAD/迁移版本/逐表行数/Memory 四件套/磁盘，作为验收对照 |

### 3.2 强建议级（P1，可在阶段 0 一并完成）

| # | 项 | 操作 | 备注 |
|---|---|---|---|
| C5 | 本地开发库升级 v36 | `npm run data:migrate -- --database D:/running/var/rai.sqlite --apply` | 本地现为 **v22 / 45 用户表**；升级后与生产 schema 对齐，阶段 1-3 的本地验收才有意义（默认自动备份） |
| C6 | 生产失效定时器清理 | 先 `cp /etc/systemd/system/rai-backup.{timer,service} /root/rai-backup-units.bak/` → `systemctl disable --now rai-backup.timer`（应已 disabled/inactive）→ 删 unit → `systemctl daemon-reload` | 当前"接口已 410、unit 仍在盘上"的中间态会让后来者误以为备份在跑；删除前必须留备份副本（可逆） |
| C7 | 残留锁清理 | 本地：先 `ls -d var/*.import.lock.stale.* \| wc -l`（应 79）、`ls var/*.import.lock.candidate.* \| wc -l`（应 12），核对后**移动到** `var/.cleanup-archive-<date>/`（可逆，勿直接删）；生产：4 个 stale 目录同法处置 | 保留清单证据（ls 输出存档） |
| C8 | 发布窗口确认 | 停手机同步（告知使用者）；导入/分析进行中不部署；`/v1/imports` 无在途批次 | 与 `deploy/README-UBUNTU.md` 既有发布纪律一致 |

### 3.3 环境能力边界（写清楚，避免白跑）

| 环境 | 能做 | 不能做 |
|---|---|---|
| Windows（当前工作机） | 全部 TS 实现与测试、`check:ios-gates`（10 支）、文档门禁、git 提交（iOS 改动需 `RAI_IOS_UNVERIFIED=1` 认账） | iOS 编译、模拟器/真机验收、`test:ios` 真跑 |
| macOS + Xcode | iOS 编译、`npm run test:ios` 全量、Simulator 验收（`apps/ios/tests/run-visual-tests.sh` 需 `var/rai.sqlite`） | — |
| 生产服务器（Linux） | 冷备、部署、只读取证探针、systemd 操作 | 无 Node 构建链以外的工具；不得在运行中 WAL 库上 `cp` 文件 |

### 3.4 明确禁止事项（全程适用）

1. 验收完成前**不删**任何旧 SQLite/备份（`rm -rf var/*.sqlite* var/backups` 一类动作一律禁止）。
2. 不新增 schema 迁移；不改 `deploy/rai-api.service` 的内存/堆参数（`apps/api/test/deploy-cloud.test.ts:12-33` 逐行钉死现行值）。
3. 不用 `RAI_IMPORT_DATA_ONLY_FAST_PATH=0` 当作"回退到候选"的手段（收口后语义已变，见 §4.2）。
4. 不在导入热路径上跑 `PRAGMA quick_check` 全库（2.15 GB ≈ 200–300 s）；副本上除外。
5. 不绕过既有门禁（`--no-verify`、改弱测试预算换绿灯）。
6. 对生产数据库的任何写操作前必须有 C1+C2 完成的记录。

---

## §4 总体设计

### 4.1 端到端流程（目标态）

```text
[iOS HealthKit]
   │ 1. 读已提交游标 (anchor + recordCursors)
   │ 2. 按单批预算导出：每消费完一页(limit 1000)检查预算，超限即在页末尾停止
   │    → (nextAnchor, hasMorePages=true)；页边界=实体边界（不切半条 <Record>）
   ▼
[POST /v1/imports/uploads]  幂等键 X-RAI-Sync-Batch: <payloadSha256>
   ▼
[POST /v1/imports/inspect]  ← 新增「直连预检」：输入树 / 字节 / 条数 / 身份
   │   ├─ 不合规 ──► 同步 400 + 错误码 + bounds/actual（不建 job，不产生任何副作用）
   │   └─ 合规 ────► 继续
   ▼
[POST /v1/import-jobs] ──► 异步作业（direct 车道，唯一通道）
   ▼
[主库单一原地写事务 (BEGIN IMMEDIATE)]           ← 现状已实现（direct-sync-ingest.ts）
   ├─ 写守卫（34 张分析表拒写）                    :183-220
   ├─ 增量事实 Upsert（content_hash 比对 + 墓碑优先）
   ├─ 路线版本原子发布（SAVEPOINT）
   ├─ 账目 + 回执 + 分析任务登记 同事务
   └─ 提交前 3 项回读断言 ──► COMMIT               :590-612
   ▼
[唤醒分析消费者（2ba4b2c 已上线：onTerminal→schedule + 60s 兜底巡检）]
   ▼
[iOS 轮询 GET /v1/import-jobs/:id → succeeded（仅此时才提交游标）]
   ├─ 3. commitSuccess：sync.sqlite 单事务写 anchor/recordCursors + 清任务行
   └─ 4. needsContinuation=true ⇒ 立即续跑下一页（页→提交一对一）
```

**与现状的唯一结构差异**：回退分支（候选链路）被替换为**显式拒绝**；其余链路原样保留（这是本方案改动面最小的原因）。

### 4.2 服务端设计（收口版）

**D1 · 车道判定收口**：`planDirectSyncLane` 保持不动（理由保留，便于测试钉住）；worker 对 `lane !== "direct"` 的处理从"落候选"改为**显式失败**：

| 否决理由 | 收口后行为 |
|---|---|
| `fast_path_disabled`（`RAI_IMPORT_DATA_ONLY_FAST_PATH=0`） | 503 `direct_sync_unavailable`（语义从"退回候选"变为"暂停同步入口"；回滚改用发布回退，见 §8） |
| `engine_<name>` / `engine_version_mismatch` | 503 `direct_sync_unavailable`（附当前引擎与期望版本） |
| `payload_is_a_complete_snapshot`（`preserveAbsent=false`） | 400 `direct_sync_full_snapshot_unsupported`（缺席即删除停用；手工全量重建走 CLI） |
| `no_existing_database` | 503（先 `data:migrate` 建库，再让 iOS 增量初始化） |
| `not_queued` | 500（编程错误；API 路径恒 queued） |

**D2 · 拒收错误码化**（`direct-sync-ingest.ts` 的 `return null` 全部拆分为带码错误）：

| 现状 null 点 | 收口后 |
|---|---|
| `:277`（缺 export.xml/导出.xml 或 manifest）、`:278`（输入树不合规）、`:287`（缺 v2 身份） | 400 `direct_sync_input_not_allowed`（附 `reason`） |
| `:282`、`:284`、`:288`（删除数超限）、`:290`（XML 超限） | 400 `direct_sync_payload_exceeds_bounds`（附 `bounds` + `actual`） |
| `:421`（库文件不存在 / 待迁移 / 身份不符） | 503 `direct_sync_unavailable` / 409 `direct_sync_baseline_rebuild_required`（见 D3） |
| `:615-618`（写守卫 / 身份竞态） | 不再折成 null；守卫触发 = 500 内部完整性错误（**绝不再是回退理由**） |

**D3 · 空库就地初始化**（替代"空库必走候选"）：将 `:421` 与 `:450-451` 的 `eligibleIdentity` 拆成三态：

1. **四项身份键全缺**（`dataset_version`、`import_completed_at` 均无）⇒ 允许首包**就地初始化**：在既有事务内写入 `import_manifest` 四要素（现有 `:566-575` 已写 metadata，只是把 `previousVersion` 兜底为固定引导符、并跳过 `:451` 的身份抛错）。
2. **身份键在但契约/算法不匹配** ⇒ 409 `direct_sync_baseline_rebuild_required`（数据在、代际不符，混用两代身份有风险；需运维显式处置：CLI 全量重建，或暂时回退旧版服务端）。
3. 齐备 ⇒ 现状路径。

约束（验收必须覆盖）：初始化仅发生在 `recordIdentity` 齐备的 v2 载荷上；写完后 `dataset_version`/`import_completed_at` 落库，后续批次自动走常规增量；**清墓碑/缺席删除逻辑不进这条路径**（`preserveAbsent` 恒 `true`）。`import_generations` 单例行由 v34 迁移种入（`v34-migration.ts:42-49`），无需额外初始化。

**D4 · bounds 契约**：`/v1/handshake` 增加：

```json
"directSyncBounds": { "maxXmlBytes": 2097152, "maxRecords": 5000, "maxRouteFiles": 200, "maxRouteBytes": 33554432 }
```

数值单一来源 = `direct-sync-ingest.ts:56-64`（引用 `record-delta-policy.ts:15-16`）；缺字段的旧服务端 ⇒ 客户端用保守常量（见 §5.3）。同时更新 iOS `RaiHandshake`（`APIModels.swift`）与 `check-direct-sync-contract-parity.py` 的扫描（如需要）。

**D5 · 观测（拒收可观测）**：在**主线程**（worker 任务返回处与 inspect 端点）统一落结构化日志：`jobId` / `code` / `stage` / `actual` / `bounds` / `inputPath` 摘要；worker 线程内不直接打日志（线程通道不保证聚合），只返回结构化 `{code, stage, actual, bounds}`。验收：任构造一次拒收，`journalctl -u rai-api` 可 grep 到 `jobId + code`。

**D6 · 文案收口**：随 D1/D2 的删除动作，`:635`、`:651-652`、`:758-760` 三条旧语义文案**随候选块一起消失**；同步版失败文案沿用受控词表（现状 `:866-867` 已是受控中文）。随后把 `check-direct-sync-status-copy.py` 的旧文案哨兵扫描范围扩到服务端同步文件（**先删文案、后扩扫描，同批提交**，避免门禁红）。

**D7 · `RAI_IMPORT_MAX_ZIP_BYTES`**：默认 4 GiB → **64 MiB**（`server.ts:132` + `deploy/rai.env.example:9`）；生产 env 若显式设置了该键需同步改 `/etc/rai/rai.env`（先核对 19 个既有键）。依据：iOS 分批后单批 ZIP 上界 = XML ≤2 MiB + routes ≤32 MiB + 包壳，64 MiB 有 ≥1.9× 余量；旧值威胁 50 GB 磁盘。风险与旧客户端兼容见 §7。

**D8 · CLI 写入口**：`packages/application/src/cli.ts:39` 裸开主库 → 改为先获取 `.import.lock` 发布锁（与 server 同一原语），拿不到即拒绝并提示走 API。对应 `publication-lock.ts` 的 4 个既有调用点风格。

### 4.3 iOS 设计（分批与续传版）

**I1 · 单批预算（页边界）**：
- 计数口径：`export.xml` 的**写入字节**（在唯一写函数 `HealthKitExport.swift:1436` 收口累加）+ 记录条数；预算值取服务端 bounds × 0.9（缺 handshake 字段时用常量 `1.8 MiB / 4500`）。
- 停止点：**只在页末尾**（见 R2）；`drain` 返回 `(anchor, hasMorePages)`；本轮提前停止时，未处理的类型保持旧游标，`hasMorePages=true` 冒泡到导出结果。
- route 计量：文件数与合计字节纳入同一预算判断；超限即本轮停止继续纳入新 route（**不做跨批 route 拆分**——超限文件列入风险 R-06，处置=显式失败 + 下轮重试，绝不静默丢）。
- 硬约束：**drain 的语义修改不得破坏**既有门禁断言（`check-healthkit-record-sync.py:58/66` 要求 `limit: 1000` 形态与 `HealthKitRecordCursor.drain` 驱动生产查询）；`check-export-determinism.py` 的夹具字节不得变化（预算只在超限时改变输出，夹具远小于预算）。

**I2 · 多页续传接线**：`HealthKitSync.swift:1659-1664` 的 `hasMorePages: false` 换真实值；`commitSuccess`（`:1726`）保持**唯一提交点**不动；`needsContinuation` 经 `persistPendingReceipt` 落盘（`HealthKitSync.swift:1927-1930`），并按既有约定**不认领后台意图**（`SyncFollowUp` 语义）。
**已知约束（必须处理）**：`maxForegroundRounds = 1`（`BackgroundSyncPolicy.swift:116`）是"新代次补跑"额度，会把"同一次导出的下一页"也限量 ⇒ 校验方向：把"有待续页"与"新代次"区分（`handoff` 增加维度），前台允许**有界页循环**，后台轮次继续兜底；以 T2 用例钉住"中断后下一唤醒继续且不重不漏"。

**I3 · 文案映射**：`HealthKitSync.swift:2311-2314` 的 `message = job.phase` 英文 token 兜底移除/收敛为受控映射；本地文案与 `DirectSyncCopy` 六句保持单一入口（门禁 `check-direct-sync-status-copy.py` 逐字钉住，不得另抄）。

**I4 · 服务端错误码的客户端处置**：inspect/job 层新错误码（§4.2 D2）在 iOS 侧的处置原则：**可读提示 + 任务行保留可续接 + 不推进 anchor**；超界码（`..._exceeds_bounds`）按"下轮预算收敛"处理（本期实现=显著提示 + 保持可重试；自动"减半重导"列入后续，非验收项）。

### 4.4 错误码词典（新增部分）

| code | HTTP | 触发 | 客户端期望 |
|---|---|---|---|
| `direct_sync_payload_exceeds_bounds` | 400 | XML/manifest/删除数超上界 | 拆批重传 |
| `direct_sync_input_not_allowed` | 400 | 输入树/必需文件/v2 身份不合规 | 修载荷；陈旧客户端升级 |
| `direct_sync_full_snapshot_unsupported` | 400 | `preserveAbsent=false` | 改用增量（本系统 iOS 从不产生该形态） |
| `direct_sync_baseline_rebuild_required` | 409 | 身份键在但契约/算法代际不符 | 人工处置（CLI 重建 / 回退版本） |
| `direct_sync_unavailable` | 503 | 开关关闭 / 引擎不匹配 / 库未就绪 / 待迁移 | 退避重试；运维介入 |
| `mutation_conflict` / `database_not_ready` | 409 | **既有契约，不变** | 既有自动重试 |

---

## §5 分阶段实施

> 每步格式：**操作（含锚点/命令）→ 输入 → 输出 → 验收 → 回滚**。提交纪律：一步一提交、message 如实（iOS 未验证不得写"门禁全绿"）。

### 5.0 阶段总览与发布顺序

| 阶段 | 内容 | 预计 | 生产变更 |
|---|---|---|---|
| **0** | 前置与安全基线（C1–C8） | 0.5–1 天 | 冷备 + 只读清理 |
| **1** | 服务端·**观测与契约版**（不改行为） | 0.5–1 天 | 部署一次（低风险） |
| **2** | iOS·**分批与续传版** | 2–3 天 | TestFlight/真机 → 全量 |
| **3** | 服务端·**收口版**（显式拒绝 + 删候选 + 文案 + MAX_ZIP + CLI 锁） | 1–1.5 天 | 部署一次 |
| **4** | 生产验收与观察期 | 0.5 天 + 观察 7–14 天 | 无 |
| **5** | 旧机制退役（可选、后置） | 3–5 天 | 部署若干次（逐项可 revert） |

**发布顺序图（关键决策 R1）**：

```text
阶段1 观测版 ──► 阶段2 iOS 分批版 ──► 观察(回退率↓, 拒因分布) ──► 阶段3 收口版 ──► 阶段4 观察期
   （不改行为）      （在旧服务端即收割收益）        （数据支撑后才切硬拒收）
```

为什么不能倒过来：收口版 + 旧 iOS = 超界批次**永久 400**（旧 iOS 无拆批能力，重试同载荷；Stage 0 实测直连尝试 5/8 被拒且原因不明）⇒ 同步停摆直到 iOS 更新。而分批版 iOS 打旧服务端：每批 ≤ 上界 ⇒ 直连接住 ⇒ **回退率立即归零、单次回到 30 s 级**。两段式把"删回退"从"赌旧客户端合规"变成"有观测数据支撑的收口"。

---

### 5.1 阶段 0 · 前置与安全基线

| 步骤 | 操作 | 输入 | 输出 | 验收 |
|---|---|---|---|---|
| S0.1 | 执行 C1 冷备（`sudo bash deploy/backup-runtime.sh --output-dir /srv/rai-backups` → `--apply`） | 生产 `/var/lib/rai` | `rai-runtime-<UTC>-<pid>/` 含 `runtime.tar`+`SHA256SUMS` | `sha256sum -c` 通过；记录停服时长与磁盘余量 |
| S0.2 | 执行 C2 恢复验证（副本解包 + `quick_check`） | S0.1 产物 | 恢复记录（含三库 quick_check 结果与计数） | 全部 `ok`；计数与 Stage 0 基线一致 |
| S0.3 | 执行 C3 门禁基线 | `51b19cf` 工作树 | 全绿记录（含 `RAI_TEST_CONCURRENCY=2 npm test`） | 全绿；未绿项先排查（禁止带着红基线开工） |
| S0.4 | 执行 C5 本地库迁移 | `D:/running/var/rai.sqlite`（v22） | 迁移回执（dry-run→apply 两段输出） | `max(version)=36`；`git status` 干净（本地库在 var/ 已忽略） |
| S0.5 | 执行 C6/C7 清理（timer 备份后删除；本地/生产残锁**移动**归档） | `systemctl cat` / `ls` 输出 | unit 备份副本 + 归档目录 + `ls` 前后对照 | 归档前后计数（79/12/4）逐一对上；`systemctl list-timers \| grep rai-backup` 空 |

**本阶段回滚**：S0.1/S0.2 纯新增（保留备份即可）；S0.5 的删除项均有备份副本/归档目录可复原。

---

### 5.2 阶段 1 · 服务端·观测与契约版（不改同步路径行为）

> 目的：先让"为什么回退"可见、把 bounds 契约暴露出来，供阶段 2 的 iOS 使用；**本版不改变任何拒绝/回退行为**，风险≈日志量。

| 步骤 | 操作 | 输入 | 输出 | 验收 |
|---|---|---|---|---|
| S1.1 | 观测埋点：在 `direct-sync-ingest.ts` 的 7 处 `return null` 与 `import-worker.ts:617-620` 回退点，改为返回/附加结构化拒因（先不动控制流，`ReturnReason` 随返回值上抛到 worker，落 `performance_json` 与日志） | `direct-sync-ingest.ts:274-302`、`:415-421`、`import-worker.ts:556-623` | diff + 日志样例 | 单测：每类构造载荷（缺文件/超界/身份不合/引擎不符）产生一条含 `jobId`+`reason` 的日志与 `performance_json.rejection`；`npm test` 全绿 |
| S1.2 | bounds 契约：`/v1/handshake` 增加 `directSyncBounds`（D4） | `server.ts:927-950`（handshake） | 响应 JSON + 契约测试 | `curl /v1/handshake` 可见字段；`check-direct-sync-contract-parity.py` 绿 |
| S1.3 | 观测记录：把每次同步的**车道决策**写进 `runtime.sqlite` 作业遥测（在既有 `performance_json` 增加 `lane` 字段即可，不新增表） | `import-worker.ts:556-563` | 字段样例 | 本地跑一条直连、一条回退，`import_jobs.performance_json.lane` 分别为 `direct` / `fallback(reason)` |
| S1.4 | 部署观测版（`sudo bash deploy/upgrade.sh` dry-run → `--apply`） | S1.1-1.3 提交 | 线上新 HEAD + 健康检查通过 | `status=ok && databaseReady=true`；随后 24–72 h 观察：拒因分布、回退率基线落表 |
| S1.5 | 观察数据归档：用探针脚本（§2.4 模板）导出最近 N 条 `performance_json` 的 `lane/rejection` 分布 | 生产 `runtime.sqlite` 只读 | 分布报告 | 明确"当前回退主因"（超界 / 身份 / 引擎 / 其他），作为阶段 3 收口顺序的依据 |

**本阶段回滚**：纯日志/字段新增与一次普通发布；回滚=上一版发布物（`deploy/upgrade.sh` 流程可重放）。**不影响数据与协议**。

---

### 5.3 阶段 2 · iOS·分批与续传版

> 目的：让"正常同步"永远不超上界 ⇒ 在旧服务端上就把回退率打到 0；同时把多页续传闭环打通。

| 步骤 | 操作 | 输入 | 输出 | 验收 |
|---|---|---|---|---|
| S2.1 | 预算模型实现：`HealthKitRecordCursor.drain` 返回值扩展为 `(anchor, hasMorePages)`；在 `HealthKitExport.swift` 唯一写函数（`:1436`）收口累加字节+条数；**页边界**停止（R2） | `HealthKitRecordCursor.swift:18-32`、`HealthKitExport.swift:897-921`、`:1436` | Swift diff + 纯逻辑回归 | 新增纯逻辑用例：给定 N 字节/条预算，断言"停在第 k 页末尾 + nextAnchor=该页 next + hasMorePages=true"；**反例**：断言不在页中途停 |
| S2.2 | 预算取值：handshake `directSyncBounds × 0.9`；缺字段回落常量（1.8 MiB / 4500 条 / route 按 0.8×） | S1.2 契约；`APIModels.swift` | Swift diff | 回归：两态（有/无 bounds 字段）各自解析；旧服务端路径可跑 |
| S2.3 | 续传接线：`:1661` 换真实 `hasMorePages`；页循环与 `maxForegroundRounds` 的关系定稿（I2 约束） | `HealthKitSync.swift:1659-1664`、`BackgroundSyncPolicy.swift:110-137` | Swift diff + 用例 | T2（多页）用例通过；T9（锚点不推进）保持绿；`check-healthkit-record-sync.py` 全绿（含 `:104` 计数按需**改写而非删除**） |
| S2.4 | 文案收口（iOS 侧）：移除/收敛 `:2311-2314` 的 phase 兜底；新增"未识别 message 不直出"断言 | `HealthKitSync.swift:23`（`DirectSyncCopy`）、`:2302`（软预算文案） | Swift diff | `check-direct-sync-status-copy.py` 48+ checks 绿；新增反例夹具（写回旧兜底即红） |
| S2.5 | 门禁与回归全跑：`npm run check:ios-gates`；macOS 上 `npm run test:ios` + Simulator 导出 `check-export-determinism-live.py` | 工作树 | 全绿记录 | Windows 侧 10 支绿；macOS 侧全绿；**提交时若仍在本机：`RAI_IOS_UNVERIFIED=1` 认账，且 message 不得写"全绿"** |
| S2.6 | TestFlight/真机灰度（1 台） | S2.5 产物 | 灰度构建 | T1/T2/T3/T9 通过；界面**不出现**旧文案；同步链路日志显示批次 ≤ 上界 |
| S2.7 | 全量 iOS | 灰度通过 | 正式版 | 连续 3 天：`candidate`/`mixed` 新增 = 0；`performance_json` 无 `backup*`/`activation*`；单次 5–30 s（对照 Stage 0 的 9.9–13.3 min） |

**本阶段回滚**：iOS 版本可回退重装；**服务端无需回滚**（仍是观测版）；预算功能对新/旧服务端均兼容（缺字段回落常量）。数据面：预算只改变"分批大小"，不改变事务语义 —— 回滚无数据影响。

---

### 5.4 阶段 3 · 服务端·收口版（显式拒绝 + 删除回退 + 文案 + 上限 + CLI 锁）

> 前置：S1.5 的观察数据已归档、S2.7 的"零回退"已达成。**若观察显示回退主因不是载荷超界**（如身份/引擎），先处置根因再收口。

| 步骤 | 操作 | 输入 | 输出 | 验收 |
|---|---|---|---|---|
| S3.1 | 错误码化：实现 §4.2 D2 的映射；`preparePayload`/`applyDirectSyncImport` 的 null 语义全部替换为带码错误；inspect 预检（同步 400）与 worker 兜底同源判据 | `direct-sync-ingest.ts`、`direct-sync-plan.ts`、`import-routes.ts:85-87` | diff + 用例 | 构造超界载荷：**inspect 同步返回 400 `direct_sync_payload_exceeds_bounds`（不建 job）**；主库 `statSync(main).ino` 不变；`var/` 无 `backups`/`rai.importing`；`performance_json` 无 `backup*` |
| S3.2 | 空库初始化（D3）：拆三态；空库 fixture 走就地初始化 | `direct-sync-ingest.ts:421`、`:450-452`、`:566-575` | diff + 用例 | T1：空库（v36、四项身份全缺）+ v2 载荷 ⇒ 就地初始化成功、写齐四要素；随后普通批次零备份；**非空库合同不符 ⇒ 409 `direct_sync_baseline_rebuild_required`** |
| S3.3 | 删除候选回退块：移除 `import-worker.ts:617-620` 的落候选与 `:624-822` 实现块内的**调用链**（备份/校验/暂存/CLI/激活）；`run()` 在该点改为"终态失败 + 错误码"；清理随之未用变量与三条旧文案 | `import-worker.ts:624-822` 及周边 | diff（大） | `npm test` 全绿（含改写后的 worker.test.ts）；`grep -n "backup\|quick_check\|activateDatabase" apps/api/src/import-worker.ts` 在同步路径 0 命中 |
| S3.4 | 测试迁移：① worker.test.ts 12 处审计（直接调方法的用例保留；模拟整流程走候选的用例改写为"显式失败"）；② 阳性对照改写（R7：直接调用保留方法证明守卫有牙） | `worker.test.ts`、`direct-sync-prohibited-operations.test.ts:340-363` | diff + 全绿 | `RAI_TEST_CONCURRENCY=2 npm test` 全绿；阳性对照仍能"变红"（突变验证一次） |
| S3.5 | 文案门禁扩展：先确认三处旧文案已随 S3.3 消失，`grep -rn "备份并校验现有数据\|临时数据库增量同步\|验证完成正在切换本地数据库" apps/api/src` 为 0；随后把 `check-direct-sync-status-copy.py` 的旧文案原始文本扫描扩到服务端同步文件（修正其 TS `//` 注释剥离盲区） | 门禁脚本 | diff | 门禁绿；反例夹具（人为写回旧文案 ⇒ 红）验证一次 |
| S3.6 | `RAI_IMPORT_MAX_ZIP_BYTES`：默认改 64 MiB + `rai.env.example`；核对/更新生产 `/etc/rai/rai.env`（先 `grep -oE '^[A-Z_]+=' ` 核对键名） | `server.ts:132`、`deploy/rai.env.example:9` | diff + env 变更记录 | 上传 65 MiB 测试包被拒（413/400 语义按现状）；正常批次不受影响 |
| S3.7 | CLI 锁（D8）：`packages/application/src/cli.ts:39` 获取 `.import.lock` | `cli.ts`、`publication-lock.ts` | diff | 单测：服务运行中运行 `npm run data:recompute` 被拒（拿到锁或明确报错），不再裸写 |
| S3.8 | 部署收口版 + 旧客户端兼容核对 | S3.1-3.7 提交 | 线上新 HEAD | ① 新 iOS 同步全绿；② 用**当前生产版 iOS**（未更新设备/旧构建）构造小批次：正常；构造超界批次：job 失败且错误码可见、任务行可续接、无重复导入；③ 观察 24 h 无 5xx 增长 |
| S3.9 | 文档收口：更新 `docs/SQLITE_DIRECT_SYNC_DESIGN.md` §10.3 相关引用、`deploy/README-UBUNTU.md` 快通路小节（开关语义变更）；`npm run check:docs`；如行号漂移涉及基线文档，跑 `node scripts/check-doc-line-refs.mjs` 并按提示更新基线 | docs | diff | `check:docs` 绿；`check:doc-refs` 无越界 |

**本阶段回滚**：见 §8.2 —— 服务端两级回滚（发布回退 / 紧急开关暂停），无数据面风险（本方案无 schema 迁移）。

---

### 5.5 阶段 4 · 生产验收与观察期

| 步骤 | 操作 | 验收（对照 Stage 0 基线） |
|---|---|---|
| S4.1 | 部署后即刻核对 | `git rev-parse HEAD` = 新发布提交；健康检查 ok；`systemctl show rai-api -p MemoryCurrent -p MemoryPeak` 无异常抬升 |
| S4.2 | 运行期指标（复用探针模板） | ①②③ 全部成立：① 新增同步作业 **100% direct**，`candidate`/`mixed` = 0；② 单次 **5–30 s**、`performance_json` 无 `backup*`/`activation*`；③ 主库 inode 全程不变、`var/` 无新临时库 |
| S4.3 | 资源与日志 | `MemoryPeak < 1,190 MiB`；24 h OOM 0；拒收日志（若发生）含 `jobId`+`code`；`journalctl` 无未处理 5xx 峰值 |
| S4.4 | 观察期（**7–14 天**） | 零人工干预、零数据差异、零重复计数；期间至少覆盖一次"大增量"（多页）与一次"删除批次"场景 |
| S4.5 | 收尾：旧备份/旧库**仍不删**（留到阶段 5 或用户确认）；把 S0.1 冷备移出运行树离线保存 | 归档件校验通过 |

---

### 5.6 阶段 5 · 旧机制退役（可选、后置）

> 前置：阶段 4 验收通过 + 用户确认。原则：**逐项独立提交、每项给出"零调用者 + 能力有替代"双证据、可单独 revert**。本阶段不改数据。

| 顺序 | 退役项 | 前置条件 | 验收 |
|---|---|---|---|
| S5.1 | `import-publication.ts` | 先改 `runtime-state.ts:251`（`DELETE FROM import_publications` 的建表耦合）；10 个引用它的测试文件按新语义迁移 | 运行期无 `no such table`；`npm test` 全绿 |
| S5.2 | `restore-journal.ts` + `maintenance.ts`/`server.ts` 引用 | 恢复/删除能力有替代（保留 `deploy/backup-runtime.sh` 路径与 `/v1/backups/:name/restore` 语义说明）；`maintenance.test.ts` 断言**改写而非删除** | 42 条断言全绿（改写后）；503 语义文档化 |
| S5.3 | `packages/storage-sqlite/src/database-file-publisher.ts` + `import-worker` 的 `activateDatabase`/`createCurrentBackup`/`installDatabase`/`moveDatabaseFile` 等方法与 `worker.test.ts` 直调用例 | S5.1 完成 | `grep -rn` 零调用者；`check-doc-links` 绿（同步更新 `docs/DATA_PIPELINE.md`、`docs/DECISIONS.md` 链接） |
| S5.4 | `direct-sync-prohibited-operations` 契约清单瘦身（`packages/contracts/src/direct-sync.ts`）+ 阳性对照终态 | S5.3 完成 | 契约测试按"直连禁项=接口面"重列；突变验证阳性对照仍可红 |

**不做**：不删 `direct-sync-plan.ts` / `mutation-coordinator.ts` / `task-admission.ts` / `write-lease.ts` / `read-store-manager.ts` / `publication-lock`（§2.5）。

---

## §6 验收用例总表（本地可执行；映射阶段）

| # | 场景 | 构造 | 断言 | 阶段 |
|---|---|---|---|---|
| T1 | 空库首次同步 | 迁移到 v36 的空库 + v2 载荷 | 就地初始化；四要素落库；**零备份/零候选**；后续批次走常规增量 | S3.2 |
| T2 | 历史积压多页 | 游标落后（如 12,000 条/多页） | 按页切分、每页 ≤ 预算；每页 `succeeded` 后 anchor 推进一次；中断页不推进；重试不重复计数 | S2.3 |
| T3 | 普通增量 | 日常批次 | 单批一次上传；`backupCopy`/`activationSwap`=0；分析任务与事实同事务登记 | S2.7 |
| T4 | 重复上传（同 payload） | 重放同 `X-RAI-Sync-Batch` | 同一 job、`replayed=true`；事实行数不变；**分析任务不重复** | 既有（`:430-442`） |
| T5 | 同 batchId 内容不同 | 篡改 payload | 409（`direct-sync-ingest.ts:433-435` 语义）；主库零变化 | 既有 |
| T6 | 部分批次失败 | 第 k 页注入失败 | 前 k-1 页已提交；第 k 页不推进；重试幂等 | S2.3 |
| T7 | 进程重启（批内） | kill -9 事务中途 | 整批回滚；`loadJobs` 判 `attempts<3` 重排队；无半批事实 | 既有 |
| T8 | 重启（提交后回执前） | kill -9 在 COMMIT 后 | 按回执判 `succeeded`；不重复导入 | 既有（`:827-836`） |
| T9 | anchor 提交失败 | sync.sqlite 写失败 | **不推进** anchor；可续接而非 failed；下轮从旧游标重导不丢 | 既有（`:1726` 闸门语义） |
| T10 | 删除记录 | manifest 带 `deletedRecords`/`deletedSourceIds` | 写墓碑 + `removed` 账目 + `deleted_at` 软删 | 既有 |
| T11 | 删除后重放旧数据 | T10 后重放含已删实体 | 实体保持删除（墓碑优先）；`deleted_at` 不被清空 | 既有（`database.ts:3240-3248`） |
| T12 | GPX 更新 | 同一 workout 换 GPX | 新版本发布后读侧才可见（`route_versions`）；发布前用旧版本 | 既有 |
| T13 | GPX 超界 | 文件数/字节超限 | 显式 400（非静默回退）；主库零变化 | S3.1 |
| T14 | 重算失败 | 注入异常 | `recompute_jobs=failed`；`active_model_run` 不切换；读侧仍读旧已发布结果 | 既有 |
| T15 | 重算并发/去重 | 并发触发同 dependency generation | 唯一未终态任务（唯一约束生效）；状态不回退 | 既有+（若做去重增强） |
| T16 | 全量窗口 NULL 语义 | 全量 + 部分窗口 | 合并后仍全量（`CASE WHEN a IS NULL OR b IS NULL THEN NULL ELSE LEAST(a,b) END`） | 既有（`:384-395`） |
| T17 | 并发写冲突 | 导入中并发写端点 | 409 `mutation_conflict`（iOS 自动重试路径不变） | 既有 |
| T18 | 跨进程互斥 | API 运行中跑 CLI | 被锁/明确拒绝（S3.7） | S3.7 |
| T19 | 就绪态 | 空库请求 `/v1/mobile/today` | 409 `database_not_ready`（不得空 200） | 既有 |
| T20 | §14.1 禁止操作 | 直连两车道全程 | 零备份、零候选、零 `quick_check`、零换库、零整表 canonical 重建（阳性对照改写后仍能证明"守卫有牙"） | 既有 + S3.4 |
| T21 | 旧 iOS 兼容 | 旧构建打收口版服务端 | 小批次正常；超界批次：错误可见、任务可续接、无重复导入 | S3.8 |

**本机执行命令**（一次备齐）：

```bash
npm run typecheck
RAI_TEST_CONCURRENCY=2 npm test          # ⚠️ 默认并发会出现"全量红、单跑绿"的假象
npm run check:docs && npm run check:scripts && npm run check:ios-gates
python apps/ios/tests/check-direct-sync-status-copy.py
python apps/ios/tests/check-healthkit-record-sync.py
# macOS 侧（阶段 2 必跑）：
#   npm run test:ios && bash apps/ios/tests/run-visual-tests.sh（需 var/rai.sqlite）
```

---

## §7 风险登记册

| # | 风险 | 触发条件 | 影响 | 缓解 | 残余 |
|---|---|---|---|---|---|
| R-01 | **恢复能力未验证**（唯一硬阻断） | 触碰生产前未完成 C1/C2 | 任何事故无回退路径 | C1 冷备 + C2 副本恢复验证；观察期内旧备份不删 | 恢复演练仅覆盖"解包+完整性"；完整业务恢复演练仍建议季度执行 |
| R-02 | **旧 iOS × 收口服务端**：超界批次硬失败 | 先上收口版（违反 R1 顺序） | 该批同步停摆直至 iOS 更新 | **按 §5.0 顺序**：iOS 先行；收口前以 S1.5 数据确认回退主因已消除 | 旧构建强刷场景需现场更新 App（单用户系统，可控） |
| R-03 | 页边界停止的**进度死锁**（若实现成实体级/中途停） | 预算实现偏离 R2 | 同一位置反复停（或丢数据） | S2.1 的反例用例钉死；至少消费 1 整页的约束 | 单页超上界（极端记录类型）→ 显式 400 可见，列入 R-06 |
| R-04 | **多页 × `maxForegroundRounds=1`** 打架 | 首次大积压 | 续传变慢（要多次唤醒） | S2.3 定稿维度拆分；前台有界页循环；后台轮次兜底 | 极端积压的首次全量仍是多轮（设计使然，非故障） |
| R-05 | 拒收错误码与 iOS 旧文案表错位 | S3 先于 iOS 更新 | 用户看到未知错误文本 | 错误码词典集中管理；iOS 未识别码回落到安全文案（S2.4 断言） | — |
| R-06 | 单文件/单页超上界 | 极端 GPX/记录 | 该批 400 | 显式可见 + 保持可续接；不得静默丢；后续可加"单文件超限"专用处置 | 本期接受 |
| R-07 | 测试迁移漏网（候选删除） | S3.3/S3.4 不同批 | 全量测试红 | S3.3+S3.4 同一提交；`RAI_TEST_CONCURRENCY=2` 验全量 | — |
| R-08 | MAX_ZIP 下调影响旧客户端大包 | 旧 iOS 重装/全量场景上传 >64 MiB | 上传被拒 | 与 iOS 分批同期发布；发布说明标注；如遇阻临时调回（env 可改） | 旧构建首次同步须先更新 App |
| R-09 | 观测缺失导致误判（历史教训 D-9） | 只看 `message` 不看遥测 | 错误结论 | 一律以 `performance_json`/账本取证；任何 `0` 必须有阳性对照 | — |
| R-10 | 生产部署与 iOS 时序错位 | 双轨期拉长 | 收益延迟 | 阶段 1/2/3 各设观察闸门，不达标不放行下一阶段 | — |

---

## §8 回滚方案（分级）

### 8.1 总原则

1. **本方案无 schema 迁移、无数据迁移** ⇒ 回滚面向"功能可用性"，不面向"数据一致性"；数据始终在 WAL 原子事务内，失败=回滚。
2. 每阶段独立提交、可单独 revert；生产回滚 = 回退发布物（上一部署提交重建），**不是**改数据库。
3. 观察期内**旧备份与旧发布物始终保留**；删除动作只发生在阶段 5 且需用户确认。
4. 回滚动作与"当前处于哪个阶段"绑定（下表）；**永不使用**"删除数据文件"作为回滚手段。

### 8.2 分级回滚动作

| 级别 | 场景 | 动作 | 验证 |
|---|---|---|---|
| L1 功能开关（仅限阶段 1 期间） | 观测版引入异常 | `RAI_IMPORT_DATA_ONLY_FAST_PATH=0` + 重启 —— 观测版语义仍是"退回候选链路"（未收口），可临时止血 | 同步恢复走候选（慢但可用）；修好后置回 `=1` |
| L2 服务端发布回退（贯穿全程） | 收口版/任何新版异常 | ① 首选：在 gitee `git revert <发布提交>` → `sudo bash deploy/upgrade.sh --apply`；② 应急：`git -C /opt/rai checkout <上一部署提交>` → `npm run build` → `systemctl restart rai-api` | 健康检查 `status=ok && databaseReady=true`；旧 iOS 同步恢复；`git rev-parse HEAD` 与预期一致 |
| L3 iOS 版本回退 | 分批版异常 | 重装上一构建（TestFlight/本地 archive）；服务端无需动（观测版对两版 iOS 都兼容） | 旧行为恢复；期间批次可能再次回退候选（慢但不丢） |
| L4 数据修复路径 | 极端：误判导致重复导入/游标异常 | 停服务 → 用 C1 冷备或既有 `var/backups` 工件恢复副本 → 定位后仅替换受影响库文件（**须保持与 `-wal`/`-shm` 一致的恢复流程，禁止裸 `cp` 活跃库**） | 恢复后 `quick_check` ok + 计数对账 + iOS 从已提交游标重导 |
| L5 停止推进 | 观察期发现不可解释差异 | 停用后续阶段（不部署下一版）；按 R-09 用遥测取证；必要时 L2 | 决策记录留档 |

### 8.3 各阶段回滚速查

| 阶段 | 回滚方式 | 备注 |
|---|---|---|
| 0 | 备份副本/归档目录复原（S0.5 的删除项） | 纯运维动作 |
| 1 | L2（回退发布物）；或 L1（临时止血） | 观测版风险最低 |
| 2 | L3 | 服务端不动 |
| 3 | L2 | 收口版回退后旧 iOS/新 iOS 均恢复旧行为（慢但可用） |
| 4 | 不回滚（只观察） | 不达标 ⇒ 不进入阶段 5 |
| 5 | 逐项 revert（每项独立提交） | 文档链接同步回退 |

### 8.4 明确不可逆点

- **无**。本方案最重的动作是"删除候选回退调用链"（S3.3），它由 L2 恢复（回退到旧发布物即恢复旧代码路径）。
- 数据侧唯一注意：阶段 2 之后 iOS 会**更快地产生更多小批次**（这是目标），若期间需要回退到"旧行为"，历史已提交批次不会重放，也不会丢——回退只影响"之后的新批次走哪条路"。

---

## §9 术语表

| 术语 | 定义 |
|---|---|
| **直连车道 / direct** | 服务端原地增量写入通道（`data-only` + `direct-sync` 两条子车道），零备份、零换库、零全库校验 |
| **候选链路 / candidate（旧链路）** | 备份→暂存副本→CLI 全量/增量导入→重算→文件换库的旧同步通道（本方案删除其调用链） |
| **mixed** | 先试直连、被拒后走完候选链路的作业（Stage 0 分类口径） |
| **页（page）** | `HKAnchoredObjectQuery(limit: 1000)` 一次返回的最大集合；**anchor 的唯一可持久化粒度** |
| **页边界停止** | 预算触顶时只在页末尾退出（返回 `page.next`），保证无重读死循环、无跳过丢数据 |
| **预算 / budget** | iOS 单批导出上界（字节+条数），取服务端 `directSyncBounds × 0.9` |
| **回执（receipt）** | `import_manifest` 中 `rai.applied-import.*` 的持久写凭证；游标推进的前提 |
| **账目（ledger）** | `import_entity_changes`（本批实体级前后值）+ `rai_direct_sync_writes`（提交前核对） |
| **代次（generation）** | `import_entity_generations` 的逐实体批次 token（防旧批次覆盖新数据）；`import_generations` 的 raw/dependency 计数器 |
| **墓碑（tombstone）** | 显式删除标记（实体级/来源级）；"墓碑优先"= 载荷带已删实体也不写 |
| **受控词表** | §10.3 六句同步状态文案 + 服务端 message 用词约定（中文，禁内部 token） |
| **bounds** | `directSyncBounds`：XML/manifest ≤2 MiB、记录 ≤5000、route ≤200 文件/32 MiB |
| **A18** | 仓库设计文档中对"SQLite 原地直连"路线的既有决策判据（本方案不反转、不依赖 PG） |
| **写守卫** | `installDirectSyncWriteGuards`：fail-closed 表分类 + TEMP 触发器拒写分析表 |

---

## §10 附录

### 10.1 关键行号索引（@`51b19cf` —— 改代码后请用门禁漂移工具复核）

| 主题 | 锚点 |
|---|---|
| 车道判定/否决理由 | `apps/api/src/direct-sync-plan.ts:47-56`；形状守卫 `:68-97` |
| 直连两车道调用 | `apps/api/src/import-worker.ts:572`（data-only）、`:597`（direct-sync） |
| 回退决策 + 候选实现块 + 三处旧文案 + 成功文案 | `import-worker.ts:617-620`、`:624-822`、`:635`、`:651-652`、`:758-760`、`:806` |
| 单批上界常量 | `apps/api/src/direct-sync-ingest.ts:56-64`；`packages/health-export-parser/src/record-delta-policy.ts:15-16` |
| 拒收点（null） | `direct-sync-ingest.ts:277/278/282/284/287/288/290/415/418/421`；catch `:615-618` |
| 写守卫 / 提交前断言 | `direct-sync-ingest.ts:183-220` / `:590-612` |
| quick_check | `apps/api/src/import-database-tasks.ts:15-27`；调用 `import-worker.ts:248/1213/1727`（+1749/1790/1820/1832/1836） |
| 备份接口 410 | `apps/api/src/server.ts:1957-1964`、`:1978-1984`；`deploy/README-UBUNTU.md:110-127` |
| 开关 / ZIP 上限 | `server.ts:168-169/477` / `:132`；`deploy/rai.env.example:9/17` |
| handshake | `server.ts:927-950`；iOS 模型 `apps/ios/RAI/APIModels.swift:21` |
| iOS drain / 写函数 / 上传 | `HealthKitRecordCursor.swift:18-32`；`HealthKitExport.swift:897/955/1436`；`HealthKitSync.swift:2768` |
| iOS 续传/文案/重试 | `HealthKitSync.swift:1659-1664/1726/2311-2314/2178/2214-2222`；`SyncTaskState.swift:48/97`；`SyncTaskStore.swift:383`；`BackgroundSyncPolicy.swift:116/164` |
| CLI 裸写 | `packages/application/src/cli.ts:39`；锁 `packages/storage-sqlite/src/publication-lock.ts` |
| 阶段 5 退役锚点 | `runtime-state.ts:251`；`maintenance.ts:8/117/131`；`packages/storage-sqlite/src/database-file-publisher.ts` |

### 10.2 生产观察与取证（复用 Stage 0 模板）

- 探针：`RAI_STAGE_0_SERVER_READONLY_PROBE_{3,4,5,6}.sh`（`C:\Users\Administrator\Desktop\subagents\`）；改为只读 `lane/rejection` 分布与 `performance_json` 阶段表导出。
- 关键只读查询口径：`runtime.sqlite.import_jobs` 最近 N 条 → `status/phase/performance_json`；`performance_json` 中 `backupCopy/backupVerify/stagingCopy/activationSwap/activation_verify` 必须为 0/缺失；`stat` 主库 inode 前后一致。
- 任何 `0` 结论必须附阳性对照（历史教训：D-9 三次测量缺陷）。

### 10.3 测试耦合清单（删除候选块时逐一对账）

`apps/api/test/worker.test.ts`（12 处）、`direct-sync-prohibited-operations.test.ts`（阳性对照）、`import-publication.test.ts`、`restore-journal.test.ts`、`server-runtime.test.ts`、`import-queue-live.test.ts`、`import-worker-direct-sync.test.ts`、`direct-sync-ingest.test.ts`、`direct-sync-analysis-reconcile.test.ts`、`data-only-import.test.ts`、`data-only-import-queue.test.ts`、`analysis-failure-isolation.test.ts`。

### 10.4 一页纸执行清单（打印用）

```text
[ ] C1 冷备（backup-runtime.sh --apply） + sha256 校验
[ ] C2 副本恢复验证（三库 quick_check）
[ ] C3 门禁基线绿（RAI_TEST_CONCURRENCY=2 npm test）
[ ] C5 本地库 → v36  [ ] C6 timer 清理  [ ] C7 残锁归档
[ ] S1 观测版上线 → 72h 观察（拒因分布落表）
[ ] S2 iOS 分批版：实现→门禁→macOS 验收→灰度→全量
[ ] S2.7 连续 3 天：candidate/mixed = 0，单次 5–30s
[ ] S3 收口版：错误码→空库初始化→删候选块→测试迁移→文案门禁→MAX_ZIP→CLI 锁
[ ] S3.8 部署 + 旧 iOS 兼容核对
[ ] S4 观察期 7–14 天：零干预/零差异/零重复
[ ] （用户确认后）S5 旧机制退役，逐项 revert 友好
```

---

**文档边界声明**：本版全部"现状"论断均于 2026-10-14 在 `51b19cf` 工作树与 Stage 0 生产只读证据上核实；数值引用不晚于该时间点。实施期间如代码行号漂移，以 `git blame` + §10.1 主题锚点重新定位，勿按行号盲改。
