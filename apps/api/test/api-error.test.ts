import assert from "node:assert/strict";
import test from "node:test";

import { apiErrorPayload } from "../src/api-error.js";
import { ImportSourceNotFoundError } from "../src/import-sources.js";
import { MutationConflictError } from "../src/mutation-coordinator.js";
import { RestoreRecoveryRequiredError } from "../src/restore-journal.js";

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

// 这两类错误原先只有 statusCode、没有 code，落到客户端只能看到笼统的
// "request_error"，无法区分"来源不存在"与"有别的写操作在跑"。
test("import source not-found keeps a distinguishable 404 code", () => {
  assert.deepEqual(apiErrorPayload(new ImportSourceNotFoundError()), {
    status: 404,
    body: { code: "import_source_not_found", message: "未找到导入来源" }
  });
});

test("mutation conflict keeps a distinguishable 409 code", () => {
  assert.deepEqual(apiErrorPayload(new MutationConflictError("recompute")), {
    status: 409,
    body: { code: "mutation_conflict", message: "另一项写操作正在执行：recompute" }
  });
});

test("invalid error statuses are redacted as internal errors", () => {
  for (const statusCode of [NaN, Infinity, -1, 200, 399, 600, 404.5, "404"]) {
    assert.deepEqual(apiErrorPayload(Object.assign(new Error("secret"), { statusCode })), {
      status: 500, body: { code: "internal_error", message: "本地服务处理请求失败" }
    });
  }
});

// P3-16：白名单之外的 5xx 一律 generic；白名单里的"领域 5xx"必须保留码与文案，
// 否则恢复失败 / 发布操作查询这类"只此一句"的运维提示会被压成"本地服务处理请求失败"。
test("designed 5xx domain outcomes keep their code and message", () => {
  const recovery = new RestoreRecoveryRequiredError("恢复备份失败，数据库需要恢复");
  assert.deepEqual(apiErrorPayload(recovery), {
    status: 503,
    body: { code: "restore_recovery_required", message: "恢复备份失败，数据库需要恢复" }
  });
  const unknownStatus = Object.assign(new Error("发布操作查询返回了未知状态 \"quarantined\"。"),
    { statusCode: 500, code: "plan_operation_status_unknown" });
  assert.deepEqual(apiErrorPayload(unknownStatus), {
    status: 500,
    body: { code: "plan_operation_status_unknown", message: "发布操作查询返回了未知状态 \"quarantined\"。" }
  });
});

test("the 5xx detail allowlist does not leak unknown internal codes", () => {
  const leaked = Object.assign(new Error("SQLITE_ERROR: no such table: secret_rows"),
    { statusCode: 500, code: "sqlite_error" });
  assert.deepEqual(apiErrorPayload(leaked), {
    status: 500,
    body: { code: "internal_error", message: "本地服务处理请求失败" }
  });
  // A missing code can never be exposed even with a 5xx status.
  assert.deepEqual(apiErrorPayload(Object.assign(new Error("boom"), { statusCode: 503 })), {
    status: 503,
    body: { code: "internal_error", message: "本地服务处理请求失败" }
  });
});
