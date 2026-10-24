// 阶段 6 统计与裁决的纯逻辑回归：成功样本 P99、独立复算、指纹、case 证据与 G5。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MIN_SAMPLES_FOR_P99,
  nearestRank,
  readJsonl,
  summarizeDurations,
  summarizeResources,
  summarizeRun
} from "../../../scripts/phase6/summarize.mjs";
import {
  DEV_BASELINE_SCENARIOS,
  cgroupGateErrors,
  evidenceIdentityErrors,
  findFakeSuccess,
  missingScenarios,
  phaseIsolationErrors,
  recomputeSummaryErrors,
  resourceConsistencyErrors,
  s13WorkloadErrors,
  selfTest,
  validateSamples,
  verifyRun
} from "../../../scripts/phase6/verify.mjs";
import { REPO_ROOT, phase6ToolHashes, runtimeSourceHashes, sha256File } from "../../../scripts/phase6/safety.mjs";

test("nearest-rank matches ceil(p*n)-1 and clamps to the last sample", () => {
  assert.equal(nearestRank([], 0.99), null);
  assert.equal(nearestRank([1], 0.99), 1);
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(nearestRank(values, 0.5), 50);
  assert.equal(nearestRank(values, 0.95), 95);
  assert.equal(nearestRank(values, 0.99), 99);
  assert.equal(nearestRank(values, 1), 100);
});

test("P99 counts only successful latency samples, never timeouts or expected 4xx", () => {
  const success = (count, extra = {}) => Array.from({ length: count }, (_, index) => ({
    clientMs: index + 1, outcome: "success", status: 200, ...extra
  }));
  const below = summarizeDurations(success(MIN_SAMPLES_FOR_P99 - 1));
  assert.equal(below.p99, "insufficient_samples");
  assert.equal(below.n, MIN_SAMPLES_FOR_P99 - 1);
  assert.equal(below.p99SampleCount, MIN_SAMPLES_FOR_P99 - 1);

  const atGate = summarizeDurations(success(MIN_SAMPLES_FOR_P99));
  assert.equal(atGate.p99, 9900);
  assert.equal(atGate.p99SampleCount, MIN_SAMPLES_FOR_P99);

  // 9999 成功 + 1 超时：超时不能把样本数补到 10000。
  const withTimeout = summarizeDurations([
    ...success(MIN_SAMPLES_FOR_P99 - 1),
    { clientMs: 9999, outcome: "timeout", status: null, timeout: true }
  ]);
  assert.equal(withTimeout.p99, "insufficient_samples");
  assert.equal(withTimeout.n, MIN_SAMPLES_FOR_P99 - 1);
  assert.equal(withTimeout.timeouts, 1);

  // 10000 个预期 4xx 不是正常读的成功延迟。
  const refusals = summarizeDurations(Array.from({ length: MIN_SAMPLES_FOR_P99 }, () => ({
    clientMs: 1, outcome: "success", status: 400, expectedStatus: [400]
  })));
  assert.equal(refusals.p99, "insufficient_samples");
  assert.equal(refusals.businessSuccess, 0);
  assert.equal(refusals.expectedRefusal, MIN_SAMPLES_FOR_P99);

  // 10000 成功 + 超时：P99 可发布，但完成率降低。
  const mixed = summarizeDurations([
    ...success(MIN_SAMPLES_FOR_P99),
    { clientMs: 50, outcome: "timeout", status: null, timeout: true }
  ]);
  assert.notEqual(mixed.p99, "insufficient_samples");
  assert.ok(mixed.successRate < 1);
  assert.ok(mixed.completionRate < 1);
});

test("timeouts and oracle failures stay in the denominator", () => {
  const summary = summarizeDurations([
    { clientMs: 10, outcome: "success", status: 200 },
    { clientMs: null, outcome: "timeout", timeout: true, status: null },
    { clientMs: 20, outcome: "oracle_failed", status: 200 },
    { clientMs: 5, outcome: "server_error", status: 500 }
  ]);
  assert.equal(summary.n, 1);
  assert.equal(summary.offered, 4);
  assert.equal(summary.success, 1);
  assert.equal(summary.successRate, 0.25);
  assert.equal(summary.timeouts, 1);
  assert.equal(summary.serverErrors, 1);
  assert.equal(summary.oracleFailed, 1);
});

test("404 on a detail route is a fake success, not a fast read", () => {
  const samples = [{
    routeTemplate: "/v1/workouts/:id", status: 404, outcome: "success",
    scheduledAt: new Date().toISOString(), sentAt: new Date().toISOString(), clientMs: 1
  }];
  assert.equal(findFakeSuccess(samples).length, 1);
  assert.ok(validateSamples(samples).length > 0);
});

test("empty/missing scenarios and warmup-only groups fail closed", () => {
  assert.deepEqual(missingScenarios(["S01"], { scenarios: {} }), ["S01"]);
  const errors = phaseIsolationErrors({
    scenarios: { S01: { requests: 2, phases: { "warmup:main": {} }, scenarios: {} } }
  });
  assert.equal(errors.length, 1);
});

test("resource summary does not claim cgroup memory when cgroup is unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-res-"));
  const path = join(dir, "resources-S01.jsonl");
  writeFileSync(path, [
    JSON.stringify({ kind: "capability", platform: "darwin", cgroup: false, intervalMs: 1000 }),
    JSON.stringify({ kind: "sample", at: "2026-01-01T00:00:00Z", rssBytes: 100, cgroup: null })
  ].join("\n") + "\n");
  try {
    const summary = summarizeResources(path);
    assert.equal(summary.cgroupAvailable, false);
    assert.equal(summary.cgroupMemoryCurrentPeakBytes, null);
    assert.equal(summary.rssPeakBytes, 100);
    assert.equal(readJsonl(path).length, 2);
    assert.ok(resourceConsistencyErrors({ resources: [summary] }).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify self-test catches every negative case", () => {
  const result = selfTest();
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function baseProtocol() {
  return {
    protocolVersion: 1,
    protocolId: "test-protocol",
    profiles: { dev: { purpose: "test" }, "cloud-validation": { purpose: "test" } },
    datasets: { D0: {} },
    scenarios: Object.fromEntries([...DEV_BASELINE_SCENARIOS, "S13"].map((scenario) => [scenario, {}])),
    statistics: {
      percentile: "nearest-rank: sorted[ceil(p*n)-1]",
      minSamplesForP99: MIN_SAMPLES_FOR_P99,
      warmupSeconds: 30,
      minimumHotReadSeconds: 300
    }
  };
}

function codeIdentity() {
  return {
    commit: "test-commit",
    packageLockSha256: sha256File(join(REPO_ROOT, "package-lock.json")),
    toolFiles: phase6ToolHashes(),
    sourceFiles: runtimeSourceHashes()
  };
}

const TEST_RUN_ID = "test-run";
const TEST_PROFILE = "dev";
const TEST_DATASET = "D0";
const testIdentity = (scenario) => ({ runId: TEST_RUN_ID, profile: TEST_PROFILE, dataset: TEST_DATASET, scenario });

function defaultScenarioData(scenario, now) {
  const identity = testIdentity(scenario);
  const samples = [{
    kind: "http", ...identity, routeTemplate: "/v1/health", method: "GET",
    scheduledAt: now, sentAt: now, status: 200, outcome: "success", clientMs: 5,
    bodyBytes: 10, timeout: false, traffic: "main", phase: "steady"
  }];
  const taskEvents = [];
  const cases = [];
  if (scenario === "S06") {
    taskEvents.push({ type: "s06_duplicate_check", noDuplicateHealthRecords: true, noDuplicateWorkouts: true });
    cases.push({ caseId: "S06-DUPLICATE", ok: true, checks: [] });
  }
  if (scenario === "S08") {
    cases.push({ caseId: "S08-01", ok: true, checks: [], contract: { required: true } });
  }
  return { samples, taskEvents, cases };
}

function writeScenario(root, scenario, data, now) {
  const identity = testIdentity(scenario);
  mkdirSync(join(root, "results", scenario, "raw"), { recursive: true });
  mkdirSync(join(root, "results", scenario, "correctness"), { recursive: true });
  const rawSamples = data.samples;
  const taskEvents = data.taskEvents ?? [];
  const cases = data.cases ?? [];
  writeJsonl(join(root, "results", scenario, "raw", "requests.jsonl"), rawSamples);
  writeJsonl(join(root, "results", scenario, "raw", "task-events.jsonl"),
    taskEvents.map((event) => ({ ...identity, ...event })));
  writeJsonl(join(root, "results", scenario, "raw", "cases.jsonl"),
    cases.map((entry) => ({ ...identity, ...entry })));
  const outcomes = rawSamples.reduce((counts, sample) => {
    const outcome = sample.outcome ?? "unknown";
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    return counts;
  }, {});
  writeFileSync(join(root, "results", scenario, "correctness", `${scenario}.json`), JSON.stringify({
    ...identity, incomplete: false, requests: rawSamples.length, outcomes, oracleFailures: [], cases
  }));
  writeFileSync(join(root, "raw", `resources-${scenario}.jsonl`), [
    JSON.stringify({ kind: "capability", platform: "darwin", cgroup: false, intervalMs: 1000 }),
    JSON.stringify({ kind: "sample", at: now, rssBytes: 1000, cgroup: null })
  ].join("\n") + "\n");
}

function syntheticRun(root, {
  protocolPath, sampleOverride = null, samples = null, scenario = "S01", cases = [], taskEvents = [],
  profile = TEST_PROFILE, commands = null, scenarioList = null
} = {}) {
  mkdirSync(join(root, "raw"), { recursive: true });
  mkdirSync(join(root, "report"), { recursive: true });
  const now = new Date().toISOString();
  const declared = [...new Set([...(scenarioList ?? DEV_BASELINE_SCENARIOS), scenario])];
  for (const declaredScenario of declared) {
    let data = defaultScenarioData(declaredScenario, now);
    if (declaredScenario === scenario) {
      const baseSample = data.samples[0];
      data = {
        samples: samples ?? [{ ...baseSample, ...(sampleOverride ?? {}) }],
        taskEvents,
        cases
      };
    }
    writeScenario(root, declaredScenario, data, now);
  }

  const fixturePath = join(root, "fixture.sqlite");
  writeFileSync(fixturePath, "fixture-bytes");
  const fixtureSha = sha256File(fixturePath);
  const fixtureManifest = join(root, "fixture-manifest.json");
  writeFileSync(fixtureManifest, JSON.stringify({
    dataset: "D0", rows: { health_records: 1 }, digest: "abc",
    bytes: { database: 13, databaseSha256: fixtureSha }
  }));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1, runId: TEST_RUN_ID, status: "complete", profile, dataset: TEST_DATASET,
    scenarios: declared,
    scenariosResults: declared.map((declaredScenario) => ({ scenario: declaredScenario, exitCode: 0, incomplete: false })),
    errors: [],
    code: codeIdentity(),
    protocol: { sha256: sha256File(protocolPath), protocolId: "test-protocol" },
    fixture: { path: fixturePath, sha256: fixtureSha, bytes: 13 },
    fixtureManifest: { path: fixtureManifest, sha256: sha256File(fixtureManifest) },
    commands: commands ?? [],
    safety: {
      rootOutsideRepo: true, envWhitelist: true, mainAndControlDistinct: true, loopbackOnly: true,
      isolatedTemp: join(root, "tmp"), tokenScan: "clean"
    }
  }));
  writeFileSync(join(root, "secret-findings.json"), "[]\n");
  writeFileSync(join(root, "report", "summary.json"), `${JSON.stringify(summarizeRun(root), null, 2)}\n`);
}

function writeProtocol(path) {
  writeFileSync(path, JSON.stringify(baseProtocol()));
}

const REQUIRED_REGRESSION_COMMANDS = [
  "node scripts/phase6/verify.mjs --self-test",
  "npm run phase6:test",
  "npm run typecheck",
  "RAI_TEST_CONCURRENCY=2 npm test",
  "npm run check:acceptance-matrix",
  "npm run smoke:api",
  "npm run check:scripts",
  "npm run check:docs"
];

function regressionsRecord(commands = REQUIRED_REGRESSION_COMMANDS) {
  return {
    overall: "PASS",
    checks: commands.map((command) => ({ command, exitCode: 0 })),
    codeIdentity: codeIdentity()
  };
}

test("verifyRun signs DEV only when the full matrix and required gates pass, and keeps CLOUD blocked", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath });
    const regressions = join(dir, "regressions.json");
    writeFileSync(regressions, JSON.stringify(regressionsRecord()));
    const acceptance = verifyRun({
      runRoot, protocolPath, scope: "dev", regressionsPath: regressions,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24")
    });
    assert.equal(acceptance.verdict.devBaseline, "PASS");
    assert.deepEqual(acceptance.verdict.devScenarioMatrix.missing, []);
    assert.equal(acceptance.verdict.cloudCapacity, "BLOCKED");
    assert.equal(acceptance.verdict.phase6Overall, "BLOCKED");
    assert.equal(acceptance.exitCode, 0);
    assert.equal(acceptance.gates.find((gate) => gate.id === "G5").status, "BLOCKED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a DEV run that only executes S01 cannot receive devBaseline PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath, scenarioList: ["S01"] });
    const regressions = join(dir, "regressions.json");
    writeFileSync(regressions, JSON.stringify(regressionsRecord()));
    const acceptance = verifyRun({
      runRoot, protocolPath, scope: "dev", regressionsPath: regressions,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24")
    });
    const g4 = acceptance.gates.find((gate) => gate.id === "G4");
    assert.equal(g4.status, "FAIL");
    assert.ok(g4.evidence.devMatrixErrors.some((error) => error.includes("S02")));
    assert.equal(acceptance.verdict.devBaseline, "FAIL");
    assert.equal(acceptance.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyRun fails closed when a scenario is missing or a 404 is recorded as success", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const missingRun = join(dir, "missing");
    mkdirSync(missingRun, { recursive: true });
    writeFileSync(join(missingRun, "manifest.json"), JSON.stringify({
      schemaVersion: 1, profile: "dev", dataset: "D0", scenarios: ["S02"],
      code: codeIdentity(), protocol: { sha256: sha256File(protocolPath) }, safety: {}
    }));
    const missing = verifyRun({ runRoot: missingRun, protocolPath, scope: "dev",
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(missing.gates.find((gate) => gate.id === "G4").status, "FAIL");
    assert.equal(missing.exitCode, 1);

    const fakeRun = join(dir, "fake");
    const now = new Date().toISOString();
    syntheticRun(fakeRun, { protocolPath, sampleOverride: {
      kind: "http", scenario: "S01", routeTemplate: "/v1/workouts/:id", method: "GET",
      scheduledAt: now, sentAt: now, status: 404, outcome: "success", clientMs: 1, bodyBytes: 1, timeout: false
    } });
    const fake = verifyRun({ runRoot: fakeRun, protocolPath, scope: "dev",
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(fake.gates.find((gate) => gate.id === "G3").status, "FAIL");
    assert.equal(fake.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyRun fails when the protocol was changed after the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath });
    // 测后把 SLO/协议内容改一字节（等价于审查复现的 health P95=999999）。
    const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
    protocol.slo = { healthP95Ms: 999999 };
    writeFileSync(protocolPath, JSON.stringify(protocol));
    const acceptance = verifyRun({ runRoot, protocolPath, scope: "dev",
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(acceptance.gates.find((gate) => gate.id === "G0").status, "FAIL");
    assert.equal(acceptance.gates.find((gate) => gate.id === "G8").status, "FAIL");
    assert.equal(acceptance.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyRun compares saved summary to raw instead of recomputing and comparing to itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath });
    const summaryPath = join(runRoot, "report", "summary.json");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    summary.scenarios.S01.routes["/v1/health"].p95 = 999;
    writeFileSync(summaryPath, JSON.stringify(summary));
    const acceptance = verifyRun({ runRoot, protocolPath, scope: "dev",
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(acceptance.gates.find((gate) => gate.id === "G8").status, "FAIL");
    assert.equal(acceptance.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyRun fails closed on unknown scope/profile and missing case evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    const protocol = baseProtocol();
    protocol.profiles = { dev: {} };
    writeFileSync(protocolPath, JSON.stringify(protocol));
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath });
    assert.throws(() => verifyRun({ runRoot, protocolPath, scope: "production" }), /unknown scope/);

    const manifest = JSON.parse(readFileSync(join(runRoot, "manifest.json"), "utf8"));
    manifest.profile = "cloud-default";
    writeFileSync(join(runRoot, "manifest.json"), JSON.stringify(manifest));
    const unknownProfile = verifyRun({ runRoot, protocolPath, scope: "dev",
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(unknownProfile.gates.find((gate) => gate.id === "G0").status, "FAIL");

    // S08 声明了场景却没有 raw/cases.jsonl：G3/G4 非 PASS。
    const s08Run = join(dir, "s08");
    syntheticRun(s08Run, { protocolPath, scenario: "S08", cases: [] });
    const s08Manifest = JSON.parse(readFileSync(join(s08Run, "manifest.json"), "utf8"));
    s08Manifest.scenarios = ["S08"];
    writeFileSync(join(s08Run, "manifest.json"), JSON.stringify(s08Manifest));
    const s08 = verifyRun({ runRoot: s08Run, protocolPath, scope: "dev",
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.notEqual(s08.gates.find((gate) => gate.id === "G3").status, "PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G5 rejects a cloud profile without target cgroup readback", () => {
  const summary = {
    resources: [{
      file: "resources-S13.jsonl", cgroupAvailable: false,
      capability: { cgroup: false, targetCgroup: null, samplerCgroup: null }
    }]
  };
  const result = cgroupGateErrors({ profile: "cloud-default" }, summary, baseProtocol());
  assert.equal(result.status, "FAIL");
  assert.ok(result.errors.length > 0);
  const dev = cgroupGateErrors({ profile: "dev" }, summary, baseProtocol());
  assert.equal(dev.status, "BLOCKED");
});

test("raw HTTP failures cannot be hidden by a forged correctness file", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    const now = new Date().toISOString();
    syntheticRun(runRoot, { protocolPath, sampleOverride: {
      kind: "http", scenario: "S01", routeTemplate: "/v1/health", method: "GET",
      scheduledAt: now, sentAt: now, status: 500, outcome: "server_error", clientMs: 5,
      bodyBytes: 10, timeout: false
    } });
    const result = verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(result.gates.find((gate) => gate.id === "G4").status, "FAIL");
    assert.equal(result.gates.find((gate) => gate.id === "G8").status, "FAIL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("incomplete runner and driver records cannot receive DEV PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath });
    const manifestPath = join(runRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.status = "incomplete";
    manifest.scenariosResults[0].incomplete = true;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(result.gates.find((gate) => gate.id === "G4").status, "FAIL");
    assert.equal(result.verdict.devBaseline, "FAIL");
    manifest.status = "complete";
    manifest.scenariosResults[0].incomplete = false;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const correctnessPath = join(runRoot, "results", "S01", "correctness", "S01.json");
    const correctness = JSON.parse(readFileSync(correctnessPath, "utf8"));
    correctness.incomplete = true;
    writeFileSync(correctnessPath, JSON.stringify(correctness));
    assert.equal(verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24")
    }).gates.find((gate) => gate.id === "G4").status, "FAIL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runtime source hash changes invalidate G0 and G8", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath });
    const manifestPath = join(runRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const source = Object.keys(manifest.code.sourceFiles)[0];
    manifest.code.sourceFiles[source] = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(result.gates.find((gate) => gate.id === "G0").status, "FAIL");
    assert.equal(result.gates.find((gate) => gate.id === "G8").status, "FAIL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("G9 requires source identity even when both old records omit it", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath });
    const manifestPath = join(runRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.code.sourceFiles;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const regressions = join(dir, "regressions.json");
    const identity = codeIdentity();
    delete identity.sourceFiles;
    writeFileSync(regressions, JSON.stringify({ overall: "PASS", checks: [{ exitCode: 0 }], codeIdentity: identity }));
    const result = verifyRun({ runRoot, protocolPath, regressionsPath: regressions,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(result.gates.find((gate) => gate.id === "G9").status, "FAIL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("G9 rejects a regression record that omits npm test even when every recorded exit is 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath });
    const regressions = join(dir, "regressions.json");
    writeFileSync(regressions, JSON.stringify(regressionsRecord(
      REQUIRED_REGRESSION_COMMANDS.filter((command) => command !== "RAI_TEST_CONCURRENCY=2 npm test")
    )));
    const result = verifyRun({ runRoot, protocolPath, regressionsPath: regressions,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    const g9 = result.gates.find((gate) => gate.id === "G9");
    assert.equal(g9.status, "FAIL");
    assert.ok(g9.evidence.missingCommands.some((command) => command.includes("npm test")));
    assert.equal(result.verdict.devBaseline, "FAIL");
    assert.equal(result.exitCode, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S13 read-only evidence cannot pass the read-write workload gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath, scenario: "S13" });
    const result = verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(result.gates.find((gate) => gate.id === "G4").status, "FAIL");
    assert.ok(result.gates.find((gate) => gate.id === "G4").evidence.workloadErrors.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("G5 checks every declared scenario resource file", () => {
  const protocol = baseProtocol();
  protocol.profiles["cloud-default"] = { resourceReadBack: {
    cpuQuotaCores: 1.5, memoryHighBytes: 1153433600, memoryMaxBytes: 1468006400,
    swapMaxBytes: 536870912, tasksMax: 128,
    host: { cpuCount: 2, totalMemoryBytes: 2147483648 }
  } };
  const good = {
    file: "resources-S01.jsonl", cgroupAvailable: true, sampleCount: 2,
    cgroupEscapedPidsMax: 0, cgroupOomKillsMax: 0,
    cgroupMemoryCurrentPeakBytes: 100, cgroupMemoryKernelPeakBytes: 100, cpuUsageCoresPeak: 1,
    capability: {
      cgroup: true, targetCgroup: "/rai/phase6", samplerCgroup: "/observer",
      samplerSeparate: true, attributionMismatch: false, limitErrors: [],
      host: { cpuCount: 2, totalMemoryBytes: 2147483648 },
      limits: {
        cpuMax: "150000 100000", cpuMaxCores: 1.5, memoryHighBytes: 1153433600,
        memoryMaxBytes: 1468006400, memorySwapMaxBytes: 536870912, pidsMax: 128,
        memoryCurrentBytes: 100, memoryPeakBytes: 100, memoryEvents: { oom_kill: 0 },
        cpuStat: { usage_usec: 1000 }, ioStat: {}
      }
    }
  };
  const manifest = { profile: "cloud-default", scenarios: ["S01", "S02"] };
  assert.equal(cgroupGateErrors({ ...manifest, scenarios: ["S01"] }, { resources: [good] }, protocol).status, "PASS");
  const goodOnly = cgroupGateErrors(manifest, { resources: [good] }, protocol);
  assert.equal(goodOnly.status, "FAIL");
  assert.ok(goodOnly.errors.some((error) => error.includes("S02")));
  const badSecond = cgroupGateErrors(manifest, { resources: [good, { ...good,
    file: "resources-S02.jsonl", cgroupEscapedPidsMax: 1
  }] }, protocol);
  assert.equal(badSecond.status, "FAIL");
  assert.ok(badSecond.errors.some((error) => error.includes("escaped")));
});

test("evidence identity: a raw file from another run cannot be aggregated into G3", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath });
    const requestsPath = join(runRoot, "results", "S01", "raw", "requests.jsonl");
    const sample = JSON.parse(readFileSync(requestsPath, "utf8"));
    writeJsonl(requestsPath, [{ ...sample, runId: "another-run" }]);
    const result = verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(result.gates.find((gate) => gate.id === "G3").status, "FAIL");
    assert.ok(result.gates.find((gate) => gate.id === "G3").evidence.identityErrors
      .some((error) => error.includes("runId")));
    const expected = { runId: "r", profile: "dev", dataset: "D0", scenario: "S01" };
    assert.equal(evidenceIdentityErrors([{ ...sample, ...expected }], expected).length, 0);
    assert.equal(evidenceIdentityErrors([{ ...sample, ...expected, scenario: "S02" }], expected).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S06 duplicate flags must pass G4 even when the driver case record is forged green", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    const now = new Date().toISOString();
    syntheticRun(runRoot, {
      protocolPath, scenario: "S06",
      samples: [{
        ...testIdentity("S06"), kind: "http", routeTemplate: "/v1/imports/uploads", method: "POST",
        scheduledAt: now, sentAt: now, status: 200, outcome: "success", clientMs: 1,
        bodyBytes: 10, timeout: false, traffic: "main", phase: null
      }],
      cases: [{ caseId: "S06-DUPLICATE", ok: true, checks: [] }],
      taskEvents: [{ type: "s06_duplicate_check", noDuplicateHealthRecords: false, noDuplicateWorkouts: true }]
    });
    const failed = verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    const failedGate = failed.gates.find((gate) => gate.id === "G4");
    assert.equal(failedGate.status, "FAIL");
    assert.ok(failedGate.evidence.workloadErrors.some((error) => error.includes("duplicate health records")));

    writeJsonl(join(runRoot, "results", "S06", "raw", "task-events.jsonl"), [{
      ...testIdentity("S06"), type: "s06_duplicate_check",
      noDuplicateHealthRecords: true, noDuplicateWorkouts: true
    }]);
    const passed = verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(passed.gates.find((gate) => gate.id === "G4").status, "PASS");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S13 offered/dropped/conservation must match raw samples; drops cannot pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const requests = join(dir, "requests.jsonl");
    const identity = testIdentity("S13");
    const mainSuccess = {
      ...identity, kind: "http", routeTemplate: "/v1/performance-entries", method: "POST",
      scheduledAt: new Date().toISOString(), sentAt: new Date().toISOString(), status: 200,
      outcome: "success", clientMs: 1, traffic: "main", phase: "steady"
    };
    const health = {
      ...identity, kind: "http", routeTemplate: "/v1/health", method: "GET",
      scheduledAt: new Date().toISOString(), sentAt: new Date().toISOString(), status: 200,
      outcome: "success", clientMs: 1, traffic: "health", phase: "steady"
    };
    const readback = {
      ...identity, kind: "http", routeTemplate: "/v1/performance-entries", method: "GET",
      scheduledAt: new Date().toISOString(), sentAt: new Date().toISOString(), status: 200,
      outcome: "success", clientMs: 1, traffic: "write-readback", phase: "steady"
    };
    const validLoad = {
      rate: 1, warmupMs: 0, durationMs: 1000, mainOffered: 1, mainSent: 1, mainCompleted: 1,
      mainDropped: 0, mainDroppedCapacity: 0, mainDroppedWindow: 0, mainStillInFlight: 0, mainCancelled: 0,
      healthOffered: 1, healthSent: 1, healthCompleted: 1, healthDropped: 0,
      healthDroppedCapacity: 0, healthDroppedWindow: 0, healthStillInFlight: 0, healthCancelled: 0,
      writeSent: 1, writeSuccessful: 1, writeReadbackSent: 1, writeReadbackSuccessful: 1,
      offered: 2, dropped: 0,
      phaseCounters: { warmup: { mainOffered: 0 }, steady: { mainOffered: 1 } },
      conservation: { main: true, health: true, mainSent: true, healthSent: true, combinedOffered: true }
    };
    const shortLimits = { warmupSeconds: 0, minimumHotReadSeconds: 1 };
    writeJsonl(requests, [mainSuccess, health, readback]);
    assert.deepEqual(s13WorkloadErrors({ rawFiles: { requests }, load: validLoad }, shortLimits), []);

    const dropped = {
      ...identity, kind: "http", routeTemplate: "/v1/health", method: "GET", scheduledAt: new Date().toISOString(),
      sentAt: null, status: null, outcome: "runner_dropped", clientMs: null, traffic: "health",
      phase: "steady", dropReason: "capacity"
    };
    writeJsonl(requests, [mainSuccess, health, readback, dropped]);
    const error = s13WorkloadErrors({
      rawFiles: { requests },
      load: { ...validLoad, healthOffered: 2, healthDropped: 1, healthDroppedCapacity: 1,
        healthSent: 1, healthCompleted: 1, offered: 3, dropped: 1 }
    }, shortLimits);
    assert.ok(error.some((item) => item.includes("dropped")));
    assert.ok(error.some((item) => item.includes("healthOffered")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S13 short smoke loads fail the protocol warmup/minimum duration gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const requests = join(dir, "requests.jsonl");
    const identity = testIdentity("S13");
    const main = {
      ...identity, kind: "http", routeTemplate: "/v1/performance-entries", method: "POST",
      scheduledAt: new Date().toISOString(), sentAt: new Date().toISOString(), status: 200,
      outcome: "success", clientMs: 1, traffic: "main", phase: "steady"
    };
    const health = {
      ...identity, kind: "http", routeTemplate: "/v1/health", method: "GET",
      scheduledAt: new Date().toISOString(), sentAt: new Date().toISOString(), status: 200,
      outcome: "success", clientMs: 1, traffic: "health", phase: "steady"
    };
    writeJsonl(requests, [main, health]);
    const errors = s13WorkloadErrors({
      rawFiles: { requests },
      load: {
        rate: 1, warmupMs: 0, durationMs: 1000, mainOffered: 1, mainSent: 1, mainCompleted: 1,
        mainDropped: 0, mainDroppedCapacity: 0, mainDroppedWindow: 0, mainStillInFlight: 0, mainCancelled: 0,
        healthOffered: 1, healthSent: 1, healthCompleted: 1, healthDropped: 0,
        healthDroppedCapacity: 0, healthDroppedWindow: 0, healthStillInFlight: 0, healthCancelled: 0,
        writeSent: 1, writeSuccessful: 1, writeReadbackSent: 1, writeReadbackSuccessful: 1,
        offered: 2, dropped: 0,
        phaseCounters: { warmup: { mainOffered: 0 }, steady: { mainOffered: 1 } },
        conservation: { main: true, health: true, mainSent: true, healthSent: true, combinedOffered: true }
      }
    }, { warmupSeconds: 30, minimumHotReadSeconds: 300 });
    assert.ok(errors.some((item) => item.includes("warmup")));
    assert.ok(errors.some((item) => item.includes("duration")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLOUD-VALIDATION S12 must record an actual command submit in the runner validation mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, {
      protocolPath, scenario: "S12", profile: "cloud-validation",
      commands: [{ scenario: "S12", command: "node --import tsx apps/api/src/server.ts",
        envKeys: ["RAI_TRAINING_PLAN_COMMAND_MODE"] }]
    });
    const result = verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    const gate = result.gates.find((item) => item.id === "G4");
    assert.equal(gate.status, "FAIL");
    assert.ok(gate.evidence.workloadErrors.some((error) => error.includes("no successful command submit")));
    assert.ok(gate.evidence.workloadErrors.some((error) => error.includes("no successful command preview")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("G1 reads saved secret-findings and logs, not only in-memory runner errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase6-verify-"));
  try {
    const protocolPath = join(dir, "protocol.json");
    writeProtocol(protocolPath);
    const runRoot = join(dir, "run");
    syntheticRun(runRoot, { protocolPath });
    writeFileSync(join(runRoot, "secret-findings.json"), JSON.stringify([
      { kind: "api_token", file: "api-S01.log" }
    ]));
    const findings = verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(findings.gates.find((gate) => gate.id === "G1").status, "FAIL");

    writeFileSync(join(runRoot, "secret-findings.json"), "[]\n");
    mkdirSync(join(runRoot, "logs"), { recursive: true });
    writeFileSync(join(runRoot, "logs", "api-S01.log"), "authorization: Bearer leakleakleakleak\n");
    const logHits = verifyRun({ runRoot, protocolPath,
      deliverableDir: join(REPO_ROOT, "deliverables", "phase6-performance-2026-10-24") });
    assert.equal(logHits.gates.find((gate) => gate.id === "G1").status, "FAIL");
    assert.equal(logHits.gates.find((gate) => gate.id === "G1").evidence.logSecretHits.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
