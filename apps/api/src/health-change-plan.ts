import type { DatabaseSync } from "node:sqlite";
import { healthTypes } from "@rai/contracts";

export const scoringHealthTypes = [
  healthTypes.heartRate, healthTypes.runningSpeed, healthTypes.restingHeartRate,
  healthTypes.sleepAnalysis, healthTypes.hrvSdnn, healthTypes.vo2Max
] as const;

export interface HealthChangePlan {
  changed: boolean;
  full: boolean;
  dirtyFromAt: string | null;
  reasons: string[];
}

function canonicalInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

/** Requires a completed import ledger. Read both before/after facts: updates
 * can move timestamps forward, change type, or delete the only known interval. */
export function planHealthChanges(database: DatabaseSync, batchId: string | null): HealthChangePlan {
  let changed = false, full = false;
  let dirtyFromAt: string | null = null;
  const reasons = new Set<string>();
  const add = (value: unknown): void => {
    if (!canonicalInstant(value)) { full = true; reasons.add("invalid_health_time"); return; }
    if (dirtyFromAt === null || value < dirtyFromAt) dirtyFromAt = value;
  };
  const changes = batchId === null ? [] : database.prepare(`
    SELECT current.id AS newId, current.type AS newType, current.start_at AS newStart, current.end_at AS newEnd,
           old.id AS oldId, old.type AS oldType, old.start_at AS oldStart, old.end_at AS oldEnd
    FROM import_entity_changes change
    LEFT JOIN health_records current ON current.id = change.entity_id
    LEFT JOIN previous.health_records old ON old.id = change.entity_id
    WHERE change.batch_id = ? AND change.entity_kind = 'record'
  `).iterate(batchId) as Iterable<{
    newId: string | null; newType: string | null; newStart: string | null; newEnd: string | null;
    oldId: string | null; oldType: string | null; oldStart: string | null; oldEnd: string | null;
  }>;
  for (const row of changes) {
    if (!row.newId && !row.oldId) {
      changed = true; full = true; reasons.add("unresolved_record_change"); continue;
    }
    for (const [type, start, end] of [[row.newType, row.newStart, row.newEnd], [row.oldType, row.oldStart, row.oldEnd]]) {
      if (!(scoringHealthTypes as readonly unknown[]).includes(type)) continue;
      changed = true;
      if (type === healthTypes.vo2Max) { full = true; reasons.add("vo2_evidence_changed"); }
      add(start);
      if (!canonicalInstant(end) || !canonicalInstant(start) || end < start) {
        full = true; reasons.add("invalid_health_interval");
      }
    }
  }
  if (changed && !full) reasons.add("bounded_health_change");

  // Canonical selection can change availability EARLIER than a late raw sleep
  // sample (e.g. an afternoon session replaces the morning's main night).
  // Ignore computed_at: canonicalization rewrites it even when facts are equal.
  for (const table of ["canonical_nights", "canonical_hrv_days"] as const) {
    const columns = (database.prepare(`PRAGMA main.table_info(${table})`).all() as { name: string }[])
      .map((row) => row.name).filter((column) => column !== "computed_at");
    const oldColumns = new Set((database.prepare(`PRAGMA previous.table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
    if (!columns.length || oldColumns.size !== columns.length + 1 || columns.some((name) => !oldColumns.has(name))) {
      changed = true; full = true; reasons.add("recovery_schema_unavailable");
      continue;
    }
    const fields = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(",");
    const filter = table === "canonical_nights" ? " WHERE kind='main'" : "";
    const versionSql = "CASE WHEN json_valid(provenance_json) THEN json_extract(provenance_json, '$.algorithmVersion') ELSE '__invalid__' END";
    const oldVersions = database.prepare(`SELECT DISTINCT ${versionSql} AS version FROM previous.${table}`).all();
    const newVersions = database.prepare(`SELECT DISTINCT ${versionSql} AS version FROM main.${table}`).all();
    if (oldVersions.length && newVersions.length &&
        JSON.stringify(oldVersions.map((row) => row.version).sort()) !== JSON.stringify(newVersions.map((row) => row.version).sort())) {
      changed = true; full = true; reasons.add("recovery_algorithm_changed");
    }
    for (const [current, other] of [["main", "previous"], ["previous", "main"]] as const) {
      const changedRows = database.prepare(`
        SELECT ${fields} FROM ${current}.${table}${filter}
        EXCEPT SELECT ${fields} FROM ${other}.${table}${filter}
      `).iterate() as Iterable<Record<string, unknown>>;
      for (const row of changedRows) {
        changed = true; reasons.add("canonical_recovery_changed");
        if (table === "canonical_nights") add(row.wake_at);
        else {
          const night = database.prepare(`SELECT wake_at AS wakeAt FROM ${current}.canonical_nights WHERE id=?`)
            .get(String(row.night_id)) as { wakeAt: string | null } | undefined;
          add(night?.wakeAt);
          add(row.window_end_at);
        }
      }
    }
  }
  if (changed && dirtyFromAt !== null && !full) {
    // Rewind to a workout that began before the changed sample. Recomputing all
    // later workouts also covers the 180-day HR maximum and recovery baselines.
    const crossing = database.prepare(`
      SELECT MIN(startAt) AS startAt FROM (
        SELECT workout.start_at AS startAt FROM training_sessions session
        JOIN workouts workout ON workout.id=session.canonical_workout_id
        WHERE workout.start_at < ? AND workout.end_at >= ?
        UNION ALL
        SELECT workout.start_at FROM previous.training_sessions session
        JOIN previous.workouts workout ON workout.id=session.canonical_workout_id
        WHERE workout.start_at < ? AND workout.end_at >= ?
      )
    `).get(dirtyFromAt, dirtyFromAt, dirtyFromAt, dirtyFromAt) as { startAt: string | null };
    if (crossing.startAt) { add(crossing.startAt); reasons.add("overlapping_workout_rewound"); }
  }
  if (changed && dirtyFromAt === null) { full = true; reasons.add("health_boundary_unknown"); }
  return { changed, full, dirtyFromAt, reasons: [...reasons] };
}
