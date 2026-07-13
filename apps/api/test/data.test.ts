import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/health-export-parser";

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

  for (let index = 0; index < 8; index += 1) {
    const workoutId = `api_workout_${index}`;
    const start = runDate(index);
    const end = new Date(Date.parse(start) + 1_800_000).toISOString();
    insertWorkout.run(workoutId, start, end);
    insertStatistic.run(workoutId, 0, "HKQuantityTypeIdentifierDistanceWalkingRunning", "km", 5, null, null, null);
    insertStatistic.run(workoutId, 1, "HKQuantityTypeIdentifierHeartRate", "count/min", null, 145 - index, 130, 165);
    insertStatistic.run(workoutId, 2, "HKQuantityTypeIdentifierRunningSpeed", "km/hr", null, 10 + index * 0.15, 9, 11);
    insertSession.run(`api_session_${index}`, start, end, workoutId);
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
    assert.equal(detail?.workout.modelVersion, "rai-model-config-v2");
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
    assert.equal(series?.series.heartRate.totalSamples, 0);
    assert.equal(series?.series.cadence.unit, "spm");
    const diagnostics = read.diagnostics();
    assert.equal(diagnostics.privacy.coordinatesRemoved, true);
    assert.equal(diagnostics.activeModel?.calibrationFeatureIds.length, 6);
    assert.equal(JSON.stringify(diagnostics).includes("Fixture Apple Watch"), false);
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
