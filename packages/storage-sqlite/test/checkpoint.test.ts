import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  runWalCheckpointTruncate,
  tryWalCheckpointTruncate,
  WalCheckpointBusyError
} from "../src/checkpoint.js";
import { RaiDatabase } from "../src/database.js";

async function withDatabase(run: (path: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-checkpoint-"));
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

function insertRecord(database: DatabaseSync, id: string): void {
  database.prepare(`INSERT INTO health_records
    (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
    VALUES (?, 'heartRate', 'Watch', 'apple_watch', 'bpm', 130,
            '2026-09-01T00:01:00.000Z', '2026-09-01T00:01:10.000Z', '{}', '{}')`).run(id);
}

test("strict TRUNCATE checkpoint reports busy while a reader pins the WAL snapshot", async () => {
  await withDatabase((path) => {
    const reader = new DatabaseSync(path);
    reader.exec("PRAGMA busy_timeout = 5000");
    reader.exec("BEGIN DEFERRED");
    reader.prepare("SELECT COUNT(*) AS count FROM health_records").get();

    const writer = new DatabaseSync(path);
    writer.exec("PRAGMA busy_timeout = 5000");
    try {
      insertRecord(writer, "while-reader-open");
      // A checkpoint cannot truncate the WAL while the old snapshot is still open.
      const relaxed = tryWalCheckpointTruncate(writer);
      assert.ok(relaxed.busy !== 0, `expected busy checkpoint, got ${JSON.stringify(relaxed)}`);
      assert.throws(() => runWalCheckpointTruncate(writer), (error: unknown) => {
        assert.ok(error instanceof WalCheckpointBusyError);
        assert.equal(error.code, "wal_checkpoint_busy");
        assert.ok(error.result.busy !== 0);
        return true;
      });
    } finally {
      writer.close();
      reader.exec("COMMIT");
      reader.close();
    }

    const after = new DatabaseSync(path);
    try {
      const result = runWalCheckpointTruncate(after);
      assert.equal(result.busy, 0);
    } finally {
      after.close();
    }
  });
});
