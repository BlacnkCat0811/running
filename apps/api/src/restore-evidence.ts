/**
 * Structured evidence for a **failed** backup restore.
 *
 * The recovery route temporarily freezes the import worker before touching the
 * main database. If the restore fails, the freeze may only be released when the
 * failure provably had no lasting side effect on the dataset. Error text,
 * `existsSync()` or a single `quick_check` are not evidence: they cannot
 * distinguish "the original file is still there" from "an empty or foreign
 * file with the right name is there".
 *
 * `DatabaseMaintenance.restoreBackup()` attaches this record to every failure;
 * the API adds its own independent checks (identity, required tables, epoch,
 * sidecar scope) before releasing anything.
 */

export const RESTORE_FAILURE_EVIDENCE = Symbol.for("rai.restore-failure-evidence");

/** Facts the maintenance layer can prove about its own failure handling. */
export interface RestoreFailureEvidence {
  /** Versioned so a future change cannot be mistaken for this contract. */
  version: 1;
  /** Did any step run that could have changed the main database bytes? */
  mainDatabaseTouched: boolean;
  /** Did the main database exist when the restore started? */
  originalExisted: boolean;
  /** Was a durable snapshot of the original committed before touching bytes? */
  originalSnapshotDurable: boolean;
  /** After the failure, were the original bytes restored and readable? */
  originalRestoredVerified: boolean;
  /** Number of errors raised by the rollback/recovery actions (0 = clean). */
  recoveryErrors: number;
  /** Is the read-store replacement gate released? */
  replaceGateReleased: boolean;
  /** Is the on-disk restore journal closed (no intent left open)? */
  restoreJournalClosed: boolean;
}

/** Facts only the caller can check, independently of the maintenance layer. */
export interface RestoreFailureCallerEvidence {
  /** Main database is readable through the normal identity path. */
  mainDatabaseReadable: boolean;
  /** Required tables are present (the first request would not fail on schema). */
  requiredTablesPresent: boolean;
  /** The effective epoch is byte-for-byte the one observed before the request. */
  epochUnchanged: boolean;
  /** Sidecar scope and configured epoch still agree with the main database. */
  sidecarScopeConsistent: boolean;
  /** The worker already held an independent recovery block before the attempt. */
  hadRecoveryBlock: boolean;
}

export type RestoreFailureDecision =
  | { safe: true }
  | { safe: false; reasons: string[] };

export function attachRestoreFailureEvidence(error: unknown, evidence: RestoreFailureEvidence): void {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    Object.defineProperty(error, RESTORE_FAILURE_EVIDENCE, {
      value: evidence, configurable: true, enumerable: false, writable: false
    });
  } catch { /* never let evidence attachment mask the original failure */ }
}

export function readRestoreFailureEvidence(error: unknown): RestoreFailureEvidence | null {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  const value = (error as Record<symbol, unknown>)[RESTORE_FAILURE_EVIDENCE];
  if (value === null || typeof value !== "object") return null;
  const evidence = value as Partial<RestoreFailureEvidence>;
  if (evidence.version !== 1
      || typeof evidence.mainDatabaseTouched !== "boolean"
      || typeof evidence.originalExisted !== "boolean"
      || typeof evidence.originalSnapshotDurable !== "boolean"
      || typeof evidence.originalRestoredVerified !== "boolean"
      || !Number.isInteger(evidence.recoveryErrors)
      || typeof evidence.replaceGateReleased !== "boolean"
      || typeof evidence.restoreJournalClosed !== "boolean") {
    return null;
  }
  return evidence as RestoreFailureEvidence;
}

/**
 * The single decision point for "may this failed restore release the temporary
 * freeze?".
 *
 * Safe only when **all** of these hold:
 *   - the restore journal is closed and the replace gate is released;
 *   - either the main database was never touched, or the original snapshot was
 *     durable AND the original bytes were restored and verified with zero
 *     recovery errors;
 *   - the caller's independent checks pass (readable identity, required
 *     tables, unchanged epoch, consistent sidecar);
 *   - there was no pre-existing genuine recovery block.
 */
export function decideRestoreFailureRelease(
  evidence: RestoreFailureEvidence | null,
  caller: RestoreFailureCallerEvidence
): RestoreFailureDecision {
  const reasons: string[] = [];
  if (evidence === null) {
    reasons.push("restore failure carried no structured evidence");
  } else {
    if (!evidence.restoreJournalClosed) reasons.push("restore journal is still open");
    if (!evidence.replaceGateReleased) reasons.push("replacement gate is still held");
    if (evidence.mainDatabaseTouched) {
      if (!evidence.originalSnapshotDurable) reasons.push("no durable snapshot of the original database");
      if (!evidence.originalRestoredVerified) reasons.push("the original database was not restored and verified");
      if (evidence.recoveryErrors > 0) reasons.push(`rollback reported ${evidence.recoveryErrors} error(s)`);
    }
  }
  if (!caller.mainDatabaseReadable) reasons.push("the main database is not readable");
  if (!caller.requiredTablesPresent) reasons.push("required tables are missing from the main database");
  if (!caller.epochUnchanged) reasons.push("the effective dataset epoch changed");
  if (!caller.sidecarScopeConsistent) reasons.push("the dataset sidecar scope does not agree");
  if (caller.hadRecoveryBlock) reasons.push("an independent recovery block was already active");
  return reasons.length === 0 ? { safe: true } : { safe: false, reasons };
}
