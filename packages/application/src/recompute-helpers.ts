import type { NumericSeriesSummary } from "@rai/features";
import { defaultFeatureConfig } from "@rai/features";
import { defaultRaiModelConfig } from "@rai/scoring";
import { appNow, median } from "./utils.js";
import type { RecomputeOptions, RecomputeRequest, RecordRow, StatisticRow } from "./service-types.js";

export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const asNullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function normalizeInstant(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid ISO timestamp`);
  return new Date(parsed).toISOString();
}

export function convertDistanceToKilometers(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  switch (unit?.toLowerCase()) {
    case "km":
      return value;
    case "m":
      return value / 1000;
    case "mi":
      return value * 1.609344;
    default:
      return null;
  }
}

export function convertSpeedToMetersPerSecond(value: number, unit: string | null): number {
  // HealthKit commonly stores running speed as km/hr; missing unit defaults to km/hr.
  const normalized = (unit ?? "").trim().toLowerCase();
  if (!normalized || normalized === "km/hr" || normalized === "km/h") {
    return value / 3.6;
  }
  switch (normalized) {
    case "mi/hr":
    case "mph":
      return value * 0.44704;
    case "m/s":
    case "m/sec":
    case "mps":
      return value;
    default:
      // Unknown labels: preserve legacy "already meters per second" behavior.
      return value;
  }
}

export function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  if (mean === 0) return null;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

export interface WeightedRecordInterval {
  value: number;
  startMs: number;
  endMs: number;
  durationSeconds: number;
}

export function weightedRecordIntervals(
  rows: RecordRow[],
  workoutStartAt: string,
  workoutEndAt: string,
  converter: (value: number, unit: string | null) => number
): WeightedRecordInterval[] {
  const workoutStartMs = Date.parse(workoutStartAt);
  const workoutEndMs = Date.parse(workoutEndAt);
  return rows.flatMap((row, index) => {
    const rowStartMs = Math.max(workoutStartMs, Date.parse(row.startAt));
    const rawEndMs = Date.parse(row.endAt);
    const nextStartMs = Date.parse(rows[index + 1]?.startAt ?? workoutEndAt);
    const inferredEndMs = rawEndMs > Date.parse(row.startAt)
      ? rawEndMs
      : Math.min(nextStartMs, Date.parse(row.startAt) + 30_000);
    const rowEndMs = Math.min(workoutEndMs, inferredEndMs);
    if (!Number.isFinite(rowStartMs) || !Number.isFinite(rowEndMs) || rowEndMs <= rowStartMs) return [];
    return [{
      value: converter(row.value, row.unit ?? null),
      startMs: rowStartMs,
      endMs: rowEndMs,
      durationSeconds: (rowEndMs - rowStartMs) / 1000
    }];
  });
}

export function coveredDurationSeconds(intervals: WeightedRecordInterval[]): number {
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs);
  let coveredMs = 0;
  let currentStart = -1;
  let currentEnd = -1;
  for (const interval of sorted) {
    if (currentStart < 0) {
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
    } else if (interval.startMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.endMs);
    } else {
      coveredMs += currentEnd - currentStart;
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
    }
  }
  if (currentStart >= 0) coveredMs += currentEnd - currentStart;
  return coveredMs / 1000;
}

export function sustainedThirtySecondPeak(
  intervals: WeightedRecordInterval[],
  workoutStartAt: string,
  workoutEndAt: string
): number | null {
  const startMs = Date.parse(workoutStartAt);
  const durationSeconds = Math.max(0, Math.ceil((Date.parse(workoutEndAt) - startMs) / 1000));
  if (!Number.isFinite(startMs) || durationSeconds < 30 || durationSeconds > 24 * 3600) return null;
  const perSecond = new Array<number | null>(durationSeconds).fill(null);
  for (const interval of intervals) {
    const start = Math.max(0, Math.floor((interval.startMs - startMs) / 1000));
    const end = Math.min(durationSeconds, Math.ceil((interval.endMs - startMs) / 1000));
    for (let second = start; second < end; second += 1) perSecond[second] = interval.value;
  }
  let peak: number | null = null;
  for (let start = 0; start + 30 <= perSecond.length; start += 1) {
    const values = perSecond.slice(start, start + 30).filter((value): value is number => value !== null);
    if (values.length < 24) continue;
    const value = median(values);
    if (value !== null && (peak === null || value > peak)) peak = value;
  }
  return peak;
}

export function summaryFromRecords(
  rows: RecordRow[],
  unit: string | null,
  workoutStartAt: string,
  workoutEndAt: string,
  converter: (value: number, unit: string | null) => number = (value) => value
): NumericSeriesSummary {
  const intervals = weightedRecordIntervals(
    rows,
    workoutStartAt,
    workoutEndAt,
    (value, rowUnit) => converter(value, rowUnit ?? unit)
  );
  if (intervals.length === 0) {
    return {
      average: null,
      minimum: null,
      maximum: null,
      sampleCount: 0,
      firstAt: null,
      lastAt: null,
      coefficientOfVariation: null,
      coveredDurationSeconds: null
    };
  }
  const totalWeight = intervals.reduce((total, interval) => total + interval.durationSeconds, 0);
  const weightedAverage = intervals.reduce(
    (total, interval) => total + interval.value * interval.durationSeconds,
    0
  ) / totalWeight;
  const weightedVariance = intervals.reduce(
    (total, interval) => total + (interval.value - weightedAverage) ** 2 * interval.durationSeconds,
    0
  ) / totalWeight;
  const values = intervals.map((interval) => interval.value);
  return {
    average: weightedAverage,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    sampleCount: values.length,
    firstAt: new Date(Math.min(...intervals.map((interval) => interval.startMs))).toISOString(),
    lastAt: new Date(Math.max(...intervals.map((interval) => interval.endMs))).toISOString(),
    coefficientOfVariation: weightedAverage === 0 ? null : Math.sqrt(weightedVariance) / Math.abs(weightedAverage),
    coveredDurationSeconds: coveredDurationSeconds(intervals)
  };
}

export function fallbackStatisticSummary(
  statistic: StatisticRow | null,
  workoutStartAt: string,
  workoutEndAt: string,
  converter: (value: number, unit: string | null) => number = (value) => value
): NumericSeriesSummary {
  if (statistic === null || statistic.averageValue === null) {
    return {
      average: null,
      minimum: null,
      maximum: null,
      sampleCount: 0,
      firstAt: null,
      lastAt: null,
      coefficientOfVariation: null,
      coveredDurationSeconds: null
    };
  }
  const average = statistic.averageValue;
  const convertedAverage = converter(average, statistic.unit);
  const convertedMinimum =
    statistic.minimumValue === null ? null : converter(statistic.minimumValue, statistic.unit);
  const convertedMaximum =
    statistic.maximumValue === null ? null : converter(statistic.maximumValue, statistic.unit);
  return {
    average: convertedAverage,
    minimum: convertedMinimum,
    maximum: convertedMaximum,
    // Aggregate statistics do not expose sample density; keep count low so
    // eligibility does not treat them as full series coverage.
    sampleCount: 1,
    firstAt: workoutStartAt,
    lastAt: workoutEndAt,
    coefficientOfVariation:
      convertedMinimum !== null && convertedMaximum !== null && convertedAverage !== 0
        ? Math.abs(convertedMaximum - convertedMinimum) / (4 * Math.abs(convertedAverage))
        : null,
    coveredDurationSeconds: null
  };
}

export function defaultRequest(options: RecomputeOptions = {}): RecomputeRequest {
  return {
    evaluatedAt: normalizeInstant(options.evaluatedAt ?? appNow(), "evaluatedAt"),
    timezoneIdentifier: options.timezoneIdentifier ?? "Asia/Shanghai",
    featureConfig: options.featureConfig ?? defaultFeatureConfig,
    modelConfig: options.modelConfig ?? defaultRaiModelConfig,
    validationMode: options.validationMode ?? "off"
  };
}
