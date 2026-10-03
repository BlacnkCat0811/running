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

const series = (points: Array<{ offsetSeconds: number; value: number }>, unit = "m/s"): WorkoutMetricSeries => ({
  unit,
  totalSamples: points.length,
  points: points.map((point) => ({ ...point, timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + point.offsetSeconds * 1000).toISOString() }))
});

test("speed pairing converts supported units and declines unknown units", () => {
  const metric = series([{ offsetSeconds: 0, value: 180 }], "spm");
  for (const [unit, value] of [["m/s", 3], ["km/hr", 10.8], ["km/h", 10.8], ["mph", 3 / 0.44704], ["mi/hr", 3 / 0.44704]] as const) {
    const speed = pairWithSpeed(metric, series([{ offsetSeconds: 0, value }], unit))[0]!.speedMetersPerSecond;
    assert.ok(speed !== null && Math.abs(speed - 3) < 1e-9, unit);
  }
  assert.equal(pairWithSpeed(metric, series([{ offsetSeconds: 0, value: 3 }], "unknown"))[0]!.speedMetersPerSecond, null);
});

test("indexed speed pairing preserves input-order ties, duplicates and tolerance boundaries", () => {
  const speed = series([
    { offsetSeconds: 20, value: 4 },
    { offsetSeconds: 0, value: 2 },
    { offsetSeconds: 20, value: 9 },
    { offsetSeconds: 10, value: Number.NaN }
  ]);
  const paired = pairWithSpeed(series([0, 10, 20, 35, 35.01, -15, -15.01].map(offsetSeconds => ({ offsetSeconds, value: 180 }))), speed);
  assert.deepEqual(paired.map(point => point.speedMetersPerSecond), [2, 4, 4, 4, null, 2, null]);
});

test("indexed speed pairing matches the linear reference across unsorted tracks", () => {
  let state = 123456;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const speed = series(Array.from({ length: 1000 }, () => ({ offsetSeconds: Math.floor(random() * 2000), value: random() * 5 })), "km/hr");
  const metric = series(Array.from({ length: 1000 }, () => ({ offsetSeconds: random() * 2200 - 100, value: 180 })));
  const expected = metric.points.map(point => {
    let value: number | null = null;
    let closest = Infinity;
    for (const sample of speed.points) {
      const distance = Math.abs(sample.offsetSeconds - point.offsetSeconds);
      if (distance <= SPEED_PAIRING_TOLERANCE_SECONDS && distance < closest) {
        closest = distance;
        value = sample.value * (1 / 3.6);
      }
    }
    return value;
  });
  assert.deepEqual(pairWithSpeed(metric, speed).map(point => point.speedMetersPerSecond), expected);
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

test("speed-matched drift is identical for m/s, km/hr and mph", () => {
  const points = Array.from({ length: 121 }, (_, index) => ({ offsetSeconds: index * 30, value: index <= 60 ? 3 : 3.2 }));
  const cadence = series(points.map(point => ({ ...point, value: point.offsetSeconds <= 1_800 ? 180 : 171 })), "spm");
  const analyse = (unit: string, factor: number) => buildRunningDynamics({ durationSeconds: 3_600,
    series: { cadence, speed: series(points.map(point => ({ ...point, value: point.value * factor })), unit),
      strideLength: series([]), verticalOscillation: series([]), groundContactTime: series([]) } });
  const metric = (unit: string, factor: number) => analyse(unit, factor).metrics.find(item => item.name === "cadence")!;
  assert.equal(metric("m/s", 1).status, "available");
  assert.equal(metric("km/hr", 3.6).driftFraction, metric("m/s", 1).driftFraction);
  assert.equal(metric("mph", 1 / 0.44704).driftFraction, metric("m/s", 1).driftFraction);
  assert.notEqual(metric("unknown", 1).status, "available");
});
