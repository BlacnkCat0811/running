import type { DatabaseSync } from "node:sqlite";

/** Append-only coach facts/companion artifacts. Never modifies sealed model bundles. */
export function migrateModelV32(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE coach_feedback_revisions (
      scope TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      available_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(scope, id, revision)
    );
    CREATE INDEX idx_coach_feedback_available ON coach_feedback_revisions(scope, available_at);
    CREATE TABLE coach_fact_operations (
      scope TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, PRIMARY KEY(scope, operation_id)
    );
    CREATE TABLE coach_prediction_summaries (
      scope TEXT NOT NULL, id TEXT NOT NULL, identity_hash TEXT NOT NULL,
      available_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(scope, id)
    );
    CREATE INDEX idx_coach_prediction_identity ON coach_prediction_summaries(scope, identity_hash, available_at);
  `);
}
