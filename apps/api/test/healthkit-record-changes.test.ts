import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RaiDatabase } from "@rai/storage-sqlite";
import { parseAppleHealthXml } from "@rai/health-export-parser";
import { planHealthChanges } from "../src/health-change-plan.js";

test("real v2 historical record-only deltas activate the existing recompute gate from old/new event times", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-hk-recompute-"));
  const baseline = join(root, "previous.sqlite");
  const candidate = join(root, "candidate.sqlite");
  const path = join(root, "export.xml");
  const type = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
  const uuid = "00000000-0000-0000-0000-00000000000a";
  const xml = (date: string, value: number) => `<HealthData><Record type="${type}" sourceName="Watch" unit="ms"
    startDate="${date} 00:00:00 +0000" endDate="${date} 00:00:00 +0000" value="${value}">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/></Record></HealthData>`;
  const first = await RaiDatabase.open(baseline, { createMigrationBackup: false });
  try {
    writeFileSync(path, xml("2020-01-01", 42));
    await parseAppleHealthXml(path, first, { fileSize: statSync(path).size, healthKitRecordIdentity: true });
  } finally { first.close(); }
  copyFileSync(baseline, candidate);
  const store = await RaiDatabase.open(candidate, { createMigrationBackup: false });
  try {
    store.database.prepare("ATTACH DATABASE ? AS previous").run(baseline);
    const delta = async (body: string, batchId: string, deletedRecords: { type: string; uuid: string }[] = []) => {
      store.database.prepare(`INSERT INTO import_batches(id, xml_sha256, status, import_mode)
        VALUES (?, 'test', 'running', 'incremental')`).run(batchId);
      writeFileSync(path, body);
      await parseAppleHealthXml(path, store, {
        fileSize: statSync(path).size, healthKitRecordIdentity: true, deletedRecords,
        incremental: { generation: batchId, batchId, preserveAbsent: true }
      });
      return planHealthChanges(store.database, batchId);
    };
    const changed = await delta(xml("2018-01-01", 60), "correct");
    assert.equal(changed.changed, true);
    assert.equal(changed.full, false);
    assert.equal(changed.dirtyFromAt, "2018-01-01T00:00:00.000Z");
    assert.ok(changed.reasons.includes("bounded_health_change"));
    const deleted = await delta("<HealthData/>", "delete", [{ type, uuid }]);
    assert.equal(deleted.changed, true);
    assert.equal(deleted.dirtyFromAt, "2020-01-01T00:00:00.000Z", "deletion reads the old fact, never sync arrival time");
    assert.equal((await delta(xml("2020-01-01", 42), "old-replay")).changed, false, "tombstoned replays do not request recompute");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("shared-source facts survive reopen and restoring a survivor rewinds recomputation to both old/new times", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-hk-survivor-recompute-"));
  const baseline = join(root, "previous.sqlite");
  const candidate = join(root, "candidate.sqlite");
  const path = join(root, "export.xml");
  const type = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
  const a = "00000000-0000-0000-0000-00000000000a";
  const b = "00000000-0000-0000-0000-00000000000b";
  const xml = (uuid: string, date: string, value: number) => `<Record type="${type}" sourceName="Watch" unit="ms"
    startDate="${date} 00:00:00 +0000" endDate="${date} 00:00:00 +0000" value="${value}">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/></Record>`;
  const first = await RaiDatabase.open(baseline, { createMigrationBackup: false });
  try {
    for (const rows of [xml(a, "2020-01-01", 42) + xml(b, "2020-01-01", 42), xml(a, "2018-01-01", 60)]) {
      writeFileSync(path, `<HealthData>${rows}</HealthData>`);
      await parseAppleHealthXml(path, first, { fileSize: statSync(path).size, healthKitRecordIdentity: true });
    }
  } finally { first.close(); }
  copyFileSync(baseline, candidate);
  const store = await RaiDatabase.open(candidate, { createMigrationBackup: false });
  try {
    store.database.prepare("ATTACH DATABASE ? AS previous").run(baseline);
    store.database.prepare(`INSERT INTO import_batches(id, xml_sha256, status, import_mode)
      VALUES ('delete-a', 'test', 'running', 'incremental')`).run();
    writeFileSync(path, "<HealthData/>");
    await parseAppleHealthXml(path, store, {
      fileSize: statSync(path).size, healthKitRecordIdentity: true, deletedRecords: [{ type, uuid: a }],
      incremental: { generation: "delete-a", batchId: "delete-a", preserveAbsent: true }
    });
    assert.equal(store.database.prepare("SELECT value_numeric FROM health_records").get()!.value_numeric, 42);
    const changed = planHealthChanges(store.database, "delete-a");
    assert.equal(changed.changed, true);
    assert.equal(changed.full, false);
    assert.equal(changed.dirtyFromAt, "2018-01-01T00:00:00.000Z", "the removed owner's old time is earlier than the restored survivor");
    assert.ok(changed.reasons.includes("bounded_health_change"));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
