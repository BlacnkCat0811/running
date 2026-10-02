import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MINIMUM_LABELS_PER_DISTANCE,
  MINIMUM_PREDICTION_LABELS,
  PERSONAL_MINIMUM_LABELS,
  PERSONAL_MINIMUM_LABELS_PER_DISTANCE,
  PredictionModelService,
  PredictionTrainingPreconditionError,
  predictionScopeFloors
} from "@rai/application";
import { RaiDatabase, SqlitePerformanceEntryRepository } from "@rai/storage-sqlite";

/**
 * M12: personal scope lowers the **data** floor and nothing else.
 *
 * The failure this guards against is the tempting shortcut: once a personal model is
 * allowed at 24 labels, letting it activate on a weaker comparison than the population
 * one. A model that is merely *fitted* is not a model that is *better than the rule*,
 * and the runner is the only one who pays for confusing the two.
 */

const AS_OF = "2026-10-01T00:00:00.000Z";
const RECORDED = "2026-09-01T00:00:00.000Z";

/**
 * `count` labels rotating over all three distances.
 *
 * All three, because the artifact contract requires a model that supports every
 * distance — a subset is rejected during validation, so a personal scope that allowed
 * two distances would only move the refusal later.
 */
const DISTANCE_CYCLE = ["five_k", "ten_k", "half_marathon"] as const;
const DISTANCE_SECONDS = { five_k: 1_150, ten_k: 2_400, half_marathon: 5_200 } as const;

function labelPlan(
  count: number,
  distances: readonly ("five_k" | "ten_k" | "half_marathon")[] = DISTANCE_CYCLE
): Array<{ localDate: string; distance: "five_k" | "ten_k" | "half_marathon"; durationSeconds: number }> {
  return Array.from({ length: count }, (_, index) => {
    const distance = distances[index % distances.length]!;
    return {
      localDate: new Date(Date.UTC(2024, 0, 7) + index * 14 * 86_400_000).toISOString().slice(0, 10),
      distance,
      durationSeconds: DISTANCE_SECONDS[distance] - index
    };
  });
}

async function withService(run: (service: PredictionModelService, database: RaiDatabase) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-scope-"));
  try {
    const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
    try {
      const service = new PredictionModelService({ database: store.database }, join(root, "artifacts"));
      run(service, store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("M12: the population gate is exactly what it was", () => {
  assert.deepEqual(predictionScopeFloors("population"), {
    scope: "population",
    requiredLabels: MINIMUM_PREDICTION_LABELS,
    requiredLabelsPerDistance: MINIMUM_LABELS_PER_DISTANCE
  });
  assert.equal(MINIMUM_PREDICTION_LABELS, 50, "the population floor must not drift");
  assert.equal(MINIMUM_LABELS_PER_DISTANCE, 8);
});

test("M12: personal scope reuses the artifact floors instead of inventing new ones", () => {
  assert.deepEqual(predictionScopeFloors("personal"), {
    scope: "personal",
    requiredLabels: PERSONAL_MINIMUM_LABELS,
    requiredLabelsPerDistance: PERSONAL_MINIMUM_LABELS_PER_DISTANCE
  });
  assert.equal(PERSONAL_MINIMUM_LABELS, 24);
  assert.equal(PERSONAL_MINIMUM_LABELS_PER_DISTANCE, 4);
});

test("M12: 30 labels are refused as population and accepted as personal", async () => {
  await withService((service, store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    for (const entry of labelPlan(30)) repository.insert({ ...entry, note: null, recordedAt: RECORDED });

    const population = service.preflight(AS_OF, "population");
    assert.equal(population.available, 30);
    assert.equal(population.eligible, false, "30 labels is still short of the population floor");
    assert.equal(population.requiredLabels, 50);
    assert.throws(
      () => service.enqueue({ asOf: AS_OF, scope: "population" }),
      (error: unknown) => {
        assert.ok(error instanceof PredictionTrainingPreconditionError);
        assert.equal(error.preflight.scope, "population");
        assert.match(error.message, /人群范围.*50 个标签/s);
        return true;
      }
    );

    const personal = service.preflight(AS_OF, "personal");
    assert.equal(personal.eligible, true, "the same 30 labels clear the personal floor");
    assert.equal(personal.requiredLabels, 24);
    assert.equal(personal.requiredLabelsPerDistance, 4);
    assert.equal(personal.availableByDistance.ten_k, 10);
    assert.equal(personal.availableByDistance.half_marathon, 10);
    assert.equal(personal.availableByDistance.five_k, 10);
  });
});

test("M12: an unqualified request keeps the population gate", async () => {
  await withService((service, store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    for (const entry of labelPlan(30)) repository.insert({ ...entry, note: null, recordedAt: RECORDED });
    // No `scope` at all: an older client must not silently get the lower floor.
    assert.throws(
      () => service.enqueue({ asOf: AS_OF }),
      (error: unknown) => {
        assert.ok(error instanceof PredictionTrainingPreconditionError);
        assert.equal(error.preflight.scope, "population");
        return true;
      }
    );
  });
});

test("M12: per-distance floors still apply inside the personal scope", async () => {
  await withService((service, store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    // 27 labels, but only three at the half marathon. The total clears the personal
    // floor while one distance does not — and the artifact contract requires all
    // three, so this must still be refused.
    for (const entry of labelPlan(12, ["ten_k"])) repository.insert({ ...entry, note: null, recordedAt: RECORDED });
    for (const entry of labelPlan(12, ["five_k"])) repository.insert({ ...entry, note: null, recordedAt: RECORDED });
    for (const entry of labelPlan(3, ["half_marathon"])) repository.insert({ ...entry, note: null, recordedAt: RECORDED });

    const personal = service.preflight(AS_OF, "personal");
    assert.equal(personal.available, 27);
    assert.equal(personal.eligible, false);
    assert.equal(personal.availableByDistance.half_marathon, 3);
    assert.match(new PredictionTrainingPreconditionError(personal).message, /每个距离至少 4 个/);
  });
});

test("M12: a stored run reports the scope it was trained under, and old rows default to population", async () => {
  await withService((service, store) => {
    // Written directly: the assertion is about how a *stored* row is read back, and
    // `enqueue` additionally requires an active ability model, which is a different
    // precondition with its own tests.
    // One row is terminal on purpose: the table enforces a single in-flight run, and
    // this assertion is about reading a stored row, not about queueing one.
    const insert = (id: string, requestJson: string, status: string): void => {
      store.database.prepare(`
        INSERT INTO prediction_model_runs (
          id, algorithm, model_version, feature_schema_version, training_data_through_at,
          hyperparameters_json, request_json, status, label_count, created_at
        ) VALUES (?, 'catboost', 'test', 'test', ?, '{}', ?, ?, 30, ?)
      `).run(id, AS_OF, requestJson, status, AS_OF);
    };
    insert("run_personal", JSON.stringify({ asOf: AS_OF, scope: "personal" }), "queued");
    insert("run_legacy", JSON.stringify({ asOf: AS_OF }), "rejected");

    const runs = service.list();
    assert.equal(runs.find((run) => run.id === "run_personal")!.scope, "personal");
    // A row written before the field existed was trained under the population gate.
    // Reading it as "personal" would relabel history as something it was not.
    assert.equal(runs.find((run) => run.id === "run_legacy")!.scope, "population");
  });
});
