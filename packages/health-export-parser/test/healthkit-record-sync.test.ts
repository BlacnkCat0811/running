import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { RaiDatabase } from "../src/database.js";
import { nativeBinary } from "../src/native-worker.js";
import { readHealthSyncManifest } from "../src/sync-manifest.js";
import { stableId } from "../src/utils.js";

const hrv = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
const sleep = "HKCategoryTypeIdentifierSleepAnalysis";
const a = "00000000-0000-0000-0000-00000000000a";
const b = "00000000-0000-0000-0000-00000000000b";
const at = "2020-01-01 00:00:00 +0000";
function record(uuid?: string, value = "42", type = hrv, syncId?: string, date = at): string {
  return `<Record type="${type}" sourceName="Watch" unit="${type === sleep ? "" : "ms"}"
    startDate="${date}" endDate="${date}" value="${value}">
    ${uuid ? `<MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/>` : ""}
    ${syncId ? `<MetadataEntry key="HKMetadataKeySyncIdentifier" value="${syncId}"/>` : ""}
  </Record>`;
}
async function fixture(run: (store: RaiDatabase, root: string,
  load: (rows: string, batch: string, deletions?: { type: string; uuid: string }[], v2?: boolean) =>
    ReturnType<typeof parseAppleHealthXml>) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-hk-record-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  const path = join(root, "export.xml");
  const load = (rows: string, batch: string, deletions: { type: string; uuid: string }[] = [], v2 = true) => {
    store.database.prepare("INSERT OR IGNORE INTO import_batches(id, xml_sha256, status, import_mode) VALUES (?, 'test', 'running', 'incremental')").run(batch);
    writeFileSync(path, `<HealthData>${rows}</HealthData>`);
    return parseAppleHealthXml(path, store, {
      fileSize: statSync(path).size, healthKitRecordIdentity: v2, deletedRecords: deletions,
      incremental: { generation: batch, batchId: batch, preserveAbsent: true }
    });
  };
  try { await run(store, root, load); }
  finally { store.close(); rmSync(root, { force: true, recursive: true }); }
}
function facts(store: RaiDatabase) {
  return store.database.prepare("SELECT id, type, value_numeric, start_at FROM health_records ORDER BY id").all();
}

test("v2 attaches UUIDs without rewriting legacy IDs, then corrects the mapped record in place", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(), "legacy", [], false);
    const oldId = facts(store)[0]!.id;
    await load(record(a, "42", hrv, "vendor-sync"), "bootstrap");
    assert.equal(facts(store).length, 1);
    assert.equal(facts(store)[0]!.id, oldId);
    await load(record(a, "55", hrv, "vendor-sync", "2018-01-01 00:00:00 +0000"), "correction");
    assert.equal(facts(store).length, 1);
    assert.equal(facts(store)[0]!.id, oldId);
    assert.equal(facts(store)[0]!.value_numeric, 55);
    assert.equal(facts(store)[0]!.start_at, "2018-01-01T00:00:00.000Z");
    assert.equal(store.database.prepare(`
      SELECT change_type FROM import_entity_changes WHERE batch_id='correction' AND entity_kind='record'
    `).get()!.change_type, "updated");
  });
});

test("ordinary XML uses the upgraded sync-identifier alias and cannot leave a deletion survivor", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(), "legacy", [], false);
    const id = facts(store)[0]!.id;
    await load(record(a, "42", hrv, "vendor"), "upgrade");
    await load(record(undefined, "42", hrv, "vendor"), "ordinary-xml", [], false);
    assert.equal(facts(store).length, 1, "the original sync identifier must resolve to the legacy canonical row");
    assert.equal(facts(store)[0]!.id, id);
    assert.equal((await load("", "delete", [{ type: hrv, uuid: a }])).removedRecordCount, 1);
    for (const [batch, rows] of [
      ["legacy-replay", record()],
      ["sync-id-replay", record(undefined, "42", hrv, "vendor")]
    ]) {
      assert.equal((await load(rows!, batch!, [], false)).tombstonedCount, 1);
      assert.equal(facts(store).length, 0, "neither XML identity may resurrect the deleted UUID");
    }
  });
});

test("UUID deletion also closes a known untracked XML fork left by a previous v30 import", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(), "legacy", [], false);
    await load(record(a, "42", hrv, "vendor"), "upgrade");
    const id = String(facts(store)[0]!.id);
    const fork = stableId("record", [hrv, "Watch", "vendor"]);
    store.observeImportEntity("record", fork, "old-v30-fork", "2020-01-01T00:00:00.000Z");
    store.database.prepare(`
      INSERT INTO health_records
      SELECT ?, type, source_name, source_category, source_version, device, unit,
        value_numeric, value_text, start_at, end_at, created_at,
        json_remove(metadata_json, '$.RAIHealthKitSampleUUID'), raw_attributes_json
      FROM health_records WHERE id = ?
    `).run(fork, id);
    store.flush();
    assert.equal(facts(store).length, 2);
    assert.equal((await load("", "delete", [{ type: hrv, uuid: a }])).removedRecordCount, 2);
    assert.equal(facts(store).length, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM import_entity_changes WHERE batch_id='delete' AND change_type='removed'").get()!.n, 2);
    await load(record() + record(undefined, "42", hrv, "vendor"), "ordinary-replay", [], false);
    assert.equal(facts(store).length, 0);
  });
});

test("old and corrected XML identities remain aliases of the same UUID after a date/value correction", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a), "first");
    const id = facts(store)[0]!.id;
    const correctedDate = "2018-01-01 00:00:00 +0000";
    await load(record(a, "60", hrv, undefined, correctedDate), "correct");
    await load(record(undefined, "60", hrv, undefined, correctedDate), "corrected-xml", [], false);
    assert.equal(facts(store).length, 1);
    assert.equal(facts(store)[0]!.id, id);
    await load("", "delete", [{ type: hrv, uuid: a }]);
    await load(record() + record(undefined, "60", hrv, undefined, correctedDate), "xml-replay", [], false);
    assert.equal(facts(store).length, 0);
  });
});

test("distinct original sync identifiers keep separate canonical identities despite equal legacy fields", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a, "42", hrv, "vendor-a") + record(b, "42", hrv, "vendor-b"), "first");
    assert.equal(facts(store).length, 2);
    await load("", "delete-a", [{ type: hrv, uuid: a }]);
    await load(record(undefined, "42", hrv, "vendor-c"), "unrelated-xml", [], false);
    assert.equal(facts(store).length, 2, "an unknown vendor identifier must not inherit A's deletion by equal value");
  });
});

test("a live alias under another vendor identity cannot revive a deleted source's value", async () => {
  await fixture(async (store, _root, load) => {
    const c = "00000000-0000-0000-0000-00000000000c";
    await load(record(a, "42", hrv, "vendor-a") + record(b, "42", hrv, "vendor-b"), "first");
    await load(record(c, "60", hrv, "vendor-a"), "replace-a", [{ type: hrv, uuid: a }]);
    assert.equal((await load(record(undefined, "42", hrv, "vendor-a"), "deleted-xml", [], false)).tombstonedCount, 1);
    assert.deepEqual(facts(store).map((row) => row.value_numeric).sort(), [42, 60]);
  });
});

test("an unambiguous ordinary XML correction refreshes the source fact restored after a replacement deletion", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a, "42", hrv, "vendor"), "first");
    await load(record(undefined, "60", hrv, "vendor"), "xml-correction", [], false);
    await load(record(b, "70", hrv, "vendor"), "share");
    await load("", "delete-b", [{ type: hrv, uuid: b }]);
    assert.equal(facts(store)[0]!.value_numeric, 60, "A's accepted XML correction is not lost behind B's later write");
  });
});

test("historical arrivals, typed sleep/quantity deletions and legacy XML replays form a closed loop", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a), "historical");
    await load(record(a, "HKCategoryValueSleepAnalysisAsleepDeep", sleep), "sleep");
    assert.equal(facts(store).length, 2);
    const result = await load("", "delete", [{ type: hrv, uuid: a.toUpperCase() }]);
    assert.equal(result.removedRecordCount, 1);
    assert.deepEqual(facts(store).map((row) => row.type), [sleep], "UUID deletion is scoped by sample type");
    assert.equal(store.database.prepare(`
      SELECT change_type, effective_at FROM import_entity_changes WHERE batch_id='delete'
    `).get()!.effective_at, "2020-01-01T00:00:00.000Z", "deletion dirties the historical event, not upload time");
    const replay = await load(record(a), "old-v2");
    assert.equal(replay.tombstonedCount, 1);
    await load(record(), "old-xml", [], false);
    assert.equal(facts(store).length, 1);
    assert.equal((await load("", "repeat-delete", [{ type: hrv, uuid: a }])).removedRecordCount, 0);
    assert.equal((await load("", "delete-sleep", [{ type: sleep, uuid: a }])).removedRecordCount, 1);
    assert.equal(facts(store).length, 0);
  });
});

test("deletion before arrival is durable but never deletes unrelated records sharing a value", async () => {
  await fixture(async (store, _root, load) => {
    await load("", "early-delete", [{ type: hrv, uuid: a }]);
    assert.equal((await load(record(a), "late-old")).tombstonedCount, 1);
    assert.equal(facts(store).length, 0);
    await load(record(), "legacy-after-resolved-delete", [], false);
    assert.equal(facts(store).length, 0, "once resolved, the source deletion protects the old XML identity too");
    await load(record(b), "live");
    assert.equal(facts(store).length, 1);
    await load("", "delete-unknown-again", [{ type: hrv, uuid: a }]);
    assert.equal(facts(store).length, 1);
  });
});

test("delete + replace with the same original sync ID keeps only the new value", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a, "42", hrv, "vendor"), "first");
    const id = facts(store)[0]!.id;
    const replacement = await load(record(b, "60", hrv, "vendor") + record(a, "42", hrv, "vendor"),
      "replace", [{ type: hrv, uuid: a }]);
    assert.equal(replacement.tombstonedCount, 1, "a carried old UUID cannot overwrite the new value later in XML order");
    assert.equal(replacement.removedRecordCount, 0, "a live replacement owns the shared canonical ID");
    assert.equal(facts(store).length, 1);
    assert.equal(facts(store)[0]!.id, id);
    assert.equal(facts(store)[0]!.value_numeric, 60);
    assert.equal((await load(record(a, "42", hrv, "vendor"), "replay")).tombstonedCount, 1);
    assert.equal(facts(store)[0]!.value_numeric, 60);
  });
});

test("replacement in a later batch may reuse a deleted sync identity but not revive its old UUID", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a, "42", hrv, "vendor"), "first");
    const id = facts(store)[0]!.id;
    await load("", "delete", [{ type: hrv, uuid: a }]);
    await load(record(b, "60", hrv, "vendor"), "replace");
    assert.equal(facts(store)[0]!.id, id);
    assert.equal((await load(record(a, "42", hrv, "vendor"), "replay")).tombstonedCount, 1);
    assert.equal(facts(store)[0]!.value_numeric, 60);
  });
});

test("shared legacy IDs are deleted only after all mapped samples are explicitly deleted", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a) + record(b), "bootstrap");
    assert.equal(facts(store).length, 1, "the existing XML identity formula is unchanged");
    await load("", "delete-a", [{ type: hrv, uuid: a }]);
    assert.equal(facts(store).length, 1);
    await load("", "empty-denied-type");
    assert.equal(facts(store).length, 1, "absence and permission loss must not delete");
    await load("", "delete-b", [{ type: hrv, uuid: b }]);
    assert.equal(facts(store).length, 0);
  });
});

test("deleting a corrected shared source restores the surviving UUID's facts and records an update", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a) + record(b), "bootstrap");
    const id = facts(store)[0]!.id;
    const correctedDate = "2018-01-01 00:00:00 +0000";
    await load(record(a, "60", hrv, undefined, correctedDate), "correct-a");
    const result = await load("", "delete-a", [{ type: hrv, uuid: a }]);
    assert.equal(result.removedRecordCount, 0, "B still owns the canonical record");
    assert.deepEqual(facts(store).map((row) => [row.id, row.value_numeric, row.start_at]),
      [[id, 42, "2020-01-01T00:00:00.000Z"]]);
    assert.equal(JSON.parse(String(store.database.prepare("SELECT metadata_json FROM health_records").get()!.metadata_json))
      .RAIHealthKitSampleUUID[0], b);
    assert.equal(store.database.prepare(`
      SELECT change_type FROM import_entity_changes WHERE batch_id='delete-a' AND entity_kind='record'
    `).get()!.change_type, "updated", "restoring a survivor must activate the existing recompute gate");
    await load("", "repeat-delete-a", [{ type: hrv, uuid: a }]);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM import_entity_changes WHERE batch_id='repeat-delete-a'").get()!.n, 0);
    assert.equal((await load(record(a, "60", hrv, undefined, correctedDate), "deleted-v2-replay")).tombstonedCount, 1);
    assert.equal((await load(record(undefined, "60", hrv, undefined, correctedDate), "deleted-xml-replay", [], false))
      .tombstonedCount, 1, "an alias belonging only to deleted A must not overwrite live B");
    assert.equal(facts(store)[0]!.value_numeric, 42);
    assert.equal((await load("", "delete-b", [{ type: hrv, uuid: b }])).removedRecordCount, 1);
    assert.equal(facts(store).length, 0);
  });
});

test("deleting a non-owning shared UUID leaves the current live fact and change ledger alone", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a, "42", hrv, "vendor") + record(b, "60", hrv, "vendor"), "bootstrap");
    await load("", "delete-a", [{ type: hrv, uuid: a }]);
    assert.equal(facts(store)[0]!.value_numeric, 60);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM import_entity_changes WHERE batch_id='delete-a'").get()!.n, 0);
  });
});

test("a replacement UUID does not acquire the retained canonical ID's deleted value as an XML alias", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(), "legacy", [], false);
    await load(record(a, "42", hrv, "vendor"), "upgrade");
    const id = facts(store)[0]!.id;
    await load(record(b, "60", hrv, "vendor"), "replace", [{ type: hrv, uuid: a }]);
    assert.equal(facts(store)[0]!.id, id);
    assert.equal((await load(record(), "legacy-deleted-replay", [], false)).tombstonedCount, 1);
    assert.equal((await load(record(undefined, "42", hrv, "vendor"), "vendor-deleted-replay", [], false)).tombstonedCount, 1);
    assert.equal(facts(store)[0]!.value_numeric, 60);
  });
});

test("a rejected shared-source restoration rolls back source deletions and facts together", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a) + record(b), "bootstrap");
    await load(record(a, "60"), "correct-a");
    store.database.exec("CREATE TRIGGER refuse_restore BEFORE UPDATE ON health_records BEGIN SELECT RAISE(ABORT, 'restore fixture'); END");
    await assert.rejects(load("", "failed-delete-a", [{ type: hrv, uuid: a }]), /restore fixture/);
    assert.equal(facts(store)[0]!.value_numeric, 60);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM import_source_tombstones").get()!.n, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM import_entity_changes WHERE batch_id='failed-delete-a'").get()!.n, 0);
    store.database.exec("DROP TRIGGER refuse_restore");
    await load("", "retry-delete-a", [{ type: hrv, uuid: a }]);
    assert.equal(facts(store)[0]!.value_numeric, 42);
  });
});

test("record deletions, tombstones, mappings and changes roll back with a failed atomic import", async () => {
  await fixture(async (store, _root, load) => {
    await load(record(a), "first");
    store.database.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON health_records BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    await assert.rejects(load(record(b, "60"), "failure", [{ type: hrv, uuid: a }]), /fixture/);
    assert.equal(facts(store).length, 1);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM import_source_tombstones").get()!.n, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM healthkit_record_sources").get()!.n, 1);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM healthkit_record_facts").get()!.n, 1);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM healthkit_record_aliases").get()!.n, 1);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM import_entity_changes WHERE batch_id='failure'").get()!.n, 0);
    store.database.exec("DROP TRIGGER refuse_delete");
    assert.equal((await load("", "retry", [{ type: hrv, uuid: a }])).removedRecordCount, 1);
  });
});

test("v2 records require source UUIDs instead of silently importing an untrackable row", async () => {
  await fixture(async (store, _root, load) => {
    await assert.rejects(load(record(a) + record(), "invalid"), /UUID/);
    assert.equal(facts(store).length, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM healthkit_record_sources").get()!.n, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM healthkit_record_facts").get()!.n, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM healthkit_record_aliases").get()!.n, 0);
  });
});

test("manifest v2 parses typed deletions while v1/XML stay compatible; unsupported/malformed v2 fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-hk-manifest-"));
  const path = join(root, "sync-manifest.json");
  try {
    assert.equal(readHealthSyncManifest(root).recordIdentity, false);
    writeFileSync(path, JSON.stringify({ version: 1, deletedSourceIds: ["old-workout"] }));
    assert.deepEqual(readHealthSyncManifest(root).deletedWorkoutIds, ["old-workout"]);
    writeFileSync(path, JSON.stringify({ version: 2, sourceScope: "healthkit",
      deletedSourceIds: ["workout"], deletedRecords: [{ type: hrv, uuid: a.toUpperCase() }] }));
    assert.deepEqual(readHealthSyncManifest(root), {
      deletedWorkoutIds: ["workout"], deletedRecords: [{ type: hrv, uuid: a }], recordIdentity: true
    });
    for (const value of [{ version: 3 }, { version: 2, sourceScope: "healthkit", deletedRecords: [{}] },
      { version: 2, sourceScope: "apple-health-full-snapshot", deletedRecords: [] }]) {
      writeFileSync(path, JSON.stringify(value));
      assert.throws(() => readHealthSyncManifest(root));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust XML parsing uses the same v2 UUID mapping/deletion contract", { skip: !existsSync(nativeBinary()) }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-hk-native-"));
  const path = join(root, "export.xml");
  const database = join(root, `rai.sqlite.importing.${randomUUID()}`);
  const store = await RaiDatabase.open(database, { createMigrationBackup: false });
  const load = async (rows: string, batchId: string, deletedRecords: { type: string; uuid: string }[] = [], v2 = true) => {
    store.database.prepare("INSERT OR IGNORE INTO import_batches(id, xml_sha256, status, import_mode) VALUES (?, 'test', 'running', 'incremental')").run(batchId);
    writeFileSync(path, `<HealthData>${rows}</HealthData>`);
    return parseAppleHealthXml(path, store, { fileSize: statSync(path).size, atomic: false,
      native: { engine: "rust", fallback: "none", stagingDatabase: database },
      healthKitRecordIdentity: v2, deletedRecords,
      incremental: { generation: batchId, batchId, preserveAbsent: true } });
  };
  try {
    await load(record(), "legacy", [], false);
    await load(record(a, "42", hrv, "vendor"), "initial");
    const id = facts(store)[0]!.id;
    await load(record(undefined, "42", hrv, "vendor"), "ordinary-xml", [], false);
    assert.equal(facts(store).length, 1, "native v1 apply cannot bypass established UUID aliases");
    await load(record(b, "42", hrv, "vendor"), "share");
    await load(record(a, "60", hrv, "vendor"), "correct");
    assert.equal(facts(store)[0]!.id, id);
    assert.equal(facts(store)[0]!.value_numeric, 60);
    await load("", "delete", [{ type: hrv, uuid: a }]);
    assert.equal((await load(record(a), "old")).tombstonedCount, 1);
    assert.equal(facts(store)[0]!.value_numeric, 42, "Rust-parsed deletion restores B's durable source fact");
    await load("", "delete-b", [{ type: hrv, uuid: b }]);
    assert.equal(facts(store).length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("production CLI carries v2 record-only deletion manifests into the published candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-hk-cli-"));
  const path = join(root, "export.xml");
  const database = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(database, { createMigrationBackup: false });
  try {
    writeFileSync(path, `<HealthData>${record(a)}</HealthData>`);
    await parseAppleHealthXml(path, store, { fileSize: statSync(path).size, healthKitRecordIdentity: true });
  } finally { store.close(); }
  try {
    writeFileSync(path, "<HealthData/>");
    writeFileSync(join(root, "sync-manifest.json"), JSON.stringify({
      version: 2, sourceScope: "healthkit", deletedRecords: [{ type: hrv, uuid: a }], deletedSourceIds: []
    }));
    const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "incremental-import", "--input", root, "--database", database, "--batch-id", "cli-delete",
      "--engine", "typescript", "--report", join(root, "audit.md"), "--json-report", join(root, "audit.json")],
    { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const published = await RaiDatabase.open(database, { createMigrationBackup: false });
    try {
      assert.equal(facts(published).length, 0);
      assert.equal(published.database.prepare(`
        SELECT change_type FROM import_entity_changes WHERE batch_id='cli-delete' AND entity_kind='record'
      `).get()!.change_type, "removed");
      assert.equal(published.countEntityTombstones(), 1);
    } finally { published.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
