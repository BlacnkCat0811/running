import { currentAbilityBaselineHash, predictionLabelRevision } from "../src/prediction-ability-baseline.js";
import { fitEmpiricalIntervals, INTERVAL_RELEASE_POLICY, type EvaluationCase } from "@rai/model-eval";
import { PHYSIOLOGY_MODEL_VERSION } from "@rai/physiology";
import { SqliteCalibrationRepository, SqlitePerformanceEntryRepository } from "@rai/storage-sqlite";
import { catBoostCalibrationKey } from "../src/prediction-policy.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PredictionModelTrainingResult, RaceDistance } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";

import {
  MAXIMUM_PREDICTION_TRAINING_ATTEMPTS,
  PredictionAbilityBaselineUnavailableError,
  PredictionModelActivationCompatibilityError,
  PredictionModelService,
  PredictionTrainingInProgressError,
  PredictionTrainingInputError,
  PredictionTrainingPreconditionError
} from "../src/prediction-model-service.js";
import {
  raceResidualFeatureSchemaHash,
  type RaceResidualTrainingSample
} from "../src/prediction-training-data.js";
import {
  orderedSamples,
  temporalEventKey,
  trainingInstantMicros,
  verifyAcceptedOnnxArtifact,
  verifyOnnxGoldenVectors
} from "../src/prediction-training-runner.js";
import { buildPredictionReportAsync } from "../src/prediction-report.js";
import { RaiApplicationService } from "../src/service.js";
import { loadLabeledRaceOutcomes, loadManualPerformanceOutcomes, type LabeledRaceOutcome } from "../src/prediction-data.js";

const asOf = "2026-07-11T00:00:00.000Z";

test("normalizes equivalent timezone representations for artifact event identity", () => {
  assert.equal(
    temporalEventKey("2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z"),
    temporalEventKey("2026-01-01T08:00:00+08:00", "2026-01-01T08:30:00+08:00")
  );
  assert.throws(() => temporalEventKey("invalid", "2026-01-01T00:30:00Z"));
});

test("preserves microseconds in normalized training instants and event identity", () => {
  assert.equal(
    trainingInstantMicros("2026-01-01T00:00:00.000100Z"),
    trainingInstantMicros("2026-01-01T08:00:00.000100+08:00")
  );
  assert.notEqual(
    temporalEventKey("2026-01-01T00:00:00.000100Z", "2026-01-01T00:30:00Z"),
    temporalEventKey("2026-01-01T00:00:00.000900Z", "2026-01-01T00:30:00Z")
  );
});

test("orders training samples by absolute instant before sample id", () => {
  const sample = (sampleId: string, observedAt: string) =>
    ({ sampleId, observedAt }) as RaceResidualTrainingSample;
  const ordered = orderedSamples([
    sample("later", "2026-01-01T00:30:00Z"),
    sample("earlier-b", "2026-01-01T01:00:00+01:00"),
    sample("earlier-a", "2026-01-01T00:00:00Z")
  ]);
  assert.deepEqual(ordered.map((row) => row.sampleId), ["earlier-a", "earlier-b", "later"]);
  assert.throws(
    () => orderedSamples([sample("invalid", "not-an-instant")]),
    /timezone-qualified ISO 8601/
  );
});

async function seedLabeledOutcomes(path: string, count: number): Promise<RaiDatabase> {
  const store = await RaiDatabase.open(path);
  store.database.exec(`
    INSERT INTO feature_runs (
      id, dataset_version, canonical_contract_version, feature_schema_version,
      feature_config_json, feature_config_hash, status, created_at, completed_at
    ) VALUES (
      'prediction-feature-run', 'dataset-1', 'contract-1', 'features-1',
      '{}', 'feature-config-1', 'succeeded',
      '2023-12-01T00:00:00.000Z', '2023-12-01T00:00:01.000Z'
    );
    INSERT INTO model_runs (
      id, feature_run_id, dataset_version, model_version, model_config_json,
      model_config_hash, evaluated_at, status, created_at, completed_at
    ) VALUES (
      'prediction-ability-run', 'prediction-feature-run', 'dataset-1', 'ability-1',
      '{}', 'ability-config-1', '2023-12-01T00:00:00.000Z', 'succeeded',
      '2023-12-01T00:00:00.000Z', '2023-12-01T00:00:01.000Z'
    );
    INSERT INTO active_model_run (singleton, model_run_id, activated_at)
    VALUES (1, 'prediction-ability-run', '2023-12-01T00:00:02.000Z');
  `);
  const insertSession = store.database.prepare(`
    INSERT INTO training_sessions (
      id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
      canonical_workout_id, status
    ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, ?, NULL, 'active')
  `);
  const insertOverride = store.database.prepare(`
    INSERT INTO workout_overrides (
      id, training_session_id, revision, session_type, performance_protocol,
      condition_tags_json, created_at
    ) VALUES (?, ?, 1, 'race', ?, '[]', '2023-12-31T00:00:00.000Z')
  `);
  store.database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric,
      start_at, end_at, metadata_json, raw_attributes_json
    ) VALUES (
      'prediction-vo2', 'HKQuantityTypeIdentifierVO2Max', 'Watch', 'apple_watch',
      'mL/min*kg', 50, '2023-12-01T00:00:00.000Z', '2023-12-01T00:00:01.000Z', '{}', '{}'
    )
  `).run();
  const fixtures: Array<{ distance: number; protocol: string; seconds: number }> = [
    { distance: 5, protocol: "five_k_time_trial", seconds: 1_500 },
    { distance: 10, protocol: "ten_k_time_trial", seconds: 3_100 },
    { distance: 21.0975, protocol: "half_marathon_race", seconds: 7_200 }
  ];
  for (let index = 0; index < count; index += 1) {
    const fixture = fixtures[index % fixtures.length]!;
    const start = new Date(Date.UTC(2024, 0, 1 + index * 7)).toISOString();
    const end = new Date(Date.parse(start) + fixture.seconds * 1_000).toISOString();
    const sessionId = `prediction_session_${index}`;
    insertSession.run(sessionId, start, end, fixture.distance);
    insertOverride.run(
      `prediction_override_${index}`,
      sessionId,
      fixture.protocol
    );
  }
  return store;
}

function distanceMetrics(sampleCount: number) {
  return {
    sampleCount,
    baselineMaeSeconds: 100,
    modelMaeSeconds: 90,
    maeImprovement: 0.1
  };
}

function writeArtifact(root: string, label = "test-run"): {
  artifactPath: string;
  artifactSha256: string;
} {
  const artifactPath = join(
    root,
    "var",
    "model-artifacts",
    "prediction",
    label,
    "attempt-1"
  );
  mkdirSync(artifactPath, { recursive: true });
  const bytes = Buffer.from(`onnx-fixture:${label}`);
  writeFileSync(join(artifactPath, "model.onnx"), bytes);
  writeFileSync(join(artifactPath, "manifest.json"), JSON.stringify({ scope: "population" }));
  return {
    artifactPath,
    artifactSha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function successfulResult(root: string, label = "test-run"): PredictionModelTrainingResult {
  const artifact = writeArtifact(root, label);
  const byDistance = Object.fromEntries(
    (["five_k", "ten_k", "half_marathon"] as RaceDistance[])
      .map((distance) => [distance, distanceMetrics(8)])
  ) as PredictionModelTrainingResult["metrics"]["byDistance"];
  return {
    featureSchemaHash: raceResidualFeatureSchemaHash(),
    trainingDataHash: "b".repeat(64),
    labelCount: 51,
    labelCountByDistance: { five_k: 17, ten_k: 17, half_marathon: 17 },
    holdoutPredictionCount: 24,
    metrics: {
      baselineMaeSeconds: 100,
      modelMaeSeconds: 90,
      maeImprovement: 0.1,
      intervalCoverageChange: 0,
      regressesAnyDistanceByMoreThan5Percent: false,
      onnxMaximumAbsoluteError: 1e-8,
      maeImprovementBootstrap95Lower: 0.02,
      byDistance
    },
    supportedDistances: ["five_k", "ten_k", "half_marathon"],
    artifactPath: artifact.artifactPath,
    artifactSha256: artifact.artifactSha256,
    evaluationStatus: "accepted",
    ridgeComparison:{status:"passed",walkForwardImprovement:0.1,releaseImprovement:0.1,bootstrapLower:0.02},
    rejectionReasons: []
  };
}

const activationClock=()=>"2026-09-29T00:00:00.000Z";
function approveIntervals(store:RaiDatabase,result:PredictionModelTrainingResult, dependency?: LabeledRaceOutcome, baselineHash?: string):void {
  const baseline=baselineHash ?? currentAbilityBaselineHash(store.database)!;
  for(const distance of ["five_k","ten_k","half_marathon"] as const){
    const rows=(prefix:string,month:string):EvaluationCase[]=>Array.from({length:24},(_,i)=>
      dependency && dependency.distance === distance && prefix === "cal" && i === 0 ? {
        eventId: dependency.id, distance, predictedAt: dependency.observedAt, outcomeAt: dependency.completedAt,
        availableAt: dependency.labelAvailableAt, actualSeconds: dependency.actualSeconds, predictedSeconds: 1000
      } : ({
      eventId:`${prefix}-${distance}-${i}`,distance,predictedAt:`2026-${month}-${String(i+1).padStart(2,"0")}T00:00:00Z`,
      outcomeAt:`2026-${month}-${String(i+1).padStart(2,"0")}T01:00:00Z`,availableAt:`2026-${month}-${String(i+1).padStart(2,"0")}T02:00:00Z`,
      actualSeconds:prefix==="cal"?1000*Math.exp(-0.1+i*0.2/23):1000,predictedSeconds:1000
    }));
    const artifact=fitEmpiricalIntervals({predictorVersion:catBoostCalibrationKey(result.artifactSha256),distance,
      calibration:rows("cal","08"),asOf:"2026-09-25T00:00:00Z",policy:INTERVAL_RELEASE_POLICY})!;
    new SqliteCalibrationRepository(store.database).save(artifact,baseline,rows("test","09"),"2026-09-25T00:00:00Z");
  }
}

test("rejects CatBoost training before enough real labeled outcomes exist", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 12);
  try {
    const service = new PredictionModelService(store);
    const preflight = service.preflight(asOf);
    assert.equal(preflight.available, 12);
    assert.equal(preflight.eligible, false);
    assert.throws(
      () => service.enqueue({ asOf }),
      (error: unknown) => error instanceof PredictionTrainingPreconditionError &&
        error.code === "insufficient_labeled_outcomes"
    );
    assert.equal(service.list().length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight counts only labels that can produce historical formula features", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-preflight-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 50);
  try {
    store.database.prepare("DELETE FROM health_records WHERE id = 'prediction-vo2'").run();
    const preflight = new PredictionModelService(store).preflight(asOf);
    assert.equal(preflight.available, 49);
    assert.equal(preflight.eligible, false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires an active ability baseline before enqueueing training", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-baseline-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    store.database.prepare("DELETE FROM active_model_run").run();
    assert.throws(
      () => new PredictionModelService(store).enqueue({ asOf }),
      PredictionAbilityBaselineUnavailableError
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("builds the full prediction preflight outside the write transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-lock-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const originalPreflight = service.preflight.bind(service);
    service.preflight = (cutoff: string) => {
      assert.equal(store.database.isTransaction, false);
      return originalPreflight(cutoff);
    };
    assert.ok(service.enqueue({ asOf }));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not serve an active residual model before its training cutoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-cutoff-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    store.database.prepare(`
      UPDATE prediction_model_runs
      SET status = 'succeeded', feature_schema_hash = ?, metrics_json = '{}',
          supported_distances_json = '["five_k","ten_k","half_marathon"]',
          artifact_path = 'unused', artifact_sha256 = ?, completed_at = ?
      WHERE id = ?
    `).run(raceResidualFeatureSchemaHash(), "a".repeat(64), asOf, runId);
    store.database.prepare(`
      INSERT INTO active_prediction_model (singleton, prediction_model_run_id, activated_at)
      VALUES (1, ?, ?)
    `).run(runId, asOf);

    const historicalAsOf = "2025-01-01T00:00:00.000Z";
    const report = await buildPredictionReportAsync(store.database, { asOf: historicalAsOf });
    assert.equal(report.modelSelection.machineLearning.status, "inference_unavailable");
    assert.equal(
      report.snapshot.races.some((race) => race.method === "catboost_residual_v6"),
      false
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not serve an active residual model for a different formula baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-serving-baseline-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    store.database.prepare(`
      UPDATE prediction_model_runs
      SET status = 'succeeded', feature_schema_hash = ?, ability_baseline_hash = ?,
          metrics_json = '{}',
          supported_distances_json = '["five_k","ten_k","half_marathon"]',
          artifact_path = 'unused', artifact_sha256 = ?, completed_at = ?
      WHERE id = ?
    `).run(raceResidualFeatureSchemaHash(), "0".repeat(64), "a".repeat(64), asOf, runId);
    store.database.prepare(`
      INSERT INTO active_prediction_model (singleton, prediction_model_run_id, activated_at)
      VALUES (1, ?, ?)
    `).run(runId, asOf);

    const report = await buildPredictionReportAsync(store.database, { asOf });
    assert.equal(report.modelSelection.machineLearning.status, "inference_unavailable");
    assert.equal(
      report.snapshot.races.some((race) => race.method === "catboost_residual_v6"),
      false
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const version of ["v4", "v5"]) test(`the temporal exclusion fix rejects formula-${version} models and intervals without erasing their audit rows`, async () => {
  const root = mkdtempSync(join(tmpdir(), `rai-formula-${version}-retirement-`));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const legacyBaseline = createHash("sha256").update(JSON.stringify({
      modelRunId: "prediction-ability-run",
      featureRunId: "prediction-feature-run",
      datasetVersion: "dataset-1",
      modelVersion: "ability-1",
      modelConfigHash: "ability-config-1",
      featureSchemaVersion: "features-1",
      featureConfigHash: "feature-config-1",
      canonicalContractVersion: "contract-1",
      physiologyModelVersion: PHYSIOLOGY_MODEL_VERSION,
      formulaPredictionBaseVersion: `rai-formula-prediction-base-${version}`,
      labelRevision: predictionLabelRevision(store.database)
    })).digest("hex");
    const currentBaseline = currentAbilityBaselineHash(store.database)!;
    assert.notEqual(currentBaseline, legacyBaseline);
    const service = new PredictionModelService(store, undefined, "owned", activationClock);
    const runId = service.enqueue({ asOf });
    service.claimNext();
    const result = successfulResult(root, `formula-${version}`);
    service.completeAndActivate(runId, result);
    approveIntervals(store, result, undefined, legacyBaseline);
    store.database.prepare("UPDATE prediction_model_runs SET ability_baseline_hash = ? WHERE id = ?")
      .run(legacyBaseline, runId);
    const intervals = new SqliteCalibrationRepository(store.database);
    const key = catBoostCalibrationKey(result.artifactSha256);
    assert.ok(intervals.select(key, legacyBaseline, "five_k", activationClock(), 1000));
    assert.equal(intervals.select(key, currentBaseline, "five_k", activationClock(), 1000), null);
    assert.throws(() => service.activate(runId), error => error instanceof PredictionModelActivationCompatibilityError &&
      error.reasons.includes("ability_baseline_mismatch"));
    store.database.prepare("INSERT INTO active_prediction_model (singleton, prediction_model_run_id) VALUES (1, ?)")
      .run(runId);
    const report = await buildPredictionReportAsync(store.database, { asOf: activationClock() });
    assert.equal(report.modelSelection.machineLearning.status, "inference_unavailable");
    assert.ok(report.snapshot.races.every(race => race.method !== "catboost_residual_v6"));
    assert.equal(service.get(runId)?.status, "succeeded");
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM prediction_calibration_artifacts").get()?.count, 3);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("point validation waits for independent intervals before atomic CatBoost activation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store,undefined,"owned",activationClock);
    const runId = service.enqueue({ asOf });
    assert.equal(service.get(runId)?.status, "queued");
    assert.equal(service.claimNext()?.id, runId);
    assert.equal(service.get(runId)?.status, "running");

    const result=successfulResult(root);
    const staged=service.completeAndActivate(runId,result);
    assert.equal(staged.status,"succeeded");assert.equal(staged.active,false);
    assert.equal(service.events(runId).at(-1)?.phase,"awaiting_calibration");
    assert.throws(()=>service.activate(runId),/independent_interval_not_validated/);
    approveIntervals(store,result);
    const completed=service.activate(runId);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.active, true);
    assert.equal(completed.metrics?.maeImprovement, 0.1);
    assert.equal(service.events(runId).at(-1)?.phase, "activated");
    const active = store.database.prepare(`
      SELECT prediction_model_run_id AS id FROM active_prediction_model WHERE singleton = 1
    `).get() as unknown as { id: string };
    assert.equal(active.id, runId);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mutation of ["manual_revocation", "workout_exclusion", "unlinked_manual_replacement"] as const) {
  test(`${mutation} retires active models and intervals and blocks historical reactivation`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-label-invalidation-"));
    const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
    try {
      const entries = new SqlitePerformanceEntryRepository(store.database);
      const entry = entries.insert({ localDate: "2026-08-01", distance: "five_k", durationSeconds: 1000,
        note: null, recordedAt: "2026-08-02T00:00:00Z" });
      const dependency = loadManualPerformanceOutcomes(store.database, activationClock())[0]!;
      const service = new PredictionModelService(store, undefined, "owned", activationClock);
      const id = service.enqueue({ asOf });
      service.claimNext();
      const result = successfulResult(root, mutation);
      service.completeAndActivate(id, result);
      approveIntervals(store, result, dependency);
      service.activate(id);
      const baseline = currentAbilityBaselineHash(store.database)!;
      const intervals = new SqliteCalibrationRepository(store.database);
      const key = catBoostCalibrationKey(result.artifactSha256);
      assert.ok(intervals.select(key, baseline, "five_k", activationClock(), 1000));
      if (mutation === "manual_revocation") {
        assert.equal(new RaiApplicationService(store).revokePerformanceEntry(entry.id), true);
      } else if (mutation === "workout_exclusion") {
        store.database.exec(`INSERT INTO workout_overrides
          (id, training_session_id, revision, session_type, performance_protocol, eligibility_override, condition_tags_json, created_at)
          VALUES ('withdrawn-label', 'prediction_session_0', 2, 'race', 'five_k_time_trial', 'exclude', '[]', '2026-09-30T00:00:00Z')`);
      } else {
        const original = loadLabeledRaceOutcomes(store.database, asOf).find(outcome => outcome.id === "prediction_session_0");
        assert.equal(Math.round(original!.actualSeconds), 1500);
        const replacement = new RaiApplicationService(store).appendPerformanceEntry({
          localDate: "2024-01-01", distance: "five_k", durationSeconds: 1000, note: null
        });
        assert.equal(replacement.trainingSessionId, null);
        const outcomes = loadLabeledRaceOutcomes(store.database, replacement.recordedAt);
        assert.equal(outcomes.find(outcome => outcome.id === replacement.id)?.actualSeconds, 1000);
        assert.ok(!outcomes.some(outcome => outcome.id === original!.id));
      }
      const current = currentAbilityBaselineHash(store.database)!;
      assert.notEqual(current, baseline);
      assert.equal(service.get(id)?.active, false);
      assert.equal(intervals.select(key, current, "five_k", "2026-10-03T00:00:00Z", 1000), null);
      assert.throws(() => service.activate(id), error => error instanceof PredictionModelActivationCompatibilityError &&
        error.reasons.includes("ability_baseline_mismatch"));
      assert.equal(service.get(id)?.status, "succeeded", "historical audit rows are retained");
      assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM prediction_calibration_artifacts").get()?.count, 3);
      // Even a restored or externally inserted stale pointer must fail closed at serve time.
      store.database.prepare("INSERT INTO active_prediction_model (singleton, prediction_model_run_id) VALUES (1, ?)").run(id);
      const report = await buildPredictionReportAsync(store.database, { asOf: "2026-10-03T00:00:00Z" });
      assert.equal(report.modelSelection.machineLearning.status, "inference_unavailable");
      assert.ok(report.snapshot.races.every(race => race.method !== "catboost_residual_v6"));
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("label invalidation rolls back with the mutation and pending training rejects a withdrawn baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-label-inflight-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const entries = new SqlitePerformanceEntryRepository(store.database);
    const entry = entries.insert({ localDate: "2026-08-01", distance: "five_k", durationSeconds: 1000,
      note: null, recordedAt: "2026-08-02T00:00:00Z" });
    const service = new PredictionModelService(store);
    const id = service.enqueue({ asOf });
    service.claimNext();
    const before = currentAbilityBaselineHash(store.database);
    store.database.exec("BEGIN IMMEDIATE");
    new RaiApplicationService(store, "savepoint").revokePerformanceEntry(entry.id);
    assert.notEqual(currentAbilityBaselineHash(store.database), before);
    store.database.exec("ROLLBACK");
    assert.equal(currentAbilityBaselineHash(store.database), before);
    assert.equal(entries.list()[0]?.revokedAt, null);
    entries.revoke(entry.id);
    const completed = service.completeAndActivate(id, successfulResult(root, "withdrawn-inflight"));
    assert.equal(completed.status, "rejected");
    assert.ok((completed.failure as { reasons: string[] }).reasons.includes("ability_baseline_mismatch"));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("M12: completion rejects artifacts from a different or missing scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-artifact-scope-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    for (const scope of ["population", undefined, "unknown"] as const) {
      const id = service.enqueue({ asOf, scope: "personal" });
      service.claimNext();
      const result = successfulResult(root, `scope-${scope}`);
      writeFileSync(join(result.artifactPath, "manifest.json"), JSON.stringify({ scope }));
      const completed = service.completeAndActivate(id, result);
      assert.equal(completed.status, "rejected");
      assert.equal(completed.active, false);
      assert.ok((completed.failure as { reasons: string[] }).reasons.includes("artifact_scope_mismatch"));
    }
    const id = service.enqueue({ asOf, scope: "personal" });
    service.claimNext();
    const result = successfulResult(root, "personal");
    writeFileSync(join(result.artifactPath, "manifest.json"), JSON.stringify({ scope: "personal" }));
    assert.equal(service.completeAndActivate(id, result).status, "succeeded");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("M12: activation rechecks manifest scope before publishing the model", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-activation-scope-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store, undefined, "owned", activationClock);
    const id = service.enqueue({ asOf });
    service.claimNext();
    const result = successfulResult(root);
    assert.equal(service.completeAndActivate(id, result).status, "succeeded");
    approveIntervals(store, result);
    writeFileSync(join(result.artifactPath, "manifest.json"), JSON.stringify({ scope: "personal" }));
    assert.throws(() => service.activate(id), /artifact_scope_mismatch/);
    assert.equal(service.get(id)!.active, false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CatBoost run versions do not alter the ability baseline hash", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-version-hash-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const hash = currentAbilityBaselineHash(store.database);
    const id = new PredictionModelService(store).enqueue({ asOf });
    for (const version of ["race-residual-catboost-v4", "race-residual-catboost-v5"]) {
      store.database.prepare("UPDATE prediction_model_runs SET model_version = ? WHERE id = ?").run(version, id);
      assert.equal(currentAbilityBaselineHash(store.database), hash);
    }
    store.database.prepare("UPDATE model_runs SET model_version = 'ability-2'").run();
    assert.notEqual(currentAbilityBaselineHash(store.database), hash);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns a shutdown-interrupted training lease to the queue without consuming an attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-shutdown-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    assert.equal(service.claimNext("shutdown-worker")?.id, runId);
    const attemptCount = (): number => Number((store.database.prepare(
      "SELECT attempt_count AS attemptCount FROM prediction_model_runs WHERE id = ?"
    ).get(runId) as { attemptCount: number }).attemptCount);
    assert.equal(attemptCount(), 1);
    service.releaseLeaseForShutdown(runId, "shutdown-worker");
    assert.equal(service.get(runId)?.status, "queued");
    assert.equal(attemptCount(), 0);
    assert.equal(service.claimNext("replacement-worker")?.id, runId);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves a runner-rejected result without loading ONNX or replacing the active model", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store,undefined,"owned",activationClock);
    const acceptedId = service.enqueue({ asOf });
    service.claimNext();
    const acceptedResult=successfulResult(root,"accepted");
    service.completeAndActivate(acceptedId,acceptedResult);approveIntervals(store,acceptedResult);service.activate(acceptedId);

    const rejectedId = service.enqueue({ asOf });
    service.claimNext();
    const rejectedResult = successfulResult(root, "rejected-mae");
    rejectedResult.metrics.maeImprovement = 0.01;
    let onnxVerificationCalls = 0;
    await verifyAcceptedOnnxArtifact("rejected", async () => {
      onnxVerificationCalls += 1;
      throw new Error("rejected artifacts are not loadable by the production ONNX loader");
    });
    const rejected = service.completeAndActivate(rejectedId, rejectedResult);
    assert.equal(onnxVerificationCalls, 0);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.active, false);
    assert.deepEqual(rejected.failure, {
      code: "activation_gate_failed",
      reasons: ["mae_improvement_below_5_percent"]
    });
    assert.equal(service.get(acceptedId)?.active, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses activation when Python evaluationStatus is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-eval-status-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext();
    const result = successfulResult(root);
    result.evaluationStatus = "rejected";
    result.rejectionReasons = ["bootstrap_lower_not_positive"];
    const completed = service.completeAndActivate(runId, result);
    assert.equal(completed.status, "rejected");
    assert.equal(completed.active, false);
    assert.deepEqual(completed.failure, {
      code: "activation_gate_failed",
      reasons: [
        "evaluation_status_not_accepted",
        "python:bootstrap_lower_not_positive"
      ]
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses activation when artifact hash or root confinement fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-artifact-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext();
    const result = successfulResult(root);
    result.artifactSha256 = "d".repeat(64);
    const completed = service.completeAndActivate(runId, result);
    assert.equal(completed.status, "rejected");
    assert.ok(
      (completed.failure as { reasons: string[] }).reasons.includes("artifact_sha256_mismatch")
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an external artifact path that merely contains the expected directory names", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-artifact-boundary-"));
  const external = mkdtempSync(join(tmpdir(), "model-artifacts-prediction-external-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext();
    const result = successfulResult(root);
    const externalArtifact = writeArtifact(external, "model-artifacts/prediction/forged");
    result.artifactPath = externalArtifact.artifactPath;
    result.artifactSha256 = externalArtifact.artifactSha256;
    const completed = service.completeAndActivate(runId, result);
    assert.equal(completed.status, "rejected");
    assert.ok((completed.failure as { reasons: string[] }).reasons.includes("artifact_path_outside_root"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("rejects an artifact directory junction that resolves outside the configured root", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-artifact-link-"));
  const external = mkdtempSync(join(tmpdir(), "rai-prediction-artifact-target-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const result = successfulResult(root, "linked");
    const externalArtifact = writeArtifact(external, "outside");
    rmSync(result.artifactPath, { recursive: true, force: true });
    try {
      // "junction" is Windows-only. The POSIX equivalent is a directory
      // symlink, so the escape check is exercised on macOS and Linux too
      // instead of being skipped on every non-Windows runner.
      symlinkSync(
        externalArtifact.artifactPath,
        result.artifactPath,
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("junction creation is unavailable in this environment");
        return;
      }
      throw error;
    }
    result.artifactSha256 = externalArtifact.artifactSha256;
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext();
    const completed = service.completeAndActivate(runId, result);
    assert.equal(completed.status, "rejected");
    assert.ok((completed.failure as { reasons: string[] }).reasons.includes("artifact_path_outside_root"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("M02: requires Node ONNX verification for runner-accepted artifacts", async () => {
  let onnxVerificationCalls = 0;
  await verifyAcceptedOnnxArtifact("accepted", async () => {
    onnxVerificationCalls += 1;
  });
  assert.equal(onnxVerificationCalls, 1);
  await assert.rejects(
    verifyAcceptedOnnxArtifact("accepted", async () => {
      throw new Error("ONNX inference failed");
    }),
    /ONNX inference failed/
  );
});

test("M02: compares Node ONNX outputs with Python golden vectors", async () => {
  const vectors = [0, 1, 2].map((index) => ({
    sampleId: `sample-${index}`,
    distance: (["five_k", "ten_k", "half_marathon"] as const)[index]!,
    features: { value: index },
    targetLogResidual: index / 100,
    correctionFraction: index / 10,
    actualSeconds: 1000 + index * 100,
    baselinePredictedSeconds: 1000,
    baselineOptimisticSeconds: 900,
    baselinePessimisticSeconds: 1200
  }));
  await verifyOnnxGoldenVectors({
    predict: async (features) => ({
      targetLogResidual: Number(features.value) / 100,
      correctionFraction: Number(features.value) / 10
    })
  }, { toleranceExclusive: 1e-6, scope: "release_holdout", vectors });
  await assert.rejects(
    verifyOnnxGoldenVectors({
      predict: async () => ({ targetLogResidual: 1, correctionFraction: 0 })
    }, { toleranceExclusive: 1e-6, scope: "release_holdout", vectors }),
    /Node ONNX golden parity/
  );
});

test("rejects a result built for a different feature schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-schema-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext();
    const result = successfulResult(root);
    result.featureSchemaHash = "a".repeat(64);
    const completed = service.completeAndActivate(runId, result);
    assert.equal(completed.status, "rejected");
    assert.deepEqual(completed.failure, {
      code: "activation_gate_failed",
      reasons: ["feature_schema_hash_mismatch"]
    });
    assert.equal(completed.active, false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves stored model versions and refuses to activate incompatible history", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-activation-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store,undefined,"owned",activationClock);
    const historicalId = service.enqueue({ asOf });
    service.claimNext();
    service.completeAndActivate(historicalId, successfulResult(root, "historical"));
    const historical = service.get(historicalId)!;

    const currentId = service.enqueue({ asOf });
    service.claimNext();
    const currentResult=successfulResult(root,"current");
    service.completeAndActivate(currentId,currentResult);approveIntervals(store,currentResult);service.activate(currentId);

    const assertActivationRejected = (
      column: "model_version" | "feature_schema_version" | "feature_schema_hash",
      value: string,
      reason: PredictionModelActivationCompatibilityError["reasons"][number]
    ): void => {
      store.database.prepare(`
        UPDATE prediction_model_runs SET ${column} = ? WHERE id = ?
      `).run(value, historicalId);
      assert.throws(
        () => service.activate(historicalId),
        (error: unknown) =>
          error instanceof PredictionModelActivationCompatibilityError &&
          error.code === "prediction_model_incompatible" &&
          error.reasons.includes(reason)
      );
      assert.equal(service.get(currentId)?.active, true);
      assert.equal(service.get(historicalId)?.active, false);
    };

    assertActivationRejected("model_version", "race-residual-catboost-v0", "model_version_mismatch");
    assert.equal(service.get(historicalId)?.modelVersion, "race-residual-catboost-v0");
    assertActivationRejected("model_version", "race-residual-catboost-v4", "model_version_mismatch");
    store.database.prepare(`
      UPDATE prediction_model_runs SET model_version = ? WHERE id = ?
    `).run(historical.modelVersion, historicalId);

    assertActivationRejected(
      "feature_schema_version",
      "race-residual-features-v0",
      "feature_schema_version_mismatch"
    );
    assert.equal(service.get(historicalId)?.featureSchemaVersion, "race-residual-features-v0");
    store.database.prepare(`
      UPDATE prediction_model_runs SET feature_schema_version = ? WHERE id = ?
    `).run(historical.featureSchemaVersion, historicalId);

    assertActivationRejected("feature_schema_hash", "a".repeat(64), "feature_schema_hash_mismatch");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to reactivate a residual after the ability baseline changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-baseline-drift-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext();
    service.completeAndActivate(runId, successfulResult(root, "baseline-drift"));
    assert.match(service.get(runId)?.abilityBaselineHash ?? "", /^[a-f0-9]{64}$/);

    store.database.exec(`
      DELETE FROM active_prediction_model;
      UPDATE model_runs SET model_config_hash = 'ability-config-2'
      WHERE id = 'prediction-ability-run';
    `);
    assert.throws(
      () => service.activate(runId),
      (error: unknown) =>
        error instanceof PredictionModelActivationCompatibilityError &&
        error.reasons.includes("ability_baseline_mismatch")
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("treats a legacy NULL baseline and a missing active baseline as incompatible", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-null-baseline-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext();
    service.completeAndActivate(runId, successfulResult(root, "null-baseline"));
    store.database.prepare(`
      UPDATE prediction_model_runs SET ability_baseline_hash = NULL WHERE id = ?
    `).run(runId);
    store.database.exec("DELETE FROM active_prediction_model; DELETE FROM active_model_run;");

    assert.throws(
      () => service.activate(runId),
      (error: unknown) =>
        error instanceof PredictionModelActivationCompatibilityError &&
        error.reasons.includes("ability_baseline_mismatch")
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a completed training result if its ability baseline changed in flight", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-inflight-baseline-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext();
    store.database.prepare(`
      UPDATE model_runs SET model_config_hash = 'ability-config-2'
      WHERE id = 'prediction-ability-run'
    `).run();

    const completed = service.completeAndActivate(runId, successfulResult(root, "inflight-baseline"));
    assert.equal(completed.status, "rejected");
    assert.ok(
      (completed.failure as { reasons: string[] }).reasons.includes("ability_baseline_mismatch")
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancels a queued model without invoking a trainer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.requestCancellation(runId);
    assert.equal(service.get(runId)?.status, "cancelled");
    assert.equal(service.claimNext(), null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("enqueues idempotently and rejects a conflicting concurrent training request", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    assert.equal(service.enqueue({ asOf }), runId);
    assert.equal(service.list().length, 1);
    assert.equal(service.claimNext("worker_token_idempotent")?.id, runId);
    assert.equal(service.enqueue({ asOf }), runId);
    assert.equal(service.get(runId)?.status, "running");
    assert.throws(
      () => service.enqueue({ asOf: "2026-07-10T00:00:00.000Z" }),
      (error: unknown) => error instanceof PredictionTrainingInProgressError &&
        error.existingRunId === runId
    );
    assert.equal(service.list().length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retries an implicit-asOf enqueue by returning any active training run", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    assert.equal(service.enqueue({}), runId);
    assert.equal(service.claimNext("worker_token_implicit_retry")?.id, runId);
    assert.equal(service.enqueue({}), runId);
    store.database.prepare(
      "UPDATE prediction_model_runs SET status = 'validating' WHERE id = ?"
    ).run(runId);
    assert.equal(service.enqueue({}), runId);
    assert.equal(service.list().length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires a strict timezone-qualified ISO timestamp", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    assert.throws(
      () => service.preflight("July 11, 2026"),
      (error: unknown) => error instanceof PredictionTrainingInputError
    );
    assert.throws(
      () => service.enqueue({ asOf: "2999-01-01T00:00:00.000Z" }),
      (error: unknown) => error instanceof PredictionTrainingInputError &&
        /future/.test(error.message)
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers an abandoned leased run and fences the previous worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext("worker_token_original");
    store.database.prepare(`
      UPDATE prediction_model_runs SET heartbeat_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(runId);
    assert.equal(service.recoverAbandoned(30_000, new Date(asOf)), 1);
    assert.equal(service.get(runId)?.status, "queued");
    service.claimNext("worker_token_replacement");
    assert.equal(service.heartbeat(runId, "worker_token_original"), false);
    assert.equal(service.heartbeat(runId, "worker_token_replacement"), true);
    const attempts = store.database.prepare(`
      SELECT attempt_count AS attemptCount FROM prediction_model_runs WHERE id = ?
    `).get(runId) as unknown as { attemptCount: number };
    assert.equal(attempts.attemptCount, 2);
    assert.ok(service.events(runId).some((event) => event.phase === "recovered"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("force-recovers every restored lease even when its heartbeat is in the future", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext("worker_token_future");
    store.database.prepare(`
      UPDATE prediction_model_runs SET heartbeat_at = '2099-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(runId);

    assert.equal(service.recoverAbandoned(0, new Date(asOf)), 0);
    assert.equal(service.get(runId)?.status, "running");
    assert.equal(service.recoverAllLeases(new Date(asOf)), 1);
    assert.equal(service.get(runId)?.status, "queued");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("honors cancellation before activation and keeps terminal operations idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext("worker_token_cancel");
    assert.equal(service.requestCancellation(runId), "requested");
    const completed = service.completeAndActivate(
      runId,
      successfulResult(root),
      "worker_token_cancel"
    );
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.active, false);
    assert.equal(service.requestCancellation(runId), "cancelled");
    service.markCancelled(runId, "worker_token_cancel");
    assert.equal(
      service.events(runId).filter((event) => event.phase === "cancelled").length,
      1
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails an abandoned run after the bounded retry budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext("worker_token_attempts");
    store.database.prepare(`
      UPDATE prediction_model_runs
      SET heartbeat_at = '2020-01-01T00:00:00.000Z', attempt_count = ?
      WHERE id = ?
    `).run(MAXIMUM_PREDICTION_TRAINING_ATTEMPTS, runId);
    assert.equal(service.recoverAbandoned(30_000, new Date(asOf)), 1);
    assert.equal(service.get(runId)?.status, "failed");
    assert.deepEqual(service.get(runId)?.failure, {
      code: "worker_lease_exhausted",
      attempts: MAXIMUM_PREDICTION_TRAINING_ATTEMPTS
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
