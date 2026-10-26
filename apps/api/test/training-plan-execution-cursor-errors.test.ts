import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createTrainingExecutionCommandHandlers,
  type TrainingPlanExecutionCommandService
} from "../src/training-plan-execution-commands.js";
import { ExecutionCursorError } from "../src/training-plan-execution-match.js";

test("B06/S03-02: an invalid candidate cursor is a 422 command error, never a storage 503", async () => {
  const service = { candidates: () => {
    throw new ExecutionCursorError("执行候选游标与当前查询不匹配，请重新读取候选。");
  } } as unknown as TrainingPlanExecutionCommandService;
  const handlers = createTrainingExecutionCommandHandlers(service, () => {}, async (fn) => fn());
  const request = { params: { sessionId: "session-1" }, query: {}, headers: {}, id: "cursor-test",
    log: { error: () => {} } } as unknown as FastifyRequest;
  const replyState = {
    statusCode: 200,
    body: null as unknown,
    header() { return this; },
    code(value: number) { this.statusCode = value; return this; },
    send(value: unknown) { this.body = value; return this; }
  };
  await handlers.candidates(request, replyState as unknown as FastifyReply);
  assert.equal(replyState.statusCode, 422);
  assert.deepEqual(replyState.body, {
    code: "training_session_command_invalid",
    message: "执行候选游标与当前查询不匹配，请重新读取候选。"
  });
});
