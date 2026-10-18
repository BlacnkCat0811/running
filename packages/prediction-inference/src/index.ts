import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { InferenceSession } from "onnxruntime-node";
import {
  CATBOOST_PREDICTION_MODEL_VERSION,
  PREDICTION_CORRECTION_CAP_FRACTION,
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH,
  predictionResidualOnnxFeatureNames,
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
  type PredictionModelScope
} from "@rai/contracts";

export const CATBOOST_RESIDUAL_MODEL_VERSION = CATBOOST_PREDICTION_MODEL_VERSION;

export interface CatBoostArtifactMetrics {
  baseline: Record<string, unknown>;
  candidate: Record<string, unknown>;
  byDistance: {
    baseline: Record<string, Record<string, unknown>>;
    candidate: Record<string, Record<string, unknown>>;
  };
  meanAbsoluteErrorImprovement: number | null;
  intervalCoverageDrop: number | null;
}

export interface CatBoostArtifactManifest {
  modelVersion: typeof CATBOOST_RESIDUAL_MODEL_VERSION;
  algorithm: "catboost";
  scope: PredictionModelScope;
  featureSchemaVersion: string;
  featureSchemaHash: string;
  trainingDataHash: string;
  modelSha256: string;
  labelCount: number;
  supportedDistances: Array<"five_k" | "ten_k" | "half_marathon">;
  featureNames: string[];
  inputName: string;
  outputName: string;
  correctionCapFraction: number;
  generatedAt: string;
  status: "accepted";
  metrics: CatBoostArtifactMetrics;
}

export interface CatBoostPredictionResult {
  targetLogResidual: number;
  correctionFraction: number;
}

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * 🔴 `onnxruntime-node` **只能惰性加载**：它是带原生绑定的可选依赖，模块加载期就
 * `dlopen` 一个平台相关的 `.node`。此前的顶层 `import { InferenceSession, Tensor }`
 * 让**任何**导入闭包触及本包的文件（`@rai/application` barrel → `prediction-report` /
 * `prediction-training-data` → 本包）在加载期就尝试加载原生库，于"签名/Team ID 与
 * 宿主不匹配"的机器上直接 `ERR_DLOPEN_FAILED` —— 实测 2026-10-18：15 个 `apps/api/test`
 * 文件（含 `training-plan-state.test.ts` 与 `server-runtime.test.ts`）一个断言都没跑就整批红，
 * 而它们与 ONNX 毫无关系。纯函数（manifest 断言、残差换算）必须能在没有原生绑定的
 * 环境里被导入与测试。
 *
 * 代价与边界：动态 import 只在**真正推理**时发生（`load()` / `predict()`），失败仍是
 * 明确的抛错，不会退化成"静默不校准"；Node 会缓存该模块，重复调用不重复加载。
 */
let onnxRuntime: Promise<typeof import("onnxruntime-node")> | null = null;
function loadOnnxRuntime(): Promise<typeof import("onnxruntime-node")> {
  onnxRuntime ??= import("onnxruntime-node");
  return onnxRuntime;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

export function assertCatBoostArtifactManifest(
  value: unknown
): asserts value is CatBoostArtifactManifest {
  if (!value || typeof value !== "object") throw new Error("CatBoost manifest must be an object");
  const manifest = value as Partial<CatBoostArtifactManifest>;
  if (
    manifest.modelVersion !== CATBOOST_RESIDUAL_MODEL_VERSION ||
    manifest.algorithm !== "catboost" ||
    (manifest.scope !== "population" && manifest.scope !== "personal") ||
    manifest.featureSchemaVersion !== PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION ||
    manifest.status !== "accepted"
  ) {
    throw new Error("Unsupported CatBoost artifact version");
  }
  if (
    !isSha256(manifest.featureSchemaHash) ||
    !isSha256(manifest.trainingDataHash) ||
    !isSha256(manifest.modelSha256) ||
    typeof manifest.inputName !== "string" || manifest.inputName.length === 0 ||
    typeof manifest.outputName !== "string" || manifest.outputName.length === 0 ||
    manifest.inputName === manifest.outputName ||
    typeof manifest.generatedAt !== "string" || !Number.isFinite(Date.parse(manifest.generatedAt)) ||
    !Array.isArray(manifest.featureNames) ||
    manifest.featureNames.length === 0 ||
    !manifest.featureNames.every((name) => typeof name === "string") ||
    new Set(manifest.featureNames).size !== manifest.featureNames.length ||
    !Array.isArray(manifest.supportedDistances) ||
    manifest.supportedDistances.length === 0 ||
    !manifest.supportedDistances.every((distance) =>
      distance === "five_k" || distance === "ten_k" || distance === "half_marathon"
    ) ||
    new Set(manifest.supportedDistances).size !== manifest.supportedDistances.length ||
    typeof manifest.labelCount !== "number" ||
    !Number.isInteger(manifest.labelCount) ||
    manifest.labelCount <= 0 ||
    typeof manifest.correctionCapFraction !== "number" ||
    !Number.isFinite(manifest.correctionCapFraction) ||
    manifest.correctionCapFraction !== PREDICTION_CORRECTION_CAP_FRACTION
  ) {
    throw new Error("CatBoost manifest is incomplete or invalid");
  }
  if (!manifest.metrics || typeof manifest.metrics !== "object") {
    throw new Error("CatBoost manifest metrics are missing");
  }
  if (
    manifest.featureSchemaHash !== PREDICTION_RESIDUAL_FEATURE_SCHEMA_HASH ||
    JSON.stringify(manifest.featureNames) !== JSON.stringify(predictionResidualOnnxFeatureNames)
  ) {
    throw new Error("CatBoost manifest does not match the runtime feature contract");
  }
}

export function correctionFractionFromLogResidual(
  targetLogResidual: number,
  maximumCorrectionFraction = 0.12
): number {
  if (!Number.isFinite(targetLogResidual)) throw new Error("CatBoost output must be finite");
  if (
    !Number.isFinite(maximumCorrectionFraction) ||
    maximumCorrectionFraction <= 0 ||
    maximumCorrectionFraction > 0.25
  ) {
    throw new Error("maximumCorrectionFraction must be between 0 and 0.25");
  }
  return clamp(
    Math.exp(targetLogResidual) - 1,
    -maximumCorrectionFraction,
    maximumCorrectionFraction
  );
}

export class OnnxCatBoostResidualModel {
  private constructor(
    readonly artifactDirectory: string,
    readonly manifest: CatBoostArtifactManifest,
    private readonly session: InferenceSession
  ) {}

  static async load(artifactDirectory: string, expectedScope?: PredictionModelScope): Promise<OnnxCatBoostResidualModel> {
    const directory = resolve(artifactDirectory);
    const manifestPath = resolve(directory, "manifest.json");
    const modelPath = resolve(directory, "model.onnx");
    const [manifestBytes, modelBytes] = await Promise.all([
      readFile(manifestPath),
      readFile(modelPath)
    ]);
    const parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    assertCatBoostArtifactManifest(parsed);
    if (expectedScope !== undefined && parsed.scope !== expectedScope) {
      throw new Error("CatBoost artifact scope mismatch");
    }
    if (sha256(modelBytes) !== parsed.modelSha256) {
      throw new Error("CatBoost ONNX artifact hash mismatch");
    }
    const { InferenceSession: OnnxInferenceSession } = await loadOnnxRuntime();
    const session = await OnnxInferenceSession.create(modelBytes, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all"
    });
    if (session.inputNames.length !== 1 || session.inputNames[0] !== parsed.inputName) {
      throw new Error(`CatBoost ONNX input not found: ${parsed.inputName}`);
    }
    if (session.outputNames.length !== 1 || session.outputNames[0] !== parsed.outputName) {
      throw new Error(`CatBoost ONNX output not found: ${parsed.outputName}`);
    }
    const input = session.inputMetadata[0];
    const output = session.outputMetadata[0];
    if (
      input?.isTensor !== true ||
      input?.type !== "float32" ||
      input.shape.length !== 2 ||
      input.shape[1] !== parsed.featureNames.length
    ) {
      throw new Error("CatBoost ONNX input metadata does not match the feature contract");
    }
    if (output?.isTensor !== true || output.type !== "float32") {
      throw new Error("CatBoost ONNX output must be float32");
    }
    const model = new OnnxCatBoostResidualModel(directory, parsed, session);
    await model.predict(Object.fromEntries(parsed.featureNames.map((name) => [name, 0])));
    return model;
  }

  supportsDistance(distance: "five_k" | "ten_k" | "half_marathon"): boolean {
    return this.manifest.supportedDistances.includes(distance);
  }

  async predict(features: Readonly<Record<string, number | null | undefined>>): Promise<CatBoostPredictionResult> {
    const values = this.manifest.featureNames.map((name) => {
      if (!Object.prototype.hasOwnProperty.call(features, name)) {
        throw new Error(`CatBoost feature is missing: ${name}`);
      }
      const value = features[name];
      if (value === null || value === undefined) return Number.NaN;
      if (!Number.isFinite(value)) throw new Error(`CatBoost feature must be finite: ${name}`);
      return value;
    });
    const { Tensor: OnnxTensor } = await loadOnnxRuntime();
    const tensor = new OnnxTensor("float32", Float32Array.from(values), [1, values.length]);
    const outputs = await this.session.run({ [this.manifest.inputName]: tensor });
    const output = outputs[this.manifest.outputName];
    if (!output || output.data.length !== 1) {
      throw new Error("CatBoost ONNX output shape is invalid");
    }
    const raw = output?.data[0];
    const targetLogResidual = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(targetLogResidual)) throw new Error("CatBoost ONNX output is invalid");
    return {
      targetLogResidual,
      correctionFraction: correctionFractionFromLogResidual(
        targetLogResidual,
        this.manifest.correctionCapFraction
      )
    };
  }
}
