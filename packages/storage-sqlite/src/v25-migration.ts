import type { DatabaseSync } from "node:sqlite";

/** Self-contained review evidence survives pruning of the run it inspected. */
export function migrateModelV25(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE baseline_rebase_reviews (
      epoch_id TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      model_run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      saturated_reviews INTEGER NOT NULL CHECK(saturated_reviews>=0),
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      PRIMARY KEY(epoch_id,policy_hash,reviewed_at)
    );
    CREATE TRIGGER immutable_baseline_rebase_review
      BEFORE UPDATE ON baseline_rebase_reviews
      BEGIN SELECT RAISE(ABORT,'baseline reviews are immutable'); END;
  `);
}
