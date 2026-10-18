import assert from "node:assert/strict";
import test from "node:test";

import {
  GRADE_ADJUSTMENT_POLICY_VERSION,
  MAXIMUM_GRADE_FRACTION,
  buildWorkoutEnvironmentView,
  gradeAdjustedPace,
  gradeCostJoulesPerKgMeter
} from "../src/index.js";

const reference = { temperatureC: 15, humidityPercent: 50, elevationGainMeters: 0 };

test("N02: grade adjustment is exact at zero and monotone where the cost model is monotone", () => {
  // The Minetti (2002) cost curve is **U-shaped**: it bottoms out around −20 %
  // (eccentric braking gets expensive again on steeper descents), so the
  // flat-equivalent pace is monotone only on each side of that minimum. The old
  // assertion sampled [−6 %, +10 %] and claimed global monotonicity, which the
  // model does not have; this splits the claim into the part that is true.
  const pace = 300;
  const flat = gradeAdjustedPace(pace, 0);
  assert.equal(flat.paceSecondsPerKm, pace, "a flat split must be its own flat equivalent");

  // Uphill side of the minimum: every extra percent of grade costs more, so the
  // flat-equivalent pace falls monotonically.
  const uphill = [-5, -1, 0, 1, 3, 6, 10, 20, 30, 45];
  const uphillValues = uphill.map((grade) => gradeAdjustedPace(pace, grade).paceSecondsPerKm);
  for (let index = 1; index < uphillValues.length; index += 1) {
    assert.ok(
      uphillValues[index]! < uphillValues[index - 1]!,
      `equivalent flat pace must fall as the grade rises: ${uphill[index - 1]}% -> ${uphill[index]}%`
    );
  }
  assert.ok(uphillValues.at(-1)! < pace, "uphill is faster at flat-equivalent effort");

  // Steep descent past the cost minimum: the model says a −30 % grade costs more
  // than a −20 % one, so the "faster because steeper" reading is false there. The
  // assertion is deliberately about the model, not about a policy choice.
  const shallowDescent = gradeAdjustedPace(pace, -20).paceSecondsPerKm;
  const steepDescent = gradeAdjustedPace(pace, -30).paceSecondsPerKm;
  const steepest = gradeAdjustedPace(pace, -MAXIMUM_GRADE_FRACTION * 100).paceSecondsPerKm;
  assert.ok(shallowDescent > pace, "a steep descent is slower than flat at equal effort");
  assert.ok(steepDescent < shallowDescent, "past the cost minimum a steeper descent costs more, so the flat equivalent is slower");
  assert.ok(steepest < steepDescent, "the same holds at the domain edge");
});


test("N02: the same split measured twice gives the same adjusted pace (no hidden state)", () => {
  const first = gradeAdjustedPace(287.4, 4.2);
  const second = gradeAdjustedPace(287.4, 4.2);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), ["paceSecondsPerKm", "reasonCodes"]);
  assert.deepEqual(first.reasonCodes, []);
});

test("N02: grade beyond the cost model domain is clamped and says so", () => {
  const beyond = gradeAdjustedPace(300, (MAXIMUM_GRADE_FRACTION + 0.2) * 100);
  assert.deepEqual(beyond.reasonCodes, ["grade_clamped_to_cost_model_domain"]);
  const atLimit = gradeAdjustedPace(300, MAXIMUM_GRADE_FRACTION * 100);
  assert.deepEqual(atLimit.reasonCodes, [], "exactly at the domain edge is still inside the model");
  // Clamping must not produce a value the unclamped polynomial would never give.
  assert.ok(Number.isFinite(beyond.paceSecondsPerKm) && beyond.paceSecondsPerKm > 0);
});

test("N02: the published cost polynomial keeps a positive cost across its domain", () => {
  for (let grade = -MAXIMUM_GRADE_FRACTION; grade <= MAXIMUM_GRADE_FRACTION + 1e-9; grade += 0.01) {
    const cost = gradeCostJoulesPerKgMeter(grade);
    assert.ok(Number.isFinite(cost) && cost > 0, `cost must stay positive at ${grade.toFixed(2)}`);
  }
  assert.equal(gradeCostJoulesPerKgMeter(0), 3.6);
});

test("N01: missing environment fields are unavailable, never a zero correction", () => {
  const view = buildWorkoutEnvironmentView({
    distanceMeters: 10_000,
    durationSeconds: 3_000,
    conditions: { temperatureC: 30, humidityPercent: 80, elevationGainMeters: null }
  });
  assert.equal(view.status, "unavailable");
  assert.equal(view.correction, null, "a partial penalty must not be presented as the total");
  assert.equal(view.adjusted, null, "no adjusted value may be invented from partial input");
  assert.deepEqual(view.reasonCodes, ["elevation_missing"]);
  // The raw observations are still reported: the reader should see 30 °C.
  assert.equal(view.temperatureC, 30);
  assert.equal(view.humidityPercent, 80);
  assert.equal(view.elevationGainMeters, null);
});

test("N01: reference conditions report not_needed with an explicit zero, not null", () => {
  const view = buildWorkoutEnvironmentView({
    distanceMeters: 10_000,
    durationSeconds: 3_000,
    conditions: reference
  });
  assert.equal(view.status, "not_needed");
  assert.deepEqual(view.reasonCodes, ["reference_conditions"]);
  assert.deepEqual(view.correction, { environment: 0, elevation: 0, total: 0 });
  assert.equal(view.adjusted?.durationSeconds, 3_000);
  assert.equal(view.adjusted?.paceSecondsPerKm, 300);
});

test("N01: a hot, humid, hilly run reports applied and the exact penalty components", () => {
  const view = buildWorkoutEnvironmentView({
    distanceMeters: 10_000,
    durationSeconds: 3_600,
    conditions: { temperatureC: 30, humidityPercent: 80, elevationGainMeters: 100 }
  });
  assert.equal(view.status, "applied");
  assert.ok(view.correction !== null);
  assert.ok(view.correction!.environment > 0, "30 °C / 80 % must carry a heat penalty");
  assert.ok(view.correction!.elevation > 0, "100 m over 10 km must carry an elevation penalty");
  assert.equal(view.correction!.total, view.correction!.environment + view.correction!.elevation);
  assert.ok(view.reasonCodes.includes("heat_humidity_adjustment"));
  assert.ok(view.reasonCodes.includes("elevation_adjustment"));
  // Adjusted time is the raw time discounted by the penalty it was given.
  const expected = 3_600 / (1 + view.correction!.total);
  assert.ok(Math.abs((view.adjusted?.durationSeconds ?? 0) - expected) < 1e-9);
  assert.equal(view.policyVersion, "rai-environment-view-v1");
  assert.match(view.adapterVersion, /conditions-v1$/);
  assert.equal(view.source, "workout_metadata");
});

test("N01: the view is the same computation the evidence path uses, not a second estimate", () => {
  const conditions = { temperatureC: 24, humidityPercent: 75, elevationGainMeters: 40 };
  const view = buildWorkoutEnvironmentView({
    distanceMeters: 8_000,
    durationSeconds: 2_400,
    conditions
  });
  assert.equal(view.status, "applied");
  assert.ok(view.correction!.total > 0);
  // Deterministic across calls: the reader cannot see a number that drifts from
  // the one applied to the evidence.
  assert.deepEqual(
    buildWorkoutEnvironmentView({ distanceMeters: 8_000, durationSeconds: 2_400, conditions }),
    view
  );
  assert.equal(GRADE_ADJUSTMENT_POLICY_VERSION, "rai-grade-adjustment-v1");
});
