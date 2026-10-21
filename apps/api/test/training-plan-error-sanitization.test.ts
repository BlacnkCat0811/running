import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { PlanOperationError } from "../src/plan-publication.js";
import {
  internalErrorLogDetail,
  trainingPlanCommandError,
  type TrainingPlanCommandService
} from "../src/training-plan-commands.js";
import { createTrainingPlanCommandHandlers, createTrainingPlanStateRoute } from "../src/training-plan-routes.js";
import { TrainingPlanStateConflictError, TrainingPlanStateError } from "../src/training-plan-store.js";

/**
 * PR-01: 5xx must not echo internal exception text.
 *
 * The probe (E-06) showed a synthesized exception carrying a fake private path
 * and token marker reaching the wire verbatim. These tests pin the whitelist:
 * known business errors keep their code/message; internal and unknown failures
 * get one fixed sentence and the original detail is only handed to the log sink.
 */

const SECRET = "/Users/private/rai.sqlite token=super-secret-marker";
const scope = { serverId: "server", athleteId: "athlete", datasetEpoch: "epoch" };

test("known business errors keep code/message; internal details never reach the wire", () => {
  const business = trainingPlanCommandError(new PlanOperationError("training_paused", "训练已暂停。", 409));
  assert.deepEqual(business, { statusCode: 409, code: "training_paused", message: "训练已暂停。" });

  const conflict = trainingPlanCommandError(new TrainingPlanStateConflictError(9));
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.code, "training_revision_conflict");
  assert.ok(!conflict.message.includes("revision conflict"), conflict.message);
  assert.ok(!conflict.message.includes("9"), "the internal revision must not leak");

  const logDetail = internalErrorLogDetail(new Error(`cannot open ${SECRET} with Bearer abc.def`));
  assert.equal(logDetail.name, "Error");
  assert.ok(!logDetail.message.includes(SECRET), logDetail.message);
  assert.ok(!logDetail.message.includes("abc.def"), logDetail.message);
  assert.ok(logDetail.message.includes("<path>") && logDetail.message.includes("<redacted>"), logDetail.message);

  const reported: Array<{ error: unknown; requestId?: string }> = [];
  const stateError = trainingPlanCommandError(new TrainingPlanStateError(`failed to open ${SECRET}`), {
    requestId: "req-1",
    report: detail => reported.push(detail)
  });
  assert.equal(stateError.statusCode, 503);
  assert.equal(stateError.code, "training_plan_state_invalid");
  assert.ok(!stateError.message.includes(SECRET));
  assert.equal(reported.length, 1);
  assert.equal(reported[0]!.requestId, "req-1");

  const unknown = trainingPlanCommandError(new Error(`EACCES ${SECRET}`), {
    requestId: "req-2",
    report: detail => reported.push(detail)
  });
  assert.equal(unknown.statusCode, 500);
  assert.equal(unknown.code, "training_plan_command_failed");
  assert.ok(!unknown.message.includes(SECRET));
  assert.equal(reported.length, 2);
  assert.equal(reported[1]!.requestId, "req-2");
});

test("command route answers a fixed 5xx, never the thrown message", async () => {
  const app = Fastify({ logger: false });
  const failing = {
    preview: () => { throw new Error(`SQLITE_ERROR at ${SECRET}`); },
    submit: () => { throw new Error(`SQLITE_ERROR at ${SECRET}`); }
  } as unknown as TrainingPlanCommandService;
  const handlers = createTrainingPlanCommandHandlers(failing);
  app.post("/preview", handlers.preview);
  app.post("/submit", handlers.submit);
  try {
    for (const url of ["/preview", "/submit"]) {
      const response = await app.inject({ method: "POST", url,
        payload: { contractVersion: 2, operationScope: scope, action: "pause" } });
      assert.equal(response.statusCode, 500, `${url}: ${response.body}`);
      const body = response.json() as { code: string; message: string };
      assert.equal(body.code, "training_plan_command_failed");
      assert.equal(body.message, "训练命令处理失败，请稍后重试；原计划保持不变。");
      assert.ok(!response.body.includes(SECRET), `${url}: ${response.body}`);
    }
  } finally {
    await app.close();
  }
});

test("v2 read route does not echo an unknown exception, but keeps known projection errors", async () => {
  const app = Fastify({ logger: false });
  app.get("/unavailable", createTrainingPlanStateRoute({
    identity: () => scope,
    businessDate: () => "2026-10-20",
    readUnifiedState: () => ({
      scope: "[]", revision: 1, updatedAt: "2026-10-20T00:00:00.000Z",
      state: {
        schemaVersion: 1, migrationVersion: 1, source: "legacy_goals", sourceStatus: "active",
        sourceDigest: "a".repeat(64), runState: "active", raceGoal: null, preferencesComplete: true,
        legacyRaceTarget: null, weekPlan: [], lockedSession: null, runCoach: null, coachLoop: null,
        goalsRevision: 0, planContextDigest: null, migratedAt: "2026-10-20T00:00:00.000Z"
      }
    }),
    readGoalsRevision: () => { throw new Error(`database is locked: ${SECRET}`); },
    legacy: () => ({ legacy: true })
  }));
  app.get("/known", createTrainingPlanStateRoute({
    identity: () => scope,
    // An invalid business date is a known projection rejection with a deliberate
    // user-facing message, not an internal exception.
    businessDate: () => "not-a-date",
    readUnifiedState: () => ({
      scope: "[]", revision: 1, updatedAt: "2026-10-20T00:00:00.000Z",
      state: {
        schemaVersion: 1, migrationVersion: 1, source: "legacy_goals", sourceStatus: "active",
        sourceDigest: "a".repeat(64), runState: "active", raceGoal: null, preferencesComplete: true,
        legacyRaceTarget: null, weekPlan: [], lockedSession: null, runCoach: null, coachLoop: null,
        goalsRevision: 0, planContextDigest: null, migratedAt: "2026-10-20T00:00:00.000Z"
      }
    }),
    readGoalsRevision: () => 0,
    legacy: () => ({ legacy: true })
  }));
  try {
    const unknown = await app.inject({ method: "GET", url: "/unavailable",
      headers: { "x-rai-training-contract": "2" } });
    assert.equal(unknown.statusCode, 503);
    assert.ok(!unknown.body.includes(SECRET), unknown.body);
    assert.equal((unknown.json() as { code: string }).code, "training_plan_state_invalid");
    assert.equal((unknown.json() as { message: string }).message, "统一训练状态暂不可读，请稍后重试；不会回退到旧合同。");

    // A known projection rejection keeps its deliberate message and code.
    const known = await app.inject({ method: "GET", url: "/known",
      headers: { "x-rai-training-contract": "2" } });
    assert.equal(known.statusCode, 503);
    const knownBody = known.json() as { code: string; message: string };
    assert.equal(knownBody.code, "training_plan_business_date_invalid");
    assert.equal(knownBody.message, "业务日期不可解析，不能生成统一快照。");
  } finally {
    await app.close();
  }
});
