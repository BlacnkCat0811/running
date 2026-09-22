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

/**
 * The scaled speed track every boundary-based measure shares.
 *
 * `samples[].meters` is already scaled so the track totals `officialMeters`;
 * callers only need to sum the samples covered by an interval.
 */
export interface StoredSpeedSample {
  startMs: number;
  endMs: number;
  metersPerSecond: number;
  meters: number;
}

export interface StoredSpeedTrack {
  samples: StoredSpeedSample[];
  officialMeters: number;
  scale: number;
}

/** A measured interval on the speed track. */
export interface StoredMeasuredSegment {
  startMs: number;
  endMs: number;
  durationSeconds: number;
  distanceMeters: number;
  averagePaceSecondsPerKm: number | null;
  averageHeartRateBpm: number | null;
  averageCadenceSpm: number | null;
}

/** A Watch-recorded lap/segment boundary (`duration > 0` only). */
export interface StoredWorkoutEventInterval {
  type: string;
  startMs: number;
  endMs: number;
}

export interface StoredSeriesSession {
  id: string;
  canonicalWorkoutId: string;
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
        SELECT ts.id, ts.canonical_workout_id, ts.anchor_start_at, ts.anchor_end_at,
          ts.anchor_distance_km,
          w.source_category, w.source_name
        FROM training_sessions ts
        JOIN workouts w ON w.id = ts.canonical_workout_id
        WHERE ts.id = ?
      `)
      .get(trainingSessionId) as Record<string, unknown> | undefined;
    if (!session) return null;
    return {
      id: String(session.id),
      canonicalWorkoutId: String(session.canonical_workout_id),
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
            ROW_NUMBER() OVER (ORDER BY COALESCE(wr.start_at, rp.timestamp), wr.id, rp.sequence) AS sample_number,
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
            ROW_NUMBER() OVER (ORDER BY COALESCE(wr.start_at, rp.timestamp), wr.id, rp.sequence) AS sample_number,
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

  /**
   * The scaled speed track that every boundary-based measure shares.
   *
   * `samples[].meters` is already scaled so the whole track totals
   * `officialMeters`; callers only sum the samples an interval covers.
   *
   * Returns `null` when the run has no usable speed samples, or when the
   * recorded track disagrees with the official distance/duration past the
   * tolerance — in that case any boundary measure would be fiction, and the
   * honest answer is "no segments" rather than invented ones.
   */
  speedTrack(
    startedAt: string,
    endedAt: string,
    sourceName: string,
    distanceKm: number | null
  ): StoredSpeedTrack | null {
    if (distanceKm === null || distanceKm <= 0) return null;
    const startedMs = Date.parse(startedAt);
    const endedMs = Date.parse(endedAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= startedMs) return null;

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
    const intervals = rawSpeed.flatMap((sample) => {
      const startMs = Math.max(sample.startMs, speedCoveredUntilMs);
      speedCoveredUntilMs = Math.max(speedCoveredUntilMs, sample.endMs);
      return sample.endMs > startMs ? [{ ...sample, startMs }] : [];
    });
    const rawDistance = intervals.reduce(
      (total, sample) => total + (sample.value * (sample.endMs - sample.startMs)) / 1000,
      0
    );
    const officialMeters = distanceKm * 1000;
    if (intervals.length === 0 || rawDistance <= 0 || officialMeters < 1) return null;

    let coveredDurationMs = 0;
    let coveredUntilMs = startedMs;
    for (const sample of intervals) {
      const uncoveredStartMs = Math.max(coveredUntilMs, sample.startMs);
      if (sample.endMs > uncoveredStartMs) coveredDurationMs += sample.endMs - uncoveredStartMs;
      coveredUntilMs = Math.max(coveredUntilMs, sample.endMs);
    }
    const durationCoverage = coveredDurationMs / (endedMs - startedMs);
    const scale = officialMeters / rawDistance;
    if (durationCoverage < 0.8 || scale < 0.75 || scale > 1.25) return null;

    return {
      officialMeters,
      scale,
      samples: intervals.map((sample) => ({
        startMs: sample.startMs,
        endMs: sample.endMs,
        metersPerSecond: sample.value,
        meters: ((sample.value * (sample.endMs - sample.startMs)) / 1000) * scale
      }))
    };
  }

  /** Heart-rate and step-count intervals plus the averages derived from them. */
  private intervalAverages(startedAt: string, endedAt: string, sourceName: string) {
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
    const weightedAverage = (startMs: number, endMs: number): number | null => {
      let weighted = 0;
      let covered = 0;
      for (const sample of heartRate) {
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
    return { heartRate, steps, weightedAverage, cadence };
  }

  /**
   * Measure arbitrary ascending boundaries against the scaled speed track.
   *
   * This is the shared measurer behind both the kilometre split and the
   * plan/event-derived segments — one code path keeps the two numbers
   * comparable. Boundaries are clamped to the workout window and to each other;
   * empty intervals are dropped. Returns `[]` when the track itself is unusable.
   */
  measureSegments(
    startedAt: string,
    endedAt: string,
    sourceName: string,
    distanceKm: number | null,
    boundaries: number[]
  ): StoredMeasuredSegment[] {
    const track = this.speedTrack(startedAt, endedAt, sourceName, distanceKm);
    if (!track) return [];
    const startedMs = Date.parse(startedAt);
    const endedMs = Date.parse(endedAt);
    const ordered = boundaries
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.max(startedMs, Math.min(endedMs, value)))
      .sort((left, right) => left - right);

    const metersAt = (timeMs: number): number => {
      let meters = 0;
      for (const sample of track.samples) {
        if (timeMs <= sample.startMs) break;
        meters +=
          sample.meters * ((Math.min(timeMs, sample.endMs) - sample.startMs) / (sample.endMs - sample.startMs));
      }
      return meters;
    };
    const { weightedAverage, cadence } = this.intervalAverages(startedAt, endedAt, sourceName);

    const segments: StoredMeasuredSegment[] = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const startMs = ordered[index]!;
      const endMs = ordered[index + 1]!;
      if (endMs <= startMs) continue;
      const durationSeconds = (endMs - startMs) / 1000;
      const distanceMeters = Math.max(0, metersAt(endMs) - metersAt(startMs));
      segments.push({
        startMs,
        endMs,
        durationSeconds,
        distanceMeters,
        averagePaceSecondsPerKm: distanceMeters > 0 ? durationSeconds / (distanceMeters / 1000) : null,
        averageHeartRateBpm: weightedAverage(startMs, endMs),
        averageCadenceSpm: cadence(startMs, endMs)
      });
    }
    return segments;
  }

  /**
   * The Watch's own lap / segment / marker events for a workout.
   *
   * `event_at` is the interval **start**; a nonzero `duration_seconds` marks a
   * real segment — Apple's wording for `HKWorkoutEventTypeLap` is "newer lap
   * events use the date interval to mark the start and the duration of the
   * lap". Zero-duration lap events are the legacy form whose date marks the
   * **end** of a lap, so they come back as zero-width boundaries (`endMs ===
   * startMs`) and the caller tiles them.
   *
   * Pause / resume events are deliberately excluded: they carry no distance.
   */
  workoutEventIntervals(workoutId: string): StoredWorkoutEventInterval[] {
    const rows = this.database
      .prepare(`
        SELECT type, event_at, duration_seconds
        FROM workout_events
        WHERE workout_id = ?
        ORDER BY ordinal
      `)
      .all(workoutId) as Record<string, unknown>[];
    return rows.flatMap((row) => {
      const type = typeof row.type === "string" ? row.type : "";
      if (!/(Lap|Segment|Marker)$/.test(type)) return [];
      const startMs = Date.parse(String(row.event_at));
      if (!Number.isFinite(startMs)) return [];
      const durationSeconds = nullableNumber(row.duration_seconds) ?? 0;
      return [{ type, startMs, endMs: startMs + (durationSeconds > 0 ? durationSeconds * 1000 : 0) }];
    });
  }

  /**
   * A workout's raw `metadata_json`, or `null` when the row is gone.
   *
   * The steps a structured workout was actually run with are **not** a table:
   * the export carries them as one metadata entry on the workout, which is how
   * `HKWorkout.workoutActivities` reaches the database at all. Reading that
   * entry back here keeps this repository a data accessor — deciding what the
   * entry means is the caller's job (`measuredStepsOf` in the API) — and
   * promoting it to columns would buy nothing until something other than the
   * segment panel needs per-step rows.
   */
  workoutMetadata(workoutId: string): string | null {
    const row = this.database
      .prepare("SELECT metadata_json AS metadataJson FROM workouts WHERE id = ?")
      .get(workoutId) as { metadataJson?: unknown } | undefined;
    return typeof row?.metadataJson === "string" ? row.metadataJson : null;
  }

  workoutSplits(
    startedAt: string,
    endedAt: string,
    sourceName: string,
    distanceKm: number | null
  ): StoredWorkoutSplit[] {
    const track = this.speedTrack(startedAt, endedAt, sourceName, distanceKm);
    if (!track) return [];
    const startedMs = Date.parse(startedAt);
    const endedMs = Date.parse(endedAt);
    const officialDistance = track.officialMeters;

    const boundaries: number[] = [startedMs];
    let accumulated = 0;
    let nextBoundary = 1000;
    for (const sample of track.samples) {
      const sampleDistance = sample.meters;
      while (nextBoundary < officialDistance && accumulated + sampleDistance >= nextBoundary) {
        const fraction = (nextBoundary - accumulated) / sampleDistance;
        boundaries.push(sample.startMs + (sample.endMs - sample.startMs) * fraction);
        nextBoundary += 1000;
      }
      accumulated += sampleDistance;
    }
    boundaries.push(endedMs);

    const { weightedAverage, cadence } = this.intervalAverages(startedAt, endedAt, sourceName);
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
          averageHeartRateBpm: weightedAverage(startMs, endMs),
          averageCadenceSpm: cadence(startMs, endMs)
        };
      })
      .filter((split) => split.distanceMeters > 0 && split.durationSeconds > 0);
  }
}
