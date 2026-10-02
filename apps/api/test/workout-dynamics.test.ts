import assert from "node:assert/strict";
import test from "node:test";

import type { WorkoutMetricSeries } from "@rai/api-contracts";

import { SPEED_PAIRING_TOLERANCE_SECONDS, buildRunningDynamics, pairWithSpeed } from "../src/workout-dynamics.js";

/**
 * Y02 belongs to the analysis package, but the *pairing* is this module's job: a
 * stride sample with no speed nearby must be paired with nothing, not with the
 * closest value on the other side of an interval. Getting that wrong makes a
 * fast/slow session look like a form collapse.
 */

const series = (points: Array<{ offsetSeconds: number; value: number }>): WorkoutMetricSeries => ({
  unit: "spm",
  totalSamples: points.length,
  points: points.map((point) => ({ ...point, timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + point.offsetSeconds * 1000).toISOString() }))
});

test("Y02: speed pairing respects the tolerance window instead of taking the nearest value", () => {
  const speed = series([
    { offsetSeconds: 0, value: 3 },
    { offsetSeconds: 600, value: 5 }
  ]);
  const inside = pairWithSpeed(series([{ offsetSeconds: 10, value: 180 }]), speed);
  assert.equal(inside[0]!.speedMetersPerSecond, 3, "10 s is inside the 0 s sample's window");

  const outside = pairWithSpeed(series([{ offsetSeconds: 30, value: 180 }]), speed);
  assert.equal(outside[0]!.speedMetersPerSecond, null, "30 s is outside a 15 s window — no pairing at all");

  const far = pairWithSpeed(series([{ offsetSeconds: 300, value: 180 }]), speed);
  assert.equal(far[0]!.speedMetersPerSecond, null, "300 s is outside both windows");
  assert.ok(SPEED_PAIRING_TOLERANCE_SECONDS < 30);
});

test("Y03: non-finite stride samples are dropped before they can be averaged", () => {
  const paired = pairWithSpeed(
    series([
      { offsetSeconds: 0, value: Number.NaN },
      { offsetSeconds: 30, value: 178 }
    ]),
    series([{ offsetSeconds: 0, value: 3 }])
  );
  assert.equal(paired.length, 1);
  assert.equal(paired[0]!.value, 178);
});

test("Y01: a run whose watch recorded no dynamics reports unavailable, not a zero average", () => {
  const empty = series([]);
  const analysis = buildRunningDynamics({
    durationSeconds: 3_600,
    series: { cadence: empty, speed: empty, strideLength: empty, verticalOscillation: empty, groundContactTime: empty }
  });
  for (const metric of analysis.metrics) {
    assert.equal(metric.status, "unavailable");
    assert.equal(metric.average, null);
  }
  assert.match(analysis.note ?? "", /没有任何跑姿动态样本/);
  assert.equal(analysis.evidenceStatus, "device_estimated_not_lab_validated");
});

test("Y02: a full cadence series at constant speed reports the drift and flags it", () => {
  const cadence = series(Array.from({ length: 121 }, (_, index) => ({
    offsetSeconds: index * 30,
    value: index * 30 <= 1_800 ? 180 : 171
  })));
  const speed = series(Array.from({ length: 121 }, (_, index) => ({ offsetSeconds: index * 30, value: 3 })));
  const analysis = buildRunningDynamics({
    durationSeconds: 3_600,
    series: { cadence, speed, strideLength: series([]), verticalOscillation: series([]), groundContactTime: series([]) }
  });
  const metric = analysis.metrics.find((item) => item.name === "cadence");
  assert.equal(metric?.status, "available");
  assert.equal(metric?.driftFraction, -0.05);
  assert.ok(analysis.flags.some((flag) => flag.code === "cadence_drift"));
});
