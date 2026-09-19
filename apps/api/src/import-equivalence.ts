import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Stable data/result projections, not job UUIDs or wall-clock audit timestamps. */
export function importEquivalence(path: string): Record<string, { rows: number; sha256: string }> {
  const db = new DatabaseSync(path, { readOnly: true });
  const volatile = ["id", "model_run_id", "feature_run_id", "feature_id", "training_metric_run_id", "zone_profile_id", "last_assessment_id", "computed_at", "created_at"];
  const domains: Record<string, string[]> = {
    profile: [], health_records: [], workouts: [], workout_statistics: [], workout_events: [], workout_routes: [], route_points: [],
    activity_summaries: [], entity_inventory: [],
    training_sessions: ["created_at", "updated_at"],
    import_entity_generations: ["generation"],
    import_entity_tombstones: ["batch_id", "deleted_at"],
    import_source_tombstones: ["batch_id", "deleted_at"],
    canonical_nights: ["created_at", "updated_at"],
    canonical_hrv_days: ["created_at", "updated_at"],
    active_ability_assessments: volatile, active_daily_ability_snapshots: volatile,
    active_workout_training_loads: volatile, active_daily_training_metrics: volatile,
    active_daily_zone_profiles: volatile, active_workout_zone_summaries: volatile
  };
  try {
    const results: Record<string, { rows: number; sha256: string }> = {};
    for (const [table, ignored] of Object.entries(domains)) {
      const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
        .map((row) => row.name).filter((name) => !ignored.includes(name)).sort();
      if (!columns.length) continue;
      const select = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(",");
      const hash = createHash("sha256");
      let rows = 0;
      for (const row of db.prepare(`SELECT ${select} FROM "${table}" ORDER BY ${select}`).iterate()) {
        hash.update(JSON.stringify(row)); hash.update("\n"); rows++;
      }
      results[table] = { rows, sha256: hash.digest("hex") };
    }
    const manifestHash = createHash("sha256");
    let manifestRows = 0;
    for (const row of db.prepare(`SELECT key,value FROM import_manifest
      WHERE key IN ('parser_contract_version','source_xml_sha256','source_gpx_bundle_sha256','dataset_version')
      ORDER BY key`).iterate()) {
      manifestHash.update(JSON.stringify(row)); manifestHash.update("\n"); manifestRows++;
    }
    results.manifest = { rows: manifestRows, sha256: manifestHash.digest("hex") };
    return results;
  } finally { db.close(); }
}
