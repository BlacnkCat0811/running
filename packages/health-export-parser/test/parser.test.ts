import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONTRACT_VERSION, healthTypes, workoutTypes } from "@rai/contracts";

import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { buildAudit } from "../src/audit.js";
import { canonicalizeRunningWorkouts } from "../src/canonicalize.js";
import { RaiDatabase } from "../src/database.js";
import { importGpxRoutes } from "../src/gpx-parser.js";
import { classifySource } from "../src/utils.js";

const appleDate = (hour: string): string => `2026-01-02 ${hour}:00 +0800`;

test("streams Health XML, imports GPX, and selects a canonical workout", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-parser-"));
  const routeDirectory = join(root, "workout-routes");
  mkdirSync(routeDirectory);
  const xmlPath = join(root, "export.xml");
  const databasePath = join(root, "rai.sqlite");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ExportDate value="${appleDate("12:00")}"/>
  <Me biologicalSex="HKBiologicalSexMale"/>
  <Record type="${healthTypes.heartRate}" sourceName="Sample Apple Watch" sourceVersion="1" unit="count/min" creationDate="${appleDate("08:00")}" startDate="${appleDate("08:00")}" endDate="${appleDate("08:01")}" value="150">
    <MetadataEntry key="sample" value="one"/>
    <MetadataEntry key="sample" value="two"/>
  </Record>
  <Workout workoutActivityType="${workoutTypes.running}" duration="30" durationUnit="min" sourceName="Sample Apple Watch" sourceVersion="1" creationDate="${appleDate("08:30")}" startDate="${appleDate("08:00")}" endDate="${appleDate("08:30")}" device="Watch">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <WorkoutEvent type="HKWorkoutEventTypePause" date="${appleDate("08:10")}">
      <MetadataEntry key="event-note" value="traffic light"/>
    </WorkoutEvent>
    <WorkoutStatistics type="${healthTypes.distanceWalkingRunning}" startDate="${appleDate("08:00")}" endDate="${appleDate("08:30")}" sum="5" unit="km"/>
    <WorkoutStatistics type="${healthTypes.heartRate}" startDate="${appleDate("08:00")}" endDate="${appleDate("08:30")}" average="150" minimum="120" maximum="170" unit="count/min"/>
    <WorkoutRoute sourceName="Sample Apple Watch" sourceVersion="1" creationDate="${appleDate("08:31")}" startDate="${appleDate("08:00")}" endDate="${appleDate("08:30")}">
      <FileReference path="/workout-routes/sample.gpx"/>
    </WorkoutRoute>
  </Workout>
  <Workout workoutActivityType="${workoutTypes.running}" duration="30.1" durationUnit="min" sourceName="Connect" sourceVersion="1" creationDate="${appleDate("08:31")}" startDate="${appleDate("08:00")}" endDate="${appleDate("08:30")}">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <WorkoutStatistics type="${healthTypes.distanceWalkingRunning}" startDate="${appleDate("08:00")}" endDate="${appleDate("08:30")}" sum="5.01" unit="km"/>
  </Workout>
  <ActivitySummary dateComponents="2026-01-02" activeEnergyBurned="500" activeEnergyBurnedGoal="600" activeEnergyBurnedUnit="kcal"/>
</HealthData>`;
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Health">
  <trk><trkseg>
    <trkpt lat="31.1" lon="121.1"><ele>5</ele><time>2026-01-02T00:00:00Z</time><extensions><speed>2.5</speed><hAcc>4</hAcc></extensions></trkpt>
    <trkpt lat="31.2" lon="121.2"><ele>6</ele><time>2026-01-02T00:00:05Z</time><extensions><speed>2.6</speed><hAcc>4</hAcc></extensions></trkpt>
  </trkseg></trk>
</gpx>`;
  writeFileSync(xmlPath, xml, "utf8");
  writeFileSync(join(routeDirectory, "sample.gpx"), gpx, "utf8");

  const store = await RaiDatabase.open(databasePath);
  try {
    const xmlResult = await parseAppleHealthXml(xmlPath, store, {
      fileSize: Buffer.byteLength(xml)
    });
    assert.equal(xmlResult.recordCount, 1);
    assert.equal(xmlResult.workoutCount, 2);
    assert.equal(xmlResult.activitySummaryCount, 1);
    const parserContract = store.database
      .prepare("SELECT value FROM import_manifest WHERE key = 'parser_contract_version'")
      .get() as unknown as { value: string };
    assert.equal(parserContract.value, CONTRACT_VERSION);

    const routeResult = await importGpxRoutes(root, store);
    assert.equal(routeResult.importedRouteCount, 1);
    assert.equal(routeResult.pointCount, 2);

    const canonical = canonicalizeRunningWorkouts(store.database);
    assert.equal(canonical.groupCount, 1);
    assert.equal(canonical.duplicateGroupCount, 1);
    assert.equal(canonical.excludedDuplicateCount, 1);
    const initialSession = store.database
      .prepare("SELECT training_session_id AS trainingSessionId FROM workout_groups")
      .get() as unknown as { trainingSessionId: string };
    canonicalizeRunningWorkouts(store.database);
    const rebuiltSession = store.database
      .prepare("SELECT training_session_id AS trainingSessionId FROM workout_groups")
      .get() as unknown as { trainingSessionId: string };
    assert.equal(rebuiltSession.trainingSessionId, initialSession.trainingSessionId);

    const canonicalSource = store.database
      .prepare(
        "SELECT source_category AS sourceCategory FROM workouts WHERE is_canonical = 1"
      )
      .get() as unknown as { sourceCategory: string };
    assert.equal(canonicalSource.sourceCategory, "apple_watch");

    const metadata = store.database
      .prepare("SELECT metadata_json AS metadataJson FROM health_records")
      .get() as unknown as { metadataJson: string };
    assert.deepEqual(JSON.parse(metadata.metadataJson), { sample: ["one", "two"] });
    const workoutMetadata = store.database.prepare(`
      SELECT metadata_json AS metadataJson FROM workouts WHERE source_name = 'Sample Apple Watch'
    `).get() as unknown as { metadataJson: string };
    assert.deepEqual(JSON.parse(workoutMetadata.metadataJson), { HKIndoorWorkout: ["0"] });
    const eventMetadata = store.database.prepare(`
      SELECT metadata_json AS metadataJson FROM workout_events
    `).get() as unknown as { metadataJson: string };
    assert.deepEqual(JSON.parse(eventMetadata.metadataJson), { "event-note": ["traffic light"] });

    const audit = buildAudit(store.database);
    assert.equal(audit.running.rawWorkouts, 2);
    assert.equal(audit.running.canonicalWorkouts, 1);
    assert.equal(audit.running.withRoute, 1);
    assert.equal(audit.readiness.goldAppleWatchOutdoor, 1);

    const routePath = join(routeDirectory, "sample.gpx");
    const originalTimes = statSync(routePath);
    const changedGpx = gpx.replace('lat="31.1"', 'lat="32.1"');
    assert.equal(Buffer.byteLength(changedGpx), Buffer.byteLength(gpx));
    writeFileSync(routePath, changedGpx, "utf8");
    utimesSync(routePath, originalTimes.atime, originalTimes.mtime);
    const changedRouteResult = await importGpxRoutes(root, store);
    assert.equal(changedRouteResult.importedRouteCount, 1);
    assert.equal(changedRouteResult.skippedRouteCount, 0);
    const changedLatitude = store.database.prepare(`
      SELECT latitude FROM route_points WHERE sequence = 0
    `).get() as unknown as { latitude: number };
    assert.equal(changedLatitude.latitude, 32.1);

    writeFileSync(routePath, "<gpx><trkpt", "utf8");
    const invalidResult = await importGpxRoutes(root, store);
    assert.equal(invalidResult.skippedRouteCount, 0);
    const invalidRoute = store.database.prepare(`
      SELECT file_status AS fileStatus, point_count AS pointCount FROM workout_routes
    `).get() as unknown as { fileStatus: string; pointCount: number };
    assert.deepEqual({ ...invalidRoute }, { fileStatus: "invalid", pointCount: 0 });

    writeFileSync(routePath, changedGpx, "utf8");
    const recoveredResult = await importGpxRoutes(root, store);
    assert.equal(recoveredResult.importedRouteCount, 1);
    assert.equal(recoveredResult.skippedRouteCount, 0);
    store.database.prepare(`
      UPDATE workout_routes SET file_status = 'invalid', point_count = 0
    `).run();
    const repairedCacheResult = await importGpxRoutes(root, store);
    assert.equal(repairedCacheResult.importedRouteCount, 1);
    assert.equal(repairedCacheResult.skippedRouteCount, 0);
    const repairedRoute = store.database.prepare(`
      SELECT file_status AS fileStatus, point_count AS pointCount FROM workout_routes
    `).get() as unknown as { fileStatus: string; pointCount: number };
    assert.deepEqual({ ...repairedRoute }, { fileStatus: "imported", pointCount: 2 });

    rmSync(routePath);
    await importGpxRoutes(root, store);
    const missingRoute = store.database.prepare(
      "SELECT point_count AS pointCount, file_status AS fileStatus FROM workout_routes"
    ).get() as unknown as { pointCount: number; fileStatus: string };
    assert.deepEqual({ ...missingRoute }, { pointCount: 0, fileStatus: "missing" });
    const remainingPoints = store.database.prepare("SELECT COUNT(*) AS count FROM route_points").get() as unknown as { count: number };
    assert.equal(remainingPoints.count, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifies vendor watches before Apple Watch and recognizes user-entered data", () => {
  assert.equal(classifySource("Huawei Health", "Huawei Watch GT"), "huawei");
  assert.equal(classifySource("COROS", "COROS PACE watch"), "coros");
  assert.equal(classifySource("Samsung Health", "Galaxy Watch"), "other");
  assert.equal(classifySource("Health", null, { HKWasUserEntered: ["1"] }), "manual");
});

test("falls back to workout dates when the exported duration is negative", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-parser-negative-duration-"));
  const xmlPath = join(root, "export.xml");
  writeFileSync(xmlPath, `<HealthData><Workout workoutActivityType="${workoutTypes.running}"
    sourceName="Watch" startDate="${appleDate("08:00")}" endDate="${appleDate("08:30")}"
    duration="-30" durationUnit="min"/></HealthData>`, "utf8");
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const result = await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    const workout = store.database.prepare(
      "SELECT duration_seconds AS durationSeconds FROM workouts"
    ).get() as unknown as { durationSeconds: number };
    assert.equal(result.workoutCount, 1);
    assert.equal(workout.durationSeconds, 1800);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("imports a GPX file whose on-disk name contains uppercase characters", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-parser-gpx-case-"));
  const routeDirectory = join(root, "workout-routes");
  mkdirSync(routeDirectory);
  const xmlPath = join(root, "export.xml");
  writeFileSync(xmlPath, `<HealthData><Workout workoutActivityType="${workoutTypes.running}"
    sourceName="Watch" startDate="${appleDate("08:00")}" endDate="${appleDate("08:30")}" duration="30" durationUnit="min">
    <WorkoutRoute><FileReference path="/workout-routes/Route-A.GPX"/></WorkoutRoute>
  </Workout></HealthData>`, "utf8");
  writeFileSync(join(routeDirectory, "Route-A.GPX"),
    `<gpx><trk><trkseg><trkpt lat="31.1" lon="121.1"/></trkseg></trk></gpx>`, "utf8");
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    const result = await importGpxRoutes(root, store);
    assert.equal(result.importedRouteCount, 1);
    assert.equal(result.missingRouteCount, 0);
    const route = store.database
      .prepare("SELECT workout_id, point_count, file_status FROM workout_routes")
      .get() as unknown as { workout_id: string | null; point_count: number; file_status: string };
    assert.ok(route.workout_id);
    assert.equal(route.file_status, "imported");
    assert.equal(route.point_count, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rolls back the entire XML import when parsing fails after a batch boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-parser-atomic-"));
  const xmlPath = join(root, "broken.xml");
  const databasePath = join(root, "rai.sqlite");
  const records = Array.from({ length: 5_001 }, (_, index) =>
    `<Record type="${healthTypes.heartRate}" sourceName="Watch" unit="count/min" startDate="${appleDate("08:00")}" endDate="${appleDate("08:01")}" value="${120 + index % 20}"/>`
  ).join("");
  writeFileSync(xmlPath, `<HealthData>${records}<Record`, "utf8");
  const store = await RaiDatabase.open(databasePath);
  try {
    await assert.rejects(parseAppleHealthXml(xmlPath, store, { fileSize: 1 }));
    const count = store.database.prepare("SELECT COUNT(*) AS count FROM health_records").get() as unknown as { count: number };
    assert.equal(count.count, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
