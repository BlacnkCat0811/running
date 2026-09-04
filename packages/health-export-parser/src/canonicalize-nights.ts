import type { DatabaseSync } from "node:sqlite";

import { healthTypes } from "@rai/contracts";

import { localDateAt, localDateTimeAt, stableId } from "./utils.js";

export const CANONICAL_NIGHT_ALGORITHM_VERSION = "canonical-night-v1" as const;

export type CanonicalNightKind = "main" | "nap";
export type HrvDayConfidence = "confident" | "sparse" | "missing";

export interface CanonicalNight {
  id: string;
  wakeDate: string;
  timezoneIdentifier: string;
  kind: CanonicalNightKind;
  sourceName: string;
  sourceCategory: string;
  sourceRank: number;
  hasStages: boolean;
  sleepOnsetAt: string | null;
  wakeAt: string | null;
  asleepUnionMinutes: number | null;
  inBedUnionMinutes: number | null;
  awakeMinutes: number | null;
  stageMinutes: { core: number; deep: number; rem: number; unspecified: number; awake: number };
  segmentCount: number;
  provenance: { algorithmVersion: typeof CANONICAL_NIGHT_ALGORITHM_VERSION; competingSourceCount: number; rejectedInBedOnly: boolean };
}

export interface CanonicalHrvDay {
  id: string;
  localDate: string;
  timezoneIdentifier: string;
  nightId: string;
  hrvSdnnMs: number | null;
  sampleCount: number;
  confidence: HrvDayConfidence;
  windowStartAt: string | null;
  windowEndAt: string | null;
  sourceName: string | null;
  provenance: { algorithmVersion: typeof CANONICAL_NIGHT_ALGORITHM_VERSION; fallbackWatch: boolean };
}

interface Segment {
  id: string;
  sourceName: string;
  sourceCategory: string;
  value: string;
  start: number;
  end: number;
}

const STAGE_VALUES = new Map<string, keyof CanonicalNight["stageMinutes"]>([
  ["HKCategoryValueSleepAnalysisAsleepCore", "core"],
  ["HKCategoryValueSleepAnalysisAsleepDeep", "deep"],
  ["HKCategoryValueSleepAnalysisAsleepREM", "rem"],
  ["HKCategoryValueSleepAnalysisAsleepUnspecified", "unspecified"],
  ["HKCategoryValueSleepAnalysisAwake", "awake"]
]);

function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const value = new Date(Date.UTC(y!, m! - 1, d! + days));
  return value.toISOString().slice(0, 10);
}

function sourceRank(category: string, hasStages: boolean): number {
  if (category === "apple_watch") return hasStages ? 1 : 2;
  if (["coros", "huawei", "connect"].includes(category)) return 3;
  if (category === "apple_phone") return 5;
  return 5;
}

function unionMinutes(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0; let start = sorted[0]?.[0] ?? 0; let end = sorted[0]?.[1] ?? 0;
  for (const [s, e] of sorted.slice(1)) {
    if (s <= end) end = Math.max(end, e);
    else { total += end - start; start = s; end = e; }
  }
  return (total + end - start) / 60_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function loadSegments(database: DatabaseSync): Segment[] {
  const rows = database.prepare(`
    SELECT MIN(id) AS id, source_name AS sourceName, source_category AS sourceCategory,
           value_text AS value, start_at AS startAt, end_at AS endAt
    FROM health_records
    WHERE type = ?
    GROUP BY source_name, source_category, value_text, start_at, end_at
    ORDER BY start_at, id
  `).all(healthTypes.sleepAnalysis) as unknown as Array<Record<string, string>>;
  return rows.map((row) => ({
    id: row.id!, sourceName: row.sourceName!, sourceCategory: row.sourceCategory!, value: row.value ?? "",
    start: Date.parse(row.startAt!), end: Date.parse(row.endAt!)
  })).filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start);
}

function loadHrv(database: DatabaseSync): Array<{ id: string; sourceName: string; start: number; value: number }> {
  const rows = database.prepare(`
    SELECT MIN(id) AS id, source_name AS sourceName, start_at AS startAt, value_numeric AS value
    FROM health_records
    WHERE type = ? AND value_numeric IS NOT NULL
    GROUP BY source_name, start_at, value_numeric
    ORDER BY start_at, id
  `).all(healthTypes.hrvSdnn) as unknown as Array<Record<string, string | number>>;
  return rows.map((row) => ({ id: String(row.id), sourceName: String(row.sourceName), start: Date.parse(String(row.startAt)), value: Number(row.value) }))
    .filter((row) => Number.isFinite(row.start) && Number.isFinite(row.value) && row.value >= 0);
}

function buildNight(wakeDate: string, timezone: string, kind: CanonicalNightKind, source: { sourceName: string; sourceCategory: string; rank: number }, segments: Segment[], competingSourceCount: number): CanonicalNight {
  const asleep = segments.filter((s) => s.value.includes("Asleep"));
  const inBed = segments.filter((s) => s.value.includes("InBed"));
  const awake = segments.filter((s) => s.value.includes("Awake"));
  const stageIntervals = (key: string) => segments.filter((s) => s.value === key).map((s) => [s.start, s.end] as [number, number]);
  const stageMinutes = {
    core: unionMinutes(stageIntervals("HKCategoryValueSleepAnalysisAsleepCore")),
    deep: unionMinutes(stageIntervals("HKCategoryValueSleepAnalysisAsleepDeep")),
    rem: unionMinutes(stageIntervals("HKCategoryValueSleepAnalysisAsleepREM")),
    unspecified: unionMinutes(stageIntervals("HKCategoryValueSleepAnalysisAsleepUnspecified") .concat(stageIntervals("HKCategoryValueSleepAnalysisAsleep"))),
    awake: unionMinutes(stageIntervals("HKCategoryValueSleepAnalysisAwake"))
  };
  const onset = asleep.reduce<number | null>((v, s) => v === null ? s.start : Math.min(v, s.start), null);
  const wake = asleep.reduce<number | null>((v, s) => v === null ? s.end : Math.max(v, s.end), null);
  const id = stableId("canonical_night", [wakeDate, timezone, kind, source.sourceName, onset]);
  return {
    id, wakeDate, timezoneIdentifier: timezone, kind, sourceName: source.sourceName, sourceCategory: source.sourceCategory,
    sourceRank: source.rank, hasStages: segments.some((s) => STAGE_VALUES.has(s.value) && s.value.includes("Asleep")),
    sleepOnsetAt: onset === null ? null : new Date(onset).toISOString(), wakeAt: wake === null ? null : new Date(wake).toISOString(),
    asleepUnionMinutes: asleep.length ? unionMinutes(asleep.map((s) => [s.start, s.end])) : null,
    inBedUnionMinutes: inBed.length ? unionMinutes(inBed.map((s) => [s.start, s.end])) : null,
    awakeMinutes: awake.length ? unionMinutes(awake.map((s) => [s.start, s.end])) : null,
    stageMinutes, segmentCount: segments.length,
    provenance: { algorithmVersion: CANONICAL_NIGHT_ALGORITHM_VERSION, competingSourceCount, rejectedInBedOnly: false }
  };
}

export interface CanonicalizationNightsResult { mainCount: number; napCount: number; hrvCount: number; rejectedInBedOnly: number; timezoneIdentifier: string }

export function canonicalizeNights(database: DatabaseSync, timezoneIdentifier = "Asia/Shanghai"): CanonicalizationNightsResult {
  const all = loadSegments(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM canonical_hrv_days; DELETE FROM canonical_nights;");
    if (all.length === 0) { database.exec("COMMIT"); return { mainCount: 0, napCount: 0, hrvCount: 0, rejectedInBedOnly: 0, timezoneIdentifier }; }
    const dates = all.map((s) => localDateAt(s.start, timezoneIdentifier));
    const minDate = dates.sort()[0]!; const maxDate = dates.sort().at(-1)!;
    const hrv = loadHrv(database); let date = minDate; let mainCount = 0; let napCount = 0; let hrvCount = 0; let rejected = 0;
    const insertNight = database.prepare(`INSERT INTO canonical_nights (id,wake_date,timezone_identifier,kind,source_name,source_category,source_rank,has_stages,sleep_onset_at,wake_at,asleep_union_minutes,in_bed_union_minutes,awake_minutes,stage_minutes_json,segment_count,provenance_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    while (date <= maxDate) {
      const windowStart = Date.parse(localDateTimeAt(`${addLocalDays(date, -1)}T18:00:00`, timezoneIdentifier));
      const windowEnd = Date.parse(localDateTimeAt(`${date}T14:00:00`, timezoneIdentifier));
      const candidates = all.filter((s) => s.end > windowStart && s.start < windowEnd).map((s) => ({ ...s, start: Math.max(s.start, windowStart), end: Math.min(s.end, windowEnd) }));
      const bySource = new Map<string, Segment[]>();
      for (const seg of candidates) {
        const key = `${seg.sourceName}\u0000${seg.sourceCategory}`; const list = bySource.get(key) ?? []; list.push(seg); bySource.set(key, list);
      }
      const sourceGroups = [...bySource.entries()].map(([key, segs]) => {
        const [sourceName, sourceCategory] = key.split("\u0000");
        const asleep = segs.filter((s) => s.value.includes("Asleep"));
        return { sourceName: sourceName!, sourceCategory: sourceCategory!, segs, asleep, rank: sourceRank(sourceCategory!, asleep.some((s) => STAGE_VALUES.has(s.value))) };
      }).filter((group) => group.asleep.length > 0).sort((a, b) => a.rank - b.rank || b.asleep.length - a.asleep.length || a.sourceName.localeCompare(b.sourceName));
      if (sourceGroups.length === 0) { if (candidates.some((s) => s.value.includes("InBed"))) rejected += 1; date = addLocalDays(date, 1); continue; }
      const winning = sourceGroups[0]!;
      const sessions: Segment[][] = [];
      for (const seg of winning.segs.filter((s) => s.value.includes("Asleep") || s.value.includes("InBed") || s.value.includes("Awake")).sort((a, b) => a.start - b.start)) {
        const current = sessions.at(-1); if (!current || seg.start - Math.max(...current.map((item) => item.end)) > 90 * 60_000) sessions.push([seg]); else current.push(seg);
      }
      const built = sessions.map((session) => buildNight(date, timezoneIdentifier, "nap", winning, session, sourceGroups.length));
      built.sort((a, b) => (b.asleepUnionMinutes ?? 0) - (a.asleepUnionMinutes ?? 0));
      for (const [index, night] of built.entries()) {
        night.kind = index === 0 ? "main" : "nap";
        insertNight.run(
          night.id, night.wakeDate, night.timezoneIdentifier, night.kind, night.sourceName, night.sourceCategory, night.sourceRank, night.hasStages ? 1 : 0,
          night.sleepOnsetAt, night.wakeAt, night.asleepUnionMinutes, night.inBedUnionMinutes, night.awakeMinutes, JSON.stringify(night.stageMinutes), night.segmentCount, JSON.stringify(night.provenance));
        if (night.kind === "main") {
          mainCount += 1;
          const samples = hrv.filter((sample) => night.sleepOnsetAt && night.wakeAt && sample.start >= Date.parse(night.sleepOnsetAt) && sample.start <= Date.parse(night.wakeAt));
          const confidence: HrvDayConfidence = samples.length >= 2 ? "confident" : samples.length === 1 ? "sparse" : "missing";
          const hrvId = stableId("canonical_hrv_day", [date, timezoneIdentifier, night.id]);
          database.prepare(`INSERT INTO canonical_hrv_days (id,local_date,timezone_identifier,night_id,hrv_sdnn_ms,sample_count,confidence,window_start_at,window_end_at,source_name,provenance_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
            hrvId, date, timezoneIdentifier, night.id, median(samples.map((s) => s.value)), samples.length, confidence, night.sleepOnsetAt, night.wakeAt,
            samples[0]?.sourceName ?? null, JSON.stringify({ algorithmVersion: CANONICAL_NIGHT_ALGORITHM_VERSION, fallbackWatch: false }));
          hrvCount += 1;
        } else napCount += 1;
      }
      // Explicit afternoon nap pass: 14:00-18:00 is outside the main night window.
      const napStart = Date.parse(localDateTimeAt(`${date}T14:00:00`, timezoneIdentifier));
      const napEnd = Date.parse(localDateTimeAt(`${date}T18:00:00`, timezoneIdentifier));
      const napGroups = new Map<string, Segment[]>();
      for (const raw of all) {
        const start = Math.max(raw.start, napStart); const end = Math.min(raw.end, napEnd);
        if (end <= start || !raw.value.includes("Asleep")) continue;
        const key = `${raw.sourceName}\u0000${raw.sourceCategory}`;
        const list = napGroups.get(key) ?? [];
        list.push({ ...raw, start, end });
        napGroups.set(key, list);
      }
      for (const [key, segments] of napGroups) {
        const [sourceName, sourceCategory] = key.split("\u0000");
        const rank = sourceRank(sourceCategory ?? "other", segments.some((s) => s.value.includes("Core") || s.value.includes("Deep") || s.value.includes("REM")));
        const sessions: Segment[][] = [];
        for (const seg of segments.sort((a, b) => a.start - b.start)) {
          const current = sessions.at(-1); const lastEnd = current?.reduce((max, item) => Math.max(max, item.end), -Infinity) ?? -Infinity;
          if (!current || seg.start - lastEnd >= 90 * 60_000) sessions.push([seg]); else current.push(seg);
        }
        for (const session of sessions) {
          const night = buildNight(date, timezoneIdentifier, "nap", { sourceName: sourceName ?? "", sourceCategory: sourceCategory ?? "other", rank }, session, 0);
          if (!night.asleepUnionMinutes) continue;
          insertNight.run(night.id, night.wakeDate, night.timezoneIdentifier, night.kind, night.sourceName, night.sourceCategory, night.sourceRank, night.hasStages ? 1 : 0, night.sleepOnsetAt, night.wakeAt, night.asleepUnionMinutes, night.inBedUnionMinutes, night.awakeMinutes, JSON.stringify(night.stageMinutes), night.segmentCount, JSON.stringify(night.provenance));
          napCount += 1;
        }
      }
      date = addLocalDays(date, 1);
    }
    database.exec("COMMIT");
    return { mainCount, napCount, hrvCount, rejectedInBedOnly: rejected, timezoneIdentifier };
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
