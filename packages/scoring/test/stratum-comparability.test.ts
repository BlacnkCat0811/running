import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_STRATA,
  sessionTypes,
  type StratumHistory,
  type WorkoutFeatureVector
} from "@rai/contracts";

import {
  COMPARABILITY_BY_STRATUM,
  COMPARABILITY_NOT_COMPARABLE,
  comparabilityValue,
  defaultRaiModelConfig,
  evaluateStratumComparability,
  sessionStratum,
  updateTrueAbilityFromFeatureScore
} from "../src/index.js";
import { scoreFeature, type PersonalBaseline, type RaiModelConfig } from "../src/model.js";

// -----------------------------------------------------------------------------
// §6.2 session comparability. A workout is only compared against its own kind, and
// only once that kind has enough independent history behind it.
// -----------------------------------------------------------------------------

const MATURE: StratumHistory = { independentSessions: 24, spanDays: 90 };
const SPARSE: StratumHistory = { independentSessions: 3, spanDays: 9 };

const baseline: PersonalBaseline = {
  calibrationFeatureIds: ["calibration"],
  calibrationStartAt: "2026-01-01T00:00:00.000Z",
  calibrationEndAt: "2026-01-15T00:00:00.000Z",
  dimensions: {
    efficiency: { center: 0.02, scale: 0.002 },
    pace: { center: 2.8, scale: 0.3 },
    stability: { center: 0.8, scale: 0.1 }
  }
};

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

test("every session type maps to a stratum, and never outside the allowed set", () => {
  const allowed = new Set<string>(SESSION_STRATA);
  for (const sessionType of sessionTypes) {
    const stratum = sessionStratum(sessionType);
    assert.ok(allowed.has(stratum), `${sessionType} mapped to an unknown stratum: ${stratum}`);
  }
  // The mapping is a partition, not a partial function: no session type may fall
  // through to a default that silently joins another kind's reference distribution.
  assert.deepEqual(
    [...new Set(sessionTypes.map((sessionType) => sessionStratum(sessionType)))].sort(),
    [...SESSION_STRATA].sort()
  );
});

test("a sparse bucket is not comparable, and refuses learning in both directions", () => {
  const score = scoreFeature(feature(), baseline, 1, SPARSE);
  assert.equal(score.stratumComparability.status, "not_comparable");
  assert.ok(score.stratumComparability.reasonCodes.includes("insufficient_independent_sessions"));
  assert.equal(score.confidenceV2.comparability, COMPARABILITY_NOT_COMPARABLE);

  // Both directions refused, so this is a quality gate rather than a one-way ratchet.
  assert.equal(updateTrueAbilityFromFeatureScore(70, 30, score).updated, false);
  assert.equal(updateTrueAbilityFromFeatureScore(30, 30, score).updated, false);
});

test("an unassessed history is reported as not assessed, not as insufficient", () => {
  // The two forbid learning for different reasons and the diagnosis must survive:
  // one says nobody measured, the other says we measured and it is thin.
  const result = evaluateStratumComparability({
    stratum: "steady_aerobic",
    history: null,
    policy: defaultRaiModelConfig.comparabilityPolicy
  });
  assert.equal(result.status, "not_assessed");
  assert.deepEqual(result.reasonCodes, ["history_not_assessed"]);
  assert.equal(result.independentSessions, null);

  const score = scoreFeature(feature(), baseline, 1, null);
  assert.equal(score.stratumComparability.status, "not_assessed");
  assert.equal(updateTrueAbilityFromFeatureScore(70, 30, score).updated, false);
});

test("a mature bucket becomes comparable at its stratum's value", () => {
  const score = scoreFeature(feature(), baseline, 1, MATURE);
  assert.equal(score.stratumComparability.status, "comparable");
  assert.deepEqual(score.stratumComparability.reasonCodes, []);
  assert.equal(score.confidenceV2.comparability, COMPARABILITY_BY_STRATUM.steady_aerobic);
  // A *positive* observation, so the result is not entangled with the §6.9
  // consecutive-negative count: a mature bucket is the only thing that changed.
  assert.equal(
    updateTrueAbilityFromFeatureScore(40, 30, score).updated,
    true,
    "a mature bucket must not block learning"
  );
});

test("a structured interval is comparable now that it is judged inside its own stratum", () => {
  // The previous blanket rule scored every interval 0.75, which held every interval
  // incomparable to every other interval — including a comparable one.
  const score = scoreFeature(feature({ sessionType: "interval" }), baseline, 1, MATURE);
  assert.equal(score.stratumComparability.status, "comparable");
  assert.equal(score.confidenceV2.comparability, COMPARABILITY_BY_STRATUM.interval);
  assert.ok(COMPARABILITY_BY_STRATUM.interval >= defaultRaiModelConfig.minimumComparabilityForLearning);
  // Positive observation again, to isolate comparability from the confirmation count.
  assert.equal(updateTrueAbilityFromFeatureScore(40, 30, score).updated, true);
});

test("recovery and unknown sessions stay displayable but never become ability evidence", () => {
  for (const sessionType of ["recovery", "unknown"] as const) {
    const score = scoreFeature(feature({ sessionType }), baseline, 1, MATURE);
    assert.equal(score.stratum, "recovery_unknown");
    assert.equal(score.stratumComparability.status, "comparable");
    // Assert the value exists before comparing it — an equality/comparison on a
    // possibly-null field silently degrades into a vacuous check.
    assert.notEqual(score.confidenceV2.comparability, null);
    assert.ok(
      (score.confidenceV2.comparability ?? 1) < defaultRaiModelConfig.minimumComparabilityForLearning,
      `${sessionType} must sit below the learning gate`
    );
    assert.equal(updateTrueAbilityFromFeatureScore(70, 30, score).updated, false);
    // Still shown: a display estimate exists even where no learning happens.
    assert.notEqual(score.currentAbility, null);
  }
});

test("the policy refuses to be widened, and the refusal is enforced by validation", () => {
  const base = defaultRaiModelConfig.comparabilityPolicy;
  const rejects = (policy: RaiModelConfig["comparabilityPolicy"], label: string): void => {
    assert.throws(
      () => scoreFeature(feature(), baseline, 1, MATURE, { ...defaultRaiModelConfig, comparabilityPolicy: policy }),
      label
    );
  };
  // The documented ceiling is only a ceiling if the parser enforces it.
  rejects({ ...base, allowedStrata: [...SESSION_STRATA], maximumStrata: 3 }, "strata above maximumStrata");
  rejects({ ...base, allowedStrata: ["steady_aerobic", "steady_aerobic"] }, "duplicate stratum");
  rejects({ ...base, allowedStrata: ["not_a_stratum" as never] }, "unknown stratum");
  rejects({ ...base, allowCrossStratumFallback: true as never }, "cross-stratum fallback enabled");
  rejects({ ...base, insufficientPolicy: "widen" as never }, "insufficientPolicy widened");
  rejects({ ...base, minimumIndependentSessions: 0 }, "non-positive minimum sessions");
  rejects({ ...base, maximumStrata: 0 }, "non-positive maximumStrata");
});

test("comparability only ever narrows", () => {
  // A value can fall to the not-comparable floor, and can take its stratum's own
  // value, but there is no path that raises it to reach a sample count.
  const notComparable = evaluateStratumComparability({
    stratum: "steady_aerobic",
    history: SPARSE,
    policy: defaultRaiModelConfig.comparabilityPolicy
  });
  assert.equal(comparabilityValue(notComparable), COMPARABILITY_NOT_COMPARABLE);
  for (const stratum of SESSION_STRATA) {
    const comparable = evaluateStratumComparability({
      stratum,
      history: MATURE,
      policy: defaultRaiModelConfig.comparabilityPolicy
    });
    assert.equal(comparabilityValue(comparable), COMPARABILITY_BY_STRATUM[stratum]);
    assert.equal(comparabilityValue(comparable), comparabilityValue(comparable));
  }
});
