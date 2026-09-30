import { predictionPolicyKey, catBoostCalibrationKey } from "./prediction-policy.js";
import { SqliteCalibrationRepository } from "@rai/storage-sqlite";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  MODEL_EVAL_VERSION, fitEmpiricalIntervals, evaluateIntervalArtifact,
  compareResidualChallengers, predictionMetrics, type EvaluationCase
} from "@rai/model-eval";

import { DATABASE_TIMEZONE,
  CATBOOST_PREDICTION_MODEL_VERSION,
  PREDICTION_CORRECTION_CAP_FRACTION,
  PHYSIOLOGY_REPORT_VERSION,
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
  assertPhysiologyPredictionSnapshot,
  type PhysiologyGuidanceCode,
  type PhysiologyPredictionReport,
  type PhysiologyPredictionScenario,
  type PredictionEnhancementSelection,
  type PredictionExplainability,
  type PredictionModelEvaluationMetrics,
  type RaceDistance,
  type RaceTimePrediction,
  type RacePredictionError,
  type RacePredictionMetrics
} from "@rai/contracts";
import { OnnxCatBoostResidualModel } from "@rai/prediction-inference";
import {
  aggregateRacePredictionErrors,
  applyRaceResidualRidge,
  buildRaceMlFeatures,
  buildPhysiologyPredictionSnapshot,
  calibrateRacePrediction,
  defaultRacePredictionCalibrationConfig,
  evaluateRacePrediction,
  fitRaceResidualRidge,
  type PredictionReadiness,
  type RaceMlTrainingExample,
  type RacePredictionConditions,
  PHYSIOLOGY_MODEL_VERSION
} from "@rai/physiology";

import {
  loadDirectVo2Evidence,
  loadLactateThresholdEvidence,
  loadLabeledPerformanceEvidence,
  loadLabeledRaceOutcomes,
  loadPerformanceVdotEvidence,
  loadPhysiologyProfile,
  loadRaceReadinessEvidence,
  loadRecoveryReadinessEvidence,
  buildLabelFunnel,
  type LabelFunnelReport
} from "./prediction-data.js";
import { currentAbilityBaselineHash } from "./prediction-ability-baseline.js";

const distances: RaceDistance[] = ["five_k", "ten_k", "half_marathon"];

export interface PredictionReportOptions {
  mode?: "neutral_potential" | "current_prepared" | "race_day_scenario";
  targetDate?: string;
  asOf?: string;
  timezoneIdentifier?: string;
  temperatureC?: number;
  humidityPercent?: number;
  elevationGainMeters?: Partial<Record<RaceDistance, number>>;
  recoveryReadiness?: number | null;
}

export interface PredictionEvaluationReport {
  reportVersion: "rai-prediction-walk-forward-v2";
  asOf: string;
  status: "insufficient_labeled_outcomes" | "evaluated";
  labeledOutcomeCount: number;
  evaluatedOutcomeCount: number;
  calibrationAppliedCount: number;
  rawMetrics: RacePredictionMetrics;
  calibratedMetrics: RacePredictionMetrics;
  machineLearningCandidate: {
    status: "insufficient_walk_forward_samples" | "recommend_activation" | "keep_formula_baseline";
    trainedExampleCount: number;
    evaluatedOutcomeCount: number;
    meanAbsoluteErrorImprovement: number | null;
    regressesAnyDistanceByMoreThan5Percent: boolean;
    baselineMetrics: RacePredictionMetrics;
    candidateMetrics: RacePredictionMetrics;
  };
  byDistance: Record<RaceDistance, {
    raw: RacePredictionMetrics;
    calibrated: RacePredictionMetrics;
  }>;
  rawErrors: RacePredictionError[];
  calibratedErrors: RacePredictionError[];
  labelFunnel: LabelFunnelReport;
  modelEvaluation: ReturnType<typeof buildModelEvaluation>;
}

export interface FormulaPredictionBase {
  directEvidenceCount: number;
  labeledPerformanceCount: number;
  thresholdEvidenceCount: number;
  performanceVdotEvidenceCount: number;
  readiness: Record<RaceDistance, number | null>;
  readinessStatus: "available" | "insufficient_data";
  readinessEvidenceCount: number;
  readinessDataThroughAt: string | null;
  recoveryReadiness: number | null;
    recoveryProvenance: {
      hrvSource: "canonical" | "raw_compat" | "none";
      sleepSource: "canonical" | "none";
      source: "canonical" | "raw_compat" | "mixed" | "none";
      coverage: "full" | "partial" | "none";
    latestObservedAt: string | null;
  };
  profile: {
    restingHeartRateBpm: number | null;
    observedMaximumHeartRateBpm: number | null;
  };
  snapshot: ReturnType<typeof buildPhysiologyPredictionSnapshot>;
}

interface HistoricalEvaluation {
  baselineCases: EvaluationCase[];
  ridgeCases: EvaluationCase[];
  labeledOutcomeCount: number;
  rawErrors: RacePredictionError[];
  calibratedErrors: RacePredictionError[];
  mlBaselineErrors: RacePredictionError[];
  mlErrors: RacePredictionError[];
  mlExamples: RaceMlTrainingExample[];
  mlImprovement: number | null;
  mlRegressesDistance: boolean;
  recommendMlActivation: boolean;
}

interface AvailableHistoricalValue<T> {
  availableAt: string;
  value: T;
}

export function historicalValuesAvailableAt<T>(
  values: ReadonlyArray<AvailableHistoricalValue<T>>,
  predictionAt: string
): T[] {
  const cutoff = Date.parse(predictionAt);
  return values
    .filter((entry) => Date.parse(entry.availableAt) <= cutoff)
    .map((entry) => entry.value);
}

interface RuntimePredictionEvaluation {
  labeledOutcomeCount: number;
  rawErrors: RacePredictionError[];
}

function isoDate(value: string | undefined): string {
  const parsed = Date.parse(value ?? new Date().toISOString());
  if (!Number.isFinite(parsed)) throw new Error("asOf must be a valid date-time");
  return new Date(parsed).toISOString();
}

function assertRange(
  name: string,
  value: number | null | undefined,
  minimum: number,
  maximum: number
): void {
  if (value == null) return;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function resolvedReadiness(readiness: PredictionReadiness): Record<RaceDistance, number | null> {
  return {
    five_k: readiness.five_k ?? null,
    ten_k: readiness.ten_k ?? null,
    half_marathon: readiness.half_marathon ?? null
  };
}

function resolvedScenario(options: PredictionReportOptions): PhysiologyPredictionScenario {
  return {
    temperatureC: options.temperatureC ?? null,
    humidityPercent: options.humidityPercent ?? null,
    elevationGainMeters: {
      five_k: options.elevationGainMeters?.five_k ?? null,
      ten_k: options.elevationGainMeters?.ten_k ?? null,
      half_marathon: options.elevationGainMeters?.half_marathon ?? null
    }
  };
}

function predictionConditions(
  scenario: PhysiologyPredictionScenario,
  recoveryReadiness: number | null
): RacePredictionConditions {
  const conditions: RacePredictionConditions = { recoveryReadiness };
  if (scenario.temperatureC !== null) conditions.temperatureC = scenario.temperatureC;
  if (scenario.humidityPercent !== null) conditions.humidityPercent = scenario.humidityPercent;
  const elevation = Object.fromEntries(
    distances.flatMap((distance) => {
      const value = scenario.elevationGainMeters[distance];
      return value === null ? [] : [[distance, value] as const];
    })
  ) as Partial<Record<RaceDistance, number>>;
  if (Object.keys(elevation).length > 0) conditions.elevationGainMeters = elevation;
  return conditions;
}

function validateOptions(options: PredictionReportOptions): void {
  if (options.mode !== undefined &&
      !["neutral_potential", "current_prepared", "race_day_scenario"].includes(options.mode)) {
    throw new Error("Unsupported prediction mode");
  }
  if (options.mode === "race_day_scenario") {
    if (!options.targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(options.targetDate) ||
        !Number.isFinite(Date.parse(`${options.targetDate}T00:00:00Z`)) ||
        new Date(`${options.targetDate}T00:00:00Z`).toISOString().slice(0, 10) !== options.targetDate) {
      throw new Error("race_day_scenario requires a valid targetDate");
    }
  } else if (options.targetDate !== undefined) {
    throw new Error("targetDate is only valid for race_day_scenario");
  }
  assertRange("temperatureC", options.temperatureC, -40, 60);
  assertRange("humidityPercent", options.humidityPercent, 0, 100);
  assertRange("recoveryReadiness", options.recoveryReadiness, 0, 1);
  for (const distance of distances) {
    assertRange(
      `elevationGainMeters.${distance}`,
      options.elevationGainMeters?.[distance],
      0,
      10_000
    );
  }
}

function latestEvidenceAt(values: Array<{ observedAt: string }>): string | null {
  return values
    .map((item) => item.observedAt)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

export function buildFormulaPredictionBase(
  database: DatabaseSync,
  asOf: string,
  options: PredictionReportOptions
): FormulaPredictionBase {
  const directEvidence = loadDirectVo2Evidence(database, asOf);
  const labeledPerformance = loadLabeledPerformanceEvidence(database, asOf);
  const performanceVdotEvidence = loadPerformanceVdotEvidence(database, asOf);
  const thresholdEvidence = loadLactateThresholdEvidence(database, asOf);
  const readinessEvidence = loadRaceReadinessEvidence(database, asOf);
  const modelReadiness: PredictionReadiness = options.mode === "neutral_potential"
    ? { five_k: 1, ten_k: 1, half_marathon: 1 }
    : readinessEvidence.values;
  const readiness = resolvedReadiness(modelReadiness);
  const recoveryEvidence = options.recoveryReadiness === undefined
    ? loadRecoveryReadinessEvidence(database, asOf, options.timezoneIdentifier ?? DATABASE_TIMEZONE)
    : {
        value: options.recoveryReadiness,
        provenance: {
          hrvSource: "none" as const,
          sleepSource: "none" as const,
          source: "none" as const,
          coverage: "none" as const,
          latestObservedAt: null
        }
      };
  // V2 never silently applies today's recent background to a future race.
  // Only an explicit race-day scenario may provide a recovery assumption.
  const recoveryReadiness = options.mode === undefined ? recoveryEvidence.value
    : options.mode === "race_day_scenario" ? options.recoveryReadiness ?? null : null;
  const scenario = resolvedScenario(options.mode !== undefined && options.mode !== "race_day_scenario" ? {} : options);
  const profile = loadPhysiologyProfile(database, asOf);
  const snapshot = buildPhysiologyPredictionSnapshot({
    // Race/test performance is VDOT evidence, not a physiological VO2max
    // measurement. Keep the count for provenance, but never merge the same
    // event into the VO2max ensemble through a second derived path.
    evidence: directEvidence,
    performanceEvidence: performanceVdotEvidence,
    thresholdEvidence,
    readiness: modelReadiness,
    conditions: predictionConditions(scenario, recoveryReadiness),
    profile,
    generatedAt: asOf,
    dataThroughAt: latestEvidenceAt([
      ...directEvidence,
      ...performanceVdotEvidence,
      ...thresholdEvidence
    ])
  });
  return {
    directEvidenceCount: directEvidence.length,
    labeledPerformanceCount: labeledPerformance.length,
    thresholdEvidenceCount: thresholdEvidence.length,
    performanceVdotEvidenceCount: performanceVdotEvidence.length,
    readiness,
    readinessStatus: readinessEvidence.status,
    readinessEvidenceCount: readinessEvidence.evidenceCount,
    readinessDataThroughAt: readinessEvidence.dataThroughAt,
    recoveryReadiness,
    recoveryProvenance: recoveryEvidence.provenance,
    profile,
    snapshot
  };
}

function historicalEvaluation(database: DatabaseSync, asOf: string): HistoricalEvaluation {
  const outcomes = loadLabeledRaceOutcomes(database, asOf);
  const rawErrors: RacePredictionError[] = [];
  const calibratedErrors: RacePredictionError[] = [];
  const mlBaselineErrors: RacePredictionError[] = [];
  const mlErrors: RacePredictionError[] = [];
  const mlExamples: RaceMlTrainingExample[] = [];
  const historicalRawErrors: Array<AvailableHistoricalValue<RacePredictionError>> = [];
  const historicalMlExamples: Array<AvailableHistoricalValue<RaceMlTrainingExample>> = [];
  const baselineCases: EvaluationCase[] = [];
  const ridgeCases: EvaluationCase[] = [];

  for (const outcome of outcomes) {
    const base = buildFormulaPredictionBase(database, outcome.observedAt, {});
    const prediction = base.snapshot.races.find((item) => item.distance === outcome.distance);
    if (!prediction || prediction.status !== "available" || prediction.predictedSeconds === null) {
      continue;
    }
    const mlFeatures = buildRaceMlFeatures(
      prediction,
      base.snapshot.performanceVdot,
      base.snapshot.vo2Max
    );
    const availableRawErrors = historicalValuesAvailableAt(
      historicalRawErrors,
      outcome.observedAt
    );
    const availableMlExamples = historicalValuesAvailableAt(
      historicalMlExamples,
      outcome.observedAt
    );
    const priorMlModel = fitRaceResidualRidge(availableMlExamples);
    const observedCase: EvaluationCase = {
      eventId: outcome.id, distance: outcome.distance,
      predictedAt: outcome.observedAt, outcomeAt: outcome.completedAt,
      availableAt: outcome.labelAvailableAt, actualSeconds: outcome.actualSeconds,
      predictedSeconds: prediction.predictedSeconds
    };
    baselineCases.push(observedCase);
    if (priorMlModel !== null) {
      const mlPrediction = applyRaceResidualRidge(prediction, priorMlModel, mlFeatures);
      ridgeCases.push({ ...observedCase, predictedSeconds: mlPrediction.predictedSeconds! });
      mlBaselineErrors.push(evaluateRacePrediction(
        prediction,
        outcome.actualSeconds,
        outcome.completedAt,
        outcome.observedAt
      ));
      mlErrors.push(evaluateRacePrediction(
        mlPrediction,
        outcome.actualSeconds,
        outcome.completedAt,
        outcome.observedAt
      ));
    }
    const calibrated = calibrateRacePrediction(
      prediction,
      outcome.observedAt,
      availableRawErrors
    );
    const rawError = evaluateRacePrediction(
      prediction,
      outcome.actualSeconds,
      outcome.completedAt,
      outcome.observedAt
    );
    rawErrors.push(rawError);
    calibratedErrors.push(evaluateRacePrediction(
      calibrated,
      outcome.actualSeconds,
      outcome.completedAt,
      outcome.observedAt
    ));
    const mlExample = {
      features: mlFeatures,
      predictedSeconds: prediction.predictedSeconds,
      actualSeconds: outcome.actualSeconds
    };
    mlExamples.push(mlExample);
    historicalRawErrors.push({ availableAt: outcome.labelAvailableAt, value: rawError });
    historicalMlExamples.push({ availableAt: outcome.labelAvailableAt, value: mlExample });
  }

  const mlBaselineMetrics = aggregateRacePredictionErrors(mlBaselineErrors);
  const mlMetrics = aggregateRacePredictionErrors(mlErrors);
  const mlImprovement =
    mlBaselineMetrics.meanAbsoluteErrorSeconds === null ||
    mlMetrics.meanAbsoluteErrorSeconds === null ||
    mlBaselineMetrics.meanAbsoluteErrorSeconds === 0
      ? null
      : 1 - mlMetrics.meanAbsoluteErrorSeconds /
        mlBaselineMetrics.meanAbsoluteErrorSeconds;
  const mlRegressesDistance = distances.some((distance) => {
    const baseline = aggregateRacePredictionErrors(
      mlBaselineErrors.filter((error) => error.distance === distance)
    );
    const candidate = aggregateRacePredictionErrors(
      mlErrors.filter((error) => error.distance === distance)
    );
    return baseline.meanAbsoluteErrorSeconds !== null &&
      candidate.meanAbsoluteErrorSeconds !== null &&
      candidate.meanAbsoluteErrorSeconds > baseline.meanAbsoluteErrorSeconds * 1.05;
  });
  const recommendMlActivation =
    mlErrors.length >= 6 &&
    mlImprovement !== null &&
    mlImprovement >= 0.03 &&
    !mlRegressesDistance;
  return {
    baselineCases,
    ridgeCases,
    labeledOutcomeCount: outcomes.length,
    rawErrors,
    calibratedErrors,
    mlBaselineErrors,
    mlErrors,
    mlExamples,
    mlImprovement,
    mlRegressesDistance,
    recommendMlActivation
  };
}

function buildModelEvaluation(evaluation: HistoricalEvaluation, asOf: string) {
  const ridgeIds = new Set(evaluation.ridgeCases.map((row) => row.eventId));
  const matchedBaseline = evaluation.baselineCases.filter((row) => ridgeIds.has(row.eventId));
  const calibration = distances.map((distance) => {
    const ordered = evaluation.baselineCases.filter((row) => row.distance === distance)
      .sort((a, b) => Date.parse(a.predictedAt) - Date.parse(b.predictedAt) || a.eventId.localeCompare(b.eventId));
    // Preregistered engineering candidate; no calibration/test event overlap.
    const calibrationCases = ordered.slice(0, Math.floor(ordered.length / 2));
    const through = Math.max(-Infinity, ...calibrationCases.map((row) => Date.parse(row.availableAt)));
    const testCases = ordered.slice(calibrationCases.length)
      .filter((row) => Date.parse(row.predictedAt) > through + 86_400_000);
    const artifact = fitEmpiricalIntervals({
      predictorVersion: PHYSIOLOGY_MODEL_VERSION,
      distance, calibration: calibrationCases, asOf,
      policy: {
        minimumCalibrationSamples: 24, minimumTestSamples: 24,
        minimumCoverage: { p80: 0.75, p90: 0.85 },
        maximumMeanRelativeWidth: 0.5
      }
    });
    return {
      distance,
      policyStatus: "heuristic_candidate_not_activated" as const,
      calibrationCount: calibrationCases.length,
      testCount: testCases.length,
      embargoExcludedCount: ordered.length - calibrationCases.length - testCases.length,
      artifactHash: artifact === null ? null : createHash("sha256").update(artifact.cohortDescriptor).digest("hex"),
      evaluation: artifact === null ? null : evaluateIntervalArtifact(artifact, testCases, asOf),
      status: artifact === null ? "not_evaluable" as const : "evaluated_candidate" as const
    };
  });
  return {
    version: MODEL_EVAL_VERSION,
    replayMode: "event_time_reconstruction" as const,
    availabilityUnknown: true,
    availabilityNote: "Legacy fact arrival times are not completely reconstructible; this is not as-known-then certification.",
    baselineMetrics: predictionMetrics(evaluation.baselineCases, asOf),
    ridgeComparison: {
      baseline: predictionMetrics(matchedBaseline, asOf),
      ridge: predictionMetrics(evaluation.ridgeCases, asOf)
    },
    challengerGate: compareResidualChallengers({
      baseline: matchedBaseline, ridge: evaluation.ridgeCases,
      // A current active model is not a historical out-of-sample challenger.
      // Only a validated training runner may supply those predictions.
      catboost: [], asOf, minimumSamples: 6,
      minimumImprovement: 0.05, maximumDistanceRegression: 0.05
    }),
    calibration
  };
}

function runtimePredictionEvaluation(
  database: DatabaseSync,
  asOf: string
): RuntimePredictionEvaluation {
  const outcomes = loadLabeledRaceOutcomes(database, asOf);
  const rawErrors: RacePredictionError[] = [];
  for (const outcome of outcomes) {
    const base = buildFormulaPredictionBase(database, outcome.observedAt, {});
    const prediction = base.snapshot.races.find((item) => item.distance === outcome.distance);
    if (!prediction || prediction.status !== "available" || prediction.predictedSeconds === null) {
      continue;
    }
    rawErrors.push(evaluateRacePrediction(
      prediction,
      outcome.actualSeconds,
      outcome.completedAt,
      outcome.observedAt
    ));
  }
  return { labeledOutcomeCount: outcomes.length, rawErrors };
}

function enhanceCurrentPrediction(
  base: FormulaPredictionBase,
  evaluation: RuntimePredictionEvaluation,
  generatedAt: string
): {
  snapshot: FormulaPredictionBase["snapshot"];
  selection: PredictionEnhancementSelection;
} {
  const eligibleOutcomeCountByDistance = Object.fromEntries(
    distances.map((distance) => [
      distance,
      evaluation.rawErrors.filter((error) => error.distance === distance).length
    ])
  ) as Record<RaceDistance, number>;
  const calibrationAvailable = distances.some(
    (distance) =>
      eligibleOutcomeCountByDistance[distance] >=
      defaultRacePredictionCalibrationConfig.minimumBiasSamples
  );
  const appliedDistances: RaceDistance[] = [];
  const races: RaceTimePrediction[] = base.snapshot.races.map((prediction) => {
    const calibrated = calibrateRacePrediction(
      prediction,
      generatedAt,
      evaluation.rawErrors
    );
    if ((calibrated.calibrationAdjustmentSeconds ?? 0) !== 0) {
      appliedDistances.push(prediction.distance);
    }
    return {
      ...calibrated,
      machineLearningAdjustmentSeconds:
        calibrated.status === "available" ? 0 : calibrated.machineLearningAdjustmentSeconds,
      machineLearningFallbackReason:
        calibrated.status === "available" ? "no_active_model" as const : null
    };
  });
  const snapshot = { ...base.snapshot, races };
  assertPhysiologyPredictionSnapshot(snapshot);
  return {
    snapshot,
    selection: {
      biasCalibration: {
        status: calibrationAvailable ? "available" : "inactive",
        historicalOutcomeCount: evaluation.labeledOutcomeCount,
        eligibleOutcomeCountByDistance,
        appliedDistances
      },
      machineLearning: {
        status: evaluation.labeledOutcomeCount < 50
          ? "insufficient_samples"
          : "keep_formula_baseline",
        modelVersion: null,
        trainedExampleCount: evaluation.labeledOutcomeCount,
        evaluatedOutcomeCount: 0,
        meanAbsoluteErrorImprovement: null,
        regressesAnyDistanceByMoreThan5Percent: false,
        activeModelRunId: null,
        activeModelVersion: null,
        featureSchemaVersion: null,
        artifactSha256: null,
        activatedAt: null
      }
    }
  };
}

interface ActivePredictionModelRow {
  id: string;
  modelVersion: string;
  featureSchemaVersion: string;
  featureSchemaHash: string | null;
  abilityBaselineHash: string | null;
  trainingDataThroughAt: string;
  trainingDataHash: string;
  metricsJson: string | null;
  labelCount: number;
  holdoutPredictionCount: number;
  supportedDistancesJson: string;
  artifactPath: string;
  artifactSha256: string;
  activatedAt: string;
}

let cachedPredictionModel: {
  key: string;
  model: Promise<OnnxCatBoostResidualModel>;
} | null = null;

function activePredictionModel(database: DatabaseSync): ActivePredictionModelRow | null {
  try {
    const row = database.prepare(`
      SELECT run.id, run.model_version AS modelVersion,
        run.feature_schema_version AS featureSchemaVersion,
        run.feature_schema_hash AS featureSchemaHash,
        run.ability_baseline_hash AS abilityBaselineHash,
        run.training_data_through_at AS trainingDataThroughAt,
        run.training_data_hash AS trainingDataHash,
        run.metrics_json AS metricsJson, run.label_count AS labelCount,
        run.holdout_prediction_count AS holdoutPredictionCount,
        run.supported_distances_json AS supportedDistancesJson,
        run.artifact_path AS artifactPath, run.artifact_sha256 AS artifactSha256,
        active.activated_at AS activatedAt
      FROM active_prediction_model active
      JOIN prediction_model_runs run ON run.id = active.prediction_model_run_id
      WHERE active.singleton = 1 AND run.status = 'succeeded'
    `).get() as unknown as ActivePredictionModelRow | undefined;
    return row ?? null;
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) return null;
    throw error;
  }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function loadActivePredictionModel(
  active: ActivePredictionModelRow
): Promise<OnnxCatBoostResidualModel> {
  const key = `${active.id}:${active.artifactSha256}`;
  if (cachedPredictionModel?.key === key) return cachedPredictionModel.model;
  const model = OnnxCatBoostResidualModel.load(active.artifactPath).then((loaded) => {
    if (loaded.manifest.modelSha256 !== active.artifactSha256) {
      throw new Error("active prediction model artifact hash mismatch");
    }
    return loaded;
  });
  cachedPredictionModel = { key, model };
  try {
    return await model;
  } catch (error) {
    if (cachedPredictionModel?.key === key) cachedPredictionModel = null;
    throw error;
  }
}

export function adjustPredictionWithCatBoost(
  prediction: RaceTimePrediction,
  correctionFraction: number
): RaceTimePrediction {
  if (prediction.status !== "available" || prediction.predictedSeconds === null) {
    return prediction;
  }
  if (!Number.isFinite(correctionFraction) || correctionFraction < -0.25 || correctionFraction > 0.25) {
    throw new Error("CatBoost correction fraction is outside the supported range");
  }
  const factor = 1 + correctionFraction;
  const adjustedPrediction = Math.max(1, prediction.predictedSeconds * factor);
  const adjustment = adjustedPrediction - prediction.predictedSeconds;
  return {
    ...prediction,
    predictedSeconds: adjustedPrediction,
    optimisticSeconds: prediction.optimisticSeconds === null
      ? null
      : Math.max(1, prediction.optimisticSeconds * factor),
    pessimisticSeconds: prediction.pessimisticSeconds === null
      ? null
      : Math.max(1, prediction.pessimisticSeconds * factor),
    machineLearningAdjustmentSeconds: adjustment,
    machineLearningFallbackReason: null,
    method: "catboost_residual_v6",
    evidenceCodes: [...new Set([...prediction.evidenceCodes, "catboost_residual_model" as const])]
  };
}

interface PredictionReportContext {
  report: PhysiologyPredictionReport;
  base: FormulaPredictionBase;
}

function buildPredictionReportContext(
  database: DatabaseSync,
  options: PredictionReportOptions = {}
): PredictionReportContext {
  validateOptions(options);
  const generatedAt = isoDate(options.asOf);
  const scenario = resolvedScenario(options.mode !== undefined && options.mode !== "race_day_scenario" ? {} : options);
  const base = buildFormulaPredictionBase(database, generatedAt, options);
  const evaluation = runtimePredictionEvaluation(database, generatedAt);
  const enhanced = enhanceCurrentPrediction(base, options.mode === undefined ? evaluation : {
    labeledOutcomeCount: evaluation.labeledOutcomeCount, rawErrors: []
  }, generatedAt);
  const guidanceCodes: PhysiologyGuidanceCode[] = [];
  if (base.directEvidenceCount === 0) guidanceCodes.push("direct_vo2_evidence_missing");
  if (evaluation.labeledOutcomeCount === 0) guidanceCodes.push("standard_test_missing");
  if (base.thresholdEvidenceCount === 0) guidanceCodes.push("threshold_segments_missing");
  if (base.readinessStatus === "insufficient_data") {
    guidanceCodes.push("race_readiness_missing");
  }
  const availableRaces = enhanced.snapshot.races.filter((race) => race.status === "available");
  if (
    enhanced.snapshot.performanceVdot.confidenceLevel === "low" ||
    (availableRaces.length > 0 && availableRaces.every((race) => race.confidenceLevel === "low"))
  ) {
    guidanceCodes.push("prediction_confidence_low");
  }
  const labelFunnel = buildLabelFunnel(database, generatedAt, Object.fromEntries(
    distances.map((distance) => [distance, evaluation.rawErrors.filter((row) => row.distance === distance).length])
  ));
  return { base, report: {
    ...(options.mode === undefined ? {} : {
      predictionPolicy: {
        version: "rai-prediction-policy-v2" as const,
        mode: options.mode,
        targetDate: options.targetDate ?? null,
        pointCorrection: "none" as const,
        intervalStatus: "insufficient_calibration" as const,
        corrections: enhanced.snapshot.races.flatMap((race) => {
          if (race.potentialSeconds === null || race.predictedSeconds === null) return [];
          let seconds = race.potentialSeconds;
          const adjustments = [
            ["preparation", race.readinessAdjustmentSeconds],
            ["environment", race.environmentAdjustmentSeconds],
            ["elevation", race.elevationAdjustmentSeconds],
            ["acute_readiness", race.fatigueAdjustmentSeconds]
          ] as const;
          const steps = adjustments.map(([kind, adjustment]) => {
            const beforeSeconds = seconds;
            seconds += adjustment ?? 0;
            return { kind, beforeSeconds, afterSeconds: seconds };
          });
          if (Math.abs(seconds - race.predictedSeconds) > 1e-6) throw new Error("Prediction correction ledger mismatch");
          return [{ distance: race.distance, steps }];
        })
      }
    }),
    labelFunnel: {
      sessionCount: labelFunnel.sessionCount,
      confirmedCount: labelFunnel.confirmedCount,
      usableOutcomeCount: labelFunnel.usableOutcomeCount,
      evaluatedOutcomeCount: labelFunnel.evaluatedOutcomeCount,
      primaryRejections: labelFunnel.primaryRejections,
      accuracyStatus: labelFunnel.accuracyStatus
    },
    reportVersion: PHYSIOLOGY_REPORT_VERSION,
    generatedAt,
    inputs: {
      directVo2Evidence: base.directEvidenceCount,
      labeledPerformanceEvidence: base.labeledPerformanceCount,
      lactateThresholdSegments: base.thresholdEvidenceCount,
      performanceVdotEvidence: base.performanceVdotEvidenceCount,
      labeledRaceOutcomes: evaluation.labeledOutcomeCount,
      readiness: base.readiness,
      recoveryReadiness: base.recoveryReadiness,
      scenario,
      profile: base.profile
    },
    modelSelection: enhanced.selection,
    guidanceCodes,
    explainability: {
      schemaVersion: "prediction-explainability-v1",
      recovery: {
        readiness: base.recoveryReadiness,
        status: base.recoveryProvenance.source === "raw_compat" || base.recoveryProvenance.source === "mixed"
          ? "compat_fallback"
          : base.recoveryReadiness === null
            ? "insufficient_data"
            : "available",
        source: base.recoveryProvenance.source,
        asOf: generatedAt,
        latestObservedAt: base.recoveryProvenance.latestObservedAt,
        coverage: base.recoveryProvenance.coverage
      },
      readiness: Object.fromEntries(
        (Object.keys(base.readiness) as RaceDistance[]).map((distance) => [
          distance,
          {
            value: base.readiness[distance],
            status: base.readinessStatus,
            evidenceCount: base.readinessEvidenceCount,
            dataThroughAt: base.readinessDataThroughAt
          }
        ])
      ) as PredictionExplainability["readiness"]
    },
    snapshot: enhanced.snapshot
  } };
}

export function buildPredictionReport(
  database: DatabaseSync,
  options: PredictionReportOptions = {}
): PhysiologyPredictionReport {
  return buildPredictionReportContext(database, options).report;
}

async function buildPredictionReportAsyncInternal(
  database: DatabaseSync,
  options: PredictionReportOptions = {}
): Promise<PhysiologyPredictionReport> {
  const active = activePredictionModel(database);
  const initialBaselineHash = active === null ? null : currentAbilityBaselineHash(database);
  const context = buildPredictionReportContext(database, options);
  const formulaReport = context.report;
  // Old residual artifacts and bias errors target the legacy policy. They must
  // not silently correct the new scenario semantics, even when a model is active.
  if (options.mode !== "current_prepared") {
    if (!activePredictionModel(database)) return formulaReport;
    return {...formulaReport, modelSelection:{...formulaReport.modelSelection,
      machineLearning:{...formulaReport.modelSelection.machineLearning,status:"inference_unavailable"}},
      snapshot:{...formulaReport.snapshot,races:formulaReport.snapshot.races.map((row)=>({...row,machineLearningFallbackReason:"feature_schema_mismatch" as const}))}};
  }
  if (active === null) return formulaReport;

  const metrics = parseJson<PredictionModelEvaluationMetrics | null>(active.metricsJson, null);
  const supportedDistances = parseJson<RaceDistance[]>(active.supportedDistancesJson, []);
  const baseSelection = (): PredictionEnhancementSelection["machineLearning"] => ({
    status: "active",
    modelVersion: CATBOOST_PREDICTION_MODEL_VERSION,
    trainedExampleCount: active.labelCount,
    evaluatedOutcomeCount: active.holdoutPredictionCount,
    meanAbsoluteErrorImprovement: metrics?.maeImprovement ?? null,
    regressesAnyDistanceByMoreThan5Percent:
      metrics?.regressesAnyDistanceByMoreThan5Percent ?? false,
    activeModelRunId: active.id,
    activeModelVersion: active.modelVersion,
    featureSchemaVersion: active.featureSchemaVersion,
    artifactSha256: active.artifactSha256,
    activatedAt: active.activatedAt
  });
  const withSelection = (
    races: RaceTimePrediction[],
    status: PredictionEnhancementSelection["machineLearning"]["status"] = "active"
  ): PhysiologyPredictionReport => ({
    ...formulaReport,
    ...(formulaReport.predictionPolicy ? {predictionPolicy:{...formulaReport.predictionPolicy,
      pointCorrection:races.some((r)=>r.method==="catboost_residual_v6")?"catboost" as const:"none" as const,
      corrections:formulaReport.predictionPolicy.corrections.map((row)=>{
        const race=races.find((r)=>r.distance===row.distance);
        const before=row.steps.at(-1)?.afterSeconds;
        return race?.method==="catboost_residual_v6" && race.predictedSeconds!==null && before!==undefined
          ? {...row,steps:[...row.steps,{kind:"catboost" as const,beforeSeconds:before,afterSeconds:race.predictedSeconds}]}:row;
      })}}:{}),
    modelSelection: {
      ...formulaReport.modelSelection,
      biasCalibration: {
        ...formulaReport.modelSelection.biasCalibration,
        appliedDistances: formulaReport.modelSelection.biasCalibration.appliedDistances.filter(
          (distance) => races.find((race) => race.distance === distance)?.method !== "catboost_residual_v6"
        )
      },
      machineLearning: { ...baseSelection(), status }
    },
    snapshot: { ...formulaReport.snapshot, races }
  });

  const { buildRaceResidualFeatureValues, raceResidualFeatureSchemaHash } =
    await import("./prediction-training-data.js");
  const generatedAt = formulaReport.generatedAt;
  const schemaMatches =
    active.modelVersion === CATBOOST_PREDICTION_MODEL_VERSION &&
    active.featureSchemaVersion === PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION &&
    active.featureSchemaHash === raceResidualFeatureSchemaHash() &&
    active.abilityBaselineHash !== null &&
    active.abilityBaselineHash === initialBaselineHash;
  const trainingCutoffMatches =
    Date.parse(active.trainingDataThroughAt) <= Date.parse(generatedAt);
  if (!schemaMatches || !trainingCutoffMatches) {
    return withSelection(formulaReport.snapshot.races.map((prediction) => ({
      ...prediction,
      machineLearningFallbackReason:
        prediction.status === "available" ? "feature_schema_mismatch" : null
    })), "inference_unavailable");
  }

  // A restored database can contain an old active pointer. Publication and
  // inference independently require the current Ridge + interval proof.
  const ridge=metrics?.ridgeComparison;
  const ridgeValid=ridge?.status==="passed" && [ridge.walkForwardImprovement,ridge.releaseImprovement,ridge.bootstrapLower]
    .every(Number.isFinite) && ridge.walkForwardImprovement>=0.05 && ridge.releaseImprovement>=0.05 && ridge.bootstrapLower>0;
  const intervals=new SqliteCalibrationRepository(database);
  const intervalsValid=initialBaselineHash!==null && distances.every(distance=>
    intervals.select(catBoostCalibrationKey(active.artifactSha256),initialBaselineHash!,distance,generatedAt,1)!==null);
  if(!ridgeValid||!intervalsValid){
    return withSelection(formulaReport.snapshot.races.map(prediction=>({...prediction,
      machineLearningFallbackReason:prediction.status==="available"?"feature_schema_mismatch" as const:null,
      machineLearningPolicyReason:!ridgeValid?"ridge_not_validated" as const:"calibration_unavailable" as const
    })),"inference_unavailable");
  }

  if (currentAbilityBaselineHash(database) !== initialBaselineHash) {
    return withSelection(formulaReport.snapshot.races.map((prediction) => ({
      ...prediction,
      machineLearningFallbackReason:
        prediction.status === "available" ? "feature_schema_mismatch" : null
    })), "inference_unavailable");
  }

  const base = context.base;
  const inferenceBase = buildFormulaPredictionBase(database, generatedAt, {
    ...(options.timezoneIdentifier === undefined ? {} : { timezoneIdentifier: options.timezoneIdentifier }),
    recoveryReadiness: base.recoveryReadiness, mode: "current_prepared"
  });
  const inferenceScenario: PhysiologyPredictionScenario = {
    temperatureC: null,
    humidityPercent: null,
    elevationGainMeters: { five_k: null, ten_k: null, half_marathon: null }
  };
  const featureValues = new Map<
    RaceDistance,
    ReturnType<typeof buildRaceResidualFeatureValues>
  >();
  for (const prediction of formulaReport.snapshot.races) {
    if (prediction.status !== "available" || !supportedDistances.includes(prediction.distance)) {
      continue;
    }
    featureValues.set(
      prediction.distance,
      buildRaceResidualFeatureValues(
        database,
        generatedAt,
        prediction.distance,
        inferenceBase,
        inferenceScenario
      )
    );
  }

  let model: OnnxCatBoostResidualModel;
  try {
    model = await loadActivePredictionModel(active);
  } catch {
    return withSelection(formulaReport.snapshot.races.map((prediction) => ({
      ...prediction,
      machineLearningFallbackReason:
        prediction.status === "available" ? "inference_failed" : null
    })), "inference_unavailable");
  }
  if (
    currentAbilityBaselineHash(database) !== initialBaselineHash ||
    model.manifest.featureSchemaVersion !== active.featureSchemaVersion ||
    model.manifest.featureSchemaHash !== active.featureSchemaHash ||
    model.manifest.trainingDataHash !== active.trainingDataHash ||
    model.manifest.labelCount !== active.labelCount ||
    model.manifest.modelSha256 !== active.artifactSha256 ||
    model.manifest.correctionCapFraction !== PREDICTION_CORRECTION_CAP_FRACTION ||
    model.manifest.supportedDistances.length !== supportedDistances.length ||
    model.manifest.supportedDistances.some((distance) => !supportedDistances.includes(distance))
  ) {
    return withSelection(formulaReport.snapshot.races.map((prediction) => ({
      ...prediction,
      machineLearningFallbackReason:
        prediction.status === "available" ? "feature_schema_mismatch" : null
    })), "inference_unavailable");
  }

  const races = await Promise.all(formulaReport.snapshot.races.map(async (formulaPrediction) => {
    if (formulaPrediction.status !== "available") return formulaPrediction;
    if (!supportedDistances.includes(formulaPrediction.distance) || !model.supportsDistance(formulaPrediction.distance)) {
      return { ...formulaPrediction, machineLearningFallbackReason: "unsupported_distance" as const };
    }
    const rawPrediction = base.snapshot.races.find(
      (prediction) => prediction.distance === formulaPrediction.distance
    );
    if (!rawPrediction || rawPrediction.status !== "available") {
      return { ...formulaPrediction, machineLearningFallbackReason: "inference_failed" as const };
    }
    const features = featureValues.get(formulaPrediction.distance) ?? null;
    if (features === null) {
      return { ...formulaPrediction, machineLearningFallbackReason: "inference_failed" as const };
    }
    try {
      const output = await model.predict({
        ...features,
        isFiveK: formulaPrediction.distance === "five_k" ? 1 : 0,
        isTenK: formulaPrediction.distance === "ten_k" ? 1 : 0,
        isHalfMarathon: formulaPrediction.distance === "half_marathon" ? 1 : 0
      });
      return adjustPredictionWithCatBoost(rawPrediction, output.correctionFraction);
    } catch {
      return { ...formulaPrediction, machineLearningFallbackReason: "inference_failed" as const };
    }
  }));
  const availableRaces = races.filter((race) => race.status === "available");
  const appliedMlRaces = availableRaces.filter(
    (race) => race.method === "catboost_residual_v6"
  );
  // "active" only when every available race applied CatBoost; partial apply is "stale".
  const mlStatus: PredictionEnhancementSelection["machineLearning"]["status"] =
    appliedMlRaces.length === 0
      ? "inference_unavailable"
      : appliedMlRaces.length === availableRaces.length
        ? "active"
        : "stale";
  const report = withSelection(races, mlStatus);
  assertPhysiologyPredictionSnapshot(report.snapshot);
  return report;
}

export function buildPredictionEvaluationReport(
  database: DatabaseSync,
  asOfInput = new Date().toISOString()
): PredictionEvaluationReport {
  const asOf = isoDate(asOfInput);
  const evaluation = historicalEvaluation(database, asOf);
  const rawMetrics = aggregateRacePredictionErrors(evaluation.rawErrors);
  const calibratedMetrics = aggregateRacePredictionErrors(evaluation.calibratedErrors);
  const baselineMetrics = aggregateRacePredictionErrors(evaluation.mlBaselineErrors);
  const candidateMetrics = aggregateRacePredictionErrors(evaluation.mlErrors);
  return {
    reportVersion: "rai-prediction-walk-forward-v2",
    asOf,
    status: evaluation.labeledOutcomeCount === 0
      ? "insufficient_labeled_outcomes"
      : "evaluated",
    labeledOutcomeCount: evaluation.labeledOutcomeCount,
    evaluatedOutcomeCount: evaluation.rawErrors.length,
    calibrationAppliedCount: evaluation.calibratedErrors.filter(
      (error, index) => error.predictedSeconds !== evaluation.rawErrors[index]?.predictedSeconds
    ).length,
    rawMetrics,
    calibratedMetrics,
    machineLearningCandidate: {
      status: evaluation.mlErrors.length === 0
        ? "insufficient_walk_forward_samples"
        : evaluation.recommendMlActivation
          ? "recommend_activation"
          : "keep_formula_baseline",
      trainedExampleCount: evaluation.mlExamples.length,
      evaluatedOutcomeCount: evaluation.mlErrors.length,
      meanAbsoluteErrorImprovement: evaluation.mlImprovement,
      regressesAnyDistanceByMoreThan5Percent: evaluation.mlRegressesDistance,
      baselineMetrics,
      candidateMetrics
    },
    byDistance: Object.fromEntries(
      distances.map((distance) => [
        distance,
        {
          raw: aggregateRacePredictionErrors(
            evaluation.rawErrors.filter((error) => error.distance === distance)
          ),
          calibrated: aggregateRacePredictionErrors(
            evaluation.calibratedErrors.filter((error) => error.distance === distance)
          )
        }
      ])
    ) as PredictionEvaluationReport["byDistance"],
    rawErrors: evaluation.rawErrors,
    calibratedErrors: evaluation.calibratedErrors,
    modelEvaluation: buildModelEvaluation(evaluation, asOf),
    labelFunnel: buildLabelFunnel(database, asOf, Object.fromEntries(
      distances.map((distance) => [
        distance, evaluation.rawErrors.filter((error) => error.distance === distance).length
      ])
    ))
  };
}

function attachCalibratedIntervals(database:DatabaseSync, report:PhysiologyPredictionReport, options:PredictionReportOptions):PhysiologyPredictionReport {
  const baselineHash=database.prepare("SELECT 1 FROM sqlite_master WHERE name='feature_runs'").get() ? currentAbilityBaselineHash(database) : null;
  const repository=new SqliteCalibrationRepository(database);
  const races=report.snapshot.races.map((prediction)=>{
    const predictorKey=predictionPolicyKey(options.mode??"legacy",prediction.method,prediction.method==="catboost_residual_v6"?report.modelSelection.machineLearning.artifactSha256:null,report.inputs.scenario);
    const selected=baselineHash && prediction.predictedSeconds!==null
      ? repository.select(predictorKey,baselineHash,prediction.distance,report.generatedAt,prediction.predictedSeconds):null;
    return {...prediction,intervalEvidence:{predictorKey,
      status:selected?"empirically_evaluated" as const:"insufficient_calibration" as const,
      artifactId:selected?.artifactId??null,p50Seconds:selected?.bounds.p50Seconds??null,
      p80:selected?.bounds.p80??null,p90:selected?.bounds.p90??null,
      coverageP80:selected?.evaluation.p80.empiricalCoverage??null,coverageP90:selected?.evaluation.p90.empiricalCoverage??null,
      coverageIntervalP80:selected?.evaluation.p80.coverageConfidenceInterval??null,
      coverageIntervalP90:selected?.evaluation.p90.coverageConfidenceInterval??null,
      evaluationSamples:selected?.evaluation.p80.evaluationSampleCount??0,
      coverageClaim:"empirical_target_not_individual_guarantee" as const}};
  });
  const calibrated=races.filter((r)=>r.intervalEvidence.status==="empirically_evaluated").length;
  return {...report,...(report.predictionPolicy?{predictionPolicy:{...report.predictionPolicy,
    intervalStatus:calibrated===0?"insufficient_calibration" as const:calibrated===races.filter((r)=>r.status==="available").length?"empirically_evaluated" as const:"partially_calibrated" as const}}:{}),
    snapshot:{...report.snapshot,races}};
}
export async function buildPredictionReportAsync(database:DatabaseSync,options:PredictionReportOptions={}):Promise<PhysiologyPredictionReport> {
  return attachCalibratedIntervals(database,await buildPredictionReportAsyncInternal(database,options),options);
}
