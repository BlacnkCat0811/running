import assert from "node:assert/strict";
import test from "node:test";
import { estimateVo2Max, estimateLactateThresholdFromEvidence, type LactateThresholdEvidence } from "../src/index.js";

const asOf = "2026-09-29T00:00:00Z";
const noVo2 = estimateVo2Max([], asOf);
const profile = { restingHeartRateBpm: null, observedMaximumHeartRateBpm: null };
const evidence: LactateThresholdEvidence = {
  id: "threshold", observedAt: "2026-09-28T00:00:00Z",
  paceSecondsPerKm: 300, heartRateBpm: 170, durationSeconds: 1800,
  source: "threshold_test", quality: 0.95
};

test("Z02: observed threshold test does not require a VO2 estimate", () => {
  const result = estimateLactateThresholdFromEvidence(noVo2, profile, [evidence], asOf);
  assert.equal(result.status, "available");
  assert.equal(result.method, "observed_threshold_v3");
  assert.equal(result.paceSecondsPerKm, 300);
  assert.equal(result.heartRateBpm, 170);
  assert.equal(result.evidenceCount, 1);
  assert.ok(!result.evidenceCodes.includes("lactate_threshold_one_hour_proxy"));
});

test("Z02: ordinary, weak, short or future segments cannot rescue an absent prior", () => {
  for (const row of [
    { ...evidence, source: "sustained_segment" as const },
    { ...evidence, quality: 0.3 },
    { ...evidence, durationSeconds: 900 },
    { ...evidence, observedAt: "2027-01-01T00:00:00Z" }
  ]) assert.equal(estimateLactateThresholdFromEvidence(noVo2, profile, [row], asOf).status, "insufficient_data");
});

test("missing HR remains missing rather than being fabricated from pace", () => {
  const result = estimateLactateThresholdFromEvidence(noVo2, profile, [{ ...evidence, heartRateBpm: null }], asOf);
  assert.equal(result.status, "available");
  assert.equal(result.heartRateBpm, null);
  assert.equal(result.heartRateRangeBpm, null);
});
