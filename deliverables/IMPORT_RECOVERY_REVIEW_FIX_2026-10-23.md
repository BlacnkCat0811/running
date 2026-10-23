# 导入恢复审查修复验收记录（2026-10-23）

状态：已实施；自动化验收见下。生产部署未包含在本次记录内。

对应方案：[IMPORT_RECOVERY_REVIEW_FIX_PLAN_2026-10-23](../docs/IMPORT_RECOVERY_REVIEW_FIX_PLAN_2026-10-23.md)。

## 修复内容

1. **恢复成功后解除正确的任务阻断**
   - `TaskAdmissionScheduler` 改为按身份保存**多个**阻断（`permanent` / `recovery`）。`blockUntilRestart()` 只增不减；
     `beginRecoveryBlock()` 返回唯一 token，`resolveRecoveryBlock()` 只接受匹配 token，且不会触碰其他阻断。
   - `ImportWorker.prepareForRestore()` 返回可幂等复用的临时冻结句柄，不再把普通恢复尝试写成 `recoveryBlocked`。
   - `ImportWorker.reloadAfterRestore(restoredEpoch)` 同时重裁决**作业**与**发布意图**：旧 scope 作业持久 `superseded`；
     旧 `import_publications` 意图写入 `import_publication_supersessions` 持久记录后失效，重启不会重新阻断。
   - `server.ts` 恢复成功分支顺序固定为：替换数据库 → 新 epoch/scope 落盘 → 重裁决 → 检查其他阻断 → 解除 import token → 唤醒 worker。

2. **恢复失败时释放临时冻结或保持可解释阻断**
   - `DatabaseMaintenance.restoreBackup()` 的每个失败都携带结构化证据（是否触及主库、原库快照是否持久、回滚是否验证、
     回滚错误数、替换门是否释放、恢复日志是否收口）。
   - 路由另做独立检查（主库身份/必要表、epoch 未变、侧车 scope 一致），由 `decideRestoreFailureRelease()` 统一判定。
     只有全部成立且此前没有独立恢复阻断时才释放冻结；否则保留冻结并抛 `RestoreRecoveryRequiredError`。
   - 明显的无副作用预检（备份名、存在、候选库身份）在冻结**之前**执行；恢复流程内再复核文件名/存在性并做完整候选校验，
     避免文件在冻结窗口内变化。

3. **放弃旧 scope 时复用唯一的新 epoch**
   - `scope_abandonments.old_scope` 增加唯一约束；迁移前检查重复历史，冲突即拒绝并给出诊断。
   - `RuntimeStateStore.abandonWriterEnteredScope()` 在同一事务里按 `old_scope + old_epoch` 查询既有操作；存在则逐项校验并复用
     持久化的 `new_epoch/new_scope`，不再生成第二个 UUID。
   - CLI 以 `--confirm-abandon` + `--reason` 作为操作身份：账本提交后崩溃只补侧车；侧车写入后崩溃只报告已完成。
   - 所有 `--apply` 分支共用 `var/import-scope-init.lock`；锁内记录同机 PID，持锁进程被强杀后可由下一次运行安全接管。

## 故障注入点

| 故障点 | 位置 | 用途 |
|---|---|---|
| `restore:after-install` | `maintenance.ts` 安装候选库之后 | 替换门后失败、验证回滚释放冻结 |
| `restore:rollback-original` | `maintenance.ts` 回滚原库入口 | 回滚本身失败、保持阻断并要求重启 |
| `restore:before-token-resolution` | `server.ts` 解除 token 之前 | 已替换库/已收口意图、token 未解除的崩溃点 |
| `scope-abandon:after-ledger-commit` | `import-scope-cli.ts` 账本事务之后 | 侧车未写、重试复用同一 epoch |
| `scope-abandon:after-sidecar-write` | `import-scope-cli.ts` 侧车写入之后 | 重试只报告已完成 |

`RAI_FAULT_POINT` 支持逗号分隔的多个屏障，便于一次运行同时注入“安装失败 + 回滚失败”。

## 验收映射

| 方案验收条件 | 自动化证据 |
|---|---|
| 恢复前 `acquire()` 为 null；恢复后同一进程新导入实际完成 | `dataset-deletion-recovery.test.ts` P1-7；`import-worker-reuse.test.ts` 恢复冻结/重裁决用例 |
| 旧发布意图被显式恢复持久取代，重启不再阻断 | `import-publication.test.ts` 两个取代用例；P2-17 |
| 另一永久阻断不被解除、响应不宣称同进程恢复 | `task-admission.test.ts` 多阻断/token 用例；`server.ts` 显式顺序 |
| token 解除前中断，重启结果一致 | P2-18 |
| 不存在/损坏/候选校验失败不留下隐藏冻结 | P2-13、P2-20 |
| 替换门后完整回滚只释放临时冻结 | P2-14 |
| 回滚失败保持阻断、恢复入口可用、重启从日志复原 | P2-19 |
| 连续失败后一次成功恢复不泄漏冻结 | P2-13 |
| 放弃命令两个崩溃边界复用同一 epoch | P2-15、P2-16 |
| 并行执行只有一个新 epoch；冲突操作者说明拒绝 | P2-21；`import-scope-evidence.test.ts` 唯一约束用例 |
| 新 epoch 首包只消费一次许可 | P2-15 扩展（首包 + established） |

## 验证命令与结果

- `tsc --noEmit -p tsconfig.pure.json`：通过
- `tsc --noEmit -p tsconfig.json`：通过
- `RAI_TEST_CONCURRENCY=2 node scripts/run-tests.mjs`：见下方“全量结果”
- `node scripts/check-doc-links.mjs`：68 个文件 / 585 条本地链接 / 0 问题
- `node --import tsx scripts/check-acceptance-matrix.mts`：80 条，cited 80，missing 0
- `node scripts/check-npm-scripts-portable.mjs`：通过
- `node apps/api/test/production-runtime-smoke.mjs`（`npm run smoke:api`）：通过

## 全量结果

`RAI_TEST_CONCURRENCY=2 node scripts/run-tests.mjs`（2026-10-23，本机 Node v24.21.0）：

- **2442 个测试；2428 通过；1 失败；13 跳过；0 取消**（duration 669 s）。
- 唯一失败是**本机执行环境**问题，与本次改动无关：
  `packages/prediction-inference/test/prediction-inference.test.ts`：`onnxruntime-node` 的 macOS x64 原生模块
  未签名，当前 node 运行时为 Developer ID 签名（Team `NAN929V4UM`），dlopen 报 Team ID 不匹配；
  属于本机运行时签名限制，不调用到本改动。原生模块的纯逻辑测试全部通过。
- 本机 PATH 没有 `npm`（只有 node 运行时），因此 `apps/api/test/node-version.test.ts` 需要一个 npm 兼容 runner；
  以 pnpm 包装为 `npm` 后该文件 **3/3 通过**，全量结果即在该 PATH 下取得。
- 与本改动相关的套件全部通过：`task-admission`（4）、`import-publication`（17）、`import-worker-reuse`（27）、
  `restore-evidence`（6）、`dataset-deletion-recovery`（28，含 P2-13…P2-21）、`import-scope-evidence`、
  `server-runtime`、`maintenance`、`coach-acceptance-replays`（4）。
- 故障注入点（`restore:after-install`、`restore:rollback-original`、`restore:before-token-resolution`、
  `scope-abandon:after-ledger-commit`、`scope-abandon:after-sidecar-write`）均由真实子进程 +
  `SIGKILL`/`throw` 执行，不是计时窗口。

## 已知边界

- “同时存在其他永久阻断时成功恢复仍不解阻断”的黑盒集成用例无法在不引入测试专用生产钩子的前提下构造：
  一旦进程内出现永久阻断，恢复日志同时处于打开状态，恢复端点按设计只接受重启/运维处理。该路径由
  `task-admission.test.ts` 的调度器状态机用例与 `server.ts` 的显式顺序覆盖。
- 安全备份失败（备份容量/保留策略错误）在现有测试环境中难以稳定注入；其代码路径在触及主库之前抛错，
  由同一结构化证据判定为“未触及主库”，与 P2-13/P2-20 走同一分支。
