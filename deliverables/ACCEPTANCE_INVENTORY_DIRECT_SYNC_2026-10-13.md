> ⚠️ **本文件是时点侦察产物，不是规范、也不是"验收通过"的声明。**
> 权威的验收矩阵在 [SQLite 直接增量同步设计 §14](../docs/SQLITE_DIRECT_SYNC_DESIGN.md)；本文件只回答
> "每一项**今天**有什么证据、缺什么、被哪一步阻塞"。
> - 判定方法：**只读**（阅读测试源码与产品源码的断言/实现），**没有运行**测试（见文末 U9）。
>   因此"行为级"= 读到了一条**真跑**该路径的断言，不等于"我复跑过它是绿的"。
> - 主智能体抽查了三条关键结论并全部成立：`deploy/upgrade.sh:83-85`/`:94` 仍在 `POST /v1/backups`；
>   全仓只有 1 个测试文件的标题携带 A-id（5 条 / 3 个 A-id）；直连车道的禁止操作守卫只有
>   5 个可观测通道且**没有 SQL 追踪**（§14.1 的"还要记录 SQL"因此机制上不可观测，见 U5）。
> - 随 PR4 各步落地，本文件的判定会**上升**（A01/A04/A10/A11/A12/A15 尤其明显）；
>   引用时请以当时最新提交为准。

# 直连增量同步 §14.1 / §14.2 证据盘点（A01–A18 与十条禁止操作）

- 日期：2026-10-13（Asia/Shanghai）。**只读取证**：本文件是本次侦察的唯一产物，未改动任何源文件。
- 基线 commit：`d2069a4`（PR1–PR3 已提交 + PR4 步骤 1 已提交）。
- 上位设计：`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §14.1（第 452–471 行）、§14.2（第 473–497 行）、§14.5（第 529–544 行）；PR4 剩余计划 `docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md` §6（第 214 行起）、§7（第 233–243 行）、§9（第 303–370 行）。
- 取证时工作树**存在未提交在制品**（PR4 步骤 2a/2b 进行中），见 U6；本报告是 `2026-10-13T02:25+08:00` 的快照。

## 0. 方法（如何复跑这些搜索）

根目录固定为 `/Users/tp/running`；所有 `grep` 都排除 `node_modules`。

**0.1 按 A-id 找测试标题**（只认 `test(`/`it(` 的标题字符串，不认正文与注释）：

```bash
grep -rnE '(test|it)\(\s*[`"'"'"'].*\bA(0[1-9]|1[0-8])\b' \
  --include='*.test.ts' --include='*.test.tsx' apps packages
```

命中 **5 条标题 / 3 个不同 A-id（A01、A05、A17）**，全部在 `apps/api/test/direct-sync-prohibited-operations.test.ts`。⇒ 其余 15 项**没有**按 ID 引用的测试，必须改用属性搜索。

**0.2 确认其余 15 项确实没有 A-id 标题**：

```bash
grep -rnE '(test|it)\(\s*[`"'"'"'].*\bA(0[2-4]|0[6-9]|1[0-6]|18)\b' \
  --include='*.test.ts' --include='*.test.tsx' apps packages     # 退出码 1
```

**0.3 其它根**：

```bash
grep -rnE '\bA(0[1-9]|1[0-8])\b' apps/web apps/ios scripts
```

**0.4 按属性搜索**（对没有 A-id 标题的项）：`SIGKILL|process\.kill|kill\(`、`cursor`、`analysisStatus`、`expectedIncumbentReleaseId|expected_incumbent_release_id`、`mutation_conflict`、`parentBatchId|parent_batch`、`tombstone`、`backup|backups`、`journal_mode|synchronous|foreign_keys|quick_check`、`DATA_ONLY_MAX_XML_BYTES|DATA_ONLY_MAX_RECORDS`、`SEED_CONTENT_HASH`。

**0.5 判定口径**（四类，另允许一个复合标签）：
- `已有行为级证据`：测试真的跑那条车道/那条真实写入路径并断言该属性；
- `只有结构/源码级证据`：源码文本门禁、类型/表结构约束，或**没有生产调用方**的纯函数/组件单测；
- `只有断言/文档`：只有设计文档或交付记录里的声明，没有执行者；
- `未覆盖`：搜索无命中，且没有等价断言；
- `部分行为级`（复合）：该条目的**部分**子条件有真实运行证据、其余见「缺口」列；凡出现该标签，缺口列都写清了缺的是哪一半。

**0.6 记录在案的「无命中」搜索**（按要求连同 pattern 与搜索根一起写出）：

| 搜索 pattern | 搜索根 | 结果 |
|---|---|---|
| `(test\|it)\(\s*["'`].*\bA(0[2-4]\|0[6-9]\|1[0-6]\|18)\b` | `apps/**`、`packages/**` 的 `*.test.ts`/`*.test.tsx` | **无命中**（`grep` 退出码 1） |
| `\bA(0[1-9]\|1[0-8])\b` | `apps/web`、`scripts` | **无命中**（0 个文件） |
| `\bA(0[1-9]\|1[0-8])\b` | `apps/ios` | 17 个文件命中，**全部是二进制**（截图、`Pods/`），无 Swift/Python 文本命中 |
| `DATA_ONLY_MAX_XML_BYTES\|DATA_ONLY_MAX_RECORDS` | `apps/**`、`packages/**` 的测试文件 | **无命中**：5000 条 / 2 MiB 预算只有定义（`packages/health-export-parser/src/record-delta-policy.ts:15-16`），无越界夹具 |
| `SEED_CONTENT_HASH` | `apps/**`、`packages/**` 的测试文件 | **无命中**：命中全在 `src`（`storage-sqlite/src/database.ts:116,3194`、`health-export-parser/src/apple-health-parser.ts:585`） |
| `cursor` | `apps/**`、`packages/**` 的测试文件 | 仅 6 处命中，全在 `packages/physiology`、`packages/training-zones`，**与同步游标无关**；服务端同步游标无用例 |
| `parentBatchId\|parent_batch` | `apps/**`、`packages/**` 的 `src`（生产源码） | **无写入方**：只有 v35 DDL（`packages/storage-sqlite/src/v35-migration.ts:51-59`）与回执字段（`apps/api/src/data-only-import.ts:195` 恒 `null`） |
| `expectedIncumbentReleaseId\|expected_incumbent_release_id` | `apps/**`、`packages/**` 的 `src` | 只有**写入方**一处（`packages/storage-sqlite/src/recompute-job-repository.ts:63-65`），**无比较方** |
| `analysisStatus` | `apps/**`、`packages/**` 的测试文件 | 只有回执断言（`direct-sync-prohibited-operations.test.ts:311`）、源码守卫（`direct-sync-analysis-registration.test.ts:112` 起）与注释；**无「分析失败」用例** |
| `"(pg\|redis\|ioredis\|postgres)"` | 根 `package.json` 与各 `apps/*/package.json`、`packages/*/package.json` | **无命中**（无该依赖，但**没有门禁在守**） |

**0.7 本报告不运行任何测试**：所有"行为级"判定来自**读取测试源码中的断言**，不是执行结果（见 U9）。

## 1. §14.1 十条禁止操作

清单与通道定义：`packages/contracts/src/direct-sync.ts:124-211`。唯一执行者：`apps/api/test/direct-sync-prohibited-operations.test.ts`（该文件 `:9-13` 自述"只有第 1 问是不够的……所以下面还有一条**阳性对照**"）。

**十条的「0」由同一条断言覆盖**：`:238` `assert.deepEqual(triggered, [], ...)`，跑的是**有界 record-only 增量**这一条真实车道（`:226`）。差别只在「通道有没有牙」（阳性对照覆盖 4/10）。

| 编号（§14.1 原文） | 现状判定 | 证据（文件:行 / 测试标题原文） | 缺口 | 阻塞于 |
|---|---|---|---|---|
| `current-backup`（createCurrentBackup） | 行为级（本车道 0，且有阳性对照） | 清单 `packages/contracts/src/direct-sync.ts:126-132`；0 断言 `direct-sync-prohibited-operations.test.ts:238`；阳性对照 `:271` "A01/§14.1 阳性对照：旧候选路径确实会触发守卫，所以上一条的「全 0」不是假绿"（`:288-290` 逐条点名 `current-backup`） | 只在 record-only 车道上被证明为 0；首次历史分页/删除-only/混合评分/大包分批仍走旧链路（该文件 `:15-20` 自述"此刻仍走旧链路，因此**必然**会踩"） | PR6（切路）；PR4 步骤 2e 后需复跑 |
| `whole-database-copy`（backupDatabase / 整库 copy） | 行为级（本车道 0，且有阳性对照） | 清单 `direct-sync.ts:133-140`；0 断言 `:238`；阳性对照 `:288-290` 点名 `whole-database-copy`；文件层独立判据 `:252-255`（`var/` 无 `backups|rai.importing` 残留 + `statSync(main).ino` 不变） | 同上一行；"等价的整库复制/扫描"只有目录名与 inode 两条间接判据，没有 SQL/文件操作追踪（§14.1 明令要求记录 SQL、任务阶段与文件操作） | PR6 |
| `full-database-quick-check`（isReadableDatabase 全库 quick_check） | 行为级（本车道 0，且有阳性对照） | 清单 `direct-sync.ts:141-148`（含 `databaseTaskOperation: "verify"`、stage `database_quick_check`）；0 断言 `:238`；阳性对照 `:288-290` 点名 `full-database-quick-check`；只投递 `data-only` 的断言 `:242` | 同上一行；`computeStagesMs` 账本在直连车道为空，stage 通道在该车道上没有阳性对照（stage 的"有牙"只在旧链路侧被间接证实） | PR6 |
| `activate-database`（activateDatabase / 换库） | 行为级（本车道 0），**无阳性对照** | 清单 `direct-sync.ts:149-156`；0 断言 `:238`；结构自洽断言 `:197-211` 只证明 `ImportWorker.prototype.activateDatabase` 存在 | 阳性对照在 CLI 之前就抛错（`:277-281`），**永不触达**本条目 ⇒ "通道有牙"未证；未覆盖场景同前 | PR6 |
| `install-database`（installDatabase） | 行为级（本车道 0），**无阳性对照** | 清单 `direct-sync.ts:157-164`；0 断言 `:238`；结构自洽 `:197-211` | 同上；`apps/api/src/import-worker.ts:1682` 是真实调用点，直连车道不经过它——但这只由"本车道没有该调用"推出，非注入验证 | PR6 |
| `move-database-file`（moveDatabaseFile / rename） | 行为级（本车道 0），**无阳性对照** | 清单 `direct-sync.ts:165-172`；0 断言 `:238`；唯一独立证据是 `:255` "主库文件身份必须保持不变（不得 rename/install/move）" | 阳性对照不触达；inode 断言只覆盖 record-only 车道且依赖宿主文件系统语义（`statSync().ino`） | PR6 |
| `forced-wal-truncate`（强制 wal_checkpoint(TRUNCATE)） | 行为级（本车道 0），**无阳性对照** | 清单 `direct-sync.ts:173-180`（`databaseTaskOperation: "checkpoint"`、stage `database_checkpoint`）；0 断言 `:238`；`:242` 断言 `databaseTaskCalls == ["data-only"]` | 仓库内**没有**本条的阳性对照用例。PR1 交付记录 `deliverables/DIRECT_SYNC_PR1_2026-10-12.md:55` 记了一次**手工突变**（"直连车道触发了 §14.1 禁止操作：**forced-wal-truncate**"），那是一次性验证，不是可复跑的测试 | PR4 步骤 2e / PR6 |
| `stage-audit-reports`（stageAuditReports 完整构建） | 行为级（本车道 0），**无阳性对照** | 清单 `direct-sync.ts:181-188`（`databaseTaskOperation: "audit"`、stages `activationAudit`/`final_audit_build`）；0 断言 `:238`；`:242` | 阳性对照不触达（旧链路审计在 CLI 之后）；`apps/api/src/import-worker.ts:248` 是真实调用点 | PR6 |
| `seed-import-generations`（全库补种） | 行为级（本车道 0，**有进程内阳性对照**） | 清单 `direct-sync.ts:189-197`（`storeMethod: "seedImportGenerations"` + `commandSubcommands`）；0 断言 `:247-248`（`guard.storeMethodCalls == []`）；阳性对照 `:360` "§14.1 进程内通道有牙：直接调用被禁的 store 方法会被守卫判红"；真实调用点 `packages/health-export-parser/src/apple-health-parser.ts:396`（仅 `incremental && !preserveAbsent` 才走） | 其它车道同前；此外该条目**依赖真实调用点不被改线**：一旦解析器在 preserve-absent 分支也补种，本车道的 0 断言会红（这正是它的设计目的） | PR4 步骤 2d / PR6 |
| `canonical-nights-full-rebuild`（全表 canonical nights 删除/重建） | **声明的真空**（在直连车道上不构成保证） | 清单 `direct-sync.ts:198-210`，其中 `:208` 原文：`vacuousOnDirectLane: "直连车道不执行任何 canonical 重建；本条目只在旧链路的 CLI 子进程里可观测"`；`:217-223` 断言"真空条目清单"恰为 `["canonical-nights-full-rebuild"]`；真实整表重建仍在 `packages/health-export-parser/src/canonicalize-nights.ts:327`，生产调用点 `packages/health-export-parser/src/cli.ts:394` | 直连车道今天**没有** canonical 执行者，所以"没有全表删除/重建"在该车道上恒真、不构成证据；局部 canonical（`canonicalizeNightsForWindow`）尚未接入 | PR4 步骤 4（`docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md:243`） |

**§14.1 汇总**：十条都有"本车道 0"的行为断言，但**只有 4 条**有阳性对照（前三条 + `seed-import-generations`）；第 10 条是**显式真空**。所有"0"都只覆盖一条车道（有界 record-only 增量）与一个重启场景（`:334`），不覆盖 §14.1 前言列出的首次历史分页、手动同步、自动同步、后台续传、删除-only、混合评分批次与大包分批。

## 2. §14.2 验收矩阵 A01–A18

| 编号 | 现状判定 | 证据（文件:行 / 测试标题原文） | 缺口 | 阻塞于 |
|---|---|---|---|---|
| A01 所有日常数据类型 | 只有结构/源码级证据（record-only 子集为行为级） | 行为级（仅 record-only）：`apps/api/test/direct-sync-prohibited-operations.test.ts:226` "A01/§14.1 逐项：真实排队的 v2 增量不触发任何禁止操作，且主库文件身份不变"；纯函数/白名单级：`apps/api/test/data-only-import.test.ts:88` "bounded data-only policy rejects scoring, workout, unknown, malformed and nested payloads"、`:358` "workout deletions, routes and unknown record types cannot take the fast path"；车道计划 `apps/api/test/direct-sync-plan.test.ts:28` "六个条件全满足才走直连，且直连只可能是 record-only 车道"；未提交 WIP 分类器单测 `packages/health-export-parser/test/direct-sync-payload-class.test.ts:41` "评分清单里的每个类型都判 analysis-required，且原因点名类型"（**未提交**，见 U6） | 心率/睡眠/HRV/RHR/Workout/GPX/混合包**没有一条**"直接写同一主库"的用例：今天它们被入口闸门**拒绝**并回退旧链路（`data-only-import.test.ts:358-371`），`deltaMode` 被钉死 `"record-only"`（`apps/api/test/direct-sync-analysis-registration.test.ts:98`）；"无 §14.1 禁止操作"的 0 断言也因此只对 record-only 成立 | PR4 步骤 2c/2d/2e（`docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md:236-243`） |
| A02 自动同步只取增量 | 部分行为级 | 无变化短路（行为级，真实 `ImportWorker`）：`apps/api/test/import-payload-preflight.test.ts:243` "an import records the payload anchor and the next identical sync skips the whole pipeline"（断言 `commandCount` 不增、无新备份、无 staging、`recomputeReasons == ["payload_identity_unchanged"]`）；负面对照 `:302` "a payload that declares absence-as-deletion never short-circuits"、`:350` "a database that moved since the anchor was recorded disables the short-circuit"、`:387` "a payload whose identity differs still runs the full pipeline"；iOS 纯逻辑：`apps/ios/tests/HealthKitRecordCursorRegression.swift:13` 前置条件原文 `"automatic sync must remain incremental even after \(days) days"`（7/30/365/3650 天） | 没有"连续三轮同步的游标、导出数量、服务端变更数量"这一组证据；"首次无游标只允许分页初始化、不复制主库"在服务端**反向**成立：`apps/api/test/data-only-import-queue.test.ts:177` "the actual candidate pipeline establishes qualification, and the next correction uses the zero-copy lane" 证明首次仍会 `backupCopy` 并发布 | PR4 步骤 2e / PR6；真机部分 §14.5 → **本环境不可达** |
| A03 历史更正与显式删除 | 部分行为级 | 直连车道（行为级）：`apps/api/test/data-only-import.test.ts:212` "deletion before arrival cannot resurrect a carried or later UUID"、`:223` "a deletion-only delta restores a surviving shared UUID and records the correction"（`:225` 用 `HKMetadataKeySyncIdentifier`，即旧 XML 身份键）；解析器级（行为级、非本车道）：`packages/health-export-parser/test/tombstone-deletion.test.ts:176` `` test(`deletion before arrival stays durable via ${deletionKey}`) ``（两种旧身份键）；日期移动只有变更规划器级：`apps/api/test/health-incremental.test.ts:150` "moving a stable record id uses both timestamps and does not trust only the new value" | 直连车道上**没有**"日期移动"的 before/after 断言；"不误删同来源其他事实"只有共享 UUID 一例（`:223`），没有跨来源/跨类型矩阵；alias/source 与账本断言分散在 `:104` 与 `:223`，未形成 §14.2 要求的完整四元组 | PR4 步骤 2d/2e；删除的读侧隐藏属 PR5 |
| A04 本批事务原子性 | 部分行为级 | 17 点故障注入（行为级）：`apps/api/test/data-only-import.test.ts:272` `` test(`${name} failure rolls back every fact, alias, tombstone, ledger and success marker`) ``，触发点清单 `:236-271`（含 `RAISE(IGNORE)`、`AFTER INSERT` 异常改写、迟到篡改）；`:287` "a silently ignored canonical correction cannot be acknowledged with only the UUID fact updated"；`:299` "profile drift rolls back earlier records and returns a no-write fallback"；重启不重放：`direct-sync-prohibited-operations.test.ts:334`；未提交 WIP：`packages/health-export-parser/test/caller-owned-transaction.test.ts:112` "解析器不自提交：commit 之前第二个连接看不到，commit 之后看得到；savepoint 不泄漏"（**未提交**） | §14.2 要求的"代次、任务、回执**同事务**"里，**代次与任务今天没有写入方**：`direct-sync-prohibited-operations.test.ts:264` 断言直连车道跑完 `recompute_jobs` 计数为 **0**，回执 `dependencyGeneration` 为 `null`。因此"任一点抛错 ⇒ 任务/代次一起回滚"无法被注入验证 | PR4 步骤 2d（登记 + 代次写入方） |
| A05 强杀与丢回复 | 已有行为级证据 | `apps/api/test/data-only-import.test.ts:159` "SIGKILL immediately before the receipt write leaves no accepted facts or partial deletion state"（真子进程 `child.kill("SIGKILL")` `:199`，断言"SQLite rolls back the killed transaction"与同批可重试 `:204`）；丢回复：`apps/api/test/data-only-import-queue.test.ts:106` "a reply lost after the real SQLite COMMIT is recovered as success, not reported as failed"；重启：`:127` "restart acknowledges a committed delta whose runtime job was never completed, without reading the missing upload"；带 A-id 的重启用例：`direct-sync-prohibited-operations.test.ts:334` "A05/§14.1 重启后的已 committed 任务从持久回执恢复，且不投递任何数据库任务"；重放不重复应用：`data-only-import.test.ts:143` "a durable same-batch replay performs no writes and refuses a changed payload identity"（`:151` `assert.deepEqual(replay?.summary, first.summary)` + 快照逐字节不变） | 只覆盖 record-only 车道；"返回**原**回执"是同一进程内 `summary` 深等，跨进程重启用例只断言 `readImportReceipt` 存在（`:355`），未做逐字节回执比对；COMMIT **后**立即 SIGKILL（写锁窗口）没有独立用例 | PR4 步骤 2e 复跑；后台续传场景 PR6 / 真机 |
| A06 幂等与负向输入 | 部分行为级 | 重放/冲突（行为级）：`apps/api/test/data-only-import.test.ts:143`（同批重放 `replayed: true`、`payloadSha256` 变更 `/payload changed after admission/`、同 id 不同内容 `/reused with different content/`）；形状兜底（行为级）：`apps/api/test/direct-sync-plan.test.ts:74` "运行期兜底拦住快照语义字段，包括类型挡不住的展开写法"、`:87` "applyDataOnlyImport 在**读取任何文件之前**先做形状校验"；负向资格（行为级）：`data-only-import.test.ts:308` "an incoming non-scoring UUID mapped to a scoring row cannot evade the SQL guards"、`:340` "a stale derivation policy or missing UUID lookup index cannot qualify for data-only" | "**错误作用域**明确拒绝"没有用例；"超出约定限制"只有常量定义（`packages/health-export-parser/src/record-delta-policy.ts:15-16`：`DATA_ONLY_MAX_XML_BYTES = 2 * 1024 * 1024`、`DATA_ONLY_MAX_RECORDS = 5000`）——见 §0.6 的无命中记录，越界夹具不存在 | PR4 步骤 2d/2e |
| A07 分页与持续意图 | 只有结构/源码级证据 | iOS 纯逻辑（真函数、非真机）：`apps/ios/tests/HealthKitRecordCursorRegression.swift:33` `"every page including deletion-only pages is drained"`、`:44` `"partial failure cannot return an advanced cursor"`；游标只随成功事务推进（真库、但只到 store 层）：`apps/ios/tests/SyncStateCommitRegression.swift:243` `"record and workout cursors commit together"`、`:249` `"no task row means record cursors cannot advance either"`、`:266` `"record cursor failure rolls back the entire success transaction"`；接线是**源码文本门禁**：`apps/ios/tests/check-background-capabilities.py:1580` `"the traversal cursor is committed without an in-transaction read-back assertion"`（由 `apps/ios/tests/run-model-tests.sh:87` 执行） | "每页游标仅在**对应持久回执**后推进"没有端到端证据：`HealthKitSync.markSuccess` 的接线不在任何回归的编译范围内（`SyncStateCommitRegression.swift:16-17` 自述"那个文件不被任何回归编译"）；5000 条/2 MiB 预算（`record-delta-policy.ts:15-16`）无测试；后台中断后继续排空的真机/Simulator 记录**不存在** | 真机/Simulator 项 → **本环境不可达**（§14.5）；服务端侧游标推进 PR6 |
| A08 大包和旧任务恢复 | 只有结构/源码级证据 | 表形状：`packages/storage-sqlite/src/v35-migration.ts:51-59`（`import_batch_partitions(parent_batch_id, partition_contract, chunk_index, chunk_hash, status, receipt_json)`）；形状用例 `packages/storage-sqlite/test/direct-sync-migrations.test.ts:85` "v35 建出路线版本与分片表，并给 workout_routes / recompute_jobs 加可空绑定列"（`:104-115` 用裸 `db.exec` 插入分片行，**不是**生产写入方）；回执字段恒空：`direct-sync-prohibited-operations.test.ts:326` `assert.equal(receipt.parentBatchId, null)`；回退旧链路：`data-only-import-queue.test.ts:155` "the rollback flag disables live transactions and restores the existing candidate path" | 见 §0.6：`parentBatchId`/`parent_batch` 在生产源码中**无写入方** ⇒ 分批计划、子批回执、父批状态、断点续传、重启恢复**全都没有实现**，更没有被测试 | PR3 §5.2 / PR4 步骤 2e（`SQLITE_DIRECT_SYNC_PR4_DESIGN.md:241`）；PR6 |
| A09 路线分块与发布 | 部分行为级 | 存储 API（行为级、真库）：`packages/storage-sqlite/test/route-version.test.ts:85` "点数不足的版本发布被拒，且已发布的轨迹与指针一字未动"、`:153` "同一路线复用同一暂存槽位；上一次失败留下的半条点不会拼进新轨迹"、`:184` "被拒的版本只留痕迹：路线状态、指针、已发布轨迹，以及指针指向的那条版本全都不动"；迁移形状 `direct-sync-migrations.test.ts:123` "v35 的路线版本外键与未发布语义：pending 版本不改变 workout_routes 的可见指针"；真实调用点 `packages/health-export-parser/src/gpx-parser.ts:407,437`；客户端分块：`apps/ios/tests/RouteSyncStatePersistenceRegression.swift:115`（"分块边界：跨过 `routeStateChunkSize`（400）必须仍然一个不少"） | 直连车道上**没有**路线：`data-only-import.test.ts:358` 断言带 `workout-routes` 的批次 `return null`（回退旧链路）；"末批完成后原子发布"与"重试不重传已确认分块"没有"直连车道 + 服务端"的联合用例；`route_points` 过渡期双写仍在（PR5 才退役） | PR4 步骤 2c/2e；读侧消费 PR5；真机续传 §14.5 → **本环境不可达** |
| A10 分析失败隔离 | 未覆盖 | 见 §0.6：`analysisStatus` 在测试中只有三类命中——回执断言（`direct-sync-prohibited-operations.test.ts:311`）、源码守卫（`direct-sync-analysis-registration.test.ts:112` 起）、注释。相邻阳性证据只到"消费者能跑通"：`direct-sync-analysis-registration.test.ts:53` "步骤 1：消费者认识 `import`，直连分析载荷会被**真正执行**（不再是 Unsupported）"；中断恢复：`packages/storage-sqlite/test/recompute-job-recovery.test.ts:96` "中断的直连分析任务（同一个 'import' 类型、直连载荷）回到队列，可被消费者重跑" | ①分析故障注入后原回执不变；②`analysisStatus: "failed"` 独立显示；③重试只计算、不重新导出/不备份——三条都无证据。今天登记尚未落地（`recompute_jobs` 计数被断言为 0），连"分析失败"这一状态都产生不出来 | PR4 步骤 2d（登记）+ PR5（读侧状态）；`SQLITE_DIRECT_SYNC_PR4_DESIGN.md:222` |
| A11 后台计算不长期占写锁 | 未覆盖（现有测试证明的是**相反**语义） | 机制单测（真对象、无真实导入/分析）：`apps/api/test/task-admission.test.ts:6` "all heavy workers share the mutation lease, yield fairly, and withdraw on shutdown"（断言各 owner 互斥）；当前生产语义：`apps/api/src/recompute-worker.ts:64` 在 spawn **之前**取许可、`:102-104` 在 `finally` 释放 ⇒ 整轮 drain 持锁；后果被写成注释而非失败断言：`apps/api/test/server-runtime.test.ts:2211-2214` "the recompute worker holds the shared `\"recompute\"` admission lock for the whole worker-thread spawn, and during that window **every write route answers `409 mutation_conflict`**"；空闲早退：`apps/api/test/recompute-worker.test.ts:89` "an idle drain never spawns a worker thread" | §14.2 要求的"CPU 分析期间仍可接收新批次""写锁只覆盖短 SQL 事务""读侧中间态不可见""轻量 API 延迟"**一条都没有**；今天的行为是互斥 + `409`，也没有"仅把旧长事务换到 Worker"的反例守卫 | PR4 步骤 3（短写租约拆分，`SQLITE_DIRECT_SYNC_PR4_DESIGN.md:242`） |
| A12 旧分析与新事实一致性 | 只有结构/源码级证据 | `FactsReader` 真库单测（行为级，但**组件无生产调用方**）：`packages/storage-sqlite/test/facts-reader.test.ts:129` "版本正确性：G=1 读到旧内容、G=5 读到新内容，都不返回混合结果"、`:187` "边界（刻意限定）：被删除的实体在任何代次下都不可见"；无调用方的证据：`openFactsReader` 在生产源码中只出现在 `packages/storage-sqlite/src/index.ts:140`（导出）与注释（`packages/application/src/services/recompute-pipeline.ts:445`）；直连分析今天等价于全量重算：同文件 `:449-451` `runDirectSyncAnalysis(job) { this.runFullRecompute(job); }`；旧 release 仍可读只被顺带断言：`direct-sync-analysis-registration.test.ts:73-74` | 没有"旧 release 不混入新 workout/route"的读侧集成用例；没有"删除不泄露旧『当前』训练"；"待分析数据/过期处方准确标记"无实现、无测试；也没有桌面/iOS 状态截图（`apps/ios/design/acceptance/*` 目录日期均为 2026-09-09…09-19，早于本设计，未逐张查看 → U1） | PR4 步骤 2d（代次绑定）+ PR5（读侧一致性） |
| A13 发布竞争与持续更新 | 部分行为级 | 覆盖变化拒绝发布（行为级，真库 + 真 `runNextJob`）：`packages/application/test/service.test.ts:241` "freezes overrides during extraction but refuses to publish after a concurrent revision change"（断言 `completed?.status === "failed"`、`/overrides changed/i`、`active_model_run`/`active_model_release` 指针停在旧 release）；不合格候选拒绝：`packages/storage-sqlite/test/model-release-v2.test.ts:48` "S01: v23 releases atomically publish/rollback and reject failed, stale and changed snapshots"；绑定列只写不比：`packages/storage-sqlite/src/recompute-job-repository.ts:63-65` | "迟到任务不倒退 active 版本"目前靠 `activateSucceeded` 的业务 gate（status/dataset 校验），而 §14.2 指定的 `expected_incumbent_release_id` 比较**没有实现**（见 §0.6：列存在、可写、无消费者）；"新数据持续到达仍有已计算结果可读"无并发用例 | PR4 步骤 2d（绑定 + 比较）+ PR5 |
| A14 旧数据与兼容升级 | 部分行为级 | 资格 stamp（行为级）：`apps/api/test/data-only-import.test.ts:340` "a stale derivation policy or missing UUID lookup index cannot qualify for data-only"、`:322` "missing/old parser attestation and uninitialized legacy hashes use the normal path without writes"；首次资格建立：`data-only-import-queue.test.ts:177`（同一用例断言 `backupCopy > 0` 与下一次 `dataOnlyApply > 0`）；迁移补丁：`packages/storage-sqlite/test/direct-sync-migrations.test.ts:158` "老库补迁移：数据一行不少，且补完后 refuse 模式才放行"；客户端升级保留 pending task：`apps/ios/tests/SyncTaskMigrationRegression.swift:18-24`（`legacyPayloadDecodesWithNewFieldsNil` / `legacyMinimalPayloadDecodes` / `legacyRecomputingMigratesToImporting` 等 7 条，手工写的旧 payload 字面量）；游标序列化 `HealthKitRecordCursorRegression.swift:21` `"all per-type cursors survive pending-batch serialization"`；代次口径：`packages/health-export-parser/test/generation-seeding-pairing.test.ts:53` "增量（preserve-absent）不补种：未被载荷触及的实体不会凭空得到代次行" | "旧内容 hash 不导致首次整库候选"没有直连车道用例（`SEED_CONTENT_HASH` 在测试中无命中，见 §0.6；其分支在 `apple-health-parser.ts:585` 与 `storage-sqlite/src/database.ts:3194`）；"手机升级保留有效游标"只有本机纯逻辑/解码回归，无真机升级记录 | PR4 步骤 2e/2d；真机升级记录 §14.5 → **本环境不可达** |
| A15 项目完全退出备份 | 只有结构/源码级证据 | 直连车道（行为级）：`direct-sync-prohibited-operations.test.ts:252-254`（`var/` 无 `backups|rai.importing`）、`:293-294`（阳性对照里旧路径**确实**留下 `var/backups`）；入口级单点（行为级）：`packages/storage-sqlite/test/transaction-owner.test.ts:54` "caller 模式默认 refuse：空库不被自动迁移，也不创建项目备份"；默认值源码：`packages/storage-sqlite/src/database.ts:1842`（caller 模式默认 `false`，非 caller 默认 `true`） | **全局判据不成立**：升级脚本仍调用备份（`deploy/upgrade.sh:83-85`，`curl ... -X POST .../v1/backups`），服务端入口仍在（`apps/api/src/server.ts:1912` `app.get("/v1/backups")`、`:1914` `app.post`），维护/恢复入口被大量正向测试（`apps/api/test/maintenance.test.ts:28` "creates an online backup containing committed WAL data and lists it"），Web 设置页仍展示备份（`apps/web/test/settings-database.test.tsx:85` "identifies a readable database preservation as a recoverable backup"） | PR6（`docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md:208-209` 明确列在 PR6） |
| A16 正常持久性与数据库故障 | 部分行为级 | 外键/约束：`apps/api/test/data-only-import.test.ts:137` `assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [])`、`packages/storage-sqlite/src/database.ts:1807`（`PRAGMA foreign_keys = ON`）；WAL 与 synchronous 源码：`database.ts:1808-1821`（`journal_mode = WAL` 回读校验；`transactionOwner="caller"` 拒绝 `synchronous=OFF`）、`apps/api/src/data-only-import.ts:143` `db.exec("PRAGMA synchronous=FULL")`；corruption：`apps/api/test/server-runtime.test.ts:598` "HTTP restore remains available when the active database is corrupt at startup"（断言 `status === "recovery_required"`、`databaseReady === false`、`assert.deepEqual(readFileSync(databasePath), corruptBytes)`）与 `:811` "database-backed writes cannot recreate a deleted database"（409 `database_not_ready` 且 `existsSync(databasePath) === false`）；外键故障门禁 `:911` | **没有**测试断言直连车道跑在 `synchronous=FULL` 下（该 PRAGMA 只有源码行，无回读断言）；EIO 未模拟；"corruption ⇒ 暂停写入"只在 API 启动路径被证明，`applyDataOnlyImport` 遇 corruption 的行为未被注入验证 | PR4 步骤 2e（车道内持久性断言）；PR6 |
| A17 客户端状态和领域语义 | 部分行为级 | 回执两字段分离（行为级）：`direct-sync-prohibited-operations.test.ts:299` "A17/§10.1 直连回执把「原始已保存」与「分析已更新」分成两个字段，且与持久回执一致"（`:329` 与磁盘持久回执深等）；契约：`packages/contracts/src/direct-sync.ts:21-31`（两套独立枚举）、`:39-50`（回执字段）；消费者侧准入：`direct-sync-analysis-registration.test.ts:78` "步骤 1 的边界：CLI 载荷被消费者**拒绝**，且不会跑分析（原因说清，不是 Unsupported）"；评分/gate 回归由 `packages/application/test/service.test.ts` 与 `model-transition-gate.test.ts` 覆盖 | "raw COMMIT 后可显示『已保存，分析更新中』"没有文案或状态断言（iOS 相近文案 `apps/ios/RAI/NativeAppModel.swift:1697` "反馈已保存；分析稍后更新。" 说的是反馈，不是直连同步）；"不再显示备份/临时库/换库阶段"没有 UI/协议用例；没有 §14.2 要求的"文案/状态截图" | PR6（客户端状态与文案） |
| A18 改动范围与迁移 | 只有结构/源码级证据 | 迁移 checksum（行为级）：`packages/storage-sqlite/test/migration-policy.test.ts:143` "every migration has a frozen checksum"、`:151` "frozen checksums still match the transpiled source they were pinned to"（`:154-158` 的失败文案点名"要么某个历史迁移的 up 被改过"）；冲突选项拒绝：`transaction-owner.test.ts:75` "caller 模式拒绝与之冲突的显式选项，而不是静默忽略" | "不新增 PostgreSQL/Redis"**没有测试**（见 §0.6：依赖声明无命中，但无门禁在守）；"冻结的窄屏 Web 不修改"没有自动化判据（AGENTS.md 明令不跑响应式 E2E，只能靠 diff 评审）；"桌面回归报告"无当日证据 | PR6（diff/依赖评审 + 桌面回归）；桌面回归报告部分 **本环境不可达** |

**§14.2 汇总**：`已有行为级证据` **1** 项（A05）；`部分行为级` **9** 项（A02、A03、A04、A06、A09、A13、A14、A16、A17）；`只有结构/源码级证据` **6** 项（A01、A07、A08、A12、A15、A18）；`未覆盖` **2** 项（A10、A11）。**没有任何一项**是 `只有断言/文档` —— 每一行都至少有源码级或测试级证据。

## 3. 标题携带 A-id 的测试文件（全集）

只有一个文件，共 5 条标题、3 个 A-id：

- `apps/api/test/direct-sync-prohibited-operations.test.ts`
  - **A01** ×3：`:189` "A01/§14.1 清单本身自洽：每条都声明了可观测通道，且通道名在真实实现上存在"、`:226` "A01/§14.1 逐项：真实排队的 v2 增量不触发任何禁止操作，且主库文件身份不变"、`:271` "A01/§14.1 阳性对照：旧候选路径确实会触发守卫，所以上一条的「全 0」不是假绿"
  - **A05** ×1：`:334` "A05/§14.1 重启后的已 committed 任务从持久回执恢复，且不投递任何数据库任务"
  - **A17** ×1：`:299` "A17/§10.1 直连回执把「原始已保存」与「分析已更新」分成两个字段，且与持久回执一致"

其余 15 个 A-id（A02、A03、A04、A06–A16、A18）在 `apps/**`、`packages/**`、`scripts/**` 的**任何**测试标题中都不出现（§0.2 搜索无命中）。本报告对它们的证据全部来自 §0.4 的属性搜索，判定按 §0.5 口径给出。

## 4. 与 `scripts/check-acceptance-matrix.mts` 的关系（两张矩阵，不要混）

- `scripts/check-acceptance-matrix.mts` 只解析 `docs/ALGORITHM.md` 的 **§16.1**：矩阵切片 `:58-64`，ID 抽取 `:65`（形如 `[A-Z]\d{2}`），只在**测试标题**里找同形 ID 判定 `cited`（`:91-105`）。`KNOWN_GAPS` 表当前为空（`:47-58` 的注释与 `const KNOWN_GAPS: Record<string, string> = {}`）。
- **§16.1 的 ID 集合不含 A 开头**：实测其表格 ID 为 B/C/D/F/G/I/L/M/N/P/R/S/T/V/Y/Z 各组。因此 A01/A05/A17 的标题虽然会被 `citedIdsIn` 采集进 `citedSet`，但 `:105` 的循环只遍历 **§16.1 矩阵的 id**，两者不会互相污染，也不会产生 missing/stale。
- 未发现任何"把 §14.2 当成 §16.1"的实际混淆：`deliverables/DIRECT_SYNC_PR1_2026-10-12.md:111` 与 `:115` 明确写着"§14.2 的 A01–A18 矩阵**尚未**接入 `scripts/check-acceptance-matrix.mts`（它目前只解析 `docs/ALGORITHM.md` §16.1）"。
- 结论：**§14.2 今天没有任何机械化覆盖门禁**；18 项里 15 项连"标题引用"都没有，而"没引用"与"没覆盖"在这张矩阵上目前无法被机器区分。

## 5. 未决问题（未核实项）

- **U1（未核实）**：§14.2 的"必须留存的证据"里有若干是**非测试产物**（截图、桌面回归报告、SQL/文件操作追踪、性能原始样本）。我只检查了 `apps/ios/design/acceptance/` 的**目录名与日期**（2026-09-09…09-19，早于直连设计 10-12），**没有逐张查看图片内容**，也没有找到针对直连同步的截图或回归报告目录。A12、A17、A18 的相关判定以"测试标题与源码"为准。
- **U2（未核实）**：A15 的"归档清单前后对比"没有任何现存产物；`apps/api/test/maintenance.test.ts`（`backup` 命中 25 处）与 `apps/web/test/settings-database.test.tsx`（14 处）我只读了标题与部分片段，未逐条判定哪些属于"正常同步路径"、哪些属于显式维护入口。
- **U3（未核实）**：A11 的"轻量 API 延迟"与 §14.3 P01–P06 同类，需要目标云机与 200 个有效样本；`docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md:370`（§9 未决 5）明确"**本环境给不了**：§14.3 P01–P06（需目标云机）、§14.5 真机 HealthKit 验收"。本报告**不宣称**任何 P 项达标。
- **U4（未核实）**：canonical 窗口外逐字节不变有组件级证据（`packages/health-export-parser/test/canonicalize-nights-window.test.ts:280` "rows outside the window are left byte-identical, including computed_at"），但**没有**"直连车道在接收事务里调用它"的链路证据（PR4 步骤 4 未动工）。
- **U5（未核实）**：§14.1 要求"还要记录 SQL、任务阶段和文件操作，确认没有等价的整库复制、扫描或替换"。今天的守卫只有函数名 / 任务类型 / stage 名 / 目录名 / inode 五个通道，**没有 SQL 追踪**；因此"等价的整库扫描"（例如一条扫全表的 `SELECT`）在机制上不可观测。这不是某个条目的缺口，而是 §14.1 判据本身的缺口，未在任何文档中被声明。
- **U6（重要：取证时仍在变化）**：工作树在本次侦察期间被并发修改。`2026-10-13T02:25+08:00` 的 `git status --porcelain` 为：`M apps/api/src/health-change-plan.ts`、`M packages/contracts/src/index.ts`、`M packages/health-export-parser/src/apple-health-parser.ts`、`M packages/health-export-parser/src/index.ts`、`M packages/health-export-parser/src/record-delta-policy.ts`、`?? packages/health-export-parser/test/caller-owned-transaction.test.ts`、`?? packages/health-export-parser/test/direct-sync-payload-class.test.ts`。这两个新测试文件**未被 commit**，但位于 `packages/*/test/`，而 `scripts/run-tests.mjs:12-17` 的发现规则会**包含**它们（编译通过即在 `npm test` 里运行）。本报告凡引用它们处均标"未提交"⇒ A01/A04 的判定在 PR4 步骤 2a/2b 提交后会**上升**，请以提交后的复跑为准。
- **U7（未核实）**：A03 在**旧候选链路**（非直连车道）上的共享 UUID / 删除-only 行为我没有盘点；`packages/health-export-parser/test/raw-incremental.test.ts`（12 条）与 `healthkit-record-sync.test.ts`（`tombstone` 命中 16 处）只读了标题。
- **U8（未核实）**：`apps/api/test/worker.test.ts`（`backup` 命中 36 处，2900+ 行）里是否存在"正常同步不创建备份"的既有断言，我只做了计数与抽样，**未逐条读完**。
- **U9（方法边界）**：本报告**未运行任何测试**，所有"行为级"判定来自读取测试源码中的断言，不是执行结果。当前工作树上测试是否真绿，需要按 `docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md:249-301`（§8 的实测口径）复跑 `RAI_TEST_CONCURRENCY=1 node scripts/run-tests.mjs`。
- **U10（未核实）**：§14.5 的发布检查清单里"迁移在隔离库演练通过""`npm run typecheck` / `npm test` / `npm run build` 通过""`npm run test:ios` 确实检查源文件"这几条属于**当日执行结果**，不是代码事实；我没有运行它们，只在代码里确认了入口存在（`package.json:37-42`、`apps/ios/tests/run-ios-gates.sh`）。
