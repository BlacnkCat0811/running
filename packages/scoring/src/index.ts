export const SCORING_MODEL_VERSION = "rai-v1.0.0-dev" as const;

export type AbilityDimension =
  | "efficiency"
  | "pace"
  | "cardio"
  | "stability"
  | "recovery";

export interface DimensionScore {
  dimension: AbilityDimension;
  score: number;
  baseWeight: number;
}

export interface ConfidenceFactors {
  coverage: number;
  source: number;
  comparability: number;
  maturity: number;
}

export interface TrueAbilityUpdateInput {
  trueAbility: number;
  currentAbility: number;
  eligibleWorkoutCount: number;
  confidence: number;
  evidenceStrength: number;
  directionFactor: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const assertFinite = (name: string, value: number): void => {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
};

export function weightedCurrentAbility(scores: DimensionScore[]): number {
  if (scores.length === 0) {
    throw new Error("At least one dimension score is required");
  }

  const totalWeight = scores.reduce((sum, item) => {
    assertFinite("dimension score", item.score);
    assertFinite("dimension weight", item.baseWeight);
    if (item.baseWeight < 0) {
      throw new Error("Dimension weights cannot be negative");
    }
    return sum + item.baseWeight;
  }, 0);

  if (totalWeight <= 0) {
    throw new Error("Available dimension weight must be positive");
  }

  return scores.reduce(
    (sum, item) => sum + clamp(item.score, 0, 100) * (item.baseWeight / totalWeight),
    0
  );
}

export function confidenceScore(factors: ConfidenceFactors): number {
  const weightedFactors: ReadonlyArray<[number, number]> = [
    [factors.coverage, 0.35],
    [factors.source, 0.25],
    [factors.comparability, 0.25],
    [factors.maturity, 0.15]
  ];

  const logScore = weightedFactors.reduce((sum, [value, weight]) => {
    assertFinite("confidence factor", value);
    return sum + weight * Math.log(clamp(value, Number.EPSILON, 1));
  }, 0);

  return Math.exp(logScore);
}

export function baseLearningRate(eligibleWorkoutCount: number): number {
  if (eligibleWorkoutCount <= 10) return 0.15;
  if (eligibleWorkoutCount <= 30) return 0.1;
  return 0.06;
}

export function growthResistance(trueAbility: number): number {
  return clamp(Math.pow((100 - clamp(trueAbility, 0, 100)) / 50, 1.5), 0.15, 1);
}

export function updateTrueAbility(input: TrueAbilityUpdateInput): number {
  const values = Object.entries(input);
  for (const [name, value] of values) assertFinite(name, value);

  const residual = clamp(input.currentAbility - input.trueAbility, -12, 12);
  const resistance = residual > 0 ? growthResistance(input.trueAbility) : 1;
  const effectiveAlpha =
    baseLearningRate(input.eligibleWorkoutCount) *
    clamp(input.confidence, 0, 1) *
    clamp(input.evidenceStrength, 0, 1) *
    clamp(input.directionFactor, 0, 1) *
    resistance;

  return clamp(input.trueAbility + effectiveAlpha * residual, 0, 100);
}

export function inactivityDecay(daysSinceEligibleRun: number): number {
  const days = Math.max(0, Math.floor(daysSinceEligibleRun));
  return (
    0.03 * clamp(days - 14, 0, 16) +
    0.05 * clamp(days - 30, 0, 30) +
    0.07 * Math.max(days - 60, 0)
  );
}

export function trueAbilityAfterInactivity(
  trueAbilityAtLastEvent: number,
  daysSinceEligibleRun: number
): number {
  return Math.max(20, trueAbilityAtLastEvent - inactivityDecay(daysSinceEligibleRun));
}

export * from "./model.js";
