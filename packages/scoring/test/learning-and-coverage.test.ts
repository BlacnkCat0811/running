import assert from "node:assert/strict";
import test from "node:test";

import type { WorkoutFeatureVector } from "@rai/contracts";

import {
  LEARNING_RATE_DECAY_WORKOUTS,
  LEARNING_RATE_MAX,
  LEARNING_RATE_MIN,
  baseLearningRate,
  defaultRaiModelConfig,
  updateTrueAbilityFromFeatureScore
} from "../src/index.js";
import { scoreFeature as scoreFeatureWithHistory, type PersonalBaseline } from "../src/model.js";

// §6.2 stratum sufficiency has its own test file. These cases are about coverage and
// learning-rate policy, so they state a mature history up front.
const SUFFICIENT_HISTORY: Parameters<typeof scoreFeatureWithHistory>[3] = { independentSessions: 24, spanDays: 90 };
const scoreFeature = (
  feature: WorkoutFeatureVector,
  baseline: PersonalBaseline,
  maturity: number,
  config?: Parameters<typeof scoreFeatureWithHistory>[4]
) => scoreFeatureWithHistory(feature, baseline, maturity, SUFFICIENT_HISTORY, config);

// -----------------------------------------------------------------------------
// §6.5 display shrinkage, §6.6 learning separation, §6.8 continuous alpha.
// These are the doc's F03–F06 acceptance cases.
// -----------------------------------------------------------------------------

const baseline: PersonalBaseline = {
  calibrationFeatureIds: ["calibration"],
  calibrationStartAt: "2026-01-01T00:00:00.000Z",
  calibrationEndAt: "2026-01-15T00:00:00.000Z",
  dimensions: {
    efficiency: { center: 0.02, scale: 0.002 },
    pace: { center: 2.8, scale: 0.3 },
    stability: { center: 0.8, scale: 0.1 }
  }
};

/** A raw value that scores exactly `z` sigma above the dimension's centre. */
const atZ = (dimension: "efficiency" | "pace" | "stability", z: number): number => {
  const entry = baseline.dimensions[dimension]!;
  return entry.center + z * entry.scale;
};

/** Dimension scores come out of floating-point arithmetic, so compare with a tolerance. */
const assertClose = (actual: number | null, expected: number, label: string): void => {
  assert.ok(actual !== null, `${label} was null`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ~${expected}, got ${actual}`);
};

const feature = (signals: Partial<WorkoutFeatureVector["signals"]> = {}): WorkoutFeatureVector => ({
  id: "feature",
  featureRunId: "run",
  trainingSessionId: "session",
  canonicalWorkoutId: "workout",
  workoutStartAt: "2026-02-01T00:00:00.000Z",
  durationSeconds: 3600,
  distanceKm: 10,
  averageSpeedMetersPerSecond: 2.8,
  averageHeartRateBpm: 150,
  heartRateSampleCount: 120,
  heartRateCoverage: 1,
  routePointCount: 100,
  routeQuality: 1,
  sourceConfidence: 1,
  sessionType: "steady",
  sessionTypeSource: "auto",
  eligibilityStatus: "eligible",
  qualityScore: 1,
  missingReasons: [],
  signals: {
    // All three configured dimensions score 60 (z = 1).
    efficiencyRaw: atZ("efficiency", 1),
    paceRawMetersPerSecond: atZ("pace", 1),
    cardioRaw: null,
    stabilityRaw: atZ("stability", 1),
    recoveryRaw: 0.75,
    heartRateReserveFraction: 0.7,
    heartRateCoefficientOfVariation: 0.04,
    speedCoefficientOfVariation: 0.04,
    sleepDurationMinutes: 480,
    restingHeartRateBpm: 50,
    hrvSdnnMs: 60,
    recentLoadMinutes: 180,
    ...signals
  },
  provenance: {},
  computedAt: "2026-02-01T01:00:00.000Z"
});

test("full dimension coverage is coverage 1, not the raw configured weight sum", () => {
  // V2-A's configured weights sum to 0.875. Normalising by that total is what
  // makes "every dimension present" mean coverage 1 instead of 0.875 — otherwise
  // every workout would be shrunk even with nothing missing.
  const score = scoreFeature(feature(), baseline, 1);
  assert.equal(score.dimensionCoverage, 1);
  assert.equal(score.currentAbility, score.learningObservation);
});

test("F03: the same dimension scores, less coverage, shrinks the display estimate toward 50", () => {
  // Coverage policy is relaxed here so the *learning* target is observable in both
  // runs. With the shipped default (coverage 1) the partial run has no learning
  // target at all, which is asserted separately below.
  const config = { ...defaultRaiModelConfig, minimumLearningCoverage: 0.65 };
  const full = scoreFeature(feature(), baseline, 1, config);
  const partial = scoreFeature(feature({ stabilityRaw: null }), baseline, 1, config);

  // Both workouts show the same observed score, because every scored dimension
  // sits at the same z.
  assertClose(full.learningObservation, 60, "full learning observation");
  assertClose(partial.learningObservation, 60, "partial learning observation");

  assert.ok(partial.dimensionCoverage < full.dimensionCoverage);
  // Fewer dimensions seen means a smaller deviation from 50 on the display.
  // The margin is substantive on purpose: a bare `<` comparison is satisfied by
  // 15th-digit floating-point noise, so it would stay green even with the shrink
  // removed entirely.
  const fullDeviation = Math.abs((full.currentAbility ?? 0) - 50);
  const partialDeviation = Math.abs((partial.currentAbility ?? 0) - 50);
  assert.ok(
    partialDeviation < fullDeviation - 0.5,
    `expected a real shrink: partial ${partialDeviation} vs full ${fullDeviation}`
  );
  // ...while the learning target is untouched by the shrink.
  assertClose(partial.learningObservation, full.learningObservation ?? 0, "learning target at lower coverage");
  // Confidence must never *rise* when evidence goes missing.
  assert.ok(partial.confidence <= full.confidence);
});

test("F04: dropping a dimension is not promised to move the estimate toward 50", () => {
  // The claim "missing data can never make CA more extreme" is false in general,
  // and a test written as if it were true would encode a bug. This pins the
  // counterexample instead: with efficiency and stability at 100 and pace at 0,
  // the full estimate is 70; dropping pace renormalises the rest to 100 and the
  // shrunk display lands at 85 — further from 50, not closer.
  const config = {
    ...defaultRaiModelConfig,
    dimensionWeights: { efficiency: 0.4, pace: 0.3, cardio: 0, stability: 0.3, recovery: 0 }
  };
  const strong = { efficiencyRaw: atZ("efficiency", 5), stabilityRaw: atZ("stability", 5) };
  const weakPace = { paceRawMetersPerSecond: atZ("pace", -5) };

  const all = scoreFeature(feature({ ...strong, ...weakPace }), baseline, 1, config);
  const withoutPace = scoreFeature(feature({ ...strong, paceRawMetersPerSecond: null }), baseline, 1, config);

  assertClose(all.currentAbility, 70, "full estimate");
  assert.equal(withoutPace.dimensionCoverage, 0.7);
  assertClose(withoutPace.currentAbility, 85, "estimate without pace");
  assert.ok(
    Math.abs((withoutPace.currentAbility ?? 0) - 50) > Math.abs((all.currentAbility ?? 0) - 50) + 0.5,
    "the counterexample needs a substantive margin, not floating-point noise"
  );
});

test("F05: a shrunken display value never becomes a negative learning signal", () => {
  // The doc's case is "TA=70 observed=70 coverage=.65": the display shrinks to ~63
  // and the learning target does not. A relaxed coverage policy is what makes the
  // learning target exist at 0.79 coverage.
  const config = { ...defaultRaiModelConfig, minimumLearningCoverage: 0.65 };
  const partial = scoreFeature(feature({ stabilityRaw: null }), baseline, 1, config);
  const observed = partial.learningObservation;
  assertClose(observed, 60, "learning observation");
  assert.ok((partial.currentAbility ?? 0) < observed!, "display should be shrunk below the observation");

  // True ability equal to the observation: there is nothing to learn.
  const aligned = updateTrueAbilityFromFeatureScore(observed!, 30, partial);
  assert.equal(aligned.updated, false);
  assert.equal(aligned.nextTrueAbility, observed);

  // The case that matters: true ability sitting at the *shrunk display* rather than
  // at the observation. Reading the residual off the display would make this a
  // decline of several points and pull true ability down. Reading it off the
  // observation makes it a small rise toward the observation at worst — never a
  // drop to the display value.
  const display = partial.currentAbility!;
  assert.ok(display < observed!);
  const fromDisplay = updateTrueAbilityFromFeatureScore(display, 30, partial);
  // Strictly greater, not "not lower": reading the residual off the display would
  // leave true ability exactly where it is, which is the failure mode this pins.
  assert.ok(
    fromDisplay.nextTrueAbility > display,
    `residual was not read off the observation: TA stayed at ${fromDisplay.nextTrueAbility}`
  );
});

test("a workout below the learning coverage produces no learning at all", () => {
  // Default policy is coverage 1: one missing configured dimension is enough.
  const partial = scoreFeature(feature({ stabilityRaw: null }), baseline, 1);
  assert.equal(partial.learningObservation, null);
  const update = updateTrueAbilityFromFeatureScore(70, 30, partial);
  assert.equal(update.updated, false);
  assert.equal(update.nextTrueAbility, 70);

  // The display estimate still exists — the athlete sees something.
  assert.notEqual(partial.currentAbility, null);
});

test("F06: alpha is continuous, so no eligible-workout count is a cliff", () => {
  for (const boundary of [10, 30]) {
    const before = baseLearningRate(boundary);
    const after = baseLearningRate(boundary + 1);
    // The old step function moved 0.15 -> 0.10 and 0.10 -> 0.06 here.
    assert.ok(Math.abs(after - before) < 0.005, `jump at ${boundary}: ${before} -> ${after}`);
  }
  assert.equal(baseLearningRate(0), LEARNING_RATE_MAX);
  assert.ok(baseLearningRate(200) > LEARNING_RATE_MIN);
  assert.ok(baseLearningRate(1e6) < LEARNING_RATE_MIN + 1e-6);
  for (let n = 0; n < 60; n += 1) {
    assert.ok(baseLearningRate(n + 1) <= baseLearningRate(n), `alpha rose at N=${n}`);
  }
  assert.equal(LEARNING_RATE_DECAY_WORKOUTS, 25);
});
