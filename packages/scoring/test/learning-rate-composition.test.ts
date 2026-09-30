import assert from "node:assert/strict";
import test from "node:test";

import { baseLearningRate, updateTrueAbility } from "../src/index.js";

// -----------------------------------------------------------------------------
// §6.9 alpha composition:
//
//   alpha_eff = alpha(N) * evidenceReliability * evidenceStrength * growthResistance
//   TA_after  = clamp(TA_before + alpha_eff * residual, 0, 100)
//
// There is no direction factor. Negative learning is damped by the K-consecutive
// confirmation gate, which asks whether a decline is real, rather than by shrinking
// every single negative step. `directionFactor(recovery)` was removed first (a low
// recovery dimension no longer slows a decline); the remaining base discount of 0.4
// was removed here, which is the 2.5x change §6.9 asks to be measured on its own.
// -----------------------------------------------------------------------------

/** Where growthResistance is exactly 1, so direction is the only free variable. */
const NEUTRAL_TRUE_ABILITY = 50;

test("alpha(N) is continuous and matches the documented curve", () => {
  // A formula check, not a table of literals: if the constants move, the shape has
  // to stay the documented one.
  for (const n of [0, 1, 10, 11, 25, 30, 31, 200]) {
    const expected = 0.04 + 0.11 * Math.exp(-n / 25);
    assert.ok(
      Math.abs(baseLearningRate(n) - expected) < 1e-12,
      `alpha(${n}) = ${baseLearningRate(n)}, expected ${expected}`
    );
  }
  // Monotonically decreasing, with no step at the old 10 / 30 boundaries.
  assert.ok(baseLearningRate(10) > baseLearningRate(11));
  assert.ok(baseLearningRate(30) > baseLearningRate(31));
  assert.ok(baseLearningRate(0) > baseLearningRate(1000));
});

test("an equal-sized negative residual moves true ability as much as a positive one", () => {
  // The sharpest statement of the new policy: at the neutral point nothing damps the
  // negative side. Re-introducing any per-step discount breaks this immediately, which
  // is the point — the previous 0.4 made the two sides differ by 2.5x.
  const common = {
    trueAbility: NEUTRAL_TRUE_ABILITY,
    eligibleWorkoutCount: 40,
    evidenceReliability: 1,
    evidenceStrength: 1
  };
  const rise = updateTrueAbility({ ...common, currentAbility: NEUTRAL_TRUE_ABILITY + 12 });
  const fall = updateTrueAbility({ ...common, currentAbility: NEUTRAL_TRUE_ABILITY - 12 });

  const up = rise - NEUTRAL_TRUE_ABILITY;
  const down = NEUTRAL_TRUE_ABILITY - fall;
  assert.ok(up > 0 && down > 0, `both directions must move: up=${up}, down=${down}`);
  assert.ok(
    Math.abs(up - down) < 1e-9,
    `negative learning is still discounted: a +12 residual moved ${up}, a -12 residual moved ${down}`
  );
});

test("growthResistance still damps positives only, and never the negative side", () => {
  const common = {
    eligibleWorkoutCount: 40,
    evidenceReliability: 1,
    evidenceStrength: 1
  };
  const alpha = baseLearningRate(40);
  const high = 90;
  const rise = updateTrueAbility({ ...common, trueAbility: high, currentAbility: high + 12 });
  const fall = updateTrueAbility({ ...common, trueAbility: high, currentAbility: high - 12 });

  // Near the ceiling a rise is resisted...
  assert.ok(rise - high < alpha * 12 - 1e-9, `growth resistance did not damp the rise: ${rise - high}`);
  // ...while a fall is not. This is what keeps "avoid double damping" (doc §6.9)
  // true once the direction factor is gone.
  assert.ok(Math.abs((high - fall) - alpha * 12) < 1e-9, `a fall was damped: ${high - fall}`);
});

test("the residual is clamped to +/-12 before the composition, on both sides", () => {
  const common = {
    trueAbility: NEUTRAL_TRUE_ABILITY,
    eligibleWorkoutCount: 40,
    evidenceReliability: 1,
    evidenceStrength: 1
  };
  // A residual far above the cap must land exactly on it...
  assert.equal(
    updateTrueAbility({ ...common, currentAbility: 100 }),
    updateTrueAbility({ ...common, currentAbility: NEUTRAL_TRUE_ABILITY + 12 })
  );
  // ...and so must one far below. The negative side had no equivalent check until the
  // direction factor was removed, so it is the side worth stating.
  assert.equal(
    updateTrueAbility({ ...common, currentAbility: 0 }),
    updateTrueAbility({ ...common, currentAbility: NEUTRAL_TRUE_ABILITY - 12 })
  );
});
