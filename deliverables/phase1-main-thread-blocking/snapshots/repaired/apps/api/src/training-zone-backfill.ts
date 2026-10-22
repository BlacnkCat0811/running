import type { DatabaseSync } from "node:sqlite";

import { FEATURE_SCHEMA_VERSION, TRAINING_LOAD_CONFIG_VERSION } from "@rai/contracts";

export interface TrainingZoneWorkoutSetCounts {
  missingSummaryCount: number;
  orphanSummaryCount: number;
}

export const readTrainingZoneWorkoutSetCounts = (
  database: DatabaseSync
): TrainingZoneWorkoutSetCounts => {
  const row = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM (
        SELECT training_session_id FROM active_workout_training_loads
        EXCEPT
        SELECT training_session_id FROM active_workout_zone_summaries
      )) AS missing_summary_count,
      (SELECT COUNT(*) FROM (
        SELECT training_session_id FROM active_workout_zone_summaries
        EXCEPT
        SELECT training_session_id FROM active_workout_training_loads
      )) AS orphan_summary_count
  `).get() as { missing_summary_count: number; orphan_summary_count: number };
  return {
    missingSummaryCount: Number(row.missing_summary_count),
    orphanSummaryCount: Number(row.orphan_summary_count)
  };
};

export interface TrainingZoneBackfillState {
  activeAlgorithmVersion: string | null;
  activeFeatureSchemaVersion: string | null;
  missingSummaryCount: number;
  orphanSummaryCount: number;
}

export const needsFullTrainingZoneBackfill = (state: TrainingZoneBackfillState): boolean =>
  state.activeAlgorithmVersion !== TRAINING_LOAD_CONFIG_VERSION ||
  state.activeFeatureSchemaVersion !== FEATURE_SCHEMA_VERSION ||
  Number(state.missingSummaryCount) > 0 ||
  Number(state.orphanSummaryCount) > 0;
