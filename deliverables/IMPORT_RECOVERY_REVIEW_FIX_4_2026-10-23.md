# 导入恢复复审第四轮修复记录（2026-10-23）

状态：已实施；定向回归与静态门禁通过。本记录对应只读复审发现的 7 项问题，
未修改生产数据、未执行部署。

## 修复内容

1. **首次导入的意外 rollback 点不再安装**
   - `ImportPublicationJournal.recover()` 对 `originalExisted=false` 且存在
     `rollbackPath` 的 `prepared` intent 一律进入结构化阻断；不再因为当前主库
     恰好有该任务回执而删除当前库并安装无关 rollback 文件。
   - 回归：`import-publication.test.ts` 的
     “initial import recovery refuses a rollback point even when the active database has its receipt”。

2. **放弃旧 scope 完成后重试的幂等语义**
   - 当侧车已经指向持久化的 `newEpoch` 时，`--confirm-abandon` 重试只校验发布
     操作身份与旧 scope 的 `abandoned` 证据，并允许新 epoch 的一次性许可已被
     首个导入合法消费（`writer_entered` / `established`）；只有侧车仍指向旧
     epoch、确实还要执行第二步时才要求许可保持 `pristine`。
   - 回归：`dataset-deletion-recovery.test.ts` P2-15c；P2-15b 继续覆盖“侧车未
     推进且许可已被消费必须拒绝”。

3. **permit_issued 阶段允许保护快照轮换**
   - CLI 的 `applyDeletionRecovery()` 只在 `prepared` / `main_removed` 阶段要求
     `protectionSnapshotProblem()`；`permit_issued` 只校验账本中已有的未消费许可，
     与启动 reconciler 及 OPERATIONS 的轮换规则一致。
   - 回归：`dataset-deletion-recovery.test.ts` P2-5b；P2-7 的快照缺失反例改用
     `main_removed` 阶段。

4. **存量无 epoch 主库在启动时回填**
   - 启动时对可读、无删除记录、缺少 `rai.dataset-epoch` 行的主库，把当前生效
     epoch 回填到主库；回填失败则保持 `databaseReady=false`，不放行写入。这样
     升级前创建的数据库在删除失败/中断后仍具备 `databaseVerifiedForEpoch()`
     所需的显式身份。
   - 回归：`dataset-deletion-recovery.test.ts` P1-1b。

5. **RestoreJournal 空/截断文件不再 fail-open**
   - `RestoreJournal.read()` 改为只读打开，并要求 `restore_intent` 表存在；
     空 journal 或缺少表的文件进入 `RestoreRecoveryRequiredError`，不再被当成
     “没有恢复意图”。只有 `write()` / `clear()` 可以创建表。
   - 回归：`restore-journal.test.ts` 的 empty journal 反例。

6. **abandoned 状态成为终态**
   - `RuntimeStateStore.upsertScopeTransition()` 拒绝 `abandoned` 向
     `writer_entered` / `established` 的转换；启动观察看到 abandoned 时原样
     返回，不重新登记。旧 scope 只能通过新 epoch 或显式恢复处理。
   - 回归：`import-scope-evidence.test.ts` 的 abandoned 终态用例。

7. **证据清单生成器的跨平台路径**
   - `scripts/phase3-evidence-manifest.mts` 将 platform 分隔符规范为 `/` 后再
     与 `git status` 路径比较，避免 Windows 上生成清单把自身纳入
     `changedFiles` / `treeDigest`。

## 验证

- `tsc --noEmit -p tsconfig.pure.json`：通过
- `tsc --noEmit -p tsconfig.json`：通过
- `node scripts/check-doc-links.mjs`：71 文件 / 588 条本地链接 / 0 问题
- `node --import tsx scripts/check-acceptance-matrix.mts`：80 条，cited 80，missing 0
- `node scripts/check-npm-scripts-portable.mjs`：108 条 script 通过
- 定向回归（逐文件、`--test-concurrency=2`）：
  - `dataset-deletion-recovery.test.ts`：36/36
  - `import-publication.test.ts` + `restore-journal.test.ts` + `import-scope-evidence.test.ts`：44/44
  - `server-runtime.test.ts`、`import-scope-fresh-install.test.ts`、`dataset-epoch-legacy.test.ts`、`import-worker-reuse.test.ts`：68/68
  - `maintenance.test.ts`：42/42（1 个环境跳过）
- 完整测试：`RAI_TEST_CONCURRENCY=2 node scripts/run-tests.mjs`（Node v22.23.2）：
  2478 个测试，2465 通过，0 失败，13 跳过，duration 782.5 s。

未执行需要 macOS Simulator 的 iOS 视觉验收。
