import type { DatabaseSync } from "node:sqlite";

/** Add source identity without rewriting canonical health record IDs. Retain
 * mappings after deletion so late archives and corrections remain resolvable. */
export function migrateModelV30(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE import_source_tombstones_v30 (
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('workout', 'record')),
      source_identifier TEXT NOT NULL,
      batch_id TEXT,
      deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (entity_kind, source_identifier)
    );
    INSERT INTO import_source_tombstones_v30 SELECT * FROM import_source_tombstones;
    DROP TABLE import_source_tombstones;
    ALTER TABLE import_source_tombstones_v30 RENAME TO import_source_tombstones;
    CREATE TABLE healthkit_record_sources (
      sample_type TEXT NOT NULL,
      sample_uuid TEXT NOT NULL,
      record_id TEXT NOT NULL,
      PRIMARY KEY (sample_type, sample_uuid)
    );
    CREATE INDEX idx_healthkit_record_sources_record
      ON healthkit_record_sources(record_id);
  `);
}
