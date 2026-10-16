/**
 * Shared SQL fragments used by both read (API) and write/recompute paths.
 * Keep business duration/eligibility definitions here to avoid dual-SQL drift.
 */

/** Prefer canonical workout active duration; fall back to wall-clock session span. */
export function activeDurationSecondsSql(sessionAlias = "session"): string {
  return `COALESCE(
    (
      SELECT w.duration_seconds
      FROM workouts w
      WHERE w.id = ${sessionAlias}.canonical_workout_id AND ${workoutPresentConditionSql("w")}
    ),
    (julianday(${sessionAlias}.anchor_end_at) - julianday(${sessionAlias}.anchor_start_at)) * 86400.0
  )`;
}

/**
 * 「这条路线此刻有没有一份正在展示的可用轨迹」的**唯一**判据。
 *
 * 🔴 为什么必须同源：同一行 `workout_routes` 有两个消费方 ——
 * 写侧 `RaiDatabase.hasUsableRoute(routeId)` 用它决定"失败时要不要把旧轨迹打成
 * `pending`/`invalid`"（`gpx-parser.ts`），读侧 `FactsReader.routeFor(workoutId)`
 * 用它决定"这条 workout 有没有可用轨迹"。
 *
 * 2026-10-12 之前读侧只判 `point_count > 0`、**不看 `file_status`**，于是同一行
 * （`file_status = 'pending'` 而 `point_count = 2`）会被读侧说成"有轨迹"、被写侧说成
 * "没有"。两处各写一遍条件时，这种分叉只能靠人去发现；写成这一个函数之后，
 * 它**在结构上不可能**再分叉。
 *
 * 判据是"已发布 + 非空"，而**不是**"`published_route_version_id` 非空"：指针是 v35 才有的列，
 * 既有库里的老路线指针仍是 NULL，但它们确实有一份正在展示的轨迹（见 `database.ts` 的同名注释）。
 *
 * @param alias `workout_routes` 在调用点的表别名；不传则列名不加前缀。
 */
export function usableRouteConditionSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}file_status = 'imported' AND ${prefix}point_count > 0`;
}

/**
 * 「此刻可读的路线点」这个**唯一**的关系（v43 视图，见 `v43-migration.ts`）。
 *
 * 为什么要有这个名字常量：视图的判据是上面那条 `usableRouteConditionSql()` 的**字面副本**
 * （迁移冻结之后不能再引用会变的东西），而引用视图的地方散在多个包
 * （`sqlite` 读仓储、`apps/api` 的等价性摘要、`health-export-parser` 的审计、
 * `scripts/normalization-coverage.mts`）。写字符串容易打错成"表名看起来对、其实读的是
 * legacy 表"这种静默错误；写成常量之后，拼错是**编译期**的事。
 *
 * ⚠️ 引用它只解决"名字对不对"，**不**替代 `read/route-point-reader.ts`：
 * 视图负责"哪些点可读"，reader 负责"怎么读、怎么排序、空集怎么表达"。
 * 新的读端应当直接注入 {@link SqliteRoutePointReader}，而不是自己拼 SQL。
 */
export const READABLE_ROUTE_POINTS_VIEW = "readable_route_points";

/**
 * 「这条训练事实此刻**还在不在**」的**唯一**判据（PR5 D4，见
 * `docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md`）。
 *
 * 语义：`workouts.deleted_at` 为 `NULL` = 事实仍在；非空 = 已删（值 = 删除时刻；v36 只新增可空列）。
 *
 * 🔴 为什么必须有这一个函数：
 * - 今天的事实侧读法是"靠 `JOIN workouts` 顺带隐藏已删训练"，而**不 JOIN 那张表**的读
 *   （今日/周/月汇总、`planActual`、`qualityDates`、成绩候选…）在删除之后**继续统计旧负荷**
 *   —— 那正是 §9.1「旧分数 JOIN 新训练」在用户面前显形。
 * - 判据写成函数之后，"同一件事两处写法"在结构上不可能：全仓只允许这一处出现 `deleted_at`
 *   的可见性条件（结构门禁扫源码，见 `packages/storage-sqlite/test/workout-presence.test.ts`）。
 *
 * ⚠️ 不要用 `import_entity_tombstones` 当长期判据：墓碑会被 `prune-tombstones` 清理，
 * 清理之后已删训练会**静默复活**。墓碑的职责是"防止后续载荷重新引入"（防复活），
 * 与"此刻可不可见"是两件事。
 *
 * @param alias `workouts` 在调用点的表别名；不传则列名不加前缀。
 */
export function workoutPresentConditionSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}deleted_at IS NULL`;
}

/**
 * 会话级的事实存在性判据：该 `training_sessions` 行指向的训练事实此刻仍在。
 *
 * 有些读路径（今日/周/月汇总、统计、趋势）手里只有 `training_session_id`，没有 `workouts` 的 JOIN
 * —— 它们必须用这一条把已删事实排除掉。它**组合**上面那一条，所以"什么算存在"只有一个定义。
 */
export function sessionFactPresentConditionSql(sessionAlias = "session"): string {
  return `${sessionAlias}.canonical_workout_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM workouts fact_present
    WHERE fact_present.id = ${sessionAlias}.canonical_workout_id
      AND ${workoutPresentConditionSql("fact_present")})`;
}

/** Core SELECT list for model-run summary rows (includes active flag and counts). */
export const MODEL_RUN_SUMMARY_SELECT = `
  mr.*, amr.model_run_id IS NOT NULL AS active,
  (SELECT COUNT(*) FROM ability_assessments a WHERE a.model_run_id = mr.id) AS assessment_count,
  (SELECT COUNT(*) FROM daily_ability_snapshots s WHERE s.model_run_id = mr.id) AS snapshot_count
`;
