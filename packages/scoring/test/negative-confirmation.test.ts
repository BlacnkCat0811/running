import assert from "node:assert/strict";
import test from "node:test";

import type { WorkoutFeatureVector } from "@rai/contracts";

import { defaultRaiModelConfig, updateTrueAbilityFromFeatureScore } from "../src/index.js";
import { scoreFeature as scoreFeatureWithHistory, type PersonalBaseline } from "../src/model.js";

// §6.2 stratum sufficiency has its own test file. These cases are about the
// consecutive-negative count, so they state a mature history up front.
const SUFFICIENT_HISTORY: Parameters<typeof scoreFeatureWithHistory>[3] = { independentSessions: 24, spanDays: 90 };
const scoreFeature = (
  feature: WorkoutFeatureVector,
  baseline: PersonalBaseline,
  maturity: number,
  config?: Parameters<typeof scoreFeatureWithHistory>[4]
) => scoreFeatureWithHistory(feature, baseline, maturity, SUFFICIENT_HISTORY, config);

// -----------------------------------------------------------------------------
// §6.9 consecutive-negative confirmation.
//
// One bad day must not rewrite long-term ability, so a negative residual is
// *recorded* until `negativeConfirmationCount` of them line up. A race or protocol
// test is a deliberate maximal effort and confirms immediately.
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

/** Every configured dimension sits at z = 1, so the observed ability is 60. */
const feature = (overrides: Partial<WorkoutFeatureVector> = {}): WorkoutFeatureVector => ({
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
    efficiencyRaw: 0.022,
    paceRawMetersPerSecond: 3.1,
    cardioRaw: null,
    stabilityRaw: 0.9,
    recoveryRaw: 0.75,
    heartRateReserveFraction: 0.7,
    heartRateCoefficientOfVariation: 0.04,
    speedCoefficientOfVariation: 0.04,
    sleepDurationMinutes: 480,
    restingHeartRateBpm: 50,
    hrvSdnnMs: 60,
    recentLoadMinutes: 180
  },
  provenance: {},
  computedAt: "2026-02-01T01:00:00.000Z",
  ...overrides
});

const config = defaultRaiModelConfig;
const strong = (): ReturnType<typeof scoreFeature> => scoreFeature(feature(), baseline, 1);

test("F10: default policy wants two consecutive negatives", () => {
  assert.equal(config.negativeConfirmationCount, 2);
  const score = strong();
  assert.ok(Math.abs((score.learningObservation ?? 0) - 60) < 1e-9);

  const first = updateTrueAbilityFromFeatureScore(70, 30, score, config, 0);
  assert.equal(first.updated, false, "a single bad day must not move ability");
  assert.equal(first.nextTrueAbility, 70);
  assert.equal(first.pendingNegativeConfirmations, 1);

  const second = updateTrueAbilityFromFeatureScore(70, 30, score, config, first.pendingNegativeConfirmations);
  assert.equal(second.updated, true);
  assert.ok(second.nextTrueAbility < 70);
  assert.equal(second.pendingNegativeConfirmations, 0, "an applied change starts a fresh run");
});

test("a positive observation resets the run", () => {
  const score = strong();
  const positive = updateTrueAbilityFromFeatureScore(50, 30, score, config, 1);
  assert.equal(positive.updated, true);
  assert.equal(positive.pendingNegativeConfirmations, 0);

  // And with the run reset, the next negative starts counting from scratch.
  const afterReset = updateTrueAbilityFromFeatureScore(70, 30, score, config, positive.pendingNegativeConfirmations);
  assert.equal(afterReset.updated, false);
  assert.equal(afterReset.pendingNegativeConfirmations, 1);
});

test("a workout the gate refuses neither advances nor breaks the run", () => {
  // A session the gate cannot learn from is also not evidence that the athlete
  // improved, so the count is preserved rather than cleared. `recovery_unknown` is
  // used because since §6.2 a well-structured interval is comparable.
  const gated = scoreFeature(feature({ sessionType: "unknown" }), baseline, 1);
  const update = updateTrueAbilityFromFeatureScore(70, 30, gated, config, 1);
  assert.equal(update.updated, false);
  assert.equal(update.directionFactor, 0);
  assert.equal(update.pendingNegativeConfirmations, 1);
});

test("a race or protocol test confirms immediately", () => {
  const race = scoreFeature(feature({ sessionType: "race" }), baseline, 1);
  assert.equal(race.protocolTest, true);
  const update = updateTrueAbilityFromFeatureScore(70, 30, race, config, 0);
  assert.equal(update.updated, true);
  assert.equal(update.pendingNegativeConfirmations, 0);
});

test("the confirmation count is policy, not a constant", () => {
  const score = strong();
  const immediate = updateTrueAbilityFromFeatureScore(70, 30, score, { ...config, negativeConfirmationCount: 1 }, 0);
  assert.equal(immediate.updated, true);

  let pending = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const step = updateTrueAbilityFromFeatureScore(70, 30, score, { ...config, negativeConfirmationCount: 3 }, pending);
    assert.equal(step.updated, false, `attempt ${attempt} of 3 must not apply`);
    pending = step.pendingNegativeConfirmations;
  }
  const third = updateTrueAbilityFromFeatureScore(70, 30, score, { ...config, negativeConfirmationCount: 3 }, pending);
  assert.equal(third.updated, true);
});

test("a large negative residual cannot be split across the count", () => {
  // The confirmation gate must not become a way to drop ability faster by
  // re-labelling; each applied step still respects the residual clamp and the
  // [0, 100] floor.
  const score = strong();
  const observation = score.learningObservation ?? 0;
  let ability = 100;
  let pending = 0;
  let applied = 0;
  for (let step = 0; step < 10; step += 1) {
    const update = updateTrueAbilityFromFeatureScore(ability, 40, score, config, pending);
    pending = update.pendingNegativeConfirmations;
    assert.ok(update.nextTrueAbility >= 0 && update.nextTrueAbility <= 100);
    assert.ok(update.nextTrueAbility <= ability, "ability must never rise on a negative observation");
    // The step size is bounded by the residual clamp, so the count cannot be used
    // to take one oversized drop.
    assert.ok(ability - update.nextTrueAbility <= 12, "a single applied step exceeded the residual clamp");
    if (update.updated) applied += 1;
    ability = update.nextTrueAbility;
  }
  assert.equal(applied, 5, "ten observations at K=2 should apply about half the time");
  // Convergence from above: ability approaches the observation and never passes it,
  // because a non-negative residual is not a decline at all.
  assert.ok(ability > observation, `ability ${ability} overshot the observation ${observation}`);
});
