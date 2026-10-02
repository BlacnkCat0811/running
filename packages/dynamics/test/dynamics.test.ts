import assert from "node:assert/strict";
import test from "node:test";

import {
  DYNAMICS_POLICY_VERSION,
  MINIMUM_METRIC_COVERAGE,
  analyseRunningDynamics,
  seriesCoverage,
  type DynamicsSample
} from "../src/index.js";

/**
 * Y01–Y03: the three ways a stride panel lies.
 *
 *   Y01  coverage reported as if it were a result;
 *   Y02  pace change read as form change;
 *   Y03  an absent metric rendered as zero.
 */

const DURATION = 3_600;

/** A full-run series at `valueFor(offset)`, sampled every 30 s. */
function series(valueFor: (offset: number) => number, speedFor: (offset: number) => number | null, durationSeconds = DURATION): DynamicsSample[] {
  const samples: DynamicsSample[] = [];
  for (let offset = 0; offset <= durationSeconds; offset += 30) {
    samples.push({ offsetSeconds: offset, value: valueFor(offset), speedMetersPerSecond: speedFor(offset) });
  }
  return samples;
}

const constantSpeed = (): number => 3;

test("Y01: coverage is measured in time, not sample count", () => {
  // Densely sampled, but only the first two minutes of an hour.
  const dense: DynamicsSample[] = Array.from({ length: 120 }, (_, index) => ({
    offsetSeconds: index,
    value: 170,
    speedMetersPerSecond: 3
  }));
  const coverage = seriesCoverage(DURATION, "步频", dense);
  assert.ok(coverage < 0.05, `two minutes of an hour must not read as covered (got ${coverage})`);
  assert.equal(seriesCoverage(DURATION, "步频", []), 0);
  assert.equal(seriesCoverage(DURATION, "步频", [{ offsetSeconds: 10, value: 170, speedMetersPerSecond: 3 }]), 0,
    "a single sample covers an instant, not a span");
});

test("Y01: below the coverage floor the metric is insufficient, with the share reported", () => {
  const analysis = analyseRunningDynamics({
    durationSeconds: DURATION,
    metrics: {
      ground_contact_time: Array.from({ length: 10 }, (_, index) => ({
        offsetSeconds: index * 5,
        value: 240,
        speedMetersPerSecond: 3
      }))
    }
  });
  const metric = analysis.metrics.find((item) => item.name === "ground_contact_time");
  assert.ok(metric);
  assert.equal(metric.status, "insufficient_coverage");
  assert.deepEqual(metric.reasonCodes, ["coverage_below_minimum"]);
  assert.equal(metric.driftFraction, null);
  assert.ok(metric.coverage < MINIMUM_METRIC_COVERAGE);
  assert.ok(metric.samples === 10, "the sample count is still reported: it is the finding that is withheld");
});

test("Y02: a pace change is not reported as a form change", () => {
  // Cadence falls in the second half, but only because the runner slowed down:
  // the form-per-pace relationship is unchanged.
  const analysis = analyseRunningDynamics({
    durationSeconds: DURATION,
    metrics: {
      cadence: series(
        (offset) => (offset <= 1_800 ? 180 : 160),
        (offset) => (offset <= 1_800 ? 3.2 : 2.6)
      )
    }
  });
  const cadence = analysis.metrics.find((item) => item.name === "cadence");
  assert.ok(cadence);
  assert.equal(cadence.status, "partial", "without comparable speed the drift is not reported");
  assert.deepEqual(cadence.reasonCodes, ["no_speed_matched_pairs"]);
  assert.equal(cadence.driftFraction, null);
  assert.equal(analysis.flags.length, 0, "a slowdown must not raise a form flag");
});

test("Y02: at matched speed, a real drift in cadence is reported and flagged", () => {
  const analysis = analyseRunningDynamics({
    durationSeconds: DURATION,
    metrics: {
      cadence: series((offset) => (offset <= 1_800 ? 180 : 171), constantSpeed)
    }
  });
  const cadence = analysis.metrics.find((item) => item.name === "cadence");
  assert.ok(cadence);
  assert.equal(cadence.status, "available");
  assert.equal(cadence.firstHalfAverage, 180);
  assert.equal(cadence.secondHalfAverage, 171);
  assert.equal(cadence.driftFraction, -0.05);
  assert.equal(cadence.comparableSamples > 0, true);
  const flag = analysis.flags.find((item) => item.code === "cadence_drift");
  assert.ok(flag, "a 5 % cadence drop at the same speed is worth showing");
  assert.match(flag.detail, /后半程同配速下下降 5\.0%/);
  assert.equal(analysis.evidenceStatus, "device_estimated_not_lab_validated");
  assert.equal(analysis.policyVersion, DYNAMICS_POLICY_VERSION);
});

test("Y02: a rising ground contact time is flagged, and the direction is per metric", () => {
  const analysis = analyseRunningDynamics({
    durationSeconds: DURATION,
    metrics: {
      ground_contact_time: series((offset) => (offset <= 1_800 ? 220 : 235), constantSpeed),
      stride_length: series((offset) => (offset <= 1_800 ? 1.1 : 1.05), constantSpeed)
    }
  });
  const code = analysis.flags.map((item) => item.code);
  assert.ok(code.includes("ground_contact_time_drift"), "a longer contact time at the same speed is the fatigued direction");
  assert.ok(!code.includes("cadence_drift"), "cadence was not supplied, so it cannot be flagged");
});

test("Y03: an absent metric is unavailable, never a zero", () => {
  const analysis = analyseRunningDynamics({ durationSeconds: DURATION, metrics: {} });
  for (const metric of analysis.metrics) {
    assert.equal(metric.status, "unavailable");
    assert.equal(metric.average, null);
    assert.equal(metric.driftFraction, null);
    assert.deepEqual(metric.reasonCodes, ["no_samples"]);
  }
  assert.match(analysis.note ?? "", /没有任何跑姿动态样本/);
  assert.equal(analysis.flags.length, 0);
});

test("Y03: non-finite samples are dropped rather than averaged in", () => {
  const samples: DynamicsSample[] = [
    { offsetSeconds: 0, value: Number.NaN, speedMetersPerSecond: 3 },
    { offsetSeconds: 60, value: 180, speedMetersPerSecond: 3 },
    ...series(() => 180, constantSpeed).slice(2)
  ];
  const analysis = analyseRunningDynamics({ durationSeconds: DURATION, metrics: { cadence: samples } });
  const cadence = analysis.metrics.find((item) => item.name === "cadence");
  assert.ok(cadence);
  assert.equal(cadence.average, 180);
  assert.ok(cadence.status === "available" || cadence.status === "partial");
});

test("Y01: a run with no duration cannot report coverage at all", () => {
  const analysis = analyseRunningDynamics({
    durationSeconds: 0,
    metrics: { cadence: series(() => 180, constantSpeed) }
  });
  const cadence = analysis.metrics.find((item) => item.name === "cadence");
  assert.equal(cadence?.status, "insufficient_coverage");
  assert.equal(cadence?.coverage, 0);
});

test("Y03: the note names which kind of partial the run is", () => {
  // Cadence only: the other three metrics were never recorded.
  const missingMetrics = analyseRunningDynamics({
    durationSeconds: DURATION,
    metrics: { cadence: series(() => 180, constantSpeed) }
  });
  assert.match(missingMetrics.note ?? "", /部分指标这次没有采样/);
  assert.equal(missingMetrics.metrics.find((item) => item.name === "cadence")?.status, "available");

  // Recorded, but too little of the run to compare: a different gap, different wording.
  const tooLittle = analyseRunningDynamics({
    durationSeconds: DURATION,
    metrics: {
      cadence: series(() => 180, constantSpeed),
      ground_contact_time: Array.from({ length: 8 }, (_, index) => ({
        offsetSeconds: index * 10,
        value: 240,
        speedMetersPerSecond: 3
      }))
    }
  });
  assert.match(tooLittle.note ?? "", /部分指标覆盖不足/);
})
