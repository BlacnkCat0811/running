import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "@rai/health-export-parser";

import { DatabaseMaintenance } from "../src/maintenance.js";

interface MaintenanceTestSurface {
  backupDatabase(database: DatabaseSync, destination: string): Promise<void>;
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

test("rejects backup path traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-"));
  try {
    const maintenance = new DatabaseMaintenance(join(root, "rai.sqlite"), root);
    assert.throws(() => maintenance.backupStream("../rai.sqlite"), /备份文件名无效/);
    assert.throws(() => maintenance.backupStream("not-a-database.txt"), /备份文件名无效/);
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

test("releases the delete gate when beforeReplace fails", async () => {
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
    assert.equal(releaseAttempts, 1);
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

test("releases the replacement gate when beforeReplace fails after partially entering", async () => {
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
    assert.equal(releaseAttempts, 2);
    assert.equal(existsSync(databasePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves both persistent beforeReplace and gate-release failures", async () => {
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
    await assert.rejects(
      maintenance.restoreBackup(backup.name),
      (error: unknown) => error instanceof AggregateError &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "persistent beforeReplace failure") &&
        error.errors.some((cause) => cause instanceof Error && cause.message === "persistent gate release failure")
    );
    assert.equal(releaseAttempts, 4);
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
  skip: process.platform !== "win32"
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
