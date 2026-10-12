import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Stable data/result projections, not job UUIDs or wall-clock audit timestamps. */
export function importEquivalence(path: string): Record<string, { rows: number; sha256: string }> {
  const db = new DatabaseSync(path, { readOnly: true });
  const volatile = ["id", "model_run_id", "feature_run_id", "feature_id", "training_metric_run_id", "zone_profile_id", "last_assessment_id", "computed_at", "created_at"];
  const domains: Record<string, string[]> = {
    profile: [], health_records: [],
    // `deleted_at` 是**墙上时钟**（删除发生的时刻），按本函数的既定口径（"不含作业 UUID 与
    // 墙上时钟审计时间戳"）必须忽略 —— 两个独立进程做同一次删除会得到不同的毫秒值。
    // ⚠️ 忽略它**不会**让"删除"变得不可见：删除同时写 tombstone 与 `import_entity_changes`
    // （两者都在比对范围内），所以等价性判断仍然能看见删除这件事本身。
    workouts: ["deleted_at"],
    workout_statistics: [], workout_events: [], workout_routes: [], route_points: [],
    activity_summaries: [], entity_inventory: [],
    training_sessions: ["created_at", "updated_at"],
    import_entity_generations: ["generation"],
    import_entity_tombstones: ["batch_id", "deleted_at"],
    import_source_tombstones: ["batch_id", "deleted_at"],
    // The change ledger is what the downstream recompute plan reads, so a comparison
    // that omits it cannot see a whole class of divergence. `batch_id` is ignored
    // because it changes on every import by construction.
    import_entity_changes: ["batch_id"],
    // Verified against the live 325 MB database (45 tables): the other uncovered tables
    // are either recompute/model output, user overrides (`workout_overrides`), or batch
    // provenance (`import_batches` / `import_batch_files` / `import_issues`). This one is
    // an import product written by the GPX path (`route_id` is a JS-generated stable id)
    // and pruned by `pruneOrphanRoutes`, so it belongs in the comparison. `imported_at` is
    // wall-clock.
    route_file_fingerprints: ["imported_at"],
    canonical_nights: ["created_at", "updated_at"],
    canonical_hrv_days: ["created_at", "updated_at"],
    active_ability_assessments: volatile, active_daily_ability_snapshots: volatile,
    active_workout_training_loads: volatile, active_daily_training_metrics: volatile,
    active_daily_zone_profiles: volatile, active_workout_zone_summaries: volatile
  };
  try {
    const results: Record<string, { rows: number; sha256: string }> = {};
    for (const [table, ignored] of Object.entries(domains)) {
      const info = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; pk: number }[];
      const columns = info.map((row) => row.name).filter((name) => !ignored.includes(name));
      if (!columns.length) continue;
      const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const select = columns.map(quote).join(",");
      // Order by the table's primary key first, then by the remaining selected columns.
      // The previous code sorted column NAMES alphabetically, which led with a
      // non-unique column for wide tables (`health_records` opened on `created_at`)
      // and left row order undefined whenever those values tied — two engines holding
      // identical data could then hash differently. Leading with the primary key makes
      // the order total. That is the reason for this change.
      //
      // It is a CORRECTNESS fix, NOT a speed-up. Measured on the local 324 MB database
      // (warm cache, 3-round median), the new ORDER BY is ~19% SLOWER overall
      // (5,790 ms -> 6,919 ms): leading with an indexed column makes SQLite choose that
      // index, whose secondary order does not match the full ORDER BY, so the plan
      // becomes index scan + row lookups + sort instead of a plain scan + sort.
      // `route_points` does improve (~-20%), but `import_entity_changes` regresses ~+82%
      // and `import_entity_generations` ~+101%. The domain list also gained two ~83k-row
      // tables, so the tool as a whole is slower than before, not faster.
      // NOTE: this changes every hash, so previously recorded baselines are void.
      const orderBy = [
        ...info.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name),
        ...columns
      ].map(quote).join(",");
      const hash = createHash("sha256");
      let rows = 0;
      for (const row of db.prepare(`SELECT ${select} FROM "${table}" ORDER BY ${orderBy}`).iterate()) {
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
