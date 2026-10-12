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
      WHERE w.id = ${sessionAlias}.canonical_workout_id
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

/** Core SELECT list for model-run summary rows (includes active flag and counts). */
export const MODEL_RUN_SUMMARY_SELECT = `
  mr.*, amr.model_run_id IS NOT NULL AS active,
  (SELECT COUNT(*) FROM ability_assessments a WHERE a.model_run_id = mr.id) AS assessment_count,
  (SELECT COUNT(*) FROM daily_ability_snapshots s WHERE s.model_run_id = mr.id) AS snapshot_count
`;
