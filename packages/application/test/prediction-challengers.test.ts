import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  RESIDUAL_CHALLENGERS_VERSION,
  evaluateResidualChallengers,
  parseResidualChallengerFile,
  readResidualChallengerImport
} from "../src/prediction-challengers.js";

const POLICY = { minimumSamples: 1, minimumImprovement: 0.05, maximumDistanceRegression: 0.05 };
const AS_OF = "2026-03-01T00:00:00.000Z";

interface Row {
  eventId: string;
  distance: "five_k" | "ten_k" | "half_marathon";
  actualSeconds: number;
  baselinePredictedSeconds: number | null;
  ridgePredictedSeconds: number | null;
  catboostPredictedSeconds: number | null;
}

function document(rows: Row[], declaredIncomplete: string[] = []) {
  return {
    challengersVersion: RESIDUAL_CHALLENGERS_VERSION,
    predictorVersion: "race-residual-catboost-v4",
    ridgeVersion: "race-residual-ridge-v1",
    asOf: AS_OF,
    partition: "release_holdout",
    caseCount: rows.length,
    incompletePredictionColumns: declaredIncomplete,
    cases: rows.map((row, index) => ({
      eventId: row.eventId,
      distance: row.distance,
      predictedAt: `2026-02-0${index + 1}T00:00:00.000Z`,
      outcomeAt: `2026-02-0${index + 1}T00:30:00.000Z`,
      availableAt: `2026-02-0${index + 1}T01:00:00.000Z`,
      actualSeconds: row.actualSeconds,
      baselinePredictedSeconds: row.baselinePredictedSeconds,
      ridgePredictedSeconds: row.ridgePredictedSeconds,
      catboostPredictedSeconds: row.catboostPredictedSeconds
    }))
  };
}

const WINNING: Row[] = [
  { eventId: "e-5k", distance: "five_k", actualSeconds: 1_500, baselinePredictedSeconds: 1_600, ridgePredictedSeconds: 1_560, catboostPredictedSeconds: 1_510 },
  { eventId: "e-10k", distance: "ten_k", actualSeconds: 3_000, baselinePredictedSeconds: 3_200, ridgePredictedSeconds: 3_120, catboostPredictedSeconds: 3_020 },
  { eventId: "e-hm", distance: "half_marathon", actualSeconds: 7_200, baselinePredictedSeconds: 7_600, ridgePredictedSeconds: 7_400, catboostPredictedSeconds: 7_220 }
];

test("D8: three challengers on one sample table pass only when CatBoost beats both", () => {
  const result = evaluateResidualChallengers({ document: document(WINNING), policy: POLICY });
  assert.equal(result.status, "passed");
  assert.equal(result.blocksActivation, false);
  assert.deepEqual(result.incompletePredictionColumns, []);
  assert.equal(result.caseCount, 3);
  assert.deepEqual(result.caseCountByDistance, { five_k: 1, ten_k: 1, half_marathon: 1 });
  assert.equal(result.partition, "release_holdout");
  assert.equal(result.asOf, AS_OF);
});

test("D8: a CatBoost column equal to the baseline cannot pass by standing still", () => {
  const tied = WINNING.map((row) => ({ ...row, catboostPredictedSeconds: row.baselinePredictedSeconds }));
  const result = evaluateResidualChallengers({ document: document(tied), policy: POLICY });
  assert.equal(result.status, "failed");
  assert.equal(result.blocksActivation, true);
  assert.ok(result.reasonCodes.includes("overall_not_better_than_baseline"));
});

test("D8: a missing Ridge column is not_evaluable and blocks activation, not an infinite error", () => {
  const partial = WINNING.map((row, index) =>
    index === 1 ? { ...row, ridgePredictedSeconds: null } : row
  );
  const result = evaluateResidualChallengers({
    document: document(partial, ["ridgePredictedSeconds"]),
    policy: POLICY
  });
  assert.equal(result.status, "not_evaluable");
  assert.equal(result.blocksActivation, true);
  assert.ok(result.reasonCodes.includes("missing_challenger_predictions"));
  assert.deepEqual(result.incompletePredictionColumns, ["ridgePredictedSeconds"]);
  // 缺列时不得给出任何"哪一方更好"的指标：没有样本就没有排名。
  assert.equal("metrics" in result, false);
});

test("D8: a document cannot declare itself complete while carrying a null column", () => {
  const partial = WINNING.map((row, index) =>
    index === 1 ? { ...row, ridgePredictedSeconds: null } : row
  );
  assert.throws(
    () => readResidualChallengerImport(document(partial, [])),
    /incompletePredictionColumns does not match/
  );
});

test("D8: a null baseline rejects the document instead of acting as a missing challenger", () => {
  const broken = WINNING.map((row, index) =>
    index === 0 ? { ...row, baselinePredictedSeconds: null } : row
  );
  assert.throws(
    () => readResidualChallengerImport(document(broken, ["baselinePredictedSeconds"])),
    /has no baseline prediction/
  );
});

test("D8: a zero prediction is rejected rather than read as a perfect forecast", () => {
  const broken = WINNING.map((row, index) =>
    index === 0 ? { ...row, ridgePredictedSeconds: 0 } : row
  );
  assert.throws(
    () => readResidualChallengerImport(document(broken, ["ridgePredictedSeconds"])),
    /non-positive ridgePredictedSeconds/
  );
});

test("D8: duplicate events cannot be counted twice towards the sample minimum", () => {
  const duplicated = [...WINNING, { ...WINNING[0]! }];
  assert.throws(
    () => readResidualChallengerImport(document(duplicated)),
    /Duplicate challenger event/
  );
});

test("D8: an outcome that arrived after the documented as-of is refused", () => {
  const late = document(WINNING);
  late.cases[0]!.availableAt = "2026-04-01T00:00:00.000Z";
  assert.throws(
    () => evaluateResidualChallengers({ document: late, policy: POLICY }),
    /as-of evaluation/
  );
});

test("D8: the importer refuses an unknown document version", () => {
  assert.throws(
    () => readResidualChallengerImport({ ...document(WINNING), challengersVersion: "rai-residual-challengers-v9" }),
    /Unsupported challenger document version/
  );
});

// 2026-09-30 的独立审计复现了这个失败模式：CLI 未传 `--challengers` 时
// `optionValue(..., "")` → `resolve("")` 得到**当前目录**，`existsSync(CWD)` 为真于是守卫放行，
// 最终 `readFileSync` 抛 EISDIR —— 报出来的是"对目录调了读"，而不是"你没给文件"。
// 目录存在不等于文件存在，所以这里把三种输入分开断言。
test("D8: reading a challengers document distinguishes no-path, no-file and not-a-file", () => {
  assert.throws(() => parseResidualChallengerFile(""), /requires a file path/);
  assert.throws(() => parseResidualChallengerFile("   "), /requires a file path/);
  assert.throws(
    () => parseResidualChallengerFile(resolve("var", "definitely-not-here.json")),
    /Challengers document not found/
  );
  // 目录：必须有明确措辞，且**不能**是 EISDIR。
  assert.throws(
    () => parseResidualChallengerFile(resolve("var")),
    (error: unknown) => error instanceof Error
      && /must be a file, not a directory/.test(error.message)
      && !/EISDIR/.test(error.message)
  );
});
