// 阶段 6 S08 合同裁决负例：HTTP 全 2xx 不能掩盖“拒绝用例被接受”。
import assert from "node:assert/strict";
import test from "node:test";

import { evaluateS08Contract } from "../../../scripts/phase6/s08-contract.mjs";

const refused = {
  expectation: "refused", expectedLane: null, allowJob: false,
  allowedRejectionStages: ["inspect"], expectedHttpStatus: [400],
  expectedCode: "import_manifest_invalid",
  expectedFacts: { healthRecords: 0, workouts: 0, routePoints: 0 },
  required: true
};

const accepted = {
  expectation: "accepted", expectedLane: "direct-sync", allowJob: true,
  allowedRejectionStages: [], expectedHttpStatus: [200], expectedCode: null,
  expectedFacts: { healthRecords: 5_001, workouts: 0, routePoints: 0 },
  required: true
};

const observed = (overrides = {}) => ({
  uploadStatus: 200, uploadCode: null, inspectStatus: 200, inspectCode: null,
  inspectBodyStatus: "ready", jobCreated: true, jobStatus: "succeeded",
  jobFailureCode: null, lane: "direct-sync", laneOutcome: "direct",
  factsDelta: { healthRecords: 5_001, workouts: 0, routePoints: 0 },
  rejection: null, ...overrides
});

test("拒绝用例被接受时，即使 HTTP 全是 2xx 也必须 ok=false", () => {
  const checks = evaluateS08Contract(refused, observed({ jobStatus: "succeeded", rejection: null }));
  assert.equal(checks.every((item) => item.ok), false);
  assert.equal(checks.find((item) => item.name === "no succeeded job").ok, false);
});

test("inspect 4xx + 零写入且 code 符合冻结合同时通过", () => {
  const checks = evaluateS08Contract(refused, observed({
    inspectStatus: 400, inspectCode: "import_manifest_invalid", inspectBodyStatus: null,
    jobCreated: false, jobStatus: null, lane: null,
    factsDelta: { healthRecords: 0, workouts: 0, routePoints: 0 },
    rejection: { stage: "inspect", status: 400, code: "import_manifest_invalid" }
  }));
  assert.equal(checks.every((item) => item.ok), true, JSON.stringify(checks.filter((item) => !item.ok)));
});

test("错误 code、错误阶段、部分事实都会失败", () => {
  const wrongCode = evaluateS08Contract(refused, observed({
    inspectStatus: 500, inspectCode: "internal_error", inspectBodyStatus: null,
    jobCreated: false, jobStatus: null,
    rejection: { stage: "inspect", status: 500, code: "internal_error" }
  }));
  assert.equal(wrongCode.every((item) => item.ok), false);

  const partialFacts = evaluateS08Contract(refused, observed({
    inspectStatus: 400, jobCreated: false, jobStatus: "failed",
    factsDelta: { healthRecords: 1, workouts: 0, routePoints: 0 },
    rejection: { stage: "inspect", status: 400, code: "import_manifest_invalid" }
  }));
  assert.equal(partialFacts.every((item) => item.ok), false);
});

test("5001 条按仓库合同走 direct-sync：车道和事实增量必须同时匹配", () => {
  assert.equal(evaluateS08Contract(accepted, observed()).every((item) => item.ok), true);
  const wrongLane = evaluateS08Contract(accepted, observed({ lane: "data-only" }));
  assert.equal(wrongLane.every((item) => item.ok), false);
  const wrongFacts = evaluateS08Contract(accepted, observed({
    factsDelta: { healthRecords: 5_000, workouts: 0, routePoints: 0 }
  }));
  assert.equal(wrongFacts.every((item) => item.ok), false);
});
