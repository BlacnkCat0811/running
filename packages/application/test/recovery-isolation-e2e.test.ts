import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { healthTypes, type WorkoutFeatureVector } from "@rai/contracts";
import { extractWorkoutFeatureVector, type WorkoutFeatureSource } from "@rai/features";
import {
  scoreFeature as scoreFeatureWithHistory,
  updateTrueAbilityFromFeatureScore,
  type PersonalBaseline
} from "@rai/scoring";

// §6.2 stratum sufficiency is covered by its own test file; this fixture is about
// recovery isolation, so it states a mature history up front.
const SUFFICIENT_HISTORY: Parameters<typeof scoreFeatureWithHistory>[3] = { independentSessions: 24, spanDays: 90 };
const scoreFeature = (
  feature: WorkoutFeatureVector,
  baseline: PersonalBaseline,
  maturity: number,
  config?: Parameters<typeof scoreFeatureWithHistory>[4]
) => scoreFeatureWithHistory(feature, baseline, maturity, SUFFICIENT_HISTORY, config);
import {
  RaiDatabase,
  RecomputeJobRepository,
  SqliteModelRunRepository,
  SqliteTrainingSessionRepository
} from "@rai/storage-sqlite";

import { RecomputePipeline } from "../src/services/recompute-pipeline.js";

// -----------------------------------------------------------------------------
// End-to-end recovery-isolation test (F01).
//
// The other two isolation tests start from a feature vector, so they cannot see
// the link this one covers: raw recovery facts -> `loadPersonalRecovery` ->
// `buildFeatureSource`. §16.2 requires F01 to run from the raw fact assembly
// entry for exactly that reason.
//
// Only sleep / HRV / resting heart rate differ between the two runs. Everything
// else — workout, heart rate, speed, distance, baseline, config — is identical.
// -----------------------------------------------------------------------------

const TIMEZONE = "Asia/Shanghai";
const SOURCE_NAME = "Apple Watch";
const DAY_MS = 86_400_000;
const WORKOUT_START = "2026-03-01T06:00:00.000Z"; // 14:00 Asia/Shanghai
const WORKOUT_END = "2026-03-01T07:00:00.000Z";
const EVALUATED_AT = "2026-03-02T00:00:00.000Z";
const START_MS = Date.parse(WORKOUT_START);
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

/** Fixed by F01: only recovery may vary, so the baseline is a constant literal. */
const FIXED_BASELINE: PersonalBaseline = {
  calibrationFeatureIds: ["calibration"],
  calibrationStartAt: "2026-01-01T00:00:00.000Z",
  calibrationEndAt: "2026-01-15T00:00:00.000Z",
  dimensions: {
    efficiency: { center: 0.022, scale: 0.002 },
    pace: { center: 2.8, scale: 0.3 },
    stability: { center: 0.8, scale: 0.1 },
    recovery: { center: 0.7, scale: 0.1 }
  }
};

interface RecoveryVariant {
  restingHeartRate: number;
  sleepMinutes: number;
  hrvMs: number;
}

const RESTED: RecoveryVariant = { restingHeartRate: 50, sleepMinutes: 430, hrvMs: 52 };
const POORLY_RECOVERED: RecoveryVariant = { restingHeartRate: 62, sleepMinutes: 280, hrvMs: 35 };

const REFERENCE_DAYS = 26;

function seed(database: DatabaseSync, recovery: RecoveryVariant, baselineDays = REFERENCE_DAYS): void {
  const record = database.prepare(`
    INSERT INTO health_records
      (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
    VALUES (?, ?, ?, 'apple_watch', ?, ?, ?, ?, '{}', '{}')
  `);
  // Daily readings from two days back onwards. Two reasons for the offset: the
  // personal reference is a median over these, and they must sit outside the
  // 36-hour "recent" window so today's reading is the only recent one. Together
  // that is what makes "today changed, reference did not" a real statement.
  for (let day = 2; day <= 1 + baselineDays; day += 1) {
    const at = START_MS - day * DAY_MS;
    record.run(`rhr-${day}`, healthTypes.restingHeartRate, SOURCE_NAME, "count/min", 50, iso(at), iso(at + 60_000));
  }
  // Today's recovery observation — the only value that differs between variants.
  const todayAt = START_MS - 2 * 3_600_000;
  record.run("rhr-today", healthTypes.restingHeartRate, SOURCE_NAME, "count/min", recovery.restingHeartRate, iso(todayAt), iso(todayAt + 60_000));
  // The observed maximum heart rate used as the reserve denominator.
  const peakAt = START_MS - 100 * DAY_MS;
  record.run("hr-peak", healthTypes.heartRate, SOURCE_NAME, "count/min", 190, iso(peakAt), iso(peakAt + 60_000));
  // In-workout heart rate and speed covering the whole hour: the eligibility rules
  // want at least ten samples and half the duration covered, or the feature is
  // only a trial and current ability is never computed.
  for (let index = 0; index < 12; index += 1) {
    const at = START_MS + index * 300_000;
    record.run(`hr-workout-${index}`, healthTypes.heartRate, SOURCE_NAME, "count/min", 130, iso(at), iso(at + 300_000));
    record.run(`speed-${index}`, healthTypes.runningSpeed, SOURCE_NAME, "m/s", 2.8, iso(at), iso(at + 300_000));
  }

  database.prepare(`
    INSERT INTO workouts
      (id, activity_type, source_name, source_category, start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
    VALUES ('w1', 'HKWorkoutActivityTypeRunning', ?, 'apple_watch', ?, ?, 3600, 0, '{}', '{}', 1)
  `).run(SOURCE_NAME, WORKOUT_START, WORKOUT_END);
  database.prepare(`
    INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, canonical_workout_id, status,
       created_at, updated_at)
    VALUES ('s1', 'HKWorkoutActivityTypeRunning', ?, ?, 'w1', 'active', ?, ?)
  `).run(WORKOUT_START, WORKOUT_END, EVALUATED_AT, EVALUATED_AT);
  database.prepare(`
    INSERT INTO workout_statistics (workout_id, ordinal, type, unit, sum_value)
    VALUES ('w1', 0, ?, 'km', 10)
  `).run(healthTypes.distanceWalkingRunning);

  const wakeAt = START_MS - 2 * 3_600_000;
  database.prepare(`
    INSERT INTO canonical_nights
      (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank,
       has_stages, sleep_onset_at, wake_at, asleep_union_minutes, stage_minutes_json,
       segment_count, provenance_json, computed_at)
    VALUES ('n1', '2026-03-01', ?, 'main', ?, 'apple_watch', 1, 0, ?, ?, ?, '{}', 1, '{}', ?)
  `).run(TIMEZONE, SOURCE_NAME, iso(wakeAt - 7 * 3_600_000), iso(wakeAt), recovery.sleepMinutes, EVALUATED_AT);
  database.prepare(`
    INSERT INTO canonical_hrv_days
      (id, local_date, timezone_identifier, night_id, hrv_sdnn_ms, sample_count, confidence,
       window_end_at, provenance_json, computed_at)
    VALUES ('h1', '2026-03-01', ?, 'n1', ?, 20, 'confident', ?, '{}', ?)
  `).run(TIMEZONE, recovery.hrvMs, iso(wakeAt), EVALUATED_AT);
}

/**
 * `buildFeatureSource` / `loadSessions` are private. The test deliberately reaches
 * through that seam: they *are* the raw fact assembly entry the invariant is
 * about, and re-deriving their behaviour elsewhere would test a copy instead.
 */
interface PipelineInternals {
  loadSessions(evaluatedAt: string): Array<Record<string, unknown>>;
  buildFeatureSource(row: Record<string, unknown>, override: unknown, timezone: string): WorkoutFeatureSource;
}

async function buildSource(
  recovery: RecoveryVariant,
  baselineDays = REFERENCE_DAYS,
  amend?: (database: DatabaseSync) => void
): Promise<WorkoutFeatureSource> {
  const directory = mkdtempSync(join(tmpdir(), "rai-f01-"));
  const store = await RaiDatabase.open(join(directory, "rai.sqlite"), { createMigrationBackup: false });
  try {
    seed(store.database, recovery, baselineDays);
    amend?.(store.database);
    const pipeline = new RecomputePipeline(
      store,
      new RecomputeJobRepository(store.database),
      new SqliteModelRunRepository(store.database),
      new SqliteTrainingSessionRepository(store.database)
    );
    const internals = pipeline as unknown as PipelineInternals;
    const session = internals.loadSessions(EVALUATED_AT)[0];
    assert.ok(session, "fixture session was not loaded");
    return internals.buildFeatureSource(session, null, TIMEZONE);
  } finally {
    store.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("changing only recovery facts leaves ability, session type and learning untouched", async () => {
  const rested = await buildSource(RESTED);
  const poor = await buildSource(POORLY_RECOVERED);

  // The recovery observation really did change — otherwise the rest of this test
  // would pass for the wrong reason.
  assert.notEqual(poor.restingHeartRate, rested.restingHeartRate);
  assert.notEqual(poor.sleepDurationMinutes, rested.sleepDurationMinutes);
  assert.notEqual(poor.hrvSdnn, rested.hrvSdnn);

  // The long-term reference is a median over the preceding days, so one bad
  // morning must not move it.
  assert.equal(rested.restingHeartRateReference, 50);
  assert.equal(poor.restingHeartRateReference, 50);

  const restedFeature = extractWorkoutFeatureVector("f", "run", rested, undefined, EVALUATED_AT);
  const poorFeature = extractWorkoutFeatureVector("f", "run", poor, undefined, EVALUATED_AT);

  // The intensity path reads the reference, so it cannot move with recovery.
  assert.equal(restedFeature.signals.heartRateReserveFraction, (130 - 50) / (190 - 50));
  assert.equal(poorFeature.signals.heartRateReserveFraction, restedFeature.signals.heartRateReserveFraction);
  assert.equal(poorFeature.sessionType, restedFeature.sessionType);
  // Guards against the whole test passing because every run collapsed to unknown.
  assert.notEqual(restedFeature.sessionType, "unknown");

  // And therefore neither can current ability, confidence or the TA update.
  const restedScore = scoreFeature(restedFeature, FIXED_BASELINE, 1);
  const poorScore = scoreFeature(poorFeature, FIXED_BASELINE, 1);
  assert.equal(restedScore.status, "eligible");
  assert.equal(poorScore.currentAbility, restedScore.currentAbility);
  assert.equal(poorScore.confidence, restedScore.confidence);
  assert.deepEqual(poorScore.effectiveWeights, restedScore.effectiveWeights);
  assert.equal(poorScore.evidenceStrength, restedScore.evidenceStrength);

  // The recovery dimension itself is expected to differ — it is still computed
  // and displayed, it just no longer scores.
  assert.notEqual(poorScore.dimensions.recovery, restedScore.dimensions.recovery);

  for (const trueAbility of [70, 40]) {
    assert.deepEqual(
      updateTrueAbilityFromFeatureScore(trueAbility, 30, poorScore),
      updateTrueAbilityFromFeatureScore(trueAbility, 30, restedScore)
    );
  }
});

test("the recovery facts really do reach the feature source", async () => {
  // The mirror of the test above: without this, a fixture that silently failed to
  // wire recovery in would make the isolation assertion vacuous.
  const poor = await buildSource(POORLY_RECOVERED);
  assert.equal(poor.restingHeartRate, 62);
  assert.equal(poor.sleepDurationMinutes, 280);
  assert.equal(poor.hrvSdnn, 35);
  assert.equal(poor.recoveryBaseline?.restingHeartRateBpm, 50);
  // The two are genuinely different fields with different meanings.
  assert.notEqual(poor.restingHeartRate, poor.restingHeartRateReference);
});

test("insufficient reference days never reopen the current-day recovery channel", async () => {
  const thin = await buildSource({ ...RESTED, restingHeartRate: 58 }, 2);
  assert.equal(thin.recoveryBaseline?.restingHeartRateBpm, null);
  assert.equal(thin.restingHeartRate, 58);
  assert.equal(thin.restingHeartRateReference, null);
  const poor = await buildSource(POORLY_RECOVERED, 2);
  const first = extractWorkoutFeatureVector("f", "run", thin, undefined, EVALUATED_AT);
  const second = extractWorkoutFeatureVector("f", "run", poor, undefined, EVALUATED_AT);
  assert.equal(first.signals.heartRateReserveFraction, null);
  assert.equal(second.signals.heartRateReserveFraction, null);
  assert.equal(first.sessionType, second.sessionType);
  assert.equal(scoreFeature(first, FIXED_BASELINE, 1).currentAbility,
    scoreFeature(second, FIXED_BASELINE, 1).currentAbility);
});

test("today cannot become the seventh baseline day and repeated samples cannot become independent days", async () => {
  const sixDays = await buildSource(RESTED, 6);
  assert.equal(sixDays.restingHeartRateReference, null);
  const repeated = await buildSource(RESTED, 2, (db) => {
    for (let n = 0; n < 12; n++) db.prepare(`
      INSERT INTO health_records
        (id,type,source_name,source_category,unit,value_numeric,start_at,end_at,metadata_json,raw_attributes_json)
      VALUES (?,?,'Apple Watch','apple_watch','count/min',50,?,?,'{}','{}')
    `).run(`repeat-${n}`, healthTypes.restingHeartRate,
      iso(START_MS - 2 * DAY_MS + n * 60_000), iso(START_MS - 2 * DAY_MS + (n + 1) * 60_000));
  });
  assert.equal(repeated.restingHeartRateReference, null);
  assert.equal(repeated.recoveryBaseline?.validDays?.rhr, 2);
});
