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

interface Point {
  offsetSeconds: number;
  value: number;
}

/** Nearest speed value within the tolerance, or null — never the closest one regardless of distance. */
function speedAt(points: readonly Point[], offsetSeconds: number): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    if (!Number.isFinite(point.value) || !Number.isFinite(point.offsetSeconds)) continue;
    const distance = Math.abs(point.offsetSeconds - offsetSeconds);
    if (distance > SPEED_PAIRING_TOLERANCE_SECONDS) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point.value;
    }
  }
  return best;
}

export function pairWithSpeed(
  metric: WorkoutMetricSeries,
  speed: WorkoutMetricSeries
): DynamicsSample[] {
  const speedPoints = speed.points.map((point) => ({ offsetSeconds: point.offsetSeconds, value: point.value }));
  return metric.points
    .filter((point) => Number.isFinite(point.offsetSeconds) && Number.isFinite(point.value))
    .map((point) => ({
      offsetSeconds: point.offsetSeconds,
      value: point.value,
      speedMetersPerSecond: speedAt(speedPoints, point.offsetSeconds)
    }));
}

export function buildRunningDynamics(input: {
  durationSeconds: number;
  series: Pick<
    { cadence: WorkoutMetricSeries; speed: WorkoutMetricSeries; strideLength: WorkoutMetricSeries; verticalOscillation: WorkoutMetricSeries; groundContactTime: WorkoutMetricSeries },
    "cadence" | "speed" | "strideLength" | "verticalOscillation" | "groundContactTime"
  >;
}): RunningDynamicsAnalysis {
  const { series } = input;
  return analyseRunningDynamics({
    durationSeconds: input.durationSeconds,
    metrics: {
      cadence: pairWithSpeed(series.cadence, series.speed),
      stride_length: pairWithSpeed(series.strideLength, series.speed),
      vertical_oscillation: pairWithSpeed(series.verticalOscillation, series.speed),
      ground_contact_time: pairWithSpeed(series.groundContactTime, series.speed)
    }
  });
}
