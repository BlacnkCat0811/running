import assert from "node:assert/strict";
import test from "node:test";

import {
  assertUnifiedEvaluationReport,
  evaluationReportEnvelope,
  EVALUATION_REPORT_ENVELOPE_VERSION
} from "../src/index.js";

/**
 * §15.8 规定"每个版本比较产物至少包括"八项。实测这份合同此前只是**约定**：
 * 只有最新的那份产物（跨版本回放）带得起全部信息，其余可以把溯源信息整个丢掉
 * 而没有任何检查转红。
 *
 * 这些用例把它变成**条件**。检查范围刻意收在"机器可核对"的公共部分上 ——
 * 指标形状因领域而异（Fitness 比 CA/TA，Readiness 比裁决，预测比秒数），
 * 强行统一只会逼出空字段。
 */

const envelope = (overrides: Record<string, unknown> = {}) =>
  evaluationReportEnvelope({
    generatedBy: "scripts/example.mts",
    databasePath: "var/rai.sqlite",
    repoRevision: "f4d8088",
    reproduceCommand: "node --import tsx scripts/example.mts --database var/rai.sqlite",
    accuracyStatus: "not_evaluable",
    accuracyReason: "no labeled race/test outcomes in this database",
    gates: [{ name: "release", status: "passed" }],
    notEvaluable: [{ item: "external_label_accuracy", reason: "no labels" }],
    generatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides
  });

test("a complete envelope passes, including the domain-specific payload", () => {
  const report = { ...envelope(), leakageRate: 0.25, cases: [] };
  assert.doesNotThrow(() => assertUnifiedEvaluationReport(report));
  assert.equal((report as { envelopeVersion: string }).envelopeVersion, EVALUATION_REPORT_ENVELOPE_VERSION);
});

test("provenance cannot be dropped (§15.8-1/8)", () => {
  for (const key of ["generatedBy", "generatedAt", "databasePath", "reproduceCommand"] as const) {
    const report = { ...envelope() } as Record<string, unknown>;
    delete report[key];
    assert.throws(() => assertUnifiedEvaluationReport(report), new RegExp(`${key} is required`), key);
  }
  // 复现命令为空字符串同样是漏写。
  assert.throws(
    () => assertUnifiedEvaluationReport({ ...envelope(), reproduceCommand: "   " }),
    /reproduceCommand is required/
  );
});

test("an unknown revision is allowed, a missing key is not", () => {
  // "当时确实不知道"与"漏写"是两件事。
  assert.doesNotThrow(() => assertUnifiedEvaluationReport({ ...envelope(), repoRevision: null }));
  const report = { ...envelope() } as Record<string, unknown>;
  delete report.repoRevision;
  assert.throws(() => assertUnifiedEvaluationReport(report), /repoRevision is required/);
});

test("not_evaluable is a formal state that must state why (§15.8-7)", () => {
  assert.throws(
    () => assertUnifiedEvaluationReport({ ...envelope(), accuracyStatus: "not_evaluable", accuracyReason: null }),
    /accuracyReason is required/
  );
  assert.throws(
    () => assertUnifiedEvaluationReport({ ...envelope(), accuracyStatus: "unknown" }),
    /must be passed, failed or not_evaluable/
  );
  // 已评估时原因可省略，但类型不能错。
  assert.doesNotThrow(() =>
    assertUnifiedEvaluationReport({ ...envelope(), accuracyStatus: "passed", accuracyReason: null }));
  assert.throws(
    () => assertUnifiedEvaluationReport({ ...envelope(), accuracyStatus: "passed", accuracyReason: 7 }),
    /must be a string or null/
  );
});

test("every gate is passed, failed or not_evaluable, and an unevaluated gate says why (§15.8-6)", () => {
  assert.doesNotThrow(() => assertUnifiedEvaluationReport({
    ...envelope(),
    gates: [
      { name: "a", status: "passed" },
      { name: "b", status: "failed" },
      { name: "c", status: "not_evaluable", reason: "no independent cohort" }
    ]
  }));
  assert.throws(
    () => assertUnifiedEvaluationReport({ ...envelope(), gates: [{ name: "a", status: "skipped" }] }),
    /status must be passed, failed or not_evaluable/
  );
  // 一个"未评估"的 gate 不写原因，读的人会以为它没必要评估。
  assert.throws(
    () => assertUnifiedEvaluationReport({ ...envelope(), gates: [{ name: "a", status: "not_evaluable" }] }),
    /gate a reason is required/
  );
  assert.throws(() => assertUnifiedEvaluationReport({ ...envelope(), gates: {} }), /gates must be an array/);
});

test("unavailable statistics carry their reason (§15.8-5)", () => {
  assert.throws(
    () => assertUnifiedEvaluationReport({ ...envelope(), notEvaluable: [{ item: "mae" }] }),
    /notEvaluable.reason is required/
  );
  assert.throws(
    () => assertUnifiedEvaluationReport({ ...envelope(), notEvaluable: "none" }),
    /notEvaluable must be an array/
  );
  // 空数组是合法的：确实没有不可用项，与"没写"不同。
  assert.doesNotThrow(() => assertUnifiedEvaluationReport({ ...envelope(), notEvaluable: [] }));
});

test("an artifact from another envelope version is refused", () => {
  assert.throws(
    () => assertUnifiedEvaluationReport({ ...envelope(), envelopeVersion: "v0" }),
    /unsupported envelopeVersion/
  );
});
