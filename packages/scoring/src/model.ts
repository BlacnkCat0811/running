import { SESSION_STRATA } from "@rai/contracts";
import type {
  AbilityDimensionScores,
  AbilityExplanationCode,
  ComparabilityPolicy,
  ConfidenceFactors as ContractConfidenceFactors,
  ConfidenceV2,
  ConfidenceWeightsV2,
  SessionStratum,
  StratumComparability,
  StratumHistory,
  WorkoutFeatureVector
} from "@rai/contracts";

import {
  comparabilityValue,
  confidenceScore,
  evaluateConfidenceV2,
  evaluateStratumComparability,
  growthResistance,
  sessionStratum,
  updateTrueAbility,
  weightedCurrentAbility,
  type AbilityDimension
} from "./index.js";

export const MODEL_CONFIG_VERSION = "rai-model-config-v12" as const;

export interface RaiModelConfig {
  baselineReferenceStartAt?: string;
  calibrationMinimumSessions: number;
  calibrationMinimumSpanDays: number;
  minimumAvailableWeight: number;
  /**
   * Legacy display threshold: drives the `low_confidence_no_true_ability_update`
   * explanation only. It is deliberately NOT the learning gate any more — since
   * v7 that is `minimumEvidenceReliabilityForLearning`, which is a different
   * number on a different scale (§6.7).
   */
  minimumConfidenceForTrueAbility: number;
  /**
   * §6.6: the share of configured dimension weight a workout must actually have
   * scored before it may move true ability. `1` means every configured dimension
   * has to be present. A workout below the threshold still produces a display
   * estimate, but produces no learning — missing evidence must not be learned as
   * decline.
   */
  minimumLearningCoverage: number;
  /** §6.7 weights of the reliability geometric mean; must be positive and sum to 1. */
  confidenceWeights: ConfidenceWeightsV2;
  /** §6.9 learning gate: rule-based evidence reliability, never `overall`. */
  minimumEvidenceReliabilityForLearning: number;
  /**
   * §6.9 learning gate applied to the §6.2 comparability value. Strata that are not
   * comparable, and `recovery_unknown` (0.80), sit below it. A well-structured
   * interval is *above* it — the previous blanket rule held every interval
   * incomparable to every other interval.
   */
  minimumComparabilityForLearning: number;
  /**
   * §6.2: which strata exist, how much independent history a stratum needs before it
   * is comparable at all, and the explicit refusal to widen a sparse bucket.
   */
  comparabilityPolicy: ComparabilityPolicy;
  /**
   * The bounded candidate must pass coverage/regression gates before promotion.
   * Local replay currently has zero learning updates under it; keep the incumbent
   * history policy explicit rather than silently activating a frozen estimator.
   */
  comparabilityHistoryMode: "legacy" | "bounded";
  /**
   * §6.9: how many *consecutive* qualified negative residuals are required before
   * true ability may fall. A single bad day is not evidence of decline. A race or
   * protocol test bypasses the count — it is a deliberate maximal effort rather
   * than one more training data point.
   */
  negativeConfirmationCount: number;
  dimensionScoreZScale: number;
  dimensionWeights: Record<AbilityDimension, number>;
}

export const defaultRaiModelConfig: RaiModelConfig = {
  calibrationMinimumSessions: 6,
  calibrationMinimumSpanDays: 14,
  minimumAvailableWeight: 0.65,
  minimumConfidenceForTrueAbility: 0.6,
  minimumLearningCoverage: 1,
  confidenceWeights: { data: 0.6, comparability: 0.25, maturity: 0.15 },
  minimumEvidenceReliabilityForLearning: 0.75,
  minimumComparabilityForLearning: 0.9,
  comparabilityPolicy: {
    allowedStrata: ["steady_aerobic", "threshold_sustained", "race_protocol", "interval", "recovery_unknown"],
    maximumStrata: 5,
    // Same starting point as the calibration requirement: a compatibility baseline,
    // not a claim that six sessions are statistically sufficient.
    minimumIndependentSessions: 6,
    minimumSpanDays: 14,
    allowCrossStratumFallback: false,
    insufficientPolicy: "not_comparable"
  },
  comparabilityHistoryMode: "legacy",
  negativeConfirmationCount: 2,
  // The observed Cardio proxy is duration multiplied by speed, which is chiefly distance.
  // Preserve it as a diagnostic score, but exclude it from CA until a valid aerobic signal exists.
  dimensionScoreZScale: 10,
  dimensionWeights: {
    // V2-A control group: recovery leaves CA entirely, and the remaining weights
    // are renormalised by their own sum (0.375 / 0.3125 / 0.1875 over 0.875 =
    // 3/7, 5/14, 3/14). The literals are unchanged — the zero is what makes the
    // separation structural, because `scoreFeature` already drops zero-weight
    // dimensions from `available`.
    efficiency: 0.375,
    pace: 0.3125,
    cardio: 0,
    stability: 0.1875,
    recovery: 0
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
  /**
   * The display estimate: the observed score shrunk toward 50 in proportion to
   * how much of the configured evidence the workout actually carried (§6.5).
   */
  currentAbility: number | null;
  /**
   * The learning target: the *unshrunk* estimate, and null when the workout is
   * below `minimumLearningCoverage` (§6.6). Keeping the two apart is what stops
   * "we did not see every dimension" from being learned as a decline.
   */
  learningObservation: number | null;
  /** Share of the configured dimension weight this workout actually scored. */
  dimensionCoverage: number;
  dimensions: AbilityDimensionScores;
  effectiveWeights: Partial<Record<AbilityDimension, number>>;
  confidence: number;
  confidenceFactors: ContractConfidenceFactors;
  /**
   * §6.7 rule-based reliability. This — not `confidence`, which is the legacy
   * four-factor aggregate kept for continuity of the persisted payload — is what
   * the learning gate reads.
   */
  confidenceV2: ConfidenceV2;
  /**
   * True for a race or standardised time trial. A maximal effort is evidence in its
   * own right, so it confirms a decline immediately instead of waiting for the
   * consecutive-negative count (§6.9).
   */
  protocolTest: boolean;
  /** §6.2 stratum this workout is compared within. */
  stratum: SessionStratum;
  /** §6.2 whether that stratum has enough independent history to be comparable. */
  stratumComparability: StratumComparability;
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
  if (config.baselineReferenceStartAt !== undefined && !Number.isFinite(Date.parse(config.baselineReferenceStartAt))) throw new Error("Invalid baseline reference start");
  if (!["legacy", "bounded"].includes(config.comparabilityHistoryMode)) {
    throw new Error("Invalid comparability history mode");
  }
  const scalarEntries: Array<[string, number]> = [
    ["calibrationMinimumSessions", config.calibrationMinimumSessions],
    ["calibrationMinimumSpanDays", config.calibrationMinimumSpanDays],
    ["minimumAvailableWeight", config.minimumAvailableWeight],
    ["minimumConfidenceForTrueAbility", config.minimumConfidenceForTrueAbility],
    ["minimumLearningCoverage", config.minimumLearningCoverage],
    ["minimumEvidenceReliabilityForLearning", config.minimumEvidenceReliabilityForLearning],
    ["minimumComparabilityForLearning", config.minimumComparabilityForLearning],
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
  if (config.minimumLearningCoverage < 0 || config.minimumLearningCoverage > 1) {
    throw new Error("minimumLearningCoverage must be between 0 and 1");
  }
  for (const [name, value] of [
    ["minimumEvidenceReliabilityForLearning", config.minimumEvidenceReliabilityForLearning],
    ["minimumComparabilityForLearning", config.minimumComparabilityForLearning]
  ] as Array<[string, number]>) {
    if (value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
  }
  if (!Number.isInteger(config.negativeConfirmationCount) || config.negativeConfirmationCount < 1) {
    throw new Error("negativeConfirmationCount must be a positive integer");
  }
  const policy = config.comparabilityPolicy;
  if (!Number.isInteger(policy.maximumStrata) || policy.maximumStrata < 1) {
    throw new Error("comparabilityPolicy.maximumStrata must be a positive integer");
  }
  if (policy.allowedStrata.length > policy.maximumStrata) {
    // §6.2 asks for the ceiling to be enforced by the parser, not just documented.
    throw new Error(
      `comparabilityPolicy lists ${policy.allowedStrata.length} strata, above its own maximum of ${policy.maximumStrata}`
    );
  }
  if (new Set(policy.allowedStrata).size !== policy.allowedStrata.length) {
    throw new Error("comparabilityPolicy.allowedStrata must not repeat a stratum");
  }
  for (const stratum of policy.allowedStrata) {
    if (!SESSION_STRATA.includes(stratum)) {
      throw new Error(`comparabilityPolicy.allowedStrata contains an unknown stratum: ${stratum}`);
    }
  }
  // Typed as literals, so these can only be violated by untyped input arriving at
  // runtime; the casts are what let the check exist at all.
  if ((policy.allowCrossStratumFallback as boolean) !== false) {
    throw new Error("comparabilityPolicy.allowCrossStratumFallback must be false");
  }
  if ((policy.insufficientPolicy as string) !== "not_comparable") {
    throw new Error('comparabilityPolicy.insufficientPolicy must be "not_comparable"');
  }
  if (!Number.isInteger(policy.minimumIndependentSessions) || policy.minimumIndependentSessions < 1) {
    throw new Error("comparabilityPolicy.minimumIndependentSessions must be a positive integer");
  }
  if (!Number.isFinite(policy.minimumSpanDays) || policy.minimumSpanDays < 0) {
    throw new Error("comparabilityPolicy.minimumSpanDays must be non-negative");
  }
  // Validated here as well as inside `evaluateConfidenceV2`, so a bad weight cannot
  // survive as far as a model run.
  evaluateConfidenceV2({
    dataConfidence: 1,
    comparability: 1,
    maturity: 1,
    evidenceCoverage: 1,
    weights: config.confidenceWeights
  });
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
  /**
   * §6.2 independent history inside this workout's stratum, as of this workout.
   * Required on purpose: a caller that could omit it would silently reopen the
   * "compare a tempo run against a recovery jog" hole this phase closes.
   */
  stratumHistory: StratumHistory | null,
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
  const configuredWeight = names.reduce((sum, dimension) => sum + config.dimensionWeights[dimension], 0);
  // Share of the *configured* weight this workout actually scored. Normalised by
  // the configured total rather than assuming that total is 1 — V2-A deliberately
  // makes it 0.875, and a raw sum would then never reach full coverage.
  const dimensionCoverage = configuredWeight > 0 ? clamp(availableWeight / configuredWeight, 0, 1) : 0;
  const effectiveWeights = Object.fromEntries(
    available.map((item) => [
      item.dimension,
      availableWeight > 0 ? item.baseWeight / availableWeight : 0
    ])
  ) as Partial<Record<AbilityDimension, number>>;
  const coverage = clamp(feature.qualityScore, 0, 1);
  const stratum = sessionStratum(feature.sessionType);
  const stratumComparability = evaluateStratumComparability({
    stratum,
    history: stratumHistory,
    policy: config.comparabilityPolicy
  });
  // §6.2: comparability is derived from the stratum and its history, never from a
  // blanket "intervals are noisy" rule.
  const comparability = clamp(comparabilityValue(stratumComparability), 0, 1);
  const confidenceFactors: ContractConfidenceFactors = {
    coverage,
    source: feature.sourceConfidence,
    comparability,
    maturity: clamp(calibrationMaturity, 0, 1)
  };
  const confidence = confidenceScore(confidenceFactors);
  // §6.7: the reliability the learning gate reads. `dataConfidence` is the existing
  // qualityScore aggregate — it already folds in coverage and source, which is why
  // the legacy `source` factor gets no weight of its own here. `evidenceCoverage`
  // is passed through for the coverage policy and is not multiplied into E.
  const confidenceV2 = evaluateConfidenceV2({
    dataConfidence: coverage,
    comparability,
    maturity: confidenceFactors.maturity,
    evidenceCoverage: dimensionCoverage,
    weights: config.confidenceWeights
  });
  // A race or protocol test is a deliberate maximal effort, not one more training
  // data point, so it does not need the consecutive-negative count behind it.
  const protocolTest = feature.sessionType === "race";
  const explanations: AbilityExplanationCode[] = [];

  if (feature.eligibilityStatus === "excluded") {
    explanations.push(feature.missingReasons.includes("user_excluded") ? "user_excluded" : "data_insufficient");
    return {
      status: "excluded",
      currentAbility: null,
      learningObservation: null,
      dimensionCoverage,
      dimensions,
      effectiveWeights,
      confidence,
      confidenceFactors,
      confidenceV2,
      protocolTest,
      stratum,
      stratumComparability,
      workoutContribution: null,
      evidenceStrength: null,
      explanationCodes: explanations
    };
  }
  if (dimensionCoverage < config.minimumAvailableWeight || (dimensions.efficiency === null && dimensions.pace === null)) {
    explanations.push("data_insufficient");
    return {
      status: "trial",
      currentAbility: null,
      learningObservation: null,
      dimensionCoverage,
      dimensions,
      effectiveWeights,
      confidence,
      confidenceFactors,
      confidenceV2,
      protocolTest,
      stratum,
      stratumComparability,
      workoutContribution: null,
      evidenceStrength: null,
      explanationCodes: explanations
    };
  }

  const observedAbility = weightedCurrentAbility(available);
  // §6.5 display shrinkage. The safe claim, stated exactly: for a *fixed* observed
  // score, lower coverage means a smaller deviation from 50. It is NOT true that
  // removing a dimension always moves the total toward 50 — two dimensions at 0.5
  // each scoring 100 and 0 give 50, and dropping the 0 leaves a shrunk value of 75.
  const currentAbility = 50 + dimensionCoverage * (observedAbility - 50);
  // §6.6: learning reads the unshrunk estimate, and only when the evidence is
  // complete enough for that reading to mean something.
  const learningObservation = dimensionCoverage >= config.minimumLearningCoverage ? observedAbility : null;
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
    learningObservation,
    dimensionCoverage,
    dimensions,
    effectiveWeights,
    confidence,
    confidenceFactors,
    confidenceV2,
    protocolTest,
    stratum,
    stratumComparability,
    workoutContribution: contribution,
    evidenceStrength: evidenceStrength(feature),
    explanationCodes: [...new Set(explanations)]
  };
}

/**
 * `ability_assessments.direction_factor` is still written, so the value an applied
 * step reports is the identity — §6.9's alpha composition has no direction factor.
 * Kept as named constants so "the factor is gone" is visible rather than implied by
 * a bare `1`.
 */
const DIRECTION_FACTOR_APPLIED = 1;
const DIRECTION_FACTOR_NOT_APPLIED = 0;

export function updateTrueAbilityFromFeatureScore(
  currentTrueAbility: number,
  eligibleWorkoutCount: number,
  score: FeatureScoreResult,
  config: RaiModelConfig = defaultRaiModelConfig,
  pendingNegativeConfirmations = 0
): {
  nextTrueAbility: number;
  directionFactor: number;
  growthResistance: number;
  updated: boolean;
  /**
   * Consecutive qualified negative residuals observed so far. The caller persists
   * this across assessments; true ability may only fall once it reaches
   * `negativeConfirmationCount`.
   */
  pendingNegativeConfirmations: number;
} {
  const reliability = score.confidenceV2.evidenceReliability;
  const comparability = score.confidenceV2.comparability;
  if (
    score.status !== "eligible" ||
    score.learningObservation === null ||
    score.evidenceStrength === null ||
    // §6.9 learning gate. It reads rule-based reliability, never `overall`, and it
    // is a different number on a different scale from the legacy display threshold
    // `minimumConfidenceForTrueAbility` used above.
    reliability === null ||
    reliability < config.minimumEvidenceReliabilityForLearning ||
    comparability === null ||
    comparability < config.minimumComparabilityForLearning
  ) {
    return {
      nextTrueAbility: currentTrueAbility,
      directionFactor: DIRECTION_FACTOR_NOT_APPLIED,
      growthResistance: 1,
      updated: false,
      // A workout we could not judge is not evidence of improvement, so it neither
      // advances nor breaks the run. Only an actual observation does.
      pendingNegativeConfirmations
    };
  }
  // The learning target, not the display estimate: a workout we could only partly
  // see must not be learned as a decline just because the display value was
  // shrunk toward 50 (§6.6).
  const negative = score.learningObservation < currentTrueAbility;
  const resistance = negative ? 1 : growthResistance(currentTrueAbility);
  // §6.9's alpha composition has no direction factor: the factor that used to halve a
  // negative step (0.4, and 0.25 when recovery was low) is gone. Negative learning is
  // now damped only by the confirmation count below, which asks whether the decline is
  // real instead of shrinking every single step. The returned value is kept because
  // `ability_assessments.direction_factor` still persists it — it is now the identity
  // on an applied step and zero on one that was not applied, so it carries no
  // information beyond `updated`. Removing the column needs a migration (Phase 5).
  if (negative && !score.protocolTest) {
    const confirmations = pendingNegativeConfirmations + 1;
    if (confirmations < config.negativeConfirmationCount) {
      // Recorded, not applied: one bad day is a day, not a decline. This is the
      // rule that stops a single recovery dip from rewriting long-term ability.
      return {
        nextTrueAbility: currentTrueAbility,
        directionFactor: DIRECTION_FACTOR_NOT_APPLIED,
        growthResistance: resistance,
        updated: false,
        pendingNegativeConfirmations: confirmations
      };
    }
  }

  const nextTrueAbility = updateTrueAbility({
    trueAbility: currentTrueAbility,
    currentAbility: score.learningObservation,
    eligibleWorkoutCount,
    evidenceReliability: reliability,
    evidenceStrength: score.evidenceStrength
  });
  return {
    nextTrueAbility,
    directionFactor: DIRECTION_FACTOR_APPLIED,
    growthResistance: resistance,
    updated: nextTrueAbility !== currentTrueAbility,
    // Applied, so the run starts over — including for a positive, which is evidence
    // that contradicts a decline.
    pendingNegativeConfirmations: 0
  };
}
