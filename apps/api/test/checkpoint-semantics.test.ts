import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import { checkpointImportDatabase } from "../src/import-database-tasks.js";
import { readImportReceipt, writeImportReceipt } from "../src/import-publication.js";

async function withDatabase(run: (path: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-api-checkpoint-"));
  const path = join(root, "rai.sqlite");
  try {
    const created = await RaiDatabase.open(path, { createMigrationBackup: false });
    created.database.exec(`INSERT INTO health_records
      (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
      VALUES ('seed', 'heartRate', 'Watch', 'apple_watch', 'bpm', 120,
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:10.000Z', '{}', '{}')`);
    created.close();
    await run(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a checkpoint required before publication fails loudly when a reader pins the snapshot", async () => {
  await withDatabase((path) => {
    const reader = new DatabaseSync(path);
    reader.exec("BEGIN DEFERRED");
    reader.prepare("SELECT COUNT(*) AS count FROM health_records").get();
    const writer = new DatabaseSync(path);
    writer.exec("PRAGMA busy_timeout = 5000");
    try {
      writer.prepare(`INSERT INTO health_records
        (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
        VALUES ('pending', 'heartRate', 'Watch', 'apple_watch', 'bpm', 130,
                '2026-09-01T00:01:00.000Z', '2026-09-01T00:01:10.000Z', '{}', '{}')`).run();
    } finally {
      writer.close();
    }
    try {
      assert.throws(() => checkpointImportDatabase(path), /Import database checkpoint is busy/);
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
    checkpointImportDatabase(path);
  });
});

test("a committed receipt survives a deferred checkpoint instead of being reported as uncommitted", async () => {
  await withDatabase((path) => {
    const reader = new DatabaseSync(path);
    reader.exec("BEGIN DEFERRED");
    reader.prepare("SELECT COUNT(*) AS count FROM health_records").get();
    try {
      const summary = {
        imported: 1,
        skipped: 0,
        failed: 0,
        records: 1,
        workouts: 0,
        routes: 0,
        issues: 0
      } as never;
      // The WAL checkpoint is allowed to stay busy here; the receipt transaction
      // below is already committed and must remain observable.
      writeImportReceipt(path, "phase2-job", summary);
      assert.deepEqual(readImportReceipt(path, "phase2-job"), summary);
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
  });
});
