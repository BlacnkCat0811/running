import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { FROZEN_MIGRATION_CHECKSUMS, RaiDatabase } from "../src/database.js";

async function withDatabase(run: (path: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-v47-"));
  const path = join(root, "rai.sqlite");
  try {
    const created = await RaiDatabase.open(path, { createMigrationBackup: false });
    created.database.exec(`INSERT INTO health_records
      (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
      VALUES ('v47-seed', 'heartRate', 'Watch', 'apple_watch', 'bpm', 120,
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:10.000Z', '{}', '{}')`);
    created.close();
    await run(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function indexColumns(database: DatabaseSync): string[] {
  return database.prepare("PRAGMA index_info(idx_ability_assessments_session)").all()
    .map((row) => String(row.name));
}

test("v47 creates the ability-assessment session lookup index and freezes its checksum", async () => {
  await withDatabase(async (path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const index = database.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_ability_assessments_session'"
      ).get() as { sql?: string } | undefined;
      assert.ok(index?.sql, "v47 index must exist");
      assert.deepEqual(indexColumns(database), ["training_session_id", "model_run_id"]);
      const row = database.prepare("SELECT checksum FROM schema_migrations WHERE version = 47").get() as
        { checksum?: string } | undefined;
      assert.equal(row?.checksum, FROZEN_MIGRATION_CHECKSUMS[47]);
    } finally {
      database.close();
    }
  });
});

test("v47 upgrades a real v46 schema, is idempotent and keeps existing rows", async () => {
  await withDatabase(async (path) => {
    const before = new DatabaseSync(path);
    try {
      before.exec("DROP INDEX idx_ability_assessments_session");
      before.exec("DELETE FROM schema_migrations WHERE version = 47");
    } finally {
      before.close();
    }
    const upgraded = await RaiDatabase.open(path, { createMigrationBackup: false });
    try {
      assert.ok(upgraded.database.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'idx_ability_assessments_session'"
      ).get());
      assert.equal(
        Number((upgraded.database.prepare("SELECT COUNT(*) AS count FROM health_records").get() as { count: number }).count),
        1
      );
      assert.equal(
        (upgraded.database.prepare("SELECT checksum FROM schema_migrations WHERE version = 47").get() as { checksum: string }).checksum,
        FROZEN_MIGRATION_CHECKSUMS[47]
      );
    } finally {
      upgraded.close();
    }
    // A second open must not re-run the migration or change the ledger.
    const reopened = await RaiDatabase.open(path, { createMigrationBackup: false });
    reopened.close();
  });
});

test("v47 makes the active-assessment existence probe seek instead of scanning every assessment", async () => {
  await withDatabase(async (path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const plan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT 1 FROM active_ability_assessments presence
        WHERE presence.training_session_id = 'session-1'
      `).all().map((row) => String(row.detail));
      assert.ok(
        plan.some((detail) => detail.includes("idx_ability_assessments_session") && detail.includes("training_session_id=?")),
        `expected a seek on idx_ability_assessments_session, got: ${plan.join(" | ")}`
      );
    } finally {
      database.close();
    }
  });
});
