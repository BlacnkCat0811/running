import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DATABASE_TIMEZONE, localDateAt } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { RaiReadStore } from "../src/data.js";
import { MobileGoalsStore } from "../src/mobile-goals.js";

const percentile = (samples: number[], p: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
};

const identity = () => ({ serverId: "latency-server", athleteId: "latency-athlete", datasetEpoch: "latency-epoch" });

/** Shanghai local date string `offset` days from `today`. */
const shiftDate = (today: string, offset: number): string => {
  const value = new Date(`${today}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

interface SeededScale {
  rows: number;
}

/**
 * Approximates a production-sized store without reading/writing `var/rai.sqlite`.
 *
 * Read-path relevance: `trainingPlanState` queries 70 days of recovery evidence,
 * the import manifest / active model run / zone settings, then runs the whole
 * `mobileTodayWithExecutablePlan` read path (workouts lists, canonical nights,
 * import state) plus the fact/analysis block (100 + 200 rows). The seeded tables
 * therefore carry ~43k rows of the shapes those queries touch:
 *
 *   - 40,000 `health_records` (70 resting-HR rows inside the 70-day window that
 *     feed `publicationDigest`, the rest typical HR samples that only enlarge the
 *     file/page cache);
 *   - 400 `canonical_nights` + 400 `canonical_hrv_days` (70-day window read);
 *   - 400 `workouts` + 400 `training_sessions` + 800 `workout_statistics`
 *     (recent-workouts / facts-block queries);
 *   - 200 control-database `mobile_goals_history` rows (aggregate planHistory).
 *
 * Deliberately NOT seeded: the model-run / training-load / ability-assessment
 * chain. Those active views are empty in this fixture, which `trainingPlanState`
 * tolerates; reproducing a valid analysis chain would require model artifacts and
 * is out of scope for a read-latency measurement. Reported latency is therefore a
 * lower bound for a real library of the same row count (analysis blocks would be
 * denser), and the row count is the "2-5 万行" scale approximation.
 */
const seedScaleDatabase = (path: string, root: string): SeededScale => {
  const database = new DatabaseSync(path);
  const today = localDateAt(Date.now());
  try {
    database.exec("BEGIN IMMEDIATE");
    const health = database.prepare(`INSERT INTO health_records
      (id, type, source_name, source_category, start_at, end_at, metadata_json, raw_attributes_json)
      VALUES (?,?,?,?,?,?,?,?)`);
    const baseInstant = Date.parse("2026-01-01T00:00:00Z");
    for (let index = 0; index < 40_000; index += 1) {
      const isRestingHr = index < 70;
      const startAt = new Date(baseInstant + index * 60_000).toISOString();
      health.run(
        `latency-health-${index}`,
        isRestingHr ? "HKQuantityTypeIdentifierRestingHeartRate" : "HKQuantityTypeIdentifierHeartRate",
        "Watch", "apple_watch", startAt, startAt, "{}", "{}"
      );
    }
    // The 70 resting-HR rows must fall inside the plan snapshot's 70-day window.
    const rhr = database.prepare(`UPDATE health_records SET start_at=?, end_at=? WHERE id=?`);
    for (let index = 0; index < 70; index += 1) {
      const startAt = `${shiftDate(today, -index)}T03:00:00.000Z`;
      rhr.run(startAt, startAt, `latency-health-${index}`);
    }
    const night = database.prepare(`INSERT INTO canonical_nights
      (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank, has_stages,
       sleep_onset_at, wake_at, asleep_union_minutes, stage_minutes_json, segment_count, provenance_json, computed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const hrv = database.prepare(`INSERT INTO canonical_hrv_days
      (id, local_date, timezone_identifier, night_id, sample_count, confidence, provenance_json, computed_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (let index = 0; index < 400; index += 1) {
      const date = shiftDate(today, -index);
      night.run(`latency-night-${index}`, date, DATABASE_TIMEZONE, "main", "Watch", "apple_watch",
        1, 0, `${shiftDate(date, -1)}T15:00:00.000Z`, `${date}T23:00:00.000Z`, 480, "{}", 1, "{}",
        `${date}T01:00:00.000Z`);
      hrv.run(`latency-hrv-${index}`, date, DATABASE_TIMEZONE, `latency-night-${index}`,
        1, "confident", "{}", `${date}T01:00:00.000Z`);
    }
    const workout = database.prepare(`INSERT INTO workouts
      (id, activity_type, source_name, source_category, start_at, end_at, duration_seconds, metadata_json, raw_attributes_json)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const session = database.prepare(`INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const statistic = database.prepare(`INSERT INTO workout_statistics
      (workout_id, ordinal, type, unit, sum_value) VALUES (?,?,?,?,?)`);
    for (let index = 0; index < 400; index += 1) {
      const day = shiftDate(today, -(index % 56));
      const startAt = `${day}T${String(6 + (index % 12)).padStart(2, "0")}:00:00.000Z`;
      const endAt = `${day}T${String(7 + (index % 12)).padStart(2, "0")}:00:00.000Z`;
      workout.run(`latency-workout-${index}`, "HKWorkoutActivityTypeRunning", "Watch", "apple_watch",
        startAt, endAt, 3600, "{}", "{}");
      session.run(`latency-session-${index}`, "HKWorkoutActivityTypeRunning", startAt, endAt,
        10, `latency-workout-${index}`, "active", startAt, startAt);
      statistic.run(`latency-workout-${index}`, 0, "HKQuantityTypeIdentifierDistanceWalkingRunning", "km", 10);
      statistic.run(`latency-workout-${index}`, 1, "HKQuantityTypeIdentifierActiveEnergyBurned", "kcal", 500);
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    database.close();
  }
  // Control database: plan history is part of the aggregate (P3-2 token input and
  // adherence/recentPlanExecution). Create the schema through the store, then
  // append 200 revisions as an external writer would.
  const controlPath = join(root, "control.sqlite");
  const store = new MobileGoalsStore(root, controlPath);
  store.close();
  const control = new DatabaseSync(controlPath);
  try {
    control.exec("BEGIN IMMEDIATE");
    const history = control.prepare("INSERT INTO mobile_goals_history (revision, payload_json, changed_at) VALUES (?,?,?)");
    for (let index = 1; index <= 200; index += 1) {
      history.run(index, JSON.stringify({ weekPlan: [], lockedSession: null }),
        new Date(Date.parse("2026-01-01T00:00:00Z") + index * 86_400_000).toISOString());
    }
    control.exec("COMMIT");
  } finally { control.close(); }
  return { rows: 40_000 + 400 + 400 + 400 + 400 + 800 + 200 };
};

const measureTrainingPlanState = (path: string, root: string, iterations: number): number[] => {
  const store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const read = new RaiReadStore(path);
  try {
    // One warm-up call (page cache / prepared statements) before measuring.
    read.trainingPlanState(store, identity);
    const samples: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      const state = read.trainingPlanState(store, identity);
      samples.push(performance.now() - started);
      assert.equal(state.metadata.goalsRevision, state.goals.revision);
    }
    return samples;
  } finally {
    read.close();
    store.close();
  }
};

test("training-plan-state latency: empty vs ~43k-row production approximation (p50/p95, diagnostic)", async t => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "rai-latency-empty-"));
  const scaleRoot = mkdtempSync(join(tmpdir(), "rai-latency-scale-"));
  const emptyPath = join(emptyRoot, "facts.sqlite");
  const scalePath = join(scaleRoot, "facts.sqlite");
  let scaleRows = 0;
  try {
    // Empty schema-only database.
    let db = await RaiDatabase.open(emptyPath);
    db.close();
    const emptySamples = measureTrainingPlanState(emptyPath, emptyRoot, 20);
    const emptyP50 = percentile(emptySamples, 0.5);
    const emptyP95 = percentile(emptySamples, 0.95);

    db = await RaiDatabase.open(scalePath);
    db.close();
    scaleRows = seedScaleDatabase(scalePath, scaleRoot).rows;
    const scaleSamples = measureTrainingPlanState(scalePath, scaleRoot, 20);
    const scaleP50 = percentile(scaleSamples, 0.5);
    const scaleP95 = percentile(scaleSamples, 0.95);

    t.diagnostic(`empty db n=20: p50=${emptyP50.toFixed(2)}ms p95=${emptyP95.toFixed(2)}ms`);
    t.diagnostic(`~${scaleRows} rows (40k health_records + 400 nights/hrv + 400 workouts/sessions + 800 stats + 200 history) n=20: p50=${scaleP50.toFixed(2)}ms p95=${scaleP95.toFixed(2)}ms`);
    // Loose upper bounds: this is a measurement test, not an SLA. A pathological
    // regression (e.g. full table scans on every read) would blow well past these.
    assert.ok(emptyP95 < 2_000, `empty-db p95 ${emptyP95.toFixed(2)}ms`);
    assert.ok(scaleP95 < 5_000, `scale-db p95 ${scaleP95.toFixed(2)}ms`);
    assert.ok(Number.isFinite(scaleP50) && scaleP50 >= 0);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
    rmSync(scaleRoot, { recursive: true, force: true });
  }
});
