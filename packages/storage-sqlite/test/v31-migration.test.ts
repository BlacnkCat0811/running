import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalHealthRecord } from "@rai/contracts";
import { RaiDatabase, PendingMigrationsError } from "../src/database.js";
import { migrateModelV31 } from "../src/v31-migration.js";

const type = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
const a = "00000000-0000-0000-0000-00000000000a";
const b = "00000000-0000-0000-0000-00000000000b";
const xmlId = (parts: unknown[]) => `record_${createHash("sha256")
  .update("record\0").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;

test("v31 migrates v30 aliases and confirmed facts atomically without cloning an overwritten UUID", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-v31-"));
  const path = join(root, "rai.sqlite");
  let store: RaiDatabase | null = await RaiDatabase.open(path, { createMigrationBackup: false });
  const record: CanonicalHealthRecord = {
    id: "retained-canonical-id", type, sourceName: "Watch", sourceVersion: null,
    device: null, unit: "ms", numericValue: 60, textValue: null,
    startAt: "2018-01-01T00:00:00.000Z", endAt: "2018-01-01T00:00:00.000Z", createdAt: null,
    metadata: { RAIHealthKitSampleUUID: [a.toUpperCase()], HKMetadataKeySyncIdentifier: ["vendor"] }
  };
  try {
    store.observeImportEntity("record", record.id, "old-generation", record.startAt, undefined, "old-content-hash");
    store.insertRecord(record, "apple_watch", { value: "60" });
    store.flush();
    store.database.prepare("INSERT INTO healthkit_record_sources VALUES (?, ?, ?)").run(type, a, record.id);
    store.database.prepare("INSERT INTO healthkit_record_sources VALUES (?, ?, ?)").run(type, b, record.id);
    store.database.prepare("INSERT INTO import_source_tombstones(entity_kind, source_identifier) VALUES ('workout', 'old-workout')").run();
    store.database.exec(`
      DROP TABLE healthkit_record_aliases;
      DROP TABLE healthkit_record_facts;
      DELETE FROM schema_migrations WHERE version = 31;
    `);
    const before = store.database.prepare("SELECT * FROM health_records").all();
    const mappings = store.database.prepare("SELECT * FROM healthkit_record_sources").all();
    const tombstones = store.database.prepare("SELECT * FROM import_source_tombstones").all();
    store.database.exec("BEGIN");
    migrateModelV31(store.database);
    assert.deepEqual(store.database.prepare("SELECT * FROM health_records").all(), before);
    assert.deepEqual(store.database.prepare("SELECT * FROM healthkit_record_sources").all(), mappings);
    assert.deepEqual(store.database.prepare("SELECT * FROM import_source_tombstones").all(), tombstones);
    assert.deepEqual(store.database.prepare("SELECT sample_uuid, content_hash FROM healthkit_record_facts").all()
      .map((row) => [row.sample_uuid, row.content_hash]), [[a, "old-content-hash"]]);
    store.database.exec("ROLLBACK");
    assert.equal(store.database.prepare("SELECT 1 FROM sqlite_master WHERE name='healthkit_record_aliases'").get(), undefined);
    assert.equal(store.database.prepare("SELECT 1 FROM sqlite_master WHERE name='healthkit_record_facts'").get(), undefined);
    store.close();
    store = null;
    assert.deepEqual(RaiDatabase.pendingMigrations(path).map((migration) => migration.version), [31]);
    await assert.rejects(RaiDatabase.open(path, { migrationPolicy: "refuse" }), PendingMigrationsError);
    store = await RaiDatabase.open(path, { createMigrationBackup: false });
    assert.equal(store.resolveHealthKitRecordAlias(xmlId([type, "Watch", "vendor"])), record.id);
    assert.equal(store.resolveHealthKitRecordAlias(xmlId([type, "Watch", record.startAt, record.endAt, "60", "ms"])), record.id);
    assert.deepEqual(store.database.prepare("SELECT * FROM health_records").all(), before);
    assert.deepEqual(store.database.prepare("SELECT * FROM import_source_tombstones").all(), tombstones);
    store.beginAtomicImport();
    assert.throws(() => store!.removeHealthKitRecords([{ type, uuid: a }]), /补读历史/,
      "B's unknown old value must not be inferred from A's corrected 60");
    store.rollbackAtomicImport();
    assert.deepEqual(store.database.prepare("SELECT * FROM health_records").all(), before);
    assert.deepEqual(store.database.prepare("SELECT * FROM import_source_tombstones").all(), tombstones);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
