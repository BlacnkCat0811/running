import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workoutTypes } from "@rai/contracts";

import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { canonicalizeRunningWorkouts } from "../src/canonicalize.js";
import { RaiDatabase } from "../src/database.js";
import { importGpxRoutes } from "../src/gpx-parser.js";

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
