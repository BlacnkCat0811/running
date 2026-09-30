import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIntervalPresentation,
  INTERVAL_RELEASE_POLICY,
  toHeuristicRange,
  type PredictionIntervalEvidence
} from "../src/index.js";

/**
 * §16.1 **I02**：「无 calibration / 域匹配 / 足够独立评估 → 不展示为 P80/P90 保证；
 * 只保留明确 heuristicRange」。
 *
 * 这条此前**一半没实现**：`heuristicRange` 这个名字在整个 src 里 **0 命中**，
 * Web 上只有一句手写文案「参考区间（非 P80/P90 保证）」在挡着。
 * 现在把"不能把规则范围当覆盖率保证"变成类型 + 运行时闸门，
 * 于是它不再依赖某个人记得别那么写。
 */
const publishable: PredictionIntervalEvidence = {
  nominalCoverage: 0.8,
  status: "empirically_evaluated",
  lowerSeconds: 1180,
  upperSeconds: 1320,
  empiricalCoverage: 0.79,
  evaluationSampleCount: INTERVAL_RELEASE_POLICY.minimumTestSamples,
  coverageConfidenceInterval: { lower: 0.71, upper: 0.86 },
  evaluationCohortHash: "cohort-1",
  calibrationVersion: "empirical-log-interval-v1",
  domainMatch: "matched",
  coverageClaim: "empirical_target_not_individual_guarantee"
};

test("I02: an uncalibrated rule range can only be shown as an explicit heuristic range", () => {
  // 老字段的选择/pessimistic 就是这么被包起来的 —— 名字里就写着"未校准"。
  const range = toHeuristicRange(1180, 1320);
  assert.equal(range.kind, "heuristic_not_calibrated");
  assert.doesNotThrow(() => assertIntervalPresentation({ kind: "heuristic", range }));
  // 全缺失也合法：不知道就说不知道，不编一个范围出来。
  assert.doesNotThrow(() => assertIntervalPresentation({ kind: "heuristic", range: toHeuristicRange(null, null) }));
});

test("I02: a heuristic range carrying coverage numbers is rejected", () => {
  // 这一条正是 §12.6 禁的事：把 optimistic/pessimistic 直接改名成 P80/P90。
  for (const leaked of [{ nominalCoverage: 0.8 }, { empiricalCoverage: 0.79 }, { coverageConfidenceInterval: { lower: 0.7, upper: 0.9 } }]) {
    assert.throws(
      () => assertIntervalPresentation({
        kind: "heuristic",
        range: { ...toHeuristicRange(1180, 1320), ...leaked } as never
      }),
      /must not carry/,
      `a heuristic range must reject ${JSON.stringify(leaked)}`
    );
  }
});

test("I02: a mislabelled heuristic range is rejected", () => {
  assert.throws(
    () => assertIntervalPresentation({ kind: "heuristic", range: { kind: "p80" as never, lowerSeconds: 1, upperSeconds: 2 } }),
    /heuristic_not_calibrated/
  );
  assert.throws(
    () => assertIntervalPresentation({ kind: "heuristic", range: toHeuristicRange(1320, 1180) }),
    /both finite and ordered/
  );
});

test("I02: calibrated bounds need the whole publication contract, not just a status string", () => {
  const ok = { kind: "calibrated" as const, evidence: publishable };
  assert.doesNotThrow(() => assertIntervalPresentation(ok));

  const cases: Array<[string, Partial<PredictionIntervalEvidence>, RegExp]> = [
    ["not evaluated", { status: "insufficient_calibration" }, /cannot be shown as a calibrated interval/],
    ["out of domain", { status: "out_of_domain" }, /cannot be shown as a calibrated interval/],
    ["domain unknown", { domainMatch: "unknown" }, /domainMatch is unknown/],
    ["domain mismatched", { domainMatch: "mismatched" }, /domainMatch is mismatched/],
    ["null bounds", { lowerSeconds: null }, /calibrated bounds cannot be null/],
    ["too few samples", { evaluationSampleCount: 3 }, /below the publication floor/],
    ["invalid samples", { evaluationSampleCount: Number.NaN }, /below the publication floor/],
    ["invalid coverage", { empiricalCoverage: Number.NaN }, /below the floor/],
    ["impossible coverage", { empiricalCoverage: 1.1 }, /below the floor/],
    ["empty cohort", { evaluationCohortHash: "" }, /must name its cohort hash/],
    ["coverage below floor", { empiricalCoverage: 0.5 }, /below the floor/],
    ["coverage missing", { empiricalCoverage: null }, /below the floor/],
    ["no cohort hash", { evaluationCohortHash: null }, /must name its cohort hash/],
    ["no calibration version", { calibrationVersion: null }, /must name its cohort hash and calibration version/]
  ];
  for (const [label, patch, expected] of cases) {
    assert.throws(
      () => assertIntervalPresentation({ kind: "calibrated", evidence: { ...publishable, ...patch } }),
      expected,
      `${label} must be refused`
    );
  }
});

test("I02: the disclaimer is required verbatim", () => {
  assert.throws(
    () => assertIntervalPresentation({
      kind: "calibrated",
      evidence: { ...publishable, coverageClaim: "guaranteed" as never }
    }),
    /disclaimer is required verbatim/
  );
});

test("I02: P90 uses its own coverage floor, not P80's", () => {
  // 0.80 对 P80 合格（floor .75），对 P90 不合格（floor .85）—— 两条下限不能混用。
  const atP80Floor = { ...publishable, nominalCoverage: 0.9 as const, empiricalCoverage: 0.80 };
  assert.throws(() => assertIntervalPresentation({ kind: "calibrated", evidence: atP80Floor }), /below the floor 0.85/);
  assert.doesNotThrow(() =>
    assertIntervalPresentation({ kind: "calibrated", evidence: { ...atP80Floor, empiricalCoverage: 0.86 } }));
});
