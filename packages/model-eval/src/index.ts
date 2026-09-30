import { canonicalSemanticJson, type RaceDistance } from "@rai/contracts";

export const MODEL_EVAL_VERSION = "rai-model-eval-v1" as const;

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
