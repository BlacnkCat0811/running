import type { DatabaseSync } from "node:sqlite";
import type { TrainingPlanSession } from "@rai/api-contracts";
import { digest } from "./plan-digest.js";
import { isValidLocalDate } from "./local-date.js";
import { parseTrainingPlanSession, sessionId, sessionInstant, sessionRevision, TrainingPlanSessionStateError } from "./training-plan-session-state.js";

export function ensureTrainingPlanSessionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mobile_training_session_history (
      scope TEXT NOT NULL,
      plan_instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_revision INTEGER NOT NULL CHECK (session_revision > 0),
      state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
      local_date TEXT NOT NULL,
      available_at TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      PRIMARY KEY (scope, plan_instance_id, session_id, session_revision),
      CHECK (json_type(payload_json,'$.protection') IS 'text' AND json_extract(payload_json,'$.protection') IN ('automatic','user_protected')),
      CHECK (json_type(payload_json,'$.lifecycle') IS 'text' AND json_extract(payload_json,'$.lifecycle') IN ('pending','completed','partial','skipped','cancelled')),
      CHECK (json_extract(payload_json,'$.planInstanceId') IS plan_instance_id),
      CHECK (json_extract(payload_json,'$.sessionId') IS session_id),
      CHECK (json_extract(payload_json,'$.sessionRevision') IS session_revision),
      CHECK (json_extract(payload_json,'$.prescription.localDate') IS local_date),
      CHECK (json_extract(payload_json,'$.availableAt') IS available_at),
      CHECK (length(available_at)=24 AND substr(available_at,24,1)='Z')
    );
    CREATE INDEX IF NOT EXISTS idx_training_session_history_date
      ON mobile_training_session_history(scope, local_date, available_at, session_id, session_revision);
    CREATE INDEX IF NOT EXISTS idx_training_session_history_time
      ON mobile_training_session_history(scope, plan_instance_id, session_id, available_at, session_revision);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_training_session_history_identity
      ON mobile_training_session_history(scope, session_id, session_revision);
  `);
}

export interface TrainingPlanSessionHistoryRow {
  scope: string;
  stateRevision: number;
  session: TrainingPlanSession;
}

interface RawHistory {
  scope: string; plan_instance_id: string; session_id: string; session_revision: number;
  state_revision: number; local_date: string; available_at: string; payload_json: string;
}
function decode(row: RawHistory | undefined): TrainingPlanSessionHistoryRow | null {
  if (!row) return null;
  const session = parseTrainingPlanSession(JSON.parse(row.payload_json));
  if (session.planInstanceId !== row.plan_instance_id || session.sessionId !== row.session_id ||
      session.sessionRevision !== row.session_revision || session.prescription.localDate !== row.local_date || session.availableAt !== row.available_at) {
    throw new TrainingPlanSessionStateError("session history columns/payload mismatch");
  }
  return { scope: row.scope, stateRevision: row.state_revision, session };
}

/** Direct indexed frozen-prescription reads; never traverses recent whole-plan snapshots. */
export class TrainingPlanSessionRepository {
  constructor(private readonly database: DatabaseSync) {}

  append(scope: string, stateRevision: number, value: TrainingPlanSession): void {
    if (!this.database.isTransaction) throw new TrainingPlanSessionStateError("session history requires publication transaction");
    const session = parseTrainingPlanSession(value);
    if (!Number.isSafeInteger(stateRevision) || stateRevision < 0) throw new TrainingPlanSessionStateError("invalid stateRevision");
    const previous = this.get(scope, session.planInstanceId, session.sessionId, session.sessionRevision);
    if (previous) {
      if (digest(previous.session) !== digest(session)) throw new TrainingPlanSessionStateError("immutable session revision collision");
      return;
    }
    const latest = this.database.prepare(`SELECT * FROM mobile_training_session_history
      WHERE scope=? AND plan_instance_id=? AND session_id=? ORDER BY session_revision DESC LIMIT 1`)
      .get(scope, session.planInstanceId, session.sessionId) as unknown as RawHistory | undefined;
    if (session.sessionRevision !== (latest?.session_revision ?? 0) + 1 ||
        latest && Date.parse(session.availableAt) < Date.parse(latest.available_at)) {
      throw new TrainingPlanSessionStateError("session revision/availability must advance monotonically");
    }
    this.database.prepare(`INSERT INTO mobile_training_session_history
      (scope,plan_instance_id,session_id,session_revision,state_revision,local_date,available_at,payload_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(scope, session.planInstanceId, session.sessionId, session.sessionRevision,
        stateRevision, session.prescription.localDate, session.availableAt, JSON.stringify(session));
  }

  get(scope: string, instance: string, id: string, revision: number): TrainingPlanSessionHistoryRow | null {
    sessionId(instance, "planInstanceId"); sessionId(id, "sessionId"); sessionRevision(revision, "sessionRevision");
    return decode(this.database.prepare(`SELECT * FROM mobile_training_session_history
      WHERE scope=? AND plan_instance_id=? AND session_id=? AND session_revision=?`)
      .get(scope, instance, id, revision) as unknown as RawHistory | undefined);
  }

  effectiveAt(scope: string, instance: string, id: string, at: string): TrainingPlanSessionHistoryRow | null {
    sessionId(instance, "planInstanceId"); sessionId(id, "sessionId"); sessionInstant(at, "asOf");
    return decode(this.database.prepare(`SELECT * FROM mobile_training_session_history
      WHERE scope=? AND plan_instance_id=? AND session_id=? AND available_at<=?
      ORDER BY available_at DESC,session_revision DESC LIMIT 1`)
      .get(scope, instance, id, at) as unknown as RawHistory | undefined);
  }

  forDate(scope: string, date: string, asOf: string, options: { limit?: number; after?: { availableAt: string; sessionId: string; sessionRevision: number } } = {}): TrainingPlanSessionHistoryRow[] {
    if (!isValidLocalDate(date)) throw new TrainingPlanSessionStateError("invalid history date");
    sessionInstant(asOf, "asOf");
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TrainingPlanSessionStateError("history limit must be 1..200");
    const cursor = options.after;
    if (cursor) { sessionInstant(cursor.availableAt, "cursor"); sessionId(cursor.sessionId, "cursor"); sessionRevision(cursor.sessionRevision, "cursor"); }
    const rows = this.database.prepare(`SELECT * FROM mobile_training_session_history
      WHERE scope=? AND local_date=? AND available_at<=?
      ${cursor ? "AND (available_at,session_id,session_revision)>(?,?,?)" : ""}
      ORDER BY available_at,session_id,session_revision LIMIT ?`)
      .all(scope, date, asOf, ...(cursor ? [cursor.availableAt, cursor.sessionId, cursor.sessionRevision] : []), limit) as unknown as RawHistory[];
    return rows.map(row => decode(row)!);
  }
}
