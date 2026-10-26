import type { DatabaseSync } from "node:sqlite";
import type { TrainingPlanSessionExecution } from "@rai/api-contracts";
import { digest } from "./plan-digest.js";
import {
  parseTrainingPlanSessionExecution, sessionId, sessionInstant, sessionRevision,
  TrainingPlanSessionStateError
} from "./training-plan-session-state.js";

/**
 * B06 control-store schema: the current link plus an append-only revision log.
 *
 * The unique indices are the machine-checkable half of two product invariants:
 * one actual run may confirm at most one session (partial unique on
 * `training_session_id` where confirmed), and one session has exactly one
 * current execution row. The other half — at most one effective session per
 * local date — stays in the resolver/CAS transaction (plan §3.1 item 3).
 */
export function ensureTrainingPlanExecutionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mobile_training_execution (
      scope TEXT NOT NULL,
      plan_instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      execution_revision INTEGER NOT NULL CHECK (execution_revision > 0),
      association_status TEXT NOT NULL CHECK (association_status IN ('unlinked','pending_confirmation','confirmed','invalidated')),
      training_session_id TEXT,
      prescription_session_revision INTEGER NOT NULL CHECK (prescription_session_revision > 0),
      source_fact_digest TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      available_at TEXT NOT NULL,
      PRIMARY KEY (scope, session_id),
      CHECK (json_extract(payload_json,'$.sessionId') IS session_id),
      CHECK (json_extract(payload_json,'$.executionRevision') IS execution_revision),
      CHECK (json_extract(payload_json,'$.association') IS association_status),
      CHECK (json_extract(payload_json,'$.availableAt') IS available_at),
      CHECK (association_status <> 'confirmed' OR (training_session_id IS NOT NULL AND source_fact_digest IS NOT NULL)),
      CHECK (association_status <> 'unlinked' OR (training_session_id IS NULL AND source_fact_digest IS NULL)),
      CHECK (length(available_at) = 24 AND substr(available_at,24,1) = 'Z')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_training_execution_confirmed_run
      ON mobile_training_execution(scope, training_session_id)
      WHERE association_status = 'confirmed' AND training_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_training_execution_instance
      ON mobile_training_execution(scope, plan_instance_id, session_id);

    CREATE TABLE IF NOT EXISTS mobile_training_execution_history (
      scope TEXT NOT NULL,
      session_id TEXT NOT NULL,
      execution_revision INTEGER NOT NULL CHECK (execution_revision > 0),
      reason TEXT NOT NULL,
      available_at TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      PRIMARY KEY (scope, session_id, execution_revision),
      CHECK (json_extract(payload_json,'$.sessionId') IS session_id),
      CHECK (json_extract(payload_json,'$.executionRevision') IS execution_revision),
      CHECK (length(available_at) = 24 AND substr(available_at,24,1) = 'Z')
    );
    CREATE INDEX IF NOT EXISTS idx_training_execution_history_time
      ON mobile_training_execution_history(scope, available_at, session_id, execution_revision);
  `);
}

export interface TrainingPlanExecutionRow {
  scope: string;
  planInstanceId: string;
  trainingSessionId: string | null;
  execution: TrainingPlanSessionExecution;
}

interface RawExecution {
  scope: string; plan_instance_id: string; session_id: string; execution_revision: number;
  association_status: string; training_session_id: string | null; prescription_session_revision: number;
  source_fact_digest: string | null; payload_json: string; available_at: string;
}

function decode(row: RawExecution | undefined): TrainingPlanExecutionRow | null {
  if (!row) return null;
  const execution = parseTrainingPlanSessionExecution(JSON.parse(row.payload_json));
  if (execution.sessionId !== row.session_id || execution.executionRevision !== row.execution_revision ||
      execution.association !== row.association_status || execution.trainingSessionId !== row.training_session_id ||
      execution.prescriptionSessionRevision !== row.prescription_session_revision ||
      execution.sourceFactDigest !== row.source_fact_digest || execution.availableAt !== row.available_at) {
    throw new TrainingPlanSessionStateError("execution columns/payload mismatch");
  }
  return { scope: row.scope, planInstanceId: row.plan_instance_id,
    trainingSessionId: row.training_session_id, execution };
}

/**
 * Append-only execution store. `append` must run inside the caller's publication
 * transaction so the course revision, frozen history, operation result and this
 * link either all commit or all roll back.
 */
export class TrainingPlanExecutionRepository {
  constructor(private readonly database: DatabaseSync) {}

  current(scope: string, sessionIdValue: string): TrainingPlanExecutionRow | null {
    sessionId(sessionIdValue, "sessionId");
    return decode(this.database.prepare(
      "SELECT * FROM mobile_training_execution WHERE scope=? AND session_id=?").get(scope, sessionIdValue) as unknown as RawExecution | undefined);
  }

  list(scope: string, instance?: string): TrainingPlanExecutionRow[] {
    const rows = instance === undefined
      ? this.database.prepare("SELECT * FROM mobile_training_execution WHERE scope=? ORDER BY session_id").all(scope)
      : this.database.prepare("SELECT * FROM mobile_training_execution WHERE scope=? AND plan_instance_id=? ORDER BY session_id")
        .all(scope, sessionId(instance, "planInstanceId"));
    return (rows as unknown as RawExecution[]).map(row => decode(row)!);
  }

  /** The session that currently claims this actual run, if any. */
  confirmedByTrainingSession(scope: string, trainingSessionIdValue: string): TrainingPlanExecutionRow | null {
    sessionId(trainingSessionIdValue, "trainingSessionId");
    return decode(this.database.prepare(`SELECT * FROM mobile_training_execution
      WHERE scope=? AND training_session_id=? AND association_status='confirmed'`)
      .get(scope, trainingSessionIdValue) as unknown as RawExecution | undefined);
  }

  history(scope: string, sessionIdValue: string): Array<{ reason: string; execution: TrainingPlanSessionExecution }> {
    sessionId(sessionIdValue, "sessionId");
    const rows = this.database.prepare(`SELECT reason,payload_json FROM mobile_training_execution_history
      WHERE scope=? AND session_id=? ORDER BY execution_revision`).all(scope, sessionIdValue) as
      unknown as Array<{ reason: string; payload_json: string }>;
    return rows.map(row => ({ reason: row.reason, execution: parseTrainingPlanSessionExecution(JSON.parse(row.payload_json)) }));
  }

  /**
   * Append the next immutable execution revision and replace the current row.
   *
   * Revisions start at 1 and advance monotonically; availability may not move
   * backwards. A confirmed link is protected by the partial unique index, so a
   * second session claiming the same run fails here — inside the transaction —
   * instead of silently overwriting either course.
   */
  append(scope: string, planInstanceId: string, value: TrainingPlanSessionExecution, reason: string): void {
    if (!this.database.isTransaction) throw new TrainingPlanSessionStateError("execution rows require the publication transaction");
    const execution = parseTrainingPlanSessionExecution(value);
    sessionId(planInstanceId, "planInstanceId");
    if (typeof reason !== "string" || !reason.trim() || reason.length > 200) {
      throw new TrainingPlanSessionStateError("execution history requires a bounded reason");
    }
    const previous = this.current(scope, execution.sessionId);
    if (previous === null) {
      if (execution.executionRevision !== 1) throw new TrainingPlanSessionStateError("the first execution revision must be 1");
    } else {
      if (previous.execution.executionRevision + 1 !== execution.executionRevision) {
        throw new TrainingPlanSessionStateError("execution revision must advance by exactly one");
      }
      if (Date.parse(execution.availableAt) < Date.parse(previous.execution.availableAt)) {
        throw new TrainingPlanSessionStateError("execution availability cannot move backwards");
      }
    }
    this.database.prepare(`INSERT INTO mobile_training_execution_history
      (scope,session_id,execution_revision,reason,available_at,payload_json) VALUES (?,?,?,?,?,?)`)
      .run(scope, execution.sessionId, execution.executionRevision, reason, execution.availableAt, JSON.stringify(execution));
    this.database.prepare(`INSERT INTO mobile_training_execution
      (scope,plan_instance_id,session_id,execution_revision,association_status,training_session_id,
       prescription_session_revision,source_fact_digest,payload_json,available_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(scope,session_id) DO UPDATE SET
        plan_instance_id=excluded.plan_instance_id,
        execution_revision=excluded.execution_revision,
        association_status=excluded.association_status,
        training_session_id=excluded.training_session_id,
        prescription_session_revision=excluded.prescription_session_revision,
        source_fact_digest=excluded.source_fact_digest,
        payload_json=excluded.payload_json,
        available_at=excluded.available_at`)
      .run(scope, planInstanceId, execution.sessionId, execution.executionRevision, execution.association,
        execution.trainingSessionId, execution.prescriptionSessionRevision, execution.sourceFactDigest,
        JSON.stringify(execution), execution.availableAt);
  }

  /** Digest of the current row, used by the update view without re-deriving it. */
  static digestOf(rows: readonly TrainingPlanSessionExecution[]): string {
    return digest(rows.map(row => ({ sessionId: row.sessionId, executionRevision: row.executionRevision,
      association: row.association, trainingSessionId: row.trainingSessionId, sourceFactDigest: row.sourceFactDigest })));
  }
}

/** Re-exported for callers that only need revision validation. */
export { sessionRevision as executionRevisionOf, sessionInstant as executionInstantOf };
