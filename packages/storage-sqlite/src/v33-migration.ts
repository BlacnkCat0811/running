import type { DatabaseSync } from "node:sqlite";

/** UUID-scoped deletion/alias repair must not scan the whole aliases table. */
export function migrateModelV33(database: DatabaseSync): void {
  database.exec(`CREATE INDEX IF NOT EXISTS idx_healthkit_record_aliases_source
    ON healthkit_record_aliases(sample_type, sample_uuid, alias_id)`);
}
