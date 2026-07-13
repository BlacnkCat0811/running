import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { PhysiologyPredictionScenario, RaceDistance } from "@rai/contracts";

import {
  loadLabeledRaceOutcomes,
  parsePerformanceConditions
} from "./prediction-data.js";
import { buildFormulaPredictionBase, type FormulaPredictionBase } from "./prediction-report.js";

export const RACE_RESIDUAL_FEATURE_SCHEMA_VERSION = "race-residual-feature-v2" as const;

export const raceResidualFeatureNames = [
  "logPredictedSeconds",
  "readiness",
  "conditionAdjustmentFraction",
  "performanceVdot",
  "vo2Max",
  "vo2Gap",
  "lactateThresholdPaceSecondsPerKm",
  "lactateThresholdConfidence",
  "recoveryReadiness",
  "weeklyDistance4wKm",
  "weeklyDistance8wKm",
  "longestRun8wKm",
  "runFrequency4wPerWeek",
  "targetDistanceExposure8w",
  "daysSinceLastRun",
  "acuteChronicLoadRatio",
  "temperatureC",
  "humidityPercent",
  "elevationGainMeters",
  "directVo2EvidenceCount",
  "thresholdEvidenceCount",
  "performanceVdotEvidenceCount",
  "overallDataQuality"
] as const;

export type RaceResidualFeatureName = (typeof raceResidualFeatureNames)[number];
export type RaceResidualFeatureValues = Record<RaceResidualFeatureName, number | null>;

export const raceResidualOnnxFeatureNames = [
  ...raceResidualFeatureNames,
  "isFiveK",
  "isTenK",
  "isHalfMarathon"
] as const;

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
  acuteChronicLoadRatio: number;
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
  const schemaDocument = {
    distanceEncoding: {
      five_k: "isFiveK",
      half_marathon: "isHalfMarathon",
      ten_k: "isTenK"
    },
    featureNames: raceResidualOnnxFeatureNames,
    featureSchemaVersion: RACE_RESIDUAL_FEATURE_SCHEMA_VERSION,
    inputDtype: "float32",
    inputShape: ["N", raceResidualOnnxFeatureNames.length],
    missingValue: "NaN",
    outputDtype: "float32",
    outputSemantics: "targetLogResidual=log(actualSeconds/baselinePredictedSeconds)",
    outputShape: ["N", 1]
  };
  return createHash("sha256")
    .update(JSON.stringify(schemaDocument))
    .digest("hex");
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

function loadTrainingContext(
  database: DatabaseSync,
  asOf: string,
  distance: RaceDistance
): TrainingContext {
  const start4w = new Date(Date.parse(asOf) - 28 * 86_400_000).toISOString();
  const start8w = new Date(Date.parse(asOf) - 56 * 86_400_000).toISOString();
  const start7d = new Date(Date.parse(asOf) - 7 * 86_400_000).toISOString();
  const start35d = new Date(Date.parse(asOf) - 35 * 86_400_000).toISOString();
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
  const load = database.prepare(`
    SELECT
      SUM(CASE WHEN anchor_start_at >= ? THEN
        (julianday(anchor_end_at) - julianday(anchor_start_at)) * 1440.0 ELSE 0 END) AS acuteMinutes,
      SUM((julianday(anchor_end_at) - julianday(anchor_start_at)) * 1440.0) / 5.0 AS chronicWeeklyMinutes
    FROM training_sessions
    WHERE status = 'active'
      AND anchor_start_at >= ?
      AND anchor_end_at <= ?
  `).get(start7d, start35d, asOf) as unknown as {
    acuteMinutes: number | null;
    chronicWeeklyMinutes: number | null;
  };
  const chronic = Math.max(numeric(load.chronicWeeklyMinutes), 30);
  return {
    weeklyDistance4wKm: numeric(row.distance4w) / 4,
    weeklyDistance8wKm: numeric(row.distance8w) / 8,
    longestRun8wKm: numeric(row.longest8w),
    runFrequency4wPerWeek: numeric(row.runs4w) / 4,
    targetDistanceExposure8w: numeric(row.exposure8w),
    daysSinceLastRun: row.latestAt === null ? 56 : daysBetween(row.latestAt, asOf),
    acuteChronicLoadRatio: numeric(load.acuteMinutes) / chronic,
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
