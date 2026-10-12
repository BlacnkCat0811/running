import type { DatabaseSync } from "node:sqlite";

/**
 * 稀疏历史 + 版本计数器（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §3.1）。
 *
 * 🔴 只新增，不修改任何历史迁移的 `up`。
 *
 * 三条刻意的选择，改动前必须先读：
 *
 * 1. **代次是 INTEGER 单调计数器，不是批次 token。**
 *    `import_entity_generations.generation` 存的是 `delta:<jobId>` 这类**批次 token**，
 *    语义是"这行由哪一批产生"。本表存的是**单调递增的版本号**，语义是"这行自哪个版本起有效"，
 *    要被 `valid_from_generation <= G` 这种**比较**使用。若沿用 TEXT，比较会退化成字典序 ——
 *    `'10' < '9'`，静默给出错误的版本视图。用 INTEGER 让这个陷阱**不存在**。
 *    对外（§10.1 回执）仍以十进制字符串呈现：`String(n)`。
 *
 * 2. **不给 `healthkit_record_facts` 加历史列。** 它有 `UNIQUE(sample_type, sample_uuid)`
 *    （见 `v31-migration.ts`），加历史行会撞唯一约束；改唯一约束 = 重建表 = 动历史迁移。
 *    恢复职责由 `import_fact_history.payload_json` 承担，两张表并存不冲突。
 *
 * 3. **`import_fact_history` 的 CHECK 只放 `record` / `workout`。**
 *    `import_entity_generations.entity_kind` 有 `CHECK IN ('record','workout','activity_summary')`，
 *    往那里加 `'route'` 必须重建表。路线版本走 v35 的独立表，所以这里也不放 `route`。
 */
export function migrateModelV34(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE import_fact_history (
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('record', 'workout')),
      entity_id TEXT NOT NULL,
      valid_from_generation INTEGER NOT NULL CHECK (valid_from_generation >= 0),
      valid_to_generation INTEGER CHECK (valid_to_generation IS NULL OR valid_to_generation > valid_from_generation),
      content_hash TEXT NOT NULL,
      effective_at TEXT,
      available_at TEXT,
      payload_json TEXT NOT NULL,
      superseded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (entity_kind, entity_id, valid_from_generation)
    );
    CREATE INDEX idx_import_fact_history_valid_to
      ON import_fact_history(entity_kind, entity_id, valid_to_generation);

    CREATE TABLE import_generations (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      raw_generation INTEGER NOT NULL CHECK (raw_generation >= 0),
      dependency_generation INTEGER NOT NULL CHECK (dependency_generation >= 0),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO import_generations (singleton, raw_generation, dependency_generation)
      VALUES (1, 0, 0);

    ALTER TABLE health_records ADD COLUMN valid_from_generation INTEGER;
    ALTER TABLE workouts ADD COLUMN valid_from_generation INTEGER;
  `);
}
