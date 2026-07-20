import type { DatabaseSync } from "node:sqlite";

import { nullableNumber, parseJson } from "./read-utils.js";

export interface StoredAbilitySnapshot {
  localDate: string;
  trueAbility: number | null;
  decayPoints: number;
  growthVelocityPerWeek: number | null;
  status: string;
}

export interface StoredEligibilityTotals {
  sessions: number;
  eligible: number;
  trial: number;
  excluded: number;
}

export interface StoredAbilityDimensions {
  efficiency: number | null;
  pace: number | null;
  cardio: number | null;
  stability: number | null;
  recovery: number | null;
  explanationCodes: string[];
}

export interface StoredCalibrationProgress {
  status: "completed" | "calibrating" | "not_started";
  eligibleSessions: number;
  eligibleDurationMinutes: number;
  spanDays: number;
  highCoverageSessions: number;
  requirements: {
    sessions: number;
    durationMinutes: number;
    spanDays: number;
    highCoverageSessions: number;
  };
  baselineStartAt: string | null;
  baselineEndAt: string | null;
}

export class SqliteDashboardReadRepository {
  constructor(private readonly database: DatabaseSync) {}

  latestAbilitySnapshot(): StoredAbilitySnapshot | null {
    const row = this.database
      .prepare(`
        SELECT local_date, true_ability, decay_points, growth_velocity_per_week, snapshot_status
        FROM active_daily_ability_snapshots
        ORDER BY local_date DESC
        LIMIT 1
      `)
      .get() as Record<string, unknown> | undefined;
    return row ? mapSnapshot(row) : null;
  }

  abilitySnapshotOnOrBefore(localDate: string, daysBefore = 0): StoredAbilitySnapshot | null {
    const row = this.database
      .prepare(`
        SELECT local_date, true_ability, decay_points, growth_velocity_per_week, snapshot_status
        FROM active_daily_ability_snapshots
        WHERE local_date <= date(?, ?)
        ORDER BY local_date DESC
        LIMIT 1
      `)
      .get(localDate, `-${daysBefore} day`) as Record<string, unknown> | undefined;
    return row ? mapSnapshot(row) : null;
  }

  eligibilityTotals(): StoredEligibilityTotals {
    const totals = this.database
      .prepare(`
        SELECT
          COUNT(*) AS sessions,
          SUM(CASE WHEN f.eligibility_status = 'eligible' THEN 1 ELSE 0 END) AS eligible,
          SUM(CASE WHEN f.eligibility_status = 'trial' THEN 1 ELSE 0 END) AS trial,
          SUM(CASE WHEN f.eligibility_status = 'excluded' THEN 1 ELSE 0 END) AS excluded
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
      `)
      .get() as Record<string, unknown>;
    return {
      sessions: Number(totals.sessions ?? 0),
      eligible: Number(totals.eligible ?? 0),
      trial: Number(totals.trial ?? 0),
      excluded: Number(totals.excluded ?? 0)
    };
  }

  assessmentDimensions(trainingSessionId: string): StoredAbilityDimensions | null {
    const row = this.database
      .prepare(`
        SELECT efficiency_score, pace_score, cardio_score, stability_score, recovery_score,
               explanation_codes_json
        FROM active_ability_assessments
        WHERE training_session_id = ?
      `)
      .get(trainingSessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      efficiency: nullableNumber(row.efficiency_score),
      pace: nullableNumber(row.pace_score),
      cardio: nullableNumber(row.cardio_score),
      stability: nullableNumber(row.stability_score),
      recovery: nullableNumber(row.recovery_score),
      explanationCodes: parseJson<string[]>(row.explanation_codes_json, [])
    };
  }

  calibrationProgress(): StoredCalibrationProgress {
    const active = this.database
      .prepare(`
        SELECT mr.model_config_json, mr.summary_json
        FROM model_runs mr
        JOIN active_model_run amr ON amr.model_run_id = mr.id
      `)
      .get() as Record<string, unknown> | undefined;
    const config = parseJson<{
      calibrationMinimumSessions?: number;
      calibrationMinimumSpanDays?: number;
    }>(active?.model_config_json, {});
    const summary = parseJson<{
      baseline?: { calibrationStartAt?: string; calibrationEndAt?: string };
    }>(active?.summary_json, {});
    const observed = this.database
      .prepare(`
        SELECT COUNT(*) AS sessions,
               SUM(f.duration_seconds) / 60.0 AS duration_minutes,
               MIN(f.workout_start_at) AS first_at,
               MAX(f.workout_start_at) AS last_at,
               SUM(CASE WHEN f.heart_rate_coverage >= 0.8 THEN 1 ELSE 0 END) AS high_coverage
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        WHERE f.eligibility_status = 'eligible'
      `)
      .get() as Record<string, unknown>;
    const first = typeof observed.first_at === "string" ? observed.first_at : null;
    const last = typeof observed.last_at === "string" ? observed.last_at : null;
    const spanDays = first && last
      ? Math.max(0, Math.floor((Date.parse(last) - Date.parse(first)) / 86_400_000))
      : 0;
    const sessions = Number(observed.sessions ?? 0);
    return {
      status: summary.baseline ? "completed" : sessions > 0 ? "calibrating" : "not_started",
      eligibleSessions: sessions,
      eligibleDurationMinutes: Number(observed.duration_minutes ?? 0),
      spanDays,
      highCoverageSessions: Number(observed.high_coverage ?? 0),
      requirements: {
        sessions: config.calibrationMinimumSessions ?? 6,
        durationMinutes: 120,
        spanDays: config.calibrationMinimumSpanDays ?? 14,
        highCoverageSessions: 4
      },
      baselineStartAt: summary.baseline?.calibrationStartAt ?? null,
      baselineEndAt: summary.baseline?.calibrationEndAt ?? null
    };
  }
}

function mapSnapshot(row: Record<string, unknown>): StoredAbilitySnapshot {
  return {
    localDate: String(row.local_date),
    trueAbility: nullableNumber(row.true_ability),
    decayPoints: Number(row.decay_points ?? 0),
    growthVelocityPerWeek: nullableNumber(row.growth_velocity_per_week),
    status: String(row.snapshot_status)
  };
}
