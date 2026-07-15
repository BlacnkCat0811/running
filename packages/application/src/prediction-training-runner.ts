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
  MAXIMUM_DISTANCE_MAE_REGRESSION,
  MAXIMUM_INTERVAL_COVERAGE_DROP,
  MINIMUM_HOLDOUT_PREDICTIONS,
  MINIMUM_HOLDOUTS_PER_DISTANCE,
  MINIMUM_MAE_IMPROVEMENT,
  MINIMUM_LABELS_PER_DISTANCE,
  MINIMUM_PREDICTION_LABELS,
  ONNX_PARITY_TOLERANCE,
  PREDICTION_CORRECTION_CAP_FRACTION,
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
      minimumHoldoutPredictions: number;
      minimumHoldoutPerDistance: number;
      minimumMaeImprovement: number;
      maximumDistanceRegression: number;
      maximumCoverageDrop: number;
    };
  };
  onnxParity: {
    maximumAbsoluteError: number;
    passed: boolean;
  };
}

interface ManifestJson {
  modelVersion: string;
  algorithm: string;
  featureSchemaVersion: string;
  featureSchemaHash: string;
  trainingDataHash: string;
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

function orderedSamples(samples: RaceResidualTrainingSample[]): RaceResidualTrainingSample[] {
  return [...samples].sort((left, right) =>
    left.observedAt.localeCompare(right.observedAt) || left.sampleId.localeCompare(right.sampleId)
  );
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
  const baseline = evaluation.walkForward.baselineMetrics;
  const candidate = evaluation.walkForward.candidateMetrics;
  const byDistance = Object.fromEntries(distances.map((distance) => [
    distance,
    distanceMetric(
      distance,
      evaluation.walkForward.baselineByDistance[distance],
      evaluation.walkForward.candidateByDistance[distance]
    )
  ])) as Record<RaceDistance, PredictionModelDistanceMetrics>;
  return {
    baselineMaeSeconds: finiteNumber("baseline MAE", baseline.meanAbsoluteErrorSeconds),
    modelMaeSeconds: finiteNumber("model MAE", candidate.meanAbsoluteErrorSeconds),
    maeImprovement: finiteNumber(
      "MAE improvement",
      evaluation.activationGate.meanAbsoluteErrorImprovement
    ),
    intervalCoverageChange:
      -finiteNumber("interval coverage drop", evaluation.activationGate.intervalCoverageDrop),
    regressesAnyDistanceByMoreThan5Percent: distances.some(
      (distance) => (evaluation.activationGate.distanceMaeRegression[distance] ?? Infinity) > 0.05
    ),
    onnxMaximumAbsoluteError: evaluation.onnxParity.maximumAbsoluteError,
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
  if (manifest.labelCount !== samples.length || evaluation.activationGate.labelCount !== samples.length) {
    throw new Error("artifact 标签数量与导出数据集不一致");
  }
  const expectedCounts = distanceCounts(samples);
  if (stableJson(evaluation.activationGate.labelCountByDistance) !== stableJson(expectedCounts)) {
    throw new Error("activation gate 分距离标签数量与导出数据集不一致");
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
    minimumLabels: MINIMUM_PREDICTION_LABELS,
    minimumLabelsPerDistance: MINIMUM_LABELS_PER_DISTANCE,
    initialTrainingSize: WALK_FORWARD_INITIAL_TRAINING_SIZE,
    minimumHoldoutPredictions: MINIMUM_HOLDOUT_PREDICTIONS,
    minimumHoldoutPerDistance: MINIMUM_HOLDOUTS_PER_DISTANCE,
    minimumMaeImprovement: MINIMUM_MAE_IMPROVEMENT,
    maximumDistanceRegression: MAXIMUM_DISTANCE_MAE_REGRESSION,
    maximumCoverageDrop: MAXIMUM_INTERVAL_COVERAGE_DROP
  };
  if (stableJson(evaluation.activationGate.thresholds) !== stableJson(expectedThresholds)) {
    throw new Error("Python 与 TypeScript activation gate 门槛不一致");
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
  if (manifest.status !== evaluation.status) throw new Error("manifest 与 evaluation 状态不一致");
  for (const value of [manifest.featureSchemaHash, manifest.trainingDataHash, manifest.modelSha256]) {
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("artifact SHA-256 字段无效");
  }
  const requiredFiles = ["model.onnx", "feature-schema.json", "evaluation.json"] as const;
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
      const first = samples[0]!;
      await model.predict({
        ...first.features,
        isFiveK: first.distance === "five_k" ? 1 : 0,
        isTenK: first.distance === "ten_k" ? 1 : 0,
        isHalfMarathon: first.distance === "half_marathon" ? 1 : 0
      });
    });

    const result: PredictionModelTrainingResult = {
      featureSchemaHash: manifest.featureSchemaHash,
      trainingDataHash: manifest.trainingDataHash,
      labelCount: samples.length,
      labelCountByDistance: counts,
      holdoutPredictionCount: evaluation.activationGate.holdoutCount,
      metrics: mapMetrics(evaluation),
      supportedDistances: manifest.supportedDistances,
      artifactPath: args.artifactDirectory,
      artifactSha256: manifest.modelSha256
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
