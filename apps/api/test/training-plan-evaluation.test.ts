import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureTrainingPlanEvaluationSchema, TrainingPlanEvaluationRepository } from "../src/training-plan-evaluation-repository.js";

const value = (inputKey: string, revision: number) => ({ inputKey, stateRevision: revision,
  businessDate: "2026-10-25", policyHash: "p".repeat(64), executionDigest: "a".repeat(64),
  operationId: "op-1", evaluatedAt: "2026-10-25T00:00:00.000Z" });

test("B08/S04-03: the evaluation cursor is one row per scope and only advances inside a transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-evaluation-"));
  const database = new DatabaseSync(join(root, "control.sqlite"));
  try {
    ensureTrainingPlanEvaluationSchema(database);
    const repository = new TrainingPlanEvaluationRepository(database);
    assert.equal(repository.get("scope"), null);
    assert.throws(() => repository.record("scope", value("k1", 1)), /publication transaction/);
    database.exec("BEGIN IMMEDIATE");
    repository.record("scope", value("k1", 1));
    repository.record("scope", value("k2", 2));
    database.exec("COMMIT");
    assert.equal(repository.get("scope")!.inputKey, "k2");
    assert.equal(repository.get("scope")!.stateRevision, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM mobile_training_plan_evaluation").get() as { n: number }).n, 1,
      "the cursor is updated in place, not appended");
    database.exec("BEGIN IMMEDIATE");
    repository.record("other", value("k3", 1));
    database.exec("ROLLBACK");
    assert.equal(repository.get("other"), null, "a rolled-back publication leaves no cursor");
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});
