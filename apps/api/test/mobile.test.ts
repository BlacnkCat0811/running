import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";

import { RaiReadStore } from "../src/data.js";
import { DEFAULT_WEEKLY_DISTANCE_KM, MobileGoalsStore } from "../src/mobile-goals.js";

const runDate = (index: number): string =>
  new Date(Date.UTC(2025, 0, 1 + index * 3, 0, 0, 0)).toISOString();

async function seed(path: string): Promise<RaiDatabase> {
  const store = await RaiDatabase.open(path);
  const database = store.database;
  database.prepare("INSERT INTO import_manifest (key, value) VALUES (?, ?)").run(
    "dataset_version",
    "dataset_mobile_fixture_v1"
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
    const workoutId = `mobile_workout_${index}`;
    const sessionId = `mobile_session_${index}`;
    const start = runDate(index);
    const end = new Date(Date.parse(start) + 1_800_000).toISOString();
    insertWorkout.run(workoutId, start, end);
    insertStatistic.run(workoutId, 0, "HKQuantityTypeIdentifierDistanceWalkingRunning", "km", 5, null, null, null);
    insertStatistic.run(workoutId, 1, "HKQuantityTypeIdentifierHeartRate", "count/min", null, 150, 130, 165);
    insertStatistic.run(workoutId, 2, "HKQuantityTypeIdentifierActiveEnergyBurned", "kcal", 320 + index, null, null, null);
    insertSession.run(sessionId, start, end, workoutId);
    insertOverride.run(`mobile_override_${index}`, sessionId);
  }
  const service = new RaiApplicationService(store);
  service.enqueueFullRecompute({ evaluatedAt: runDate(8), timezoneIdentifier: "UTC" });
  assert.equal(service.runNextJob()?.status, "succeeded");
  return store;
}

test("mobileToday returns zero-filled today with week series and recent workouts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-mobile-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  store.close();
  const read = new RaiReadStore(databasePath);
  try {
    const today = read.mobileToday(30);
    assert.equal(today.timezone, "Asia/Shanghai");
    // Fixture workouts are from 2025-01; "today" has no training and must zero-fill.
    assert.equal(today.today.distanceKm, 0);
    assert.equal(today.today.workoutCount, 0);
    assert.equal(today.today.paceSecondsPerKm, null);
    assert.equal(today.today.energyKcal, null);
    // Latest data date reflects the newest workout (2025-01-22), not the wall
    // clock, so lagging imports can surface a staleness hint in the UI.
    assert.equal(today.latestDataDate, "2025-01-22");
    // weekDaily covers Monday..today of the current ISO week (1..7 entries).
    assert.ok(today.weekDaily.length >= 1 && today.weekDaily.length <= 7);
    assert.ok(today.weekDaily.every((day) => day.distanceKm >= 0));
    const lastDay = today.weekDaily[today.weekDaily.length - 1];
    assert.ok(lastDay, "weekDaily must not be empty");
    assert.equal(lastDay.localDate, today.today.localDate);
    assert.equal(today.week.goalDistanceKm, 30);
    assert.equal(today.week.goalProgressFraction, 0);
    assert.ok(Array.isArray(today.recentWorkouts));
    assert.ok(today.recentWorkouts.length > 0 && today.recentWorkouts.length <= 5);

    // With a null goal there is no progress fraction either.
    const noGoal = read.mobileToday(null);
    assert.equal(noGoal.week.goalDistanceKm, null);
    assert.equal(noGoal.week.goalProgressFraction, null);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mobileToday aggregates today distance, energy and pace from active loads", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-mobile-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  // Recompute already produced one workout_training_loads row per session;
  // re-date the latest session's load row to "today" instead of inserting.
  const loadRow = store.database.prepare(`
    SELECT load.id
    FROM workout_training_loads load
    JOIN training_sessions ts ON ts.id = load.training_session_id
    WHERE load.training_metric_run_id IN (
      SELECT id FROM training_metric_runs WHERE status = 'succeeded'
    )
    ORDER BY ts.anchor_start_at DESC LIMIT 1
  `).get() as { id: string };
  assert.ok(loadRow, "fixture recompute should produce training load rows");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  // The read endpoints aggregate whatever the load rows contain; give the
  // re-dated row known distance/duration values (the fixture recompute runs in
  // a reduced environment that leaves distance_km null).
  store.database.prepare(`
    UPDATE workout_training_loads
    SET local_date = ?, timezone_identifier = 'Asia/Shanghai',
        distance_km = 5.2, duration_seconds = 1800
    WHERE id = ?
  `).run(today, loadRow.id);
  store.close();

  const read = new RaiReadStore(databasePath);
  try {
    const todayPayload = read.mobileToday(10);
    assert.ok(Math.abs(todayPayload.today.distanceKm - 5.2) < 1e-9);
    assert.equal(todayPayload.today.workoutCount, 1);
    const todayPace = todayPayload.today.paceSecondsPerKm;
    assert.ok(todayPace !== null && Math.abs(todayPace - 1800 / 5.2) < 1e-9);
    assert.ok(todayPayload.today.energyKcal !== null && todayPayload.today.energyKcal > 0);
    assert.ok(todayPayload.week.goalProgressFraction !== null && todayPayload.week.goalProgressFraction > 0);
    // weekDaily comes from daily metrics (recompute output), which the fixture
    // leaves on their original 2025-01 dates, so today's bar stays zero-filled.
    const lastDay = todayPayload.weekDaily[todayPayload.weekDaily.length - 1];
    assert.ok(lastDay, "weekDaily must not be empty");
    assert.equal(lastDay.localDate, todayPayload.today.localDate);
    assert.equal(lastDay.distanceKm, 0);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mobileStatistics returns month buckets, totals and zone distribution shape", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-mobile-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  store.close();
  const read = new RaiReadStore(databasePath);
  try {
    const statistics = read.mobileStatistics();
    assert.equal(statistics.timezone, "Asia/Shanghai");
    assert.ok(statistics.months.length >= 1 && statistics.months.length <= 3);
    const month = statistics.months[statistics.months.length - 1];
    assert.ok(month, "expected at least one month bucket");
    assert.match(month.month, /^\d{4}-\d{2}$/);
    assert.ok(month.totalDistanceKm >= month.runningDistanceKm);
    assert.ok(month.workoutCount > 0);
    assert.ok(statistics.totals.distanceKm >= 0);
    assert.ok(statistics.totals.workoutCount >= 0);
    assert.ok(Array.isArray(statistics.heartRateZones));
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mobileStatistics rolls 28-day totals anchored on the latest data date", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-mobile-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  // Fixture recompute leaves load distances null; give every load row a known
  // 5km/30min on its natural 2025-01 date (2025-01-01 .. 2025-01-22, every 3d).
  store.database.prepare(`
    UPDATE workout_training_loads
    SET distance_km = 5, duration_seconds = 1800
    WHERE distance_km IS NULL
  `).run();
  // Move the earliest load into the previous 28-day window (anchor-56, anchor-28]
  // so the change-fraction branch is exercised too.
  store.database.prepare(`
    UPDATE workout_training_loads
    SET local_date = '2024-12-10'
    WHERE id = (
      SELECT load.id
      FROM workout_training_loads load
      JOIN training_sessions ts ON ts.id = load.training_session_id
      WHERE load.training_metric_run_id IN (
        SELECT id FROM training_metric_runs WHERE status = 'succeeded'
      )
      ORDER BY ts.anchor_start_at ASC LIMIT 1
    )
  `).run();
  store.close();

  const read = new RaiReadStore(databasePath);
  try {
    const statistics = read.mobileStatistics();
    // Anchor = MAX(local_date) = 2025-01-22. The wall clock (2026-09) is far
    // ahead, so these assertions fail if the query reverts to wall-clock
    // anchoring: current window (anchor-28, anchor] = 7 x 5km = 35km and the
    // previous window (anchor-56, anchor-28] holds exactly the moved 5km run.
    assert.equal(statistics.totals.distanceKm, 35);
    assert.equal(statistics.totals.workoutCount, 7);
    assert.ok(statistics.totals.averagePaceSecondsPerKm !== null);
    const change = statistics.totals.distanceChangeFraction;
    assert.ok(change !== null, "previous window has 5km so a fraction must exist");
    assert.ok(Math.abs(change - 6) < 1e-9);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mobileTrends returns weeks, personal records and insights", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-mobile-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  // Fixture recompute leaves load distances null; give every load row 5km so
  // weekly distance buckets are exact. Runs land on 2025-01-01/04/07/10/13/16/19/22,
  // anchored at 2025-01-22: anchor week (01-16..01-22) holds 3 runs = 15km,
  // the previous week (01-09..01-15) holds 2 runs = 10km.
  store.database.prepare(`
    UPDATE workout_training_loads
    SET distance_km = 5
    WHERE distance_km IS NULL
  `).run();
  store.close();
  const read = new RaiReadStore(databasePath);
  try {
    const trends = read.mobileTrends();
    assert.equal(trends.timezone, "Asia/Shanghai");
    assert.ok(trends.weeks.length >= 1 && trends.weeks.length <= 12);
    const byStart = new Map(trends.weeks.map((week) => [week.periodStart, week]));
    // Anchor week (2025-01-16..2025-01-22) must aggregate 3 x 5km, not one
    // per-day group: guards against the julianday float-division regression
    // that split weeks into single-day buckets.
    const anchorWeek = byStart.get("2025-01-13");
    assert.ok(anchorWeek, "expected the anchor week starting Monday 2025-01-13");
    assert.equal(anchorWeek.distanceKm, 15);
    assert.equal(anchorWeek.workoutCount, 3);
    const previousWeek = byStart.get("2025-01-06");
    assert.ok(previousWeek, "expected the previous week starting Monday 2025-01-06");
    assert.equal(previousWeek.distanceKm, 10);
    assert.equal(previousWeek.workoutCount, 2);
    assert.equal(trends.weeks.reduce((sum, week) => sum + week.workoutCount, 0), 8);
    // Every listed week ended before the current calendar week → all complete.
    assert.ok(trends.weeks.every((week) => week.isComplete));
    for (const week of trends.weeks) {
      assert.match(week.periodStart, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(week.distanceKm >= 0);
    }
    // Fixture has 8 eligible 5 km workouts at 1800 s → 360 s/km pace record.
    assert.ok(trends.records.fastest5k, "expected a 5k record from the fixture");
    assert.ok(Math.abs(trends.records.fastest5k!.paceSecondsPerKm - 360) < 1e-6);
    assert.equal(trends.records.fastest10k, null);
    assert.ok(trends.records.longestDistance !== null);
    assert.ok(Math.abs(trends.records.longestDistance!.distanceKm - 5) < 1e-9);
    assert.ok(Array.isArray(trends.insights));
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mobile goals store persists, clamps and recovers from corrupt files", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-goals-"));
  try {
    const store = new MobileGoalsStore(root);
    // Defaults before any write; var/ may not exist yet.
    const initial = store.read();
    assert.equal(initial.weeklyDistanceKm, DEFAULT_WEEKLY_DISTANCE_KM);
    assert.ok(!existsSync(join(root, "var", "mobile-goals.json")));

    const written = store.write({ weeklyDistanceKm: 42.5 });
    assert.equal(written.weeklyDistanceKm, 42.5);
    assert.ok(written.updatedAt > initial.updatedAt);
    // Round-trips through a fresh store instance (simulated restart).
    const reloaded = new MobileGoalsStore(root).read();
    assert.equal(reloaded.weeklyDistanceKm, 42.5);

    // Values are clamped into [1, 500].
    assert.equal(new MobileGoalsStore(root).write({ weeklyDistanceKm: 9999 }).weeklyDistanceKm, 500);
    assert.equal(new MobileGoalsStore(root).write({ weeklyDistanceKm: 0.2 }).weeklyDistanceKm, 1);

    // Corrupt file falls back to defaults instead of throwing.
    writeFileSync(join(root, "var", "mobile-goals.json"), "{not json", "utf8");
    const recovered = new MobileGoalsStore(root).read();
    assert.equal(recovered.weeklyDistanceKm, DEFAULT_WEEKLY_DISTANCE_KM);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
