import assert from "node:assert/strict";
import test from "node:test";

import { assertCaWeightAblationReport } from "../src/index.js";

/**
 * §6.1 把权重消融报告列为**发布条件**："缺少上述工程报告则该权重 PR 不满足验收"。
 * 这些用例把"报告必须包含什么、以及**不许**宣称什么"钉成可执行断言。
 *
 * 背景：这份报告的工具曾经因为一行 import 被插到 `#!` 之前而完全跑不起来，
 * 而 deliverables 里那份产物是更早的快照 —— 谁都没发现。所以生成端现在先自检。
 */

/** §6.9：接受率按轴分层。至少要有课型与 comparisonStratum 两轴。 */
const acceptanceByGroup = () => ({
  "stratum:steady_aerobic": { opportunitiesPositive: 3, opportunitiesNegative: 1, acceptedPositive: 2, acceptedNegative: 0, unscorable: 0 },
  "session:easy": { opportunitiesPositive: 3, opportunitiesNegative: 1, acceptedPositive: 2, acceptedNegative: 0, unscorable: 0 }
});

const candidate = (name: string) => ({
  candidate: name,
  dimensionWeights: { efficiency: 0.375, pace: 0.3125, cardio: 0, stability: 0.1875, recovery: 0 },
  scorableRate: 1,
  refusalReasons: { applied: 1 },
  acceptanceByGroup: acceptanceByGroup(),
  currentAbility: { mean: 50, saturationRate: 0 },
  trueAbility: { meanAbsoluteDelta: 1.2 },
  acceptance: {
    positiveCandidates: 3, positiveAccepted: 2, negativeCandidates: 1, negativeAccepted: 0,
    negativeOpportunitiesToFirstAcceptance: null, firstNegativeAcceptanceAtAttempt: null
  }
});

const validReport = (overrides: Record<string, unknown> = {}) => ({
  reportVersion: "rai-ca-weight-ablation-v1",
  modelConfigVersion: "rai-model-config-v12",
  featureRunId: "feature_run_x",
  comparabilityHistoryMode: "legacy",
  featureCount: 257,
  labeledOutcomeCount: 0,
  accuracyComparison: "not_evaluable",
  accuracyComparisonReason: "no labeled race/test outcomes in this database",
  outcomes: [candidate("v1_current"), candidate("v2a"), candidate("v2b"), candidate("drop_pace"), candidate("drop_efficiency")],
  correlations: [{ left: "efficiency", right: "pace", samples: 100, pearson: 0.5, spearman: 0.4 }],
  correlationsByStratum: [{ stratum: "steady_aerobic", pairs: [] }],
  stratumCensus: [{ stratum: "steady_aerobic", workouts: 10 }],
  normalizedCorrelations: { status: "not_evaluable", reason: "stored_v3_features_have_no_normalized_signals" },
  findings: [{ candidate: "v2a", status: "never_accepted" }],
  releaseBlockers: [{ candidate: "v2a", code: "negative_learning_never_accepted", negativeOpportunities: 26 }],
  negativeGatePreregistration: { status: "not_configured", recommendation: "not_evaluable" },
  ...overrides
});

test("a report that self-certifies what it could not do passes", () => {
  assert.doesNotThrow(() => assertCaWeightAblationReport(validReport()));
});

test("F11: accuracy cannot be claimed while there are no labeled outcomes", () => {
  // §6.1-5：无标签时 A/B 精度排序必须 not_evaluable，不许拿 V1 分数当"真值"。
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ accuracyComparison: "evaluated" })),
    /accuracy cannot be claimed without labeled outcomes/
  );
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ accuracyComparison: "probably_better" })),
    /must be not_evaluable or evaluated/
  );
  // 有标签也不代表自动可以宣称已被评估 —— 状态本身仍需是合法值。
  assert.doesNotThrow(() => assertCaWeightAblationReport(validReport({
    labeledOutcomeCount: 30,
    accuracyComparison: "not_evaluable",
    accuracyComparisonReason: "behavioural ablation only; see the walk-forward report"
  })));
});

test("F11: the five required candidates are a floor, not a suggestion", () => {
  // §6.1-1：A、B、去 Pace、去 Efficiency、去 Stability。
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ outcomes: [candidate("v2a"), candidate("v2b")] })),
    /at least 5 candidates/
  );
  assert.throws(
    () => assertCaWeightAblationReport(validReport({
      outcomes: [candidate("v2a"), candidate("v2a"), candidate("b"), candidate("c"), candidate("d")]
    })),
    /duplicate candidate/
  );
});

test("an outcome without refusal attribution cannot support the §6.9-7 review", () => {
  // 没有归因就只能说"一次都没接受"，说不出卡在哪道门，也就无法"复查/放宽非必要门槛"。
  const broken = candidate("v2a") as Record<string, unknown>;
  delete broken.refusalReasons;
  const outcomes = [broken, candidate("v2b"), candidate("a"), candidate("b"), candidate("c")];
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ outcomes })),
    /refusalReasons is required/
  );
});

test("an unevaluated section must state why, instead of staying blank", () => {
  // §6.1-2 要求 raw 与 normalized **分别**报告。做不到时留空，读的人会以为"没必要做"。
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ normalizedCorrelations: { status: "not_evaluable" } })),
    /must state its reason/
  );
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ normalizedCorrelations: {} })),
    /status is required/
  );
});

test("an unfrozen pre-registration cannot recommend a threshold", () => {
  // §6.9-6 要求在评估前冻结最少机会数/可接受检测延迟/最大误判下降率。
  assert.throws(
    () => assertCaWeightAblationReport(validReport({
      negativeGatePreregistration: { status: "not_configured", recommendation: "use_reliability_0.70" }
    })),
    /cannot produce a recommendation/
  );
});

test("malformed numbers are rejected rather than reported as a plausible rate", () => {
  const outcomes = [candidate("v2a"), candidate("v2b"), candidate("a"), candidate("b"), candidate("c")];
  outcomes[0]!.scorableRate = Number.NaN as unknown as number;
  assert.throws(() => assertCaWeightAblationReport(validReport({ outcomes })), /scorableRate must be a finite number/);
  assert.throws(() => assertCaWeightAblationReport(validReport({ featureCount: -1 })), /non-negative integer/);
  assert.throws(() => assertCaWeightAblationReport(validReport({ reportVersion: "v0" })), /unsupported reportVersion/);
});

// -----------------------------------------------------------------------------
// §6.9 的分层接受率与检测延迟。
//
// 产物里本来就有这两样，但**契约没要求**：它们可以悄悄消失而没有任何检查转红。
// 而 §6.9-7 恰恰要靠"某一课型/分桶长期 0 接受"来判定，一个总分看不出来。
// -----------------------------------------------------------------------------

test("F13: acceptance must be reported per stratum and per session type, not as one total", () => {
  const withoutGroups = [candidate("v2a"), candidate("v2b"), candidate("a"), candidate("b"), candidate("c")];
  delete (withoutGroups[0] as Record<string, unknown>).acceptanceByGroup;
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ outcomes: withoutGroups })),
    /acceptanceByGroup must be an object/
  );

  // 只报一个轴等于把分层退化成总量。
  const stratumOnly = [candidate("v2a"), candidate("v2b"), candidate("a"), candidate("b"), candidate("c")];
  (stratumOnly[0] as Record<string, unknown>).acceptanceByGroup = {
    "stratum:steady_aerobic": { opportunitiesPositive: 3, opportunitiesNegative: 1, acceptedPositive: 2, acceptedNegative: 0 }
  };
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ outcomes: stratumOnly })),
    /missing the session: axis/
  );

  // 分母为 0 必须看得见是 0，而不是让这一组消失。
  const missingCounts = [candidate("v2a"), candidate("v2b"), candidate("a"), candidate("b"), candidate("c")];
  (missingCounts[0] as Record<string, unknown>).acceptanceByGroup = {
    ...acceptanceByGroup(),
    "stratum:interval": { opportunitiesPositive: 0, opportunitiesNegative: 0, acceptedPositive: 0 }
  };
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ outcomes: missingCounts })),
    /acceptedNegative must be a non-negative integer/
  );
});

test("F13: a group cannot accept more than it had opportunities for", () => {
  const outcomes = [candidate("v2a"), candidate("v2b"), candidate("a"), candidate("b"), candidate("c")];
  (outcomes[0] as Record<string, unknown>).acceptanceByGroup = {
    ...acceptanceByGroup(),
    "stratum:interval": { opportunitiesPositive: 1, opportunitiesNegative: 0, acceptedPositive: 4, acceptedNegative: 0 }
  };
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ outcomes })),
    /accepted more than it had opportunities for/
  );
});

test("F13: a negative acceptance must report how long the gate took to allow it", () => {
  // §6.9-1：报出的不能只是"接受了多少"，还要有"多久才接受"。
  const accepted = [candidate("v2a"), candidate("v2b"), candidate("a"), candidate("b"), candidate("c")];
  (accepted[0] as Record<string, unknown>).acceptance = {
    positiveCandidates: 3, positiveAccepted: 2, negativeCandidates: 5, negativeAccepted: 2,
    negativeOpportunitiesToFirstAcceptance: null, firstNegativeAcceptanceAtAttempt: null
  };
  assert.throws(
    () => assertCaWeightAblationReport(validReport({ outcomes: accepted })),
    /must report its detection latency/
  );

  // 没有负向接受时 null 是对的：确实没有"首次"，不该为了好看编一个数。
  const neverAccepted = [candidate("v2a"), candidate("v2b"), candidate("a"), candidate("b"), candidate("c")];
  (neverAccepted[0] as Record<string, unknown>).acceptance = {
    positiveCandidates: 3, positiveAccepted: 2, negativeCandidates: 5, negativeAccepted: 0,
    negativeOpportunitiesToFirstAcceptance: null, firstNegativeAcceptanceAtAttempt: null
  };
  assert.doesNotThrow(() => assertCaWeightAblationReport(validReport({ outcomes: neverAccepted })));
});
