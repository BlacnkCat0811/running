import type {
  DailyZoneProfile,
  HeartRateZone,
  HeartRateZoneBand,
  PaceZone,
  PaceZoneBand,
  SessionType,
  StimulusScore,
  StimulusType,
  TrainingLoadBreakdown,
  TrainingZoneProfileSettings,
  WorkoutZoneSummary,
  ZoneExposure,
  ZoneAgreement,
  ZoneCoherence,
  ZoneValueSource
} from "@rai/contracts";
import { highIntensityHeartRateZones } from "@rai/contracts";
import {
  RPE_INTENSITY,
  SESSION_TYPE_INTENSITY,
  TRIMP_EXPONENT_MALE,
  trimpMinuteLoad
} from "@rai/training-load";
import { localCalendarFormatter } from "@rai/contracts";

export interface TimedMetricSample {
  value: number;
  durationSeconds: number;
  startOffsetSeconds?: number;
  distanceMeters?: number;
}

export interface RestingHeartRateEvidence { valueBpm: number; observedAt: string }
export interface MaximumHeartRateEvidence {
  peakBpm: number;
  observedAt: string;
  coverage: number;
  sourceConfidence: number;
}
export interface ThresholdPaceCandidate {
  evidenceSource?: "observed" | "inferred" | "fallback";
  paceSecondsPerKm: number;
  confidence: number;
  evidenceCount: number;
  dataThroughAt: string | null;
}

export interface BuildZoneProfileInput {
  id: string;
  localDate: string;
  timezoneIdentifier: string;
  effectiveAt: string;
  createdAt: string;
  dateOfBirth?: string | null;
  restingHeartRates: RestingHeartRateEvidence[];
  maximumHeartRates: MaximumHeartRateEvidence[];
  thresholdPace: ThresholdPaceCandidate | null;
  previousProfile?: DailyZoneProfile | null;
  settings?: TrainingZoneProfileSettings | null;
}

export interface AnalyzeWorkoutZonesInput {
  trainingSessionId: string;
  durationSeconds: number;
  elapsedDurationSeconds?: number;
  distanceMeters: number | null;
  sourceConfidence: number;
  profile: DailyZoneProfile;
  heartRateSamples: TimedMetricSample[];
  speedSamples: TimedMetricSample[];
  averageHeartRateBpm?: number | null;
  averagePaceSecondsPerKm?: number | null;
}

export interface CompositeLoadInput {
  durationSeconds: number;
  elapsedDurationSeconds?: number;
  distanceMeters: number | null;
  profile: DailyZoneProfile;
  zoneSummary: WorkoutZoneSummary;
  heartRateSamples: TimedMetricSample[];
  speedSamples: TimedMetricSample[];
  averageHeartRateBpm?: number | null;
  averagePaceSecondsPerKm?: number | null;
  distanceReferenceMeters?: number | null;
  rpe?: number | null;
  sessionType?: SessionType;
  /** Source-device confidence (0–1); folded into load provenance confidences. */
  sourceConfidence?: number;
}

const clamp = (value: number, low = 0, high = 1): number => Math.min(high, Math.max(low, value));
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const DAY_MS = 86_400_000;

function latestTimestamp(current: string | null, candidate: string | null): string | null {
  if (candidate === null) return current;
  return current === null || Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? null;
}

function localDate(value: string, timezoneIdentifier: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = localCalendarFormatter(timezoneIdentifier, "day").formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function daysBefore(observedAt: string, effectiveAt: string): number {
  return (Date.parse(effectiveAt) - Date.parse(observedAt)) / DAY_MS;
}

function robustDailyRestingHeartRate(
  evidence: RestingHeartRateEvidence[],
  effectiveAt: string,
  timezoneIdentifier: string,
  lookbackDays: number
): { value: number | null; days: number } {
  const byDate = new Map<string, number[]>();
  for (const item of evidence) {
    const age = daysBefore(item.observedAt, effectiveAt);
    if (!finite(item.valueBpm) || item.valueBpm < 35 || item.valueBpm > 110 || age <= 0 || age > lookbackDays) continue;
    const date = localDate(item.observedAt, timezoneIdentifier);
    byDate.set(date, [...(byDate.get(date) ?? []), item.valueBpm]);
  }
  const daily = [...byDate.values()].map((values) => median(values)).filter(finite);
  const center = median(daily);
  if (center === null) return { value: null, days: 0 };
  const mad = median(daily.map((value) => Math.abs(value - center))) ?? 0;
  const radius = Math.max(3 * mad, 2);
  const filtered = daily.filter((value) => Math.abs(value - center) <= radius);
  return { value: median(filtered), days: filtered.length };
}

function ageYears(dateOfBirth: string | null | undefined, at: string): number | null {
  if (!dateOfBirth) return null;
  const born = new Date(`${dateOfBirth.slice(0, 10)}T00:00:00.000Z`);
  const current = new Date(at);
  if (!Number.isFinite(born.getTime()) || !Number.isFinite(current.getTime()) || born >= current) return null;
  return (current.getTime() - born.getTime()) / (365.2425 * DAY_MS);
}

function buildHeartRateBands(resting: number, maximum: number): HeartRateZoneBand[] {
  const bpm = (fraction: number): number => resting + fraction * (maximum - resting);
  return [
    { zone: "recovery", lowerReserveFraction: null, upperReserveFraction: 0.6, lowerBpm: null, upperBpm: bpm(0.6) },
    { zone: "aerobic_base", lowerReserveFraction: 0.6, upperReserveFraction: 0.7, lowerBpm: bpm(0.6), upperBpm: bpm(0.7) },
    { zone: "aerobic_power", lowerReserveFraction: 0.7, upperReserveFraction: 0.8, lowerBpm: bpm(0.7), upperBpm: bpm(0.8) },
    { zone: "lactate_threshold", lowerReserveFraction: 0.8, upperReserveFraction: 0.9, lowerBpm: bpm(0.8), upperBpm: bpm(0.9) },
    { zone: "anaerobic", lowerReserveFraction: 0.9, upperReserveFraction: null, lowerBpm: bpm(0.9), upperBpm: null }
  ];
}

function buildPaceBands(threshold: number | null): PaceZoneBand[] {
  if (threshold === null) return [
    "easy", "marathon", "lactate_threshold", "anaerobic_endurance", "sprint"
  ].map((zone) => ({ zone: zone as PaceZone, lowerSecondsPerKm: null, upperSecondsPerKm: null }));
  return [
    { zone: "easy", lowerSecondsPerKm: threshold * 1.15, upperSecondsPerKm: null },
    { zone: "marathon", lowerSecondsPerKm: threshold * 1.06, upperSecondsPerKm: threshold * 1.15 },
    { zone: "lactate_threshold", lowerSecondsPerKm: threshold * 0.97, upperSecondsPerKm: threshold * 1.06 },
    { zone: "anaerobic_endurance", lowerSecondsPerKm: threshold * 0.9, upperSecondsPerKm: threshold * 0.97 },
    { zone: "sprint", lowerSecondsPerKm: null, upperSecondsPerKm: threshold * 0.9 }
  ];
}

function activeManualSettings(settings: TrainingZoneProfileSettings | null | undefined, localDateValue: string): TrainingZoneProfileSettings | null {
  return settings && settings.effectiveFromLocalDate <= localDateValue ? settings : null;
}

export function buildDailyZoneProfile(input: BuildZoneProfileInput): DailyZoneProfile {
  const previous = input.previousProfile ?? null;
  const settings = activeManualSettings(input.settings, input.localDate);
  const recent = robustDailyRestingHeartRate(input.restingHeartRates, input.effectiveAt, input.timezoneIdentifier, 28);
  const extended = recent.days >= 7 ? recent : robustDailyRestingHeartRate(input.restingHeartRates, input.effectiveAt, input.timezoneIdentifier, 90);
  const restingCandidate = recent.days >= 7 ? recent.value : extended.days >= 7 ? extended.value : null;
  let resting = previous?.restingHeartRateBpm ?? 60;
  let restingSource: ZoneValueSource = previous
    ? previous.heartRateSource === "fallback" && previous.evidence.restingHeartRateDays < 7
      ? "fallback"
      : "carried_forward"
    : "fallback";
  let restingDays = recent.days >= 7 ? recent.days : extended.days;
  if (restingCandidate !== null) {
    resting = previous
      ? previous.restingHeartRateBpm + clamp(0.25 * (restingCandidate - previous.restingHeartRateBpm), -2, 2)
      : restingCandidate;
    restingSource = "automatic";
  }

  const qualifiedPeaks = input.maximumHeartRates.filter((item) => {
    const age = daysBefore(item.observedAt, input.effectiveAt);
    return finite(item.peakBpm) && item.peakBpm >= 120 && item.peakBpm <= 230 && age > 0 && item.coverage >= 0.7 && item.sourceConfidence >= 0.6;
  });
  const validPeaks = qualifiedPeaks.filter((item) => daysBefore(item.observedAt, input.effectiveAt) <= 180);
  const observedMaximum = validPeaks.length ? Math.max(...validPeaks.map((item) => item.peakBpm)) : null;
  const age = ageYears(input.dateOfBirth, input.effectiveAt);
  const formulaMaximum = age === null ? 190 : 208 - 0.7 * age;
  let maximum = previous?.maximumHeartRateBpm ?? formulaMaximum;
  let maximumSource: ZoneValueSource = previous
    ? previous.heartRateSource === "fallback" && previous.evidence.maximumHeartRateWorkouts === 0
      ? "fallback"
      : "carried_forward"
    : "fallback";
  if (!previous && observedMaximum !== null) {
    maximum = observedMaximum;
    maximumSource = "automatic";
  } else if (previous) {
    if (observedMaximum !== null && observedMaximum > maximum) {
      maximum += Math.min(observedMaximum - maximum, 3);
      maximumSource = "automatic";
    }
    const comparableEvidence = qualifiedPeaks.some((item) =>
      daysBefore(item.observedAt, input.effectiveAt) <= 365 && item.peakBpm >= previous.maximumHeartRateBpm - 1
    );
    const declineTarget = Math.max(formulaMaximum, observedMaximum ?? 0);
    if (observedMaximum !== null) maximumSource = "automatic";
    if (!comparableEvidence && declineTarget < maximum) {
      maximum += Math.max(declineTarget - maximum, -1 / 90);
      maximumSource = "automatic";
    }
  }

  if (settings?.restingHeartRate.mode === "manual" && finite(settings.restingHeartRate.valueBpm)) {
    resting = settings.restingHeartRate.valueBpm;
    restingSource = "manual";
    restingDays = 0;
  }
  if (settings?.maximumHeartRate.mode === "manual" && finite(settings.maximumHeartRate.valueBpm)) {
    maximum = settings.maximumHeartRate.valueBpm;
    maximumSource = "manual";
  }
  resting = clamp(resting, 35, 110);
  maximum = clamp(maximum, Math.max(120, resting + 30), 230);

  const switchedPaceToAutomatic = previous?.paceSource === "manual" &&
    settings?.lactateThresholdPace.mode !== "manual";
  let threshold = switchedPaceToAutomatic ? null : previous?.lactateThresholdPaceSecondsPerKm ?? null;
  let paceSource: ZoneValueSource = switchedPaceToAutomatic ? "fallback" : previous ? "carried_forward" : "fallback";
  let paceConfidence = switchedPaceToAutomatic ? 0 : previous ? previous.paceConfidence * Math.pow(0.5, 1 / 180) : 0;
  let thresholdDataThroughAt = switchedPaceToAutomatic ? null : previous?.dataThroughAt ?? null;
  const candidate = input.thresholdPace;
  const thresholdEvidenceCount = Math.max(
    previous?.evidence.thresholdEvidenceCount ?? 0,
    candidate?.evidenceCount ?? 0
  );
  if (candidate && finite(candidate.paceSecondsPerKm) && candidate.paceSecondsPerKm >= 150 && candidate.paceSecondsPerKm <= 900) {
    // §10.5：新阈值证据**只影响之后的 profile**。调用方（`recompute-pipeline`）已经把证据
    // 按 `observedAt < effectiveAt` 过滤，但那是**调用方的**纪律；这里补上证明：
    // 一旦候选的证据游标落在 profile 生效时刻或之后，就是"用本次训练推高 threshold"的闭环，
    // 必须立刻失败而不是静默采纳。
    if (candidate.dataThroughAt !== null && Date.parse(candidate.dataThroughAt) >= Date.parse(input.effectiveAt)) {
      throw new Error(
        `threshold pace evidence (${candidate.dataThroughAt}) is not before the profile effective moment (${input.effectiveAt})`
      );
    }
    const hasNewEvidence = previous === null ||
      (candidate.dataThroughAt !== null && (thresholdDataThroughAt === null ||
        Date.parse(candidate.dataThroughAt) > Date.parse(thresholdDataThroughAt))) ||
      candidate.evidenceCount > (previous?.evidence.thresholdEvidenceCount ?? 0);
    if (threshold === null) {
      threshold = candidate.paceSecondsPerKm;
      paceConfidence = candidate.confidence;
      paceSource = "automatic";
      thresholdDataThroughAt = latestTimestamp(thresholdDataThroughAt, candidate.dataThroughAt);
    } else if (hasNewEvidence && candidate.confidence >= 0.35) {
      const alpha = clamp(candidate.confidence, 0.2, 0.6);
      const proposed = threshold + alpha * (candidate.paceSecondsPerKm - threshold);
      threshold = clamp(proposed, threshold * (1 - 0.03 / 28), threshold * (1 + 0.03 / 28));
      paceConfidence = candidate.confidence;
      paceSource = "automatic";
      thresholdDataThroughAt = latestTimestamp(thresholdDataThroughAt, candidate.dataThroughAt);
    } else if (hasNewEvidence && paceConfidence < 0.35) {
      threshold = candidate.paceSecondsPerKm;
      paceConfidence = candidate.confidence;
      paceSource = "automatic";
      thresholdDataThroughAt = latestTimestamp(thresholdDataThroughAt, candidate.dataThroughAt);
    } else if (hasNewEvidence) {
      // dataThroughAt is the evaluated-evidence cursor. Advancing it prevents a
      // rejected candidate from becoming eligible later only because confidence decayed.
      thresholdDataThroughAt = latestTimestamp(thresholdDataThroughAt, candidate.dataThroughAt);
    }
  }
  if (settings?.lactateThresholdPace.mode === "manual" && finite(settings.lactateThresholdPace.valueSecondsPerKm)) {
    threshold = settings.lactateThresholdPace.valueSecondsPerKm;
    paceConfidence = 1;
    paceSource = "manual";
    thresholdDataThroughAt = input.effectiveAt;
  }

  const restingConfidence = restingSource === "manual"
    ? 1
    : clamp(0.35 + Math.min(restingDays, 14) / 28, 0.25, 0.9);
  const maximumConfidence = maximumSource === "manual"
    ? 1
    : clamp(0.35 + Math.min(validPeaks.length, 3) / 12, 0.25, 0.9);
  const heartRateConfidence = Math.min(restingConfidence, maximumConfidence);
  const heartRateSource: ZoneValueSource = restingSource === "fallback" || maximumSource === "fallback"
    ? "fallback"
    : restingSource === "manual" && maximumSource === "manual"
      ? "manual"
      : restingSource === "automatic" || maximumSource === "automatic"
        ? "automatic"
        : restingSource === "manual" || maximumSource === "manual"
          ? "manual"
          : "carried_forward";
  const status = heartRateSource === "fallback" || threshold === null
    ? "fallback"
    : paceConfidence < 0.35 ? "provisional" : "stable";
  return {
    id: input.id,
    localDate: input.localDate,
    timezoneIdentifier: input.timezoneIdentifier,
    effectiveAt: input.effectiveAt,
    dataThroughAt: thresholdDataThroughAt,
    restingHeartRateBpm: round(resting),
    maximumHeartRateBpm: round(maximum),
    lactateThresholdPaceSecondsPerKm: threshold === null ? null : round(threshold),
    heartRateSource,
    paceSource,
    heartRateConfidence: round(heartRateConfidence),
    paceConfidence: round(clamp(paceConfidence)),
    status,
    heartRateBands: buildHeartRateBands(resting, maximum).map((band) => ({
      ...band,
      lowerBpm: band.lowerBpm === null ? null : round(band.lowerBpm),
      upperBpm: band.upperBpm === null ? null : round(band.upperBpm)
    })),
    paceBands: buildPaceBands(threshold).map((band) => ({
      ...band,
      lowerSecondsPerKm: band.lowerSecondsPerKm === null ? null : round(band.lowerSecondsPerKm),
      upperSecondsPerKm: band.upperSecondsPerKm === null ? null : round(band.upperSecondsPerKm)
    })),
    evidence: {
      valueSources: {
        restingHeartRate: restingSource,
        maximumHeartRate: maximumSource,
        thresholdPace: paceSource,
        thresholdEvidence: paceSource === "manual" ? "manual"
          : paceSource === "automatic" ? candidate?.evidenceSource ?? "inferred"
            : previous?.evidence.valueSources?.thresholdEvidence ?? "fallback"
      },
      restingHeartRateDays: restingDays,
      maximumHeartRateWorkouts: validPeaks.length,
      // This is an evaluated-evidence cursor, so temporary candidate loss or
      // a regressed aggregate must not make old evidence appear new later.
      thresholdEvidenceCount
    },
    createdAt: input.createdAt
  };
}

export function heartRateZoneFor(heartRateBpm: number, profile: DailyZoneProfile): HeartRateZone | null {
  // A heart rate of 0 or below is a broken sample, not "very easy". Without this,
  // `reserve < 0.6` classified it as `recovery`, which then counted towards both
  // heart-rate coverage and recovery exposure (§10: zones are evidence, not a bucket
  // for anything numeric that parses).
  if (!finite(heartRateBpm) || heartRateBpm <= 0 ||
      profile.maximumHeartRateBpm <= profile.restingHeartRateBpm) return null;
  const reserve = (heartRateBpm - profile.restingHeartRateBpm) /
    (profile.maximumHeartRateBpm - profile.restingHeartRateBpm);
  if (reserve < 0.6) return "recovery";
  if (reserve < 0.7) return "aerobic_base";
  if (reserve < 0.8) return "aerobic_power";
  if (reserve < 0.9) return "lactate_threshold";
  return "anaerobic";
}

export function paceZoneFor(paceSecondsPerKm: number, profile: DailyZoneProfile): PaceZone | null {
  const threshold = profile.lactateThresholdPaceSecondsPerKm;
  if (!finite(paceSecondsPerKm) || paceSecondsPerKm < 150 || paceSecondsPerKm > 900 || threshold === null) return null;
  if (paceSecondsPerKm >= threshold * 1.15) return "easy";
  if (paceSecondsPerKm >= threshold * 1.06) return "marathon";
  if (paceSecondsPerKm >= threshold * 0.97) return "lactate_threshold";
  if (paceSecondsPerKm >= threshold * 0.9) return "anaerobic_endurance";
  return "sprint";
}

function emptyExposure<TZone extends string>(zones: readonly TZone[]): Array<ZoneExposure<TZone>> {
  return zones.map((zone) => ({ zone, durationSeconds: 0, distanceMeters: 0, fraction: 0 }));
}

function normalizeExposure<TZone extends string>(items: Array<ZoneExposure<TZone>>, durationSeconds: number): Array<ZoneExposure<TZone>> {
  return items.map((item) => ({
    ...item,
    durationSeconds: round(item.durationSeconds),
    distanceMeters: round(item.distanceMeters),
    fraction: durationSeconds > 0 ? round(item.durationSeconds / durationSeconds) : 0
  }));
}

function addExposure<TZone extends string>(items: Array<ZoneExposure<TZone>>, zone: TZone, duration: number, distance: number): void {
  const item = items.find((candidate) => candidate.zone === zone);
  if (!item) return;
  item.durationSeconds += duration;
  item.distanceMeters += distance;
}

const heartZoneOrder: HeartRateZone[] = ["recovery", "aerobic_base", "aerobic_power", "lactate_threshold", "anaerobic"];
const paceZoneOrder: PaceZone[] = ["easy", "marathon", "lactate_threshold", "anaerobic_endurance", "sprint"];

function validSamples(samples: TimedMetricSample[]): TimedMetricSample[] {
  return samples.filter((sample) => finite(sample.value) && finite(sample.durationSeconds) && sample.durationSeconds > 0);
}

interface TimelineSample extends TimedMetricSample {
  startOffsetSeconds: number;
  distanceMeters: number;
}

function normalizedTimeline(samples: TimedMetricSample[], durationSeconds: number): TimelineSample[] {
  const duration = Math.max(0, durationSeconds);
  let sequentialOffset = 0;
  const intervals = validSamples(samples).flatMap((sample, index) => {
    const requestedStart = finite(sample.startOffsetSeconds) ? sample.startOffsetSeconds : sequentialOffset;
    const requestedEnd = requestedStart + sample.durationSeconds;
    sequentialOffset = Math.max(sequentialOffset, requestedEnd);
    const start = clamp(requestedStart, 0, duration);
    const end = clamp(requestedEnd, 0, duration);
    return end > start ? [{ ...sample, index, start, end }] : [];
  });
  if (intervals.length === 0) return [];

  const events = intervals.flatMap((sample) => [
    { at: sample.start, kind: "start" as const, sample },
    { at: sample.end, kind: "end" as const, sample }
  ]).sort((left, right) => left.at - right.at ||
    (left.kind === right.kind ? 0 : left.kind === "end" ? -1 : 1));
  const active = new Map<number, typeof intervals[number]>();
  const result: TimelineSample[] = [];
  let previousAt = events[0]?.at ?? 0;
  let eventIndex = 0;
  while (eventIndex < events.length) {
    const at = events[eventIndex]?.at ?? previousAt;
    if (at > previousAt && active.size > 0) {
      const current = [...active.values()];
      const segmentDuration = at - previousAt;
      const value = current.reduce((sum, sample) => sum + sample.value, 0) / current.length;
      const distanceRate = current.reduce((sum, sample) =>
        sum + (finite(sample.distanceMeters) ? sample.distanceMeters / sample.durationSeconds : sample.value), 0
      ) / current.length;
      result.push({
        value,
        startOffsetSeconds: previousAt,
        durationSeconds: segmentDuration,
        distanceMeters: distanceRate * segmentDuration
      });
    }
    while (eventIndex < events.length && events[eventIndex]?.at === at) {
      const event = events[eventIndex];
      if (event?.kind === "end") active.delete(event.sample.index);
      else if (event) active.set(event.sample.index, event.sample);
      eventIndex += 1;
    }
    previousAt = at;
  }
  return result;
}

function limitTimelineCoverage(samples: TimelineSample[], durationSeconds: number): TimelineSample[] {
  const coveredSeconds = samples.reduce((sum, sample) => sum + sample.durationSeconds, 0);
  const availableSeconds = Math.max(0, durationSeconds);
  if (coveredSeconds <= availableSeconds || coveredSeconds === 0) return samples;
  const scale = availableSeconds / coveredSeconds;
  return samples.map((sample) => ({
    ...sample,
    startOffsetSeconds: sample.startOffsetSeconds * scale,
    durationSeconds: sample.durationSeconds * scale,
    distanceMeters: sample.distanceMeters * scale
  }));
}

function exposureSeconds<TZone extends string>(exposure: Array<ZoneExposure<TZone>>, ...zones: TZone[]): number {
  return exposure.filter((item) => zones.includes(item.zone)).reduce((sum, item) => sum + item.durationSeconds, 0);
}

function qualifyingBouts(samples: TimedMetricSample[], qualifies: (value: number) => boolean, minimum: number, maximum: number): { total: number; count: number; continuousMaximum: number } {
  let total = 0;
  let count = 0;
  let current = 0;
  let continuousMaximum = 0;
  let previousEnd: number | null = null;
  const ordered = [...samples].sort((left, right) => (left.startOffsetSeconds ?? 0) - (right.startOffsetSeconds ?? 0));
  const finish = (): void => {
    continuousMaximum = Math.max(continuousMaximum, current);
    if (current >= minimum && current <= maximum) { total += current; count += 1; }
    current = 0;
  };
  for (const sample of ordered) {
    const start: number = sample.startOffsetSeconds ?? previousEnd ?? 0;
    if (previousEnd !== null && start - previousEnd > 15) finish();
    if (qualifies(sample.value)) current += sample.durationSeconds;
    else finish();
    previousEnd = start + sample.durationSeconds;
  }
  finish();
  return { total, count, continuousMaximum };
}

function stimulusScore(
  stimulusType: Exclude<StimulusType, "unclassified">,
  qualifyingSeconds: number,
  targetSeconds: number,
  confidence: number
): StimulusScore {
  return {
    stimulusType,
    qualifyingSeconds: round(qualifyingSeconds),
    targetSeconds,
    score: round(qualifyingSeconds / targetSeconds * confidence),
    confidence: round(confidence)
  };
}

// -----------------------------------------------------------------------------
// §10.4 HR / Pace coherence
// -----------------------------------------------------------------------------

export const ZONE_COHERENCE_POLICY_VERSION = "rai-zone-coherence-v1";

/**
 * 共享**生理努力档**。两套分区并不同构 —— `aerobic_power` 只在 HR 一侧存在，
 * `anaerobic_endurance` / `sprint` 只在 Pace 一侧存在。
 *
 * 🔴 §10.4 明令："**不能把各自数组下标相减当『冲突分』**"。下面这张表就是那句禁令的实现：
 * 比较前先把两侧映射到同一个生理阶梯，再用**显式语义映射**判断是否对齐。
 */
const heartZoneEffort: Record<HeartRateZone, number> = {
  recovery: 0,
  aerobic_base: 1,
  aerobic_power: 2,
  lactate_threshold: 3,
  anaerobic: 5
};
const paceZoneEffort: Record<PaceZone, number> = {
  easy: 0,
  marathon: 2,
  lactate_threshold: 3,
  anaerobic_endurance: 4,
  sprint: 5
};

/** 每个 HR 档**可接受**的 Pace 努力档。显式列举，不靠下标距离。 */
const acceptedPaceEffortForHeartZone: Record<HeartRateZone, readonly number[]> = {
  recovery: [0],
  aerobic_base: [0, 2],
  aerobic_power: [2],
  lactate_threshold: [2, 3],
  anaerobic: [4, 5]
};

export interface ZoneCoherenceConfig {
  /** 双来源同时有分区的时长占比低于它 ⇒ `insufficient`。 */
  readonly minimumPairedCoverage: number;
  /** 短于这么久的分歧不算"持续冲突"（§10.4：间歇中的 HR 滞后不应成为常态冲突）。 */
  readonly minimumSustainedSeconds: number;
  /** 方向判定用的努力档容差。 */
  readonly effortTolerance: number;
}

export const defaultZoneCoherenceConfig: ZoneCoherenceConfig = {
  minimumPairedCoverage: 0.5,
  minimumSustainedSeconds: 90,
  effortTolerance: 1
};

export interface ZoneCoherenceSegment<TZone extends string> {
  startOffsetSeconds: number;
  durationSeconds: number;
  zone: TZone;
}

type SegmentDirection = "pace_high" | "hr_high";

/**
 * §10.4：把数值指标（配对覆盖、持续冲突秒数）与行动分类（`agreement`）分开的**唯一**入口。
 *
 * 配对覆盖率是**真实配对**：把两条时间线按边界扫一遍，只统计"两侧都落到某个分区"的时长，
 * 不拿 `min(心率覆盖, 配速覆盖)` 冒充 —— 那会把"两条线各覆盖一半但互不重叠"算成满配对。
 */
export function assessZoneCoherence(input: {
  durationSeconds: number;
  heartRateSegments: readonly ZoneCoherenceSegment<HeartRateZone>[];
  paceSegments: readonly ZoneCoherenceSegment<PaceZone>[];
  config?: ZoneCoherenceConfig;
}): ZoneCoherence {
  const config = input.config ?? defaultZoneCoherenceConfig;
  if (!Number.isFinite(config.minimumPairedCoverage) || config.minimumPairedCoverage < 0 || config.minimumPairedCoverage > 1) {
    throw new Error("minimumPairedCoverage must be within [0, 1]");
  }
  if (!Number.isFinite(config.minimumSustainedSeconds) || config.minimumSustainedSeconds < 0) {
    throw new Error("minimumSustainedSeconds must not be negative");
  }
  if (!Number.isFinite(config.effortTolerance) || config.effortTolerance < 0) {
    throw new Error("effortTolerance must not be negative");
  }

  const duration = Math.max(0, input.durationSeconds);
  const base = { comparisonPolicyVersion: ZONE_COHERENCE_POLICY_VERSION };

  const boundaries = new Set<number>([0, duration]);
  for (const segment of [...input.heartRateSegments, ...input.paceSegments]) {
    const start = clamp(segment.startOffsetSeconds, 0, duration);
    const end = clamp(segment.startOffsetSeconds + segment.durationSeconds, 0, duration);
    if (end > start) {
      boundaries.add(start);
      boundaries.add(end);
    }
  }
  const edges = [...boundaries].sort((left, right) => left - right);

  const covering = <TZone extends string>(
    segments: readonly ZoneCoherenceSegment<TZone>[],
    at: number
  ): TZone | null => {
    for (const segment of segments) {
      if (segment.startOffsetSeconds <= at && at < segment.startOffsetSeconds + segment.durationSeconds) {
        return segment.zone;
      }
    }
    return null;
  };

  let pairedSeconds = 0;
  let sustainedConflictSeconds = 0;
  const directionSeconds: Record<SegmentDirection, number> = { pace_high: 0, hr_high: 0 };
  let runSeconds = 0;
  const runDirections: SegmentDirection[] = [];

  const flushRun = (): void => {
    if (runSeconds >= config.minimumSustainedSeconds && runSeconds > 0) {
      sustainedConflictSeconds += runSeconds;
      for (const direction of runDirections) directionSeconds[direction] += 1;
    }
    runSeconds = 0;
    runDirections.length = 0;
  };

  for (let index = 0; index < edges.length - 1; index += 1) {
    const start = edges[index]!;
    const end = edges[index + 1]!;
    const seconds = end - start;
    if (seconds <= 0) continue;
    const heartZone = covering(input.heartRateSegments, start);
    const paceZone = covering(input.paceSegments, start);
    if (heartZone === null || paceZone === null) {
      flushRun();
      continue;
    }
    pairedSeconds += seconds;
    const heartEffort = heartZoneEffort[heartZone];
    const paceEffort = paceZoneEffort[paceZone];
    if (acceptedPaceEffortForHeartZone[heartZone].includes(paceEffort)) {
      flushRun();
      continue;
    }
    // Not aligned: the shared effort ladder says which side reads harder.
    const direction: SegmentDirection =
      paceEffort - heartEffort > config.effortTolerance ? "pace_high" : "hr_high";
    runSeconds += seconds;
    runDirections.push(direction);
  }
  flushRun();

  const pairedCoverage = duration > 0 ? clamp(pairedSeconds / duration) : 0;
  const reasonCodes: string[] = [];
  if (pairedCoverage < config.minimumPairedCoverage) {
    reasonCodes.push("paired_coverage_below_threshold");
    return { ...base, agreement: "insufficient", pairedCoverage: round(pairedCoverage), sustainedConflictSeconds: 0, reasonCodes };
  }
  if (sustainedConflictSeconds === 0) {
    reasonCodes.push("no_sustained_conflict");
    return { ...base, agreement: "aligned", pairedCoverage: round(pairedCoverage), sustainedConflictSeconds: 0, reasonCodes };
  }
  const agreement: SegmentDirection = directionSeconds.pace_high >= directionSeconds.hr_high ? "pace_high" : "hr_high";
  reasonCodes.push("sustained_conflict_detected", agreement === "pace_high" ? "pace_leads_hr" : "hr_leads_pace");
  return {
    ...base,
    agreement,
    pairedCoverage: round(pairedCoverage),
    sustainedConflictSeconds: round(sustainedConflictSeconds),
    reasonCodes
  };
}

export function analyzeWorkoutZones(input: AnalyzeWorkoutZonesInput): WorkoutZoneSummary {
  const duration = Math.max(0, input.durationSeconds);
  const timelineDuration = Math.max(duration, input.elapsedDurationSeconds ?? duration);
  const heartExposure = emptyExposure(heartZoneOrder);
  const paceExposure = emptyExposure(paceZoneOrder);
  let heartCovered = 0;
  let paceCovered = 0;
  const heartSamples = limitTimelineCoverage(
    // Symmetric with the speed filter below: a non-positive reading is a broken
    // sample, not a very easy one, and must not buy coverage or recovery exposure.
    normalizedTimeline(input.heartRateSamples, timelineDuration).filter((sample) => sample.value > 0),
    duration
  );
  const speedSamples = limitTimelineCoverage(
    normalizedTimeline(input.speedSamples, timelineDuration).filter((sample) => sample.value > 0),
    duration
  );
  for (const sample of heartSamples) {
    const zone = heartRateZoneFor(sample.value, input.profile);
    if (!zone) continue;
    const seconds = sample.durationSeconds;
    addExposure(heartExposure, zone, seconds, 0);
    heartCovered += seconds;
  }
  for (const sample of speedSamples) {
    const pace = 1000 / sample.value;
    const zone = paceZoneFor(pace, input.profile);
    if (!zone) continue;
    const seconds = sample.durationSeconds;
    const distance = finite(sample.distanceMeters) ? sample.distanceMeters : sample.value * seconds;
    addExposure(paceExposure, zone, seconds, distance);
    paceCovered += seconds;
  }
  let averageOnlyHeart = false;
  let averageOnlyPace = false;
  if (heartCovered === 0 && finite(input.averageHeartRateBpm)) {
    const zone = heartRateZoneFor(input.averageHeartRateBpm, input.profile);
    if (zone) { addExposure(heartExposure, zone, duration, 0); heartCovered = duration; averageOnlyHeart = true; }
  }
  if (paceCovered === 0 && finite(input.averagePaceSecondsPerKm)) {
    const zone = paceZoneFor(input.averagePaceSecondsPerKm, input.profile);
    if (zone) {
      addExposure(paceExposure, zone, duration, input.distanceMeters ?? 0);
      paceCovered = duration;
      averageOnlyPace = true;
    }
  }
  const normalizedHeart = normalizeExposure(heartExposure, duration);
  const normalizedPace = normalizeExposure(paceExposure, duration);
  const exposedDistance = normalizedPace.reduce((sum, item) => sum + item.distanceMeters, 0);
  if (finite(input.distanceMeters) && input.distanceMeters >= 0 && exposedDistance > input.distanceMeters && exposedDistance > 0) {
    const scale = input.distanceMeters / exposedDistance;
    for (const item of normalizedPace) item.distanceMeters = round(item.distanceMeters * scale);
  }
  const heartCoverage = duration > 0 ? clamp(heartCovered / duration) : 0;
  const paceCoverage = duration > 0 ? clamp(paceCovered / duration) : 0;
  const hrConfidence = Math.min(averageOnlyHeart ? 0.4 : 1, input.sourceConfidence * Math.min(1, heartCoverage / 0.7) * input.profile.heartRateConfidence);
  const paceConfidence = Math.min(averageOnlyPace ? 0.4 : 1, input.sourceConfidence * Math.min(1, paceCoverage / 0.7) * input.profile.paceConfidence);
  const highHeart = exposureSeconds(normalizedHeart, ...highIntensityHeartRateZones);
  const recoverySeconds = exposureSeconds(normalizedHeart, "recovery");
  const aerobicSeconds = Math.max(
    exposureSeconds(normalizedHeart, "aerobic_base"),
    exposureSeconds(normalizedPace, "easy")
  );
  const marathonSeconds = exposureSeconds(normalizedPace, "marathon");
  const thresholdSeconds = Math.max(
    exposureSeconds(normalizedHeart, "lactate_threshold"),
    exposureSeconds(normalizedPace, "lactate_threshold")
  );
  const vo2PaceBouts = qualifyingBouts(speedSamples, (speed) => paceZoneFor(1000 / speed, input.profile) === "anaerobic_endurance", 120, 480);
  const vo2HeartBouts = qualifyingBouts(heartSamples, (heartRate) => heartRateZoneFor(heartRate, input.profile) === "anaerobic", 120, 480);
  const continuousVo2 = Math.max(vo2PaceBouts.continuousMaximum, vo2HeartBouts.continuousMaximum) >= 480
    ? Math.max(vo2PaceBouts.continuousMaximum, vo2HeartBouts.continuousMaximum) : 0;
  const vo2Seconds = Math.max(vo2PaceBouts.total, vo2HeartBouts.total, continuousVo2);
  const sprintBouts = qualifyingBouts(speedSamples, (speed) => paceZoneFor(1000 / speed, input.profile) === "sprint", 10, 120);
  const sprintSeconds = sprintBouts.count >= 3 ? sprintBouts.total : 0;
  const thresholdConfidence = Math.max(hrConfidence, paceConfidence);
  const scores: StimulusScore[] = [
    stimulusScore("recovery", highHeart <= duration * 0.05 ? recoverySeconds : 0, 1800, hrConfidence),
    stimulusScore("aerobic_base", aerobicSeconds, 1800, Math.max(hrConfidence, paceConfidence)),
    stimulusScore("marathon_pace", marathonSeconds, 1200, paceConfidence),
    stimulusScore("lactate_threshold", thresholdSeconds, 900, thresholdConfidence),
    stimulusScore("vo2max", vo2Seconds, 600, Math.max(hrConfidence, paceConfidence)),
    stimulusScore("anaerobic_endurance", sprintSeconds, 180, paceConfidence)
  ];
  const minimums: Record<Exclude<StimulusType, "unclassified">, number> = {
    recovery: 1200,
    aerobic_base: 1200,
    marathon_pace: 720,
    lactate_threshold: 600,
    vo2max: 360,
    anaerobic_endurance: 90
  };
  const intensityOrder: Array<Exclude<StimulusType, "unclassified">> = [
    "recovery", "aerobic_base", "marathon_pace", "lactate_threshold", "vo2max", "anaerobic_endurance"
  ];
  const eligible = scores.filter((item) => item.qualifyingSeconds >= minimums[item.stimulusType]);
  eligible.sort((left, right) => right.score - left.score || intensityOrder.indexOf(right.stimulusType) - intensityOrder.indexOf(left.stimulusType));
  const fallback = [...scores].filter((item) => item.qualifyingSeconds > 0).sort((left, right) => right.score - left.score)[0];
  const primary = eligible[0] ?? fallback;
  const usedFallback = eligible.length === 0 && primary !== undefined;
  const stimulusType: StimulusType = primary?.stimulusType ?? "unclassified";
  const secondary = primary
    ? eligible.filter((item) => item.stimulusType !== primary.stimulusType && item.score >= primary.score * 0.5).map((item) => item.stimulusType)
    : [];
  const explanationCodes: string[] = [];
  if (averageOnlyHeart) explanationCodes.push("heart_rate_average_fallback");
  if (averageOnlyPace) explanationCodes.push("pace_average_fallback");
  if (input.profile.status !== "stable") explanationCodes.push("zone_profile_provisional");
  const dominantHeart = normalizedHeart.reduce((best, item, index) => item.durationSeconds > best.seconds ? { index, seconds: item.durationSeconds } : best, { index: 0, seconds: 0 });
  const dominantPace = normalizedPace.reduce((best, item, index) => item.durationSeconds > best.seconds ? { index, seconds: item.durationSeconds } : best, { index: 0, seconds: 0 });
  const conflictFraction = duration > 0 ? Math.min(dominantHeart.seconds, dominantPace.seconds) / duration : 0;
  const conflict = heartCoverage >= 0.5 && paceCoverage >= 0.5 && conflictFraction > 0.3 && Math.abs(dominantHeart.index - dominantPace.index) >= 2;
  if (conflict) explanationCodes.push("heart_rate_pace_conflict");
  // §10.4：显式语义映射版本，与上面那条下标相减的 `conflict` **并存但尚未统一**。
  // 切换 `conflict` 会改 `stimulusConfidence`（−0.2）与 `explanationCodes` ⇒ 属对外数值变更，
  // 必须走"先迁移、再离线比较"。本字段让那次比较有据可依，也让消费方现在就能读语义版本。
  const zoneCoherence = assessZoneCoherence({
    durationSeconds: duration,
    heartRateSegments: heartSamples.flatMap((sample) => {
      const zone = heartRateZoneFor(sample.value, input.profile);
      return zone === null
        ? []
        : [{ startOffsetSeconds: sample.startOffsetSeconds, durationSeconds: sample.durationSeconds, zone }];
    }),
    paceSegments: speedSamples.flatMap((sample) => {
      if (sample.value <= 0) return [];
      const zone = paceZoneFor(1000 / sample.value, input.profile);
      return zone === null
        ? []
        : [{ startOffsetSeconds: sample.startOffsetSeconds, durationSeconds: sample.durationSeconds, zone }];
    })
  });
  if (usedFallback) explanationCodes.push("stimulus_low_confidence");
  if (!primary) explanationCodes.push("stimulus_unclassified");
  const stimulusConfidence = primary
    ? clamp(Math.min(primary.confidence, usedFallback ? 0.4 : 1) - (conflict ? 0.2 : 0))
    : 0;
  return {
    trainingSessionId: input.trainingSessionId,
    zoneProfileId: input.profile.id,
    stimulusType,
    secondaryStimulusTypes: secondary,
    stimulusConfidence: round(stimulusConfidence),
    heartRateCoverage: round(heartCoverage),
    paceCoverage: round(paceCoverage),
    heartRateExposure: normalizedHeart,
    paceExposure: normalizedPace,
    stimulusScores: scores,
    explanationCodes,
    zoneCoherence
  };
}

/** Re-export Banister TRIMP minute helper; male coefficient by default (see TRIMP_EXPONENT_MALE). */
export function trimpMinute(intensity: number): number {
  return trimpMinuteLoad(intensity, TRIMP_EXPONENT_MALE);
}

export function calculateCompositeTrainingLoad(input: CompositeLoadInput): TrainingLoadBreakdown {
  const durationMinutes = Math.max(0, input.durationSeconds) / 60;
  const timelineDuration = Math.max(input.durationSeconds, input.elapsedDurationSeconds ?? input.durationSeconds, 0);
  const sourceConfidence = clamp(input.sourceConfidence ?? 1);
  const resting = input.profile.restingHeartRateBpm;
  const maximum = input.profile.maximumHeartRateBpm;
  let rawHrrTrimp: number | null = null;
  let heartIntensity: number | null = null;
  let averageOnlyHeart = false;
  const heartSamples = limitTimelineCoverage(
    normalizedTimeline(input.heartRateSamples, timelineDuration),
    input.durationSeconds
  );
  if (heartSamples.length > 0 && maximum > resting) {
    rawHrrTrimp = heartSamples.reduce((sum, sample) => {
      const reserve = clamp((sample.value - resting) / (maximum - resting));
      return sum + sample.durationSeconds / 60 * trimpMinute(reserve);
    }, 0);
    const heartSeconds = heartSamples.reduce((sum, sample) => sum + sample.durationSeconds, 0);
    heartIntensity = heartSeconds > 0 ? heartSamples.reduce((sum, sample) =>
      sum + clamp((sample.value - resting) / (maximum - resting)) * sample.durationSeconds, 0) / heartSeconds : null;
  } else if (finite(input.averageHeartRateBpm) && maximum > resting) {
    averageOnlyHeart = true;
    heartIntensity = clamp((input.averageHeartRateBpm - resting) / (maximum - resting));
    rawHrrTrimp = durationMinutes * trimpMinute(heartIntensity);
  }
  const internalLoad = rawHrrTrimp === null ? null : rawHrrTrimp * 100 / (60 * trimpMinute(0.85));

  const threshold = input.profile.lactateThresholdPaceSecondsPerKm;
  const speedSamples = limitTimelineCoverage(
    normalizedTimeline(input.speedSamples, timelineDuration)
      .filter((sample) => sample.value > 0 && paceZoneFor(1000 / sample.value, input.profile) !== null),
    input.durationSeconds
  );
  let paceLoad: number | null = null;
  let paceIntensity: number | null = null;
  let averageOnlyPace = false;
  if (threshold !== null && speedSamples.length > 0) {
    paceLoad = speedSamples.reduce((sum, sample) => {
      const pace = 1000 / sample.value;
      const intensityFactor = clamp(threshold / pace, 0.5, 1.3);
      return sum + sample.durationSeconds / 3600 * 100 * intensityFactor ** 2;
    }, 0);
    const paceSeconds = speedSamples.reduce((sum, sample) => sum + sample.durationSeconds, 0);
    paceIntensity = paceSeconds > 0 ? speedSamples.reduce((sum, sample) => {
      const pace = 1000 / sample.value;
      return sum + clamp(threshold / pace, 0.5, 1.3) / 1.3 * sample.durationSeconds;
    }, 0) / paceSeconds : null;
  } else if (threshold !== null && finite(input.averagePaceSecondsPerKm)) {
    averageOnlyPace = true;
    const intensityFactor = clamp(threshold / input.averagePaceSecondsPerKm, 0.5, 1.3);
    paceLoad = input.durationSeconds / 3600 * 100 * intensityFactor ** 2;
    paceIntensity = intensityFactor / 1.3;
  }

  const distance = finite(input.distanceMeters) ? Math.max(0, input.distanceMeters) : null;
  const reference = finite(input.distanceReferenceMeters) && input.distanceReferenceMeters > 0 ? input.distanceReferenceMeters : null;
  const distanceExposureRatio = distance !== null && reference !== null ? distance / reference : null;
  const distanceFactor = distanceExposureRatio === null ? 1 : 1 + 0.15 * clamp(distanceExposureRatio - 1, 0, 1);
  // Average-only paths inflate zoneSummary coverage to 1.0; discount like stimulus scoring (~0.4).
  const heartCoverageForLoad = averageOnlyHeart
    ? Math.min(0.4, input.zoneSummary.heartRateCoverage > 0 ? input.zoneSummary.heartRateCoverage : 0.4)
    : input.zoneSummary.heartRateCoverage;
  const paceCoverageForLoad = averageOnlyPace
    ? Math.min(0.4, input.zoneSummary.paceCoverage > 0 ? input.zoneSummary.paceCoverage : 0.4)
    : input.zoneSummary.paceCoverage;
  const heartConfidence = internalLoad === null || heartCoverageForLoad <= 0
    ? 0
    : sourceConfidence * heartCoverageForLoad * input.profile.heartRateConfidence;
  const paceConfidence = paceLoad === null || paceCoverageForLoad <= 0
    ? 0
    : sourceConfidence * paceCoverageForLoad * input.profile.paceConfidence;
  const heartWeight = 0.6 * heartConfidence;
  const paceWeight = 0.4 * paceConfidence;
  let baseLoad: number;
  let compositeIntensity: number;
  let fallbackHeartConfidence = heartConfidence;
  let fallbackPaceConfidence = paceConfidence;
  if (heartWeight + paceWeight > 0) {
    baseLoad = (heartWeight * (internalLoad ?? 0) + paceWeight * (paceLoad ?? 0)) / (heartWeight + paceWeight);
    compositeIntensity = (heartWeight * (heartIntensity ?? 0) + paceWeight * (paceIntensity ?? 0)) / (heartWeight + paceWeight);
  } else if (finite(input.rpe) && input.rpe >= 1 && input.rpe <= 10) {
    // Same RPE→intensity table and TRIMP family as Banister (training-load).
    const intensity = RPE_INTENSITY[Math.round(input.rpe)] ?? 0.48;
    baseLoad = durationMinutes * trimpMinute(intensity) * 100 / (60 * trimpMinute(0.85));
    compositeIntensity = intensity;
    // Banister RPE confidence 0.65 * source; training-load skips 0.6/0.4 blend when both loads null.
    fallbackHeartConfidence = 0.65 * sourceConfidence;
    fallbackPaceConfidence = 0;
  } else {
    const intensity = SESSION_TYPE_INTENSITY[input.sessionType ?? "unknown"];
    baseLoad = durationMinutes * trimpMinute(intensity) * 100 / (60 * trimpMinute(0.85));
    compositeIntensity = intensity;
    fallbackHeartConfidence = 0.4 * sourceConfidence;
    fallbackPaceConfidence = 0;
  }
  return {
    rawHrrTrimp: rawHrrTrimp === null ? null : round(rawHrrTrimp),
    internalLoad: internalLoad === null ? null : round(internalLoad),
    paceLoad: paceLoad === null ? null : round(paceLoad),
    distanceReferenceMeters: reference === null ? null : round(reference),
    distanceExposureRatio: distanceExposureRatio === null ? null : round(distanceExposureRatio),
    distanceFactor: round(distanceFactor),
    compositeLoad: round(Math.max(0, baseLoad * distanceFactor)),
    compositeIntensity: round(clamp(compositeIntensity)),
    heartRateConfidence: round(clamp(fallbackHeartConfidence)),
    paceConfidence: round(clamp(fallbackPaceConfidence))
  };
}

export function percentile(values: number[], fraction: number): number | null {
  const finiteValues = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finiteValues.length === 0) return null;
  const position = (finiteValues.length - 1) * clamp(fraction);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return (finiteValues[lower] ?? 0) * (1 - weight) + (finiteValues[upper] ?? 0) * weight;
}
