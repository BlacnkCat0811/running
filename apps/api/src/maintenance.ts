import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { ClientRequestError } from "./api-error.js";
import { faultPoint } from "./fault-injection.js";
import { closeDeletionOperation, readDatasetEpochState, type DatasetEpochState } from "./dataset-epoch.js";
import { ImportPublicationJournal } from "./import-publication.js";
import {
  isBoundRestoreIntent, RestoreJournal, RestoreRecoveryRequiredError,
  type BoundRestoreIntent, type RestoreIntent
} from "./restore-journal.js";
import { attachRestoreFailureEvidence, type RestoreFailureEvidence } from "./restore-evidence.js";
import { RuntimeStateStore } from "./runtime-state.js";

import type { BackupDto } from "@rai/api-contracts";
import { RaiDatabase, runWalCheckpointTruncate } from "@rai/storage-sqlite";

/**
 * P1-9：删除失败后的**结构化**恢复证据。
 *
 * server 不得从 `existsSync()` 推断“已恢复成功”。维护层在异常路径上必须
 * 明确回答：原库当时是否可读、快照是否恢复出了一个通过校验的库、replace
 * gate 是否真的释放。
 */
export interface DatabaseDeletionFailureEvidence {
  originalReadable: boolean;
  originalRestored: boolean;
  gateReleased: boolean;
  restoredVerified: boolean;
}

export class DatabaseDeletionFailure extends AggregateError {
  constructor(
    message: string, errors: unknown[], readonly evidence: DatabaseDeletionFailureEvidence,
    options?: ErrorOptions
  ) {
    super(errors, message, options);
    this.name = "DatabaseDeletionFailure";
  }
}

const applyBusyTimeout = (database: DatabaseSync, milliseconds = 5000): void => {
  database.exec(`PRAGMA busy_timeout = ${milliseconds}`);
};

const hasRequiredColumns = (
  database: DatabaseSync,
  table: string,
  requiredColumns: readonly string[]
): boolean => {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  return requiredColumns.every((column) => names.has(column));
};

const validateRaiDatabaseIdentity = (database: DatabaseSync): void => {
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('schema_migrations', 'health_records', 'workouts')
  `).all() as Array<{ name: string }>;
  const names = new Set(tables.map((table) => table.name));
  const hasCanonicalSchema =
    names.has("health_records") &&
    names.has("workouts") &&
    hasRequiredColumns(database, "health_records", ["id", "type", "start_at", "end_at", "metadata_json"]) &&
    hasRequiredColumns(database, "workouts", [
      "id", "activity_type", "start_at", "end_at", "duration_seconds", "metadata_json"
    ]);
  if (!hasCanonicalSchema) throw new Error("备份不是有效的 RAI 数据库");

  // Pre-ledger databases are supported, as are v1 ledgers without the later name/checksum columns.
  if (names.has("schema_migrations")) {
    const migrationColumns = database.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
    if (!migrationColumns.some((column) => column.name === "version")) {
      throw new Error("备份不是有效的 RAI 数据库");
    }
    const initialMigration = database
      .prepare("SELECT 1 AS present FROM schema_migrations WHERE version = 1 LIMIT 1")
      .get() as { present: number } | undefined;
    if (initialMigration?.present !== 1) throw new Error("备份不是有效的 RAI 数据库");
  }
};

/**
 * Caller-supplied identity for a production restore. When present the journal
 * is a {@link BoundRestoreIntent} and remains open after the main database
 * commit until {@link DatabaseMaintenance.finalizeCommittedRestore} finishes
 * the sidecar, scope and publication-intent settlement.
 */
export interface RestoreOperationContext {
  plannedEpoch: string;
  configuredEpoch: string;
  serverId: string;
  athleteId: string;
  deletionId: string | null;
}

export interface BackupPolicyOptions {
  maxCount?: number;
  maxTotalBytes?: number;
  minimumFreeBytes?: number;
}

export const backupPolicyFromEnvironment = (
  environment: NodeJS.ProcessEnv = process.env
): BackupPolicyOptions => {
  const positive = (name: string): number | undefined => {
    const value = environment[name];
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const maxCount = positive("RAI_BACKUP_MAX_COUNT");
  const maxTotalBytes = positive("RAI_BACKUP_MAX_TOTAL_BYTES");
  const minimumFreeBytes = positive("RAI_BACKUP_MIN_FREE_BYTES");
  return {
    ...(maxCount !== undefined ? { maxCount } : {}),
    ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}),
    ...(minimumFreeBytes !== undefined ? { minimumFreeBytes } : {})
  };
};

const DEFAULT_BACKUP_POLICY = {
  maxCount: 10,
  maxTotalBytes: 20 * 1024 ** 3,
  minimumFreeBytes: 512 * 1024 ** 2
} as const;

/**
 * Files an interrupted process leaves behind in the database directory.
 *
 * Two shapes matter, and both are equally permanent:
 *
 * * `<target>.replaced.<uuid>` — `publishDatabaseFile` renames the previous
 *   database aside so that a failed publication can roll back. Once the
 *   publisher has committed, nothing will ever call rollback again, so the file
 *   is unreachable and should be reclaimed by its owner.
 * * the staging names — `<target>.importing.<uuid>`
 *   (`health-export-parser/src/cli.ts`) and `rai.importing.<jobId>.sqlite`
 *   (`worker.ts`). Each is a whole-database copy removed by a `finally` block,
 *   and a `finally` block does not run after SIGKILL, OOM or a power cut. Left
 *   out of this pattern they are permanent, and because they sit next to the
 *   database rather than in `var/backups/` no retention policy sees them.
 *
 * The age window is what keeps this safe: an import that is still running is
 * minutes old, never a day.
 */
const ABANDONED_DATABASE_FILE_PATTERN =
  /\.(?:replaced\.[0-9a-fA-F-]{36}|importing\.[^/\\]+)$/;

/** Long enough for an operator to recover by hand, short enough to bound growth. */
const DEFAULT_DISPLACED_DATABASE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface DisplacedDatabaseReclamation {
  removed: number;
  reclaimedBytes: number;
}

export class DatabaseMaintenance {
  private readonly restoreJournal: RestoreJournal;
  private readonly runtimeRoot: string;
  readonly backupDirectory: string;
  readonly quarantineDirectory: string;

  constructor(
    private readonly databasePath: string,
    projectRoot: string,
    private readonly beforeReplace: () => void | Promise<void> = () => {},
    private readonly afterReplace: () => void | Promise<void> = () => {},
    private readonly installReplacement: (source: string, destination: string) => Promise<void> = rename,
    private readonly removeFile: (path: string) => Promise<void> = (path) => rm(path, { force: true }),
    private readonly moveFile: (source: string, destination: string) => Promise<void> = rename,
    private readonly backupPolicy: BackupPolicyOptions = {}
  ) {
    this.runtimeRoot = projectRoot;
    this.restoreJournal = new RestoreJournal(databasePath, projectRoot);
    this.backupDirectory = resolve(projectRoot, "var/backups");
    this.quarantineDirectory = resolve(projectRoot, "var/quarantine");
  }

  private async syncFile(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    // Windows does not support opening directories through fs.open.
    if (process.platform === "win32") return;
    await this.syncFile(path);
  }

  /** Must run under the publication lock, before opening any read store/worker. */
  async recoverInterruptedRestore(): Promise<void> {
    const intent = this.restoreJournal.read();
    if (!intent) return;
    if (intent.phase === "committed") {
      if (isBoundRestoreIntent(intent)) {
        // The durable intent, the actual main bytes and the epoch written by
        // the committed restore must all agree before any sidecar/scope or
        // publication state is allowed to move.
        await this.finalizeBoundRestore(intent);
        return;
      }
      // A legacy committed journal has no planned epoch, deletion binding or
      // main-byte hash. "Readable" alone cannot prove which dataset was
      // restored, so it must never be finalized automatically.
      throw new RestoreRecoveryRequiredError(
        "Legacy committed restore journal cannot be verified; manual recovery required");
    } else if (intent.snapshot) {
      // Copy from an immutable snapshot. If recovery itself is killed, the same
      // intent can be replayed without consuming its only rollback point.
      const failures = await this.restoreDeletedDatabase(intent.snapshot, intent.snapshotIsQuarantine);
      if (failures.length) throw new RestoreRecoveryRequiredError("Interrupted restore could not be recovered", { cause: failures[0] });
    } else {
      for (const suffix of ["-shm", "-wal", ""]) await this.removeFileWithRetry(`${this.databasePath}${suffix}`);
    }
    await this.syncDirectory(dirname(this.databasePath));
    this.restoreJournal.clear();
    for (const suffix of ["-shm", "-wal", ""]) await this.removeFileWithRetry(`${intent.staging}${suffix}`);
  }

  /**
   * Finish the durable metadata settlement of a committed bound restore.
   *
   * Idempotent: sidecar closure, scope registration and publication-intent
   * supersession are replayed in full after every crash point. The journal is
   * cleared only after all three have succeeded, so a later startup can resume
   * from exactly the same intent.
   */
  async finalizeCommittedRestore(): Promise<void> {
    const intent = this.restoreJournal.read();
    if (intent === null) return;
    if (intent.phase !== "committed") {
      throw new RestoreRecoveryRequiredError("The restore journal is not at the committed phase");
    }
    if (!isBoundRestoreIntent(intent)) {
      this.restoreJournal.clear();
      await this.removeRestoreStaging(intent);
      return;
    }
    await this.finalizeBoundRestore(intent);
  }

  private async finalizeBoundRestore(intent: BoundRestoreIntent): Promise<void> {
    // Verify the main bytes and read the bound deletion in the same snapshot;
    // never re-read a possibly different file between verification and closing.
    const state = await this.verifyCommittedRestore(intent);
    const at = new Date().toISOString();
    const deletion = state.deletion;
    if (intent.deletionId !== null && deletion === null) {
      throw new RestoreRecoveryRequiredError(
        `Restore intent is bound to deletion ${JSON.stringify(intent.deletionId)}, but the sidecar has no `
        + "deletion operation; manual recovery required");
    }
    if (deletion !== null && deletion.deletionId !== intent.deletionId) {
      throw new RestoreRecoveryRequiredError(
        `Restore intent is bound to deletion ${JSON.stringify(intent.deletionId)}, but the sidecar records `
        + `${JSON.stringify(deletion.deletionId)}; manual recovery required`);
    }
    const store = new RuntimeStateStore(this.runtimeRoot);
    if (deletion !== null) {
      // Same order as every other rollback: revoke before closing.
      store.revokeDeletionPermit(
        JSON.stringify([intent.serverId, intent.athleteId, deletion.nextEpoch]), deletion.deletionId, at);
    }
    closeDeletionOperation(this.databasePath, intent.configuredEpoch, intent.plannedEpoch, {
      ...(deletion === null ? {} : { deletionId: deletion.deletionId }),
      reason: "explicit backup restore committed",
      at,
      supersedeConsumed: true
    });
    store.markScopeDatasetEstablished(
      JSON.stringify([intent.serverId, intent.athleteId, intent.plannedEpoch]), at);
    // Publication intents that predate the replacement belong to bytes that are
    // gone by operator decision. They become inert only after the restored
    // main database, sidecar epoch and scope are all durable.
    new ImportPublicationJournal(this.databasePath, this.runtimeRoot)
      .supersedeWithRestore(intent.plannedEpoch);
    // Acceptance-only barrier: sidecar, scope and publication intents are all
    // settled, but the durable intent has not been cleared yet.
    faultPoint("restore:before-journal-clear");
    await this.removeRestoreStaging(intent);
    this.restoreJournal.clear();
  }

  private async verifyCommittedRestore(intent: BoundRestoreIntent): Promise<DatasetEpochState> {
    if (!existsSync(this.databasePath)) {
      throw new RestoreRecoveryRequiredError("Committed restore database is missing");
    }
    try {
      if (intent.mainSha256 !== undefined) {
        const actual = await this.hashFile(this.databasePath);
        if (actual.sha256 !== intent.mainSha256) {
          throw new Error("main database bytes do not match the committed restore intent");
        }
      }
      const state = readDatasetEpochState(this.databasePath, intent.configuredEpoch, {
        strictConfigured: true, identity: { serverId: intent.serverId, athleteId: intent.athleteId }
      });
      if (state.mainEpochExplicit !== true || state.epoch !== intent.plannedEpoch) {
        throw new Error(`main database reports epoch ${JSON.stringify(state.epoch)}, `
          + `not the planned restore epoch ${JSON.stringify(intent.plannedEpoch)}`);
      }
      if (!this.isVerifiedRestoredDatabase(this.databasePath)) {
        throw new Error("main database failed identity or integrity verification");
      }
      return state;
    } catch (error) {
      if (error instanceof RestoreRecoveryRequiredError) throw error;
      throw new RestoreRecoveryRequiredError(
        "Committed restore does not match its durable intent", { cause: error });
    }
  }

  private async removeRestoreStaging(intent: RestoreIntent): Promise<void> {
    for (const suffix of ["-shm", "-wal", ""]) {
      await this.removeFileWithRetry(`${intent.staging}${suffix}`).catch(() => {});
    }
  }

  private async hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
    const before = await stat(path);
    const hash = createHash("sha256");
    await new Promise<void>((resolveStream, rejectStream) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.once("error", rejectStream);
      stream.once("end", resolveStream);
    });
    const after = await stat(path);
    if (before.size !== after.size) throw new Error(`File changed while hashing: ${path}`);
    return { sha256: hash.digest("hex"), sizeBytes: after.size };
  }

  private protectedRestoreSnapshot(): string[] {
    const snapshot = this.restoreJournal.read()?.snapshot;
    return snapshot ? [basename(snapshot)] : [];
  }

  async createBackup(reason = "manual", additionalProtectedNames: readonly string[] = []): Promise<BackupDto> {
    if (!existsSync(this.databasePath)) throw new Error("本地 RAI 数据库不存在");
    await mkdir(this.backupDirectory, { recursive: true });
    await this.ensureBackupCapacity(additionalProtectedNames);
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const safeReason = reason.replace(/[^a-z0-9-]/gi, "-").slice(0, 48) || "manual";
    const name = `rai.${safeReason}.${timestamp}.${randomUUID().slice(0, 8)}.sqlite`;
    const destination = resolve(this.backupDirectory, name);
    const staging = `${destination}.partial-${randomUUID()}`;
    const database = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      await this.backupDatabase(database, staging);
      await rename(staging, destination);
      // The deletion journal may be fsynced immediately after this returns.
      // Make its recovery snapshot durable first, including the directory entry.
      await this.syncFile(destination);
      await this.syncDirectory(this.backupDirectory);
    } catch (error) {
      try {
        await this.removeFileWithRetry(staging);
      } catch (cleanupError) {
        if (error && typeof error === "object") {
          try {
            (error as { cleanupError?: unknown }).cleanupError = cleanupError;
          } catch { /* Preserve the original backup error even when it is immutable. */ }
        }
      }
      throw error;
    } finally {
      database.close();
    }
    const result = await this.describe(name);
    try {
      await this.enforceBackupPolicy([name, ...additionalProtectedNames]);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Backup retention cleanup failed after backup was published: ${message}\n`);
    }
    return result;
  }

  async listBackups(): Promise<BackupDto[]> {
    if (!existsSync(this.backupDirectory)) return [];
    const names = (await readdir(this.backupDirectory))
      .filter((name) => name.endsWith(".sqlite"));
    const backups = await Promise.all(names.map(async (name) => {
      try {
        return await this.describe(name);
      } catch (error) {
        // Retention and explicit deletion may remove an entry after readdir().
        if (this.isMissingFileError(error)) return null;
        throw error;
      }
    }));
    return backups
      .filter((backup): backup is BackupDto => backup !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async backupStream(name: string) {
    if (name !== basename(name) || !name.endsWith(".sqlite")) throw new ClientRequestError("invalid_backup_name", "备份文件名无效", 400);
    const path = resolve(this.backupDirectory, name);
    try {
      // Opening first removes the exists/open race. On Windows the handle also
      // keeps deletion from invalidating a response already being streamed.
      const handle = await open(path, "r");
      return handle.createReadStream();
    } catch (error) {
      if (this.isMissingFileError(error)) throw new ClientRequestError("backup_not_found", "备份文件不存在", 404);
      throw error;
    }
  }

  async deleteBackup(name: string): Promise<BackupDto> {
    if (name !== basename(name) || !name.endsWith(".sqlite")) throw new ClientRequestError("invalid_backup_name", "备份文件名无效", 400);
    if (this.protectedRestoreSnapshot().includes(name)) throw new ClientRequestError("backup_in_use", "备份正在用于恢复", 409);
    const backupInfo = await this.describe(name).catch((error: unknown) => {
      if (this.isMissingFileError(error)) throw new ClientRequestError("backup_not_found", "备份文件不存在", 404);
      throw error;
    });
    await this.removeFileWithRetry(resolve(this.backupDirectory, name));
    return backupInfo;
  }

  async deleteDatabase(
    prepareDeletion: (backup: BackupDto & { restorable?: boolean }) => void = () => {},
    afterRemoval: () => void = () => {}
  ): Promise<BackupDto & { restorable?: boolean }> {
    const originalReadable = this.isReadableDatabase(this.databasePath);
    let backupIsQuarantine = false;
    let backupInfo: BackupDto;
    try {
      backupInfo = await this.createBackup("before-delete");
    } catch (error) {
      if (this.isReadableDatabase(this.databasePath)) throw error;
      backupInfo = await this.preserveCorruptDatabase("before-delete-corrupt");
      backupIsQuarantine = true;
    }
    const backupPath = resolve(backupIsQuarantine ? this.quarantineDirectory : this.backupDirectory, backupInfo.name);
    let replaceGateEntered = false;
    try {
      await this.beforeReplace();
      replaceGateEntered = true;
    } catch (error) {
      throw error;
    }
    try {
      if (this.isReadableDatabase(this.databasePath)) this.checkpointDatabase(this.databasePath);
      prepareDeletion(backupInfo);
      await this.removeFileWithRetry(`${this.databasePath}-shm`);
      await this.removeFileWithRetry(`${this.databasePath}-wal`);
      await this.removeFileWithRetry(this.databasePath);
      // The unlink is not durable until the directory entry is flushed. Only the
      // caller's `afterRemoval` may persist `main_removed`, so a crash before this
      // point remains a *prepared* (ambiguous) deletion, never an assumed one.
      await this.syncDirectory(dirname(this.databasePath));
      faultPoint("deletion:after-main-unlinked");
      afterRemoval();
      await this.releaseReplaceGate();
      replaceGateEntered = false;
      return backupInfo;
    } catch (error) {
      const errors: unknown[] = [error];
      let originalRestored = false;
      let restoredVerified = false;
      if (!this.isReadableDatabase(this.databasePath)) {
        const restoreErrors = await this.restoreDeletedDatabase(backupPath, backupIsQuarantine);
        errors.push(...restoreErrors);
        originalRestored = restoreErrors.length === 0;
        restoredVerified = originalRestored && this.isVerifiedRestoredDatabase(this.databasePath);
      } else {
        restoredVerified = this.isVerifiedRestoredDatabase(this.databasePath);
      }
      // P1-9: the replace gate is released on **every** failure path. Leaving it
      // entered hides the main database from maintenance for the rest of the
      // process, which is strictly worse than surfacing "not verified".
      if (replaceGateEntered) {
        try {
          await this.releaseReplaceGate();
          replaceGateEntered = false;
        } catch (releaseError) {
          errors.push(releaseError);
        }
      }
      const primary = errors[0];
      throw new DatabaseDeletionFailure(
        errors.length === 1
          ? (primary instanceof Error ? primary.message : String(primary))
          : "Database deletion failed and required recovery actions also failed",
        errors,
        {
          originalReadable,
          originalRestored,
          gateReleased: !replaceGateEntered,
          restoredVerified
        },
        { cause: errors.length === 1 ? primary : new AggregateError(errors) }
      );
    }
  }

  /**
   * Side-effect-free checks that can run **before** the API freezes imports.
   *
   * The backup name and existence are cheap and prove the request cannot
   * proceed; doing them before the freeze shrinks the frozen window to actual
   * candidate work. `restoreBackup()` repeats them under the restore flow
   * because the filesystem can change in between.
   */
  preflightRestore(name: string): { backupDirectory: string; source: string } {
    if (name !== basename(name) || !name.endsWith(".sqlite")) {
      throw new ClientRequestError("invalid_backup_name", "备份文件名无效", 400);
    }
    if (this.restoreJournal.read()) {
      throw new RestoreRecoveryRequiredError("A previous restore needs startup recovery");
    }
    const source = resolve(this.backupDirectory, name);
    if (!existsSync(source)) throw new ClientRequestError("backup_not_found", "备份文件不存在", 404);
    // Cheap identity preflight only; full quick_check/foreign_key validation
    // still runs on the private staging copy after the freeze.
    const candidate = new DatabaseSync(source, { readOnly: true });
    try {
      validateRaiDatabaseIdentity(candidate);
    } finally {
      candidate.close();
    }
    return { backupDirectory: this.backupDirectory, source };
  }

  /**
   * Replace the main database with a backup.
   *
   * Every failure carries {@link RestoreFailureEvidence}: "the request was
   * rejected" is a claim about *side effects*, not about the error code. The
   * API uses it (plus its own independent checks) to decide whether a temporary
   * import freeze may be released.
   */
  async restoreBackup(
    name: string,
    beforeCommit: () => void | Promise<void> = () => {},
    prepareReplacement: (database: DatabaseSync) => void = () => {},
    operation?: RestoreOperationContext
  ): Promise<{ restored: BackupDto; safetyBackup: BackupDto | null }> {
    const evidence: RestoreFailureEvidence = {
      version: 1,
      mainDatabaseTouched: false,
      originalExisted: existsSync(this.databasePath),
      originalSnapshotDurable: false,
      originalRestoredVerified: false,
      recoveryErrors: 0,
      replaceGateReleased: true,
      restoreJournalClosed: false
    };
    try {
      return await this.restoreBackupInner(name, beforeCommit, prepareReplacement, evidence, operation);
    } catch (error) {
      try {
        evidence.restoreJournalClosed = this.restoreJournal.read() === null;
      } catch {
        // An unreadable journal is not a closed journal.
        evidence.restoreJournalClosed = false;
      }
      attachRestoreFailureEvidence(error, { ...evidence });
      throw error;
    }
  }

  private async restoreBackupInner(
    name: string,
    beforeCommit: () => void | Promise<void>,
    prepareReplacement: (database: DatabaseSync) => void,
    evidence: RestoreFailureEvidence,
    operation?: RestoreOperationContext
  ): Promise<{ restored: BackupDto; safetyBackup: BackupDto | null }> {
    // Re-check under the restore flow: the name/existence preflight ran before
    // the import freeze, and a file can disappear while the freeze is prepared.
    const { source } = this.preflightRestore(name);
    let safetyBackup: BackupDto | null = null;
    let intent: RestoreIntent | null = null;
    const staging = `${this.databasePath}.restoring.${randomUUID()}`;
    const rollback = resolve(this.backupDirectory, `rai.restore-rollback.${randomUUID()}.sqlite`);
    try {
      await mkdir(dirname(this.databasePath), { recursive: true });
      // Bind the exact backup bytes the operator authorized, not merely its
      // name: the source can be rotated/replaced while the request is frozen.
      const authorizedBackup = await this.hashFile(source);
      await copyFile(source, staging);
      const copiedBackup = await this.hashFile(staging);
      if (copiedBackup.sha256 !== authorizedBackup.sha256
          || copiedBackup.sizeBytes !== authorizedBackup.sizeBytes) {
        throw new Error("Backup bytes changed while the restore was being prepared");
      }
      const sourceCandidate = new DatabaseSync(staging, { readOnly: true });
      try {
        validateRaiDatabaseIdentity(sourceCandidate);
      } finally {
        sourceCandidate.close();
      }
      const migratedCandidate = await RaiDatabase.open(staging, { createMigrationBackup: false });
      try { prepareReplacement(migratedCandidate.database); }
      finally { migratedCandidate.close(); }
      this.checkpointDatabase(staging);
      await this.removeFileWithRetry(`${staging}-shm`);
      await this.removeFileWithRetry(`${staging}-wal`);
      const candidate = new DatabaseSync(staging, { readOnly: true });
      try {
        const quick = candidate.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
        if (quick?.quick_check !== "ok") throw new Error("备份数据库完整性校验失败");
        const violations = candidate.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) throw new Error("备份数据库外键校验失败");
      } finally {
        candidate.close();
      }
      // Read-only validation can recreate WAL sidecars for a WAL-mode database.
      await this.removeFileWithRetry(`${staging}-shm`);
      await this.removeFileWithRetry(`${staging}-wal`);
      // A rejected restore must not consume retention slots or evict good backups.
      if (existsSync(this.databasePath)) {
        try {
          safetyBackup = await this.createBackup("before-restore", [name]);
        } catch (error) {
          if (this.isReadableDatabase(this.databasePath)) throw error;
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          process.stderr.write(`Restore safety backup failed; the replacement gate will preserve corrupt bytes in quarantine: ${message}\n`);
        }
      }
      let replaceGateEntered = false;
      try {
        await this.beforeReplace();
        replaceGateEntered = true;
      } catch (error) {
        throw error;
      }
      const originalExisted = existsSync(this.databasePath);
      evidence.originalExisted = originalExisted;
      const originalReadable = originalExisted && this.isReadableDatabase(this.databasePath);
      let originalMoved = false;
      let corruptSnapshotPath: string | null = null;
      let originalMutationStarted = false;
      let committed = false;
      try {
        if (originalExisted && !originalReadable) {
          const snapshot = await this.preserveCorruptDatabase("before-restore-corrupt");
          corruptSnapshotPath = resolve(this.quarantineDirectory, snapshot.name);
        }
        const commonIntent = {
          target: resolve(this.databasePath), staging: resolve(staging),
          snapshot: corruptSnapshotPath ?? (safetyBackup ? resolve(this.backupDirectory, safetyBackup.name) : null),
          snapshotIsQuarantine: corruptSnapshotPath !== null, phase: "prepared" as const
        };
        intent = operation === undefined ? commonIntent : {
          ...commonIntent,
          version: 2 as const,
          configuredEpoch: operation.configuredEpoch,
          serverId: operation.serverId,
          athleteId: operation.athleteId,
          deletionId: operation.deletionId,
          backupName: basename(source),
          backupSha256: authorizedBackup.sha256,
          backupSizeBytes: authorizedBackup.sizeBytes,
          plannedEpoch: operation.plannedEpoch
        };
        if (originalExisted && !intent.snapshot) throw new Error("Restore requires a durable original snapshot");
        if (intent.snapshot) {
          for (const suffix of ["", "-wal", "-shm"]) {
            if (existsSync(`${intent.snapshot}${suffix}`)) await this.syncFile(`${intent.snapshot}${suffix}`);
          }
          await this.syncDirectory(dirname(intent.snapshot));
        }
        await this.syncFile(staging);
        this.restoreJournal.write(intent);
        await this.syncDirectory(dirname(this.databasePath));
        evidence.originalSnapshotDurable = !originalExisted || intent.snapshot !== null;
        // From here on the main database bytes (or their absence) may change.
        evidence.mainDatabaseTouched = true;
        if (originalExisted) {
          if (originalReadable) {
            const current = new DatabaseSync(this.databasePath);
            applyBusyTimeout(current);
            try {
              // 恢复/换库前的 checkpoint 必须完成：busy 时继续移走数据库会留下
              // 未写回主库的 WAL 页，`-wal` 侧车随后被删除就等于丢事务。
              runWalCheckpointTruncate(current);
            } finally {
              current.close();
            }
          }
          if (originalReadable) {
            await this.moveFileWithRetry(this.databasePath, rollback);
            originalMoved = true;
          } else {
            originalMutationStarted = true;
            await this.removeFileWithRetry(`${this.databasePath}-shm`);
            await this.removeFileWithRetry(`${this.databasePath}-wal`);
            await this.removeFileWithRetry(this.databasePath);
          }
        }
        await this.removeFileWithRetry(`${this.databasePath}-shm`);
        await this.removeFileWithRetry(`${this.databasePath}-wal`);
        await this.installReplacementWithRetry(staging, this.databasePath);
        this.restoreJournal.write({ ...intent, phase: "installed" });
        // Acceptance-only barrier: proves the rollback-and-verify path really
        // releases the temporary freeze on a post-gate failure.
        faultPoint("restore:after-install");
        await beforeCommit();
        this.checkpointDatabase(this.databasePath);
        await this.syncFile(this.databasePath);
        await this.syncDirectory(dirname(this.databasePath));
        await this.releaseReplaceGate();
        replaceGateEntered = false;
        if (isBoundRestoreIntent(intent)) {
          const main = await this.hashFile(this.databasePath);
          this.restoreJournal.write({ ...intent, phase: "committed", mainSha256: main.sha256 });
        } else {
          this.restoreJournal.write({ ...intent, phase: "committed" });
        }
        committed = true;
      } catch (error) {
        const errors: unknown[] = [error];
        // A failure inside the rollback itself must still fall through to the
        // evidence/gate handling below: skipping it would leave the journal open
        // without an explicit decision and without recorded evidence.
        const recover = async (action: () => Promise<unknown[]>): Promise<void> => {
          try { errors.push(...await action()); }
          catch (recoveryError) { errors.push(recoveryError); }
        };
        if (originalMoved) {
          await recover(() => this.restoreOriginalDatabase(rollback));
        } else if (corruptSnapshotPath !== null) {
          const snapshotPath: string = corruptSnapshotPath;
          await recover(() => this.restoreDatabaseGroup(snapshotPath, false));
        } else if (!originalExisted) {
          // When the original state was "no main database", a readable
          // candidate is kept in place during failure handling (deleting the
          // only readable database would be worse), but the journal below stays
          // open so startup rolls the absence back from the durable intent.
          try {
            await this.removeFileWithRetry(`${this.databasePath}-shm`);
            await this.removeFileWithRetry(`${this.databasePath}-wal`);
            await this.syncDirectory(dirname(this.databasePath));
          } catch (removalError) {
            errors.push(removalError);
          }
        }
        const activeReadable = this.isReadableDatabase(this.databasePath);
        if (replaceGateEntered && (
          activeReadable ||
          (!originalExisted && !existsSync(this.databasePath)) ||
          (!originalReadable && !originalMutationStarted && existsSync(this.databasePath)) ||
          (!originalReadable && corruptSnapshotPath !== null && errors.length === 1)
        )) {
          if (!originalExisted) {
            try {
              // quick_check can open WAL sidecars even in read-only mode.
              await this.removeFileWithRetry(`${this.databasePath}-shm`);
              await this.removeFileWithRetry(`${this.databasePath}-wal`);
            } catch (sidecarError) {
              errors.push(sidecarError);
            }
          }
          try {
            await this.releaseReplaceGate();
            replaceGateEntered = false;
          } catch (releaseError) {
            errors.push(releaseError);
          }
        }
        // Evidence is recorded before the throw so the caller never has to
        // infer side effects from the error class or message.
        evidence.recoveryErrors = Math.max(0, errors.length - 1);
        evidence.replaceGateReleased = !replaceGateEntered;
        evidence.originalRestoredVerified = !originalExisted
          ? !existsSync(this.databasePath) && errors.length === 1
          : errors.length === 1 && existsSync(this.databasePath) && this.isReadableDatabase(this.databasePath);
        const corruptGroupRestored = originalExisted && !originalReadable
          && corruptSnapshotPath !== null && errors.length === 1;
        if (errors.length === 1 && intent
            && (evidence.originalRestoredVerified
              || (operation === undefined && corruptGroupRestored))) {
          // A legacy/low-level caller can treat an exact corrupt-group restore
          // as closing the attempt. A bound production intent keeps its
          // deletion/backup/epoch binding until startup verifies the restore.
          this.restoreJournal.clear();
        }
        if (this.restoreJournal.read()) {
          const primaryMessage = errors[0] instanceof Error ? errors[0].message : String(errors[0]);
          throw new RestoreRecoveryRequiredError(
            `${primaryMessage}; database restore needs startup recovery`,
            { cause: new AggregateError(errors) });
        }
        throw errors.length === 1 ? error : new AggregateError(errors, "Database restore failed and required recovery actions also failed");
      } finally {
        if (committed && originalMoved) {
          // Cleanup is post-commit. A locked rollback remains a visible, valid backup.
          await this.removeFileWithRetry(rollback).catch(() => {});
        }
      }
      // Acceptance-only barrier: the main database and the durable intent are
      // committed, but no sidecar, scope or publication state has moved yet.
      // Keep this outside the rollback `catch`: a throw here must not pretend
      // the already-committed restore can be rolled back in-process.
      faultPoint("restore:after-commit");
      // A bound production restore stays replayable until the caller confirms
      // that the sidecar, scope and publication intents were settled.
      if (operation === undefined) this.restoreJournal.clear();
      return { restored: await this.describe(name), safetyBackup };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const candidate of [staging, `${staging}-shm`, `${staging}-wal`]) {
        try {
          await this.removeFileWithRetry(candidate);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Database restore failed and staging cleanup also failed"
        );
      }
      throw error;
    }
  }

  private async restoreOriginalDatabase(rollback: string): Promise<unknown[]> {
    // Acceptance-only barrier: simulates the rollback itself failing. The
    // caller must keep the dataset blocked and the journal open.
    faultPoint("restore:rollback-original");
    const errors: unknown[] = [];
    const activeExists = existsSync(this.databasePath);
    const activeReadable = activeExists && this.isReadableDatabase(this.databasePath);
    if (activeReadable) {
      try {
        this.checkpointDatabase(this.databasePath);
        await this.removeFileWithRetry(`${this.databasePath}-shm`);
        await this.removeFileWithRetry(`${this.databasePath}-wal`);
      } catch (error) {
        errors.push(error);
        return errors;
      }
    } else if (activeExists) {
      try {
        try { this.checkpointDatabase(this.databasePath); } catch { /* Candidate is already unreadable. */ }
        await this.removeFileWithRetry(`${this.databasePath}-shm`);
        await this.removeFileWithRetry(`${this.databasePath}-wal`);
        await this.removeFileWithRetry(this.databasePath);
      } catch (error) {
        errors.push(error);
        return errors;
      }
    }
    try {
      await this.moveFileWithRetry(rollback, this.databasePath);
      await this.syncFile(this.databasePath);
      await this.syncDirectory(dirname(this.databasePath));
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  private async restoreDeletedDatabase(backupPath: string, restoreSidecars = false): Promise<unknown[]> {
    if (restoreSidecars) return await this.restoreDatabaseGroup(backupPath, false);
    const errors: unknown[] = [];
    const staging = `${this.databasePath}.delete-rollback.${randomUUID()}`;
    try {
      // Validate the copy before touching the active file, including on replay.
      await copyFile(backupPath, staging);
      if (!this.isReadableDatabase(staging)) throw new Error("Safety backup is unreadable");
      for (const candidate of [`${this.databasePath}-shm`, `${this.databasePath}-wal`, this.databasePath]) {
        await this.removeFileWithRetry(candidate);
      }
      await this.moveFileWithRetry(staging, this.databasePath);
      if (!this.isReadableDatabase(this.databasePath)) {
        throw new Error("Safety backup did not restore a readable active database");
      }
      await this.syncFile(this.databasePath);
      await this.syncDirectory(dirname(this.databasePath));
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await this.removeFileWithRetry(staging);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    return errors;
  }

  private async restoreDatabaseGroup(sourceBase: string, requireReadable: boolean): Promise<unknown[]> {
    const errors: unknown[] = [];
    const stagingBase = `${this.databasePath}.group-rollback.${randomUUID()}`;
    const suffixes = ["-wal", "-shm", ""] as const;
    const available = suffixes.filter((suffix) => existsSync(`${sourceBase}${suffix}`));
    try {
      if (!available.includes("")) throw new Error("Database group main file is missing");
      for (const suffix of available) await copyFile(`${sourceBase}${suffix}`, `${stagingBase}${suffix}`);
      for (const suffix of ["-shm", "-wal", ""] as const) {
        await this.removeFileWithRetry(`${this.databasePath}${suffix}`);
      }
      for (const suffix of available.filter((suffix) => suffix !== "")) {
        await this.moveFileWithRetry(`${stagingBase}${suffix}`, `${this.databasePath}${suffix}`);
        await this.syncFile(`${this.databasePath}${suffix}`);
      }
      await this.moveFileWithRetry(stagingBase, this.databasePath);
      if (requireReadable && !this.isReadableDatabase(this.databasePath)) {
        throw new Error("Safety backup did not restore a readable active database");
      }
      await this.syncFile(this.databasePath);
      await this.syncDirectory(dirname(this.databasePath));
    } catch (error) {
      errors.push(error);
    } finally {
      for (const suffix of suffixes) {
        try {
          await this.removeFileWithRetry(`${stagingBase}${suffix}`);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
    }
    return errors;
  }

  private async backupDatabase(database: DatabaseSync, destination: string): Promise<void> {
    await backup(database, destination);
  }

  async preserveCorruptDatabase(reason: string): Promise<BackupDto & { restorable: false }> {
    if (!existsSync(this.databasePath)) throw new Error("Local RAI database does not exist");
    await mkdir(this.quarantineDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const safeReason = reason.replace(/[^a-z0-9-]/gi, "-").slice(0, 48) || "corrupt";
    const name = `rai.${safeReason}.${timestamp}.${randomUUID().slice(0, 8)}.sqlite`;
    const destination = resolve(this.quarantineDirectory, name);
    const stagingId = randomUUID();
    const staged = ["", "-wal", "-shm"]
      .map((suffix) => ({ suffix, source: `${this.databasePath}${suffix}` }))
      .filter(({ source }) => existsSync(source))
      .map(({ suffix, source }) => ({
        suffix,
        source,
        staging: `${destination}${suffix}.partial-${stagingId}`,
        published: `${destination}${suffix}`
      }));
    try {
      for (const item of staged) await copyFile(item.source, item.staging);
      for (const item of staged.filter((item) => item.suffix !== "")) {
        await rename(item.staging, item.published);
      }
      const main = staged.find((item) => item.suffix === "");
      if (!main) throw new Error("Local RAI database does not exist");
      await rename(main.staging, main.published);
      for (const item of staged) await this.syncFile(item.published);
      await this.syncDirectory(this.quarantineDirectory);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const item of staged) {
        for (const path of [item.staging, item.published]) {
          try {
            await this.removeFileWithRetry(path);
          } catch (cleanupError) {
            // A whole-database copy left behind in `var/quarantine/` is invisible
            // to every retention policy, so a failed cleanup must not vanish
            // along with the error that caused it.
            cleanupErrors.push(cleanupError);
          }
        }
      }
      throw cleanupErrors.length > 0
        ? new AggregateError(
            [error, ...cleanupErrors],
            "Quarantining the corrupt database failed and cleanup also failed"
          )
        : error;
    }
    const info = await stat(destination);
    return { name, sizeBytes: info.size, createdAt: info.mtime.toISOString(), restorable: false };
  }

  private resolvedBackupPolicy(): Required<BackupPolicyOptions> {
    const positive = (value: number | undefined, fallback: number): number =>
      Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : fallback;
    return {
      maxCount: positive(this.backupPolicy.maxCount, DEFAULT_BACKUP_POLICY.maxCount),
      maxTotalBytes: positive(this.backupPolicy.maxTotalBytes, DEFAULT_BACKUP_POLICY.maxTotalBytes),
      minimumFreeBytes: positive(this.backupPolicy.minimumFreeBytes, DEFAULT_BACKUP_POLICY.minimumFreeBytes)
    };
  }

  async ensureBackupCapacity(protectedNames: readonly string[] = []): Promise<void> {
    await mkdir(this.backupDirectory, { recursive: true });
    try {
      await this.reclaimDisplacedDatabases();
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Displaced database reclamation failed: ${message}\n`);
    }
    try {
      await this.enforceBackupPolicy(protectedNames);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Pre-backup retention cleanup failed; checking capacity without pruning: ${message}\n`);
    }
    const databaseInfo = await stat(this.databasePath);
    const requiredBytes = databaseInfo.size + this.resolvedBackupPolicy().minimumFreeBytes;
    let backups = await this.listBackups();
    let filesystem = await statfs(this.backupDirectory);
    let availableBytes = filesystem.bavail * filesystem.bsize;
    const protectedSet = new Set([...protectedNames, ...this.protectedRestoreSnapshot()]);
    const removalErrors: unknown[] = [];
    for (const candidate of [...backups].reverse()) {
      if (availableBytes >= requiredBytes || backups.length <= 1) break;
      if (protectedSet.has(candidate.name)) continue;
      try {
        await this.removeFileWithRetry(resolve(this.backupDirectory, candidate.name));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EBUSY", "EPERM", "EACCES"].includes(code ?? "")) throw error;
        removalErrors.push(error);
        continue;
      }
      backups = backups.filter((backupInfo) => backupInfo.name !== candidate.name);
      filesystem = await statfs(this.backupDirectory);
      availableBytes = filesystem.bavail * filesystem.bsize;
    }
    if (availableBytes < requiredBytes) {
      const message = `磁盘空间不足，创建备份至少需要 ${requiredBytes} 字节，当前可用 ${availableBytes} 字节`;
      if (removalErrors.length > 0) throw new AggregateError(removalErrors, message);
      throw new Error(message);
    }
  }

  async enforceBackupPolicy(protectedNames: string | readonly string[]): Promise<void> {
    const policy = this.resolvedBackupPolicy();
    const protectedSet = new Set(
      [...(typeof protectedNames === "string" ? [protectedNames] : protectedNames), ...this.protectedRestoreSnapshot()]
    );
    const backups = await this.listBackups();
    let totalBytes = backups.reduce((sum, item) => sum + item.sizeBytes, 0);
    let count = backups.length;
    for (const candidate of [...backups].reverse()) {
      if (count <= 1 || (count <= policy.maxCount && totalBytes <= policy.maxTotalBytes)) break;
      if (protectedSet.has(candidate.name)) continue;
      await this.removeFileWithRetry(resolve(this.backupDirectory, candidate.name));
      totalBytes -= candidate.sizeBytes;
      count -= 1;
    }
  }

  /**
   * Reclaims abandoned database copies: rename-aside rollback points
   * (`<database>.replaced.<uuid>`) and staging files
   * (`<database>.importing.<uuid>`) that can no longer serve any purpose.
   *
   * Nothing ever collected these: `publishDatabaseFile` moves the previous
   * database aside so a failed publication can roll back, and once the publisher
   * commits, the file is unreachable - but both the CLI and the import worker only
   * removed their staging files on the happy path. Every web import therefore left
   * one full database copy behind (89 files / 36 GB, measured 2026-09-15).
   *
   * Files younger than `maxAgeMs` are preserved so an in-flight publication or
   * import can still roll back. Returns what it reclaimed so callers can log the
   * effect.
   *
   * Driven from two places: `ensureBackupCapacity` (a backup or a web import) and a
   * daily timer in `server.ts`, because a machine that stops importing and stops
   * backing up would otherwise keep every leftover forever.
   */
  async reclaimDisplacedDatabases(
    maxAgeMs: number = DEFAULT_DISPLACED_DATABASE_MAX_AGE_MS
  ): Promise<DisplacedDatabaseReclamation> {
    const directory = dirname(this.databasePath);
    if (!existsSync(directory)) return { removed: 0, reclaimedBytes: 0 };
    const cutoff = Date.now() - maxAgeMs;
    const names = (await readdir(directory)).filter((name) => ABANDONED_DATABASE_FILE_PATTERN.test(name));
    const errors: unknown[] = [];
    let removed = 0;
    let reclaimedBytes = 0;
    for (const name of names) {
      const path = resolve(directory, name);
      let info;
      try {
        info = await stat(path);
      } catch (error) {
        if (this.isMissingFileError(error)) continue;
        errors.push(error);
        continue;
      }
      // Never touch a directory, and never touch a publication that may still roll back.
      if (!info.isFile() || info.mtimeMs > cutoff) continue;
      try {
        const sizeBytes = info.size;
        await this.removeFileWithRetry(path);
        for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
          if (existsSync(sidecar)) await this.removeFileWithRetry(sidecar);
        }
        removed += 1;
        reclaimedBytes += sizeBytes;
      } catch (error) {
        if (this.isMissingFileError(error)) continue;
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to reclaim ${errors.length} displaced database file(s)`);
    }
    return { removed, reclaimedBytes };
  }

  private checkpointDatabase(path: string): void {
    const database = new DatabaseSync(path);
    applyBusyTimeout(database);
    try {
      // 调用点全部是“恢复/换库/删除前”的必须完成路径；busy 必须阻止后续文件操作，
      // 不能像可延后的维护那样静默跳过（见 packages/storage-sqlite/src/checkpoint.ts）。
      runWalCheckpointTruncate(database);
    } finally {
      database.close();
    }
  }

  /**
   * P1-9: `quick_check` alone is not enough to declare "the old dataset is
   * back". The restored file must also still be a RAI database: the canonical
   * tables and the columns the API will query on the first request.
   */
  private isVerifiedRestoredDatabase(path: string): boolean {
    if (!this.isReadableDatabase(path)) return false;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path, { readOnly: true });
      validateRaiDatabaseIdentity(database);
      return true;
    } catch {
      return false;
    } finally { database?.close(); }
  }

  private isReadableDatabase(path: string): boolean {
    if (!existsSync(path)) return false;
    try {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        return (database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined)?.quick_check === "ok";
      } finally {
        database.close();
      }
    } catch {
      return false;
    }
  }

  private async removeFileWithRetry(path: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.removeFile(path);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw lastError;
  }

  private async releaseReplaceGate(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.afterReplace();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw lastError;
  }

  private async describe(name: string): Promise<BackupDto> {
    const info = await stat(resolve(this.backupDirectory, name));
    return {
      name,
      sizeBytes: info.size,
      createdAt: info.mtime.toISOString()
    };
  }

  private async moveFileWithRetry(source: string, destination: string): Promise<void> {
    await this.retryWindowsFileOperation(() => this.moveFile(source, destination));
  }

  private async installReplacementWithRetry(source: string, destination: string): Promise<void> {
    await this.retryWindowsFileOperation(() => this.installReplacement(source, destination));
  }

  private async retryWindowsFileOperation(operation: () => Promise<void>): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await operation();
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EBUSY", "EPERM", "EACCES"].includes(code ?? "") || attempt === 19) throw error;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
    throw lastError;
  }

  private isMissingFileError(error: unknown): boolean {
    return typeof error === "object" && error !== null &&
      "code" in error && (error as { code?: unknown }).code === "ENOENT";
  }
}
