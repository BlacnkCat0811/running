# 导入恢复审查问题修复方案（2026-10-23）

状态：已实施（2026-10-23）。本文保留原始设计与验收条件；实施细节、故障注入点与逐条验收证据见
[IMPORT_RECOVERY_REVIEW_FIX_2026-10-23](../deliverables/IMPORT_RECOVERY_REVIEW_FIX_2026-10-23.md)。

## 范围与目标

本方案处理三处已确认的恢复状态问题：

1. 回执恢复阻断后，备份恢复返回成功，但任务准入仍处于 `blockUntilRestart`，后续导入无法运行。
2. 备份恢复在校验或执行阶段失败后，导入 worker 的 `recoveryBlocked` 可能永久保留。
3. `--abandon-and-create-new-epoch` 在账本提交与侧车提交之间中断，重试会生成第二个 epoch 和第二张 `pristine` 许可。

相关实现位于 [server.ts](../apps/api/src/server.ts)、[import-worker.ts](../apps/api/src/import-worker.ts)、[task-admission.ts](../apps/api/src/task-admission.ts)、[maintenance.ts](../apps/api/src/maintenance.ts)、[import-publication.ts](../apps/api/src/import-publication.ts)、[runtime-state.ts](../apps/api/src/runtime-state.ts) 和 [import-scope-cli.ts](../apps/api/src/import-scope-cli.ts)。保持现有 iOS 原生客户端、API `/v1` 合同和只读健康样本同步范围；本修复不需要新增客户端平台或端点。

## 一、备份恢复成功后解除正确的任务阻断

### 现状与失败路径

`ImportWorker.loadJobs()` 遇到无法核实回执的任务时登记恢复阻断；`resume()` 触发 `onRecoveryRequired`，使 `TaskAdmissionScheduler.blockUntilRestart("import_publication_recovery_required")` 生效。现有备份恢复路由允许处于 `recovery_required` 的导入任务进入恢复，并在成功后调用 `importWorker.reloadAfterRestore()`、`importWorker.resume()` 和其他 worker 的调度入口。但是 `TaskAdmissionScheduler` 没有对应的解除操作。路由可能返回 `restored: true`、健康检查也可能报告 `databaseReady: true`，而所有需要任务准入许可的工作仍拿不到许可。

### 修复方法

1. 将任务准入阻断分为**可由已验证的显式恢复解除**与**必须重启/人工处置**两类。为导入回执或发布意图的恢复阻断提供带唯一 token（或等价代次）的可恢复阻断；保留其他 `RestoreRecoveryRequiredError` 的永久阻断语义。调度器应保存各阻断的身份，`acquire()` 只在阻断集合为空时发许可，避免一个阻断原因覆盖另一个原因。
2. 增加只接受匹配 token 的解除方法。若 token 不匹配、仍有其他永久阻断或恢复证据不完整，方法不得解除任何其他阻断；解除成功后通知已等待的 owner 重试。保留可观测快照中的全部活跃阻断原因。
3. 在 `ImportWorker.reloadAfterRestore()` 中重新裁决**恢复后的**导入作业与发布意图，而不能仅清空内存中的 `recoveryBlocked`：
   - 旧 scope 的未决作业按现有原则持久标记 `superseded`，不宣称原事务未提交。
   - 对恢复前留下的 `import_publications` 意图建立可重放的“已被本次显式恢复取代”记录；只有在备份恢复已提交、最终 epoch/账本已持久化之后才能使这些意图失效。重启时必须能识别该记录，不能重新把旧意图当作当前主库的提交冲突。
   - 如果仍有属于当前恢复后数据集的未决意图或回执无法核实，返回阻断结果并保持任务准入关闭。不能用 `reloadAfterRestore() === true` 表示“只检查了作业，没有检查发布日志”。
4. 在 [server.ts](../apps/api/src/server.ts) 的恢复成功分支，按顺序完成：替换数据库提交 → 写入并复核新 epoch 和 scope → 重裁决作业/发布意图 → 确认无其他阻断 → **最后**解除本次导入恢复 token → 唤醒导入、命令、重算和预测 worker。任何步骤失败都保持关闭，并在响应中明确 `restartRequired` 或恢复错误；不得返回一个暗示同进程已经恢复的普通成功响应。
5. 保证中断可重放：在“数据库已替换、发布意图尚未收口”与“意图已收口、token 尚未解除”两个崩溃点重启后，均能从持久 epoch、恢复记录和发布日志得出同一结论。内存 token 仅控制当前进程，不充当持久证据。

### 验收条件

- 构造一个当前 scope 的 `recovery_required` 导入任务，确认恢复前 `TaskAdmissionScheduler.acquire()` 返回 `null`；执行有效备份恢复后，`restored: true`、`databaseReady: true`，且**同一进程内**新导入任务实际进入 `running` 并完成，而非仅成功入队。
- 恢复前若存在已阻断的发布意图，恢复后其旧提交事实被持久标记为由显式恢复取代；重启不再因该旧意图重新阻断。若不能安全裁决，响应必须要求重启/人工处置，业务仍保持关闭。
- 同时存在其他永久阻断时，完成备份恢复不得解除它；任务仍拿不到准入许可，响应不得报告“同进程已恢复”。
- 在解除 token 之前注入进程中断，重启结果与无中断路径一致；无重复发布、无旧作业被误报为取消/未提交。

## 二、恢复失败时释放临时冻结，或保持可解释的恢复阻断

### 现状与失败路径

`prepareForRestore()` 立即设置 `ImportWorker.recoveryBlocked = true`。随后 [maintenance.ts](../apps/api/src/maintenance.ts) 仍可能在备份不存在、备份身份/完整性校验失败、安全备份失败、替换门或文件操作失败时抛错。路由的 `finally` 仅把 `restoringDatabase` 设回 `false`；没有清除此临时 worker 阻断。一次不存在的备份请求因此足以使后续导入一直停在队列中。

### 修复方法

1. 将“恢复期间临时冻结”从“回执/发布事实不确定的持久恢复阻断”分离。`prepareForRestore()` 设置独立的 `restoreFreeze`，停止并等待 ingest 线程退出，然后返回一个幂等的冻结句柄；`scheduleNext()` 同时检查两种阻断。它不得把一次普通恢复尝试永久写成 `recoveryBlocked`。
2. 恢复路由持有该句柄直到数据库替换与最终化结束。恢复成功时，由第一节的重裁决逻辑决定能否释放临时冻结和原恢复阻断；恢复失败时，只有拿到**结构化、可核验的失败证据**才能释放临时冻结。不要根据错误文案、`existsSync()` 或单一 `quick_check` 猜测原库仍可用。
3. 让 `DatabaseMaintenance.restoreBackup()` 对失败分支提供至少以下证据：是否触及主库字节、原库是否保留或已验证回滚、替换门是否释放、恢复日志是否已收口，以及当前主库 epoch 是否仍与调用前一致。调用方还要独立检查数据库身份/必要表与侧车 scope。只在证据全部成立且原本没有独立的 `recoveryBlocked` 时解除冻结并重新调度；否则抛出/保持 `RestoreRecoveryRequiredError`，关闭业务写入，保留恢复入口。
4. 将明显的无副作用预检（备份名、备份存在与候选可读性）尽量放在冻结之前，但保留冻结后的复核以防文件竞态。预检只是减少冻结窗口，不能替代失败清理。
5. 保证 `finally` 的幂等释放不会覆盖一个在恢复过程中新增的真正恢复阻断。可以用冻结句柄的身份或代次来限定释放对象，不能使用无条件 `recoveryBlocked = false`。

### 失败分支判据

| 失败点 | 主库/替换门证据 | 期望处理 |
|---|---|---|
| 备份名无效、备份不存在、候选校验失败，尚未触及主库 | 原库身份/epoch 不变，恢复日志为空，替换门未进入 | 返回原有 400/404/校验错误；释放临时冻结；原本可运行的导入继续运行 |
| 已进入替换门，但原库完整回滚并验证 | 原库身份/epoch 与请求前相同，替换门已释放，恢复日志收口 | 返回恢复失败；只释放临时冻结，不解除此前独立的恢复阻断 |
| 主库或 WAL/SHM 回滚不能证明成功、替换门未释放、恢复日志仍开着 | 任一证据缺失 | 返回恢复必需错误；保留业务阻断和恢复入口；不得调度新写者 |

### 验收条件

- 在原本健康的 API 上请求不存在的备份，得到 `backup_not_found`；随后在**同一进程**提交有效导入，确认任务完成且回执可读。无需要重启才能恢复的隐藏队列阻断。
- 对损坏备份、候选校验失败、安全备份失败及替换门后的可回滚失败分别覆盖上述表格；验证 HTTP 状态、健康状态、任务准入、worker 调度和持久恢复日志彼此一致。
- 故障注入使主库恢复或替换门释放失败时，后续写请求被拒绝，原库/快照保留，恢复端点可用；重启重裁决不会自动创建空主库。
- 连续两次失败恢复及失败后一次成功恢复不会泄漏冻结句柄，也不会错误释放另一项恢复阻断。

## 三、放弃旧 scope 时复用唯一的新 epoch

### 现状与失败路径

`applyAbandonAndCreateNewEpoch()` 每次调用都先 `randomUUID()`，再由 `RuntimeStateStore.abandonWriterEnteredScope()` 在一个事务里把旧 scope 标为 `abandoned`、插入新 `pristine` 许可和 `scope_abandonments` 行，最后另行写删库侧车。如果进程在账本事务提交后、侧车写入前退出，重试时仍读到旧的有效 epoch；现有逻辑允许再次从 `abandoned` 行发放许可，但使用了第二个 UUID。第一张许可没有被消费，也没有被撤销。

### 修复方法

1. 为 `scope_abandonments.old_scope` 建立唯一操作约束；升级已有表时先检查重复历史行，遇到冲突即拒绝自动迁移并给出运维诊断，不静默挑选其中一行。
2. 在同一作用域初始化锁下，先以 `old_scope + old_epoch` 查询账本中已有的放弃操作：
   - 没有记录：生成一次 UUID，在**同一个 runtime.sqlite 事务**中写旧 scope `abandoned`、新 scope `pristine` 和包含 `new_epoch/new_scope/operator/reason` 的操作记录。
   - 已有记录：复用持久化的 `new_epoch/new_scope`；逐项验证旧 scope 状态、新许可来源、未撤销/未消费状态及操作身份。任何冲突都拒绝，不生成新 UUID。
3. 仅用上述确定的新 epoch 写侧车并收口删除日志。侧车写入使用 compare-before-write：仍指向旧 epoch 时可完成；已指向同一新 epoch 时返回“已完成”；指向其他 epoch 时拒绝。两步之间的崩溃重试必须只补齐第二步。
4. 把 `--confirm-abandon <旧 epoch>` 作为重试操作身份的一部分。即使默认检查显示侧车已切换到新 epoch，重复提交同一命令也只报告该操作已完成；不能再造许可。另一旧 scope、另一新 epoch 或不相容的操作者说明应要求人工核对。
5. CLI apply 分支与其他会初始化 scope 的运维入口共享排他锁边界，并在锁内复核主库及 WAL/SHM 仍不存在；并行执行时只有一个操作可以创建许可。

### 验收条件

- 在账本事务提交之后、侧车写入之前注入 `SIGKILL`；以相同命令重试，得到**同一** `new_epoch`，`scope_abandonments` 恰好一行，相关 `pristine` 许可恰好一张，侧车最终指向该 epoch。
- 在侧车写入之后、命令输出之前注入 `SIGKILL`；重试报告已完成，不改 epoch、不新增许可或 abandonment 行。
- 并行运行两条相同 apply 命令，最终只有一个新 epoch；失败方给出可重试/已完成结果。用不同 `--confirm-abandon` 或冲突的历史证据重试时明确拒绝。
- 新 epoch 的首包只消费一次许可；旧 scope 的作业仍保持 `superseded`/未核实语义，重启不复活旧许可。

## 实施与回归顺序

1. 先补 [task-admission.test.ts](../apps/api/test/task-admission.test.ts) 的多阻断/token 状态机测试，以及 [import-worker-reuse.test.ts](../apps/api/test/import-worker-reuse.test.ts) 的冻结句柄和恢复后实际调度测试。
2. 扩展 [dataset-deletion-recovery.test.ts](../apps/api/test/dataset-deletion-recovery.test.ts)：在现有“恢复返回 200、健康检查 ready”之后，必须提交并完成一项新导入；添加失败恢复矩阵和两个 CLI 崩溃边界。补 [import-publication.test.ts](../apps/api/test/import-publication.test.ts) 的显式恢复取代旧意图与重启重放测试。
3. 实施生产状态机与持久记录，再跑定向回归；不要先用无条件清除 `blocked` 的方式让测试变绿。
4. 按仓库门禁执行 `npm run typecheck`、`RAI_TEST_CONCURRENCY=2 npm test`、`npm run check:docs`、`npm run check:acceptance-matrix`（测试改动后）、`npm run check:scripts`。若改动触及 API 启动，再跑 `npm run smoke:api`。发布记录写明测试并发、结果和故障注入点。

## 完成判定

三条路径都要满足同一原则：**只根据持久证据改变恢复状态**。有效备份恢复结束后，同进程调度真的可用；无副作用的恢复失败不会留下隐藏的永久冻结；无法证明回滚成功时继续阻断；一次放弃旧 scope 无论中断和重试多少次，都只有一个可消费的新 epoch 许可。对应自动化验收和重启故障注入全部通过后，才可把本方案标为已实施。

## 实施记录（2026-10-23）

三条路径均已按“只根据持久证据改变恢复状态”实现：

- 任务准入改为多阻断集合 + token：导入回执/发布意图阻断可被一次已验证的显式恢复解除，其他
  `RestoreRecoveryRequiredError` 仍为永久阻断；`snapshot()` 保留全部活跃原因。
- `ImportWorker` 的恢复期临时冻结与 `recoveryBlocked` 分离；`reloadAfterRestore()` 同时重裁决作业与发布意图，
  发布意图以 `import_publication_supersessions` 持久记录取代后才失效。
- `restoreBackup()` 的失败分支携带结构化证据，路由独立复核主库身份/必要表/epoch/侧车后才释放冻结。
- `scope_abandonments.old_scope` 唯一；`abandonWriterEnteredScope()` 重放持久化的 `new_epoch`；CLI 以
  `--confirm-abandon + --reason` 作为操作身份，侧车 compare-before-write，`--apply` 共用可回收陈旧锁的排他锁。

自动化验收（`RAI_TEST_CONCURRENCY=2`）与故障注入点见上述验收记录。
