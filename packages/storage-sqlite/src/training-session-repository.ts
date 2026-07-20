import type { DatabaseSync } from "node:sqlite";

import type { PerformanceProtocol, SessionType, WorkoutOverride } from "@rai/contracts";

import { parseJson } from "./utils.js";

const runningType = "HKWorkoutActivityTypeRunning";
const distanceType = "HKQuantityTypeIdentifierDistanceWalkingRunning";

export interface FeatureSessionRow {
  trainingSessionId: string;
  trainingSessionStatus: "active" | "inactive" | "ambiguous";
  canonicalWorkoutId: string;
  workoutStartAt: string;
  workoutEndAt: string;
  durationSeconds: number;
  indoor: number | null;
  sourceCategory: string;
  sourceName: string;
  distanceValue: number | null;
  distanceUnit: string | null;
}

export class SqliteTrainingSessionRepository {
  constructor(private readonly database: DatabaseSync) {}

  exists(trainingSessionId: string): boolean {
    const row = this.database
      .prepare("SELECT id FROM training_sessions WHERE id = ?")
      .get(trainingSessionId) as { id: string } | undefined;
    return Boolean(row);
  }

  listActiveForFeatures(): FeatureSessionRow[] {
    return this.database
      .prepare(`
        SELECT
          session.id AS trainingSessionId,
          session.status AS trainingSessionStatus,
          workout.id AS canonicalWorkoutId,
          workout.start_at AS workoutStartAt,
          workout.end_at AS workoutEndAt,
          workout.duration_seconds AS durationSeconds,
          workout.indoor,
          workout.source_category AS sourceCategory,
          workout.source_name AS sourceName,
          (
            SELECT statistic.sum_value FROM workout_statistics statistic
            WHERE statistic.workout_id = workout.id AND statistic.type = ?
            ORDER BY statistic.ordinal LIMIT 1
          ) AS distanceValue,
          (
            SELECT statistic.unit FROM workout_statistics statistic
            WHERE statistic.workout_id = workout.id AND statistic.type = ?
            ORDER BY statistic.ordinal LIMIT 1
          ) AS distanceUnit
        FROM training_sessions session
        JOIN workouts workout ON workout.id = session.canonical_workout_id
        WHERE session.activity_type = ? AND session.status IN ('active', 'ambiguous')
        ORDER BY workout.start_at, session.id
      `)
      .all(distanceType, distanceType, runningType) as unknown as FeatureSessionRow[];
  }

  loadOverride(trainingSessionId: string): WorkoutOverride | null {
    const row = this.database
      .prepare("SELECT * FROM effective_workout_overrides WHERE training_session_id = ?")
      .get(trainingSessionId) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      trainingSessionId: String(row.training_session_id),
      revision: Number(row.revision),
      eligibilityOverride:
        row.eligibility_override === "include" || row.eligibility_override === "exclude"
          ? row.eligibility_override
          : null,
      sessionType: typeof row.session_type === "string" ? (row.session_type as SessionType) : null,
      performanceProtocol:
        typeof row.performance_protocol === "string"
          ? (row.performance_protocol as PerformanceProtocol)
          : null,
      statisticsParticipation:
        row.statistics_participation === "include" || row.statistics_participation === "exclude"
          ? row.statistics_participation
          : null,
      rpe: typeof row.rpe === "number" ? row.rpe : null,
      conditionTags: parseJson(typeof row.condition_tags_json === "string" ? row.condition_tags_json : "[]", []),
      note: typeof row.note === "string" ? row.note : null,
      createdAt: String(row.created_at)
    };
  }
}
