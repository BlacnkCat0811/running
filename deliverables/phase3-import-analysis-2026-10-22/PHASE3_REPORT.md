# RAI 阶段 3 实施与验收报告（双车道导入与分析依赖边界）

- **基线：** `/Users/ta/running`，HEAD `16a12296d62a77b45be9a96a38d90163ce2f5b13`（2026-10-22，实施开始时工作区干净）。
- **依据：** `/Users/ta/Downloads/RAI_Phase3_Implementation_Plan_2026-10-22.md`（下称“方案”）。
- **性质：** 研发实施与验收记录；**未部署、未操作生产库、未进入阶段 4**。
- **证据索引：** `STATE_CONTRACT.md`、`DEPENDENCY_MATRIX.md`、`TEST_MATRIX.md`、`evidence/`。
- **测试并发：** 所有行为套件使用 `--test-concurrency=2`；完整 `npm test` 使用 `RAI_TEST_CONCURRENCY=2`。本次复审在目标 macOS 主机上用 nvm 提供的 Node `v22.23.2` + npm `10.9.8`（满足 `engines`）执行，`onnxruntime-node` 在该运行时下可正常加载；逐条命令与退出码见 `evidence/manifest.json`。

## 1. 结论摘要

阶段 3 的核心实现已落地；复审问题的修复状态与验收证据见 §1.1 与 §5：

1. **回执合同收口（P3-02）：** no-op 新回执显式写 `analysisJobId: null`；direct-sync 非分析回执的 `dependencyGeneration` 改为 `null`；旧回执缺键/旧值原样读取、原样重放。
2. **重启恢复四态 + 作用域首空状态机 + 删库操作日志（P3-03 / P1 / P2）：** `loadJobs()` 不再把“回执读取失败/主库缺失”降级为“没有回执”；`found / confirmed_absent / missing / unreadable` 四态落地。首次空库许可升级为 `import_scope_evidence` 的单调状态机 `unknown → pristine → writer_entered → established`：**没有任何路径**会根据“文件不存在”自动写 pristine；真正首次安装必须运行 `npm run data:init-scope -- --apply --fresh-install`（默认模式只读检查）。删库改为持久 `dataset_deletion` 操作日志（`prepared → main_removed → permit_issued → writer_entered`，`deletionId` + 保护快照 + runtime 账本实例绑定）：`prepared + 主库仍在` 自动回滚旧 epoch；`prepared + 主库缺失` 保持 `recovery_required`，运维核对快照后经 `--deletion-id --confirm-main-removed` 完成；`main_removed` 幂等补发同一 `nextEpoch` 许可；`permit_issued` 只消费已有许可；`writer_entered` 后主库再消失或账本隔离重建都不建新空库。执行前 `markScopeWriterEntered` 失败即阻断；写者进入顺序为 runtime 账本 → 侧车 → 主库。其余 missing/unreadable 一律阻断，不发布猜测终态、不释放写者。
3. **真实缺陷修复（P3-04）：**
   - T05：未知 record 类型与有界已知变更混合时，未知影响不得借用已知边界；现在强制 `full`（`unknown_record_type`）。
   - T11(a)：纯 GPX 同大小内容替换不再因 canonicalize 的净零 workout 写在写守卫处整批拒绝；路线版本摘要真实更新，所属训练进入脏范围。
   - T11(b)：路线归属 A→B 且 GPX 字节相同时，显式引用路径改归新训练（复用旧 route 行，保留点/指纹/版本），旧、新归属都进入 `routeDirtyTimes`。
   - T11(c)（复审新增）：归属变化的脏证据改为在 `insertWorkout` 实际 UPDATE 处观测，不再依赖“本批带了哪些 GPX 文件”；仅 XML 改归属、增量包省略未变化 GPX 时，旧 A/新 B 仍同时进入脏证据。同批同一路径两次归属变更确定性拒收。
4. **计划前提更正（不是代码缺陷）：** 方案 §4.3/T14 写“direct-sync Record ≤ 5000”，但当前产品合同明确 `directSyncBounds.maxRecords` **只约束删除配额**、不约束 XML `<Record>` 条数（iOS 允许到 12,000）。本阶段按真实合同执行，**没有收紧** XML 记录条数；详见 §3.4。
5. **逐域完整产物等价（P3-05/P3-06，复审后二次加固）：** 完整业务投影比较器现覆盖 **15 张表/投影**：load/zone 逐会话、`training_sessions` 自身全业务列、ability assessments、daily snapshots、五域封存 payload、`model_release_bundles`（含 normalized `evaluation_json`、快照域/投影哈希、激活事实）、`release_readable_state`（active 指针、可读域、`analysisStatus`/`freshness`）、input binding/coverage。正向/拒绝场景 + 22 个比较器负对照全部通过（含 `training_sessions`/`model_release_bundles`/`release_readable_state` 的缺表、缺列、业务值变化控制）；增量 A 与同条件全量 B 的 raw `baselineEpochId` / `calibrationCohortHash` 逐字段相等，不再做语义替换。T12 真实车道改为“真实到达 + 原任务消费”：52 天按日/分段导入，A 直接领取导入事务登记的 `analysisJobId` 并经生产消费者完成 partial 发布，input binding/coverage/`reuse.proof=verified` 以及**精确断言** loads/zones/daily `reused=4`（固定 52 天夹具与固定 `EVAL_2` 时钟下的确定性值）为直接证据；B 是“生产导入修订批次 + 生产取消接口取消原分析任务 + 测试 `enqueueControlledFull()` 受控全量分析”的对照侧，不是生产全量主路径（报告不得再把它写成生产导入任务自己生成全量请求）。readiness 完整输出等价、中间 36..49 不变、Fitness 未被污染；T11 仅 XML 改归属场景 complete A/B：loads 39/2、zones 39/4、daily 39/4、features 39/2、assessments 32。
6. **调度/合并/发布闭环（P3-07）：** 既有持久任务、唤醒巡检、合并/重排、raw-only vs analysis-required、发布事务与 F10 补测全部有本次通过证据（见 `TEST_MATRIX.md`）。

**复审缺口收口：** 第一轮 P1/F01/T12 缺口已由作用域状态机、删除+GPX 确定性屏障、发布全投影与 15 表比较器补齐。第二轮 **删库恢复协议**改为持久操作日志 + 同源账本实例校验 + 分阶段启动裁决 + CLI 显式恢复，原 9 条真实子进程故障用例（G11）覆盖四阶段与旧备份恢复；**T12** 改为真实到达 52 天 + A 原任务真实消费，并加入到达时间/active 指针负对照。最新复审提出的四项恢复缺口已按 §10 收口；G11 是此前轮次的历史目标套件，最新目标套件为 G12/G13，完整套件与命令清单见 §4 和 `evidence/manifest.json`。阶段 3 尚未部署生产。

### 1.1 复审问题与状态

| 审查问题 | 修复 | 状态 | 验收证据 |
|---|---|---|---|
| 1. 数据库缺失被误判为“确认没有回执” | 读取函数缺库返回 `missing`；入队持久记录 `databaseAbsentAtEnqueue`；仅 `queued + attempts=0 + missing + 当前 scope 的 pristine 许可` 走首次空库政策；其余阻断 | ✅ 已修复 | `import-restart-receipt-recovery.test.ts` 14/14：已提交+缺失库+cancelRequested 不发布 cancelled，恢复后原回执；缺许可的旧作业阻断 |
| 2. 仅 XML 改归属而本批未附 GPX 时旧训练漏脏 | 事务内 `RouteOwnershipChange` 观察器从实际 UPDATE 捕获旧/新归属；合并进 `changedRouteIds` / `routeDirtyTimes`；同批矛盾归属拒收 | ✅ 已修复 | `phase3-import-matrix.test.ts` 15/15；`P3-06 T11` 增量 A/全量 B 完整投影等价，A 路线特征 0、B 3 |
| 3. 增量/全量 raw epoch/cohort 偏差 | checkpoint 恢复按 training session 重映射校准集合；复制 checkpoint 写重映射 state/hash；比较器改 raw 值 | ✅ 已修复 | G4 42/42；连续两轮 epoch 稳定；4 条 raw hash 篡改负对照失败 |
| 4. 验收结论超证据范围（T12 原任务主路径） | T12 改为真实到达 52 天、A 直接领取导入事务登记的 `analysisJobId` 并由生产消费者完成 partial 发布；取消 B 的登记任务后同父全量对照；不再 DELETE 原任务/复制计划/事后改 canonical 到达时间；加入到达时间与 active 指针负对照 | ✅ 收口 | `phase3-t12-real-lane.test.ts` G10 1/1；input binding + coverage + `reuse.proof=verified`；`TEST_MATRIX.md` T12；本报告 §4/§5 |
| 5. **删库提交与首空许可跨两个持久状态（P2）** | 侧车新增 `dataset_deletion` 操作日志（`deletionId`/previous+next epoch/保护快照/runtime 实例/单调阶段）；启动按阶段裁决；CLI 默认只读检查、`--fresh-install`/`--deletion-id` 显式模式；写者进入顺序 runtime 账本→侧车→主库 | ✅ 已修复 | `dataset-deletion-recovery.test.ts` 19/19（G11，最终日志）；prepared/main_removed/permit_issued/writer_entered 强杀、账本隔离重建、CLI 失败关闭、旧备份恢复 |
| 5. **P1 多任务首次空库绕过恢复阻断 + 旧库缺失/账本丢失** | 作用域账本改为 unknown→pristine→writer_entered→established 状态机；启动登记旧库；受控 `data:init-scope`；显式删除/恢复 scope 转移；执行/恢复只认 pristine 许可，旧版自动空行迁移为 unknown | ✅ 已修复 | `import-scope-evidence.test.ts` 9/9（旧库升级/首次登记前缺失/启动后消失/账本损坏/首次安装/写失败/epoch）；`import-restart-receipt-recovery.test.ts` 14/14（A/B 双任务） |

### 1.2 2026-10-23 复审问题修复状态（P1/P2/P3）

| 编号 | 修复落点 | 状态 | 直接回归 |
|---|---|---|---|
| P1-1 旧删除 epoch 被忽略 | `readDatasetEpochState()` 主库无行时严格读取侧车 epoch；主库不可读与“无行”分开；`backfillDatasetEpochToMain()` compare-before-write | ✅ 代码+定向回归 | `dataset-epoch-legacy.test.ts` 5/5 |
| P1-2 启动阻断误撤销许可 | `blocked()` 仅对“主库实际存在且不可读”作不可逆观察；快照/实例/冲突类阻断不撤销许可；`main_removed` 先验证原许可 | ✅ 代码+定向回归 | `dataset-deletion-recovery.test.ts::P1-2` |
| P1-3 删除脏边界丢失 | 删除/别名/存活来源路径保存 `previous_type/effective_at/end_at`；历史缺旧侧升级 `full`；`nightWindow` 读旧区间 | ✅ 代码+定向回归 | `dirty-range.test.ts` 3 条、`import-removal-ledger.test.ts` 2 条 |
| P1-4 恢复阻断期间访问主库 | `deletionRecoveryRequired` 时跳过 `recoverDatabaseJobs`/后台调度；待迁移主库不再退出 78；恢复后再受控重跑 | ✅ 代码+定向回归 | `dataset-deletion-recovery.test.ts::P1-4` |
| P1-5 建库前崩溃 | 新增 `--abandon-and-create-new-epoch`；旧 scope `abandoned`、新 epoch 一次性许可、旧任务 `superseded` | ✅ 代码+定向回归 | `dataset-deletion-recovery.test.ts::P1-5` |
| P1-6 journal 把不可读当无回执 | `recover()` 返回结构化 `blocked`；committed/prepared 的 missing/unreadable 保留现场；构造器不退出 | ✅ 代码+定向回归 | `import-publication.test.ts` P1-6 三条 |
| P1-7 恢复任务阻塞显式 restore | `hasPendingWrites`/`hasRecoveryBlockedJobs` 拆分；`prepareForRestore()`/`reloadAfterRestore()`；restore 后重建状态 | ✅ 代码；HTTP 级 restore 越过已由 G11 覆盖，进程级 SIGKILL 仍属人工演练缺口 | `dataset-deletion-recovery.test.ts::P1-7`、`import-publication.test.ts::P1-7` |
| P1-8 历史 runtime 证据未纳入首装 | 三态预检 + 全量历史扫描 + 初始化锁 + 隔离账本检测 | ✅ 代码+定向回归 | `import-scope-fresh-install.test.ts` 5/5 |
| P1-9 删除失败登记 established | 维护层 `DatabaseDeletionFailure` 结构化证据；server 独立校验 quick_check/表/epoch/gate；先撤许可再收口 | ✅ 代码+定向回归 | `deletion-failure-evidence.test.ts` |
| P2-1 过早 established | 文件存在不再等于 established；established 的诊断写失败不阻断 data-only/no-op | ✅ 代码+定向回归 | `import-scope-evidence.test.ts` 2 条 |
| P2-2 permit_issued 强制快照 | 移除快照前置条件，只校验删除身份/scope/实例/未消费许可 | ✅ 代码+定向回归 | G11 P1-2 |
| P2-3 收口不撤许可 | `revokeDeletionPermit()`；rollback/restore 先撤销 next scope 许可 | ✅ 代码+定向回归 | `deletion-failure-evidence.test.ts::P2-3` |
| P2-4 restore finalization 失败 | `writer_entered + 可读主库` 按主库 epoch 幂等写 `superseded` + 侧车最终 epoch | ✅ 代码+定向回归 | `deletion-failure-evidence.test.ts::P2-4` |
| P2-5 prepared + 不可读主库 | `--list-quarantine` 只读列举 + `--quarantine-unreadable-main` 显式隔离/哈希/manifest | ✅ 代码+定向回归 | G11 P2-5 |
| P2-6 路线归属冲突普通 Error | 稳定 `route_ownership_conflict` / `direct_sync_route_ownership_conflict`；整批回滚；iOS 非重试处置 | ✅ 代码+定向回归 | `import-worker-direct-sync.test.ts::P2-6`、`phase3-import-matrix.test.ts::T11` |
| P2-7 删除记录未绑定身份 | 删除日志 v3 绑定 `serverId+athleteId`；v1/v2 不可签发许可 | ✅ 代码+定向回归 | `dataset-epoch-legacy.test.ts::P2-7` |
| P2-8 routesUpdated 语义 | 合同/文档/客户端文案统一“内容或归属变化的唯一路线数”；内容不变为 0 | ✅ 代码+文档 | `phase3-import-matrix.test.ts::T11` |
| P2-9 退役路由 410 优先级 | `preHandler` 精确 method/path 先放行 410 handler | ✅ 代码+定向回归 | G11 P2-9 |
| P3 | 故障注入双开关、CLI actionRequired、规范时钟、GPX 缓存命中断言、observer finally、公开错误脱敏、同阶段 replay COMMIT、旧写入口标注 | ✅ 代码+定向回归 | 见 `TEST_MATRIX.md` §6 |
| §3 证据 | 15 表投影生成器、T12 精确复用断言、F10 生产路径、比较器自校验、统一计数/manifest | ✅ 本报告与 `equivalence-summary.json`/`manifest.json` 同步重建 | `scripts/phase3-equivalence-summary.mts`、`scripts/phase3-evidence-manifest.mts` |

**状态口径：** 上述代码修复与定向回归已完成；最终 `npm test` 全量日志、`typecheck`、`check:docs`、`check:acceptance-matrix`、`smoke:api` 见 §4 与 `manifest.json`。阶段 3 **仍未部署生产**；P2-4 的进程级 SIGKILL 与“restore 收口后立刻断电”仍建议作为上线前人工演练项，报告不把它们写成已覆盖。

## 2. 实际修改

| # | 工作包 | 文件 | 修改 | 证据 |
|---|---|---|---|---|
| 1 | P3-02 R1 | `apps/api/src/import-database-thread.ts` | `writeNoopReceiptTask` 新回执显式 `analysisJobId: null` | `import-receipt-fields.test.ts` 4/4；`import-payload-preflight.test.ts` |
| 2 | P3-02 R2 | `apps/api/src/direct-sync-ingest.ts` | 非分析批次 `dependencyGeneration: null`；真实代次仍持久化在 `import_generations` / `import_batches` | `import-receipt-fields.test.ts`；`direct-sync-analysis-reconcile.test.ts` |
| 3 | P3-02 R5 | `apps/api/src/direct-sync-ingest.ts` | 校正“观测版回退候选”的过期注释；行为不变 | diff / typecheck |
| 4 | P3-03 R3 | `apps/api/src/import-publication.ts` | `readImportReceiptForRecovery()` 四态：缺失库返回 `missing`（不再 `confirmed_absent`）；严格读取返回类型收窄为非空 | `import-restart-receipt-recovery.test.ts` 14/14 |
| 5 | P3-03 R3 + P1 复审 | `apps/api/src/import-worker.ts`、`runtime-state.ts`、`server.ts`、`import-scope-cli.ts` | `loadJobs()` 使用四态；`import_scope_evidence` 改为 unknown/pristine/writer_entered/established 状态机；启动登记旧库；受控 `data:init-scope`；入队只读 permit，执行前 `markScopeWriterEntered`，建库/观察旧库写 established；缺失库无 permit → `recovery_required`，不创建新库；全局通知只在 `resume()` 显式兑现 | `import-scope-evidence.test.ts` 9/9；`import-restart-receipt-recovery.test.ts` 14/14；`import-worker-reuse.test.ts` |
| 13 | 复审 T11(c) | `apps/api/src/direct-sync-ingest.ts`、`packages/storage-sqlite/src/database.ts` | 事务内 `RouteOwnershipChange` 观察器：实际 UPDATE 捕获旧/新归属；T11 脏证据不再依赖 GPX 文件清单；同批矛盾归属拒收 | `phase3-import-matrix.test.ts` 15/15；`P3-06 T11` |
| 14 | 复审 D1 | `packages/application/src/services/recompute-pipeline.ts` | `remapResumedCheckpointState()` 按 `trainingSessionId` 重映射父 checkpoint 的校准集合与 pending negative ids；复制 checkpoint 写重映射 state/hash；校验失败安全全量 | `training-metric-domain-reuse.test.ts` 连续两轮/损坏 cohort |
| 15 | 复审 D1 | `packages/application/test/business-artifact-projection.ts`、两个差分测试 | 删除 `replaceDerivedHashes`；raw epoch/cohort 直接比较；新增 4 条篡改负对照 + T11 A/B 场景 | G4 42/42 |
| 16 | P1 复审 | `apps/api/test/import-scope-evidence.test.ts`、`apps/api/test/import-restart-receipt-recovery.test.ts` | 新增旧库升级/首次登记前缺失/启动后消失/账本损坏/真正首次安装/写失败/epoch 九类路径；A/B 双任务故障保持通过 | G7 23/23 |
| 17 | T12 复审（第二轮） | `apps/api/test/phase3-t12-real-lane.test.ts`、`packages/application/test/training-metric-domain-reuse.test.ts`、`apps/api/src/direct-sync-ingest.ts`、`packages/health-export-parser/src/canonicalize-nights.ts` | T12 改为真实到达 52 天 + A 原任务真实消费：注入单一到达时钟（canonical `computed_at`/批次完成/任务 `evaluatedAt`/`import_completed_at` 同源）；A 领取原 `analysisJobId` 并核对 binding/coverage/发布；B 为“生产导入修订批次 + 生产取消接口取消原任务 + 测试 `enqueueControlledFull()` 受控全量分析”的对照；到达时间与 active 指针负对照 | G10 1/1（14.3 s）；G4 42/42 |
| 20 | P2 删库恢复复审 | `apps/api/src/dataset-epoch.ts`、`apps/api/src/deletion-recovery.ts`、`apps/api/src/runtime-state.ts`、`apps/api/src/maintenance.ts`、`apps/api/src/server.ts`、`apps/api/src/import-worker.ts`、`apps/api/src/import-scope-cli.ts`、`apps/api/src/fault-injection.ts` | 持久删库操作日志（`prepared→main_removed→permit_issued→writer_entered`，绑定保护快照与 runtime 实例）；启动分阶段裁决；幂等许可；CLI 只读检查 + fresh-install + deletion-id 恢复；写者进入顺序；确定性故障点 | `dataset-deletion-recovery.test.ts` 19/19（G11）；`import-scope-evidence.test.ts` 9/9；`maintenance.test.ts`/`restore-journal.test.ts` 回归 |
| 18 | F01 复审 | `apps/api/test/direct-sync-http-acceptance.test.ts`、`apps/api/test/fixtures/pre-commit-barrier.mjs` | 新增“真实删除 + GPX”批次：回执 INSERT 触发器在同一事务连接内证明待删 UUID 已不可见、路线版本/3 点/墓碑已写入，再 SIGKILL；15 张表逐字节回滚，重启同 job 恰好一次 | G5 36/36 |
| 19 | 发布投影复审 | `packages/application/test/business-artifact-projection.ts`、`phase3-business-artifact-differential.test.ts` | 新增 `training_sessions` 全业务列、`model_release_bundles`（normalized evaluation/snapshot domains/激活事实）、`release_readable_state`（active 指针/可读域/freshness）；3 条负对照 | G4 42/42；`equivalence-summary.json` |
| 6 | P3-04 T05 | `packages/health-export-parser/src/dirty-range.ts` | 未知记录类型（既非评分、也非 data-only 白名单）强制 `full` + `unknown_record_type`，未知+已知混合不得借用边界 | `dirty-range.test.ts` 3 条新增；`phase3-import-matrix.test.ts` T05 |
| 7 | P3-04 T11(a) | `apps/api/src/direct-sync-ingest.ts` | `canonicalizeRunningWorkouts` 只收 `parsed.dirtyWorkoutTimes`；routeDirtyTimes 仅用于分析脏范围，避免净零 workout 写触发写守卫 | `phase3-import-matrix.test.ts` T11(a) |
| 8 | P3-04 T11(b) | `apps/api/src/direct-sync-ingest.ts`、`packages/health-export-parser/src/gpx-parser.ts` | 初版：按本批 GPX 路径快照旧归属并强制 `forceChangedRouteIds`。复审发现“仅 XML 改归属、不附 GPX”会漏脏，已由 #13 的事务内观察器取代 | `phase3-import-matrix.test.ts` T11(b)（保留回归） |
| 9 | P3-04 T11(b) | `packages/storage-sqlite/src/database.ts` | `preserveAbsent` 下显式引用路径与旧行冲突时，复用旧 route id 改归新训练，保留点/指纹/已发布版本（不再静默跳过） | `database-import.test.ts` 更新契约 + `phase3-import-matrix.test.ts` T11(b) |
| 10 | P3-03/P3-04 测试 | `apps/api/test/import-restart-receipt-recovery.test.ts`、`import-receipt-fields.test.ts`、`phase3-import-matrix.test.ts`、`phase3-analysis-publication.test.ts` | 新增故障/边界/幂等/发布测试 | 见 `TEST_MATRIX.md` |
| 11 | P3-05/P3-06 | `packages/application/test/business-artifact-projection.ts`、`training-metric-domain-reuse.test.ts`、`phase3-business-artifact-differential.test.ts` | 完整业务投影 + 严格比较器 + 负对照 + T13/direct binding 场景 | `evidence/equivalence-summary.json` |
| 12 | P3-01/P3-08 | `deliverables/phase3-import-analysis-2026-10-22/*` | 状态合同、依赖矩阵、测试矩阵、证据、本报告 | 本目录 |

**没有修改：** v47 schema、迁移校验和、iOS 源码/工程、API 公开路由、写者数量、数据库数量、发布锁/租约/准入调度器。没有恢复 Web/macOS 或候选整库换库链路。

**新增模块：** `apps/api/src/deletion-recovery.ts`（删库启动裁决）、`apps/api/src/fault-injection.ts`（仅测试环境变量触发的确定性故障屏障）；`dataset-epoch.ts` 扩展 `dataset_deletion` 日志；`runtime-state.ts` 增加稳定实例标识与 `establishDeletionPermit`；`maintenance.ts` 的 `deleteDatabase` 增加保护快照回调与目录 fsync 后的 `afterRemoval`；`direct-sync-ingest.ts`/`canonicalize-nights.ts` 增加可审计的到达时钟注入（生产默认真实时钟）。

## 3. 审查结论与偏差

### 3.1 R1：no-op 回执缺 `analysisJobId`

- 确认：`writeNoopReceiptTask` 原先无该键；data-only/direct-sync 无分析时写 `null`。
- 修复：仅新 no-op 回执写显式 `null`；历史回执不批量回填。
- 验证：no-op 第二次导入的持久回执 `Object.hasOwn(...,"analysisJobId")===true` 且值为 `null`；同内容重放/重启恢复不改变原字节语义。

### 3.2 R2：`dependencyGeneration` 语义

- 确认：合同 `packages/contracts/src/direct-sync.ts` 明确“本批不影响分析时为 `null`”；direct-sync 原先无条件写全局代次。
- 修复：`analysisRequired ? String(generations.dependency) : null`。`import_generations` / `import_batches` 的真实代次不变。
- 验证：record-only 回执 `null`；queued 回执等于 `recompute_jobs.target_dependency_generation` 与 `import_generations.dependency_generation`；旧回执（缺键或 `"7"`）原样读取并重放。

### 3.3 R3：重启恢复把“读不到/库缺失”当“没有”

- 复现：构造“已提交 + 持久状态 running + 数据库暂时缺失/不可读 + cancelRequested/attempts=3”的作业；旧 `loadJobs()` 会错误发布 cancelled/failed。
- 修复：`readImportReceiptForRecovery()` 返回 `found / confirmed_absent / missing / unreadable`。只有 `confirmed_absent`（查询成功且没有该 job 回执行）走原取消/重试政策；`missing` 仅当作业满足“入队时主库不存在（`databaseAbsentAtEnqueue=true`）+ 仍 queued + attempts=0 + 作用域账本仍为 `pristine` 且 `firstEmptyEpoch` 匹配”时才按首次空库处理；其余 missing/unreadable 保持 queued/running、`phase=recovery_required`、`recoveryBlocked=true`，不 finalize、不清理来源、不发终态。
- 首次空库：缺失库不再由读取函数擅自确认；入队只读取受控 `pristine` 许可，绝不创建；执行前写 `writerEnteredAt`，建库/观察旧库写 `datasetEstablishedAt`；旧作业或账本已被写者进入/数据集建立/显式撤销时，缺失一律按无法核实阻断（详见 §3.7）。
- 启动时序：构造器只登记 pending 通知，全局 `onRecoveryRequired` 只在启动依赖声明完成后的 `resume()` 显式兑现一次；不再靠捕获 `ReferenceError` 判断是否过早。
- publication journal：已提交 intent 遇到主库暂时缺失时不再误报“回执丢失”并中止启动；保留 intent，等可读后按原回执收敛。
- 验证：`import-restart-receipt-recovery.test.ts` 14/14；`import-publication.test.ts` 16/16（含 journal 结构化恢复用例）。

### 3.4 T14：direct-sync XML 记录条数（方案前提与真实合同冲突）

- 方案 §4.3/T14 假设 “direct-sync Record ≤ 5000”。
- 真实合同（`packages/api-contracts/src/index.ts:223-229`、`docs/IOS_NATIVE_API_CONTRACT.md:66`）明确：`directSyncBounds.maxRecords` **只约束删除配额**，不约束 XML `<Record>` 条数；`apps/ios/RAI/DirectSyncBatchBudget.swift:79` 允许 12,000 条。
- 处理：**不收紧**。实施中曾短暂加入 `records_exceed_bounds` 校验，核对合同后已回退；测试改为断言 5001 条 XML 记录在 8 MiB 内合法接收，删除配额仍按 5000 严格 `>` 判定；既有 9000 条 2–8 MiB 用例恢复并通过。
- 判定：属于**方案文字与现行产品合同的冲突**，不是代码缺陷。若未来要收紧，必须作为独立产品决策并同步 iOS 预算/合同，不在阶段 3 顺手修改。

### 3.5 D1：派生 `baselineEpochId` / `calibrationCohortHash`（已修复）

P3-06 差分最初发现：同一事实、同一父发布下，增量 run 与从头全量 run 的 **raw** `baselineEpochId` / `calibrationCohortHash` 不同（增量把父 run 的 `calibrationFeatureIds` 与当前 run 的 feature id 求交，得到空集；全量得到 15 场校准训练）。

- **根因：** `resumeModelReplay()` 把父 checkpoint 的 baseline 原样带回，而 checkpoint 保存的是父 run 的 run-scoped feature id；`copyFeaturePrefix` 给复用行生成当前 run 的新 id，交集为空。
- **修复：** `remapResumedCheckpointState()` 按稳定 `trainingSessionId` 把父 checkpoint 的 `calibrationFeatureIds`（及 `pendingNegativeIds`）映射到当前 feature run；校验数量、唯一性、可解析性、校准区间、dimensions、顺序和 `throughSequence` 边界。复制 checkpoint 时写入重映射后的 `state_json` 与 `state_hash`；后续 checkpoint 同为当前 run id。任一失败 ⇒ 拒绝复用并安全全量，旧 checkpoint 仍可读、不批量改写历史。
- **比较口径：** 已删除 `replaceDerivedHashes` 语义替换；lineage、daily snapshot、assessment explanation、五域封存 payload 中的 raw epoch/cohort 全部直接比较，`lineage_hash` 仍逐 run 自证。新增 4 条负对照证明篡改任一 raw hash 会让比较器失败。
- **验证：** 连续两轮增量 epoch/cohort 稳定，每轮 checkpoint 的 `calibrationFeatureIds` 全部属于当前 feature run；损坏父 cohort（重复 id）被拒绝复用且全量结果正确；T11 A/B 场景 raw epoch/cohort 逐字段相等。

### 3.6 T11(c)：仅 XML 改归属、本批未附 GPX

- **原缺陷：** 旧归属快照只枚举本批 GPX 文件路径；`WorkoutRoute` 显式引用可以把已有路线从 A 改挂到 B，而增量包省略未变化 GPX 时，A 不会进入 `routeDirtyTimes`。
- **修复：** `RaiDatabase.observeRouteOwnershipChanges()` 在 `insertWorkout` 实际执行归属 UPDATE 时发出 `RouteOwnershipChange`（旧/新 workoutId + startAt）；`direct-sync-ingest` 在解析段收集事件，合并 GPX 内容变更与归属变更到 `changedRouteIds` / `routeDirtyTimes`。同批同一路线第二次归属变更确定性拒收，整批回滚。
- **验证：** `phase3-import-matrix.test.ts` 的“仅 XML 改归属、未附 GPX”用例（旧 A/新 B 均脏、路线点 3 个与已发布版本保留）；`P3-06 T11` 真实增量 A/全量 B 完整业务投影（loads 39/2、zones 39/4、daily 39/4、features 39/2、assessments 32），A 的 `routePointCount=0`、B=3。

### 3.7 P1：首次空库许可缺少历史数据集证据（复审三次加固）

- **原缺陷：** 旧实现只要 `import_scope_evidence` 没有 scope 行，就在入队时插入 `first_empty_epoch=1`。这无法区分“真正首次安装”和“旧库/旧账本暂时缺失、损坏隔离、或迁移后无行”，会把未知当成“从未建库”。
- **修复：**
  1. 状态机 `unknown → pristine → writer_entered → established`；无行 = unknown，unknown **永不**自动变 pristine。
  2. 启动时在 ImportWorker 构造/`loadJobs()`/`resume()` 之前登记：可读旧库 → established；存在但不可读 → unknown（撤销许可）；缺失 → 保持 unknown/pristine 现状。
  3. 真正首次安装只能由受控 `npm run data:init-scope` 写入一次 pristine；显式删除成功并切换 epoch 后只对新 scope 写 pristine；恢复旧库登记 established；旧 scope 不复活。
  4. 入队只**读取**许可；执行前 `markScopeWriterEntered()` 失败即 `recovery_required`，不写主库、不发布终态、不清理来源；建库/观察旧库/恢复完成写 established。旧版自动空行在迁移时降为 unknown。
- **验证：** `import-scope-evidence.test.ts` 9/9 覆盖旧库升级（含旧表迁移）、首次登记前缺失、启动后消失、账本损坏隔离、真正首次安装（v47 建库 + 第二包）、账本写失败、显式删除/恢复；`import-restart-receipt-recovery.test.ts` 14/14 保留 A/B 双任务故障。所有未知/缺库路径均断言主库路径无新建、来源保留、无第二写者。

### 3.8 P2：删库提交与首空许可跨两个持久状态

- **原缺陷：** `DELETE /v1/database` 先把新 epoch 写进 dataset-epoch 侧车，再由 `DatabaseMaintenance.deleteDatabase()` 删除主库，返回后才写 `pristine` 许可。两步跨侧车、文件删除和 runtime 账本；SIGKILL 落在“主库已删、许可未写”时，重启后的 `readDatasetEpoch()` 会读出新 epoch，但 `data:init-scope` 仍用环境变量 `RAI_DATASET_EPOCH` 构造旧 scope，既可能拒绝，也可能给旧 scope 写无用许可。
- **修复：**
  1. 侧车新增 `dataset_deletion` 操作日志：`deletionId`、configured/previous/next epoch、保护快照名与类型、runtime 账本实例标识、单调阶段 `prepared→main_removed→permit_issued→writer_entered`；`prepared` 与 next epoch 在同一 SQLite 事务写入。
  2. `main_removed` 只在主库/WAL/SHM 移除且目录 fsync 成功后写入；SIGKILL 不执行 catch/finally，启动裁决按阶段处理，绝不把“文件缺失”补成 `main_removed`。
  3. 新增 `deletion-recovery.ts`：`prepared+主库仍在` 回滚旧 epoch；`prepared+主库缺失` 阻断并要求运维恢复快照或 `--confirm-main-removed`；`main_removed` 幂等补发同一 `deletionId` 的 `nextEpoch` 许可；`permit_issued` 只消费已有许可；`writer_entered` 后主库消失/账本隔离重建都不建新库。
  4. `RuntimeStateStore` 增加稳定 `runtimeInstanceId` 与 `establishDeletionPermit(scope, deletionId)`；首次写者顺序固定为 runtime 账本 `writer_entered` → 侧车 `writer_entered` → 主库。
  5. `data:init-scope` 改为默认只读检查；`--apply --fresh-install` 仅用于无主库/无删库记录/无历史证据；`--apply --deletion-id <id>` 复用记录且 `prepared` 阶段必须 `--confirm-main-removed`。CLI 与 API 共用 `readDatasetEpochState()`，不再各写一套 epoch 选择规则。
- **验证：** `dataset-deletion-recovery.test.ts` 19/19（G11，最终日志）：真实 API 子进程 + 真实 `DatabaseMaintenance` + 真实侧车/runtime/main SQLite；`RAI_FAULT_POINT` 确定性屏障 SIGKILL 后原目录重启，测试不手工修补状态。覆盖首次安装、prepared 前/后、prepared+缺失、main_removed、permit_issued、writer_entered+账本损坏、侧车损坏/配置不匹配/快照缺失/账本实例不符/写失败、删除中途普通异常的保护快照回滚、恢复旧备份；所有“旧库暂时缺失/账本隔离重建”序列均未创建新主库。

## 4. 测试与证据

### 4.1 目标套件（实施后）

| 组 | 内容 | 结果 |
|---|---|---|
| G1 | data-only / direct-sync ingest / analysis-reconcile / preflight 等 | 82 tests / 82 pass / 0 fail（见 `TEST_MATRIX.md` G1） |
| G2 | dirty-range / analysis-input / VO2 / task recovery / migration / release | 92 tests / 92 pass / 0 fail |
| G3 | analysis-job-merge / failure isolation / import-publication / recompute-worker / epoch / coverage | **42 tests / 42 pass / 0 fail / 17.3 s**（最终独立日志；并发 1；不再声称 38/38） |
| G4 | `training-metric-domain-reuse.test.ts` + `phase3-business-artifact-differential.test.ts` | **42 tests / 42 pass / 0 fail / 73.9 s** |
| G5 | direct-sync HTTP acceptance + import worker reuse | **36 tests / 36 pass / 0 fail**（HTTP 12 含 F01 删除+GPX 确定性屏障 + worker 24） |
| G6 | phase3 import matrix + analysis publication | **16 tests / 16 pass / 0 fail**（matrix 15 + publication 1） |
| G7 | restart receipt recovery + scope evidence | **23 tests / 23 pass / 0 fail**（restart 14 + scope 9） |
| G8 | receipt fields | 4 tests / 4 pass / 0 fail |
| G9 | canonical nights window | 20 tests / 20 pass / 0 fail |
| G10 | `phase3-t12-real-lane.test.ts`（真实到达→原任务 partial 消费→发布 A/B） | **1 test / 1 pass / 0 fail / 14.3 s** |
| G11 | `dataset-deletion-recovery.test.ts`（删库四阶段强杀/CLI/恢复） | **19 tests / 19 pass / 0 fail**（最终日志；含 2026-10-23 新增 P1-2/P1-4/P1-5/P2-5） |

复审后另单独运行：`direct-sync-ingest + database-import` 26/26、`direct-sync-http + import-worker-reuse` 36/36、`restart-recovery + scope-evidence` 23/23、`phase3-t12-real-lane` 1/1、`import-publication` 16/16；其余由最终完整套件覆盖。

### 4.2 完整测试与门禁

- **完整套件（含全部测试文件）：** `RAI_TEST_CONCURRENCY=2 npm test`（Node v22.23.2 / npm 10.9.8，`--test-concurrency=2`）→ **2419 tests / 2406 pass / 0 fail / 0 cancelled / 13 skipped / 626.4 s，exit 0**。完整日志：`evidence/full-suite-final-2026-10-23.log`；命令与退出码：`evidence/manifest.json`。该次运行同时通过 `node-version.test.ts`（npm 生命周期）与 `prediction-inference.test.ts`（`onnxruntime-node` 可加载并执行）。
- **门禁：** `typecheck`（pure + full）、`check:package-boundaries`、`check:training-plan-single-writer`、`check:scripts`、`check:acceptance-matrix`、`check:docs`、`check:doc-refs`、`smoke:api` 全部 exit 0；`check:ios-gates` 的 11 支跨平台判据通过（2 支需 Simulator/mutation 的按设计跳过；本阶段未改 iOS）。日志：`evidence/gates-final-4.log`。
- 逐条命令、并发、退出码与日志路径见 `evidence/manifest.json`；本轮最终完整套件为 `evidence/full-suite-final-2026-10-23.log`。

### 4.3 未执行

- 未做生产导入、全量重算、压测、故障注入生产、VACUUM、迁移或部署。
- 未做 iOS Simulator/真机验收；未运行 `test:ios`（本阶段未改 iOS）。
- 未做生产级性能/RSS/P99 测量；只记录测试运行时长与等价性套件中的复用/行数计数，不声称容量或延迟改善。

## 5. 阶段验收清单（对照方案 §10）

| 条件 | 结论 | 证据 |
|---|---|---|
| 双车道真实调用顺序保持，no-op 独立条件明确，refusal 终态和输入上限不变 | ✅ | `STATE_CONTRACT.md` §2；G1/G5；T14 合同更正 |
| 三个新回执生产者字段语义一致；旧回执兼容且不可变 | ✅ | R1/R2；`import-receipt-fields.test.ts` 4/4 |
| queued 对应事务内已持久任务及正确关联；not_required 不登记本批任务 | ✅ | `direct-sync-analysis-reconcile.test.ts`；T04 |
| 提交前失败整批回滚；提交后丢回复按持久事实恢复；无法核实不猜测终态 | ✅ 删除+GPX 同一未提交事务的确定性屏障、SIGKILL 后 15 表逐字节回滚、同 job 恰好一次；F02/F03/F04 均有真实证据 | F01/F02/F03/F04；G5/G7；`TEST_MATRIX.md` §3 |
| 重启恢复覆盖数据库缺失/不可读、取消和重试耗尽；P1/R3 有复现/排除证据 | ✅ | G7 23/23（restart 14：missing + unreadable + cancel + attempts=3 + 已提交+缺失库恢复 + 作用域首空 A/B；scope 9：旧库升级/首次登记前缺失/启动后消失/账本损坏/首次安装/写失败/epoch） |
| 新增、重复、修订、删除、未知类型、GPX、恢复、epoch/scope 用例完成 | ✅ T11 三类变体、T12 真实车道 A/B、F01 删除+GPX 确定性屏障、P1 scope 九路径全部完成 | G1/G2/G4/G5/G6/G7/G10；`TEST_MATRIX.md` 80/80 acceptance rows cited（`check:acceptance-matrix`） |
| 每个域的输入、失效、回看窗口、复用证明和全量条件有符号与测试对应 | ✅ | `DEPENDENCY_MATRIX.md` |
| 声明增量的场景真实复用，完整业务产物与同条件全量计算等价 | ✅（raw epoch/cohort 直接比较；T11 A/B 39/2、39/4、39/4、39/2、32；T12 真实车道 readiness/Fitness/15 表投影等价，精确 reused=4） | G4 42/42；G10 1/1；`evidence/equivalence-summary.json` |
| 未知边界、失效 checkpoint、coverage gap、输入漂移保留安全全量/拒绝发布 | ✅ | G2/G4；T05/T13/F07/F12 |
| task 唤醒、合并、重排、失败、取消、重启可收敛；旧 receipt 的 task 不失联 | ✅ | G3；F05/F08/F09/F10 |
| 原始接收不写派生/发布表；分析失败不撤销已提交事实或伪造发布成功 | ✅ | `direct-sync-prohibited-operations.test.ts`；`analysis-failure-isolation.test.ts` |
| 发布输入绑定、bundle、active 指针和可读状态一致，无重复可见发布 | ✅ `model_release_bundles` + `evaluation_json` + `release_readable_state`（active run/release 指针、可读域、freshness）进入全部 A/B 场景，并断言 active 指针指向已激活 bundle | G4 42/42；F10；direct binding 场景；`DEPENDENCY_MATRIX.md` §4 |
| 适用 typecheck、测试、合同和静态门禁通过；退出码、并发及未执行项齐全 | ✅ 完整 `npm test` exit 0（Node 22.23.2 + npm 10.9.8；ONNX 可加载）；typecheck/静态门禁 exit 0 | `evidence/manifest.json`；`evidence/full-suite-final-2026-10-23.log` |
| 没有新增客户端、数据库、写者、无界队列，或削弱现有保护机制 | ✅ | diff 范围；未改 schema/iOS |
| 兼容、发布与回滚限制写清楚；未做生产操作，阶段 4 未开始 | ✅ | 本报告 §6/§7 |
| **阶段 3 总体验收结论** | **✅ 本地可复核范围内通过（目标 macOS 主机，未部署生产；人工演练项见 §1.2）**：P1 作用域状态机/旧库缺失/账本隔离、T11/D1/R3、T12 真实车道 A/B、F01 删除+GPX 确定性屏障、发布全投影与完整 `npm test` 均有本次证据；`TEST_MATRIX.md` 80/80 acceptance rows cited（`check:acceptance-matrix`） | 本报告 §4/§5；`TEST_MATRIX.md`；`DEPENDENCY_MATRIX.md` |

### 5.1 复审三项验收对账（2026-10-22 最终执行）

| 复审项 | 方案验收条件 | 最终结果 | 证据 |
|---|---|---|---|
| **P1** 首次空库许可缺少历史数据集证据 | 旧库缺失、账本丢失、A/B 排队、真正首次安装四类路径全部通过；任何未知状态都不自动创建主库 | ✅ 通过 | `import-scope-evidence.test.ts` 9/9（旧库升级/首次登记前缺失/启动后消失/账本损坏/首次安装/写失败/epoch）；`import-restart-receipt-recovery.test.ts` 14/14（A/B 双任务：B 阻断、不建库、来源保留、恢复后只提交一次） |
| **P2（F01）** 删除与 GPX 的提交前强杀证明 | 杀前屏障证明删除与 GPX 都已写入同一未提交事务；SIGKILL 后全回滚；重启同 job 恰好一次 | ✅ 通过 | `direct-sync-http-acceptance.test.ts` A05/F01：回执 INSERT 触发器+同连接断言+IPC 暂停；15 表逐字节等于批次前；重启后 13 记录/1 Workout/1 路线版本/3 点/1 指纹/2 批次/2 回执；重放零变化 |
| **P3** T12 从实际导入到 readiness 发布 A/B | 真实到达的 XML 修订产生两个不相邻脏时期；中间 canonical/readiness 不变；A 的**原登记任务**实际被消费并发布，有 `reused>0` 持久证据；readiness 变化且 A=B；Fitness 不被污染 | ✅ 通过 | `phase3-t12-real-lane.test.ts` 1/1：52 天真实到达导入→局部夜重建（仅 4 个 wake date 变化）→A 原 `analysisJobId` 领取/运行（无 DELETE/复制计划）→input binding+coverage→发布；B 为“生产导入修订批次＋生产取消接口取消原任务＋测试 `enqueueControlledFull()` 受控全量分析”的对照（非生产全量主路径）；15 表投影零差分；`reuse.proof=verified`，loads/zones/daily 精确 `reused=4`（固定夹具/时钟的确定性值）；到达时间/active 指针负对照失败；进程级 SIGKILL 未覆盖，本层为进程内故障注入 |
| **P2（删库恢复）** 删库任意中断可恢复 | prepared/main_removed/permit_issued/writer_entered 各断点重启都不错误建库；只按记录补发一次 nextEpoch 许可；账本损坏/身份不符/侧车损坏/快照缺失/写失败全部失败关闭；CLI 与 API 使用同一生效 epoch | ✅ 通过 | `dataset-deletion-recovery.test.ts` 19/19（G11，最终日志）：真实子进程+SIGKILL+原目录重启；prepared+主库存在回滚且字节不变；prepared+缺失阻断并需 `--confirm-main-removed`；main_removed 幂等补发；permit_issued 不产生第二张许可；writer_entered+账本隔离重建不建新库；恢复旧备份收口意图 |
| 统一回归/门禁 | 至少 typecheck、G1/G4/G5/G7、完整 `npm test`、acceptance matrix；退出码 0 且证据一致 | ✅ 通过 | 完整 `npm test` **2419 tests / 2406 pass / 0 fail / 0 cancelled / 13 skipped，exit 0**（`evidence/full-suite-final-2026-10-23.log`）；本轮门禁 `evidence/typecheck-final-2026-10-23.log`、`evidence/acceptance-final-2026-10-23.log`、`evidence/docs-final-2026-10-23.log`、`evidence/doc-refs-final-2026-10-23.log`、`evidence/smoke-api-final-2026-10-23.log`；逐条命令/并发/退出码见 `evidence/manifest.json` |

## 6. 性能与开销（有限观测，不声称容量）

- 等价性套件（40 天合成历史、15 张表/投影）单场景约 4–10 s；T12 真实车道的 52 天双库场景约 14.3 s；G4 整组 42 tests / 73.9 s；G11 删库故障注入 19 tests / 109.1 s（测试机负载下）。
- 复用计数（见 `evidence/equivalence-summary.json`）：新 workout 场景 loads 40/1、zones 41/2、daily 41/2、features 40/1、assessments 40；VO2-only 39/1、39/4、39/4、39/1、32；direct binding 40/1、41/2、41/2、40/1、40；T11 仅 XML 改归属 39/2、39/4、39/4、39/2、32。
- 拒绝复用场景（删除/override/config/checkpoint 篡改/缺证据父 run/链尾漂移）均为 `reused=0` 且完整产物仍等价。
- **未测**：生产接收事务 P50/P95、分析各阶段耗时、RSS、排队至发布时间、冷/热对比。阶段 3 不以性能为验收目标。

## 7. 兼容与回滚

- **schema：** 未新增版本，仍为 v47；未修改历史迁移校验和。
- **回执：** 修改只作用于新写入；历史回执缺键或旧 `dependencyGeneration` 值继续可读、可重放；不批量回填。
- **runtime state：** `import_scope_evidence` 表（`var/runtime.sqlite`，不是主库 v47 schema）升级为 `unknown/pristine/writer_entered/established` 状态机；旧表迁移不会补写 pristine，旧版自动空行降为 unknown。旧代码忽略它，回滚无需删除，但重新启用新代码前不要手工改写状态/许可。
- **首次空库作用域：** 账本按现有 `scope = [serverId, athleteId, datasetEpoch]` 隔离；真正首次安装必须在主库不存在时显式运行 `npm run data:init-scope`（写入一次 pristine），导入 worker 只消费、不创建许可。显式删除会切换 dataset epoch 并只为新 scope 建立 pristine；恢复旧库登记 established。不要通过删除主库并复用同一 scope 来“重建数据集”——那会按设计进入 `recovery_required`，应走显式的数据恢复/epoch 变更流程。
- **代码回滚：** 回滚目标应为本阶段实施前的兼容版本（HEAD `16a1229` 或本阶段提交前版本），不能回退到阶段 2 之前的 v46 二进制（v47 库会被旧代码拒绝启动）。
- **已提交事实：** 代码回滚不会撤销已提交事实；分析修复应走既有合法重算/发布流程，不手改 active 指针。
- **T11 行为变化：** `preserveAbsent` 下显式引用路径现在会改归新训练（复用旧 route 行、保留点/指纹/版本）；归属变化的脏证据来自事务内实际 UPDATE，不再依赖 GPX 文件清单。这是契约修正，回滚时需同时回滚该行为及测试。
- **增量域：** 任一域若不能证明正确，保留全量兜底；本阶段没有新增持久格式或任务类型。

## 8. 未决风险与后续

1. **D1 派生 epoch/cohort hash（已修复）**：checkpoint 恢复时按训练 session 重映射校准集合，raw 值增量/全量一致；旧 pre-fix checkpoint 会被安全拒绝复用并退回全量，因此升级后首次增量可能重算全部 assessment（预期取舍）。
2. **T12 原任务主路径（已验收）**：真实到达 52 天 v2 XML→局部夜重建→批次脏证据→A 原 `analysisJobId` 领取/绑定复核/partial 发布；B 为“生产导入修订批次 + 生产取消接口取消原任务 + 测试 `enqueueControlledFull()` 受控全量分析”的对照；readiness 业务值变化且 A=B、Fitness 不变、中间期不变、15 表投影零差分；readiness 自身仍是整域全量，不宣称其有增量复用。
3. **F01 删除+GPX 确定性屏障（已验收）**：同一未提交事务内删除/GPX 均已写入，SIGKILL 后 15 表逐字节回滚，同 job 恰好重试一次。
4. **发布 bundle/active 指针（已验收）**：`model_release_bundles`、`evaluation_json`、`active_model_run/active_model_release`、可读域与 freshness 已进入全部 A/B 场景。
5. **完整测试门禁（已通过）**：目标 macOS 主机用 Node 22.23.2 + npm 10.9.8 跑完整 `npm test`，exit 0；`onnxruntime-node` 可加载。若换回无 npm / ONNX 不可加载的宿主，仍需重新记录环境限制。
6. **性能**未测，不能给出容量/延迟结论。

## 9. 阶段停止声明

阶段 3 的代码、测试与证据已完成到本报告所述范围；**未部署生产、未执行生产导入/重算、未进入阶段 4**。后续如需发布，应按项目既有发布流程单独评审，并以 `evidence/manifest.json` 的最终命令/退出码为准。

## 10. 最新复审四项恢复缺口（2026-10-22）

| 问题 | 修复与安全边界 | 验收 |
|---|---|---|
| `prepared` 日志与可读主库 epoch 冲突仍可能服务旧/新 scope | 启动裁决显式标记 `recovery_required`；API 业务读写与后台 worker 阻断，仅保留诊断和显式备份恢复入口；恢复成功后登记恢复 epoch | P2-9：健康状态为需恢复，业务读写 409，恢复入口成功 |
| `permit_issued` 丢失 runtime 许可行时 CLI 重签 | CLI 该阶段只校验原许可仍为 pristine、未消费且绑定原 `deletionId`；缺失或冲突均退出非零；账本迁移不得把当前 unknown 重新提升为 established | P2-10 与作用域证据回归：CLI 和 API 均不发第二张许可 |
| `writer_entered` 后备份恢复留下旧删除意图 | 显式恢复以 `superseded` 收口已消费意图，在侧车持久最终恢复 epoch；恢复 scope 为 established；收口失败继续阻断业务 | P2-11：恢复后重启采用最终 epoch；主库后来缺失也不回退到删除 `nextEpoch` |
| 保护快照只检查文件存在 | v2 删除记录绑定主文件及隔离 WAL/SHM 的大小与 SHA-256；删库前 fsync 并核对可恢复备份的 SQLite 完整性；补发许可前逐字节复核，旧 v1 隔离快照保守阻断 | P2-12：文件仍在但单字节损坏时，启动与 CLI 均拒绝补发 |

**附带回归：** WAL 未 checkpoint 时浅层文件大小探针可误判可读主库；启动裁决在浅层检查失败后使用 SQLite 完整性检查。`server-runtime.test.ts` 的删除后重建与重启两个用例均通过。完整套件首次运行揭示 `RecomputeWorker.close()` 对空闲 `unref` 常驻线程的终止等待可能在事件循环退出时被取消；关闭前临时 `ref` 线程后，原组合用例单独复跑通过。删除加 GPX 的验收辅助函数在后台重算占用 SQLite 时可能立即收到 `database is locked`，现为其只读连接设置 `busy_timeout=5000`，原故障注入用例单独复跑通过。快照验收也加强为等长单字节篡改，确认 SHA-256 而非文件大小在阻断恢复。组合 G12 为 **100 tests / 99 pass / 0 fail / 1 skipped**（`evidence/g12-recovery-review-fixes.log`）；`npm run typecheck`、`npm run check:acceptance-matrix`、`npm run check:docs`、`npm run smoke:api` 在最终完整套件前已退出 0。完整套件以 `evidence/manifest.json` 的最新记录为准。
