import assert from "node:assert/strict";
import test from "node:test";

import type { ModelLineageV2, RaceDistance } from "@rai/contracts";

import {
  DURABILITY_MODEL_VERSION,
  LEGACY_WEEKLY_DENOMINATOR_WEEKS,
  PREPARATION_TARGETS,
  PREPARATION_WINDOW_DAYS,
  RACE_EVIDENCE_CHANNELS,
  assessDurability,
  assessPreparation,
  buildDurabilitySnapshot,
  defaultRaceEvidenceLedger,
  validateRaceEvidenceLedger,
  type PreparationTrainingFact,
  type RaceEvidenceConsumer
} from "../src/index.js";

const DAY_MS = 86_400_000;
const AS_OF = "2026-03-01T00:00:00.000Z";

const at = (daysBeforeAsOf: number): string => new Date(Date.parse(AS_OF) - daysBeforeAsOf * DAY_MS).toISOString();

/** `count` runs of `distanceKm`, oldest first, the last one landing exactly on `asOf`. */
function runSeries(count: number, distanceKm: number, spreadDays: number): PreparationTrainingFact[] {
  return Array.from({ length: count }, (_unused, index) => ({
    observedAt: at(spreadDays - (index * spreadDays) / (count - 1)),
    distanceKm,
    durationSeconds: distanceKm * 360
  }));
}

/**
 * The documented §8.1 formula, written out here on purpose: the test has to encode the *spec*
 * rather than call the implementation, otherwise a changed weight would still agree with itself.
 *
 * 🔴 `8` and the target table are **hardcoded** rather than read from the module. They are a
 * compatibility contract with the pre-migration behaviour: if the test referenced
 * `LEGACY_WEEKLY_DENOMINATOR_WEEKS`, changing that constant would move the expectation with it and
 * the test would never notice — which is exactly what an earlier version of this file did.
 */
const FROZEN_WEEKLY_DENOMINATOR_WEEKS = 8;

function expectedScore(distance: RaceDistance, facts: readonly PreparationTrainingFact[]): number {
  const target = PREPARATION_TARGETS[distance];
  const totalKm = facts.reduce((sum, fact) => sum + fact.distanceKm, 0);
  const weekly = totalKm / FROZEN_WEEKLY_DENOMINATOR_WEEKS;
  const runsPerWeek = facts.length / FROZEN_WEEKLY_DENOMINATOR_WEEKS;
  const longest = Math.max(...facts.map((fact) => fact.distanceKm));
  const latestAt = facts.at(-1)!.observedAt;
  const daysSinceRun = Math.max(0, (Date.parse(AS_OF) - Date.parse(latestAt)) / DAY_MS);
  const recency = Math.exp(-Math.max(0, daysSinceRun - 3) / 14);
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const exposures = facts.filter((fact) => fact.distanceKm >= target.exposureDistanceKm).length;
  return clamp01(
    target.weights.volume * clamp01(weekly / target.weeklyDistanceKm) +
      target.weights.longRun * clamp01(longest / target.longestRunKm) +
      target.weights.frequency * clamp01(runsPerWeek / target.runsPerWeek) +
      target.weights.exposure * clamp01(exposures / target.exposureCount) +
      target.weights.recency * recency
  );
}

test("the migrated constants are the frozen legacy ones", () => {
  // These two numbers come from the pre-migration implementation. Changing either is a policy
  // change, not a refactor, and must not slip through as part of the §8.1 move.
  assert.equal(LEGACY_WEEKLY_DENOMINATOR_WEEKS, FROZEN_WEEKLY_DENOMINATOR_WEEKS);
  assert.equal(PREPARATION_WINDOW_DAYS, 56);
});

test("the preparation target table is the frozen §8.1 table", () => {
  // Copied from the plan's §8.1 table, which in turn documents the pre-migration implementation.
  // A deliberate recalibration should have to edit this literal.
  assert.deepEqual(PREPARATION_TARGETS, {
    five_k: {
      weeklyDistanceKm: 15,
      longestRunKm: 8,
      runsPerWeek: 2.5,
      exposureDistanceKm: 3,
      exposureCount: 2,
      weights: { volume: 0.25, longRun: 0.2, frequency: 0.25, exposure: 0.15, recency: 0.15 }
    },
    ten_k: {
      weeklyDistanceKm: 25,
      longestRunKm: 12,
      runsPerWeek: 3,
      exposureDistanceKm: 6,
      exposureCount: 2,
      weights: { volume: 0.3, longRun: 0.25, frequency: 0.2, exposure: 0.1, recency: 0.15 }
    },
    half_marathon: {
      weeklyDistanceKm: 35,
      longestRunKm: 18,
      runsPerWeek: 3.5,
      exposureDistanceKm: 12,
      exposureCount: 2,
      weights: { volume: 0.35, longRun: 0.35, frequency: 0.15, exposure: 0.05, recency: 0.1 }
    }
  });
});

// -----------------------------------------------------------------------------
// §8.1 Preparation：迁移必须**保持旧计算**
// -----------------------------------------------------------------------------

test("preparation reproduces the documented legacy formula exactly", () => {
  const facts = runSeries(8, 10, 56);
  const assessment = assessPreparation(facts, AS_OF);
  assert.equal(assessment.status, "available");
  assert.equal(assessment.modelVersion, DURABILITY_MODEL_VERSION);
  assert.equal(assessment.evidenceCount, 8);
  assert.equal(assessment.weeklyDistanceKm, 10);
  assert.equal(assessment.runsPerWeek, 1);
  assert.equal(assessment.longestRunKm, 10);
  for (const distance of Object.keys(PREPARATION_TARGETS) as RaceDistance[]) {
    assert.ok(
      Math.abs((assessment.values[distance] ?? NaN) - expectedScore(distance, facts)) < 1e-12,
      `${distance}: ${assessment.values[distance]} != ${expectedScore(distance, facts)}`
    );
  }
  // A gross sanity check that does not depend on the same arithmetic.
  assert.ok((assessment.values.five_k ?? 0) > 0.75 && (assessment.values.five_k ?? 0) < 0.78);
});

test("the fixed 8-week denominator is preserved even when history is shorter", () => {
  // §8.1 names this exact defect: a user with two weeks of data is read as under-trained.
  // The legacy denominator must survive the migration; the difference is reported, not acted on.
  const facts = runSeries(4, 10, 14);
  const assessment = assessPreparation(facts, AS_OF);
  assert.equal(assessment.weeklyDistanceKm, 40 / FROZEN_WEEKLY_DENOMINATOR_WEEKS);
  // The diagnostic would say 20 km/week instead of 5 — a 4x difference, which is why it must not
  // leak into `values` without its own measured change.
  assert.equal(assessment.observedCoverageWeeklyDistanceKm, 20);
  for (const distance of Object.keys(PREPARATION_TARGETS) as RaceDistance[]) {
    assert.ok(
      Math.abs((assessment.values[distance] ?? NaN) - expectedScore(distance, facts)) < 1e-12,
      `${distance} must still use the fixed denominator`
    );
  }
});

test("the coverage diagnostic is clamped to between one and eight weeks", () => {
  const tiny = assessPreparation(runSeries(2, 10, 1), AS_OF);
  // Coverage of 1 day is one week, not a seventh of one: dividing by 0.14 weeks would blow the
  // number up into a claim the data cannot support.
  assert.equal(tiny.historyCoverageDays, 1);
  assert.equal(tiny.observedCoverageWeeklyDistanceKm, 20);

  const long = assessPreparation(runSeries(8, 10, 300), AS_OF);
  assert.equal(long.observedCoverageWeeklyDistanceKm, 80 / LEGACY_WEEKLY_DENOMINATOR_WEEKS);
});

test("coverage days are fractional, matching the legacy unrounded day difference", () => {
  const facts: PreparationTrainingFact[] = [
    { observedAt: "2026-02-01T00:00:00.000Z", distanceKm: 10, durationSeconds: 3600 },
    { observedAt: "2026-03-01T12:00:00.000Z", distanceKm: 10, durationSeconds: 3600 }
  ];
  const assessment = assessPreparation(facts, "2026-03-01T12:00:00.000Z");
  assert.equal(assessment.historyCoverageDays, 28.5);
});

test("evidence level separates incomplete history from genuinely low volume", () => {
  const short = assessPreparation(runSeries(4, 10, 14), AS_OF);
  assert.equal(short.evidenceLevel, "developing");
  assert.deepEqual(short.reasonCodes, ["history_incomplete"]);

  const covered = assessPreparation(runSeries(8, 10, PREPARATION_WINDOW_DAYS), AS_OF);
  assert.equal(covered.evidenceLevel, "established");
  assert.deepEqual(covered.reasonCodes, ["history_covers_window"]);

  const none = assessPreparation([], AS_OF);
  assert.equal(none.evidenceLevel, "insufficient");
  assert.equal(none.status, "insufficient_data");
  assert.deepEqual(none.values, {});
  // Zero coverage is a fact here, not an unknown, so 0 is honest (and §8.3 types it as a number).
  assert.equal(none.historyCoverageDays, 0);
  assert.deepEqual(none.reasonCodes, ["no_usable_training"]);
});

test("preparation rejects inputs it cannot compute honestly", () => {
  assert.throws(() => assessPreparation([], "not-a-date"));
  assert.throws(() =>
    assessPreparation([{ observedAt: "nonsense", distanceKm: 10, durationSeconds: 3600 }], AS_OF)
  );
  assert.throws(() =>
    assessPreparation([{ observedAt: AS_OF, distanceKm: Number.NaN, durationSeconds: 3600 }], AS_OF)
  );
  // Targets whose weights do not sum to 1 would silently rescale every score.
  assert.throws(() =>
    assessPreparation([], AS_OF, {
      ...PREPARATION_TARGETS,
      five_k: { ...PREPARATION_TARGETS.five_k, weights: { ...PREPARATION_TARGETS.five_k.weights, volume: 0.5 } }
    })
  );
});

// -----------------------------------------------------------------------------
// §17.4 Durability：只出证据，不给分数
// -----------------------------------------------------------------------------

test("durability never produces a score without calibration", () => {
  for (const count of [0, 1, 2, 5, 40]) {
    const assessment = assessDurability({
      lateRunStability: 0.9,
      matchedPerformanceEvidence: 0.8,
      lateRunEvidenceCount: count,
      evidenceTargetCount: 2
    });
    // `null`, never 0: 0 would be the claim "durability is nil", which nothing here supports.
    assert.equal(assessment.durabilityScore, null);
    assert.ok(assessment.reasonCodes.includes("penalty_withheld_pending_calibration"));
    assert.equal(assessment.components.lateRunStability, 0.9);
  }
});

test("durability evidence levels come from the distance exposure target, not a new threshold", () => {
  const level = (count: number) =>
    assessDurability({
      lateRunStability: null,
      matchedPerformanceEvidence: null,
      lateRunEvidenceCount: count,
      evidenceTargetCount: 3
    }).evidenceLevel;
  assert.equal(level(0), "insufficient");
  assert.equal(level(2), "developing");
  assert.equal(level(3), "established");
  assert.equal(level(9), "established");
});

test("durability rejects impossible inputs", () => {
  assert.throws(() =>
    assessDurability({ lateRunStability: null, matchedPerformanceEvidence: null, lateRunEvidenceCount: -1, evidenceTargetCount: 2 })
  );
  assert.throws(() =>
    assessDurability({ lateRunStability: 1.4, matchedPerformanceEvidence: null, lateRunEvidenceCount: 1, evidenceTargetCount: 2 })
  );
  assert.throws(() =>
    assessDurability({ lateRunStability: null, matchedPerformanceEvidence: null, lateRunEvidenceCount: 1, evidenceTargetCount: 0 })
  );
});

// -----------------------------------------------------------------------------
// §8.3 快照
// -----------------------------------------------------------------------------

const lineage: ModelLineageV2 = {
  sourceRunId: "run-1",
  datasetVersion: "canonical-health-v2",
  factsSnapshotHash: "facts",
  overrideSnapshotHash: "overrides",
  modelVersion: "rai-model-config-v10",
  featureSchemaVersion: "workout-feature-v3",
  configVersion: "rai-model-config-v10",
  configHash: "config",
  calibrationCohortHash: null,
  baselineEpochId: null,
  normalizationVersion: null,
  normalizationConfigHash: null,
  timezoneIdentifier: "Asia/Shanghai",
  asOf: AS_OF,
  dataThroughAt: null
};

test("the snapshot carries both scores separately and never merges them into one number", () => {
  const preparation = assessPreparation(runSeries(8, 10, PREPARATION_WINDOW_DAYS), AS_OF);
  const durability = assessDurability({
    lateRunStability: 0.7,
    matchedPerformanceEvidence: 0.5,
    lateRunEvidenceCount: 4,
    evidenceTargetCount: 2
  });
  const snapshot = buildDurabilitySnapshot({ distance: "ten_k", preparation, durability, lineage });

  assert.equal(snapshot.modelVersion, DURABILITY_MODEL_VERSION);
  assert.equal(snapshot.distance, "ten_k");
  assert.equal(snapshot.preparationScore, preparation.values.ten_k);
  assert.equal(snapshot.durabilityScore, null);
  assert.equal(snapshot.evidenceLevel, "established");
  assert.equal(snapshot.historyCoverageDays, PREPARATION_WINDOW_DAYS);
  assert.equal(snapshot.components.volumePreparedness, preparation.components.ten_k?.volumePreparedness);
  assert.equal(snapshot.components.lateRunStability, 0.7);
  assert.equal(snapshot.lineage, lineage);
  // There is deliberately no `totalScore` field: §8.2 forbids a single vague number.
  assert.equal(Object.hasOwn(snapshot, "totalScore"), false);
});

test("the snapshot evidence level takes the weaker side", () => {
  const shortPreparation = assessPreparation(runSeries(3, 10, 10), AS_OF);
  const strongDurability = assessDurability({
    lateRunStability: 0.9,
    matchedPerformanceEvidence: 0.9,
    lateRunEvidenceCount: 9,
    evidenceTargetCount: 2
  });
  const snapshot = buildDurabilitySnapshot({
    distance: "five_k",
    preparation: shortPreparation,
    durability: strongDurability,
    lineage
  });
  // Durability cannot promote an athlete whose preparation history is too short to judge.
  assert.equal(snapshot.evidenceLevel, "developing");

  const none = buildDurabilitySnapshot({
    distance: "five_k",
    preparation: assessPreparation([], AS_OF),
    durability: strongDurability,
    lineage
  });
  assert.equal(none.evidenceLevel, "insufficient");
  assert.equal(none.preparationScore, null);
  assert.equal(none.historyCoverageDays, 0);
});

// -----------------------------------------------------------------------------
// §8.2 比赛证据额度账本
// -----------------------------------------------------------------------------

test("the shipped race-evidence ledger is valid and spends the single-race budget", () => {
  validateRaceEvidenceLedger(defaultRaceEvidenceLedger);
  const total = defaultRaceEvidenceLedger.reduce((sum, item) => sum + item.shareFraction, 0);
  assert.equal(total, 1, "the current configuration should sit exactly at the budget");
  for (const consumer of defaultRaceEvidenceLedger) {
    for (const location of consumer.locations) {
      assert.ok(location.includes(":"), `${consumer.id} location must be 文件:函数 — got ${location}`);
    }
  }
});

test("a second full-strength claim on the same race is rejected", () => {
  // §8.2: don't let one race raise VDOT *and* fully relieve the preparation penalty *and* reward
  // durability. The existing row already spends the whole budget, so this must be refused.
  const greedy: RaceEvidenceConsumer[] = [
    ...defaultRaceEvidenceLedger,
    {
      id: "race-also-relieves-preparation",
      channel: "preparation_penalty_relief",
      shareFraction: 1,
      locations: ["packages/application/src/prediction-data.ts:loadRaceReadinessEvidence"],
      note: ""
    }
  ];
  assert.throws(() => validateRaceEvidenceLedger(greedy), /over-consumed: total shareFraction is 2/);
});

test("a split budget is allowed once the shares add up", () => {
  const split: RaceEvidenceConsumer[] = [
    { ...defaultRaceEvidenceLedger[0]!, shareFraction: 0.6 },
    {
      id: "race-partially-relieves-preparation",
      channel: "preparation_penalty_relief",
      shareFraction: 0.4,
      locations: ["packages/application/src/prediction-data.ts:loadRaceReadinessEvidence"],
      note: ""
    }
  ];
  validateRaceEvidenceLedger(split);
});

test("malformed race-evidence entries are rejected", () => {
  assert.throws(() =>
    validateRaceEvidenceLedger([
      { id: "", channel: "ability_estimate", shareFraction: 1, locations: ["a:b"], note: "" }
    ])
  );
  assert.throws(() =>
    validateRaceEvidenceLedger([
      { id: "a", channel: "nonsense" as never, shareFraction: 1, locations: ["a:b"], note: "" }
    ])
  );
  assert.throws(() =>
    validateRaceEvidenceLedger([
      { id: "a", channel: "ability_estimate", shareFraction: 1, locations: [], note: "" }
    ])
  );
  assert.throws(() =>
    validateRaceEvidenceLedger([
      { id: "a", channel: "ability_estimate", shareFraction: 1.5, locations: ["a:b"], note: "" }
    ])
  );
  assert.throws(() =>
    validateRaceEvidenceLedger([
      { id: "a", channel: "ability_estimate", shareFraction: 0.5, locations: ["a:b"], note: "" },
      { id: "a", channel: "durability_reward", shareFraction: 0.5, locations: ["a:b"], note: "" }
    ])
  );
  assert.equal(RACE_EVIDENCE_CHANNELS.length, 3);
});

test("D03: a slower late run never becomes an endurance-decline conclusion", () => {
  // §16.1 D03：地形不同导致后段变慢时，只能**降低可比性**，不能给"耐力下降"的结论。
  // 本包没有地形/可比性输入，所以它**做不到**把后段变慢解释成耐力 —— 这条测试钉的正是
  // 这个"做不到"：同一暴露量下，好与差的后段表现给出**同一种结论形状**。
  const assess = (lateRunStability: number | null) => assessDurability({
    lateRunStability,
    matchedPerformanceEvidence: null,
    lateRunEvidenceCount: 2,
    evidenceTargetCount: 2
  });
  const fast = assess(0.95);
  const slow = assess(0.2);

  // 1) 两者都没有分数：没有校准就不给数值，"慢"不等于"耐力下降"。
  assert.equal(fast.durabilityScore, null);
  assert.equal(slow.durabilityScore, null);
  // 2) 证据等级只由暴露量决定，后段快慢不得改变它 —— 否则一次爬坡长跑就会降级。
  assert.equal(slow.evidenceLevel, fast.evidenceLevel);
  // 3) 理由码里不能出现任何"下降/退化"的断言。
  assert.deepEqual(slow.reasonCodes, fast.reasonCodes);
  assert.ok(slow.reasonCodes.includes("penalty_withheld_pending_calibration"));
  assert.equal(slow.reasonCodes.some((code) => /decline|decreas|degrad|endurance_loss/.test(code)), false);
  // 4) 原始观测仍然如实保留，供人看；只是没有任何东西把它换算成结论。
  assert.equal(slow.components.lateRunStability, 0.2);
  // 5) 越界值抛错而不是被夹到合法区间 —— 夹一下就会变成一个"看起来正常"的观测。
  assert.throws(() => assess(-0.1));
});
