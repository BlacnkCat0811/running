import type { DatabaseSync } from "node:sqlite";

import { SQL_UTC_OFFSET_MODIFIER } from "@rai/contracts";
import { nullableNumber } from "./read-utils.js";

export interface StoredTrendDaily {
  baselineEpochId?: string | null;
  date: string;
  trueAbility: number | null;
  decayPoints: number;
  growthVelocityPerWeek: number | null;
  status: string;
}

export interface StoredTrendWorkout {
  id: string;
  date: string;
  currentAbility: number | null;
  confidence: number | null;
  assessmentStatus: string;
  distanceKm: number | null;
  durationSeconds: number;
  workoutContribution: number | null;
  dimensions: {
    efficiency: number | null;
    pace: number | null;
    cardio: number | null;
    stability: number | null;
    recovery: number | null;
  };
}

export interface StoredTrendContext {
  date: string;
  distanceKm: number;
  durationMinutes: number;
  trainingLoad: number;
}

export interface StoredTrendModelRun {
  id: string;
  date: string;
  modelVersion: string;
  active: boolean;
}

export interface StoredTrends {
  startDate: string | null;
  endDate: string | null;
  daily: StoredTrendDaily[];
  workouts: StoredTrendWorkout[];
  context: StoredTrendContext[];
  modelRuns: StoredTrendModelRun[];
}

export class SqliteTrendsReadRepository {
  constructor(private readonly database: DatabaseSync) {}

  load(days: number): StoredTrends {
    const end = this.database
      .prepare("SELECT MAX(local_date) AS value FROM active_daily_ability_snapshots")
      .get() as Record<string, unknown>;
    const endDate = typeof end.value === "string" ? end.value : null;
    const startDate = endDate ? new Date(`${endDate}T00:00:00Z`) : null;
    if (startDate) startDate.setUTCDate(startDate.getUTCDate() - Math.max(days - 1, 0));
    const start = startDate?.toISOString().slice(0, 10) ?? null;

    const hasEpoch = Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='ability_assessments'").get()) &&
      (this.database.prepare("PRAGMA table_info(active_daily_ability_snapshots)").all() as Array<{name:string}>).some((c)=>c.name==="last_assessment_id");
    const epochSql = hasEpoch ? "(SELECT json_extract(a.explanation_json,'$.baselineEpochId') FROM ability_assessments a WHERE a.id=active_daily_ability_snapshots.last_assessment_id)" : "NULL";
    const daily = this.database
      .prepare(`
        SELECT local_date, true_ability, decay_points, growth_velocity_per_week, snapshot_status,
          ${epochSql} AS baseline_epoch_id
        FROM active_daily_ability_snapshots
        WHERE (? IS NULL OR local_date >= ?)
        ORDER BY local_date
      `)
      .all(start, start) as Record<string, unknown>[];
    const workouts = this.database
      .prepare(`
        SELECT a.training_session_id, f.workout_start_at, load.local_date,
               a.current_ability, a.confidence,
               a.assessment_status, f.distance_km, f.duration_seconds, a.workout_contribution,
               a.efficiency_score, a.pace_score, a.cardio_score, a.stability_score, a.recovery_score
        FROM active_ability_assessments a
        JOIN workout_features f ON f.id = a.feature_id
        JOIN active_workout_training_loads load ON load.training_session_id = a.training_session_id
        WHERE (? IS NULL OR load.local_date >= ?)
        ORDER BY f.workout_start_at
      `)
      .all(start, start) as Record<string, unknown>[];
    const context = this.database
      .prepare(`
        SELECT load.local_date,
               SUM(COALESCE(load.distance_km, 0)) AS distance_km,
               SUM(load.duration_seconds) / 60.0 AS duration_minutes,
               SUM(load.training_load) AS training_load
        FROM active_ability_assessments a
        JOIN active_workout_training_loads load ON load.training_session_id = a.training_session_id
        WHERE (? IS NULL OR load.local_date >= ?)
        GROUP BY load.local_date
        ORDER BY local_date
      `)
      .all(start, start) as Record<string, unknown>[];
    const modelRuns = this.database
      .prepare(`
        SELECT mr.id, mr.evaluated_at, mr.model_version, amr.model_run_id IS NOT NULL AS active
        FROM model_runs mr
        LEFT JOIN active_model_run amr ON amr.model_run_id = mr.id
        WHERE mr.status = 'succeeded'
          AND (amr.model_run_id IS NOT NULL OR ? IS NULL OR date(mr.evaluated_at, '${SQL_UTC_OFFSET_MODIFIER}') >= ?)
        ORDER BY mr.evaluated_at
      `)
      .all(start, start) as Record<string, unknown>[];

    return {
      startDate: daily[0] ? String(daily[0].local_date) : null,
      endDate: daily.at(-1) ? String(daily.at(-1)?.local_date) : null,
      daily: daily.map((row) => ({
        date: String(row.local_date),
        trueAbility: nullableNumber(row.true_ability),
        baselineEpochId: typeof row.baseline_epoch_id === "string" ? row.baseline_epoch_id : null,
        decayPoints: Number(row.decay_points ?? 0),
        growthVelocityPerWeek: nullableNumber(row.growth_velocity_per_week),
        status: String(row.snapshot_status)
      })),
      workouts: workouts.map((row) => ({
        id: String(row.training_session_id),
        date: String(row.workout_start_at),
        currentAbility: nullableNumber(row.current_ability),
        confidence: nullableNumber(row.confidence),
        assessmentStatus: String(row.assessment_status),
        distanceKm: nullableNumber(row.distance_km),
        durationSeconds: Number(row.duration_seconds),
        workoutContribution: nullableNumber(row.workout_contribution),
        dimensions: {
          efficiency: nullableNumber(row.efficiency_score),
          pace: nullableNumber(row.pace_score),
          cardio: nullableNumber(row.cardio_score),
          stability: nullableNumber(row.stability_score),
          recovery: nullableNumber(row.recovery_score)
        }
      })),
      context: context.map((row) => ({
        date: String(row.local_date),
        distanceKm: Number(row.distance_km ?? 0),
        durationMinutes: Number(row.duration_minutes ?? 0),
        trainingLoad: Number(row.training_load ?? 0)
      })),
      modelRuns: modelRuns.map((row) => ({
        id: String(row.id),
        date: String(row.evaluated_at),
        modelVersion: String(row.model_version),
        active: Number(row.active) === 1
      }))
    };
  }
}
