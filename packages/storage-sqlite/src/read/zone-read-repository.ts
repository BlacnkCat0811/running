import type { DatabaseSync } from "node:sqlite";

import type {
  DailyZoneProfile,
  StimulusType,
  TrainingZoneProfileSettings,
  WorkoutZoneSummary
} from "@rai/contracts";

import { nullableNumber, parseJson } from "./read-utils.js";

export class SqliteZoneReadRepository {
  constructor(private readonly database: DatabaseSync) {}

  latestProfile(): DailyZoneProfile | null {
    const row = this.database
      .prepare(`SELECT * FROM active_daily_zone_profiles ORDER BY local_date DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    return row ? mapZoneProfile(row) : null;
  }

  previousProfile(beforeLocalDate: string): DailyZoneProfile | null {
    const row = this.database
      .prepare(`
        SELECT * FROM active_daily_zone_profiles
        WHERE local_date < ? ORDER BY local_date DESC LIMIT 1
      `)
      .get(beforeLocalDate) as Record<string, unknown> | undefined;
    return row ? mapZoneProfile(row) : null;
  }

  history(limit: number): DailyZoneProfile[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM active_daily_zone_profiles
        ORDER BY local_date DESC LIMIT ?
      `)
      .all(limit) as unknown as Record<string, unknown>[];
    return rows.reverse().map(mapZoneProfile);
  }

  profileById(id: string): DailyZoneProfile | null {
    const row = this.database
      .prepare(`SELECT * FROM active_daily_zone_profiles WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapZoneProfile(row) : null;
  }

  settings(): TrainingZoneProfileSettings {
    const row = this.database
      .prepare(`SELECT * FROM training_zone_profile_settings ORDER BY revision DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return {
        revision: 0,
        effectiveFromLocalDate: "",
        restingHeartRate: { mode: "auto", valueBpm: null },
        maximumHeartRate: { mode: "auto", valueBpm: null },
        lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null },
        createdAt: ""
      };
    }
    return {
      revision: Number(row.revision),
      effectiveFromLocalDate: String(row.effective_from_local_date),
      restingHeartRate: {
        mode: String(row.resting_mode) as "auto" | "manual",
        valueBpm: nullableNumber(row.resting_value_bpm)
      },
      maximumHeartRate: {
        mode: String(row.maximum_mode) as "auto" | "manual",
        valueBpm: nullableNumber(row.maximum_value_bpm)
      },
      lactateThresholdPace: {
        mode: String(row.threshold_pace_mode) as "auto" | "manual",
        valueSecondsPerKm: nullableNumber(row.threshold_pace_seconds_per_km)
      },
      createdAt: String(row.created_at)
    };
  }

  workoutZoneSummary(trainingSessionId: string): WorkoutZoneSummary | null {
    const row = this.database
      .prepare(`SELECT * FROM active_workout_zone_summaries WHERE training_session_id = ?`)
      .get(trainingSessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      trainingSessionId: String(row.training_session_id),
      zoneProfileId: String(row.zone_profile_id),
      stimulusType: String(row.stimulus_type) as StimulusType,
      secondaryStimulusTypes: parseJson<WorkoutZoneSummary["secondaryStimulusTypes"]>(
        row.secondary_stimulus_types_json,
        []
      ),
      stimulusConfidence: Number(row.stimulus_confidence),
      heartRateCoverage: Number(row.heart_rate_coverage),
      paceCoverage: Number(row.pace_coverage),
      heartRateExposure: parseJson<WorkoutZoneSummary["heartRateExposure"]>(
        row.heart_rate_exposure_json,
        []
      ),
      paceExposure: parseJson<WorkoutZoneSummary["paceExposure"]>(row.pace_exposure_json, []),
      stimulusScores: parseJson<WorkoutZoneSummary["stimulusScores"]>(row.stimulus_scores_json, []),
      explanationCodes: parseJson<string[]>(row.explanation_codes_json, [])
    };
  }
}

export function mapZoneProfile(row: Record<string, unknown>): DailyZoneProfile {
  return {
    id: String(row.id),
    localDate: String(row.local_date),
    timezoneIdentifier: String(row.timezone_identifier),
    effectiveAt: String(row.effective_at),
    dataThroughAt: typeof row.data_through_at === "string" ? row.data_through_at : null,
    restingHeartRateBpm: Number(row.resting_heart_rate_bpm),
    maximumHeartRateBpm: Number(row.maximum_heart_rate_bpm),
    lactateThresholdPaceSecondsPerKm: nullableNumber(row.threshold_pace_seconds_per_km),
    heartRateSource: String(row.heart_rate_source) as DailyZoneProfile["heartRateSource"],
    paceSource: String(row.pace_source) as DailyZoneProfile["paceSource"],
    heartRateConfidence: Number(row.heart_rate_confidence),
    paceConfidence: Number(row.pace_confidence),
    status: String(row.profile_status) as DailyZoneProfile["status"],
    heartRateBands: parseJson<DailyZoneProfile["heartRateBands"]>(row.heart_rate_bands_json, []),
    paceBands: parseJson<DailyZoneProfile["paceBands"]>(row.pace_bands_json, []),
    evidence: parseJson<DailyZoneProfile["evidence"]>(row.evidence_json, {
      restingHeartRateDays: 0,
      maximumHeartRateWorkouts: 0,
      thresholdEvidenceCount: 0
    }),
    createdAt: String(row.created_at)
  };
}
