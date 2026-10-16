import type { DatabaseSync } from "node:sqlite";
import { healthTypes, scoringHealthTypes } from "@rai/contracts";
import {
  isCanonicalInstant as canonicalInstant,
  rewindToOverlappingWorkoutStart,
  type DirtyRangeWorkout
} from "@rai/health-export-parser";

/**
 * 评分类型清单的**唯一定义**在 `@rai/contracts`（见那里的说明：它同时是批次分类与
 * record-only 车道结构闸门的输入，两处各写一份等于允许它们悄悄分叉）。
 * 这里只做转发，保持既有调用点的 import 路径不变。
 */
export { scoringHealthTypes };

export interface HealthChangePlan {
  changed: boolean;
  full: boolean;
  dirtyFromAt: string | null;
  reasons: string[];
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
    //
    // O04（WP-20）：判定谓词与直连车道**共用同一个原语**（`rewindToOverlappingWorkoutStart`，
    // 单点区间 = 与 `start_at < ? AND end_at >= ?` 逐字同义）—— 这里保持两代库的读法
    // （main ∪ previous），只把"怎么判相交"收敛到单点定义，防止两处悄悄分叉。
    const crossingRows = database.prepare(`
      SELECT workout.start_at AS startAt, workout.end_at AS endAt FROM training_sessions session
      JOIN workouts workout ON workout.id=session.canonical_workout_id
      UNION ALL
      SELECT workout.start_at AS startAt, workout.end_at AS endAt FROM previous.training_sessions session
      JOIN previous.workouts workout ON workout.id=session.canonical_workout_id
    `).all() as unknown as DirtyRangeWorkout[];
    const rewound = rewindToOverlappingWorkoutStart(
      [{ start: dirtyFromAt, end: dirtyFromAt }], crossingRows
    );
    if (rewound !== null) { add(rewound); reasons.add("overlapping_workout_rewound"); }
  }
  if (changed && dirtyFromAt === null) { full = true; reasons.add("health_boundary_unknown"); }
  return { changed, full, dirtyFromAt, reasons: [...reasons] };
}
