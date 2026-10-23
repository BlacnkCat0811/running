# 导入恢复复审第三轮修复记录（2026-10-23）

状态：已实施；定向回归与静态门禁通过。本记录对应只读复审发现的 5 项问题，
未修改生产数据、未执行部署。

## 修复内容

### 1. 旧 scope 的已终态作业不再永久占用写者

- `ImportWorker.loadJobs()` 现在会处理“状态已是终态、但 `queue.finalized=false`
  且不属于当前 scope”的作业：保留原终态（`succeeded` 不会被伪报为失败），把
  `phase` 标为 `superseded`，并通过 `RuntimeStateStore.finalizeImportJob()` 在同一
  原子操作里清除对应的发布意图。
- 之前这类作业永远不会再被当前 scope 的调度器重试，`hasPendingWrites` 会一直为真，
  导致后续删库/备份恢复返回 409。回归：
  `apps/api/test/import-publication.test.ts` 的
  “旧 scope 已完成但未确认的作业在启动时 superseded 并释放写者”。

### 2. `prepared` 发布窗口内主库缺失时自动恢复旧库

- `ImportPublicationJournal.recover()` 对 `prepared` 意图区分两种正常崩溃窗口：
  候选库已装入且回执已提交（回执可读），以及旧库已移到 rollback 文件、候选库尚未
  装入（主库缺失）。
- 后者现在会用现存 rollback 文件恢复旧库；恢复前以只读 `quick_check` 验证回滚点，
  校验失败则保留现场并进入结构化阻断，不再把可自动回滚的启动转成人工恢复。
- 对 `originalExisted=false` 的首次导入，若出现不属于本次操作的 rollback 文件仍拒绝安装。
- 回归：`apps/api/test/import-publication.test.ts` 的
  “prepared rollback with missing main restores the displaced old database”与
  “prepared rollback that fails integrity validation blocks instead of installing it”。

### 3. 放弃旧 scope 的重试复用许可重放校验

- `RuntimeStateStore` 公开 `assertAbandonmentReplayable()`，复用账本原有的
  `assertAbandonmentReplayableInDb()`：复核旧 scope 的 `abandoned` 证据、新 scope
  许可存在、`pristine`、来源匹配且未撤销/未消费。
- `apps/api/src/import-scope-cli.ts` 在重试分支写侧车前调用该校验。许可缺失、
  被撤销或已消费时拒绝推进侧车，不会留下“新 epoch、无可用许可”的状态。
- 回归：`apps/api/test/dataset-deletion-recovery.test.ts` 的
  “P2-15b 放弃重试发现新 epoch 许可已被消费：拒绝推进侧车”。

### 4. `--from-log` 不再把失败测试记为通过

- `scripts/phase3-equivalence-summary.mts` 同时解析 TAP（`# fail N`）与 spec
  reporter（`ℹ fail N`）汇总；`fail > 0`、`cancelled > 0`、存在 `not ok` 或缺少
  完整测试摘要时直接失败，不再无条件设 `exitCode = 0`。
- 回归：`apps/api/test/phase3-evidence-scripts.test.ts` 覆盖 TAP/spec 失败日志与
  缺失摘要三种反例。

### 5. 证据清单覆盖未跟踪目录中的文件

- `scripts/phase3-evidence-manifest.mts` 改用
  `git status --porcelain=v1 -z --untracked-files=all`，逐个收集未跟踪目录中的文件；
  同时把每个变更文件的内容 SHA-256 纳入 `treeDigest`（`git diff` 不含未跟踪内容）；
  仅排除生成器自身，避免自引用哈希。
- 重新生成的 `evidence/manifest.json` 从 52 个文件增加到 **172 个**（生成器自身不计入自哈希），
  与 `git status --untracked-files=all` 的工作树范围一致。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.pure.json`：通过
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：通过
- `node scripts/check-npm-scripts-portable.mjs`：通过（108 条 script）
- `node scripts/check-doc-links.mjs`：通过（69 文件 / 586 链接 / 0 问题）
- `node --import tsx scripts/check-acceptance-matrix.mts`：80 条 / cited 80 / missing 0
- `node apps/api/test/production-runtime-smoke.mjs`：通过
- 定向回归（`--test-concurrency=2`，Node v24.21.0）：
  - `import-publication.test.ts`：20/20
  - `import-restart-receipt-recovery.test.ts`：14/14
  - `import-worker-reuse.test.ts`：27/27
  - `import-queue.test.ts` + `import-source-finalization.test.ts`：8/8
  - `dataset-deletion-recovery.test.ts`：33/33
  - `server-runtime.test.ts`：31/31
  - `phase3-evidence-scripts.test.ts`：3/3

未执行完整 `npm test`（本会话无 npm 可执行文件，使用仓库内 Node 24 直接运行定向套件）；
未执行需要 macOS Simulator 的 iOS 视觉验收。
