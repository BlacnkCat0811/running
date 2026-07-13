import type {
  DailyTrainingMetric,
  SessionType,
  TrainingLoadSource,
  TrainingPeriodSummary,
  TrainingStatisticsGranularity,
  TrainingStatusCode,
  TrainingStatusExplanation,
  WorkoutTrainingLoad,
  WorkoutZoneSummary,
  TrainingLoadBreakdown
} from "@rai/contracts";

export interface HeartRateSample { heartRate: number; durationSeconds: number }
export interface WorkoutLoadInput {
  trainingSessionId: string;
  localDate: string;
  durationSeconds: number;
  distanceMeters?: number | null;
  heartRateSamples?: HeartRateSample[];
  heartRateCoverage?: number;
  averageHeartRate?: number | null;
  restingHeartRate?: number | null;
  observedMaxHeartRate?: number | null;
  rpe?: number | null;
  sessionType?: SessionType;
  elevationGainMeters?: number | null;
  sourceConfidence?: number;
  excluded?: boolean;
  zoneSummary?: WorkoutZoneSummary | null;
  loadBreakdown?: TrainingLoadBreakdown | null;
}

export interface RecoveryEvidence { localDate: string; value: number }
export interface DailyMetricConfig {
  acuteHalfLifeDays: number;
  chronicHalfLifeDays: number;
  minimumHistoryDays: number;
  minimumWorkoutCount: number;
  minimumChronicLoad: number;
}

export const defaultDailyMetricConfig: DailyMetricConfig = {
  acuteHalfLifeDays: 7,
  chronicHalfLifeDays: 28,
  minimumHistoryDays: 21,
  minimumWorkoutCount: 6,
  minimumChronicLoad: 5
};

const typeIntensity: Record<SessionType, number> = {
  unknown: 0.48, recovery: 0.30, easy: 0.42, steady: 0.52,
  tempo: 0.70, interval: 0.80, long_run: 0.55, race: 0.86
};
const rpeIntensity = [0, 0.25, 0.30, 0.38, 0.45, 0.52, 0.60, 0.68, 0.76, 0.84, 0.90] as const;
const clamp = (value: number, low = 0, high = 1): number => Math.min(high, Math.max(low, value));
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

export function heartRateReserve(heartRate: number, restingHeartRate: number, observedMaxHeartRate: number): number | null {
  if (![heartRate, restingHeartRate, observedMaxHeartRate].every(Number.isFinite) || observedMaxHeartRate <= restingHeartRate) return null;
  return clamp((heartRate - restingHeartRate) / (observedMaxHeartRate - restingHeartRate));
}

export function trimpMinuteLoad(intensity: number): number {
  if (!Number.isFinite(intensity)) throw new Error("intensity must be finite");
  const normalized = clamp(intensity);
  return normalized * Math.exp(1.92 * normalized);
}

export function calculateWorkoutTrainingLoad(input: WorkoutLoadInput): WorkoutTrainingLoad | null {
  if (input.excluded || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) return null;
  const sessionType = input.sessionType ?? "unknown";
  const baseConfidence = clamp(input.sourceConfidence ?? 1);
  let source: TrainingLoadSource;
  let intensity: number;
  let load: number;
  let confidence: number;
  const validHrr = (hr: number): number | null => finite(input.restingHeartRate) && finite(input.observedMaxHeartRate)
    ? heartRateReserve(hr, input.restingHeartRate, input.observedMaxHeartRate) : null;
  const samples = (input.heartRateSamples ?? []).map(sample => ({ ...sample, hrr: validHrr(sample.heartRate) }))
    .filter((sample): sample is HeartRateSample & { hrr: number } => sample.hrr !== null && finite(sample.durationSeconds) && sample.durationSeconds > 0);
  const sampleCoverage = samples.reduce((sum, sample) => sum + sample.durationSeconds, 0) / input.durationSeconds;
  const declaredCoverage = finite(input.heartRateCoverage) ? input.heartRateCoverage : sampleCoverage;
  const coverage = clamp(Math.min(declaredCoverage, sampleCoverage));
  if (coverage >= 0.7 && samples.length > 0) {
    source = "heart_rate_series";
    const coveredSeconds = samples.reduce((sum, sample) => sum + sample.durationSeconds, 0);
    const observedLoad = samples.reduce((sum, sample) => sum + sample.durationSeconds / 60 * trimpMinuteLoad(sample.hrr), 0);
    load = observedLoad * input.durationSeconds / coveredSeconds;
    intensity = samples.reduce((sum, sample) => sum + sample.hrr * sample.durationSeconds, 0) / coveredSeconds;
    confidence = 0.95 * baseConfidence * coverage;
  } else {
    const averageHrr = finite(input.averageHeartRate) ? validHrr(input.averageHeartRate) : null;
    if (averageHrr !== null) {
      source = "average_heart_rate"; intensity = averageHrr; confidence = 0.8 * baseConfidence;
    } else if (finite(input.rpe) && input.rpe >= 1 && input.rpe <= 10) {
      source = "rpe"; intensity = rpeIntensity[Math.round(input.rpe)] ?? 0.48; confidence = 0.65 * baseConfidence;
    } else {
      source = "session_type"; intensity = typeIntensity[sessionType]; confidence = 0.4 * baseConfidence;
    }
    load = input.durationSeconds / 60 * trimpMinuteLoad(intensity);
  }
  const breakdown: TrainingLoadBreakdown = input.loadBreakdown ?? {
    rawHrrTrimp: source === "heart_rate_series" || source === "average_heart_rate" ? round(Math.max(0, load)) : null,
    internalLoad: source === "heart_rate_series" || source === "average_heart_rate" ? round(Math.max(0, load)) : null,
    paceLoad: null,
    distanceReferenceMeters: null,
    distanceExposureRatio: null,
    distanceFactor: 1,
    compositeLoad: round(Math.max(0, load)),
    heartRateConfidence: source === "heart_rate_series" || source === "average_heart_rate" ? round(clamp(confidence)) : 0,
    paceConfidence: 0
  };
  return {
    trainingSessionId: input.trainingSessionId, localDate: input.localDate,
    distanceMeters: finite(input.distanceMeters) ? Math.max(0, input.distanceMeters) : null,
    durationSeconds: input.durationSeconds, load: breakdown.compositeLoad, intensity: round(intensity),
    source, confidence: round(clamp(confidence)), rpe: finite(input.rpe) ? clamp(input.rpe, 1, 10) : null,
    sessionType, averageHeartRate: finite(input.averageHeartRate) ? input.averageHeartRate : null,
    elevationGainMeters: finite(input.elevationGainMeters) ? Math.max(0, input.elevationGainMeters) : null,
    stimulusType: input.zoneSummary?.stimulusType ?? "unclassified",
    breakdown,
    explanations: [{ code: `load_source_${source}`, value: round(intensity), threshold: null }]
  };
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
const parseDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const addDays = (value: string, days: number): string => { const date = parseDate(value); date.setUTCDate(date.getUTCDate() + days); return isoDate(date); };
const dateDiff = (start: string, end: string): number => Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / 86_400_000);
const sumRange = (values: number[], end: number, length: number): number => values.slice(Math.max(0, end - length + 1), end + 1).reduce((a, b) => a + b, 0);
const percentile = (values: number[], fraction: number): number | null => {
  if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? null;
};

export function classifyTrainingStatus(input: {
  historyDays: number; workoutCount: number; chronicEwma: number; loadRatio: number | null;
  rampRate: number; recoveryEvidence: number | null; strain: number | null; strainP90: number | null; daysSinceLastRun: number;
}, config = defaultDailyMetricConfig): { status: TrainingStatusCode; explanations: TrainingStatusExplanation[] } {
  const explanation = (code: string, value: number | null, threshold: number | null): TrainingStatusExplanation => ({ code, value, threshold });
  if (input.historyDays < config.minimumHistoryDays || input.workoutCount < config.minimumWorkoutCount || input.chronicEwma < config.minimumChronicLoad || input.loadRatio === null)
    return { status: "insufficient_data", explanations: [explanation("insufficient_training_history", input.historyDays, config.minimumHistoryDays)] };
  if (input.loadRatio > 1.5) return { status: "attention", explanations: [explanation("load_ratio_attention", input.loadRatio, 1.5)] };
  if (input.rampRate > 0.5) return { status: "attention", explanations: [explanation("ramp_rate_attention", input.rampRate, 0.5)] };
  if (input.recoveryEvidence !== null && input.recoveryEvidence < 0.35 && input.loadRatio >= 1.1)
    return { status: "attention", explanations: [explanation("low_recovery_with_load", input.recoveryEvidence, 0.35)] };
  if (input.loadRatio > 1.3) return { status: "high_load", explanations: [explanation("load_ratio_high", input.loadRatio, 1.3)] };
  if (input.strain !== null && input.strainP90 !== null && input.strain > input.strainP90)
    return { status: "high_load", explanations: [explanation("strain_above_personal_p90", input.strain, input.strainP90)] };
  if (input.loadRatio < 0.7 || input.daysSinceLastRun >= 7)
    return { status: "recovery", explanations: [explanation(input.daysSinceLastRun >= 7 ? "seven_days_without_run" : "load_ratio_recovery", input.daysSinceLastRun >= 7 ? input.daysSinceLastRun : input.loadRatio, input.daysSinceLastRun >= 7 ? 7 : 0.7)] };
  if (input.loadRatio >= 0.9 && input.loadRatio <= 1.3 && (input.recoveryEvidence === null || input.recoveryEvidence >= 0.45) && input.rampRate >= 0)
    return { status: "effective_stimulus", explanations: [explanation("effective_load_range", input.loadRatio, 0.9)] };
  return { status: "maintaining", explanations: [explanation("load_maintaining", input.loadRatio, null)] };
}

export function buildDailyTrainingMetrics(loads: WorkoutTrainingLoad[], throughDate: string, recovery: RecoveryEvidence[] = [], config = defaultDailyMetricConfig): DailyTrainingMetric[] {
  if (loads.length === 0) return [];
  const sorted = [...loads].sort((a, b) => a.localDate.localeCompare(b.localDate));
  const start = sorted[0]!.localDate; if (throughDate < start) return [];
  const days = Array.from({ length: dateDiff(start, throughDate) + 1 }, (_, index) => addDays(start, index));
  const byDate = new Map<string, WorkoutTrainingLoad[]>();
  for (const load of sorted) byDate.set(load.localDate, [...(byDate.get(load.localDate) ?? []), load]);
  const dailyLoads: number[] = []; const results: DailyTrainingMetric[] = [];
  const acuteAlpha = 1 - Math.exp(-Math.LN2 / config.acuteHalfLifeDays); const chronicAlpha = 1 - Math.exp(-Math.LN2 / config.chronicHalfLifeDays);
  let acute = 0, chronic = 0, workouts = 0, lastRunIndex = -1;
  for (let index = 0; index < days.length; index++) {
    const localDate = days[index]!; const items = byDate.get(localDate) ?? [];
    const load = items.reduce((sum, item) => sum + item.load, 0); dailyLoads.push(load);
    acute = acuteAlpha * load + (1 - acuteAlpha) * acute; chronic = chronicAlpha * load + (1 - chronicAlpha) * chronic;
    workouts += items.length; if (items.length > 0) lastRunIndex = index;
    const current7dLoad = sumRange(dailyLoads, index, 7); const previous7dLoad = dailyLoads.slice(Math.max(0, index - 13), Math.max(0, index - 6)).reduce((a, b) => a + b, 0);
    const floor = Math.max(10, chronic * 7 * 0.25); const rampRate = (current7dLoad - previous7dLoad) / Math.max(previous7dLoad, floor);
    const seven = dailyLoads.slice(Math.max(0, index - 6), index + 1); const mean = seven.reduce((a, b) => a + b, 0) / seven.length;
    const variance = seven.reduce((sum, value) => sum + (value - mean) ** 2, 0) / seven.length;
    const monotony = mean > 0 ? Math.min(5, variance === 0 ? 5 : mean / Math.sqrt(variance)) : null; const strain = monotony === null ? null : current7dLoad * monotony;
    const recentRecovery = recovery.filter(item => item.localDate <= localDate && dateDiff(item.localDate, localDate) <= 7).sort((a, b) => b.localDate.localeCompare(a.localDate)).slice(0, 3);
    const recoveryEvidence = recentRecovery.length ? recentRecovery.reduce((sum, item, i) => sum + clamp(item.value) * (3 - i), 0) / recentRecovery.reduce((sum, _item, i) => sum + 3 - i, 0) : null;
    const loadRatio = index + 1 >= config.minimumHistoryDays && workouts >= config.minimumWorkoutCount && chronic >= config.minimumChronicLoad ? acute / chronic : null;
    const historicalStrains = results.filter(item => dateDiff(item.localDate, localDate) <= 56).map(item => item.strain).filter(finite);
    const classified = classifyTrainingStatus({ historyDays: index + 1, workoutCount: workouts, chronicEwma: chronic, loadRatio, rampRate, recoveryEvidence, strain, strainP90: index >= 55 ? percentile(historicalStrains, 0.9) : null, daysSinceLastRun: lastRunIndex < 0 ? index + 1 : index - lastRunIndex }, config);
    const duration = items.reduce((sum, item) => sum + item.durationSeconds, 0);
    results.push({ localDate, distanceMeters: items.reduce((sum, item) => sum + (item.distanceMeters ?? 0), 0), durationSeconds: duration, workoutCount: items.length,
      load: round(load), current7dLoad: round(current7dLoad), previous7dLoad: round(previous7dLoad), acuteEwma: round(acute), chronicEwma: round(chronic), loadRatio: loadRatio === null ? null : round(loadRatio), rampRate: round(rampRate), monotony: monotony === null ? null : round(monotony), strain: strain === null ? null : round(strain), recoveryEvidence: recoveryEvidence === null ? null : round(recoveryEvidence), trainingStatus: classified.status, statusExplanations: classified.explanations,
      loadConfidence: items.length ? round(items.reduce((sum, item) => sum + item.confidence * item.load, 0) / Math.max(load, Number.EPSILON)) : null });
  }
  return results;
}

export function localDateInTimeZone(instant: string | Date, timeZone = "Asia/Shanghai"): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (!Number.isFinite(date.getTime())) throw new Error("instant must be a valid date");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function periodBounds(localDate: string, granularity: TrainingStatisticsGranularity): { start: string; end: string } {
  const date = parseDate(localDate);
  if (granularity === "week") { const weekday = date.getUTCDay(); const start = addDays(localDate, -(weekday === 0 ? 6 : weekday - 1)); return { start, end: addDays(start, 6) }; }
  if (granularity === "month") { const start = `${localDate.slice(0, 7)}-01`; const next = parseDate(start); next.setUTCMonth(next.getUTCMonth() + 1); return { start, end: addDays(isoDate(next), -1) }; }
  return { start: `${localDate.slice(0, 4)}-01-01`, end: `${localDate.slice(0, 4)}-12-31` };
}

const change = (current: number, previous: number): number | null => previous === 0 ? null : round((current - previous) / previous);
export function aggregateTrainingPeriod(loads: WorkoutTrainingLoad[], start: string, end: string, granularity: TrainingStatisticsGranularity | "rolling", asOfDate = end, comparisonLoads?: WorkoutTrainingLoad[]): TrainingPeriodSummary {
  const selected = loads.filter(item => item.localDate >= start && item.localDate <= end); const totalDistance = selected.reduce((sum, item) => sum + (item.distanceMeters ?? 0), 0);
  const totalDuration = selected.reduce((sum, item) => sum + item.durationSeconds, 0); const totalLoad = selected.reduce((sum, item) => sum + item.load, 0);
  const heartRateDuration = selected.filter(item => item.averageHeartRate !== null).reduce((sum, item) => sum + item.durationSeconds, 0);
  const summary = { distance: totalDistance, duration: totalDuration, count: selected.length, load: totalLoad };
  const previous = comparisonLoads ? { distance: comparisonLoads.reduce((s, x) => s + (x.distanceMeters ?? 0), 0), duration: comparisonLoads.reduce((s, x) => s + x.durationSeconds, 0), count: comparisonLoads.length, load: comparisonLoads.reduce((s, x) => s + x.load, 0) } : null;
  const types = [...new Set(selected.map(item => item.sessionType))].sort();
  const stimuli = [...new Set(selected.map(item => item.stimulusType))].sort();
  return { granularity, periodStart: start, periodEnd: end, isComplete: asOfDate >= end, distanceMeters: round(totalDistance), durationSeconds: round(totalDuration), workoutCount: selected.length, totalLoad: round(totalLoad),
    elevationGainMeters: round(selected.reduce((sum, item) => sum + (item.elevationGainMeters ?? 0), 0)), longestRunMeters: round(Math.max(0, ...selected.map(item => item.distanceMeters ?? 0))),
    averagePaceSecondsPerKm: totalDistance > 0 ? round(totalDuration / (totalDistance / 1000)) : null,
    averageHeartRate: heartRateDuration > 0 ? round(selected.reduce((sum, item) => sum + (item.averageHeartRate ?? 0) * item.durationSeconds, 0) / heartRateDuration) : null,
    dataCompleteness: selected.length ? round(selected.filter(item => item.distanceMeters !== null && item.durationSeconds > 0).length / selected.length) : 0,
    loadConfidence: totalLoad > 0 ? round(selected.reduce((sum, item) => sum + item.confidence * item.load, 0) / totalLoad) : null,
    typeDistribution: types.map(sessionType => { const group = selected.filter(item => item.sessionType === sessionType); return { sessionType, workoutCount: group.length, distanceMeters: round(group.reduce((s, x) => s + (x.distanceMeters ?? 0), 0)), load: round(group.reduce((s, x) => s + x.load, 0)) }; }),
    stimulusDistribution: stimuli.map(stimulusType => { const group = selected.filter(item => item.stimulusType === stimulusType); return { stimulusType, workoutCount: group.length, distanceMeters: round(group.reduce((s, x) => s + (x.distanceMeters ?? 0), 0)), load: round(group.reduce((s, x) => s + x.load, 0)) }; }),
    comparison: previous ? { distanceChangeFraction: change(summary.distance, previous.distance), durationChangeFraction: change(summary.duration, previous.duration), workoutCountChangeFraction: change(summary.count, previous.count), loadChangeFraction: change(summary.load, previous.load) } : null };
}

export function buildCalendarPeriodSummary(
  loads: WorkoutTrainingLoad[],
  asOfDate: string,
  granularity: TrainingStatisticsGranularity
): TrainingPeriodSummary {
  const current = periodBounds(asOfDate, granularity);
  const elapsedDays = dateDiff(current.start, asOfDate);
  const previousAnchor = addDays(current.start, -1);
  const previous = periodBounds(previousAnchor, granularity);
  const previousComparisonEnd = addDays(previous.start, Math.min(elapsedDays, dateDiff(previous.start, previous.end)));
  const previousLoads = loads.filter(item => item.localDate >= previous.start && item.localDate <= previousComparisonEnd);
  return aggregateTrainingPeriod(loads, current.start, current.end, granularity, asOfDate, previousLoads);
}

export function buildRollingPeriodSummary(loads: WorkoutTrainingLoad[], asOfDate: string, days: number): TrainingPeriodSummary {
  if (!Number.isInteger(days) || days <= 0) throw new Error("days must be a positive integer");
  const start = addDays(asOfDate, -(days - 1));
  const previousEnd = addDays(start, -1);
  const previousStart = addDays(previousEnd, -(days - 1));
  return aggregateTrainingPeriod(
    loads,
    start,
    asOfDate,
    "rolling",
    asOfDate,
    loads.filter(item => item.localDate >= previousStart && item.localDate <= previousEnd)
  );
}
