import {
  assertWorkoutFeatureVector,
  type EligibilityStatus,
  type MissingReasonCode,
  type SessionType,
  type WorkoutFeatureVector,
  type WorkoutOverride
} from "@rai/contracts";

export const FEATURE_CONFIG_VERSION = "feature-config-v3" as const;

export interface FeatureConfig {
  minimumDistanceKm: number;
  minimumDurationSeconds: number;
  minimumHeartRateSamples: number;
  minimumHeartRateCoverage: number;
  minimumPaceMinutesPerKilometer: number;
  maximumPaceMinutesPerKilometer: number;
  longRunDurationMinutes: number;
  longRunDistanceKm: number;
  intervalSpeedCvThreshold: number;
  recoveryHeartRateReserveThreshold: number;
  easyHeartRateReserveThreshold: number;
  steadyHeartRateReserveThreshold: number;
  raceHeartRateReserveThreshold: number;
}

export const defaultFeatureConfig: FeatureConfig = {
  minimumDistanceKm: 1,
  minimumDurationSeconds: 8 * 60,
  minimumHeartRateSamples: 10,
  minimumHeartRateCoverage: 0.5,
  minimumPaceMinutesPerKilometer: 2.5,
  maximumPaceMinutesPerKilometer: 15,
  longRunDurationMinutes: 75,
  longRunDistanceKm: 15,
  intervalSpeedCvThreshold: 0.14,
  recoveryHeartRateReserveThreshold: 0.5,
  easyHeartRateReserveThreshold: 0.65,
  steadyHeartRateReserveThreshold: 0.75,
  raceHeartRateReserveThreshold: 0.85
};

export interface NumericSeriesSummary {
  average: number | null;
  minimum: number | null;
  maximum: number | null;
  sampleCount: number;
  firstAt: string | null;
  lastAt: string | null;
  coefficientOfVariation: number | null;
  coveredDurationSeconds?: number | null;
}

export interface WorkoutFeatureSource {
  id: string;
  trainingSessionId: string;
  trainingSessionStatus: "active" | "inactive" | "ambiguous";
  workoutStartAt: string;
  workoutEndAt: string;
  durationSeconds: number;
  distanceKm: number | null;
  indoor: boolean | null;
  sourceCategory: string;
  routePointCount: number;
  routeQuality: number | null;
  speed: NumericSeriesSummary;
  heartRate: NumericSeriesSummary;
  restingHeartRate: number | null;
  hrvSdnn: number | null;
  sleepDurationMinutes: number | null;
  recentLoadMinutes: number | null;
  observedMaximumHeartRate: number | null;
  override: WorkoutOverride | null;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const average = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
};

function sourceConfidence(sourceCategory: string): number {
  switch (sourceCategory) {
    case "apple_watch":
      return 1;
    case "coros":
      return 0.8;
    case "huawei":
      return 0.65;
    case "connect":
      return 0.6;
    default:
      return 0.45;
  }
}

interface SessionTypeEvidence {
  durationSeconds: number;
  distanceKm: number | null;
  speedCv: number | null;
  heartRateReserveFraction: number | null;
}

const raceDistancesKm = [3, 5, 10, 15, 21.0975, 42.195];

function isRaceDistance(distanceKm: number): boolean {
  return raceDistancesKm.some((raceDistance) => {
    const tolerance = raceDistance <= 5 ? 0.04 : 0.03;
    return Math.abs(distanceKm - raceDistance) / raceDistance <= tolerance;
  });
}

function automaticSessionType(
  evidence: SessionTypeEvidence,
  config: FeatureConfig
): SessionType {
  const pace = paceMinutesPerKilometer(evidence.distanceKm, evidence.durationSeconds);
  if (
    pace === null ||
    pace < config.minimumPaceMinutesPerKilometer ||
    pace > config.maximumPaceMinutesPerKilometer
  ) return "unknown";

  const hrr = evidence.heartRateReserveFraction;
  if (
    hrr !== null &&
    hrr >= config.raceHeartRateReserveThreshold &&
    evidence.distanceKm !== null &&
    isRaceDistance(evidence.distanceKm)
  ) return "race";

  if (
    evidence.durationSeconds / 60 >= config.longRunDurationMinutes ||
    (evidence.distanceKm ?? 0) >= config.longRunDistanceKm
  ) return "long_run";
  if (
    evidence.speedCv !== null &&
    evidence.speedCv >= config.intervalSpeedCvThreshold
  ) return "interval";

  // Heart-rate reserve normalizes effort to the runner instead of relying on
  // absolute pace, which changes substantially with fitness and conditions.
  if (hrr !== null) {
    if (hrr < config.recoveryHeartRateReserveThreshold) return "recovery";
    if (hrr < config.easyHeartRateReserveThreshold) return "easy";
    if (hrr < config.steadyHeartRateReserveThreshold) return "steady";
    return "tempo";
  }

  // A valid, stable run without heart-rate evidence is most safely treated as
  // easy. Explicit overrides remain available for workouts with known intent.
  return "easy";
}

function paceMinutesPerKilometer(
  distanceKm: number | null,
  durationSeconds: number
): number | null {
  if (distanceKm === null || distanceKm <= 0 || durationSeconds <= 0) return null;
  return durationSeconds / 60 / distanceKm;
}

function heartRateCoverage(source: WorkoutFeatureSource): number | null {
  const { firstAt, lastAt, sampleCount, coveredDurationSeconds } = source.heartRate;
  if (typeof coveredDurationSeconds === "number" && Number.isFinite(coveredDurationSeconds) && source.durationSeconds > 0) {
    return clamp(coveredDurationSeconds / source.durationSeconds, 0, 1);
  }
  const sampleDensity = sampleCount > 0
    ? Math.min(1, sampleCount / Math.max(1, source.durationSeconds / 60))
    : null;
  if (firstAt !== null && lastAt !== null && source.durationSeconds > 0) {
    const spanSeconds = (Date.parse(lastAt) - Date.parse(firstAt)) / 1000;
    if (Number.isFinite(spanSeconds) && spanSeconds >= 0) {
      const spanCoverage = clamp(spanSeconds / source.durationSeconds, 0, 1);
      return sampleDensity === null ? spanCoverage : Math.min(spanCoverage, sampleDensity);
    }
  }
  return sampleDensity;
}

function eligibility(
  source: WorkoutFeatureSource,
  config: FeatureConfig
): { status: EligibilityStatus; reasons: MissingReasonCode[] } {
  const reasons: MissingReasonCode[] = [];
  const pace = paceMinutesPerKilometer(source.distanceKm, source.durationSeconds);
  const coverage = heartRateCoverage(source);

  if (source.trainingSessionStatus === "ambiguous") reasons.push("session_ambiguous");
  if (source.distanceKm === null) reasons.push("distance_missing");
  else if (source.distanceKm < config.minimumDistanceKm) reasons.push("distance_below_1km");
  if (source.durationSeconds < config.minimumDurationSeconds) reasons.push("duration_below_8min");
  if (source.indoor === true) reasons.push("indoor_workout");
  if (source.indoor === null) reasons.push("indoor_status_unknown");
  if (pace !== null && (pace < config.minimumPaceMinutesPerKilometer || pace > config.maximumPaceMinutesPerKilometer)) {
    reasons.push("implausible_average_pace");
  }
  if (source.heartRate.average === null) reasons.push("heart_rate_missing");
  const hasRequiredHeartEvidence =
    source.heartRate.average !== null &&
    (source.heartRate.sampleCount >= config.minimumHeartRateSamples ||
      (coverage !== null && coverage >= config.minimumHeartRateCoverage));
  if (source.heartRate.average !== null && !hasRequiredHeartEvidence) {
    reasons.push("heart_rate_coverage_low");
  }
  if (source.routePointCount === 0) reasons.push("route_missing");
  if (source.routeQuality !== null && source.routeQuality < 0.5) reasons.push("route_quality_low");
  if (source.sleepDurationMinutes === null && source.restingHeartRate === null && source.hrvSdnn === null) {
    reasons.push("recovery_data_missing");
  }

  if (source.override?.eligibilityOverride === "exclude") {
    return { status: "excluded", reasons: [...reasons, "user_excluded"] };
  }

  const hardExclusion = reasons.some((reason) =>
    [
      "session_ambiguous",
      "distance_missing",
      "distance_below_1km",
      "duration_below_8min",
      "indoor_workout",
      "implausible_average_pace"
    ].includes(reason)
  );
  if (hardExclusion) return { status: "excluded", reasons };

  if (!hasRequiredHeartEvidence || source.indoor === null) {
    return { status: source.override?.eligibilityOverride === "include" ? "eligible" : "trial", reasons };
  }
  return { status: "eligible", reasons };
}

export function extractWorkoutFeatureVector(
  featureId: string,
  featureRunId: string,
  source: WorkoutFeatureSource,
  config: FeatureConfig = defaultFeatureConfig,
  computedAt = new Date().toISOString()
): WorkoutFeatureVector {
  const speed =
    source.speed.average ??
    (source.distanceKm !== null && source.durationSeconds > 0
      ? (source.distanceKm * 1000) / source.durationSeconds
      : null);
  const hrCoverage = heartRateCoverage(source);
  const averageHeartRate = source.heartRate.average;
  const hrr =
    averageHeartRate !== null &&
    source.restingHeartRate !== null &&
    source.observedMaximumHeartRate !== null &&
    source.observedMaximumHeartRate > source.restingHeartRate
      ? clamp(
          (averageHeartRate - source.restingHeartRate) /
            (source.observedMaximumHeartRate - source.restingHeartRate),
          0,
          1.1
        )
      : null;
  const stabilityInputs = [source.speed.coefficientOfVariation, source.heartRate.coefficientOfVariation]
    .filter((value): value is number => value !== null)
    .map((value) => clamp(value, 0, 1));
  const stabilityRaw =
    stabilityInputs.length > 0 ? 1 - (average(stabilityInputs) ?? 0) : null;
  const recoveryParts = [
    source.sleepDurationMinutes === null ? null : clamp(source.sleepDurationMinutes / 480, 0, 1),
    source.restingHeartRate === null
      ? null
      : 1 - clamp((source.restingHeartRate - 40) / 80, 0, 1),
    source.hrvSdnn === null ? null : clamp(source.hrvSdnn / 100, 0, 1),
    source.recentLoadMinutes === null
      ? null
      : 1 - clamp(source.recentLoadMinutes / (7 * 60), 0, 1)
  ].filter((value): value is number => value !== null);
  const recoveryRaw = average(recoveryParts);
  const sessionType = source.override?.sessionType ?? automaticSessionType({
    durationSeconds: source.durationSeconds,
    distanceKm: source.distanceKm,
    speedCv: source.speed.coefficientOfVariation,
    heartRateReserveFraction: hrr
  }, config);
  const sessionTypeSource = source.override?.sessionType ? "override" : "auto";
  const result = eligibility(source, config);
  const coverageScore = average([
    source.distanceKm !== null ? 1 : 0,
    hrCoverage ?? 0,
    source.routePointCount > 0 ? source.routeQuality ?? 0.75 : 0
  ]) ?? 0;
  const qualityScore = clamp(
    0.55 * coverageScore + 0.25 * sourceConfidence(source.sourceCategory) + 0.2 * (result.status === "eligible" ? 1 : result.status === "trial" ? 0.5 : 0),
    0,
    1
  );

  const feature: WorkoutFeatureVector = {
    id: featureId,
    featureRunId,
    trainingSessionId: source.trainingSessionId,
    canonicalWorkoutId: source.id,
    workoutStartAt: source.workoutStartAt,
    durationSeconds: source.durationSeconds,
    distanceKm: source.distanceKm,
    averageSpeedMetersPerSecond: speed,
    averageHeartRateBpm: averageHeartRate,
    heartRateSampleCount: source.heartRate.sampleCount,
    heartRateCoverage: hrCoverage,
    routePointCount: source.routePointCount,
    routeQuality: source.routeQuality,
    sourceConfidence: sourceConfidence(source.sourceCategory),
    sessionType,
    sessionTypeSource,
    eligibilityStatus: result.status,
    qualityScore,
    missingReasons: result.reasons,
    signals: {
      efficiencyRaw:
        speed !== null && averageHeartRate !== null ? speed / averageHeartRate : null,
      paceRawMetersPerSecond: speed,
      cardioRaw: speed !== null ? (source.durationSeconds / 60) * speed : null,
      stabilityRaw,
      recoveryRaw,
      heartRateReserveFraction: hrr,
      heartRateCoefficientOfVariation: source.heartRate.coefficientOfVariation,
      speedCoefficientOfVariation: source.speed.coefficientOfVariation,
      sleepDurationMinutes: source.sleepDurationMinutes,
      restingHeartRateBpm: source.restingHeartRate,
      hrvSdnnMs: source.hrvSdnn,
      recentLoadMinutes: source.recentLoadMinutes
    },
    provenance: {
      featureConfigVersion: FEATURE_CONFIG_VERSION,
      featureConfig: config,
      sourceCategory: source.sourceCategory,
      observedMaximumHeartRate: source.observedMaximumHeartRate
    },
    computedAt
  };
  assertWorkoutFeatureVector(feature);
  return feature;
}
