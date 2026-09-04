import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";

import { RaiReadStore } from "../src/data.js";

const runDate = (index: number): string =>
  new Date(Date.UTC(2025, 0, 1 + index * 3, 0, 0, 0)).toISOString();

async function seed(path: string): Promise<RaiDatabase> {
  const store = await RaiDatabase.open(path);
  const database = store.database;
  database.prepare("INSERT INTO import_manifest (key, value) VALUES (?, ?)").run(
    "dataset_version",
    "dataset_api_fixture_v1"
  );
  const insertWorkout = database.prepare(`
    INSERT INTO workouts (
      id, activity_type, source_name, source_category, source_version, device,
      start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json,
      is_canonical
    ) VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture Apple Watch', 'apple_watch',
      '1', 'Watch', ?, ?, 1800, 0, '{}', '{}', 1)
  `);
  const insertStatistic = database.prepare(`
    INSERT INTO workout_statistics (
      workout_id, ordinal, type, unit, sum_value, average_value, minimum_value, maximum_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSession = database.prepare(`
    INSERT INTO training_sessions (
      id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
      canonical_workout_id, status
    ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 5, ?, 'active')
  `);

  const insertOverride = database.prepare(`
    INSERT INTO workout_overrides (
      id, training_session_id, revision, eligibility_override, session_type,
      statistics_participation, performance_protocol, rpe, condition_tags_json, note
    ) VALUES (?, ?, 1, 'include', NULL, NULL, NULL, NULL, '[]', NULL)
  `);
  for (let index = 0; index < 8; index += 1) {
    const workoutId = `api_workout_${index}`;
    const sessionId = `api_session_${index}`;
    const start = runDate(index);
    const end = new Date(Date.parse(start) + 1_800_000).toISOString();
    insertWorkout.run(workoutId, start, end);
    insertStatistic.run(workoutId, 0, "HKQuantityTypeIdentifierDistanceWalkingRunning", "km", 5, null, null, null);
    insertStatistic.run(workoutId, 1, "HKQuantityTypeIdentifierHeartRate", "count/min", null, 145 - index, 130, 165);
    insertStatistic.run(workoutId, 2, "HKQuantityTypeIdentifierRunningSpeed", "km/hr", null, 10 + index * 0.15, 9, 11);
    insertSession.run(sessionId, start, end, workoutId);
    // Stats-only HR is trial after R3-16; force include so fixture recompute can calibrate.
    insertOverride.run(`api_override_${index}`, sessionId);
  }
  const service = new RaiApplicationService(store);
  service.enqueueFullRecompute({ evaluatedAt: runDate(8), timezoneIdentifier: "UTC" });
  assert.equal(service.runNextJob()?.status, "succeeded");
  return store;
}

test("maps active SQLite results into Web API DTOs", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-api-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  store.close();
  const fixtureWriter = new DatabaseSync(databasePath);
  try {
    const insertRecord = fixtureWriter.prepare(`
      INSERT INTO health_records (
        id, type, source_name, source_category, unit, value_numeric,
        start_at, end_at, metadata_json, raw_attributes_json
      ) VALUES (?, ?, 'Fixture Apple Watch', 'apple_watch', ?, ?, ?, ?, '{}', '{}')
    `);
    const workoutStart = Date.parse(runDate(7));
    for (let kilometer = 0; kilometer < 5; kilometer += 1) {
      const start = new Date(workoutStart + kilometer * 360_000).toISOString();
      const end = new Date(workoutStart + (kilometer + 1) * 360_000).toISOString();
      insertRecord.run(`speed_${kilometer}`, "HKQuantityTypeIdentifierRunningSpeed", "km/hr", 10, start, end);
      insertRecord.run(`heart_${kilometer}`, "HKQuantityTypeIdentifierHeartRate", "count/min", 140 + kilometer, start, end);
      insertRecord.run(`steps_${kilometer}`, "HKQuantityTypeIdentifierStepCount", "count", 960, start, end);
      insertRecord.run(`steps_duplicate_${kilometer}`, "HKQuantityTypeIdentifierStepCount", "count", 960, start, end);
    }
  } finally {
    fixtureWriter.close();
  }
  const read = new RaiReadStore(databasePath);
  try {
    const dashboard = read.dashboard();
    assert.equal(dashboard.activeModel?.active, true);
    assert.equal(dashboard.activeModel?.featureCount, 8);
    assert.equal(dashboard.activeModel?.assessmentCount, 8);
    assert.ok((dashboard.activeModel?.snapshotCount ?? 0) > 0);
    assert.equal(dashboard.totals.sessions, 8);
    assert.equal(dashboard.latestWorkout?.id, "api_session_7");
    assert.equal(dashboard.calibration.status, "completed");
    assert.equal(dashboard.calibration.eligibleSessions, 8);

    const workouts = read.workouts({ limit: 3, offset: 0 });
    assert.equal(workouts.total, 8);
    assert.equal(workouts.items.length, 3);
    assert.ok(workouts.items.every((item) => typeof item.stimulusType === "string"));
    const stimulusFiltered = read.workouts({
      limit: 10,
      offset: 0,
      stimulusType: workouts.items[0]?.stimulusType ?? "unclassified"
    });
    assert.ok(stimulusFiltered.items.length > 0);
    const filtered = read.workouts({ limit: 10, offset: 0, participation: "included", environment: "outdoor", sourceGroup: "apple_watch", days: 28 });
    assert.ok(filtered.total > 0);
    assert.ok(filtered.items.every((item) => item.indoor === false && item.sourceCategory === "apple_watch"));

    const detail = read.workout("api_session_7");
    assert.equal(detail?.workout.distanceKm, 5);
    assert.equal(detail?.workout.hasRoute, false);
    assert.equal(detail?.workout.elapsedSeconds, 1800);
    assert.equal(detail?.workout.modelVersion, "rai-model-config-v3");
    assert.equal(detail?.dimensions.cardio !== null, true);
    assert.ok(detail?.trainingLoad);
    assert.equal(detail?.trainingLoad?.trainingSessionId, "api_session_7");
    assert.ok((detail?.trainingLoad?.load ?? 0) > 0);
    assert.ok(detail?.zoneSummary);
    assert.equal(detail?.zoneProfile?.id, detail?.zoneSummary?.zoneProfileId);
    assert.equal(detail?.workout.stimulusType, detail?.zoneSummary?.stimulusType);
    assert.equal(detail?.trainingLoad?.breakdown.compositeLoad, detail?.trainingLoad?.load);

    const zones = read.trainingZonesCurrent();
    assert.ok(zones);
    assert.equal(zones?.profile.heartRateBands.length, 5);
    assert.equal(zones?.profile.paceBands.length, 5);
    assert.equal(zones?.settings.revision, 0);
    const zoneHistory = read.trainingZonesHistory(90);
    assert.ok(zoneHistory.profiles.length > 0);
    assert.ok(zoneHistory.profiles.length <= 90);

    const statistics = read.trainingStatisticsOverview();
    assert.ok(statistics.status);
    assert.ok((statistics.week?.distanceMeters ?? 0) > 0);
    assert.ok((statistics.month?.workoutCount ?? 0) > 0);
    assert.ok((statistics.year?.totalLoad ?? 0) > 0);
    assert.ok((statistics.year?.stimulusDistribution.length ?? 0) > 0);
    const weekly = read.trainingStatisticsHistory("week", 12);
    assert.equal(weekly.granularity, "week");
    assert.equal(weekly.periods.length, 12);
    const loadTimeline = read.trainingLoadTimeline(180);
    assert.ok(loadTimeline.days.length > 0);
    assert.ok(loadTimeline.components.length > 0);

    const trends = read.trends(84);
    assert.ok(trends.daily.length > 0);
    assert.ok(trends.workouts.length > 0);
    assert.ok(trends.context.length > 0);
    assert.equal(trends.modelRuns.length, 1);
    const modelRuns = read.modelRuns();
    assert.equal(modelRuns[0]?.active, true);
    const comparison = read.compareModelRuns(modelRuns[0]?.id ?? "", modelRuns[0]?.id ?? "");
    assert.equal(comparison?.metrics.matchedSessions, 8);
    assert.equal(comparison?.metrics.currentAbilityMeanDelta, 0);
    assert.equal(comparison?.metrics.finalTrueAbilityDelta, 0);
    const audit = read.dataAudit();
    assert.equal(audit.canonical.workouts, 8);
    assert.equal(audit.canonical.canonicalWorkouts, 8);
    assert.equal(audit.canonical.trainingSessions, 8);
    assert.deepEqual(audit.sessionStatuses, [{ status: "active", count: 8 }]);
    const series = read.workoutSeries("api_session_7");
    assert.equal(series?.sourceCategory, "apple_watch");
    assert.equal(series?.series.heartRate.totalSamples, 5);
    assert.equal(series?.series.cadence.unit, "spm");
    assert.equal(series?.series.cadence.totalSamples, 5);
    assert.equal(series?.splits.length, 5);
    assert.equal(series?.splits[0]?.distanceMeters, 1000);
    assert.equal(series?.splits[0]?.durationSeconds, 360);
    assert.equal(series?.splits[0]?.averagePaceSecondsPerKm, 360);
    assert.equal(series?.splits[0]?.averageHeartRateBpm, 140);
    assert.equal(series?.splits[0]?.averageCadenceSpm, 160);
    assert.equal(series?.splits[4]?.averageHeartRateBpm, 144);
    const diagnostics = read.diagnostics();
    assert.equal(diagnostics.privacy.coordinatesRemoved, true);
    assert.equal(diagnostics.activeModel?.calibrationFeatureIds.length, 6);
    assert.equal(JSON.stringify(diagnostics).includes("Fixture Apple Watch"), false);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses stored Shanghai local dates for trend windows and context", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-api-trend-local-date-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  const database = store.database;
  try {
    const end = database.prepare(
      "SELECT MAX(local_date) AS localDate FROM active_daily_ability_snapshots"
    ).get() as { localDate: string };
    const previous = new Date(`${end.localDate}T00:30:00+08:00`).toISOString();
    database.prepare(`
      UPDATE workout_features SET workout_start_at = ? WHERE training_session_id = 'api_session_7'
    `).run(previous);
    database.prepare(`
      UPDATE workout_training_loads SET local_date = ? WHERE training_session_id = 'api_session_7'
    `).run(end.localDate);
    database.prepare("UPDATE model_runs SET evaluated_at = ?").run(previous);
  } finally {
    store.close();
  }
  const read = new RaiReadStore(databasePath);
  try {
    const trends = read.trends(1);
    assert.ok(trends.workouts.some((workout) => workout.id === "api_session_7"));
    assert.ok(trends.context.some((entry) => entry.date === trends.endDate));
    assert.equal(trends.modelRuns.length, 1);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("omits kilometer splits when running-speed coverage cannot represent the workout", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-api-sparse-splits-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  const workoutStart = Date.parse(runDate(7));
  store.database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric,
      start_at, end_at, metadata_json, raw_attributes_json
    ) VALUES (
      'sparse_speed', 'HKQuantityTypeIdentifierRunningSpeed',
      'Fixture Apple Watch', 'apple_watch', 'km/hr', 10, ?, ?, '{}', '{}'
    )
  `).run(
    new Date(workoutStart).toISOString(),
    new Date(workoutStart + 30_000).toISOString()
  );
  store.close();

  const read = new RaiReadStore(databasePath);
  try {
    assert.deepEqual(read.workoutSeries("api_session_7")?.splits, []);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not double-count overlapping running-speed records in kilometer splits", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-api-overlapping-splits-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  const workoutStart = Date.parse(runDate(7));
  const insertRecord = store.database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric,
      start_at, end_at, metadata_json, raw_attributes_json
    ) VALUES (?, 'HKQuantityTypeIdentifierRunningSpeed',
      'Fixture Apple Watch', 'apple_watch', 'km/hr', 10, ?, ?, '{}', '{}')
  `);
  for (let kilometer = 0; kilometer < 5; kilometer += 1) {
    const start = new Date(workoutStart + kilometer * 360_000).toISOString();
    const end = new Date(workoutStart + (kilometer + 1) * 360_000).toISOString();
    insertRecord.run(`speed-primary-${kilometer}`, start, end);
    insertRecord.run(`speed-duplicate-${kilometer}`, start, end);
  }
  store.close();

  const read = new RaiReadStore(databasePath);
  try {
    const splits = read.workoutSeries("api_session_7")?.splits;
    assert.equal(splits?.length, 5);
    assert.deepEqual(splits?.map((split) => split.durationSeconds), [360, 360, 360, 360, 360]);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("includes metric intervals crossing the workout start in the first kilometer split", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-api-crossing-splits-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  const workoutStart = Date.parse(runDate(7));
  const insertRecord = store.database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric,
      start_at, end_at, metadata_json, raw_attributes_json
    ) VALUES (?, ?, 'Fixture Apple Watch', 'apple_watch', ?, ?, ?, ?, '{}', '{}')
  `);
  for (let kilometer = 0; kilometer < 5; kilometer += 1) {
    const start = new Date(workoutStart + kilometer * 360_000 - (kilometer === 0 ? 60_000 : 0)).toISOString();
    const end = new Date(workoutStart + (kilometer + 1) * 360_000).toISOString();
    insertRecord.run(`crossing-speed-${kilometer}`, "HKQuantityTypeIdentifierRunningSpeed", "km/hr", 10, start, end);
    insertRecord.run(`crossing-heart-${kilometer}`, "HKQuantityTypeIdentifierHeartRate", "count/min", 150 + kilometer, start, end);
    insertRecord.run(`crossing-steps-${kilometer}`, "HKQuantityTypeIdentifierStepCount", "count", 960, start, end);
  }
  // These retain the existing point/invalid-end inference semantics but must not
  // cause an old pre-workout point to be inferred into the workout.
  insertRecord.run(
    "old-invalid-speed",
    "HKQuantityTypeIdentifierRunningSpeed",
    "km/hr",
    10,
    new Date(workoutStart - 120_000).toISOString(),
    "invalid"
  );
  store.close();

  const read = new RaiReadStore(databasePath);
  try {
    const splits = read.workoutSeries("api_session_7")?.splits;
    assert.equal(splits?.length, 5);
    assert.equal(splits?.[0]?.durationSeconds, 360);
    assert.equal(splits?.[0]?.averageHeartRateBpm, 150);
    assert.equal(splits?.[0]?.averageCadenceSpm, 160);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("infers intervals for point and invalid end timestamps inside a workout", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-api-point-splits-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  const workoutStart = Date.parse(runDate(7));
  const insertSpeed = store.database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric,
      start_at, end_at, metadata_json, raw_attributes_json
    ) VALUES (?, 'HKQuantityTypeIdentifierRunningSpeed',
      'Fixture Apple Watch', 'apple_watch', 'km/hr', 10, ?, ?, '{}', '{}')
  `);
  for (let index = 0; index < 60; index += 1) {
    const start = new Date(workoutStart + index * 30_000).toISOString();
    insertSpeed.run(`point-speed-${index}`, start, index % 2 === 0 ? start : "invalid");
  }
  store.close();

  const read = new RaiReadStore(databasePath);
  try {
    const splits = read.workoutSeries("api_session_7")?.splits;
    assert.equal(splits?.length, 5);
    assert.deepEqual(splits?.map((split) => split.durationSeconds), [360, 360, 360, 360, 360]);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshes cached summaries after another connection commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-api-cache-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  store.close();
  const read = new RaiReadStore(databasePath);
  try {
    assert.deepEqual(read.dataSummary().issues, []);
    const writer = new DatabaseSync(databasePath);
    try {
      writer.prepare(`
        INSERT INTO import_issues (severity, code, message)
        VALUES ('warning', 'cache_fixture', 'fixture')
      `).run();
    } finally {
      writer.close();
    }
    assert.deepEqual(read.dataSummary().issues, [{ severity: "warning", count: 1 }]);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds workout route and metric samples in SQL while preserving totals and endpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-api-sampling-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  const database = store.database;
  const workoutId = "api_workout_7";
  const sessionId = "api_session_7";
  const startedAt = runDate(7);
  database.prepare(`
    INSERT INTO workout_routes (
      id, workout_id, source_name, source_category, relative_path, metadata_json, point_count, file_status
    ) VALUES ('sampling-route', ?, 'Fixture Apple Watch', 'apple_watch', 'sampling.gpx', '{}', 1001, 'imported')
  `).run(workoutId);
  const insertRoutePoint = database.prepare(`
    INSERT INTO route_points (route_id, sequence, timestamp, latitude, longitude, elevation_meters, speed_mps)
    VALUES ('sampling-route', ?, ?, ?, ?, ?, 3)
  `);
  const insertHeartRate = database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json
    ) VALUES (?, 'HKQuantityTypeIdentifierHeartRate', 'Fixture Apple Watch', 'apple_watch', 'count/min', ?, ?, ?, '{}', '{}')
  `);
  database.exec("BEGIN");
  try {
    for (let index = 0; index < 1201; index += 1) {
      const timestamp = new Date(Date.parse(startedAt) + index * 1000).toISOString();
      insertHeartRate.run(`sampling-heart-rate-${index}`, 120 + index % 40, timestamp, timestamp);
      if (index <= 1000) insertRoutePoint.run(index, timestamp, 31 + index / 100_000, 121, index);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  store.close();
  const read = new RaiReadStore(databasePath);
  try {
    const detail = read.workout(sessionId);
    assert.ok(detail);
    assert.ok((detail?.route.length ?? 0) <= 501);
    assert.equal(detail?.route[0]?.elevationMeters, 0);
    assert.equal(detail?.route.at(-1)?.elevationMeters, 1000);
    const series = read.workoutSeries(sessionId);
    assert.equal(series?.series.heartRate.totalSamples, 1201);
    assert.ok((series?.series.heartRate.points.length ?? 0) <= 601);
    assert.equal(series?.series.heartRate.points[0]?.offsetSeconds, 0);
    assert.equal(series?.series.heartRate.points.at(-1)?.offsetSeconds, 1200);
    assert.equal(series?.series.elevation.totalSamples, 1001);
    assert.ok((series?.series.elevation.points.length ?? 0) <= 601);
    assert.equal(series?.series.elevation.points.at(-1)?.value, 1000);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("record type audit uses the covering type-time index", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-api-plan-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  try {
    const plan = store.database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT type, COUNT(*) AS count
      FROM health_records
      GROUP BY type
      ORDER BY count DESC, type
      LIMIT 24
    `).all() as unknown as Array<{ detail: string }>;
    assert.ok(plan.some((row) => row.detail.includes("COVERING INDEX idx_health_records_type_time")));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
