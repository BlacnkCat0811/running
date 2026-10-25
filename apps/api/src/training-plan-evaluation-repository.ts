import type { DatabaseSync } from "node:sqlite";
import { digest } from "./plan-digest.js";
import { isValidLocalDate } from "./local-date.js";

/**
 * B08 evaluation cursor: "the newest input this scope has already checked".
 *
 * This is a cursor, not a task queue and not a second plan owner. It exists so a
 * no-change evaluation is not repeated every tick after a restart; the content
 * authority remains `mobile_training_state`. One row per scope.
 */
export function ensureTrainingPlanEvaluationSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mobile_training_plan_evaluation (
      scope TEXT PRIMARY KEY,
      input_key TEXT NOT NULL,
      state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
      business_date TEXT NOT NULL,
      policy_hash TEXT,
      execution_digest TEXT NOT NULL,
      operation_id TEXT,
      evaluated_at TEXT NOT NULL,
      CHECK (length(input_key) > 0),
      CHECK (length(execution_digest) = 64)
    );
  `);
}

export interface TrainingPlanEvaluation {
  inputKey: string;
  stateRevision: number;
  businessDate: string;
  policyHash: string | null;
  executionDigest: string;
  operationId: string | null;
  evaluatedAt: string;
}

interface RawEvaluation {
  scope: string; input_key: string; state_revision: number; business_date: string;
  policy_hash: string | null; execution_digest: string; operation_id: string | null; evaluated_at: string;
}

function decode(row: RawEvaluation | undefined): TrainingPlanEvaluation | null {
  if (!row) return null;
  return { inputKey: row.input_key, stateRevision: row.state_revision, businessDate: row.business_date,
    policyHash: row.policy_hash, executionDigest: row.execution_digest, operationId: row.operation_id,
    evaluatedAt: row.evaluated_at };
}

export class TrainingPlanEvaluationRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(scope: string): TrainingPlanEvaluation | null {
    const row = this.database.prepare("SELECT * FROM mobile_training_plan_evaluation WHERE scope=?").get(scope) as unknown as RawEvaluation | undefined;
    return decode(row);
  }

  /** Must join the caller's publication transaction: result and cursor share one COMMIT. */
  record(scope: string, value: TrainingPlanEvaluation): void {
    if (!this.database.isTransaction) throw new Error("evaluation cursor requires the publication transaction");
    if (!value.inputKey.trim()) throw new Error("evaluation input key must be non-empty");
    if (!Number.isSafeInteger(value.stateRevision) || value.stateRevision < 0) throw new Error("invalid evaluation state revision");
    if (!isValidLocalDate(value.businessDate)) throw new Error("invalid evaluation business date");
    if (!/^[a-f0-9]{64}$/i.test(value.executionDigest)) throw new Error("invalid execution digest");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.evaluatedAt) ||
        !Number.isFinite(Date.parse(value.evaluatedAt))) throw new Error("invalid evaluation instant");
    this.database.prepare(`INSERT INTO mobile_training_plan_evaluation
      (scope,input_key,state_revision,business_date,policy_hash,execution_digest,operation_id,evaluated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET
        input_key=excluded.input_key, state_revision=excluded.state_revision,
        business_date=excluded.business_date, policy_hash=excluded.policy_hash,
        execution_digest=excluded.execution_digest, operation_id=excluded.operation_id,
        evaluated_at=excluded.evaluated_at`)
      .run(scope, value.inputKey, value.stateRevision, value.businessDate, value.policyHash,
        value.executionDigest.toLowerCase(), value.operationId, value.evaluatedAt);
  }

  static digestOf(value: TrainingPlanEvaluation | null): string {
    return digest(value === null ? null : { inputKey: value.inputKey, stateRevision: value.stateRevision,
      businessDate: value.businessDate, policyHash: value.policyHash, executionDigest: value.executionDigest });
  }
}
