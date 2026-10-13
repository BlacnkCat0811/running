# 直接增量同步：PR4 落地设计（全部类型接收、分析任务登记、短写调度）

日期：2026-10-13，Asia/Shanghai。基线：`5fedc2a` + PR4 步骤 1（本文档同批落地）。
上位设计：[SQLITE_DIRECT_SYNC_DESIGN.md](SQLITE_DIRECT_SYNC_DESIGN.md) §6–§8、§13 PR4、§14。
前序：[SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md](SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md)（PR1–PR3 已实施）。

**状态：步骤 1 已实施并有实测证据（见 §8）；步骤 2–6 是设计，未实施。**
本文所有"现状"断言都落到 `文件:行号`，可逐条复核；**未核实的项在 §9 显式标出**。

---

## 0. 本文档要回答的四件事

1. 直连车道怎么从 `record-only` 扩到**全部正常类型**（Workout、评分类型、删除、路线），
   并且**同批**登记分析任务 —— 而不是"原始已存、分析不更新"。
2. 分析任务怎么"真正跑分析"而**不长期占写锁**（§6 的许可表），今天它占的是什么。
3. §7 的固定输入版本（代次）在今天的代码里具体要接哪几根线，哪些部分 PR4 **不做**（留给 PR5）。
4. 每一步的验收判据与**突变靶子**，以及本环境给不了的项。

---

## 1. 现状锚点（设计必须绕着走的事实）

| 事实 | 位置 | 对设计的影响 |
|---|---|---|
| 旧链路把 recompute 跑在**暂存副本**上（子进程 + `--database stagingDatabase`） | `apps/api/src/import-worker.ts:696-710` | 换成"主库上的分析任务"必须自带**版本化输入**，不能直接读当前表 |
| 分析消费者：`claimNext()` → `pipeline.runXxx(job)` → 失败则 `jobs.fail` | `packages/application/src/service.ts:283-311` | 已加 `import` 分支（步骤 1）；准入判据是 `(job_type, 载荷 mode)` 合取 |
| 分析**今天已经跑在主库上**：`recompute-thread.ts` 以 `migrationPolicy: "refuse"` 打开主库后 `runNextJob()` | `apps/api/src/recompute-thread.ts:7-12` | "主库上分析"不是新东西；**新的是**不占长写锁 + 读固定版本 |
| 写许可是**整段 drain**：`admission.acquire()` 在 spawn 之前拿到，直到 `finally release()` | `apps/api/src/recompute-worker.ts:64`、`102-104` | §6 要拆的正是这一段；spawn 本身实测 ~2.5 s（同文件注释） |
| 单写者闸门 = `MutationCoordinator`（一次只允许一个 operation 名） | `apps/api/src/mutation-coordinator.ts:11-25` | 接收侧与分析侧共用它；"接收优先 + 分析最小份额"要在这一层设计 |
| 接收侧自己也是一个 owner：`admission: taskAdmission.owner("import")` | `apps/api/src/server.ts:475` | 两个 owner 并存 ⇒ 今天的实际语义是"谁先拿到谁独占到底" |
| `job_type` 的 `CHECK` 只有三值；v35 只加了**可空绑定列** | `packages/storage-sqlite/src/database.ts:484`、`packages/storage-sqlite/src/v35-migration.ts:61-64` | 分析任务仍是 `'import'`；判别靠载荷 `mode`（步骤 1 的合同） |
| 代次计数器 `import_generations(singleton, raw_generation, dependency_generation)` 只有 schema | `packages/storage-sqlite/src/v34-migration.ts:42-49` | **没有写入方**⇒ 数值版本号今天不存在（回执刻意不承诺，见 `packages/contracts/src/direct-sync.ts:60-67`） |
| 稀疏历史 `import_fact_history`（`record`/`workout`）也只有 schema | `packages/storage-sqlite/src/v34-migration.ts:27-40` | 分析"读固定 G"缺的是**写入方**，不是读取方 |
| `FactsReader` 已实现，但**无生产调用方**，且只覆盖 update、不覆盖 delete（裁决 D1） | `packages/storage-sqlite/src/read/facts-reader.ts:97-137`、同文件 29-35 | PR4 接它时必须同时定掉"删除是否要在旧代次可见" |
| 局部 canonical 已实现：`canonicalizeNightsForWindow` 不做 DELETE/事务，由调用方按作用域处理 | `packages/health-export-parser/src/canonicalize-nights.ts:250-261` | 直连车道可以调它；**谁调、在哪个事务里调**是 PR4 要定的 |
| 既有 `canonicalizeNights` 仍整表 `DELETE` 重建 | `packages/health-export-parser/src/canonicalize-nights.ts:333` | 旧链路不变；直连车道不许走它（§14.1 已把它列为禁止操作） |
| 路线版本 API 已就绪：`beginRouteVersion` / `publishRouteVersion`（发布段自带 SAVEPOINT） | `packages/storage-sqlite/src/database.ts:2613`、`2665`、`2672` | 路线"不发布半条"是现成能力；直连车道接上即可 |
| record-only 车道的两道闸门：类型白名单 + XML 形状 | `apps/api/src/data-only-import.ts:102`、`119` | 扩到全部类型时**不许放宽这两道**，要新增并列车道 |
| 解析器的 `recordDelta` 资格：`atomic !== false && recordIdentity && preserveAbsent && isDataOnlyRecordXml` | `packages/health-export-parser/src/apple-health-parser.ts:309-312` | 新车道不能复用 `recordDelta` 的资格判定（它是 record-only 专用） |
| `transactionOwner: "caller"` + SAVEPOINT 已实现（组件提不了、flush 抛错、LIFO 强制） | `packages/storage-sqlite/test/transaction-owner.test.ts`（8 条） | 解析器进"上层持有的事务"有机械保证可用 |

---

## 2. 步骤 2 设计：车道扩到"全部正常类型"

### 2.1 载荷分类：`analysis_required` 必须**默认成立**

新增纯函数（不读库、不写库、不看时间）：

```ts
export type DirectSyncPayloadClass = "record-only" | "analysis-required";
export function classifyDirectSyncPayload(input: {
  recordTypes: readonly string[];      // 本批 XML 出现的 record 类型
  hasWorkout: boolean;                 // 出现 Workout 元素
  hasRoute: boolean;                   // 出现 GPX / WorkoutRoute
  deletedRecords: number;              // manifest.deletedRecords.length
  deletedWorkouts: number;             // manifest.deletedWorkoutIds.length
}): DirectSyncPayloadClass;
```

🔴 **判据的默认方向**：只有**证明了**"本批一个评分类型、一个 Workout、一条路线、一条删除都没有"才允许
`record-only`（⇒ `analysisStatus: "not_required"`）。任何未知、无法判定、将来新增的类型一律
`analysis-required`。理由：§9.1（读取不能把旧分析标成最新）的代价是"分析落后"，而反向
（该分析却宣布 `not_required`）的代价是**用户看到与事实不符的当前结论**。两者不对称，默认值必须偏向分析。

突变靶子：把未知类型默认成 `record-only` ⇒ 新增的"未知类型必须分析"用例转红。

### 2.2 事务所有权：解析器进入**调用方持有**的事务

今天 parser 的 `atomic` 路径是"组件自己 `BEGIN`/`COMMIT`"（`beginAtomicImport` / `commitAtomicImport`），
而 PR2 已让这两个方法在 `caller` 模式下**抛错**。新增选项：

```ts
// packages/health-export-parser/src/apple-health-parser.ts
callerOwnedTransaction?: boolean;
```

语义（每一条都要有断言）：

- `true` 时**不**调用 `beginAtomicImport` / `commitAtomicImport`；批次边界用 `store.savepoint(name)`
  / `store.releaseSavepoint(name)` 表达，**不产生新的提交点**。
- 上层（`DirectSyncIngestWorker`）负责 `BEGIN IMMEDIATE` 与 `COMMIT`；解析器任何路径都不得提交。
- `callerOwnedTransaction: true` 与 `recordDelta` **互斥**（后者的资格判定要求 `atomic !== false`）：
  两个一起传直接抛错。这条把"record-only 车道的行为零变化"钉成结构事实，而不是靠人记得别混用。

### 2.3 写守卫按载荷类别**分档**，不是放宽

`installWriteGuards`（`apps/api/src/data-only-import.ts:54-79`）当前是"除白名单外一律 ABORT"。
新车道要写更多表（`workouts` / `training_sessions` / `workout_routes` / `route_versions` /
`route_version_points` / `canonical_nights` / `canonical_hrv_days` / `import_entity_changes` …），
但**分档**必须体现在守卫上：

- `record-only` 档：与今天**逐字节相同**的白名单（不许因为"新车道也能写别的"而放宽）。
- `analysis-required` 档：白名单 + 本批声明要写的表；**仍然**拒绝 `recompute_jobs` 以外的
  发布类写入（`active_model_run` / `model_runs` / `feature_runs` 一律禁止在本事务里写）。

突变靶子：把分档参数写死成"全部允许" ⇒ "直连接收事务不得写发布表"用例转红。

### 2.4 路线：只发布本条，且**只在整条补齐后**移动指针

复用 PR3 已落地的版本 API：分片写 `route_version_points`（`status='pending'`，对读侧不可见）→
点序 / 点数 / `content_sha256` 校验通过 → `publishRouteVersion` 在 SAVEPOINT 内原子移动
`workout_routes.published_route_version_id`。缺口（配额拒绝 / 解析失败）按 ADR-004 落 pending，
**不动**旧路线。

⚠️ 与 PR2/PR3 同一处已知边界：过渡期发布时**真双写** `route_points`（F1/NEW-2 的处置），
PR5 让读侧改走版本表后 `route_points` 退役。这条双写是**临时**的，必须在 PR5 的验收里被删掉，
否则"版本表"会变成第二份真相。

### 2.5 同一事务内登记分析任务（§4.2）

`beforeCommit` 内、**同一个主库事务**里做四件事（顺序即依赖顺序）：

1. `UPDATE import_generations SET raw_generation = raw_generation + 1`（本批事实版本）。
2. 若 `analysis_required`：再 `dependency_generation = dependency_generation + 1`。
3. `jobs.enqueue("import", datasetVersion, {
     mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
     evaluatedAt, importBatchId, incrementalPlan: { mode: "partial", dirtyFromAt }
   }, {
     targetRawGeneration, targetDependencyGeneration,
     expectedIncumbentReleaseId: <读自 active_model_run>,
     dirty: { entityKinds, beforeAfterTimes }
   })` —— `enqueue` 不自开事务（`packages/storage-sqlite/src/recompute-job-repository.ts:46-90`），
   正好可以放在这里。
4. 回执的 `analysisStatus: "queued"`（**不是** `"published"`），`dependencyGeneration: String(n)`。

🔴 **门禁**：一条断言钉住"`deltaMode === "full"` 时回执里必须存在已登记的任务" ——
即"登记"与"放开车道"不可能分两次悄悄落地。

### 2.6 代次写入方：只对**本批碰到的实体**打标（§4.3）

- 事务内按 `import_entity_changes`（本批账目）逐实体写 `valid_from_generation = <新 raw_generation>`，
  **不做全库 seed**（`seedImportGenerations` 在 §14.1 是禁止操作）。
- 更正的实体在覆盖前把旧内容写进 `import_fact_history`（`valid_to_generation = <新 raw_generation>`）。
- ⚠️ 裁决 D1 的边界**在此处兑现或改写**：`import_fact_history` 只覆盖 update。删除要不要在旧代次
  可见，必须在本步**定掉**（`FactsReader` 的边界用例会先红）。
- 老库/老行 `valid_from_generation IS NULL` 继续解释为"自古以来有效"（`facts-reader.ts` 的既定口径），
  所以老数据不需要回填也能被读。

---

## 3. 步骤 3 设计：分析消费与短写调度（§6）

### 3.1 今天占的是什么锁

`RecomputeWorker.drain()` 在**spawn worker 之前**取得 admission，直到整轮 drain 结束才释放
（`apps/api/src/recompute-worker.ts:64`、`102-104`）。也就是说：CPU 计算的每一毫秒都持着写许可，
而同一时刻 API 的任何写路由都会拿到 `mutation_conflict`（`mutation-coordinator.ts:3-8`）。
§6 的许可表要求的是：

| 阶段 | 目标许可 |
|---|---|
| 解析 / 读固定版本数据 | 不持有长期写许可 |
| 计算 canonical / 特征 / 评分 | 不持有写许可（在 worker 里算） |
| 原始提交、候选分析行分块落地、最终指针发布 | 各自**短**写事务 |

### 3.2 机制：把"写许可"从 drain 全程缩到**每个短写窗口**

- 新增 `WriteLease`（同一 `TaskAdmissionScheduler` 之上）：`withWriteLease(fn)` 在 `fn` 期间
  `admission.acquire()`，退出即 release（`finally`，含抛错）。
- `RecomputePipeline` 的写点按阶段分组，每组包一个 `withWriteLease`：
  1. `createFeatureRun` + 特征分块写；
  2. `createTrainingMetricRun` + 指标分块写；
  3. `createModelRun` + 时间线重放写；
  4. 发布指针（`verifyAndPoint`，`model-release-repository.ts:89-91`）。
- **跨窗口的一致性靠"未发布"而不是长事务**：读侧只认 `succeeded` run + `active_model_run`
  指针（`packages/storage-sqlite/src/database.ts:932-938` 一类视图），所以中间态对读侧不可见。
  这一点必须由**一条读侧用例**钉住（分析跑到一半时读到的仍是旧 release）。
- 接收优先：接收侧仍用 `owner("import")` 的名字拿同一个闸门；分析侧在两次租约之间让路
  （§6 的"给分析落地最小服务份额避免饿死"= 允许分析侧在**没有接收任务排队**时优先，
  而不是无限提高 `busy_timeout` 去抢）。
- ⛔ 不做：把 `busy_timeout` 调大来掩盖竞争（§6 明令）。

⚠️ **未决（必须在步骤 3 动工前定掉）**：pipeline 内部是否存在"跨阶段未提交写的相互依赖"
（例如某阶段读回上一阶段刚写的候选行）。同一连接内可见，所以分块提交在**单进程**语义下成立；
需要逐点核对后再动手（§9 未决 1）。

### 3.3 空队列不启动计算 Worker

已具备：`hasPendingJob()` 在 spawn 之前早退（`apps/api/src/recompute-worker.ts:75`）。
步骤 3 必须**保留**它（否则拆锁会把"空转 spawn 2.5 s"重新引入）。

---

## 4. 步骤 4：局部 canonical 接入

直连车道**不许**调用整表重建的 `canonicalizeNights`（`apps/api/src/data-only-import.ts` 的
禁止操作清单里已列）。接入点与作用域：

- 本批触及的睡眠/HRV 类型 ⇒ 由账目算出受影响**夜**（含跨夜：窗口边界按
  `canonicalize-nights.ts:250-261` 的"开始与结束都算"口径）。
- 在**接收事务内**调用 `canonicalizeNightsForWindow(...)`（受本批窗口限制，保持有界）。
- 窗口外的 canonical 行必须**逐字节不变**（PR3 已有等价判据，直连车道复用同一条）。

⚠️ 未决（§9 未决 2）：canonical 重建放在**接收事务内**还是**分析任务内**。放接收侧的理由是
"回执代表一个自洽的原始状态"；放分析侧的理由是"canonical 是派生事实，不该拖长接收事务"。
本设计**暂定接收事务内**（有界窗口），但需要在步骤 4 用实测（P01 的 p95 预算）复核。

---

## 5. 明确不做（留给 PR5 / PR6）

- `currentFacts` / `publishedAnalysis` 的读侧拆分、`route_versions` 的读侧消费、删除的读侧隐藏、
  "今日处方/锁课/手表导出"的新鲜度检查：**全部 PR5**。
  现状盘点见 `docs/SQLITE_DIRECT_SYNC_DESIGN.md` §9.1 与当轮侦察报告
  （`var/reports/pr5-recon.md`，191 行，逐条 `file:line`）。
- iOS/桌面状态文案、旧 backup/candidate/swap 退场、`deploy/upgrade.sh` 去掉 `POST /v1/backups`：
  **PR6**（当轮侦察：`var/reports/pr6-recon.md`，299 行，备份入口调用点 25 处）。
- Rust native `apply-records` 的 permit 放宽：§13 明令首版复用 TS 主写，**不做**。

---

## 6. 验收判据（对应 §14.2 的条目）

| 编号 | 本步要过的判据 | 突变靶子（必须能变红） |
|---|---|---|
| A01 | Workout / 评分类型 / GPX / 混合包各一条，全部**直接写主库**且 §14.1 十条禁止操作为 0 | 把 `classifyDirectSyncPayload` 的 Workout 判成 record-only |
| A03 | 删除先于到达 / 共享 UUID / 旧 XML 桥接 / 删除-only 四种身份与删除保护 | 去掉 tombstone 登记 |
| A04 | 写入点逐点故障注入 ⇒ 事实/身份/账本/代次/**任务**/回执**全部回滚** | 把 `enqueue` 挪到 `beforeCommit` 之外 |
| A06 | 同批同内容重放安全；同批不同内容/错误作用域明确拒绝 | 去掉 receipt 的 payload 比对 |
| A08 | 大包按稳定原子单元分批；父批未全成不提交最终游标 | 让子批回执提前返回 committed |
| A10 | 分析失败不撤销已接收事实 | ✅ 已落地（2026-10-13，见 §8.5）；突变靶子=`fail()` 回写 raw 回执 |
| A11 | CPU 分析期间仍可接收新批次（写锁只覆盖短事务） | 把 `withWriteLease` 换回 drain 全程持锁 |
| A13 | 迟到任务不倒退 active 版本；配置变化使不合格候选拒绝发布 | 去掉 `expected_incumbent_release_id` 比较 |
| A18 | 只新增迁移、不改历史 checksum；不引入 PostgreSQL/Redis | 改 v34/v35 的 `up` |

性能（P01–P06）**本环境给不了**：需要目标云机、隔离脱敏数据集与 200 个有效样本
（§14.4 明令不得用开发机空库替代）。本轮**不宣称**任何 P 项达标。

---

## 7. 实施顺序（每步都能单独跑绿）

| 步 | 内容 | 单独绿的判据 | 状态 |
|---|---|---|---|
| 2a | 载荷分类纯函数 + "未知必须分析"门禁 | 新用例（无行为变化） | ✅ 已完成（2026-10-13，见 §8.1） |
| 2b | parser `callerOwnedTransaction` + SAVEPOINT；与 `recordDelta` 互斥 | 结构判据 + record-only 车道零变化 | ✅ 已完成（2026-10-13，见 §8.2） |
| 2c | 写守卫分档（先只放 Workout/删除，`analysis_required` 仍走旧路） | 守卫扩展用例 | ✅ 已完成（2026-10-13，见 §8.3） |
| 2d | 同事务登记 + 代次写入方 + 回执 `queued` | A04 故障注入 + 账本断言 | ✅ 已完成（2026-10-13，见 §8.3） |
| 2e | **放开 `deltaMode: "full"`**（三步顺序的第 3 步） | A01 全类型 + 禁止操作 0 | ✅ 已完成（2026-10-13，见 §8.4） |
| 3 | 短写租约拆分（§6） | A11 并发用例 + 读侧"中间态不可见" | ⛔ 未做 |
| 4 | 局部 canonical 接入 | 窗口外逐字节不变 | ⛔ 未做 |

⛔ 顺序不可交换：2e 之前必须先有 2d（登记），2d 之前必须先有消费者（**步骤 1，已完成**）。
✅ 2026-10-13：2a–2e 全部落地。剩下的 3（短写租约）与 4（局部 canonical）互不依赖，可并行。

### 7.2 🔴 2e 的新增前置：PR5-S1 + S2（2026-10-13 实测确认）

放开 `deltaMode: "full"` 意味着生产开始接收 Workout / 评分类型 / **删除**。而读侧今天还不能
区分"当前事实"与"已发布分析"，于是两类后果会直接对用户可见：

1. **删除之后旧负荷仍然计入当天汇总**：一批删除落地后，`active_workout_training_loads` 里的旧行
   仍被 `apps/api/src/data.ts` 的今日/周/统计查询统计（那几条 SQL **不 JOIN** `workouts`）。
2. **删除会级联销毁已发布路线的版本内容**（本轮实测复现，不是推断）：

```text
before: workouts=1 workout_routes=1 route_versions=1 route_version_points=2
DELETE FROM workouts WHERE id='w1'
after : workouts=0 workout_routes=0 route_versions=0 route_version_points=0
```

外键链是 `workouts --CASCADE--> workout_routes --CASCADE--> route_versions --CASCADE--> route_version_points`
（`packages/storage-sqlite/src/database.ts:211`、`packages/storage-sqlite/src/v35-migration.ts:24`、`:35`），
`published_route_version_id` 的 `NO ACTION` **拦不住级联**。这直接违反 §7「删除优先留
inactive/tombstone 身份…不让 raw FK 级联删掉不可变 release 所需的证据和路线」。

⇒ 因此 **2e 的前置是 [PR5 设计](SQLITE_DIRECT_SYNC_PR5_DESIGN.md) 的 S1（事实侧排除已删）
+ S2（`workouts.deleted_at` 软删标记）**。这不是"顺手优化"，而是"删掉一个训练会连带毁掉
它的已发布轨迹证据"这条**今天就存在**的缺陷的修复；不修就放开车道，等于把缺陷扩大到
每一条删除批次。

⚠️ 与 2e 的关系是**顺序**关系，不是"2e 可以顺手做 S1/S2"：S1/S2 必须在 2e 之前单独跑绿
（PR5 设计 §5 给了各自的判据）。

✅ **2026-10-13：S1 + S2 已落地**（与本文档的 2c/2d 同轮，证据见
[PR5 设计 §5.1](SQLITE_DIRECT_SYNC_PR5_DESIGN.md)）：`workouts.deleted_at` 软删（v36）、
唯一存在性判据 `workoutPresentConditionSql()` 覆盖全部事实侧读路径、C3/C7 两条判据转绿、
3 处突变被精确捕获。⇒ **2e 的前置清单已清空**，放开 `deltaMode: "full"` 只剩它自己的验收。

### 7.1 撰写后修订（2026-10-13，实施 2a/2b 时定下）

**修订一：分类事实的来源改为"批次账本"，不是第二遍 XML 扫描。**
§2.1 初稿把 `DirectSyncPayloadFacts` 写成"XML 扫描结果"。实施时改定为：这些事实在**事务内**从
本批自己的账本取 —— 实体种类/数量从 `import_entity_changes`（`entity_kind`）、类型从
`health_records.type`、删除从 manifest 与 tombstone 表。理由：
XML 扫描是**第二套解释**，它与真正落库的解析器只要有一处不一致（大小写、属性缺失、
未来的新元素），分类就会与事实脱节，而且是**静默**的。账本是本批写入的**自身结果**，
不存在"两套解释分叉"。
纯函数 `classifyDirectSyncPayload` 的签名因此不变（它只吃事实），变的是**谁来喂它**。
⇒ 2c 落地时的要求：分类必须在事务内、基于账本，并且**默认分析**（账本读不出来也算"拿不准"）。

**修订二：写守卫的判据是"这张表属不属于本次接收"，不是"本批是不是 record-only"。**
初稿把守卫分档挂在"载荷类别"上。实施时改定为：守卫只回答一个问题 ——
**本事务允许写哪些表**。事实类表（records / workouts / routes / canonical / 账本 / tombstone）
允许，**发布与分析类表**（`model_runs` / `feature_runs` / `active_model_run` / `training_metric_runs` 等）
一律拒绝。理由：载荷分类是**事后的**结论（要等账本），而守卫必须在**写入发生之前**就位；
把它挂在事后结论上，等于守卫在写入时还不知道自己的档位。

---

## 8. 步骤 1 的实测证据（2026-10-13）

**已落地**（"三步上线顺序"的第 1 步：消费者先认识 `import`）：

- `packages/contracts/src/index.ts`：新增 `CLI_OWNED_IMPORT_REQUEST_MODE`（`cli_export_import`）、
  `DIRECT_SYNC_ANALYSIS_REQUEST_MODE`（`direct_sync_analysis`）、`RECOMPUTE_JOB_TYPE_DISPOSITIONS`、
  `PAYLOAD_SCOPED_JOB_OWNERSHIP`、`recomputeRequestMode`、`isApplicationConsumableJob`。
  **判据是 `(job_type, 载荷 mode)` 的合取**，唯一实现被恢复流程与消费者**共用**。
- `packages/storage-sqlite/src/recompute-job-repository.ts`：`recoverInterrupted()` 读 `request_json`
  并按该合取判据分派 ⇒ CLI 载荷中断即失败（文案不变），直连载荷中断**回到队列**（§10.1 重启恢复）。
- `packages/application/src/service.ts:293-306`：消费者在**分支之前**做准入判定，拒绝时给出
  "不属于这个消费者 + 是哪种载荷"的原因；`import` 分支调用 `RecomputePipeline.runDirectSyncAnalysis`。
- `packages/application/src/services/recompute-pipeline.ts`：新增 `runDirectSyncAnalysis`
  （复用同一套 feature/metric/model 计算与全部发布 gate；代次绑定留给步骤 2d）。
- `packages/health-export-parser/src/cli.ts:321-343`：CLI 任务写**共享常量**而不是字面量
  （两边写字面量会让判别悄悄分叉 —— 分叉的后果是"消费者把 CLI 导入任务当分析任务跑"）。

**实测**（本机，`node --import tsx --test --test-concurrency=1`）：

| 用例 | 结果 |
|---|---|
| 直连分析载荷被消费者**真正执行**（终态 `succeeded`、feature/model run 落地、`active_model_run` 移动） | ✔ |
| CLI 载荷被拒绝且**零分析产物**（`feature_runs`/`model_runs` 均为 0），原因点名 `cli_export_import` | ✔ |
| `deltaMode` 仍为 `record-only`；回执 `analysisStatus` 仍为 `not_required` | ✔ |
| 恢复：CLI 载荷 ⇒ `failed/interrupted`（保留原因）；直连载荷 ⇒ `queued`；未知载荷 ⇒ **不放行** | ✔ |
| 结构约束：DDL 的每个 `job_type` 都有意表态，且判别函数与声明逐项一致（含未知类型默认不放行） | ✔ |
| 直连车道跑完 `recompute_jobs` 计数为 0（行为级钉住"今天没有登记"） | ✔ |
| `tsc --noEmit`（`tsconfig.pure.json` + `tsconfig.json`） | EXIT=0 |

**突变验证（3 处，全部被精确捕获）**：

1. `isApplicationConsumableJob` 的载荷白名单改成"默认放行" ⇒ 恢复文件 3 条转红：
   CLI 载荷被判给消费者、"未知载荷不放行"失败、结构约束点名 `cli_export_import` 不得放行；
   同时 API 侧"CLI 载荷被拒绝"转红。
2. 删掉 `RECOMPUTE_JOB_TYPE_DISPOSITIONS` 的 `import` 条目 ⇒ 结构约束转红
   （"新增了既没有消费者、也没有声明外部所有者的 job_type"），且直连载荷的中断恢复用例转红。
3. 删掉消费者里的准入判定 ⇒ "CLI 载荷被拒绝且不跑分析"转红。

**同轮发现并修掉的既有缺陷（在测试自身）**：`recompute-job-recovery.test.ts` 原有 4 条用例的
测试体是 `() => { withJobs(...) }`（同步体调异步助手），失败会以
`asynchronous activity after the test ended` 形式变成**未处理拒绝**：报告里它们仍然打印 ✔，
只有文件级失败。突变 1 第一次跑就复现了这个形态（3 条断言失败，却只有 1 条文件级红）。
已全部改为 `async () => { await withJobs(...) }`，突变因此能被**逐条**定位。

**全量套件（本机）**：Node 套件 1676 tests / **1672 pass / 1 fail** / 3 skipped，
唯一失败是 `apps/api/test/node-version.test.ts` 的生命周期用例 —— 本机 Node 运行时**没有 `npm`**
（`command -v npm` 退出码 1），`spawnSync("npm", …)` 得到 ENOENT，**与本批改动无关**
（本批未碰 `package.json` 与 `scripts/check-node-version.mjs`）。Web 套件单独跑 **184/184 pass**
（全量跑时 `share-card-panel.test.tsx` 有一次负载下的 `waitFor` 超时，单跑 17/17）。
⇒ 本环境的等价门禁命令是 `node node_modules/typescript/bin/tsc --noEmit -p <tsconfig>` 与
`RAI_TEST_CONCURRENCY=1 node scripts/run-tests.mjs`（详见当批验收记录）。

### 8.1 步骤 2a 的实测证据（2026-10-13）

- `packages/contracts/src/index.ts`：`scoringHealthTypes` 的**唯一定义**移到这里
  （此前在 `apps/api/src/health-change-plan.ts`，那里改为转发）。理由：它同时是批次分类、
  record-only 车道结构闸门、`dataOnlyBaselineContract()` 哈希的输入 —— 三处各写一份
  等于允许"只改一处就造出**该分析却宣布不需要分析**"。取值与顺序**逐字未变**，
  所以基线哈希不变（`data-only-import.test.ts` 的既有断言继续通过）。
- `packages/health-export-parser/src/record-delta-policy.ts`：新增
  `classifyDirectSyncPayload(facts)` 与两个类型。**默认方向 = 必须分析**：
  未知类型 / 评分类型 / Workout / 路线 / 显式删除 各自单独成立就要求分析；
  只有"全部类型都在非评分白名单里且什么都不碰"才允许 `record-only`。
  输出**排序**（同样输入逐字相同），便于落库与比较。
- 新用例 `packages/health-export-parser/test/direct-sync-payload-class.test.ts`（9 条）
  含三条结构前提：两个清单不得有交集、都不得为空、评分清单只能由 `healthTypes` 常量构成。
- **突变验证**：把未知类型从原因里去掉（= 默认放行）⇒ **3 条转红**
  （"未知类型一律必须分析"、"白名单 + 未知"，以及确定性用例），其余 6 条仍绿。

### 8.3 步骤 2c/2d 的实测证据（2026-10-13）

**已落地**：`apps/api/src/direct-sync-ingest.ts`（统一原始接收器）+ 数据库任务 operation
`"direct-sync"`（`apps/api/src/import-database-tasks.ts` / `import-database-thread.ts`）。

- **一个事务里做完**：`RaiDatabase.open({ transactionOwner: "caller" })` → `PRAGMA synchronous=FULL`
  → `beginCallerTransaction()` → 解析（`callerOwnedTransaction: true`）→ GPX 路线 → 训练会话局部
  规范化 → 代次递增 → 登记分析任务 → 回执/批次/清单 → 回读断言 → `commitCallerTransaction()`。
  失败路径整体回滚。
- **写守卫按表分类**：`INGEST_TABLE_DISPOSITIONS` 给生产 DDL 的**每一张表**表态（`ingest` / `analysis`），
  `analysis` 类表装 TEMP 触发器一律 `RAISE(ABORT)`；**未表态的新表会让守卫拒绝安装**（fail-closed）。
  另有"事实写入全程记账 + 提交前逐条核对账本"的断言。
- **登记与回执一致**：`analysis-required` ⇒ 同事务 `enqueue("import", …, { mode: "direct_sync_analysis" }, bindings)`
  + `dependency_generation` 递增 + 回执 `analysisStatus: "queued"`；`record-only` ⇒ 不登记 + `not_required`。
  提交前断言：任务存在、状态 queued、绑定代次等于刚递增的值、载荷 mode 正确；**反之若声称
  `not_required` 却登记了任务，直接抛错**。
- **回执不承诺不存在的版本号**：`dependencyGeneration` 现在有真实写入方（`import_generations`），
  所以回执填 `String(n)`；`publishedReleaseId` 仍为 `null`（分析还没跑，说 published 是假话）。

**同轮修掉的两个"组件擅自开事务/提交"**（都是实测撞出来的，不是设想）：
1. `PRAGMA synchronous=FULL` 必须在 `BEGIN` **之前** —— 放进事务里会报
   `Safety level may not be changed inside a transaction`，让**每一批**都失败；
2. `importGpxRoutes` / `native-record-writer` 直接调 `store.flush()`，在 caller 模式下抛错，
   报错看起来像"事务配置错了"。新增**公开**的 `flushIfOwned()` / `rollbackIfOwned()`
   （"按所有权提交"：store 模式提交、caller 模式什么都不做），并给
   `canonicalizeRunningWorkouts` / `canonicalizeNightsForWindow` 增加
   `{ callerOwnedTransaction: true }`（边界从 `BEGIN` 变成 SAVEPOINT，见
   `packages/health-export-parser/src/owned-transaction.ts`）。

**实测**：新用例 9 条全绿（`apps/api/test/direct-sync-ingest.test.ts`），含：
record-only 无任务 / Workout 登记**并由真消费者跑完**（闭环）/ 删除-only / GPX 路线（版本表 + 指针）/
超限与杂物载荷不合格且零写入 / 写守卫逐条拒绝 + 事实表阳性对照 / 未表态表 fail-closed /
**回执写入点故障注入 ⇒ 事实、批次、任务、账目、代次、回执整批回滚**（随后清掉注入还能重收同一载荷）/ §4.3 无资格 stamp 也可走直连。
回归：parser 包 **146/146**、API+storage **80/80**、`tsc`（pure + full）EXIT=0。

**突变验证（3+1 处，全部被精确捕获）**：
① 忽略分类恒判 `not_required` ⇒ 3 条转红（其中 GPX 用例**第一次假绿**，已补"路线批次也必须登记任务"的断言）；
② 车道内不装写守卫 ⇒ 6 条转红（账本核对因缺临时表而失败）；
②b 只跳过 `analysis` 表触发器 ⇒ "写守卫"用例转红；
③ 失败路径不回滚 ⇒ A04 用例的整批回滚断言转红。

### 8.2 步骤 2b 的实测证据（2026-10-13）

- `packages/health-export-parser/src/apple-health-parser.ts`：新增
  `callerOwnedTransaction?: boolean` 与导出常量 `CALLER_OWNED_PARSE_SAVEPOINT`。
  语义：不 `BEGIN`/`COMMIT`/`ROLLBACK`、不 `flush()`/`rollback()`；批次边界是
  `store.savepoint("rai_parse_batch")`，成功 `releaseSavepoint`，失败 `rollbackSavepoint`。
  与 `recordDelta`、`atomic: false` **互斥**（在函数最前面判定，先于资格检查与任何写入）。
- **失败路径不得换掉真因**：收尾的 `rollbackSavepoint` 包在 `try/catch` 里（F4 的教训）。
  泄漏的 savepoint 也不构成静默提交风险 —— 调用方的 `commitCallerTransaction()`
  会因栈非空**拒绝提交**并点名它（该行为由 `transaction-owner.test.ts` 钉住）。
- 新用例 `packages/health-export-parser/test/caller-owned-transaction.test.ts`（4 条）：
  ①两种所有权互斥；②**第二个连接**在 commit 前看不到、commit 后看得到（= 解析器没提交），
  且解析后能重新拿到同名 savepoint（= 没泄漏）；③截断 XML 失败后，调用方**失败前与失败后**
  的写入都能提交，而半批事实**一行不落**；④在非 caller 模式的 store 上要求该模式 ⇒ 响亮拒绝。
- **突变验证（3 处，全部被精确捕获）**：
  ①分类器忽略未知类型 ⇒ 2a 的 3 条转红；
  ②解析器在成功路径上自己 `commitCallerTransaction()` ⇒ "commit 前第二个连接看不到"转红
  （断言语义：*commit 之前第二个连接就看到了行 ⇒ 解析器自己提交了*）；
  ③失败路径把 `rollbackSavepoint` 换成 `releaseSavepoint`（保留半批）⇒
  "半批事实一行不落"转红。
- 回归：`packages/health-export-parser/test/*` **146/146**、受影响的 API 侧 6 个文件 **70/70**、
  `packages/contracts/test/*` + `application/test/service.test.ts` **49/49**；`tsc`（pure + full）EXIT=0。

---

### 8.4 步骤 2e 的实测证据（2026-10-13）

**改了什么**

| 项 | 位置 | 说明 |
|---|---|---|
| 车道判据 | `apps/api/src/direct-sync-plan.ts` | `deltaMode` 由 `"record-only"` 放开为 `"full"`：车道**能装下**任意增量载荷，批次是否需要分析由账本决定（不是车道决定） |
| 车道接线 | `apps/api/src/import-worker.ts` | record-only 快通路拒收之后，投递 `direct-sync` 数据库任务（统一接收器），**两条都拒收**才回退旧候选链路；`fastPathAttempted` 到最后才清零，所以"已提交但回执没送到"仍可从持久回执恢复 |
| 计时账本 | `packages/api-contracts/src/index.ts` | `ImportStage` 增加 `directSyncApply`：两条子车道分别计时，否则"直连变慢了"定位不到是哪一条 |
| 载荷身份 | `apps/api/src/direct-sync-ingest.ts` | 🔴 **修掉一个真缺陷**：接收器原先用 `digestHealthKitRecordSnapshot`（只算 XML+manifest）复核，而 worker 的准入摘要用 `digestHealthKitExportContent`（折进 `workout-routes/**`）。两者不一致 ⇒ **任何带 GPX 的载荷**都会在这句话上硬失败（`Direct sync payload changed after admission`，不是回退）。现在两侧同源 |
| 输入目录 | `apps/api/src/direct-sync-ingest.ts` | `inputTreeAllowed` 收紧为"顶层 XML+manifest，加上 `workout-routes/**/*.gpx`" —— 与摘要覆盖范围、与 `allGpxRelativePaths` 的发现范围**逐项对齐**；从前允许任意位置的 `.gpx`，那些文件既不入摘要也不会被导入 |

**实测**

- 新增端到端用例 `apps/api/test/import-worker-direct-sync.test.ts`（**2/2**）：真实排队 → 车道判定 →
  快通路拒收 → 统一接收器（真实子进程 + 真实事务）。断言：事实落库、`training_sessions` 生成、
  `recompute_jobs` 恰好一条（`job_type='import'`、`status='queued'`、载荷 mode
  `direct_sync_analysis`、两个代次都为 1、`dirty_json.reasons` 含 `workout_present`）、
  回执 `analysisStatus='queued'` 且与终态摘要一致、`import_batches.summary_json.analysisJobId` 对上、
  无备份 / 无换库 / 主库 inode 不变。
- 带 GPX 的回归用例（同一文件第二条）：`route_versions` 发布一条 complete、`route_version_points` 两点、
  `dirty_json.reasons` 含 `route_present` —— 这一条就是上面那个摘要缺陷的守卫。
- `apps/api/test/direct-sync-prohibited-operations.test.ts` 新增 **full 车道**的 §14.1 用例：
  同一套守卫仪器（方法/子进程/任务/阶段四类通道）在 Workout 载荷上"全 0"，
  且断言投递序列恰为 `["data-only", "direct-sync"]`。
- 门禁用例更新：`direct-sync-plan.test.ts`（`full` + 顺序）、
  `direct-sync-analysis-registration.test.ts`（新增"放开判据 ≠ 接上车道"的源码判据、
  回执与登记的双向提交前断言）。**回执语义从车道级细化为批次级**：
  record-only 载荷仍必须 `not_required`，动了分析的批次必须 `queued`。

**突变验证（3 处，全部被精确捕获）**

| # | 突变 | 结果 |
|---|---|---|
| 1 | worker 不再投递 `direct-sync` | 两条端到端用例转红（载荷掉回旧候选链路并撞上"不得整库备份"的守卫） |
| 2 | 接收器复核退回"只算 XML+manifest" | **带 GPX** 的用例转红，无 GPX 的仍绿（正是缺陷的形态） |
| 3 | 回执恒写 `not_required` | 两条端到端用例转红（"登记了任务却声称分析不必要"） |

**如实标注的边界**：§14.3 P01–P06 需要目标云机，本环境给不了；首次历史分页与大包分批
（§5.2 分片未实现）仍走旧链路，因此 §14.1 的"全 0"不能推广成整份清单已通过。

### 8.5 步骤 2e 之后的 A10 证据：分析失败隔离（2026-10-13）

**为什么现在才能测**：A10 的前提是"分析任务真的会被登记"。2e 之前直连车道的 `recompute_jobs`
计数被断言为 **0**，连"分析失败"这个状态都产生不出来（见验收清单里 A10 那一行的"未覆盖"结论）。
2e（`34780e3`）落地之后这条判据才有可观测对象。

**用例**：`apps/api/test/analysis-failure-isolation.test.ts`（1 条，约 3 s）。两条独立通道：
原始接收走真实 `ImportWorker`（真实排队 + 子进程 + 事务），分析走进程内
`RaiApplicationService.runNextJob()`（与 API 消费者同一入口），故障注入落在**真实写点**上
（`CREATE TRIGGER ... BEFORE INSERT ON model_runs ... RAISE(ABORT)`），不是 mock。

**三条判据各自的证据**

| 判据 | 断言 |
|---|---|
| ① 原回执不变 | 分析失败前后 `readImportReceipt(batch)` **逐字段 deep-equal**（两批都查）；事实/会话计数不变；`import_batches` 计数不变 |
| ② 失败独立可见 | `recompute_jobs.status='failed'` 且 `error_json` 点名注入原因；**读侧** `GET /v1/jobs` 用的 `RaiReadStore.jobs()` 报 `status='failed'` + `error={code:"task_failed"}`，而同一次读取里前一个成功的任务仍是 `succeeded`；`active_model_run` 与 `dashboard().activeModel` 仍指向成功的那次 release |
| ③ 重试只计算 | 走 API 的真实重试入口（`POST /v1/model-runs` → `enqueueFullRecompute`）后再跑消费者：批次/事实/会话计数不变、回执仍逐字段不变、`var/` 无备份与整库候选、发布指针**移动到一个新的** release |

⚠️ 如实标注：回执里的 `analysisStatus` 是**写入时刻**的事实（`queued`），消费者不得改写它；
"分析失败"这个独立状态今天由 `recompute_jobs` + `/v1/jobs` 承载。读侧的**派生**投影
（把事实版本/分析版本合成一个 `freshness`）属 PR5 S3/S4 —— 本用例钉住的是"两者不会互相污染"，
那正是那个投影能成立的前提。

**突变验证（4 处，逐个跑，全部按预期变红）**

| # | 突变 | 结果 |
|---|---|---|
| 1 | `fail()` 里用任务行的 `model_run_id` 激活候选 | **不变红** —— 因为注入点（`INSERT INTO model_runs`）发生在 `setJobRunIds(..., modelRunId)` **之前**，该列为 NULL，突变体是空操作。如实记录：这条突变选错了靶子，不是用例没牙 |
| 2 | `fail()` 把排队中回执改写成 `analysisStatus:"failed"`（**§6 表里写明的靶子**） | 转红（"分析失败不得改写原始回执"） |
| 3 | `fail()` 删掉最新批次行 + 把发布指针指向不存在的 run | 转红（批次计数 + "旧 release 必须仍然可读"） |
| 4 | `enqueueFullRecompute` 里插入一个批次行（模拟"重试重新接收"） | 转红（"重试不得产生新的批次行"） |

## 9. 未决问题（动工前必须定掉）

1. **未核实**：`RecomputePipeline` 内是否存在"跨阶段未提交写相互依赖"的实际调用点。
   分块提交在单连接内语义成立，但需要逐点核对（含 `recordCache` 的生命周期）。
2. **未决**：局部 canonical 放在接收事务内还是分析任务内（§4 的两条理由都成立）。
3. **未决**：删除在**旧代次**是否可见（裁决 D1 要求在接 `FactsReader` 写入方时定掉；
   今天 `import_fact_history` 只覆盖 update，边界用例钉着这个口径）。
4. **未核实**：`route_points` 过渡期双写的退役时点是否与 PR5 同批（PR5 读侧改完才可退役）。
5. **本环境给不了**：§14.3 P01–P06（需目标云机）、§14.5 真机 HealthKit 验收。
