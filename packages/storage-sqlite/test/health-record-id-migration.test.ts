import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { RaiDatabase } from "../src/database.js";

/**
 * The record identity formula no longer includes `device`, so a sample Apple
 * exports once with a device attribute and once without stops counting twice.
 * New imports were folded correctly; the rows already in the table were not, so
 * they kept the old id — and every pair stayed two rows.
 *
 * Two consequences, both user visible: `COUNT(*)` (what the audit and settings
 * pages show) reads above the number of real samples, and a full re-export
 * reports every stored row as "present here, absent from the import", which the
 * removal guard refuses as a mass deletion. Deleting the duplicate is not enough
 * on its own — the survivor would still carry an id the parser can no longer
 * compute — so the migration must also realign it.
 */

const stableId = (kind: string, parts: unknown[]): string => {
  const hash = createHash("sha256");
  hash.update(kind);
  hash.update("\0");
  hash.update(JSON.stringify(parts));
  return `${kind}_${hash.digest("hex").slice(0, 32)}`;
};

const TYPE = "HKQuantityTypeIdentifierRunningSpeed";
const SOURCE = "唐攀的Apple Watch";
const UNIT = "km/hr";
const START = "2026-09-01T10:00:00.000Z";
const END = "2026-09-01T10:00:10.000Z";

const currentId = (value: string): string =>
  stableId("record", [TYPE, SOURCE, START, END, value, UNIT]);
const legacyId = (value: string, device: string | null): string =>
  stableId("record", [TYPE, SOURCE, START, END, value, UNIT, device]);

const insertRecord = (
  database: DatabaseSync,
  id: string,
  value: string,
  device: string | null,
  createdAt: string
): void => {
  const attributes: Record<string, string> = { value, unit: UNIT };
  if (device !== null) attributes.device = device;
  database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, source_version, device,
      unit, value_numeric, value_text, start_at, end_at, created_at,
      metadata_json, raw_attributes_json
    ) VALUES (?, ?, ?, 'apple_watch', NULL, ?, ?, ?, NULL, ?, ?, ?, '{}', ?)
  `).run(
    id, TYPE, SOURCE, device, UNIT, Number(value),
    START, END, createdAt, JSON.stringify(attributes)
  );
};

const insertGeneration = (database: DatabaseSync, entityId: string): void => {
  database.prepare(`
    INSERT INTO import_entity_generations (entity_kind, entity_id, generation, content_hash)
    VALUES ('record', ?, 'import-1', 'hash-1')
  `).run(entityId);
};

const makeLegacyDatabase = async (root: string): Promise<string> => {
  const path = join(root, "rai.sqlite");
  const initial = await RaiDatabase.open(path, { createMigrationBackup: false });
  initial.close();
  return path;
};

test("migration collapses duplicate records and realigns the survivor's id", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-record-id-migration-"));
  const DEVICE = "Apple Watch";
  try {
    const path = await makeLegacyDatabase(root);

    // Roll back to the pre-migration state: version 22 unapplied, one sample
    // stored twice (exported once with a device attribute, once without), both
    // rows still carrying the legacy id.
    const legacy = new DatabaseSync(path);
    legacy.exec("DELETE FROM schema_migrations WHERE version = 22");
    insertRecord(legacy, legacyId("2.7", DEVICE), "2.7", DEVICE, "2026-09-02T00:00:00.000Z");
    insertRecord(legacy, legacyId("2.7", null), "2.7", null, "2026-09-01T00:00:00.000Z");
    // An unrelated sample must come through untouched.
    insertRecord(legacy, legacyId("3.4", DEVICE), "3.4", DEVICE, "2026-09-02T00:00:00.000Z");
    insertGeneration(legacy, legacyId("2.7", DEVICE));
    insertGeneration(legacy, legacyId("2.7", null));
    insertGeneration(legacy, legacyId("3.4", DEVICE));
    legacy.close();

    const migrated = await RaiDatabase.open(path, { createMigrationBackup: false });
    try {
      const rows = migrated.database
        .prepare("SELECT id, device FROM health_records ORDER BY id")
        .all() as unknown as Array<{ id: string; device: string | null }>;
      assert.deepEqual(
        [...rows.map((row) => row.id)].sort(),
        [currentId("2.7"), currentId("3.4")].sort()
      );
      // The survivor is the row that kept its device: it carries more of what the
      // export said, and the migration has to pick deterministically.
      assert.equal(rows.find((row) => row.id === currentId("2.7"))?.device, DEVICE);

      // The dependent tables have to follow, or the next import sees an id it
      // never wrote and reports the sample as newly inserted forever.
      const generations = migrated.database
        .prepare("SELECT entity_id FROM import_entity_generations WHERE entity_kind = 'record' ORDER BY entity_id")
        .all() as unknown as Array<{ entity_id: string }>;
      assert.deepEqual(
        [...generations.map((row) => row.entity_id)].sort(),
        [currentId("2.7"), currentId("3.4")].sort()
      );
      const staged = migrated.database
        .prepare("SELECT COUNT(*) AS count FROM import_entity_generations WHERE entity_id LIKE '__realign__%'")
        .get() as unknown as { count: number };
      assert.equal(staged.count, 0);
    } finally {
      migrated.close();
    }

    // Idempotent: a second open changes nothing.
    const second = await RaiDatabase.open(path, { createMigrationBackup: false });
    try {
      const count = second.database
        .prepare("SELECT COUNT(*) AS count FROM health_records")
        .get() as unknown as { count: number };
      assert.equal(count.count, 2);
    } finally {
      second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration refuses to rewrite a row whose id it cannot account for", async () => {
  // A row matching neither the current nor the legacy formula came from a shape
  // this migration does not understand. Rewriting it would be a guess about
  // someone's health data, so the whole migration has to abort.
  const root = mkdtempSync(join(tmpdir(), "rai-record-id-migration-unknown-"));
  const DEVICE = "Apple Watch";
  try {
    const path = await makeLegacyDatabase(root);
    const legacy = new DatabaseSync(path);
    legacy.exec("DELETE FROM schema_migrations WHERE version = 22");
    insertRecord(legacy, "record_00000000000000000000000000000000", "2.7", DEVICE, "2026-09-02T00:00:00.000Z");
    legacy.close();

    await assert.rejects(
      () => RaiDatabase.open(path, { createMigrationBackup: false }),
      /match neither/
    );

    // The transaction rolled back, so the row is still there under its own id.
    const check = new DatabaseSync(path, { readOnly: true });
    const row = check
      .prepare("SELECT COUNT(*) AS count FROM health_records WHERE id = 'record_00000000000000000000000000000000'")
      .get() as unknown as { count: number };
    const applied = check
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 22")
      .get() as unknown as { count: number };
    check.close();
    assert.equal(row.count, 1);
    assert.equal(applied.count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
