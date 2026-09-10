import type { DatabaseSync } from "node:sqlite";

import { nullableNumber } from "./read-utils.js";

export interface MetricInterval {
  value: number;
  startMs: number;
  endMs: number;
}

export interface StoredMetricSeries {
  unit: string;
  totalSamples: number;
  points: Array<{ timestamp: string; offsetSeconds: number; value: number }>;
}

export interface StoredRoutePoint {
  latitude: number;
  longitude: number;
  elevationMeters: number | null;
  speedMetersPerSecond: number | null;
  timestamp: string | null;
}

export interface StoredWorkoutSplit {
  index: number;
  distanceMeters: number;
  durationSeconds: number;
  averagePaceSecondsPerKm: number;
  averageHeartRateBpm: number | null;
  averageCadenceSpm: number | null;
}

export interface StoredSeriesSession {
  id: string;
  startedAt: string;
  endedAt: string;
  sourceCategory: string;
  sourceName: string;
  distanceKm: number | null;
}

export class SqliteSeriesReadRepository {
  constructor(private readonly database: DatabaseSync) {}

  sessionForSeries(trainingSessionId: string): StoredSeriesSession | null {
    const session = this.database
      .prepare(`
        SELECT ts.id, ts.anchor_start_at, ts.anchor_end_at, ts.anchor_distance_km,
          w.source_category, w.source_name
        FROM training_sessions ts
        JOIN workouts w ON w.id = ts.canonical_workout_id
        WHERE ts.id = ?
      `)
      .get(trainingSessionId) as Record<string, unknown> | undefined;
    if (!session) return null;
    return {
      id: String(session.id),
      startedAt: String(session.anchor_start_at),
      endedAt: String(session.anchor_end_at),
      sourceCategory: String(session.source_category),
      sourceName: String(session.source_name),
      distanceKm: nullableNumber(session.anchor_distance_km)
    };
  }

  routePoints(workoutId: string): StoredRoutePoint[] {
    const points = this.database
      .prepare(`
        WITH numbered AS (
          SELECT rp.latitude, rp.longitude, rp.elevation_meters, rp.speed_mps, rp.timestamp,
            ROW_NUMBER() OVER (ORDER BY rp.sequence) AS sample_number,
            COUNT(*) OVER () AS total_samples
          FROM workout_routes wr
          JOIN route_points rp ON rp.route_id = wr.id
          WHERE wr.workout_id = ?
        )
        SELECT latitude, longitude, elevation_meters, speed_mps, timestamp
        FROM numbered
        WHERE (sample_number - 1) % MAX(1, (total_samples + 499) / 500) = 0
          OR sample_number = total_samples
        ORDER BY sample_number
      `)
      .all(workoutId) as Record<string, unknown>[];
    return points.map((row) => ({
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      elevationMeters: nullableNumber(row.elevation_meters),
      speedMetersPerSecond: nullableNumber(row.speed_mps),
      timestamp: typeof row.timestamp === "string" ? row.timestamp : null
    }));
  }

  metricSeries(
    type: string,
    fallbackUnit: string,
    startedAt: string,
    endedAt: string,
    sourceName: string,
    transform: (value: number, row: Record<string, unknown>) => number = (value) => value,
    forceFallbackUnit = false
  ): StoredMetricSeries {
    const rows = this.database
      .prepare(`
        WITH deduplicated AS (
          SELECT DISTINCT start_at, end_at, value_numeric, unit
          FROM health_records
          WHERE type = ?
            AND source_name = ?
            AND start_at >= ?
            AND start_at <= ?
            AND value_numeric IS NOT NULL
        ), numbered AS (
          SELECT start_at, end_at, value_numeric, unit,
            ROW_NUMBER() OVER (ORDER BY start_at) AS sample_number,
            COUNT(*) OVER () AS total_samples,
            FIRST_VALUE(unit) OVER (ORDER BY start_at) AS first_unit,
            ROW_NUMBER() OVER (ORDER BY value_numeric DESC, start_at) AS peak_rank
          FROM deduplicated
        )
        SELECT start_at, end_at, value_numeric, unit, total_samples, first_unit
        FROM numbered
        WHERE (sample_number - 1) % MAX(1, (total_samples + 598) / 599) = 0
          OR sample_number = total_samples
          OR peak_rank = 1
        ORDER BY sample_number
      `)
      .all(type, sourceName, startedAt, endedAt) as Record<string, unknown>[];
    return {
      unit: !forceFallbackUnit && typeof rows[0]?.first_unit === "string" ? rows[0].first_unit : fallbackUnit,
      totalSamples: Number(rows[0]?.total_samples ?? 0),
      points: rows
        .map((row) => ({
          timestamp: String(row.start_at),
          offsetSeconds: Math.max(0, (Date.parse(String(row.start_at)) - Date.parse(startedAt)) / 1000),
          value: transform(Number(row.value_numeric), row)
        }))
        .filter((point) => Number.isFinite(point.offsetSeconds) && Number.isFinite(point.value))
    };
  }

  metricIntervals(
    type: string,
    sourceName: string,
    startedAt: string,
    endedAt: string,
    transform: (value: number, unit: string | null) => number = (value) => value
  ): MetricInterval[] {
    const workoutStartMs = Date.parse(startedAt);
    const workoutEndMs = Date.parse(endedAt);
    const rows = this.database
      .prepare(`
        SELECT start_at, end_at, value_numeric, unit
        FROM (
          SELECT DISTINCT start_at, end_at, value_numeric, unit
          FROM health_records
          WHERE type = ? AND source_name = ? AND value_numeric IS NOT NULL
            AND start_at < ?
            AND (
              start_at >= ?
              OR (
                julianday(end_at) > julianday(start_at)
                AND julianday(end_at) > julianday(?)
              )
            )
        )
        ORDER BY start_at
      `)
      .all(type, sourceName, endedAt, startedAt, startedAt) as unknown as Record<string, unknown>[];
    return rows.flatMap((row, index) => {
      const sourceStartMs = Date.parse(String(row.start_at));
      const startMs = Math.max(workoutStartMs, sourceStartMs);
      const recordedEndMs = Date.parse(String(row.end_at));
      const nextStartMs = Date.parse(String(rows[index + 1]?.start_at ?? endedAt));
      const inferredEndMs =
        recordedEndMs > sourceStartMs ? recordedEndMs : Math.min(nextStartMs, sourceStartMs + 30_000);
      const endMs = Math.min(workoutEndMs, inferredEndMs);
      const value = transform(Number(row.value_numeric), typeof row.unit === "string" ? row.unit : null);
      return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && Number.isFinite(value)
        ? [{ value, startMs, endMs }]
        : [];
    });
  }

  routeElevationSeries(trainingSessionId: string): StoredMetricSeries {
    const rows = this.database
      .prepare(`
        WITH numbered AS (
          SELECT ts.anchor_start_at, rp.timestamp, rp.elevation_meters,
            ROW_NUMBER() OVER (ORDER BY rp.sequence) AS sample_number,
            COUNT(*) OVER () AS total_samples
          FROM training_sessions ts
          JOIN workout_routes wr ON wr.workout_id = ts.canonical_workout_id
          JOIN route_points rp ON rp.route_id = wr.id
          WHERE ts.id = ? AND rp.timestamp IS NOT NULL AND rp.elevation_meters IS NOT NULL
        )
        SELECT anchor_start_at, timestamp, elevation_meters, total_samples
        FROM numbered
        WHERE (sample_number - 1) % MAX(1, (total_samples + 599) / 600) = 0
          OR sample_number = total_samples
        ORDER BY sample_number
      `)
      .all(trainingSessionId) as Record<string, unknown>[];
    const startedAt = typeof rows[0]?.anchor_start_at === "string" ? rows[0].anchor_start_at : "";
    return {
      unit: "m",
      totalSamples: Number(rows[0]?.total_samples ?? 0),
      points: rows
        .map((row) => ({
          timestamp: String(row.timestamp),
          offsetSeconds: Math.max(0, (Date.parse(String(row.timestamp)) - Date.parse(startedAt)) / 1000),
          value: Number(row.elevation_meters)
        }))
        .filter((point) => Number.isFinite(point.offsetSeconds) && Number.isFinite(point.value))
    };
  }

  workoutSplits(
    startedAt: string,
    endedAt: string,
    sourceName: string,
    distanceKm: number | null
  ): StoredWorkoutSplit[] {
    if (distanceKm === null || distanceKm <= 0) return [];
    const startedMs = Date.parse(startedAt);
    const endedMs = Date.parse(endedAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= startedMs) return [];

    const rawSpeed = this.metricIntervals(
      "HKQuantityTypeIdentifierRunningSpeed",
      sourceName,
      startedAt,
      endedAt,
      (value, unit) =>
        unit === "km/hr" || unit === "km/h"
          ? value / 3.6
          : unit === "mi/hr" || unit === "mph"
            ? value * 0.44704
            : value
    ).filter((sample) => sample.value > 0 && 1000 / sample.value >= 150 && 1000 / sample.value <= 900);
    let speedCoveredUntilMs = startedMs;
    const speed = rawSpeed.flatMap((sample) => {
      const startMs = Math.max(sample.startMs, speedCoveredUntilMs);
      speedCoveredUntilMs = Math.max(speedCoveredUntilMs, sample.endMs);
      return sample.endMs > startMs ? [{ ...sample, startMs }] : [];
    });
    const rawDistance = speed.reduce(
      (total, sample) => total + (sample.value * (sample.endMs - sample.startMs)) / 1000,
      0
    );
    const officialDistance = distanceKm * 1000;
    if (speed.length === 0 || rawDistance <= 0 || officialDistance < 1) return [];

    let coveredDurationMs = 0;
    let coveredUntilMs = startedMs;
    for (const sample of speed) {
      const uncoveredStartMs = Math.max(coveredUntilMs, sample.startMs);
      if (sample.endMs > uncoveredStartMs) coveredDurationMs += sample.endMs - uncoveredStartMs;
      coveredUntilMs = Math.max(coveredUntilMs, sample.endMs);
    }
    const durationCoverage = coveredDurationMs / (endedMs - startedMs);
    const distanceScale = officialDistance / rawDistance;
    if (durationCoverage < 0.8 || distanceScale < 0.75 || distanceScale > 1.25) return [];

    const boundaries: number[] = [startedMs];
    let accumulated = 0;
    let nextBoundary = 1000;
    for (const sample of speed) {
      const sampleDistance = ((sample.value * (sample.endMs - sample.startMs)) / 1000) * distanceScale;
      while (nextBoundary < officialDistance && accumulated + sampleDistance >= nextBoundary) {
        const fraction = (nextBoundary - accumulated) / sampleDistance;
        boundaries.push(sample.startMs + (sample.endMs - sample.startMs) * fraction);
        nextBoundary += 1000;
      }
      accumulated += sampleDistance;
    }
    boundaries.push(endedMs);

    const heartRate = this.metricIntervals(
      "HKQuantityTypeIdentifierHeartRate",
      sourceName,
      startedAt,
      endedAt
    );
    const steps = this.metricIntervals(
      "HKQuantityTypeIdentifierStepCount",
      sourceName,
      startedAt,
      endedAt
    );
    const weightedAverage = (samples: MetricInterval[], startMs: number, endMs: number): number | null => {
      let weighted = 0;
      let covered = 0;
      for (const sample of samples) {
        const overlap = Math.max(0, Math.min(endMs, sample.endMs) - Math.max(startMs, sample.startMs));
        weighted += sample.value * overlap;
        covered += overlap;
      }
      return covered > 0 ? weighted / covered : null;
    };
    const cadence = (startMs: number, endMs: number): number | null => {
      let stepCount = 0;
      for (const sample of steps) {
        const overlap = Math.max(0, Math.min(endMs, sample.endMs) - Math.max(startMs, sample.startMs));
        stepCount += (sample.value * overlap) / (sample.endMs - sample.startMs);
      }
      const durationSeconds = (endMs - startMs) / 1000;
      return stepCount > 0 && durationSeconds > 0 ? stepCount / (durationSeconds / 60) : null;
    };

    return boundaries
      .slice(0, -1)
      .map((startMs, index) => {
        const endMs = boundaries[index + 1]!;
        const distanceMeters = Math.min(1000, officialDistance - index * 1000);
        const durationSeconds = (endMs - startMs) / 1000;
        return {
          index: index + 1,
          distanceMeters,
          durationSeconds,
          averagePaceSecondsPerKm: durationSeconds / (distanceMeters / 1000),
          averageHeartRateBpm: weightedAverage(heartRate, startMs, endMs),
          averageCadenceSpm: cadence(startMs, endMs)
        };
      })
      .filter((split) => split.distanceMeters > 0 && split.durationSeconds > 0);
  }
}
