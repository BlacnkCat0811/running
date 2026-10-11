# 未提交改动审查（2026-10-11）

**审查对象**：工作区**无未提交改动** —— `git status --porcelain=v1` 返回 **0 行**（无修改 / 无未跟踪 / 无暂存），无 stash，无额外 worktree，本地 `main` = `origin/main` = `5950a11`。
经确认，实际审查对象为**最近已提交批次** `14bda36..5950a11`（5 个提交 / 21 文件 / `+1150 −51`），即今日智能体协作产出的全部改动。

| 提交 | 内容 | 性质 |
|---|---|---|
| `cebb0dc` | fix(recompute)：纯补史导入不再被资格漂移门禁死锁（新增 `sourceBackfill` 证据通道） | 后端代码（9 文件） |
| `076b8bd` | fix(ios)：盘上有 `jobId` 的任务不再坠进导出路径（前台续接 + 逐类型进度） | iOS 代码（10 文件） |
| `6ea930f` | fix(ios-tests)：live 导出确定性探针源文件清单补齐 | iOS 测试脚本（1 文件） |
| `f2e5da0` / `5950a11` | docs：两份验收证据 + `deliverables/README.md` | 文档 |

**方法**：主智能体分派 **3 路并行子智能体**（后端 / iOS / 文档），并对**全部关键结论亲验**；门禁实跑 + 突变验证。
所有结论落到 `文件:行号` 或命令实测输出。

---

## 一、结论摘要

| # | 级别 | 结论 | 证据 |
|---|---|---|---|
| 1 | ✅ | **`batch_id` 身份一致**：解析器写账本与 recompute 查账本用的是同一个 `job.id` | `import-worker.ts:578` / `:654` / `:48`；`database.ts:948,975` |
| 2 | ✅ | **4 处删除事实行的路径全部写账本**（`change_type='removed'` 或 tombstone） | `database.ts:2650-2659` / `:2742-2752` / `:2964-2988` / `:3062-3087` |
| 3 | ✅ | **`--replace` / 非增量路径不会误放行**：拿不到 `inserted` 行 ⇒ `earliestInsertedIsNewGlobalEarliest=false` ⇒ 豁免不生效 | `packages/health-export-parser/src/cli.ts:275-281,307-311`；`recompute-pipeline.ts:425-428` |
| 4 | ✅ | iOS `nextStep` 的 `jobId` **优先短路**，节流豁免与选分支**同源**（派生属性，非手写 `jobId != nil`） | `SyncPhase.swift:162,144`；`HealthKitSync.swift:303-313` |
| 5 | ✅ | `.waitJob` 分支存在、不认领后台意图、失败分类共用 `HealthSyncResumePolicy` | `HealthKitSync.swift:916,942,956`；`HealthSyncCancellation.swift:38` |
| 6 | ✅ | **三个门禁全绿**：`typecheck` / `npm test` / `test:ios` 均 EXIT=0 | §四 |
| 7 | ✅ | **突变有效**：摘掉 `earliestInsertedIsNewGlobalEarliest` ⇒ 门禁变红（复现并还原） | §四.4 |
| 8 | ✅ | **载荷逐字节未变**：进度文案只走 `onProgress` | `Export determinism checks: 14 checks, 0 failed` |
| 9 | ✅ | 两份验收文档**行号抽验一致**、门禁数字与脚本常量一致、未验证项**诚实** | §五 |
| 10 | 🟡→✅ | **"零删除证人"的写入侧无专项断言**：`batchId` 形参可选 + `if (batchId)` 条件写 ⇒ 漏传会静默降级 —— **已修**，新增库级测试直击生产删除方法 | 原判据 `database.ts:2443-2446,2653,2735,2965,3064`；修复见 §八 |
| 11 | 🟡→✅ | **迁移去重路径**删 `health_records` 且删 tombstone、**不写账本**（低危：删的是重复行）—— **已修**，改为断言钉住 | 原判据 `database.ts:1576-1590`；修复见 §八 |
| 12 | 🟡→✅ | **证据强度边界**：线上从未发生真实删除事件，起判别作用的是"最早事实前推"这一条 —— **已修**，新增"生产路径删除 + 读证据"端到端用例 | 原判据 验收文档 §6.2；`database.ts:2921-2928`；修复见 §八 |

**本轮无 🔴。**

---

## 二、🔴 必修

无。

---

## 三、🟡 待决策（**三条均已处理**：🟡1 / 🟡3 已修，🟡2 改为断言钉住；修法与证据见 §八）

### 🟡1 "零删除证人"的写入侧无专项断言（覆盖缺口，非缺陷）

`recordEntityTombstones(kind, ids, options?)` 的 `options.batchId` 是**可选**的（`packages/storage-sqlite/src/database.ts:2443-2446`），
且 4 处写 `import_entity_changes` 的行都是 `if (batchId)` 条件写（`:2653` / `:2735` / `:2965` / `:3064`）。

⇒ 若**将来**新增一条删除路径漏传 `batchId`，`sourceBackfillEvidence()` 的 `preservedAbsent` 会**静默为 `true`**
（查询 `WHERE batch_id = ?` 查不到任何行 = 读作"零删除"）。

**当前防线**：`earliestInsertedIsNewGlobalEarliest` 要求查到**本批的 `inserted` 行**（`recompute-pipeline.ts:425-428`），
所以"完全无账本"这一形态会被挡住；但"账本存在、**某一条**删除路径漏写 `removed`"这一形态**无断言保护**。

**现状覆盖**：`apps/api/test/healthkit-record-changes.test.ts:44-46` 通过 `planHealthChanges` **间接**依赖 `removed` 行
（`dirtyFromAt` 取自被删行的 `effective_at`），**不是直接断言**。

**建议**：加一条集成测试，直接走生产删除路径（`removeHealthKitRecords(deletions, batchId)` 或
`finalizeImportGeneration(generation, batchId, {})`），断言 `import_entity_changes` 出现该 batch 的 `change_type='removed'` 行。
**验收标准**：把该断言对应的写入改成 `if (false)` ⇒ 测试必须变红。

### 🟡2 迁移去重路径删 `health_records` 不写账本（低危）

`database.ts:1576-1590` 的 realign 去重：`deleteGeneration` → `deleteTombstone` → `deleteRecord`，
**既不写 `change_type='removed'`，还主动删掉对应 tombstone**。

**为何低危**：它删的是**重复 id**（同一 `record` 的冗余副本，内容相同），语义上是"冗余消除"而非"数据丢失"，
且只在 `duplicateIds.length > 0 || needsRename` 时触发（罕见修复路径）。

**建议**：在注释里显式声明"该路径的删除不计入事实丢失"，或把它纳入上面的断言范围。不急于改。

### 🟡3 证据强度边界（时点事实，非缺陷）

线上 `import_entity_changes(change_type='removed')` 与 `import_entity_tombstones` **全库为 0**
（`VERIFICATION_2026-10-11-source-backfill.md` §6.2 自认），且线上案例走 `--preserve-absent`
⇒ `finalizeImportGeneration` **直接短路不删**（`database.ts:2921-2928`）。

⇒ 本次真正起判别作用的是 `earliestInsertedIsNewGlobalEarliest`；"零删除证人"**未经真实删除事件演练**。
这是证据强度的诚实边界，**建议保持记录**，并有条件时补一次"真实删除事件"的集成演练。

---

## 四、门禁实跑（主智能体执行，日志在 `.workbuddy/runlogs/`）

| 门禁 | 结果 | 日志 |
|---|---|---|
| `npm run typecheck` | **EXIT=0**（`tsconfig.pure.json` + `tsconfig.json`） | `typecheck-2026-10-11.log` |
| `npm test` | **EXIT=0** · node 段 `# tests 1545 / pass 1542 / fail 0 / skipped 3` · web vitest `25 files / 184 tests passed` | `npmtest-2026-10-11.log` |
| `npm run test:ios` | **EXIT=0** · 类型检查 90 文件（跳 3）· `HealthKit record sync wiring: 26 checks, 0 failed` · `Health sync archive execution-boundary checks: 19 checks, 0 failed` · `Background capability checks: 274 checks, 0 failed` · `Export determinism checks: 14 checks, 0 failed` | `ios-gates-review-2026-10-11.log` |

> ✅ 全部数字与两份验收文档声称的一致。
> ⚠️ node 段 `3 skipped` —— 按既有记载，`publication lock rejects PID reuse…` 在 macOS 上靠 `spawnSync("ps", …)`
> 探测进程身份，子进程被沙箱拒 ⇒ 按设计 fail-safe 跳过。**这个数会随环境变化，不是覆盖丢失**。
> ⚠️ 上轮报告提到的 `server-runtime.test.ts` 负载型假失败**本次未复现**（`fail 0`）。

### 4.1 突变验证（证明断言不是空转）

```bash
# 突变：摘掉 verifiedBackfill 的 earliestInsertedIsNewGlobalEarliest 条件
#   model-transition-gate.ts:239  ... && backfill.earliestInsertedIsNewGlobalEarliest === true;
#                              →  ... && backfill.removedCalibrationSessions === 0;
node --import tsx --test packages/storage-sqlite/test/model-transition-gate.test.ts
```

实测：

```
MUT_EXIT=1
not ok 14 - sourceBackfill: without the global-earliest proof the drift still fails
# tests 18 / # pass 17 / # fail 1
```

⇒ 该条件**真的在拦**：摘掉它，非补史的时间线也会被豁免，测试如期变红。

**还原校验**：`shasum -a 256 packages/storage-sqlite/src/model-transition-gate.ts`
= `aac789ed834caa0c7401cfe5bfc430cbf4a0380b85d5e9a83c0f51b87b8e5ccf`（与突变前一致）；
`git status --porcelain` = **0 行**。

---

## 五、逐层亲验（✅ 通过项）

### 5.1 后端 `sourceBackfill`（`cebb0dc`）

| 判据 | 位置 | 实测 |
|---|---|---|
| 账本写入与查询同一 id 空间 | `import-worker.ts:578`（`--batch-id job.id`）/ `:654`（`--import-batch job.id`）/ `:48`（`createImportJobId` = `web_import_<base36>_<uuid>`） | ✅ 同一个 `job.id` |
| `import_batches` 主键即该 id | `database.ts:948`（`id TEXT PRIMARY KEY`）、`:975`（`import_entity_changes.batch_id REFERENCES import_batches(id)`） | ✅ |
| 删除 record 写 `removed` + tombstone | `database.ts:2650-2659`（alias 副本）、`:2742-2752`（主删除） | ✅ |
| 删除 workout / summary 写 `removed` + tombstone | `database.ts:2964-2988`（finalize）、`:3062-3087`（sync-identifier 删除） | ✅ |
| `preserve-absent` 下根本不删 | `database.ts:2921-2928` 直接返回 0 | ✅（线上案例即此路径） |
| `--replace` / 非增量不写账本 ⇒ 豁免不生效 | `packages/health-export-parser/src/cli.ts:276-281`（`if (incremental)` 才插 `import_batches`）、`:307-311`（才传 `incremental.batchId`） | ✅ 被 `earliestInsertedIsNewGlobalEarliest=false` 挡住 |
| 首次导入不经 gate | `recompute-pipeline.ts:312`（`incumbentModelRunId ? evaluateModelTransitionGateV2(...) : {...}`）、`:315` | ✅ |
| 阈值未改 | `MODEL_TRANSITION_GATE_THRESHOLDS_V2` 一字未动（`model-transition-gate.ts:107` 区域） | ✅ |
| 缺省输入逐位等价 | `...(sourceBackfill === undefined ? {} : {sourceBackfill})`（`:315`）；结果对象 `...(backfill === undefined ? {} : {sourceBackfill: backfill})` | ✅ 且有专门测试 `sourceBackfill: omitted evidence is bit-identical…` |

### 5.2 iOS `.waitJob`（`076b8bd` + `6ea930f`）

| 判据 | 位置 | 实测 |
|---|---|---|
| `jobId` 优先短路 | `SyncPhase.swift:162` `if jobId != nil { return .waitJob }` | ✅ |
| 节流豁免与选分支同源 | `SyncPhase.swift:144` `isServerReconciliationOnly`；`HealthKitSync.swift:303-313`（`isLedgerResume` 由 `nextStep` 派生） | ✅ 不另写 `jobId != nil` |
| `.waitJob` 分支存在 | `HealthKitSync.swift:916` | ✅ |
| 分支内**不**认领后台意图 | `:922-926` 注释 + 门禁 §15d 钉住 | ✅ |
| 失败分类共用 | `:942-945` `HealthSyncResumePolicy.disposition`；`:956` `terminalJobCode` | ✅ |
| `terminalJobCode` 常量 | `HealthSyncCancellation.swift:38` = `"import_job_failed"` | ✅ |
| 删掉的 `.inspect` 回退确实不可达 | `.inspect` 前置 = `unitStep == .inspect`，而 `nextStep` 中 `jobId != nil` 已先行返回 ⇒ `restored.jobId` 必为 nil | ✅ 逻辑成立 |
| `markSuccess` 参数对齐 | 定义 `HealthKitSync.swift:1437-1448`；调用 `:928-937`（含 `clearWatermark`/`anchor`/`recordCursors`/`routeDiscoveryCursor`） | ✅ |
| `writeGlobalRecords` 调用点完整 | 唯一调用 `HealthKitExport.swift:402-405`，已传 `onProgress` | ✅ |
| 门禁地板自洽 | `check-background-capabilities.py:1876` `MIN_CHECKS = 273`（打印 274，地板 = 打印 − 1） | ✅ |

### 5.3 文档（`f2e5da0` / `5950a11`）

| 判据 | 实测 |
|---|---|
| `SyncPhase.swift:144` 引用内容 | ✅ 该行正是 `var isServerReconciliationOnly: Bool { self == .waitJob }` |
| `HealthKitSync.swift:916` 引用内容 | ✅ 该行正是 `.waitJob` 分支的 `if let restored = restoredTask, unitStep == .waitJob, …` |
| `HealthKitSync.swift:995-998` | ✅ 该段正是"原回退不可达"的说明 |
| `MIN_CHECKS` 273 / 记录 274 | ✅ 与脚本一致 |
| 门禁数字 26 / 274 / 14 / 19 | ✅ 与本次实跑逐项一致 |
| 未验证项诚实性 | ✅ `VERIFICATION_2026-10-11-ios-resume.md` §9 明说"模拟器走不到 `.waitJob` 真实分支与进度文案"、"仍需 Xcode 安装到手机"、"`.waitJob` 四条出口未对真 `GET /v1/import-jobs/<id>` 跑过" |

### 5.4 部署面

`git diff --name-only cebb0dc..5950a11` 全部落在 `apps/ios/**`、`docs/`、`deliverables/` ⇒
**服务器侧零改动，本轮不需要部署**（与 `VERIFICATION_2026-10-11-ios-resume.md` §9.4 一致）。

---

## 六、修复顺序 + 验收标准 + 回滚

| 顺序 | 项 | 验收标准 | 回滚 |
|---|---|---|---|
| 1 | 🟡1 补"删除路径必写账本"的直接断言 | 把任一写入改成 `if (false)` ⇒ 测试变红；正常态全绿 | `git checkout -- packages/storage-sqlite/test/...` |
| 2 | 🟡3 记录/演练"真实删除事件"边界 | 造一次真实删除导入，断言 `preservedAbsent=false` ⇒ 不走豁免 | 纯文档/测试，无运行时回滚 |
| 3 | 🟡2 realign 路径加注释声明（可选） | — | `git checkout -- packages/storage-sqlite/src/database.ts` |

**破坏性变更 / 迁移**：本批**无**新迁移、**无**破坏性契约变更（`importBatchId` 为可选字段，缺省逐位等价）。

---

## 七、清理项

- `.workbuddy/runlogs/` 下本次新增的日志（`typecheck-*` / `npmtest-*` / `ios-gates-review-*`，含 §八 的 `-b`/`-c` 重跑）—— 未纳入版本控制，按需保留。
- 工作区：§八 的修复留下 **3 个测试文件改动 + 本报告**；`packages/storage-sqlite/src/database.ts` **与 HEAD 逐字节一致**（无产品代码改动）。
- ⚠️ 两份 `VERIFICATION_2026-10-11-*.md` 与 `UNCOMMITTED_REVIEW_2026-10-09/10-10` 按 `deliverables/README.md` 的约定属"当轮产物"，
  收尾后应并入 `docs/PROJECT_REVIEW.md` 或删除，**不长期保留**。

---

## 八、修复记录（2026-10-11 追加）

上节三条 🟡 **全部处理完毕**。改动只落在**测试**，产品代码零改动。

| 项 | 修法 | 改动文件 |
|---|---|---|
| 🟡1 写入侧无断言 | 新增 4 条直击**生产删除方法**的库级测试 | `packages/storage-sqlite/test/import-removal-ledger.test.ts`（新） |
| 🟡3 未经真实删除事件演练 | 新增 1 条：走**生产删除路径**删一次再读证据，断言「最早事实前推」成立也压不住真实删除 | `packages/application/test/source-backfill-evidence.test.ts` |
| 🟡2 realign 去重不写账本 | 改为**断言钉住**（不加注释，理由见 8.1） | `packages/storage-sqlite/test/health-record-id-migration.test.ts` |

### 8.1 为什么 🟡2 用断言而不是注释

原计划在 `database.ts` 的去重循环处加注释。实测发现：**加 7 行注释会让该文件之后所有行号 +7**，
而 `UNCOMMITTED_REVIEW_2026-10-09.md`（6 处）与 `2026-10-10.md`（5 处）都引用 `database.ts:NNNN`，
`check-doc-line-refs` 只覆盖 `docs/` 四个核心文件，**抓不到这类静默作废**。
⇒ 改为断言：不动行号，且能在有人"补上"账本行时**真的变红**（注释做不到）。
断言落在 `health-record-id-migration.test.ts` 的 v22 用例里——该用例本就走去重 + realign 路径。

### 8.2 修复验收（全部亲验）

**门禁**（`.workbuddy/runlogs/`，全量测试独占运行）：

| 门禁 | 结果 | 日志 |
|---|---|---|
| `npm run typecheck` | **EXIT=0** | `typecheck-2026-10-11c.log` |
| `npm test`（干净重跑） | **EXIT=0** · node `# tests 1550 / pass 1547 / fail 0 / skipped 3` · web `25 files / 184 tests passed` | `npmtest-2026-10-11c.log` |

新增 5 条在本次全量里逐条通过：`ok 984`（真实删除演练）、`ok 1393`（迁移去重不写账本）、
`ok 1395/1396/1397/1398`（finalize / removeHealthKitRecords / removeWorkoutsBySyncIdentifiers / preserve-absent）。

**突变验证**（三条，逐条变红后还原）：

| # | 突变点 | 预期 | 实测 |
|---|---|---|---|
| 1 | `database.ts:2965` `if (batchId)` → `if (false)`（finalize） | 只挂 test 1 | `MUT1_EXIT=1` · `not ok 1`（其余 3 条仍绿） |
| 2 | `database.ts:2746` 同改（removeHealthKitRecords） | 同时挂写入侧与真实演练 | `MUT2_EXIT=1` · `not ok 2` **+** `not ok 4` |
| 3 | `database.ts:3064` 同改（removeWorkoutsBySyncIdentifiers） | 只挂 test 3 | `MUT3_EXIT=1` · `not ok 3` |

突变 2 同时挂掉「写入侧」与「真实删除演练」两条 ⇒ 证明 🟡3 那条读的是**生产路径写出来的账本**，
不是自己塞的行。还原后 `shasum` 与 HEAD 一致，`git status` 里 `database.ts` 消失。

### 8.3 一条运维教训（本轮真踩到）

第一次全量重跑报 `fail 1`：`not ok 9 - 41 missing mappings have runnable assertions …`
`error: 'Source changed during coach behavior replay'`。

根因**不是代码回归**：我在它运行的那 66.7 秒里编辑了 `packages/storage-sqlite/src/database.ts`（撤回注释）。
`scripts/coach-replay-provenance.mts:8-17` 对 `git ls-files … -- packages/storage-sqlite/src …` 的
**每个文件内容**取哈希；`scripts/coach-behavior-replay.mts:32-33` 在重放前后各算一次并比对，不一致就抛。
⇒ **隔离单跑 `EXIT=0` 复现不了**（先跑隔离印证了这点），干净重跑即全绿。

教训：全量门禁运行期间**连"撤回改动"也算改仓库**；哈希面**含 `packages/*/src`，不含 `packages/*/test`**
（所以新增测试文件本身不会触发它）。
