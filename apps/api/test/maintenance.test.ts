import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import { DatabaseMaintenance } from "../src/maintenance.js";

interface MaintenanceTestSurface {
  backupDatabase(database: DatabaseSync, destination: string): Promise<void>;
  describe(name: string): Promise<{ name: string; sizeBytes: number; createdAt: string }>;
}

const readMarker = (path: string): string => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM marker LIMIT 1").get() as { value: string };
    return row.value;
  } finally {
    database.close();
  }
};

test("creates an online backup containing committed WAL data and lists it", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('wal-visible');");
    assert.equal(existsSync(`${databasePath}-wal`), true);
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await maintenance.createBackup();
    assert.equal(readMarker(join(maintenance.backupDirectory, backup.name)), "wal-visible");
    const listed = await maintenance.listBackups();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, backup.name);
    assert.ok((listed[0]?.sizeBytes ?? 0) > 0);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("enforces backup retention while preserving the newest snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-retention-"));
  const databasePath = join(root, "rai.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('retained');");
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCount: 2, maxTotalBytes: Number.MAX_SAFE_INTEGER, minimumFreeBytes: 1 }
    );
    await maintenance.createBackup("first");
    await maintenance.createBackup("second");
    const newest = await maintenance.createBackup("third");
    const listed = await maintenance.listBackups();
    assert.equal(listed.length, 2);
    assert.equal(listed.some((item) => item.name === newest.name), true);
    assert.equal(listed.some((item) => item.name.includes("first")), false);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves corrupt database bytes before deleting an unrecoverable database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-corrupt-delete-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const corrupt = Buffer.from("not a sqlite database");
  writeFileSync(databasePath, corrupt);
  try {
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await maintenance.deleteDatabase();
    assert.equal(existsSync(databasePath), false);
    assert.equal(backup.restorable, false);
    assert.deepEqual(readFileSync(join(maintenance.quarantineDirectory, backup.name)), corrupt);
    assert.deepEqual(await maintenance.listBackups(), []);
    assert.match(backup.name, /before-delete-corrupt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restores a corrupt database group when deletion fails after removing its sidecars", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-corrupt-delete-rollback-"));
  const databasePath = join(root, "rai.sqlite");
  const files = {
    "": Buffer.from("corrupt main"),
    "-wal": Buffer.from("recoverable wal bytes"),
    "-shm": Buffer.from("shared memory evidence")
  };
  for (const [suffix, bytes] of Object.entries(files)) writeFileSync(`${databasePath}${suffix}`, bytes);
  let mainRemovalFailures = 0;
  const gateEvents: string[] = [];
  try {
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { gateEvents.push("closed"); },
      () => { gateEvents.push("opened"); },
      undefined,
      async (path) => {
        rmSync(path, { force: true });
        if (path === databasePath && mainRemovalFailures < 4) {
          mainRemovalFailures += 1;
          throw new Error("simulated corrupt delete failure");
        }
      }
    );
    await assert.rejects(maintenance.deleteDatabase(), /simulated corrupt delete failure/);
    const snapshot = readdirSync(maintenance.quarantineDirectory)
      .find((candidate) => candidate.endsWith(".sqlite"));
    assert.ok(snapshot);
    for (const suffix of Object.keys(files)) {
      assert.deepEqual(
        readFileSync(`${databasePath}${suffix}`),
        readFileSync(join(maintenance.quarantineDirectory, `${snapshot}${suffix}`))
      );
    }
    assert.deepEqual(gateEvents, ["closed", "opened"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishes corrupt main, WAL, and SHM files as one quarantine group", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-quarantine-group-"));
  const databasePath = join(root, "rai.sqlite");
  const files = {
    "": Buffer.from("corrupt main"),
    "-wal": Buffer.from("wal evidence"),
    "-shm": Buffer.from("shm evidence")
  };
  for (const [suffix, bytes] of Object.entries(files)) writeFileSync(`${databasePath}${suffix}`, bytes);
  try {
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const snapshot = await maintenance.preserveCorruptDatabase("group");
    for (const [suffix, bytes] of Object.entries(files)) {
      assert.deepEqual(readFileSync(join(maintenance.quarantineDirectory, `${snapshot.name}${suffix}`)), bytes);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt quarantine snapshots never evict the last valid backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-quarantine-retention-"));
  const databasePath = join(root, "rai.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('valid')");
  database.close();
  try {
    const maintenance = new DatabaseMaintenance(
      databasePath, root, undefined, undefined, undefined, undefined, undefined,
      { maxCount: 1, minimumFreeBytes: 1 }
    );
    const valid = await maintenance.createBackup("valid");
    writeFileSync(databasePath, "not a sqlite database");
    await maintenance.preserveCorruptDatabase("corrupt");
    assert.deepEqual((await maintenance.listBackups()).map((item) => item.name), [valid.name]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejecting an invalid restore does not evict a valid backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-invalid-restore-retention-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath, { createMigrationBackup: false });
    store.close();
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCount: 2, maxTotalBytes: Number.MAX_SAFE_INTEGER, minimumFreeBytes: 1 }
    );
    const valid = await maintenance.createBackup("known-good");
    const invalidName = "rai.invalid.sqlite";
    writeFileSync(join(maintenance.backupDirectory, invalidName), "not a sqlite database");

    await assert.rejects(maintenance.restoreBackup(invalidName), /not a database/);

    const backups = await maintenance.listBackups();
    assert.equal(backups.some((backup) => backup.name === valid.name), true);
    assert.equal(backups.some((backup) => backup.name.includes("before-restore")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns a published backup when retention cleanup fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-retention-failure-"));
  const databasePath = join(root, "rai.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('retained');");
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      undefined,
      undefined,
      undefined,
      async () => { throw Object.assign(new Error("retention target is locked"), { code: "EBUSY" }); },
      undefined,
      { maxCount: 1, maxTotalBytes: Number.MAX_SAFE_INTEGER, minimumFreeBytes: 1 }
    );
    await maintenance.createBackup("first");
    const published = await maintenance.createBackup("second");
    assert.equal(readMarker(join(maintenance.backupDirectory, published.name)), "retained");
    assert.equal((await maintenance.listBackups()).length, 2);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity cleanup skips locked backups and removes other eligible candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-capacity-locked-"));
  const databasePath = join(root, "rai.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE marker (value TEXT)");
  database.close();
  const backupDirectory = join(root, "var", "backups");
  mkdirSync(backupDirectory, { recursive: true });
  for (const name of ["a.sqlite", "b.sqlite", "c.sqlite"]) writeFileSync(join(backupDirectory, name), name);
  utimesSync(join(backupDirectory, "a.sqlite"), new Date(1_000), new Date(1_000));
  utimesSync(join(backupDirectory, "b.sqlite"), new Date(2_000), new Date(2_000));
  utimesSync(join(backupDirectory, "c.sqlite"), new Date(3_000), new Date(3_000));
  try {
    const maintenance = new DatabaseMaintenance(
      databasePath, root, undefined, undefined, undefined,
      async (path) => {
        if (path.endsWith("a.sqlite")) throw Object.assign(new Error("locked"), { code: "EBUSY" });
        await rm(path, { force: true });
      },
      undefined,
      { maxCount: 1, minimumFreeBytes: Number.MAX_SAFE_INTEGER }
    );
    await assert.rejects(maintenance.ensureBackupCapacity(), AggregateError);
    assert.deepEqual(readdirSync(backupDirectory), ["a.sqlite"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not prune a backup selected as a restore source", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-protected-restore-"));
  const databasePath = join(root, "rai.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('protected');");
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCount: 1, maxTotalBytes: Number.MAX_SAFE_INTEGER, minimumFreeBytes: 1 }
    );
    const restoreSource = await maintenance.createBackup("restore-source");
    const safety = await maintenance.createBackup("before-restore", [restoreSource.name]);
    const names = (await maintenance.listBackups()).map((item) => item.name);
    assert.equal(names.includes(restoreSource.name), true);
    assert.equal(names.includes(safety.name), true);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deletes an explicitly selected backup and rejects insufficient disk capacity", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-capacity-"));
  const databasePath = join(root, "rai.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('capacity');");
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const created = await maintenance.createBackup("delete-me");
    assert.equal((await maintenance.deleteBackup(created.name)).name, created.name);
    assert.deepEqual(await maintenance.listBackups(), []);

    const constrained = new DatabaseMaintenance(
      databasePath,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { minimumFreeBytes: Number.MAX_SAFE_INTEGER }
    );
    await assert.rejects(constrained.createBackup(), /磁盘空间不足/);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not expose a partial backup when SQLite backup fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-failed-backup-"));
  const databasePath = join(root, "invalid.sqlite");
  writeFileSync(databasePath, "not a sqlite database");
  try {
    const maintenance = new DatabaseMaintenance(databasePath, root);
    await assert.rejects(maintenance.createBackup(), /not a database/);
    assert.deepEqual(await maintenance.listBackups(), []);
    assert.deepEqual(readdirSync(maintenance.backupDirectory), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retries transient cleanup failures without replacing the backup error", async () => {
  for (const busyFailures of [1, 3]) {
    const root = mkdtempSync(join(tmpdir(), "rai-maintenance-backup-cleanup-retry-"));
    const databasePath = join(root, "rai.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE marker (value TEXT NOT NULL)");
    database.close();
    let cleanupAttempts = 0;
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      undefined,
      undefined,
      undefined,
      async (path) => {
        cleanupAttempts += 1;
        if (cleanupAttempts <= busyFailures) {
          throw Object.assign(new Error("partial backup is busy"), { code: "EBUSY" });
        }
        await rm(path, { force: true });
      }
    );
    const backupError = new Error("injected backup failure");
    (maintenance as unknown as MaintenanceTestSurface).backupDatabase = async (_database, destination) => {
      writeFileSync(destination, "incomplete backup", "utf8");
      throw backupError;
    };
    try {
      let rejected: unknown;
      try {
        await maintenance.createBackup();
      } catch (error) {
        rejected = error;
      }
      assert.equal(rejected, backupError);
      assert.equal(cleanupAttempts, busyFailures + 1);
      assert.deepEqual(readdirSync(maintenance.backupDirectory), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("preserves the backup error when partial cleanup remains locked", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-backup-cleanup-failure-"));
  const databasePath = join(root, "rai.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE marker (value TEXT NOT NULL)");
  database.close();
  const cleanupError = Object.assign(new Error("partial backup remains locked"), { code: "EPERM" });
  let cleanupAttempts = 0;
  const maintenance = new DatabaseMaintenance(
    databasePath,
    root,
    undefined,
    undefined,
    undefined,
    async () => {
      cleanupAttempts += 1;
      throw cleanupError;
    }
  );
  const backupError = new Error("injected backup failure");
  (maintenance as unknown as MaintenanceTestSurface).backupDatabase = async (_database, destination) => {
    writeFileSync(destination, "incomplete backup", "utf8");
    throw backupError;
  };
  try {
    let rejected: unknown;
    try {
      await maintenance.createBackup();
    } catch (error) {
      rejected = error;
    }
    assert.equal(rejected, backupError);
    assert.equal((rejected as { cleanupError?: unknown }).cleanupError, cleanupError);
    assert.equal(cleanupAttempts, 4);
    assert.equal(readdirSync(maintenance.backupDirectory).length, 1);
    assert.match(readdirSync(maintenance.backupDirectory)[0] ?? "", /\.sqlite\.partial-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects backup path traversal", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-"));
  try {
    const maintenance = new DatabaseMaintenance(join(root, "rai.sqlite"), root);
    await assert.rejects(maintenance.backupStream("../rai.sqlite"), /备份文件名无效/);
    await assert.rejects(maintenance.backupStream("not-a-database.txt"), /备份文件名无效/);
    await assert.rejects(maintenance.backupStream("missing.sqlite"), /备份文件不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores a backup deleted between directory enumeration and metadata lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-list-race-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('listed')");
    database.close();
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const kept = await maintenance.createBackup("kept");
    const disappearing = await maintenance.createBackup("disappearing");
    const surface = maintenance as unknown as MaintenanceTestSurface;
    const describe = surface.describe.bind(maintenance);
    surface.describe = async (name) => {
      if (name === disappearing.name) {
        throw Object.assign(new Error("deleted during list"), { code: "ENOENT" });
      }
      return describe(name);
    };

    assert.deepEqual((await maintenance.listBackups()).map((backup) => backup.name), [kept.name]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backs up the current database before deleting SQLite files", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-"));
  const databasePath = join(root, "rai.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('before-delete');");
  database.close();
  try {
    let closedBeforeReplace = false;
    const maintenance = new DatabaseMaintenance(databasePath, root, () => {
      closedBeforeReplace = true;
    });
    const backup = await maintenance.deleteDatabase();
    assert.equal(closedBeforeReplace, true);
    assert.equal(existsSync(databasePath), false);
    assert.equal(existsSync(`${databasePath}-wal`), false);
    assert.equal(readMarker(join(maintenance.backupDirectory, backup.name)), "before-delete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not release a delete gate that beforeReplace failed to acquire", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-delete-before-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('current-version')");
    database.close();
    let releaseAttempts = 0;
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { throw new Error("simulated delete gate failure"); },
      () => { releaseAttempts += 1; }
    );
    await assert.rejects(maintenance.deleteDatabase(), /simulated delete gate failure/);
    assert.equal(releaseAttempts, 0);
    assert.equal(readMarker(databasePath), "current-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restores the safety backup when delete removes the main file and then fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-delete-rollback-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('current-version')");
    database.close();
    let mainRemovalAttempts = 0;
    const gateEvents: string[] = [];
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { gateEvents.push("closed"); },
      () => { gateEvents.push(`opened:${readMarker(databasePath)}`); },
      undefined,
      async (path) => {
        rmSync(path, { force: true });
        if (path === databasePath && mainRemovalAttempts < 4) {
          mainRemovalAttempts += 1;
          throw new Error("simulated post-delete failure");
        }
      }
    );
    await assert.rejects(maintenance.deleteDatabase(), /simulated post-delete failure/);
    assert.equal(mainRemovalAttempts, 4);
    assert.equal(readMarker(databasePath), "current-version");
    assert.deepEqual(gateEvents, ["closed", "opened:current-version"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restores the database before reporting a persistent delete gate-release failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-delete-after-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('current-version')");
    database.close();
    let releaseAttempts = 0;
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => {},
      () => {
        releaseAttempts += 1;
        if (releaseAttempts <= 4) throw new Error("simulated persistent delete release failure");
      }
    );
    await assert.rejects(
      maintenance.deleteDatabase(),
      /simulated persistent delete release failure/
    );
    assert.equal(releaseAttempts, 5);
    assert.equal(readMarker(databasePath), "current-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates and atomically restores a RAI backup while preserving the replaced database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-"));
  const databasePath = join(root, "rai.sqlite");
  const createRaiDatabase = async (value: string) => {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL)");
    store.database.prepare("INSERT INTO marker VALUES (?)").run(value);
    store.close();
  };
  try {
    await createRaiDatabase("backup-version");
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const backupInfo = await maintenance.createBackup("fixture");
    const legacyBackup = new DatabaseSync(join(maintenance.backupDirectory, backupInfo.name));
    legacyBackup.prepare("DELETE FROM schema_migrations WHERE version = 14").run();
    legacyBackup.close();
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();
    const restored = await maintenance.restoreBackup(backupInfo.name);
    assert.equal(restored.restored.name, backupInfo.name);
    assert.ok(restored.safetyBackup);
    assert.equal(readMarker(databasePath), "backup-version");
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((migrated.prepare(`
        SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 14
      `).get() as { count: number }).count, 1);
      assert.equal((migrated.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name = 'training_zone_profile_settings'
      `).get() as { count: number }).count, 1);
    } finally {
      migrated.close();
    }
    assert.equal(readMarker(join(maintenance.backupDirectory, restored.safetyBackup?.name ?? "")), "current-version");
    assert.equal(readdirSync(maintenance.backupDirectory).filter((entry) => entry.endsWith(".sqlite")).length, 2);
    assert.deepEqual(readdirSync(root).filter((entry) => entry.includes(".restoring.")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retries transient Windows file locks while publishing a restore", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-transient-publish-lock-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.close();
    const fixture = new DatabaseMaintenance(databasePath, root);
    const backup = await fixture.createBackup("transient-publish-lock");
    let moveAttempts = 0;
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      async (source, destination) => {
        if (source === databasePath && moveAttempts < 2) {
          moveAttempts += 1;
          throw Object.assign(new Error("database handle is still closing"), { code: "EBUSY" });
        }
        moveAttempts += 1;
        await rename(source, destination);
      }
    );

    await maintenance.restoreBackup(backup.name);
    assert.ok(moveAttempts >= 3);
    const active = new DatabaseSync(databasePath, { readOnly: true });
    active.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restores over a corrupt database and quarantines the original bytes when safety backup fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-corrupt-restore-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
    store.close();
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await maintenance.createBackup("corrupt-restore-fixture");
    const corruptFiles = {
      "": Buffer.from("not a sqlite database"),
      "-wal": Buffer.from("corrupt restore wal evidence"),
      "-shm": Buffer.from("corrupt restore shm evidence")
    };
    for (const [suffix, bytes] of Object.entries(corruptFiles)) writeFileSync(`${databasePath}${suffix}`, bytes);

    const restored = await maintenance.restoreBackup(backup.name);

    assert.equal(restored.safetyBackup, null);
    assert.equal(readMarker(databasePath), "backup-version");
    assert.deepEqual((await maintenance.listBackups()).map((candidate) => candidate.name), [backup.name]);
    const quarantined = readdirSync(maintenance.quarantineDirectory)
      .find((candidate) => candidate.endsWith(".sqlite"));
    assert.ok(quarantined);
    assert.deepEqual(readFileSync(join(maintenance.quarantineDirectory, quarantined)), corruptFiles[""]);
    assert.deepEqual(readFileSync(join(maintenance.quarantineDirectory, `${quarantined}-wal`)), corruptFiles["-wal"]);
    assert.ok(readFileSync(join(maintenance.quarantineDirectory, `${quarantined}-shm`)).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restores a quarantined corrupt group when restore fails before commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-corrupt-restore-rollback-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.close();
    const fixture = new DatabaseMaintenance(databasePath, root);
    const backup = await fixture.createBackup("corrupt-rollback-fixture");
    const corruptFiles = {
      "": Buffer.from("corrupt main before failed restore"),
      "-wal": Buffer.from("wal before failed restore"),
      "-shm": Buffer.from("shm before failed restore")
    };
    for (const [suffix, bytes] of Object.entries(corruptFiles)) writeFileSync(`${databasePath}${suffix}`, bytes);
    const gateEvents: string[] = [];
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { gateEvents.push("closed"); },
      () => { gateEvents.push("opened"); }
    );
    await assert.rejects(
      maintenance.restoreBackup(backup.name, () => { throw new Error("simulated corrupt pre-commit failure"); }),
      /simulated corrupt pre-commit failure/
    );
    const snapshot = readdirSync(maintenance.quarantineDirectory)
      .find((candidate) => candidate.endsWith(".sqlite"));
    assert.ok(snapshot);
    for (const suffix of Object.keys(corruptFiles)) {
      assert.deepEqual(
        readFileSync(`${databasePath}${suffix}`),
        readFileSync(join(maintenance.quarantineDirectory, `${snapshot}${suffix}`))
      );
    }
    assert.deepEqual(gateEvents, ["closed", "opened"]);
    assert.deepEqual((await maintenance.listBackups()).map((candidate) => candidate.name), [backup.name]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retries transient Windows locks while removing restored candidate sidecars", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-restore-sidecars-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("sidecar-fixture");
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();

    let lockedWalAttempts = 0;
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      undefined,
      undefined,
      undefined,
      async (path) => {
        if (path.includes(".restoring.") && path.endsWith("-wal")) {
          lockedWalAttempts += 1;
          if (lockedWalAttempts === 1) {
            throw Object.assign(new Error("restored candidate WAL is temporarily locked"), { code: "EPERM" });
          }
        }
        await rm(path, { force: true });
      }
    );
    await maintenance.restoreBackup(backup.name);
    assert.ok(lockedWalAttempts >= 2);
    assert.equal(readMarker(databasePath), "backup-version");
    assert.deepEqual(readdirSync(root).filter((entry) => entry.includes(".restoring.")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a superficially plausible four-table database before replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-invalid-restore-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const current = await RaiDatabase.open(databasePath);
    current.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('current-version')");
    current.close();
    let replacementStarted = false;
    const maintenance = new DatabaseMaintenance(databasePath, root, () => {
      replacementStarted = true;
    });
    mkdirSync(maintenance.backupDirectory, { recursive: true });
    const invalidPath = join(maintenance.backupDirectory, "invalid.sqlite");
    const invalid = new DatabaseSync(invalidPath);
    invalid.exec(`
      CREATE TABLE workouts (id TEXT PRIMARY KEY);
      CREATE TABLE training_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE model_runs (id TEXT PRIMARY KEY);
      CREATE TABLE active_model_run (singleton INTEGER PRIMARY KEY);
    `);
    invalid.close();

    await assert.rejects(maintenance.restoreBackup("invalid.sqlite"));
    assert.equal(replacementStarted, false);
    assert.equal(readMarker(databasePath), "current-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an empty migration ledger without replacing the current database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-empty-ledger-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const current = await RaiDatabase.open(databasePath);
    current.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('current-version')");
    current.close();

    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("empty-ledger-fixture");
    const invalid = new DatabaseSync(join(fixtureMaintenance.backupDirectory, backup.name));
    invalid.exec("DELETE FROM schema_migrations");
    invalid.close();

    let replacementStarted = false;
    const maintenance = new DatabaseMaintenance(databasePath, root, () => {
      replacementStarted = true;
    });

    await assert.rejects(
      maintenance.restoreBackup(backup.name),
      /备份不是有效的 RAI 数据库/
    );
    assert.equal(replacementStarted, false);
    assert.equal(readMarker(databasePath), "current-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps reads gated until the original database is restored after an install failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-rollback-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('original-version')");
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("rollback-fixture");
    const legacyBackup = new DatabaseSync(join(fixtureMaintenance.backupDirectory, backup.name));
    legacyBackup.prepare("DELETE FROM schema_migrations WHERE version = 14").run();
    legacyBackup.close();
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();

    const gateEvents: string[] = [];
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { gateEvents.push("closed"); },
      () => { gateEvents.push(`opened:${readMarker(databasePath)}`); },
      async () => { throw new Error("simulated install failure"); }
    );
    await assert.rejects(maintenance.restoreBackup(backup.name), /simulated install failure/);
    assert.deepEqual(gateEvents, ["closed", "opened:current-version"]);
    assert.equal(readMarker(databasePath), "current-version");
    assert.equal(readdirSync(maintenance.backupDirectory).filter((entry) => entry.endsWith(".sqlite")).length, 2);
    assert.deepEqual(readdirSync(root).filter((entry) => entry.includes(".restoring.")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rolls back the installed database before reopening reads when pre-commit recovery fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-recovery-rollback-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("recovery-rollback-fixture");
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();

    const gateEvents: string[] = [];
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { gateEvents.push("closed"); },
      () => { gateEvents.push(`opened:${readMarker(databasePath)}`); }
    );
    await assert.rejects(
      maintenance.restoreBackup(backup.name, () => {
        assert.equal(readMarker(databasePath), "backup-version");
        throw new Error("simulated recovery failure");
      }),
      /simulated recovery failure/
    );
    assert.deepEqual(gateEvents, ["closed", "opened:current-version"]);
    assert.equal(readMarker(databasePath), "current-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removes an unreadable replacement before restoring the original database on Windows", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-unreadable-candidate-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("unreadable-candidate-fixture");
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();

    const gateEvents: string[] = [];
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { gateEvents.push("closed"); },
      () => { gateEvents.push(`opened:${readMarker(databasePath)}`); },
      undefined,
      undefined,
      async (source, destination) => {
        if (source.includes("restore-rollback") && existsSync(destination)) {
          throw Object.assign(new Error("Windows cannot replace an existing database"), { code: "EEXIST" });
        }
        await rename(source, destination);
      }
    );
    await assert.rejects(
      maintenance.restoreBackup(backup.name, () => {
        writeFileSync(databasePath, "not a sqlite database");
        throw new Error("simulated unreadable replacement failure");
      }),
      /simulated unreadable replacement failure/
    );
    assert.equal(readMarker(databasePath), "current-version");
    assert.deepEqual(gateEvents, ["closed", "opened:current-version"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the only readable candidate active but removes its sidecars when an empty-destination restore fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-empty-rollback-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const source = await RaiDatabase.open(databasePath);
    source.close();
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await maintenance.createBackup("empty-destination-fixture");
    rmSync(databasePath, { force: true });

    await assert.rejects(
      maintenance.restoreBackup(backup.name, () => {
        writeFileSync(`${databasePath}-wal`, "stale wal");
        writeFileSync(`${databasePath}-shm`, "stale shm");
        throw new Error("simulated empty-destination recovery failure");
      }),
      /simulated empty-destination recovery failure/
    );
    assert.equal(existsSync(databasePath), true);
    assert.equal(existsSync(`${databasePath}-wal`), false);
    assert.equal(existsSync(`${databasePath}-shm`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commits and retains a visible backup when the rollback file cannot be removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-rollback-delete-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("rollback-delete-fixture");
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();

    let rollbackRemovalAttempts = 0;
    const gateEvents: string[] = [];
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { gateEvents.push("closed"); },
      () => { gateEvents.push(`opened:${readMarker(databasePath)}`); },
      undefined,
      async (path) => {
        if (path.includes("restore-rollback")) {
          rollbackRemovalAttempts += 1;
          throw new Error("simulated rollback delete failure");
        }
        rmSync(path, { force: true });
      }
    );
    await maintenance.restoreBackup(backup.name);
    assert.equal(rollbackRemovalAttempts, 4);
    assert.deepEqual(gateEvents, ["closed", "opened:backup-version"]);
    assert.equal(readMarker(databasePath), "backup-version");
    const retained = (await maintenance.listBackups()).find((item) => item.name.includes("restore-rollback"));
    assert.ok(retained);
    assert.equal(readMarker(join(maintenance.backupDirectory, retained.name)), "current-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not release a replacement gate that beforeReplace failed to acquire", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-before-gate-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("before-gate-fixture");
    let releaseAttempts = 0;
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { throw new Error("simulated beforeReplace failure"); },
      () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("simulated transient gate release failure");
      }
    );
    await assert.rejects(maintenance.restoreBackup(backup.name), /simulated beforeReplace failure/);
    assert.equal(releaseAttempts, 0);
    assert.equal(existsSync(databasePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves a persistent beforeReplace failure without releasing another owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-persistent-before-gate-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("persistent-before-gate-fixture");
    let releaseAttempts = 0;
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { throw new Error("persistent beforeReplace failure"); },
      () => {
        releaseAttempts += 1;
        throw new Error("persistent gate release failure");
      }
    );
    await assert.rejects(maintenance.restoreBackup(backup.name), /persistent beforeReplace failure/);
    assert.equal(releaseAttempts, 0);
    assert.equal(existsSync(databasePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retries afterReplace without turning a committed restore into a failed response", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-after-gate-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("after-gate-fixture");
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();

    let releaseAttempts = 0;
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => {},
      () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("simulated transient gate release failure");
      }
    );
    await maintenance.restoreBackup(backup.name);
    assert.equal(releaseAttempts, 2);
    assert.equal(readMarker(databasePath), "backup-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restores the original database before reporting a persistent afterReplace failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-persistent-after-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("persistent-after-fixture");
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();

    let releaseAttempts = 0;
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => {},
      () => {
        releaseAttempts += 1;
        throw new Error("persistent afterReplace failure");
      }
    );
    await assert.rejects(
      maintenance.restoreBackup(backup.name),
      (error: unknown) => error instanceof AggregateError &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "persistent afterReplace failure")
    );
    assert.equal(releaseAttempts, 8);
    assert.equal(readMarker(databasePath), "current-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the candidate active when moving the original rollback back fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-rollback-rename-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("rollback-rename-fixture");
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();

    const gateEvents: string[] = [];
    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => { gateEvents.push("closed"); },
      () => { gateEvents.push(`opened:${readMarker(databasePath)}`); },
      undefined,
      undefined,
      async (source, destination) => {
        if (source.includes("restore-rollback") && destination === databasePath) {
          throw new Error("simulated rollback rename failure");
        }
        await rename(source, destination);
      }
    );
    await assert.rejects(
      maintenance.restoreBackup(backup.name, () => { throw new Error("simulated recovery failure"); }),
      (error: unknown) => error instanceof AggregateError &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "simulated recovery failure") &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "simulated rollback rename failure")
    );
    assert.equal(readMarker(databasePath), "backup-version");
    assert.deepEqual(gateEvents, ["closed", "opened:backup-version"]);
    const retained = (await maintenance.listBackups()).find((item) => item.name.includes("restore-rollback"));
    assert.ok(retained);
    assert.equal(readMarker(join(maintenance.backupDirectory, retained.name)), "current-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a genuinely locked rollback as a visible backup after commit", {
  // 只有 Windows 会真的锁住一个被打开的库文件：POSIX 下 rename 一个仍被打开的
  // 文件是合法的，于是"回滚重命名失败"这个分支根本无法在本机复现。这不是环境
  // 噪音，而是被测行为本身不可用——所以写明理由而不是留一个裸布尔值。
  skip: process.platform !== "win32"
    ? "Windows-only: POSIX can rename an open database, so the locked-rollback path cannot be reproduced here"
    : false
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-locked-rollback-"));
  const databasePath = join(root, "rai.sqlite");
  let rollbackLock: DatabaseSync | null = null;
  try {
    const store = await RaiDatabase.open(databasePath);
    store.database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('backup-version')");
    store.close();
    const fixtureMaintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await fixtureMaintenance.createBackup("locked-rollback-fixture");
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();

    const maintenance = new DatabaseMaintenance(
      databasePath,
      root,
      () => {},
      () => {},
      undefined,
      async (path) => {
        if (path.includes("restore-rollback") && rollbackLock === null) {
          rollbackLock = new DatabaseSync(path, { readOnly: true });
        }
        await rm(path, { force: true });
      }
    );
    await maintenance.restoreBackup(backup.name);
    assert.equal(readMarker(databasePath), "backup-version");
    const retained = (await maintenance.listBackups()).find((item) => item.name.includes("restore-rollback"));
    assert.ok(retained);
    assert.equal(readMarker(join(maintenance.backupDirectory, retained.name)), "current-version");
  } finally {
    (rollbackLock as DatabaseSync | null)?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("reclaims leftover database copies past the window while keeping in-flight ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-displaced-"));
  const variableDirectory = join(root, "var");
  const databasePath = join(variableDirectory, "rai.sqlite");
  mkdirSync(variableDirectory);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('active');");
  } finally {
    database.close();
  }
  const staleName = "rai.sqlite.replaced.11111111-1111-4111-8111-111111111111";
  const freshName = "rai.sqlite.replaced.22222222-2222-4222-8222-222222222222";
  // The two staging names a killed import leaves behind: the CLI's, suffixed with a
  // uuid, and the worker's, which starts with `rai.` and still ends in `.sqlite`.
  // They share no suffix, so a pattern tightened to fit either one would silently
  // stop reclaiming the other.
  const staleCliStaging = "rai.sqlite.importing.55555555-5555-4555-8555-555555555555";
  const staleWorkerStaging = "rai.importing.66666666-6666-4666-8666-666666666666.sqlite";
  const freshStaging = "rai.sqlite.importing.77777777-7777-4777-8777-777777777777";
  const staleBody = "stale rollback point";
  const staleCliBody = "stale cli staging copy";
  const staleWorkerBody = "stale worker staging copy";
  const stalePath = join(variableDirectory, staleName);
  const staleCliPath = join(variableDirectory, staleCliStaging);
  const staleWorkerPath = join(variableDirectory, staleWorkerStaging);
  writeFileSync(stalePath, staleBody);
  writeFileSync(staleCliPath, staleCliBody);
  writeFileSync(staleWorkerPath, staleWorkerBody);
  writeFileSync(join(variableDirectory, freshName), "fresh rollback point");
  writeFileSync(join(variableDirectory, freshStaging), "in-flight staging copy");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(stalePath, twoDaysAgo, twoDaysAgo);
  utimesSync(staleCliPath, twoDaysAgo, twoDaysAgo);
  utimesSync(staleWorkerPath, twoDaysAgo, twoDaysAgo);

  try {
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const result = await maintenance.reclaimDisplacedDatabases();

    assert.equal(result.removed, 3);
    assert.equal(result.reclaimedBytes, staleBody.length + staleCliBody.length + staleWorkerBody.length);
    assert.equal(existsSync(stalePath), false);
    assert.equal(existsSync(staleCliPath), false);
    assert.equal(existsSync(staleWorkerPath), false);
    // A publication or an import that is still in flight must be able to roll back.
    assert.equal(existsSync(join(variableDirectory, freshName)), true);
    assert.equal(existsSync(join(variableDirectory, freshStaging)), true);
    assert.equal(existsSync(databasePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reclaims displaced rollback points during backup capacity preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-displaced-capacity-"));
  const variableDirectory = join(root, "var");
  const databasePath = join(variableDirectory, "rai.sqlite");
  mkdirSync(variableDirectory);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('active');");
  } finally {
    database.close();
  }
  const displaced = join(variableDirectory, "rai.sqlite.replaced.33333333-3333-4333-8333-333333333333");
  writeFileSync(displaced, "left behind by a killed publisher");
  const yesterday = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(displaced, yesterday, yesterday);

  try {
    const maintenance = new DatabaseMaintenance(databasePath, root);
    await maintenance.ensureBackupCapacity();
    assert.equal(existsSync(displaced), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaves unrelated files, directories and malformed names alone when reclaiming", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-displaced-scope-"));
  const variableDirectory = join(root, "var");
  const databasePath = join(variableDirectory, "rai.sqlite");
  mkdirSync(variableDirectory);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('active');");
  } finally {
    database.close();
  }
  // Shares the prefix but is not a rename-aside rollback point.
  const malformed = join(variableDirectory, "rai.sqlite.replaced.not-a-uuid");
  // A staging name with nothing after `importing.` is not a staging file either.
  const truncatedStaging = join(variableDirectory, "rai.sqlite.importing");
  // Same shape as a rollback point but a directory: reclamation must not recurse into it.
  const displacedDirectory = join(variableDirectory, "rai.sqlite.replaced.44444444-4444-4444-8444-444444444444");
  // Same, for the staging shape.
  const stagingDirectory = join(variableDirectory, "rai.sqlite.importing.88888888-8888-4888-8888-888888888888");
  const unrelated = join(variableDirectory, "data-audit.something.md");
  writeFileSync(malformed, "malformed");
  writeFileSync(truncatedStaging, "malformed staging");
  mkdirSync(displacedDirectory);
  mkdirSync(stagingDirectory);
  writeFileSync(unrelated, "unrelated");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(malformed, twoDaysAgo, twoDaysAgo);
  utimesSync(truncatedStaging, twoDaysAgo, twoDaysAgo);
  utimesSync(displacedDirectory, twoDaysAgo, twoDaysAgo);
  utimesSync(stagingDirectory, twoDaysAgo, twoDaysAgo);

  try {
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const result = await maintenance.reclaimDisplacedDatabases();

    assert.equal(result.removed, 0);
    assert.equal(existsSync(malformed), true);
    assert.equal(existsSync(truncatedStaging), true);
    assert.equal(existsSync(displacedDirectory), true);
    assert.equal(existsSync(stagingDirectory), true);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(databasePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
