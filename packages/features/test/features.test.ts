import assert from "node:assert/strict";
import test from "node:test";

import {
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

  const longRun = extractWorkoutFeatureVector("long", "run", source({
    durationSeconds: 80 * 60,
    distanceKm: 14,
    workoutEndAt: "2025-01-01T01:20:00.000Z"
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
    observedMaximumHeartRate: 201
  }));
  assert.equal(feature.sessionType, "steady");
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
