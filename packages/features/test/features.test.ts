import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateRecoveryParts,
  defaultFeatureConfig,
  extractWorkoutFeatureVector,
  type FeatureConfig,
  type WorkoutFeatureSource
} from "../src/index.js";

const startAt = "2025-01-01T00:00:00.000Z";
const endAt = "2025-01-01T00:30:00.000Z";

function source(overrides: Partial<WorkoutFeatureSource> = {}): WorkoutFeatureSource {
  return {
    id: "workout_1",
    trainingSessionId: "session_1",
    trainingSessionStatus: "active",
    workoutStartAt: startAt,
    workoutEndAt: endAt,
    durationSeconds: 1800,
    distanceKm: 5,
    indoor: false,
    sourceCategory: "apple_watch",
    routePointCount: 100,
    routeQuality: 0.9,
    speed: {
      average: 2.78,
      minimum: 2.6,
      maximum: 3,
      sampleCount: 12,
      firstAt: startAt,
      lastAt: endAt,
      coefficientOfVariation: 0.04
    },
    heartRate: {
      average: 155,
      minimum: 135,
      maximum: 175,
      sampleCount: 4,
      firstAt: startAt,
      lastAt: endAt,
      coefficientOfVariation: 0.06
    },
    restingHeartRate: 50,
    restingHeartRateReference: 50,
    hrvSdnn: 50,
    sleepDurationMinutes: 420,
    recentLoadMinutes: 180,
    observedMaximumHeartRate: 185,
    override: null,
    ...overrides
  };
}

test("does not treat sparse endpoint timestamps as full heart-rate coverage", () => {
  const feature = extractWorkoutFeatureVector("feature_1", "run_1", source());

  assert.equal(feature.heartRateSampleCount, 4);
  assert.equal(feature.heartRateCoverage, 4 / 30);
  assert.equal(feature.eligibilityStatus, "trial");
  assert.ok(feature.missingReasons.includes("heart_rate_coverage_low"));
});

test("calculates recovery from personal baselines with fixed weighted renormalization", () => {
  const result = calculateRecoveryParts(source({
    sleepDurationMinutes: 360,
    restingHeartRate: 60,
    hrvSdnn: 40,
    recentLoadMinutes: 180,
    recoveryBaseline: {
      sleepMinutes: 420,
      restingHeartRateBpm: 50,
      hrvSdnnMs: 50,
      loadMinutes: 180,
      lookbackDays: 28,
      validDays: { sleep: 20, rhr: 25, hrv: 14, load: 22 }
    },
    recoveryContext: { nightId: "night-1", hrvConfidence: "confident" }
  }));

  assert.equal(result.parts.sleepRatio, 360 / 420);
  assert.equal(result.parts.rhrRatio, 50 / 60);
  assert.equal(result.parts.hrvRatio, 40 / 50);
  assert.equal(result.parts.loadPart, 1);
  assert.deepEqual(result.parts.weights, { sleep: 0.35, rhr: 0.25, hrv: 0.25, load: 0.15 });
  assert.equal(result.recoveryRaw, (0.35 * (360 / 420) + 0.25 * (50 / 60) + 0.25 * 0.8 + 0.15) / 1);
});

test("renormalizes weights when only some physiological signals are available", () => {
  const result = calculateRecoveryParts(source({
    sleepDurationMinutes: null,
    restingHeartRate: 55,
    hrvSdnn: null,
    recentLoadMinutes: 300,
    recoveryBaseline: {
      sleepMinutes: 420,
      restingHeartRateBpm: 50,
      hrvSdnnMs: 50,
      loadMinutes: 200,
      lookbackDays: 60
    }
  }));

  // RHR (0.25) and load (0.15) are re-normalized to 0.4.
  assert.deepEqual(Object.keys(result.parts.weights).sort(), ["load", "rhr"]);
  assert.ok(Math.abs((result.parts.weights.rhr ?? 0) - 0.625) < 1e-12);
  assert.ok(Math.abs((result.parts.weights.load ?? 0) - 0.375) < 1e-12);
  assert.equal(result.parts.loadPart, 0.5);
  assert.ok(Math.abs((result.recoveryRaw ?? 0) - ((0.25 * (50 / 55) + 0.15 * 0.5) / 0.4)) < 1e-12);
});

test("load-only recovery remains unavailable", () => {
  const result = calculateRecoveryParts(source({
    sleepDurationMinutes: null,
    restingHeartRate: null,
    hrvSdnn: null,
    recentLoadMinutes: 20,
    recoveryBaseline: {
      sleepMinutes: 420,
      restingHeartRateBpm: 50,
      hrvSdnnMs: 50,
      loadMinutes: 200
    }
  }));
  assert.equal(result.recoveryRaw, null);
  assert.equal(result.parts.loadPart, null);
  assert.deepEqual(result.parts.weights, {});
});

test("missing or non-positive baselines do not fall back to population thresholds", () => {
  const result = calculateRecoveryParts(source({
    recoveryBaseline: {
      sleepMinutes: null,
      restingHeartRateBpm: 0,
      hrvSdnnMs: null,
      loadMinutes: null
    }
  }));
  assert.equal(result.recoveryRaw, null);
  assert.equal(result.parts.sleepRatio, null);
  assert.equal(result.parts.rhrRatio, null);
  assert.equal(result.parts.hrvRatio, null);
});

test("keeps sparse instantaneous heart-rate records in trial status", () => {
  const feature = extractWorkoutFeatureVector(
    "feature_2",
    "run_1",
    source({
      heartRate: {
        average: 155,
        minimum: 155,
        maximum: 155,
        sampleCount: 4,
        firstAt: startAt,
        lastAt: "2025-01-01T00:03:00.000Z",
        coefficientOfVariation: 0
      }
    })
  );

  assert.equal(feature.eligibilityStatus, "trial");
  assert.ok(feature.missingReasons.includes("heart_rate_coverage_low"));
});

test("falls back to sample density when heart-rate timestamps are invalid", () => {
  const feature = extractWorkoutFeatureVector("feature_3", "run_1", source({
    heartRate: {
      average: 155, minimum: 140, maximum: 170, sampleCount: 20,
      firstAt: "invalid", lastAt: "invalid", coefficientOfVariation: 0.05
    }
  }));
  assert.equal(feature.heartRateCoverage, 2 / 3);
  assert.equal(feature.eligibilityStatus, "eligible");
});

test("classifies ordinary runs from normalized heart-rate effort", () => {
  const cases = [
    { average: 105, expected: "recovery" },
    { average: 125, expected: "easy" },
    { average: 145, expected: "steady" },
    { average: 165, expected: "tempo" }
  ] as const;

  for (const item of cases) {
    const feature = extractWorkoutFeatureVector("feature", "run", source({
      heartRate: {
        average: item.average,
        minimum: item.average - 10,
        maximum: item.average + 10,
        sampleCount: 30,
        firstAt: startAt,
        lastAt: endAt,
        coefficientOfVariation: 0.04
      },
      restingHeartRate: 50,
      observedMaximumHeartRate: 190
    }));
    assert.equal(feature.sessionType, item.expected);
  }
});

test("prioritizes interval, long-run, and race evidence", () => {
  const interval = extractWorkoutFeatureVector("interval", "run", source({
    speed: { ...source().speed, coefficientOfVariation: 0.22 },
    speedSamples: Array.from({ length: 36 }, (_, index) => ({
      value: Math.floor(index / 2) % 2 === 0 ? 4 : 2.5,
      startOffsetSeconds: index * 30,
      durationSeconds: 30
    }))
  }));
  assert.equal(interval.sessionType, "interval");

  // Non-easy HRR + long duration → long_run (HRR ≥ easy threshold).
  const longRun = extractWorkoutFeatureVector("long", "run", source({
    durationSeconds: 80 * 60,
    distanceKm: 14,
    workoutEndAt: "2025-01-01T01:20:00.000Z",
    heartRate: {
      average: 155, minimum: 140, maximum: 170, sampleCount: 30,
      firstAt: startAt, lastAt: "2025-01-01T01:20:00.000Z", coefficientOfVariation: 0.05
    },
    restingHeartRate: 50,
    observedMaximumHeartRate: 190
  }));
  assert.equal(longRun.sessionType, "long_run");

  const race = extractWorkoutFeatureVector("race", "run", source({
    durationSeconds: 25 * 60,
    distanceKm: 5.02,
    heartRate: { ...source().heartRate, average: 175 },
    restingHeartRate: 50,
    observedMaximumHeartRate: 190,
    override: {
      id: "override_1", trainingSessionId: "session_1", revision: 1,
      eligibilityOverride: null, statisticsParticipation: null, sessionType: null,
      performanceProtocol: "other_race", rpe: null, conditionTags: [], note: null,
      createdAt: startAt
    }
  }));
  assert.equal(race.sessionType, "race");
});

test("does not promote long volume to long_run without non-easy HRR", () => {
  const noHrr = extractWorkoutFeatureVector("long-no-hrr", "run", source({
    durationSeconds: 80 * 60,
    distanceKm: 16,
    workoutEndAt: "2025-01-01T01:20:00.000Z",
    heartRate: {
      average: null, minimum: null, maximum: null, sampleCount: 0,
      firstAt: null, lastAt: null, coefficientOfVariation: null
    },
    restingHeartRate: null,
    observedMaximumHeartRate: null
  }));
  assert.equal(noHrr.sessionType, "easy");

  const easyLong = extractWorkoutFeatureVector("long-easy-hrr", "run", source({
    durationSeconds: 80 * 60,
    distanceKm: 16,
    workoutEndAt: "2025-01-01T01:20:00.000Z",
    heartRate: {
      average: 125, minimum: 115, maximum: 135, sampleCount: 30,
      firstAt: startAt, lastAt: "2025-01-01T01:20:00.000Z", coefficientOfVariation: 0.04
    },
    restingHeartRate: 50,
    observedMaximumHeartRate: 190
  }));
  assert.equal(easyLong.sessionType, "easy");
});

test("statistic-only average heart rate stays trial unless user includes", () => {
  const statsOnly = extractWorkoutFeatureVector("stats-only", "run", source({
    heartRate: {
      average: 150,
      minimum: 140,
      maximum: 160,
      sampleCount: 1,
      firstAt: startAt,
      lastAt: endAt,
      coefficientOfVariation: null,
      coveredDurationSeconds: null
    }
  }));
  assert.equal(statsOnly.eligibilityStatus, "trial");
  assert.ok(statsOnly.missingReasons.includes("heart_rate_coverage_low"));

  const included = extractWorkoutFeatureVector("stats-include", "run", source({
    heartRate: {
      average: 150,
      minimum: 140,
      maximum: 160,
      sampleCount: 1,
      firstAt: startAt,
      lastAt: endAt,
      coefficientOfVariation: null,
      coveredDurationSeconds: null
    },
    override: {
      id: "override_include", trainingSessionId: "session_1", revision: 1,
      eligibilityOverride: "include", statisticsParticipation: null, sessionType: null,
      performanceProtocol: null, rpe: null, conditionTags: [], note: null,
      createdAt: startAt
    }
  }));
  assert.equal(included.eligibilityStatus, "eligible");
  assert.ok(included.missingReasons.includes("heart_rate_coverage_low"));
});

test("keeps repeated interval evidence ahead of long-run duration", () => {
  const speedSamples = Array.from({ length: 160 }, (_, index) => ({
    value: Math.floor(index / 4) % 2 === 0 ? 4.2 : 2.6,
    startOffsetSeconds: index * 30,
    durationSeconds: 30
  }));
  const feature = extractWorkoutFeatureVector("long-interval", "run", source({
    durationSeconds: 80 * 60,
    workoutEndAt: "2025-01-01T01:20:00.000Z",
    distanceKm: 15,
    speed: { ...source().speed, coefficientOfVariation: 0.24 },
    speedSamples
  }));
  assert.equal(feature.sessionType, "interval");
});

test("keeps explicit recovery effort ahead of long-run distance", () => {
  const feature = extractWorkoutFeatureVector("recovery-long", "run", source({
    durationSeconds: 80 * 60,
    workoutEndAt: "2025-01-01T01:20:00.000Z",
    distanceKm: 15,
    heartRate: { ...source().heartRate, average: 100 },
    restingHeartRate: 50,
    observedMaximumHeartRate: 190
  }));
  assert.equal(feature.sessionType, "recovery");
});

test("does not infer race intent from a standard distance and high heart rate", () => {
  const feature = extractWorkoutFeatureVector("hard_5k", "run", source({
    durationSeconds: 30 * 60,
    distanceKm: 5.03,
    heartRate: { ...source().heartRate, average: 180 },
    restingHeartRate: 60,
    observedMaximumHeartRate: 198
  }));
  assert.equal(feature.sessionType, "tempo");
});

test("does not mistake aerobic progression and short surges for intervals", () => {
  const blocks = [
    { bins: 2, value: 2.2 }, { bins: 3, value: 2.8 }, { bins: 8, value: 2.2 },
    { bins: 6, value: 2.8 }, { bins: 12, value: 2.2 }, { bins: 2, value: 2.8 },
    { bins: 1, value: 2.2 }, { bins: 3, value: 2.8 }, { bins: 6, value: 2.2 },
    { bins: 11, value: 3.2 }
  ];
  let offset = 0;
  const speedSamples = blocks.flatMap((block) => Array.from({ length: block.bins }, () => {
    const sample = { value: block.value, startOffsetSeconds: offset, durationSeconds: 30 };
    offset += 30;
    return sample;
  }));
  const feature = extractWorkoutFeatureVector("progressive", "run", source({
    durationSeconds: offset,
    distanceKm: 4.3,
    speed: { ...source().speed, coefficientOfVariation: 0.164 },
    speedSamples,
    heartRate: { ...source().heartRate, average: 165 },
    restingHeartRate: 70,
    restingHeartRateReference: 70,
    observedMaximumHeartRate: 201
  }));
  assert.equal(feature.sessionType, "steady");
});

test("smooths second-level speed noise before stability scoring and interval classification", () => {
  const speedSamples = Array.from({ length: 1800 }, (_, index) => ({
    value: index % 2 === 0 ? 1.7 : 3.3,
    startOffsetSeconds: index,
    durationSeconds: 1
  }));
  const feature = extractWorkoutFeatureVector("noisy-steady", "run", source({
    speed: { ...source().speed, average: 2.5, coefficientOfVariation: 0.32 },
    speedSamples,
    heartRate: { ...source().heartRate, average: 145, coefficientOfVariation: 0.05 },
    restingHeartRate: 50,
    observedMaximumHeartRate: 190
  }));

  assert.equal(feature.sessionType, "steady");
  assert.ok((feature.signals.speedCoefficientOfVariation ?? 1) < 0.01);
  assert.ok((feature.signals.stabilityRaw ?? 0) > 0.97);
});

test("normalizes overlapping speed samples before stability scoring", () => {
  const speedSamples = Array.from({ length: 60 }, (_, index) => ({
    value: 3,
    startOffsetSeconds: index * 30,
    durationSeconds: 30
  }));
  speedSamples.push({ value: 3, startOffsetSeconds: 15, durationSeconds: 45 });
  const feature = extractWorkoutFeatureVector("overlapping-steady", "run", source({
    speed: { ...source().speed, average: 3, coefficientOfVariation: 0.2 },
    speedSamples
  }));

  assert.ok((feature.signals.speedCoefficientOfVariation ?? 1) < 1e-10);
  assert.notEqual(feature.sessionType, "interval");
});

test("does not infer intervals from sparse speed islands", () => {
  const speedSamples = Array.from({ length: 10 }, (_, index) => ({
    value: index % 2 === 0 ? 4.5 : 2.2,
    startOffsetSeconds: index * 360,
    durationSeconds: 30
  }));
  const feature = extractWorkoutFeatureVector("sparse-speed", "run", source({
    durationSeconds: 3600,
    distanceKm: 10,
    workoutEndAt: "2025-01-01T01:00:00.000Z",
    speed: { ...source().speed, coefficientOfVariation: 0.3 },
    speedSamples,
    heartRate: { ...source().heartRate, average: 165 },
    restingHeartRate: 70,
    restingHeartRateReference: 70,
    observedMaximumHeartRate: 201
  }));
  assert.equal(feature.sessionType, "steady");
});

test("recognizes repeated intervals after a workout pause", () => {
  const speedSamples = Array.from({ length: 18 }, (_, index) => ({
    value: Math.floor(index / 2) % 2 === 0 ? 4.5 : 2.2,
    startOffsetSeconds: 900 + index * 30,
    durationSeconds: 30
  }));
  const feature = extractWorkoutFeatureVector("paused-intervals", "run", source({
    durationSeconds: 900,
    workoutEndAt: "2025-01-01T00:24:00.000Z",
    distanceKm: 3.2,
    speed: { ...source().speed, coefficientOfVariation: 0.3 },
    speedSamples,
    heartRate: { ...source().heartRate, average: 165 },
    restingHeartRate: 70,
    restingHeartRateReference: 70,
    observedMaximumHeartRate: 201
  }));

  assert.equal(feature.sessionType, "interval");
});

test("defaults interval speed coverage for feature configs created before the setting existed", () => {
  const { minimumIntervalSpeedCoverage: _removed, ...legacyConfig } = defaultFeatureConfig;
  const speedSamples = Array.from({ length: 12 }, (_, index) => ({
    value: Math.floor(index / 2) % 2 === 0 ? 4.5 : 2.2,
    startOffsetSeconds: index * 30,
    durationSeconds: 30
  }));
  const feature = extractWorkoutFeatureVector("legacy-config", "run", source({
    durationSeconds: 1800,
    distanceKm: 5,
    speed: { ...source().speed, coefficientOfVariation: 0.3 },
    speedSamples,
    heartRate: { ...source().heartRate, average: 165 },
    restingHeartRate: 70,
    restingHeartRateReference: 70,
    observedMaximumHeartRate: 201
  }), legacyConfig);

  assert.equal(feature.sessionType, "steady");
  assert.equal(
    (feature.provenance.featureConfig as FeatureConfig).minimumIntervalSpeedCoverage,
    defaultFeatureConfig.minimumIntervalSpeedCoverage
  );

  const explicitlyUndefined = extractWorkoutFeatureVector(
    "undefined-coverage",
    "run",
    source(),
    { ...legacyConfig, minimumIntervalSpeedCoverage: undefined }
  );
  assert.equal(
    (explicitlyUndefined.provenance.featureConfig as FeatureConfig).minimumIntervalSpeedCoverage,
    defaultFeatureConfig.minimumIntervalSpeedCoverage
  );
});

test("keeps implausible and incomplete runs unclassified", () => {
  const implausible = extractWorkoutFeatureVector("bad", "run", source({
    durationSeconds: 13 * 60 * 60,
    distanceKm: 2.2,
    heartRate: { ...source().heartRate, average: null }
  }));
  assert.equal(implausible.sessionType, "unknown");

  const missingDistance = extractWorkoutFeatureVector("missing", "run", source({
    distanceKm: null
  }));
  assert.equal(missingDistance.sessionType, "unknown");
});

test("uses easy as the conservative fallback when heart-rate data is absent", () => {
  const feature = extractWorkoutFeatureVector("no_hr", "run", source({
    heartRate: {
      average: null, minimum: null, maximum: null, sampleCount: 0,
      firstAt: null, lastAt: null, coefficientOfVariation: null
    }
  }));
  assert.equal(feature.sessionType, "easy");
});
