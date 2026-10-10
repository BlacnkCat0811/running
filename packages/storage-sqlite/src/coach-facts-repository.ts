import type { DatabaseSync } from "node:sqlite";

/** Storage owns atomic append/idempotency, while API owns the feedback contract. */
export class SqliteCoachFactsRepository {
  constructor(private readonly database: DatabaseSync) {}

  feedback<T>(scope: string, asOf: string): T[] {
    return (this.database.prepare(`SELECT payload_json FROM coach_feedback_revisions
      WHERE scope = ? AND julianday(available_at) <= julianday(?) ORDER BY id, revision`)
      .all(scope, asOf) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json) as T);
  }

  appendFeedback<T>(scope: string, id: string, expectedRevision: number, availableAt: string, value: T): void {
    const latest = this.database.prepare(`SELECT COALESCE(MAX(revision),0) AS revision
      FROM coach_feedback_revisions WHERE scope = ? AND id = ?`).get(scope, id) as { revision: number };
    if (latest.revision !== expectedRevision) throw new Error("coach_feedback_revision_conflict");
    this.database.prepare("INSERT INTO coach_feedback_revisions VALUES (?,?,?,?,?)")
      .run(scope, id, expectedRevision + 1, availableAt, JSON.stringify(value));
  }

  operation<T>(scope: string, operationId: string, requestHash: string, write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT request_hash,result_json FROM coach_fact_operations WHERE scope=? AND operation_id=?")
        .get(scope, operationId) as { request_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw new Error("coach_feedback_operation_conflict");
        this.database.exec("COMMIT");
        return JSON.parse(existing.result_json) as T;
      }
      const result = write();
      this.database.prepare("INSERT INTO coach_fact_operations VALUES (?,?,?,?)")
        .run(scope, operationId, requestHash, JSON.stringify(result));
      this.database.exec("COMMIT");
      return result;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  publishSummary<T>(scope: string, id: string, identityHash: string, availableAt: string, value: T): void {
    const payload = JSON.stringify(value);
    const old = this.database.prepare("SELECT payload_json FROM coach_prediction_summaries WHERE scope=? AND id=?")
      .get(scope, id) as { payload_json: string } | undefined;
    if (old && old.payload_json !== payload) throw new Error("Immutable coach summary collision");
    if (!old) this.database.prepare("INSERT INTO coach_prediction_summaries VALUES (?,?,?,?,?)")
      .run(scope, id, identityHash, availableAt, payload);
  }

  summary<T>(scope: string, identityHash: string, asOf: string): T | null {
    const row = this.database.prepare(`SELECT payload_json FROM coach_prediction_summaries
      WHERE scope=? AND identity_hash=? AND julianday(available_at)<=julianday(?)
      ORDER BY julianday(available_at) DESC,id DESC LIMIT 1`).get(scope, identityHash, asOf) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as T : null;
  }
}
