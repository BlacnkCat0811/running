import assert from "node:assert/strict";
import test from "node:test";
import type { CoachPredictionSummary } from "@rai/api-contracts";
import { coachGoalGap, type CoachPredictionIdentity } from "../src/coach-goal-gap.js";
import { digest } from "../src/plan-digest.js";
import { shiftCoachDate } from "../src/coach-loop-facts.js";

const identity: CoachPredictionIdentity = {
  athleteId: "synthetic", bundleId: "bundle", bundleHash: "bundle-hash", datasetEpoch: "dataset",
  factsHash: "facts", overrideHash: "overrides", labelCohortHash: null,
  activePredictionArtifactId: "model", predictionPolicyVersion: "synthetic-model-v1", scenario: "current_prepared"
};
const summary = (): CoachPredictionSummary => ({
  schemaVersion: 1, ...identity, id: "synthetic-summary", asOf: "2026-10-10T01:00:00Z",
  publishedAt: "2026-10-10T02:00:00Z", availableAt: "2026-10-10T02:00:00Z",
  dataThroughAt: "2026-10-09T01:00:00Z", entries: [{
    distance: "ten_k", status: "available", referenceSeconds: 3000,
    method: "synthetic-reference", calibrationStatus: "uncalibrated", range: null,
    evidenceRefs: [], limitationCodes: ["heuristic_reference_not_calibrated"]
  }]
});
const gap = (overrides: Partial<Parameters<typeof coachGoalGap>[0]> = {}) => coachGoalGap({
  asOf: "2026-10-10T04:00:00Z", distance: "ten_k", targetSeconds: 2700,
  summary: summary(), currentIdentity: identity, ...overrides
});

test("AC6-01/02 candidate: +300/0/-300 seconds, never a success probability or calibrated guarantee", () => {
  for (const [targetSeconds, expected] of [[2700, 300], [3000, 0], [3300, -300]] as const) {
    const output = gap({ targetSeconds });
    assert.equal(output.status, "available");
    assert.equal(output.gapSeconds, expected);
    assert.equal(output.referenceSeconds, 3000);
    assert.equal(output.calibrationStatus, "uncalibrated");
    assert.ok(output.reasons.some(reason => reason.code === "goal_gap_not_a_probability"));
    assert.ok(!("probability" in output) && !("successRate" in output) && !("confidence" in output));
  }
});

test("AC6-03/04 candidate: time goal changes no source facts; no goal/summary/unsupported distance stay distinct", () => {
  const reference = summary(), before = digest(reference);
  gap({ summary: reference, targetSeconds: 2400 });
  gap({ summary: reference, targetSeconds: 3300 });
  assert.equal(digest(reference), before);
  assert.equal(gap({ targetSeconds: null }).status, "no_time_goal");
  assert.equal(gap({ summary: null }).status, "summary_unavailable");
  assert.equal(gap({ distance: "unsupported" }).status, "unsupported_distance");
  assert.equal(gap({ summary: { ...reference, dataThroughAt: null } }).status, "summary_unavailable");
});

test("AC6-04 candidate: 6/7/8 Shanghai days use dataThrough, not a fresh calculation timestamp", () => {
  for (const age of [6, 7, 8]) {
    const date = shiftCoachDate("2026-10-10", -age);
    const output = gap({ summary: { ...summary(), dataThroughAt: `${date}T01:00:00Z` } });
    assert.equal(output.status, age > 7 ? "stale" : "available");
    assert.equal(output.freshness.stale, age > 7);
    assert.equal(output.gapSeconds, age > 7 ? null : 300);
  }
  const nearMidnight = gap({ asOf: "2026-10-09T16:00:00Z",
    summary: { ...summary(), asOf: "2026-10-09T14:00:00Z", publishedAt: "2026-10-09T15:00:00Z",
      availableAt: "2026-10-09T15:00:00Z", dataThroughAt: "2026-10-02T16:00:00Z" } });
  assert.equal(nearMidnight.status, "available", "the data belongs to October 3 Shanghai, exactly seven local days old");
});

test("AC6-05/07/08 candidate: every compatibility identity, future availability and scenario is checked", () => {
  for (const overrides of [
    { factsHash: "new-facts" }, { overrideHash: "new-overrides" }, { datasetEpoch: "restored-dataset" },
    { labelCohortHash: "withdrawn-labels" }, { activePredictionArtifactId: "rolled-back-model" },
    { bundleHash: "new-bundle" }, { predictionPolicyVersion: "another-policy" }, { athleteId: "someone-else" }
  ]) assert.equal(gap({ currentIdentity: { ...identity, ...overrides } }).status, "incompatible", JSON.stringify(overrides));
  assert.equal(gap({ summary: { ...summary(), scenario: "neutral_potential" as CoachPredictionSummary["scenario"] } }).status, "incompatible");
  assert.equal(gap({ summary: { ...summary(), availableAt: "2026-10-11T01:00:00Z" } }).status, "incompatible");
  assert.equal(gap({ summary: { ...summary(), dataThroughAt: "2026-10-10T03:00:00Z" } }).status, "incompatible");
  assert.equal(gap({ summary: { ...summary(), bundleHash: "" }, currentIdentity: { ...identity, bundleHash: "" } }).status, "incompatible");
  const duplicate = summary();
  duplicate.entries.push({ ...duplicate.entries[0]! });
  assert.equal(gap({ summary: duplicate }).status, "incompatible");
  const mislabeledRange = summary();
  mislabeledRange.entries[0]!.range = { lowerSeconds: 2700, upperSeconds: 3300, kind: "empirical" };
  assert.equal(gap({ summary: mislabeledRange }).status, "incompatible", "an uncalibrated formula cannot acquire an empirical range label");
});

test("AC6-06 candidate helper: repeated reads are pure and deterministic; it does not own a report builder", () => {
  const input = summary(), before = digest(input), expected = gap({ summary: input });
  for (let index = 0; index < 100; index++) assert.deepEqual(gap({ summary: input }), expected);
  assert.equal(digest(input), before);
  assert.equal(expected.policyStatus, "candidate");
  assert.ok(!("weeklyCapacityKm" in expected) && !("qualitySessionCap" in expected));
});
