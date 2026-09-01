import {
  assertWorkoutFeatureVector,
  type EligibilityStatus,
  type MissingReasonCode,
  type SessionType,
  type WorkoutFeatureVector,
  type WorkoutOverride
} from "@rai/contracts";

export const FEATURE_CONFIG_VERSION = "feature-config-v7" as const;

const SPEED_STABILITY_WINDOW_SECONDS = 60;

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
  minimumIntervalSpeedCoverage: number;
  recoveryHeartRateReserveThreshold: number;
  easyHeartRateReserveThreshold: number;
  steadyHeartRateReserveThreshold: number;
}

export type FeatureConfigInput = Omit<FeatureConfig, "minimumIntervalSpeedCoverage"> & {
  minimumIntervalSpeedCoverage?: number | undefined;
};

export const defaultFeatureConfig: FeatureConfig = {
  minimumDistanceKm: 1,
  minimumDurationSeconds: 8 * 60,
  minimumHeartRateSamples: 10,
  minimumHeartRateCoverage: 0.5,
  minimumPaceMinutesPerKilometer: 2.5,
  maximumPaceMinutesPerKilometer: 15,
  longRunDurationMinutes: 75,
  longRunDistanceKm: 15,
  intervalSpeedCvThreshold: 0.18,
  minimumIntervalSpeedCoverage: 0.5,
  recoveryHeartRateReserveThreshold: 0.5,
  easyHeartRateReserveThreshold: 0.65,
  steadyHeartRateReserveThreshold: 0.75
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

export interface TimedSeriesSample {
  value: number;
  startOffsetSeconds: number;
  durationSeconds: number;
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
  speedSamples?: TimedSeriesSample[];
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
  elapsedDurationSeconds: number;
  distanceKm: number | null;
  speedCv: number | null;
  speedSamples: TimedSeriesSample[];
  heartRateReserveFraction: number | null;
  confirmedRace: boolean;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

function summarizeSpeedWindow(
  samples: TimedSeriesSample[],
  start: number,
  end: number
): { weightedValue: number; coveredSeconds: number } {
  const overlaps = samples.flatMap((sample) => {
    const overlapStart = Math.max(start, sample.startOffsetSeconds);
    const overlapEnd = Math.min(end, sample.startOffsetSeconds + sample.durationSeconds);
    return overlapEnd > overlapStart
      ? [{ start: overlapStart, end: overlapEnd, value: sample.value }]
      : [];
  });
  const boundaries = [...new Set(overlaps.flatMap((overlap) => [overlap.start, overlap.end]))]
    .sort((left, right) => left - right);
  let weightedValue = 0;
  let coveredSeconds = 0;
  for (let index = 1; index < boundaries.length; index += 1) {
    const segmentStart = boundaries[index - 1] ?? start;
    const segmentEnd = boundaries[index] ?? segmentStart;
    const active = overlaps.filter(
      (overlap) => overlap.start < segmentEnd && overlap.end > segmentStart
    );
    if (active.length === 0) continue;
    const segmentSeconds = segmentEnd - segmentStart;
    const segmentValue = active.reduce((sum, overlap) => sum + overlap.value, 0) / active.length;
    weightedValue += segmentValue * segmentSeconds;
    coveredSeconds += segmentSeconds;
  }
  return { weightedValue, coveredSeconds };
}

function smoothedSpeedCoefficientOfVariation(
  samples: TimedSeriesSample[],
  activeDurationSeconds: number,
  elapsedDurationSeconds: number,
  minimumCoverage: number
): number | null {
  const valid = samples.filter((sample) =>
    Number.isFinite(sample.value) && sample.value > 0 &&
    Number.isFinite(sample.startOffsetSeconds) && sample.startOffsetSeconds >= 0 &&
    Number.isFinite(sample.durationSeconds) && sample.durationSeconds > 0
  );
  if (valid.length === 0 || activeDurationSeconds <= 0) return null;

  const values: number[] = [];
  let totalCoveredSeconds = 0;
  for (
    let start = 0;
    start + SPEED_STABILITY_WINDOW_SECONDS <= elapsedDurationSeconds;
    start += SPEED_STABILITY_WINDOW_SECONDS
  ) {
    const { weightedValue, coveredSeconds } = summarizeSpeedWindow(
      valid,
      start,
      start + SPEED_STABILITY_WINDOW_SECONDS
    );
    totalCoveredSeconds += coveredSeconds;
    if (coveredSeconds >= SPEED_STABILITY_WINDOW_SECONDS * 0.6) {
      values.push(weightedValue / coveredSeconds);
    }
  }
  if (values.length < 2 || totalCoveredSeconds / activeDurationSeconds < minimumCoverage) return null;
  const mean = average(values);
  if (mean === null || mean === 0) return null;
  const variance = average(values.map((value) => (value - mean) ** 2));
  return variance === null ? null : Math.sqrt(variance) / Math.abs(mean);
}

function hasRepeatedIntervalStructure(
  samples: TimedSeriesSample[],
  activeDurationSeconds: number,
  elapsedDurationSeconds: number,
  minimumCoverage: number
): boolean {
  const binSeconds = 30;
  const valid = samples.filter((sample) =>
    Number.isFinite(sample.value) && sample.value > 0 &&
    Number.isFinite(sample.startOffsetSeconds) && sample.startOffsetSeconds >= 0 &&
    Number.isFinite(sample.durationSeconds) && sample.durationSeconds > 0
  );
  if (valid.length === 0) return false;

  const duration = Math.max(0, elapsedDurationSeconds);
  const bins: Array<number | null> = [];
  let totalCoveredSeconds = 0;
  for (let start = 0; start + binSeconds <= duration; start += binSeconds) {
    const { weightedValue, coveredSeconds } = summarizeSpeedWindow(valid, start, start + binSeconds);
    totalCoveredSeconds += coveredSeconds;
    bins.push(coveredSeconds >= binSeconds * 0.6 ? weightedValue / coveredSeconds : null);
  }
  if (activeDurationSeconds <= 0 || totalCoveredSeconds / activeDurationSeconds < minimumCoverage) return false;
  const coveredBins = bins.filter((value): value is number => value !== null);
  if (coveredBins.length < 10) return false;

  const low = percentile(coveredBins, 0.2);
  const high = percentile(coveredBins, 0.8);
  if (low === null || high === null || low <= 0 || high / low < 1.15) return false;

  const midpoint = (low + high) / 2;
  const runs: Array<{ fast: boolean; bins: number }> = [];
  for (const value of bins) {
    if (value === null) {
      runs.push({ fast: false, bins: 0 });
      continue;
    }
    const fast = value >= midpoint;
    const previous = runs.at(-1);
    if (previous?.fast === fast && previous.bins > 0) previous.bins += 1;
    else runs.push({ fast, bins: 1 });
  }

  const workBouts = runs.filter((run) => run.fast && run.bins * binSeconds >= 60);
  if (workBouts.length < 3) return false;
  const firstWork = runs.findIndex((run) => run.fast && run.bins * binSeconds >= 60);
  const lastWork = runs.findLastIndex((run) => run.fast && run.bins * binSeconds >= 60);
  const recoveries = runs.slice(firstWork + 1, lastWork).filter((run) =>
    !run.fast && run.bins * binSeconds >= 30
  );
  return recoveries.length >= 2;
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
  if (evidence.confirmedRace) return "race";

  if (
    evidence.speedCv !== null &&
    evidence.speedCv >= config.intervalSpeedCvThreshold &&
    hasRepeatedIntervalStructure(
      evidence.speedSamples,
      evidence.durationSeconds,
      evidence.elapsedDurationSeconds,
      config.minimumIntervalSpeedCoverage
    )
  ) return "interval";
  if (hrr !== null && hrr < config.recoveryHeartRateReserveThreshold) return "recovery";
  // Long easy volume stays "easy" so TA evidence is not inflated by duration alone.
  if (hrr !== null && hrr < config.easyHeartRateReserveThreshold) return "easy";
  // Auto long_run requires non-easy HRR (or higher intensity). Duration/distance
  // alone without HRR must not promote a workout before the easy fallback.
  const longVolume =
    evidence.durationSeconds / 60 >= config.longRunDurationMinutes ||
    (evidence.distanceKm ?? 0) >= config.longRunDistanceKm;
  if (longVolume && hrr !== null && hrr >= config.easyHeartRateReserveThreshold) {
    return "long_run";
  }

  // Heart-rate reserve normalizes effort to the runner instead of relying on
  // absolute pace, which changes substantially with fitness and conditions.
  if (hrr !== null) {
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
  // Aggregate WorkoutStatistics expose an average without sample density.
  // Stats-only averages must not satisfy full eligibility — force trial unless
  // the user include override is set. Still surface the coverage reason.
  const statisticOnlyAverage =
    source.heartRate.average !== null &&
    source.heartRate.sampleCount > 0 &&
    source.heartRate.sampleCount < config.minimumHeartRateSamples &&
    source.heartRate.coveredDurationSeconds === null;
  const hasRequiredHeartEvidence =
    source.heartRate.average !== null &&
    !statisticOnlyAverage &&
    (source.heartRate.sampleCount >= config.minimumHeartRateSamples ||
      (coverage !== null && coverage >= config.minimumHeartRateCoverage));
  if (
    source.heartRate.average !== null &&
    (statisticOnlyAverage || !hasRequiredHeartEvidence)
  ) {
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
  config: FeatureConfigInput = defaultFeatureConfig,
  computedAt = new Date().toISOString()
): WorkoutFeatureVector {
  const normalizedConfig: FeatureConfig = {
    ...defaultFeatureConfig,
    ...config,
    minimumIntervalSpeedCoverage:
      config.minimumIntervalSpeedCoverage ?? defaultFeatureConfig.minimumIntervalSpeedCoverage
  };
  const speed =
    source.speed.average ??
    (source.distanceKm !== null && source.durationSeconds > 0
      ? (source.distanceKm * 1000) / source.durationSeconds
      : null);
  const speedCoefficientOfVariation =
    smoothedSpeedCoefficientOfVariation(
      source.speedSamples ?? [],
      source.durationSeconds,
      Math.max(
        source.durationSeconds,
        (Date.parse(source.workoutEndAt) - Date.parse(source.workoutStartAt)) / 1000
      ),
      normalizedConfig.minimumIntervalSpeedCoverage
    ) ?? source.speed.coefficientOfVariation;
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
  const stabilityInputs = [speedCoefficientOfVariation, source.heartRate.coefficientOfVariation]
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
  const elapsedSeconds = (Date.parse(source.workoutEndAt) - Date.parse(source.workoutStartAt)) / 1000;
  const sessionType = source.override?.sessionType ?? automaticSessionType({
    durationSeconds: source.durationSeconds,
    elapsedDurationSeconds: Number.isFinite(elapsedSeconds)
      ? Math.max(source.durationSeconds, elapsedSeconds)
      : source.durationSeconds,
    distanceKm: source.distanceKm,
    speedCv: speedCoefficientOfVariation,
    speedSamples: source.speedSamples ?? [],
    heartRateReserveFraction: hrr,
    confirmedRace: source.override?.performanceProtocol === "half_marathon_race" ||
      source.override?.performanceProtocol === "other_race"
  }, normalizedConfig);
  const sessionTypeSource = source.override?.sessionType ? "override" : "auto";
  const result = eligibility(source, normalizedConfig);
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
      speedCoefficientOfVariation,
      sleepDurationMinutes: source.sleepDurationMinutes,
      restingHeartRateBpm: source.restingHeartRate,
      hrvSdnnMs: source.hrvSdnn,
      recentLoadMinutes: source.recentLoadMinutes
    },
    provenance: {
      featureConfigVersion: FEATURE_CONFIG_VERSION,
      featureConfig: normalizedConfig,
      sourceCategory: source.sourceCategory,
      observedMaximumHeartRate: source.observedMaximumHeartRate
    },
    computedAt
  };
  assertWorkoutFeatureVector(feature);
  return feature;
}
