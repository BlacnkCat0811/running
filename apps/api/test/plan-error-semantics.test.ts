import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import Fastify from "fastify";

import type { CoachLoopCommand, CoachLoopDeviceReceipt } from "@rai/api-contracts";

import { apiErrorPayload, retryAfterSeconds } from "../src/api-error.js";
import { registerCoachLoopRoutes } from "../src/coach-loop-routes.js";
import { MobileGoalsRevisionConflictError } from "../src/mobile-goals.js";
import { PlanOperationError } from "../src/plan-publication.js";

test("MobileGoalsRevisionConflictError maps to 409 even when a route forgets to catch it", () => {
  const payload = apiErrorPayload(new MobileGoalsRevisionConflictError(7));
  assert.equal(payload.status, 409);
  assert.equal(payload.body.code, "mobile_goals_revision_conflict");
  assert.equal(payload.body.message, "训练目标已在其他页面更新，请重新加载后再保存");
});

test("POST /v1/mobile/coach-loop maps a stale expectedRevision to 409 with currentRevision", async () => {
  const app = Fastify();
  const runtime = {
    read: () => { throw new Error("read must not be used by this test"); },
    command: (_command: CoachLoopCommand) => { throw new MobileGoalsRevisionConflictError(9); },
    recordDeviceReceipt: (_receipt: CoachLoopDeviceReceipt) => { throw new Error("not used"); }
  };
  registerCoachLoopRoutes({
    app,
    runtime: runtime as unknown as Parameters<typeof registerCoachLoopRoutes>[0]["runtime"],
    identity: () => ({ serverId: "local", athleteId: "athlete_1", datasetEpoch: "default" }),
    openMainDatabase: async () => { throw new Error("not used"); }
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mobile/coach-loop",
      payload: {
        contractVersion: 1,
        operationId: randomUUID(),
        operationScope: { serverId: "local", athleteId: "athlete_1", datasetEpoch: "default" },
        expectedRevision: 3,
        expectedFactsHash: "facts-hash",
        action: "refresh"
      }
    });
    assert.equal(response.statusCode, 409);
    const body = response.json() as { code: string; message: string; currentRevision: number };
    assert.equal(body.code, "mobile_goals_revision_conflict");
    assert.equal(body.currentRevision, 9);
    assert.match(body.message, /训练目标已在其他页面更新/);
  } finally {
    await app.close();
  }
});

test("coach_snapshot_changed keeps its 503 code/message instead of being redacted to internal_error", () => {
  const payload = apiErrorPayload(new PlanOperationError("coach_snapshot_changed",
    "教练计划状态在读取期间变化，请重新读取。", 503));
  assert.equal(payload.status, 503);
  assert.equal(payload.body.code, "coach_snapshot_changed");
  assert.equal(payload.body.message, "教练计划状态在读取期间变化，请重新读取。");
});

test("transient snapshot conflicts advertise one-second Retry-After (P2-6)", () => {
  const planChanged = apiErrorPayload(new PlanOperationError("plan_snapshot_changed",
    "训练事实在读取期间变化，请重试完整快照。", 503));
  assert.equal(retryAfterSeconds(planChanged), "1");
  const coachChanged = apiErrorPayload(new PlanOperationError("coach_snapshot_changed",
    "教练计划状态在读取期间变化，请重新读取。", 503));
  assert.equal(retryAfterSeconds(coachChanged), "1");
  // A generic 503 or an ordinary 409 is not evidence that one second is enough.
  assert.equal(retryAfterSeconds(apiErrorPayload(new PlanOperationError("plan_operations_unavailable",
    "当前存储不支持持久操作", 503))), null);
  assert.equal(retryAfterSeconds(apiErrorPayload(new PlanOperationError("plan_receipt_key_conflict",
    "冲突", 409))), null);
  assert.equal(retryAfterSeconds({ status: 429, body: { code: "rate_limited", message: "too many" } }), "5");
});

test("control-database busy keeps a retryable 503 instead of being redacted (P3-8)", () => {
  const busy = Object.assign(new Error("本地数据库正在切换，请稍后重试"),
    { statusCode: 503, code: "database_busy" });
  const payload = apiErrorPayload(busy);
  assert.equal(payload.status, 503);
  assert.equal(payload.body.code, "database_busy");
  assert.equal(payload.body.message, "本地数据库正在切换，请稍后重试");
  assert.equal(retryAfterSeconds(payload), "1");
});
