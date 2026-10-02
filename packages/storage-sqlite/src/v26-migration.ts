import type { DatabaseSync } from "node:sqlite";

/**
 * Privacy zones for shared route cards (docs/WEB.md, docs/DECISIONS.md D9).
 *
 * These live in the **main** database, not the control database, because the
 * backup and restore path only covers the main database
 * (`DatabaseMaintenance(databasePath, runtimeRoot)` in `apps/api/src/server.ts`).
 * A privacy zone that survives everything except a restore is a privacy zone that
 * silently disappears exactly when the user is rebuilding from a backup — and the
 * next card they share is unredacted.
 *
 * Coordinates are stored in WGS-84, the same convention as `route_points`; the
 * GCJ-02 conversion stays a display-only concern in the iOS map layer.
 */
export function migrateModelV26(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE privacy_zones (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      center_latitude REAL NOT NULL CHECK(center_latitude BETWEEN -90 AND 90),
      center_longitude REAL NOT NULL CHECK(center_longitude BETWEEN -180 AND 180),
      radius_meters REAL NOT NULL CHECK(radius_meters > 0 AND radius_meters <= 5000),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE privacy_zone_revisions (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      updated_at TEXT NOT NULL
    );

    INSERT INTO privacy_zone_revisions (singleton, revision, updated_at)
      VALUES (1, 0, '1970-01-01T00:00:00.000Z');
  `);
}
