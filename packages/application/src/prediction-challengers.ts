import { existsSync, readFileSync, statSync } from "node:fs";
import { compareResidualChallengers, type EvaluationCase } from "@rai/model-eval";
import type { RaceDistance } from "@rai/contracts";

/**
 * §12.3 / §17.5 —— 三方残差竞争（baseline / ridge / catboost）的**唯一入口**。
 *
 * 为什么要有这个文件：Python runner 与 TypeScript 评估此前各自算过一套候选指标
 * （Python 侧有 `ridgeChallenger.releaseHoldout`，TS 侧有 `compareResidualChallengers`），
 * 但**没有喂进同一批样本**。两套数字都"看起来通过"，却回答不了同一个问题：
 * 在同一批事件、同一个 as-of 上，CatBoost 是否同时优于基线与 Ridge。
 *
 * 这里只做两件事：**读懂** Python 产出的同一份样本表，**交给** `@rai/model-eval`
 * 既有的门槛函数。**不在此处重写任何门槛** —— 门槛只应有一份实现。
 */

export const RESIDUAL_CHALLENGERS_VERSION = "rai-residual-challengers-v1" as const;

const DISTANCES: readonly RaceDistance[] = ["five_k", "ten_k", "half_marathon"];

const BASELINE_COLUMN = "baselinePredictedSeconds";
const RIDGE_COLUMN = "ridgePredictedSeconds";
const CATBOOST_COLUMN = "catboostPredictedSeconds";
const PREDICTION_COLUMNS = [BASELINE_COLUMN, RIDGE_COLUMN, CATBOOST_COLUMN] as const;

export interface ResidualChallengerCase {
  eventId: string;
  distance: RaceDistance;
  predictedAt: string;
  outcomeAt: string;
  availableAt: string;
  actualSeconds: number;
}

export interface ResidualChallengerImport {
  version: typeof RESIDUAL_CHALLENGERS_VERSION;
  predictorVersion: string;
  ridgeVersion: string;
  /** 计算这批预测时的 as-of（Python 侧取训练标签截止时间）。 */
  asOf: string;
  partition: string;
  caseCount: number;
  caseCountByDistance: Record<RaceDistance, number>;
  /** 逐事件对齐的同一份样本表，用于报告里的样本流失说明。 */
  cases: ResidualChallengerCase[];
  /** 至少缺一个预测的列名。非空 ⇒ 三方对比必然 `not_evaluable`。 */
  incompletePredictionColumns: string[];
  baseline: EvaluationCase[];
  ridge: EvaluationCase[];
  catboost: EvaluationCase[];
}

function instant(name: string, value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Challenger document has an invalid ${name}`);
  }
  return value;
}

function positiveSeconds(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Challenger document has a non-positive ${name}`);
  }
  return value;
}

function optionalSeconds(name: string, value: unknown): number | null {
  // 缺失的挑战者列必须是 null：0 会被读成"完美预测"，Infinity 会被读成"无限差"，
  // 两者都是用一个数去表达"这个候选没有给出预测"这件不同的事。
  if (value === null || value === undefined) return null;
  return positiveSeconds(name, value);
}

function nonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Challenger document has an invalid ${name}`);
  }
  return value;
}

/**
 * 把 Python 的 `challengers.json` 读成三列 `EvaluationCase`。
 * 契约不符即抛错：宁可拒绝评估，也不要拿一份错位的表算出"通过"。
 */
export function readResidualChallengerImport(value: unknown): ResidualChallengerImport {
  if (typeof value !== "object" || value === null) throw new Error("Challenger document must be an object");
  const document = value as Record<string, unknown>;
  if (document.challengersVersion !== RESIDUAL_CHALLENGERS_VERSION) {
    throw new Error(`Unsupported challenger document version: ${String(document.challengersVersion)}`);
  }
  const predictorVersion = nonEmptyString("predictorVersion", document.predictorVersion);
  const ridgeVersion = nonEmptyString("ridgeVersion", document.ridgeVersion);
  const partition = nonEmptyString("partition", document.partition);
  const asOf = instant("asOf", document.asOf);
  if (!Array.isArray(document.cases) || document.cases.length === 0) {
    throw new Error("Challenger document has no cases");
  }
  if (document.caseCount !== document.cases.length) {
    throw new Error("Challenger caseCount does not match its cases");
  }

  const cases: ResidualChallengerCase[] = [];
  const baseline: EvaluationCase[] = [];
  const ridge: EvaluationCase[] = [];
  const catboost: EvaluationCase[] = [];
  const seen = new Set<string>();
  const incomplete = new Set<string>();
  const caseCountByDistance: Record<RaceDistance, number> = { five_k: 0, ten_k: 0, half_marathon: 0 };

  for (const raw of document.cases) {
    if (typeof raw !== "object" || raw === null) throw new Error("Challenger case must be an object");
    const row = raw as Record<string, unknown>;
    const eventId = nonEmptyString("eventId", row.eventId);
    if (seen.has(eventId)) throw new Error(`Duplicate challenger event: ${eventId}`);
    seen.add(eventId);
    const distance = row.distance;
    if (typeof distance !== "string" || !DISTANCES.includes(distance as RaceDistance)) {
      throw new Error(`Unsupported challenger distance: ${String(distance)}`);
    }
    const base: ResidualChallengerCase = {
      eventId,
      distance: distance as RaceDistance,
      predictedAt: instant("predictedAt", row.predictedAt),
      outcomeAt: instant("outcomeAt", row.outcomeAt),
      availableAt: instant("availableAt", row.availableAt),
      actualSeconds: positiveSeconds("actualSeconds", row.actualSeconds)
    };
    caseCountByDistance[base.distance] += 1;
    cases.push(base);

    const columns: Record<(typeof PREDICTION_COLUMNS)[number], number | null> = {
      [BASELINE_COLUMN]: optionalSeconds(BASELINE_COLUMN, row[BASELINE_COLUMN]),
      [RIDGE_COLUMN]: optionalSeconds(RIDGE_COLUMN, row[RIDGE_COLUMN]),
      [CATBOOST_COLUMN]: optionalSeconds(CATBOOST_COLUMN, row[CATBOOST_COLUMN])
    };
    // baseline 缺失不是"候选缺预测"，而是这份文档本身不成立：没有基线就没有可比较的对象。
    if (columns[BASELINE_COLUMN] === null) {
      throw new Error(`Challenger case ${eventId} has no baseline prediction`);
    }
    for (const column of PREDICTION_COLUMNS) {
      if (columns[column] === null) incomplete.add(column);
    }
    const toCase = (predictedSeconds: number | null): EvaluationCase | null =>
      predictedSeconds === null
        ? null
        : {
            eventId: base.eventId,
            distance: base.distance,
            predictedAt: base.predictedAt,
            outcomeAt: base.outcomeAt,
            availableAt: base.availableAt,
            actualSeconds: base.actualSeconds,
            predictedSeconds
          };
    baseline.push(toCase(columns[BASELINE_COLUMN])!);
    const ridgeCase = toCase(columns[RIDGE_COLUMN]);
    if (ridgeCase) ridge.push(ridgeCase);
    const catboostCase = toCase(columns[CATBOOST_COLUMN]);
    if (catboostCase) catboost.push(catboostCase);
  }

  const incompletePredictionColumns = [...incomplete].sort();
  const declared = document.incompletePredictionColumns;
  if (!Array.isArray(declared) || declared.some((name) => typeof name !== "string")) {
    throw new Error("Challenger document must declare incompletePredictionColumns");
  }
  // 声明的完整性与数据必须一致：否则一份"声明齐全但带 null"的文档就能绕过缺列检测。
  const declaredSorted = [...(declared as string[])].sort();
  if (
    declaredSorted.length !== incompletePredictionColumns.length ||
    declaredSorted.some((name, index) => name !== incompletePredictionColumns[index])
  ) {
    throw new Error("Challenger incompletePredictionColumns does not match its cases");
  }

  return {
    version: RESIDUAL_CHALLENGERS_VERSION,
    predictorVersion,
    ridgeVersion,
    asOf,
    partition,
    caseCount: cases.length,
    caseCountByDistance,
    cases,
    incompletePredictionColumns,
    baseline,
    ridge,
    catboost
  };
}

/**
 * 只负责"读文件 + JSON 解析"，返回**原始**文档。
 * 校验一律由 `readResidualChallengerImport` 做一次 —— 若这里也返回已导入的结构，
 * 调用方再传给评估函数时校验就会跑在转换后的对象上，等于没有校验。
 *
 * 但"是不是一个文件"必须在读之前判掉。2026-09-30 的独立审计复现了原来的失败模式：
 * CLI 未传 `--challengers` 时 `optionValue(..., "")` 返回空串，`resolve("")` 得到**当前目录**，
 * `existsSync(CWD)` 为真于是守卫放行，`readFileSync` 才抛 `EISDIR` ——
 * 报出来的是"对目录调了读"，而不是"你没给文件"。目录存在不等于文件存在。
 */
export function parseResidualChallengerFile(path: string): unknown {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("Challengers document requires a file path (got an empty path)");
  }
  if (!existsSync(path)) throw new Error(`Challengers document not found: ${path}`);
  if (!statSync(path).isFile()) {
    throw new Error(`Challengers document must be a file, not a directory: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export interface ResidualChallengerPolicy {
  minimumSamples: number;
  minimumImprovement: number;
  maximumDistanceRegression: number;
}

/**
 * 用同一批样本跑 `@rai/model-eval` 既有的三方门槛。
 *
 * 缺列时**不**构造一个"无限差"的候选：把该列置空，让 `compareResidualChallengers`
 * 自己那条"缺一列即 `not_evaluable` 且 `blocksActivation`"的规则生效。
 * 这样"缺数据"与"更差"在结果里是两个可区分的事实。
 */
export function evaluateResidualChallengers(input: {
  document: unknown;
  policy: ResidualChallengerPolicy;
}) {
  const imported = readResidualChallengerImport(input.document);
  const comparison = compareResidualChallengers({
    baseline: imported.baseline,
    ridge: imported.incompletePredictionColumns.includes(RIDGE_COLUMN) ? [] : imported.ridge,
    catboost: imported.incompletePredictionColumns.includes(CATBOOST_COLUMN) ? [] : imported.catboost,
    asOf: imported.asOf,
    minimumSamples: input.policy.minimumSamples,
    minimumImprovement: input.policy.minimumImprovement,
    maximumDistanceRegression: input.policy.maximumDistanceRegression
  });
  return {
    version: RESIDUAL_CHALLENGERS_VERSION,
    predictorVersion: imported.predictorVersion,
    ridgeVersion: imported.ridgeVersion,
    partition: imported.partition,
    asOf: imported.asOf,
    caseCount: imported.caseCount,
    caseCountByDistance: imported.caseCountByDistance,
    incompletePredictionColumns: imported.incompletePredictionColumns,
    ...comparison
  };
}
