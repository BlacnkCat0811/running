/**
 * Compatibility re-export. Schema, migrations, and import write APIs live in
 * `@rai/storage-sqlite`. Prefer importing from `@rai/storage-sqlite` directly.
 */
export {
  RaiDatabase,
  SEED_CONTENT_HASH,
  type RaiDatabaseOpenOptions,
  type RouteImportTarget
} from "@rai/storage-sqlite";
