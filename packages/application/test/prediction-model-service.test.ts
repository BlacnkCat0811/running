import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PredictionModelTrainingResult, RaceDistance } from "@rai/contracts";
import { RaiDatabase } from "@rai/health-export-parser";

import {
  MAXIMUM_PREDICTION_TRAINING_ATTEMPTS,
  PredictionModelActivationCompatibilityError,
  PredictionModelService,
  PredictionTrainingInProgressError,
  PredictionTrainingInputError,
  PredictionTrainingPreconditionError
} from "../src/prediction-model-service.js";
import { raceResidualFeatureSchemaHash } from "../src/prediction-training-data.js";
import { verifyAcceptedOnnxArtifact } from "../src/prediction-training-runner.js";

const asOf = "2026-07-11T00:00:00.000Z";

async function seedLabeledOutcomes(path: string, count: number): Promise<RaiDatabase> {
  const store = await RaiDatabase.open(path);
  const insertSession = store.database.prepare(`
    INSERT INTO training_sessions (
      id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
      canonical_workout_id, status
    ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, ?, NULL, 'active')
  `);
  const insertOverride = store.database.prepare(`
    INSERT INTO workout_overrides (
      id, training_session_id, revision, session_type, performance_protocol,
      condition_tags_json
    ) VALUES (?, ?, 1, 'race', ?, '[]')
  `);
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

function successfulResult(): PredictionModelTrainingResult {
  const byDistance = Object.fromEntries(
    (["five_k", "ten_k", "half_marathon"] as RaceDistance[])
      .map((distance) => [distance, distanceMetrics(5)])
  ) as PredictionModelTrainingResult["metrics"]["byDistance"];
  return {
    featureSchemaHash: raceResidualFeatureSchemaHash(),
    trainingDataHash: "b".repeat(64),
    labelCount: 51,
    labelCountByDistance: { five_k: 17, ten_k: 17, half_marathon: 17 },
    holdoutPredictionCount: 15,
    metrics: {
      baselineMaeSeconds: 100,
      modelMaeSeconds: 90,
      maeImprovement: 0.1,
      intervalCoverageChange: 0,
      regressesAnyDistanceByMoreThan5Percent: false,
      onnxMaximumAbsoluteError: 1e-8,
      byDistance
    },
    supportedDistances: ["five_k", "ten_k", "half_marathon"],
    artifactPath: "var/model-artifacts/prediction/model.onnx",
    artifactSha256: "c".repeat(64)
  };
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

test("passes offline gates and atomically activates a completed CatBoost run", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    assert.equal(service.get(runId)?.status, "queued");
    assert.equal(service.claimNext()?.id, runId);
    assert.equal(service.get(runId)?.status, "running");

    const completed = service.completeAndActivate(runId, successfulResult());
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
    const service = new PredictionModelService(store);
    const acceptedId = service.enqueue({ asOf });
    service.claimNext();
    service.completeAndActivate(acceptedId, successfulResult());

    const rejectedId = service.enqueue({ asOf });
    service.claimNext();
    const rejectedResult = successfulResult();
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
      reasons: ["mae_improvement_below_3_percent"]
    });
    assert.equal(service.get(acceptedId)?.active, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires Node ONNX verification for runner-accepted artifacts", async () => {
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

test("rejects a result built for a different feature schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-schema-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    const runId = service.enqueue({ asOf });
    service.claimNext();
    const result = successfulResult();
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
    const service = new PredictionModelService(store);
    const historicalId = service.enqueue({ asOf });
    service.claimNext();
    service.completeAndActivate(historicalId, successfulResult());
    const historical = service.get(historicalId)!;

    const currentId = service.enqueue({ asOf });
    service.claimNext();
    service.completeAndActivate(currentId, successfulResult());

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

test("requires a strict timezone-qualified ISO timestamp", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prediction-model-"));
  const store = await seedLabeledOutcomes(join(root, "rai.sqlite"), 51);
  try {
    const service = new PredictionModelService(store);
    assert.throws(
      () => service.preflight("July 11, 2026"),
      (error: unknown) => error instanceof PredictionTrainingInputError
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
      successfulResult(),
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
