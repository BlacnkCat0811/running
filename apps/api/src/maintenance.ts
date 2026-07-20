import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

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

export class DatabaseMaintenance {
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
    this.backupDirectory = resolve(projectRoot, "var/backups");
    this.quarantineDirectory = resolve(projectRoot, "var/quarantine");
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
    if (name !== basename(name) || !name.endsWith(".sqlite")) throw new Error("备份文件名无效");
    const path = resolve(this.backupDirectory, name);
    try {
      // Opening first removes the exists/open race. On Windows the handle also
      // keeps deletion from invalidating a response already being streamed.
      const handle = await open(path, "r");
      return handle.createReadStream();
    } catch (error) {
      if (this.isMissingFileError(error)) throw new Error("备份文件不存在");
      throw error;
    }
  }

  async deleteBackup(name: string): Promise<BackupDto> {
    if (name !== basename(name) || !name.endsWith(".sqlite")) throw new Error("备份文件名无效");
    const backupInfo = await this.describe(name).catch(() => null);
    if (!backupInfo) throw new Error("备份文件不存在");
    await this.removeFileWithRetry(resolve(this.backupDirectory, name));
    return backupInfo;
  }

  async deleteDatabase(): Promise<BackupDto & { restorable?: boolean }> {
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
    beforeCommit: () => void | Promise<void> = () => {}
  ): Promise<{ restored: BackupDto; safetyBackup: BackupDto | null }> {
    if (name !== basename(name) || !name.endsWith(".sqlite")) throw new Error("备份文件名无效");
    const source = resolve(this.backupDirectory, name);
    if (!existsSync(source)) throw new Error("备份文件不存在");
    let safetyBackup: BackupDto | null = null;
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
      migratedCandidate.close();
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
            const snapshot = await this.preserveCorruptDatabase("before-restore-corrupt");
            corruptSnapshotPath = resolve(this.quarantineDirectory, snapshot.name);
            originalMutationStarted = true;
            await this.removeFileWithRetry(`${this.databasePath}-shm`);
            await this.removeFileWithRetry(`${this.databasePath}-wal`);
            await this.removeFileWithRetry(this.databasePath);
          }
        }
        await this.removeFileWithRetry(`${this.databasePath}-shm`);
        await this.removeFileWithRetry(`${this.databasePath}-wal`);
        await this.installReplacementWithRetry(staging, this.databasePath);
        await beforeCommit();
        await this.releaseReplaceGate();
        replaceGateEntered = false;
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
        throw errors.length === 1
          ? error
          : new AggregateError(errors, "Database restore failed and required recovery actions also failed");
      } finally {
        if (committed && originalMoved) {
          // Cleanup is post-commit. A locked rollback remains a visible, valid backup.
          await this.removeFileWithRetry(rollback).catch(() => {});
        }
      }
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
      for (const candidate of [`${this.databasePath}-shm`, `${this.databasePath}-wal`, this.databasePath]) {
        await this.removeFileWithRetry(candidate);
      }
      await copyFile(backupPath, staging);
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
      for (const item of staged) {
        await this.removeFileWithRetry(item.staging).catch(() => {});
        await this.removeFileWithRetry(item.published).catch(() => {});
      }
      throw error;
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
    const protectedSet = new Set(protectedNames);
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
      typeof protectedNames === "string" ? [protectedNames] : protectedNames
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
