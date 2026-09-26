import type { DatabaseSync } from "node:sqlite";

import { DATABASE_TIMEZONE, healthTypes, raceDistanceMeters, type RaceDistance } from "@rai/contracts";
import {
  activeDurationSecondsSql,
  SqlitePredictionRecoveryReadRepository
  , type PredictionRecoveryProvenance
} from "@rai/storage-sqlite";

import {
  historicalEligibilitySql,
  historicalOverrideJoin,
  historicalQualitySql
} from "./prediction-historical-features.js";
import {
  performanceEvidence,
  performanceVdotEvidence,
  type LactateThresholdEvidence,
  type PerformanceObservation,
  type PerformanceVdotEvidence,
  type PredictionReadiness,
  type PhysiologyProfile,
  type Vo2MaxEvidence
} from "@rai/physiology";

interface HealthRecordRow {
  id: string;
  observedAt: string;
  value: number;
  sourceCategory: string;
}

interface PerformanceRow {
  id: string;
  observedAt: string;
  completedAt: string;
  distanceKm: number;
  durationSeconds: number;
  sessionType: string | null;
  performanceProtocol: string | null;
  rpe: number | null;
  conditionTagsJson: string;
  overrideCreatedAt: string;
}

interface ThresholdSessionRow {
  id: string;
  observedAt: string;
  completedAt: string;
  sourceName: string;
  sourceConfidence: number;
  sessionType: string | null;
  performanceProtocol: string | null;
  conditionTagsJson: string | null;
}

interface PerformanceEnvelopeRow extends PerformanceRow {
  qualityScore: number;
  sourceConfidence: number;
  eligibilityStatus: string;
  metadataJson: string;
}

export const PERFORMANCE_ENVELOPE_WINDOW_DAYS = 56;

export interface RaceReadinessEvidence {
  values: PredictionReadiness;
  status: "available" | "insufficient_data";
  evidenceCount: number;
  dataThroughAt: string | null;
}

export interface RecoveryReadinessEvidence {
  value: number | null;
  provenance: PredictionRecoveryProvenance;
}

interface SeriesRow {
  value: number;
  unit: string | null;
  observedAt: string;
}

export interface LabeledRaceOutcome {
  id: string;
  distance: RaceDistance;
  observedAt: string;
  completedAt: string;
  labelAvailableAt: string;
  actualDistanceMeters: number;
  actualSeconds: number;
  labelSource: Exclude<PerformanceObservation["source"], "hard_workout">;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted[middle - 1];
  if (upper === undefined) return null;
  return sorted.length % 2 === 0 && lower !== undefined ? (lower + upper) / 2 : upper;
}

function daysBetween(earlier: string, later: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / 86_400_000;
}

function conditionTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function evidenceLabel(row: PerformanceRow): {
  source: PerformanceObservation["source"];
  quality: number;
} | null {
  const tags = conditionTags(row.conditionTagsJson);
  if (
    row.performanceProtocol === "half_marathon_race" ||
    row.performanceProtocol === "other_race"
  ) {
    return { source: "race", quality: 1 };
  }
  if (
    row.performanceProtocol === "five_k_time_trial" ||
    row.performanceProtocol === "ten_k_time_trial"
  ) {
    return { source: "standard_test", quality: 0.98 };
  }
  if (row.sessionType === "race" || tags.includes("race")) {
    return { source: "race", quality: 1 };
  }
  if (tags.includes("standard_test")) {
    return { source: "standard_test", quality: 0.95 };
  }
  if (tags.includes("time_trial")) {
    return { source: "time_trial", quality: 0.88 };
  }
  if (row.rpe !== null && row.rpe >= 9) {
    return { source: "hard_workout", quality: 0.55 };
  }
  return null;
}

function performanceProtocolExpression(database: DatabaseSync): string {
  const columns = database
    .prepare("PRAGMA table_info(workout_overrides)")
    .all() as unknown as Array<{ name: string }>;
  return columns.some((column) => column.name === "performance_protocol")
    ? "override.performance_protocol"
    : "NULL";
}

function performanceRows(database: DatabaseSync, asOf: string): PerformanceRow[] {
  return database
    .prepare(`
      SELECT
        session.id,
        session.anchor_start_at AS observedAt,
        session.anchor_end_at AS completedAt,
        session.anchor_distance_km AS distanceKm,
        ${activeDurationSecondsSql("session")} AS durationSeconds,
        override.session_type AS sessionType,
        ${performanceProtocolExpression(database)} AS performanceProtocol,
        override.rpe,
        override.condition_tags_json AS conditionTagsJson
        , override.created_at AS overrideCreatedAt
      FROM training_sessions session
      ${historicalOverrideJoin("JOIN")}
      WHERE session.status = 'active'
        AND session.anchor_distance_km IS NOT NULL
        AND session.anchor_distance_km > 0
        AND session.anchor_end_at <= ?
      ORDER BY session.anchor_start_at
    `)
    .all(asOf, asOf) as unknown as PerformanceRow[];
}

export function loadDirectVo2Evidence(
  database: DatabaseSync,
  asOf: string
): Vo2MaxEvidence[] {
  const rows = database
    .prepare(`
      SELECT
        id,
        start_at AS observedAt,
        value_numeric AS value,
        source_category AS sourceCategory
      FROM health_records
      WHERE type = ?
        AND value_numeric IS NOT NULL
        AND start_at < ?
      ORDER BY start_at
    `)
    .all(healthTypes.vo2Max, asOf) as unknown as HealthRecordRow[];
  return rows.map((row) => ({
    id: row.id,
    observedAt: row.observedAt,
    valueMlKgMin: row.value,
    source: "apple_health",
    quality: row.sourceCategory === "apple_watch" ? 1 : 0.65
  }));
}

export function loadLabeledPerformanceEvidence(
  database: DatabaseSync,
  asOf: string
): Vo2MaxEvidence[] {
  return performanceRows(database, asOf).flatMap((row) => {
    const label = evidenceLabel(row);
    if (label === null) return [];
    return [performanceEvidence({
      id: row.id,
      observedAt: row.completedAt,
      distanceMeters: row.distanceKm * 1_000,
      durationSeconds: row.durationSeconds,
      source: label.source,
      quality: label.quality
    })];
  });
}

export function loadPerformanceVdotEvidence(
  database: DatabaseSync,
  asOf: string
): PerformanceVdotEvidence[] {
  const labeled = performanceRows(database, asOf).flatMap((row) => {
    const label = evidenceLabel(row);
    if (
      label === null ||
      label.source === "hard_workout" ||
      row.durationSeconds < 12 * 60 ||
      row.durationSeconds > 4 * 60 * 60 ||
      row.distanceKm <= 0
    ) {
      return [];
    }
    const paceMinutesPerKm = row.durationSeconds / 60 / row.distanceKm;
    if (paceMinutesPerKm < 2.5 || paceMinutesPerKm > 15) return [];
    return [performanceVdotEvidence({
      id: row.id,
      observedAt: row.completedAt,
      distanceMeters: row.distanceKm * 1_000,
      durationSeconds: row.durationSeconds,
      source: label.source,
      quality: label.quality
    })];
  });
  const rows = database
    .prepare(`
      SELECT
        session.id,
        session.anchor_start_at AS observedAt,
        session.anchor_end_at AS completedAt,
        session.anchor_distance_km AS distanceKm,
        ${activeDurationSecondsSql("session")} AS durationSeconds,
        override.session_type AS sessionType,
        ${performanceProtocolExpression(database)} AS performanceProtocol,
        override.rpe,
        COALESCE(override.condition_tags_json, '[]') AS conditionTagsJson,
        ${historicalQualitySql()} AS qualityScore,
        feature.source_confidence AS sourceConfidence,
        feature.eligibility_status AS eligibilityStatus,
        workout.metadata_json AS metadataJson
      FROM training_sessions session
      JOIN workouts workout ON workout.id = session.canonical_workout_id
      JOIN workout_features feature
        ON feature.training_session_id = session.id
      JOIN model_runs model ON model.feature_run_id = feature.feature_run_id
      JOIN active_model_run active ON active.model_run_id = model.id
      ${historicalOverrideJoin("LEFT JOIN")}
      WHERE session.status = 'active'
        AND session.anchor_distance_km BETWEEN 3 AND 30
        AND session.anchor_start_at >= ?
        AND session.anchor_end_at <= ?
        AND (${historicalEligibilitySql()}) <> 'excluded'
      ORDER BY session.anchor_start_at
    `)
    // historicalOverrideJoin contributes the first placeholder, followed by
    // the explicit training window and its as-of upper bound. node:sqlite
    // silently treats a missing binding as NULL, so keep all three bindings
    // adjacent to this query.
    .all(
      asOf,
      new Date(Date.parse(asOf) - PERFORMANCE_ENVELOPE_WINDOW_DAYS * 86_400_000).toISOString(),
      asOf
    ) as unknown as PerformanceEnvelopeRow[];
  return rows.flatMap((row) => {
    // A labeled performance is already represented above. Do not turn the
    // same event into an additional training-envelope observation.
    if (evidenceLabel(row) !== null) return [];
    if (
      row.durationSeconds < 12 * 60 ||
      row.durationSeconds > 4 * 60 * 60 ||
      row.distanceKm <= 0
    ) {
      return [];
    }
    const paceMinutesPerKm = row.durationSeconds / 60 / row.distanceKm;
    if (paceMinutesPerKm < 2.5 || paceMinutesPerKm > 15) return [];
    const label = evidenceLabel(row);
    const source: PerformanceVdotEvidence["source"] =
      label?.source === "race" ||
      label?.source === "standard_test" ||
      label?.source === "time_trial"
        ? label.source
        : "training_envelope";
    const quality = source === "training_envelope"
      ? clamp(row.qualityScore * row.sourceConfidence * 0.6, 0.1, 0.6)
      : label?.quality ?? 0.8;
    return [performanceVdotEvidence({
      id: row.id,
      observedAt: row.completedAt,
      distanceMeters: row.distanceKm * 1_000,
      durationSeconds: row.durationSeconds,
      source,
      quality,
      conditions: parsePerformanceConditions(row.metadataJson)
    })];
  }).concat(labeled);
}

function metadataQuantity(metadataJson: string, key: string): {
  value: number;
  unit: string;
} | null {
  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    const raw = metadata[key];
    const first = Array.isArray(raw) ? raw.find((value) => typeof value === "string") : raw;
    if (typeof first !== "string") return null;
    const match = first.trim().match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
    if (!match?.[1]) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? { value, unit: match[2] ?? "" } : null;
  } catch {
    return null;
  }
}

export function parsePerformanceConditions(metadataJson: string): {
  temperatureC: number | null;
  humidityPercent: number | null;
  elevationGainMeters: number | null;
} {
  const temperature = metadataQuantity(metadataJson, "HKWeatherTemperature");
  const humidity = metadataQuantity(metadataJson, "HKWeatherHumidity");
  const elevation = metadataQuantity(metadataJson, "HKElevationAscended");
  const temperatureC = temperature === null
    ? null
    : temperature.unit.toLowerCase().includes("degf")
      ? (temperature.value - 32) * 5 / 9
      : temperature.value;
  const humidityPercent = humidity === null
    ? null
    : humidity.value > 100
      ? humidity.value / 100
      : humidity.value;
  const elevationGainMeters = elevation === null
    ? null
    : elevation.unit.toLowerCase() === "cm"
      ? elevation.value / 100
      : elevation.value;
  return { temperatureC, humidityPercent, elevationGainMeters };
}

function restingHeartRate(database: DatabaseSync, asOf: string): number | null {
  const cutoff = new Date(Date.parse(asOf) - 28 * 86_400_000).toISOString();
  const rows = database
    .prepare(`
      SELECT value_numeric AS value
      FROM health_records
      WHERE type = ?
        AND value_numeric IS NOT NULL
        AND start_at >= ?
        AND start_at < ?
    `)
    .all(healthTypes.restingHeartRate, cutoff, asOf) as unknown as Array<{ value: number }>;
  return median(rows.map((row) => row.value));
}

function observedMaximumHeartRate(
  database: DatabaseSync,
  asOf: string
): number | null {
  const cutoff = new Date(Date.parse(asOf) - 180 * 86_400_000).toISOString();
  const row = database
    .prepare(`
      SELECT MAX(value_numeric) AS value
      FROM health_records
      WHERE type = ?
        AND value_numeric IS NOT NULL
        AND start_at >= ?
        AND start_at < ?
    `)
    .get(healthTypes.heartRate, cutoff, asOf) as unknown as { value: number | null } | undefined;
  return typeof row?.value === "number" && Number.isFinite(row.value) ? row.value : null;
}

export function loadPhysiologyProfile(
  database: DatabaseSync,
  asOf: string
): PhysiologyProfile {
  return {
    restingHeartRateBpm: restingHeartRate(database, asOf),
    observedMaximumHeartRateBpm: observedMaximumHeartRate(database, asOf)
  };
}

interface ReadinessTarget {
  weeklyDistanceKm: number;
  longestRunKm: number;
  runsPerWeek: number;
  exposureDistanceKm: number;
  exposureCount: number;
  weights: {
    volume: number;
    longRun: number;
    frequency: number;
    exposure: number;
    recency: number;
  };
}

const readinessTargets: Record<RaceDistance, ReadinessTarget> = {
  five_k: {
    weeklyDistanceKm: 15,
    longestRunKm: 8,
    runsPerWeek: 2.5,
    exposureDistanceKm: 3,
    exposureCount: 2,
    weights: { volume: 0.25, longRun: 0.2, frequency: 0.25, exposure: 0.15, recency: 0.15 }
  },
  ten_k: {
    weeklyDistanceKm: 25,
    longestRunKm: 12,
    runsPerWeek: 3,
    exposureDistanceKm: 6,
    exposureCount: 2,
    weights: { volume: 0.3, longRun: 0.25, frequency: 0.2, exposure: 0.1, recency: 0.15 }
  },
  half_marathon: {
    weeklyDistanceKm: 35,
    longestRunKm: 18,
    runsPerWeek: 3.5,
    exposureDistanceKm: 12,
    exposureCount: 2,
    weights: { volume: 0.35, longRun: 0.35, frequency: 0.15, exposure: 0.05, recency: 0.1 }
  }
};

export function loadRaceReadiness(
  database: DatabaseSync,
  asOf: string
): PredictionReadiness {
  return loadRaceReadinessEvidence(database, asOf).values;
}

export function loadRaceReadinessEvidence(
  database: DatabaseSync,
  asOf: string
): RaceReadinessEvidence {
  const cutoff = new Date(Date.parse(asOf) - 56 * 86_400_000).toISOString();
  const rows = database
    .prepare(`
      SELECT
        session.anchor_start_at AS observedAt,
        session.anchor_distance_km AS distanceKm,
        ${activeDurationSecondsSql("session")} AS durationSeconds
      FROM training_sessions session
      JOIN workout_features feature
        ON feature.training_session_id = session.id
      JOIN model_runs model ON model.feature_run_id = feature.feature_run_id
      JOIN active_model_run active ON active.model_run_id = model.id
      ${historicalOverrideJoin("LEFT JOIN")}
      WHERE session.status = 'active'
        AND session.anchor_distance_km IS NOT NULL
        AND session.anchor_distance_km > 0
        AND session.anchor_start_at >= ?
        AND session.anchor_end_at <= ?
        AND (${historicalEligibilitySql()}) <> 'excluded'
      ORDER BY session.anchor_start_at
    `)
    .all(asOf, cutoff, asOf) as unknown as Array<{
      observedAt: string;
      distanceKm: number;
      durationSeconds: number;
    }>;
  const usable = rows.filter((row) => {
    if (row.durationSeconds < 5 * 60 || row.durationSeconds > 4 * 60 * 60) return false;
    const pace = row.durationSeconds / 60 / row.distanceKm;
    return pace >= 2.5 && pace <= 15;
  });
  if (usable.length === 0) {
    return {
      values: {},
      status: "insufficient_data",
      evidenceCount: 0,
      dataThroughAt: null
    };
  }
  const weeklyDistanceKm = usable.reduce((sum, row) => sum + row.distanceKm, 0) / 8;
  const runsPerWeek = usable.length / 8;
  const longestRunKm = Math.max(...usable.map((row) => row.distanceKm));
  const latestAt = usable.at(-1)?.observedAt ?? cutoff;
  const daysSinceRun = Math.max(0, daysBetween(latestAt, asOf));
  const recencyScore = Math.exp(-Math.max(0, daysSinceRun - 3) / 14);
  const values = Object.fromEntries(
    (Object.keys(readinessTargets) as RaceDistance[]).map((distance) => {
      const target = readinessTargets[distance];
      const volume = clamp(weeklyDistanceKm / target.weeklyDistanceKm, 0, 1);
      const longRun = clamp(longestRunKm / target.longestRunKm, 0, 1);
      const frequency = clamp(runsPerWeek / target.runsPerWeek, 0, 1);
      const exposures = usable.filter(
        (row) => row.distanceKm >= target.exposureDistanceKm
      ).length;
      const exposure = clamp(exposures / target.exposureCount, 0, 1);
      const score =
        target.weights.volume * volume +
        target.weights.longRun * longRun +
        target.weights.frequency * frequency +
        target.weights.exposure * exposure +
        target.weights.recency * recencyScore;
      return [distance, clamp(score, 0, 1)];
    })
  ) as PredictionReadiness;
  return {
    values,
    status: "available",
    evidenceCount: usable.length,
    dataThroughAt: latestAt
  };
}

export function loadRecoveryReadiness(
  database: DatabaseSync,
  asOf: string,
  timezoneIdentifier: string = DATABASE_TIMEZONE
): number | null {
  return loadRecoveryReadinessEvidence(database, asOf, timezoneIdentifier).value;
}

export function loadRecoveryReadinessEvidence(
  database: DatabaseSync,
  asOf: string,
  timezoneIdentifier: string = DATABASE_TIMEZONE
): RecoveryReadinessEvidence {
  const readings = new SqlitePredictionRecoveryReadRepository(database)
    .load(asOf, timezoneIdentifier);
  const scores: number[] = [];
  if (readings.latestSleepMinutes !== null && readings.baselineSleepMinutes !== null && readings.baselineSleepMinutes > 0) {
    scores.push(clamp(readings.latestSleepMinutes / readings.baselineSleepMinutes, 0, 1));
  }
  if (readings.recentRestingHeartRate !== null && readings.baselineRestingHeartRate !== null) {
    scores.push(clamp(1 - Math.max(0, readings.recentRestingHeartRate - readings.baselineRestingHeartRate) / 12, 0, 1));
  }
  if (readings.recentHrv !== null && readings.baselineHrv !== null && readings.baselineHrv > 0) {
    scores.push(clamp(readings.recentHrv / readings.baselineHrv, 0, 1));
  }
  return {
    value: scores.length === 0 ? null : clamp(average(scores) ?? 0, 0, 1),
    provenance: readings.provenance
  };
}

function targetDistance(distanceMeters: number): RaceDistance | null {
  const candidates = (Object.keys(raceDistanceMeters) as RaceDistance[])
    .map((distance) => ({
      distance,
      relativeError: Math.abs(distanceMeters - raceDistanceMeters[distance]) /
        raceDistanceMeters[distance]
    }))
    .sort((left, right) => left.relativeError - right.relativeError);
  const closest = candidates[0];
  return closest && closest.relativeError <= 0.01 ? closest.distance : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function average(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function coefficientOfVariation(values: number[]): number | null {
  const mean = average(values);
  if (mean === null || mean === 0 || values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

function linearSlopePerHour(values: number[]): number {
  if (values.length < 2) return 0;
  const centerX = (values.length - 1) / 2;
  const centerY = average(values) ?? 0;
  let numerator = 0;
  let denominator = 0;
  for (const [index, value] of values.entries()) {
    numerator += (index - centerX) * (value - centerY);
    denominator += (index - centerX) ** 2;
  }
  return denominator === 0 ? 0 : (numerator / denominator) * 60;
}

function speedMetersPerSecond(value: number, unit: string | null): number {
  switch (unit?.toLowerCase()) {
    case "km/hr":
    case "km/h":
      return value / 3.6;
    case "mi/hr":
    case "mph":
      return value * 0.44704;
    default:
      return value;
  }
}

function minuteMedians(
  rows: SeriesRow[],
  workoutStartAt: string,
  converter: (value: number, unit: string | null) => number
): Map<number, number> {
  const start = Date.parse(workoutStartAt);
  const bins = new Map<number, number[]>();
  for (const row of rows) {
    const minute = Math.floor((Date.parse(row.observedAt) - start) / 60_000);
    if (!Number.isFinite(minute) || minute < 0) continue;
    const values = bins.get(minute) ?? [];
    values.push(converter(row.value, row.unit));
    bins.set(minute, values);
  }
  return new Map(
    [...bins].flatMap(([minute, values]) => {
      const value = median(values);
      return value === null ? [] : [[minute, value] as const];
    })
  );
}

function recordSeries(
  database: DatabaseSync,
  session: ThresholdSessionRow,
  type: string
): SeriesRow[] {
  return database
    .prepare(`
      SELECT value_numeric AS value, unit, start_at AS observedAt
      FROM health_records
      WHERE source_name = ?
        AND type = ?
        AND value_numeric IS NOT NULL
        AND start_at >= ?
        AND start_at <= ?
      ORDER BY start_at
    `)
    .all(
      session.sourceName,
      type,
      session.observedAt,
      session.completedAt
    ) as unknown as SeriesRow[];
}

function thresholdEvidenceSource(session: ThresholdSessionRow): {
  source: LactateThresholdEvidence["source"];
  labelBoost: number;
} {
  const tags = conditionTags(session.conditionTagsJson ?? "[]");
  if (
    session.performanceProtocol === "half_marathon_race" ||
    session.performanceProtocol === "other_race"
  ) {
    return { source: "race_segment", labelBoost: 1 };
  }
  if (session.performanceProtocol !== null) {
    return { source: "threshold_test", labelBoost: 1 };
  }
  if (session.sessionType === "race" || tags.includes("race")) {
    return { source: "race_segment", labelBoost: 1 };
  }
  if (tags.includes("standard_test") || tags.includes("time_trial")) {
    return { source: "threshold_test", labelBoost: 1 };
  }
  return { source: "sustained_segment", labelBoost: 0.72 };
}

export function loadLactateThresholdEvidence(
  database: DatabaseSync,
  asOf: string
): LactateThresholdEvidence[] {
  const cutoff = new Date(Date.parse(asOf) - 365 * 86_400_000).toISOString();
  const sessions = database
    .prepare(`
      SELECT
        session.id,
        session.anchor_start_at AS observedAt,
        session.anchor_end_at AS completedAt,
        workout.source_name AS sourceName,
        feature.source_confidence AS sourceConfidence,
        override.session_type AS sessionType,
        ${performanceProtocolExpression(database)} AS performanceProtocol,
        override.condition_tags_json AS conditionTagsJson
      FROM training_sessions session
      JOIN workouts workout ON workout.id = session.canonical_workout_id
      JOIN workout_features feature
        ON feature.training_session_id = session.id
      JOIN model_runs model ON model.feature_run_id = feature.feature_run_id
      JOIN active_model_run active ON active.model_run_id = model.id
      ${historicalOverrideJoin("LEFT JOIN")}
      WHERE session.status = 'active'
        AND session.anchor_start_at >= ?
        AND session.anchor_end_at <= ?
        AND (${historicalEligibilitySql()}) <> 'excluded'
        AND feature.heart_rate_coverage >= 0.75
        AND (julianday(session.anchor_end_at) - julianday(session.anchor_start_at)) * 1440.0 >= 20
      ORDER BY session.anchor_start_at
    `)
    .all(asOf, cutoff, asOf) as unknown as ThresholdSessionRow[];
  const evidence: LactateThresholdEvidence[] = [];
  for (const session of sessions) {
    const speedBins = minuteMedians(
      recordSeries(database, session, healthTypes.runningSpeed),
      session.observedAt,
      speedMetersPerSecond
    );
    const heartBins = minuteMedians(
      recordSeries(database, session, healthTypes.heartRate),
      session.observedAt,
      (value) => value
    );
    const durationMinutes = Math.floor(
      (Date.parse(session.completedAt) - Date.parse(session.observedAt)) / 60_000
    );
    const profile = loadPhysiologyProfile(database, session.observedAt);
    const resting = profile.restingHeartRateBpm;
    const maximum = profile.observedMaximumHeartRateBpm;
    if (resting === null || maximum === null || maximum <= resting) continue;
    const label = thresholdEvidenceSource(session);
    const firstWindow = label.source === "sustained_segment" ? 5 : 0;
    let best: LactateThresholdEvidence | null = null;
    let bestScore = -Infinity;
    for (let startMinute = firstWindow; startMinute + 20 <= durationMinutes; startMinute += 1) {
      const speeds: number[] = [];
      const heartRates: number[] = [];
      for (let minute = startMinute; minute < startMinute + 20; minute += 1) {
        const speed = speedBins.get(minute);
        const heartRate = heartBins.get(minute);
        if (speed !== undefined && heartRate !== undefined) {
          speeds.push(speed);
          heartRates.push(heartRate);
        }
      }
      const coverage = speeds.length / 20;
      if (coverage < 0.85) continue;
      const meanSpeed = average(speeds);
      const meanHeartRate = average(heartRates);
      const speedCv = coefficientOfVariation(speeds);
      if (meanSpeed === null || meanHeartRate === null || speedCv === null || meanSpeed <= 0) continue;
      const heartRateReserve = (meanHeartRate - resting) / (maximum - resting);
      const maximumCv = label.source === "sustained_segment" ? 0.1 : 0.13;
      const minimumReserve = label.source === "sustained_segment" ? 0.78 : 0.72;
      if (
        speedCv > maximumCv ||
        heartRateReserve < minimumReserve ||
        heartRateReserve > 0.97
      ) {
        continue;
      }
      const drift = Math.abs(linearSlopePerHour(heartRates));
      const stabilityQuality = clamp(1 - speedCv / maximumCv, 0, 1);
      const intensityQuality = clamp(1 - Math.abs(heartRateReserve - 0.86) / 0.16, 0, 1);
      const driftQuality = clamp(1 - Math.max(0, drift - 5) / 30, 0, 1);
      const quality = clamp(
        Math.pow(
          coverage *
            Math.max(stabilityQuality, 0.15) *
            Math.max(intensityQuality, 0.15) *
            Math.max(driftQuality, 0.15),
          0.25
        ) * session.sourceConfidence * label.labelBoost,
        0,
        1
      );
      if (quality < 0.35) continue;
      const score = quality * (0.7 + 0.3 * clamp(heartRateReserve, 0, 1));
      if (score <= bestScore) continue;
      bestScore = score;
      best = {
        id: `${session.id}:threshold:${startMinute}`,
        observedAt: new Date(Date.parse(session.observedAt) + startMinute * 60_000).toISOString(),
        paceSecondsPerKm: 1_000 / meanSpeed,
        heartRateBpm: meanHeartRate,
        durationSeconds: speeds.length * 60,
        source: label.source,
        quality
      };
    }
    if (best !== null) evidence.push(best);
  }
  return evidence;
}

export function loadLabeledRaceOutcomes(
  database: DatabaseSync,
  asOf: string
): LabeledRaceOutcome[] {
  return performanceRows(database, asOf).flatMap((row) => {
    if (row.performanceProtocol === "thirty_min_threshold") return [];
    const label = evidenceLabel(row);
    if (label === null || label.source === "hard_workout") return [];
    const distance = targetDistance(row.distanceKm * 1_000);
    if (distance === null) return [];
    const paceMinutesPerKm = row.durationSeconds / 60 / row.distanceKm;
    if (
      row.durationSeconds < 12 * 60 ||
      row.durationSeconds > 4 * 60 * 60 ||
      paceMinutesPerKm < 2.5 ||
      paceMinutesPerKm > 15
    ) return [];
    return [{
      id: row.id,
      distance,
      observedAt: row.observedAt,
      completedAt: row.completedAt,
      labelAvailableAt:
        Date.parse(row.overrideCreatedAt) > Date.parse(row.completedAt)
          ? row.overrideCreatedAt
          : row.completedAt,
      actualDistanceMeters: row.distanceKm * 1_000,
      actualSeconds: row.durationSeconds,
      labelSource: label.source
    }];
  });
}
