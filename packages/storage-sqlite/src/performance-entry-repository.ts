import type { DatabaseSync } from "node:sqlite";

import { SQL_UTC_OFFSET_MODIFIER, localDateAt, performanceResultValidationError, raceDistanceMeters,
  type PerformanceEntry, type PerformanceEntryDistance } from "@rai/contracts";

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

export const PERFORMANCE_ENTRY_DISTANCE_METERS: Record<PerformanceEntryDistance, number> = raceDistanceMeters;

/** Every representation of a race event, with eligibility as known at the requested instant. */
export function loadPerformanceEventSessions(
  database: DatabaseSync,
  entry: Pick<PerformanceEntry, "localDate" | "distance" | "trainingSessionId">,
  asOf?: string
): Array<{ id: string; status: string; eligibilityOverride: string | null }> {
  const nominalKm = PERFORMANCE_ENTRY_DISTANCE_METERS[entry.distance] / 1000;
  const select = `SELECT session.id, session.status,
    (SELECT eligibility_override FROM workout_overrides
      WHERE training_session_id = session.id AND julianday(created_at) <= julianday(?)
      ORDER BY julianday(created_at) DESC, revision DESC LIMIT 1) AS eligibilityOverride
    FROM training_sessions session`;
  const rows = entry.trainingSessionId
    ? database.prepare(`${select}
        JOIN training_sessions linked ON linked.id = ?
        WHERE session.id = linked.id OR (
          session.anchor_distance_km BETWEEN ? AND ?
          AND julianday(session.anchor_start_at) < julianday(linked.anchor_end_at)
          AND julianday(session.anchor_end_at) > julianday(linked.anchor_start_at)
        ) ORDER BY session.id
      `).all(asOf ?? null, entry.trainingSessionId, nominalKm * 0.9, nominalKm * 1.1)
    : database.prepare(`${select}
        WHERE date(session.anchor_end_at, '${SQL_UTC_OFFSET_MODIFIER}') = ?
          AND session.anchor_distance_km BETWEEN ? AND ?
        ORDER BY session.id
      `).all(asOf ?? null, entry.localDate, nominalKm * 0.9, nominalKm * 1.1);
  return rows as unknown as Array<{ id: string; status: string; eligibilityOverride: string | null }>;
}

function assertEntry(entry: Pick<StoredPerformanceEntry, "localDate" | "distance" | "durationSeconds">): void {
  const day = Date.parse(`${entry.localDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.localDate) || !Number.isFinite(day) ||
      new Date(day).toISOString().slice(0, 10) !== entry.localDate) {
    throw new PerformanceEntryValidationError("localDate must be a local calendar date");
  }
  if (!DISTANCES.includes(entry.distance)) {
    throw new PerformanceEntryValidationError(`distance must be one of ${DISTANCES.join(", ")}`);
  }
  const error = performanceResultValidationError(PERFORMANCE_ENTRY_DISTANCE_METERS[entry.distance], entry.durationSeconds);
  if (error !== null) throw new PerformanceEntryValidationError(error);
}

export class SqlitePerformanceEntryRepository {
  constructor(private readonly database: DatabaseSync) {}

  /** Entries that were **available** at `asOf`: entered by then, and not withdrawn by then. */
  availableAt(asOf: string): StoredPerformanceEntry[] {
    if (!Number.isFinite(Date.parse(asOf))) throw new Error("asOf must be a valid instant");
    const rows = this.database
      .prepare(`
        SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY local_date, distance ORDER BY julianday(recorded_at), id
          ) AS event_rank
          FROM performance_entries
          WHERE julianday(recorded_at) <= julianday(?)
            AND (revoked_at IS NULL OR julianday(revoked_at) > julianday(?))
        ) WHERE event_rank = 1
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
    trainingSessionId?: string | null;
  }): StoredPerformanceEntry {
    assertEntry(input);
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(recordedAt))) {
      throw new PerformanceEntryValidationError("recordedAt must be a valid instant");
    }
    if (input.trainingSessionId !== undefined && input.trainingSessionId !== null &&
        (typeof input.trainingSessionId !== "string" || input.trainingSessionId.trim().length === 0)) {
      throw new PerformanceEntryValidationError("trainingSessionId must be a non-empty identifier");
    }
    const session = input.trainingSessionId ? this.database.prepare(`
      SELECT anchor_start_at AS observedAt, anchor_end_at AS completedAt,
        anchor_distance_km AS distanceKm, status
      FROM training_sessions WHERE id = ?
    `).get(input.trainingSessionId) as {
      observedAt: string; completedAt: string; distanceKm: number; status: string;
    } | undefined : undefined;
    if (input.trainingSessionId) {
      const nominalKm = PERFORMANCE_ENTRY_DISTANCE_METERS[input.distance] / 1000;
      if (!session || session.status !== "active" || !Number.isFinite(Date.parse(session.observedAt)) ||
          !Number.isFinite(Date.parse(session.completedAt)) || Date.parse(session.observedAt) >= Date.parse(session.completedAt) ||
          localDateAt(session.completedAt) !== input.localDate ||
          !(session.distanceKm >= nominalKm * 0.9 && session.distanceKm <= nominalKm * 1.1) ||
          Date.parse(session.completedAt) > Date.parse(recordedAt)) {
        throw new PerformanceEntryValidationError("trainingSessionId must identify a completed workout on this date and distance");
      }
      if (loadPerformanceEventSessions(this.database, input, recordedAt)
        .some(eventSession => eventSession.eligibilityOverride === "exclude")) {
        throw new PerformanceEntryValidationError("该比赛事件关联的训练已被排除，请先恢复训练资格再确认成绩");
      }
    }
    const id = `performance_entry_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    const inserted = this.database
      .prepare(`
        INSERT INTO performance_entries (id, local_date, distance, duration_seconds, source, note, recorded_at, revoked_at, revision,
          training_session_id, observed_at, completed_at)
        SELECT ?, ?, ?, ?, 'manual', ?, ?, NULL, 1, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM performance_entries
          WHERE local_date = ? AND distance = ? AND revoked_at IS NULL
        )
      `)
      .run(id, input.localDate, input.distance, input.durationSeconds, input.note, recordedAt,
        input.trainingSessionId ?? null, session?.observedAt ?? null, session?.completedAt ?? null, input.localDate, input.distance);
    if (Number(inserted.changes) === 0) {
      throw new PerformanceEntryValidationError("同日同距离已有成绩，请先撤销旧条目再录入更正成绩");
    }
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
    revision: Number(row.revision),
    trainingSessionId: typeof row.training_session_id === "string" ? row.training_session_id : null,
    observedAt: typeof row.observed_at === "string" ? row.observed_at : null,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null
  };
}
