# 导入恢复复审第二轮修复记录（2026-10-23）

状态：已实施；自动化验收见下。本记录对应只读复审发现的两个问题：
`deletion-recovery.ts:252-253`（`main_removed`/`permit_issued` 把可读主库误判为删除回滚成功）与
`direct-sync-ingest.ts:886-900`（路线归属冲突依赖 XML 顺序）。

## 修复内容

### 1. 收紧删库恢复裁决

- `prepared`、`main_removed`、`permit_issued` 的“原库回滚”都要先核对主库显式
  `rai.dataset-epoch` 与删除记录：`main_removed`/`permit_issued` 要求显式 epoch 等于
  `previousEpoch`，并复用 `protectionSnapshotProblem()` 校验保护快照的名称、文件集与
  SHA-256 字节绑定。
- `prepared` 同样要求主库有显式 epoch；可读但无 `rai.dataset-epoch` 行的外来 SQLite 文件不再被
  推断为 `previousEpoch`。旧库必须由显式备份恢复或运维确认路径处理。
- 可读主库出现其他 epoch（或 `main_removed`/`permit_issued` 下没有显式 epoch）时返回
  `recovery_required`，不撤销 `nextEpoch` 许可、不关闭删除日志。
- `writer_entered` 不再以“可读且 epoch 不同”推断显式恢复完成；只有 `nextEpoch` 或由持久恢复
  意图收口后的状态才可继续。`rolled_back`/`superseded` 也必须让可读主库的显式 epoch 与侧车最终
  epoch 一致，否则保持 `recovery_required` 并报告侧车 epoch，不把外来 epoch 登记为 `established`。

### 2. 显式备份恢复的崩溃重放

- `restore-journal.ts` 增加 `version: 2` 的 `BoundRestoreIntent`：在替换主库前记录
  `deletionId`、备份名/大小/SHA-256、`plannedEpoch`、`configuredEpoch`、部署身份；主库
  checkpoint/fsync 后写 `committed` 阶段与主库 SHA-256。
- 原库本不存在的失败恢复保留唯一可读的候选库（不删除现场）但保持恢复意图打开；重启从
  `installed` 阶段把“原本无主库”的状态恢复出来，避免半恢复被当作已提交。
- `DatabaseMaintenance.finalizeCommittedRestore()` 幂等收口：校验主库字节、epoch、SQLite
  身份/必要表 → 撤销并关闭绑定的删除意图 → 登记恢复 scope → 将恢复前发布意图持久标记为
  被本次恢复取代 → 最后才清除恢复意图。
- `recoverInterruptedRestore()` 启动时只依据这份恢复意图及主库校验结果重放；`prepared`/
  `installed` 阶段仍从不可变保护快照回滚原库。无法验证时保持
  `RestoreRecoveryRequiredError`，不猜“可读即成功”；启动失败以 fatal 日志和退出码 78 受控失败。
- 只有 legacy/低层调用在“原库本来损坏且完整恢复损坏组”时才允许清除未绑定 intent；生产绑定
  intent 必须等启动重放验证后才清除。

### 3. 路线归属冲突按完整 XML 声明集判定

- 解析器新增 `onRouteDeclaration`，在每个显式 `WorkoutRoute` 的父训练身份确定后回调，
  包含归属未变化的声明；路径使用与存储一致的规范化形式。
- 直连接收器在解析后按“规范化路径 → 父训练 ID”检查完整声明集；同一路径对应两个不同父训练
  即返回既有 `route_ownership_conflict` 并回滚整批。实际归属变化观察器继续负责旧、新训练
  的脏范围，二者职责分离。
- 声明携带父训练的 `tombstoned` 标记：本批 `deletedWorkoutIds` 命中或实体已墓碑的父训练不参与
  冲突判定，避免“删除旧训练、把路线转给新训练”的合法批次被误拒。同一训练重复声明同一路径仍通过。

## 回归覆盖

- `apps/api/test/deletion-failure-evidence.test.ts`：`main_removed`/`permit_issued` + 外来可读
  epoch 均保持 `recovery_required`，许可不撤销、日志不关闭；原库回滚校验保护快照身份；
  `writer_entered` 的可读新 epoch 无恢复意图时阻断，有持久 `committed` 意图时收口为
  `superseded`。
- `apps/api/test/dataset-deletion-recovery.test.ts`：新增两个删库阶段的黑盒外来可读主库用例；
  `restore:after-commit` 与 `restore:before-journal-clear` 两个 SIGKILL 恢复重放用例。
- `apps/api/test/restore-journal.test.ts`：`prepared`/`moved`/`installed`/`committed` 全阶段；
  committed 主库 epoch/字节不匹配不推断成功；生产入口写出的绑定意图字段与最终清除顺序。
- `apps/api/test/import-worker-direct-sync.test.ts`：A→B、B→A 两种 XML 声明顺序都拒收，
  同一路径同一父训练重复声明通过，已删除父训练的同路径声明不误拒；
  `phase3-import-matrix.test.ts` 的双重归属变更拒收继续通过。

## 验证

- `npm run typecheck`：通过。
- `node scripts/check-doc-links.mjs`：69 个文件 / 586 条本地链接 / 0 问题。
- `node --import tsx scripts/check-acceptance-matrix.mts`：80 条，cited 80，missing 0。
- `node scripts/check-npm-scripts-portable.mjs`：通过。
- `node apps/api/test/production-runtime-smoke.mjs`（`npm run smoke:api`）：通过。
- `RAI_TEST_CONCURRENCY=2 npm test`：全量结果见下方“全量结果”。

## 全量结果

`RAI_TEST_CONCURRENCY=2 npm test`（2026-10-23，本机 Node v24.21.0）：

- 2462 个测试；2448 通过；1 失败；13 跳过。唯一失败为已知本机环境限制：
  `packages/prediction-inference/test/prediction-inference.test.ts` 的 `onnxruntime-node` macOS x64
  原生模块签名限制（与本次改动无关）。`apps/api/test/node-version.test.ts` 在 PATH 提供 pnpm
  兼容 `npm` shim 后 3/3 通过。
