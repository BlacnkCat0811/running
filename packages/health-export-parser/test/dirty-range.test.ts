import assert from "node:assert/strict";
import test from "node:test";

import { healthTypes } from "@rai/contracts";

import { planIncrementalAnalysisDirtyRange, rewindToOverlappingWorkoutStart } from "../src/index.js";

/**
 * O04（WP-20）脏范围纯函数。
 *
 * 钉住的核心缺陷：记录时间更正（训练**中段**心率）的边界必须回退到相交训练起点 ——
 * 旧 `dirtyFromAt()` 只取账本时刻的 min，`extractFeatures` 据此把"起点 < 边界"的训练
 * 当成未受影响、错误复用旧特征（合成库复现）。
 *
 * 训练时间线（三个用例共用）：跨过更正点的训练 + 次日训练。
 */
const workoutAt = (day: string) => ({
  startAt: `2026-01-${day}T08:00:00.000Z`,
  endAt: `2026-01-${day}T09:00:00.000Z`
});
const WORKOUTS = [workoutAt("10"), workoutAt("11")];

const heartRateChange = (start: string, end: string, previousStart = start, previousEnd = end) => ({
  entityKind: "record" as const,
  changeType: "updated" as const,
  newType: healthTypes.heartRate,
  newStart: start,
  newEnd: end,
  previousType: healthTypes.heartRate,
  previousStart,
  previousEnd
});

test("训练内更正：边界回退到相交训练起点（旧实现只到更正时刻）", () => {
  const range = planIncrementalAnalysisDirtyRange({
    changes: [heartRateChange("2026-01-10T08:10:00.000Z", "2026-01-10T08:11:00.000Z")],
    workouts: WORKOUTS
  });
  assert.equal(range.full, false);
  assert.equal(range.dirtyFromAt, "2026-01-10T08:00:00.000Z");
  assert.equal(range.domains.features, "2026-01-10T08:00:00.000Z");
  assert.ok(range.reasons.includes("overlapping_workout_rewound"));
});

test("新旧区间并集：时间前移后旧范围同样是脏下界", () => {
  const range = planIncrementalAnalysisDirtyRange({
    changes: [heartRateChange(
      "2026-01-10T02:00:00.000Z", "2026-01-10T03:00:00.000Z",
      "2026-01-09T02:00:00.000Z", "2026-01-09T03:00:00.000Z"
    )],
    workouts: WORKOUTS
  });
  assert.equal(range.full, false);
  // 旧范围（01-09T02:00）比更正后范围更早 ⇒ 并集下界取它；且 02:00 窗不与任何训练相交。
  assert.equal(range.dirtyFromAt, "2026-01-09T02:00:00.000Z");
  assert.ok(!range.reasons.includes("overlapping_workout_rewound"));
});

test("route-only 时刻纳入：合成 route 变更给出边界（不再退化成无边界）", () => {
  const range = planIncrementalAnalysisDirtyRange({
    changes: [{
      entityKind: "route",
      changeType: "updated",
      newType: null, newStart: "2026-01-11T08:00:00.000Z", newEnd: null,
      previousType: null, previousStart: null, previousEnd: null
    }],
    workouts: WORKOUTS
  });
  assert.equal(range.full, false);
  assert.equal(range.dirtyFromAt, "2026-01-11T08:00:00.000Z");
});

test("不可解析时刻 ⇒ full（fail-safe，方向是不可错复用）", () => {
  const range = planIncrementalAnalysisDirtyRange({
    changes: [{
      entityKind: "record",
      changeType: "updated",
      newType: healthTypes.heartRate, newStart: "not-a-time", newEnd: "2026-01-10T08:11:00.000Z",
      previousType: null, previousStart: null, previousEnd: null
    }],
    workouts: WORKOUTS
  });
  assert.equal(range.full, true);
  assert.equal(range.dirtyFromAt, null);
  assert.ok(range.reasons.includes("invalid_health_time") || range.reasons.includes("invalid_health_interval"));
});

test("vo2Max 变更 ⇒ full（与 CLI 的 planHealthChanges 同口径）", () => {
  const range = planIncrementalAnalysisDirtyRange({
    changes: [{
      entityKind: "record",
      changeType: "updated",
      newType: healthTypes.vo2Max, newStart: "2026-01-10T07:00:00.000Z", newEnd: "2026-01-10T07:05:00.000Z",
      previousType: null, previousStart: null, previousEnd: null
    }],
    workouts: WORKOUTS
  });
  assert.equal(range.full, true);
  assert.ok(range.reasons.includes("vo2_evidence_changed"));
});

test("恢复边界只压低 readiness/fitness，不污染 features 之外的语义", () => {
  const range = planIncrementalAnalysisDirtyRange({
    changes: [heartRateChange("2026-01-10T08:10:00.000Z", "2026-01-10T08:11:00.000Z")],
    workouts: WORKOUTS,
    recoveryBoundaries: ["2026-01-09T22:00:00.000Z"]
  });
  assert.equal(range.full, false);
  assert.equal(range.dirtyFromAt, "2026-01-09T22:00:00.000Z");
  assert.equal(range.domains.readiness, "2026-01-09T22:00:00.000Z");
  assert.equal(range.domains.fitness, "2026-01-09T22:00:00.000Z");
  // features 也必须跟着取更早值（它是全局下界的一部分，宁可宽）。
  assert.equal(range.domains.features, "2026-01-09T22:00:00.000Z");
});

test("无变更 ⇒ 非 full 且无边界（消费侧按'无 partial'处理）", () => {
  const range = planIncrementalAnalysisDirtyRange({ changes: [], workouts: WORKOUTS });
  assert.equal(range.full, false);
  assert.equal(range.dirtyFromAt, null);
  assert.deepEqual(range.domains, { features: null, fitness: null, readiness: null });
});

test("有变更但全被过滤（非评分类型）⇒ health_boundary_unknown full（与 CLI 同口径）", () => {
  const range = planIncrementalAnalysisDirtyRange({
    changes: [{
      entityKind: "record",
      changeType: "inserted",
      newType: "HKQuantityTypeIdentifierBodyMass", newStart: "2026-01-10T06:00:00.000Z", newEnd: "2026-01-10T06:00:00.000Z",
      previousType: null, previousStart: null, previousEnd: null
    }],
    workouts: WORKOUTS
  });
  assert.equal(range.full, true);
  assert.ok(range.reasons.includes("health_boundary_unknown"));
});

test("回退原语的边界：区间起点等于训练终点算相交（与 SQL 的 `end_at >= ?` 同义）", () => {
  assert.equal(
    rewindToOverlappingWorkoutStart(
      [{ start: "2026-01-10T09:00:00.000Z", end: "2026-01-10T09:30:00.000Z" }], WORKOUTS
    ),
    "2026-01-10T08:00:00.000Z",
    "区间起点 == 训练终点 ⇒ 相交（训练 end_at >= 区间 start）"
  );
  assert.equal(
    rewindToOverlappingWorkoutStart(
      [{ start: "2026-01-10T07:00:00.000Z", end: "2026-01-10T07:30:00.000Z" }], WORKOUTS
    ),
    null,
    "区间完全在训练之前 ⇒ 不相交"
  );
  assert.equal(
    rewindToOverlappingWorkoutStart(
      [{ start: "2026-01-09T00:00:00.000Z", end: "2026-01-11T00:00:00.000Z" }], WORKOUTS
    ),
    "2026-01-10T08:00:00.000Z",
    "大区间跨两个训练 ⇒ 取最早的训练起点"
  );
});
