import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { parseTrainingPlanScopeKey, parseTrainingPlanState } from "./training-plan-store.js";
import { sessionRecord, trainingPlanLockedRestConflicts, type TrainingPlanLockedRestConflict } from "./training-plan-session-state.js";

interface Location { source: string; scope: string; revision: number; schemaVersion: number | null }
export interface TrainingPlanStateAuditReport {
  ok: boolean;
  complete: boolean;
  readOnly: true;
  snapshots: number;
  scopes: number;
  affectedScopes: number | null;
  conflicts: Array<Location & TrainingPlanLockedRestConflict>;
  issues: Array<Partial<Location> & { code: string }>;
}

/** Explicit offline copy only. No runtime bootstrap, migrations or environment defaults. */
export function auditTrainingPlanStateCopy(path: string): TrainingPlanStateAuditReport {
  const report: TrainingPlanStateAuditReport = { ok: false, complete: false, readOnly: true, snapshots: 0, scopes: 0,
    affectedScopes: null, conflicts: [], issues: [] };
  let database: DatabaseSync | undefined;
  try {
    try { if (!statSync(path).isFile()) throw new Error(); }
    catch { report.issues.push({ code: "control_copy_missing_or_not_file" }); return report; }
    try { database = new DatabaseSync(path, { readOnly: true }); }
    catch { report.issues.push({ code: "control_copy_unavailable" }); return report; }
    database.exec("BEGIN");
    const sources = ["mobile_training_state", "mobile_training_state_history"];
    for (const source of sources) {
      const columns = database.prepare(`PRAGMA table_info(${source})`).all().map(row => row.name);
      if (!["scope", "revision", "payload_json"].every(name => columns.includes(name))) {
        report.issues.push({ source, code: "state_table_schema_mismatch" });
      }
    }
    if (report.issues.length > 0) return report;
    const scopes = new Set<string>(), affected = new Set<string>();
    for (const source of sources) {
      // Iterate snapshots instead of retaining historical health-bearing payloads.
      for (const row of database.prepare(`SELECT scope,revision,payload_json FROM ${source} ORDER BY scope,revision`).iterate()) {
        report.snapshots++;
        const scope = String(row.scope), revision = Number(row.revision);
        const location: Location = { source, scope, revision, schemaVersion: null };
        scopes.add(scope);
        try { parseTrainingPlanScopeKey(scope); }
        catch { report.issues.push({ ...location, code: "invalid_scope" }); }
        if (!Number.isSafeInteger(revision) || revision < 0) report.issues.push({ ...location, code: "invalid_revision" });
        let raw: unknown;
        try { raw = JSON.parse(String(row.payload_json)); }
        catch { report.issues.push({ ...location, code: "invalid_json" }); continue; }
        location.schemaVersion = sessionRecord(raw) && typeof raw.schemaVersion === "number" ? raw.schemaVersion : null;
        const conflicts = trainingPlanLockedRestConflicts(raw);
        if (conflicts.length > 0) {
          affected.add(scope);
          report.conflicts.push(...conflicts.map(conflict => ({ ...location, ...conflict })));
        }
        if (location.schemaVersion !== 1 && location.schemaVersion !== 2) {
          report.issues.push({ ...location, code: "unsupported_state_schema" });
        } else if (conflicts.length === 0) {
          try { parseTrainingPlanState(raw); }
          catch { report.issues.push({ ...location, code: "invalid_state" }); }
        }
      }
    }
    report.scopes = scopes.size;
    report.complete = report.issues.length === 0;
    report.affectedScopes = report.complete ? affected.size : null;
    report.ok = report.complete && report.conflicts.length === 0;
    return report;
  } catch {
    // SQLite/parser error strings can contain payload fragments or local paths.
    report.issues.push({ code: "control_copy_read_failed" });
    return report;
  } finally {
    if (database) { if (database.isTransaction) database.exec("ROLLBACK"); database.close(); }
  }
}
