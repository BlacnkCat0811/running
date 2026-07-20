import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  CATBOOST_PREDICTION_MODEL_VERSION,
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
  type PredictionModelDistanceMetrics,
  type PredictionModelEvaluationMetrics,
  type PredictionModelTrainingResult,
  type RaceDistance
} from "@rai/contracts";
import { OnnxCatBoostResidualModel } from "@rai/prediction-inference";

import {
  buildRaceResidualTrainingDataset,
  raceResidualFeatureNames,
  raceResidualFeatureSchemaHash,
  raceResidualOnnxFeatureNames,
  type RaceResidualTrainingSample
} from "./prediction-training-data.js";
import {
  CATBOOST_V1_HYPERPARAMETERS,
  MINIMUM_ARTIFACT_TRAINING_LABELS,
  MINIMUM_ARTIFACT_TRAINING_LABELS_PER_DISTANCE,
  MAXIMUM_DISTANCE_MAE_REGRESSION,
  MAXIMUM_INTERVAL_COVERAGE_DROP,
  MINIMUM_HOLDOUT_PREDICTIONS,
  MINIMUM_HOLDOUTS_PER_DISTANCE,
  MINIMUM_MAE_IMPROVEMENT,
  MINIMUM_LABELS_PER_DISTANCE,
  MINIMUM_PREDICTION_LABELS,
  MINIMUM_WALK_FORWARD_PER_DISTANCE,
  MINIMUM_WALK_FORWARD_PREDICTIONS,
  ONNX_PARITY_TOLERANCE,
  PREDICTION_CORRECTION_CAP_FRACTION,
  MINIMUM_RELEASE_BOOTSTRAP_BLOCKS,
  RELEASE_BOOTSTRAP_BLOCK_EVENTS,
  RELEASE_BOOTSTRAP_ITERATIONS,
  RELEASE_HOLDOUT_EMBARGO_HOURS,
  WALK_FORWARD_INITIAL_TRAINING_SIZE
} from "./prediction-model-service.js";

const distances: RaceDistance[] = ["five_k", "ten_k", "half_marathon"];

interface RunnerArguments {
  database: string;
  runId: string;
  asOf: string;
  artifactDirectory: string;
  result: string;
}

interface RegressionMetricsJson {
  sampleCount: number;
  meanAbsoluteErrorSeconds: number | null;
  intervalCoverage: number | null;
}

interface EvaluationJson {
  status: "accepted" | "rejected";
  rejectionReasons: string[];
  walkForward: {
    baselineMetrics: RegressionMetricsJson;
    candidateMetrics: RegressionMetricsJson;
    baselineByDistance: Record<RaceDistance, RegressionMetricsJson>;
    candidateByDistance: Record<RaceDistance, RegressionMetricsJson>;
  };
  activationGate: {
    labelCount: number;
    labelCountByDistance: Record<RaceDistance, number>;
    holdoutCount: number;
    holdoutCountByDistance: Record<RaceDistance, number>;
    meanAbsoluteErrorImprovement: number | null;
    distanceMaeRegression: Record<RaceDistance, number | null>;
    intervalCoverageDrop: number | null;
    thresholds: {
      minimumLabels: number;
      minimumLabelsPerDistance: number;
      initialTrainingSize: number;
      minimumWalkForwardPredictions: number;
      minimumWalkForwardPerDistance: number;
      minimumMaeImprovement: number;
      maximumDistanceRegression: number;
      maximumCoverageDrop: number;
    };
  };
  releaseSplit: {
    method: "temporal_event_grouped_holdout_v1";
    embargoHours: number;
    holdoutStartsAt: string;
    trainingLabelAvailabilityCutoff: string;
    trainingSampleIds: string[];
    holdoutSampleIds: string[];
    trainingDataHash: string;
    holdoutDataHash: string;
    trainingCount: number;
    holdoutCount: number;
    trainingCountByDistance: Record<RaceDistance, number>;
    holdoutCountByDistance: Record<RaceDistance, number>;
  };
  releaseHoldout: {
    baselineMetrics: RegressionMetricsJson;
    candidateMetrics: RegressionMetricsJson;
    baselineByDistance: Record<RaceDistance, RegressionMetricsJson>;
    candidateByDistance: Record<RaceDistance, RegressionMetricsJson>;
    meanAbsoluteErrorImprovement: number | null;
    maeImprovementBootstrap95: {
      method: "non_overlapping_temporal_event_block_v1";
      lower: number | null;
      upper: number | null;
      iterations: number;
      blockEvents: number;
      effectiveBlocks: number;
    };
    distanceMaeRegression: Record<RaceDistance, number | null>;
    intervalCoverageDrop: number | null;
    thresholds: {
      minimumHoldout: number;
      minimumHoldoutPerDistance: number;
      minimumMaeImprovement: number;
      maximumDistanceRegression: number;
      maximumCoverageDrop: number;
      requirePositiveBootstrapLowerBound: boolean;
      minimumBootstrapBlocks: number;
    };
  };
  onnxParity: {
    maximumAbsoluteError: number;
    passed: boolean;
  };
  publishedArtifact: {
    fitStrategy: "training_partition_only";
    generalizationMetricsSource: "temporal_release_holdout";
    directGeneralizationMetric: true;
    numericParityFixture: "onnx-golden.json";
    evaluatedArtifactSha256: string;
  };
}

export interface OnnxGoldenJson {
  toleranceExclusive: number;
  scope: "release_holdout";
  vectors: Array<{
    sampleId: string;
    distance: RaceDistance;
    features: Record<string, number | null>;
    targetLogResidual: number;
    correctionFraction: number;
    actualSeconds: number;
    baselinePredictedSeconds: number;
    baselineOptimisticSeconds: number | null;
    baselinePessimisticSeconds: number | null;
  }>;
}

interface ManifestJson {
  modelVersion: string;
  algorithm: string;
  featureSchemaVersion: string;
  featureSchemaHash: string;
  trainingDataHash: string;
  holdoutDataHash: string;
  trainingDataThroughAt: string;
  inputFileSha256: string;
  modelSha256: string;
  labelCount: number;
  supportedDistances: RaceDistance[];
  featureNames: string[];
  correctionCapFraction: number;
  catBoostParameters: Record<string, unknown>;
  artifactFiles: Record<string, string>;
  status: "accepted" | "rejected";
  pythonRuntime: {
    python: string;
    packages: Record<string, string>;
  };
}

function parseArguments(values: string[]): RunnerArguments {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("prediction training runner 参数格式无效");
    }
    options.set(key.slice(2), value);
  }
  const required = ["database", "run-id", "as-of", "artifact-directory", "result"] as const;
  for (const key of required) {
    if (!options.get(key)) throw new Error(`缺少 --${key}`);
  }
  const asOf = new Date(Date.parse(options.get("as-of")!)).toISOString();
  return {
    database: resolve(options.get("database")!),
    runId: options.get("run-id")!,
    asOf,
    artifactDirectory: resolve(options.get("artifact-directory")!),
    result: resolve(options.get("result")!)
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const preciseIsoInstantPattern =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

export function trainingInstantMicros(value: string): bigint {
  const match = preciseIsoInstantPattern.exec(value);
  if (!match) throw new Error("training timestamp must be a timezone-qualified ISO 8601 instant");
  const [, date, time, fraction = "", timezone] = match;
  const localMillis = Date.parse(`${date}T${time}Z`);
  const instantMillis = Date.parse(`${date}T${time}${timezone}`);
  if (
    !Number.isFinite(localMillis) ||
    !Number.isFinite(instantMillis) ||
    new Date(localMillis).toISOString().slice(0, 19) !== `${date}T${time}`
  ) {
    throw new Error("training timestamp must be a valid ISO 8601 instant");
  }
  return BigInt(instantMillis) * 1_000n + BigInt(fraction.padEnd(6, "0"));
}

export function temporalEventKey(observedAt: string, completedAt: string): string {
  return `${trainingInstantMicros(observedAt)}\u0000${trainingInstantMicros(completedAt)}`;
}

export function orderedSamples(samples: RaceResidualTrainingSample[]): RaceResidualTrainingSample[] {
  return samples.map((sample) => ({ sample, instant: trainingInstantMicros(sample.observedAt) }))
    .sort((left, right) => left.instant < right.instant
      ? -1
      : left.instant > right.instant
        ? 1
        : left.sample.sampleId.localeCompare(right.sample.sampleId))
    .map(({ sample }) => sample);
}

function datasetJsonl(samples: RaceResidualTrainingSample[]): string {
  return samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n";
}

function distanceCounts(samples: RaceResidualTrainingSample[]): Record<RaceDistance, number> {
  const counts: Record<RaceDistance, number> = { five_k: 0, ten_k: 0, half_marathon: 0 };
  for (const sample of samples) counts[sample.distance] += 1;
  return counts;
}

function runPython(
  input: string,
  artifactDirectory: string,
  generatedAt: string
): Promise<{ code: number; output: string }> {
  const projectRoot = resolve(import.meta.dirname, "../../..");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      "research/scripts/python-env.mjs",
      "--train",
      "--input",
      input,
      "--output-dir",
      artifactDirectory,
      "--generated-at",
      generatedAt,
      "--data-through-at",
      generatedAt
    ], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-16_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise({ code: code ?? 1, output: output.trim() }));
  });
}

function parseJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function finiteNumber(name: string, value: number | null): number {
  if (value === null || !Number.isFinite(value)) throw new Error(`${name} 缺失或无效`);
  return value;
}

function distanceMetric(
  distance: RaceDistance,
  baseline: RegressionMetricsJson,
  candidate: RegressionMetricsJson
): PredictionModelDistanceMetrics {
  const baselineMae = baseline.meanAbsoluteErrorSeconds;
  const modelMae = candidate.meanAbsoluteErrorSeconds;
  return {
    sampleCount: candidate.sampleCount,
    baselineMaeSeconds: baselineMae,
    modelMaeSeconds: modelMae,
    maeImprovement:
      baselineMae === null || baselineMae === 0 || modelMae === null
        ? null
        : 1 - modelMae / baselineMae
  };
}

function mapMetrics(evaluation: EvaluationJson): PredictionModelEvaluationMetrics {
  const baseline = evaluation.releaseHoldout.baselineMetrics;
  const candidate = evaluation.releaseHoldout.candidateMetrics;
  const byDistance = Object.fromEntries(distances.map((distance) => [
    distance,
    distanceMetric(
      distance,
      evaluation.releaseHoldout.baselineByDistance[distance],
      evaluation.releaseHoldout.candidateByDistance[distance]
    )
  ])) as Record<RaceDistance, PredictionModelDistanceMetrics>;
  const bootstrapLower = evaluation.releaseHoldout.maeImprovementBootstrap95.lower;
  return {
    baselineMaeSeconds: finiteNumber("baseline MAE", baseline.meanAbsoluteErrorSeconds),
    modelMaeSeconds: finiteNumber("model MAE", candidate.meanAbsoluteErrorSeconds),
    maeImprovement: finiteNumber(
      "MAE improvement",
      evaluation.releaseHoldout.meanAbsoluteErrorImprovement
    ),
    intervalCoverageChange:
      -finiteNumber("interval coverage drop", evaluation.releaseHoldout.intervalCoverageDrop),
    regressesAnyDistanceByMoreThan5Percent: distances.some(
      (distance) => (evaluation.releaseHoldout.distanceMaeRegression[distance] ?? Infinity) > 0.05
    ),
    onnxMaximumAbsoluteError: evaluation.onnxParity.maximumAbsoluteError,
    maeImprovementBootstrap95Lower: Number.isFinite(bootstrapLower) ? bootstrapLower : null,
    byDistance
  };
}

function assertArtifactContract(
  manifest: ManifestJson,
  evaluation: EvaluationJson,
  samples: RaceResidualTrainingSample[],
  artifactDirectory: string,
  exportedDatasetSha256: string,
  pythonExitCode: number,
  expectedDataThroughAt: string
): void {
  if (
    manifest.modelVersion !== CATBOOST_PREDICTION_MODEL_VERSION ||
    manifest.algorithm !== "catboost" ||
    manifest.featureSchemaVersion !== PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION
  ) {
    throw new Error("Python artifact 模型或特征版本不匹配");
  }
  if (!manifest.pythonRuntime || !/^3\.(12|13)\./.test(manifest.pythonRuntime.python)) {
    throw new Error("Python artifact 缺少受支持的运行时版本快照");
  }
  if (manifest.featureSchemaHash !== raceResidualFeatureSchemaHash()) {
    throw new Error("Python 与 TypeScript feature schema hash 不一致");
  }
  const expectedExitCode = evaluation.status === "accepted" ? 0 : 2;
  if (pythonExitCode !== expectedExitCode) {
    throw new Error("Python 退出码与 activation gate 状态不一致");
  }
  if (manifest.inputFileSha256 !== exportedDatasetSha256) {
    throw new Error("Python 训练输入文件与 TypeScript 导出数据集不一致");
  }
  if (manifest.trainingDataThroughAt !== expectedDataThroughAt) {
    throw new Error("Python artifact 数据截止时间与锁定的训练请求不一致");
  }
  if (JSON.stringify(manifest.featureNames) !== JSON.stringify(raceResidualOnnxFeatureNames)) {
    throw new Error("Python 与 TypeScript ONNX 特征顺序不一致");
  }
  const samplesById = new Map(samples.map((sample) => [sample.sampleId, sample]));
  const training = evaluation.releaseSplit.trainingSampleIds.map((id) => samplesById.get(id));
  const holdout = evaluation.releaseSplit.holdoutSampleIds.map((id) => samplesById.get(id));
  if (training.some((sample) => !sample) || holdout.some((sample) => !sample)) {
    throw new Error("release split 引用了未知样本");
  }
  const trainingSamples = training as RaceResidualTrainingSample[];
  const holdoutSamples = holdout as RaceResidualTrainingSample[];
  const trainingIds = new Set(evaluation.releaseSplit.trainingSampleIds);
  if (
    trainingIds.size !== trainingSamples.length ||
    new Set(evaluation.releaseSplit.holdoutSampleIds).size !== holdoutSamples.length ||
    holdoutSamples.some((sample) => trainingIds.has(sample.sampleId))
  ) {
    throw new Error("release split 样本重复或交叉");
  }
  const eventPartitions = new Map<string, "training" | "holdout">();
  for (const [partition, rows] of [["training", trainingSamples], ["holdout", holdoutSamples]] as const) {
    for (const sample of rows) {
      const key = temporalEventKey(sample.observedAt, sample.completedAt);
      const previous = eventPartitions.get(key);
      if (previous && previous !== partition) throw new Error("同一事件跨越 release split");
      eventPartitions.set(key, partition);
    }
  }
  const cutoff = trainingInstantMicros(evaluation.releaseSplit.trainingLabelAvailabilityCutoff);
  const holdoutStart = trainingInstantMicros(evaluation.releaseSplit.holdoutStartsAt);
  const embargoMicros = BigInt(RELEASE_HOLDOUT_EMBARGO_HOURS) * 3_600_000_000n;
  if (
    evaluation.releaseSplit.method !== "temporal_event_grouped_holdout_v1" ||
    evaluation.releaseSplit.embargoHours !== RELEASE_HOLDOUT_EMBARGO_HOURS ||
    cutoff !== holdoutStart - embargoMicros ||
    trainingSamples.some((sample) => trainingInstantMicros(sample.labelAvailableAt) > cutoff) ||
    holdoutSamples.some((sample) => trainingInstantMicros(sample.observedAt) < holdoutStart)
  ) {
    throw new Error("release split 时间截止或 embargo 无效");
  }
  const trainingCounts = distanceCounts(trainingSamples);
  const holdoutCounts = distanceCounts(holdoutSamples);
  if (
    manifest.labelCount !== trainingSamples.length ||
    evaluation.releaseSplit.trainingCount !== trainingSamples.length ||
    evaluation.releaseSplit.holdoutCount !== holdoutSamples.length ||
    stableJson(evaluation.releaseSplit.trainingCountByDistance) !== stableJson(trainingCounts) ||
    stableJson(evaluation.releaseSplit.holdoutCountByDistance) !== stableJson(holdoutCounts) ||
    evaluation.releaseSplit.trainingDataHash !== manifest.trainingDataHash ||
    evaluation.releaseSplit.holdoutDataHash !== manifest.holdoutDataHash
  ) {
    throw new Error("release split 数量或 hash 与 artifact 不一致");
  }
  if (
    evaluation.activationGate.labelCount !== trainingSamples.length ||
    stableJson(evaluation.activationGate.labelCountByDistance) !== stableJson(trainingCounts)
  ) {
    throw new Error("walk-forward gate 训练标签与 release split 不一致");
  }
  for (const distance of distances) {
    const holdoutCount = evaluation.activationGate.holdoutCountByDistance[distance];
    if (
      evaluation.walkForward.baselineByDistance[distance].sampleCount !== holdoutCount ||
      evaluation.walkForward.candidateByDistance[distance].sampleCount !== holdoutCount
    ) {
      throw new Error(`walk-forward ${distance} holdout 数量不一致`);
    }
  }
  const expectedThresholds: EvaluationJson["activationGate"]["thresholds"] = {
    minimumLabels: MINIMUM_ARTIFACT_TRAINING_LABELS,
    minimumLabelsPerDistance: MINIMUM_ARTIFACT_TRAINING_LABELS_PER_DISTANCE,
    initialTrainingSize: WALK_FORWARD_INITIAL_TRAINING_SIZE,
    minimumWalkForwardPredictions: MINIMUM_WALK_FORWARD_PREDICTIONS,
    minimumWalkForwardPerDistance: MINIMUM_WALK_FORWARD_PER_DISTANCE,
    minimumMaeImprovement: MINIMUM_MAE_IMPROVEMENT,
    maximumDistanceRegression: MAXIMUM_DISTANCE_MAE_REGRESSION,
    maximumCoverageDrop: MAXIMUM_INTERVAL_COVERAGE_DROP
  };
  if (stableJson(evaluation.activationGate.thresholds) !== stableJson(expectedThresholds)) {
    throw new Error("Python 与 TypeScript activation gate 门槛不一致");
  }
  const expectedReleaseThresholds: EvaluationJson["releaseHoldout"]["thresholds"] = {
    minimumHoldout: MINIMUM_HOLDOUT_PREDICTIONS,
    minimumHoldoutPerDistance: MINIMUM_HOLDOUTS_PER_DISTANCE,
    minimumMaeImprovement: MINIMUM_MAE_IMPROVEMENT,
    maximumDistanceRegression: MAXIMUM_DISTANCE_MAE_REGRESSION,
    maximumCoverageDrop: MAXIMUM_INTERVAL_COVERAGE_DROP,
    requirePositiveBootstrapLowerBound: true,
    minimumBootstrapBlocks: MINIMUM_RELEASE_BOOTSTRAP_BLOCKS
  };
  if (
    stableJson(evaluation.releaseHoldout.thresholds) !== stableJson(expectedReleaseThresholds) ||
    evaluation.releaseHoldout.maeImprovementBootstrap95.method !==
      "non_overlapping_temporal_event_block_v1" ||
    evaluation.releaseHoldout.maeImprovementBootstrap95.iterations !== RELEASE_BOOTSTRAP_ITERATIONS ||
    evaluation.releaseHoldout.maeImprovementBootstrap95.blockEvents !==
      RELEASE_BOOTSTRAP_BLOCK_EVENTS ||
    evaluation.releaseHoldout.maeImprovementBootstrap95.effectiveBlocks <
      MINIMUM_RELEASE_BOOTSTRAP_BLOCKS ||
    (evaluation.status === "accepted" &&
      (evaluation.releaseHoldout.maeImprovementBootstrap95.lower === null ||
       evaluation.releaseHoldout.maeImprovementBootstrap95.lower <= 0))
  ) {
    throw new Error("release holdout activation gate 门槛或不确定性无效");
  }
  if (stableJson(manifest.catBoostParameters) !== stableJson(CATBOOST_V1_HYPERPARAMETERS)) {
    throw new Error("Python 与 TypeScript CatBoost 参数快照不一致");
  }
  if (manifest.correctionCapFraction !== PREDICTION_CORRECTION_CAP_FRACTION) {
    throw new Error("Python 与 TypeScript 残差修正上限不一致");
  }
  if (!evaluation.onnxParity.passed || evaluation.onnxParity.maximumAbsoluteError >= ONNX_PARITY_TOLERANCE) {
    throw new Error("ONNX parity 未通过生产门槛");
  }
  if (
    evaluation.publishedArtifact?.fitStrategy !== "training_partition_only" ||
    evaluation.publishedArtifact.generalizationMetricsSource !== "temporal_release_holdout" ||
    evaluation.publishedArtifact.directGeneralizationMetric !== true ||
    evaluation.publishedArtifact.numericParityFixture !== "onnx-golden.json" ||
    evaluation.publishedArtifact.evaluatedArtifactSha256 !== manifest.modelSha256
  ) {
    throw new Error("published artifact 的拟合与指标来源声明无效");
  }
  if (manifest.status !== evaluation.status) throw new Error("manifest 与 evaluation 状态不一致");
  if (evaluation.status === "accepted" && evaluation.rejectionReasons.length !== 0) {
    throw new Error("accepted evaluation 不能包含 rejection reasons");
  }
  for (const value of [manifest.featureSchemaHash, manifest.trainingDataHash, manifest.holdoutDataHash, manifest.modelSha256]) {
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("artifact SHA-256 字段无效");
  }
  const requiredFiles = ["model.onnx", "feature-schema.json", "evaluation.json", "onnx-golden.json"] as const;
  for (const name of requiredFiles) {
    const expectedHash = manifest.artifactFiles[name];
    if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
      throw new Error(`artifact ${name} SHA-256 缺失或无效`);
    }
    const actualHash = sha256(readFileSync(resolve(artifactDirectory, name)));
    if (actualHash !== expectedHash) throw new Error(`artifact ${name} 完整性校验失败`);
  }
  if (manifest.artifactFiles["model.onnx"] !== manifest.modelSha256) {
    throw new Error("manifest model hash 与 artifact 文件清单不一致");
  }
  const schema = parseJsonFile<{
    featureSchemaHash: string;
    featureNames: string[];
  }>(resolve(artifactDirectory, "feature-schema.json"));
  if (
    schema.featureSchemaHash !== manifest.featureSchemaHash ||
    JSON.stringify(schema.featureNames) !== JSON.stringify(manifest.featureNames)
  ) {
    throw new Error("feature-schema.json 与 manifest 不一致");
  }
}

export async function verifyAcceptedOnnxArtifact(
  status: EvaluationJson["status"],
  verify: () => Promise<void>
): Promise<void> {
  if (status === "accepted") await verify();
}

export async function verifyOnnxGoldenVectors(
  model: Pick<OnnxCatBoostResidualModel, "predict">,
  golden: OnnxGoldenJson
): Promise<{
  baselineMetrics: RegressionMetricsJson;
  candidateMetrics: RegressionMetricsJson;
  baselineByDistance: Record<RaceDistance, RegressionMetricsJson>;
  candidateByDistance: Record<RaceDistance, RegressionMetricsJson>;
}> {
  if (
    !Number.isFinite(golden.toleranceExclusive) ||
    golden.toleranceExclusive <= 0 ||
    golden.toleranceExclusive > ONNX_PARITY_TOLERANCE ||
    golden.scope !== "release_holdout" ||
    !Array.isArray(golden.vectors) || golden.vectors.length === 0
  ) {
    throw new Error("Node ONNX golden fixture 无效");
  }
  const baselineRows: Array<{ distance: RaceDistance; actual: number; predicted: number; optimistic: number | null; pessimistic: number | null }> = [];
  const candidateRows: typeof baselineRows = [];
  for (const vector of golden.vectors) {
    const output = await model.predict(vector.features);
    if (
      Math.abs(output.targetLogResidual - vector.targetLogResidual) >= golden.toleranceExclusive ||
      Math.abs(output.correctionFraction - vector.correctionFraction) >= golden.toleranceExclusive
    ) {
      throw new Error(`Node ONNX golden parity 失败: ${vector.sampleId}`);
    }
    const factor = 1 + output.correctionFraction;
    baselineRows.push({
      distance: vector.distance,
      actual: vector.actualSeconds,
      predicted: vector.baselinePredictedSeconds,
      optimistic: vector.baselineOptimisticSeconds,
      pessimistic: vector.baselinePessimisticSeconds
    });
    candidateRows.push({
      distance: vector.distance,
      actual: vector.actualSeconds,
      predicted: Math.max(1, vector.baselinePredictedSeconds * factor),
      optimistic: vector.baselineOptimisticSeconds === null ? null : Math.max(1, vector.baselineOptimisticSeconds * factor),
      pessimistic: vector.baselinePessimisticSeconds === null ? null : Math.max(1, vector.baselinePessimisticSeconds * factor)
    });
  }
  const metrics = (rows: typeof baselineRows): RegressionMetricsJson => {
    const intervalRows = rows.filter((row) => row.optimistic !== null && row.pessimistic !== null);
    return {
      sampleCount: rows.length,
      meanAbsoluteErrorSeconds: rows.length
        ? rows.reduce((sum, row) => sum + Math.abs(row.predicted - row.actual), 0) / rows.length
        : null,
      intervalCoverage: intervalRows.length
        ? intervalRows.filter((row) => row.optimistic! <= row.actual && row.actual <= row.pessimistic!).length / intervalRows.length
        : null
    };
  };
  return {
    baselineMetrics: metrics(baselineRows),
    candidateMetrics: metrics(candidateRows),
    baselineByDistance: Object.fromEntries(distances.map((distance) => [distance, metrics(baselineRows.filter((row) => row.distance === distance))])) as Record<RaceDistance, RegressionMetricsJson>,
    candidateByDistance: Object.fromEntries(distances.map((distance) => [distance, metrics(candidateRows.filter((row) => row.distance === distance))])) as Record<RaceDistance, RegressionMetricsJson>
  };
}

function assertReleaseMetricParity(
  actual: Awaited<ReturnType<typeof verifyOnnxGoldenVectors>>,
  expected: EvaluationJson["releaseHoldout"]
): void {
  const compare = (name: string, left: RegressionMetricsJson, right: RegressionMetricsJson): void => {
    if (left.sampleCount !== right.sampleCount) throw new Error(`${name} sample count 不一致`);
    for (const key of ["meanAbsoluteErrorSeconds", "intervalCoverage"] as const) {
      const a = left[key];
      const b = right[key];
      if (a === null || b === null ? a !== b : Math.abs(a - b) >= 1e-6) {
        throw new Error(`${name} ${key} 与 Node ONNX 重算不一致`);
      }
    }
  };
  compare("release baseline", actual.baselineMetrics, expected.baselineMetrics);
  compare("release candidate", actual.candidateMetrics, expected.candidateMetrics);
  for (const distance of distances) {
    compare(`${distance} baseline`, actual.baselineByDistance[distance], expected.baselineByDistance[distance]);
    compare(`${distance} candidate`, actual.candidateByDistance[distance], expected.candidateByDistance[distance]);
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const workspace = resolve(dirname(args.artifactDirectory), `.work-${args.runId}`);
  const datasetPath = resolve(workspace, "training.jsonl");
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  try {
    const database = new DatabaseSync(args.database, { readOnly: true });
    let samples: RaceResidualTrainingSample[];
    try {
      samples = orderedSamples(buildRaceResidualTrainingDataset(database, args.asOf).samples);
    } finally {
      database.close();
    }
    const counts = distanceCounts(samples);
    if (
      samples.length < MINIMUM_PREDICTION_LABELS ||
      distances.some((distance) => counts[distance] < MINIMUM_LABELS_PER_DISTANCE)
    ) {
      throw new Error(
        `训练标签不足：总数 ${samples.length}，分距离 ${JSON.stringify(counts)}`
      );
    }
    const jsonl = datasetJsonl(samples);
    writeFileSync(datasetPath, jsonl, "utf8");
    const exportedDatasetSha256 = sha256(jsonl);

    const trained = await runPython(datasetPath, args.artifactDirectory, args.asOf);
    if (trained.code !== 0 && trained.code !== 2) {
      throw new Error(trained.output || `Python 训练失败，退出码 ${trained.code}`);
    }
    const manifest = parseJsonFile<ManifestJson>(resolve(args.artifactDirectory, "manifest.json"));
    const evaluation = parseJsonFile<EvaluationJson>(resolve(args.artifactDirectory, "evaluation.json"));
    assertArtifactContract(
      manifest,
      evaluation,
      samples,
      args.artifactDirectory,
      exportedDatasetSha256,
      trained.code,
      args.asOf
    );

    await verifyAcceptedOnnxArtifact(evaluation.status, async () => {
      const model = await OnnxCatBoostResidualModel.load(args.artifactDirectory);
      if (model.manifest.modelSha256 !== manifest.modelSha256) {
        throw new Error("Node ONNX loader 与 manifest artifact hash 不一致");
      }
      const golden = parseJsonFile<OnnxGoldenJson>(resolve(args.artifactDirectory, "onnx-golden.json"));
      const samplesById = new Map(samples.map((sample) => [sample.sampleId, sample]));
      if (
        golden.vectors.length !== evaluation.releaseSplit.holdoutSampleIds.length ||
        golden.vectors.some((vector, index) => vector.sampleId !== evaluation.releaseSplit.holdoutSampleIds[index])
      ) {
        throw new Error("Node ONNX golden 与 release holdout 身份不一致");
      }
      for (const vector of golden.vectors) {
        const sample = samplesById.get(vector.sampleId);
        if (!sample) throw new Error("Node ONNX golden 引用了未知 holdout 样本");
        const expectedFeatures = {
          ...sample.features,
          isFiveK: sample.distance === "five_k" ? 1 : 0,
          isTenK: sample.distance === "ten_k" ? 1 : 0,
          isHalfMarathon: sample.distance === "half_marathon" ? 1 : 0
        };
        if (
          stableJson(vector.features) !== stableJson(expectedFeatures) ||
          vector.distance !== sample.distance ||
          vector.actualSeconds !== sample.actualSeconds ||
          vector.baselinePredictedSeconds !== sample.baselinePredictedSeconds ||
          vector.baselineOptimisticSeconds !== sample.baselineOptimisticSeconds ||
          vector.baselinePessimisticSeconds !== sample.baselinePessimisticSeconds
        ) {
          throw new Error(`Node ONNX golden 与 holdout 输入不一致: ${vector.sampleId}`);
        }
      }
      const nodeMetrics = await verifyOnnxGoldenVectors(model, golden);
      assertReleaseMetricParity(nodeMetrics, evaluation.releaseHoldout);
    });

    const result: PredictionModelTrainingResult = {
      featureSchemaHash: manifest.featureSchemaHash,
      trainingDataHash: manifest.trainingDataHash,
      labelCount: evaluation.releaseSplit.trainingCount,
      labelCountByDistance: evaluation.releaseSplit.trainingCountByDistance,
      holdoutPredictionCount: evaluation.releaseSplit.holdoutCount,
      metrics: mapMetrics(evaluation),
      supportedDistances: manifest.supportedDistances,
      artifactPath: args.artifactDirectory,
      artifactSha256: manifest.modelSha256,
      evaluationStatus: evaluation.status,
      rejectionReasons: evaluation.rejectionReasons
    };
    mkdirSync(dirname(args.result), { recursive: true });
    const temporaryResult = `${args.result}.${process.pid}.tmp`;
    writeFileSync(temporaryResult, `${JSON.stringify(result)}\n`, "utf8");
    renameSync(temporaryResult, args.result);
    process.stdout.write(`${JSON.stringify({
      status: evaluation.status,
      exportedDatasetSha256,
      canonicalTrainingDataHash: manifest.trainingDataHash,
      result: args.result
    })}\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
