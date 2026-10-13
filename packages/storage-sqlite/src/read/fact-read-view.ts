/**
 * 事实侧 / 分析侧的**两块视图**与它们的新鲜度（PR5 S3/S4，见
 * `docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md` §2 D1/D2/D5、§3 清单 3/4/8）。
 *
 * ## 这个文件解决的那件事
 *
 * §9.1 点名的是「不能只改一个『更新中』文本、底层仍把两个版本拼在一起」。今天服务端的
 * 读侧正是那样：`WorkoutListItem.currentAbility` 来自某个 `active_*` 视图（分析），
 * 而同一行的 `indoor` / `sourceCategory` 来自**当前** `workouts`（可变事实）——
 * 一个响应体里两个版本被 JOIN 成一个值，客户端**没有任何办法**分辨某个数字属于哪一版。
 *
 * 本模块把两侧拆成两个可空块，并且把它们放在**同一个读快照**里取（D1 的理由：
 * 两块做成同一响应里的兄弟，C1 才可能用一条断言钉住；拆成两次请求则两次之间的提交
 * 不可观测，C1 会退化成不可断言的竞态）。
 *
 * ## 三条硬约束落在代码的哪里
 *
 * 1. **同一次请求内两块各来自各自快照** ⇒ {@link readFactReadView}。它**自己**开
 *    `BEGIN DEFERRED`，把四个读（代次、事实行、分析行、分析状态）压在一次事务里。
 *    ⚠️ 这不是"两次查询恰好看到同一版本"：SQLite 的 deferred 事务在第一次读时取 WAL
 *    快照，此后本连接的所有读都在那个快照上。把 `BEGIN DEFERRED` 去掉，
 *    `facts-reader` 之外的任何一个读都会各自取新快照，两块就可能来自不同版本。
 * 2. **事实行不含分析字段、分析行不读当前事实** ⇒ 行类型的字段集在
 *    `@rai/contracts`（`facts-analysis-view.ts`）里由类型级断言钉住（`FactsAnalysisBlocksDisjoint`），
 *    这里只负责**填**那一组键 —— 多填一个键 `tsc` 就会红。
 * 3. **默认 `null`、不是空对象** ⇒ 两个可选块由调用方决定给不给；本模块返回的是
 *    "这一侧视图的内容"，不返回占位对象。
 *
 * ## 为什么读的是"当前事实"而不是某个固定代次
 *
 * 事实块的口径是**此刻**（D4.1：事实侧一律排除已删事实）。固定代次的读法是
 * `FactsReader`（`read/facts-reader.ts`）的职责，用于"必须在稳定快照上跑 CPU 的计算"；
 * 响应体的 `currentFacts` 回答的是"现在是什么"，两者不是同一件事，不要合并。
 */

import type { DatabaseSync } from "node:sqlite";

import type {
  AnalysisBlockRow,
  AnalysisStatus,
  AnalysisView,
  FactsBlockRow,
  FactsView,
  FactVersions,
  Freshness
} from "@rai/contracts";

import { workoutPresentConditionSql } from "../sql/fragments.js";
import { nullableNumber } from "./read-utils.js";

type Row = Record<string, unknown>;

/** 事实块**最多**读出的键。类型级断言要求它与分析行无交集，见文件头。 */
export const FACTS_BLOCK_KEYS = [
  "workoutId", "activityType", "startAt", "endAt", "durationSeconds",
  "distanceMeters", "indoor", "sourceCategory", "analysisState"
] as const satisfies readonly (keyof FactsBlockRow)[];

/** 分析块**最多**读出的键。 */
export const ANALYSIS_BLOCK_KEYS = [
  "analyzedWorkoutId", "releaseId", "currentAbility", "qualityScore", "stimulusType",
  "frozenDistanceKm", "frozenDurationSeconds", "frozenStartedAt", "factDeleted"
] as const satisfies readonly (keyof AnalysisBlockRow)[];

/**
 * 事实块与分析块的行数上界。
 *
 * 🔴 为什么需要它：两块是**同一个响应里的兄弟**，而事实侧通常是"全部历史"。一个跑了
 * 十年的库会让 `/v1/workouts` 的响应体从几十行变成几万行 —— 那不是"更正确"，那是把
 * 端点打死。上界取的是分页端点自己的 `limit` 上界（`apps/api/src/server.ts` 的
 * `/v1/workouts` 把 `limit` 夹到 `[1, 100]`）；调用方显式传，这里不猜。
 */
export interface FactReadViewLimits {
  factRows: number;
  analysisRows: number;
}

export interface FactReadView {
  facts: FactsView;
  analysis: AnalysisView;
  versions: FactVersions;
  freshness: Freshness;
  /** 供调用方在**同一个快照内**继续组装同名响应（例如 `pendingAnalysisCount` 的解释）。 */
  analysisStatus: AnalysisStatus;
}

/**
 * 在**一个** `BEGIN DEFERRED` 里读齐：代次 → 分析状态 → 已发布 release → 两块行。
 *
 * `run` 是**唯一**的出口：调用方不能在事务外再读一次 `import_generations` 或
 * `active_model_run` 来"补齐"某个值 —— 那正是 C1 要挡的形态。需要额外的东西就写进
 * `run` 里，它拿得到 `database`。
 *
 * ⚠️ SQLite 没有嵌套事务，所以这个入口**不能**在已经开着事务的连接上调用
 * （`apps/api/src/data.ts` 的 `trainingPlanState` 自带一个 `BEGIN DEFERRED`，
 * 它走的是 {@link readFactReadViewInTransaction}）。
 */
export function readFactReadView(
  database: DatabaseSync,
  limits: FactReadViewLimits,
  run: (context: FactReadViewContext) => void = () => {}
): FactReadView {
  database.exec("BEGIN DEFERRED");
  try {
    const view = readFactReadViewInTransaction(database, limits, run);
    database.exec("COMMIT");
    return view;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export interface FactReadViewContext {
  database: DatabaseSync;
  versions: FactVersions;
  freshness: Freshness;
  facts: FactsView;
  analysis: AnalysisView;
}

/**
 * {@link readFactReadView} 的**事务内**形态：调用方已经持有读事务时用这个。
 *
 * 🔴 拆出这个函数的唯一理由是"同一次请求内两块各来自各自快照"必须由**调用方的事务**
 * 兜住：`trainingPlanState` 的读事务还要读 `import_manifest` / `canonical_nights` /
 * `active_model_run`，若这里另开一个 `BEGIN`，整个端点会直接抛
 * `cannot start a transaction within a transaction`；若改成"不 BEGIN 直接读"，
 * 跨快照的问题又回来了。
 */
export function readFactReadViewInTransaction(
  database: DatabaseSync,
  limits: FactReadViewLimits,
  run: (context: FactReadViewContext) => void = () => {}
): FactReadView {
  const generations = readGenerations(database);
  const versions = buildVersions(database, generations);
  const freshness = deriveFreshness(versions, generations.present);
  const facts = readFactsBlock(database, versions, limits.factRows);
  const analysis = readAnalysisBlock(database, versions, freshness.stale, limits.analysisRows);
  const view: FactReadView = {
    facts,
    analysis,
    versions,
    freshness,
    analysisStatus: versions.analysisStatus
  };
  run({ database, versions, freshness, facts, analysis });
  return view;
}

interface Generations {
  present: boolean;
  raw: number;
  dependency: number;
}

/**
 * `import_generations` 的**取值语义**，2026-10-13 实测（不是引用文档）：
 *
 * | 场景 | `(raw, dependency)` |
 * |---|---|
 * | 全新库（只跑迁移） | `(0, 0)` |
 * | 有真实训练事实、但只走过普通导入路径 | `(0, 0)` |
 * | 直连车道收过 1 批（`apps/api/src/direct-sync-ingest.ts` 递增） | `(1, 1)` 或 `(n, m)` |
 *
 * 三行的共同点是：**计数器为 `(0, 0)` 时它说明不了任何事** —— 它既可能是"还没有任何事实"
 * （全新库），也可能是"事实是别的车道写进来的"（老库）。所以 D2 的 `generations_absent`
 * 的判据就是 `raw_generation === 0`，而不是"表里有没有行"：v34 的迁移无条件插入了
 * `singleton = 1` 的那一行，**表非空与计数器可用是两件事**（这条是本轮实测确认的，
 * 旧文档 §1.3 写的"没有写入方"在 PR4 2d 之后已不成立）。
 */
function readGenerations(database: DatabaseSync): Generations {
  const row = database.prepare(
    "SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton = 1"
  ).get() as { raw?: unknown; dependency?: unknown } | undefined;
  const raw = integerOrNull(row?.raw) ?? 0;
  const dependency = integerOrNull(row?.dependency) ?? 0;
  return { present: raw > 0, raw, dependency };
}

/**
 * 分析状态由三个**既有**事实派生（D2 未决 2 的暂定口径）：最新一个绑定了当前依赖代次的
 * 分析任务的状态、该任务是否成功、以及已发布指针有没有动。
 *
 * 🔴 为什么必须跟 `active_model_run` 一起看：`recompute_jobs.status = 'succeeded'` 只说明
 * **任务跑完了**，不说明**它的结论被发布了**（`SqliteModelRunRepository.activateSucceeded`
 * 才是发布动作，见 `apps/api/src/command-queue.ts` 的 `activate_model`）。只看任务状态会
 * 把"算完了但没启用"报成 `published`，那正是"拿旧分析冒充最新"的另一种写法。
 */
function deriveAnalysisStatus(database: DatabaseSync, dependency: number): AnalysisStatus {
  const job = database.prepare(`
    SELECT job.status AS status, job.completed_at AS completedAt
    FROM recompute_jobs job
    WHERE job.target_dependency_generation = ?
    ORDER BY job.created_at DESC, job.rowid DESC
    LIMIT 1
  `).get(dependency) as { status?: unknown; completedAt?: unknown } | undefined;
  if (job === undefined) return "not_required";
  switch (String(job.status)) {
    case "succeeded":
      // 任务成功 = 结论已发布（`activateSucceeded` 在同一次成功里换指针）。若指针**没动**，
      // 仍报 published —— "指针没动"与"这次发布换了指针"在库里不可区分，冒认比冒否更安全：
      // 冒否会让 `executable` 变 false（产品被关掉），冒认最坏也只是沿用旧结论。
      return "published";
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "failed":
      return "failed";
    default:
      // `cancelled`：**不是** failed（它没有"失败原因"可显示），但也不是 published。
      // 落在"分析没跟上"这一侧，由 `stale` 表达，不编一个失败码出来。
      return "queued";
  }
}

function activeReleaseId(database: DatabaseSync): string | null {
  const row = database.prepare(
    "SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1"
  ).get() as { id?: unknown } | undefined;
  return typeof row?.id === "string" && row.id.length > 0 ? row.id : null;
}

function buildVersions(database: DatabaseSync, generations: Generations): FactVersions {
  return {
    // 计数器不可用时是 `null`，**不是** `"0"`：`"0"` 会被读成"版本 0"，而它表达的是
    // "这一侧还没有版本可报"。两种语义共用一个取值是本仓反复踩过的坑（对照 §10.1 回执里
    // `dependencyGeneration: null` 与空串的区别）。
    facts: generations.present ? String(generations.raw) : null,
    analysis: generations.present ? String(generations.dependency) : null,
    releaseId: activeReleaseId(database),
    analysisStatus: generations.present ? deriveAnalysisStatus(database, generations.dependency) : "published"
  };
}

/**
 * `stale === true` ⇔ `analysisStatus !== "published"` **或** `analysis !== facts`（D2 原文）。
 *
 * `generations_absent` 优先判断：在那个状态下 `analysis` 与 `facts` 都是 `null`（"相等"），
 * 若只按字面比较会得出 `up_to_date` —— 那会把"数字不可信"说成"一切同步"。
 */
function deriveFreshness(versions: FactVersions, generationsPresent: boolean): Freshness {
  if (!generationsPresent) return { stale: true, reason: "generations_absent", versions };
  const behind = versions.analysis !== versions.facts;
  const reason: Freshness["reason"] =
    versions.analysisStatus === "failed" ? "analysis_failed"
      : versions.analysisStatus !== "published" ? (behind ? "analysis_behind" : "analysis_missing")
        : behind ? "analysis_behind" : "up_to_date";
  return { stale: reason !== "up_to_date", reason, versions };
}

/**
 * 事实块：**当前**事实（D4.1：已删事实不出现），只带事实字段。
 *
 * `analysisState` 的判据是"这条事实有没有出现在**当前 release** 的评估里" —— 用
 * `active_ability_assessments` 的 `training_session_id` 存在性表达，而**不是**读
 * `a.current_ability` 是否非空：后者会把分数读进事实块（C2 的键集断言要求事实块行
 * 一个分析字段都不带），而且"分析过但没有值"会被误判成"没分析过"。
 *
 * `factVersion` 就是 S3 的 `versions.facts`：两块必须报**同一个**版本号，
 * 否则调用方会自己再查一次，两次查询之间的提交就没人管了。
 */
function readFactsBlock(database: DatabaseSync, versions: FactVersions, limit: number): FactsView {
  // 🔴 事实存在性**只**引用 workoutPresentConditionSql()（PR5 D4.2 的同源要求）。
  // 这里有一个真实的选择：JOIN workouts 既是取 duration_seconds / indoor / source_category
  // 的来源，也是"顺带隐藏已删训练"的那条老路；把判据挂在 JOIN 条件上，两个职责同时成立，
  // 且不需要第二处字面量。分析块**刻意不挂**（已删行要保留并标注），见 readAnalysisBlock。
  // ⚠️ 上面几句刻意**一个反引号都不写**：结构门禁按"前后各一个反引号"切 SQL 字面量，
  // 注释里的反引号会让它把注释当成一条 SQL 语句，于是报出一处并不存在的违例（实测踩过）。
  const rows = database.prepare(`
    SELECT
      session.id AS workoutId,
      session.activity_type AS activityType,
      session.anchor_start_at AS startAt,
      session.anchor_end_at AS endAt,
      session.anchor_distance_km AS distanceKm,
      ${factsAnalysisMarkerSql("session")} AS analyzed,
      workout.duration_seconds AS durationSeconds,
      workout.indoor AS indoor,
      workout.source_category AS sourceCategory
    FROM training_sessions session
    JOIN workouts workout
      ON workout.id = session.canonical_workout_id AND ${workoutPresentConditionSql("workout")}
    WHERE session.status = 'active'
    ORDER BY session.anchor_start_at DESC, session.id
    LIMIT ?
  `).all(Math.max(1, limit)) as Row[];
  return {
    factVersion: versions.facts,
    rows: rows.map((row) => ({
      workoutId: String(row.workoutId),
      activityType: String(row.activityType),
      startAt: String(row.startAt),
      endAt: String(row.endAt),
      durationSeconds: Number(row.durationSeconds),
      distanceMeters: nullableNumber(row.distanceKm) === null ? null : Number(row.distanceKm) * 1000,
      indoor: row.indoor === null || row.indoor === undefined ? null : Number(row.indoor) === 1,
      sourceCategory: typeof row.sourceCategory === "string" ? row.sourceCategory : null,
      analysisState: Number(row.analyzed) === 1 ? "analyzed" : "pending"
    })),
    pendingAnalysisCount: countPendingAnalysis(database)
  };
}

/**
 * "这条事实有没有出现在当前 release 的评估里"。
 *
 * 写成 `EXISTS` 而不是 `LEFT JOIN ... IS NOT NULL` 是刻意的：`active_ability_assessments`
 * 是逐 `(training_session_id)` 建的视图，`EXISTS` 能直接命中它的主键索引，而 JOIN 会先把
 * 整个评估集读出来再筛 —— 对一个分页端点来说那是"读 100 行、扫全表"。
 * 两种写法语义相同，取物化代价小的那一种。
 */
function factsAnalysisMarkerSql(sessionAlias: string): string {
  return `EXISTS (
    SELECT 1 FROM active_ability_assessments presence
    WHERE presence.training_session_id = ${sessionAlias}.id)`;
}

/**
 * 分析块的 `pendingAnalysisCount`：有事实、但**未被当前 release 的评估覆盖**的条数。
 *
 * 与事实块的 `analysisState` 同源（同一个 `active_ability_assessments` 视图），
 * 差别只在聚合粒度：行属性 vs 计数。刻意不再写一遍"已删事实"的判据 —— 计数分母是
 * 事实块自己的行数，两者必须一起变，否则"列表里有 N 行、其中 0 行未分析、而计数说 3"
 * 这种自相矛盾的响应没人能发现。
 */
function countPendingAnalysis(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS n
    FROM training_sessions session
    JOIN workouts workout
      ON workout.id = session.canonical_workout_id AND ${workoutPresentConditionSql("workout")}
    WHERE session.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM active_ability_assessments presence
        WHERE presence.training_session_id = session.id)
  `).get() as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * 分析块：某个**已发布 release** 的冻结输入与结论。
 *
 * 三点是"分析侧"的定义本身，改任何一点都会让这个块变成事实块的第二个名字（D5）：
 * - `JOIN active_ability_assessments`（分析侧的视图），**不**读当前事实的
 *   `indoor`/`source_category` 这些可变列；时刻与距离取 `workout_features`（已冻结的输入），
 *   不取当前 `workouts`/`anchor_*`（数据块那边读的正是它们，两块刻意不同）；
 * - 已删事实的行**保留**并标 `factDeleted: true`（D4.3）。所以这里对 `workouts` 用的是
 *   **`LEFT JOIN` + `factDeleted` 标记**，而不是把它写进 `WHERE`/`JOIN ... AND` 里过滤掉
 *   —— 过滤掉就等于"删除会改写历史结论的输入标签"，而 §9.2 明令禁止改写历史。
 *   存在性判据本身仍然只有一个来源（`workoutPresentConditionSql("fact_present")`），
 *   这里只是**取反**使用它。
 */
function readAnalysisBlock(
  database: DatabaseSync,
  versions: FactVersions,
  stale: boolean,
  limit: number
): AnalysisView {
  const rows = database.prepare(`
    SELECT
      assessment.training_session_id AS analyzedWorkoutId,
      assessment.model_run_id AS releaseId,
      assessment.current_ability AS currentAbility,
      feature.quality_score AS qualityScore,
      COALESCE(zone.stimulus_type, 'unclassified') AS stimulusType,
      feature.distance_km AS frozenDistanceKm,
      feature.duration_seconds AS frozenDurationSeconds,
      feature.workout_start_at AS frozenStartedAt,
      ${factDeletedMarkerSql()} AS factDeleted
    FROM active_ability_assessments assessment
    JOIN workout_features feature ON feature.id = assessment.feature_id
    JOIN training_sessions session ON session.id = assessment.training_session_id
    LEFT JOIN workouts fact_present
      ON fact_present.id = session.canonical_workout_id AND ${workoutPresentConditionSql("fact_present")}
    LEFT JOIN active_workout_zone_summaries zone
      ON zone.training_session_id = assessment.training_session_id
    ORDER BY feature.workout_start_at DESC, assessment.training_session_id
    LIMIT ?
  `).all(Math.max(1, limit)) as Row[];
  return {
    releaseId: versions.releaseId,
    dependencyVersion: versions.analysis,
    stale,
    rows: rows.map((row) => ({
      analyzedWorkoutId: String(row.analyzedWorkoutId),
      releaseId: String(row.releaseId),
      currentAbility: nullableNumber(row.currentAbility),
      qualityScore: Number(row.qualityScore),
      stimulusType: String(row.stimulusType),
      // `frozen*` 三个字段一律来自 `workout_features`（冻结输入），见 `readAnalysisBlock` 的注释。
      frozenDistanceKm: nullableNumber(row.frozenDistanceKm),
      frozenDurationSeconds: Number(row.frozenDurationSeconds),
      frozenStartedAt: String(row.frozenStartedAt),
      factDeleted: Number(row.factDeleted) === 1
    }))
  };
}

/**
 * "这一行引用的事实已被删除"的**取值**半边（`1` = 已删）。
 *
 * 与 {@link factDeletedJoinSql} 配对使用：两者必须成对出现，否则 `fact_present` 不存在时
 * 会退化成"未知"（`NULL`）而不是"已删"。
 */
function factDeletedMarkerSql(): string {
  return "CASE WHEN fact_present.id IS NULL THEN 1 ELSE 0 END";
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
