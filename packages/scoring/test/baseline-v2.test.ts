import assert from "node:assert/strict";
import test from "node:test";
import type { WorkoutFeatureVector } from "@rai/contracts";
import { adaptiveBaselineAt, buildAdaptiveBaselineTimeline, reviewBaselineRebase } from "../src/index.js";

const feature = (overrides: Partial<WorkoutFeatureVector> = {}): WorkoutFeatureVector => ({
  id: "feature",
  featureRunId: "run",
  trainingSessionId: "session",
  canonicalWorkoutId: "workout",
  workoutStartAt: "2026-02-01T00:00:00.000Z",
  durationSeconds: 3600,
  distanceKm: 10,
  averageSpeedMetersPerSecond: 2.8,
  averageHeartRateBpm: 150,
  heartRateSampleCount: 120,
  heartRateCoverage: 1,
  routePointCount: 100,
  routeQuality: 1,
  sourceConfidence: 1,
  sessionType: "steady",
  sessionTypeSource: "auto",
  eligibilityStatus: "eligible",
  qualityScore: 1,
  missingReasons: [],
  signals: {
    efficiencyRaw: 0.022,
    paceRawMetersPerSecond: 3.1,
    cardioRaw: null,
    stabilityRaw: 0.9,
    recoveryRaw: 0.75,
    heartRateReserveFraction: 0.7,
    heartRateCoefficientOfVariation: 0.04,
    speedCoefficientOfVariation: 0.04,
    sleepDurationMinutes: 480,
    restingHeartRateBpm: 50,
    hrvSdnnMs: 60,
    recentLoadMinutes: 180
  },
  provenance: {},
  computedAt: "2026-02-01T01:00:00.000Z",
  ...overrides
});

test("adaptive baseline excludes future, same-session, other-stratum and excluded observations", () => {
  const current = feature({ id: "current", trainingSessionId: "current", workoutStartAt: "2026-09-29T00:00:00Z" });
  const history = Array.from({ length: 6 }, (_, i) => feature({
    id: `f${i}`, trainingSessionId: `s${i}`, workoutStartAt: `2026-09-${String(3 + i * 3).padStart(2, "0")}T00:00:00Z`
  }));
  const reference = adaptiveBaselineAt(history, current);
  assert.equal(reference.status, "available");
  assert.equal(reference.history.spanDays, 15);
  const noisy = [
    ...history, { ...history[0]!, id: "same-session-window" },
    feature({ id: "future", workoutStartAt: "2026-10-01T00:00:00Z" }),
    feature({ id: "tempo", sessionType: "tempo", workoutStartAt: "2026-09-05T00:00:00Z" }),
    feature({ id: "excluded", eligibilityStatus: "excluded", workoutStartAt: "2026-09-05T00:00:00Z" }),
    current
  ];
  assert.deepEqual(adaptiveBaselineAt(noisy, current), reference);
  assert.deepEqual(buildAdaptiveBaselineTimeline([...history, current]).at(-1), reference);
});

test("a years-old workout never fills a sparse contemporary bucket", () => {
  const current = feature({ id: "current", trainingSessionId: "current", workoutStartAt: "2026-09-29T00:00:00Z" });
  const old = Array.from({ length: 20 }, (_, i) => feature({ id: `f${i}`, trainingSessionId: `s${i}` }));
  const result = adaptiveBaselineAt(old, current);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.baseline, null);
  assert.equal(result.history.independentSessions, 0);
  assert.equal(result.extended, true);
  assert.equal(result.windowDays, 42);
});

test("rebase is a reviewed candidate, never an automatic epoch/TA change", () => {
  const value = { asOf: "2026-09-29T00:00:00Z", epochStartedAt: "2026-01-01T00:00:00Z",
    lastReviewedAt: "2026-08-20T00:00:00Z", independentSessions: 12,
    saturatedFraction: 0.3, precedingSaturatedReviews: 1 };
  assert.equal(reviewBaselineRebase(value).status, "candidate_requested");
  assert.equal(reviewBaselineRebase(value).autoRebase, false);
  assert.equal(reviewBaselineRebase({ ...value, independentSessions: 1 }).status, "insufficient_evidence");
  assert.equal(reviewBaselineRebase({ ...value, lastReviewedAt: "2026-09-28T00:00:00Z" }).status, "not_due");
  assert.equal(reviewBaselineRebase({ ...value, epochStartedAt: "2026-09-01T00:00:00Z" }).status, "epoch_cooldown");
  assert.equal(reviewBaselineRebase({ ...value, saturatedFraction: 0 }).saturatedReviews, 0);
});
