import assert from "node:assert/strict";
import test from "node:test";

import {
  PERSONAL_CALIBRATION_POLICY,
  assertPersonalIntervalPresentation,
  fitPersonalInterval,
  personalBandSeconds,
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
  const evidence = fitPersonalInterval({ samples: series((index) => index * 10) });
  assert.ok(evidence, "eight labels with held-out residuals are enough for the personal tier");
  assert.equal(evidence.method, "leave_one_out_relative_residual_v1");
  assert.equal(evidence.coverageClaim, "personal_self_calibrated_not_population_guarantee");
  assert.equal(evidence.samples, 8);
  assert.equal(evidence.evaluated, 8, "every label contributes its own held-out ratio");
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

test("M05: a band that excludes the runner's own centre is a bias claim, not an uncertainty", () => {
  const evidence = fitPersonalInterval({ samples: series((index) => index * 4) });
  assert.ok(evidence);
  // A systematic bias the rule does not capture: every ratio sits above 1. The band
  // is allowed to sit above 1 — it is the runner's own centre — but it must *contain*
  // that centre, or it is claiming something the sample does not support.
  assert.ok(evidence.relativeLower > 1, "eight consistently slower races push the whole band above 1");
  assertPersonalIntervalPresentation(evidence);
  assert.throws(
    () => assertPersonalIntervalPresentation({ ...evidence, relativeUpper: evidence.relativeLower - 0.01 } as never),
    /contain the runner's own centre/
  );
});

test("M06: below the label floor no band is produced at all", () => {
  const samples = series((index) => index, PERSONAL_CALIBRATION_POLICY.minimumSamples - 1);
  assert.equal(fitPersonalInterval({ samples }), null);

  const readiness = personalCalibrationReadiness(samples);
  assert.equal(readiness.available, false);
  assert.ok(readiness.reasonCodes.includes("samples_below_minimum"));
  assert.ok(readiness.reasonCodes.includes("distances_below_minimum"));
  assert.equal(readiness.samples, PERSONAL_CALIBRATION_POLICY.minimumSamples - 1);
});

test("M06: the gate refuses a band whose residuals are not leave-one-out", () => {
  const evidence = fitPersonalInterval({ samples: series((index) => index * 5) });
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
  const tight = fitPersonalInterval({ samples: series((index) => (index % 2 === 0 ? -5 : 5)) });
  const loose = fitPersonalInterval({ samples: series((index) => (index % 2 === 0 ? -60 : 60)) });
  assert.ok(tight && loose);
  assert.ok(
    loose.relativeUpper - loose.relativeLower > tight.relativeUpper - tight.relativeLower,
    "a wider residual spread must produce a wider band"
  );
  // Ratios, not seconds: ±5 s on a 2 400 s prediction is a band a few tenths of a
  // percent wide, and that is the point — the same ratio transfers between distances.
  assert.ok(tight.relativeUpper - tight.relativeLower <= 0.01);
  assert.ok(tight.relativeLower <= tight.relativeCenter && tight.relativeCenter <= tight.relativeUpper);
  const bounds = personalBandSeconds(tight, 2_400);
  assert.ok(bounds && bounds.lowerSeconds <= 2_400 && bounds.upperSeconds >= 2_400);
});

test("M06: non-finite residuals cannot enter the band", () => {
  const samples = [
    ...series((index) => index * 3, 7),
    sample({ actualSeconds: Number.NaN })
  ];
  const evidence = fitPersonalInterval({ samples });
  assert.ok(evidence);
  assert.equal(evidence.samples, 8, "the label still counts toward the sample floor");
  assert.equal(evidence.evaluated, 7, "but a non-finite residual is not evaluated");
  assertPersonalIntervalPresentation(evidence);
});

test("M05/M06: the fitted band always passes the presentation gate it is shown under", () => {
  // Mutation that turns this red: remove the `assertPersonalIntervalPresentation`
  // call from `fitPersonalInterval`, so the only thing checking a displayable personal
  // band is a caller that may forget (production returns the fit result directly).
  for (const count of [8, 9, 12]) {
    const evidence = fitPersonalInterval({ samples: series((index) => index * 3, count) });
    assert.ok(evidence, `${count} labels must produce a band`);
    assertPersonalIntervalPresentation(evidence);
  }
  // Leave-one-out means at most one unusable pair; with two of them the fit returns
  // null instead of a band the gate would refuse.
  const twoBroken = [
    ...series((index) => index * 3, 8),
    sample({ actualSeconds: Number.NaN }),
    sample({ pointSeconds: Number.NaN })
  ];
  assert.equal(fitPersonalInterval({ samples: twoBroken }), null);
});
