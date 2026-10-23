# 阶段 3 复审问题：逐项修复实施方案

- 日期：2026-10-23（Asia/Shanghai）
- 基线：HEAD `16a1229` 及其上 41 个未提交路径
- 性质：实施设计与验收清单；本文不表示修复已经完成
- 范围：`apps/api`、`packages/*` 及其测试和阶段 3 交付证据。客户端仍只有原生 iOS；不增加浏览器、桌面或其他移动客户端。
- 复核依据：用户提供的审查报告、当前源码、`HEAD` 的旧 epoch 实现和现有日志。编写本文档未修改生产代码，未重新运行会写测试数据库的套件。

## 0. 判定边界与共同约束

报告中的 P1-1～P1-7、P1-9 和大部分 P2 项都有直接代码依据。P1-8 的“历史损坏证据未检查”成立，但“读账本失败一律被吞成空账本”的描述不准确：`readEvidenceReadOnly()` 只吞打开异常，查询异常会抛出。`routesUpdated` 已有 T11 专门断言；F10 与 T12 的问题主要是验收声称超过测试实际路径。P3 中冗余参数、observer 清理和同阶段 replay 的显式提交是维护改进，不应写成已发生的功能故障。

所有工作包必须保持以下不变量：

1. 主库文件缺失、存在或暂时不可读，都不能单独证明“首次安装”“删库完成”或“回执未提交”。
2. `serverId + athleteId + 生效 epoch` 定义唯一数据作用域。旧作用域的许可、缓存、任务和回执不得在新作用域重新成为有效证据。
3. `pristine` 许可只能由受控初始化或已核实的显式删除签发一次；写者进入后不复活。无法裁决时保留日志、来源和原始字节，明确阻断业务写入。
4. 恢复阻断期间，API 必须能启动诊断与显式恢复入口；后台任务不得访问主库。数据集恢复后，主库 epoch、侧车、runtime scope 与队列结论必须同源。
5. 修复测试必须验证最终业务产物和持久状态；单纯断言函数返回值或日志文案不足以证明恢复协议。

## 1. P1：数据隔离、增量正确性与恢复入口

### P1-1 旧删除 epoch 被 `readDatasetEpochState()` 忽略

**修改位置：**`apps/api/src/dataset-epoch.ts` 的 `readDatasetEpochState()`；`apps/api/test/dataset-epoch.test.ts`；`apps/api/test/dataset-deletion-recovery.test.ts`。

**实施方法：**

1. 主库可读且 `rai.dataset-epoch` 行存在时仍以主库为准。行不存在、删除日志也不存在时，若旧侧车的 `dataset_epoch` 行存在，则用严格配置身份校验读取该 epoch；只有侧车本身确实不存在才回退 `configuredEpoch`。侧车存在但无法读取、配置不匹配或内容无效时明确阻断，不允许静默回退。
2. 删除日志存在时保留现有分阶段裁决，不把旧侧车值覆盖到未完成删除的 `nextEpoch` 上。把“主库无行”与“主库不可读”分成不同分支，以免锁/权限错误被当成旧格式。
3. 在主库完成迁移且确认该 epoch 后，以单独、可重放的事务将旧侧车 epoch 回填到主库 `import_manifest`；回填使用 compare-before-write，若已有不同主库值则报身份冲突。回填失败不能改变本次生效 epoch 的裁决。

**验收：**构造旧版“删库→首包建立无 epoch 行主库→升级”目录；新读函数、API handshake、导入 scope 都保持旧侧车 epoch，旧 scope 证据不能被新库复用。另测侧车损坏、主库已有 epoch、配置身份变化。

### P1-2 启动阻断误撤销已签发许可

**修改位置：**`apps/api/src/deletion-recovery.ts` 的 `blocked()`；`apps/api/src/runtime-state.ts` 的作用域转移；CLI 恢复测试。

**实施方法：**

1. 将“本次启动无法裁决”保存在删除裁决结果中；对快照暂时缺失、账本实例冲突等情况，不调用会撤销许可的 `markScopeDatabaseUnreadable()`。持久删除日志本身已使下一次启动重新裁决，无须用 `unknown` 覆盖同一 `deletionId` 的未消费许可。
2. 只有**主库实际存在且经检查不可读**、且该 scope 确实代表该主库时，才作不可逆的不可读观察；记录明确原因。`main_removed` 阶段若已存在同一删除 ID 的 `pristine` 行，快照问题解除后先验证原许可，不能把它当冲突，也不能再生成一张许可。
3. `permit_issued` 阶段按 P2-2 移除快照持续存在的前置条件；此阶段只验证原许可与身份。CLI 与启动裁决共用同一验证函数，避免一方可继续、另一方拒绝。

**验收：**`permit_issued` 后临时移走快照并重启、再放回快照；原许可的 `firstEmptyEpoch/pristineAt/permitSource` 不变，首包最多成功一次。对真正不可读主库则继续阻断自动建库。

### P1-3 删除健康记录的脏边界丢失

**修改位置：**`packages/storage-sqlite/src/database.ts` 的 `removeHealthKitRecords()` 与 `removeDeletedHealthKitAliasCopies()`；`packages/health-export-parser/src/dirty-range-input.ts`、`dirty-range.ts`；`apps/api/src/direct-sync-ingest.ts` 的 `nightWindow()`。

**实施方法：**

1. 删除前的 SELECT 同时读取每个待删行的 `type/start_at/end_at`。在同一事务、删除行之前，把它们写到 `import_entity_changes.previous_type/previous_effective_at/previous_end_at`；`effective_at` 可保留兼容值，但不得代替旧侧。别名副本必须使用**副本自身**的旧区间和类型。
2. 对仅删除来源但 canonical 行由另一活来源保留的路径，按最终事实变化写 `updated` 的新旧侧；若事实完全未变，不制造误导性的删除边界。处理同批多次指向同一 canonical 行时，保存本批最早的旧侧，不让后一次 `INSERT OR REPLACE` 擦掉它。
3. `loadDirtyRangeInput()` 对 `removed` 只依赖账本旧侧。遇到历史账本 `removed` 且旧侧缺失、无法证明类型/区间时，将该批升级为 `full`，不能把它解释为无影响。未知类型的删除也必须触发 `unknown_record_type` 的全量保护。
4. `nightWindow()` 的删除路径同时读取旧起止时间和类型，覆盖跨夜区间；不能只用 `effective_at` 一个时刻重建夜事实。

**验收：**“删除已有评分记录＋同批较晚 workout”“删除未知类型＋已知变更”“删除跨夜 sleep/HRV”“删除旧别名副本”均与同事实的全量分析零业务差分；历史不完整账本走 `full`。补 T10 当前未覆盖的“删除已存在记录”变体。

### P1-4 恢复阻断期间启动和定时器仍访问主库

**修改位置：**`apps/api/src/server.ts` 的 `recoverDatabaseJobs()` 调用、`ensureWeeklyPlan()`、各启动任务与定时器。

**实施方法：**

1. 删除裁决得到 `deletionRecoveryRequired` 后，不执行 `recoverDatabaseJobs()`、训练区回填、每周计划生成及任何需打开主库的 worker 调度。用一个启动期的 `mainDatabaseAccessAllowed()` 判据统一门控，并逐一审计所有 `setTimeout/setInterval` 回调；健康状态和备份诊断不受影响。
2. 待迁移主库若同时需要删除恢复，不在 `app.listen()` 前因 `PendingMigrationsError` 退出 78；把诊断写入恢复状态，让显式备份恢复可用。正常、无删库阻断的待迁移启动政策保持原样。
3. 恢复成功后再执行一次受控的 job/lease 恢复和后台调度；若这一步失败，继续保持业务阻断，不宣称恢复完成。

**验收：**`prepared` epoch 冲突且主库可读、`main_removed` 留下不可读文件、待迁移主库三类场景下，API 都能提供诊断和恢复路由；恢复前主库 `recompute_jobs` 等表字节不变，定时器不写主库。

### P1-5 首装写者进入后、建库前崩溃无法恢复

**修改位置：**`apps/api/src/import-worker.ts` 的首包执行阶段；`apps/api/src/import-scope-cli.ts`；`apps/api/src/runtime-state.ts`；操作文档。

**实施方法：**

1. 保留“写者先于主库写入持久化”的顺序，不直接把 `writer_entered` 重新变成 `pristine`。新增可审计的显式 `abandon-and-create-new-epoch` 运维恢复流程：要求确认原主库及 WAL/SHM 不存在、核对任务/删除日志与 runtime 实例、记录操作者确认和旧 scope 作废事实，再生成**全新 epoch**及其一次性许可。原 scope 和原任务保持已消费/待人工裁决状态。
2. 若存在可恢复备份，优先恢复原数据集；无法证明旧任务未曾提交时，不把原任务标成 `failed` 并悄悄重试。新 epoch 的首包必须使用新 job 身份。
3. 增加建库前后持久阶段或诊断事件，明确指出故障落在 `writer_entered` 与 `RaiDatabase.open()` 之间；阶段仅辅助诊断，不能单凭“主库现已缺失”复活旧许可。

**验收：**在两个持久屏障之间 SIGKILL，重启不自动建库；显式恢复创建不同 epoch，旧 scope 的回执、anchor、任务不可见，新首包成功且许可只消费一次。

### P1-6 已提交 publication journal 把“不可读”误判为“无回执”

**修改位置：**`apps/api/src/import-publication.ts` 的 `ImportPublicationJournal.recover()`；`apps/api/src/import-worker.ts` 构造与恢复阻断通知。

**实施方法：**

1. `committed` intent 改用 `readImportReceiptForRecovery()`。`found` 保留 intent 直到 runtime job 确认；`missing/unreadable` 保留 intent、记录恢复阻断，继续启动恢复 API；只有 `confirmed_absent` 才报告真正的“已提交 intent 与回执不符”。
2. `prepared` 分支也停止用吞错回执作文件替换裁决。主库暂时不可读时不能删除主库或回滚点，必须保留现场并给出可诊断状态。journal 解析或路径身份损坏仍按明确启动错误处理，但需要评估能否启动不碰主库的恢复服务。
3. 将 journal 恢复结果设计为结构化状态传给 ImportWorker；构造函数不得因为可恢复的 `missing/unreadable` 异常直接使整个 API 退出。

**验收：**`committed` intent＋主库锁定/权限故障/损坏/缺失分别启动；不清 journal、不误报失败、不创建新库，恢复入口可达；修好主库后原回执只发布一次。

### P1-7 `recovery_required` 导入任务阻塞显式备份恢复

**修改位置：**`apps/api/src/server.ts` 的 `isDatabaseRestoreBusy()`；`apps/api/src/import-worker.ts` 的 `hasPending`、`recoveryBlocked` 与恢复后重新裁决。

**实施方法：**

1. 忙判定拆为“仍有真实写者或未完成的终态确认”与“停在恢复裁决的旧任务”。只有前者禁止替换主库。允许经过认证的显式 restore 越过后者，同时必须确认 worker 线程已终止、没有活动写锁，并冻结新任务进入。
2. restore 成功会创建新 dataset epoch。旧 scope 的待裁决任务保留原持久事实，标为被显式恢复所替代或要求重启后按旧 scope 收口；不能对恢复出的备份读取不到旧回执就倒推旧事务从未提交。恢复后重建/重载 ImportWorker 状态，再解除当前进程阻断；若无法安全重载，则响应“恢复成功、须重启”并保持业务关闭。
3. 失败的 restore 不得清除原任务、journal 或阻断位；重复 restore 要由恢复日志幂等裁决。

**验收：**构造已提交结果不确定的导入，确认普通写请求 409、显式 restore 不因该任务的 `hasPending` 被 409；恢复后旧 scope 不再阻塞新 scope，且旧任务无虚假的“未提交”终态。

### P1-8 历史 runtime 损坏证据未纳入首装判据

**修改位置：**`apps/api/src/import-scope-cli.ts` 的只读预检和 `applyFreshInstall()`；`apps/api/src/runtime-state.ts` 的隔离路径。

**实施方法：**

1. 预检结果改为 `absent / readable / unreadable`，而不是把打开失败与不存在都变成 `null`；查询失败继续明确报错。调用 `new RuntimeStateStore()` 前扫描主库、侧车、`runtime.sqlite` 及 `runtime.sqlite.corrupt-*`、保留的账本备份和任务/来源历史。发现任一历史证据时，`--fresh-install` 拒绝并输出具体证据路径。
2. 初始化与预检间要防状态变化：在受控锁下重新检查“真正全新”，再签发许可。runtime 构造器隔离损坏账本后，CLI 必须知道发生过隔离，不能把重建空账本当首装。
3. 区分“从未安装”与“运维决定放弃旧数据集”：后者走 P1-5 的新 epoch 显式流程，不借用 `--fresh-install`。

**验收：**不存在任何历史文件时首装成功；账本查询损坏、打开失败、已隔离为 `.corrupt-*`、主账本缺失但有侧车/旧任务时均拒绝首装。报告原称“一切读失败都返回 null”不作为测试前提。

### P1-9 删除失败回滚把损坏库登记为 established

**修改位置：**`apps/api/src/server.ts` 的删除 catch；`apps/api/src/maintenance.ts` 的恢复和 replace gate 生命周期。

**实施方法：**

1. catch 中先确认主库可用：`quick_check`/必要表结构/配置 epoch 与预期 `previousEpoch`，并确认 WAL 状态与维护层 replace gate 已释放；仅 `existsSync` 不够。原库本来就损坏时不能声称“已恢复健康”，应保留人工恢复状态。
2. 验证成功后按 P2-3 先撤销 next scope 许可，再关闭删除日志、登记旧 scope established，并调用 `changeDatasetEpoch(previousEpoch)` 回切当前进程 worker/command scope。任一步失败继续阻断，留下未收口日志供重启裁决。
3. 维护层负责在所有异常路径释放或明确保持 replace gate，返回结构化的“恢复成功且已验证”证据；server 不能从文件存在推断成功。

**验收：**删除中途失败、保护快照恢复失败、恢复出损坏文件、许可已发但侧车推进失败四种路径分别故障注入；不能出现“日志 rolled_back、主库不可读、scope established”的组合。

## 2. P2：恢复协议、对外合同与执行细节

| 编号 | 实施位置与方法 | 最低验收 |
|---|---|---|
| P2-1 过早 established | `import-worker.ts`：将现有“文件存在就登记 established”移到成功打开和结构检查之后。对已经持久 established 的 scope，重复诊断写失败不应阻断 no-op/data-only；对尚无安全证据的 scope 仍拒绝写入。 | 零字节/损坏文件不变 established；既有 established 的重复写失败不误阻断只读或 no-op 车道。 |
| P2-2 `permit_issued` 强制快照 | `deletion-recovery.ts`、`import-scope-cli.ts`：快照哈希核验只用于 `prepared/main_removed` 的删除完成或新许可签发；`permit_issued` 只验证删除 ID、完整 scope、账本实例与未消费原许可。更新 `STATE_CONTRACT` 的阶段表。 | 许可发出后快照轮换，启动与 CLI 仍能消费同一许可；`main_removed` 且快照缺失仍拒绝补发。 |
| P2-3 收口不撤许可 | `runtime-state.ts` 增加按 `deletionId + scope` 条件撤销许可的方法；`server.ts` 的回滚/restore 与 `deletion-recovery.ts` 的自动收口先撤许可、再关闭侧车，最后回切进程 scope。跨库中断采用可重放顺序，任何中间态宁可阻断。 | 各步骤强杀后重启都不能消费已回滚的 next scope 许可；原 scope 或恢复 scope 正确。 |
| P2-4 restore finalization 失败 | `deletion-recovery.ts` 在 `writer_entered + 可读主库` 时比较主库 epoch 与 `nextEpoch`：若主库显式持有 restore 的新 epoch，幂等补写 `superseded` 和侧车最终 epoch，再登记 established；若仍是 next epoch，则保留已消费语义。 | restore 已写主库而收口失败后重启；之后再让主库缺失，绝不退回旧 `nextEpoch`。 |
| P2-5 `prepared + 不可读主库` | 提供只读列举、哈希核对 `quarantine` 快照和受控隔离/恢复操作；CLI 不因“文件存在”自动确认删除，只有运维明确选择、保护字节匹配且原文件已隔离，才继续原 `deletionId`。 | 损坏主库可由操作入口诊断和恢复；没有任何自动把不可读判为已删的路径。 |
| P2-6 路线归属冲突普通 Error | `direct-sync-ingest.ts` 返回稳定拒收原因 `route_ownership_conflict`；`import-worker.ts` 形成 `ImportLaneRefusal`/`failureCode`；同步更新 API 合同与 iOS 对不可重试冲突的处置。 | 同批二次改归属事务全回滚，公开 job 具有稳定码，不进入无限自动重试。 |
| P2-7 删除记录未绑定身份 | `dataset-epoch.ts` 的新记录版本保存 `serverId/athleteId` 或规范 scope hash，并在 API/CLI 每次读取时严格比较。旧 v1/v2 记录不可凭新环境自动签发，需明确迁移或人工恢复。 | 只改环境 identity 重启时不能给新 namespace 签发原删除许可。 |
| P2-8 `routesUpdated` 语义 | 在 `packages/api-contracts` 与 `docs/IOS_NATIVE_API_CONTRACT.md` 明确“本批内容或归属发生变化的唯一路线数”；保留 `phase3-import-matrix.test.ts` 已有“XML-only 改归属为 1”断言，补内容不变/重复 ID 的去重边界。核对 iOS 展示文案。 | 合同、回执和 iOS 用语一致；不再声称此语义完全无测试。 |
| P2-9 退役路由 410 优先级 | `server.ts` 的 `preHandler` 对精确 method/path 的已退役路由先放行至 410 handler，再处理删库恢复 409；不可按 URL 前缀放行仍有效路由。 | 恢复期退役路由 410、未知路由 404、现役业务路由 409。 |

## 3. 验收证据与报告修订

1. **重建 `equivalence-summary.json`。** 当前文件的验证记录为 2357/2344，正向场景 `tables` 仍只有 12 项，虽顶层清单已列 15 项。修复后从同一次最终测试运行生成新 JSON，记录每场景实际表名/行数/字段数、commit/工作树摘要、命令、并发、日志、测试统计和时间。若生成器未读取三张新投影，直接失败；报告不能继续把旧文件当最终 15 表证据。
2. **T12 准确界定 B 侧。** 现有 B 是生产导入修订批次、经生产取消接口取消原分析任务、再由测试手工 `enqueueControlledFull()` 建全量对照并交给生产分析消费者。报告与矩阵必须写成“生产导入＋受控全量分析对照”。若要声称 B 也是生产导入任务的全量主路径，就增加正式生产入口生成全量请求的测试，而不是换一个描述。现有 `reuse.proof=verified` 和 `loads.reused>0` 断言不能支持精确的 loads/zones/daily `reused=4`；补三个精确断言并说明数据夹具稳定性，或将 4 标成当次观测值。
3. **F10 补生产发布路径。** 现有测试手工 seed run/bundle 后直接调用 `activateSucceeded()`，可证明存储操作原子/幂等。新增 `activateModelRunAndCompleteJob()` 的真实任务完成、发布前/提交中/提交后故障测试，核对 `recompute_jobs`、bundle、两个 active 指针、可读状态和重复发布；若不补进程级 SIGKILL，报告明确注明该层尚未覆盖。
4. **给 15 表比较器加自校验。** 在 `business-artifact-projection.ts` 定义独立的必需表名与列名规范；生产 fixture 投影必须恰好匹配，关键表不得意外为空。负对照增加对 `training_sessions`、`model_release_bundles`、`release_readable_state` 的缺表/缺列/业务值变化校验；现有手工 7 表 fixture 仅证明比较机制，不作生产清单完整性证据。
5. **统一计数与 manifest。** `PHASE3_REPORT.md` 中 G11 9/9 明示为历史运行；当前 `dataset-deletion-recovery.test.ts` 为 13 条，须用新日志报告实际通过数。`TEST_MATRIX.md` 的 24/24、12 表改为对应最终运行事实。`manifest.json` 的 `changedFiles` 从最终 `git status`/打包范围生成，不保留 25 对 41 的错配；G3 现有日志是 54 tests，若仍声称 38/38，须提供独立 38-test 日志。

## 4. P3：低优先级实施办法

| 项目 | 处理 |
|---|---|
| 故障注入自毁开关 | `fault-injection.ts` 的 `sigkill/throw` 只在明确测试开关与测试环境双条件下启用；子进程测试显式提供两项，部署模板不设置。仍保留确定性故障验收能力。 |
| CLI 诊断文案 | `writer_entered` 且主库缺失时 `actionRequired` 返回 `database_recovery`/`manual_review`，同时输出删除 ID、scope 和建议入口；不返回 `none`。 |
| 时间格式 | `direct-sync-ingest.ts` 对注入的 `input.now` 使用规范 UTC 毫秒 ISO 形状并回读验证；`canonicalize-nights.ts` 的外部 `computedAt` 参数同样校验。生产默认时钟保持 `toISOString()`。 |
| GPX 强制 ID 参数 | 当前 `forceChangedRouteIds` 对最终去重 ID 集合有冗余，但缓存命中时还产生 `ownershipChangedRouteCount`。先确认该计数的消费者与合同，再决定删冗余参数或保留并补缓存命中单测；不要在本轮安全修复中顺手改变回执。 |
| observer 清理 | `direct-sync-ingest.ts` 用 `try/finally` 清理 `observeRouteOwnershipChanges(undefined)`，即使 XML 解析抛错也不留回调；当前 `store.close()` 已兜底，因此按维护改进验收。 |
| 公开错误详情 | `import-worker.ts` 的 `publicJob()` 不直接输出含 SQLite/路径详情的 `job.message`；公开文案和稳定 `failureCode` 与内部日志分离，检查轮询与单次查询两个公开入口。 |
| 同阶段 replay 事务 | `dataset-epoch.ts` 的同阶段返回前显式 `COMMIT`，或在开始事务前做只读阶段判定；加重复调用后连接可正常继续使用的测试。当前无写入，属语义加固。 |
| 旧 epoch API | `writeDeletedDatasetEpoch()/readDatasetEpoch()` 在旧目录兼容测试仍有价值。先补 P1-1 的生产读函数测试，再决定标注 deprecated 或移除旧写入口；不得先删兼容读取。 |

## 5. 建议的实施批次与最终验收

1. **批次 A：身份与脏证据。** P1-1、P1-2、P1-3、P2-2、P2-7；先固定旧目录与删除记录夹具，再改读写协议。
2. **批次 B：恢复服务可用性。** P1-4、P1-5、P1-6、P1-7、P1-8；用真实子进程覆盖重启、SIGKILL、损坏/缺失文件和显式恢复。
3. **批次 C：删除/restore 收口。** P1-9、P2-1、P2-3、P2-4、P2-5；每个跨主库、侧车、runtime 的持久断点都做故障注入，验证同进程及重启后一致。
4. **批次 D：合同与证据。** P2-6、P2-8、P2-9、P3 和第 3 节证据修订；最终从同一次验证生成报告，不拼接不同代码版本的统计。

每批改动按仓库 `AGENTS.md` 选择检查。API/包变动至少运行 `npm run typecheck` 与 `RAI_TEST_CONCURRENCY=2 npm test`，并在记录中注明并发数；测试或 `docs/ALGORITHM.md` 改动运行 `npm run check:acceptance-matrix`，README/AGENTS/`docs/` 改动运行 `npm run check:docs`，启动路径改动运行 `npm run smoke:api`。iOS 合同/客户端调整运行 `npm run test:ios` 与 `npm run check:ios-gates`。最后核对所有证据文件与代码版本、最终 `git status` 和报告叙述一致。

**进入下一阶段的判据：**九项 P1 的真实故障路径均有直接回归；删除/restore 的所有持久中断点可恢复或明确保持阻断；旧 scope 不复活；删除记录增量与全量业务产物等价；恢复接口在阻断态可达；15 表证据和测试统计与最终代码一致。未达到这些条件时，阶段 3 报告应标注“修复中”，不写无保留通过。
