import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CONTRACT_VERSION, healthTypes } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { identityAlgorithmFingerprint, parseAppleHealthXml, isDataOnlyRecordXml, NATIVE_VERSION,
  DATA_ONLY_RECORD_TYPES } from "@rai/health-export-parser";
import { applyDataOnlyImport, dataOnlyBaselineContract, type DataOnlyImportInput } from "../src/data-only-import.js";
import { readImportReceipt } from "../src/import-publication.js";
import { importPayloadSha256 } from "../src/import-payload-identity.js";
import { digestHealthKitRecordSnapshot } from "../src/import-sources.js";
import { scoringHealthTypes } from "../src/health-change-plan.js";

const a = "00000000-0000-0000-0000-00000000000a";
const b = "00000000-0000-0000-0000-00000000000b";
const c = "00000000-0000-0000-0000-00000000000c";
const step = healthTypes.stepCount;
function record(uuid: string, value = "10", type: string = step, syncId?: string): string {
  return `<Record type="${type}" sourceName="Watch" unit="count" value="${value}"
    startDate="2018-01-01 00:00:00 +0000" endDate="2018-01-01 00:01:00 +0000">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/>
    ${syncId ? `<MetadataEntry key="HKMetadataKeySyncIdentifier" value="${syncId}"/>` : ""}
  </Record>`;
}
const xml = (rows = "") => `<HealthData>${rows}</HealthData>`;

function snapshot(path: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => [String(name),
      db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all()
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]));
  } finally { db.close(); }
}

async function fixture(run: (ctx: {
  root: string; main: string;
  input(rows?: string, deletions?: { type: string; uuid: string }[], job?: string): DataOnlyImportInput;
  seed(rows: string): Promise<void>;
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-data-only-atomic-"));
  const main = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(main);
  store.setManifest("dataset_version", "baseline");
  store.setManifest("parser_contract_version", CONTRACT_VERSION);
  store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  store.setManifest("data_only_baseline_contract", dataOnlyBaselineContract());
  store.setProfile({ dateOfBirth: "1990-01-01" });
  store.close();
  let ordinal = 0;
  const input = (rows = "", deletions: { type: string; uuid: string }[] = [], job = "delta") => {
    const inputPath = join(root, `input-${ordinal++}`);
    mkdirSync(inputPath);
    writeFileSync(join(inputPath, "export.xml"), xml(rows));
    writeFileSync(join(inputPath, "sync-manifest.json"), JSON.stringify({
      version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: deletions
    }));
    const payloadSha256 = importPayloadSha256(digestHealthKitRecordSnapshot(
      readFileSync(join(inputPath, "export.xml"), "utf8"), readFileSync(join(inputPath, "sync-manifest.json"), "utf8")
    ), { preserveAbsent: true, contractVersion: CONTRACT_VERSION,
      engine: `typescript@${NATIVE_VERSION}`, identityAlgorithm: identityAlgorithmFingerprint() });
    return { databasePath: main, inputPath, jobId: job, payloadSha256, startedAtMs: Date.now() };
  };
  const seed = async (rows: string) => {
    const seeded = await RaiDatabase.open(main);
    const path = join(root, "seed.xml");
    writeFileSync(path, xml(rows));
    try {
      seeded.database.prepare(`INSERT OR IGNORE INTO import_batches
        (id,xml_sha256,status,import_mode) VALUES ('seed','seed','running','incremental')`).run();
      await parseAppleHealthXml(path, seeded, {
        fileSize: statSync(path).size, healthKitRecordIdentity: true,
        incremental: { generation: "seed", batchId: "seed", preserveAbsent: true }
      });
    } finally { seeded.close(); }
  };
  try { await run({ root, main, input, seed }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("bounded data-only policy rejects scoring, workout, unknown, malformed and nested payloads", () => {
  assert.ok(DATA_ONLY_RECORD_TYPES.every(type => !(scoringHealthTypes as readonly string[]).includes(type)),
    "new scoring dependencies must never be silently accepted by the live delta lane");
  assert.equal(isDataOnlyRecordXml(xml(record(a))), true);
  assert.equal(isDataOnlyRecordXml(xml("<Me dateOfBirth=\"1990-01-01\"/>")), true);
  for (const type of [healthTypes.heartRate, healthTypes.runningSpeed, healthTypes.restingHeartRate,
    healthTypes.sleepAnalysis, healthTypes.hrvSdnn, healthTypes.vo2Max, "HKQuantityTypeIdentifierFutureMetric"]) {
    assert.equal(isDataOnlyRecordXml(xml(record(a, "10", type))), false, type);
  }
  for (const source of ["<HealthData><Record", "<HealthData><Workout/></HealthData>",
    "<HealthData><ActivitySummary/></HealthData>", "<HealthData><Unknown/></HealthData>",
    "<HealthData><Me><Record/></Me></HealthData>", "<HealthData>unexpected text</HealthData>"]) {
    assert.equal(isDataOnlyRecordXml(source), false);
  }
});

test("raw inserts, corrections, deletions, UUID facts, ledger and receipt commit together without replacement", async () => {
  await fixture(async ({ root, main, input, seed }) => {
    await seed(record(a) + record(c, "99"));
    const beforeInode = statSync(main).ino;
    const oldReader = new DatabaseSync(main, { readOnly: true });
    oldReader.exec("BEGIN");
    assert.equal(oldReader.prepare("SELECT SUM(value_numeric) AS n FROM health_records").get()!.n, 109);
    try {
      const batch = input(record(a, "20") + record(b, "65", "HKQuantityTypeIdentifierBodyMass"),
        [{ type: step, uuid: c }]);
      const applied = await applyDataOnlyImport(batch);
      assert.ok(applied);
      assert.equal(applied.summary.backupName, null);
      assert.equal(applied.summary.featuresRecomputed, 0);
      assert.equal(applied.replayed, false);
      assert.equal(statSync(main).ino, beforeInode, "no file swap");
      assert.equal(readdirSync(root).some(name => /backups|importing|replaced/.test(name)), false);
      assert.equal(oldReader.prepare("SELECT SUM(value_numeric) AS n FROM health_records").get()!.n, 109,
        "existing readers retain their coherent old snapshot");
      oldReader.exec("COMMIT");
      assert.equal(oldReader.prepare("SELECT SUM(value_numeric) AS n FROM health_records").get()!.n, 85);
      assert.deepEqual(readImportReceipt(main, batch.jobId), applied.summary);
      const rows = snapshot(main);
      assert.equal(rows.health_records!.length, 2);
      assert.equal(rows.healthkit_record_sources!.length, 3);
      assert.equal(rows.healthkit_record_facts!.length, 3);
      const db = new DatabaseSync(main, { readOnly: true });
      try {
        assert.deepEqual(db.prepare(`SELECT change_type FROM import_entity_changes
          WHERE batch_id='delta' ORDER BY change_type`).all().map(row => row.change_type),
        ["inserted", "removed", "updated"]);
        assert.equal(db.prepare("SELECT status FROM import_batches WHERE id='delta'").get()!.status, "succeeded");
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM import_source_tombstones").get()!.n, 1);
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      } finally { db.close(); }
    } finally { oldReader.close(); }
  });
});

test("a durable same-batch replay performs no writes and refuses a changed payload identity", async () => {
  await fixture(async ({ main, input }) => {
    const batch = input(record(a));
    const first = await applyDataOnlyImport(batch);
    assert.ok(first);
    const before = snapshot(main);
    const replay = await applyDataOnlyImport(batch);
    assert.equal(replay?.replayed, true);
    assert.deepEqual(replay?.summary, first.summary);
    assert.deepEqual(snapshot(main), before);
    await assert.rejects(applyDataOnlyImport({ ...batch, payloadSha256: "b".repeat(64) }), /payload changed after admission/);
    await assert.rejects(applyDataOnlyImport(input(record(a, "99"), [], batch.jobId)), /reused with different content/);
    assert.deepEqual(snapshot(main), before);
  });
});

test("SIGKILL immediately before the receipt write leaves no accepted facts or partial deletion state", { timeout: 30_000 }, async () => {
  await fixture(async ({ root, main, input, seed }) => {
    await seed(record(c));
    const batch = input(record(a), [{ type: step, uuid: c }], "crash-before-receipt");
    const db = new DatabaseSync(main);
    db.exec(`CREATE TRIGGER pause_before_receipt BEFORE INSERT ON import_manifest
      WHEN NEW.key LIKE 'rai.applied-import.%' BEGIN SELECT hold_receipt(); END`);
    db.close();
    const before = snapshot(main);
    const ready = join(root, "before-commit");
    // Test-only instrumentation of the actual connection factory. The child
    // runs the real applyDataOnlyImport; no production transaction is mocked.
    const code = `
      import { RaiDatabase } from '@rai/storage-sqlite';
      import { applyDataOnlyImport } from './apps/api/src/data-only-import.ts';
      import { writeFileSync } from 'node:fs';
      const original = RaiDatabase.open.bind(RaiDatabase);
      RaiDatabase.open = async (...args) => {
        const store = await original(...args);
        store.database.function('hold_receipt', () => {
          writeFileSync(${JSON.stringify(ready)}, 'ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300000);
          return 0;
        });
        return store;
      };
      await applyDataOnlyImport(${JSON.stringify(batch)});
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const exited = once(child, "exit");
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(ready)) {
        assert.equal(child.exitCode, null, stderr);
        assert.ok(Date.now() < deadline, `child did not reach pre-commit receipt: ${stderr}`);
        await new Promise(done => setTimeout(done, 20));
      }
      assert.deepEqual(snapshot(main), before, "uncommitted changes remain invisible to readers");
      child.kill("SIGKILL");
      await exited;
      assert.deepEqual(snapshot(main), before, "SQLite rolls back the killed transaction");
      assert.equal(readImportReceipt(main, batch.jobId), null);
      const clean = new DatabaseSync(main); clean.exec("DROP TRIGGER pause_before_receipt"); clean.close();
      assert.ok(await applyDataOnlyImport(batch), "the same persisted batch can be retried after restart");
      assert.ok(readImportReceipt(main, batch.jobId));
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
  });
});

test("deletion before arrival cannot resurrect a carried or later UUID", async () => {
  await fixture(async ({ main, input }) => {
    assert.ok(await applyDataOnlyImport(input(record(a), [{ type: step, uuid: a }], "deleted-first")));
    assert.equal(snapshot(main).health_records!.length, 0);
    assert.ok(await applyDataOnlyImport(input(record(a), [], "late-replay")));
    assert.equal(snapshot(main).health_records!.length, 0);
    assert.equal(snapshot(main).import_source_tombstones!.length, 1);
    assert.ok(readImportReceipt(main, "late-replay"));
  });
});

test("a deletion-only delta restores a surviving shared UUID and records the correction", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(record(a, "10", step, "vendor") + record(b, "20", step, "vendor"));
    assert.ok(await applyDataOnlyImport(input("", [{ type: step, uuid: b }], "shared-delete")));
    const db = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT value_numeric FROM health_records").get()!.value_numeric, 10);
      assert.equal(db.prepare("SELECT change_type FROM import_entity_changes WHERE batch_id='shared-delete'").get()!.change_type, "updated");
      assert.ok(readImportReceipt(main, "shared-delete"));
    } finally { db.close(); }
  });
});

for (const [name, trigger] of [
  ["UUID fact write", `CREATE TRIGGER fail_delta BEFORE INSERT ON healthkit_record_facts
    BEGIN SELECT RAISE(ABORT,'fixture fact failure'); END`],
  ["change ledger", `CREATE TRIGGER fail_delta BEFORE INSERT ON import_entity_changes
    BEGIN SELECT RAISE(ABORT,'fixture ledger failure'); END`],
  ["silently ignored raw record", `CREATE TRIGGER fail_delta BEFORE INSERT ON health_records
    BEGIN SELECT RAISE(IGNORE); END`],
  ["silently rewritten raw value", `CREATE TRIGGER fail_delta AFTER INSERT ON health_records
    BEGIN UPDATE health_records SET value_numeric=999 WHERE id=NEW.id; END`],
  ["silently ignored UUID identity", `CREATE TRIGGER fail_delta BEFORE INSERT ON healthkit_record_sources
    BEGIN SELECT RAISE(IGNORE); END`],
  ["silently ignored alias", `CREATE TRIGGER fail_delta BEFORE INSERT ON healthkit_record_aliases
    BEGIN SELECT RAISE(IGNORE); END`],
  ["silently ignored change ledger", `CREATE TRIGGER fail_delta BEFORE INSERT ON import_entity_changes
    BEGIN SELECT RAISE(IGNORE); END`],
  ["silently ignored deletion", `CREATE TRIGGER fail_delta BEFORE DELETE ON health_records
    BEGIN SELECT RAISE(IGNORE); END`],
  ["silently ignored source tombstone", `CREATE TRIGGER fail_delta BEFORE INSERT ON import_source_tombstones
    BEGIN SELECT RAISE(IGNORE); END`],
  ["receipt write", `CREATE TRIGGER fail_delta BEFORE INSERT ON import_manifest
    WHEN NEW.key LIKE 'rai.applied-import.%' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END`],
  ["silently ignored receipt", `CREATE TRIGGER fail_delta BEFORE INSERT ON import_manifest
    WHEN NEW.key LIKE 'rai.applied-import.%' BEGIN SELECT RAISE(IGNORE); END`],
  ["silently rewritten receipt", `CREATE TRIGGER fail_delta AFTER INSERT ON import_manifest
    WHEN NEW.key LIKE 'rai.applied-import.%' BEGIN UPDATE import_manifest SET value='{}' WHERE key=NEW.key; END`],
  ["late ledger removal", `CREATE TRIGGER fail_delta AFTER INSERT ON import_manifest
    WHEN NEW.key LIKE 'rai.applied-import.%' BEGIN DELETE FROM import_entity_changes WHERE batch_id='delta'; END`],
  ["late fact corruption", `CREATE TRIGGER fail_delta AFTER INSERT ON import_manifest
    WHEN NEW.key LIKE 'rai.applied-import.%' BEGIN UPDATE health_records SET value_numeric=999; END`],
  ["late identity removal", `CREATE TRIGGER fail_delta AFTER INSERT ON import_manifest
    WHEN NEW.key LIKE 'rai.applied-import.%' BEGIN DELETE FROM healthkit_record_sources; END`],
  ["ignored completion metadata", `CREATE TRIGGER fail_delta BEFORE INSERT ON import_manifest
    WHEN NEW.key='import_completed_at' BEGIN SELECT RAISE(IGNORE); END`],
  ["late batch corruption", `CREATE TRIGGER fail_delta AFTER INSERT ON import_manifest
    WHEN NEW.key LIKE 'rai.applied-import.%' BEGIN UPDATE import_batches SET summary_json='{}' WHERE id='delta'; END`],
] as const) {
  test(`${name} failure rolls back every fact, alias, tombstone, ledger and success marker`, async () => {
    await fixture(async ({ main, input, seed }) => {
      await seed(record(c));
      const db = new DatabaseSync(main); db.exec(trigger); db.close();
      const before = snapshot(main);
      // A distinct natural identity is essential: equal legacy fields would
      // legitimately share C's canonical row and neither INSERT nor DELETE
      // triggers would run.
      await assert.rejects(applyDataOnlyImport(input(record(a, "20"), [{ type: step, uuid: c }])));
      assert.deepEqual(snapshot(main), before);
      assert.equal(readImportReceipt(main, "delta"), null);
    });
  });
}

test("a silently ignored canonical correction cannot be acknowledged with only the UUID fact updated", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(record(a));
    const db = new DatabaseSync(main);
    db.exec("CREATE TRIGGER ignore_correction BEFORE UPDATE ON health_records BEGIN SELECT RAISE(IGNORE); END");
    db.close();
    const before = snapshot(main);
    await assert.rejects(applyDataOnlyImport(input(record(a, "20"))), /pre-commit assertion/);
    assert.deepEqual(snapshot(main), before);
  });
});

test("profile drift rolls back earlier records and returns a no-write fallback", async () => {
  await fixture(async ({ main, input }) => {
    const before = snapshot(main);
    assert.equal(await applyDataOnlyImport(input(record(a) + "<Me dateOfBirth=\"1980-01-01\"/>")), null);
    assert.deepEqual(snapshot(main), before);
    assert.ok(await applyDataOnlyImport(input(record(a) + "<Me dateOfBirth=\"1990-01-01\"/>", [], "same-profile")));
  });
});

test("an incoming non-scoring UUID mapped to a scoring row cannot evade the SQL guards", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(record(b, "42", healthTypes.hrvSdnn));
    const db = new DatabaseSync(main);
    const id = db.prepare("SELECT id FROM health_records").get()!.id;
    assert.ok(typeof id === "string");
    db.prepare("INSERT INTO healthkit_record_sources VALUES (?,?,?)").run(step, a, id);
    db.close();
    const before = snapshot(main);
    assert.equal(await applyDataOnlyImport(input(record(a, "99"))), null);
    assert.deepEqual(snapshot(main), before);
  });
});

test("missing/old parser attestation and uninitialized legacy hashes use the normal path without writes", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(record(a));
    const db = new DatabaseSync(main);
    db.prepare("DELETE FROM import_entity_generations WHERE entity_kind='record'").run();
    db.close();
    const before = snapshot(main);
    assert.equal(await applyDataOnlyImport(input(record(a, "99"))), null);
    assert.deepEqual(snapshot(main), before);
    const old = new DatabaseSync(main);
    old.prepare("DELETE FROM import_manifest WHERE key='parser_identity_algorithm'").run();
    old.close();
    const older = snapshot(main);
    assert.equal(await applyDataOnlyImport(input(record(b), [], "older-parser")), null);
    assert.deepEqual(snapshot(main), older);
  });
});

test("a stale derivation policy or missing UUID lookup index cannot qualify for data-only", async () => {
  await fixture(async ({ main, input }) => {
    const db = new DatabaseSync(main);
    db.prepare("UPDATE import_manifest SET value='old-canonical-policy' WHERE key='data_only_baseline_contract'").run();
    db.close();
    const old = snapshot(main);
    assert.equal(await applyDataOnlyImport(input(record(a))), null);
    assert.deepEqual(snapshot(main), old);
    const current = new DatabaseSync(main);
    current.prepare("UPDATE import_manifest SET value=? WHERE key='data_only_baseline_contract'").run(dataOnlyBaselineContract());
    current.exec("DROP INDEX idx_healthkit_record_aliases_source");
    current.close();
    const missing = snapshot(main);
    assert.equal(await applyDataOnlyImport(input(record(a), [], "no-index")), null);
    assert.deepEqual(snapshot(main), missing);
  });
});

test("workout deletions, routes and unknown record types cannot take the fast path", async () => {
  await fixture(async ({ main, input }) => {
    const before = snapshot(main);
    const batch = input(record(a));
    mkdirSync(join(batch.inputPath, "workout-routes"));
    assert.equal(await applyDataOnlyImport(batch), null);
    const deletion = input();
    writeFileSync(join(deletion.inputPath, "sync-manifest.json"), JSON.stringify({
      version: 2, sourceScope: "healthkit", deletedSourceIds: ["workout"], deletedRecords: []
    }));
    assert.equal(await applyDataOnlyImport(deletion), null);
    assert.equal(await applyDataOnlyImport(input(record(a, "10", "HKQuantityTypeIdentifierUnknown"))), null);
    assert.deepEqual(snapshot(main), before);
  });
});
