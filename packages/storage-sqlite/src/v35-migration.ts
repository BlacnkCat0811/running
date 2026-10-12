import type { DatabaseSync } from "node:sqlite";

/**
 * 路线版本 + 分析任务绑定 + 大包分片（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §3.2）。
 *
 * 🔴 只新增，不修改任何历史迁移的 `up`。
 *
 * 为什么路线要另开表，而不是复用既有结构：
 *
 * - `import_entity_generations.entity_kind` 带 `CHECK IN ('record','workout','activity_summary')`
 *   （见 `database.ts` v12），加 `'route'` 必须重建表 ⇒ 那是改历史迁移。**不能做。**
 * - `workout_routes.relative_path` 是 `UNIQUE`，同一个 `relative_path` 放不下第二个版本。
 *   所以版本内容全部落在 `route_version_points`，`workout_routes` 继续当**当前发布指针**
 *   （新增 `published_route_version_id`）。未完成（`status <> 'complete'`）的版本对读侧不可见，
 *   旧路线因此在补齐期间保持可用 —— 这是"不发布半条路线"的机械实现。
 *
 * `recompute_jobs` 在主库，所以"事实 + 账目 + 分析任务"可以在**同一个事务**里落库（§4.2）。
 * 这里只加**可空列**，⛔ 不放宽 `job_type` / `status` 的 CHECK —— 放宽会让既有约束静默失效。
 */
export function migrateModelV35(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE route_versions (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES workout_routes(id) ON DELETE CASCADE,
      content_sha256 TEXT NOT NULL,
      point_count INTEGER NOT NULL CHECK (point_count >= 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'rejected')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT,
      UNIQUE (route_id, content_sha256)
    );
    CREATE INDEX idx_route_versions_route_status ON route_versions(route_id, status);

    CREATE TABLE route_version_points (
      route_version_id TEXT NOT NULL REFERENCES route_versions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      timestamp TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      elevation_meters REAL,
      speed_mps REAL,
      course_degrees REAL,
      horizontal_accuracy_meters REAL,
      vertical_accuracy_meters REAL,
      PRIMARY KEY (route_version_id, sequence)
    );

    ALTER TABLE workout_routes ADD COLUMN published_route_version_id TEXT REFERENCES route_versions(id);

    CREATE TABLE import_batch_partitions (
      parent_batch_id TEXT NOT NULL,
      partition_contract TEXT NOT NULL,
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      chunk_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
      receipt_json TEXT,
      PRIMARY KEY (parent_batch_id, partition_contract, chunk_index),
      UNIQUE (parent_batch_id, chunk_hash)
    );

    ALTER TABLE recompute_jobs ADD COLUMN target_raw_generation INTEGER;
    ALTER TABLE recompute_jobs ADD COLUMN target_dependency_generation INTEGER;
    ALTER TABLE recompute_jobs ADD COLUMN expected_incumbent_release_id TEXT;
    ALTER TABLE recompute_jobs ADD COLUMN dirty_json TEXT;
  `);
}
