import { DatabaseSync } from "node:sqlite";
import { healthTypes } from "@rai/contracts";
import { planHealthChanges } from "./health-change-plan.js";

export interface ImportDatasetChange {
  mode: "unchanged" | "data-only" | "incremental" | "full";
  dirtyFromAt: string | null;
  insertedWorkouts: number;
  updatedWorkouts: number;
  removedWorkouts: number;
  unchangedWorkouts: number;
  routesUpdated: number;
  recomputeReasons?: string[];
}

export function analyzeDatasetChange(
  stagingPath: string,
  previousPath: string,
  batchId?: string,
  preserveAbsent?: boolean
): ImportDatasetChange {
  const database = new DatabaseSync(stagingPath);
  database.exec("PRAGMA busy_timeout = 5000");
  try {
    database.prepare("ATTACH DATABASE ? AS previous").run(previousPath);
    const count = (sql: string): number => Number((database.prepare(sql).get() as { count: number }).count);
    const batch = batchId ? database.prepare(`
      SELECT status FROM import_batches WHERE id = ?
    `).get(batchId) as { status: string } | undefined : undefined;
    const useChangeLedger = batch?.status === "succeeded";
    const ledgerBatchId = batchId ?? "";
    database.exec("CREATE TEMP TABLE changed_workout_ids (id TEXT PRIMARY KEY)");
    if (useChangeLedger) database.prepare(`INSERT OR IGNORE INTO changed_workout_ids
      SELECT entity_id FROM import_entity_changes WHERE batch_id=? AND entity_kind='workout'`).run(ledgerBatchId);
    const changedWorkout = `current.canonical_workout_id IS NOT old.canonical_workout_id
      OR current.anchor_start_at <> old.anchor_start_at OR current.anchor_end_at <> old.anchor_end_at
      OR current.anchor_distance_km IS NOT old.anchor_distance_km OR current.status IS NOT old.status
      OR COALESCE(current.canonical_workout_id IN (SELECT id FROM changed_workout_ids),0)
      OR COALESCE(old.canonical_workout_id IN (SELECT id FROM changed_workout_ids),0)`;
    const insertedWorkouts = count(`SELECT COUNT(*) AS count FROM training_sessions current
      WHERE NOT EXISTS (SELECT 1 FROM previous.training_sessions old WHERE old.id = current.id)`);
    const removedWorkouts = count(`SELECT COUNT(*) AS count FROM previous.training_sessions old
      WHERE NOT EXISTS (SELECT 1 FROM training_sessions current WHERE current.id = old.id)`);
    const updatedWorkouts = count(`SELECT COUNT(*) AS count FROM training_sessions current
      JOIN previous.training_sessions old ON old.id = current.id WHERE ${changedWorkout}`);
    const unchangedWorkouts = count(`SELECT COUNT(*) AS count FROM training_sessions current
      JOIN previous.training_sessions old ON old.id = current.id WHERE NOT (${changedWorkout})`);
    const relevantTypes = `(${[
      healthTypes.heartRate,
      healthTypes.restingHeartRate,
      healthTypes.hrvSdnn,
      healthTypes.runningSpeed,
      healthTypes.sleepAnalysis,
      healthTypes.vo2Max
    ].map((type) => `'${type}'`).join(", ")})`;
    const recordDifferent = `current.id IS NULL OR old.id IS NULL OR
      ${["type", "source_name", "source_category", "source_version", "device", "unit", "value_numeric", "value_text", "start_at", "end_at", "created_at", "metadata_json", "raw_attributes_json"].map((column) => `current.${column} IS NOT old.${column}`).join(" OR ")}`;
    const recordDifference = (relevantOnly: boolean): boolean => Boolean((database.prepare(`
      SELECT EXISTS(SELECT 1 FROM health_records current LEFT JOIN previous.health_records old ON old.id=current.id
        WHERE (${recordDifferent}) ${relevantOnly ? `AND (current.type IN ${relevantTypes} OR old.type IN ${relevantTypes})` : ""}
        UNION ALL SELECT 1 FROM previous.health_records old LEFT JOIN health_records current ON current.id=old.id
        WHERE current.id IS NULL ${relevantOnly ? `AND old.type IN ${relevantTypes}` : ""}) AS changed
    `).get() as { changed: number }).changed);
    const healthPlan = planHealthChanges(database, useChangeLedger ? ledgerBatchId : null);
    const healthChanged = healthPlan.changed || (!useChangeLedger && recordDifference(true));
    const anyHealthRecordChanged = useChangeLedger ? Boolean(database.prepare(`SELECT 1 FROM import_entity_changes
      WHERE batch_id=? AND entity_kind='record' LIMIT 1`).get(ledgerBatchId)) : recordDifference(false);
    const contractChanged = count(`SELECT COUNT(*) AS count FROM (
      SELECT key,value FROM import_manifest WHERE key='parser_contract_version'
      EXCEPT SELECT key,value FROM previous.import_manifest WHERE key='parser_contract_version'
    )`) > 0 || count(`SELECT COUNT(*) AS count FROM (
      SELECT key,value FROM previous.import_manifest WHERE key='parser_contract_version'
      EXCEPT SELECT key,value FROM import_manifest WHERE key='parser_contract_version'
    )`) > 0;
    const activitySummaryChanged = useChangeLedger ? Number((database.prepare(`
      SELECT COUNT(*) AS count FROM import_entity_changes
      WHERE batch_id = ? AND entity_kind = 'activity_summary'
    `).get(ledgerBatchId) as { count: number }).count) > 0 : count(`SELECT COUNT(*) AS count FROM (
      SELECT date_components, attributes_json FROM (
        SELECT date_components, attributes_json FROM activity_summaries
        EXCEPT SELECT date_components, attributes_json FROM previous.activity_summaries
      )
      UNION ALL
      SELECT date_components, attributes_json FROM (
        SELECT date_components, attributes_json FROM previous.activity_summaries
        EXCEPT SELECT date_components, attributes_json FROM activity_summaries
      )
    )`) > 0;
    const profileChanged = count(`SELECT COUNT(*) AS count FROM (
      SELECT id, attributes_json FROM (
        SELECT id, attributes_json FROM profile
        EXCEPT SELECT id, attributes_json FROM previous.profile
      )
      UNION ALL
      SELECT id, attributes_json FROM (
        SELECT id, attributes_json FROM previous.profile
        EXCEPT SELECT id, attributes_json FROM profile
      )
    )`) > 0;
    const inventoryChanged = count(`SELECT COUNT(*) AS count FROM (
      SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM (
        SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM entity_inventory
        EXCEPT
        SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM previous.entity_inventory
      )
      UNION ALL
      SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM (
        SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM previous.entity_inventory
        EXCEPT
        SELECT entity_kind, entity_type, item_count, first_at, last_at, details_json FROM entity_inventory
      )
    )`) > 0;
    // Deliberately *not* `dataset_version`. It is a derived value
    // (`cli.ts` sets it to `stableId("dataset", fingerprints)` over
    // `source_xml_sha256` / `source_gpx_bundle_sha256`), and `source_xml_sha256`
    // is the sha256 of the whole `export.xml` — including `<ExportDate>`, the wall
    // clock the exporter stamps on every export. So `dataset_version` moves on
    // every sync of a dataset that did not change by a single row, and comparing
    // it here forced the verdict from `unchanged` onto `data-only`: the worker then
    // still copies the whole database, re-parses, and swaps the main file, which is
    // exactly the work `unchanged` exists to skip.
    //
    // Losing the comparison costs nothing, because every fact it could stand in
    // for is already compared directly and by a field with its own meaning:
    // route changes via `source_gpx_bundle_sha256` below, workout/record/profile
    // changes via their own table diffs, and the row count via `record_count` here.
    const auditManifestChanged = count(`SELECT COUNT(*) AS count FROM (
      SELECT key, value FROM import_manifest WHERE key IN ('record_count')
      EXCEPT
      SELECT key, value FROM previous.import_manifest WHERE key IN ('record_count')
      UNION ALL
      SELECT key, value FROM previous.import_manifest WHERE key IN ('record_count')
      EXCEPT
      SELECT key, value FROM import_manifest WHERE key IN ('record_count')
    )`) > 0;
    const importIssuesChanged = count(`SELECT COUNT(*) AS count FROM (
      SELECT severity, code, object_id, message, occurrence_count FROM (
        SELECT severity, code, object_id, message, COUNT(*) AS occurrence_count
        FROM import_issues GROUP BY severity, code, object_id, message
        EXCEPT
        SELECT severity, code, object_id, message, COUNT(*) AS occurrence_count
        FROM previous.import_issues GROUP BY severity, code, object_id, message
      )
      UNION ALL
      SELECT severity, code, object_id, message, occurrence_count FROM (
        SELECT severity, code, object_id, message, COUNT(*) AS occurrence_count
        FROM previous.import_issues GROUP BY severity, code, object_id, message
        EXCEPT
        SELECT severity, code, object_id, message, COUNT(*) AS occurrence_count
        FROM import_issues GROUP BY severity, code, object_id, message
      )
    )`) > 0;
    const routeFingerprintChanged = count(`SELECT COUNT(*) AS count FROM (
      SELECT key, value FROM (
        SELECT key, value FROM import_manifest WHERE key = 'source_gpx_bundle_sha256'
        EXCEPT
        SELECT key, value FROM previous.import_manifest WHERE key = 'source_gpx_bundle_sha256'
      )
      UNION ALL
      SELECT key, value FROM (
        SELECT key, value FROM previous.import_manifest WHERE key = 'source_gpx_bundle_sha256'
        EXCEPT
        SELECT key, value FROM import_manifest WHERE key = 'source_gpx_bundle_sha256'
      )
    )`) > 0;
    const routeChanges = routeFingerprintChanged ? database.prepare(`
      WITH changed_routes(route_id) AS (
        SELECT current.route_id
        FROM route_file_fingerprints current
        LEFT JOIN previous.route_file_fingerprints old ON old.relative_path = current.relative_path
        WHERE old.relative_path IS NULL OR old.sha256 <> current.sha256 OR old.route_id <> current.route_id
        UNION
        SELECT old.route_id
        FROM previous.route_file_fingerprints old
        LEFT JOIN route_file_fingerprints current ON current.relative_path = old.relative_path
        WHERE current.relative_path IS NULL OR current.sha256 <> old.sha256 OR current.route_id <> old.route_id
      ), route_times(value) AS (
        SELECT workout.start_at FROM changed_routes changed
        JOIN workout_routes route ON route.id = changed.route_id
        JOIN workouts workout ON workout.id = route.workout_id
        UNION ALL
        SELECT workout.start_at FROM changed_routes changed
        JOIN previous.workout_routes route ON route.id = changed.route_id
        JOIN previous.workouts workout ON workout.id = route.workout_id
      )
      SELECT
        (SELECT COUNT(*) FROM changed_routes) AS count,
        (SELECT MIN(value) FROM route_times) AS dirtyFromAt
    `).get() as { count: number; dirtyFromAt: string | null } : { count: 0, dirtyFromAt: null };
    const hasGranularRouteChanges = routeChanges.count > 0;
    const ignoreUngranularPreserveAbsentRoutes =
      Boolean(preserveAbsent) && routeFingerprintChanged && !hasGranularRouteChanges;
    const routeChangeAffectsDirtyRange = routeFingerprintChanged && !ignoreUngranularPreserveAbsentRoutes;
    const routesUpdated = routeChangeAffectsDirtyRange
      ? hasGranularRouteChanges ? Number(routeChanges.count) : count("SELECT COUNT(*) AS count FROM workout_routes")
      : 0;
    const dirty = database.prepare(`SELECT MIN(value) AS dirtyFromAt FROM (
      SELECT current.anchor_start_at AS value FROM training_sessions current
        WHERE NOT EXISTS (SELECT 1 FROM previous.training_sessions old WHERE old.id = current.id)
      UNION ALL
      SELECT old.anchor_start_at FROM previous.training_sessions old
        WHERE NOT EXISTS (SELECT 1 FROM training_sessions current WHERE current.id = old.id)
      UNION ALL
      SELECT current.anchor_start_at FROM training_sessions current
        JOIN previous.training_sessions old ON old.id = current.id
         WHERE ${changedWorkout}
      UNION ALL
      SELECT old.anchor_start_at FROM training_sessions current
        JOIN previous.training_sessions old ON old.id=current.id WHERE ${changedWorkout}
      UNION ALL
      SELECT workout.start_at FROM workouts workout JOIN changed_workout_ids change ON change.id=workout.id
      UNION ALL
      SELECT workout.start_at FROM previous.workouts workout JOIN changed_workout_ids change ON change.id=workout.id
    )`).get() as unknown as { dirtyFromAt: string | null };
    const hasWorkoutChange = insertedWorkouts + updatedWorkouts + removedWorkouts > 0 || count("SELECT COUNT(*) AS count FROM changed_workout_ids") > 0;
    // A deletion can arrive before its entity. Publish the tombstone even if
    // no workout or scoring input changed, and persist authoritative clears.
    const tombstonesChanged = [
      ["import_entity_tombstones", "entity_kind, entity_id, source_identifier"],
      ["import_source_tombstones", "entity_kind, source_identifier"]
    ].some(([table, columns]) => {
      const previousExists = database.prepare(
        "SELECT 1 FROM previous.sqlite_master WHERE type = 'table' AND name = ?"
      ).get(table!) !== undefined;
      if (!previousExists) return count(`SELECT COUNT(*) AS count FROM ${table}`) > 0;
      return count(`SELECT COUNT(*) AS count FROM (
        SELECT * FROM (SELECT ${columns} FROM ${table} EXCEPT SELECT ${columns} FROM previous.${table})
        UNION ALL
        SELECT * FROM (SELECT ${columns} FROM previous.${table} EXCEPT SELECT ${columns} FROM ${table})
      )`) > 0;
    });
    if (!hasWorkoutChange && !routeChangeAffectsDirtyRange && !healthChanged && !profileChanged && !contractChanged) {
      return {
        mode: anyHealthRecordChanged || activitySummaryChanged || inventoryChanged ||
          auditManifestChanged || importIssuesChanged || tombstonesChanged
          ? "data-only"
          : "unchanged",
        dirtyFromAt: null,
        insertedWorkouts,
        updatedWorkouts,
        removedWorkouts,
        unchangedWorkouts,
        routesUpdated
      };
    }
    const granularDirtyFromAt = [dirty.dirtyFromAt, routeChanges.dirtyFromAt, healthPlan?.dirtyFromAt ?? null]
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;
    const dirtyFromAt = routeChangeAffectsDirtyRange && !hasGranularRouteChanges && !dirty.dirtyFromAt
      ? (database.prepare("SELECT MIN(anchor_start_at) AS value FROM training_sessions").get() as { value: string | null }).value
      : granularDirtyFromAt;
    const reasons = [...(healthPlan?.reasons ?? [])];
    if (healthChanged && !useChangeLedger) reasons.push("health_ledger_unavailable");
    if (profileChanged) reasons.push("profile_changed");
    if (contractChanged) reasons.push("parser_contract_changed");
    if (hasWorkoutChange) reasons.push("workout_changed");
    if (routeChangeAffectsDirtyRange) reasons.push("route_changed");
    const validBoundary = dirtyFromAt !== null && Number.isFinite(Date.parse(dirtyFromAt)) && new Date(dirtyFromAt).toISOString() === dirtyFromAt;
    let forceFull = profileChanged || contractChanged || !validBoundary ||
      (healthChanged && (!useChangeLedger || healthPlan.full));
    // With no reusable prefix, partial + shadow only adds a redundant replay.
    if (healthChanged && !forceFull && !database.prepare(`
      SELECT 1 FROM previous.active_model_run active
      JOIN previous.model_runs model ON model.id=active.model_run_id AND model.status='succeeded'
      JOIN previous.workout_features feature ON feature.feature_run_id=model.feature_run_id
      WHERE feature.workout_start_at < ? LIMIT 1
    `).get(dirtyFromAt!)) {
      forceFull = true; reasons.push("no_reusable_health_prefix");
    }
    return {
      mode: forceFull ? "full" : "incremental",
      dirtyFromAt: forceFull ? null : dirtyFromAt,
      insertedWorkouts, updatedWorkouts, removedWorkouts, unchangedWorkouts, routesUpdated,
      recomputeReasons: reasons
    };

  } finally {
    try { database.exec("DETACH DATABASE previous"); } catch { /* Database is closing. */ }
    database.close();
  }
}
