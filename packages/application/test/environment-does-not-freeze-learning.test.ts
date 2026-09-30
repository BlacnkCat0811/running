import assert from "node:assert/strict";
import test from "node:test";

import type { WorkoutFeatureVector } from "@rai/contracts";
import { defaultFeatureConfig, extractWorkoutFeatureVectorV4, projectFeatureV4, type WorkoutFeatureSource } from "@rai/features";
import { defaultRaiModelConfig, scoreFeature, updateTrueAbilityFromFeatureScore, type PersonalBaseline } from "@rai/scoring";

/**
 * §16.1 的 F07 + §18.5-1 的伴生断言。
 *
 * 设计里最容易被"看起来解决了"糊弄过去的一条是：**负向 TA 学习不得以 `environmentAdjusted=true` 为前置**。
 * 缺天气的那次训练如果永远不能下调能力，系统就只会升不会降（§6.9 的棘轮风险）。
 *
 * 这条测试不靠"搜索代码里没有 environmentAdjusted 这个词"来证明（那正是设计 §13.4 (5) 点名的假断言），
 * 而是走真实链路：**同一份训练证据、只换环境上下文** ⇒ 投影出的评分输入必须逐位相同，
 * 且两种环境状态下的负向学习必须同样被接受。
 */

const source = (environment?: WorkoutFeatureSource["environment"]): WorkoutFeatureSource => ({
  id: "w",
  trainingSessionId: "s",
  trainingSessionStatus: "active",
  workoutStartAt: "2026-01-01T00:00:00Z",
  workoutEndAt: "2026-01-01T01:00:00Z",
  durationSeconds: 3600,
  distanceKm: 10,
  indoor: false,
  sourceCategory: "apple_watch",
  routePointCount: 10,
  routeQuality: 1,
  speed: { average: 2.5, minimum: 2.5, maximum: 2.5, sampleCount: 60, firstAt: null, lastAt: null, coefficientOfVariation: 0 },
  heartRate: { average: 150, minimum: 150, maximum: 150, sampleCount: 60, firstAt: null, lastAt: null, coefficientOfVariation: 0, coveredDurationSeconds: 3600 },
  speedSamples: [{ value: 2.5, startOffsetSeconds: 0, durationSeconds: 3600 }],
  heartRateSamples: [{ value: 150, startOffsetSeconds: 0, durationSeconds: 3600 }],
  restingHeartRate: 50,
  restingHeartRateReference: 50,
  hrvSdnn: 50,
  sleepDurationMinutes: 420,
  recentLoadMinutes: 100,
  observedMaximumHeartRate: 190,
  override: null,
  ...(environment === undefined ? {} : { environment })
});

const extract = (environment?: WorkoutFeatureSource["environment"]): WorkoutFeatureVector =>
  projectFeatureV4(extractWorkoutFeatureVectorV4("f", "run", source(environment), defaultFeatureConfig, "2026-01-02T00:00:00Z"));

/** 三个维度都远低于基线中心 ⇒ 观测表现明显低于 TA=70，是一次"变差"的观测。 */
const baseline: PersonalBaseline = {
  calibrationFeatureIds: ["calibration"],
  calibrationStartAt: "2025-12-01T00:00:00.000Z",
  calibrationEndAt: "2025-12-15T00:00:00.000Z",
  dimensions: {
    efficiency: { center: 0.03, scale: 0.003 },
    pace: { center: 3.5, scale: 0.3 },
    stability: { center: 1.2, scale: 0.2 }
  }
};

// §6.2 的可比性按分桶检查，所以这里先声明一个成熟的历史。
const MATURE_HISTORY = { independentSessions: 24, spanDays: 90 };

test("F07: environment knowledge never changes the scoring inputs", () => {
  const known = extract({ temperatureC: 15, humidityPercent: 50, elevationGainMeters: 0 });
  const unknown = extract();

  // 前提：两次确实处在不同的环境状态，否则下面的"相同"是因为两条支路本就一样。
  const statusOf = (feature: WorkoutFeatureVector): string | undefined =>
    (feature.provenance.featurePayloadV4 as { normalization?: { status?: string } } | undefined)?.normalization?.status;
  assert.equal(statusOf(known), "not_needed");
  assert.equal(statusOf(unknown), "unavailable");

  assert.deepEqual(known.signals, unknown.signals);
});

test("F07: a high-quality negative observation is accepted whether or not the environment is known", () => {
  const scores = [
    { label: "not_needed", feature: extract({ temperatureC: 15, humidityPercent: 50, elevationGainMeters: 0 }) },
    { label: "unavailable", feature: extract() }
  ].map(({ label, feature }) => ({
    label,
    score: scoreFeature(feature, baseline, 1, MATURE_HISTORY)
  }));

  for (const { label, score } of scores) {
    assert.notEqual(score.learningObservation, null, `${label}: 这次训练必须能形成学习观测`);
    assert.ok(
      (score.learningObservation ?? 100) < 70,
      `${label}: 夹具必须真的是一次"变差"的观测，否则这条测试什么都没测`
    );
  }
  // 两种环境状态给出同一个学习目标：环境状态不是学习门控的输入。
  assert.equal(scores[0]!.score.learningObservation, scores[1]!.score.learningObservation);
  assert.equal(scores[0]!.score.confidenceV2.evidenceReliability, scores[1]!.score.confidenceV2.evidenceReliability);

  // 连续两次合格负残差 ⇒ 两次都必须下调，且下调幅度相同。
  for (const { label, score } of scores) {
    const first = updateTrueAbilityFromFeatureScore(70, 30, score, defaultRaiModelConfig, 0);
    assert.equal(first.updated, false, `${label}: 第一次负残差只登记`);
    const second = updateTrueAbilityFromFeatureScore(70, 30, score, defaultRaiModelConfig, first.pendingNegativeConfirmations);
    assert.equal(second.updated, true, `${label}: 第二次负残差必须被接受，环境未知不得冻结下调`);
    assert.ok(second.nextTrueAbility < 70, `${label}: TA 必须真的下降`);
  }
  const known = updateTrueAbilityFromFeatureScore(70, 30, scores[0]!.score, defaultRaiModelConfig, 1);
  const unknown = updateTrueAbilityFromFeatureScore(70, 30, scores[1]!.score, defaultRaiModelConfig, 1);
  assert.equal(known.nextTrueAbility, unknown.nextTrueAbility);
});
