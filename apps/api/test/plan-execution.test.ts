import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanExecution } from "../src/plan-execution.js";
import type { PlanHistoryRevision } from "../src/mobile-goals.js";

const history: PlanHistoryRevision[] = [{
  revision: 1, changedAt: "2026-09-06T12:00:00Z", lockedSession: null,
  weekPlan: [
    { localDate: "2026-09-07", kind: "interval", distanceKm: 8 },
    { localDate: "2026-09-09", kind: "easy", distanceKm: 8 }
  ]
}];

test("rolling seven days crosses Monday; no record is pending, not missed", () => {
  const rows = buildPlanExecution("2026-09-14", history, [
    { localDate: "2026-09-09", distanceKm: 3, workoutCount: 1 }
  ]);
  assert.equal(rows.length, 7);
  assert.equal(rows[0]?.localDate, "2026-09-07");
  assert.equal(rows[6]?.localDate, "2026-09-13");
  assert.equal(rows[0]?.plannedKind, "interval");
  assert.equal(rows[0]?.status, "pending");
  assert.equal(rows[2]?.status, "observed");
  assert.equal(rows[2]?.distanceRatio, 3 / 8);
  assert.equal(rows[1]?.status, "unknown");
});

test("late edits cannot rewrite historical plans; missing history stays unknown", () => {
  const late = { ...history[0]!, revision: 2, changedAt: "2026-09-10T01:00:00Z", weekPlan: [] };
  const rows = buildPlanExecution("2026-09-14", [late, ...history], []);
  assert.equal(rows[0]?.planRevision, 1);
  assert.equal(rows[2]?.plannedDistanceKm, 8);
  assert.ok(buildPlanExecution("2026-09-14", [], []).every((row) => row.status === "unknown"));
});

test("uses Shanghai midnight, excludes same-day writes and does not equate rest with completion", () => {
  const row = { ...history[0]!, changedAt: "2026-09-06T16:00:00Z" };
  assert.equal(buildPlanExecution("2026-09-14", [row], [])[0]?.plannedKind, null);
  row.changedAt = "2026-09-06T15:59:59Z";
  row.weekPlan = [{ localDate: "2026-09-07", kind: "rest", distanceKm: 0 }];
  const result = buildPlanExecution("2026-09-14", [row], [{ localDate: "2026-09-07", distanceKm: 5, workoutCount: 2 }])[0]!;
  assert.equal(result.status, "observed");
  assert.equal(result.distanceRatio, null);
  assert.equal(result.plannedKind, "rest");
});
