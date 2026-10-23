import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBusinessEquivalent,
  compareBusinessProjections,
  type BusinessProjection
} from "./business-artifact-projection.js";

/**
 * P3-06 §7.3：**比较器自身的负对照**。
 *
 * 差分工具是"增量与全量等价"这一结论的唯一证据来源；如果它只验证自己的快乐路径，
 * 那么把分数改掉、删一行、改解释码、破坏引用或新增未知字段都可能静默通过。
 * 这些用例用**小份突变副本**（不碰数据库）证明每一种差异都会让比较失败。
 */

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fixture(): BusinessProjection {
  return {
    tables: [
      {
        name: "workout_features",
        keyFields: ["trainingSessionId"],
        rows: [{
          trainingSessionId: "fixture_session_1",
          qualityScore: 0.875,
          eligibilityStatus: "eligible",
          missingReasons: ["route_missing"],
          features: { schemaVersion: "workout-feature-v4", raw: { efficiencyRaw: 0.0215 }, execution: { pairedCoverage: 0.5 } }
        }]
      },
      {
        name: "ability_assessments",
        keyFields: ["trainingSessionId", "sequenceNumber"],
        rows: [{
          trainingSessionId: "fixture_session_1",
          sequenceNumber: 0,
          assessmentStatus: "eligible",
          trueAbilityAfter: 55.5,
          trueAbilityDelta: 1.25,
          updatedTrueAbility: true,
          explanationCodes: ["steady_improvement", "confidence_limited"],
          explanation: {
            baselineEpochId: "fixture_epoch_raw_1",
            calibrationCohortHash: "fixture_cohort_raw_1"
          }
        }]
      },
      {
        name: "daily_ability_snapshots",
        keyFields: ["localDate"],
        rows: [{
          localDate: "2026-02-12",
          trueAbility: 55.5,
          decayPoints: 0,
          growthVelocityPerWeek: 0.5,
          snapshotStatus: "active",
          baselineEpochId: "fixture_epoch_raw_1",
          lastAssessmentRef: JSON.stringify(["fixture_session_1", 0])
        }],
        references: [{ field: "lastAssessmentRef", table: "ability_assessments" }]
      },
      {
        name: "training_sessions",
        keyFields: ["trainingSessionId"],
        rows: [{
          trainingSessionId: "fixture_session_1",
          activityType: "HKWorkoutActivityTypeRunning",
          anchorStartAt: "2026-02-11T00:00:00.000Z",
          anchorEndAt: "2026-02-11T00:30:00.000Z",
          anchorDistanceKm: 5,
          canonicalWorkoutId: "fixture_workout_1",
          status: "active"
        }]
      },
      {
        name: "model_v2_runs",
        keyFields: ["singleton"],
        rows: [{
          singleton: "lineage",
          engineVersion: "fixture",
          configVersion: "fixture",
          lineage: {
            baselineEpochId: "fixture_epoch_raw_1",
            calibrationCohortHash: "fixture_cohort_raw_1",
            datasetVersion: "fixture_dataset"
          }
        }]
      },
      {
        name: "model_release_bundles",
        keyFields: ["runOrdinal"],
        rows: [{
          runOrdinal: 2,
          baseRunOrdinal: 1,
          datasetVersion: "fixture_dataset",
          status: "passed",
          evaluation: { status: "passed", metrics: { invalidValueCount: 0 } },
          snapshotDomains: ["fitness/summary@2026-02-12", "readiness/summary@2026-02-12"],
          snapshotProjectionHash: "fixture_snapshot_projection_hash",
          createdAt: "2026-02-12T04:00:00.000Z",
          activated: true
        }]
      },
      {
        name: "release_readable_state",
        keyFields: ["singleton"],
        rows: [{
          singleton: "active",
          activeRunOrdinal: 2,
          activeReleaseOrdinal: 2,
          activePublished: true,
          bundleStatus: "passed",
          readableDomains: ["fitness/summary@2026-02-12", "readiness/summary@2026-02-12"],
          analysisStatus: "published",
          freshness: {
            stale: false,
            reason: "up_to_date",
            versions: { facts: "2", analysis: "2", releaseOrdinal: 2 }
          }
        }]
      }
    ]
  };
}

function assertRejected(actual: BusinessProjection, pattern: RegExp): void {
  const diffs = compareBusinessProjections(actual, fixture());
  assert.ok(diffs.length > 0, "the mutation must produce at least one business difference");
  assert.throws(
    () => assertBusinessEquivalent(actual, fixture(), "negative control"),
    pattern
  );
}

test("P3-06 §7.3 control: identical projections pass (the comparator is not always-throwing)", () => {
  assert.deepEqual(compareBusinessProjections(fixture(), fixture()), []);
  assert.doesNotThrow(() => assertBusinessEquivalent(fixture(), fixture()));
});

test("P3-06 §7.3 control: a changed score fails", () => {
  const mutated = clone(fixture());
  const assessment = mutated.tables.find((table) => table.name === "ability_assessments")!;
  (assessment.rows[0] as Record<string, unknown>).trueAbilityAfter = 56.5;
  assertRejected(mutated, /trueAbilityAfter/);
});

test("P3-06 §7.3 control: a deleted row fails", () => {
  const mutated = clone(fixture());
  const features = mutated.tables.find((table) => table.name === "workout_features")!;
  (features.rows as Array<Record<string, unknown>>).length = 0;
  assertRejected(mutated, /missing row/);
});

test("P3-06 §7.3 control: a changed explanation code fails", () => {
  const mutated = clone(fixture());
  const assessment = mutated.tables.find((table) => table.name === "ability_assessments")!;
  (assessment.rows[0] as Record<string, unknown>).explanationCodes = ["steady_improvement", "data_insufficient"];
  assertRejected(mutated, /explanationCodes\[1\]/);
});

test("P3-06 §7.3 control: a tampered raw lineage baselineEpochId fails", () => {
  const mutated = clone(fixture());
  const lineage = mutated.tables.find((table) => table.name === "model_v2_runs")!;
  const row = lineage.rows[0] as { lineage: Record<string, unknown> };
  row.lineage.baselineEpochId = "tampered_epoch_raw_2";
  assertRejected(mutated, /lineage\.baselineEpochId/);
});

test("P3-06 §7.3 control: a tampered raw daily-snapshot baselineEpochId fails", () => {
  const mutated = clone(fixture());
  const daily = mutated.tables.find((table) => table.name === "daily_ability_snapshots")!;
  (daily.rows[0] as Record<string, unknown>).baselineEpochId = "tampered_epoch_raw_2";
  assertRejected(mutated, /baselineEpochId/);
});

test("P3-06 §7.3 control: a tampered raw explanation baselineEpochId fails", () => {
  const mutated = clone(fixture());
  const assessment = mutated.tables.find((table) => table.name === "ability_assessments")!;
  const row = assessment.rows[0] as { explanation: Record<string, unknown> };
  row.explanation.baselineEpochId = "tampered_epoch_raw_2";
  assertRejected(mutated, /explanation\.baselineEpochId/);
});

test("P3-06 §7.3 control: a tampered raw explanation calibrationCohortHash fails", () => {
  const mutated = clone(fixture());
  const assessment = mutated.tables.find((table) => table.name === "ability_assessments")!;
  const row = assessment.rows[0] as { explanation: Record<string, unknown> };
  row.explanation.calibrationCohortHash = "tampered_cohort_raw_2";
  assertRejected(mutated, /explanation\.calibrationCohortHash/);
});

test("P3-06 §7.3 control: a broken relation fails even when both sides carry it", () => {
  const mutated = clone(fixture());
  const daily = mutated.tables.find((table) => table.name === "daily_ability_snapshots")!;
  (daily.rows[0] as Record<string, unknown>).lastAssessmentRef = JSON.stringify(["fixture_session_missing", 0]);
  // 比较器对 actual/expected 两侧都做引用完整性校验：同一个悬空引用不能"两边一样"而通过。
  assertRejected(mutated, /dangling_reference/);
});

test("P3-06 §7.3 control: an unknown output field fails", () => {
  const mutated = clone(fixture());
  const features = mutated.tables.find((table) => table.name === "workout_features")!;
  (features.rows[0] as Record<string, unknown>).unexpectedNewOutput = 1;
  assertRejected(mutated, /unknown output field/);
});

test("P3-06 §7.3 control: an unknown output table fails", () => {
  const mutated = clone(fixture());
  (mutated.tables as BusinessProjection["tables"] as BusinessProjection["tables"][number][]).push({
    name: "brand_new_artifact",
    keyFields: ["id"],
    rows: [{ id: "x" }]
  });
  assertRejected(mutated, /unknown output table/);
});

test("P3-06 §7.3 control: a changed training_sessions business field fails", () => {
  const mutated = clone(fixture());
  const sessions = mutated.tables.find((table) => table.name === "training_sessions")!;
  (sessions.rows[0] as Record<string, unknown>).anchorDistanceKm = 5.1;
  assertRejected(mutated, /anchorDistanceKm/);
});

test("P3-06 §7.3 control: a changed release evaluation report fails", () => {
  const mutated = clone(fixture());
  const bundles = mutated.tables.find((table) => table.name === "model_release_bundles")!;
  const row = bundles.rows[0] as { evaluation: { metrics: Record<string, unknown> } };
  row.evaluation.metrics.invalidValueCount = 3;
  assertRejected(mutated, /evaluation\.metrics\.invalidValueCount/);
});

test("P3-06 §7.3 control: an active pointer that disagrees with the bundle fails", () => {
  const mutated = clone(fixture());
  const readable = mutated.tables.find((table) => table.name === "release_readable_state")!;
  (readable.rows[0] as Record<string, unknown>).activeReleaseOrdinal = 1;
  assertRejected(mutated, /activeReleaseOrdinal/);
});

test("P3-06 §7.3 control: integers are exact, floats use the 1e-9 relative bound", () => {
  const withinTolerance = clone(fixture());
  const features = withinTolerance.tables.find((table) => table.name === "workout_features")!;
  (features.rows[0] as Record<string, unknown>).qualityScore = 0.875 + 1e-12;
  assert.deepEqual(compareBusinessProjections(withinTolerance, fixture()), [],
    "a float move inside 1e-9 relative tolerance must pass");

  const integerChanged = clone(fixture());
  const assessment = integerChanged.tables.find((table) => table.name === "ability_assessments")!;
  (assessment.rows[0] as Record<string, unknown>).sequenceNumber = 1;
  const diffs = compareBusinessProjections(integerChanged, fixture());
  assert.ok(diffs.some((diff) => diff.kind === "missing_row" || diff.kind === "extra_row"),
    "an integer key change must not be swallowed by float tolerance (it becomes a row-identity change)");
  assert.throws(() => assertBusinessEquivalent(integerChanged, fixture(), "integer control"), /missing row/);
});

// ---------------------------------------------------------------------------
// 复审 §3.4：三张新增投影的缺表/缺列/业务值负对照
// ---------------------------------------------------------------------------

function mutated(mutate: (tables: BusinessProjection["tables"]) => BusinessProjection["tables"]): BusinessProjection {
  const copy = clone(fixture());
  return { tables: mutate(copy.tables) };
}

for (const table of ["training_sessions", "model_release_bundles", "release_readable_state"] as const) {
  test(`P3-06 §3.4 control: a missing ${table} projection fails`, () => {
    const actual = mutated((tables) => tables.filter((entry) => entry.name !== table));
    assert.ok(compareBusinessProjections(actual, fixture()).some((diff) =>
      diff.kind === "missing_table" && diff.table === table));
    assert.throws(() => assertBusinessEquivalent(actual, fixture(), `missing ${table}`), /missing table/);
  });

  test(`P3-06 §3.4 control: a missing business column in ${table} fails`, () => {
    const actual = mutated((tables) => tables.map((entry) => {
      if (entry.name !== table) return entry;
      return {
        ...entry,
        rows: entry.rows.map((row) => {
          const { ...rest } = row;
          const firstBusiness = Object.keys(rest).find((key) => key !== entry.keyFields[0]);
          if (firstBusiness !== undefined) delete rest[firstBusiness];
          return rest;
        })
      };
    }));
    assert.ok(compareBusinessProjections(actual, fixture()).some((diff) =>
      diff.table === table && diff.kind === "missing_field"),
      `removing a ${table} column must be visible to the comparator`);
    assert.throws(() => assertBusinessEquivalent(actual, fixture(), `missing column ${table}`), /missing field/);
  });
}

test("P3-06 §3.4 control: a changed release_readable_state business value fails", () => {
  const actual = mutated((tables) => tables.map((entry) => {
    if (entry.name !== "release_readable_state") return entry;
    return {
      ...entry,
      rows: entry.rows.map((row) => ({ ...row, activePublished: !row.activePublished }))
    };
  }));
  assert.throws(() => assertBusinessEquivalent(actual, fixture(), "changed readable state"), /value/);
});
