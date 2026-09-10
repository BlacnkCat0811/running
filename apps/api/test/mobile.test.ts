import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(today.latestDataDate, "2025-01-22");
    assert.equal(today.weekDaily.length, 7);
    assert.equal(today.weekDaily[0]?.localDate, today.week.periodStart);
    assert.equal(today.weekDaily.at(-1)?.localDate, today.week.periodEnd);
    assert.ok(today.weekDaily.every((day) => day.distanceKm >= 0));
    const todayBar = today.weekDaily.find((day) => day.localDate === today.today.localDate);
    assert.ok(todayBar, "weekDaily must include today");
    assert.equal(todayBar.distanceKm, 0);
    assert.equal(today.week.goalDistanceKm, 30);
    assert.equal(today.week.goalProgressFraction, 0);
    assert.ok(Array.isArray(today.recentWorkouts));
    assert.ok(today.recentWorkouts.length > 0 && today.recentWorkouts.length <= 5);
    assert.ok(["green", "yellow", "red"].includes(today.verdict.tone));
    assert.ok(today.nextSession.title.length > 0);
    assert.ok(today.ability.explanation.length > 0);
    assert.equal(today.weekPlan.length, 7);
    assert.ok(Array.isArray(today.injuryFlags));
    assert.ok(["need_sync", "morning_open", "locked", "post_run", "rest_done"].includes(today.phase));
    assert.equal(typeof today.lock.present, "boolean");
    assert.equal(today.verdict.stale, true, "undated recovery cannot authorize locking");

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
    assert.equal(todayPayload.weekDaily.length, 7);
    const todayBar = todayPayload.weekDaily.find((day) => day.localDate === todayPayload.today.localDate);
    assert.ok(todayBar, "weekDaily must include today");
    assert.ok(Math.abs(todayBar.distanceKm - 5.2) < 1e-9);
    assert.equal(todayBar.workoutCount, 1);
    const dailySum = todayPayload.weekDaily.reduce((sum, day) => sum + day.distanceKm, 0);
    assert.ok(Math.abs(dailySum - todayPayload.week.distanceKm) < 1e-9);
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
    assert.ok(statistics.months.length >= 2);
    assert.ok(statistics.months[0]!.month < statistics.months.at(-1)!.month);
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
  // weekly distance buckets are exact. Runs land on 2025-01-01/04/07/10/13/16/19/22.
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
    assert.equal(trends.weeks.length, 12);
    for (let index = 1; index < trends.weeks.length; index += 1) {
      const previous = Date.parse(`${trends.weeks[index - 1]!.periodStart}T00:00:00Z`);
      const current = Date.parse(`${trends.weeks[index]!.periodStart}T00:00:00Z`);
      assert.equal((current - previous) / 86_400_000, 7);
    }
    const byStart = new Map(trends.weeks.map((week) => [week.periodStart, week]));
    const weekOfJan22 = byStart.get("2025-01-20");
    assert.ok(weekOfJan22, "expected ISO week starting Monday 2025-01-20");
    assert.equal(weekOfJan22.distanceKm, 5);
    assert.equal(weekOfJan22.workoutCount, 1);
    const weekOfJan13 = byStart.get("2025-01-13");
    assert.ok(weekOfJan13, "expected ISO week starting Monday 2025-01-13");
    assert.equal(weekOfJan13.distanceKm, 15);
    assert.equal(weekOfJan13.workoutCount, 3);
    const weekOfJan6 = byStart.get("2025-01-06");
    assert.ok(weekOfJan6, "expected ISO week starting Monday 2025-01-06");
    assert.equal(weekOfJan6.distanceKm, 10);
    assert.equal(weekOfJan6.workoutCount, 2);
    assert.equal(byStart.get("2024-12-30")?.distanceKm, 10);
    assert.equal(trends.weeks.reduce((sum, week) => sum + week.workoutCount, 0), 8);
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
    assert.ok(Array.isArray(trends.ability));
    assert.ok(Array.isArray(trends.currentAbility));
    assert.equal(typeof trends.decayPoints, "number");
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
    assert.equal(written.easyDurationFloorFraction, 0.7);
    assert.equal(written.qualitySessionCap, 2);
    assert.equal(written.raceTarget, null);
    assert.equal(written.lockedSession, null);
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

test("recovery trends use the configured local calendar date at the day boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recovery-trends-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  store.close();
  const read = new RaiReadStore(databasePath);
  try {
    const result = read.recoveryTrends(2, new Date("2026-09-06T23:30:00.000Z"));
    assert.equal(result.timezone, "Asia/Shanghai");
    assert.equal(result.asOf, "2026-09-07");
    assert.deepEqual(result.days.map((point) => point.date), ["2026-09-06", "2026-09-07"]);
    assert.equal(result.latestDataDate, null);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("control goals migration commits the current goal and its history together", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-goals-control-"));
  const controlPath = join(root, "var", "rai-control.sqlite");
  try {
    const legacyPath = join(root, "var", "mobile-goals.json");
    const legacy = {
      revision: 7,
      weeklyDistanceKm: 42,
      easyDurationFloorFraction: 0.75,
      qualitySessionCap: 3,
      raceTarget: null,
      weekPlan: [],
      lockedSession: null,
      updatedAt: "2026-09-06T10:00:00.000Z"
    };
    mkdirSync(join(root, "var"), { recursive: true });
    writeFileSync(legacyPath, `${JSON.stringify(legacy)}\n`, "utf8");
    const store = new MobileGoalsStore(root, controlPath);
    try {
      assert.equal(store.read().weeklyDistanceKm, 42);
      const control = new DatabaseSync(controlPath);
      try {
        const current = control.prepare("SELECT revision FROM mobile_goals WHERE singleton = 1").get() as { revision: number };
        const history = control.prepare("SELECT COUNT(*) AS count FROM mobile_goals_history").get() as { count: number };
        assert.equal(current.revision, 0);
        assert.equal(history.count, 1);
      } finally {
        control.close();
      }
      assert.ok(existsSync(`${legacyPath}.migration-complete`));
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mobile goals store can lock today's session without dropping weekly distance", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-lock-"));
  try {
    const store = new MobileGoalsStore(root);
    store.write({ weeklyDistanceKm: 36 });
    const locked = store.lockSession({
      localDate: "2026-09-03",
      verdictTone: "yellow",
      lockedAt: "2026-09-03T01:00:00.000Z",
      session: {
        kind: "easy",
        title: "轻松跑",
        reason: "锁定",
        distanceKm: 8,
        durationMinutes: 50,
        paceSecondsPerKmLower: 330,
        paceSecondsPerKmUpper: 390,
        heartRateBpmLower: 120,
        heartRateBpmUpper: 145
      }
    });
    assert.equal(locked.weeklyDistanceKm, 36);
    assert.equal(locked.lockedSession?.localDate, "2026-09-03");
    assert.equal(locked.lockedSession?.session.kind, "easy");
    assert.equal(new MobileGoalsStore(root).read().lockedSession?.session.title, "轻松跑");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("mobile recovery uses the latest evidence date and its historical baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-mobile-recovery-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  try {
    const insert = store.database.prepare(`INSERT INTO canonical_nights
      (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank,
       has_stages, sleep_onset_at, wake_at, asleep_union_minutes, stage_minutes_json, segment_count, provenance_json)
      VALUES (?, ?, 'Asia/Shanghai', 'main', 'Watch', 'apple_watch', 1, 0, ?, ?, ?, '{}', 1, '{}')`);
    insert.run("prior-night", "2025-01-21", "2025-01-20T15:00:00Z", "2025-01-20T23:00:00Z", 480);
    insert.run("latest-night", "2025-01-22", "2025-01-21T15:00:00Z", "2025-01-21T20:00:00Z", 300);
    const read = new RaiReadStore(databasePath);
    try {
      const snapshot = read.mobileToday(30);
      assert.equal(snapshot.verdict.stale, true);
      const recovery = snapshot.recovery;
      assert.equal(recovery.lastNightSleepMinutes, 300);
      assert.equal(recovery.sleepBaselineMinutes, 480);
      assert.equal(recovery.state, "reduced");
      assert.match(recovery.note, /2025-01-22/);
      assert.doesNotMatch(recovery.note, /昨夜|今晨/);
      const date = snapshot.today.localDate;
      insert.run("today-night", date, `${date}T00:00:00+08:00`, `${date}T08:00:00+08:00`, 480);
      const current = read.mobileToday(30);
      assert.equal(current.latestDataDate, "2025-01-22");
      assert.equal(current.verdict.stale, false, "current recovery is independent of the latest run date");
    } finally { read.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
