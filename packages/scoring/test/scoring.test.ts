import assert from "node:assert/strict";
import test from "node:test";

import type { WorkoutFeatureVector } from "@rai/contracts";

import {
  defaultRaiModelConfig,
  confidenceScore,
  growthResistance,
  inactivityDecay,
  updateTrueAbility,
  weightedCurrentAbility
} from "../src/index.js";
import { scoreFeature, type PersonalBaseline } from "../src/model.js";

const baseline: PersonalBaseline = {
  calibrationFeatureIds: ["calibration"],
  calibrationStartAt: "2026-01-01T00:00:00.000Z",
  calibrationEndAt: "2026-01-15T00:00:00.000Z",
  dimensions: {
    efficiency: { center: 0.02, scale: 0.002 },
    pace: { center: 3, scale: 0.3 },
    stability: { center: 0.8, scale: 0.1 },
    recovery: { center: 0.7, scale: 0.1 }
  }
};

const feature = (overrides: Partial<WorkoutFeatureVector> = {}): WorkoutFeatureVector => ({
  id: "feature", featureRunId: "run", trainingSessionId: "session",
  canonicalWorkoutId: "workout", workoutStartAt: "2026-02-01T00:00:00.000Z",
  durationSeconds: 3600, distanceKm: 10, averageSpeedMetersPerSecond: 3,
  averageHeartRateBpm: 150, heartRateSampleCount: 120, heartRateCoverage: 1,
  routePointCount: 100, routeQuality: 1, sourceConfidence: 1,
  sessionType: "steady", sessionTypeSource: "auto", eligibilityStatus: "eligible",
  qualityScore: 1, missingReasons: [],
  signals: {
    efficiencyRaw: 0.022, paceRawMetersPerSecond: 3.3, cardioRaw: 198,
    stabilityRaw: 0.85, recoveryRaw: 0.75, heartRateReserveFraction: 0.7,
    heartRateCoefficientOfVariation: 0.04, speedCoefficientOfVariation: 0.04,
    sleepDurationMinutes: 480, restingHeartRateBpm: 50, hrvSdnnMs: 60,
    recentLoadMinutes: 180
  },
  provenance: {}, computedAt: "2026-02-01T01:00:00.000Z",
  ...overrides
});

test("keeps the distance-like Cardio proxy out of V1 current ability weights", () => {
  assert.equal(defaultRaiModelConfig.dimensionWeights.cardio, 0);
  assert.equal(
    Object.values(defaultRaiModelConfig.dimensionWeights).reduce((total, weight) => total + weight, 0),
    1
  );
});

test("renormalizes available dimension weights", () => {
  const score = weightedCurrentAbility([
    { dimension: "efficiency", score: 80, baseWeight: 0.3 },
    { dimension: "pace", score: 60, baseWeight: 0.2 }
  ]);
  assert.equal(score, 72);
});

test("confidence uses weighted geometric mean", () => {
  const score = confidenceScore({
    coverage: 0.8,
    source: 0.8,
    comparability: 0.8,
    maturity: 0.8
  });
  assert.ok(Math.abs(score - 0.8) < 1e-12);
});

test("growth resistance decreases as true ability rises", () => {
  assert.ok(growthResistance(60) > growthResistance(80));
  assert.ok(growthResistance(80) > growthResistance(95));
});

test("a single workout residual is capped", () => {
  const common = {
    trueAbility: 50,
    eligibleWorkoutCount: 1,
    confidence: 1,
    evidenceStrength: 1,
    directionFactor: 1
  };
  const capped = updateTrueAbility({ ...common, currentAbility: 100 });
  const exactlyTwelve = updateTrueAbility({ ...common, currentAbility: 62 });
  assert.equal(capped, exactlyTwelve);
});

test("inactivity decay starts after day fourteen", () => {
  assert.equal(inactivityDecay(14), 0);
  assert.equal(inactivityDecay(15), 0.03);
  assert.ok(inactivityDecay(61) > inactivityDecay(60));
});

test("scoreFeature covers excluded and eligible main paths", () => {
  const excluded = scoreFeature(feature({ eligibilityStatus: "excluded", missingReasons: ["user_excluded"] }), baseline, 1);
  assert.equal(excluded.status, "excluded");
  assert.equal(excluded.currentAbility, null);
  assert.ok(excluded.explanationCodes.includes("user_excluded"));

  const immature = scoreFeature(feature(), baseline, 0.25);
  const mature = scoreFeature(feature(), baseline, 1);
  assert.equal(mature.status, "eligible");
  assert.ok((mature.currentAbility ?? 0) > 50);
  assert.ok(immature.confidence < mature.confidence);
  assert.ok(Math.abs(Object.values(mature.effectiveWeights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
});
