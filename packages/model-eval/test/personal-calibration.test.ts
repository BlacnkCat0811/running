import assert from "node:assert/strict";
import test from "node:test";

import {
  PERSONAL_CALIBRATION_POLICY,
  assertPersonalIntervalPresentation,
  fitPersonalInterval,
  personalCalibrationReadiness,
  type PersonalCalibrationSample
} from "../src/index.js";

/**
 * M05/M06: the personal tier is a different object from the population one, and the
 * way it fails is by *looking like* the population tier.
 *
 *   M05  a self-calibrated band presented with P80/P90 vocabulary;
 *   M06  a band fitted from too few labels, or from residuals that are not held out.
 */

const sample = (overrides: Partial<PersonalCalibrationSample> = {}): PersonalCalibrationSample => ({
  distance: "ten_k",
  observedAt: "2026-01-01T04:00:00.000Z",
  pointSeconds: 2_400,
  actualSeconds: 2_400,
  ...overrides
});

/** Eight ten-k labels spanning 200 days, actual = predicted + `bias`. */
function series(bias: (index: number) => number, count = 8): PersonalCalibrationSample[] {
  return Array.from({ length: count }, (_, index) => sample({
    observedAt: new Date(Date.UTC(2026, 0, 1) + index * 25 * 86_400_000).toISOString(),
    actualSeconds: 2_400 + bias(index)
  }));
}

test("M05: a personal band must not borrow the population vocabulary", () => {
  const evidence = fitPersonalInterval({ distance: "ten_k", samples: series((index) => index * 10) });
  assert.ok(evidence, "eight labels with held-out residuals are enough for the personal tier");
  assert.equal(evidence.method, "leave_one_out_residual_v1");
  assert.equal(evidence.coverageClaim, "personal_self_calibrated_not_population_guarantee");
  assert.equal(evidence.samples, 8);
  assert.equal(evidence.evaluated, 8, "every label contributes its own held-out residual");
  assertPersonalIntervalPresentation(evidence);

  for (const forbidden of ["nominalCoverage", "coverageP80", "coverageP90"]) {
    assert.throws(
      () => assertPersonalIntervalPresentation({ ...evidence, [forbidden]: 0.8 } as never),
      new RegExp(forbidden),
      `${forbidden} must be refused on a personal band`
    );
  }
  assert.throws(
    () => assertPersonalIntervalPresentation({ ...evidence, coverageClaim: "empirical_target_not_individual_guarantee" } as never),
    /self-calibrated disclaimer/
  );
});

test("M06: below the label floor no band is produced at all", () => {
  const samples = series((index) => index, PERSONAL_CALIBRATION_POLICY.minimumSamples - 1);
  assert.equal(fitPersonalInterval({ distance: "ten_k", samples }), null);

  const readiness = personalCalibrationReadiness(samples);
  assert.equal(readiness.available, false);
  assert.ok(readiness.reasonCodes.includes("samples_below_minimum"));
  assert.ok(readiness.reasonCodes.includes("distances_below_minimum"));
  assert.equal(readiness.samples, PERSONAL_CALIBRATION_POLICY.minimumSamples - 1);
});

test("M06: the gate refuses a band whose residuals are not leave-one-out", () => {
  const evidence = fitPersonalInterval({ distance: "ten_k", samples: series((index) => index * 5) });
  assert.ok(evidence);
  assert.throws(
    () => assertPersonalIntervalPresentation({ ...evidence, evaluated: evidence.samples - 2 } as never),
    /not leave-one-out/
  );
});

test("M06: readiness needs labels, distances and a span — and reports which is missing", () => {
  const oneDistance = series((index) => index * 4);
  const readiness = personalCalibrationReadiness(oneDistance);
  assert.equal(readiness.available, false);
  assert.deepEqual(readiness.reasonCodes, ["distances_below_minimum"], "8 labels over 175 days but one distance");

  const twoDistances = [
    ...series((index) => index * 4),
    ...series((index) => index * 6).map((item) => ({ ...item, distance: "half_marathon" as const }))
  ];
  const ready = personalCalibrationReadiness(twoDistances);
  assert.equal(ready.available, true);
  assert.deepEqual(ready.reasonCodes, []);
  assert.ok(ready.spanDays >= PERSONAL_CALIBRATION_POLICY.minimumSpanDays);
});

test("M06: a short block of labels does not qualify, however many there are", () => {
  const compressed = Array.from({ length: 12 }, (_, index) => sample({
    distance: index % 2 === 0 ? "ten_k" : "half_marathon",
    observedAt: new Date(Date.UTC(2026, 0, 1) + index * 3 * 86_400_000).toISOString(),
    actualSeconds: 2_400 + index * 5
  }));
  const readiness = personalCalibrationReadiness(compressed);
  assert.equal(readiness.available, false);
  assert.ok(readiness.reasonCodes.includes("span_below_minimum"));
});

test("M05: the band is the runner's own residual spread, and it widens with it", () => {
  const tight = fitPersonalInterval({ distance: "ten_k", samples: series((index) => (index % 2 === 0 ? -5 : 5)) });
  const loose = fitPersonalInterval({ distance: "ten_k", samples: series((index) => (index % 2 === 0 ? -60 : 60)) });
  assert.ok(tight && loose);
  assert.ok(loose.upperSeconds - loose.lowerSeconds > tight.upperSeconds - tight.lowerSeconds);
  // Residuals, not absolute times: a bias of +10 s per label stays a narrow band.
  assert.ok(tight.upperSeconds - tight.lowerSeconds <= 10);
});

test("M06: non-finite residuals cannot enter the band", () => {
  const samples = [
    ...series((index) => index * 3, 7),
    sample({ actualSeconds: Number.NaN })
  ];
  const evidence = fitPersonalInterval({ distance: "ten_k", samples });
  assert.ok(evidence);
  assert.equal(evidence.samples, 8, "the label still counts toward the sample floor");
  assert.equal(evidence.evaluated, 7, "but a non-finite residual is not evaluated");
  assertPersonalIntervalPresentation(evidence);
});
