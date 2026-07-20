export function historicalOverrideJoin(
  joinType: "JOIN" | "LEFT JOIN",
  sessionAlias = "session"
): string {
  return `${joinType} workout_overrides override
    ON override.id = (
      SELECT historical_override.id
      FROM workout_overrides historical_override
      WHERE historical_override.training_session_id = ${sessionAlias}.id
        AND historical_override.created_at <= ?
      ORDER BY historical_override.revision DESC
      LIMIT 1
    )`;
}

export function historicalEligibilitySql(
  featureAlias = "feature",
  overrideAlias = "override"
): string {
  return `CASE
    WHEN ${overrideAlias}.eligibility_override = 'exclude' THEN 'excluded'
    WHEN EXISTS (
      SELECT 1 FROM json_each(${featureAlias}.missing_reasons_json) reason
      WHERE reason.value IN (
        'session_ambiguous', 'distance_missing', 'distance_below_1km',
        'duration_below_8min', 'indoor_workout', 'implausible_average_pace'
      )
    ) THEN 'excluded'
    WHEN ${overrideAlias}.eligibility_override = 'include' THEN 'eligible'
    WHEN EXISTS (
      SELECT 1 FROM json_each(${featureAlias}.missing_reasons_json) reason
      WHERE reason.value IN ('heart_rate_coverage_low', 'indoor_status_unknown')
    ) THEN 'trial'
    ELSE 'eligible'
  END`;
}

export function historicalQualitySql(
  featureAlias = "feature",
  overrideAlias = "override"
): string {
  const eligibility = historicalEligibilitySql(featureAlias, overrideAlias);
  return `MAX(0, MIN(1,
    ${featureAlias}.quality_score
    - CASE ${featureAlias}.eligibility_status
        WHEN 'eligible' THEN 0.2 WHEN 'trial' THEN 0.1 ELSE 0 END
    + CASE (${eligibility})
        WHEN 'eligible' THEN 0.2 WHEN 'trial' THEN 0.1 ELSE 0 END
  ))`;
}
