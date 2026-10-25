import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TrainingPlanSession, TrainingPlanSuppression } from "@rai/api-contracts";
import { digest } from "./plan-digest.js";
import { ensureTrainingPlanSessionSchema, TrainingPlanSessionRepository } from "./training-plan-session-repository.js";
import { parseSessionPrescription, sessionRecord } from "./training-plan-session-state.js";
import { parseTrainingPlanState, parseTrainingPlanScopeKey, readTrainingPlanMigrationSources, TrainingPlanStore,
  TrainingPlanStateError, type TrainingPlanSessionState, type TrainingPlanStateRow } from "./training-plan-store.js";

export class TrainingPlanSessionMigrationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const refuse = (code: string, message: string): never => { throw new TrainingPlanSessionMigrationError(code, message); };
interface Snapshot { revision: number; payload_json: string; changed_at: string }
interface Mapping { sourceRevision: number; localDate: string; planInstanceId: string; sessionId: string; sessionRevision: number }
export interface SessionIdentityMigrationReport {
  status: "ready" | "replayed";
  scope: string;
  sourceDigest: string;
  existingRevision: number;
  historySnapshots: number;
  historicalSessions: number;
  currentSessions: number;
  planInstanceId: string | null;
  notes: string[];
}

const NOTES = [
  "No per-session ownership evidence exists in schema 1: every migrated running session is user_protected; rest intent is protected explicitly.",
  "Each historical source revision gets its own identity mapping; equal date/content does not prove identity continuity.",
  "Unscoped mobile_goals_history is preserved byte-for-byte, not attributed to a dataset epoch by guesswork. Only this scope's complete unified history is backfilled.",
  "No IDs are allocated by dry-run; no new read/write capability is enabled. B03 protection/resolver acceptance remains required."
];

function snapshots(database: DatabaseSync, scope: string): Snapshot[] {
  return database.prepare(`SELECT revision,payload_json,changed_at FROM mobile_training_state_history
    WHERE scope=? ORDER BY revision`).all(scope) as unknown as Snapshot[];
}
function rawDays(snapshot: Snapshot) {
  const raw: unknown = JSON.parse(snapshot.payload_json);
  const state = parseTrainingPlanState(raw);
  if (state.schemaVersion !== 1 || !sessionRecord(raw) || !Array.isArray(raw.weekPlan)) {
    return refuse("session_migration_invalid_history", "Identity migration requires complete schema 1 source snapshots.");
  }
  const days = raw.weekPlan.map(day => parseSessionPrescription(day));
  if (new Set(days.map(day => day.localDate)).size !== days.length) refuse("session_migration_invalid_history", "Duplicate source dates; no source may be silently dropped.");
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Number.isFinite(Date.parse(snapshot.changed_at))) {
    refuse("session_migration_invalid_history", "Invalid historical revision/availability.");
  }
  return days;
}

function checkLedger(database: DatabaseSync): number {
  const row = database.prepare("SELECT MAX(version) AS version FROM mobile_control_schema").get() as { version: number | null };
  // The identity migration only needs the B02/B03 tables. Every later append-only
  // control-schema version (currently up to B08's evaluation cursor) is compatible;
  // version 0/1 predates the tables and must still fail closed.
  if (row.version === null || row.version < 2 || row.version > 5) {
    return refuse("session_migration_schema_unsupported", "Install the compatible control-schema 2–5 reader before identity migration.");
  }
  return row.version;
}

function inspect(database: DatabaseSync, scope: string): { report: SessionIdentityMigrationReport; current: TrainingPlanStateRow; history: Snapshot[] } {
  checkLedger(database);
  const identity = parseTrainingPlanScopeKey(scope);
  const sources = readTrainingPlanMigrationSources(database, identity);
  const current = sources.existingState;
  if (!current) return refuse("training_plan_not_migrated", "Migrate to unified schema 1 before session identity migration.");
  if (current.state.schemaVersion === 2) {
    const audit = database.prepare(`SELECT source_digest,result_digest,payload_json FROM mobile_training_migration_audit
      WHERE scope=? AND migration_version=2`).get(scope) as { source_digest: string; result_digest: string; payload_json: string } | undefined;
    if (!audit) return refuse("session_migration_audit_invalid", "Session state exists without its controlled migration audit.");
    const raw: unknown = JSON.parse(audit.payload_json);
    if (!sessionRecord(raw) || !Array.isArray(raw.identityMappings) || typeof raw.historySnapshots !== "number" ||
        raw.mappingVersion !== 1 || raw.mappingDigest !== digest(raw.identityMappings)) {
      return refuse("session_migration_audit_invalid", "Identity mapping audit is incomplete.");
    }
    const state = parseTrainingPlanState(raw.state);
    if (state.schemaVersion !== 2 || digest(state) !== audit.result_digest || state.sourceDigest !== audit.source_digest) {
      return refuse("session_migration_audit_invalid", "Identity audit digest mismatch.");
    }
    const repo = new TrainingPlanSessionRepository(database);
    for (const value of raw.identityMappings) {
      if (!sessionRecord(value) || typeof value.planInstanceId !== "string" || typeof value.sessionId !== "string" || typeof value.sessionRevision !== "number" ||
          !repo.get(scope, value.planInstanceId, value.sessionId, value.sessionRevision)) {
        return refuse("session_migration_audit_invalid", "A frozen identity mapping has no history row.");
      }
    }
    return { current, history: [], report: { status: "replayed", scope, sourceDigest: audit.source_digest,
      existingRevision: current.revision, historySnapshots: raw.historySnapshots, historicalSessions: raw.identityMappings.length,
      currentSessions: state.sessions.length, planInstanceId: state.planInstanceId, notes: NOTES } };
  }
  const originalAudit = database.prepare(`SELECT migration_version,source_digest,result_digest,payload_json
    FROM mobile_training_migration_audit WHERE scope=? ORDER BY migration_version DESC LIMIT 1`)
    .get(scope) as { migration_version: number; source_digest: string; result_digest: string; payload_json: string } | undefined;
  if (current.state.migrationVersion !== 1 || originalAudit?.migration_version !== 1 || originalAudit.source_digest !== current.state.sourceDigest) {
    refuse("session_migration_audit_invalid", "Expected the intact version 1 source audit; identity migration will not guess an occupied migration version.");
  }
  if (!sources.goals || sources.goals.revision !== current.state.goalsRevision) refuse("session_migration_owner_invalid", "Unified/goals revisions disagree; repair ownership before migration.");
  if ((sources.coachLoopReceipt?.operationId ?? null) !== (current.state.coachLoop?.operationId ?? null)) {
    refuse("session_migration_owner_invalid", "Unified/receipt ownership disagrees.");
  }
  const goals = sources.goals!.payload;
  if (!sessionRecord(goals) || !Array.isArray(goals.weekPlan)) refuse("session_migration_owner_invalid", "Goals projection has no readable plan.");
  const normalizedGoals = parseTrainingPlanState({ ...current.state, weekPlan: (goals as Record<string, unknown>).weekPlan });
  // Ended loop's compatibility all-rest window is not a second live intention.
  if (digest(normalizedGoals.weekPlan) !== digest(current.state.weekPlan) &&
      !(current.state.sourceStatus === "ended" && current.state.weekPlan.length === 0 && normalizedGoals.weekPlan.every(day => day.kind === "rest"))) {
    refuse("session_migration_owner_invalid", "Unified/goals plan content disagrees.");
  }
  const history = snapshots(database, scope);
  const latest = history.find(row => row.revision === current.revision);
  if (!latest || digest(parseTrainingPlanState(JSON.parse(latest.payload_json))) !== digest(current.state)) {
    refuse("session_migration_invalid_history", "Current state has no matching source history revision.");
  }
  let count = 0;
  for (const snapshot of history) count += rawDays(snapshot).filter(day => day.kind !== "rest").length;
  return { current, history, report: { status: "ready", scope,
    sourceDigest: digest({ contract: "rai-training-session-identity-migration-v1", scope,
      current, history, goals: sources.goals, receipt: sources.coachLoopReceipt, originalAudit }),
    existingRevision: current.revision, historySnapshots: history.length, historicalSessions: count,
    currentSessions: rawDays(latest!).filter(day => day.kind !== "rest").length, planInstanceId: null, notes: NOTES } };
}

/** Read snapshot only. Even validation of all source history allocates no identity. */
export function inspectSessionIdentityMigration(database: DatabaseSync, scope: string): SessionIdentityMigrationReport {
  const owns = !database.isTransaction;
  if (owns) database.exec("BEGIN");
  try { const report = inspect(database, scope).report; if (owns) database.exec("COMMIT"); return report; }
  catch (error) { if (owns) { try { database.exec("ROLLBACK"); } catch {} } throw error; }
}

/** Caller holds the existing control publication lock; all new rows and DDL join one transaction. */
export function applySessionIdentityMigration(database: DatabaseSync, scope: string, expectedDigest: string, expectedRevision: number) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const { report, current, history } = inspect(database, scope);
    if (report.sourceDigest !== expectedDigest) refuse("source_digest_mismatch", "Identity migration sources changed after dry-run.");
    if (report.status === "replayed") { database.exec("ROLLBACK"); return { ...report, revision: current.revision }; }
    if (current.revision !== expectedRevision) refuse("session_migration_revision_conflict", "Identity migration CAS conflict.");
    const now = new Date().toISOString();
    const ledger = checkLedger(database);
    ensureTrainingPlanSessionSchema(database);
    if (ledger === 2) database.prepare("INSERT INTO mobile_control_schema(version,applied_at) VALUES (3,?)").run(now);
    const repo = new TrainingPlanSessionRepository(database);
    const mappings: Mapping[] = [];
    const instance = `plan-${randomUUID()}`;
    let currentSessions: TrainingPlanSession[] = [], suppressions: TrainingPlanSuppression[] = [];
    let currentDays = current.state.weekPlan;
    for (const snapshot of history) {
      const isCurrent = snapshot.revision === current.revision;
      const historicalInstance = isCurrent ? instance : `legacy-plan-${randomUUID()}`;
      const days = rawDays(snapshot);
      const availableAt = new Date(snapshot.changed_at).toISOString();
      const sessions = days.filter(day => day.kind !== "rest").map(prescription => {
        const session: TrainingPlanSession = { planInstanceId: historicalInstance, sessionId: `session-${randomUUID()}`,
          sessionRevision: 1, prescription, recommendation: null, userOverride: null, protection: "user_protected",
          lifecycle: "pending", availableAt, supersededBySessionId: null };
        mappings.push({ sourceRevision: snapshot.revision, localDate: prescription.localDate, planInstanceId: historicalInstance,
          sessionId: session.sessionId, sessionRevision: 1 });
        if (!isCurrent) repo.append(scope, snapshot.revision, session);
        return session;
      });
      if (isCurrent) {
        currentDays = days; currentSessions = sessions;
        suppressions = days.filter(day => day.kind === "rest").map(day => ({ localDate: day.localDate, reason: "explicit_rest", sessionId: null, availableAt }));
      }
    }
    const state = parseTrainingPlanState({ ...current.state, schemaVersion: 2, migrationVersion: 2,
      sourceDigest: report.sourceDigest, planInstanceId: instance, sessions: currentSessions, suppressions,
      weekPlan: currentDays, publishedInputKey: null }) as TrainingPlanSessionState;
    const result = new TrainingPlanStore(database).commitState({ scope, expectedRevision,
      state, eventType: "session_identity_migration" }, { inTransaction: true, sessionMigration: true });
    database.prepare(`INSERT INTO mobile_training_migration_audit
      (scope,migration_version,source_digest,result_digest,status,payload_json,created_at) VALUES (?,2,?,?,'applied',?,?)`)
      .run(scope, report.sourceDigest, digest(state), JSON.stringify({ revision: result.revision, state,
        mappingVersion: 1, mappingDigest: digest(mappings), identityMappings: mappings, historySnapshots: history.length }), now);
    database.exec("COMMIT");
    return { ...report, status: "applied" as const, revision: result.revision, planInstanceId: instance };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
    if (error instanceof TrainingPlanStateError) throw new TrainingPlanSessionMigrationError("session_migration_invalid_state", error.message);
    throw error;
  }
}
