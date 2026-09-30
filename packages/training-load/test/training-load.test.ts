import assert from "node:assert/strict";
import test from "node:test";

import type { HeartRateZone, WorkoutTrainingLoad } from "@rai/contracts";

import {
  HIGH_INTENSITY_MINIMUM_HEART_RATE_COVERAGE,
  LOAD_RISK_BASIS,
  LOAD_VECTOR_V2_VERSION,
  acuteLoadExcess,
  aggregateTrainingPeriod,
  assessLoad,
  assessLoadV2,
  buildDailyTrainingMetrics,
  buildLoadVectorV2,
  buildCalendarPeriodSummary,
  buildRollingPeriodSummary,
  calculateWorkoutTrainingLoad,
  classifyPhysState,
  classifyTrainingStatus,
  countNightsBelowSleepBaseline,
  heartRateReserve,
  latestAcuteChronicLoadRatio,
  localDateInTimeZone,
  periodBounds,
  trimpMinuteLoad
} from "../src/index.js";

const historicalLoad = (
  trainingSessionId: string,
  localDate: string,
  load: number
): WorkoutTrainingLoad => ({
  trainingSessionId,
  localDate,
  durationSeconds: 3600,
  distanceMeters: 10_000,
  load,
  intensity: 0.5,
  source: "session_type",
  confidence: 1,
  rpe: null,
  sessionType: "easy",
  averageHeartRate: null,
  elevationGainMeters: null,
  stimulusType: "aerobic_base",
  breakdown: {
    rawHrrTrimp: null,
    internalLoad: null,
    paceLoad: null,
    distanceReferenceMeters: null,
    distanceExposureRatio: null,
    distanceFactor: 1,
    compositeLoad: load,
    compositeIntensity: 0.5,
    heartRateConfidence: 0,
    paceConfidence: 0
  },
  explanations: []
});

test("clamps HRR and rejects an invalid personal heart-rate range", () => {
  assert.equal(heartRateReserve(40, 50, 190), 0);
  assert.equal(heartRateReserve(210, 50, 190), 1);
  assert.equal(heartRateReserve(150, 190, 190), null);
  assert.equal(trimpMinuteLoad(-1), 0);
});

test("integrates heart-rate samples when coverage is sufficient", () => {
  const result = calculateWorkoutTrainingLoad({
    trainingSessionId: "run-1", localDate: "2026-07-01", durationSeconds: 600,
    restingHeartRate: 50, observedMaxHeartRate: 190, heartRateCoverage: 0.8,
    heartRateSamples: [{ heartRate: 120, durationSeconds: 300 }, { heartRate: 160, durationSeconds: 300 }]
  });
  assert.equal(result?.source, "heart_rate_series");
  assert.equal(result?.intensity, 0.642857);
  assert.equal(result?.confidence, 0.76);
  assert.ok((result?.load ?? 0) > 20);
});

test("falls back to sample coverage when supplied coverage is non-finite", () => {
  const result = calculateWorkoutTrainingLoad({
    trainingSessionId: "run-nan", localDate: "2026-07-01", durationSeconds: 600,
    restingHeartRate: 50, observedMaxHeartRate: 190, heartRateCoverage: Number.NaN,
    heartRateSamples: [{ heartRate: 140, durationSeconds: 500 }]
  });
  assert.equal(result?.source, "heart_rate_series");
});

test("uses average heart rate, RPE, then session type in that order", () => {
  const common = { trainingSessionId: "run", localDate: "2026-07-01", durationSeconds: 3600, restingHeartRate: 50, observedMaxHeartRate: 190 };
  assert.equal(calculateWorkoutTrainingLoad({ ...common, averageHeartRate: 134, rpe: 9, sessionType: "race" })?.source, "average_heart_rate");
  assert.equal(calculateWorkoutTrainingLoad({ ...common, rpe: 5, sessionType: "race" })?.intensity, 0.52);
  assert.equal(calculateWorkoutTrainingLoad({ ...common, sessionType: "easy" })?.intensity, 0.42);
  assert.equal(calculateWorkoutTrainingLoad({ ...common, excluded: true }), null);
});

test("does not extrapolate sparse heart-rate samples from declared coverage", () => {
  const load = calculateWorkoutTrainingLoad({
    trainingSessionId: "sparse-heart-rate",
    localDate: "2026-01-01",
    durationSeconds: 3_600,
    heartRateSamples: [{ heartRate: 190, durationSeconds: 1 }],
    heartRateCoverage: 0.8,
    averageHeartRate: 140,
    restingHeartRate: 50,
    observedMaxHeartRate: 200,
    sourceConfidence: 1
  });

  assert.equal(load?.source, "average_heart_rate");
  assert.ok((load?.load ?? 0) < 409);
});

test("composite load confidence follows component provenance", () => {
  const load = calculateWorkoutTrainingLoad({
    trainingSessionId: "composite", localDate: "2026-07-01", durationSeconds: 3600,
    sessionType: "steady", loadBreakdown: {
      rawHrrTrimp: 80, internalLoad: 70, paceLoad: 90,
      distanceReferenceMeters: 10_000, distanceExposureRatio: 1,
      distanceFactor: 1, compositeLoad: 78, compositeIntensity: 0.72,
      heartRateConfidence: 0.8, paceConfidence: 0.5
    }
  });
  assert.equal(load?.load, 78);
  assert.equal(load?.confidence, 0.68);
  assert.equal(load?.source, "composite");
  assert.equal(load?.intensity, 0.72);
  assert.equal(load?.breakdown.paceLoad, 90);
});

test("pure RPE/session composite fallbacks keep Banister confidence targets", () => {
  const rpe = calculateWorkoutTrainingLoad({
    trainingSessionId: "rpe-fallback", localDate: "2026-07-01", durationSeconds: 3600,
    sessionType: "easy", loadBreakdown: {
      rawHrrTrimp: null, internalLoad: null, paceLoad: null,
      distanceReferenceMeters: null, distanceExposureRatio: null,
      distanceFactor: 1, compositeLoad: 40, compositeIntensity: 0.52,
      heartRateConfidence: 0.65, paceConfidence: 0
    }
  });
  // Must not re-blend 0.65 * 0.6 → 0.39.
  assert.equal(rpe?.confidence, 0.65);
  assert.equal(rpe?.source, "composite");
  assert.equal(rpe?.intensity, 0.52);

  const session = calculateWorkoutTrainingLoad({
    trainingSessionId: "session-fallback", localDate: "2026-07-01", durationSeconds: 3600,
    sessionType: "easy", loadBreakdown: {
      rawHrrTrimp: null, internalLoad: null, paceLoad: null,
      distanceReferenceMeters: null, distanceExposureRatio: null,
      distanceFactor: 1, compositeLoad: 30, compositeIntensity: 0.42,
      heartRateConfidence: 0.4, paceConfidence: 0
    }
  });
  assert.equal(session?.confidence, 0.4);
});

test("merges overlapping heart-rate samples into one unique timeline", () => {
  const overlap = calculateWorkoutTrainingLoad({
    trainingSessionId: "overlap", localDate: "2026-07-01", durationSeconds: 600,
    restingHeartRate: 50, observedMaxHeartRate: 190,
    heartRateSamples: [
      { heartRate: 120, durationSeconds: 600, startOffsetSeconds: 0 },
      { heartRate: 160, durationSeconds: 600, startOffsetSeconds: 0 }
    ]
  });
  const merged = calculateWorkoutTrainingLoad({
    trainingSessionId: "merged", localDate: "2026-07-01", durationSeconds: 600,
    restingHeartRate: 50, observedMaxHeartRate: 190,
    heartRateSamples: [{ heartRate: 140, durationSeconds: 600, startOffsetSeconds: 0 }]
  });
  assert.equal(overlap?.source, "heart_rate_series");
  assert.equal(overlap?.intensity, merged?.intensity);
  assert.equal(overlap?.load, merged?.load);
  assert.equal(overlap?.confidence, 0.95);
});

test("composite metadata covers pace-only, conflicting components, and distance correction", () => {
  const make = (heartRateConfidence: number, paceConfidence: number, compositeIntensity: number, distanceFactor: number) =>
    calculateWorkoutTrainingLoad({
      trainingSessionId: "composite-case", localDate: "2026-07-01", durationSeconds: 3600,
      sessionType: "easy", loadBreakdown: {
        rawHrrTrimp: heartRateConfidence > 0 ? 50 : null,
        internalLoad: heartRateConfidence > 0 ? 50 : null,
        paceLoad: paceConfidence > 0 ? 100 : null,
        distanceReferenceMeters: 10_000, distanceExposureRatio: distanceFactor > 1 ? 2 : 1,
        distanceFactor, compositeLoad: 75 * distanceFactor, compositeIntensity,
        heartRateConfidence, paceConfidence
      }
    });
  const paceOnly = make(0, 1, 0.8, 1);
  const conflict = make(1, 1, 0.55, 1);
  const corrected = make(1, 1, 0.55, 1.15);
  assert.deepEqual(
    [paceOnly?.source, paceOnly?.intensity, paceOnly?.confidence],
    ["composite", 0.8, 0.4]
  );
  assert.equal(conflict?.source, "composite");
  assert.equal(conflict?.intensity, 0.55);
  assert.equal(corrected?.load, 86.25);
  assert.equal(corrected?.intensity, conflict?.intensity);
});

test("fills rest days and updates EWMA with zero load", () => {
  const first = calculateWorkoutTrainingLoad({ trainingSessionId: "a", localDate: "2026-06-01", durationSeconds: 3600, sessionType: "easy" })!;
  const second = calculateWorkoutTrainingLoad({ trainingSessionId: "b", localDate: "2026-06-08", durationSeconds: 3600, sessionType: "tempo" })!;
  const days = buildDailyTrainingMetrics([first, second], "2026-06-09");
  assert.equal(days.length, 9);
  assert.equal(days[1]?.load, 0);
  assert.ok(days[1]!.acuteEwma < days[0]!.acuteEwma);
  assert.equal(days[7]?.workoutCount, 1);
  assert.equal(days[0]?.loadRatio, null);
  assert.equal(days[0]?.acuteEwma, days[0]?.load);
  assert.equal(days[0]?.chronicEwma, days[0]?.load);
});

test("computes the latest acute/chronic ratio without building the full daily series", () => {
  const loads = Array.from({ length: 80 }, (_, index) => historicalLoad(
    `run-${index}`,
    new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    index > 65 ? 180 : 60
  ));
  const throughDate = "2026-03-21";
  assert.equal(
    latestAcuteChronicLoadRatio(loads, throughDate),
    buildDailyTrainingMetrics(loads, throughDate).at(-1)?.loadRatio ?? null
  );
});

test("computes a decades-long latest ratio in linear time", () => {
  const loads = Array.from({ length: 800 }, (_, index) => historicalLoad(
    `historical-${index}`,
    new Date(Date.UTC(2000, 0, 1 + index * 12)).toISOString().slice(0, 10),
    70 + index % 30
  ));
  const startedAt = performance.now();
  assert.notEqual(latestAcuteChronicLoadRatio(loads, "2026-01-01"), null);
  assert.ok(performance.now() - startedAt < 1_000);
});

test("training-state priority protects insufficient history and attention", () => {
  const common = { historyDays: 60, workoutCount: 20, chronicEwma: 20, loadRatio: 1, rampRate: 0, recoveryEvidence: 0.8, strain: 100, strainP90: 200, daysSinceLastRun: 1 };
  assert.equal(classifyTrainingStatus({ ...common, historyDays: 5, loadRatio: 2 }).status, "insufficient_data");
  assert.equal(classifyTrainingStatus({ ...common, loadRatio: 1.51 }).status, "attention");
  assert.equal(classifyTrainingStatus({ ...common, loadRatio: 1.4 }).status, "high_load");
  assert.equal(classifyTrainingStatus({ ...common, loadRatio: 0.6 }).status, "recovery");
  assert.equal(classifyTrainingStatus(common).status, "effective_stimulus");
  assert.equal(classifyTrainingStatus({ ...common, loadRatio: 0.8 }).status, "maintaining");
});

test("daily physiological state drives status and legacy recovery evidence stays null", () => {
  const loads = Array.from({ length: 30 }, (_, index) => historicalLoad(
    `run-${index}`,
    new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    index === 29 ? 120 : 40
  ));
  const metrics = buildDailyTrainingMetrics(loads, "2026-01-30", [
    { localDate: "2026-01-30", physState: "depleted" }
  ]);
  const latest = metrics.at(-1)!;
  assert.equal(latest.recoveryEvidence, null);
  assert.equal(latest.trainingStatus, "attention");
  assert.equal(latest.statusExplanations[0]?.code, "depleted_phys_with_load");
});

test("legacy recovery evidence cannot change training status without a physiological state", () => {
  const common = { historyDays: 60, workoutCount: 20, chronicEwma: 20, loadRatio: 1, rampRate: 0, strain: 100, strainP90: 200, daysSinceLastRun: 1 };
  assert.equal(classifyTrainingStatus({ ...common, recoveryEvidence: 0.1 }).status, "effective_stimulus");
});

test("uses Shanghai local dates and Monday week boundaries", () => {
  assert.equal(localDateInTimeZone("2026-07-01T16:30:00Z"), "2026-07-02");
  assert.deepEqual(periodBounds("2026-07-05", "week"), { start: "2026-06-29", end: "2026-07-05" });
  assert.deepEqual(periodBounds("2024-02-10", "month"), { start: "2024-02-01", end: "2024-02-29" });
});

test("aggregates pace by total duration and distance and weights heart rate by duration", () => {
  const a = calculateWorkoutTrainingLoad({ trainingSessionId: "a", localDate: "2026-07-01", durationSeconds: 1800, distanceMeters: 5000, averageHeartRate: 140, restingHeartRate: 50, observedMaxHeartRate: 190, sessionType: "easy" })!;
  const b = calculateWorkoutTrainingLoad({ trainingSessionId: "b", localDate: "2026-07-02", durationSeconds: 3600, distanceMeters: 10000, averageHeartRate: 160, restingHeartRate: 50, observedMaxHeartRate: 190, sessionType: "tempo" })!;
  const summary = aggregateTrainingPeriod([a, b], "2026-07-01", "2026-07-31", "month", "2026-07-10");
  assert.equal(summary.averagePaceSecondsPerKm, 360);
  assert.equal(summary.averageHeartRate, 153.333333);
  assert.equal(summary.distanceMeters, 15000);
  assert.equal(summary.isComplete, false);
});

test("compares an incomplete calendar period with the same elapsed days", () => {
  const load = (id: string, date: string, distance: number) => calculateWorkoutTrainingLoad({ trainingSessionId: id, localDate: date, durationSeconds: 1800, distanceMeters: distance, sessionType: "easy" })!;
  const summary = buildCalendarPeriodSummary([
    load("previous-in-range", "2026-06-05", 4000),
    load("previous-after-cutoff", "2026-06-20", 20000),
    load("current", "2026-07-05", 6000)
  ], "2026-07-10", "month");
  assert.equal(summary.comparison?.distanceChangeFraction, 0.5);
});

test("builds deterministic adjacent rolling summaries", () => {
  const recent = calculateWorkoutTrainingLoad({ trainingSessionId: "recent", localDate: "2026-07-10", durationSeconds: 1800, distanceMeters: 6000, sessionType: "easy" })!;
  const previous = calculateWorkoutTrainingLoad({ trainingSessionId: "previous", localDate: "2026-07-03", durationSeconds: 1800, distanceMeters: 3000, sessionType: "easy" })!;
  const summary = buildRollingPeriodSummary([recent, previous], "2026-07-10", 7);
  assert.equal(summary.distanceMeters, 6000);
  assert.equal(summary.comparison?.distanceChangeFraction, 1);
});

const phys = (overrides: Partial<Parameters<typeof classifyPhysState>[0]> = {}) => classifyPhysState({
  sleepMinutes: null, sleepBaselineMinutes: null,
  hrvSdnnMs: null, hrvBaselineMs: null,
  rhrBpm: null, rhrBaselineBpm: null,
  nightsBelowSleepBaseline: 0,
  ...overrides
});

test("physiological state never falls back to a negative verdict", () => {
  // No comparable evidence at all is unknown.
  assert.equal(phys(), "unknown");
  // Partial coverage that matches no named rule is insufficient evidence, not
  // "reduced": 0.80 of baseline sleep with no usable HRV/RHR has no defined
  // physiological meaning, so the classifier must not invent one.
  assert.equal(phys({ sleepMinutes: 344, sleepBaselineMinutes: 430 }), "unknown");
  assert.equal(phys({ hrvSdnnMs: 46, hrvBaselineMs: 52 }), "unknown");
  // A resting heart rate at or barely above baseline is not evidence either.
  assert.equal(phys({ rhrBpm: 54, rhrBaselineBpm: 53 }), "unknown");
});

test("physiological state keeps every named rule it had", () => {
  assert.equal(phys({ sleepMinutes: 300, sleepBaselineMinutes: 430 }), "reduced");
  assert.equal(phys({ hrvSdnnMs: 40, hrvBaselineMs: 52, rhrBpm: 56, rhrBaselineBpm: 53 }), "reduced");
  assert.equal(phys({ sleepMinutes: 300, sleepBaselineMinutes: 430, hrvSdnnMs: 40, hrvBaselineMs: 52, rhrBpm: 56, rhrBaselineBpm: 53 }), "depleted");
  assert.equal(phys({ sleepMinutes: 400, sleepBaselineMinutes: 430 }), "recovered_phys");
  assert.equal(phys({ hrvSdnnMs: 50, hrvBaselineMs: 52, rhrBpm: 52, rhrBaselineBpm: 53 }), "recovered_phys");
  // Three low nights stay a depleted signal regardless of the ratios.
  assert.equal(phys({ sleepMinutes: 400, sleepBaselineMinutes: 430, nightsBelowSleepBaseline: 3 }), "depleted");
});

test("low-night streak counts only recorded nights in its own window", () => {
  const night = (minutes: number | null) => ({ asleepUnionMinutes: minutes });
  assert.equal(countNightsBelowSleepBaseline([night(300), night(300), night(300)], 430), 3);
  // A gap day carries no reading: it neither extends the streak nor counts as a
  // low night. 0.8 x baseline is the boundary and exactly at it is not low.
  assert.equal(countNightsBelowSleepBaseline([night(300), null, night(300)], 430), 2);
  assert.equal(countNightsBelowSleepBaseline([night(344), night(343.9), night(400)], 430), 1);
  assert.equal(countNightsBelowSleepBaseline([null, null, null], 430), 0);
  // Without a usable baseline there is no streak to report.
  assert.equal(countNightsBelowSleepBaseline([night(300), night(300), night(300)], null), 0);
  assert.equal(countNightsBelowSleepBaseline([night(300), night(300), night(300)], 0), 0);
});

test("dense non-overlapping heart-rate streams remain bounded and preserve load", () => {
  const count = 100_000;
  const result = calculateWorkoutTrainingLoad({ trainingSessionId: "dense", localDate: "2026-09-21",
    durationSeconds: count, restingHeartRate: 60, observedMaxHeartRate: 180,
    heartRateSamples: Array.from({ length: count }, (_, i) => ({ heartRate: 120, durationSeconds: 1, startOffsetSeconds: i })) });
  assert.ok(result);
  assert.equal(result.source, "heart_rate_series");
  assert.equal(result.intensity, 0.5);
  assert.ok(Math.abs(result.load - count / 60 * trimpMinuteLoad(0.5)) < 1e-5);
});

// -----------------------------------------------------------------------------
// §9.4 / §9.5 负荷命名与"把数值指标与行动分类分开"
// -----------------------------------------------------------------------------

test("acuteLoadExcess is a derived load proxy, and says so by refusing to invent a value", () => {
  assert.equal(acuteLoadExcess(120, 90), 30);
  // Below chronic there is no excess — and it is 0, not a negative "recovery credit".
  assert.equal(acuteLoadExcess(80, 90), 0);
  assert.equal(acuteLoadExcess(90, 90), 0);
  // Unknown inputs stay unknown: 0 would read as "measured, and no excess".
  assert.equal(acuteLoadExcess(null, 90), null);
  assert.equal(acuteLoadExcess(90, null), null);
  assert.equal(acuteLoadExcess(Number.NaN, 90), null);
});

test("the risk-basis table covers every code the classifier can emit", () => {
  // Frozen contract: if `classifyTrainingStatus` grows a branch, its code has to be registered
  // here — otherwise `assessLoad` would silently fall through to `maintaining`, which reports
  // "nothing to see" for a signal nobody mapped.
  assert.deepEqual(Object.keys(LOAD_RISK_BASIS).sort(), [
    "depleted_phys_with_load",
    "effective_load_range",
    "insufficient_training_history",
    "load_maintaining",
    "load_ratio_attention",
    "load_ratio_high",
    "load_ratio_recovery",
    "ramp_rate_attention",
    "seven_days_without_run",
    "strain_above_personal_p90"
  ]);
  // And the declared list must be exactly what the classifier emits.
  const emitted = new Set<string>();
  const base = { historyDays: 30, workoutCount: 10, chronicEwma: 60, acuteEwma: 70, recoveryEvidence: null, rampRate: 0, strain: null, strainP90: null, daysSinceLastRun: 1 };
  for (const probe of [
    { ...base, loadRatio: null },
    { ...base, loadRatio: 2 },
    { ...base, loadRatio: 1.4, rampRate: 0.9 },
    { ...base, loadRatio: 1.2, physState: "depleted" as const },
    { ...base, loadRatio: 1.4, strain: 999, strainP90: 500 },
    { ...base, loadRatio: 1.2, daysSinceLastRun: 9 },
    { ...base, loadRatio: 0.5 },
    { ...base, loadRatio: 1.1 },
    { ...base, loadRatio: 1.35 },
    { ...base, loadRatio: 1.05 }
  ]) {
    for (const explanation of classifyTrainingStatus(probe).explanations) emitted.add(explanation.code);
  }
  for (const code of emitted) {
    assert.ok(code in LOAD_RISK_BASIS, `classifier emitted ${code}, which has no risk basis`);
  }
});

test("assessLoad separates the indicators from the classification", () => {
  const base = { historyDays: 30, workoutCount: 10, chronicEwma: 60, acuteEwma: 130, rampRate: 0, strain: null, strainP90: null, daysSinceLastRun: 1 };
  const unknown = assessLoad({ ...base, loadRatio: null, historyDays: 3 });
  assert.equal(unknown.risk, "unknown");
  assert.equal(unknown.basis, "insufficient_history");
  assert.equal(unknown.indicators.acwr, null);

  const high = assessLoad({ ...base, loadRatio: 2 });
  assert.equal(high.risk, "high");
  assert.equal(high.basis, "acwr");
  // Indicators are reported alongside, and they are the raw numbers — not re-weighted votes.
  assert.equal(high.indicators.acwr, 2);
  assert.equal(high.indicators.acuteLoadExcess, 70);

  const nominal = assessLoad({ ...base, loadRatio: 1.05 });
  assert.equal(nominal.risk, "nominal");
  assert.equal(nominal.basis, "effective_range");
});

test("assessLoad exposes exactly one basis, so three signals cannot each vote", () => {
  // §9.4 forbids ATL, ACWR and the excess voting separately. The shape enforces it: `basis` is a
  // single value, and the risk follows the classifier's first match — later signals cannot add
  // a second vote even when their thresholds are also breached.
  const base = { historyDays: 30, workoutCount: 10, chronicEwma: 60, acuteEwma: 130, loadRatio: 2, rampRate: 5, strain: 999, strainP90: 1, daysSinceLastRun: 1 };
  const both = assessLoad({ ...base, physState: "depleted" as const });
  assert.equal(both.basis, "acwr", "the first breach names the basis and nothing else votes");
  assert.equal(assessLoad({ ...base, rampRate: 5, strain: null, strainP90: null }).basis, "acwr");
  // Changing only a non-basis signal must not change the risk.
  assert.equal(both.risk, assessLoad({ ...base, rampRate: 0, strain: null, strainP90: null }).risk);
});

test("the retired Coach clause never changed a builder-produced verdict", () => {
  // §9.5 removed `loadRatio > 1.3` from the Coach verdict. That is only safe if, for rows the
  // builder actually produces, the clause never disagreed with the status. Sweep several load
  // shapes and prove it — including that the clause DOES fire somewhere, so the sweep is not
  // vacuous.
  const day = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
  const patterns: Record<string, (index: number, total: number) => number> = {
    steady: () => 180,
    late_ramp_3x: (index, total) => (index <= total - 7 ? 60 : 180),
    late_spike_10x: (index, total) => (index <= total - 5 ? 30 : 300),
    sawtooth: (index) => (index % 2 ? 0 : 220),
    single_huge: (index, total) => (index === total - 1 ? 900 : 40),
    declining: (index, total) => Math.round(300 * (1 - index / total) + 20),
    stop_for_a_week: (index, total) => (index <= total - 7 ? 300 : 0)
  };
  let clauseTrue = 0;
  let clauseWouldChange = 0;
  for (const pattern of Object.values(patterns)) {
    const loads: WorkoutTrainingLoad[] = [];
    for (let index = 0; index < 60; index += 1) {
      const load = pattern(index, 60);
      if (load <= 0) continue;
      loads.push({
        trainingSessionId: `s${index}`,
        localDate: day(index),
        distanceMeters: 10_000,
        durationSeconds: 3600,
        load,
        intensity: 0.8,
        source: "composite",
        confidence: 0.9,
        rpe: 7,
        sessionType: "steady",
        averageHeartRate: 150,
        elevationGainMeters: null,
        stimulusType: "aerobic_base",
        breakdown: {
          rawHrrTrimp: load,
          internalLoad: load,
          paceLoad: null,
          distanceReferenceMeters: null,
          distanceExposureRatio: null,
          distanceFactor: 1,
          compositeLoad: load,
          compositeIntensity: 0.8,
          heartRateConfidence: 0.9,
          paceConfidence: 0
        },
        explanations: []
      });
    }
    for (const metric of buildDailyTrainingMetrics(loads, day(59))) {
      if (metric.trainingStatus === "insufficient_data") continue;
      const statusHigh = metric.trainingStatus === "attention" || metric.trainingStatus === "high_load";
      const clause = metric.loadRatio !== null && metric.loadRatio > 1.3;
      if (clause) clauseTrue += 1;
      if (clause && !statusHigh) clauseWouldChange += 1;
    }
  }
  assert.ok(clauseTrue > 0, "the sweep must exercise rows where the clause is true, or it proves nothing");
  assert.equal(clauseWouldChange, 0, "the clause could change a builder-produced verdict");
});

// -----------------------------------------------------------------------------
// §9.2 LoadVectorV2：只增向量，不动 compositeLoad
// -----------------------------------------------------------------------------

function vectorFixture(overrides: Partial<Parameters<typeof buildLoadVectorV2>[0]> = {}) {
  const load = calculateWorkoutTrainingLoad({
    trainingSessionId: "session-1",
    localDate: "2026-03-01",
    durationSeconds: 3600,
    distanceMeters: 12_000,
    averageHeartRate: 150,
    restingHeartRate: 50,
    observedMaxHeartRate: 190,
    sessionType: "steady",
    sourceConfidence: 1
  })!;
  return { load, ...overrides };
}

const zoneExposure = (entries: Array<[HeartRateZone, number]>) =>
  entries.map(([zone, durationSeconds]) => ({
    zone,
    durationSeconds,
    distanceMeters: 0,
    fraction: durationSeconds / 3600
  }));

test("the load vector passes compositeLoad through untouched (§9.6 golden parity)", () => {
  const { load } = vectorFixture();
  const vector = buildLoadVectorV2({ load });
  assert.equal(vector.compositeLoad, load.load);
  assert.equal(vector.compositeLoad, load.breakdown.compositeLoad);
  assert.equal(vector.rawHrrTrimp, load.breakdown.rawHrrTrimp);
  assert.equal(vector.internalLoad, load.breakdown.internalLoad);
  assert.equal(vector.paceLoad, load.breakdown.paceLoad);
  assert.equal(vector.source, load.source);
  assert.equal(vector.confidence, load.confidence);
});

test("the load vector never grows a second total", () => {
  // §9.2: distance, heart-rate load and pace load must not be re-weighted into another total.
  // Freezing the key set is what makes that structural: adding `totalLoad` means editing this list.
  const vector = buildLoadVectorV2(vectorFixture());
  assert.deepEqual(Object.keys(vector).sort(), [
    "activeDurationMinutes",
    "compositeLoad",
    "confidence",
    "distanceMeters",
    "elevationGainMeters",
    "highIntensityMinutes",
    "highIntensityZoneSystem",
    "internalLoad",
    "mechanicalLoad",
    "mechanicalModelVersion",
    "paceLoad",
    "rawHrrTrimp",
    "reasonCodes",
    "source"
  ]);
  assert.equal(LOAD_VECTOR_V2_VERSION, "rai-load-vector-v2");
});

test("activeDurationMinutes is a duration, not another TRIMP", () => {
  const { load } = vectorFixture();
  const vector = buildLoadVectorV2({ load });
  assert.equal(vector.activeDurationMinutes, 60);
  // 60 minutes at maximal intensity is 60 * trimpMinuteLoad(1) TRIMP, not 60.
  assert.notEqual(vector.activeDurationMinutes, 60 * trimpMinuteLoad(1));
});

test("high intensity minutes come from the shared zone set, or are withheld", () => {
  const { load } = vectorFixture();
  // 900s of threshold + 300s of anaerobic = 20 minutes. `aerobic_power` is deliberately not
  // high intensity, and it is the zone that exists only on the heart-rate ladder.
  const withZones = buildLoadVectorV2({
    load,
    zoneSummary: {
      zoneProfileId: "profile-1",
      heartRateCoverage: 0.9,
      heartRateExposure: zoneExposure([
        ["aerobic_base", 1200],
        ["aerobic_power", 1200],
        ["lactate_threshold", 900],
        ["anaerobic", 300]
      ])
    }
  });
  assert.equal(withZones.highIntensityMinutes, 20);
  assert.equal(withZones.highIntensityZoneSystem, "profile-1");
  assert.ok(!withZones.reasonCodes.includes("heart_rate_coverage_below_threshold"));

  // No zone summary at all: withheld, with the reason recorded.
  const withoutZones = buildLoadVectorV2({ load });
  assert.equal(withoutZones.highIntensityMinutes, null);
  assert.equal(withoutZones.highIntensityZoneSystem, null);
  assert.ok(withoutZones.reasonCodes.includes("zone_summary_absent"));

  // Partial coverage is not extrapolated to the whole session (§9.6).
  const thin = buildLoadVectorV2({
    load,
    zoneSummary: {
      zoneProfileId: "profile-1",
      heartRateCoverage: HIGH_INTENSITY_MINIMUM_HEART_RATE_COVERAGE - 0.01,
      heartRateExposure: zoneExposure([["lactate_threshold", 900]])
    }
  });
  assert.equal(thin.highIntensityMinutes, null);
  assert.ok(thin.reasonCodes.includes("heart_rate_coverage_below_threshold"));
});

test("mechanical load stays null until a mapping is validated", () => {
  const vector = buildLoadVectorV2(vectorFixture());
  assert.equal(vector.mechanicalLoad, null);
  assert.equal(vector.mechanicalModelVersion, null);
  assert.ok(vector.reasonCodes.includes("mechanical_load_not_modeled"));
  // The raw exposure is still there — §9.2 asks to show distance and climb as they are.
  assert.equal(vector.distanceMeters, 12_000);
});

test("L04: an unobserved prehistory is never filled with zero load", () => {
  const days = buildDailyTrainingMetrics(
    [historicalLoad("a", "2026-06-01", 120), historicalLoad("b", "2026-06-08", 120)],
    "2026-06-09"
  );

  // 序列从**第一次观测到的训练日**开始：未知前史是"不存在"，不是"负荷 0 的休息日"。
  assert.equal(days[0]?.localDate, "2026-06-01");
  assert.equal(days.some((day) => day.localDate < "2026-06-01"), false);
  // 两个 EWMA 都从这次观测播种。若把未知前史补 0，chronic 会被稀释成约 120 × α(28 日半衰期) ≈ 3.2，
  // 低于 minimumChronicLoad=5 ⇒ ACWR 永远算不出来，界面会长期显示"低负荷"，而事实是"不知道"。
  assert.equal(days[0]?.acuteEwma, 120);
  assert.equal(days[0]?.chronicEwma, 120);

  // 未知前史下这一天只能说"历史不足"，不能说"正常"。
  const assessment = assessLoadV2({
    historyDays: 1,
    workoutCount: 1,
    acuteEwma: days[0]!.acuteEwma,
    chronicEwma: days[0]!.chronicEwma,
    loadRatio: days[0]!.loadRatio,
    rampRate: days[0]!.rampRate,
    strain: days[0]!.strain,
    strainP90: null,
    daysSinceLastRun: 0
  });
  assert.equal(assessment.risk, "unknown");
  assert.equal(assessment.basis, "insufficient_history");

  // 对照：**观测到的**休息日确实按 0 计入并让 EWMA 衰减 —— 补零只允许发生在有观测的地方。
  assert.equal(days[1]?.load, 0);
  assert.ok(days[1]!.chronicEwma < days[0]!.chronicEwma);
});
