import type { DatabaseSync } from "node:sqlite";
import {
  PERFORMANCE_ENTRY_DISTANCE_METERS,
  loadPerformanceEventSessions,
  SqlitePerformanceEntryRepository,
  type PerformanceEntryDistance
} from "@rai/storage-sqlite";
import { legacyRecoveryBackground } from "@rai/readiness";
import { buildRaceResidualTrainingDataset } from "./prediction-training-data.js";

import { DATABASE_TIMEZONE, ISO_UTC_OFFSET, SQL_UTC_OFFSET_MODIFIER, healthTypes, raceDistanceMeters, type RaceDistance } from "@rai/contracts";
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
import { assessPreparation } from "@rai/durability";
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
  eligibilityOverride?: string | null;
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
  trainingSessionIds?: readonly string[];
}

/** Holding out a label must also hold out every representation of its event. */
export function expandPerformanceEventExclusions(
  database: DatabaseSync, ids: ReadonlySet<string>, asOf: string
): ReadonlySet<string> {
  if (!ids.size) return ids;
  const expanded = new Set(ids);
  const repository = new SqlitePerformanceEntryRepository(database);
  const available = new Set(repository.availableAt(asOf).map(entry => entry.id));
  // Explicit targets retain their identity even before confirmation; other
  // labels may link events only while they were available at the cutoff.
  const events = repository.list().filter(entry => ids.has(entry.id) || available.has(entry.id))
    .map(entry => ({ id: entry.id, sessions: loadPerformanceEventSessions(database, entry, asOf) }));
  let changed = true;
  while (changed) {
    const previousSize = expanded.size;
    for (const event of events) {
      if (expanded.has(event.id) || event.sessions.some(session => expanded.has(session.id))) {
        expanded.add(event.id);
        for (const session of event.sessions) expanded.add(session.id);
      }
    }
    changed = expanded.size !== previousSize;
  }
  return expanded;
}

function excludedHealthEventSql(excluded: ReadonlySet<string>): string {
  return excluded.size ? `AND NOT EXISTS (
    SELECT 1 FROM training_sessions held_out
    WHERE held_out.id IN (SELECT value FROM json_each(?))
      AND julianday(health_records.start_at) <= julianday(held_out.anchor_end_at)
      AND julianday(health_records.end_at) >= julianday(held_out.anchor_start_at)
  )` : "";
}

function excludedHealthBindings(excluded: ReadonlySet<string>): string[] {
  return excluded.size ? [JSON.stringify([...excluded])] : [];
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

// 本文件原先的 `daysBetween` 已随 §8.1 迁移删除。它的语义是**未取整的毫秒差**
// （`(Date.parse(later) - Date.parse(earlier)) / 86_400_000`），与 `@rai/contracts` 里那个
// 按日实现**不同** —— 后者会把完整时间戳拼成 `...T00:00:00Z` 而解析成 NaN。
// 等价实现现在只有一处：`@rai/durability` 的 `fractionalDaysBetween`。

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
        , override.eligibility_override AS eligibilityOverride
      FROM training_sessions session
      ${historicalOverrideJoin("JOIN")}
      WHERE session.status = 'active'
        AND session.anchor_distance_km IS NOT NULL
        AND session.anchor_distance_km > 0
        AND julianday(session.anchor_end_at) <= julianday(?)
      ORDER BY session.anchor_start_at
    `)
    .all(asOf, asOf) as unknown as PerformanceRow[];
}

export function loadDirectVo2Evidence(
  database: DatabaseSync,
  asOf: string,
  excluded: ReadonlySet<string> = new Set()
): Vo2MaxEvidence[] {
  const rows = database
    .prepare(`
      SELECT
        id,
        end_at AS observedAt,
        value_numeric AS value,
        source_category AS sourceCategory
      FROM health_records
      WHERE type = ?
        AND value_numeric IS NOT NULL
        AND julianday(start_at) < julianday(?)
        AND julianday(end_at) <= julianday(?)
        ${excludedHealthEventSql(excluded)}
      ORDER BY start_at
    `)
    .all(healthTypes.vo2Max, asOf, asOf, ...excludedHealthBindings(excluded)) as unknown as HealthRecordRow[];
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
  asOf: string,
  excluded: ReadonlySet<string> = new Set()
): Vo2MaxEvidence[] {
  return performanceRows(database, asOf).flatMap((row) => {
    if (row.eligibilityOverride === "exclude" || excluded.has(row.id)) return [];
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
  asOf: string,
  /**
   * Labels to leave out (docs/ALGORITHM.md §12.11).
   *
   * The personal-calibration pass needs the prediction that would have been made
   * *without* the label it is about to score; exclusion is a parameter of the real
   * loader rather than a second implementation of the evidence chain.
   */
  excludeLabelIds: ReadonlySet<string> = new Set()
): PerformanceVdotEvidence[] {
  excludeLabelIds = expandPerformanceEventExclusions(database, excludeLabelIds, asOf);
  const manualOutcomes = loadManualPerformanceOutcomes(database, asOf);
  const manualSessions = new Set(manualOutcomes.flatMap(outcome => outcome.trainingSessionIds ?? []));
  const labeled = performanceRows(database, asOf).flatMap((row) => {
    if (excludeLabelIds.has(row.id) || manualSessions.has(row.id) || row.eligibilityOverride === "exclude") return [];
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
  const manual = manualOutcomes.flatMap((outcome) => {
    if (excludeLabelIds.has(outcome.id)) return [];
    // §12.10: an entered race informs the prediction it will later be calibrated
    // against. The recompute-stored VO2 ensemble is a separate path and is
    // deliberately untouched here (it changes stored snapshots and needs its own gate).
    return [performanceVdotEvidence({
      id: outcome.id,
      observedAt: outcome.completedAt,
      distanceMeters: outcome.actualDistanceMeters,
      durationSeconds: outcome.actualSeconds,
      source: "race",
      quality: 1
    })];
  });
  const envelope = rows.flatMap((row) => {
    if (excludeLabelIds.has(row.id) || manualSessions.has(row.id)) return [];
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
  // Manual entries last: ordering is stable and the session-derived evidence keeps
  // exactly the order it had before this path existed.
  return [...envelope, ...manual];
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

function restingHeartRate(database: DatabaseSync, asOf: string, excluded: ReadonlySet<string>): number | null {
  const cutoff = new Date(Date.parse(asOf) - 28 * 86_400_000).toISOString();
  const rows = database
    .prepare(`
      SELECT value_numeric AS value
      FROM health_records
      WHERE type = ?
        AND value_numeric IS NOT NULL
        AND julianday(start_at) >= julianday(?)
        AND julianday(start_at) < julianday(?)
        AND julianday(end_at) <= julianday(?)
        ${excludedHealthEventSql(excluded)}
    `)
    .all(healthTypes.restingHeartRate, cutoff, asOf, asOf, ...excludedHealthBindings(excluded)) as unknown as Array<{ value: number }>;
  return median(rows.map((row) => row.value));
}

function observedMaximumHeartRate(
  database: DatabaseSync,
  asOf: string,
  excluded: ReadonlySet<string>
): number | null {
  const cutoff = new Date(Date.parse(asOf) - 180 * 86_400_000).toISOString();
  const row = database
    .prepare(`
      SELECT MAX(value_numeric) AS value
      FROM health_records
      WHERE type = ?
        AND value_numeric IS NOT NULL
        AND julianday(start_at) >= julianday(?)
        AND julianday(start_at) < julianday(?)
        AND julianday(end_at) <= julianday(?)
        ${excludedHealthEventSql(excluded)}
    `)
    .get(healthTypes.heartRate, cutoff, asOf, asOf, ...excludedHealthBindings(excluded)) as unknown as { value: number | null } | undefined;
  return typeof row?.value === "number" && Number.isFinite(row.value) ? row.value : null;
}

export function loadPhysiologyProfile(
  database: DatabaseSync,
  asOf: string,
  excluded: ReadonlySet<string> = new Set()
): PhysiologyProfile {
  return {
    restingHeartRateBpm: restingHeartRate(database, asOf, excluded),
    observedMaximumHeartRateBpm: observedMaximumHeartRate(database, asOf, excluded)
  };
}

// §8.1：目标值只有一处定义（`@rai/durability` 的 `PREPARATION_TARGETS`）。
// 原先这里的 `readinessTargets` 副本已删除 —— 保留两份会让"改了一边"变成静默分叉。


export function loadRaceReadiness(
  database: DatabaseSync,
  asOf: string
): PredictionReadiness {
  return loadRaceReadinessEvidence(database, asOf).values;
}

export function loadRaceReadinessEvidence(
  database: DatabaseSync,
  asOf: string,
  excluded: ReadonlySet<string> = new Set()
): RaceReadinessEvidence {
  const cutoff = new Date(Date.parse(asOf) - 56 * 86_400_000).toISOString();
  const rows = database
    .prepare(`
      SELECT
        session.id,
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
      id: string;
      observedAt: string;
      distanceKm: number;
      durationSeconds: number;
    }>;
  const usable = rows.filter((row) => {
    if (excluded.has(row.id)) return false;
    if (row.durationSeconds < 5 * 60 || row.durationSeconds > 4 * 60 * 60) return false;
    const pace = row.durationSeconds / 60 / row.distanceKm;
    return pace >= 2.5 && pace <= 15;
  });
  // §8.1：算术收敛到 `@rai/durability` 一处（Preparation 语义），本函数只负责取数与映射。
  // `usable` 保持 SQL 的 `ORDER BY anchor_start_at` 顺序 —— `assessPreparation` 的"最早/最近"
  // 都依赖这个顺序，重新排序会改变 recency 与 historyCoverageDays。
  const assessment = assessPreparation(
    usable.map((row) => ({
      observedAt: row.observedAt,
      distanceKm: row.distanceKm,
      durationSeconds: row.durationSeconds
    })),
    asOf
  );
  if (assessment.status === "insufficient_data") {
    return {
      values: {},
      status: "insufficient_data",
      evidenceCount: 0,
      dataThroughAt: null
    };
  }
  return {
    values: assessment.values as PredictionReadiness,
    status: "available",
    evidenceCount: assessment.evidenceCount,
    dataThroughAt: assessment.latestTrainingAt
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
  return {
    value: legacyRecoveryBackground({
      sleepMinutes: readings.latestSleepMinutes, sleepBaselineMinutes: readings.baselineSleepMinutes,
      rhrBpm: readings.recentRestingHeartRate, rhrBaselineBpm: readings.baselineRestingHeartRate,
      hrvMs: readings.recentHrv, hrvBaselineMs: readings.baselineHrv
    }),
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
        AND julianday(start_at) >= julianday(?)
        AND julianday(start_at) <= julianday(?)
        AND julianday(end_at) <= julianday(?)
      ORDER BY start_at
    `)
    .all(
      session.sourceName,
      type,
      session.observedAt,
      session.completedAt,
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
  asOf: string,
  excluded: ReadonlySet<string> = new Set()
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
        AND julianday(session.anchor_start_at) >= julianday(?)
        AND julianday(session.anchor_end_at) <= julianday(?)
        AND (${historicalEligibilitySql()}) <> 'excluded'
        AND feature.heart_rate_coverage >= 0.75
        AND (julianday(session.anchor_end_at) - julianday(session.anchor_start_at)) * 1440.0 >= 20
      ORDER BY session.anchor_start_at
    `)
    .all(asOf, cutoff, asOf) as unknown as ThresholdSessionRow[];
  const evidence: LactateThresholdEvidence[] = [];
  for (const session of sessions) {
    if (excluded.has(session.id)) continue;
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
    const profile = loadPhysiologyProfile(database, session.observedAt, excluded);
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

/**
 * Manually entered race results as labels (docs/ALGORITHM.md §12.10).
 *
 * Two as-of rules, both required by T01/T03:
 *
 * - the entry must have been **recorded** by `asOf` (`labelAvailableAt`), so a 2023
 *   race typed in today cannot appear inside yesterday's prediction;
 * - the race itself must already have happened by `asOf`.
 *
 * A manual entry states the nominal distance, so the distance is exact by
 * construction and there is no "actual distance" to compare against a target. It
 * carries no GPS or heart-rate verification — that is the runner's own assertion,
 * and the ID keeps the `performance_entry_` prefix so a report can tell the two
 * provenance classes apart.
 */
export const MANUAL_ENTRY_ID_PREFIX = "performance_entry_";

export function loadManualPerformanceOutcomes(
  database: DatabaseSync,
  asOf: string
): LabeledRaceOutcome[] {
  const instant = new Date(asOf).toISOString();
  return new SqlitePerformanceEntryRepository(database).availableAt(instant).flatMap((entry) => {
    const recorded = Date.parse(entry.recordedAt);
    const dayStart = Date.parse(`${entry.localDate}T00:00:00${ISO_UTC_OFFSET}`);
    // Date-only results have no defensible race clock. Features stop at midnight;
    // a same-day recording is a conservative finish bound, not a race start.
    const observedAt = entry.observedAt ?? new Date(dayStart).toISOString();
    const dayEnd = dayStart + 86_400_000 - 1;
    const completedAt = entry.completedAt ?? new Date(recorded >= dayStart ? Math.min(dayEnd, recorded) : dayEnd).toISOString();
    if (Date.parse(completedAt) > Date.parse(instant)) return [];
    if (Date.parse(entry.recordedAt) > Date.parse(instant)) return [];
    const sessions = loadPerformanceEventSessions(database, entry, instant);
    if (entry.trainingSessionId && !sessions.some(session => session.id === entry.trainingSessionId && session.status === "active")) return [];
    if (sessions.some(session => session.eligibilityOverride === "exclude")) return [];
    return [{
      id: entry.id,
      distance: entry.distance as PerformanceEntryDistance,
      observedAt,
      completedAt,
      labelAvailableAt: new Date(Math.max(recorded, Date.parse(completedAt))).toISOString(),
      actualDistanceMeters: PERFORMANCE_ENTRY_DISTANCE_METERS[entry.distance],
      actualSeconds: entry.durationSeconds,
      labelSource: "race",
      trainingSessionIds: sessions.map(session => session.id)
    }];
  });
}

export function loadLabeledRaceOutcomes(
  database: DatabaseSync,
  asOf: string
): LabeledRaceOutcome[] {
  const fromSessions = performanceRows(database, asOf).flatMap((row) => {
    if (row.eligibilityOverride === "exclude") return [];
    if (row.performanceProtocol === "thirty_min_threshold") return [];
    const label = evidenceLabel(row);
    if (label === null || label.source === "hard_workout") return [];
    const distance = targetDistance(row.distanceKm * 1_000);
    if (distance === null) return [];
    const protocolDistance = protocolTargetDistance(row.performanceProtocol);
    if (protocolDistance !== null && distance !== protocolDistance) return [];
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
      labelSource: label.source,
      trainingSessionIds: [row.id]
    }];
  });
  const manual = loadManualPerformanceOutcomes(database, asOf);
  const represented = new Set(manual.flatMap(outcome => outcome.trainingSessionIds ?? []));
  return [...fromSessions.filter(outcome => !represented.has(outcome.id)), ...manual]
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id));
}

function protocolTargetDistance(protocol: string | null): RaceDistance | null {
  if (protocol === "five_k_time_trial") return "five_k";
  if (protocol === "ten_k_time_trial") return "ten_k";
  if (protocol === "half_marathon_race") return "half_marathon";
  return null;
}

export interface LabelFunnelReport {
  version: "race-label-funnel-v1";
  asOf: string;
  sessionCount: number;
  confirmedCount: number;
  /** How many usable labels came from manual entries rather than a recorded session. */
  manualEntryCount: number;
  usableOutcomeCount: number;
  /** Exact temporal dataset size, not the number of eligible result labels. */
  trainingSampleCount: number;
  trainingExcludedOutcomeCount: number;
  evaluatedOutcomeCount: number;
  rejectedCount: number;
  /** Mutually exclusive: sessions = (usable outcomes - manual entries) + rejected. */
  primaryRejections: Record<string, number>;
  byDistance: Record<RaceDistance, { usable: number; trainingSamples: number; evaluated: number }>;
  decisions: Array<{ trainingSessionId: string; revision: number | null; reason: string }>;
  accuracyStatus: "not_evaluable" | "requires_release_evaluation";
}

/**
 * Uses the exact outcome loader used for training and evaluation. This diagnostic
 * does not create labels, count superseded revisions, or reinterpret old labels
 * as if they were available before the user confirmed them.
 */
export function buildLabelFunnel(
  database: DatabaseSync,
  asOf: string,
  evaluatedByDistance: Partial<Record<RaceDistance, number>> = {}
): LabelFunnelReport {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error("asOf must be a valid instant");
  const instant = new Date(asOf).toISOString();
  const outcomes = loadLabeledRaceOutcomes(database, instant);
  const trainingSamples = buildRaceResidualTrainingDataset(database, instant).samples;
  const accepted = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const rows = database.prepare(`
    SELECT session.id, session.status, session.anchor_start_at AS observedAt,
      session.anchor_end_at AS completedAt, session.anchor_distance_km AS distanceKm,
      ${activeDurationSecondsSql("session")} AS durationSeconds,
      override.session_type AS sessionType,
      ${performanceProtocolExpression(database)} AS performanceProtocol,
      override.rpe, override.condition_tags_json AS conditionTagsJson,
      override.created_at AS overrideCreatedAt, override.revision,
      override.eligibility_override AS eligibilityOverride
    FROM training_sessions session
    ${historicalOverrideJoin("LEFT JOIN")}
    WHERE julianday(session.anchor_start_at) <= julianday(?)
    ORDER BY session.anchor_start_at, session.id
  `).all(instant, instant) as unknown as Array<PerformanceRow & {
    status: string; revision: number | null;
  }>;
  const primaryRejections: Record<string, number> = {};
  const byDistance: LabelFunnelReport["byDistance"] = {
    five_k: { usable: 0, trainingSamples: 0, evaluated: evaluatedByDistance.five_k ?? 0 },
    ten_k: { usable: 0, trainingSamples: 0, evaluated: evaluatedByDistance.ten_k ?? 0 },
    half_marathon: { usable: 0, trainingSamples: 0, evaluated: evaluatedByDistance.half_marathon ?? 0 }
  };
  let confirmedCount = 0;
  const decisions = rows.map((row) => {
    const label = evidenceLabel(row);
    const confirmed = row.performanceProtocol !== null ||
      (label !== null && label.source !== "hard_workout");
    if (confirmed) confirmedCount++;
    const outcome = accepted.get(row.id);
    let reason: string;
    if (outcome) {
      reason = "usable";
      byDistance[outcome.distance].usable++;
    } else if (row.status !== "active") reason = "inactive_session";
    else if (outcomes.some(item => item.trainingSessionIds?.includes(row.id))) reason = "superseded_by_manual_entry";
    else if (Date.parse(row.completedAt) > Date.parse(instant)) reason = "not_completed";
    else if (!confirmed) reason = "not_confirmed";
    else if (row.eligibilityOverride === "exclude") reason = "user_excluded";
    else if (row.performanceProtocol === "thirty_min_threshold") reason = "threshold_only_protocol";
    else if (!Number.isFinite(row.distanceKm) || row.distanceKm <= 0) reason = "distance_missing";
    else {
      const distance = targetDistance(row.distanceKm * 1_000);
      const protocolDistance = protocolTargetDistance(row.performanceProtocol);
      if (distance === null) reason = "unsupported_distance";
      else if (protocolDistance !== null && protocolDistance !== distance) reason = "protocol_distance_mismatch";
      else reason = "duration_or_pace_out_of_range";
    }
    if (reason !== "usable") primaryRejections[reason] = (primaryRejections[reason] ?? 0) + 1;
    return { trainingSessionId: row.id, revision: row.revision, reason };
  });
  // Manual entries have no session row, so the decision loop above cannot count
  // them. Without this, `byDistance` would disagree with `usableOutcomeCount` and
  // the funnel would stop being reconcilable — which is the one thing T03 asks of it.
  for (const outcome of outcomes) {
    if (!outcome.id.startsWith(MANUAL_ENTRY_ID_PREFIX)) continue;
    byDistance[outcome.distance].usable += 1;
  }
  for (const value of Object.values(byDistance)) {
    if (!Number.isInteger(value.evaluated) || value.evaluated < 0 || value.evaluated > value.usable) {
      throw new Error("Evaluated label counts must be non-negative integers no greater than usable labels");
    }
  }
  for (const sample of trainingSamples) byDistance[sample.distance].trainingSamples += 1;
  return {
    version: "race-label-funnel-v1",
    asOf: instant,
    sessionCount: rows.length,
    confirmedCount,
    manualEntryCount: outcomes.filter((outcome) => outcome.id.startsWith(MANUAL_ENTRY_ID_PREFIX)).length,
    usableOutcomeCount: outcomes.length,
    trainingSampleCount: trainingSamples.length,
    trainingExcludedOutcomeCount: outcomes.length - trainingSamples.length,
    evaluatedOutcomeCount: Object.values(byDistance).reduce((n, item) => n + item.evaluated, 0),
    rejectedCount: decisions.filter((item) => item.reason !== "usable").length,
    primaryRejections,
    byDistance,
    decisions,
    accuracyStatus: outcomes.length === 0 ? "not_evaluable" : "requires_release_evaluation"
  };
}
