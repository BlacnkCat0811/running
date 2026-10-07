import assert from "node:assert/strict";
import test from "node:test";

import { assessDatedReadiness, type DatedRecoverySignal } from "@rai/readiness";

import { decideVerdict, decideVerdictFromSnapshots, type CoachInput } from "../src/mobile-coach.js";

/**
 * §16.1 的 C01 + §13.4 的委托约束。
 *
 * 本仓没有 i18n 层，所以"更换显示语言"在这里的**可检验等价物**是：
 * **两个消费方（原始读数入口 / 快照入口）对同一份证据必须给出同一个结论与同一组理由码。**
 * 这正是 §13.3 要求的"可以有不同的措辞，但结论和参数必须一致"。
 *
 * 这条测试盯的是一个**此前完全没有直接覆盖**的生产入口：`decideVerdictFromSnapshots`
 * 只被 `mobile-read.ts` 调用，映射写错了只有 E2E 才可能发现。
 * 阈值不在测试里重写 —— 快照一律由规则所有者 `assessDatedReadiness` 产出。
 */

const base = (): CoachInput => ({
  today: "2026-09-03",
  latestDataDate: "2026-09-03",
  recoveryEvidenceDate: "2026-09-03",
  recoveryEvidenceStatus: "valid",
  calibration: "completed",
  eligibleSessions: 20,
  trueAbility: 44,
  currentAbility: 43.5,
  changeFrom7DaysAgo: 0.2,
  growthVelocityPerWeek: 0.1,
  decayPoints: 0,
  snapshotDate: "2026-09-03",
  explanationCodes: [],
  trainingStatus: "effective_stimulus",
  loadRatio: 1.05,
  rampRate: 0.1,
  strain: 40,
  strainP90: 80,
  monotony: 1.2,
  recoveryEvidence: 0.7,
  lastNightSleepMinutes: 420,
  sleepBaselineMinutes: 430,
  nightsBelowSleepBaseline: 0,
  morningHrvMs: 50,
  hrvBaselineMs: 52,
  restingHeartRateBpm: 52,
  restingHeartRateBaselineBpm: 53,
  consecutiveQualityDays: 0,
  daysSinceLastRun: 1,
  daysSinceLastQuality: 3,
  weekDistanceKm: 18,
  weekDurationSeconds: 7200,
  weekEasyDurationSeconds: 5400,
  weekQualityCount: 0,
  weeklyVolumeCeilingKm: 30,
  easyDurationFloorFraction: 0.7,
  qualitySessionCap: 2,
  fourWeekDistanceChangeFraction: 0.1,
  previousWeekDistanceKm: 20,
  currentWeekDistanceKm: 18,
  longestRun8WeekKm: 16,
  latestLongRunKm: 14,
  intendedEasyCount: 3,
  easyEnoughCount: 3,
  latestWorkout: null,
  todayWorkoutCount: 0,
  storedWeekPlan: [],
  lockedSession: null,
  zones: {
    easyPaceLower: 330,
    easyPaceUpper: 390,
    easyHrLower: 120,
    easyHrUpper: 145,
    thresholdPaceLower: 270,
    thresholdPaceUpper: 300,
    thresholdHrLower: 160,
    thresholdHrUpper: 172,
    intervalPaceLower: 240,
    intervalPaceUpper: 265
  },
  raceTarget: null,
  raceShapeScore: 0.6,
  raceVolumeFraction: 0.7,
  raceLongRunFraction: 0.8,
  weekDaily: []
});

const LOCAL_DATE = "2026-09-03";

/** 只保留决策合同里允许的字段；恢复原始读数一律由调用方剔除（§13.1）。 */
function snapshotContext(input: CoachInput) {
  const {
    lastNightSleepMinutes: _sleep, sleepBaselineMinutes: _sleepBaseline,
    morningHrvMs: _hrv, hrvBaselineMs: _hrvBaseline,
    restingHeartRateBpm: _rhr, restingHeartRateBaselineBpm: _rhrBaseline,
    nightsBelowSleepBaseline: _nights, recoveryEvidenceDate: _date,
    recoveryEvidenceStatus: _status,
    ...context
  } = input;
  return context;
}

const dayBefore = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
};

function readinessFor(
  readings: { sleep: [number, number]; hrv: [number, number]; rhr: [number, number] },
  nightsBelow: number
) {
  const at = `${LOCAL_DATE}T06:00:00.000Z`;
  const signal = (pair: [number, number], localDate: string): DatedRecoverySignal => ({
    value: pair[0], baseline: pair[1], observedAt: at, availableAt: at,
    localDate, availabilitySource: "canonical_computation"
  });
  // `nights` 必须自带日期：连续性是规则所有者自己按日期证明的，不接受预算好的计数。
  const nights: DatedRecoverySignal[] = Array.from({ length: nightsBelow }, (_, index) => ({
    value: 300, baseline: 430, observedAt: at, availableAt: at,
    localDate: dayBefore(LOCAL_DATE, nightsBelow - index - 1),
    availabilitySource: "canonical_computation"
  }));
  return assessDatedReadiness({
    asOf: `${LOCAL_DATE}T08:00:00.000Z`,
    localDate: LOCAL_DATE,
    signals: {
      sleep: signal(readings.sleep, LOCAL_DATE),
      hrv: signal(readings.hrv, LOCAL_DATE),
      rhr: signal(readings.rhr, LOCAL_DATE)
    },
    nights
  });
}

const rawInput = (
  readings: { sleep: [number, number]; hrv: [number, number]; rhr: [number, number] },
  nightsBelow: number
): CoachInput => ({
  ...base(),
  lastNightSleepMinutes: readings.sleep[0],
  sleepBaselineMinutes: readings.sleep[1],
  morningHrvMs: readings.hrv[0],
  hrvBaselineMs: readings.hrv[1],
  restingHeartRateBpm: readings.rhr[0],
  restingHeartRateBaselineBpm: readings.rhr[1],
  nightsBelowSleepBaseline: nightsBelow
});

const HEALTHY = { sleep: [420, 430] as [number, number], hrv: [50, 52] as [number, number], rhr: [52, 53] as [number, number] };
const POOR = { sleep: [300, 430] as [number, number], hrv: [40, 52] as [number, number], rhr: [56, 53] as [number, number] };
// 单信号病例是**必需的**：只测"三个一起低"时，把 hrvLow 与 rhrLow 接反也照样通过
// （这一点是被突变验证抓出来的 —— 最初的用例集就是没牙齿的）。
const HRV_ONLY = { sleep: [420, 430] as [number, number], hrv: [40, 52] as [number, number], rhr: [52, 53] as [number, number] };
const RHR_ONLY = { sleep: [420, 430] as [number, number], hrv: [50, 52] as [number, number], rhr: [56, 53] as [number, number] };
const SLEEP_ONLY = { sleep: [300, 430] as [number, number], hrv: [50, 52] as [number, number], rhr: [52, 53] as [number, number] };

test("C01: the raw-reading entry and the snapshot entry reach the same conclusion", () => {
  for (const [label, readings, nightsBelow] of [
    ["no low signal", HEALTHY, 0],
    ["sleep only", SLEEP_ONLY, 0],
    ["hrv only", HRV_ONLY, 0],
    ["rhr only", RHR_ONLY, 0],
    ["multiple low signals", POOR, 3]
  ] as const) {
    const legacy = decideVerdict(rawInput(readings, nightsBelow));
    const readiness = readinessFor(readings, nightsBelow);
    const fromSnapshot = decideVerdictFromSnapshots(snapshotContext(rawInput(readings, nightsBelow)), readiness);
    assert.equal(fromSnapshot.tone, legacy.tone, `${label}: 两个入口的 tone 必须一致`);
    assert.deepEqual(fromSnapshot.reasonCodes, legacy.reasonCodes, `${label}: 理由码也必须一致`);
  }
});

test("C01: the three single-signal fixtures are distinguishable from each other (fixture guard)", () => {
  // 这条**只是夹具守卫**：三个病例必须各自只点亮一个通道。
  // 否则"把 hrvLow 与 rhrLow 接反"这类映射错误会在上一条里悄悄通过 ——
  // 最初的用例集就只有"三个一起低"，突变验证证明它是没牙齿的。
  //
  // 注意这里断言的是**信号标记**，不是最终 tone：单独一个 RHR 升高按设计就不升级
  // （readiness 自己的用例已经写明"a lone raised resting heart rate ... does not by itself escalate"），
  // 所以"每个单信号病例都要与健康日不同色"是个过强的夹具假设。
  const signatures = [SLEEP_ONLY, HRV_ONLY, RHR_ONLY].map((readings) => {
    const snapshot = readinessFor(readings, 0);
    return [snapshot.signals.sleep.low, snapshot.signals.hrv.low, snapshot.signals.rhr.low].join(",");
  });
  assert.deepEqual(signatures, ["true,false,false", "false,true,false", "false,false,true"]);
});

test("R01/C01: a snapshot with no evidence cannot be talked into a verdict by smuggled raw readings", () => {
  // 调用方若把完整的 CoachInput 展开传进来，原始读数会在入口处被清空：快照是唯一依据。
  const healthy = readinessFor(HEALTHY, 0);
  const clean = decideVerdictFromSnapshots(snapshotContext(rawInput(HEALTHY, 0)), healthy);
  const smuggled = decideVerdictFromSnapshots(
    { ...snapshotContext(rawInput(HEALTHY, 0)), lastNightSleepMinutes: 5, morningHrvMs: 5, restingHeartRateBpm: 90 } as never,
    healthy
  );
  assert.deepEqual(smuggled, clean);
});

test("R01: a day with no assessable recovery is not assessed, and is not reported as low", () => {
  const none = assessDatedReadiness({
    asOf: `${LOCAL_DATE}T08:00:00.000Z`,
    localDate: LOCAL_DATE,
    signals: {
      sleep: { value: null, baseline: 430, observedAt: null, availableAt: null, localDate: null },
      hrv: { value: null, baseline: 52, observedAt: null, availableAt: null, localDate: null },
      rhr: { value: null, baseline: 53, observedAt: null, availableAt: null, localDate: null }
    },
    nights: []
  });
  assert.equal(none.coverage, "none");
  assert.equal(none.assessment, "not_assessed");
  assert.equal(none.score, null);

  const verdict = decideVerdictFromSnapshots(snapshotContext(rawInput(HEALTHY, 0)), none);
  // 没有证据时不能自动红：那会把"没测到"变成健康结论。
  assert.notEqual(verdict.tone, "red");
  // 但缺失必须**被说出来**，不能悄悄当作"恢复没问题"。
  const codes = verdict.reasonCodes;
  assert.ok(codes !== undefined, "理由码必须被显式给出，而不是留给消费方猜");
  assert.ok(codes.includes("recovery_evidence_absent"));
  assert.match(verdict.reason, /未结合今日恢复监测/);
  // 也绝不能反过来把缺数据写成"恢复很好"。
  assert.doesNotMatch(verdict.reason, /恢复良好|恢复充分|已恢复/);
});
