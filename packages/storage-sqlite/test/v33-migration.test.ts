import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RaiDatabase, PendingMigrationsError } from "../src/database.js";

test("v33 is explicit, preserves alias facts and indexes the actual deletion-repair query", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-v33-"));
  const path = join(root, "rai.sqlite");
  try {
    (await RaiDatabase.open(path)).close();
    const previous = new DatabaseSync(path);
    previous.exec(`DROP INDEX idx_healthkit_record_aliases_source;
      DELETE FROM schema_migrations WHERE version=33;
      INSERT INTO healthkit_record_sources VALUES ('type','uuid','record');
      INSERT INTO healthkit_record_aliases VALUES ('alias','type','uuid')`);
    previous.close();
    await assert.rejects(RaiDatabase.open(path, { migrationPolicy: "refuse" }), (error: unknown) => {
      assert.ok(error instanceof PendingMigrationsError);
      assert.deepEqual(error.versions, [33]);
      return true;
    });
    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT * FROM healthkit_record_aliases").all().map(row => ({ ...row })),
        [{ alias_id: "alias", sample_type: "type", sample_uuid: "uuid" }]);
      const source = readFileSync(join(process.cwd(), "packages/storage-sqlite/src/database.ts"), "utf8");
      const repair = source.split("private removeDeletedHealthKitAliasCopies(")[1]!
        .match(/const copies = this\.database\.prepare\(`([\s\S]*?)`\)/)![1]!;
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${repair}`).all("record") as { detail: string }[];
      assert.ok(plan.some(row => row.detail.includes("idx_healthkit_record_aliases_source")), JSON.stringify(plan));
      assert.ok(!plan.some(row => /SCAN a\b/.test(row.detail)), "the real repair query must not scan every alias");
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
    (await RaiDatabase.open(path, { migrationPolicy: "refuse" })).close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
