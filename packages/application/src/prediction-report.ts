import type { DatabaseSync } from "node:sqlite";

import {
  CATBOOST_PREDICTION_MODEL_VERSION,
  PREDICTION_CORRECTION_CAP_FRACTION,
  PHYSIOLOGY_REPORT_VERSION,
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
  assertPhysiologyPredictionSnapshot,
  type PhysiologyGuidanceCode,
  type PhysiologyPredictionReport,
  type PhysiologyPredictionScenario,
  type PredictionEnhancementSelection,
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
  type RacePredictionConditions
} from "@rai/physiology";

import {
  loadDirectVo2Evidence,
  loadLactateThresholdEvidence,
  loadLabeledPerformanceEvidence,
  loadLabeledRaceOutcomes,
  loadPerformanceVdotEvidence,
  loadPhysiologyProfile,
  loadRaceReadiness,
  loadRecoveryReadiness
} from "./prediction-data.js";
import { currentAbilityBaselineHash } from "./prediction-ability-baseline.js";

const distances: RaceDistance[] = ["five_k", "ten_k", "half_marathon"];

export interface PredictionReportOptions {
  asOf?: string;
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
}

export interface FormulaPredictionBase {
  directEvidenceCount: number;
  labeledPerformanceCount: number;
  thresholdEvidenceCount: number;
  performanceVdotEvidenceCount: number;
  readiness: Record<RaceDistance, number>;
  recoveryReadiness: number | null;
  profile: {
    restingHeartRateBpm: number | null;
    observedMaximumHeartRateBpm: number | null;
  };
  snapshot: ReturnType<typeof buildPhysiologyPredictionSnapshot>;
}

interface HistoricalEvaluation {
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

function resolvedReadiness(readiness: PredictionReadiness): Record<RaceDistance, number> {
  return {
    five_k: readiness.five_k ?? 0,
    ten_k: readiness.ten_k ?? 0,
    half_marathon: readiness.half_marathon ?? 0
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
  const readiness = resolvedReadiness(loadRaceReadiness(database, asOf));
  const recoveryReadiness = options.recoveryReadiness === undefined ? loadRecoveryReadiness(database, asOf) : options.recoveryReadiness;
  const scenario = resolvedScenario(options);
  const profile = loadPhysiologyProfile(database, asOf);
  const snapshot = buildPhysiologyPredictionSnapshot({
    // Race/test performance is VDOT evidence, not a physiological VO2max
    // measurement. Keep the count for provenance, but never merge the same
    // event into the VO2max ensemble through a second derived path.
    evidence: directEvidence,
    performanceEvidence: performanceVdotEvidence,
    thresholdEvidence,
    readiness,
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
    recoveryReadiness,
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
    if (priorMlModel !== null) {
      const mlPrediction = applyRaceResidualRidge(prediction, priorMlModel, mlFeatures);
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
  const scenario = resolvedScenario(options);
  const base = buildFormulaPredictionBase(database, generatedAt, options);
  const evaluation = runtimePredictionEvaluation(database, generatedAt);
  const enhanced = enhanceCurrentPrediction(base, evaluation, generatedAt);
  const guidanceCodes: PhysiologyGuidanceCode[] = [];
  if (base.directEvidenceCount === 0) guidanceCodes.push("direct_vo2_evidence_missing");
  if (evaluation.labeledOutcomeCount === 0) guidanceCodes.push("standard_test_missing");
  if (base.thresholdEvidenceCount === 0) guidanceCodes.push("threshold_segments_missing");
  const availableRaces = enhanced.snapshot.races.filter((race) => race.status === "available");
  if (
    enhanced.snapshot.performanceVdot.confidenceLevel === "low" ||
    (availableRaces.length > 0 && availableRaces.every((race) => race.confidenceLevel === "low"))
  ) {
    guidanceCodes.push("prediction_confidence_low");
  }
  return { base, report: {
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
    snapshot: enhanced.snapshot
  } };
}

export function buildPredictionReport(
  database: DatabaseSync,
  options: PredictionReportOptions = {}
): PhysiologyPredictionReport {
  return buildPredictionReportContext(database, options).report;
}

export async function buildPredictionReportAsync(
  database: DatabaseSync,
  options: PredictionReportOptions = {}
): Promise<PhysiologyPredictionReport> {
  const active = activePredictionModel(database);
  const initialBaselineHash = active === null ? null : currentAbilityBaselineHash(database);
  const context = buildPredictionReportContext(database, options);
  const formulaReport = context.report;
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

  if (currentAbilityBaselineHash(database) !== initialBaselineHash) {
    return withSelection(formulaReport.snapshot.races.map((prediction) => ({
      ...prediction,
      machineLearningFallbackReason:
        prediction.status === "available" ? "feature_schema_mismatch" : null
    })), "inference_unavailable");
  }

  const base = context.base;
  const inferenceBase = buildFormulaPredictionBase(database, generatedAt, {
    recoveryReadiness: base.recoveryReadiness
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
    calibratedErrors: evaluation.calibratedErrors
  };
}
