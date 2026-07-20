import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateTrainingPeriod,
  buildDailyTrainingMetrics,
  buildCalendarPeriodSummary,
  buildRollingPeriodSummary,
  calculateWorkoutTrainingLoad,
  classifyTrainingStatus,
  heartRateReserve,
  localDateInTimeZone,
  periodBounds,
  trimpMinuteLoad
} from "../src/index.js";

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

test("training-state priority protects insufficient history and attention", () => {
  const common = { historyDays: 60, workoutCount: 20, chronicEwma: 20, loadRatio: 1, rampRate: 0, recoveryEvidence: 0.8, strain: 100, strainP90: 200, daysSinceLastRun: 1 };
  assert.equal(classifyTrainingStatus({ ...common, historyDays: 5, loadRatio: 2 }).status, "insufficient_data");
  assert.equal(classifyTrainingStatus({ ...common, loadRatio: 1.51 }).status, "attention");
  assert.equal(classifyTrainingStatus({ ...common, loadRatio: 1.4 }).status, "high_load");
  assert.equal(classifyTrainingStatus({ ...common, loadRatio: 0.6 }).status, "recovery");
  assert.equal(classifyTrainingStatus(common).status, "effective_stimulus");
  assert.equal(classifyTrainingStatus({ ...common, loadRatio: 0.8 }).status, "maintaining");
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
