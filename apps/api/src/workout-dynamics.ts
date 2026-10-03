import type { RunningDynamicsAnalysis } from "@rai/contracts";
import { analyseRunningDynamics, type DynamicsSample } from "@rai/dynamics";
import type { WorkoutMetricSeries } from "@rai/api-contracts";

/**
 * Running dynamics read-out for one run (docs/ALGORITHM.md §19).
 *
 * The analysis itself lives in `@rai/dynamics`; this module only pairs the stored
 * series with the speed series so the two halves can be compared at comparable
 * speed. Pairing belongs here because it is a statement about *this* storage
 * format (offset-based samples), not about stride mechanics.
 *
 * Nothing here feeds CA/TA. These are device estimates with no laboratory
 * validation, and the policy version travels with the response.
 */

/**
 * How far apart a stride sample and a speed sample may be and still be treated as
 * the same instant. The speed track is sampled at the watch's own cadence, so an
 * exact offset match would silently drop most samples; 15 s is well inside the
 * timescale over which pace changes matter for this comparison.
 */
export const SPEED_PAIRING_TOLERANCE_SECONDS = 15;

interface SpeedPoint {
  offsetSeconds: number;
  value: number;
  index: number;
}

/** Nearest speed value within the tolerance, or null — never the closest one regardless of distance. */
function speedLookup(speed: WorkoutMetricSeries): (offsetSeconds: number) => number | null {
  const scale = speed.unit === "m/s" ? 1
    : speed.unit === "km/hr" || speed.unit === "km/h" ? 1 / 3.6
      : speed.unit === "mi/hr" || speed.unit === "mph" ? 0.44704 : null;
  const sorted = scale === null ? [] : speed.points.map((point, index): SpeedPoint => ({
    offsetSeconds: point.offsetSeconds,
    value: point.value * scale,
    index
  })).filter((point) => Number.isFinite(point.value) && Number.isFinite(point.offsetSeconds))
    .sort((left, right) => left.offsetSeconds - right.offsetSeconds || left.index - right.index);
  // Keep the first input sample at each offset, including original tie precedence.
  const points = sorted.filter((point, index) => index === 0 || point.offsetSeconds !== sorted[index - 1]!.offsetSeconds);
  return (offsetSeconds) => {
    let left = 0;
    let right = points.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (points[middle]!.offsetSeconds < offsetSeconds) left = middle + 1;
      else right = middle;
    }
    const before = points[left - 1];
    const after = points[left];
    const beforeDistance = before ? Math.abs(before.offsetSeconds - offsetSeconds) : Infinity;
    const afterDistance = after ? Math.abs(after.offsetSeconds - offsetSeconds) : Infinity;
    const nearest = beforeDistance < afterDistance ||
      (beforeDistance === afterDistance && before && after && before.index < after.index) ? before : after;
    return nearest && Math.min(beforeDistance, afterDistance) <= SPEED_PAIRING_TOLERANCE_SECONDS ? nearest.value : null;
  };
}

function pairMetric(metric: WorkoutMetricSeries, speedAt: (offsetSeconds: number) => number | null): DynamicsSample[] {
  return metric.points
    .filter((point) => Number.isFinite(point.offsetSeconds) && Number.isFinite(point.value))
    .map((point) => ({
      offsetSeconds: point.offsetSeconds,
      value: point.value,
      speedMetersPerSecond: speedAt(point.offsetSeconds)
    }));
}

export function pairWithSpeed(metric: WorkoutMetricSeries, speed: WorkoutMetricSeries): DynamicsSample[] {
  return pairMetric(metric, speedLookup(speed));
}

export function buildRunningDynamics(input: {
  durationSeconds: number;
  series: Pick<
    { cadence: WorkoutMetricSeries; speed: WorkoutMetricSeries; strideLength: WorkoutMetricSeries; verticalOscillation: WorkoutMetricSeries; groundContactTime: WorkoutMetricSeries },
    "cadence" | "speed" | "strideLength" | "verticalOscillation" | "groundContactTime"
  >;
}): RunningDynamicsAnalysis {
  const { series } = input;
  const speedAt = speedLookup(series.speed);
  return analyseRunningDynamics({
    durationSeconds: input.durationSeconds,
    metrics: {
      cadence: pairMetric(series.cadence, speedAt),
      stride_length: pairMetric(series.strideLength, speedAt),
      vertical_oscillation: pairMetric(series.verticalOscillation, speedAt),
      ground_contact_time: pairMetric(series.groundContactTime, speedAt)
    }
  });
}
