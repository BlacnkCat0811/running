import { DATABASE_TIMEZONE } from "@rai/contracts";
import type { DatabaseSync } from "node:sqlite";

import type {
  DailyTrainingMetric,
  StimulusType,
  TrainingPeriodSummary,
  TrainingStatisticsGranularity,
  WorkoutTrainingLoad
} from "@rai/contracts";

import { localDateInTimezone, nextPeriod, periodStart, previousPeriod, shiftDate } from "./date-utils.js";
import { nullableNumber, parseJson } from "./read-utils.js";

export interface LoadTimelineComponent {
  localDate: string;
  internalLoad: number | null;
  paceLoad: number | null;
  compositeLoad: number;
}

export class SqliteTrainingStatisticsReadRepository {
  constructor(private readonly database: DatabaseSync) {}

  latestMetric(): DailyTrainingMetric | null {
    const row = this.database
      .prepare(`SELECT * FROM active_daily_training_metrics ORDER BY local_date DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    return row ? mapDailyMetric(row) : null;
  }

  earliestLoadLocalDate(): string | null {
    const firstRow = this.database
      .prepare("SELECT MIN(local_date) AS value FROM active_workout_training_loads")
      .get() as Record<string, unknown>;
    return typeof firstRow.value === "string" ? firstRow.value : null;
  }

  metricsBetween(start: string, end: string): DailyTrainingMetric[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM active_daily_training_metrics
        WHERE local_date BETWEEN ? AND ? ORDER BY local_date
      `)
      .all(start, end) as unknown as Record<string, unknown>[];
    return rows.map(mapDailyMetric);
  }

  loadComponentsBetween(start: string, end: string): LoadTimelineComponent[] {
    const componentRows = this.database
      .prepare(`
        SELECT local_date,
          SUM(internal_load) AS internal_load,
          SUM(pace_load) AS pace_load,
          SUM(training_load) AS composite_load,
          SUM(CASE WHEN internal_load IS NOT NULL THEN 1 ELSE 0 END) AS internal_count,
          SUM(CASE WHEN pace_load IS NOT NULL THEN 1 ELSE 0 END) AS pace_count
        FROM active_workout_training_loads
        WHERE local_date BETWEEN ? AND ?
        GROUP BY local_date ORDER BY local_date
      `)
      .all(start, end) as unknown as Record<string, unknown>[];
    return componentRows.map((row) => ({
      localDate: String(row.local_date),
      internalLoad: Number(row.internal_count ?? 0) > 0 ? Number(row.internal_load) : null,
      paceLoad: Number(row.pace_count ?? 0) > 0 ? Number(row.pace_load) : null,
      compositeLoad: Number(row.composite_load ?? 0)
    }));
  }

  loadTimeline(days: number): {
    days: DailyTrainingMetric[];
    components: LoadTimelineComponent[];
  } | null {
    const latest = this.latestMetric();
    if (!latest) return null;
    const start = shiftDate(latest.localDate, -days + 1);
    return {
      days: this.metricsBetween(start, latest.localDate),
      components: this.loadComponentsBetween(start, latest.localDate)
    };
  }

  overview(timezone: string = DATABASE_TIMEZONE): {
    status: DailyTrainingMetric | null;
    asOf: string;
    week: TrainingPeriodSummary;
    month: TrainingPeriodSummary;
    year: TrainingPeriodSummary;
    rolling7Days: TrainingPeriodSummary;
    rolling28Days: TrainingPeriodSummary;
  } {
    const latest = this.latestMetric();
    const asOf = latest?.localDate ?? localDateInTimezone(timezone);
    const rolling7Days = this.periodSummary("rolling", shiftDate(asOf, -6), asOf, asOf);
    return {
      status: latest,
      asOf,
      week: this.periodSummary("week", periodStart(asOf, "week"), asOf, asOf),
      month: this.periodSummary("month", periodStart(asOf, "month"), asOf, asOf),
      year: this.periodSummary("year", periodStart(asOf, "year"), asOf, asOf),
      rolling7Days,
      rolling28Days: this.periodSummary("rolling", shiftDate(asOf, -27), asOf, asOf)
    };
  }

  history(granularity: TrainingStatisticsGranularity, limit: number): TrainingPeriodSummary[] {
    const latest = this.latestMetric();
    if (!latest) return [];
    const items: TrainingPeriodSummary[] = [];
    const first = this.earliestLoadLocalDate();
    const earliestPeriod = first
      ? periodStart(first, granularity)
      : periodStart(latest.localDate, granularity);
    let start = periodStart(latest.localDate, granularity);
    for (let index = 0; index < limit; index += 1) {
      if (granularity === "year" && start < earliestPeriod) break;
      const next = nextPeriod(start, granularity);
      const naturalEnd = shiftDate(next, -1);
      const end = index === 0 && latest.localDate < naturalEnd ? latest.localDate : naturalEnd;
      items.push(this.periodSummary(granularity, start, end, latest.localDate));
      start = previousPeriod(start, granularity);
    }
    return items;
  }

  periodSummary(
    granularity: TrainingPeriodSummary["granularity"],
    startDate: string,
    endDate: string,
    asOf: string
  ): TrainingPeriodSummary {
    const rows = this.database
      .prepare(`
        SELECT load.*
        FROM active_workout_training_loads load
        WHERE load.local_date BETWEEN ? AND ? ORDER BY load.local_date
      `)
      .all(startDate, endDate) as unknown as Record<string, unknown>[];
    const distance = rows.reduce((sum, row) => sum + Number(row.distance_km ?? 0), 0);
    const duration = rows.reduce((sum, row) => sum + Number(row.duration_seconds ?? 0), 0);
    const load = rows.reduce((sum, row) => sum + Number(row.training_load ?? 0), 0);
    const weightedHrSeconds = rows.reduce(
      (sum, row) => sum + Number(row.average_heart_rate_bpm ?? 0) * Number(row.duration_seconds ?? 0),
      0
    );
    const hrSeconds = rows.reduce(
      (sum, row) =>
        sum + (nullableNumber(row.average_heart_rate_bpm) === null ? 0 : Number(row.duration_seconds ?? 0)),
      0
    );
    const types = new Map<string, { workoutCount: number; distanceKm: number; trainingLoad: number }>();
    const stimuli = new Map<string, { workoutCount: number; distanceKm: number; trainingLoad: number }>();
    for (const row of rows) {
      const key = String(row.session_type);
      const value = types.get(key) ?? { workoutCount: 0, distanceKm: 0, trainingLoad: 0 };
      value.workoutCount += 1;
      value.distanceKm += Number(row.distance_km ?? 0);
      value.trainingLoad += Number(row.training_load ?? 0);
      types.set(key, value);
      const stimulusKey = String(row.stimulus_type ?? "unclassified");
      const stimulus = stimuli.get(stimulusKey) ?? { workoutCount: 0, distanceKm: 0, trainingLoad: 0 };
      stimulus.workoutCount += 1;
      stimulus.distanceKm += Number(row.distance_km ?? 0);
      stimulus.trainingLoad += Number(row.training_load ?? 0);
      stimuli.set(stimulusKey, stimulus);
    }
    const naturalEnd =
      granularity === "rolling" ? endDate : shiftDate(nextPeriod(startDate, granularity), -1);
    return {
      granularity,
      periodStart: startDate,
      periodEnd: endDate,
      isComplete: endDate >= naturalEnd && endDate < asOf,
      distanceMeters: distance * 1000,
      durationSeconds: duration,
      workoutCount: rows.length,
      totalLoad: load,
      elevationGainMeters: rows.reduce((sum, row) => sum + Number(row.elevation_gain_meters ?? 0), 0),
      longestRunMeters: rows.reduce((max, row) => Math.max(max, Number(row.distance_km ?? 0) * 1000), 0),
      averagePaceSecondsPerKm: distance > 0 ? duration / distance : null,
      averageHeartRate: hrSeconds > 0 ? weightedHrSeconds / hrSeconds : null,
      loadConfidence:
        load > 0
          ? rows.reduce((sum, row) => sum + Number(row.confidence) * Number(row.training_load ?? 0), 0) /
            load
          : null,
      dataCompleteness: rows.length
        ? rows.filter((row) => row.load_source !== "session_type").length / rows.length
        : 0,
      comparison: this.periodComparison(granularity, startDate, endDate, {
        distance,
        duration,
        count: rows.length,
        load
      }),
      typeDistribution: [...types].map(([sessionType, value]) => ({
        sessionType: sessionType as WorkoutTrainingLoad["sessionType"],
        workoutCount: value.workoutCount,
        distanceMeters: value.distanceKm * 1000,
        load: value.trainingLoad
      })),
      stimulusDistribution: [...stimuli].map(([stimulusType, value]) => ({
        stimulusType: stimulusType as StimulusType,
        workoutCount: value.workoutCount,
        distanceMeters: value.distanceKm * 1000,
        load: value.trainingLoad
      }))
    };
  }

  private periodComparison(
    granularity: TrainingPeriodSummary["granularity"],
    start: string,
    end: string,
    current: { distance: number; duration: number; count: number; load: number }
  ): TrainingPeriodSummary["comparison"] {
    const days =
      Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
    const naturalEnd = granularity === "rolling" ? end : shiftDate(nextPeriod(start, granularity), -1);
    const previousStart =
      granularity === "rolling" ? shiftDate(start, -days) : previousPeriod(start, granularity);
    const previousEnd =
      granularity !== "rolling" && end !== naturalEnd
        ? shiftDate(previousStart, days - 1)
        : shiftDate(start, -1);
    const row = this.database
      .prepare(`
        SELECT COALESCE(SUM(distance_km),0) distance,
               COALESCE(SUM(duration_seconds),0) duration,
               COUNT(*) count,
               COALESCE(SUM(training_load),0) load
        FROM active_workout_training_loads
        WHERE local_date BETWEEN ? AND ?
      `)
      .get(previousStart, previousEnd) as Record<string, unknown>;
    const fraction = (value: number, previous: number): number | null =>
      previous > 0 ? (value - previous) / previous : null;
    return {
      distanceChangeFraction: fraction(current.distance, Number(row.distance)),
      durationChangeFraction: fraction(current.duration, Number(row.duration)),
      workoutCountChangeFraction: fraction(current.count, Number(row.count)),
      loadChangeFraction: fraction(current.load, Number(row.load))
    };
  }
}

function mapDailyMetric(row: Record<string, unknown>): DailyTrainingMetric {
  return {
    localDate: String(row.local_date),
    distanceMeters: Number(row.distance_km) * 1000,
    durationSeconds: Number(row.duration_seconds),
    workoutCount: Number(row.workout_count),
    load: Number(row.daily_load),
    current7dLoad: Number(row.current_7d_load),
    previous7dLoad: Number(row.previous_7d_load),
    acuteEwma: Number(row.acute_ewma),
    chronicEwma: Number(row.chronic_ewma),
    loadRatio: nullableNumber(row.load_ratio),
    rampRate: Number(row.ramp_rate ?? 0),
    monotony: nullableNumber(row.monotony),
    strain: nullableNumber(row.strain),
    recoveryEvidence: nullableNumber(row.recovery_evidence),
    trainingStatus: String(row.training_status) as DailyTrainingMetric["trainingStatus"],
    loadConfidence: nullableNumber(row.confidence),
    statusExplanations: parseJson<DailyTrainingMetric["statusExplanations"]>(row.explanation_json, [])
  };
}
