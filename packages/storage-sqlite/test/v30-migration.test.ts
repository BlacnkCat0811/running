import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateModelV30 } from "../src/v30-migration.js";

test("v30 widens source tombstones without changing workout deletions or canonical record IDs", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE health_records(id TEXT PRIMARY KEY, value_numeric REAL);
      INSERT INTO health_records VALUES ('legacy-record-id', 42);
      CREATE TABLE import_source_tombstones(
        entity_kind TEXT NOT NULL CHECK(entity_kind='workout'), source_identifier TEXT NOT NULL,
        batch_id TEXT, deleted_at TEXT NOT NULL DEFAULT 'old', PRIMARY KEY(entity_kind, source_identifier)
      );
      INSERT INTO import_source_tombstones VALUES('workout', 'old-uuid', 'old-batch', '2020-01-01');
    `);
    const before = database.prepare("SELECT * FROM health_records").all();
    const deletions = database.prepare("SELECT * FROM import_source_tombstones").all();
    database.exec("BEGIN");
    migrateModelV30(database);
    assert.deepEqual(database.prepare("SELECT * FROM health_records").all(), before);
    assert.deepEqual(database.prepare("SELECT * FROM import_source_tombstones").all(), deletions);
    database.prepare("INSERT INTO import_source_tombstones(entity_kind, source_identifier) VALUES('record', ?)").run("record-uuid");
    database.prepare("INSERT INTO healthkit_record_sources VALUES(?, ?, ?)").run("sleep", "uuid", "legacy-record-id");
    database.exec("ROLLBACK");
    assert.deepEqual(database.prepare("SELECT * FROM health_records").all(), before);
    assert.deepEqual(database.prepare("SELECT * FROM import_source_tombstones").all(), deletions);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='healthkit_record_sources'").get(), undefined);
    assert.throws(() => database.prepare("INSERT INTO import_source_tombstones(entity_kind, source_identifier) VALUES('record', 'rejected')").run());
    migrateModelV30(database);
    assert.deepEqual(database.prepare("SELECT * FROM health_records").all(), before);
    assert.deepEqual(database.prepare("SELECT * FROM import_source_tombstones").all(), deletions);
  } finally { database.close(); }
});
