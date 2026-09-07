import type {
  AbilityDimensionScores,
  AbilityExplanationCode,
  ConfidenceFactors as ContractConfidenceFactors,
  WorkoutFeatureVector
} from "@rai/contracts";

import {
  confidenceScore,
  growthResistance,
  updateTrueAbility,
  weightedCurrentAbility,
  type AbilityDimension
} from "./index.js";

export const MODEL_CONFIG_VERSION = "rai-model-config-v4" as const;

export interface RaiModelConfig {
  calibrationMinimumSessions: number;
  calibrationMinimumSpanDays: number;
  minimumAvailableWeight: number;
  minimumConfidenceForTrueAbility: number;
  dimensionScoreZScale: number;
  dimensionWeights: Record<AbilityDimension, number>;
}

export const defaultRaiModelConfig: RaiModelConfig = {
  calibrationMinimumSessions: 6,
  calibrationMinimumSpanDays: 14,
  minimumAvailableWeight: 0.65,
  minimumConfidenceForTrueAbility: 0.6,
  // The observed Cardio proxy is duration multiplied by speed, which is chiefly distance.
  // Preserve it as a diagnostic score, but exclude it from CA until a valid aerobic signal exists.
  dimensionScoreZScale: 10,
  dimensionWeights: {
    efficiency: 0.375,
    pace: 0.3125,
    cardio: 0,
    stability: 0.1875,
    recovery: 0.125
  }
};

export interface RobustDimensionBaseline {
  center: number;
  scale: number;
}

export interface PersonalBaseline {
  calibrationFeatureIds: string[];
  calibrationStartAt: string;
  calibrationEndAt: string;
  dimensions: Partial<Record<AbilityDimension, RobustDimensionBaseline>>;
}

export interface FeatureScoreResult {
  status: "eligible" | "trial" | "excluded" | "calibrating";
  currentAbility: number | null;
  dimensions: AbilityDimensionScores;
  effectiveWeights: Partial<Record<AbilityDimension, number>>;
  confidence: number;
  confidenceFactors: ContractConfidenceFactors;
  workoutContribution: number | null;
  evidenceStrength: number | null;
  explanationCodes: AbilityExplanationCode[];
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (upper === undefined) return null;
  return sorted.length % 2 === 0 && lower !== undefined ? (lower + upper) / 2 : upper;
};

export function sortWorkoutFeaturesChronologically(
  features: WorkoutFeatureVector[]
): WorkoutFeatureVector[] {
  for (const feature of features) {
    if (!Number.isFinite(Date.parse(feature.workoutStartAt))) {
      throw new Error("workoutStartAt must be a valid date-time");
    }
  }
  return [...features].sort((left, right) => {
    const leftMs = Date.parse(left.workoutStartAt);
    const rightMs = Date.parse(right.workoutStartAt);
    return leftMs - rightMs ||
      left.trainingSessionId.localeCompare(right.trainingSessionId) ||
      left.id.localeCompare(right.id);
  });
}

function scoreFiniteZ(value: number, baseline: RobustDimensionBaseline, zScale: number): number {
  if (zScale === 0) return 50;
  const z = (value - baseline.center) / baseline.scale;
  const scaled = zScale * z;
  if (!Number.isFinite(scaled)) return scaled > 0 ? 100 : 0;
  return clamp(50 + scaled, 0, 100);
}

function assertModelConfig(config: RaiModelConfig): void {
  const scalarEntries: Array<[string, number]> = [
    ["calibrationMinimumSessions", config.calibrationMinimumSessions],
    ["calibrationMinimumSpanDays", config.calibrationMinimumSpanDays],
    ["minimumAvailableWeight", config.minimumAvailableWeight],
    ["minimumConfidenceForTrueAbility", config.minimumConfidenceForTrueAbility],
    ["dimensionScoreZScale", config.dimensionScoreZScale]
  ];
  for (const [name, value] of scalarEntries) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  }
  if (config.calibrationMinimumSessions < 1 || config.calibrationMinimumSpanDays < 0) {
    throw new Error("Calibration requirements must be non-negative, with at least one session");
  }
  if (config.minimumAvailableWeight < 0 || config.minimumAvailableWeight > 1) {
    throw new Error("minimumAvailableWeight must be between 0 and 1");
  }
  if (config.minimumConfidenceForTrueAbility < 0 || config.minimumConfidenceForTrueAbility > 1) {
    throw new Error("minimumConfidenceForTrueAbility must be between 0 and 1");
  }
  if (config.dimensionScoreZScale < 0) {
    throw new Error("dimensionScoreZScale must be non-negative");
  }
  for (const dimension of ["efficiency", "pace", "cardio", "stability", "recovery"] as AbilityDimension[]) {
    const weight = config.dimensionWeights[dimension];
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`dimensionWeights.${dimension} must be finite and non-negative`);
    }
  }
}

const rawSignal = (
  feature: WorkoutFeatureVector,
  dimension: AbilityDimension
): number | null => {
  switch (dimension) {
    case "efficiency":
      return feature.signals.efficiencyRaw;
    case "pace":
      return feature.signals.paceRawMetersPerSecond;
    case "cardio":
      return feature.signals.cardioRaw;
    case "stability":
      return feature.signals.stabilityRaw;
    case "recovery":
      return feature.signals.recoveryRaw;
  }
};

function robustBaseline(values: number[]): RobustDimensionBaseline | null {
  const center = median(values);
  if (center === null) return null;
  const deviations = values.map((value) => Math.abs(value - center));
  const mad = median(deviations);
  if (mad === null) return null;
  return {
    center,
    scale: Math.max(1.4826 * mad, Math.abs(center) * 0.03, 0.0001)
  };
}

export function createPersonalBaseline(
  calibrationFeatures: WorkoutFeatureVector[]
): PersonalBaseline | null {
  if (calibrationFeatures.length === 0) return null;
  const dimensions: Partial<Record<AbilityDimension, RobustDimensionBaseline>> = {};
  const names: AbilityDimension[] = ["efficiency", "pace", "cardio", "stability", "recovery"];
  for (const dimension of names) {
    const values = calibrationFeatures
      .map((feature) => rawSignal(feature, dimension))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const baseline = robustBaseline(values);
    if (baseline) dimensions[dimension] = baseline;
  }

  const sorted = sortWorkoutFeaturesChronologically(calibrationFeatures);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return null;
  return {
    calibrationFeatureIds: sorted.map((feature) => feature.id),
    calibrationStartAt: first.workoutStartAt,
    calibrationEndAt: last.workoutStartAt,
    dimensions
  };
}

export function hasCompletedCalibration(
  features: WorkoutFeatureVector[],
  config: RaiModelConfig = defaultRaiModelConfig
): boolean {
  if (features.length < config.calibrationMinimumSessions) return false;
  const sorted = sortWorkoutFeaturesChronologically(features);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return false;
  const spanDays =
    (Date.parse(last.workoutStartAt) - Date.parse(first.workoutStartAt)) / (24 * 60 * 60 * 1000);
  return spanDays >= config.calibrationMinimumSpanDays;
}

function scoreRawSignal(
  value: number | null,
  baseline: RobustDimensionBaseline | undefined,
  zScale: number
): number | null {
  if (value === null || !Number.isFinite(value) || !baseline) return null;
  if (!Number.isFinite(baseline.center) || !Number.isFinite(baseline.scale) || baseline.scale <= 0) {
    throw new Error("Baseline center and scale must be finite, with a positive scale");
  }
  if (!Number.isFinite(zScale) || zScale < 0) {
    throw new Error("dimensionScoreZScale must be finite and non-negative");
  }
  return scoreFiniteZ(value, baseline, zScale);
}

function evidenceStrength(feature: WorkoutFeatureVector): number {
  switch (feature.sessionType) {
    case "race":
      return 1;
    case "tempo":
    case "steady":
      return 0.9;
    case "long_run":
      return 0.8;
    case "interval":
      return 0.7;
    case "easy":
      return 0.6;
    case "recovery":
      return 0.45;
    default:
      return 0.65;
  }
}

function contributionFactor(feature: WorkoutFeatureVector): number {
  switch (feature.sessionType) {
    case "race":
      return 1;
    case "tempo":
    case "interval":
      return 0.9;
    case "steady":
    case "long_run":
      return 0.75;
    case "easy":
      return 0.55;
    case "recovery":
      return 0.35;
    default:
      return 0.5;
  }
}

export function scoreFeature(
  feature: WorkoutFeatureVector,
  baseline: PersonalBaseline,
  calibrationMaturity: number,
  config: RaiModelConfig = defaultRaiModelConfig
): FeatureScoreResult {
  assertModelConfig(config);
  const dimensions: AbilityDimensionScores = {
    efficiency: scoreRawSignal(
      feature.signals.efficiencyRaw,
      baseline.dimensions.efficiency,
      config.dimensionScoreZScale
    ),
    pace: scoreRawSignal(
      feature.signals.paceRawMetersPerSecond,
      baseline.dimensions.pace,
      config.dimensionScoreZScale
    ),
    cardio: scoreRawSignal(
      feature.signals.cardioRaw,
      baseline.dimensions.cardio,
      config.dimensionScoreZScale
    ),
    stability: scoreRawSignal(
      feature.signals.stabilityRaw,
      baseline.dimensions.stability,
      config.dimensionScoreZScale
    ),
    recovery: scoreRawSignal(
      feature.signals.recoveryRaw,
      baseline.dimensions.recovery,
      config.dimensionScoreZScale
    )
  };
  const names: AbilityDimension[] = ["efficiency", "pace", "cardio", "stability", "recovery"];
  const available = names.flatMap((dimension) => {
    const score = dimensions[dimension];
    return score === null || config.dimensionWeights[dimension] === 0
      ? []
      : [{ dimension, score, baseWeight: config.dimensionWeights[dimension] }];
  });
  const availableWeight = available.reduce((sum, item) => sum + item.baseWeight, 0);
  const effectiveWeights = Object.fromEntries(
    available.map((item) => [
      item.dimension,
      availableWeight > 0 ? item.baseWeight / availableWeight : 0
    ])
  ) as Partial<Record<AbilityDimension, number>>;
  const coverage = clamp(feature.qualityScore, 0, 1);
  const comparability = clamp(
    feature.sessionType === "interval" ? 0.75 : feature.sessionType === "unknown" ? 0.8 : 1,
    0,
    1
  );
  const confidenceFactors: ContractConfidenceFactors = {
    coverage,
    source: feature.sourceConfidence,
    comparability,
    maturity: clamp(calibrationMaturity, 0, 1)
  };
  const confidence = confidenceScore(confidenceFactors);
  const explanations: AbilityExplanationCode[] = [];

  if (feature.eligibilityStatus === "excluded") {
    explanations.push(feature.missingReasons.includes("user_excluded") ? "user_excluded" : "data_insufficient");
    return {
      status: "excluded",
      currentAbility: null,
      dimensions,
      effectiveWeights,
      confidence,
      confidenceFactors,
      workoutContribution: null,
      evidenceStrength: null,
      explanationCodes: explanations
    };
  }
  if (availableWeight < config.minimumAvailableWeight || (dimensions.efficiency === null && dimensions.pace === null)) {
    explanations.push("data_insufficient");
    return {
      status: "trial",
      currentAbility: null,
      dimensions,
      effectiveWeights,
      confidence,
      confidenceFactors,
      workoutContribution: null,
      evidenceStrength: null,
      explanationCodes: explanations
    };
  }

  const currentAbility = weightedCurrentAbility(available);
  const contribution = clamp(feature.qualityScore * contributionFactor(feature) * 100, 0, 100);
  const resultStatus = feature.eligibilityStatus === "trial" ? "trial" : "eligible";
  const mapping: Array<[AbilityDimension, AbilityExplanationCode, AbilityExplanationCode]> = [
    ["efficiency", "efficiency_above_baseline", "efficiency_below_baseline"],
    ["pace", "pace_above_baseline", "pace_below_baseline"],
    ["cardio", "cardio_above_baseline", "cardio_below_baseline"],
    ["stability", "stability_above_baseline", "stability_below_baseline"]
  ];
  for (const [dimension, positive, negative] of mapping) {
    if (config.dimensionWeights[dimension] === 0) continue;
    const value = dimensions[dimension];
    if (value !== null && value >= 56) explanations.push(positive);
    if (value !== null && value <= 44) explanations.push(negative);
  }
  if (dimensions.recovery !== null && dimensions.recovery <= 44) explanations.push("recovery_low");
  if (dimensions.recovery !== null && dimensions.recovery >= 56) explanations.push("recovery_high");
  if (confidence < config.minimumConfidenceForTrueAbility) {
    explanations.push("low_confidence_no_true_ability_update");
  }

  return {
    status: resultStatus,
    currentAbility,
    dimensions,
    effectiveWeights,
    confidence,
    confidenceFactors,
    workoutContribution: contribution,
    evidenceStrength: evidenceStrength(feature),
    explanationCodes: [...new Set(explanations)]
  };
}

export function updateTrueAbilityFromFeatureScore(
  currentTrueAbility: number,
  eligibleWorkoutCount: number,
  score: FeatureScoreResult,
  config: RaiModelConfig = defaultRaiModelConfig
): {
  nextTrueAbility: number;
  directionFactor: number;
  growthResistance: number;
  updated: boolean;
} {
  if (
    score.status !== "eligible" ||
    score.currentAbility === null ||
    score.evidenceStrength === null ||
    score.confidence < config.minimumConfidenceForTrueAbility
  ) {
    return {
      nextTrueAbility: currentTrueAbility,
      directionFactor: 0,
      growthResistance: 1,
      updated: false
    };
  }
  const negative = score.currentAbility < currentTrueAbility;
  const directionFactor = negative && score.dimensions.recovery !== null && score.dimensions.recovery < 40 ? 0.25 : negative ? 0.4 : 1;
  const resistance = negative ? 1 : growthResistance(currentTrueAbility);
  const nextTrueAbility = updateTrueAbility({
    trueAbility: currentTrueAbility,
    currentAbility: score.currentAbility,
    eligibleWorkoutCount,
    confidence: score.confidence,
    evidenceStrength: score.evidenceStrength,
    directionFactor
  });
  return {
    nextTrueAbility,
    directionFactor,
    growthResistance: resistance,
    updated: nextTrueAbility !== currentTrueAbility
  };
}
