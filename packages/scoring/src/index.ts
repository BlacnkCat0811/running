import {
  COMPARABILITY_POLICY_VERSION,
  CONFIDENCE_AGGREGATION_POLICY_VERSION,
  type ComparabilityPolicy,
  type ConfidenceV2,
  type ConfidenceWeightsV2,
  type SessionStratum,
  type SessionType,
  type StratumComparability,
  type StratumHistory
} from "@rai/contracts";

export const SCORING_MODEL_VERSION = "rai-v2.0.0" as const;

export * from "./baseline-v2.js";

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
  /**
   * §6.7 rule-based evidence reliability. Named for what it is: the legacy
   * four-factor `confidence` is a different number on a different scale and is
   * never an input to learning.
   */
  evidenceReliability: number;
  evidenceStrength: number;
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

// -----------------------------------------------------------------------------
// Confidence V2 (§6.7).
// -----------------------------------------------------------------------------

export const DEFAULT_CONFIDENCE_WEIGHTS_V2: ConfidenceWeightsV2 = {
  data: 0.6,
  comparability: 0.25,
  maturity: 0.15
};

export interface ConfidenceV2Input {
  dataConfidence: number | null;
  comparability: number | null;
  maturity: number | null;
  evidenceCoverage: number;
  weights?: ConfidenceWeightsV2;
}

/**
 * Rule-based evidence reliability, kept strictly apart from any calibrated
 * `overall`.
 *
 * The three cases the design insists on distinguishing, because collapsing any
 * two of them hides a real situation:
 *
 * - a factor is **null** -> reliability is null and the status is
 *   `insufficient_evidence`. A missing factor is never renormalised away.
 * - a factor is exactly **0** -> reliability is 0 through an explicit branch (no
 *   `log(0)`), and the status is still `available`: zero reliability was
 *   *observed*, which is different from not having looked.
 * - a factor is non-finite or outside [0, 1] -> this throws. Clamping or
 *   defaulting here would turn a broken input into a plausible number.
 *
 * Both a null and a zero forbid learning; they are reported differently so the
 * diagnosis is not lost.
 */
export function evaluateConfidenceV2(input: ConfidenceV2Input): ConfidenceV2 {
  const weights = input.weights ?? DEFAULT_CONFIDENCE_WEIGHTS_V2;
  const weightEntries: Array<[string, number]> = [
    ["data", weights.data],
    ["comparability", weights.comparability],
    ["maturity", weights.maturity]
  ];
  for (const [name, value] of weightEntries) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Confidence weight ${name} must be finite and positive`);
    }
  }
  const weightSum = weightEntries.reduce((sum, [, value]) => sum + value, 0);
  if (Math.abs(weightSum - 1) > 1e-9) {
    throw new Error(`Confidence weights must sum to 1, got ${weightSum}`);
  }
  assertUnitInterval("evidenceCoverage", input.evidenceCoverage);

  const factors: Array<[string, number | null]> = [
    ["dataConfidence", input.dataConfidence],
    ["comparability", input.comparability],
    ["maturity", input.maturity]
  ];
  for (const [name, value] of factors) {
    if (value !== null) assertUnitInterval(name, value);
  }

  const missing = factors.filter(([, value]) => value === null);
  const zero = factors.filter(([, value]) => value === 0);
  const available = missing.length === 0;

  let evidenceReliability: number | null = null;
  if (available) {
    evidenceReliability =
      zero.length > 0
        ? 0
        : Math.exp(
            weights.data * Math.log(input.dataConfidence as number) +
              weights.comparability * Math.log(input.comparability as number) +
              weights.maturity * Math.log(input.maturity as number)
          );
  }

  return {
    dataConfidence: input.dataConfidence,
    comparability: input.comparability,
    maturity: input.maturity,
    evidenceCoverage: input.evidenceCoverage,
    evidenceReliability,
    evidenceStatus: available ? "available" : "insufficient_evidence",
    // No calibration artifact exists yet, so there is no calibrated figure to
    // report. `null` is the contract; it must not be filled with a default.
    modelConfidence: null,
    overall: null,
    overallStatus: available && zero.length === 0 ? "not_calibrated" : "insufficient_evidence",
    aggregationPolicyVersion: CONFIDENCE_AGGREGATION_POLICY_VERSION,
    calibrationArtifactId: null,
    calibrationTarget: null
  };
}

function assertUnitInterval(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number within [0, 1]`);
  }
}

// -----------------------------------------------------------------------------
// Session comparability strata (§6.2).
// -----------------------------------------------------------------------------

/**
 * Which reference distribution a workout belongs to. A tempo run and a recovery jog
 * are not two samples of one thing, and treating them as such turns "the plan
 * changed" into "the athlete declined".
 */
export function sessionStratum(sessionType: SessionType): SessionStratum {
  switch (sessionType) {
    case "easy":
    case "steady":
    case "long_run":
      return "steady_aerobic";
    case "tempo":
      return "threshold_sustained";
    case "race":
      return "race_protocol";
    case "interval":
      return "interval";
    case "recovery":
    case "unknown":
      return "recovery_unknown";
  }
}

/**
 * Comparability inside a stratum, once the stratum itself is comparable.
 *
 * `recovery_unknown` sits at 0.80 — below the 0.90 learning gate — because a
 * recovery jog or an unclassified session is displayable but is not strong evidence
 * about ability in either direction. `interval` sits at 0.95 rather than the old
 * blanket 0.75: within its own work/recovery structure an interval *is* comparable,
 * and the previous rule made every interval incomparable to every other interval.
 */
export const COMPARABILITY_BY_STRATUM: Record<SessionStratum, number> = {
  steady_aerobic: 1,
  threshold_sustained: 1,
  race_protocol: 1,
  interval: 0.95,
  recovery_unknown: 0.8
};

/** Below the 0.90 learning gate on purpose: an insufficient bucket never learns. */
export const COMPARABILITY_NOT_COMPARABLE = 0.75;

export interface StratumComparabilityInput {
  stratum: SessionStratum;
  /** `null` when the caller has not assessed history at all. */
  history: StratumHistory | null;
  policy: ComparabilityPolicy;
}

export function evaluateStratumComparability(input: StratumComparabilityInput): StratumComparability {
  const { stratum, history, policy } = input;
  if (history === null) {
    // "Not assessed" is not the same as "assessed and found insufficient", and the
    // two must not be reported as one: the first says nobody looked, the second says
    // we looked and there is not enough. Both are handled explicitly downstream.
    return {
      status: "not_assessed",
      stratum,
      independentSessions: null,
      spanDays: null,
      reasonCodes: ["history_not_assessed"]
    };
  }
  const reasonCodes: string[] = [];
  if (!policy.allowedStrata.includes(stratum)) reasonCodes.push("stratum_not_allowed");
  if (history.independentSessions < policy.minimumIndependentSessions) {
    reasonCodes.push("insufficient_independent_sessions");
  }
  if (history.spanDays < policy.minimumSpanDays) reasonCodes.push("insufficient_span_days");
  return {
    status: reasonCodes.length === 0 ? "comparable" : "not_comparable",
    stratum,
    independentSessions: history.independentSessions,
    spanDays: history.spanDays,
    reasonCodes
  };
}

/**
 * Comparability only ever *narrows*: an insufficient or unassessed bucket falls
 * below the learning gate, and a comparable one takes its stratum's own value.
 * There is deliberately no branch that widens a bucket to reach a sample count —
 * `allowCrossStratumFallback` is typed as `false` for the same reason.
 */
export function comparabilityValue(comparability: StratumComparability): number {
  if (comparability.status !== "comparable") return COMPARABILITY_NOT_COMPARABLE;
  return COMPARABILITY_BY_STRATUM[comparability.stratum];
}

export function comparabilityPolicyVersion(): typeof COMPARABILITY_POLICY_VERSION {
  return COMPARABILITY_POLICY_VERSION;
}

/**
 * Continuous learning rate (§6.8).
 *
 * The previous step function jumped at 10 and 30 eligible workouts, so one extra
 * session could move the step size by 50% with nothing about the athlete's
 * evidence changing. This decay has no discontinuity:
 * `alpha(N) = min + (max - min) * exp(-N / k)`.
 *
 * `N` is the number of eligible learning opportunities in this epoch. It must be
 * counted from the learning timeline, never from page refreshes or import counts.
 */
export const LEARNING_RATE_MAX = 0.15;
export const LEARNING_RATE_MIN = 0.04;
export const LEARNING_RATE_DECAY_WORKOUTS = 25;

export function baseLearningRate(eligibleWorkoutCount: number): number {
  const workouts = Number.isFinite(eligibleWorkoutCount) ? Math.max(0, eligibleWorkoutCount) : 0;
  return (
    LEARNING_RATE_MIN +
    (LEARNING_RATE_MAX - LEARNING_RATE_MIN) *
      Math.exp(-workouts / LEARNING_RATE_DECAY_WORKOUTS)
  );
}

export function growthResistance(trueAbility: number): number {
  return clamp(Math.pow((100 - clamp(trueAbility, 0, 100)) / 50, 1.5), 0.15, 1);
}

export function updateTrueAbility(input: TrueAbilityUpdateInput): number {
  const values = Object.entries(input);
  for (const [name, value] of values) assertFinite(name, value);

  const residual = clamp(input.currentAbility - input.trueAbility, -12, 12);
  const resistance = residual > 0 ? growthResistance(input.trueAbility) : 1;
  // §6.9: `alpha_eff = alpha(N) * evidenceReliability * evidenceStrength * growthResistance`.
  // There is deliberately no direction factor. Negative residual damping is done by the
  // K-consecutive confirmation gate in `updateTrueAbilityFromFeatureScore`, which tests
  // whether a decline is real; a further per-step discount would damp the same concern
  // twice, and §6.9 asks for one policy factor per change so the effect stays attributable.
  const effectiveAlpha =
    baseLearningRate(input.eligibleWorkoutCount) *
    clamp(input.evidenceReliability, 0, 1) *
    clamp(input.evidenceStrength, 0, 1) *
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
  assertFinite("trueAbilityAtLastEvent", trueAbilityAtLastEvent);
  assertFinite("daysSinceEligibleRun", daysSinceEligibleRun);
  const floor = trueAbilityAtLastEvent >= 20 ? 20 : 0;
  return Math.max(floor, trueAbilityAtLastEvent - inactivityDecay(daysSinceEligibleRun));
}

export * from "./model.js";

export * as legacyV1 from "./legacy-v1/index.js";
