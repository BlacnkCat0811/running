import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { PendingMigrationsError, RaiDatabase } from "../src/database.js";
import { acquireDatabasePublicationLock } from "../src/publication-lock.js";

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
for (const mode of ["delete", "wal"]) {
  test(`refuse pending preserves ${mode} database bytes`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-policy-"));
    const path = join(root, "rai.sqlite");
    try {
      (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
      const database = new DatabaseSync(path);
      database.exec(`DELETE FROM schema_migrations WHERE version=22; PRAGMA journal_mode=${mode}`);
      database.close();
      const before = hash(path);
      await assert.rejects(RaiDatabase.open(path, { migrationPolicy: "refuse" }), (error: unknown) => {
        assert.ok(error instanceof PendingMigrationsError);
        assert.deepEqual(error.versions, [22]);
        assert.match(error.message, /data:migrate/);
        return true;
      });
      assert.equal(hash(path), before);
      // SQLite read-only WAL connections may create shared-memory sidecars;
      // refuse guarantees no schema/data writes, not absence of OS coordination files.
      assert.ok(!existsSync(join(root, "backups")));
      (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
      (await RaiDatabase.open(path, { migrationPolicy: "refuse" })).close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("refuse missing and unversioned databases never bootstraps them", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-policy-"));
  const path = join(root, "rai.sqlite");
  try {
    await assert.rejects(RaiDatabase.open(path, { migrationPolicy: "refuse" }), PendingMigrationsError);
    assert.equal(existsSync(path), false);
    new DatabaseSync(path).close();
    const before = hash(path);
    await assert.rejects(RaiDatabase.open(path, { migrationPolicy: "refuse" }), PendingMigrationsError);
    assert.equal(hash(path), before);
    assert.deepEqual(readdirSync(root), ["rai.sqlite"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuse does not repair legacy metadata or accept checksum corruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-policy-"));
  const path = join(root, "rai.sqlite");
  try {
    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE schema_migrations SET checksum=NULL WHERE version=1");
    db.close();
    const before = hash(path);
    await assert.rejects(RaiDatabase.open(path, { migrationPolicy: "refuse" }), PendingMigrationsError);
    assert.equal(hash(path), before);
    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    const corrupt = new DatabaseSync(path);
    corrupt.exec("UPDATE schema_migrations SET checksum='invalid' WHERE version=22");
    corrupt.close();
    await assert.rejects(RaiDatabase.open(path, { migrationPolicy: "refuse" }), /checksum does not match/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migration CLI dry-run, explicit apply, idempotence and publication lock", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-migrate-cli-"));
  const path = join(root, "rai.sqlite");
  const run = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", "packages/storage-sqlite/src/migrate-cli.ts", "--database", path, ...args], { encoding: "utf8" });
  try {
    const preview = run();
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).mode, "dry-run");
    assert.equal(existsSync(path), false);
    const release = acquireDatabasePublicationLock(path, "api");
    try { assert.equal(run("--apply").status, 1); } finally { release(); }
    const first = run("--apply");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).status, "migrated");
    const pending = new DatabaseSync(path);
    pending.exec("DELETE FROM schema_migrations WHERE version=22");
    pending.close();
    const upgrade = run("--apply");
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.equal(JSON.parse(upgrade.stdout).status, "migrated");
    const backups = readdirSync(join(root, "backups"));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(root, "backups", backups[0]!), { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 21);
    } finally { backup.close(); }
    const second = run("--apply");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).status, "already current");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
