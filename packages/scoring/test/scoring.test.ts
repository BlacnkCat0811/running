import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultRaiModelConfig,
  confidenceScore,
  growthResistance,
  inactivityDecay,
  updateTrueAbility,
  weightedCurrentAbility
} from "../src/index.js";

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
