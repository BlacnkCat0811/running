# 阶段 4 实施验收复核与优化实施方案

**复核日期：** 2026-10-23（Asia/Shanghai）  
**范围：** [阶段 4 报告](PHASE4_REPORT.md)、四个分册、当前工作树的存储锁与冷备实现；基线 `main` / `36d79a95f42f854d54e7dfb91e27eb21152a1fa1`，阶段 4 改动尚未提交。  
**本文件性质：** 审查意见和下一批实施、验收方案；本文没有修改业务代码、部署生产或对生产数据做故障注入。

## 1. 审查结论

报告记录的全量测试结果和隔离恢复演练有原始证据：`evidence/SHA256SUMS` 中 21 个文件均通过 SHA-256 复核，`full-suite.log` 的结尾确为 2486 tests、2473 pass、0 fail、13 skip；隔离演练的 `rehearsal-1.json` 确为 29/29 checks。报告明确写出了生产配置、真实 systemd 和生产恢复未验证，这部分证据边界是恰当的。

但是，**G2/I1 与 G4/I8 目前不能按报告中的“通过”作为发布验收结论**。下面三个问题均能在一次性临时目录复现，且现有新增测试没有覆盖。它们是潜在失效路径，不代表生产已发生事故。建议在修复、补测、重写对应报告结论前暂停阶段 4 的提交与发布评审；原始日志应保留，不能改写为“当时已覆盖”。

| 编号 | 优先级 | 发现 | 直接影响 | 对原报告的修正 |
|---|---|---|---|---|
| R1 | P1，发布阻断 | publication lock 以词法 `resolve(databasePath)` 派生锁文件；同一 SQLite 文件的符号链接别名可取得另一把锁 | API/CLI 可同时成为同一物理库的写者，I1 未证明 | G2、T11、I1 从 PASS 改为“待修复复验” |
| R2 | P1，发布阻断 | 路径检查只检查列举的目录本身，不递归检查其中的符号链接；`tar` 默认把链接归档为链接 | 导入原件/工件/保护快照可能指向根外，manifest 显示 `complete`，恢复后文件不可读，I8 未证明 | G4、T12、I8 从 PASS（隔离）改为“正常样例通过，路径闭包待修复复验” |
| R3 | P1，发布阻断 | 检查器在 `RAI_DATABASE` 缺省时按 `<runtime>/var/rai.sqlite` 推断；API 的缺省却是 `<projectRoot>/var/rai.sqlite` | 仅设置 `RAI_RUNTIME_ROOT` 的合法配置可让检查器对错库报 `complete`，归档漏掉 API 实际主库 | G4 路径闭包结论增加“仅显式主库路径配置已覆盖”；修复前不能用隐式默认值证明闭包 |
| R4 | P2，报告/操作步骤 | 报告 §10.1 要求对 `backup-runtime.sh` dry-run 核对 `path-manifest.json`，而 dry-run 只打印摘要、不生成该文件 | 操作者按报告无法完成所写的核对步骤 | 改成可执行命令，或让 dry-run 写脱敏 manifest 到显式输出路径 |

### 1.1 R1：同一物理库有两把锁

源码证据：[publication-lock.ts](../../packages/storage-sqlite/src/publication-lock.ts) 的 `acquireDatabasePublicationLock` 在约 164–165 行用 `resolve(databasePath)` 生成 `<path>.import.lock`，没有 canonicalize 文件目标；[server.ts](../../apps/api/src/server.ts) 约 223–235 行和 [planner CLI](../../scripts/migrate-training-planner.mts) 使用该锁。[阶段 4 新测试](../../apps/api/test/phase4-storage-locks.test.ts) 只测试同一拼写的路径；原 [publication-lock.test.ts](../../packages/storage-sqlite/test/publication-lock.test.ts) 也未覆盖别名。

隔离复现：在临时目录创建 `alias.sqlite -> main.sqlite`，先对 `main.sqlite` 取 `api` 锁，再对 `alias.sqlite` 取 `cli` 锁，**第二次取锁成功**，两份 `.import.lock` 同时存在。没有打开或写入项目数据库。这直接反驳“同一物理主库任意时刻只有一个获准写者”的 I1 断言。主库/控制库是否为同一文件的启动检查也只比较词法 `resolve()`，同类别名应一并处理。

### 1.2 R2：归档可缺失目录内的权威文件

源码证据：[路径检查器](../../scripts/check-runtime-backup-paths.mjs) 约 195–201 行仅 `classify(var/imports)` 等几个顶层路径；`classify` 只对传入的那个路径执行 `realpath`；[冷备脚本](../../deploy/backup-runtime.sh) 约 103–109 行直接 `tar -C "$runtime" ... .` 并验证 tar 可列举，没有逐项校验 manifest 中的权威文件能在恢复根下读取。

隔离复现：在 `var/imports/job1/source.zip` 放一个指向 runtime 根外的符号链接，并放齐三份必需库文件。检查器退出 0、`closure=complete`；tar 与解包均退出 0；移除外部目录后，恢复根中 `source.zip` 仍是符号链接，但其目标不存在、文件不可读。`source.zip` 在[存储矩阵](STORAGE_OWNERSHIP_MATRIX.md) §7 被列为权威来源证据。现有 29/29 演练只使用普通文件，不能证明该边界。

### 1.3 R3：检查器与 API 的主库默认值不一致

[server.ts](../../apps/api/src/server.ts) 约 156–160 行在 `RAI_DATABASE` 缺失时使用 `<projectRoot>/var/rai.sqlite`；[路径检查器](../../scripts/check-runtime-backup-paths.mjs) 约 170 行则使用 `<runtimeRoot>/var/rai.sqlite`。`backup-runtime.sh` 约 48–56 行只要求有 env 文件，不要求其中显式包含两个数据库路径。隔离复现：env 文件仅有 `RAI_RUNTIME_ROOT`，runtime 下放齐三个文件，检查器返回 `closure=complete`；API 代码在该配置下却会指向另一个主库路径。当前生产模板显式设置了两个路径，**不能据此推断实际配置也完整**；生产配置仍未读取。

### 1.4 R4：报告中的 dry-run 命令与产物不符

[阶段 4 报告](PHASE4_REPORT.md) §10.1 写“运行 `backup-runtime.sh --env-file ...` dry-run，核对 `path-manifest.json` 五类状态”。[冷备脚本](../../deploy/backup-runtime.sh) 在约 60–65 行的 dry-run 分支直接退出；只有 `--apply` 停服之后才把 manifest 写进临时归档目录。只读核对可暂用 `node scripts/check-runtime-backup-paths.mjs --runtime-root <实际根> --deployment-env <实际env> --json`；输出可能含部署路径，须保存在受控位置，不能包含 Token。

## 2. 详细实施方案

### 批次 A：修正物理库锁身份（R1）

1. 在 `packages/storage-sqlite/src/publication-lock.ts` 提取统一的数据库路径身份函数。对存在的库解析实际文件路径；对首次安装的缺失库解析已存在的父目录，再接上文件名。对于悬空链接、循环链接、不可解析路径，**拒绝取锁**，不能退回词法路径。锁身份在数据库文件替换前后应稳定，不能只用会随替换变化的 inode 作为锁名。
2. 显式裁决硬链接：如果同一 SQLite 文件有多个硬链接，`realpath` 仍不同。应在写者入口拒绝 `nlink > 1` 的数据库文件，并给稳定错误；或设计、验证覆盖硬链接的单一锁身份。不得只修符号链接后继续声称“同一物理库”。
3. API 启动时用同一身份规则比较主库与控制库，防止两条路径映射到同一文件；保持已有的“主库 → 控制库”取锁顺序及退出释放顺序。CLI 的 `--apply` 继续在打开写连接之前取锁；失败时不写 schema/数据。
4. 对迁移中的旧版锁语义做兼容评估：如果旧 API 与新 CLI 能同时运行，锁名变化会出现双协议窗口。部署操作必须先停所有旧写者，切换新版后再启动；不要把新锁回滚到旧版时的 stale 文件清理当作活锁判断。

**验收：** 扩展 `publication-lock.test.ts` 和 `phase4-storage-locks.test.ts`，用两个真实进程分别持锁/争锁，覆盖直达路径、符号链接路径、父目录链接路径、缺失库首次安装、硬链接或其显式拒绝、主库/控制库同物理文件。每个拒绝例断言非零退出、锁 owner 未被覆盖、五库 schema/业务行及文件哈希不变；释放后按同一路径重试成功。`npm run typecheck` 与相关 API/包测试通过。

### 批次 B：修正冷备路径闭包与配置来源（R2/R3）

1. `--apply` 必须获得**与 API 实际解析结果一致**的主库和控制库路径。建议要求部署 env 中显式包含 `RAI_DATABASE`、`RAI_CONTROL_DATABASE`，或者两者均由命令行显式传入；缺一个就拒绝。若仍支持缺省，检查器必须按 API 的 `projectRoot` 规则计算，且证明备份使用的是实际 service 的环境，而非另一个 env 文件。对 systemd unit/drop-in 与传入 env 不一致的情况失败关闭；不要输出 Token。
2. 明确五类 SQLite 及各自 `-wal`/`-shm` 的归档相对路径、解析目标、类型与存在状态。对实际存在的权威文件，只记录目录 `present` 不够；需要递归扫描 `var/imports`、`var/model-artifacts/prediction`、`var/backups`、`var/quarantine` 及其子项。最小安全策略是对这些树中**任何符号链接、悬空链接或无法读取的权威项拒绝备份**，并给出相对路径；若允许根内链接，须同时证明目标也是归档条目且恢复后仍可解析。
3. 在停服、确认没有独立 CLI 写者之后重新生成权威 manifest；tar 后比对实际归档条目与 manifest 的权威文件清单、文件类型和摘要，再发布归档。只靠 `tar -tf` 成功或整包 SHA-256，不能证明语义闭包。若检查与打包期间文件发生变化，失败并保留诊断，不输出“备份成功”。
4. 扩展隔离恢复演练：至少覆盖 `restore journal` 实际存在、未终态导入来源/任务、预测工件、保护快照及一个非空 WAL 样例；同时演示外部/悬空/根内链接的接收或拒绝裁决。恢复后对归档中每个标记为权威且 `present` 的项目检查可读性与必要字节摘要，再启动 API 核对 epoch、scope、operation receipt、active bundle 与来源文件。

**验收：** 用临时目录对 `check-runtime-backup-paths.mjs`、`backup-runtime.sh` 和 rehearsal 做表驱动负例：仅配置 runtime root、主库/控制库外置、顶层和嵌套外部链接、悬空链接、库/WAL 链接、权限不可读、service env 与备份 env 不同、归档过程中源文件变化。每例必须在发布归档前非零退出；如果服务原来是 active，应恢复原状态；不得留下看似完整的最终归档。正例要求从归档解包后逐项复核 manifest 与实际文件，再跑四库或五库 `quick_check`（按侧车实际存在性）和真实 API 只读核对。

### 批次 C：修订验收报告与操作说明（R1–R4）

1. 在原报告中保留旧测试统计与原始证据，新增“复核发现/修复批次/复验结果”章节。修复前 G2/T11/I1 和 G4/T12/I8 标为待复验；修复后以**新日志、新代码版本和新 SHA256SUMS**重新裁决，不覆盖原日志。
2. 更新 `BACKUP_RESTORE_REHEARSAL.md` 的路径闭包边界和演练覆盖表；区分“当前 29/29 正常样例通过”与“扩展负例通过”。把报告 §10.1 的 dry-run 操作改成确实会产生 JSON 的只读检查命令，或者实现显式 `--manifest-out` 并测试它。
3. 在 `docs/OPERATIONS.md`、`deploy/README-UBUNTU.md` 说明部署前比较实际 service 配置、停全部写者、检查链接和归档恢复校验；生产路径仍未读取时保持“待确认”，不能写成生产通过。

**验收：** `npm run check:docs`、`npm run check:doc-refs`、`npm run check:acceptance-matrix`、`git diff --check` 通过；审查者按文档中的只读命令能取得五类存储 manifest，而不启动备份 `--apply`。

## 3. 最终阶段门与发布判据

| 阶段门 | 必须提交的证据 | 通过条件 |
|---|---|---|
| G2/I1/T11 | 物理别名与硬链接负例的双进程日志、锁 owner、失败前后数据库哈希 | 同一物理库无法被两个路径并发取锁；主/控同物理库拒绝启动；无锁顺序环 |
| G4/I8/T12 | 显式路径配置、递归文件清单、tar 条目比对、链接负例、含 journal 的恢复演练 | 任一权威文件无法随归档恢复时不产生 `closure=complete`/“备份成功”；正例恢复后摘要、schema、身份与未完成操作一致 |
| 全仓门禁 | `npm run typecheck`、`RAI_TEST_CONCURRENCY=2 npm test`、`npm run check:docs`、`npm run check:acceptance-matrix`；部署脚本变化另跑 `npm run smoke:api` | 退出码 0；记录测试并发度、skip 原因、HEAD 与工作树状态；Windows 分支若本机未执行仍标未验证 |
| 生产前人工门 | 实际 `/etc/rai/rai.env`、systemd unit/drop-in 的**脱敏路径**核对；同一停写窗口的归档和恢复抽检记录 | 五类存储及必要工件的实际路径与归档清单一致；未执行时只允许写“模板/隔离通过”，不得写生产验收通过 |

本文件只要求隔离故障注入。生产恢复演练、服务停启和发布遵循现有运维维护窗口；不得用生产库进行强杀测试。阶段 4 修复若需要回滚，先停 API 与所有 CLI 写者，保留已验证的冷备；回滚后必须重新验证旧版锁与备份脚本的实际行为，不能引用新版验收结果。
