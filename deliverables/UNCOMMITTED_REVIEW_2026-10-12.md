# 未提交改动审查（2026-10-12）

- **审查对象**：`/Users/ta/running` 相对 `HEAD=7a6408a` 的**全部未提交改动** ——
  22 个已改动文件（`1051 insertions / 142 deletions`）+ 20 个未跟踪新文件（约 5200 行）。
- **改动主体**：SQLite 直接增量同步的 **PR1（契约/守卫/文档）+ PR2（同库事务、迁 v34/v35）**
  **+ PR3（版本化事实与路线、局部 canonical、FactsReader）**。
  设计依据 `docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md`；进度记录 `deliverables/DIRECT_SYNC_PR2_PR3_2026-10-12.md`。
- **方法**：每条结论落到 `文件:行号` 或**实跑输出**；新增门禁按纪律做**突变验证**（改坏 ⇒ 必须变红 ⇒ 还原 ⇒ `shasum` 逐字节校验）；
  核对"证据真空"时先问**判据住哪、谁会执行它**。
- ⚠️ **本轮实测到一条工具事实**：本沙箱下 `git diff` 的 `+/-` 前缀与 `git show HEAD:<file>` 的**内容不一致**
  （例：`database.ts` 的 `rollback()` 早退行被 `git diff` 标为新增，而 `git show HEAD` 证明它在 HEAD 第 2082 行就存在）。
  ⇒ **凡"某行是新增/删除了"的结论，本轮一律回源码核，不采信 diff 前缀。**

---

## 一、结论摘要

| # | 级别 | 结论 | 证据（可复核） | 处置 |
|---|---|---|---|---|
| R1 | 🔴 | 报告声称的 `npm run check:doc-refs` 全绿，对本批**新增的两份设计文档是真空的** | `scripts/check-doc-line-refs.mjs:60` 的 `DEFAULT_DOCS` **只有 4 份**文档；本批新文档不在内。§七 复核时进一步发现：**那 4 份本身都是 0 处引用** ⇒ 当时它校验了 **0 处**却返回 `EXIT=0` | ✅ 已修（§七 1） |
| R2 | 🔴 | 对新增设计文档**显式实跑** ⇒ `EXIT=1`，**2 处行号越界** | `node scripts/check-doc-line-refs.mjs docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md`（见 §二 R2 输出） | ✅ 已修（§七 1） |
| R3 | 🔴 | 同一文档中多条 `database.ts:<行号>` 与目标行**内容不符**（漂移），且因无 baseline，漂移判据**完全未生效** | `database.ts:1012` 实读为 `ALTER TABLE feature_runs ADD COLUMN …`；真实 `import_entity_generations` 表在 **1034-1035** 行（§七 已按工作区重定为 `:1037`） | ✅ 已修（§七 1） |
| Y1 | 🟡 | 旧链路增量导入（`incremental-import`）**不再清空 `import_issues`** —— 一次未登记、无测试的行为变更 | 旧：`apple-health-parser.ts` 在 `preserveAbsent:true` 时调 `seedImportGenerations`（内含无条件 `DELETE FROM import_issues`，`database.ts:3222`）；新：只在 `removalDetection` 时调（`apple-health-parser.ts:333-341`） | ✅ 已修（§七 2） |
| Y2 | 🟡 | 同一事实两个来源、口径不一致：`hasUsableRoute` 看 `file_status='imported'`，`FactsReader.routeFor` **只看 `point_count>0`** | `database.ts:2573` vs `read/facts-reader.ts:162` | ✅ 已修（§七 3） |
| Y3 | 🟡 | 全量 `npm test` 仍未取得 `EXIT=0`（报告已如实标注）；其"并发脆弱"归因**本轮未独立复现**，仅核对了它引用的三个常量 | 见 §三 Y3 | ⏸ **未修**（保留原判：需真正独占窗口） |
| Y4 | 🟡 | `gpx-parser` 的"解析窗口"注释说只含 `parseGpxFile`，实际窗口**包含 DB 写入回调** | `gpx-parser.ts:425-434` | ✅ 已修（§七 4） |
| P1 | ✅ | 定向门禁 6 组**实跑全绿**（43 + 63 + 6 条，`EXIT=0`；含 §14.1 阳性对照 6/6） | §四 | — |
| P2 | ✅ | `typecheck` `EXIT=0`（0 个 `error TS`）；`check:docs` 37 文件 / 344 链接 / 0 问题 | §四。⚠️ **该 ✅ 在写完本报告的那一刻就失效了**：本文件当时未从 `deliverables/README.md` 链进来 ⇒ 成为"不可达文档"（§七 5） | ✅ 已修（§七 5） |
| P3 | ✅ | **两处突变均被精确捕获**，还原后 `shasum` 与基线逐字节一致、`mtime` 已复原 | §四 | — |


---

## 二、🔴 必修

### R1 — 报告的 `check:doc-refs` 全绿是"真空的 0"

报告（`DIRECT_SYNC_PR2_PR3_2026-10-12.md` §3）把 `check:doc-refs` 的"越界 0 / 漂移 0 / 锚在空行 0"列为验收证据。
实读脚本，它**只检查 4 份写死的文档**：

```js
// scripts/check-doc-line-refs.mjs:60
const DEFAULT_DOCS = ["docs/ARCHITECTURE.md", "docs/ALGORITHM.md", "docs/DATA_PIPELINE.md", "docs/OPERATIONS.md"];
```

本批新增的 `docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md`（**36 处** `文件:行号` 引用）、
`docs/SQLITE_DIRECT_SYNC_DESIGN.md`（0 处）、以及 `deliverables/*.md` **都不在清单里**。
实跑输出只有那 4 行、且都是"0 处引用" —— 它证明的是"这 4 份文档里没有行号引用"，**不是"本批文档的引用没问题"**。

⚠️ 这与本仓纪律 2「脚本跑绿 ≠ 门禁存在」、16「引用行号没越界 ≠ 引用没错」同族：
**一份含 36 处行号引用的新文档，从未被任何通道校验过。**

**修法（二选一）**：
- 把新文档加进 `DEFAULT_DOCS`（会改变全局默认检查范围，需评估耗时）；
- 或在 CI / `check:docs` 里显式传文档路径，并按仓规为它建 baseline（`--write-baseline`）。

**验收标准**：把文档里任意一处行号改错 ⇒ 门禁**非 0 退出**（突变验证）。

### R2 — 新增设计文档 2 处行号引用越界（实跑 `EXIT=1`）

```
$ node scripts/check-doc-line-refs.mjs docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md
🚨 行号越界  recompute-job-repository.ts:172-175  -> packages/application/src/recompute-job-repository.ts
🚨 行号越界  cli.ts:421-432                        -> packages/application/src/cli.ts
docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md: 36 处引用，2 处越界/无法解析
EXIT=1
```

**根因**：文档用了**裸 basename**，而仓库里存在**同名文件**，脚本的消歧表（`AMBIGUOUS`，`scripts/check-doc-line-refs.mjs:63-69`）
没有这两条 ⇒ 落到错误的同名文件上（`packages/application/src/cli.ts` 只有 4080 B、`.../recompute-job-repository.ts` 只有 181 B），行号自然越界。

- 文档位置：`docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md:651`（`recompute-job-repository.ts:172-175`）、`:693`（`cli.ts:421-432`）。
- 文档**意图**指向的应是 `packages/storage-sqlite/src/recompute-job-repository.ts:172-175` 与
  `packages/health-export-parser/src/cli.ts:421-432`（同一文档别处正是这么写的，如 `:323`、`:334-340`）。

**修法**：改写成全路径（推荐，读者与脚本都不会再猜）；若确需保留裸名，则往 `AMBIGUOUS` 补两条（但那是全局改动，须先扫一遍其它文档的既有引用）。

**验收标准**：上面那条命令 `EXIT=0`。

### R3 — `database.ts:<行号>` 引用与目标行内容不符（漂移未受检）

脚本对**已跟踪**的文档有 baseline 漂移检查；新文档没有 baseline ⇒ 输出"内容漂移 0 处"是**第二次真空**。
手动回源码核对三条：

| 文档写 | 文档描述的目标 | 该行**实际**内容 | 真实位置 |
|---|---|---|---|
| `database.ts:1012`（`:29`） | `import_entity_generations.entity_kind` 的 CHECK | `database.exec("ALTER TABLE feature_runs ADD COLUMN parent_feature_run_id …` | 表定义在 **1034**、CHECK 在 **1035** |
| `database.ts:457-473`（`:32`） | `recompute_jobs` 表（含 `job_type` CHECK） | 非 `recompute_jobs` 定义 | 表在 **480**、`job_type` CHECK 在 **482** |
| `database.ts:98,1648,1691`（`:34`） | 迁移注册表 / 冻结校验和 | `98` 实读 `featureRuns: number;` | `const migrations` 在 **121** |

同一条错误引用还被**复制到了别处**（纪律 15：同一句错话会在别处留副本）：
`.workbuddy/memory/NOTES-direct-sync.md:42` 也写 `packages/storage-sqlite/src/database.ts:1012`。

**修法**：以当前工作区为准逐条改正行号；并在文档头部标注**对齐的提交基线**（本仓既有判据：
"验收截图/文档必须带 commit 锚点"）。改完全库反向 grep 同一错引用。
**验收标准**：`check:doc-refs` 对该文档 `EXIT=0`，且抽查 5 条回源码核内容一致。

---

## 三、🟡 待决策

### Y1 — `import_issues` 不再随旧链路增量导入清空（未登记的行为变更）

旧代码（`HEAD`）：
```ts
// apple-health-parser.ts（改动前）
if (options.incremental && !options.recordDelta) {
  store.seedImportGenerations(options.incremental.generation,
    options.incremental.preserveAbsent ? { preserveAbsent: true } : undefined);
}
```
新代码（`:333-341`）把补种与删除判定合并为**单一判据** `removalDetection = !preserveAbsent`，
只在 `removalDetection` 时调用 `seedImportGenerations(incremental.generation)`。合并本身是对的
（`generation-seeding-pairing.test.ts` 正反两面都钉住了），但 `seedImportGenerations` **不只补种**：

```ts
// database.ts:3211-3225
seedImportGenerations(generation, options?) {
  this.begin();
  if (!options?.preserveAbsent) { this.database.exec("DELETE FROM entity_inventory"); this.clearEntityTombstones(); }
  this.database.exec("DELETE FROM import_issues");   // ← 无条件
  ...
}
```

于是：
- **全量快照路径**：不变（仍调用）✓
- **直连车道（recordDelta）**：本来就不调用（旧代码 `!options.recordDelta` 为假）⇒ 不变 ✓
- **旧链路的 `incremental-import`**：`cli.ts:359-364` 在无 `--replace-absent` 时传 `preserveAbsent: true`
  ⇒ 旧代码**会**清空 `import_issues`，新代码**不会** ⇒ **真实行为变更**

**影响面**（均可复核）：`import_issues` 的消费方为 `import-dataset-analysis.ts:139-150`（本批 vs 上一批的差异）、
`audit-read-repository.ts:78,188`（审计展示）、`health-export-parser/src/audit.ts:436`（计数）。
语义从"本批导入的问题清单"变成"**跨批累积**"。

**需要拍定**：这是有意的统一（与直连车道一致，都是累积），还是副作用？
若为后者，最小修法是恢复"清 issues"这一件事（例如把它从 `seedImportGenerations` 里拆成一个独立调用）。
**验收标准**：一条用例断言所选语义（"清"或"不清"），且旧链路 `incremental-import` 路径在用例里真被走到。

### Y2 — 同一事实两个来源，口径不一致

| 位置 | 判据 |
|---|---|
| `database.ts:2573` `hasUsableRoute()` | `file_status === "imported" && point_count > 0` |
| `read/facts-reader.ts:162` `routeFor()` | `COUNT(*) WHERE workout_id = ? AND point_count > 0`（**不看 `file_status`**） |

`gpx-parser.ts:465,475` 正是用 `hasUsableRoute` 决定"要不要把旧路线打成 pending/invalid"。
`FactsReader` 今天**没有生产调用方**（报告 §5 也这么写）⇒ 现在不构成线上不一致；
但 PR4/PR5 接读侧时，两条判据对同一行会给出不同结论（例如 `file_status='invalid'` 但 `point_count>0`）。
建议：**PR4 开工前**统一到一条判据（或让 `routeFor` 也带上 `file_status`），并加一条"两处对同一行给同一结论"的断言。

### Y3 — 全量 `npm test` 未取得 `EXIT=0`（报告已如实标注，本轮未复现其归因）

报告 §4 说全量 `EXIT=1`（3 条：`data-only-import-queue` / `server-runtime` / `worker`），
归因为"6-CPU 上默认并发 6 vs 5s/30s 墙钟预算"。**本轮没有独立复现这个归因**，理由是环境不达标：
`uptime` 实测 `load average: 10.50 → 13.94`（6 核，外部负载；本仓纪律："全量门禁必须独占跑，
并行会伪造一批文件级失败"）。跑出来的结果不可信，故**不跑**。
已核实的**只是它引用的三个常量**：`worker.test.ts:214` 的 `waitFor(..., timeoutMilliseconds = 5000)` ✓、
`data-only-import-queue.test.ts:61` 的 `30_000` ✓、`scripts/run-tests.mjs` 在
`concurrency === undefined` 时**不追加** `--test-concurrency`（⇒ 走 node 默认并发）✓。
⇒ **判据边界**：可以说"归因的机制描述与代码一致"，不能说"归因已被验证"。

### Y4 — `gpx-parser` 的"解析窗口"注释与实现有出入

注释（`gpx-parser.ts:341-344`）说"只把 `parseGpxFile` 那一小段当作'文件可能坏了'的窗口"，
但窗口内包含回调 `(points) => store.appendRouteVersionPoints(...)`（`:428`）——
该方法若因**数据库**错误抛出，同样会被 `parseWindowFailure` 标记并落成 `INVALID_GPX`（写一条假话）。
⚠️ 这只是**旧行为的子集**（旧代码整个 `beginRoutePointReplacement + parseGpxFile` 都在窗口内），
所以**不是回归**；但注释里的承诺比实现强。建议把注释改准，或把回调的失败单独分派。

---

## 四、✅ 通过项（明确列出，不只挑刺）

1. **`npm run typecheck`：`EXIT=0`**，`grep -c "error TS"` = 0（双 tsconfig：`tsconfig.pure.json` + `tsconfig.json`）。
2. **`npm run check:docs`：37 文件 / 344 本地链接 / 0 问题，`EXIT=0`**。
3. **定向门禁 6 组实跑全绿**（串行/低并发，`EXIT=0`）：
   - `storage-sqlite` 新测试 6 文件：**43 / 43 pass**（含 `transaction-owner` 11、`route-version` 5、
     `recompute-job-recovery` 4、`facts-reader` 14、`direct-sync-migrations` 5、`recompute-job-bindings`）
   - 解析器 + 契约 + runner：**63 / 63 pass**（`canonicalize-nights-window`、`generation-seeding-pairing`、
     `parser`、`gpx-quota`、`healthkit-record-sync`、`test-runner`、`direct-sync-plan`、`direct-sync-analysis-registration`）
   - `direct-sync-prohibited-operations`：**6 / 6 pass**（含阳性对照：旧候选路径确实触发守卫 + `var/backups` 落盘）
4. **突变验证（本轮实做 2 处，各自红在预期用例上）**：
   | 突变 | 结果 |
   |---|---|
   | 删掉 `direct-sync-plan.ts:43` 的 `!input.preserveAbsent` 判定 | `direct-sync-plan.test.ts` **#2、#3 变红**（`not ok`） |
   | 把 `apple-health-parser.ts:333` 的 `removalDetection` 置为 `false` | `generation-seeding-pairing.test.ts` **#8 变红**（完整快照漏删） |
   还原后 `shasum -a 256` 与突变前**逐字节一致**（`3bfdd3c7…` / `6eaedd8a…`），`MUTATION-KILL` 标记 0 处，`mtime` 已 `touch -t` 复原。
5. **迁移层符合本仓硬规矩**：v34/v35 是"新增表 + 可空列"，**未改任何历史迁移的 `up`**；
   `MIGRATION_VERSIONS` 由 `migrations.map(...)` **自动推导**（`database.ts:1755`）⇒ 34/35 自动纳入，
   不存在"漏登记版本"；`FROZEN_MIGRATION_CHECKSUMS` 已补 34/35；`direct-sync-migrations.test.ts` 对
   每条约束都有一次**"期望被拒绝"的写入**（`entity_kind='route'`、`valid_to<=valid_from`、`job_type='bogus'`、
   分片 `UNIQUE`、`status='half'`），这正是"CHECK 写错时 SQLite 不报错"的解药。
6. **"静默全库删除"防线是结构性的，不是约定**：`directSyncParserOptions()` 返回类型写死 `{ preserveAbsent: true }`
   （`direct-sync-plan.ts:67-69`，且 `length === 0` 有断言）；`assertDirectSyncRequestShape` 拦展开写法；
   `generation-seeding-pairing.test.ts` 证明"直连恒为增量"（缺 `preserveAbsent` 或显式 `false` 均被资格门拒）。
7. **恢复流程按"谁能执行"分派**，且有**负向对照**（可消费类型仍回队列、已取消仍走 cancelled）+
   **结构约束**（从生产 DDL 解出 `job_type` 清单，断言每个类型都被表态）——这正是纪律"只断言'不再发生'
   无法区分'把逻辑删了'"的正确解法。
8. **路线版本"不发布半条"有正反用例**：不足/顺序断裂被拒且旧轨迹与指针一字未动；
   被拒版本只留痕迹；`published` 版本行**自带**点（真双写，`route-version.test.ts:144-149`）。
9. **未新增 HTTP 写端点**（`apps/api/src/server.ts` 未改）⇒ 无需登记 `metadataOnlyMutationRoutes` /
   `databaseRequiredMutationRoutes`；**未改 `apps/web` / `apps/ios`** ⇒ 无需跑 `test:e2e:web` / `test:ios`。
10. **文档登记齐**：`README.md` 文档表、`docs/DATA_PIPELINE.md`、`docs/HEALTHKIT_RECORD_SYNC_V2.md`、
    `docs/OPERATIONS.md`（新增"外部一致性备份的责任边界"）、`deliverables/README.md` 均已更新，
    且明确声明"设计未上线，不能据该设计认定线上已覆盖"。

---

## 五、修复顺序 + 验收标准 + 回滚

| 顺序 | 动作 | 验收标准 | 回滚 |
|---|---|---|---|
| 1 | **R1**：把新设计文档纳入 `check:doc-refs` 的可执行范围（加 `DEFAULT_DOCS` 或显式路径 + `--write-baseline`） | 改坏一处行号 ⇒ 门禁非 0（突变验证） | 还原 `scripts/check-doc-line-refs.mjs` 一行 |
| 2 | **R2**：两处引用改全路径 | `node scripts/check-doc-line-refs.mjs docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md` `EXIT=0` | 纯文档改动，`git checkout -- <doc>` |
| 3 | **R3**：逐条改正 `database.ts:<行号>`，文档头标注对齐提交；改完反向 grep 同一错引用（含 `NOTES-direct-sync.md:42`） | `check:doc-refs` 该文档 `EXIT=0`；抽查 5 条回源码核内容一致 | 同上 |
| 4 | **Y1**：拍定 `import_issues` 语义并补断言 | 有 1 条用例断言所选语义，且旧链路 `incremental-import` 被真走到 | `git checkout -- packages/health-export-parser/src/apple-health-parser.ts`（+ `database.ts` 若拆函数） |
| 5 | **Y2**：统一 `routeFor` / `hasUsableRoute` 判据（或显式声明差异）| 一条断言：同一行两处给同一结论 | 只涉及 `read/facts-reader.ts` |
| 6 | **Y3**：在**真正独占**窗口重跑全量 `npm test`；或先落地 `RAI_TEST_CONCURRENCY` 的默认有界并发（属项目决策） | `EXIT=0`，且日志落在 `.workbuddy/runlogs/` | 不设该 env ⇒ 行为与历史逐字相同（已有断言钉住） |

**迁移与破坏性契约声明**：
- 本批新增 v34/v35，**不提供反向迁移**（设计 §6 已明示）；旧代码路径不读新表/新列，可继续跑。
- 契约变更是**加可选字段**（`ImportJobResponse.summary.directSync?`）⇒ **非破坏性**，老客户端不受影响。
- 未发现 `MobileNextSession.structure` 那类"必填新字段 + 多端构造点"的破坏性变更。

---

## 六、清理项与工具坑

- 本轮临时文件：`/tmp/rai-typecheck.log`、`/tmp/rai-t1..t3.log`、`/tmp/rai-mut.log`、`/tmp/rai-doc*.log`、
  `/tmp/rai-diff-*.txt`（均在 `/tmp`，不在仓库内）。
- 突变**已完全还原**：`shasum` 一致 + `mtime` 复原（不残留"构建后源码有变动"的假信号）。
- ⚠️ **新增工具事实（建议进 `NOTES-engineering.md` 的工具坑章）**：
  本沙箱下 `git diff` 的 `+/-` 前缀与 `git show HEAD:<file>` **可能不一致**（本轮实测）。
  ⇒ 判"某行是新增还是既有"必须回源码核；已有纪律"不要信管道渲染"应扩展到 `git diff` 本身。

### 未验证项（如实标注，不含糊）

| 项 | 状态 | 原因 |
|---|---|---|
| 全量 `npm test` 的 `EXIT=0` | ⛔ **未取得** | 本机 `load 10.5–13.9`（6 核，外部负载），结果不可信；报告亦已声明未取得 |
| 报告对 3 条失败的**并发归因** | ⚠️ **未复现** | 只核对了它引用的三个常量（5000ms / 30_000 / 不追加 `--test-concurrency`） |
| `server-runtime` / `worker` 单跑复核 | ⚠️ **未跑** | 单跑实测 443s / 349s，本轮时间预算外 |
| iOS 门禁 / 视觉回归 | — **不适用** | 本批未改 `apps/ios` |
| Web e2e | — **不适用** | 本批未改 `apps/web` |
| 云机 P01–P06 / 真机 HealthKit | ⛔ **不可达** | 设计 §5.4 已声明：需目标云机 / 真机 |

---

## 七、修复记录（同轮完成，2026-10-12）

**范围**：R1 / R2 / R3 + Y1 / Y2 / Y4；另修一条**本报告自身引入**的门禁失败（见 5）。
**Y3 不修**，理由见 §八。
**纪律**：三处代码改动各自**先补断言、再突变到红、再逐字节还原**（见 6）；所有实跑日志落
`.workbuddy/runlogs/`（项目内，不落 `/tmp`）。

### 1. R1 / R2 / R3 —— 文档行号与门禁范围

| 动作 | 文件 | 结果 |
|---|---|---|
| `DEFAULT_DOCS` 纳入设计文档 | `scripts/check-doc-line-refs.mjs` | `npm run check:doc-refs` 从"校验 0 处"变为**实跑 39 处** |
| 2 处越界引用改**全路径** | `docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md` | `cli.ts:421-432` → `packages/health-export-parser/src/cli.ts:421-432`；`recompute-job-repository.ts:172-175` → `packages/storage-sqlite/src/recompute-job-repository.ts:181-191` |
| 逐条改正内容漂移的引用 | 同上 | 见下表 |
| 反向 grep 同一批错引用的**副本** | `.workbuddy/memory/NOTES-direct-sync.md` §四 | 6 条全部重核（`1012`→`1037`、`2925-2932`→`3324-3337`、`193/196`→`218/221`、`457-473`→`482-498`、`98/1691`→`123/1718`、`1728/1740`→`1757/1769`） |

**修前 → 修后（逐条实测，对齐当前工作区）**：

| 文档位置 | 修前写的 | 修后（`check:doc-refs` 打印的实读内容） |
|---|---|---|
| `:24` | `database.ts:2051-2054` | `database.ts:2117-2121`（`markObject()` 的 5000 攒批提交点） |
| `:25` | `database.ts:2074-2086` | `database.ts:2143-2157`（`flush()` 的 `COMMIT` / `rollback()` 的 `ROLLBACK`） |
| `:26` | `database.ts:2056-2067` | `database.ts:2123-2135`（`beginAtomicImport()` / `commitAtomicImport()`） |
| `:27` | `apple-health-parser.ts:325-330` | `apple-health-parser.ts:336-345`（**并改写结论**，见下） |
| `:28` | `database.ts:2925-2932` | `database.ts:3324-3337`（`finalizeImportGeneration` 的 `preserveAbsent` 早退） |
| `:29` | `database.ts:1012` | `database.ts:1037`（v12 建表语句里的 `CHECK (entity_kind IN …)`） |
| `:31` | `database.ts:184-197` | `database.ts:209-222`（`workout_routes` 整表） |
| `:32` | `database.ts:457-473` | `database.ts:482-498`（`recompute_jobs` 整表） |
| `:33` | `canonicalize-nights.ts:219` / 注释 `226-235` | `canonicalize-nights.ts:333` 整表删重建 / `canonicalize-nights.ts:10` 与 `canonicalize-nights.ts:259-261` |
| `:34` | `database.ts:98,1648,1691`；`1728/1740` | `database.ts:123`（注册表）、`:1673`（v33）、`:1718`（冻结值）、`1757/1769`（`MIGRATION_VERSIONS`/`transpiledChecksumFor`） |
| `:35` | `import-worker.ts:939-957` | `apps/api/src/import-worker.ts:948-966`（`databaseTask<T>` 本体） |
| `:243` | `database.ts:1638-1648` | `database.ts:123-1673`（v1–v33 那一段）+ `:1674-1675`（新增的两条） |
| `:244` | `database.ts:1691` | `database.ts:1718` |
| `:251` / `:257` | `canonicalize-nights.ts:219` / `234-235` | `:333` / `7-15`（常量定义所在段） |
| `:341` | `canonicalize-nights.ts:226-239` | `canonicalize-nights.ts:250-261` |
| `:647` | `cli.ts:323` | `packages/health-export-parser/src/cli.ts:321`（生成 `importJobId` 那行） |
| `:680` | `database.ts:482` | `database.ts:484`（`job_type` 的 CHECK 那一行，不是表头） |
| `:693` | `cli.ts:421-432` | `packages/health-export-parser/src/cli.ts:421-432` |

🔴 **一处不是行号问题，是结论本身过期**（`:27` 那行"现状锚点"）：原文写「全库补种只在
`incremental && !recordDelta` 时发生」。实测判据是 `removalDetection`（= `incremental && !preserveAbsent`，
`apple-health-parser.ts:337`）；`recordDelta` 之所以**结构上**碰不到补种，是因为资格检查强制它必须
`preserveAbsent`（`apple-health-parser.ts:309-312`）。所以改的是结论 + 锚点，不是数字。
**这正是 R3 的价值所在**：光看"行号没越界"永远发现不了这一类。

**同时确认**：`docs/SQLITE_DIRECT_SYNC_DESIGN.md`（上位设计）**0 处**行号引用，无需改动。

### 2. Y1 —— `import_issues` 语义拍定

- `RaiDatabase` 抽出独立入口 `clearImportIssues()`（`packages/storage-sqlite/src/database.ts`），
  `seedImportGenerations()` 改为调用它 —— 原先那次 `DELETE FROM import_issues` 是它**无人声明的副作用**。
- `apple-health-parser.ts` 补回旧链路的按批重建：
  `else if (incremental && !options.recordDelta) store.clearImportIssues()`。
- 断言：`generation-seeding-pairing.test.ts` 新增 2 条 ——
  ①`preserve-absent 增量不补种，但仍必须按批重建问题清单`（先断言旧问题**真的**写进去了，再断言清空为 0，
  并断言代次行**没有**被凭空补种）；②负面对照`没有 incremental 的调用不重建问题清单`（防止"顺手扩大清空范围"）。

### 3. Y2 —— 「可用路线」收敛为**一条**判据

- 判据本体搬进 `packages/storage-sqlite/src/sql/fragments.ts` 的 `usableRouteConditionSql(alias?)`
  （`file_status = 'imported' AND point_count > 0`）——该文件头本来就写着"Keep business … definitions here
  to avoid dual-SQL drift"。
- `RaiDatabase.hasUsableRoute()`（写侧）与 `FactsReader.routeFor()`（读侧）**共用**它 ⇒ 分叉**在结构上不可能**，
  而不是靠一条断言去追。
- `routeFor()` 顺带把"先 `COUNT` 再取点"合成**一次查询**：条件只写一遍，且"COUNT 说有、取点一行都没有"
  不再返回 `[]`（那落在契约的两种取值之外）。
- 断言：`facts-reader.test.ts` 新增`routeFor 与 hasUsableRoute 对同一行 workout_routes 给同一结论`。
  构造了**走公开 API 造不出**的一行（`file_status='pending'` 而 `point_count=2`，`markRouteStatus()` 会把点数一起清零）
  —— 只有这样一行能把"修前/修后"两种实现分开；恒等式逐个 workout 核：
  `routeFor(W) !== null` ⟺ W 至少有**一条**可用路线。
  ⚠️ 本用例第一版把 workout 级与 route 级混成一个问题，**当场红了**，记录在案（见 §八 的"自我纠错"）。

### 4. Y4 —— 落库回调的失败与「这份文件坏了」分开

- `gpx-parser.ts`：回调包一层 `try/catch`，失败时打 `routeWriteFailure` 标记；
  内层 catch 从无条件的 `parseWindowFailure = true` 改为 `parseWindowFailure = !routeWriteFailure`。
  ⇒ 磁盘满 / 库被锁这类**基础设施**故障不再被写成一条 `INVALID_GPX` 假话。
- 注释订正为实际口径（原来写的"窗口只含 `parseGpxFile`"做不到：回调**由 `parseGpxFile` 内部调用**）。
- 断言：`parser.test.ts` 新增`落库回调失败时上抛，不得被当成'这份文件坏了'`——
  注入落库故障 ⇒ 断言**原样上抛**、`INVALID_GPX` 计数为 0、路线状态未变；**再撤掉故障重跑同一份文件**，
  断言能正常导入（这才是"坏的不是文件"的直接证据）。含前置断言 `writeAttempts > 0`，
  防止"根本没走到回调"也变绿。

### 5. 本报告自己引入的门禁失败（P2 的 ✅ 在写完报告那一刻失效）

写完本文件后 `npm run check:docs` 由 **0 问题**变为 **1 问题**：
`deliverables/UNCOMMITTED_REVIEW_2026-10-12.md: not reachable from README.md`
（`check-doc-links.mjs:52-56` 会报出所有"从 `README.md` 走不到"的文档）。
⇒ 已在 `deliverables/README.md` 的「当轮审查」段补上本文件的索引条目。修后 `check:docs` 回到
`38 files / 346 local links / 0 problems`（`EXIT=0`）。
**教益**：`check:docs` 的 ✅ 是**关于文档图**的，新增任何 `.md` 都会改变这个图 —— 它不是"与改动无关的既常量"。

### 6. 突变验证（3 处，各自红在**预期的那条**用例上）

| # | 突变（回到修复前的行为） | 期望 | 实测 |
|---|---|---|---|
| M1 | `read/facts-reader.ts`：`WHERE wr.workout_id = ? AND ${usableRouteConditionSql("wr")}` → `AND wr.point_count > 0` | 新用例变红 | `15 tests / 14 pass / 1 fail`；`not ok 11 - routeFor 与 hasUsableRoute 对同一行 workout_routes 给同一结论` |
| M2 | `gpx-parser.ts`：`parseWindowFailure = !routeWriteFailure` → `= true` | 新用例变红 | `6 tests / 5 pass / 1 fail`；`not ok 6 - 落库回调失败时上抛…`，`error: Missing expected rejection` |
| M3 | `apple-health-parser.ts`：`else if (incremental && !options.recordDelta)` → `else if (false)` | 新用例变红 | `5 tests / 4 pass / 1 fail`；`not ok 4 - preserve-absent 增量不补种，但仍必须按批重建问题清单`，`expected 0 / actual 1` |

**还原核验**（判据是对象账，不是退出码）：三个文件 `shasum -a 256` 前 16 位与突变前**逐字节一致** ——
`d316e86b1a968159`（`facts-reader.ts`）、`e0ec6e0e545ab461`（`gpx-parser.ts`）、`8a85ee5259a4d498`
（`apple-health-parser.ts`）；`mtime` 已 `touch -t` 复原；`grep -rn "回到修复前" packages apps` **无残留**。
还原后三组复跑 `26 tests / 26 pass / 0 fail`（`EXIT=0`）。

### 7. 本轮门禁实跑汇总（日志全在 `.workbuddy/runlogs/`）

| 门禁 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 类型 | `npm run typecheck` | **`EXIT=0`**，`error TS` = 0 | `2026-10-12-typecheck.log` |
| 文档链接 | `npm run check:docs` | **`EXIT=0`**，38 文件 / 346 链接 / 0 问题 | `2026-10-12-checkdocs.log` |
| 文档行号 | `npm run check:doc-refs` | **`EXIT=0`**，39 处 / 0 越界 / 0 漂移 | `2026-10-12-docrefs-all.log` |
| ↳ 修前同命令 | `node scripts/check-doc-line-refs.mjs docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md` | `EXIT=1`，**2 处越界** | `2026-10-12-docrefs-before.log` |
| 包级测试（storage-sqlite 32 + health-export-parser 21 文件，串行） | `node --import tsx --test --test-concurrency=1 …` | **`EXIT=0`**，279 tests / 278 pass / **0 fail** / 1 skip | `2026-10-12-pkg-suites.log` |
| 三组定向复跑 | 同上，3 文件 | **`EXIT=0`**，26 / 26 | `2026-10-12-rerun-three.log` |

唯一那条 skip = `publication lock rejects PID reuse when the process identity differs`
（`SKIP process identity probing is unavailable in this environment`）—— 沙箱下 `ps` 被拒的**已知** fail-safe，
与仓库纪律里记的"3 skip / 4 skip"同一条，**不是覆盖丢失**。

### 8. 未修 / 保留（不含糊）

| 项 | 状态 | 理由 |
|---|---|---|
| **Y3**：全量 `npm test` 的 `EXIT=0` | ⏸ **仍未取得** | 本轮 `load average` 实测 **10.3 – 23.5**（6 核）；本仓纪律：全量必须独占跑，否则会伪造一批文件级失败。**不伪造结论**。本轮已跑的等价物是"两个受改包的全量 + 3 组定向"，见 7 |
| 判据 2（内容漂移）**全仓**是否启用 | ⏸ **未做，属项目决策** | 仓库里**没有任何 `.linerefs.json` 基线** ⇒ 该判据今天对**所有**文档都没生效。本轮**故意没**生成：给单份文档建基线会让"编辑任何被引源码"都让 `check:doc-refs` 非 0（改 `database.ts` 一行会让设计文档 39 处全报漂移），而那是**跨文档**的门禁 —— 正是本项目吃过苦头的"门禁因无关改动变红"。要做请一次做全（全部现行文档）+ 明确谁负责重跑 |
| `check:doc-refs` 的默认范围是否扩充 | ⏸ 只加了 1 份 | 全仓含引用的 `.md` 共 6 份 / 127 处，**全在默认范围外**；其中 4 份是**带日期的时点快照**（按脚本第 3 条判读陷阱**不该**进默认范围）。另有 1 份现行文档 `deploy/README-UBUNTU.md`（1 处）**漏登记**，待补 |
| iOS 门禁 / Web e2e / 云机 P01–P06 / 真机 HealthKit | — **不适用或不可达** | 本批未改 `apps/ios` / `apps/web`；云机与真机见设计 §5.4 |

### 9. 本轮改动的文件清单

**代码（4 个源文件 + 3 个测试文件）**
- `packages/storage-sqlite/src/sql/fragments.ts`（新增 `usableRouteConditionSql`）
- `packages/storage-sqlite/src/database.ts`（+`clearImportIssues()`；`hasUsableRoute()` 改用共享判据）
- `packages/storage-sqlite/src/read/facts-reader.ts`（`routeFor()` 判据同源 + 合成单次查询）
- `packages/health-export-parser/src/gpx-parser.ts`（解析窗口与落库回调分开）
- `packages/health-export-parser/src/apple-health-parser.ts`（旧链路按批重建问题清单）
- `packages/storage-sqlite/test/facts-reader.test.ts`（Y2 断言）
- `packages/health-export-parser/test/parser.test.ts`（Y4 断言）
- `packages/health-export-parser/test/generation-seeding-pairing.test.ts`（Y1 断言 ×2）

**文档 / 门禁 / 笔记**
- `scripts/check-doc-line-refs.mjs`（`DEFAULT_DOCS` + 注释记下"原先校验 0 处"的实测）
- `docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md`（逐条改正引用；1 行结论改写）
- `deliverables/README.md`（本报告入索引）
- `.workbuddy/memory/NOTES-direct-sync.md`（§四 6 条引用重核）

