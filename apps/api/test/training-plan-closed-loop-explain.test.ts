import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { TrainingPlanSession, TrainingPlanSessionExecution } from "@rai/api-contracts";

import {
  ensureTrainingPlanEvaluationSchema, TrainingPlanEvaluationRepository
} from "../src/training-plan-evaluation-repository.js";
import {
  ensureTrainingPlanExecutionSchema, TrainingPlanExecutionRepository
} from "../src/training-plan-execution-repository.js";
import {
  ensureTrainingPlanSessionSchema, TrainingPlanSessionRepository
} from "../src/training-plan-session-repository.js";

/**
 * B09 / S05-03 / M04: the B06/B08 read paths must use the indexes added by the
 * control-schema migrations, not rescan the whole history.
 *
 * The fixture deliberately holds 1,500 session-history rows and 1,500 current
 * execution rows. The assertions accept the documented EXPLAIN wording
 * differences across SQLite builds: a plan is accepted when its detail contains
 * `SEARCH` plus `USING INDEX` (or the specific index name), and is rejected when
 * the table itself is scanned. They do not pin a full plan string.
 */

const scope = "b09-explain-scope";
const instance = "b09-explain-plan";
const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-sessions-v2.json",
  import.meta.url), "utf8")) as { initial: TrainingPlanSession };

const historyRows = 1_500;
const executionRows = 1_500;
const confirmedRows = 100;
const targetDate = "2025-06-01";

interface DetailRow { detail: string }

function plan(database: DatabaseSync, sql: string, ...params: Array<string | number>): string {
  const rows = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as unknown as DetailRow[];
  return rows.map(row => row.detail).join(" | ");
}

function assertIndexed(label: string, detail: string, indexName?: string): void {
  assert.match(detail, /SEARCH/, `${label}: expected an index SEARCH plan, got: ${detail}`);
  assert.match(detail, /USING (?:COVERING )?INDEX/, `${label}: expected USING INDEX, got: ${detail}`);
  assert.doesNotMatch(detail, /\bSCAN\b/, `${label}: a table scan is not acceptable: ${detail}`);
  if (indexName !== undefined) {
    assert.ok(detail.includes(indexName), `${label}: expected index ${indexName}, got: ${detail}`);
  }
}

test("B06/B08/S05-03: 1,500+ history/execution rows still use the declared indexes", t => {
  const root = mkdtempSync(join(tmpdir(), "rai-b09-explain-"));
  const path = join(root, "control.sqlite");
  const database = new DatabaseSync(path);
  try {
    ensureTrainingPlanSessionSchema(database);
    ensureTrainingPlanExecutionSchema(database);
    ensureTrainingPlanEvaluationSchema(database);
    const sessions = new TrainingPlanSessionRepository(database);
    const executions = new TrainingPlanExecutionRepository(database);

    database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < historyRows; index += 1) {
      const day = new Date(Date.UTC(2025, 0, 1) + (index % 500) * 86_400_000).toISOString().slice(0, 10);
      const session: TrainingPlanSession = {
        ...structuredClone(fixture.initial),
        sessionId: `b09-history-${String(index).padStart(5, "0")}`,
        sessionRevision: 1,
        prescription: { ...structuredClone(fixture.initial.prescription), localDate: day },
        availableAt: new Date(Date.UTC(2025, 0, 1) + index * 60_000).toISOString()
      };
      sessions.append(scope, 1, session);
    }
    for (let index = 0; index < executionRows; index += 1) {
      const confirmed = index < confirmedRows;
      const execution: TrainingPlanSessionExecution = {
        sessionId: `b09-history-${String(index).padStart(5, "0")}`,
        executionRevision: 1,
        association: confirmed ? "confirmed" : "unlinked",
        trainingSessionId: confirmed ? `b09-run-${index}` : null,
        sourceFactDigest: confirmed ? "a".repeat(64) : null,
        prescriptionSessionRevision: 1,
        assessment: null,
        availableAt: new Date(Date.UTC(2025, 0, 1) + index * 60_000).toISOString(),
        reasonCodes: []
      };
      executions.append(scope, instance, execution, "b09-explain-seed");
    }
    database.exec("COMMIT");
    database.exec("BEGIN IMMEDIATE");
    new TrainingPlanEvaluationRepository(database).record(scope, {
      inputKey: "b09-explain-input-key", stateRevision: 1, businessDate: "2026-10-25", policyHash: null,
      executionDigest: "b".repeat(64), operationId: "b09-explain-op", evaluatedAt: "2026-10-25T00:00:00.000Z"
    });
    database.exec("COMMIT");

    const sessionCount = (database.prepare("SELECT COUNT(*) AS n FROM mobile_training_session_history").get() as { n: number }).n;
    const executionCount = (database.prepare("SELECT COUNT(*) AS n FROM mobile_training_execution").get() as { n: number }).n;
    assert.ok(sessionCount >= 1_000, `expected 1,000+ session history rows, got ${sessionCount}`);
    assert.ok(executionCount >= 1_000, `expected 1,000+ execution rows, got ${executionCount}`);
    assert.equal(executions.confirmedByTrainingSession(scope, "b09-run-0")!.execution.sessionId, "b09-history-00000");

    // 1. Session history by (scope, local_date, available_at): the B02 date index.
    const datePlan = plan(database, `SELECT * FROM mobile_training_session_history
      WHERE scope=? AND local_date=? AND available_at<=?
      ORDER BY available_at,session_id,session_revision LIMIT 50`, scope, targetDate, "2025-12-31T00:00:00.000Z");
    assertIndexed("session history by date", datePlan, "idx_training_session_history_date");

    // 2. Frozen revision by (scope, plan_instance_id, session_id, available_at): B02 time index.
    const effectivePlan = plan(database, `SELECT * FROM mobile_training_session_history
      WHERE scope=? AND plan_instance_id=? AND session_id=? AND available_at<=?
      ORDER BY available_at DESC,session_revision DESC LIMIT 1`, scope, instance, "b09-history-00000",
    "2025-12-31T00:00:00.000Z");
    assertIndexed("session history effective-at", effectivePlan, "idx_training_session_history_time");

    // 3. Current execution by (scope, session_id): the composite primary key.
    const currentPlan = plan(database,
      "SELECT * FROM mobile_training_execution WHERE scope=? AND session_id=?", scope, "b09-history-00000");
    assertIndexed("current execution by session", currentPlan);

    // 4. Confirmed execution by (scope, training_session_id): the partial unique index.
    const confirmedPlan = plan(database, `SELECT * FROM mobile_training_execution
      WHERE scope=? AND training_session_id=? AND association_status='confirmed'`, scope, "b09-run-0");
    assertIndexed("confirmed execution by run", confirmedPlan, "idx_training_execution_confirmed_run");

    // 5. Evaluation cursor by scope: the table's scope primary key.
    const evaluationPlan = plan(database, "SELECT * FROM mobile_training_plan_evaluation WHERE scope=?", scope);
    assertIndexed("evaluation cursor by scope", evaluationPlan);

    t.diagnostic(`rows: session_history=${sessionCount} execution=${executionCount} confirmed=${confirmedRows}`);
    t.diagnostic(`session date: ${datePlan}`);
    t.diagnostic(`session effective: ${effectivePlan}`);
    t.diagnostic(`execution current: ${currentPlan}`);
    t.diagnostic(`execution confirmed: ${confirmedPlan}`);
    t.diagnostic(`evaluation: ${evaluationPlan}`);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
