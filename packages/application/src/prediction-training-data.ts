import type { DatabaseSync } from "node:sqlite";

import {
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH,
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
  predictionResidualFeatureNames,
  predictionResidualOnnxFeatureNames,
  type PhysiologyPredictionScenario,
  type RaceDistance,
  type WorkoutTrainingLoad
} from "@rai/contracts";
import {
  buildDailyTrainingMetrics,
  localDateInTimeZone
} from "@rai/training-load";

import {
  loadLabeledRaceOutcomes,
  parsePerformanceConditions
} from "./prediction-data.js";
import { buildFormulaPredictionBase, type FormulaPredictionBase } from "./prediction-report.js";

export const RACE_RESIDUAL_FEATURE_SCHEMA_VERSION =
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION;

export const raceResidualFeatureNames = predictionResidualFeatureNames;

export type RaceResidualFeatureName = (typeof raceResidualFeatureNames)[number];
export type RaceResidualFeatureValues = Record<RaceResidualFeatureName, number | null>;

export const raceResidualOnnxFeatureNames = predictionResidualOnnxFeatureNames;

export interface RaceResidualTrainingSample {
  schemaVersion: typeof RACE_RESIDUAL_FEATURE_SCHEMA_VERSION;
  sampleId: string;
  observedAt: string;
  completedAt: string;
  distance: RaceDistance;
  baselinePredictedSeconds: number;
  baselineOptimisticSeconds: number | null;
  baselinePessimisticSeconds: number | null;
  actualSeconds: number;
  features: RaceResidualFeatureValues;
}

export interface RaceResidualTrainingDataset {
  schemaVersion: typeof RACE_RESIDUAL_FEATURE_SCHEMA_VERSION;
  featureSchemaHash: string;
  asOf: string;
  samples: RaceResidualTrainingSample[];
}

interface TrainingContext {
  weeklyDistance4wKm: number;
  weeklyDistance8wKm: number;
  longestRun8wKm: number;
  runFrequency4wPerWeek: number;
  targetDistanceExposure8w: number;
  daysSinceLastRun: number;
  acuteChronicLoadRatio: number | null;
  overallDataQuality: number | null;
}

const exposureThresholdKm: Record<RaceDistance, number> = {
  five_k: 3,
  ten_k: 6,
  half_marathon: 12
};

const daysBetween = (earlier: string, later: string): number =>
  Math.max(0, (Date.parse(later) - Date.parse(earlier)) / 86_400_000);

const numeric = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function raceResidualFeatureSchemaHash(): string {
  return PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH;
}

function loadOutcomeMetadata(database: DatabaseSync, trainingSessionId: string): string {
  const row = database.prepare(`
    SELECT workout.metadata_json AS metadataJson
    FROM training_sessions session
    JOIN workouts workout ON workout.id = session.canonical_workout_id
    WHERE session.id = ?
  `).get(trainingSessionId) as unknown as { metadataJson: string } | undefined;
  return row?.metadataJson ?? "{}";
}

interface ActiveTrainingLoadRow {
  trainingSessionId: string;
  localDate: string;
  timezoneIdentifier: string;
  durationSeconds: number;
  trainingLoad: number;
  distanceKm: number | null;
  confidence: number;
}

export function loadAcuteChronicLoadRatio(
  database: DatabaseSync,
  asOf: string
): number | null {
  const rows = database.prepare(`
    SELECT
      load.training_session_id AS trainingSessionId,
      load.local_date AS localDate,
      load.timezone_identifier AS timezoneIdentifier,
      load.duration_seconds AS durationSeconds,
      load.training_load AS trainingLoad,
      load.distance_km AS distanceKm,
      load.confidence AS confidence
    FROM active_workout_training_loads load
    JOIN training_sessions session ON session.id = load.training_session_id
    WHERE session.status = 'active'
      AND session.anchor_end_at <= ?
    ORDER BY load.local_date, load.training_session_id
  `).all(asOf) as unknown as ActiveTrainingLoadRow[];
  if (rows.length === 0) return null;

  const timezoneIdentifier = rows.at(-1)?.timezoneIdentifier ?? "Asia/Shanghai";
  const throughDate = localDateInTimeZone(asOf, timezoneIdentifier);
  const loads = rows.map((row) => ({
    trainingSessionId: row.trainingSessionId,
    localDate: row.localDate,
    durationSeconds: row.durationSeconds,
    distanceMeters: row.distanceKm === null ? null : row.distanceKm * 1_000,
    load: row.trainingLoad,
    confidence: row.confidence
  })) as WorkoutTrainingLoad[];
  const metrics = buildDailyTrainingMetrics(loads, throughDate);
  return metrics.at(-1)?.loadRatio ?? null;
}

function loadTrainingContext(
  database: DatabaseSync,
  asOf: string,
  distance: RaceDistance
): TrainingContext {
  const start4w = new Date(Date.parse(asOf) - 28 * 86_400_000).toISOString();
  const start8w = new Date(Date.parse(asOf) - 56 * 86_400_000).toISOString();
  const row = database.prepare(`
    SELECT
      SUM(CASE WHEN session.anchor_start_at >= ? THEN session.anchor_distance_km ELSE 0 END) AS distance4w,
      SUM(session.anchor_distance_km) AS distance8w,
      MAX(session.anchor_distance_km) AS longest8w,
      SUM(CASE WHEN session.anchor_start_at >= ? THEN 1 ELSE 0 END) AS runs4w,
      SUM(CASE WHEN session.anchor_distance_km >= ? THEN 1 ELSE 0 END) AS exposure8w,
      MAX(session.anchor_start_at) AS latestAt,
      AVG(feature.quality_score) AS averageQuality
    FROM training_sessions session
    JOIN workout_features feature ON feature.training_session_id = session.id
    JOIN model_runs model ON model.feature_run_id = feature.feature_run_id
    JOIN active_model_run active ON active.model_run_id = model.id
    WHERE session.status = 'active'
      AND session.anchor_start_at >= ?
      AND session.anchor_end_at <= ?
      AND session.anchor_distance_km IS NOT NULL
      AND session.anchor_distance_km > 0
      AND feature.eligibility_status <> 'excluded'
  `).get(
    start4w,
    start4w,
    exposureThresholdKm[distance],
    start8w,
    asOf
  ) as unknown as {
    distance4w: number | null;
    distance8w: number | null;
    longest8w: number | null;
    runs4w: number | null;
    exposure8w: number | null;
    latestAt: string | null;
    averageQuality: number | null;
  };
  return {
    weeklyDistance4wKm: numeric(row.distance4w) / 4,
    weeklyDistance8wKm: numeric(row.distance8w) / 8,
    longestRun8wKm: numeric(row.longest8w),
    runFrequency4wPerWeek: numeric(row.runs4w) / 4,
    targetDistanceExposure8w: numeric(row.exposure8w),
    daysSinceLastRun: row.latestAt === null ? 56 : daysBetween(row.latestAt, asOf),
    acuteChronicLoadRatio: loadAcuteChronicLoadRatio(database, asOf),
    overallDataQuality: row.averageQuality
  };
}

export function buildRaceResidualFeatureValues(
  database: DatabaseSync,
  asOf: string,
  distance: RaceDistance,
  base: FormulaPredictionBase,
  scenario: PhysiologyPredictionScenario
): RaceResidualFeatureValues | null {
  const prediction = base.snapshot.races.find((race) => race.distance === distance);
  if (!prediction || prediction.status !== "available" || prediction.predictedSeconds === null) {
    return null;
  }
  const context = loadTrainingContext(database, asOf, distance);
  const conditionAdjustmentSeconds =
    (prediction.environmentAdjustmentSeconds ?? 0) +
    (prediction.elevationAdjustmentSeconds ?? 0) +
    (prediction.fatigueAdjustmentSeconds ?? 0);
  const performanceVdot = base.snapshot.performanceVdot.value;
  const vo2Max = base.snapshot.vo2Max.valueMlKgMin;
  return {
    logPredictedSeconds: Math.log(prediction.predictedSeconds),
    readiness: prediction.readiness,
    conditionAdjustmentFraction: conditionAdjustmentSeconds / prediction.predictedSeconds,
    performanceVdot,
    vo2Max,
    vo2Gap: performanceVdot === null || vo2Max === null ? null : vo2Max - performanceVdot,
    lactateThresholdPaceSecondsPerKm: base.snapshot.lactateThreshold.paceSecondsPerKm,
    lactateThresholdConfidence: base.snapshot.lactateThreshold.confidence,
    recoveryReadiness: base.recoveryReadiness,
    weeklyDistance4wKm: context.weeklyDistance4wKm,
    weeklyDistance8wKm: context.weeklyDistance8wKm,
    longestRun8wKm: context.longestRun8wKm,
    runFrequency4wPerWeek: context.runFrequency4wPerWeek,
    targetDistanceExposure8w: context.targetDistanceExposure8w,
    daysSinceLastRun: context.daysSinceLastRun,
    acuteChronicLoadRatio: context.acuteChronicLoadRatio,
    temperatureC: scenario.temperatureC,
    humidityPercent: scenario.humidityPercent,
    elevationGainMeters: scenario.elevationGainMeters[distance],
    directVo2EvidenceCount: base.directEvidenceCount,
    thresholdEvidenceCount: base.thresholdEvidenceCount,
    performanceVdotEvidenceCount: base.performanceVdotEvidenceCount,
    overallDataQuality: context.overallDataQuality
  };
}

export function buildRaceResidualTrainingDataset(
  database: DatabaseSync,
  asOfInput = new Date().toISOString()
): RaceResidualTrainingDataset {
  const asOf = new Date(Date.parse(asOfInput)).toISOString();
  const outcomes = loadLabeledRaceOutcomes(database, asOf);
  const samples: RaceResidualTrainingSample[] = [];
  for (const outcome of outcomes) {
    const conditions = parsePerformanceConditions(
      loadOutcomeMetadata(database, outcome.id)
    );
    const elevationGainMeters = conditions.elevationGainMeters === null
      ? undefined
      : { [outcome.distance]: conditions.elevationGainMeters };
    const base = buildFormulaPredictionBase(database, outcome.observedAt, {
      ...(conditions.temperatureC === null ? {} : { temperatureC: conditions.temperatureC }),
      ...(conditions.humidityPercent === null ? {} : { humidityPercent: conditions.humidityPercent }),
      ...(elevationGainMeters === undefined ? {} : { elevationGainMeters })
    });
    const prediction = base.snapshot.races.find((race) => race.distance === outcome.distance);
    if (!prediction || prediction.status !== "available" || prediction.predictedSeconds === null) {
      continue;
    }
    const scenario: PhysiologyPredictionScenario = {
      temperatureC: conditions.temperatureC,
      humidityPercent: conditions.humidityPercent,
      elevationGainMeters: {
        five_k: outcome.distance === "five_k" ? conditions.elevationGainMeters : null,
        ten_k: outcome.distance === "ten_k" ? conditions.elevationGainMeters : null,
        half_marathon: outcome.distance === "half_marathon" ? conditions.elevationGainMeters : null
      }
    };
    const features = buildRaceResidualFeatureValues(
      database,
      outcome.observedAt,
      outcome.distance,
      base,
      scenario
    );
    if (features === null) continue;
    samples.push({
      schemaVersion: RACE_RESIDUAL_FEATURE_SCHEMA_VERSION,
      sampleId: outcome.id,
      observedAt: outcome.observedAt,
      completedAt: outcome.completedAt,
      distance: outcome.distance,
      baselinePredictedSeconds: prediction.predictedSeconds,
      baselineOptimisticSeconds: prediction.optimisticSeconds,
      baselinePessimisticSeconds: prediction.pessimisticSeconds,
      actualSeconds: outcome.actualSeconds,
      features
    });
  }
  return {
    schemaVersion: RACE_RESIDUAL_FEATURE_SCHEMA_VERSION,
    featureSchemaHash: raceResidualFeatureSchemaHash(),
    asOf,
    samples
  };
}
