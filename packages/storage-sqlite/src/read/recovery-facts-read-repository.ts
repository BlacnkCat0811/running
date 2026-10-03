import type { DatabaseSync } from "node:sqlite";

export interface StoredCanonicalNight {
  id: string; wakeDate: string; timezoneIdentifier: string; kind: "main" | "nap";
  sourceName: string; sourceCategory: string; sourceRank: number; hasStages: boolean;
  sleepOnsetAt: string | null; wakeAt: string | null; asleepUnionMinutes: number | null;
  inBedUnionMinutes: number | null; awakeMinutes: number | null;
  stageMinutes: { core: number; deep: number; rem: number; unspecified: number; awake: number };
  segmentCount: number; provenance: Record<string, unknown>;
}

function mapNight(row: Record<string, unknown>): StoredCanonicalNight {
  return {
    id: String(row.id), wakeDate: String(row.wake_date), timezoneIdentifier: String(row.timezone_identifier), kind: row.kind as "main" | "nap",
    sourceName: String(row.source_name), sourceCategory: String(row.source_category), sourceRank: Number(row.source_rank), hasStages: Number(row.has_stages) === 1,
    sleepOnsetAt: row.sleep_onset_at as string | null, wakeAt: row.wake_at as string | null,
    asleepUnionMinutes: row.asleep_union_minutes as number | null, inBedUnionMinutes: row.in_bed_union_minutes as number | null,
    awakeMinutes: row.awake_minutes as number | null, stageMinutes: JSON.parse(String(row.stage_minutes_json ?? "{}")),
    segmentCount: Number(row.segment_count), provenance: JSON.parse(String(row.provenance_json ?? "{}"))
  };
}

export interface StoredCanonicalHrvDay {
  id: string; localDate: string; timezoneIdentifier: string; nightId: string; hrvSdnnMs: number | null;
  sampleCount: number; confidence: "confident" | "sparse" | "missing"; windowStartAt: string | null; windowEndAt: string | null; sourceName: string | null; provenance: Record<string, unknown>;
}

function mapHrvDay(row: Record<string, unknown>): StoredCanonicalHrvDay {
  return { id: String(row.id), localDate: String(row.local_date), timezoneIdentifier: String(row.timezone_identifier), nightId: String(row.night_id), hrvSdnnMs: row.hrv_sdnn_ms as number | null, sampleCount: Number(row.sample_count), confidence: row.confidence as StoredCanonicalHrvDay["confidence"], windowStartAt: row.window_start_at as string | null, windowEndAt: row.window_end_at as string | null, sourceName: row.source_name as string | null, provenance: JSON.parse(String(row.provenance_json ?? "{}")) };
}

export class SqliteRecoveryFactsReadRepository {
  constructor(private readonly database: DatabaseSync) {}

  loadCanonicalNight(wakeDate: string, timezoneIdentifier: string): StoredCanonicalNight | null {
    const row = this.database.prepare("SELECT * FROM canonical_nights WHERE wake_date = ? AND timezone_identifier = ? AND kind = 'main'").get(wakeDate, timezoneIdentifier) as unknown as Record<string, unknown> | undefined;
    return row ? mapNight(row) : null;
  }

  loadNaps(wakeDate: string, timezoneIdentifier: string): StoredCanonicalNight[] {
    const rows = this.database.prepare("SELECT * FROM canonical_nights WHERE wake_date = ? AND timezone_identifier = ? AND kind = 'nap' ORDER BY sleep_onset_at").all(wakeDate, timezoneIdentifier) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapNight);
  }

  loadRecentMainNights(endWakeDate: string, count: number, timezoneIdentifier: string): StoredCanonicalNight[] {
    const rows = this.database.prepare("SELECT * FROM canonical_nights WHERE wake_date <= ? AND timezone_identifier = ? AND kind = 'main' ORDER BY wake_date DESC LIMIT ?").all(endWakeDate, timezoneIdentifier, Math.max(0, count)) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapNight);
  }

  loadMainNightsRange(from: string, through: string, timezoneIdentifier: string): StoredCanonicalNight[] {
    const rows = this.database.prepare("SELECT * FROM canonical_nights WHERE wake_date >= ? AND wake_date <= ? AND timezone_identifier = ? AND kind = 'main' ORDER BY wake_date")
      .all(from, through, timezoneIdentifier) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapNight);
  }

  loadHrvDay(localDate: string, timezoneIdentifier: string): StoredCanonicalHrvDay | null {
    const row = this.database.prepare("SELECT * FROM canonical_hrv_days WHERE local_date = ? AND timezone_identifier = ?").get(localDate, timezoneIdentifier) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapHrvDay(row);
  }

  loadHrvDaysRange(from: string, through: string, timezoneIdentifier: string): StoredCanonicalHrvDay[] {
    const rows = this.database.prepare("SELECT * FROM canonical_hrv_days WHERE local_date >= ? AND local_date <= ? AND timezone_identifier = ? ORDER BY local_date")
      .all(from, through, timezoneIdentifier) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapHrvDay);
  }

  /**
   * Newest main-night wake date, regardless of which date the caller asked
   * about. `loadCanonicalNight` answers "is there a night for this date"; this
   * answers "how far back is the newest one", which is what separates a coverage
   * gap from a stop in the feed.
   */
  latestMainNightDate(timezoneIdentifier: string): string | null {
    const row = this.database.prepare("SELECT MAX(wake_date) AS value FROM canonical_nights WHERE kind = 'main' AND timezone_identifier = ?").get(timezoneIdentifier) as { value?: string | null } | undefined;
    return row?.value ?? null;
  }

  /** Newest overnight-HRV local date. */
  latestHrvDate(timezoneIdentifier: string): string | null {
    const row = this.database.prepare("SELECT MAX(local_date) AS value FROM canonical_hrv_days WHERE timezone_identifier = ?").get(timezoneIdentifier) as { value?: string | null } | undefined;
    return row?.value ?? null;
  }

  /** Newest resting-heart-rate sample instant, as an ISO timestamp. */
  latestRestingHeartRateAt(): string | null {
    const row = this.database.prepare("SELECT MAX(start_at) AS value FROM health_records WHERE type = 'HKQuantityTypeIdentifierRestingHeartRate' AND value_numeric IS NOT NULL").get() as { value?: string | null } | undefined;
    return row?.value ?? null;
  }

  /**
   * Newest raw HealthKit sample instant of any type, as an ISO timestamp.
   *
   * A full scan by design: `idx_health_records_type_time` leads with `type`, so
   * nothing can answer a time-maximum across all types. This is the one number
   * that separates "the feed stopped" from "there was nothing to measure", and
   * the store holds ~10^5 rows, so the scan is milliseconds.
   */
  latestHealthSampleAt(): string | null {
    const row = this.database.prepare("SELECT MAX(start_at) AS value FROM health_records").get() as { value?: string | null } | undefined;
    return row?.value ?? null;
  }

  loadRhrMedian(fromIso: string, toIso: string): number | null {
    const rows = this.database.prepare("SELECT source_category AS sourceCategory, value_numeric AS value FROM health_records WHERE type = 'HKQuantityTypeIdentifierRestingHeartRate' AND start_at >= ? AND start_at < ? AND value_numeric IS NOT NULL ORDER BY start_at").all(fromIso, toIso) as unknown as Array<{ sourceCategory: string; value: number }>;
    const watch = rows.filter((r) => r.sourceCategory === "apple_watch"); const selected = watch.length ? watch : rows;
    if (!selected.length) return null; const values = selected.map((r) => Number(r.value)).sort((a, b) => a - b); const i = Math.floor(values.length / 2); return values.length % 2 ? values[i]! : (values[i - 1]! + values[i]!) / 2;
  }

  loadBaselines(asOfIso: string, timezoneIdentifier: string): { sleepMinutes: number | null; hrvSdnnMs: number | null; rhrBpm: number | null } {
    const asOf = Date.parse(asOfIso);
    const nights = this.database.prepare("SELECT asleep_union_minutes AS value FROM canonical_nights WHERE kind='main' AND timezone_identifier=? AND wake_at < ? AND wake_date >= date(?, '-60 days') AND wake_date < date(?)").all(timezoneIdentifier, asOfIso, asOfIso.slice(0, 10), asOfIso.slice(0, 10)) as unknown as Array<{ value: number | null }>;
    const hrvs = this.database.prepare("SELECT hrv_sdnn_ms AS value FROM canonical_hrv_days WHERE timezone_identifier=? AND hrv_sdnn_ms IS NOT NULL AND window_end_at < ? AND local_date >= date(?, '-60 days') AND local_date < date(?)").all(timezoneIdentifier, asOfIso, asOfIso.slice(0, 10), asOfIso.slice(0, 10)) as unknown as Array<{ value: number }>;
    const median = (values: number[]): number | null => { if (!values.length) return null; const sorted = [...values].sort((a,b)=>a-b); const i=Math.floor(sorted.length/2); return sorted.length%2?sorted[i]!:((sorted[i-1]!+sorted[i]!)/2); };
    const rhr = this.loadRhrMedian(new Date(asOf - 60 * 86400000).toISOString(), asOfIso);
    return { sleepMinutes: median(nights.flatMap((r) => r.value == null ? [] : [Number(r.value)])), hrvSdnnMs: median(hrvs.map((r) => Number(r.value))), rhrBpm: rhr };
  }
}
