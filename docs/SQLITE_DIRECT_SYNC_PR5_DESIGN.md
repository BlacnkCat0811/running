# 直接增量同步：PR5 落地设计（分析指针与全部读侧一致性）

日期：2026-10-13，Asia/Shanghai。基线：`5fedc2a` + PR4 步骤 2a/2b（工作树在制）。
上位设计：[SQLITE_DIRECT_SYNC_DESIGN.md](SQLITE_DIRECT_SYNC_DESIGN.md) §9.1、§9.2、§13 PR5、§14.2 A12/A13。
前序：[SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md](SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md)、[SQLITE_DIRECT_SYNC_PR4_DESIGN.md](SQLITE_DIRECT_SYNC_PR4_DESIGN.md)。
证据底稿：`var/reports/pr5-recon.md`（191 行）；验收盘点：`deliverables/ACCEPTANCE_INVENTORY_DIRECT_SYNC_2026-10-13.md`。

**状态：本文档是设计，未实施。** 所有"现状"断言落到 `文件:行号`；转引自侦察报告而未由本文作者重读的，
逐条标注"转引自侦察报告，已复核/未复核"。

---

## 0. 本文档要回答的问题

1. 读侧怎么**在响应里**区分 `currentFacts`（当前可变事实）与 `publishedAnalysis`（某次已发布分析的冻结输入与结论），
   且**不制造 flag day**（`docs/SQLITE_DIRECT_SYNC_DESIGN.md:305-306`：`API 明确区分 currentFacts 与 publishedAnalysis`）。
2. 侦察报告 §2 的约 17 处"分析视图 JOIN 当前可变事实"，**先改哪些**、每处最小正确改法。
3. 删除（今天是**物理** `DELETE FROM workouts`）在读侧怎么隐藏/标注；已发布 release 是否保留被删训练。
4. 今日建议 / 锁课 / 手表导出的**新鲜度合同**是哪几个字段、什么值算 stale、怎么只用一个真相源。
5. `RaiReadStore.cached()` 的 `PRAGMA data_version` 换成什么 key（§9.2）。
6. 与 PR4 步骤 2e 的**顺序约束**，以及解锁 2e 的最小 PR5 子集。

---

## 1. 现状锚点

### 1.1 🔴 本轮新发现（侦察报告没有）

| 事实 | 位置 | 逐字证据（节选） |
|---|---|---|
| 物理删 workout 沿外键级联删掉**已发布路线版本的全部点**，并令"不可变版本"永久不可读 | `packages/storage-sqlite/src/database.ts:220`、`v35-migration.ts:35`；`v35-migration.ts:34`、`:48` | `workout_id TEXT REFERENCES workouts(id) ON DELETE CASCADE,` / `route_id TEXT NOT NULL REFERENCES route_versions(id) ON DELETE CASCADE` |
| `route_versions` 行本身被指针以 `NO ACTION` 挡住显式删除，但**拦不住级联**：链一旦从 `workouts` 触发，`route_versions` 与 `route_version_points` 一并消失 | `v35-migration.ts:48`、`database.ts:2852-2856` | `ALTER TABLE workout_routes ADD COLUMN published_route_version_id TEXT REFERENCES route_versions(id);` |
| published 版本行**自带完整点内容**（真双写），所以它的内容确实在 `route_version_points` 里；级联删掉它 = 丢掉"已发布轨迹的版本证据" | `database.ts:2798-2800` | `FROM route_version_points WHERE route_version_id = ?` |
| 生产代码里删 workout 只有两处，且都是物理删 | `database.ts:3512`、`:3607` | `const deleteWorkout = this.database.prepare("DELETE FROM workouts WHERE id = ?");` |
| 全仓**没有**任何测试断言"删 workout 后路线版本仍在" | `packages/storage-sqlite/test/`、`apps/api/test/` | 搜索 `workout_routes` 与 `delete\|cascade\|remove` 合取：0 命中 |

### 1.2 已由本文作者重读并确认（合并同类项）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 读侧唯一权威发布指针是单行表 `active_model_run`；所有 `active_*` 视图每次查询重新 JOIN 它 | `database.ts:525-529`、`:926-932`、`:949-955` |
| 2 | 第二条发布指针 `active_model_release` 指向已过 gate 的 bundle；发布 = 单行 `ON CONFLICT DO UPDATE` | `v2-migration.ts:33-35`、`model-release-repository.ts:89-91` |
| 3 | 训练列表与计数：assessment × session × workout × zone summary 一条 SQL；`has_route` 读**当前** `workout_routes` 且只判 `point_count > 0` | `read/workout-read-repository.ts:182-195`、`:218-232`；对照 `sql/fragments.ts:36-38` |
| 4 | 详情行：`JOIN workouts w` + `JOIN model_runs mr`，同时给出分析分数与当前 `w.indoor/source_category` | `read/workout-read-repository.ts:246-285` |
| 5 | 详情路线点、`sessionForSeries`、第二条路线读路径都读**当前** `workout_routes`；删 workout 后 `sessionForSeries` 返回 `null`（404） | `read/series-read-repository.ts:85-97`、`:107-116`、`:232-233` |
| 6 | `mobileTodayWithExecutablePlan` 一个响应混分析视图与当前事实（`canonical_nights`/`health_records`/`import_manifest`） | `apps/api/src/data.ts:570-596`、`:598-613`、`:636-646` |
| 7 | 今日/周/28 天汇总多条 SQL **不 JOIN** `workouts`：删训练后其分析负荷仍计入里程、次数、能量、`planActual` | `data.ts:604`、`:620`、`:641`、`:655`、`:713` |
| 8 | 周跑步汇总、月统计 JOIN `training_sessions`（当前事实）判 `activity_type`，无删除判据 | `data.ts:665-672`、`:975-989` |
| 9 | 计划状态快照：发布指针 + 当前事实同一响应，带 `coherenceToken` 与 `metadata: { contractVersion: 1, …` | `data.ts:454-496` |
| 10 | `coachLoopFacts` 的 `facts` 显式 `s.status='active'` 且 JOIN `workouts`；但 `qualityDates` 只读分析负荷，无删除过滤 | `data.ts:255-262`、`:271-274` |
| 11 | 成绩候选只看 `session.status = 'active'`；`durationSeconds` 回退到 anchor 跨度 | `data.ts:1661-1667`、`sql/fragments.ts:6-15` |
| 12 | Web 趋势 assessment × feature × load；统计页近期负荷 load × 当前 session 时间 | `read/trends-read-repository.ts:80-91`、`read/training-statistics-read-repository.ts:66-75` |
| 13 | 恢复/解读用已发布 run 的 feature schema 当开关，再读**当前**恢复事实 | `apps/api/src/mobile-read.ts:362-364`；`packages/application/src/model-v2-snapshots.ts:38-52` |
| 14 | `executable` 与版本无关（结构非空且非 rest）；`freshness.state` 只由 `sync.status` 派生且已 `@deprecated` | `mobile-read.ts:567`、`:614`；`data.ts:774-779`；`api-contracts/src/index.ts:1272-1285` |
| 15 | 锁课 gate 只查 `syncStatus === "failed"` 与 `recommendationRevision`；锁课的 workout 校验只查 `training_sessions.status` | `mobile-sync.ts:99-104`；`server.ts:1552-1557`；`coach-loop-routes.ts:56` |
| 16 | 缓存开关 = `PRAGMA data_version`（任何一页写清空全部 key），只用于两个 key | `data.ts:208-209`、`:354-364`、`:1824`、`:1837`；`server.ts:926-927` |
| 17 | `recommendationRevision` 的哈希**已经包含** `activeModel`（旧 release 边界的既成先例） | `data.ts:785-797` |
| 18 | 任务 DTO 只透传 12 个旧字段，v35 绑定列**读不出去** | `packages/storage-sqlite/src/recompute-job-repository.ts:121-135`、`:527-548`；`contracts/src/index.ts:934-941`；`data.ts:1922-1945` |
| 19 | 回执状态合同已存在，唯一生产者恒为 `not_required` / `publishedReleaseId: null` | `contracts/src/direct-sync.ts:24-52`；`data-only-import.ts:184-195` |
| 20 | 能力协商既成范式：`/v1/handshake` 用**可选**版本字段宣告，客户端 `guard` 后才使用 | `server.ts:906-916`；`apps/ios/RAI/NativeAppModel.swift:414` |
| 21 | iOS `TrainingPlanStateResponse.Metadata` 是**非可选**字段结构体 ⇒ 给它加必填字段会让旧客户端 decode 失败 | `apps/ios/RAI/APIModels.swift:1185-1198` |

### 1.3 转引自侦察报告、本文作者已复核

| 事实 | 位置 |
|---|---|
| `import_fact_history` / `import_generations` 至今**没有写入方**（回执刻意不承诺数值版本） | `contracts/src/direct-sync.ts:60-67`、`v34-migration.ts:42-48` |
| `RaiReadStore` 只按**路径**缓存连接对象，与版本无关 | `read-store-manager.ts:52-64`、`:141-144` |
| PR3 的 `FactsReader.routeFor()` 读**当前** `workout_routes`（注释自陈"改由读侧消费是 PR5/PR6 的事"） | `read/facts-reader.ts:58-60`、`:166-183` |
| `FactsReader` 只覆盖更正、**不覆盖删除**（被删实体在任何代次不可见），该边界被测试钉住 | `read/facts-reader.ts:29-48`；`test/facts-reader.test.ts:187-200` |
| 删除会留持久 tombstone（`import_entity_tombstones`），而 `read/` 目录搜索 `tombstone` 无命中 | `database.ts:1382-1390`、`:2960` |

---

## 2. 决策

### D1 `currentFacts` / `publishedAnalysis`：**同名顶层可空字段 + 追加式能力，不改任何旧字段语义**

**决策**

1. **不给旧字段改语义**：`WorkoutListItem.currentAbility`、`qualityScore`、`MobileTodayResponse.week.distanceKm`
   等一律保持今天的样子（含"混"这件事），改它们就是 flag day。
2. **新增**顶层可空字段 `currentFacts: {...} | null` 与 `publishedAnalysis: {...} | null`（§9.1 点名的两个名字），
   默认 `null` —— **不是**空对象占位：`null` 表示"本端点还没有这一侧视图"，空对象会撒谎。
3. 两块的最小必要形状：

```ts
interface FactsView<T> {              // 只放当前事实，不含任何分析字段
  factVersion: string | null;         // import_generations.raw_generation，String(n)
  rows: T[];                          // 已删除事实**不出现**
  pendingAnalysisCount: number;       // 有事实但未被当前 release 覆盖的条数
}
interface AnalysisView<T> {           // 只放某次已发布 release 的冻结输入与结论
  releaseId: string | null;           // active_model_run.model_run_id
  dependencyVersion: string | null;   // import_generations.dependency_generation，String(n)
  rows: T[];                          // 结论 + 冻结输入（路线走版本表）
  stale: boolean;                     // D2 的 freshness 派生，本块唯一的 stale 出口
}
```

4. **能力宣告**：`/v1/handshake` 追加可选 `factsAnalysisContractVersion: 1`（范式见锚点 20）。
   客户端 `guard handshake?.factsAnalysisContractVersion == 1` 后才读两块，否则退回旧字段。
5. **端点边界先收窄**：`/v1/workouts`、`/v1/mobile/training-plan-state`、`/v1/mobile/today` 先行；
   `/v1/dashboard`、`/v1/trends`、`/v1/mobile/statistics` 只在**数值**上按 D4 修正，不新增块。

**理由**：§9.1 要求"明确区分"而非"改名"；追加字段同时满足区分与不 flag day。
旧客户端读到的仍是今天那个混过的值——这是**已知**过渡态，其可见性由 D6 的顺序约束控制，而不是靠改名。
两块做成同一响应里的兄弟，C1（两块各来自各自快照）才可能用一条断言钉住；拆成两个端点则两次请求之间的提交不可观测。

**代价**：响应变大（两块重复一部分行）；`pendingAnalysisCount` 多一次聚合；
"新旧字段并存"期间必须有**不变量测试**防人悄悄改旧字段。
**突变靶子**：用旧字段的过滤结果冒充事实块 ⇒ C2 转红。

### D2 新鲜度合同：**只派生、不新增存储；`generations_absent` 期间沿用现状**

```ts
interface FactVersions {
  facts: string | null;      // import_generations.raw_generation
  analysis: string | null;   // import_generations.dependency_generation
  releaseId: string | null;  // active_model_run.model_run_id
  analysisStatus: AnalysisStatus;  // contracts/src/direct-sync.ts:24-31 的既有枚举
}
interface Freshness {
  stale: boolean;
  reason: "up_to_date" | "analysis_behind" | "analysis_failed" | "analysis_missing" | "generations_absent";
  versions: FactVersions;
}
```

- `stale === true` ⇔ `analysisStatus !== "published"`（`failed`/`queued`/`running`）**或** `analysis !== facts`；
  `generations_absent` 也算 stale，但**行为不同**（下条）。
- 三个入口消费同一份 `Freshness`：
  1. `executable`：`data.ts:858-868` 与 `mobile-read.ts:567`、`:614` 的判据在 stale 时**结构不变、值置 `false`**；
  2. 锁课：`mobileLockRejection`（`mobile-sync.ts:99-104`）**并进** `analysis_stale` 拒绝；
  3. 今日建议：stale 时 `recoveryAssessment`/`recommendation` 仍可读（§9.2"完成的旧目标可成为最新已计算历史视图"），
     但把 `versions` 并入 `recommendationRevision` 的哈希输入 —— **复用**锚点 17 的既有机制，不新开一条。
- ⚠️ **过渡期口径（必须写进契约注释）**：`import_generations` 今天没有写入方（锚点 19、§1.3），
  所以 D2 若立刻生效会把**一切**判成 `generations_absent` ⇒ `executable` 恒 `false`、锁课恒拒 ——
  那不是更安全，那是把系统关掉。因此 D2 **必须携带回退**：无写入方时用现状探针
  （`active_model_run` + `import_manifest.import_completed_at`）合成 `versions` 并标 `generations_absent`；
  该状态下 `executable` 与锁课**沿用今天行为**，只有 `analysis_behind`/`analysis_failed`/`analysis_missing` 才降级。
  这是"不能凭空关掉产品"与"不能从旧数据授予最新可执行"之间**唯一**的折中，必须写成显式分支并配突变靶子。
- **不新增表/列**：`analysisStatus` 由"最新相关任务（按 `target_dependency_generation`）+ `active_model_run`"派生。
  ⚠️ 今天 `map()` 不透出绑定列（锚点 18），所以 D2 落地时必须同时给 `RecomputeJob` 加**可选**绑定字段。

**理由**：§9.1 要的是"不能从旧数据授予最新可执行"，而"旧"的唯一定义是**版本比较**；
用"距今天数"当 staleness（`apps/api/src/run-coach.ts:77-82` 的 8 周判据）会与发布版本解耦，
出现"没有新数据、分析也没跟上"却被判 fresh 的形态。

**代价**：`executable` 从"结构判据"变成"结构 ∧ 版本判据"，会真的出现"结构完整但不可导出"的日子，
必须配 §10.3 文案，否则被当成故障。**突变靶子**：把 stale 判据改成 `sync.status === "failed"` ⇒ C4 转红。

### D3 缓存 key：**五元组，`data_version` 退役为测试期断言**

```ts
type ReadCacheKey = `${scope}|${factsVer}|${analysisVer}|${controlRev}|${businessDate}`;
```

- `scope`：`{serverId, athleteId, datasetEpoch}` 的 `digest`（同 `data.ts:459` 一路）。
- `factsVer`/`analysisVer`：D2 的 `versions.facts`/`versions.analysis`（空串表示缺失）。
- `controlRev`：`digest({ goals, planHistory(200), training_zone_profile_settings.revision, 最新 effective_workout_overrides.revision })`
  —— 今天 `data.ts:459` 只吃前两项，漏了后两项，而分区剖面决定 `executable`（锚点 14）。
- `businessDate`：`mobileLocalDate()`（业务时点，不是墙上时钟）。
- 🔴 **五元组必须一次读齐**：新增 `RaiReadStore.versionSnapshot()`，在**一个 `BEGIN DEFERRED`** 里读五个值
  （`data.ts:462` 已有此范式）；否则五个分量来自五个时刻，会拼出一个从未存在过的 key。
- `PRAGMA data_version`（`data.ts:354-364`）不再参与失效：侦察报告 §5 已指出它"任何一页写都会清空全部 key"，
  而 §9.2 明令"权威失效依据是相应发布/事实版本，而非数据库任意一页写过"。

**理由**：候选行/进度更新（`recompute_job_events` 每 tick 一行）会改 `data_version`，
今天的实现正好是 §9.2 点名要避免的形态。**代价**：每次读多一次五读事务；
`generations_absent` 期间后两项为空串 ⇒ 缓存近乎无效（与今天等价，不更差）。
**突变靶子**：key 换回 `data_version` ⇒ C6 转红。

### D4 删除可见性：**事实侧排除、分析块保留并标注、已发布 release 不动；物理删必须改软删标记**

1. **事实侧一律排除**：进入 `currentFacts` 的行（列表、详情、today/week、statistics、trends、`planActual`、
   `qualityDates`、成绩候选、手表导出行）都必须排除已删事实。
2. **判据必须同源**：新增 `sql/fragments.ts` 的 `workoutPresentConditionSql(alias)`（范式照 `usableRouteConditionSql()`）：
   `NOT EXISTS (SELECT 1 FROM import_entity_tombstones t WHERE t.entity_kind='workout' AND t.entity_id = ${alias}.id)`，
   **所有**事实侧 JOIN 引用它。今天的形态是"靠 INNER JOIN `workouts` 顺带隐藏"（锚点 3/4/5），
   它只对走那条 JOIN 的读生效，对锚点 7 的六条裸读完全无效——这正是"删除后里程还在涨"的成因。
3. **分析侧保留并标注**：`publishedAnalysis.rows` **包含**引用已删事实的行，每行带 `factDeleted: true`，
   并使该块 `stale: true`。依据 §9.1 原文"旧run仍作为历史证据，相关汇总明确待更新"。
4. **已发布 release 不动**：不因事实被删而回滚 `active_model_run`/`active_model_release`；release 是"当时的输入 + 当时的结论"，
   改它等于伪造历史（§9.2"不能改写历史候选的输入标签"）。
5. 🔴 **物理删 → 软删标记，这是 PR5 的硬前置**：§1.1 证明 `DELETE FROM workouts` 沿
   `workout_routes → route_versions → route_version_points` 级联，**把已发布路线的版本内容一起删掉**，
   于是"旧 release 保持可读"在最需要它的删除场景下不成立。最小正确改法：`workouts` 增**可空列**
   `deleted_at TEXT`（只新增列，不改历史 `up`，§14.2 A18），`database.ts:3512`/`:3607` 改为"标记 + 保留行"，
   `workoutPresentConditionSql` 同步改为 `deleted_at IS NULL`；tombstone 与账目继续写（它们还有防复活的独立职责）。
   ⚠️ 该改动同时改变写侧可见行为（`workout_routes` 不再级联消失、`import_equivalence` 的摘要可能变化），
   **必须与 PR4 owner 同批评审**。

**理由**：读侧的"隐藏"有两种语义——"事实消失了"与"事实从未存在"。今天是后者（靠 JOIN 顺带实现），
把二者混起来会让 A12 的"删除不泄露旧『当前』训练"既不可断言也不可解释。
**代价**：新迁移 + 两处写路径改造 + `import_equivalence` 基线复核。
**突变靶子**：`workoutPresentConditionSql` 换成 `1=1` ⇒ C3/C5 转红；软删换回物理删 ⇒ C7 转红。

### D5 读侧边界：**事实行不许带分析字段，分析行不许带当前可变字段**

- `FactsView.rows` 的行类型**不得**包含 `currentAbility`/`qualityScore`/`stimulusType`/zone summary 等任何 `active_*` 来源字段；
  未分析事实显示 `analysisState: "pending"`，**不用 `null` 分数**（§9.1"不配上旧分数冒充一致"）。
  ⚠️ 刻意不用 `null`：`null` 已表示"分析过但没有值"（如 `distanceKm: null`），两种语义共用一个取值是本仓反复踩的坑。
- `AnalysisView.rows` 不得读当前事实：分析侧的距离/时刻来自 `workout_features`
  （已冻结的输入），不是当前 `workouts`。
- 路线：分析块走 v35 版本表（`route_versions.status='complete'` + `workout_routes.published_route_version_id`
  + `route_version_points` 按 `sequence` 读）；事实块走当前 `route_points`。这是 PR4 §2.4 承诺的
  "PR5 让读侧改走版本表后 `route_points` 退役"（`SQLITE_DIRECT_SYNC_PR4_DESIGN.md:107-109`）。
  ⚠️ 老库行 `published_route_version_id` 仍为 `NULL`（`database.ts:2681` 的既有注释），
  所以分析块必须**允许**退化读当前 `route_points` 并标 `routeVersionId: null`——不猜、不假装它有版本。

**理由**：两块若允许重叠，`currentFacts`/`publishedAnalysis` 就只是同一堆字段的两个名字，
§9.1"不能只改一个『更新中』文本、底层仍把两个版本拼在一起"就没被满足。
**代价**：需要新行类型（不复用 `WorkoutListItem`），前端过渡期只能继续读旧字段。
**突变靶子**：给事实块行填一个 `currentAbility` ⇒ C2 转红。

### D6 与 PR4 的顺序：**S1+S2 必须先于 2e；新鲜度的回退值必须与 S3 同批**

- **硬阻塞（2e 之前必须完成）**：§5 步骤 S1（`workoutPresentConditionSql` + 事实侧排除已删）与
  S2（`workouts.deleted_at` 软删标记）。没有这两步，2e 一开闸，孤儿负荷行立刻进入今日/周/月汇总（锚点 7），
  且删除会级联销毁已发布路线的版本内容（§1.1）——前者是 §9.1 点名的"旧分数 JOIN 新训练"在用户面前显形，
  后者是**不可逆**的证据丢失。
- **软依赖（与 2e 同批发布）**：S3 的 `versions`/`freshness` 字段与 `generations_absent` 回退分支。
  2e 的验收（A01）只要求"直接写主库"，但 §9.1 的"API 明确区分"缺席时，
  2e 引入的**删除**会以"突然少一行、汇总不变"的形式出现，属用户可见的不一致。
- **可以晚于 2e**：S4–S11（两块字段、统计/趋势/计划/coach/预测、缓存、路线版本消费、`route_points` 退役）。

**理由**：2e 是把删除放进直连车道的那一步，而删除的读侧后果与路线版本的级联后果**都在 PR5 的地盘上**；
把 PR5 拆成"最小解锁子集"与"完全一致性"两段，才能既不放慢 PR4，又不让 2e 独自承担它管不了的风险。
**代价**：两个 PR 的排期耦合；建议在 `SQLITE_DIRECT_SYNC_PR4_DESIGN.md` §7 的 2e 行登记"前置：PR5-S1+S2"。

### D7 `route_points` 过渡期双写的退役时点

读侧（S5/S11）改走版本表、并在两个读侧入口断言"分析块路线 == 版本表内容"之后，
才停止在 `publishRouteVersion` 里写 `route_points`（`database.ts:2852-2856` 那句 `UPDATE workout_routes` 保留，
它写的是指针与 `point_count`，不是 `route_points` 的点）。不退役 = 让 `route_points` 与
`route_version_points` 构成**第二份真相**，而两份真相迟早分叉。
**代价**：退役后老库（指针 `NULL`）**只能**读 `route_points`，所以退役不是删表，而是"新版本不再写"。
**突变靶子**：退役后 `publishRouteVersion` 继续写 `route_points` ⇒ C8 转红。

---

## 3. 读侧改造清单（有序）

| # | 位置（今天） | 最小正确改法 |
|---|---|---|
| 1 | `sql/fragments.ts`（新增，对照 `:36-38`） | 新增 `workoutPresentConditionSql(alias)`；`read/` 与 `apps/api` 的事实侧 JOIN 全部引用它；配结构判据（全仓 `JOIN workouts` 站点必须引用） |
| 2 | `database.ts:3512`/`:3607`（写侧，受 D4.5 约束） | `workouts.deleted_at` 软删标记（只新增可空列）+ 两处调用改标记；tombstone/账目照旧写 |
| 3 | `read/workout-read-repository.ts:182-195`、`:196-235` | 加存在性判据；`has_route` 改用 `usableRouteConditionSql`（与 `facts-reader.ts:167-185` 同源）；返回两块视图 |
| 4 | `read/workout-read-repository.ts:246-285` | 分析块走 `workout_features` 冻结列；`indoor`/`source_category` 移入事实块；加存在性判据 |
| 5 | `read/series-read-repository.ts:85-97`、`:107-116`、`:232-233` | 分析块路线改读版本表（`complete` + 指针 + `route_version_points` 按 `sequence`）；老库退化读 `route_points` 并标 `routeVersionId: null`；`sessionForSeries` 保持 404 语义；#5 的三处共用一个内部函数 |
| 6 | `data.ts:598-613`、`:615-634`、`:636-646`、`:651-656`、`:711-714` | 全部 JOIN `training_sessions` + 存在性判据；或在分析块保留并标 `factDeleted`——**同一个数字不许两处不一致** |
| 7 | `data.ts:665-672`、`:975-989` | 周跑步/月统计加存在性判据 |
| 8 | `read/training-statistics-read-repository.ts:66-75`、`read/trends-read-repository.ts:80-91` | 加存在性判据；`rows` 拆进两块 |
| 9 | `data.ts:454-496` | `metadata` 加**可选** `versions`/`freshness`（锚点 21：iOS 结构体非可选字段 ⇒ 只能加可选）；`coherenceToken` 输入加 `versions`（今天已吃 `publicationDigest`，`:483-493`） |
| 10 | `data.ts:255-274` | `qualityDates` 加存在性判据；`factsHash` 输入加 `versions` |
| 11 | `data.ts:1661-1667` + `sql/fragments.ts:6-15` | 加存在性判据；anchor 回退分支在事实缺失时**不产出候选**（不用 anchor 顶一个时长出来） |
| 12 | `apps/api/src/coach-loop-routes.ts:56` | 锁课 workout 校验加存在性判据（否则可锁一个已删训练） |
| 13 | `mobile-read.ts:362-364` + `packages/application/src/model-v2-snapshots.ts:38-52` | schema 开关保留（它是能力探测）；恢复事实的 `versions` 随响应输出，stale 时按 D2 标记 |
| 14 | `mobile-read.ts:567`、`:614` + `data.ts:858-868` + `mobile-sync.ts:99-104` + `server.ts:1552-1557` | 接入 D2：置 `executable=false`；锁课加 `analysis_stale`（`generations_absent` 下不拒） |
| 15 | `apps/api/src/coach-prediction-companion.ts:15-31` | `factsHash` 的输入拆成 `versions` 与事实摘要两个域；`dataThroughAt` 取自分析块的冻结输入 |
| 16 | `data.ts:354-364`、`:208-209` | D3 五元组 + `RaiReadStore.versionSnapshot()`；`data_version` 退为测试期断言 |
| 17 | `read/facts-reader.ts:167-185`、`:363-371` | 路线读取加版本语义或明确标注"本方法读当前"；**不改** `records`/`workouts` 的代次语义 |
| 18 | `packages/storage-sqlite/src/recompute-job-repository.ts:1296-1340` + `contracts/src/index.ts:934-941` | `RecomputeJob` 加**可选** `targetRawGeneration`/`targetDependencyGeneration`/`expectedIncumbentReleaseId`（12 个旧字段不动） |

---

## 4. 验收判据与突变靶子

| # | 判据（要断言的句子） | 突变靶子（必须转红） |
|---|---|---|
| C1 | 两块**同一次请求内**各来自各自快照：读期间发生一次事实提交，两块 `rows` 都不含跨快照混合 | 拆成两条连接/两次查询（去掉 `BEGIN DEFERRED`） |
| C2 | 事实块的行**不含**任何分析来源字段（**键集**断言，不是值断言） | 给事实块行填 `currentAbility` |
| C3 | 已删训练：事实侧列表/汇总/统计/成绩候选全部不出现，汇总数字 == 删除前减去该训练，逐位相等 | `workoutPresentConditionSql` 换成 `1=1` |
| C4 | 构造 `dependency_generation < raw_generation` ⇒ 手表导出 `executable` 全 `false`、锁课返回 `analysis_stale`；构造 `generations_absent` ⇒ **沿用今天行为** | stale 判据改成 `sync.status === "failed"` |
| C5 | 分析块保留已删训练行且 `factDeleted: true`、块 `stale: true`；`active_model_run` 指针**未变** | 让删除回滚 `active_model_run`，或从分析块过滤掉该行 |
| C6 | 写一行 `recompute_job_events` 后 `/v1/data-summary` 两次读命中同一 key；发布新 release 后 key 改变 | key 换回 `PRAGMA data_version` |
| C7 | 删 workout 后该路线 `status='complete'` 版本的 `route_version_points` 行数**不变** | 软删标记换回 `DELETE FROM workouts` |
| C8 | 分析块路线点 == `route_version_points`（按 `sequence`）；老库指针 `NULL` 时退化读 `route_points` 且 `routeVersionId: null` | 让分析块继续读当前 `route_points` 且不标注退化 |
| C9 | 旧字段**语义未变**：today/workouts/training-plan-state 三个响应里新块之外的取值与基线逐字节相同 | 让旧字段改用事实块的过滤结果 |
| C10 | 绑定列可读：`/v1/jobs` DTO 在绑定非空的任务上有 `targetDependencyGeneration`，旧任务为 `undefined`（12 个旧字段逐个不变） | `map()` 继续只读 12 个字段 |

**结构判据（编译期/构造期）**

1. `FactsView`/`AnalysisView` 的行类型字段交集为空（类型级断言）。
2. `workoutPresentConditionSql` 是事实存在性的**唯一**实现：不存在第二处 `import_entity_tombstones`/`deleted_at IS NULL` 字面 SQL。
3. 新增迁移只 `ALTER TABLE ADD COLUMN`（可空）；`FROZEN_MIGRATION_CHECKSUMS` 追加而不修改历史项。

**本环境给不了的（不得宣称通过）**：A12 的桌面/iOS 状态截图（需运行桌面 Web 与 Simulator）；
A13 的"新数据持续到达仍有结果可读"的**真并发**时序（本环境只能做固定顺序的交错调用）；
§14.3 P01–P06（需目标云机、隔离脱敏数据集与 200 个有效样本，§14.4 明令不得用开发机空库替代）；
真机 HealthKit 删除/续传（§14.5）。

---

## 5. 实施顺序（每步都能单独跑绿）

| 步 | 内容 | 单独绿的判据 | 阻塞关系 | 状态 |
|---|---|---|---|---|
| S1 | `workoutPresentConditionSql` + 事实侧排除已删（清单 1、3、6、7、8、11、12） | C3 转绿；**旧响应逐字节不变**（此时还没有新字段） | 🔴 **必须早于 PR4 2e** | ✅ 已完成（与 S2 同批，见 §8） |
| S2 | `deleted_at` 软删标记 + 两处写路径 + `import_equivalence` 复核（清单 2） | C7 转绿；既有删除保护用例（A03）全绿 | 🔴 **必须早于 PR4 2e** | ✅ 已完成（与 S1 同批，见 §8） |
| S3 | `versions`/`freshness`（D2）+ 绑定列可读 + `metadata` 可选字段（清单 18、9） | C4 的 `generations_absent` 分支转绿；C10 转绿 | 与 S1/S2 同批发布 | ⛔ 未做 |
| S4 | 两块视图 + handshake 能力（清单 3、4、8） | C1、C2、C9 转绿 | 需 S3 | ⛔ 未做 |
| S5 | 详情路线走版本表（清单 5） | C8 转绿（含老库退化分支） | 需 S4 | ⛔ 未做 |
| S6 | 今日/周/统计/趋势/计划快照数值修正（清单 6、7、8、9、10） | C3 在四个端点分别转绿 | 需 S1 | ⛔ 未做 |
| S7 | `executable` 与锁课接入新鲜度（清单 14） | C4 全分支转绿 | 需 S3 | ⛔ 未做 |
| S8 | coach/预测 identity 与 `dataThroughAt` 绑定（清单 10、15） | A13 的"迟到任务不倒退"在**读侧**有断言 | 需 S3 | ⛔ 未做 |
| S9 | 缓存五元组 + `versionSnapshot()`（清单 16） | C6 转绿 | 需 S3 | ⛔ 未做 |
| S10 | `FactsReader.routeFor` 版本语义收尾（清单 17） | 路线读取两条路径同源 | 需 S5 | ⛔ 未做 |
| S11 | `route_points` 双写退役（D7） | C8 仍绿（新版本不再写 `route_points`） | 需 S5 **且** PR4 §2.4 评审同意 | ⛔ 未做 |

**🔥 解锁 PR4 2e 的最小 PR5 子集 = S1 + S2。** 只有这两步能同时挡住
①已删训练的负荷进入当前汇总（C3）与 ②级联销毁已发布路线的版本内容（C7）。
建议 S3 同批带上，但它在**语义上**不阻塞 2e——2e 不改变 `executable` 的判据。
⛔ 顺序不可交换：S4 之前必须 S3（否则新块没有 `versions` 可填）；S7 之前必须 S3；S11 之前必须 S5。

---

## 5.1 S1 + S2 的实测证据（2026-10-13，与 PR4 步骤 2c/2d 同轮）

**结论先行**：`deltaMode: "full"`（PR4 2e）的前置已满足 —— 删除不再级联销毁路线证据，
且已删训练不再进入任何事实侧汇总。

**写侧（S2）**

- 新迁移 **v36 `workout_soft_delete_marker`**：只 `ALTER TABLE workouts ADD COLUMN deleted_at TEXT`，
  可空、无默认值（老库补迁移后所有行读作"未删除"）；冻结校验和已追加，历史项一个没动。
- 两处 `DELETE FROM workouts` → `UPDATE ... SET deleted_at = <now>, is_canonical = 0,
  canonical_group_id = NULL WHERE id = ? AND <presence>`。tombstone 与账目照旧写。
- **恢复语义**：`insertWorkout` 的 `ON CONFLICT DO UPDATE` 增加 `deleted_at = NULL`，并且
  `observeImportEntity` 的"存不存在"改为按**事实是否存在**判定（软删行算"不存在"）——
  否则一条权威载荷重新提到它时 `shouldWrite` 为 false，`deleted_at` 永远擦不掉，
  "删错了还能从好档案里恢复"这条既有契约就断了。墓碑仍拦住增量载荷（parser 的 `shouldWrite`），
  实测"删除是持久的"没有被改坏。
- `countImportableEntities()`（删除配额的分母）改为只数仍在的训练 —— 否则允许删除的比例会随
  历史删除次数悄悄变大。
- `canonicalize.ts` 的 `loadRunningWorkouts` 加同一判据：已删训练不得再被重新分组，
  否则它会重新长出一个 session。
- `import_equivalence` 的 `workouts` 域忽略 `deleted_at`（墙上时钟；删除这件事本身由
  tombstone 与账目承载，二者都在比对范围内）。

**读侧（S1）**

- 新判据只在 `sql/fragments.ts` 一处：`workoutPresentConditionSql(alias)`（事实存在性）与
  `sessionFactPresentConditionSql(sessionAlias)`（会话级，**组合**前者）。
- 引用它的读路径：`read/workout-read-repository.ts`（列表/计数/详情/两处按 id 读）、
  `read/series-read-repository.ts`（会话行 + 元数据）、`read/facts-reader.ts`（固定代次读）、
  `read/trends-read-repository.ts`、`read/training-statistics-read-repository.ts`、
  `apps/api/src/data.ts`（今日/周/四周/planActual/统计/趋势锚点/qualityDates/成绩候选/
  coach 事实）、`apps/api/src/mobile-read.ts`（两处）、`apps/api/src/coach-loop-routes.ts`（锁课校验）、
  `activeDurationSecondsSql`。
- 结构判据（`packages/storage-sqlite/test/workout-presence.test.ts`）：全仓**只有**
  `sql/fragments.ts` 允许出现 `deleted_at IS NULL` 字面量；列出的每个事实侧文件里，
  每一处 `FROM/JOIN workouts` 所在的语句都必须引用那条判据。

**行为判据**：C3（`apps/api/test/data.test.ts` 新增用例：软删一条之后，事实侧列表 8→7、
汇总距离**恰好**少 5 km）、C7（`workout-presence.test.ts`：软删后 `route_version_points` 点数不变、
已发布版本行与指针不动）、会话级判据、v36 列形状。

**收紧的真实代价（已核实）**：会话级判据要求会话挂在真实存在的训练事实上。生产里只有两条写
`training_sessions` 的路径（`canonicalize.ts` 总带 `canonical_workout_id`；`import-worker.ts` 从既有行复制），
唯一为空的来源是老库里"workout 被物理删过"（`ON DELETE SET NULL`）—— 那正是要隐藏的行。
凡"夹具里造了没有 workout 的会话"的测试必须补真实事实，**不许放宽判据**。

**突变验证（3 处，全部被精确捕获）**：判据换成 `1 = 1` ⇒ 5 条转红（含 C3）；
软删换回物理删 ⇒ C7 转红；会话级判据换成 `1 = 1` ⇒ C3 与会话级用例转红。

**回归**：storage-sqlite 154/154、parser 146/146、`tsc`（pure + full）EXIT=0。

---

## 6. 明确不做

- **不做**"给 `workouts` 加 `is_active` 布尔列再全域过滤"：布尔列会与 tombstone 形成两个事实来源；
  `deleted_at` 带时点，同时回答"删没删"与"何时删"。
- **不做**把 `active_*` 视图改成按 release 参数化的表值函数：SQLite 没有参数化视图；
  PR5 只固定"哪些字段该 JOIN 谁"，不重做视图层。
- **不做** `route_points` 的**表删除**：老库指针 `NULL` 的行仍靠它；退役 = 新版本不再写（D7）。
- **不做** `currentFacts`/`publishedAnalysis` 的独立端点：两次请求之间的提交不可观测，C1 会变成不可断言的竞态。
- **不做**旧字段的 `@deprecated` 标记：废弃是 flag day 的前半段，由使用率数据与 PR6 的客户端切路决定。
- **不做** iOS/Web 渲染改造与文案：PR5 只保证 API 正确与可协商（D1.4），客户端读新字段属 PR6。
- **不做** Rust native `apply-records` 的 permit 放宽（§13 明令首版复用 TS 主写）。

---

## 7. 未决问题

1. **未决（需接口评审拍定）**：D1 两块的**确切字段名与嵌套深度**——顶层块
   （`currentFacts: { rows, factVersion, … }`）还是把两块**平铺**进现有行类型
   （在 `StoredWorkoutListItem` 上并列 `facts`/`analysis` 子对象）。本文给的是最小必要形状 + 三条硬约束
   （默认 `null`、块内不许跨域、旧字段语义不变）。平铺更省响应体但更容易被误当成"同一行的两个视图"；
   顶层块更明确但客户端多读一层。**settle 它需要**：与 `apps/web`/`apps/ios` 消费方的接口评审 + A12 的状态截图证据。
2. **未决**：D2 的 `analysisStatus` 派生口径——用 `recompute_jobs` 里最新相关任务的状态，
   还是纯版本比较（完全不看任务表）。前者能区分 `queued`/`running`/`failed`，后者不依赖任务保留策略。
   本文暂定前者，`failed` 与版本比较同时成立时才报 `analysis_failed`。
   **settle 它需要**：PR4 步骤 2d 后 `recompute_jobs` 的保留/清理策略（今天只做读取，见 `data.ts:1819-1820`）。
3. **未决**：D4.5 的软删标记是否与 PR4 **同一批**落地。它改变写侧可见行为
   （`workout_routes` 不再级联消失、`import_equivalence` 摘要可能变化），跨 PR 边界需 PR4 owner 明确同意。
   **settle 它需要**：一次 PR4/PR5 联合评审 + `import-equivalence` 基线前后对比。
4. **未决**：`pendingAnalysisCount` 的"未分析"定义——"有事实且未出现在当前 release 的任何 assessment/load 行里"
   还是"`valid_from_generation > 已发布代次`"。后者更精确，但需要 `model_runs` 记录它消费的 raw 代次（今天没有这一列）。
   **settle 它需要**：PR4 步骤 2d 是否为 `model_runs` 加"输入代次"列。
5. **未核实（转引自侦察报告，本文作者未追重算流水线）**：删除训练后 `active_workout_training_loads`
   里遗留的负荷行是否会被下一次重算清理。C3 不依赖它（读侧排除即可），但 §9.1 的"相关汇总明确待更新"文案需要它。
6. **未核实**：本文按 §3 清单改造后是否**穷尽**了"分析 × 当前事实"的全部读路径。侦察报告自陈（未决 7）
   只扫描了 `packages/storage-sqlite/src/read/`、`apps/api/src/data.ts`、`mobile-read.ts`、`server.ts`、`coach-*.ts`；
   `packages/application/src/prediction-*.ts` 等写侧/离线侧读未逐条核对。**settle 它需要**：一次按
   `active_` 视图名反向搜索的收口（清单 1 的结构判据正好是它的机械化形式）。
7. **本环境给不了**：C1 的"读期间插入一次事实提交"需要能中止读事务的测试钩子，本环境只能做同步交错，
   不是真并发；A12 截图、A13 真并发时序、P01–P06、真机 HealthKit 验收（见 §4 末）。
