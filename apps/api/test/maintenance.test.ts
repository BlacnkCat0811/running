import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DatabaseMaintenance } from "../src/maintenance.js";

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

test("validates and atomically restores a RAI backup while preserving the replaced database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-maintenance-"));
  const databasePath = join(root, "rai.sqlite");
  const createRaiDatabase = (value: string) => {
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE workouts (id TEXT PRIMARY KEY);
      CREATE TABLE training_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE model_runs (id TEXT PRIMARY KEY);
      CREATE TABLE active_model_run (singleton INTEGER PRIMARY KEY);
      CREATE TABLE marker (value TEXT NOT NULL);
    `);
    database.prepare("INSERT INTO marker VALUES (?)").run(value);
    database.close();
  };
  try {
    createRaiDatabase("backup-version");
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const backupInfo = await maintenance.createBackup("fixture");
    const current = new DatabaseSync(databasePath);
    current.prepare("UPDATE marker SET value = 'current-version'").run();
    current.close();
    const restored = await maintenance.restoreBackup(backupInfo.name);
    assert.equal(restored.restored.name, backupInfo.name);
    assert.ok(restored.safetyBackup);
    assert.equal(readMarker(databasePath), "backup-version");
    assert.equal(readMarker(join(maintenance.backupDirectory, restored.safetyBackup?.name ?? "")), "current-version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
