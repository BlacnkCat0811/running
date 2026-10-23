# 阶段 4 一致性窗口与协调机制

**基线：** HEAD `36d79a95f42f854d54e7dfb91e27eb21152a1fa1`（2026-10-23）。
**范围：** 当前 HEAD 的写路径、持锁顺序、持久点与重启裁决者。行号是写作时点（2026-10-23）；符号是可复核的稳定入口。
**证据口径：** E1 = 源码；E2 = 本会话隔离执行；E3 = 推断。本文不把“源码看起来有锁”当作行为通过。

## 1. 协调机制清单

| 机制 | 作用域 | 主要实现 | 失败方向 |
|---|---|---|---|
| 主库 publication lock | 跨进程、按数据库**物理身份**（realpath；缺失库用最深已存在祖先 + 剩余组件） | `packages/storage-sqlite/src/publication-lock.ts` `resolveDatabasePathIdentity` / `acquireDatabasePublicationLock`；API 启动取得 | 活主存在即拒绝；PID 复用按进程身份；不完整锁 5 s grace；悬空链接/链接环/硬链接（nlink>1）拒绝取锁 |
| 控制库 publication lock（阶段 4） | 跨进程、按控制库物理身份（与主库同一规则） | API 启动取得；`scripts/migrate-training-planner.mts` `--apply` 取得 | 在线 API 与 planner apply 只能有一个写者；主/控同物理文件时 API 拒绝启动 |
| TaskAdmissionScheduler | 进程内作业级 FIFO | `apps/api/src/task-admission.ts` `TaskAdmissionScheduler` | 拿不到许可 → 409/重排，不失败开放 |
| MutationCoordinator | 进程内请求级互斥 | `apps/api/src/mutation-coordinator.ts:13` | 冲突 → 409 `mutation_conflict` |
| write-lease | 跨线程、一个窗口 = 一个短事务 | `apps/api/src/write-lease.ts`；`withDatabaseTransaction` 结构探测 | 超时撤回请求并抛可重试错误 |
| publication guard | 跨主库/控制库的发布窗口标记 | `apps/api/src/publication-guard.ts:74/83`；`MobileGoalsStore.withPublicationTransaction` `mobile-goals.ts:405` | 读端重试，耗尽 503；epoch 保留 |
| read lease / replace gate | 进程内读连接与文件替换 | `apps/api/src/read-store-manager.ts:73/116/167` | 替换等待有界 20 s；超时 409 `database_busy` |
| restore journal | 跨文件恢复意图 | `apps/api/src/restore-journal.ts`；`maintenance.ts:682/712/724` | 不可验证 → `recovery_required`，不猜 |
| dataset epoch sidecar | 删库/恢复/放弃作用域的单调证据 | `apps/api/src/dataset-epoch.ts:241/266/374` | 缺失/损坏/不匹配 → 失败关闭 |

## 2. 逐条写路径

### 2.1 API 启动（最长的一串持久点）

`apps/api/src/server.ts:223` 取主库锁 → `:235` 取控制库锁 → `:630` `DatabaseMaintenance.recoverInterruptedRestore()` → `:641` `reconcileDatasetDeletionAtStartup()` → `:650` 读取 startup epoch 回填 → `:671` `new MobileGoalsStore`（控制库 schema 自动追加、`clearPublicationMarkerOnStartup`）→ `:808` `recoverDatabaseJobs()`（主库分析任务恢复）→ 各 worker 启动 → listen。

- 持久点：锁文件（协调）、restore journal（若存在）、epoch 侧车、主库 epoch 行、控制库 `mobile_publication_guard`/schema、主库 `recompute_jobs` 状态。
- 崩溃裁决：restore 未收口 → journal；删库未收口 → sidecar `dataset_deletion`；账本/许可 → runtime `import_scope_evidence`；分析任务 → 主库 `recompute_jobs`。
- 空库不自动建：`deletionRecoveryRequired`/`recovery_required` 时跳过 `recoverDatabaseJobs`，只保留恢复入口（`server.ts:820-833`）。

### 2.2 API 导入（data-only / direct-sync）

入口：`ImportWorker.run()`（`apps/api/src/import-worker.ts:863`）。

1. 准入：`TaskAdmissionScheduler` + 持久 job（runtime `import_jobs`）；先写 `writer_entered` 再进入可提交区（`import-worker.ts:939`）。
2. 预检/回执：已存在可信回执 → 原结果返回；无回执才进入车道。
3. 车道：`applyDataOnlyImport`（`data-only-import.ts:92`）或 `applyDirectSyncImport`（`direct-sync-ingest.ts:796`）；事实、路线、batch、generation、`import_manifest` 回执/锚点、`recompute_jobs`（queued 时）在**同一主库事务**提交（`writeImportReceiptInDatabase`，`data-only-import.ts:231`、`direct-sync-ingest.ts:1185`）。
4. 终态：runtime job 状态、来源 finalization；HTTP 响应在提交之后。
5. 崩溃裁决：主库回执优先。`loadJobs()`（`import-worker.ts:2801`）用 `readImportReceiptForRecovery` 四态：`found` 恢复原回执；`confirmed_absent` 才按取消/重试；`missing` 只有“当前 pristine 作用域许可”可放行；`unreadable` → `recovery_required`。

**窗口：** 主库 COMMIT → runtime 终态/HTTP。若在两者之间强杀，重启从**主库回执**恢复 `succeeded`，不重复事实；这正是 T02。

### 2.3 分析/模型发布

`RecomputePipeline.activateModelRunAndCompleteJob`（`packages/application/src/services/recompute-pipeline.ts:4370`）：

1. `RecomputeJobRepository.complete(jobId, ..., beforeComplete)`（`recompute-job-repository.ts:412`）在一个 `BEGIN IMMEDIATE`/savepoint 事务里。
2. `beforeComplete`：`writeAnalysisInputBinding`（`:4381`）→ `SqliteModelRunRepository.activateSucceeded`（`:4382`）→ `SqliteModelReleaseRepository.verifyAndPoint`（`model-release-repository.ts:76`）→ `active_model_run`/`active_model_release` 指针 + `model_release_bundles.activated_at` + job `succeeded` 同事务。
3. 事务外：`pruneSupersededRuns`（housekeeping，失败不回滚发布）。

**窗口：** 同一主库文件的单事务，没有跨文件窗口；强杀要么全有要么全无。T04 用真实仓库 + 子进程 SIGKILL 钉住。`verifyAndPoint` 另做输入绑定/lineage/snapshot/incumbent/override 摘要校验，错误 bundle 不能成为 active。

### 2.4 控制库计划发布（跨主库/控制库）

`MobileGoalsStore.publicationOperation`（`mobile-goals.ts:510`）→ `withPublicationTransaction`（`:405`）：

1. `beginPublicationMarker`（`:420`）：独立 `BEGIN IMMEDIATE` 提交 `mobile_publication_guard`（`epoch+1`, `pending_since`）。**这一步先于业务事务**，所以读者若看到旧控制状态，也能在之后看到 marker/epoch 变化。
2. 业务事务：控制库状态/历史/operation receipt（`inWriteTransaction`，`:446`）；`action()` 内可能写主库（例如 synced 的覆盖/回执）。
3. `endPublicationMarker`（`:431`）：独立事务清 `pending_since`；失败只留下 lease，不掩盖业务结果。
4. 读端：`readStableSnapshot`（`plan-read-consistency.ts:158`）读前/读后 control digest + guard；`publicationGuardChanged` 检测 `pending`/epoch；3 次（1–5 上限）后 503。`clearPublicationMarkerOnStartup`（`publication-guard.ts:109`）清死进程 marker 但保留 epoch。

**窗口：** 控制库 marker COMMIT → 主库/控制库业务 COMMIT → marker 清除。任何跨库读者只能“稳定旧快照 / 稳定新快照 / 503”，不能混合。T05 用双真实进程压测 + `plan-read-consistency.test.ts` 覆盖。

### 2.5 删库（四阶段）

`DatabaseMaintenance.deleteDatabase`（`maintenance.ts:436`）→ API 路由 `server.ts:2714`：

1. 取 `TaskAdmissionScheduler` 恢复/写者许可；准备保护快照（`before-delete`，失败不消耗保留槽）。
2. `deletion:before-prepared` → sidecar `dataset_deletion(stage=prepared)` commit。
3. `deletion:after-prepared` / `faultPoint("deletion:after-main-unlinked")` → 主库文件 unlink。
4. `advanceDeletionOperation(main_removed)` → `deletion:after-main-removed`。
5. runtime `establishDeletionPermit`（`explicit_database_delete:<id>`）→ sidecar `permit_issued`（`deletion:after-permit`）。
6. 写者进入 → runtime `markScopeWriterEntered`（`import-worker.ts:939`）→ sidecar `writer_entered`；`deletion:before-response`。
7. 失败回滚：保护快照恢复 + `rolled_back`；`deletion:rollback-verified`。

**窗口：** 每阶段都有持久记录；重启由 `reconcileDatasetDeletionAtStartup` + CLI `data:init-scope --apply --deletion-id` 裁决。未知缺库不建新库；许可最多消费一次。T07/T08 覆盖。

### 2.6 备份恢复（prepared/installed/committed）

`DatabaseMaintenance.restoreBackupInner`（`maintenance.ts:579`）：

1. `preflightRestore`：basename 限定 `var/backups`，校验备份身份/schema/`quick_check`。
2. 保护快照 `before-restore`；`restoreJournal.write(prepared)`（`:682`）——包含备份字节 SHA/大小、planned epoch、deletion 绑定。
3. `beforeReplace` 取 read replace gate → checkpoint → 移走原库 → 安装 staging（`:712` `installed`）→ `restore:after-install`。
4. `beforeCommit`（调用方在恢复路由里执行 `/v1/backups/:name/restore` 的 epoch/sidecar 准备）→ checkpoint/fsync → 释放 replace gate → 写 `committed` + `mainSha256`（`:724`）。
5. `restore:after-commit` → 调用方收口 sidecar/scope/publication 意图（`finalizeBoundRestore`，`:256`）→ `restore:before-journal-clear` → 清 journal。
6. 失败：原库回滚/校验（`:840` `restore:rollback-original`）；不可证明 → `RestoreRecoveryRequiredError`，journal 保留。

**窗口：** 替换前（journal prepared）、安装后（installed）、提交后（committed）、收口前（before-journal-clear）、token 解除前。T09/T10 + `dataset-deletion-recovery.test.ts` P2-18/P2-19/P2-20 覆盖。

### 2.7 可写 CLI

| CLI | 写库 | 锁 | 备注 |
|---|---|---|---|
| `data:migrate`（`packages/storage-sqlite/src/migrate-cli.ts:45`） | 主库 | 主库 publication lock | 每版本一个事务；迁移备份在 `dirname(db)/backups` |
| `data:import` / `data:incremental-import`（`packages/health-export-parser/src/cli.ts:206`） | 主库（候选 + 文件换库） | 主库 publication lock | 离线车道；不用于线上修复 |
| `data:recompute`（`packages/application/src/cli.ts:46`） | 主库 | 主库 publication lock | 离线重算 |
| `data:init-scope`（`apps/api/src/import-scope-cli.ts`） | sidecar/runtime/主库文件移动 | 主库 publication lock → `var/import-scope-init.lock` | 阶段 4 起 `--apply` 在读取 state 前取主库锁 |
| `migrate-training-planner --apply`（`scripts/migrate-training-planner.mts`） | 控制库 | 控制库 publication lock | 阶段 4 新增；API 在线时 `control_database_locked` |
| `data:backfill-canonical-nights --apply`（`scripts/backfill-canonical-nights.mts`） | 主库 | 主库 publication lock | 阶段 4 起 `--apply` 取锁 |
| `data:analyze` / `data:predict` / `data:prediction-eval` | 只读 | 无（不需要） | `RaiDatabase.openReadonly` |

**锁顺序：** 主库 → 控制库 → runtime 初始化锁。没有反向路径：planner 只取控制库；主库 CLI 只取主库；scope CLI 取主库再取初始化锁。锁文件不提供“事务语义”，只提供互斥；跨库原子性仍靠 guard/epoch/摘要。

### 2.8 关闭

`server.ts:781` `onClose`：停止 command queue、导入/重算/预测 worker、series worker、read store、控制库 store；最后释放主库 + 控制库锁（`:802-803`）。`process.once("exit")` 兜底释放。关闭期间的写请求由 `closing`/HTTP server 生命周期拒绝；不依赖 PID 存活作为唯一互斥证据。

## 3. 跨文件窗口与裁决者

| 窗口 | 最后一个持久点 | 下一个持久点 | 重启裁决者 | 证据 |
|---|---|---|---|---|
| W1 导入事实已提交、runtime/HTTP 未落 | 主库 `import_manifest` 回执 + 事实/batch | runtime `import_jobs` 终态 | `loadJobs` + `readImportReceiptForRecovery` | T01/T02 |
| W2 分析候选已生成、active 未翻 | 主库 `model_runs`/bundle（未激活） | `active_model_run`/job `succeeded` | 候选不可见；任务重排/重试 | T03/T04 |
| W3 控制库 marker 已提交、业务未提交 | `mobile_publication_guard(epoch,pending)` | 业务事务 COMMIT / marker 清除 | 读者 detect+retry；启动清 stale marker 保 epoch | T05 |
| W4 主库/控制库跨库发布（一库已提交） | 其中一个库的业务 COMMIT | 另一个库的业务 COMMIT | guard epoch 变化 → 读重试/503；不假装原子 | T05 |
| W5 删库 sidecar 阶段已写、文件/许可未下一步 | `dataset_deletion(stage)` | 下一阶段/保护快照恢复 | `reconcileDatasetDeletionAtStartup` + CLI | T07/T08 |
| W6 恢复 journal 已写、安装/提交/收口未完成 | `restore_intent(phase)` | 下一 phase / mainSha / 清 journal | `recoverInterruptedRestore`/`finalizeBoundRestore` | T09/T10 |
| W7 读连接持有旧 inode、文件已替换 | 读租约/缓存连接 | 新 inode 打开 | `ReadStoreManager` 按 inode 失效；替换 gate 等待 | T06 |
| W8 备份归档已产生、manifest/服务未恢复 | `runtime.tar` | `path-manifest.json`/服务状态 | 运维按 SHA/清单核对；脚本失败恢复服务状态 | T12 |

## 4. 三种“原子性”必须分开说

1. **同库事务原子性**：主库导入、分析发布、控制库状态/历史/operation、runtime job/scope 写都是 SQLite 单库事务。COMMIT 前崩溃 = 全部回滚；COMMIT 后崩溃 = 全部可见。T01/T04/T07 的强杀证明的是这一类。
2. **跨库 detect + retry**：主库与控制库**没有**分布式事务。`mobile_publication_guard` 的 pending/epoch 只让读端**检测**混合快照，重试或 503；它不会把两个 COMMIT 变成原子。任何“跨库已提交”结论都必须带 `pending`/epoch 证据。
3. **冷备恢复的一致性**：只能靠“停所有写者 + 整根归档 + 解包后核对”；不是在线备份 API 的语义。单库恢复必须生成新 epoch 并重裁决其他库；不能把控制库/runtime 说成一起回到旧时点。

## 5. 责任覆盖与未决项

| 机制 | 覆盖测试 | 未覆盖/边界 |
|---|---|---|
| 主库锁 | `packages/storage-sqlite/test/publication-lock.test.ts`（23 例，含真实双进程别名/硬链接）+ `phase4-storage-locks.test.ts`（data:migrate 在线拒绝、主控同物理文件） | Windows 进程身份/链接分支只在对应平台执行 |
| 控制库锁 | `phase4-storage-locks.test.ts`（持锁拒绝、API 启动拒绝、在线 CLI 拒绝） | 生产 systemd 停机窗口未实测 |
| 导入回执恢复 | `import-restart-receipt-recovery.test.ts`（14 例）+ `data-only-import.test.ts` SIGKILL | worker 线程崩溃与进程崩溃是两类；线程崩溃由 import-worker-reuse 覆盖 |
| 分析发布 | `phase3-analysis-publication.test.ts` + `phase4-model-release-crash.test.ts` | 真实训练 + HTTP 全链路的强杀未执行（仓库内无可控训练数据） |
| 计划 guard | `plan-read-consistency.test.ts`（20 例）+ `plan-publication-stress.test.ts`（双进程） | 跨机/网络文件系统未验证 |
| 删库/恢复 | `dataset-deletion-recovery.test.ts`（36 例）+ `restore-journal.test.ts`（8 例）+ `maintenance.test.ts`（43 例） | 生产真实备份恢复未执行 |
| 读替换 | `read-store-manager.test.ts`（9 例） | 真实文件系统 inode 复用极端场景未注入 |
| 冷备路径 | `phase4-storage-locks.test.ts` 路径闭包 + `deploy-n100.test.ts` 脚本夹具 + `phase4-backup-restore-rehearsal.mjs` | 生产 `/etc/rai/rai.env` 未读取；systemctl 未执行 |

**已知空档：** 控制库仍没有主库级的 schema registry/冻结 checksum（PR-06 后续）；控制库锁只排除“在线 API vs 离线 apply”，不提供数据迁移的跨版本校验。`restore journal` 的 legacy committed 记录只能人工裁决。上述均不构成本阶段 I1–I8 的已知违例，但属于未完成项。
