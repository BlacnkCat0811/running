import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";

import {
  RaiApplicationService,
  TrainingZoneProfileRevisionConflictError,
  TrainingZoneProfileValidationError,
  WorkoutNotFoundError
} from "../src/index.js";

function dateForRun(index: number): string {
  return new Date(Date.UTC(2025, 0, 1 + index * 3, 0, 0, 0)).toISOString();
}

async function seedDatabase(path: string): Promise<RaiDatabase> {
  const store = await RaiDatabase.open(path);
  const database = store.database;
  database.prepare("INSERT INTO import_manifest (key, value) VALUES (?, ?)").run(
    "dataset_version",
    "dataset_fixture_v1"
  );
  database.prepare("INSERT INTO import_manifest (key, value) VALUES (?, ?)").run(
    "parser_contract_version",
    "canonical-health-v1"
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
    const workoutId = `workout_${index}`;
    const sessionId = `session_${index}`;
    const start = dateForRun(index);
    const end = new Date(Date.parse(start) + 1_800_000).toISOString();
    insertWorkout.run(workoutId, start, end);
    insertStatistic.run(
      workoutId,
      0,
      "HKQuantityTypeIdentifierDistanceWalkingRunning",
      "km",
      5,
      null,
      null,
      null
    );
    insertStatistic.run(
      workoutId,
      1,
      "HKQuantityTypeIdentifierHeartRate",
      "count/min",
      null,
      145 - index,
      130,
      165
    );
    insertStatistic.run(
      workoutId,
      2,
      "HKQuantityTypeIdentifierRunningSpeed",
      "km/hr",
      null,
      10 + index * 0.15,
      9,
      11
    );
    insertSession.run(sessionId, start, end, workoutId);
  }
  return store;
}

test("creates immutable feature/model runs and switches the active model", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-application-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seedDatabase(databasePath);
  try {
    const service = new RaiApplicationService(store);
    const firstJobId = service.enqueueFullRecompute({
      evaluatedAt: dateForRun(8),
      timezoneIdentifier: "UTC"
    });
    const firstJob = service.runNextJob();
    assert.equal(firstJob?.id, firstJobId);
    assert.equal(firstJob?.status, "succeeded");
    const contract = store.database
      .prepare("SELECT canonical_contract_version AS version FROM feature_runs WHERE id = ?")
      .get(firstJob?.featureRunId) as unknown as { version: string };
    assert.equal(contract.version, "canonical-health-v1");

    const counts = store.database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM feature_runs WHERE status = 'succeeded') AS featureRuns,
          (SELECT COUNT(*) FROM model_runs WHERE status = 'succeeded') AS modelRuns,
          (SELECT COUNT(*) FROM workout_features) AS features,
          (SELECT COUNT(*) FROM ability_assessments) AS assessments,
          (SELECT COUNT(*) FROM daily_ability_snapshots) AS snapshots,
          (SELECT COUNT(*) FROM training_metric_runs WHERE status = 'succeeded') AS metricRuns,
          (SELECT COUNT(*) FROM workout_training_loads) AS trainingLoads,
          (SELECT COUNT(*) FROM daily_zone_profiles) AS zoneProfiles,
          (SELECT COUNT(*) FROM workout_zone_summaries) AS zoneSummaries,
          (SELECT COUNT(*) FROM daily_training_metrics) AS trainingDays,
          (SELECT COUNT(*) FROM active_model_run) AS activeModels
      `)
      .get() as unknown as Record<string, number>;
    assert.equal(counts.featureRuns, 1);
    assert.equal(counts.modelRuns, 1);
    assert.equal(counts.features, 8);
    assert.equal(counts.assessments, 8);
    assert.ok(Number(counts.snapshots ?? 0) >= 22);
    assert.equal(counts.metricRuns, 1);
    assert.equal(counts.trainingLoads, 8);
    assert.ok(Number(counts.zoneProfiles ?? 0) >= 22);
    assert.equal(counts.zoneSummaries, 8);
    assert.ok(Number(counts.trainingDays ?? 0) >= 22);
    assert.equal(counts.activeModels, 1);
    const initialSnapshot = store.database
      .prepare("SELECT snapshot_status AS status FROM daily_ability_snapshots ORDER BY local_date LIMIT 1")
      .get() as unknown as { status: string };
    assert.equal(initialSnapshot.status, "calibrating");

    const firstOverride = service.appendWorkoutOverride({
      trainingSessionId: "session_7",
      eligibilityOverride: "exclude",
      statisticsParticipation: null,
      sessionType: "race",
      performanceProtocol: "other_race",
      rpe: 8,
      conditionTags: ["fixture"],
      note: "Exclude test run"
    });
    const secondJob = service.runNextJob();
    assert.equal(secondJob?.id, firstOverride.jobId);
    assert.match(firstOverride.overrideId, /^workout_override_/);
    assert.equal(secondJob?.status, "succeeded", JSON.stringify(secondJob));
    const metricConfig = store.database.prepare(`
      SELECT metric.config_json AS configJson
      FROM training_metric_runs metric
      WHERE metric.model_run_id = ?
    `).get(secondJob?.modelRunId) as unknown as { configJson: string };
    assert.deepEqual(
      (JSON.parse(metricConfig.configJson) as { overrideSnapshotIds: string[] }).overrideSnapshotIds,
      [firstOverride.overrideId]
    );

    const active = store.database
      .prepare("SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1")
      .get() as unknown as { modelRunId: string };
    const runCount = store.database
      .prepare("SELECT COUNT(*) AS count FROM model_runs WHERE status = 'succeeded'")
      .get() as unknown as { count: number };
    const excluded = store.database
      .prepare(`
        SELECT assessment_status AS status
        FROM active_ability_assessments
        WHERE training_session_id = 'session_7'
      `)
      .get() as unknown as { status: string };
    assert.equal(runCount.count, 2);
    assert.ok(active.modelRunId.length > 0);
    assert.equal(excluded.status, "excluded");
    const stillIncludedInStatistics = store.database
      .prepare(`
        SELECT COUNT(*) AS count FROM active_workout_training_loads
        WHERE training_session_id = 'session_7'
      `)
      .get() as unknown as { count: number };
    assert.equal(stillIncludedInStatistics.count, 1);
    const protocol = store.database
      .prepare("SELECT performance_protocol AS protocol FROM effective_workout_overrides WHERE training_session_id = 'session_7'")
      .get() as unknown as { protocol: string };
    assert.equal(protocol.protocol, "other_race");

    service.appendWorkoutOverride({
      trainingSessionId: "session_7",
      eligibilityOverride: "exclude",
      statisticsParticipation: "exclude",
      sessionType: "race",
      performanceProtocol: "other_race",
      rpe: 8,
      conditionTags: ["fixture"],
      note: "Exclude from both RAI and statistics"
    });
    const thirdJob = service.runNextJob();
    assert.equal(thirdJob?.status, "succeeded");
    const excludedFromStatistics = store.database
      .prepare(`
        SELECT COUNT(*) AS count FROM active_workout_training_loads
        WHERE training_session_id = 'session_7'
      `)
      .get() as unknown as { count: number };
    assert.equal(excludedFromStatistics.count, 0);
    const effectiveParticipation = store.database
      .prepare(`
        SELECT statistics_participation AS participation
        FROM effective_workout_overrides WHERE training_session_id = 'session_7'
      `)
      .get() as unknown as { participation: string };
    assert.equal(effectiveParticipation.participation, "exclude");

    const beforeRefresh = store.database
      .prepare("SELECT COUNT(*) AS count FROM active_daily_training_metrics")
      .get() as unknown as { count: number };
    const refreshJobId = service.enqueueSnapshotRefresh({
      evaluatedAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      timezoneIdentifier: "UTC"
    });
    const refreshJob = service.runNextJob();
    assert.equal(refreshJob?.id, refreshJobId);
    assert.equal(refreshJob?.status, "succeeded");
    const afterRefresh = store.database
      .prepare("SELECT COUNT(*) AS count FROM active_daily_training_metrics")
      .get() as unknown as { count: number };
    assert.ok(afterRefresh.count > beforeRefresh.count);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("freezes the override snapshot before feature extraction starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-override-snapshot-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    const pipeline = Reflect.get(service, "pipeline") as object;
    const extractFeatures = Reflect.get(pipeline, "extractFeatures") as (
      ...args: unknown[]
    ) => unknown;
    let inserted = false;
    Reflect.set(pipeline, "extractFeatures", (...args: unknown[]) => {
      if (!inserted) {
        inserted = true;
        store.database.exec(`
          INSERT INTO workout_overrides (
            id, training_session_id, revision, session_type, rpe,
            condition_tags_json, note
          ) VALUES (
            'mid-run-override', 'session_7', 1, 'race', 10, '[]',
            'Inserted after the recompute snapshot was captured'
          )
        `);
      }
      return extractFeatures.apply(pipeline, args);
    });

    service.enqueueFullRecompute({ evaluatedAt: dateForRun(8), timezoneIdentifier: "UTC" });
    const completed = service.runNextJob();
    assert.equal(completed?.status, "succeeded");
    const row = store.database.prepare(`
      SELECT metric.config_json AS configJson, load.rpe
      FROM training_metric_runs metric
      JOIN workout_training_loads load ON load.training_metric_run_id = metric.id
      WHERE metric.model_run_id = ? AND load.training_session_id = 'session_7'
    `).get(completed?.modelRunId) as unknown as { configJson: string; rpe: number | null };
    assert.deepEqual(
      (JSON.parse(row.configJson) as { overrideSnapshotIds: string[] }).overrideSnapshotIds,
      []
    );
    assert.equal(row.rpe, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical recompute excludes sessions that have not ended by evaluatedAt", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-historical-recompute-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seedDatabase(databasePath);
  try {
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: dateForRun(8), timezoneIdentifier: "UTC" });
    assert.equal(service.runNextJob()?.status, "succeeded");

    store.setManifest("dataset_version", "dataset_historical_fixture");
    store.flush();
    const jobId = service.enqueueIncrementalRecompute({
      mode: "partial",
      dirtySessionIds: [],
      dirtyFromAt: dateForRun(7),
      reasons: ["workout_or_route_change"]
    }, {
      evaluatedAt: dateForRun(5),
      timezoneIdentifier: "UTC"
    });
    assert.ok(jobId);
    const job = service.runNextJob();
    assert.equal(job?.status, "succeeded");

    const counts = store.database.prepare(`
      SELECT feature.reused_feature_count AS reused,
             feature.recomputed_feature_count AS recomputed,
             (SELECT COUNT(*) FROM workout_features WHERE feature_run_id = feature.id) AS features,
             (SELECT COUNT(*) FROM ability_assessments WHERE model_run_id = model.id) AS assessments
      FROM active_model_run active
      JOIN model_runs model ON model.id = active.model_run_id
      JOIN feature_runs feature ON feature.id = model.feature_run_id
    `).get() as unknown as { reused: number; recomputed: number; features: number; assessments: number };
    assert.deepEqual({ ...counts }, { reused: 5, recomputed: 0, features: 5, assessments: 5 });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes offset recompute boundaries before filtering and prefix reuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-offset-recompute-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({
      evaluatedAt: "2025-01-16T08:00:00+08:00",
      timezoneIdentifier: "UTC"
    });
    assert.equal(service.runNextJob()?.status, "succeeded");
    assert.equal((store.database.prepare(`
      SELECT COUNT(*) AS count
      FROM active_model_run active
      JOIN model_runs model ON model.id = active.model_run_id
      JOIN workout_features feature ON feature.feature_run_id = model.feature_run_id
    `).get() as unknown as { count: number }).count, 5);

    store.setManifest("dataset_version", "dataset_offset_incremental_fixture");
    store.flush();
    const jobId = service.enqueueIncrementalRecompute({
      mode: "partial",
      dirtySessionIds: [],
      dirtyFromAt: "2025-01-10T19:00:00-05:00",
      reasons: ["workout_or_route_change"]
    }, {
      evaluatedAt: "2025-01-16T08:00:00+08:00",
      timezoneIdentifier: "UTC"
    });
    assert.ok(jobId);
    assert.equal(service.runNextJob()?.status, "succeeded");
    const featureRun = store.database.prepare(`
      SELECT feature.reused_feature_count AS reused, feature.recomputed_feature_count AS recomputed
      FROM active_model_run active
      JOIN model_runs model ON model.id = active.model_run_id
      JOIN feature_runs feature ON feature.id = model.feature_run_id
    `).get() as unknown as { reused: number; recomputed: number };
    assert.deepEqual({ ...featureRun }, { reused: 4, recomputed: 1 });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects invalid recompute timestamps before enqueue", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-invalid-recompute-time-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    assert.throws(() => service.enqueueFullRecompute({ evaluatedAt: "not-a-date" }), /evaluatedAt/);
    assert.throws(() => service.enqueueIncrementalRecompute({
      mode: "partial", dirtySessionIds: [], dirtyFromAt: "invalid", reasons: []
    }), /dirtyFromAt/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates and revisions training zone profile settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-zone-settings-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    const first = service.appendTrainingZoneProfileSettings({
      expectedRevision: 0,
      restingHeartRate: { mode: "manual", valueBpm: 55 },
      maximumHeartRate: { mode: "manual", valueBpm: 195 },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 330 }
    }, "UTC");
    assert.equal(first.revision, 1);
    assert.equal(first.restingHeartRate.valueBpm, 55);
    assert.throws(() => service.appendTrainingZoneProfileSettings({
      expectedRevision: 0,
      restingHeartRate: { mode: "auto", valueBpm: null },
      maximumHeartRate: { mode: "auto", valueBpm: null },
      lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null }
    }, "UTC"), (error: unknown) => error instanceof TrainingZoneProfileRevisionConflictError);
    assert.throws(() => service.appendTrainingZoneProfileSettings({
      expectedRevision: 1,
      restingHeartRate: { mode: "manual", valueBpm: 34 },
      maximumHeartRate: { mode: "manual", valueBpm: 195 },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 330 }
    }, "UTC"), (error: unknown) =>
      error instanceof TrainingZoneProfileValidationError && /between 35 and 110/.test(error.message));
    assert.throws(() => service.appendTrainingZoneProfileSettings({
      expectedRevision: 1,
      restingHeartRate: { mode: "manual", valueBpm: 100 },
      maximumHeartRate: { mode: "manual", valueBpm: 125 },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 901 }
    }, "UTC"), (error: unknown) =>
      error instanceof TrainingZoneProfileValidationError && /between 150 and 900/.test(error.message));
    assert.throws(() => service.appendTrainingZoneProfileSettings({
      expectedRevision: 1,
      restingHeartRate: { mode: "manual", valueBpm: 100 },
      maximumHeartRate: { mode: "manual", valueBpm: 125 },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 330 }
    }, "UTC"), (error: unknown) =>
      error instanceof TrainingZoneProfileValidationError && /at least 30 bpm/.test(error.message));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps used daily zone profiles frozen during snapshot refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-zone-profile-freeze-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: dateForRun(8), timezoneIdentifier: "UTC" });
    assert.equal(service.runNextJob()?.status, "succeeded");
    const frozenThrough = store.database
      .prepare("SELECT MAX(local_date) AS localDate FROM active_daily_zone_profiles")
      .get() as unknown as { localDate: string };
    const frozenBefore = store.database
      .prepare("SELECT * FROM active_daily_zone_profiles WHERE local_date <= ? ORDER BY local_date")
      .all(frozenThrough.localDate);

    const futureEvidenceAt = new Date(Date.parse(dateForRun(8)) + 86_400_000).toISOString();
    store.database.prepare(`
      INSERT INTO health_records (
        id, type, source_name, source_category, unit, value_numeric,
        start_at, end_at, metadata_json, raw_attributes_json
      ) VALUES ('future_resting_hr', 'HKQuantityTypeIdentifierRestingHeartRate',
        'Fixture Apple Watch', 'apple_watch', 'count/min', 100, ?, ?, '{}', '{}')
    `).run(futureEvidenceAt, futureEvidenceAt);

    service.enqueueSnapshotRefresh({
      evaluatedAt: new Date(Date.parse(dateForRun(8)) + 3 * 86_400_000).toISOString(),
      timezoneIdentifier: "UTC"
    });
    assert.equal(service.runNextJob()?.status, "succeeded");
    const frozenAfter = store.database
      .prepare("SELECT * FROM active_daily_zone_profiles WHERE local_date <= ? ORDER BY local_date")
      .all(frozenThrough.localDate);
    const refreshedThrough = store.database
      .prepare("SELECT MAX(local_date) AS localDate FROM active_daily_zone_profiles")
      .get() as unknown as { localDate: string };
    assert.deepEqual(frozenAfter, frozenBefore);
    assert.ok(refreshedThrough.localDate > frozenThrough.localDate);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rolls back active activation when job completion cannot be persisted", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-activation-rollback-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: dateForRun(8), timezoneIdentifier: "UTC" });
    assert.equal(service.runNextJob()?.status, "succeeded");
    const initialActive = store.database
      .prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1")
      .get() as unknown as { id: string };

    store.database.exec(`
      CREATE TRIGGER fail_completed_recompute_event
      BEFORE INSERT ON recompute_job_events
      WHEN NEW.phase = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'fixture completion failure');
      END;
    `);
    service.enqueueFullRecompute({ evaluatedAt: dateForRun(9), timezoneIdentifier: "UTC" });
    const failed = service.runNextJob();
    assert.equal(failed?.status, "failed");
    const activeAfterFailure = store.database
      .prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1")
      .get() as unknown as { id: string };
    assert.equal(activeAfterFailure.id, initialActive.id);
    const failedModel = store.database
      .prepare("SELECT status FROM model_runs WHERE id = ?")
      .get(failed?.modelRunId ?? "") as unknown as { status: string };
    assert.equal(failedModel.status, "failed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rolls back a job claim when its claimed event cannot be persisted", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-claim-rollback-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    const jobId = service.enqueueFullRecompute({
      evaluatedAt: dateForRun(8),
      timezoneIdentifier: "UTC"
    });
    store.database.exec(`
      CREATE TRIGGER fail_claimed_recompute_event
      BEFORE INSERT ON recompute_job_events
      WHEN NEW.phase = 'claimed'
      BEGIN
        SELECT RAISE(ABORT, 'fixture claimed event failure');
      END;
    `);

    assert.throws(() => service.runNextJob(), /fixture claimed event failure/);
    const queued = store.database.prepare(`
      SELECT status, started_at AS startedAt, progress_phase AS progressPhase
      FROM recompute_jobs WHERE id = ?
    `).get(jobId) as unknown as {
      status: string;
      startedAt: string | null;
      progressPhase: string;
    };
    assert.equal(queued.status, "queued");
    assert.equal(queued.startedAt, null);
    assert.equal(queued.progressPhase, "queued");

    store.database.exec("DROP TRIGGER fail_claimed_recompute_event");
    const completed = service.runNextJob();
    assert.equal(completed?.id, jobId);
    assert.equal(completed?.status, "succeeded");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses the best cross-source heart-rate series and weights covered duration", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-heart-interval-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const start = dateForRun(7);
    const tenMinutes = new Date(Date.parse(start) + 10 * 60_000).toISOString();
    const end = new Date(Date.parse(start) + 30 * 60_000).toISOString();
    const previous = new Date(Date.parse(start) - 24 * 60 * 60_000).toISOString();
    const insert = store.database.prepare(`
      INSERT INTO health_records (
        id, type, source_name, source_category, unit, value_numeric,
        start_at, end_at, metadata_json, raw_attributes_json
      ) VALUES (?, ?, 'Fixture Apple Watch', 'apple_watch', 'count/min', ?, ?, ?, '{}', '{}')
    `);
    insert.run("hr_max_prior", "HKQuantityTypeIdentifierHeartRate", 190, previous, previous);
    insert.run("resting_prior", "HKQuantityTypeIdentifierRestingHeartRate", 60, previous, previous);
    insert.run("hr_interval_1", "HKQuantityTypeIdentifierHeartRate", 140, start, tenMinutes);
    insert.run("hr_interval_2", "HKQuantityTypeIdentifierHeartRate", 160, tenMinutes, end);
    store.database.prepare(`
      UPDATE health_records SET source_name = 'Companion Apple Watch'
      WHERE id IN ('hr_interval_1', 'hr_interval_2')
    `).run();

    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: dateForRun(8), timezoneIdentifier: "UTC" });
    assert.equal(service.runNextJob()?.status, "succeeded");
    const feature = store.database.prepare(`
      SELECT average_heart_rate_bpm AS averageHeartRate, heart_rate_coverage AS coverage
      FROM workout_features feature
      JOIN model_runs model ON model.feature_run_id = feature.feature_run_id
      JOIN active_model_run active ON active.model_run_id = model.id
      WHERE feature.training_session_id = 'session_7'
    `).get() as unknown as { averageHeartRate: number; coverage: number };
    assert.ok(Math.abs(feature.averageHeartRate - 153.333333) < 0.001);
    assert.equal(feature.coverage, 1);
    const load = store.database.prepare(`
      SELECT load_source AS source, training_load AS value, internal_load AS internalLoad
      FROM active_workout_training_loads WHERE training_session_id = 'session_7'
    `).get() as unknown as { source: string; value: number; internalLoad: number };
    assert.equal(load.source, "composite");
    assert.ok(Number.isFinite(load.internalLoad) && load.internalLoad > 0);
    assert.ok(Number.isFinite(load.value) && load.value > 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns interrupted recompute jobs to the durable queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-recovery-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    const jobId = service.enqueueFullRecompute({ evaluatedAt: dateForRun(8), timezoneIdentifier: "UTC" });
    store.database.prepare(`
      UPDATE recompute_jobs SET status = 'running', started_at = ?, progress_phase = 'feature_extraction'
      WHERE id = ?
    `).run(new Date().toISOString(), jobId);
    assert.equal(service.recoverInterruptedJobs(), 1);
    const recovered = store.database.prepare(`
      SELECT status, progress_phase AS progressPhase FROM recompute_jobs WHERE id = ?
    `).get(jobId) as unknown as { status: string; progressPhase: string };
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.progressPhase, "recovered");
    assert.equal(service.runNextJob()?.status, "succeeded");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rolls back a workout override when recompute enqueue fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-override-rollback-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    store.database.exec(`
      CREATE TRIGGER fail_recompute_enqueue
      BEFORE INSERT ON recompute_jobs
      BEGIN
        SELECT RAISE(ABORT, 'fixture enqueue failure');
      END;
    `);
    const service = new RaiApplicationService(store);
    assert.throws(() => service.appendWorkoutOverride({
      trainingSessionId: "session_7",
      eligibilityOverride: "exclude",
      statisticsParticipation: null,
      sessionType: "race",
      performanceProtocol: "other_race",
      rpe: 8,
      conditionTags: ["fixture"],
      note: "must roll back"
    }), /fixture enqueue failure/);
    const count = store.database
      .prepare("SELECT COUNT(*) AS count FROM workout_overrides WHERE training_session_id = 'session_7'")
      .get() as unknown as { count: number };
    assert.equal(count.count, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a missing workout with a typed application error", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-override-missing-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    assert.throws(() => service.appendWorkoutOverride({
      trainingSessionId: "missing_session",
      eligibilityOverride: null,
      statisticsParticipation: null,
      sessionType: null,
      performanceProtocol: null,
      rpe: null,
      conditionTags: [],
      note: null
    }), (error: unknown) =>
      error instanceof WorkoutNotFoundError && error.code === "workout_not_found");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("distinguishes missing, active, and terminal job cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-job-cancellation-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    assert.deepEqual(service.requestJobCancellation("missing_job"), { outcome: "not_found" });
    const activeId = service.enqueueFullRecompute({ evaluatedAt: dateForRun(8), timezoneIdentifier: "UTC" });
    assert.deepEqual(service.requestJobCancellation(activeId), {
      outcome: "cancelled",
      status: "cancelled",
      cancelRequested: false
    });
    assert.equal(service.runNextJob(), null);
    const cancelled = store.database.prepare(`
      SELECT status, progress_phase AS progressPhase, completed_at AS completedAt
      FROM recompute_jobs WHERE id = ?
    `).get(activeId) as unknown as { status: string; progressPhase: string; completedAt: string | null };
    assert.deepEqual(
      { status: cancelled.status, progressPhase: cancelled.progressPhase },
      { status: "cancelled", progressPhase: "cancelled" }
    );
    assert.ok(cancelled.completedAt);
    const featureRuns = store.database.prepare("SELECT COUNT(*) AS count FROM feature_runs").get() as unknown as { count: number };
    assert.equal(featureRuns.count, 0);
    assert.deepEqual(service.requestJobCancellation(activeId), { outcome: "terminal" });

    const runningId = service.enqueueFullRecompute({ evaluatedAt: dateForRun(9), timezoneIdentifier: "UTC" });
    store.database.prepare(`
      UPDATE recompute_jobs SET status = 'running', started_at = ?, progress_phase = 'feature_extraction'
      WHERE id = ?
    `).run(new Date().toISOString(), runningId);
    assert.deepEqual(service.requestJobCancellation(runningId), {
      outcome: "cancellation_requested",
      status: "running",
      cancelRequested: true
    });
    const running = store.database.prepare(`
      SELECT status, cancel_requested AS cancelRequested FROM recompute_jobs WHERE id = ?
    `).get(runningId) as unknown as { status: string; cancelRequested: number };
    assert.equal(running.status, "running");
    assert.equal(running.cancelRequested, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes persisted fields when a running recompute reaches cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-running-job-cancellation-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    const jobId = service.enqueueFullRecompute({ evaluatedAt: dateForRun(9), timezoneIdentifier: "UTC" });
    store.database.exec(`
      CREATE TRIGGER request_cancel_after_claim
      AFTER UPDATE OF status ON recompute_jobs
      WHEN NEW.id = '${jobId}' AND NEW.status = 'running'
      BEGIN
        UPDATE recompute_jobs SET cancel_requested = 1 WHERE id = NEW.id;
      END;
    `);

    const result = service.runNextJob();
    assert.equal(result?.status, "cancelled");
    assert.equal(result?.progressPhase, "cancelled");
    assert.equal(result?.cancelRequested, false);
    const persisted = store.database.prepare(`
      SELECT status, progress_phase AS progressPhase,
             cancel_requested AS cancelRequested, completed_at AS completedAt
      FROM recompute_jobs WHERE id = ?
    `).get(jobId) as unknown as {
      status: string;
      progressPhase: string;
      cancelRequested: number;
      completedAt: string | null;
    };
    assert.deepEqual(
      {
        status: persisted.status,
        progressPhase: persisted.progressPhase,
        cancelRequested: persisted.cancelRequested
      },
      { status: "cancelled", progressPhase: "cancelled", cancelRequested: 0 }
    );
    assert.ok(persisted.completedAt);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a completed replay leaves the previous model and prediction activation in place", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-complete-cancel-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({
      evaluatedAt: dateForRun(8),
      timezoneIdentifier: "UTC"
    });
    assert.equal(service.runNextJob()?.status, "succeeded");
    const previousModel = store.database.prepare(`
      SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1
    `).get() as { modelRunId: string };
    const predictionId = "prediction_model_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    store.database.prepare(`
      INSERT INTO prediction_model_runs (
        id, algorithm, model_version, feature_schema_version, ability_baseline_hash,
        training_data_through_at, hyperparameters_json, request_json, status
      ) VALUES (?, 'catboost', 'catboost_v1', 'race_residual_features_v1', 'fixture',
        ?, '{}', '{}', 'succeeded')
    `).run(predictionId, dateForRun(8));
    store.database.prepare(`
      INSERT INTO active_prediction_model (singleton, prediction_model_run_id) VALUES (1, ?)
    `).run(predictionId);

    const jobId = service.enqueueFullRecompute({
      evaluatedAt: dateForRun(8),
      timezoneIdentifier: "UTC"
    });
    store.database.exec(`
      CREATE TRIGGER request_cancel_before_activation
      AFTER UPDATE OF status ON model_runs
      WHEN NEW.status = 'succeeded'
      BEGIN
        UPDATE recompute_jobs SET cancel_requested = 1
        WHERE id = '${jobId}' AND status = 'running';
      END;
    `);

    const result = service.runNextJob();
    assert.equal(result?.id, jobId);
    assert.equal(result?.status, "cancelled");
    assert.equal(result?.cancelRequested, false);
    const active = store.database.prepare(`
      SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1
    `).get() as { modelRunId: string };
    assert.equal(active.modelRunId, previousModel.modelRunId);
    const prediction = store.database.prepare(`
      SELECT prediction_model_run_id AS runId FROM active_prediction_model WHERE singleton = 1
    `).get() as { runId: string };
    assert.equal(prediction.runId, predictionId);
    new RecomputeJobRepository(store.database).fail(jobId, new Error("duplicate fail after cancel"));
    assert.equal(service.requestJobCancellation(jobId).outcome, "terminal");
    assert.equal(
      (store.database.prepare("SELECT status FROM recompute_jobs WHERE id = ?").get(jobId) as { status: string }).status,
      "cancelled"
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling snapshot refresh after writing snapshots keeps the job cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-snapshot-cancel-"));
  const store = await seedDatabase(join(root, "rai.sqlite"));
  try {
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({
      evaluatedAt: dateForRun(8),
      timezoneIdentifier: "UTC"
    });
    assert.equal(service.runNextJob()?.status, "succeeded");

    const jobId = service.enqueueSnapshotRefresh({
      evaluatedAt: new Date(Date.parse(dateForRun(8)) + 3 * 86_400_000).toISOString(),
      timezoneIdentifier: "UTC"
    });
    store.database.exec(`
      CREATE TRIGGER request_cancel_after_snapshot_write
      AFTER INSERT ON daily_ability_snapshots
      BEGIN
        UPDATE recompute_jobs SET cancel_requested = 1
        WHERE id = '${jobId}' AND status = 'running';
      END;
    `);

    const result = service.runNextJob();
    assert.equal(result?.id, jobId);
    assert.equal(result?.status, "cancelled");
    assert.equal(result?.progressPhase, "cancelled");
    assert.notEqual(result?.status, "succeeded");
    assert.notEqual(result?.status, "failed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("V2 lineage uses a stable epoch and explicit rebase preserves the previous immutable release", async () => {
  const root=mkdtempSync(join(tmpdir(),'rai-epoch-'));
  const store=await seedDatabase(join(root,'db.sqlite'));
  try {
    const record=store.database.prepare(`INSERT INTO health_records
      (id,type,source_name,source_category,unit,value_numeric,start_at,end_at,metadata_json,raw_attributes_json)
      VALUES (?,'HKQuantityTypeIdentifierHeartRate','Fixture Apple Watch','apple_watch','count/min',150,?,?,'{}','{}')`);
    for(let run=0;run<8;run++)for(let n=0;n<12;n++){
      const start=Date.parse(dateForRun(run))+n*150000;
      record.run(`r-${run}-${n}`,new Date(start).toISOString(),new Date(start+150000).toISOString());
    }
    const service=new RaiApplicationService(store),at=dateForRun(9);
    const execute=(modelConfig?:import('@rai/scoring').RaiModelConfig)=>{
      service.enqueueFullRecompute({evaluatedAt:at,timezoneIdentifier:'UTC',...(modelConfig?{modelConfig}:{})});
      const job=service.runNextJob();assert.equal(job?.status,'succeeded',JSON.stringify(job));return job!.modelRunId!;
    };
    const first=execute();
    const lineage=(id:string)=>JSON.parse(String(store.database.prepare('SELECT lineage_json AS json FROM model_v2_runs WHERE model_run_id=?').get(id)?.json));
    const initial=lineage(first);assert.equal(typeof initial.baselineEpochId,'string');assert.equal(typeof initial.calibrationCohortHash,'string');
    const firstSnapshot=store.database.prepare("SELECT payload_json AS json FROM model_domain_snapshots WHERE model_run_id=? AND domain='fitness'").get(first)?.json;
    const second=execute();assert.equal(lineage(second).baselineEpochId,initial.baselineEpochId);
    const {defaultRaiModelConfig}=await import('@rai/scoring');
    const third=execute({...defaultRaiModelConfig,baselineReferenceStartAt:dateForRun(1)});
    assert.notEqual(lineage(third).baselineEpochId,initial.baselineEpochId);
    const release=store.database.prepare('SELECT evaluation_json AS json,status FROM model_release_bundles WHERE model_run_id=?').get(third)!;
    assert.equal(release.status,'passed');assert.equal(JSON.parse(String(release.json)).rebase.referenceStartAt,dateForRun(1));
    assert.equal(store.database.prepare("SELECT payload_json AS json FROM model_domain_snapshots WHERE model_run_id=? AND domain='fitness'").get(first)?.json,firstSnapshot);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
