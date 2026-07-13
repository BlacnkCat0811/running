import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import type { BackupDto } from "@rai/api-contracts";

export class DatabaseMaintenance {
  readonly backupDirectory: string;

  constructor(
    private readonly databasePath: string,
    projectRoot: string,
    private readonly beforeReplace: () => void | Promise<void> = () => {},
    private readonly afterReplace: () => void | Promise<void> = () => {}
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
    const database = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      await backup(database, destination);
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
    await this.beforeReplace();
    try {
      for (const candidate of [this.databasePath, `${this.databasePath}-shm`, `${this.databasePath}-wal`]) {
        await rm(candidate, { force: true });
      }
    } finally {
      await this.afterReplace();
    }
    return backupInfo;
  }

  async restoreBackup(name: string): Promise<{ restored: BackupDto; safetyBackup: BackupDto | null }> {
    if (name !== basename(name) || !name.endsWith(".sqlite")) throw new Error("备份文件名无效");
    const source = resolve(this.backupDirectory, name);
    if (!existsSync(source)) throw new Error("备份文件不存在");
    const safetyBackup = existsSync(this.databasePath) ? await this.createBackup("before-restore") : null;
    const staging = `${this.databasePath}.restoring.${randomUUID()}`;
    try {
      await mkdir(dirname(this.databasePath), { recursive: true });
      await copyFile(source, staging);
      const candidate = new DatabaseSync(staging, { readOnly: true });
      try {
        const quick = candidate.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
        if (quick?.quick_check !== "ok") throw new Error("备份数据库完整性校验失败");
        const required = candidate.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'table' AND name IN ('workouts', 'training_sessions', 'model_runs', 'active_model_run')
        `).get() as { count: number };
        if (required.count !== 4) throw new Error("备份不是有效的 RAI 数据库");
        const violations = candidate.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) throw new Error("备份数据库外键校验失败");
      } finally {
        candidate.close();
      }
      await this.beforeReplace();
      try {
        for (const current of [this.databasePath, `${this.databasePath}-shm`, `${this.databasePath}-wal`]) {
          await rm(current, { force: true });
        }
        await rename(staging, this.databasePath);
      } finally {
        await this.afterReplace();
      }
      return { restored: await this.describe(name), safetyBackup };
    } catch (error) {
      await rm(staging, { force: true });
      if (safetyBackup && !existsSync(this.databasePath)) {
        await copyFile(resolve(this.backupDirectory, safetyBackup.name), this.databasePath);
      }
      throw error;
    }
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
