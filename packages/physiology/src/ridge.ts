import type {
  PerformanceVdotEstimate,
  PhysiologyEvidenceCode,
  RaceDistance,
  RaceTimePrediction,
  Vo2MaxEstimate
} from "@rai/contracts";

export interface RaceMlFeatures {
  logPredictedSeconds: number;
  readiness: number;
  conditionAdjustmentFraction: number;
  performanceVdot: number;
  vo2Gap: number;
  isTenK: number;
  isHalfMarathon: number;
}

export interface RaceMlTrainingExample {
  features: RaceMlFeatures;
  predictedSeconds: number;
  actualSeconds: number;
}

export interface RaceResidualRidgeModel {
  version: "race-residual-ridge-v1";
  featureNames: Array<keyof RaceMlFeatures>;
  means: number[];
  scales: number[];
  coefficients: number[];
  lambda: number;
  sampleCount: number;
}

export interface RaceResidualRidgeConfig {
  minimumSamples: number;
  lambda: number;
  maximumCorrectionFraction: number;
}

export const defaultRaceResidualRidgeConfig: RaceResidualRidgeConfig = {
  minimumSamples: 12,
  lambda: 2,
  maximumCorrectionFraction: 0.12
};

const featureNames: Array<keyof RaceMlFeatures> = [
  "logPredictedSeconds",
  "readiness",
  "conditionAdjustmentFraction",
  "performanceVdot",
  "vo2Gap",
  "isTenK",
  "isHalfMarathon"
];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function distanceFlags(distance: RaceDistance): { isTenK: number; isHalfMarathon: number } {
  return {
    isTenK: distance === "ten_k" ? 1 : 0,
    isHalfMarathon: distance === "half_marathon" ? 1 : 0
  };
}

export function buildRaceMlFeatures(
  prediction: RaceTimePrediction,
  performanceVdot: PerformanceVdotEstimate,
  vo2Max: Vo2MaxEstimate
): RaceMlFeatures {
  if (prediction.predictedSeconds === null || prediction.predictedSeconds <= 0) {
    throw new Error("Available race prediction is required for ML features");
  }
  const totalConditionAdjustment =
    (prediction.environmentAdjustmentSeconds ?? 0) +
    (prediction.elevationAdjustmentSeconds ?? 0) +
    (prediction.fatigueAdjustmentSeconds ?? 0);
  const flags = distanceFlags(prediction.distance);
  return {
    logPredictedSeconds: Math.log(prediction.predictedSeconds),
    readiness: prediction.readiness ?? 0.5,
    conditionAdjustmentFraction: totalConditionAdjustment / prediction.predictedSeconds,
    performanceVdot: performanceVdot.value ?? 40,
    vo2Gap:
      vo2Max.valueMlKgMin === null || performanceVdot.value === null
        ? 0
        : vo2Max.valueMlKgMin - performanceVdot.value,
    ...flags
  };
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index] ?? 0]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]?.[column] ?? 0) > Math.abs(augmented[pivot]?.[column] ?? 0)) {
        pivot = row;
      }
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const pivotValue = augmented[column]?.[column] ?? 0;
    if (Math.abs(pivotValue) < 1e-10) throw new Error("Ridge system is singular");
    for (let index = column; index <= size; index += 1) {
      augmented[column]![index] = (augmented[column]?.[index] ?? 0) / pivotValue;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]?.[column] ?? 0;
      for (let index = column; index <= size; index += 1) {
        augmented[row]![index] =
          (augmented[row]?.[index] ?? 0) - factor * (augmented[column]?.[index] ?? 0);
      }
    }
  }
  return augmented.map((row) => row[size] ?? 0);
}

export function fitRaceResidualRidge(
  examples: RaceMlTrainingExample[],
  config: RaceResidualRidgeConfig = defaultRaceResidualRidgeConfig
): RaceResidualRidgeModel | null {
  const usable = examples.filter(
    (example) =>
      Number.isFinite(example.predictedSeconds) &&
      example.predictedSeconds > 0 &&
      Number.isFinite(example.actualSeconds) &&
      example.actualSeconds > 0 &&
      featureNames.every((name) => Number.isFinite(example.features[name]))
  );
  if (usable.length < config.minimumSamples) return null;
  const means = featureNames.map((name) => mean(usable.map((example) => example.features[name])));
  const scales = featureNames.map((name, index) => {
    const center = means[index] ?? 0;
    const variance = mean(usable.map((example) => (example.features[name] - center) ** 2));
    return Math.max(Math.sqrt(variance), 1e-6);
  });
  const rows = usable.map((example) => [
    1,
    ...featureNames.map(
      (name, index) => (example.features[name] - (means[index] ?? 0)) / (scales[index] ?? 1)
    )
  ]);
  const targets = usable.map((example) => Math.log(example.actualSeconds / example.predictedSeconds));
  const size = featureNames.length + 1;
  const xtx = Array.from({ length: size }, () => Array<number>(size).fill(0));
  const xty = Array<number>(size).fill(0);
  for (const [rowIndex, row] of rows.entries()) {
    const target = targets[rowIndex] ?? 0;
    for (let left = 0; left < size; left += 1) {
      xty[left] = (xty[left] ?? 0) + (row[left] ?? 0) * target;
      for (let right = 0; right < size; right += 1) {
        xtx[left]![right] = (xtx[left]?.[right] ?? 0) + (row[left] ?? 0) * (row[right] ?? 0);
      }
    }
  }
  for (let index = 1; index < size; index += 1) {
    xtx[index]![index] = (xtx[index]?.[index] ?? 0) + config.lambda;
  }
  return {
    version: "race-residual-ridge-v1",
    featureNames: [...featureNames],
    means,
    scales,
    coefficients: solveLinearSystem(xtx, xty),
    lambda: config.lambda,
    sampleCount: usable.length
  };
}

export function predictRaceResidual(
  model: RaceResidualRidgeModel,
  features: RaceMlFeatures
): number {
  const standardized = model.featureNames.map(
    (name, index) => (features[name] - (model.means[index] ?? 0)) / (model.scales[index] ?? 1)
  );
  return (model.coefficients[0] ?? 0) + standardized.reduce(
    (sum, value, index) => sum + value * (model.coefficients[index + 1] ?? 0),
    0
  );
}

export function applyRaceResidualRidge(
  prediction: RaceTimePrediction,
  model: RaceResidualRidgeModel,
  features: RaceMlFeatures,
  config: RaceResidualRidgeConfig = defaultRaceResidualRidgeConfig
): RaceTimePrediction {
  if (prediction.status !== "available" || prediction.predictedSeconds === null) {
    return prediction;
  }
  const rawFraction = Math.exp(predictRaceResidual(model, features)) - 1;
  const correctionFraction = clamp(
    rawFraction,
    -config.maximumCorrectionFraction,
    config.maximumCorrectionFraction
  );
  const correctionMultiplier = 1 + correctionFraction;
  const adjustment = prediction.predictedSeconds * correctionFraction;
  const shift = (value: number | null): number | null =>
    value === null ? null : Math.max(1, value * correctionMultiplier);
  const confidence = clamp(
    prediction.confidence + 0.04 * (1 - Math.exp(-model.sampleCount / 12)),
    0,
    0.95
  );
  const confidenceLevel = confidence >= 0.8 ? "high" : confidence >= 0.55 ? "moderate" : "low";
  return {
    ...prediction,
    predictedSeconds: Math.max(1, prediction.predictedSeconds + adjustment),
    optimisticSeconds: shift(prediction.optimisticSeconds),
    pessimisticSeconds: shift(prediction.pessimisticSeconds),
    machineLearningAdjustmentSeconds:
      (prediction.machineLearningAdjustmentSeconds ?? 0) + adjustment,
    confidence,
    confidenceLevel,
    method: "ridge_ensemble_v5",
    evidenceCodes: [
      ...new Set<PhysiologyEvidenceCode>([
        ...prediction.evidenceCodes,
        "ridge_residual_model"
      ])
    ]
  };
}
