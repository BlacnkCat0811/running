# RAI 全项目深度审查 · Lane 1：数据管线 / 存储 / 发布 / Rust 执行器

- 审查对象：git `24aa7d8`（工作树干净，HEAD diff `09ed8d0..HEAD` 为本轮回归重点）
- 范围：`packages/health-export-parser`、`packages/storage-sqlite`、`packages/application`（recompute/publication）、`apps/api/src/import-*` / `direct-sync-*` / `dataset-epoch.ts` / `data.ts` / `maintenance.ts`、`crates/rai-data-worker`、以及 `docs/DATA_PIPELINE.md` / `docs/SQLITE_DIRECT_SYNC_*.md` 的设计—实现对照
- 方式：只读。未修改任何 git 跟踪文件，未读写 `var/` 下真实数据库/健康数据/备份；合成探针全部在 `/tmp` 与 `mkdtemp` 临时库
- 时间：2026-10-18

## 0. 结论摘要

| 严重度 | 数量 | 标题 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 2 | L1-01 无 sample UUID 的记录在 `preserveAbsent` 增量下“值更正 → 重复事实”（已复现）<br>L1-02 `/v1/mobile/today`、`/v1/mobile/workout-plan` 的 control/main 混读未纳入 publication guard（代码推断） |
| P3 | 5 | L1-03 guard 读取失败时读侧静默降级为 digest-only（fail-open 降级）<br>L1-04 本进程发布事务内完全关闭 guard（含 epoch 检测），对外来 in-flight 发布者存在理论盲区<br>L1-05 parity 测试的 `unchanged` 三态未被真正断言；缺 Rust 二进制时该文件静默 skip<br>L1-06 `trainingPlanState` 把主库 mtime 变化直接 503 抛出（同函数其余检查都重试）<br>L1-07 R1–R3 边界探针不在 CI/`npm test` 门禁内；裸 `node` 运行会 `ERR_MODULE_NOT_FOUND` |

**总体判断**：Lane 1 的实现质量显著高于一般“待审”状态。核心正确性机制（caller-owned 事务 + 提交前回读断言、直连写守卫的 fail-closed 表分类、软删可见性判据单点化、迁移 checksum 冻结、Rust staging permit + `.importing.<uuid>` 后缀）都成立，并且有真实的负向测试兜住；HEAD 刚修的 TS↔Rust 增量账本 before 侧 parity **经我独立复现确认已修复且测试不是假绿**。未发现 P0/P1：没有找到能造成已发布数据丢失、绕过发布 gate 写主库、或半批提交的路径。两个 P2 分别落在“无 UUID 记录的更正语义”和“legacy 读路由未复用新 guard”，都不是数据丢失级。

## 1. 范围与方法

### 1.1 读了什么（重点）

| 模块 | 文件 |
|---|---|
| parser | `apple-health-parser.ts`（record/workout 身份、`shouldWrite`、观察账本）、`identity-algorithm.ts`、`canonicalize.ts`（`workoutPresentConditionSql` 使用、session 失活）、`record-delta-policy.ts`、`utils.ts`（`stableId`）、`sync-manifest.ts` |
| storage | `database.ts`（迁移 runner/冻结 checksum、`observeImportEntity`、软删、删除账本、`removeWorkoutsBySyncIdentifiers`、caller 事务）、`v36–v45`、`sql/fragments.ts`、`read/*`（workout/series/trends/fact-read-view/route-point-reader/audit）、`publication-lock.ts`、`database-file-publisher.ts`、`model-transition-gate.ts`、`model-release-repository.ts` |
| application | `services/recompute-pipeline.ts`（N+1/循环内 prepare 扫描）、`services/analysis-fact-view.ts`（会话口径）、`service.ts` |
| API | `data.ts`（`trainingPlanState`/`factAnalysisBlocks`/缓存）、`direct-sync-ingest.ts`（整个事务 + 提交前断言）、`data-only-import.ts`、`import-worker.ts`（activate/rollback）、`maintenance.ts`（backup/restore）、`dataset-epoch.ts`、`publication-guard.ts`、`plan-read-consistency.ts`、`server.ts`（`/v1/mobile/*` 读路由、guard 接线）、`mobile-goals.ts`（guard 事务）、`import-equivalence.ts`、`import-payload-identity.ts`、`import-sources.ts` |
| Rust | `crates/rai-data-worker/src/main.rs`（`apply_records` 全量、`run()` 打开模式/后缀校验、写许可）、`docs/RUST_DATA_ENGINE.md` |
| 设计对照 | `docs/DATA_PIPELINE.md`、`docs/SQLITE_DIRECT_SYNC_DESIGN.md`、`docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md`、`docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md`、`docs/RUST_DATA_ENGINE.md` |
| 既有审查 | `docs/PROJECT_REVIEW.md`、`deliverables/training-plan-review-2026-10-18/*`、`deliverables/DIRECT_SYNC_*` / `INGEST_PERSIST_CHAIN_REVIEW` / `SYNC_DATA_PIPELINE_AUDIT`（作为上下文，已修结论不重复报告） |

### 1.2 跑了什么（定向，未跑全量）

| 命令 | 结果 |
|---|---|
| `RAI_TEST_CONCURRENCY=1 RAI_REQUIRE_RUST_TESTS=1 node --import tsx --test packages/health-export-parser/test/native-worker.test.ts` | **8 tests / 8 pass / 0 skip**（含 TS↔Rust 等价性、permit 拒绝、取消/资源上限） |
| 同模式跑 10 个定向文件（migration-policy / publication-lock / connection-contention / direct-sync-migrations / model-transition-gate / transaction-owner / tombstone-deletion / identity-algorithm / direct-sync-payload-class / caller-owned-transaction） | **83 pass / 0 fail / 0 skip**（8.6 s） |
| `RAI_TEST_CONCURRENCY=1 node --import tsx --test apps/api/test/plan-read-consistency.test.ts` | **15 pass / 0 fail**（含 guard 悬而未决→fail-closed、stale marker、read amplification p95） |
| `npx tsx scripts/review-model-boundaries.mts --out /tmp/rai-boundaries.json` | `violationCount: 0`（R1/R2/R3 均 `violation:false`） |
| `/tmp/probe-parity-sensitivity2.mts`（合成库负向控制） | 证明 `importEquivalence` 对 `previous_type` 变 NULL 敏感 ⇒ parity 测试能抓住 R7 回归形状 |
| `/tmp/probe-record-correction.mts`（合成库） | 复现 L1-01：值更正后同时间窗出现两条 record 行，旧行无 removed 账目 |

### 1.3 没做什么（未验证边界）

- **没有**重复跑全量 `npm test`（Lead 在后台跑）与 `node scripts/rust-worker.mjs verify` 的 `cargo test` 部分（只跑了它包装的两个 TS 测试文件；`target/release/rai-data-worker` 存在于 11:39，晚于 `main.rs` 的 11:38 mtime，确认二进制包含 HEAD 前一提交的 parity 修复）。
- **没有**跑多进程 guard 压力测试 `apps/api/test/plan-publication-stress.test.ts`（Lead 全量套件覆盖；我读了它的测试名与断言结构）。
- **没有**对真实 `var/rai-dev.sqlite`（325 MB）做任何迁移/备份/恢复演练，也没有在真实 iOS 上传包上跑双引擎等价性；所有结论基于合成夹具。
- **没有**验证"第二个 API 进程并发发布"场景（L1-04 因此标为代码推断）。
- 没有审查 iOS/算法/文档 lane（由其他 lane 负责）；`recompute-pipeline.ts` 只做了 N+1/循环内 prepare 的启发式扫描与关键读法抽查，未逐行审 4397 行。

## 2. 发现清单

| ID | 严重度 | 标题 | 位置 | 证据等级 |
|---|---|---|---|---|
| L1-01 | P2 | 无 sample UUID 的记录“值更正”在 `preserveAbsent` 增量下留下旧行 ⇒ 同一时间窗重复事实，且账本无 `removed` | `packages/health-export-parser/src/apple-health-parser.ts:221-228`（record id 含 value/unit）、`:599-600`（shouldWrite）、`packages/storage-sqlite/src/database.ts:3510-3586`（仅完整载荷删除陈旧实体） | 已复现（合成探针 `/tmp/probe-record-correction.mts`） |
| L1-02 | P2 | `/v1/mobile/today`、`/v1/mobile/workout-plan` 先读 control 再开主库读事务，未使用 publication guard/稳定快照；HEAD 的 guard 只接了 `training-plan-state` 与 coach-loop | `apps/api/src/server.ts:1381-1387`、`:1408-1412`；对照 `apps/api/src/data.ts:541`、`apps/api/src/coach-loop-runtime.ts:96`、`apps/api/src/plan-read-consistency.ts:96-118` | 代码阅读推断 |
| L1-03 | P3 | guard 读取抛错时 `readSnapshotGuardSafe` 返回 `null`，跨库检查整体跳过（fail-open 降级）；注释/测试把它当既定契约 | `apps/api/src/plan-read-consistency.ts:88-97`、`apps/api/test/plan-read-consistency.test.ts:160` | 代码阅读 + 测试名确认 |
| L1-04 | P3 | 本进程处于自己发布事务时 `planReadGuard` 返回 `undefined`（不是“只隐藏自己的 marker”），epoch 检测一并关闭；外来发布者若已提交 marker 且已换主库，可形成盲区 | `apps/api/src/plan-read-consistency.ts:55-86`、`apps/api/src/mobile-goals.ts:325-343`、`apps/api/src/publication-guard.ts:10-18` | 代码阅读推断 |
| L1-05 | P3 | TS↔Rust parity 测试的第三次解析（`unchanged` 态）不带 `batchId` ⇒ 两引擎都不写账本，"未变更不误报 updated" 实际未被断言；缺二进制时整个文件静默 skip（本地默认 `npm test`） | `packages/health-export-parser/test/native-worker.test.ts:15-16`、`:99-105` | 代码阅读 + 已跑测试 |
| L1-06 | P3 | `trainingPlanState` 把主库 `mtimeMs` 变化直接抛 503，而同一函数的 inode/guard/data_version 检查都走重试（`continue`）；WAL checkpoint 会改主库 mtime（`read-store-manager.ts` 自己的注释承认这点） | `apps/api/src/data.ts:646-648`；`apps/api/src/read-store-manager.ts:82-93` | 代码阅读推断 |
| L1-07 | P3 | `review:model-boundaries`（R1–R3）不在 CI、不在 `npm test`；且它需要 tsx，任务建议的裸 `node scripts/review-model-boundaries.mts` 直接 `ERR_MODULE_NOT_FOUND`（注意：经 shell 管道会得到 exit 0 的假象） | `package.json` 的 `review:model-boundaries`；`.github/workflows/ci.yml`（无该步骤）；`docs/PROJECT_REVIEW.md:62-65` | 已运行（失败/成功两种方式都试过） |

## 3. 详情

### L1-01（P2）无 UUID 记录的“值更正”在增量下重复，且账本没有 removed

**证据**

1. record 的身份（无 `HKMetadataKeySyncIdentifier`、无 sample UUID 时）把 `value`/`unit` 折进 id：
```ts
// packages/health-export-parser/src/apple-health-parser.ts:221-228
const id = syncIdentifier
  ? stableId("record", [type, sourceName, syncIdentifier])
  : stableId("record", [type, sourceName, startAt, endAt, attributes.value ?? null, attributes.unit ?? null]);
```
2. 增量写入判定只看 `exists/updated`，`preserveAbsent` 下**不删除**载荷缺席的旧实体：
```ts
// apple-health-parser.ts:598-600
const shouldWrite = !observation.tombstoned
  && (!options.incremental || observation.inserted || observation.updated);
```
```ts
// packages/storage-sqlite/src/database.ts:3508-3513（applyManifestDeletions 前置注释）
// Reaching this branch means the payload declared itself a complete snapshot. ...
```
3. 合成探针（`/tmp/probe-record-correction.mts`，临时库，同一 XML 只把 `value="2000"` 改成 `"2100"`，第二次以 `incremental + preserveAbsent` 解析）：
```
RECORDS [{"id":"record_9e9b...","v":2000},{"id":"record_d2b6...","v":2100}]
LEDGER  [{"entity_id":"record_d2b6...","change_type":"inserted"}]
```
旧行仍在、账本只有 `inserted` 一条（没有 `removed`，也没有 `updated`）。

**影响**

- 同类型、同来源、同 `start/end` 的两条互相矛盾的样本同时留在 `health_records`；分析/特征按"所有记录"读取，会把这段窗口双计（步数、能量、心率样本等）。
- 账本/墓碑都没有记录这次"替换"，所以 `import_entity_changes` 驱动的脏范围不会覆盖旧行；重算后旧值仍会被算进去。
- **可达性受限，需明确**：两条生产车道（`direct-sync-ingest.ts`、`data-only-import.ts`）都传 `healthKitRecordIdentity: true`，而该模式下 `apple-health-parser.ts:540-545` 对缺 `RAIHealthKitSampleUUID` 的记录**直接抛错**，所以 iOS 上行链路不会命中；命中的是 CLI 侧的 legacy 增量语义（`packages/health-export-parser/src/cli.ts:363-366`，默认 `preserveAbsent: true`，README 未把它列为常规运维入口）。

**建议**（任一即可，别把冻结值当修法）

1. 增量 legacy 路径对"同 type/source/start/end、仅内容不同"的旧身份做显式 supersede（账本写 `removed` + 墓碑），或
2. 明确把该能力限定在 `healthKitRecordIdentity`（要求 sample UUID），CLI incremental 入口对无 UUID 导出**拒绝**并提示改用完整重建，或
3. 若判定为可接受的设计边界，写进 `docs/DATA_PIPELINE.md §2` 并在 `audit` 里输出"同窗重复 record"计数，让运维看得见。

### L1-02（P2）legacy 移动读路由仍混读 control 与 main 快照

**证据**

```ts
// apps/api/src/server.ts:1381-1387
app.get("/v1/mobile/today", async () => {
  // Goals live in a plain file and do not depend on database readiness.
  const goals = mobileGoalsStore.read();
  return withReadStore((store) => store.mobileTodayWithViews(goals, mobileGoalsStore.planHistory(200)));
});
```
```ts
// apps/api/src/server.ts:1408-1412
app.get("/v1/mobile/workout-plan", async () => {
  const goals = mobileGoalsStore.read();
  return withReadStore((store) => store.mobileWorkoutPlan(goals));
});
```

`goals`/`planHistory` 在 control 库上各自 autocommit 读取（`mobileGoalsStore.read()` / `planHistory()`），随后 `withReadStore` 才在主库开 `BEGIN DEFERRED`。两次读之间可以落一次 plan 发布（control 写）或一次导入发布（主库换文件）。HEAD 新加的跨库 guard + 稳定快照只出现在两条路径：

```ts
// apps/api/src/data.ts:541（training-plan-state）
const readGuard = planReadGuard(store as unknown as PublicationGuardCapableStore);
// apps/api/src/coach-loop-runtime.ts:96（coach-loop 读）
const readGuard = planReadGuard(this.store as unknown as PublicationGuardCapableStore);
```

`plan-read-consistency.ts:96-118` 明确写了这类混读的后果（"iOS schedules that response directly, so the mixed snapshot must fail closed instead of being returned"），但 `/mobile/today` 的响应同样被 iOS 直接排期，且没有任何 digest/guard 复核。iOS 侧这条 legacy 路径是**活代码**：`aggregateContract = handshake?.planSnapshotContractVersion != nil`（`apps/ios/RAI/TrainingPlanStore.swift:231`），为假时走 `api.mobileToday()` / `api.mobileWorkoutPlan()`（`apps/ios/RAI/APIClient.swift:151,192`）；服务端只在非 coach-loop 数据集上下发该能力（`apps/api/src/server.ts:959`），所以 coach-loop 未接管（或尚未初始化）的数据集正好命中。

**影响**：响应可能出现"旧 revision 的周计划 + 新事实快照"（completed/adherence 用新事实判定），与 C1/P2-2 要挡的形态同类；`mobileToday` 的 `weekPlan`/`completedWorkoutId` 混用会让客户端按旧计划打卡。属于**非致命、可被下一次刷新纠正**的用户可见不一致，且只在导入/发布窗口内出现。

**建议**：把这两条路由的 control 读取搬进 `readStableSnapshot`（`plan-read-consistency.ts:119` 已有现成入口），`readControl` 返回 `{goals, history}`、`build` 里调 `mobileTodayWithViews`/`mobileWorkoutPlan`，`changedError` 复用 `PlanOperationError("plan_snapshot_changed", …, 503)`；若判定 legacy 路由不值得，就在 `docs/DATA_PIPELINE.md §7` 明确写出这一例外，避免下次审查再次当成缺陷。

### L1-03（P3）guard 读失败静默降级（fail-open）

```ts
// apps/api/src/plan-read-consistency.ts:88-97
export function readSnapshotGuardSafe(readGuard: ...): PublicationGuardState | null {
  if (!readGuard) return null;
  try { return readGuard(); } catch { return null; }
}
```
`readStableSnapshot` 与 `trainingPlanState` 都只在 `guardBefore !== null && guardAfter !== null` 时比较 guard（`plan-read-consistency.ts:145-147`、`data.ts:649-651`）。因此"guard 表坏了/读不到"等于**静默回到 pre-guard 行为**，而注释和 `apps/api/test/plan-read-consistency.test.ts:160` 把这条降级写成了既定契约。实际风险被两层兜住（control 库不可读时 `store.read()` 通常同样失败；同连接的 SQLite 读错误罕见），因此定 P3。

**建议**：若希望"fail-closed"名副其实，guard 读失败时应记录一次可观测计数/日志（现在完全静默），并在设计文档里声明这是"可用性优先于跨库原子性"的显式取舍。

### L1-04（P3）本进程发布事务内 guard 完全关闭，而非只隐藏自己的 marker

`MobileGoalsStore.publicationGuardState()` 在本进程发布事务内返回 `{epoch, pendingSince: null}`（保留 epoch、只隐藏自己的 pending，`mobile-goals.ts:325-343`），但 `planReadGuard()` 在 `publicationInFlight()` 时直接返回 `undefined`：

```ts
// apps/api/src/plan-read-consistency.ts:77-85
const publishing = typeof store.publicationInFlight === "function"
  ? store.publicationInFlight() === true
  : store.publicationTransaction === true;
return publishing ? undefined : readGuard;
```

后果：`/v1/mobile/workout-plan/synced` 在 `withPublicationTransaction` 内调 `trainingPlanState` 时，epoch 比较也一起消失。注释里的安全论证是"another writer is either blocked on `BEGIN IMMEDIATE`, or it marked pending before this transaction and cannot write the main database while this control write lock is held"（`mobile-goals.ts:328-342`）。后半句对**发布协议本身**不成立：发布者先提交 marker、再写主库、最后才取 control 写锁（`publication-guard.ts:16-18` 的顺序），所以一个已 in-flight 的外来发布者完全可能"已换主库、尚未取 control 锁"。此时本进程若在发布事务内读主库，会读到外来新事实 + 本地旧 control，且没有 epoch 检测可用。

触发前提是**第二个发布进程**（CLI 或第二个 API 实例）与本地发布事务重叠；生产是单进程 API，因此定 P3 并标"代码推断，未复现"。

**建议**：`planReadGuard` 改为返回 `publicationGuardState` 的掩码读取器（保留 epoch 比较），或在该路径的读法上把"外来 in-flight"检测做成显式不可能（例如发布事务内禁止跨库读，只读 control）。

### L1-05（P3）parity 测试对 `unchanged` 态是弱覆盖；缺二进制静默 skip

```ts
// packages/health-export-parser/test/native-worker.test.ts:15-16
const available = existsSync(nativeBinary());
if (process.env.RAI_REQUIRE_RUST_TESTS === "1" && !available) throw new Error(...);
// 全部 test 用 { skip: !available }
```
```ts
// :99-105 第三次解析：没有任何 batchId
incremental: { generation: "repeat", preserveAbsent: true }
```
第三次解析（"未变更"）不带 `batchId`，两引擎按 `if (batchId && …)` 都不写 `import_entity_changes`，`health_records` 也不会被 upsert——于是"未变更时不得误报 updated/不得多写"这件事**没有任何断言**能看见。三态里 `inserted`/`updated` 是实测覆盖的（第二次解析的 fixture 用 `HKMetadataKeySyncIdentifier` 保证 id 稳定、`value` 变化 ⇒ `updated`；我用探针确认 TS 侧该行 `previous_effective_at/previous_end_at/previous_type` 三列有值，且把 `previous_type` 置 NULL 会让 `importEquivalence` 摘要改变，因此 R7 回归形状确实会被测试抓住——这一条**不是**假绿）。

另外：本机 `npm test`（未设 `RAI_REQUIRE_RUST_TESTS=1`）在缺 `target/release/rai-data-worker` 时会把整个文件 skip，而 CI 由独立 job 先 `cargo build` 再 `npm run rust:verify`，所以门禁层面不丢；只是本地/纯 Node 环境的"绿"不代表 parity 被验证过。

**建议**：`unchanged` 态补一个带 `batchId`、同内容重复解析的断言（`import_entity_changes` 该批 0 行、`health_records` 内容 hash 不变）；`npm test` 对 `native-worker.test.ts` 的 skip 打一行显式提示（AGENTS.md 要求的 "skip loudly"）。

### L1-06（P3）plan-state 读把 mtime 变化当致命错误

```ts
// apps/api/src/data.ts:646-648
if (fileIdentity.ino !== currentFile.ino || fileIdentity.mtimeMs !== currentFile.mtimeMs) {
  throw new PlanOperationError("plan_snapshot_changed", "训练数据库在读取期间发布，请重读完整快照。", 503);
}
```
同一函数的其它不稳定信号都走 `continue` 重试（`:548-556` guard pending、`:641-645` stat 为空、`:649-652` guard 变化），只有 mtime 直接抛。而 `read-store-manager.ts:82-93` 自己的注释写明："mtime alone must not reopen: **every WAL checkpoint touches the main file**" —— 即同一次 checkpoint 会让这里的 plan 读 503。inode 变化代表换库（应当失败），mtime 变化不代表快照混读（`BEGIN DEFERRED` 快照仍然一致）。

**影响**：重算/导入发布写主库触发 auto-checkpoint 时，正在进行的 plan-state 读会拿到 503 而不是在第 2 次尝试上重读；客户端有有界重试可自愈，属可用性抖动。该行在 HEAD 前就存在（原为 `statSync` 比较），HEAD 只把 ENOENT/EACCES/EIO 改成重试，未处理 mtime。

**建议**：mtime 变化改为 `this.cache.clear(); continue;`（保留 inode 检测的抛错语义），或删掉 mtime 项让 `data_version` + guard + control digest 负责一致性。

### L1-07（P3）R1–R3 探针未进门禁；运行方式有坑

```json
// npx tsx scripts/review-model-boundaries.mts --out /tmp/rai-boundaries.json
{ "version": "rai-model-boundary-review-v1", "violationCount": 0, ... }
```
- `package.json` 有 `"review:model-boundaries": "tsx scripts/review-model-boundaries.mts"`，但 `.github/workflows/ci.yml` 没有调用它，`scripts/run-tests.mjs` 也不包含（只收集 `*.test.ts`）。`docs/PROJECT_REVIEW.md:62-65` 把它当作可复跑的证据，实际只能靠人手动跑。
- 直接 `node scripts/review-model-boundaries.mts` 会 `ERR_MODULE_NOT_FOUND: packages/application/src/service.js`（.mts 需要 tsx 装载器）；若命令带 `| tail`，管道会把退出码变成 0，读起来像"跑过了"。我本次审查里就先踩了一次这个假绿，随后用 `npx tsx` 得到真实结果。

**建议**：把 `npm run review:model-boundaries` 接进 CI 的 linux job（一条 step 即可，合成库、约几秒），或在 `check:acceptance-matrix` 类门禁里引用，避免"探针存在但从未执行"。

## 4. 高价值问题逐项结论

| # | 问题 | 结论 |
|---|---|---|
| 1 | 身份/去重/tombstone/复活语义 | 基本成立：删除写墓碑 + 软删（v36）双轨；`observeImportEntity` 以"事实是否仍在"判定 `exists`，软删实体重新观测为 `inserted`（可恢复），墓碑存在时 `shouldWrite=false`（不复活）——`workout-presence.test.ts` 覆盖。**但**无 UUID 记录的"值即身份"在 preserveAbsent 增量下会把更正变成新增，旧行永不删除（L1-01）。路由版本跨删除保留有测试（`C7` 用例：soft delete 后 `route_version_points` 仍 2 行、发布指针不变），PR5-S1/S2 的结论在 HEAD 仍成立。 |
| 2 | 事务与发布原子性 | 直连事务一致性**成立**：同一 `BEGIN IMMEDIATE` 内完成解析/路线/局部 canonical/分析任务登记/回执，并在提交前逐项回读（`direct-sync-ingest.ts:997-1022`：账本覆盖、任务行、批次代次绑定、回执四类断言），任一失败即回滚；data-only 车道同样有 `rollbackAtomicImport()` 与写守卫。文件发布：`activateDatabase` 在 `beforeCommit` 失败时用 rollback point 恢复 incumbent，并且只有"回滚已被证明完成"才清 publication journal（`import-worker.ts:1949-1956`）——**失败保持 incumbent 成立**。跨 main/control 的 plan 发布由 marker→主库→control→清 marker 的 guard 兜；读侧 fail-closed（3 次后 503）。例外见 L1-02/L1-03/L1-04。 |
| 3 | 迁移安全 | 成立：迁移 1–45 全部有冻结 checksum（`database.ts:1738-1779`），运行时**只**用冻结值（`migrationChecksum`）；每个迁移单独 `BEGIN IMMEDIATE`+`schema_migrations` 插入（原子、可重入）；已应用库对 name/checksum 双向校验；`pending>0` 后跑 `PRAGMA foreign_key_check` 并在非空时抛错；`pendingMigrations()` 被直连车道用来拒收（`direct-sync-ingest.ts:715-716`）。v45 只 `ADD COLUMN`（可空、无回填），与 docs 的"只新增"约束一致。backup/restore 有 journal + quarantine + `quick_check`（`maintenance.ts:264-343`），删除前置备份失败则降级为 quarantine 备份后再删。`migration-policy.test.ts` 通过。 |
| 4 | 读侧一致性 | `currentFacts`/`publishedAnalysis` 与 base 在同一个 `BEGIN DEFERRED`（`data.ts:500-520` 的 `factAnalysisBlocks`，`training-plan-state` 用 `readFactReadViewInTransaction`），未发现第二次开事务；软删可见性判据单点化（`sql/fragments.ts` 的 `workoutPresentConditionSql`/`sessionFactPresentConditionSql`），且有结构门禁扫描 `packages/*/src` + `apps/api/src` 只允许一处 `deleted_at IS NULL` 字面量（`workout-presence.test.ts:132-172`，扫描面含 6 个事实侧文件）；`canonicalize` 对已删训练做 presence 过滤并全局失活其 session（`canonicalize.ts:253-266, 560-568, 811`），因此 feature 侧的 `listActiveForFeatures()`（无 presence 过滤）不会读到已删训练。`route_versions` 指针 NULL 走 `readable_route_points` 视图回退 `route_points`，且 `route-point-reader.ts` 有"视图不存在则退回双表 SQL"的兼容分支。缓存连接按 inode 重开、忽略 mtime（`read-store-manager.ts:82-93`）——但 `data.ts` 的 mtime 判定与这条原则相反（L1-06）。 |
| 5 | Rust worker | parity **已修复且验证**（见 §0/§1.2、L1-05 的负向控制）。写许可 fail-closed 成立：`apply_records` 要求 target 文件名带 `.importing.<36>` 后缀（`main.rs:496-521`），permit 长度 64 hex 且在 staging 库 `import_manifest` 中逐字匹配（`:522-528`），source 用 `SQLITE_OPEN_READ_ONLY` 打开（`:520`），主库文件名不可能通过后缀校验；`run()` 对 `--output` 用 `create_new(true)`（`:697-706`），不可能覆盖既有库。取消/崩溃：父进程在任何失败上丢弃候选库，不发布半批（`import-worker.ts` 的 finally/cleanup 与 `native-worker.test.ts` 的"取消即删 spool"用例）。 |
| 6 | 规模/性能/资源 | 没有发现新的无界物化：`factAnalysisBlocks` 的上界是固定行数（facts 100 / analysis 200）；`direct-sync` 的路线归属查询只查本批路径（`:778-790`，注释记载了从全表扫描改过来）；`recompute-pipeline.ts` 的 105 处 `prepare` 里只有一处位于循环内（`:4316` 的 `for (const batchId of capture.mergedBatchIds)`，每批一条 INSERT，量级=本次合并批次数，不是 O(N)），其余循环（`:997` session、`:1873` plan rows、`:2260` 批量 writer、`:3214`）都是单次 prepare + 批量执行。`node:sqlite` 同步调用 + 短事务 + `busy_timeout`（control 库 2000 ms、主库 5000 ms）与 `connection-contention.test.ts` 通过。**未做**真实 325 MB 库的延迟基准。 |
| 7 | 测试可信度 | 关键失败路径大多有真实数据断言而非 mock：直连/数据-only 的提交前回读断言、发布回滚（`plan-publication-stress` 双进程）、guard 三态（`plan-read-consistency.test.ts` 15 条）、迁移 checksum（`migration-policy`）。发现的弱点是 L1-05（unchanged 态）与 L1-07（探针未进门禁）；另外 `importEquivalence` 的域清单是"人工维护的白名单"，新增表不会被自动比对，只靠 `benchmark-import`/等价性测试的现有域（这属于既知设计，未列为 finding）。 |

## 5. 与既有审查的关系

- **新增**：L1-01（无 UUID 记录值更正重复，合成复现）、L1-02（legacy 读路由未接新 guard）、L1-03/L1-04（新 guard 自身的降级/盲区边界）、L1-05（parity 测试 unchanged 态与 skip 语义）、L1-06（mtime 503 与自有原则冲突）、L1-07（探针未进门禁）。
- **确认（HEAD 修复成立，不重复报旧问题）**：
  - c644c49 的 Rust 增量账本 before 侧 parity：`native-worker.test.ts` 8/8（0 skip）+ 我的 `/tmp` 负向控制证明 `importEquivalence` 对 `previous_type` 变 NULL 敏感 ⇒ 修复真实、测试不是假绿。
  - HEAD 的 publication guard（P2-2 批次 B）：`plan-read-consistency.test.ts` 15/15、双进程压力测试存在、`/synced` 的 `matchesCurrent` 与回执写在同一事务且读路径在事务内屏蔽自己的 marker（`plan-receipt-identity.test.ts:169,210`）。
  - 软删不级联销毁已发布路线版本（PR5-S1/S2）、写侧 `.importing` + permit、直连写守卫 fail-closed 表分类：均与历史结论一致，当前 HEAD 未被推翻。
- **推翻/降级**：无。历史审查没有涉及"无 UUID 记录更正语义"与"legacy 读路由 guard 覆盖"这两点；L1-06 是既有行为（`P2-5` 只修了 stat 异常路径），标注为"当前仍存在，但非本轮引入"。
