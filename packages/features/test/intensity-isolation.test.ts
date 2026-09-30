import assert from "node:assert/strict";
import test from "node:test";

import { extractWorkoutFeatureVector, type WorkoutFeatureSource } from "../src/index.js";

const startAt = "2026-03-01T06:00:00.000Z";
const endAt = "2026-03-01T07:00:00.000Z";

/**
 * Intensity inference must read the long-term resting-HR reference, never today's
 * recovery observation. `restingHeartRateReference` is what the session type is
 * derived from; `restingHeartRate`, `hrvSdnn` and `sleepDurationMinutes` are the
 * day's recovery readings.
 */
function source(overrides: Partial<WorkoutFeatureSource> = {}): WorkoutFeatureSource {
  return {
    id: "workout_1",
    trainingSessionId: "session_1",
    trainingSessionStatus: "active",
    workoutStartAt: startAt,
    workoutEndAt: endAt,
    durationSeconds: 3600,
    distanceKm: 10,
    indoor: false,
    sourceCategory: "apple_watch",
    routePointCount: 100,
    routeQuality: 0.9,
    speed: {
      average: 10 / 3.6,
      minimum: 2.6,
      maximum: 3,
      sampleCount: 120,
      firstAt: startAt,
      lastAt: endAt,
      coefficientOfVariation: 0.04
    },
    heartRate: {
      average: 130,
      minimum: 118,
      maximum: 142,
      sampleCount: 120,
      firstAt: startAt,
      lastAt: endAt,
      coefficientOfVariation: 0.05,
      coveredDurationSeconds: 3600
    },
    restingHeartRate: 50,
    restingHeartRateReference: 50,
    hrvSdnn: 50,
    sleepDurationMinutes: 420,
    recentLoadMinutes: 180,
    recoveryBaseline: {
      sleepMinutes: 430,
      restingHeartRateBpm: 50,
      hrvSdnnMs: 52,
      loadMinutes: 180
    },
    observedMaximumHeartRate: 190,
    override: null,
    ...overrides
  };
}

test("today's recovery readings do not move session type or heart-rate reserve", () => {
  const extract = (overrides: Partial<WorkoutFeatureSource>) =>
    extractWorkoutFeatureVector("f", "run", source(overrides), undefined, "2026-03-01T08:00:00.000Z");

  const base = extract({});
  // Guards against the whole test passing because every variant collapsed to
  // "unknown" — that would be equality without meaning.
  assert.notEqual(base.sessionType, "unknown");

  const variants: Array<[string, Partial<WorkoutFeatureSource>]> = [
    ["a raised resting heart rate", { restingHeartRate: 62 }],
    ["a suppressed HRV", { hrvSdnn: 35 }],
    ["a short night", { sleepDurationMinutes: 280 }],
    ["all three at once", { restingHeartRate: 62, hrvSdnn: 35, sleepDurationMinutes: 280 }],
    ["missing recovery readings entirely", { restingHeartRate: null, hrvSdnn: null, sleepDurationMinutes: null }]
  ];

  for (const [label, overrides] of variants) {
    const variant = extract(overrides);
    assert.equal(variant.sessionType, base.sessionType, `session type moved with ${label}`);
    assert.equal(
      variant.signals.heartRateReserveFraction,
      base.signals.heartRateReserveFraction,
      `heart-rate reserve moved with ${label}`
    );
  }
});

test("the long-term reference is what actually drives heart-rate reserve", () => {
  const extract = (overrides: Partial<WorkoutFeatureSource>) =>
    extractWorkoutFeatureVector("f", "run", source(overrides), undefined, "2026-03-01T08:00:00.000Z");

  const base = extract({});
  assert.equal(base.signals.heartRateReserveFraction, (130 - 50) / (190 - 50));

  // Reverting the extractor to today's reading would make this variant identical
  // to the baseline instead of different, so this assertion is the one that fails
  // if the channel is reopened.
  const differentReference = extract({ restingHeartRateReference: 120 });
  assert.notEqual(differentReference.signals.heartRateReserveFraction, base.signals.heartRateReserveFraction);
  assert.equal(differentReference.signals.heartRateReserveFraction, (130 - 120) / (190 - 120));
});

test("a reference without a today reading still infers intensity", () => {
  // Recovery can be missing while the long-term reference is available; the
  // intensity path must not become unavailable just because the night is.
  const feature = extractWorkoutFeatureVector(
    "f",
    "run",
    source({ restingHeartRate: null, hrvSdnn: null, sleepDurationMinutes: null }),
    undefined,
    "2026-03-01T08:00:00.000Z"
  );
  assert.equal(feature.signals.heartRateReserveFraction, (130 - 50) / (190 - 50));
  assert.notEqual(feature.sessionType, "unknown");

  const noReference = extractWorkoutFeatureVector(
    "f",
    "run",
    source({ restingHeartRateReference: null }),
    undefined,
    "2026-03-01T08:00:00.000Z"
  );
  // With no reference there is no reserve fraction, which is a gap in evidence
  // rather than a low value.
  assert.equal(noReference.signals.heartRateReserveFraction, null);
});
