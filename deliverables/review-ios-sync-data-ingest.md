# iOS 端数据同步与数据解析入库审查报告

> 审查日期：2026-10-17
> 审查范围：`apps/ios/RAI/`（Swift）、`apps/api/src/direct-sync-ingest.ts`、`packages/health-export-parser/src/`、`packages/storage-sqlite/src/`

---

## 一、同步管道整体数据流

```
HealthKit
  └─ HealthKitExport.swift
       ├─ 逐 workout 分页导出（HKAnchoredObjectQuery）
       ├─ RouteGpxWriter → GPX 文件流写入
       ├─ DirectSyncBatchBudget：写前判定 / 先判后取路线闸门
       └─ DirectSyncDeletionPartition：三段预扣（旧槽 record → 旧槽 workout → 新 workout）
  └─ HealthSyncArchive → ZIP 打包
  └─ BackgroundUploadSession / APIClient → POST /v1/imports/uploads → /v1/imports/inspect → /v1/import-jobs
  └─ API import-worker → applyDirectSyncImport
       ├─ preflightDirectSyncPayload（目录预检 + 上界校验）
       ├─ preparePayload（SHA256 一致性校验）
       ├─ installDirectSyncWriteGuards（白名单写守卫 + TEMP 触发器）
       └─ 同一主库事务：parseAppleHealthXml → importGpxRoutes → 账本 → recompute_jobs → commit
```

管道整体设计成熟，核心机制已有覆盖良好的回归测试（写守卫白名单、批次级脏证据、删除暂存守恒、预算收敛均有对应断言）。以下列出仍存在的具体问题，按优先级排序。

---

## 二、发现的问题

> ⚠️ 本节是 **2026-10-17 修复前**的代码快照：其中的行号与代码片段描述的是当时的实现。
> 四项已在工作树实现（尚未提交）的改动、两处与事实不符的条目、一处降级为取舍的条目，以及改动后的新锚点，统一见文末 **§四 复核与实施状态**。

### P1 — 高优先级（影响吞吐或可靠性）

#### P1-1：同一批次文件被打开三次，内容读取约 80 MiB

**位置：** [`apps/api/src/direct-sync-ingest.ts:477–496`](../apps/api/src/direct-sync-ingest.ts)

`preparePayload` 的串行执行路径如下（数字都是上界，不是典型值）：

1. `preflightDirectSyncPayload` → `statSync(xmlPath)` 获取文件大小（第 1 次打开，**仅元数据**，不读内容）
2. `readFileSync(xmlPath, "utf8")` 同步读取 XML 全文（第 2 次打开，≤ 8 MiB，**阻塞 worker 线程**）
3. `digestHealthKitExportContent(input.inputPath)` 流式 SHA256：XML（≤ 8 MiB）+ manifest（≤ 8 MiB）+ `workout-routes/**`（≤ 64 MiB），manifest 也参与摘要（见 `apps/api/src/import-sources.ts:292-295`）

步骤 2 是同步阻塞调用，步骤 3 是 `async`，两者在 worker 线程里串行完成，且对同一文件没有任何缓存或合并。按上界算，内容读取约 **80 MiB**（8 + 8 + 64），不是"72 MiB × 3"；三次**打开**里有一次只读元数据。

**建议：** 在 `preparePayload` 内合并步骤 2 和步骤 3，使用流式读取一次性同时填充 `xmlText` 缓冲区和 SHA256 摘要；GPX 文件维持独立流式读取。这样 XML 从 2 次磁盘读降到 1 次；真实回填批（2.4 MiB XML + 34 MiB 路线）里 XML 只占内容读取的约 6.6%，收益是"去掉一次同步阻塞的 ≤ 8 MiB 读"，不是数量级改善。

---

#### P1-2：增量批次的幂等性验证触发第二次完整写入（`assertIdempotent`）

**位置：** [`packages/health-export-parser/src/native-record-writer.ts:130–152`](../packages/health-export-parser/src/native-record-writer.ts)

对所有**增量**批次，`apply()` 在第一次 Rust native apply 完成后调用 `assertIdempotent`，后者再次以相同参数执行 `runApply`（即第二次完整写入 + B1 摘要校验）。这是设计上正确的（replace 批次因论据原因跳过），但对大增量批次意味着：

- Rust native apply 的写入开销翻倍
- 第二次 apply 仍占用 worker 线程，阻塞后续任务
- 磁盘写放大（candidate 数据库 + 账本写入量 × 2）

代码注释已说明跳过 replace 批次的完整理由，但没有提及对增量批次成本的量化评估。

**建议：** 对小批次（如 `this.count < N`，可以是 1000 条）保留完整幂等性验证；对大增量批次，用 B1 摘要（`inputDigest` 对比）加 B4 采样（`assertSampleMatches`）代替完整第二次写入，覆盖率足够且成本与批次大小解耦。此为优化项，不影响正确性。

---

### P2 — 中优先级（维护风险或隐藏耦合）

#### P2-1：`INGEST_TABLE_DISPOSITIONS` 白名单与数据库迁移之间存在强耦合，遗漏时整条同步车道静默阻断

**位置：** [`apps/api/src/direct-sync-ingest.ts:175–260`](../apps/api/src/direct-sync-ingest.ts)

写守卫是失败关闭的（fail-closed）：数据库中存在任何未在 `INGEST_TABLE_DISPOSITIONS` 表态的表，`installDirectSyncWriteGuards` 会抛出 `write_guard_triggered`，整批直连请求被拒收。这在正确性上是期望行为，但维护上构成耦合：每次在 `packages/storage-sqlite/src/` 增加迁移文件（添加新表），必须同批在 `apps/api/src/direct-sync-ingest.ts` 的白名单里加入对应条目，**否则整条同步车道在下次请求时立即拒收所有批次**。代码注释（第 239 行）已有记录，但这一规则只在注释里，没有编译期或测试期门禁。

**建议：** 在 `npm run test` 或 `npm run typecheck` 的前置步骤里加一条静态检查：枚举 `storage-sqlite` 所有迁移文件新建的表名，与 `INGEST_TABLE_DISPOSITIONS` 的已声明集合做差集比较，差集非空时编译失败。这将维护责任从"人工纪律"升级到"编译门禁"，代价仅是一个几十行的检查脚本。

---

#### P2-2：`planRecompute` 在非 workout/route 变更或缺 `effectiveAt` 时退化到全量重算

**位置：** [`packages/health-export-parser/src/incremental.ts:74–89`](../packages/health-export-parser/src/incremental.ts)

```ts
const unsafe = material.filter((change) => !["workout", "route"].includes(change.entityKind));
if (unsafe.length > 0 || dates.length !== material.length) {
  return { mode: "full", ... };
}
```

这里有两道会触发 full 的条件：① 任何 `entityKind` 不是 `workout`/`route` 的变更（`unsafe` 非空）；② `workout`/`route` 变更里存在 `effectiveAt` 为 null 的条目（`dates.length !== material.length`）。注意 `ImportEntityKind` 的联合类型里并没有 `activity_summary`（见 `incremental.ts:7`），所以"活动摘要缺时间戳"不是这条代码的触发路径。保守兜底本身正确，但会让本可增量的批次升级为全量重算（耗时数分钟）。

**建议：** 若将来重新启用该函数，先按 `entityKind` 区分"影响分析边界的类型"与"可局部忽略的类型"；当前它没有生产调用方（见 §4.1），改动优先级低。

---

#### P2-3：`NativeRecordWriter` 资源上界检查每 4096 行才触发一次

**位置：** [`packages/health-export-parser/src/native-record-writer.ts:57–60`](../packages/health-export-parser/src/native-record-writer.ts)

```ts
if (this.count % 4096 === 0) {
  const pages = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
  const size = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
  if (pages.page_count * size.page_size > 8 * 1024 ** 3) throw new NativeWorkerError("resource_limit");
}
```

每 4096 条记录才做一次 `page_count × page_size` 检查。默认 SQLite 页大小为 4 KiB，4096 条记录按平均记录大小估算可能占 4–40 MiB。超界时最多可以多用 `4096 × max_record_size` 的内存而不被察觉。此外 `PRAGMA page_count` 本身是一次同步数据库查询，在 `journal_mode=OFF` 模式下每次都需要计数所有页。

**建议：** 把检查周期缩短到 512 行，与页大小的关系更紧密；或改用已写字节的累积估算（把每次 `capture` 增加的字节数累加到一个计数器），避免反复触发 `PRAGMA` 查询。

---

#### P2-4：`BatchAnalysisDirtyEvidence` 版本字段无迁移追踪，未来版本升级时旧批次证据将全部返回 `invalid`

**位置：** [`packages/health-export-parser/src/batch-dirty-evidence.ts:29`](../packages/health-export-parser/src/batch-dirty-evidence.ts)

```ts
export const BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION = 1;
```

`parseBatchAnalysisDirtyEvidence` 在 `record.version !== BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION` 时返回 `invalid`。这是故意的严格策略（注释里明确说明），但意味着将来升级 version 为 2 时，数据库里所有旧批次的 `analysis_dirty_plan_json` 字段将全部解析为 `invalid`，消费端会退回全量重算路径。如果升级不带迁移（不更新历史批次的字段），这会造成一段时间内所有历史批次的增量计划失效。

**建议：** 在升级 version 时同步提供一个向后读取函数（`parseV1ToV2`），或在 `parseBatchAnalysisDirtyEvidence` 中支持已知旧版本的升迁（只需要在从旧 schema 向新 schema 映射有意义时才做，不需要通用向后兼容）。至少在版本升级的提交 message 里明确记录"历史批次证据将失效，增量计划在下一轮全量导入后恢复"。

---

### P3 — 低优先级（设计边界 / 运维可观测性）

#### P3-1：预算收敛耗尽（`budget_convergence_exhausted`）后没有自动恢复路径

**位置：** [`apps/ios/RAI/DirectSyncBatchBudget.swift:161`](../apps/ios/RAI/DirectSyncBatchBudget.swift)

`DirectSyncBudgetConvergence.maxSteps = 3`，三次折半后若仍超界，会抛出 `budget_convergence_exhausted`，同步停止并等待人工处置。这是设计决定（代码注释已说明理由：避免无限重读 HealthKit），但：

- 没有任何 UI 入口让用户手动"重置收敛状态"后重试
- 用户看到的症状与"服务端拒绝批次"在界面上相同，难以区分

**建议：** 在同步详情页（`TechDataSyncDetailView`）展示"预算耗尽"作为独立错误态，提供"以最小批量重试"按钮（将 convergence.steps 重置为 maxSteps，强制最小预算逐批发送）。

---

#### P3-2：`mobileSyncStatus` 在 worker 日志不可用时无法感知失败

**位置：** [`apps/api/src/mobile-sync.ts:51–68`](../apps/api/src/mobile-sync.ts)

当 `outcome` 为 null（数据库直接从 CLI 导入，或没有 worker 运行记录）时，函数回落到 `lastSuccessAt == null ? "never" : "ok"`，永远不会报告失败。这对纯 iOS 直连场景（所有导入都经过 worker）问题不大，但对调试环境（CLI 导入后 API 冷启动）会掩盖历史失败。已在代码注释中说明，属于已知权衡。

---

## 三、总结

| 优先级 | 编号   | 问题                          | 影响               |
| --- | ---- | --------------------------- | ---------------- |
| P1  | P1-1 | 同一批次文件三次 I/O                | 大批次吞吐下降 30–40%   |
| P1  | P1-2 | 增量批次幂等性验证双倍 Rust 写入开销       | 大增量批次处理时间翻倍      |
| P2  | P2-1 | 白名单与迁移无编译门禁                 | 新迁移漏表 = 整条同步车道阻断 |
| P2  | P2-2 | activity_summary 缺时间戳触发全量重算 | 无效全量重算，耗时数分钟     |
| P2  | P2-3 | 资源检查间隔 4096 行               | 超界检测滞后最多 ~40 MiB |
| P2  | P2-4 | 脏证据版本升级时历史批次失效              | 下次升级后增量计划暂时失效    |
| P3  | P3-1 | 预算耗尽无自动恢复 / 用户入口            | 运维可见性差           |
| P3  | P3-2 | CLI 导入场景无失败状态               | 调试环境掩盖失败（已知权衡）   |

核心机制（写守卫、删除守恒、预算收敛、游标闸门、脏证据编码）设计严谨，已有完整回归覆盖。P1-1 和 P2-1 是最值得优先处理的两项：前者影响日常同步吞吐，后者是一条无编译保护的维护陷阱。

---

## 四、复核与实施状态（2026-10-17 二次核对）

本节是对上方结论的**复核**，不删改原文。**两处**与代码事实不符（P2-2、P3-1；P3-1 更准确的说法是"原建议无效"），**一处由"事实错误"降级为取舍**（P1-2）；**四项已在工作树实现（尚未提交）**。2026-10-17 复核时补强了 P1-1 与 P2-3 的判据（AST 判据、默认上限钉值），并给 P2-1 补了 kind/why、触发器与生产 SQL 抄本判据。

### 4.1 两处误判 + 一处取舍（附证据）

| 编号 | 原文结论 | 复核结果 |
| --- | --- | --- |
| P1-2 | 大增量批次"处理时间翻倍" | ⚠️ **降级为取舍，不算"与事实不符"**：服务端**没有**记录条数上限 —— `DIRECT_SYNC_MAX_RECORDS` 只约束删除配额（`direct-sync-ingest.ts:465-467`），契约里写明"不约束 XML 记录条数"（`packages/api-contracts/src/index.ts:204-209`）；4500 条只是 iOS 客户端自限（`DirectSyncBatchBudget.swift:56`），8 MiB XML 可远超 5000 条。且 incremental 下 Rust 对已存在且 hash 未变的记录**跳过 canonical insert**、但仍逐行写 `import_entity_generations`（`crates/rai-data-worker/src/main.rs:576-600`），所以第二次 apply 是"重扫 + 部分写"，按批有界、总成本随批数增长。保留 B3 的理由是"刻意的不变量 + 全仓没有负例测试，削覆盖收益为负"，**不做**。原判断不是事实错误，是影响被高估。 |
| P2-2 | 任意记录缺 `effectiveAt` ⇒ 全量重算 | ❌ `planRecompute` **没有生产调用方**（只有 `packages/health-export-parser/src/index.ts:61` 的 re-export 与它自己的单测）。生产走 `planIncrementalAnalysisDirtyRange`（`dirty-range.ts:147`）：其 `activity_summary` 分支（`:191-226`）按**点区间**处理，只有"整批都没有任何可用边界"才 `full`（`:249-252`）。**不做**。 |
| P3-1 | 建议"把 `convergence.steps` 重置为 `maxSteps`" | ❌ **建议本身无效**：耗尽时 `steps` 已等于 `maxSteps`（`apps/ios/RAI/DirectSyncBatchBudget.swift:171` 的 `isExhausted` 即 `steps >= maxSteps`；真正赋满档在 `apps/ios/RAI/HealthKitSync.swift:1754`），重置到 3 是空操作。真正能恢复的是 `clearBudgetConvergence()`，而它被结构门禁钉死"只许 repair 调用"（`apps/ios/tests/check-background-capabilities.py:1704-1712`）。**原建议作废**；若将来要做，唯一安全形态是给 repair 加一个更显眼的入口，而不是新增第二条清零路径。 |

### 4.2 已在工作树实现（尚未提交）

| 编号 | 改动 | 判据与结果 |
| --- | --- | --- |
| P1-1 | `preparePayload` 不再 `readFileSync` 整读 XML；字节数改用预检已算出的 `statSync` 值（`direct-sync-ingest.ts:478-505`，`PreparedPayload` 见 `:339`） | 直连用例 **21/21**；两条判据：①行为判据的夹具**故意放一个非法 UTF-8 字节**（XML 注释内），旧口径会报磁盘字节 + 2，因此能区分新旧实现；②源码判据改用 **TypeScript AST** 检查 `preparePayload` 函数体（不得出现 `readFileSync` / `xmlText`）与 `PreparedPayload` 成员（不得含 `xmlText`、须含 `xmlFileBytes`）。复核时用 `git show HEAD:` 的旧源码与"先赋局部变量"的别名回退各跑一次，**均被 AST 判据抓到**；`readStripped` 的模板串/单引号截断绕过（复核实测会让负断言恒绿）因此不再适用。 |
| P2-1 | 新增 `apps/api/test/direct-sync-table-dispositions.test.ts`：跑完全部迁移后查 `sqlite_master`，与白名单做**双向**差集；再在真实迁移库上安装守卫，核对每张 analysis 表的 3 个触发器；补 `kind`/`why` 非空与"生产 SQL 抄本仍出现在生产源码"判据；`.githooks/pre-commit` 增加触发块（含 hook 自己、含删除、并拒绝 index/工作树不一致） | **1/1**；两次变异（删一条表态 / 加一条 ghost）各自红并点名；`kind`/`why`/触发器缺失/生产 SQL 漂移各有对应断言。生产 `:292` 的静默 `continue` 保持不变 —— 僵尸条目只在构建期清理。 |
| P2-3 | spool 体积检查间隔 4096 → 512；`page_size` 只在构造时读一次；上限可注入（`native-record-writer.ts:57-62`），检查循环在 `:87-91`，`assertIdempotent` 现在在 `:161` | 新用例 **3/3**；三个单变量变异（间隔 4096 / 间隔 1 / 默认上限改小）**全部被检出** —— 复核时补了"默认上限就是 8 GiB"的**绝对**判据（只跑 512 行时，默认值从 8 GiB 改到 8 MiB 仍不会抛，原 2 条用例抓不到）。 |
| P2-4 | 升级协议注释（四步）+ 字面量钉版本测试（源常量 `batch-dirty-evidence.ts:44`；字面量断言在 `test/batch-dirty-evidence.test.ts:106-109`） | 用例 **11/11**（复核时新增"缺 routeDirtyTimes / recoveryBoundaries / reasons ⇒ invalid"，并让解析器真的**缺键即 invalid** —— 原先两个数组缺键会取 `[]`，与文件头"缺字段一律 invalid"矛盾）；把常量抬到 2 ⇒ 新判据立刻红，且 `tsc` 同时报 `TS2322: Type '1' is not assignable to type '2'`（写入点 `direct-sync-ingest.ts:876`）——证明"常量抬了、写入点没跟"本就由类型系统兜住。 |

### 4.3 两处口径修正

- **P1-1 的收益被高估**。"省 30–40% 的 prepare 时间"只在**无 GPX 的纯 XML 批**上成立；真实回填批（2.4 MiB XML + 34 MiB GPX）里 XML 约占内容读取的 **6.6%**（2.4 / (2.4+34)；若拿 72 MiB 上界当分母则是约 3.3%，两种口径不要混用）。真实收益是"去掉一次同步阻塞的 ≤ 8 MiB 读"，而不是数量级改善。
- **P3-2 无需改动**：`apps/api/src/mobile-sync.ts:40-50` 已用整段注释记录该权衡（无 worker 日志时不臆造失败），属已知设计边界。

### 4.4 验收边界（哪些跑了、哪些没跑）

已跑并绿：
- `npm run typecheck` EXIT=0（改动后 3 次；2026-10-17 复核又跑 2 次，含 AST 判据与解析器收紧后）
- `apps/api/test/direct-sync-ingest.test.ts` 21/21、`import-worker-direct-sync.test.ts` 3/3、`direct-sync-table-dispositions.test.ts` 1/1
- `packages/health-export-parser/test/native-record-writer.test.ts` 3/3、`batch-dirty-evidence.test.ts` 11/11
- `check-package-boundaries` / `check-npm-scripts-portable` / `check-blob-size` / `check-doc-links` / `check-acceptance-matrix` 均 EXIT=0
- 发现性：`scripts/run-tests.mjs` 的 `nodeTestFiles()` 共 248 个文件，**两个新测试都在列表里**

**没跑或没跑完，如实记录：**
- `npm test` 全量：43 分钟未结束时中止（本机为虚拟机，248 个文件）。替代以"新文件的发现性证明 + 逐包定向批次"。
- `packages/application/test/*`：上一轮整批红，失败原因是**当时沙箱**拒绝删除 `TMPDIR` 下的 `rai.sqlite-journal`（`file-delete` 被拦）——这是环境限制，不是代码关系。⚠️ 该现象在 2026-10-17 复核的 full-access 环境里**不可复现**（抽样 `analysis-input-batch-floor.test.ts` 为 1/1 绿）。另外，当时"本批对 parser 的改动是纯注释"只对 `batch-dirty-evidence.ts` 的注释成立；`native-record-writer.ts` 有功能改动，且它经 `apple-health-parser.ts` 可以从 `@rai/application` 测试到达——只是与本批失败无因果关系。
- `packages/health-export-parser/test/native-worker.test.ts`：**6/8，2 红为基线既存**。根因可证：`target/release/rai-data-worker` 是 **2026-09-22** 的二进制，`crates/` 源码改到 **2026-10-16/17**，而本机 `cargo: command not found` ⇒ 无法重编译。**二进制存在 ⇒ 测试真跑，但跑在旧二进制上**，这是本轮之外的环境债。
- 环境边界：默认 DSH Node 下 `apps/api` 测试会因 `onnxruntime-node` 的 darwin/x64 绑定无法 `dlopen` 而无法启动（`ERR_DLOPEN_FAILED`，既有环境债）；复核对 `apps/api` 测试使用未签名 Node 副本绕过，`node_modules` 未改动。
