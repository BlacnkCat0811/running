# RAI 架构可视化审计报告（只读）

审计对象：`D:\running`，Git revision `60678af97e4710cfd8444b3952df9fff09c2bff3`（`git status --short` 仅显示未跟踪的 `.archify/`，因此报告中引用的都是已提交字节）。  
生成工具：已安装的 Archify Skill（`@tt-a1i/archify-dsh` v3.0.1，standalone HTML 输出）。  
本审计为**只读**：没有修改任何源码、配置、数据库或既有文档；没有安装依赖；没有执行迁移；没有启动服务。

## 0. 本目录文件清单

| 文件 | 内容 |
|---|---|
| [AUDIT-REPORT.md](AUDIT-REPORT.md) | 本报告：发现、差异、待人工核实项 |
| [architecture-system/architecture-system.html](architecture-system/architecture-system.html) | 图1 系统总架构（交互式） |
| [architecture-system/candidate.json](architecture-system/candidate.json) | 图1 规格（带 `path:line` 源码引用） |
| [dataflow-core/dataflow-core.html](dataflow-core/dataflow-core.html) | 图2 核心数据流（交互式） |
| [dataflow-core/candidate.json](dataflow-core/candidate.json) | 图2 规格 |
| [sequence-analysis/sequence-analysis.html](sequence-analysis/sequence-analysis.html) | 图3 服务端执行时序（交互式） |
| [sequence-analysis/candidate.json](sequence-analysis/candidate.json) | 图3 规格 |
| [architecture-database/architecture-database.html](architecture-database/architecture-database.html) | 图4 数据库读写关系（交互式） |
| [architecture-database/candidate.json](architecture-database/candidate.json) | 图4 规格 |
| [architecture-modules/architecture-modules.html](architecture-modules/architecture-modules.html) | 图5 模块依赖（交互式） |
| [architecture-modules/candidate.json](architecture-modules/candidate.json) | 图5 规格 |
| [architecture-risks/architecture-risks.html](architecture-risks/architecture-risks.html) | 图6 风险与边界（交互式） |
| [architecture-risks/candidate.json](architecture-risks/candidate.json) | 图6 规格 |
| [architecture-risks/DOC-SOURCE-DIFF.md](architecture-risks/DOC-SOURCE-DIFF.md) | 31 行文档声明 vs 源码实况逐行对照 |
| [verification/VERIFICATION.md](verification/VERIFICATION.md) | 独立对抗式核验（逐条 sources 复读） |
| [verification/verification.json](verification/verification.json) | 机器可读核验结果 |
| [verification/_ground-truth.md](verification/_ground-truth.md) | 核验方使用的独立事实底稿 |
| [../TEAM-BRIEF.md](../TEAM-BRIEF.md) | 本次审计的协作约束：只读边界、证据分级（A/B/C）、门禁命令 |

每张图旁另有 Archify 门禁回执：`<name>.finalize.json`、`<name>.finalize-summary.json`、`<name>.browser-check.json`、`<name>.delivery.json`。

> ⚠️ 本目录是**带日期的时点快照**：其中的 `文件:行号` 引用刻意对齐 `60678af`，**不要**随后续源码改动回写（`scripts/check-doc-line-refs.mjs` 的判读陷阱第 3 条：时点快照不能用来判漂移）。因此本目录不在该脚本的默认核对范围内，需要核对时请显式传入路径。

---

## 1. 结论摘要

1. **系统的核心不是"任务队列"，而是"单写者 + 一把跨进程发布锁"。** 三次源码证据一致：进程内 `MutationCoordinator`（冲突即 HTTP 409 `mutation_conflict`）、执行器级 `TaskAdmissionScheduler`（同一时刻只有一个 CPU 重写者，FIFO）、跨进程 `${db}.import.lock` 硬链接锁（API 启动即持有）。
2. **导入有两条并行存在的发布机制，而文档只写了一条，并且默认的那条正是文档没写的。** `planDirectSyncLane()` 在 engine=typescript、引擎版本一致、载荷为增量、主库已存在时选择**直连车道**——直接在主库内以 caller-owned 单事务提交事实、分析任务与回执；`RAI_IMPORT_DATA_ONLY_FAST_PATH` 缺省即为 `1`。文档描述的"私有候选 SQLite → 原子发布"仍是回退车道。
3. **"候选库"在当前默认路径上并不出现。** 因此任何把候选库画成必经环节的架构图都是错的；本报告产出的图 1 与图 6 都按"两条车道"表达。
4. **算法核心是纯 TypeScript 包，Rust 只是可选的解码/Record 写入热循环，且默认关闭**（`RAI_IMPORT_ENGINE` 默认 `typescript`；`RAI_RUST_FALLBACK` 默认 `none`）。它不是 WASM/napi，而是 CLI 子进程。
5. **已发现的真实边界缺口（源码证实，非推测）**：
   - 分析写租约**失败开放**：worker 等授权超过 30s 就撤回请求并继续写，该窗口没有单写者许可，只有诊断计数。
   - **存在无锁写者**：`npm run data:recompute` / `data:refresh-snapshots` 直接打开主库写入，`packages/application/src/cli.ts` 全文没有获取发布锁。
   - **锁文件残留无人回收**：`var/` 下有约 80 个 `rai.sqlite.import.lock.stale.*` 目录与 12 个 `.candidate.*` 文件，回收器的正则与 `isFile()` 判断显式跳过它们。
   - **两把互不相通的进程内锁**（`mutationCoordinator` 与 `sourceMutations`）以及独立的 `TryAcquireGate`。
   - **本机 `var/rai.sqlite` 停在 migration 22，源码定义到 36**；启动策略是拒绝自动迁移（`migrationPolicy: "refuse"`），因此本机数据集当前无法服务任何 v23+ 路由。

---

## 2. 交付物清单（工作区路径）

六张图 + 规格 JSON 全部位于独立审计目录 `.archify/rai-audit-20261013-160439/`，未覆盖任何既有文件。

| # | 图       | 交互式 HTML                                                                              | 架构规格 JSON                                                                 |
| - | ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1 | 系统总架构   | `.archify/rai-audit-20261013-160439/architecture-system/architecture-system.html`     | `.archify/rai-audit-20261013-160439/architecture-system/candidate.json`   |
| 2 | 核心数据流   | `.archify/rai-audit-20261013-160439/dataflow-core/dataflow-core.html`                 | `.archify/rai-audit-20261013-160439/dataflow-core/candidate.json`         |
| 3 | 服务端执行时序 | `.archify/rai-audit-20261013-160439/sequence-analysis/sequence-analysis.html`         | `.archify/rai-audit-20261013-160439/sequence-analysis/candidate.json`     |
| 4 | 数据库读写关系 | `.archify/rai-audit-20261013-160439/architecture-database/architecture-database.html` | `.archify/rai-audit-20261013-160439/architecture-database/candidate.json` |
| 5 | 模块依赖    | `.archify/rai-audit-20261013-160439/architecture-modules/architecture-modules.html`   | `.archify/rai-audit-20261013-160439/architecture-modules/candidate.json`  |
| 6 | 风险与边界   | `.archify/rai-audit-20261013-160439/architecture-risks/architecture-risks.html`       | `.archify/rai-audit-20261013-160439/architecture-risks/candidate.json`    |

配套证据与报告：

- `.archify/rai-audit-20261013-160439/architecture-risks/DOC-SOURCE-DIFF.md` —— 31 行文档 vs 源码逐行对照。
- `.archify/rai-audit-20261013-160439/verification/VERIFICATION.md` —— 独立对抗式核验（逐条 sources 复读）。
- `.archify/rai-audit-20261013-160439/verification/verification.json` —— 机器可读的核验结果。
- `.archify/rai-audit-20261013-160439/AUDIT-REPORT.md` —— 本报告。
- 每张图旁的 `<name>.finalize.json` / `.finalize-summary.json` / `.browser-check.json` —— Archify 交付回执。

### 2.1 门禁回执（`finalize` showcase，四道门全过才算通过）

下表由脚本从磁盘重算：`specBound` 表示回执记录的规格哈希与磁盘 `candidate.json` 实际哈希一致，`htmlBound` 同理对应产出的 HTML。

| # | 图       | `ok` | specBound | htmlBound | spec sha256（前 16 位） | artifact sha256（前 16 位） |
| - | ------- | ---- | --------- | --------- | ------------------- | ----------------------- |
| 1 | 系统总架构   | true | true      | true      | `22b2846ef325756a`  | `146740f328450e89`      |
| 2 | 核心数据流   | true | true      | true      | `5d6ab025db73b02b`  | `4c313996f54b949d`      |
| 3 | 服务端执行时序 | true | true      | true      | `c1523143e4159bd9`  | `46b39c16a876d743`      |
| 4 | 数据库读写关系 | true | true      | true      | `04d9c37d42349efe`  | `a4fa96738734fd42`      |
| 5 | 模块依赖    | true | true      | true      | `3132f2ce5f72c06b`  | `7016fb0f50f7aa5f`      |
| 6 | 风险与边界   | true | true      | true      | `7eace9855c29d345`  | `81ec0e9ab15ef554`      |

六个 HTML 另经独立检查：均为单文件、包含内联 `<svg>`、无任何远程引用（`remoteRefs=0`）、带 `viewport` 与深浅色主题支持，可离线打开。

### 2.2 独立核验结论（`verifier`，逐条 sources 复读）

| 图         | 结论                        | 主要/次要问题           |
| --------- | ------------------------- | ----------------- |
| 1 系统总架构   | **verified**              | 0 / 0             |
| 2 核心数据流   | **verified**              | 0 / 2（均为措辞，无事实错误） |
| 3 服务端执行时序 | verified-with-corrections | 1 主要 → **已修复**    |
| 4 数据库读写关系 | verified-with-corrections | 0 / 5（均为补充性）      |
| 5 模块依赖    | verified-with-corrections | 1 主要 → **已修复**    |
| 6 风险与边界   | verified-with-corrections | 0 / 4（均为措辞）       |

核验过程中被独立发现并已修复的实质缺陷（不是措辞）：把 `import-worker.ts:465-491` 当作"ImportWorker 装配"（真正位置是 `apps/api/src/server.ts:465-491`）；把 `publishDatabaseFile` 归给 API（只有 CLI 子进程调用它）；把 Rust record 热循环画在算法核心一侧（实际入口在解析器）；`migrations v2→v36` 应为 `v1→v36`；组件数 7 少于用户要求的 8–12；控制库声明缺少支撑引用；以及两次"回执哈希与磁盘文件不一致"的门禁绑定缺陷。

另有两处**核验意见经我方复核后被否定或修正**，记录在此以免误信：

- 核验方认为图3"没有任何一行从导入路径调度分析消费者"，据此判为主要缺陷。该结论**不成立**：`import-worker.ts:897-907` 的终态路径会调用 `runTerminalCallbackWithRetry`，后者在 `import-worker.ts:951` 调用 `queueOptions.onTerminal`，而该回调在 `apps/api/src/server.ts:483-490` 装配、其体内 `server.ts:517` 就是 `recomputeWorker.schedule()`。核验方的搜索漏掉了这一点，因为 `schedule()` 出现在一个回调体内而不是独立语句。不过其**表述层面**的意见成立：图3 原先从 `COMMIT` 直接跳到 `claim queued`，确实省略了这一跳，已补画。
- 核验方一度记录 `.archify/tools/check-geometry.mjs` 不存在；其本人已发更正，该文件确实存在。

---

## 3. 主要架构发现

### 3.1 单写者三级结构（源码证实 A）

| 层级     | 机制                                                                                             | 证据                                                                |
| ------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 进程内写互斥 | `MutationCoordinator.acquire()`，冲突抛 `MutationConflictError`（HTTP 409，code `mutation_conflict`） | `apps/api/src/mutation-coordinator.ts:11-25`                      |
| 执行器准入  | `TaskAdmissionScheduler`：同一时刻只有一个 CPU 重写者，等待者按 FIFO 保序，可 `blockUntilRestart`                   | `apps/api/src/task-admission.ts:9-43`                             |
| 跨线程写租约 | `Atomics` 共享内存序号协议（不是标志位），窗口约 0.07ms，超时 30s 失败开放                                               | `apps/api/src/write-lease.ts:64-108`                              |
| 跨进程发布锁 | `${db}.import.lock`，`writeFileSync('wx')` + `linkSync` 原子发布 owner，回收时留墓碑                       | `packages/storage-sqlite/src/publication-lock.ts:160-253`         |
| DB 级声明 | `recompute_jobs` 用 `BEGIN IMMEDIATE` + 条件 UPDATE 抢占任务                                          | `packages/storage-sqlite/src/recompute-job-repository.ts:104-129` |

### 3.2 两条导入车道（源码证实 A）

- **直连车道（默认）**：`planDirectSyncLane()` 的判定条件是 `queued && fastPathEnabled && engine==="typescript" && version 一致 && preserveAbsent && databaseExists`；命中后 `applyDirectSyncImport()` 以 `PRAGMA synchronous=FULL` → `beginCallerTransaction()` → SAX 解析 → GPX 导入 → canonical 化 → 递增 generation → **同事务登记 `import` 分析任务** → 写回执 → 提交前回读断言 → `commitCallerTransaction()`。  
  证据：`apps/api/src/direct-sync-plan.ts:47-56`、`apps/api/src/direct-sync-ingest.ts:444-469、495-524、589-613`。
- **候选库车道（回退）**：在线备份 → 候选副本 `var/rai.importing.<jobId>.attempt-N.sqlite` → 子进程跑导入 CLI → 分析 → 写回执 → `activateDatabase()`：checkpoint → 移 sidecar → 主库 rename 到 rollback → 安装候选 → 读校验，失败即回滚。  
  证据：`apps/api/src/import-worker.ts:654-682、1716-1729、1787-1824`、`packages/storage-sqlite/src/database-file-publisher.ts:19-35`。
- **两者都写同一个 `rai.sqlite`，但没有共享的发布不变量检查。** 独立核验未找到任何断言两条车道产物互通的代码（搜索 `lane`、`publishMode`、`publicationMode`、`importMode`）——这是风险图中的一个真实缺口。

### 3.3 幂等与原子性（源码证实 A）

- 写命令幂等键 = `sha256([scope, idempotencyKey])`，内容指纹 = `sha256(canonical({kind,payload}))`，不同内容复用同一 key 直接 409；**业务效果与回执共用同一个 `BEGIN IMMEDIATE`**，回执写 `import_manifest['rai.applied-command.<id>']`，重放返回旧结果。证据：`apps/api/src/command-queue.ts:107-123、177-219`。
- 导入接收对同一 `sourceId` 复用 `queued/running/succeeded` 的既有任务（202）。证据：`apps/api/src/routes/import-routes.ts:16-30`。
- 导入来源按 `import_sources.idempotency_key`（UNIQUE）去重。证据：`apps/api/src/runtime-state.ts:292、326`。
- 换库意图先落 `runtime.sqlite` 的 `import_publications`（`prepared` → `committed`），进程被杀后可依据 phase 回滚或确认，并在回滚前跑 `PRAGMA quick_check`。证据：`apps/api/src/import-publication.ts:62-118`。

### 3.4 读路径与换库的协调（源码证实 A）

读端通过 `ReadStoreManager.use()` 持有租约并以只读连接打开主库；换库前 `beginReplace()` 等待租约排空，上界 20s，超时抛 `DatabaseReplaceTimeoutError`（HTTP 409，code `database_busy`）。证据：`apps/api/src/read-store-manager.ts:9、52-64、94-122`。

### 3.5 外部依赖与信任边界（源码证实 A）

- 默认绑定 `127.0.0.1:8787`；`RAI_API_TOKEN` 可选。匿名读必须**同时**命中 `publicReadRoutes` 与 `publicReadHosts` 两张白名单。证据：`apps/api/src/server.ts:129-131、255-288`、`apps/api/src/local-request-security.ts:57-68`。
- 云部署经 Nginx 终止 TLS 并 `proxy_pass` 到回环。证据：`deploy/nginx-rai.conf:69、84`。
- 浏览器端**不请求任何地图瓦片**（内联 SVG）；AMap 仅在 iOS 端、且需隐私同意。证据：`apps/web/src/components/ShareCardPanel.tsx:21`、`apps/ios/RAI/MapPrivacy.swift:8-10、61-72`。
- 未发现任何 LLM/天气第三方 API 调用。
- 上传限额 4 GiB（`RAI_IMPORT_MAX_ZIP_BYTES` 默认 `4*1024**3`）。证据：`apps/api/src/server.ts:132、227-229`。

---

## 4. 文档 vs 源码差异（摘要，完整 31 行见 DOC-SOURCE-DIFF.md）

| 文档声明                                                                                                    | 源码实况                                                                                                     | 判词                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md:11-16` 管线图只有"私有候选 SQLite → 原子发布 → 主 SQLite"                                       | 默认路径不生成候选库：`apps/api/src/direct-sync-ingest.ts:449、613` 在主库内单事务提交                                        | **outdated（不全是错，是不全）**                                                                                                                        |
| `docs/ARCHITECTURE.md:53` `runtime.sqlite` 保存"来源/任务状态"                                                  | 它还保存 `mutation_commands` 与 `import_publications` 两张队列表                                                   | **incomplete**                                                                                                                                |
| `docs/ARCHITECTURE.md:59` 写命令具备 "revision/idempotency/generation" 约束                                    | 幂等与 revision 成立；队列表 `sequence/id/scope/status/payload` **没有 generation 列**                               | **overstated**                                                                                                                                |
| `docs/ARCHITECTURE.md:61` 候选必须过"完整性、数据代次与模型 gate"才可切换                                                   | 文件换库只做 checkpoint → rename → 读校验；代次绑定在直连车道，模型 gate 在重算发布                                                 | **overstated**                                                                                                                                |
| `docs/ARCHITECTURE.md:13` Rust 为"可选 Record 热循环（受限写许可）"                                                  | 一致，且默认关闭；直连车道显式拒绝非 typescript 引擎                                                                         | **matches**                                                                                                                                   |
| `docs/DATA_PIPELINE.md:6` 直连增量同步"设计，未上线"                                                                | 已上线且对合格载荷是默认                                                                                             | **outdated**                                                                                                                                  |
| `docs/DATA_PIPELINE.md:55` migrations "1–32"                                                            | 定义到 `version: 36`                                                                                        | **outdated**                                                                                                                                  |
| `docs/DATA_PIPELINE.md:76` / `docs/OPERATIONS.md:107` 应用不删除自建 rollback 文件                               | worker 在提交成功后确实删除 rollback 点并回收被替换库                                                                      | **contradiction**                                                                                                                             |
| `POST /v1/backups` 现在返回 410 `backup_creation_retired`，文案称"应用不再创建备份"（`apps/api/src/server.ts:1934-1939`） | 导入维护链路仍然创建 `var/backups/rai.before-web-import.<jobId>.sqlite`（`apps/api/src/import-worker.ts:1148-1171`） | **contradiction（两条陈述同时成立但互相矛盾）**                                                                                                              |
| `docs/DATA_PIPELINE.md:7` 称普通同步"不再执行项目备份、全库检查、候选主库复制或文件换库"                                              | 候选/维护链路仍在做备份、发布后 `quick_check`（`apps/api/src/import-worker.ts:1727-1729`）与 `rename` 换库（同文件 1718-1726）    | **overstated**                                                                                                                                |
| `README.md:11` 导入使用私有候选库                                                                                | 仅对回退车道成立                                                                                                 | **partially outdated**                                                                                                                        |
| `docs/ALGORITHM.md:330-333`、`docs/ARCHITECTURE.md:62` 模型发布/回滚合同                                         | 本次未逐条展开阅读                                                                                                | **cannot confirm**（独立核验已把 `ALGORITHM.md:330` 的 `not_evaluable` 一条升级为 A，证据 `packages/storage-sqlite/src/model-transition-gate.ts:302-303、313`） |

---

## 5. 风险与边界（源码证实，含缺口）

| #  | 风险                                                | 证据                                                                                                      | 等级 | 现状                                              |
| -- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -- | ----------------------------------------------- |
| R1 | 写租约失败开放导致超时窗口内无互斥                                 | `apps/api/src/write-lease.ts:87-103`                                                                    | A  | **真实缺口**：`stats.timeouts` 只回传，无阻断分支             |
| R2 | `data:recompute` / `data:refresh-snapshots` 无锁写主库 | `packages/application/src/cli.ts`（全文无锁）、`package.json:60、69`                                            | A  | **真实缺口**：跨进程单写者对其不成立                            |
| R3 | 锁/候选残留无人回收                                        | `packages/storage-sqlite/src/publication-lock.ts:177、203、213`；`apps/api/src/maintenance.ts:105-106、750` | A  | **真实缺口**：观测到约 80 个 stale 目录 + 12 个 candidate 文件 |
| R4 | 两把互不相通的进程内锁                                       | `apps/api/src/server.ts:372-374、1390`                                                                   | A  | 真实，但未观测到后果（源锁路径不写主库）                            |
| R5 | 两条发布机制无共享不变量检查                                    | `apps/api/src/import-worker.ts:1678` vs `apps/api/src/direct-sync-ingest.ts:413`                        | A  | **未找到守卫**                                       |
| R6 | 主库与 runtime/control 库无分布式事务                       | `apps/api/src/import-worker.ts:899`（激活后才写运行时终态）                                                         | A  | 顺序有意为之，`docs/OPERATIONS.md:104` 自己也承认           |
| R7 | 本机数据集落后 14 个 migration                            | `var/rai.sqlite` probe（max 22）vs `packages/storage-sqlite/src/database.ts:126-1677`                     | A  | 设计使然（拒绝自动迁移），但 v23+ 路由在本机不可用                    |
| R8 | 只读租约排水超时                                          | `apps/api/src/read-store-manager.ts:94-122`                                                             | A  | 已缓解：20s 上界后返回 409 `database_busy`               |


被证实**确实存在**的保护（不要当作缺口）：发布日志 + 三步激活顺序 + 硬链接锁、`import_manifest` 同事务回执、直连车道提交前回读断言（未登记的写会让提交被拒）、未分类表写入即失败的 TEMP 触发器、`recoverInterruptedRestore()` 与 `recoverInterruptedJobs()` 的启动恢复。

---

## 6. 仍需人工核实（UNKNOWN / C）

1. 生产环境中 `RAI_IMPORT_ENGINE` 是否被设为 `rust`（`deploy/rai.env.example:14` 为 `typescript`；主机上的 `/etc/rai/rai.env` 不可读）。
2. 本机 `var/` 下 4 个 `import_batches` 实际走的是哪条车道（本机库停在 v22，早于 `import_generations`/`route_versions`）。
3. `var/runtime.sqlite` 是"过期文件"还是 `import_publications` 从未在该 profile 创建（其 mtime 为 2026-09-07，而其 `-shm` 为 2026-10-13）。
4. `apps/api/src/data.ts`（约 105 KB 的 `RaiReadStore`）是否覆盖了每个端点的读模型。
5. `scripts/check-package-boundaries.mjs` 的具体禁线表（文档只举了 `package→app`、`Fitness→Readiness`）。
6. `mobile-goals.ts` / `mobile-coach.ts` / `coach-loop-runtime.ts` 的教练回路状态机与 `plan_operations` revision 语义。
7. `replayModel` / `resumeModelReplay` 的 checkpoint 恢复语义。
8. iOS 端是否有任何 Swift 代码**计算** CA/TA（而非仅渲染服务端值）。
9. `docs/ALGORITHM.md`（53 KB）与 `docs/COACH_LOOP_OPTIMIZATION_PLAN.md`（132 KB）的其余声明未审计。
10. `deploy/` 下的 Nginx/systemd 具体配置与移动端凭证隔离未审。
11. 构建机上是否配置了真实的 AMap key（`Info.plist` 引用 `$(RAI_AMAP_API_KEY)`）。

---

## 7. 关于 Archify 交付与"可视化审查"的诚实说明

- 六张图都用 `finalize`（showcase）交付，其四道门是 `validate` → `deliver` → `check` → 真实浏览器 `browser-check`。**只有 `ok: true` 的回执才算通过**；本报告不把任何非零退出写成成功。
- **自动化检查不等于人眼审查。** 本报告没有对渲染结果做像素级目视检查。回执中的 `visualReviewRecommendation` 仍对若干图给出建议（系统图 5 处交叉/3 处折弯、风险图 1 处、数据库图 8 处交叉/4 处折弯、模块图 2 处交叉/2 处折弯），其中多数是"共享同一端点"的分支汇合、并非真正的错线；但这些都**只是建议**，本报告不据此宣称"视觉质量已确认"。
- 环境说明：在受限沙箱会话中，Archify 因无法创建管道子进程（`spawnSync ... stdio:'pipe'` → `EPERM`）而无法产出回执，这是环境边界、不是候选缺陷。本次由具备完整权限的 Lead 会话统一执行全部门禁；各作者提交的"我未能自行取得回执"属于如实声明，不构成候选质量结论。

---

## 8. 本轮审计中被修正的关键错误（含我自己的）

1. **图1 初版把我自己写错了**：把 `import-worker.ts:465-491` 当作 `ImportWorker` 的装配处（真正位置 `apps/api/src/server.ts:465-491`）；把 `publishDatabaseFile` 归给 API（只有导入 CLI 子进程调用它，API 自己的换库走 `ImportWorker.activateDatabase()`）；把 Rust record 热循环画在算法核心一侧（入口在解析器）；`migrations v2→v36` 应为 `v1→v36`；组件数一度只有 7，低于用户要求的 8–12。这些都在独立核验后修正并重跑门禁。
2. **图1 初版漏掉了本次审计最重要的发现**：默认导入车道是主库内单事务的直连车道，而不是候选库换库。修正后图1、图4、图6 都改成"两条车道"的表述。
3. **图3 初版从 `COMMIT` 直接跳到 `claim queued`**，省略了终态回调唤醒分析消费者这一跳；已补画为 `终态回调触发 schedule()`（虚线，注明 `server.ts:517`）。
4. **图5 初版把 `features`/`training-load` 与 `scoring`/`readiness` 合并成一个"只依赖契约"的节点**，而白名单里存在 `features → normalization` 与 `training-load → readiness`；已拆成两个节点并补画这两条边。
5. **图4 先后出现两次"回执与磁盘文件不匹配"**：一次是作者在通过后再次改动坐标，一次是最后一次位置编辑落在通过之后。最终以"恢复通过版本的坐标 + 保留唯一必要的 sublabel 缩短"解决，并重跑到通过。
6. **核验方也有一次自我更正**：一度记录 `.archify/tools/check-geometry.mjs` 不存在，实际存在。

---

## 9. 复现方式（只读）

```bash
# 单张图重跑门禁（不修改任何项目文件）
node "<archify>/bin/archify.mjs" finalize architecture \
  .archify/rai-audit-20261013-160439/architecture-system/candidate.json \
  .archify/rai-audit-20261013-160439/architecture-system/architecture-system.html \
  --repo-root . --quality showcase --json

# 校验六张图的回执是否仍绑定磁盘字节
node -e "…"   # 见本报告 §2.1 所用方法：重算 sha256 与 .finalize.json 记录比对

# 检查产出物是否可离线打开
node .archify/tools/check-artifacts.mjs
```

