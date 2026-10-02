import type { DatabaseSync } from "node:sqlite";

import type { PerformanceEntry, PerformanceEntryDistance } from "@rai/contracts";

/**
 * Manually entered race results (docs/ALGORITHM.md §12.10).
 *
 * The label pipeline only ever accepted labels attached to a training session, so a
 * runner with years of race results but no watch data on those days had **zero**
 * labels — which is exactly the state the project's own review recorded ("零有效比赛/
 * 测试标签"). This table is the missing door: a date, a distance and a time.
 *
 * Two properties are deliberate and load-bearing:
 *
 * 1. `recordedAt` is the moment the runner entered it, and the prediction pipeline
 *    treats *that* as the label's availability, not the race date. A 2023 result
 *    typed in today must not appear inside a prediction that was made yesterday.
 * 2. `revokedAt` is a tombstone, not a delete: T03 requires that a withdrawn label
 *    propagates its invalidation instead of vanishing silently.
 *
 * An entry is label-only evidence: it can calibrate and be evaluated against, and it
 * can never create a route, a heart-rate series or an ability assessment.
 */

export type { PerformanceEntryDistance } from "@rai/contracts";

/** Storage-side alias: the contract shape is what callers read. */
export type StoredPerformanceEntry = PerformanceEntry;

export class PerformanceEntryValidationError extends Error {
  readonly code = "performance_entry_invalid";
}

const DISTANCES: readonly PerformanceEntryDistance[] = ["five_k", "ten_k", "half_marathon"];

/** Bounds shared with the workout-label path so a manual entry cannot be "faster" than a real one. */
const MINIMUM_SECONDS = 12 * 60;
const MAXIMUM_SECONDS = 4 * 60 * 60;
const MINIMUM_PACE_SECONDS_PER_KM = 150;
const MAXIMUM_PACE_SECONDS_PER_KM = 900;

export const PERFORMANCE_ENTRY_DISTANCE_METERS: Record<PerformanceEntryDistance, number> = {
  five_k: 5_000,
  ten_k: 10_000,
  half_marathon: 21_097.5
};

function assertEntry(entry: Pick<StoredPerformanceEntry, "localDate" | "distance" | "durationSeconds">): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.localDate) || !Number.isFinite(Date.parse(`${entry.localDate}T00:00:00Z`))) {
    throw new PerformanceEntryValidationError("localDate must be a local calendar date");
  }
  if (!DISTANCES.includes(entry.distance)) {
    throw new PerformanceEntryValidationError(`distance must be one of ${DISTANCES.join(", ")}`);
  }
  if (!Number.isFinite(entry.durationSeconds) || entry.durationSeconds < MINIMUM_SECONDS || entry.durationSeconds > MAXIMUM_SECONDS) {
    throw new PerformanceEntryValidationError("durationSeconds is outside the range a race result can occupy");
  }
  const pace = entry.durationSeconds / (PERFORMANCE_ENTRY_DISTANCE_METERS[entry.distance] / 1_000);
  if (pace < MINIMUM_PACE_SECONDS_PER_KM || pace > MAXIMUM_PACE_SECONDS_PER_KM) {
    throw new PerformanceEntryValidationError("implied pace is outside the range a race result can occupy");
  }
}

export class SqlitePerformanceEntryRepository {
  constructor(private readonly database: DatabaseSync) {}

  /** Entries that were **available** at `asOf`: entered by then, and not withdrawn by then. */
  availableAt(asOf: string): StoredPerformanceEntry[] {
    if (!Number.isFinite(Date.parse(asOf))) throw new Error("asOf must be a valid instant");
    const rows = this.database
      .prepare(`
        SELECT * FROM performance_entries
        WHERE recorded_at <= ?
          AND (revoked_at IS NULL OR revoked_at > ?)
        ORDER BY local_date, id
      `)
      .all(asOf, asOf) as unknown as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  list(): StoredPerformanceEntry[] {
    const rows = this.database
      .prepare("SELECT * FROM performance_entries ORDER BY local_date DESC, id")
      .all() as unknown as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  insert(input: {
    localDate: string;
    distance: PerformanceEntryDistance;
    durationSeconds: number;
    note: string | null;
    recordedAt?: string;
  }): StoredPerformanceEntry {
    assertEntry(input);
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(recordedAt))) {
      throw new PerformanceEntryValidationError("recordedAt must be a valid instant");
    }
    const id = `performance_entry_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    this.database
      .prepare(`
        INSERT INTO performance_entries (id, local_date, distance, duration_seconds, source, note, recorded_at, revoked_at, revision)
        VALUES (?, ?, ?, ?, 'manual', ?, ?, NULL, 1)
      `)
      .run(id, input.localDate, input.distance, input.durationSeconds, input.note, recordedAt);
    const row = this.database.prepare("SELECT * FROM performance_entries WHERE id = ?").get(id) as unknown as Record<string, unknown>;
    return mapRow(row);
  }

  /** Tombstone, not a delete: the invalidation has a timestamp that later readers can honour. */
  revoke(id: string, revokedAt = new Date().toISOString()): boolean {
    if (!Number.isFinite(Date.parse(revokedAt))) {
      throw new PerformanceEntryValidationError("revokedAt must be a valid instant");
    }
    const result = this.database
      .prepare(`
        UPDATE performance_entries
        SET revoked_at = ?, revision = revision + 1
        WHERE id = ? AND revoked_at IS NULL
      `)
      .run(revokedAt, id);
    return Number(result.changes) > 0;
  }
}

function mapRow(row: Record<string, unknown>): StoredPerformanceEntry {
  return {
    id: String(row.id),
    localDate: String(row.local_date),
    distance: String(row.distance) as PerformanceEntryDistance,
    durationSeconds: Number(row.duration_seconds),
    source: "manual",
    note: typeof row.note === "string" ? row.note : null,
    recordedAt: String(row.recorded_at),
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
    revision: Number(row.revision)
  };
}
