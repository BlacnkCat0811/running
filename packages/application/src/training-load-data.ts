import type { DatabaseSync } from "node:sqlite";
import type { SessionType, WorkoutTrainingLoad } from "@rai/contracts";
import type { DailyPhysEvidence } from "@rai/training-load";
import { physStateFromReadiness } from "@rai/readiness";
import { loadDatedReadiness } from "./model-v2-snapshots.js";
import { addDays, localDateStartAt, parseJson } from "./utils.js";
import { asNullableNumber } from "./recompute-helpers.js";

// Shared by production refresh/recompute and offline load replay. Do not add a
// second SQL-to-domain mapping in the audit runner.
export function loadPersistedTrainingLoads(database: DatabaseSync, metricRunId: string): WorkoutTrainingLoad[] {
    const rows = database.prepare(`
      SELECT * FROM workout_training_loads
      WHERE training_metric_run_id = ? ORDER BY local_date, training_session_id
    `).all(metricRunId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      trainingSessionId: String(row.training_session_id),
      localDate: String(row.local_date),
      distanceMeters: row.distance_km === null ? null : Number(row.distance_km) * 1000,
      durationSeconds: Number(row.duration_seconds),
      load: Number(row.training_load),
      intensity: Number(row.intensity),
      source: String(row.load_source) as WorkoutTrainingLoad["source"],
      confidence: Number(row.confidence),
      rpe: row.rpe === null ? null : Number(row.rpe),
      sessionType: String(row.session_type) as SessionType,
      averageHeartRate: row.average_heart_rate_bpm === null ? null : Number(row.average_heart_rate_bpm),
      elevationGainMeters: row.elevation_gain_meters === null ? null : Number(row.elevation_gain_meters),
      stimulusType: String(row.stimulus_type ?? "unclassified") as WorkoutTrainingLoad["stimulusType"],
      breakdown: {
        rawHrrTrimp: asNullableNumber(row.raw_hrr_trimp),
        internalLoad: asNullableNumber(row.internal_load),
        paceLoad: asNullableNumber(row.pace_load),
        distanceReferenceMeters: asNullableNumber(row.distance_reference_meters),
        distanceExposureRatio: asNullableNumber(row.distance_exposure_ratio),
        distanceFactor: Number(row.distance_factor ?? 1),
        compositeLoad: Number(row.training_load),
        compositeIntensity: Number(row.intensity),
        heartRateConfidence: Number(row.heart_rate_load_confidence ?? 0),
        paceConfidence: Number(row.pace_load_confidence ?? 0)
      },
      explanations: parseJson<{ explanations: WorkoutTrainingLoad["explanations"] }>(
        String(row.provenance_json),
        { explanations: [] }
      ).explanations
    }));
  }


export function loadDailyPhysEvidence(database: DatabaseSync, startDate: string, throughDate: string, timezoneIdentifier: string, asOfAt: string): DailyPhysEvidence[] {
    const result:DailyPhysEvidence[]=[];
    for(let date=startDate;date<=throughDate;date=addDays(date,1)){
      const end=Date.parse(localDateStartAt(addDays(date,1),timezoneIdentifier))-1;
      const asOf=new Date(Math.min(end,Date.parse(asOfAt))).toISOString();
      result.push({localDate:date,physState:physStateFromReadiness(loadDatedReadiness(database,asOf,timezoneIdentifier))});
    }
    return result;
  }
