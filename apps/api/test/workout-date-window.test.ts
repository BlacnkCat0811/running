import assert from "node:assert/strict";
import test from "node:test";
import { workoutDateWindow } from "../src/workout-date-window.js";
import { exportWindow } from "../src/workout-summary-export.js";

test("list calendar validation has its own error, not export-specific wording", () => {
  for (const date of ["2026-02-29", "2026-09-31", "not-a-date", "2026-9-1"]) {
    assert.throws(() => workoutDateWindow(date, date), (error: unknown) => {
      const problem = error as { code: string; message: string; statusCode: number };
      assert.equal(problem.code, "invalid_workout_date");
      assert.equal(problem.statusCode, 400);
      assert.ok(!problem.message.includes("导出"));
      return true;
    });
  }
});
test("list and export share calendar bounds but export alone imposes its range cap", () => {
  assert.deepEqual(workoutDateWindow("2026-09-28", "2026-09-28"), exportWindow("2026-09-28", "2026-09-28"));
  assert.deepEqual(workoutDateWindow("2028-02-29", "2028-02-29"), {
    startedFrom: "2028-02-29T00:00:00+08:00", startedBefore: "2028-02-29T16:00:00.000Z"
  });
  assert.doesNotThrow(() => workoutDateWindow("2024-01-01", "2026-01-01"));
  assert.throws(() => exportWindow("2024-01-01", "2026-01-01"), { code: "invalid_export_range" });
});
