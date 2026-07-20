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

/** Core SELECT list for model-run summary rows (includes active flag and counts). */
export const MODEL_RUN_SUMMARY_SELECT = `
  mr.*, amr.model_run_id IS NOT NULL AS active,
  (SELECT COUNT(*) FROM ability_assessments a WHERE a.model_run_id = mr.id) AS assessment_count,
  (SELECT COUNT(*) FROM daily_ability_snapshots s WHERE s.model_run_id = mr.id) AS snapshot_count
`;
