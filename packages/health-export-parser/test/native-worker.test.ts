import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importEquivalence } from "../../../apps/api/src/import-equivalence.js";
import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { importGpxRoutes } from "../src/gpx-parser.js";
import { RaiDatabase } from "../src/database.js";
import { canonicalizeRunningWorkouts } from "../src/canonicalize.js";
import { prepareNative, nativeBinary, nativeElevationGains } from "../src/native-worker.js";
import { NativeRecordWriter } from "../src/native-record-writer.js";

const available = existsSync(nativeBinary());
if (process.env.RAI_REQUIRE_RUST_TESTS === "1" && !available) throw new Error("Rust verification requires the compiled release worker");
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData ANY>]>
<h:HealthData xmlns:h="fixture">
 <Me biologicalSex="HKBiologicalSexMale"/><ExportDate value="2026-01-02 00:00:00 +0800"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch 中文 ⌚" unit="count/min"
 startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:00:05 +0800" value="1.5e2" __proto__="raw-data">
  <MetadataEntry key="10" value="a&#xA;b"/><MetadataEntry key="2" value="&amp;"/>
  <MetadataEntry key="HKMetadataKeySyncIdentifier" value="record-uuid"/>
  <MetadataEntry key="duplicate" value="first"/><MetadataEntry key="duplicate" value="second"/>
  <MetadataEntry key="__proto__" value="metadata-data"/>
 </Record>
 <Record type="HKQuantityTypeIdentifierSleepAnalysis" sourceName="Apple Watch" value="HKCategoryValueSleepAnalysisAsleepCore"
 startDate="2026-01-01 00:00:00 +0800" endDate="2026-01-01 06:00:00 +0800"/>
 <Record type="invalid" value="NaN"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Apple Watch" duration="30" durationUnit="min"
 startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800">
  <MetadataEntry key="RAIHealthKitWorkoutUUID" value="workout-uuid"/>
  <MetadataEntry key="constructor" value="workout-data"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
  <WorkoutEvent type="HKWorkoutEventTypePause" date="2026-01-01 08:10:00 +0800"><MetadataEntry key="reason" value="灯"/><MetadataEntry key="__proto__" value="event-data"/></WorkoutEvent>
  <WorkoutRoute><MetadataEntry key="toString" value="route-data"/><FileReference path="/workout-routes/Route.GPX"/></WorkoutRoute>
 </Workout>
 <ActivitySummary dateComponents="2026-01-01" activeEnergyBurned="500"/>
</h:HealthData>`;
const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>
 <trkpt lat="31.1" lon="121.1"><time>2026-01-01T08:00:00.123456+08:00</time><ele>5</ele><extensions><speed>2.5</speed><hAcc>4</hAcc></extensions></trkpt>
 <trkpt lat="31.2" lon="121.2"><time>2026-01-01T00:00:05Z</time><ele>6</ele><course>-0</course></trkpt>
 <trkpt lat="bad" lon="121.3"><ele>30</ele></trkpt>
</trkseg></trk></gpx>`;

test("Rust decoded data preserves TS stable IDs, metadata, routes, updates, and tombstones", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-rust-parity-"));
  const stores: RaiDatabase[] = [];
  const databasePath = (engine: string) => join(root, engine === "rust"
    ? "rust.sqlite.importing.00000000-0000-0000-0000-000000000001" : "typescript.sqlite");
  try {
    mkdirSync(join(root, "workout-routes"));
    writeFileSync(join(root, "workout-routes/Route.GPX"), gpx);
    const path = join(root, "export.xml");
    writeFileSync(path, `\uFEFF${xml}`);
    for (const engine of ["typescript", "rust"] as const) {
      const store = await RaiDatabase.open(databasePath(engine));
      stores.push(store);
      await parseAppleHealthXml(path, store, { fileSize: statSync(path).size, atomic: false,
        native: { engine, spoolRoot: root, stagingDatabase: databasePath(engine) } });
      const record = store.database.prepare("SELECT metadata_json, raw_attributes_json FROM health_records WHERE type='HKQuantityTypeIdentifierHeartRate'").get()!;
      assert.deepEqual(JSON.parse(String(record.metadata_json)).__proto__, ["metadata-data"]);
      assert.equal(JSON.parse(String(record.raw_attributes_json)).__proto__, "raw-data");
      for (const [table, key, value] of [
        ["workouts", "constructor", "workout-data"],
        ["workout_events", "__proto__", "event-data"],
        ["workout_routes", "toString", "route-data"]
      ] as const) {
        const row = store.database.prepare(`SELECT metadata_json FROM ${table}`).get()!;
        assert.deepEqual(JSON.parse(String(row.metadata_json))[key], [value]);
      }
      await importGpxRoutes(root, store, { native: { engine, spoolRoot: root } });
      canonicalizeRunningWorkouts(store.database);
      store.flush();
    }
    const digest = () => {
      const left = importEquivalence(databasePath("typescript"));
      const right = importEquivalence(databasePath("rust"));
      assert.deepEqual(right, left);
    };
    digest();
    writeFileSync(path, xml.replace('value="1.5e2"', 'value="155"'));
    for (const [index, engine] of (["typescript", "rust"] as const).entries()) {
      const store = stores[index]!;
      store.database.exec(`INSERT INTO import_batches (id,xml_sha256,status,import_mode,summary_json)
        VALUES ('update-batch','pending','running','incremental','{}')`);
      await parseAppleHealthXml(path, store, {
        fileSize: statSync(path).size, atomic: false, native: { engine, spoolRoot: root, stagingDatabase: databasePath(engine) },
        incremental: { generation: "update", batchId: "update-batch", preserveAbsent: true }, deletedWorkoutIds: ["workout-uuid"]
      });
      store.flush();
    }
    digest();
    assert.deepEqual(
      stores[1]!.database.prepare("SELECT batch_id,entity_kind,entity_id,change_type,effective_at,content_hash FROM import_entity_changes ORDER BY entity_kind,entity_id").all(),
      stores[0]!.database.prepare("SELECT batch_id,entity_kind,entity_id,change_type,effective_at,content_hash FROM import_entity_changes ORDER BY entity_kind,entity_id").all()
    );
    for (const [index, engine] of (["typescript", "rust"] as const).entries()) {
      await parseAppleHealthXml(path, stores[index]!, {
        fileSize: statSync(path).size, atomic: false, native: { engine, spoolRoot: root, stagingDatabase: databasePath(engine) },
        incremental: { generation: "repeat", preserveAbsent: true }
      });
      stores[index]!.flush();
    }
    digest();
  } finally { stores.forEach((store) => store.close()); rmSync(root, { recursive: true, force: true }); }
});

test("native worker refuses existing outputs, protocol mismatches and malformed XML without modifying data", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-rust-invalid-"));
  try {
    const path = join(root, "export.xml");
    for (const body of ["<HealthData><Record></HealthData>", "<a/><b/>", "<a x='1' x='2'/>", "<a>&#0;</a>",
      "<a>]]></a>", "<!--before--><?xml version='1.0'?><a/>"]) {
      writeFileSync(path, body);
      await assert.rejects(prepareNative("health", path, { engine: "rust", spoolRoot: root }));
      assert.equal(readdirSync(root).some((name) => name.startsWith("rai-native-")), false);
    }
    writeFileSync(path, "<HealthData/>");
    const existing = join(root, "existing.sqlite");
    writeFileSync(existing, "do not overwrite");
    const refused = spawnSync(nativeBinary(), ["--operation", "health", "--input", path, "--output", existing]);
    assert.notEqual(refused.status, 0);
    assert.equal(readFileSync(existing, "utf8"), "do not overwrite");
    await assert.rejects(prepareNative("health", path, { engine: "rust", version: "wrong-version", fallback: "typescript", spoolRoot: root }), /invalid_protocol/);
    assert.equal(await prepareNative("health", path, { engine: "rust", binary: join(root, "missing"), fallback: "typescript", spoolRoot: root }), null);
    await assert.rejects(prepareNative("health", path, { engine: "rust", binary: join(root, "missing"), spoolRoot: root }), /unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("even a valid permit cannot authorize native writes to an active-database filename", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-rust-main-guard-"));
  const path = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(path);
  const permit = "1".repeat(64);
  try {
    store.setManifest("rai.native_import_permit", permit); store.flush();
    await assert.rejects(prepareNative("apply-records", path, {
      engine: "rust", fallback: "typescript", spoolRoot: root, stagingDatabase: path, permit
    }), /native_failure/);
    assert.equal((store.database.prepare("SELECT value FROM import_manifest WHERE key='rai.native_import_permit'").get() as { value: string }).value, permit);
    assert.equal((store.database.prepare("SELECT COUNT(*) AS n FROM health_records").get() as { n: number }).n, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("native resource limits cannot be bypassed by fallback and active cancellation removes its spool", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-rust-limits-"));
  try {
    const path = join(root, "export.xml");
    writeFileSync(path, `<HealthData x="${"x".repeat(2 * 1024 * 1024)}"/>`);
    await assert.rejects(prepareNative("health", path, { engine: "rust", fallback: "typescript", spoolRoot: root }), /resource_limit/);
    writeFileSync(path, `<HealthData>${"<Record type='test' value='1'/>".repeat(200_000)}</HealthData>`);
    const controller = new AbortController();
    const task = prepareNative("health", path, { engine: "rust", fallback: "typescript", spoolRoot: root, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 10);
    try { await assert.rejects(task, /cancelled/); } finally { clearTimeout(timer); }
    assert.equal(readdirSync(root).some((name) => name.startsWith("rai-native-")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native GPX unsupported timestamps fall back only before points are applied", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-rust-gpx-fallback-"));
  try {
    const path = join(root, "route.gpx");
    writeFileSync(path, gpx.replace("2026-01-01T00:00:05Z", "2026-01-01 00:00:05"));
    assert.equal(await prepareNative("gpx", path, { engine: "rust", fallback: "typescript", spoolRoot: root }), null);
    await assert.rejects(prepareNative("gpx", path, { engine: "rust", spoolRoot: root }), /unsupported_xml/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native aggregate matches elevation spike filtering and leaves ambiguous multi-route ordering to TS", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-rust-aggregate-"));
  const path = join(root, "db.sqlite");
  const store = await RaiDatabase.open(path);
  try {
    writeFileSync(join(root, "export.xml"), xml);
    mkdirSync(join(root, "workout-routes"));
    writeFileSync(join(root, "workout-routes/Route.GPX"), gpx);
    await parseAppleHealthXml(join(root, "export.xml"), store, { fileSize: Buffer.byteLength(xml) });
    await importGpxRoutes(root, store);
    store.flush();
    const gains = await nativeElevationGains(path, { engine: "rust", spoolRoot: root });
    assert.deepEqual([...gains!.values()], [1]);
    const route = store.database.prepare("SELECT * FROM workout_routes WHERE workout_id IS NOT NULL LIMIT 1").get()!;
    const second = { ...route, id: `${route.id}_second`, relative_path: "second.gpx", point_count: 0, file_status: "missing" };
    const columns = Object.keys(second);
    store.database.prepare(`INSERT INTO workout_routes (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .run(...Object.values(second) as import("node:sqlite").SQLInputValue[]);
    const ambiguous = await nativeElevationGains(path, { engine: "rust", spoolRoot: root });
    assert.equal(ambiguous!.has(String(route.workout_id)), false, "ambiguous route ordering must use TS");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a record id carried twice keeps the last occurrence and does not trip the write sample check", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-rust-duplicate-id-"));
  const databasePath = join(root, "duplicate.sqlite.importing.00000000-0000-0000-0000-000000000002");
  const store = await RaiDatabase.open(databasePath);
  try {
    // `device` is stored but deliberately excluded from the record id
    // (`apple-health-parser.ts:191`: Apple exports the same sample with and without it), so
    // these two elements collapse onto ONE id carrying two different content hashes. The
    // worker's upsert keeps the last one. B4 may only compare against that final write, so
    // this fails if the sample is taken from the head of the spool or keeps repeated ids.
    const path = join(root, "duplicate.xml");
    writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<h:HealthData xmlns:h="fixture">
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" device="with-device"
  startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:00:05 +0800" value="120"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min"
  startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:00:05 +0800" value="120"/>
</h:HealthData>`);
    const result = await parseAppleHealthXml(path, store, { fileSize: statSync(path).size, atomic: false,
      native: { engine: "rust", spoolRoot: root, stagingDatabase: databasePath } });
    assert.equal(result.recordCount, 2, "both elements are parsed");
    const rows = store.database.prepare("SELECT id, device FROM health_records").all() as
      Array<{ id: string; device: string | null }>;
    assert.equal(rows.length, 1, "one identity means one row");
    assert.equal(rows[0]!.device, null, "the surviving row is the last occurrence, not the first");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("B4 records an inactive content check instead of passing when the candidate holds no sampled row", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-b4-empty-sample-"));
  const store = await RaiDatabase.open(join(root, "candidate.sqlite"));
  const writer = new NativeRecordWriter(root, "fixture-generation", undefined, false);
  try {
    // The canonical spool holds one row and the candidate holds none, so the sample has
    // nothing to compare against. Without the `compared === 0` guard the loop reports no
    // divergence and the check silently "passes" having looked at zero rows.
    writer.capture({
      id: "record_b4_fixture", type: "HKQuantityTypeIdentifierHeartRate", sourceName: "Apple Watch",
      sourceVersion: "1", device: null, unit: "count/min", numericValue: 120, textValue: null,
      startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-01T00:00:05.000Z",
      createdAt: "2026-01-01T00:00:00.000Z", metadata: {}
    }, "apple_watch", {}, "hash_b4_fixture");
    (writer as unknown as { db: { exec(sql: string): void } }).db.exec("COMMIT");
    writer.close();
    (writer as unknown as { assertSampleMatches(store: RaiDatabase): void }).assertSampleMatches(store);
    const issue = store.database.prepare("SELECT code FROM import_issues WHERE code = ?")
      .get("invariant.b4.no_rows_compared") as { code: string } | undefined;
    assert.ok(issue, "a sample that compared zero rows must not look like a passed check");
  } finally { writer.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
