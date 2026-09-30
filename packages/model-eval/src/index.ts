import { canonicalSemanticJson, type RaceDistance } from "@rai/contracts";

export const MODEL_EVAL_VERSION = "rai-model-eval-v1" as const;

// -----------------------------------------------------------------------------
// §5.5 / P02 环境责任账本：阻止**同一历史环境被去偏差两次**
//
// §5.5 允许"过去热天去偏差 + 未来热天加情景"，因为那是两个**不同对象**；
// 它禁止的是"同一历史热惩罚被 adapter 与 performanceVdotEvidence 各去一次"。
//
// 实测（2026-09-30）：现行账本已经能验证 `after−before` 逐项重建最终结果
// （`prediction-report.ts` 里的 "Prediction correction ledger mismatch"），
// 但它**不记录每一步作用于什么证据**。于是最危险的那种重复恰恰漏网：
// 若 adapter 把热惩罚折进 `potentialSeconds`（账本起点之前），
// 链式重建照样成立、断言照样通过，而惩罚已经扣了两次。
//
// 所以这里补两件事：每一步声明 `object`（作用于哪个对象）与 `inputHash`（去的是哪份证据），
// 然后断言两条规则 —— 见 `assertPredictionCorrectionLedger`。
// -----------------------------------------------------------------------------

/** 一步修正作用于哪个对象。`null` 表示该 kind 不区分对象。 */
export type CorrectionObject = "historical_evidence" | "target_scenario" | null;

export interface PredictionCorrectionStep {
  kind: "preparation" | "durability" | "environment" | "elevation" | "acute_readiness" | "catboost";
  object: CorrectionObject;
  /** 是谁做的这一步。同一步责任重复出现时，owner 会不同 —— 那正是要抓的形状。 */
  ownerVersion: string;
  /** 这一步去的是哪份证据。同一份证据被两个 owner 各去一次 ⇒ 违规。 */
  inputHash: string | null;
  applied: boolean;
  beforeSeconds: number;
  afterSeconds: number;
  reasonCodes: string[];
}

export interface PredictionCorrectionLedger {
  distance: RaceDistance;
  potentialSeconds: number;
  predictedSeconds: number;
  steps: readonly PredictionCorrectionStep[];
}

/**
 * §11.6 的 `after−before` 重建 + §5.5 的"一次修正一项责任"。
 *
 * 规则：
 * 1. **重建**：把 `applied` 的步骤按序叠加到 `potentialSeconds`，必须精确得到 `predictedSeconds`。
 * 2. **不重复责任**：同一 `(kind, object, inputHash)` 至多一个 `applied: true`。
 * 3. **历史去偏差不得出现在潜在能力之后**：`potentialSeconds` 的定义就是"历史证据已归一化之后"的
 *    中性能力，所以 `object = historical_evidence` 的步骤出现在这条链上，意味着历史惩罚
 *    已经被上游扣过一次 —— 这正是 §5.5 禁止的重复。它必须记为 `applied: false` 的说明性记录。
 */
export function assertPredictionCorrectionLedger(ledger: PredictionCorrectionLedger): void {
  const where = `correction ledger (${ledger.distance})`;
  if (!Number.isFinite(ledger.potentialSeconds) || !Number.isFinite(ledger.predictedSeconds)) {
    throw new Error(`${where}: potentialSeconds and predictedSeconds must be finite`);
  }

  // 规则 1：重建。
  let reconstructed = ledger.potentialSeconds;
  for (const step of ledger.steps) {
    if (!Number.isFinite(step.beforeSeconds) || !Number.isFinite(step.afterSeconds)) {
      throw new Error(`${where}: step ${step.kind} has a non-finite boundary`);
    }
    if (step.applied) reconstructed += step.afterSeconds - step.beforeSeconds;
  }
  if (Math.abs(reconstructed - ledger.predictedSeconds) > 1e-6) {
    throw new Error(
      `${where}: applied steps rebuild ${reconstructed} but predictedSeconds is ${ledger.predictedSeconds}`
    );
  }
  // 每个 applied 步骤自己的 before/after 也必须自洽，否则"重建"可能靠两个错误互相抵消。
  for (const step of ledger.steps) {
    if (step.applied && step.afterSeconds - step.beforeSeconds === 0 && step.reasonCodes.length === 0) {
      throw new Error(`${where}: applied step ${step.kind} changes nothing and gives no reason`);
    }
  }

  // 规则 2：同一份证据、同一个对象，至多被去一次。
  const seen = new Map<string, string>();
  for (const step of ledger.steps) {
    if (!step.applied) continue;
    const key = `${step.kind}|${step.object ?? "-"}|${step.inputHash ?? "-"}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new Error(
        `${where}: ${step.kind} on ${step.object ?? "-"} already applied by ${previous}, ` +
          `now again by ${step.ownerVersion} (§5.5 一次修正一项责任)`
      );
    }
    seen.set(key, step.ownerVersion);
  }

  // 规则 3：历史去偏差不能出现在潜在能力之后的链上。
  for (const step of ledger.steps) {
    if (step.applied && step.object === "historical_evidence") {
      throw new Error(
        `${where}: step ${step.kind} de-biases historical evidence after potentialSeconds was formed ` +
          `(owner ${step.ownerVersion}). potentialSeconds is by definition post-normalisation; ` +
          `applying it here means the same historical penalty was removed twice (§5.5)`
      );
    }
  }

  // 规则 4（§8.2 / §8.5 D3 / P04）：Preparation 与 Durability 是**两个不同职责**，
  // 但它们不能吃同一份证据。若 durability 声明了与 preparation 相同的 inputHash，
  // 说明它不是"后段表现是否维持"的独立证据，而是把同一份训练暴露又罚了一次 ——
  // 那正是本方案要求"合并/替换对应项，而不是继续叠加 penalty"的形状。
  const preparationEvidence = new Map<string, string>();
  for (const step of ledger.steps) {
    if (step.applied && step.kind === "preparation" && step.inputHash !== null) {
      preparationEvidence.set(step.inputHash, step.ownerVersion);
    }
  }
  for (const step of ledger.steps) {
    if (!step.applied || step.kind !== "durability" || step.inputHash === null) continue;
    const preparationOwner = preparationEvidence.get(step.inputHash);
    if (preparationOwner !== undefined) {
      throw new Error(
        `${where}: durability step (owner ${step.ownerVersion}) consumes the same evidence as the ` +
          `preparation step (owner ${preparationOwner}); that penalises one piece of training exposure twice. ` +
          `Durability must bring independent post-fatigue performance evidence, or the two must be merged (§8.2)`
      );
    }
  }
}

export interface EvaluationCase {
  eventId: string;
  distance: RaceDistance;
  predictedAt: string;
  outcomeAt: string;
  availableAt: string;
  actualSeconds: number;
  predictedSeconds: number;
}

function instant(value: string): number {
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid instant: ${value}`);
  return n;
}

export function validateCases(cases: readonly EvaluationCase[], asOf: string): void {
  const seen = new Set<string>();
  const outcomes = new Set<string>();
  const cutoff = instant(asOf);
  for (const row of cases) {
    if (!row.eventId || seen.has(row.eventId)) throw new Error("Events must have unique nonempty identities");
    seen.add(row.eventId);
    const outcomeKey = `${row.distance}:${instant(row.outcomeAt)}`;
    if (outcomes.has(outcomeKey)) throw new Error("Duplicate outcome event under different sample identities");
    outcomes.add(outcomeKey);
    if (!["five_k", "ten_k", "half_marathon"].includes(row.distance)) throw new Error("Unsupported distance");
    if (![row.actualSeconds, row.predictedSeconds].every((n) => Number.isFinite(n) && n > 0)) {
      throw new Error("Evaluation seconds must be finite and positive");
    }
    if (instant(row.predictedAt) >= instant(row.outcomeAt) ||
        instant(row.availableAt) < instant(row.outcomeAt) || instant(row.availableAt) > cutoff) {
      throw new Error("Outcome timing violates as-of evaluation");
    }
  }
}

export function predictionMetrics(cases: readonly EvaluationCase[], asOf: string) {
  validateCases(cases, asOf);
  if (!cases.length) return { sampleCount: 0, mae: null, mape: null, bias: null, medianAbsoluteError: null };
  const errors = cases.map((row) => row.predictedSeconds - row.actualSeconds);
  const absolute = errors.map(Math.abs).sort((a, b) => a - b);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    sampleCount: cases.length,
    mae: sum(absolute) / cases.length,
    mape: sum(errors.map((error, i) => Math.abs(error) / cases[i]!.actualSeconds)) / cases.length,
    bias: sum(errors) / cases.length,
    medianAbsoluteError: quantile(absolute, 0.5)
  };
}

export function assertIndependentTemporalPartitions(input: {
  trainingEventIds: readonly string[];
  trainingLabelsAvailableThrough: string;
  calibration: readonly EvaluationCase[];
  test: readonly EvaluationCase[];
  asOf: string;
  embargoHours: number;
}): void {
  validateCases(input.calibration, input.asOf);
  validateCases(input.test, input.asOf);
  if (!Number.isFinite(input.embargoHours) || input.embargoHours < 0) throw new Error("Invalid embargo");
  const all = [...input.trainingEventIds, ...input.calibration.map((x) => x.eventId), ...input.test.map((x) => x.eventId)];
  if (all.some((id) => !id) || new Set(all).size !== all.length) throw new Error("Partition event overlap");
  const trainThrough = instant(input.trainingLabelsAvailableThrough);
  const embargoMs = input.embargoHours * 3_600_000;
  if (trainThrough > instant(input.asOf)) throw new Error("Training labels are in the future");
  if (input.calibration.some((row) => instant(row.predictedAt) <= trainThrough + embargoMs)) {
    throw new Error("Calibration predictions precede the training/embargo boundary");
  }
  const calibrationThrough = Math.max(trainThrough, ...input.calibration.map((row) => instant(row.availableAt)));
  if (input.test.some((row) => instant(row.predictedAt) <= calibrationThrough + embargoMs)) {
    throw new Error("Test predictions precede the calibration/embargo boundary");
  }
}

function quantile(sorted: readonly number[], p: number): number {
  if (!sorted.length) throw new Error("Quantile requires observations");
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  return sorted[lo]! + (sorted[Math.ceil(at)]! - sorted[lo]!) * (at - lo);
}

export interface IntervalPolicy {
  minimumCalibrationSamples: number;
  minimumTestSamples: number;
  minimumCoverage: { p80: number; p90: number };
  maximumMeanRelativeWidth: number;
}

/** Initial engineering publication floor, not a physiological guarantee or fitted optimum. */
export const INTERVAL_RELEASE_POLICY: IntervalPolicy = {
  minimumCalibrationSamples:24, minimumTestSamples:24,
  minimumCoverage:{p80:0.75,p90:0.85}, maximumMeanRelativeWidth:0.5
};

export function assertIntervalPublicationPolicy(policy:IntervalPolicy):void {
  if(!policy || policy.minimumCalibrationSamples<INTERVAL_RELEASE_POLICY.minimumCalibrationSamples ||
    policy.minimumTestSamples<INTERVAL_RELEASE_POLICY.minimumTestSamples ||
    policy.minimumCoverage.p80<INTERVAL_RELEASE_POLICY.minimumCoverage.p80 ||
    policy.minimumCoverage.p90<INTERVAL_RELEASE_POLICY.minimumCoverage.p90 ||
    policy.maximumMeanRelativeWidth>INTERVAL_RELEASE_POLICY.maximumMeanRelativeWidth) {
    throw new Error("Interval policy is weaker than the versioned publication floor");
  }
}

export interface IntervalArtifact {
  version: "empirical-log-interval-v1";
  predictorVersion: string;
  distance: RaceDistance;
  policy: IntervalPolicy;
  calibrationEventIds: string[];
  calibrationAvailableThrough: string;
  quantiles: { q05: number; q10: number; q50: number; q90: number; q95: number };
  /** Canonical payload for the I/O owner to hash and persist. No fake cohort hash. */
  cohortDescriptor: string;
}

/** A recorded cohort, not a version label, is the authority for calibration coefficients. */
export function validateIntervalArtifact(artifact: IntervalArtifact): void {
  if (artifact.version !== "empirical-log-interval-v1" || typeof artifact.cohortDescriptor !== "string") {
    throw new Error("Unsupported interval artifact");
  }
  const source = JSON.parse(artifact.cohortDescriptor) as {
    predictorVersion: string; policy: IntervalPolicy; cases: EvaluationCase[];
  };
  if (!Array.isArray(source.cases)) throw new Error("Interval artifact cohort is missing");
  const reconstructed = fitEmpiricalIntervals({
    predictorVersion: source.predictorVersion, distance: artifact.distance,
    policy: source.policy, calibration: source.cases, asOf: artifact.calibrationAvailableThrough
  });
  if (reconstructed === null || canonicalSemanticJson(reconstructed) !== canonicalSemanticJson(artifact)) {
    throw new Error("Interval artifact differs from its calibration evidence");
  }
}

export function fitEmpiricalIntervals(input: {
  predictorVersion: string; distance: RaceDistance;
  calibration: readonly EvaluationCase[]; asOf: string; policy: IntervalPolicy;
}): IntervalArtifact | null {
  validateCases(input.calibration, input.asOf);
  const p = input.policy;
  if (!input.predictorVersion || ![p.minimumCalibrationSamples, p.minimumTestSamples]
    .every((n) => Number.isInteger(n) && n >= 2) ||
    !Object.values(p.minimumCoverage).every((n) => Number.isFinite(n) && n > 0 && n <= 1) ||
    !Number.isFinite(p.maximumMeanRelativeWidth) || p.maximumMeanRelativeWidth <= 0) {
    throw new Error("Invalid preregistered interval policy");
  }
  if (input.calibration.some((row) => row.distance !== input.distance)) throw new Error("Mixed-distance calibration");
  if (input.calibration.length < p.minimumCalibrationSamples) return null;
  const residuals = input.calibration.map((row) => Math.log(row.actualSeconds / row.predictedSeconds)).sort((a, b) => a - b);
  const rows = [...input.calibration].sort((a, b) => a.eventId.localeCompare(b.eventId));
  return {
    version: "empirical-log-interval-v1", predictorVersion: input.predictorVersion,
    distance: input.distance, policy: { ...p, minimumCoverage: { ...p.minimumCoverage } },
    calibrationEventIds: rows.map((row) => row.eventId),
    calibrationAvailableThrough: new Date(Math.max(...rows.map((row) => instant(row.availableAt)))).toISOString(),
    quantiles: {
      q05: quantile(residuals, 0.05), q10: quantile(residuals, 0.1), q50: quantile(residuals, 0.5),
      q90: quantile(residuals, 0.9), q95: quantile(residuals, 0.95)
    },
    cohortDescriptor: canonicalSemanticJson({ predictorVersion: input.predictorVersion, policy: p, cases: rows })
  };
}

export function empiricalIntervalBounds(artifact: IntervalArtifact, pointSeconds: number) {
  if (!Number.isFinite(pointSeconds) || pointSeconds <= 0) throw new Error("Invalid point prediction");
  const q = artifact.quantiles;
  const ordered = [q.q05, q.q10, q.q50, q.q90, q.q95];
  if (ordered.some((n, i) => !Number.isFinite(n) || (i > 0 && n < ordered[i - 1]!))) {
    throw new Error("Invalid interval quantiles");
  }
  const scale = (n: number) => pointSeconds * Math.exp(n);
  const values = ordered.map(scale);
  if (values.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error("Non-finite interval");
  return {
    p50Seconds: values[2]!,
    p80: { lowerSeconds: values[1]!, upperSeconds: values[3]! },
    p90: { lowerSeconds: values[0]!, upperSeconds: values[4]! }
  };
}

export function evaluateIntervalArtifact(artifact: IntervalArtifact, test: readonly EvaluationCase[], asOf: string) {
  validateIntervalArtifact(artifact);
  validateCases(test, asOf);
  const calibrationIds = new Set(artifact.calibrationEventIds);
  if (test.some((row) => calibrationIds.has(row.eventId) || row.distance !== artifact.distance ||
      instant(row.predictedAt) <= instant(artifact.calibrationAvailableThrough))) {
    throw new Error("Interval test overlaps calibration, predates it, or targets another distance");
  }
  const insufficient = test.length < artifact.policy.minimumTestSamples;
  const evidence = (nominal: 0.8 | 0.9) => {
    let covered = 0, width = 0, score = 0;
    const coverageEvents:number[]=[];
    const chronological=[...test].sort((a,b)=>instant(a.predictedAt)-instant(b.predictedAt)||a.eventId.localeCompare(b.eventId));
    for (const row of chronological) {
      const bounds = empiricalIntervalBounds(artifact, row.predictedSeconds)[nominal === 0.8 ? "p80" : "p90"];
      const { lowerSeconds: lower, upperSeconds: upper } = bounds;
      const hit=lower <= row.actualSeconds && row.actualSeconds <= upper;
      if (hit) covered++;
      coverageEvents.push(Number(hit));
      width += (upper - lower) / row.predictedSeconds;
      score += upper - lower + (2 / (1 - nominal)) *
        (Math.max(0, lower - row.actualSeconds) + Math.max(0, row.actualSeconds - upper));
    }
    return {
      nominalCoverage: nominal,
      evaluationSampleCount: test.length,
      empiricalCoverage: test.length ? covered / test.length : null,
      meanRelativeWidth: test.length ? width / test.length : null,
      meanIntervalScoreSeconds: test.length ? score / test.length : null,
      coverageConfidenceInterval: coverageBootstrap(coverageEvents),
      coverageClaim: "empirical_target_not_individual_guarantee" as const
    };
  };
  const p80 = evidence(0.8), p90 = evidence(0.9);
  const passed = !insufficient && p80.empiricalCoverage! >= artifact.policy.minimumCoverage.p80 &&
    p90.empiricalCoverage! >= artifact.policy.minimumCoverage.p90 &&
    p90.meanRelativeWidth! <= artifact.policy.maximumMeanRelativeWidth;
  return { status: insufficient ? "not_evaluable" as const : passed ? "passed" as const : "failed" as const,
    blocksPublication: !passed, p80, p90 };
}

/** Temporal block diagnostic, not an IID or individual-outcome coverage guarantee. */
function coverageBootstrap(covered:readonly number[]) {
  const blocks:number[][]=[];
  for(let i=0;i<covered.length;i+=3)blocks.push(covered.slice(i,i+3));
  if(blocks.length<6)return null;
  let seed=20260929;
  const rates:number[]=[];
  for(let iteration=0;iteration<2000;iteration++){
    let hits=0,count=0;
    for(let i=0;i<blocks.length;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const block=blocks[Math.floor(seed/4294967296*blocks.length)]!;
      hits+=block.reduce((a,b)=>a+b,0);count+=block.length;
    }
    rates.push(hits/count);
  }
  rates.sort((a,b)=>a-b);
  return {lower:quantile(rates,0.025),upper:quantile(rates,0.975),
    method:"temporal_event_block_bootstrap_diagnostic" as const,blockEvents:3,effectiveBlocks:blocks.length,iterations:2000};
}

export function compareResidualChallengers(input: {
  baseline: readonly EvaluationCase[]; ridge: readonly EvaluationCase[]; catboost: readonly EvaluationCase[];
  asOf: string; minimumSamples: number; minimumImprovement: number; maximumDistanceRegression: number;
}) {
  for (const values of [input.baseline, input.ridge, input.catboost]) validateCases(values, input.asOf);
  if (!Number.isInteger(input.minimumSamples) || input.minimumSamples < 1 ||
      ![input.minimumImprovement, input.maximumDistanceRegression].every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) {
    throw new Error("Invalid challenger policy");
  }
  // Missing challenger is not an infinite-error baseline and cannot win by absence.
  if (!input.baseline.length || !input.ridge.length || !input.catboost.length) {
    return { status: "not_evaluable" as const, blocksActivation: true, reasonCodes: ["missing_challenger_predictions"] };
  }
  const reference = new Map(input.baseline.map((row) => [row.eventId, row]));
  for (const values of [input.ridge, input.catboost]) {
    if (values.length !== reference.size || values.some((row) => {
      const base = reference.get(row.eventId);
      return !base || base.actualSeconds !== row.actualSeconds || base.distance !== row.distance ||
        instant(base.predictedAt) !== instant(row.predictedAt) ||
        instant(base.outcomeAt) !== instant(row.outcomeAt) ||
        instant(base.availableAt) !== instant(row.availableAt);
    })) throw new Error("Challengers must use exactly the same cases and prediction times");
  }
  const groups: Array<RaceDistance | null> = [null, "five_k", "ten_k", "half_marathon"];
  const failures: string[] = [];
  let enough = true;
  const metrics = groups.map((distance) => {
    const select = (rows: readonly EvaluationCase[]) => rows.filter((x) => distance === null || x.distance === distance);
    const baseline = predictionMetrics(select(input.baseline), input.asOf);
    const ridge = predictionMetrics(select(input.ridge), input.asOf);
    const catboost = predictionMetrics(select(input.catboost), input.asOf);
    if (baseline.sampleCount < input.minimumSamples) enough = false;
    if (catboost.mae !== null) {
      for (const [name, other] of [["baseline", baseline], ["ridge", ridge]] as const) {
        if (other.mae === null) continue;
        const limit = distance === null ? 1 - input.minimumImprovement : 1 + input.maximumDistanceRegression;
        if (catboost.mae > other.mae * limit || (distance === null && catboost.mae >= other.mae)) {
          failures.push(`${distance ?? "overall"}_not_better_than_${name}`);
        }
      }
    }
    return { distance, baseline, ridge, catboost };
  });
  return {
    status: !enough ? "not_evaluable" as const : failures.length ? "failed" as const : "passed" as const,
    blocksActivation: !enough || failures.length > 0,
    reasonCodes: [...(!enough ? ["insufficient_samples_per_distance"] : []), ...failures],
    metrics
  };
}

export * from "./replay.js";

// -----------------------------------------------------------------------------
// §6.9-7：负向学习的发布阻断判据
//
// 文档对这个风险的措辞是"**有充分合格负机会却长期 0 接受**，必须阻止该门控版本发布并复查"，
// 并明确"不能用'更保守'作为永久解释"。
//
// 这里刻意**不引入任何"负接受率必须大于 X%"的阈值**：§6.9-6 说得很清楚 ——
// 分布还未知时不要捏造一个全局门槛。所以判据只用文档自己的措辞：
// **机会数 > 0 且接受数 = 0**。可见性上也不把"没有机会"当成"通过"：
// 没有机会是一种独立状态，报告必须能把它与"有机会但从不接受"区分开。
// -----------------------------------------------------------------------------

export interface NegativeLearningCensusEntry {
  candidate: string;
  negativeOpportunities: number;
  negativeAccepted: number;
}

export type NegativeLearningStatus = "no_opportunity" | "never_accepted" | "accepted";

export interface NegativeLearningFinding {
  candidate: string;
  status: NegativeLearningStatus;
  negativeOpportunities: number;
  negativeAccepted: number;
}

export interface NegativeLearningReleaseBlocker {
  candidate: string;
  code: "negative_learning_never_accepted";
  negativeOpportunities: number;
}

/**
 * 逐候选举报负向学习状态，并把"有机会却从不接受"的候选列为发布阻断项。
 * 抛错优先于猜测：负数的机会数说明上游统计已经坏了。
 */
export function negativeLearningReleaseBlockers(
  candidates: readonly NegativeLearningCensusEntry[]
): { findings: NegativeLearningFinding[]; releaseBlockers: NegativeLearningReleaseBlocker[] } {
  const findings: NegativeLearningFinding[] = [];
  const releaseBlockers: NegativeLearningReleaseBlocker[] = [];
  for (const entry of candidates) {
    if (!entry.candidate) throw new Error("negative learning census requires a candidate name");
    for (const [name, value] of [["negativeOpportunities", entry.negativeOpportunities], ["negativeAccepted", entry.negativeAccepted]] as const) {
      if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    }
    if (entry.negativeAccepted > entry.negativeOpportunities) {
      throw new Error("accepted negatives cannot exceed negative opportunities");
    }
    const status: NegativeLearningStatus =
      entry.negativeOpportunities === 0 ? "no_opportunity"
        : entry.negativeAccepted === 0 ? "never_accepted"
          : "accepted";
    findings.push({
      candidate: entry.candidate,
      status,
      negativeOpportunities: entry.negativeOpportunities,
      negativeAccepted: entry.negativeAccepted
    });
    if (status === "never_accepted") {
      releaseBlockers.push({
        candidate: entry.candidate,
        code: "negative_learning_never_accepted",
        negativeOpportunities: entry.negativeOpportunities
      });
    }
  }
  return { findings, releaseBlockers };
}

// -----------------------------------------------------------------------------
// §6.1：CA 权重消融报告的**发布条件**校验
//
// §6.1 说这份报告"不能留成可选 TODO —— 缺少上述工程报告则该权重 PR 不满足验收"。
// 但"必须包含什么"此前只写在文档里，评审时靠人记；而这份报告的工具确实曾经
// 因为一行 import 被插到 `#!` 之前而**完全跑不起来**，谁都没发现。
//
// 所以把要求写成可执行校验：
//  - 报告必须自证**哪些做不到**（normalized 相关性、精度排名），而不是留空；
//  - 无标签时精度排名只能是 `not_evaluable`（§6.1-5：不拿 V1 分数当"真值"）；
//  - 预注册未冻结时不得给出"该用哪个阈值"的结论（§6.9-6）。
// -----------------------------------------------------------------------------

const ABLATION_REPORT_VERSION = "rai-ca-weight-ablation-v1";

// -----------------------------------------------------------------------------
// §15.8 统一报告 envelope
//
// §15.8 规定"每个版本比较产物至少包括"八项。实测（2026-09-30）：只有最新那份
// （跨版本回放）带得起全部信息 —— `repoRevision` 只在三份里有、`reproduce` 只有一份有、
// gate 状态只有一份有、`notEvaluable` 只有一份有。也就是 §15.8 此前是**约定**而不是**条件**：
// 一份产物可以把溯源信息整个丢掉，而没有任何检查会转红。
//
// 这里把它变成可执行条件。刻意只要求**机器可核对**的那几项：版本矩阵、cohort 定义、
// 差异分布的形状因领域而异（Fitness 比 CA/TA，Readiness 比裁决，预测比秒数），
// 强行统一只会逼出空字段。所以分两层：
//
//   必需（本函数检查）：谁生成的、描述哪份库、哪个提交、怎么复现、gate 三态、未评估项及原因
//   领域自有（不检查）：指标本身的形状
// -----------------------------------------------------------------------------

export const EVALUATION_REPORT_ENVELOPE_VERSION = "rai-eval-report-envelope-v1" as const;

/** §15.8-6：每个 gate 只有这三种状态；"未评估"是正式状态，不是自动通过或失败。 */
export type EvaluationGateStatus = "passed" | "failed" | "not_evaluable";

export interface EvaluationGate {
  name: string;
  status: EvaluationGateStatus;
  /** status 为 not_evaluable 时必须说明为什么评估不了。 */
  reason?: string | null;
}

/** 组装 §15.8 要求的公共部分。生成端调它而不是各自手写 —— 手写正是漂移的来源。 */
export function evaluationReportEnvelope(input: {
  generatedBy: string;
  databasePath: string;
  repoRevision: string | null;
  reproduceCommand: string;
  accuracyStatus: EvaluationGateStatus;
  accuracyReason: string | null;
  gates?: readonly EvaluationGate[];
  notEvaluable?: ReadonlyArray<{ item: string; reason: string }>;
  generatedAt?: string;
}) {
  return {
    envelopeVersion: EVALUATION_REPORT_ENVELOPE_VERSION,
    generatedBy: input.generatedBy,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    databasePath: input.databasePath,
    repoRevision: input.repoRevision,
    reproduceCommand: input.reproduceCommand,
    accuracyStatus: input.accuracyStatus,
    accuracyReason: input.accuracyReason,
    gates: [...(input.gates ?? [])],
    notEvaluable: [...(input.notEvaluable ?? [])]
  };
}

function asEnvelopeRecord(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Evaluation report: ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireEnvelopeText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Evaluation report: ${name} is required (§15.8)`);
  }
  return value;
}

/**
 * §15.8 公共部分校验。领域专属指标不在这里检查 —— 见上面的说明。
 *
 * `repoRevision` 允许为 null（例如在非 git 目录下生成），但**必须显式出现**：
 * "少一个键"与"当时确实不知道"是两件事，前者是漏写，后者是事实。
 */
export function assertUnifiedEvaluationReport(report: unknown): void {
  const root = asEnvelopeRecord("report", report);
  if (root.envelopeVersion !== EVALUATION_REPORT_ENVELOPE_VERSION) {
    throw new Error(`Evaluation report: unsupported envelopeVersion ${String(root.envelopeVersion)}`);
  }
  // §15.8-1：谁生成的、描述哪份库、哪个提交。
  requireEnvelopeText("generatedBy", root.generatedBy);
  requireEnvelopeText("generatedAt", root.generatedAt);
  requireEnvelopeText("databasePath", root.databasePath);
  if (root.repoRevision !== null) requireEnvelopeText("repoRevision", root.repoRevision);
  // §15.8-8：复现命令。没有它，产物只能被相信，不能被核对。
  requireEnvelopeText("reproduceCommand", root.reproduceCommand);

  // §15.8-7：发布建议。"未评估"是正式状态，必须能表达，且不得含糊。
  const accuracy = root.accuracyStatus;
  if (accuracy !== "passed" && accuracy !== "failed" && accuracy !== "not_evaluable") {
    throw new Error("Evaluation report: accuracyStatus must be passed, failed or not_evaluable (§15.8-7)");
  }
  if (accuracy === "not_evaluable") {
    requireEnvelopeText("accuracyReason", root.accuracyReason);
  } else if (root.accuracyReason !== null && typeof root.accuracyReason !== "string") {
    throw new Error("Evaluation report: accuracyReason must be a string or null");
  }

  // §15.8-6：每个 gate 的 passed/failed/not_evaluable 状态。
  if (!Array.isArray(root.gates)) throw new Error("Evaluation report: gates must be an array (§15.8-6)");
  for (const entry of root.gates) {
    const gate = asEnvelopeRecord("gate", entry);
    const name = requireEnvelopeText("gate.name", gate.name);
    if (gate.status !== "passed" && gate.status !== "failed" && gate.status !== "not_evaluable") {
      throw new Error(`Evaluation report: gate ${name} status must be passed, failed or not_evaluable`);
    }
    // 一个"未评估"的 gate 不写原因，读的人会以为它没必要评估。
    if (gate.status === "not_evaluable") requireEnvelopeText(`gate ${name} reason`, gate.reason);
  }

  // §15.8-5：统计不可用项及原因。
  if (!Array.isArray(root.notEvaluable)) {
    throw new Error("Evaluation report: notEvaluable must be an array (§15.8-5)");
  }
  for (const entry of root.notEvaluable) {
    const item = asEnvelopeRecord("notEvaluable entry", entry);
    requireEnvelopeText("notEvaluable.item", item.item);
    requireEnvelopeText("notEvaluable.reason", item.reason);
  }
}

/** §6.1 要求比较的候选数下限：A、B、去 Pace、去 Efficiency、去 Stability（外加旧对照）。 */
const MINIMUM_ABLATION_CANDIDATES = 5;

function assertFiniteOrNull(name: string, value: unknown): void {
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Ablation report: ${name} must be a finite number or null`);
  }
}

function assertCount(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Ablation report: ${name} must be a non-negative integer`);
  }
}

function asRecord(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Ablation report: ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertCaWeightAblationReport(report: unknown): void {
  const root = asRecord("report", report);
  if (root.reportVersion !== ABLATION_REPORT_VERSION) {
    throw new Error(`Ablation report: unsupported reportVersion ${String(root.reportVersion)}`);
  }
  for (const key of ["modelConfigVersion", "featureRunId", "comparabilityHistoryMode"] as const) {
    if (typeof root[key] !== "string" || root[key] === "") {
      throw new Error(`Ablation report: ${key} is required`);
    }
  }
  if (root.comparabilityHistoryMode !== "legacy" && root.comparabilityHistoryMode !== "bounded") {
    throw new Error("Ablation report: comparabilityHistoryMode must be legacy or bounded");
  }
  assertCount("featureCount", root.featureCount);
  assertCount("labeledOutcomeCount", root.labeledOutcomeCount);

  // 精度排名：无标签时必须明确不可评估。把"没有标签"写成别的值，
  // 就等于在没有任何外部结果的情况下给出精度结论。
  if (root.accuracyComparison !== "not_evaluable" && root.accuracyComparison !== "evaluated") {
    throw new Error("Ablation report: accuracyComparison must be not_evaluable or evaluated");
  }
  if (root.labeledOutcomeCount === 0 && root.accuracyComparison !== "not_evaluable") {
    throw new Error("Ablation report: accuracy cannot be claimed without labeled outcomes");
  }
  if (typeof root.accuracyComparisonReason !== "string" || root.accuracyComparisonReason === "") {
    throw new Error("Ablation report: accuracyComparisonReason is required");
  }

  if (!Array.isArray(root.outcomes) || root.outcomes.length < MINIMUM_ABLATION_CANDIDATES) {
    throw new Error(`Ablation report: at least ${MINIMUM_ABLATION_CANDIDATES} candidates must be compared`);
  }
  const candidates = new Set<string>();
  for (const entry of root.outcomes) {
    const outcome = asRecord("outcome", entry);
    if (typeof outcome.candidate !== "string" || outcome.candidate === "") {
      throw new Error("Ablation report: every candidate needs a name");
    }
    if (candidates.has(outcome.candidate)) {
      throw new Error(`Ablation report: duplicate candidate ${outcome.candidate}`);
    }
    candidates.add(outcome.candidate);
    asRecord("outcome.dimensionWeights", outcome.dimensionWeights);
    // §6.1-3：既要数值差异，也要 coverage —— 缺一个就无法判断"是不是靠丢样本变好的"。
    assertFiniteOrNull("outcome.scorableRate", outcome.scorableRate);
    const ability = asRecord("outcome.currentAbility", outcome.currentAbility);
    assertFiniteOrNull("outcome.currentAbility.saturationRate", ability.saturationRate);
    const trueAbility = asRecord("outcome.trueAbility", outcome.trueAbility);
    assertFiniteOrNull("outcome.trueAbility.meanAbsoluteDelta", trueAbility.meanAbsoluteDelta);
    const acceptance = asRecord("outcome.acceptance", outcome.acceptance);
    for (const key of ["positiveCandidates", "positiveAccepted", "negativeCandidates", "negativeAccepted"] as const) {
      assertCount(`outcome.acceptance.${key}`, acceptance[key]);
    }
    // §6.9-7 的复查前提：报告必须能说出卡在哪道门。
    if (typeof outcome.refusalReasons !== "object" || outcome.refusalReasons === null) {
      throw new Error("Ablation report: outcome.refusalReasons is required");
    }
    // §6.9：接受率必须**分层**报告（课型 / comparisonStratum / normalization.status /
    // 环境覆盖 / 设备来源）。一个总分会让"只在某一课型里 0 接受"看不出来，
    // 而那正是 §6.9-7 要复査的情形。
    const byGroup = asRecord("outcome.acceptanceByGroup", outcome.acceptanceByGroup);
    const groupKeys = Object.keys(byGroup);
    if (groupKeys.length === 0) {
      throw new Error("Ablation report: outcome.acceptanceByGroup must not be empty (§6.9)");
    }
    // 轴必须存在，而不是"这次碰巧有一组"。至少要有课型与 comparisonStratum 两轴 ——
    // 只报一个轴等于把分层退化成总量。
    for (const axis of ["session:", "stratum:"] as const) {
      if (!groupKeys.some((key) => key.startsWith(axis))) {
        throw new Error(`Ablation report: outcome.acceptanceByGroup is missing the ${axis} axis (§6.9)`);
      }
    }
    for (const [key, value] of Object.entries(byGroup)) {
      const group = asRecord(`outcome.acceptanceByGroup.${key}`, value);
      // 机会数与接受数都要在，才能算出率；分母为 0 时必须**看得见**是 0，
      // 而不是让这一组消失（§6.9："分母为 0 则该率=null，并报告 0 次机会"）。
      for (const field of ["opportunitiesPositive", "opportunitiesNegative", "acceptedPositive", "acceptedNegative"] as const) {
        assertCount(`outcome.acceptanceByGroup.${key}.${field}`, group[field]);
      }
      if ((group.acceptedPositive as number) > (group.opportunitiesPositive as number) ||
          (group.acceptedNegative as number) > (group.opportunitiesNegative as number)) {
        throw new Error(`Ablation report: ${key} accepted more than it had opportunities for`);
      }
    }
    // §6.9-1：必须能报出**首次有效负学习**所需的训练次数。没有负向接受时 null 是对的
    // （确实没有"首次"），但一旦接受过，延迟就必须存在 —— 否则"接受了多少"与
    // "多久才接受"会被拆开，而后者才是 §6.9-7 判检测延迟的依据。
    const latency = acceptance.negativeOpportunitiesToFirstAcceptance;
    const firstAt = acceptance.firstNegativeAcceptanceAtAttempt;
    if (latency !== null) assertCount("outcome.acceptance.negativeOpportunitiesToFirstAcceptance", latency);
    if (firstAt !== null) assertCount("outcome.acceptance.firstNegativeAcceptanceAtAttempt", firstAt);
    if ((acceptance.negativeAccepted as number) > 0 && (latency === null || firstAt === null)) {
      throw new Error("Ablation report: a negative acceptance must report its detection latency (§6.9-1)");
    }
  }

  if (!Array.isArray(root.correlations)) throw new Error("Ablation report: correlations are required");
  if (!Array.isArray(root.correlationsByStratum)) {
    throw new Error("Ablation report: correlationsByStratum are required (§6.1-2)");
  }
  if (!Array.isArray(root.stratumCensus)) throw new Error("Ablation report: stratumCensus is required (§6.2)");
  // §6.1-2 要求 raw 与 normalized **分别**报告；做不到时必须写明原因而不是留空。
  const normalized = asRecord("normalizedCorrelations", root.normalizedCorrelations);
  if (typeof normalized.status !== "string" || normalized.status === "") {
    throw new Error("Ablation report: normalizedCorrelations.status is required");
  }
  if (normalized.status === "not_evaluable" && (typeof normalized.reason !== "string" || normalized.reason === "")) {
    throw new Error("Ablation report: an unevaluated section must state its reason");
  }

  if (!Array.isArray(root.findings) || !Array.isArray(root.releaseBlockers)) {
    throw new Error("Ablation report: negative-learning findings and releaseBlockers are required");
  }
  // §6.9-6：预注册未冻结时不得替用户挑阈值。
  const preregistration = asRecord("negativeGatePreregistration", root.negativeGatePreregistration);
  if (preregistration.status === "not_configured" && preregistration.recommendation !== "not_evaluable") {
    throw new Error("Ablation report: an unfrozen pre-registration cannot produce a recommendation");
  }
}
