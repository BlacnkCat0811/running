import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { healthTypes, workoutTypes } from "@rai/contracts";
import { canonicalizeRunningWorkouts, parseAppleHealthXml } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

const appleDate = (day: number, time: string): string =>
  `2026-01-${String(day).padStart(2, "0")} ${time}:00 +0800`;

test("imports a small Health fixture and replays features, CA/TA, and daily snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-import-replay-"));
  const xmlPath = join(root, "export.xml");
  const databasePath = join(root, "rai.sqlite");
  const days = [1, 4, 7, 10, 13, 16, 19];
  const workouts = days.map((day, index) => `
  <Workout workoutActivityType="${workoutTypes.running}" duration="30" durationUnit="min" sourceName="Fixture Apple Watch" sourceVersion="1" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" device="Watch">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <WorkoutStatistics type="${healthTypes.distanceWalkingRunning}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" sum="${(5 + index * 0.08).toFixed(2)}" unit="km"/>
    <WorkoutStatistics type="${healthTypes.heartRate}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" average="${145 + index}" minimum="120" maximum="172" unit="count/min"/>
  </Workout>`).join("");
  // Dense HR records so R3-16 stats-only path is not used (series eligibility).
  const heartRecords = days.flatMap((day, index) =>
    Array.from({ length: 15 }, (_, sample) => {
      const minute = String(sample * 2).padStart(2, "0");
      const endMinute = String(sample * 2 + 1).padStart(2, "0");
      return `
  <Record type="${healthTypes.heartRate}" sourceName="Fixture Apple Watch" sourceVersion="1" unit="count/min" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, `08:${minute}`)}" endDate="${appleDate(day, `08:${endMinute}`)}" value="${140 + index + (sample % 3)}"/>`;
    })
  ).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
  <ExportDate value="${appleDate(25, "12:00")}"/>
  <Me biologicalSex="HKBiologicalSexMale"/>${workouts}${heartRecords}
</HealthData>`;
  writeFileSync(xmlPath, xml, "utf8");

  const store = await RaiDatabase.open(databasePath);
  try {
    const imported = await parseAppleHealthXml(xmlPath, store, { fileSize: Buffer.byteLength(xml) });
    assert.equal(imported.workoutCount, days.length);
    const canonical = canonicalizeRunningWorkouts(store.database);
    assert.equal(canonical.groupCount, days.length);
    assert.equal(canonical.trainingSessionCount, days.length);

    const service = new RaiApplicationService(store);
    const jobId = service.enqueueFullRecompute({
      evaluatedAt: "2026-01-25T04:00:00.000Z",
      timezoneIdentifier: "Asia/Shanghai"
    });
    const completed = service.runNextJob();
    assert.equal(completed?.id, jobId);
    assert.equal(completed?.status, "succeeded");

    const counts = store.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM training_sessions) AS sessions,
        (SELECT COUNT(*) FROM workout_features) AS features,
        (SELECT COUNT(*) FROM ability_assessments) AS assessments,
        (SELECT COUNT(*) FROM ability_assessments WHERE current_ability IS NOT NULL) AS scored,
        (SELECT COUNT(*) FROM daily_ability_snapshots) AS snapshots,
        (SELECT COUNT(*) FROM model_runs WHERE status = 'succeeded') AS successfulModels,
        (SELECT COUNT(*) FROM active_model_run) AS activeModels
    `).get() as unknown as Record<string, number>;
    assert.deepEqual({ ...counts }, {
      sessions: 7,
      features: 7,
      assessments: 7,
      scored: 1,
      snapshots: 25,
      successfulModels: 1,
      activeModels: 1
    });

    const scored = store.database.prepare(`
      SELECT current_ability AS currentAbility,
             true_ability_before AS trueAbilityBefore,
             true_ability_after AS trueAbilityAfter,
             cardio_score AS cardioScore,
             effective_weights_json AS effectiveWeightsJson
      FROM ability_assessments
      WHERE current_ability IS NOT NULL
    `).get() as unknown as {
      currentAbility: number;
      trueAbilityBefore: number;
      trueAbilityAfter: number;
      cardioScore: number;
      effectiveWeightsJson: string;
    };
    assert.ok(Number.isFinite(scored.currentAbility));
    assert.ok(Number.isFinite(scored.trueAbilityBefore));
    assert.ok(Number.isFinite(scored.trueAbilityAfter));
    assert.ok(Number.isFinite(scored.cardioScore));
    assert.equal(Object.hasOwn(JSON.parse(scored.effectiveWeightsJson), "cardio"), false);

    store.setManifest("dataset_version", "dataset_incremental_fixture");
    store.flush();
    const incrementalJobId = service.enqueueIncrementalRecompute({
      mode: "partial",
      dirtySessionIds: [],
      dirtyFromAt: "2026-01-16T00:00:00.000Z",
      reasons: ["workout_or_route_change"]
    }, {
      evaluatedAt: "2026-01-25T04:00:00.000Z",
      timezoneIdentifier: "Asia/Shanghai"
    });
    assert.ok(incrementalJobId);
    assert.equal(service.runNextJob()?.status, "succeeded");
    const incremental = store.database.prepare(`
      SELECT parent_feature_run_id AS parentId, reused_feature_count AS reused,
             recomputed_feature_count AS recomputed
      FROM feature_runs WHERE dataset_version = 'dataset_incremental_fixture'
    `).get() as unknown as { parentId: string | null; reused: number; recomputed: number };
    assert.ok(incremental.parentId);
    assert.equal(incremental.reused, 5);
    assert.equal(incremental.recomputed, 2);
    const activeCounts = store.database.prepare(`
      SELECT (SELECT COUNT(*) FROM active_ability_assessments) AS assessments,
             (SELECT COUNT(*) FROM active_daily_ability_snapshots) AS snapshots
    `).get() as unknown as { assessments: number; snapshots: number };
    assert.deepEqual({ ...activeCounts }, { assessments: 7, snapshots: 25 });

    store.setManifest("dataset_version", "dataset_checkpoint_fixture");
    store.flush();
    const checkpointJobId = service.enqueueIncrementalRecompute({
      mode: "partial",
      dirtySessionIds: [],
      dirtyFromAt: "2026-01-18T00:00:00.000Z",
      reasons: ["workout_or_route_change"]
    }, {
      evaluatedAt: "2026-01-25T04:00:00.000Z",
      timezoneIdentifier: "Asia/Shanghai",
      validationMode: "shadow"
    });
    assert.ok(checkpointJobId);
    assert.equal(service.runNextJob()?.status, "succeeded");
    const checkpointRun = store.database.prepare(`
      SELECT model.parent_model_run_id AS parentId,
             model.reused_assessment_count AS reusedAssessments,
             feature.reused_feature_count AS reusedFeatures
      FROM active_model_run active
      JOIN model_runs model ON model.id = active.model_run_id
      JOIN feature_runs feature ON feature.id = model.feature_run_id
    `).get() as unknown as { parentId: string | null; reusedAssessments: number; reusedFeatures: number };
    assert.ok(checkpointRun.parentId);
    assert.equal(checkpointRun.reusedAssessments, 6);
    assert.equal(checkpointRun.reusedFeatures, 6);
    const validation = store.database.prepare(`
      SELECT status, hashes_json AS hashesJson FROM recompute_validations WHERE job_id = ?
    `).get(checkpointJobId) as unknown as { status: string; hashesJson: string };
    assert.equal(validation.status, "matched");
    assert.deepEqual(Object.keys(JSON.parse(validation.hashesJson)).sort(), [
      "assessments", "dailyTrainingMetrics", "dailyZoneProfiles", "features", "snapshots",
      "workoutTrainingLoads", "workoutZoneSummaries"
    ]);

    const activeBeforeMismatch = store.database.prepare(
      "SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1"
    ).get() as unknown as { id: string };
    store.database.prepare(`
      UPDATE ability_assessments SET confidence = confidence + 0.01
      WHERE model_run_id = ? AND sequence_number = 0
    `).run(activeBeforeMismatch.id);
    store.setManifest("dataset_version", "dataset_shadow_mismatch_fixture");
    store.flush();
    const mismatchJobId = service.enqueueIncrementalRecompute({
      mode: "partial", dirtySessionIds: [], dirtyFromAt: "2026-01-18T00:00:00.000Z",
      reasons: ["workout_or_route_change"]
    }, {
      evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai",
      validationMode: "shadow"
    });
    assert.ok(mismatchJobId);
    const mismatchJob = service.runNextJob();
    assert.equal(mismatchJob?.status, "failed");
    assert.equal((store.database.prepare(
      "SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1"
    ).get() as unknown as { id: string }).id, activeBeforeMismatch.id);
    assert.equal((store.database.prepare(
      "SELECT status FROM recompute_validations WHERE job_id = ?"
    ).get(mismatchJobId) as unknown as { status: string }).status, "mismatched");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
