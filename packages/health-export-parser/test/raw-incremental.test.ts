import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { healthTypes, workoutTypes } from "@rai/contracts";

import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { canonicalizeRunningWorkouts } from "../src/canonicalize.js";
import { RaiDatabase } from "../src/database.js";
import { importGpxRoutes } from "../src/gpx-parser.js";

function fingerprintBundleHash(store: RaiDatabase): string {
  const rows = store.database.prepare(
    "SELECT relative_path AS relativePath, sha256 FROM route_file_fingerprints"
  ).all() as Array<{ relativePath: string; sha256: string }>;
  const hash = createHash("sha256");
  for (const row of [...rows].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  )) {
    hash.update(row.relativePath, "utf8");
    hash.update("\0");
    hash.update(row.sha256, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function archiveBundleHash(files: Array<{ relativePath: string; sha256: string }>): string {
  const hash = createHash("sha256");
  for (const row of [...files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  )) {
    hash.update(row.relativePath, "utf8");
    hash.update("\0");
    hash.update(row.sha256, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function exportXml(workouts: Array<{ start: string; duration: number }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US"><ExportDate value="2026-01-03 00:00:00 +0800"/>
${workouts.map((workout) => `<Workout workoutActivityType="${workoutTypes.running}"
 sourceName="Watch" startDate="${workout.start}" endDate="${workout.start.replace("08:00:00", "08:30:00")}"
 duration="${workout.duration}" durationUnit="min"/>`).join("\n")}
</HealthData>`;
}

test("incremental XML scan skips unchanged rows and removes entities absent from the new generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-raw-incremental-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  const first = [
    { start: "2026-01-01 08:00:00 +0800", duration: 30 },
    { start: "2026-01-02 08:00:00 +0800", duration: 30 }
  ];
  writeFileSync(xmlPath, exportXml(first));
  const store = await RaiDatabase.open(databasePath);
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    canonicalizeRunningWorkouts(store.database);
    const stableBefore = store.database.prepare(`
      SELECT g.id AS groupId, g.training_session_id AS sessionId
      FROM workout_groups g JOIN workouts w ON w.id = g.canonical_workout_id
      WHERE w.start_at LIKE '2026-01-02%'
    `).get() as { groupId: string; sessionId: string };
    writeFileSync(xmlPath, exportXml(first.slice(1)));
    const result = await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "generation-2" }
    });
    assert.equal(result.insertedWorkoutCount, 0);
    assert.equal(result.removedWorkoutCount, 1);
    const workoutCount = store.database.prepare("SELECT COUNT(*) AS count FROM workouts").get() as { count: number };
    const groupCount = store.database.prepare("SELECT COUNT(*) AS count FROM workout_groups").get() as { count: number };
    assert.equal(workoutCount.count, 1);
    assert.equal(groupCount.count, 1);
    const canonical = canonicalizeRunningWorkouts(store.database, {
      dirtyWorkoutTimes: result.dirtyWorkoutTimes ?? []
    });
    assert.equal(canonical.affectedWorkoutCount, 0);
    const stableAfter = store.database.prepare(`
      SELECT g.id AS groupId, g.training_session_id AS sessionId
      FROM workout_groups g JOIN workouts w ON w.id = g.canonical_workout_id
      WHERE w.start_at LIKE '2026-01-02%'
    `).get() as { groupId: string; sessionId: string };
    assert.deepEqual(stableAfter, stableBefore);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental import with preserve-absent keeps missing entities and upserts present workouts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-preserve-absent-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  const recordXml = (value: string) => `<Record type="${healthTypes.heartRate}" sourceName="Watch"
    unit="count/min" startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:01:00 +0800" value="${value}"/>`;
  const first = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US"><ExportDate value="2026-01-03 00:00:00 +0800"/>
${recordXml("150")}
<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
  startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800" duration="30" durationUnit="min"/>
<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
  startDate="2026-01-02 08:00:00 +0800" endDate="2026-01-02 08:30:00 +0800" duration="30" durationUnit="min"/>
</HealthData>`;
  const second = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US"><ExportDate value="2026-01-04 00:00:00 +0800"/>
<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
  startDate="2026-01-02 08:00:00 +0800" endDate="2026-01-02 08:30:00 +0800" duration="31" durationUnit="min"/>
</HealthData>`;
  writeFileSync(xmlPath, first);
  const store = await RaiDatabase.open(databasePath);
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    const keptWorkout = store.database.prepare(`
      SELECT id FROM workouts WHERE start_at LIKE '2026-01-01%'
    `).get() as { id: string };
    const updatedWorkout = store.database.prepare(`
      SELECT id FROM workouts WHERE start_at LIKE '2026-01-02%'
    `).get() as { id: string };
    const keptRecord = store.database.prepare("SELECT id FROM health_records").get() as { id: string };
    const inventoryBefore = store.database.prepare(`
      SELECT entity_kind AS entityKind, entity_type AS entityType, item_count AS itemCount
      FROM entity_inventory ORDER BY entity_kind, entity_type
    `).all() as Array<{ entityKind: string; entityType: string; itemCount: number }>;
    const manifestBefore = Object.fromEntries(
      (store.database.prepare(`
        SELECT key, value FROM import_manifest
        WHERE key IN ('record_count', 'workout_count', 'activity_summary_count')
        ORDER BY key
      `).all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value])
    );
    writeFileSync(xmlPath, second);
    const result = await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "healthkit-generation-2", preserveAbsent: true }
    });
    assert.equal(result.removedWorkoutCount, 0);
    assert.equal(result.removedRecordCount, 0);
    assert.equal(result.insertedWorkoutCount, 0);
    assert.deepEqual(
      store.database.prepare(`
        SELECT entity_kind AS entityKind, entity_type AS entityType, item_count AS itemCount
        FROM entity_inventory ORDER BY entity_kind, entity_type
      `).all(),
      inventoryBefore
    );
    assert.deepEqual(
      Object.fromEntries(
        (store.database.prepare(`
          SELECT key, value FROM import_manifest
          WHERE key IN ('record_count', 'workout_count', 'activity_summary_count')
          ORDER BY key
        `).all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value])
      ),
      manifestBefore
    );
    const workoutCount = store.database.prepare("SELECT COUNT(*) AS count FROM workouts").get() as { count: number };
    const recordCount = store.database.prepare("SELECT COUNT(*) AS count FROM health_records").get() as { count: number };
    assert.equal(workoutCount.count, 2);
    assert.equal(recordCount.count, 1);
    assert.equal(
      (store.database.prepare("SELECT id FROM workouts WHERE start_at LIKE '2026-01-01%'").get() as { id: string }).id,
      keptWorkout.id
    );
    assert.equal(
      (store.database.prepare("SELECT id FROM health_records").get() as { id: string }).id,
      keptRecord.id
    );
    const updated = store.database.prepare(`
      SELECT id, duration_seconds AS duration FROM workouts WHERE start_at LIKE '2026-01-02%'
    `).get() as { id: string; duration: number };
    assert.equal(updated.id, updatedWorkout.id);
    assert.equal(updated.duration, 1860);
    assert.equal(
      (store.database.prepare("SELECT COUNT(*) AS count FROM import_issues").get() as { count: number }).count,
      0
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserve-absent XML scan still records issues from the payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-preserve-issues-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  const first = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US"><ExportDate value="2026-01-03 00:00:00 +0800"/>
<Record type="${healthTypes.heartRate}" sourceName="Watch"
  unit="count/min" startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:01:00 +0800" value="150"/>
<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
  startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800" duration="30" durationUnit="min"/>
</HealthData>`;
  const second = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US"><ExportDate value="2026-01-04 00:00:00 +0800"/>
<Record type="${healthTypes.heartRate}" value="150"/>
<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
  startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800" duration="30" durationUnit="min"/>
</HealthData>`;
  writeFileSync(xmlPath, first);
  const store = await RaiDatabase.open(databasePath);
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    const inventoryBefore = store.database.prepare(`
      SELECT entity_kind AS entityKind, entity_type AS entityType, item_count AS itemCount
      FROM entity_inventory ORDER BY entity_kind, entity_type
    `).all() as Array<{ entityKind: string; entityType: string; itemCount: number }>;
    writeFileSync(xmlPath, second);
    const result = await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "issue-payload-generation-2", preserveAbsent: true }
    });
    assert.equal(result.issueCount, 1);
    const issues = store.database.prepare(
      "SELECT code FROM import_issues ORDER BY code"
    ).all() as Array<{ code: string }>;
    assert.deepEqual(issues.map((issue) => issue.code), ["INVALID_RECORD"]);
    assert.deepEqual(
      store.database.prepare(`
        SELECT entity_kind AS entityKind, entity_type AS entityType, item_count AS itemCount
        FROM entity_inventory ORDER BY entity_kind, entity_type
      `).all(),
      inventoryBefore
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync identifiers keep workout identity stable while payload updates in place", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-sync-identity-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  const xml = (duration: number) => `<HealthData><Workout workoutActivityType="${workoutTypes.running}"
    sourceName="Watch" startDate="2026-01-02 08:00:00 +0800" endDate="2026-01-02 08:30:00 +0800"
    duration="${duration}" durationUnit="min"><MetadataEntry key="HKMetadataKeySyncIdentifier"
    value="stable-workout"/></Workout></HealthData>`;
  writeFileSync(xmlPath, xml(30));
  const store = await RaiDatabase.open(databasePath);
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    const before = store.database.prepare("SELECT id FROM workouts").get() as { id: string };
    writeFileSync(xmlPath, xml(31));
    const result = await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "sync-generation-2" }
    });
    const after = store.database.prepare("SELECT id, duration_seconds AS duration FROM workouts").get() as { id: string; duration: number };
    assert.equal(after.id, before.id);
    assert.equal(after.duration, 1860);
    assert.equal(result.insertedWorkoutCount, 0);
    assert.equal((store.database.prepare("SELECT COUNT(*) AS count FROM workouts").get() as { count: number }).count, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous rematches retain a deterministic existing session id", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-session-lineage-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  writeFileSync(xmlPath, exportXml([{ start: "2026-01-02 08:00:00 +0800", duration: 30 }]));
  const store = await RaiDatabase.open(databasePath);
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    canonicalizeRunningWorkouts(store.database);
    const original = store.database.prepare(`
      SELECT id, activity_type AS activityType, anchor_start_at AS startAt,
        anchor_end_at AS endAt, anchor_distance_km AS distanceKm, canonical_workout_id AS workoutId
      FROM training_sessions
    `).get() as { id: string; activityType: string; startAt: string; endAt: string; distanceKm: number | null; workoutId: string };
    store.database.prepare(`
      INSERT INTO training_sessions (
        id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status
      ) VALUES ('zzzz-duplicate-session', ?, ?, ?, ?, ?, 'active')
    `).run(original.activityType, original.startAt, original.endAt, original.distanceKm, original.workoutId);

    const result = canonicalizeRunningWorkouts(store.database);
    const rematched = store.database.prepare(`
      SELECT training_session_id AS id FROM workout_groups
    `).get() as { id: string };
    assert.equal(result.ambiguousTrainingSessionCount, 1);
    assert.equal(rematched.id, original.id);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-match rematch prefers active session over inactive", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-session-status-rank-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  writeFileSync(xmlPath, exportXml([{ start: "2026-01-02 08:00:00 +0800", duration: 30 }]));
  const store = await RaiDatabase.open(databasePath);
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    canonicalizeRunningWorkouts(store.database);
    const original = store.database.prepare(`
      SELECT id, activity_type AS activityType, anchor_start_at AS startAt,
        anchor_end_at AS endAt, anchor_distance_km AS distanceKm, canonical_workout_id AS workoutId
      FROM training_sessions
    `).get() as {
      id: string;
      activityType: string;
      startAt: string;
      endAt: string;
      distanceKm: number | null;
      workoutId: string;
    };

    // Mark the original session inactive and insert a later-id active twin that also matches.
    // Status rank must prefer the active row even when its id sorts after the inactive one.
    store.database.prepare(`
      UPDATE training_sessions SET status = 'inactive' WHERE id = ?
    `).run(original.id);
    store.database.prepare(`
      INSERT INTO training_sessions (
        id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status
      ) VALUES ('zzzz-active-session', ?, ?, ?, ?, ?, 'active')
    `).run(
      original.activityType,
      original.startAt,
      original.endAt,
      original.distanceKm,
      original.workoutId
    );

    const result = canonicalizeRunningWorkouts(store.database);
    const rematched = store.database.prepare(`
      SELECT training_session_id AS id FROM workout_groups
    `).get() as { id: string };
    assert.equal(result.ambiguousTrainingSessionCount, 1);
    assert.equal(rematched.id, "zzzz-active-session");
    assert.notEqual(rematched.id, original.id);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental XML scan updates a changed ActivitySummary for the same date", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-summary-incremental-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  const summaryXml = (energy: number) => `<HealthData>
    <ActivitySummary dateComponents="2026-01-02" activeEnergyBurned="${energy}"
      activeEnergyBurnedGoal="600" activeEnergyBurnedUnit="kcal"/>
  </HealthData>`;
  writeFileSync(xmlPath, summaryXml(500));
  const store = await RaiDatabase.open(databasePath);
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    writeFileSync(xmlPath, summaryXml(550));
    store.database.prepare(`
      INSERT INTO import_batches (id, xml_sha256, status, import_mode, summary_json)
      VALUES ('summary-batch', 'pending', 'running', 'incremental', '{}')
    `).run();
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "summary-generation-2", batchId: "summary-batch" }
    });
    const row = store.database.prepare(`
      SELECT attributes_json AS attributesJson FROM activity_summaries
      WHERE date_components = '2026-01-02'
    `).get() as unknown as { attributesJson: string };
    assert.equal(JSON.parse(row.attributesJson).activeEnergyBurned, "550");
    const change = store.database.prepare(`
      SELECT change_type AS changeType FROM import_entity_changes
      WHERE batch_id = 'summary-batch' AND entity_kind = 'activity_summary'
    `).get() as unknown as { changeType: string };
    assert.equal(change.changeType, "updated");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserve-absent GPX import keeps historical route points when the archive omits files", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-preserve-gpx-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  const routeDirectory = join(root, "workout-routes");
  mkdirSync(routeDirectory);
  const gpx = (lat: string) =>
    `<gpx><trk><trkseg><trkpt lat="${lat}" lon="121.1"><time>2026-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>`;
  const workoutXml = (start: string, file: string) => `<Workout workoutActivityType="${workoutTypes.running}"
    sourceName="Watch" startDate="${start}" endDate="${start.replace("08:00:00", "08:30:00")}"
    duration="30" durationUnit="min">
    <WorkoutRoute><FileReference path="/workout-routes/${file}"/></WorkoutRoute>
  </Workout>`;
  writeFileSync(join(routeDirectory, "alpha.gpx"), gpx("31.1"), "utf8");
  writeFileSync(join(routeDirectory, "beta.gpx"), gpx("32.2"), "utf8");
  writeFileSync(xmlPath, `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  ${workoutXml("2026-01-01 08:00:00 +0800", "alpha.gpx")}
  ${workoutXml("2026-01-02 08:00:00 +0800", "beta.gpx")}
</HealthData>`, "utf8");
  const store = await RaiDatabase.open(databasePath);
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    await importGpxRoutes(root, store);
    const before = store.database.prepare(`
      SELECT route.relative_path AS relativePath, COUNT(point.sequence) AS pointCount
      FROM workout_routes route
      JOIN route_points point ON point.route_id = route.id
      GROUP BY route.relative_path
      ORDER BY route.relative_path
    `).all() as Array<{ relativePath: string; pointCount: number }>;
    assert.deepEqual(before.map((row) => ({ ...row })), [
      { relativePath: "workout-routes/alpha.gpx", pointCount: 1 },
      { relativePath: "workout-routes/beta.gpx", pointCount: 1 }
    ]);

    rmSync(join(routeDirectory, "alpha.gpx"));
    writeFileSync(join(routeDirectory, "gamma.gpx"), gpx("33.3"), "utf8");
    writeFileSync(xmlPath, `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  ${workoutXml("2026-01-02 08:00:00 +0800", "beta.gpx")}
  ${workoutXml("2026-01-03 08:00:00 +0800", "gamma.gpx")}
</HealthData>`, "utf8");
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "gpx-generation-2", preserveAbsent: true }
    });
    const gpxResult = await importGpxRoutes(root, store, { preserveAbsent: true });
    assert.equal(gpxResult.missingRouteCount, 0);
    const remainingHash = fingerprintBundleHash(store);
    const storedHash = (store.database.prepare(
      "SELECT value FROM import_manifest WHERE key = 'source_gpx_bundle_sha256'"
    ).get() as { value: string }).value;
    assert.equal(storedHash, remainingHash);
    const archiveOnly = store.database.prepare(`
      SELECT relative_path AS relativePath, sha256 FROM route_file_fingerprints
      WHERE relative_path IN ('workout-routes/beta.gpx', 'workout-routes/gamma.gpx')
    `).all() as Array<{ relativePath: string; sha256: string }>;
    assert.notEqual(storedHash, archiveBundleHash(archiveOnly));

    const after = store.database.prepare(`
      SELECT route.relative_path AS relativePath, COUNT(point.sequence) AS pointCount,
        route.file_status AS fileStatus
      FROM workout_routes route
      LEFT JOIN route_points point ON point.route_id = route.id
      GROUP BY route.id
      ORDER BY route.relative_path
    `).all() as Array<{ relativePath: string; pointCount: number; fileStatus: string }>;
    assert.deepEqual(after.map((row) => ({ ...row })), [
      { relativePath: "workout-routes/alpha.gpx", pointCount: 1, fileStatus: "imported" },
      { relativePath: "workout-routes/beta.gpx", pointCount: 1, fileStatus: "imported" },
      { relativePath: "workout-routes/gamma.gpx", pointCount: 1, fileStatus: "imported" }
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserve-absent GPX import keeps the full remaining bundle hash for a subset ZIP", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-preserve-gpx-hash-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  const routeDirectory = join(root, "workout-routes");
  mkdirSync(routeDirectory);
  const gpx = (lat: string) =>
    `<gpx><trk><trkseg><trkpt lat="${lat}" lon="121.1"><time>2026-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>`;
  const workoutXml = (start: string, file: string) => `<Workout workoutActivityType="${workoutTypes.running}"
    sourceName="Watch" startDate="${start}" endDate="${start.replace("08:00:00", "08:30:00")}"
    duration="30" durationUnit="min">
    <WorkoutRoute><FileReference path="/workout-routes/${file}"/></WorkoutRoute>
  </Workout>`;
  writeFileSync(join(routeDirectory, "alpha.gpx"), gpx("31.1"), "utf8");
  writeFileSync(join(routeDirectory, "beta.gpx"), gpx("32.2"), "utf8");
  writeFileSync(xmlPath, `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  ${workoutXml("2026-01-01 08:00:00 +0800", "alpha.gpx")}
  ${workoutXml("2026-01-02 08:00:00 +0800", "beta.gpx")}
</HealthData>`, "utf8");
  const store = await RaiDatabase.open(databasePath);
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    await importGpxRoutes(root, store);
    const fullHash = (store.database.prepare(
      "SELECT value FROM import_manifest WHERE key = 'source_gpx_bundle_sha256'"
    ).get() as { value: string }).value;
    assert.equal(fullHash, fingerprintBundleHash(store));

    rmSync(join(routeDirectory, "alpha.gpx"));
    writeFileSync(xmlPath, `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  ${workoutXml("2026-01-02 08:00:00 +0800", "beta.gpx")}
</HealthData>`, "utf8");
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "gpx-hash-generation-2", preserveAbsent: true }
    });
    await importGpxRoutes(root, store, { preserveAbsent: true });
    const afterHash = (store.database.prepare(
      "SELECT value FROM import_manifest WHERE key = 'source_gpx_bundle_sha256'"
    ).get() as { value: string }).value;
    const remaining = store.database.prepare(
      "SELECT relative_path AS relativePath, sha256 FROM route_file_fingerprints"
    ).all() as Array<{ relativePath: string; sha256: string }>;
    assert.equal(remaining.length, 2);
    assert.equal(afterHash, fullHash);
    assert.equal(afterHash, fingerprintBundleHash(store));
    assert.notEqual(
      afterHash,
      archiveBundleHash(remaining.filter((row) => row.relativePath.endsWith("beta.gpx")))
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserve-absent workout upsert keeps GPS when HealthKit omits WorkoutRoute", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-preserve-route-omit-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  const routeDirectory = join(root, "workout-routes");
  mkdirSync(routeDirectory);
  writeFileSync(join(routeDirectory, "sample.gpx"),
    `<gpx><trk><trkseg><trkpt lat="31.1" lon="121.1"/></trkseg></trk></gpx>`, "utf8");
  const withRoute = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
  <Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
    startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800"
    duration="30" durationUnit="min">
    <MetadataEntry key="HKMetadataKeySyncIdentifier" value="stable-run"/>
    <WorkoutRoute><FileReference path="/workout-routes/sample.gpx"/></WorkoutRoute>
  </Workout>
</HealthData>`;
  const withoutRoute = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
  <Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
    startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800"
    duration="31" durationUnit="min">
    <MetadataEntry key="HKMetadataKeySyncIdentifier" value="stable-run"/>
  </Workout>
</HealthData>`;
  writeFileSync(xmlPath, withRoute, "utf8");
  const store = await RaiDatabase.open(databasePath);
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    await importGpxRoutes(root, store);
    writeFileSync(xmlPath, withoutRoute, "utf8");
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "omit-route-generation-2", preserveAbsent: true }
    });
    const route = store.database.prepare(`
      SELECT point_count AS pointCount, file_status AS fileStatus FROM workout_routes
    `).get() as { pointCount: number; fileStatus: string };
    const points = store.database.prepare("SELECT COUNT(*) AS count FROM route_points").get() as { count: number };
    const duration = store.database.prepare(
      "SELECT duration_seconds AS duration FROM workouts"
    ).get() as { duration: number };
    assert.equal(route.pointCount, 1);
    assert.equal(route.fileStatus, "imported");
    assert.equal(points.count, 1);
    assert.equal(duration.duration, 1860);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserve-absent profile merge keeps existing Me keys when incoming Me is empty or a subset", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-preserve-profile-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  const first = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
  <Me HKCharacteristicTypeIdentifierDateOfBirth="1990-01-01"
      HKCharacteristicTypeIdentifierHeight="180"
      HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
  <Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
    startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800"
    duration="30" durationUnit="min"/>
</HealthData>`;
  const subset = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
  <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
  <Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
    startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800"
    duration="30" durationUnit="min"/>
</HealthData>`;
  const emptyMe = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData>
  <Me/>
  <Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
    startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800"
    duration="31" durationUnit="min"/>
</HealthData>`;
  writeFileSync(xmlPath, first, "utf8");
  const store = await RaiDatabase.open(databasePath);
  const profile = (): Record<string, string> =>
    JSON.parse(
      (store.database.prepare("SELECT attributes_json AS attributesJson FROM profile WHERE id = 1")
        .get() as { attributesJson: string }).attributesJson
    ) as Record<string, string>;
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    writeFileSync(xmlPath, subset, "utf8");
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "profile-generation-2", preserveAbsent: true }
    });
    let attributes = profile();
    assert.equal(attributes.HKCharacteristicTypeIdentifierDateOfBirth, "1990-01-01");
    assert.equal(attributes.HKCharacteristicTypeIdentifierHeight, "180");
    assert.equal(attributes.HKCharacteristicTypeIdentifierBiologicalSex, "HKBiologicalSexMale");

    writeFileSync(xmlPath, emptyMe, "utf8");
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "profile-generation-3", preserveAbsent: true }
    });
    attributes = profile();
    assert.equal(attributes.HKCharacteristicTypeIdentifierDateOfBirth, "1990-01-01");
    assert.equal(attributes.HKCharacteristicTypeIdentifierHeight, "180");
    assert.equal(attributes.HKCharacteristicTypeIdentifierBiologicalSex, "HKBiologicalSexMale");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental scans rebuild invalid record and GPX issues without accumulating them", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-issue-generation-"));
  const databasePath = join(root, "rai.sqlite");
  const xmlPath = join(root, "export.xml");
  const routeDirectory = join(root, "workout-routes");
  mkdirSync(routeDirectory);
  writeFileSync(join(routeDirectory, "invalid.gpx"), "<gpx><trkpt", "utf8");
  const xml = `<HealthData>
    <Record type="HKQuantityTypeIdentifierHeartRate" value="150"/>
    <Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
      startDate="2026-01-02 08:00:00 +0800" endDate="2026-01-02 08:30:00 +0800" duration="30" durationUnit="min">
      <WorkoutRoute><FileReference path="/workout-routes/invalid.gpx"/></WorkoutRoute>
    </Workout>
  </HealthData>`;
  writeFileSync(xmlPath, xml, "utf8");
  const store = await RaiDatabase.open(databasePath);
  const issueProjection = (): Array<{ code: string; objectId: string | null; message: string }> =>
    store.database.prepare(`
      SELECT code, object_id AS objectId, message FROM import_issues ORDER BY code, object_id
    `).all() as unknown as Array<{ code: string; objectId: string | null; message: string }>;
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    await importGpxRoutes(root, store);
    canonicalizeRunningWorkouts(store.database);
    const first = issueProjection();
    assert.deepEqual(first.map((issue) => issue.code), ["INVALID_GPX", "INVALID_RECORD"]);

    await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "issue-generation-2" }
    });
    await importGpxRoutes(root, store);
    canonicalizeRunningWorkouts(store.database, { dirtyWorkoutTimes: [] });
    assert.deepEqual(issueProjection(), first);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
