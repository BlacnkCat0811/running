import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TrainingPlanSessionExecution } from "@rai/api-contracts";
import { ensureTrainingPlanExecutionSchema, TrainingPlanExecutionRepository } from "../src/training-plan-execution-repository.js";

const scope = "s";
const instance = "instance-1";
const at = (second: number) => new Date(Date.UTC(2026, 9, 30, 3, 0, second)).toISOString();
const execution = (id: string, revision: number, overrides: Partial<TrainingPlanSessionExecution> = {}): TrainingPlanSessionExecution => ({
  sessionId: id, executionRevision: revision, association: "unlinked", trainingSessionId: null,
  sourceFactDigest: null, prescriptionSessionRevision: 1, assessment: null, availableAt: at(revision),
  reasonCodes: [], ...overrides
});
const confirmed = (id: string, revision: number, run: string, digest: string): TrainingPlanSessionExecution =>
  execution(id, revision, { association: "confirmed", trainingSessionId: run, sourceFactDigest: digest });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rai-execution-repository-"));
  const database = new DatabaseSync(join(root, "control.sqlite"));
  ensureTrainingPlanExecutionSchema(database);
  return { root, database, repository: new TrainingPlanExecutionRepository(database),
    close: () => { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("B06/S03-01: execution rows are transaction-only, revision-monotonic and immutable in history", () => {
  const f = setup();
  try {
    assert.throws(() => f.repository.append(scope, instance, execution("s1", 1), "confirm"), /publication transaction/);
    f.database.exec("BEGIN IMMEDIATE");
    f.repository.append(scope, instance, execution("s1", 1), "confirm");
    f.repository.append(scope, instance, confirmed("s1", 2, "run-1", "a".repeat(64)), "confirm");
    f.database.exec("COMMIT");
    assert.equal(f.repository.current(scope, "s1")!.execution.executionRevision, 2);
    assert.equal(f.repository.list(scope, instance).length, 1);
    assert.equal(f.repository.history(scope, "s1").length, 2);
    f.database.exec("BEGIN IMMEDIATE");
    assert.throws(() => f.repository.append(scope, instance, execution("s1", 4), "confirm"), /advance by exactly one/);
    assert.throws(() => f.repository.append(scope, instance, confirmed("s2", 1, "run-1", "b".repeat(64)),
      "confirm"), /UNIQUE constraint failed/);
    f.database.exec("ROLLBACK");
    assert.equal(f.repository.current(scope, "s1")!.execution.executionRevision, 2, "a failed append leaves the prior row intact");
  } finally { f.close(); }
});

test("B06/S03-01: one actual run can be confirmed by at most one course, but an unlinked/missing run does not occupy the key", () => {
  const f = setup();
  try {
    f.database.exec("BEGIN IMMEDIATE");
    f.repository.append(scope, instance, confirmed("s1", 1, "run-1", "a".repeat(64)), "confirm");
    assert.throws(() => f.repository.append(scope, instance + "-x", confirmed("s2", 1, "run-1", "a".repeat(64)), "confirm"),
      /UNIQUE constraint failed/);
    // The unique key is partial: an unlinked row for another session is fine.
    f.repository.append(scope, instance, execution("s3", 1), "skip");
    f.database.exec("COMMIT");
    assert.equal(f.repository.confirmedByTrainingSession(scope, "run-1")!.execution.sessionId, "s1");
    assert.equal(f.repository.list(scope).length, 2);
  } finally { f.close(); }
});

test("B06/S03-01: a rolled-back publication leaves no ghost execution or history", () => {
  const f = setup();
  try {
    f.database.exec("BEGIN IMMEDIATE");
    f.repository.append(scope, instance, confirmed("s1", 1, "run-1", "a".repeat(64)), "confirm");
    f.database.exec("ROLLBACK");
    assert.equal(f.repository.current(scope, "s1"), null);
    assert.equal(f.repository.history(scope, "s1").length, 0);
    assert.equal(f.repository.confirmedByTrainingSession(scope, "run-1"), null);
  } finally { f.close(); }
});
