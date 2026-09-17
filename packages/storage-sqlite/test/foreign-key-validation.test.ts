import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "../src/database.js";

function insertForeignKeyViolation(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare(`
      INSERT INTO workout_statistics (workout_id, ordinal, type)
      VALUES ('missing-workout', 1, 'fixture')
    `).run();
  } finally {
    database.close();
  }
}

test("foreign key validation stays strict by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-fk-default-"));
  const path = join(root, "rai.sqlite");
  try {
    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    insertForeignKeyViolation(path);
    await assert.rejects(
      RaiDatabase.open(path, { createMigrationBackup: false }),
      /foreign key validation failed/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("after-migration validation skips the full scan on a current schema but keeps write constraints", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-fk-hot-open-"));
  const path = join(root, "rai.sqlite");
  try {
    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    insertForeignKeyViolation(path);
    const hot = await RaiDatabase.open(path, {
      createMigrationBackup: false,
      foreignKeyValidation: "after-migration"
    });
    try {
      assert.throws(
        () => hot.database.prepare(`
          INSERT INTO workout_statistics (workout_id, ordinal, type)
          VALUES ('another-missing-workout', 1, 'fixture')
        `).run(),
        /FOREIGN KEY constraint failed/
      );
    } finally {
      hot.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("after-migration validation still checks when an actual migration is pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-fk-pending-migration-"));
  const path = join(root, "rai.sqlite");
  try {
    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    insertForeignKeyViolation(path);
    const database = new DatabaseSync(path);
    try {
      // Migration 11 is intentionally reserved/no-op. Removing its ledger row
      // creates a safe, real pending migration without mutating user data.
      database.prepare("DELETE FROM schema_migrations WHERE version = 11").run();
    } finally {
      database.close();
    }
    await assert.rejects(
      RaiDatabase.open(path, {
        createMigrationBackup: false,
        foreignKeyValidation: "after-migration"
      }),
      /foreign key validation failed/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
