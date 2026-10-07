import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";

import type {
  MobileNextSession,
  MobileSessionStructure,
  TrainingZonesCurrentResponse
} from "@rai/api-contracts";

import { RaiReadStore, mobileLocalDate } from "../src/data.js";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { DEFAULT_EASY_DURATION_FLOOR, DEFAULT_QUALITY_SESSION_CAP, buildSessionStructure, measureStructure, pacesFromZones, roundKm } from "../src/mobile-coach.js";
import { assembleMobileWorkoutPlan, recommendationAdjustmentReason, zonePrescription } from "../src/mobile-read.js";
import { MAX_PLANNED_DISTANCE_KM } from "../src/session-structure.js";

test("legacy-day protection survives confirmation and restart, expires by Shanghai date, and keeps live gates", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-06T04:00:00Z") });
  const root = mkdtempSync(join(tmpdir(), "rai-preserved-day-read-"));
  const databasePath = join(root, "rai.sqlite");
  (await RaiDatabase.open(databasePath)).close();
  const controlPath = join(root, "var", "control.sqlite");
  let goalsStore = new MobileGoalsStore(root, controlPath);
  let read = new RaiReadStore(databasePath);
  try {
    const today = mobileLocalDate();
    goalsStore.write({ weekPlan: [today, "2026-10-07"].map(localDate => ({
      localDate, kind: "easy", distanceKm: 8, reason: "旧处方"
    })), weekPlanAudit: { generatedBy: "llm", model: "legacy", promptVersion: "v1", generatedAt: null } });
    const pending = goalsStore.retireLegacyModelPlan(today);
    assert.equal(pending.weekPlanPreservedDate, today);
    const current = read.mobileToday(pending);
    assert.equal(current.nextSession.distanceKm, 8);
    const offered = read.mobileWorkoutPlan(pending);
    assert.equal(offered.days[0]?.distanceKm, 8);
    assert.equal(offered.days[0]?.executable, true);
    assert.equal(read.mobileWeeklyPlanInputs(pending).weeklyVolumeBaselineKm, 5, "protection must not enlarge future capacity");

    const taperGoals = { ...pending, raceTarget: { date: "2026-10-07", distance: "ten_k" as const, targetPaceSecondsPerKm: 330 } };
    const taper = read.mobileToday(taperGoals);
    assert.ok(taper.nextSession.distanceKm! < 8, "live taper policy can still shorten the protected day");
    assert.equal(read.mobileWorkoutPlan(taperGoals).days[0]?.distanceKm, taper.nextSession.distanceKm);
    const quality = read.mobileToday({ ...pending, weekPlan: [{ localDate: today, kind: "interval", distanceKm: 8 }] });
    assert.notEqual(quality.nextSession.kind, "interval", "incomplete calibration still vetoes legacy quality work");

    const confirmed = goalsStore.write({ expectedRevision: pending.revision, weekPlan: pending.weekPlan,
      weekPlanAudit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: null }
    }, { confirmCoachPlan: true });
    assert.equal(read.mobileToday(confirmed).nextSession.distanceKm, 8);
    assert.equal(read.mobileWorkoutPlan(confirmed).days[0]?.source, "llm");
    read.close();
    goalsStore.close();
    goalsStore = new MobileGoalsStore(root, controlPath);
    read = new RaiReadStore(databasePath);
    assert.equal(read.mobileToday(goalsStore.read()).nextSession.distanceKm, 8, "restart cannot lose the preserved day");

    context.mock.timers.setTime(Date.parse("2026-10-06T16:01:00Z"));
    assert.equal(mobileLocalDate(), "2026-10-07");
    const nextDay = { ...goalsStore.read(), weekPlan: [{ localDate: "2026-10-07", kind: "easy" as const, distanceKm: 8 }] };
    assert.equal(read.mobileToday(nextDay).nextSession.distanceKm, 5, "yesterday's legacy protection must not widen today's budget");
    assert.equal(read.mobileWorkoutPlan(nextDay).days[0]?.source, "heuristic");
  } finally {
    read.close();
    goalsStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
    const today = read.mobileToday();
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
    assert.ok(Array.isArray(today.recentWorkouts));
    assert.ok(today.recentWorkouts.length > 0 && today.recentWorkouts.length <= 5);
    assert.ok(["green", "yellow", "red"].includes(today.verdict.tone));
    // §13.3：版本化决策输出必须随 payload 一起发出，且与 legacy 投影**同源**。
    // 断言三件事：字段在、tone 逐字等于 verdict、action 是已声明取值或刻意的 null。
    assert.ok(today.decision, "the versioned decision must be on the payload");
    assert.equal(today.decision.version, "rai-coach-v2.0.0");
    assert.equal(today.decision.tone, today.verdict.tone, "tone must come from the same verdict");
    assert.ok(
      today.decision.action === null
      || ["keep_plan", "reduce_intensity", "reduce_duration", "easy_only", "rest", "collect_evidence"]
        .includes(today.decision.action),
      `undeclared action: ${String(today.decision.action)}`
    );
    assert.ok(today.decision.reasons.some((reason) => reason.code.startsWith("plan_disposition_")));
    // 快照身份只放真实存在的类别：readiness 缺席时它不出现，而不是填空串。
    for (const id of today.decision.inputSnapshotIds) assert.notEqual(id.trim(), "");
    assert.ok(today.nextSession.title.length > 0);
    assert.ok(today.ability.explanation.length > 0);
    assert.equal(today.weekPlan.length, 7);
    assert.ok(Array.isArray(today.injuryFlags));
    assert.ok(["need_sync", "morning_open", "locked", "post_run", "rest_done"].includes(today.phase));
    assert.equal(typeof today.lock.present, "boolean");
    // `verdict.stale` no longer gates `POST /v1/mobile/lock` (a missing night must not
    // block confirming an arrangement). What it still carries is the safety rule that
    // undated recovery cannot authorize a quality session.
    assert.equal(today.verdict.stale, true, "undated recovery cannot authorize a quality session");

    const observed = read.mobileToday(undefined, []);
    assert.equal(observed.recentPlanExecution?.length, 7);
    assert.ok(observed.recentPlanExecution?.every((day) => day.localDate < observed.today.localDate));
    assert.deepEqual(observed.weekPlan, today.weekPlan, "historical observations do not change today's executable plan");
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the top-level data date and the coverage date cannot drift apart", async () => {
  // `MobileTodayResponse` carries the newest training date twice: at the top level
  // (predating the coverage block) and as `coverage.latestTrainingDate`. Both consumers
  // are live — the iOS disclosure line reads the top-level one while the coverage panel
  // reads the nested one — so if a future edit derives them from different sources the
  // page would print two different "数据截至" dates and nothing else would notice.
  const root = mkdtempSync(join(tmpdir(), "rai-mobile-date-invariant-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  store.close();
  const read = new RaiReadStore(databasePath);
  try {
    const today = read.mobileToday();
    assert.equal(today.latestDataDate, "2025-01-22");
    assert.equal(today.coverage.latestTrainingDate, today.latestDataDate);
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
    const todayPayload = read.mobileToday();
    assert.ok(Math.abs(todayPayload.today.distanceKm - 5.2) < 1e-9);
    assert.equal(todayPayload.today.workoutCount, 1);
    const todayPace = todayPayload.today.paceSecondsPerKm;
    assert.ok(todayPace !== null && Math.abs(todayPace - 1800 / 5.2) < 1e-9);
    assert.ok(todayPayload.today.energyKcal !== null && todayPayload.today.energyKcal > 0);
    assert.equal(todayPayload.weekDaily.length, 7);
    const todayBar = todayPayload.weekDaily.find((day) => day.localDate === todayPayload.today.localDate);
    assert.ok(todayBar, "weekDaily must include today");
    assert.ok(Math.abs(todayBar.distanceKm - 5.2) < 1e-9);
    assert.equal(todayBar.workoutCount, 1);
    const dailySum = todayPayload.weekDaily.reduce((sum, day) => sum + day.distanceKm, 0);
    assert.ok(Math.abs(dailySum - todayPayload.week.distanceKm) < 1e-9);
    const withPlan = read.mobileToday({ easyDurationFloorFraction: 0.7, qualitySessionCap: 2,
      raceTarget: { date: new Date(Date.parse(`${today}T00:00:00Z`) + 60 * 86400000).toISOString().slice(0, 10),
        distance: "ten_k", targetPaceSecondsPerKm: 300 },
      weekPlan: [], lockedSession: null }, [{ revision: 1,
      changedAt: `${today}T00:00:00+08:00`, lockedSession: null,
      weekPlan: [{ localDate: today, kind: "easy", distanceKm: 5.2 }] }]);
    assert.equal(withPlan.adherence!.current!.observedDays, 1);
    assert.equal(withPlan.adherence!.current!.observedDistanceKm, 5.2);
    assert.equal(withPlan.adherence!.current!.volumeRatio, 1);
    assert.notEqual(withPlan.adherence!.current!.status, "under");
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mobile week averages cover all runs and distributions exclude other weeks and low coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-week-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const rows = store.database.prepare("SELECT training_session_id FROM active_workout_training_loads ORDER BY local_date")
    .all() as Array<{ training_session_id: string }>;
  assert.ok(rows.length > 5);
  store.database.prepare(`UPDATE workout_training_loads SET local_date = ?, distance_km = 5,
    duration_seconds = 1800, average_heart_rate_bpm = 140`).run(today);
  const update = store.database.prepare(`UPDATE workout_training_loads SET distance_km = ?,
    duration_seconds = ?, average_heart_rate_bpm = ? WHERE training_session_id = ?`);
  update.run(10, 3600, 160, rows[0]!.training_session_id);
  update.run(5, 1800, null, rows[1]!.training_session_id);
  store.database.prepare(`UPDATE workout_zone_summaries SET heart_rate_coverage = 1, pace_coverage = 1,
    heart_rate_exposure_json = ?, pace_exposure_json = ?`).run(
      JSON.stringify([{ zone: "z2", durationSeconds: 1200 }]),
      JSON.stringify([{ zone: "easy", durationSeconds: 900 }, { zone: "marathon", durationSeconds: 300 }]));
  store.database.prepare(`UPDATE workout_zone_summaries SET heart_rate_coverage = 0.1
    WHERE training_session_id = ?`).run(rows[0]!.training_session_id);
  store.database.prepare(`UPDATE workout_training_loads SET local_date = '2020-01-01'
    WHERE training_session_id = ?`).run(rows.at(-1)!.training_session_id);
  store.close();
  const read = new RaiReadStore(databasePath);
  try {
    const week = read.mobileToday().week;
    const count = rows.length - 1;
    assert.equal(week.averageSpeedKmPerHour, 10);
    assert.equal(week.averagePaceSecondsPerKm, 360);
    assert.equal(week.averageHeartRateBpm, (160 * 3600 + (count - 2) * 140 * 1800) / (count * 1800));
    assert.deepEqual(week.heartRateZones, [{ zone: "z2", durationSeconds: (count - 1) * 1200, fraction: 1 }]);
    assert.deepEqual(week.paceZones, [
      { zone: "easy", durationSeconds: count * 900, fraction: 0.75 },
      { zone: "marathon", durationSeconds: count * 300, fraction: 0.25 }
    ]);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mobile week without current runs has missing averages rather than zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-week-empty-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  store.close();
  const read = new RaiReadStore(databasePath);
  try {
    const week = read.mobileToday().week;
    assert.equal(week.averageSpeedKmPerHour, null);
    assert.equal(week.averagePaceSecondsPerKm, null);
    assert.equal(week.averageHeartRateBpm, null);
    assert.deepEqual(week.heartRateZones, []);
    assert.deepEqual(week.paceZones, []);
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
    assert.equal(initial.easyDurationFloorFraction, DEFAULT_EASY_DURATION_FLOOR);
    assert.equal(initial.qualitySessionCap, DEFAULT_QUALITY_SESSION_CAP);
    assert.equal(initial.raceTarget, null);
    assert.ok(!existsSync(join(root, "var", "mobile-goals.json")));

    const written = store.write({ easyDurationFloorFraction: 0.75 });
    assert.equal(written.easyDurationFloorFraction, 0.75);
    assert.equal(written.qualitySessionCap, DEFAULT_QUALITY_SESSION_CAP);
    assert.equal(written.raceTarget, null);
    assert.equal(written.lockedSession, null);
    assert.ok(written.updatedAt > initial.updatedAt);
    // Round-trips through a fresh store instance (simulated restart).
    const reloaded = new MobileGoalsStore(root).read();
    assert.equal(reloaded.easyDurationFloorFraction, 0.75);

    // Every goal is optional, so an empty edit is legal: it still advances the
    // revision and leaves every stored field exactly as it was.
    const untouched = new MobileGoalsStore(root).write({});
    assert.equal(untouched.revision, reloaded.revision + 1);
    assert.equal(untouched.easyDurationFloorFraction, 0.75);
    assert.equal(untouched.qualitySessionCap, DEFAULT_QUALITY_SESSION_CAP);

    // Values are clamped into their own ranges rather than trusted.
    assert.equal(new MobileGoalsStore(root).write({ easyDurationFloorFraction: 9 }).easyDurationFloorFraction, 0.95);
    assert.equal(new MobileGoalsStore(root).write({ easyDurationFloorFraction: 0.1 }).easyDurationFloorFraction, 0.4);
    assert.equal(new MobileGoalsStore(root).write({ qualitySessionCap: 99 }).qualitySessionCap, 4);
    assert.equal(new MobileGoalsStore(root).write({ qualitySessionCap: -1 }).qualitySessionCap, 0);

    // A payload written before the weekly goal was retired still reads: the key
    // is ignored rather than rejected, and the fields that remain survive.
    const legacyPayload = JSON.parse(readFileSync(join(root, "var", "mobile-goals.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(root, "var", "mobile-goals.json"),
      `${JSON.stringify({ ...legacyPayload, weeklyDistanceKm: 42 })}\n`, "utf8");
    // The unknown key must not make the file unreadable, and the goals that do
    // still exist must come back at the values the writes above left behind.
    const legacyRead = new MobileGoalsStore(root).read();
    assert.equal(legacyRead.easyDurationFloorFraction, 0.4);
    assert.equal(legacyRead.qualitySessionCap, 0);

    // Corrupt file falls back to defaults instead of throwing.
    writeFileSync(join(root, "var", "mobile-goals.json"), "{not json", "utf8");
    const recovered = new MobileGoalsStore(root).read();
    assert.equal(recovered.easyDurationFloorFraction, DEFAULT_EASY_DURATION_FLOOR);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("race goals reject impossible calendar dates instead of normalizing them", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-invalid-race-date-"));
  try {
    const store = new MobileGoalsStore(root);
    assert.throws(
      () => store.write({
        raceTarget: { date: "2026-02-31", distance: "ten_k", targetPaceSecondsPerKm: null }
      }),
      /real YYYY-MM-DD date/
    );
    assert.equal(store.read().raceTarget, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recommendation explainability reports same-kind distance adjustments", () => {
  const planned = { localDate: "2026-09-25", kind: "easy" as const, distanceKm: 10, structure: null };
  const computed: MobileNextSession = {
    kind: "easy",
    title: "预算内轻松跑",
    reason: "按本自然周剩余跑量缩减今日处方。",
    distanceKm: 5,
    durationMinutes: 30,
    paceSecondsPerKmLower: null,
    paceSecondsPerKmUpper: null,
    heartRateBpmLower: null,
    heartRateBpmUpper: null,
    structure: null
  };
  assert.equal(recommendationAdjustmentReason(planned, computed), computed.reason);
  assert.equal(
    recommendationAdjustmentReason(planned, { ...computed, distanceKm: 10 }),
    null
  );
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
      // Deliberately still carries the retired key: the migration must accept a
      // payload written before that key existed, and ignore what it no longer knows.
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
      // A legacy file still carrying the retired key migrates without losing what
      // remains: the migration is gated on `revision` now, so this also proves the
      // replacement probe accepts a real payload.
      const migrated = store.read();
      assert.equal(migrated.easyDurationFloorFraction, 0.75);
      assert.equal(migrated.qualitySessionCap, 3);
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

test("mobile goals store can lock today's session without dropping other goals", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-lock-"));
  try {
    const store = new MobileGoalsStore(root);
    store.write({ easyDurationFloorFraction: 0.8, qualitySessionCap: 3 });
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
        heartRateBpmUpper: 145,
        structure: {
          warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: null },
          blocks: [
            {
              iterations: 1,
              steps: [
                { purpose: "work", goal: { type: "distance", meters: 7000 }, alert: { kind: "pace", lower: 330, upper: 390 } }
              ]
            }
          ],
          cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: null }
        }
      }
    });
    // Locking today's session must not disturb the other stored goals.
    assert.equal(locked.easyDurationFloorFraction, 0.8);
    assert.equal(locked.qualitySessionCap, 3);
    assert.equal(locked.lockedSession?.localDate, "2026-09-03");
    assert.equal(locked.lockedSession?.session.kind, "easy");
    const reread = new MobileGoalsStore(root).read().lockedSession?.session;
    assert.equal(reread?.title, "轻松跑");
    assert.equal(reread?.structure?.blocks[0]?.steps[0]?.goal.type, "distance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("weekly plan keeps valid structures and drops malformed ones", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-plan-"));
  try {
    const store = new MobileGoalsStore(root);
    const written = store.write({
      weekPlan: [
        {
          localDate: "2026-09-04",
          kind: "interval",
          distanceKm: 9.4,
          structure: {
            warmup: { purpose: "warmup", goal: { type: "time", seconds: 600 }, alert: null },
            blocks: [
              {
                iterations: 5,
                steps: [
                  { purpose: "work", goal: { type: "distance", meters: 800 }, alert: { kind: "pace", lower: 240, upper: 265 } },
                  { purpose: "recovery", goal: { type: "time", seconds: 120 }, alert: null }
                ]
              }
            ],
            cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 600 }, alert: null }
          }
        },
        {
          localDate: "2026-09-05",
          kind: "easy",
          distanceKm: 8,
          // Malformed structure: unknown purpose and an out-of-range alert.
          structure: {
            warmup: { purpose: "sprint", goal: { type: "time", seconds: 600 }, alert: null },
            blocks: [{ iterations: 0, steps: [] }],
            cooldown: null
          } as never
        }
      ],
      weekPlanAudit: {
        generatedBy: "llm",
        model: "deepseek-chat",
        promptVersion: "weekly-plan-v1",
        generatedAt: "2026-09-01T00:00:00.000Z"
      }
    });

    const interval = written.weekPlan.find((day) => day.localDate === "2026-09-04");
    assert.equal(interval?.structure?.blocks[0]?.iterations, 5);
    const easy = written.weekPlan.find((day) => day.localDate === "2026-09-05");
    assert.equal(easy?.structure, undefined);
    assert.deepEqual(written.weekPlanAudit, {
      generatedBy: "llm",
      model: "deepseek-chat",
      promptVersion: "weekly-plan-v1",
      generatedAt: "2026-09-01T00:00:00.000Z"
    });

    const reread = new MobileGoalsStore(root).read();
    assert.equal(reread.weekPlan.find((day) => day.localDate === "2026-09-04")?.structure?.blocks[0]?.iterations, 5);
    assert.equal(reread.weekPlanAudit?.generatedBy, "llm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a goals edit keeps the generated structure and its distance unless the session kind changes", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-plan-merge-"));
  const intervalStructure = {
    warmup: { purpose: "warmup", goal: { type: "time", seconds: 600 }, alert: null },
    blocks: [
      {
        iterations: 6,
        steps: [
          { purpose: "work", goal: { type: "distance", meters: 800 }, alert: { kind: "pace", lower: 240, upper: 265 } },
          { purpose: "recovery", goal: { type: "time", seconds: 120 }, alert: null }
        ]
      }
    ],
    cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 600 }, alert: null }
  } as never;
  try {
    const store = new MobileGoalsStore(root);
    const initial = store.write({
      weekPlan: [
        { localDate: "2026-09-04", kind: "interval", distanceKm: 9.4, structure: intervalStructure, reason: "周三 6×800m" },
        { localDate: "2026-09-05", kind: "easy", distanceKm: 8 }
      ]
    });
    assert.equal(initial.weekPlan.find((day) => day.localDate === "2026-09-04")?.structure?.blocks[0]?.iterations, 6);

    // The goals editor only carries localDate / kind / distanceKm, so this is
    // exactly what a "save my weekly distance" round trip looks like.
    const edited = new MobileGoalsStore(root).write({
      expectedRevision: initial.revision,
      weekPlan: [
        { localDate: "2026-09-04", kind: "interval", distanceKm: 7 },
        { localDate: "2026-09-05", kind: "tempo", distanceKm: 6 }
      ]
    });

    const kept = edited.weekPlan.find((day) => day.localDate === "2026-09-04");
    assert.equal(kept?.structure?.blocks[0]?.iterations, 6, "同类型课表必须保留已生成的结构");
    assert.equal(kept?.reason, "周三 6×800m", "生成理由不应被目标编辑抹掉");
    // The structure is the session the watch runs, so the day's distance belongs
    // to it rather than to the number typed beside it. This store has no
    // prescription, so the day keeps the value it already carried — never the
    // editor's 7 km, which describes a session nobody will run.
    assert.equal(kept?.distanceKm, 9.4, "距离由结构决定，编辑器写入的 7km 不生效");

    const changed = edited.weekPlan.find((day) => day.localDate === "2026-09-05");
    assert.equal(changed?.structure, undefined, "训练类型改变后不得沿用旧结构");

    // An explicit empty plan still clears, so the merge never blocks deletion.
    const cleared = new MobileGoalsStore(root).write({ weekPlan: [] });
    assert.equal(cleared.weekPlan.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("mobile recovery reports a historical night as a reference, never as today's reading", async (context) => {
  const asOf = "2026-10-02T04:00:00.000Z";
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(asOf) });
  const root = mkdtempSync(join(tmpdir(), "rai-mobile-recovery-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  // A published refresh exists, so the data status has something to reflect. The
  // assertions below exist to prove it reflects the refresh and not the night.
  store.database.prepare("INSERT INTO import_manifest (key, value) VALUES (?, ?)").run(
    "import_completed_at",
    "2026-09-19T06:10:06.000Z"
  );
  try {
    // SQLite defaults use the real clock, so arrival times must share the fixture clock.
    const insert = store.database.prepare(`INSERT INTO canonical_nights
      (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank,
       has_stages, sleep_onset_at, wake_at, asleep_union_minutes, stage_minutes_json, segment_count, provenance_json, computed_at)
      VALUES (?, ?, 'Asia/Shanghai', 'main', 'Watch', 'apple_watch', 1, 0, ?, ?, ?, '{}', 1, '{}', ?)`);
    insert.run("prior-night", "2025-01-21", "2025-01-20T15:00:00Z", "2025-01-20T23:00:00Z", 480, asOf);
    insert.run("latest-night", "2025-01-22", "2025-01-21T15:00:00Z", "2025-01-21T20:00:00Z", 300, asOf);
    const read = new RaiReadStore(databasePath);
    try {
      const snapshot = read.mobileToday();
      // The newest recorded night is older than today. It stays reachable as the
      // historical reference (note + freshness.recoveryDate) but must never be
      // served as today's sleep/HRV/RHR.
      assert.equal(snapshot.verdict.stale, true);
      const recovery = snapshot.recovery;
      assert.equal(recovery.lastNightSleepMinutes, null, "更早一晚的睡眠不得充当今天的读数");
      assert.equal(recovery.state, "unknown");
      assert.equal(snapshot.freshness.recoveryDate, "2025-01-22");
      assert.match(recovery.note, /2025-01-22/);
      assert.doesNotMatch(recovery.note, /昨夜|今晨/);
      // A night that woke yesterday is a reference, not a verdict: coverage says so
      // and the assessment refuses to grade a day it could not measure.
      assert.equal(snapshot.coverage.sleep.state, "historical");
      assert.equal(snapshot.coverage.sleep.latestDate, "2025-01-22");
      assert.equal(snapshot.recoveryAssessment.coverage, "none");
      assert.equal(snapshot.recoveryAssessment.assessment, "not_assessed");
      assert.ok(snapshot.recoveryAssessment.reasonCodes.includes("not_assessed"));
      assert.equal(snapshot.recommendation.recoveryAdjustment, "no_evidence", "缺测既不是批准也不是降级");
      assert.equal(snapshot.sync.status, "ok", "刷新成功与有没有恢复记录无关");
      assert.equal(snapshot.sync.lastSuccessAt, "2026-09-19T06:10:06.000Z");
      const freshnessWithoutNight = snapshot.freshness.state;
      // A night that woke up today is today's reading, independent of the latest run.
      const date = snapshot.today.localDate;
      const baselineNight = new Date(Date.parse(`${date}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
      insert.run("baseline-night", baselineNight, `${baselineNight}T15:00:00Z`, `${baselineNight}T23:00:00Z`, 400, asOf);
      // V2 requires seven prior comparable days; a single night is not a mature baseline.
      for (let offset=4;offset<=10;offset++) {
        const d=new Date(Date.parse(`${date}T00:00:00Z`)-offset*86400000).toISOString().slice(0,10);
        insert.run(`reference-${offset}`,d,`${d}T00:00:00+08:00`,`${d}T08:00:00+08:00`,400,asOf);
      }
      insert.run("today-night", date, `${date}T00:00:00+08:00`, `${date}T08:00:00+08:00`, 480, asOf);
      const current = read.mobileToday();
      assert.equal(current.latestDataDate, "2025-01-22");
      assert.equal(current.verdict.stale, false, "current recovery is independent of the latest run date");
      assert.equal(current.recovery.lastNightSleepMinutes, 480, "今天的夜才进今天的读数");
      assert.equal(current.coverage.sleep.state, "current");
      assert.equal(
        current.recoveryAssessment.coverage,
        "partial",
        "有读数且能对比才算覆盖：睡眠可用，HRV 与静息心率缺失"
      );
      assert.equal(current.recoveryAssessment.assessment, "no_low_signal");
      assert.equal(
        current.freshness.state,
        freshnessWithoutNight,
        "数据状态只反映刷新结果，不再由睡眠日期决定"
      );
    } finally { read.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

const planZones = {
  profile: {
    restingHeartRateBpm: 52,
    maximumHeartRateBpm: 190,
    lactateThresholdPaceSecondsPerKm: 280,
    heartRateBands: [
      { zone: "recovery", lowerBpm: 100, upperBpm: 130 },
      { zone: "aerobic_base", lowerBpm: 130, upperBpm: 150 },
      { zone: "lactate_threshold", lowerBpm: 160, upperBpm: 172 }
    ],
    paceBands: [
      { zone: "easy", lowerSecondsPerKm: 330, upperSecondsPerKm: 390 },
      { zone: "lactate_threshold", lowerSecondsPerKm: 270, upperSecondsPerKm: 300 },
      { zone: "anaerobic_endurance", lowerSecondsPerKm: 240, upperSecondsPerKm: 265 }
    ]
  }
} as unknown as TrainingZonesCurrentResponse;

const planSession = (overrides: Partial<MobileNextSession> = {}): MobileNextSession => ({
  kind: "easy",
  title: "轻松跑",
  reason: "闸门放行",
  distanceKm: 8,
  durationMinutes: 50,
  paceSecondsPerKmLower: 330,
  paceSecondsPerKmUpper: 390,
  heartRateBpmLower: 130,
  heartRateBpmUpper: 150,
  structure: null,
  ...overrides
});

test("workout plan covers today plus the rest of the window", () => {
  const plan = assembleMobileWorkoutPlan({
    today: "2026-09-03",
    todaySession: planSession(),
    todayCompleted: false,
    storedPlan: [
      { localDate: "2026-09-04", kind: "interval", distanceKm: 9.4, reason: "VO2" },
      { localDate: "2026-09-05", kind: "easy", distanceKm: 8 },
      { localDate: "2026-09-10", kind: "easy", distanceKm: 8 }
    ],
    zones: planZones,
    audit: {
      generatedBy: "llm",
      model: "deepseek-chat",
      promptVersion: "weekly-plan-v1",
      generatedAt: "2026-09-01T00:00:00.000Z"
    },
    planRevision: 7
  });

  assert.equal(plan.planRevision, 7);
  assert.equal(plan.audit?.generatedBy, "llm");
  // 2026-09-10 falls outside the 7 day window starting 09-03
  assert.deepEqual(plan.days.map((day) => day.localDate), ["2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"]);
  assert.equal(plan.windowDays, 7);
  assert.equal(plan.windowStart, "2026-09-03");
  assert.equal(plan.windowEnd, "2026-09-09");
  assert.ok(plan.days.slice(3).every(day => day.kind === "rest" && !day.executable && day.structure === null));
  assert.equal(plan.days.every((day) => day.source === "llm"), true);
});

test("workout plan re-measures every day from its own structure", () => {
  const plan = assembleMobileWorkoutPlan({
    today: "2026-09-03",
    todaySession: planSession({ kind: "tempo", title: "节奏 / 阈值" }),
    todayCompleted: false,
    storedPlan: [{ localDate: "2026-09-04", kind: "interval", distanceKm: 9.4 }],
    zones: planZones,
    audit: null,
    planRevision: 0
  });

  for (const day of plan.days) {
    if (day.title === "未生成") {
      assert.equal(day.executable, false);
      assert.equal(day.structure, null);
      continue;
    }
    assert.ok(day.structure, `${day.localDate} 应当有结构`);
    assert.equal(day.executable, true);
    assert.ok((day.distanceKm ?? 0) > 0);
    assert.ok((day.durationMinutes ?? 0) > 0);
  }
  const interval = plan.days.find((day) => day.kind === "interval");
  assert.deepEqual(interval?.structure?.blocks[0]?.steps[0]?.goal, { type: "distance", meters: 800 });
  // interval prescription overrides the stored distance hint
  assert.ok((interval?.distanceKm ?? 0) >= 4);
  // source falls back to heuristic when no audit is recorded
  assert.equal(interval?.source, "heuristic");
});

test("rest days and completed days are never marked executable", () => {
  const plan = assembleMobileWorkoutPlan({
    today: "2026-09-03",
    todaySession: planSession({ kind: "rest", title: "今天的动作：休息", distanceKm: null, durationMinutes: null }),
    todayCompleted: true,
    storedPlan: [{ localDate: "2026-09-04", kind: "rest", distanceKm: null }],
    zones: planZones,
    audit: null,
    planRevision: 1
  });
  assert.equal(plan.days.every((day) => day.executable === false), true);
  assert.equal(plan.days[0]?.structure, null);
  assert.equal(plan.days[0]?.distanceKm, null);
});

test("a day without a stored structure still derives one from its kind", () => {
  const plan = assembleMobileWorkoutPlan({
    today: "2026-09-03",
    todaySession: planSession(),
    todayCompleted: false,
    storedPlan: [{ localDate: "2026-09-04", kind: "easy", distanceKm: 10 }],
    zones: planZones,
    audit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: null },
    planRevision: 2
  });
  const easy = plan.days.find((day) => day.localDate === "2026-09-04");
  assert.ok(easy?.structure);
  assert.equal(easy?.structure?.blocks[0]?.iterations, 1);
  const workStep = easy?.structure?.blocks[0]?.steps[0];
  assert.equal(workStep?.goal.type, "distance");
  // warmup and cooldown are carved out of the requested target
  assert.ok((easy?.distanceKm ?? 0) <= 10.5);
});

test("ranges come from the zone profile per session kind", () => {
  const plan = assembleMobileWorkoutPlan({
    today: "2026-09-03",
    todaySession: planSession(),
    todayCompleted: false,
    storedPlan: [
      { localDate: "2026-09-04", kind: "interval", distanceKm: null },
      { localDate: "2026-09-05", kind: "tempo", distanceKm: null },
      { localDate: "2026-09-06", kind: "easy", distanceKm: null }
    ],
    zones: planZones,
    audit: null,
    planRevision: 0
  });
  const interval = plan.days.find((day) => day.localDate === "2026-09-04");
  const tempo = plan.days.find((day) => day.localDate === "2026-09-05");
  const easy = plan.days.find((day) => day.localDate === "2026-09-06");
  assert.equal(interval?.paceSecondsPerKmLower, 240);
  assert.equal(interval?.heartRateBpmLower, 160);
  assert.equal(tempo?.paceSecondsPerKmLower, 270);
  assert.equal(easy?.paceSecondsPerKmLower, 330);
  // easy heart rate floor follows the recovery band, matching the coach rule
  assert.equal(easy?.heartRateBpmLower, 100);
});

test("a goals row written before weekPlanAudit existed still reads back as null", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-goals-legacy-"));
  try {
    const controlPath = join(root, "var", "control.sqlite");
    mkdirSync(dirname(controlPath), { recursive: true });
    const database = new DatabaseSync(controlPath);
    database.exec(`
      CREATE TABLE mobile_goals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE mobile_goals_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
    `);
    // Exactly the shape an earlier build wrote: no `weekPlanAudit`, and plan days
    // without `structure` / `reason`.
    database
      .prepare("INSERT INTO mobile_goals (singleton, revision, payload_json, updated_at) VALUES (1, 3, ?, ?)")
      .run(
        JSON.stringify({ weekPlan: [{ localDate: "2026-09-04", kind: "easy", distanceKm: 8 }] }),
        "2026-09-01T00:00:00.000Z"
      );
    database.close();

    const store = new MobileGoalsStore(root, controlPath);
    try {
      const goals = store.read();
      assert.equal(goals.weekPlanAudit, null, "缺少审计字段时必须读出 null，而不是 undefined");
      assert.equal(goals.weekPlan[0]?.distanceKm, 8);
      assert.equal(goals.weekPlan[0]?.structure, undefined);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a merged plan day stores the distance its structure measures, not the editor's hint", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-goals-merge-"));
  try {
    const controlPath = join(root, "var", "control.sqlite");
    const prescription = zonePrescription(planZones);
    const structure = buildSessionStructure("interval", prescription, { reps: 6 });
    assert.ok(structure);
    const measuredKm = roundKm(measureStructure(structure, "interval", pacesFromZones(prescription)).distanceKm);
    // 6 × 800 m plus warmup/cooldown, well above the 7 km the editor typed.
    assert.ok(measuredKm > 8, `结构本身应当约 9.7km，实测 ${measuredKm}`);

    const store = new MobileGoalsStore(root, controlPath);
    const written = store.write(
      {
        weekPlan: [{ localDate: "2026-09-05", kind: "interval", distanceKm: 7, structure, reason: "VO2" }]
      },
      { prescription }
    );
    assert.equal(written.weekPlan[0]?.distanceKm, measuredKm);
    store.close();

    // And it is what a later read sees, so the editor cannot reload the old hint.
    const reopened = new MobileGoalsStore(root, controlPath);
    assert.equal(reopened.read().weekPlan[0]?.distanceKm, measuredKm);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a zone prescription the merge keeps the prior distance, never the hint", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-goals-merge-nod-"));
  try {
    const controlPath = join(root, "var", "control.sqlite");
    const prescription = zonePrescription(planZones);
    const structure = buildSessionStructure("interval", prescription, { reps: 6 });
    assert.ok(structure);
    const measuredKm = roundKm(measureStructure(structure, "interval", pacesFromZones(prescription)).distanceKm);

    const store = new MobileGoalsStore(root, controlPath);
    store.write(
      { weekPlan: [{ localDate: "2026-09-05", kind: "interval", distanceKm: measuredKm, structure }] },
      { prescription }
    );
    // Same structure, no zones readable: the echoed 7 km must not be persisted
    // next to a structure that measures ~9.7 km.
    const merged = store.write({
      weekPlan: [{ localDate: "2026-09-05", kind: "interval", distanceKm: 7, structure }]
    });
    assert.equal(merged.weekPlan[0]?.distanceKm, measuredKm);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a day typed into the editor without a structure is persisted with the one its kind builds", () => {
  // The editor sends only `kind` + `distanceKm`. Such a day used to be stored
  // with no structure, so each endpoint synthesized one on the way out — and
  // because tempo/interval ignore the hint, the two ended up disagreeing about
  // a single stored row (6 km in the editor, 8.8 km in the plan).
  const root = mkdtempSync(join(tmpdir(), "rai-goals-materialize-"));
  try {
    const prescription = zonePrescription(planZones);
    const store = new MobileGoalsStore(root, join(root, "var", "control.sqlite"));
    const written = store.write(
      { weekPlan: [{ localDate: "2026-09-14", kind: "tempo", distanceKm: 6 }] },
      { prescription }
    );
    const day = written.weekPlan[0]!;
    assert.ok(day.structure, "写入时必须把结构物化下来，否则它无法被测量");
    const measured = roundKm(measureStructure(day.structure, "tempo", pacesFromZones(prescription)).distanceKm);
    assert.equal(day.distanceKm, measured);
    assert.notEqual(day.distanceKm, 6, "编辑器送的 hint 不是距离的来源");

    // One stored row, three readers: the editor reload, today's week plan, and
    // the executable week.
    const read = store.read({ prescription });
    assert.equal(read.weekPlan[0]?.distanceKm, measured);
    const plan = assembleMobileWorkoutPlan({
      today: "2026-09-13",
      todaySession: planSession(),
      todayCompleted: false,
      storedPlan: read.weekPlan,
      zones: planZones,
      audit: null,
      planRevision: 1
    });
    assert.equal(plan.days.find((entry) => entry.localDate === "2026-09-14")?.distanceKm, measured);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rest day stores neither a distance nor a structure", () => {
  // Every reader measures `rest` to nothing, so a stored 5 km would be a number
  // that exists only in the file — and a round trip through the editor would
  // silently drop it anyway.
  const root = mkdtempSync(join(tmpdir(), "rai-goals-rest-"));
  try {
    const store = new MobileGoalsStore(root, join(root, "var", "control.sqlite"));
    const written = store.write(
      { weekPlan: [{ localDate: "2026-09-16", kind: "rest", distanceKm: 5 }] },
      { prescription: zonePrescription(planZones) }
    );
    assert.equal(written.weekPlan[0]?.distanceKm, null);
    assert.equal(written.weekPlan[0]?.structure ?? null, null);
    assert.equal(store.read({ prescription: zonePrescription(planZones) }).weekPlan[0]?.distanceKm, null);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a locked snapshot is re-measured on the way out of the store", () => {
  // Locks written before structured sessions existed have a distance and no
  // structure; the editor reads the lock back through this same response.
  const root = mkdtempSync(join(tmpdir(), "rai-goals-lock-"));
  try {
    const prescription = zonePrescription(planZones);
    const store = new MobileGoalsStore(root, join(root, "var", "control.sqlite"));
    const written = store.write(
      {
        lockedSession: {
          localDate: "2026-09-13",
          verdictTone: "green",
          lockedAt: new Date(0).toISOString(),
          session: {
            kind: "interval", title: "间歇", reason: "", distanceKm: 7, durationMinutes: 40,
            paceSecondsPerKmLower: null, paceSecondsPerKmUpper: null,
            heartRateBpmLower: null, heartRateBpmUpper: null, structure: null
          }
        }
      },
      { prescription }
    );
    const structure = buildSessionStructure("interval", prescription, {});
    assert.ok(structure);
    const measured = roundKm(measureStructure(structure, "interval", pacesFromZones(prescription)).distanceKm);
    assert.equal(written.lockedSession?.session.distanceKm, measured);
    assert.ok(written.lockedSession?.session.structure, "锁定的会话也必须带可执行结构");
    assert.notEqual(written.lockedSession?.session.distanceKm, 7);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a structure sent for a different kind than the stored day is discarded", () => {
  // iOS `save()` copies the loaded item and only overwrites the distance, so a
  // kind change sends the *old* kind's structure back. Trusting it would store
  // an easy prescription under a tempo label, and every reader would then
  // measure it with tempo paces.
  const root = mkdtempSync(join(tmpdir(), "rai-goals-kind-swap-"));
  try {
    const prescription = zonePrescription(planZones);
    const store = new MobileGoalsStore(root, join(root, "var", "control.sqlite"));
    const easy = buildSessionStructure("easy", prescription, { targetDistanceKm: 6 });
    assert.ok(easy);
    const first = store.write(
      { weekPlan: [{ localDate: "2026-09-14", kind: "easy", distanceKm: 6, structure: easy }] },
      { prescription }
    );
    assert.equal(first.weekPlan[0]?.kind, "easy");

    const swapped = store.write(
      { weekPlan: [{ localDate: "2026-09-14", kind: "tempo", distanceKm: 6, structure: easy }] },
      { prescription }
    );
    const day = swapped.weekPlan[0]!;
    const tempo = buildSessionStructure("tempo", prescription, {});
    assert.ok(tempo);
    assert.deepEqual(day.structure, tempo, "必须按新类型重建结构");
    assert.equal(
      day.distanceKm,
      roundKm(measureStructure(tempo, "tempo", pacesFromZones(prescription)).distanceKm)
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("editing the distance of a target-sized day rebuilds it, and a fixed-dose day ignores it", () => {
  // The editor's distance field can only mean something for a kind whose
  // prescription is sized by a target (`buildSessionStructure` subtracts its
  // warmup/cooldown overhead). A quality day's dose is fixed by the coach, so
  // its typed number stays a hint.
  const root = mkdtempSync(join(tmpdir(), "rai-goals-distance-edit-"));
  try {
    const prescription = zonePrescription(planZones);
    const store = new MobileGoalsStore(root, join(root, "var", "control.sqlite"));
    store.write(
      {
        weekPlan: [
          { localDate: "2026-09-14", kind: "easy", distanceKm: 6 },
          { localDate: "2026-09-15", kind: "tempo", distanceKm: 6 }
        ]
      },
      { prescription }
    );

    // The editor clears the structure for a day it edited (see `save()` in both
    // skins), which is what these requests look like on the wire.
    const edited = store.write(
      {
        weekPlan: [
          { localDate: "2026-09-14", kind: "easy", distanceKm: 12 },
          { localDate: "2026-09-15", kind: "tempo", distanceKm: 12 }
        ]
      },
      { prescription }
    );

    const easy = edited.weekPlan.find((day) => day.localDate === "2026-09-14")!;
    const easyStructure = buildSessionStructure("easy", prescription, { targetDistanceKm: 12 });
    assert.ok(easyStructure);
    assert.deepEqual(easy.structure, easyStructure, "轻松跑必须按新距离重建");
    assert.equal(
      easy.distanceKm,
      roundKm(measureStructure(easyStructure, "easy", pacesFromZones(prescription)).distanceKm)
    );

    const tempo = edited.weekPlan.find((day) => day.localDate === "2026-09-15")!;
    const tempoStructure = buildSessionStructure("tempo", prescription, {});
    assert.ok(tempoStructure);
    assert.deepEqual(tempo.structure, tempoStructure, "质量课的处方是固定剂量，距离编辑不能改它");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a client-supplied structure over the single-day ceiling is rebuilt, never stored", () => {
  // `normalizeSessionStructure` bounds every *field* a client may send — one step
  // at `MAX_STEP_METERS`, one block at `MAX_BLOCK_ITERATIONS` repetitions — and
  // nothing bounds the total: this payload satisfies all of them and measures
  // 2000 km. The plan validator caps what the *model* sends; the goals editor and
  // the lock endpoint reach the same store, the same plan views and the same
  // workout bridge, so they are held to the same ceiling.
  const root = mkdtempSync(join(tmpdir(), "rai-goals-oversized-"));
  try {
    const prescription = zonePrescription(planZones);
    const store = new MobileGoalsStore(root, join(root, "var", "control.sqlite"));
    const oversized: MobileSessionStructure = {
      warmup: null,
      blocks: [
        { iterations: 20, steps: [{ purpose: "work", goal: { type: "distance", meters: 100_000 }, alert: null }] }
      ],
      cooldown: null
    };
    const paces = pacesFromZones(prescription);
    assert.ok(
      measureStructure(oversized, "long_run", paces).distanceKm > MAX_PLANNED_DISTANCE_KM,
      "载荷本身必须超限，否则这个用例什么都没测"
    );

    const written = store.write(
      {
        weekPlan: [{ localDate: "2026-09-14", kind: "long_run", distanceKm: 5, structure: oversized }]
      },
      { prescription }
    );
    const day = written.weekPlan[0]!;
    assert.ok(day.structure, "必须留下可执行结构");
    const measured = measureStructure(day.structure, "long_run", paces).distanceKm;
    assert.ok(
      measured <= MAX_PLANNED_DISTANCE_KM,
      `结构实测 ${measured} 必须 ≤ ${MAX_PLANNED_DISTANCE_KM}，否则手表会收到超限处方`
    );
    assert.ok(
      (day.distanceKm ?? 0) <= MAX_PLANNED_DISTANCE_KM,
      `落库距离 ${day.distanceKm} 必须 ≤ ${MAX_PLANNED_DISTANCE_KM}`
    );
    assert.ok(
      Math.abs((day.distanceKm ?? 0) - roundKm(measured)) <= 0.05,
      "落库距离必须等于被钳制的结构反推值"
    );

    const locked = store.write(
      {
        lockedSession: {
          localDate: "2026-09-14",
          verdictTone: "green",
          lockedAt: new Date(0).toISOString(),
          session: {
            kind: "long_run", title: "长距离", reason: "", distanceKm: 5, durationMinutes: null,
            paceSecondsPerKmLower: null, paceSecondsPerKmUpper: null,
            heartRateBpmLower: null, heartRateBpmUpper: null, structure: oversized
          }
        }
      },
      { prescription }
    );
    const lockedStructure = locked.lockedSession?.session.structure;
    assert.ok(lockedStructure, "锁定的会话也必须留下结构");
    const lockedMeasured = measureStructure(lockedStructure, "long_run", paces).distanceKm;
    assert.ok(
      lockedMeasured <= MAX_PLANNED_DISTANCE_KM,
      `锁定结构实测 ${lockedMeasured} 必须 ≤ ${MAX_PLANNED_DISTANCE_KM}`
    );
    assert.ok((locked.lockedSession?.session.distanceKm ?? 0) <= MAX_PLANNED_DISTANCE_KM);

    // Asserted on what is *persisted*, not only on what the response renders:
    // `read()` without a prescription echoes what is stored, and that is exactly
    // how `/v1/mobile/today` reads this store. A cap applied only on the way out
    // would leave 2000 km in the file — and on the week card and the watch.
    const reread = store.read();
    const persisted = reread.weekPlan[0]!;
    assert.ok(
      (persisted.distanceKm ?? 0) <= MAX_PLANNED_DISTANCE_KM,
      `持久化距离 ${persisted.distanceKm} 必须 ≤ ${MAX_PLANNED_DISTANCE_KM}`
    );
    assert.ok(persisted.structure, "持久化后仍必须带结构");
    assert.ok(
      measureStructure(persisted.structure, "long_run", paces).distanceKm <= MAX_PLANNED_DISTANCE_KM,
      "持久化的结构实测必须 ≤ 上限，否则上表处方仍超限"
    );
    const persistedLock = reread.lockedSession?.session;
    assert.ok((persistedLock?.distanceKm ?? 0) <= MAX_PLANNED_DISTANCE_KM);
    assert.ok(persistedLock?.structure, "持久化后锁定会话仍必须带结构");
    assert.ok(
      measureStructure(persistedLock.structure, "long_run", paces).distanceKm <= MAX_PLANNED_DISTANCE_KM
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a structure already inside the ceiling is stored untouched", () => {
  // The cap must not rewrite days that are already legal: rebuilding every day
  // would silently replace a generated prescription's tuned rep count with the
  // default dose.
  const root = mkdtempSync(join(tmpdir(), "rai-goals-within-ceiling-"));
  try {
    const prescription = zonePrescription(planZones);
    const store = new MobileGoalsStore(root, join(root, "var", "control.sqlite"));
    const interval = buildSessionStructure("interval", prescription, { reps: 6 });
    assert.ok(interval);
    const written = store.write(
      {
        weekPlan: [{ localDate: "2026-09-14", kind: "interval", distanceKm: 5, structure: interval }]
      },
      { prescription }
    );
    assert.deepEqual(written.weekPlan[0]?.structure, interval, "未超限的结构必须原样保留");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a structure built for the new kind is trusted even when the stored kind differs", () => {
  // The weekly generator replaces days wholesale — kind included — and sends the
  // structure that matches. Only the stored day's *own* structure coming back for
  // a different kind is stale; dropping every structure on a kind change would
  // rebuild the generated prescription at the default dose, and the generate
  // response (built from the same days) would then disagree with what got stored.
  const root = mkdtempSync(join(tmpdir(), "rai-goals-generated-kind-change-"));
  try {
    const prescription = zonePrescription(planZones);
    const store = new MobileGoalsStore(root, join(root, "var", "control.sqlite"));
    const easy = buildSessionStructure("easy", prescription, { targetDistanceKm: 6 });
    assert.ok(easy);
    store.write(
      { weekPlan: [{ localDate: "2026-09-14", kind: "easy", distanceKm: 6, structure: easy }] },
      { prescription }
    );

    const generated = buildSessionStructure("interval", prescription, { reps: 8 });
    assert.ok(generated);
    const written = store.write(
      {
        weekPlan: [{ localDate: "2026-09-14", kind: "interval", distanceKm: 11.9, structure: generated }]
      },
      { prescription }
    );
    const day = written.weekPlan[0]!;
    assert.deepEqual(day.structure, generated, "生成器为新类型准备的结构必须被采信");
    assert.equal(
      day.distanceKm,
      roundKm(measureStructure(generated, "interval", pacesFromZones(prescription)).distanceKm)
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("race goals create, edit and clear survive control database reopen without replacing weekly plans", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-race-goals-"));
  const controlPath = join(root, "var", "control.sqlite");
  let store = new MobileGoalsStore(root, controlPath);
  try {
    const original = store.write({ easyDurationFloorFraction: 0.75,
      qualitySessionCap: 3, weekPlan: [{ localDate: "2026-12-01", kind: "easy", distanceKm: 8 }] });
    const target = { date: "2026-12-06", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 };
    const created = store.write({ expectedRevision: original.revision, raceTarget: target });
    store.close();
    store = new MobileGoalsStore(root, controlPath);
    assert.deepEqual(store.read().raceTarget, target);
    assert.deepEqual(store.read().weekPlan, original.weekPlan);
    assert.equal(store.read().easyDurationFloorFraction, 0.75);
    assert.equal(store.read().qualitySessionCap, 3);
    assert.throws(() => store.write({ expectedRevision: original.revision, raceTarget: null }));
    assert.deepEqual(store.read().raceTarget, target);
    const editedTarget = { date: "2027-01-10", distance: "ten_k" as const, targetPaceSecondsPerKm: null };
    const edited = store.write({ expectedRevision: created.revision, raceTarget: editedTarget });
    store.close();
    store = new MobileGoalsStore(root, controlPath);
    assert.deepEqual(store.read().raceTarget, editedTarget);
    store.write({ expectedRevision: edited.revision, raceTarget: null });
    store.close();
    store = new MobileGoalsStore(root, controlPath);
    assert.equal(store.read().raceTarget, null);
    assert.deepEqual(store.read().weekPlan, original.weekPlan);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
