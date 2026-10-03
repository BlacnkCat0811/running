import {
  RUNNING_DYNAMICS_POLICY_VERSION,
  type RunningDynamicsAnalysis,
  type RunningDynamicsFlag,
  type RunningDynamicsMetricAnalysis,
  type RunningDynamicsMetricName
} from "@rai/contracts";

/**
 * Running dynamics read-out (docs/ALGORITHM.md §19).
 *
 * These metrics arrive from the watch (Apple Watch reports cadence, stride length,
 * vertical oscillation and ground contact time without any extra pod), and until
 * now they were stored and drawn but never analysed: `packages/features` and
 * `packages/scoring` reference them zero times.
 *
 * Three rules shape everything here:
 *
 * 1. **Coverage is a gate, not a detail.** A watch that never reported ground
 *    contact time must say so; averaging the two samples it did report into a
 *    "drift" would invent a finding.
 * 2. **Compare like with like.** Half-split drift is computed only over the meters
 *    where the two halves were actually run at comparable speed. Otherwise a
 *    positive split shows up as "your cadence collapsed", which is a statement
 *    about pace wearing the clothes of a statement about form.
 * 3. **Unknown is not zero.** Every absent number stays `null` and carries a
 *    reason code.
 *
 * Nothing here feeds CA/TA: these are device estimates with no laboratory
 * validation, so they are display-and-evidence only.
 */

export { RUNNING_DYNAMICS_POLICY_VERSION as DYNAMICS_POLICY_VERSION } from "@rai/contracts";

/**
 * Minimum share of the run's duration a metric must cover to be analysed.
 * Below this the series is reported as `insufficient_coverage` with the measured
 * share, never averaged into a number that looks complete.
 */
export const MINIMUM_METRIC_COVERAGE = 0.6;

/** Occupied time buckets, not the span between the first and last samples. */
export const METRIC_COVERAGE_BUCKET_SECONDS = 30;

/** Minimum comparable samples in *each* half before a drift is reported. */
export const MINIMUM_HALF_SAMPLES = 20;

/**
 * Speed bands used to decide whether two samples are comparable: within a band the
 * pace difference is small enough that a form change is not just a pace change.
 * Expressed in m/s and deliberately wide — this is a guard against comparing a
 * 6:00/km half with a 3:30/km half, not a pace-matching algorithm.
 */
export const COMPARABLE_SPEED_TOLERANCE_MPS = 0.35;

/** Drift beyond this (relative to the first half) is worth telling the runner about. */
export const DRIFT_FLAG_THRESHOLD = 0.04;

export interface DynamicsSample {
  offsetSeconds: number;
  value: number;
  /** Speed at the same offset, m/s. Required for the drift comparison. */
  speedMetersPerSecond: number | null;
}

export interface DynamicsInput {
  durationSeconds: number;
  metrics: Partial<Record<RunningDynamicsMetricName, readonly DynamicsSample[]>>;
}

const METRIC_LABELS: Record<RunningDynamicsMetricName, string> = {
  cadence: "步频",
  stride_length: "步幅",
  vertical_oscillation: "垂直振幅",
  ground_contact_time: "触地时间"
};

/** A rise in these is the direction that usually accompanies fatigue. */
const HIGHER_IS_WORSE: Record<RunningDynamicsMetricName, boolean> = {
  cadence: false,
  stride_length: true,
  vertical_oscillation: true,
  ground_contact_time: true
};

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Coverage is measured in *time*, not sample count: a series sampled densely for
 * two minutes of a one-hour run is not 60 % covered just because it has many rows.
 */
export function seriesCoverage(durationSeconds: number, metricLabel: string, samples: readonly DynamicsSample[]): number {
  if (!finite(durationSeconds) || durationSeconds <= 0) return 0;
  const offsets = new Set(samples.filter((sample) => finite(sample.value) &&
    finite(sample.offsetSeconds) && sample.offsetSeconds >= 0 && sample.offsetSeconds <= durationSeconds)
    .map((sample) => sample.offsetSeconds));
  if (offsets.size < 2) return 0;
  const bucketCount = Math.ceil(durationSeconds / METRIC_COVERAGE_BUCKET_SECONDS);
  const buckets = new Set([...offsets].map((offset) =>
    Math.min(bucketCount - 1, Math.floor(offset / METRIC_COVERAGE_BUCKET_SECONDS))));
  const coveredSeconds = [...buckets].reduce((sum, bucket) => sum +
    Math.min(METRIC_COVERAGE_BUCKET_SECONDS, durationSeconds - bucket * METRIC_COVERAGE_BUCKET_SECONDS), 0);
  void metricLabel;
  return Math.min(1, coveredSeconds / durationSeconds);
}

function analyseMetric(
  name: RunningDynamicsMetricName,
  durationSeconds: number,
  samples: readonly DynamicsSample[]
): RunningDynamicsMetricAnalysis {
  const label = METRIC_LABELS[name];
  const usable = samples.filter((sample) => finite(sample.value) && finite(sample.offsetSeconds) &&
    sample.offsetSeconds >= 0 && sample.offsetSeconds <= durationSeconds);
  const unit = name === "cadence" ? "spm" : name === "ground_contact_time" ? "ms" : name === "vertical_oscillation" ? "cm" : "m";
  const coverage = seriesCoverage(durationSeconds, label, usable);
  const average = mean(usable.map((sample) => sample.value));
  const base = {
    name,
    label,
    unit,
    samples: usable.length,
    coverage: round(coverage, 3),
    average: average === null ? null : round(average, 2),
    firstHalfAverage: null as number | null,
    secondHalfAverage: null as number | null,
    driftFraction: null as number | null,
    comparableSamples: 0,
    reasonCodes: [] as string[]
  };

  if (usable.length === 0) {
    return { ...base, status: "unavailable", reasonCodes: ["no_samples"] };
  }
  if (coverage < MINIMUM_METRIC_COVERAGE) {
    return { ...base, average: null, status: "insufficient_coverage", reasonCodes: ["coverage_below_minimum"] };
  }

  const halfway = durationSeconds / 2;
  const first = usable.filter((sample) => sample.offsetSeconds <= halfway);
  const second = usable.filter((sample) => sample.offsetSeconds > halfway);

  // Only samples whose speed is known can be compared for form drift. When the
  // speed series is missing entirely the halves are compared as-is but the result
  // is capped at "partial" information via the reason code — never silently.
  const pairedFirst = first.filter((sample) => finite(sample.speedMetersPerSecond));
  const pairedSecond = second.filter((sample) => finite(sample.speedMetersPerSecond));
  const canMatchSpeed = pairedFirst.length >= MINIMUM_HALF_SAMPLES && pairedSecond.length >= MINIMUM_HALF_SAMPLES;

  if (!canMatchSpeed) {
    return {
      ...base,
      status: "partial",
      firstHalfAverage: mean(first.map((sample) => sample.value)) === null ? null : round(mean(first.map((sample) => sample.value))!, 2),
      secondHalfAverage: mean(second.map((sample) => sample.value)) === null ? null : round(mean(second.map((sample) => sample.value))!, 2),
      reasonCodes: ["comparable_speed_samples_insufficient"]
    };
  }

  // Match each second-half sample to first-half samples inside its speed band, and
  // compare the *matched* averages: an interval session's fast half and slow half
  // are then not mistaken for a form change.
  const matchedFirst: number[] = [];
  const matchedSecond: number[] = [];
  for (const sample of pairedSecond) {
    const speed = sample.speedMetersPerSecond as number;
    const band = pairedFirst.filter(
      (candidate) => Math.abs((candidate.speedMetersPerSecond as number) - speed) <= COMPARABLE_SPEED_TOLERANCE_MPS
    );
    if (band.length === 0) continue;
    matchedSecond.push(sample.value);
    matchedFirst.push(band.reduce((sum, item) => sum + item.value, 0) / band.length);
  }

  if (matchedSecond.length < MINIMUM_HALF_SAMPLES) {
    return {
      ...base,
      status: "partial",
      reasonCodes: ["no_speed_matched_pairs"],
      comparableSamples: matchedSecond.length
    };
  }

  const firstAverage = mean(matchedFirst);
  const secondAverage = mean(matchedSecond);
  if (firstAverage === null || secondAverage === null || firstAverage === 0) {
    return { ...base, status: "partial", comparableSamples: matchedSecond.length, reasonCodes: ["matched_average_undefined"] };
  }

  const drift = (secondAverage - firstAverage) / Math.abs(firstAverage);
  return {
    ...base,
    status: "available",
    firstHalfAverage: round(firstAverage, 2),
    secondHalfAverage: round(secondAverage, 2),
    driftFraction: round(drift, 4),
    comparableSamples: matchedSecond.length,
    reasonCodes: []
  };
}

function flagFor(metric: RunningDynamicsMetricAnalysis): RunningDynamicsFlag | null {
  if (metric.status !== "available" || metric.driftFraction === null) return null;
  const higherIsWorse = HIGHER_IS_WORSE[metric.name];
  const worse = higherIsWorse ? metric.driftFraction : -metric.driftFraction;
  if (worse < DRIFT_FLAG_THRESHOLD) return null;
  return {
    code: `${metric.name}_drift`,
    metric: metric.name,
    detail: `${metric.label}在后半程同配速下${higherIsWorse ? "上升" : "下降"} ${Math.abs(metric.driftFraction * 100).toFixed(1)}%`,
    driftFraction: metric.driftFraction,
    comparableSamples: metric.comparableSamples
  };
}

export function analyseRunningDynamics(input: DynamicsInput): RunningDynamicsAnalysis {
  const names = Object.keys(METRIC_LABELS) as RunningDynamicsMetricName[];
  const metrics = names.map((name) => analyseMetric(name, input.durationSeconds, input.metrics[name] ?? []));
  const flags = metrics.flatMap((metric) => {
    const flag = flagFor(metric);
    return flag === null ? [] : [flag];
  });
  // The note names *which* kind of partial this is: "the watch never recorded it"
  // and "it recorded too little to compare" are different gaps, and a single
  // generic sentence would hide the one the runner can actually act on.
  const analysable = metrics.filter((metric) => metric.status === "available" || metric.status === "partial").length;
  const note = analysable === 0 && metrics.every((metric) => metric.samples === 0)
    ? "这次训练没有任何跑姿动态样本（手表未记录或未同步）。"
    : metrics.some((metric) => metric.status === "insufficient_coverage")
      ? "部分指标覆盖不足，只展示可用部分。"
      : metrics.some((metric) => metric.status === "unavailable")
        ? "部分指标这次没有采样（多为手表未记录），只展示可用的部分。"
        : null;
  return {
    policyVersion: RUNNING_DYNAMICS_POLICY_VERSION,
    /** Device estimates. No laboratory validation has been done on this pipeline. */
    evidenceStatus: "device_estimated_not_lab_validated",
    metrics,
    flags,
    note
  };
}
