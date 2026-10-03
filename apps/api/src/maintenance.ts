import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { ClientRequestError } from "./api-error.js";
import { RestoreJournal, RestoreRecoveryRequiredError, type RestoreIntent } from "./restore-journal.js";

import type { BackupDto } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";

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
      if (!this.isReadableDatabase(this.databasePath)) {
        throw new RestoreRecoveryRequiredError("Committed restore database is unreadable");
      }
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

  async deleteDatabase(prepareDeletion: () => void = () => {}): Promise<BackupDto & { restorable?: boolean }> {
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
      prepareDeletion();
      await this.removeFileWithRetry(`${this.databasePath}-shm`);
      await this.removeFileWithRetry(`${this.databasePath}-wal`);
      await this.removeFileWithRetry(this.databasePath);
      await this.releaseReplaceGate();
      replaceGateEntered = false;
      return backupInfo;
    } catch (error) {
      const errors: unknown[] = [error];
      let originalRestored = false;
      if (!this.isReadableDatabase(this.databasePath)) {
        const restoreErrors = await this.restoreDeletedDatabase(backupPath, backupIsQuarantine);
        errors.push(...restoreErrors);
        originalRestored = restoreErrors.length === 0;
      }
      if (replaceGateEntered && (this.isReadableDatabase(this.databasePath) || (!originalReadable && originalRestored))) {
        try {
          await this.releaseReplaceGate();
          replaceGateEntered = false;
        } catch (releaseError) {
          errors.push(releaseError);
        }
      }
      throw errors.length === 1
        ? error
        : new AggregateError(errors, "Database deletion failed and required recovery actions also failed");
    }
  }

  async restoreBackup(
    name: string,
    beforeCommit: () => void | Promise<void> = () => {},
    prepareReplacement: (database: DatabaseSync) => void = () => {}
  ): Promise<{ restored: BackupDto; safetyBackup: BackupDto | null }> {
    if (name !== basename(name) || !name.endsWith(".sqlite")) throw new ClientRequestError("invalid_backup_name", "备份文件名无效", 400);
    if (this.restoreJournal.read()) throw new RestoreRecoveryRequiredError("A previous restore needs startup recovery");
    const source = resolve(this.backupDirectory, name);
    if (!existsSync(source)) throw new ClientRequestError("backup_not_found", "备份文件不存在", 404);
    let safetyBackup: BackupDto | null = null;
    let intent: RestoreIntent | null = null;
    const staging = `${this.databasePath}.restoring.${randomUUID()}`;
    const rollback = resolve(this.backupDirectory, `rai.restore-rollback.${randomUUID()}.sqlite`);
    try {
      await mkdir(dirname(this.databasePath), { recursive: true });
      await copyFile(source, staging);
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
        intent = {
          target: resolve(this.databasePath), staging: resolve(staging),
          snapshot: corruptSnapshotPath ?? (safetyBackup ? resolve(this.backupDirectory, safetyBackup.name) : null),
          snapshotIsQuarantine: corruptSnapshotPath !== null, phase: "prepared"
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
        if (originalExisted) {
          if (originalReadable) {
            const current = new DatabaseSync(this.databasePath);
            applyBusyTimeout(current);
            try {
              current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
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
        await beforeCommit();
        this.checkpointDatabase(this.databasePath);
        await this.syncFile(this.databasePath);
        await this.syncDirectory(dirname(this.databasePath));
        await this.releaseReplaceGate();
        replaceGateEntered = false;
        this.restoreJournal.write({ ...intent, phase: "committed" });
        committed = true;
      } catch (error) {
        const errors: unknown[] = [error];
        if (originalMoved) {
          errors.push(...await this.restoreOriginalDatabase(rollback));
        } else if (corruptSnapshotPath) {
          errors.push(...await this.restoreDatabaseGroup(corruptSnapshotPath, false));
        } else if (!originalExisted && existsSync(this.databasePath)) {
          try {
            await this.removeFileWithRetry(`${this.databasePath}-shm`);
            await this.removeFileWithRetry(`${this.databasePath}-wal`);
          } catch (sidecarError) {
            errors.push(sidecarError);
          }
        }
        const activeReadable = this.isReadableDatabase(this.databasePath);
        if (replaceGateEntered && (
          activeReadable ||
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
        if (errors.length === 1 && intent) this.restoreJournal.clear();
        if (this.restoreJournal.read()) {
          throw new RestoreRecoveryRequiredError("Database restore needs startup recovery", { cause: new AggregateError(errors) });
        }
        throw errors.length === 1 ? error : new AggregateError(errors, "Database restore failed and required recovery actions also failed");
      } finally {
        if (committed && originalMoved) {
          // Cleanup is post-commit. A locked rollback remains a visible, valid backup.
          await this.removeFileWithRetry(rollback).catch(() => {});
        }
      }
      this.restoreJournal.clear();
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
      }
      await this.moveFileWithRetry(stagingBase, this.databasePath);
      if (requireReadable && !this.isReadableDatabase(this.databasePath)) {
        throw new Error("Safety backup did not restore a readable active database");
      }
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
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
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
