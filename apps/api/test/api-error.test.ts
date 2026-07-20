import assert from "node:assert/strict";
import test from "node:test";

import { apiErrorPayload } from "../src/api-error.js";

test("does not infer not-found responses from internal error messages", () => {
  assert.deepEqual(apiErrorPayload(new Error("内部对象不存在：secret-row-id")), {
    status: 500,
    body: {
      code: "internal_error",
      message: "本地服务处理请求失败"
    }
  });
});

test("preserves explicit framework status codes", () => {
  const error = Object.assign(new Error("Invalid request"), { statusCode: 400, code: "invalid_fixture" });
  assert.deepEqual(apiErrorPayload(error), {
    status: 400,
    body: { code: "invalid_fixture", message: "Invalid request" }
  });
});

test("redacts explicit server errors and their internal codes", () => {
  const error = Object.assign(new Error("disk path: C:\\secret"), { statusCode: 503, code: "EIO" });
  assert.deepEqual(apiErrorPayload(error), {
    status: 503,
    body: { code: "internal_error", message: "本地服务处理请求失败" }
  });
});
