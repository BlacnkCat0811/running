# 阶段 4 故障矩阵（T01–T12）

**基线：** HEAD `36d79a95f42f854d54e7dfb91e27eb21152a1fa1`（2026-10-23）。
**环境：** macOS Darwin 25.6.0 / x86_64 / 6 核；Node **v22.23.2**；内置 SQLite **3.51.3**；`RAI_TEST_CONCURRENCY=1`（下列定向套件）。
**证据等级：** E2 = 本会话实际执行；E1 = 源码/测试阅读；E3 = 未执行/推断。所有失败注入都在 `mkdtempSync(tmpdir())` 生成的隔离根内，不访问生产库，不写健康原文/Token。

## 0. 结果总览

| 场景 | 结果 | 证据 |
|---|---|---|
| T01 导入未提交 | **PASS** | `data-only-import.test.ts`（真实子进程 + SIGKILL，pre-commit 触发器屏障） |
| T02 导入已提交/响应丢失 | **PASS** | `import-worker-reuse.test.ts` + `import-restart-receipt-recovery.test.ts` |
| T03 分析候选未发布 | **PASS** | `phase3-analysis-publication.test.ts` F10（真实 repository；发布事务未发生） |
| T04 模型发布切换 | **PASS** | `phase4-model-release-crash.test.ts`（真实 `complete()` + `verifyAndPoint`，COMMIT 前 SIGKILL） |
| T05 控制库发布 | **PASS** | `plan-publication-stress.test.ts`（双真实进程/HTTP）+ `plan-read-consistency.test.ts` |
| T06 读库替换 | **PASS** | `read-store-manager.test.ts`（inode/mtime/WAL checkpoint/租约） |
| T07 删库四阶段 | **PASS** | `dataset-deletion-recovery.test.ts` P2-2…P2-5/P2-18/P2-21 |
| T08 账本/侧车不匹配 | **PASS** | `dataset-deletion-recovery.test.ts` P2-6/P2-7/P2-10/P2-12/P2-16 |
| T09 备份恢复三阶段 | **PASS** | P2-18/P2-18b/P2-18c/P2-11 + `restore-journal.test.ts` |
| T10 恢复失败 | **PASS** | P2-19/P2-20 + `maintenance.test.ts` 失败路径 |
| T11 CLI 互斥 | **PASS（复核后复验）** | `publication-lock.test.ts` 23 例（物理身份/别名/硬链接）+ `phase4-storage-locks.test.ts`（锁、API 启动拒绝、主控同文件） |
| T12 路径与冷备 | **PASS（本轮隔离）**；生产待确认 | `phase4-storage-locks.test.ts` 路径闭包 2 例 + `deploy-n100.test.ts` 38 例 + `phase4-backup-restore-rehearsal.mjs` 47 checks；N1–N3 见报告 §14 |

**套件汇总（本次执行）：**

| 日志 | 文件范围 | tests | pass | fail | skip | exit |
|---|---|---|---|---|---|---|
| `evidence/targeted-a.log` | import/publication/restore/plan-read/read-store/锁定/模型 12 文件 | 161 | 161 | 0 | 0 | 0 |
| `evidence/targeted-b.log` | deletion-recovery/maintenance/plan-stress 3 文件 | 81 | 80 | 0 | 1（Windows-only） | 0 |
| `evidence/targeted-c.log` | training-plan-migration/mobile/plan 4 文件 | 69 | 69 | 0 | 0 | 0 |
| `evidence/phase4-new.log`（初验） | `phase4-storage-locks` + `phase4-model-release-crash` | 6 | 6 | 0 | 0 | 0 |
| `evidence/deploy-n100.log`（初验） | `deploy-n100.test.ts` | 8 | 8 | 0 | 0 | 0 |
| `evidence/remediation-2026-10-23/publication-lock.log` | `publication-lock.test.ts` | 23 | 23 | 0 | 0 | 0 |
| `evidence/remediation-2026-10-23/phase4-storage-locks.log` | `phase4-storage-locks.test.ts` | 9 | 9 | 0 | 0 | 0 |
| `evidence/remediation-2026-10-23/deploy-n100.log` | `deploy-n100.test.ts` | 18 | 18 | 0 | 0 | 0 |
| `evidence/rehearsal-1.json`（初验） | 整套冷备恢复演练 | 29 | 29 | 0 | 0 | 0 |
| `evidence/remediation-2026-10-23/rehearsal-2.json` | 扩展整套冷备恢复演练 | 47 | 47 | 0 | 0 | 0 |

> 说明：`targeted-b` 的 1 个 skip 是 `keeps a genuinely locked rollback as a visible backup after commit`，原因写明“Windows-only：POSIX 可以 rename 打开的数据库”，不是静默跳过。

## T01 导入未提交

- **注入窗口：** data-only 事务已写事实/路线/batch，但 `import_manifest` 回执 INSERT 前；测试用 `BEFORE INSERT ON import_manifest` 触发器 + 子进程 `Atomics.wait` 停在真实 `applyDataOnlyImport` 调用里，然后 SIGKILL。不是 sleep 猜测窗口。
- **必须断言：** 杀前读者看不到未提交变化；杀后 SQLite 回滚，无回执；同一持久 batch 重试只提交一次并写回执。
- **证据：** `apps/api/test/data-only-import.test.ts` `"SIGKILL immediately before the receipt write leaves no accepted facts or partial deletion state"`（ok 4，`targeted-a.log`）。
- **退出码：** 套件 0；子进程 SIGKILL 由测试断言。
- **重启查询：** 重新打开同一主库，`snapshot(main)` 与杀前完全一致；`readImportReceipt(main, batch.jobId) === null`；重试后回执存在。
- **重放：** 同一 batch 重试成功；不同内容复用同一 job 被拒绝。

## T02 导入已提交但响应丢失

- **注入窗口：** worker 真正提交后线程终止（模拟回复丢失），以及“已提交回执 + 持久 running + 重启”。
- **必须断言：** 从原回执恢复 `succeeded`，事实/任务不重复；数据库不可读时不判 `cancelled/failed`，进入 `recovery_required`。
- **证据：**
  - `apps/api/test/import-worker-reuse.test.ts` `"真实 worker 提交后回复丢失：线程终止后从持久回执恢复同一成功结果"`（ok 72）、`"提交后回复丢失：从持久回执恢复同一个 no-op 成功结果"`（ok 67）。
  - `apps/api/test/import-restart-receipt-recovery.test.ts` `"已提交回执 + 持久 running：重启恢复 succeeded 原回执且不重复事实"`（ok 52）。
- **重启查询：** `loadJobs()` → `readImportReceiptForRecovery` 四态；`found` 返回原回执；`unreadable` 进入阻断。
- **重放：** 同 identity 请求返回同一回执；事实计数不增长。

## T03 分析候选未发布

- **注入窗口：** 候选 run 已生成、封存、评估通过，但发布事务从未发生（进程在发布前消失的持久状态）。
- **必须断言：** 旧 active 指针稳定；候选不在任何可见 release 投影；补发同一发布幂等且无重复 release。
- **证据：** `apps/api/test/phase3-analysis-publication.test.ts` `"F10 候选已生成但发布前中断：旧发布稳定、候选不可见；补发同一发布幂等且无重复 release"`（ok 92）。
- **边界：** 该用例没有 SIGKILL 子进程；它断言的是“发布事务未发生时数据库应有的形状”，与“杀在事务前”等价，但不等价于“杀在事务中”。事务中的崩溃由 T04 覆盖。

## T04 模型发布切换

- **注入窗口：** 真实 `RecomputeJobRepository.complete()`（内部 `verifyAndPoint` + active 指针 + job 结算）完成所有写之后、外层 `COMMIT` 之前 SIGKILL。
- **必须断言：** active 指针仍指旧 release；job 仍 `running`；候选 bundle `activated_at` 仍 NULL；重放同一发布后指针与 job 同时变为新值。
- **证据：** `apps/api/test/phase4-model-release-crash.test.ts` `"T04 发布事务 COMMIT 前 SIGKILL：active 指针与 job 结算同进同退，重放一次成功"`（ok 1，`phase4-new.log`）；子进程 `apps/api/test/phase4-model-release-crash-child.mjs` 用 `withWriteTransaction` 代理，SQL/仓库调用与生产相同。
- **补充：** `packages/storage-sqlite/test/model-release-v2.test.ts` 的 `S01`（ok 143）证明事务内触发器失败时指针/bundle 一起回滚；`model-run-repository.test.ts` 证明 failed/旧 incumbent/未封存候选不能激活。
- **重启查询：** 新连接 `SELECT model_run_id FROM active_model_run`、`SELECT status FROM recompute_jobs`、`SELECT activated_at FROM model_release_bundles`。

## T05 控制库发布

- **注入窗口：** 两个真实进程（publisher + reader）并发跑 guard 协议；HTTP 读在发布窗口内重复读；含 `pending_since`/epoch 变化。
- **必须断言：** 不出现“旧 control + 新 main”的混合快照；503 可重试且有 `Retry-After`；死进程 marker 启动清除但 epoch 保留。
- **证据：**
  - `apps/api/test/plan-publication-stress.test.ts` `"guard protocol: two real processes never observe a consistent mixed snapshot"`（ok 80）、`"HTTP load: readers stay consistent, 503s are retryable, latency stays bounded"`（ok 81）。
  - `apps/api/test/plan-read-consistency.test.ts`：`G: a publication that starts during the build...`（ok 44）、`G: a live publication marker blocks...`（ok 45）、`G: a stale pending marker...`（ok 46）、`P3-14`（ok 111）。
- **边界：** 跨机/网络文件系统未测；SQLite 锁只在同机文件系统上假设成立。

## T06 读库替换

- **注入窗口：** 读租约持有期间 `beginReplace`；替换完成后释放；WAL checkpoint 只改 mtime 不改 inode；utimes-only 变化。
- **必须断言：** 替换等待或超时 409；替换后只读新 inode；WAL checkpoint 不误判为换库；`data_version`/inode 指纹正确。
- **证据：** `apps/api/test/read-store-manager.test.ts` `"database replacement waits for asynchronous read leases and blocks new reads"`（ok 115）、`"P3-4: the cached read store reopens when the database file is replaced"`（ok 117）、`"P3-4+: utimes-only mtime change must not reopen..."`（ok 118）、`"P3-4+: a WAL checkpoint ..."`（ok 119）、`"dataVersionFingerprint..."`（ok 121）。
- **重放：** 替换后新读取打开新 inode；旧连接不再提供业务数据。

## T07 删库四阶段

- **注入窗口：** `prepared`、`main_removed`、`permit_issued`、`writer_entered` 各阶段 SIGKILL，以及保护快照轮换、库缺失、CLI 恢复。
- **必须断言：** 同一 `deletionId/nextEpoch` 单调恢复；未知缺库不建新库；许可最多消费一次；来源/保护快照保留。
- **证据：** `apps/api/test/dataset-deletion-recovery.test.ts`：
  - `P2-2 prepared 前/后强杀且主库仍在...`（ok 3）
  - `P2-3 prepared 已写、主库已删...`（ok 5）
  - `P2-4 main_removed 强杀、许可未写...`（ok 6）
  - `P2-5 permit_issued 响应前强杀...`（ok 7）
  - `P2-21 并行执行同一放弃命令...`（ok 36）
- **重启查询：** sidecar `dataset_deletion.stage`、runtime `import_scope_evidence`、主库存在性/字节哈希；CLI `data:init-scope` 非零/许可计数。

## T08 账本与侧车不匹配

- **注入窗口：** runtime 实例变化、侧车损坏、保护字节变化、旧版本日志、账本写失败、scope 行丢失。
- **必须断言：** 不重签许可、不猜 epoch、保持恢复入口与诊断；主库字节不被覆写。
- **证据：** `P2-6 写者已进入后主库消失且 runtime 账本损坏...`（ok 9）、`P2-7 侧车损坏/配置不匹配/快照缺失/账本实例不符/写账本失败...`（ok 10）、`P2-10 ...不得重签许可`（ok 15）、`P2-12 快照存在但字节损坏...`（ok 17）、`P2-16 侧车写入后 SIGKILL...`（ok 29）。
- **重放：** 同一恢复命令重试只补齐缺失步骤，不新增 epoch/许可/操作行。

## T09 备份恢复三阶段

- **注入窗口：** restore journal `prepared`/`installed`/`committed`、收口前、token 解除前 SIGKILL。
- **必须断言：** 旧库回滚或绑定新库重放；有且只有一个最终 epoch；未核实保持阻断；旧任务/发布意图按合同 supersede。
- **证据：**
  - `P2-18 解除 token 前 SIGKILL...`（ok 31）
  - `P2-18b 恢复主库提交后 SIGKILL...`（ok 32）
  - `P2-18c sidecar/scope 已收口、恢复意图未清除时 SIGKILL...`（ok 33）
  - `P2-11 首包消费后恢复备份...`（ok 16）
  - `apps/api/test/restore-journal.test.ts` 8 例（含 committed 不可只凭可读主库推断成功、空 journal≠无意图）。
- **重放：** 同一 bound intent 重放；`mainSha256`/planned epoch 不符则 `recovery_required`。

## T10 恢复失败

- **注入窗口：** 候选预检失败、安装失败且完整回滚、回滚失败、损坏备份。
- **必须断言：** 仅无副作用或可证明完整回滚才释放临时冻结；不可证明不宣称成功；恢复入口仍可用。
- **证据：** `P2-19 回滚本身失败...`（ok 34）、`P2-20 损坏备份...`（ok 35）；`maintenance.test.ts` 的 `"keeps reads gated until the original database is restored after an install failure"`、`"rolls back the installed database before reopening reads when pre-commit recovery fails"`、`"rejects a superficially plausible four-table database before replacement"`。
- **重启查询：** `recoverInterruptedRestore` 读到 journal → 恢复原库或抛 `RestoreRecoveryRequiredError`；主库字节哈希与保护快照一致。

## T11 CLI 互斥

- **注入窗口：** 测试进程持有主库/控制库 publication lock 时启动真实 CLI；API 启动时控制库锁被另一个进程持有；反向（API 在线后 planner apply）。
- **必须断言：** 锁冲突退出非零；控制库无 `mobile_training_state` 写入；API 不在锁冲突时启动；释放后 CLI 成功；无锁顺序环；同一物理库的两个路径（符号链接/父目录链接）不能各拿一把锁。
- **证据（复核后）：**
  - `apps/api/test/phase4-storage-locks.test.ts` 10 例：控制库锁拒绝/API 启动拒绝/主库 CLI 拒绝/CLI 审计/路径闭包 2 例/**符号链接别名持锁拒绝且 owner、行、SHA-256 不变**/**主控同物理文件拒绝启动**/**身份不可解析失败关闭**。
  - `packages/storage-sqlite/test/publication-lock.test.ts` **23 例**：活主/陈旧/不完整/PID 复用/空 legacy 目录 + 真实双进程直达路径、文件链接双向、父目录链接、`link/..` 按文件系统顺序、缺失库双别名、硬链接拒绝、悬空链接、链接环、目录、文件替换后锁名稳定。
  - 日志：`evidence/remediation-2026-10-23/publication-lock.log`、`phase4-storage-locks.log`。
- **边界：** 双 CLI 反序竞争的“反序”路径不存在：planner 只取控制库，主库 CLI 只取主库；锁顺序固定主库→控制库，scope CLI 主库→初始化锁。没有代码路径按相反顺序取锁。硬链接库文件被显式拒绝；旧版锁协议切换必须先停所有旧写者。

## T12 路径与冷备

- **注入窗口：** 显式路径/仅 runtime root、主库/控制库外置、缺一侧车、活跃 WAL、链接/不可读、service 配置冲突、归档前后源文件变化，以及危险 tar 成员；整根 tar、归档逐项校验、移开旧根、解包、启动 API。
- **必须断言：** 缺显式库路径拒绝；manifest v2 记录五类存储与逐文件摘要；外置/链接/不可读在发布归档前拒绝；归档条目/类型/摘要与 manifest 一致；归档窗口后源文件变化失败；恢复后五库/工件/scope/计划回执/未终态任务/active bundle 一致。
- **证据（复核后）：**
  - `apps/api/test/phase4-storage-locks.test.ts` 2 例：显式路径必需/manifest v2/WAL 摘要/外置/缺库/Token 不回显；外部/悬空/根内链接与库链接全部拒绝。
  - `apps/api/test/deploy-n100.test.ts` **18/18**：dry-run + `--manifest-out`、仅 runtime root 拒绝、外置路径拒绝且不 stop 服务、四类链接拒绝、不可读拒绝、service env 不同拒绝、manifest v2/摘要/SHA256SUMS、归档窗口后源文件变化拒绝、失败清理/服务恢复、重启失败保留归档。
  - `scripts/phase4-backup-restore-rehearsal.mjs`：**47/47 checks**（含真实 restore journal、未终态 job、保护快照、active bundle、非空 WAL、三类链接裁决），见 [BACKUP_RESTORE_REHEARSAL](BACKUP_RESTORE_REHEARSAL.md)。
  - 日志：`evidence/remediation-2026-10-23/deploy-n100.log`、`rehearsal-2.json`。
- **二次审查 N1–N3 新证据：** 上述 18/18 与 47/47 保留为历史。`deploy-n100.test.ts` 扩为 **41/41**，覆盖 env/CLI 错配、多份/可选 env、UnsetEnvironment、直接配置正例、归档前后树变化和五类危险 tar；新一轮演练仍为 **47/47**。日志见 `evidence/second-review-2026-10-23/deploy-n100.log`、`rehearsal-3.json`，裁决见 [PHASE4_REPORT.md](PHASE4_REPORT.md) §14。
- **环境限制：** 本机没有 systemd，`deploy/backup-runtime.sh --apply` 的 systemctl 路径只在 `deploy-n100.test.ts` 的 stub 中执行；真实生产停服/恢复未执行。生产实际 `/etc/rai/rai.env` 未读取，路径覆盖结论仅限模板与隔离环境。

## 未执行项（不伪装成通过）

| 项 | 原因 | 影响 |
|---|---|---|
| 生产环境真实故障注入 | 禁止访问生产/真实健康库；计划只允许隔离副本 | 生产 RPO/RTO 未测量；只给隔离演练值 |
| systemd 停服/恢复实测 | 本机 macOS 无 systemd | 脚本编排由 stub 文本合同覆盖，非真实服务 |
| Windows 进程身份/文件锁分支 | 本机 darwin | 对应测试在 CI/Windows 上执行；本报告不宣称跨平台通过 |
| 真实训练数据 + HTTP 全链路 T04 | 仓库无受控训练数据 | 用真实 repository + 真实 SQLite 崩溃边界替代；HTTP 层未注入 |
| 跨机/网络文件系统锁 | 无此环境 | SQLite 锁只在本地文件系统假设成立 |

## 复现命令

```bash
node --import tsx --test --test-concurrency=1 \
  apps/api/test/data-only-import.test.ts \
  apps/api/test/import-worker-reuse.test.ts \
  apps/api/test/import-restart-receipt-recovery.test.ts \
  apps/api/test/import-publication.test.ts \
  apps/api/test/phase3-analysis-publication.test.ts \
  apps/api/test/plan-read-consistency.test.ts \
  apps/api/test/read-store-manager.test.ts \
  apps/api/test/restore-journal.test.ts \
  packages/storage-sqlite/test/publication-lock.test.ts \
  packages/storage-sqlite/test/model-release-v2.test.ts \
  packages/storage-sqlite/test/model-run-repository.test.ts \
  packages/storage-sqlite/test/migration-policy.test.ts

node --import tsx --test --test-concurrency=1 \
  apps/api/test/dataset-deletion-recovery.test.ts \
  apps/api/test/maintenance.test.ts \
  apps/api/test/plan-publication-stress.test.ts

node --import tsx --test --test-concurrency=1 \
  apps/api/test/phase4-storage-locks.test.ts \
  apps/api/test/phase4-model-release-crash.test.ts \
  apps/api/test/deploy-n100.test.ts

node --import tsx scripts/phase4-backup-restore-rehearsal.mjs
```
