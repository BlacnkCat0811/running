# 方案真实检查报告（第二轮）

> 日期：2026-09-17 ｜ 被检对象：`deliverables/PLAN_P0_P3_REVISED_2026-09-17.md`
> 方法：**能跑的一律跑**（不再"读码即结论"）。共 6 项可运行实测 + 30 余处行号核对。
> 全程只读真库副本或一次性临时副本，**未触碰 `var/rai.sqlite`**。

---

## 0. 一页结论

| 类别 | 数量 | 内容 |
|---|---|---|
| 🔴 **推翻我自己上轮的结论** | **2 条** | 「文件哈希是假断言」——**我错了**；「`speedTrack` 不存在」——**我错了**（路径写错导致 grep 失败） |
| ✅ **实测确认（上轮是推断）** | 2 条 | `process.exitCode` 在监听下**确实不退出**；完整启动链**确实透传 78** |
| 🟠 **新增实质发现** | 4 条 | 构造函数有副作用；"v22 要 44.3s" 要分场景；**每个写请求有 ~1.3s 固定开销**；**`enqueueJob` 完全不去重（P2-A 确定性叠加）** |
| 🟡 **路径/表述错误** | 2 处 | `series-read-repository.ts` 缺 `/read/` 子目录；P2-B/P3-A 的"分层"表述会撞模块边界 |
| ✅ 行号核对 | 30+ 处 | **除上述 1 处路径外全部准确**（含 `worker.ts` 7 处、各测试文件行号） |

**净判断**：方案的**设计与判据没有新错误**，但有一处**安全承诺不完整**（"零写库"）需要收紧，一处路径需修正，一处分层表述需明确。

---

## 1. 🔴 推翻我自己的两条结论

### E1. 「库文件哈希不变是假断言」——**我上轮错了，实测反驳**

**我上轮写的**：
> "库文件哈希不变"是**假断言**（新建连接即 `PRAGMA journal_mode=WAL`，会改主库头 + 产 `-wal`）

**实测**（`/tmp/waltest.sqlite`，324 MB 真库副本，已是 WAL）：

| 时点 | md5 | 文件 |
|---|---|---|
| `RaiDatabase.open` 之前 | `57fada8cb6fdd67ec28d5049e0900b2d` | 仅主库 |
| `open` + `close` 之后 | **`57fada8cb6fdd67ec28d5049e0900b2d`（完全相同）** | **仍仅主库，无 `-wal`/`-shm`** |

**真相**：库**已是 WAL** 时，`PRAGMA journal_mode = WAL` 是 no-op；且**全程无写入** ⇒ 哈希不变、不产 WAL 文件。

⇒ **正确结论（分场景）**：

| 路径 | 断言 | 依据 |
|---|---|---|
| **refuse + pending（零写库）** | ✅ **文件哈希不变** 是**可靠且最强**的判据 | 本轮实测：无写入 ⇒ md5 不变 |
| **apply（真迁移）** | 必须用**逻辑指纹**（哈希本就该变，无法反映"是否被意外改动"） | 实测：迁移后 `57fada8c…` → **`11135274…`** |

⇒ 修订版方案 §3.1 验收表把"文件哈希"整条换掉是**过度修正**，应改回**分场景**。

### E2. 「`speedTrack` 不存在」——**我上轮错了，是我 grep 的路径写错了**

实际位置：**`packages/storage-sqlite/src/read/series-read-repository.ts:269`**（我漏了 `read/` 子目录）。

| 方案声称 | 实测 |
|---|---|
| `speedTrack` 在 `:269-326` | ✅ `:269` `speedTrack(`，返回 `StoredSpeedTrack \| null`（`:274`） |
| 质量门 `:314`，`0.8 / 0.75 / 1.25` | ✅ `:314` = `if (durationCoverage < 0.8 \|\| scale < 0.75 \|\| scale > 1.25) return null;` —— **与方案逐字一致** |
| "已内建质量门，不要另写采样" | ✅ 判断正确 |

**额外正面发现**：该文件 `:365` 有一个 **"Measure arbitrary ascending boundaries against the scaled speed track"** 的方法（`measureBoundaries`，被 `:379`/`:474` 调用）—— 这正是 P3-A 的 CS（滚动最快 3/7/12 分钟）与 P2-B（分段对半）**共同需要的能力**，且已存在。⇒ 两个方案的"不重复造轮子"判断都成立。

---

## 2. ✅ 实测确认的两条（上轮只是推断）

### C1. `process.exitCode` 在监听下**确实不会退出**

```js
// 实测脚本：Fastify 监听后设 process.exitCode = 78
await app.listen({ host: "127.0.0.1", port: 0 });
process.exitCode = 78;
```
**结果**：4 秒后进程**仍在运行**（靠 `kill -0` 判定）⇒ 上轮"监听句柄让事件循环永不空闲"的判断**成立**。
⇒ 必须 `process.exit(78)`，方案 §3.1 第 4 条的修正是**对的**。

### C2. 完整启动链**真实透传退出码 78**

真实链条比上轮测的复杂：
```
/usr/bin/npm run start          (root package.json:46)
  → npm run start -w @rai/api   (workspace 转发)
    → prestart: node scripts/check-node-version.mjs   (apps/api/package.json:9)
      → start: tsx src/server.ts                       (apps/api/package.json:10)
```
实测结果：

| 层 | 退出码 |
|---|---|
| `tsx` 直跑 | **78** |
| 单层 npm + tsx | **78** |
| **完整链（2 层 npm + prestart + tsx）** | **78** |

⇒ `RestartPreventExitStatus=78` 机制**可用**（上轮只测了假结构，这轮测了含 `tsx` 与 `prestart` 的真实链）。

---

## 3. 🟠 三条新增的实质发现

### N1. 🔴 `new RaiDatabase(path)` 的**构造函数本身有副作用** ⇒ "零写库"承诺不完整

构造函数（`database.ts:1635-1647`）先执行：
```js
PRAGMA foreign_keys = ON;  PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;  PRAGMA busy_timeout = 5000;   // 后三条是连接级/前两条
```

**实测**（造一个 `journal_mode=delete` 的库）：

| 操作 | 结果 |
|---|---|
| 造库后 `journal_mode` | `delete` |
| 执行 `PRAGMA journal_mode = WAL` 后 | **`wal`（模式被改写 ⇒ 主库头被改 ⇒ 哈希必变）** |
| 换用**只读连接**读 | `delete`，且**文件哈希不变**（`c513be97…` 前后一致） |

🔴 **方案 §3.1 的缺口**：原写"在 `ensureMigrationTable()` 之前只读探测"——但 `ensureMigrationTable()` 是 `migrate()` 的第一行，而 `migrate()` 是被 `open()` 在 **`new RaiDatabase(path)` 之后**调用的 ⇒ **探测时构造函数已经跑过了**。若目标库非 WAL，此时已被改写。

**修正后的设计**：
```
open(path, {migrationPolicy:"refuse"})
  → ① 先用独立只读连接探测 pending：
       new DatabaseSync(path, { readOnly: true })
       → 查 sqlite_master 有无 schema_migrations（无表 ⇒ 全部 pending）
       → 有表则查已应用版本
       → pending 非空 ⇒ throw PendingMigrationsError（此时零写库，哈希可断言不变）
  → ② 才 new RaiDatabase(path) 并正常 migrate
```
⇒ **只读探测必须在 `new RaiDatabase(path)` 之前**，而不是只在 `ensureMigrationTable()` 之前。
⇒ 实际风险低（线上库每次 open 都被设成 WAL，实测副本 `journal_mode = wal`），但这是承诺完整性所必需。

### N2. 🟠 "v22 需要 44.3 秒"要分场景，不能当通用预期

**实测**（副本，删掉 `schema_migrations` 里 v22 那行以造出 pending，然后 `RaiDatabase.open`）：

| 场景 | 实测耗时 |
|---|---|
| **首次迁移**（真的要重写 160k 行 id、去重） | 44.3 s（历史实测） |
| **幂等重跑**（库已被 v22 处理过 ⇒ `needsRename=false` 且 `duplicateIds` 为空 ⇒ `:1542` 早退） | **7515 ms**（其中大部分是 **324 MB 备份**的复制耗时） |

⇒ 备份落点实测确认：`dirname(dbPath)/backups`（对副本是 `/tmp/backups/`，**真的生成了 324 MB 备份**）⇒ 线上即 `/var/lib/rai/var/backups/`。
⇒ 文档与验收里引用"44.3s"时应注明是**首次**迁移；幂等重跑约 **7.5 s**（备份主导）。

### N3. 🟠 每个写请求有 **~1.3 秒**的固定开销（方案完全没提）

**实测**：对一个 324 MB、**22 条迁移全部已应用（无 pending）**的库，`RaiDatabase.open` 仍耗 **1306 ms**。

原因：`migrate()` 每次都对**全部已应用迁移**做 `sha256(up.toString())` 校验（`:1741-1753`）+ `prepareStatements()`。

而 `openMainDatabase()`（`server.ts:399-412`）被 **9 个写端点**每次调用一次（`:502/800/1033/1134/1177/1207/1252/1269/1300`）⇒ **每个写请求付 ~1.3 s**。

⇒ 这解释了方案里"数据库半挂时每个写请求都像卡住"的体感，也是"不能频繁触发全量重算"之外的另一重成本。
⇒ **不影响 P-1 的结论**，但值得作为独立的性能观察项记录（优化方向：把 checksum 校验结果缓存/或只校验 pending）。

### N4. 🔴 `enqueueJob` **完全没有去重** —— 方案 §5 待确认项 6 结案

**方案 §5 第 6 项**原写："`enqueueFullRecompute` 是否对同一时刻去重（决定 P2-A 改判可行性）"——**本轮结案：不去重，一次调用 = 一条新排队任务。**

调用链逐层读实：

| 层 | 位置 | 实证 |
|---|---|---|
| 业务入口 | `packages/application/src/service.ts:180` | `const jobId = this.enqueueFullRecompute();`（在 `appendWorkoutOverride` 内，**COMMIT 之前**、**无条件**） |
| 门面 | `service.ts:62-64` | 直接 `return this.enqueueJob("full_recompute", defaultRequest(options));` |
| 派发 | `service.ts:212-216` | 只查 `import_manifest.dataset_version` 后转交，**无任何幂等判断** |
| 落库 | `packages/storage-sqlite/src/recompute-job-repository.ts:20-29` | **纯 `INSERT INTO recompute_jobs (... status='queued' ...)`** —— **无 `WHERE NOT EXISTS`、无 upsert、无唯一索引**，随后 `logEvent` 再写一行 |

⇒ 结构上就决定了**不可能去重**（不是"忘了写"，是根本没设约束）。连存 5 次 RPE ⇒ **排 5 条 `full_recompute`**，而 `claimNext()`（`:38-63`）是**逐条 FIFO 领取**（`ORDER BY created_at, rowid LIMIT 1`）⇒ **串行跑 5 遍全量重算**。

**对 P2-A 的结论**：维持**推迟**，且理由从"疑似叠加"升级为"**确定性叠加且串行**"。反过来说，若将来要做 P2-A，**前置条件必然是先给 `enqueueJob` 加去重/合并语义**（例如同 `job_type` 的 queued 任务只留一条，或把 RPE 改成增量重算），这是一个**独立于 UI 的存储层改动**。

---

## 4. 🟡 两处路径与表述错误

### P1. `series-read-repository.ts` 路径缺 `/read/`

- 方案写：`packages/storage-sqlite/src/series-read-repository.ts`
- 实际：**`packages/storage-sqlite/src/read/series-read-repository.ts`**（512 行）
- 同目录还有 `read/` 下其它仓储；引用统一加 `read/` 前缀

### P2. P2-B / P3-A 的"分层"表述会导致模块边界冲突

方案 §3.5 同时写了两句：
- 「落点放 `packages/features/src/index.ts` 的**纯函数**」
- 「采样**复用** `series-read-repository.ts` 的 `speedTrack`」

🔴 这两者**不在同一层**：
- `tsconfig.pure.json` 白名单确实**含 `features`**（本轮已确认），但该配置是 `"types": []` ⇒ **纯函数包不能 import `storage-sqlite`，也不能用任何 node API**
- `speedTrack` 是**要连库**的方法

⇒ **正确的落法**：`apps/api/src/data.ts`（或对应读路径）调 `speedTrack` 取样本 → 把**纯数据**传给 `features` 的纯函数。
⇒ 否则按方案字面实施会直接撞上模块边界（编译不过）。

---

## 5. 行号核对结果（30+ 处，除 P1 外全部通过）

| 引用 | 声称 | 实测 |
|---|---|---|
| `database.ts` 关键位 | `:24-32` / `:1649` / `:1683` / `:1719` / `:1755` / `:1607` | ✅ 全对（`RaiDatabaseOpenOptions` 确在 `:24-32`，含 `createMigrationBackup`/`foreignKeyValidation`） |
| `server.ts` 关键位 | `:336` / `:350` / `:399` / **`:1535`** | ✅ 全对 |
| `worker.ts` 7 处 | `:425/442/462/478/493/538/547` | ✅ **7 处逐一对上** |
| `recompute-thread.ts` | `:7` | ✅ |
| `mobile-coach.ts` | `:741` / `:794` / `:1036` | ✅ |
| `features/src/index.ts` | `:543-547` | ✅（`stabilityRaw` 第 546 行，区间覆盖） |
| `training-zones/src/index.ts` | `:37` | ✅ |
| `recompute-pipeline.ts` | `:1235` | ✅ |
| `api-contracts` | `:665` / `:580-585` | ✅ |
| `mobile-goals.ts` | `:66`（`MAX_READ_ROWS=200`）/ `:453` / `:512` | ✅ |
| `weekly-plan-prompt.ts` | `:5`（v1）/ `:18-35`（SYSTEM_PROMPT）/ `:43-97`（context） | ✅ |
| `NativeViews.swift` | `:1886` / `:1269-1270` | ✅ `:1886` = "今天之前的日期由服务端置为休息…"（改后会成事实错误，判断准确） |
| `TechViews.swift` | `:1178-1179` | ✅（垂直振幅 / 触地时间） |
| `WorkoutDetailPage.tsx` | `:252` / `:259` / `:263` | ✅（`:263` 行内含 `running-form-metrics`） |
| 测试文件 | `mobile-coach.test.ts:109/110`、`weekly-plan.test.ts:465`（`"weekly-plan-v1"`）、`web-flows.test.ts:741/752` | ✅ |
| `import_issues` 表结构 | `severity/code/object_id/message` | ✅ 一致（且当前**空表**） |
| `series-read-repository.ts` 路径 | 缺 `/read/` | ❌ **需修正**（见 P1） |
| `weekly-plan-prompt.ts` 的 context | "完全看不到计划" | ✅ **成立**：context 里只有 `recentWorkouts`（**实际完成**的训练），没有任何"计划了什么/哪天没跑" |

---

## 6. 对方案的净影响：需改 3 处，不改结论

| # | 位置 | 改法 |
|---|---|---|
| 1 | §3.1 第 3 条（探测设计） | "在 `ensureMigrationTable()` 之前" → **"在 `new RaiDatabase(path)` 之前，用独立只读连接（`{readOnly:true}`）探测"** |
| 2 | §3.1 验收表 | "零写库（替换原文件哈希不变）" → **分场景**：refuse 路径用**文件哈希不变**（最强，实测可靠）；apply 路径用**逻辑指纹** |
| 3 | §3.5 / §3.4 落点 | 明确**分层**：`speedTrack` 在 API 读路径（`data.ts`）调用，纯函数在 `features`；并修正 `series-read-repository.ts` 路径为 `read/series-read-repository.ts` |

**新增的观察项（不改结论，但应记录）**：
- 每个写请求 **~1.3 s** 固定开销（`open` 的 checksum 校验 + `prepareStatements`）
- "44.3 s" 仅指**首次** v22；幂等重跑 **~7.5 s**（备份主导）
- `import_issues` 当前为**空表**，`AMBIGUOUS_TRAINING_SESSION_MATCH` 也没有记录 ⇒ 该表从未被写入过

---

## 7. 方法论：为什么这轮才抓到

| 上轮做法 | 本轮做法 | 结果 |
|---|---|---|
| 读代码 → 推断行为 | **写最小复现脚本跑一遍** | 推翻 2 条自己的结论（哈希、`speedTrack`） |
| 用"同类结构"代替真实结构 | **按真实链条复现**（含 `tsx` 与 `prestart`） | 才发现真实链也能透传 78（上轮的"证据"其实不充分） |
| 只核对符号存在性 | **核对路径 + 行号 + 行内容** | 抓到 `read/` 子目录缺失 |
| 未验证"承诺完整性" | 造**非 WAL 库**做边界测试 | 才发现构造函数有副作用 |

⇒ **规则**：凡是"断言某个行为会发生/不会发生"的，必须**构造最小场景跑一遍**；凡引用 `文件:行号` 的，必须**读到该行的实际内容**。

---

*真实检查：小满 🧭 ｜ 2026-09-17 ｜ 6 项可运行实测 + 30 余处行号核对*
