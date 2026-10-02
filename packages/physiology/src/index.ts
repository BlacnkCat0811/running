import {
  ENVIRONMENT_VIEW_POLICY_VERSION,
  PHYSIOLOGY_PREDICTION_SCHEMA_VERSION,
  assertPhysiologyPredictionSnapshot,
  raceDistanceMeters,
  type LactateThresholdEstimate,
  type PhysiologyEvidenceCode,
  type PhysiologyPredictionSnapshot,
  type PerformanceVdotEstimate,
  type PredictionConfidenceLevel,
  type RaceDistance,
  type RacePredictionError,
  type RacePredictionMetrics,
  type RaceTimePrediction,
  type Vo2MaxEstimate,
  type WorkoutEnvironmentView
} from "@rai/contracts";

export const PHYSIOLOGY_MODEL_VERSION = "rai-physiology-v1.8.0" as const;

export type Vo2EvidenceSource =
  | "apple_health"
  | "race"
  | "standard_test"
  | "time_trial"
  | "hard_workout";

export interface Vo2MaxEvidence {
  id: string;
  observedAt: string;
  valueMlKgMin: number;
  source: Vo2EvidenceSource;
  quality: number;
}

export interface PerformanceObservation {
  id: string;
  observedAt: string;
  distanceMeters: number;
  durationSeconds: number;
  source: Exclude<Vo2EvidenceSource, "apple_health">;
  quality: number;
}

export type PerformanceVdotEvidenceSource =
  | "race"
  | "standard_test"
  | "time_trial"
  | "training_envelope";

export interface PerformanceVdotEvidence {
  id: string;
  observedAt: string;
  value: number;
  source: PerformanceVdotEvidenceSource;
  quality: number;
  conditionPenaltyFraction?: number;
}

export interface PhysiologyProfile {
  restingHeartRateBpm: number | null;
  observedMaximumHeartRateBpm: number | null;
}

export type LactateThresholdEvidenceSource =
  | "sustained_segment"
  | "threshold_test"
  | "race_segment";

export interface LactateThresholdEvidence {
  id: string;
  observedAt: string;
  paceSecondsPerKm: number;
  heartRateBpm: number | null;
  durationSeconds: number;
  source: LactateThresholdEvidenceSource;
  quality: number;
}

export interface PredictionReadiness {
  five_k?: number;
  ten_k?: number;
  half_marathon?: number;
}

export interface RacePredictionConditions {
  temperatureC?: number;
  humidityPercent?: number;
  recoveryReadiness?: number | null;
  elevationGainMeters?: Partial<Record<RaceDistance, number>>;
}

export interface PhysiologyConfig {
  evidenceHalfLifeDays: number;
  minimumVo2Max: number;
  maximumVo2Max: number;
  lactateThresholdDurationMinutes: number;
  lactateThresholdHeartRateReserveFraction: number;
  lactateThresholdHeartRateUncertaintyBpm: number;
  defaultRaceReadiness: Record<RaceDistance, number>;
  raceReadinessVdotPenalty: Record<RaceDistance, number>;
}

export interface PerformanceConditions {
  temperatureC?: number | null;
  humidityPercent?: number | null;
  elevationGainMeters?: number | null;
}

export const defaultPhysiologyConfig: PhysiologyConfig = {
  evidenceHalfLifeDays: 120,
  minimumVo2Max: 20,
  maximumVo2Max: 85,
  lactateThresholdDurationMinutes: 60,
  lactateThresholdHeartRateReserveFraction: 0.85,
  lactateThresholdHeartRateUncertaintyBpm: 5,
  defaultRaceReadiness: {
    five_k: 0.7,
    ten_k: 0.6,
    half_marathon: 0.45
  },
  raceReadinessVdotPenalty: {
    five_k: 3,
    ten_k: 4,
    half_marathon: 6
  }
};

const sourceWeight: Record<Vo2EvidenceSource, number> = {
  apple_health: 1,
  race: 1,
  standard_test: 0.95,
  time_trial: 0.85,
  hard_workout: 0.5
};

const sourceUncertainty: Record<Vo2EvidenceSource, number> = {
  apple_health: 3,
  race: 1.8,
  standard_test: 2,
  time_trial: 2.5,
  hard_workout: 4.5
};

const sourceEvidenceCode: Record<Vo2EvidenceSource, PhysiologyEvidenceCode> = {
  apple_health: "apple_health_vo2max",
  race: "race_performance",
  standard_test: "standard_test_performance",
  time_trial: "time_trial_performance",
  hard_workout: "hard_workout_performance"
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

function confidenceLevel(confidence: number): PredictionConfidenceLevel {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.55) return "moderate";
  return "low";
}

function weightedMedian(items: Array<{ value: number; weight: number }>): number {
  const sorted = [...items].sort((left, right) => left.value - right.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= total / 2) return item.value;
  }
  return sorted.at(-1)?.value ?? 0;
}

function daysBetween(earlier: string, later: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / 86_400_000;
}

export function danielsFractionOfVo2Max(durationMinutes: number): number {
  assertPositiveFinite("durationMinutes", durationMinutes);
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * durationMinutes) +
    0.2989558 * Math.exp(-0.1932605 * durationMinutes)
  );
}

export function oxygenCostAtVelocity(velocityMetersPerMinute: number): number {
  assertPositiveFinite("velocityMetersPerMinute", velocityMetersPerMinute);
  const oxygenCost = (
    -4.6 +
    0.182258 * velocityMetersPerMinute +
    0.000104 * velocityMetersPerMinute ** 2
  );
  if (oxygenCost <= 0) throw new Error("velocityMetersPerMinute is outside the Daniels running domain");
  return oxygenCost;
}

export function velocityAtOxygenCost(oxygenCostMlKgMin: number): number {
  assertPositiveFinite("oxygenCostMlKgMin", oxygenCostMlKgMin);
  const a = 0.000104;
  const b = 0.182258;
  const c = -4.6 - oxygenCostMlKgMin;
  const discriminant = b ** 2 - 4 * a * c;
  if (discriminant <= 0) throw new Error("Oxygen cost does not yield a running velocity");
  return (-b + Math.sqrt(discriminant)) / (2 * a);
}

export function vdotFromPerformance(
  distanceMeters: number,
  durationSeconds: number
): number {
  assertPositiveFinite("distanceMeters", distanceMeters);
  assertPositiveFinite("durationSeconds", durationSeconds);
  const durationMinutes = durationSeconds / 60;
  const velocityMetersPerMinute = distanceMeters / durationMinutes;
  return oxygenCostAtVelocity(velocityMetersPerMinute) /
    danielsFractionOfVo2Max(durationMinutes);
}

export function heatHumidityPenaltyFraction(
  temperatureC: number | null | undefined,
  humidityPercent: number | null | undefined
): number {
  if (temperatureC === null || temperatureC === undefined || !Number.isFinite(temperatureC)) {
    return 0;
  }
  const humidity = humidityPercent === null || humidityPercent === undefined ||
    !Number.isFinite(humidityPercent)
    ? 50
    : clamp(humidityPercent, 0, 100);
  const heat = Math.max(0, temperatureC - 15) * 0.0025 *
    (1 + Math.max(0, humidity - 50) / 100);
  const cold = Math.max(0, 5 - temperatureC) * 0.001;
  return clamp(heat + cold, 0, 0.15);
}

export function elevationPenaltyFraction(
  distanceMeters: number,
  elevationGainMeters: number | null | undefined
): number {
  assertPositiveFinite("distanceMeters", distanceMeters);
  if (
    elevationGainMeters === null ||
    elevationGainMeters === undefined ||
    !Number.isFinite(elevationGainMeters) ||
    elevationGainMeters <= 0
  ) {
    return 0;
  }
  const metersPerKilometer = elevationGainMeters / (distanceMeters / 1_000);
  return clamp(metersPerKilometer * 0.00035, 0, 0.1);
}

export function performanceConditionPenaltyFraction(
  distanceMeters: number,
  conditions: PerformanceConditions
): { environment: number; elevation: number; total: number } {
  const environment = heatHumidityPenaltyFraction(
    conditions.temperatureC,
    conditions.humidityPercent
  );
  const elevation = elevationPenaltyFraction(
    distanceMeters,
    conditions.elevationGainMeters
  );
  return {
    environment,
    elevation,
    total: clamp(environment + elevation, 0, 0.2)
  };
}

// -----------------------------------------------------------------------------
// Grade-adjusted pace (docs/ALGORITHM.md §5) — display-only.
//
// This is a *different object* from the two §5.5 ledger sites: it re-expresses a
// measured pace at a reference gradient, it does not de-bias historical evidence
// or compensate a future scenario. It therefore must not be wired into
// `performanceVdotEvidence` or `predictRaceTimes` without registering a ledger
// site — doing both would be exactly the "same field corrected twice" that
// `validateConditionLedger` exists to refuse.
// -----------------------------------------------------------------------------

export const GRADE_ADJUSTMENT_POLICY_VERSION = "rai-grade-adjustment-v1" as const;

/**
 * The Minetti polynomial is defined on |i| ≤ 0.45 (24°). Beyond that a
 * fifth-order fit is extrapolation, so callers clamp and say so instead.
 */
export const MAXIMUM_GRADE_FRACTION = 0.45;

/**
 * Energy cost of running as a function of gradient, after Minetti et al. (2002),
 * J Appl Physiol 93:1039-46:
 *
 *   Cr(i) = 155.4i⁵ − 30.86i⁴ − 43.3i³ + 46.3i² + 19.5i + 3.6   [J·kg⁻¹·m⁻¹]
 *
 * A published cost model, not a fit to this athlete's labels — which is why it may
 * be shown without a calibration artifact, and also why it may never be presented
 * as a measurement.
 */
export function gradeCostJoulesPerKgMeter(gradeFraction: number): number {
  assertFinite("gradeFraction", gradeFraction);
  const grade = clamp(gradeFraction, -MAXIMUM_GRADE_FRACTION, MAXIMUM_GRADE_FRACTION);
  return (
    155.4 * grade ** 5 -
    30.86 * grade ** 4 -
    43.3 * grade ** 3 +
    46.3 * grade ** 2 +
    19.5 * grade +
    3.6
  );
}

export interface GradeAdjustedPace {
  paceSecondsPerKm: number;
  reasonCodes: string[];
}

/**
 * Flat-equivalent pace for a measured pace at `gradePercent`.
 *
 * Uphill costs more per metre, so the equivalent *flat* pace is faster (a smaller
 * seconds-per-km number); downhill is the reverse. The ratio is
 * `Cr(0) / Cr(i)`, i.e. the cost of running flat over the cost actually paid.
 */
export function gradeAdjustedPace(
  paceSecondsPerKm: number,
  gradePercent: number
): GradeAdjustedPace {
  assertPositiveFinite("paceSecondsPerKm", paceSecondsPerKm);
  assertFinite("gradePercent", gradePercent);
  const grade = gradePercent / 100;
  const clamped = Math.abs(grade) > MAXIMUM_GRADE_FRACTION;
  const cost = gradeCostJoulesPerKgMeter(grade);
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error("grade cost ratio must be a positive finite number");
  }
  return {
    paceSecondsPerKm: paceSecondsPerKm * (gradeCostJoulesPerKgMeter(0) / cost),
    reasonCodes: clamped ? ["grade_clamped_to_cost_model_domain"] : []
  };
}

export function performanceSecondsFromVdot(
  distanceMeters: number,
  vdot: number
): number {
  assertPositiveFinite("distanceMeters", distanceMeters);
  assertPositiveFinite("vdot", vdot);
  let lowerSeconds = Math.max(120, distanceMeters / 12);
  let upperSeconds = Math.max(lowerSeconds + 60, distanceMeters / 0.5);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const midpoint = (lowerSeconds + upperSeconds) / 2;
    const requiredVdot = vdotFromPerformance(distanceMeters, midpoint);
    if (requiredVdot > vdot) lowerSeconds = midpoint;
    else upperSeconds = midpoint;
  }
  return (lowerSeconds + upperSeconds) / 2;
}

export function performanceEvidence(
  observation: PerformanceObservation
): Vo2MaxEvidence {
  return {
    id: observation.id,
    observedAt: observation.observedAt,
    valueMlKgMin: vdotFromPerformance(
      observation.distanceMeters,
      observation.durationSeconds
    ),
    source: observation.source,
    quality: observation.quality
  };
}

export function performanceVdotEvidence(input: {
  id: string;
  observedAt: string;
  distanceMeters: number;
  durationSeconds: number;
  source: PerformanceVdotEvidenceSource;
  quality: number;
  conditions?: PerformanceConditions;
}): PerformanceVdotEvidence {
  const normalized = createPhysiologyNormalizationAdapter().normalize({distanceMeters:input.distanceMeters,
    durationSeconds:input.durationSeconds,conditions:input.conditions??{}});
  const penalty = {total:normalized.legacyPartialPenalty};
  return {
    id: input.id,
    observedAt: input.observedAt,
    value: vdotFromPerformance(
      input.distanceMeters,
      input.durationSeconds / (1 + penalty.total)
    ),
    source: input.source,
    quality: input.quality,
    conditionPenaltyFraction: penalty.total
  };
}

function unavailableVo2Max(codes: PhysiologyEvidenceCode[]): Vo2MaxEstimate {
  return {
    status: "insufficient_data",
    valueMlKgMin: null,
    rangeMlKgMin: null,
    confidence: 0,
    confidenceLevel: "low",
    evidenceCount: 0,
    latestEvidenceAt: null,
    method: "robust_evidence_ensemble_v1",
    evidenceCodes: codes
  };
}

export function estimateVo2Max(
  evidence: Vo2MaxEvidence[],
  asOf: string,
  config: PhysiologyConfig = defaultPhysiologyConfig
): Vo2MaxEstimate {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error("asOf must be an ISO date");
  const codes = new Set<PhysiologyEvidenceCode>();
  const usable = evidence.flatMap((item) => {
    const ageDays = daysBetween(item.observedAt, asOf);
    if (!Number.isFinite(ageDays) || ageDays < 0) {
      codes.add("future_evidence_excluded");
      return [];
    }
    if (
      !Number.isFinite(item.valueMlKgMin) ||
      item.valueMlKgMin < config.minimumVo2Max ||
      item.valueMlKgMin > config.maximumVo2Max ||
      !Number.isFinite(item.quality) ||
      item.quality <= 0
    ) {
      return [];
    }
    codes.add(sourceEvidenceCode[item.source]);
    const recency = Math.pow(0.5, ageDays / config.evidenceHalfLifeDays);
    const weight = clamp(item.quality, 0, 1) * sourceWeight[item.source] * recency;
    return [{ ...item, ageDays, weight }];
  });
  if (usable.length === 0) return unavailableVo2Max([...codes]);

  const center = weightedMedian(usable.map((item) => ({ value: item.valueMlKgMin, weight: item.weight })));
  const clipRadius = Math.max(3, center * 0.12);
  const weighted = usable.map((item) => ({
    ...item,
    clippedValue: clamp(item.valueMlKgMin, center - clipRadius, center + clipRadius)
  }));
  const weightSum = weighted.reduce((sum, item) => sum + item.weight, 0);
  const value = weighted.reduce((sum, item) => sum + item.clippedValue * item.weight, 0) / weightSum;
  const betweenVariance = weighted.reduce(
    (sum, item) => sum + item.weight * (item.clippedValue - value) ** 2,
    0
  ) / weightSum;
  const averageMeasurementUncertainty = weighted.reduce(
    (sum, item) => sum + item.weight * sourceUncertainty[item.source],
    0
  ) / weightSum;
  const sumSquaredWeights = weighted.reduce((sum, item) => sum + item.weight ** 2, 0);
  const effectiveCount = weightSum ** 2 / Math.max(sumSquaredWeights, Number.EPSILON);
  const systematicUncertaintyFloor = weighted.reduce(
    (sum, item) => sum + item.weight * sourceUncertainty[item.source],
    0
  ) / weightSum * 0.75;
  const uncertainty = Math.max(
    1.5,
    systematicUncertaintyFloor,
    Math.sqrt(betweenVariance),
    averageMeasurementUncertainty / Math.sqrt(Math.max(effectiveCount, 1))
  );
  if (Math.sqrt(betweenVariance) >= 3.5) codes.add("evidence_disagreement");
  const uniqueSourceCount = new Set(weighted.map((item) => item.source)).size;
  if (uniqueSourceCount === 1) codes.add("single_source_only");
  const maturity = 1 - Math.exp(-weightSum / 3);
  const agreement = Math.exp(-Math.sqrt(betweenVariance) / 8);
  const averageQuality = weighted.reduce(
    (sum, item) => sum + item.weight * clamp(item.quality, 0, 1),
    0
  ) / weightSum;
  const unboundedConfidence = maturity * agreement * averageQuality;
  const confidence = clamp(
    uniqueSourceCount === 1 ? Math.min(unboundedConfidence, 0.78) : unboundedConfidence,
    0,
    0.98
  );
  const latestEvidenceAt = weighted
    .map((item) => item.observedAt)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  if (latestEvidenceAt !== null && daysBetween(latestEvidenceAt, asOf) > 180) {
    codes.add("stale_evidence");
  }
  return {
    status: "available",
    valueMlKgMin: value,
    rangeMlKgMin: {
      lower: clamp(value - uncertainty, config.minimumVo2Max, config.maximumVo2Max),
      upper: clamp(value + uncertainty, config.minimumVo2Max, config.maximumVo2Max)
    },
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    evidenceCount: usable.length,
    latestEvidenceAt,
    method: "robust_evidence_ensemble_v1",
    evidenceCodes: [...codes]
  };
}

const performanceSourceWeight: Record<PerformanceVdotEvidenceSource, number> = {
  race: 1,
  standard_test: 0.95,
  time_trial: 0.85,
  training_envelope: 0.5
};

const performanceSourceCode: Record<
  PerformanceVdotEvidenceSource,
  PhysiologyEvidenceCode
> = {
  race: "race_performance",
  standard_test: "standard_test_performance",
  time_trial: "time_trial_performance",
  training_envelope: "training_performance_envelope"
};

export function estimatePerformanceVdot(
  vo2Max: Vo2MaxEstimate,
  evidence: PerformanceVdotEvidence[],
  asOf: string,
  config: PhysiologyConfig = defaultPhysiologyConfig
): PerformanceVdotEstimate {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error("asOf must be an ISO date");
  const codes = new Set<PhysiologyEvidenceCode>();
  const candidates = evidence.flatMap((item) => {
    const ageDays = daysBetween(item.observedAt, asOf);
    if (!Number.isFinite(ageDays) || ageDays < 0) {
      codes.add("future_evidence_excluded");
      return [];
    }
    if (
      !Number.isFinite(item.value) ||
      item.value < config.minimumVo2Max ||
      item.value > config.maximumVo2Max ||
      !Number.isFinite(item.quality) ||
      item.quality <= 0
    ) {
      return [];
    }
    const recency = Math.pow(0.5, ageDays / config.evidenceHalfLifeDays);
    return [{ ...item, weight: clamp(item.quality, 0, 1) * performanceSourceWeight[item.source] * recency }];
  });
  const labeled = candidates.filter((item) => item.source !== "training_envelope");
  const training = candidates
    .filter((item) => item.source === "training_envelope")
    .sort((left, right) => right.value - left.value);
  const envelopeCount = training.length === 0
    ? 0
    : Math.max(1, Math.min(6, Math.ceil(training.length * 0.15)));
  const selected = [...labeled, ...training.slice(0, envelopeCount)];
  for (const item of selected) codes.add(performanceSourceCode[item.source]);
  if (selected.some((item) => (item.conditionPenaltyFraction ?? 0) > 0)) {
    codes.add("performance_environment_normalized");
  }

  const values = selected.map((item) => ({ value: item.value, weight: item.weight }));
  if (vo2Max.status === "available" && vo2Max.valueMlKgMin !== null) {
    values.push({
      value: Math.max(config.minimumVo2Max, vo2Max.valueMlKgMin - 1.5),
      weight: 0.45 * Math.max(vo2Max.confidence, 0.25)
    });
    codes.add("vo2_upper_prior");
  }
  if (values.length === 0) {
    codes.add("performance_evidence_missing");
    return {
      status: "insufficient_data",
      value: null,
      range: null,
      confidence: 0,
      confidenceLevel: "low",
      evidenceCount: 0,
      latestEvidenceAt: null,
      method: "performance_envelope_v1",
      evidenceCodes: [...codes]
    };
  }
  if (selected.length === 0) codes.add("performance_evidence_missing");
  const estimate = robustWeightedValue(values, 0.16);
  let value = estimate.value;
  if (vo2Max.status === "available" && vo2Max.rangeMlKgMin !== null) {
    value = Math.min(value, vo2Max.rangeMlKgMin.upper + 0.5);
  }
  if (
    vo2Max.status === "available" &&
    vo2Max.valueMlKgMin !== null &&
    Math.abs(vo2Max.valueMlKgMin - value) >= 4
  ) {
    codes.add("performance_vo2_gap");
  }
  const hasLabeled = labeled.length > 0;
  const evidenceWeight = selected.reduce((sum, item) => sum + item.weight, 0);
  const baseConfidence =
    0.3 * vo2Max.confidence +
    0.55 * (1 - Math.exp(-evidenceWeight / 1.5)) +
    (hasLabeled ? 0.1 : 0);
  const confidence = clamp(
    hasLabeled ? Math.min(baseConfidence, 0.92) : Math.min(baseConfidence, 0.72),
    0,
    0.92
  );
  const uncertainty = Math.max(
    hasLabeled ? 1.4 : 2.25,
    estimate.spread * 1.25,
    vo2Max.rangeMlKgMin === null
      ? 0
      : (vo2Max.rangeMlKgMin.upper - vo2Max.rangeMlKgMin.lower) / 3
  );
  const latestEvidenceAt = selected
    .map((item) => item.observedAt)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? vo2Max.latestEvidenceAt;
  return {
    status: "available",
    value,
    range: {
      lower: clamp(value - uncertainty, config.minimumVo2Max, config.maximumVo2Max),
      upper: clamp(value + uncertainty, config.minimumVo2Max, config.maximumVo2Max)
    },
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    evidenceCount: selected.length + (vo2Max.status === "available" ? 1 : 0),
    latestEvidenceAt,
    method: "performance_envelope_v1",
    evidenceCodes: [...codes]
  };
}

function thresholdPaceSecondsPerKm(vdot: number, durationMinutes: number): number {
  const oxygenCost = vdot * danielsFractionOfVo2Max(durationMinutes);
  const velocityMetersPerMinute = velocityAtOxygenCost(oxygenCost);
  return (1_000 / velocityMetersPerMinute) * 60;
}

export function estimateLactateThreshold(
  vo2Max: Vo2MaxEstimate,
  profile: PhysiologyProfile,
  config: PhysiologyConfig = defaultPhysiologyConfig
): LactateThresholdEstimate {
  if (vo2Max.status !== "available" || vo2Max.valueMlKgMin === null) {
    return {
      status: "insufficient_data",
      paceSecondsPerKm: null,
      paceRangeSecondsPerKm: null,
      heartRateBpm: null,
      heartRateRangeBpm: null,
      confidence: 0,
      confidenceLevel: "low",
      evidenceCount: 0,
      latestEvidenceAt: null,
      method: "vdot_one_hour_proxy_v1",
      evidenceCodes: []
    };
  }
  const codes = new Set<PhysiologyEvidenceCode>(["lactate_threshold_one_hour_proxy"]);
  const pace = thresholdPaceSecondsPerKm(
    vo2Max.valueMlKgMin,
    config.lactateThresholdDurationMinutes
  );
  const paceRange = vo2Max.rangeMlKgMin === null
    ? null
    : {
        lower: thresholdPaceSecondsPerKm(
          vo2Max.rangeMlKgMin.upper,
          config.lactateThresholdDurationMinutes
        ),
        upper: thresholdPaceSecondsPerKm(
          vo2Max.rangeMlKgMin.lower,
          config.lactateThresholdDurationMinutes
        )
      };
  let heartRateBpm: number | null = null;
  let heartRateRangeBpm: { lower: number; upper: number } | null = null;
  const resting = profile.restingHeartRateBpm;
  const maximum = profile.observedMaximumHeartRateBpm;
  if (
    resting !== null &&
    maximum !== null &&
    Number.isFinite(resting) &&
    Number.isFinite(maximum) &&
    maximum > resting
  ) {
    heartRateBpm = resting +
      config.lactateThresholdHeartRateReserveFraction * (maximum - resting);
    heartRateRangeBpm = {
      lower: Math.max(resting, heartRateBpm - config.lactateThresholdHeartRateUncertaintyBpm),
      upper: Math.min(maximum, heartRateBpm + config.lactateThresholdHeartRateUncertaintyBpm)
    };
    codes.add("lactate_threshold_hr_reserve_proxy");
  } else {
    codes.add("heart_rate_inputs_missing");
  }
  const confidence = clamp(vo2Max.confidence * (heartRateBpm === null ? 0.72 : 0.84), 0, 0.95);
  return {
    status: "available",
    paceSecondsPerKm: pace,
    paceRangeSecondsPerKm: paceRange,
    heartRateBpm,
    heartRateRangeBpm,
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    evidenceCount: 1,
    latestEvidenceAt: vo2Max.latestEvidenceAt,
    method: "vdot_one_hour_proxy_v1",
    evidenceCodes: [...codes]
  };
}

const thresholdSourceWeight: Record<LactateThresholdEvidenceSource, number> = {
  sustained_segment: 0.5,
  threshold_test: 1,
  race_segment: 0.9
};

const thresholdSourceCode: Record<
  LactateThresholdEvidenceSource,
  PhysiologyEvidenceCode
> = {
  sustained_segment: "sustained_threshold_segment",
  threshold_test: "threshold_test_segment",
  race_segment: "race_threshold_segment"
};

function robustWeightedValue(
  values: Array<{ value: number; weight: number }>,
  relativeClip: number
): { value: number; spread: number } {
  const center = weightedMedian(values);
  const clipped = values.map((item) => ({
    ...item,
    value: clamp(item.value, center * (1 - relativeClip), center * (1 + relativeClip))
  }));
  const weightSum = clipped.reduce((sum, item) => sum + item.weight, 0);
  const value = clipped.reduce((sum, item) => sum + item.value * item.weight, 0) / weightSum;
  const variance = clipped.reduce(
    (sum, item) => sum + item.weight * (item.value - value) ** 2,
    0
  ) / weightSum;
  return { value, spread: Math.sqrt(variance) };
}

export function estimateLactateThresholdFromEvidence(
  vo2Max: Vo2MaxEstimate,
  profile: PhysiologyProfile,
  evidence: LactateThresholdEvidence[],
  asOf: string,
  config: PhysiologyConfig = defaultPhysiologyConfig
): LactateThresholdEstimate {
  const prior = estimateLactateThreshold(vo2Max, profile, config);
  if (!Number.isFinite(Date.parse(asOf))) throw new Error("asOf must be an ISO date");
  const codes = new Set<PhysiologyEvidenceCode>(prior.evidenceCodes);
  const usable = evidence.flatMap((item) => {
    const ageDays = daysBetween(item.observedAt, asOf);
    if (!Number.isFinite(ageDays) || ageDays < 0) {
      codes.add("future_evidence_excluded");
      return [];
    }
    if (
      !Number.isFinite(item.paceSecondsPerKm) ||
      item.paceSecondsPerKm < 150 ||
      item.paceSecondsPerKm > 900 ||
      !Number.isFinite(item.durationSeconds) ||
      item.durationSeconds < 15 * 60 ||
      !Number.isFinite(item.quality) ||
      item.quality <= 0
    ) {
      return [];
    }
    codes.add(thresholdSourceCode[item.source]);
    const recency = Math.pow(0.5, ageDays / config.evidenceHalfLifeDays);
    return [{
      ...item,
      weight: clamp(item.quality, 0, 1) * thresholdSourceWeight[item.source] * recency
    }];
  });
  if (usable.length === 0) {
    codes.add("threshold_segments_missing");
    return { ...prior, evidenceCodes: [...codes] };
  }

  if (prior.status !== "available" || prior.paceSecondsPerKm === null) {
    // Without an aerobic prior only a deliberate, high-quality threshold test
    // may stand alone. Ordinary sustained training is not a threshold test.
    const observed = usable.filter((item) =>
      item.source === "threshold_test" && item.quality >= 0.8 && item.durationSeconds >= 20 * 60
    );
    if (!observed.length) return { ...prior, evidenceCodes: ["threshold_segments_missing"] };
    const pace = robustWeightedValue(observed.map((item) => ({
      value: item.paceSecondsPerKm, weight: item.weight
    })), 0.18);
    const hr = observed.filter((item) => item.heartRateBpm !== null &&
      Number.isFinite(item.heartRateBpm) && item.heartRateBpm >= 80 && item.heartRateBpm <= 230);
    const heart = hr.length ? robustWeightedValue(hr.map((item) => ({
      value: item.heartRateBpm!, weight: item.weight
    })), 0.12) : null;
    const weight = observed.reduce((sum, item) => sum + item.weight, 0);
    // Evidence reliability, not empirical diagnostic probability.
    const confidence = clamp(0.35 + 0.35 * (1 - Math.exp(-weight / 2)), 0, 0.7);
    return {
      status: "available",
      paceSecondsPerKm: pace.value,
      paceRangeSecondsPerKm: {
        lower: Math.max(150, pace.value - Math.max(8, pace.spread * 1.25)),
        upper: Math.min(900, pace.value + Math.max(8, pace.spread * 1.25))
      },
      heartRateBpm: heart?.value ?? null,
      heartRateRangeBpm: heart === null ? null : {
        lower: Math.max(80, heart.value - Math.max(4, heart.spread * 1.25)),
        upper: Math.min(230, heart.value + Math.max(4, heart.spread * 1.25))
      },
      confidence, confidenceLevel: confidenceLevel(confidence),
      evidenceCount: observed.length,
      latestEvidenceAt: observed.map((item) => item.observedAt)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0]!,
      method: "observed_threshold_v3",
      evidenceCodes: ["threshold_test_segment",
        ...(heart === null ? ["heart_rate_inputs_missing" as const] : [])]
    };
  }

  const paceItems = [
    { value: prior.paceSecondsPerKm, weight: 0.8 * Math.max(prior.confidence, 0.25) },
    ...usable.map((item) => ({ value: item.paceSecondsPerKm, weight: item.weight }))
  ];
  const pace = robustWeightedValue(paceItems, 0.18);
  if (pace.spread / pace.value >= 0.08) codes.add("threshold_evidence_disagreement");
  const paceUncertainty = Math.max(
    8,
    pace.spread * 1.25,
    prior.paceRangeSecondsPerKm === null
      ? 0
      : (prior.paceRangeSecondsPerKm.upper - prior.paceRangeSecondsPerKm.lower) / 3
  );

  const hrItems = usable.flatMap((item) =>
    item.heartRateBpm === null ||
    !Number.isFinite(item.heartRateBpm) ||
    item.heartRateBpm < 80 ||
    item.heartRateBpm > 230
      ? []
      : [{ value: item.heartRateBpm, weight: item.weight }]
  );
  if (prior.heartRateBpm !== null) {
    hrItems.push({ value: prior.heartRateBpm, weight: 0.65 * Math.max(prior.confidence, 0.25) });
  }
  const heartRate = hrItems.length === 0 ? null : robustWeightedValue(hrItems, 0.12);
  const sourceDiversity = new Set(usable.map((item) => item.source)).size;
  const evidenceWeight = usable.reduce((sum, item) => sum + item.weight, 0);
  const confidence = clamp(
    prior.confidence * 0.55 +
      (1 - Math.exp(-evidenceWeight / 2)) * 0.35 +
      Math.min(sourceDiversity, 2) * 0.05 -
      (codes.has("threshold_evidence_disagreement") ? 0.12 : 0),
    0,
    0.93
  );
  const latestEvidenceAt = [...usable
    .map((item) => item.observedAt), prior.latestEvidenceAt]
    .filter((item): item is string => item !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? prior.latestEvidenceAt;
  return {
    status: "available",
    paceSecondsPerKm: pace.value,
    paceRangeSecondsPerKm: {
      lower: Math.max(150, pace.value - paceUncertainty),
      upper: Math.min(900, pace.value + paceUncertainty)
    },
    heartRateBpm: heartRate?.value ?? null,
    heartRateRangeBpm: heartRate === null
      ? null
      : {
          lower: Math.max(80, heartRate.value - Math.max(4, heartRate.spread * 1.25)),
          upper: Math.min(230, heartRate.value + Math.max(4, heartRate.spread * 1.25))
        },
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    evidenceCount: usable.length + 1,
    latestEvidenceAt,
    method: "multi_evidence_threshold_v2",
    evidenceCodes: [...codes]
  };
}

function performanceVdotAsAerobicEstimate(
  estimate: PerformanceVdotEstimate
): Vo2MaxEstimate {
  return {
    status: estimate.status,
    valueMlKgMin: estimate.value,
    rangeMlKgMin: estimate.range,
    confidence: estimate.confidence,
    confidenceLevel: estimate.confidenceLevel,
    evidenceCount: estimate.evidenceCount,
    latestEvidenceAt: estimate.latestEvidenceAt,
    method: "robust_evidence_ensemble_v1",
    evidenceCodes: estimate.evidenceCodes
  };
}

export function estimateLactateThresholdFromPerformanceVdot(
  performanceVdot: PerformanceVdotEstimate,
  profile: PhysiologyProfile,
  evidence: LactateThresholdEvidence[],
  asOf: string,
  config: PhysiologyConfig = defaultPhysiologyConfig
): LactateThresholdEstimate {
  return estimateLactateThresholdFromEvidence(
    performanceVdotAsAerobicEstimate(performanceVdot),
    profile,
    evidence,
    asOf,
    config
  );
}

export function predictRaceTimes(
  vo2Max: Vo2MaxEstimate,
  readiness: PredictionReadiness = {},
  config: PhysiologyConfig = defaultPhysiologyConfig,
  conditions: RacePredictionConditions = {}
): RaceTimePrediction[] {
  return (Object.keys(raceDistanceMeters) as RaceDistance[]).map((distance) => {
    const distanceMeters = raceDistanceMeters[distance];
    const readinessValue = clamp(
      readiness[distance] ?? config.defaultRaceReadiness[distance],
      0,
      1
    );
    if (vo2Max.status !== "available" || vo2Max.valueMlKgMin === null) {
      return {
        distance,
        distanceMeters,
        status: "insufficient_data",
        potentialSeconds: null,
        predictedSeconds: null,
        readinessAdjustmentSeconds: null,
        environmentAdjustmentSeconds: null,
        elevationAdjustmentSeconds: null,
        fatigueAdjustmentSeconds: null,
        calibrationAdjustmentSeconds: null,
        machineLearningAdjustmentSeconds: null,
        machineLearningFallbackReason: null,
        optimisticSeconds: null,
        pessimisticSeconds: null,
        readiness: readiness[distance] ?? null,
        confidence: 0,
        confidenceLevel: "low",
        method: "daniels_vdot_v1",
        evidenceCodes: []
      };
    }
    const potentialSeconds = performanceSecondsFromVdot(distanceMeters, vo2Max.valueMlKgMin);
    const readinessPenalty = (1 - readinessValue) * config.raceReadinessVdotPenalty[distance];
    const adjustedVdot = Math.max(config.minimumVo2Max, vo2Max.valueMlKgMin - readinessPenalty);
    const preparedSeconds = performanceSecondsFromVdot(distanceMeters, adjustedVdot);
    const environmentPenalty = heatHumidityPenaltyFraction(
      conditions.temperatureC,
      conditions.humidityPercent
    );
    const elevationPenalty = elevationPenaltyFraction(
      distanceMeters,
      conditions.elevationGainMeters?.[distance]
    );
    const recoveryReadiness = conditions.recoveryReadiness == null
      ? null
      : clamp(conditions.recoveryReadiness, 0, 1);
    const fatiguePenalty = recoveryReadiness === null ? 0 : (1 - recoveryReadiness) * 0.04;
    const environmentAdjustmentSeconds = preparedSeconds * environmentPenalty;
    const elevationAdjustmentSeconds = preparedSeconds * elevationPenalty;
    const fatigueAdjustmentSeconds = preparedSeconds * fatiguePenalty;
    const predictedSeconds = preparedSeconds +
      environmentAdjustmentSeconds +
      elevationAdjustmentSeconds +
      fatigueAdjustmentSeconds;
    const totalConditionPenalty = environmentPenalty + elevationPenalty + fatiguePenalty;
    const optimisticSeconds = vo2Max.rangeMlKgMin === null
      ? null
      : performanceSecondsFromVdot(
          distanceMeters,
          Math.max(
            config.minimumVo2Max,
            vo2Max.rangeMlKgMin.upper - readinessPenalty * 0.5
          )
        ) * (1 + totalConditionPenalty * 0.6);
    const pessimisticSeconds = vo2Max.rangeMlKgMin === null
      ? null
      : performanceSecondsFromVdot(
          distanceMeters,
          Math.max(
            config.minimumVo2Max,
            vo2Max.rangeMlKgMin.lower - readinessPenalty * 1.25
          )
        ) * (1 + totalConditionPenalty * 1.4);
    const evidenceCodes: PhysiologyEvidenceCode[] = ["race_prediction_vdot_baseline"];
    if (readiness[distance] === undefined) {
      evidenceCodes.push("endurance_readiness_unmodeled");
    } else {
      evidenceCodes.push("race_readiness_applied");
      if (readinessValue < 0.5) evidenceCodes.push("race_readiness_low");
    }
    if (environmentPenalty > 0) evidenceCodes.push("heat_humidity_adjustment");
    if (elevationPenalty > 0) evidenceCodes.push("elevation_adjustment");
    if (fatiguePenalty > 0) evidenceCodes.push("fatigue_adjustment");
    if (totalConditionPenalty === 0) evidenceCodes.push("standard_conditions");
    const confidence = clamp(
      vo2Max.confidence * (0.55 + 0.45 * readinessValue),
      0,
      0.95
    );
    return {
      distance,
      distanceMeters,
      status: "available",
      potentialSeconds,
      predictedSeconds,
      readinessAdjustmentSeconds: preparedSeconds - potentialSeconds,
      environmentAdjustmentSeconds,
      elevationAdjustmentSeconds,
      fatigueAdjustmentSeconds,
      calibrationAdjustmentSeconds: 0,
      machineLearningAdjustmentSeconds: 0,
      machineLearningFallbackReason: null,
      optimisticSeconds,
      pessimisticSeconds,
      readiness: readiness[distance] ?? null,
      confidence,
      confidenceLevel: confidenceLevel(confidence),
      method: totalConditionPenalty > 0
        ? "daniels_vdot_conditions_v3"
        : readiness[distance] === undefined
          ? "daniels_vdot_v1"
          : "daniels_vdot_readiness_v2",
      evidenceCodes
    };
  });
}

export function predictRaceTimesFromPerformanceVdot(
  performanceVdot: PerformanceVdotEstimate,
  readiness: PredictionReadiness = {},
  config: PhysiologyConfig = defaultPhysiologyConfig,
  conditions: RacePredictionConditions = {}
): RaceTimePrediction[] {
  return predictRaceTimes(
    performanceVdotAsAerobicEstimate(performanceVdot),
    readiness,
    config,
    conditions
  );
}

export function buildPhysiologyPredictionSnapshot(input: {
  evidence: Vo2MaxEvidence[];
  performanceEvidence?: PerformanceVdotEvidence[];
  thresholdEvidence?: LactateThresholdEvidence[];
  profile: PhysiologyProfile;
  readiness?: PredictionReadiness;
  conditions?: RacePredictionConditions;
  generatedAt: string;
  dataThroughAt?: string | null;
  config?: PhysiologyConfig;
}): PhysiologyPredictionSnapshot {
  const config = input.config ?? defaultPhysiologyConfig;
  const vo2Max = estimateVo2Max(input.evidence, input.generatedAt, config);
  const performanceVdot = estimatePerformanceVdot(
    vo2Max,
    input.performanceEvidence ?? [],
    input.generatedAt,
    config
  );
  const snapshot: PhysiologyPredictionSnapshot = {
    schemaVersion: PHYSIOLOGY_PREDICTION_SCHEMA_VERSION,
    modelVersion: PHYSIOLOGY_MODEL_VERSION,
    generatedAt: input.generatedAt,
    dataThroughAt: input.dataThroughAt ?? vo2Max.latestEvidenceAt,
    vo2Max,
    performanceVdot,
    lactateThreshold: estimateLactateThresholdFromPerformanceVdot(
          performanceVdot,
          input.profile,
          input.thresholdEvidence ?? [],
          input.generatedAt,
          config
        ),
    races: predictRaceTimesFromPerformanceVdot(
      performanceVdot,
      input.readiness,
      config,
      input.conditions
    ),
    disclaimer: "这些结果是基于历史运动数据的训练估计，不是实验室乳酸或最大摄氧量测试，也不构成医疗建议。"
  };
  assertPhysiologyPredictionSnapshot(snapshot);
  return snapshot;
}

export function evaluateRacePrediction(
  prediction: RaceTimePrediction,
  actualSeconds: number,
  outcomeAt: string,
  predictionGeneratedAt: string
): RacePredictionError {
  assertPositiveFinite("actualSeconds", actualSeconds);
  if (prediction.status !== "available" || prediction.predictedSeconds === null) {
    throw new Error("An available race prediction is required for evaluation");
  }
  if (Date.parse(outcomeAt) < Date.parse(predictionGeneratedAt)) {
    throw new Error("Outcome cannot precede prediction generation");
  }
  const signedErrorSeconds = prediction.predictedSeconds - actualSeconds;
  const intervalCovered =
    prediction.optimisticSeconds === null || prediction.pessimisticSeconds === null
      ? null
      : actualSeconds >= prediction.optimisticSeconds &&
        actualSeconds <= prediction.pessimisticSeconds;
  return {
    distance: prediction.distance,
    predictionGeneratedAt,
    outcomeAt,
    predictedSeconds: prediction.predictedSeconds,
    actualSeconds,
    signedErrorSeconds,
    absoluteErrorSeconds: Math.abs(signedErrorSeconds),
    absolutePercentageError: Math.abs(signedErrorSeconds) / actualSeconds,
    intervalCovered
  };
}

export function aggregateRacePredictionErrors(
  errors: RacePredictionError[]
): RacePredictionMetrics {
  if (errors.length === 0) {
    return {
      sampleCount: 0,
      meanAbsoluteErrorSeconds: null,
      rootMeanSquaredErrorSeconds: null,
      meanAbsolutePercentageError: null,
      meanSignedErrorSeconds: null,
      intervalCoverage: null
    };
  }
  const mean = (values: number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const covered = errors
    .map((error) => error.intervalCovered)
    .filter((value): value is boolean => value !== null);
  return {
    sampleCount: errors.length,
    meanAbsoluteErrorSeconds: mean(errors.map((error) => error.absoluteErrorSeconds)),
    rootMeanSquaredErrorSeconds: Math.sqrt(
      mean(errors.map((error) => error.signedErrorSeconds ** 2))
    ),
    meanAbsolutePercentageError: mean(
      errors.map((error) => error.absolutePercentageError)
    ),
    meanSignedErrorSeconds: mean(errors.map((error) => error.signedErrorSeconds)),
    intervalCoverage:
      covered.length === 0
        ? null
        : covered.filter((value) => value).length / covered.length
  };
}

export interface RacePredictionCalibrationConfig {
  minimumBiasSamples: number;
  minimumIntervalSamples: number;
  maximumAdjustmentFraction: number;
  empiricalIntervalQuantile: number;
}

export const defaultRacePredictionCalibrationConfig: RacePredictionCalibrationConfig = {
  minimumBiasSamples: 3,
  minimumIntervalSamples: 5,
  maximumAdjustmentFraction: 0.12,
  empiricalIntervalQuantile: 0.8
};

function quantile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * clamp(percentile, 0, 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return null;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

export function calibrateRacePrediction(
  prediction: RaceTimePrediction,
  predictionGeneratedAt: string,
  priorErrors: RacePredictionError[],
  config: RacePredictionCalibrationConfig = defaultRacePredictionCalibrationConfig
): RaceTimePrediction {
  if (prediction.status !== "available" || prediction.predictedSeconds === null) {
    return prediction;
  }
  const eligible = priorErrors.filter(
    (error) =>
      error.distance === prediction.distance &&
      Date.parse(error.outcomeAt) <= Date.parse(predictionGeneratedAt)
  );
  if (eligible.length < config.minimumBiasSamples) return prediction;
  const bias = quantile(eligible.map((error) => error.signedErrorSeconds), 0.5) ?? 0;
  const maximumAdjustment = prediction.predictedSeconds * config.maximumAdjustmentFraction;
  const adjustment = clamp(-bias, -maximumAdjustment, maximumAdjustment);
  const correctedSeconds = Math.max(1, prediction.predictedSeconds + adjustment);
  let optimisticSeconds = prediction.optimisticSeconds === null
    ? null
    : Math.max(1, prediction.optimisticSeconds + adjustment);
  let pessimisticSeconds = prediction.pessimisticSeconds === null
    ? null
    : Math.max(1, prediction.pessimisticSeconds + adjustment);
  if (eligible.length >= config.minimumIntervalSamples) {
    const empiricalHalfWidth = quantile(
      eligible.map((error) => Math.abs(error.signedErrorSeconds - bias)),
      config.empiricalIntervalQuantile
    );
    if (empiricalHalfWidth !== null) {
      const currentHalfWidth = Math.max(
        optimisticSeconds === null ? 0 : correctedSeconds - optimisticSeconds,
        pessimisticSeconds === null ? 0 : pessimisticSeconds - correctedSeconds
      );
      const halfWidth = Math.max(currentHalfWidth, empiricalHalfWidth);
      optimisticSeconds = Math.max(1, correctedSeconds - halfWidth);
      pessimisticSeconds = correctedSeconds + halfWidth;
    }
  }
  const confidence = clamp(
    prediction.confidence + 0.05 * (1 - Math.exp(-eligible.length / 5)),
    0,
    0.95
  );
  return {
    ...prediction,
    predictedSeconds: correctedSeconds,
    optimisticSeconds,
    pessimisticSeconds,
    calibrationAdjustmentSeconds:
      (prediction.calibrationAdjustmentSeconds ?? 0) + adjustment,
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    method: "bias_calibrated_v4",
    evidenceCodes: [
      ...new Set<PhysiologyEvidenceCode>([
        ...prediction.evidenceCodes,
        "walk_forward_bias_calibration"
      ])
    ]
  };
}

export * from "./ridge.js";

/** Versioned condition adapter, reusing the exact historical penalty owner. */
export function createPhysiologyNormalizationAdapter() {
  return {
    version: `${PHYSIOLOGY_MODEL_VERSION}:conditions-v1`,
    normalize(input: {distanceMeters:number;durationSeconds:number;conditions:PerformanceConditions}) {
      assertPositiveFinite("distanceMeters",input.distanceMeters);assertPositiveFinite("durationSeconds",input.durationSeconds);
      const c=input.conditions;
      const known=c.temperatureC!=null && c.humidityPercent!=null && c.elevationGainMeters!=null;
      const penalty=performanceConditionPenaltyFraction(input.distanceMeters,c);
      return {version:`${PHYSIOLOGY_MODEL_VERSION}:conditions-v1`,
        status:!known?"unavailable" as const:penalty.total===0?"not_needed" as const:"applied" as const,
        normalizedSeconds:known?input.durationSeconds/(1+penalty.total):null,
        correctionFraction:known?penalty.total:null,
        rawComparableFallback:known?null:input.durationSeconds,
        // Existing partial-input evidence normalisation is explicit, not counted a second time.
        legacyPartialPenalty:penalty.total};
    }
  };
}

/**
 * Read-out of the environment correction for one run (docs/ALGORITHM.md §5).
 *
 * This adds no correction site: it calls the same adapter the historical VDOT
 * evidence path calls, so the number a reader sees is the number that was applied
 * — not a second estimate that can drift from it. When the adapter reports
 * `unavailable`, `correction` and `adjusted` stay `null`; a partially known
 * context is never presented as a complete penalty.
 */
export function buildWorkoutEnvironmentView(input: {
  distanceMeters: number;
  durationSeconds: number;
  conditions: PerformanceConditions;
}): WorkoutEnvironmentView {
  assertPositiveFinite("distanceMeters", input.distanceMeters);
  assertPositiveFinite("durationSeconds", input.durationSeconds);
  const conditions = input.conditions;
  const adapter = createPhysiologyNormalizationAdapter();
  const result = adapter.normalize({
    distanceMeters: input.distanceMeters,
    durationSeconds: input.durationSeconds,
    conditions
  });

  const missing: string[] = [];
  if (conditions.temperatureC === null || conditions.temperatureC === undefined) {
    missing.push("temperature_missing");
  }
  if (conditions.humidityPercent === null || conditions.humidityPercent === undefined) {
    missing.push("humidity_missing");
  }
  if (conditions.elevationGainMeters === null || conditions.elevationGainMeters === undefined) {
    missing.push("elevation_missing");
  }

  if (result.status === "unavailable") {
    return {
      policyVersion: ENVIRONMENT_VIEW_POLICY_VERSION,
      adapterVersion: result.version,
      status: "unavailable",
      source: "workout_metadata",
      temperatureC: conditions.temperatureC ?? null,
      humidityPercent: conditions.humidityPercent ?? null,
      elevationGainMeters: conditions.elevationGainMeters ?? null,
      correction: null,
      adjusted: null,
      reasonCodes: missing
    };
  }

  const penalty = performanceConditionPenaltyFraction(input.distanceMeters, conditions);
  const reasonCodes: string[] = [];
  if (penalty.environment > 0) reasonCodes.push("heat_humidity_adjustment");
  if (penalty.elevation > 0) reasonCodes.push("elevation_adjustment");
  if (reasonCodes.length === 0) reasonCodes.push("reference_conditions");

  const adjustedSeconds = result.normalizedSeconds;
  return {
    policyVersion: ENVIRONMENT_VIEW_POLICY_VERSION,
    adapterVersion: result.version,
    status: result.status,
    source: "workout_metadata",
    temperatureC: conditions.temperatureC ?? null,
    humidityPercent: conditions.humidityPercent ?? null,
    elevationGainMeters: conditions.elevationGainMeters ?? null,
    correction: {
      environment: penalty.environment,
      elevation: penalty.elevation,
      total: penalty.total
    },
    adjusted: adjustedSeconds === null
      ? null
      : {
          durationSeconds: adjustedSeconds,
          paceSecondsPerKm: adjustedSeconds / (input.distanceMeters / 1_000)
        },
    reasonCodes
  };
}
