import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import type { BackupDto } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/health-export-parser";

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

export class DatabaseMaintenance {
  readonly backupDirectory: string;

  constructor(
    private readonly databasePath: string,
    projectRoot: string,
    private readonly beforeReplace: () => void | Promise<void> = () => {},
    private readonly afterReplace: () => void | Promise<void> = () => {},
    private readonly installReplacement: (source: string, destination: string) => Promise<void> = rename,
    private readonly removeFile: (path: string) => Promise<void> = (path) => rm(path, { force: true }),
    private readonly moveFile: (source: string, destination: string) => Promise<void> = rename
  ) {
    this.backupDirectory = resolve(projectRoot, "var/backups");
  }

  async createBackup(reason = "manual"): Promise<BackupDto> {
    if (!existsSync(this.databasePath)) throw new Error("本地 RAI 数据库不存在");
    await mkdir(this.backupDirectory, { recursive: true });
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
    return this.describe(name);
  }

  async listBackups(): Promise<BackupDto[]> {
    if (!existsSync(this.backupDirectory)) return [];
    const names = (await readdir(this.backupDirectory))
      .filter((name) => name.endsWith(".sqlite"));
    const backups = await Promise.all(names.map((name) => this.describe(name)));
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  backupStream(name: string) {
    if (name !== basename(name) || !name.endsWith(".sqlite")) throw new Error("备份文件名无效");
    const path = resolve(this.backupDirectory, name);
    if (!existsSync(path)) throw new Error("备份文件不存在");
    return createReadStream(path);
  }

  async deleteDatabase(): Promise<BackupDto> {
    const backupInfo = await this.createBackup("before-delete");
    const backupPath = resolve(this.backupDirectory, backupInfo.name);
    let replaceGateEntered = true;
    try {
      await this.beforeReplace();
    } catch (error) {
      const errors: unknown[] = [error];
      if (this.isReadableDatabase(this.databasePath)) {
        try {
          await this.releaseReplaceGate();
          replaceGateEntered = false;
        } catch (releaseError) {
          errors.push(releaseError);
        }
      }
      throw errors.length === 1
        ? error
        : new AggregateError(errors, "Database deletion gate failed and could not be released");
    }
    try {
      this.checkpointDatabase(this.databasePath);
      await this.removeFileWithRetry(`${this.databasePath}-shm`);
      await this.removeFileWithRetry(`${this.databasePath}-wal`);
      await this.removeFileWithRetry(this.databasePath);
      await this.releaseReplaceGate();
      replaceGateEntered = false;
      return backupInfo;
    } catch (error) {
      const errors: unknown[] = [error];
      if (!this.isReadableDatabase(this.databasePath)) {
        errors.push(...await this.restoreDeletedDatabase(backupPath));
      }
      if (replaceGateEntered && this.isReadableDatabase(this.databasePath)) {
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
    const safetyBackup = existsSync(this.databasePath) ? await this.createBackup("before-restore") : null;
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
      let replaceGateEntered = false;
      try {
        replaceGateEntered = true;
        await this.beforeReplace();
      } catch (error) {
        if (replaceGateEntered && this.isReadableDatabase(this.databasePath)) {
          try {
            await this.releaseReplaceGate();
          } catch (releaseError) {
            throw new AggregateError([error, releaseError], "Failed to enter and release database replacement gate");
          }
        }
        throw error;
      }
      const originalExisted = existsSync(this.databasePath);
      let originalMoved = false;
      let committed = false;
      try {
        if (originalExisted) {
          const current = new DatabaseSync(this.databasePath);
          try {
            current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } finally {
            current.close();
          }
          await this.moveFile(this.databasePath, rollback);
          originalMoved = true;
        }
        await this.removeFileWithRetry(`${this.databasePath}-shm`);
        await this.removeFileWithRetry(`${this.databasePath}-wal`);
        await this.installReplacement(staging, this.databasePath);
        await beforeCommit();
        await this.releaseReplaceGate();
        replaceGateEntered = false;
        committed = true;
      } catch (error) {
        const errors: unknown[] = [error];
        if (originalMoved) {
          errors.push(...await this.restoreOriginalDatabase(rollback));
        } else if (existsSync(this.databasePath)) {
          try {
            await this.removeFileWithRetry(`${this.databasePath}-shm`);
            await this.removeFileWithRetry(`${this.databasePath}-wal`);
          } catch (sidecarError) {
            errors.push(sidecarError);
          }
        }
        const activeReadable = this.isReadableDatabase(this.databasePath);
        if (replaceGateEntered && activeReadable) {
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
      await this.moveFile(rollback, this.databasePath);
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  private async restoreDeletedDatabase(backupPath: string): Promise<unknown[]> {
    const errors: unknown[] = [];
    const staging = `${this.databasePath}.delete-rollback.${randomUUID()}`;
    try {
      for (const candidate of [`${this.databasePath}-shm`, `${this.databasePath}-wal`, this.databasePath]) {
        await this.removeFileWithRetry(candidate);
      }
      await copyFile(backupPath, staging);
      await this.moveFile(staging, this.databasePath);
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

  private async backupDatabase(database: DatabaseSync, destination: string): Promise<void> {
    await backup(database, destination);
  }

  private checkpointDatabase(path: string): void {
    const database = new DatabaseSync(path);
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
}
